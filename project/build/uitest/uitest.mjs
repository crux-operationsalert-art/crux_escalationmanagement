import { chromium } from 'playwright';
const B = 'http://127.0.0.1:8787/functions/v1/crux';
const b = await chromium.launch({ args:['--no-sandbox'] });
const ctx = await b.newContext({ viewport:{width:1440,height:960} });
const p = await ctx.newPage();
const errs=[], warns=[];
p.on('pageerror', e => errs.push('PAGEERROR: '+e.message));
p.on('console', m => { if(m.type()==='error') errs.push('CONSOLE: '+m.text()); });
p.on('requestfailed', r => { if(!/gsi\/client|accounts\.google/.test(r.url())) warns.push('REQFAIL: '+r.url()+' '+r.failure()?.errorText); });

await p.goto(B, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(900);
console.log('signin visible:', await p.locator('#signin').isVisible());
console.log('ghint:', (await p.locator('#ghint').textContent())?.trim());
await p.screenshot({ path:'./shot-signin.png', fullPage:true });

await p.fill('#em','ops@cruxindia.co.in');
await p.fill('#pw','x');
await p.click('#go');
await p.waitForTimeout(1200);
console.log('app visible:', await p.locator('#app').isVisible());
console.log('nav tabs:', (await p.locator('#nav a').allTextContents()).map(s=>s.trim()).join(' | '));
console.log('who:', (await p.locator('#who').textContent())?.trim(), '/', (await p.locator('#whochair').textContent())?.trim());

const tabs = await p.locator('#nav a').evaluateAll(as=>as.map(a=>a.getAttribute('data-t')));
for (const t of tabs) {
  const before = errs.length;
  await p.click(`#nav a[data-t="${t}"]`);
  await p.waitForTimeout(800);
  const h = (await p.locator('#view h1').first().textContent().catch(()=>null)) || '(no h1)';
  console.log(`tab ${t.padEnd(10)} h1="${h.trim()}" newErrors=${errs.length-before}`);
  await p.screenshot({ path:`./shot-${t}.png`, fullPage:true });
}

// mobile
const mp = await (await b.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true })).newPage();
mp.on('pageerror', e => errs.push('MOB PAGEERROR: '+e.message));
await mp.goto(B, { waitUntil:'domcontentloaded' });
await mp.waitForTimeout(700);
await mp.fill('#em','ops@cruxindia.co.in'); await mp.fill('#pw','x'); await mp.click('#go');
await mp.waitForTimeout(1000);
console.log('mob bar visible:', await mp.locator('#mobbar').isVisible());
console.log('mob bar items:', (await mp.locator('#mobbar a').allTextContents()).map(s=>s.trim()).join(' | '));
await mp.screenshot({ path:'./shot-mobile.png', fullPage:true });
await mp.locator('#mobbar a[data-more]').click();
await mp.waitForTimeout(400);
console.log('sheet visible:', await mp.locator('#mobsheet').isVisible());
await mp.screenshot({ path:'./shot-mobile-sheet.png', fullPage:true });
// horizontal overflow check
const ov = await mp.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('mobile horizontal overflow px:', ov);

console.log('=== ERRORS ('+errs.length+') ===');
errs.forEach(e=>console.log(e));
console.log('=== WARNS ('+warns.length+') ===');
warns.slice(0,10).forEach(e=>console.log(e));
await b.close();
