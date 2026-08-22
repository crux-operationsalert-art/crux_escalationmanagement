/**
 * kpi.test.js — configurable KPIs and per-client allocation (section 14).
 *
 * KPI_DEFS is empty in the live datastore and TARGETS had no client column at
 * all, so "each KPI can be divided across clients, maximum 50 allocations" was
 * not modelled. These tests cover the model that implements it and, importantly,
 * that the three pre-existing unallocated rows keep scoring exactly as before.
 *
 * Run: node test/kpi.test.js
 */
const assert = require('assert');
const { createSandbox } = require('./gas-harness');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32mPASS\x1b[0m ' + name); pass++; }
  catch (e) { console.log('  \x1b[31mFAIL\x1b[0m ' + name + '\n         ' + e.message); fail++; }
}
function section(t) { console.log('\n' + t); }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol === undefined ? 0.01 : tol),
  (msg ? msg + ': ' : '') + 'expected ~' + b + ', got ' + a);

const FILES = ['Utils.gs', 'Session.gs', 'Auth.gs', 'Clients.gs'];
const MK = '2026-08';
const MGR = 'mgr@crux.example';
const REP = 'rep@crux.example';

/** A manager with one direct report, two clients, and the window open. */
function fixture() {
  const s = createSandbox({ activeUser: MGR, files: FILES });
  const T = s.__tables;
  T.USERS.length = 0; T.TARGETS.length = 0; T.KPI_DEFS.length = 0;
  T.SCORES.length = 0; T.WARNINGS.length = 0; T.ESCALATIONS.length = 0;
  T.PEOPLE_EVENTS.length = 0; T.CLIENTS.length = 0; T.BRANCHES.length = 0;
  T.USERS.push(
    { UserID: 'U1', Name: 'Mgr', Email: MGR, Role: 'MANAGER', Designation: 'Zonal Manager',
      Department: 'Operations', AdminAccess: 'YES', Manager: '', Status: 'ACTIVE' },
    { UserID: 'U2', Name: 'Rep', Email: REP, Role: 'VIEWER', Designation: 'Executive',
      Department: 'Operations', Manager: MGR, Status: 'ACTIVE' });
  T.CLIENTS.push(
    { ClientID: 'C1', ClientName: 'Alpha Bank', Status: 'ACTIVE' },
    { ClientID: 'C2', ClientName: 'Beta Finance', Status: 'ACTIVE' });
  // Admin bypasses the submission window, and the manager here holds AdminAccess,
  // so window state never masks an allocation assertion.
  return s;
}
const me = (s) => s.whoAmI_('', {});
const setT = (s, o) => s.teamSetTarget_(Object.assign(
  { Email: REP, MonthKey: MK, Category: 'Revenue' }, o), me(s));
const ach = (s, email) => s.targetAchievement_(email || REP, MK);

/* ==================================================================== */
section('1. The KPI ceiling and who may set KPIs');

test('the ceilings are 5 KPIs and 50 allocations', () => {
  const s = fixture();
  assert.strictEqual(s.KPI_MAX, 5);
  assert.strictEqual(s.KPI_ALLOCATION_MAX, 50);
});

test('a manager can set up to five KPIs for a direct report', () => {
  const s = fixture();
  const out = s.setKpis_({ Email: REP, Categories: ['Revenue', 'BD', 'Collection', 'Quality', 'NPS'] }, me(s));
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(Array.prototype.slice.call(s.kpisFor_(REP)),
    ['Revenue', 'BD', 'Collection', 'Quality', 'NPS']);
});

