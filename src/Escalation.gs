/**
 * Escalation.gs — LOG and RAISE escalation flows.
 */

var ESCALATION_STATUSES = ['OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED','EXCEPTION'];
/** Dispositions that stop the clock — excluded from "overdue" and from ageing. */
var ESCALATION_TERMINAL = ['RESOLVED','CLOSED','EXCEPTION'];
/** Only these roles may excuse a complaint. MANAGER can update but NOT excuse. */
var EXCEPTION_ROLES = ['ADMIN','LOCATION_HEAD'];

/**
 * Row-level scoping for complaints. Shared by the list view and the MIS so the
 * two can never disagree about what a Location Head is allowed to see.
 *
 * PERF: this used to call findRowById_('CLIENTS', ...) INSIDE the filter — a
 * full CLIENTS scan per escalation, i.e. O(n*m). The client index is now built
 * once. Same bug class as the EMAIL_LOG re-read in sendEmail_.
 */
function scopeEscalations_(rows, me, clients) {
  // ADMIN sees everything. Everyone else sees only what is theirs: assigned to
  // them, created by them, raised against them, or belonging to a client they
  // own. Previously only LOCATION_HEAD was filtered, so a scoped MANAGER or
  // VIEWER still saw every escalation in the business.
  if (me.role === 'ADMIN') return rows;
  var mine = String(me.email).toLowerCase();
  return rows.filter(function(e) {
    if (String(e.AssignedOwner || '').toLowerCase() === mine) return true;
    if (String(e.CreatedBy || '').toLowerCase() === mine) return true;
    // Raised AGAINST me: it is my escalation to answer, so I must see it even
    // when the client sits outside my scope.
    if (String(e.AgainstEmail || '').toLowerCase() === mine) return true;
    var c = clients[e.ClientID];
    return !!(c && String(c.DefaultLocationHead || '').toLowerCase() === mine);
  });
}

function clientIndex_() {
  var idx = {};
  readTable_('CLIENTS').forEach(function(c){ idx[c.ClientID] = c; });
  return idx;
}

function listEscalations_(p, me) {
  var clients = clientIndex_();
  var rows = scopeEscalations_(readTable_('ESCALATIONS'), me, clients);
  rows = rows.map(function(r){
    return Object.assign({}, r, { ClientName: (clients[r.ClientID] || {}).ClientName || r.ClientID });
  });
  rows = applyFilters_(rows, p && p.filters);
  return paginate_(rows, p);
}

function logEscalationCase_(payload, me) {
  var e = payload || {};
  if (!req_(e.ClientID)) throw ValidationError_('Client is required.');
  var c = findRowById_('CLIENTS','ClientID', e.ClientID);
  if (!c) throw ValidationError_('Invalid client.');
  var row = {
    EscalationID: nextId_('ESC'), Type: 'LOGGED',
    Date: e.Date || ymd_(new Date()), Time: e.Time || Utilities.formatDate(new Date(), getTz_(), 'HH:mm'),
    ClientID: e.ClientID, BranchID: e.BranchID || '',
    BranchCode: e.BranchCode || '',
    ContactName: e.ContactName || '', ContactPhone: e.ContactPhone || '',
    Category: e.Category || 'Service',
    Severity: e.Severity || 'Medium',
    EscalatedAgainst: e.EscalatedAgainst || '',
    AgainstEmail: resolveAgainstEmail_(e),
    Description: e.Description || '',
    AssignedOwner: (e.AssignedOwner || c.DefaultLocationHead || me.email).toLowerCase(),
    RequiredAction: e.RequiredAction || '', TargetDate: e.TargetDate || '',
    Status: 'OPEN', ClosureDate: '', ClosureRemarks: '',
    CreatedBy: me.email, CreatedAt: nowIso_(), UpdatedAt: nowIso_()
  };
  appendRow_('ESCALATIONS', row);
  appendRow_('ESCALATION_HISTORY', {
    HistoryID: nextId_('EHI'), EscalationID: row.EscalationID, Timestamp: nowIso_(),
    User: me.email, Field: 'CREATE', OldValue: '', NewValue: 'LOGGED', Note: ''
  });
  logAudit_({ user: me.email, action: 'ESCALATION_LOG', entity: 'ESCALATIONS', entityId: row.EscalationID, oldValue: '', newValue: JSON.stringify(row) });
  return row;
}

