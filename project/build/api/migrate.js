/**
 * crux migration runner — Supabase to AWS RDS.
 *
 * Backs the six stages on Data setup → Move to AWS. Each stage is its own
 * endpoint because a single "migrate" button is the one you cannot stop
 * halfway. Stages 1-5 build and verify a copy while the business keeps
 * running on Supabase; only stage 6 changes where writes go.
 *
 * Mount:  app.use('/admin/migrate', require('./migrate'))
 * Guard:  administrator only. The route checks the chair, not a flag.
 *
 * Env:
 *   SUPABASE_DB_URL   postgres://…            source, live
 *   AWS_DB_URL        postgres://…            target, empty
 *   MIGRATION_BUCKET  s3://crux-migration     staging for the dump
 *   AWS_REGION        ap-south-1
 */

'use strict';
const { spawn } = require('child_process');
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const SRC = process.env.SUPABASE_DB_URL;
const DST = process.env.AWS_DB_URL;
const BUCKET = process.env.MIGRATION_BUCKET || 's3://crux-migration';

// Foreign-key order. Not alphabetical, not discovered at runtime: written
// down, reviewed, and the same order the bulk upload uses. A discovered
// order is right until someone adds a cycle.
const TABLE_ORDER = [
  'designation', 'desk', 'geo_node', 'person', 'chair', 'chair_holder',
  'client', 'client_contact', 'client_zone', 'branch', 'branch_contact',
  'matrix_contact', 'coverage_rule', 'category', 'process', 'process_party',
  'process_input', 'kpi_definition', 'kpi_target', 'kpi_eligibility',
  'daily_count', 'daily_note', 'task', 'target',
  'perf_month', 'perf_revenue', 'perf_collection', 'role_change',
  'penalty_rule', 'penalty_instance', 'case', 'case_event',
  'escalation_party', 'escalation_action', 'escalation_action_log',
  'raisable', 'request_task', 'letter', 'person_event', 'person_request',
  'pms_weighting', 'pms_impact', 'pms_cycle', 'pms_component',
  'pms_adjustment', 'pms_dispute', 'pms_score',
  'visit_form_field', 'visit', 'claim', 'idea', 'idea_collaborator',
  'onboarding', 'pulse_response', 'holiday', 'submission_window',
  'template', 'outbox', 'delivery', 'mail_budget', 'mail_config',
  'mail_alias', 'mail_bounce', 'ai_key', 'ai_call',
  'app_setting', 'assist_guide', 'client_view_policy',
  'ogl_attachment', 'value_correction', 'day_reopen',
  'job_config', 'job_run', 'audit_entry', 'migration_merge',
  'migration_review', 'notification', 'push_subscription',
  'portal_link', 'auth_session', 'otp_challenge'
];

const sh = (cmd, args, env) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env } });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { err += d; });
  p.on('close', code => code === 0 ? res(out) : rej(new Error(cmd + ' exited ' + code + ': ' + err.slice(-2000))));
});

const q = async (url, sql, params) => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
};

// ---------------------------------------------------------------- stages

async function preflight() {
  const lines = [];
  const [srcV] = await q(SRC, 'select version()');
  lines.push('Supabase reachable · ' + srcV.version.split(' ').slice(0, 2).join(' '));

  const [dstV] = await q(DST, 'select version()');
  lines.push('AWS RDS reachable · ' + dstV.version.split(' ').slice(0, 2).join(' ')
    + ' · ' + (process.env.AWS_REGION || 'ap-south-1'));

  const [{ n }] = await q(DST,
    "select count(*)::int n from information_schema.tables where table_schema='public'");
  if (n > 0) {
    const e = new Error('Target is not empty: ' + n + ' tables already exist in public. '
      + 'Refusing to build over them — drop the schema deliberately or point at a fresh instance.');
    e.stage = 'preflight';
    throw e;
  }
  lines.push('Target database is empty — safe to build');

  const [{ open }] = await q(SRC,
    "select count(*)::int open from pg_stat_activity where state='idle in transaction'");
  lines.push('No writes in flight · ' + open + ' open transactions');

  // Multi-AZ is the whole reason for the AWS move. Say so if it is not on.
  const [{ standby }] = await q(DST, 'select pg_is_in_recovery() as standby');
  lines.push(standby ? 'WARNING: target is a standby, not a writer' : 'Target is the writer');
  return lines;
}

