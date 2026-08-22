/**
 * Auth.gs — role-based access control.
 *
 * Roles: ADMIN, MANAGER, LOCATION_HEAD, VIEWER.
 * Auth identity comes from Google (Session.getActiveUser().getEmail()).
 * Every RPC verifies the caller against the USERS sheet.
 * Location Heads only see clients/branches assigned to them (or where they
 * are the DefaultLocationHead on the client).
 */

var VALID_ROLES = ['ADMIN','MANAGER','LOCATION_HEAD','VIEWER'];

var _ME_CACHE = null;
var _ME_CACHE_KEY = null;
var _IDENTITY_SOURCE = 'GOOGLE';

/**
 * Resolve the caller.
 *
 * Identity has exactly two sources, in this order:
 *
 *  1. GOOGLE  - Session.getActiveUser().getEmail(). Authoritative. This is the
 *     only source that can carry administrator rights.
 *  2. SESSION - a server-side session row, established by exchanging a
 *     single-use invite code (see Session.gs). Identifies out-of-domain
 *     colleagues whose Google identity this deployment cannot read. Capped:
 *     never an administrator.
 *
 * There is NO third source and NO fallback. getEffectiveUser() is never
 * consulted: under executeAs: USER_DEPLOYING it always returns the publishing
 * account, so consulting it authenticates strangers as that administrator.
 *
 * When we cannot identify the caller we return an inert guest. Failing closed is
 * the whole point - every RPC except auth.me is refused for a guest.
 *
 * @param {string} cred     session id (preferred) or, on first load only, an invite code
 * @param {object} meta     { ua, lang, tz } client hints used to bind the session
 */
