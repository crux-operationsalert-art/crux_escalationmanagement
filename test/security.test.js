/**
 * security.test.js — the P0 incident, as an executable test.
 *
 * Scenario 1 is the reported incident reproduced against the OLD logic, so the
 * test proves the vulnerability was real rather than asserting it away. Every
 * other case exercises the new logic and must pass.
 *
 * Run: node test/security.test.js
 */
const assert = require('assert');
const { createSandbox } = require('./gas-harness');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32mPASS\x1b[0m ' + name); pass++; }
  catch (e) { console.log('  \x1b[31mFAIL\x1b[0m ' + name + '\n         ' + e.message); fail++; }
}
function section(t) { console.log('\n' + t); }

const ADMIN = 'shantanu.suravase@cruxindia.co.in';
const GMAIL_USER = 'pawarakanksha27@gmail.com';        // real ACTIVE VIEWER on personal Gmail
const OUTSIDER = 'someone.random@example.com';

/** A sandbox whose USERS rows carry known invite codes. */
function boot(activeUser) {
  const s = createSandbox({ activeUser: activeUser || '' });
  const users = s.__tables.USERS;
  users.forEach(u => {
    u.AccessToken = 'CODE-' + String(u.Email || '').replace(/[^a-z0-9]/gi, '') + '-PADPADPADPADPAD';
    u.InviteStatus = 'SENT';
    u.InvitedAt = new Date().toISOString();
  });
  return s;
}
const codeFor = (s, email) => (s.__tables.USERS
  .find(u => String(u.Email).toLowerCase() === email.toLowerCase()) || {}).AccessToken;

/* ==================================================================== */
section('1. The reported incident — reproduced against the OLD logic');

test('OLD: a permanent URL token authenticated the holder as full ADMIN', () => {
  const s = boot('');                       // no Google identity: any outsider
  const token = codeFor(s, ADMIN);
  // This is verbatim the pre-fix emailFromToken_ + whoAmI_ token path.
  const legacyResolve = (tok) => {
    const u = s.readTable_('USERS').find(x => String(x.AccessToken || '').trim() === String(tok).trim());
    if (!u) return '';
    if (String(u.Status || '') !== 'ACTIVE') return '';
    return String(u.Email || '').toLowerCase();
  };
  const who = legacyResolve(token);
  assert.strictEqual(who, ADMIN, 'expected the legacy path to hand back the admin');
  const row = s.readTable_('USERS').find(u => u.Email.toLowerCase() === who);
  assert.strictEqual(String(row.Role).toUpperCase(), 'ADMIN',
    'the legacy path yielded an ADMIN identity to an anonymous holder of the URL');
});

/* ==================================================================== */
section('2. The same attack against the NEW logic');

test('an admin invite code is refused outright (admin ceiling)', () => {
  const s = boot('');
  assert.throws(() => s.exchangeInviteCode_(codeFor(s, ADMIN), {}),
    /Administrator accounts cannot sign in through a personal link/);
});

test('the refusal is written to the audit trail', () => {
  const s = boot('');
  try { s.exchangeInviteCode_(codeFor(s, ADMIN), {}); } catch (e) {}
  const hit = s.__tables.AUDIT_LOG.filter(r => r.Action === 'AUTH_REFUSED_ADMIN_VIA_LINK');
  assert.ok(hit.length >= 1, 'expected an AUTH_REFUSED_ADMIN_VIA_LINK audit row');
});

test('emailFromToken_ never resolves an administrator', () => {
  const s = boot('');
  assert.strictEqual(s.emailFromToken_(codeFor(s, ADMIN)), '');
});

test('no session row is created by the refused attempt', () => {
  const s = boot('');
  const before = s.__tables.SESSIONS.length;
  try { s.exchangeInviteCode_(codeFor(s, ADMIN), {}); } catch (e) {}
  assert.strictEqual(s.__tables.SESSIONS.length, before);
});

/* ==================================================================== */
section('3. Authorised users still work');

test('authorised ADMIN via Google sign-in gets ADMIN', () => {
  const s = boot(ADMIN);
  const me = s.whoAmI_('', {});
  assert.strictEqual(me.email.toLowerCase(), ADMIN);
  assert.strictEqual(me.role, 'ADMIN');
  assert.strictEqual(me.active, true);
  assert.strictEqual(me.identitySource, 'GOOGLE');
});

