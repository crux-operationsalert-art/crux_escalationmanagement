-- =====================================================================
-- CRUX — schema patch v13
-- OGL: the ops-to-ops verification assignment module.
--
-- Until now `ogl_assignment` was a record type the Opening balances loader
-- refused, because there was nothing to load it into. OGL_IMPLEMENTATION.md
-- specifies a module, not a table: a case, its parties and verification
-- points, an assignment with fourteen states, an SLA clock measured in
-- business minutes, and requests that pause it.
--
-- The idea the spec asks to hold on to, and which this keeps:
--   current_state is the operational position and NOTHING else. sla_status,
--   escalation level, priority bucket and open_request_type are orthogonal
--   attributes. A breached assignment is still IN_PROGRESS and still shows
--   its operator the correct next action.
--
-- Two deliberate departures from the spec, both stated where they happen:
--
--   · The spec adds business_calendar + calendar_holiday. This schema
--     already has `holiday`, loaded, and carrying the confirmed flag the
--     whole deadline rule turns on. A second holiday table would drift, and
--     the one that drifts is the one nobody loads — which is precisely how
--     the old system read an empty HOLIDAYS tab for two years. So the
--     calendar keeps the window and the working days; the holidays stay in
--     `holiday`.
--
--   · The spec enforces "the transition service is the sole writer of
--     current_state" with REVOKE UPDATE (current_state). service_role
--     bypasses a column grant, so it is a trigger here instead. Same rule,
--     enforced against every role rather than most of them.
--
-- Not built yet, and not pretended: the conditional-pause arithmetic on
-- RFIs, delay auto-accept, the escalation sweep, strike generation, and
-- monthly partitions on assignment_event. The tables they write to exist.
--
-- Run after schema-patch-v12-columns.sql.
-- =====================================================================

-- ------------------------------------------------------------ calendar
create table if not exists business_calendar (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  geo_node_id     uuid references geo_node(id),
  window_start    time not null default '10:00',
  window_end      time not null default '17:00',
  works_saturday  boolean not null default false,
  works_sunday    boolean not null default false,
  timezone        text not null default 'Asia/Kolkata',
  effective_from  date not null default current_date,
  effective_to    date,
  check (window_end > window_start)
);
comment on table business_calendar is
  'Working window and working days. Holidays are not duplicated here - they '
  'come from holiday where confirmed, so there is one calendar to load and '
  'one to keep right.';

insert into business_calendar (code, window_start, window_end, effective_from)
values ('DEFAULT', '10:00', '17:00', current_date)
on conflict (code) do nothing;

create table if not exists reason_taxonomy (
  id                  uuid primary key default gen_random_uuid(),
  context             text not null,
  code                text not null,
  label               text not null,
  requires_remarks    boolean not null default true,
  implied_attribution text,
  active              boolean not null default true,
  unique (context, code)
);

create table if not exists verification_type (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  label             text not null,
  requires_point_id boolean not null default true,
  active            boolean not null default true
);

insert into verification_type (code, label, requires_point_id) values
  ('RESIDENT','Resident verification',true),
  ('BUSINESS','Business verification',true),
  ('EMPLOYEE','Employment verification',true),
  ('QUOTATION','Quotation check',false)
on conflict (code) do nothing;

-- ------------------------------------------- case, parties, requirements
create table if not exists verification_case (
  id                 uuid primary key default gen_random_uuid(),
  force1_case_id     text not null unique,
  client_id          uuid not null references client(id),
  branch_id          uuid references branch(id),
  applicant_name     text not null,
  applicant_contact  text not null,
  applicant_address  text not null,
  pincode            text not null,
  completeness_score int,
  created_by         uuid not null references person(id),
  created_at         timestamptz not null default now()
);
create index if not exists verification_case_client_idx
  on verification_case (client_id, created_at desc);

create table if not exists case_party (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references verification_case(id) on delete cascade,
  party_role        text not null,
  seq_no            int not null,
  name              text not null,
  contact           text,
  address           text,
  same_as_applicant boolean not null default false,
  unique (case_id, party_role, seq_no)
);
comment on table case_party is
  'A guarantor who is also a co-applicant is ONE party row with two '
  'requirement rows against it. Two party rows would double-count the person '
  'on every report.';

create table if not exists case_verification_requirement (
  id                   uuid primary key default gen_random_uuid(),
  case_id              uuid not null references verification_case(id) on delete cascade,
  party_id             uuid not null references case_party(id),
  verification_type_id uuid not null references verification_type(id),
  force1_point_id      text not null,
  attempt_no           int not null default 1,
  lineage              text not null default 'ORIGINAL',
  supersedes_id        uuid references case_verification_requirement(id),
  status               text not null default 'PENDING',
  unique (force1_point_id, attempt_no)
);
comment on column case_verification_requirement.force1_point_id is
  'Keyed by hand, so NOT globally unique - a repeat of the same Point ID is a '
  'legitimate business event, routed by repeat_point_decision.';
create index if not exists cvr_case_status_idx on case_verification_requirement (case_id, status);
create index if not exists cvr_point_attempt_idx on case_verification_requirement (force1_point_id, attempt_no desc);
create unique index if not exists cvr_one_live_point
  on case_verification_requirement (force1_point_id)
  where status in ('PENDING','IN_PROGRESS','REPORTED','DISPUTED');

