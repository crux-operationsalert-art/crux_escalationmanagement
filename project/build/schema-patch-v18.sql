-- =====================================================================
-- CRUX — schema patch v18
-- The OGL engine: the parts v13 had tables for and no logic behind.
--
-- v13 built the state model, the clock and the transition service, and
-- said plainly that the conditional-pause arithmetic, delay auto-accept,
-- the escalation sweep and strike generation were not built. They are
-- built here.
--
-- The rule the whole module turns on is unchanged: current_state is the
-- operational position and nothing else. sla_status, escalation level,
-- priority bucket and open_request_type are orthogonal attributes. A
-- breached assignment is still IN_PROGRESS and still shows its operator
-- the correct next action.
--
-- Run after schema-patch-v17.sql.
-- =====================================================================

-- ============================================ the tables the engine needs

alter table reason_taxonomy add column if not exists pause_eligible boolean not null default false;

comment on column reason_taxonomy.pause_eligible is
  'Whether an RFI citing this reason may stop the clock. It is a column, not '
  'an inference from implied_attribution, because the two are allowed to '
  'disagree: a reason can be somebody else''s fault and still not earn a pause.';

create table if not exists escalation_instance (
  id               uuid primary key default gen_random_uuid(),
  assignment_id    uuid not null references assignment(id),
  breach_cycle_no  int  not null,
  escalation_level int  not null check (escalation_level between 1 and 4),
  trigger_code     text not null check (trigger_code in ('BREACH','SUB_TAT_BREACH','MANUAL','REPEAT_BREACH')),
  idempotency_key  text not null unique,
  resolved_to_id   uuid references person(id),
  resolved_chair_id uuid references chair(id),
  route_trace      jsonb not null default '{}',
  fallback_used    boolean not null default false,
  fallback_reason  text,
  raised_at        timestamptz not null default now(),
  closed_at        timestamptz,
  closed_by        uuid references person(id)
);
create index if not exists escalation_instance_assignment
  on escalation_instance (assignment_id, escalation_level);
create index if not exists escalation_instance_open
  on escalation_instance (raised_at desc) where closed_at is null;

comment on table escalation_instance is
  'One row per escalation actually raised. The idempotency key is the hash of '
  'assignment, cycle, level and trigger, so a sweep that runs twice raises one '
  'escalation - the property the old engine could not have, which is how it '
  'produced 1,892 sends from 77 keys.';

create table if not exists strike_event (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null references person(id),
  location_id      uuid references geo_node(id),
  assignment_id    uuid references assignment(id),
  breach_cycle_no  int,
  trigger_code     text not null check (trigger_code in ('SLA_BREACH','SUB_TAT_BREACH','DISPUTE_UPHELD','MIGRATED')),
  occurred_at      timestamptz not null default now(),
  attributable_minutes int,
  strike_no        int,
  status           text not null default 'ACTIVE' check (status in ('ACTIVE','WAIVED','EXPIRED')),
  waived_by        uuid references person(id),
  waived_reason    text,
  facts            jsonb not null default '{}',
  unique (assignment_id, breach_cycle_no, trigger_code)
);
create index if not exists strike_event_person
  on strike_event (person_id, occurred_at desc) where status = 'ACTIVE';

comment on table strike_event is
  'A strike is generated, never deleted. A dispute found NOT_UPHELD sets '
  'status = WAIVED with a reason and the row stays visible as waived; the '
  'ninety-day rolling window counts only ACTIVE ones.';
comment on column strike_event.location_id is
  'The location as at the breach, not as at now. A person who moves branch '
  'does not move their history with them.';

create table if not exists temp_participant_grant (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignment(id),
  person_id     uuid not null references person(id),
  granted_by    uuid not null references person(id),
  reason        text not null,
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  unique (assignment_id, person_id, granted_at)
);
create index if not exists temp_participant_live
  on temp_participant_grant (person_id) where revoked_at is null;

comment on table temp_participant_grant is
  'Read access to one assignment for one person for a stated while. It exists '
  'so that helping with a case is a recorded act with an end date, rather than '
  'a permanent widening of somebody''s scope that nobody remembers granting.';

