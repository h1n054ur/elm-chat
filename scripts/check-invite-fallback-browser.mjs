const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
const origin=process.env.TEST_ORIGIN || 'http://127.0.0.1:3128';
async function setup(locale, mode='reject') {
 const context=await browser.newContext({locale}); const page=await context.newPage();
 let invite={token:'synthetic-invite',createdAt:Date.now(),expiresAt:Date.now()+60000};let ws;let growth=[];
 const room={roomId:'invite-check',createdAt:Date.now(),expiresAt:null,inactivityTimeoutMs:null,maxAgeMs:null,disappearAfterReadSeconds:null,status:'open',participantCount:1,creatorJoined:true,lastActivityAt:Date.now(),membershipVersion:1};
 await page.addInitScript(({mode})=>{
  localStorage.setItem('elm-chat:creator:invite-check','synthetic-creator');
  Object.defineProperty(navigator,'share',{configurable:true,value: mode==='sharepending'?()=>new Promise((resolve,reject)=>{window.releaseShare=kind=>kind==='success'?resolve():reject(new DOMException('synthetic',kind==='cancel'?'AbortError':'NotAllowedError'));}):mode==='cancel'?()=>Promise.reject(new DOMException('cancel','AbortError')):mode==='sharefail'?()=>Promise.reject(new Error('synthetic share failure')):undefined});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>mode==='pending'?new Promise((resolve,reject)=>{window.releaseClipboard=()=>reject(new Error('synthetic denial'));window.resolveClipboard=resolve;}):Promise.reject(new Error('synthetic denial'))}});
 },{mode});
 await page.route('**/api/**',async route=>{
  const url=route.request().url();
  if(url.endsWith('/api/growth')){growth.push(route.request().postData());await route.fulfill({status:204});return;}
  if(url.endsWith('/invites/revoke')){invite={...invite,revokedAt:Date.now()};await route.fulfill({status:200,body:'{}'});return;}
  const body=url.endsWith('/invites')?(route.request().method()==='POST'?invite:[invite]):room;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.routeWebSocket('**/api/rooms/invite-check/ws',socket=>{ws=socket;socket.onMessage(raw=>{const m=JSON.parse(String(raw));if(m.type==='join')socket.send(JSON.stringify({type:'joined',room,sessionId:m.sessionId,creator:true,self:{sessionId:m.sessionId,creator:true,connectedAt:Date.now(),identityKey:m.identityKey,agreementKey:m.agreementKey},peers:[],presence:{count:1,connectedSessionIds:[m.sessionId]}}));});});
 await page.goto(origin+'/c/invite-check#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
 const copy=page.getByRole('button',{name:locale==='es-MX'?'Copiar enlace de invitación':'Copy invite link',exact:true});
 await copy.waitFor();
 return {page,context,copy,growth,setInvite:patch=>{invite={...invite,...patch};ws.send(JSON.stringify({type:'presence',presence:{count:1,connectedSessionIds:[]}}));},closeRoom:()=>ws.send(JSON.stringify({type:'room_state',status:'destroyed',reason:'synthetic'}))};
}
try{
for(const locale of ['en-US','es-MX']){
 let c=await setup(locale);let {page,copy}=c;
 await copy.focus();await copy.press('Enter');
 const field=page.locator('.manual-invite input');
 if(process.env.BASELINE){await page.waitForTimeout(100);assert.equal(await field.count(),0);console.log('Baseline reproduced: denied clipboard has no selectable field');await c.context.close();continue;}
 await field.waitFor();assert.equal(await field.evaluate(e=>document.activeElement===e),true);
 assert.equal(await field.evaluate(e=>e.selectionEnd-e.selectionStart===e.value.length),true);
 assert.equal(await field.getAttribute('readonly'),'');
 assert.equal(await page.locator('[role=alert] input,[aria-live] .manual-invite').count(),0);
 assert.equal(c.growth.some(x=>x?.includes('invite_share_handoff')),false);
 await field.press('Escape');await page.waitForTimeout(40);assert.equal(await copy.evaluate(e=>document.activeElement===e),true);
 await copy.click();await field.waitFor();c.setInvite({expiresAt:Date.now()-1});await field.waitFor({state:'detached'});
 await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>document.activeElement===document.body),false,'expiry focus has stable destination');
 await c.context.close();
 c=await setup(locale);({page,copy}=c);await copy.evaluate(e=>{document.activeElement?.blur();e.click();});await page.locator('.manual-invite input').waitFor();
 assert.equal(await page.locator('.manual-invite input').evaluate(e=>document.activeElement===e),true,'body origin still focuses deliberate fallback');
 await page.locator('.manual-invite input').press('Escape');await page.waitForTimeout(40);assert.equal(await copy.evaluate(e=>document.activeElement===e),true,'restores actual button, not BODY');await c.context.close();
 c=await setup(locale,'pending');({page,copy}=c);await copy.click();await page.waitForFunction(()=>window.releaseClipboard);
 await page.locator('textarea').focus();await page.evaluate(()=>window.releaseClipboard());await page.locator('.manual-invite input').waitFor();
 assert.equal(await page.locator('textarea').evaluate(e=>document.activeElement===e),true,'no async focus theft');await c.context.close();
 c=await setup(locale,'pending');({page,copy}=c);await copy.click();await page.waitForFunction(()=>window.releaseClipboard);
 c.setInvite({consumedAt:Date.now()});await copy.waitFor({state:'detached'});await page.evaluate(()=>window.releaseClipboard());await page.waitForTimeout(80);assert.equal(await page.locator('.manual-invite').count(),0,'no stale invite reveal');await c.context.close();
 c=await setup(locale);({page,copy}=c);await copy.click();await page.locator('.manual-invite').waitFor();await page.getByRole('button',{name:locale==='es-MX'?'Eliminar':'Remove',exact:true}).click();await page.locator('.manual-invite').waitFor({state:'detached'});await c.context.close();
 c=await setup(locale);({page,copy}=c);await copy.click();await page.locator('.manual-invite').waitFor();c.closeRoom();await page.locator('.manual-invite').waitFor({state:'detached'});await c.context.close();
 c=await setup(locale,'pending');({page,copy}=c);await copy.click();await page.waitForFunction(()=>window.releaseClipboard);
 await page.evaluate(()=>navigator.clipboard.writeText=()=>Promise.resolve());await copy.click();
 await page.waitForTimeout(60);const notice=await page.locator('.room-notice').innerText();
 await page.evaluate(()=>window.releaseClipboard());await page.waitForTimeout(60);
 assert.equal(await page.locator('.manual-invite').count(),0,'superseded failure does not restore fallback');
 assert.equal(await page.locator('.room-notice').innerText(),notice,'superseded failure preserves new success');await c.context.close();
 c=await setup(locale,'pending');({page,copy}=c);await copy.click();await page.waitForFunction(()=>window.releaseClipboard);
 await page.getByRole('button',{name:locale==='es-MX'?'Eliminar':'Remove',exact:true}).click();
 await page.getByText(locale==='es-MX'?'Invitación eliminada.':'Invite removed.',{exact:true}).waitFor();
 const removedNotice=await page.locator('.room-notice').innerText();await page.evaluate(()=>window.releaseClipboard());await page.waitForTimeout(80);
 assert.equal(await page.locator('.manual-invite').count(),0);assert.equal(await page.locator('.room-notice').innerText(),removedNotice,'pending failure preserves revoke notice');await c.context.close();
 for(const completion of ['success','failure','cancel']) {
 c=await setup(locale,'sharepending');({page}=c);await page.locator('.invite-actions button').first().click();await page.waitForFunction(()=>window.releaseShare);
 await page.getByRole('button',{name:locale==='es-MX'?'Eliminar':'Remove',exact:true}).click();await page.getByText(locale==='es-MX'?'Invitación eliminada.':'Invite removed.',{exact:true}).waitFor();
 const notice=await page.locator('.room-notice').innerText();await page.evaluate(kind=>window.releaseShare(kind),completion);await page.waitForTimeout(70);
 assert.equal(await page.locator('.manual-invite').count(),0);assert.equal(await page.locator('.room-notice').innerText(),notice,'late share completion preserves revoke notice');await c.context.close();
 }
 c=await setup(locale,'pending');({page,copy}=c);await copy.click();await page.waitForFunction(()=>window.resolveClipboard);
 await page.getByRole('button',{name:locale==='es-MX'?'Eliminar':'Remove',exact:true}).click();await page.getByText(locale==='es-MX'?'Invitación eliminada.':'Invite removed.',{exact:true}).waitFor();
 const successfulCopyNotice=await page.locator('.room-notice').innerText();await page.evaluate(()=>window.resolveClipboard());await page.waitForTimeout(70);
 assert.equal(await page.locator('.room-notice').innerText(),successfulCopyNotice,'late successful copy preserves revoke notice');await c.context.close();
 c=await setup(locale,'cancel');({page}=c);await page.locator('.room-actions button').filter({hasText:locale==='es-MX'?'Enviar invitación':'Send invite'}).click();await page.waitForTimeout(100);assert.equal(await page.locator('.manual-invite').count(),0,'share cancel stays cancellation');await c.context.close();
 c=await setup(locale,'sharefail');({page}=c);await page.locator('.room-actions button').filter({hasText:locale==='es-MX'?'Enviar invitación':'Send invite'}).click();await page.locator('.manual-invite').waitFor();await c.context.close();
 console.log(locale+': copy/select/dismiss, expiry, async focus, invalidation race, revoke, room end, share cancel/failure passed');
}
}finally{await browser.close();}