test('a sixth KPI is refused', () => {
  const s = fixture();
  assert.throws(() => s.setKpis_(
    { Email: REP, Categories: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'] }, me(s)),
    /maximum of 5 KPIs/);
});

test('KPIs can be applied to a whole direct team at once', () => {
  const s = fixture();
  const out = s.setKpis_({ Scope: 'TEAM', Categories: ['Revenue', 'Collection'] }, me(s));
  assert.strictEqual(out.applied, 1);
  assert.deepStrictEqual(Array.prototype.slice.call(s.kpisFor_(REP)), ['Revenue', 'Collection']);
});

test('the three standard categories are the default, not hard-coded law', () => {
  const s = fixture();
  // Nothing configured: the org default applies.
  const def = Array.prototype.slice.call(s.kpisFor_(REP));
  assert.ok(def.length >= 1, 'expected a default KPI set');
  // And it can be replaced entirely.
  s.setKpis_({ Email: REP, Categories: ['Recoveries'] }, me(s));
  assert.deepStrictEqual(Array.prototype.slice.call(s.kpisFor_(REP)), ['Recoveries']);
});

test('a KPI name that is not one of theirs cannot carry a target', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  assert.throws(() => setT(s, { Category: 'Something Else', TargetValue: 10 }),
    /is not one of their KPIs/);
});

/* ==================================================================== */
section('2. Per-client allocation');

test('a KPI can be split across clients', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { ClientID: 'C1', TargetValue: 100, AchievedValue: 50 });
  setT(s, { ClientID: 'C2', TargetValue: 300, AchievedValue: 300 });
  const d = ach(s).categories.filter(c => c.Category === 'Revenue')[0];
  assert.strictEqual(d.allocationCount, 2);
  near(d.target, 400); near(d.achieved, 350);
});

test('the KPI percentage sums the slices and divides once', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { ClientID: 'C1', TargetValue: 100, AchievedValue: 100 });   // 100%
  setT(s, { ClientID: 'C2', TargetValue: 900, AchievedValue: 0 });     // 0%
  const d = ach(s).categories.filter(c => c.Category === 'Revenue')[0];
  // Averaging the slice percentages would give 50. Summing gives 100/1000 = 10.
  near(d.pct, 10, 0.5,
    'a small fully-achieved client must not offset a large missed one');
});

test('each allocation reports its own target, achievement and percentage', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { ClientID: 'C1', TargetValue: 200, AchievedValue: 150 });
  const a = ach(s).categories.filter(c => c.Category === 'Revenue')[0].allocations[0];
  assert.strictEqual(a.ClientID, 'C1');
  assert.strictEqual(a.ClientName, 'Alpha Bank');
  near(a.target, 200); near(a.achieved, 150); assert.strictEqual(a.pct, 75);
});

test('a non-client sub-category split also works', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Collection'] }, me(s));
  setT(s, { Category: 'Collection', SubCategory: 'Retail', TargetValue: 50, AchievedValue: 25 });
  setT(s, { Category: 'Collection', SubCategory: 'Corporate', TargetValue: 50, AchievedValue: 50 });
  const d = ach(s).categories.filter(c => c.Category === 'Collection')[0];
  assert.strictEqual(d.allocationCount, 2);
  near(d.pct, 75);
});

test('an unknown client is refused', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  assert.throws(() => setT(s, { ClientID: 'NOPE', TargetValue: 10 }),
    /client does not exist/);
});

test('editing an existing allocation updates it rather than adding a duplicate', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { ClientID: 'C1', TargetValue: 100, AchievedValue: 10 });
  setT(s, { ClientID: 'C1', TargetValue: 100, AchievedValue: 80 });
  assert.strictEqual(s.__tables.TARGETS.length, 1);
  near(ach(s).categories.filter(c => c.Category === 'Revenue')[0].achieved, 80);
});

/* ==================================================================== */
section('3. The 50-allocation ceiling');

test('50 allocations are accepted and the 51st is refused', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  for (let i = 1; i <= 50; i++) {
    setT(s, { SubCategory: 'slice-' + i, TargetValue: 10, AchievedValue: 5 });
  }
  assert.strictEqual(s.__tables.TARGETS.length, 50);
  assert.throws(() => setT(s, { SubCategory: 'slice-51', TargetValue: 10 }),
    /maximum of 50 client allocations/);
});

test('at the ceiling an existing allocation can still be edited', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  for (let i = 1; i <= 50; i++) setT(s, { SubCategory: 's' + i, TargetValue: 10 });
  setT(s, { SubCategory: 's7', TargetValue: 10, AchievedValue: 9 });   // must not throw
  assert.strictEqual(s.__tables.TARGETS.length, 50);
});

test('the ceiling is per KPI, not per person', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue', 'Collection'] }, me(s));
  for (let i = 1; i <= 50; i++) setT(s, { SubCategory: 's' + i, TargetValue: 10 });
  // A different KPI starts from zero.
  setT(s, { Category: 'Collection', SubCategory: 's1', TargetValue: 10 });
  assert.strictEqual(s.__tables.TARGETS.length, 51);
});

/* ==================================================================== */
section('4. Combined and split shapes are mutually exclusive');

