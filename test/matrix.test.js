/**
 * matrix.test.js — escalation-matrix isolation and email routing.
 *
 * Exercises the three-tier resolver and the new matrix-aware recipient
 * resolution against the real exported data (28 clients, 812 branches, 470
 * matrix rows), then against synthetic two-location clients where the isolation
 * requirement in section 5 can be asserted exactly.
 *
 * Run: node test/matrix.test.js
 */
const assert = require('assert');
const { createSandbox } = require('./gas-harness');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32mPASS\x1b[0m ' + name); pass++; }
  catch (e) { console.log('  \x1b[31mFAIL\x1b[0m ' + name + '\n         ' + e.message); fail++; }
}
function section(t) { console.log('\n' + t); }

const FILES = ['Utils.gs', 'Session.gs', 'Auth.gs', 'Clients.gs', 'Scheduler.gs'];
const ADMIN = 'shantanu.suravase@cruxindia.co.in';

function boot(opts = {}) {
  return createSandbox(Object.assign({ activeUser: ADMIN, files: FILES }, opts));
}

/** A clean two-location client: Mumbai and Pune, one branch each. */
function twoLocationFixture() {
  const s = boot();
  const T = s.__tables;
  T.CLIENTS.length = 0; T.BRANCHES.length = 0; T.ESCALATION_MATRIX.length = 0;
  T.CLIENTS.push({ ClientID: 'C1', ClientName: 'Acme Bank', ClientCode: 'ACME',
    ClientEmail: 'ops@acme.example', ClientCC: '', HeadOfficeEmail: '', HeadOfficeCC: '',
    DefaultLocationHead: '', Status: 'ACTIVE' });
  T.BRANCHES.push(
    { BranchID: 'B-MUM', ClientID: 'C1', BranchName: 'Andheri', BranchCode: 'ACME-MUM',
      Location: 'Mumbai', Status: 'ACTIVE', BranchManagerEmail: 'bm.mum@acme.example',
      CruxPOCEmail: 'poc.mum@crux.example' },
    { BranchID: 'B-PUN', ClientID: 'C1', BranchName: 'Aundh', BranchCode: 'ACME-PUN',
      Location: 'Pune', Status: 'ACTIVE', BranchManagerEmail: 'bm.pun@acme.example',
      CruxPOCEmail: 'poc.pun@crux.example' });
  return s;
}
const addMatrix = (s, row) => s.__tables.ESCALATION_MATRIX.push(Object.assign(
  { MatrixID: 'M' + (s.__tables.ESCALATION_MATRIX.length + 1), ClientID: 'C1',
    BranchID: '', Location: '', Level: 1, LevelName: 'SPOC',
    ContactName: '', Mobile: '', Email: '' }, row));
const at = (rows, lvl) => rows.filter(r => Number(r.Level) === lvl)[0];
/* Values come back from the vm realm, whose Array is not this realm's Array, so
   deepStrictEqual rejects them on prototype identity. Copy into a host array. */
const arr = (x) => Array.prototype.slice.call(x || []);

/* ==================================================================== */
section('1. Section 5 — one client, two locations, isolated defaults');

test('each location resolves its OWN default, not the other', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Mumbai', Level: 1, ContactName: 'Mum SPOC', Email: 'spoc.mum@acme.example' });
  addMatrix(s, { Location: 'Pune',   Level: 1, ContactName: 'Pun SPOC', Email: 'spoc.pun@acme.example' });
  const mum = s.resolveMatrixRows_('C1', 'B-MUM', 'Mumbai');
  const pun = s.resolveMatrixRows_('C1', 'B-PUN', 'Pune');
  assert.strictEqual(at(mum, 1).Email, 'spoc.mum@acme.example');
  assert.strictEqual(at(pun, 1).Email, 'spoc.pun@acme.example');
});

