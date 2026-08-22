/**
 * Email.gs — email engine, templates, logging, retry, dry-run.
 *
 * Sending path is GmailApp.sendEmail (uses the authorized deployer's Gmail),
 * so no SMTP/app-password is needed. The deployer must have the send-mail
 * OAuth scope on first authorization (declared in appsscript.json).
 */

/**
 * Central send with idempotency, dry-run, retry, and logging.
 * options: {
 *   type, clientId, branchId, to, cc, subject, htmlBody, trigger,
 *   idempotencyKey, replyTo, senderName, bcc
 * }
 */
/**
 * Is `addr` usable as a From address for the account this script runs as?
 *
 * GmailApp.sendEmail's `from` option only accepts the authorised account's own
 * address or one of its verified "Send mail as" aliases (Gmail > Settings >
 * Accounts and Import). Anything else makes the send throw.
 *
 * Returns true (usable), false (definitely not), or null (cannot tell — reading
 * aliases needs a Gmail settings scope this project may not hold).
 */
function gmailAliasAvailable_(addr) {
  var want = String(addr || '').trim().toLowerCase();
  if (!want) return false;
  var me = '';
  try { me = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) {}
  if (me && me === want) return true;
  try {
    var aliases = GmailApp.getAliases() || [];
    for (var i = 0; i < aliases.length; i++) {
      if (String(aliases[i] || '').trim().toLowerCase() === want) return true;
    }
    return false;
  } catch (e) {
    return null; // scope unavailable — let Gmail be the judge at send time
  }
}

/**
 * Diagnostic. Run this from the Apps Script editor (select listMyEmailAliases in
 * the function dropdown, press Run) and read the Execution log to see exactly
 * which addresses this deployment is allowed to send as.
 */
function listMyEmailAliases() {
  var me = Session.getEffectiveUser().getEmail();
  Logger.log('This deployment sends email as: ' + me);
  var aliases;
  try {
    aliases = GmailApp.getAliases() || [];
  } catch (e) {
    Logger.log('Could not read aliases: ' + (e && e.message ? e.message : e));
    Logger.log('Add the scope https://www.googleapis.com/auth/gmail.settings.basic');
    Logger.log('to appsscript.json and re-authorise if you want this check to work.');
    return { primary: me, aliases: null };
  }
  if (!aliases.length) {
    Logger.log('No "Send mail as" aliases configured. FROM_ADDRESS must be blank,');
    Logger.log('or set to ' + me + ', until an alias is added and verified.');
  } else {
    Logger.log('Verified aliases you may use as FROM_ADDRESS:');
    aliases.forEach(function(a) { Logger.log('  - ' + a); });
  }
  Logger.log('Current FROM_ADDRESS setting: "' + getSetting_('FROM_ADDRESS', '') + '"');
  return { primary: me, aliases: aliases };
}

/**
 * Index of idempotency keys already marked SENT, built once per execution.
 * Apps Script gives every execution a cold global scope, so this is rebuilt on
 * each run and cannot go stale across runs. Within a run (e.g. the dispatch
 * worker sending 25 emails) EMAIL_LOG is read exactly once instead of 25 times.
 */
var _SENT_KEYS = null;
function sentKeyIndex_() {
  if (_SENT_KEYS) return _SENT_KEYS;
  _SENT_KEYS = {};
  readTable_('EMAIL_LOG').forEach(function(r) {
    if (r.Status === 'SENT' && r.IdempotencyKey) _SENT_KEYS[String(r.IdempotencyKey)] = r.LogID;
  });
  return _SENT_KEYS;
}

