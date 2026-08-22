/**
 * bootstrap-deploy.gs — install this repo into the Apps Script project, then
 * update the EXISTING deployment so the shared /exec URL does not change.
 *
 * WHY THIS EXISTS
 * Deploying normally means installing clasp locally, cloning, copying 18 files and
 * pushing. This does the same job from inside the editor: it fetches the code from
 * the public GitHub repo and writes it back through the Apps Script API using the
 * editor's own authorisation. One paste, one Run.
 *
 * WHAT IT DOES NOT DO
 * It does not run the data migrations (M2-M5) and it does not send invitations.
 * Those stay manual on purpose - M2 invalidates every existing sign-in link, which
 * is not something a script should do without somebody deciding to.
 *
 * AFTER IT RUNS
 * The project is exactly what is in git: this bootstrap file is gone and the
 * manifest is the clean one, with no lingering permission to rewrite the project.
 * To deploy again later, paste this file again.
 */

// ---------------------------------------------------------------- configuration
var REPO   = 'crux-operationsalert-art/crux_escalationmanagement';
var BRANCH = 'claude/full-stack-execution-x9z1qd';
var SCRIPT_ID = ScriptApp.getScriptId();

/** Every file in src/, and how the Apps Script API types it. */
var FILES = [
  ['appsscript.json', 'JSON',      'appsscript'],
  ['Code.gs',         'SERVER_JS', 'Code'],
  ['Sheets.gs',       'SERVER_JS', 'Sheets'],
  ['Auth.gs',         'SERVER_JS', 'Auth'],
  ['Session.gs',      'SERVER_JS', 'Session'],
  ['Clients.gs',      'SERVER_JS', 'Clients'],
  ['Import.gs',       'SERVER_JS', 'Import'],
  ['Email.gs',        'SERVER_JS', 'Email'],
  ['Scheduler.gs',    'SERVER_JS', 'Scheduler'],
  ['Escalation.gs',   'SERVER_JS', 'Escalation'],
  ['Gemini.gs',       'SERVER_JS', 'Gemini'],
  ['PortalSvc.gs',    'SERVER_JS', 'PortalSvc'],
  ['Migrate.gs',      'SERVER_JS', 'Migrate'],
  ['Preflight.gs',    'SERVER_JS', 'Preflight'],
  ['Utils.gs',        'SERVER_JS', 'Utils'],
  ['Index.html',      'HTML',      'Index'],
  ['App.html',        'HTML',      'App'],
  ['Styles.html',     'HTML',      'Styles'],
  ['Portal.html',     'HTML',      'Portal']
];

/* ============================================================================
 * STEP 1 — read only. Run this FIRST. It writes nothing.
 * Confirms the API is reachable, every file downloads, and shows which
 * deployment would be updated.
 * ========================================================================== */
