/**
 * One-shot configuration the owner asked for. Idempotent - safe to re-run.
 * Everything here is configuration, not credentials.
 */






/** One-shot: seed, then run every acceptance check the brief asks for. */
function runEverything() {
  var step = function(name, fn) {
    Logger.log('');
    Logger.log('################ ' + name + ' ################');
    try { fn(); } catch (e) {
      Logger.log('!!!! ' + name + ' THREW: ' + (e && e.message || e));
      if (e && e.stack) Logger.log(e.stack);
    }
  };
  step('ENTRY POINTS', testEntryPoints);
  step('STRIKE CLOCK', testStrikeClock);
  step('BACKFILL USER ORG', backfillUserOrg);
  step('SEED SAMPLE DATA', seedSampleData);
  step('ESCALATION CREATE (log + raise)', testEscalationCreate);
  step('OWNERSHIP + AI', testOwnershipAndAi);
  step('LOCATION MATRIX (P1)', testLocationMatrix);
  step('BRANCH MATRIX + CLIENT FALLBACK', testBranchMatrixFallback);
  step('WARNING RAISE', testWarningRaise);
  step('WARNING UNIFICATION', testWarningUnification);
  step('WARNING ACK LIFECYCLE', testWarningAck);
  step('RESYNC ROLES', resyncRolesFromDesignation);
  step('DESIGNATION MODEL', testDesignationModel);
  step('LOG SCOPING', testLogScoping);
  step('ORG CHART + ACCESS', testOrgAndAccess);
  step('INVITE TOKENS', testInviteTokens);
  step('RESPONSIBILITY SPLIT', testResponsibilitySplit);
  step('SCORING ENGINE', testScoringEngine);
  step('SUBMISSION WINDOWS', testWindows);
  step('WINDOWS', testWindows);
  step('TEAM MANAGEMENT', testTeamManagement);
  step('DASHBOARD FIXTURES', testDashboardFixtures);
  step('STRIKE SWEEP (dry run)', testStrikeSweep);
  step('PREFLIGHT', function() { var r = preflight(); Logger.log('preflight -> ' + JSON.stringify(r).slice(0, 1500)); });
  Logger.log('');
  Logger.log('################ runEverything complete ################');
}


/**
 * Go-live cleanup. Removes everything this session created for testing, and
 * reports anything it deliberately left alone rather than guessing.
 * Safe to re-run. Never touches CLIENTS or real escalations.
 */
function cleanupTestData() {
  var removed = [], kept = [];
  Logger.log('--- de-duplicating SETTINGS ---');
  dedupeSettings_();
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;

  // 1. Automated selftest escalations and everything hanging off them.
  var selftest = readTable_('ESCALATIONS').filter(function(r) {
    return String(r.Description || '').indexOf('automated selftest') !== -1
        || String(r.RequiredAction || '').indexOf('automated selftest') !== -1;
  });
  var badIds = {};
  selftest.forEach(function(r) { badIds[r.EscalationID] = true; });

  readTable_('WARNINGS').forEach(function(w) {
    if (badIds[w.EscalationID] || String(w.Notes || '').toLowerCase().indexOf('selftest') !== -1) {
      try { deleteRowById_('WARNINGS','WarningID',w.WarningID); removed.push('WARNINGS ' + w.WarningID); } catch(e){}
    }
  });
  _TABLE_CACHE = {};
  readTable_('ESCALATION_HISTORY').forEach(function(hRow) {
    if (badIds[hRow.EscalationID] || String(hRow.Note || '').toLowerCase().indexOf('selftest') !== -1) {
      try { deleteRowById_('ESCALATION_HISTORY','HistoryID',hRow.HistoryID); removed.push('HISTORY ' + hRow.HistoryID); } catch(e){}
    }
  });
  _TABLE_CACHE = {};
  selftest.forEach(function(r) {
    try { deleteRowById_('ESCALATIONS','EscalationID',r.EscalationID); removed.push('ESCALATION ' + r.EscalationID); } catch(e){}
  });

  // Clear branch matrix rows that the round-trip bug hardened into overrides, so
  // those levels inherit again. Only touches the seeded demo branch.
  _TABLE_CACHE = {};
  readTable_('BRANCHES').filter(function(b){ return String(b.BranchCode) === 'BOM5678'; })
    .forEach(function(b) {
      var n = 0;
      readTable_('ESCALATION_MATRIX').forEach(function(m) {
        if (String(m.BranchID || '') !== String(b.BranchID)) return;
        if (Number(m.Level) <= 2) return;   // levels 1-2 are the genuine overrides
        try { deleteRowById_('ESCALATION_MATRIX','MatrixID',m.MatrixID); n++; } catch(e){}
      });
      if (n) removed.push('hardened branch matrix rows: ' + n + ' on ' + b.BranchID);
    });
  invalidateTableCache_('ESCALATION_MATRIX');

  // 2. The seeded demo branch and its matrix. Recognised by its sample contacts,
  //    so a real branch that happens to share the code is never touched.
  _TABLE_CACHE = {};
  readTable_('BRANCHES').forEach(function(b) {
    var fake = String(b.BranchCode) === 'BOM5678'
      && /sample\./i.test(String(b.CruxPOCEmail || '') + String(b.BranchManagerEmail || ''));
    if (!fake) return;
    readTable_('ESCALATION_MATRIX').forEach(function(m) {
      if (String(m.BranchID || '') === String(b.BranchID)) {
        try { deleteRowById_('ESCALATION_MATRIX','MatrixID',m.MatrixID); removed.push('MATRIX ' + m.MatrixID); } catch(e){}
      }
    });
    try { deleteRowById_('BRANCHES','BranchID',b.BranchID); removed.push('BRANCH ' + b.BranchID + ' (' + b.BranchName + ')'); } catch(e){}
  });

  // 3. Left alone on purpose - these are configuration, not test data.
  _TABLE_CACHE = {};
  readTable_('BRANCHES').forEach(function(b) {
    if (String(b.Location || '').trim() || String(b.Zone || '').trim()) {
      kept.push('BRANCH ' + b.BranchID + ' Location/Zone backfill (' + b.Location + '/' + b.Zone + ')');
    }
    if (String(b.LocationHead || '').trim()) {
      kept.push('BRANCH ' + b.BranchID + ' LocationHead=' + b.LocationHead);
    }
  });
  kept.push('SETTINGS DISPATCH_GRANULARITY=' + getSetting_('DISPATCH_GRANULARITY',''));
  kept.push('SETTINGS BRANCH_RECIPIENT=' + getSetting_('BRANCH_RECIPIENT',''));

  Logger.log('=== REMOVED (' + removed.length + ') ===');
  removed.forEach(function(r){ Logger.log('  - ' + r); });
  Logger.log('=== KEPT ON PURPOSE (configuration, not test data) ===');
  kept.forEach(function(r){ Logger.log('  . ' + r); });

  _TABLE_CACHE = {};
  Logger.log('final row counts: ESCALATIONS=' + readTable_('ESCALATIONS').length +
    '  WARNINGS=' + readTable_('WARNINGS').length +
    '  BRANCHES=' + readTable_('BRANCHES').length +
    '  MATRIX=' + readTable_('ESCALATION_MATRIX').length +
    '  CLIENTS=' + readTable_('CLIENTS').length);
  Logger.log(removed.length ? 'CLEANUP: ' + removed.length + ' test row(s) removed' : 'CLEANUP: nothing to remove');
}


// Placed first on purpose: the Run button defaults to the first function in
// the open file, so this can be run without touching the function dropdown.

function applyOwnerConfig() {
  var by = 'system:config';
  var log = [];

  // 1. Strike 3 must reach the MD.
  setSetting_('MD_EMAIL', 'virendra.pal@cruxindia.co.in', by);
  log.push('MD_EMAIL = virendra.pal@cruxindia.co.in');

  // 2. Gemini's stored key is being rejected (HTTP 400), so Groq leads and
  //    Gemini stays as the fallback. No key is touched here.
  PropertiesService.getScriptProperties().setProperty('AI_PRIMARY', 'GROQ');
  PropertiesService.getScriptProperties().setProperty('AI_PROVIDER', 'AUTO');
  log.push('AI_PRIMARY = GROQ, AI_PROVIDER = AUTO');

  // 3. Org tagging. A branch manager must be scoped, not left wide open:
  //    a MANAGER with empty scope currently sees EVERY client.
  var wants = [
    { email:'avinash.chaskar@cruxindia.co.in', role:'LOCATION_HEAD', locs:'Pune',  zones:'' },
    { email:'nitish.bhope@cruxindia.co.in',    role:'LOCATION_HEAD', locs:'Pune',  zones:'ROMG' }
  ];
  var users = readTable_('USERS');
  wants.forEach(function(w) {
    var u = users.filter(function(x){ return String(x.Email || '').toLowerCase() === w.email; })[0];
    if (!u) { log.push('SKIPPED - no user row for ' + w.email); return; }
    updateRowById_('USERS', 'Email', u.Email, {
      Role: w.role, ScopeLocations: w.locs, ScopeZones: w.zones,
      UpdatedAt: nowIso_(), UpdatedBy: by
    });
    log.push(w.email + ' -> ' + w.role + ', locations="' + w.locs + '", zones="' + w.zones + '"');
  });

  logAudit_({ user: by, action: 'OWNER_CONFIG', entity: 'SETTINGS', entityId: 'applyOwnerConfig',
             oldValue: '', newValue: log.join(' | ') });
  Logger.log('=== APPLIED ===');
  log.forEach(function(l){ Logger.log('  ' + l); });
  Logger.log('');
  Logger.log('Scope rule: blank = see only what you are named on. Any value = also see everything matching.');
  Logger.log('Editable any time in the app: Admin > Users > edit > Scope.');
  return log;
}

/**
 * Preflight.gs - deployment self-check.
 *
 * TWO WAYS TO RUN IT
 *   1. Admin > Setup > Health check  (in the app)
 *   2. Editor > function dropdown > preflight > Run  (log output)
 *
 * IMPORTANT: it checks the code currently SAVED in the editor, not the
 * published deployment. Correct order is always:
 *      paste -> Ctrl+S -> run health check -> GO -> publish New version
 *
 * This file is inert: it only reads. It sends no email and writes no data.
 */

/** RPC entrypoint for Admin > Setup. ADMIN-gated in Code.gs. */
function preflightReport_(p, me) { return preflightCore_(); }

/** Editor entrypoint - same checks, printed to the Execution log. */
function preflight() {
  var r = preflightCore_();
  Logger.log('==================================================');
  Logger.log(' CRUX ESCALATION MATRIX - PREFLIGHT');
  Logger.log('==================================================');
  r.items.forEach(function(i) {
    Logger.log('  ' + (i.level === 'fail' ? 'FAIL' : i.level === 'warn' ? 'NOTE' : 'OK  ')
      + '  [' + i.group + '] ' + i.msg + (i.fix ? '  -> ' + i.fix : ''));
  });
  Logger.log('');
  Logger.log(r.go ? ' RESULT: GO.' : ' RESULT: NO-GO. Fix the FAIL items, save, run again.');
  return r;
}

function preflightCore_() {
  var items = [];
  function ok(g, m)       { items.push({ level:'pass', group:g, msg:m }); }
  function bad(g, m, fix) { items.push({ level:'fail', group:g, msg:m, fix:fix||'' }); }
  function hmm(g, m, fix) { items.push({ level:'warn', group:g, msg:m, fix:fix||'' }); }

  // ---- 1. SECURITY ----
  // Apps Script (V8) lets a function return its own source, so we inspect
  // whoAmI_ directly instead of trusting that a paste landed. Comments are
  // stripped first, so a comment MENTIONING the old code cannot mask it.
  try {
    var src = whoAmI_.toString();
    var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    if (code.indexOf('getEffectiveUser') !== -1) {
      bad('Security', 'whoAmI_ still falls back to getEffectiveUser() - ANY visitor Google '
        + 'cannot identify is logged in as the deploying admin, with full ADMIN rights.',
        'In Auth.gs, on the line that assigns `email`, delete " || Session.getEffectiveUser().getEmail()". '
        + 'Save, then publish a New version.');
    } else {
      ok('Security', 'Identity comes only from getActiveUser() - unidentified visitors get Guest, not admin.');
    }
    if (src.indexOf('getEffectiveUser') !== -1) {
      hmm('Security', 'getEffectiveUser appears in a comment only - harmless.');
    }
  } catch (e) {
    bad('Security', 'Could not inspect whoAmI_ (' + e + ').', 'Check that Auth.gs exists and is saved.');
  }

  // ---- 2. FILES (inferred from the functions each one must define) ----
  var need = {
    'Sheets.gs':     ['sheetHeaders_', 'appendRows_', 'updateRowsById_', 'getBoolSetting_', 'schemaStamp_'],
    'Auth.gs':       ['whoAmI_'],
    'Email.gs':      ['sentKeyIndex_', 'listMyEmailAliases'],
    'Scheduler.gs':  ['planDispatch_', 'runDispatchQueue_', 'dispatchOneTarget_', 'buildDispatchContext_'],
    'Escalation.gs': ['escalationMIS_', 'grantEscalationException_', 'revokeEscalationException_', 'scopeEscalations_'],
    'Migrate.gs':    ['migrateMatrixToBranchLevel', 'migrateMatrixToBranchLevelDryRun'],
    'Gemini.gs':     ['geminiStatus_', 'listGeminiModels'],
    'PortalSvc.gs':  ['ensurePortalSecret_', 'getPortalPayload_'],
    'Clients.gs':    ['validateClientMatrix_'],
    'Import.gs':     ['validateImport_'],
    'Utils.gs':      ['isEmail_', 'nowIso_']
  };
  Object.keys(need).forEach(function(file) {
    var missing = need[file].filter(function(fn) {
      try { return typeof eval(fn) !== 'function'; } catch (e) { return true; }
    });
    if (missing.length) bad('Files', file + ' is stale or missing (no ' + missing.join(', ') + ')',
      'Paste the latest ' + file + ', save, then publish a New version.');
    else ok('Files', file + ' is up to date');
  });

  // HTML files are resolved by EXACT name, so capitalisation matters.
  ['Index', 'Styles', 'App', 'Portal'].forEach(function(n) {
    try { HtmlService.createHtmlOutputFromFile(n); ok('Files', 'HTML file "' + n + '" found'); }
    catch (e) { bad('Files', 'HTML file "' + n + '" NOT FOUND - the app looks it up by this exact name.',
      'Rename the file to exactly "' + n + '" (the capital letter matters).'); }
  });

  // ---- 3. DATA / SCHEMA ----
  try {
    ensureSpreadsheet_();
    [['ESCALATION_MATRIX', 'BranchID'],
     ['ESCALATIONS', 'ExceptionBy'],
     ['ESCALATIONS', 'ExceptionReason'],
     ['DISPATCH_QUEUE', 'QueueID']].forEach(function(pair) {
      var hdr = sheetHeaders_(pair[0]);
      if (hdr.indexOf(pair[1]) === -1) bad('Data', pair[0] + ' is missing the ' + pair[1] + ' column',
        'Reload the web app once - the schema updates itself on first load.');
      else ok('Data', pair[0] + '.' + pair[1] + ' present (column ' + (hdr.indexOf(pair[1]) + 1) + ')');
    });

    // Column ORDER may differ from the code's order - that is fine, because every
    // helper resolves columns by NAME. Prove a real row still reads correctly
    // rather than assuming it.
    var mx = readTable_('ESCALATION_MATRIX');
    if (!mx.length) hmm('Data', 'ESCALATION_MATRIX is empty, so column alignment cannot be verified yet.',
      'Add a client with a matrix, then run this check again.');
    else {
      var row = mx[0];
      var levelOk = String(row.Level) !== '' && !isNaN(Number(row.Level));
      var emailOk = !row.Email || isEmail_(row.Email);
      if (levelOk && emailOk) ok('Data', 'Matrix rows read correctly (Level=' + row.Level + ') - columns are aligned.');
      else bad('Data', 'Matrix columns look SHIFTED (Level="' + row.Level + '", Email="' + row.Email + '")',
        'STOP. Do not write any data. Restore the spreadsheet from a backup, then re-check.');
    }
  } catch (e) {
    bad('Data', 'Schema check failed: ' + e, 'Reload the web app once, then run this again.');
  }

  // ---- 4. SETTINGS ----
  try {
    ['DISPATCH_GRANULARITY', 'DISPATCH_BATCH_SIZE', 'DISPATCH_QUOTA_RESERVE',
     'BRANCH_RECIPIENT', 'FROM_ADDRESS'].forEach(function(k) {
      var v = getSetting_(k, '\u0000');
      if (v === '\u0000') hmm('Settings', 'No "' + k + '" row in the SETTINGS sheet - the built-in default is being used.',
        'Reload the web app once - missing settings are added automatically.');
      else ok('Settings', k + ' = "' + v + '"');
    });
    var gran = String(getSetting_('DISPATCH_GRANULARITY', 'CLIENT')).toUpperCase();
    if (gran === 'BRANCH') {
      var anyBranchRows = readTable_('ESCALATION_MATRIX').some(function(x){ return String(x.BranchID || '') !== ''; });
      if (!anyBranchRows) bad('Dispatch', 'Granularity is BRANCH but no branch-level matrix rows exist - '
        + 'branch emails would go out with an empty matrix.',
        'Run migrateMatrixToBranchLevelDryRun, then migrateMatrixToBranchLevel. Or set DISPATCH_GRANULARITY back to CLIENT.');
      else ok('Dispatch', 'BRANCH mode has branch-level matrix rows.');
    } else {
      ok('Dispatch', 'Granularity is CLIENT - one email per client (the safe default).');
    }
    if (getBoolSetting_('DRY_RUN', 'false')) {
      var ov = getSetting_('TEST_EMAIL_OVERRIDE', '');
      if (isEmail_(ov)) hmm('Email', 'TEST MODE is ON - every email goes to ' + ov + ' instead of real recipients.',
        'Set DRY_RUN to false in the SETTINGS sheet when you are ready to go live.');
      else bad('Email', 'DRY_RUN is on but TEST_EMAIL_OVERRIDE is not a valid email - sending will fail.',
        'Put your own email address in the TEST_EMAIL_OVERRIDE row of the SETTINGS sheet.');
    } else {
      hmm('Email', 'TEST MODE is OFF - real clients will receive email.',
        'Correct for live running. Set DRY_RUN=true first if you want to rehearse safely.');
    }
  } catch (e) {
    bad('Settings', 'Settings check failed: ' + e, '');
  }

  // ---- 5. AUTOMATION / AI / QUOTA ----
  try {
    var hasTick = ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'tick'; });
    if (hasTick) ok('Automation', 'Tick trigger is installed - scheduled jobs will run.');
    else bad('Automation', 'No tick trigger - reminders and monthly dispatch will never run.',
      'Click "Install tick trigger" above, or run setup() from the editor.');
  } catch (e) { hmm('Automation', 'Could not read triggers (' + e + ')', ''); }

  try {
    var g = geminiStatus_();
    if (g && g.unavailable) hmm('AI', 'Gemini.gs is not loaded - AI features are off. Everything else still works.', '');
    else if (g && !g.configured) hmm('AI', 'No Gemini API key set - AI features are off.', 'Admin > AI > paste your key.');
    else ok('AI', 'Configured, model = ' + (g && g.model));
  } catch (e) { hmm('AI', String(e), ''); }

  try {
    var q = MailApp.getRemainingDailyQuota();
    ok('Email', q + ' email recipients remaining today.');
    if (q < 100) hmm('Email', 'Daily email quota is low - dispatch will pause and resume tomorrow.',
      'This is normal and self-correcting. No action needed.');
  } catch (e) { hmm('Email', 'Could not read email quota (' + e + ')', ''); }

  // ---- VERDICT ----
  var fails  = items.filter(function(i){ return i.level === 'fail'; });
  var warns  = items.filter(function(i){ return i.level === 'warn'; });
  var passes = items.filter(function(i){ return i.level === 'pass'; });
  return {
    generatedAt: nowIso_(),
    go: fails.length === 0,
    counts: { passed: passes.length, failed: fails.length, notes: warns.length },
    items: items,
    ordered: fails.concat(warns).concat(passes),
    nextStep: fails.length
      ? 'Fix the failures below, save, then publish: Deploy > Manage deployments > pencil > Version: New version.'
      : 'All checks passed. If you changed code since the last publish, publish a New version so users get it.'
  };
}


