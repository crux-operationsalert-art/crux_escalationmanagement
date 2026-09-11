-- =====================================================================
-- CRUX — libSQL / Turso migration
-- Generated from build/schema.sql by transformation, not by hand.
--
-- READ FIRST: TURSO_R2_READINESS.md
--   §2b  6 functions and 1 trigger are commented out below. They CANNOT be
--        ported. The coverage-overlap trigger is a real guarantee being lost.
--   §3   Money columns are marked /* paise */ and MUST be confirmed per column.
--        29 numeric columns, not 4. Scores are not paise.
--
-- Set this on EVERY connection or the 153 foreign keys are silently ignored:
--   PRAGMA foreign_keys = ON;
-- =====================================================================

pragma foreign_keys = on;

-- =====================================================================
-- CRUX ESCALATION MATRIX — replacement schema (PostgreSQL 15+)
-- Generated 3 Sep 2026 from the audit of the live Google Sheets datastore.
--
-- Design rules enforced here, not by convention:
--   1. Every reference is an id. No name or e-mail is ever a foreign key.
--      (583 coverage rows in the old system pointed at a misspelt domain.)
--   2. Nothing derivable is stored.
--   3. Every migrated row keeps source_ref, so it can be traced back to
--      the sheet tab and row it came from.
--   4. Duplication is made IMPOSSIBLE by constraints, not discouraged.
--      (The old system had a column literally named "Dublicate".)
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- people
create table designation (
  id            text primary key default (lower(hex(randomblob(16)))),
  title         text not null,
  desk_id       text,                      -- fk added after desk
  is_desk_head  boolean not null default false,
  seniority     int    not null default 0,
  constraint designation_title_uniq unique (title)
);

create table person (
  id                 text primary key default (lower(hex(randomblob(16)))),
  employee_no        text,
  full_name          text not null,
  work_email         text,
  personal_email     text,
  mobile             text,
  designation_id     text references designation(id),
  department         text,
  manager_id         text references person(id),
  app_role           text not null default 'VIEWER' check (app_role in ('ADMIN', 'MANAGER', 'LOCATION_HEAD', 'VIEWER')),
  employment_status  text not null default 'ACTIVE' check (employment_status in ('ACTIVE', 'INACTIVE')),
  joined_on          text /* YYYY-MM-DD */,
  left_on            text /* YYYY-MM-DD */,
  superseded_by      text references person(id),   -- identity merges, never deletes
  source_ref         text,
  created_at         text not null default now(),
  updated_at         text not null default now()
);
-- the constraint that would have prevented the cruxinida.co.in twin:
create unique index person_work_email_uniq
  on person (lower(work_email))
  where employment_status = 'ACTIVE' and superseded_by is null and work_email is not null;
create unique index person_employee_no_uniq
  on person (employee_no) where employee_no is not null;

create table desk (
  id                text primary key default (lower(hex(randomblob(16)))),
  name              text not null unique,
  primary_person_id text references person(id),
  escalation_only   boolean not null default false,   -- MD office
  fallback_desk_id  text references desk(id),
  constraint desk_primary_or_fallback check (primary_person_id is not null or fallback_desk_id is not null)
);
alter table designation add constraint designation_desk_fk foreign key (desk_id) references desk(id);

-- ------------------------------------------------------------- geography
create table geo_node (
  id        text primary key default (lower(hex(randomblob(16)))),
  parent_id text references geo_node(id),
  level     text not null check (level in ('ZONE', 'STATE', 'CITY')),
  name      text not null
);
-- collapses "Goa" and "GOA", and the 36 mixed Zone values of the old sheet
create unique index geo_node_sibling_uniq on geo_node (coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::text), lower(name));

-- --------------------------------------------------------------- clients
create table client (
  id             text primary key default (lower(hex(randomblob(16)))),
  code           text not null,
  name           text not null,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  effective_from text /* YYYY-MM-DD */,
  effective_to   text /* YYYY-MM-DD */,
  notes          text,
  source_ref     text,
  created_at     text not null default now(),
  updated_at     text not null default now(),
  constraint client_code_uniq unique (code)
);

create table client_contact (
  id         text primary key default (lower(hex(randomblob(16)))),
  client_id  text not null references client(id) on delete cascade,
  kind       text not null,             -- 'PRIMARY' | 'CC' | 'HEAD_OFFICE' | 'HEAD_OFFICE_CC'
  name       text,
  email      text not null,
  mobile     text,
  constraint client_contact_uniq unique (client_id, kind, lower(email))
);

create table client_zone (
  id          text primary key default (lower(hex(randomblob(16)))),
  client_id   text not null references client(id) on delete cascade,
  name        text not null,            -- the client's own vocabulary
  geo_node_id text references geo_node(id),
  constraint client_zone_uniq unique (client_id, lower(name))
);

create table branch (
  id             text primary key default (lower(hex(randomblob(16)))),
  client_id      text not null references client(id),
  code           text not null,
  name           text not null,
  address        text,
  geo_node_id    text references geo_node(id),
  client_zone_id text references client_zone(id),
  status         text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  effective_from text /* YYYY-MM-DD */,
  effective_to   text /* YYYY-MM-DD */,
  notes          text,
  source_ref     text,
  created_at     text not null default now(),
  updated_at     text not null default now(),
  constraint branch_code_uniq unique (client_id, code)   -- 217 old branches had no code
);
create index branch_client_status_idx on branch (client_id, status);

create table branch_contact (
  id        text primary key default (lower(hex(randomblob(16)))),
  branch_id text not null references branch(id) on delete cascade,
  role      text not null,              -- 'BRANCH_MANAGER' | 'CRUX_POC'
  person_id text references person(id), -- internal people are referenced
  name      text,                       -- external contacts are stored
  mobile    text,
  email     text,
  active    boolean not null default true,
  constraint branch_contact_identified check (person_id is not null or name is not null)
);
create unique index branch_contact_one_active on branch_contact (branch_id, role) where active;

-- ---------------------------------------------------------------- matrix
create table matrix_contact (
  id         text primary key default (lower(hex(randomblob(16)))),
  client_id  text not null references client(id),
  branch_id  text references branch(id) on delete cascade,  -- null = client-level matrix
  level      int  not null check (level between 1 and 5),
  level_name text not null,
  person_id  text references person(id),
  name       text,
  mobile     text,
  email      text,
  updated_by text references person(id),
  updated_at text not null default now(),
  source_ref text
);
create unique index matrix_branch_level_uniq on matrix_contact (branch_id, level) where branch_id is not null;
create unique index matrix_client_level_uniq on matrix_contact (client_id, level) where branch_id is null;

-- completeness, computed — never stored (rule R-01)
create view branch_matrix_state as
select b.id as branch_id,
       b.client_id,
       count(*) filter (
         where m.name is not null and btrim(m.name) <> ''
           and (coalesce(btrim(m.mobile),'') <> '' or coalesce(btrim(m.email),'') <> '')
       ) as complete_levels
from branch b
left join matrix_contact m on m.branch_id = b.id
group by b.id, b.client_id;

create view dispatch_eligible_branch as
select b.id as branch_id, b.client_id
from branch b
join branch_matrix_state s on s.branch_id = b.id
join client c on c.id = b.client_id
where b.status = 'ACTIVE' and c.status = 'ACTIVE' and s.complete_levels = 5;

-- -------------------------------------------------------------- coverage
create table coverage_rule (
  id             text primary key default (lower(hex(randomblob(16)))),
  person_id      text not null references person(id),
  role           text not null,          -- LOCATION_HEAD | BRANCH_MANAGER | ZONAL_MANAGER
  scope_type     text not null check (scope_type in ('CLIENT', 'CLIENT_ZONE', 'STATE', 'BRANCH')),
  client_id      text references client(id),
  client_zone_id text references client_zone(id),
  geo_node_id    text references geo_node(id),
  branch_id      text references branch(id),
  effective_from text /* YYYY-MM-DD */ not null default current_date,
  effective_to   text /* YYYY-MM-DD */,
  source_ref     text,
  created_at     text not null default now(),
  constraint coverage_scope_shape check (
    (scope_type = 'CLIENT'      and client_id is not null and client_zone_id is null and geo_node_id is null and branch_id is null) or
    (scope_type = 'CLIENT_ZONE' and client_zone_id is not null and branch_id is null) or
    (scope_type = 'STATE'       and client_id is not null and geo_node_id is not null and branch_id is null) or
    (scope_type = 'BRANCH'      and branch_id is not null)
  )
);

