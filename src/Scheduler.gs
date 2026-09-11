/**
 * Scheduler.gs — reminders (25th, LWD), monthly dispatch (1st).
 *
 * Google's time-driven triggers can drift by a few minutes. We therefore:
 *   1. Install a single "tick" trigger that fires every 5 minutes.
 *   2. Each tick checks: today's date + configured schedule time, and if
 *      the job is due AND not yet run this month, runs it exactly once.
 *   3. Idempotency is enforced by REMINDER_LOG.JobKey ("YYYY-MM-<TYPE>").
 *   4. LockService prevents concurrent execution.
 */

var JOB_TYPES = { R25:'REMINDER_25', RLW:'REMINDER_LWD', DIS:'MONTHLY_DISPATCH', SUM:'MONTHLY_SUMMARY', PLAN:'DISPATCH_PLAN' };

/** Called by the installable time-driven trigger every 5 minutes. */
function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var now = new Date();
    var tz = getTz_();
    var today = parseInt(Utilities.formatDate(now, tz, 'd'), 10);
    var hhmm  = Utilities.formatDate(now, tz, 'HH:mm');
    var month = Utilities.formatDate(now, tz, 'yyyy-MM');
    var remDay = parseInt(getSetting_('REMINDER_DAY_1','25'), 10);
    var remTime = getSetting_('REMINDER_TIME','12:00');
    var disDay = parseInt(getSetting_('MONTHLY_DISPATCH_DAY','1'), 10);
    var disTime = getSetting_('MONTHLY_DISPATCH_TIME','10:00');
    var sumDay = parseInt(getSetting_('MONTHLY_SUMMARY_DAY','2'), 10);
    var sumTime = getSetting_('MONTHLY_SUMMARY_TIME','09:00');
    // Reminder 25th
    if (today === remDay && hhmm >= remTime && !jobDone_(month, JOB_TYPES.R25)) {
      runReminder_(JOB_TYPES.R25, 'auto');
    }
    // Reminder LWD
    var lwd = lastWorkingDay_(now.getFullYear(), now.getMonth());
    var lwdDay = parseInt(Utilities.formatDate(lwd, tz, 'd'), 10);
    if (today === lwdDay && hhmm >= remTime && !jobDone_(month, JOB_TYPES.RLW)) {
      runReminder_(JOB_TYPES.RLW, 'auto');
    }
    // Monthly dispatch on the 1st — PLAN once, then drain a batch on every tick.
    // The queue survives across executions and days, so a 500-branch month is
    // sent in small pieces instead of one run that would time out or blow quota.
    if (today === disDay && hhmm >= disTime && !jobDone_(month, JOB_TYPES.PLAN)) {
      planDispatch_('auto');
    }
    // Three-strike chase. Self-limiting: silent outside working hours, and each
    // strike sends at most once per escalation via its idempotency key.
    try { runStrikeSweep_('auto'); } catch (e) { logAudit_({ user:'auto', action:'STRIKE_ERROR', entity:'ESCALATIONS', entityId:'', oldValue:'', newValue:String(e && e.message || e) }); }

    if (!jobDone_(month, JOB_TYPES.DIS)) {
      runDispatchQueue_('auto');
    }
    // Monthly summary digest on 2nd (of same month, reporting on previous month)
    if (today === sumDay && hhmm >= sumTime && !jobDone_(month, JOB_TYPES.SUM)) {
      runMonthlySummary_('auto');
    }
    // Weekly appreciation nudge (section 25). Monday morning; idempotent per
    // manager per ISO week, so the 5-minute tick cannot send it repeatedly.
    var apprDay  = parseInt(getSetting_('APPRECIATION_NUDGE_DAY', '1'), 10);
    var apprHour = parseInt(getSetting_('APPRECIATION_NUDGE_HOUR', '11'), 10);
    var isoDow   = Number(Utilities.formatDate(now, tz, 'u'));
    var hourNow  = Number(Utilities.formatDate(now, tz, 'H'));
    if (isoDow === apprDay && hourNow >= apprHour &&
        !jobDone_(isoWeekKey_(now), 'APPRECIATION_NUDGE')) {
      try { runAppreciationNudge_('auto', { now: now }); }
      catch (e) { logAudit_({ user:'auto', action:'APPRECIATION_NUDGE_ERROR',
        entity:'PEOPLE_EVENTS', entityId:'', oldValue:'', newValue:String(e && e.message || e) }); }
    }

    // Resend anything that failed. RETRY_LIMIT was configured but nothing ever
    // re-attempted a failed send, so a transient sender-alias error left eleven
    // escalation and people emails permanently undelivered with nothing
    // surfacing it. Bounded per tick so an outage cannot burn the daily quota.
    try { retryFailedEmails_(); }
    catch (e) { logAudit_({ user:'auto', action:'EMAIL_RETRY_ERROR', entity:'EMAIL_LOG',
      entityId:'', oldValue:'', newValue:String(e && e.message || e) }); }

    // Session housekeeping: drop rows that can no longer authenticate anything.
    try { if (typeof purgeDeadSessions_ === 'function') purgeDeadSessions_(); }
    catch (e) { /* never let housekeeping break the tick */ }
  } finally {
    lock.releaseLock();
  }
}

function jobDone_(monthKey, type) {
  var jobKey = monthKey + '-' + type;
  var rows = readTable_('REMINDER_LOG');
  return rows.some(function(r){ return r.JobKey === jobKey && r.Result === 'OK'; });
}

function recordJob_(monthKey, type, result, notes, executedBy) {
  appendRow_('REMINDER_LOG', {
    JobKey: monthKey + '-' + type, Type: type, Month: monthKey,
    ExecutedAt: nowIso_(), ExecutedBy: executedBy || 'auto',
    Result: result, Notes: notes || ''
  });
}

/** Sends the reminder email(s), grouped by Location Head. */
function runReminder_(type, executedBy, force) {
  var monthKey = Utilities.formatDate(new Date(), getTz_(), 'yyyy-MM');
  var jobKey = monthKey + '-' + type;
  if (jobDone_(monthKey, type)) return { skipped: true };
  var clients = readTable_('CLIENTS').filter(function(c){ return c.Status !== 'INACTIVE'; });
  var matrix = readTable_('ESCALATION_MATRIX');
  var matrixAll = matrix;
  // Group by LH email.
  var groups = {};
  clients.forEach(function(c) {
    var m = matrix.filter(function(x){ return x.ClientID === c.ClientID; });
    var v = validateClientMatrix_(c, m);
    var lh = String(c.DefaultLocationHead || '').toLowerCase();
    if (!lh) lh = 'unassigned';
    if (!groups[lh]) groups[lh] = [];
    groups[lh].push(Object.assign({}, c, { _status: v.complete ? 'Complete' : ('Missing: ' + v.missing.join(', ')) }));
  });
  var tpl = getTemplate_('REMINDER');
  var sent = 0, failed = 0;
  var defaultCc = parseListStr_(getSetting_('DEFAULT_CC',''));
  var mgr = getSetting_('ESCALATION_MANAGER','');
  Object.keys(groups).forEach(function(lh) {
    if (lh === 'unassigned' || !isEmail_(lh)) return; // don't email unassigned bucket
    var user = readTable_('USERS').filter(function(u){ return String(u.Email).toLowerCase() === lh; })[0] || { Name: lh.split('@')[0] };
    var vars = {
      LOCATION_HEAD_NAME: user.Name || lh,
      MONTH: Utilities.formatDate(new Date(), getTz_(), 'MMMM'),
      YEAR: Utilities.formatDate(new Date(), getTz_(), 'yyyy'),
      NEXT_MONTH: Utilities.formatDate(new Date(new Date().getFullYear(), new Date().getMonth()+1, 1), getTz_(), 'MMMM'),
      CLIENT_TABLE: clientListToHtml_(groups[lh]),
      APP_URL: ScriptApp.getService().getUrl() || '',
      SIGNATURE: getSetting_('SIGNATURE','')
    };
    var subj = renderTemplate_(tpl.Subject, vars);
    var body = renderTemplate_(tpl.Body, vars);
    try {
      var res = sendEmail_({
        type: type, to: [lh], cc: defaultCc.concat(mgr && isEmail_(mgr) ? [mgr] : []),
        subject: subj, htmlBody: body, trigger: 'scheduler.' + type,
        idempotencyKey: jobKey + '-' + lh
      });
      if (res.status === 'SENT' || res.skipped) sent++; else failed++;
    } catch (err) {
      failed++;
      appendRow_('EMAIL_LOG', {
        LogID: nextId_('EML'), Timestamp: nowIso_(), Type: type,
        ClientID: '', BranchID: '', ToAddr: lh, CcAddr: '', Subject: subj,
        Trigger: 'scheduler.' + type, SentBy: 'scheduler',
        Status: 'FAILED', Attempt: 1, Error: String(err && err.message || err),
        MessageRef: '', IdempotencyKey: jobKey + '-' + lh
      });
    }
  });
  recordJob_(monthKey, type, failed === 0 ? 'OK' : 'PARTIAL', 'sent=' + sent + ' failed=' + failed, executedBy);
  return { type: type, sent: sent, failed: failed };
}

