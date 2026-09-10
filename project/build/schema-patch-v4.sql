-- =====================================================================
-- CRUX — schema patch v4
-- Covers everything added to the application after schema.sql was written:
--   · daily filing for every chair, whatever the KPI's cadence
--   · offline queue: entry time and receipt time are different facts
--   · assigned-handler basis for the MIS final count
--   · person performance history: monthly achieved, revenue, collections
--   · role-change history that follows the person, not the chair
--   · OGL attachments, per party and per case
--   · corrections that overwrite but keep the previous value
-- Idempotent: safe to run more than once.
-- =====================================================================

-- ------------------------------------------------------------- cadence
-- Cadence belongs to the KPI, not to the update. Everybody files daily;
-- a count adds to its period, a rate replaces the period-to-date level.
do $$ begin
  create type kpi_cadence as enum ('DAILY','WEEKLY','MONTHLY','QUARTERLY');
exception when duplicate_object then null; end $$;

do $$ begin
  create type kpi_accrual as enum ('ADDS','REPLACES');
exception when duplicate_object then null; end $$;

alter table kpi_definition
  add column if not exists cadence kpi_cadence not null default 'DAILY',
  add column if not exists accrual kpi_accrual not null default 'ADDS';

comment on column kpi_definition.accrual is
  'ADDS: today''s figure is added to the period total (counts, rupees). '
  'REPLACES: today''s figure replaces the period-to-date level (percentages, scores). '
  'Derived at seed time from unit, then owned by the administrator.';

-- rates and scores replace; everything else adds
update kpi_definition set accrual = 'REPLACES'
 where accrual = 'ADDS' and (unit ilike '%\%%' or unit ilike '%score%');

-- ---------------------------------------------------- the daily filing
-- Two timestamps, never conflated. entered_at is when the person typed it,
-- taken from the device; received_at is when the server got it. An offline
-- filing has a gap between them and the business rule reads both.
alter table daily_count
  add column if not exists entered_at      timestamptz,
  add column if not exists received_at     timestamptz not null default now(),
  add column if not exists entered_offline boolean     not null default false,
  add column if not exists device_ref      text,
  add column if not exists sync_attempts   int         not null default 0,
  add column if not exists late_sync       boolean     not null default false;

update daily_count set entered_at = received_at where entered_at is null;
alter table daily_count alter column entered_at set not null;

-- Rule, as decided: a filing counts for the day it was ENTERED provided it
-- reaches the server within 24 hours. Past that it is refused at the API and
-- needs an administrator reopen. Enforced here so no client can bypass it.
alter table daily_count drop constraint if exists daily_count_sync_window;
alter table daily_count add constraint daily_count_sync_window
  check (received_at <= entered_at + interval '24 hours');

comment on constraint daily_count_sync_window on daily_count is
  'A filing older than 24 hours cannot be inserted. Beyond the window the row '
  'must come through the administrator reopen path, which records a reason.';

-- A device clock that disagrees with the server by more than a day is not
-- trusted. Flagged rather than silently accepted.
alter table daily_count
  add column if not exists clock_skew_flag boolean not null default false;

-- ------------------------------------------------- the assigned handler
-- The MIS final count reads the assigned handler's figure only. A manager's
-- own filing is real work and is kept, but it is supervision, not throughput —
-- adding it would count the same case at every level it passes through.
alter table coverage_rule
  add column if not exists is_assigned_handler boolean not null default false;

comment on column coverage_rule.is_assigned_handler is
  'True for the person who owns this client x location. Exactly one per pair '
  'per period; the MIS final count sums these rows and nothing else.';

create unique index if not exists coverage_one_handler
  on coverage_rule (client_id, geo_node_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_assigned_handler and effective_to is null;

alter table daily_count
  add column if not exists counts_to_mis boolean not null default false;

comment on column daily_count.counts_to_mis is
  'Set by the API from the filer''s coverage_rule at insert time, not by the '
  'client. Denormalised deliberately: the MIS report must not change meaning '
  'when a coverage rule is edited months later.';

-- ------------------------------------------------- performance history
-- What bulk upload loads and what the six-month trend and the appraisal
-- comparison read. Three shapes, one key each, kept apart because they
-- reconcile against different things.
create table if not exists perf_month (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id),
  period        date not null,                     -- first of month
  kpi_id        uuid references kpi_definition(id),
  kpi_name      text not null,
  sub_category  text,
  unit          text,
  target_value  numeric,
  achieved      numeric not null,
  mtd_achieved  numeric,
  source        text,
  source_ref    text,
  loaded_by     uuid references person(id),
  loaded_at     timestamptz not null default now(),
  constraint perf_month_uniq unique (person_id, period, kpi_name, sub_category)
);
comment on table perf_month is
  'Monthly achieved per person per KPI. Loaded oldest month first. A row whose '
  'kpi_name has no matching kpi_target for that person and month is rejected at '
  'load rather than creating a stray KPI.';

create table if not exists perf_revenue (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references client(id),
  geo_node_id       uuid references geo_node(id),
  branch_id         uuid references branch(id),
  period            date not null,
  invoiced_inr      bigint not null,
  realised_inr      bigint not null,
  owner_person_id   uuid references person(id),
  remarks           text,
  source_ref        text,
  loaded_by         uuid references person(id),
  loaded_at         timestamptz not null default now(),
  constraint perf_revenue_uniq unique (client_id, geo_node_id, branch_id, period)
);
comment on column perf_revenue.owner_person_id is
  'Who owned the figure at the time. Recorded for attribution; moving the owner '
  'later does not move the history.';