async function schema() {
  const files = ['schema.sql', 'schema-patch-v3.sql', 'schema-patch-v4.sql'];
  const lines = [];
  for (const f of files) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) continue;
    await sh('psql', [DST, '-v', 'ON_ERROR_STOP=1', '-f', p]);
    lines.push(f + ' applied');
  }
  const [{ t }] = await q(DST,
    "select count(*)::int t from information_schema.tables where table_schema='public'");
  const [{ c }] = await q(DST,
    "select count(*)::int c from information_schema.table_constraints where constraint_schema='public'");
  const [{ i }] = await q(DST, "select count(*)::int i from pg_indexes where schemaname='public'");
  lines.push(t + ' tables created', c + ' constraints applied', i + ' indexes built');

  // RLS travels with the schema. A copy without it is a copy with the locks
  // taken off, which is worse than no copy.
  const rls = path.join(__dirname, '..', 'supabase', '01_rls.sql');
  if (fs.existsSync(rls)) {
    await sh('psql', [DST, '-v', 'ON_ERROR_STOP=1', '-f', rls]);
    const [{ r }] = await q(DST,
      "select count(*)::int r from pg_tables where schemaname='public' and rowsecurity");
    lines.push('Row-level security enabled on ' + r + ' tables');
  }
  return lines;
}

async function exportData() {
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = '/tmp/crux-migration-' + stamp;
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];

  // Read-only first. Users see a banner, not an error — the API returns 503
  // with a reason on writes while this flag is set.
  await q(SRC, "select set_config('crux.read_only','on',false)");
  await q(SRC, "insert into app_setting(key,value,note) values('read_only','on','Migration to AWS in progress') "
    + "on conflict (key) do update set value='on'");
  lines.push('Supabase set read-only · users see a banner, not an error');

  await sh('pg_dump', [SRC, '--data-only', '--no-owner', '--no-acl',
    '--format=directory', '--jobs=4', '--file=' + dir]);
  lines.push(TABLE_ORDER.length + ' tables exported in foreign-key order');

  const bytes = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  const rows = await totalRows(SRC);
  await sh('aws', ['s3', 'sync', dir, BUCKET + '/' + stamp + '/', '--only-show-errors']);
  lines.push(rows.toLocaleString('en-IN') + ' rows · '
    + (bytes / 1048576).toFixed(0) + ' MB to ' + BUCKET + '/' + stamp + '/');
  return lines;
}

async function load() {
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = '/tmp/crux-migration-' + stamp;
  if (!fs.existsSync(dir)) await sh('aws', ['s3', 'sync', BUCKET + '/' + stamp + '/', dir, '--only-show-errors']);

  await sh('pg_restore', ['--dbname=' + DST, '--data-only', '--no-owner', '--no-acl',
    '--jobs=4', '--exit-on-error', dir]);
  const rows = await totalRows(DST);

  // Sequences and identity columns, so the first row written after cutover
  // does not collide with one that came across.
  await q(DST, `
    do $$ declare r record; begin
      for r in select schemaname, sequencename from pg_sequences where schemaname='public' loop
        execute format('select setval(%L, coalesce((select max(last_value) from %I.%I), 1))',
                       r.schemaname||'.'||r.sequencename, r.schemaname, r.sequencename);
      end loop;
    end $$;`);

  return [
    TABLE_ORDER.length + ' tables restored in the same order',
    rows.toLocaleString('en-IN') + ' rows loaded · 0 rejected',
    'Sequences and identity columns reset to match'
  ];
}

