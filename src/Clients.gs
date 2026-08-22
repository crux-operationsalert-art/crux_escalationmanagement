/**
 * Clients.gs — client / branch / matrix domain logic.
 */

var MATRIX_LEVELS = [
  { level: 1, name: 'SPOC' },
  { level: 2, name: 'Team Leader' },
  { level: 3, name: 'Branch Manager' },
  { level: 4, name: 'Zonal Manager' },
  { level: 5, name: 'Head Office' }
];

/* ---------- CLIENTS ---------- */

function listClients_(p, me) {
  var rows = readTable_('CLIENTS');
  // Clients are a SHARED master list, deliberately NOT scoped. Every role sees
  // every client; only ADMIN may create or edit one (enforced in upsertClient_).
  // Scoping stays on BRANCHES and ESCALATIONS, which is where ownership lives.
  // This is what fixed a Location Head being unable to see an existing client
  // and then hitting "client already exists" when trying to re-create it.
  rows = applyFilters_(rows, p && p.filters);
  // Attach summary stats.
  var branches = readTable_('BRANCHES');
  var matrix = readTable_('ESCALATION_MATRIX');
  rows = rows.map(function(c){
    var bcount = branches.filter(function(b){ return b.ClientID === c.ClientID && b.Status !== 'INACTIVE'; }).length;
    var m = matrix.filter(function(m){ return m.ClientID === c.ClientID; });
    var complete = isMatrixComplete_(c, m);
    return Object.assign({}, c, { _branchCount: bcount, _matrixComplete: complete });
  });
  return paginate_(rows, p);
}

function getClient_(id, me) {
  var c = findRowById_('CLIENTS', 'ClientID', id);
  assertClientAccess_(c, me);
  var branches = readTable_('BRANCHES').filter(function(b){ return b.ClientID === id; });
  var matrix = readTable_('ESCALATION_MATRIX').filter(function(m){ return m.ClientID === id; });
  return { client: c, branches: branches, matrix: matrix };
}

function upsertClient_(payload, me) {
  var c = payload || {};
  if (!req_(c.ClientName)) throw ValidationError_('Client Name is required.');
  if (c.ClientEmail && !isEmail_(c.ClientEmail)) throw ValidationError_('Client email format is invalid.');
  if (c.HeadOfficeEmail && !isEmail_(c.HeadOfficeEmail)) throw ValidationError_('Head office email format is invalid.');
  var existing = c.ClientID ? findRowById_('CLIENTS', 'ClientID', c.ClientID) : null;
  var patch = {
    ClientName: c.ClientName, ClientCode: c.ClientCode || '',
    ClientEmail: c.ClientEmail || '', ClientCC: c.ClientCC || '',
    HeadOfficeEmail: String(c.HeadOfficeEmail || '').trim().toLowerCase(),
    HeadOfficeCC: String(c.HeadOfficeCC || '').trim(),
    DefaultLocationHead: (c.DefaultLocationHead || '').toString().toLowerCase(),
    Status: c.Status || 'ACTIVE',
    EffectiveFrom: c.EffectiveFrom || '', EffectiveTo: c.EffectiveTo || '',
    Notes: c.Notes || '', UpdatedAt: nowIso_(), UpdatedBy: me.email
  };
  if (existing) {
    assertClientAccess_(existing, me);
    // Duplicate name check (case-insensitive) except self.
    var dupe = readTable_('CLIENTS').filter(function(r){ return r.ClientID !== existing.ClientID && String(r.ClientName).toLowerCase() === String(patch.ClientName).toLowerCase(); })[0];
    if (dupe) throw ValidationError_('Another client already exists with this name.');
    updateRowById_('CLIENTS', 'ClientID', existing.ClientID, patch);
    logAudit_({ user: me.email, action: 'CLIENT_UPDATE', entity: 'CLIENTS', entityId: existing.ClientID, oldValue: JSON.stringify(existing), newValue: JSON.stringify(patch) });
    return Object.assign({}, existing, patch);
  }
  patch.ClientID = nextId_('CLI'); patch.CreatedAt = nowIso_();
  var dupe2 = readTable_('CLIENTS').filter(function(r){ return String(r.ClientName).toLowerCase() === String(patch.ClientName).toLowerCase(); })[0];
  if (dupe2) throw ValidationError_('A client already exists with this name.');
  appendRow_('CLIENTS', patch);
  logAudit_({ user: me.email, action: 'CLIENT_CREATE', entity: 'CLIENTS', entityId: patch.ClientID, oldValue:'', newValue: JSON.stringify(patch) });
  return patch;
}

