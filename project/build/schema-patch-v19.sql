-- =====================================================================
-- CRUX — schema patch v19
-- The doors the linter found standing open.
--
-- Run after v18, before any real data is loaded. Everything here is a
-- revoke or an ALTER ... ENABLE ROW LEVEL SECURITY; nothing changes what
-- the application does, because the application reads through the edge
-- functions as service_role, which is not subject to either.
-- =====================================================================

-- Twelve tables carried a SELECT grant to anon and had no row-level
-- security on them at all. anon is the key printed in the page source of
-- every Supabase app; these were readable by anybody who looked. Two of
-- them are the escalation case and its event log, and one is the org
-- chart. This is the same class of defect as the OGL tables in v13, found
-- the same way, and it is closed the same way.
do $do$
declare t text;
begin
  foreach t in array array[
    'case','case_event','chair','chair_holder','geo_node','holiday',
    'category','desk','designation','client_zone','client_view_policy',
    'visit_form_field'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $do$;

-- A view owned by a superuser runs with the owner's rights, so a grant on
-- one is a hole straight past every policy underneath it. None of these is
-- meant for an unauthenticated caller.
do $do$
declare v text;
begin
  foreach v in array array[
    'branch_effective_matrix','branch_matrix_state','chair_status',
    'dispatch_eligible_branch','dispatch_eligible_branch_v2',
    'migration_coverage_shape','migration_gate','migration_merge_log',
    'migration_open_questions','migration_unaccounted'
  ] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
  end loop;
end $do$;

-- crux_tick() drives the sweeps: it raises escalations, generates strikes
-- and queues mail. It was callable, unauthenticated, at /rest/v1/rpc.
-- postgres keeps it because that is the role pg_cron runs the job as.
revoke all on function crux_tick() from public, anon, authenticated;
grant execute on function crux_tick() to service_role, postgres;

-- otp_gate answers whether a mobile number belongs to somebody here, which
-- makes it a directory for anyone who can call it.
revoke all on function otp_gate(text) from public, anon, authenticated;

-- A function that resolves its own names against whatever search_path the
-- caller happens to have is a function somebody else can redirect.
alter function ul_txt(jsonb, text) set search_path = public;
alter function is_ymd(text)        set search_path = public;
alter function is_ym(text)         set search_path = public;
alter function csv_cell(text)      set search_path = public;

-- The check that this held. Both must be zero.
--   select count(*) from information_schema.role_table_grants
--    where table_schema='public' and grantee in ('anon','authenticated');
--   select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
--    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;
