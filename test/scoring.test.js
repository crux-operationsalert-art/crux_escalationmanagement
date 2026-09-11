/**
 * scoring.test.js — the monthly score (sections 17-22) and the three-strike
 * engine (section 9), exercised against the real exported data.
 *
 * SCORES, SCORE_LEDGER and KPI_DEFS are all empty in the live datastore, so none
 * of these rules had ever actually run on real input. This suite runs them.
 *
 * Run: node test/scoring.test.js
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

const FILES = ['Utils.gs', 'Session.gs', 'Auth.gs', 'Clients.gs', 'Escalation.gs', 'Scheduler.gs'];
const ADMIN = 'shantanu.suravase@cruxindia.co.in';
const MK = '2026-08';

/** Sandbox with the scheduler/email/AI side effects captured, not performed. */
function boot(opts = {}) {
  const s = createSandbox(Object.assign({ activeUser: ADMIN, files: FILES }, opts));
  s.sendEmail_ = (o) => {
    (s.__tables.__MAIL = s.__tables.__MAIL || []).push(o);
    return { status: 'SENT' };
  };
  s.geminiCall_ = () => 'stubbed factual summary.';
  s.getWebAppUrl_ = () => 'https://script.example/exec';
  return s;
}
const mail = (s) => s.__tables.__MAIL || [];

/** One person, one month, no history. Returns the sandbox. */
function personFixture(extra = {}) {
  const s = boot();
  const T = s.__tables;
  T.USERS.length = 0; T.TARGETS.length = 0; T.SCORES.length = 0;
  T.WARNINGS.length = 0; T.ESCALATIONS.length = 0; T.PEOPLE_EVENTS.length = 0;
  T.USERS.push(Object.assign({
    UserID: 'U1', Name: 'Asha', Email: 'asha@crux.example', Role: 'VIEWER',
    Designation: 'Executive', Department: 'Operations', Manager: '', Status: 'ACTIVE',
  }, extra));
  return s;
}
const addTarget = (s, o) => s.__tables.TARGETS.push(Object.assign(
  { TargetID: 'T' + (s.__tables.TARGETS.length + 1), PersonEmail: 'asha@crux.example',
    MonthKey: MK, Category: 'Revenue', TargetValue: '100', AchievedValue: '100' }, o));
const addEsc = (s, o) => s.__tables.ESCALATIONS.push(Object.assign(
  { EscalationID: 'E' + (s.__tables.ESCALATIONS.length + 1), Status: 'OPEN',
    AgainstEmail: 'asha@crux.example', Category: 'Ops',
    CreatedAt: MK + '-10T10:00:00+05:30' }, o));
const addWarn = (s, o) => s.__tables.WARNINGS.push(Object.assign(
  { WarningID: 'W' + (s.__tables.WARNINGS.length + 1), PersonEmail: 'asha@crux.example',
    IssuedAt: MK + '-12T10:00:00+05:30', Status: 'ISSUED', Notes: 'Test warning' }, o));
const addAppr = (s, o) => s.__tables.PEOPLE_EVENTS.push(Object.assign(
  { EventID: 'EV' + (s.__tables.PEOPLE_EVENTS.length + 1), PersonEmail: 'asha@crux.example',
    Type: 'APPRECIATION', Timestamp: MK + '-15T10:00:00+05:30', Notes: 'Good work' }, o));
const setRating = (s, r, email) => s.__tables.SCORES.push(
  { ScoreID: 'S1', PersonEmail: email || 'asha@crux.example', MonthKey: MK, ManagerRating: String(r) });

/* ==================================================================== */
section('1. Section 17 — the 75 / 25 split');

test('the weights are 75 target and 25 attribute', () => {
  const s = boot();
  assert.strictEqual(s.SCORE_TARGET_WEIGHT, 75);
  assert.strictEqual(s.SCORE_ATTRIBUTE_WEIGHT, 25);
  assert.strictEqual(s.SCORE_TARGET_WEIGHT + s.SCORE_ATTRIBUTE_WEIGHT, 100);
});

test('full achievement and a full rating give 100', () => {
  const s = personFixture();
  addTarget(s, { TargetValue: '100', AchievedValue: '100' });
  setRating(s, 10);
  const r = s.computeScore_('asha@crux.example', MK);
  near(r.targetScore, 75); near(r.attributeScore, 25); near(r.finalScore, 100);
});

