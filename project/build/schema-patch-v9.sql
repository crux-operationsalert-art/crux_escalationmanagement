-- =====================================================================
-- CRUX — schema patch v9: sample data, tagged and removable in one action
--
-- Built to the rule the Data setup screen already states:
--   "Sample data fills only what the workbook could not answer. Every
--    placeholder is tagged at the row, so it can be counted here and removed
--    in one action — nothing the tracker actually said is touched."
--   Purge: "Tagged rows only — nothing real is touched."
--
-- Why a registry rather than a flag column on ninety tables: the purge has to
-- be able to prove it deleted only what it created. sample_row holds the exact
-- table and id of every seeded row, so sample_purge() can never reach a row it
-- did not put there — even one that looks like a placeholder.
--
-- Two deliberate safety properties in the data itself:
--   · every sample address is @example.invalid, a TLD reserved by RFC 2606 and
--     guaranteed never to resolve, so the outbox cannot deliver a sample
--     notification to a real person
--   · every sample name, code and reference is prefixed, so a placeholder is
--     recognisable on screen without looking it up
--
-- NOT seeded: holidays. A sample holiday is not inert — the clock consumes it,
-- shortening real TATs and firing real penalties. Only the three statutory
-- national days are loaded (patch v8), and the rest come through the uploader.
-- Run after schema-patch-v8.sql.
-- =====================================================================

create table if not exists sample_row (
  table_name text not null,
  row_id     uuid not null,
  seeded_at  timestamptz not null default now(),
  primary key (table_name, row_id)
);
comment on table sample_row is
  'One row per seeded placeholder. The purge deletes exactly these and nothing '
  'else, so it cannot reach real data even by accident.';

alter table sample_row enable row level security;
alter table sample_row force row level security;

create or replace function sample_tag(p_table text, p_id uuid) returns uuid
language sql set search_path = public as $$
  insert into sample_row (table_name, row_id) values (p_table, p_id)
  on conflict do nothing
  returning row_id
$$;

-- ------------------------------------------------------------- the count
-- What the Sample data tab shows: "N placeholder rows or fields".
create or replace function sample_count()
returns table (table_name text, rows bigint)
language sql stable set search_path = public as $$
  select s.table_name, count(*) from sample_row s
  group by s.table_name order by s.table_name
$$;

-- -------------------------------------------------------------- the seed
-- A small but complete organisation: enough that every screen has something
-- true to show, and few enough that it is obviously not the real company.
create or replace function sample_seed(p_actor uuid default null)
returns table (table_name text, rows bigint)
language plpgsql set search_path = public as $$
declare
  d_ops uuid; d_hr uuid;
  c_md uuid; c_ops uuid; c_rm uuid; c_bm uuid; c_ex uuid;
  p_md uuid; p_ops uuid; p_rm uuid; p_bm uuid; p_ex1 uuid; p_ex2 uuid;
  cl_a uuid; cl_b uuid;
  br_1 uuid; br_2 uuid; br_3 uuid;
  g_city uuid; g_state uuid;
  cat uuid; case_1 uuid;
  k_bm uuid; k_ex uuid;
  cyc uuid; lvl int;
  period date := date_trunc('month', current_date)::date;