/* ===================================================================
 * A2 QUEUED DISPATCH — resumable, quota-gated
 *
 * Why: the old runDispatch_ sent everything in one synchronous pass. At 500+
 * branches that breaks two hard Google limits:
 *   - 6-minute execution cap  -> the run dies part-way, leaving the month
 *     unmarked, so the next tick restarts it from the beginning.
 *   - ~1,500 email recipients/day -> a single client can exceed a whole day's
 *     allowance, and the excess sends simply throw.
 *
 * How: split into a PLANNER (writes one DISPATCH_QUEUE row per target, in one
 * setValues call) and a WORKER (runs on the existing 5-minute tick, claims a
 * small batch, checks remaining quota first, and stops cleanly when low —
 * resuming automatically on the next tick, or the next day once quota resets).
 * =================================================================== */

/** Remaining daily recipient allowance, or null when unavailable. */
function remainingQuota_() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return null; }
}

/** Resolve the recipient for a BRANCH-granularity target. */
/**
 * Resolve recipients for a BRANCH-granularity target.
 * BRANCH_RECIPIENT is a comma separated list of roles, so more can be added
 * without touching code. Roles: BRANCH_MANAGER, CRUX_POC, CLIENT, LOCATION_HEAD.
 * Anything in the list that looks like an email address is used verbatim, which
 * lets a fixed mailbox be added alongside the roles.
 * Returns an array. Previously it returned only the first match, so a branch
 * dispatch could only ever reach one person.
 */
function branchRecipients_(branch, client, allMatrixRows) {
  var raw = String(getSetting_('BRANCH_RECIPIENT', 'BRANCH_MANAGER,CRUX_POC'));
  var wanted = raw.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
  var byRole = {
    BRANCH_MANAGER: branch.BranchManagerEmail,
    CRUX_POC:       branch.CruxPOCEmail,
    SPOC:           branch.CruxPOCEmail,
    CLIENT:         client.ClientEmail,
    LOCATION_HEAD:  branch.LocationHead || client.DefaultLocationHead
  };
  var out = [];
  wanted.forEach(function(w) {
    var role = w.toUpperCase();

    // MATRIX_n routes to whoever the escalation matrix names at level n for THIS
    // branch, honouring branch -> client+location -> client-wide precedence. A
    // populated matrix had no effect on routing before this.
    var mx = /^MATRIX_([1-5])$/.exec(role);
    if (mx) {
      var hit = matrixContactForLevel_(client.ClientID, branch.BranchID,
        branch.Location, Number(mx[1]), allMatrixRows);
      if (hit) out.push(hit.email);
      return;
    }
    if (role === 'HEAD_OFFICE') {
      var ho = headOfficeRecipients_(client, branch.BranchID, branch.Location, allMatrixRows);
      ho.to.forEach(function(e) { out.push(e); });
      return;
    }
    var val = isEmail_(w) ? w : byRole[role];
    if (isEmail_(val)) out.push(val);
  });

  out = dedupeEmails_(out);
  // Never send nothing: fall back down the chain if the configured roles are blank.
  if (!out.length) {
    out = dedupeEmails_([branch.BranchManagerEmail, branch.CruxPOCEmail, client.ClientEmail])
      .slice(0, 1);
  }
  return out;
}

/** Back-compat: first recipient only. Kept for the queue Recipient column. */
function branchRecipient_(branch, client, allMatrixRows) {
  var list = branchRecipients_(branch, client, allMatrixRows);
  return list.length ? list.join(', ') : '';
}

/**
 * PLANNER. Enumerates this month's dispatch targets and writes them to
 * DISPATCH_QUEUE as PENDING. Safe to call repeatedly: it no-ops if this month
 * has already been planned.
 */
function planDispatch_(executedBy) {
  var now = new Date();
  var monthKey = Utilities.formatDate(now, getTz_(), 'yyyy-MM');
  var already = readTable_('DISPATCH_QUEUE').some(function(q){ return q.MonthKey === monthKey; });
  if (already) return { skipped: true, reason: 'already planned', monthKey: monthKey };

  var granularity = String(getSetting_('DISPATCH_GRANULARITY','CLIENT')).trim().toUpperCase();
  var clients = readTable_('CLIENTS').filter(function(c){ return c.Status !== 'INACTIVE'; });
  var rows = [];
  var seq = 0;

  if (granularity === 'BRANCH') {
    var branches = readTable_('BRANCHES').filter(function(b){ return b.Status !== 'INACTIVE'; });
    var byClient = {};
    clients.forEach(function(c){ byClient[c.ClientID] = c; });
    // Read the matrix ONCE. Recipient resolution is now matrix-aware, and at 800+
    // branches letting each call re-read a 470-row table would be 800 full scans
    // inside one six-minute execution.
    var matrixRows = readTable_('ESCALATION_MATRIX');
    branches.forEach(function(b) {
      var c = byClient[b.ClientID];
      if (!c) return;                       // orphan or inactive client
      rows.push({
        QueueID: 'DQ-' + monthKey + '-' + (++seq),
        MonthKey: monthKey, Granularity: 'BRANCH',
        ClientID: b.ClientID, BranchID: b.BranchID,
        Recipient: branchRecipient_(b, c, matrixRows),
        Status: 'PENDING', Attempt: 0, PlannedAt: nowIso_(),
        SentAt: '', Error: '',
        IdempotencyKey: monthKey + '-DISPATCH-' + b.BranchID
      });
    });
  } else {
    clients.forEach(function(c) {
      rows.push({
        QueueID: 'DQ-' + monthKey + '-' + (++seq),
        MonthKey: monthKey, Granularity: 'CLIENT',
        ClientID: c.ClientID, BranchID: '',
        Recipient: c.ClientEmail,
        Status: 'PENDING', Attempt: 0, PlannedAt: nowIso_(),
        SentAt: '', Error: '',
        IdempotencyKey: monthKey + '-DISPATCH-' + c.ClientID
      });
    });
  }

  appendRows_('DISPATCH_QUEUE', rows);
  recordJob_(monthKey, JOB_TYPES.PLAN, 'OK',
    'granularity=' + granularity + ' queued=' + rows.length, executedBy);
  return { monthKey: monthKey, granularity: granularity, queued: rows.length };
}