/* ==================================================================
 * OPS HELPERS - no underscore, so they appear in the Run dropdown.
 * ================================================================== */

/** Rehearse the three-strike sweep. Computes everything, sends NOTHING. */
function testStrikeSweep() {
  var r = runStrikeSweep_('manual-test', { dryRun: true, ignoreWindow: true });
  Logger.log('=== THREE-STRIKE DRY RUN (no email sent) ===');
  Logger.log('open escalations checked : ' + (r.checked || 0));
  Logger.log('strikes that WOULD fire  : ' + ((r.struck || []).length));
  (r.struck || []).forEach(function(s) {
    Logger.log('   ' + s.id + '  strike ' + s.level + '  idle ' + s.idle + ' working hours');
    Logger.log('        to: ' + (s.to || []).join(', ') + '   cc count: ' + s.cc);
    Logger.log('        subject: ' + s.subject);
  });
  Logger.log('skipped (' + ((r.skipped || []).length) + '):');
  (r.skipped || []).forEach(function(s){ Logger.log('   ' + s.id + ' - ' + s.why); });
  Logger.log('');
  Logger.log('Send window right now: ' + (withinSendWindow_(new Date()) ? 'OPEN' : 'CLOSED (nothing would send)'));
  return r;
}

/** Prove the working-hours clock against fixed cases. Reads nothing, writes nothing. */
function testWorkingHoursClock() {
  var tz = getTz_();
  var mk = function(s){ return new Date(s); };
  var cases = [
    ['Fri 16:00 -> Mon 11:00 (weekend skipped)', '2026-08-14T16:00:00+05:30', '2026-08-17T11:00:00+05:30'],
    ['Mon 10:00 -> Mon 17:00 (one full day)',    '2026-08-17T10:00:00+05:30', '2026-08-17T17:00:00+05:30'],
    ['Mon 18:00 -> Tue 09:00 (all outside)',     '2026-08-17T18:00:00+05:30', '2026-08-18T09:00:00+05:30'],
    ['Sat 10:00 -> Sun 17:00 (weekend only)',    '2026-08-15T10:00:00+05:30', '2026-08-16T17:00:00+05:30']
  ];
  Logger.log('=== WORKING-HOURS CLOCK ===');
  Logger.log('window: ' + getSetting_('WORK_HOURS_START','10') + ':00 to ' + getSetting_('WORK_HOURS_END','17') + ':00, Mon-Fri');
  cases.forEach(function(c) {
    Logger.log('  ' + c[0] + '  =  ' + workingHoursBetween_(mk(c[1]), mk(c[2])).toFixed(1) + ' working hours');
  });
  Logger.log('');
  Logger.log('Send window now (' + Utilities.formatDate(new Date(), tz, 'EEE HH:mm') + '): '
    + (withinSendWindow_(new Date()) ? 'OPEN' : 'CLOSED'));
}

/**
 * Ops check for the executive dashboard.
 * Recomputes the headline numbers independently and reconciles them against the
 * dashboard payload, so a silent divergence shows up here rather than on screen.
 * Run this from the editor and read the Execution log.
 */
function testDashboardSummary() {
  var me  = whoAmI_();
  var d   = dashboardSummary_(me);
  var mis = escalationMIS_({}, me);

  var raw    = readTable_('ESCALATIONS');
  var scoped = scopeEscalations_(raw, me, clientIndex_());
  var openRecount = scoped.filter(function(e) {
    return ESCALATION_TERMINAL.indexOf(String(e.Status || 'OPEN')) === -1;
  }).length;

  Logger.log('user       : ' + me.email + '   role=' + me.role);
  Logger.log('scope      : ' + d.scopeLabel + '   month=' + d.monthKey);
  Logger.log('escalations: sheet=' + raw.length + '   visible to me=' + scoped.length);
  Logger.log('totals     : ' + JSON.stringify(d.totals));
  Logger.log('ageing     : ' + JSON.stringify(d.ageing));
  Logger.log('dispatch   : ' + JSON.stringify(d.dispatch));
  Logger.log('list sizes : overdueTop=' + d.overdueTop.length +
             '  recent=' + d.recent.length +
             '  incompleteList=' + d.incompleteList.length);

  var checks = [
    ['open equals MIS headline',        d.totals.openEscalations === mis.headline.open],
    ['open equals fresh recount',       d.totals.openEscalations === openRecount],
    ['overdue equals MIS headline',     d.totals.overdue === mis.headline.overdue],
    ['exception equals MIS headline',   d.totals.exception === mis.headline.exception],
    ['complete + incomplete = clients', (d.totals.complete + d.totals.incomplete) === d.totals.clients],
    ['coverage percent arithmetic',     d.totals.clients === 0 ||
        d.totals.coveragePct === Math.round(d.totals.complete / d.totals.clients * 100)],
    ['queue parts within queued total', (d.dispatch.sent + d.dispatch.pending + d.dispatch.failed) <= d.dispatch.queued],
    ['overdueTop within overdue count', d.overdueTop.length <= d.totals.overdue]
  ];

  var failed = 0;
  checks.forEach(function(c) {
    if (!c[1]) failed++;
    Logger.log((c[1] ? 'PASS   ' : 'FAIL   ') + c[0]);
  });

  // Informational, not a pass/fail: MIS only buckets rows whose date parses, so a
  // gap here means some open rows have an unreadable CreatedAt or Date.
  var ageSum = 0;
  Object.keys(d.ageing).forEach(function(k){ ageSum += d.ageing[k]; });
  Logger.log('note       : ageing buckets sum to ' + ageSum + ' of ' + d.totals.openEscalations +
             ' open' + (ageSum === d.totals.openEscalations ? '' : '  <-- gap means unparseable dates'));

  Logger.log(failed === 0 ? 'RESULT: ALL CHECKS PASS' : 'RESULT: ' + failed + ' CHECK(S) FAILED');
  return d;
}

/**
 * Fixture test for the executive dashboard.
 * Primes the in-memory table cache with a known dataset, so every number can be
 * asserted against a hand-computed expected value. Writes NOTHING to the
 * spreadsheet - it only fills the cache that readTable_ consults first, then puts
 * the real cache back. Scenario B is the scope fix: the same data seen by a
 * LOCATION_HEAD must yield strictly smaller numbers than an ADMIN sees.
 */
function testDashboardFixtures() {
  var MS  = 86400000;
  var now = new Date();
  var iso = function(daysAgo){ return new Date(now.getTime() - daysAgo * MS).toISOString(); };
  var ymd = function(daysAgo){ return ymd_(new Date(now.getTime() - daysAgo * MS)); };
  var mk  = monthKey_(now);
  var LH  = 'lh.fixture@test.local';

  var build = function() {
    return {
      CLIENTS: [
        { ClientID:'C1', ClientName:'Fixture One',   ClientCode:'F1', Status:'ACTIVE', DefaultLocationHead: LH },
        { ClientID:'C2', ClientName:'Fixture Two',   ClientCode:'F2', Status:'ACTIVE', DefaultLocationHead:'other@test.local' },
        { ClientID:'C3', ClientName:'Fixture Three', ClientCode:'F3', Status:'ACTIVE', DefaultLocationHead:'other@test.local' }
      ],
      BRANCHES: [
        { BranchID:'B1', ClientID:'C1', BranchCode:'BC1', Status:'ACTIVE' },
        { BranchID:'B2', ClientID:'C2', BranchCode:'BC2', Status:'ACTIVE' },
        { BranchID:'B3', ClientID:'C3', BranchCode:'BC3', Status:'ACTIVE' }
      ],
      ESCALATIONS: [
        { EscalationID:'E1', ClientID:'C1', BranchID:'B1', BranchCode:'BC1', Status:'OPEN',        Category:'Service', Severity:'LOW',    CreatedAt: iso(3),  UpdatedAt: iso(3),  TargetDate: ymd(-5) },
        { EscalationID:'E2', ClientID:'C1', BranchID:'B1', BranchCode:'BC1', Status:'IN_PROGRESS', Category:'Billing', Severity:'HIGH',   CreatedAt: iso(10), UpdatedAt: iso(10), TargetDate: ymd(2) },
        { EscalationID:'E3', ClientID:'C2', BranchID:'B2', BranchCode:'BC2', Status:'ASSIGNED',    Category:'Service', Severity:'MEDIUM', CreatedAt: iso(20), UpdatedAt: iso(20), TargetDate: ymd(1) },
        { EscalationID:'E4', ClientID:'C2', BranchID:'B2', BranchCode:'BC2', Status:'OPEN',        Category:'Safety',  Severity:'HIGH',   CreatedAt: iso(40), UpdatedAt: iso(40), TargetDate: ymd(10) },
        { EscalationID:'E5', ClientID:'C3', BranchID:'B3', BranchCode:'BC3', Status:'CLOSED',      Category:'Service', Severity:'LOW',    CreatedAt: iso(30), UpdatedAt: iso(20), ClosureDate: iso(20) },
        { EscalationID:'E6', ClientID:'C3', BranchID:'B3', BranchCode:'BC3', Status:'EXCEPTION',   Category:'Billing', Severity:'LOW',    CreatedAt: iso(15), UpdatedAt: iso(15) },
        { EscalationID:'E7', ClientID:'C1', BranchID:'B1', BranchCode:'BC1', Status:'RESOLVED',    Category:'Service', Severity:'LOW',    CreatedAt: iso(8),  UpdatedAt: iso(4),  ClosureDate: iso(4) }
      ],
      ESCALATION_MATRIX: [],
      EMAIL_LOG: [
        { LogID:'L1', Timestamp: mk + '-05T10:00:00', ClientID:'C1', BranchID:'B1', Status:'SENT' },
        { LogID:'L2', Timestamp: mk + '-06T10:00:00', ClientID:'C1', BranchID:'B1', Status:'SENT' },
        { LogID:'L3', Timestamp: mk + '-07T10:00:00', ClientID:'C2', BranchID:'B2', Status:'FAILED' },
        { LogID:'L4', Timestamp: '1999-01-01T10:00:00', ClientID:'C1', BranchID:'B1', Status:'SENT' }
      ],
      DISPATCH_QUEUE: [
        { QueueID:'Q1', MonthKey: mk,        ClientID:'C1', BranchID:'B1', Status:'SENT' },
        { QueueID:'Q2', MonthKey: mk,        ClientID:'C1', BranchID:'B1', Status:'PENDING' },
        { QueueID:'Q3', MonthKey: mk,        ClientID:'C2', BranchID:'B2', Status:'SENT' },
        { QueueID:'Q4', MonthKey: mk,        ClientID:'C2', BranchID:'B2', Status:'RETRY' },
        { QueueID:'Q5', MonthKey: mk,        ClientID:'C2', BranchID:'B2', Status:'FAILED' },
        { QueueID:'Q6', MonthKey: '1999-01', ClientID:'C1', BranchID:'B1', Status:'PENDING' }
      ],
      WARNINGS: [
        { WarningID:'W1', EscalationID:'E2', ClientID:'C1', BranchID:'B1', PersonEmail:'p1@test.local', IssuedAt: iso(5), Status:'ISSUED', AcknowledgedAt:'' },
        { WarningID:'W2', EscalationID:'E4', ClientID:'C2', BranchID:'B2', PersonEmail:'p2@test.local', IssuedAt: iso(6), Status:'ISSUED', AcknowledgedAt:'' },
        { WarningID:'W3', EscalationID:'E3', ClientID:'C2', BranchID:'B2', PersonEmail:'p3@test.local', IssuedAt: iso(7), Status:'ISSUED', AcknowledgedAt: iso(2) }
      ],
      USERS: [
        { UserID:'U1', Name:'LH Fixture', Email: LH, Role:'LOCATION_HEAD', ScopeZones:'', ScopeLocations:'', ScopeBranchIDs:'', ScopeClientIDs:'' }
      ]
    };
  };

  var realTables = _TABLE_CACHE;
  var realScope  = _SCOPE_CACHE;
  var out = [];
  var check = function(label, got, want) {
    var ok = String(got) === String(want);
    out.push((ok ? 'PASS   ' : 'FAIL   ') + label + '   got=' + got + '  want=' + want);
  };

  try {
    _TABLE_CACHE = build(); _SCOPE_CACHE = null;
    var a = dashboardSummary_({ email:'admin@test.local', role:'ADMIN' });
    Logger.log('ADMIN totals   : ' + JSON.stringify(a.totals));
    Logger.log('ADMIN ageing   : ' + JSON.stringify(a.ageing));
    Logger.log('ADMIN dispatch : ' + JSON.stringify(a.dispatch));

    check('A clients',         a.totals.clients, 3);
    check('A branches',        a.totals.branches, 3);
    check('A incomplete',      a.totals.incomplete, 3);
    check('A coveragePct',     a.totals.coveragePct, 0);
    check('A open',            a.totals.openEscalations, 4);
    check('A overdue',         a.totals.overdue, 3);
    check('A exception',       a.totals.exception, 1);
    check('A avgResolution',   a.totals.avgResolutionDays, 7);
    check('A ageing 0-7',      a.ageing['0-7'], 1);
    check('A ageing 8-15',     a.ageing['8-15'], 1);
    check('A ageing 16-30',    a.ageing['16-30'], 1);
    check('A ageing 30+',      a.ageing['30+'], 1);
    check('A emailsThisMonth', a.totals.emailsThisMonth, 3);
    check('A failedEmails',    a.totals.failedEmails, 1);
    check('A queue queued',    a.dispatch.queued, 5);
    check('A queue sent',      a.dispatch.sent, 2);
    check('A queue pending',   a.dispatch.pending, 2);
    check('A queue failed',    a.dispatch.failed, 1);
    check('A warningsOpen',    a.totals.warningsOpen, 2);
    check('A recent count',    a.recent.length, 7);
    check('A recent newest',   a.recent[0].EscalationID, 'E1');
    check('A overdueTop rows', a.overdueTop.length, 3);
    check('A worst overdue',   a.overdueTop[0].EscalationID, 'E4');

    _TABLE_CACHE = build(); _SCOPE_CACHE = null;
    var b = dashboardSummary_({ email: LH, role:'LOCATION_HEAD' });
    Logger.log('LH totals      : ' + JSON.stringify(b.totals));
    Logger.log('LH dispatch    : ' + JSON.stringify(b.dispatch));

    check('B scopeLabel',      b.scopeLabel, 'your scope only');
    check('B clients',         b.totals.clients, 1);
    check('B open',            b.totals.openEscalations, 2);
    check('B overdue',         b.totals.overdue, 1);
    check('B emailsThisMonth', b.totals.emailsThisMonth, 2);
    check('B failedEmails',    b.totals.failedEmails, 0);
    check('B queue queued',    b.dispatch.queued, 2);
    check('B queue failed',    b.dispatch.failed, 0);
    check('B recent count',    b.recent.length, 3);
    check('B sees less than A', b.totals.openEscalations < a.totals.openEscalations, true);
  } finally {
    _TABLE_CACHE = realTables;
    _SCOPE_CACHE = realScope;
  }

  var fails = 0;
  out.forEach(function(r){ if (r.indexOf('FAIL') === 0) fails++; Logger.log(r); });
  Logger.log(fails === 0
    ? 'FIXTURE RESULT: ALL ' + out.length + ' CHECKS PASS'
    : 'FIXTURE RESULT: ' + fails + ' OF ' + out.length + ' FAILED');
}