function raiseEscalationCase_(payload, me) {
  var e = payload || {};
  if (!req_(e.ClientID)) throw ValidationError_('Client is required.');
  var c = findRowById_('CLIENTS','ClientID', e.ClientID);
  if (!c) throw ValidationError_('Invalid client.');
  var to = parseListStr_(e.To);
  if (to.length === 0 || !to.every(isEmail_)) throw ValidationError_('At least one valid recipient (TO) is required.');
  var cc = parseListStr_(e.Cc).filter(isEmail_);
  var row = {
    EscalationID: nextId_('ESC'), Type: 'RAISED',
    Date: ymd_(new Date()), Time: Utilities.formatDate(new Date(), getTz_(), 'HH:mm'),
    ClientID: e.ClientID, BranchID: e.BranchID || '',
    BranchCode: e.BranchCode || '',
    ContactName: '', ContactPhone: '',
    Category: e.Category || 'General',
    Severity: e.Severity || 'Medium',
    EscalatedAgainst: e.PersonConcerned || '',
    AgainstEmail: resolveAgainstEmail_(e),
    Description: e.Details || '',
    AssignedOwner: me.email,
    RequiredAction: e.RequiredResolution || '', TargetDate: e.DueDate || '',
    Status: 'OPEN', ClosureDate: '', ClosureRemarks: '',
    CreatedBy: me.email, CreatedAt: nowIso_(), UpdatedAt: nowIso_()
  };
  appendRow_('ESCALATIONS', row);
  appendRow_('ESCALATION_HISTORY', {
    HistoryID: nextId_('EHI'), EscalationID: row.EscalationID, Timestamp: nowIso_(),
    User: me.email, Field: 'CREATE', OldValue: '', NewValue: 'RAISED', Note: ''
  });
  // Send the formal email now (logged automatically).
  var tpl = getTemplate_('RAISE_ESCALATION');
  var table = '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' +
    kv_('Client', c.ClientName) + kv_('Branch Code', row.BranchCode) +
    kv_('Category', row.Category) + kv_('Severity', row.Severity) +
    kv_('Person/Team', row.EscalatedAgainst) + kv_('Details', row.Description) + '</table>';
  var vars = {
    CLIENT_NAME: c.ClientName, BRANCH_CODE: row.BranchCode,
    CATEGORY: row.Category, ESCALATION_TABLE: table,
    REQUIRED_RESOLUTION: row.RequiredAction, DUE_DATE: row.TargetDate,
    SIGNATURE: getSetting_('SIGNATURE','')
  };
  var res = sendEmail_({
    type: 'RAISED_ESCALATION', clientId: c.ClientID,
    to: to, cc: cc, subject: renderTemplate_(tpl.Subject, vars),
    htmlBody: renderTemplate_(tpl.Body, vars),
    trigger: 'escalations.raise',
    idempotencyKey: 'ESC-' + row.EscalationID,
    attachments: e.Attachments || []
  });
  logAudit_({ user: me.email, action: 'ESCALATION_RAISE', entity: 'ESCALATIONS', entityId: row.EscalationID, oldValue: '', newValue: JSON.stringify({ to: to, cc: cc, emailStatus: res.status, attachments: (e.Attachments||[]).length }) });
  return { escalation: row, email: res };
}

function updateEscalationCase_(payload, me) {
  var e = findRowById_('ESCALATIONS','EscalationID', payload.EscalationID);
  if (!e) throw ValidationError_('Escalation not found.');
  var patch = {};
  ['Status','AssignedOwner','RequiredAction','TargetDate','ClosureDate','ClosureRemarks','Severity','Category','Description'].forEach(function(k){
    if (payload[k] !== undefined) patch[k] = payload[k];
  });
  if (patch.Status && ESCALATION_STATUSES.indexOf(patch.Status) === -1) throw ValidationError_('Invalid status.');
  // An exception is a governed act: it needs a reason and a named approver, so it
  // must go through grantEscalationException_ and cannot be set by a plain update.
  if (patch.Status === 'EXCEPTION') {
    throw ValidationError_('Use "Grant exception" to excuse a complaint — it requires a reason and an approver.');
  }
  if (String(e.Status) === 'EXCEPTION' && patch.Status && patch.Status !== 'EXCEPTION') {
    throw ValidationError_('This complaint is under exception. Revoke the exception before changing its status.');
  }
  patch.UpdatedAt = nowIso_();
  updateRowById_('ESCALATIONS','EscalationID', e.EscalationID, patch);
  Object.keys(patch).forEach(function(k){
    if (k === 'UpdatedAt') return;
    appendRow_('ESCALATION_HISTORY', {
      HistoryID: nextId_('EHI'), EscalationID: e.EscalationID, Timestamp: nowIso_(),
      User: me.email, Field: k, OldValue: String(e[k] || ''), NewValue: String(patch[k] || ''), Note: ''
    });
  });
  logAudit_({ user: me.email, action: 'ESCALATION_UPDATE', entity: 'ESCALATIONS', entityId: e.EscalationID, oldValue: JSON.stringify(e), newValue: JSON.stringify(patch) });
  // A genuine response resets the strike clock. Deliberately NOT tied to
  // UpdatedAt, which moves on any write and would let an escalation be nudged
  // forever without ever striking.
  touchActivity_(String(p.EscalationID || p.escalationId || ''), me.email,
    'Updated by ' + me.email + '.');
  return Object.assign({}, e, patch);
}

function kv_(k, v) {
  return '<tr><td style="border:1px solid #d0d7de;background:#f6f8fa"><b>' + escHtml_(k) + '</b></td>' +
         '<td style="border:1px solid #d0d7de">' + escHtml_(v || '') + '</td></tr>';
}

/* ===================================================================
 * COMPLAINT EXCEPTIONS + MIS
 *
 * NOTE ON TERMINOLOGY — the tool uses "escalation" for two unrelated things:
 *   1. ESCALATION_MATRIX  — the 5-level contact directory per branch, kept
 *                           current monthly and dispatched to clients.
 *   2. ESCALATIONS        — actual complaints raised and logged against a
 *                           party. THIS section is about (2) only.
 * An exception excuses a COMPLAINT. It is not a waiver of the matrix
 * requirement and has nothing to do with the monthly dispatch.
 * =================================================================== */