test('editing the Pune default cannot change what Mumbai resolves to', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Mumbai', Level: 1, ContactName: 'Mum SPOC', Email: 'spoc.mum@acme.example' });
  addMatrix(s, { Location: 'Pune',   Level: 1, ContactName: 'Pun SPOC', Email: 'spoc.pun@acme.example' });
  const me = s.whoAmI_('', {});
  s.saveMatrix_({ clientId: 'C1', location: 'Pune', rows: [
    { Level: 1, LevelName: 'SPOC', ContactName: 'Pune NEW', Email: 'new.pun@acme.example' }] }, me);
  assert.strictEqual(at(s.resolveMatrixRows_('C1', 'B-PUN', 'Pune'), 1).Email, 'new.pun@acme.example');
  assert.strictEqual(at(s.resolveMatrixRows_('C1', 'B-MUM', 'Mumbai'), 1).Email, 'spoc.mum@acme.example',
    'Mumbai must be untouched by a Pune edit');
});

test('a location with no default of its own falls back to the client-wide one', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Level: 1, ContactName: 'Client SPOC', Email: 'spoc@acme.example' });   // client-wide
  addMatrix(s, { Location: 'Pune', Level: 1, ContactName: 'Pun SPOC', Email: 'spoc.pun@acme.example' });
  assert.strictEqual(at(s.resolveMatrixRows_('C1', 'B-MUM', 'Mumbai'), 1).Email, 'spoc@acme.example');
  assert.strictEqual(at(s.resolveMatrixRows_('C1', 'B-MUM', 'Mumbai'), 1)._source, 'CLIENT');
  assert.strictEqual(at(s.resolveMatrixRows_('C1', 'B-PUN', 'Pune'), 1)._source, 'LOCATION');
});

test('a branch override beats its location default', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Pune', Level: 3, LevelName: 'Branch Manager',
    ContactName: 'Pune BM', Email: 'bm.pune@acme.example' });
  addMatrix(s, { BranchID: 'B-PUN', Level: 3, LevelName: 'Branch Manager',
    ContactName: 'Aundh BM', Email: 'bm.aundh@acme.example' });
  const r = s.resolveMatrixRows_('C1', 'B-PUN', 'Pune');
  assert.strictEqual(at(r, 3).Email, 'bm.aundh@acme.example');
  assert.strictEqual(at(r, 3)._source, 'BRANCH');
});

test('resolution is per level: a branch overriding L3 still inherits L1', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Pune', Level: 1, ContactName: 'Pune SPOC', Email: 'spoc.pune@acme.example' });
  addMatrix(s, { BranchID: 'B-PUN', Level: 3, LevelName: 'Branch Manager',
    ContactName: 'Aundh BM', Email: 'bm.aundh@acme.example' });
  const r = s.resolveMatrixRows_('C1', 'B-PUN', 'Pune');
  assert.strictEqual(at(r, 1)._source, 'LOCATION');
  assert.strictEqual(at(r, 3)._source, 'BRANCH');
});

test('an empty branch row inherits rather than resolving to nobody', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Pune', Level: 1, ContactName: 'Pune SPOC', Email: 'spoc.pune@acme.example' });
  addMatrix(s, { BranchID: 'B-PUN', Level: 1, ContactName: '', Email: '' });  // saved blank
  const r = s.resolveMatrixRows_('C1', 'B-PUN', 'Pune');
  assert.strictEqual(at(r, 1).Email, 'spoc.pune@acme.example',
    'a blank branch row must not blank out the inherited contact');
});

test('a branch of another client is never reachable', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Pune', Level: 1, ContactName: 'Pune SPOC', Email: 'spoc.pune@acme.example' });
  const r = s.resolveMatrixRows_('C2', 'B-PUN', 'Pune');   // different client id
  assert.strictEqual(at(r, 1).Email, '', 'matrix rows must not cross client boundaries');
});

test('saving a branch matrix rejects a branch belonging to another client', () => {
  const s = twoLocationFixture();
  s.__tables.CLIENTS.push({ ClientID: 'C2', ClientName: 'Other', Status: 'ACTIVE' });
  const me = s.whoAmI_('', {});
  assert.throws(() => s.saveMatrix_({ clientId: 'C2', branchId: 'B-PUN',
    rows: [{ Level: 1, LevelName: 'SPOC', ContactName: 'x', Email: 'x@y.example' }] }, me),
    /does not belong to this client/);
});

/* ==================================================================== */
section('2. Section 6 — head office and matrix-based routing');

