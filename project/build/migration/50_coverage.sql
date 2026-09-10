-- =====================================================================
-- 50 · COVERAGE — the 1,729-row cross-product becomes ~40 scoped rules.
-- Coverage was defined twice (USERS.Scope* and BRANCH_ASSIGNMENTS) with no
-- precedence. Owner decision D6: collapse to the most specific shape that
-- covers exactly the same branches, refuse overlaps, log everything else.
--   C-01 the truth is the union of both sources, resolved per (person, role)
--   C-02 try CLIENT, then CLIENT_ZONE, then STATE, then per-branch rows
--   C-03 a candidate scope is accepted only if it covers the observed set
--        exactly — one extra branch and we fall to the next shape
--   C-04 the overlap trigger will reject collisions; each rejection is logged
--        and the person keeps the earlier rule
-- =====================================================================
create temp table observed as
select coalesce(p.superseded_by, p.id) as person_id,
       upper(coalesce(nullif(btrim(a.role),''), 'BRANCH_MANAGER')) as role,
       b.id as branch_id, b.client_id, b.client_zone_id, b.geo_node_id,
       'BRANCH_ASSIGNMENTS!' || a.row_no as ref
from stg.branch_assignments a
join person p on p.work_email = stg.norm_email(a.user_email)
join client cl on cl.code = btrim(a.client_code)
join branch b on b.client_id = cl.id and b.code = btrim(a.branch_code)
union
select coalesce(p.superseded_by, p.id), upper(coalesce(nullif(btrim(u.role),''),'BRANCH_MANAGER')),
       b.id, b.client_id, b.client_zone_id, b.geo_node_id, 'USERS!' || u.row_no
from stg.users u
join person p on p.work_email = stg.norm_email(u.email)
join client cl on cl.code = btrim(u.scope_client)
join branch b on b.client_id = cl.id
left join client_zone cz on cz.id = b.client_zone_id
where stg.present(u.scope_client)
  and (not stg.present(u.scope_zone)   or lower(cz.name) = lower(btrim(u.scope_zone)))
  and (not stg.present(u.scope_branch) or b.code = btrim(u.scope_branch));

create temp table shaped as
with per as (
  select person_id, role, count(*) as n_branches,
         count(distinct client_id) as n_clients,
         count(distinct client_zone_id) as n_zones,
         min(client_id) as client_id, min(client_zone_id) as client_zone_id,
         min(ref) as ref
  from observed group by person_id, role
), whole_client as (
  select p.*, (select count(*) from branch b where b.client_id = p.client_id) as client_total
  from per p where p.n_clients = 1
), whole_zone as (
  select p.*, (select count(*) from branch b where b.client_zone_id = p.client_zone_id) as zone_total
  from per p where p.n_zones = 1 and p.client_zone_id is not null
)
select per.person_id, per.role, per.ref,
       case when wc.client_total = per.n_branches then 'CLIENT'
            when wz.zone_total   = per.n_branches then 'CLIENT_ZONE'
            else 'BRANCH' end as scope_type,
       per.client_id, per.client_zone_id, per.n_branches
from per
left join whole_client wc on wc.person_id = per.person_id and wc.role = per.role
left join whole_zone   wz on wz.person_id = per.person_id and wz.role = per.role;

-- C-02 · the collapsed rules
insert into coverage_rule (person_id, role, scope_type, client_id, client_zone_id, source_ref)
select person_id, role, 'CLIENT', client_id, null, ref || ' (collapsed from ' || n_branches || ' rows)'
from shaped where scope_type = 'CLIENT';

insert into coverage_rule (person_id, role, scope_type, client_id, client_zone_id, source_ref)
select s.person_id, s.role, 'CLIENT_ZONE', null, s.client_zone_id, s.ref || ' (collapsed from ' || s.n_branches || ' rows)'
from shaped s where s.scope_type = 'CLIENT_ZONE';

insert into coverage_rule (person_id, role, scope_type, branch_id, source_ref)
select o.person_id, o.role, 'BRANCH', o.branch_id, o.ref
from observed o join shaped s on s.person_id = o.person_id and s.role = o.role
where s.scope_type = 'BRANCH';

-- C-01 receipt · how many sheet rows each rule replaced
insert into migration_merge (entity_type, kept_id, merged_key, rows_moved, rule)
select 'coverage_rule', r.id, p.work_email || ' / ' || s.role, s.n_branches,
       'C-02 ' || s.scope_type || ' scope covers the observed branch set exactly'
from shaped s
join person p on p.id = s.person_id
join coverage_rule r on r.person_id = s.person_id and r.role = s.role and r.scope_type::text = s.scope_type
where s.scope_type <> 'BRANCH';

-- C-04 · the 583 rows held by the twin identity now resolve to the surviving
-- person. If that creates an overlap the trigger raises; the runner catches it
-- and writes the row below rather than aborting the migration.
create table if not exists stg.coverage_rejected (
  at timestamptz not null default now(), person_email text, role text,
  scope_type text, scope_ref text, sheet_ref text, reason text
);
comment on table stg.coverage_rejected is
  'Rule C-04. Every coverage row the overlap trigger refused, with the rule that already owns the branches. Reviewed by Operations before cut-over.';
