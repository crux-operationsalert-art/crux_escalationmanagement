import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--no-sandbox'] });
const p = await (await b.newContext()).newPage();
const errs=[]; p.on('pageerror', e=>errs.push(e.message));
await p.goto('http://127.0.0.1:8899/?api=http://127.0.0.1:8787', { waitUntil:'domcontentloaded' });
await p.waitForTimeout(3200);          // past the 2.5s Google check
console.log('ghint:', (await p.locator('#ghint').textContent()).trim().replace(/\s+/g,' '));
await p.screenshot({ path:'./shot-nogoogle.png', fullPage:true });
await p.fill('#em','ops@cruxindia.co.in'); await p.fill('#pw','x'); await p.click('#go');
await p.waitForTimeout(1300);
console.log('signed in:', await p.locator('#app').isVisible());
console.log('nav:', (await p.locator('#nav a').allTextContents()).map(s=>s.trim()).join(' | '));
console.log('pageerrors:', errs.length, errs.join(' | '));
await b.close();