function whoAmI_(cred, meta) {
  var key = String(cred || '') + '|' + String((meta && meta.ua) || '');
  // Cache per credential, not globally: a guest resolved earlier in this
  // execution must never be handed back for a later authenticated call.
  if (_ME_CACHE && _ME_CACHE_KEY === key) return _ME_CACHE;

  var email = '';
  _IDENTITY_SOURCE = 'GOOGLE';
  try { email = (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) {}

  if (!email && cred) {
    // A session id is the normal case. An invite code reaching this point means
    // the browser replayed one instead of exchanging it in doGet; exchange is
    // deliberately NOT done here, because RPCs must not mint sessions.
    var viaSession = emailFromSession_(cred, meta);
    if (viaSession) { email = viaSession; _IDENTITY_SOURCE = 'SESSION'; }
  }

  if (!email) {
    _ME_CACHE_KEY = key;
    _ME_CACHE = { email: '', role: 'VIEWER', active: false, name: 'Guest',
                  pending: true, identitySource: 'NONE' };
    return _ME_CACHE;
  }

  var user = readTable_('USERS').filter(function(u) {
    return String(u.Email || '').toLowerCase() === email;
  })[0];

  if (!user) {
    // An unrecognised visitor gets NOTHING and no USERS row is created.
    //
    // The previous code auto-provisioned a PENDING row for any email that
    // reached this point. That was two problems at once: it let an outsider
    // write to the datastore just by loading the page, and it put a row in
    // USERS that an administrator could make ACTIVE without ever having decided
    // to grant access. Access now starts with an administrator adding the
    // person deliberately - never with the stranger's own page load.
    //
    // The one exception is genuine first-run bootstrap, and only for an address
    // on the hard-coded BOOTSTRAP_ADMINS allowlist. The old code promoted
    // WHOEVER ARRIVED FIRST to ADMIN whenever no active admin row existed,
    // which turned an empty or mis-edited USERS sheet into a full takeover.
    if (BOOTSTRAP_ADMINS.indexOf(email) !== -1) {
      var boot = {
        UserID: nextId_('USR'), Name: email.split('@')[0], Email: email, Mobile: '',
        Department: 'Operations', Designation: 'Admin', Role: 'ADMIN', AdminAccess: 'YES',
        LocationHead: '', Manager: '', Status: 'ACTIVE',
        CreatedAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy: 'system:bootstrap'
      };
      appendRow_('USERS', boot);
      invalidateTableCache_('USERS');
      logAudit_({ user: email, action: 'AUTH_BOOTSTRAP_ADMIN', entity: 'USERS',
        entityId: boot.UserID, oldValue: '', newValue: 'allowlisted bootstrap administrator' });
      user = boot;
    } else {
      try {
        logAudit_({ user: email, action: 'AUTH_UNKNOWN_VISITOR', entity: 'USERS', entityId: '',
          oldValue: _IDENTITY_SOURCE, newValue: 'no account - access refused, no row created' });
      } catch (e) {}
      _ME_CACHE_KEY = key;
      _ME_CACHE = { email: email, role: 'VIEWER', active: false, name: email.split('@')[0],
                    pending: false, unknown: true, identitySource: _IDENTITY_SOURCE };
      return _ME_CACHE;
    }
  }

  // Belt and braces. emailFromSession_ already refuses an administrator row, but
  // assert it here too so no future caller of whoAmI_ can bypass the ceiling.
  if (_IDENTITY_SOURCE === 'SESSION') assertNotPrivileged_(user, 'SESSION');

  _ME_CACHE_KEY = key;
  _ME_CACHE = {
    email: user.Email, name: user.Name, role: user.Role,
    active: String(user.Status || '') === 'ACTIVE',
    pending: String(user.Status || '') === 'PENDING',
    userId: user.UserID,
    locationHead: user.LocationHead || '',
    identitySource: _IDENTITY_SOURCE
  };
  return _ME_CACHE;
}

/**
 * Menu for a role. The escalation matrix lives behind Clients, so Clients is
 * hidden entirely from anyone outside the Operations branch roles - it is not
 * part of their job, and a menu that errors on click is worse than no menu.
 * Everyone gets My profile.
 */
function navForRole_(role, user) {
  var common = [{key:'dashboard', label:'Dashboard'}];
  var mine   = [{key:'profile', label:'My profile'}];
  var matrixOk = canUseMatrix_(user || { Role: role });
  var teamOk = hasTeam_(user || {});

  if (role === 'ADMIN') {
    return common.concat([
      {key:'clients', label:'Clients'},
      {key:'escalations', label:'Escalations'},
      {key:'warnings', label:'Warnings'},
      {key:'admin', label:'Admin'},
      {key:'logs', label:'Logs'}
    ]).concat(mine);
  }
  if (role === 'MANAGER') {
    return common
      .concat(matrixOk ? [{key:'clients', label:'Clients'}] : [])
      // Logs is the whole-business trail, so it is an admin view only.
      .concat([{key:'escalations', label:'Escalations'},
               {key:'warnings', label:'Warnings'}])
      .concat(mine);
  }
  if (role === 'LOCATION_HEAD') {
    return common
      .concat(matrixOk ? [{key:'clients', label:'My Clients'}] : [])
      .concat([{key:'escalations', label:'Escalations'},
               {key:'warnings', label:'Warnings'}])
      .concat(mine);
  }
  return common
    .concat(matrixOk ? [{key:'clients', label:'Matrix'}] : [])
    .concat([{key:'escalations', label:'Escalations'},
             {key:'warnings', label:'Warnings'}])
    .concat(mine);
}

function requestAccess_(payload, me) {
  // Department drives which designation list applies and whether this person is
  // part of the matrix journey at all, so capture it up front rather than
  // guessing later from a free-text job title.
  var email = me.email;
  if (!email) throw AuthError_('Please sign in with your Crux Google account.');
  // Department was being collected on the form and then dropped here, so it never
  // reached the sheet and nothing downstream could use it.
  var dept = String(payload.department || '').trim() || 'Operations';
  var desig = String(payload.designation || '').trim();
  var etype = String(payload.employeeType || '').trim().toUpperCase() === 'PARTNER' ? 'PARTNER' : 'EMPLOYEE';
  var patch = {
    Name: payload.name || me.name, Mobile: payload.mobile || '',
    Department: dept,
    Designation: desig,
    EmployeeType: etype,
    PartnerCompany: etype === 'PARTNER' ? String(payload.partnerCompany || '').trim() : '',
    EmployeeID: String(payload.employeeId || '').trim(),
    DateOfJoining: String(payload.dateOfJoining || '').trim(),
    Manager: String(payload.manager || '').trim().toLowerCase(),
    UpdatedAt: nowIso_(), UpdatedBy: email
  };
  updateRowById_('USERS', 'Email', email, patch);
  logAudit_({ user: email, action: 'REQUEST_ACCESS', entity: 'USERS', entityId: me.userId, oldValue:'', newValue: JSON.stringify(patch) });
  return { ok: true };
}

function listUsers_() { return readTable_('USERS'); }

function upsertUser_(payload, me) {
  var u = payload || {};
  if (!isEmail_(u.Email)) throw ValidationError_('Valid email is required.');
  // Role is no longer taken from the form. It is computed from the designation,
  // so the admin has one thing to set instead of two that could disagree.
  var dept = String(u.Department || 'Operations');
  var desig = String(u.Designation || '').trim();
  if (desig && orgDesignationsFor_(dept).indexOf(desig) === -1) {
    throw ValidationError_('"' + desig + '" is not a designation in ' + dept + '.');
  }
  var existing = findRowById_('USERS', 'Email', String(u.Email).toLowerCase());

  // Admin is granted by admins only. The route is already ADMIN-gated, but this
  // is checked here too so a direct call cannot smuggle the flag in.
  if (u.Manager && String(u.Manager).trim().toLowerCase() === String(u.Email).trim().toLowerCase()) {
    throw ValidationError_('A person cannot report to themselves.');
  }
  var wantAdmin = String(u.AdminAccess || '').trim().toUpperCase() === 'YES';
  var hadAdmin = hasAdminAccess_(existing || {});
  if (wantAdmin !== hadAdmin) {
    if (!hasAdminAccess_(userRow_(me))) {
      throw AuthError_('Only an administrator can change who has admin access.');
    }
    if (!wantAdmin) {
      // Never leave the tool with nobody who can administer it.
      var others = readTable_('USERS').filter(function(x) {
        return String(x.Email||'').toLowerCase() !== String(u.Email).toLowerCase() && hasAdminAccess_(x);
      });
      if (!others.length) throw ValidationError_('This is the only administrator. Grant admin to someone else first.');
    }
  }
  var patch = {
    Name: u.Name || '', Email: String(u.Email).toLowerCase(), Mobile: u.Mobile || '',
    // Department and EmployeeType were being sent by the admin form and dropped
    // here, so the hierarchy never reached the sheet and canUseMatrix_ read every
    // edited user as non-Operations.
    Department: u.Department || 'Operations',
    Designation: u.Designation || '',
    EmployeeType: String(u.EmployeeType || 'EMPLOYEE').toUpperCase() === 'PARTNER' ? 'PARTNER' : 'EMPLOYEE',
    AdminAccess: wantAdmin ? 'YES' : '',
    // Manager was never on the admin form, so the reporting chain could only be
    // set by editing the sheet directly. It is a picker now, and stored as email.
    Manager: String(u.Manager || '').trim().toLowerCase(),
    Role: roleForDesignation_(u.Department || 'Operations', u.Designation || '', u.Email, wantAdmin ? 'YES' : ''),
    LocationHead: u.LocationHead || '',
    // Org tagging. These drive userScope_ - without them a LOCATION_HEAD sees only
    // records they are personally named on, which is why a newly added client did
    // not appear for a zonal head.
    ScopeZones: u.ScopeZones || '', ScopeLocations: u.ScopeLocations || '',
    ScopeBranchIDs: u.ScopeBranchIDs || '', ScopeClientIDs: u.ScopeClientIDs || '',
    Manager: u.Manager || '', Status: u.Status || 'ACTIVE',
    UpdatedAt: nowIso_(), UpdatedBy: me.email
  };
  if (existing) {
    updateRowById_('USERS', 'Email', existing.Email, patch);
    logAudit_({ user: me.email, action: 'USER_UPDATE', entity: 'USERS', entityId: existing.UserID, oldValue: JSON.stringify(existing), newValue: JSON.stringify(patch) });
    return Object.assign({}, existing, patch);
  }
  patch.UserID = nextId_('USR'); patch.CreatedAt = nowIso_();
  appendRow_('USERS', patch);
  logAudit_({ user: me.email, action: 'USER_CREATE', entity: 'USERS', entityId: patch.UserID, oldValue:'', newValue: JSON.stringify(patch) });
  return patch;
}

/* ==================================================================
 * SCOPE RESOLVER - who can see which clients and branches.
 *
 * The old rule was a single equality: CLIENTS.DefaultLocationHead == my email.
 * That left two real roles unable to see anything:
 *   - a ZONAL manager, because zones were never mapped to people;
 *   - a BRANCH manager, because BranchManagerEmail granted no access at all.
 *
 * A user is in scope for a BRANCH when ANY of these is true:
 *   - the branch id is in their ScopeBranchIDs
 *   - the branch Zone is in their ScopeZones
 *   - the branch Location is in their ScopeLocations
 *   - they are its LocationHead, BranchManager, or Crux POC   <- no setup needed
 * ...and for a CLIENT when it is in ScopeClientIDs, they are its
 * DefaultLocationHead, or they can see any of its branches.
 * ================================================================== */
var _SCOPE_CACHE = null;

/**
 * What data may this person see?
 * Default is their own only. On top of that, a manager inherits everything
 * belonging to their reporting chain, at any depth - so a Zonal Manager sees the
 * Branch Managers and Partners under them without anyone maintaining a second list.
 */
function userScope_(me) {
  if (_SCOPE_CACHE && _SCOPE_CACHE._email === me.email) return _SCOPE_CACHE;
  if (me.role === 'ADMIN') return (_SCOPE_CACHE = { _email: me.email, all: true, chain: [] });

  var chain = visibleEmails_(me);                       // self + everyone below
  var chainSet = {};
  chain.forEach(function(x){ chainSet[x] = true; });

  var users = readTable_('USERS').filter(function(u) {
    return chainSet[String(u.Email || '').toLowerCase()];
  });

  var zones = {}, locs = {}, brIds = {}, clIds = {};
  var explicit = 0;
  users.forEach(function(u) {
    parseList_(u.ScopeZones).forEach(function(z){ zones[up_(z)] = true; explicit++; });
    parseList_(u.ScopeLocations).forEach(function(x){ locs[up_(x)] = true; explicit++; });
    parseList_(u.ScopeBranchIDs).forEach(function(x){ brIds[x] = true; explicit++; });
    parseList_(u.ScopeClientIDs).forEach(function(x){ clIds[x] = true; explicit++; });
  });

  var branchIds = {}, clientIds = {};
  Object.keys(brIds).forEach(function(k){ branchIds[k] = true; });
  Object.keys(clIds).forEach(function(k){ clientIds[k] = true; });

  readTable_('BRANCHES').forEach(function(b) {
    var hit = brIds[b.BranchID]
      || (Object.keys(zones).length && zones[up_(b.Zone)])
      || (Object.keys(locs).length && locs[up_(b.Location)])
      || chainSet[String(b.LocationHead || '').toLowerCase()]
      || chainSet[String(b.BranchManagerEmail || '').toLowerCase()]
      || chainSet[String(b.CruxPOCEmail || '').toLowerCase()];
    if (hit) { branchIds[b.BranchID] = true; clientIds[b.ClientID] = true; }
  });

  readTable_('CLIENTS').forEach(function(c) {
    if (clIds[c.ClientID] || chainSet[String(c.DefaultLocationHead || '').toLowerCase()]) {
      clientIds[c.ClientID] = true;
    }
  });

  // A client in scope carries its branches.
  readTable_('BRANCHES').forEach(function(b) {
    if (clientIds[b.ClientID]) branchIds[b.BranchID] = true;
  });

  var any = explicit || Object.keys(branchIds).length || Object.keys(clientIds).length;
  if (!any && (me.role === 'MANAGER' || me.role === 'VIEWER')) {
    // Legacy rows with no scope at all: keep them restricted to nothing rather
    // than silently granting everything, which is what the old code did.
    return (_SCOPE_CACHE = { _email: me.email, all: false, branchIds: {}, clientIds: {}, chain: chain });
  }
  return (_SCOPE_CACHE = {
    _email: me.email, all: false,
    branchIds: branchIds, clientIds: clientIds, chain: chain
  });
}

function scopeClientsForUser_(clients, me) {
  var sc = userScope_(me);
  if (sc.all) return clients;
  return clients.filter(function(c){ return !!sc.clientIds[c.ClientID]; });
}

function scopeBranchesForUser_(branches, me) {
  var sc = userScope_(me);
  if (sc.all) return branches;
  return branches.filter(function(b){ return !!sc.branchIds[b.BranchID]; });
}

function assertClientAccess_(client, me) {
  // CLIENTS is a shared master list. Admin creates them; every role may then
  // open one and maintain branches and matrices underneath it. Ownership is
  // enforced where it matters instead: only ADMIN can create or edit the client
  // record itself (route roles), and escalation visibility is filtered by
  // scopeEscalations_. Gating the client record here made it impossible for a
  // Location Head to add a branch to a client the admin had set up.
  if (!client) throw ValidationError_('Client not found.');
}

/**
 * Crux org chart. Two ladders.
 * OPERATIONS runs the escalation matrix: those people own branches and maintain
 * the 5 levels. Every other department only raises escalations and handles
 * warnings - they never see or edit a matrix.
 * Designation is what a person IS. Role is what the app LETS THEM DO. Keeping
 * them separate means a promotion is a designation change, not a permissions rewrite.
 */
var ORG_DEPARTMENTS = ['Operations', 'HR', 'Finance', 'IT', 'Admin', 'Sales', 'Other'];

var ORG_DESIGNATIONS = {
  Operations: ['Executive','Team Leader','Branch Manager','Partner','Zonal Manager','AVP','Operations Head','MD'],
  OTHER:      ['Executive','Team Leader','Manager','AVP','Operations Head','MD']
};

/** Designations that may own branches and edit an escalation matrix. */

function orgDesignationsFor_(department) {
  return ORG_DESIGNATIONS[String(department) === 'Operations' ? 'Operations' : 'OTHER'];
}


/**
 * Is this person part of the escalation matrix journey at all?
 * Non-Operations departments are not, by design.
 */


/**
 * Partners are not Crux employees. Operationally they sit where a Branch Manager
 * sits: they own a branch and maintain its escalation matrix. So they get the
 * same access as a Branch Manager, and are flagged separately for reporting.
 */
var PARTNER_DESIGNATION = 'Partner';

/**
 * The reporting chain. USERS.Manager points at the person above, so the chain is
 * built by walking downwards from a manager to everyone beneath them, at any depth.
 * Guards against a cycle - a bad Manager value must not hang the request.
 */
function reportsSubtree_(email) {
  var root = String(email || '').toLowerCase();
  if (!root) return [];
  var users = readTable_('USERS');
  var childrenOf = {};
  users.forEach(function(u) {
    var mgr = String(u.Manager || '').trim().toLowerCase();
    var self = String(u.Email || '').trim().toLowerCase();
    if (!mgr || !self || mgr === self) return;
    (childrenOf[mgr] = childrenOf[mgr] || []).push(self);
  });
  var out = [], seen = {}, queue = [root];
  seen[root] = true;
  var guard = 0;
  while (queue.length && guard++ < 5000) {
    var cur = queue.shift();
    (childrenOf[cur] || []).forEach(function(child) {
      if (seen[child]) return;
      seen[child] = true;
      out.push(child);
      queue.push(child);
    });
  }
  return out;
}

/** Everyone whose data this person may see: themselves plus their whole chain. */
function visibleEmails_(me) {
  var self = String(me.email || '').toLowerCase();
  return [self].concat(reportsSubtree_(self));
}


/** Look up the full USERS row for the signed-in person. */
function userRow_(me) {
  var e = String(me.email || '').toLowerCase();
  return readTable_('USERS').filter(function(u) {
    return String(u.Email || '').toLowerCase() === e;
  })[0] || {};
}

/** Server-side gate. Throws rather than relying on the menu being hidden. */
function assertMatrixAccess_(me) {
  if (!canUseMatrix_(userRow_(me))) {
    throw AuthError_('The escalation matrix is for Operations branch roles and partners. ' +
      'Your account uses escalations and warnings instead.');
  }
}

function parseList_(v) {
  return String(v || '').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
}
function up_(v) { return String(v || '').trim().toUpperCase(); }

/** Everyone, admin included, manages their own record here. */
function getProfile_(p, me) {
  var u = userRow_(me);
  var mgr = String(u.Manager || '');
  var reports = reportsSubtree_(me.email);
  var all = readTable_('USERS');
  var byEmail = {};
  all.forEach(function(x){ byEmail[String(x.Email||'').toLowerCase()] = x; });
  return {
    Name: u.Name || '', Email: u.Email || me.email, Mobile: u.Mobile || '',
    Department: u.Department || '', Designation: u.Designation || '',
    EmployeeType: u.EmployeeType || 'EMPLOYEE', PartnerCompany: u.PartnerCompany || '',
    EmployeeID: u.EmployeeID || '', DateOfJoining: u.DateOfJoining || '',
    Manager: mgr, Role: u.Role || me.role, Status: u.Status || '',
    canUseMatrix: canUseMatrix_(u),
    adminAccess: hasAdminAccess_(u),
    managerName: (byEmail[mgr.toLowerCase()] || {}).Name || '',
    departments: ORG_DEPARTMENTS,
    designations: ORG_DESIGNATIONS,
    // The chain below this person, so everyone can see their own team.
    team: reports.map(function(em) {
      var r = byEmail[em] || {};
      return { Name: r.Name || em, Email: em, Designation: r.Designation || '',
               Department: r.Department || '', EmployeeType: r.EmployeeType || 'EMPLOYEE' };
    })
  };
}

/**
 * Save your own details. Role, Status and scope are deliberately NOT editable
 * here - those are the admin's to set, or a user could promote themselves.
 */
function saveProfile_(p, me) {
  var email = String(me.email || '').toLowerCase();
  if (!email) throw AuthError_('Please sign in.');
  var dept = String(p.Department || '').trim() || 'Operations';
  var desig = String(p.Designation || '').trim();
  var allowed = orgDesignationsFor_(dept);
  if (desig && allowed.indexOf(desig) === -1) {
    throw ValidationError_('"' + desig + '" is not a designation in ' + dept + '. Choose one from the list.');
  }
  var mgr = String(p.Manager || '').trim().toLowerCase();
  if (mgr && !isEmail_(mgr)) throw ValidationError_('Reporting manager must be an email address.');
  if (mgr === email) throw ValidationError_('You cannot report to yourself.');
  var etype = String(p.EmployeeType || 'EMPLOYEE').toUpperCase() === 'PARTNER' ? 'PARTNER' : 'EMPLOYEE';

  var patch = {
    Name: String(p.Name || '').trim(), Mobile: String(p.Mobile || '').trim(),
    Department: dept, Designation: desig, EmployeeType: etype,
    PartnerCompany: etype === 'PARTNER' ? String(p.PartnerCompany || '').trim() : '',
    EmployeeID: String(p.EmployeeID || '').trim(),
    DateOfJoining: String(p.DateOfJoining || '').trim(),
    Manager: mgr, UpdatedAt: nowIso_(), UpdatedBy: email
  };
  // A user editing their own profile cannot change their admin access, so the
  // existing flag is carried forward rather than read from the payload.
  var mineNow = userRow_(me);
  patch.Role = roleForDesignation_(dept, desig, email, mineNow.AdminAccess || '');
  updateRowById_('USERS', 'Email', email, patch);
  _SCOPE_CACHE = null;
  invalidateTableCache_('USERS');
  logAudit_({ user: email, action: 'PROFILE_SAVE', entity: 'USERS', entityId: email,
    oldValue: '', newValue: JSON.stringify(patch) });
  return { ok: true, suggestedRole: suggestRoleFor_(dept, desig) };
}

/* ===================== TEAM MANAGEMENT =====================
 * A manager maintains the people who report to them. Everything here is guarded
 * by canManagePerson_, so you can only act on someone genuinely inside your own
 * reporting chain - not a peer, and not someone above you.
 * Records are additive: a PIP or an appreciation is a dated event, never an edit
 * of history, so the trail stays auditable.
 */

var EMPLOYMENT_STATUSES = ['ACTIVE','ON_LEAVE','TRANSFERRED','ON_NOTICE','INACTIVE','EXITED'];

/**
 * RESPONSIBILITY vs ACCOUNTABILITY.
 *
 * You are RESPONSIBLE for your DIRECT reports: their targets, achievements,
 * scores, PIPs, appreciations and warnings are yours to set. That is one level.
 *
 * You are ACCOUNTABLE for the whole chain beneath you: you can see it, and it
 * rolls into your own score, but you do not manage those people directly - their
 * own manager does. Skipping a level would undermine the manager in between.
 *
 * reportsSubtree_ therefore stays the basis for VISIBILITY and roll-up, and
 * directReports_ is the basis for ACTION.
 */
function directReports_(email) {
  var mgr = String(email || '').trim().toLowerCase();
  if (!mgr) return [];
  return readTable_('USERS')
    .filter(function(u) {
      var self = String(u.Email || '').trim().toLowerCase();
      return self && self !== mgr &&
             String(u.Manager || '').trim().toLowerCase() === mgr;
    })
    .map(function(u){ return String(u.Email).toLowerCase(); });
}

/** May I ACT on this person? Direct reports only. */
function canManagePerson_(me, targetEmail) {
  var t = String(targetEmail || '').toLowerCase();
  if (!t) return false;
  if (String(me.role) === 'ADMIN') return true;
  return directReports_(me.email).indexOf(t) !== -1;
}

/** May I SEE this person? Anyone in my chain. */
function canViewPerson_(me, targetEmail) {
  var t = String(targetEmail || '').toLowerCase();
  if (!t) return false;
  if (String(me.role) === 'ADMIN') return true;
  // Everyone can see their OWN record. This line was missing, so opening
  // My performance threw 'You cannot view that score' for every non-admin -
  // the person the score is about was the one person who could not read it.
  if (String(me.email || '').toLowerCase() === t) return true;
  return reportsSubtree_(me.email).indexOf(t) !== -1;
}

/**
 * TWO different reaches, deliberately.
 *
 * assertScoreManage_  - targets, achievement closure and scoring. DIRECT reports
 *   only: setting a target for someone two levels down would cut their own
 *   manager out of the job they are accountable for.
 *
 * assertPeopleReach_  - appreciation, PIP and warnings. The WHOLE tree beneath
 *   you. A zonal manager who sees poor conduct two levels down should be able to
 *   record it there and then, not route it through the intervening manager.
 */
function assertScoreManage_(me, targetEmail) {
  if (!canManagePerson_(me, targetEmail)) {
    var indirect = reportsSubtree_(me.email).indexOf(String(targetEmail||'').toLowerCase()) !== -1;
    throw AuthError_(indirect
      ? (targetEmail + ' does not report to you directly, so their own manager sets ' +
         'their targets and score. You remain accountable, and it reaches you through the roll-up.')
      : (targetEmail + ' does not report to you.'));
  }
  if (!canIssuePeopleActions_(userRow_(me)) && String(me.role) !== 'ADMIN') {
    throw AuthError_('Your designation has no team below it.');
  }
}

function assertPeopleReach_(me, targetEmail) {
  if (!canViewPerson_(me, targetEmail) ||
      String(me.email).toLowerCase() === String(targetEmail||'').toLowerCase()) {
    throw AuthError_(targetEmail + ' is not in your team.');
  }
  if (!canIssuePeopleActions_(userRow_(me)) && String(me.role) !== 'ADMIN') {
    throw AuthError_('Your designation has no team below it, so you cannot record ' +
      'warnings, plans or appreciations. You can still raise escalations and see your own targets.');
  }
}

/** Kept so older call sites keep working; scoring is the stricter of the two. */
function assertManage_(me, targetEmail) { return assertScoreManage_(me, targetEmail); }

/** The team, with this month's target and any open PIP folded in. */
function teamList_(p, me) {
  var emails = String(me.role) === 'ADMIN' && p && p.all
    ? readTable_('USERS').map(function(u){ return String(u.Email||'').toLowerCase(); })
    : reportsSubtree_(me.email);
  var set = {}; emails.forEach(function(e){ set[e] = true; });

  var mk = monthKey_(new Date());
  var targets = {};
  readTable_('TARGETS').forEach(function(t) {
    var tm = (t.MonthKey instanceof Date)
      ? Utilities.formatDate(t.MonthKey, getTz_(), 'yyyy-MM')
      : String(t.MonthKey == null ? '' : t.MonthKey).replace(/^'/,'').trim().slice(0,7);
    if (tm === mk) targets[String(t.PersonEmail||'').toLowerCase()] = t;
  });
  var openPip = {}, lastAppr = {};
  readTable_('PEOPLE_EVENTS').forEach(function(e) {
    var em = String(e.PersonEmail||'').toLowerCase();
    if (e.Type === 'PIP' && String(e.Status) === 'OPEN') openPip[em] = e;
    if (e.Type === 'APPRECIATION') lastAppr[em] = e.Timestamp;
  });
  var warn = {};
  readTable_('WARNINGS').forEach(function(w) {
    var em = String(w.PersonEmail||'').toLowerCase();
    if (!String(w.AcknowledgedAt||'').trim()) warn[em] = (warn[em] || 0) + 1;
  });

  return readTable_('USERS').filter(function(u) {
    return set[String(u.Email||'').toLowerCase()];
  }).map(function(u) {
    var em = String(u.Email||'').toLowerCase();
    var t = targets[em] || {};
    return {
      Name: u.Name || em, Email: u.Email, Mobile: u.Mobile || '',
      Department: u.Department || '', Designation: u.Designation || '',
      EmployeeType: u.EmployeeType || 'EMPLOYEE', PartnerCompany: u.PartnerCompany || '',
      EmployeeID: u.EmployeeID || '', DateOfJoining: u.DateOfJoining || '',
      EmploymentStatus: u.EmploymentStatus || 'ACTIVE',
      Manager: String(u.Manager || '').toLowerCase(), Role: u.Role || '', AccountStatus: u.Status || '',
      // direct = you manage them; indirect = you are accountable but do not act
      isDirect: String(u.Manager || '').toLowerCase() === String(me.email).toLowerCase(),
      // Process-compliance RAG for the WHOLE tree. Not to score people from two
      // levels up, but to see at a glance whether the system is being run:
      // targets set, achievements closed, scores completed on time.
      targetRag: ragTargets_(em, mk),
      scoreRag: ragScore_(em, mk),
      lastMonth: lastMonthSummary_(em, mk),
      targetsByCategory: targetsFor_(em, mk),
      MonthKey: mk, TargetValue: t.TargetValue || '', AchievedValue: t.AchievedValue || '',
      openPip: !!openPip[em],
      pipEnds: openPip[em] ? openPip[em].EndDate : '',
      openWarnings: warn[em] || 0,
      lastAppreciation: lastAppr[em] || ''
    };
  });
}

/** Add someone to my team, or correct their details. */
function teamUpsertMember_(p, me) {
  var email = String(p.Email || '').trim().toLowerCase();
  if (!isEmail_(email)) throw ValidationError_('A valid email address is required.');
  if (email === String(me.email).toLowerCase()) throw ValidationError_('You cannot add yourself to your own team.');

  var existing = readTable_('USERS').filter(function(u) {
    return String(u.Email||'').toLowerCase() === email;
  })[0];

  // Adding an existing person is allowed only if they already report to me,
  // otherwise a manager could silently take someone off another manager.
  if (existing && String(existing.Manager||'').toLowerCase() !== String(me.email).toLowerCase()) {
    assertManage_(me, email);
  }

  var dept = String(p.Department || 'Operations').trim();
  var desig = String(p.Designation || '').trim();
  var allowed = orgDesignationsFor_(dept);
  if (desig && allowed.indexOf(desig) === -1) {
    throw ValidationError_('"' + desig + '" is not a designation in ' + dept + '.');
  }
  var etype = String(p.EmployeeType||'EMPLOYEE').toUpperCase() === 'PARTNER' ? 'PARTNER' : 'EMPLOYEE';
  var estat = EMPLOYMENT_STATUSES.indexOf(String(p.EmploymentStatus||'ACTIVE')) === -1
    ? 'ACTIVE' : String(p.EmploymentStatus);

  var patch = {
    Name: String(p.Name||'').trim() || email,
    Email: email, Mobile: String(p.Mobile||'').trim(),
    Department: dept, Designation: desig, EmployeeType: etype,
    PartnerCompany: etype === 'PARTNER' ? String(p.PartnerCompany||'').trim() : '',
    EmployeeID: String(p.EmployeeID||'').trim(),
    DateOfJoining: String(p.DateOfJoining||'').trim(),
    EmploymentStatus: estat,
    Manager: String(me.email).toLowerCase(),
    UpdatedAt: nowIso_(), UpdatedBy: me.email
  };

  var created = false;
  patch.AdminAccess = existing ? (existing.AdminAccess || '') : '';
  patch.Role = roleForDesignation_(dept, desig, email, patch.AdminAccess);
  if (existing) {
    updateRowById_('USERS', 'Email', email, patch);
  } else {
    patch.UserID = nextId_('USR');
    // New people are inactive until an admin approves the account. The manager
    // sets up the record; the admin still controls who can sign in.
    patch.Status = 'PENDING';
    patch.ScopeZones = ''; patch.ScopeLocations = '';
    patch.ScopeBranchIDs = ''; patch.ScopeClientIDs = '';
    patch.CreatedAt = nowIso_();
    appendRow_('USERS', patch);
    created = true;
  }
  invalidateTableCache_('USERS'); _SCOPE_CACHE = null;
  logAudit_({ user: me.email, action: created ? 'TEAM_ADD' : 'TEAM_UPDATE', entity: 'USERS',
    entityId: email, oldValue: existing ? JSON.stringify(existing) : '', newValue: JSON.stringify(patch) });
  return { ok: true, created: created, Email: email,
           note: created ? 'Added. An admin must approve the account before they can sign in.' : 'Updated.' };
}

function teamSetStatus_(p, me) {
  var email = String(p.Email||'').toLowerCase();
  assertManage_(me, email);
  var st = String(p.EmploymentStatus||'');
  if (EMPLOYMENT_STATUSES.indexOf(st) === -1) throw ValidationError_('Unknown employment status.');
  var u = readTable_('USERS').filter(function(x){ return String(x.Email||'').toLowerCase() === email; })[0];
  var old = u ? u.EmploymentStatus : '';
  updateRowById_('USERS', 'Email', email, { EmploymentStatus: st, UpdatedAt: nowIso_(), UpdatedBy: me.email });
  peopleEvent_(email, 'STATUS_CHANGE', '', '', (old||'-') + ' to ' + st + (p.note ? '. ' + p.note : ''), me, 'CLOSED');
  invalidateTableCache_('USERS');
  return { ok: true, EmploymentStatus: st };
}

function peopleEvent_(email, type, start, end, notes, me, status) {
  var id = nextId_('PEV');
  appendRow_('PEOPLE_EVENTS', {
    EventID: id, Timestamp: nowIso_(), PersonEmail: email, Type: type,
    StartDate: start || '', EndDate: end || '', Notes: notes || '',
    IssuedBy: me.email, Status: status || 'OPEN', ClosedAt: '', Outcome: ''
  });
  logAudit_({ user: me.email, action: 'PEOPLE_' + type, entity: 'PEOPLE_EVENTS',
    entityId: id, oldValue: '', newValue: JSON.stringify({ person: email, type: type }) });
  return id;
}

/** Put someone on a Performance Improvement Plan for a fixed, dated window. */
function teamStartPip_(p, me) {
  var email = String(p.Email||'').toLowerCase();
  assertPeopleReach_(me, email);
  var start = String(p.StartDate||'').trim(), end = String(p.EndDate||'').trim();
  if (!start || !end) throw ValidationError_('A PIP needs a start date and an end date.');
  if (end <= start) throw ValidationError_('The end date must be after the start date.');
  var reason = String(p.Notes||'').trim();
  if (reason.length < 10) throw ValidationError_('Please record what the plan is for (at least 10 characters).');

  var already = readTable_('PEOPLE_EVENTS').filter(function(e) {
    return String(e.PersonEmail||'').toLowerCase() === email && e.Type === 'PIP' && String(e.Status) === 'OPEN';
  })[0];
  if (already) throw ValidationError_('This person already has an open PIP ending ' + already.EndDate + '.');

  var id = peopleEvent_(email, 'PIP', start, end, reason, me, 'OPEN');
  var sent = notifyPerson_(email, 'Performance improvement plan: ' + start + ' to ' + end,
    '<p>Dear ' + escHtml_(personName_(email)) + ',</p>' +
    '<p>A performance improvement plan has been recorded for you, running from <b>' +
    escHtml_(start) + '</b> to <b>' + escHtml_(end) + '</b>.</p>' +
    '<p><b>What this is about:</b><br>' + escHtml_(reason) + '</p>' +
    '<p>Your manager will review progress with you before the end date.</p>', me);
  return { ok: true, EventID: id, emailed: sent };
}

function teamClosePip_(p, me) {
  var id = String(p.EventID||'');
  var ev = readTable_('PEOPLE_EVENTS').filter(function(e){ return String(e.EventID) === id; })[0];
  if (!ev) throw ValidationError_('PIP not found.');
  assertManage_(me, ev.PersonEmail);
  var outcome = String(p.Outcome||'').trim();
  if (!outcome) throw ValidationError_('Record the outcome before closing the plan.');
  updateRowById_('PEOPLE_EVENTS','EventID',id,
    { Status:'CLOSED', ClosedAt: nowIso_(), Outcome: outcome });
  return { ok: true };
}

/** Appreciation. Same weight of record as a warning, opposite sign. */
function teamAppreciate_(p, me) {
  var email = String(p.Email||'').toLowerCase();
  assertPeopleReach_(me, email);
  var reason = String(p.Notes||'').trim();
  if (reason.length < 10) throw ValidationError_('Please say what they did well (at least 10 characters).');
  var id = peopleEvent_(email, 'APPRECIATION', ymd_(new Date()), '', reason, me, 'CLOSED');
  var sent = notifyPerson_(email, 'Thank you - appreciation recorded',
    '<p>Dear ' + escHtml_(personName_(email)) + ',</p>' +
    '<p>Your work has been recognised by ' + escHtml_(me.email) + '.</p>' +
    '<p>' + escHtml_(reason) + '</p><p>Thank you.</p>', me);
  return { ok: true, EventID: id, emailed: sent };
}

/**
 * Monthly target for ONE category. Revenue, Business Development and Collection
 * are tracked separately: a strong revenue month must not paper over a collection
 * miss, which is exactly what a single blended figure would allow.
 */
function teamSetTarget_(p, me) {
  var email = String(p.Email||'').toLowerCase();
  assertScoreManage_(me, email);
  var mk = String(p.MonthKey||'').trim() || monthKey_(new Date());
  if (!/^\d{4}-\d{2}$/.test(mk)) throw ValidationError_('Month must look like 2026-08.');
  var cat = String(p.Category || '').trim();
  var allowed = kpisFor_(email);
  if (allowed.indexOf(cat) === -1) {
    throw ValidationError_('"' + cat + '" is not one of their KPIs: ' + allowed.join(', ') + '.');
  }
  var num = function(v, label) {
    if (v === '' || v == null) return '';
    var n = Number(v);
    if (isNaN(n)) throw ValidationError_(label + ' must be a number.');
    if (n < 0) throw ValidationError_(label + ' cannot be negative.');
    return n;
  };
  var target = num(p.TargetValue, 'Target');
  var achieved = num(p.AchievedValue, 'Achievement');
  // Setting a target and closing an achievement are governed by different windows.
  if (target !== '') assertWindowOpen_('TARGET', email, mk, me);
  if (achieved !== '') assertWindowOpen_('ACHIEVEMENT', email, mk, me);

  // Which slice of the KPI this is. Both blank = the KPI's single unallocated
  // row, which is how every row written before allocations existed is shaped.
  var clientId = String(p.ClientID || '').trim();
  var subCat = String(p.SubCategory || '').trim();
  if (clientId) {
    var cli = findRowById_('CLIENTS', 'ClientID', clientId);
    if (!cli) throw ValidationError_('That client does not exist.');
    assertClientAccess_(cli, me);
  }
  if (subCat.length > 60) throw ValidationError_('Sub-category name is too long.');

  var all = readTable_('TARGETS');
  var sameKpi = all.filter(function(t) {
    return String(t.PersonEmail||'').toLowerCase() === email
      && monthOfValue_(t.MonthKey) === mk
      && String(t.Category || '') === cat;
  });
  var wantKey = clientId + '|' + subCat;
  var existing = sameKpi.filter(function(t){ return allocationKey_(t) === wantKey; })[0];

  // Section 14 ceiling. Counted before the write so the limit cannot be exceeded
  // by one, and only for a NEW slice - editing an existing one is always allowed.
  if (!existing && (clientId || subCat)) {
    var already = sameKpi.filter(function(t) {
      return String(t.ClientID || '').trim() || String(t.SubCategory || '').trim();
    }).length;
    if (already >= KPI_ALLOCATION_MAX) {
      throw ValidationError_('"' + cat + '" already has the maximum of ' +
        KPI_ALLOCATION_MAX + ' client allocations for ' + mk + '.');
    }
  }
  // Mixing a whole-KPI row with per-client slices would double count the KPI, so
  // the two shapes are mutually exclusive.
  if ((clientId || subCat) && sameKpi.some(function(t){ return allocationKey_(t) === '|'; })) {
    throw ValidationError_('"' + cat + '" currently has a single combined target. ' +
      'Remove it before splitting the KPI across clients.');
  }
  if (!clientId && !subCat && sameKpi.some(function(t){ return allocationKey_(t) !== '|'; })) {
    throw ValidationError_('"' + cat + '" is split across clients. ' +
      'Set the target on each client allocation rather than as one combined figure.');
  }

  var patch = { PersonEmail: email, MonthKey: "'" + mk, Category: cat,
                ClientID: clientId, SubCategory: subCat,
                TargetValue: target, AchievedValue: achieved,
                Notes: String(p.Notes||''), UpdatedBy: me.email, UpdatedAt: nowIso_() };
  if (existing) updateRowById_('TARGETS','TargetID',existing.TargetID, patch);
  else { patch.TargetID = nextId_('TGT'); appendRow_('TARGETS', patch); }
  invalidateTableCache_('TARGETS');
  logAudit_({ user: me.email, action:'TARGET_SET', entity:'TARGETS',
    entityId: email + '/' + mk + '/' + cat + (wantKey === '|' ? '' : '/' + wantKey),
    oldValue: existing ? JSON.stringify(existing) : '', newValue: JSON.stringify(patch) });
  return { ok: true, MonthKey: mk, Category: cat, ClientID: clientId, SubCategory: subCat };
}

/**
 * Remove one target row: either a single client allocation, or the combined
 * unallocated row for a KPI.
 *
 * Needed because a KPI cannot hold a combined figure and per-client slices at the
 * same time without double counting, so moving between the two shapes requires
 * removing what is there. Without this the manager reached a dead end: the error
 * told them to remove the combined target and nothing could.
 */
function teamRemoveTarget_(p, me) {
  var email = String(p.Email || '').toLowerCase();
  assertScoreManage_(me, email);
  var mk = String(p.MonthKey || '').trim() || monthKey_(new Date());
  var cat = String(p.Category || '').trim();
  var wantKey = String(p.ClientID || '').trim() + '|' + String(p.SubCategory || '').trim();

  var row = readTable_('TARGETS').filter(function(t) {
    return String(t.PersonEmail || '').toLowerCase() === email
      && monthOfValue_(t.MonthKey) === mk
      && String(t.Category || '') === cat
      && allocationKey_(t) === wantKey;
  })[0];
  if (!row) throw ValidationError_('That target line no longer exists.');

  // Removing a target changes a score, so it is bound by the same window as
  // setting one. Otherwise the window could be sidestepped by delete-and-recreate.
  assertWindowOpen_('TARGET', email, mk, me);
  if (String(row.ClosedAt || '').trim()) {
    throw ValidationError_('That target has been closed and can no longer be removed.');
  }

  deleteRowById_('TARGETS', 'TargetID', row.TargetID);
  invalidateTableCache_('TARGETS');
  logAudit_({ user: me.email, action: 'TARGET_REMOVE', entity: 'TARGETS',
    entityId: email + '/' + mk + '/' + cat + (wantKey === '|' ? '' : '/' + wantKey),
    oldValue: JSON.stringify(row), newValue: '' });
  return { ok: true, MonthKey: mk, Category: cat };
}

/** Everything a manager or the person needs to see the score and why. */
function getScore_(p, me) {
  var email = String(p.Email || me.email).toLowerCase();
  if (!canViewPerson_(me, email)) throw AuthError_('You cannot view that score.');
  var mk = String(p.MonthKey || monthKey_(new Date()));
  var computed = computeScore_(email, mk);
  var stored = readTable_('SCORES').filter(function(s) {
    return String(s.PersonEmail||'').toLowerCase() === email && monthOfValue_(s.MonthKey) === mk;
  })[0] || {};
  return {
    computed: computed,
    stored: stored,
    canScore: canManagePerson_(me, email) && String(me.email).toLowerCase() !== email,
    isSelf: String(me.email).toLowerCase() === email,
    // The person's ACTUAL KPIs, not the global default list. Returning the
    // constant meant a score screen for anybody on a custom KPI set showed the
    // three standard headings while the score underneath was computed from
    // theirs - two different answers on one page.
    categories: kpisFor_(email),
    orgDefaultCategories: TARGET_CATEGORIES,
    allocationMax: KPI_ALLOCATION_MAX
  };
}

/**
 * The manager completes the monthly review. Rating out of 10 plus all three
 * written sections are mandatory - a score with no explanation is not reviewable,
 * and the employee has a right to reject it on the strength of what it says.
 */
function saveScore_(p, me) {
  var email = String(p.Email||'').toLowerCase();
  assertManage_(me, email);
  if (String(me.email).toLowerCase() === email) throw ValidationError_('You cannot score yourself.');
  var mk = String(p.MonthKey || monthKey_(new Date()));
  var rating = Number(p.ManagerRating);
  if (isNaN(rating) || rating < 0 || rating > 10) throw ValidationError_('Rating must be between 0 and 10.');
  var need = [['Comments','Performance comments'],
              ['AreasOfImprovement','Areas of improvement'],
              ['NextMonthExpectations','Next month expectations']];
  need.forEach(function(f) {
    if (String(p[f[0]] || '').trim().length < 10) {
      throw ValidationError_(f[1] + ' is required (at least 10 characters).');
    }
  });

  var computed = computeScore_(email, mk);
  var existing = readTable_('SCORES').filter(function(s) {
    return String(s.PersonEmail||'').toLowerCase() === email && monthOfValue_(s.MonthKey) === mk;
  })[0];
  var patch = {
    PersonEmail: email, MonthKey: "'" + mk,
    TargetScore: computed.targetScore, AttributeScore: computed.attributeScore,
    FinalScore: computed.finalScore,
    OwnAttributePoints: Math.round((computed.attributeBreakdown.own||0)*100)/100,
    TeamAttributePoints: Math.round((computed.attributeBreakdown.team||0)*100)/100,
    ManagerRating: rating,
    Comments: String(p.Comments).trim(),
    AreasOfImprovement: String(p.AreasOfImprovement).trim(),
    NextMonthExpectations: String(p.NextMonthExpectations).trim(),
    Status: 'AWAITING_EMPLOYEE', ScoredBy: me.email, ScoredAt: nowIso_(),
    EmployeeDecision: '', DecisionAt: '', DecisionReason: '',
    HRStatus: '', HRNotes: '', ComputedAt: nowIso_()
  };
  if (existing) updateRowById_('SCORES','ScoreID',existing.ScoreID, patch);
  else { patch.ScoreID = nextId_('SCR'); appendRow_('SCORES', patch); }
  invalidateTableCache_('SCORES');

  // The ledger is rewritten for the month so it always matches the stored score.
  readTable_('SCORE_LEDGER').filter(function(r) {
    return String(r.PersonEmail||'').toLowerCase() === email && monthOfValue_(r.MonthKey) === mk;
  }).forEach(function(r){ try { deleteRowById_('SCORE_LEDGER','LedgerID',r.LedgerID); } catch(e){} });
  computed.ledger.forEach(function(row) {
    appendRow_('SCORE_LEDGER', {
      LedgerID: nextId_('LED'), PersonEmail: email, MonthKey: "'" + mk,
      Timestamp: nowIso_(), SourceType: row.SourceType, SourceID: row.SourceID,
      Reason: row.Reason, Component: row.Component, Delta: row.Delta,
      ScoreBefore: row.ScoreBefore, ScoreAfter: row.ScoreAfter, Sequence: row.Sequence
    });
  });
  invalidateTableCache_('SCORE_LEDGER');

  notifyPerson_(email, 'Your score for ' + mk + ' is ready to review',
    '<p>Dear ' + escHtml_(personName_(email)) + ',</p>' +
    '<p>Your manager has completed your review for <b>' + escHtml_(mk) + '</b>.</p>' +
    '<p><b>Final score: ' + computed.finalScore + ' / 100</b><br>' +
    'Target ' + computed.targetScore + ' of 75, attributes ' + computed.attributeScore + ' of 25.</p>' +
    '<p><b>Comments</b><br>' + escHtml_(patch.Comments) + '</p>' +
    '<p><b>Areas of improvement</b><br>' + escHtml_(patch.AreasOfImprovement) + '</p>' +
    '<p><b>Next month</b><br>' + escHtml_(patch.NextMonthExpectations) + '</p>' +
    '<p>Please open the portal to accept or reject it. You have one week.</p>', me);

  logAudit_({ user: me.email, action:'SCORE_SAVE', entity:'SCORES',
    entityId: email + '/' + mk, oldValue: existing ? JSON.stringify(existing) : '',
    newValue: JSON.stringify({ final: computed.finalScore, rating: rating }) });
  return { ok: true, score: computed.finalScore, ledgerRows: computed.ledger.length };
}

/**
 * A warning on a team member, with no escalation behind it - a branch manager
 * addressing conduct does not first raise a service escalation. Same record and
 * same lifecycle as any other warning; only the entry point differs.
 */
function teamWarn_(p, me) {
  var email = String(p.Email||'').toLowerCase();
  assertPeopleReach_(me, email);
  return createWarning_({
    personEmail: email, personName: personName_(email),
    escalationId: '', strikeLevel: p.StrikeLevel || 'MANUAL',
    category: p.Category || 'OTHER',
    reason: String(p.Notes || ''), cc: p.cc, source: 'TEAM',
    summary: 'Raised by ' + me.email + ' from the team page.',
    sendLetter: p.sendLetter !== false, me: me
  });
}

function personName_(email) {
  var u = readTable_('USERS').filter(function(x) {
    return String(x.Email||'').toLowerCase() === String(email).toLowerCase();
  })[0];
  return (u && u.Name) ? u.Name : String(email);
}

/** Best-effort notification. A mail failure must never lose the record itself. */
function notifyPerson_(email, subject, html, me) {
  try {
    sendEmail_({ type:'PEOPLE', to:[email], cc:[], subject: subject,
      htmlBody: html, trigger:'people.notify',
      idempotencyKey: 'PPL-' + email + '-' + nowIso_() });
    return true;
  } catch (e) {
    Logger.log('notifyPerson_ failed for ' + email + ': ' + e);
    return false;
  }
}

/* ================= WHAT SOMEONE CAN DO =================
 * Driven by DESIGNATION, not by a separate role an admin has to reason about.
 * Rank is seniority, and the one fact that matters is whether a person has a team.
 *
 *   Executive (rank 1) - no team. Read only. Raises and logs escalations and sees
 *     their own targets. Cannot edit clients, branches or matrices, and cannot
 *     issue a warning, PIP or appreciation to anyone.
 *   Rank 2 and up - has a team. All of the above, plus their own performance AND
 *     their direct reports' performance, plus warnings, PIPs and appreciations
 *     for that team.
 *   Operations, rank 2 and up - also maintains branches and escalation matrices.
 *     Other departments never see the matrix.
 *   Operations Head and MD - whole company, plus the Admin console.
 *
 * Role is now DERIVED and kept only so existing route guards keep working.
 * Nobody sets it by hand.
 */
var DESIGNATION_RANK = {
  'Executive': 1,
  'Team Leader': 2,
  'Branch Manager': 3,
  'Partner': 3,
  'Manager': 3,
  'Zonal Manager': 4,
  'AVP': 5,
  'Operations Head': 6,
  'MD': 7
};

function designationRank_(desig) {
  var r = DESIGNATION_RANK[String(desig || '').trim()];
  return r ? r : 1;   // blank or unrecognised gets the most limited access
}

/** Does anyone report to this person? */
function hasTeam_(user) {
  return designationRank_(user && (user.Designation || user.designation)) >= 2;
}

/** Single source of truth for access level. Derived, never typed. */
/**
 * Admin console access is its own thing. It is NOT a rung on the org ladder and
 * is never implied by a designation - an MD is not automatically an administrator
 * of this tool, and the AVP who runs it is. It is a single flag on the user row,
 * and only an existing admin can grant or revoke it (see upsertUser_).
 *
 * BOOTSTRAP_ADMINS exists so the system can never be locked out of itself: these
 * addresses are admins even if the flag is missing from their row.
 */
var BOOTSTRAP_ADMINS = [
  'shantanu.suravase@cruxindia.co.in',
  'operations.alert@cruxindia.co.in'
];

function hasAdminAccess_(user) {
  if (!user) return false;
  var em = String(user.Email || user.email || '').trim().toLowerCase();
  if (em && BOOTSTRAP_ADMINS.indexOf(em) !== -1) return true;
  return String(user.AdminAccess || user.adminAccess || '').trim().toUpperCase() === 'YES';
}

/**
 * Access level from designation. Deliberately caps at MANAGER: seniority decides
 * how much of the business you see, never whether you administer the tool.
 */
function roleForDesignation_(department, designation, email, adminAccess) {
  var em = String(email || '').trim().toLowerCase();
  if (hasAdminAccess_({ Email: em, AdminAccess: adminAccess })) return 'ADMIN';
  var rank = designationRank_(designation);
  if (rank >= 4) return 'MANAGER';               // Zonal Manager, AVP, and above
  if (rank >= 2) return 'LOCATION_HEAD';         // Team Leader, Branch Manager, Partner
  return 'VIEWER';                               // Executive
}

function suggestRoleFor_(department, designation, email, adminAccess) {
  return roleForDesignation_(department, designation, email, adminAccess);
}

/**
 * Clients and the escalation matrix: Operations, and only people with a team.
 * Team Leader was previously left out of a hand-maintained list, which is exactly
 * why two real Team Leaders could not see the Clients tab whatever else changed.
 * Ranking removes the second list that had to be kept in step.
 */
function canUseMatrix_(user) {
  if (!user) return false;
  if (hasAdminAccess_(user)) return true;
  if (String(user.EmployeeType || user.employeeType || '').toUpperCase() === 'PARTNER') return true;
  if (String(user.Department || user.department || '') !== 'Operations') return false;
  return hasTeam_(user);
}

/** Warnings, PIPs and appreciations are a manager action. */
function canIssuePeopleActions_(user) { return hasTeam_(user); }

/** Admin console. Flag only - designation never grants it. */
function isAdminDesignation_(user) { return hasAdminAccess_(user); }

/**
 * Everyone in the directory, for dropdowns. Free-text people fields were the
 * cause of records holding a NAME where an EMAIL was needed - the tool matches on
 * email, so a typed name silently matched nothing and had to be corrected in the
 * sheet by hand. A picker makes that mistake impossible.
 */
function userPickList_(p, me) {
  return readTable_('USERS')
    .filter(function(u){ return isEmail_(u.Email); })
    .map(function(u) {
      return {
        Email: String(u.Email).toLowerCase(),
        Name: u.Name || u.Email,
        Designation: u.Designation || '',
        Department: u.Department || '',
        Status: u.Status || ''
      };
    })
    .sort(function(a,b){ return String(a.Name).localeCompare(String(b.Name)); });
}

/* ==================== SCORING ENGINE ====================
 * ONE authoritative calculation. Escalations, warnings, appreciations and the
 * team roll-up all mutate the same two numbers here - if any of them got its own
 * calculation the totals would silently disagree, which is the failure this file
 * has already had to undo once with warnings.
 *
 * Final score = 75 target + 25 attribute.
 *
 * Sequence matters, and is applied in this order so the result is reproducible:
 *   1. target base      achievement % across categories, capped at 100, x0.75
 *   2. attribute base   own attributes, plus the team roll-up for managers
 *   3. appreciations    +1 attribute each, never above the 25 ceiling
 *   4. warnings         attribute to 0, then -5 target each
 *   5. escalations      -1 attribute each; once attribute is spent, -2 target each
 *   6. floor            neither component goes below 0
 *
 * Every step writes a ledger row with the value before and after.
 */
var TARGET_CATEGORIES = ['Revenue', 'Business Development', 'Collection'];
var SCORE_TARGET_WEIGHT = 75;
var SCORE_ATTRIBUTE_WEIGHT = 25;
var APPRECIATION_POINTS = 1;
var ESCALATION_ATTRIBUTE_PENALTY = 1;
var ESCALATION_TARGET_PENALTY = 2;
var WARNING_EXTRA_PENALTY = 5;

function monthOfValue_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, getTz_(), 'yyyy-MM');
  return String(v == null ? '' : v).replace(/^'/, '').trim().slice(0, 7);
}

/** Achievement across the three categories, as a percentage of target. */
/** Label for one allocation row. Blank ClientID and SubCategory = unallocated. */
function allocationKey_(t) {
  return String(t.ClientID || '').trim() + '|' + String(t.SubCategory || '').trim();
}

/**
 * Achievement per KPI, rolled up from its client allocations.
 *
 * A KPI may be split across clients (section 14). The KPI's target is the SUM of
 * its slices and its achievement is the SUM of theirs, so the percentage is
 * computed once at KPI level. Summing first and dividing once matters: averaging
 * the slice percentages would let a tiny fully-achieved allocation offset a large
 * missed one, which is not what a revenue target means.
 *
 * A KPI with no split has exactly one row with both allocation fields blank,
 * which is the shape of every row that predates allocations, so those keep
 * working untouched.
 */
function targetAchievement_(email, monthKey, rows) {
  var em = String(email).toLowerCase();
  var CATS = kpisFor_(em);
  var mine = (rows || readTable_('TARGETS')).filter(function(t) {
    return String(t.PersonEmail || '').toLowerCase() === em && monthOfValue_(t.MonthKey) === monthKey;
  });
  var clientName = {};
  try {
    readTable_('CLIENTS').forEach(function(c){ clientName[c.ClientID] = c.ClientName; });
  } catch (e) {}

  var per = [], detail = [];
  CATS.forEach(function(cat) {
    var slices = mine.filter(function(t){ return String(t.Category || '') === cat; });
    if (!slices.length) { detail.push({ Category: cat, set: false, allocations: [] }); return; }

    var tgt = 0, ach = 0, allocations = [], achRecorded = false;
    slices.forEach(function(r) {
      var st = Number(r.TargetValue), sa = Number(r.AchievedValue || 0);
      if (isNaN(st)) st = 0;
      if (isNaN(sa)) sa = 0;
      // "no achievement recorded yet" and "an achievement of zero" are different
      // facts: RAG counts a KPI as closed once an achievement exists, so treating
      // a blank as 0 would mark every unfilled KPI complete.
      if (String(r.AchievedValue === null || r.AchievedValue === undefined ? '' : r.AchievedValue).trim() !== '') {
        achRecorded = true;
      }
      tgt += st; ach += sa;
      allocations.push({
        ClientID: String(r.ClientID || ''),
        ClientName: clientName[String(r.ClientID || '')] || '',
        SubCategory: String(r.SubCategory || ''),
        target: st, achieved: sa,
        pct: st ? Math.round(Math.max(0, sa / st * 100)) : null
      });
    });
    allocations.sort(function(a, b) {
      return String(a.ClientName + a.SubCategory).localeCompare(String(b.ClientName + b.SubCategory));
    });
    var allocCount = allocations.filter(function(a) {
      return a.ClientID || a.SubCategory; }).length;
    if (!tgt) {
      detail.push({ Category: cat, set: false, achievedRecorded: achRecorded,
                    allocations: allocations, allocationCount: allocCount });
      return;
    }
    var pct = Math.max(0, ach / tgt * 100);
    per.push(Math.min(pct, 100));   // over-achievement does not subsidise a miss
    detail.push({ Category: cat, set: true, target: tgt, achieved: ach,
                  achievedRecorded: achRecorded,
                  pct: Math.round(pct), allocations: allocations,
                  allocationCount: allocCount });
  });
  // A person with no targets set scores 0 on the target component rather than
  // 100 - an unset target must never read as full marks.
  var avg = per.length ? (per.reduce(function(a,b){ return a+b; }, 0) / per.length) : 0;
  return { pct: avg, categories: detail, categoriesSet: per.length };
}

/**
 * The attribute base out of 25.
 * A manager with direct reports takes half from their own attributes and half
 * from the team pyramid - their reports' final scores, which already contain
 * their own roll-ups, so the whole pyramid propagates without double counting.
 */
function attributeBase_(email, monthKey, ctx) {
  ctx = ctx || { depth: 0, seen: {} };
  var em = String(email).toLowerCase();
  var ownRating = 0;
  var scoreRow = readTable_('SCORES').filter(function(s) {
    return String(s.PersonEmail || '').toLowerCase() === em && monthOfValue_(s.MonthKey) === monthKey;
  })[0];
  // ManagerRating is out of 10 and covers attendance, behaviour, teamwork and
  // people management. Unrated means unrated, not zero-rated, so it is neutral.
  if (scoreRow && String(scoreRow.ManagerRating || '').trim() !== '') {
    ownRating = Math.max(0, Math.min(10, Number(scoreRow.ManagerRating))) / 10;
  } else {
    ownRating = 1;
  }

  var reports = directReports_(em);
  if (!reports.length || ctx.depth >= 8) {
    return { points: ownRating * SCORE_ATTRIBUTE_WEIGHT, own: ownRating * SCORE_ATTRIBUTE_WEIGHT, team: 0, hasTeam: false };
  }

  var half = SCORE_ATTRIBUTE_WEIGHT / 2;
  var teamScores = [];
  reports.forEach(function(r) {
    if (ctx.seen[r]) return;                 // a bad Manager loop must not recurse forever
    ctx.seen[r] = true;
    var s = computeScore_(r, monthKey, { depth: ctx.depth + 1, seen: ctx.seen, noWrite: true });
    teamScores.push(s.finalScore);
  });
  var teamAvg = teamScores.length
    ? teamScores.reduce(function(a,b){ return a+b; }, 0) / teamScores.length : 0;
  return {
    points: (ownRating * half) + (teamAvg / 100 * half),
    own: ownRating * half,
    team: teamAvg / 100 * half,
    hasTeam: true,
    teamAverage: Math.round(teamAvg * 10) / 10,
    teamCount: teamScores.length
  };
}

function computeScore_(email, monthKey, ctx) {
  ctx = ctx || { depth: 0, seen: {} };
  var em = String(email).toLowerCase();
  var mk = String(monthKey || monthKey_(new Date()));
  var ledger = [], seq = 0;
  var note = function(type, id, reason, component, delta, before, after) {
    ledger.push({ SourceType: type, SourceID: id || '', Reason: reason,
                  Component: component, Delta: Math.round(delta * 100) / 100,
                  ScoreBefore: Math.round(before * 100) / 100,
                  ScoreAfter: Math.round(after * 100) / 100, Sequence: ++seq });
  };

  // 1. target
  var ach = targetAchievement_(em, mk);
  var target = Math.min(ach.pct, 100) / 100 * SCORE_TARGET_WEIGHT;
  note('TARGET', '', 'Achievement ' + Math.round(ach.pct) + '% across ' +
       ach.categoriesSet + ' categor' + (ach.categoriesSet === 1 ? 'y' : 'ies'),
       'TARGET', target, 0, target);

  // 2. attributes
  var ab = attributeBase_(em, mk, ctx);
  var attribute = Math.min(ab.points, SCORE_ATTRIBUTE_WEIGHT);
  note('ATTRIBUTE', '', ab.hasTeam
    ? ('Own attributes ' + Math.round(ab.own * 10) / 10 + ' + team roll-up ' + Math.round(ab.team * 10) / 10 +
       ' (' + ab.teamCount + ' direct report' + (ab.teamCount === 1 ? '' : 's') + ' averaging ' + ab.teamAverage + ')')
    : 'Own attributes', 'ATTRIBUTE', attribute, 0, attribute);



  var events = readTable_('PEOPLE_EVENTS').filter(function(e) {
    return String(e.PersonEmail || '').toLowerCase() === em &&
           monthOfValue_(e.Timestamp) === mk;
  });

  // 4. warnings - materially heavier than an escalation
  var warnings = readTable_('WARNINGS').filter(function(w) {
    return String(w.PersonEmail || '').toLowerCase() === em && monthOfValue_(w.IssuedAt) === mk;
  });
  if (warnings.length) {
    var wb = attribute;
    attribute = 0;
    note('WARNING', warnings[0].WarningID, 'A formal warning zeroes the attribute component',
         'ATTRIBUTE', -wb, wb, 0);
    warnings.forEach(function(w) {
      var tb = target;
      target = Math.max(0, target - WARNING_EXTRA_PENALTY);
      note('WARNING', w.WarningID, String(w.Notes || 'Warning').slice(0, 90),
           'TARGET', target - tb, tb, target);
    });
  }

  // 5. escalations - attribute first, then target once attribute is spent
  var escs = readTable_('ESCALATIONS').filter(function(e) {
    var against = String(e.AgainstEmail || '').toLowerCase();
    return against === em && monthOfValue_(e.CreatedAt || e.Date) === mk;
  });
  escs.forEach(function(e) {
    if (attribute > 0) {
      var ab2 = attribute;
      attribute = Math.max(0, attribute - ESCALATION_ATTRIBUTE_PENALTY);
      note('ESCALATION', e.EscalationID, String(e.Category || 'Escalation') + ' - ' + String(e.Status || ''),
           'ATTRIBUTE', attribute - ab2, ab2, attribute);
    } else {
      var tb2 = target;
      target = Math.max(0, target - ESCALATION_TARGET_PENALTY);
      note('ESCALATION', e.EscalationID, String(e.Category || 'Escalation') +
           ' - attribute exhausted, deducted from target',
           'TARGET', target - tb2, tb2, target);
    }
  });

  // 6. appreciations LAST, so they genuinely offset deductions.
  //
  // Applied before the deductions they were worthless: almost everyone starts at
  // the 25 ceiling, so every appreciation was immediately clipped and recognition
  // had no effect on any score. Applying them after means recognition actually
  // recovers ground lost to escalations - which is the whole point of counting it.
  //
  // A warning is the exception. It is meant to be materially more serious than an
  // escalation, so once a warning exists in the month the attribute component
  // stays at zero and appreciation cannot quietly undo it.
  var apprEvents = events.filter(function(e){ return e.Type === 'APPRECIATION'; });
  if (warnings.length) {
    if (apprEvents.length) {
      note('APPRECIATION', '', apprEvents.length + ' appreciation(s) recorded, but a warning ' +
           'this month holds the attribute component at zero', 'ATTRIBUTE', 0, 0, 0);
    }
  } else {
    apprEvents.forEach(function(e) {
      var b4 = attribute;
      attribute = Math.min(SCORE_ATTRIBUTE_WEIGHT, attribute + APPRECIATION_POINTS);
      note('APPRECIATION', e.EventID, String(e.Notes || 'Appreciation').slice(0, 90),
           'ATTRIBUTE', attribute - b4, b4, attribute);
    });
  }

  var r2 = function(n){ return Math.round(n * 100) / 100; };
  return {
    PersonEmail: em, MonthKey: mk,
    targetScore: r2(Math.max(0, target)),
    attributeScore: r2(Math.max(0, attribute)),
    finalScore: r2(Math.max(0, target) + Math.max(0, attribute)),
    achievement: ach, attributeBreakdown: ab,
    escalations: escs.length, warnings: warnings.length,
    appreciations: apprEvents.length,
    ledger: ledger
  };
}

/**
 * The employee accepts or rejects their score. Rejection needs a reason, brings
 * HR in, and raises an escalation so it enters the normal lifecycle and the
 * 3-strike engine rather than sitting in a side channel.
 */
function decideScore_(p, me) {
  var mk = String(p.MonthKey || monthKey_(new Date()));
  var em = String(me.email).toLowerCase();
  var row = readTable_('SCORES').filter(function(s) {
    return String(s.PersonEmail||'').toLowerCase() === em && monthOfValue_(s.MonthKey) === mk;
  })[0];
  if (!row) throw ValidationError_('There is no score for you for ' + mk + ' yet.');
  if (String(row.Status) !== 'AWAITING_EMPLOYEE') {
    throw ValidationError_('That score has already been ' + String(row.Status || 'closed').toLowerCase() + '.');
  }
  var decision = String(p.Decision || '').toUpperCase();
  if (['ACCEPT','REJECT'].indexOf(decision) === -1) throw ValidationError_('Choose accept or reject.');
  var reason = String(p.Reason || '').trim();
  if (decision === 'REJECT' && reason.length < 10) {
    throw ValidationError_('Please say why you are rejecting the score (at least 10 characters).');
  }

  updateRowById_('SCORES','ScoreID',row.ScoreID, {
    Status: decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
    EmployeeDecision: decision, DecisionAt: nowIso_(), DecisionReason: reason,
    HRStatus: decision === 'REJECT' ? 'OPEN' : ''
  });
  invalidateTableCache_('SCORES');

  var escId = '';
  if (decision === 'REJECT') {
    // Goes through the existing escalation engine, so reminders, ageing and the
    // 3-strike policy all apply without a parallel workflow.
    var hr = String(getSetting_('HR_EMAIL','') || '').trim();
    var res = logEscalationCase_({
      ClientID: '', Category: 'HR', Severity: 'High',
      EscalatedAgainst: row.ScoredBy, AgainstEmail: row.ScoredBy,
      Description: 'Score rejected for ' + mk + ' by ' + em + '. Reason: ' + reason,
      RequiredAction: 'HR to review the rating, discuss with both parties and close.',
      TargetDate: ymd_(new Date(new Date().getTime() + 7*86400000))
    }, me);
    escId = res.EscalationID || (res.escalation && res.escalation.EscalationID) || '';
    notifyPerson_(row.ScoredBy, 'Score rejected for ' + mk,
      '<p>' + escHtml_(personName_(em)) + ' has rejected the score you recorded for ' +
      escHtml_(mk) + '.</p><p><b>Their reason</b><br>' + escHtml_(reason) + '</p>' +
      '<p>HR has been informed and escalation ' + escHtml_(escId) + ' has been raised.</p>', me);
    if (isEmail_(hr)) {
      notifyPerson_(hr, 'Score rejection to review - ' + personName_(em) + ' (' + mk + ')',
        '<p>' + escHtml_(personName_(em)) + ' has rejected their score for ' + escHtml_(mk) + '.</p>' +
        '<p><b>Scored by</b> ' + escHtml_(row.ScoredBy) + '<br>' +
        '<b>Final score</b> ' + escHtml_(String(row.FinalScore)) + ' / 100</p>' +
        '<p><b>Reason given</b><br>' + escHtml_(reason) + '</p>' +
        '<p>Escalation ' + escHtml_(escId) + ' is open for this.</p>', me);
    }
  }
  logAudit_({ user: em, action:'SCORE_' + decision, entity:'SCORES', entityId: row.ScoreID,
    oldValue: String(row.Status||''), newValue: decision + (escId ? (' / ' + escId) : '') });
  return { ok: true, decision: decision, escalationId: escId };
}

/** HR closes a rejected score, optionally revising the rating. */
function hrCloseScore_(p, me) {
  if (!hasAdminAccess_(userRow_(me)) &&
      String(userRow_(me).Department || '') !== 'HR') {
    throw AuthError_('Only HR or an administrator can close a rejected score.');
  }
  var row = readTable_('SCORES').filter(function(s){ return String(s.ScoreID) === String(p.ScoreID); })[0];
  if (!row) throw ValidationError_('Score not found.');
  var notes = String(p.HRNotes || '').trim();
  if (notes.length < 10) throw ValidationError_('Record what HR concluded (at least 10 characters).');
  var patch = { HRStatus: 'CLOSED', HRNotes: notes, Status: 'CLOSED_BY_HR' };
  if (p.RevisedRating !== '' && p.RevisedRating != null) {
    var r = Number(p.RevisedRating);
    if (isNaN(r) || r < 0 || r > 10) throw ValidationError_('Revised rating must be between 0 and 10.');
    patch.ManagerRating = r;
    var re = computeScore_(String(row.PersonEmail).toLowerCase(), monthOfValue_(row.MonthKey));
    patch.TargetScore = re.targetScore; patch.AttributeScore = re.attributeScore;
    patch.FinalScore = re.finalScore; patch.ComputedAt = nowIso_();
  }
  updateRowById_('SCORES','ScoreID',row.ScoreID, patch);
  invalidateTableCache_('SCORES');
  logAudit_({ user: me.email, action:'SCORE_HR_CLOSE', entity:'SCORES', entityId: row.ScoreID,
    oldValue: String(row.HRStatus||''), newValue: JSON.stringify(patch) });
  return { ok: true };
}

/* ============ INVITATIONS ============
 * Some colleagues have personal Gmail addresses rather than Workspace accounts.
 * Widening the deployment alone does not help them: with executeAs USER_DEPLOYING,
 * Session.getActiveUser() returns EMPTY for anyone outside the domain, so they
 * would fail closed and still be unable to sign in.
 *
 * Each such person therefore gets a personal invite link carrying a long random
 * INVITE CODE. The code is SINGLE-USE and SHORT-LIVED: opening the link exchanges
 * it for a server-side session and burns the code (see Session.gs). It is not a
 * standing credential, so a forwarded invite email is inert, and it can never
 * yield administrator rights.
 *
 * The previous design treated this column as a permanent bearer token matched on
 * every request. That is what allowed anyone holding the URL - including a
 * non-Crux address - to open the tool as its owner, an administrator included.
 */
function newAccessToken_() {
  var raw = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)).replace(/=+$/, '');
}