create table if not exists repeat_point_decision (
  id                   uuid primary key default gen_random_uuid(),
  force1_point_id      text not null,
  prior_requirement_id uuid not null references case_verification_requirement(id),
  new_requirement_id   uuid references case_verification_requirement(id),
  address_match        text not null,
  match_score          int,
  proposed             text not null,
  decision             text,
  decided_by           uuid references person(id),
  decided_at           timestamptz,
  reason               text,
  asked_at             timestamptz not null default now(),
  unique (force1_point_id, prior_requirement_id, asked_at)
);
comment on table repeat_point_decision is
  'A repeat Point ID is not a duplicate to refuse - it is a decision to '
  'route, and it belongs to the assignor. Undecided rows are a queue with an '
  'owner, not a silent backlog.';
create index if not exists rpd_undecided_idx on repeat_point_decision (asked_at) where decision is null;

-- ---------------------------------------------------------- assignment
create table if not exists assignment (
  id                   uuid primary key default gen_random_uuid(),
  ref                  text not null unique,
  case_id              uuid not null references verification_case(id),
  assignor_id          uuid not null references person(id),
  assignor_chair_id    uuid not null references chair(id),
  from_location_id     uuid not null references geo_node(id),
  to_location_id       uuid not null references geo_node(id),
  allocated_to_id      uuid references person(id),
  current_state        text not null default 'DRAFT',
  next_action_owner_id uuid references person(id),
  breach_cycle_no      int not null default 1,
  delay_count          int not null default 0,
  dispute_count        int not null default 0,
  open_request_type    text,
  priority_score       int not null default 0,
  priority_bucket      text not null default 'Normal',
  self_assign_reason   text,
  source_ref           text,
  created_at           timestamptz not null default now(),
  closed_at            timestamptz,
  check (delay_count <= 3),
  check (dispute_count <= 2),
  check (to_location_id <> from_location_id or self_assign_reason is not null)
);
comment on column assignment.current_state is
  'The operational position and nothing else. sla_status, escalation level, '
  'priority bucket and open_request_type are orthogonal attributes, not '
  'states: a breached assignment is still IN_PROGRESS and still shows its '
  'operator the correct next action. Written only by ogl_transition().';

create index if not exists assignment_action_idx
  on assignment (next_action_owner_id, priority_score desc, created_at) where closed_at is null;
create index if not exists assignment_assignor_idx on assignment (assignor_id, created_at desc);
create index if not exists assignment_team_idx
  on assignment (to_location_id, current_state, priority_score desc);
create index if not exists assignment_case_idx on assignment (case_id);
create unique index if not exists assignment_one_live
  on assignment (case_id, current_state)
  where current_state in ('SUBMITTED','ASSIGNED','ACCEPTED','IN_PROGRESS');

create table if not exists assignment_completion (
  id               uuid primary key default gen_random_uuid(),
  assignment_id    uuid not null references assignment(id),
  breach_cycle_no  int not null,
  shared_at        timestamptz not null,
  submitted_at     timestamptz not null default now(),
  channel          text not null,
  recipient        text,
  message_ref      text,
  force1_ref       text,
  backdate_flagged boolean not null default false,
  other_remarks    text,
  submitted_by     uuid not null references person(id),
  unique (assignment_id, breach_cycle_no)
);
comment on table assignment_completion is
  'Insert only. A dispute creates the next cycle''s row; the disputed one '
  'stays exactly as submitted.';

-- ----------------------------------------------------------------- SLA
create table if not exists sla_rule (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null,
  version              int not null,
  client_id            uuid references client(id),
  verification_type_id uuid references verification_type(id),
  geo_node_id          uuid references geo_node(id),
  qty_band_min         int,
  qty_band_max         int,
  priority             text,
  tat_business_minutes int not null,
  grace_minutes        int not null default 0,
  at_risk_pct          int not null default 75,
  specificity          int not null default 0,
  effective_from       date not null default current_date,
  effective_to         date,
  unique (code, version)
);
create index if not exists sla_rule_match_idx
  on sla_rule (client_id, verification_type_id, geo_node_id, specificity desc);

create table if not exists sla_instance (
  id                   uuid primary key default gen_random_uuid(),
  assignment_id        uuid not null references assignment(id),
  breach_cycle_no      int not null,
  sla_rule_id          uuid not null references sla_rule(id),
  rule_trace           jsonb not null default '{}',
  calendar_id          uuid not null references business_calendar(id),
  tat_business_minutes int not null,
  started_at           timestamptz not null,
  due_at               timestamptz not null,
  extended_to          timestamptz,
  stopped_at           timestamptz,
  sla_status           text not null default 'ON_TRACK',
  unique (assignment_id, breach_cycle_no)
);
comment on column sla_instance.tat_business_minutes is
  'A snapshot. A later rule change never moves a live clock.';
comment on column sla_instance.rule_trace is
  'Which dimensions matched, the specificity arithmetic, the runners-up. When '
  'someone asks in three months why this got 26 hours and not 24, the answer '
  'is in the row.';
create index if not exists sla_sweep_idx on sla_instance (sla_status, due_at) where stopped_at is null;