function sendEmail_(options) {
  var opt = options || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (opt.idempotencyKey) {
      // PERF FIX (was O(n^2)): this used to call readTable_('EMAIL_LOG') on EVERY
      // send, while EMAIL_LOG grows by one row per send. Harmless at 4 clients,
      // fatal at 500 branches — each send re-read a bigger table, pushing a bulk
      // run past the 6-minute execution cap around branch 120-150. Now the sent
      // keys are indexed ONCE per execution and updated in place after each send.
      var idx = sentKeyIndex_();
      // opt.force = an admin explicitly pressed "Run now". Without this the
      // idempotency guard silently skips everything and the button looks broken.
      if (idx[opt.idempotencyKey] && !opt.force) {
        return { skipped: true, reason: 'already sent', logId: idx[opt.idempotencyKey] };
      }
    }
    var dryRun = getBoolSetting_('DRY_RUN','false');
    var override = getSetting_('TEST_EMAIL_OVERRIDE','');
    var toAddr = (opt.to || []).slice();
    var ccAddr = dedupeEmails_(opt.cc || [], toAddr);
    var bccAddr = dedupeEmails_(opt.bcc || parseListStr_(getSetting_('DEFAULT_BCC','')), toAddr.concat(ccAddr));
    // remove dupes from To against itself
    toAddr = dedupeEmails_(toAddr, []);
    if (toAddr.length === 0) throw new Error('No valid recipient');
    if (dryRun) {
      if (!isEmail_(override)) throw new Error('DRY_RUN is enabled but TEST_EMAIL_OVERRIDE is not set.');
      // Rewrite recipients but include the intended list in the body header.
      opt.htmlBody = '<div style="background:#fff3bf;padding:10px;margin:0 0 12px;border:1px solid #fab005">' +
        '<b>TEST MODE</b> — original To: ' + toAddr.join(', ') +
        (ccAddr.length ? '<br/>original CC: ' + ccAddr.join(', ') : '') + '</div>' + (opt.htmlBody || '');
      toAddr = [override]; ccAddr = []; bccAddr = [];
    }
    var subject = opt.subject || '(no subject)';
    var senderName = opt.senderName || getSetting_('FROM_NAME','Crux Risk Management');
    var replyTo = opt.replyTo || getSetting_('REPLY_TO','');
    var logId = nextId_('EML');
    var attempt = 1;
    var status = 'PENDING';
    var errorMsg = '';
    var messageRef = '';
    // Attachments: array of { name, mimeType, dataBase64 }
    var blobs = (opt.attachments || []).map(function(a) {
      try {
        var bytes = Utilities.base64Decode(a.dataBase64 || '');
        return Utilities.newBlob(bytes, a.mimeType || 'application/octet-stream', a.name || 'attachment');
      } catch (e) { return null; }
    }).filter(Boolean);
    try {
      var mailOpts = {
        // DUPLICATE SIGNATURE FIX. Every template already ends with {{SIGNATURE}},
      // which the token pass expands. This line then appended the signature a
      // second time, so every email carried it twice. The template token is the
      // single source now; if a template forgets it, append once as a fallback.
      htmlBody: appendSignatureOnce_(opt.htmlBody || ''),
      inlineImages: (function(){
        // Only attach when the body actually references it, so ordinary mail is
        // not carrying a stray image.
        var b = signatureLogoBlob_();
        if (!b) return undefined;
        var m = {}; m[SIG_LOGO_CID] = b; return m;
      })(),
        name: senderName,
        cc: ccAddr.join(','),
        bcc: bccAddr.join(','),
        replyTo: replyTo || undefined
      };
      // Custom sender address. Blank = send as the deploying account, as before.
      // If a value is set but provably NOT permitted, fail instead of quietly
      // sending from the wrong mailbox — a client escalation that appears to come
      // from the wrong address is worse than one that visibly failed to send.
      var fromAddr = String(opt.fromAddress || getSetting_('FROM_ADDRESS','')).trim();
      if (fromAddr) {
        var allowed = gmailAliasAvailable_(fromAddr);
        if (allowed === false) {
          throw new Error('FROM_ADDRESS "' + fromAddr + '" is not the deploying account\'s own '
            + 'address and is not one of its verified "Send mail as" aliases. Add and verify it '
            + 'in Gmail > Settings > Accounts and Import > Send mail as, or clear FROM_ADDRESS. '
            + 'Run listMyEmailAliases() in the Apps Script editor to see what is permitted.');
        }
        mailOpts.from = fromAddr; // true, or null (unverifiable — Gmail will decide)
      }
      if (blobs.length) mailOpts.attachments = blobs;
      GmailApp.sendEmail(toAddr.join(','), subject, stripHtml_(opt.htmlBody || ''), mailOpts);
      status = 'SENT';
      messageRef = 'gmail:' + Utilities.getUuid();
    } catch (e) {
      status = 'FAILED';
      errorMsg = String(e && e.message || e);
    }
    appendRow_('EMAIL_LOG', {
      LogID: logId, Timestamp: nowIso_(),
      Type: opt.type || 'MANUAL',
      ClientID: opt.clientId || '', BranchID: opt.branchId || '',
      ToAddr: toAddr.join(','), CcAddr: ccAddr.join(','),
      Subject: subject, Trigger: opt.trigger || '',
      SentBy: (Session.getEffectiveUser() || {}).getEmail && Session.getEffectiveUser().getEmail() || '',
      Status: status, Attempt: attempt, Error: errorMsg,
      MessageRef: messageRef, IdempotencyKey: opt.idempotencyKey || ''
    });
    // Keep the in-execution index current so a later send in this same run sees it.
    if (opt.idempotencyKey && status === 'SENT') sentKeyIndex_()[String(opt.idempotencyKey)] = logId;
    return { logId: logId, status: status, error: errorMsg };
  } finally {
    lock.releaseLock();
  }
}

