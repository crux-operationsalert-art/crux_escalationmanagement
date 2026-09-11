/**
 * build-harness.js — assemble the real SPA into a standalone page.
 *
 * src/Index.html is an Apps Script template: it pulls in Styles and App through
 * `<?!= include(...) ?>` and receives its bootstrap from the server. This inlines
 * both, stubs `google.script.run` with canned responses, and appends a probe that
 * measures the layout and writes the numbers into the DOM.
 *
 * That makes section 32 testable: headless Chromium loads the page, the probe
 * reports whether the document scrolls sideways and whether the navigation stays
 * on screen, and --dump-dom hands the numbers back. No CDP, no Playwright.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
const inner = (html) => {           // strip the outer <style>/<script> wrapper
  const m = /^\s*<(style|script)[^>]*>([\s\S]*)<\/\1>\s*$/.exec(html.trim());
  return m ? m[2] : html;
};

const styles = inner(read('Styles.html'));
const app = read('App.html');

/** A signed-in manager with a team, so the widest screens actually render. */
const BOOT = {
  user: { email: 'mgr@crux.example', name: 'Mgr', role: 'ADMIN', active: true },
  app: { name: 'Crux Escalation Matrix', company: 'Crux Risk Management Pvt Ltd',
         timezone: 'Asia/Kolkata', dateFormat: 'dd-MMM-yyyy', testMode: false, version: '1.0.0' },
  nav: [{ key: 'dashboard', label: 'Dashboard' }, { key: 'clients', label: 'Clients' },
        { key: 'escalations', label: 'Escalations' }, { key: 'warnings', label: 'Warnings' },
        { key: 'admin', label: 'Admin' }, { key: 'logs', label: 'Logs' },
        { key: 'profile', label: 'My profile' }],
  scheduledJobs: [], sessionId: '', signInError: '',
  deepLink: { route: '', tab: '', action: '', preview: '' }
};

/** Canned RPC data. Rows are deliberately long and wide to stress the layout. */
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
/** The shape paginate_ actually returns: { total, page, size, rows }. Getting
    this wrong makes every list view render its empty state, which would silently
    defeat the whole point of a layout test. */
const page = (list) => ({ total: list.length, page: 1, size: 200, rows: list });

const CLIENTS = rows(28, i => ({
  ClientID: 'CLI-' + i, ClientName: 'Client Number ' + i, ClientCode: 'CL' + i,
  ClientEmail: 'ops' + i + '@example.com', ClientCC: 'cc@example.com',
  HeadOfficeEmail: 'ho' + i + '@example.com', HeadOfficeCC: '',
  DefaultLocationHead: 'lh@crux.example', Status: 'ACTIVE',
  branches: 30, matrixComplete: i % 2 === 0, UpdatedAt: '2026-08-20T10:00:00+05:30',
}));
const BRANCHES = rows(40, i => ({
  BranchID: 'BR-' + i, ClientID: 'CLI-1',
  BranchName: 'A Branch With Quite A Long Name ' + i, BranchCode: 'BRC-' + i,
  Address: 'A long street address that goes on for a while, Pune, Maharashtra 411001',
  Location: 'Pune', Zone: 'West', Status: 'ACTIVE',
  CruxPOCName: 'Poc Person ' + i, CruxPOCEmail: 'poc' + i + '@crux.example',
  CruxPOCMobile: '9800000000', BranchManagerName: 'Manager Person ' + i,
  BranchManagerEmail: 'bm' + i + '@example.com', BranchManagerMobile: '9800000001',
  LocationHead: 'lh@crux.example', UpdatedAt: '2026-08-20T10:00:00+05:30',
}));
const ESCALATIONS = rows(30, i => ({
  EscalationID: 'ESC-' + (3000 + i), Type: 'RAISED', Date: '2026-08-0' + (i % 9),
  ClientID: 'CLI-1', BranchID: 'BR-1', BranchCode: 'BRC-1',
  ContactName: 'Contact Person ' + i, ContactPhone: '9800000002',
  Category: 'Billing and invoicing dispute', Severity: 'High',
  EscalatedAgainst: 'A Person With A Long Name ' + i, AgainstEmail: 'p' + i + '@crux.example',
  Description: 'A fairly long description of what went wrong, repeated to make the cell wide.',
  AssignedOwner: 'owner@crux.example', RequiredAction: 'Do the needful promptly',
  TargetDate: '2026-08-25', Status: 'OPEN', CreatedBy: 'a@crux.example',
  CreatedAt: '2026-08-05T10:00:00+05:30', UpdatedAt: '2026-08-06T10:00:00+05:30',
}));
const WARNINGS = rows(15, i => ({
  WarningID: 'WRN-' + i, IssuedAt: '2026-08-1' + (i % 9) + 'T10:00:00+05:30',
  PersonEmail: 'p' + i + '@crux.example', PersonName: 'Person ' + i, Category: 'PROCESS',
  StrikeLevel: 'MANUAL', Summary: 'A summary of the warning that is reasonably long',
  IssuedBy: 'mgr@crux.example', Status: 'ISSUED', EscalationID: '', ClientID: 'CLI-1',
}));
const EMAIL_LOG = rows(25, i => ({
  LogID: 'EML-' + i, Timestamp: '2026-08-2' + (i % 9) + 'T10:00:00+05:30',
  Type: 'RAISED_ESCALATION', ClientID: 'CLI-1', BranchID: 'BR-1',
  ToAddr: 'a.rather.long.address' + i + '@example.com', CcAddr: 'cc.address@example.com',
  Subject: 'Escalation ESC-3000 raised at a named branch', Trigger: 'escalation.raise',
  SentBy: 'system@crux.example', Status: 'SENT', Attempt: 1, Error: '',
  MessageRef: 'gmail:abc', IdempotencyKey: 'K-' + i,
}));