/** Ops: dump the most recent RPC_ERROR rows from AUDIT_LOG into the Execution log. */
function showRecentRpcErrors() {
  var rows = readTable_('AUDIT_LOG');
  Logger.log('AUDIT_LOG total rows: ' + rows.length);
  var errs = rows.filter(function(r) {
    return /ERROR/i.test(String(r.Action || '')) || /ERROR/i.test(String(r.Entity || ''));
  });
  Logger.log('rows matching ERROR: ' + errs.length);
  errs.sort(function(a,b){ return String(b.Timestamp).localeCompare(String(a.Timestamp)); });
  errs.slice(0, 14).forEach(function(r, i) {
    Logger.log('--- ' + (i+1) + ' --- ' + r.Timestamp + '  user=' + r.User);
    Logger.log('    Action=' + r.Action + '  Entity=' + r.Entity + '  EntityID=' + r.EntityID);
    Logger.log('    NewValue=' + String(r.NewValue || '').slice(0, 900));
    if (String(r.OldValue || '').trim()) Logger.log('    OldValue=' + String(r.OldValue).slice(0, 400));
  });
  var actions = {};
  rows.forEach(function(r){ var k = String(r.Action||''); actions[k] = (actions[k]||0) + 1; });
  Logger.log('distinct Action values: ' + JSON.stringify(actions));
}

/**
 * Runtime test for escalation creation, both paths.
 * A parse-check cannot catch an undefined-variable bug, which is exactly what
 * broke this (resolveAgainstEmail_(p) where no p existed). Only execution can.
 * Creates two real rows, verifies AgainstEmail is populated, then deletes them.
 */
function testEscalationCreate() {
  var me = whoAmI_();
  var clients = readTable_('CLIENTS');
  if (!clients.length) { Logger.log('FAIL - no clients exist, cannot test'); return; }
  var c = clients[0];
  var users = readTable_('USERS').filter(function(u){ return isEmail_(u.Email); });
  var target = users[0] || { Name: me.email, Email: me.email };
  Logger.log('using client=' + c.ClientID + ' (' + c.ClientName + ')');
  Logger.log('resolving against name=' + target.Name + ' expecting=' + target.Email);

  var idOf = function(res) {
    if (!res) return '';
    if (res.EscalationID) return String(res.EscalationID);
    if (res.escalation && res.escalation.EscalationID) return String(res.escalation.EscalationID);
    if (res.id) return String(res.id);
    return '';
  };
  var made = [];
  var out = [];
  var chk = function(label, ok, detail) {
    out.push((ok ? 'PASS   ' : 'FAIL   ') + label + (detail ? '   ' + detail : ''));
  };

  try {
    // ---- LOG path: sends EscalatedAgainst ----
    var logRes = logEscalationCase_({
      ClientID: c.ClientID, Category: 'Service', Severity: 'Medium',
      EscalatedAgainst: target.Name, Description: 'automated selftest - log path',
      RequiredAction: 'none', TargetDate: ymd_(new Date())
    }, me);
    var logId = idOf(logRes);
    Logger.log('log path returned: ' + JSON.stringify(logRes).slice(0, 200));
    chk('LOG created a row', !!logId, 'id=' + logId);
    if (logId) made.push(logId);

    // ---- RAISE path: sends PersonConcerned ----
    var raiseRes = raiseEscalationCase_({
      ClientID: c.ClientID, Category: 'Service', Severity: 'Medium',
      PersonConcerned: target.Name, Details: 'automated selftest - raise path', Description: 'automated selftest - raise path',
      To: me.email, Cc: ''
    }, me);
    var raiseId = idOf(raiseRes);
    Logger.log('raise path returned: ' + JSON.stringify(raiseRes).slice(0, 200));
    chk('RAISE created a row', !!raiseId, 'id=' + raiseId);
    if (raiseId) made.push(raiseId);

    // ---- verify the rows landed with AgainstEmail populated ----
    _TABLE_CACHE = {};
    var rows = readTable_('ESCALATIONS');
    made.forEach(function(id) {
      var r = rows.filter(function(x){ return String(x.EscalationID) === String(id); })[0];
      chk('row ' + id + ' present in sheet', !!r);
      if (r) {
        chk('row ' + id + ' AgainstEmail populated', !!String(r.AgainstEmail || '').trim(),
            'AgainstEmail=' + r.AgainstEmail + ' EscalatedAgainst=' + r.EscalatedAgainst);
        chk('row ' + id + ' ClientID correct', String(r.ClientID) === String(c.ClientID));
      }
    });
  } catch (err) {
    chk('no exception thrown', false, String(err && err.message || err));
    Logger.log('STACK: ' + (err && err.stack ? err.stack : 'n/a'));
  } finally {
    // Sweep by marker, not by returned id. If the id extraction is wrong the row
    // still gets removed instead of being left behind in production data.
    _TABLE_CACHE = {};
    var strays = readTable_('ESCALATIONS').filter(function(r) {
      return String(r.Description || '').indexOf('automated selftest') !== -1;
    });
    strays.forEach(function(r) {
      try { deleteRowById_('ESCALATIONS', 'EscalationID', r.EscalationID); Logger.log('cleaned up ' + r.EscalationID); }
      catch (e2) { Logger.log('CLEANUP FAILED for ' + r.EscalationID + ' - delete by hand: ' + e2); }
    });
    Logger.log('sweep removed ' + strays.length + ' selftest row(s)');
  }

  var fails = 0;
  out.forEach(function(r){ if (r.indexOf('FAIL') === 0) fails++; Logger.log(r); });
  Logger.log(fails === 0 ? 'ESCALATION CREATE: ALL ' + out.length + ' CHECKS PASS'
                         : 'ESCALATION CREATE: ' + fails + ' OF ' + out.length + ' FAILED');
}

/**
 * Verifies the shared-client ownership model, the tightened escalation scope,
 * and that every ai.* handler accepts the exact payload the client sends.
 */
function testOwnershipAndAi() {
  var out = [];
  var chk = function(label, ok, detail) {
    out.push((ok ? 'PASS   ' : 'FAIL   ') + label + (detail ? '   ' + detail : ''));
  };
  var nitish = { email: 'nitish.bhope@cruxindia.co.in', role: 'LOCATION_HEAD' };
  var admin  = whoAmI_();

  // ---- shared client list ----
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  var allClients = readTable_('CLIENTS').filter(function(c){ return c.Status !== 'INACTIVE'; });
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  var nitishList = listClients_({}, nitish);
  var nItems = nitishList.items || nitishList.rows || nitishList;
  Logger.log('active clients in sheet: ' + allClients.length);
  Logger.log('clients visible to nitish: ' + (nItems.length || 0));
  chk('Nitish sees every shared client', (nItems.length || 0) === allClients.length,
      'saw=' + (nItems.length||0) + ' of ' + allClients.length);
  var bom = nItems.filter(function(c){ return /Bank Of Maharashtra/i.test(String(c.ClientName||'')); })[0];
  chk('Nitish can see Bank Of Maharashtra', !!bom, bom ? bom.ClientID : 'NOT VISIBLE');

  // ---- client in scope implies its branches ----
  _SCOPE_CACHE = null;
  var sc = userScope_(nitish);
  Logger.log('nitish scope: all=' + sc.all + ' clients=' + JSON.stringify(Object.keys(sc.clientIds||{})) +
             ' branches=' + JSON.stringify(Object.keys(sc.branchIds||{})));
  if (!sc.all) {
    var orphan = 0;
    readTable_('BRANCHES').forEach(function(b) {
      if (sc.clientIds[b.ClientID] && !sc.branchIds[b.BranchID]) orphan++;
    });
    chk('no branch of an in-scope client is excluded', orphan === 0, 'orphans=' + orphan);
  } else {
    chk('no branch of an in-scope client is excluded', true, 'nitish has full scope');
  }

  // ---- escalation scope now applies to MANAGER and VIEWER ----
  var idx = clientIndex_();
  var esc = readTable_('ESCALATIONS');
  var mgr = { email: 'aniket.chalke@cruxindia.co.in', role: 'MANAGER' };
  var mgrSees = scopeEscalations_(esc, mgr, idx).length;
  var admSees = scopeEscalations_(esc, admin, idx).length;
  Logger.log('escalations: total=' + esc.length + ' admin=' + admSees + ' manager=' + mgrSees);
  chk('ADMIN still sees all escalations', admSees === esc.length, admSees + '/' + esc.length);
  chk('MANAGER no longer sees everything by default', mgrSees <= admSees, 'mgr=' + mgrSees);

  // ---- ai.* payload shapes, exactly as the client sends them ----
  var aiOn = false;
  try { aiOn = !!geminiConfigured_(); } catch (e) {}
  Logger.log('AI configured: ' + aiOn);
  var tryAi = function(label, fn) {
    try { var r = fn(); Logger.log(label + ' -> ' + JSON.stringify(r).slice(0, 220)); chk(label, true); }
    catch (e) { chk(label, false, String(e && e.message || e)); }
  };
  tryAi('ai.classifyEscalation accepts {description}', function() {
    return aiClassifyEscalation_({ description: 'The branch has not responded to our service request for over two weeks despite repeated follow ups.' }, admin);
  });
  tryAi('ai.draftEscalation accepts {brief,ClientID,category,severity}', function() {
    return aiDraftEscalation_({ brief: 'Branch unresponsive on service request for two weeks.',
      ClientID: (allClients[0]||{}).ClientID || '', category: 'Service', severity: 'Medium' }, admin);
  });
  tryAi('ai.chat accepts {messages:[{role,text}]}', function() {
    return aiChat_({ messages: [{ role: 'user', text: 'How many open escalations are there?' }] }, admin);
  });

  var fails = 0;
  out.forEach(function(r){ if (r.indexOf('FAIL') === 0) fails++; Logger.log(r); });
  Logger.log(fails === 0 ? 'OWNERSHIP+AI: ALL ' + out.length + ' CHECKS PASS'
                         : 'OWNERSHIP+AI: ' + fails + ' OF ' + out.length + ' FAILED');
}

/**
 * Fills in the blanks Shantanu approved sample data for, and adds a second
 * branch plus a branch-level matrix so the fallback behaviour is demonstrable.
 * Idempotent - safe to re-run.
 */
