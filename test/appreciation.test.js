/**
 * appreciation.test.js — weekly appreciation monitoring (section 25) and the
 * record-backed AI draft context (section 26).
 *
 * Neither existed before: nothing ever prompted a manager to recognise anybody,
 * and "AI-assisted" drafting saw a single line of client-supplied text rather
 * than the person's actual record.
 *
 * Run: node test/appreciation.test.js
 */
const assert = require('assert');
const { createSandbox } = require('./gas-harness');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32mPASS\x1b[0m ' + name); pass++; }
  catch (e) { console.log('  \x1b[31mFAIL\x1b[0m ' + name + '\n         ' + e.message); fail++; }
}
function section(t) { console.log('\n' + t); }

const FILES = ['Utils.gs', 'Session.gs', 'Auth.gs', 'Clients.gs', 'Escalation.gs',
               'Scheduler.gs', 'Gemini.gs'];
const MGR = 'mgr@crux.example';
const REP = 'rep@crux.example';
const REP2 = 'rep2@crux.example';
const MK = '2026-08';
/** Monday 24 Aug 2026, 11:00 IST — the nudge slot. */
const MONDAY = new Date('2026-08-24T11:00:00+05:30');

function boot() {
  const s = createSandbox({ activeUser: MGR, files: FILES });
  s.__outbox = [];
  s.sendEmail_ = (o) => {
    const key = String(o.idempotencyKey || '');
    if (key && s.__outbox.some(x => x.idempotencyKey === key)) {
      return { skipped: true, reason: 'already sent' };
    }
    s.__outbox.push(o);
    return { status: 'SENT', logId: 'L' + s.__outbox.length };
  };
  s.geminiCall_ = () => '<p>A generated, motivational paragraph about recognising your team.</p>';
  s.escHtml_ = (x) => String(x == null ? '' : x);
  const T = s.__tables;
  T.USERS.length = 0; T.PEOPLE_EVENTS.length = 0; T.TARGETS.length = 0;
  T.SCORES.length = 0; T.WARNINGS.length = 0; T.ESCALATIONS.length = 0;
  T.KPI_DEFS.length = 0; T.REMINDER_LOG.length = 0;
  T.USERS.push(
    { UserID: 'U1', Name: 'Mgr', Email: MGR, Role: 'MANAGER', Designation: 'Zonal Manager',
      Department: 'Operations', AdminAccess: 'YES', Manager: '', Status: 'ACTIVE' },
    { UserID: 'U2', Name: 'Rep One', Email: REP, Role: 'VIEWER', Designation: 'Executive',
      Department: 'Operations', Manager: MGR, Status: 'ACTIVE' },
    { UserID: 'U3', Name: 'Rep Two', Email: REP2, Role: 'VIEWER', Designation: 'Executive',
      Department: 'Operations', Manager: MGR, Status: 'ACTIVE' });
  return s;
}
const me = (s) => s.whoAmI_('', {});
const appreciate = (s, by, about, when) => s.__tables.PEOPLE_EVENTS.push({
  EventID: 'EV' + (s.__tables.PEOPLE_EVENTS.length + 1), PersonEmail: about,
  Type: 'APPRECIATION', Timestamp: (when || MK + '-10') + 'T10:00:00+05:30',
  Notes: 'Well done', IssuedBy: by, Status: 'CLOSED' });

/* ==================================================================== */
section('1. Who gets nudged');

test('a manager who has recognised nobody this month is a candidate', () => {
  const s = boot();
  const owed = s.managersOwedAppreciationNudge_(MONDAY);
  assert.strictEqual(owed.length, 1);
  assert.strictEqual(owed[0].email, MGR);
  assert.strictEqual(owed[0].teamSize, 2);
});

test('a manager who HAS appreciated somebody is left alone', () => {
  const s = boot();
  appreciate(s, MGR, REP);
  assert.strictEqual(s.managersOwedAppreciationNudge_(MONDAY).length, 0,
    'the nudge must stop once the behaviour is happening');
});