-- lock them down before anything can read them: these carry names,
-- attributions and disciplinary facts
do $do$
declare t text;
begin
  foreach t in array array['escalation_instance','strike_event','temp_participant_grant'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $do$;

-- The matrix table arrived in v13 without the three columns that make a
-- routing table maintainable: an order between equals, and a life.
alter table ogl_escalation_matrix
  add column if not exists sequence_no int not null default 1,
  add column if not exists effective_from date not null default current_date,
  add column if not exists effective_to date;

create unique index if not exists ogl_escalation_matrix_live
  on ogl_escalation_matrix (client_id, location_id, branch_id, escalation_level, sequence_no)
  where effective_to is null;

-- One open request per assignment was the rule, and it was too broad. A
-- dispute is not a request that blocks the assignee - it is a finding about
-- work already delivered, and the rework that follows it may perfectly well
-- need a request for information of its own. So: one open blocking request,
-- and separately one open dispute.
drop index if exists ar_one_open;
create unique index if not exists ar_one_open
  on assignment_request (assignment_id)
  where resolved_at is null and request_type <> 'DISPUTE';
create unique index if not exists ar_one_open_dispute
  on assignment_request (assignment_id)
  where resolved_at is null and request_type = 'DISPUTE';

-- ================================ the vocabulary: reasons and their meaning
-- A reason is not free text with a dropdown in front of it. Each one carries
-- who the resulting time belongs to and whether it may stop the clock, so
-- the attribution arithmetic is a lookup rather than a judgement made
-- differently by each reviewer.
insert into reason_taxonomy (context, code, label, requires_remarks, implied_attribution, pause_eligible) values
 ('RFI','ADDRESS_INCOMPLETE','The address given cannot be found',            true,  'ASSIGNOR',      true),
 ('RFI','CONTACT_UNREACHABLE','The contact number does not connect',          true,  'ASSIGNOR',      true),
 ('RFI','DOCUMENT_MISSING','A document named in the case was not attached',   true,  'ASSIGNOR',      true),
 ('RFI','POINT_ID_UNCLEAR','The Point ID does not match the case',            true,  'ASSIGNOR',      true),
 ('RFI','CLIENT_CLARIFICATION','The client has to be asked before we proceed',true,  'CUSTOMER',      true),
 ('RFI','SCOPE_UNCLEAR','What is to be verified is not clear from the case',  true,  'ASSIGNOR',      true),
 ('RFI','OUR_QUERY','Our own question, not a gap in the case',                true,  'ASSIGNEE',      false),
 ('DELAY','APPLICANT_UNAVAILABLE','Nobody was at the address',                 true,  'CUSTOMER',      false),
 ('DELAY','PREMISES_CLOSED','The business was shut',                           true,  'CUSTOMER',      false),
 ('DELAY','WEATHER_OR_UNREST','Travel was not possible',                       true,  'EXTERNAL',      false),
 ('DELAY','THIRD_PARTY_WAIT','Waiting on somebody outside Crux',               true,  'EXTERNAL',      false),
 ('DELAY','APPROVED_HOLD','Held deliberately, with approval',                  true,  'APPROVED_HOLD', false),
 ('DELAY','OWN_CAPACITY','We did not have anyone free',                        true,  'ASSIGNEE',      false),
 ('DELAY','FIELD_TRAVEL','The location is far and the day ran out',            true,  'ASSIGNEE',      false),
 ('DISPUTE','EVIDENCE_INSUFFICIENT','The evidence does not support the finding',true, 'ASSIGNEE',      false),
 ('DISPUTE','WRONG_ADDRESS_VISITED','A different address was visited',          true, 'ASSIGNEE',      false),
 ('DISPUTE','INCOMPLETE_REPORT','Not every point was reported',                 true, 'ASSIGNEE',      false),
 ('DISPUTE','FINDING_CONTRADICTED','Later information contradicts the finding', true, 'EXTERNAL',      false),
 ('HOLD','CLIENT_INSTRUCTION','The client asked us to stop',                    true, 'CUSTOMER',      true),
 ('HOLD','INTERNAL_REVIEW','Held for an internal review',                       true, 'APPROVED_HOLD', true),
 ('CANCEL','DUPLICATE','The same work is already assigned',                     true, 'SYSTEM',        false),
 ('CANCEL','CLIENT_WITHDREW','The client withdrew the case',                    true, 'CUSTOMER',      false),
 ('CANCEL','RAISED_IN_ERROR','It should not have been raised',                  true, 'ASSIGNOR',      false),
 ('REASSIGN','WRONG_LOCATION','It went to the wrong location',                  true, 'ASSIGNOR',      false),
 ('REASSIGN','CAPACITY','The location cannot take it',                          true, 'ASSIGNEE',      false),
 ('REASSIGN','ABSENCE','The allocatee is away',                                 true, 'ASSIGNEE',      false),
 ('REOPEN','NEW_INFORMATION','Something came to light after closing',           true, 'EXTERNAL',      false),
 ('REOPEN','CLIENT_QUERY','The client questioned the closed report',            true, 'CUSTOMER',      false),
 ('ATTRIBUTION','CONFIRMED_AS_REPORTED','The reason given stands',              false,'SYSTEM',        false),
 ('ATTRIBUTION','RECLASSIFIED_ASSIGNEE','On review, this time is ours',         true, 'ASSIGNEE',      false),
 ('ATTRIBUTION','RECLASSIFIED_EXTERNAL','On review, this time is external',     true, 'EXTERNAL',      false)
on conflict (context, code) do update
  set label = excluded.label,
      implied_attribution = excluded.implied_attribution,
      pause_eligible = excluded.pause_eligible;

-- Every number the engine uses is a row, not a literal. The 50%, the 120
-- minutes and the twelve business hours are all arguable; arguing about
-- them should not need a deploy.
insert into app_setting (key, value, plain_language, group_name, secret, editable_by) values
 ('ogl_rfi_sub_tat_minutes','120','How long the assignor has to answer a request for information, in business minutes.','OGL',false,'ADMIN'),
 ('ogl_delay_sub_tat_minutes','60','How long the assignor has to review a reported delay before it accepts itself, in business minutes.','OGL',false,'ADMIN'),
 ('ogl_pause_cap_minutes','120','The most business minutes one request for information may take off the clock.','OGL',false,'ADMIN'),
 ('ogl_pause_consumed_pct','50','A request for information may stop the clock only if less than this much of the TAT has gone.','OGL',false,'ADMIN'),
 ('ogl_delay_extension_cap_minutes','720','The most an accepted delay may move the due date, in business minutes. Twelve business hours.','OGL',false,'ADMIN'),
 ('ogl_escalation_step_minutes','240','Business minutes between one escalation level and the next after a breach.','OGL',false,'ADMIN'),
 ('ogl_strike_window_days','90','The rolling window strikes are counted in.','OGL',false,'ADMIN')
on conflict (key) do nothing;

insert into job_config (job_key, enabled, cron)
values ('OGL_SWEEP', true, '*/15 * * * *')
on conflict (job_key) do nothing;

-- ================================================== the clock, in segments

create or replace function ogl_setting_int(p_key text, p_default int)
returns int language sql stable set search_path = public as $fn$
  select coalesce((select nullif(value,'')::int from app_setting where key = p_key), p_default)
$fn$;

-- ogl_ts already read a naive string as a Pune time. The other direction was
-- missing, and every message that prints a deadline needs it: an instant
-- rendered as the wall clock somebody in the office would read.
create or replace function ogl_ts(p timestamptz)
returns timestamp language sql immutable set search_path = public as $fn$
  select (p at time zone 'Asia/Kolkata')
$fn$;

comment on function ogl_ts(timestamptz) is
  'An instant as the wall clock in the Pune office reads it. Every deadline '
  'printed in a message goes through this: a time typed in Pune is a Pune '
  'time, and a time shown in Pune is a Pune time.';

-- The live clock for an assignment: the current cycle's instance, still
-- running. Null when the assignment is closed or was never started.
create or replace function ogl_live_sla(p_assignment uuid)
returns sla_instance language sql stable set search_path = public as $fn$
  select si.* from sla_instance si
    join assignment a on a.id = si.assignment_id
   where si.assignment_id = p_assignment
     and si.breach_cycle_no = a.breach_cycle_no
     and si.stopped_at is null
   limit 1
$fn$;

-- Close whatever segment is open and write its length, in business minutes
-- against the instance's own calendar - the one snapshotted when the clock
-- started, not whichever is current.
create or replace function ogl_segment_close(p_sla uuid, p_at timestamptz default now())
returns int language plpgsql set search_path = public as $fn$
declare v_seg sla_clock_segment%rowtype; v_cal uuid; v_min int;
begin
  select * into v_seg from sla_clock_segment
   where sla_instance_id = p_sla and closed_at is null for update;
  if not found then return null; end if;

  select calendar_id into v_cal from sla_instance where id = p_sla;
  v_min := business_minutes_between(v_seg.opened_at, greatest(p_at, v_seg.opened_at), v_cal);

  update sla_clock_segment
     set closed_at = greatest(p_at, v_seg.opened_at), business_minutes = v_min
   where id = v_seg.id;
  return v_min;
end $fn$;

-- Open a segment, closing the previous one in the same breath. One open
-- segment at a time is a unique index, not a convention.
create or replace function ogl_segment_open(
  p_sla uuid, p_state text, p_attribution text,
  p_counts_sla boolean, p_counts_strike boolean,
  p_reason uuid default null, p_reason_text text default null,
  p_by uuid default null, p_at timestamptz default now())
returns uuid language plpgsql set search_path = public as $fn$
declare v_id uuid; v_seq int;
begin
  perform ogl_segment_close(p_sla, p_at);
  select coalesce(max(seq_no), 0) + 1 into v_seq
    from sla_clock_segment where sla_instance_id = p_sla;

  insert into sla_clock_segment (sla_instance_id, seq_no, segment_state, attribution,
         counts_to_sla, counts_to_strike, reason_id, reason_text, opened_at, set_by)
  values (p_sla, v_seq, p_state, p_attribution, p_counts_sla, p_counts_strike,
          p_reason, p_reason_text, p_at, p_by)
  returning id into v_id;
  return v_id;
end $fn$;

-- Elapsed and exposure are derived, never stored. Both count the open
-- segment up to now, because a clock that only moves when something happens
-- is the old system's clock.
create or replace function ogl_elapsed_sla(p_sla uuid)
returns int language sql stable set search_path = public as $fn$
  select coalesce(sum(
           case when s.closed_at is not null then s.business_minutes
                else business_minutes_between(s.opened_at, now(), si.calendar_id) end), 0)::int
    from sla_clock_segment s join sla_instance si on si.id = s.sla_instance_id
   where s.sla_instance_id = p_sla and s.counts_to_sla
$fn$;

create or replace function ogl_strike_exposure(p_sla uuid)
returns int language sql stable set search_path = public as $fn$
  select coalesce(sum(
           case when s.closed_at is not null then s.business_minutes
                else business_minutes_between(s.opened_at, now(), si.calendar_id) end), 0)::int
    from sla_clock_segment s join sla_instance si on si.id = s.sla_instance_id
   where s.sla_instance_id = p_sla
     and s.counts_to_strike and s.attribution = 'ASSIGNEE'
$fn$;

-- Whether any time on this cycle is still waiting for somebody to say whose
-- it was. A strike cannot be generated while the answer is pending.
create or replace function ogl_attribution_pending(p_sla uuid)
returns boolean language sql stable set search_path = public as $fn$
  select exists (select 1 from sla_clock_segment
                  where sla_instance_id = p_sla and attribution = 'PENDING_REVIEW')
$fn$;

-- A cutover instance arrived without segments, because it arrived as a row
-- rather than through the workflow. Give each live one an opening segment so
-- exposure is measured from when the clock started rather than from whenever
-- the first request happens to be raised.
create or replace function ogl_backfill_segments()
returns int language plpgsql set search_path = public as $fn$
declare v_n int := 0; r record;
begin
  for r in select si.id, si.started_at from sla_instance si
            where si.stopped_at is null
              and not exists (select 1 from sla_clock_segment s where s.sla_instance_id = si.id)
  loop
    perform ogl_segment_open(r.id, 'RUNNING', 'ASSIGNEE', true, true,
                             null, 'opening segment', null, r.started_at);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $fn$;

select ogl_backfill_segments();

-- ================================ the conditional pause, stated once

-- The pause decision, shown before anybody commits to it. Three conditions,
-- each named, each with the number behind it - so an assignee who is refused
-- a pause is told which test failed rather than being told no.
create or replace function ogl_pause_preview(p_assignment uuid, p_reason uuid)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare
  si sla_instance%rowtype; r reason_taxonomy%rowtype;
  v_elapsed int; v_pct numeric; v_limit int; v_cap int;
  c1 boolean; c2 boolean; c3 boolean; v_prior int;
begin
  si := ogl_live_sla(p_assignment);
  if si.id is null then
    return jsonb_build_object('eligible', false,
      'reason','This assignment has no running clock, so there is nothing to pause.');
  end if;
  select * into r from reason_taxonomy where id = p_reason;

  v_limit := ogl_setting_int('ogl_pause_consumed_pct', 50);
  v_cap   := ogl_setting_int('ogl_pause_cap_minutes', 120);
  v_elapsed := ogl_elapsed_sla(si.id);
  v_pct := round(100.0 * v_elapsed / greatest(si.tat_business_minutes,1), 1);

  select count(*) into v_prior from assignment_request
   where assignment_id = p_assignment and breach_cycle_no = si.breach_cycle_no
     and pause_granted;

  c1 := v_pct < v_limit;
  c2 := v_prior = 0;
  c3 := coalesce(r.pause_eligible, false);

  return jsonb_build_object(
    'eligible', c1 and c2 and c3,
    'cap_minutes', v_cap,
    'elapsed_minutes', v_elapsed,
    'tat_minutes', si.tat_business_minutes,
    'consumed_pct', v_pct,
    'conditions', jsonb_build_array(
      jsonb_build_object('test','Less than ' || v_limit || '% of the time has gone',
        'pass', c1,
        'detail', v_elapsed || ' of ' || si.tat_business_minutes ||
                  ' business minutes used, ' || v_pct || '%'),
      jsonb_build_object('test','No pause has been granted on this cycle yet',
        'pass', c2,
        'detail', case when c2 then 'none so far'
                       else v_prior || ' already granted on cycle ' || si.breach_cycle_no end),
      jsonb_build_object('test','The reason given may stop the clock',
        'pass', c3,
        'detail', case when r.id is null then 'no reason chosen'
                       when c3 then r.label || ' - the information is somebody else''s to supply'
                       else r.label || ' - this is ours to resolve, so the clock keeps running' end)),
    'plain', case
      when c1 and c2 and c3 then
        'The clock will stop while this is open, for at most ' || v_cap ||
        ' business minutes. Anything beyond that still counts against the deadline.'
      else 'The clock will keep running. Raising this is still the right thing to do; it simply does not buy time.'
      end);
end $fn$;

comment on function ogl_pause_preview is
  'The conditional-pause arithmetic, run before submission and shown to the '
  'person submitting. Three conditions, each with its number. This is what '
  'stops a request for information being a free extension while still '
  'protecting a genuine one.';

-- ============================================ one place to become an e-mail
-- Everything the engine sends goes through here, so the idempotency scope
-- and the placeholder rule are applied once rather than at each call site.
create or replace function ogl_notify(
  p_assignment uuid, p_person uuid, p_template text,
  p_subject text, p_body text, p_scope text default null)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_email text; a assignment%rowtype;
begin
  if p_person is null then return jsonb_build_object('skipped','no_person'); end if;
  select work_email into v_email from person
   where id = p_person and employment_status = 'ACTIVE' and superseded_by is null;
  if v_email is null then return jsonb_build_object('skipped','no_active_person'); end if;
  select * into a from assignment where id = p_assignment;

  return mail_enqueue(p_template, v_email,
    coalesce(a.ref, '') || ' - ' || p_subject,
    p_body || E'\n\n' || 'Assignment ' || coalesce(a.ref,'') ||
      ', currently ' || coalesce(a.current_state,'') || '.',
    'assignment', p_assignment, null, now(),
    coalesce(p_scope, p_assignment::text || ':' || p_template || ':' || current_date::text));
end $fn$;

-- ================================================= requests: four kinds, one table

create or replace function ogl_request_raise(
  p_assignment uuid, p_type text, p_actor uuid, p_reason uuid,
  p_remarks text default null, p_delay_category text default null,
  p_expected_completion timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  a assignment%rowtype; si sla_instance%rowtype; r reason_taxonomy%rowtype;
  v_seq int; v_id uuid; v_sub int; v_due timestamptz;
  v_pause jsonb; v_granted boolean := false; v_to text; v_counter uuid;
  v_actor_name text;
begin
  if p_type not in ('RFI','DELAY','DISPUTE','HOLD') then
    return jsonb_build_object('error','unknown_request',
      'reason','A request is one of RFI, DELAY, DISPUTE or HOLD.');
  end if;

  select * into a from assignment where id = p_assignment for update;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;

  select * into r from reason_taxonomy where id = p_reason and active;
  if not found then
    return jsonb_build_object('error','no_such_reason',
      'reason','Choose a reason from the list for this kind of request.');
  end if;
  if r.context <> p_type then
    return jsonb_build_object('error','wrong_reason_context',
      'reason','"' || r.label || '" is a ' || r.context || ' reason, not a ' || p_type || ' one.');
  end if;
  if r.requires_remarks and coalesce(btrim(coalesce(p_remarks,'')),'') = '' then
    return jsonb_build_object('error','remarks_required',
      'reason','"' || r.label || '" needs a sentence saying what happened.');
  end if;

  -- who may raise what. The assignee reports what is in their way; the
  -- assignor disputes what came back. Neither does the other's.
  if p_type in ('RFI','DELAY') then
    if a.allocated_to_id is distinct from p_actor then
      return jsonb_build_object('error','not_the_assignee',
        'reason','Only the person the work is allocated to raises a ' || p_type || '.');
    end if;
    if a.current_state not in ('IN_PROGRESS','REWORK') then
      return jsonb_build_object('error','wrong_state',
        'reason','A ' || p_type || ' is raised while work is in progress. This is ' || a.current_state || '.');
    end if;
  elsif p_type = 'DISPUTE' then
    if a.assignor_id is distinct from p_actor then
      return jsonb_build_object('error','not_the_assignor',
        'reason','Only the assignor disputes a completed report.');
    end if;
    if a.current_state <> 'UNDER_REVIEW' then
      return jsonb_build_object('error','wrong_state',
        'reason','A dispute is raised on a report under review. This is ' || a.current_state || '.');
    end if;
  else -- HOLD
    if a.assignor_id is distinct from p_actor
       and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
      return jsonb_build_object('error','not_permitted',
        'reason','A hold is placed by the assignor or an administrator.');
    end if;
    if a.current_state in ('CLOSED','CANCELLED','COMPLETED','UNDER_REVIEW') then
      return jsonb_build_object('error','wrong_state',
        'reason','There is nothing left running to hold.');
    end if;
  end if;

  if p_type <> 'DISPUTE' and a.open_request_type is not null then
    return jsonb_build_object('error','request_open',
      'reason','A ' || a.open_request_type || ' is already open. Resolve it first.');
  end if;
  if p_type = 'DELAY' and a.delay_count >= 3 then
    return jsonb_build_object('error','delay_limit',
      'reason','Three delays have already been reported on this assignment.');
  end if;
  if p_type = 'DELAY' and p_expected_completion is null then
    return jsonb_build_object('error','expected_completion_required',
      'reason','A reported delay has to say when the work will be done.');
  end if;

  si := ogl_live_sla(p_assignment);

  -- the clock, decided before the row is written so the decision and its
  -- arithmetic are stored with the request rather than recomputed later
  if p_type in ('RFI','HOLD') and si.id is not null then
    if p_type = 'RFI' then
      v_pause := ogl_pause_preview(p_assignment, p_reason);
      v_granted := (v_pause->>'eligible')::boolean;
    else
      v_granted := r.pause_eligible;
      v_pause := jsonb_build_object('eligible', v_granted,
        'plain','An approved hold stops the clock for as long as it lasts.');
    end if;
  end if;

  v_sub := case p_type
             when 'RFI'   then ogl_setting_int('ogl_rfi_sub_tat_minutes', 120)
             when 'DELAY' then ogl_setting_int('ogl_delay_sub_tat_minutes', 60)
             else null end;
  if v_sub is not null and si.id is not null then
    v_due := add_business_minutes(now(), v_sub, si.calendar_id);
  end if;

  select coalesce(max(seq_no),0) + 1 into v_seq from assignment_request
   where assignment_id = p_assignment and request_type = p_type
     and breach_cycle_no = a.breach_cycle_no;

  insert into assignment_request (assignment_id, breach_cycle_no, request_type, seq_no,
    raised_by, reason_id, remarks, delay_category, expected_completion,
    sub_tat_minutes, sub_tat_due_at, pause_granted)
  values (p_assignment, a.breach_cycle_no, p_type, v_seq, p_actor, p_reason, p_remarks,
    coalesce(p_delay_category, case when p_type='DELAY' then r.implied_attribution end),
    p_expected_completion, v_sub, v_due, v_granted)
  returning id into v_id;

  if v_granted and si.id is not null then
    perform ogl_segment_open(si.id, 'PAUSED', coalesce(r.implied_attribution,'EXTERNAL'),
                             false, false, p_reason, r.label, p_actor);
  end if;

  if p_type <> 'DISPUTE' then
    update assignment set open_request_type = p_type where id = p_assignment;
  end if;

  insert into assignment_event (assignment_id, event_type, actor_id, from_state, to_state, payload)
  values (p_assignment, p_type || '_RAISED', p_actor, a.current_state, a.current_state,
          jsonb_build_object('request', v_id, 'reason', r.code, 'remarks', p_remarks,
                             'pause', v_pause, 'sub_tat_due_at', v_due));
  if v_sub is not null then
    insert into assignment_event (assignment_id, event_type, actor_id, is_system, payload)
    values (p_assignment, 'SUB_TAT_STARTED', p_actor, true,
            jsonb_build_object('request', v_id, 'minutes', v_sub, 'due_at', v_due));
  end if;

  -- the state move, through the only thing allowed to make one
  if p_type = 'RFI' then
    perform ogl_transition(p_assignment, 'AWAITING_INFORMATION', p_actor, r.label);
    v_counter := a.assignor_id;
  elsif p_type = 'DELAY' then
    perform ogl_transition(p_assignment, 'DELAY_REVIEW', p_actor, r.label);
    v_counter := a.assignor_id;
  elsif p_type = 'DISPUTE' then
    if a.dispute_count >= 2 then
      perform ogl_transition(p_assignment, 'ARBITRATION', p_actor, r.label);
    else
      perform ogl_transition(p_assignment, 'REWORK', p_actor, r.label);
    end if;
    v_counter := a.allocated_to_id;
  else
    v_counter := a.allocated_to_id;
  end if;

  select full_name into v_actor_name from person where id = p_actor;
  select coalesce(a.ref,'') into v_to;

  perform ogl_notify(p_assignment, v_counter, p_type || '_RAISED',
    case p_type when 'RFI' then 'information needed'
                when 'DELAY' then 'a delay has been reported'
                when 'DISPUTE' then 'the report has been disputed'
                else 'placed on hold' end,
    coalesce(v_actor_name,'Someone') || ' raised a ' || p_type || ' on ' || v_to || '.' ||
    E'\n' || 'Reason: ' || r.label ||
    coalesce(E'\n' || 'Remarks: ' || p_remarks, '') ||
    case when v_due is not null then
      E'\n' || 'You have until ' || to_char(ogl_ts(v_due), 'DD Mon, HH24:MI') ||
      ' IST to respond.' else '' end,
    p_assignment::text || ':' || p_type || ':' || v_id::text);

  return jsonb_build_object('id', v_id, 'type', p_type, 'seq_no', v_seq,
    'pause_granted', v_granted, 'pause', v_pause,
    'sub_tat_due_at', v_due,
    'state', (select current_state from assignment where id = p_assignment));
end $fn$;

create or replace function ogl_request_resolve(
  p_request uuid, p_resolution text, p_actor uuid,
  p_remarks text default null, p_system boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  q assignment_request%rowtype; a assignment%rowtype; si sla_instance%rowtype;
  r reason_taxonomy%rowtype; v_paused int; v_credit int; v_cap int;
  v_ext timestamptz; v_ceiling timestamptz; v_attr text; v_ok text[];
  v_new_due timestamptz;
begin
  select * into q from assignment_request where id = p_request for update;
  if not found then return jsonb_build_object('error','no_such_request'); end if;
  if q.resolved_at is not null then
    return jsonb_build_object('error','already_resolved',
      'reason','This was resolved on ' || to_char(ogl_ts(q.resolved_at),'DD Mon at HH24:MI') ||
               ' as ' || q.resolution || '.');
  end if;

  select * into a from assignment where id = q.assignment_id for update;
  select * into r from reason_taxonomy where id = q.reason_id;

  v_ok := case q.request_type
            when 'RFI'   then array['ANSWERED','REJECTED_INVALID']
            when 'DELAY' then array['ACCEPTED','DENIED','AUTO_ACCEPTED']
            when 'HOLD'  then array['RELEASED']
            when 'DISPUTE' then array['UPHELD','NOT_UPHELD']
            end;
  if not (p_resolution = any(v_ok)) then
    return jsonb_build_object('error','bad_resolution',
      'reason','A ' || q.request_type || ' is resolved as one of: ' || array_to_string(v_ok, ', ') || '.');
  end if;

  -- the counterparty answers, not the person who asked. A system sweep is
  -- the one exception and it says so rather than borrowing somebody's name.
  if not p_system then
    if q.request_type in ('RFI','DELAY','HOLD') then
      if a.assignor_id is distinct from p_actor
         and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
        return jsonb_build_object('error','not_the_assignor',
          'reason','The assignor answers a ' || q.request_type || '.');
      end if;
    end if;
    if p_resolution = 'AUTO_ACCEPTED' then
      return jsonb_build_object('error','not_yours_to_give',
        'reason','AUTO_ACCEPTED is what happens when nobody answers. It is not a choice.');
    end if;
  end if;

  si := ogl_live_sla(q.assignment_id);

  if q.pause_granted and si.id is not null then
    v_paused := ogl_segment_close(si.id, now());
    v_cap := case q.request_type when 'RFI'
               then ogl_setting_int('ogl_pause_cap_minutes', 120)
               else 100000 end;   -- an approved hold is not capped; it is approved
    v_credit := least(coalesce(v_paused,0), v_cap);
    v_new_due := add_business_minutes(si.due_at, v_credit, si.calendar_id);
    update sla_instance set due_at = v_new_due where id = si.id;
    update assignment_request set pause_minutes_credited = v_credit where id = p_request;
    insert into assignment_event (assignment_id, event_type, actor_id, is_system, payload)
    values (q.assignment_id, 'CLOCK_RESUMED', p_actor, p_system,
            jsonb_build_object('paused_minutes', v_paused, 'credited', v_credit,
                               'capped', coalesce(v_paused,0) > v_cap, 'due_at', v_new_due));
  end if;

  -- an accepted delay moves the due date, never past the ceiling, and never
  -- backwards: asking for less time than you already have changes nothing
  if q.request_type = 'DELAY' and p_resolution in ('ACCEPTED','AUTO_ACCEPTED') and si.id is not null then
    v_ceiling := add_business_minutes(coalesce(si.due_at, now()),
                   ogl_setting_int('ogl_delay_extension_cap_minutes', 720), si.calendar_id);
    v_ext := least(coalesce(q.expected_completion, v_ceiling), v_ceiling);
    if v_ext > coalesce(si.extended_to, si.due_at) then
      update sla_instance set extended_to = v_ext where id = si.id;
    else
      v_ext := null;   -- nothing moved; say nothing moved
    end if;
    insert into assignment_event (assignment_id, event_type, actor_id, is_system, payload)
    values (q.assignment_id,
            case when p_resolution='AUTO_ACCEPTED' then 'DELAY_AUTO_ACCEPTED' else 'DELAY_ACCEPTED' end,
            p_actor, p_system,
            jsonb_build_object('asked_for', q.expected_completion, 'granted_to', v_ext,
                               'ceiling', v_ceiling,
                               'capped', coalesce(q.expected_completion, v_ceiling) > v_ceiling,
                               'no_change', v_ext is null));
  end if;

  -- the segment the assignment runs in from here. An auto-accepted delay
  -- runs as PENDING_REVIEW: the time counts against the deadline, because it
  -- passed, but not against anybody's record until a person says whose it
  -- was. Silence must not be able to convict or acquit.
  if si.id is not null and q.request_type <> 'DISPUTE' then
    if p_resolution = 'AUTO_ACCEPTED' then
      v_attr := 'PENDING_REVIEW';
      perform ogl_segment_open(si.id, 'RUNNING', v_attr, true, false, q.reason_id,
                               'auto-accepted delay, attribution not yet confirmed', p_actor);
    else
      v_attr := case when p_resolution = 'ACCEPTED' then coalesce(r.implied_attribution,'ASSIGNEE')
                     else 'ASSIGNEE' end;
      perform ogl_segment_open(si.id, 'RUNNING', v_attr, true,
                               v_attr = 'ASSIGNEE', q.reason_id, r.label, p_actor);
    end if;
  end if;

  update assignment_request set resolution = p_resolution, resolved_by = p_actor,
         resolved_at = now(), resolution_remarks = p_remarks
   where id = p_request;

  if q.request_type <> 'DISPUTE' then
    update assignment set open_request_type = null where id = q.assignment_id;
  end if;

  -- the generic line stands aside where a specific one has already fired;
  -- an event log with duplicates in it is a log people stop trusting
  if not (q.request_type = 'DELAY' and p_resolution in ('ACCEPTED','AUTO_ACCEPTED')) then
    insert into assignment_event (assignment_id, event_type, actor_id, is_system, payload)
    values (q.assignment_id, q.request_type || '_' ||
            case p_resolution when 'REJECTED_INVALID' then 'REJECTED' else p_resolution end,
            p_actor, p_system,
            jsonb_build_object('request', p_request, 'remarks', p_remarks));
  end if;

  if q.request_type in ('RFI','DELAY') and a.current_state in ('AWAITING_INFORMATION','DELAY_REVIEW') then
    perform ogl_transition(q.assignment_id, 'IN_PROGRESS', p_actor,
      q.request_type || ' ' || p_resolution);
  end if;

  perform ogl_notify(q.assignment_id, q.raised_by, q.request_type || '_' || p_resolution,
    case p_resolution
      when 'ANSWERED' then 'your question has been answered'
      when 'REJECTED_INVALID' then 'your request was not accepted'
      when 'ACCEPTED' then 'your delay was accepted'
      when 'AUTO_ACCEPTED' then 'your delay was accepted with nobody reviewing it'
      when 'DENIED' then 'your delay was not accepted'
      else 'the hold has been released' end,
    'The ' || q.request_type || ' you raised has been resolved as ' || p_resolution || '.' ||
    coalesce(E'\n' || 'Remarks: ' || p_remarks, '') ||
    case when v_credit is not null and v_credit > 0 then
      E'\n' || v_credit || ' business minutes were credited back to the clock.'
      else '' end ||
    case when v_ext is not null then
      E'\n' || 'The deadline moved to ' || to_char(ogl_ts(v_ext), 'DD Mon at HH24:MI') || ' IST.'
      else '' end,
    p_request::text || ':resolved');

  return jsonb_build_object('id', p_request, 'resolution', p_resolution,
    'credited_minutes', v_credit, 'extended_to', v_ext,
    'state', (select current_state from assignment where id = q.assignment_id));
end $fn$;

-- Somebody has to say whose the time was. Until they do it belongs to
-- nobody, and the strike sweep will not touch the cycle.
create or replace function ogl_attribution_confirm(
  p_segment uuid, p_reason uuid, p_actor uuid, p_remarks text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  s sla_clock_segment%rowtype; a assignment%rowtype; r reason_taxonomy%rowtype;
  v_attr text;
begin
  select * into s from sla_clock_segment where id = p_segment for update;
  if not found then return jsonb_build_object('error','no_such_segment'); end if;
  if s.attribution <> 'PENDING_REVIEW' then
    return jsonb_build_object('error','nothing_pending',
      'reason','That stretch of time is already attributed to ' || s.attribution || '.');
  end if;

  select asg.* into a from assignment asg
    join sla_instance si on si.assignment_id = asg.id
   where si.id = s.sla_instance_id;

  if a.assignor_id is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN'
     and not exists (select 1 from person p where p.id = a.assignor_id and p.manager_id = p_actor) then
    return jsonb_build_object('error','not_yours_to_confirm',
      'reason','The assignor, their manager, or an administrator confirms attribution.');
  end if;

  select * into r from reason_taxonomy where id = p_reason and context = 'ATTRIBUTION';
  if not found then
    return jsonb_build_object('error','no_such_reason',
      'reason','Choose one of the attribution outcomes.');
  end if;
  if r.requires_remarks and coalesce(btrim(coalesce(p_remarks,'')),'') = '' then
    return jsonb_build_object('error','remarks_required',
      'reason','Reclassifying time needs a sentence saying why.');
  end if;

  v_attr := case r.code
    when 'RECLASSIFIED_ASSIGNEE' then 'ASSIGNEE'
    when 'RECLASSIFIED_EXTERNAL' then 'EXTERNAL'
    -- the delay's own reason stands
    else coalesce((select implied_attribution from reason_taxonomy where id = s.reason_id), 'EXTERNAL')
  end;

  update sla_clock_segment
     set attribution      = v_attr,
         counts_to_strike = (v_attr = 'ASSIGNEE'),
         reason_text      = coalesce(p_remarks, s.reason_text),
         set_by           = p_actor
   where id = p_segment;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (a.id, 'ATTRIBUTION_CONFIRMED', p_actor,
          jsonb_build_object('segment', p_segment, 'outcome', r.code,
                             'attribution', v_attr, 'remarks', p_remarks));

  return jsonb_build_object('segment', p_segment, 'outcome', r.code, 'attribution', v_attr);
end $fn$;

-- What is waiting for somebody to say whose it was.
create or replace function ogl_attribution_tray(p_person uuid)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.opened_at), '[]'::jsonb) from (
    select s.id as segment_id, s.opened_at, s.reason_text,
           a.id as assignment_id, a.ref, a.current_state,
           p.full_name as allocated_to,
           business_minutes_between(s.opened_at, coalesce(s.closed_at, now()), si.calendar_id) as minutes
      from sla_clock_segment s
      join sla_instance si on si.id = s.sla_instance_id
      join assignment a on a.id = si.assignment_id
      left join person p on p.id = a.allocated_to_id
     where s.attribution = 'PENDING_REVIEW'
       and (a.assignor_id = p_person
            or exists (select 1 from person m where m.id = a.assignor_id and m.manager_id = p_person)
            or (select app_role from person where id = p_person) = 'ADMIN')
     order by s.opened_at) x
$fn$;

-- ============================== escalation: one adapter, called from one place

-- Who an escalation at this level reaches. Four attempts, most specific
-- first, and the fourth is a walk up the line from the assignee - so an
-- escalation is never dropped because the matrix has a hole in it. When the
-- walk is used it is recorded, and the hole is named to the people who can
-- fill it.
create or replace function ogl_escalation_route(p_assignment uuid, p_level int)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare
  a assignment%rowtype; vc verification_case%rowtype;
  m ogl_escalation_matrix%rowtype; v_person uuid; v_chair uuid;
  v_steps int; v_cur uuid; v_trace jsonb := '[]'::jsonb; v_hit boolean := false;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  select * into vc from verification_case where id = a.case_id;

  select * into m from ogl_escalation_matrix
   where escalation_level = p_level and effective_to is null
     and client_id is not distinct from vc.client_id
     and location_id is not distinct from a.to_location_id
     and branch_id is not distinct from vc.branch_id
   order by sequence_no limit 1;
  v_hit := found;
  v_trace := v_trace || jsonb_build_object('tried','client+location+branch','hit', v_hit);

  if not v_hit then
    select * into m from ogl_escalation_matrix
     where escalation_level = p_level and effective_to is null
       and client_id is not distinct from vc.client_id
       and location_id is not distinct from a.to_location_id
       and branch_id is null
     order by sequence_no limit 1;
    v_hit := found;
    v_trace := v_trace || jsonb_build_object('tried','client+location','hit', v_hit);
  end if;

  if not v_hit then
    select * into m from ogl_escalation_matrix
     where escalation_level = p_level and effective_to is null
       and client_id is null
       and location_id is not distinct from a.to_location_id
     order by sequence_no limit 1;
    v_hit := found;
    v_trace := v_trace || jsonb_build_object('tried','location','hit', v_hit);
  end if;

  if v_hit then
    v_person := m.person_id;
    v_chair  := m.chair_id;
    -- a chair without a named person resolves to whoever holds it today
    if v_person is null and v_chair is not null then
      select h.person_id into v_person
        from chair_holder h join person p on p.id = h.person_id
       where h.chair_id = v_chair
         and (h.to_date is null or h.to_date >= current_date)
         and h.from_date <= current_date
         and p.employment_status = 'ACTIVE' and p.superseded_by is null
       order by h.is_primary desc, h.from_date desc
       limit 1;
    end if;
    if v_person is not null then
      return jsonb_build_object('person_id', v_person, 'chair_id', v_chair,
        'fallback_used', false, 'trace', v_trace);
    end if;
    v_trace := v_trace || jsonb_build_object('note','a matrix row was found but nobody holds that chair');
  end if;

  -- the walk. Level N means N managers above the assignee.
  v_cur := coalesce(a.allocated_to_id, a.assignor_id);
  v_steps := p_level;
  while v_steps > 0 and v_cur is not null loop
    select manager_id into v_cur from person where id = v_cur;
    v_steps := v_steps - 1;
  end loop;
  -- climbing past the top lands on the top, not on nobody
  if v_cur is null then
    select id into v_cur from person
     where manager_id is null and employment_status = 'ACTIVE' and superseded_by is null
     limit 1;
  end if;
  v_trace := v_trace || jsonb_build_object('tried','hierarchy walk','hit', v_cur is not null);

  return jsonb_build_object('person_id', v_cur, 'chair_id', null,
    'fallback_used', true,
    'fallback_reason',
      'No escalation matrix row for level ' || p_level || ' at client ' ||
      coalesce((select name from client where id = vc.client_id), 'unknown') ||
      ', location ' || coalesce((select name from geo_node where id = a.to_location_id), 'unknown') ||
      '. Delivered by walking up the line from the assignee instead.',
    'trace', v_trace);
end $fn$;

create or replace function raise_escalation(
  p_assignment uuid, p_level int, p_trigger text, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  a assignment%rowtype; si sla_instance%rowtype; v_route jsonb;
  v_key text; v_id uuid; v_name text;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  if a.current_state in ('CLOSED','CANCELLED') then
    return jsonb_build_object('skipped','assignment_finished');
  end if;

  v_key := encode(extensions.digest(concat_ws('|', p_assignment::text,
             a.breach_cycle_no::text, p_level::text, p_trigger), 'sha256'), 'hex');

  v_route := ogl_escalation_route(p_assignment, p_level);

  insert into escalation_instance (assignment_id, breach_cycle_no, escalation_level,
    trigger_code, idempotency_key, resolved_to_id, resolved_chair_id,
    route_trace, fallback_used, fallback_reason)
  values (p_assignment, a.breach_cycle_no, p_level, p_trigger, v_key,
    nullif(v_route->>'person_id','')::uuid, nullif(v_route->>'chair_id','')::uuid,
    coalesce(v_route->'trace','[]'::jsonb),
    coalesce((v_route->>'fallback_used')::boolean, false),
    v_route->>'fallback_reason')
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  -- the same sweep running twice raises one escalation
  if v_id is null then
    return jsonb_build_object('duplicate', true, 'key', v_key);
  end if;

  si := ogl_live_sla(p_assignment);
  select full_name into v_name from person where id = a.allocated_to_id;

  insert into assignment_event (assignment_id, event_type, actor_id, is_system, payload)
  values (p_assignment, 'ESCALATED', p_actor, p_actor is null,
          jsonb_build_object('level', p_level, 'trigger', p_trigger,
                             'to', v_route->>'person_id', 'escalation', v_id));

  perform ogl_notify(p_assignment, nullif(v_route->>'person_id','')::uuid,
    'ESCALATION_L' || p_level,
    'escalated to level ' || p_level,
    'Assignment ' || coalesce(a.ref,'') || ' has been escalated to level ' || p_level ||
    ' because of ' || replace(lower(p_trigger), '_', ' ') || '.' || E'\n' ||
    'Allocated to: ' || coalesce(v_name, 'nobody yet') || '.' ||
    case when si.id is not null then E'\n' ||
      'Due ' || to_char(ogl_ts(coalesce(si.extended_to, si.due_at)), 'DD Mon at HH24:MI') || ' IST, ' ||
      'status ' || si.sla_status || '.' else '' end,
    v_key);

  -- a gap in configuration must never be the reason nobody hears about a
  -- breach, and must never stay invisible either
  if coalesce((v_route->>'fallback_used')::boolean, false) then
    insert into assignment_event (assignment_id, event_type, is_system, payload)
    values (p_assignment, 'ESCALATION_FALLBACK_USED', true,
            jsonb_build_object('level', p_level, 'reason', v_route->>'fallback_reason'));

    perform mail_enqueue('CONFIG_GAP', p.work_email,
      'Crux - the escalation matrix has a gap',
      v_route->>'fallback_reason' || E'\n\n' ||
      'The escalation was delivered anyway, by walking up the line from the ' ||
      'assignee. Adding the missing row will route the next one properly.',
      'assignment', p_assignment, null, now(),
      'configgap:' || coalesce(a.to_location_id::text,'-') || ':' || p_level || ':' || current_date::text)
      from person p
     where p.app_role = 'ADMIN' and p.employment_status = 'ACTIVE' and p.superseded_by is null;
  end if;

  return jsonb_build_object('id', v_id, 'level', p_level, 'trigger', p_trigger,
    'to', v_route->>'person_id', 'fallback_used', v_route->>'fallback_used');
end $fn$;

comment on function raise_escalation is
  'The one door escalation goes through. It computes its own idempotency key, '
  'so a sweep that runs twice raises one escalation; it never drops a delivery '
  'because the matrix is incomplete, and it never lets the gap stay quiet.';

-- ============================================================== the sweeps

-- A sub-TAT is the counterparty's own clock: two hours to answer a question,
-- one hour to review a delay. When it runs out, something has to happen, and
-- what happens differs by kind - which is the whole point of measuring it.
create or replace function ogl_sub_tat_sweep()
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  r record; v_breached int := 0; v_auto int := 0; v_esc int := 0; v_prior int;
  a assignment%rowtype;
begin
  for r in
    select q.* from assignment_request q
      join assignment asg on asg.id = q.assignment_id
     where q.resolved_at is null
       and q.sub_tat_breached = false
       and q.sub_tat_due_at is not null
       and q.sub_tat_due_at <= now()
       and asg.current_state not in ('CLOSED','CANCELLED')
     order by q.sub_tat_due_at
  loop
    update assignment_request set sub_tat_breached = true where id = r.id;
    v_breached := v_breached + 1;

    insert into assignment_event (assignment_id, event_type, is_system, payload)
    values (r.assignment_id, 'SUB_TAT_BREACHED', true,
            jsonb_build_object('request', r.id, 'type', r.request_type,
                               'due_at', r.sub_tat_due_at, 'minutes', r.sub_tat_minutes));

    if r.request_type = 'DELAY' then
      -- One auto-accept per assignment. A second unreviewed delay does not
      -- accept itself; it goes up a level. Otherwise silence becomes a
      -- renewable extension, which is exactly how the old system lost a year.
      select count(*) into v_prior from assignment_request
       where assignment_id = r.assignment_id and resolution = 'AUTO_ACCEPTED';

      if v_prior = 0 then
        select * into a from assignment where id = r.assignment_id;
        perform ogl_request_resolve(r.id, 'AUTO_ACCEPTED', a.assignor_id,
          'Nobody reviewed this within ' || r.sub_tat_minutes ||
          ' business minutes, so it was accepted. The time is recorded as ' ||
          'unattributed until somebody confirms whose it was.', true);
        v_auto := v_auto + 1;
        -- the assignor's manager is told, because an auto-accept is a thing
        -- that happened to them rather than a thing they did
        perform ogl_notify(r.assignment_id,
          (select manager_id from person where id = a.assignor_id),
          'DELAY_AUTO_ACCEPTED_MGR', 'a delay accepted itself',
          'A reported delay was accepted automatically because it was not ' ||
          'reviewed within ' || r.sub_tat_minutes || ' business minutes. It is ' ||
          'waiting in Confirm attribution until somebody says whose time it was.',
          r.id::text || ':auto:mgr');
      else
        perform raise_escalation(r.assignment_id, 2, 'SUB_TAT_BREACH');
        v_esc := v_esc + 1;
      end if;
    else
      perform raise_escalation(r.assignment_id, 1, 'SUB_TAT_BREACH');
      v_esc := v_esc + 1;
    end if;
  end loop;

  return jsonb_build_object('sub_tat_breached', v_breached,
    'delays_auto_accepted', v_auto, 'escalated', v_esc);
end $fn$;

-- Escalation climbs with time, not with anybody remembering to climb it.
-- Level 1 at the breach, one level per step thereafter, four at the top.
create or replace function ogl_escalation_sweep()
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare r record; v_step int; v_level int; v_raised int := 0; l int; res jsonb;
begin
  v_step := greatest(ogl_setting_int('ogl_escalation_step_minutes', 240), 1);

  for r in
    select si.id, si.assignment_id, si.calendar_id,
           coalesce(si.extended_to, si.due_at) as deadline
      from sla_instance si
      join assignment a on a.id = si.assignment_id
     where si.stopped_at is null
       and si.sla_status = 'BREACHED'
       and a.current_state not in ('CLOSED','CANCELLED')
       -- a paused clock is not breaching; nothing to climb
       and not exists (select 1 from sla_clock_segment s
                        where s.sla_instance_id = si.id and s.closed_at is null
                          and s.counts_to_sla = false)
  loop
    v_level := least(4, 1 + (business_minutes_between(r.deadline, now(), r.calendar_id) / v_step)::int);
    -- every level up to the current one, so a sweep that was not running for
    -- a day does not skip the levels it slept through
    for l in 1..v_level loop
      res := raise_escalation(r.assignment_id, l, 'BREACH');
      if not coalesce((res->>'duplicate')::boolean, false) and res ? 'id' then
        v_raised := v_raised + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('escalations_raised', v_raised);
end $fn$;

-- Three tests, all of which must hold. The old STRIKE_SWEEP held the script
-- lock and ran 1,690 times to produce 1,535 no-ops; this one takes an
-- advisory lock it releases with the transaction, and cannot produce a
-- second strike for the same breach because a unique constraint says so.
create or replace function ogl_strike_sweep()
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  r record; v_made int := 0; v_no int; v_window int; v_exposure int; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ogl_strike_sweep'));
  v_window := ogl_setting_int('ogl_strike_window_days', 90);

  for r in
    select si.id as sla_id, si.assignment_id, si.breach_cycle_no,
           si.tat_business_minutes, si.calendar_id,
           coalesce(si.extended_to, si.due_at) as deadline,
           coalesce(sr.grace_minutes, 0) as grace,
           a.allocated_to_id, a.to_location_id, a.ref
      from sla_instance si
      join sla_rule sr on sr.id = si.sla_rule_id
      join assignment a on a.id = si.assignment_id
     where si.sla_status = 'BREACHED'
       and a.allocated_to_id is not null
       and a.current_state not in ('CANCELLED')
       -- nobody is struck for time whose owner has not been established
       and not ogl_attribution_pending(si.id)
       and not exists (select 1 from strike_event s
                        where s.assignment_id = si.assignment_id
                          and s.breach_cycle_no = si.breach_cycle_no
                          and s.trigger_code = 'SLA_BREACH')
  loop
    -- past grace, measured in business minutes like everything else
    if now() <= add_business_minutes(r.deadline, r.grace, r.calendar_id) then
      continue;
    end if;

    -- and the assignee's own time has to exceed the whole TAT. Time that
    -- belonged to the client, the weather or the assignor does not count.
    v_exposure := ogl_strike_exposure(r.sla_id);
    if v_exposure <= r.tat_business_minutes then
      continue;
    end if;

    select count(*) + 1 into v_no from strike_event
     where person_id = r.allocated_to_id and status = 'ACTIVE'
       and occurred_at > now() - (v_window || ' days')::interval;

    insert into strike_event (person_id, location_id, assignment_id, breach_cycle_no,
      trigger_code, occurred_at, attributable_minutes, strike_no, facts)
    values (r.allocated_to_id, r.to_location_id, r.assignment_id, r.breach_cycle_no,
      'SLA_BREACH', now(), v_exposure, v_no,
      jsonb_build_object('ref', r.ref, 'tat', r.tat_business_minutes,
                         'exposure', v_exposure, 'deadline', r.deadline,
                         'grace_minutes', r.grace))
    on conflict (assignment_id, breach_cycle_no, trigger_code) do nothing
    returning id into v_id;

    if v_id is not null then
      v_made := v_made + 1;
      insert into assignment_event (assignment_id, event_type, is_system, payload)
      values (r.assignment_id, 'STRIKE_GENERATED', true,
              jsonb_build_object('strike', v_id, 'person', r.allocated_to_id,
                                 'strike_no', v_no, 'minutes', v_exposure));

      perform ogl_notify(r.assignment_id, r.allocated_to_id, 'STRIKE',
        'a strike has been recorded',
        'A strike has been recorded against ' || r.ref || '. It is strike ' ||
        v_no || ' in the last ' || v_window || ' days.' || E'\n' ||
        v_exposure || ' business minutes of the delay were attributed to you, ' ||
        'against a target of ' || r.tat_business_minutes || '.' || E'\n\n' ||
        'If you believe the attribution is wrong, say so - a strike can be ' ||
        'waived, and the record of the waiver stays visible.',
        r.assignment_id::text || ':strike:' || r.breach_cycle_no);
    end if;
  end loop;

  return jsonb_build_object('strikes_generated', v_made);
end $fn$;

-- A strike is waived, never deleted. The row stays and says who waived it.
create or replace function ogl_strike_waive(p_strike uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_role role_kind; s strike_event%rowtype;
begin
  select app_role into v_role from person where id = p_actor;
  if v_role not in ('ADMIN','MANAGER') then
    return jsonb_build_object('error','not_permitted',
      'reason','A manager or an administrator waives a strike.');
  end if;
  if coalesce(btrim(coalesce(p_reason,'')),'') = '' then
    return jsonb_build_object('error','reason_required',
      'reason','Waiving a strike needs a reason. It is the whole record of why.');
  end if;
  select * into s from strike_event where id = p_strike;
  if not found then return jsonb_build_object('error','no_such_strike'); end if;
  if s.status <> 'ACTIVE' then
    return jsonb_build_object('error','not_active',
      'reason','That strike is already ' || s.status || '.');
  end if;

  update strike_event set status = 'WAIVED', waived_by = p_actor, waived_reason = p_reason
   where id = p_strike;
  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (s.assignment_id, 'STRIKE_WAIVED', p_actor,
          jsonb_build_object('strike', p_strike, 'reason', p_reason));
  return jsonb_build_object('id', p_strike, 'status','WAIVED');
end $fn$;

-- ==================================== starting and stopping a clock

-- Which rule applies, and why. The scoring is written to rule_trace with the
-- runners-up, so that when somebody asks in three months why this assignment
-- got twenty-six hours and not twenty-four, the answer is in the row rather
-- than in somebody's memory.
create or replace function ogl_sla_start(p_assignment uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  a assignment%rowtype; vc verification_case%rowtype;
  v_cal uuid; v_rule sla_rule%rowtype; v_trace jsonb; v_id uuid;
  v_due timestamptz; v_vtype uuid;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;

  if exists (select 1 from sla_instance
              where assignment_id = p_assignment and breach_cycle_no = a.breach_cycle_no) then
    return jsonb_build_object('exists', true,
      'reason','Cycle ' || a.breach_cycle_no || ' already has a clock.');
  end if;

  select * into vc from verification_case where id = a.case_id;
  select r.verification_type_id into v_vtype from case_verification_requirement r
   where r.case_id = a.case_id order by r.attempt_no desc limit 1;

  -- the calendar of the location the work is in, else the default
  select id into v_cal from business_calendar
   where geo_node_id = a.to_location_id and effective_to is null limit 1;
  if v_cal is null then
    select id into v_cal from business_calendar where code = 'DEFAULT' limit 1;
  end if;
  if v_cal is null then
    return jsonb_build_object('error','no_calendar',
      'reason','No business calendar is configured, so no deadline can be computed.');
  end if;

  with scored as (
    select r.*,
      (case when r.client_id is not null and r.client_id = vc.client_id then 16 else 0 end) +
      (case when r.verification_type_id is not null and r.verification_type_id = v_vtype then 16 else 0 end) +
      (case when r.geo_node_id is not null and r.geo_node_id = a.to_location_id then 8 else 0 end) +
      (case when r.priority is not null and r.priority = a.priority_bucket then 8 else 0 end)
        as score
      from sla_rule r
     where r.effective_from <= current_date
       and (r.effective_to is null or r.effective_to >= current_date)
       and (r.client_id is null or r.client_id = vc.client_id)
       and (r.verification_type_id is null or r.verification_type_id = v_vtype)
       and (r.geo_node_id is null or r.geo_node_id = a.to_location_id)
       and (r.priority is null or r.priority = a.priority_bucket)
  )
  select * into v_rule from scored order by score desc, effective_from desc, version desc limit 1;

  if v_rule.id is null then
    return jsonb_build_object('error','no_rule',
      'reason','No SLA rule matches this assignment, so no deadline can be set. '
             ||'Load a rate card and an SLA rule before starting work.');
  end if;

  with scored as (
    select r.code, r.version, r.tat_business_minutes,
      (case when r.client_id is not null and r.client_id = vc.client_id then 16 else 0 end) +
      (case when r.verification_type_id is not null and r.verification_type_id = v_vtype then 16 else 0 end) +
      (case when r.geo_node_id is not null and r.geo_node_id = a.to_location_id then 8 else 0 end) +
      (case when r.priority is not null and r.priority = a.priority_bucket then 8 else 0 end)
        as score
      from sla_rule r
     where r.effective_from <= current_date
       and (r.effective_to is null or r.effective_to >= current_date)
  )
  select jsonb_build_object(
    'chosen', jsonb_build_object('code', v_rule.code, 'version', v_rule.version),
    'dimensions', jsonb_build_object('client', 16, 'verification_type', 16,
                                     'geography', 8, 'priority', 8),
    'runners_up', coalesce(jsonb_agg(jsonb_build_object(
        'code', s.code, 'version', s.version, 'score', s.score,
        'tat', s.tat_business_minutes) order by s.score desc), '[]'::jsonb))
    into v_trace
    from (select * from scored order by score desc limit 5) s;

  v_due := add_business_minutes(now(), v_rule.tat_business_minutes, v_cal);

  insert into sla_instance (assignment_id, breach_cycle_no, sla_rule_id, rule_trace,
    calendar_id, tat_business_minutes, started_at, due_at)
  values (p_assignment, a.breach_cycle_no, v_rule.id, v_trace, v_cal,
    v_rule.tat_business_minutes, now(), v_due)
  returning id into v_id;

  perform ogl_segment_open(v_id, 'RUNNING', 'ASSIGNEE', true, true, null,
                           'work in progress', p_actor);

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (p_assignment, 'SLA_INSTANCE_CREATED', p_actor,
          jsonb_build_object('instance', v_id, 'cycle', a.breach_cycle_no,
                             'tat', v_rule.tat_business_minutes, 'due_at', v_due,
                             'rule', v_rule.code || ' v' || v_rule.version));

  return jsonb_build_object('id', v_id, 'due_at', v_due,
    'tat_business_minutes', v_rule.tat_business_minutes,
    'rule', v_rule.code || ' v' || v_rule.version, 'trace', v_trace);
end $fn$;

create or replace function ogl_sla_stop(p_assignment uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare si sla_instance%rowtype; v_min int;
begin
  si := ogl_live_sla(p_assignment);
  if si.id is null then return jsonb_build_object('skipped','no_running_clock'); end if;
  v_min := ogl_segment_close(si.id, now());
  update sla_instance set stopped_at = now() where id = si.id;
  insert into assignment_event (assignment_id, event_type, actor_id, is_system, payload)
  values (p_assignment, 'CLOCK_STOPPED', p_actor, p_actor is null,
          jsonb_build_object('instance', si.id, 'final_segment_minutes', v_min,
                             'elapsed', ogl_elapsed_sla(si.id)));
  return jsonb_build_object('instance', si.id, 'elapsed', ogl_elapsed_sla(si.id));
end $fn$;

-- ============================= the transition service now drives the clock
-- Until now ogl_transition moved the state and left the clock to whoever
-- remembered. That is the seam the old system's workflow leaked through, so
-- it closes here: the one writer of current_state is also the one thing that
-- starts and stops a clock. Only the clock block at the end is new; every
-- guard above it is v13's, unchanged.
create or replace function ogl_transition(p_assignment uuid, p_to text, p_actor uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; v_guard text; v_next uuid; v_clock jsonb;
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
               || to_char(ogl_ts(a.closed_at), 'DD Mon YYYY') || '.');
  end if;
  if p_to = 'REOPENED' and coalesce(btrim(coalesce(p_reason,'')),'') = '' then
    return jsonb_build_object('error','reason_required',
      'reason','Reopening needs a reason. It is the first thing anyone asks.');
  end if;

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
    when 'ARBITRATION'          then null
    else null end;

  perform set_config('crux.ogl_transition', 'on', true);

  update assignment set
    current_state        = p_to,
    next_action_owner_id = v_next,
    delay_count   = delay_count   + case when p_to = 'DELAY_REVIEW' then 1 else 0 end,
    dispute_count = dispute_count + case when p_to = 'REWORK' and a.current_state = 'UNDER_REVIEW' then 1 else 0 end,
    breach_cycle_no = breach_cycle_no + case when p_to = 'REWORK' or p_to = 'REOPENED' then 1 else 0 end,
    closed_at = case when p_to in ('CLOSED','CANCELLED') then now()
                     when p_to = 'REOPENED' then null
                     else closed_at end
   where id = p_assignment;

  perform set_config('crux.ogl_transition', 'off', true);

  insert into assignment_event (assignment_id, event_type, actor_id, from_state, to_state, payload)
  values (p_assignment, 'STATE_CHANGED', p_actor, a.current_state, p_to,
          jsonb_build_object('reason', p_reason, 'guard', v_guard));

  -- the clock follows the state, in the same transaction as the state
  if p_to = 'IN_PROGRESS' and a.current_state in ('ACCEPTED','REOPENED') then
    v_clock := ogl_sla_start(p_assignment, p_actor);
  elsif p_to in ('REWORK','REOPENED') then
    -- a new cycle is new work with its own deadline; the old one is closed
    perform ogl_sla_stop(p_assignment, p_actor);
    if p_to = 'REWORK' then v_clock := ogl_sla_start(p_assignment, p_actor); end if;
  elsif p_to in ('COMPLETED','CLOSED','CANCELLED') then
    v_clock := ogl_sla_stop(p_assignment, p_actor);
  end if;

  if p_to = 'COMPLETED' then
    perform ogl_transition(p_assignment, 'UNDER_REVIEW', p_actor, 'automatic on completion');
    return jsonb_build_object('state','UNDER_REVIEW','via','COMPLETED','clock', v_clock);
  end if;

  return jsonb_build_object('state', p_to, 'next_action_owner', v_next, 'clock', v_clock);
end $fn$;

-- ====================================================== one tick, everything in it
create or replace function crux_tick()
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_run uuid; v_closed int := 0; v_risk int := 0; v_breached int := 0;
  v_sub jsonb := '{}'::jsonb; v_esc jsonb := '{}'::jsonb; v_strk jsonb := '{}'::jsonb;
  v_counts jsonb;
begin
  insert into job_run (job_key, started_at, state)
  values ('CRUX_TICK', now(), 'RUNNING') returning id into v_run;

  -- R-05: a resolved case closes itself seven days later, on the schedule set
  -- when it was resolved rather than by a sweep guessing at it.
  if coalesce((select enabled from job_config where job_key='AUTO_CLOSE'), true) then
    with done as (
      update "case" set status = 'CLOSED', closed_at = now(), last_activity_at = now()
       where status = 'RESOLVED' and auto_close_at is not null and auto_close_at <= now()
      returning id
    )
    insert into case_event (case_id, at, kind, note)
    select id, now(), 'AUTO_CLOSED', 'Closed automatically seven days after resolution.' from done;
    get diagnostics v_closed = row_count;
  end if;

  -- SLA status is derived from the clock, never typed in. A paused clock is
  -- not breaching: while a granted pause is open the deadline does not move
  -- towards the assignment.
  if coalesce((select enabled from job_config where job_key='SLA_SWEEP'), true) then
    with hit as (
      update sla_instance si set sla_status = 'BREACHED'
        where si.stopped_at is null and si.sla_status <> 'BREACHED'
          and now() > coalesce(si.extended_to, si.due_at)
          and not exists (select 1 from sla_clock_segment s
                           where s.sla_instance_id = si.id and s.closed_at is null
                             and s.counts_to_sla = false)
      returning si.assignment_id, si.id, coalesce(si.extended_to, si.due_at) as deadline)
    insert into assignment_event (assignment_id, event_type, is_system, payload)
    select assignment_id, 'SLA_BREACHED', true,
           jsonb_build_object('instance', id, 'deadline', deadline) from hit;
    get diagnostics v_breached = row_count;

    with hit as (
      update sla_instance si set sla_status = 'AT_RISK'
        from sla_rule r
       where r.id = si.sla_rule_id
         and si.stopped_at is null and si.sla_status = 'ON_TRACK'
         and not exists (select 1 from sla_clock_segment s
                          where s.sla_instance_id = si.id and s.closed_at is null
                            and s.counts_to_sla = false)
         and ogl_elapsed_sla(si.id) >= si.tat_business_minutes * r.at_risk_pct / 100.0
      returning si.assignment_id, si.id, r.at_risk_pct)
    insert into assignment_event (assignment_id, event_type, is_system, payload)
    select assignment_id, 'SLA_AT_RISK', true,
           jsonb_build_object('instance', id, 'at_risk_pct', at_risk_pct) from hit;
    get diagnostics v_risk = row_count;
  end if;

  -- the OGL engine: sub-TATs first, because an auto-accepted delay moves a
  -- deadline and the escalation sweep should see the moved one
  if coalesce((select enabled from job_config where job_key='OGL_SWEEP'), true) then
    v_sub  := ogl_sub_tat_sweep();
    v_esc  := ogl_escalation_sweep();
    v_strk := ogl_strike_sweep();
  end if;

  v_counts := jsonb_build_object('auto_closed', v_closed,
                'sla_at_risk', v_risk, 'sla_breached', v_breached)
              || v_sub || v_esc || v_strk;

  update job_run set finished_at = now(), state = 'DONE', counts = v_counts where id = v_run;
  return v_counts;
exception when others then
  update job_run set finished_at = now(), state = 'FAILED', error = sqlerrm where id = v_run;
  raise;
end $fn$;

comment on function crux_tick is
  'Everything that happens because time passed: auto-close, the SLA sweep, '
  'sub-TATs and the delay auto-accept, escalation, strikes. One function, one '
  'job_run row, one place to look when somebody asks what the tool did '
  'overnight.';

-- ======================================================= what the screens read

create or replace function ogl_reasons(p_context text default null)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.context, x.label), '[]'::jsonb) from (
    select id, context, code, label, requires_remarks, implied_attribution, pause_eligible
      from reason_taxonomy
     where active and (p_context is null or context = p_context)) x
$fn$;

-- One assignment, whole. current_state is the operational position; the SLA
-- status, the escalation level and the open request sit beside it as the
-- separate facts they are.
create or replace function ogl_detail(p_assignment uuid, p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare a assignment%rowtype; si sla_instance%rowtype; v_may boolean;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;

  -- D8: nobody borrows another chair's data, and an empty answer says why
  v_may := p_person in (a.assignor_id, a.allocated_to_id, a.next_action_owner_id)
        or (select app_role from person where id = p_person) = 'ADMIN'
        or exists (select 1 from person p where p.id in (a.assignor_id, a.allocated_to_id)
                     and p.manager_id = p_person)
        or exists (select 1 from temp_participant_grant g
                    where g.assignment_id = p_assignment and g.person_id = p_person
                      and g.revoked_at is null and g.expires_at > now())
        or exists (select 1 from escalation_instance e
                    where e.assignment_id = p_assignment and e.resolved_to_id = p_person);
  if not v_may then
    return jsonb_build_object('error','not_yours',
      'reason','This assignment belongs to another chair. You are not the assignor, '
             ||'the assignee, their manager, or anyone it has been escalated to.');
  end if;

  si := ogl_live_sla(p_assignment);

  return jsonb_build_object(
    'assignment', to_jsonb(a) || jsonb_build_object(
      'assignor', (select full_name from person where id = a.assignor_id),
      'allocated_to', (select full_name from person where id = a.allocated_to_id),
      'next_action_owner', (select full_name from person where id = a.next_action_owner_id),
      'location', (select name from geo_node where id = a.to_location_id)),
    'case', (select to_jsonb(c) || jsonb_build_object(
               'client', (select name from client where id = c.client_id))
               from verification_case c where c.id = a.case_id),
    'parties', coalesce((select jsonb_agg(to_jsonb(cp) order by cp.party_role, cp.seq_no)
                  from case_party cp where cp.case_id = a.case_id), '[]'::jsonb),
    'requirements', coalesce((select jsonb_agg(to_jsonb(cr) || jsonb_build_object(
                       'verification_type', (select label from verification_type where id = cr.verification_type_id))
                       order by cr.force1_point_id, cr.attempt_no)
                       from case_verification_requirement cr where cr.case_id = a.case_id), '[]'::jsonb),
    'sla', case when si.id is null then null else
      to_jsonb(si) || jsonb_build_object(
        'elapsed_minutes', ogl_elapsed_sla(si.id),
        'strike_exposure', ogl_strike_exposure(si.id),
        'attribution_pending', ogl_attribution_pending(si.id),
        'due_ist', to_char(ogl_ts(coalesce(si.extended_to, si.due_at)), 'DD Mon YYYY HH24:MI'))
      end,
    'segments', coalesce((select jsonb_agg(to_jsonb(s) order by s.seq_no)
                  from sla_clock_segment s where s.sla_instance_id = si.id), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(q) || jsonb_build_object(
                   'reason', (select label from reason_taxonomy where id = q.reason_id),
                   'raised_by_name', (select full_name from person where id = q.raised_by))
                   order by q.raised_at desc)
                   from assignment_request q where q.assignment_id = p_assignment), '[]'::jsonb),
    'escalations', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object(
                     'to', (select full_name from person where id = e.resolved_to_id))
                     order by e.raised_at desc)
                     from escalation_instance e where e.assignment_id = p_assignment), '[]'::jsonb),
    'strikes', coalesce((select jsonb_agg(to_jsonb(st) order by st.occurred_at desc)
                 from strike_event st where st.assignment_id = p_assignment), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                 'at', ev.occurred_at, 'type', ev.event_type, 'from', ev.from_state,
                 'to', ev.to_state, 'system', ev.is_system,
                 'by', (select full_name from person where id = ev.actor_id),
                 'payload', ev.payload) order by ev.occurred_at desc, ev.id desc)
                 from (select * from assignment_event
                        where assignment_id = p_assignment
                        order by occurred_at desc, id desc limit 60) ev), '[]'::jsonb));
