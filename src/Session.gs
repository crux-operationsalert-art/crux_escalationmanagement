/**
 * Session.gs — authenticated sessions for out-of-domain staff.
 *
 * WHY THIS FILE EXISTS (P0 incident, 2026-08-22)
 * ----------------------------------------------
 * The web app is published `executeAs: USER_DEPLOYING`. Under that mode Google
 * only reveals `Session.getActiveUser().getEmail()` when the visitor is in the
 * same Workspace domain as the deploying account. Nine legitimate colleagues are
 * on personal Gmail addresses, so for them the script sees no identity at all.
 *
 * The previous answer was a permanent token in the URL: `.../exec?t=<token>`,
 * matched straight against USERS.AccessToken. That token
 *   - never expired,
 *   - was reusable an unlimited number of times,
 *   - was not bound to a browser or a device,
 *   - identified ADMINS as readily as anyone else, and
 *   - lived in the query string, so it leaked through browser history, URL
 *     autocomplete, bookmarks, screenshots, the Referer header and any forwarded
 *     copy of the invite email.
 * Anyone who obtained that URL became that user permanently. When the URL
 * belonged to an admin, the holder became a full administrator. That is exactly
 * the reported incident: opening the live link from a non-Crux, non-invited
 * address produced an administrator session.
 *
 * THE MODEL NOW
 * -------------
 *  - USERS.AccessToken is an INVITE CODE: single-use and short-lived. Opening the
 *    invite link EXCHANGES the code for a session and consumes the code, so a
 *    forwarded or replayed link is dead on arrival.
 *  - A session is a server-side row in SESSIONS. The browser holds only its id,
 *    in sessionStorage — never in the URL, so it cannot be bookmarked, shared or
 *    put in a Referer header, and it dies when the tab closes.
 *  - Sessions carry an idle timeout, an absolute lifetime, a bound client
 *    fingerprint and a revocation flag.
 *  - A session can NEVER carry administrator rights. See assertNotPrivileged_():
 *    a token/session identity is refused outright for any row that administers
 *    the tool. Administrators sign in with their Crux Google account, whose
 *    identity comes from Google and cannot be replayed. This one invariant means
 *    that even a leaked invite code cannot reproduce the incident.
 */

/* Lifetimes. Deliberately short: a session is a convenience, not a credential
 * anyone should be able to hoard. */
var SESSION_IDLE_MINUTES     = 12 * 60;   // no activity for this long -> dead
var SESSION_ABSOLUTE_MINUTES = 7 * 24 * 60; // hard ceiling regardless of use
var INVITE_CODE_VALID_DAYS   = 14;        // an unused invite expires
var SESSION_ID_MIN_LENGTH    = 40;

/** Cryptographically random, URL-safe id. */
function newSessionId_() {
  var raw = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)).replace(/=+$/, '');
}

/**
 * Stable, non-reversible fingerprint of the calling browser. Binding a session
 * to this means a session id copied out of one browser's storage into another is
 * refused. It is a speed bump, not a proof of identity — which is why it sits on
 * top of expiry and the administrator ceiling rather than replacing them.
 */
function clientFingerprint_(meta) {
  var m = meta || {};
  var basis = [String(m.ua || ''), String(m.lang || ''), String(m.tz || '')].join('|');
  if (!basis.replace(/\|/g, '')) return '';
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, basis)).replace(/=+$/, '').slice(0, 32);
}

function minutesBetween_(aIso, bDate) {
  var a = new Date(aIso).getTime();
  if (!a || isNaN(a)) return Infinity;
  return ((bDate || new Date()).getTime() - a) / 60000;
}

/**
 * A session identity must never administer the tool. Administrators are
 * identified by Google, never by a replayable credential.
 * Throws (fails closed) rather than silently downgrading, so the refusal is
 * visible in the audit trail instead of looking like a role mix-up.
 */
function assertNotPrivileged_(userRow, how) {
  if (!userRow) return;
  var isAdmin = hasAdminAccess_(userRow) || String(userRow.Role || '').toUpperCase() === 'ADMIN';
  if (!isAdmin) return;
  try {
    logAudit_({
      user: String(userRow.Email || '').toLowerCase(), action: 'AUTH_REFUSED_ADMIN_VIA_LINK',
      entity: 'SESSIONS', entityId: '', oldValue: how || 'TOKEN',
      newValue: 'Administrator identity may only come from a Crux Google sign-in.'
    });
  } catch (e) {}
  throw AuthError_(
    'Administrator accounts cannot sign in through a personal link. ' +
    'Please open the tool while signed in to your Crux Google account.');
}

/**
 * Exchange a single-use invite code for a session. Consumes the code.
 * Returns { sessionId, email } or null when the code is not usable.
 */