const RESPONSES = {
  'auth.me': BOOT.user,
  'dashboard.summary': {
    counts: { clients: 28, branches: 812, escalations: 2, openEscalations: 2, warnings: 0 },
    total: 2,
    overdue: rows(12, i => ({ EscalationID: 'ESC-' + (1000 + i), ClientID: 'CLI-0001',
      Category: 'A rather long category label ' + i, Severity: 'High', Status: 'OPEN',
      TargetDate: '2026-08-2' + (i % 9), EscalatedAgainst: 'Somebody With A Long Name ' + i })),
    recent: rows(10, i => ({ EscalationID: 'ESC-' + (2000 + i), Category: 'Ops', Status: 'OPEN',
      Date: '2026-08-1' + (i % 9), ClientID: 'CLI-0002' })),
    incomplete: rows(8, i => ({ ClientID: 'CLI-000' + i, ClientName: 'A Client With A Long Name ' + i,
      missing: 'levels 3, 4 and 5 have no contact recorded at all for this location' })),
  },
  'clients.list': page(CLIENTS),
  'branches.list': page(BRANCHES),
  'escalations.list': page(ESCALATIONS),
  'warnings.list': { items: WARNINGS, total: WARNINGS.length, rows: WARNINGS },
  'admin.logs.email': page(EMAIL_LOG),
  'admin.logs.audit': page([]),
  'admin.logs.reminders': page([]),
  'warnings.categories': [['PROCESS', 'Process or SOP violation'], ['OTHER', 'Other']],
  'team.list': { items: rows(14, i => ({ Email: 'p' + i + '@crux.example', Name: 'Team Person ' + i,
    Designation: 'Executive', Department: 'Operations', Manager: 'mgr@crux.example',
    isDirect: true, MonthKey: '2026-08', targetRag: 'AMBER', scoreRag: 'RED',
    openWarnings: 0, openPip: false, targetsByCategory: [] })), monthKey: '2026-08' },
  'admin.users.list': rows(30, i => ({ UserID: 'USR-' + i, Name: 'User ' + i,
    Email: 'u' + i + '@crux.example', Role: 'VIEWER', Designation: 'Executive',
    Department: 'Operations', Status: 'ACTIVE', AdminAccess: '', InviteStatus: 'SENT' })),
  'admin.settings.get': rows(20, i => ({ Key: 'SETTING_' + i, Value: 'a value',
    Description: 'A description of what this setting does, which can be long', UpdatedBy: 'system' })),
  'admin.automation.status': { triggers: [], nextRuns: [] },
  'ai.status': { configured: false, enabled: false, model: '', keyPreview: '' },
  'windows.mine': { monthKey: '2026-08', target: { open: true, label: 'open' },
                    achievement: { open: false, label: 'closed' }, isAdmin: true },
  'windows.status': { target: { open: true, label: 'open' }, achievement: { open: false, label: 'closed' } },
  'profile.get': { Name: 'Mgr', Email: 'mgr@crux.example', Role: 'ADMIN', Department: 'Operations',
    Designation: 'Zonal Manager', team: rows(6, i => ({ Name: 'Rep ' + i,
    Email: 'r' + i + '@crux.example', Designation: 'Executive', Department: 'Operations' })),
    departments: ['Operations'], designations: { Operations: ['Executive'] } },
  'auth.orgChart': { departments: ['Operations'], designations: { Operations: ['Executive'] } },
  'users.pickList': { items: rows(30, i => ({ Email: 'u' + i + '@crux.example', Name: 'User ' + i })) },
  'escalations.mis': { rows: [], totals: {} },
  'kpis.get': { Email: 'r0@crux.example', categories: ['Revenue', 'Collection'],
                orgDefault: ['Revenue'], max: 5, allocationMax: 50, canEdit: true, directReports: 6 },
};

