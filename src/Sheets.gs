/**
 * Sheets.gs — spreadsheet bootstrap + generic table CRUD.
 * Every sheet is treated as a table with a header row.
 * Records use stable IDs (never row index).
 */

// One canonical schema. Order matters for column layout.
var SCHEMA = {
  SETTINGS: ['Key','Value','Description','UpdatedAt','UpdatedBy'],
  // Scope* columns decide WHAT A USER CAN SEE. Comma-separated, blank = none.
  // A user is also auto-scoped to any branch where their email is the
  // LocationHead, BranchManager or Crux POC - so a branch manager needs no setup.
  USERS:    ['UserID','Name','Email','Mobile','Department','Designation','Role','EmployeeType','PartnerCompany','EmployeeID','DateOfJoining','EmploymentStatus','AdminAccess','AccessToken','InvitedAt','InviteStatus','LocationHead','Manager','ScopeZones','ScopeLocations','ScopeBranchIDs','ScopeClientIDs','Status','CreatedAt','UpdatedAt','UpdatedBy'],
  // HeadOfficeEmail / HeadOfficeCC: the client's own head office. Level 5 of the
  // escalation matrix is 'Head Office', but there was nowhere to record the
  // address, so a level-5 escalation had no one to reach.
  CLIENTS:  ['ClientID','ClientName','ClientCode','ClientEmail','ClientCC','HeadOfficeEmail','HeadOfficeCC','DefaultLocationHead','Status','EffectiveFrom','EffectiveTo','Notes','CreatedAt','UpdatedAt','UpdatedBy'],
  BRANCHES: ['BranchID','ClientID','BranchName','BranchCode','Address','CruxPOCName','CruxPOCEmpID','CruxPOCMobile','CruxPOCEmail','BranchManagerName','BranchManagerMobile','BranchManagerEmail','LocationHead','Location','Zone','Status','EffectiveFrom','EffectiveTo','Notes','CreatedAt','UpdatedAt','UpdatedBy'],
  // BranchID: '' means a client-level row (pre-migration legacy). After
  // migrateMatrixToBranchLevel() every row carries a real BranchID.
  ESCALATION_MATRIX: ['MatrixID','ClientID','Location','BranchID','Level','LevelName','ContactName','Mobile','Email','UpdatedAt','UpdatedBy'],
  HOLIDAYS: ['HolidayID','Date','Name','Status','CreatedAt'],
  EMAIL_TEMPLATES: ['Key','Subject','Body','UpdatedAt','UpdatedBy'],
  // RetryBody holds the rendered HTML of a send that FAILED, and only while it
  // is still retryable. Without it a retry had nothing to resend: it posted a
  // placeholder line and marked the row SENT, so the recipient never received
  // the escalation and the failure looked resolved. Cleared once sent or spent,
  // so the column stays empty in normal operation.
  EMAIL_LOG: ['LogID','Timestamp','Type','ClientID','BranchID','ToAddr','CcAddr','Subject','Trigger','SentBy','Status','Attempt','Error','MessageRef','IdempotencyKey','RetryBody','NextRetryAt'],
  REMINDER_LOG: ['JobKey','Type','Month','ExecutedAt','ExecutedBy','Result','Notes'],
  // A2 QUEUE: one row per dispatch target per month. Lets the 1st-of-month send
  // be resumable across many short executions and spread across days to stay
  // inside Gmail's daily recipient cap.
  // Strike-3 notices. A factual record of non-response, not a disciplinary
  // finding - what it means is for a human to decide.
  // People management. Kept separate from WARNINGS so a performance record and a
  // service escalation never get confused with one another.
  PEOPLE_EVENTS: ['EventID','Timestamp','PersonEmail','Type','StartDate','EndDate',
                  'Notes','IssuedBy','Status','ClosedAt','Outcome'],
  // Targets are per person, per month, PER CATEGORY. Keeping the three categories
  // as separate rows rather than three columns means a fourth category later is a
  // data change, not a schema rewrite - and reporting, scoring and aggregation all
  // group by the same key.
  // KPI definitions. A blank PersonEmail is the organisation default; a row with
  // an email overrides it for that person. Kept as rows rather than a fixed list
  // so a manager can change what their team is measured on without a code change.
  KPI_DEFS: ['KpiID','PersonEmail','Category','Position','Active','UpdatedBy','UpdatedAt'],

  // A KPI can be split across clients (section 14). ClientID names the client
  // the slice belongs to and SubCategory labels a non-client split; BOTH blank is
  // the single unallocated row for that KPI, which is what every pre-existing row
  // is. The row key is therefore PersonEmail + MonthKey + Category + ClientID +
  // SubCategory, so a KPI's slices sum to the KPI and the KPI still rolls up to
  // the person exactly as before.
  TARGETS: ['TargetID','PersonEmail','MonthKey','Category','ClientID','SubCategory',
            'TargetValue','AchievedValue',
            'Notes','UpdatedBy','UpdatedAt','ClosedAt','ClosedBy'],

  // The computed monthly score. One row per person per month.
  SCORES: ['ScoreID','PersonEmail','MonthKey','TargetScore','AttributeScore','FinalScore',
           'OwnAttributePoints','TeamAttributePoints','ManagerRating','Comments',
           'AreasOfImprovement','NextMonthExpectations','Status','ScoredBy','ScoredAt',
           'EmployeeDecision','DecisionAt','DecisionReason','HRStatus','HRNotes','ComputedAt'],

  // Every adjustment, in order, with the score before and after. The scoring rules
  // are only defensible to the person being scored if each step is visible.
  SCORE_LEDGER: ['LedgerID','PersonEmail','MonthKey','Timestamp','SourceType','SourceID',
                 'Reason','Component','Delta','ScoreBefore','ScoreAfter','Sequence'],

  WARNINGS: ['WarningID','IssuedAt','EscalationID','PersonEmail','PersonName','ClientID','BranchID','StrikeLevel','Category','Summary','FactsJson','IssuedBy','Status','AcknowledgedAt','Notes'],
  DISPATCH_QUEUE: ['QueueID','MonthKey','Granularity','ClientID','BranchID','Recipient','Status','Attempt','PlannedAt','SentAt','Error','IdempotencyKey'],
  ESCALATIONS: ['EscalationID','Type','Date','Time','ClientID','BranchID','BranchCode','ContactName','ContactPhone','Category','Severity','EscalatedAgainst','AgainstEmail','Description','AssignedOwner','RequiredAction','TargetDate','Status','ClosureDate','ClosureRemarks','ExceptionBy','ExceptionAt','ExceptionReason','LastActivityAt','CreatedBy','CreatedAt','UpdatedAt'],
  ESCALATION_HISTORY: ['HistoryID','EscalationID','Timestamp','User','Field','OldValue','NewValue','Note'],
  AUDIT_LOG: ['LogID','Timestamp','User','Action','Entity','EntityID','OldValue','NewValue'],
  // Server-side sessions for colleagues whose Google identity this deployment
  // cannot read (personal Gmail under executeAs: USER_DEPLOYING). The browser
  // only ever holds SessionID, in sessionStorage - never in the URL. See
  // Session.gs for why the old permanent ?t= token had to go.
  SESSIONS: ['SessionID','PersonEmail','CreatedAt','LastSeenAt','ExpiresAt','Fingerprint','Source','RevokedAt','RevokedBy']
};

