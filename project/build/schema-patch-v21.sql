-- =====================================================================
-- CRUX — schema patch v21
-- The three things that stood between "the module exists" and "an
-- operator can do a day's work in it".
--
--   1. Reporting and completion. The tables for a completion and its
--      evidence existed and nothing could write one. An assignee could
--      accept work, ask about it, be delayed on it and be struck for it,
--      and had no way to say what they found.
--   2. SLA rules by file. Every assignment was getting the single
--      CUTOVER rule at 1,440 minutes because there was no way to load a
--      real one.
--   3. The escalation matrix by file. Every escalation fell back to the
--      reporting line and raised a configuration alert saying so.
--
-- Run after schema-patch-v20.sql.
-- =====================================================================

-- ---------------------------------------- what a verification came back with
alter table case_verification_requirement
  add column if not exists outcome text
    check (outcome is null or outcome in ('POSITIVE','NEGATIVE','REFER','UNTRACEABLE','PARTIAL')),
  add column if not exists remarks text,
  add column if not exists findings jsonb not null default '{}',
  add column if not exists reported_at timestamptz,
  add column if not exists reported_by uuid references person(id);

comment on column case_verification_requirement.outcome is
  'What was found. POSITIVE, NEGATIVE, REFER, UNTRACEABLE or PARTIAL - the '
  'five answers a field verification actually comes back with. Null until '
  'the point is reported.';

create or replace function ogl_report_point(
  p_requirement uuid, p_actor uuid, p_outcome text,
  p_remarks text default null, p_findings jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare r case_verification_requirement%rowtype; a assignment%rowtype; v_left int;
begin
  select * into r from case_verification_requirement where id = p_requirement for update;
  if not found then return jsonb_build_object('error','no_such_requirement'); end if;

  select * into a from assignment where case_id = r.case_id order by created_at desc limit 1;
  if a.id is null then return jsonb_build_object('error','no_assignment_for_case'); end if;

  if a.allocated_to_id is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_the_assignee',
      'reason','The person the work is allocated to reports what they found.');
  end if;
  if a.current_state not in ('IN_PROGRESS','REWORK') then
    return jsonb_build_object('error','wrong_state',
      'reason','Findings are recorded while work is in progress. This is ' || a.current_state || '.');
  end if;
  if r.status in ('CLOSED','CANCELLED','SUPERSEDED') then
    return jsonb_build_object('error','not_open','reason','That point is ' || r.status || '.');
  end if;
  if p_outcome not in ('POSITIVE','NEGATIVE','REFER','UNTRACEABLE','PARTIAL') then
    return jsonb_build_object('error','bad_outcome',
      'reason','The outcome is one of POSITIVE, NEGATIVE, REFER, UNTRACEABLE or PARTIAL.');
  end if;
  -- anything but a clean positive has to say what happened
  if p_outcome <> 'POSITIVE' and coalesce(btrim(coalesce(p_remarks,'')),'') = '' then
    return jsonb_build_object('error','remarks_required',
      'reason','A ' || p_outcome || ' finding needs a sentence saying what was seen.');
  end if;

  update case_verification_requirement
     set status = 'REPORTED', outcome = p_outcome, remarks = p_remarks,
         findings = coalesce(p_findings, '{}'::jsonb),
         reported_at = now(), reported_by = p_actor
   where id = p_requirement;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (a.id, 'POINT_REPORTED', p_actor,
          jsonb_build_object('requirement', p_requirement, 'point_id', r.force1_point_id,
                             'outcome', p_outcome, 'remarks', p_remarks));

  select count(*) into v_left from case_verification_requirement
   where case_id = r.case_id and status in ('PENDING','IN_PROGRESS');

  return jsonb_build_object('id', p_requirement, 'outcome', p_outcome,
    'still_to_report', v_left,
    'note', case when v_left = 0
      then 'Every point is reported. The assignment can be completed.'
      else v_left || ' point(s) still to report.' end);
end $fn$;