create table if not exists sla_clock_segment (
  id               uuid primary key default gen_random_uuid(),
  sla_instance_id  uuid not null references sla_instance(id),
  seq_no           int not null,
  segment_state    text not null,
  attribution      text not null,
  counts_to_sla    boolean not null,
  counts_to_strike boolean not null,
  reason_id        uuid references reason_taxonomy(id),
  reason_text      text,
  opened_at        timestamptz not null,
  closed_at        timestamptz,
  business_minutes int,
  set_by           uuid references person(id),
  unique (sla_instance_id, seq_no)
);
-- one open segment at a time, enforced rather than assumed
create unique index if not exists sla_one_open_segment
  on sla_clock_segment (sla_instance_id) where closed_at is null;
comment on table sla_clock_segment is
  'Elapsed and exposure are DERIVED, never stored: elapsed = sum(business_'
  'minutes) where counts_to_sla; strike exposure = the same where '
  'counts_to_strike and attribution = ASSIGNEE.';

create table if not exists assignment_request (
  id                     uuid primary key default gen_random_uuid(),
  assignment_id          uuid not null references assignment(id),
  breach_cycle_no        int not null,
  request_type           text not null,
  seq_no                 int not null,
  raised_by              uuid not null references person(id),
  raised_at              timestamptz not null default now(),
  reason_id              uuid references reason_taxonomy(id),
  remarks                text,
  delay_category         text,
  expected_completion    timestamptz,
  sub_tat_minutes        int,
  sub_tat_due_at         timestamptz,
  sub_tat_breached       boolean not null default false,
  pause_granted          boolean not null default false,
  pause_minutes_credited int not null default 0,
  resolution             text,
  resolved_by            uuid references person(id),
  resolved_at            timestamptz,
  resolution_remarks     text,
  unique (assignment_id, request_type, breach_cycle_no, seq_no)
);
create unique index if not exists ar_one_open on assignment_request (assignment_id) where resolved_at is null;
create index if not exists ar_subtat_idx on assignment_request (sub_tat_due_at)
  where resolved_at is null and sub_tat_breached = false;

create table if not exists assignment_event (
  id             bigserial primary key,
  assignment_id  uuid not null references assignment(id),
  event_type     text not null,
  occurred_at    timestamptz not null default now(),
  actor_id       uuid references person(id),
  actor_chair_id uuid references chair(id),
  is_system      boolean not null default false,
  from_state     text,
  to_state       text,
  payload        jsonb not null default '{}'
);
create index if not exists ae_assignment_idx on assignment_event (assignment_id, occurred_at);
create index if not exists ae_type_idx on assignment_event (event_type, occurred_at desc);
comment on table assignment_event is
  'Append only. The spec partitions this monthly; unpartitioned here until '
  'the volume justifies the job that creates partitions ahead of time.';

create table if not exists ogl_escalation_matrix (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid references client(id),
  location_id      uuid references geo_node(id),
  branch_id        uuid references branch(id),
  escalation_level int not null check (escalation_level between 1 and 4),
  chair_id         uuid references chair(id),
  person_id        uuid references person(id)
);
comment on table ogl_escalation_matrix is
  'The INTERNAL matrix. The client contact directory is a different table and '
  'is reused as exactly that.';

-- =====================================================================
-- The business-minute clock.
-- "No arithmetic on wall-clock timestamps anywhere in the codebase."
-- Both functions read the window and the working days from the calendar and
-- the holidays from `holiday` where confirmed — an unconfirmed festival
-- shows on the calendar and shortens nothing.
-- =====================================================================

create or replace function ogl_is_working_day(p_day date, p_cal uuid)
returns boolean language sql stable set search_path = public as $fn$
  select case extract(isodow from p_day)
           when 6 then (select works_saturday from business_calendar where id = p_cal)
           when 7 then (select works_sunday   from business_calendar where id = p_cal)
           else true
         end
     and not exists (select 1 from holiday h where h.day = p_day and h.confirmed)
$fn$;

create or replace function business_minutes_between(p_from timestamptz, p_to timestamptz, p_cal uuid)
returns int language plpgsql stable set search_path = public as $fn$
declare
  c business_calendar%rowtype;
  v_day date; v_total int := 0;
  v_start timestamptz; v_end timestamptz; v_a timestamptz; v_b timestamptz;
begin
  if p_to <= p_from then return 0; end if;
  select * into c from business_calendar where id = p_cal;
  if not found then raise exception 'no such calendar'; end if;

  v_day := (p_from at time zone c.timezone)::date;
  while v_day <= (p_to at time zone c.timezone)::date loop
    if ogl_is_working_day(v_day, p_cal) then
      v_start := (v_day + c.window_start) at time zone c.timezone;
      v_end   := (v_day + c.window_end)   at time zone c.timezone;
      v_a := greatest(p_from, v_start);
      v_b := least(p_to, v_end);
      if v_b > v_a then
        v_total := v_total + (extract(epoch from (v_b - v_a)) / 60)::int;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;
  return v_total;
end $fn$;