var DEFAULT_SETTINGS = [
  ['APP_NAME','Crux Escalation Matrix','Displayed app title'],
  ['COMPANY_NAME','Crux Risk Management Pvt Ltd','Company name'],
  ['APP_TIMEZONE','Asia/Kolkata','Timezone for jobs & dates'],
  ['DATE_FORMAT','dd-MMM-yyyy','UI date format'],
  ['REMINDER_DAY_1','25','Day of month for first reminder'],
  ['REMINDER_TIME','12:00','Time of day HH:mm (24h)'],
  ['MONTHLY_DISPATCH_DAY','1','Day of month to dispatch matrix to client'],
  ['MONTHLY_DISPATCH_TIME','10:00','Time of day HH:mm for dispatch'],
  ['MONTHLY_SUMMARY_DAY','2','Day of month to email admin summary of previous month'],
  ['MONTHLY_SUMMARY_TIME','09:00','Time of day HH:mm for summary digest'],
  ['FROM_NAME','Crux Risk Management','Email display name'],
  ['ESCALATION_CC','valsan.p@cruxindia.co.in','Always copied on every raised or logged escalation and on all three-strike reminders. Comma-separated.'],
  ['STRIKE_ENABLED','true','Master switch for the three-strike chase on open escalations.'],
  ['WORK_HOURS_START','10','Earliest hour (24h) any strike email may be sent. Also the start of the working day for the strike clock.'],
  ['WORK_HOURS_END','17','Latest hour (24h) any strike email may be sent. Also the end of the working day for the strike clock.'],
  ['STRIKE_WINDOW_HOURS','24','Working hours of no activity before the next strike. Weekends never count.'],
  ['STRIKE2_CC','shantanu.suravase@cruxindia.co.in,manish.s@cruxindia.co.in','Added to CC from strike 2 onwards.'],
  ['STRIKE3_TO','valsan.p@cruxindia.co.in','Strike 3 is addressed to HR.'],
  ['MD_EMAIL','','Copied on strike 3 and on every issued notice. Leave blank to skip.'],
  ['DISPATCH_GRANULARITY','BRANCH','CLIENT = one email per client (default). BRANCH = one email per branch. Switch to BRANCH only after the per-branch matrix is populated.'],
  ['DISPATCH_BATCH_SIZE','200','SAFETY CEILING only. The worker is self-tuning: it sends until ~3.5 min of its 6-min budget is used, then resumes on the next tick. Lower this only to deliberately throttle.'],
  ['DISPATCH_QUOTA_RESERVE','200','Email recipients held back each day for reminders and manual sends. The worker stops when remaining daily quota falls below this.'],
  ['BRANCH_RECIPIENT','BRANCH_MANAGER,CRUX_POC','Comma separated roles who receive a branch dispatch: BRANCH_MANAGER, CRUX_POC (the SPOC), CLIENT, LOCATION_HEAD, HEAD_OFFICE, or MATRIX_1..MATRIX_5 to use whoever the escalation matrix names at that level. Plain email addresses may also be listed.'],
  ['APPRECIATION_NUDGE_ENABLED','true','Weekly nudge to managers who have recognised nobody on their team this month.'],
  ['APPRECIATION_NUDGE_DAY','1','ISO day of week for the appreciation nudge. 1 = Monday.'],
  ['APPRECIATION_NUDGE_HOUR','11','Earliest hour (24h) the appreciation nudge may go out.'],
  ['HEAD_OFFICE_EMAIL','','Crux head office mailbox. Used for a head-office (level 5) escalation when the client has no HeadOfficeEmail of its own and the matrix names nobody at level 5.'],
  ['HEAD_OFFICE_CC','','Always copied on any head-office escalation. Comma separated.'],
  ['FROM_ADDRESS','','Sender address. MUST be a verified "Send mail as" alias on the deploying account, or blank to use that account\'s own address.'],
  ['REPLY_TO','','Reply-to address (blank uses sender)'],
  ['DEFAULT_CC','','Default CC (comma separated)'],
  ['DEFAULT_BCC','','Default BCC (comma separated)'],
  ['ESCALATION_MANAGER','','Internal escalation recipient (email)'],
  ['SUMMARY_EXTRA_RECIPIENTS','','Extra recipients for the monthly digest (comma-separated). Added in addition to all active ADMINs.'],
  ['RETRY_LIMIT','3','Max email retry attempts'],
  ['DRY_RUN','false','If true, override all recipients with TEST_EMAIL_OVERRIDE'],
  ['TEST_EMAIL_OVERRIDE','','Recipient used when DRY_RUN is true'],
  ['SIGNATURE','<p>Warm regards,<br/>Team Crux Risk Management</p>','Raw HTML signature. Used only when SIGNATURE_MODE=HTML.'],
  ['SIGNATURE_MODE','BUILDER','BUILDER = compose the signature from the SIG_ fields below. HTML = use the raw SIGNATURE block as typed.'],
  ['SIG_NAME','Team Crux Risk Management','Name shown on the signature'],
  ['SIG_TITLE','','Job title, optional'],
  ['SIG_PHONE','','Phone, optional'],
  ['SIG_EMAIL','','Email shown in the signature, optional'],
  ['SIG_WEBSITE','https://www.cruxindia.co.in','Website, optional'],
  ['SIG_LOGO_URL','','Direct link to a logo image. Must be a public https link ending in .png or .jpg. A Google Drive share link will NOT render in email.'],
  ['SIG_LOGO_WIDTH','140','Logo width in pixels'],
  ['SIG_TAGLINE','','One line under the details, optional']
];