test('one appreciation is enough to stop the nudge, not one per report', () => {
  const s = boot();
  appreciate(s, MGR, REP);          // only one of two reports
  assert.strictEqual(s.managersOwedAppreciationNudge_(MONDAY).length, 0);
});

test('an appreciation in a PREVIOUS month does not count', () => {
  const s = boot();
  appreciate(s, MGR, REP, '2026-07-10');
  assert.strictEqual(s.managersOwedAppreciationNudge_(MONDAY).length, 1,
    'recognition is monitored per month');
});

test('somebody with no direct reports is never nudged', () => {
  const s = boot();
  s.__tables.USERS = s.__tables.USERS.filter(u => u.Email !== REP && u.Email !== REP2);
  assert.strictEqual(s.managersOwedAppreciationNudge_(MONDAY).length, 0);
});

test('an appreciation issued by somebody else does not excuse this manager', () => {
  const s = boot();
  appreciate(s, 'someone.else@crux.example', REP);
  assert.strictEqual(s.managersOwedAppreciationNudge_(MONDAY).length, 1);
});

test('a manager whose only reports are inactive is not nudged', () => {
  const s = boot();
  s.__tables.USERS.forEach(u => { if (u.Email !== MGR) u.Status = 'EXITED'; });
  assert.strictEqual(s.managersOwedAppreciationNudge_(MONDAY).length, 0);
});

/* ==================================================================== */
section('2. Sending, once per week');

test('the sweep sends to each candidate', () => {
  const s = boot();
  const out = s.runAppreciationNudge_('test', { now: MONDAY });
  assert.strictEqual(out.sent.length, 1);
  assert.strictEqual(s.__outbox.length, 1);
  assert.strictEqual(s.__outbox[0].to[0], MGR);
});

test('running twice in the same week sends once', () => {
  const s = boot();
  s.runAppreciationNudge_('test', { now: MONDAY });
  const again = s.runAppreciationNudge_('test', { now: MONDAY });
  assert.strictEqual(s.__outbox.length, 1, 'the idempotency key must hold');
  assert.strictEqual(again.skipped.length, 1);
});

test('a later week sends again', () => {
  const s = boot();
  s.runAppreciationNudge_('test', { now: MONDAY });
  s.runAppreciationNudge_('test', { now: new Date('2026-08-31T11:00:00+05:30') });
  assert.strictEqual(s.__outbox.length, 2);
});

test('the week key changes across weeks and is stable within one', () => {
  const s = boot();
  const a = s.isoWeekKey_(new Date('2026-08-24T11:00:00+05:30'));   // Monday
  const b = s.isoWeekKey_(new Date('2026-08-28T18:00:00+05:30'));   // Friday, same week
  const c = s.isoWeekKey_(new Date('2026-08-31T11:00:00+05:30'));   // next Monday
  assert.strictEqual(a, b, 'same ISO week must give the same key');
  assert.notStrictEqual(a, c, 'a new week must give a new key');
  assert.ok(/^\d{4}-W\d{2}$/.test(a), 'unexpected shape: ' + a);
});

test('a dry run computes everything and sends nothing', () => {
  const s = boot();
  const out = s.runAppreciationNudge_('test', { now: MONDAY, dryRun: true });
  assert.strictEqual(out.sent.length, 1);
  assert.strictEqual(s.__outbox.length, 0);
});

test('the master switch turns it off', () => {
  const s = boot();
  s.setSetting_('APPRECIATION_NUDGE_ENABLED', 'false', 't');
  assert.strictEqual(s.runAppreciationNudge_('test', { now: MONDAY }).skipped, 'disabled');
  assert.strictEqual(s.__outbox.length, 0);
});

test('the run is recorded so the scheduler will not repeat it', () => {
  const s = boot();
  s.runAppreciationNudge_('test', { now: MONDAY });
  assert.ok(s.jobDone_(s.isoWeekKey_(MONDAY), 'APPRECIATION_NUDGE'));
});