test('authorised MANAGER via Google sign-in gets MANAGER', () => {
  const s = boot('nitish.bhope@cruxindia.co.in');
  const me = s.whoAmI_('', {});
  assert.strictEqual(me.role, 'MANAGER');
  assert.strictEqual(me.active, true);
});

test('authorised LOCATION_HEAD via Google sign-in gets LOCATION_HEAD', () => {
  const s = boot('avinash.chaskar@cruxindia.co.in');
  assert.strictEqual(s.whoAmI_('', {}).role, 'LOCATION_HEAD');
});

test('out-of-domain colleague exchanges their code and is identified', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), { ua: 'UA/1', lang: 'en', tz: 'Asia/Kolkata' });
  assert.ok(ex && ex.sessionId, 'expected a session');
  assert.strictEqual(ex.email, GMAIL_USER);
  const me = s.whoAmI_(ex.sessionId, { ua: 'UA/1', lang: 'en', tz: 'Asia/Kolkata' });
  assert.strictEqual(me.email.toLowerCase(), GMAIL_USER);
  assert.strictEqual(me.active, true);
  assert.strictEqual(me.identitySource, 'SESSION');
  assert.strictEqual(me.role, 'VIEWER');
});

/* ==================================================================== */
section('4. Invite codes are single-use and expiring');

test('a code cannot be used twice', () => {
  const s = boot('');
  const code = codeFor(s, GMAIL_USER);
  assert.ok(s.exchangeInviteCode_(code, {}), 'first use should succeed');
  assert.strictEqual(s.exchangeInviteCode_(code, {}), null, 'second use must fail');
});

test('a used code is marked USED, not left live', () => {
  const s = boot('');
  s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  const row = s.readTable_('USERS').find(u => u.Email.toLowerCase() === GMAIL_USER);
  assert.strictEqual(row.InviteStatus, 'USED');
  assert.strictEqual(String(row.AccessToken || ''), '');
});

test('an expired code is refused', () => {
  const s = boot('');
  const old = new Date(Date.now() - (s.INVITE_CODE_VALID_DAYS + 1) * 86400000).toISOString();
  s.updateRowById_('USERS', 'Email', GMAIL_USER, { InvitedAt: old });
  assert.strictEqual(s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {}), null);
});

test('a revoked code is refused', () => {
  const s = boot('');
  s.updateRowById_('USERS', 'Email', GMAIL_USER, { InviteStatus: 'REVOKED' });
  assert.strictEqual(s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {}), null);
});

test('a code for a non-ACTIVE user is refused', () => {
  const s = boot('');
  s.updateRowById_('USERS', 'Email', GMAIL_USER, { Status: 'PENDING' });
  assert.strictEqual(s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {}), null);
});

test('a made-up code is refused', () => {
  const s = boot('');
  assert.strictEqual(s.exchangeInviteCode_('NOTAREALCODE-XXXXXXXXXXXXXXXXXXXX', {}), null);
});

test('a short string is refused without touching the table', () => {
  const s = boot('');
  assert.strictEqual(s.exchangeInviteCode_('abc', {}), null);
  assert.strictEqual(s.exchangeInviteCode_('', {}), null);
});

/* ==================================================================== */
section('5. Sessions expire, bind and revoke');

test('an idle-expired session stops working', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  const stale = new Date(Date.now() - (s.SESSION_IDLE_MINUTES + 5) * 60000).toISOString();
  s.updateRowById_('SESSIONS', 'SessionID', ex.sessionId, { LastSeenAt: stale });
  assert.strictEqual(s.emailFromSession_(ex.sessionId, {}), '');
});

test('an absolutely-expired session stops working even if recently active', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  const born = new Date(Date.now() - (s.SESSION_ABSOLUTE_MINUTES + 5) * 60000).toISOString();
  s.updateRowById_('SESSIONS', 'SessionID', ex.sessionId,
    { CreatedAt: born, LastSeenAt: new Date().toISOString() });
  assert.strictEqual(s.emailFromSession_(ex.sessionId, {}), '');
});