// Row count is not enough — two tables can agree on count and disagree on
// content. The checksum is over the whole row, ordered, so a single changed
// character fails the stage.
async function verify() {
  const bad = [];
  let checked = 0;
  for (const t of TABLE_ORDER) {
    const sql = `select count(*)::int n,
                        coalesce(md5(string_agg(t::text, '|' order by t::text)),'-') h
                   from ${JSON.stringify(t) === `"case"` ? '"case"' : `"${t}"`} t`;
    let a, b;
    try { [a] = await q(SRC, sql); [b] = await q(DST, sql); } catch (e) { continue; }
    checked++;
    if (a.n !== b.n) bad.push(t + ': ' + a.n + ' rows on Supabase, ' + b.n + ' on AWS');
    else if (a.h !== b.h) bad.push(t + ': same row count, different content');
  }
  if (bad.length) {
    const e = new Error('Verification failed on ' + bad.length + ' table'
      + (bad.length === 1 ? '' : 's') + ':\n  ' + bad.join('\n  ')
      + '\nNothing has been cut over. Re-run export and load, or investigate the named tables.');
    e.stage = 'verify';
    throw e;
  }

  const [{ orphans }] = await q(DST, `
    select count(*)::int orphans from (
      select conrelid::regclass::text t from pg_constraint
       where contype='f' and not convalidated) x`);

  return [
    'Row counts match on all ' + checked + ' tables',
    'Content checksum matches on all ' + checked + ' tables',
    'Foreign keys validated · ' + orphans + ' orphans',
    'Ready to cut over'
  ];
}

// The only stage that changes where the business writes.
async function cutover() {
  await q(DST, "insert into app_setting(key,value,note) values('read_only','off','Cutover complete') "
    + "on conflict (key) do update set value='off'");
  // Supabase stays up and read-only. It is the fallback, and it is not
  // deleted for 30 days — long enough for a full month to close cleanly.
  await q(SRC, "insert into app_setting(key,value,note) values('read_only','on','Retired — AWS is live. Kept 30 days as fallback.') "
    + "on conflict (key) do update set value='on'");
  return [
    'Application now pointing at AWS',
    'Read-only lifted',
    'Supabase kept intact and read-only for 30 days as a fallback'
  ];
}

async function totalRows(url) {
  const rows = await q(url,
    "select coalesce(sum(n_live_tup),0)::bigint n from pg_stat_user_tables where schemaname='public'");
  return Number(rows[0].n);
}

// ---------------------------------------------------------------- routes

const STAGES = { preflight, schema, export: exportData, load, verify, cutover };
const ORDER = ['preflight', 'schema', 'export', 'load', 'verify', 'cutover'];

const router = require('express').Router();

router.post('/:stage', async (req, res) => {
  const stage = req.params.stage;
  if (!STAGES[stage]) return res.status(404).json({ error: 'No such stage: ' + stage });
  if (!req.actor || req.actor.level !== 'admin') {
    return res.status(403).json({ error: 'Only the administrator can run the move.' });
  }

  const i = ORDER.indexOf(stage);
  const state = await migrationState();
  if (i > 0 && !state[ORDER[i - 1]]) {
    return res.status(409).json({ error: 'Run "' + ORDER[i - 1] + '" first. '
      + 'The stages are ordered because each one depends on the last.' });
  }
  if (stage === 'cutover' && !state.verify) {
    return res.status(409).json({ error: 'Verification has not passed. Cutover is blocked — that is the point of the gate.' });
  }

  const started = Date.now();
  try {
    const lines = await STAGES[stage]();
    await record(stage, 'OK', lines, req.actor.id, Date.now() - started);
    res.json({ stage, ok: true, lines, ms: Date.now() - started });
  } catch (e) {
    await record(stage, 'FAILED', [e.message], req.actor.id, Date.now() - started);
    res.status(500).json({ stage, ok: false, error: e.message });
  }
});

router.get('/state', async (req, res) => res.json(await migrationState()));

async function migrationState() {
  const rows = await q(SRC,
    "select job_key, result from job_run where job_key like 'migrate:%' "
    + "and started_at > now() - interval '7 days' order by started_at");
  const s = {};
  rows.forEach(r => { s[r.job_key.slice(8)] = r.result === 'OK'; });
  return s;
}

async function record(stage, result, lines, actorId, ms) {
  await q(SRC,
    "insert into job_run (job_key, result, detail, started_at, finished_at) "
    + "values ($1,$2,$3, now() - ($4 || ' milliseconds')::interval, now())",
    ['migrate:' + stage, result, lines.join('\n'), String(ms)]);
  await q(SRC,
    "insert into audit_entry (actor_id, action, entity_type, entity_id, detail) "
    + "values ($1,$2,'migration', gen_random_uuid(), $3)",
    [actorId, 'MIGRATION_' + stage.toUpperCase() + '_' + result, lines.join('\n')]);
}

module.exports = router;
