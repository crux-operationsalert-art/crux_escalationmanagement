-- =====================================================================
-- CRUX on Supabase — row-level security
--
-- The API already scopes every read through coverage_rule (build/api/scope.js).
-- RLS is the second lock: it means a leaked anon key, a mistake in a new
-- endpoint, or someone querying through the Supabase SQL editor still cannot
-- read outside their scope. Defence in depth, not a replacement.
--
-- Run after schema.sql and schema-patch-v4.sql.
-- =====================================================================

-- --------------------------------------------------------------- helpers
-- The signed-in person, resolved from the Supabase JWT. Sign-in MATCHES a
-- person row; it never creates one. An auth user with no person row resolves
-- to null and every policy below then denies — which is the correct answer
-- for someone who is authenticated but not employed.
create or replace function app_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select p.id from person p
   where p.work_email = lower(nullif(current_setting('request.jwt.claims', true)::json->>'email',''))
     and p.status = 'ACTIVE'
   limit 1
$$;

create or replace function app_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from chair_holder ch
      join chair c on c.id = ch.chair_id
     where ch.person_id = app_person_id()
       and ch.to_date is null
       and c.level = 'admin')
$$;

-- Everyone at or below the signed-in person, at every depth. This is the
-- drill-down the dashboard shows, and it is the same set the database will
-- release — the screen cannot show more than the policy allows.
create or replace function app_subtree() returns table (person_id uuid)
language sql stable security definer set search_path = public as $$
  with recursive below as (
    select id from person where id = app_person_id()
    union all
    select p.id from person p join below b on p.manager_id = b.person_id
  )
  select id from below
$$;

-- The clients and locations the person's coverage actually resolves to.
create or replace function app_scope_clients() returns table (client_id uuid)
language sql stable security definer set search_path = public as $$
  select distinct cr.client_id from coverage_rule cr
   where cr.person_id in (select person_id from app_subtree())
     and cr.effective_to is null
$$;

-- ------------------------------------------------------------ enable RLS
do $$
declare t text;
begin
  foreach t in array array[
    'person','daily_count','daily_note','task','target',
    'perf_month','perf_revenue','perf_collection','role_change',
    'pms_cycle','pms_component','pms_adjustment','pms_dispute','pms_score',
    'penalty_instance','raisable','request_task','letter','person_event',
    'visit','claim','idea','idea_collaborator',
    'coverage_rule','client','branch','branch_contact','matrix_contact',
    'client_contact','ogl_attachment','value_correction','day_reopen',
    'notification','push_subscription','auth_session','audit_entry'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------- own records
-- A person always sees their own row and their own filings. This is the
-- floor: no policy below can take it away.
create policy person_self_read on person for select
  using (id = app_person_id() or id in (select person_id from app_subtree()) or app_is_admin());

create policy person_self_update on person for update
  using (id = app_person_id())
  with check (id = app_person_id());

-- --------------------------------------------------------- daily filing
-- Read your own and your team's, all the way down. Write only your own —
-- a manager filing their team's numbers is exactly what the change request
-- said must not happen.
create policy daily_read on daily_count for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());

create policy daily_insert_own on daily_count for insert
  with check (person_id = app_person_id());

-- Update is allowed only inside the day, or inside an open administrator
-- reopen. The 24-hour constraint in the patch handles the offline case;
-- this handles the deliberate correction.
create policy daily_update_own on daily_count for update
  using (
    person_id = app_person_id()
    and (
      received_at::date = current_date
      or exists (select 1 from day_reopen r
                  where r.person_id = daily_count.person_id
                    and r.day = daily_count.for_day
                    and r.closed_at is null
                    and now() < r.closes_at)
    )
  )
  with check (person_id = app_person_id());

-- Nothing is ever deleted. Corrections overwrite and log the previous value.
create policy daily_no_delete on daily_count for delete using (false);

-- ------------------------------------------------------------ notes etc
create policy note_read on daily_note for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());
create policy note_write_own on daily_note for insert
  with check (person_id = app_person_id());

create policy task_read on task for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());

create policy target_read on target for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());
-- targets are set BY THE MANAGER and are read-only to the holder
create policy target_write_manager on target for insert
  with check (
    person_id <> app_person_id()
    and person_id in (select person_id from app_subtree())
  );

-- --------------------------------------------------- performance history
create policy perf_month_read on perf_month for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());