test('head office resolves from matrix level 5 for that location', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Pune', Level: 5, LevelName: 'Head Office',
    ContactName: 'HO Pune', Email: 'ho.pune@acme.example' });
  const ho = s.headOfficeRecipients_(s.__tables.CLIENTS[0], 'B-PUN', 'Pune');
  assert.deepStrictEqual(arr(ho.to), ['ho.pune@acme.example']);
  assert.ok(ho.source.indexOf('MATRIX_L5') === 0, 'expected the matrix to win, got ' + ho.source);
});

test('head office falls back to the client HeadOfficeEmail', () => {
  const s = twoLocationFixture();
  s.__tables.CLIENTS[0].HeadOfficeEmail = 'ho@acme.example';
  const ho = s.headOfficeRecipients_(s.__tables.CLIENTS[0], 'B-PUN', 'Pune');
  assert.deepStrictEqual(arr(ho.to), ['ho@acme.example']);
  assert.strictEqual(ho.source, 'CLIENT_HEAD_OFFICE');
});

test('head office falls back to the HEAD_OFFICE_EMAIL setting', () => {
  const s = twoLocationFixture();
  s.setSetting_('HEAD_OFFICE_EMAIL', 'ho.crux@cruxindia.co.in', 'test');
  const ho = s.headOfficeRecipients_(s.__tables.CLIENTS[0], 'B-PUN', 'Pune');
  assert.deepStrictEqual(arr(ho.to), ['ho.crux@cruxindia.co.in']);
  assert.strictEqual(ho.source, 'SETTING_HEAD_OFFICE_EMAIL');
});

test('head office CC combines the client and the global setting, de-duplicated', () => {
  const s = twoLocationFixture();
  s.__tables.CLIENTS[0].HeadOfficeEmail = 'ho@acme.example';
  s.__tables.CLIENTS[0].HeadOfficeCC = 'a@x.example, b@x.example';
  s.setSetting_('HEAD_OFFICE_CC', 'B@X.example, c@x.example', 'test');
  const ho = s.headOfficeRecipients_(s.__tables.CLIENTS[0], 'B-PUN', 'Pune');
  assert.deepStrictEqual(arr(ho.to), ['ho@acme.example']);
  assert.deepStrictEqual(arr(ho.cc), ['a@x.example', 'b@x.example', 'c@x.example'],
    'CC must de-duplicate case-insensitively');
});

test('when nothing is configured head office resolves to nobody, not a wrong address', () => {
  const s = twoLocationFixture();
  const ho = s.headOfficeRecipients_(s.__tables.CLIENTS[0], 'B-PUN', 'Pune');
  assert.deepStrictEqual(arr(ho.to), []);
  assert.strictEqual(ho.source, 'NONE');
});

test('BRANCH_RECIPIENT=MATRIX_3 routes to whoever the matrix names at level 3', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Pune', Level: 3, LevelName: 'Branch Manager',
    ContactName: 'Pune BM', Email: 'bm.pune@acme.example' });
  s.setSetting_('BRANCH_RECIPIENT', 'MATRIX_3', 'test');
  const to = s.branchRecipients_(s.__tables.BRANCHES[1], s.__tables.CLIENTS[0]);
  assert.deepStrictEqual(arr(to), ['bm.pune@acme.example']);
});

test('MATRIX_n routing is per branch, so two locations get different recipients', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Mumbai', Level: 1, ContactName: 'Mum', Email: 'spoc.mum@acme.example' });
  addMatrix(s, { Location: 'Pune',   Level: 1, ContactName: 'Pun', Email: 'spoc.pun@acme.example' });
  s.setSetting_('BRANCH_RECIPIENT', 'MATRIX_1', 'test');
  const [mumB, punB] = s.__tables.BRANCHES;
  assert.deepStrictEqual(arr(s.branchRecipients_(mumB, s.__tables.CLIENTS[0])), ['spoc.mum@acme.example']);
  assert.deepStrictEqual(arr(s.branchRecipients_(punB, s.__tables.CLIENTS[0])), ['spoc.pun@acme.example']);
});

test('BRANCH_RECIPIENT=HEAD_OFFICE routes to the head office', () => {
  const s = twoLocationFixture();
  s.__tables.CLIENTS[0].HeadOfficeEmail = 'ho@acme.example';
  s.setSetting_('BRANCH_RECIPIENT', 'HEAD_OFFICE', 'test');
  assert.deepStrictEqual(arr(s.branchRecipients_(s.__tables.BRANCHES[0], s.__tables.CLIENTS[0])), ['ho@acme.example']);
});