function exchangeInviteCode_(code, meta) {
  var t = String(code || '').trim();
  if (t.length < 20) return null;

  var user = readTable_('USERS').filter(function(u) {
    return String(u.AccessToken || '').trim() === t;
  })[0];

  var fail = function(reason) {
    try {
      logAudit_({ user: user ? String(user.Email||'').toLowerCase() : 'unknown',
        action: 'AUTH_INVITE_REJECTED', entity: 'USERS', entityId: user ? String(user.Email||'') : '',
        oldValue: reason, newValue: '' });
    } catch (e) {}
    return null;
  };

  if (!user) return fail('NO_MATCH');
  if (String(user.Status || '') !== 'ACTIVE') return fail('USER_NOT_ACTIVE');
  if (String(user.InviteStatus || '').toUpperCase() === 'REVOKED') return fail('INVITE_REVOKED');
  if (String(user.InviteStatus || '').toUpperCase() === 'USED') return fail('INVITE_ALREADY_USED');

  var invitedAt = String(user.InvitedAt || '').trim();
  if (invitedAt && minutesBetween_(invitedAt, new Date()) > INVITE_CODE_VALID_DAYS * 24 * 60) {
    return fail('INVITE_EXPIRED');
  }

  // Administrators may not enter this way, however valid the code is.
  assertNotPrivileged_(user, 'INVITE_CODE');

  var email = String(user.Email || '').toLowerCase();
  var sid = newSessionId_();
  appendRow_('SESSIONS', {
    SessionID: sid,
    PersonEmail: email,
    CreatedAt: nowIso_(),
    LastSeenAt: nowIso_(),
    ExpiresAt: '',
    // Left blank on purpose: doGet has no user-agent to hash. The first RPC
    // binds it (see emailFromSession_).
    Fingerprint: clientFingerprint_(meta),
    Source: 'INVITE',
    RevokedAt: '',
    RevokedBy: ''
  });
  invalidateTableCache_('SESSIONS');

  // Burn the code. A forwarded copy of the invite email is now inert.
  updateRowById_('USERS', 'Email', email, {
    AccessToken: '', InviteStatus: 'USED',
    UpdatedAt: nowIso_(), UpdatedBy: 'system:invite-exchange'
  });
  invalidateTableCache_('USERS');

  logAudit_({ user: email, action: 'AUTH_SESSION_START', entity: 'SESSIONS', entityId: sid,
    oldValue: 'INVITE', newValue: '' });
  return { sessionId: sid, email: email };
}

/**
 * Resolve a session id to an email, or '' when it is not usable.
 * Slides the idle window forward on every successful call.
 */
function emailFromSession_(sessionId, meta) {
  var sid = String(sessionId || '').trim();
  if (sid.length < SESSION_ID_MIN_LENGTH) return '';

  var s = readTable_('SESSIONS').filter(function(x) {
    return String(x.SessionID || '').trim() === sid;
  })[0];

  var fail = function(reason) {
    try {
      logAudit_({ user: s ? String(s.PersonEmail||'') : 'unknown', action: 'AUTH_SESSION_REJECTED',
        entity: 'SESSIONS', entityId: sid.slice(0, 8) + '…', oldValue: reason, newValue: '' });
    } catch (e) {}
    return '';
  };

  if (!s) return fail('NO_MATCH');
  if (String(s.RevokedAt || '').trim()) return fail('REVOKED');
  if (minutesBetween_(s.CreatedAt, new Date())  > SESSION_ABSOLUTE_MINUTES) return fail('ABSOLUTE_EXPIRY');
  if (minutesBetween_(s.LastSeenAt, new Date()) > SESSION_IDLE_MINUTES)     return fail('IDLE_EXPIRY');

  // Binding: trust-on-first-use.
  //
  // doGet cannot see the browser's user-agent (Apps Script exposes no request
  // headers), so a session is born unbound and the fingerprint only arrives with
  // the first RPC. Binding at that moment, then enforcing it, is what makes the
  // check real - storing it at exchange time recorded an empty string and the
  // comparison below never ran.
  var bound = String(s.Fingerprint || '').trim();
  var seen = clientFingerprint_(meta);
  if (bound) {
    if (seen && seen !== bound) return fail('FINGERPRINT_MISMATCH');
  } else if (seen) {
    try {
      updateRowById_('SESSIONS', 'SessionID', sid, { Fingerprint: seen });
      invalidateTableCache_('SESSIONS');
    } catch (e) {}
  }

  var email = String(s.PersonEmail || '').toLowerCase();
  var user = readTable_('USERS').filter(function(u) {
    return String(u.Email || '').toLowerCase() === email;
  })[0];
  if (!user) return fail('USER_GONE');
  if (String(user.Status || '') !== 'ACTIVE') return fail('USER_NOT_ACTIVE');

  // Re-checked on EVERY call, not just at exchange: if this person is granted
  // admin rights while holding a session, the session stops working rather than
  // silently becoming an administrator session.
  assertNotPrivileged_(user, 'SESSION');

  // Slide the idle window. Best-effort — a failed touch must not deny access.
  try {
    updateRowById_('SESSIONS', 'SessionID', sid, { LastSeenAt: nowIso_() });
    invalidateTableCache_('SESSIONS');
  } catch (e) {}

  return email;
}