test('half achievement gives half the target component', () => {
  const s = personFixture();
  addTarget(s, { TargetValue: '100', AchievedValue: '50' });
  setRating(s, 10);
  const r = s.computeScore_('asha@crux.example', MK);
  near(r.targetScore, 37.5); near(r.attributeScore, 25); near(r.finalScore, 62.5);
});

test('over-achievement is capped at 100 per cent of the target component', () => {
  const s = personFixture();
  addTarget(s, { TargetValue: '100', AchievedValue: '400' });
  setRating(s, 10);
  near(s.computeScore_('asha@crux.example', MK).targetScore, 75,
    0.01, 'a 400% achievement must not earn 300 points');
});

test('an unrated month is neutral, not zero-rated', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' });
  const r = s.computeScore_('asha@crux.example', MK);   // no ManagerRating row
  near(r.attributeScore, 25, 0.01, 'unrated must not read as a zero rating');
});

test('the components stay separately reported, never merged into one number', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '60' });
  setRating(s, 6);
  const r = s.computeScore_('asha@crux.example', MK);
  assert.ok('targetScore' in r && 'attributeScore' in r && 'finalScore' in r);
  near(r.targetScore + r.attributeScore, r.finalScore);
});

/* ==================================================================== */
section('2. Section 19 — escalation deductions');

test('one escalation takes 1 from the attribute component', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addEsc(s, {});
  const r = s.computeScore_('asha@crux.example', MK);
  near(r.attributeScore, 24); near(r.targetScore, 75); near(r.finalScore, 99);
});

test('escalations deduct 1 each while attribute remains', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  for (let i = 0; i < 5; i++) addEsc(s, {});
  near(s.computeScore_('asha@crux.example', MK).attributeScore, 20);
});

test('once the 25 attribute is spent, further escalations take 2 from target', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  for (let i = 0; i < 27; i++) addEsc(s, {});     // 25 to clear attribute, 2 spill over
  const r = s.computeScore_('asha@crux.example', MK);
  near(r.attributeScore, 0);
  near(r.targetScore, 75 - 4, 0.01, 'two spill-over escalations at -2 each');
});

test('the score never goes negative', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  for (let i = 0; i < 200; i++) addEsc(s, {});
  const r = s.computeScore_('asha@crux.example', MK);
  assert.ok(r.finalScore >= 0, 'got ' + r.finalScore);
  assert.ok(r.targetScore >= 0 && r.attributeScore >= 0);
});

test('an escalation against somebody else does not touch this person', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addEsc(s, { AgainstEmail: 'someone.else@crux.example' });
  near(s.computeScore_('asha@crux.example', MK).finalScore, 100);
});

test('an escalation in another month does not touch this month', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addEsc(s, { CreatedAt: '2026-06-10T10:00:00+05:30' });
  near(s.computeScore_('asha@crux.example', MK).finalScore, 100);
});

/* ==================================================================== */
section('3. Section 20 — warning deductions');

test('a warning zeroes the attribute component', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addWarn(s, {});
  near(s.computeScore_('asha@crux.example', MK).attributeScore, 0);
});

test('a warning also takes 5 from the target component', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addWarn(s, {});
  const r = s.computeScore_('asha@crux.example', MK);
  near(r.targetScore, 70); near(r.finalScore, 70);
});

test('after a warning, escalations take 2 from target', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addWarn(s, {});
  addEsc(s, {}); addEsc(s, {});
  const r = s.computeScore_('asha@crux.example', MK);
  near(r.attributeScore, 0);
  near(r.targetScore, 75 - 5 - 4, 0.01, 'warning -5, then two escalations at -2');
});

/* ==================================================================== */
section('4. Section 21 — appreciation');

test('appreciation recovers ground lost to an escalation', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addEsc(s, {}); addEsc(s, {});     // 25 -> 23
  addAppr(s, {});                   // -> 24
  near(s.computeScore_('asha@crux.example', MK).attributeScore, 24);
});

test('appreciation cannot push the attribute component above its 25 ceiling', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  for (let i = 0; i < 10; i++) addAppr(s, {});
  near(s.computeScore_('asha@crux.example', MK).attributeScore, 25,
    0.01, 'the ceiling must hold');
});

test('appreciation cannot undo a warning', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addWarn(s, {});
  for (let i = 0; i < 10; i++) addAppr(s, {});
  near(s.computeScore_('asha@crux.example', MK).attributeScore, 0,
    0.01, 'a warning must not be washed out by appreciation');
});

