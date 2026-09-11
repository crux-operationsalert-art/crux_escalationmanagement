-- =====================================================================
-- 20 · PEOPLE — one row per human, identity resolved once.
-- Defect 3: identity was an e-mail string. aniket.chalke@cruxINIDA.co.in
-- holds 583 coverage rows and exists in no USERS row. Rules:
--   P-01 typo domains are normalised before anything is compared
--   P-02 an e-mail seen only in BRANCH_ASSIGNMENTS still creates a person
--   P-03 twins merge into the older row; superseded_by is set, never deleted
--   P-04 every merge writes migration_merge with the rule that decided it
-- =====================================================================

-- designations first: routing is by designation, so an unknown title is a gap
insert into designation (title, seniority)
select distinct stg.norm_name(u.designation), 0
from stg.users u where stg.present(u.designation)
on conflict (title) do nothing;

-- P-01/P-02 · the candidate set is the union of every place a human appears
create temp table cand as
with src as (
  select stg.norm_email(email) as email, stg.norm_name(name) as full_name,
         designation, department, status, 'USERS!' || row_no as ref, stg.ts(created_at) as seen_at, 1 as pref
  from stg.users where stg.present(email) or stg.present(name)
  union all
  select stg.norm_email(user_email), null, null, null, 'ACTIVE',
         'BRANCH_ASSIGNMENTS!' || row_no, stg.ts(created_at), 2
  from stg.branch_assignments where stg.present(user_email)
  union all
  select stg.norm_email(bm_email), stg.norm_name(bm_name), null, null, 'ACTIVE',
         'BRANCHES!' || row_no, stg.ts(updated_at), 3
  from stg.branches where stg.present(bm_email)
  union all
  select stg.norm_email(updated_by), null, null, null, 'ACTIVE',
         'MATRIX!' || row_no, stg.ts(updated_at), 3
  from stg.matrix where stg.present(updated_by)
)
select email,
       (array_agg(full_name order by pref, seen_at nulls last) filter (where full_name is not null))[1] as full_name,
       (array_agg(designation order by pref) filter (where designation is not null))[1] as designation,
       (array_agg(department  order by pref) filter (where department  is not null))[1] as department,
       (array_agg(status      order by pref) filter (where status      is not null))[1] as status,
       min(seen_at) as first_seen,
       (array_agg(ref order by pref, seen_at nulls last))[1] as source_ref,
       count(*) as mentions,
       min(pref) as best_pref
from src where email is not null
group by email;

insert into person (full_name, work_email, designation_id, department, app_role, employment_status, source_ref)
select coalesce(c.full_name, initcap(replace(split_part(c.email,'@',1), '.', ' '))),
       c.email,
       d.id,
       c.department,
       'VIEWER'::role_kind,
       case when upper(coalesce(c.status,'ACTIVE')) in ('INACTIVE','LEFT','EXITED') then 'INACTIVE' else 'ACTIVE' end::entity_status,
       c.source_ref
from cand c left join designation d on d.title = stg.norm_name(c.designation)
on conflict do nothing;

-- P-02 receipt · people who existed only in coverage rows are named in the log
insert into migration_merge (entity_type, kept_id, merged_key, rows_moved, rule)
select 'person', p.id, c.email, c.mentions::int, 'P-02 created from coverage only (absent from USERS)'
from cand c join person p on p.work_email = c.email
where c.best_pref > 1;

-- P-03 · twin detection AFTER normalisation: same normalised e-mail local part
-- and same normalised name, different rows. The older row survives.
with pairs as (
  select a.id as keep_id, b.id as drop_id,
         split_part(a.work_email,'@',1) as local
  from person a join person b
    on a.id <> b.id
   and stg.norm_name(a.full_name) = stg.norm_name(b.full_name)
   and split_part(a.work_email,'@',1) = split_part(b.work_email,'@',1)
   and (a.created_at, a.id) < (b.created_at, b.id)
)
update person p set superseded_by = pairs.keep_id, employment_status = 'INACTIVE', updated_at = now()
from pairs where p.id = pairs.drop_id;

insert into migration_merge (entity_type, kept_id, merged_id, merged_key, rule)
select 'person', p.superseded_by, p.id, p.work_email,
       'P-03 typo-domain twin merged into older identity'
from person p where p.superseded_by is not null;

-- reporting chain, resolved through the surviving identity
update person p set manager_id = m2.id
from stg.users u
join person m on m.work_email = stg.norm_email(u.manager_email)
join person m2 on m2.id = coalesce(m.superseded_by, m.id)
where p.work_email = stg.norm_email(u.email) and stg.present(u.manager_email);

-- P-05 · 39 of 55 users held a standing AccessToken in the sheet. None migrate.
insert into audit_entry (actor_id, action, entity_type, entity_ref, old_value, new_value)
select null, 'MIGRATION_TOKEN_REVOKED', 'person', stg.norm_email(u.email),
       jsonb_build_object('had_standing_token', true), jsonb_build_object('sessions', 0)
from stg.users u where stg.present(u.access_token);
