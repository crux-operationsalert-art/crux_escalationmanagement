-- =====================================================================
-- CRUX — schema patch v20
-- The rest of the OGL module: raising an assignment in the tool.
--
-- Until v20 the only way an OGL assignment existed was the cutover
-- loader. That is fine for a migration and useless for a Tuesday. This
-- patch adds the day-to-day path — a case, its parties, its verification
-- points and the assignment that carries them — and with it the three
-- pieces of the specification that only matter once somebody is typing:
--
--   * the repeated Point ID. A Point ID keyed twice is not a duplicate
--     to refuse; it is a decision to route, and the decision belongs to
--     the assignor. The system compares the addresses, proposes, and
--     waits. Nothing starts until a person chooses.
--   * arbitration, with the arbiter computed as the lowest manager both
--     parties report to rather than nominated by one of them.
--   * the dispute outcome, which is what turns a strike on or waives it.
--
-- Run after schema-patch-v19.sql.
-- =====================================================================

-- A held point needs somewhere to wait. The decision row carries the
-- intent so the requirement can be made once the assignor has chosen;
-- creating it first would trip the one-live-attempt index and refuse
-- legitimate work.
alter table repeat_point_decision
  add column if not exists case_id uuid references verification_case(id) on delete cascade,
  add column if not exists party_id uuid references case_party(id),
  add column if not exists verification_type_id uuid references verification_type(id),
  add column if not exists new_address text,
  add column if not exists assignment_id uuid references assignment(id);

create index if not exists rpd_waiting on repeat_point_decision (asked_at) where decision is null;

comment on table repeat_point_decision is
  'A Point ID keyed twice is not a duplicate to refuse - it is a decision to '
  'route, and the decision belongs to the assignor. Until they make it the '
  'point waits here, the assignment sits in DRAFT and no clock starts. '
  'Undecided rows are a queue with an owner, not a silent backlog.';

-- ------------------------------------------------------- address matching
-- Addresses are typed by hand in a hurry. Compare them the way a person
-- would: the same address written differently is the same address. The
-- comparison runs on the form with the spaces taken out as well, which is
-- the difference between measuring how somebody typed and what they meant.
create or replace function ogl_addr_norm(p text)
returns text language sql immutable set search_path = public as $fn$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(p,'')), '[.,/#!$%&;:{}=_`~()''"-]', ' ', 'g'),
      '\m(road|rd|street|st|lane|ln|marg|nagar|colony|apartments?|apts?|flat|building|bldg|floor|flr|near|opp|opposite|behind|society|soc)\M',
      ' ', 'g'),
    '\s+', ' ', 'g'))
$fn$;

create or replace function ogl_addr_match(a text, b text)
returns jsonb language plpgsql immutable set search_path = public as $fn$
declare na text; nb text; ta text; tb text; d int; len int; score int;
begin
  if btrim(coalesce(a,'')) = btrim(coalesce(b,'')) and coalesce(a,'') <> '' then
    return jsonb_build_object('match','EXACT','score',100);
  end if;
  na := ogl_addr_norm(a); nb := ogl_addr_norm(b);
  ta := replace(na,' ',''); tb := replace(nb,' ','');   -- how it was typed stops mattering
  if ta = tb and ta <> '' then
    return jsonb_build_object('match','NORMALISED','score',100);
  end if;
  len := greatest(length(ta), length(tb), 1);
  -- levenshtein refuses very long strings; the first 120 characters of an
  -- Indian address is the part that identifies it
  d := extensions.levenshtein(left(ta,120), left(tb,120));
  score := greatest(0, 100 - (100 * d / greatest(least(len,120),1)));
  if score >= 80 then
    return jsonb_build_object('match','FUZZY','score',score);
  end if;
  return jsonb_build_object('match','DIFFERENT','score',score);
end $fn$;

comment on function ogl_addr_match is
  'EXACT, NORMALISED, FUZZY with a score, or DIFFERENT. What it returns '
  'decides what the system proposes; it never decides anything itself. '
  '14-B against 14-C on the same road scores FUZZY 89, not NORMALISED - a '
  'near-miss on a house number must never apply itself.';