var DEFAULT_TEMPLATES = [
  ['REMINDER',
   'Action required: Update Client Escalation Matrix — {{MONTH}} {{YEAR}}',
   '<p>Dear {{LOCATION_HEAD_NAME}},</p><p>Please review and update the Client Escalation Matrix for the following clients assigned to you. The finalized matrix will be dispatched to clients on the 1st of {{NEXT_MONTH}}.</p>{{CLIENT_TABLE}}<p><a href="{{APP_URL}}">Open the tool</a></p>{{SIGNATURE}}'],
  ['DISPATCH',
   'Client Escalation Matrix — {{CLIENT_NAME}} — {{MONTH}} {{YEAR}}',
   '<p>{{GREETING}}</p><p>Please find below the current escalation matrix for <b>{{CLIENT_NAME}}</b>, effective {{MONTH}} {{YEAR}}. Kindly reach out to the concerned level should any issue require attention.</p>{{MATRIX_TABLE}}<p>Branch contacts are available on request.</p>{{SIGNATURE}}'],
  ['INCOMPLETE',
   '[ACTION REQUIRED] Incomplete Escalation Matrix — {{CLIENT_NAME}}',
   '<p>Dear {{LOCATION_HEAD_NAME}},</p><p>The escalation matrix for <b>{{CLIENT_NAME}}</b> could not be dispatched because the following mandatory fields are missing:</p>{{MISSING_LIST}}<p>Please complete the matrix at the earliest. This client email was <b>not</b> sent.</p>{{SIGNATURE}}'],
  ['RAISE_ESCALATION',
   '[ESCALATION] {{CATEGORY}} — {{CLIENT_NAME}} ({{BRANCH_CODE}})',
   '<p>{{GREETING}}</p><p>We wish to formally escalate the following matter:</p>{{ESCALATION_TABLE}}<p><b>Required resolution:</b> {{REQUIRED_RESOLUTION}}<br/><b>Due date:</b> {{DUE_DATE}}</p>{{SIGNATURE}}'],
  ['TEST',
   '[TEST] Crux Escalation Tool — Email connectivity check',
   '<p>This is a test email from the Crux Escalation Matrix tool.</p><p>If you received this, sending is configured correctly.</p>{{SIGNATURE}}']
];