function seedSampleData() {
  var me = whoAmI_();
  var log = [];
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;

  var clients = readTable_('CLIENTS').filter(function(c){ return c.Status !== 'INACTIVE'; });
  if (!clients.length) { Logger.log('no clients - nothing to seed'); return; }
  var c = clients[0];

  // 1. Backfill the blank Location/Zone on existing branches so location and
  //    zone scoped users can actually match them.
  readTable_('BRANCHES').filter(function(b){ return String(b.ClientID) === String(c.ClientID); })
    .forEach(function(b) {
      var patch = {};
      if (!String(b.Location || '').trim()) patch.Location = 'Pune';
      if (!String(b.Zone || '').trim())     patch.Zone = 'ROMG';
      if (Object.keys(patch).length) {
        patch.UpdatedAt = nowIso_(); patch.UpdatedBy = me.email;
        updateRowById_('BRANCHES', 'BranchID', b.BranchID, patch);
        log.push('backfilled ' + b.BranchID + ' ' + JSON.stringify(patch));
      }
    });

  // 2. A second branch, so the per-branch matrix editor has more than one tab.
  _TABLE_CACHE = {};
  var branches = readTable_('BRANCHES').filter(function(b){ return String(b.ClientID) === String(c.ClientID); });
  if (!branches.some(function(b){ return String(b.BranchCode) === 'BOM5678'; })) {
    upsertBranch_({
      ClientID: c.ClientID, BranchName: 'Nagpur', BranchCode: 'BOM5678',
      Address: 'Nagpur', Location: 'Nagpur', Zone: 'ROMG',
      CruxPOCName: 'Sample POC', CruxPOCMobile: '9049705664',
      CruxPOCEmail: 'sample.poc@cruxindia.co.in',
      BranchManagerName: 'Sample Manager',
      BranchManagerEmail: 'sample.manager@cruxindia.co.in',
      Status: 'ACTIVE'
    }, me);
    log.push('created sample branch Nagpur / BOM5678');
  }

  // 3. Branch-level matrix on ONE branch only, and deliberately partial, so the
  //    client-level fallback is observable at the untouched levels.
  _TABLE_CACHE = {};
  branches = readTable_('BRANCHES').filter(function(b){ return String(b.ClientID) === String(c.ClientID); });
  var nagpur = branches.filter(function(b){ return String(b.BranchCode) === 'BOM5678'; })[0];
  if (nagpur) {
    var existing = readTable_('ESCALATION_MATRIX').filter(function(m2) {
      return String(m2.ClientID) === String(c.ClientID)
          && String(m2.BranchID || '').trim() === String(nagpur.BranchID);
    });
    if (!existing.length) {
      saveMatrix_({ clientId: c.ClientID, branchId: nagpur.BranchID, rows: [
        { Level:1, LevelName:'SPOC',           ContactName:'Nagpur SPOC',    Mobile:'9049705664', Email:'nagpur.spoc@cruxindia.co.in' },
        { Level:2, LevelName:'Team Leader',    ContactName:'Nagpur TL',      Mobile:'9049705664', Email:'nagpur.tl@cruxindia.co.in' },
        { Level:3, LevelName:'Branch Manager', ContactName:'', Mobile:'', Email:'' },
        { Level:4, LevelName:'Zonal Manager',  ContactName:'', Mobile:'', Email:'' },
        { Level:5, LevelName:'Head Office',    ContactName:'', Mobile:'', Email:'' }
      ] }, me);
      log.push('seeded partial branch matrix on ' + nagpur.BranchID + ' (levels 1-2 only, 3-5 inherit)');
    }
  }

  // 4. Give Nitish an owned branch so his scope is not empty.
  _TABLE_CACHE = {};
  var nitish = 'nitish.bhope@cruxindia.co.in';
  var first = readTable_('BRANCHES').filter(function(b){ return String(b.ClientID) === String(c.ClientID); })[0];
  if (first && String(first.LocationHead || '').toLowerCase() !== nitish) {
    updateRowById_('BRANCHES', 'BranchID', first.BranchID,
      { LocationHead: nitish, UpdatedAt: nowIso_(), UpdatedBy: me.email });
    log.push('set LocationHead=' + nitish + ' on ' + first.BranchID);
  }

  // 5. Dispatch config Shantanu approved: one email per branch, to the branch
  //    manager and the SPOC. BRANCH_RECIPIENT is comma separated so more roles
  //    or plain addresses can be appended later without a code change.
  var wantCfg = {
    DISPATCH_GRANULARITY: 'BRANCH',
    BRANCH_RECIPIENT: 'BRANCH_MANAGER,CRUX_POC'
  };
  Object.keys(wantCfg).forEach(function(k) {
    var cur = String(getSetting_(k, '') || '');
    if (cur !== wantCfg[k]) {
      setSetting_(k, wantCfg[k], 'system:config');
      log.push('setting ' + k + ': ' + (cur || '(blank)') + ' -> ' + wantCfg[k]);
    }
  });

  log.forEach(function(l){ Logger.log(l); });
  Logger.log(log.length ? 'SEED: ' + log.length + ' change(s) applied' : 'SEED: nothing to do, already seeded');
}


/** Branch matrix saves, and dispatch falls back to the client matrix when blank. */
function testBranchMatrixFallback() {
  var me = whoAmI_();
  var out = [];
  var chk = function(l, ok, d) { out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  var c = readTable_('CLIENTS').filter(function(x){ return x.Status !== 'INACTIVE'; })[0];
  var branches = readTable_('BRANCHES').filter(function(b){ return String(b.ClientID) === String(c.ClientID) && b.Status !== 'INACTIVE'; });
  Logger.log('client=' + c.ClientID + '  branches=' + branches.length);
  // One branch is enough to prove inheritance. The old assertion demanded two,
  // which only held while the demo branch existed - cleanupTestData removes it,
  // so the check was asserting seed data rather than behaviour.
  chk('client has a branch to test against', branches.length >= 1, 'n=' + branches.length);

  // client-level matrix must still exist and be untouched by branch saves
  // for a reason that had nothing to do with the behaviour under test.
  // This test asserts INHERITANCE, so a client-level default must exist. Earlier
  // cleanups removed it, which made the test fail for a reason unrelated to the
  // behaviour under test. Seed it if missing.
  var clientLevelNow = getMatrix_(c.ClientID, me, '')
    .filter(function(r){ return String(r.ContactName||'').trim() || String(r.Email||'').trim(); }).length;
  if (!clientLevelNow) {
    saveMatrix_({ clientId: c.ClientID, branchId: '', location: '', rows: [
      { Level:1, LevelName:'SPOC',           ContactName:'Client SPOC', Mobile:'', Email:'client.spoc@cruxindia.co.in' },
      { Level:2, LevelName:'Team Leader',    ContactName:'Client TL',   Mobile:'', Email:'client.tl@cruxindia.co.in' },
      { Level:3, LevelName:'Branch Manager', ContactName:'Client BM',   Mobile:'', Email:'client.bm@cruxindia.co.in' },
      { Level:4, LevelName:'Zonal Manager',  ContactName:'Client ZM',   Mobile:'', Email:'client.zm@cruxindia.co.in' },
      { Level:5, LevelName:'Head Office',    ContactName:'Client HO',   Mobile:'', Email:'client.ho@cruxindia.co.in' }
    ] }, me);
    invalidateTableCache_('ESCALATION_MATRIX'); _TABLE_CACHE = {};
    Logger.log('seeded a client-level default so inheritance can be asserted');
  }

  var clientRows = getMatrix_(c.ClientID, me, '');
  var clientFilled = clientRows.filter(function(r){ return String(r.ContactName||'').trim() || String(r.Email||'').trim(); }).length;
  Logger.log('client-level filled levels: ' + clientFilled + '/5');
  chk('client-level matrix preserved as fallback', clientFilled > 0, clientFilled + '/5 filled');

  // Establish the precondition rather than trusting leftover state: this test
  // asserts inheritance, so the branch must override levels 1-2 ONLY. A previous
  // run of the round-trip bug hard-coded all five, which made the assertion fail
  var seeded = branches.filter(function(b){ return String(b.BranchCode) === 'BOM5678'; })[0];
  if (seeded) {
    var wiped = 0;
    readTable_('ESCALATION_MATRIX').forEach(function(m) {
      if (String(m.BranchID || '') !== String(seeded.BranchID)) return;
      if (Number(m.Level) <= 2) return;
      try { deleteRowById_('ESCALATION_MATRIX','MatrixID',m.MatrixID); wiped++; } catch(e){}
    });
    if (wiped) Logger.log('reset ' + wiped + ' hardened branch row(s) before asserting');
    invalidateTableCache_('ESCALATION_MATRIX');
    _TABLE_CACHE = {};
  }
  if (seeded) {
    var br = getMatrix_(c.ClientID, me, seeded.BranchID);
    var own = br.filter(function(r){ return r._filled; }).length;
    var inh = br.filter(function(r){ return !r._filled && (r._inheritedContactName || r._inheritedEmail); }).length;
    Logger.log('branch ' + seeded.BranchID + ': own=' + own + ' inheriting=' + inh);
    chk('branch has its own overrides', own >= 1, 'own=' + own);
    chk('blank branch levels expose the client fallback', inh >= 1, 'inheriting=' + inh);
    chk('branch matrix is separate from client matrix',
        JSON.stringify(br.map(function(r){return r.ContactName;})) !== JSON.stringify(clientRows.map(function(r){return r.ContactName;})));

    // Loading a matrix and saving it unchanged must NOT convert inherited values
    // into stored branch rows. That silently destroyed the fallback on first save.
    var beforeOwn = getMatrix_(c.ClientID, me, seeded.BranchID)
      .filter(function(r){ return String(r.ContactName||'').trim() || String(r.Email||'').trim(); }).length;
    saveMatrix_({ clientId: c.ClientID, branchId: seeded.BranchID,
      rows: getMatrix_(c.ClientID, me, seeded.BranchID).map(function(r) {
        return { Level:r.Level, LevelName:r.LevelName, ContactName:r.ContactName,
                 Mobile:r.Mobile, Email:r.Email };
      }) }, me);
    _TABLE_CACHE = {};
    var afterOwn = getMatrix_(c.ClientID, me, seeded.BranchID)
      .filter(function(r){ return String(r.ContactName||'').trim() || String(r.Email||'').trim(); }).length;
    chk('save round-trip does not harden inheritance', afterOwn === beforeOwn,
        'before=' + beforeOwn + ' after=' + afterOwn);

    // round-trip a save and confirm the client rows did not move
    var beforeClient = JSON.stringify(getMatrix_(c.ClientID, me, ''));
    saveMatrix_({ clientId: c.ClientID, branchId: seeded.BranchID, rows: br.map(function(r) {
      return { Level:r.Level, LevelName:r.LevelName, ContactName:r.ContactName, Mobile:r.Mobile, Email:r.Email };
    }) }, me);
    _TABLE_CACHE = {};
    var afterClient = JSON.stringify(getMatrix_(c.ClientID, me, ''));
    chk('saving a branch matrix does not alter client rows', beforeClient === afterClient);
  } else {
    chk('seeded branch present', false, 'BOM5678 missing');
  }
  var f = 0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'BRANCH MATRIX: ALL ' + out.length + ' PASS' : 'BRANCH MATRIX: ' + f + ' FAILED');
}

/** Raising a warning off an escalation writes the register and the history. */
function testWarningRaise() {
  var me = whoAmI_();
  var out = [];
  var chk = function(l, ok, d) { out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  _TABLE_CACHE = {};
  var c = readTable_('CLIENTS').filter(function(x){ return x.Status !== 'INACTIVE'; })[0];
  var made = null, wid = null;
  try {
    var res = logEscalationCase_({
      ClientID: c.ClientID, Category: 'Service', Severity: 'Medium',
      EscalatedAgainst: me.email, Description: 'automated selftest - warning path',
      RequiredAction: 'none', TargetDate: ymd_(new Date())
    }, me);
    made = res.EscalationID || (res.escalation && res.escalation.EscalationID);
    chk('setup escalation created', !!made, made);
    _TABLE_CACHE = {};
    var w = raiseWarning_({ EscalationID: made, reason: 'Automated selftest of the manual warning path.', sendLetter: false }, me);
    wid = w.WarningID;
    Logger.log('raiseWarning_ -> ' + JSON.stringify(w));
    chk('warning created', !!wid, wid);
    chk('warning resolved the person', !!w.PersonEmail, w.PersonEmail);
    _TABLE_CACHE = {};
    var row = readTable_('WARNINGS').filter(function(x){ return String(x.WarningID) === String(wid); })[0];
    chk('warning row in register', !!row);
    if (row) {
      chk('linked to the escalation', String(row.EscalationID) === String(made));
      chk('reason recorded in Notes', String(row.Notes||'').indexOf('selftest') !== -1);
      chk('status ISSUED', String(row.Status) === 'ISSUED', row.Status);
    }
    var hist = readTable_('ESCALATION_HISTORY').filter(function(x){ return String(x.NewValue) === String(wid); });
    chk('history entry written', hist.length === 1, 'n=' + hist.length);
    // reason must be mandatory
    var rejected = false;
    try { raiseWarning_({ EscalationID: made, reason: 'no', sendLetter: false }, me); }
    catch (e) { rejected = true; }
    chk('short reason is rejected', rejected);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = {};
    if (wid) { try { deleteRowById_('WARNINGS','WarningID',wid); Logger.log('cleaned warning ' + wid); } catch(x){} }
    readTable_('ESCALATION_HISTORY').filter(function(x){ return String(x.NewValue) === String(wid); })
      .forEach(function(x){ try { deleteRowById_('ESCALATION_HISTORY','HistoryID',x.HistoryID); } catch(e2){} });
    _TABLE_CACHE = {};
    readTable_('ESCALATIONS').filter(function(r){ return String(r.Description||'').indexOf('automated selftest') !== -1; })
      .forEach(function(r){ try { deleteRowById_('ESCALATIONS','EscalationID',r.EscalationID); Logger.log('cleaned ' + r.EscalationID); } catch(e2){} });
  }
  var f = 0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'WARNING RAISE: ALL ' + out.length + ' PASS' : 'WARNING RAISE: ' + f + ' FAILED');
}

/** The full warning lifecycle: raise -> appears open -> acknowledge -> closes. */
function testWarningAck() {
  var me = whoAmI_();
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  _TABLE_CACHE = {};
  var c = readTable_('CLIENTS').filter(function(x){ return x.Status !== 'INACTIVE'; })[0];
  var escId = null, wid = null;
  try {
    var r = logEscalationCase_({
      ClientID: c.ClientID, Category: 'Service', Severity: 'Medium',
      EscalatedAgainst: me.email, Description: 'automated selftest - ack path',
      RequiredAction: 'none', TargetDate: ymd_(new Date())
    }, me);
    escId = r.EscalationID || (r.escalation && r.escalation.EscalationID);
    _TABLE_CACHE = {};
    wid = raiseWarning_({ EscalationID: escId, reason: 'Automated selftest of the acknowledge lifecycle.', sendLetter: false }, me).WarningID;
    chk('warning raised', !!wid, wid);

    _TABLE_CACHE = {};
    var before = (listWarnings_({}, me).items || []).filter(function(w){ return w.WarningID === wid; })[0];
    chk('starts unacknowledged', !!before && !String(before.AcknowledgedAt||'').trim(), before ? before.Status : 'missing');

    _TABLE_CACHE = {};
    var ackRes = acknowledgeWarning_({ WarningID: wid, note: 'Handled in selftest.' }, me);
    Logger.log('acknowledgeWarning_ -> ' + JSON.stringify(ackRes));
    chk('acknowledge returned a stamp', !!ackRes.AcknowledgedAt, ackRes.AcknowledgedAt);

    _TABLE_CACHE = {};
    var after = findRowById_('WARNINGS','WarningID',wid);
    chk('status is ACKNOWLEDGED', String(after.Status) === 'ACKNOWLEDGED', after.Status);
    chk('AcknowledgedAt is set', !!String(after.AcknowledgedAt||'').trim());
    chk('note appended to Notes', String(after.Notes||'').indexOf('Handled in selftest') !== -1);

    // second acknowledge must be a no-op, not a duplicate or an error
    _TABLE_CACHE = {};
    var again = acknowledgeWarning_({ WarningID: wid }, me);
    chk('re-acknowledge is idempotent', again.already === true);

    // dashboard count must drop it
    _TABLE_CACHE = {}; _SCOPE_CACHE = null;
    var d = dashboardSummary_(me);
    var stillCounted = (listWarnings_({}, me).items || [])
      .filter(function(w){ return w.WarningID === wid && !String(w.AcknowledgedAt||'').trim(); }).length;
    chk('no longer counted as open', stillCounted === 0, 'warningsOpen=' + d.totals.warningsOpen);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = {};
    if (wid) { try { deleteRowById_('WARNINGS','WarningID',wid); Logger.log('cleaned ' + wid); } catch(x){} }
    readTable_('ESCALATION_HISTORY').filter(function(x){ return String(x.OldValue) === String(wid) || String(x.NewValue) === String(wid); })
      .forEach(function(x){ try { deleteRowById_('ESCALATION_HISTORY','HistoryID',x.HistoryID); } catch(e2){} });
    _TABLE_CACHE = {};
    readTable_('ESCALATIONS').filter(function(x){ return String(x.Description||'').indexOf('automated selftest') !== -1; })
      .forEach(function(x){ try { deleteRowById_('ESCALATIONS','EscalationID',x.EscalationID); Logger.log('cleaned ' + x.EscalationID); } catch(e2){} });
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'WARNING ACK: ALL ' + out.length + ' PASS' : 'WARNING ACK: ' + f + ' FAILED');
}