create or replace function add_business_minutes(p_from timestamptz, p_minutes int, p_cal uuid)
returns timestamptz language plpgsql stable set search_path = public as $fn$
declare
  c business_calendar%rowtype;
  v_day date; v_left int := p_minutes;
  v_start timestamptz; v_end timestamptz; v_cursor timestamptz; v_avail int;
  v_guard int := 0;
begin
  select * into c from business_calendar where id = p_cal;
  if not found then raise exception 'no such calendar'; end if;
  if p_minutes <= 0 then return p_from; end if;

  v_day := (p_from at time zone c.timezone)::date;
  v_cursor := p_from;

  while v_left > 0 loop
    v_guard := v_guard + 1;
    if v_guard > 3650 then
      raise exception 'add_business_minutes ran past ten years; check the calendar';
    end if;

    if ogl_is_working_day(v_day, p_cal) then
      v_start := (v_day + c.window_start) at time zone c.timezone;
      v_end   := (v_day + c.window_end)   at time zone c.timezone;
      if v_cursor < v_start then v_cursor := v_start; end if;
      if v_cursor < v_end then
        v_avail := (extract(epoch from (v_end - v_cursor)) / 60)::int;
        if v_avail >= v_left then
          return v_cursor + (v_left || ' minutes')::interval;
        end if;
        v_left := v_left - v_avail;
      end if;
    end if;
    v_day := v_day + 1;
    v_cursor := (v_day + c.window_start) at time zone c.timezone;
  end loop;
  return v_cursor;
end $fn$;

-- A time typed into a spreadsheet in a Pune office is a Pune time. Read as
-- UTC it lands five and a half hours late, and every migrated clock inherits
-- the error. An explicit offset is still honoured, so a file exported from a
-- system that writes them is not second-guessed.
create or replace function ogl_ts(p text)
returns timestamptz language sql immutable set search_path = public as $fn$
  select case
    when p is null then null
    when p ~ '(Z|[+-]\d{2}:?\d{2})$' then replace(p,' ','T')::timestamptz
    else (replace(p,' ','T')::timestamp at time zone 'Asia/Kolkata')
  end
$fn$;

-- =====================================================================
-- The state model. Fourteen states; only these transitions exist.
-- =====================================================================
create table if not exists ogl_transition_rule (
  from_state   text not null,
  to_state     text not null,
  trigger_name text not null,
  guard_note   text,
  primary key (from_state, to_state)
);

delete from ogl_transition_rule;
insert into ogl_transition_rule (from_state, to_state, trigger_name, guard_note) values
('DRAFT','SUBMITTED','submit','all mandatory fields; at least one requirement; every requirement has a Point ID'),
('SUBMITTED','ASSIGNED','resolve target location','location active for that client'),
('ASSIGNED','ACCEPTED','accept','actor holds an assignee-side chair for the target location'),
('ACCEPTED','IN_PROGRESS','start / allocate','allocatee is active and in the target location'),
('IN_PROGRESS','AWAITING_INFORMATION','RFI raised','no other request open'),
('AWAITING_INFORMATION','IN_PROGRESS','RFI answered or rejected',null),
('IN_PROGRESS','DELAY_REVIEW','delay reported','delay_count < 3'),
('DELAY_REVIEW','IN_PROGRESS','delay accepted, denied, or auto-accepted',null),
('IN_PROGRESS','COMPLETED','completion submitted','every requirement reported; evidence present per channel'),
('REWORK','COMPLETED','rework submitted','as COMPLETED'),
('COMPLETED','UNDER_REVIEW','automatic, same transaction',null),
('UNDER_REVIEW','CLOSED','accepted','no requirement incomplete and no request pending'),
('UNDER_REVIEW','REWORK','dispute raised','dispute_count < 2'),
('UNDER_REVIEW','ARBITRATION','third dispute attempt','arbiter is the lowest common manager of both parties'),
('ARBITRATION','CLOSED','arbitration decided','arbiter only'),
('ARBITRATION','REWORK','arbitration decided','arbiter only'),
('CLOSED','REOPENED','reopen','Ops Head or Admin, within 7 days, reason required'),
('REOPENED','IN_PROGRESS','re-allocate','new sla_instance, next cycle'),
('DRAFT','CANCELLED','cancel','assignor or Admin; no request pending'),
('SUBMITTED','CANCELLED','cancel','assignor or Admin; no request pending'),
('ASSIGNED','CANCELLED','cancel','assignor or Admin; no request pending'),
('ACCEPTED','CANCELLED','cancel','assignor or Admin; no request pending'),
('IN_PROGRESS','CANCELLED','cancel','assignor or Admin; no request pending'),
('AWAITING_INFORMATION','CANCELLED','cancel','assignor or Admin; no request pending'),
('DELAY_REVIEW','CANCELLED','cancel','assignor or Admin; no request pending'),
('REOPENED','CANCELLED','cancel','assignor or Admin; no request pending');

-- The spec enforces "the transition service is the sole writer of
-- current_state" with REVOKE UPDATE (current_state). service_role bypasses a
-- column grant, so it is a trigger here: the column moves only while
-- ogl_transition() has set its transaction-local flag. An INSERT is exempt —
-- a row has to arrive in some state, and the cutover loader says so.
create or replace function assignment_state_guard() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.current_state is distinct from old.current_state
     and coalesce(current_setting('crux.ogl_transition', true), '') <> 'on' then
    raise exception 'current_state is written only by ogl_transition(); % -> % was attempted directly',
      old.current_state, new.current_state
      using hint = 'Call ogl_transition(assignment, to_state, actor, reason).';
  end if;
  return new;