-- Completion is a delivery, not a state change somebody types. The report
-- goes somewhere, by some channel, with a reference - and that reference is
-- what makes "was it sent?" answerable later without anybody's memory.
create or replace function ogl_complete(
  p_assignment uuid, p_actor uuid, p_channel text,
  p_recipient text default null, p_reference text default null,
  p_remarks text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; v_left int; v_id uuid; v_back boolean;
begin
  select * into a from assignment where id = p_assignment for update;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  if a.allocated_to_id is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_the_assignee',
      'reason','The person the work is allocated to completes it.');
  end if;
  if a.current_state not in ('IN_PROGRESS','REWORK') then
    return jsonb_build_object('error','wrong_state','reason','This is ' || a.current_state || '.');
  end if;
  if a.open_request_type is not null then
    return jsonb_build_object('error','request_open',
      'reason','A ' || a.open_request_type || ' is open. Resolve it before completing.');
  end if;

  select count(*) into v_left from case_verification_requirement
   where case_id = a.case_id and status in ('PENDING','IN_PROGRESS');
  if v_left > 0 then
    return jsonb_build_object('error','points_unreported',
      'reason', v_left || ' verification point(s) have no finding recorded. '
             || 'Report each one before completing.');
  end if;

  if coalesce(btrim(coalesce(p_channel,'')),'') = '' then
    return jsonb_build_object('error','channel_required',
      'reason','Say how the report was delivered - the channel is the evidence.');
  end if;

  -- a completion dated before the last thing that happened is flagged, not
  -- refused: backdating is sometimes honest and always worth seeing
  v_back := exists (select 1 from assignment_event e
                     where e.assignment_id = p_assignment and e.occurred_at > now());

  insert into assignment_completion (assignment_id, breach_cycle_no, channel,
    recipient, force1_ref, message_ref, other_remarks, submitted_by, shared_at)
  values (p_assignment, a.breach_cycle_no, upper(btrim(p_channel)),
    nullif(btrim(coalesce(p_recipient,'')),''),
    nullif(btrim(coalesce(p_reference,'')),''),
    nullif(btrim(coalesce(p_reference,'')),''),
    p_remarks, p_actor, now())
  returning id into v_id;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (p_assignment, 'COMPLETED', p_actor,
          jsonb_build_object('completion', v_id, 'channel', upper(btrim(p_channel)),
                             'recipient', p_recipient, 'reference', p_reference));

  return ogl_transition(p_assignment, 'COMPLETED', p_actor,
           'report delivered by ' || upper(btrim(p_channel)))
         || jsonb_build_object('completion', v_id, 'backdate_flagged', v_back);
end $fn$;

-- Accepting the report closes the case's points as well as the assignment.
-- Closing one without the other is how a case ends up closed with a point
-- still showing as open on somebody's list.
create or replace function ogl_review_accept(p_assignment uuid, p_actor uuid, p_remarks text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; r jsonb;
begin
  select * into a from assignment where id = p_assignment for update;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  if a.current_state <> 'UNDER_REVIEW' then
    return jsonb_build_object('error','wrong_state',
      'reason','A report is accepted while it is under review. This is ' || a.current_state || '.');
  end if;
  if a.assignor_id is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_the_assignor','reason','The assignor accepts the report.');
  end if;

  update case_verification_requirement set status = 'CLOSED'
   where case_id = a.case_id and status = 'REPORTED';

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (p_assignment, 'REVIEW_ACCEPTED', p_actor, jsonb_build_object('remarks', p_remarks));

  r := ogl_transition(p_assignment, 'CLOSED', p_actor, coalesce(p_remarks, 'report accepted'));
  perform ogl_notify(p_assignment, a.allocated_to_id, 'REVIEW_ACCEPTED',
    'your report was accepted', 'The report you submitted has been accepted and the assignment is closed.',
    p_assignment::text || ':accepted');
  return r;
end $fn$;

create or replace function ogl_open_points(p_assignment uuid)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.force1_point_id), '[]'::jsonb) from (
    select r.id, r.force1_point_id, r.status, r.attempt_no, r.lineage,
           t.label as verification_type, p.name as party, p.party_role, p.address
      from case_verification_requirement r
      join assignment a on a.case_id = r.case_id
      join verification_type t on t.id = r.verification_type_id
      join case_party p on p.id = r.party_id
     where a.id = p_assignment and r.status in ('PENDING','IN_PROGRESS')) x