/**
 * Resolve a visitor from an INVITE CODE, without consuming it.
 *
 * This is now a read-only predicate used by the self-test and by admin screens.
 * It is deliberately NOT part of the sign-in path: authenticating on a bare
 * invite code is precisely what let a leaked URL impersonate its owner forever.
 * Sign-in goes through exchangeInviteCode_() -> a session (see Session.gs).
 *
 * Administrator rows resolve to '' here, matching the ceiling enforced at
 * exchange time, so no caller can use this to reach an administrator identity.
 */
function emailFromToken_(token) {
  var t = String(token || '').trim();
  if (t.length < 20) return '';
  var u = readTable_('USERS').filter(function(x) {
    return String(x.AccessToken || '').trim() === t;
  })[0];
  if (!u) return '';
  if (String(u.Status || '') !== 'ACTIVE') return '';
  if (String(u.InviteStatus || '').toUpperCase() === 'REVOKED') return '';
  if (String(u.InviteStatus || '').toUpperCase() === 'USED') return '';
  if (hasAdminAccess_(u) || String(u.Role || '').toUpperCase() === 'ADMIN') return '';
  return String(u.Email || '').toLowerCase();
}

/**
 * Invite someone, or re-send their link. Records the event and never mints a
 * second live token for the same person - a resend reuses the existing one so an
 * older email keeps working.
 */
