-- =====================================================================
-- 30 · CLIENTS AND BRANCHES — 28 clients, 1,413 real branches out of 101,330
-- staged rows. Rules:
--   B-01 a branch is real only if code or name is present
--   B-02 the 217 code-less branches get a synthetic code and a review row
--   B-03 the Dublicate column (634×1, 390×2) is a claim, not a fact — we
--        re-derive duplicates from (client, normalised name, city)
--   B-04 status maps to 722 ACTIVE / 691 INACTIVE and must reconcile
-- =====================================================================

insert into client (code, name, status, source_ref)
select btrim(c.code), stg.norm_name(c.name),
       case when upper(coalesce(c.status,'ACTIVE')) = 'INACTIVE' then 'INACTIVE' else 'ACTIVE' end::entity_status,
       'CLIENTS!' || c.row_no
from stg.clients c where stg.present(c.code)
on conflict (code) do nothing;

insert into client_contact (client_id, kind, email)
select cl.id, k.kind, stg.norm_email(k.email)
from stg.clients c join client cl on cl.code = btrim(c.code)
cross join lateral (values ('PRIMARY', c.primary_email), ('CC', c.cc_email),
                           ('HEAD_OFFICE', c.ho_email), ('HEAD_OFFICE_CC', c.ho_cc_email)) k(kind, email)
where stg.present(k.email)
on conflict do nothing;

-- client zones keep the client's own vocabulary and point at our geography
insert into client_zone (client_id, name, geo_node_id)
select distinct cl.id, stg.norm_name(b.zone), null::uuid
from stg.branches b join client cl on cl.code = btrim(b.client_code)
where stg.present(b.zone)
on conflict do nothing;

update client_zone cz set geo_node_id = g.id
from geo_node g
where g.level = 'STATE' and lower(g.name) = lower(cz.name) and cz.geo_node_id is null;

-- B-01/B-02/B-03 · one pass, duplicates resolved by completeness then recency
create temp table branch_pick as
with real_rows as (
  select b.*, cl.id as client_uuid,
         (case when stg.present(b.code) then 0 else 1 end) as no_code,
         ( (stg.present(b.name))::int + (stg.present(b.address))::int
         + (stg.present(b.bm_name))::int + (stg.present(b.bm_mobile))::int
         + (stg.present(b.bm_email))::int + (stg.present(b.city))::int ) as fill_score
  from stg.branches b join client cl on cl.code = btrim(b.client_code)
  where stg.present(b.code) or stg.present(b.name)
), keyed as (
  select *, coalesce(nullif(btrim(code),''),
              'GEN-' || lpad(row_number() over (partition by client_uuid, (case when stg.present(code) then 0 else 1 end)
                                                order by row_no)::text, 4, '0')) as final_code,
         row_number() over (partition by client_uuid, lower(coalesce(nullif(btrim(code),''), stg.norm_name(name) || '|' || coalesce(stg.norm_name(city),'')))
                            order by fill_score desc, stg.ts(updated_at) desc nulls last, row_no) as rn
  from real_rows
)
select * from keyed;

insert into branch (client_id, code, name, address, geo_node_id, client_zone_id, status, notes, source_ref)
select p.client_uuid, p.final_code, coalesce(stg.norm_name(p.name), p.final_code), nullif(btrim(p.address),''),
       g.id, cz.id,
       case when upper(coalesce(p.status,'ACTIVE')) in ('INACTIVE','CLOSED') then 'INACTIVE' else 'ACTIVE' end::entity_status,
       case when p.no_code = 1 then 'Code synthesised during migration — confirm the real branch code.' end,
       'BRANCHES!' || p.row_no
from branch_pick p
left join geo_node g on g.level = 'CITY' and lower(g.name) = lower(btrim(p.city))
left join client_zone cz on cz.client_id = p.client_uuid and lower(cz.name) = lower(btrim(p.zone))
where p.rn = 1
on conflict (client_id, code) do nothing;

-- B-02 receipt
insert into migration_review (entity_type, entity_ref, question, context)
select 'branch', 'BRANCHES!' || p.row_no, 'Branch had no code — synthetic code ' || p.final_code || ' assigned. Confirm or replace.',
       concat_ws(' | ', p.name, p.address, p.city)
from branch_pick p where p.rn = 1 and p.no_code = 1;

-- B-03 receipt · every collapsed duplicate, with the row that won
insert into migration_merge (entity_type, kept_id, merged_key, rows_moved, rule)
select 'branch', b.id, 'BRANCHES!' || d.row_no, 1,
       'B-03 duplicate collapsed by fill score then recency (sheet Dublicate=' || coalesce(nullif(btrim(d.dublicate),''),'blank') || ')'
from branch_pick d
join branch_pick k on k.client_uuid = d.client_uuid and k.rn = 1
  and lower(coalesce(nullif(btrim(k.code),''), stg.norm_name(k.name) || '|' || coalesce(stg.norm_name(k.city),'')))
    = lower(coalesce(nullif(btrim(d.code),''), stg.norm_name(d.name) || '|' || coalesce(stg.norm_name(d.city),'')))
join branch b on b.client_id = k.client_uuid and b.code = k.final_code
where d.rn > 1;

-- branch manager and Crux POC, internal people referenced not copied
insert into branch_contact (branch_id, role, person_id, name, mobile, email)
select b.id, 'BRANCH_MANAGER', coalesce(p.superseded_by, p.id), stg.norm_name(k.bm_name),
       stg.norm_mobile(k.bm_mobile), stg.norm_email(k.bm_email)
from branch_pick k
join branch b on b.client_id = k.client_uuid and b.code = k.final_code
left join person p on p.work_email = stg.norm_email(k.bm_email)
where k.rn = 1 and (stg.present(k.bm_name) or stg.present(k.bm_email))
on conflict do nothing;

insert into branch_contact (branch_id, role, person_id, name, email)
select b.id, 'CRUX_POC', coalesce(p.superseded_by, p.id), p.full_name, p.work_email
from branch_pick k
join branch b on b.client_id = k.client_uuid and b.code = k.final_code
join person p on p.work_email = stg.norm_email(k.poc_email)
where k.rn = 1
on conflict do nothing;