/**
 * WORKER. Claims up to DISPATCH_BATCH_SIZE pending rows and sends them.
 * Returns cleanly when quota is low or the queue is empty; the 5-minute tick
 * calls it again until the month is drained.
 */
function runDispatchQueue_(executedBy, force) {
  var now = new Date();
  var monthKey = Utilities.formatDate(now, getTz_(), 'yyyy-MM');
  var pending = readTable_('DISPATCH_QUEUE').filter(function(q) {
    return q.MonthKey === monthKey && (q.Status === 'PENDING' || q.Status === 'RETRY');
  });
  if (!pending.length) {
    if (!jobDone_(monthKey, JOB_TYPES.DIS)) {
      var all = readTable_('DISPATCH_QUEUE').filter(function(q){ return q.MonthKey === monthKey; });
      if (all.length) {
        var bad = all.filter(function(q){ return q.Status === 'FAILED'; }).length;
        recordJob_(monthKey, JOB_TYPES.DIS, bad === 0 ? 'OK' : 'PARTIAL',
          'queue drained: total=' + all.length + ' failed=' + bad, executedBy || 'auto');
      }
    }
    return { done: true, sent: 0, remaining: 0 };
  }

  // ADAPTIVE BATCH: rather than trusting a hand-tuned number, the worker sends
  // until its time budget is nearly spent, then stops and lets the next 5-minute
  // tick continue. Nothing needs measuring or tuning by hand — throughput is
  // whatever the account actually sustains, and it adjusts if Google gets slower.
  // DISPATCH_BATCH_SIZE remains a hard safety ceiling per run.
  var maxBatch = Math.max(1, parseInt(getSetting_('DISPATCH_BATCH_SIZE','200'), 10) || 200);
  var reserve = Math.max(0, parseInt(getSetting_('DISPATCH_QUOTA_RESERVE','200'), 10) || 0);
  var quota = remainingQuota_();
  if (quota !== null && quota <= reserve) {
    return { paused: true, reason: 'daily quota reserve reached', remainingQuota: quota,
             remaining: pending.length };
  }

  var ctx = buildDispatchContext_(now, monthKey);
  // Admin "Run now" passes force=true. Without threading it down to sendEmail_,
  // every re-run this month is silently skipped by the idempotency index and the
  // button appears to do nothing.
  ctx.force = !!force;
  var batch = pending.slice(0, maxBatch);
  var patches = {};
  var sent = 0, failed = 0, incomplete = 0;
  var started = new Date().getTime();
  // Apps Script hard-kills at 6 min. Stop at 3.5 min, and also stop early if the
  // NEXT send is unlikely to finish inside the budget, based on measured average.
  var BUDGET_MS = 3.5 * 60 * 1000;
  var quotaUsed = 0;

  for (var i = 0; i < batch.length; i++) {
    var elapsed = new Date().getTime() - started;
    if (elapsed > BUDGET_MS) break;
    if (i > 0) {
      var avg = elapsed / i;
      if (elapsed + (avg * 1.5) > BUDGET_MS) break;   // no room for another send
    }
    if (quota !== null && (quota - quotaUsed) <= reserve) break;   // quota mid-run
    var q = batch[i];
    var attempt = (parseInt(q.Attempt, 10) || 0) + 1;
    var out;
    try {
      out = dispatchOneTarget_(q, ctx, force);
    } catch (err) {
      out = { status: 'FAILED', error: String(err && err.message || err) };
    }
    if (out.status === 'SENT' || out.status === 'SKIPPED') { sent++; quotaUsed += (out.recipients || 1); }
    else if (out.status === 'INCOMPLETE') { incomplete++; quotaUsed += (out.recipients || 1); }
    else failed++;
    patches[q.QueueID] = {
      Status: out.status === 'SKIPPED' ? 'SENT' : out.status,
      Attempt: attempt,
      SentAt: (out.status === 'SENT' || out.status === 'SKIPPED') ? nowIso_() : '',
      Error: out.error || ''
    };
  }

  updateRowsById_('DISPATCH_QUEUE', 'QueueID', patches);
  var done = Object.keys(patches).length;
  var left = pending.length - done;
  var elapsedMs = new Date().getTime() - started;
  // Measured throughput, surfaced so nobody has to time this by hand.
  return { sent: sent, incomplete: incomplete, failed: failed, remaining: left,
           processed: done, elapsedMs: elapsedMs,
           msPerSend: done ? Math.round(elapsedMs / done) : 0,
           projectedRunsLeft: done ? Math.ceil(left / done) : null,
           remainingQuota: quota };
}

/**
 * Shared, read-once context for a dispatch run. Built ONCE per worker execution
 * rather than per target — at 500 branches, re-reading these tables per target
 * is what made the old loop quadratic.
 */
function buildDispatchContext_(now, monthKey) {
  var tz = getTz_();
  var matrix = readTable_('ESCALATION_MATRIX');
  var byClient = {}, byBranch = {};
  matrix.forEach(function(m) {
    var bid = String(m.BranchID || '');
    if (bid) (byBranch[bid] = byBranch[bid] || []).push(m);
    else (byClient[m.ClientID] = byClient[m.ClientID] || []).push(m);
  });
  var clients = {};
  readTable_('CLIENTS').forEach(function(c){ clients[c.ClientID] = c; });
  var branches = {};
  readTable_('BRANCHES').forEach(function(b){ branches[b.BranchID] = b; });
  var users = readTable_('USERS');
  return {
    now: now, tz: tz, monthKey: monthKey,
    month: Utilities.formatDate(now, tz, 'MMMM'),
    year: Utilities.formatDate(now, tz, 'yyyy'),
    matrixByClient: byClient, matrixByBranch: byBranch, clients: clients, branches: branches, users: users,
    tplD: getTemplate_('DISPATCH'), tplI: getTemplate_('INCOMPLETE'),
    defaultCc: parseListStr_(getSetting_('DEFAULT_CC','')),
    mgr: getSetting_('ESCALATION_MANAGER',''),
    signature: getSetting_('SIGNATURE','')
  };
}

/**
 * Sends ONE queued dispatch target.
 * Returns { status: 'SENT' | 'SKIPPED' | 'INCOMPLETE' | 'FAILED', error }.
 * Behaviour for CLIENT granularity is identical to the previous runDispatch_:
 * an incomplete matrix is never emailed to the client, only escalated inward.
 */