-- rule R-07: overlapping ownership cannot be created. The resolved branch set
-- of a candidate rule must not intersect an existing active rule for the same
-- (person, role). Enforced by trigger because the scope is relational.
-- ===== NOT PORTABLE: function coverage_resolve =====
-- SQLite/libSQL has no stored functions. Reimplement in the API.
-- See TURSO_R2_READINESS.md §2b.
-- create or replace function coverage_resolve(p_rule coverage_rule) returns setof text as $$
--   select b.id from branch b
--   left join client_zone cz on cz.id = b.client_zone_id
--   where case p_rule.scope_type
--     when 'CLIENT'      then b.client_id = p_rule.client_id
--     when 'CLIENT_ZONE' then b.client_zone_id = p_rule.client_zone_id
--     when 'STATE'       then b.client_id = p_rule.client_id and b.geo_node_id in (
--                               with recursive t as (
--                                 select id from geo_node where id = p_rule.geo_node_id
--                                 union all select g.id from geo_node g join t on g.parent_id = t.id
--                               ) select id from t)
--     when 'BRANCH'      then b.id = p_rule.branch_id
--   end;
-- $$ language sql stable;

-- ===== NOT PORTABLE: function coverage_no_overlap =====
-- SQLite/libSQL has no stored functions. Reimplement in the API.
-- See TURSO_R2_READINESS.md §2b.
-- create or replace function coverage_no_overlap() returns trigger as $$
-- declare clash record;
-- begin
--   select r.id, r.scope_type, count(*) as n into clash
--   from coverage_rule r
--   where r.person_id = new.person_id and r.role = new.role and r.id <> new.id
--     and (r.effective_to is null or r.effective_to >= current_date)
--   cross join lateral (select 1 from coverage_resolve(r) x where x in (select coverage_resolve(new))) hit
--   group by r.id, r.scope_type
--   limit 1;
--   if clash.id is not null then
--     raise exception 'coverage overlap: % branches already covered by rule % (%)', clash.n, clash.id, clash.scope_type
--       using errcode = 'check_violation';
--   end if;
--   return new;
-- end;
-- $$ language plpgsql;

-- ===== NOT PORTABLE: trigger =====
-- This enforced "overlaps refused at write time, by the database".
-- On libSQL it MUST be reimplemented inside the write transaction of every
-- caller (API, bulk upload, migration seeding) plus a nightly integrity scan.
-- See TURSO_R2_READINESS.md §2b and §7.
-- create trigger coverage_rule_no_overlap
--   before insert or update on coverage_rule
--   for each row execute function coverage_no_overlap();

-- ----------------------------------------------------------------- cases
create table category (
  id          text primary key default (lower(hex(randomblob(16)))),
  name        text not null unique,
  desk_id     text not null references desk(id),
  pinned      boolean not null default false,  -- Fraud/Integrity, Data Privacy
  chase_hours int,                             -- null = use the global clock
  active      boolean not null default true
);

create table "case" (
  id                text primary key default (lower(hex(randomblob(16)))),
  ref               text not null unique,
  client_id         text not null references client(id),
  branch_id         text references branch(id),
  category_id       text not null references category(id),
  raised_by         text not null references person(id),
  against_person_id text references person(id),
  against_text      text,
  description       text,
  owner_person_id   text references person(id),
  desk_id           text references desk(id),
  status            text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'BLOCKED')),
  resolution_note   text,
  resolved_at       text,
  auto_close_at     text,             -- resolved_at + 7 days (rule R-05)
  next_chase_at     text,             -- scheduled, never swept (rule R-03)
  strike_count      int not null default 0,
  last_activity_at  text not null default now(),
  closed_at         text,
  source_ref        text,
  created_at        text not null default now(),
  -- a case can never be ownerless: it is owned, or explicitly BLOCKED and visible
  constraint case_has_owner check (owner_person_id is not null or desk_id is not null or status = 'BLOCKED')
);
create index case_open_chase_idx on "case" (next_chase_at) where status in ('OPEN','IN_PROGRESS');
create index case_autoclose_idx  on "case" (auto_close_at) where status = 'RESOLVED';

create table case_event (
  id         text primary key default (lower(hex(randomblob(16)))),
  case_id    text not null references "case"(id) on delete cascade,
  at         text not null default now(),
  actor_id   text references person(id),
  field      text,
  old_value  text,
  new_value  text,
  note       text
);
create index case_event_case_idx on case_event (case_id, at);

-- ------------------------------------------------------------------ mail
create table template (
  id         text primary key default (lower(hex(randomblob(16)))),
  key        text not null,
  version    int  not null default 1,
  subject    text not null,
  body       text not null,
  updated_by text references person(id),
  updated_at text not null default now(),
  constraint template_key_version_uniq unique (key, version)
);

-- THE constraint. 77 idempotency keys produced 1,892 sends in the old system
-- because uniqueness was a convention rather than a rule.
create table outbox (
  id              text primary key default (lower(hex(randomblob(16)))),
  idempotency_key text not null,
  kind            text not null,
  entity_type     text,
  entity_id       text,
  to_addr         text not null,
  cc_addr         text,
  subject         text not null,
  body            text not null,
  state           text not null default 'QUEUED' check (state in ('QUEUED', 'SENT', 'DEFERRED', 'ABANDONED')),
  attempts        int not null default 0,
  not_before      text not null default now(),
  sent_at         text,
  last_error      text,
  created_at      text not null default now(),
  constraint outbox_idempotency_uniq unique (idempotency_key)
);
create index outbox_due_idx on outbox (not_before) where state = 'QUEUED';

create table delivery (
  id           text primary key default (lower(hex(randomblob(16)))),
  outbox_id    text references outbox(id),
  to_addr      text not null,
  state        text not null,
  at           text not null default now(),
  provider_ref text,
  entity_type  text,
  entity_id    text
);
create index delivery_entity_idx on delivery (entity_type, entity_id, at);

create table mail_budget (
  day            text /* YYYY-MM-DD */ primary key,
  recipients_sent int not null default 0,
  cap            int not null default 1800,
  reserve        int not null default 200
);

-- ------------------------------------------------------------------ jobs
create table job_run (
  id          text primary key default (lower(hex(randomblob(16)))),
  job_key     text not null,
  started_at  text not null default now(),
  finished_at text,
  result      text check (result in ('OK', 'NOOP', 'FAILED')),
  counts      text,
  error       text,
  next_due_at text
);
create index job_run_key_idx on job_run (job_key, started_at desc);

-- a job may be disabled only with a reason, and it is visible (no silent pause)
create table job_config (
  job_key      text primary key,
  enabled      boolean not null default true,
  cron         text not null,
  disabled_by  text references person(id),
  disabled_at  text,
  reason       text,
  constraint job_disable_needs_reason check (enabled or (reason is not null and disabled_by is not null))
);

-- --------------------------------------------------------------- windows
create table submission_window (
  id         text primary key default (lower(hex(randomblob(16)))),
  kind       text not null,
  person_id  text not null references person(id),
  period     text not null,               -- 'YYYY-MM'
  state      text not null,               -- OPEN | CLOSED
  opened_by  text references person(id),
  opened_at  text,
  closes_at  text,
  reason     text,
  constraint submission_window_uniq unique (kind, person_id, period)
);