var SS_PROP_KEY = 'CRUX_SS_ID';
// Per-execution caches — Apps Script instantiates a fresh V8 context per RPC call.
// Caching within a single execution avoids repeat spreadsheet opens + header scans.
var _SS_CACHE = null;
var _SCHEMA_OK = false;
var _TABLE_CACHE = {};
var _SETTINGS_MAP = null;

// PERF FIX: the caches above die with the execution, so the 12-table header
// scan in ensureSpreadsheet_ used to re-run on EVERY rpc() call (~26+ Sheets
// API round-trips before any real work). We persist a "schema verified" stamp
// in Script Properties instead. The stamp encodes the table list AND every
// header name, so editing SCHEMA in code automatically forces one re-scan.
var SCHEMA_STAMP_KEY = 'CRUX_SCHEMA_STAMP';
function schemaStamp_() {
  var tables = Object.keys(SCHEMA).sort().map(function(n) {
    return n + '[' + SCHEMA[n].join(',') + ']';
  }).join('|');
  // The DEFAULT_SETTINGS keys are part of the stamp on purpose. The fast path
  // in ensureSpreadsheet_ skips topUpMissingSettings_, so if the stamp tracked
  // only table columns, a newly added default setting (FROM_ADDRESS was exactly
  // this case) would never be written to the sheet. Including the keys forces
  // one re-run whenever the defaults change.
  var settings = DEFAULT_SETTINGS.map(function(r){ return r[0]; }).sort().join(',');
  return tables + '||SETTINGS:' + settings;
}

/**
 * The sheet's REAL header row — the authority on column positions.
 *
 * DATA-INTEGRITY FIX. ensureSpreadsheet_ adds newly-declared columns at the END
 * of an existing sheet, but every read/write helper used to derive positions from
 * SCHEMA order instead. The moment a column was declared anywhere except the end
 * of a SCHEMA array, the two disagreed and every column after the insertion point
 * was read under the wrong name — silent, total corruption of that table.
 * Keying off the sheet makes column ORDER irrelevant: only names matter.
 */
var _HEADERS_CACHE = {};
function sheetHeaders_(name) {
  if (_HEADERS_CACHE[name]) return _HEADERS_CACHE[name];
  var sh = sh_(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var row = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h){ return String(h).trim(); });
  // Trim trailing blanks so we never write past the real header block.
  while (row.length && row[row.length - 1] === '') row.pop();
  if (!row.length) row = SCHEMA[name].slice();
  _HEADERS_CACHE[name] = row;
  return row;
}

function invalidateTableCache_(name) {
  // NOTE: _HEADERS_CACHE is deliberately NOT cleared here. Row-level writes
  // (append/update/delete) cannot change the header row, and clearing it made
  // every append re-read row 1 - reintroducing per-send I/O in bulk loops.
  // ensureSpreadsheet_ clears it explicitly on the only path that adds columns.
  if (name) delete _TABLE_CACHE[name]; else _TABLE_CACHE = {};
  if (name === 'SETTINGS' || !name) _SETTINGS_MAP = null;
  if (name === 'USERS' || !name) _ME_CACHE = null;
  // NOTE: _SENT_KEYS (Email.gs) is deliberately cleared ONLY on a full flush.
  // Every EMAIL_LOG append invalidates that table, and wiping the sent-key index
  // there would reintroduce the O(n^2) re-read it exists to prevent. sendEmail_
  // updates the index in place after each send instead.
  if (!name && typeof _SENT_KEYS !== 'undefined') _SENT_KEYS = null;
}

