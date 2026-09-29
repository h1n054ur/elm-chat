// Real local reconnect smoke: a byte-transparent guest TCP proxy cuts transport.
// No room HTTP or WebSocket responses are mocked.
import assert from 'node:assert/strict';
import net from 'node:net';
let proxy;
let forwarding = true;
const pipes = new Set();
let guestOrigin;

let phase = 'configuration';
let browser;
let pageErrors = 0;
let roomPage;
let destroyed = false;
const contexts = [];
let origin;
const check = (condition) => assert.ok(condition, 'Smoke assertion failed');
async function step(name, run) {
  phase = name;
  await run();
  check(pageErrors === 0);
  console.log(`PASS ${name}`);
}

try {
  const recoveryMode = process.env.RECOVERY_MODE || 'automatic';
  check(['automatic', 'manual'].includes(recoveryMode));
  origin = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:5210');
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1');
  check(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/');
  // Byte-transparent guest-only transport; no protocol payload inspection.
  proxy = net.createServer(client => {
    if (!forwarding) return client.destroy();
    const upstream = net.connect({ host: '127.0.0.1', port: Number(origin.port || 80) });
    const pair = { client, upstream };
    pipes.add(pair);
    const dispose = () => { client.destroy(); upstream.destroy(); pipes.delete(pair); };
    client.on('error', dispose); upstream.on('error', dispose);
    client.on('close', dispose); upstream.on('close', dispose);
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  guestOrigin = new URL(`http://127.0.0.1:${proxy.address().port}`);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  async function page(allowedOrigin = origin) {
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    contexts.push(context);
    context.setDefaultTimeout(20000);
    // Abort only off-origin and unrelated public feed requests; never replace a response.
    // Feed endpoints would otherwise fetch public GitHub data from the local Worker.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== allowedOrigin.origin || ['/api/stars', '/api/community'].includes(url.pathname)) return route.abort();
      return route.continue();
    });
    const result = await context.newPage();
    result.on('pageerror', () => { pageErrors += 1; });
    return result;
  }
  const creator = await page();
  const guest = await page(guestOrigin);
  let guestSockets = 0;
  let guestCloses = 0;
  let guestMetadataRequests = 0;
  guest.on('request', request => {
    if (/^\/api\/rooms\/[^/]+$/.test(new URL(request.url()).pathname)) guestMetadataRequests += 1;
  });
  guest.on('websocket', socket => { guestSockets += 1; socket.on('close', () => { guestCloses += 1; }); });
  roomPage = creator;
  const ready = async p => { await p.locator('.composer textarea:not([disabled])').waitFor(); };
  const closed = async p => {
    await p.getByRole('heading', { name: 'Room gone', exact: true }).waitFor();
    check(await p.locator('.composer').count() === 0);
  };
  let roomId;
  let unusedInvite;
  async function invite() {
    const responsePromise = creator.waitForResponse(r =>
      new URL(r.url()).pathname === `/api/rooms/${roomId}/invites` && r.request().method() === 'POST');
    await creator.locator('.room-actions button').first().click();
    const response = await responsePromise;
    check(response.ok());
    const record = await response.json();
    const url = new URL(creator.url());
    url.search = new URLSearchParams({ invite: record.token }).toString();
    // Only the in-memory browser handoff receives this URL; never print it.
    return url.href;
  }
  await step('create room through local Worker', async () => {
    await creator.goto(origin.href);
    await creator.getByRole('button', { name: 'Create private conversation', exact: true }).click();
    await ready(creator);
    roomId = new URL(creator.url()).pathname.split('/').pop();
    check(Boolean(roomId));
  });
  await step('admit independent guest and establish both keys', async () => {
    const target = new URL(await invite());
    target.host = guestOrigin.host;
    await guest.goto(target.href);
    for (const p of [creator, guest]) {
      await p.getByText('2 present', { exact: true }).waitFor();
      await ready(p);
    }
  });
  const baselineMessages = [];
  await step('baseline decrypted messages both ways', async () => {
    for (const [from, to] of [[creator, guest], [guest, creator]]) {
      const text = `Synthetic baseline ${crypto.randomUUID()}`;
      await from.locator('.composer textarea').fill(text);
      await from.locator('.composer button[type=submit]').click();
      const remote = to.locator('.bubble-theirs p').filter({ hasText: text });
      await remote.waitFor();
      check(await remote.count() === 1 && await remote.innerText() === text);
      baselineMessages.push({ to, text });
    }
  });
  await step(`guest-only cut and in-place ${recoveryMode} reconnect`, async () => {
    const draft = 'Synthetic preserved reconnect draft';
    await guest.locator('.composer textarea').fill(draft);
    const sentinel = crypto.randomUUID();
    await guest.evaluate(value => { window.__smokeDocument = value; }, sentinel);
    check(await guest.evaluate(id => {
      const session = sessionStorage.getItem(`elm-chat:session:${id}`);
      const stored = sessionStorage.getItem(`elm-chat:identity:${id}:${session}`);
      if (!session || !stored) return false;
      const { publicKey, agreementPublicKey } = JSON.parse(stored);
      window.__smokeIdentity = { session, publicKey, agreementPublicKey };
      return Boolean(publicKey && agreementPublicKey);
    }, roomId));
    const beforeSockets = guestSockets;
    const beforeCloses = guestCloses;
    forwarding = false;
    for (const { client, upstream } of pipes) { client.destroy(); upstream.destroy(); }
    const deadline = Date.now() + 10000;
    while (guestCloses === beforeCloses && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    check(guestCloses > beforeCloses);
    await creator.getByText('1 present', { exact: true }).waitFor();
    await guest.locator('.composer textarea:disabled').waitFor();
    check(await guest.locator('.composer textarea').inputValue() === draft);
    console.log('PASS observed real guest socket close, creator presence loss, disabled draft preserved');
    if (recoveryMode === 'manual') {
      await guest.getByRole('button', { name: 'Retry connection', exact: true }).waitFor({ timeout: 35000 });
      check(await guest.locator('.composer textarea').isDisabled());
      check(await guest.locator('.composer textarea').inputValue() === draft);
      const exhaustedRequests = guestMetadataRequests;
      forwarding = true;
      // Longer than the maximum automatic backoff: restored transport alone must
      // not restart an exhausted scheduler. No browser clocks/timers are patched.
      await guest.waitForTimeout(9000);
      check(guestMetadataRequests === exhaustedRequests && guestSockets === beforeSockets);
      check(await guest.locator('.composer textarea').isDisabled());
      await guest.getByRole('button', { name: 'Retry connection', exact: true }).click();
    } else forwarding = true;
    for (const p of [creator, guest]) {
      await p.getByText('2 present', { exact: true }).waitFor();
      await ready(p);
    }
    check(guestSockets > beforeSockets);
    check(await guest.evaluate(() => window.__smokeDocument) === sentinel);
    check(await guest.evaluate(id => {
      const before = window.__smokeIdentity;
      const session = sessionStorage.getItem(`elm-chat:session:${id}`);
      const stored = sessionStorage.getItem(`elm-chat:identity:${id}:${session}`);
      if (!before || !stored) return false;
      const { publicKey, agreementPublicKey } = JSON.parse(stored);
      return session === before.session && publicKey === before.publicKey && agreementPublicKey === before.agreementPublicKey;
    }, roomId));
    check(await guest.locator('.composer textarea').inputValue() === draft);
    await guest.locator('.composer button[type=submit]').click();
    const remote = creator.locator('.bubble-theirs p').filter({ hasText: draft });
    await remote.waitFor();
    check(await remote.count() === 1 && await remote.innerText() === draft);
  });
  for (const [from, to, direction] of [[creator, guest, 'creator to guest'], [guest, creator, 'guest to creator']]) {
    await step(`decrypted message ${direction}`, async () => {
      const text = `Synthetic local smoke ${direction} ${crypto.randomUUID()}`;
      await from.locator('.composer textarea').fill(text);
      await from.locator('.composer button[type=submit]').click();
      const remote = to.locator('.bubble-theirs p').filter({ hasText: text });
      await remote.waitFor();
      check(await remote.count() === 1 && await remote.innerText() === text);
    });
  }
  await step('baseline remains exactly once and no visible room errors', async () => {
    for (const { to, text } of baselineMessages) check(await to.locator('.bubble-theirs p').filter({ hasText: text }).count() === 1);
    for (const p of [creator, guest]) check(await p.locator('.room-error').count() === 0);
  });
  await step('destroy room and terminate both peers', async () => {
    unusedInvite = await invite();
    if (recoveryMode === 'manual') {
      const beforeCloses = guestCloses;
      forwarding = false;
      for (const { client, upstream } of pipes) { client.destroy(); upstream.destroy(); }
      const deadline = Date.now() + 10000;
      while (guestCloses === beforeCloses && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      check(guestCloses > beforeCloses);
      await creator.getByText('1 present', { exact: true }).waitFor();
      await guest.locator('.composer textarea:disabled').waitFor();
      await guest.getByRole('button', { name: 'Retry connection', exact: true }).waitFor({ timeout: 35000 });
    }
    await creator.getByRole('button', { name: 'Destroy', exact: true }).click();
    await closed(creator);
    if (recoveryMode === 'manual') {
      const terminalSockets = guestSockets;
      forwarding = true;
      await guest.getByRole('button', { name: 'Retry connection', exact: true }).click();
      await closed(guest);
      check(guestSockets === terminalSockets);
      check(await guest.getByRole('button', { name: 'Retry connection', exact: true }).count() === 0);
    } else await closed(guest);
    destroyed = true;
  });
  await step('unused invite cannot admit after destruction', async () => {
    const visitor = await page();
    await visitor.goto(unusedInvite);
    await closed(visitor);
    const state = await visitor.evaluate(async id => {
      const response = await fetch(`/api/rooms/${id}`);
      return response.ok ? { code: response.status, state: (await response.json()).status } : { code: response.status };
    }, roomId);
    check([404, 410].includes(state.code) || state.state === 'destroyed');
    // Allow queued room events to settle; none may restore sending or admission.
    const terminalSockets = guestSockets;
    await visitor.waitForTimeout(9000);
    check(guestSockets === terminalSockets);
    for (const p of [creator, guest, visitor]) check(await p.locator('.composer').count() === 0);
  });
  console.log(`PASS real local ${recoveryMode} reconnect smoke (${browser.version()}); no capability artifacts saved`);
} catch (error) {
  // Playwright error messages can contain current URLs with invite capabilities.
  console.error(`FAIL ${phase} (${error?.name || 'Error'}); details suppressed to protect local capabilities`);
  process.exitCode = 1;
} finally {
  if (!destroyed && roomPage) {
    try {
      const button = roomPage.getByRole('button', { name: 'Destroy', exact: true });
      if (await button.count()) await button.click({ timeout: 2000 });
    } catch { /* Local state can be removed after stopping the local server. */ }
  }
  forwarding = true;
  let cleanupFailed = false;
  for (const context of contexts) {
    try { await context.close(); } catch { cleanupFailed = true; }
  }
  try { await browser?.close(); } catch { cleanupFailed = true; } finally {
    for (const { client, upstream } of pipes) { client.destroy(); upstream.destroy(); }
    if (proxy?.listening) {
      try {
        await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
      } catch { cleanupFailed = true; }
    }
  }
  if (cleanupFailed) {
    console.error('FAIL cleanup; details suppressed to protect local capabilities');
    process.exitCode = 1;
  }
}
