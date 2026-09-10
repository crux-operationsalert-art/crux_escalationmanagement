-- =====================================================================
-- 40 · ESCALATION MATRIX — 3,783 rows, 5 levels per branch.
-- The unique index allows one row per (branch, level). Rules:
--   M-01 a level is complete with a name plus mobile or e-mail (rule R-01)
--   M-02 duplicate (branch, level) keeps the most complete, then the latest
--   M-03 rows whose branch did not survive attach to the client-level matrix
--   M-04 completeness is never written — 693 complete branches must fall out
--        of branch_matrix_state, not out of a column
-- =====================================================================
create temp table matrix_pick as
with rows as (
  select m.*, cl.id as client_uuid, b.id as branch_uuid,
         nullif(regexp_replace(coalesce(m.level,''), '[^0-9]', '', 'g'), '')::int as lvl,
         ( (stg.present(m.name))::int + (stg.present(m.mobile))::int + (stg.present(m.email))::int ) as fill_score
  from stg.matrix m
  join client cl on cl.code = btrim(m.client_code)
  left join branch b on b.client_id = cl.id and b.code = btrim(m.branch_code)
  where stg.present(m.name) or stg.present(m.mobile) or stg.present(m.email)
)
select *, row_number() over (partition by client_uuid, branch_uuid, lvl
                             order by fill_score desc, stg.ts(updated_at) desc nulls last, row_no) as rn
from rows where lvl between 1 and 5;

insert into matrix_contact (client_id, branch_id, level, level_name, person_id, name, mobile, email, updated_by, updated_at, source_ref)
select p.client_uuid, p.branch_uuid, p.lvl,
       coalesce(nullif(btrim(p.level_name),''), 'Level ' || p.lvl),
       coalesce(ip.superseded_by, ip.id),
       stg.norm_name(p.name), stg.norm_mobile(p.mobile), stg.norm_email(p.email),
       coalesce(up.superseded_by, up.id), coalesce(stg.ts(p.updated_at), now()),
       'MATRIX!' || p.row_no
from matrix_pick p
left join person ip on ip.work_email = stg.norm_email(p.email)
left join person up on up.work_email = stg.norm_email(p.updated_by)
where p.rn = 1
on conflict do nothing;

-- M-02 receipt
insert into migration_merge (entity_type, kept_id, merged_key, rows_moved, rule)
select 'matrix_contact', mc.id, 'MATRIX!' || d.row_no, 1,
       'M-02 duplicate level collapsed (kept fill score ' || k.fill_score || ' over ' || d.fill_score || ')'
from matrix_pick d
join matrix_pick k on k.client_uuid = d.client_uuid
  and coalesce(k.branch_uuid, '00000000-0000-0000-0000-000000000000') = coalesce(d.branch_uuid, '00000000-0000-0000-0000-000000000000')
  and k.lvl = d.lvl and k.rn = 1
join matrix_contact mc on mc.source_ref = 'MATRIX!' || k.row_no
where d.rn > 1;

-- M-03 receipt · orphaned branch codes
insert into migration_review (entity_type, entity_ref, question, context)
select 'matrix_contact', 'MATRIX!' || p.row_no,
       'Branch code "' || btrim(p.branch_code) || '" not found — row held at client level. Reattach or delete?',
       concat_ws(' | ', p.name, p.mobile, p.email)
from matrix_pick p where p.rn = 1 and stg.present(p.branch_code) and p.branch_uuid is null;