test('the ledger says so explicitly rather than silently ignoring appreciation', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addWarn(s, {}); addAppr(s, {});
  const l = s.computeScore_('asha@crux.example', MK).ledger
    .filter(x => x.SourceType === 'APPRECIATION');
  assert.strictEqual(l.length, 1);
  assert.ok(/holds the attribute component at zero/.test(l[0].Reason), l[0].Reason);
});

/* ==================================================================== */
section('5. Section 22 — manager pyramid roll-up');

test('a person with no team takes the whole attribute component from their own rating', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  const r = s.computeScore_('asha@crux.example', MK);
  assert.strictEqual(r.attributeBreakdown.hasTeam, false);
  near(r.attributeBreakdown.own, 25);
  near(r.attributeBreakdown.team, 0);
});

test('a manager splits the attribute component 50/50 with their team', () => {
  const s = personFixture();
  const T = s.__tables;
  T.USERS.push({ UserID: 'U2', Name: 'Rep', Email: 'rep@crux.example', Role: 'VIEWER',
    Designation: 'Executive', Manager: 'asha@crux.example', Status: 'ACTIVE' });
  addTarget(s, { AchievedValue: '100' });                                  // Asha full target
  addTarget(s, { PersonEmail: 'rep@crux.example', AchievedValue: '100' }); // rep full target
  setRating(s, 10);                                     // Asha rated 10
  s.__tables.SCORES.push({ ScoreID: 'S2', PersonEmail: 'rep@crux.example',
    MonthKey: MK, ManagerRating: '10' });               // rep rated 10 -> rep scores 100
  const r = s.computeScore_('asha@crux.example', MK);
  assert.strictEqual(r.attributeBreakdown.hasTeam, true);
  near(r.attributeBreakdown.own, 12.5, 0.01, 'own half');
  near(r.attributeBreakdown.team, 12.5, 0.01, 'team half');
  near(r.attributeScore, 25);
});

test('a weak team drags the manager attribute score down by exactly the team half', () => {
  const s = personFixture();
  s.__tables.USERS.push({ UserID: 'U2', Email: 'rep@crux.example', Name: 'Rep',
    Designation: 'Executive', Manager: 'asha@crux.example', Status: 'ACTIVE' });
  addTarget(s, { AchievedValue: '100' });
  addTarget(s, { PersonEmail: 'rep@crux.example', AchievedValue: '0' });   // rep achieves nothing
  setRating(s, 10);
  s.__tables.SCORES.push({ ScoreID: 'S2', PersonEmail: 'rep@crux.example',
    MonthKey: MK, ManagerRating: '0' });                                   // rep scores 0
  const r = s.computeScore_('asha@crux.example', MK);
  near(r.attributeBreakdown.own, 12.5);
  near(r.attributeBreakdown.team, 0, 0.01, 'a team scoring 0 contributes 0 of its 12.5');
  near(r.attributeScore, 12.5);
});

test('the roll-up works through more than one level of hierarchy', () => {
  const s = personFixture();                       // asha (top)
  s.__tables.USERS.push(
    { UserID: 'U2', Email: 'mid@crux.example', Name: 'Mid', Designation: 'Team Leader',
      Manager: 'asha@crux.example', Status: 'ACTIVE' },
    { UserID: 'U3', Email: 'jun@crux.example', Name: 'Jun', Designation: 'Executive',
      Manager: 'mid@crux.example', Status: 'ACTIVE' });
  ['asha@crux.example', 'mid@crux.example', 'jun@crux.example'].forEach(e =>
    addTarget(s, { PersonEmail: e, AchievedValue: '100' }));
  const r = s.computeScore_('asha@crux.example', MK);
  assert.strictEqual(r.attributeBreakdown.hasTeam, true);
  assert.ok(r.attributeBreakdown.teamCount >= 1);
  assert.ok(r.finalScore > 0 && r.finalScore <= 100, 'got ' + r.finalScore);
});

test('a circular Manager chain terminates instead of recursing forever', () => {
  const s = personFixture();
  s.__tables.USERS.push({ UserID: 'U2', Email: 'loop@crux.example', Name: 'Loop',
    Designation: 'Team Leader', Manager: 'asha@crux.example', Status: 'ACTIVE' });
  // asha reports to loop AND loop reports to asha: a data error, not a shape.
  s.__tables.USERS[0].Manager = 'loop@crux.example';
  addTarget(s, { AchievedValue: '100' });
  addTarget(s, { PersonEmail: 'loop@crux.example', AchievedValue: '100' });
  const r = s.computeScore_('asha@crux.example', MK);   // must return, not hang
  assert.ok(r.finalScore >= 0);
});