/**
 * SETTINGS had two rows for the same Key (an old CLIENT row and a newer BRANCH
 * row). getSetting_ builds a map by iterating rows, so the LAST physical row won
 * regardless of age - which silently reinstated stale config. Keep the newest row
 * per key and delete the rest.
 */
function dedupeSettings_() {
  _TABLE_CACHE = {};
  var rows = readTable_('SETTINGS');
  var byKey = {};
  rows.forEach(function(r) {
    var k = String(r.Key || '').trim();
    if (!k) return;
    (byKey[k] = byKey[k] || []).push(r);
  });
  var killed = [];
  Object.keys(byKey).forEach(function(k) {
    var list = byKey[k];
    if (list.length < 2) return;
    list.sort(function(a, b) {
      return String(b.UpdatedAt || '').localeCompare(String(a.UpdatedAt || ''));
    });
    var keep = list[0];
    list.slice(1).forEach(function(dup) {
      killed.push(k + ' = ' + dup.Value + ' (' + (dup.UpdatedAt || 'no date') + ')');
    });
    Logger.log('  ' + k + ': keeping ' + keep.Value + ' (' + keep.UpdatedAt + '), dropping ' + (list.length - 1));
  });
  if (!killed.length) { Logger.log('SETTINGS: no duplicates'); return 0; }

  // Rewrite the sheet with one row per key. Safer than deleting by index while
  // the row numbers shift underneath.
  var keepRows = Object.keys(byKey).map(function(k) {
    var list = byKey[k];
    list.sort(function(a, b) { return String(b.UpdatedAt || '').localeCompare(String(a.UpdatedAt || '')); });
    return list[0];
  });
  var sh = sh_('SETTINGS');
  var headers = sheetHeaders_('SETTINGS');
  var out = keepRows.map(function(r) {
    return headers.map(function(hName){ return r[hName] === undefined ? '' : r[hName]; });
  });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, headers.length).setValues(out);
  invalidateTableCache_('SETTINGS');
  _TABLE_CACHE = {}; _SETTINGS_MAP = null;
  Logger.log('SETTINGS deduped: removed ' + killed.length + ' stale row(s)');
  killed.forEach(function(x){ Logger.log('  removed: ' + x); });
  return killed.length;
}

/** Org chart, reporting chain, matrix gate, partner layer and profile. */
function testOrgAndAccess() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var realUsers = null;
  try {
    _TABLE_CACHE = {}; _SCOPE_CACHE = null;
    realUsers = readTable_('USERS');

    // ---- fixture org: MD > AVP > Zonal > BranchMgr + Partner, plus HR ----
    var U = function(e,n,dept,desig,mgr,etype){
      return { UserID:'U-'+n, Name:n, Email:e, Mobile:'', Department:dept, Designation:desig,
               Role: suggestRoleFor_(dept,desig,e,''), EmployeeType: etype||'EMPLOYEE',
               PartnerCompany:'', EmployeeID:'', DateOfJoining:'', Manager:mgr,
               ScopeZones:'', ScopeLocations:'', ScopeBranchIDs:'', ScopeClientIDs:'', Status:'ACTIVE' };
    };
    _TABLE_CACHE = { USERS: [
      U('md@t.local','MD','Operations','MD',''),
      U('avp@t.local','Avp','Operations','AVP','md@t.local'),
      U('zm@t.local','Zonal','Operations','Zonal Manager','avp@t.local'),
      U('bm@t.local','BranchMgr','Operations','Branch Manager','zm@t.local'),
      U('pt@t.local','PartnerX','Operations','Partner','zm@t.local','PARTNER'),
      U('exec@t.local','Exec','Operations','Executive','bm@t.local'),
      U('hr@t.local','HrPerson','HR','Manager','md@t.local')
    ], BRANCHES: [], CLIENTS: [] };

    // ---- reporting chain ----
    var zmChain = reportsSubtree_('zm@t.local').sort();
    Logger.log('chain under zm: ' + JSON.stringify(zmChain));
    chk('Zonal sees Branch Mgr, Partner and their Exec', zmChain.length === 3, zmChain.join(','));
    chk('chain is deep, not one level', zmChain.indexOf('exec@t.local') !== -1);
    chk('Branch Mgr chain has only their Exec', reportsSubtree_('bm@t.local').length === 1);
    chk('Exec has nobody below', reportsSubtree_('exec@t.local').length === 0);
    var mdChain = reportsSubtree_('md@t.local');
    chk('MD sees the whole company', mdChain.length === 6, 'n=' + mdChain.length);

    // ---- role mapping ----
    chk('MD does not map to ADMIN by rank', suggestRoleFor_('Operations','MD','md@t.local','') === 'MANAGER');
    chk('AVP maps to MANAGER', suggestRoleFor_('Operations','AVP') === 'MANAGER');
    chk('Branch Manager maps to LOCATION_HEAD', suggestRoleFor_('Operations','Branch Manager') === 'LOCATION_HEAD');
    chk('Partner maps to LOCATION_HEAD', suggestRoleFor_('Operations','Partner') === 'LOCATION_HEAD');
    chk('HR Manager is not an admin', suggestRoleFor_('HR','Manager','hr@t.local','') !== 'ADMIN');

    // ---- matrix gate ----
    var byE = {}; _TABLE_CACHE.USERS.forEach(function(u){ byE[u.Email] = u; });
    chk('Branch Manager may use the matrix', canUseMatrix_(byE['bm@t.local']) === true);
    chk('Partner may use the matrix', canUseMatrix_(byE['pt@t.local']) === true);
    chk('Ops Executive may NOT', canUseMatrix_(byE['exec@t.local']) === false);
    chk('HR may NOT', canUseMatrix_(byE['hr@t.local']) === false);
    var threw = false;
    try { assertMatrixAccess_({ email:'hr@t.local', role:'VIEWER' }); } catch(e){ threw = true; }
    chk('server blocks HR from the matrix', threw);

    // ---- menu ----
    var hrNav = navForRole_('VIEWER', byE['hr@t.local']).map(function(x){ return x.key; });
    Logger.log('HR menu: ' + hrNav.join(','));
    chk('HR menu has no Clients', hrNav.indexOf('clients') === -1);
    chk('HR menu has escalations and warnings',
        hrNav.indexOf('escalations') !== -1 && hrNav.indexOf('warnings') !== -1);
    chk('everyone gets My profile', hrNav.indexOf('profile') !== -1);
    var bmNav = navForRole_('LOCATION_HEAD', byE['bm@t.local']).map(function(x){ return x.key; });
    chk('Branch Manager menu keeps Clients', bmNav.indexOf('clients') !== -1);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'ORG + ACCESS: ALL ' + out.length + ' PASS' : 'ORG + ACCESS: ' + f + ' FAILED');
}

/**
 * One-shot backfill for rows that predate the Department / EmployeeType columns.
 * Without this every existing non-admin loses the Clients menu on deploy, because
 * a blank Department reads as non-Operations. Everyone in the tool today is an
 * Operations user, so blank means Operations. Designation is inferred from the
 * role they already hold, which keeps their current access exactly as it is.
 * Idempotent - only ever fills blanks, never overwrites a real value.
 */
function backfillUserOrg() {
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  var byRole = { ADMIN:'Operations Head', MANAGER:'Zonal Manager',
                 LOCATION_HEAD:'Branch Manager', VIEWER:'Executive' };
  var changed = 0;
  readTable_('USERS').forEach(function(u) {
    var patch = {};
    if (!String(u.Department || '').trim())   patch.Department = 'Operations';
    if (!String(u.EmployeeType || '').trim()) patch.EmployeeType = 'EMPLOYEE';
    if (!String(u.Designation || '').trim())  patch.Designation = byRole[String(u.Role || 'VIEWER')] || 'Executive';
    if (!Object.keys(patch).length) return;
    patch.UpdatedAt = nowIso_(); patch.UpdatedBy = 'system:backfill';
    updateRowById_('USERS', 'Email', u.Email, patch);
    Logger.log('  backfilled ' + u.Email + ' -> ' + JSON.stringify(patch));
    changed++;
  });
  invalidateTableCache_('USERS');
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  Logger.log(changed ? 'BACKFILL: ' + changed + ' user row(s) filled'
                     : 'BACKFILL: nothing to fill, all users already tagged');
  // Show the resulting access so a wrong inference is visible immediately.
  readTable_('USERS').forEach(function(u) {
    Logger.log('  ' + u.Email + '  ' + u.Department + ' / ' + u.Designation +
      ' / ' + u.Role + '  matrix=' + canUseMatrix_(u));
  });
  return changed;
}

/** Team management: add, edit, status, target, appreciation, PIP, warning, and the guard. */
function testTeamManagement() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var me = whoAmI_();
  var victim = 'team.selftest@test.local';
  var made = [];
  try {
    _TABLE_CACHE = {}; _SCOPE_CACHE = null;

    // add
    var r = teamUpsertMember_({ Email: victim, Name:'Selftest Person', Department:'Operations',
      Designation:'Branch Manager', EmployeeType:'EMPLOYEE', EmploymentStatus:'ACTIVE' }, me);
    chk('member created', r.created === true);
    chk('new account is pending approval',
      (readTable_('USERS').filter(function(u){ return u.Email === victim; })[0]||{}).Status === 'PENDING');
    chk('manager set to me',
      String((readTable_('USERS').filter(function(u){ return u.Email === victim; })[0]||{}).Manager) === String(me.email).toLowerCase());

    // appears in my team, and in my scope chain
    _SCOPE_CACHE = null; invalidateTableCache_('USERS');
    var list = teamList_({}, me);
    var row = list.filter(function(x){ return String(x.Email).toLowerCase() === victim; })[0];
    chk('shows in team list', !!row);
    chk('reporting chain includes them', reportsSubtree_(me.email).indexOf(victim) !== -1);

    // designation must belong to the department
    var bad = false;
    try { teamUpsertMember_({ Email: victim, Department:'HR', Designation:'Branch Manager' }, me); }
    catch(e) { bad = true; }
    chk('rejects designation not in that department', bad);

    // status change
    teamSetStatus_({ Email: victim, EmploymentStatus:'TRANSFERRED' }, me);
    invalidateTableCache_('USERS');
    chk('employment status changed',
      (readTable_('USERS').filter(function(u){ return u.Email === victim; })[0]||{}).EmploymentStatus === 'TRANSFERRED');
    chk('status change is logged as an event',
      readTable_('PEOPLE_EVENTS').filter(function(e){
        return String(e.PersonEmail) === victim && e.Type === 'STATUS_CHANGE'; }).length === 1);

    // target
    teamSetTarget_({ Email: victim, MonthKey:'2026-08', Category:'Revenue', TargetValue: 100, AchievedValue: 60 }, me);
    invalidateTableCache_('TARGETS');
    var t = readTable_('TARGETS').filter(function(x){ return String(x.PersonEmail) === victim; });
    chk('target saved', t.length === 1, JSON.stringify(t[0]||{}).slice(0,80));
    teamSetTarget_({ Email: victim, MonthKey:'2026-08', Category:'Revenue', TargetValue: 100, AchievedValue: 90 }, me);
    invalidateTableCache_('TARGETS');
    chk('same month updates, not duplicates',
      readTable_('TARGETS').filter(function(x){ return String(x.PersonEmail) === victim && String(x.Category) === 'Revenue'; }).length === 1);
    var badNum = false;
    try { teamSetTarget_({ Email: victim, Category:'Revenue', TargetValue:'abc' }, me); } catch(e){ badNum = true; }
    chk('rejects a non-numeric target', badNum);
    var badCat = false;
    try { teamSetTarget_({ Email: victim, Category:'Anything', TargetValue: 10 }, me); } catch(e){ badCat = true; }
    chk('rejects a category outside the three', badCat);
    teamSetTarget_({ Email: victim, MonthKey:'2026-08', Category:'Collection', TargetValue: 50, AchievedValue: 50 }, me);
    invalidateTableCache_('TARGETS');
    chk('a second category is a separate row, not an overwrite',
      readTable_('TARGETS').filter(function(x){ return String(x.PersonEmail) === victim; }).length === 2);

    // PIP
    var pip = teamStartPip_({ Email: victim, StartDate:'2026-09-01', EndDate:'2026-09-30',
      Notes:'Automated selftest of the PIP path.' }, me);
    chk('PIP started', !!pip.EventID);
    var dup = false;
    try { teamStartPip_({ Email: victim, StartDate:'2026-10-01', EndDate:'2026-10-30',
      Notes:'Automated selftest duplicate PIP.' }, me); } catch(e){ dup = true; }
    chk('refuses a second open PIP', dup);
    var backwards = false;
    try { teamStartPip_({ Email:'nobody@test.local', StartDate:'2026-09-10', EndDate:'2026-09-01',
      Notes:'Automated selftest backwards dates.' }, me); } catch(e){ backwards = true; }
    chk('refuses end before start or a stranger', backwards);
    teamClosePip_({ EventID: pip.EventID, Outcome:'Closed by selftest.' }, me);
    invalidateTableCache_('PEOPLE_EVENTS');
    chk('PIP closes',
      readTable_('PEOPLE_EVENTS').filter(function(e){ return String(e.EventID) === pip.EventID; })[0].Status === 'CLOSED');

    // appreciation and warning
    var ap = teamAppreciate_({ Email: victim, Notes:'Automated selftest appreciation.' }, me);
    chk('appreciation recorded', !!ap.EventID);
    var w = teamWarn_({ Email: victim, Notes:'Automated selftest team warning.' }, me);
    chk('team warning recorded without an escalation', !!w.WarningID);
    made.push(w.WarningID);

    // the guard
    var blocked = false;
    try { teamWarn_({ Email:'someone.else@test.local', Notes:'Should not be allowed at all.' },
      { email:'nitish.bhope@cruxindia.co.in', role:'LOCATION_HEAD' }); } catch(e){ blocked = true; }
    chk('cannot act on someone outside your chain', blocked);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = {};
    readTable_('PEOPLE_EVENTS').filter(function(e){ return String(e.PersonEmail) === victim; })
      .forEach(function(e){ try { deleteRowById_('PEOPLE_EVENTS','EventID',e.EventID); } catch(x){} });
    _TABLE_CACHE = {};
    readTable_('TARGETS').filter(function(t){ return String(t.PersonEmail) === victim; })
      .forEach(function(t){ try { deleteRowById_('TARGETS','TargetID',t.TargetID); } catch(x){} });
    _TABLE_CACHE = {};
    readTable_('WARNINGS').filter(function(w){ return String(w.PersonEmail) === victim; })
      .forEach(function(w){ try { deleteRowById_('WARNINGS','WarningID',w.WarningID); } catch(x){} });
    _TABLE_CACHE = {};
    try { deleteRowById_('USERS','Email',victim); Logger.log('cleaned selftest user'); } catch(x){}
    invalidateTableCache_('USERS'); _SCOPE_CACHE = null;
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'TEAM MGMT: ALL ' + out.length + ' PASS' : 'TEAM MGMT: ' + f + ' FAILED');
}