create policy perf_revenue_read on perf_revenue for select
  using (client_id in (select client_id from app_scope_clients()) or app_is_admin());

create policy perf_collection_read on perf_collection for select
  using (client_id in (select client_id from app_scope_clients()) or app_is_admin());

-- History is loaded by bulk upload, which runs as the service role.
create policy perf_month_admin_write on perf_month for all
  using (app_is_admin()) with check (app_is_admin());
create policy perf_revenue_admin_write on perf_revenue for all
  using (app_is_admin()) with check (app_is_admin());
create policy perf_collection_admin_write on perf_collection for all
  using (app_is_admin()) with check (app_is_admin());

create policy role_change_read on role_change for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());
create policy role_change_admin_write on role_change for all
  using (app_is_admin()) with check (app_is_admin());

-- ------------------------------------------------------------ appraisal
-- You see your own cycle and your team's. You cannot score yourself, and
-- you cannot decide a dispute about your own score.
create policy pms_cycle_read on pms_cycle for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());

create policy pms_cycle_score_not_self on pms_cycle for update
  using (
    person_id in (select person_id from app_subtree())
    and person_id <> app_person_id()
  )
  with check (person_id <> app_person_id());

create policy pms_dispute_read on pms_dispute for select
  using (
    cycle_id in (select id from pms_cycle where person_id in (select person_id from app_subtree()))
    or app_is_admin());

-- ------------------------------------------------------------ penalties
create policy penalty_read on penalty_instance for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());
create policy penalty_no_self_waive on penalty_instance for update
  using (app_is_admin() and person_id <> app_person_id());

-- ------------------------------------------------- raisables and letters
-- A raisable hits the person it is raised against, never the raiser. Both
-- sides can read it; only the raiser and admin can write it.
create policy raisable_read on raisable for select
  using (
    against_person_id in (select person_id from app_subtree())
    or raised_by = app_person_id()
    or app_is_admin());

create policy raisable_insert on raisable for insert
  with check (raised_by = app_person_id() and against_person_id <> app_person_id());

create policy letter_read on letter for select
  using (person_id in (select person_id from app_subtree()) or person_id = app_person_id() or app_is_admin());

-- ---------------------------------------------------- clients and scope
create policy coverage_read on coverage_rule for select
  using (person_id in (select person_id from app_subtree()) or app_is_admin());

create policy client_read on client for select
  using (id in (select client_id from app_scope_clients()) or app_is_admin());

create policy branch_read on branch for select
  using (client_id in (select client_id from app_scope_clients()) or app_is_admin());

-- HR sees no client data; the policy reads the table rather than a constant.
create policy client_contact_read on client_contact for select
  using (
    app_is_admin()
    or exists (
      select 1 from person p
        join client_view_policy v on v.department = p.department
       where p.id = app_person_id() and v.view_kind in ('matrix','contacts'))
    and client_id in (select client_id from app_scope_clients()));

-- ---------------------------------------------------------- attachments
create policy ogl_att_read on ogl_attachment for select
  using (uploaded_by in (select person_id from app_subtree()) or app_is_admin());
create policy ogl_att_insert on ogl_attachment for insert
  with check (uploaded_by = app_person_id());
create policy ogl_att_no_delete on ogl_attachment for delete using (false);

-- ------------------------------------------------- audit and correction
-- Append-only, readable by admin. Nobody edits the trail, including admin.
create policy audit_read on audit_entry for select using (app_is_admin());
create policy audit_no_update on audit_entry for update using (false);
create policy audit_no_delete on audit_entry for delete using (false);

create policy correction_read on value_correction for select
  using (app_is_admin());
create policy correction_no_change on value_correction for update using (false);
create policy correction_no_delete on value_correction for delete using (false);

create policy reopen_admin on day_reopen for all
  using (app_is_admin()) with check (app_is_admin());

-- -------------------------------------------------------- notifications
create policy notif_own on notification for select using (person_id = app_person_id());
create policy notif_own_update on notification for update
  using (person_id = app_person_id()) with check (person_id = app_person_id());
create policy push_own on push_subscription for all
  using (person_id = app_person_id()) with check (person_id = app_person_id());

create policy session_own on auth_session for select using (person_id = app_person_id());

-- ------------------------------------------------------------ the anon key
-- Nothing is readable without a session. Stated explicitly rather than left
-- to the absence of a policy, so a future GRANT cannot open it by accident.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