create table if not exists perf_collection (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid not null references client(id),
  geo_node_id               uuid references geo_node(id),
  branch_id                 uuid references branch(id),
  period                    date not null,
  opening_outstanding_inr   bigint not null,
  collected_inr             bigint not null,
  closing_outstanding_inr   bigint not null,
  owner_person_id           uuid references person(id),
  source_ref                text,
  loaded_by                 uuid references person(id),
  loaded_at                 timestamptz not null default now(),
  constraint perf_collection_uniq unique (client_id, geo_node_id, branch_id, period),
  -- a collections file that does not balance is the one import you never
  -- want half-applied; refused at the row, named in the preview
  constraint perf_collection_balances
    check (opening_outstanding_inr - collected_inr = closing_outstanding_inr)
);

create index if not exists perf_month_person_idx on perf_month (person_id, period desc);
create index if not exists perf_revenue_period_idx on perf_revenue (period desc);
create index if not exists perf_collection_period_idx on perf_collection (period desc);

-- ------------------------------------------------ role change history
-- History follows the PERSON. A chair that changes hands keeps its KPI
-- definition; the person keeps their score and their trail.
create table if not exists role_change (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id),
  from_chair_id uuid references chair(id),
  to_chair_id   uuid references chair(id),
  from_title    text,
  to_title      text,
  kind          text not null default 'MOVE'
                check (kind in ('JOIN','MOVE','PROMOTION','LATERAL','EXIT')),
  from_date     date not null,
  to_date       date,
  reason        text,
  approved_by   uuid references person(id),
  recorded_at   timestamptz not null default now()
);
create index if not exists role_change_person_idx on role_change (person_id, from_date desc);

-- one open segment per person: you cannot hold two current roles
create unique index if not exists role_change_one_open
  on role_change (person_id) where to_date is null;

-- ------------------------------------------------------- OGL documents
-- Filed against the party they belong to, not dumped in one pile: an RFI
-- usually asks for one party's paperwork, not the whole case.
do $$ begin
  create type ogl_party_kind as enum ('CASE','APPLICANT','CO_APPLICANT','GUARANTOR');
exception when duplicate_object then null; end $$;

create table if not exists ogl_attachment (
  id           uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  party_kind   ogl_party_kind not null,
  party_seq    int not null default 0,        -- 1-based for co-applicants/guarantors
  doc_kind     text not null,
  file_name    text not null,
  storage_key  text not null,
  bytes        bigint,
  mime         text,
  uploaded_by  uuid not null references person(id),
  uploaded_at  timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid references person(id)
);
create index if not exists ogl_attachment_case_idx
  on ogl_attachment (assignment_id) where removed_at is null;

comment on column ogl_attachment.party_seq is
  'Zero for CASE and APPLICANT. One-based for CO_APPLICANT and GUARANTOR, so a '
  'document stays attached to the right party when another is added above it.';

-- Removal is never a delete. The row stays, marked, so a document that was
-- present at assignment time can still be proven to have been present.
comment on column ogl_attachment.removed_at is
  'Soft removal. A document that existed when the assignment was created must '
  'remain provable even after the assignor takes it off the live list.';

-- --------------------------------------------------------- corrections
-- Overwrite in the table, keep the previous value in the log. Zero data loss
-- means the earlier figure is always recoverable, not merely that a change
-- was noticed.
create table if not exists value_correction (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null,
  entity_id     uuid not null,
  column_name   text not null,
  previous_value text,
  new_value     text,
  reason        text not null,
  corrected_by  uuid not null references person(id),
  corrected_at  timestamptz not null default now(),
  reopened_day  date
);
create index if not exists value_correction_entity_idx
  on value_correction (entity_type, entity_id, corrected_at desc);

comment on table value_correction is
  'Every overwrite writes one row here carrying the value that was replaced. '
  'A disputed number always has an earlier version to compare against.';

-- A correction without a reason is not a correction.
alter table value_correction drop constraint if exists value_correction_reason_real;
alter table value_correction add constraint value_correction_reason_real
  check (length(btrim(reason)) >= 8);

-- ------------------------------------------------ reopen a locked day
-- Administrator only, as decided. Recorded, time-boxed, and the reason
-- travels with the corrected figure.
create table if not exists day_reopen (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references person(id),
  day          date not null,
  reason       text not null,
  opened_by    uuid not null references person(id),
  opened_at    timestamptz not null default now(),
  closes_at    timestamptz not null,
  closed_at    timestamptz,
  constraint day_reopen_window check (closes_at > opened_at)
);
create unique index if not exists day_reopen_one_open
  on day_reopen (person_id, day) where closed_at is null;

-- --------------------------------------------- penalty dispute evidence
-- The P-01 penalty applies whatever the cause, and is disputable with the
-- device sync log attached automatically.
alter table penalty_instance
  add column if not exists sync_evidence jsonb;

comment on column penalty_instance.sync_evidence is
  'Attached by the API when the penalty is for a missed daily filing and the '
  'device reported failed sync attempts. The reviewer sees whether the phone '
  'actually tried, without the person having to argue it.';
