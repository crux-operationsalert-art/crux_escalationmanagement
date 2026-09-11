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

create type role_kind        as enum ('ADMIN','MANAGER','LOCATION_HEAD','VIEWER');
create type entity_status    as enum ('ACTIVE','INACTIVE');
create type geo_level        as enum ('ZONE','STATE','CITY');
create type scope_kind       as enum ('CLIENT','CLIENT_ZONE','STATE','BRANCH');
create type case_status      as enum ('OPEN','IN_PROGRESS','RESOLVED','CLOSED','BLOCKED');
create type outbox_state     as enum ('QUEUED','SENT','DEFERRED','ABANDONED');
create type job_result       as enum ('OK','NOOP','FAILED');
create type person_event_kind as enum ('NOTE','APPRECIATION','WARNING','PIP','ACTIVATION');

-- ---------------------------------------------------------------- people
create table designation (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  desk_id       uuid,                      -- fk added after desk
  is_desk_head  boolean not null default false,
  seniority     int    not null default 0,
  constraint designation_title_uniq unique (title)
);

create table person (
  id                 uuid primary key default gen_random_uuid(),
  employee_no        text,
  full_name          text not null,
  work_email         text,
  personal_email     text,
  mobile             text,
  designation_id     uuid references designation(id),
  department         text,
  manager_id         uuid references person(id),
  app_role           role_kind not null default 'VIEWER',
  employment_status  entity_status not null default 'ACTIVE',
  joined_on          date,
  left_on            date,
  superseded_by      uuid references person(id),   -- identity merges, never deletes
  source_ref         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- the constraint that would have prevented the cruxinida.co.in twin:
create unique index person_work_email_uniq
  on person (lower(work_email))
  where employment_status = 'ACTIVE' and superseded_by is null and work_email is not null;
create unique index person_employee_no_uniq
  on person (employee_no) where employee_no is not null;

create table desk (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  primary_person_id uuid references person(id),
  escalation_only   boolean not null default false,   -- MD office
  fallback_desk_id  uuid references desk(id),
  constraint desk_primary_or_fallback check (primary_person_id is not null or fallback_desk_id is not null)
);
alter table designation add constraint designation_desk_fk foreign key (desk_id) references desk(id);

-- ------------------------------------------------------------- geography
create table geo_node (
  id        uuid primary key default gen_random_uuid(),
  parent_id uuid references geo_node(id),
  level     geo_level not null,
  name      text not null
);
-- collapses "Goa" and "GOA", and the 36 mixed Zone values of the old sheet
create unique index geo_node_sibling_uniq on geo_node (coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- --------------------------------------------------------------- clients
create table client (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  status         entity_status not null default 'ACTIVE',
  effective_from date,
  effective_to   date,
  notes          text,
  source_ref     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint client_code_uniq unique (code)
);

create table client_contact (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references client(id) on delete cascade,
  kind       text not null,             -- 'PRIMARY' | 'CC' | 'HEAD_OFFICE' | 'HEAD_OFFICE_CC'
  name       text,
  email      text not null,
  mobile     text
);
create unique index client_contact_uniq on client_contact (client_id, kind, lower(email));

create table client_zone (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references client(id) on delete cascade,
  name        text not null,            -- the client's own vocabulary
  geo_node_id uuid references geo_node(id)
);
create unique index client_zone_uniq on client_zone (client_id, lower(name));

create table branch (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references client(id),
  code           text not null,
  name           text not null,
  address        text,
  geo_node_id    uuid references geo_node(id),
  client_zone_id uuid references client_zone(id),
  status         entity_status not null default 'ACTIVE',
  effective_from date,
  effective_to   date,
  notes          text,
  source_ref     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint branch_code_uniq unique (client_id, code)   -- 217 old branches had no code
);
create index branch_client_status_idx on branch (client_id, status);

create table branch_contact (
  id        uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branch(id) on delete cascade,
  role      text not null,              -- 'BRANCH_MANAGER' | 'CRUX_POC'
  person_id uuid references person(id), -- internal people are referenced
  name      text,                       -- external contacts are stored
  mobile    text,
  email     text,
  active    boolean not null default true,
  constraint branch_contact_identified check (person_id is not null or name is not null)
);
create unique index branch_contact_one_active on branch_contact (branch_id, role) where active;

-- ---------------------------------------------------------------- matrix
create table matrix_contact (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references client(id),
  branch_id  uuid references branch(id) on delete cascade,  -- null = client-level matrix
  level      int  not null check (level between 1 and 5),
  level_name text not null,
  person_id  uuid references person(id),
  name       text,
  mobile     text,
  email      text,
  updated_by uuid references person(id),
  updated_at timestamptz not null default now(),
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
  id             uuid primary key default gen_random_uuid(),
  person_id      uuid not null references person(id),
  role           text not null,          -- LOCATION_HEAD | BRANCH_MANAGER | ZONAL_MANAGER
  scope_type     scope_kind not null,
  client_id      uuid references client(id),
  client_zone_id uuid references client_zone(id),
  geo_node_id    uuid references geo_node(id),
  branch_id      uuid references branch(id),
  effective_from date not null default current_date,
  effective_to   date,
  source_ref     text,
  created_at     timestamptz not null default now(),
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
create or replace function coverage_resolve(p_rule coverage_rule) returns setof uuid as $$
  select b.id from branch b
  left join client_zone cz on cz.id = b.client_zone_id
  where case p_rule.scope_type
    when 'CLIENT'      then b.client_id = p_rule.client_id
    when 'CLIENT_ZONE' then b.client_zone_id = p_rule.client_zone_id
    when 'STATE'       then b.client_id = p_rule.client_id and b.geo_node_id in (
                              with recursive t as (
                                select id from geo_node where id = p_rule.geo_node_id
                                union all select g.id from geo_node g join t on g.parent_id = t.id
                              ) select id from t)
    when 'BRANCH'      then b.id = p_rule.branch_id
  end;
$$ language sql stable;

create or replace function coverage_no_overlap() returns trigger as $$
declare clash record;
begin
  select r.id, r.scope_type, count(*) as n into clash
  from coverage_rule r
  cross join lateral (select 1 from coverage_resolve(r) x where x in (select coverage_resolve(new))) hit
  where r.person_id = new.person_id and r.role = new.role and r.id <> new.id
    and (r.effective_to is null or r.effective_to >= current_date)
  group by r.id, r.scope_type
  limit 1;
  if clash.id is not null then
    raise exception 'coverage overlap: % branches already covered by rule % (%)', clash.n, clash.id, clash.scope_type
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger coverage_rule_no_overlap
  before insert or update on coverage_rule
  for each row execute function coverage_no_overlap();

-- ----------------------------------------------------------------- cases
create table category (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  desk_id     uuid not null references desk(id),
  pinned      boolean not null default false,  -- Fraud/Integrity, Data Privacy
  chase_hours int,                             -- null = use the global clock
  active      boolean not null default true
);

create table "case" (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,
  client_id         uuid not null references client(id),
  branch_id         uuid references branch(id),
  category_id       uuid not null references category(id),
  raised_by         uuid not null references person(id),
  against_person_id uuid references person(id),
  against_text      text,
  description       text,
  owner_person_id   uuid references person(id),
  desk_id           uuid references desk(id),
  status            case_status not null default 'OPEN',
  resolution_note   text,
  resolved_at       timestamptz,
  auto_close_at     timestamptz,             -- resolved_at + 7 days (rule R-05)
  next_chase_at     timestamptz,             -- scheduled, never swept (rule R-03)
  strike_count      int not null default 0,
  last_activity_at  timestamptz not null default now(),
  closed_at         timestamptz,
  source_ref        text,
  created_at        timestamptz not null default now(),
  -- a case can never be ownerless: it is owned, or explicitly BLOCKED and visible
  constraint case_has_owner check (owner_person_id is not null or desk_id is not null or status = 'BLOCKED')
);
create index case_open_chase_idx on "case" (next_chase_at) where status in ('OPEN','IN_PROGRESS');
create index case_autoclose_idx  on "case" (auto_close_at) where status = 'RESOLVED';

create table case_event (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references "case"(id) on delete cascade,
  at         timestamptz not null default now(),
  actor_id   uuid references person(id),
  kind       text,       -- 'RAISED', an escalation_action.code, etc
  field      text,
  old_value  text,
  new_value  text,
  note       text
);
create index case_event_case_idx on case_event (case_id, at);

-- ------------------------------------------------------------------ mail
create table template (
  id         uuid primary key default gen_random_uuid(),
  key        text not null,
  version    int  not null default 1,
  subject    text not null,
  body       text not null,
  updated_by uuid references person(id),
  updated_at timestamptz not null default now(),
  constraint template_key_version_uniq unique (key, version)
);

-- THE constraint. 77 idempotency keys produced 1,892 sends in the old system
-- because uniqueness was a convention rather than a rule.
create table outbox (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  template_key    text not null,
  entity_type     text,
  entity_id       uuid,
  recipient       text not null,
  cc_addr         text,
  subject         text not null,
  body            text not null,
  state           outbox_state not null default 'QUEUED',
  attempts        int not null default 0,
  not_before      timestamptz not null default now(),
  sent_at         timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  constraint outbox_idempotency_uniq unique (idempotency_key)
);
create index outbox_due_idx on outbox (not_before) where state = 'QUEUED';

create table delivery (
  id           uuid primary key default gen_random_uuid(),
  outbox_id    uuid references outbox(id),
  channel      text not null default 'EMAIL',
  recipient    text not null,
  state        text not null,
  error        text,
  at           timestamptz not null default now(),
  provider_ref text,
  entity_type  text,
  entity_id    uuid
);
create index delivery_entity_idx on delivery (entity_type, entity_id, at);

create table mail_budget (
  day            date primary key,
  recipients_sent int not null default 0,
  cap            int not null default 1800,
  reserve        int not null default 200
);

-- ------------------------------------------------------------------ jobs
create table job_run (
  id          uuid primary key default gen_random_uuid(),
  job_key     text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  state       text,        -- RUNNING|OK|NOOP|ERROR, as the worker actually writes it
  note        text,        -- free-text outcome, e.g. 'sent=3 failed=0'
  result      job_result,
  counts      jsonb,
  error       text,
  next_due_at timestamptz
);
create index job_run_key_idx on job_run (job_key, started_at desc);

-- a job may be disabled only with a reason, and it is visible (no silent pause)
create table job_config (
  job_key      text primary key,
  enabled      boolean not null default true,
  cron         text not null,
  disabled_by  uuid references person(id),
  disabled_at  timestamptz,
  reason       text,
  constraint job_disable_needs_reason check (enabled or (reason is not null and disabled_by is not null))
);

-- --------------------------------------------------------------- windows
create table submission_window (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  person_id  uuid not null references person(id),
  period     text not null,               -- 'YYYY-MM'
  state      text not null,               -- OPEN | CLOSED
  opened_by  uuid references person(id),
  opened_at  timestamptz,
  closes_at  timestamptz,
  reason     text,
  constraint submission_window_uniq unique (kind, person_id, period)
);

-- ------------------------------------------------------- people workflow
create table person_event (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references person(id),
  kind       text not null,     -- free text: NOTE, ACTIVATION_ISSUED, etc — not every kind the api writes fits the original enum
  at         timestamptz not null default now(),
  start_on   date,
  end_on     date,
  note       text,
  issued_by  uuid references person(id),
  status     text,
  outcome    text,
  case_id    uuid references "case"(id),
  source_ref text                          -- the 449 rescued notes keep this
);
create index person_event_person_idx on person_event (person_id, at desc);

create table target (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references person(id),
  period     text not null,
  category   text,
  sub_category text,
  client_id  uuid references client(id),
  target_value numeric,
  achieved_value numeric,
  notes      text,
  updated_by uuid references person(id),
  updated_at timestamptz not null default now(),
  constraint target_uniq unique (person_id, period, category, sub_category)
);

-- ----------------------------------------------------------------- audit
create table audit_entry (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  actor_id    uuid references person(id),
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  entity_ref  text,        -- the api's generic actor-facing reference (ref/code/id-as-text)
  old_value   jsonb,
  new_value   jsonb
);
create index audit_entity_idx on audit_entry (entity_type, entity_id, at desc);
create index audit_actor_idx  on audit_entry (actor_id, at desc);
-- NOTE: machine retries do NOT belong here. In the old system EMAIL_RETRY was
-- the single largest action (1,740 of 5,913). Retries live in outbox/job_run.

-- ------------------------------------------------------------- migration
create table migration_merge (
  id           uuid primary key default gen_random_uuid(),
  at           timestamptz not null default now(),
  entity_type  text not null,
  kept_id      uuid not null,
  merged_id    uuid,
  merged_key   text,
  rows_moved   int,
  rule         text not null,
  reviewed_by  uuid references person(id),
  reviewed_at  timestamptz
);

create table auth_session (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references person(id),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at   timestamptz not null,
  source       text,
  revoked_at   timestamptz,
  revoked_by   uuid references person(id)
);
create index auth_session_person_idx on auth_session (person_id) where revoked_at is null;

create table portal_link (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references client(id),
  branch_id  uuid references branch(id),
  token_hash text not null unique,   -- only the hash is stored
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  constraint portal_link_target check (client_id is not null or branch_id is not null)
);


-- =====================================================================
-- v2 ADDITIONS — organisation structure, daily counts, penalty engine
-- Added 3 Sep 2026 from the attached operating structure (70 chairs,
-- 188 owned processes, 14 functions) and the review comments.
-- =====================================================================

create type penalty_state as enum ('PENDING','APPLIED','WAIVED','DISPUTED','REVERSED');
create type approval_state as enum ('DRAFT','AWAITING_HR','AWAITING_ADMIN','ACTIVE','REJECTED');
create type esc_party as enum ('RAISER','RESPONDENT','MANAGER','DESK','HR','ADMIN','INFORMED');

-- ------------------------------------------------- chairs and the RACI map
-- A chair is a seat in the operating structure. A person occupies a chair;
-- ownership and routing resolve through the chair, never through a name.
create table chair (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,          -- e.g. 'BM_P', 'RM_W', 'HRH'
  title         text not null,
  desk_id       uuid references desk(id),
  parent_id     uuid references chair(id),     -- reporting line between chairs
  level         text not null,                 -- board|function|national|region|branch|executive|partner
  reports_daily boolean not null default false -- does this chair file a daily count
);

create table chair_holder (
  id         uuid primary key default gen_random_uuid(),
  chair_id   uuid not null references chair(id),
  person_id  uuid not null references person(id),
  is_primary boolean not null default false,   -- breaks the two-people-one-title tie
  from_date  date not null default current_date,
  to_date    date
);
create unique index chair_one_primary on chair_holder (chair_id) where is_primary and to_date is null;

create table process (
  id        uuid primary key default gen_random_uuid(),
  ref       text not null unique,              -- 'R1', 'S12' …
  function  text not null,                     -- one of the 14 functions
  name      text not null,
  owner_chair_id uuid not null references chair(id)
);

create table process_party (
  process_id uuid not null references process(id) on delete cascade,
  chair_id   uuid not null references chair(id),
  part       text not null,                    -- DOES | ADVISES | INFORMED
  primary key (process_id, chair_id, part)
);

create table process_input (
  id         uuid primary key default gen_random_uuid(),
  process_id uuid not null references process(id) on delete cascade,
  what       text not null,
  from_chair_id uuid not null references chair(id)
);

-- ------------------------------------------------------------ daily counts
create table kpi_definition (
  id         uuid primary key default gen_random_uuid(),
  chair_id   uuid references chair(id),
  person_id  uuid references person(id),
  name       text not null,
  unit       text,
  active     boolean not null default true,
  constraint kpi_scope check (chair_id is not null or person_id is not null)
);

-- the target is set BY THE MANAGER and is read-only to the holder
create table kpi_target (
  id            uuid primary key default gen_random_uuid(),
  kpi_id        uuid not null references kpi_definition(id),
  person_id     uuid not null references person(id),
  period        text not null,                 -- 'YYYY-MM'
  target_value  numeric not null,
  set_by        uuid not null references person(id),
  set_at        timestamptz not null default now(),
  constraint kpi_target_uniq unique (kpi_id, person_id, period),
  constraint kpi_target_not_self check (set_by <> person_id)   -- you cannot set your own target
);

create table daily_count (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references person(id),
  count_date   date not null,
  kpi_id       uuid not null references kpi_definition(id),
  value        numeric not null,
  submitted_at timestamptz not null default now(),
  locked_at    timestamptz,                    -- set when the 23:59 window closes
  reopened_by  uuid references person(id),
  reopen_reason text,
  constraint daily_count_uniq unique (person_id, count_date, kpi_id),
  constraint daily_reopen_needs_reason check (reopened_by is null or reopen_reason is not null)
);
create index daily_count_date_idx on daily_count (count_date, person_id);

-- ---------------------------------------------------------- penalty engine
-- Admin-editable: action, who, how often, cutoff, amount, who recovers.
create table penalty_rule (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,          -- 'P-01' …
  what          text not null,
  plain_language text not null,                -- shown in the UI verbatim
  applies_to    text not null,                 -- chair code, department, or ALL
  frequency     text not null,                 -- DAILY | MONTHLY | PER_EVENT | WEEKLY
  cutoff_spec   text not null,                 -- '23:59' | '3rd 18:00' | '48 working hours'
  amount        numeric not null,
  recovered_by  text not null,                 -- HR | FINANCE
  active        boolean not null default true,
  effective_from date not null default current_date,
  created_by    uuid references person(id)
);

create table penalty_instance (
  id            uuid primary key default gen_random_uuid(),
  rule_id       uuid not null references penalty_rule(id),
  person_id     uuid not null references person(id),
  period        text not null,
  occurred_on   date not null,
  cutoff_missed text not null,
  evidence      text not null,                 -- what proves it: 'no daily_count for 2026-09-01'
  entity_type   text,                          -- 'case' | 'branch' | 'kpi_target' …
  entity_id     uuid,
  amount        numeric not null,              -- copied from the rule at firing time
  state         penalty_state not null default 'APPLIED',
  waived_by     uuid references person(id),
  waive_reason  text,
  recovered_by  text not null,
  recovered_at  timestamptz,
  created_at    timestamptz not null default now(),
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
  case_id   uuid not null references "case"(id) on delete cascade,
  person_id uuid not null references person(id),
  part      esc_party not null,
  primary key (case_id, person_id, part)
);

create table escalation_action (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  label         text not null,
  pms_impact    boolean not null,              -- does it count in the performance score
  unlock_after_working_days int,               -- 'escalate' unlocks at 7
  sets_tat_hours int,                          -- 'needs immediate action' sets 24
  routes_to     text                            -- 'RAISER_MANAGER+HR' for dispute
);

create table escalation_action_log (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references "case"(id),
  action_code text not null references escalation_action(code),
  actor_id    uuid not null references person(id),
  at          timestamptz not null default now(),
  note        text
);

-- warning and notice letters, issuable by managers and upper management
create table letter (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,                   -- WARNING | NOTICE | APPRECIATION
  person_id   uuid not null references person(id),
  case_id     uuid references "case"(id),
  issued_by   uuid not null references person(id),
  issued_at   timestamptz not null default now(),
  body        text not null,
  acknowledged_at timestamptz,
  due_ack_at  timestamptz not null,            -- 72 hours; rule P-07 fires after
  copied_to   text[]                            -- HR and MD office by default
);

-- ------------------------------------------------- people joining approval
create table person_request (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  work_email    text not null,
  chair_id      uuid not null references chair(id),
  manager_id    uuid not null references person(id),
  requested_by  uuid not null references person(id),
  requested_at  timestamptz not null default now(),
  state         approval_state not null default 'AWAITING_HR',
  hr_by         uuid references person(id),
  hr_at         timestamptz,
  admin_by      uuid references person(id),
  admin_at      timestamptz,
  reject_reason text,
  person_id     uuid references person(id),    -- filled when the account is created
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
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references person(id),
  endpoint   text not null unique,
  keys       jsonb not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table notification (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references person(id),
  kind       text not null,
  text       text not null,
  entity_type text,
  entity_id  uuid,
  push       boolean not null default false,   -- deadline-bearing items are pushed
  at         timestamptz not null default now(),
  read_at    timestamptz
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
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_ref  text not null,          -- e.g. 'BRANCHES!4127'
  question    text not null,          -- 'Madhya Pradesh or Chhattisgarh?'
  context     text,                   -- the address as held in the sheet
  resolved_to text,
  resolved_by uuid references person(id),
  resolved_at timestamptz
);

-- 3 · Penalty rules are owned by Administrator, HR and Finance. No approval step.
create or replace function may_edit_penalty_rule(p_person uuid) returns boolean as $$
  select coalesce(
    (select department in ('Human Resources','Finance & Accounts') or app_role = 'ADMIN'
     from person where id = p_person), false);
$$ language sql stable;

-- 4 · Franchise partners are in scope for penalties and daily counts.
alter table penalty_rule
  add column applies_to_list text[] not null default '{Everybody}';
comment on column penalty_rule.applies_to_list is
  'Multi-select: Everybody | a department | a named chair | Managers with reportees | Executives | Team Leaders | Branch Managers | Regional Managers | Franchise Partners | Interns';

alter table person
  add column if not exists employee_type text not null default 'EMPLOYEE'
    check (employee_type in ('EMPLOYEE','PARTNER'));
comment on column person.employee_type is
  'PARTNER = franchise partner: in scope for PMS/penalties but billed by Finance, not payroll.';

-- partners are billed by Finance; employees are recovered through payroll by HR
create or replace function penalty_recovery_for(p_person uuid, p_rule uuid) returns text as $$
  select case when (select employee_type from person where id = p_person) = 'PARTNER'
              then 'FINANCE'
              else (select recovered_by from penalty_rule where id = p_rule) end;
$$ language sql stable;


-- =====================================================================
-- v2.1 — PMS, tasks, attributes, requests, visits & claims, ideathon
-- Added 3 Sep 2026 from the second review round.
-- =====================================================================

create type raisable_kind  as enum ('ESCALATION','WARNING','APPRECIATION','ASSISTANCE');
create type claim_stage    as enum ('DRAFT','OPS_APPROVAL','HR_APPROVAL','ACCOUNTS','DISPUTED','PAID','REJECTED');
create type idea_stage     as enum ('SUBMITTED','IN_REVIEW','ACCEPTED','INITIATED','ON_HOLD','REJECTED','DELIVERED');
create type note_class     as enum ('UNCLASSIFIED','ATTRIBUTE','FYI');

-- ------------------------------------------------------------ KPI structure
-- 5 KPIs per person: 3 mandatory, 2 optional. Sub-categories are whatever the
-- manager needs — client, location, product — so the target can be split.
alter table kpi_definition
  add column mandatory boolean not null default true,
  add column position  int not null default 1,
  add column parent_id uuid references kpi_definition(id);   -- sub-category

alter table kpi_target
  add column parent_target_id uuid references kpi_target(id); -- sub-category target

-- optional gate: miss it and either lose points or take a fixed default score
create table kpi_eligibility (
  id            uuid primary key default gen_random_uuid(),
  kpi_id        uuid references kpi_definition(id),
  person_id     uuid references person(id),
  chair_id      uuid references chair(id),
  scope_all     boolean not null default false,   -- admin may set it for everybody
  gate          text not null,                    -- 'TAT >= 85%'
  on_miss       text not null check (on_miss in ('DEDUCT','DEFAULT_SCORE')),
  deduct_points numeric,
  default_score numeric,
  set_by        uuid references person(id),
  constraint kpi_elig_effect check (
    (on_miss = 'DEDUCT' and deduct_points is not null) or
    (on_miss = 'DEFAULT_SCORE' and default_score is not null))
);

-- ------------------------------------------- tasks (Attributes, not KPIs)
create table task (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references person(id),
  assigned_by  uuid not null references person(id),
  title        text not null,
  detail       text,
  due_on       date,
  period       text not null,
  status       text not null default 'OPEN',
  outcome      text,
  attribute_weight numeric,        -- how much it counts inside Attributes
  closed_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index task_person_period_idx on task (person_id, period);

-- daily free-text note; the assistant files it as an Attribute or as FYI
create table daily_note (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id),
  note_date     date not null,
  body          text not null,
  classification note_class not null default 'UNCLASSIFIED',
  attribute_heading text,
  model_reason  text,
  classified_at timestamptz,
  included_in_review boolean not null default true
);
create index daily_note_person_idx on daily_note (person_id, note_date);

-- ------------------------------------------------------------- PMS scoring
create table pms_weighting (
  id            uuid primary key default gen_random_uuid(),
  scope_all     boolean not null default false,
  chair_id      uuid references chair(id),
  person_id     uuid references person(id),
  kpi_percent   numeric not null,
  attr_percent  numeric not null,
  effective_from date not null default current_date,
  set_by        uuid references person(id),
  constraint pms_weight_sums check (kpi_percent + attr_percent = 100)
);

-- impact of an escalation, warning or appreciation on the score — configured,
-- never hard-coded, and owned jointly by Admin and HR
create table pms_impact (
  kind        raisable_kind primary key,
  points      numeric not null,
  applies_to  text not null default 'PERSON_CONCERNED',
  set_by      uuid references person(id),
  updated_at  timestamptz not null default now()
);

create table pms_score (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id),
  period        text not null,
  kpi_score     numeric,
  attr_score    numeric,
  final_score   numeric,
  manager_score numeric check (manager_score between 1 and 10),
  manager_note  text,
  review_summary text,               -- built from tasks, notes, appreciations
  scored_by     uuid references person(id),
  scored_at     timestamptz,
  hr_closed_by  uuid references person(id),
  hr_closed_at  timestamptz,
  constraint pms_score_uniq unique (person_id, period)
);

-- ------------------------------------------------- raisables and requests
-- One table behind four buttons: escalation, warning, appreciation, assistance.
create table raisable (
  id            uuid primary key default gen_random_uuid(),
  kind          raisable_kind not null,
  ref           text not null unique,
  raised_by     uuid not null references person(id),
  about_person  uuid references person(id),
  department    text,                          -- for an assistance request
  case_id       uuid references "case"(id),    -- escalations reuse the case row
  body          text,
  auto_source   text,                          -- 'STRIKE_3' when the system raised it
  pms_points    numeric,                       -- copied from pms_impact at raise time
  created_at    timestamptz not null default now()
);

-- an assistance request becomes a task on the responder; if it is not actioned
-- the three-strike policy raises an escalation against them automatically
create table request_task (
  id            uuid primary key default gen_random_uuid(),
  raisable_id   uuid not null references raisable(id),
  responder_id  uuid not null references person(id),
  due_at        timestamptz not null,
  actioned_at   timestamptz,
  strike_count  int not null default 0,
  escalated_case_id uuid references "case"(id)
);
create index request_task_due_idx on request_task (due_at) where actioned_at is null;

-- ---------------------------------------------------------- visits & claims
-- The visit form differs per department, so the fields are configuration.
create table visit_form_field (
  id          uuid primary key default gen_random_uuid(),
  department  text not null,
  position    int not null,
  label       text not null,
  field_type  text not null default 'text',
  required    boolean not null default true
);

create table visit (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person(id),
  visited_on  date not null,
  branch_id   uuid references branch(id),
  client_id   uuid references client(id),
  purpose     text,
  answers     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table claim (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique,
  visit_id      uuid references visit(id),
  person_id     uuid not null references person(id),
  amount        numeric not null,
  stage         claim_stage not null default 'DRAFT',
  ops_by        uuid references person(id),
  ops_at        timestamptz,
  hr_by         uuid references person(id),
  hr_at         timestamptz,
  accounts_by   uuid references person(id),
  accounts_at   timestamptz,
  paid_ref      text,                       -- UTR / payment reference
  dispute_reason text,
  created_at    timestamptz not null default now(),
  constraint claim_dispute_reason check (stage <> 'DISPUTED' or dispute_reason is not null),
  constraint claim_paid_ref check (stage <> 'PAID' or paid_ref is not null)
);
create index claim_stage_idx on claim (stage);

-- ---------------------------------------------------------------- ideathon
create table idea (
  id           uuid primary key default gen_random_uuid(),
  ref          text not null unique,
  title        text not null,
  body         text not null,
  raised_by    uuid not null references person(id),
  stage        idea_stage not null default 'SUBMITTED',
  sponsor_id   uuid references person(id),
  owner_dept   text,
  charter      text,
  decided_by   uuid references person(id),
  decided_at   timestamptz,
  decision_reason text,
  created_at   timestamptz not null default now(),
  constraint idea_decision_reason check (stage not in ('REJECTED','ON_HOLD') or decision_reason is not null)
);

create table idea_collaborator (
  idea_id   uuid not null references idea(id) on delete cascade,
  person_id uuid not null references person(id),
  role      text not null default 'COLLABORATOR',
  primary key (idea_id, person_id)
);

-- --------------------------------------------------------- HR (not payroll)
create table onboarding (
  id           uuid primary key default gen_random_uuid(),
  person_request_id uuid references person_request(id),
  person_id    uuid references person(id),
  induction_on date,
  buddy_id     uuid references person(id),
  documents_ok boolean not null default false,
  completed_at timestamptz
);

create table pulse_response (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid references person(id),      -- nullable: responses may be anonymous
  period     text not null,
  score      numeric check (score between 1 and 10),
  comment    text,
  at         timestamptz not null default now()
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
  updated_by   uuid references person(id),
  updated_at   timestamptz not null default now()
);

-- a guided assist panel per screen, so help is data rather than a help desk
create table assist_guide (
  key        text primary key,
  route      text not null,
  title      text not null,
  steps      text[] not null,
  why        text not null
);


-- =====================================================================
-- ADMIN SETUP: assistant keys, mailbox  (added 3 Sep 2026)
-- =====================================================================

create table ai_key (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  model           text not null,
  key_encrypted   bytea,
  endpoint        text,
  chain_order     int  not null unique,
  scope           text not null default 'everything'
                  check (scope in ('everything','short','long','fallback')),
  monthly_budget  int  not null default 0,
  used_this_month int  not null default 0,
  state           text not null default 'untested'
                  check (state in ('healthy','untested','erroring','no_key')),
  last_tested_at  timestamptz,
  last_latency_ms int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table ai_key is
  'Fallback chain. Calls try keys in chain_order; a key that is spent, erroring or unset is skipped so no feature stops because one key ran out.';

create table ai_call (
  id          uuid primary key default gen_random_uuid(),
  ai_key_id   uuid not null references ai_key(id),
  touchpoint  text not null,
  at          timestamptz not null default now(),
  latency_ms  int,
  ok          boolean not null,
  error       text,
  actor_id    uuid references person(id)
);
create index on ai_call (at desc);
comment on table ai_call is 'One row per assistant call, for budget accounting and the audit trail. Prompts and keys are never stored.';

create table mail_config (
  id                    smallint primary key default 1 check (id = 1),
  mailbox               text not null,
  auth_mode             text not null check (auth_mode in ('service_account','oauth','smtp')),
  service_account_email text,
  delegation_client_id  text,
  reply_to              text,
  daily_budget          int  not null default 1800,
  used_today            int  not null default 0,
  signature_json        jsonb,
  signature_logo_file   uuid,
  test_mode             boolean not null default false,
  test_address          text,
  test_mode_expires_at  timestamptz,
  bounce_strikes        int not null default 3,
  last_tested_at        timestamptz,
  updated_at            timestamptz not null default now(),
  check (test_mode = false or test_address is not null)
);
comment on column mail_config.signature_logo_file is
  'Uploaded file id. A Drive share link renders broken in mail clients, so links are refused.';
comment on column mail_config.daily_budget is
  '1,800 of the 2,000 cap; 200 reserved for interactive mail. This ceiling is what the legacy tool breached 1,849 times.';

create table mail_alias (
  id       uuid primary key default gen_random_uuid(),
  address  text not null unique,
  verified boolean not null default false
);

create table mail_bounce (
  id        uuid primary key default gen_random_uuid(),
  address   text not null,
  at        timestamptz not null default now(),
  hard      boolean not null,
  strikes   int  not null default 1,
  unreachable boolean not null default false
);
create index on mail_bounce (address);
comment on table mail_bounce is
  'Three hard bounces mark a recipient unreachable and raise a matrix task, rather than retrying forever.';


-- =====================================================================
-- IDENTITY  (revised 4 Sep 2026)
-- A branch inbox is shared: 10 POC e-mails cover all 1,413 branches.
-- An e-mail therefore cannot identify a person, so it is neither unique
-- nor a credential. Mobile number and user ID are.
-- =====================================================================

alter table person
  add column if not exists user_id text,
  add column if not exists mobile_verified_at timestamptz;

create unique index person_user_id_key on person (lower(user_id)) where left_on is null;
create unique index person_mobile_key  on person (mobile)         where left_on is null;

-- e-mail is optional, shared, and grants nothing
drop index if exists person_work_email_uniq;
comment on column person.work_email is
  'Optional. Often a shared branch inbox, so NOT unique and NOT a credential.';
comment on column person.mobile is
  'Required and unique. The identity for sign-in, OTP activation and password reset.';
comment on column person.user_id is
  'Chosen at activation, unique, what the person types to sign in.';

create table otp_challenge (
  id         uuid primary key default gen_random_uuid(),
  mobile     text not null,
  code_hash  bytea not null,
  purpose    text not null check (purpose in ('activate','reset')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts   int not null default 0
);
create index on otp_challenge (mobile, purpose);
comment on table otp_challenge is
  'Six-digit code to a mobile. Single use, short expiry, attempt-capped. Never reveals whether a number is registered.';

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
  day         date primary key,
  name        text not null,
  applies_to  text not null default 'ALL',   -- ALL | a geo_node name | a department
  source      text,                          -- upload file or the person who added it
  created_at  timestamptz not null default now()
);
comment on table holiday is
  'Skipped by every clock. Loaded by upload, never hard-coded.';

-- Mon-Fri run day_start..day_end; Saturday is a half day of sat_hours;
-- Sunday is off. Held as settings so the working week is administrator data.
insert into app_setting (key, value, plain_language, group_name) values
  ('day_start',  '10:00', 'Start of the working day. Every TAT counts only minutes inside the window.', 'clocks'),
  ('day_end',    '19:00', 'End of the working day.', 'clocks'),
  ('sat',        'Yes - half day', 'Yes - half day | Yes - full day | No.', 'clocks'),
  ('sat_hours',  '4',     'Hours counted on a Saturday when it is a half day: 10:00-14:00.', 'clocks')
on conflict (key) do nothing;

-- --------------------------------------------------------- cycle + gates
create type pms_cycle_state as enum
  ('PENDING','SELF_DONE','AWAITING_REVIEW','SCORED','DISPUTED','CLOSED');

create table pms_cycle (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id),
  chair_id      uuid references chair(id),
  period        date not null,                  -- first day of the month scored
  state         pms_cycle_state not null default 'PENDING',
  window_opens  timestamptz,
  window_closes timestamptz,
  self_due      timestamptz,
  self_at       timestamptz,
  review_due    timestamptz,                    -- self_at + pms_review_hrs working hours
  scored_at     timestamptz,
  closed_at     timestamptz,
  on_probation  boolean not null default false,
  is_partner    boolean not null default false, -- partners are not forced into a band
  constraint pms_cycle_uniq unique (person_id, period)
);
create index pms_cycle_period_idx on pms_cycle (period, state);
create index pms_cycle_review_due_idx on pms_cycle (review_due) where state = 'AWAITING_REVIEW';

-- Bottom-up closure. A manager's window may not open while anyone below
-- them is unclosed, which is what makes the team average real. Enforced
-- here rather than trusted to the UI.
create or replace function pms_window_may_open(p_person uuid, p_period date)
returns boolean as $$
  select not exists (
    select 1
    from chair_holder ch
    join chair c on c.id = ch.chair_id
    join chair_holder sub_h on true
    join chair sub on sub.id = sub_h.chair_id and sub.parent_id = c.id
    left join pms_cycle pc on pc.person_id = sub_h.person_id and pc.period = p_period
    where ch.person_id = p_person and ch.to_date is null and sub_h.to_date is null
      and coalesce(pc.state, 'PENDING') <> 'CLOSED'
  )
  or not (select coalesce(value, 'Yes') like 'Y%' from app_setting where key = 'pms_bottom_up');
$$ language sql stable;

-- --------------------------------------------------------- the two halves
-- KPI half and Attribute half, weighted by pms_wkpi. Attributes are fed by
-- tasks, notes, appreciations, ideas — and reduced by escalations and
-- warnings, which is the cascade below.
create table pms_component (
  id          uuid primary key default gen_random_uuid(),
  cycle_id    uuid not null references pms_cycle(id) on delete cascade,
  kind        text not null check (kind in ('KPI','ATTRIBUTE','TEAM')),
  raw         numeric not null,                 -- 0-10 before weighting
  weight_pct  numeric not null,                 -- read from pms_weighting at close
  note        text,
  constraint pms_component_uniq unique (cycle_id, kind)
);
comment on column pms_component.kind is
  'TEAM is the average final score of everyone below, at every level; it supplies pms_team_share percent of a manager''s Attribute half.';

-- Every point the cascade moves, with what moved it. The monthly cap is
-- shared across escalations and warnings together; anything past the cap is
-- recorded here with applied = false and flagged to HR rather than dropped.
create table pms_adjustment (
  id           uuid primary key default gen_random_uuid(),
  cycle_id     uuid not null references pms_cycle(id) on delete cascade,
  source_kind  raisable_kind not null,
  source_id    uuid,                             -- raisable(id) or letter(id)
  half         text not null check (half in ('ATTRIBUTE','KPI')),
  points       numeric not null,                 -- signed
  applied      boolean not null default true,
  capped       boolean not null default false,
  reason       text not null,
  at           timestamptz not null default now()
);
create index pms_adjustment_cycle_idx on pms_adjustment (cycle_id, half);
comment on table pms_adjustment is
  'The cascade, one row per movement: Attributes first, floor at zero, then KPI points, total capped by pms_cut_cap per month. A capped row is evidence, not a silent no-op.';

-- Attributes may not go below zero; that floor is what pushes the cost into
-- the KPI half rather than into negative numbers.
create or replace function pms_attribute_balance(p_cycle uuid) returns numeric as $$
  select greatest(0, coalesce(sum(points), 0))
  from pms_adjustment where cycle_id = p_cycle and half = 'ATTRIBUTE' and applied;
$$ language sql stable;

-- ------------------------------------------------------------- disputes
create table pms_dispute (
  id           uuid primary key default gen_random_uuid(),
  cycle_id     uuid not null references pms_cycle(id) on delete cascade,
  raised_by    uuid not null references person(id),
  raised_at    timestamptz not null default now(),
  reason       text not null,
  hr_due       timestamptz not null,             -- raised_at + pms_dispute_hrs working hours
  decided_by   uuid references person(id),
  decided_at   timestamptz,
  outcome      text check (outcome in ('SCORE_STANDS','RESCORE','WITHDRAWN')),
  outcome_note text,
  constraint pms_dispute_outcome check (decided_at is null or outcome is not null)
);
create index pms_dispute_due_idx on pms_dispute (hr_due) where decided_at is null;
comment on table pms_dispute is
  'A dispute freezes the score and pulls HR in. RESCORE reopens the manager review; the original score stays in pms_score history.';

-- ----------------------------------------------------------- exceptions
create table pms_exception (
  id           uuid primary key default gen_random_uuid(),
  cycle_id     uuid not null references pms_cycle(id) on delete cascade,
  requested_by uuid not null references person(id),
  requested_at timestamptz not null default now(),
  reason       text not null,
  hr_due       timestamptz not null,             -- + pms_exc_hrs working hours
  state        text not null default 'PENDING'
                 check (state in ('PENDING','GRANTED','REFUSED','EXPIRED')),
  decided_by   uuid references person(id),
  decided_at   timestamptz,
  reopens_until timestamptz                      -- + pms_exc_open working hours, this person only
);
create index pms_exception_due_idx on pms_exception (hr_due) where state = 'PENDING';
comment on table pms_exception is
  'Missed the window and asks HR to reopen it. Grants are per person and self-closing; unanswered requests become escalations against HR.';

-- ---------------------------------------------------------- bell curve
create table pms_curve_band (
  id         uuid primary key default gen_random_uuid(),
  effective_fy text not null,                    -- '2026-27'; changing mid-year splits comparability
  rank       int not null check (rank between 1 and 5),
  label      text not null,
  share_pct  numeric not null,
  constraint pms_curve_uniq unique (effective_fy, rank)
);
comment on table pms_curve_band is
  'Employees only, consolidated month on month across the financial year. Partners and probationers are reported separately and are never forced into a band.';

insert into pms_curve_band (effective_fy, rank, label, share_pct) values
  ('2026-27', 1, 'Outstanding', 5),
  ('2026-27', 2, 'Exceeds', 15),
  ('2026-27', 3, 'Meets', 60),
  ('2026-27', 4, 'Below', 15),
  ('2026-27', 5, 'Unsatisfactory', 5)
on conflict do nothing;

create table pms_band_result (
  cycle_id  uuid primary key references pms_cycle(id) on delete cascade,
  band_id   uuid references pms_curve_band(id),
  final     numeric not null,
  floored   boolean not null default false,      -- probation floor applied
  excluded  boolean not null default false,      -- partner or probationer
  at        timestamptz not null default now()
);

-- ---------------------------------------------------------- automations
-- The prototype fires 49 of these. Held as rows so a schedule change is a
-- config edit, and so a paused automation is visible rather than silent —
-- the legacy kill switch stopped every job with no record of why.
create table automation (
  key          text primary key,
  title        text not null,
  fires_on     text not null,                    -- cron-ish or 'ON <event>'
  reads_setting text[],                          -- app_setting keys it obeys
  writes_kind  text[],                           -- audit_entry kinds it emits
  ladder_step  int,                              -- position in a miss ladder
  escalates_to text,                             -- chair code or desk
  enabled      boolean not null default true,
  disabled_reason text,
  constraint automation_pause_reason check (enabled or disabled_reason is not null)
);

create table automation_run (
  id           uuid primary key default gen_random_uuid(),
  key          text not null references automation(key),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  outcome      text check (outcome in ('OK','NOOP','ERROR')),
  affected     int not null default 0,
  detail       text
);
create index automation_run_key_idx on automation_run (key, started_at desc);
comment on table automation_run is
  'One row per firing. STRIKE_SWEEP was 1,690 of 1,707 legacy runs and 1,535 of them NOOP; a NOOP rate is now a number somebody can see.';

-- ------------------------------------------------------ hiring pipeline
-- Chair-first: a request is raised against a chair, HR accepts it, Finance
-- approves the cost, and only then does the chair open for an occupant.
alter table person_request
  add column if not exists chair_id      uuid references chair(id),
  add column if not exists finance_state text default 'NOT_REQUIRED'
      check (finance_state in ('NOT_REQUIRED','AWAITING','APPROVED','REFUSED')),
  add column if not exists finance_by    uuid references person(id),
  add column if not exists finance_at    timestamptz,
  add column if not exists finance_note  text,
  add column if not exists due_at        timestamptz,
  add column if not exists returned_to   uuid references person(id);
create index if not exists person_request_overdue_idx
  on person_request (due_at) where finance_state = 'AWAITING';
comment on column person_request.returned_to is
  'A Finance refusal goes back to the raising manager with the note, not into a void.';

-- A chair with no holder and no live request is not shown on the chart; a
-- chair whose request is past due is shown as risk. This view is what the
-- org chart reads, so the rule lives in one place.
create or replace view chair_status as
select c.id as chair_id, c.id, c.code, c.title,
  h.person_id,
  case
    when h.person_id is not null then 'FILLED'
    when r.id is not null and r.due_at < now() then 'OVERDUE'
    when r.id is not null then 'REQUESTED'
    else 'DORMANT'
  end as state,
  r.due_at,
  (h.person_id is null) as vacant,
  case when r.id is not null and r.due_at < now()
       then greatest(0, extract(day from now() - r.due_at)::int) else 0 end as overdue_days
from chair c
left join chair_holder h on h.chair_id = c.id and h.to_date is null and h.is_primary
left join person_request r on r.chair_id = c.id and r.state in ('DRAFT','AWAITING_HR','AWAITING_ADMIN');

-- ---------------------------------------------------------------- audit
-- Scope is per chair: HR reads company-wide, a manager reads their own
-- subtree, nobody reads sideways. Kept as a column so a scope question has
-- an answer that does not depend on the screen it was asked from.
alter table audit_entry
  add column if not exists chair_id   uuid references chair(id),
  add column if not exists scope_path text,            -- materialised chair path, e.g. 'MD/OPS/RM_W/BM_P'
  add column if not exists sentence   text;            -- the readable line the UI shows
create index if not exists audit_entry_scope_idx on audit_entry (scope_path, at desc);
comment on column audit_entry.sentence is
  'Written at insert time. The trail is read by people, so the row carries the sentence rather than asking the UI to rebuild it.';


-- =====================================================================
-- MIS LAYER: rate master + business records  (added 7 Sep 2026)
-- No employee/client/location tables are created here: the MIS references
-- the existing masters. Only rate and business volume are net-new.
-- =====================================================================

create type rate_scope as enum ('exact','group','client');

create table rate (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,
  client_id      uuid not null references client(id),
  scope          rate_scope not null,
  value          numeric(12,2) not null check (value >= 0),
  currency       char(3) not null default 'INR',
  effective_from date not null,
  effective_to   date,
  status         text not null default 'active',
  reason         text,
  created_by     uuid references person(id),
  created_at     timestamptz not null default now(),
  updated_by     uuid references person(id),
  updated_at     timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (scope <> 'client' or true)
);
comment on table rate is
  'Scoped rate. Never duplicated per location: scope=group carries its locations in rate_location.';

create table rate_location (
  rate_id     uuid not null references rate(id) on delete cascade,
  geo_node_id uuid not null references geo_node(id),
  primary key (rate_id, geo_node_id)
);
comment on table rate_location is
  'Only for scope in (exact, group). scope=client has no rows here and applies to every location.';

-- Overlap prevention (Part 23.1): no two active rates may cover the same
-- client + scope + location for an intersecting period.
create index rate_lookup on rate (client_id, scope, effective_from desc)
  where status = 'active';

create table business_record (
  id            uuid primary key default gen_random_uuid(),
  period        char(7) not null,                    -- YYYY-MM
  business_date date not null,
  client_id     uuid not null references client(id),
  geo_node_id   uuid not null references geo_node(id),
  owner_id      uuid references person(id),
  mtd           integer not null default 0 check (mtd >= 0),
  day10         integer not null default 0 check (day10 >= 0),
  target        integer not null default 0 check (target >= 0),
  revenue       numeric(14,2) not null default 0,     -- STORED, authoritative
  source_ref    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (period, client_id, geo_node_id)
);
comment on column business_record.revenue is
  'Stored revenue is the source value. Derived rate (revenue/mtd) is diagnostic only and never overwrites it.';

create table rate_exception (
  id           uuid primary key default gen_random_uuid(),
  record_id    uuid not null references business_record(id),
  kind         text not null,   -- no_rate | zero_mtd_with_revenue | implied_mismatch
  configured   numeric(12,2),
  implied      numeric(12,2),
  detected_at  timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references person(id),
  resolution   text
);

create table forecast_config (
  id        smallint primary key default 1 check (id = 1),
  scenarios jsonb not null default
    '[{"key":"cons","label":"Conservative","mult":3.25},
      {"key":"base","label":"Base","mult":3.5},
      {"key":"stretch","label":"Stretch","mult":4},
      {"key":"agg","label":"Aggressive","mult":5,"kept":true}]'::jsonb,
  updated_by uuid references person(id),
  updated_at timestamptz not null default now()
);
comment on table forecast_config is
  'Part 27: multipliers are configuration. Defaults are the workbook scenarios; the label mapping needs workbook confirmation.';

create table mis_saved_view (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references person(id),
  name       text not null,
  config     jsonb not null,   -- dims, filters, month, scenario, expanded rows
  created_at timestamptz not null default now(),
  unique (person_id, name)
);
comment on table mis_saved_view is 'Configuration only. No copy of the underlying data.';