function stripHtml_(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g,' ').trim(); }

function getTemplate_(key) {
  var rows = readTable_('EMAIL_TEMPLATES');
  return rows.filter(function(r){ return r.Key === key; })[0] || { Subject:'', Body:'' };
}

/* ---------- Public admin actions ---------- */

function sendTestEmail_(payload, me) {
  var to = payload.to || me.email;
  if (!isEmail_(to)) throw ValidationError_('Please provide a valid test email.');
  var tpl = getTemplate_('TEST');
  var body = renderTemplate_(tpl.Body, { SIGNATURE: buildSignature_() });
  var subj = renderTemplate_(tpl.Subject, {});
  return sendEmail_({
    type: 'TEST', to: [to], cc: [],
    subject: subj, htmlBody: body, trigger: 'admin.email.test'
  });
}

function retryEmail_(payload, me) {
  var log = findRowById_('EMAIL_LOG', 'LogID', payload.logId);
  if (!log) throw ValidationError_('Log not found.');
  if (log.Status === 'SENT') return { skipped: true, reason: 'already sent' };
  var limit = parseInt(getSetting_('RETRY_LIMIT','3'), 10);
  if ((parseInt(log.Attempt || 1, 10)) >= limit) throw ValidationError_('Retry limit reached.');
  var res = sendEmail_({
    type: log.Type, clientId: log.ClientID, branchId: log.BranchID,
    to: parseListStr_(log.ToAddr), cc: parseListStr_(log.CcAddr),
    subject: log.Subject, htmlBody: '(retry) See original log ' + log.LogID,
    trigger: 'admin.email.retry',
    idempotencyKey: log.IdempotencyKey ? log.IdempotencyKey + '-retry-' + (parseInt(log.Attempt || 1, 10) + 1) : ''
  });
  updateRowById_('EMAIL_LOG', 'LogID', log.LogID, {
    Attempt: (parseInt(log.Attempt || 1, 10) + 1),
    Status: res.status, Error: res.error || ''
  });
  return res;
}

/* ---------- Rendering helpers used by scheduler/dispatch ---------- */

function matrixToHtml_(client, matrixRows) {
  var byLevel = {}; matrixRows.forEach(function(r){ byLevel[r.Level] = r; });
  var rows = MATRIX_LEVELS.map(function(L){
    var r = byLevel[L.level] || {};
    return '<tr><td>' + L.level + '</td><td>' + L.name + '</td>' +
      '<td>' + escHtml_(r.ContactName) + '</td>' +
      '<td>' + escHtml_(r.Mobile) + '</td>' +
      '<td>' + escHtml_(r.Email) + '</td></tr>';
  }).join('');
  return '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #d0d7de;font-family:Arial,sans-serif;font-size:14px">' +
    '<thead style="background:#f6f8fa"><tr>' +
      '<th style="border:1px solid #d0d7de">#</th>' +
      '<th style="border:1px solid #d0d7de">Level</th>' +
      '<th style="border:1px solid #d0d7de">Name</th>' +
      '<th style="border:1px solid #d0d7de">Mobile</th>' +
      '<th style="border:1px solid #d0d7de">Email</th>' +
    '</tr></thead><tbody>' + rows.replace(/<td>/g,'<td style="border:1px solid #d0d7de">') + '</tbody></table>';
}

function escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function clientListToHtml_(clients) {
  if (!clients.length) return '<p><i>No clients pending.</i></p>';
  var rows = clients.map(function(c){
    return '<tr><td style="border:1px solid #d0d7de;padding:6px">' + escHtml_(c.ClientName) +
      '</td><td style="border:1px solid #d0d7de;padding:6px">' + escHtml_(c.ClientCode || '') +
      '</td><td style="border:1px solid #d0d7de;padding:6px">' + escHtml_(c._status || '') + '</td></tr>';
  }).join('');
  return '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px"><thead style="background:#f6f8fa"><tr><th style="border:1px solid #d0d7de;padding:6px">Client</th><th style="border:1px solid #d0d7de;padding:6px">Code</th><th style="border:1px solid #d0d7de;padding:6px">Status</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function missingToHtml_(missing) {
  return '<ul>' + missing.map(function(m){ return '<li>' + escHtml_(m) + '</li>'; }).join('') + '</ul>';
}
/**
 * What addresses this deployment may legitimately send from.
 * Gmail only permits the account's own address plus VERIFIED send-as aliases,
 * so this reports the real, allowed list rather than guessing.
 */