-- ------------------------------------------------------- people workflow
create table person_event (
  id         text primary key default (lower(hex(randomblob(16)))),
  person_id  text not null references person(id),
  type       text not null check (type in ('NOTE', 'APPRECIATION', 'WARNING', 'PIP', 'ACTIVATION')),
  at         text not null default now(),
  start_on   text /* YYYY-MM-DD */,
  end_on     text /* YYYY-MM-DD */,
  note       text,
  issued_by  text references person(id),
  status     text,
  outcome    text,
  case_id    text references "case"(id),
  source_ref text                          -- the 449 rescued notes keep this
);
create index person_event_person_idx on person_event (person_id, at desc);

create table target (
  id         text primary key default (lower(hex(randomblob(16)))),
  person_id  text not null references person(id),
  period     text not null,
  category   text,
  sub_category text,
  client_id  text references client(id),
  target_value real        -- a KPI value may be a count, a percentage or rupees; the unit column says which. REAL avoids lying about precision. DEFAULT.
  -- was: ,
  achieved_value real        -- a KPI value may be a count, a percentage or rupees; the unit column says which. REAL avoids lying about precision. DEFAULT.
  -- was: ,
  notes      text,
  updated_by text references person(id),
  updated_at text not null default now(),
  constraint target_uniq unique (person_id, period, category, sub_category)
);

-- ----------------------------------------------------------------- audit
create table audit_entry (
  id          text primary key default (lower(hex(randomblob(16)))),
  at          text not null default now(),
  actor_id    text references person(id),
  action      text not null,
  entity_type text not null,
  entity_id   text,
  old_value   text,
  new_value   text
);
create index audit_entity_idx on audit_entry (entity_type, entity_id, at desc);
create index audit_actor_idx  on audit_entry (actor_id, at desc);
-- NOTE: machine retries do NOT belong here. In the old system EMAIL_RETRY was
-- the single largest action (1,740 of 5,913). Retries live in outbox/job_run.

-- ------------------------------------------------------------- migration
create table migration_merge (
  id           text primary key default (lower(hex(randomblob(16)))),
  at           text not null default now(),
  entity_type  text not null,
  kept_id      text not null,
  merged_id    text,
  merged_key   text,
  rows_moved   int,
  rule         text not null,
  reviewed_by  text references person(id),
  reviewed_at  text
);

create table auth_session (
  id           text primary key default (lower(hex(randomblob(16)))),
  person_id    text not null references person(id),
  created_at   text not null default now(),
  last_seen_at text,
  expires_at   text not null,
  source       text,
  revoked_at   text,
  revoked_by   text references person(id)
);
create index auth_session_person_idx on auth_session (person_id) where revoked_at is null;

create table portal_link (
  id         text primary key default (lower(hex(randomblob(16)))),
  client_id  text references client(id),
  branch_id  text references branch(id),
  token_hash text not null unique,   -- only the hash is stored
  created_at text not null default now(),
  rotated_at text,
  revoked_at text,
  constraint portal_link_target check (client_id is not null or branch_id is not null)
);


-- =====================================================================
-- v2 ADDITIONS — organisation structure, daily counts, penalty engine
-- Added 3 Sep 2026 from the attached operating structure (70 chairs,
-- 188 owned processes, 14 functions) and the review comments.
-- =====================================================================

-- ------------------------------------------------- chairs and the RACI map
-- A chair is a seat in the operating structure. A person occupies a chair;
-- ownership and routing resolve through the chair, never through a name.
create table chair (
  id            text primary key default (lower(hex(randomblob(16)))),
  code          text not null unique,          -- e.g. 'BM_P', 'RM_W', 'HRH'
  title         text not null,
  desk_id       text references desk(id),
  parent_id     text references chair(id),     -- reporting line between chairs
  level         text not null,                 -- board|function|national|region|branch|executive|partner
  reports_daily boolean not null default false -- does this chair file a daily count
);

create table chair_holder (
  id         text primary key default (lower(hex(randomblob(16)))),
  chair_id   text not null references chair(id),
  person_id  text not null references person(id),
  is_primary boolean not null default false,   -- breaks the two-people-one-title tie
  from_date  text /* YYYY-MM-DD */ not null default current_date,
  to_date    text /* YYYY-MM-DD */
);
create unique index chair_one_primary on chair_holder (chair_id) where is_primary and to_date is null;

create table process (
  id        text primary key default (lower(hex(randomblob(16)))),
  ref       text not null unique,              -- 'R1', 'S12' …
  function  text not null,                     -- one of the 14 functions
  name      text not null,
  owner_chair_id text not null references chair(id)
);

create table process_party (
  process_id text not null references process(id) on delete cascade,
  chair_id   text not null references chair(id),
  part       text not null,                    -- DOES | ADVISES | INFORMED
  primary key (process_id, chair_id, part)
);

create table process_input (
  id         text primary key default (lower(hex(randomblob(16)))),
  process_id text not null references process(id) on delete cascade,
  what       text not null,
  from_chair_id text not null references chair(id)
);

-- ------------------------------------------------------------ daily counts
create table kpi_definition (
  id         text primary key default (lower(hex(randomblob(16)))),
  chair_id   text references chair(id),
  person_id  text references person(id),
  name       text not null,
  unit       text,
  active     boolean not null default true,
  constraint kpi_scope check (chair_id is not null or person_id is not null)
);

-- the target is set BY THE MANAGER and is read-only to the holder
create table kpi_target (
  id            text primary key default (lower(hex(randomblob(16)))),
  kpi_id        text not null references kpi_definition(id),
  person_id     text not null references person(id),
  period        text not null,                 -- 'YYYY-MM'
  target_value  real        -- a KPI value may be a count, a percentage or rupees; the unit column says which. REAL avoids lying about precision. DEFAULT.
  -- was: not null,
  set_by        text not null references person(id),
  set_at        text not null default now(),
  constraint kpi_target_uniq unique (kpi_id, person_id, period),
  constraint kpi_target_not_self check (set_by <> person_id)   -- you cannot set your own target
);

create table daily_count (
  id           text primary key default (lower(hex(randomblob(16)))),
  person_id    text not null references person(id),
  count_date   text /* YYYY-MM-DD */ not null,
  kpi_id       text not null references kpi_definition(id),
  value        real        -- a KPI value may be a count, a percentage or rupees; the unit column says which. REAL avoids lying about precision. DEFAULT.
  -- was: not null,
  submitted_at text not null default now(),
  locked_at    text,                    -- set when the 23:59 window closes
  reopened_by  text references person(id),
  reopen_reason text,
  constraint daily_count_uniq unique (person_id, count_date, kpi_id),
  constraint daily_reopen_needs_reason check (reopened_by is null or reopen_reason is not null)
);
create index daily_count_date_idx on daily_count (count_date, person_id);

-- ---------------------------------------------------------- penalty engine
-- Admin-editable: action, who, how often, cutoff, amount, who recovers.
create table penalty_rule (
  id            text primary key default (lower(hex(randomblob(16)))),
  code          text not null unique,          -- 'P-01' …
  what          text not null,
  plain_language text not null,                -- shown in the UI verbatim
  applies_to    text not null,                 -- chair code, department, or ALL
  frequency     text not null,                 -- DAILY | MONTHLY | PER_EVENT | WEEKLY
  cutoff_spec   text not null,                 -- '23:59' | '3rd 18:00' | '48 working hours'
  amount        integer        -- paise. Divide by 100 only at display. DEFAULT: change only if this is not money.
  -- was: not null,
  recovered_by  text not null,                 -- HR | FINANCE
  active        boolean not null default true,
  effective_from text /* YYYY-MM-DD */ not null default current_date,
  created_by    text references person(id)
);

