// Real local Worker/DO smoke: no room HTTP or WebSocket responses are mocked.
import assert from 'node:assert/strict';

let phase = 'configuration';
let browser;
let pageErrors = 0;

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
  check(['en-US', 'es-ES'].includes(process.env.TEST_LOCALE || 'en-US'));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  async function page() {
    const context = await browser.newContext({ locale: contexts.length === 0 ? 'en-US' : (process.env.TEST_LOCALE || 'en-US'), serviceWorkers: 'block' });
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
  const ready = async p => { await p.locator('.composer textarea:not([disabled])').waitFor(); };
  let roomId;
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
      await p.getByText(p === creator || process.env.TEST_LOCALE !== 'es-ES' ? '2 present' : '2 presentes', { exact: true }).waitFor();
      await ready(p);
    }
  });
  const fileCard = (p, name) => p.locator('.file-card').filter({ hasText: name });
  const spanish = process.env.TEST_LOCALE === 'es-ES';
  const baseline = process.env.BASELINE === '1';
  const failureFocus = process.env.FAILURE_FOCUS || 'card';
  check(['card', 'composer', 'other'].includes(failureFocus));
  const focused = locator => locator.evaluate(el => el === document.activeElement);
  const composer = guest.locator('.composer textarea');
  const saveLink = card => card.getByRole('link');
  await creator.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    window.__held = [];
    // Hold only synthetic file chunks; leave room HTTP, WS and key exchange real.
    crypto.subtle.encrypt = async (...args) => {
      const data = args[2];
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes[0] === 17) await new Promise(resolve => window.__held.push(resolve));
      return encrypt(...args);
    };
  });
  async function offer(name) {
    await creator.locator('input[type=file]').setInputFiles({ name, mimeType:'application/octet-stream', buffer:Buffer.alloc(1000,17) });
    const card = fileCard(guest,name);
    await card.getByRole('button').waitFor();
    if (!baseline) {
      check(await card.getAttribute('role') === 'group');
      check(await card.getAttribute('tabindex') === '-1');
      check(await card.getAttribute('aria-label') === `${spanish ? 'Archivo' : 'File'} ${name}`);
    }
    return card;
  }
  async function start(card, key = 'Enter') {
    const button = card.getByRole('button');
    await button.focus(); check(await focused(button));
    await button.press(key);
    await card.getByRole('progressbar').waitFor();
    await creator.waitForFunction(() => window.__held.length > 0);
    check(await card.getByRole('progressbar').getAttribute('aria-live') === 'off');
    await retained(card);
  }
  async function retained(card) {
    check(baseline ? await guest.evaluate(() => document.activeElement === document.body) : await focused(card));
  }
  async function complete(card) {
    await creator.evaluate(() => window.__held.splice(0).forEach(resolve => resolve()));
    await saveLink(card).waitFor();
  }
  for (const key of ['Enter','Space']) {
    await step(`${spanish ? 'ES' : 'EN'} ${key}: progress, completion and Tab to Save`, async () => {
      const card = await offer(`keyboard-${key}.bin`);
      await start(card,key);
      if (!baseline) {
        check(await card.evaluate(el => {
          const style = getComputedStyle(el);
          return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
        }));
      }
      await complete(card); await retained(card);
      if (!baseline) {
        await guest.keyboard.press('Tab');
        check(await focused(saveLink(card)));
        check(await saveLink(card).getAttribute('aria-label') === `${spanish ? 'Guardar archivo' : 'Save file'} keyboard-${key}.bin`);
      }
    });
  }
  await step('Tab away during progress is preserved on completion', async () => {
    const card = await offer('tab-away.bin'); await start(card);
    await guest.keyboard.press('Tab');
    check(!await focused(card));
    check(!await guest.evaluate(() => document.activeElement === document.body));
    await guest.evaluate(() => { window.__focusOwner = document.activeElement; });
    await complete(card);
    check(await guest.evaluate(() => document.activeElement === window.__focusOwner));
  });
  await step('composer focus is preserved on completion', async () => {
    const card = await offer('composer.bin'); await start(card);
    await composer.focus(); await complete(card); check(await focused(composer));
  });
  const other = await offer('other-file.bin');
  await step('another file focus is preserved on completion', async () => {
    const card = await offer('other-owner.bin'); await start(card);
    await other.getByRole('button').focus(); await complete(card);
    check(await focused(other.getByRole('button')));
  });
  await step('activation without trigger focus preserves composer', async () => {
    const card = await offer('unfocused.bin');
    await composer.focus();
    // Programmatic click models an activation whose trigger does not own focus.
    await card.getByRole('button').evaluate(el => el.click());
    await card.getByRole('progressbar').waitFor();
    await creator.waitForFunction(() => window.__held.length > 0);
    check(await focused(composer));
    await complete(card); check(await focused(composer));
  });
  await step(`sender departure preserves ${failureFocus} focus through failure`, async () => {
    const card = await offer('failure.bin'); await start(card);
    const failureOwner = failureFocus === 'composer' ? composer : failureFocus === 'other' ? saveLink(fileCard(guest, 'keyboard-Enter.bin')) : null;
    if (failureOwner) await failureOwner.focus();
    await creator.close();
    await card.locator('.file-status-error').waitFor();
    if (failureOwner) check(await focused(failureOwner)); else await retained(card);
    check(await card.getByRole('link').count() === 0);
  });
  console.log(baseline ? 'PASS old-main BODY defect reproduced; baseline mode does not validate repaired focus' : 'PASS Download focus checks; synthetic crypto holds, real local transport; no screen-reader claim');
} catch(error) {
  console.error(`FAIL ${phase} (${error?.name || 'Error'}); details suppressed to protect capabilities`);
  process.exitCode = 1;
} finally {
  for (const context of contexts) {
    try { await context.close(); }
    catch { console.error('FAIL context cleanup; details suppressed'); process.exitCode = 1; }
  }
  try { await browser?.close(); }
  catch { console.error('FAIL browser cleanup; details suppressed'); process.exitCode = 1; }
}