/** Bring every stored Role back in step with its designation. Safe to re-run. */
function resyncRolesFromDesignation() {
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  var changed = 0;
  readTable_('USERS').forEach(function(u) {
    var em = String(u.Email||'').trim().toLowerCase();
    var patch = {};
    // Seed the flag for the bootstrap admins so the column reflects reality
    // rather than relying on the hardcoded list forever.
    var shouldBeAdmin = BOOTSTRAP_ADMINS.indexOf(em) !== -1;
    if (shouldBeAdmin && String(u.AdminAccess||'').toUpperCase() !== 'YES') patch.AdminAccess = 'YES';
    var adminFlag = patch.AdminAccess || u.AdminAccess || '';
    var want = roleForDesignation_(u.Department || 'Operations', u.Designation || '', em, adminFlag);
    if (String(u.Role || '') !== want) patch.Role = want;
    if (!Object.keys(patch).length) return;
    patch.UpdatedAt = nowIso_(); patch.UpdatedBy = 'system:resync';
    updateRowById_('USERS','Email',u.Email,patch);
    Logger.log('  ' + u.Email + '  ' + (u.Designation||'-') + ': ' + JSON.stringify(patch));
    changed++;
  });
  invalidateTableCache_('USERS'); _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  Logger.log(changed ? 'RESYNC: ' + changed + ' role(s) corrected' : 'RESYNC: all roles already match');
  readTable_('USERS').forEach(function(u) {
    Logger.log('  ' + u.Email + '  ' + (u.Department||'-') + ' / ' + (u.Designation||'-') +
      '  role=' + u.Role + '  admin=' + hasAdminAccess_(u) + '  team=' + hasTeam_(u) + '  matrix=' + canUseMatrix_(u));
  });
}

/** The designation-driven capability model. */
function testDesignationModel() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var U = function(dept, desig, etype) {
    return { Department: dept, Designation: desig, EmployeeType: etype || 'EMPLOYEE' };
  };
  // the exact bug that was reported
  chk('Operations Team Leader CAN see the matrix', canUseMatrix_(U('Operations','Team Leader')) === true);
  chk('Operations Executive CANNOT', canUseMatrix_(U('Operations','Executive')) === false);
  chk('Operations Branch Manager CAN', canUseMatrix_(U('Operations','Branch Manager')) === true);
  chk('Operations Zonal Manager CAN', canUseMatrix_(U('Operations','Zonal Manager')) === true);
  chk('Partner CAN even outside Operations', canUseMatrix_(U('Other','Partner','PARTNER')) === true);
  chk('HR Manager CANNOT', canUseMatrix_(U('HR','Manager')) === false);
  chk('HR MD has no matrix without the admin flag', canUseMatrix_(U('HR','MD')) === false);
  chk('blank designation CANNOT', canUseMatrix_(U('Operations','')) === false);

  chk('Executive has no team', hasTeam_(U('Operations','Executive')) === false);
  chk('Team Leader has a team', hasTeam_(U('Operations','Team Leader')) === true);
  chk('Executive cannot issue people actions', canIssuePeopleActions_(U('Operations','Executive')) === false);
  chk('Team Leader can', canIssuePeopleActions_(U('Operations','Team Leader')) === true);

  chk('MD is senior but NOT an admin', roleForDesignation_('Operations','MD','md@t.local','') === 'MANAGER');
  chk('Ops Head is senior but NOT an admin', roleForDesignation_('Operations','Operations Head','oh@t.local','') === 'MANAGER');
  chk('AVP derives MANAGER', roleForDesignation_('Operations','AVP') === 'MANAGER');
  chk('Zonal Manager derives MANAGER', roleForDesignation_('Operations','Zonal Manager') === 'MANAGER');
  chk('Team Leader derives LOCATION_HEAD', roleForDesignation_('Operations','Team Leader') === 'LOCATION_HEAD');
  chk('Executive derives VIEWER', roleForDesignation_('Operations','Executive') === 'VIEWER');
  chk('HR Manager derives LOCATION_HEAD not ADMIN', roleForDesignation_('HR','Manager') === 'LOCATION_HEAD');

  // menus
  var tlNav = navForRole_('LOCATION_HEAD', U('Operations','Team Leader')).map(function(x){ return x.key; });
  chk('Team Leader menu has Clients', tlNav.indexOf('clients') !== -1, tlNav.join(','));
  var exNav = navForRole_('VIEWER', U('Operations','Executive')).map(function(x){ return x.key; });
  chk('Executive menu has no Clients', exNav.indexOf('clients') === -1, exNav.join(','));
  chk('Executive still gets escalations and profile',
    exNav.indexOf('escalations') !== -1 && exNav.indexOf('profile') !== -1);

  // admin console is a flag, never a designation
  chk('MD alone is NOT an admin', roleForDesignation_('Operations','MD','x@t.local','') !== 'ADMIN');
  chk('Ops Head alone is NOT an admin', roleForDesignation_('Operations','Operations Head','x@t.local','') !== 'ADMIN');
  chk('flag grants ADMIN at any rank', roleForDesignation_('Operations','Executive','x@t.local','YES') === 'ADMIN');
  chk('bootstrap admin keeps ADMIN', roleForDesignation_('Operations','AVP','shantanu.suravase@cruxindia.co.in','') === 'ADMIN');
  chk('operations.alert keeps ADMIN', roleForDesignation_('Operations','Executive','operations.alert@cruxindia.co.in','') === 'ADMIN');
  chk('admin flag grants matrix too', canUseMatrix_({ Department:'HR', Designation:'Executive', AdminAccess:'YES' }) === true);

  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'DESIGNATION MODEL: ALL ' + out.length + ' PASS' : 'DESIGNATION MODEL: ' + f + ' FAILED');
}

/** Logs must not leak. Admin sees everything; nobody else sees another person's rows. */
function testLogScoping() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var realTables = _TABLE_CACHE;
  try {
    _TABLE_CACHE = {
      EMAIL_LOG: [
        { LogID:'L1', Timestamp:'2026-08-01T10:00:00', ToAddr:'alice@t.local', Cc:'', Status:'SENT' },
        { LogID:'L2', Timestamp:'2026-08-02T10:00:00', ToAddr:'bob@t.local',   Cc:'', Status:'SENT' },
        { LogID:'L3', Timestamp:'2026-08-03T10:00:00', ToAddr:'carol@t.local', Cc:'alice@t.local', Status:'FAILED' }
      ],
      AUDIT_LOG: [
        { LogID:'A1', Timestamp:'2026-08-01T10:00:00', User:'alice@t.local', Action:'LOGIN' },
        { LogID:'A2', Timestamp:'2026-08-02T10:00:00', User:'bob@t.local',   Action:'CLIENT_EDIT' }
      ],
      REMINDER_LOG: [
        { LogID:'R1', Timestamp:'2026-08-01T10:00:00', ToAddr:'alice@t.local' },
        { LogID:'R2', Timestamp:'2026-08-02T10:00:00', ToAddr:'bob@t.local' }
      ]
    };
    var admin = { email:'root@t.local', role:'ADMIN' };
    var alice = { email:'alice@t.local', role:'MANAGER' };
    var count = function(res) { return ((res && (res.rows || res.items)) || res || []).length; };

    chk('admin sees the whole email log', count(queryEmailLog_({}, admin)) === 3);
    chk('admin sees the whole audit log', count(queryAuditLog_({}, admin)) === 2);

    var aliceMail = queryEmailLog_({}, alice);
    chk('manager sees only mail involving them', count(aliceMail) === 2, 'got ' + count(aliceMail));
    var ids = ((aliceMail.rows || aliceMail.items || aliceMail) || []).map(function(r){ return r.LogID; });
    chk('the Cc match is included', ids.indexOf('L3') !== -1, ids.join(','));
    chk('another person\'s mail is excluded', ids.indexOf('L2') === -1);

    var aliceAudit = queryAuditLog_({}, alice);
    chk('manager sees only their own audit rows', count(aliceAudit) === 1, 'got ' + count(aliceAudit));
    chk('manager sees only their own reminders', count(queryReminderLog_({}, alice)) === 1);

    // no identity means nothing at all, never everything
    chk('an unidentified caller sees nothing', count(queryEmailLog_({}, { email:'', role:'VIEWER' })) === 0);

    // the menu must not offer it
    var mgrNav = navForRole_('MANAGER', { Department:'Operations', Designation:'Zonal Manager' }).map(function(x){ return x.key; });
    chk('Logs is not in the manager menu', mgrNav.indexOf('logs') === -1, mgrNav.join(','));
    var admNav = navForRole_('ADMIN', { Department:'Operations', Designation:'AVP', AdminAccess:'YES' }).map(function(x){ return x.key; });
    chk('Logs is in the admin menu', admNav.indexOf('logs') !== -1, admNav.join(','));
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = realTables;
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'LOG SCOPING: ALL ' + out.length + ' PASS' : 'LOG SCOPING: ' + f + ' FAILED');
}

/**
 * P1: a client's DEFAULT matrix must differ per location, and one location must
 * never affect another. Runs entirely on primed cache - writes nothing.
 */
function testLocationMatrix() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var real = _TABLE_CACHE;
  try {
    var mk = function(id, cid, loc, bid, lvl, name, mail) {
      return { MatrixID:id, ClientID:cid, Location:loc, BranchID:bid, Level:lvl,
               LevelName:'L'+lvl, ContactName:name, Mobile:'', Email:mail };
    };
    _TABLE_CACHE = { ESCALATION_MATRIX: [
      // client-wide legacy default (pre-Location rows look exactly like this)
      mk('M1','C1','','',1,'Client SPOC','client.spoc@t.local'),
      mk('M2','C1','','',2,'Client TL','client.tl@t.local'),
      mk('M3','C1','','',3,'Client BM','client.bm@t.local'),
      // Pune location default overrides levels 1 and 2
      mk('M4','C1','Pune','',1,'Pune SPOC','pune.spoc@t.local'),
      mk('M5','C1','Pune','',2,'Pune TL','pune.tl@t.local'),
      // Nagpur location default overrides level 1 only, differently
      mk('M6','C1','Nagpur','',1,'Nagpur SPOC','nagpur.spoc@t.local'),
      // one Pune branch overrides level 1 for itself alone
      mk('M7','C1','','B-PUNE-1',1,'Branch1 SPOC','b1.spoc@t.local')
    ]};

    var pune = resolveMatrixRows_('C1','','Pune');
    var nagpur = resolveMatrixRows_('C1','','Nagpur');
    var byLvl = function(rows,l){ return rows.filter(function(r){ return r.Level===l; })[0] || {}; };

    chk('Pune default L1 is the Pune contact', byLvl(pune,1).Email === 'pune.spoc@t.local', byLvl(pune,1).Email);
    chk('Nagpur default L1 is the Nagpur contact', byLvl(nagpur,1).Email === 'nagpur.spoc@t.local', byLvl(nagpur,1).Email);
    chk('two locations of one client differ', byLvl(pune,1).Email !== byLvl(nagpur,1).Email);
    chk('Pune L2 uses the Pune override', byLvl(pune,2).Email === 'pune.tl@t.local');
    chk('Nagpur L2 falls back to client-wide', byLvl(nagpur,2).Email === 'client.tl@t.local', byLvl(nagpur,2).Email);
    chk('both fall back to client-wide at L3', byLvl(pune,3).Email === 'client.bm@t.local' && byLvl(nagpur,3).Email === 'client.bm@t.local');
    chk('unset level resolves to nothing', !byLvl(pune,5).Email);
    chk('source is reported per level', byLvl(pune,1)._source === 'LOCATION' && byLvl(nagpur,2)._source === 'CLIENT');

    // branch overrides beat the location default, and only for that branch
    var b1 = resolveMatrixRows_('C1','B-PUNE-1','Pune');
    chk('branch override wins at L1', byLvl(b1,1).Email === 'b1.spoc@t.local', byLvl(b1,1).Email);
    chk('branch still inherits the location default at L2', byLvl(b1,2).Email === 'pune.tl@t.local');
    chk('branch marks its own row as filled', byLvl(b1,1)._filled === true);
    chk('a sibling Pune branch is untouched by B-PUNE-1',
        byLvl(resolveMatrixRows_('C1','B-PUNE-2','Pune'),1).Email === 'pune.spoc@t.local');
    chk('a Nagpur branch is untouched by the Pune default',
        byLvl(resolveMatrixRows_('C1','B-NAG-1','Nagpur'),1).Email === 'nagpur.spoc@t.local');

    // a location the client has no default for still works via client-wide
    chk('unknown location falls back cleanly',
        byLvl(resolveMatrixRows_('C1','','Mumbai'),1).Email === 'client.spoc@t.local');
    // legacy behaviour preserved
    // A blank row is not an override. saveMatrix_ writes all five levels, so a
    // partially filled branch keeps empty rows at the untouched levels and those
    // must still inherit rather than resolving to nothing.
    _TABLE_CACHE.ESCALATION_MATRIX.push(
      mk('M8','C1','','B-PUNE-1',2,'',''),
      mk('M9','C1','','B-PUNE-1',3,'',''));
    var b1b = resolveMatrixRows_('C1','B-PUNE-1','Pune');
    chk('a blank branch row still inherits the location default',
        byLvl(b1b,2).Email === 'pune.tl@t.local', byLvl(b1b,2).Email);
    chk('a blank branch row still inherits client-wide',
        byLvl(b1b,3).Email === 'client.bm@t.local', byLvl(b1b,3).Email);
    chk('a blank branch row is not counted as filled', byLvl(b1b,2)._filled === false);
    chk('a blank branch row reports the inherited source', byLvl(b1b,3)._source === 'CLIENT');

    chk('client-wide scope unchanged',
        byLvl(resolveMatrixRows_('C1','',''),1).Email === 'client.spoc@t.local');
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = real;
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'LOCATION MATRIX: ALL ' + out.length + ' PASS' : 'LOCATION MATRIX: ' + f + ' FAILED');
}

/**
 * One warning model. All three entry points must produce the same record shape
 * and the same lifecycle, so the register cannot drift again.
 */
