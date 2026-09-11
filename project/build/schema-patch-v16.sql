-- =====================================================================
-- CRUX — schema patch v16
-- Google sign-in, the front end, and emptying the tool.
--
-- Three things, all of which keep configuration out of code:
--
--  · The Google client id is an app_setting row, not a constant. Changing
--    it is a row. It is not a secret either — it appears in the page source
--    of every site that uses Google sign-in — which is why /api/config can
--    serve it before anyone has signed in.
--
--  · The front end lives in app_page. A change to a screen is an UPDATE,
--    not a redeploy of a 45KB function.
--
--  · data_reset() is the one action in the tool that cannot be undone, so
--    it is the one with a preview, a typed confirmation, and an explicit
--    list of what it keeps.
--
-- Run after schema-patch-v15.sql.
-- =====================================================================

insert into app_setting (key, value, plain_language, group_name, editable_by) values
  ('google_client_id', '',
   'The Google OAuth client staff sign in through. Changing it here changes it everywhere; no deploy.',
   'Sign-in', 'ADMIN'),
  ('workspace_domain', 'cruxindia.co.in',
   'The only e-mail domain that may sign in. A personal address cannot hold a chair.',
   'Sign-in', 'ADMIN')
on conflict (key) do nothing;

-- Sign-in MATCHES a person; it never creates one. The domain is checked by the
-- caller against the hd claim Google signs, and again here against the address,
-- because a caller that forgets is not a reason to let somebody in.
create or replace function auth_google(p_email text, p_token_hash text, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare p person%rowtype; v_domain text;
begin
  select value into v_domain from app_setting where key = 'workspace_domain';

  if lower(p_email) not like '%@' || lower(coalesce(v_domain,'cruxindia.co.in')) then
    insert into login_attempt (email, ip, ok) values (lower(p_email), p_ip, false);
    return jsonb_build_object('error','wrong_domain',
      'reason', p_email || ' is not a Crux Workspace address.',
      'hint','Personal addresses cannot hold a chair.');
  end if;

  select * into p from person
   where lower(work_email) = lower(p_email)
     and employment_status = 'ACTIVE'
     and superseded_by is null;

  if not found then
    insert into login_attempt (email, ip, ok) values (lower(p_email), p_ip, false);
    return jsonb_build_object('error','not_a_person',
      'reason', p_email || ' is not on the people master.',
      'hint','HR loads the person first. Signing in does not create an employee.');
  end if;

  insert into login_attempt (email, ip, ok) values (lower(p_email), p_ip, true);
  insert into auth_session (person_id, expires_at, source, token_hash)
  values (p.id, now() + interval '7 days', 'WORKSPACE_SSO', p_token_hash);

  return jsonb_build_object('id', p.id, 'full_name', p.full_name,
    'work_email', p.work_email, 'app_role', p.app_role);
end $fn$;

create or replace function app_config() returns jsonb
language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'googleClientId', (select value from app_setting where key='google_client_id'),
    'workspaceDomain', (select value from app_setting where key='workspace_domain'))
$fn$;

-- ------------------------------------------------------------- the page
create table if not exists app_page (
  slug       text primary key,
  html       text not null,
  updated_at timestamptz not null default now()
);
comment on table app_page is
  'The front end, served from here rather than baked into the edge function. '
  'A change to a screen is an UPDATE, not a redeploy.';
alter table app_page enable row level security;
alter table app_page force row level security;
revoke all on app_page from anon, authenticated;

create or replace function app_html(p_slug text default 'app')
returns text language sql stable security definer set search_path = public as $fn$
  select html from app_page where slug = p_slug
$fn$;
-- the page itself is in supabase/functions/crux/app.html and is loaded into
-- app_page; it is not repeated here

-- --------------------------------------------------- what the screens need
-- Scoped the same way every read is: an administrator sees everything, anyone
-- else sees only what their coverage resolves to. A form that offered a client
-- outside your scope would be offering you a case you cannot then read.
create or replace function app_refs(p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_admin boolean;
begin
  select app_role = 'ADMIN' into v_admin from person where id = p_person;
  return jsonb_build_object(
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'code', c.code) order by c.name)
        from client c
       where c.status = 'ACTIVE'
         and (v_admin or exists (
              select 1 from coverage_rule r
               where r.person_id = p_person and r.client_id = c.id
                 and (r.effective_to is null or r.effective_to >= current_date)))), '[]'::jsonb),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code,
                                          'client_id', b.client_id) order by b.name)
        from branch b
       where b.status = 'ACTIVE'
         and (v_admin or exists (
              select 1 from coverage_rule r
              cross join lateral coverage_resolve(r) cr(branch_id)
               where r.person_id = p_person and cr.branch_id = b.id
                 and (r.effective_to is null or r.effective_to >= current_date)))), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
        from category where active), '[]'::jsonb));
end $fn$;