function ensureSpreadsheet_() {
  if (_SS_CACHE && _SCHEMA_OK) return _SS_CACHE;
  var ss = _SS_CACHE;
  if (!ss) {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty(SS_PROP_KEY);
    if (id) {
      try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
    }
    if (!ss) {
      ss = SpreadsheetApp.create('Crux Escalation Matrix — Datastore');
      props.setProperty(SS_PROP_KEY, ss.getId());
    }
    _SS_CACHE = ss;
  }
  if (!_SCHEMA_OK) {
    // Fast path: a previous execution already verified this exact schema.
    var sProps = PropertiesService.getScriptProperties();
    if (sProps.getProperty(SCHEMA_STAMP_KEY) === schemaStamp_()) {
      _SCHEMA_OK = true;
      return ss;
    }
    // Ensure every table exists with headers.
    Object.keys(SCHEMA).forEach(function(name) {
      var sh = ss.getSheetByName(name);
      var headers = SCHEMA[name];
      if (!sh) {
        sh = ss.insertSheet(name);
        sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
        sh.setFrozenRows(1);
      } else {
        var existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
        var missing = headers.filter(function(h){ return existing.indexOf(h) === -1; });
        if (missing.length) {
          var startCol = sh.getLastColumn() + 1;
          sh.getRange(1, startCol, 1, missing.length).setValues([missing]).setFontWeight('bold');
          // New columns land at the END of the sheet, which is fine because every
          // helper resolves positions by NAME via sheetHeaders_(). Drop the cached
          // header row so the new columns are picked up immediately.
          delete _HEADERS_CACHE[name];
          delete _TABLE_CACHE[name];
        }
      }
    });
    var extra = ss.getSheetByName('Sheet1');
    if (extra && extra.getLastRow() <= 1 && Object.keys(SCHEMA).indexOf('Sheet1') === -1) {
      try { ss.deleteSheet(extra); } catch (e) {}
    }
    seedSettingsIfEmpty_(ss);
    topUpMissingSettings_(ss);
    seedTemplatesIfEmpty_(ss);
    sProps.setProperty(SCHEMA_STAMP_KEY, schemaStamp_());
    _SCHEMA_OK = true;
  }
  return ss;
}

/**
 * Adds any DEFAULT_SETTINGS keys that are absent from the sheet, leaving every
 * existing Value untouched. seedSettingsIfEmpty_ only ever seeds a blank sheet,
 * so without this a newly-introduced setting would never appear in Admin >
 * Settings on an already-populated install. Safe to run repeatedly.
 */
function syncMissingSettings_() {
  var ss = ensureSpreadsheet_();
  var sh = ss.getSheetByName('SETTINGS');
  var have = {};
  readTable_('SETTINGS').forEach(function(r) { have[String(r.Key || '').trim()] = true; });
  var add = DEFAULT_SETTINGS.filter(function(r) { return !have[r[0]]; });
  if (!add.length) return { added: 0, keys: [] };
  var rows = add.map(function(r) { return [r[0], r[1], r[2], nowIso_(), 'system']; });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  invalidateTableCache_('SETTINGS');
  return { added: rows.length, keys: add.map(function(r) { return r[0]; }) };
}

/**
 * Append any DEFAULT_SETTINGS keys that are missing from an EXISTING sheet.
 *
 * seedSettingsIfEmpty_ only fires when SETTINGS is blank, so any key added to
 * DEFAULT_SETTINGS after go-live (e.g. FROM_ADDRESS) would never appear for an
 * install that already had rows — the admin can't configure a setting they can't
 * see. Existing values are never touched; only missing keys are appended.
 */
function topUpMissingSettings_(ss) {
  var sh = ss.getSheetByName('SETTINGS');
  if (!sh) return 0;
  var last = sh.getLastRow();
  var have = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function(r) {
      have[String(r[0] == null ? '' : r[0]).trim()] = true;
    });
  }
  var add = DEFAULT_SETTINGS
    .filter(function(r) { return !have[r[0]]; })
    .map(function(r) { return [r[0], r[1], r[2], nowIso_(), 'system']; });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add);
  // Newly written rows must drop the cached settings map, or getSetting_
  // keeps serving the pre-top-up view for the rest of this execution.
  if (add.length) invalidateTableCache_('SETTINGS');
  return add.length;
}

