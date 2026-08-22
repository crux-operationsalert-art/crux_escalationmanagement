/**
 * Migrate.gs — one-off data migrations. Run manually from the Apps Script editor.
 *
 * Each migration is IDEMPOTENT: running it twice must not duplicate data. Every
 * migration reports what it would do in DRY-RUN first, so nothing is written
 * until you have read the log and are happy.
 */

/* ===================================================================
 * M1 — fan client-level escalation matrix rows out to every branch.
 *
 * Before: ESCALATION_MATRIX has one set of 5 levels per CLIENT, BranchID = ''.
 * After:  every ACTIVE branch owns its own real 5 rows, seeded from its client's
 *         rows. No inheritance at read time — each branch's data stands alone
 *         and is independently editable and auditable, as specified.
 *
 * HOW TO RUN
 *   1. Editor > function dropdown > migrateMatrixToBranchLevelDryRun > Run.
 *      Read the Execution log. Nothing is written.
 *   2. Happy? Run migrateMatrixToBranchLevel.
 *   3. Re-run it any time; already-migrated branches are skipped.
 * =================================================================== */

function migrateMatrixToBranchLevelDryRun() { return m1_(true); }
function migrateMatrixToBranchLevel()       { return m1_(false); }

function m1_(dryRun) {
  var tag = dryRun ? '[DRY RUN] ' : '';
  Logger.log(tag + 'M1 — fan client matrix out to branches');

  var matrix   = readTable_('ESCALATION_MATRIX');
  var branches = readTable_('BRANCHES').filter(function(b){ return b.Status !== 'INACTIVE'; });
  var clients  = readTable_('CLIENTS');

  // Client-level template rows (the legacy shape) grouped by client.
  var template = {};
  matrix.forEach(function(m) {
    if (String(m.BranchID || '') !== '') return;      // already branch-level
    (template[m.ClientID] = template[m.ClientID] || []).push(m);
  });

  // What already exists per branch, so we never duplicate.
  var haveBranchLevel = {};
  matrix.forEach(function(m) {
    var bid = String(m.BranchID || '');
    if (bid) haveBranchLevel[bid + '|' + m.Level] = true;
  });

  var toAdd = [];
  var perClient = {};
  var noTemplate = [];

  branches.forEach(function(b) {
    var tpl = template[b.ClientID];
    if (!tpl || !tpl.length) { noTemplate.push(b.BranchID); return; }
    MATRIX_LEVELS.forEach(function(L) {
      if (haveBranchLevel[b.BranchID + '|' + L.level]) return;   // already done
      var src = tpl.filter(function(r){ return String(r.Level) === String(L.level); })[0] || {};
      toAdd.push({
        MatrixID: '',                                  // assigned below
        ClientID: b.ClientID, BranchID: b.BranchID,
        Level: L.level, LevelName: L.name,
        ContactName: src.ContactName || '', Mobile: src.Mobile || '', Email: src.Email || '',
        UpdatedAt: nowIso_(), UpdatedBy: 'migration:M1'
      });
      perClient[b.ClientID] = (perClient[b.ClientID] || 0) + 1;
    });
  });

  Logger.log(tag + 'clients with a client-level template : ' + Object.keys(template).length);
  Logger.log(tag + 'active branches                      : ' + branches.length);
  Logger.log(tag + 'rows that would be created           : ' + toAdd.length);
  Object.keys(perClient).forEach(function(cid) {
    var c = clients.filter(function(x){ return x.ClientID === cid; })[0] || {};
    Logger.log(tag + '  ' + cid + ' (' + (c.ClientName || '?') + '): +' + perClient[cid] + ' rows');
  });
  if (noTemplate.length) {
    Logger.log(tag + 'WARNING: ' + noTemplate.length + ' branch(es) have no client-level template '
      + 'to copy from and were skipped. Fill their client matrix first, then re-run. '
      + 'First few: ' + noTemplate.slice(0, 10).join(', '));
  }
  if (!toAdd.length) {
    Logger.log(tag + 'Nothing to do — already migrated.');
    return { created: 0, skippedBranches: noTemplate.length, dryRun: !!dryRun };
  }
  if (dryRun) {
    Logger.log('[DRY RUN] No changes written. Run migrateMatrixToBranchLevel to apply.');
    return { wouldCreate: toAdd.length, skippedBranches: noTemplate.length, dryRun: true };
  }

  // Assign ids and write in bulk chunks (one setValues per chunk).
  var seq = matrix.length + 1;
  toAdd.forEach(function(r){ r.MatrixID = 'MTX-' + pad_(seq++, 5); });
  var CHUNK = 2000;
  var written = 0;
  for (var i = 0; i < toAdd.length; i += CHUNK) {
    written += appendRows_('ESCALATION_MATRIX', toAdd.slice(i, i + CHUNK));
  }

  logAudit_({
    user: 'migration:M1', action: 'MIGRATION', entity: 'ESCALATION_MATRIX',
    entityId: 'M1', oldValue: 'client-level rows: ' + matrix.length,
    newValue: 'branch-level rows created: ' + written
  });
  Logger.log('M1 complete. Created ' + written + ' branch-level rows.');
  Logger.log('The original client-level rows were LEFT IN PLACE as a fallback and');
  Logger.log('an audit record. Once you are satisfied, archive them with');
  Logger.log('archiveClientLevelMatrixRows().');
  return { created: written, skippedBranches: noTemplate.length, dryRun: false };
}