-- ------------------------------------------ raising a case and its assignment
-- One call, one transaction: the case, its parties, its verification points
-- and the assignment that carries them, in DRAFT with no clock running.
create or replace function ogl_case_create(p_actor uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_client uuid; v_branch uuid; v_to uuid; v_from uuid; v_chair uuid;
  v_case uuid; v_asg uuid; v_ref text; v_alloc uuid;
  v_party uuid; v_type uuid; v_prior case_verification_requirement%rowtype;
  v_prior_case verification_case%rowtype;
  v jsonb; m jsonb; v_held int := 0; v_made int := 0; v_pending jsonb := '[]'::jsonb;
  v_addr text; v_self text;
begin
  if not exists (select 1 from person where id = p_actor
                  and employment_status = 'ACTIVE' and superseded_by is null) then
    return jsonb_build_object('error','no_such_actor');
  end if;

  select id into v_client from client
   where code = btrim(p_payload->>'client_code') or lower(name) = lower(btrim(p_payload->>'client_code'));
  if v_client is null then
    return jsonb_build_object('error','no_such_client',
      'reason','No client matches "' || coalesce(p_payload->>'client_code','') || '".');
  end if;

  select id into v_to from geo_node
   where level = 'ZONE' and lower(name) = lower(btrim(p_payload->>'to_location'));
  if v_to is null then
    return jsonb_build_object('error','no_such_location',
      'reason','No zone is called "' || coalesce(p_payload->>'to_location','') ||
               '". Load Geography first, or use the name exactly as it is loaded.');
  end if;

  if nullif(btrim(coalesce(p_payload->>'branch_code','')),'') is not null then
    select id into v_branch from branch where code = btrim(p_payload->>'branch_code');
  end if;

  if nullif(btrim(coalesce(p_payload->>'from_location','')),'') is not null then
    select id into v_from from geo_node
     where level = 'ZONE' and lower(name) = lower(btrim(p_payload->>'from_location'));
  end if;
  -- a location that raises work for itself is allowed, and has to say so
  if v_from is null then v_from := v_to; end if;
  if v_from = v_to then
    v_self := coalesce(nullif(btrim(coalesce(p_payload->>'self_assign_reason','')),''),
                       'Raised and verified in the same location.');
  end if;

  select h.chair_id into v_chair from chair_holder h
   where h.person_id = p_actor and h.from_date <= current_date
     and (h.to_date is null or h.to_date >= current_date)
   order by h.is_primary desc limit 1;
  if v_chair is null then
    return jsonb_build_object('error','no_chair',
      'reason','You do not hold a chair, and an assignment is raised by a chair '
             ||'rather than by a person. Ask an administrator to seat you.');
  end if;

  if nullif(btrim(coalesce(p_payload->>'allocated_to','')),'') is not null then
    select id into v_alloc from person
     where lower(work_email) = lower(btrim(p_payload->>'allocated_to'))
       and employment_status = 'ACTIVE' and superseded_by is null;
  end if;

  if jsonb_typeof(p_payload->'verifications') <> 'array'
     or jsonb_array_length(p_payload->'verifications') = 0 then
    return jsonb_build_object('error','no_verifications',
      'reason','An assignment with nothing to verify is not an assignment.');
  end if;

  insert into verification_case (force1_case_id, client_id, branch_id, applicant_name,
    applicant_contact, applicant_address, pincode, created_by)
  values (btrim(p_payload->>'force1_case_id'), v_client, v_branch,
    btrim(p_payload->>'applicant_name'), btrim(p_payload->>'applicant_contact'),
    btrim(p_payload->>'applicant_address'), btrim(p_payload->>'pincode'), p_actor)
  returning id into v_case;

  v_ref := next_ref('OGL', 5);
  insert into assignment (ref, case_id, assignor_id, assignor_chair_id,
    from_location_id, to_location_id, allocated_to_id, current_state,
    next_action_owner_id, self_assign_reason, source_ref)
  values (v_ref, v_case, p_actor, v_chair, v_from, v_to, v_alloc, 'DRAFT',
    p_actor, v_self, 'raised in the tool')
  returning id into v_asg;

  insert into assignment_event (assignment_id, event_type, actor_id, to_state, payload)
  values (v_asg, 'ASSIGNMENT_CREATED', p_actor, 'DRAFT',
          jsonb_build_object('case', v_case, 'ref', v_ref));

  for v in select * from jsonb_array_elements(p_payload->'verifications') loop
    select id into v_type from verification_type
     where code = upper(btrim(v->>'type')) and active;
    if v_type is null then
      raise exception 'No verification type "%". They are RESIDENT, BUSINESS, EMPLOYEE and QUOTATION.',
        coalesce(v->>'type','');
    end if;
    if nullif(btrim(coalesce(v->>'point_id','')),'') is null then
      raise exception 'Every selected verification needs a Point ID. "%" has none.', coalesce(v->>'type','');
    end if;

    v_addr := coalesce(nullif(btrim(coalesce(v->>'address','')),''),
                       btrim(p_payload->>'applicant_address'));

    insert into case_party (case_id, party_role, seq_no, name, contact, address, same_as_applicant)
    values (v_case, upper(coalesce(nullif(btrim(coalesce(v->>'party_role','')),''),'APPLICANT')),
      coalesce((v->>'seq_no')::int,
               (select count(*) + 1 from case_party
                 where case_id = v_case
                   and party_role = upper(coalesce(nullif(btrim(coalesce(v->>'party_role','')),''),'APPLICANT')))),
      coalesce(nullif(btrim(coalesce(v->>'name','')),''), btrim(p_payload->>'applicant_name')),
      coalesce(nullif(btrim(coalesce(v->>'contact','')),''), btrim(p_payload->>'applicant_contact')),
      v_addr,
      coalesce(nullif(btrim(coalesce(v->>'name','')),''), btrim(p_payload->>'applicant_name'))
        = btrim(p_payload->>'applicant_name'))
    returning id into v_party;

    -- has this Point ID been here before?
    select * into v_prior from case_verification_requirement
     where force1_point_id = btrim(v->>'point_id')
     order by attempt_no desc limit 1;

    if found then
      select * into v_prior_case from verification_case where id = v_prior.case_id;
      m := ogl_addr_match(v_prior_case.applicant_address, v_addr);
      insert into repeat_point_decision (force1_point_id, prior_requirement_id,
        address_match, match_score, proposed, case_id, party_id,
        verification_type_id, new_address, assignment_id)
      values (btrim(v->>'point_id'), v_prior.id,
        m->>'match', (m->>'score')::int,
        case when m->>'match' = 'DIFFERENT' then 'NEW_ASSIGNMENT' else 'REVISIT' end,
        v_case, v_party, v_type, v_addr, v_asg);
      v_held := v_held + 1;
      v_pending := v_pending || jsonb_build_object(
        'point_id', btrim(v->>'point_id'), 'match', m->>'match', 'score', m->>'score',
        'proposed', case when m->>'match' = 'DIFFERENT' then 'NEW_ASSIGNMENT' else 'REVISIT' end,
        'prior_ref', (select a.ref from assignment a where a.case_id = v_prior.case_id limit 1));
    else
      insert into case_verification_requirement (case_id, party_id, verification_type_id,
        force1_point_id, attempt_no, lineage)
      values (v_case, v_party, v_type, btrim(v->>'point_id'), 1, 'ORIGINAL');
      v_made := v_made + 1;
    end if;
  end loop;

  return jsonb_build_object('id', v_asg, 'ref', v_ref, 'case', v_case,
    'state', 'DRAFT', 'points_created', v_made, 'points_held', v_held,
    'pending_decisions', v_pending,
    'note', case when v_held > 0
      then v_held || ' Point ID(s) have been used before. They are waiting for you to '
         || 'say whether each is a revisit, a reopen, new work, or keyed in error. '
         || 'Nothing starts until you do.'
      else 'Raised as a draft. Submit it when it is ready.' end);
end $fn$;

-- --------------------------------------------- the triage decision and its queue

create or replace function ogl_pending_decisions(p_person uuid)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.asked_at), '[]'::jsonb) from (
    select d.id, d.force1_point_id, d.address_match, d.match_score, d.proposed,
           d.new_address, d.asked_at, a.ref, a.id as assignment_id,
           vc.applicant_name,
           pc.applicant_address as prior_address,
           pa.ref as prior_ref,
           pr.status as prior_status, pr.attempt_no as prior_attempt
      from repeat_point_decision d
      join assignment a on a.id = d.assignment_id
      join verification_case vc on vc.id = d.case_id
      join case_verification_requirement pr on pr.id = d.prior_requirement_id
      join verification_case pc on pc.id = pr.case_id
      left join assignment pa on pa.case_id = pr.case_id
     where d.decision is null
       and (a.assignor_id = p_person
            or (select app_role from person where id = p_person) = 'ADMIN')
     order by d.asked_at) x
