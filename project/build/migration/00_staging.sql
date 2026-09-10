-- =====================================================================
-- 00 · STAGING — the 26 xlsx tabs land here verbatim, every column text.
-- Nothing is cleaned on the way in. Every later script reads only from stg
-- and writes only to the app schema, so a re-run is a truncate + reload.
-- =====================================================================
create schema if not exists stg;

-- row_no is the 1-based sheet row, so source_ref reads 'BRANCHES!4127'.
create table stg.users              (row_no int primary key, name text, email text, role text, designation text, department text, manager_email text, scope_client text, scope_zone text, scope_state text, scope_branch text, status text, access_token text, created_at text);
create table stg.clients            (row_no int primary key, code text, name text, status text, primary_email text, cc_email text, ho_email text, ho_cc_email text, zones text, notes text);
create table stg.branches           (row_no int primary key, client_code text, code text, name text, address text, zone text, state text, city text, status text, bm_name text, bm_mobile text, bm_email text, poc_email text, dublicate text, updated_at text);
create table stg.branch_assignments (row_no int primary key, user_email text, branch_code text, client_code text, role text, created_at text);
create table stg.matrix             (row_no int primary key, client_code text, branch_code text, level text, level_name text, name text, mobile text, email text, updated_by text, updated_at text);
create table stg.escalations        (row_no int primary key, ref text, client_code text, branch_code text, category text, raised_by text, against text, description text, status text, resolved_at text, strike_count text, created_at text);
create table stg.escalation_events  (row_no int primary key, ref text, at text, actor_email text, kind text, note text);
create table stg.people_events      (row_no int primary key, person_email text, at text, kind text, note text, actor_email text);
create table stg.people_events_copy (row_no int primary key, person_email text, at text, kind text, note text, actor_email text);
create table stg.audit_log          (row_no int primary key, at text, actor_email text, action text, entity_type text, entity_ref text, old_value text, new_value text);
create table stg.email_log          (row_no int primary key, at text, idempotency_key text, template_key text, recipient text, state text, error text, entity_ref text);
create table stg.job_log            (row_no int primary key, job_key text, started_at text, finished_at text, state text, note text);
create table stg.settings           (row_no int primary key, key text, value text, updated_at text);
create table stg.holidays           (row_no int primary key, holiday_date text, name text);
create table stg.warnings           (row_no int primary key, person_email text, at text, kind text, note text);
create table stg.targets            (row_no int primary key, person_email text, period text, metric text, value text);
create table stg.sheet4             (row_no int primary key, c1 text, c2 text, c3 text, c4 text, c5 text, c6 text);

-- Tabs deliberately NOT staged (audited as derived or dead):
--   PIVOT_*, DASHBOARD_CACHE, LOOKUPS, README, and the four empty report tabs.
-- Their contents are recomputed by views in schema.sql.

-- ---------------------------------------------------------------------
-- Emptiness is defined once, here. 198,890 of the 305,307 staged rows are
-- blank-but-present artefacts of appendRow(); a row is real only if its key
-- column carries a non-space character.
-- ---------------------------------------------------------------------
create or replace function stg.present(t text) returns boolean as $$
  select t is not null and btrim(t) <> '' and btrim(t) <> '#N/A' and btrim(t) <> 'null';
$$ language sql immutable;

create or replace function stg.norm_email(t text) returns text as $$
  select case when not stg.present(t) then null else
    replace(lower(btrim(t)), 'cruxinida.co.in', 'cruxindia.co.in')
  end;
$$ language sql immutable;

create or replace function stg.norm_name(t text) returns text as $$
  select case when not stg.present(t) then null else
    regexp_replace(initcap(lower(btrim(t))), '\s+', ' ', 'g') end;
$$ language sql immutable;

create or replace function stg.norm_mobile(t text) returns text as $$
  select case when not stg.present(t) then null else
    nullif(right(regexp_replace(t, '[^0-9]', '', 'g'), 10), '') end;
$$ language sql immutable;

create or replace function stg.ts(t text) returns timestamptz as $$
  select case when not stg.present(t) then null else
    (case when t ~ '^\d{4}-\d{2}-\d{2}' then t::timestamptz
          when t ~ '^\d{1,2}/\d{1,2}/\d{4}' then to_timestamp(t, 'DD/MM/YYYY HH24:MI:SS')
          else null end) end;
$$ language sql immutable;

-- run-scoped bookkeeping, so a re-run is idempotent and auditable
create table if not exists stg.run (
  id         uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  script     text,
  rows_in    int,
  rows_out   int,
  rows_logged int,
  notes      text
);
