import { chromium } from 'playwright-core';
const O = process.env.O, D = process.env.D;
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const sizes = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
for (const scheme of ['light', 'dark']) for (const [s, vp] of Object.entries(sizes)) {
  const tag = `${scheme}-${s}`;
  const mk = async () => (await b.newContext({ viewport: vp, colorScheme: scheme, locale: 'en-US' })).newPage();
  const c = await mk(), g = await mk();
  await c.goto(O + '/'); await c.waitForTimeout(400);
  await c.screenshot({ path: `${D}/landing-${tag}.png` });
  await c.goto(O + '/limits'); await c.waitForTimeout(300);
  await c.screenshot({ path: `${D}/limits-${tag}.png`, fullPage: true });
  await c.goto(O + '/');
  await c.getByRole('button', { name: 'Create private conversation', exact: true }).click();
  await c.locator('.composer textarea:not([disabled])').waitFor({ timeout: 30000 });
  await c.screenshot({ path: `${D}/room-empty-${tag}.png` });
  const rp = c.waitForResponse(r => r.url().includes('/invites') && r.request().method() === 'POST');
  await c.locator('.room-actions button').first().click();
  const tok = (await (await rp).json()).token;
  await c.waitForTimeout(500);
  await c.screenshot({ path: `${D}/room-invite-${tag}.png` });
  const u = new URL(c.url()); u.search = new URLSearchParams({ invite: tok }).toString();
  await g.goto(u.href);
  await g.locator('.composer textarea:not([disabled])').waitFor({ timeout: 30000 });
  for (const [p, t] of [[c, 'hey, is this the new chat?'], [g, 'yep, keys are in the URL fragment'], [c, 'nice. destroy when done']]) {
    await p.locator('.composer textarea').fill(t); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
  }
  await c.screenshot({ path: `${D}/room-chat-creator-${tag}.png` });
  await g.screenshot({ path: `${D}/room-chat-guest-${tag}.png` });
  await c.getByRole('button', { name: 'Destroy', exact: true }).click();
  await c.waitForTimeout(600);
  const conf = c.getByRole('button', { name: 'Destroy', exact: true }); if (await conf.count()) await conf.last().click().catch(() => {});
  await g.getByRole('heading', { name: 'Room gone', exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
  await g.screenshot({ path: `${D}/room-gone-${tag}.png` });
  await c.context().close(); await g.context().close();
}
await b.close(); console.log('ok');