$fn$;

-- The assignor chooses. The assignee is not shown the choice and cannot make
-- it; they see the outcome.
create or replace function ogl_repeat_decide(
  p_decision uuid, p_actor uuid, p_choice text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  d repeat_point_decision%rowtype; a assignment%rowtype;
  pr case_verification_requirement%rowtype; v_new uuid;
begin
  select * into d from repeat_point_decision where id = p_decision for update;
  if not found then return jsonb_build_object('error','no_such_decision'); end if;
  if d.decision is not null then
    return jsonb_build_object('error','already_decided',
      'reason','That was decided on ' || to_char(ogl_ts(d.decided_at),'DD Mon') ||
               ' as ' || d.decision || '.');
  end if;
  if p_choice not in ('REVISIT','REOPEN','NEW_ASSIGNMENT','REFUSED_DUPLICATE') then
    return jsonb_build_object('error','bad_choice',
      'reason','The choices are REVISIT, REOPEN, NEW_ASSIGNMENT and REFUSED_DUPLICATE.');
  end if;

  select * into a from assignment where id = d.assignment_id;
  if a.assignor_id is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_yours_to_decide',
      'reason','The assignor decides what a repeated Point ID means.');
  end if;
  -- a fuzzy or different address may not be called a revisit on a shrug
  if p_choice = 'REVISIT' and d.address_match = 'DIFFERENT'
     and coalesce(btrim(coalesce(p_reason,'')),'') = '' then
    return jsonb_build_object('error','reason_required',
      'reason','The address is different from the previous attempt. Calling it a '
             ||'revisit needs a sentence saying why.');
  end if;

  select * into pr from case_verification_requirement where id = d.prior_requirement_id;

  if p_choice = 'REVISIT' then
    -- new work against the same point: a fresh attempt, the prior one left
    -- closed and fully readable
    insert into case_verification_requirement (case_id, party_id, verification_type_id,
      force1_point_id, attempt_no, lineage, supersedes_id)
    values (d.case_id, d.party_id, d.verification_type_id, d.force1_point_id,
      pr.attempt_no + 1, 'REVISIT', pr.id)
    returning id into v_new;

  elsif p_choice = 'REOPEN' then
    -- "overwrite" is a workflow word, never a storage one: the earlier report
    -- stays retrievable under its own attempt, marked superseded
    insert into case_verification_requirement (case_id, party_id, verification_type_id,
      force1_point_id, attempt_no, lineage, supersedes_id)
    values (d.case_id, d.party_id, d.verification_type_id, d.force1_point_id,
      pr.attempt_no + 1, 'REOPENED', pr.id)
    returning id into v_new;
    update case_verification_requirement set status = 'SUPERSEDED' where id = pr.id;

  elsif p_choice = 'NEW_ASSIGNMENT' then
    insert into case_verification_requirement (case_id, party_id, verification_type_id,
      force1_point_id, attempt_no, lineage)
    values (d.case_id, d.party_id, d.verification_type_id, d.force1_point_id,
      pr.attempt_no + 1, 'ORIGINAL')
    returning id into v_new;
  end if;
  -- REFUSED_DUPLICATE creates nothing; the point was keyed in error

  update repeat_point_decision
     set decision = p_choice, decided_by = p_actor, decided_at = now(),
         reason = p_reason, new_requirement_id = v_new
   where id = p_decision;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (d.assignment_id, 'REPEAT_POINT_DECIDED', p_actor,
          jsonb_build_object('point_id', d.force1_point_id, 'decision', p_choice,
                             'address_match', d.address_match, 'score', d.match_score,
                             'reason', p_reason, 'requirement', v_new));

  return jsonb_build_object('id', p_decision, 'decision', p_choice,
    'requirement', v_new,
    'still_waiting', (select count(*) from repeat_point_decision
                       where assignment_id = d.assignment_id and decision is null));
