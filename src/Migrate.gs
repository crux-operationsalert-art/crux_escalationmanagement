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