/**
 * Excuse a complaint. Requires a reason and is restricted to ADMIN /
 * LOCATION_HEAD. The complaint stays on the record — an exception is a visible
 * disposition, never a delete — and it is excluded from overdue and ageing.
 */
function grantEscalationException_(payload, me) {
  if (EXCEPTION_ROLES.indexOf(me.role) === -1) {
    throw AuthError_('Only an Admin or Location Head can grant an exception.');
  }
  var reason = String((payload && payload.reason) || '').trim();
  if (reason.length < 10) {
    throw ValidationError_('Give a reason of at least 10 characters. The reason is the record.');
  }
  var e = findRowById_('ESCALATIONS', 'EscalationID', payload.EscalationID);
  if (!e) throw ValidationError_('Complaint not found.');
  if (String(e.Status) === 'EXCEPTION') throw ValidationError_('This complaint is already under exception.');

  // A Location Head may only excuse complaints inside their own scope.
  var scoped = scopeEscalations_([e], me, clientIndex_());
  if (!scoped.length) throw AuthError_('This complaint is outside your scope.');

  var patch = {
    Status: 'EXCEPTION',
    ExceptionBy: me.email, ExceptionAt: nowIso_(), ExceptionReason: reason,
    UpdatedAt: nowIso_()
  };
  updateRowById_('ESCALATIONS', 'EscalationID', e.EscalationID, patch);
  appendRow_('ESCALATION_HISTORY', {
    HistoryID: nextId_('EHI'), EscalationID: e.EscalationID, Timestamp: nowIso_(),
    User: me.email, Field: 'Status', OldValue: String(e.Status || ''), NewValue: 'EXCEPTION',
    Note: 'Exception granted: ' + reason
  });
  logAudit_({ user: me.email, action: 'ESCALATION_EXCEPTION_GRANT', entity: 'ESCALATIONS',
    entityId: e.EscalationID, oldValue: String(e.Status || ''), newValue: JSON.stringify(patch) });
  return Object.assign({}, e, patch);
}

/** Undo an exception granted in error. Same roles; the trail is kept. */
function revokeEscalationException_(payload, me) {
  if (EXCEPTION_ROLES.indexOf(me.role) === -1) {
    throw AuthError_('Only an Admin or Location Head can revoke an exception.');
  }
  var e = findRowById_('ESCALATIONS', 'EscalationID', payload.EscalationID);
  if (!e) throw ValidationError_('Complaint not found.');
  if (String(e.Status) !== 'EXCEPTION') throw ValidationError_('This complaint is not under exception.');
  var scoped = scopeEscalations_([e], me, clientIndex_());
  if (!scoped.length) throw AuthError_('This complaint is outside your scope.');
  var note = String((payload && payload.reason) || '').trim();

  var patch = {
    Status: payload.restoreTo && ESCALATION_STATUSES.indexOf(payload.restoreTo) !== -1
      ? payload.restoreTo : 'OPEN',
    ExceptionBy: '', ExceptionAt: '', ExceptionReason: '', UpdatedAt: nowIso_()
  };
  updateRowById_('ESCALATIONS', 'EscalationID', e.EscalationID, patch);
  appendRow_('ESCALATION_HISTORY', {
    HistoryID: nextId_('EHI'), EscalationID: e.EscalationID, Timestamp: nowIso_(),
    User: me.email, Field: 'Status', OldValue: 'EXCEPTION', NewValue: patch.Status,
    Note: 'Exception revoked' + (note ? ': ' + note : '') +
          ' (was: ' + String(e.ExceptionReason || '') + ')'
  });
  logAudit_({ user: me.email, action: 'ESCALATION_EXCEPTION_REVOKE', entity: 'ESCALATIONS',
    entityId: e.EscalationID, oldValue: JSON.stringify({ reason: e.ExceptionReason }), newValue: JSON.stringify(patch) });
  return Object.assign({}, e, patch);
}

function daysBetween_(fromIso, to) {
  var d = new Date(fromIso);
  if (isNaN(d.getTime())) return null;
  return Math.floor((to.getTime() - d.getTime()) / 86400000);
}

function bump_(obj, key) { key = key || '(none)'; obj[key] = (obj[key] || 0) + 1; return obj; }

/**
 * Complaint MIS. Returns headline counts, breakdowns, ageing buckets, the
 * overdue list and the exception register — all inside the caller's scope, so a
 * Location Head sees only their own clients.
 *
 * payload: { from:'YYYY-MM-DD', to:'YYYY-MM-DD', clientId, branchId, category, severity }
 */