function inviteUser_(p, me) {
  if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can invite users.');
  var email = String(p.Email || '').trim().toLowerCase();
  if (!isEmail_(email)) throw ValidationError_('A valid email address is required.');
  var u = readTable_('USERS').filter(function(x) {
    return String(x.Email || '').toLowerCase() === email;
  })[0];
  if (!u) throw ValidationError_('Add them as a user first, then invite them.');
  // An administrator cannot be given a link: a link identity is capped below
  // administrator (Session.gs), so the link would only ever be refused. Say so
  // here rather than emailing somebody a credential that cannot work.
  if (hasAdminAccess_(u) || String(u.Role || '').toUpperCase() === 'ADMIN') {
    throw ValidationError_(
      'Administrators sign in with their Crux Google account, so they do not need ' +
      'a personal link. Remove admin access first if a link is genuinely required.');
  }

  // A resend always mints a FRESH code, because the previous one is single-use
  // and may already be spent. Reusing a spent code is what made "resend" appear
  // to work while the recipient still could not get in.
  var reissue = p.reissue === true;
  var token = newAccessToken_();

  updateRowById_('USERS', 'Email', email, {
    AccessToken: token, InvitedAt: nowIso_(), InviteStatus: 'SENT',
    Status: String(u.Status || '') === 'PENDING' ? 'ACTIVE' : (u.Status || 'ACTIVE'),
    UpdatedAt: nowIso_(), UpdatedBy: me.email
  });
  invalidateTableCache_('USERS');

  var base = String(getSetting_('APP_URL', '') || ScriptApp.getService().getUrl() || '').trim();
  var link = base + (base.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(token);
  var name = u.Name || email;

  var sent = notifyPerson_(email, 'Your Crux Escalation Matrix account is ready',
    '<p>Dear ' + escHtml_(name) + ',</p>' +
    '<p>Your profile on the Crux Escalation Matrix is now active.</p>' +
    '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-size:14px">' +
    '<tr><td><b>Name</b></td><td>' + escHtml_(name) + '</td></tr>' +
    '<tr><td><b>Department</b></td><td>' + escHtml_(u.Department || '-') + '</td></tr>' +
    '<tr><td><b>Designation</b></td><td>' + escHtml_(u.Designation || '-') + '</td></tr>' +
    '<tr><td><b>Reports to</b></td><td>' + escHtml_(u.Manager || '-') + '</td></tr>' +
    '</table>' +
    '<p><a href="' + escHtml_(link) + '" style="background:#17150f;color:#fff;padding:10px 18px;' +
    'border-radius:4px;text-decoration:none;display:inline-block">Open the portal</a></p>' +
    '<p style="color:#666;font-size:12px">This link is personal to you and can be used <b>once</b>. ' +
    'It stops working after ' + INVITE_CODE_VALID_DAYS + ' days, or as soon as you have opened it. ' +
    'Please do not forward it. If it is shared by mistake, tell your administrator and they will issue a new one.</p>', me);

  logAudit_({ user: me.email, action: reissue ? 'INVITE_REISSUE' : 'INVITE_SEND', entity: 'USERS',
    entityId: email, oldValue: String(u.InviteStatus || ''), newValue: 'SENT' });
  return { ok: true, emailed: sent, link: link, reissued: reissue };
}

/** Revoke a personal link without removing the account. */
function revokeInvite_(p, me) {
  if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can revoke a link.');
  var email = String(p.Email || '').trim().toLowerCase();
  updateRowById_('USERS', 'Email', email,
    { AccessToken: '', InviteStatus: 'REVOKED', UpdatedAt: nowIso_(), UpdatedBy: me.email });
  invalidateTableCache_('USERS');
  // Clearing the code alone left anyone already signed in with a working
  // session, so "revoke" did not actually end their access. Kill both.
  var killed = revokeSessionsFor_(email, me.email);
  logAudit_({ user: me.email, action:'INVITE_REVOKE', entity:'USERS', entityId: email,
    oldValue:'SENT', newValue:'REVOKED; sessions ended: ' + killed.revoked });
  return { ok: true, sessionsEnded: killed.revoked };
}

/* ---------- RAG helpers for team process compliance ---------- */

function prevMonthKey_(mk) {
  var y = Number(String(mk).slice(0,4)), m = Number(String(mk).slice(5,7));
  m -= 1; if (m < 1) { m = 12; y -= 1; }
  return y + '-' + (m < 10 ? '0' : '') + m;
}

/**
 * Per-KPI targets for one person and month, for the profile and the team list.
 *
 * Delegates the roll-up to targetAchievement_, which is the one place that knows
 * how client allocations sum into a KPI. This used to take the FIRST TARGETS row
 * per category, so once a KPI was split across clients it displayed one arbitrary
 * slice as though it were the whole target - while scoring used the correct total.
 * Two different answers from two implementations of the same question.
 */
function targetsFor_(email, mk) {
  var em = String(email).toLowerCase();
  var d = targetAchievement_(em, mk);
  return (d.categories || []).map(function(c) {
    return {
      Category: c.Category,
      target: c.set ? c.target : '',
      // Blank, not 0, when nothing has been recorded - ragTargets_ counts a KPI
      // as closed on `achieved !== ''`.
      achieved: c.achievedRecorded ? c.achieved : '',
      pct: c.set ? c.pct : null,
      allocations: c.allocations || [],
      allocationCount: c.allocationCount || 0
    };
  });
}

/** RED nothing set, AMBER partly set, GREEN all three set. */
function ragTargets_(email, mk) {
  var t = targetsFor_(email, mk);
  var set = t.filter(function(x){ return x.target !== '' && x.target > 0; }).length;
  var closed = t.filter(function(x){ return x.achieved !== ''; }).length;
  var total = t.length || 1;
  return {
    status: set === 0 ? 'RED' : (set < total ? 'AMBER' : 'GREEN'),
    set: set, of: total, closed: closed,
    label: set === 0 ? 'no targets set'
      : (set < total ? (set + ' of ' + total + ' set')
      : (closed === total ? 'set and closed' : 'all set, ' + closed + ' closed'))
  };
}

/** RED unscored or rejected, AMBER awaiting the employee, GREEN accepted. */
function ragScore_(email, mk) {
  var em = String(email).toLowerCase();
  var s = readTable_('SCORES').filter(function(x) {
    return String(x.PersonEmail||'').toLowerCase() === em && monthOfValue_(x.MonthKey) === mk;
  })[0];
  if (!s) return { status:'RED', label:'not scored', score:'' };
  var st = String(s.Status || '');
  var map = { AWAITING_EMPLOYEE:['AMBER','awaiting employee'], ACCEPTED:['GREEN','accepted'],
              REJECTED:['RED','rejected'], CLOSED_BY_HR:['AMBER','closed by HR'] };
  var hit = map[st] || ['AMBER', st.toLowerCase() || 'in progress'];
  return { status: hit[0], label: hit[1], score: s.FinalScore };
}

function lastMonthSummary_(email, mk) {
  var pm = prevMonthKey_(mk);
  var t = targetsFor_(email, pm);
  var done = t.filter(function(x){ return x.pct !== null; });
  var avg = done.length ? Math.round(done.reduce(function(a,b){ return a + b.pct; }, 0) / done.length) : null;
  var sc = ragScore_(email, pm);
  return { monthKey: pm, achievementPct: avg, score: sc.score,
           scoreStatus: sc.status, scoreLabel: sc.label };
}

/* ============ TARGET AND ACHIEVEMENT WINDOWS ============
 * Targets must be set by the 5th, achievements closed by the 3rd. Each window
 * opens a week before its deadline and closes the day after, so there is a
 * defined period rather than an open-ended one.
 *
 * Enforced HERE, in the service, not in the form. A date check in the browser is
 * a suggestion; this is the rule. An admin can reopen a window for one person,
 * and that reopening is audited because it is an exception to a stated policy.
 */
var TARGET_DEADLINE_DAY = 5;
var ACHIEVEMENT_DEADLINE_DAY = 3;
var WINDOW_OPENS_DAYS_BEFORE = 7;

function windowState_(kind, now) {
  now = now || new Date();
  var day = Number(Utilities.formatDate(now, getTz_(), 'd'));
  var deadline = kind === 'TARGET' ? TARGET_DEADLINE_DAY : ACHIEVEMENT_DEADLINE_DAY;
  var closesAfter = deadline + 1;

  // The window spans the last days of the previous month through the deadline,
  // so 'seven days before the 5th' really means the 29th onward.
  var opensOnOrAfter = deadline - WINDOW_OPENS_DAYS_BEFORE;   // may be negative
  var open;
  if (opensOnOrAfter >= 1) {
    open = day >= opensOnOrAfter && day <= closesAfter;
  } else {
    var lastDay = Number(Utilities.formatDate(
      new Date(now.getFullYear(), now.getMonth() + 1, 0), getTz_(), 'd'));
    open = (day >= (lastDay + opensOnOrAfter)) || (day <= closesAfter);
  }
  return {
    kind: kind, open: open, today: day, deadlineDay: deadline, closesAfterDay: closesAfter,
    label: open
      ? (kind === 'TARGET' ? 'Target window is open until the ' : 'Achievement window is open until the ') + closesAfter
      : (kind === 'TARGET' ? 'Target window is closed. It opens on the ' : 'Achievement window is closed. It opens on the ') +
        (opensOnOrAfter >= 1 ? opensOnOrAfter : ('末 ' + Math.abs(opensOnOrAfter) + ' days before month end'))
  };
}

/** An admin may grant one person an exception. Recorded, never silent. */
function windowOverrideKey_(kind, email, monthKey) {
  return 'WINOVR:' + kind + ':' + String(email).toLowerCase() + ':' + monthKey;
}

/**
 * THE window reopen/re-close handler. Admin only, always audited.
 *
 * There were two of these: grantWindowOverride_ and reopenWindow_, both bound to
 * the RPC key 'windows.reopen'. The second binding silently won, so the richer
 * handler was dead code - and it referenced an undefined WINDOW_RULES global, so
 * it would have thrown ReferenceError had it ever been reached. Worse, it wrote
 * the override value as 'OPEN' while assertWindowOpen_ tests for the 'OPEN:'
 * prefix, so even its happy path would not have reopened anything.
 *
 * One handler now, with the behaviour that was wanted from both: validation,
 * re-close, notification, and the value format the guard actually reads.
 *
 * Policy (section 11): an admin may reopen a closed window only up to the 15th
 * of the MONTH AFTER the month being reopened. After that the record is settled
 * and reopening needs a higher authority that this tool does not model.
 */
var WINDOW_KINDS = {
  TARGET:      { label: 'target setting' },
  ACHIEVEMENT: { label: 'achievement update' }
};
var REOPEN_CUTOFF_DAY = 15;

/** Is `monthKey` still reopenable today? Returns {allowed, reason}. */
function reopenAllowedFor_(monthKey, now) {
  now = now || new Date();
  var m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
  if (!m) return { allowed: false, reason: 'That month is not a valid period.' };
  var y = Number(m[1]), mo = Number(m[2]);           // mo is 1-12
  // Cutoff = the 15th of the following month, end of day.
  var cutoff = new Date(y, mo, REOPEN_CUTOFF_DAY, 23, 59, 59);
  if (now.getTime() <= cutoff.getTime()) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: 'The window for ' + monthKey + ' can no longer be reopened. Reopening is ' +
            'permitted only until the ' + REOPEN_CUTOFF_DAY + 'th of the following month.'
  };
}