function setClientStatus_(payload, me) {
  var c = findRowById_('CLIENTS', 'ClientID', payload.id);
  if (!c) throw ValidationError_('Client not found.');
  updateRowById_('CLIENTS', 'ClientID', c.ClientID, { Status: payload.status, UpdatedAt: nowIso_(), UpdatedBy: me.email });
  logAudit_({ user: me.email, action: 'CLIENT_STATUS', entity: 'CLIENTS', entityId: c.ClientID, oldValue: c.Status, newValue: payload.status });
  return { ok: true };
}

/* ---------- BRANCHES ---------- */

function listBranches_(p, me) {
  var rows = readTable_('BRANCHES');
  if (p && p.clientId) rows = rows.filter(function(b){ return b.ClientID === p.clientId; });
  rows = scopeBranchesForUser_(rows, me);
  rows = applyFilters_(rows, p && p.filters);
  return paginate_(rows, p);
}

function upsertBranch_(payload, me) {
  var b = payload || {};
  if (!req_(b.ClientID)) throw ValidationError_('Client is required.');
  if (!req_(b.BranchName)) throw ValidationError_('Branch Name is required.');
  if (!req_(b.BranchCode)) throw ValidationError_('Branch Code is required.');
  // Trim first. A pasted address usually carries a leading or trailing space,
  // which failed validation with a message that did not say why. Also name the
  // offending value in the error so the user can see what to correct.
  ['CruxPOCEmail','BranchManagerEmail','CruxPOCMobile','BranchManagerMobile',
   'BranchName','BranchCode','Location','Zone','CruxPOCName','BranchManagerName']
    .forEach(function(k) { if (b[k] != null) b[k] = String(b[k]).trim(); });

  if (b.CruxPOCEmail && !isEmail_(b.CruxPOCEmail)) {
    throw ValidationError_('Crux POC email does not look like an email: "' + b.CruxPOCEmail +
      '". Use something like name@cruxindia.co.in, or leave it blank.');
  }
  if (b.BranchManagerEmail && !isEmail_(b.BranchManagerEmail)) {
    throw ValidationError_('Branch manager email does not look like an email: "' + b.BranchManagerEmail +
      '". Use something like name@cruxindia.co.in, or leave it blank.');
  }
  if (b.CruxPOCMobile && !isPhone_(b.CruxPOCMobile)) throw ValidationError_('Crux POC mobile format is invalid.');
  var client = findRowById_('CLIENTS', 'ClientID', b.ClientID);
  if (!client) throw ValidationError_('Invalid client reference.');
  assertClientAccess_(client, me);
  // duplicate branch code under same client
  var siblings = readTable_('BRANCHES').filter(function(r){ return r.ClientID === b.ClientID; });
  var dupe = siblings.filter(function(r){
    return String(r.BranchCode).toLowerCase() === String(b.BranchCode).toLowerCase()
      && r.BranchID !== b.BranchID;
  })[0];
  if (dupe) throw ValidationError_('Duplicate Branch Code under this client.');
  var patch = {
    ClientID: b.ClientID, BranchName: b.BranchName, BranchCode: b.BranchCode,
    Address: b.Address || '',
    CruxPOCName: b.CruxPOCName || '', CruxPOCEmpID: b.CruxPOCEmpID || '',
    CruxPOCMobile: b.CruxPOCMobile || '', CruxPOCEmail: b.CruxPOCEmail || '',
    BranchManagerName: b.BranchManagerName || '', BranchManagerMobile: b.BranchManagerMobile || '', BranchManagerEmail: b.BranchManagerEmail || '',
    LocationHead: String(b.LocationHead || '').toLowerCase(),
    // Trimmed and whitespace-collapsed so 'Pune ' and 'Pune' cannot become two
    // locations. Case is preserved for display; every comparison upstream is
    // case-insensitive.
    Location: String(b.Location || '').trim().replace(/\s+/g, ' '),
    Zone: String(b.Zone || '').trim().replace(/\s+/g, ' '),
    Status: b.Status || 'ACTIVE',
    EffectiveFrom: b.EffectiveFrom || '', EffectiveTo: b.EffectiveTo || '',
    Notes: b.Notes || '', UpdatedAt: nowIso_(), UpdatedBy: me.email
  };
  var existing = b.BranchID ? findRowById_('BRANCHES', 'BranchID', b.BranchID) : null;
  if (existing) {
    updateRowById_('BRANCHES', 'BranchID', existing.BranchID, patch);
    logAudit_({ user: me.email, action: 'BRANCH_UPDATE', entity: 'BRANCHES', entityId: existing.BranchID, oldValue: JSON.stringify(existing), newValue: JSON.stringify(patch) });
    return Object.assign({}, existing, patch);
  }
  patch.BranchID = nextId_('BR'); patch.CreatedAt = nowIso_();
  appendRow_('BRANCHES', patch);
  logAudit_({ user: me.email, action: 'BRANCH_CREATE', entity: 'BRANCHES', entityId: patch.BranchID, oldValue:'', newValue: JSON.stringify(patch) });
  return patch;
}