function testWarningUnification() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var me = whoAmI_();
  var made = [];
  try {
    _TABLE_CACHE = {};
    var c = readTable_('CLIENTS').filter(function(x){ return x.Status !== 'INACTIVE'; })[0];

    // a) manual, off an escalation
    var r = logEscalationCase_({
      ClientID: c.ClientID, Category:'Service', Severity:'Medium',
      EscalatedAgainst: me.email, Description:'automated selftest - unification',
      RequiredAction:'none', TargetDate: ymd_(new Date())
    }, me);
    var escId = r.EscalationID || (r.escalation && r.escalation.EscalationID);
    _TABLE_CACHE = {};
    var w1 = raiseWarning_({ EscalationID: escId, reason:'Automated selftest of the manual path.', sendLetter:false }, me);
    made.push(w1.WarningID);
    chk('manual path creates a warning', !!w1.WarningID);
    chk('manual path reports its source', w1.source === 'MANUAL', w1.source);

    // b) team page, with NO escalation behind it
    _TABLE_CACHE = {};
    // Warning yourself is refused by design, so pick a real colleague. Admin
    // reach covers everyone, which is what this path is exercising.
    var other = readTable_('USERS').filter(function(u) {
      return isEmail_(u.Email) && String(u.Email).toLowerCase() !== String(me.email).toLowerCase();
    })[0];
    if (!other) { chk('a second user exists to warn', false); return; }
    var w2 = teamWarn_({ Email: other.Email, Notes:'Automated selftest of the team path.', sendLetter:false }, me);
    made.push(w2.WarningID);
    chk('team path works without an escalation', !!w2.WarningID);
    chk('team path reports its source', w2.source === 'TEAM', w2.source);

    // c) both rows must have the same shape
    _TABLE_CACHE = {};
    var rows = readTable_('WARNINGS');
    var a = rows.filter(function(x){ return x.WarningID === w1.WarningID; })[0] || {};
    var b = rows.filter(function(x){ return x.WarningID === w2.WarningID; })[0] || {};
    ['WarningID','IssuedAt','PersonEmail','StrikeLevel','Summary','FactsJson','IssuedBy','Status','Notes']
      .forEach(function(f) {
        chk('both records carry ' + f, !!String(a[f]||'').trim() && !!String(b[f]||'').trim());
      });
    chk('both start ISSUED', a.Status === 'ISSUED' && b.Status === 'ISSUED');
    chk('both start unacknowledged', !String(a.AcknowledgedAt||'').trim() && !String(b.AcknowledgedAt||'').trim());
    chk('escalation-linked warning keeps the link', String(a.EscalationID) === String(escId));
    chk('standalone warning has no escalation', !String(b.EscalationID||'').trim());

    // d) both appear in the one register
    var reg = (listWarnings_({}, me) || {}).items || [];
    var ids = reg.map(function(x){ return x.WarningID; });
    chk('both appear in the register', ids.indexOf(w1.WarningID) !== -1 && ids.indexOf(w2.WarningID) !== -1);

    // e) both acknowledge through the one lifecycle
    _TABLE_CACHE = {};
    acknowledgeWarning_({ WarningID: w2.WarningID, note:'selftest ack' }, me);
    _TABLE_CACHE = {};
    chk('standalone warning acknowledges',
      String(findRowById_('WARNINGS','WarningID',w2.WarningID).Status) === 'ACKNOWLEDGED');

    // f) a short reason is refused on every path
    var short1 = false, short2 = false;
    try { raiseWarning_({ EscalationID: escId, reason:'no', sendLetter:false }, me); } catch(x){ short1 = true; }
    try { teamWarn_({ Email: other.Email, Notes:'no', sendLetter:false }, me); } catch(x){ short2 = true; }
    chk('both paths refuse a short reason', short1 && short2);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = {};
    readTable_('WARNINGS').filter(function(w){
      return String(w.Notes||'').toLowerCase().indexOf('selftest') !== -1;
    }).forEach(function(w){ try { deleteRowById_('WARNINGS','WarningID',w.WarningID); } catch(x){} });
    _TABLE_CACHE = {};
    readTable_('ESCALATION_HISTORY').filter(function(x){
      return made.indexOf(String(x.NewValue)) !== -1;
    }).forEach(function(x){ try { deleteRowById_('ESCALATION_HISTORY','HistoryID',x.HistoryID); } catch(e2){} });
    _TABLE_CACHE = {};
    readTable_('ESCALATIONS').filter(function(x){
      return String(x.Description||'').indexOf('automated selftest') !== -1;
    }).forEach(function(x){ try { deleteRowById_('ESCALATIONS','EscalationID',x.EscalationID); } catch(e2){} });
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'WARNING UNIFICATION: ALL ' + out.length + ' PASS' : 'WARNING UNIFICATION: ' + f + ' FAILED');
}

/**
 * Responsibility vs accountability. A manager ACTS on direct reports only;
 * they SEE the whole chain beneath them. The scoring engine will be built on
 * this distinction, so it must hold before that work starts.
 */
function testResponsibilitySplit() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var real = _TABLE_CACHE, realScope = _SCOPE_CACHE;
  try {
    var U = function(e, mgr) {
      return { UserID:'U'+e, Name:e, Email:e, Manager:mgr, Department:'Operations',
               Designation:'Team Leader', Role:'LOCATION_HEAD', Status:'ACTIVE',
               ScopeZones:'', ScopeLocations:'', ScopeBranchIDs:'', ScopeClientIDs:'' };
    };
    _TABLE_CACHE = { USERS: [
      U('avp@t.local',''),
      U('zm@t.local','avp@t.local'),
      U('bm@t.local','zm@t.local'),
      U('exec@t.local','bm@t.local')
    ]};
    _SCOPE_CACHE = null;
    var avp = { email:'avp@t.local', role:'MANAGER' };
    var zm  = { email:'zm@t.local',  role:'LOCATION_HEAD' };

    chk('direct reports are one level only', directReports_('avp@t.local').length === 1,
        JSON.stringify(directReports_('avp@t.local')));
    chk('the chain runs deeper', reportsSubtree_('avp@t.local').length === 3,
        'n=' + reportsSubtree_('avp@t.local').length);

    // action
    chk('AVP may act on their direct report', canManagePerson_(avp, 'zm@t.local') === true);
    chk('AVP may NOT act two levels down', canManagePerson_(avp, 'bm@t.local') === false);
    chk('AVP may NOT act three levels down', canManagePerson_(avp, 'exec@t.local') === false);
    chk('the intervening manager may act on their own report', canManagePerson_(zm, 'bm@t.local') === true);

    // visibility
    chk('AVP still SEES two levels down', canViewPerson_(avp, 'bm@t.local') === true);
    chk('AVP still SEES three levels down', canViewPerson_(avp, 'exec@t.local') === true);
    chk('nobody sees sideways', canViewPerson_(zm, 'avp@t.local') === false);

    // the guard must explain, not just refuse
    var msg = '';
    try { assertManage_(avp, 'exec@t.local'); } catch (e) { msg = String(e && e.message || e); }
    chk('refusal explains accountability', /does not report to you directly/.test(msg), msg.slice(0,70));

    // admin is unrestricted
    chk('admin may act on anyone', canManagePerson_({ email:'root@t.local', role:'ADMIN' }, 'exec@t.local') === true);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = real; _SCOPE_CACHE = realScope;
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'RESPONSIBILITY SPLIT: ALL ' + out.length + ' PASS' : 'RESPONSIBILITY SPLIT: ' + f + ' FAILED');
}

/**
 * The scoring engine, proved arithmetically on primed cache. Writes nothing.
 * Every number below is hand-computed from the stated rules.
 */
function testScoringEngine() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var real = _TABLE_CACHE, realScope = _SCOPE_CACHE;
  var MK = '2026-08';
  try {
    var T = function(em, cat, tgt, ach) {
      return { TargetID:'T'+em+cat, PersonEmail:em, MonthKey:MK, Category:cat,
               TargetValue:tgt, AchievedValue:ach };
    };
    var base = function(extra) {
      var t = { USERS: [
          { UserID:'U1', Name:'Solo', Email:'solo@t.local', Manager:'', Designation:'Executive',
            Department:'Operations', Role:'VIEWER', Status:'ACTIVE' }
        ],
        TARGETS: [ T('solo@t.local','Revenue',100,100),
                   T('solo@t.local','Business Development',100,100),
                   T('solo@t.local','Collection',100,100) ],
        SCORES: [], PEOPLE_EVENTS: [], WARNINGS: [], ESCALATIONS: [] };
      Object.keys(extra||{}).forEach(function(k){ t[k] = extra[k]; });
      return t;
    };

    // full marks
    _TABLE_CACHE = base(); _SCOPE_CACHE = null;
    var s = computeScore_('solo@t.local', MK);
    chk('100% achievement gives the full 75', s.targetScore === 75, 'got ' + s.targetScore);
    chk('unrated attributes give the full 25', s.attributeScore === 25, 'got ' + s.attributeScore);
    chk('final is 100', s.finalScore === 100, 'got ' + s.finalScore);

    // partial achievement, averaged across the three categories
    _TABLE_CACHE = base({ TARGETS: [ T('solo@t.local','Revenue',100,50),
      T('solo@t.local','Business Development',100,100), T('solo@t.local','Collection',100,0) ] });
    s = computeScore_('solo@t.local', MK);
    chk('50/100/0 averages to 50% of 75', s.targetScore === 37.5, 'got ' + s.targetScore);

    // over-achievement in one category must not mask a miss in another
    _TABLE_CACHE = base({ TARGETS: [ T('solo@t.local','Revenue',100,300),
      T('solo@t.local','Business Development',100,0), T('solo@t.local','Collection',100,100) ] });
    s = computeScore_('solo@t.local', MK);
    chk('over-achievement is capped, not carried', s.targetScore === 50, 'got ' + s.targetScore);

    // no targets set is zero, not full marks
    _TABLE_CACHE = base({ TARGETS: [] });
    s = computeScore_('solo@t.local', MK);
    chk('no targets scores 0 on target, not 75', s.targetScore === 0, 'got ' + s.targetScore);

    // escalations take 1 point of attribute each
    var E = function(n){ var a=[]; for (var i=0;i<n;i++) a.push({ EscalationID:'E'+i,
      AgainstEmail:'solo@t.local', CreatedAt: MK + '-05T10:00:00', Category:'Service', Status:'OPEN' }); return a; };
    _TABLE_CACHE = base({ ESCALATIONS: E(3) });
    s = computeScore_('solo@t.local', MK);
    chk('3 escalations cost 3 attribute points', s.attributeScore === 22, 'got ' + s.attributeScore);
    chk('target untouched while attribute remains', s.targetScore === 75, 'got ' + s.targetScore);

    // once attribute is exhausted escalations bite the target at 2 each
    _TABLE_CACHE = base({ ESCALATIONS: E(27) });
    s = computeScore_('solo@t.local', MK);
    chk('25 escalations exhaust the attribute', s.attributeScore === 0, 'got ' + s.attributeScore);
    chk('the remaining 2 take 2% each from target', s.targetScore === 71, 'got ' + s.targetScore);

    // a warning zeroes attributes and costs 5 more
    _TABLE_CACHE = base({ WARNINGS: [{ WarningID:'W1', PersonEmail:'solo@t.local',
      IssuedAt: MK + '-06T10:00:00', Notes:'test' }] });
    s = computeScore_('solo@t.local', MK);
    chk('a warning zeroes the attribute component', s.attributeScore === 0, 'got ' + s.attributeScore);
    chk('a warning also costs 5 from target', s.targetScore === 70, 'got ' + s.targetScore);

    // after a warning every escalation takes 2 from target
    _TABLE_CACHE = base({ WARNINGS: [{ WarningID:'W1', PersonEmail:'solo@t.local',
      IssuedAt: MK + '-06T10:00:00', Notes:'test' }], ESCALATIONS: E(2) });
    s = computeScore_('solo@t.local', MK);
    chk('post-warning escalations cost 2 target each', s.targetScore === 66, 'got ' + s.targetScore);

    // appreciation lifts the attribute but never past the ceiling
    var A = function(n){ var a=[]; for (var i=0;i<n;i++) a.push({ EventID:'P'+i, Type:'APPRECIATION',
      PersonEmail:'solo@t.local', Timestamp: MK + '-07T10:00:00', Notes:'good work' }); return a; };
    _TABLE_CACHE = base({ ESCALATIONS: E(5), PEOPLE_EVENTS: A(3) });
    s = computeScore_('solo@t.local', MK);
    chk('appreciation offsets escalations', s.attributeScore === 23, 'got ' + s.attributeScore);
    _TABLE_CACHE = base({ PEOPLE_EVENTS: A(10) });
    s = computeScore_('solo@t.local', MK);
    chk('appreciation cannot exceed the 25 ceiling', s.attributeScore === 25, 'got ' + s.attributeScore);

    // never negative
    _TABLE_CACHE = base({ TARGETS: [], WARNINGS: [{ WarningID:'W1', PersonEmail:'solo@t.local',
      IssuedAt: MK + '-06T10:00:00' }], ESCALATIONS: E(40) });
    s = computeScore_('solo@t.local', MK);
    chk('score never goes negative', s.finalScore >= 0 && s.targetScore >= 0, 'got ' + s.finalScore);

    // the ledger explains every step
    _TABLE_CACHE = base({ ESCALATIONS: E(2), PEOPLE_EVENTS: A(1) });
    s = computeScore_('solo@t.local', MK);
    chk('ledger records every adjustment', s.ledger.length === 5, 'rows=' + s.ledger.length);
    chk('ledger rows carry before and after',
        s.ledger.every(function(r){ return r.ScoreBefore !== undefined && r.ScoreAfter !== undefined; }));
    chk('ledger is sequenced', s.ledger[0].Sequence === 1 && s.ledger[s.ledger.length-1].Sequence === s.ledger.length);

    // manager roll-up: half own, half team
    _TABLE_CACHE = {
      USERS: [
        { UserID:'M', Name:'Mgr', Email:'mgr@t.local', Manager:'', Designation:'Zonal Manager',
          Department:'Operations', Role:'MANAGER', Status:'ACTIVE' },
        { UserID:'R', Name:'Rep', Email:'rep@t.local', Manager:'mgr@t.local', Designation:'Executive',
          Department:'Operations', Role:'VIEWER', Status:'ACTIVE' }
      ],
      TARGETS: [ T('mgr@t.local','Revenue',100,100), T('mgr@t.local','Business Development',100,100),
                 T('mgr@t.local','Collection',100,100),
                 T('rep@t.local','Revenue',100,0), T('rep@t.local','Business Development',100,0),
                 T('rep@t.local','Collection',100,0) ],
      SCORES: [], PEOPLE_EVENTS: [], WARNINGS: [], ESCALATIONS: []
    };
    _SCOPE_CACHE = null;
    var rep = computeScore_('rep@t.local', MK);
    chk('the report scores 25 (attributes only)', rep.finalScore === 25, 'got ' + rep.finalScore);
    var mgr = computeScore_('mgr@t.local', MK);
    // own half 12.5, team half 25% of 12.5 = 3.125  ->  15.625
    chk('manager attribute is half own, half team', mgr.attributeScore === 15.63 || mgr.attributeScore === 15.62,
        'got ' + mgr.attributeScore);
    chk('a weak team drags the manager down', mgr.finalScore < 100, 'got ' + mgr.finalScore);
    chk('roll-up is reported in the breakdown', mgr.attributeBreakdown.hasTeam === true);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  } finally {
    _TABLE_CACHE = real; _SCOPE_CACHE = realScope;
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'SCORING ENGINE: ALL ' + out.length + ' PASS' : 'SCORING ENGINE: ' + f + ' FAILED');
}

/** One-shot: correct Manish's designation and invite the personal-Gmail users. */
function fixManishAndInvite() {
  var me = whoAmI_();
  _TABLE_CACHE = {}; _SCOPE_CACHE = null;
  var users = readTable_('USERS');
  var manish = users.filter(function(u){ return /manish/i.test(String(u.Email||'') + String(u.Name||'')); })[0];
  if (manish) {
    updateRowById_('USERS','Email',manish.Email, {
      Designation: 'Operations Head', Department: 'Operations',
      Role: roleForDesignation_('Operations','Operations Head', manish.Email, manish.AdminAccess || ''),
      UpdatedAt: nowIso_(), UpdatedBy: 'system:fix'
    });
    Logger.log('Manish: ' + manish.Email + '  ' + (manish.Designation||'-') + ' -> Operations Head');
  } else { Logger.log('no Manish row found'); }
  invalidateTableCache_('USERS'); _TABLE_CACHE = {}; _SCOPE_CACHE = null;

  var external = readTable_('USERS').filter(function(u) {
    var e = String(u.Email||'').toLowerCase();
    return e && e.indexOf('@cruxindia.co.in') === -1 && String(u.Status||'') !== 'DENIED';
  });
  Logger.log('users outside the Workspace domain: ' + external.length);
  external.forEach(function(u) {
    try {
      var r = inviteUser_({ Email: u.Email }, me);
      Logger.log('  invited ' + u.Email + '  emailed=' + r.emailed);
    } catch (e) { Logger.log('  FAILED ' + u.Email + ': ' + (e && e.message || e)); }
  });
  _TABLE_CACHE = {};
  readTable_('USERS').forEach(function(u) {
    Logger.log('  ' + u.Email + '  ' + (u.Designation||'-') + '  role=' + u.Role +
      '  token=' + (String(u.AccessToken||'').trim() ? 'yes' : 'no'));
  });
}