end $fn$;

-- What this person may do next, computed here rather than guessed at in the
-- browser. A button that is offered and then refused is worse than no button.
create or replace function ogl_actions(p_assignment uuid, p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare a assignment%rowtype; v_role role_kind; v_acts jsonb := '[]'::jsonb;
  v_is_assignee boolean; v_is_assignor boolean;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  select app_role into v_role from person where id = p_person;
  v_is_assignee := a.allocated_to_id = p_person;
  v_is_assignor := a.assignor_id = p_person;

  -- the states that follow, from the table rather than from a list here
  v_acts := coalesce((select jsonb_agg(jsonb_build_object('kind','transition','to', to_state,
              'label', initcap(replace(to_state,'_',' '))) order by to_state)
              from ogl_transition_rule where from_state = a.current_state), '[]'::jsonb);

  if v_is_assignee and a.current_state in ('IN_PROGRESS','REWORK') and a.open_request_type is null then
    v_acts := v_acts
      || jsonb_build_array(jsonb_build_object('kind','request','type','RFI',
           'label','Ask for information'))
      || case when a.delay_count < 3 then
           jsonb_build_array(jsonb_build_object('kind','request','type','DELAY',
             'label','Report a delay'))
         else '[]'::jsonb end;
  end if;

  if v_is_assignor and a.current_state = 'UNDER_REVIEW' then
    v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','request','type','DISPUTE',
      'label', case when a.dispute_count >= 2 then 'Dispute - this one goes to arbitration'
                    else 'Dispute the report' end));
  end if;

  if (v_is_assignor or v_role = 'ADMIN') and a.open_request_type is null
     and a.current_state not in ('CLOSED','CANCELLED','COMPLETED','UNDER_REVIEW') then
    v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','request','type','HOLD',
      'label','Place on hold'));
  end if;

  if a.open_request_type is not null and (v_is_assignor or v_role = 'ADMIN') then
    v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','resolve',
      'type', a.open_request_type, 'label','Answer the open ' || a.open_request_type,
      'request', (select q.id from assignment_request q
                   where q.assignment_id = p_assignment and q.resolved_at is null
                     and q.request_type <> 'DISPUTE' limit 1)));
  end if;

  return jsonb_build_object('state', a.current_state, 'open_request', a.open_request_type,
    'actions', v_acts);