function setBranchStatus_(payload, me) {
  var b = findRowById_('BRANCHES', 'BranchID', payload.id);
  if (!b) throw ValidationError_('Branch not found.');
  updateRowById_('BRANCHES', 'BranchID', b.BranchID, { Status: payload.status, UpdatedAt: nowIso_(), UpdatedBy: me.email });
  logAudit_({ user: me.email, action: 'BRANCH_STATUS', entity: 'BRANCHES', entityId: b.BranchID, oldValue: b.Status, newValue: payload.status });
  return { ok: true };
}

/* ---------- ESCALATION MATRIX ---------- */

/**
 * Read a matrix at one of three scopes. Scope is decided by what is passed:
 *   branchId  -> that branch, with inheritance shown per level
 *   location  -> the client+location default
 *   neither   -> the client-wide default (legacy)
 */
function getMatrix_(clientId, me, branchId, location) {
  var c = findRowById_('CLIENTS', 'ClientID', clientId);
  assertClientAccess_(c, me);
  var bid = String(branchId || '').trim();
  var loc = String(location || '').trim();

  // A branch always carries its own location, so a caller need only name the branch.
  if (bid && !loc) {
    var br = findRowById_('BRANCHES', 'BranchID', bid);
    if (br) loc = String(br.Location || '').trim();
  }
  var all = readTable_('ESCALATION_MATRIX');

  if (!bid && loc) {
    // Editing a location default: show only rows owned at that scope, so a blank
    // level reads as blank rather than borrowing from the client-wide row.
    var own = {};
    all.forEach(function(r) {
      if (String(r.ClientID) !== String(clientId)) return;
      if (String(r.BranchID || '').trim()) return;
      if (String(r.Location || '').trim().toUpperCase() !== loc.toUpperCase()) return;
      own[r.Level] = r;
    });
    var clientWide = {};
    all.forEach(function(r) {
      if (String(r.ClientID) !== String(clientId)) return;
      if (String(r.BranchID || '').trim() || String(r.Location || '').trim()) return;
      clientWide[r.Level] = r;
    });
    return MATRIX_LEVELS.map(function(Lv) {
      var r = own[Lv.level] || {};
      var inh = clientWide[Lv.level] || {};
      return {
        Level: Lv.level, LevelName: Lv.name,
        ContactName: r.ContactName || '', Mobile: r.Mobile || '', Email: r.Email || '',
        MatrixID: r.MatrixID || '', BranchID: '', Location: loc,
        _filled: !!(String(r.ContactName||'').trim() || String(r.Email||'').trim()),
        _source: (r.MatrixID ? 'LOCATION' : (inh.MatrixID ? 'CLIENT' : 'NONE')),
        _inheritedContactName: r.MatrixID ? '' : (inh.ContactName || ''),
        _inheritedMobile: r.MatrixID ? '' : (inh.Mobile || ''),
        _inheritedEmail: r.MatrixID ? '' : (inh.Email || '')
      };
    });
  }
  // EDITING view. Returns only what this scope actually STORES, with the
  // inherited value carried separately for display.
  //
  // resolveMatrixRows_ returns EFFECTIVE values, which is right for dispatch and
  // wrong for a form: the UI loaded effective values, the user pressed Save, and
  // saveMatrix_ wrote every inherited value back as a hard branch override -
  // silently destroying the fallback on first save. Keep the two views separate.
  var eff = resolveMatrixRows_(clientId, bid, loc, all);
  var ownRows = {};
  all.forEach(function(r) {
    if (String(r.ClientID) !== String(clientId)) return;
    if (String(r.BranchID || '').trim() === bid) ownRows[r.Level] = r;
  });
  return eff.map(function(r) {
    var own = ownRows[r.Level] || {};
    return {
      Level: r.Level, LevelName: r.LevelName,
      ContactName: own.ContactName || '', Mobile: own.Mobile || '', Email: own.Email || '',
      MatrixID: own.MatrixID || '', BranchID: bid, Location: r.Location,
      _filled: r._filled, _source: r._source,
      // what dispatch would actually use, for preview
      _effectiveContactName: r.ContactName || '', _effectiveEmail: r.Email || '',
      _inheritedContactName: r._inheritedContactName || '',
      _inheritedMobile: r._inheritedMobile || '',
      _inheritedEmail: r._inheritedEmail || ''
    };
  });
}