/* ==================================================================== */
section('6. The deduction ledger');

test('the ledger records every step in order with before and after', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  addEsc(s, {}); addAppr(s, {});
  const l = s.computeScore_('asha@crux.example', MK).ledger;
  assert.ok(l.length >= 4, 'expected target, attribute, escalation, appreciation; got ' + l.length);
  l.forEach((row, i) => {
    assert.strictEqual(row.Sequence, i + 1, 'sequence must be contiguous');
    assert.ok('ScoreBefore' in row && 'ScoreAfter' in row && 'Component' in row);
  });
  const types = l.map(x => x.SourceType);
  assert.ok(types.indexOf('ESCALATION') !== -1 && types.indexOf('APPRECIATION') !== -1);
});

test('each ledger step is arithmetically consistent', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '100' }); setRating(s, 10);
  for (let i = 0; i < 3; i++) addEsc(s, {});
  s.computeScore_('asha@crux.example', MK).ledger.forEach(r => {
    near(r.ScoreAfter, r.ScoreBefore + r.Delta, 0.02,
      'step ' + r.Sequence + ' (' + r.SourceType + ')');
  });
});

test('every component named in the ledger is TARGET or ATTRIBUTE', () => {
  const s = personFixture();
  addTarget(s, { AchievedValue: '80' }); setRating(s, 8);
  addWarn(s, {}); addEsc(s, {});
  s.computeScore_('asha@crux.example', MK).ledger.forEach(r => {
    assert.ok(r.Component === 'TARGET' || r.Component === 'ATTRIBUTE', r.Component);
  });
});

/* ==================================================================== */
section('7. Section 9 — the three-strike engine on the REAL escalations');

test('both real escalations are open and name a resolvable person', () => {
  const s = boot();
  const open = s.readTable_('ESCALATIONS')
    .filter(e => s.ESCALATION_TERMINAL.indexOf(String(e.Status || 'OPEN')) === -1);
  assert.strictEqual(open.length, 2, 'expected the two live escalations');
  open.forEach(e => assert.ok(s.__tables.USERS.some(
    u => String(u.Email).toLowerCase() === String(e.AgainstEmail).toLowerCase()),
    e.EscalationID + ' names ' + e.AgainstEmail + ', who is not a user'));
});

test('a blank LastActivityAt falls back to CreatedAt, so the clock does start', () => {
  const s = boot();
  const hist = {};
  s.readTable_('ESCALATION_HISTORY').forEach(h => (hist[h.EscalationID] = hist[h.EscalationID] || []).push(h));
  s.readTable_('ESCALATIONS').forEach(e => {
    assert.strictEqual(String(e.LastActivityAt || '').trim(), '',
      'fixture assumption: LastActivityAt is blank in the export');
    const last = s.lastActivityAt_(e, hist);
    assert.ok(last && !isNaN(last.getTime()),
      e.EscalationID + ' has no usable timestamp, so it would be skipped forever');
  });
});

test('zero strikes on 22 Aug is CORRECT, not a disconnected engine', () => {
  const s = boot();
  // 2026-08-22 is a Saturday. ESC-00022 was raised Wed 19 Aug 06:38.
  // Working hours are 10:00-17:00 Mon-Fri => 7 per day. Wed+Thu+Fri = 21.
  // STRIKE_WINDOW_HOURS is 24, so floor(21/24) = 0: strike 1 is not yet due.
  const out = s.runStrikeSweep_('test', { dryRun: true, ignoreWindow: true,
    now: new Date('2026-08-22T12:00:00+05:30') });
  assert.strictEqual(out.struck.length, 0,
    'expected no strike due yet, got ' + JSON.stringify(out.struck));
  assert.strictEqual(out.checked, 2);
  out.skipped.forEach(sk => assert.ok(/only \d+h idle/.test(sk.why),
    sk.id + ' skipped for the wrong reason: ' + sk.why));
});