function dispatchOneTarget_(q, ctx, force) {
  var c = ctx.clients[q.ClientID];
  if (!c) return { status: 'FAILED', error: 'client not found: ' + q.ClientID };
  var isBranch = String(q.Granularity).toUpperCase() === 'BRANCH';
  var b = isBranch ? ctx.branches[q.BranchID] : null;
  if (isBranch && !b) return { status: 'FAILED', error: 'branch not found: ' + q.BranchID };

  // M1: a branch owns its own rows. Client-level rows are used ONLY as a
  // pre-migration fallback so dispatch keeps working before
  // migrateMatrixToBranchLevel() has been run. After migration + archive,
  // every branch resolves to its own data with no inheritance.
  // One resolver for dispatch and for the UI, so what is previewed is what is
  // sent, and a location default can never leak into another location.
  var m = isBranch
    ? resolveMatrixRows_(q.ClientID, q.BranchID, (b && b.Location) || '',
        ctx.matrixAll || readTable_('ESCALATION_MATRIX'))
        .filter(function(r){ return String(r.Email||'').trim() || String(r.ContactName||'').trim(); })
    : (ctx.matrixByClient[q.ClientID] || []);
  var v = validateClientMatrix_(c, m);
  var lhEmail = (isBranch && b.LocationHead) ? b.LocationHead : c.DefaultLocationHead;
  var lhName = (ctx.users.filter(function(u){
    return String(u.Email).toLowerCase() === String(lhEmail).toLowerCase();
  })[0] || {}).Name || lhEmail || '';

  // Personalisation. Every template opened with a flat "Dear Team" because there
  // was no token for the actual addressee. RECIPIENT_NAME resolves to the person
  // this copy is going to; GREETING is the whole salutation so a template can just
  // say {{GREETING}} and never render "Dear ," when the name is missing.
  var toList = isBranch ? branchRecipients_(b, c) : [c.ClientEmail];
  var firstTo = (toList && toList.length) ? toList[0] : '';
  var recipName = '';
  if (isBranch) {
    if (String(b.BranchManagerEmail || '').toLowerCase() === String(firstTo).toLowerCase()) recipName = b.BranchManagerName || '';
    else if (String(b.CruxPOCEmail || '').toLowerCase() === String(firstTo).toLowerCase()) recipName = b.CruxPOCName || '';
  }
  if (!recipName) {
    recipName = (ctx.users.filter(function(u) {
      return String(u.Email).toLowerCase() === String(firstTo).toLowerCase();
    })[0] || {}).Name || '';
  }

  var vars = {
    RECIPIENT_NAME: recipName || 'Team',
    GREETING: recipName ? ('Dear ' + recipName + ',') : 'Dear Team,',
    CLIENT_NAME: c.ClientName,
    BRANCH_NAME: isBranch ? (b.BranchName || '') : '',
    BRANCH_CODE: isBranch ? (b.BranchCode || '') : '',
    MONTH: ctx.month, YEAR: ctx.year,
    MATRIX_TABLE: matrixToHtml_(c, m),
    MISSING_LIST: missingToHtml_(v.missing),
    LOCATION_HEAD_NAME: lhName,
    SIGNATURE: ctx.signature
  };

  // Incomplete matrix: escalate internally, never email the client/branch.
  if (!v.complete) {
    if (!isEmail_(lhEmail)) return { status: 'FAILED', error: 'no valid Location Head email' };
    var resI = sendEmail_({
      type: 'INCOMPLETE_ESCALATION', clientId: c.ClientID, branchId: q.BranchID || '',
      to: [lhEmail], cc: ctx.defaultCc.concat(isEmail_(ctx.mgr) ? [ctx.mgr] : []),
      subject: renderTemplate_(ctx.tplI.Subject, vars),
      htmlBody: renderTemplate_(ctx.tplI.Body, vars),
      trigger: 'scheduler.dispatch.incomplete',
      force: !!ctx.force, force: !!force,
      idempotencyKey: ctx.monthKey + '-INCOMPLETE-' + (q.BranchID || c.ClientID)
    });
    if (resI.status === 'SENT' || resI.skipped) return { status: 'INCOMPLETE', recipients: 1 + ctx.defaultCc.length };
    return { status: 'FAILED', error: resI.error || 'incomplete notice not sent' };
  }

  var to = q.Recipient && isEmail_(q.Recipient) ? q.Recipient
         : (isBranch ? branchRecipients_(b, c) : c.ClientEmail);
  if (!isEmail_(to)) return { status: 'FAILED', error: 'no valid recipient' };

  // A2 NOTE: Gmail counts RECIPIENTS, not messages. For BRANCH granularity the
  // matrix contacts are NOT copied onto every branch email — at 500 branches that
  // alone would be ~4,000 recipients/day against a ~1,500 cap. Switch this to
  // match CLIENT behaviour only if you have quota headroom (see option A1).
  var cc = isBranch
    ? dedupeEmails_(parseListStr_(c.ClientCC).filter(isEmail_), [to])
    : dedupeEmails_(m.map(function(r){ return r.Email; }).filter(isEmail_)
        .concat(parseListStr_(c.ClientCC).filter(isEmail_))
        .concat(ctx.defaultCc), [to]);

  var res = sendEmail_({
    type: 'MONTHLY_DISPATCH', clientId: c.ClientID, branchId: q.BranchID || '',
    to: [to], cc: cc,
    subject: renderTemplate_(ctx.tplD.Subject, vars),
    htmlBody: renderTemplate_(ctx.tplD.Body, vars),
    trigger: 'scheduler.dispatch',
    force: !!ctx.force, force: !!force,
    idempotencyKey: q.IdempotencyKey || (ctx.monthKey + '-DISPATCH-' + (q.BranchID || c.ClientID))
  });
  if (res.skipped) return { status: 'SKIPPED', recipients: 0 };
  if (res.status === 'SENT') return { status: 'SENT', recipients: 1 + cc.length };
  return { status: 'FAILED', error: res.error || 'send failed' };
}

/**
 * Compatibility wrapper. Anything that used to call runDispatch_ (Admin "Run
 * Now", runJob_) now plans the month and drains the first batch; the 5-minute
 * tick finishes the rest.
 */
/**
 * Forced re-run: clear this month's queue AND the PLAN marker so planDispatch_
 * rebuilds it. Without this, "Run monthly dispatch" is a no-op after the first
 * run because every queue row is already SENT.
 */
function resetDispatchQueueForMonth_(monthKey) {
  var sh = sh_('DISPATCH_QUEUE');
  var headers = sheetHeaders_('DISPATCH_QUEUE');
  var last = sh.getLastRow();
  if (last > 1) {
    var mCol = headers.indexOf('MonthKey');
    var vals = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var keep = vals.filter(function(r){ return String(r[mCol]) !== String(monthKey); });
    sh.getRange(2, 1, vals.length, headers.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, headers.length).setValues(keep);
    invalidateTableCache_('DISPATCH_QUEUE');
  }
  var rl = sh_('REMINDER_LOG');
  var rlast = rl.getLastRow();
  if (rlast > 1) {
    var rows = rl.getRange(2, 1, rlast - 1, SCHEMA.REMINDER_LOG.length).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i][0] === monthKey + '-' + JOB_TYPES.PLAN) rl.deleteRow(i + 2);
    }
    invalidateTableCache_('REMINDER_LOG');
  }
}

function runDispatch_(executedBy, force) {
  var plan = planDispatch_(executedBy);
  var res = runDispatchQueue_(executedBy, force);
  return {
    queued: plan.queued || 0, planSkipped: !!plan.skipped,
    sent: res.sent || 0, incomplete: res.incomplete || 0,
    failed: res.failed || 0, remaining: res.remaining || 0,
    paused: !!res.paused, remainingQuota: res.remainingQuota
  };
}

/** Admin "Run Now" wrapper (bypasses schedule but respects idempotency unless force=true). */
function runJob_(type, payload, me) {
  var monthKey = Utilities.formatDate(new Date(), getTz_(), 'yyyy-MM');
  if (payload && payload.force) {
    // Clear this month's log entry so it can rerun; still uses per-recipient idempotency keys.
    var sh = sh_('REMINDER_LOG');
    var last = sh.getLastRow();
    if (last > 1) {
      var rows = sh.getRange(2, 1, last-1, SCHEMA.REMINDER_LOG.length).getValues();
      for (var i = rows.length - 1; i >= 0; i--) {
        if (rows[i][0] === monthKey + '-' + type) sh.deleteRow(i + 2);
      }
    }
  }
  var force = !!(payload && payload.force);
  if (type === JOB_TYPES.DIS) {
    if (force) resetDispatchQueueForMonth_(monthKey);
    return runDispatch_(me.email, force);
  }
  if (type === JOB_TYPES.SUM) return runMonthlySummary_(me.email, force);
  return runReminder_(type, me.email, force);
}