/**
 * Save a matrix at exactly one scope. Never touches the other two, so a branch
 * override cannot alter a location default and a location default cannot alter
 * another location.
 */
function saveMatrix_(payload, me) {
  var clientId = payload.clientId;
  var bid = String(payload.branchId || '').trim();
  var loc = String(payload.location || '').trim();
  var rows = payload.rows || [];
  var c = findRowById_('CLIENTS', 'ClientID', clientId);
  if (!c) throw ValidationError_('Client not found.');
  assertClientAccess_(c, me);

  if (bid) {
    var br = findRowById_('BRANCHES', 'BranchID', bid);
    if (!br) throw ValidationError_('Branch not found.');
    if (String(br.ClientID) !== String(clientId)) {
      throw ValidationError_('That branch does not belong to this client.');
    }
    loc = '';   // a branch row is keyed by branch, not by location
  }

  var existing = readTable_('ESCALATION_MATRIX').filter(function(m) {
    if (String(m.ClientID) !== String(clientId)) return false;
    var mb = String(m.BranchID || '').trim();
    var ml = String(m.Location || '').trim().toUpperCase();
    if (bid) return mb === bid;
    if (loc) return !mb && ml === loc.toUpperCase();
    return !mb && !ml;
  });
  var byLevel = {}; existing.forEach(function(r){ byLevel[r.Level] = r; });

  rows.forEach(function(r) {
    if (r.Email && !isEmail_(r.Email)) throw ValidationError_('Invalid email for level ' + r.LevelName);
    if (r.Mobile && !isPhone_(r.Mobile)) throw ValidationError_('Invalid mobile for level ' + r.LevelName);
    var e = byLevel[r.Level];
    var patch = {
      Level: r.Level, LevelName: r.LevelName,
      ContactName: r.ContactName || '', Mobile: r.Mobile || '', Email: r.Email || '',
      UpdatedAt: nowIso_(), UpdatedBy: me.email
    };
    if (e) {
      updateRowById_('ESCALATION_MATRIX', 'MatrixID', e.MatrixID, patch);
    } else {
      patch.MatrixID = nextId_('MTX');
      patch.ClientID = clientId;
      patch.BranchID = bid;
      patch.Location = bid ? '' : loc;
      appendRow_('ESCALATION_MATRIX', patch);
    }
  });
  updateRowById_('CLIENTS', 'ClientID', clientId, { UpdatedAt: nowIso_(), UpdatedBy: me.email });
  invalidateTableCache_('ESCALATION_MATRIX');
  logAudit_({ user: me.email, action: 'MATRIX_SAVE', entity: 'ESCALATION_MATRIX',
    entityId: clientId + (bid ? ('/branch:' + bid) : (loc ? ('/loc:' + loc) : '/client')),
    oldValue: JSON.stringify(existing), newValue: JSON.stringify(rows) });
  return { ok: true, branchId: bid, location: loc,
           scope: bid ? 'BRANCH' : (loc ? 'LOCATION' : 'CLIENT') };
}

