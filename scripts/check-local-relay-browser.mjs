// Real local Worker/DO smoke: no room HTTP or WebSocket responses are mocked.
import assert from 'node:assert/strict';

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
  origin = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:5210');
  check(origin.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname));
  check(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  async function page() {
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    contexts.push(context);
    context.setDefaultTimeout(20000);
    // Abort only off-origin and unrelated public feed requests; never replace a response.
    // Feed endpoints would otherwise fetch public GitHub data from the local Worker.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin.origin || ['/api/stars', '/api/community'].includes(url.pathname)) return route.abort();
      return route.continue();
    });
    const result = await context.newPage();
    result.on('pageerror', () => { pageErrors += 1; });
    return result;
  }
  const creator = await page();
  const guest = await page();
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
    await guest.goto(await invite());
    for (const p of [creator, guest]) {
      await p.getByText('2 present', { exact: true }).waitFor();
      await ready(p);
    }
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
  await step('small file crosses real local relay', async () => {
    const content = 'Synthetic local relay file\n';
    await creator.locator('input[type=file]').setInputFiles({ name: 'local-smoke.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
    await guest.getByRole('button', { name: 'Download local-smoke.txt', exact: true }).click();
    const saved = guest.getByRole('link', { name: 'Save file local-smoke.txt', exact: true });
    await saved.waitFor();
    const downloading = guest.waitForEvent('download');
    await saved.click();
    const download = await downloading;
    const stream = await download.createReadStream();
    check(Boolean(stream));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    check(Buffer.concat(chunks).toString('utf8') === content);
    await download.delete();
  });
  await step('destroy room and terminate both peers', async () => {
    unusedInvite = await invite();
    await creator.getByRole('button', { name: 'Destroy', exact: true }).click();
    await Promise.all([closed(creator), closed(guest)]);
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
    await visitor.waitForTimeout(1000);
    for (const p of [creator, guest, visitor]) check(await p.locator('.composer').count() === 0);
  });
  console.log(`PASS real local relay smoke (${browser.version()}); no capability artifacts saved`);
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
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