/**
 * Optional cleanup after M1 has been verified: removes the legacy client-level
 * rows (BranchID = ''). Keep them until you have checked a few branches in the
 * UI — they are the only copy of the pre-migration state inside the sheet.
 */
function archiveClientLevelMatrixRows() {
  var sh = sh_('ESCALATION_MATRIX');
  var headers = SCHEMA['ESCALATION_MATRIX'];
  var last = sh.getLastRow();
  if (last < 2) { Logger.log('Nothing to archive.'); return { removed: 0 }; }
  var bCol = headers.indexOf('BranchID');
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var keep = values.filter(function(r){ return String(r[bCol] || '') !== ''; });
  var removed = values.length - keep.length;
  if (!removed) { Logger.log('No client-level rows found.'); return { removed: 0 }; }
  sh.getRange(2, 1, values.length, headers.length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, headers.length).setValues(keep);
  invalidateTableCache_('ESCALATION_MATRIX');
  logAudit_({ user: 'migration:M1', action: 'MIGRATION', entity: 'ESCALATION_MATRIX',
    entityId: 'M1-archive', oldValue: String(values.length), newValue: String(keep.length) });
  Logger.log('Removed ' + removed + ' client-level row(s). ' + keep.length + ' branch-level rows remain.');
  return { removed: removed, remaining: keep.length };
}
/* ===================================================================
 * M2 — retire permanent URL tokens (P0 incident remediation, 2026-08-22).
 *
 * Before: USERS.AccessToken was a permanent bearer credential. Anyone holding
 *         the URL `.../exec?t=<token>` was authenticated as its owner, forever.
 *         Two of those rows are administrators, so a leaked admin link granted
 *         full administrative access to whoever opened it.
 * After:  - every administrator row has its token cleared, because an admin can
 *           no longer sign in by link at all (Session.gs caps link identity
 *           below administrator);
 *         - every other live token is invalidated, so no URL already in a
 *           browser history, a bookmark or a forwarded email still works;
 *         - affected people are flagged NEEDS_REINVITE so an administrator can
 *           reissue single-use codes deliberately, in one pass, from Admin >
 *           Users.
 *
 * This is the step that actually closes the incident for tokens already in the
 * wild. Deploying the code alone leaves those URLs valid until first use.
 *
 * HOW TO RUN
 *   1. Editor > function dropdown > retireLegacyTokensDryRun > Run. Read the log.
 *   2. Happy? Run retireLegacyTokens.
 *   3. Then, in the app: Admin > Users > Invite for each person listed. Every
 *      invite is single-use and expires.
 * =================================================================== */