create table penalty_instance (
  id            text primary key default (lower(hex(randomblob(16)))),
  rule_id       text not null references penalty_rule(id),
  person_id     text not null references person(id),
  period        text not null,
  occurred_on   text /* YYYY-MM-DD */ not null,
  cutoff_missed text not null,
  evidence      text not null,                 -- what proves it: 'no daily_count for 2026-09-01'
  entity_type   text,                          -- 'case' | 'branch' | 'kpi_target' …
  entity_id     text,
  amount        integer        -- paise. Divide by 100 only at display. DEFAULT: change only if this is not money.
  -- was: not null,              -- copied from the rule at firing time
  state         text not null default 'APPLIED' check (state in ('PENDING', 'APPLIED', 'WAIVED', 'DISPUTED', 'REVERSED')),
  waived_by     text references person(id),
  waive_reason  text,
  recovered_by  text not null,
  recovered_at  text,
  created_at    text not null default now(),
  constraint penalty_no_duplicate unique (rule_id, person_id, occurred_on, entity_id),
  constraint penalty_waiver_needs_reason check (state <> 'WAIVED' or (waived_by is not null and waive_reason is not null)),
  constraint penalty_amount_frozen check (amount >= 0)  -- a later rule change never rewrites history
);
create index penalty_person_period_idx on penalty_instance (person_id, period);
create index penalty_recovery_idx on penalty_instance (recovered_by, state, period);

-- --------------------------------------------- escalation parties + actions
-- Who may do what on an escalation depends on the part they play, not on
-- their app role. The action set in the UI is generated from this table.
create table escalation_party (
  case_id   text not null references "case"(id) on delete cascade,
  person_id text not null references person(id),
  part      text not null check (part in ('RAISER', 'RESPONDENT', 'MANAGER', 'DESK', 'HR', 'ADMIN', 'INFORMED')),
  primary key (case_id, person_id, part)
);

create table escalation_action (
  id            text primary key default (lower(hex(randomblob(16)))),
  code          text not null unique,
  label         text not null,
  allowed_part  text not null check (allowed_part in ('RAISER', 'RESPONDENT', 'MANAGER', 'DESK', 'HR', 'ADMIN', 'INFORMED')),
  pms_impact    boolean not null,              -- does it count in the performance score
  unlock_after_working_days int,               -- 'escalate' unlocks at 7
  sets_tat_hours int,                          -- 'needs immediate action' sets 24
  routes_to     text                            -- 'RAISER_MANAGER+HR' for dispute
);

create table escalation_action_log (
  id         text primary key default (lower(hex(randomblob(16)))),
  case_id    text not null references "case"(id),
  action_id  text not null references escalation_action(id),
  actor_id   text not null references person(id),
  at         text not null default now(),
  note       text
);

-- warning and notice letters, issuable by managers and upper management
create table letter (
  id          text primary key default (lower(hex(randomblob(16)))),
  kind        text not null,                   -- WARNING | NOTICE | APPRECIATION
  person_id   text not null references person(id),
  case_id     text references "case"(id),
  issued_by   text not null references person(id),
  issued_at   text not null default now(),
  body        text not null,
  acknowledged_at text,
  due_ack_at  text not null,            -- 72 hours; rule P-07 fires after
  -- MANUAL: copied_to was text[]. Create a child table; do NOT store a delimited string.
  -- copied_to   text[]                            -- HR and MD office by default
);

-- ------------------------------------------------- people joining approval
create table person_request (
  id            text primary key default (lower(hex(randomblob(16)))),
  full_name     text not null,
  work_email    text not null,
  chair_id      text not null references chair(id),
  manager_id    text not null references person(id),
  requested_by  text not null references person(id),
  requested_at  text not null default now(),
  state         text not null default 'AWAITING_HR' check (state in ('DRAFT', 'AWAITING_HR', 'AWAITING_ADMIN', 'ACTIVE', 'REJECTED')),
  hr_by         text references person(id),
  hr_at         text,
  admin_by      text references person(id),
  admin_at      text,
  reject_reason text,
  person_id     text references person(id),    -- filled when the account is created
  constraint person_request_reject_reason check (state <> 'REJECTED' or reject_reason is not null)
);

-- ------------------------------------ client-level default matrix inheritance
-- A branch with no matrix rows of its own uses its client's default set, so a
-- new branch is dispatchable from the day it is created.
create view branch_effective_matrix as
select b.id as branch_id, m.level, m.level_name, m.name, m.mobile, m.email, false as inherited
from branch b join matrix_contact m on m.branch_id = b.id
union all
select b.id, m.level, m.level_name, m.name, m.mobile, m.email, true as inherited
from branch b
join matrix_contact m on m.client_id = b.client_id and m.branch_id is null
where not exists (select 1 from matrix_contact x where x.branch_id = b.id);

create or replace view dispatch_eligible_branch_v2 as
select b.id as branch_id, b.client_id,
       bool_or(e.inherited) as using_client_default
from branch b
join client c on c.id = b.client_id
join branch_effective_matrix e on e.branch_id = b.id
where b.status = 'ACTIVE' and c.status = 'ACTIVE'
group by b.id, b.client_id
having count(*) filter (
         where e.name is not null and btrim(e.name) <> ''
           and (coalesce(btrim(e.mobile),'') <> '' or coalesce(btrim(e.email),'') <> '')
       ) = 5;

-- ------------------------------------------------------ client visibility
-- HR sees no client data; Operations owns the matrix; the money and
-- compliance functions get branch details and contacts only.
create table client_view_policy (
  department text primary key,
  view_kind  text not null check (view_kind in ('matrix','contacts','none'))
);
insert into client_view_policy (department, view_kind) values
  ('Operations','matrix'), ('Technology','matrix'),
  ('Finance & Accounts','contacts'), ('Business Development','contacts'),
  ('Compliance & Assurance','contacts'),
  ('Human Resources','none'), ('MIS','none');

-- ------------------------------------------------------------ push devices
create table push_subscription (
  id         text primary key default (lower(hex(randomblob(16)))),
  person_id  text not null references person(id),
  endpoint   text not null unique,
  keys       text not null,
  created_at text not null default now(),
  revoked_at text
);

create table notification (
  id         text primary key default (lower(hex(randomblob(16)))),
  person_id  text not null references person(id),
  kind       text not null,
  text       text not null,
  entity_type text,
  entity_id  text,
  push       boolean not null default false,   -- deadline-bearing items are pushed
  at         text not null default now(),
  read_at    text
);
create index notification_person_idx on notification (person_id, at desc);


-- =====================================================================
-- Decisions of 3 Sep 2026
-- =====================================================================

-- 1 · Audit/Quality routes to Operations, not Compliance.
--    (Applied as data: category.desk_id → Operations. Fraud/Integrity and
--     Data Privacy keep pinned = true on Compliance.)

-- 2 · Geography: Maharashtra resolves to three cities; Indore-MPCG splits.
--    Cities under West → Maharashtra: Mumbai, Pune, Rest of Maharashtra.
--    Indore-MPCG becomes Central → Madhya Pradesh and Central → Chhattisgarh;
--    affected branches go to a review queue rather than being guessed.
create table migration_review (
  id          text primary key default (lower(hex(randomblob(16)))),
  entity_type text not null,
  entity_ref  text not null,          -- e.g. 'BRANCHES!4127'
  question    text not null,          -- 'Madhya Pradesh or Chhattisgarh?'
  context     text,                   -- the address as held in the sheet
  resolved_to text,
  resolved_by text references person(id),
  resolved_at text
);

-- 3 · Penalty rules are owned by Administrator, HR and Finance. No approval step.
-- ===== NOT PORTABLE: function may_edit_penalty_rule =====
-- SQLite/libSQL has no stored functions. Reimplement in the API.
-- See TURSO_R2_READINESS.md §2b.
-- create or replace function may_edit_penalty_rule(p_person text) returns boolean as $$
--   select coalesce(
--     (select department in ('Human Resources','Finance & Accounts') or app_role = 'ADMIN'
--      from person where id = p_person), false);
-- $$ language sql stable;