test('a session binds to the first browser it is used from', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  const meta = { ua: 'Firefox/1', lang: 'en', tz: 'Asia/Kolkata' };
  assert.strictEqual(s.emailFromSession_(ex.sessionId, meta), GMAIL_USER);
  const row = s.readTable_('SESSIONS').find(x => x.SessionID === ex.sessionId);
  assert.ok(String(row.Fingerprint || '').length > 0, 'expected the session to bind on first use');
});

test('a stolen session id used from another browser is refused', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  s.emailFromSession_(ex.sessionId, { ua: 'Firefox/1', lang: 'en', tz: 'Asia/Kolkata' });
  assert.strictEqual(
    s.emailFromSession_(ex.sessionId, { ua: 'Chrome/9', lang: 'fr', tz: 'Europe/Paris' }), '',
    'a session replayed from a different browser must be refused');
});

test('revoking a session ends it immediately', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  s.revokeSession_(ex.sessionId, 'test');
  assert.strictEqual(s.emailFromSession_(ex.sessionId, {}), '');
});

test('revoking an invite also ends every live session for that person', () => {
  const s = boot(ADMIN);
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  const me = s.whoAmI_('', {});
  const out = s.revokeInvite_({ Email: GMAIL_USER }, me);
  assert.ok(out.sessionsEnded >= 1, 'expected at least one session to be ended');
  assert.strictEqual(s.emailFromSession_(ex.sessionId, {}), '');
});

test('a session dies when the person is deactivated', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  s.updateRowById_('USERS', 'Email', GMAIL_USER, { Status: 'INACTIVE' });
  assert.strictEqual(s.emailFromSession_(ex.sessionId, {}), '');
});

test('a session refuses to work if the person is later made an administrator', () => {
  const s = boot('');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  s.updateRowById_('USERS', 'Email', GMAIL_USER, { AdminAccess: 'YES' });
  assert.throws(() => s.emailFromSession_(ex.sessionId, {}),
    /Administrator accounts cannot sign in through a personal link/);
});

/* ==================================================================== */
section('6. Unknown and anonymous visitors get nothing');

test('an anonymous visitor is an inert guest', () => {
  const s = boot('');
  const me = s.whoAmI_('', {});
  assert.strictEqual(me.email, '');
  assert.strictEqual(me.active, false);
  assert.strictEqual(me.role, 'VIEWER');
});

test('a non-invited outsider with a Google identity gets no access', () => {
  const s = boot(OUTSIDER);
  const me = s.whoAmI_('', {});
  assert.strictEqual(me.active, false);
  assert.strictEqual(me.unknown, true);
});

test('a non-invited outsider does NOT get a USERS row created', () => {
  const s = boot(OUTSIDER);
  const before = s.__tables.USERS.length;
  s.whoAmI_('', {});
  assert.strictEqual(s.__tables.USERS.length, before,
    'loading the page must never write a USERS row for a stranger');
});

test('the refused outsider is recorded in the audit trail', () => {
  const s = boot(OUTSIDER);
  s.whoAmI_('', {});
  assert.ok(s.__tables.AUDIT_LOG.some(r => r.Action === 'AUTH_UNKNOWN_VISITOR'));
});

test('an empty USERS sheet does NOT promote the first arrival to ADMIN', () => {
  const s = boot(OUTSIDER);
  s.__tables.USERS.length = 0;               // no admins exist at all
  const me = s.whoAmI_('', {});
  assert.notStrictEqual(me.role, 'ADMIN', 'a stranger must never bootstrap to ADMIN');
  assert.strictEqual(me.active, false);
  assert.strictEqual(s.__tables.USERS.length, 0, 'and still no row created');
});

test('an allowlisted bootstrap admin CAN still recover an empty USERS sheet', () => {
  const s = boot(ADMIN);
  s.__tables.USERS.length = 0;
  const me = s.whoAmI_('', {});
  assert.strictEqual(me.role, 'ADMIN');
  assert.strictEqual(me.active, true);
});

/* ==================================================================== */
section('7. No session reuse between people on one browser');

