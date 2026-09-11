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

/* ===================================================================
 * M4 — remove orphan escalation history left by the deployment self-test.
 *
 * The self-test raises real escalations in the live datastore and deletes them
 * afterwards, but its cleanup removed only the ESCALATIONS row and never the
 * child ESCALATION_HISTORY rows. Every run therefore left history behind
 * pointing at an escalation that no longer exists.
 *
 * In the live datastore that is 166 of 171 history rows. The consequence is not
 * cosmetic: the strike engine groups history by EscalationID to decide when
 * somebody last responded, listing screens count history per escalation, and the
 * audit trail reads as though far more happened than did.
 *
 * The leak itself is fixed in Preflight.gs. This clears what has already
 * accumulated. It only ever removes rows whose parent escalation is ABSENT --
 * history for a live escalation is never touched.
 *
 * HOW TO RUN
 *   1. Editor > purgeOrphanHistoryDryRun > Run. Read the log carefully: it lists
 *      every row it would remove, grouped by the missing escalation.
 *   2. Happy? Run purgeOrphanHistory.
 * =================================================================== */

function purgeOrphanHistoryDryRun() { return m4_(true); }
function purgeOrphanHistory()       { return m4_(false); }

function m4_(dryRun) {
  var tag = dryRun ? '[DRY RUN] ' : '';
  Logger.log(tag + 'M4 — purge orphan escalation history');

  var live = {};
  readTable_('ESCALATIONS').forEach(function(e) { live[String(e.EscalationID)] = true; });
  var history = readTable_('ESCALATION_HISTORY');
  var orphans = history.filter(function(h) { return !live[String(h.EscalationID || '')]; });

  var byEsc = {};
  orphans.forEach(function(h) {
    (byEsc[h.EscalationID] = byEsc[h.EscalationID] || []).push(h);
  });

  Logger.log(tag + 'history rows total: ' + history.length);
  Logger.log(tag + 'orphan rows: ' + orphans.length + ' across ' +
             Object.keys(byEsc).length + ' missing escalation(s)');
  Object.keys(byEsc).sort().forEach(function(id) {
    Logger.log(tag + '  ' + id + ': ' + byEsc[id].length + ' row(s)');
  });

  // Warnings referenced by history but absent from the register. Reported only:
  // a missing warning is a fact an administrator should see, not something a
  // migration should invent a replacement for.
  var wIds = {};
  history.forEach(function(h) {
    [h.NewValue, h.OldValue].forEach(function(v) {
      var m = /WRN-\d+/.exec(String(v || ''));
      if (m) wIds[m[0]] = true;
    });
  });
  var haveW = {};
  readTable_('WARNINGS').forEach(function(w) { haveW[String(w.WarningID)] = true; });
  var missingW = Object.keys(wIds).filter(function(id) { return !haveW[id]; });
  if (missingW.length) {
    Logger.log(tag + 'NOTE: history references warnings that are not in WARNINGS: ' +
      missingW.join(', ') + '. These were raised and later removed (self-test ' +
      'residue). Nothing is recreated; recorded here so the gap is visible.');
  }

  if (dryRun) {
    Logger.log('[DRY RUN] nothing written. Run purgeOrphanHistory to apply.');
    return { dryRun: true, orphans: orphans.length,
             escalations: Object.keys(byEsc).length, missingWarnings: missingW };
  }

  var removed = 0;
  orphans.forEach(function(h) {
    try { deleteRowById_('ESCALATION_HISTORY', 'HistoryID', h.HistoryID); removed++; }
    catch (e) { Logger.log('failed to remove ' + h.HistoryID + ': ' + e); }
  });
  if (removed) invalidateTableCache_('ESCALATION_HISTORY');

  logAudit_({ user: 'migration:M4', action: 'ORPHAN_HISTORY_PURGE',
    entity: 'ESCALATION_HISTORY', entityId: '',
    oldValue: String(history.length),
    newValue: JSON.stringify({ removed: removed, missingWarnings: missingW }) });

  Logger.log('M4 done. Removed ' + removed + ' orphan history row(s).');
  return { dryRun: false, removed: removed, missingWarnings: missingW };
}