begin
  if exists (select 1 from sample_row) then
    raise exception 'sample data is already loaded; purge it first';
  end if;

  -- geography: reuse the real tree rather than inventing places
  select id into g_city from geo_node where level = 'CITY' order by name limit 1;
  select id into g_state from geo_node where level = 'STATE' order by name limit 1;

  -- people first: a desk needs somebody to own it
  insert into person (full_name, employee_no, work_email, mobile, department, app_role, source_ref)
  values ('Sample: Meera Nair','SMP-0001','sample.md@example.invalid','9000000001','MD Office','ADMIN','SAMPLE')
  returning id into p_md;
  insert into person (full_name, employee_no, work_email, mobile, department, app_role, manager_id, source_ref)
  values ('Sample: Arjun Rao','SMP-0002','sample.ops@example.invalid','9000000002','Operations','MANAGER',p_md,'SAMPLE')
  returning id into p_ops;
  insert into person (full_name, employee_no, work_email, mobile, department, app_role, manager_id, source_ref)
  values ('Sample: Kavita Iyer','SMP-0003','sample.rm@example.invalid','9000000003','Operations','MANAGER',p_ops,'SAMPLE')
  returning id into p_rm;
  insert into person (full_name, employee_no, work_email, mobile, department, app_role, manager_id, source_ref)
  values ('Sample: Rohit Sharma','SMP-0004','sample.bm@example.invalid','9000000004','Operations','MANAGER',p_rm,'SAMPLE')
  returning id into p_bm;
  insert into person (full_name, employee_no, work_email, mobile, department, app_role, manager_id, source_ref)
  values ('Sample: Neha Joshi','SMP-0005','sample.ex1@example.invalid','9000000005','Operations','VIEWER',p_bm,'SAMPLE')
  returning id into p_ex1;
  insert into person (full_name, employee_no, work_email, mobile, department, app_role, manager_id, employee_type, source_ref)
  values ('Sample: Imran Qureshi','SMP-0006','sample.ex2@example.invalid','9000000006','Operations','VIEWER',p_bm,'PARTNER','SAMPLE')
  returning id into p_ex2;
  perform sample_tag('person', x) from unnest(array[p_md,p_ops,p_rm,p_bm,p_ex1,p_ex2]) x;

  insert into desk (name, primary_person_id) values ('Sample Operations desk', p_ops) returning id into d_ops;
  insert into desk (name, primary_person_id) values ('Sample HR desk', p_md) returning id into d_hr;
  perform sample_tag('desk', x) from unnest(array[d_ops,d_hr]) x;

  -- the chair spine, which is what authority resolves through
  insert into chair (code,title,level,desk_id) values ('SMP_MD','Sample Managing Director','board',d_hr) returning id into c_md;
  insert into chair (code,title,level,desk_id,parent_id) values ('SMP_OPS','Sample Operations Head','function',d_ops,c_md) returning id into c_ops;
  insert into chair (code,title,level,desk_id,parent_id) values ('SMP_RM','Sample Regional Manager','region',d_ops,c_ops) returning id into c_rm;
  insert into chair (code,title,level,desk_id,parent_id,reports_daily) values ('SMP_BM','Sample Branch Manager','branch',d_ops,c_rm,true) returning id into c_bm;
  insert into chair (code,title,level,desk_id,parent_id,reports_daily) values ('SMP_EX','Sample Executive','executive',d_ops,c_bm,true) returning id into c_ex;
  perform sample_tag('chair', x) from unnest(array[c_md,c_ops,c_rm,c_bm,c_ex]) x;

  insert into chair_holder (chair_id,person_id,is_primary) values
   (c_md,p_md,true),(c_ops,p_ops,true),(c_rm,p_rm,true),(c_bm,p_bm,true),(c_ex,p_ex1,true);
  perform sample_tag('chair_holder', id) from chair_holder
   where chair_id in (c_md,c_ops,c_rm,c_bm,c_ex);

  -- clients and branches: names nobody could mistake for a real client
  insert into client (code,name,source_ref) values ('SMP-A','Sample Client Alpha','SAMPLE') returning id into cl_a;
  insert into client (code,name,source_ref) values ('SMP-B','Sample Client Beta','SAMPLE') returning id into cl_b;
  perform sample_tag('client', x) from unnest(array[cl_a,cl_b]) x;

  insert into branch (client_id,code,name,geo_node_id,source_ref)
  values (cl_a,'SMP-A-001','Sample Branch One',g_city,'SAMPLE') returning id into br_1;
  insert into branch (client_id,code,name,geo_node_id,source_ref)
  values (cl_a,'SMP-A-002','Sample Branch Two',g_city,'SAMPLE') returning id into br_2;
  insert into branch (client_id,code,name,geo_node_id,source_ref)
  values (cl_b,'SMP-B-001','Sample Branch Three',g_city,'SAMPLE') returning id into br_3;
  perform sample_tag('branch', x) from unnest(array[br_1,br_2,br_3]) x;

  -- a complete five-level matrix on one branch, so dispatch eligibility is
  -- demonstrably true somewhere and demonstrably false elsewhere
  for lvl in 1..5 loop
    insert into matrix_contact (client_id,branch_id,level,level_name,name,email,mobile,source_ref)
    values (cl_a, br_1, lvl, 'Level ' || lvl, 'Sample Contact L' || lvl,
            'sample.l' || lvl || '@example.invalid', '900000010' || lvl, 'SAMPLE');
  end loop;
  perform sample_tag('matrix_contact', id) from matrix_contact where branch_id = br_1;

  -- coverage: this is what makes any of it visible to anybody
  insert into coverage_rule (person_id, role, scope_type, client_id, source_ref)
  values (p_bm,'BRANCH_MANAGER','CLIENT',cl_a,'SAMPLE');
  insert into coverage_rule (person_id, role, scope_type, client_id, source_ref)
  values (p_rm,'ZONAL_MANAGER','CLIENT',cl_b,'SAMPLE');
  perform sample_tag('coverage_rule', id) from coverage_rule where source_ref = 'SAMPLE';

  insert into category (name, desk_id, chase_hours) values ('Sample: Service quality', d_ops, 24)
  returning id into cat;
  perform sample_tag('category', cat);

  insert into "case" (ref,client_id,branch_id,category_id,raised_by,against_person_id,
                      description,desk_id,status,next_chase_at,source_ref)
  values ('SMP-ESC-0001',cl_a,br_1,cat,p_rm,p_bm,
          'Sample escalation: response not received within the agreed window.',
          d_ops,'OPEN', working_hours_after(now(), 24),'SAMPLE')
  returning id into case_1;
  perform sample_tag('case', case_1);
  insert into escalation_party (case_id,person_id,part) values (case_1,p_rm,'RAISER'),(case_1,p_bm,'RESPONDENT');

  -- KPIs, targets and an open appraisal cycle so the PMS screens compute
  insert into kpi_definition (chair_id,name,unit) values (c_bm,'Sample: Cases closed','count') returning id into k_bm;
  insert into kpi_definition (chair_id,name,unit) values (c_ex,'Sample: Verifications completed','count') returning id into k_ex;
  perform sample_tag('kpi_definition', x) from unnest(array[k_bm,k_ex]) x;

  insert into kpi_target (kpi_id,person_id,period,target_value,set_by)
  values (k_bm,p_bm,to_char(period,'YYYY-MM'),120,p_rm),
         (k_ex,p_ex1,to_char(period,'YYYY-MM'),300,p_bm);
  perform sample_tag('kpi_target', id) from kpi_target where kpi_id in (k_bm,k_ex);

  insert into pms_cycle (person_id, chair_id, period, state) values (p_bm,c_bm,period,'PENDING')
  returning id into cyc;
  perform sample_tag('pms_cycle', cyc);
  insert into pms_component (cycle_id,kind,raw,weight_pct) values (cyc,'KPI',7,70),(cyc,'ATTRIBUTE',6,30);
  perform sample_tag('pms_component', id) from pms_component where cycle_id = cyc;

  insert into pms_cycle (person_id, chair_id, period, state) values (p_ex1,c_ex,period,'PENDING')
  returning id into cyc;
  perform sample_tag('pms_cycle', cyc);
  insert into pms_component (cycle_id,kind,raw,weight_pct) values (cyc,'KPI',8,70),(cyc,'ATTRIBUTE',7,30);
  perform sample_tag('pms_component', id) from pms_component where cycle_id = cyc;

  -- rates: round numbers against sample clients only, so a placeholder can
  -- never be mistaken for an agreed commercial rate
  insert into rate (code,client_id,scope,value,effective_from,reason,created_by)
  values ('SMP-RATE-001',cl_a,'client',100.00,date_trunc('year',current_date)::date,'Sample placeholder rate',p_actor),
         ('SMP-RATE-002',cl_b,'client',150.00,date_trunc('year',current_date)::date,'Sample placeholder rate',p_actor);
  perform sample_tag('rate', id) from rate where code like 'SMP-RATE-%';

  insert into penalty_rule (code,what,plain_language,applies_to,frequency,cutoff_spec,amount,recovered_by,created_by)
  values ('SMP-P-01','Daily count not filed','File your daily numbers before the day closes at 23:59.',
          'ALL','DAILY','23:59 same day',200,'HR',p_actor);
  perform sample_tag('penalty_rule', id) from penalty_rule where code = 'SMP-P-01';

  insert into business_record (period,business_date,client_id,geo_node_id,owner_id,mtd,day10,target,revenue,source_ref)
  values (to_char(period,'YYYY-MM'),current_date,cl_a,g_city,p_bm,820,260,1000,82000,'SAMPLE'),
         (to_char(period,'YYYY-MM'),current_date,cl_b,g_city,p_rm,410,150,600,61500,'SAMPLE');
  perform sample_tag('business_record', id) from business_record where source_ref = 'SAMPLE';

  return query select * from sample_count();