/* ==================================================================== */
section('3. The message itself');

test('the nudge is motivational and names no employee', () => {
  const s = boot();
  s.runAppreciationNudge_('test', { now: MONDAY });
  const html = s.__outbox[0].htmlBody;
  assert.ok(html.indexOf('Mgr') !== -1, 'it should address the manager');
  ['Rep One', 'Rep Two', REP, REP2].forEach(n => assert.strictEqual(html.indexOf(n), -1,
    'must not single anybody out: found ' + n));
  assert.ok(!/fail|neglect|must explain|why have you/i.test(html),
    'tone must not be accusatory');
});

test('it still sends a usable message when the AI is unavailable', () => {
  const s = boot();
  s.geminiCall_ = () => { throw new Error('AI down'); };
  s.runAppreciationNudge_('test', { now: MONDAY });
  assert.strictEqual(s.__outbox.length, 1);
  const html = s.__outbox[0].htmlBody;
  assert.ok(/appreciate someone on your team/i.test(html), 'the fallback must carry the ask');
  assert.ok(/Carnegie/.test(html), 'the fallback includes a quote');
});

test('an empty AI response falls back rather than sending a blank email', () => {
  const s = boot();
  s.geminiCall_ = () => '   ';
  s.runAppreciationNudge_('test', { now: MONDAY });
  assert.ok(/appreciate someone on your team/i.test(s.__outbox[0].htmlBody));
});

/* ==================================================================== */
section('4. Section 26 — AI drafts from the real record');

test('the context carries the review period and the role', () => {
  const s = boot();
  const ctx = s.personContextForAi_(REP, me(s));
  assert.ok(/PERSON: Rep One/.test(ctx), ctx);
  assert.ok(/ROLE: Executive/.test(ctx));
  assert.ok(/REVIEW PERIOD:/.test(ctx));
  assert.ok(/REPORTS TO: /.test(ctx));
});

test('missed targets appear with the actual figures', () => {
  const s = boot();
  s.__tables.KPI_DEFS.push({ KpiID: 'K1', PersonEmail: REP, Category: 'Revenue',
    Position: 1, Active: 'YES' });
  s.__tables.TARGETS.push({ TargetID: 'T1', PersonEmail: REP, MonthKey: MK,
    Category: 'Revenue', TargetValue: '100', AchievedValue: '40' });
  const ctx = s.personContextForAi_(REP, me(s));
  assert.ok(/TARGETS 2026-08: Revenue 40\/100 \(40%\)/.test(ctx), ctx);
});

test('recurring escalations appear, with status', () => {
  const s = boot();
  s.__tables.ESCALATIONS.push(
    { EscalationID: 'E1', AgainstEmail: REP, Category: 'Billing', Severity: 'High',
      Status: 'OPEN', CreatedAt: MK + '-05T10:00:00+05:30', Description: 'Invoice not raised' },
    { EscalationID: 'E2', AgainstEmail: REP, Category: 'Ops', Severity: 'Medium',
      Status: 'OPEN', CreatedAt: MK + '-12T10:00:00+05:30', Description: 'Roster not filed' });
  const ctx = s.personContextForAi_(REP, me(s));
  assert.ok(/ESCALATIONS AGAINST THEM: 2/.test(ctx), ctx);
  assert.ok(/Invoice not raised/.test(ctx));
  assert.ok(/Roster not filed/.test(ctx));
});

test('warnings and prior PIPs appear', () => {
  const s = boot();
  s.__tables.WARNINGS.push({ WarningID: 'W1', PersonEmail: REP, Category: 'PROCESS',
    IssuedAt: MK + '-08T10:00:00+05:30', Status: 'ISSUED', Summary: 'Process not followed' });
  s.__tables.PEOPLE_EVENTS.push({ EventID: 'EV9', PersonEmail: REP, Type: 'PIP',
    StartDate: '2026-08-01', EndDate: '2026-08-31', Status: 'OPEN',
    Timestamp: MK + '-01T10:00:00+05:30', IssuedBy: MGR });
  const ctx = s.personContextForAi_(REP, me(s));
  assert.ok(/WARNINGS: 1/.test(ctx), ctx);
  assert.ok(/Process not followed/.test(ctx));
  assert.ok(/PRIOR PIP: 2026-08-01 to 2026-08-31/.test(ctx));
});