$fn$;

-- The guard that already refuses a direct write to current_state gains a
-- second job: it refuses a move to COMPLETED while any verification point has
-- no finding on it. Here rather than in ogl_transition, so it holds for every
-- caller including a future one nobody has written yet.
create or replace function assignment_state_guard()
returns trigger language plpgsql set search_path = public as $fn$
declare v_left int;
begin
  if new.current_state is distinct from old.current_state
     and coalesce(current_setting('crux.ogl_transition', true), '') <> 'on' then
    raise exception 'current_state is written only by ogl_transition(); % -> % was attempted directly',
      old.current_state, new.current_state
      using hint = 'Call ogl_transition(assignment, to_state, actor, reason).';
  end if;

  if new.current_state = 'COMPLETED' and old.current_state is distinct from 'COMPLETED' then
    select count(*) into v_left from case_verification_requirement
     where case_id = new.case_id and status in ('PENDING','IN_PROGRESS');
    if v_left > 0 then
      raise exception 'cannot complete: % verification point(s) have no finding recorded', v_left
        using hint = 'Report each point first, then complete through ogl_complete().';
    end if;
  end if;

  return new;
end $fn$;

-- ================ a new file kind becomes a row, not a redeploy
-- The two dispatchers carried the list of kinds twice, in a CASE each. Every
-- new kind meant editing both and deploying. The name of the function that
-- handles a kind is data about that kind, so it lives on the kind.
alter table upload_kind
  add column if not exists validator text,
  add column if not exists applier text;

update upload_kind set validator = 'uv_' || v, applier = 'ua_' || v
  from (values
    ('Chairs','chairs'), ('People','people'), ('Geography','geography'),
    ('Clients and branches','clients'), ('Assignments','assignments'),
    ('Rates','rates'), ('Collections','collections'), ('KPI targets','kpi_targets'),
    ('Past performance','past_perf'), ('Opening balances','opening'), ('Holidays','holidays')
  ) as m(k, v)
 where upload_kind.kind = m.k;

create or replace function upload_validate(p_batch uuid)
returns table(rows_total integer, rows_ok integer, rows_error integer)
language plpgsql set search_path to 'public' as $fn$
declare v_kind text; v_fn text; v_total int; v_ok int; v_bad int;
begin
  select kind into v_kind from upload_batch where id = p_batch;
  if v_kind is null then raise exception 'no such batch'; end if;

  update upload_row set error = null where batch_id = p_batch;

  select validator into v_fn from upload_kind where kind = v_kind and implemented;
  if v_fn is null then
    update upload_row set error = 'no loader is implemented for this file kind yet'
     where batch_id = p_batch;
  else
    execute format('select %I($1)', v_fn) using p_batch;
  end if;

  select count(*)::int,
         count(*) filter (where error is null)::int,
         count(*) filter (where error is not null)::int
    into v_total, v_ok, v_bad
    from upload_row where batch_id = p_batch;

  update upload_batch b set rows_total = v_total, rows_ok = v_ok, rows_error = v_bad
   where b.id = p_batch;

  rows_total := v_total; rows_ok := v_ok; rows_error := v_bad;
  return next;
end $fn$;