end $fn$;

-- Submitting is the gate the specification names: mandatory fields, at least
-- one verification, a Point ID on every one, and nothing still waiting to be
-- triaged.
create or replace function ogl_submit(p_assignment uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; vc verification_case%rowtype; v_waiting int; v_pts int;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  if a.assignor_id is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_the_assignor');
  end if;

  select count(*) into v_waiting from repeat_point_decision
   where assignment_id = p_assignment and decision is null;
  if v_waiting > 0 then
    return jsonb_build_object('error','decisions_waiting',
      'reason', v_waiting || ' repeated Point ID(s) are waiting for you to say what '
             || 'they are. Nothing can start until they are decided.');
  end if;

  select count(*) into v_pts from case_verification_requirement
   where case_id = a.case_id and status not in ('CANCELLED','SUPERSEDED');
  if v_pts = 0 then
    return jsonb_build_object('error','no_verifications',
      'reason','Every verification on this case was refused as a duplicate. '
             ||'There is nothing to send.');
  end if;

  select * into vc from verification_case where id = a.case_id;
  if coalesce(btrim(vc.applicant_name),'') = ''
     or coalesce(btrim(vc.applicant_address),'') = ''
     or coalesce(btrim(vc.applicant_contact),'') = ''
     or coalesce(btrim(vc.pincode),'') = '' then
    return jsonb_build_object('error','incomplete_case',
      'reason','Name, contact, address and pincode are all needed before this goes out.');
  end if;

  return ogl_transition(p_assignment, 'SUBMITTED', p_actor, 'submitted');
end $fn$;

create or replace function ogl_allocate(p_assignment uuid, p_person uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; v_ok boolean; r jsonb;
begin
  select * into a from assignment where id = p_assignment for update;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;

  select true into v_ok from person
   where id = p_person and employment_status = 'ACTIVE' and superseded_by is null;
  if not coalesce(v_ok,false) then
    return jsonb_build_object('error','no_such_person',
      'reason','That person is not active on the people master.');
  end if;

  update assignment set allocated_to_id = p_person where id = p_assignment;
  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (p_assignment, 'ALLOCATED', p_actor, jsonb_build_object('to', p_person));

  if a.current_state = 'SUBMITTED' then
    r := ogl_transition(p_assignment, 'ASSIGNED', p_actor, 'allocated');
  else
    r := jsonb_build_object('state', a.current_state);
  end if;

  perform ogl_notify(p_assignment, p_person, 'ALLOCATED', 'allocated to you',
    'This assignment has been allocated to you. Accept it to start work.',
    p_assignment::text || ':allocated:' || p_person::text);

  return r || jsonb_build_object('allocated_to', p_person);
end $fn$;

-- ------------------------------------ arbitration and the dispute outcome

-- The arbiter is the lowest manager both parties report to. Computed, not
-- nominated - a nominated arbiter is one of the parties' choice, which is
-- the thing arbitration exists to avoid.
create or replace function ogl_arbiter(p_assignment uuid)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare
  a assignment%rowtype; v_cur uuid; v_chain uuid[] := '{}'; v_guard int := 0;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;

  v_cur := a.assignor_id;
  while v_cur is not null and v_guard < 50 loop
    v_chain := v_chain || v_cur;
    select manager_id into v_cur from person where id = v_cur;
    v_guard := v_guard + 1;
  end loop;

  v_cur := coalesce(a.allocated_to_id, a.assignor_id); v_guard := 0;
  while v_cur is not null and v_guard < 50 loop
    if v_cur = any(v_chain) and v_cur is distinct from a.assignor_id
       and v_cur is distinct from a.allocated_to_id then
      return jsonb_build_object('person_id', v_cur,
        'name', (select full_name from person where id = v_cur), 'how','lowest common manager');
    end if;
    select manager_id into v_cur from person where id = v_cur;
    v_guard := v_guard + 1;
  end loop;

  -- no common manager below the top: the top is the arbiter
  select id into v_cur from person
   where manager_id is null and employment_status = 'ACTIVE' and superseded_by is null
   limit 1;
  return jsonb_build_object('person_id', v_cur,
    'name', (select full_name from person where id = v_cur),
    'how','no common manager below the top of the chart, so the top holds it');
end $fn$;

create or replace function ogl_arbitrate(
  p_assignment uuid, p_actor uuid, p_outcome text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; arb jsonb; q assignment_request%rowtype; r jsonb;
begin
  select * into a from assignment where id = p_assignment for update;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  if a.current_state <> 'ARBITRATION' then
    return jsonb_build_object('error','not_in_arbitration',
      'reason','This assignment is ' || a.current_state || '.');
  end if;
  if p_outcome not in ('CLOSED','REWORK') then
    return jsonb_build_object('error','bad_outcome',
      'reason','Arbitration ends in CLOSED or REWORK.');
  end if;
  if coalesce(btrim(coalesce(p_reason,'')),'') = '' then
    return jsonb_build_object('error','reason_required',
      'reason','An arbitration decision without its reasoning is not a decision.');
  end if;

  arb := ogl_arbiter(p_assignment);
  if (arb->>'person_id')::uuid is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_the_arbiter',
      'reason','This one is ' || coalesce(arb->>'name','nobody') || '''s to decide - '
             || coalesce(arb->>'how',''), 'arbiter', arb);
  end if;

  -- an arbitration that goes to rework says the dispute was right; one that
  -- closes says it was not, and that answer is what waives or keeps a strike
  select * into q from assignment_request
   where assignment_id = p_assignment and request_type = 'DISPUTE' and resolved_at is null
   order by raised_at desc limit 1;
  if q.id is not null then
    perform ogl_dispute_classify(q.id, p_actor,
      case when p_outcome = 'REWORK' then 'UPHELD' else 'NOT_UPHELD' end,
      'By arbitration: ' || p_reason);
  end if;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (p_assignment, 'ARBITRATION_DECIDED', p_actor,
          jsonb_build_object('outcome', p_outcome, 'reason', p_reason, 'arbiter', arb));

  r := ogl_transition(p_assignment, p_outcome, p_actor, 'arbitration: ' || p_reason);
  return r || jsonb_build_object('arbiter', arb, 'outcome', p_outcome);
end $fn$;

-- UPHELD means the report was wrong, and that is a strike. NOT_UPHELD means
-- the dispute was wrong, and that waives one - the row stays visible as
-- waived, and the fact counts on the assignor's quality, not the assignee's.
create or replace function ogl_dispute_classify(
  p_request uuid, p_actor uuid, p_outcome text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare q assignment_request%rowtype; a assignment%rowtype; v_id uuid; v_waived int := 0;
begin
  select * into q from assignment_request where id = p_request for update;
  if not found then return jsonb_build_object('error','no_such_request'); end if;
  if q.request_type <> 'DISPUTE' then
    return jsonb_build_object('error','not_a_dispute');
  end if;
  if q.resolved_at is not null then
    return jsonb_build_object('error','already_classified',
      'reason','That dispute was classified as ' || q.resolution || '.');
  end if;
  if p_outcome not in ('UPHELD','NOT_UPHELD') then
    return jsonb_build_object('error','bad_outcome');
  end if;
  if coalesce(btrim(coalesce(p_reason,'')),'') = '' then
    return jsonb_build_object('error','reason_required',
      'reason','Classifying a dispute needs a sentence saying why.');
  end if;

  select * into a from assignment where id = q.assignment_id;

  update assignment_request set resolution = p_outcome, resolved_by = p_actor,
         resolved_at = now(), resolution_remarks = p_reason
   where id = p_request;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (q.assignment_id, 'DISPUTE_CLASSIFIED', p_actor,
          jsonb_build_object('request', p_request, 'outcome', p_outcome, 'reason', p_reason));

  if p_outcome = 'UPHELD' and a.allocated_to_id is not null then
    insert into strike_event (person_id, location_id, assignment_id, breach_cycle_no,
      trigger_code, occurred_at, strike_no, facts)
    values (a.allocated_to_id, a.to_location_id, q.assignment_id, q.breach_cycle_no,
      'DISPUTE_UPHELD', now(),
      (select count(*) + 1 from strike_event
        where person_id = a.allocated_to_id and status = 'ACTIVE'
          and occurred_at > now() - (ogl_setting_int('ogl_strike_window_days',90) || ' days')::interval),
      jsonb_build_object('ref', a.ref, 'dispute', p_request, 'reason', p_reason))
    on conflict (assignment_id, breach_cycle_no, trigger_code) do nothing
    returning id into v_id;
    if v_id is not null then
      insert into assignment_event (assignment_id, event_type, is_system, payload)
      values (q.assignment_id, 'STRIKE_GENERATED', true,
              jsonb_build_object('strike', v_id, 'because','dispute upheld'));
    end if;
  end if;

  if p_outcome = 'NOT_UPHELD' then
    update strike_event
       set status = 'WAIVED', waived_by = p_actor,
           waived_reason = 'The dispute behind this was not upheld: ' || p_reason
     where assignment_id = q.assignment_id and breach_cycle_no = q.breach_cycle_no
       and status = 'ACTIVE';
    get diagnostics v_waived = row_count;
    if v_waived > 0 then
      insert into assignment_event (assignment_id, event_type, actor_id, payload)
      values (q.assignment_id, 'STRIKE_WAIVED', p_actor,
              jsonb_build_object('count', v_waived, 'because','dispute not upheld'));
    end if;
  end if;

  return jsonb_build_object('id', p_request, 'outcome', p_outcome,
    'strike', v_id, 'strikes_waived', v_waived);
end $fn$;

-- Helping with a case is a recorded act with an end date, not a permanent
-- widening of somebody's scope that nobody remembers granting.
create or replace function ogl_grant_participant(
  p_assignment uuid, p_person uuid, p_actor uuid, p_reason text, p_hours int default 72)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; v_id uuid;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  if a.assignor_id is distinct from p_actor
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_permitted',
      'reason','The assignor or an administrator lends access to an assignment.');
  end if;
  if coalesce(btrim(coalesce(p_reason,'')),'') = '' then
    return jsonb_build_object('error','reason_required',
      'reason','Lending access needs a reason. That is the whole record of why.');
  end if;

  insert into temp_participant_grant (assignment_id, person_id, granted_by, reason, expires_at)
  values (p_assignment, p_person, p_actor, p_reason,
          now() + (greatest(1, least(p_hours, 720)) || ' hours')::interval)
  returning id into v_id;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (p_assignment, 'PARTICIPANT_GRANTED', p_actor,
          jsonb_build_object('person', p_person, 'reason', p_reason, 'hours', p_hours));
  return jsonb_build_object('id', v_id, 'expires_in_hours', p_hours);
end $fn$;

create or replace function ogl_revoke_participant(p_grant uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare g temp_participant_grant%rowtype;
begin
  select * into g from temp_participant_grant where id = p_grant;
  if not found then return jsonb_build_object('error','no_such_grant'); end if;
  update temp_participant_grant set revoked_at = now()
   where id = p_grant and revoked_at is null;
  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (g.assignment_id, 'PARTICIPANT_REVOKED', p_actor,
          jsonb_build_object('grant', p_grant, 'person', g.person_id));
  return jsonb_build_object('id', p_grant, 'revoked', true);
end $fn$;

-- ------------------------------------------------------------- reference data
-- The raise-an-assignment form needs zones, verification types and a list of
-- people, and they belong with the other reference data rather than behind a
-- new door.
create or replace function ogl_people()
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.full_name), '[]'::jsonb) from (
    select p.id, p.full_name, p.work_email, d.title as designation
      from person p left join designation d on d.id = p.designation_id
     where p.employment_status = 'ACTIVE' and p.superseded_by is null) x
$fn$;

create or replace function app_refs(p_person uuid)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'clients', coalesce((select jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name)
                                          order by name)
                          from client where status = 'ACTIVE' or status is null), '[]'::jsonb),
    'branches', coalesce((select jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,
                                             'client_id',client_id) order by name)
                           from branch), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name)
                             from category), '[]'::jsonb),
    'zones', coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,
                                 'region',region,'group',group_name) order by name)
                        from geo_node where level = 'ZONE'), '[]'::jsonb),
    'verification_types', coalesce((select jsonb_agg(jsonb_build_object('code',code,'label',label)
                                      order by label)
                                     from verification_type where active), '[]'::jsonb),
    'people', ogl_people())
$fn$;

-- ogl_actions grows the rest of the verbs, so the browser keeps deciding
-- nothing. A button that is offered and then refused is worse than no button.
create or replace function ogl_actions(p_assignment uuid, p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare
  a assignment%rowtype; v_role role_kind; v_acts jsonb := '[]'::jsonb;
  v_is_assignee boolean; v_is_assignor boolean; v_waiting int; v_disp uuid; arb jsonb;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  select app_role into v_role from person where id = p_person;
  v_is_assignee := a.allocated_to_id = p_person;
  v_is_assignor := a.assignor_id = p_person;

  select count(*) into v_waiting from repeat_point_decision
   where assignment_id = p_assignment and decision is null;

  -- a draft with points still waiting to be triaged offers nothing else
  if v_waiting > 0 then
    return jsonb_build_object('state', a.current_state, 'open_request', a.open_request_type,
      'decisions_waiting', v_waiting,
      'actions', jsonb_build_array(jsonb_build_object('kind','decide',
        'label', v_waiting || ' repeated Point ID' || case when v_waiting = 1 then '' else 's' end
                 || ' to decide first')));
  end if;

  -- the states that follow, from the table rather than from a list here.
  -- SUBMITTED is left out: it has its own gate, ogl_submit.
  v_acts := coalesce((select jsonb_agg(jsonb_build_object('kind','transition','to', to_state,
              'label', initcap(replace(to_state,'_',' '))) order by to_state)
              from ogl_transition_rule
             where from_state = a.current_state and to_state <> 'SUBMITTED'), '[]'::jsonb);

  if a.current_state = 'DRAFT' and (v_is_assignor or v_role = 'ADMIN') then
    v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','submit','label','Submit it'));
  end if;

  if (v_is_assignor or v_role = 'ADMIN')
     and a.current_state in ('DRAFT','SUBMITTED','ASSIGNED','REOPENED') then
    v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','allocate',
      'label', case when a.allocated_to_id is null then 'Allocate it' else 'Re-allocate it' end));
  end if;

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
     and a.current_state not in ('CLOSED','CANCELLED','COMPLETED','UNDER_REVIEW','DRAFT') then
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

  -- an open dispute is a finding waiting to be judged, not a blocking request
  select q.id into v_disp from assignment_request q
   where q.assignment_id = p_assignment and q.request_type = 'DISPUTE'
     and q.resolved_at is null limit 1;
  if v_disp is not null and (v_is_assignor or v_role in ('ADMIN','MANAGER')) then
    v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','classify',
      'request', v_disp, 'label','Classify the dispute'));
  end if;

  if a.current_state = 'ARBITRATION' then
    arb := ogl_arbiter(p_assignment);
    if (arb->>'person_id')::uuid = p_person or v_role = 'ADMIN' then
      v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','arbitrate',
        'label','Decide the arbitration'));
    end if;
  end if;

  if (v_is_assignor or v_role = 'ADMIN')
     and a.current_state not in ('CLOSED','CANCELLED') then
    v_acts := v_acts || jsonb_build_array(jsonb_build_object('kind','lend',
      'label','Lend someone access'));
  end if;

  return jsonb_build_object('state', a.current_state, 'open_request', a.open_request_type,
    'decisions_waiting', 0,
    'arbiter', case when a.current_state = 'ARBITRATION' then ogl_arbiter(p_assignment) end,
    'actions', v_acts);
end $fn$;

-- ------------------------------------------------------------------ exposure
do $do$
declare f text;
begin
  foreach f in array array[
    'ogl_addr_norm(text)','ogl_addr_match(text,text)','ogl_case_create(uuid,jsonb)',
    'ogl_pending_decisions(uuid)','ogl_repeat_decide(uuid,uuid,text,text)',
    'ogl_submit(uuid,uuid)','ogl_allocate(uuid,uuid,uuid)',
    'ogl_arbiter(uuid)','ogl_arbitrate(uuid,uuid,text,text)',
    'ogl_dispute_classify(uuid,uuid,text,text)',
    'ogl_grant_participant(uuid,uuid,uuid,text,integer)','ogl_revoke_participant(uuid,uuid)',
    'ogl_people()','app_refs(uuid)','ogl_actions(uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