test('an absence of findings is stated, not left blank', () => {
  const s = boot();
  const ctx = s.personContextForAi_(REP, me(s));
  assert.ok(/ESCALATIONS AGAINST THEM: none/.test(ctx));
  assert.ok(/WARNINGS: none/.test(ctx));
  assert.ok(/TARGETS: none recorded/.test(ctx),
    'the model must be told there is nothing rather than inferring');
});

test('drafting about somebody outside your reach is refused', () => {
  const s = boot();
  s.__tables.USERS.push({ UserID: 'U9', Name: 'Stranger',
    Email: 'stranger@crux.example', Designation: 'Executive',
    Manager: 'other.mgr@crux.example', Status: 'ACTIVE' });
  s.__tables.USERS[0].AdminAccess = '';           // drop admin: reach decides
  s.__tables.USERS[0].Role = 'MANAGER';
  s._ME_CACHE = null;
  assert.throws(() => s.personContextForAi_('stranger@crux.example', s.whoAmI_('', {})),
    /cannot draft about that person/);
});

test('a person can always draft about themselves', () => {
  const s = boot();
  s.__tables.USERS[0].AdminAccess = ''; s.__tables.USERS[0].Role = 'VIEWER';
  s._ME_CACHE = null;
  const ctx = s.personContextForAi_(MGR, s.whoAmI_('', {}));
  assert.ok(/PERSON: Mgr/.test(ctx));
});

test('the draft prompt presents the record as the only source of facts', () => {
  const s = boot();
  let seen = null;
  s.geminiCall_ = (o) => { seen = o; return 'drafted text'; };
  const out = s.aiDraftNote_({ kind: 'pip', text: 'needs to improve on revenue',
    Email: REP, context: 'hint' }, me(s));
  assert.strictEqual(out.usedRecord, true);
  assert.ok(/THE RECORD/.test(seen.prompt), seen.prompt.slice(0, 200));
  assert.ok(/do not add/i.test(seen.prompt));
  assert.ok(/INVENT NONE/.test(seen.system));
  assert.ok(/PERSON: Rep One/.test(seen.prompt), 'the real record must be in the prompt');
});

test('drafting still works with no subject, just without a record', () => {
  const s = boot();
  let seen = null;
  s.geminiCall_ = (o) => { seen = o; return 'drafted'; };
  const out = s.aiDraftNote_({ kind: 'note', text: 'some rough words' }, me(s));
  assert.strictEqual(out.usedRecord, false);
  assert.ok(!/THE RECORD/.test(seen.prompt));
});

test('an authorisation refusal is surfaced, not swallowed into a blank record', () => {
  const s = boot();
  s.__tables.USERS.push({ UserID: 'U9', Email: 'stranger@crux.example', Name: 'S',
    Designation: 'Executive', Manager: 'x@crux.example', Status: 'ACTIVE' });
  s.__tables.USERS[0].AdminAccess = ''; s.__tables.USERS[0].Role = 'MANAGER';
  s._ME_CACHE = null;
  s.geminiCall_ = () => 'drafted';
  assert.throws(() => s.aiDraftNote_({ kind: 'pip', text: 'rough words',
    Email: 'stranger@crux.example' }, s.whoAmI_('', {})), /cannot draft about that person/);
});

test('a PIP draft is given more room than a short note', () => {
  const s = boot();
  const caps = {};
  s.geminiCall_ = (o) => { caps[o.maxTokens] = true; return 'x'; };
  s.aiDraftNote_({ kind: 'pip', text: 'rough words', Email: REP }, me(s));
  s.aiDraftNote_({ kind: 'appreciation', text: 'rough words', Email: REP }, me(s));
  assert.ok(Object.keys(caps).length === 2, 'PIP and appreciation must not share a cap');
});