-- 4 · Franchise partners are in scope for penalties and daily counts.
-- MANUAL: penalty_rule.applies_to_list was text[] (multi-select audience).
-- A child table, not a delimited string — a string here is how the old
-- datastore ended up with CSV inside cells, and it cannot be joined or indexed.
create table penalty_rule_audience (
  penalty_rule_id text not null references penalty_rule(id) on delete cascade,
  audience        text not null
                  check (audience in ('Everybody','Department','Chair','Managers with reportees',
                                      'Executives','Team Leaders','Branch Managers',
                                      'Regional Managers','Franchise Partners','Interns')),
  audience_ref    text,   -- the department or chair id when audience is Department or Chair
  primary key (penalty_rule_id, audience)
);
-- Seed the existing default so behaviour is unchanged on migration:
--   insert into penalty_rule_audience (penalty_rule_id, audience)
--   select id, 'Everybody' from penalty_rule;
-- NOTE column penalty_rule.applies_to_list: Multi-select: Everybody | a department | a named chair | Managers with reportees | Executives | Team Leaders | Branch Managers | Regional Managers | Franchise Partners | Interns

-- partners are billed by Finance; employees are recovered through payroll by HR
-- ===== NOT PORTABLE: function penalty_recovery_for =====
-- SQLite/libSQL has no stored functions. Reimplement in the API.
-- See TURSO_R2_READINESS.md §2b.
-- create or replace function penalty_recovery_for(p_person text, p_rule text) returns text as $$
--   select case when (select employee_type from person where id = p_person) = 'PARTNER'
--               then 'FINANCE'
--               else (select recovered_by from penalty_rule where id = p_rule) end;
-- $$ language sql stable;


-- =====================================================================
-- v2.1 — PMS, tasks, attributes, requests, visits & claims, ideathon
-- Added 3 Sep 2026 from the second review round.
-- =====================================================================

-- ------------------------------------------------------------ KPI structure
-- 5 KPIs per person: 3 mandatory, 2 optional. Sub-categories are whatever the
-- manager needs — client, location, product — so the target can be split.
alter table kpi_definition add column mandatory boolean not null default true;
alter table kpi_definition add column position  int not null default 1;
alter table kpi_definition add column parent_id text references kpi_definition(id);   -- sub-category

alter table kpi_target
  add column parent_target_id text references kpi_target(id); -- sub-category target

-- optional gate: miss it and either lose points or take a fixed default score
create table kpi_eligibility (
  id            text primary key default (lower(hex(randomblob(16)))),
  kpi_id        text references kpi_definition(id),
  person_id     text references person(id),
  chair_id      text references chair(id),
  scope_all     boolean not null default false,   -- admin may set it for everybody
  gate          text not null,                    -- 'TAT >= 85%'
  on_miss       text not null check (on_miss in ('DEDUCT','DEFAULT_SCORE')),
  deduct_points integer        -- whole points, not paise. DEFAULT.
  -- was: ,
  default_score real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: ,
  set_by        text references person(id),
  constraint kpi_elig_effect check (
    (on_miss = 'DEDUCT' and deduct_points is not null) or
    (on_miss = 'DEFAULT_SCORE' and default_score is not null))
);

-- ------------------------------------------- tasks (Attributes, not KPIs)
create table task (
  id           text primary key default (lower(hex(randomblob(16)))),
  person_id    text not null references person(id),
  assigned_by  text not null references person(id),
  title        text not null,
  detail       text,
  due_on       text /* YYYY-MM-DD */,
  period       text not null,
  status       text not null default 'OPEN',
  outcome      text,
  attribute_weight real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: ,        -- how much it counts inside Attributes
  closed_at    text,
  created_at   text not null default now()
);
create index task_person_period_idx on task (person_id, period);

-- daily free-text note; the assistant files it as an Attribute or as FYI
create table daily_note (
  id            text primary key default (lower(hex(randomblob(16)))),
  person_id     text not null references person(id),
  note_date     text /* YYYY-MM-DD */ not null,
  body          text not null,
  classification text not null default 'UNCLASSIFIED' check (classification in ('UNCLASSIFIED', 'ATTRIBUTE', 'FYI')),
  attribute_heading text,
  model_reason  text,
  classified_at text,
  included_in_review boolean not null default true
);
create index daily_note_person_idx on daily_note (person_id, note_date);

-- ------------------------------------------------------------- PMS scoring
create table pms_weighting (
  id            text primary key default (lower(hex(randomblob(16)))),
  scope_all     boolean not null default false,
  chair_id      text references chair(id),
  person_id     text references person(id),
  kpi_percent   real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: not null,
  attr_percent  real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: not null,
  effective_from text /* YYYY-MM-DD */ not null default current_date,
  set_by        text references person(id),
  constraint pms_weight_sums check (kpi_percent + attr_percent = 100)
);

-- impact of an escalation, warning or appreciation on the score — configured,
-- never hard-coded, and owned jointly by Admin and HR
create table pms_impact (
  kind        text primary key check (kind in ('ESCALATION', 'WARNING', 'APPRECIATION', 'ASSISTANCE')),
  points      integer        -- whole points, not paise. DEFAULT.
  -- was: not null,
  applies_to  text not null default 'PERSON_CONCERNED',
  set_by      text references person(id),
  updated_at  text not null default now()
);

create table pms_score (
  id            text primary key default (lower(hex(randomblob(16)))),
  person_id     text not null references person(id),
  period        text not null,
  kpi_score     real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: ,
  attr_score    real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: ,
  final_score   real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: ,
  manager_score real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: check (manager_score between 1 and 10),
  manager_note  text,
  review_summary text,               -- built from tasks, notes, appreciations
  scored_by     text references person(id),
  scored_at     text,
  hr_closed_by  text references person(id),
  hr_closed_at  text,
  constraint pms_score_uniq unique (person_id, period)
);

-- ------------------------------------------------- raisables and requests
-- One table behind four buttons: escalation, warning, appreciation, assistance.
create table raisable (
  id            text primary key default (lower(hex(randomblob(16)))),
  kind          text not null check (kind in ('ESCALATION', 'WARNING', 'APPRECIATION', 'ASSISTANCE')),
  ref           text not null unique,
  raised_by     text not null references person(id),
  about_person  text references person(id),
  department    text,                          -- for an assistance request
  case_id       text references "case"(id),    -- escalations reuse the case row
  body          text,
  auto_source   text,                          -- 'STRIKE_3' when the system raised it
  pms_points    integer        -- whole points, not paise. DEFAULT.
  -- was: ,                       -- copied from pms_impact at raise time
  created_at    text not null default now()
);

-- an assistance request becomes a task on the responder; if it is not actioned
-- the three-strike policy raises an escalation against them automatically
create table request_task (
  id            text primary key default (lower(hex(randomblob(16)))),
  raisable_id   text not null references raisable(id),
  responder_id  text not null references person(id),
  due_at        text not null,
  actioned_at   text,
  strike_count  int not null default 0,
  escalated_case_id text references "case"(id)
);
create index request_task_due_idx on request_task (due_at) where actioned_at is null;

-- ---------------------------------------------------------- visits & claims
-- The visit form differs per department, so the fields are configuration.
create table visit_form_field (
  id          text primary key default (lower(hex(randomblob(16)))),
  department  text not null,
  position    int not null,
  label       text not null,
  field_type  text not null default 'text',
  required    boolean not null default true
);

create table visit (
  id          text primary key default (lower(hex(randomblob(16)))),
  person_id   text not null references person(id),
  visited_on  text /* YYYY-MM-DD */ not null,
  branch_id   text references branch(id),
  client_id   text references client(id),
  purpose     text,
  answers     text not null default '{}',
  created_at  text not null default now()
);

create table claim (
  id            text primary key default (lower(hex(randomblob(16)))),
  ref           text not null unique,
  visit_id      text references visit(id),
  person_id     text not null references person(id),
  amount        integer        -- paise. Divide by 100 only at display. DEFAULT: change only if this is not money.
  -- was: not null,
  stage         text not null default 'DRAFT' check (stage in ('DRAFT', 'OPS_APPROVAL', 'HR_APPROVAL', 'ACCOUNTS', 'DISPUTED', 'PAID', 'REJECTED')),
  ops_by        text references person(id),
  ops_at        text,
  hr_by         text references person(id),
  hr_at         text,
  accounts_by   text references person(id),
  accounts_at   text,
  paid_ref      text,                       -- UTR / payment reference
  dispute_reason text,
  created_at    text not null default now(),
  constraint claim_dispute_reason check (stage <> 'DISPUTED' or dispute_reason is not null),
  constraint claim_paid_ref check (stage <> 'PAID' or paid_ref is not null)
);
create index claim_stage_idx on claim (stage);