-- current_state and sla_status are returned side by side because they are
-- different facts: a breached assignment is still IN_PROGRESS.
create or replace function ogl_list(p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_admin boolean;
begin
  select app_role = 'ADMIN' into v_admin from person where id = p_person;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.due_at nulls last)
      from (
        select a.id, a.ref, a.current_state, a.created_at, a.closed_at,
               vc.applicant_name, vc.force1_case_id,
               c.name as client, g.name as location,
               si.sla_status, si.due_at,
               n.full_name as next_action_owner
          from assignment a
          join verification_case vc on vc.id = a.case_id
          join client c on c.id = vc.client_id
          join geo_node g on g.id = a.to_location_id
          left join sla_instance si on si.assignment_id = a.id
                                   and si.breach_cycle_no = a.breach_cycle_no
          left join person n on n.id = a.next_action_owner_id
         where v_admin
            or a.assignor_id = p_person
            or a.allocated_to_id = p_person
            or a.next_action_owner_id = p_person
         order by si.due_at nulls last
         limit 200) x), '[]'::jsonb);
end $fn$;

-- ------------------------------------------------------- emptying the tool
-- Two things this deliberately is NOT. It is not a purge of "rows that look
-- like demo data" — once real data is loaded through the same uploader it
-- carries the same marks, and a purge that guesses would one day take the real
-- thing. And it is not a truncate of everything: that would delete the account
-- of the person running it and lock them out of their own tool.
create or replace function data_reset_preview()
returns table (table_name text, rows bigint)
language plpgsql stable security definer set search_path = public as $fn$
declare t text; n bigint;
begin
  foreach t in array array[
    'sla_clock_segment','assignment_request','assignment_event','assignment_completion',
    'sla_instance','assignment','repeat_point_decision','case_verification_requirement',
    'case_party','verification_case','ogl_escalation_matrix',
    'escalation_action_log','escalation_party','case_event','case',
    'claim','penalty_instance','pms_adjustment','pms_component','pms_dispute',
    'pms_exception','pms_score','pms_cycle','raisable',
    'daily_count','daily_note','task','target','perf_month','perf_revenue','perf_collection',
    'role_change','person_event','letter','notification','push_subscription',
    'value_correction','day_reopen','upload_row','upload_batch','holiday',
    'matrix_contact','client_contact','branch_contact','coverage_rule','client_zone',
    'branch','client','chair_holder','person','chair','geo_node',
    'sample_row','login_attempt','outbox','delivery','person_request'
  ] loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('select count(*) from %I', t) into n;
      if n > 0 then table_name := t; rows := n; return next; end if;
    end if;
  end loop;
end $fn$;

create or replace function data_reset(p_actor uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare t text; n bigint; v_counts jsonb := '{}'::jsonb; v_chair uuid; v_total bigint := 0;
begin
  if p_confirm is distinct from 'DELETE ALL DATA' then
    return jsonb_build_object('error','not_confirmed',
      'reason','This empties every person, client, branch, case and filing in the tool.',
      'hint','Type DELETE ALL DATA to confirm.');
  end if;
  if p_actor is null or not exists (select 1 from person where id = p_actor and app_role = 'ADMIN') then
    return jsonb_build_object('error','admin_only',
      'reason','Only an administrator can empty the tool.');
  end if;

  -- the chair the administrator sits in survives, or they cannot sign back in
  select chair_id into v_chair from chair_holder
   where person_id = p_actor and to_date is null order by is_primary desc limit 1;

  foreach t in array array[
    'sla_clock_segment','assignment_request','assignment_event','assignment_completion',
    'sla_instance','assignment','repeat_point_decision','case_verification_requirement',
    'case_party','verification_case','ogl_escalation_matrix',
    'escalation_action_log','escalation_party','case_event','case',
    'claim','penalty_instance','pms_adjustment','pms_component','pms_dispute',
    'pms_exception','pms_score','pms_cycle','raisable',
    'daily_count','daily_note','task','target','perf_month','perf_revenue','perf_collection',
    'role_change','person_event','letter','notification','push_subscription',
    'value_correction','day_reopen','person_request','upload_row','upload_batch','holiday',
    'matrix_contact','client_contact','branch_contact','coverage_rule','client_zone',
    'branch','client','sample_row','login_attempt','outbox','delivery'
  ] loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('delete from %I', t);
      get diagnostics n = row_count;
      if n > 0 then
        v_counts := v_counts || jsonb_build_object(t, n); v_total := v_total + n;
      end if;
    end if;
  end loop;

  delete from chair_holder where person_id <> p_actor;
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('chair_holder', n); v_total := v_total + n;

  delete from person where id <> p_actor;
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('person', n); v_total := v_total + n;

  -- keep the administrator's own chair and the line above it, so the structure
  -- they sit in is still coherent when they sign back in
  delete from chair where id not in (
    with recursive up as (
      select id, parent_id from chair where id = v_chair
      union all
      select c.id, c.parent_id from chair c join up on c.id = up.parent_id)
    select id from up);
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('chair', n); v_total := v_total + n;

  delete from geo_node;
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('geo_node', n); v_total := v_total + n;

  update ref_counter set last_no = 0;

  insert into audit_entry (actor_id, action, entity_type, entity_ref, new_value)
  values (p_actor, 'DATA_RESET', 'database', 'all', v_counts);

  return jsonb_build_object('deleted', v_total, 'byTable', v_counts,
    'kept', 'Configuration, the audit trail, your own account and the chair you sit in.');
end $fn$;

-- ------------------------------------------------------------- exposure
do $g$
declare f text;
begin
  foreach f in array array[
    'auth_google(text,text,text)','app_config()','app_html(text)','app_refs(uuid)',
    'ogl_list(uuid)','data_reset_preview()','data_reset(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $g$;