function grantWindowOverride_(p, me) {
  if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can reopen a window.');
  var kind = String(p.Kind || 'TARGET').toUpperCase();
  if (!WINDOW_KINDS[kind]) throw ValidationError_('Choose target setting or achievement update.');
  var email = String(p.Email || '').trim().toLowerCase();
  var mk = String(p.MonthKey || monthKey_(new Date()));
  var reason = String(p.Reason || '').trim();
  var close = p.Close === true;
  if (!isEmail_(email)) throw ValidationError_('Choose a person.');
  if (reason.length < 10) throw ValidationError_('Record why this window is being reopened (at least 10 characters).');

  // Re-closing is always allowed - withdrawing an exception can never be the
  // unsafe direction. Only granting one is time-limited.
  if (!close) {
    var gate = reopenAllowedFor_(mk);
    if (!gate.allowed) throw ValidationError_(gate.reason);
  }

  var key = windowOverrideKey_(kind, email, mk);
  var before = String(getSetting_(key, '') || '');
  // Value format matters: assertWindowOpen_ tests for the 'OPEN:' prefix.
  // It also carries who granted it and why, so the exception is self-describing
  // in SETTINGS without a join.
  var value = close ? '' : ('OPEN:' + me.email + ':' + nowIso_() + ':' + reason);
  setSetting_(key, value, me.email);

  logAudit_({
    user: me.email, action: close ? 'WINDOW_CLOSE' : 'WINDOW_REOPEN', entity: 'SETTINGS',
    entityId: key,
    oldValue: before,
    newValue: JSON.stringify({ kind: kind, forPerson: email, monthKey: mk,
                               reason: reason, by: me.email, at: nowIso_() })
  });

  if (!close) {
    notifyPerson_(email,
      'Your ' + WINDOW_KINDS[kind].label + ' window for ' + mk + ' has been reopened',
      '<p>Dear ' + escHtml_(personName_(email)) + ',</p>' +
      '<p>An administrator has reopened your <b>' + escHtml_(WINDOW_KINDS[kind].label) +
      '</b> window for <b>' + escHtml_(mk) + '</b>.</p>' +
      '<p><b>Reason given</b><br>' + escHtml_(reason) + '</p>' +
      '<p>Please complete it as soon as you can.</p>', me);
  }
  return { ok: true, kind: kind, monthKey: mk, forPerson: email, reopened: !close };
}

