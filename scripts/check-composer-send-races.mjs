// Synthetic room transport, native crypto, controlled send completion ordering.
import assert from 'node:assert/strict';
let browser;
let phase = 'configuration';
const contexts = new Set();
const check = value => assert.ok(value, 'Regression assertion failed');
try {
  const selected = process.env.TEST_SCENARIO;
  check(selected === undefined || /^(?:[1-9]|10)$/.test(selected));
  const origin = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:5197');
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1');
  check(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const room = { roomId: 'compose-test', createdAt: Date.now(), expiresAt: null, inactivityTimeoutMs: null, maxAgeMs: null, disappearAfterReadSeconds: null, status: 'open', participantCount: 1, creatorJoined: true, lastActivityAt: Date.now(), membershipVersion: 1 };
  let number = 0;
  async function scenario(name, run) {
    number++;
    if (selected !== undefined && Number(selected) !== number) return;
    phase = name;
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    contexts.add(context);
    context.setDefaultTimeout(10000);
    try {
      const page = await context.newPage();
      const state = { page, sends: [], failMetadata: false, errors: 0 };
      page.on('pageerror', () => { state.errors++; });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin.origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        return route.fulfill({ status: state.failMetadata ? 503 : 200, contentType: 'application/json', body: JSON.stringify(state.failMetadata ? {} : url.pathname === '/api/rooms/compose-test' ? room : []) });
      });
      await page.routeWebSocket('**/api/rooms/compose-test/ws', socket => {
        state.socket = socket;
        socket.onMessage(raw => {
          const message = JSON.parse(String(raw));
          if (message.type === 'peer_data' && message.data.payload.type === 'chat_message') state.sends.push(message);
          if (message.type === 'join') socket.send(JSON.stringify({ type: 'joined', room, sessionId: message.sessionId, creator: false, self: { sessionId: message.sessionId, creator: false, connectedAt: 1, identityKey: message.identityKey, agreementKey: message.agreementKey }, peers: [], presence: { count: 1, connectedSessionIds: [message.sessionId] } }));
        });
      });
      await page.goto(origin.origin + '/c/compose-test?invite=synthetic#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      await page.locator('.composer textarea:not([disabled])').waitFor();
      await run(state);
      check(state.errors === 0);
      console.log(`PASS ${name}`);
    } finally {
      await context.close();
      contexts.delete(context);
    }
  }
  const draft = 'Synthetic original draft';
  const newer = 'Synthetic newer draft';
  const textarea = state => state.page.locator('.composer textarea');
  const bubble = state => state.page.locator('.bubble').filter({ has: state.page.locator('p', { hasText: draft }) });
  const submit = state => state.page.locator('.composer').evaluate(form => form.requestSubmit());
  async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(120);
  }
  async function arm(state, method, reject = false) {
    await state.page.evaluate(({ method, reject }) => {
      const native = crypto.subtle[method].bind(crypto.subtle);
      let armed = true;
      window.__composeReleased = false;
      window.__composeRelease = undefined;
      crypto.subtle[method] = async (...args) => {
        const pause = armed; armed = false;
        const result = await native(...args);
        if (pause) {
          await new Promise(resolve => { window.__composeRelease = resolve; });
          window.__composeReleased = true;
          if (reject) throw new Error('Synthetic crypto failure');
        }
        return result;
      };
    }, { method, reject });
  }
  async function pending(state, method, reject = false) {
    await arm(state, method, reject);
    await textarea(state).fill(draft); await submit(state);
    await state.page.waitForFunction(() => typeof window.__composeRelease === 'function');
  }
  async function release(state) {
    await state.page.evaluate(() => window.__composeRelease());
    await state.page.waitForFunction(() => window.__composeReleased);
    await settle(state.page);
  }
  async function sentOnce(state) {
    for (let count = 0; count < 100 && state.sends.length === 0; count++) await state.page.waitForTimeout(20);
    check(state.sends.length === 1);
    check(await bubble(state).count() === 1);
  }
  await scenario('successful send clears unchanged draft', async state => {
    await textarea(state).fill(draft); await submit(state); await settle(state.page); await sentOnce(state);
    check(await textarea(state).inputValue() === '');
  });
  await scenario('pending encryption preserves newer draft', async state => {
    await pending(state, 'encrypt'); await textarea(state).fill(newer); await release(state); await sentOnce(state);
    check(await textarea(state).inputValue() === newer);
  });
  for (const method of ['encrypt', 'sign']) {
    await scenario(`repeated submit during ${method} sends once`, async state => {
      await pending(state, method); await submit(state); await submit(state); await settle(state.page);
      check(state.sends.length === 0);
      await release(state); await sentOnce(state);
      check(await textarea(state).inputValue() === '');
    });
  }
  for (const method of ['encrypt', 'sign']) {
    await scenario(`${method} rejection preserves draft and permits retry`, async state => {
      await pending(state, method, true); await release(state);
      check(await textarea(state).inputValue() === draft);
      check(state.sends.length === 0); check(await bubble(state).count() === 0);
      await submit(state); await settle(state.page); await sentOnce(state);
      check(await textarea(state).inputValue() === '');
    });
  }
  await scenario('disconnect cancels pending send without clearing draft', async state => {
    await pending(state, 'encrypt'); state.failMetadata = true;
    state.socket.close({ code: 1001, reason: 'Synthetic transport loss' });
    await state.page.locator('.composer textarea:disabled').waitFor(); await release(state);
    check(state.sends.length === 0); check(await bubble(state).count() === 0);
    check(await textarea(state).inputValue() === draft);
  });
  await scenario('terminal event prevents pending send and keeps closed screen', async state => {
    await pending(state, 'encrypt');
    state.socket.send(JSON.stringify({ type: 'room_state', status: 'destroyed', reason: 'Synthetic terminal event' }));
    await state.page.getByRole('heading', { name: 'Room gone', exact: true }).waitFor(); await release(state);
    check(state.sends.length === 0); check(await bubble(state).count() === 0);
    check(await state.page.locator('.composer').count() === 0);
  });
  await scenario('editing away then back preserves draft revision', async state => {
    await pending(state, 'encrypt');
    await textarea(state).fill(newer); await textarea(state).fill(draft);
    await release(state); await sentOnce(state);
    check(await textarea(state).inputValue() === draft);
  });
  await scenario('membership change cancels pending signature', async state => {
    await pending(state, 'sign');
    const peer = await state.page.evaluate(async () => {
      const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const agreement = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      return { sessionId: crypto.randomUUID(), creator: false, connectedAt: 2, identityKey: encode(await crypto.subtle.exportKey('raw', signing.publicKey)), agreementKey: encode(await crypto.subtle.exportKey('raw', agreement.publicKey)) };
    });
    state.socket.send(JSON.stringify({ type: 'peer_joined', peer, membershipVersion: 2 }));
    await settle(state.page); await release(state);
    check(state.sends.length === 0); check(await bubble(state).count() === 0);
    check(await textarea(state).inputValue() === draft);
    await state.page.locator('.composer textarea:not([disabled])').waitFor();
    await submit(state); await settle(state.page); await sentOnce(state);
    check(state.sends[0].data.payload.envelope.keyEpoch === 2);
  });

} catch {
  console.error(`FAIL ${phase}; raw diagnostics suppressed`); process.exitCode = 1;
} finally {
  for (const context of contexts) {
    try { await context.close(); } catch { console.error('FAIL context cleanup'); process.exitCode = 1; }
  }
  if (browser) {
    try { await browser.close(); } catch { console.error('FAIL browser cleanup'); process.exitCode = 1; }
  }
}
