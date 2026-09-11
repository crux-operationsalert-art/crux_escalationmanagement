import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--no-sandbox'] });
const ctx = await b.newContext();
// stand in for the Google Identity script, which cannot load in this sandbox
await ctx.addInitScript(() => {
  window.google = { accounts: { id: {
    initialize(o){ window.__gsiInit = o.client_id; },
    renderButton(elm, o){ window.__gsiBtn = o.size; elm.innerHTML = '<div style="border:1px solid #d8d5cd;padding:12px;min-height:44px;text-align:center">Continue with Google</div>'; }
  } } };
});
const p = await ctx.newPage();
const errs=[]; p.on('pageerror', e=>errs.push(e.message));
await p.route('**/api/config', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ googleClientId:'1064617222271-tj4d14h5ngegc4la0b0i5f3u472q4ps0.apps.googleusercontent.com', workspaceDomain:'cruxindia.co.in' }) }));
await p.goto('http://127.0.0.1:8787/functions/v1/crux', { waitUntil:'domcontentloaded' });
await p.waitForTimeout(900);
console.log('gsi initialize called with client_id:', await p.evaluate(()=>window.__gsiInit));
console.log('renderButton called, size:', await p.evaluate(()=>window.__gsiBtn));
console.log('ghint:', (await p.locator('#ghint').textContent()).trim());
console.log('button rendered in #gbtn:', (await p.locator('#gbtn').innerHTML()).length > 0);
console.log('pageerrors:', errs.length, errs.join(' | '));
await p.screenshot({ path:'./shot-signin-google.png', fullPage:true });
await b.close();