function assertWindowOpen_(kind, email, monthKey, me) {
  // Admins are not bound by the window; everyone else is, unless granted an
  // explicit exception for this person and month.
  if (hasAdminAccess_(userRow_(me))) return;
  var ovr = String(getSetting_(windowOverrideKey_(kind, email, monthKey), '') || '');
  if (ovr.indexOf('OPEN:') === 0) return;
  var w = windowState_(kind);
  if (!w.open) {
    throw ValidationError_(w.label + '. Ask an administrator to reopen it for this person if it is genuinely needed.');
  }
}

function windowStatus_(p, me) {
  return { target: windowState_('TARGET'), achievement: windowState_('ACHIEVEMENT') };
}

/** Which windows are open right now. The UI uses this to explain itself. */
function myWindows_(p, me) {
  var mk = String((p && p.MonthKey) || monthKey_(new Date()));
  return {
    monthKey: mk,
    target: windowState_('TARGET', mk),
    achievement: windowState_('ACHIEVEMENT', mk),
    isAdmin: hasAdminAccess_(userRow_(me))
  };
}

/* ==================== CONFIGURABLE KPIs ====================
 * Revenue, Business Development and Collection are the DEFAULTS, not the law.
 * A manager decides what their people are actually measured on - a collections
 * team and a sales team should not carry the same three headings.
 *
 * Up to five per person. Five is a deliberate ceiling: beyond that the weighting
 * of any single KPI becomes too small to change behaviour, and the monthly
 * conversation stops being about priorities.
 */
