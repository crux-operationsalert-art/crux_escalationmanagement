-- =====================================================================
-- CRUX — schema patch v5
-- Reconciles the schema with what the application and the API actually do,
-- on the evidence of the prototype rather than on inference:
--   · a daily filing is ONE submission per person per day, carrying every
--     KPI figure — not one row per KPI
--   · a person request carries the employment type, and there are four of
--     them, not two
--   · the PMS clocks are administrator data, not constants in code
-- Additive and idempotent except where a contradiction has to be removed,
-- which is called out at the point it happens.
-- Run after schema-patch-v4.sql.
-- =====================================================================

-- ------------------------------------------------- the daily filing grain
-- The prototype holds ONE object for the day (S.daily, keyed by KPI index,
-- sub-categories under 'i.j'), submitted by one button, closed by one 23:59
-- cutoff, and missed as a single event that fires rule P-01 — the evidence
-- line in IMPLEMENTATION.md is literally "no daily_count for 2026-09-01",
-- naming a person and a date and no KPI.
--
-- schema-patch-v3 already asserted that grain with a unique index on
-- (person_id, count_date). The base table never caught up: it still carries
-- kpi_id/value NOT NULL and a unique on (person_id, count_date, kpi_id),
-- which together limited a person to filing exactly ONE KPI per day and made
-- the documented "5 KPIs per person" impossible to file. This resolves that
-- contradiction in favour of the grain the application, the automations and
-- the penalty rule all assume.

alter table daily_count add column if not exists values jsonb;
comment on column daily_count.values is
  'The day''s figures, keyed by KPI. Sub-categories hang off their parent key. '
  'One row per person per day: the filing is a single act with a single cutoff.';

-- kpi_id/value described the old one-row-per-KPI shape. Kept, so a single-KPI
-- filing can still be read back, but no longer required.
alter table daily_count alter column kpi_id drop not null;
alter table daily_count alter column value  drop not null;

-- the contradiction itself: this constraint and daily_count_person_date_uniq
-- cannot both describe the same table.
alter table daily_count drop constraint if exists daily_count_uniq;

-- A filing carries figures one way or the other. Belt and braces so the table
-- cannot hold a row that says nothing.
alter table daily_count drop constraint if exists daily_count_has_figures;
alter table daily_count add constraint daily_count_has_figures
  check (values is not null or (kpi_id is not null and value is not null));

-- ------------------------------------------------------ employment type
-- The "Add a person" form offers four: Employee · payroll, Franchise partner ·
-- billed, Intern · project based, Contract. penalty_recovery_for() only asks
-- whether somebody is a PARTNER, so the other three route to payroll as before.
alter table person drop constraint if exists person_employee_type_check;
alter table person add constraint person_employee_type_check
  check (employee_type in ('EMPLOYEE','PARTNER','INTERN','CONTRACT'));

alter table person_request add column if not exists employee_type text not null default 'EMPLOYEE';
alter table person_request drop constraint if exists person_request_employee_type_check;
alter table person_request add constraint person_request_employee_type_check
  check (employee_type in ('EMPLOYEE','PARTNER','INTERN','CONTRACT'));
comment on column person_request.employee_type is
  'Captured when the request is raised, because HR approves the terms as well '
  'as the chair. Carried onto the person at account creation.';

-- ------------------------------------------------------------ PMS clocks
-- The dispute and exception clocks were described in comments but never given
-- a row, so the API had to hard-code them. Both are working-hours clocks.
insert into setting (key, value) values
  ('pms_dispute_hrs','48'),
  ('pms_exc_hrs','48'),
  ('pms_exc_open','48')
on conflict (key) do nothing;
