// Synthetic transport with real native crypto and deterministic completion ordering.
// This is not the real-relay smoke test.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
let browser;
let phase = 'configuration';
const contexts = new Set();
const check = value => assert.ok(value, 'Regression assertion failed');
try {
  const selectedScenario = process.env.TEST_SCENARIO;
  check(selectedScenario === undefined || /^[1-9]$/.test(selectedScenario));
  let scenarioNumber = 0;
  const origin = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:5197');
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1');
  check(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const cryptoModule = '/@fs' + fileURLToPath(new URL('../packages/crypto/src/index.ts', import.meta.url));
  const base = { roomId: 'crypto-race', createdAt: Date.now(), expiresAt: null, inactivityTimeoutMs: null, maxAgeMs: null, disappearAfterReadSeconds: null, status: 'open', participantCount: 1, creatorJoined: true, lastActivityAt: Date.now(), membershipVersion: 1 };

  async function fixture(run) {
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    contexts.add(context);
    context.setDefaultTimeout(15000);
    const page = await context.newPage();
    let errors = 0;
    page.on('pageerror', () => { errors++; });
    const state = { page, sends: [], joins: 0, failMetadata: false, version: 1 };
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin.origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      return route.fulfill({ status: state.failMetadata ? 503 : 200, contentType: 'application/json', body: JSON.stringify(state.failMetadata ? {} : url.pathname === '/api/rooms/crypto-race' ? { ...base, membershipVersion: state.version } : []) });
    });
    await page.routeWebSocket('**/api/rooms/crypto-race/ws', socket => {
      state.socket = socket;
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'peer_data') state.sends.push(message);
        if (message.type !== 'join') return;
        state.joins++;
        state.join = message;
        socket.send(JSON.stringify({ type: 'joined', room: { ...base, membershipVersion: state.version }, sessionId: message.sessionId, creator: false, self: { sessionId: message.sessionId, creator: false, connectedAt: 1, identityKey: message.identityKey, agreementKey: message.agreementKey }, peers: [], presence: { count: 1, connectedSessionIds: [message.sessionId] } }));
      });
    });
    try {
      await page.goto(origin.origin + '/c/crypto-race?invite=synthetic#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      await ready(page);
      state.peer = await page.evaluate(async modulePath => {
        const c = await import(modulePath);
        const sign = await c.createIdentityKeyPair();
        const agree = await c.createAgreementKeyPair();
        const peer = { sessionId: crypto.randomUUID(), creator: false, connectedAt: 2, identityKey: await c.exportIdentityPublicKey(sign.publicKey), agreementKey: await c.exportAgreementPublicKey(agree.publicKey) };
        window.__raceFixture = { c, sign, agree, peer };
        return peer;
      }, cryptoModule);
      await run(state);
      check(errors === 0);
    } finally {
      await context.close();
      contexts.delete(context);
    }
  }
  const ready = page => page.locator('.composer textarea:not([disabled])').waitFor();
  const disabled = page => page.locator('.composer textarea:disabled').waitFor();
  const send = (state, message) => state.socket.send(JSON.stringify(message));
  const joinPeer = state => send(state, { type: 'peer_joined', peer: state.peer, membershipVersion: 2 });
  const leavePeer = state => send(state, { type: 'peer_left', sessionId: state.peer.sessionId, membershipVersion: 3 });
  async function arm(page, method, filter = '') {
    await page.evaluate(({ method, filter }) => {
      const original = crypto.subtle[method].bind(crypto.subtle);
      let armed = true;
      window.__raceDone = false;
      window.__raceRelease = undefined;
      crypto.subtle[method] = async (...args) => {
        const info = args[0]?.info ? new TextDecoder().decode(args[0].info) : '';
        const pause = armed && (!filter || (filter === 'room' ? !info.startsWith('elm-chat-key-rotation:') : info.startsWith('elm-chat-key-rotation:')));
        if (pause) armed = false;
        const value = await original(...args);
        if (pause) {
          await new Promise(resolve => { window.__raceRelease = resolve; });
          window.__raceDone = true;
        }
        return value;
      };
    }, { method, filter });
  }
  const paused = page => page.waitForFunction(() => typeof window.__raceRelease === 'function');
  async function release(page) {
    await page.evaluate(() => window.__raceRelease());
    await page.waitForFunction(() => window.__raceDone);
    // Drain native-crypto continuations and React updates before negative assertions.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(100);
  }
  async function chat(state, epoch) {
    const count = state.sends.filter(m => m.data.payload.type === 'chat_message').length;
    await state.page.locator('.composer textarea').fill('Synthetic epoch assertion');
    await state.page.locator('.composer button[type=submit]').click();
    for (let attempt = 0; attempt < 100 && state.sends.filter(m => m.data.payload.type === 'chat_message').length === count; attempt++) await state.page.waitForTimeout(20);
    const messages = state.sends.filter(m => m.data.payload.type === 'chat_message');
    check(messages.length === count + 1);
    check(messages.at(-1).data.payload.envelope.keyEpoch === epoch);
  }
  async function step(name, run) {
    scenarioNumber++;
    if (selectedScenario !== undefined && Number(selectedScenario) !== scenarioNumber) return;
    phase = name; await fixture(run); console.log(`PASS ${name}`);
  }

  await step('leader current completion enables current epoch', async state => {
    await arm(state.page, 'deriveKey', 'room'); joinPeer(state); await paused(state.page); await disabled(state.page);
    await release(state.page); await ready(state.page); await chat(state, 2);
  });
  await step('leader disconnect preserves draft until fresh admission', async state => {
    await state.page.locator('.composer textarea').fill('Synthetic retained draft');
    await arm(state.page, 'deriveKey', 'room'); joinPeer(state); await paused(state.page);
    state.failMetadata = true;
    state.socket.close({ code: 1001, reason: 'Synthetic transport loss' });
    await disabled(state.page); await state.page.waitForTimeout(100); await release(state.page);
    check(await state.page.locator('.composer textarea').isDisabled());
    check(await state.page.locator('.composer textarea').inputValue() === 'Synthetic retained draft');
    check(state.joins === 1);
    state.version = 3; state.failMetadata = false;
    await ready(state.page); check(state.joins === 2);
    check(await state.page.locator('.composer textarea').inputValue() === 'Synthetic retained draft');
    await chat(state, 3);
  });
  await step('leader older completion cannot regress newer epoch', async state => {
    await arm(state.page, 'deriveKey', 'room'); joinPeer(state); await paused(state.page);
    leavePeer(state); await ready(state.page); await chat(state, 3);
    await release(state.page); await chat(state, 3);
  });
  for (const method of ['deriveKey', 'sign']) {
    await step(`leader stale ${method === 'deriveKey' ? 'wrap' : 'signature'} cannot send rotation`, async state => {
      await arm(state.page, method, method === 'deriveKey' ? 'pairwise' : '');
      joinPeer(state); await paused(state.page);
      leavePeer(state); await ready(state.page); await release(state.page);
      check(!state.sends.some(m => m.data.payload.type === 'key_rotation' && m.data.payload.keyEpoch === 2));
      await chat(state, 3);
    });
  }
  await step('leader terminal screen remains closed', async state => {
    await arm(state.page, 'deriveKey', 'room'); joinPeer(state); await paused(state.page);
    send(state, { type: 'room_state', status: 'destroyed', reason: 'Synthetic terminal event' });
    await state.page.getByRole('heading', { name: 'Room gone', exact: true }).waitFor();
    await release(state.page);
    check(await state.page.locator('.composer').count() === 0);
    check(!state.sends.some(m => m.data.payload.type === 'key_rotation'));
  });

  async function incoming(state, epoch) {
    return state.page.evaluate(async ({ recipient, epoch }) => {
      const { c, sign, agree, peer } = window.__raceFixture;
      const wrapped = await c.wrapRoomSecret(agree.privateKey, recipient.agreementKey, 'crypto-race', epoch, peer.sessionId, recipient.sessionId, c.generateRoomSecret());
      return c.createAuthenticatedPeerEvent(sign.privateKey, 'crypto-race', peer.sessionId, recipient.sessionId, { type: 'key_rotation', keyEpoch: epoch, senderAgreementKey: peer.agreementKey, ...wrapped });
    }, { recipient: state.join, epoch });
  }
  const receive = (state, event) => send(state, { type: 'peer_data', fromSessionId: state.peer.sessionId, data: event });
  for (const method of ['deriveKey', 'decrypt']) {
    await step(`incoming stale ${method === 'deriveKey' ? 'derive' : 'unwrap'} cannot regress epoch`, async state => {
      const event2 = await incoming(state, 2);
      const event3 = await incoming(state, 3);
      state.peer.creator = true; joinPeer(state); await disabled(state.page);
      await arm(state.page, method, method === 'deriveKey' ? 'room' : '');
      receive(state, event2); await paused(state.page);
      // Same valid key leader, newer membership version.
      send(state, { type: 'peer_joined', peer: { ...state.peer }, membershipVersion: 3 });
      receive(state, event3); await ready(state.page); await chat(state, 3);
      await release(state.page); await chat(state, 3);
    });
  }
  await step('incoming disconnect cannot restore readiness', async state => {
    const event = await incoming(state, 2);
    state.peer.creator = true; joinPeer(state); await disabled(state.page);
    await arm(state.page, 'deriveKey', 'room'); receive(state, event); await paused(state.page);
    state.failMetadata = true; state.socket.close({ code: 1001, reason: 'Synthetic transport loss' });
    await state.page.waitForTimeout(100); await release(state.page);
    check(await state.page.locator('.composer textarea').isDisabled()); check(state.joins === 1);
  });
} catch {
  console.error(`FAIL ${phase}; raw diagnostics suppressed`);
  process.exitCode = 1;
} finally {
  for (const context of contexts) {
    try { await context.close(); } catch { console.error('FAIL context cleanup'); process.exitCode = 1; }
  }
  if (browser) {
    try { await browser.close(); } catch { console.error('FAIL browser cleanup'); process.exitCode = 1; }
  }
}