/**
 * Monthly summary digest — sent to admins on the 2nd (configurable).
 * Reports on the PREVIOUS calendar month: sent, failed, incomplete, escalations.
 */
function runMonthlySummary_(executedBy, force) {
  var now = new Date();
  var thisMonthKey = Utilities.formatDate(now, getTz_(), 'yyyy-MM');
  if (jobDone_(thisMonthKey, JOB_TYPES.SUM)) return { skipped: true };
  // Previous month (report period)
  var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var prevKey = Utilities.formatDate(prev, getTz_(), 'yyyy-MM');
  var prevLabel = Utilities.formatDate(prev, getTz_(), 'MMMM yyyy');
  var emails = readTable_('EMAIL_LOG').filter(function(r){ return String(r.Timestamp).indexOf(prevKey) === 0; });
  var sent = emails.filter(function(r){ return r.Status === 'SENT'; });
  var failed = emails.filter(function(r){ return r.Status === 'FAILED'; });
  var dispatched = sent.filter(function(r){ return r.Type === 'MONTHLY_DISPATCH'; });
  var incomplete = emails.filter(function(r){ return r.Type === 'INCOMPLETE_ESCALATION'; });
  var reminders = emails.filter(function(r){ return r.Type === 'REMINDER_25' || r.Type === 'REMINDER_LWD'; });
  var escalations = readTable_('ESCALATIONS').filter(function(r){ return String(r.CreatedAt).indexOf(prevKey) === 0; });
  var openEsc = escalations.filter(function(r){ return ['OPEN','ASSIGNED','IN_PROGRESS'].indexOf(r.Status) !== -1; });
  var admins = readTable_('USERS').filter(function(u){ return u.Role === 'ADMIN' && u.Status === 'ACTIVE'; }).map(function(u){ return u.Email; }).filter(isEmail_);
  var manager = getSetting_('ESCALATION_MANAGER','');
  if (isEmail_(manager) && admins.indexOf(manager) === -1) admins.push(manager);
  // Extra digest recipients (§ Digest Recipients): comma/semicolon separated.
  var extra = parseListStr_(getSetting_('SUMMARY_EXTRA_RECIPIENTS',''));
  extra.filter(isEmail_).forEach(function(e){ if (admins.indexOf(e) === -1) admins.push(e); });
  if (!admins.length) {
    recordJob_(thisMonthKey, JOB_TYPES.SUM, 'PARTIAL', 'no active admin recipients', executedBy);
    return { ok: false, reason: 'no admin recipients' };
  }
  // AI insight (soft-fails if Gemini not configured).
  var aiPara = aiSummaryInsight_(prevLabel, {
    dispatched: dispatched.length, reminders: reminders.length,
    incomplete: incomplete.length, failed: failed.length,
    escalations: escalations.length, open: openEsc.length
  }, incomplete.slice(0, 15).map(function(r){ return r.ClientID; }),
     failed.slice(0, 8).map(function(r){ return r.Error || ''; }));
  var aiBlock = aiPara ? ('<div style="background:#e0f2fe;border-left:3px solid #0369a1;padding:12px 14px;margin:12px 0;font-family:Arial,sans-serif;font-size:13px;color:#0e1116">' +
    '<div style="font-family:Georgia,serif;font-size:14px;margin-bottom:4px">What changed / what to watch</div>' +
    escHtml_(aiPara) + '</div>') : '';
  // Build failed-list table (top 20)
  var failRows = failed.slice(0, 20).map(function(r){
    return '<tr><td style="border:1px solid #d0d7de;padding:6px">' + escHtml_(r.Timestamp) +
      '</td><td style="border:1px solid #d0d7de;padding:6px">' + escHtml_(r.Type) +
      '</td><td style="border:1px solid #d0d7de;padding:6px">' + escHtml_(r.ToAddr) +
      '</td><td style="border:1px solid #d0d7de;padding:6px">' + escHtml_(r.Error) + '</td></tr>';
  }).join('');
  var failTable = failed.length ?
    '<h4 style="font-family:Georgia,serif;margin:14px 0 6px">Failed sends (' + failed.length + ')</h4>' +
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">' +
    '<thead style="background:#f6f8fa"><tr><th style="border:1px solid #d0d7de;padding:6px">When</th><th style="border:1px solid #d0d7de;padding:6px">Type</th><th style="border:1px solid #d0d7de;padding:6px">To</th><th style="border:1px solid #d0d7de;padding:6px">Error</th></tr></thead><tbody>' +
    failRows + '</tbody></table>' : '<p style="color:#0a7d3b"><b>Zero failed sends</b> — a clean month.</p>';
  var incompleteList = incomplete.slice(0, 20).map(function(r){
    return '<li>' + escHtml_(r.ClientID) + ' — ' + escHtml_(r.ToAddr) + '</li>';
  }).join('');
  var body = '<p>Hi Admins,</p>' +
    '<p>Here is the automated digest for <b>' + escHtml_(prevLabel) + '</b>.</p>' +
    aiBlock +
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;margin:10px 0">' +
      kv_('Client dispatches sent', String(dispatched.length)) +
      kv_('Reminders sent', String(reminders.length)) +
      kv_('Incomplete-matrix escalations', String(incomplete.length)) +
      kv_('Total failed sends', String(failed.length)) +
      kv_('Total emails logged', String(emails.length)) +
      kv_('Escalations opened in month', String(escalations.length)) +
      kv_('Still open', String(openEsc.length)) +
    '</table>' +
    (incomplete.length ? '<h4 style="font-family:Georgia,serif;margin:14px 0 6px">Clients that missed dispatch</h4><ul>' + incompleteList + '</ul>' : '') +
    failTable +
    '<p style="color:#5b6473;margin-top:16px">Generated automatically. Manage recipients via <code>MONTHLY_SUMMARY_DAY</code> and admin roster.</p>';
  var subject = '[Crux] Monthly summary — ' + prevLabel;
  var results = { sent: 0, failed: 0 };
  admins.forEach(function(addr) {
    try {
      var res = sendEmail_({
        type: 'MONTHLY_SUMMARY', to: [addr], cc: [],
        subject: subject, htmlBody: body,
        trigger: 'scheduler.summary', force: !!force,
        idempotencyKey: thisMonthKey + '-SUMMARY-' + addr
      });
      if (res.status === 'SENT' || res.skipped) results.sent++; else results.failed++;
    } catch (e) { results.failed++; }
  });
  recordJob_(thisMonthKey, JOB_TYPES.SUM, results.failed === 0 ? 'OK' : 'PARTIAL', 'sent=' + results.sent + ' failed=' + results.failed, executedBy);
  return { period: prevLabel, admins: admins.length, sent: results.sent, failed: results.failed };
}