-- ---------------------------------------------------------------- ideathon
create table idea (
  id           text primary key default (lower(hex(randomblob(16)))),
  ref          text not null unique,
  title        text not null,
  body         text not null,
  raised_by    text not null references person(id),
  stage        text not null default 'SUBMITTED' check (stage in ('SUBMITTED', 'IN_REVIEW', 'ACCEPTED', 'INITIATED', 'ON_HOLD', 'REJECTED', 'DELIVERED')),
  sponsor_id   text references person(id),
  owner_dept   text,
  charter      text,
  decided_by   text references person(id),
  decided_at   text,
  decision_reason text,
  created_at   text not null default now(),
  constraint idea_decision_reason check (stage not in ('REJECTED','ON_HOLD') or decision_reason is not null)
);

create table idea_collaborator (
  idea_id   text not null references idea(id) on delete cascade,
  person_id text not null references person(id),
  role      text not null default 'COLLABORATOR',
  primary key (idea_id, person_id)
);

-- --------------------------------------------------------- HR (not payroll)
create table onboarding (
  id           text primary key default (lower(hex(randomblob(16)))),
  person_request_id text references person_request(id),
  person_id    text references person(id),
  induction_on text /* YYYY-MM-DD */,
  buddy_id     text references person(id),
  documents_ok boolean not null default false,
  completed_at text
);

create table pulse_response (
  id         text primary key default (lower(hex(randomblob(16)))),
  person_id  text references person(id),      -- nullable: responses may be anonymous
  period     text not null,
  score      real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: check (score between 1 and 10),
  comment    text,
  at         text not null default now()
);

-- ------------------------------------------------- app settings, not code
-- Everything the old tool hard-coded: sender, aliases, signature, templates,
-- reminder days, dispatch granularity, assistant provider/model/key/cap.
create table app_setting (
  key          text primary key,
  value        text,
  plain_language text not null,      -- shown in the UI, verbatim
  group_name   text not null,        -- email | assistant | clocks | jobs | desks
  secret       boolean not null default false,
  editable_by  text not null default 'ADMIN',
  updated_by   text references person(id),
  updated_at   text not null default now()
);

-- a guided assist panel per screen, so help is data rather than a help desk
create table assist_guide (
  key        text primary key,
  route      text not null,
  title      text not null,
  -- MANUAL: steps was text[]. Create a child table; do NOT store a delimited string.
  -- steps      text[] not null,
  why        text not null
);


-- =====================================================================
-- ADMIN SETUP: assistant keys, mailbox  (added 3 Sep 2026)
-- =====================================================================

create table ai_key (
  id              text primary key default (lower(hex(randomblob(16)))),
  provider        text not null,
  model           text not null,
  key_encrypted   blob,
  endpoint        text,
  chain_order     int  not null unique,
  scope           text not null default 'everything'
                  check (scope in ('everything','short','long','fallback')),
  monthly_budget  int  not null default 0,
  used_this_month int  not null default 0,
  state           text not null default 'untested'
                  check (state in ('healthy','untested','erroring','no_key')),
  last_tested_at  text,
  last_latency_ms int,
  created_at      text not null default now(),
  updated_at      text not null default now()
);
-- NOTE table ai_key: Fallback chain. Calls try keys in chain_order; a key that is spent, erroring or unset is skipped so no feature stops because one key ran out.

create table ai_call (
  id          text primary key default (lower(hex(randomblob(16)))),
  ai_key_id   text not null references ai_key(id),
  touchpoint  text not null,
  at          text not null default now(),
  latency_ms  int,
  ok          boolean not null,
  error       text,
  actor_id    text references person(id)
);
create index ai_call_at_desc_idx on ai_call (at desc);
-- NOTE table ai_call: One row per assistant call, for budget accounting and the audit trail. Prompts and keys are never stored.

create table mail_config (
  id                    integer primary key default 1 check (id = 1),
  mailbox               text not null,
  auth_mode             text not null check (auth_mode in ('service_account','oauth','smtp')),
  service_account_email text,
  delegation_client_id  text,
  reply_to              text,
  daily_budget          int  not null default 1800,
  used_today            int  not null default 0,
  signature_json        text,
  signature_logo_file   text,
  test_mode             boolean not null default false,
  test_address          text,
  test_mode_expires_at  text,
  bounce_strikes        int not null default 3,
  last_tested_at        text,
  updated_at            text not null default now(),
  check (test_mode = false or test_address is not null)
);
-- NOTE column mail_config.signature_logo_file: Uploaded file id. A Drive share link renders broken in mail clients, so links are refused.
-- NOTE column mail_config.daily_budget: 1,800 of the 2,000 cap; 200 reserved for interactive mail. This ceiling is what the legacy tool breached 1,849 times.

create table mail_alias (
  id       text primary key default (lower(hex(randomblob(16)))),
  address  text not null unique,
  verified boolean not null default false
);

create table mail_bounce (
  id        text primary key default (lower(hex(randomblob(16)))),
  address   text not null,
  at        text not null default now(),
  hard      boolean not null,
  strikes   int  not null default 1,
  unreachable boolean not null default false
);
create index mail_bounce_address_idx on mail_bounce (address);
-- NOTE table mail_bounce: Three hard bounces mark a recipient unreachable and raise a matrix task, rather than retrying forever.


-- =====================================================================
-- IDENTITY  (revised 4 Sep 2026)
-- A branch inbox is shared: 10 POC e-mails cover all 1,413 branches.
-- An e-mail therefore cannot identify a person, so it is neither unique
-- nor a credential. Mobile number and user ID are.
-- =====================================================================

alter table person add column user_id text;
alter table person add column mobile  text;
alter table person add column mobile_verified_at text;

create unique index person_user_id_key on person (lower(user_id)) where left_on is null;
create unique index person_mobile_key  on person (mobile)         where left_on is null;

-- e-mail is optional, shared, and grants nothing
drop index if exists person_work_email_key;
-- NOTE column person.email: Optional. Often a shared branch inbox, so NOT unique and NOT a credential.
-- NOTE column person.mobile: Required and unique. The identity for sign-in, OTP activation and password reset.
-- NOTE column person.user_id: Chosen at activation, unique, what the person types to sign in.

create table otp_challenge (
  id         text primary key default (lower(hex(randomblob(16)))),
  mobile     text not null,
  code_hash  blob not null,
  purpose    text not null check (purpose in ('activate','reset')),
  expires_at text not null,
  consumed_at text,
  attempts   int not null default 0
);
create index otp_challenge_mobile_purpose_idx on otp_challenge (mobile, purpose);
-- NOTE table otp_challenge: Six-digit code to a mobile. Single use, short expiry, attempt-capped. Never reveals whether a number is registered.

-- =====================================================================
-- PART 4 — THE PERFORMANCE CYCLE AS BUILT
-- Everything below exists because the prototype's PMS engine needs it and
-- Part 3 did not have it. Same principle throughout: a rule is a row, a
-- clock is a column, and no number is written in code.
-- =====================================================================

-- ------------------------------------------------------------- calendar
-- Until this table has rows no TAT can be enforced, because a holiday
-- would count as a working day. The legacy HOLIDAYS tab was empty while
-- its rules claimed to use it.
create table holiday (
  day         text /* YYYY-MM-DD */ primary key,
  name        text not null,
  applies_to  text not null default 'ALL',   -- ALL | a geo_node name | a department
  source      text,                          -- upload file or the person who added it
  created_at  text not null default now()
);
-- NOTE table holiday: Skipped by every clock. Loaded by upload, never hard-coded.