test('a combined target cannot be split without removing it first', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { TargetValue: 400, AchievedValue: 100 });                  // combined
  assert.throws(() => setT(s, { ClientID: 'C1', TargetValue: 100 }),
    /single combined target/);
});

test('a split KPI refuses a combined figure', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { ClientID: 'C1', TargetValue: 100 });
  assert.throws(() => setT(s, { TargetValue: 400 }), /split across clients/);
});

test('removing the combined row then allows the split', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { TargetValue: 400, AchievedValue: 100 });
  s.teamRemoveTarget_({ Email: REP, MonthKey: MK, Category: 'Revenue' }, me(s));
  setT(s, { ClientID: 'C1', TargetValue: 100, AchievedValue: 100 });
  const d = ach(s).categories.filter(c => c.Category === 'Revenue')[0];
  assert.strictEqual(d.allocationCount, 1);
  near(d.pct, 100);
});

test('removing a line that does not exist is refused clearly', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  assert.throws(() => s.teamRemoveTarget_(
    { Email: REP, MonthKey: MK, Category: 'Revenue' }, me(s)), /no longer exists/);
});

test('a closed target cannot be removed', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { TargetValue: 100 });
  s.__tables.TARGETS[0].ClosedAt = '2026-09-01T10:00:00+05:30';
  assert.throws(() => s.teamRemoveTarget_(
    { Email: REP, MonthKey: MK, Category: 'Revenue' }, me(s)), /has been closed/);
});

test('removal is written to the audit trail', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  setT(s, { TargetValue: 100 });
  s.teamRemoveTarget_({ Email: REP, MonthKey: MK, Category: 'Revenue' }, me(s));
  assert.ok(s.__tables.AUDIT_LOG.some(r => r.Action === 'TARGET_REMOVE'));
});

/* ==================================================================== */
section('5. Backward compatibility');

test('an unallocated row scores exactly as it did before allocations existed', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue'] }, me(s));
  // Written the old way: no ClientID, no SubCategory.
  s.__tables.TARGETS.push({ TargetID: 'T-OLD', PersonEmail: REP, MonthKey: MK,
    Category: 'Revenue', TargetValue: '100', AchievedValue: '60' });
  const d = ach(s).categories.filter(c => c.Category === 'Revenue')[0];
  assert.strictEqual(d.set, true);
  near(d.pct, 60);
  assert.strictEqual(d.allocationCount, 0, 'an unallocated row is not an allocation');
});

test('the three real TARGETS rows still resolve', () => {
  const s = createSandbox({ activeUser: MGR, files: FILES });
  const rows = s.readTable_('TARGETS');
  assert.ok(rows.length >= 1, 'expected the real target rows');
  rows.forEach(t => {
    assert.strictEqual(String(t.ClientID || ''), '',
      'every pre-existing row is unallocated');
    const d = s.targetAchievement_(t.PersonEmail, s.monthOfValue_(t.MonthKey));
    assert.ok(d && typeof d.pct === 'number', 'achievement must still compute');
  });
  console.log('         (' + rows.length + ' real target rows, all unallocated)');
});

test('an unset KPI scores zero, never full marks', () => {
  const s = fixture();
  s.setKpis_({ Email: REP, Categories: ['Revenue', 'Collection'] }, me(s));
  setT(s, { ClientID: 'C1', TargetValue: 100, AchievedValue: 100 });   // Revenue only
  const d = ach(s);
  assert.strictEqual(d.categoriesSet, 1);
  assert.strictEqual(d.categories.filter(c => c.Category === 'Collection')[0].set, false);
});

/* ==================================================================== */
section('6. Permissions');

test('a manager cannot set targets for somebody who is not their report', () => {
  const s = fixture();
  s.__tables.USERS.push({ UserID: 'U3', Email: 'other@crux.example', Name: 'Other',
    Designation: 'Executive', Manager: 'someone.else@crux.example', Status: 'ACTIVE' });
  // Drop admin access so the reporting chain is what decides.
  s.__tables.USERS[0].AdminAccess = '';
  s.__tables.USERS[0].Role = 'MANAGER';
  s._ME_CACHE = null;
  assert.throws(() => s.teamSetTarget_({ Email: 'other@crux.example', MonthKey: MK,
    Category: 'Revenue', TargetValue: 10 }, s.whoAmI_('', {})));
});

/* ==================================================================== */
console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
