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
  const fileCard = (p, name) => p.locator('.file-card').filter({ hasText: name });
  async function verifyBytes(p, name, bytes) {
    const saved = p.getByRole('link', { name: `Save file ${name}`, exact: true });
    await saved.waitFor();
    const pending = p.waitForEvent('download'); await saved.click();
    const download = await pending; const stream = await download.createReadStream();
    check(Boolean(stream)); const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    check(Buffer.concat(chunks).equals(bytes)); await download.delete();
  }
  await guest.evaluate(() => {
    const set = window.setTimeout.bind(window); const clear = window.clearTimeout.bind(window);
    window.__transferTimers = []; window.__clearedTimers = [];
    window.setTimeout = (callback, delay, ...args) => {
      const id = set(callback, delay, ...args);
      if (delay === 30000) window.__transferTimers.push({ id, run: () => callback(...args) });
      return id;
    };
    window.clearTimeout = id => { window.__clearedTimers.push(id); clear(id); };
  });
  await creator.evaluate(() => {
    const set = window.setTimeout.bind(window); const clear = window.clearTimeout.bind(window);
    window.__transferTimers = []; window.__clearedTimers = [];
    window.setTimeout = (callback, delay, ...args) => {
      const id = set(callback, delay, ...args);
      if (delay === 30000) window.__transferTimers.push({ id, run: () => callback(...args) });
      return id;
    };
    window.clearTimeout = id => { window.__clearedTimers.push(id); clear(id); };
  });
  const content = Buffer.from('Synthetic deferred download\n');
  await step('offer remains downloadable beyond 30s and recipient bytes match', async () => {
    await creator.locator('input[type=file]').setInputFiles([
      { name: 'waiting.txt', mimeType: 'text/plain', buffer: content }
    ]);
    const button = guest.getByRole('button', { name: 'Download waiting.txt', exact: true });
    await button.waitFor(); await guest.waitForTimeout(31000);
    check(await button.count() === 1);
    check(await guest.evaluate(() => window.__transferTimers.length === 0));
    for (const p of [creator, guest]) { await ready(p); check(await p.getByText('2 present', { exact:true }).count() === 1); }
    await button.click(); await verifyBytes(guest, 'waiting.txt', content);
    // Deliberately invoke cleared/queued callbacks: they must not demote completed data.
    await guest.evaluate(() => { for (const timer of window.__transferTimers) timer.run(); });
    check(await guest.getByRole('link', {name:'Save file waiting.txt',exact:true}).count() === 1);
  });
  await guest.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle); const counts = new Map();
    crypto.subtle.encrypt = async (...args) => {
      const data = args[2]; const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const marker = bytes[0]; const count = (counts.get(marker) || 0) + 1; counts.set(marker, count);
      if ((marker === 2 && count === 1) || ((marker === 7 || marker === 9) && count === 2)) await new Promise(() => {});
      return encrypt(...args);
    };
  });
  await step('requested no-chunk and partial stalls time out with no incomplete Save', async () => {
    await guest.locator('input[type=file]').setInputFiles([
      { name:'no-chunks.bin', mimeType:'application/octet-stream', buffer:Buffer.alloc(150000,2) },
      { name:'partial.bin', mimeType:'application/octet-stream', buffer:Buffer.alloc(150000,7) }
    ]);
    for (const name of ['no-chunks.bin','partial.bin']) await creator.getByRole('button',{name:`Download ${name}`,exact:true}).click();
    phase = 'partial chunk becomes visible';
    await creator.waitForFunction(() => { const p = [...document.querySelectorAll('.file-card')].find(c => c.textContent.includes('partial.bin'))?.querySelector('[role=progressbar]'); return p && Number(p.getAttribute('aria-valuenow')) > 0 && Number(p.getAttribute('aria-valuenow')) < 100; });
    await creator.evaluate(() => window.__transferTimers[1].run());
    check(await fileCard(creator, 'partial.bin').getByRole('progressbar').count() === 1);
    for (const name of ['no-chunks.bin','partial.bin']) {
      const card = fileCard(creator,name);
      phase = name === 'no-chunks.bin' ? 'zero-chunk request times out' : 'partial request times out';
      await card.getByText('Transfer failed: ask for a re-share',{exact:true}).waitFor({timeout:35000});
      check(await card.getByRole('link').count() === 0);
    }
  });
  await step('sender departure invalidates partial transfer with no incomplete Save', async () => {
    await guest.locator('input[type=file]').setInputFiles({name:'departure.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(150000,9)});
    const card=fileCard(creator,'departure.bin');
    await card.getByRole('button',{name:'Download departure.bin',exact:true}).click();
    await creator.waitForFunction(() => {const p=[...document.querySelectorAll('.file-card')].find(c=>c.textContent.includes('departure.bin'))?.querySelector('[role=progressbar]');return p && Number(p.getAttribute('aria-valuenow'))>0;});
    await guest.close();
    await card.getByText('Transfer failed: ask for a re-share',{exact:true}).waitFor();
    check(await card.getByRole('link').count()===0);
  });
  await creator.getByRole('button',{name:'Destroy',exact:true}).click(); await closed(creator); destroyed=true;
  await step('unrequested offer disappears at its independent message-policy expiry', async () => {
    await creator.goto(origin.href);
    // A separate synthetic six-second policy avoids racing the 31-second idle test.
    await creator.getByRole('button',{name:'custom',exact:true}).first().click();await creator.getByRole('spinbutton',{name:'Message vanish duration',exact:true}).fill('0.1');
    await creator.getByRole('button', {name:'Create private conversation',exact:true}).click();
    await ready(creator); destroyed=false;
    roomId=new URL(creator.url()).pathname.split('/').pop();
    const expiryGuest=await page(); await expiryGuest.goto(await invite());
    for(const p of [creator,expiryGuest]) {await p.getByText('2 present',{exact:true}).waitFor();await ready(p);}
    await creator.locator('input[type=file]').setInputFiles({name:'policy-expiry.txt',mimeType:'text/plain',buffer:content});
    const card=fileCard(expiryGuest,'policy-expiry.txt');
    await card.getByRole('button',{name:'Download policy-expiry.txt',exact:true}).waitFor();
    await card.waitFor({state:'detached',timeout:10000});
    await creator.getByRole('button',{name:'Destroy',exact:true}).click();await closed(creator);destroyed=true;
  });
  console.log('PASS local file-request lifecycle; only stall encryption and queued timer replay injected; no capability artifacts');
} catch(error) {
  console.error(`FAIL ${phase} (${error?.name || 'Error'}); details suppressed to protect capabilities`); process.exitCode=1;
} finally {
  if (!destroyed && roomPage && !roomPage.isClosed()) {
    try { await roomPage.getByRole('button',{name:'Destroy',exact:true}).click({timeout:2000}); } catch {}
  }
  for(const context of contexts) await context.close().catch(()=>{});
  try { await browser?.close(); }
  catch { console.error('FAIL browser cleanup; details suppressed'); process.exitCode=1; }
}