end $fn$;

drop trigger if exists assignment_state_guard_trg on assignment;
create trigger assignment_state_guard_trg
  before update on assignment
  for each row execute function assignment_state_guard();

create or replace function ogl_transition(
  p_assignment uuid, p_to text, p_actor uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; v_guard text; v_next uuid;
begin
  select * into a from assignment where id = p_assignment for update;
  if not found then
    return jsonb_build_object('error','no_such_assignment');
  end if;

  if a.current_state = p_to then
    return jsonb_build_object('error','already_there',
      'reason','This assignment is already ' || p_to || '.');
  end if;

  select guard_note into v_guard from ogl_transition_rule
   where from_state = a.current_state and to_state = p_to;
  if not found then
    return jsonb_build_object('error','transition_refused',
      'reason', a.current_state || ' does not go to ' || p_to || '.',
      'hint','The states that follow ' || a.current_state || ' are: ' ||
             coalesce((select string_agg(to_state, ', ' order by to_state)
                         from ogl_transition_rule where from_state = a.current_state), 'none'));
  end if;

  -- the guards that are countable are counted here rather than trusted
  if p_to = 'DELAY_REVIEW' and a.delay_count >= 3 then
    return jsonb_build_object('error','delay_limit',
      'reason','Three delays have already been reported on this assignment.');
  end if;
  if p_to = 'REWORK' and a.current_state = 'UNDER_REVIEW' and a.dispute_count >= 2 then
    return jsonb_build_object('error','dispute_limit',
      'reason','Two disputes have already been raised. The third goes to arbitration.');
  end if;
  if p_to = 'CANCELLED' and a.open_request_type is not null then
    return jsonb_build_object('error','request_open',
      'reason','A ' || a.open_request_type || ' is open. Resolve it before cancelling.');
  end if;
  if p_to = 'CLOSED' and a.current_state = 'UNDER_REVIEW' then
    if a.open_request_type is not null then
      return jsonb_build_object('error','request_open',
        'reason','A ' || a.open_request_type || ' is open. Resolve it before closing.');
    end if;
    if exists (select 1 from case_verification_requirement r
                where r.case_id = a.case_id
                  and r.status in ('PENDING','IN_PROGRESS','DISPUTED')) then
      return jsonb_build_object('error','requirement_incomplete',
        'reason','Not every verification on this case has been reported.');
    end if;
  end if;
  if p_to = 'REOPENED' and a.closed_at is not null and a.closed_at < now() - interval '7 days' then
    return jsonb_build_object('error','too_late_to_reopen',
      'reason','A closed assignment can be reopened for seven days. This one closed on '
               || to_char(a.closed_at, 'DD Mon YYYY') || '.');
  end if;
  if p_to = 'REOPENED' and coalesce(btrim(p_reason),'') = '' then
    return jsonb_build_object('error','reason_required',
      'reason','Reopening needs a reason. It is the first thing anyone asks.');
  end if;

  -- who the assignment is waiting on next: this drives the Action Required tab
  v_next := case p_to
    when 'SUBMITTED'            then null
    when 'ASSIGNED'             then a.allocated_to_id
    when 'ACCEPTED'             then a.allocated_to_id
    when 'IN_PROGRESS'          then a.allocated_to_id
    when 'AWAITING_INFORMATION' then a.assignor_id
    when 'DELAY_REVIEW'         then a.assignor_id
    when 'COMPLETED'            then a.assignor_id
    when 'UNDER_REVIEW'         then a.assignor_id
    when 'REWORK'               then a.allocated_to_id
    else null end;

  perform set_config('crux.ogl_transition', 'on', true);

  update assignment set
    current_state        = p_to,
    next_action_owner_id = v_next,
    delay_count   = delay_count   + case when p_to = 'DELAY_REVIEW' then 1 else 0 end,
    dispute_count = dispute_count + case when p_to = 'REWORK' and a.current_state = 'UNDER_REVIEW' then 1 else 0 end,
    breach_cycle_no = breach_cycle_no + case when p_to in ('REWORK','REOPENED') then 1 else 0 end,
    closed_at = case when p_to in ('CLOSED','CANCELLED') then now()
                     when p_to = 'REOPENED' then null
                     else closed_at end
   where id = p_assignment;

  perform set_config('crux.ogl_transition', 'off', true);

  insert into assignment_event (assignment_id, event_type, actor_id, from_state, to_state, payload)
  values (p_assignment, 'STATE_CHANGED', p_actor, a.current_state, p_to,
          jsonb_build_object('reason', p_reason, 'guard', v_guard));

  -- COMPLETED moves to UNDER_REVIEW in the same transaction, as specified
  if p_to = 'COMPLETED' then
    perform ogl_transition(p_assignment, 'UNDER_REVIEW', p_actor, 'automatic on completion');
    return jsonb_build_object('state','UNDER_REVIEW','via','COMPLETED');
  end if;

  return jsonb_build_object('state', p_to, 'next_action_owner', v_next);
end $fn$;

revoke all on function ogl_transition(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function ogl_transition(uuid,text,uuid,text) to service_role;

-- =====================================================================
-- The Opening balances loader, now that ogl_assignment has somewhere to go.
-- Supersedes the uv_opening / ua_opening in schema-patch-v12.sql.
-- =====================================================================

create or replace function uv_opening(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when lower(coalesce(ul_txt(r2.raw,'record_type'),'')) not in ('escalation','ogl_assignment','claim')
           then 'record_type must be escalation, ogl_assignment or claim' end,
      case when ul_txt(r2.raw,'reference') is null then 'reference is required' end,
      case when ul_txt(r2.raw,'created_at') is null then 'created_at is required'
           when ul_txt(r2.raw,'created_at') !~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$'
                or not is_ymd(left(ul_txt(r2.raw,'created_at'),10))
           then 'created_at must be a real date and time, written YYYY-MM-DDTHH:MM' end,
      case when ul_txt(r2.raw,'owner_employee_no') is null then 'owner_employee_no is required'
           when not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'owner_employee_no'))
           then 'owner_employee_no ' || ul_txt(r2.raw,'owner_employee_no') || ' is not on the people master' end,
      case when lower(coalesce(ul_txt(r2.raw,'record_type'),'')) = 'escalation' then
        nullif(concat_ws('; ',
          case when upper(coalesce(ul_txt(r2.raw,'current_state'),'')) not in
                    ('OPEN','IN_PROGRESS','RESOLVED','CLOSED','BLOCKED')
               then 'current_state for an escalation must be OPEN, IN_PROGRESS, RESOLVED, CLOSED or BLOCKED' end,
          case when ul_txt(r2.raw,'client_code') is null then 'client_code is required for an escalation'
               when not exists (select 1 from client c where c.code = ul_txt(r2.raw,'client_code'))
               then 'client_code ' || ul_txt(r2.raw,'client_code') || ' does not exist' end
        ), '') end,
      case when lower(coalesce(ul_txt(r2.raw,'record_type'),'')) = 'claim' then
        nullif(concat_ws('; ',
          case when upper(coalesce(ul_txt(r2.raw,'current_state'),'')) not in
                    ('DRAFT','OPS_APPROVAL','HR_APPROVAL','ACCOUNTS','DISPUTED','PAID','REJECTED')
               then 'current_state for a claim must be DRAFT, OPS_APPROVAL, HR_APPROVAL, ACCOUNTS, DISPUTED, PAID or REJECTED' end,
          case when ul_txt(r2.raw,'amount') is not null and ul_txt(r2.raw,'amount') !~ '^\d+(\.\d{1,2})?$'
               then 'amount must be a non-negative number' end
        ), '') end,
      case when lower(coalesce(ul_txt(r2.raw,'record_type'),'')) = 'ogl_assignment' then
        nullif(concat_ws('; ',
          case when upper(coalesce(ul_txt(r2.raw,'current_state'),'')) not in
                    ('DRAFT','SUBMITTED','ASSIGNED','ACCEPTED','IN_PROGRESS','AWAITING_INFORMATION',
                     'DELAY_REVIEW','COMPLETED','UNDER_REVIEW','REWORK','ARBITRATION','CLOSED',
                     'REOPENED','CANCELLED')
               then 'current_state for an OGL assignment must be one of the fourteen states - '
                    || 'DRAFT, SUBMITTED, ASSIGNED, ACCEPTED, IN_PROGRESS, AWAITING_INFORMATION, '
                    || 'DELAY_REVIEW, COMPLETED, UNDER_REVIEW, REWORK, ARBITRATION, CLOSED, REOPENED or CANCELLED' end,
          case when ul_txt(r2.raw,'client_code') is null then 'client_code is required for an OGL assignment'
               when not exists (select 1 from client c where c.code = ul_txt(r2.raw,'client_code'))
               then 'client_code ' || ul_txt(r2.raw,'client_code') || ' does not exist' end,
          case when ul_txt(r2.raw,'zone') is null then 'zone is required for an OGL assignment - it is the target location'
               when not exists (select 1 from geo_node g where g.level='ZONE' and lower(g.name)=lower(ul_txt(r2.raw,'zone')))
               then 'zone ' || ul_txt(r2.raw,'zone') || ' does not exist - load Geography first' end,
          case when ul_txt(r2.raw,'force1_case_id') is null
               then 'force1_case_id is required for an OGL assignment' end,
          case when ul_txt(r2.raw,'applicant_name') is null
               then 'applicant_name is required for an OGL assignment' end,
          case when ul_txt(r2.raw,'verification_type') is not null
                and not exists (select 1 from verification_type vt
                                 where upper(vt.code) = upper(ul_txt(r2.raw,'verification_type')))
               then 'verification_type ' || ul_txt(r2.raw,'verification_type')
                    || ' is not one of RESIDENT, BUSINESS, EMPLOYEE or QUOTATION' end
        ), '') end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate reference in this file'
    from (select id, row_number() over (partition by lower(ul_txt(raw,'reference')) order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function ua_opening(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
declare v_cat uuid; v_desk uuid; v_cal uuid; v_rule uuid;
        r record; v_case uuid; v_party uuid; v_assign uuid; v_vt uuid; v_from uuid;
begin
  -- Cutover rows arrive without the category and desk the live workflow would
  -- have chosen. They get their own, clearly named, rather than being filed
  -- under a real one where they would read as genuine classifications.
  -- desk_primary_or_fallback: a desk has to answer to somebody, so until it
  -- is reassigned it answers to the administrator who loaded the file.
  select id into v_desk from desk where name = 'Cutover desk';
  if v_desk is null then
    insert into desk (name, primary_person_id, escalation_only)
    values ('Cutover desk', p_actor, false) returning id into v_desk;
  end if;

  select id into v_cat from category where name = 'Migrated at cutover';
  if v_cat is null then
    insert into category (name, desk_id, pinned, chase_hours, active)
    values ('Migrated at cutover', v_desk, false, 24, true) returning id into v_cat;
  end if;

  insert into "case" (ref, client_id, category_id, raised_by, owner_person_id, desk_id,
                      status, created_at, last_activity_at, source_ref)
  select ul_txt(r2.raw,'reference'), c.id, v_cat, o.id, o.id, v_desk,
         upper(ul_txt(r2.raw,'current_state'))::case_status,
         ogl_ts(ul_txt(r2.raw,'created_at')), ogl_ts(ul_txt(r2.raw,'created_at')),
         'opening balance'
    from upload_row r2
    join client c on c.code = ul_txt(r2.raw,'client_code')
    join person o on o.employee_no = ul_txt(r2.raw,'owner_employee_no')
   where r2.batch_id = p_batch and lower(ul_txt(r2.raw,'record_type')) = 'escalation'
  on conflict (ref) do nothing;

  insert into claim (ref, person_id, amount, stage, created_at)
  select ul_txt(r2.raw,'reference'), o.id,
         coalesce(ul_txt(r2.raw,'amount')::numeric, 0),
         upper(ul_txt(r2.raw,'current_state'))::claim_stage,
         ogl_ts(ul_txt(r2.raw,'created_at'))
    from upload_row r2
    join person o on o.employee_no = ul_txt(r2.raw,'owner_employee_no')
   where r2.batch_id = p_batch and lower(ul_txt(r2.raw,'record_type')) = 'claim'
  on conflict (ref) do nothing;

  if exists (select 1 from upload_row where batch_id = p_batch
              and lower(ul_txt(raw,'record_type')) = 'ogl_assignment') then

    select id into v_cal from business_calendar where code = 'DEFAULT';

    -- a cutover TAT rule, so every migrated assignment has a clock with a
    -- rule behind it rather than a number from nowhere
    select id into v_rule from sla_rule where code = 'CUTOVER' and version = 1;
    if v_rule is null then
      insert into sla_rule (code, version, tat_business_minutes, specificity, effective_from)
      values ('CUTOVER', 1, 1440, 0, current_date) returning id into v_rule;
    end if;

    for r in select raw from upload_row where batch_id = p_batch
              and lower(ul_txt(raw,'record_type')) = 'ogl_assignment' order by row_no loop

      select id into v_vt from verification_type
       where upper(code) = upper(coalesce(ul_txt(r.raw,'verification_type'),'RESIDENT'));

      insert into verification_case (force1_case_id, client_id, applicant_name,
                                     applicant_contact, applicant_address, pincode, created_by)
      select ul_txt(r.raw,'force1_case_id'), c.id,
             ul_txt(r.raw,'applicant_name'),
             coalesce(ul_txt(r.raw,'applicant_contact'),'not captured at cutover'),
             coalesce(ul_txt(r.raw,'applicant_address'),'not captured at cutover'),
             coalesce(ul_txt(r.raw,'pincode'),'000000'),
             p_actor
        from client c where c.code = ul_txt(r.raw,'client_code')
      on conflict (force1_case_id) do nothing;

      select id into v_case from verification_case
       where force1_case_id = ul_txt(r.raw,'force1_case_id');

      insert into case_party (case_id, party_role, seq_no, name, same_as_applicant)
      values (v_case, 'APPLICANT', 1, ul_txt(r.raw,'applicant_name'), true)
      on conflict (case_id, party_role, seq_no) do nothing;
      select id into v_party from case_party
       where case_id = v_case and party_role = 'APPLICANT' and seq_no = 1;

      if ul_txt(r.raw,'force1_point_id') is not null then
        insert into case_verification_requirement
          (case_id, party_id, verification_type_id, force1_point_id, status)
        values (v_case, v_party, v_vt, ul_txt(r.raw,'force1_point_id'),
                case when upper(ul_txt(r.raw,'current_state')) in ('CLOSED','CANCELLED')
                     then 'CLOSED' else 'IN_PROGRESS' end)
        on conflict (force1_point_id, attempt_no) do nothing;
      end if;

      -- the assignor's own coverage stands in for from_location at cutover
      select cr.geo_node_id into v_from
        from coverage_rule cr join person p on p.id = cr.person_id
       where p.employee_no = ul_txt(r.raw,'owner_employee_no')
         and cr.geo_node_id is not null
       limit 1;

      -- This INSERT is the one place current_state is written outside
      -- ogl_transition(). A migrated assignment arrives mid-flight; replaying
      -- a history that happened in the old system would be a fiction.
      insert into assignment (ref, case_id, assignor_id, assignor_chair_id,
                              from_location_id, to_location_id, allocated_to_id,
                              current_state, next_action_owner_id,
                              self_assign_reason, source_ref, created_at, closed_at)
      select ul_txt(r.raw,'reference'), v_case, o.id, ch.chair_id,
             coalesce(v_from, g.id), g.id, o.id,
             upper(ul_txt(r.raw,'current_state')),
             case when upper(ul_txt(r.raw,'current_state')) in ('CLOSED','CANCELLED')
                  then null else o.id end,
             'migrated at cutover', 'opening balance',
             ogl_ts(ul_txt(r.raw,'created_at')),
             case when upper(ul_txt(r.raw,'current_state')) in ('CLOSED','CANCELLED')
                  then ogl_ts(ul_txt(r.raw,'created_at')) else null end
        from person o
        join chair_holder ch on ch.person_id = o.id and ch.to_date is null
        join geo_node g on g.level='ZONE' and lower(g.name) = lower(ul_txt(r.raw,'zone'))
       where o.employee_no = ul_txt(r.raw,'owner_employee_no')
       limit 1
      on conflict (ref) do nothing;

      select id into v_assign from assignment where ref = ul_txt(r.raw,'reference');

      -- a clock, from the real creation time, for anything still running
      if v_assign is not null
         and upper(ul_txt(r.raw,'current_state')) not in ('CLOSED','CANCELLED','DRAFT') then
        insert into sla_instance (assignment_id, breach_cycle_no, sla_rule_id, calendar_id,
                                  tat_business_minutes, started_at, due_at, rule_trace)
        values (v_assign, 1, v_rule, v_cal, 1440,
                ogl_ts(ul_txt(r.raw,'created_at')),
                add_business_minutes(ogl_ts(ul_txt(r.raw,'created_at')), 1440, v_cal),
                jsonb_build_object('rule','CUTOVER v1',
                  'why','Migrated at cutover: no rule dimensions were captured, so the '
                        || 'default applies and the trace says so rather than implying a match.'))
        on conflict (assignment_id, breach_cycle_no) do nothing;
      end if;

      insert into assignment_event (assignment_id, event_type, actor_id, to_state, is_system, payload)
      select v_assign, 'ASSIGNMENT_CREATED', p_actor, upper(ul_txt(r.raw,'current_state')), true,
             jsonb_build_object('source','opening balance',
               'note','Seated directly in its state. The history before cutover happened '
                      || 'in the old system and is not replayed here.')
      where v_assign is not null;
    end loop;
  end if;
end $fn$;

-- the Opening balances template gains the OGL columns
update upload_column set rule = 'escalation, ogl_assignment or claim.'
 where kind='Opening balances' and name='record_type';
update upload_column set rule = 'An escalation: OPEN, IN_PROGRESS, RESOLVED, CLOSED or BLOCKED. A claim: DRAFT, OPS_APPROVAL, HR_APPROVAL, ACCOUNTS, DISPUTED, PAID or REJECTED. An OGL assignment: any of its fourteen states.'
 where kind='Opening balances' and name='current_state';
update upload_column set rule = 'Required for an escalation and for an OGL assignment.'
 where kind='Opening balances' and name='client_code';
update upload_column set rule = 'Optional for an escalation. Required for an OGL assignment - it is the target location.'
 where kind='Opening balances' and name='zone';

insert into upload_column (kind, ord, name, example, rule) values
('Opening balances',9,'force1_case_id','F1-2026-114233','Required for an OGL assignment. The externally supplied case id.'),
('Opening balances',10,'applicant_name','Ramesh Patil','Required for an OGL assignment.'),
('Opening balances',11,'applicant_contact','9821001122','Optional. Recorded as not captured at cutover when blank.'),
('Opening balances',12,'applicant_address','Kothrud, Pune','Optional. Recorded as not captured at cutover when blank.'),
('Opening balances',13,'pincode','411038','Optional at cutover.'),
('Opening balances',14,'verification_type','RESIDENT','RESIDENT, BUSINESS, EMPLOYEE or QUOTATION. Defaults to RESIDENT.'),
('Opening balances',15,'force1_point_id','P-884512','Optional. Creates the verification requirement when given.')
on conflict (kind, ord) do update
  set name = excluded.name, example = excluded.example, rule = excluded.rule;

-- =====================================================================
-- Exposure.
-- Patch v7 locked the tables that existed then. Everything above was
-- created after it and so inherited the default grant to anon and
-- authenticated — and verification_case carries applicant names, contacts,
-- addresses and pincodes. The anon key is public by design. This closes it.
-- Nothing in this module is read through PostgREST; the hosted shell and
-- the API reach it as service_role.
-- =====================================================================
do $g$
declare t text;
begin
  foreach t in array array[
    'business_calendar','reason_taxonomy','verification_type','verification_case',
    'case_party','case_verification_requirement','repeat_point_decision','assignment',
    'assignment_completion','sla_rule','sla_instance','sla_clock_segment',
    'assignment_request','assignment_event','ogl_escalation_matrix','ogl_transition_rule'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $g$;