test('two people in sequence on the same browser do not share identity', () => {
  const s = boot('');
  const a = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  const meta = { ua: 'Shared/1', lang: 'en', tz: 'Asia/Kolkata' };
  assert.strictEqual(s.whoAmI_(a.sessionId, meta).email.toLowerCase(), GMAIL_USER);
  // Second person signs in on the same machine with their own code.
  const other = 'vsalunkhe1880@gmail.com';
  const b = s.exchangeInviteCode_(codeFor(s, other), {});
  assert.strictEqual(s.whoAmI_(b.sessionId, meta).email.toLowerCase(), other,
    'the cache must not hand back the previous person');
});

test('the identity cache is keyed per credential, not global', () => {
  const s = boot('');
  const guest = s.whoAmI_('', {});
  assert.strictEqual(guest.email, '');
  const ex = s.exchangeInviteCode_(codeFor(s, GMAIL_USER), {});
  const real = s.whoAmI_(ex.sessionId, {});
  assert.strictEqual(real.email.toLowerCase(), GMAIL_USER,
    'a guest resolved earlier must not be returned for an authenticated call');
});

/* ==================================================================== */
section('8. Administrators cannot be issued link credentials at all');

test('inviting an administrator is refused with a clear reason', () => {
  const s = boot(ADMIN);
  const me = s.whoAmI_('', {});
  assert.throws(() => s.inviteUser_({ Email: ADMIN }, me),
    /Administrators sign in with their Crux Google account/);
});

test('a non-admin can still be invited, and gets a fresh single-use code', () => {
  const s = boot(ADMIN);
  const me = s.whoAmI_('', {});
  const before = codeFor(s, GMAIL_USER);
  const out = s.inviteUser_({ Email: GMAIL_USER }, me);
  assert.ok(out.ok);
  const after = codeFor(s, GMAIL_USER);
  assert.notStrictEqual(after, before, 'a resend must mint a fresh code, not reuse a spent one');
  assert.ok(out.link.indexOf('t=') !== -1);
});

/* ==================================================================== */
section('9. Window reopen policy (section 11)');

test('the current month can be reopened', () => {
  const s = boot(ADMIN);
  const now = new Date();
  const mk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  assert.strictEqual(s.reopenAllowedFor_(mk, now).allowed, true);
});

test('a month is still reopenable on the 15th of the following month', () => {
  const s = boot(ADMIN);
  assert.strictEqual(s.reopenAllowedFor_('2026-07', new Date(2026, 7, 15, 12, 0)).allowed, true);
});

test('a month is NOT reopenable on the 16th of the following month', () => {
  const s = boot(ADMIN);
  assert.strictEqual(s.reopenAllowedFor_('2026-07', new Date(2026, 7, 16, 0, 1)).allowed, false);
});

test('reopening past the cutoff is refused by the handler', () => {
  const s = boot(ADMIN);
  const me = s.whoAmI_('', {});
  assert.throws(() => s.grantWindowOverride_(
    { Kind: 'TARGET', Email: GMAIL_USER, MonthKey: '2020-01', Reason: 'a genuine documented reason' }, me),
    /can no longer be reopened/);
});

test('a reopen requires a real reason', () => {
  const s = boot(ADMIN);
  const me = s.whoAmI_('', {});
  const now = new Date();
  const mk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  assert.throws(() => s.grantWindowOverride_(
    { Kind: 'TARGET', Email: GMAIL_USER, MonthKey: mk, Reason: 'x' }, me), /Record why/);
});

test('a granted reopen writes a value the window guard actually accepts', () => {
  const s = boot(ADMIN);
  const me = s.whoAmI_('', {});
  const now = new Date();
  const mk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  s.grantWindowOverride_({ Kind: 'TARGET', Email: GMAIL_USER, MonthKey: mk,
    Reason: 'joined mid-month, agreed with HR' }, me);
  const v = s.getSetting_(s.windowOverrideKey_('TARGET', GMAIL_USER, mk), '');
  assert.ok(v.indexOf('OPEN:') === 0,
    'assertWindowOpen_ tests for the OPEN: prefix; the handler must write it');
});

test('a non-admin cannot reopen a window', () => {
  const s = boot(GMAIL_USER);
  const me = s.whoAmI_('', {});
  assert.throws(() => s.grantWindowOverride_(
    { Kind: 'TARGET', Email: GMAIL_USER, Reason: 'because I would like to' }, me),
    /Only an administrator/);
});

/* ==================================================================== */
console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