function escalationMIS_(payload, me) {
  var p = payload || {};
  var now = new Date();
  var clients = clientIndex_();
  var branches = {};
  readTable_('BRANCHES').forEach(function(b){ branches[b.BranchID] = b; });

  var rows = scopeEscalations_(readTable_('ESCALATIONS'), me, clients);

  // Filters
  if (p.from) rows = rows.filter(function(e){ return String(e.CreatedAt || e.Date || '') >= String(p.from); });
  if (p.to)   rows = rows.filter(function(e){ return String(e.CreatedAt || e.Date || '') <= String(p.to) + '\uffff'; });
  ['ClientID','BranchID','Category','Severity','Status'].forEach(function(f) {
    var key = f.charAt(0).toLowerCase() + f.slice(1);
    if (p[key]) rows = rows.filter(function(e){ return String(e[f]) === String(p[key]); });
  });

  var byStatus = {}, bySeverity = {}, byCategory = {}, byClient = {}, byOwner = {};
  var ageing = { '0-7': 0, '8-15': 0, '16-30': 0, '30+': 0 };
  var overdue = [], exceptions = [];
  var openCount = 0, closedCount = 0, exceptionCount = 0;
  var resolutionDays = [];
  var todayStr = Utilities.formatDate(now, getTz_(), 'yyyy-MM-dd');

  rows.forEach(function(e) {
    var status = String(e.Status || 'OPEN');
    bump_(byStatus, status);
    bump_(bySeverity, e.Severity);
    bump_(byCategory, e.Category);
    bump_(byClient, (clients[e.ClientID] || {}).ClientName || e.ClientID);
    bump_(byOwner, e.AssignedOwner);

    var terminal = ESCALATION_TERMINAL.indexOf(status) !== -1;
    if (status === 'EXCEPTION') {
      exceptionCount++;
      exceptions.push({
        EscalationID: e.EscalationID, ClientName: (clients[e.ClientID] || {}).ClientName || e.ClientID,
        BranchCode: e.BranchCode || (branches[e.BranchID] || {}).BranchCode || '',
        Category: e.Category, Severity: e.Severity, Description: e.Description,
        ExceptionBy: e.ExceptionBy, ExceptionAt: e.ExceptionAt, ExceptionReason: e.ExceptionReason
      });
    } else if (terminal) {
      closedCount++;
      var rd = daysBetween_(e.CreatedAt || e.Date, new Date(e.ClosureDate || e.UpdatedAt || now));
      if (rd !== null && rd >= 0) resolutionDays.push(rd);
    } else {
      openCount++;
      var age = daysBetween_(e.CreatedAt || e.Date, now);
      if (age !== null) {
        if (age <= 7) ageing['0-7']++;
        else if (age <= 15) ageing['8-15']++;
        else if (age <= 30) ageing['16-30']++;
        else ageing['30+']++;
      }
      if (e.TargetDate && String(e.TargetDate) < todayStr) {
        overdue.push({
          EscalationID: e.EscalationID, ClientName: (clients[e.ClientID] || {}).ClientName || e.ClientID,
          BranchCode: e.BranchCode || (branches[e.BranchID] || {}).BranchCode || '',
          Category: e.Category, Severity: e.Severity, Status: status,
          AssignedOwner: e.AssignedOwner, TargetDate: e.TargetDate,
          daysOverdue: daysBetween_(e.TargetDate, now), ageDays: age,
          Description: e.Description
        });
      }
    }
  });

  overdue.sort(function(a, b){ return (b.daysOverdue || 0) - (a.daysOverdue || 0); });
  var avgRes = resolutionDays.length
    ? Math.round(resolutionDays.reduce(function(a, b){ return a + b; }, 0) / resolutionDays.length * 10) / 10
    : null;

  return {
    generatedAt: nowIso_(),
    scope: me.role === 'LOCATION_HEAD' ? 'your clients only' : 'all clients',
    filters: p,
    headline: {
      total: rows.length, open: openCount, closed: closedCount,
      exception: exceptionCount, overdue: overdue.length,
      avgResolutionDays: avgRes
    },
    ageing: ageing,
    byStatus: byStatus, bySeverity: bySeverity, byCategory: byCategory,
    byClient: byClient, byOwner: byOwner,
    overdue: overdue.slice(0, 200),
    exceptions: exceptions.slice(0, 200),
    canGrantException: EXCEPTION_ROLES.indexOf(me.role) !== -1
  };
}
/* ==================================================================
 * DIRECTORY SUGGEST - powers the type-ahead on "Person / team concerned".
 * Reads the live USERS and BRANCHES tables, so newly added people appear
 * immediately with no extra configuration.
 *
 * Typing "Pu" returns the Pune branch/location AND the people attached to it,
 * because a name is rarely what the person raising an escalation remembers.
 * ================================================================== */
