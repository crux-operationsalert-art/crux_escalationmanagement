-- =====================================================================
-- 70 · RECONCILIATION GATES — the migration is not done until every row
-- below reads PASS. These are the audited counts; a mismatch is a defect in
-- the migration, not a number to be edited.
-- =====================================================================
create or replace view migration_gate as
with g as (
  select 'clients'               as gate, (select count(*) from client)::int             as actual, 28    as expected union all
  select 'branches',                      (select count(*) from branch),                            1413  union all
  select 'branches ACTIVE',               (select count(*) from branch where status='ACTIVE'),      722   union all
  select 'branches INACTIVE',             (select count(*) from branch where status='INACTIVE'),    691   union all
  select 'matrix rows',                   (select count(*) from matrix_contact),                    3783  union all
  select 'branches complete at 5 levels', (select count(*) from branch_matrix_state where complete_levels = 5), 693 union all
  select 'people',                        (select count(*) from person where superseded_by is null), 55   union all
  select 'open escalation cases',         (select count(*) from "case" where status <> 'CLOSED'),   3     union all
  select 'rescued notes',                 (select count(*) from person_event where source_ref like 'Copy of%'), 449 union all
  select 'queued mail',                   (select count(*) from outbox where state = 'QUEUED'),     0     union all
  select 'standing tokens',               (select count(*) from auth_session where revoked_at is null), 0
)
select gate, actual, expected, actual - expected as delta,
       case when actual = expected then 'PASS' else 'FAIL' end as result
from g;

-- coverage does not have an expected count — it has an expected shape
create or replace view migration_coverage_shape as
select scope_type, count(*) as rules,
       sum((select count(*) from coverage_resolve(r))) as branches_covered
from coverage_rule r group by scope_type order by 1;

-- nothing may be left unanswered at cut-over
create or replace view migration_open_questions as
select entity_type, count(*) as open
from migration_review where resolved_at is null group by entity_type order by 2 desc;

-- the merge log, in the shape the owner signs off on
create or replace view migration_merge_log as
select m.at, m.entity_type, m.rule,
       coalesce(m.merged_key, m.merged_id::text) as merged,
       m.kept_id, m.rows_moved,
       case when m.reviewed_at is null then 'UNREVIEWED' else 'REVIEWED' end as state
from migration_merge m order by m.entity_type, m.at;

-- a row that reached no table and no log is the one thing we cannot allow
create or replace view migration_unaccounted as
select 'BRANCHES' as tab, b.row_no, coalesce(b.code, b.name) as key
from stg.branches b
where (stg.present(b.code) or stg.present(b.name))
  and not exists (select 1 from branch x where x.source_ref = 'BRANCHES!' || b.row_no)
  and not exists (select 1 from migration_merge x where x.merged_key = 'BRANCHES!' || b.row_no)
  and not exists (select 1 from migration_review x where x.entity_ref = 'BRANCHES!' || b.row_no)
union all
select 'MATRIX', m.row_no, m.branch_code
from stg.matrix m
where (stg.present(m.name) or stg.present(m.email) or stg.present(m.mobile))
  and not exists (select 1 from matrix_contact x where x.source_ref = 'MATRIX!' || m.row_no)
  and not exists (select 1 from migration_merge x where x.merged_key = 'MATRIX!' || m.row_no)
  and not exists (select 1 from migration_review x where x.entity_ref = 'MATRIX!' || m.row_no);