const stub = `
<script>
window.__BOOTSTRAP__ = ${JSON.stringify(BOOT)};
var __RESPONSES__ = ${JSON.stringify(RESPONSES)};
window.google = { script: { run: (function() {
  var ok = null, err = null;
  var api = {
    withSuccessHandler: function(f) { ok = f; return api; },
    withFailureHandler: function(f) { err = f; return api; },
    rpc: function(action, payload) {
      var data = Object.prototype.hasOwnProperty.call(__RESPONSES__, action)
        ? __RESPONSES__[action] : {};
      setTimeout(function() { try { ok({ ok: true, data: data }); } catch (e) {} }, 0);
    }
  };
  return api;
})() } };
</script>`;

/** Probe: reports the numbers section 32 is actually about. */
const probe = `
<script>
window.__measure__ = function() {
  var d = document.documentElement, b = document.body;
  var shell = document.querySelector('.app-shell');
  var side = document.querySelector('.sidebar');
  var main = document.querySelector('.main');
  var nav = document.querySelector('.nav-item');
  var box = function(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left),
             w: Math.round(r.width), h: Math.round(r.height),
             scrollW: el.scrollWidth, clientW: el.clientWidth,
             scrollH: el.scrollHeight, clientH: el.clientHeight };
  };
  // Scroll the content pane (or the document when stacked) to the bottom and see
  // whether the navigation is still reachable.
  var scroller = (main && main.scrollHeight > main.clientHeight + 2) ? main : (d);
  scroller.scrollTop = scroller.scrollHeight;
  var navAfter = nav ? Math.round(nav.getBoundingClientRect().top) : null;
  var widest = null, worst = 0;
  Array.prototype.forEach.call(document.querySelectorAll('table'), function(t) {
    var over = t.scrollWidth - (t.parentElement ? t.parentElement.clientWidth : 0);
    if (over > worst) { worst = over; widest = t.getAttribute('data-testid') || t.className; }
  });
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docScrollW: d.scrollWidth, docClientW: d.clientWidth,
    bodyScrollW: b.scrollWidth, bodyClientW: b.clientWidth,
    horizontalPageScroll: (d.scrollWidth - d.clientWidth) > 1 || (b.scrollWidth - b.clientWidth) > 1,
    shell: box(shell), sidebar: box(side), main: box(main),
    navTopAfterScroll: navAfter,
    scrolledPane: scroller === d ? 'document' : 'main',
    widestOverflowingTable: widest, widestOverflowPx: worst,
    // When the document is wider than the viewport, name the elements responsible
    // so a failure points at a selector rather than just a number.
    offenders: (function() {
      var vw = d.clientWidth, out = [];
      Array.prototype.forEach.call(document.querySelectorAll('#app *'), function(el) {
        var r = el.getBoundingClientRect();
        if (r.width < 1) return;
        if (r.right <= vw + 1) return;
        var cs = window.getComputedStyle(el);
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 60),
          testid: el.getAttribute('data-testid') || '',
          right: Math.round(r.right), w: Math.round(r.width),
          minW: cs.minWidth, ovX: cs.overflowX, disp: cs.display
        });
      });
      // Deepest first: the innermost offender is the real cause.
      return out.slice(-8);
    })(),
    tables: document.querySelectorAll('table').length
  };
};
</script>`;

const out = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness</title><style>${styles}</style></head><body>
<div id="app"><div class="boot"><div class="boot-inner"><div class="spinner"></div><div>Loading…</div></div></div></div>
<div id="toast" class="toast" aria-live="polite"></div>
<div id="busy" class="busy" style="display:none"><div class="spinner"></div><span>Working…</span></div>
<div id="modal" class="modal hidden" role="dialog" aria-modal="true">
  <div class="modal-card">
    <div class="modal-head"><div id="modal-title" class="modal-title"></div><button id="modal-close" class="icon-btn">×</button></div>
    <div id="modal-body" class="modal-body"></div>
    <div id="modal-foot" class="modal-foot"></div>
  </div>
</div>
${stub}
${app}
${probe}
<pre id="RESULT" style="display:none"></pre>
<script>
  // Give the SPA time to render, then publish the measurements for --dump-dom.
  // The SPA's router lives inside its IIFE, so navigate the way a user does:
  // click the nav item. data-testid is set by h() for exactly this purpose.
  var __route = (location.hash || '#dashboard').slice(1);
  setTimeout(function() {
    try {
      var nav = document.querySelector('[data-testid="nav-' + __route + '"]');
      if (nav) nav.click();
    } catch (e) {}
    setTimeout(function() {
      var r;
      try { r = window.__measure__(); } catch (e) { r = { error: String(e && e.message || e) }; }
      document.getElementById('RESULT').textContent = 'MEASURE:' + JSON.stringify(r);
    }, 700);
  }, 500);
</script>
</body></html>`;

const dest = path.join(__dirname, 'harness.html');
fs.writeFileSync(dest, out);
console.log('wrote ' + dest + ' (' + Math.round(out.length / 1024) + ' KB)');