/** Validate a client's matrix. Returns {complete, missing:[...]}. */
function validateClientMatrix_(client, matrixRows) {
  var missing = [];
  if (!isEmail_(client.ClientEmail)) missing.push('Client Email');
  var byLevel = {}; (matrixRows || []).forEach(function(r){ byLevel[r.Level] = r; });
  MATRIX_LEVELS.forEach(function(L) {
    var r = byLevel[L.level] || {};
    if (!req_(r.ContactName)) missing.push(L.name + ' — Name');
    if (!isPhone_(r.Mobile))  missing.push(L.name + ' — Mobile');
    if (!isEmail_(r.Email))   missing.push(L.name + ' — Email');
  });
  return { complete: missing.length === 0, missing: missing };
}

function isMatrixComplete_(client, matrixRows) {
  return validateClientMatrix_(client, matrixRows).complete;
}

function dashboardSummary_(me) {
  var sc       = userScope_(me);
  var clients  = scopeClientsForUser_(readTable_('CLIENTS'), me);
  var branches = scopeBranchesForUser_(readTable_('BRANCHES'), me);

  var activeClients  = clients.filter(function(c){ return c.Status !== 'INACTIVE'; });
  var activeBranches = branches.filter(function(b){ return b.Status !== 'INACTIVE'; });

  // Matrix coverage. Group ESCALATION_MATRIX by ClientID ONCE. The old code ran
  // matrix.filter() inside a loop over clients, and did it twice - O(n*m) each.
  var matrixByClient = {};
  readTable_('ESCALATION_MATRIX').forEach(function(x) {
    var k = String(x.ClientID);
    if (!matrixByClient[k]) matrixByClient[k] = [];
    matrixByClient[k].push(x);
  });
  var complete = 0, incompleteRows = [];
  activeClients.forEach(function(c) {
    var rows = matrixByClient[String(c.ClientID)] || [];
    if (isMatrixComplete_(c, rows)) complete++;
    else incompleteRows.push(c);
  });
  var coveragePct = activeClients.length
    ? Math.round((complete / activeClients.length) * 100)
    : 0;

  // Escalation numbers come from the MIS, not from a second implementation here.
  // Two consequences, both wanted: the dashboard is scope-correct because MIS runs
  // scopeEscalations_, and the dashboard can never disagree with the MIS report
  // the user drills into. Costs no extra Sheets I/O - _TABLE_CACHE memoises reads
  // for the life of the execution.
  var mis = escalationMIS_({}, me) || {};
  var hd  = mis.headline || {};

  // Scope gate for the log-style tables. userScope_ covers every role, not just
  // LOCATION_HEAD, so a restricted MANAGER or VIEWER is filtered here too.
  var inScope = function(row) {
    if (sc.all) return true;
    if (row.ClientID && sc.clientIds[row.ClientID]) return true;
    if (row.BranchID && sc.branchIds[row.BranchID]) return true;
    return false;
  };

  var mKey = monthKey_(new Date());

  var monthEmails = readTable_('EMAIL_LOG').filter(function(e) {
    return String(e.Timestamp).indexOf(mKey) === 0 && inScope(e);
  });
  var failedEmails = monthEmails.filter(function(e){ return e.Status === 'FAILED'; });

  // Dispatch queue health for the current month.
  var queue = readTable_('DISPATCH_QUEUE').filter(function(q) {
    return String(q.MonthKey) === mKey && inScope(q);
  });
  var qCount = function(list) {
    return queue.filter(function(q) {
      return list.indexOf(String(q.Status || 'PENDING').toUpperCase()) !== -1;
    }).length;
  };
  var dispatch = {
    monthKey: mKey,
    queued:   queue.length,
    sent:     qCount(['SENT']),
    pending:  qCount(['PENDING','RETRY']),
    failed:   qCount(['FAILED'])
  };

  // Warnings via listWarnings_ so the count matches the register when its UI lands.
  // Open means not yet acknowledged - nothing writes ACKNOWLEDGED today.
  var warnItems = (listWarnings_({}, me) || {}).items || [];
  var warningsOpen = warnItems.filter(function(w) {
    return !String(w.AcknowledgedAt || '').trim();
  }).length;

  // Recent activity, newest first, already scoped.
  var cIdx = clientIndex_();
  var recent = scopeEscalations_(readTable_('ESCALATIONS'), me, cIdx)
    .slice()
    .sort(function(a, b) {
      return String(b.UpdatedAt || b.CreatedAt || '')
        .localeCompare(String(a.UpdatedAt || a.CreatedAt || ''));
    })
    .slice(0, 8)
    .map(function(e) {
      return {
        EscalationID: e.EscalationID,
        ClientName:   (cIdx[e.ClientID] || {}).ClientName || e.ClientID,
        BranchCode:   e.BranchCode || '',
        Category:     e.Category,
        Severity:     e.Severity,
        Status:       e.Status,
        Against:      e.EscalatedAgainst || '',
        At:           e.UpdatedAt || e.CreatedAt || e.Date || ''
      };
    });

  return {
    role:        me.role,
    generatedAt: nowIso_(),
    monthKey:    mKey,
    scopeLabel:  sc.all ? 'all clients' : 'your scope only',
    totals: {
      clients:           activeClients.length,
      branches:          activeBranches.length,
      complete:          complete,
      incomplete:        incompleteRows.length,
      coveragePct:       coveragePct,
      openEscalations:   hd.open || 0,
      overdue:           hd.overdue || 0,
      exception:         hd.exception || 0,
      avgResolutionDays: hd.avgResolutionDays,
      emailsThisMonth:   monthEmails.length,
      failedEmails:      failedEmails.length,
      warningsOpen:      warningsOpen
    },
    ageing:         mis.ageing || {},
    bySeverity:     mis.bySeverity || {},
    dispatch:       dispatch,
    overdueTop:     (mis.overdue || []).slice(0, 8),
    recent:         recent,
    myClients:      me.role === 'LOCATION_HEAD' ? activeClients.slice(0, 10) : [],
    incompleteList: incompleteRows.slice(0, 20)
  };
}