function automationStatus_() {
  var tz = getTz_();
  var now = new Date();
  var remDay = parseInt(getSetting_('REMINDER_DAY_1','25'), 10);
  var remTime = getSetting_('REMINDER_TIME','12:00');
  var disDay = parseInt(getSetting_('MONTHLY_DISPATCH_DAY','1'), 10);
  var disTime = getSetting_('MONTHLY_DISPATCH_TIME','10:00');
  var sumDay = parseInt(getSetting_('MONTHLY_SUMMARY_DAY','2'), 10);
  var sumTime = getSetting_('MONTHLY_SUMMARY_TIME','09:00');
  function next(day, timeHHmm, useLWD) {
    var d = new Date(now.getFullYear(), now.getMonth(), 1);
    for (var i = 0; i < 3; i++) {
      var target = useLWD ? lastWorkingDay_(d.getFullYear(), d.getMonth()) : new Date(d.getFullYear(), d.getMonth(), day);
      target.setHours(parseInt(timeHHmm.split(':')[0], 10), parseInt(timeHHmm.split(':')[1], 10), 0, 0);
      if (target > now) return Utilities.formatDate(target, tz, 'yyyy-MM-dd HH:mm');
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    return '';
  }
  var logs = readTable_('REMINDER_LOG');
  var lastOk = logs.filter(function(r){ return r.Result === 'OK'; }).slice(-1)[0];
  var lastFail = logs.filter(function(r){ return r.Result !== 'OK'; }).slice(-1)[0];
  return {
    tickInstalled: ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'tick'; }),
    nextReminder25: next(remDay, remTime, false),
    nextReminderLWD: next(null, remTime, true),
    nextMonthlyDispatch: next(disDay, disTime, false),
    nextMonthlySummary: next(sumDay, sumTime, false),
    lastSuccess: lastOk ? (lastOk.Type + ' @ ' + lastOk.ExecutedAt) : '',
    lastFailure: lastFail ? (lastFail.Type + ' @ ' + lastFail.ExecutedAt + ' — ' + lastFail.Notes) : ''
  };
}

function nextScheduledJobs_() {
  try { return automationStatus_(); } catch (e) { return {}; }
}

function installTriggers_() {
  // Remove any existing tick triggers first.
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  return { ok: true };
}
/* ==================================================================
 * THREE-STRIKE CHASE
 *
 * Clock: 24 WORKING hours of no activity per strike. Working hours are
 * WORK_HOURS_START..WORK_HOURS_END, Monday to Friday. Weekends never count,
 * so a Friday escalation cannot strike on Sunday.
 * Send window: emails only go out inside those same hours, so nobody is
 * chased at 2am.
 * Activity = ANY comment or update, i.e. any ESCALATION_HISTORY row.
 * ================================================================== */

/** Working hours between two instants, honouring weekends and the daily window. */
/**
 * Offset of the app timezone from UTC, in ms, at a given instant.
 *
 * Derived by reading the instant as local wall-clock text and reinterpreting
 * those numbers as UTC. Correct for fixed-offset zones (Asia/Kolkata) and
 * evaluated per day, so a daylight-saving zone still behaves sensibly.
 */
function tzOffsetMs_(d, tz) {
  var s = Utilities.formatDate(d, tz || getTz_(), 'yyyy-MM-dd HH:mm');
  var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (!m) return 0;
  var asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return asUtc - Math.floor(d.getTime() / 60000) * 60000;
}

/**
 * Working hours elapsed between two instants. Weekends never count.
 *
 * TIMEZONE FIX: this used to walk in hour buckets floored to a whole UTC hour,
 * then ask formatDate which local hour each bucket fell in. India is UTC+05:30,
 * so every UTC-aligned bucket straddles two IST clock hours. The bucket covering
 * 09:30-10:30 IST reads as hour 9 and was skipped whole, losing 10:00-10:30, and
 * the 16:30-17:30 bucket read as hour 16 and was counted whole. A full working
 * day therefore measured 6.5 hours instead of 7 -- a half hour lost per day,
 * which pushed every strike later than the policy intends. The error is invisible
 * in any whole-hour timezone, which is why it survived.
 *
 * Now each local day's window is computed as two absolute timestamps and
 * intersected with the range, so nothing depends on bucket alignment. It also
 * iterates once per day rather than 24 times per day.
 */
function workingHoursBetween_(from, to) {
  if (!from || !to || to.getTime() <= from.getTime()) return 0;
  var tz = getTz_();
  var sH = parseInt(getSetting_('WORK_HOURS_START', '10'), 10);
  var eH = parseInt(getSetting_('WORK_HOURS_END', '17'), 10);
  if (!(eH > sH)) return 0;

  var HOUR = 3600000, DAY = 24 * HOUR;
  var total = 0, guard = 0;
  var probe = new Date(from.getTime());

  while (probe.getTime() < to.getTime() && guard++ < 400) {
    var off = tzOffsetMs_(probe, tz);
    var localMidnight = Math.floor((probe.getTime() + off) / DAY) * DAY - off;
    // Midday avoids any boundary ambiguity when reading the weekday.
    var dow = Number(Utilities.formatDate(new Date(localMidnight + 12 * HOUR), tz, 'u'));
    if (dow >= 1 && dow <= 5) {
      var a = Math.max(localMidnight + sH * HOUR, from.getTime());
      var b = Math.min(localMidnight + eH * HOUR, to.getTime());
      if (b > a) total += (b - a) / HOUR;
    }
    probe = new Date(localMidnight + DAY + HOUR);   // safely inside the next local day
  }
  return total;
}

/** True only inside working hours - nothing is sent outside them. */
function withinSendWindow_(now) {
  var tz = getTz_();
  var sH = parseInt(getSetting_('WORK_HOURS_START', '10'), 10);
  var eH = parseInt(getSetting_('WORK_HOURS_END', '17'), 10);
  var p = Utilities.formatDate(now || new Date(), tz, 'u H').split(' ');
  var dow = Number(p[0]), h = Number(p[1]);
  return dow <= 5 && h >= sH && h < eH;
}

/** Latest sign of life on an escalation: creation, update, or any history row. */
/**
 * When did somebody last GENUINELY respond to this escalation?
 *
 * This previously took the latest of UpdatedAt, CreatedAt and EVERY history row.
 * Two consequences, both bad:
 *   1. the strike's OWN history entry became 'activity', so each strike reset its
 *      own clock and strike 2 could never follow strike 1;
 *   2. any routine edit moved UpdatedAt and silently restarted the timer, so an
 *      escalation could be nudged indefinitely and never strike at all.
 *
 * Only a human response counts now: the explicit LastActivityAt stamp, or a
 * history row that is not a system or strike entry. CreatedAt is the baseline
 * so a brand new escalation starts its clock from creation.
 */
function lastActivityAt_(e, historyByEsc) {
  var stamps = [];
  if (e.LastActivityAt) stamps.push(e.LastActivityAt);
  if (e.CreatedAt) stamps.push(e.CreatedAt);
  if (!e.CreatedAt && e.Date) stamps.push(e.Date);

  var isSystem = function(h) {
    var who = String(h.User || '').toLowerCase();
    var field = String(h.Field || '');
    var note = String(h.Note || '');
    if (who.indexOf('system') === 0 || who === 'auto') return true;
    if (/^(Strike|Warning|Activity)$/i.test(field)) return /strike/i.test(note) || /^Strike$/i.test(field);
    if (/strike\s*[123]/i.test(note)) return true;
    if (/reminder sent|notice issued|automatic record/i.test(note)) return true;
    return false;
  };

  (historyByEsc[e.EscalationID] || []).forEach(function(h) {
    if (!h.Timestamp) return;
    if (isSystem(h)) return;          // the chase must not count as a reply to itself
    stamps.push(h.Timestamp);
  });

  var best = null;
  stamps.forEach(function(s) {
    var dt = new Date(s);
    if (!isNaN(dt.getTime()) && (!best || dt.getTime() > best.getTime())) best = dt;
  });
  return best;
}

/** Everyone on the escalation matrix for this escalation's branch (or client). */
function matrixContactsFor_(e) {
  var rows = readTable_('ESCALATION_MATRIX').filter(function(m) {
    if (e.BranchID && String(m.BranchID || '') === String(e.BranchID)) return true;
    if (!e.BranchID && String(m.ClientID) === String(e.ClientID)) return true;
    return false;
  });
  if (!rows.length) {
    rows = readTable_('ESCALATION_MATRIX').filter(function(m){ return String(m.ClientID) === String(e.ClientID); });
  }
  return rows.map(function(m){ return m.Email; }).filter(isEmail_);
}