/** Revoke one session. */
function revokeSession_(sessionId, by) {
  var sid = String(sessionId || '').trim();
  if (!sid) return { ok: false };
  updateRowById_('SESSIONS', 'SessionID', sid,
    { RevokedAt: nowIso_(), RevokedBy: by || 'system' });
  invalidateTableCache_('SESSIONS');
  logAudit_({ user: by || 'system', action: 'AUTH_SESSION_REVOKE', entity: 'SESSIONS',
    entityId: sid, oldValue: '', newValue: '' });
  return { ok: true };
}

/** Revoke every live session for a person. Used when access is withdrawn. */
function revokeSessionsFor_(email, by) {
  var em = String(email || '').toLowerCase();
  if (!em) return { ok: false, revoked: 0 };
  var n = 0;
  readTable_('SESSIONS').forEach(function(s) {
    if (String(s.PersonEmail || '').toLowerCase() !== em) return;
    if (String(s.RevokedAt || '').trim()) return;
    updateRowById_('SESSIONS', 'SessionID', s.SessionID,
      { RevokedAt: nowIso_(), RevokedBy: by || 'system' });
    n++;
  });
  if (n) invalidateTableCache_('SESSIONS');
  logAudit_({ user: by || 'system', action: 'AUTH_SESSIONS_REVOKE_ALL', entity: 'USERS',
    entityId: em, oldValue: String(n), newValue: '' });
  return { ok: true, revoked: n };
}

/** Explicit sign-out from the UI. */
function endMySession_(p, me) {
  var sid = String((p && p.__s) || '').trim();
  if (!sid) return { ok: true };
  return revokeSession_(sid, me && me.email ? me.email : 'self');
}

/** Admin view of live sessions. Ids are truncated — never show a live credential. */
function listSessions_(p, me) {
  if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can view sessions.');
  var now = new Date();
  return readTable_('SESSIONS').map(function(s) {
    var revoked = !!String(s.RevokedAt || '').trim();
    var idle = minutesBetween_(s.LastSeenAt, now);
    var abs  = minutesBetween_(s.CreatedAt, now);
    return {
      SessionRef: String(s.SessionID || '').slice(0, 8) + '…',
      SessionID: s.SessionID,             // needed to revoke; admin-only route
      PersonEmail: s.PersonEmail,
      CreatedAt: s.CreatedAt, LastSeenAt: s.LastSeenAt,
      Source: s.Source || '',
      Bound: !!String(s.Fingerprint || '').trim(),
      Status: revoked ? 'REVOKED'
            : abs  > SESSION_ABSOLUTE_MINUTES ? 'EXPIRED'
            : idle > SESSION_IDLE_MINUTES     ? 'IDLE_EXPIRED' : 'LIVE',
      IdleMinutes: Math.round(idle)
    };
  }).sort(function(a, b) { return String(b.LastSeenAt).localeCompare(String(a.LastSeenAt)); });
}

/** Admin action: revoke a session. */
function adminRevokeSession_(p, me) {
  if (!hasAdminAccess_(userRow_(me))) throw AuthError_('Only an administrator can revoke a session.');
  if (p && p.Email) return revokeSessionsFor_(p.Email, me.email);
  return revokeSession_(p && p.SessionID, me.email);
}

/**
 * Housekeeping: drop rows that can no longer authenticate anything. Called from
 * the scheduler so SESSIONS does not grow without bound.
 */
function purgeDeadSessions_() {
  var now = new Date(), removed = 0;
  readTable_('SESSIONS').forEach(function(s) {
    var dead = String(s.RevokedAt || '').trim()
      || minutesBetween_(s.CreatedAt, now)  > SESSION_ABSOLUTE_MINUTES
      || minutesBetween_(s.LastSeenAt, now) > SESSION_IDLE_MINUTES;
    // Keep recently-revoked rows for a week so the audit trail stays readable.
    if (dead && minutesBetween_(s.LastSeenAt, now) > SESSION_ABSOLUTE_MINUTES) {
      deleteRowById_('SESSIONS', 'SessionID', s.SessionID);
      removed++;
    }
  });
  if (removed) invalidateTableCache_('SESSIONS');
  return { removed: removed };
}