/* ===================================================================
 * M5 — normalise TARGETS for client allocations (section 14).
 *
 * A KPI can now be divided across clients, so TARGETS gained ClientID and
 * SubCategory. A row with both blank is the KPI's single combined figure, which
 * is exactly what every pre-existing row is -- so no data has to move, and the
 * three live rows keep scoring identically.
 *
 * What this does check is the one invariant the new model relies on: a KPI must
 * not hold a combined row AND per-client slices at the same time, or the KPI
 * would be counted twice. It reports any such conflict rather than guessing which
 * shape was intended, because picking either would silently change somebody's
 * score.
 *
 * It also fills the two new columns with '' where the export left them undefined,
 * so downstream reads never see undefined.
 *
 * HOW TO RUN
 *   1. Editor > normaliseTargetAllocationsDryRun > Run. Read the log.
 *   2. Happy? Run normaliseTargetAllocations.
 * =================================================================== */

function normaliseTargetAllocationsDryRun() { return m5_(true); }
function normaliseTargetAllocations()       { return m5_(false); }

function m5_(dryRun) {
  var tag = dryRun ? '[DRY RUN] ' : '';
  Logger.log(tag + 'M5 — normalise TARGETS allocations');

  var rows = readTable_('TARGETS');
  Logger.log(tag + 'TARGETS rows: ' + rows.length);

  var needsFill = rows.filter(function(t) {
    return t.ClientID === undefined || t.SubCategory === undefined;
  });

  // Conflict check: same person + month + KPI holding both shapes.
  var groups = {};
  rows.forEach(function(t) {
    var k = String(t.PersonEmail || '').toLowerCase() + '|' +
            monthOfValue_(t.MonthKey) + '|' + String(t.Category || '');
    (groups[k] = groups[k] || []).push(t);
  });
  var conflicts = [];
  Object.keys(groups).forEach(function(k) {
    var g = groups[k];
    var combined = g.filter(function(t) {
      return !String(t.ClientID || '').trim() && !String(t.SubCategory || '').trim();
    });
    var sliced = g.filter(function(t) {
      return String(t.ClientID || '').trim() || String(t.SubCategory || '').trim();
    });
    if (combined.length && sliced.length) {
      conflicts.push({ key: k, combined: combined.length, sliced: sliced.length });
    }
    if (combined.length > 1) {
      conflicts.push({ key: k, duplicateCombined: combined.length });
    }
    if (sliced.length > KPI_ALLOCATION_MAX) {
      conflicts.push({ key: k, overAllocationLimit: sliced.length });
    }
  });

  Logger.log(tag + 'rows missing the new columns: ' + needsFill.length);
  Logger.log(tag + 'conflicting KPI groups: ' + conflicts.length);
  conflicts.forEach(function(c) { Logger.log(tag + '  ' + JSON.stringify(c)); });
  if (conflicts.length) {
    Logger.log(tag + 'NOTE: conflicts are REPORTED, not resolved. Choosing a shape ' +
      'would change somebody\'s score; a manager should decide per KPI.');
  }

  if (dryRun) {
    Logger.log('[DRY RUN] nothing written. Run normaliseTargetAllocations to apply.');
    return { dryRun: true, rows: rows.length, filled: needsFill.length, conflicts: conflicts };
  }

  var filled = 0;
  needsFill.forEach(function(t) {
    updateRowById_('TARGETS', 'TargetID', t.TargetID, {
      ClientID: String(t.ClientID || ''), SubCategory: String(t.SubCategory || '')
    });
    filled++;
  });
  if (filled) invalidateTableCache_('TARGETS');

  logAudit_({ user: 'migration:M5', action: 'TARGET_ALLOCATION_NORMALISE', entity: 'TARGETS',
    entityId: '', oldValue: String(rows.length),
    newValue: JSON.stringify({ filled: filled, conflicts: conflicts.length }) });
  Logger.log('M5 done. Filled ' + filled + ' row(s). Conflicts left for a human: ' + conflicts.length);
  return { dryRun: false, filled: filled, conflicts: conflicts };
}