end $fn$;

create or replace function ogl_strikes(p_person uuid, p_of uuid default null)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_at desc), '[]'::jsonb) from (
    select s.id, s.occurred_at, s.trigger_code, s.status, s.strike_no,
           s.attributable_minutes, s.waived_reason, s.facts,
           p.full_name as person, a.ref
      from strike_event s
      join person p on p.id = s.person_id
      left join assignment a on a.id = s.assignment_id
     where (coalesce(p_of, p_person) = s.person_id)
       and (s.person_id = p_person
            or (select app_role from person where id = p_person) in ('ADMIN','MANAGER')
            or p.manager_id = p_person)
     order by s.occurred_at desc limit 100) x
$fn$;

-- ================================================================= exposure
-- Everything here is reached through the edge functions, as service_role.
-- Nothing is granted to anon or authenticated: the shell authenticates the
-- person itself and then acts on their behalf.
do $do$
declare f text;
begin
  foreach f in array array[
    'ogl_setting_int(text,integer)','ogl_live_sla(uuid)',
    'ogl_segment_open(uuid,text,text,boolean,boolean,uuid,text,uuid,timestamptz)',
    'ogl_segment_close(uuid,timestamptz)','ogl_elapsed_sla(uuid)','ogl_strike_exposure(uuid)',
    'ogl_attribution_pending(uuid)','ogl_backfill_segments()','ogl_pause_preview(uuid,uuid)',
    'ogl_notify(uuid,uuid,text,text,text,text)',
    'ogl_request_raise(uuid,text,uuid,uuid,text,text,timestamptz)',
    'ogl_request_resolve(uuid,text,uuid,text,boolean)',
    'ogl_attribution_confirm(uuid,uuid,uuid,text)','ogl_attribution_tray(uuid)',
    'ogl_escalation_route(uuid,integer)','raise_escalation(uuid,integer,text,uuid)',
    'ogl_sub_tat_sweep()','ogl_escalation_sweep()','ogl_strike_sweep()',
    'ogl_strike_waive(uuid,uuid,text)',
    'ogl_sla_start(uuid,uuid)','ogl_sla_stop(uuid,uuid)',
    'ogl_reasons(text)','ogl_detail(uuid,uuid)','ogl_actions(uuid,uuid)','ogl_strikes(uuid,uuid)',
    'ogl_ts(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
