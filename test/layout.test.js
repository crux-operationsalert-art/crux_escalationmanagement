/**
 * layout.test.js — scrolling and responsive behaviour (section 32), measured in a
 * real browser rather than asserted about CSS text.
 *
 * Builds the actual SPA into a standalone page (test/layout/build-harness.js),
 * renders it in headless Chromium at several viewport sizes, drives it to each
 * route by clicking the nav, scrolls to the bottom, and reads back the geometry.
 *
 * Requires Chromium. Set CHROME to override the path. If it is not present the
 * suite reports that and exits 0 rather than failing a run that cannot do better.
 *
 * Run: node test/layout.test.js
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'layout');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32mPASS\x1b[0m ' + name); pass++; }
  catch (e) { console.log('  \x1b[31mFAIL\x1b[0m ' + name + '\n         ' + e.message); fail++; }
}
function section(t) { console.log('\n' + t); }

if (!fs.existsSync(CHROME)) {
  console.log('layout.test.js: Chromium not found at ' + CHROME + ' — skipping.');
  console.log('Set CHROME=/path/to/chrome to run these.');
  process.exit(0);
}

execFileSync('node', [path.join(DIR, 'build-harness.js')], { stdio: 'pipe' });

const cache = {};
function measure(width, route, height) {
  const key = width + 'x' + (height || 900) + '/' + route;
  if (cache[key]) return cache[key];
  const out = execFileSync(path.join(DIR, 'measure.sh'),
    [String(width), String(height || 900), route],
    { encoding: 'utf8', env: Object.assign({}, process.env, { CHROME }) }).trim();
  assert.ok(out, 'no measurement came back for ' + key + ' (did the page render?)');
  cache[key] = JSON.parse(out);
  return cache[key];
}

const ROUTES = ['dashboard', 'clients', 'escalations', 'warnings', 'logs', 'admin', 'profile'];
const WIDTHS = [360, 390, 768, 1024, 1440];
const DESKTOP = [1024, 1440];

/* ==================================================================== */
section('1. The page never scrolls horizontally');

WIDTHS.forEach(w => {
  test('no route scrolls the page sideways at ' + w + 'px', () => {
    const bad = ROUTES.filter(r => measure(w, r).horizontalPageScroll)
      .map(r => r + ' (' + measure(w, r).docScrollW + '/' + measure(w, r).docClientW + ')');
    assert.deepStrictEqual(bad, [],
      'these routes widen the document, so the header and nav slide out of view: ' + bad.join(', '));
  });
});

test('a wide table DOES overflow, and is contained rather than absent', () => {
  // If nothing overflowed anywhere, the test above would pass trivially and prove
  // nothing. Confirm the pressure is real: some table is wider than its box.
  const worst = Math.max(...ROUTES.map(r => measure(768, r).widestOverflowPx));
  assert.ok(worst > 100,
    'expected a genuinely wide table in the fixtures, widest overflow was ' + worst + 'px');
});

/* ==================================================================== */
section('2. The navigation stays reachable on long pages');

DESKTOP.forEach(w => {
  ROUTES.forEach(r => {
    test('nav is still on screen after scrolling ' + r + ' at ' + w + 'px', () => {
      const d = measure(w, r);
      assert.notStrictEqual(d.navTopAfterScroll, null, 'no nav item rendered');
      assert.ok(d.navTopAfterScroll >= 0,
        'the nav scrolled off the top (top: ' + d.navTopAfterScroll + 'px). The shell ' +
        'must be a fixed frame with an independently scrolling content pane.');
      assert.ok(d.navTopAfterScroll < d.viewport.h,
        'nav is below the fold (top: ' + d.navTopAfterScroll + ')');
    });
  });
});

test('the content pane is what scrolls on desktop, not the document', () => {
  const d = measure(1440, 'logs');
  assert.strictEqual(d.scrolledPane, 'main');
  assert.ok(d.main.scrollH > d.main.clientH,
    'the fixture should produce more content than fits');
});

test('the sidebar is bounded by the viewport, not by the content height', () => {
  const d = measure(1440, 'logs');
  assert.ok(d.sidebar.h <= d.viewport.h + 1,
    'sidebar is ' + d.sidebar.h + 'px tall in a ' + d.viewport.h + 'px viewport, so it ' +
    'grows with the content and its footer can never stay in view');
});

/* ==================================================================== */
section('3. Stacked layout below the breakpoint');

test('the document scrolls again when stacked', () => {
  const d = measure(390, 'logs');
  assert.strictEqual(d.scrolledPane, 'document',
    'a 100dvh frame with overflow:hidden would make a phone unscrollable');
});

test('the sidebar becomes a short top bar, not a full-height column', () => {
  const d = measure(390, 'dashboard');
  assert.ok(d.sidebar.h < 400, 'sidebar is ' + d.sidebar.h + 'px tall when stacked');
  assert.strictEqual(d.sidebar.top, 0, 'it should be stuck to the top');
});

test('the nav bar stays visible when stacked', () => {
  ['dashboard', 'escalations', 'logs'].forEach(r => {
    const d = measure(390, r);
    assert.ok(d.navTopAfterScroll >= 0 && d.navTopAfterScroll < 120,
      r + ': nav at ' + d.navTopAfterScroll + 'px after scrolling');
  });
});

/* ==================================================================== */
section('4. Short viewports');

test('a 500px-tall window still scrolls and keeps the nav', () => {
  const d = measure(1440, 'logs', 500);
  assert.strictEqual(d.horizontalPageScroll, false);
  assert.ok(d.navTopAfterScroll >= 0, 'nav at ' + d.navTopAfterScroll);
  assert.ok(d.main.scrollH > d.main.clientH, 'content should exceed a 500px window');
});

test('the shell matches the viewport height rather than overflowing it', () => {
  const d = measure(1440, 'dashboard', 500);
  assert.ok(Math.abs(d.shell.h - d.viewport.h) <= 2,
    'shell is ' + d.shell.h + 'px in a ' + d.viewport.h + 'px viewport');
});

/* ==================================================================== */
console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