function step1_check() {
  var log = [];
  log.push('Script ID: ' + SCRIPT_ID);

  // Can we reach the Apps Script API with this project's own token?
  var res = api_('GET', '/v1/projects/' + SCRIPT_ID);
  if (res.code !== 200) {
    log.push('');
    log.push('FAILED to read this project through the Apps Script API (HTTP ' + res.code + ').');
    log.push(res.body.slice(0, 500));
    log.push('');
    log.push('Almost always one of two things:');
    log.push('  1. The Apps Script API is off for your account. Turn it on at');
    log.push('     https://script.google.com/home/usersettings');
    log.push('  2. The manifest is missing the two scopes. See the instructions.');
    Logger.log(log.join('\n'));
    return log.join('\n');
  }
  log.push('Apps Script API: OK');

  // Does every file download from GitHub?
  var missing = [], bytes = 0;
  FILES.forEach(function(f) {
    var r = fetchRaw_(f[0]);
    if (r === null) missing.push(f[0]); else bytes += r.length;
  });
  log.push('GitHub ' + REPO + '@' + BRANCH);
  log.push('Files downloaded: ' + (FILES.length - missing.length) + '/' + FILES.length +
           ' (' + Math.round(bytes / 1024) + ' KB)');
  if (missing.length) log.push('MISSING: ' + missing.join(', '));

  // Which deployment would be updated?
  var d = listDeployments_();
  log.push('');
  log.push('Deployments found: ' + d.all.length);
  d.all.forEach(function(x) {
    var c = x.deploymentConfig || {};
    log.push('  ' + x.deploymentId + '  version=' + (c.versionNumber || '@HEAD') +
             '  ' + (c.description || ''));
  });
  log.push('');
  log.push(d.target
    ? 'WOULD UPDATE: ' + d.target.deploymentId + ' (this keeps the /exec URL)'
    : 'No versioned deployment found. step2 will refuse rather than create a new ' +
      'one, because a new deployment means a NEW /exec URL.');

  log.push('');
  log.push(missing.length || !d.target
    ? '>>> NOT READY. Fix the above first.'
    : '>>> READY. Now run step2_deploy.');
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/* ============================================================================
 * STEP 2 — writes the code and updates the existing deployment.
 * ========================================================================== */
function step2_deploy() {
  var log = [];

  // Gather everything BEFORE writing, so a download failure cannot leave the
  // project half-updated.
  var payload = { files: [] };
  var missing = [];
  FILES.forEach(function(f) {
    var src = fetchRaw_(f[0]);
    if (src === null) { missing.push(f[0]); return; }
    payload.files.push({ name: f[2], type: f[1], source: src });
  });
  if (missing.length) {
    throw new Error('Refusing to write: could not download ' + missing.join(', '));
  }
  if (payload.files.length !== FILES.length) {
    throw new Error('Refusing to write: expected ' + FILES.length + ' files, got ' +
                    payload.files.length);
  }

  // Which deployment are we updating? Establish this BEFORE overwriting the code,
  // because this bootstrap is about to delete itself.
  var d = listDeployments_();
  if (!d.target) {
    throw new Error('No versioned deployment found to update. Creating one would ' +
      'mint a NEW /exec URL, which must not happen. Check Deploy > Manage ' +
      'deployments and re-run step1_check.');
  }
  var deploymentId = d.target.deploymentId;
  var oldDesc = (d.target.deploymentConfig || {}).description || '';
  log.push('Updating deployment ' + deploymentId);

  // 1. Write the code. This replaces the whole project, so this bootstrap file
  //    and the temporary scopes both disappear - which is the intended end state.
  var put = api_('PUT', '/v1/projects/' + SCRIPT_ID + '/content', payload);
  if (put.code !== 200) {
    throw new Error('Writing the project failed (HTTP ' + put.code + '): ' +
                    put.body.slice(0, 600));
  }
  log.push('Wrote ' + payload.files.length + ' files.');

  // 2. Version it.
  var ver = api_('POST', '/v1/projects/' + SCRIPT_ID + '/versions',
    { description: 'Deployed from ' + BRANCH + ' at ' + new Date().toISOString() });
  if (ver.code !== 200) {
    throw new Error('Creating a version failed (HTTP ' + ver.code + '): ' +
      ver.body.slice(0, 400) + '\nThe CODE is already updated; finish by hand in ' +
      'Deploy > Manage deployments.');
  }
  var versionNumber = JSON.parse(ver.body).versionNumber;
  log.push('Created version ' + versionNumber + '.');

  // 3. Point the EXISTING deployment at it. Never create a new one.
  var upd = api_('PUT', '/v1/projects/' + SCRIPT_ID + '/deployments/' + deploymentId, {
    deploymentConfig: {
      scriptId: SCRIPT_ID,
      versionNumber: versionNumber,
      manifestFileName: 'appsscript',
      description: oldDesc || 'Crux Escalation Matrix'
    }
  });
  if (upd.code !== 200) {
    throw new Error('Updating the deployment failed (HTTP ' + upd.code + '): ' +
      upd.body.slice(0, 400) + '\nVersion ' + versionNumber + ' exists; point the ' +
      'existing deployment at it by hand in Deploy > Manage deployments.');
  }

  log.push('Deployment now serves version ' + versionNumber + '.');
  log.push('');
  log.push('The /exec URL is unchanged.');
  log.push('');
  log.push('NEXT, and none of it is optional:');
  log.push('  1. Reload the editor. This bootstrap file is gone (expected).');
  log.push('  2. Run retireLegacyTokensDryRun, read the log, then retireLegacyTokens.');
  log.push('     Until this runs, every old ?t= link still works.');
  log.push('  3. Run canonicaliseLocationsDryRun then canonicaliseLocations.');
  log.push('  4. Run purgeOrphanHistoryDryRun then purgeOrphanHistory.');
  log.push('  5. Run normaliseTargetAllocationsDryRun then normaliseTargetAllocations.');
  log.push('  6. In the app: Admin > Users > Invite everyone marked NEEDS_REINVITE.');
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/* ------------------------------------------------------------------ internals */

/** Apps Script API call, authorised with this project's own token. */
function api_(method, path, body) {
  var opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: 'application/json',
    muteHttpExceptions: true
  };
  if (body) opts.payload = JSON.stringify(body);
  var r = UrlFetchApp.fetch('https://script.googleapis.com' + path, opts);
  return { code: r.getResponseCode(), body: r.getContentText() };
}

/** One file from the public repo, or null. */
function fetchRaw_(name) {
  var url = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/src/' + name;
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return r.getResponseCode() === 200 ? r.getContentText() : null;
}

/**
 * Deployments, and which one to update.
 *
 * Apps Script always reports a @HEAD deployment (the editor's own test target,
 * versionNumber absent). That is NOT the shared web app. The one to update is the
 * versioned deployment; if there are several, the most recently versioned.
 */
function listDeployments_() {
  var r = api_('GET', '/v1/projects/' + SCRIPT_ID + '/deployments');
  if (r.code !== 200) return { all: [], target: null };
  var all = (JSON.parse(r.body).deployments || []);
  var versioned = all.filter(function(x) {
    return (x.deploymentConfig || {}).versionNumber;
  }).sort(function(a, b) {
    return b.deploymentConfig.versionNumber - a.deploymentConfig.versionNumber;
  });
  return { all: all, target: versioned[0] || null };
}
