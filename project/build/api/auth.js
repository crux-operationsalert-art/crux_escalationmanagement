// Workspace SSO for most people; admin-created e-mail + password with an
// activation OTP for field staff; account-free links for clients.
// The old system left 39 of 55 users holding standing AccessTokens in a sheet
// cell. Sessions here are rows in auth_session, expire, and can be revoked.
const crypto = require('crypto');
const { q, one, tx } = require('./db');

const SESSION_DAYS = 7;
const OTP_MINUTES = 15;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createSession(personId, source) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await q(
    `insert into auth_session (person_id, expires_at, source, token_hash)
     values ($1, now() + ($2 || ' days')::interval, $3, $4)`,
    [personId, SESSION_DAYS, source, sha(raw)]
  );
  return raw;
}

async function personForToken(raw) {
  if (!raw) return null;
  const r = await one(
    `update auth_session s set last_seen_at = now()
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
      returning s.person_id`,
    [sha(raw)]
  );
  if (!r) return null;
  return one(
    `select p.id, p.full_name, p.work_email, p.department, p.app_role, d.title as designation
       from person p left join designation d on d.id = p.designation_id
      where p.id = $1 and p.employment_status = 'ACTIVE' and p.superseded_by is null`,
    [r.person_id]
  );
}

// SSO. The Google id_token is verified against Workspace, then matched to a
// person by work_email — matched, never created. An unknown address is a
// refusal with a sentence, not an auto-provision.
async function signInWithWorkspace(idToken) {
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
  const claims = ticket.getPayload();
  if (!claims.email_verified) throw httpError(401, 'email_unverified');
  if (claims.hd !== process.env.WORKSPACE_DOMAIN) throw httpError(403, 'wrong_domain');

  const email = String(claims.email).toLowerCase();
  const p = await one(
    `select id, superseded_by from person
      where lower(work_email) = $1 and employment_status = 'ACTIVE'`,
    [email]
  );
  if (!p) throw httpError(403, 'not_a_person', 'This address has no person record. HR creates people; sign-in does not.');
  if (p.superseded_by) throw httpError(403, 'superseded', 'This address was merged during migration. Sign in with the surviving address.');
  return { token: await createSession(p.id, 'WORKSPACE_SSO'), personId: p.id };
}

// Field staff: HR creates the row, the person activates with a one-time code.
// The code is stored hashed and single-use.
async function issueActivation(personId, actorId) {
  const code = String(crypto.randomInt(100000, 999999));
  await tx(actorId, async (t) => {
    await t.q(
      `insert into person_event (person_id, kind, note, at)
       values ($1, 'ACTIVATION_ISSUED', $2, now())`,
      [personId, 'Activation code issued, valid ' + OTP_MINUTES + ' minutes']
    );
    await t.q(
      `insert into auth_session (person_id, expires_at, source, token_hash)
       values ($1, now() + ($2 || ' minutes')::interval, 'ACTIVATION_OTP', $3)`,
      [personId, OTP_MINUTES, sha(personId + ':' + code)]
    );
    await t.audit('ACTIVATION_ISSUED', 'person', personId, null, { channel: 'email' });
  });
  return code; // handed to the outbox, never logged
}

async function redeemActivation(email, code, password) {
  const p = await one(`select id from person where lower(work_email) = lower($1)`, [email]);
  if (!p) throw httpError(403, 'not_a_person');
  const s = await one(
    `update auth_session set revoked_at = now()
      where person_id = $1 and source = 'ACTIVATION_OTP'
        and token_hash = $2 and revoked_at is null and expires_at > now()
      returning id`,
    [p.id, sha(p.id + ':' + code)]
  );
  if (!s) throw httpError(403, 'bad_code', 'That code is wrong or has expired. Ask HR to issue a new one.');
  if (!password || password.length < 10) throw httpError(400, 'weak_password', 'Ten characters minimum.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  await q(`update person set password_hash = $2, password_salt = $3, updated_at = now() where id = $1`,
    [p.id, hash, salt.toString('hex')]);
  return { token: await createSession(p.id, 'PASSWORD') };
}

async function signInWithPassword(email, password) {
  const p = await one(
    `select id, password_hash, password_salt from person
      where lower(work_email) = lower($1) and employment_status = 'ACTIVE' and superseded_by is null`,
    [email]
  );
  if (!p || !p.password_hash) throw httpError(403, 'no_password', 'This account signs in with Google.');
  const hash = crypto.scryptSync(password, Buffer.from(p.password_salt, 'hex'), 64).toString('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(p.password_hash)))
    throw httpError(403, 'bad_credentials');
  return { token: await createSession(p.id, 'PASSWORD') };
}

// Account-free client portal. The link is the credential; only its hash is
// stored, it is rotatable and revocable, and it grants exactly one client or
// one branch — read-only.
async function portalContext(rawToken) {
  return one(
    `select client_id, branch_id from portal_link
      where token_hash = $1 and revoked_at is null`,
    [sha(rawToken)]
  );
}

function httpError(status, code, reason) {
  const e = new Error(code);
  e.status = status; e.code = code; e.reason = reason;
  return e;
}

function middleware() {
  return async (req, res, next) => {
    try {
      const h = req.get('authorization') || '';
      const raw = h.startsWith('Bearer ') ? h.slice(7) : null;
      req.person = await personForToken(raw);
      next();
    } catch (e) { next(e); }
  };
}

function requirePerson(req, res, next) {
  if (!req.person) return res.status(401).json({ error: 'sign_in_required' });
  next();
}

module.exports = {
  middleware, requirePerson, createSession, signInWithWorkspace, signInWithPassword,
  issueActivation, redeemActivation, portalContext, httpError,
};