test('the existing role names still work and are de-duplicated', () => {
  const s = twoLocationFixture();
  s.setSetting_('BRANCH_RECIPIENT', 'BRANCH_MANAGER,CRUX_POC,BRANCH_MANAGER', 'test');
  assert.deepStrictEqual(arr(s.branchRecipients_(s.__tables.BRANCHES[0], s.__tables.CLIENTS[0])),
    ['bm.mum@acme.example', 'poc.mum@crux.example']);
});

test('a literal email address in BRANCH_RECIPIENT is honoured', () => {
  const s = twoLocationFixture();
  s.setSetting_('BRANCH_RECIPIENT', 'fixed@crux.example,BRANCH_MANAGER', 'test');
  assert.deepStrictEqual(arr(s.branchRecipients_(s.__tables.BRANCHES[0], s.__tables.CLIENTS[0])),
    ['fixed@crux.example', 'bm.mum@acme.example']);
});

test('an unresolvable configuration still sends to somebody rather than nobody', () => {
  const s = twoLocationFixture();
  s.setSetting_('BRANCH_RECIPIENT', 'MATRIX_4', 'test');   // nothing at level 4
  const to = s.branchRecipients_(s.__tables.BRANCHES[0], s.__tables.CLIENTS[0]);
  assert.strictEqual(to.length, 1);
  assert.strictEqual(to[0], 'bm.mum@acme.example');
});

test('matrixRecipientsUpToLevel_ includes the levels below, not just the top', () => {
  const s = twoLocationFixture();
  addMatrix(s, { Location: 'Pune', Level: 1, ContactName: 'L1', Email: 'l1@acme.example' });
  addMatrix(s, { Location: 'Pune', Level: 2, LevelName: 'Team Leader', ContactName: 'L2', Email: 'l2@acme.example' });
  addMatrix(s, { Location: 'Pune', Level: 3, LevelName: 'Branch Manager', ContactName: 'L3', Email: 'l3@acme.example' });
  assert.deepStrictEqual(arr(s.matrixRecipientsUpToLevel_('C1', 'B-PUN', 'Pune', 2)),
    ['l1@acme.example', 'l2@acme.example']);
});

/* ==================================================================== */
section('3. Against the real exported data');

test('every branch resolves five levels without throwing', () => {
  const s = boot();
  const rows = s.readTable_('ESCALATION_MATRIX');
  const branches = s.readTable_('BRANCHES').filter(b => b.Status !== 'INACTIVE');
  // 121 of the 812 exported branches are ACTIVE; the other 691 are INACTIVE.
  assert.ok(branches.length > 100, 'expected the real active branch data, got ' + branches.length);
  let checked = 0;
  branches.forEach(b => {
    const r = s.resolveMatrixRows_(b.ClientID, b.BranchID, b.Location, rows);
    assert.strictEqual(r.length, 5, 'branch ' + b.BranchID + ' resolved ' + r.length + ' levels');
    checked++;
  });
  console.log('         (' + checked + ' real branches resolved)');
});

test('no branch resolves a contact belonging to a different client', () => {
  const s = boot();
  const rows = s.readTable_('ESCALATION_MATRIX');
  const byClient = {};
  rows.forEach(m => {
    (byClient[m.ClientID] = byClient[m.ClientID] || new Set())
      .add(String(m.Email || '').toLowerCase());
  });
  s.readTable_('BRANCHES').filter(b => b.Status !== 'INACTIVE').forEach(b => {
    s.resolveMatrixRows_(b.ClientID, b.BranchID, b.Location, rows).forEach(r => {
      const e = String(r.Email || '').toLowerCase();
      if (!e) return;
      assert.ok((byClient[b.ClientID] || new Set()).has(e),
        'branch ' + b.BranchID + ' of client ' + b.ClientID + ' resolved ' + e +
        ', which is not one of that client\'s matrix contacts');
    });
  });
});