/* Appended: peopleHistory_ (section 24). Kept in this file because it is the
   read side of the same appreciation loop. */
section('5. Section 24 — appreciation history');

test('history lists appreciations, warnings and PIPs newest first', () => {
  const s = boot();
  appreciate(s, MGR, REP, '2026-08-05');
  appreciate(s, MGR, REP, '2026-08-20');
  s.__tables.WARNINGS.push({ WarningID: 'W1', PersonEmail: REP, Category: 'PROCESS',
    IssuedAt: '2026-08-12T10:00:00+05:30', Status: 'ISSUED', Summary: 'Process missed',
    IssuedBy: MGR });
  const h = s.peopleHistory_({ Email: REP }, me(s));
  assert.strictEqual(h.total, 3);
  const dates = h.items.map(x => String(x.at).slice(0, 10));
  assert.deepStrictEqual(Array.prototype.slice.call(dates),
    ['2026-08-20', '2026-08-12', '2026-08-05'], 'newest first');
  assert.strictEqual(h.items[1].kind, 'WARNING');
});

test('the counts separate this month from all time', () => {
  const s = boot();
  appreciate(s, MGR, REP, '2026-07-05');     // previous month
  appreciate(s, MGR, REP, '2026-08-20');     // this month
  const h = s.peopleHistory_({ Email: REP }, me(s));
  assert.strictEqual(h.counts.appreciationsTotal, 2);
  assert.strictEqual(h.counts.appreciationsThisMonth, 1);
});

test('an open PIP is counted', () => {
  const s = boot();
  s.__tables.PEOPLE_EVENTS.push({ EventID: 'EV1', PersonEmail: REP, Type: 'PIP',
    StartDate: '2026-08-01', EndDate: '2026-08-31', Status: 'OPEN',
    Timestamp: '2026-08-01T10:00:00+05:30', IssuedBy: MGR });
  assert.strictEqual(s.peopleHistory_({ Email: REP }, me(s)).counts.openPip, 1);
});

test('an empty history is an empty list, not an error', () => {
  const s = boot();
  const h = s.peopleHistory_({ Email: REP }, me(s));
  assert.strictEqual(h.total, 0);
  assert.strictEqual(h.items.length, 0);
});

test('history for somebody outside your reach is refused', () => {
  const s = boot();
  s.__tables.USERS.push({ UserID: 'U9', Email: 'stranger@crux.example', Name: 'S',
    Designation: 'Executive', Manager: 'x@crux.example', Status: 'ACTIVE' });
  s.__tables.USERS[0].AdminAccess = ''; s.__tables.USERS[0].Role = 'MANAGER';
  s._ME_CACHE = null;
  assert.throws(() => s.peopleHistory_({ Email: 'stranger@crux.example' }, s.whoAmI_('', {})),
    /cannot view that record/);
});

test('everyone can read their own history', () => {
  const s = boot();
  s.__tables.USERS[0].AdminAccess = ''; s.__tables.USERS[0].Role = 'VIEWER';
  s._ME_CACHE = null;
  appreciate(s, 'boss@crux.example', MGR, '2026-08-09');
  const h = s.peopleHistory_({}, s.whoAmI_('', {}));
  assert.strictEqual(h.Email, MGR);
  assert.strictEqual(h.total, 1);
});

test('the limit is capped so a long history cannot blow the response', () => {
  const s = boot();
  for (let i = 1; i <= 250; i++) appreciate(s, MGR, REP, '2026-08-' + String((i % 28) + 1).padStart(2, '0'));
  const h = s.peopleHistory_({ Email: REP, limit: 9999 }, me(s));
  assert.strictEqual(h.total, 250);
  assert.ok(h.items.length <= 200, 'got ' + h.items.length);
});

console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