create or replace function upload_apply(p_batch uuid, p_actor uuid)
returns table(applied integer)
language plpgsql set search_path to 'public' as $fn$
declare v_kind text; v_state text; v_err int; v_fn text; v_n int;
begin
  select kind, state, rows_error into v_kind, v_state, v_err
    from upload_batch where id = p_batch for update;
  if v_kind is null then raise exception 'no such batch'; end if;
  if v_state = 'APPLIED' then raise exception 'batch already applied'; end if;
  if v_err > 0 then
    raise exception 'file has % errored row(s); a file with any error applies zero rows', v_err
      using errcode = 'check_violation';
  end if;

  select applier into v_fn from upload_kind where kind = v_kind and implemented;
  if v_fn is null then raise exception 'no loader is implemented for %', v_kind; end if;
  execute format('select %I($1, $2)', v_fn) using p_batch, p_actor;

  update upload_batch set state = 'APPLIED', applied_at = now(), applied_by = p_actor
   where id = p_batch;

  select count(*)::int into v_n from upload_row where batch_id = p_batch and error is null;
  applied := v_n;
  return next;
end $fn$;

-- ------------------------------------------- the two kinds that were missing
insert into upload_kind (kind, load_order, needs, implemented, validator, applier) values
 ('SLA rules', 12, 'Clients and Geography, if the rule names either.', true, 'uv_sla_rules', 'ua_sla_rules'),
 ('Escalation matrix', 13, 'People, Clients and Geography.', true, 'uv_escalation', 'ua_escalation')
on conflict (kind) do update
  set load_order = excluded.load_order, needs = excluded.needs,
      implemented = excluded.implemented,
      validator = excluded.validator, applier = excluded.applier;

insert into upload_column (kind, ord, name, rule, example) values
 ('SLA rules', 1, 'code', 'Required. A short name for the rule. Loading the same code again makes a new version; the old one keeps its history.', 'NBK-RESIDENT-METRO'),
 ('SLA rules', 2, 'client_code', 'Blank means every client. Otherwise a client code that exists.', 'NBK'),
 ('SLA rules', 3, 'verification_type', 'Blank means every type. Otherwise RESIDENT, BUSINESS, EMPLOYEE or QUOTATION.', 'RESIDENT'),
 ('SLA rules', 4, 'zone', 'Blank means everywhere. Otherwise a zone that exists.', 'Pune'),
 ('SLA rules', 5, 'priority', 'Blank means every priority. Otherwise the bucket name.', 'Normal'),
 ('SLA rules', 6, 'tat_business_minutes', 'Required. Business minutes, not clock minutes. A seven-hour working day is 420. Twenty-four working hours is 1440.', '1440'),
 ('SLA rules', 7, 'grace_minutes', 'Business minutes past the deadline before a strike can be generated. 0 if none.', '60'),
 ('SLA rules', 8, 'at_risk_pct', 'Per cent of the TAT at which it starts showing as at risk. 75 if you have no view.', '75'),
 ('SLA rules', 9, 'effective_from', 'Required, YYYY-MM-DD.', '2026-10-01'),
 ('SLA rules', 10, 'effective_to', 'Blank for open-ended.', ''),
 ('Escalation matrix', 1, 'client_code', 'Blank means every client. Otherwise a client code that exists.', 'NBK'),
 ('Escalation matrix', 2, 'zone', 'Required. The zone the work is in.', 'Pune'),
 ('Escalation matrix', 3, 'branch_code', 'Blank means every branch in that zone.', ''),
 ('Escalation matrix', 4, 'level', 'Required, 1 to 4. Level 1 is the first person told; 4 is the last.', '1'),
 ('Escalation matrix', 5, 'person_email', 'The person to tell. Give this or chair_code, not neither.', 'ops.pune@cruxindia.co.in'),
 ('Escalation matrix', 6, 'chair_code', 'A chair instead of a person, so the escalation follows the seat when somebody moves.', ''),
 ('Escalation matrix', 7, 'sequence_no', 'Order between two rows at the same level. 1 if there is only one.', '1')
on conflict (kind, ord) do update
  set name = excluded.name, rule = excluded.rule, example = excluded.example;