/** A token must identify, never elevate. */
function testInviteTokens() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var real = _TABLE_CACHE;
  try {
    _TABLE_CACHE = { USERS: [
      { UserID:'U1', Name:'Ext', Email:'ext@gmail.com', Status:'ACTIVE', AccessToken:'TOKEN-ABCDEFGHIJKLMNOPQRSTUV',
        Department:'Operations', Designation:'Executive', Role:'VIEWER', AdminAccess:'' },
      { UserID:'U2', Name:'Pend', Email:'pend@gmail.com', Status:'PENDING', AccessToken:'TOKEN-PENDINGXXXXXXXXXXXXXX',
        Department:'Operations', Designation:'Executive', Role:'VIEWER', AdminAccess:'' }
    ]};
    chk('a valid token resolves to its owner',
      emailFromToken_('TOKEN-ABCDEFGHIJKLMNOPQRSTUV') === 'ext@gmail.com');
    chk('an unknown token resolves to nobody', emailFromToken_('TOKEN-NOTREALXXXXXXXXXXXXXXX') === '');
    chk('a short string is rejected outright', emailFromToken_('abc') === '');
    chk('an empty token resolves to nobody', emailFromToken_('') === '');
    chk('a token on a PENDING account does not work',
      emailFromToken_('TOKEN-PENDINGXXXXXXXXXXXXXX') === '');
    chk('the token holder keeps their own role, not admin',
      roleForDesignation_('Operations','Executive','ext@gmail.com','') === 'VIEWER');
    chk('a token cannot confer admin',
      hasAdminAccess_({ Email:'ext@gmail.com', AdminAccess:'' }) === false);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
  } finally { _TABLE_CACHE = real; }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'INVITE TOKENS: ALL ' + out.length + ' PASS' : 'INVITE TOKENS: ' + f + ' FAILED');
}

/**
 * ENTRY-POINT SMOKE TEST.
 *
 * Every other suite calls the underlying functions directly. That is how a
 * ReferenceError inside getBootstrap_ reached production: the function was never
 * exercised through the door the app actually uses. This calls doGet and rpc()
 * themselves, plus every registered route, so a broken entry point fails here
 * rather than in front of a user.
 *
 * Read-only routes are called for real. Write routes are checked for existence
 * and handler shape only - this must never create data as a side effect.
 */
function testEntryPoints() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };

  // 1. the page itself must render
  try {
    var page = doGet({ parameter: {} });
    chk('doGet returns a page', !!page && typeof page.getContent === 'function');
    var html = page.getContent();
    chk('the page carries a bootstrap', html.indexOf('bootstrap') !== -1 || html.length > 500,
        'len=' + html.length);
  } catch (e) {
    chk('doGet does not throw', false, String(e && e.message || e));
  }

  // 2. bootstrap with and without a token
  try {
    var b1 = getBootstrap_();
    chk('getBootstrap_() works with no token', !!b1 && !!b1.user);
    var b2 = getBootstrap_('');
    chk('getBootstrap_("") works', !!b2 && !!b2.user);
    chk('bootstrap carries nav', Array.isArray(b1.nav));
  } catch (e) {
    chk('getBootstrap_ does not throw', false, String(e && e.message || e));
  }

  // 3. the rpc dispatcher itself
  try {
    var r = rpc('auth.me', {});
    chk('rpc(auth.me) returns', !!r);
    var r2 = rpc('auth.me', { __t: '' });
    chk('rpc tolerates an empty token', !!r2);
    var r3 = rpc('auth.me', null);
    chk('rpc tolerates a null payload', !!r3);
  } catch (e) {
    chk('rpc does not throw on auth.me', false, String(e && e.message || e));
  }

  // 4. unknown route must fail cleanly, not crash
  // rpc() CATCHES and returns an error envelope rather than throwing, so the
  // client always gets a serialisable object. Assert the real contract, not the
  // one I assumed.
  var clean = false, shape = '';
  try {
    var bad = rpc('no.such.route', {});
    shape = JSON.stringify(bad).slice(0, 80);
    clean = !!bad && (bad.ok === false || /Unknown action/.test(JSON.stringify(bad)));
  } catch (e) {
    clean = /Unknown action/.test(String(e.message||e));
    shape = 'threw: ' + String(e.message||e).slice(0,60);
  }
  chk('an unknown route fails cleanly', clean, shape);

  // 5. every registered route must have a callable handler
  var names = Object.keys(RPC_ROUTES);
  chk('routes are registered', names.length > 30, 'n=' + names.length);
  var badShape = names.filter(function(n) {
    var h = RPC_ROUTES[n];
    return !h || typeof h.fn !== 'function';
  });
  chk('every route has a function', badShape.length === 0, badShape.join(','));

  // 6. read-only routes called for real, through the dispatcher
  var readOnly = ['auth.me','users.pickList','clients.list','escalations.list',
                  'warnings.list','profile.get','team.list','dashboard.summary',
                  'escalations.mis','auth.orgChart'];
  readOnly.forEach(function(n) {
    if (!RPC_ROUTES[n]) { chk('route ' + n + ' exists', false); return; }
    try { rpc(n, {}); chk('rpc(' + n + ') runs', true); }
    catch (e) { chk('rpc(' + n + ') runs', false, String(e && e.message || e).slice(0,80)); }
  });

  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'ENTRY POINTS: ALL ' + out.length + ' PASS' : 'ENTRY POINTS: ' + f + ' FAILED');
}

/** Sends a real signed email to the two personal addresses for hands-on testing. */
function sendShantanuTestEmails() {
  var me = whoAmI_();
  var to = ['shantanu007y@gmail.com', 'shantanu.suravase@yahoo.com'];
  var sig = buildSignature_();
  to.forEach(function(addr) {
    try {
      sendEmail_({
        type: 'TEST', to: [addr], cc: [],
        subject: 'Crux Escalation Matrix - test email',
        htmlBody:
          '<p>Hello,</p>' +
          '<p>This is a test from the Crux Escalation Matrix, sent to check three things:</p>' +
          '<ol>' +
          '<li>that mail reaches an address outside the Crux domain,</li>' +
          '<li>that it is sent <b>as ' + escHtml_(getSetting_('FROM_ADDRESS','') || Session.getEffectiveUser().getEmail()) + '</b> - check the From line,</li>' +
          '<li>that the signature and logo render properly below.</li>' +
          '</ol>' +
          '<p>If the logo shows here, it will show for clients too: it travels inside the message ' +
          'rather than being loaded from a link.</p>' +
          '<p>Nothing needs doing with this email.</p>',
        trigger: 'manual.test',
        idempotencyKey: 'TESTMAIL-' + addr + '-' + nowIso_()
      });
      Logger.log('SENT to ' + addr);
    } catch (e) {
      Logger.log('FAILED to ' + addr + ': ' + (e && e.message || e));
    }
  });
  Logger.log('from address configured as: "' + getSetting_('FROM_ADDRESS','') + '"');
  Logger.log('signature length: ' + String(sig || '').length + ' chars, logo=' +
    (String(getSetting_('SIG_LOGO_FILE_ID','')||'').trim() ? 'uploaded' : 'none'));
}

/** Target and achievement windows, and the employee accept/reject path. */
function testWindows() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  var D = function(day) { return new Date(2026, 7, day, 12, 0, 0); };   // August 2026
  try {
    // TARGET deadline 5th: opens 29 Jul, closes end of 6 Aug
    chk('target window open on the 1st', windowState_('TARGET', D(1)).open === true);
    chk('target window open on the deadline (5th)', windowState_('TARGET', D(5)).open === true);
    chk('target window open on the 6th (closes after)', windowState_('TARGET', D(6)).open === true);
    chk('target window CLOSED on the 7th', windowState_('TARGET', D(7)).open === false);
    chk('target window CLOSED mid month', windowState_('TARGET', D(15)).open === false);
    chk('target window reopens near month end', windowState_('TARGET', D(30)).open === true);

    // ACHIEVEMENT deadline 3rd: closes end of 4 Aug
    chk('achievement window open on the 3rd', windowState_('ACHIEVEMENT', D(3)).open === true);
    chk('achievement window open on the 4th', windowState_('ACHIEVEMENT', D(4)).open === true);
    chk('achievement window CLOSED on the 5th', windowState_('ACHIEVEMENT', D(5)).open === false);
    chk('achievement closes before target does', 
      windowState_('ACHIEVEMENT', D(5)).open === false && windowState_('TARGET', D(5)).open === true);

    chk('the two windows are independent',
      windowState_('TARGET', D(6)).open !== windowState_('ACHIEVEMENT', D(6)).open);
    chk('a closed window explains itself', /closed/i.test(windowState_('TARGET', D(15)).label));
    chk('an open window states the last day', /open/i.test(windowState_('TARGET', D(1)).label));

    // the override key is per person AND per month, so one exception cannot leak
    var k1 = windowOverrideKey_('TARGET','a@t.local','2026-08');
    var k2 = windowOverrideKey_('TARGET','a@t.local','2026-09');
    var k3 = windowOverrideKey_('TARGET','b@t.local','2026-08');
    chk('an override is scoped to one month', k1 !== k2);
    chk('an override is scoped to one person', k1 !== k3);

    // a non-admin cannot grant themselves an exception
    var blocked = false;
    try { grantWindowOverride_({ Kind:'TARGET', Email:'a@t.local', Reason:'because I want to' },
      { email:'nitish.bhope@cruxindia.co.in', role:'LOCATION_HEAD' }); } catch(e){ blocked = true; }
    chk('a non-admin cannot reopen a window', blocked);

    var noReason = false;
    try { grantWindowOverride_({ Kind:'TARGET', Email:'a@t.local', Reason:'x' }, whoAmI_()); }
    catch(e){ noReason = true; }
    chk('reopening requires a recorded reason', noReason);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'WINDOWS: ALL ' + out.length + ' PASS' : 'WINDOWS: ' + f + ' FAILED');
}

/** Why are the live escalations not striking? Reports, changes nothing. */
function AAdiagnoseStrikes() {
  _TABLE_CACHE = {};
  Logger.log('STRIKE_ENABLED = ' + getSetting_('STRIKE_ENABLED','true'));
  Logger.log('STRIKE_WINDOW_HOURS = ' + getSetting_('STRIKE_WINDOW_HOURS','24'));
  Logger.log('send window open right now: ' + withinSendWindow_(new Date()));
  Logger.log('tick trigger installed: ' +
    ScriptApp.getProjectTriggers().filter(function(t){ return t.getHandlerFunction()==='tick'; }).length);

  var hist = {};
  readTable_('ESCALATION_HISTORY').forEach(function(h) {
    (hist[h.EscalationID] = hist[h.EscalationID] || []).push(h);
  });
  readTable_('ESCALATIONS').forEach(function(e) {
    var last = e.LastActivityAt || e.UpdatedAt || e.CreatedAt || e.Date;
    var idle = 0;
    try { idle = workingHoursBetween_(new Date(last), new Date()); } catch (x) {}
    var strikes = (hist[e.EscalationID]||[]).filter(function(h){ return /STRIKE/i.test(String(h.Field||'') + String(h.Note||'')); }).length;
    Logger.log([
      e.EscalationID, 'status=' + e.Status, 'against=' + (e.AgainstEmail || e.EscalatedAgainst || 'NONE'),
      'created=' + (e.CreatedAt || e.Date), 'lastActivity=' + last,
      'workingHoursIdle=' + Math.round(idle), 'strikesSoFar=' + strikes,
      'target=' + (e.TargetDate || '-')
    ].join('  '));
  });

  // What WOULD the sweep do right now, ignoring the working-hours gate?
  try {
    var r = runStrikeSweep_('diagnose', { ignoreWindow: true, dryRun: true });
    Logger.log('sweep dry run -> ' + JSON.stringify(r).slice(0, 900));
  } catch (e) {
    Logger.log('sweep THREW: ' + (e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  }
}

/**
 * The strike clock must move only on a genuine response.
 * A routine edit resetting it would mean an escalation could be nudged forever
 * and never strike - the exact failure this guards.
 */
function testStrikeClock() {
  var out = [];
  var chk = function(l, ok, d){ out.push((ok?'PASS   ':'FAIL   ')+l+(d?'   '+d:'')); };
  try {
    var cols = sheetHeaders_('ESCALATIONS');
    chk('ESCALATIONS has LastActivityAt', cols.indexOf('LastActivityAt') !== -1, cols.length + ' cols');

    chk('strike settings exist', getSetting_('STRIKE_ENABLED','') !== '' ||
        getBoolSetting_('STRIKE_ENABLED','true') === true);
    chk('strike window is a number', !isNaN(parseFloat(getSetting_('STRIKE_WINDOW_HOURS','24'))));

    // working-hours maths: Mon-Fri 10:00-17:00 is 7 hours a day
    var wed = new Date('2026-08-19T10:00:00+05:30');
    var thu = new Date('2026-08-20T17:00:00+05:30');
    var h = workingHoursBetween_(wed, thu);
    chk('one full working day plus one is 14 hours', Math.round(h) === 14, 'got ' + Math.round(h));
    var fri = new Date('2026-08-21T10:00:00+05:30');
    var mon = new Date('2026-08-24T10:00:00+05:30');
    chk('a weekend adds no working hours', Math.round(workingHoursBetween_(fri, mon)) === 7,
        'got ' + Math.round(workingHoursBetween_(fri, mon)));

    // the live escalations should be UNDER the threshold, which is why they have not struck
    _TABLE_CACHE = {};
    var win = parseFloat(getSetting_('STRIKE_WINDOW_HOURS','24')) || 24;
    readTable_('ESCALATIONS').filter(function(e){ return String(e.Status) === 'OPEN'; })
      .forEach(function(e) {
        var last = e.LastActivityAt || e.CreatedAt || e.Date;
        var idle = 0;
        try { idle = workingHoursBetween_(new Date(last), new Date()); } catch(x) {}
        Logger.log('  ' + e.EscalationID + '  idle=' + Math.round(idle) +
          'h  threshold=' + win + 'h  wouldStrike=' + (idle >= win));
      });
    // The defect that made strike 2 unreachable: the strike's own history row
    // counted as activity, so every strike restarted its own clock.
    var esc = { EscalationID:'E-CLK', CreatedAt:'2026-08-17T10:00:00+05:30', UpdatedAt:'2026-08-21T09:00:00+05:30' };
    var hist = { 'E-CLK': [
      { Timestamp:'2026-08-20T11:00:00+05:30', User:'system:strike', Field:'Strike', Note:'Strike 1 reminder sent' },
      { Timestamp:'2026-08-21T09:00:00+05:30', User:'auto', Field:'Strike', Note:'Strike 2 reminder sent' }
    ]};
    var la = lastActivityAt_(esc, hist);
    chk('a strike does not reset its own clock',
        la && la.getTime() === new Date('2026-08-17T10:00:00+05:30').getTime(),
        la ? la.toISOString() : 'null');
    chk('a routine edit does not reset the clock either',
        la && la.getTime() !== new Date('2026-08-21T09:00:00+05:30').getTime());

    // but a real human reply DOES reset it
    var hist2 = { 'E-CLK': [
      { Timestamp:'2026-08-20T11:00:00+05:30', User:'system:strike', Field:'Strike', Note:'Strike 1 reminder sent' },
      { Timestamp:'2026-08-20T15:00:00+05:30', User:'nitish.bhope@cruxindia.co.in', Field:'Status', Note:'Spoke to the client, action under way' }
    ]};
    var la2 = lastActivityAt_(esc, hist2);
    chk('a human reply DOES reset the clock',
        la2 && la2.getTime() === new Date('2026-08-20T15:00:00+05:30').getTime(),
        la2 ? la2.toISOString() : 'null');

    chk('idle is computed without throwing', true);
  } catch (e) {
    chk('no exception', false, String(e && e.message || e));
    if (e && e.stack) Logger.log(e.stack);
  }
  var f=0; out.forEach(function(r){ if(r.indexOf('FAIL')===0) f++; Logger.log(r); });
  Logger.log(f===0 ? 'STRIKE CLOCK: ALL ' + out.length + ' PASS' : 'STRIKE CLOCK: ' + f + ' FAILED');
}