end $$;

-- ------------------------------------------------------------- the purge
-- Deletes exactly the registered rows, children before parents, and nothing
-- else. Counts what it removed so the screen can say so.
create or replace function sample_purge()
returns table (table_name text, removed bigint)
language plpgsql set search_path = public as $$
declare
  t text;
  n bigint;
  -- reverse dependency order
  order_list text[] := array[
    'business_record','penalty_rule','rate',
    'pms_component','pms_cycle','kpi_target','kpi_definition',
    'case','category','coverage_rule','matrix_contact',
    'branch','client','chair_holder','chair','desk','person'
  ];
begin
  create temp table _purged (table_name text, removed bigint) on commit drop;

  foreach t in array order_list loop
    -- escalation_party and pms_adjustment hang off cascades or are removed
    -- with their parent; anything else registered is deleted by id
    if t = 'case' then
      delete from escalation_party where case_id in
        (select row_id from sample_row where table_name = 'case');
      delete from case_event where case_id in
        (select row_id from sample_row where table_name = 'case');
    elsif t = 'pms_cycle' then
      delete from pms_adjustment where cycle_id in
        (select row_id from sample_row where table_name = 'pms_cycle');
    elsif t = 'rate' then
      delete from rate_location where rate_id in
        (select row_id from sample_row where table_name = 'rate');
    end if;

    execute format(
      'delete from %I where id in (select row_id from sample_row where table_name = %L)', t, t);
    get diagnostics n = row_count;
    insert into _purged values (t, n);
    delete from sample_row s where s.table_name = t;
  end loop;

  return query select p.table_name, p.removed from _purged p where p.removed > 0
               order by p.table_name;
end $$;

comment on function sample_purge is
  'Removes every tagged placeholder in one action and nothing else. A row the '
  'seed did not create is not in sample_row, so the purge cannot reach it.';