-- ------------------------------------------------------------- SLA rules
create or replace function uv_sla_rules(p_batch uuid)
returns void language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg
    from (
      select r2.id, nullif(concat_ws('; ',
        case when nullif(btrim(r2.raw->>'code'),'') is null then 'code is required' end,
        case when nullif(btrim(r2.raw->>'client_code'),'') is not null
              and not exists (select 1 from client c where c.code = btrim(r2.raw->>'client_code'))
             then 'client_code ' || (r2.raw->>'client_code') || ' does not exist - load Clients first' end,
        case when nullif(btrim(r2.raw->>'verification_type'),'') is not null
              and not exists (select 1 from verification_type t
                               where t.code = upper(btrim(r2.raw->>'verification_type')))
             then 'verification_type must be RESIDENT, BUSINESS, EMPLOYEE or QUOTATION' end,
        case when nullif(btrim(r2.raw->>'zone'),'') is not null
              and not exists (select 1 from geo_node g
                               where g.level = 'ZONE' and lower(g.name) = lower(btrim(r2.raw->>'zone')))
             then 'zone ' || (r2.raw->>'zone') || ' does not exist - load Geography first' end,
        case when nullif(btrim(r2.raw->>'tat_business_minutes'),'') is null then 'tat_business_minutes is required'
             when (r2.raw->>'tat_business_minutes') !~ '^\d+$' then 'tat_business_minutes must be a whole number of minutes'
             when (r2.raw->>'tat_business_minutes')::int < 1 then 'tat_business_minutes must be at least 1'
             when (r2.raw->>'tat_business_minutes')::int > 100000 then 'tat_business_minutes over 100000 is almost certainly clock minutes, not business minutes'
        end,
        case when nullif(btrim(r2.raw->>'grace_minutes'),'') is not null
              and (r2.raw->>'grace_minutes') !~ '^\d+$' then 'grace_minutes must be a whole number' end,
        case when nullif(btrim(r2.raw->>'at_risk_pct'),'') is not null
              and ((r2.raw->>'at_risk_pct') !~ '^\d+$' or (r2.raw->>'at_risk_pct')::int not between 1 and 99)
             then 'at_risk_pct must be between 1 and 99' end,
        case when nullif(btrim(r2.raw->>'effective_from'),'') is null then 'effective_from is required'
             when not is_ymd(btrim(r2.raw->>'effective_from')) then 'effective_from must be a real date, written YYYY-MM-DD'
        end,
        case when nullif(btrim(r2.raw->>'effective_to'),'') is not null
              and not is_ymd(btrim(r2.raw->>'effective_to'))
             then 'effective_to must be a real date, written YYYY-MM-DD, or left blank' end,
        case when nullif(btrim(r2.raw->>'effective_to'),'') is not null
              and is_ymd(btrim(r2.raw->>'effective_to')) and is_ymd(btrim(r2.raw->>'effective_from'))
              and btrim(r2.raw->>'effective_to')::date <= btrim(r2.raw->>'effective_from')::date
             then 'effective_to must be after effective_from' end
      ), '') as msg
      from upload_row r2 where r2.batch_id = p_batch
    ) e
   where r.id = e.id and e.msg is not null;

  -- two rows in one file with the same code and the same start date would
  -- become two versions of the same thing on the same day
  update upload_row r set error = coalesce(r.error || '; ', '') || 'another row in this file has the same code and effective_from'
    from (select id, row_number() over (partition by btrim(raw->>'code'), btrim(raw->>'effective_from')
                                        order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function ua_sla_rules(p_batch uuid, p_actor uuid)
returns void language plpgsql set search_path = public as $fn$
declare r record; v_client uuid; v_type uuid; v_zone uuid; v_ver int; v_spec int; v_id uuid;
begin
  for r in select * from upload_row where batch_id = p_batch and error is null order by row_no loop
    v_client := null; v_type := null; v_zone := null;
    if nullif(btrim(r.raw->>'client_code'),'') is not null then
      select id into v_client from client where code = btrim(r.raw->>'client_code');
    end if;
    if nullif(btrim(r.raw->>'verification_type'),'') is not null then
      select id into v_type from verification_type where code = upper(btrim(r.raw->>'verification_type'));
    end if;
    if nullif(btrim(r.raw->>'zone'),'') is not null then
      select id into v_zone from geo_node
       where level = 'ZONE' and lower(name) = lower(btrim(r.raw->>'zone'));
    end if;

    -- the same arithmetic the resolver uses, stored so the two cannot drift
    v_spec := (case when v_client is not null then 16 else 0 end)
            + (case when v_type is not null then 16 else 0 end)
            + (case when v_zone is not null then 8 else 0 end)
            + (case when nullif(btrim(r.raw->>'priority'),'') is not null then 8 else 0 end);

    select coalesce(max(version), 0) + 1 into v_ver from sla_rule where code = btrim(r.raw->>'code');

    insert into sla_rule (code, version, client_id, verification_type_id, geo_node_id,
      priority, tat_business_minutes, grace_minutes, at_risk_pct, specificity,
      effective_from, effective_to)
    values (btrim(r.raw->>'code'), v_ver, v_client, v_type, v_zone,
      nullif(btrim(r.raw->>'priority'),''),
      (btrim(r.raw->>'tat_business_minutes'))::int,
      coalesce(nullif(btrim(r.raw->>'grace_minutes'),'')::int, 0),
      coalesce(nullif(btrim(r.raw->>'at_risk_pct'),'')::int, 75),
      v_spec,
      (btrim(r.raw->>'effective_from'))::date,
      nullif(btrim(r.raw->>'effective_to'),'')::date)
    returning id into v_id;

    -- a new version of a code supersedes the previous one from its start date
    update sla_rule set effective_to = (btrim(r.raw->>'effective_from'))::date - 1
     where code = btrim(r.raw->>'code') and version < v_ver and effective_to is null;

    insert into audit_entry (actor_id, action, entity_type, entity_id, entity_ref, new_value)
    values (p_actor, 'SLA_RULE_LOADED', 'sla_rule', v_id,
            btrim(r.raw->>'code') || ' v' || v_ver, r.raw);
  end loop;
end $fn$;

-- --------------------------------------------------- the escalation matrix
create or replace function uv_escalation(p_batch uuid)
returns void language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg
    from (
      select r2.id, nullif(concat_ws('; ',
        case when nullif(btrim(r2.raw->>'client_code'),'') is not null
              and not exists (select 1 from client c where c.code = btrim(r2.raw->>'client_code'))
             then 'client_code ' || (r2.raw->>'client_code') || ' does not exist - load Clients first' end,
        case when nullif(btrim(r2.raw->>'zone'),'') is null then 'zone is required'
             when not exists (select 1 from geo_node g
                               where g.level = 'ZONE' and lower(g.name) = lower(btrim(r2.raw->>'zone')))
             then 'zone ' || (r2.raw->>'zone') || ' does not exist - load Geography first'
        end,
        case when nullif(btrim(r2.raw->>'branch_code'),'') is not null
              and not exists (select 1 from branch b where b.code = btrim(r2.raw->>'branch_code'))
             then 'branch_code ' || (r2.raw->>'branch_code') || ' does not exist' end,
        case when nullif(btrim(r2.raw->>'level'),'') is null then 'level is required'
             when (r2.raw->>'level') !~ '^[1-4]$' then 'level must be 1, 2, 3 or 4'
        end,
        case when nullif(btrim(r2.raw->>'person_email'),'') is null
              and nullif(btrim(r2.raw->>'chair_code'),'') is null
             then 'give a person_email or a chair_code - an escalation level with nobody in it is the gap this table exists to close' end,
        case when nullif(btrim(r2.raw->>'person_email'),'') is not null
              and not exists (select 1 from person p
                               where lower(p.work_email) = lower(btrim(r2.raw->>'person_email'))
                                 and p.employment_status = 'ACTIVE' and p.superseded_by is null)
             then 'person_email ' || (r2.raw->>'person_email') || ' is not an active person - load People first' end,
        case when nullif(btrim(r2.raw->>'chair_code'),'') is not null
              and not exists (select 1 from chair c where c.code = btrim(r2.raw->>'chair_code'))
             then 'chair_code ' || (r2.raw->>'chair_code') || ' does not exist - load Chairs first' end,
        case when nullif(btrim(r2.raw->>'sequence_no'),'') is not null
              and (r2.raw->>'sequence_no') !~ '^\d+$' then 'sequence_no must be a whole number' end
      ), '') as msg
      from upload_row r2 where r2.batch_id = p_batch
    ) e
   where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'another row in this file has the same client, zone, branch, level and sequence'
    from (select id, row_number() over (
            partition by coalesce(lower(btrim(raw->>'client_code')),''),
                         lower(btrim(raw->>'zone')),
                         coalesce(lower(btrim(raw->>'branch_code')),''),
                         btrim(raw->>'level'),
                         coalesce(nullif(btrim(raw->>'sequence_no'),''),'1')
            order by row_no) rn
          from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function ua_escalation(p_batch uuid, p_actor uuid)
returns void language plpgsql set search_path = public as $fn$
declare r record; v_client uuid; v_zone uuid; v_branch uuid; v_person uuid; v_chair uuid; v_id uuid;
begin
  for r in select * from upload_row where batch_id = p_batch and error is null order by row_no loop
    v_client := null; v_branch := null; v_person := null; v_chair := null;
    if nullif(btrim(r.raw->>'client_code'),'') is not null then
      select id into v_client from client where code = btrim(r.raw->>'client_code');
    end if;
    select id into v_zone from geo_node
     where level = 'ZONE' and lower(name) = lower(btrim(r.raw->>'zone'));
    if nullif(btrim(r.raw->>'branch_code'),'') is not null then
      select id into v_branch from branch where code = btrim(r.raw->>'branch_code');
    end if;
    if nullif(btrim(r.raw->>'person_email'),'') is not null then
      select id into v_person from person
       where lower(work_email) = lower(btrim(r.raw->>'person_email'))
         and employment_status = 'ACTIVE' and superseded_by is null;
    end if;
    if nullif(btrim(r.raw->>'chair_code'),'') is not null then
      select id into v_chair from chair where code = btrim(r.raw->>'chair_code');
    end if;

    -- a routing rule is retired, not overwritten: the old row keeps its dates
    -- so a question about who was told last March still has an answer
    update ogl_escalation_matrix
       set effective_to = current_date - 1
     where effective_to is null
       and client_id is not distinct from v_client
       and location_id is not distinct from v_zone
       and branch_id is not distinct from v_branch
       and escalation_level = (btrim(r.raw->>'level'))::int
       and sequence_no = coalesce(nullif(btrim(r.raw->>'sequence_no'),'')::int, 1);

    insert into ogl_escalation_matrix (client_id, location_id, branch_id,
      escalation_level, chair_id, person_id, sequence_no, effective_from)
    values (v_client, v_zone, v_branch, (btrim(r.raw->>'level'))::int,
      v_chair, v_person, coalesce(nullif(btrim(r.raw->>'sequence_no'),'')::int, 1),
      current_date)
    returning id into v_id;

    insert into audit_entry (actor_id, action, entity_type, entity_id, entity_ref, new_value)
    values (p_actor, 'ESCALATION_ROUTE_LOADED', 'ogl_escalation_matrix', v_id,
            btrim(r.raw->>'zone') || ' L' || btrim(r.raw->>'level'), r.raw);
  end loop;
end $fn$;

-- ------------------------------------------------------------------ exposure
-- ogl_actions also gains the report, complete and accept verbs, and drops
-- COMPLETED and the close out of UNDER_REVIEW from the generic transition
-- list: both have their own gate now, and offering the bare transition would
-- be offering a way around it. See the deployed definition.
do $do$
declare f text;
begin
  foreach f in array array[
    'ogl_report_point(uuid,uuid,text,text,jsonb)',
    'ogl_complete(uuid,uuid,text,text,text,text)',
    'ogl_review_accept(uuid,uuid,text)','ogl_open_points(uuid)',
    'uv_sla_rules(uuid)','ua_sla_rules(uuid,uuid)',
    'uv_escalation(uuid)','ua_escalation(uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
