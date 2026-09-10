const express = require('express');
const auth = require('./auth');
const scope = require('./scope');
const { one, q } = require('./db');
const outbox = require('./outbox');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// The prototype is served from a different origin during the pilot only.
app.use((req, res, next) => {
  const allowed = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
  const origin = req.get('origin');
  if (origin && allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'authorization, content-type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(auth.middleware());
app.use(scope.middleware());

app.get('/health', async (_req, res) => {
  const db = await one('select now() as at').catch(() => null);
  res.status(db ? 200 : 503).json({ db: !!db, at: db && db.at });
});

// sign-in
app.post('/auth/google', async (req, res, next) => {
  try { res.json(await auth.signInWithWorkspace(req.body.idToken)); } catch (e) { next(e); }
});
app.post('/auth/password', async (req, res, next) => {
  try { res.json(await auth.signInWithPassword(req.body.email, req.body.password)); } catch (e) { next(e); }
});
app.post('/auth/activate', async (req, res, next) => {
  try { res.json(await auth.redeemActivation(req.body.email, req.body.code, req.body.password)); } catch (e) { next(e); }
});
app.post('/auth/signout', auth.requirePerson, async (req, res) => {
  const h = (req.get('authorization') || '').slice(7);
  await q(`update auth_session set revoked_at = now() where token_hash = encode(sha256($1::bytea),'hex')`, [h]);
  res.sendStatus(204);
});

// the account-free client portal: read-only, one client or one branch
app.get('/portal/:token', async (req, res, next) => {
  try {
    const ctx = await auth.portalContext(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'link_not_valid' });
    const rows = await require('./db').many(
      `select level, level_name, name, mobile, email from branch_effective_matrix
        where branch_id = coalesce($1, branch_id) order by level`,
      [ctx.branch_id]
    );
    res.json({ scope: ctx, levels: rows });
  } catch (e) { next(e); }
});

app.use('/api/cases', auth.requirePerson, require('./routes/cases'));
app.use('/api/matrix', auth.requirePerson, require('./routes/matrix'));
app.use('/api/pms', auth.requirePerson, require('./routes/pms'));
app.use('/api/people', auth.requirePerson, require('./routes/people'));
app.use('/api/penalties', auth.requirePerson, require('./routes/penalties'));

// operational visibility: the two numbers that would have caught the storm
app.get('/api/ops/mail', auth.requirePerson, async (_req, res) => {
  res.json({
    today: await one(`select * from mail_budget where day = current_date`),
    queued: (await one(`select count(*)::int as n from outbox where state = 'QUEUED'`)).n,
    failedToday: (await one(`select count(*)::int as n from delivery where state='FAILED' and at::date = current_date`)).n,
    cap: outbox.DAILY_CAP,
    jobs: await require('./db').many(
      `select job_key, enabled, disabled_reason from job_config order by job_key`
    ),
  });
});

app.use((e, _req, res, _next) => {
  const status = e.status || 500;
  if (status >= 500) console.error('[api]', e);
  res.status(status).json({ error: e.code || e.message, reason: e.reason || undefined });
});

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log('crux-api on :' + port));
module.exports = app;