function retireLegacyTokensDryRun() { return m2_(true); }
function retireLegacyTokens()       { return m2_(false); }

function m2_(dryRun) {
  var tag = dryRun ? '[DRY RUN] ' : '';
  Logger.log(tag + 'M2 — retire permanent URL tokens');

  var users = readTable_('USERS');
  var admins = [], others = [], already = 0;

  users.forEach(function(u) {
    var tok = String(u.AccessToken || '').trim();
    if (!tok) { already++; return; }
    if (hasAdminAccess_(u) || String(u.Role || '').toUpperCase() === 'ADMIN') admins.push(u);
    else others.push(u);
  });

  Logger.log(tag + 'administrator rows holding a live token: ' + admins.length);
  admins.forEach(function(u) { Logger.log(tag + '  ADMIN  ' + u.Email); });
  Logger.log(tag + 'other rows holding a live token: ' + others.length);
  others.forEach(function(u) { Logger.log(tag + '  user   ' + u.Email); });
  Logger.log(tag + 'rows already without a token: ' + already);

  if (dryRun) {
    Logger.log('[DRY RUN] nothing written. Run retireLegacyTokens to apply.');
    return { dryRun: true, admins: admins.length, others: others.length, cleared: 0 };
  }

  var cleared = 0;
  admins.concat(others).forEach(function(u) {
    var email = String(u.Email || '').toLowerCase();
    updateRowById_('USERS', 'Email', email, {
      AccessToken: '',
      // An administrator needs no invite at all; everyone else needs a fresh
      // single-use one. Distinguishing them stops an admin appearing on the
      // reinvite worklist forever.
      InviteStatus: (hasAdminAccess_(u) || String(u.Role || '').toUpperCase() === 'ADMIN')
        ? 'NOT_REQUIRED' : 'NEEDS_REINVITE',
      UpdatedAt: nowIso_(), UpdatedBy: 'migration:M2'
    });
    cleared++;
  });
  invalidateTableCache_('USERS');

  // Any session minted under the old rules is also untrustworthy.
  var killedSessions = 0;
  try {
    readTable_('SESSIONS').forEach(function(s) {
      if (String(s.RevokedAt || '').trim()) return;
      updateRowById_('SESSIONS', 'SessionID', s.SessionID,
        { RevokedAt: nowIso_(), RevokedBy: 'migration:M2' });
      killedSessions++;
    });
    if (killedSessions) invalidateTableCache_('SESSIONS');
  } catch (e) { Logger.log('SESSIONS not present yet: ' + e); }

  logAudit_({ user: 'migration:M2', action: 'SECURITY_TOKEN_RETIRE', entity: 'USERS', entityId: '',
    oldValue: 'permanent URL tokens',
    newValue: JSON.stringify({ cleared: cleared, adminsCleared: admins.length,
                               sessionsRevoked: killedSessions }) });

  Logger.log('M2 done. Tokens cleared: ' + cleared + '. Sessions revoked: ' + killedSessions);
  Logger.log('NEXT: Admin > Users > Invite for everyone marked NEEDS_REINVITE.');
  return { dryRun: false, cleared: cleared, adminsCleared: admins.length,
           sessionsRevoked: killedSessions };
}

/* ===================================================================
 * M3 — canonicalise Location spelling.
 *
 * BRANCHES.Location was free text, so the same place was recorded several ways:
 * CLI-00024 has 'PUNE' on eight branches and 'Pune' on one; CLI-00010 has 'PUNE'
 * and 'pune'. The matrix resolver compares location case-insensitively, so the
 * server treats those as ONE location - but the branch screen listed them
 * separately, so an operator could open what looked like two independent location
 * defaults and have each save overwrite the other.
 *
 * This picks the commonest spelling per client+location and rewrites the rest, in
 * BRANCHES and in ESCALATION_MATRIX, so storage agrees with the resolver.
 *
 * HOW TO RUN
 *   1. Editor > canonicaliseLocationsDryRun > Run. Read the log.
 *   2. Happy? Run canonicaliseLocations.
 * =================================================================== */