function seedSettingsIfEmpty_(ss) {
  var sh = ss.getSheetByName('SETTINGS');
  if (sh.getLastRow() > 1) return;
  var rows = DEFAULT_SETTINGS.map(function(r) { return [r[0], r[1], r[2], nowIso_(), 'system']; });
  sh.getRange(2, 1, rows.length, 5).setValues(rows);
}

function seedTemplatesIfEmpty_(ss) {
  var sh = ss.getSheetByName('EMAIL_TEMPLATES');
  if (sh.getLastRow() > 1) return;
  var rows = DEFAULT_TEMPLATES.map(function(r){ return [r[0], r[1], r[2], nowIso_(), 'system']; });
  sh.getRange(2, 1, rows.length, 5).setValues(rows);
}

/* -----------------------------------------------------------
 * Generic table helpers
 * ----------------------------------------------------------- */

function sh_(name) {
  var ss = ensureSpreadsheet_();
  return ss.getSheetByName(name);
}

function readTable_(name) {
  if (_TABLE_CACHE[name]) return _TABLE_CACHE[name];
  var sh = sh_(name);
  var last = sh.getLastRow();
  if (last < 2) { _TABLE_CACHE[name] = []; return []; }
  var headers = sheetHeaders_(name);
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var out = values.map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  }).filter(function(o){
    return Object.keys(o).some(function(k){ return o[k] !== '' && o[k] !== null; });
  });
  _TABLE_CACHE[name] = out;
  return out;
}

function appendRow_(name, obj) {
  var sh = sh_(name);
  var headers = sheetHeaders_(name);
  var row = headers.map(function(h){ return obj[h] === undefined ? '' : obj[h]; });
  sh.appendRow(row);
  invalidateTableCache_(name);
  return obj;
}

/**
 * Bulk append. ONE setValues() call instead of N appendRow_() calls.
 * Planning 500 queue rows this way takes seconds; 500 appendRow_ calls would
 * consume the 6-minute execution limit on their own.
 */
function appendRows_(name, objs) {
  var rows = (objs || []);
  if (!rows.length) return 0;
  var sh = sh_(name);
  var headers = sheetHeaders_(name);
  var values = rows.map(function(obj) {
    return headers.map(function(h){ return obj[h] === undefined ? '' : obj[h]; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
  invalidateTableCache_(name);
  return values.length;
}

/**
 * Bulk patch by id: reads the sheet once and writes once, instead of a full
 * read + write per row as updateRowById_ does. `patches` is { idValue: patch }.
 */
function updateRowsById_(name, idField, patches) {
  var keys = Object.keys(patches || {});
  if (!keys.length) return 0;
  var sh = sh_(name);
  var headers = sheetHeaders_(name);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var idCol = headers.indexOf(idField);
  if (idCol < 0) throw new Error('updateRowsById_: unknown id field ' + idField);
  var range = sh.getRange(2, 1, last - 1, headers.length);
  var values = range.getValues();
  var changed = 0;
  for (var r = 0; r < values.length; r++) {
    var id = String(values[r][idCol]);
    if (!Object.prototype.hasOwnProperty.call(patches, id)) continue;
    var patch = patches[id];
    for (var h = 0; h < headers.length; h++) {
      if (patch[headers[h]] !== undefined) values[r][h] = patch[headers[h]];
    }
    changed++;
  }
  if (changed) {
    range.setValues(values);
    invalidateTableCache_(name);
  }
  return changed;
}

function updateRowById_(name, idField, idValue, patch) {
  var sh = sh_(name);
  var headers = sheetHeaders_(name);
  var idCol = headers.indexOf(idField) + 1;
  if (idCol < 1) throw new Error('unknown id column ' + idField);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var ids = sh.getRange(2, idCol, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idValue)) {
      var rowNum = i + 2;
      var current = sh.getRange(rowNum, 1, 1, headers.length).getValues()[0];
      var merged = headers.map(function(h, j){
        if (patch.hasOwnProperty(h)) return patch[h];
        return current[j];
      });
      sh.getRange(rowNum, 1, 1, headers.length).setValues([merged]);
      invalidateTableCache_(name);
      var obj = {};
      headers.forEach(function(h, j){ obj[h] = merged[j]; });
      return obj;
    }
  }
  return null;
}

function findRowById_(name, idField, idValue) {
  var rows = readTable_(name);
  for (var i = 0; i < rows.length; i++) if (String(rows[i][idField]) === String(idValue)) return rows[i];
  return null;
}

function deleteRowById_(name, idField, idValue) {
  var sh = sh_(name);
  var headers = sheetHeaders_(name);
  var idCol = headers.indexOf(idField) + 1;
  var last = sh.getLastRow();
  if (last < 2) return false;
  var ids = sh.getRange(2, idCol, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idValue)) {
      sh.deleteRow(i + 2);
      invalidateTableCache_(name);
      return true;
    }
  }
  return false;
}