var KPI_DEFAULTS = ['Revenue', 'Business Development', 'Collection'];
var KPI_MAX = 5;
// Each KPI may be divided across up to this many client / sub-category slices
// (section 14). Counted per person, per month, per KPI.
var KPI_ALLOCATION_MAX = 50;

/** The KPIs this person is measured on, in order. */
function kpisFor_(email) {
  var em = String(email || '').toLowerCase();
  var rows = readTable_('KPI_DEFS').filter(function(k) {
    return String(k.Active || 'YES').toUpperCase() !== 'NO';
  });
  var mine = rows.filter(function(k){ return String(k.PersonEmail||'').toLowerCase() === em && em; });
  var org  = rows.filter(function(k){ return !String(k.PersonEmail||'').trim(); });
  var use = mine.length ? mine : org;
  if (!use.length) return KPI_DEFAULTS.slice();
  return use
    .sort(function(a,b){ return (Number(a.Position)||0) - (Number(b.Position)||0); })
    .map(function(k){ return String(k.Category); })
    .filter(function(c, i, arr){ return c && arr.indexOf(c) === i; })
    .slice(0, KPI_MAX);
}

/**
 * Set the KPI list. Scope is one person, or every DIRECT report at once.
 * Bulk is deliberately limited to direct reports: setting what somebody two
 * levels down is measured on is their own manager's call.
 */