function seedDemoData_(me) {
  // Idempotent: only seed if empty.
  if (readTable_('CLIENTS').length > 0) return { seeded: false, reason: 'already has data' };
  var lhEmail = me.email; // assign to current user
  var clientRows = [
    { name:'ABC Bank', code:'ABCB', email:'ops@abc-bank.example.com', cc:'compliance@abc-bank.example.com' },
    { name:'XYZ Finance', code:'XYZF', email:'support@xyzfin.example.com', cc:'' },
    { name:'Nova Insurance', code:'NOVA', email:'client-desk@nova.example.com', cc:'ops@nova.example.com' }
  ];
  var clients = clientRows.map(function(cr) {
    var c = {
      ClientID: nextId_('CLI'), ClientName: cr.name, ClientCode: cr.code,
      ClientEmail: cr.email, ClientCC: cr.cc,
      DefaultLocationHead: lhEmail, Status:'ACTIVE',
      EffectiveFrom: ymd_(new Date()), EffectiveTo:'', Notes:'Demo',
      CreatedAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy:'seed'
    };
    appendRow_('CLIENTS', c);
    return c;
  });
  var branchTpl = [
    ['001','Andheri','Mumbai','West'],
    ['002','Borivali','Mumbai','West'],
    ['003','Pune','Pune','West'],
    ['004','Nashik','Nashik','West']
  ];
  clients.forEach(function(c) {
    branchTpl.forEach(function(bt) {
      appendRow_('BRANCHES', {
        BranchID: nextId_('BR'), ClientID: c.ClientID,
        BranchName: bt[1], BranchCode: c.ClientCode + '-' + bt[0], Address: bt[2] + ', India',
        CruxPOCName: 'Rahul Sharma', CruxPOCEmpID:'CRX-101', CruxPOCMobile:'9876543210', CruxPOCEmail:'rahul.sharma@crux.example.com',
        BranchManagerName:'Priya Nair', BranchManagerMobile:'9812345670', BranchManagerEmail:'priya.nair@'+c.ClientCode.toLowerCase()+'.example.com',
        LocationHead: lhEmail, Location: bt[2], Zone: bt[3], Status:'ACTIVE',
        EffectiveFrom: ymd_(new Date()), EffectiveTo:'', Notes:'', CreatedAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy:'seed'
      });
    });
  });
  // Matrix: fill fully for first two clients, leave 3rd partial.
  function fillMatrix(client, partial) {
    MATRIX_LEVELS.forEach(function(L) {
      if (partial && L.level >= 4) return;
      appendRow_('ESCALATION_MATRIX', {
        MatrixID: nextId_('MTX'), ClientID: client.ClientID,
        Level: L.level, LevelName: L.name,
        ContactName: L.name + ' ' + client.ClientCode,
        Mobile: '9800' + (100000 + L.level * 111 + Math.floor(Math.random()*89)),
        Email: L.name.toLowerCase().replace(/\s+/g,'.') + '@' + client.ClientCode.toLowerCase() + '.example.com',
        UpdatedAt: nowIso_(), UpdatedBy:'seed'
      });
    });
  }
  fillMatrix(clients[0], false);
  fillMatrix(clients[1], false);
  fillMatrix(clients[2], true);
  // Holidays
  var yr = new Date().getFullYear();
  [
    [yr+'-01-26','Republic Day'],
    [yr+'-08-15','Independence Day'],
    [yr+'-10-02','Gandhi Jayanti']
  ].forEach(function(h){ appendRow_('HOLIDAYS', { HolidayID: nextId_('HOL'), Date: h[0], Name: h[1], Status:'ACTIVE', CreatedAt: nowIso_() }); });
  return { seeded: true, clients: clients.length };
}