test('the working-hour clock counts only 10-17 on weekdays', () => {
  const s = boot();
  const from = new Date('2026-08-19T06:38:58+05:30');            // Wed, before the window
  const h = (t) => s.workingHoursBetween_(from, new Date(t + ':00+05:30'));
  near(h('2026-08-19T17:00'), 7,  0.01, 'Wed: only the 10-17 window counts');
  near(h('2026-08-21T17:00'), 21, 0.01, 'Wed+Thu+Fri = three full days');
  near(h('2026-08-24T12:00'), 23, 0.01, 'the weekend adds nothing');
});

test('the clock runs from the LAST human activity, not from creation', () => {
  const s = boot();
  const hist = {};
  s.readTable_('ESCALATION_HISTORY').forEach(h =>
    (hist[h.EscalationID] = hist[h.EscalationID] || []).push(h));
  const e = s.readTable_('ESCALATIONS').filter(x => x.EscalationID === 'ESC-00022')[0];
  // ESC-00022 was raised Wed 19 Aug 06:38 but worked on until Thu 20 Aug 10:23
  // (a warning was raised against it, then acknowledged). Those are real human
  // actions, so the strike clock correctly restarts from the later one.
  const last = s.lastActivityAt_(e, hist);
  assert.strictEqual(last.toISOString(), new Date('2026-08-20T10:23:44+05:30').toISOString(),
    'expected the clock to start at the last human action on the escalation');
});

test('strike 1 falls due 24 working hours after the last activity', () => {
  const s = boot();
  const at = (iso) => s.runStrikeSweep_('test',
    { dryRun: true, ignoreWindow: true, now: new Date(iso) }).struck;
  // Last activity Thu 20 Aug 10:23. Thu 6.6h + Fri 7h + Mon 7h = 20.6h by Mon
  // 17:00; the 24th hour lands on Tue 25 Aug.
  assert.strictEqual(at('2026-08-24T13:00:00+05:30')
    .filter(x => x.id === 'ESC-00022').length, 0, 'not yet due on Monday');
  const due = at('2026-08-25T14:00:00+05:30').filter(x => x.id === 'ESC-00022');
  assert.strictEqual(due.length, 1, 'expected strike 1 by Tuesday afternoon');
  assert.strictEqual(due[0].level, 1);
});

test('the clock escalates 1 -> 2 -> 3 and stops at 3', () => {
  const s = boot();
  const at = (iso) => s.runStrikeSweep_('test',
    { dryRun: true, ignoreWindow: true, now: new Date(iso) }).struck;
  const lvl = (rows, id) => (rows.filter(r => r.id === id)[0] || {}).level || 0;
  // Thresholds measured from the real record: last activity Thu 20 Aug 10:23,
  // 7 working hours a day, 24 per strike.
  assert.strictEqual(lvl(at('2026-08-25T16:00:00+05:30'), 'ESC-00022'), 1);   // 26.6h
  assert.strictEqual(lvl(at('2026-08-29T16:00:00+05:30'), 'ESC-00022'), 2);   // 48.6h
  assert.strictEqual(lvl(at('2026-09-03T16:00:00+05:30'), 'ESC-00022'), 3);   // 75.6h
  assert.strictEqual(lvl(at('2026-09-30T16:00:00+05:30'), 'ESC-00022'), 3,
    'the ladder must cap at 3, not keep climbing');
});

test('a working day is 7 hours, so the ladder lands on policy', () => {
  const s = boot();
  // Before the timezone fix a UTC-aligned bucket walk measured 6.5 hours per
  // day, so 24 "working hours" took 3.7 days instead of 3.4 and every strike
  // arrived late. Assert the day length directly.
  near(s.workingHoursBetween_(new Date('2026-08-19T00:00:00+05:30'),
                              new Date('2026-08-20T00:00:00+05:30')), 7, 0.01);
});

test('weekends never advance the strike clock', () => {
  const s = boot();
  const fri = s.workingHoursBetween_(new Date('2026-08-21T10:00:00+05:30'),
                                     new Date('2026-08-21T17:00:00+05:30'));
  const wknd = s.workingHoursBetween_(new Date('2026-08-22T00:00:00+05:30'),
                                      new Date('2026-08-24T00:00:00+05:30'));
  near(fri, 7, 0.2, 'a full Friday is 7 working hours');
  near(wknd, 0, 0.2, 'Saturday and Sunday contribute nothing');
});

test('the sweep does nothing outside working hours', () => {
  const s = boot();
  const out = s.runStrikeSweep_('test', { now: new Date('2026-08-24T22:00:00+05:30') });
  assert.strictEqual(out.skipped, 'outside working hours');
});