function canonicaliseLocationsDryRun() { return m3_(true); }
function canonicaliseLocations()       { return m3_(false); }

function m3_(dryRun) {
  var tag = dryRun ? '[DRY RUN] ' : '';
  Logger.log(tag + 'M3 — canonicalise Location spelling');

  var branches = readTable_('BRANCHES');
  var matrix   = readTable_('ESCALATION_MATRIX');

  // Commonest spelling per client + upper-cased location.
  var tally = {};
  branches.forEach(function(b) {
    var loc = String(b.Location || '').trim().replace(/\s+/g, ' ');
    if (!loc) return;
    var k = String(b.ClientID) + '|' + loc.toUpperCase();
    var e = tally[k] || (tally[k] = { counts: {}, best: loc, n: 0 });
    e.counts[loc] = (e.counts[loc] || 0) + 1;
    if (e.counts[loc] > e.n) { e.n = e.counts[loc]; e.best = loc; }
  });

  var canon = function(clientId, loc) {
    var v = String(loc || '').trim().replace(/\s+/g, ' ');
    if (!v) return '';
    var e = tally[String(clientId) + '|' + v.toUpperCase()];
    return e ? e.best : v;
  };

  var brFix = branches.filter(function(b) {
    var want = canon(b.ClientID, b.Location);
    return want && want !== String(b.Location || '');
  });
  var mxFix = matrix.filter(function(m) {
    if (!String(m.Location || '').trim()) return false;   // client-wide / branch row
    var want = canon(m.ClientID, m.Location);
    return want && want !== String(m.Location || '');
  });

  Logger.log(tag + 'distinct client+location groups: ' + Object.keys(tally).length);
  Logger.log(tag + 'BRANCHES rows to rewrite: ' + brFix.length);
  brFix.forEach(function(b) {
    Logger.log(tag + '  ' + b.BranchID + '  "' + b.Location + '" -> "' + canon(b.ClientID, b.Location) + '"');
  });
  Logger.log(tag + 'ESCALATION_MATRIX rows to rewrite: ' + mxFix.length);
  mxFix.forEach(function(m) {
    Logger.log(tag + '  ' + m.MatrixID + '  "' + m.Location + '" -> "' + canon(m.ClientID, m.Location) + '"');
  });

  if (dryRun) {
    Logger.log('[DRY RUN] nothing written. Run canonicaliseLocations to apply.');
    return { dryRun: true, branches: brFix.length, matrix: mxFix.length };
  }

  brFix.forEach(function(b) {
    updateRowById_('BRANCHES', 'BranchID', b.BranchID,
      { Location: canon(b.ClientID, b.Location), UpdatedAt: nowIso_(), UpdatedBy: 'migration:M3' });
  });
  mxFix.forEach(function(m) {
    updateRowById_('ESCALATION_MATRIX', 'MatrixID', m.MatrixID,
      { Location: canon(m.ClientID, m.Location), UpdatedAt: nowIso_(), UpdatedBy: 'migration:M3' });
  });
  if (brFix.length) invalidateTableCache_('BRANCHES');
  if (mxFix.length) invalidateTableCache_('ESCALATION_MATRIX');

  logAudit_({ user: 'migration:M3', action: 'LOCATION_CANONICALISE', entity: 'BRANCHES', entityId: '',
    oldValue: '', newValue: JSON.stringify({ branches: brFix.length, matrix: mxFix.length }) });
  Logger.log('M3 done. BRANCHES: ' + brFix.length + ', ESCALATION_MATRIX: ' + mxFix.length);
  return { dryRun: false, branches: brFix.length, matrix: mxFix.length };
}