/**
 * THE authoritative matrix resolver. P1 fix.
 *
 * The default matrix was client-wide, so every branch of a client inherited one
 * set of contacts. In reality a client's default differs by location - a Pune
 * default is not a Nagpur default - and editing one silently changed the other.
 *
 * Resolution is now three tiers, most specific first:
 *   1. the branch's own row          (ClientID + BranchID)
 *   2. the client+location default   (ClientID + Location, no BranchID)
 *   3. the client-wide default       (ClientID only)  - kept so existing rows,
 *      which predate Location, continue to work untouched.
 *
 * Resolution happens per LEVEL, not per set, so a branch may override level 3
 * while still inheriting levels 1, 2, 4 and 5 from its location default.
 */
function resolveMatrixRows_(clientId, branchId, location, allRows) {
  var rows = allRows || readTable_('ESCALATION_MATRIX');
  var cid = String(clientId || '');
  var bid = String(branchId || '').trim();
  var loc = String(location || '').trim().toUpperCase();

  var branchLvl = {}, locLvl = {}, clientLvl = {};
  rows.forEach(function(r) {
    if (String(r.ClientID) !== cid) return;
    var rb = String(r.BranchID || '').trim();
    var rl = String(r.Location || '').trim().toUpperCase();
    if (rb) { if (bid && rb === bid) branchLvl[r.Level] = r; return; }
    if (rl) { if (loc && rl === loc) locLvl[r.Level] = r; return; }
    clientLvl[r.Level] = r;
  });

  // A row EXISTING is not an override. saveMatrix_ writes all five levels, so a
  // branch that filled only levels 1-2 still has blank rows at 3-5. Gating on
  // existence made those levels resolve to nothing instead of inheriting, which
  // would have sent an empty contact at dispatch. Gate on CONTENT instead.
  var has = function(r) {
    return !!(r && (String(r.ContactName || '').trim() || String(r.Email || '').trim()));
  };
  return MATRIX_LEVELS.map(function(L) {
    var own = has(branchLvl[L.level]) ? branchLvl[L.level] : null;
    var viaLoc = has(locLvl[L.level]) ? locLvl[L.level] : null;
    var viaClient = has(clientLvl[L.level]) ? clientLvl[L.level] : null;
    var eff = own || viaLoc || viaClient || {};
    var source = own ? 'BRANCH' : viaLoc ? 'LOCATION' : viaClient ? 'CLIENT' : 'NONE';
    return {
      Level: L.level, LevelName: L.name,
      ContactName: eff.ContactName || '', Mobile: eff.Mobile || '', Email: eff.Email || '',
      MatrixID: (branchLvl[L.level] || {}).MatrixID || '',
      BranchID: bid, Location: location || '',
      _filled: !!(own && (String(own.ContactName||'').trim() || String(own.Email||'').trim())),
      _source: source,
      _inheritedContactName: own ? '' : (eff.ContactName || ''),
      _inheritedMobile: own ? '' : (eff.Mobile || ''),
      _inheritedEmail: own ? '' : (eff.Email || '')
    };
  });
}