-- Mon-Fri run day_start..day_end; Saturday is a half day of sat_hours;
-- Sunday is off. Held as settings so the working week is administrator data.
insert into app_setting (key, value, note) values
  ('day_start',  '10:00', 'Start of the working day. Every TAT counts only minutes inside the window.'),
  ('day_end',    '19:00', 'End of the working day.'),
  ('sat',        'Yes - half day', 'Yes - half day | Yes - full day | No.'),
  ('sat_hours',  '4',     'Hours counted on a Saturday when it is a half day: 10:00-14:00.')
on conflict (key) do nothing;

-- --------------------------------------------------------- cycle + gates
create table pms_cycle (
  id            text primary key default (lower(hex(randomblob(16)))),
  person_id     text not null references person(id),
  chair_id      text references chair(id),
  period        text /* YYYY-MM-DD */ not null,                  -- first day of the month scored
  state         text not null default 'PENDING' check (state in ('PENDING', 'SELF_DONE', 'AWAITING_REVIEW', 'SCORED', 'DISPUTED', 'CLOSED')),
  window_opens  text,
  window_closes text,
  self_due      text,
  self_at       text,
  review_due    text,                    -- self_at + pms_review_hrs working hours
  scored_at     text,
  closed_at     text,
  on_probation  boolean not null default false,
  is_partner    boolean not null default false, -- partners are not forced into a band
  constraint pms_cycle_uniq unique (person_id, period)
);
create index pms_cycle_period_idx on pms_cycle (period, state);
create index pms_cycle_review_due_idx on pms_cycle (review_due) where state = 'AWAITING_REVIEW';

-- Bottom-up closure. A manager's window may not open while anyone below
-- them is unclosed, which is what makes the team average real. Enforced
-- here rather than trusted to the UI.
-- ===== NOT PORTABLE: function pms_window_may_open =====
-- SQLite/libSQL has no stored functions. Reimplement in the API.
-- See TURSO_R2_READINESS.md §2b.
-- create or replace function pms_window_may_open(p_person text, p_period date)
-- returns boolean as $$
--   select not exists (
--     select 1
--     from chair_holder ch
--     join chair c on c.id = ch.chair_id
--     join chair_holder sub_h on true
--     join chair sub on sub.id = sub_h.chair_id and sub.reports_to_chair_id = c.id
--     left join pms_cycle pc on pc.person_id = sub_h.person_id and pc.period = p_period
--     where ch.person_id = p_person and ch.to_date is null and sub_h.to_date is null
--       and coalesce(pc.state, 'PENDING') <> 'CLOSED'
--   )
--   or not (select coalesce(value, 'Yes') like 'Y%' from app_setting where key = 'pms_bottom_up');
-- $$ language sql stable;

-- --------------------------------------------------------- the two halves
-- KPI half and Attribute half, weighted by pms_wkpi. Attributes are fed by
-- tasks, notes, appreciations, ideas — and reduced by escalations and
-- warnings, which is the cascade below.
create table pms_component (
  id          text primary key default (lower(hex(randomblob(16)))),
  cycle_id    text not null references pms_cycle(id) on delete cascade,
  kind        text not null check (kind in ('KPI','ATTRIBUTE','TEAM')),
  raw         real        -- a KPI value may be a count, a percentage or rupees; the unit column says which. REAL avoids lying about precision. DEFAULT.
  -- was: not null,                 -- 0-10 before weighting
  weight_pct  real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: not null,                 -- read from pms_weighting at close
  note        text,
  constraint pms_component_uniq unique (cycle_id, kind)
);
-- NOTE column pms_component.kind: TEAM is the average final score of everyone below, at every level; it supplies pms_team_share percent of a manager's Attribute half.

-- Every point the cascade moves, with what moved it. The monthly cap is
-- shared across escalations and warnings together; anything past the cap is
-- recorded here with applied = false and flagged to HR rather than dropped.
create table pms_adjustment (
  id           text primary key default (lower(hex(randomblob(16)))),
  cycle_id     text not null references pms_cycle(id) on delete cascade,
  source_kind  text not null check (source_kind in ('ESCALATION', 'WARNING', 'APPRECIATION', 'ASSISTANCE')),
  source_id    text,                             -- raisable(id) or letter(id)
  half         text not null check (half in ('ATTRIBUTE','KPI')),
  points       integer        -- whole points, not paise. DEFAULT.
  -- was: not null,                 -- signed
  applied      boolean not null default true,
  capped       boolean not null default false,
  reason       text not null,
  at           text not null default now()
);
create index pms_adjustment_cycle_idx on pms_adjustment (cycle_id, half);
-- NOTE table pms_adjustment: The cascade, one row per movement: Attributes first, floor at zero, then KPI points, total capped by pms_cut_cap per month. A capped row is evidence, not a silent no-op.

-- Attributes may not go below zero; that floor is what pushes the cost into
-- the KPI half rather than into negative numbers.
-- ===== NOT PORTABLE: function pms_attribute_balance =====
-- SQLite/libSQL has no stored functions. Reimplement in the API.
-- See TURSO_R2_READINESS.md §2b.
-- create or replace function pms_attribute_balance(p_cycle text) returns integer /* paise or REAL for a score — confirm per column */ as $$
--   select greatest(0, coalesce(sum(points), 0))
--   from pms_adjustment where cycle_id = p_cycle and half = 'ATTRIBUTE' and applied;
-- $$ language sql stable;

-- ------------------------------------------------------------- disputes
create table pms_dispute (
  id           text primary key default (lower(hex(randomblob(16)))),
  cycle_id     text not null references pms_cycle(id) on delete cascade,
  raised_by    text not null references person(id),
  raised_at    text not null default now(),
  reason       text not null,
  hr_due       text not null,             -- raised_at + pms_dispute_hrs working hours
  decided_by   text references person(id),
  decided_at   text,
  outcome      text check (outcome in ('SCORE_STANDS','RESCORE','WITHDRAWN')),
  outcome_note text,
  constraint pms_dispute_outcome check (decided_at is null or outcome is not null)
);
create index pms_dispute_due_idx on pms_dispute (hr_due) where decided_at is null;
-- NOTE table pms_dispute: A dispute freezes the score and pulls HR in. RESCORE reopens the manager review; the original score stays in pms_score history.

-- ----------------------------------------------------------- exceptions
create table pms_exception (
  id           text primary key default (lower(hex(randomblob(16)))),
  cycle_id     text not null references pms_cycle(id) on delete cascade,
  requested_by text not null references person(id),
  requested_at text not null default now(),
  reason       text not null,
  hr_due       text not null,             -- + pms_exc_hrs working hours
  state        text not null default 'PENDING'
                 check (state in ('PENDING','GRANTED','REFUSED','EXPIRED')),
  decided_by   text references person(id),
  decided_at   text,
  reopens_until text                      -- + pms_exc_open working hours, this person only
);
create index pms_exception_due_idx on pms_exception (hr_due) where state = 'PENDING';
-- NOTE table pms_exception: Missed the window and asks HR to reopen it. Grants are per person and self-closing; unanswered requests become escalations against HR.

-- ---------------------------------------------------------- bell curve
create table pms_curve_band (
  id         text primary key default (lower(hex(randomblob(16)))),
  effective_fy text not null,                    -- '2026-27'; changing mid-year splits comparability
  rank       int not null check (rank between 1 and 5),
  label      text not null,
  share_pct  real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: not null,
  constraint pms_curve_uniq unique (effective_fy, rank)
);
-- NOTE table pms_curve_band: Employees only, consolidated month on month across the financial year. Partners and probationers are reported separately and are never forced into a band.

insert into pms_curve_band (effective_fy, rank, label, share_pct) values
  ('2026-27', 1, 'Outstanding', 5),
  ('2026-27', 2, 'Exceeds', 15),
  ('2026-27', 3, 'Meets', 60),
  ('2026-27', 4, 'Below', 15),
  ('2026-27', 5, 'Unsatisfactory', 5)
on conflict do nothing;