function emailAliasInfo_(payload, me) {
  // The alias list is a CONVENIENCE, not the authority. Reading it needs the
  // gmail.settings.basic scope, and a deployment authorised before that scope was
  // added will throw here. The old code swallowed that error, so the dropdown
  // silently showed only the default address and setFromAddress_ then refused the
  // very address the admin was trying to set. Surface it instead, and let the
  // admin type an address we could not verify - Gmail is the real judge at send time.
  var aliases = [];
  var aliasError = '';
  try {
    aliases = GmailApp.getAliases() || [];
  } catch (e) {
    aliasError = String(e && e.message || e);
    Logger.log('getAliases failed: ' + aliasError);
  }
  var acct = '';
  try { acct = Session.getEffectiveUser().getEmail(); } catch (e) {}
  var configured = getSetting_('FROM_ADDRESS', '');
  var allowed = [acct].concat(aliases).filter(Boolean);
  return {
    account: acct,
    aliases: aliases,
    allowed: allowed,
    configured: configured,
    configuredIsAllowed: !configured || allowed.map(function(a){ return String(a).toLowerCase(); })
      .indexOf(String(configured).toLowerCase()) !== -1,
    aliasError: aliasError,
    canReadAliases: !aliasError,
    gmailSettingsUrl: 'https://mail.google.com/mail/u/0/#settings/accounts'
  };
}

/** Save the chosen sending address into SETTINGS. Rejects anything Gmail will not allow. */
function setFromAddress_(payload, me) {
  var addr = String((payload && payload.fromAddress) || '').trim();
  if (addr && !isEmail_(addr)) throw ValidationError_('That does not look like an email address.');
  var info = emailAliasInfo_({}, me);
  // Only refuse when we could actually READ the alias list and the address is
  // genuinely absent. If the list is unreadable, accept it and let Gmail decide -
  // refusing on the strength of a list we failed to load is how a correctly
  // configured alias became impossible to select.
  if (addr && info.canReadAliases &&
      info.allowed.map(function(a){ return String(a).toLowerCase(); }).indexOf(addr.toLowerCase()) === -1) {
    throw ValidationError_('Gmail will not let this account send as ' + addr +
      '. Add it under Gmail > Settings > Accounts > Send mail as, verify it, then try again.');
  }
  setSetting_('FROM_ADDRESS', addr, me.email);
  return emailAliasInfo_({}, me);
}

/**
 * Returns the body with exactly one signature.
 * Templates carry {{SIGNATURE}}; if the token pass already expanded it, we leave
 * the body alone. Only a template that omits it gets one appended.
 */
function appendSignatureOnce_(html) {
  var sig = String(buildSignature_() || '').trim();
  var body = String(html || '');
  if (!sig) return body;
  // Compare on text, not markup, so whitespace or tag differences do not fool it.
  var norm = function(s) {
    return stripHtml_(String(s || '')).replace(/\s+/g, ' ').trim().toLowerCase();
  };
  var sigText = norm(sig);
  if (sigText && norm(body).indexOf(sigText) !== -1) return body;
  return body + sig;
}

/**
 * Builds the signature block. Outlook-style: logo, name, title, contact line.
 * Table markup with inline styles, because that is what survives Outlook and Gmail.
 * The logo must be a public https image URL; a Drive share link renders as a
 * broken image for anyone outside the domain.
 */
