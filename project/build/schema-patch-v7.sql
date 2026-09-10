-- =====================================================================
-- CRUX — schema patch v7: close the PostgREST hole, and pin search_path
--
-- 01_rls.sql revoked everything from `anon` and stopped there. `authenticated`
-- was left holding SELECT, INSERT, UPDATE, DELETE and TRUNCATE on all 103
-- tables, and 57 of those have no RLS. Any signed-in Workspace account could
-- therefore go straight to PostgREST with its own JWT and read every penalty,
-- rate and revenue figure — or rewrite them, or truncate audit_entry.
--
-- That is precisely what the RLS file said it was preventing: "a leaked key, a
-- mistake in a new endpoint, or someone querying through the Supabase SQL
-- editor still cannot read outside their scope."
--
-- Nothing in the product needs those grants: the application talks to the
-- Express API, which connects as the owner, and the owner is unaffected by
-- everything below.
-- Run after schema-patch-v6.sql.
-- =====================================================================

-- ------------------------------------------------- writes are the API's job
-- Every write goes through build/api, inside tx(), which cannot commit a
-- change without its audit row. A client writing directly would bypass that,
-- so no client may write directly. Read access is dealt with separately below
-- because some of it is load-bearing for the policies themselves.
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
revoke insert, update, delete, truncate on all tables in schema public from anon;
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from authenticated;

-- --------------------------------------------------- reads worth locking
-- Deny-by-default on the tables where a read is itself the damage: keys,
-- one-time codes, link tokens, the money, and the people pipeline. RLS with no
-- policy denies everyone except the owner, which is the API.
--
-- Deliberately NOT locked here: client_view_policy, person, day_reopen,
-- pms_cycle and ogl_attachment. Their contents are read INSIDE other tables'
-- policy expressions, which are evaluated as the querying role rather than as
-- the definer — locking them would not raise an error, it would quietly make
-- those policies return false and empty the screens that depend on them.
do $$
declare t text;
begin
  foreach t in array array[
    'ai_key','ai_call','mail_config','mail_alias','mail_bounce',
    'otp_challenge','portal_link',
    'app_setting','setting','assist_guide',
    'penalty_rule','rate','rate_location','rate_exception',
    'business_record','forecast_config','mis_saved_view',
    'person_request','onboarding','pulse_response',
    'migration_review','migration_merge',
    'kpi_definition','kpi_target','kpi_eligibility',
    'pms_weighting','pms_impact','pms_exception','pms_curve_band','pms_band_result',
    'automation','automation_run','job_config','job_run',
    'outbox','delivery','template','mail_budget',
    'escalation_action','escalation_action_log','escalation_party',
    'submission_window','process','process_party','process_input'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- ------------------------------------------- the reopen a person cannot see
-- daily_update_own lets somebody correct a locked day while an administrator's
-- reopen window is open — but it proves that window by reading day_reopen,
-- whose only policy is admin-only. A non-admin therefore could not see their
-- own reopen row, so the branch could never be true for the very people it
-- exists for. A person may now see the reopen rows that are about them.
create policy reopen_own_read on day_reopen for select
  using (person_id = app_person_id() or app_is_admin());

-- ----------------------------------------------------------- search_path
-- A function without a pinned search_path resolves its tables against
-- whatever the caller's search_path happens to be. For SECURITY DEFINER
-- functions that is a privilege-escalation route; for the rest it is still a
-- correctness risk. ALTER rather than recreate, so no body changes here.
alter function coverage_resolve(coverage_rule)            set search_path = public;
alter function coverage_no_overlap()                      set search_path = public;
alter function may_edit_penalty_rule(uuid)                set search_path = public;
alter function penalty_recovery_for(uuid, uuid)           set search_path = public;
alter function pms_window_may_open(uuid, date)            set search_path = public;
alter function pms_attribute_balance(uuid)                set search_path = public;
alter function stg.present(text)                          set search_path = stg, public;
alter function stg.norm_email(text)                       set search_path = stg, public;
alter function stg.norm_name(text)                        set search_path = stg, public;
alter function stg.norm_mobile(text)                      set search_path = stg, public;
alter function stg.ts(text)                               set search_path = stg, public;
