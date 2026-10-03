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

  const es = process.env.TEST_LOCALE === 'es-ES';
  const labels = es ? {
    find:'Buscar en la conversación', search:'Buscar mensajes visibles', next:'Siguiente coincidencia', previous:'Coincidencia anterior', close:'Cerrar búsqueda', empty:'Sin coincidencias en los mensajes visibles'
  } : {
    find:'Find in conversation', search:'Search visible messages', next:'Next match', previous:'Previous match', close:'Close search', empty:'No matches in visible messages'
  };
  const find = guest.getByRole('button',{name:labels.find,exact:true});
  const search = guest.getByRole('searchbox',{name:labels.search,exact:true});
  const next = guest.getByRole('button',{name:labels.next,exact:true});
  const previous = guest.getByRole('button',{name:labels.previous,exact:true});
  const close = guest.getByRole('button',{name:labels.close,exact:true});
  const count = guest.locator('.conversation-find-count');
  const log = guest.locator('.chat-log');
  const selected = guest.locator('.bubble-find-selected');
  const focused = locator => locator.evaluate(el=>el===document.activeElement);
  const scrollTop = () => log.evaluate(el=>el.scrollTop);
  const settled = () => guest.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  async function send(text) {
    await creator.locator('.composer textarea').fill(text);
    await creator.locator('.composer button[type=submit]').click();
    await guest.locator('.bubble p').filter({hasText:text}).waitFor();
  }
  async function matches(total, position) {
    const expected = position ? (es ? `Mensaje ${position} de ${total}` : `Message ${position} of ${total}`) : total ? (es ? `${total} mensajes coincidentes` : `${total} matching messages`) : labels.empty;
    await guest.waitForFunction(({expected})=>document.querySelector('.conversation-find-count')?.textContent===expected,{expected});
  }
  async function selectedText(text) {
    check(await selected.count()===1);
    check(await selected.locator('p').textContent()===text);
  }
  await step('seed real encrypted conversation with text and file',async()=>{
    await send('Alpha [a+b] first repeated [a+b]');
    for(let i=0;i<12;i++) await send(`Spacer ${i}: ${'synthetic text '.repeat(12)}`);
    await send('ALPHA [A+B] second');
    for(let i=12;i<24;i++) await send(`Spacer ${i}: ${'synthetic text '.repeat(12)}`);
    await send('alpha third');
    await creator.locator('input[type=file]').setInputFiles({name:'file-only-token.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});
    await guest.locator('.file-card').filter({hasText:'file-only-token.txt'}).waitFor();
    check(await log.evaluate(el=>el.scrollHeight>el.clientHeight));
  });
  await step('localized literal matching counts messages, excludes filenames',async()=>{
    await find.click(); await search.waitFor(); check(await focused(search));
    const before=await scrollTop();
    await search.fill('[a+b]'); await matches(2); await settled();
    check(Math.abs(await scrollTop()-before)<2); check(await selected.count()===0);
    await search.fill('file-only-token'); await matches(0);
    await search.fill('alpha'); await matches(3);
    await search.fill(''); check(await selected.count()===0);
    check(await next.isDisabled() && await previous.isDisabled());
    await search.fill('ALPHA'); await matches(3);
  });
  await step('Enter and Shift Enter wrap with input focus and explicit scroll',async()=>{
    await search.press('Enter'); await matches(3,1); await selectedText('Alpha [a+b] first repeated [a+b]'); check(await focused(search));
    await settled(); check(await scrollTop()<100);
    await search.press('Shift+Enter'); await matches(3,3); await selectedText('alpha third'); check(await focused(search));
    await search.press('Enter'); await matches(3,1);
    await next.click(); await matches(3,2); check(await focused(next));
    await previous.click(); await matches(3,1); check(await focused(previous));
    await search.focus();
  });
  await step('incoming match and query edits do not steal focus or scroll',async()=>{
    await settled(); const before=await scrollTop();
    await send('Alpha new arrival'); await matches(4,1); await settled();
    check(await focused(search)); check(Math.abs(await scrollTop()-before)<2);
    await search.fill('spacer'); await matches(24); await settled();
    check(await selected.count()===0); check(Math.abs(await scrollTop()-before)<2);
    check(await guest.locator('.jump-to-latest').count()===1);
    await guest.locator('.jump-to-latest').click(); await settled();
    check(await log.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<50));
  });
  await step('Escape restores opener only from search; close and reopen clears query',async()=>{
    const composer=guest.locator('.composer textarea'); await composer.focus();
    await guest.keyboard.press('Escape'); check(await search.count()===1); check(await focused(composer));
    await search.focus(); await search.press('Escape'); await search.waitFor({state:'detached'}); check(await focused(find));
    await find.click(); check(await search.inputValue()===''); check(await selected.count()===0);
    await search.fill('alpha'); await close.click(); await search.waitFor({state:'detached'});
    await find.click(); check(await search.inputValue()==='');
  });
  await step('terminal room removes active search',async()=>{
    await search.fill('alpha'); await creator.getByRole('button',{name:'Destroy',exact:true}).click();
    await guest.locator('.composer').waitFor({state:'detached'});
    check(await search.count()===0); check(await selected.count()===0);
  });
  await step('selected expired message leaves no stale result',async()=>{
    await creator.goto(origin.href);
    await creator.getByRole('button',{name:'custom',exact:true}).first().click();await creator.getByRole('spinbutton',{name:'Message vanish duration',exact:true}).fill('0.1');
    await creator.getByRole('button',{name:'Create private conversation',exact:true}).click(); await ready(creator);
    roomId=new URL(creator.url()).pathname.split('/').pop();
    await guest.goto(await invite()); await ready(guest);
    await send('Expiring synthetic needle');
    await find.click(); check(await search.inputValue()==='');
    await search.fill('needle'); await matches(1); await search.press('Enter'); await matches(1,1);
    await guest.locator('.bubble p').filter({hasText:'Expiring synthetic needle'}).waitFor({state:'detached',timeout:12000});
    await matches(0); check(await selected.count()===0); check(await focused(search));
    check(await next.isDisabled() && await previous.isDisabled());
    await creator.getByRole('button',{name:'Destroy',exact:true}).click();
    await guest.locator('.composer').waitFor({state:'detached'});
  });
  console.log('PASS conversation Find; real local HTTP/WS and policy expiry; no screen-reader claim');
} catch(error) {
  console.error(`FAIL ${phase} (${error?.name || 'Error'}); details suppressed to protect capabilities`);
  process.exitCode=1;
} finally {
  for(const context of contexts) {
    try { await context.close(); } catch { console.error('FAIL context cleanup; details suppressed'); process.exitCode=1; }
  }
  try { await browser?.close(); } catch { console.error('FAIL browser cleanup; details suppressed'); process.exitCode=1; }
}