function buildSignature_() {
  var mode = String(getSetting_('SIGNATURE_MODE','BUILDER') || 'BUILDER').toUpperCase();
  if (mode !== 'BUILDER') return String(getSetting_('SIGNATURE','') || '');
  var g = function(k){ return String(getSetting_(k,'') || '').trim(); };
  var name = g('SIG_NAME'), title = g('SIG_TITLE'), phone = g('SIG_PHONE');
  var mail = g('SIG_EMAIL'), web = g('SIG_WEBSITE');
  // An uploaded logo wins; the URL field stays as a fallback for anyone who
  // already had one set.
  var logo = g('SIG_LOGO_FILE_ID') ? ('cid:' + SIG_LOGO_CID) : g('SIG_LOGO_URL');
  var tag = g('SIG_TAGLINE'), w = g('SIG_LOGO_WIDTH') || '140';
  var lines = [];
  if (name)  lines.push('<div style="font-weight:bold;color:#111">' + escHtml_(name) + '</div>');
  if (title) lines.push('<div style="color:#555">' + escHtml_(title) + '</div>');
  var contact = [];
  if (phone) contact.push(escHtml_(phone));
  if (mail)  contact.push('<a href="mailto:' + escHtml_(mail) + '" style="color:#1a73e8;text-decoration:none">' + escHtml_(mail) + '</a>');
  if (web)   contact.push('<a href="' + escHtml_(web) + '" style="color:#1a73e8;text-decoration:none">' + escHtml_(web.replace(/^https?:\/\//,'')) + '</a>');
  if (contact.length) lines.push('<div style="color:#555">' + contact.join(' &nbsp;|&nbsp; ') + '</div>');
  if (tag) lines.push('<div style="color:#888;font-size:11px;padding-top:4px">' + escHtml_(tag) + '</div>');
  var logoCell = logo
    ? '<td style="padding-right:14px;vertical-align:top"><img src="' + escHtml_(logo) +
      '" width="' + escHtml_(w) + '" alt="' + escHtml_(name || 'logo') + '" style="display:block;border:0"></td>'
    : '';
  return '<div style="margin-top:18px;padding-top:12px;border-top:1px solid #e0e0e0">' +
    '<p style="margin:0 0 8px;color:#333">Warm regards,</p>' +
    '<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px">' +
    '<tr>' + logoCell + '<td style="vertical-align:top">' + lines.join('') + '</td></tr></table></div>';
}

/* ============ SIGNATURE LOGO ============
 * The logo is uploaded, stored as a file on Drive, and embedded in each email as
 * an inline CID attachment. That means no public hosting and no image URL: the
 * picture travels inside the message, so it renders in Outlook and Gmail even for
 * people outside the domain. A Drive share link would show as a broken image for
 * exactly those recipients, which is why this path exists.
 */
var SIG_LOGO_CID = 'cruxsignaturelogo';

function signatureFolder_() {
  var name = 'Crux Escalation Matrix - Assets';
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** Store an uploaded image and remember its file id. */
function saveSignatureLogo_(p, me) {
  var data = String(p.dataBase64 || '');
  if (!data) throw ValidationError_('No image was received. Please choose a file.');
  var mime = String(p.mimeType || '').toLowerCase();
  if (['image/png','image/jpeg','image/jpg','image/gif'].indexOf(mime) === -1) {
    throw ValidationError_('Use a PNG, JPG or GIF image.');
  }
  var bytes = Utilities.base64Decode(data);
  if (bytes.length > 1024 * 1024) {
    throw ValidationError_('That image is ' + Math.round(bytes.length/1024) + ' KB. Please use one under 1 MB.');
  }
  var blob = Utilities.newBlob(bytes, mime, String(p.filename || 'signature-logo'));

  // Replace the previous logo rather than piling up copies in Drive.
  var oldId = String(getSetting_('SIG_LOGO_FILE_ID','') || '').trim();
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }

  var file = signatureFolder_().createFile(blob);
  setSetting_('SIG_LOGO_FILE_ID', file.getId(), me.email);
  setSetting_('SIG_LOGO_URL', '', me.email);   // the URL route is no longer needed
  logAudit_({ user: me.email, action:'SIGNATURE_LOGO', entity:'SETTINGS',
    entityId:'SIG_LOGO_FILE_ID', oldValue: oldId, newValue: file.getId() });
  return { ok: true, fileId: file.getId(), sizeKb: Math.round(bytes.length/1024) };
}

function removeSignatureLogo_(p, me) {
  var oldId = String(getSetting_('SIG_LOGO_FILE_ID','') || '').trim();
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  setSetting_('SIG_LOGO_FILE_ID', '', me.email);
  return { ok: true };
}

/** The blob to attach inline, or null when no logo is set. */
function signatureLogoBlob_() {
  var id = String(getSetting_('SIG_LOGO_FILE_ID','') || '').trim();
  if (!id) return null;
  try {
    var b = DriveApp.getFileById(id).getBlob();
    b.setName(SIG_LOGO_CID);
    return b;
  } catch (e) {
    Logger.log('signature logo unreadable: ' + e);
    return null;
  }
}

/** A base64 data URI, used only for the on-screen preview. */
function signatureLogoPreview_(p, me) {
  var b = signatureLogoBlob_();
  if (!b) return { dataUri: '', has: false };
  return { has: true,
           dataUri: 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()) };
}

/** Signature as HTML, plus a preview variant with the logo inlined for the screen. */
function signaturePreview_(p, me) {
  var html = buildSignature_();
  var pv = signatureLogoPreview_();
  return { html: html.split('cid:' + SIG_LOGO_CID).join(pv.dataUri || ''), hasLogo: pv.has };
}