function directorySuggest_(payload, me) {
  var q = String((payload && payload.q) || '').trim().toLowerCase();
  if (q.length < 1) return { items: [] };
  var hit = function() {
    for (var i = 0; i < arguments.length; i++) {
      if (String(arguments[i] || '').toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  };
  var items = [], seen = {};
  var push = function(it) {
    var k = it.kind + '|' + (it.email || it.label);
    if (seen[k]) return;
    seen[k] = true; items.push(it);
  };

  var branches = readTable_('BRANCHES').filter(function(b){ return b.Status !== 'INACTIVE'; });
  var matchedBranches = branches.filter(function(b){
    return hit(b.BranchName, b.BranchCode, b.Location, b.Zone);
  });

  // 1. People matched by their own details.
  readTable_('USERS').filter(function(u){ return u.Status === 'ACTIVE'; }).forEach(function(u) {
    if (hit(u.Name, u.Email, u.Designation, u.ScopeZones, u.ScopeLocations)) {
      push({ kind:'USER', label: u.Name || u.Email, email: u.Email,
             sub: (u.Designation || u.Role || '') });
    }
  });

  // 2. Places matched, plus the people attached to them.
  matchedBranches.forEach(function(b) {
    push({ kind:'BRANCH', label: b.BranchName, email: b.BranchManagerEmail || b.CruxPOCEmail || '',
           sub: [b.BranchCode, b.Location, b.Zone].filter(Boolean).join(' \u00b7 '), branchId: b.BranchID });
    if (isEmail_(b.BranchManagerEmail)) {
      push({ kind:'USER', label: b.BranchManagerName || b.BranchManagerEmail,
             email: b.BranchManagerEmail, sub: 'Branch Manager \u00b7 ' + (b.BranchName || '') });
    }
    if (isEmail_(b.CruxPOCEmail)) {
      push({ kind:'USER', label: b.CruxPOCName || b.CruxPOCEmail,
             email: b.CruxPOCEmail, sub: 'Crux POC \u00b7 ' + (b.BranchName || '') });
    }
  });

  // 3. Distinct locations and zones as their own suggestions.
  var locs = {}, zones = {};
  branches.forEach(function(b) {
    if (b.Location && hit(b.Location)) locs[b.Location] = true;
    if (b.Zone && hit(b.Zone)) zones[b.Zone] = true;
  });
  Object.keys(locs).forEach(function(l){ push({ kind:'LOCATION', label: l, sub:'Location', email:'' }); });
  Object.keys(zones).forEach(function(z){ push({ kind:'ZONE', label: z, sub:'Zone', email:'' }); });

  // 4. People whose scope covers a matched location or zone.
  readTable_('USERS').filter(function(u){ return u.Status === 'ACTIVE'; }).forEach(function(u) {
    var mine = parseListStr_(u.ScopeLocations).concat(parseListStr_(u.ScopeZones))
      .map(function(v){ return String(v).trim().toLowerCase(); });
    var covers = Object.keys(locs).concat(Object.keys(zones)).some(function(v){
      return mine.indexOf(String(v).toLowerCase()) !== -1;
    });
    if (covers) push({ kind:'USER', label: u.Name || u.Email, email: u.Email,
                       sub: (u.Designation || u.Role || '') + ' \u00b7 covers this area' });
  });

  var order = { USER:0, BRANCH:1, LOCATION:2, ZONE:3 };
  items.sort(function(a,b){ return (order[a.kind]||9) - (order[b.kind]||9); });
  return { items: items.slice(0, 12) };
}
/**
 * Resolve WHO an escalation is against to a real email address.
 *
 * Server-side on purpose: the form only has to capture a name, and any caller
 * (UI, import, API) gets the same resolution. Without an email the three-strike
 * chase has nobody to chase, and the escalation cannot show up in that person's
 * own view - so this is the link that makes ownership work.
 */
function resolveAgainstEmail_(p) {
  p = p || {};
  if (isEmail_(p.AgainstEmail)) return String(p.AgainstEmail).trim().toLowerCase();
  var label = String(p.AgainstName || p.EscalatedAgainst || p.PersonConcerned || p.person || '').trim();
  if (!label) return '';
  if (isEmail_(label)) return label.toLowerCase();
  var low = label.toLowerCase();
  var users = readTable_('USERS').filter(function(u){ return u.Status === 'ACTIVE'; });
  var exact = users.filter(function(u){
    return String(u.Name || '').trim().toLowerCase() === low
        || String(u.Email || '').trim().toLowerCase() === low;
  })[0];
  if (exact && isEmail_(exact.Email)) return String(exact.Email).toLowerCase();
  // A single unambiguous partial match is safe; two or more is not, so leave it
  // blank rather than chase the wrong person.
  var partial = users.filter(function(u){
    return String(u.Name || '').toLowerCase().indexOf(low) !== -1;
  });
  if (partial.length === 1 && isEmail_(partial[0].Email)) return String(partial[0].Email).toLowerCase();
  // Branch manager of a named branch.
  var br = readTable_('BRANCHES').filter(function(b){
    return String(b.BranchName || '').trim().toLowerCase() === low
        || String(b.BranchCode || '').trim().toLowerCase() === low;
  })[0];
  if (br && isEmail_(br.BranchManagerEmail)) return String(br.BranchManagerEmail).toLowerCase();
  return '';
}
/** Warnings register. A Location Head sees only their own people's records. */
function listWarnings_(p, me) {
  var rows = readTable_('WARNINGS');
  if (me.role !== 'ADMIN') {
    var clients = clientIndex_();
    var mine = String(me.email).toLowerCase();
    var scoped = scopeEscalations_(readTable_('ESCALATIONS'), me, clients);
    var allowed = {};
    scoped.forEach(function(x){ allowed[x.EscalationID] = true; });
    rows = rows.filter(function(w) {
      return allowed[w.EscalationID] || String(w.PersonEmail || '').toLowerCase() === mine;
    });
  }
  rows.sort(function(a,b){ return String(b.IssuedAt).localeCompare(String(a.IssuedAt)); });
  return { items: rows.slice(0, 300), total: rows.length };
}

/**
 * Raise a warning from an escalation. Validation and person resolution live here;
 * the record, the letter, the history and the audit all go through createWarning_.
 */
function raiseWarning_(payload, me) {
  var p = payload || {};
  var escId = String(p.EscalationID || '').trim();
  // A warning does NOT require an escalation. Attendance, conduct and safety
  // letters are raised directly against a person; only the escalation-linked
  // route needs an escalation to read the client and branch from.
  if (!escId && !String(p.Email || '').trim()) {
    throw ValidationError_('Choose a person, or an escalation to raise this against.');
  }
  if (!escId) {
    var direct = String(p.Email).trim().toLowerCase();
    assertPeopleReach_(me, direct);
    return createWarning_({
      personEmail: direct, personName: personName_(direct),
      escalationId: '', strikeLevel: p.StrikeLevel || 'MANUAL',
      category: p.Category || 'OTHER',
      reason: String(p.reason || ''), cc: p.cc, source: 'MANUAL',
      sendLetter: p.sendLetter !== false, me: me
    });
  }
  var reason = String(p.reason || '').trim();

  var e = findRowById_('ESCALATIONS', 'EscalationID', escId);
  if (!e) throw ValidationError_('Escalation not found.');
  var visible = scopeEscalations_([e], me, clientIndex_());
  if (!visible.length) throw AuthError_('You do not have access to this escalation.');

  var personEmail = String(e.AgainstEmail || resolveAgainstEmail_(e) || '').trim().toLowerCase();
  var personName  = String(e.EscalatedAgainst || '').trim();
  if (!personName && !personEmail) throw ValidationError_('This escalation has nobody recorded against it.');

  return createWarning_({
    personEmail: personEmail, personName: personName,
    escalationId: escId, escalation: e,
    clientId: e.ClientID || '', branchId: e.BranchID || '',
    strikeLevel: p.StrikeLevel || 'MANUAL',
    category: p.Category || 'ESCALATION',
    reason: reason, cc: p.cc, source: 'MANUAL',
    sendLetter: p.sendLetter !== false, me: me
  });
}

/**
 * Acknowledge a warning. Closes the loop the register was missing: warnings could
 * be issued but never marked as seen, so warningsOpen only ever grew.
 * Acknowledging records who did it and when; it never edits the original facts.
 */
function acknowledgeWarning_(payload, me) {
  var p = payload || {};
  var wid = String(p.WarningID || '').trim();
  if (!wid) throw ValidationError_('Warning is required.');

  var w = findRowById_('WARNINGS', 'WarningID', wid);
  if (!w) throw ValidationError_('Warning not found.');

  // Only someone who can see this warning may acknowledge it.
  var visible = (listWarnings_({}, me) || {}).items || [];
  var allowed = visible.some(function(x){ return String(x.WarningID) === wid; });
  if (!allowed) throw AuthError_('You do not have access to this warning.');

  if (String(w.AcknowledgedAt || '').trim()) {
    return { ok: true, already: true, WarningID: wid, AcknowledgedAt: w.AcknowledgedAt };
  }

  var note = String(p.note || '').trim();
  var stamp = nowIso_();
  updateRowById_('WARNINGS', 'WarningID', wid, {
    Status: 'ACKNOWLEDGED',
    AcknowledgedAt: stamp,
    Notes: String(w.Notes || '') + (note ? ('\nAcknowledged by ' + me.email + ': ' + note) : ('\nAcknowledged by ' + me.email + '.'))
  });

  if (w.EscalationID) {
    appendRow_('ESCALATION_HISTORY', {
      HistoryID: nextId_('EHI'), EscalationID: w.EscalationID, Timestamp: stamp,
      User: me.email, Field: 'Warning', OldValue: wid, NewValue: 'ACKNOWLEDGED',
      Note: 'Warning ' + wid + ' acknowledged.' + (note ? ' ' + note : '')
    });
  }

  logAudit_({ user: me.email, action: 'WARNING_ACK', entity: 'WARNINGS',
    entityId: wid, oldValue: String(w.Status || ''), newValue: 'ACKNOWLEDGED' });

  return { ok: true, WarningID: wid, AcknowledgedAt: stamp };
}

/**
 * Body of a warning letter. Deliberately factual and dated: it states what was
 * escalated, how long it has been open and what is being asked for, then records
 * who raised it. No adjectives about the person.
 */
function warningLetterBody_(e, level, reason, me) {
  var name = String(e.EscalatedAgainst || '').trim();
  var greeting = name ? ('Dear ' + escHtml_(name) + ',') : 'Dear Colleague,';
  var levelText = String(level) === 'MANUAL'
    ? 'a formal warning'
    : ('a level ' + escHtml_(String(level)) + ' of 3 warning');
  var rows = [
    ['Escalation', e.EscalationID],
    ['Client', (clientIndex_()[e.ClientID] || {}).ClientName || e.ClientID],
    ['Branch', e.BranchCode || e.BranchID || '-'],
    ['Category', e.Category || '-'],
    ['Severity', e.Severity || '-'],
    ['Raised on', e.CreatedAt || e.Date || '-'],
    ['Target date', e.TargetDate || '-'],
    ['Current status', e.Status || '-']
  ];
  var table = '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-size:14px;margin:12px 0">';
  rows.forEach(function(r) {
    table += '<tr><td style="background:#f5f5f5"><b>' + escHtml_(r[0]) + '</b></td><td>' + escHtml_(String(r[1] || '-')) + '</td></tr>';
  });
  table += '</table>';
  return '<p>' + greeting + '</p>' +
    '<p>This is ' + levelText + ' regarding the escalation below, which remains unresolved.</p>' +
    table +
    '<p><b>Reason for this warning:</b><br/>' + escHtml_(reason) + '</p>' +
    '<p>Please respond with the action taken, or update the escalation in the Crux Escalation Matrix portal.</p>' +
    '<p style="color:#666;font-size:12px">Raised by ' + escHtml_(me.email) + ' on ' + escHtml_(nowIso_()) +
    '. This is a record of fact for the escalation register.</p>' +
    (buildSignature_() || '');
}

/**
 * MIS as a downloadable CSV.
 * The file is written to Drive and a link returned, rather than streaming bytes
 * to the browser: the app runs inside a sandboxed iframe where a client-side
 * download is unreliable, and a Drive file is also shareable afterwards.
 */
function misExport_(p, me) {
  var mis = escalationMIS_(p || {}, me) || {};
  var rows = mis.rows || mis.detail || [];

  // If the MIS did not hand back detail rows, rebuild them from the same scoped
  // source it uses, so the export can never be silently empty.
  if (!rows.length) {
    var idx = clientIndex_();
    rows = scopeEscalations_(readTable_('ESCALATIONS'), me, idx).map(function(e) {
      return {
        EscalationID: e.EscalationID, Date: e.Date || e.CreatedAt || '',
        ClientName: (idx[e.ClientID] || {}).ClientName || e.ClientID,
        BranchCode: e.BranchCode || '', Category: e.Category || '',
        Severity: e.Severity || '', Status: e.Status || '',
        EscalatedAgainst: e.EscalatedAgainst || '', AgainstEmail: e.AgainstEmail || '',
        AssignedOwner: e.AssignedOwner || '', TargetDate: e.TargetDate || '',
        ClosureDate: e.ClosureDate || '', Description: e.Description || ''
      };
    });
  }

  var cols = ['EscalationID','Date','ClientName','BranchCode','Category','Severity',
              'Status','EscalatedAgainst','AgainstEmail','AssignedOwner','TargetDate',
              'ClosureDate','Description'];
  var esc = function(v) {
    var s = String(v == null ? '' : v);
    return '"' + s.split('"').join('""') + '"';
  };
  var lines = [cols.join(',')];
  rows.forEach(function(r) {
    lines.push(cols.map(function(c){ return esc(r[c]); }).join(','));
  });

  // A short summary block, so the file is useful on its own.
  var hd = mis.headline || {};
  lines.push('');
  lines.push('Summary');
  lines.push('Total,' + (hd.total || rows.length));
  lines.push('Open,' + (hd.open || 0));
  lines.push('Overdue,' + (hd.overdue || 0));
  lines.push('Exception,' + (hd.exception || 0));
  lines.push('Average resolution days,' + (hd.avgResolutionDays == null ? '' : hd.avgResolutionDays));
  lines.push('Generated,' + nowIso_());
  lines.push('Generated for,' + me.email);

  var name = 'Crux escalation MIS ' + ymd_(new Date()) + '.csv';
  var blob = Utilities.newBlob(lines.join('\n'), 'text/csv', name);
  var file = signatureFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  logAudit_({ user: me.email, action: 'MIS_EXPORT', entity: 'ESCALATIONS',
    entityId: file.getId(), oldValue: '', newValue: String(rows.length) + ' rows' });
  return {
    ok: true, rows: rows.length, fileName: name,
    url: 'https://drive.google.com/uc?export=download&id=' + file.getId(),
    viewUrl: file.getUrl()
  };
}

/* ================= THE WARNING MODEL =================
 * There were three independent writers to WARNINGS - the manual raise, the team
 * page, and the automatic strike-3 sweep - each with its own email path, its own
 * field set and its own idea of what a warning record looks like. That is one
 * business concept with three implementations, which is why warnings behaved
 * inconsistently and why some paths emailed and others did not.
 *
 * createWarning_ is now the single writer. Every caller goes through it, so a
 * warning always: writes one row, notifies the person, records history, and
 * audits - regardless of who raised it.
 */
var WARNING_SOURCES = ['MANUAL','TEAM','STRIKE'];

/**
 * Operational warning categories. Most warning letters have nothing to do with a
 * service escalation - attendance, conduct, uniform, safety - so requiring an
 * escalation first made the register unusable for the cases it is most needed for.
 * The category also tells the AI what kind of letter it is drafting.
 */
var WARNING_CATEGORIES = [
  { key:'ATTENDANCE',  label:'Attendance or punctuality',
    guide:'unauthorised absence, late reporting or leaving early' },
  { key:'CONDUCT',     label:'Behaviour or misconduct',
    guide:'rudeness, argument, insubordination or conduct unbecoming' },
  { key:'UNIFORM',     label:'Uniform, grooming or turnout',
    guide:'incomplete uniform, poor grooming or missing identification' },
  { key:'PROCESS',     label:'Process or SOP violation',
    guide:'not following the laid down procedure or register discipline' },
  { key:'SAFETY',      label:'Safety or security lapse',
    guide:'a lapse that put people, property or the client at risk' },
  { key:'PERFORMANCE', label:'Performance shortfall',
    guide:'sustained failure to meet the agreed standard' },
  { key:'CLIENT',      label:'Client complaint',
    guide:'a complaint received from the client about this person' },
  { key:'ESCALATION',  label:'Unanswered escalation',
    guide:'an escalation that went unanswered' },
  { key:'OTHER',       label:'Other',  guide:'' }
];

function warningCategories_(p, me) { return WARNING_CATEGORIES; }

function createWarning_(opts) {
  var o = opts || {};
  var person = String(o.personEmail || '').trim().toLowerCase();
  var reason = String(o.reason || '').trim();
  var source = WARNING_SOURCES.indexOf(String(o.source)) === -1 ? 'MANUAL' : String(o.source);
  var level = String(o.strikeLevel == null ? 'MANUAL' : o.strikeLevel);
  var issuedBy = String((o.me && o.me.email) || o.issuedBy || 'system').toLowerCase();

  if (!person && !String(o.personName || '').trim()) {
    throw ValidationError_('A warning needs a person.');
  }
  if (reason.length < 10) {
    throw ValidationError_('Please record why this warning is being raised (at least 10 characters).');
  }

  var wid = nextId_('WRN');
  appendRow_('WARNINGS', {
    WarningID: wid, IssuedAt: nowIso_(),
    EscalationID: String(o.escalationId || ''),
    PersonEmail: person,
    PersonName: String(o.personName || '').trim() || (person ? personName_(person) : ''),
    ClientID: String(o.clientId || ''), BranchID: String(o.branchId || ''),
    StrikeLevel: level,
    Category: String(o.category || 'OTHER'),
    Summary: String(o.summary || ('Raised by ' + issuedBy + ' (' + source.toLowerCase() + ').')),
    FactsJson: JSON.stringify(o.facts || { source: source, category: o.category || 'OTHER', reason: reason }),
    IssuedBy: issuedBy, Status: 'ISSUED', AcknowledgedAt: '',
    Notes: reason
  });
  invalidateTableCache_('WARNINGS');

  // History, when the warning hangs off an escalation.
  if (o.escalationId) {
    try {
      appendRow_('ESCALATION_HISTORY', {
        HistoryID: nextId_('EHI'), EscalationID: o.escalationId, Timestamp: nowIso_(),
        User: issuedBy, Field: 'Warning', OldValue: '', NewValue: wid,
        Note: 'Warning raised (' + source.toLowerCase() + '). Reason: ' + reason
      });
    } catch (e) { Logger.log('warning history failed: ' + e); }
  }

  // Notify. Never lose the record because mail failed, but never swallow the
  // failure silently either - it is returned and logged.
  var sent = { attempted: false, ok: false, to: person, why: '' };
  if (o.sendLetter !== false) {
    if (!isEmail_(person)) {
      sent.why = 'no email on record for this person, warning filed only';
    } else {
      var cc = [];
      var ccSetting = String(getSetting_('ESCALATION_CC','') || '').trim();
      if (ccSetting) cc = ccSetting.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      if (String(level) === '3') {
        var md = String(getSetting_('MD_EMAIL','') || '').trim();
        if (md && cc.indexOf(md) === -1) cc.push(md);
      }
      if (o.cc) {
        String(o.cc).split(',').map(function(x){ return x.trim(); }).filter(Boolean)
          .forEach(function(x){ if (cc.indexOf(x) === -1) cc.push(x); });
      }
      var subject = (level === 'MANUAL' ? '[WARNING] ' : '[WARNING ' + level + '/3] ') +
        (o.escalationId ? (o.escalationId + ' - ') : '') + 'action required';
      try {
        sendEmail_({
          type: 'WARNING_LETTER', clientId: o.clientId || '', branchId: o.branchId || '',
          to: [person], cc: cc, subject: subject,
          htmlBody: o.htmlBody || warningLetterBody_(o.escalation || {}, level, reason,
                                                     { email: issuedBy }),
          trigger: 'warning.' + source.toLowerCase(),
          idempotencyKey: 'WARNLETTER-' + wid
        });
        sent.attempted = true; sent.ok = true;
      } catch (e) {
        sent.attempted = true; sent.ok = false;
        sent.why = String(e && e.message || e);
        Logger.log('WARNING EMAIL FAILED for ' + wid + ': ' + sent.why);
        // Make the failure visible in the record rather than only in a log.
        updateRowById_('WARNINGS', 'WarningID', wid,
          { Notes: reason + '\nEMAIL FAILED: ' + sent.why });
      }
    }
  } else {
    sent.why = 'filed without sending, as requested';
  }

  logAudit_({ user: issuedBy, action: 'WARNING_RAISE', entity: 'WARNINGS', entityId: wid,
    oldValue: '', newValue: JSON.stringify({ person: person, source: source, level: level,
                                            escalation: o.escalationId || '', emailed: sent.ok }) });
  return { ok: true, WarningID: wid, PersonEmail: person, sent: sent, source: source };
}

/**
 * The strike clock.
 *
 * The sweep used to fall back to UpdatedAt, which changes on ANY write - a status
 * tweak, an exception grant, an admin correction. That silently reset the
 * three-strike timer, so an escalation could be nudged indefinitely and never
 * strike. LastActivityAt moves ONLY when somebody genuinely responds.
 */
function touchActivity_(escalationId, who, note) {
  if (!escalationId) return;
  try {
    updateRowById_('ESCALATIONS', 'EscalationID', escalationId, { LastActivityAt: nowIso_() });
    invalidateTableCache_('ESCALATIONS');
    if (note) {
      appendRow_('ESCALATION_HISTORY', {
        HistoryID: nextId_('EHI'), EscalationID: escalationId, Timestamp: nowIso_(),
        User: who || 'system', Field: 'Activity', OldValue: '', NewValue: '',
        Note: String(note).slice(0, 300)
      });
    }
  } catch (e) { Logger.log('touchActivity_ failed for ' + escalationId + ': ' + e); }
}