test('the sweep is off when STRIKE_ENABLED is off', () => {
  const s = boot();
  s.setSetting_('STRIKE_ENABLED', 'false', 'test');
  assert.strictEqual(s.runStrikeSweep_('test', { ignoreWindow: true }).skipped, 'disabled');
});

test('STRIKE_ENABLED reads True/Yes/1, not only lowercase true', () => {
  const s = boot();
  ['True', 'TRUE', 'yes', 'Y', '1', 'on'].forEach(v => {
    s.setSetting_('STRIKE_ENABLED', v, 'test');
    assert.strictEqual(s.getBoolSetting_('STRIKE_ENABLED', 'false'), true, 'value ' + v);
  });
  assert.strictEqual(String(s.getSetting_('STRIKE_ENABLED', '')), 'on');
});

test('an escalation with no resolvable person is skipped, not silently struck', () => {
  const s = boot();
  s.__tables.ESCALATIONS.forEach(e => { e.AgainstEmail = ''; });
  const out = s.runStrikeSweep_('test', { dryRun: true, ignoreWindow: true,
    now: new Date('2026-08-27T12:00:00+05:30') });
  assert.strictEqual(out.struck.length, 0);
  assert.strictEqual(out.skipped.length, 2);
  out.skipped.forEach(sk => assert.ok(/no resolved email/.test(sk.why), sk.why));
});

test('a resolved escalation is not chased', () => {
  const s = boot();
  s.__tables.ESCALATIONS.forEach(e => { e.Status = 'RESOLVED'; });
  const out = s.runStrikeSweep_('test', { dryRun: true, ignoreWindow: true,
    now: new Date('2026-09-30T12:00:00+05:30') });
  assert.strictEqual(out.checked, 0);
  assert.strictEqual(out.struck.length, 0);
});

test('a genuine human reply resets the clock; the strike email does not', () => {
  const s = boot();
  const e = s.__tables.ESCALATIONS[0];
  const hist = {};
  // The engine's own strike record must not read as activity, or strike 2 could
  // never follow strike 1.
  hist[e.EscalationID] = [
    { EscalationID: e.EscalationID, Timestamp: '2026-08-26T11:00:00+05:30',
      User: 'system:strike', Field: 'Strike', NewValue: 'STRIKE_1',
      Note: 'Automatic strike 1 after 24 working hours with no update.' },
  ];
  const afterOwnStrike = s.lastActivityAt_(e, hist);
  assert.strictEqual(afterOwnStrike.toISOString(), new Date(e.CreatedAt).toISOString(),
    'the strike must not reset its own clock');

  hist[e.EscalationID].push({ EscalationID: e.EscalationID,
    Timestamp: '2026-08-26T12:00:00+05:30', User: 'nitish.bhope@cruxindia.co.in',
    Field: 'Status', OldValue: 'OPEN', NewValue: 'IN_PROGRESS', Note: 'Looking into it' });
  const afterReply = s.lastActivityAt_(e, hist);
  assert.ok(afterReply.getTime() > new Date(e.CreatedAt).getTime(),
    'a human reply must reset the clock');
});

/* ==================================================================== */
section('8. Real-data score run');

test('every active user scores without throwing, and inside 0-100', () => {
  const s = boot();
  const users = s.readTable_('USERS').filter(u => u.Status === 'ACTIVE' && u.Email);
  assert.ok(users.length > 20, 'expected the real roster, got ' + users.length);
  users.forEach(u => {
    const r = s.computeScore_(u.Email, MK, { depth: 0, seen: {}, noWrite: true });
    assert.ok(r.finalScore >= 0 && r.finalScore <= 100,
      u.Email + ' scored ' + r.finalScore);
    assert.ok(r.ledger.length >= 2, u.Email + ' produced no ledger');
  });
  console.log('         (' + users.length + ' real users scored)');
});

test('the two real escalations do reach the person score', () => {
  const s = boot();
  const r = s.computeScore_(ADMIN, MK, { depth: 0, seen: {}, noWrite: true });
  assert.strictEqual(r.escalations, 2,
    'both live escalations are against this person and must count');
  const hits = r.ledger.filter(x => x.SourceType === 'ESCALATION');
  assert.strictEqual(hits.length, 2);
  hits.forEach(h => assert.strictEqual(h.Component, 'ATTRIBUTE'));
});

/* ==================================================================== */
console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