create table pms_band_result (
  cycle_id  text primary key references pms_cycle(id) on delete cascade,
  band_id   text references pms_curve_band(id),
  final     real        -- 0-10 or a percentage. REAL is correct here: a score is not money. DEFAULT.
  -- was: not null,
  floored   boolean not null default false,      -- probation floor applied
  excluded  boolean not null default false,      -- partner or probationer
  at        text not null default now()
);

-- ---------------------------------------------------------- automations
-- The prototype fires 49 of these. Held as rows so a schedule change is a
-- config edit, and so a paused automation is visible rather than silent —
-- the legacy kill switch stopped every job with no record of why.
create table automation (
  key          text primary key,
  title        text not null,
  fires_on     text not null,                    -- cron-ish or 'ON <event>'
  -- MANUAL: reads_setting was text[]. Create a child table; do NOT store a delimited string.
  -- reads_setting text[],                          -- app_setting keys it obeys
  -- MANUAL: writes_kind was text[]. Create a child table; do NOT store a delimited string.
  -- writes_kind  text[],                           -- audit_entry kinds it emits
  ladder_step  int,                              -- position in a miss ladder
  escalates_to text,                             -- chair code or desk
  enabled      boolean not null default true,
  disabled_reason text,
  constraint automation_pause_reason check (enabled or disabled_reason is not null)
);

create table automation_run (
  id           text primary key default (lower(hex(randomblob(16)))),
  key          text not null references automation(key),
  started_at   text not null default now(),
  finished_at  text,
  outcome      text check (outcome in ('OK','NOOP','ERROR')),
  affected     int not null default 0,
  detail       text
);
create index automation_run_key_idx on automation_run (key, started_at desc);
-- NOTE table automation_run: One row per firing. STRIKE_SWEEP was 1,690 of 1,707 legacy runs and 1,535 of them NOOP; a NOOP rate is now a number somebody can see.

-- ------------------------------------------------------ hiring pipeline
-- Chair-first: a request is raised against a chair, HR accepts it, Finance
-- approves the cost, and only then does the chair open for an occupant.
alter table person_request add column chair_id      text references chair(id);
alter table person_request add column finance_state text default 'NOT_REQUIRED'
      check (finance_state in ('NOT_REQUIRED','AWAITING','APPROVED','REFUSED'));
alter table person_request add column finance_by    text references person(id);
alter table person_request add column finance_at    text;
alter table person_request add column finance_note  text;
alter table person_request add column due_at        text;
alter table person_request add column returned_to   text references person(id);
create index if not exists person_request_overdue_idx
  on person_request (due_at) where finance_state = 'AWAITING';
-- NOTE column person_request.returned_to: A Finance refusal goes back to the raising manager with the note, not into a void.

-- A chair with no holder and no live request is not shown on the chart; a
-- chair whose request is past due is shown as risk. This view is what the
-- org chart reads, so the rule lives in one place.
create or replace view chair_status as
select c.id, c.code, c.title,
  h.person_id,
  case
    when h.person_id is not null then 'FILLED'
    when r.id is not null and r.due_at < now() then 'OVERDUE'
    when r.id is not null then 'REQUESTED'
    else 'DORMANT'
  end as state,
  r.due_at
from chair c
left join chair_holder h on h.chair_id = c.id and h.to_date is null and h.is_primary
left join person_request r on r.chair_id = c.id and r.state in ('DRAFT','AWAITING_HR','AWAITING_ADMIN');

-- ---------------------------------------------------------------- audit
-- Scope is per chair: HR reads company-wide, a manager reads their own
-- subtree, nobody reads sideways. Kept as a column so a scope question has
-- an answer that does not depend on the screen it was asked from.
alter table audit_entry add column chair_id   text references chair(id);
alter table audit_entry add column scope_path text;  -- materialised chair path, e.g. 'MD/OPS/RM_W/BM_P'
alter table audit_entry add column sentence   text;  -- the readable line the UI shows
create index if not exists audit_entry_scope_idx on audit_entry (scope_path, at desc);
-- NOTE column audit_entry.sentence: Written at insert time. The trail is read by people, so the row carries the sentence rather than asking the UI to rebuild it.


-- =====================================================================
-- MIS LAYER: rate master + business records  (added 7 Sep 2026)
-- No employee/client/location tables are created here: the MIS references
-- the existing masters. Only rate and business volume are net-new.
-- =====================================================================

create table rate (
  id             text primary key default (lower(hex(randomblob(16)))),
  code           text unique not null,
  client_id      text not null references client(id),
  scope          text not null check (scope in ('exact', 'group', 'client')),
  value          integer        -- paise. Divide by 100 only at display. DEFAULT: change only if this is not money.
  -- was: not null check (value >= 0),
  currency       char(3) not null default 'INR',
  effective_from text /* YYYY-MM-DD */ not null,
  effective_to   text /* YYYY-MM-DD */,
  status         text not null default 'active',
  reason         text,
  created_by     text references person(id),
  created_at     text not null default now(),
  updated_by     text references person(id),
  updated_at     text not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (scope <> 'client' or true)
);
-- NOTE table rate: Scoped rate. Never duplicated per location: scope=group carries its locations in rate_location.

create table rate_location (
  rate_id     text not null references rate(id) on delete cascade,
  geo_node_id text not null references geo_node(id),
  primary key (rate_id, geo_node_id)
);
-- NOTE table rate_location: Only for scope in (exact, group). scope=client has no rows here and applies to every location.

-- Overlap prevention (Part 23.1): no two active rates may cover the same
-- client + scope + location for an intersecting period.
create index rate_lookup on rate (client_id, scope, effective_from desc)
  where status = 'active';

create table business_record (
  id            text primary key default (lower(hex(randomblob(16)))),
  period        char(7) not null,                    -- YYYY-MM
  business_date text /* YYYY-MM-DD */ not null,
  client_id     text not null references client(id),
  geo_node_id   text not null references geo_node(id),
  owner_id      text references person(id),
  mtd           integer not null default 0 check (mtd >= 0),
  day10         integer not null default 0 check (day10 >= 0),
  target        integer not null default 0 check (target >= 0),
  revenue       integer        -- paise. Divide by 100 only at display. DEFAULT: change only if this is not money.
  -- was: not null default 0,     -- STORED, authoritative
  source_ref    text,
  created_at    text not null default now(),
  updated_at    text not null default now(),
  unique (period, client_id, geo_node_id)
);
-- NOTE column business_record.revenue: Stored revenue is the source value. Derived rate (revenue/mtd) is diagnostic only and never overwrites it.

create table rate_exception (
  id           text primary key default (lower(hex(randomblob(16)))),
  record_id    text not null references business_record(id),
  kind         text not null,   -- no_rate | zero_mtd_with_revenue | implied_mismatch
  configured   integer        -- paise. Divide by 100 only at display. DEFAULT: change only if this is not money.
  -- was: ,
  implied      integer        -- paise. Divide by 100 only at display. DEFAULT: change only if this is not money.
  -- was: ,
  detected_at  text not null default now(),
  resolved_at  text,
  resolved_by  text references person(id),
  resolution   text
);

create table forecast_config (
  id        integer primary key default 1 check (id = 1),
  scenarios text not null default
    '[{"key":"cons","label":"Conservative","mult":3.25},
      {"key":"base","label":"Base","mult":3.5},
      {"key":"stretch","label":"Stretch","mult":4},
      {"key":"agg","label":"Aggressive","mult":5,"kept":true}]'::text,
  updated_by text references person(id),
  updated_at text not null default now()
);
-- NOTE table forecast_config: Part 27: multipliers are configuration. Defaults are the workbook scenarios; the label mapping needs workbook confirmation.

create table mis_saved_view (
  id         text primary key default (lower(hex(randomblob(16)))),
  person_id  text not null references person(id),
  name       text not null,
  config     text not null,   -- dims, filters, month, scenario, expanded rows
  created_at text not null default now(),
  unique (person_id, name)
);
-- NOTE table mis_saved_view: Configuration only. No copy of the underlying data.