function strikeBody_(e, level, hoursIdle, facts) {
  var tone = level === 1
    ? 'This is a reminder that the escalation below is still open and no update has been recorded.'
    : level === 2
      ? 'This escalation remains unanswered after two full working days. Please respond today.'
      : 'This escalation has gone unanswered through three working-day windows and is now on record.';
  return '<p>' + tone + '</p>'
    + '<table cellpadding="6" style="border-collapse:collapse">'
    + '<tr><td><b>Escalation</b></td><td>' + e.EscalationID + '</td></tr>'
    + '<tr><td><b>Category</b></td><td>' + (e.Category || '') + '</td></tr>'
    + '<tr><td><b>Severity</b></td><td>' + (e.Severity || '') + '</td></tr>'
    + '<tr><td><b>Raised on</b></td><td>' + String(e.CreatedAt || e.Date || '').slice(0, 16) + '</td></tr>'
    + '<tr><td><b>Against</b></td><td>' + (e.EscalatedAgainst || '') + '</td></tr>'
    + '<tr><td><b>Working hours idle</b></td><td>' + Math.round(hoursIdle) + '</td></tr>'
    + '<tr><td><b>Required action</b></td><td>' + (e.RequiredAction || '') + '</td></tr>'
    + '<tr><td><b>Target date</b></td><td>' + (e.TargetDate || '') + '</td></tr>'
    + '</table>'
    + '<p>' + (e.Description || '') + '</p>'
    + (facts ? '<p><b>Summary:</b> ' + facts + '</p>' : '')
    + '<p><a href="' + getWebAppUrl_() + '">Open the escalation tool</a></p>';
}

function getWebAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}
/**
 * The sweep. Runs on the 5-minute tick; does nothing outside working hours.
 * Idempotent per strike per escalation via the email idempotency key.
 */
function runStrikeSweep_(executedBy, opts) {
  opts = opts || {};
  if (!getBoolSetting_('STRIKE_ENABLED', 'true')) return { skipped: 'disabled' };
  var now = opts.now || new Date();
  if (!opts.ignoreWindow && !withinSendWindow_(now)) {
    return { skipped: 'outside working hours', at: nowIso_() };
  }
  var windowHours = parseFloat(getSetting_('STRIKE_WINDOW_HOURS', '24')) || 24;
  var ccBase = parseListStr_(getSetting_('ESCALATION_CC', '')).filter(isEmail_);
  var cc2 = parseListStr_(getSetting_('STRIKE2_CC', '')).filter(isEmail_);
  var hrTo = parseListStr_(getSetting_('STRIKE3_TO', '')).filter(isEmail_);
  var md = parseListStr_(getSetting_('MD_EMAIL', '')).filter(isEmail_);

  var history = {};
  readTable_('ESCALATION_HISTORY').forEach(function(h) {
    (history[h.EscalationID] = history[h.EscalationID] || []).push(h);
  });
  var open = readTable_('ESCALATIONS').filter(function(e) {
    return ESCALATION_TERMINAL.indexOf(String(e.Status || 'OPEN')) === -1;
  });

  var out = { checked: open.length, struck: [], skipped: [], warnings: 0, dryRun: !!opts.dryRun };
  open.forEach(function(e) {
    var target = String(e.AgainstEmail || '').trim();
    if (!isEmail_(target)) { out.skipped.push({ id: e.EscalationID, why: 'no resolved email for the person concerned' }); return; }
    var last = lastActivityAt_(e, history);
    if (!last) { out.skipped.push({ id: e.EscalationID, why: 'no usable timestamp' }); return; }
    var idle = workingHoursBetween_(last, now);
    var due = Math.min(3, Math.floor(idle / windowHours));
    if (due < 1) { out.skipped.push({ id: e.EscalationID, why: 'only ' + Math.round(idle) + 'h idle' }); return; }

    var matrix = matrixContactsFor_(e);
    var cc = ccBase.concat(matrix);
    if (due >= 2) cc = cc.concat(cc2);
    var to = [target];
    if (due >= 3) { to = hrTo.concat(md); cc = cc.concat([target]); }
    cc = dedupeEmails_(cc.filter(isEmail_), to);

    var facts = '';
    if (due >= 3) {
      try {
        facts = geminiCall_({
          system: 'You summarise facts only. No opinions, no judgement about any person, no recommendation. 2 sentences maximum.',
          prompt: 'Summarise this unanswered escalation factually: ' + JSON.stringify({
            id: e.EscalationID, category: e.Category, severity: e.Severity,
            raised: e.CreatedAt, description: e.Description, required: e.RequiredAction,
            target: e.TargetDate, workingHoursIdle: Math.round(idle)
          }), temp: 0, maxTokens: 160
        });
      } catch (err) { facts = 'Automatic summary unavailable (' + String(err.message || err).slice(0, 80) + ').'; }
    }

    var subject = due >= 3
      ? '[STRIKE 3 - ON RECORD] ' + e.EscalationID + ' unanswered - ' + (e.Category || '')
      : '[REMINDER ' + due + '/3] ' + e.EscalationID + ' still open - ' + (e.Category || '');

    if (opts.dryRun) {
      out.struck.push({ id: e.EscalationID, level: due, idle: Math.round(idle), to: to, cc: cc.length, subject: subject });
      return;
    }
    var res = sendEmail_({
      type: 'STRIKE_' + due, clientId: e.ClientID, branchId: e.BranchID || '',
      to: to, cc: cc, subject: subject,
      htmlBody: strikeBody_(e, due, idle, facts),
      trigger: 'scheduler.strike',
      idempotencyKey: 'STRIKE-' + e.EscalationID + '-' + due
    });
    if (res.skipped) { out.skipped.push({ id: e.EscalationID, why: 'strike ' + due + ' already sent' }); return; }
    out.struck.push({ id: e.EscalationID, level: due, idle: Math.round(idle), status: res.status });

    appendRow_('ESCALATION_HISTORY', {
      HistoryID: nextId_('EHI'), EscalationID: e.EscalationID, Timestamp: nowIso_(),
      User: 'system:strike', Field: 'Strike', OldValue: '', NewValue: 'STRIKE_' + due,
      Note: 'Automatic strike ' + due + ' after ' + Math.round(idle) + ' working hours with no update.'
    });

    if (due >= 3) {
      // A record of FACT: what happened and when. It deliberately does not draw a
      // conclusion about the person - that decision belongs to a human.
        // Routed through the single warning writer so an automatic strike-3
        // produces exactly the same record, letter and audit trail as a manual one.
        createWarning_({
          personEmail: target, personName: e.EscalatedAgainst || '',
          escalationId: e.EscalationID, escalation: e,
          clientId: e.ClientID, branchId: e.BranchID || '',
          strikeLevel: 3, source: 'STRIKE', issuedBy: 'system:strike',
          summary: facts,
          reason: 'Automatic record of non-response after three reminders. ' +
                  'Any disciplinary decision is a separate human judgement.',
          facts: { raised: e.CreatedAt, lastActivity: last,
                   workingHoursIdle: Math.round(idle) },
          sendLetter: true
        });
      out.warnings++;
    }
  });
  recordJob_(Utilities.formatDate(now, getTz_(), 'yyyy-MM-dd') + '-STRIKE', 'STRIKE_SWEEP',
    out.struck.length ? 'OK' : 'NOOP',
    'struck=' + out.struck.length + ' warnings=' + out.warnings, executedBy || 'auto');
  return out;
}