/** SETTINGS helpers. Reads are hot — use a per-execution map cache. */
/**
 * SAFETY FIX: booleans in SETTINGS are typed by humans. `=== 'true'` meant a
 * cell containing TRUE / True / Yes / 1 read as FALSE — so an admin could
 * "enable" DRY_RUN and still blast real client mailboxes. Always route boolean
 * settings through this.
 */
function getBoolSetting_(key, dflt) {
  var raw = getSetting_(key, dflt == null ? 'false' : String(dflt));
  var v = String(raw).trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === 'y' || v === '1' || v === 'on';
}

function getSetting_(key, dflt) {
  if (!_SETTINGS_MAP) {
    _SETTINGS_MAP = {};
    readTable_('SETTINGS').forEach(function(r){ _SETTINGS_MAP[r.Key] = r.Value; });
  }
  var v = _SETTINGS_MAP[key];
  if (v === undefined || v === '' || v === null) return dflt;
  return String(v);
}

function setSetting_(key, value, user) {
  var existing = findRowById_('SETTINGS', 'Key', key);
  if (existing) {
    return updateRowById_('SETTINGS', 'Key', key, { Value: value, UpdatedAt: nowIso_(), UpdatedBy: user || 'system' });
  }
  return appendRow_('SETTINGS', { Key: key, Value: value, Description: '', UpdatedAt: nowIso_(), UpdatedBy: user || 'system' });
}

function getAllSettings_() {
  return readTable_('SETTINGS');
}

function saveSettings_(payload, me) {
  var updates = payload.updates || [];
  updates.forEach(function(u) { setSetting_(u.Key, u.Value, me.email); });
  logAudit_({ user: me.email, action: 'SETTINGS_SAVE', entity: 'SETTINGS', entityId: '', oldValue: '', newValue: JSON.stringify(updates) });
  return { ok: true };
}

function getTemplates_() { return readTable_('EMAIL_TEMPLATES'); }
function saveTemplates_(payload, me) {
  var items = payload.items || [];
  items.forEach(function(t) {
    var existing = findRowById_('EMAIL_TEMPLATES', 'Key', t.Key);
    if (existing) updateRowById_('EMAIL_TEMPLATES', 'Key', t.Key, { Subject: t.Subject, Body: t.Body, UpdatedAt: nowIso_(), UpdatedBy: me.email });
    else appendRow_('EMAIL_TEMPLATES', { Key: t.Key, Subject: t.Subject, Body: t.Body, UpdatedAt: nowIso_(), UpdatedBy: me.email });
  });
  logAudit_({ user: me.email, action: 'TEMPLATE_SAVE', entity: 'EMAIL_TEMPLATES', entityId: '', oldValue: '', newValue: JSON.stringify(items.map(function(i){return i.Key;})) });
  return { ok: true };
}

function listHolidays_() { return readTable_('HOLIDAYS'); }
function saveHolidays_(payload, me) {
  var items = payload.items || [];
  // Simple approach: clear & rewrite. Small table, admin-only.
  var sh = sh_('HOLIDAYS');
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, SCHEMA.HOLIDAYS.length).clearContent();
  invalidateTableCache_('HOLIDAYS');
  items.forEach(function(h) {
    appendRow_('HOLIDAYS', {
      HolidayID: h.HolidayID || nextId_('HOL'),
      Date: h.Date, Name: h.Name || '',
      Status: h.Status || 'ACTIVE',
      CreatedAt: h.CreatedAt || nowIso_()
    });
  });
  logAudit_({ user: me.email, action: 'HOLIDAYS_SAVE', entity: 'HOLIDAYS', entityId: '', oldValue: '', newValue: String(items.length) });
  return { ok: true, count: items.length };
}

function logAudit_(o) {
  appendRow_('AUDIT_LOG', {
    LogID: nextId_('AUD'),
    Timestamp: nowIso_(),
    User: o.user || '',
    Action: o.action || '',
    Entity: o.entity || '',
    EntityID: o.entityId || '',
    OldValue: o.oldValue || '',
    NewValue: o.newValue || ''
  });
}