test('the multi-location clients in the real data are reported honestly', () => {
  const s = boot();
  const locs = {};
  s.readTable_('BRANCHES').filter(b => b.Status !== 'INACTIVE').forEach(b => {
    const l = String(b.Location || '').trim().toUpperCase();
    if (l) (locs[b.ClientID] = locs[b.ClientID] || new Set()).add(l);
  });
  const multi = Object.keys(locs).filter(c => locs[c].size > 1);
  assert.ok(multi.length >= 1, 'expected at least one multi-location client');
  console.log('         (' + multi.length + ' clients have more than one location; ' +
    'largest has ' + Math.max(...multi.map(c => locs[c].size)) + ')');
});

/* ==================================================================== */
section('4. Location canonicalisation (M3)');

test('the real data does contain case-colliding locations', () => {
  const s = boot();
  const g = {};
  s.readTable_('BRANCHES').forEach(b => {
    const l = String(b.Location || '').trim();
    if (!l) return;
    const k = b.ClientID + '|' + l.toUpperCase();
    (g[k] = g[k] || new Set()).add(l);
  });
  const collisions = Object.keys(g).filter(k => g[k].size > 1);
  assert.ok(collisions.length >= 1,
    'expected the PUNE/Pune style collisions this migration exists to fix');
  console.log('         (' + collisions.length + ' colliding groups: ' +
    collisions.map(k => [...g[k]].join('/')).join(', ') + ')');
});

test('M3 dry run reports the rewrites and writes nothing', () => {
  const s = createSandbox({ activeUser: ADMIN, files: FILES.concat(['Migrate.gs']) });
  const before = JSON.stringify(s.__tables.BRANCHES.map(b => b.Location));
  const out = s.canonicaliseLocationsDryRun();
  assert.strictEqual(out.dryRun, true);
  assert.ok(out.branches >= 1, 'expected rows to rewrite');
  assert.strictEqual(JSON.stringify(s.__tables.BRANCHES.map(b => b.Location)), before,
    'a dry run must not write');
});

test('M3 leaves no case collisions behind, and is idempotent', () => {
  const s = createSandbox({ activeUser: ADMIN, files: FILES.concat(['Migrate.gs']) });
  s.canonicaliseLocations();
  const g = {};
  s.readTable_('BRANCHES').forEach(b => {
    const l = String(b.Location || '').trim();
    if (!l) return;
    (g[b.ClientID + '|' + l.toUpperCase()] = g[b.ClientID + '|' + l.toUpperCase()] || new Set()).add(l);
  });
  assert.strictEqual(Object.keys(g).filter(k => g[k].size > 1).length, 0,
    'collisions remain after the migration');
  const again = s.canonicaliseLocations();
  assert.strictEqual(again.branches, 0, 'a second run must be a no-op');
  assert.strictEqual(again.matrix, 0);
});

/* ==================================================================== */
section('5. Token retirement migration (M2)');

test('M2 clears every live token and flags who needs reinviting', () => {
  const s = createSandbox({ activeUser: ADMIN, files: FILES.concat(['Migrate.gs']) });
  s.__tables.USERS.forEach(u => { u.AccessToken = 'TOK-' + u.UserID + '-PADPADPADPADPADPAD'; });
  const out = s.retireLegacyTokens();
  assert.ok(out.cleared >= 25, 'expected the real user rows to be cleared, got ' + out.cleared);
  assert.ok(out.adminsCleared >= 1, 'expected administrator tokens to be cleared');
  const live = s.readTable_('USERS').filter(u => String(u.AccessToken || '').trim());
  assert.strictEqual(live.length, 0, 'no token may survive the migration');
  const admins = s.readTable_('USERS').filter(u => s.hasAdminAccess_(u));
  admins.forEach(u => assert.strictEqual(u.InviteStatus, 'NOT_REQUIRED',
    'an administrator must not sit on the reinvite worklist'));
});

test('after M2 no retired token can be exchanged', () => {
  const s = createSandbox({ activeUser: '', files: FILES.concat(['Migrate.gs']) });
  s.__tables.USERS.forEach(u => { u.AccessToken = 'TOK-' + u.UserID + '-PADPADPADPADPADPAD'; });
  const victim = s.__tables.USERS.find(u => !s.hasAdminAccess_(u) && u.Status === 'ACTIVE');
  const stolen = victim.AccessToken;
  s.retireLegacyTokens();
  assert.strictEqual(s.exchangeInviteCode_(stolen, {}), null,
    'a URL already in the wild must stop working');
});

/* ==================================================================== */
console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