function setKpis_(p, me) {
  var list = (p.Categories || []).map(function(c){ return String(c).trim(); }).filter(Boolean);
  list = list.filter(function(c,i,a){ return a.indexOf(c) === i; });
  if (!list.length) throw ValidationError_('Give at least one KPI.');
  if (list.length > KPI_MAX) throw ValidationError_('A maximum of ' + KPI_MAX + ' KPIs. You gave ' + list.length + '.');
  list.forEach(function(c) {
    if (c.length < 2) throw ValidationError_('"' + c + '" is too short to be a KPI name.');
    if (c.length > 40) throw ValidationError_('"' + c.slice(0,20) + '..." is too long. Keep KPI names short.');
  });

  var targets = [];
  if (p.Scope === 'TEAM') {
    targets = directReports_(me.email);
    if (!targets.length) throw ValidationError_('You have no direct reports to apply this to.');
  } else if (p.Scope === 'ORG') {
    if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can change the organisation default.');
    targets = [''];   // blank email is the org default
  } else {
    var one = String(p.Email || '').trim().toLowerCase();
    if (!isEmail_(one)) throw ValidationError_('Choose a person.');
    assertScoreManage_(me, one);   // KPIs drive scoring, so this is direct-report only
    targets = [one];
  }

  var existing = readTable_('KPI_DEFS');
  targets.forEach(function(t) {
    existing.filter(function(k){ return String(k.PersonEmail||'').toLowerCase() === t; })
      .forEach(function(k){ try { deleteRowById_('KPI_DEFS','KpiID',k.KpiID); } catch(e){} });
    list.forEach(function(c, i) {
      appendRow_('KPI_DEFS', {
        KpiID: nextId_('KPI'), PersonEmail: t, Category: c, Position: i + 1,
        Active: 'YES', UpdatedBy: me.email, UpdatedAt: nowIso_()
      });
    });
  });
  invalidateTableCache_('KPI_DEFS');
  logAudit_({ user: me.email, action:'KPI_SET', entity:'KPI_DEFS',
    entityId: (p.Scope || 'PERSON') + ':' + targets.join(','),
    oldValue: '', newValue: list.join(' | ') });
  return { ok: true, applied: targets.length, categories: list,
           scope: p.Scope || 'PERSON' };
}

/** What a manager needs to render the KPI editor. */
function getKpis_(p, me) {
  var em = String(p.Email || me.email).toLowerCase();
  return {
    Email: em,
    categories: kpisFor_(em),
    orgDefault: kpisFor_(''),
    max: KPI_MAX,
    allocationMax: KPI_ALLOCATION_MAX,
    isCustom: readTable_('KPI_DEFS').some(function(k) {
      return String(k.PersonEmail||'').toLowerCase() === em;
    }),
    canEdit: canManagePerson_(me, em),
    canSetOrg: hasAdminAccess_(userRow_(me)),
    directReports: directReports_(me.email).length
  };
}