/**
 * Logs are scoped. The full trail belongs to an administrator: it spans every
 * client, every recipient and every action in the business. Anyone else sees only
 * the rows that are about them - their own actions, and mail addressed to them.
 * These functions previously took no `me` at all, so a MANAGER opening the Logs
 * tab was served every email the tool had ever sent.
 */
function scopeLogRows_(rows, me, fields) {
  if (!me || String(me.role) === 'ADMIN') return rows;
  var mine = String(me.email || '').trim().toLowerCase();
  if (!mine) return [];
  return rows.filter(function(r) {
    for (var i = 0; i < fields.length; i++) {
      var v = String(r[fields[i]] == null ? '' : r[fields[i]]).toLowerCase();
      // ToAddr and Cc can hold several addresses, so match on containment.
      if (v && v.indexOf(mine) !== -1) return true;
    }
    return false;
  });
}

function queryEmailLog_(p, me) {
  var rows = readTable_('EMAIL_LOG');
  rows = scopeLogRows_(rows, me, ['ToAddr','Cc','Bcc','SentBy']);
  rows = applyLogFilters_(rows, p && p.filters);
  return paginate_(rows, p);
}
function queryAuditLog_(p, me) {
  var rows = readTable_('AUDIT_LOG');
  rows = scopeLogRows_(rows, me, ['User']);
  rows = applyLogFilters_(rows, p && p.filters);
  return paginate_(rows, p);
}
function queryReminderLog_(p, me) {
  var rows = readTable_('REMINDER_LOG');
  rows = scopeLogRows_(rows, me, ['ToAddr','Cc','PersonEmail','User']);
  rows = applyLogFilters_(rows, p && p.filters);
  return paginate_(rows, p);
}

/**
 * Rich filter for log tables. Recognised keys:
 *   dateFrom / dateTo — YYYY-MM-DD, compared against the row's timestamp field.
 *   Status            — exact match (SENT / FAILED / …).
 *   Any other key     — substring match against the same column name.
 */
function applyLogFilters_(rows, f) {
  if (!f) return rows;
  var dateFrom = f.dateFrom || '';
  var dateTo = f.dateTo || '';
  var status = f.Status || '';
  var timeField = rows.length && (rows[0].Timestamp !== undefined ? 'Timestamp' : (rows[0].ExecutedAt !== undefined ? 'ExecutedAt' : ''));
  return rows.filter(function(r) {
    if (dateFrom && timeField) {
      var ts = String(r[timeField] || '').slice(0, 10);
      if (ts < dateFrom) return false;
    }
    if (dateTo && timeField) {
      var ts2 = String(r[timeField] || '').slice(0, 10);
      if (ts2 > dateTo) return false;
    }
    if (status && String(r.Status || r.Result || '') !== status) return false;
    return Object.keys(f).every(function(k) {
      if (['dateFrom','dateTo','Status'].indexOf(k) !== -1) return true;
      var v = f[k];
      if (v === '' || v == null) return true;
      return String(r[k] || '').toLowerCase().indexOf(String(v).toLowerCase()) !== -1;
    });
  });
}

/**
 * Server-side CSV export. Admins/managers can pull whole logs for month-end reporting.
 * payload: { table: 'EMAIL_LOG'|'AUDIT_LOG'|'REMINDER_LOG'|'ESCALATIONS'|'CLIENTS'|'BRANCHES', filters?: {} }
 * Returns { filename, mime, dataBase64 }
 */
function exportCsv_(payload) {
  var table = payload && payload.table;
  if (!SCHEMA[table]) throw ValidationError_('Unknown table: ' + table);
  var rows = readTable_(table);
  if (payload && payload.filters) {
    // Log-shaped filters (date range + status) for log tables; substring for others.
    if (['EMAIL_LOG','AUDIT_LOG','REMINDER_LOG'].indexOf(table) !== -1) rows = applyLogFilters_(rows, payload.filters);
    else rows = applyFilters_(rows, payload.filters);
  }
  var headers = SCHEMA[table];
  var lines = [headers.map(csvCell_).join(',')];
  rows.forEach(function(r){ lines.push(headers.map(function(h){ return csvCell_(r[h]); }).join(',')); });
  var csv = lines.join('\r\n');
  var stamp = Utilities.formatDate(new Date(), getTz_(), 'yyyyMMdd-HHmm');
  return {
    filename: table.toLowerCase() + '-' + stamp + '.csv',
    mime: 'text/csv',
    dataBase64: Utilities.base64Encode(csv, Utilities.Charset.UTF_8),
    rowCount: rows.length
  };
}

function csvCell_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s.indexOf('"') !== -1) s = s.replace(/"/g, '""');
  if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) s = '"' + s + '"';
  return s;
}