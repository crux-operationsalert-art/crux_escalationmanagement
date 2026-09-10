-- =====================================================================
-- v3 PATCH — the columns and functions build/api/ assumes.
-- Additive only: no table is rewritten, no constraint is relaxed.
-- Run after schema.sql, before build/migration/.
-- Written 7 Sep 2026.
-- =====================================================================

-- 1 · sessions are credentials, so only the hash is stored (defect 3)
alter table auth_session add column if not exists token_hash text;
create unique index if not exists auth_session_token_uniq on auth_session (token_hash) where token_hash is not null;

-- field staff sign in with a password; Workspace people never have one
alter table person add column if not exists password_hash text;
alter table person add column if not exists password_salt text;
comment on column person.password_hash is
  'scrypt. Null for Workspace SSO accounts, which must not be able to fall back to a password.';

-- 2 · the outbox needs to remember why it failed and how often (defect 1)
alter table outbox add column if not exists attempts   int  not null default 0;
alter table outbox add column if not exists last_error text;
alter table outbox add column if not exists sent_at    timestamptz;

-- 3 · an action's effect belongs in the table, not in a switch statement:
--     the UI renders the buttons from this and the API validates from it too
alter table escalation_action add column if not exists sets_status     case_status;
alter table escalation_action add column if not exists valid_statuses  case_status[];
alter table escalation_action add column if not exists allowed_parts   esc_party[] not null default '{}';
alter table escalation_action add column if not exists needs_note      boolean not null default false;

-- 4 · settings: 44 PMS numbers and every threshold live here, never in code
create table if not exists setting (
  key        text primary key,
  value      text not null,
  updated_by uuid references person(id),
  updated_at timestamptz not null default now()
);
comment on table setting is
  'Every tunable number. If a value appears in application code instead of here, that is a defect.';

-- 5 · the working-hours clock: 24 working hours, Mon-Sat 10:00-19:00,
--     Saturday a half day, holidays excluded. One function, one definition.
create or replace function working_hours_after(p_from timestamptz, p_hours numeric)
returns timestamptz as $$
declare
  cur   timestamptz := p_from;
  left_ numeric     := p_hours;
  open_h  int := coalesce((select value::int from setting where key = 'day_open_hour'), 10);
  close_h int := coalesce((select value::int from setting where key = 'day_close_hour'), 19);
  sat_h   numeric := coalesce((select value::numeric from setting where key = 'sat_hours'), 4);
  sat_on  boolean := coalesce((select value = 'true' from setting where key = 'sat'), true);
  day_cap numeric;
  avail   numeric;
begin
  while left_ > 0 loop
    if extract(dow from cur) = 0
       or (extract(dow from cur) = 6 and not sat_on)
       or exists (select 1 from holiday h where h.day = cur::date) then
      cur := date_trunc('day', cur) + interval '1 day' + (open_h || ' hours')::interval;
      continue;
    end if;
    day_cap := case when extract(dow from cur) = 6 then sat_h else close_h - open_h end;
    if cur::time < (open_h || ':00')::time then
      cur := date_trunc('day', cur) + (open_h || ' hours')::interval;
    end if;
    avail := least(day_cap, extract(epoch from ((date_trunc('day', cur) + ((open_h + day_cap) || ' hours')::interval) - cur)) / 3600.0);
    if avail <= 0 then
      cur := date_trunc('day', cur) + interval '1 day' + (open_h || ' hours')::interval;
      continue;
    end if;
    if left_ <= avail then
      return cur + (left_ || ' hours')::interval;
    end if;
    left_ := left_ - avail;
    cur := date_trunc('day', cur) + interval '1 day' + (open_h || ' hours')::interval;
  end loop;
  return cur;
end;
$$ language plpgsql stable;

-- 6 · PMS: an adjustment past the shared cap is recorded and flagged, not dropped
alter table pms_adjustment add column if not exists over_cap boolean not null default false;
alter table pms_adjustment add column if not exists actor_id uuid references person(id);
comment on column pms_adjustment.over_cap is
  'True when this movement exceeded the 2-point shared monthly cap. The movement still stands; HR is notified.';

alter table pms_exception add column if not exists created_at timestamptz not null default now();
alter table pms_exception add column if not exists due_at     timestamptz;
comment on column pms_exception.due_at is 'created_at + 48 hours. The clock the requester sees.';

-- 7 · notes feed Attribute scores only once classified
alter table person_event add column if not exists note_class note_class not null default 'UNCLASSIFIED';
alter table person_event add column if not exists actor_id   uuid references person(id);

-- 8 · one row per person per day, one target per KPI per period
create unique index if not exists daily_count_person_date_uniq on daily_count (person_id, count_date);
create unique index if not exists kpi_target_period_uniq       on kpi_target (kpi_id, period);

-- 9 · hiring requests carry their own clock, like exceptions
alter table person_request add column if not exists created_at timestamptz not null default now();
alter table person_request add column if not exists due_at     timestamptz;
alter table person_request add column if not exists person_id  uuid references person(id);

-- 10 · audit scope, so a chair's trail can be read without reading everyone's
alter table audit_entry add column if not exists scope_chair_id uuid references chair(id);
comment on column audit_entry.scope_chair_id is
  'Null means company-wide. Set means the entry is visible to that chair and its ancestors.';

-- =====================================================================
-- seed: the settings the code reads by name, with the owner's numbers
-- =====================================================================
insert into setting (key, value) values
  ('day_open_hour','10'), ('day_close_hour','19'), ('sat','true'), ('sat_hours','4'),
  ('chase_hours','24'), ('auto_close_days','7'),
  ('pms_monthly_cap','2'), ('pms_probation_floor','5'), ('pms_team_share','0.5'),
  ('curve_band_1','5'), ('curve_band_2','15'), ('curve_band_3','60'),
  ('curve_band_4','15'), ('curve_band_5','5'),
  ('mail_daily_cap','1500'), ('mail_spread_above','1200'),
  ('whatsapp','Not connected')
on conflict (key) do nothing;