/** Safe rehearsal: computes every strike that WOULD fire and sends nothing. */
function previewStrikeSweep_(p, me) {
  return runStrikeSweep_(me && me.email, { dryRun: true, ignoreWindow: true });
}
/* =========================================================================
 * WEEKLY APPRECIATION MONITORING (section 25)
 *
 * Appreciation is part of performance management, and the tool could record it
 * but nothing ever prompted anybody to. This runs weekly, works out which
 * managers have recognised nobody on their team this month, and sends them a
 * motivational nudge.
 *
 * Deliberate design choices, because a reminder that annoys people gets filtered:
 *   - one reminder per manager per WEEK, keyed in REMINDER_LOG, so a re-run or a
 *     second tick in the same week cannot send twice;
 *   - it stops as soon as the manager has appreciated ANYONE this month - the
 *     point is the behaviour, not the paperwork;
 *   - managers with no active direct reports are skipped entirely;
 *   - the tone is motivational, never accusatory, and it never names who has or
 *     has not been appreciated. Singling a person out would make recognition feel
 *     like a compliance task.
 * ========================================================================= */

var APPRECIATION_REMINDER_DAY = 1;   // ISO day: 1 = Monday
var APPRECIATION_REMINDER_HOUR = 11;

/** ISO week key, e.g. 2026-W34. Used to make the send idempotent per week. */
function isoWeekKey_(d) {
  var tz = getTz_();
  var y = Number(Utilities.formatDate(d, tz, 'yyyy'));
  // Thursday of this week decides the ISO year and week number.
  var dow = Number(Utilities.formatDate(d, tz, 'u'));        // 1..7
  var thur = new Date(d.getTime() + (4 - dow) * 86400000);
  var thurY = Number(Utilities.formatDate(thur, tz, 'yyyy'));
  var jan1 = new Date(thurY, 0, 1);
  var week = Math.floor((thur.getTime() - jan1.getTime()) / (7 * 86400000)) + 1;
  return thurY + '-W' + (week < 10 ? '0' + week : String(week));
}

/**
 * Managers who have recognised nobody on their team this month.
 * Returns [{ email, name, teamSize, monthKey }].
 */
function managersOwedAppreciationNudge_(now) {
  now = now || new Date();
  var mk = monthKey_(now);
  var users = readTable_('USERS').filter(function(u) {
    return isEmail_(u.Email) && String(u.Status || '') === 'ACTIVE';
  });

  // Appreciations recorded THIS month, by who issued them.
  var issuedBy = {};
  readTable_('PEOPLE_EVENTS').forEach(function(e) {
    if (String(e.Type || '') !== 'APPRECIATION') return;
    if (monthOfValue_(e.Timestamp) !== mk) return;
    issuedBy[String(e.IssuedBy || '').toLowerCase()] = true;
  });

  var out = [];
  users.forEach(function(u) {
    var em = String(u.Email).toLowerCase();
    var team = directReports_(em).filter(function(r) {
      var row = users.filter(function(x){ return String(x.Email).toLowerCase() === r; })[0];
      return !!row;                          // active reports only
    });
    if (!team.length) return;                // not a manager: nothing to prompt
    if (issuedBy[em]) return;                // already recognising people: leave them alone
    out.push({ email: u.Email, name: u.Name || u.Email, teamSize: team.length, monthKey: mk });
  });
  return out;
}

/** The nudge body. AI-assisted, with a fixed fallback so it never fails to send. */
function appreciationNudgeHtml_(mgr) {
  var fallback =
    '<p>Dear ' + escHtml_(mgr.name) + ',</p>' +
    '<p>You have ' + mgr.teamSize + ' ' + (mgr.teamSize === 1 ? 'person' : 'people') +
    ' reporting to you, and no appreciation has been recorded from you this month.</p>' +
    '<p>Recognition is the cheapest thing a manager can give and the one people ' +
    'remember longest. Noticing good work out loud costs a minute and changes how ' +
    'somebody feels about the next month.</p>' +
    '<blockquote style="margin:12px 0;padding:8px 14px;border-left:3px solid #d0c7b0;color:#5b5346">' +
    '&ldquo;People work for money but go the extra mile for recognition, praise and rewards.&rdquo;' +
    '<br><span style="font-size:12px">&mdash; Dale Carnegie</span></blockquote>' +
    '<p><b>Please take a moment this week to appreciate someone on your team.</b> ' +
    'Open the tool, find them under your team, and press Appreciate.</p>';

  if (typeof geminiCall_ !== 'function') return fallback;
  try {
    var body = geminiCall_({
      system: 'You write short, warm internal emails for an Indian facilities-management ' +
        'company. Tone: motivational and encouraging, never accusatory, never a telling-off. ' +
        'Do not imply the manager has done anything wrong. 120 words maximum. ' +
        'Include one short motivational quote with its author. Return HTML paragraphs only, ' +
        'no salutation and no sign-off, and name no individual employee.',
      prompt: 'Encourage a manager with ' + mgr.teamSize + ' direct reports to recognise ' +
        'someone on their team this month. Cover briefly: the value of appreciation, ' +
        'that contribution deserves to be noticed, and that consistent people management ' +
        'is part of the job. End with a clear request to appreciate a team member.',
      temp: 0.7, maxTokens: 320
    });
    var html = String(body || '').trim();
    if (html.length < 40) return fallback;
    return '<p>Dear ' + escHtml_(mgr.name) + ',</p>' + html +
      '<p style="color:#5b5346;font-size:12px">Open the tool, find them under your team, ' +
      'and press Appreciate.</p>';
  } catch (e) {
    return fallback;
  }
}

/**
 * The weekly sweep. Idempotent per manager per ISO week.
 * @param {string} executedBy
 * @param {object} opts { now, dryRun }
 */
function runAppreciationNudge_(executedBy, opts) {
  opts = opts || {};
  if (!getBoolSetting_('APPRECIATION_NUDGE_ENABLED', 'true')) return { skipped: 'disabled' };
  var now = opts.now || new Date();
  var week = isoWeekKey_(now);

  var owed = managersOwedAppreciationNudge_(now);
  var out = { week: week, candidates: owed.length, sent: [], skipped: [], dryRun: !!opts.dryRun };

  owed.forEach(function(mgr) {
    var idem = 'APPRECIATION-NUDGE-' + week + '-' + String(mgr.email).toLowerCase();
    if (opts.dryRun) { out.sent.push({ email: mgr.email, teamSize: mgr.teamSize }); return; }
    var res = sendEmail_({
      type: 'APPRECIATION_NUDGE',
      to: [mgr.email],
      subject: 'A minute for your team this week',
      htmlBody: appreciationNudgeHtml_(mgr),
      trigger: 'scheduler.appreciationNudge',
      idempotencyKey: idem
    });
    if (res.skipped) { out.skipped.push({ email: mgr.email, why: 'already sent this week' }); return; }
    if (res.status === 'SENT') out.sent.push({ email: mgr.email, teamSize: mgr.teamSize });
    else out.skipped.push({ email: mgr.email, why: res.error || 'send failed' });
  });

  if (!opts.dryRun) {
    recordJob_(week, 'APPRECIATION_NUDGE', 'OK',
      'candidates ' + owed.length + ', sent ' + out.sent.length, executedBy || 'auto');
  }
  return out;
}

/** Admin: rehearse the sweep. Computes everything, sends nothing. */
function previewAppreciationNudge_(p, me) {
  if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can preview this.');
  return runAppreciationNudge_(me.email, { dryRun: true });
}

/** Admin: run it now. */
function runAppreciationNudgeNow_(p, me) {
  if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can run this.');
  return runAppreciationNudge_(me.email, {});
}