/* =========================================================================
 * MATRIX-BASED EMAIL ROUTING (section 6)
 *
 * Recipient resolution used to read only the BRANCHES and CLIENTS columns, so a
 * fully-populated escalation matrix had no effect on who actually received an
 * email. A level-4 escalation went to the branch manager exactly like a level-1
 * one, and level 5 ("Head Office") had nowhere to send at all because no head
 * office address was recorded anywhere.
 *
 * These helpers route through resolveMatrixRows_, so email inherits the same
 * branch -> client+location -> client-wide precedence as the matrix screen. One
 * resolver, one precedence, one answer.
 * ========================================================================= */

/** The matrix contact for one level at one branch, or null. */
function matrixContactForLevel_(clientId, branchId, location, level, allRows) {
  var rows = resolveMatrixRows_(clientId, branchId, location, allRows);
  var hit = rows.filter(function(r) { return Number(r.Level) === Number(level); })[0];
  if (!hit) return null;
  if (!isEmail_(hit.Email)) return null;
  return { level: Number(level), name: hit.LevelName, contactName: hit.ContactName,
           email: String(hit.Email).trim(), mobile: hit.Mobile || '', source: hit._source };
}

/**
 * Head office recipients for a client, most specific first:
 *   1. matrix level 5, resolved for this branch/location
 *   2. the client's own HeadOfficeEmail
 *   3. the HEAD_OFFICE_EMAIL setting (Crux head office)
 * Returns { to: [], cc: [], source: '' }.
 */
function headOfficeRecipients_(client, branchId, location, allRows) {
  var to = [], cc = [], source = 'NONE';
  var c = client || {};

  var viaMatrix = matrixContactForLevel_(c.ClientID, branchId, location, 5, allRows);
  if (viaMatrix) { to.push(viaMatrix.email); source = 'MATRIX_L5/' + viaMatrix.source; }

  if (!to.length && isEmail_(c.HeadOfficeEmail)) {
    to.push(String(c.HeadOfficeEmail).trim()); source = 'CLIENT_HEAD_OFFICE';
  }
  if (!to.length) {
    var fallback = String(getSetting_('HEAD_OFFICE_EMAIL', '') || '').trim();
    if (isEmail_(fallback)) { to.push(fallback); source = 'SETTING_HEAD_OFFICE_EMAIL'; }
  }

  parseList_(c.HeadOfficeCC).forEach(function(e) { if (isEmail_(e)) cc.push(e); });
  parseList_(getSetting_('HEAD_OFFICE_CC', '')).forEach(function(e) { if (isEmail_(e)) cc.push(e); });

  return { to: to, cc: dedupeEmails_(cc), source: source };
}

/** Case-insensitive de-duplication, first spelling wins. */
function dedupeEmails_(list) {
  var seen = {}, out = [];
  (list || []).forEach(function(e) {
    var v = String(e || '').trim();
    if (!isEmail_(v)) return;
    var k = v.toLowerCase();
    if (seen[k]) return;
    seen[k] = true; out.push(v);
  });
  return out;
}

/**
 * Everyone the matrix names for a branch, from level 1 up to `maxLevel`.
 * Used when an escalation has climbed: level 3 reaches levels 1-3, not only 3,
 * so the people already involved stay on the thread.
 */
function matrixRecipientsUpToLevel_(clientId, branchId, location, maxLevel, allRows) {
  var rows = resolveMatrixRows_(clientId, branchId, location, allRows);
  var out = [];
  rows.forEach(function(r) {
    if (Number(r.Level) > Number(maxLevel)) return;
    if (isEmail_(r.Email)) out.push(String(r.Email).trim());
  });
  return dedupeEmails_(out);
}
