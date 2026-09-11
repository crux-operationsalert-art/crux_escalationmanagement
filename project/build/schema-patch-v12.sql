-- =====================================================================
-- CRUX — schema patch v12
-- The remaining bulk-upload loaders, and the gaps they exposed.
--
-- v8 shipped two loaders (Holidays, Rates) and eight placeholders that
-- validated nothing and loaded nothing. This finishes them, and adds an
-- eleventh kind the design needed but nobody had written:
--
--   Chairs — the People template says the chair "must already exist", and
--   nothing in the system could create one. A person could not be loaded
--   at all. Chairs now load first, and a chair may report to another chair
--   created by the same file.
--
-- Three real defects turned up while loading against it, all of them the
-- kind that corrupt quietly rather than fail loudly:
--
--   · ua_rates joined each inserted rate to every row of the file sharing
--     a client and an effective_from, so a rate for one zone was attached
--     to all of that client's zones. Northern Bank's Pune, Mumbai and
--     Delhi rates each resolved at all three locations. Now one row at a
--     time, correlated by row.
--   · geo_node was matched by name alone in three places. A location that
--     exists as both a ZONE and a CITY matched twice, and every such row
--     loaded twice. Now ZONE only, in both the validators and the loaders.
--   · upload_apply_audited reported every check violation as "has_errors",
--     so a constraint the loader itself broke was reported to the person
--     as a problem with their file. It now says which it is.
--
-- Two columns were added rather than let a template ask for something with
-- nowhere to go: geo_node.group_name/region, and coverage_rule.product.
--
-- Run after schema-patch-v11.sql.
-- =====================================================================

create extension if not exists fuzzystrmatch with schema extensions;

alter table geo_node      add column if not exists group_name text;
alter table geo_node      add column if not exists region text;
alter table coverage_rule add column if not exists product text;

comment on column geo_node.group_name is
  'Optional grouping above region, as loaded. Free text; no routing depends on it.';
comment on column coverage_rule.product is
  'Optional product the rule is limited to. Blank means every product for that '
  'client at that location.';

-- ------------------------------------------------------------ the kinds
insert into upload_kind (kind, load_order, needs, implemented)
values ('Chairs', 1, 'The chair structure: code, title, level and who each chair reports to.', true)
on conflict (kind) do nothing;

-- load_order is unique, so it has to move out of the way before it moves back
update upload_kind set load_order = -load_order;
update upload_kind set load_order = case kind
  when 'Chairs' then 1  when 'People' then 2
  when 'Geography' then 3  when 'Clients and branches' then 4
  when 'Assignments' then 5  when 'Rates' then 6
  when 'Collections' then 7  when 'KPI targets' then 8
  when 'Past performance' then 9  when 'Opening balances' then 10
  when 'Holidays' then 11 end;
update upload_kind set implemented = true;

-- ---------------------------------------------------------- the columns
-- What each loader reads, and the rule for every column. This lived in the
-- hosted shell, where adding a kind meant redeploying it. It belongs here.
create table if not exists upload_column (
  kind    text not null references upload_kind(kind) on delete cascade,
  ord     int  not null,
  name    text not null,
  example text not null default '',
  rule    text not null default '',
  primary key (kind, ord)
);
comment on table upload_column is
  'The columns each loader reads, with the rule for every one. Lives here '
  'rather than in the hosted shell so a new kind needs no redeploy.';
alter table upload_column enable row level security;
alter table upload_column force row level security;
revoke all on upload_column from anon, authenticated;

-- (seed rows for all eleven kinds are in schema-patch-v12-columns.sql)

create or replace function csv_cell(v text) returns text
language sql immutable as $fn$
  select case when v is null then ''
              when v ~ '[",\n]' then '"' || replace(v, '"', '""') || '"'
              else v end
$fn$;

create or replace function upload_template(p_kind text)
returns text language plpgsql stable security definer set search_path = public as $fn$
declare v_csv text;
begin
  if not exists (select 1 from upload_column where kind = p_kind) then return null; end if;
  select string_agg(line, E'\n' order by ord) into v_csv from (
    select 0 as ord, 'Crux bulk upload template,' || csv_cell(p_kind) as line
    union all select 1, 'Row below the header is an example - delete it before uploading.'
    union all select 2, 'A file with any error applies zero rows.'
    union all select 3, ''
    union all select 4, (select string_agg(csv_cell(name), ',' order by ord) from upload_column where kind = p_kind)
    union all select 5, (select string_agg(csv_cell(example), ',' order by ord) from upload_column where kind = p_kind)
    union all select 6, ''
    union all select 7, 'NOTES'
    union all select 8, (select string_agg(csv_cell(name) || ',' || csv_cell(rule), E'\n' order by ord)
                           from upload_column where kind = p_kind)
  ) s;
  return v_csv;
end $fn$;

-- ------------------------------------------------------------- helpers
create or replace function ul_txt(r jsonb, k text) returns text
  language sql immutable as $fn$ select nullif(btrim(r->>k), '') $fn$;

create or replace function is_ym(p text) returns boolean
language sql immutable as $fn$
  select p is not null and p ~ '^\d{4}-(0[1-9]|1[0-2])$'
$fn$;

-- =====================================================================
-- Validators. One per kind, dispatched by upload_validate.
-- Each sets upload_row.error; none of them writes to a master table.
-- =====================================================================

create or replace function uv_chairs(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'chair_code') is null then 'chair_code is required' end,
      case when ul_txt(r2.raw,'title') is null then 'title is required' end,
      case when lower(coalesce(ul_txt(r2.raw,'level'),'')) not in
                ('board','function','region','branch','executive','admin')
           then 'level must be board, function, region, branch, executive or admin' end,
      case when ul_txt(r2.raw,'reports_to_chair_code') is not null
            and not exists (select 1 from chair c where c.code = ul_txt(r2.raw,'reports_to_chair_code'))
            and not exists (select 1 from upload_row r3 where r3.batch_id = p_batch
                              and ul_txt(r3.raw,'chair_code') = ul_txt(r2.raw,'reports_to_chair_code'))
           then 'reports_to_chair_code ' || ul_txt(r2.raw,'reports_to_chair_code') ||
                ' is neither in this file nor already in the structure' end,
      case when ul_txt(r2.raw,'reports_to_chair_code') = ul_txt(r2.raw,'chair_code')
           then 'a chair cannot report to itself' end,
      case when lower(coalesce(ul_txt(r2.raw,'reports_daily'),'no')) not in ('yes','no','true','false')
           then 'reports_daily must be yes or no' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate chair_code in this file'
    from (select id, row_number() over (partition by lower(ul_txt(raw,'chair_code')) order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function uv_people(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'employee_no') is null then 'employee_no is required' end,
      case when ul_txt(r2.raw,'full_name') is null then 'full_name is required' end,
      case when ul_txt(r2.raw,'work_email') is null then 'work_email is required'
           when ul_txt(r2.raw,'work_email') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
           then 'work_email is not a valid address' end,
      case when ul_txt(r2.raw,'mobile') is null then 'mobile is required'
           when regexp_replace(ul_txt(r2.raw,'mobile'), '[^0-9]', '', 'g') !~ '^[0-9]{10,13}$'
           then 'mobile must be 10 to 13 digits' end,
      case when ul_txt(r2.raw,'chair') is null then 'chair is required'
           when not exists (select 1 from chair c
                             where c.title = ul_txt(r2.raw,'chair')
                                or c.code  = ul_txt(r2.raw,'chair'))
           then 'chair ' || ul_txt(r2.raw,'chair') || ' does not exist - load Chairs first' end,
      case when ul_txt(r2.raw,'reports_to_employee_no') is not null
            and not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'reports_to_employee_no'))
            and not exists (select 1 from upload_row r3 where r3.batch_id = p_batch
                              and ul_txt(r3.raw,'employee_no') = ul_txt(r2.raw,'reports_to_employee_no'))
           then 'reports_to_employee_no ' || ul_txt(r2.raw,'reports_to_employee_no') ||
                ' is neither in this file nor already on the people master' end,
      case when ul_txt(r2.raw,'reports_to_employee_no') = ul_txt(r2.raw,'employee_no')
           then 'a person cannot report to themselves' end,
      case when ul_txt(r2.raw,'date_of_joining') is not null
            and not is_ymd(ul_txt(r2.raw,'date_of_joining'))
           then 'date_of_joining must be a real date, written YYYY-MM-DD' end,
      case when lower(coalesce(ul_txt(r2.raw,'employment_type'),'employee'))
                not in ('employee','partner','intern','contract')
           then 'employment_type must be Employee, Partner, Intern or Contract' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate employee_no in this file'
    from (select id, row_number() over (partition by lower(ul_txt(raw,'employee_no')) order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate work_email in this file'
    from (select id, row_number() over (partition by lower(ul_txt(raw,'work_email')) order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'work_email already belongs to another person'
    from upload_row r2
   where r.id = r2.id and r2.batch_id = p_batch and r2.error is null
     and exists (select 1 from person p
                  where lower(p.work_email) = lower(ul_txt(r2.raw,'work_email'))
                    and p.employee_no is distinct from ul_txt(r2.raw,'employee_no'));

  -- The near-duplicate domain check. A misspelt domain is one edit away from
  -- the one everybody else uses, and it is how the old system ended up with a
  -- second person holding 583 coverage rows.
  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'work_email domain ' || split_part(ul_txt(r.raw,'work_email'),'@',2) ||
         ' looks like a misspelling of ' || m.common_domain ||
         ' - correct it, or load it alone if it is genuinely a different domain'
    from (
      select (select lower(split_part(ul_txt(x.raw,'work_email'),'@',2)) as d
                from upload_row x where x.batch_id = p_batch and x.error is null
               group by 1 order by count(*) desc, 1 limit 1) as common_domain
    ) m
   where r.batch_id = p_batch and r.error is null
     and m.common_domain is not null
     and lower(split_part(ul_txt(r.raw,'work_email'),'@',2)) <> m.common_domain
     and extensions.levenshtein(lower(split_part(ul_txt(r.raw,'work_email'),'@',2)), m.common_domain) between 1 and 2;
end $fn$;

create or replace function uv_geography(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'zone') is null then 'zone is required' end,
      case when ul_txt(r2.raw,'region') is not null
            and lower(ul_txt(r2.raw,'region')) not in
                ('east','west','north','south','central','north-east','north east')
           then 'region must be East, West, North, South, Central or North-East' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate zone in this file'
    from (select id, row_number() over (partition by lower(ul_txt(raw,'zone')) order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function uv_clients(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'client_code') is null then 'client_code is required' end,
      case when ul_txt(r2.raw,'client_name') is null then 'client_name is required' end,
      case when ul_txt(r2.raw,'branch_code') is null then 'branch_code is required' end,
      case when ul_txt(r2.raw,'branch_name') is null then 'branch_name is required' end,
      case when ul_txt(r2.raw,'zone') is null then 'zone is required'
           when not exists (select 1 from geo_node g
                             where g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r2.raw,'zone')))
           then 'zone ' || ul_txt(r2.raw,'zone') || ' does not exist - load Geography first' end,
      case when upper(coalesce(ul_txt(r2.raw,'status'),'ACTIVE')) not in ('ACTIVE','INACTIVE')
           then 'status must be ACTIVE or INACTIVE' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'duplicate branch_code for this client in this file'
    from (select id, row_number() over (
              partition by lower(ul_txt(raw,'client_code')), lower(ul_txt(raw,'branch_code'))
              order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;

  -- one client_code must mean one client. Two names under one code is the
  -- shape of a typo, and it silently splits a client's history.
  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'client_code ' || ul_txt(r.raw,'client_code') || ' is used with more than one client_name in this file'
    from (select lower(ul_txt(raw,'client_code')) as cc
            from upload_row where batch_id = p_batch and error is null
           group by 1 having count(distinct lower(ul_txt(raw,'client_name'))) > 1) x
   where r.batch_id = p_batch and r.error is null
     and lower(ul_txt(r.raw,'client_code')) = x.cc;
end $fn$;

create or replace function uv_assignments(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'client_code') is null then 'client_code is required'
           when not exists (select 1 from client c where c.code = ul_txt(r2.raw,'client_code'))
           then 'client_code ' || ul_txt(r2.raw,'client_code') || ' does not exist - load Clients first' end,
      case when ul_txt(r2.raw,'zone') is null then 'zone is required'
           when not exists (select 1 from geo_node g where g.level='ZONE' and lower(g.name)=lower(ul_txt(r2.raw,'zone')))
           then 'zone ' || ul_txt(r2.raw,'zone') || ' does not exist - load Geography first' end,
      case when ul_txt(r2.raw,'handler_employee_no') is null then 'handler_employee_no is required'
           when not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'handler_employee_no'))
           then 'handler_employee_no ' || ul_txt(r2.raw,'handler_employee_no') || ' is not on the people master - load People first' end,
      case when ul_txt(r2.raw,'location_head_employee_no') is not null
            and not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'location_head_employee_no'))
           then 'location_head_employee_no ' || ul_txt(r2.raw,'location_head_employee_no') || ' is not on the people master' end,
      case when ul_txt(r2.raw,'effective_from') is null then 'effective_from is required'
           when not is_ymd(ul_txt(r2.raw,'effective_from')) then 'effective_from must be a real date, written YYYY-MM-DD' end,
      case when ul_txt(r2.raw,'effective_to') is not null and not is_ymd(ul_txt(r2.raw,'effective_to'))
           then 'effective_to must be a real date, written YYYY-MM-DD, or left blank' end,
      case when is_ymd(ul_txt(r2.raw,'effective_from')) and is_ymd(ul_txt(r2.raw,'effective_to'))
            and ul_txt(r2.raw,'effective_to')::date <= ul_txt(r2.raw,'effective_from')::date
           then 'effective_to must be after effective_from' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  -- two rows in this file covering the same client, zone and product at once
  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'overlaps another row in this file for the same client, zone and product'
    from (
      select a.id from upload_row a join upload_row b
        on a.batch_id = b.batch_id and a.id <> b.id
       and ul_txt(a.raw,'client_code') = ul_txt(b.raw,'client_code')
       and lower(ul_txt(a.raw,'zone')) = lower(ul_txt(b.raw,'zone'))
       and coalesce(lower(ul_txt(a.raw,'product')),'') = coalesce(lower(ul_txt(b.raw,'product')),'')
       and daterange(ul_txt(a.raw,'effective_from')::date, ul_txt(a.raw,'effective_to')::date, '[)')
        && daterange(ul_txt(b.raw,'effective_from')::date, ul_txt(b.raw,'effective_to')::date, '[)')
      where a.batch_id = p_batch and a.error is null and b.error is null
    ) o where r.id = o.id;

  -- and against what is already covered, so the overlap trigger never has to
  -- abort the whole file to say so
  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'overlaps a coverage rule that already exists for this client and zone'
    from upload_row r2
    join client c   on c.code = ul_txt(r2.raw,'client_code')
    join geo_node g on g.level='ZONE' and lower(g.name) = lower(ul_txt(r2.raw,'zone'))
   where r.id = r2.id and r2.batch_id = p_batch and r2.error is null
     and exists (
       select 1 from coverage_rule cr
        where cr.client_id = c.id and cr.geo_node_id = g.id
          and coalesce(lower(cr.product),'') = coalesce(lower(ul_txt(r2.raw,'product')),'')
          and cr.is_assigned_handler
          and daterange(cr.effective_from, cr.effective_to, '[)')
           && daterange(ul_txt(r2.raw,'effective_from')::date, ul_txt(r2.raw,'effective_to')::date, '[)'));
end $fn$;

create or replace function uv_collections(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'period') is null then 'period is required'
           when not is_ym(ul_txt(r2.raw,'period')) then 'period must be a month, written YYYY-MM' end,
      case when ul_txt(r2.raw,'client_code') is null then 'client_code is required'
           when not exists (select 1 from client c where c.code = ul_txt(r2.raw,'client_code'))
           then 'client_code ' || ul_txt(r2.raw,'client_code') || ' does not exist - load Clients first' end,
      case when ul_txt(r2.raw,'zone') is null then 'zone is required'
           when not exists (select 1 from geo_node g where g.level='ZONE' and lower(g.name)=lower(ul_txt(r2.raw,'zone')))
           then 'zone ' || ul_txt(r2.raw,'zone') || ' does not exist - load Geography first' end,
      case when ul_txt(r2.raw,'billed') is null then 'billed is required'
           when ul_txt(r2.raw,'billed') !~ '^\d+(\.\d{1,2})?$' then 'billed must be a non-negative number' end,
      case when ul_txt(r2.raw,'collected') is null then 'collected is required'
           when ul_txt(r2.raw,'collected') !~ '^\d+(\.\d{1,2})?$' then 'collected must be a non-negative number' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'duplicate client, zone and month in this file'
    from (select id, row_number() over (
            partition by lower(ul_txt(raw,'client_code')), lower(ul_txt(raw,'zone')), ul_txt(raw,'period')
            order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function uv_kpi_targets(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'period') is null then 'period is required'
           when not is_ym(ul_txt(r2.raw,'period')) then 'period must be a month, written YYYY-MM' end,
      case when ul_txt(r2.raw,'employee_no') is null then 'employee_no is required'
           when not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'employee_no'))
           then 'employee_no ' || ul_txt(r2.raw,'employee_no') || ' is not on the people master - load People first' end,
      case when ul_txt(r2.raw,'kpi_name') is null then 'kpi_name is required' end,
      case when ul_txt(r2.raw,'target') is null then 'target is required'
           when ul_txt(r2.raw,'target') !~ '^\d+(\.\d+)?$' then 'target must be a non-negative number' end,
      case when ul_txt(r2.raw,'unit') is not null
            and lower(ul_txt(r2.raw,'unit')) not in ('count','%','score','inr lakh','rs lakh','lakh')
            and ul_txt(r2.raw,'unit') <> ''
           then 'unit must be count, %, score or a lakh unit' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'duplicate person, KPI, sub-category and month in this file'
    from (select id, row_number() over (
            partition by lower(ul_txt(raw,'employee_no')), lower(ul_txt(raw,'kpi_name')),
                         coalesce(lower(ul_txt(raw,'sub_category')),''), ul_txt(raw,'period')
            order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;

  -- "Sub-category targets must add up to the KPI target" - the template says
  -- so, so the file has to be held to it.
  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'sub-category targets for this KPI add up to ' || s.kids ||
         ', but the KPI target is ' || s.parent
    from (
      select lower(ul_txt(raw,'employee_no')) en, lower(ul_txt(raw,'kpi_name')) kn,
             ul_txt(raw,'period') pr,
             sum(case when ul_txt(raw,'sub_category') is null then 0 else ul_txt(raw,'target')::numeric end) kids,
             max(case when ul_txt(raw,'sub_category') is null then ul_txt(raw,'target')::numeric end) parent
        from upload_row where batch_id = p_batch and error is null
       group by 1,2,3
      having max(case when ul_txt(raw,'sub_category') is null then ul_txt(raw,'target')::numeric end) is not null
         and sum(case when ul_txt(raw,'sub_category') is null then 0 else ul_txt(raw,'target')::numeric end) > 0
         and sum(case when ul_txt(raw,'sub_category') is null then 0 else ul_txt(raw,'target')::numeric end)
             <> max(case when ul_txt(raw,'sub_category') is null then ul_txt(raw,'target')::numeric end)
    ) s
   where r.batch_id = p_batch and r.error is null
     and lower(ul_txt(r.raw,'employee_no')) = s.en
     and lower(ul_txt(r.raw,'kpi_name')) = s.kn
     and ul_txt(r.raw,'period') = s.pr;
end $fn$;

create or replace function uv_past_perf(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when lower(coalesce(ul_txt(r2.raw,'file_part'),'')) not in ('mtd','revenue','collections')
           then 'file_part must be mtd, revenue or collections' end,
      case when ul_txt(r2.raw,'period') is null then 'period is required'
           when not is_ym(ul_txt(r2.raw,'period')) then 'period must be a month, written YYYY-MM' end,
      case when lower(coalesce(ul_txt(r2.raw,'file_part'),'')) = 'mtd' then
        nullif(concat_ws('; ',
          case when ul_txt(r2.raw,'employee_no') is null then 'employee_no is required for mtd'
               when not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'employee_no'))
               then 'employee_no ' || ul_txt(r2.raw,'employee_no') || ' is not on the people master' end,
          case when ul_txt(r2.raw,'kpi_name') is null then 'kpi_name is required for mtd' end,
          case when ul_txt(r2.raw,'achieved') is null then 'achieved is required for mtd'
               when ul_txt(r2.raw,'achieved') !~ '^-?\d+(\.\d+)?$' then 'achieved must be a number' end,
          case when ul_txt(r2.raw,'mtd_achieved') is not null
                and ul_txt(r2.raw,'mtd_achieved') !~ '^-?\d+(\.\d+)?$' then 'mtd_achieved must be a number' end,
          case when ul_txt(r2.raw,'target') is not null
                and ul_txt(r2.raw,'target') !~ '^-?\d+(\.\d+)?$' then 'target must be a number' end
        ), '') end,
      case when lower(coalesce(ul_txt(r2.raw,'file_part'),'')) in ('revenue','collections') then
        nullif(concat_ws('; ',
          case when ul_txt(r2.raw,'client_code') is null then 'client_code is required for ' || lower(ul_txt(r2.raw,'file_part'))
               when not exists (select 1 from client c where c.code = ul_txt(r2.raw,'client_code'))
               then 'client_code ' || ul_txt(r2.raw,'client_code') || ' does not exist' end,
          case when ul_txt(r2.raw,'location_code') is null then 'location_code is required for ' || lower(ul_txt(r2.raw,'file_part'))
               when not exists (select 1 from geo_node g
                                 where g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r2.raw,'location_code')))
               then 'location_code ' || ul_txt(r2.raw,'location_code') || ' is not a zone - load Geography first' end,
          case when ul_txt(r2.raw,'owner_employee_no') is not null
                and not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'owner_employee_no'))
               then 'owner_employee_no ' || ul_txt(r2.raw,'owner_employee_no') || ' is not on the people master' end
        ), '') end,
      case when lower(coalesce(ul_txt(r2.raw,'file_part'),'')) = 'revenue' then
        nullif(concat_ws('; ',
          case when ul_txt(r2.raw,'invoiced_inr') is null then 'invoiced_inr is required for revenue'
               when ul_txt(r2.raw,'invoiced_inr') !~ '^\d+$' then 'invoiced_inr must be whole rupees, no commas' end,
          case when ul_txt(r2.raw,'realised_inr') is null then 'realised_inr is required for revenue'
               when ul_txt(r2.raw,'realised_inr') !~ '^\d+$' then 'realised_inr must be whole rupees, no commas' end
        ), '') end,
      case when lower(coalesce(ul_txt(r2.raw,'file_part'),'')) = 'collections' then
        nullif(concat_ws('; ',
          case when coalesce(ul_txt(r2.raw,'opening_outstanding_inr'),'') !~ '^\d+$' then 'opening_outstanding_inr must be whole rupees' end,
          case when coalesce(ul_txt(r2.raw,'collected_inr'),'') !~ '^\d+$' then 'collected_inr must be whole rupees' end,
          case when coalesce(ul_txt(r2.raw,'closing_outstanding_inr'),'') !~ '^\d+$' then 'closing_outstanding_inr must be whole rupees' end,
          case when ul_txt(r2.raw,'opening_outstanding_inr') ~ '^\d+$'
                and ul_txt(r2.raw,'collected_inr') ~ '^\d+$'
                and ul_txt(r2.raw,'closing_outstanding_inr') ~ '^\d+$'
                and ul_txt(r2.raw,'opening_outstanding_inr')::bigint - ul_txt(r2.raw,'collected_inr')::bigint
                    <> ul_txt(r2.raw,'closing_outstanding_inr')::bigint
               then 'opening minus collected must equal closing' end
        ), '') end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;
end $fn$;

create or replace function uv_opening(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when lower(coalesce(ul_txt(r2.raw,'record_type'),'')) not in ('escalation','ogl_assignment','claim')
           then 'record_type must be escalation, ogl_assignment or claim'
           when lower(ul_txt(r2.raw,'record_type')) = 'ogl_assignment'
           then 'ogl_assignment has no table in this schema yet - load escalation and claim now, and OGL once it exists' end,
      case when ul_txt(r2.raw,'reference') is null then 'reference is required' end,
      case when ul_txt(r2.raw,'created_at') is null then 'created_at is required'
           when ul_txt(r2.raw,'created_at') !~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$'
                or not is_ymd(left(ul_txt(r2.raw,'created_at'),10))
           then 'created_at must be a real date and time, written YYYY-MM-DDTHH:MM' end,
      case when ul_txt(r2.raw,'owner_employee_no') is null then 'owner_employee_no is required'
           when not exists (select 1 from person p where p.employee_no = ul_txt(r2.raw,'owner_employee_no'))
           then 'owner_employee_no ' || ul_txt(r2.raw,'owner_employee_no') || ' is not on the people master' end,
      case when lower(coalesce(ul_txt(r2.raw,'record_type'),'')) = 'escalation' then
        nullif(concat_ws('; ',
          case when upper(coalesce(ul_txt(r2.raw,'current_state'),'')) not in
                    ('OPEN','IN_PROGRESS','RESOLVED','CLOSED','BLOCKED')
               then 'current_state for an escalation must be OPEN, IN_PROGRESS, RESOLVED, CLOSED or BLOCKED' end,
          case when ul_txt(r2.raw,'client_code') is null then 'client_code is required for an escalation'
               when not exists (select 1 from client c where c.code = ul_txt(r2.raw,'client_code'))
               then 'client_code ' || ul_txt(r2.raw,'client_code') || ' does not exist' end
        ), '') end,
      case when lower(coalesce(ul_txt(r2.raw,'record_type'),'')) = 'claim' then
        nullif(concat_ws('; ',
          case when upper(coalesce(ul_txt(r2.raw,'current_state'),'')) not in
                    ('DRAFT','OPS_APPROVAL','HR_APPROVAL','ACCOUNTS','DISPUTED','PAID','REJECTED')
               then 'current_state for a claim must be DRAFT, OPS_APPROVAL, HR_APPROVAL, ACCOUNTS, DISPUTED, PAID or REJECTED' end,
          case when ul_txt(r2.raw,'amount') is not null and ul_txt(r2.raw,'amount') !~ '^\d+(\.\d{1,2})?$'
               then 'amount must be a non-negative number' end
        ), '') end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate reference in this file'
    from (select id, row_number() over (partition by lower(ul_txt(raw,'reference')) order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function uv_holidays(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'date') is null then 'date is required'
           when not is_ymd(ul_txt(r2.raw,'date')) then 'date must be a real date, written YYYY-MM-DD' end,
      case when ul_txt(r2.raw,'name') is null then 'name is required' end,
      case when lower(coalesce(r2.raw->>'confirmed','no')) not in ('yes','no','true','false','')
           then 'confirmed must be yes or no' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate date in this file'
    from (select id, row_number() over (partition by raw->>'date' order by row_no) rn
            from upload_row where batch_id = p_batch and error is null) d
   where r.id = d.id and d.rn > 1;
end $fn$;

create or replace function uv_rates(p_batch uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update upload_row r set error = e.msg from (
    select r2.id, nullif(concat_ws('; ',
      case when ul_txt(r2.raw,'client_code') is null then 'client_code is required'
           when not exists (select 1 from client c where c.code = ul_txt(r2.raw,'client_code'))
           then 'client_code ' || ul_txt(r2.raw,'client_code') || ' does not exist - load Clients first' end,
      case when ul_txt(r2.raw,'zone') is not null
            and not exists (select 1 from geo_node g
                             where g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r2.raw,'zone')))
           then 'zone ' || ul_txt(r2.raw,'zone') || ' does not exist - load Geography first' end,
      case when ul_txt(r2.raw,'rate') is null then 'rate is required'
           when ul_txt(r2.raw,'rate') !~ '^\d+(\.\d{1,2})?$'
           then 'rate must be a non-negative number with at most two decimals' end,
      case when ul_txt(r2.raw,'effective_from') is null then 'effective_from is required'
           when not is_ymd(ul_txt(r2.raw,'effective_from'))
           then 'effective_from must be a real date, written YYYY-MM-DD' end,
      case when ul_txt(r2.raw,'effective_to') is not null and not is_ymd(ul_txt(r2.raw,'effective_to'))
           then 'effective_to must be a real date, written YYYY-MM-DD, or left blank' end,
      case when is_ymd(ul_txt(r2.raw,'effective_to')) and is_ymd(ul_txt(r2.raw,'effective_from'))
            and ul_txt(r2.raw,'effective_to')::date <= ul_txt(r2.raw,'effective_from')::date
           then 'effective_to must be after effective_from' end
    ), '') as msg
    from upload_row r2 where r2.batch_id = p_batch
  ) e where r.id = e.id and e.msg is not null;

  update upload_row r set error = coalesce(r.error || '; ', '') ||
         'overlaps another row in this file for the same client and zone'
    from (
      select a.id from upload_row a join upload_row b
        on a.batch_id = b.batch_id and a.id <> b.id
       and ul_txt(a.raw,'client_code') = ul_txt(b.raw,'client_code')
       and coalesce(lower(ul_txt(a.raw,'zone')),'') = coalesce(lower(ul_txt(b.raw,'zone')),'')
       and daterange(ul_txt(a.raw,'effective_from')::date, ul_txt(a.raw,'effective_to')::date, '[)')
        && daterange(ul_txt(b.raw,'effective_from')::date, ul_txt(b.raw,'effective_to')::date, '[)')
      where a.batch_id = p_batch and a.error is null and b.error is null
    ) o where r.id = o.id;
end $fn$;

-- =====================================================================
-- Appliers. Reached only after upload_apply has confirmed the batch has
-- no errored row, so none of them re-checks the file.
-- =====================================================================

create or replace function ua_chairs(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  insert into chair (code, title, level, reports_daily)
  select ul_txt(raw,'chair_code'), ul_txt(raw,'title'), lower(ul_txt(raw,'level')),
         lower(coalesce(ul_txt(raw,'reports_daily'),'no')) in ('yes','true')
    from upload_row where batch_id = p_batch
  on conflict (code) do update
    set title = excluded.title, level = excluded.level, reports_daily = excluded.reports_daily;

  -- second pass: a chair can report to one created by the same file
  update chair c set parent_id = p.id
    from upload_row r join chair p on p.code = ul_txt(r.raw,'reports_to_chair_code')
   where r.batch_id = p_batch and c.code = ul_txt(r.raw,'chair_code');
end $fn$;

create or replace function ua_people(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  insert into person (employee_no, full_name, work_email, mobile, employment_status,
                      employee_type, joined_on, app_role, source_ref)
  select ul_txt(raw,'employee_no'),
         ul_txt(raw,'full_name'),
         lower(ul_txt(raw,'work_email')),
         regexp_replace(ul_txt(raw,'mobile'), '[^0-9]', '', 'g'),
         'ACTIVE',
         upper(coalesce(ul_txt(raw,'employment_type'),'EMPLOYEE')),
         ul_txt(raw,'date_of_joining')::date,
         'VIEWER',
         'bulk upload'
    from upload_row where batch_id = p_batch
  on conflict (employee_no) where employee_no is not null do update
    set full_name = excluded.full_name, work_email = excluded.work_email,
        mobile = excluded.mobile, employee_type = excluded.employee_type,
        joined_on = excluded.joined_on, updated_at = now();

  -- managers second, so a person can report to someone created by this file
  update person p set manager_id = m.id
    from upload_row r join person m on m.employee_no = ul_txt(r.raw,'reports_to_employee_no')
   where r.batch_id = p_batch and p.employee_no = ul_txt(r.raw,'employee_no');

  -- seat each person in their chair; an existing seat is vacated first so a
  -- move shows as a move rather than two people holding one chair
  update chair_holder ch set to_date = current_date
    from upload_row r
    join person p on p.employee_no = ul_txt(r.raw,'employee_no')
   where r.batch_id = p_batch and ch.person_id = p.id and ch.to_date is null
     and ch.chair_id <> (select c.id from chair c
                          where c.title = ul_txt(r.raw,'chair') or c.code = ul_txt(r.raw,'chair') limit 1);

  insert into chair_holder (chair_id, person_id, is_primary, from_date)
  select c.id, p.id, true, coalesce(ul_txt(r.raw,'date_of_joining')::date, current_date)
    from upload_row r
    join person p on p.employee_no = ul_txt(r.raw,'employee_no')
    join lateral (select c2.id from chair c2
                   where c2.title = ul_txt(r.raw,'chair') or c2.code = ul_txt(r.raw,'chair')
                   limit 1) c on true
   where r.batch_id = p_batch
     and not exists (select 1 from chair_holder x
                      where x.person_id = p.id and x.chair_id = c.id and x.to_date is null);
end $fn$;

create or replace function ua_geography(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
declare r record; v_state uuid; v_zone uuid;
begin
  for r in select raw from upload_row where batch_id = p_batch order by row_no loop
    v_state := null;

    if ul_txt(r.raw,'state') is not null then
      select id into v_state from geo_node
       where level = 'STATE' and lower(name) = lower(ul_txt(r.raw,'state')) and parent_id is null;
      if v_state is null then
        insert into geo_node (level, name) values ('STATE', ul_txt(r.raw,'state'))
        returning id into v_state;
      end if;
    end if;

    select id into v_zone from geo_node
     where level = 'ZONE' and lower(name) = lower(ul_txt(r.raw,'zone'))
       and parent_id is not distinct from v_state;
    if v_zone is null then
      insert into geo_node (level, name, parent_id, group_name, region)
      values ('ZONE', ul_txt(r.raw,'zone'), v_state,
              ul_txt(r.raw,'group'), ul_txt(r.raw,'region'))
      returning id into v_zone;
    else
      update geo_node set group_name = coalesce(ul_txt(r.raw,'group'), group_name),
                          region     = coalesce(ul_txt(r.raw,'region'), region)
       where id = v_zone;
    end if;

    if ul_txt(r.raw,'city') is not null
       and lower(ul_txt(r.raw,'city')) <> lower(ul_txt(r.raw,'zone'))
       and not exists (select 1 from geo_node
                        where level='CITY' and parent_id = v_zone
                          and lower(name) = lower(ul_txt(r.raw,'city'))) then
      insert into geo_node (level, name, parent_id)
      values ('CITY', ul_txt(r.raw,'city'), v_zone);
    end if;
  end loop;
end $fn$;

create or replace function ua_clients(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  insert into client (code, name, status, source_ref)
  select distinct on (ul_txt(raw,'client_code'))
         ul_txt(raw,'client_code'), ul_txt(raw,'client_name'), 'ACTIVE', 'bulk upload'
    from upload_row where batch_id = p_batch
   order by ul_txt(raw,'client_code'), row_no
  on conflict (code) do update set name = excluded.name, updated_at = now();

  insert into branch (client_id, code, name, address, geo_node_id, status, source_ref)
  select c.id, ul_txt(r.raw,'branch_code'), ul_txt(r.raw,'branch_name'),
         ul_txt(r.raw,'address'), g.id,
         upper(coalesce(ul_txt(r.raw,'status'),'ACTIVE'))::entity_status, 'bulk upload'
    from upload_row r
    join client c   on c.code = ul_txt(r.raw,'client_code')
    join geo_node g on g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'zone'))
   where r.batch_id = p_batch
  on conflict (client_id, code) do update
    set name = excluded.name, address = excluded.address,
        geo_node_id = excluded.geo_node_id, status = excluded.status, updated_at = now();
end $fn$;

-- A coverage rule at client x zone hangs off a client_zone row, not off the
-- client and the geography separately; coverage_scope_shape says so.
create or replace function ua_assignments(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
declare r record; v_cz uuid;
begin
  for r in select raw from upload_row where batch_id = p_batch order by row_no loop
    select cz.id into v_cz
      from client_zone cz
      join client c on c.id = cz.client_id and c.code = ul_txt(r.raw,'client_code')
     where lower(cz.name) = lower(ul_txt(r.raw,'zone'));

    if v_cz is null then
      insert into client_zone (client_id, name, geo_node_id)
      select c.id, ul_txt(r.raw,'zone'), g.id
        from client c, geo_node g
       where c.code = ul_txt(r.raw,'client_code')
         and g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'zone'))
      returning id into v_cz;
    end if;

    insert into coverage_rule (person_id, role, scope_type, client_id, client_zone_id,
                               geo_node_id, product, effective_from, effective_to,
                               is_assigned_handler, source_ref)
    select p.id, 'HANDLER', 'CLIENT_ZONE', c.id, v_cz, g.id,
           ul_txt(r.raw,'product'),
           ul_txt(r.raw,'effective_from')::date, ul_txt(r.raw,'effective_to')::date,
           true, 'bulk upload'
      from person p, client c, geo_node g
     where p.employee_no = ul_txt(r.raw,'handler_employee_no')
       and c.code = ul_txt(r.raw,'client_code')
       and g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'zone'));

    if ul_txt(r.raw,'location_head_employee_no') is not null then
      insert into coverage_rule (person_id, role, scope_type, client_id, client_zone_id,
                                 geo_node_id, product, effective_from, effective_to,
                                 is_assigned_handler, source_ref)
      select p.id, 'LOCATION_HEAD', 'CLIENT_ZONE', c.id, v_cz, g.id,
             ul_txt(r.raw,'product'),
             ul_txt(r.raw,'effective_from')::date, ul_txt(r.raw,'effective_to')::date,
             false, 'bulk upload'
        from person p, client c, geo_node g
       where p.employee_no = ul_txt(r.raw,'location_head_employee_no')
         and c.code = ul_txt(r.raw,'client_code')
         and g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'zone'));
    end if;
  end loop;
end $fn$;

-- The old set-based applier joined every inserted rate to every row of the
-- file that shared a client and an effective_from, so a rate for one zone was
-- attached to all of that client's zones. It also matched geo_node by name
-- alone, which catches a CITY of the same name as well as the ZONE.
-- One row at a time, correlated by row, and ZONE only.
create or replace function ua_rates(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
declare r record; v_rate uuid; v_seq int;
begin
  select coalesce(count(*),0) into v_seq from rate;

  for r in select row_no, raw from upload_row where batch_id = p_batch order by row_no loop
    v_seq := v_seq + 1;

    insert into rate (code, client_id, scope, value, currency,
                      effective_from, effective_to, reason, created_by)
    select 'RATE-' || lpad(v_seq::text, 6, '0'), c.id,
           case when ul_txt(r.raw,'zone') is null then 'client' else 'exact' end::rate_scope,
           ul_txt(r.raw,'rate')::numeric,
           coalesce(ul_txt(r.raw,'currency'), 'INR'),
           ul_txt(r.raw,'effective_from')::date,
           ul_txt(r.raw,'effective_to')::date,
           ul_txt(r.raw,'reason'), p_actor
      from client c where c.code = ul_txt(r.raw,'client_code')
    returning id into v_rate;

    if ul_txt(r.raw,'zone') is not null then
      insert into rate_location (rate_id, geo_node_id)
      select v_rate, g.id from geo_node g
       where g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'zone'))
      on conflict do nothing;
    end if;
  end loop;
end $fn$;

create or replace function ua_collections(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  insert into perf_revenue (client_id, geo_node_id, period, invoiced_inr, realised_inr,
                            loaded_by, source_ref)
  select c.id, g.id, (ul_txt(r.raw,'period') || '-01')::date,
         round(ul_txt(r.raw,'billed')::numeric)::bigint,
         round(ul_txt(r.raw,'collected')::numeric)::bigint,
         p_actor, 'bulk upload'
    from upload_row r
    join client   c on c.code = ul_txt(r.raw,'client_code')
    join geo_node g on g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'zone'))
   where r.batch_id = p_batch;
end $fn$;

create or replace function ua_kpi_targets(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  insert into target (person_id, period, category, sub_category, target_value, updated_by)
  select p.id, ul_txt(r.raw,'period'), ul_txt(r.raw,'kpi_name'),
         ul_txt(r.raw,'sub_category'), ul_txt(r.raw,'target')::numeric, p_actor
    from upload_row r
    join person p on p.employee_no = ul_txt(r.raw,'employee_no')
   where r.batch_id = p_batch;
end $fn$;

-- location_code names a ZONE. Matching geo_node on name alone also catches the
-- CITY of the same name, and every such row was loaded twice.
create or replace function ua_past_perf(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  insert into perf_month (person_id, period, kpi_name, sub_category, unit,
                          target_value, achieved, mtd_achieved, source, loaded_by)
  select p.id, (ul_txt(r.raw,'period') || '-01')::date, ul_txt(r.raw,'kpi_name'),
         ul_txt(r.raw,'sub_category'), ul_txt(r.raw,'unit'),
         ul_txt(r.raw,'target')::numeric, ul_txt(r.raw,'achieved')::numeric,
         ul_txt(r.raw,'mtd_achieved')::numeric,
         coalesce(ul_txt(r.raw,'source'), 'bulk upload'), p_actor
    from upload_row r
    join person p on p.employee_no = ul_txt(r.raw,'employee_no')
   where r.batch_id = p_batch and lower(ul_txt(r.raw,'file_part')) = 'mtd';

  insert into perf_revenue (client_id, geo_node_id, branch_id, period,
                            invoiced_inr, realised_inr, owner_person_id, loaded_by, source_ref)
  select c.id, g.id, b.id, (ul_txt(r.raw,'period') || '-01')::date,
         ul_txt(r.raw,'invoiced_inr')::bigint, ul_txt(r.raw,'realised_inr')::bigint,
         o.id, p_actor, coalesce(ul_txt(r.raw,'source'), 'bulk upload')
    from upload_row r
    join client   c on c.code = ul_txt(r.raw,'client_code')
    join geo_node g on g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'location_code'))
    left join branch b on b.client_id = c.id and b.code = ul_txt(r.raw,'branch_code')
    left join person o on o.employee_no = ul_txt(r.raw,'owner_employee_no')
   where r.batch_id = p_batch and lower(ul_txt(r.raw,'file_part')) = 'revenue';

  insert into perf_collection (client_id, geo_node_id, branch_id, period,
                               opening_outstanding_inr, collected_inr, closing_outstanding_inr,
                               owner_person_id, loaded_by, source_ref)
  select c.id, g.id, b.id, (ul_txt(r.raw,'period') || '-01')::date,
         ul_txt(r.raw,'opening_outstanding_inr')::bigint,
         ul_txt(r.raw,'collected_inr')::bigint,
         ul_txt(r.raw,'closing_outstanding_inr')::bigint,
         o.id, p_actor, coalesce(ul_txt(r.raw,'source'), 'bulk upload')
    from upload_row r
    join client   c on c.code = ul_txt(r.raw,'client_code')
    join geo_node g on g.level = 'ZONE' and lower(g.name) = lower(ul_txt(r.raw,'location_code'))
    left join branch b on b.client_id = c.id and b.code = ul_txt(r.raw,'branch_code')
    left join person o on o.employee_no = ul_txt(r.raw,'owner_employee_no')
   where r.batch_id = p_batch and lower(ul_txt(r.raw,'file_part')) = 'collections';
end $fn$;

create or replace function ua_opening(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
declare v_cat uuid; v_desk uuid;
begin
  -- Cutover rows arrive without the category and desk the live workflow would
  -- have chosen. They get their own, clearly named, rather than being filed
  -- under a real one where they would read as genuine classifications.
  -- desk_primary_or_fallback: a desk has to answer to somebody, so until it is
  -- reassigned it answers to the administrator who loaded the file.
  select id into v_desk from desk where name = 'Cutover desk';
  if v_desk is null then
    insert into desk (name, primary_person_id, escalation_only)
    values ('Cutover desk', p_actor, false) returning id into v_desk;
  end if;

  select id into v_cat from category where name = 'Migrated at cutover';
  if v_cat is null then
    insert into category (name, desk_id, pinned, chase_hours, active)
    values ('Migrated at cutover', v_desk, false, 24, true) returning id into v_cat;
  end if;

  insert into "case" (ref, client_id, category_id, raised_by, owner_person_id, desk_id,
                      status, created_at, last_activity_at, source_ref)
  select ul_txt(r.raw,'reference'), c.id, v_cat, o.id, o.id, v_desk,
         upper(ul_txt(r.raw,'current_state'))::case_status,
         replace(ul_txt(r.raw,'created_at'),' ','T')::timestamptz,
         replace(ul_txt(r.raw,'created_at'),' ','T')::timestamptz,
         'opening balance'
    from upload_row r
    join client c on c.code = ul_txt(r.raw,'client_code')
    join person o on o.employee_no = ul_txt(r.raw,'owner_employee_no')
   where r.batch_id = p_batch and lower(ul_txt(r.raw,'record_type')) = 'escalation'
  on conflict (ref) do nothing;

  insert into claim (ref, person_id, amount, stage, created_at)
  select ul_txt(r.raw,'reference'), o.id,
         coalesce(ul_txt(r.raw,'amount')::numeric, 0),
         upper(ul_txt(r.raw,'current_state'))::claim_stage,
         replace(ul_txt(r.raw,'created_at'),' ','T')::timestamptz
    from upload_row r
    join person o on o.employee_no = ul_txt(r.raw,'owner_employee_no')
   where r.batch_id = p_batch and lower(ul_txt(r.raw,'record_type')) = 'claim'
  on conflict (ref) do nothing;
end $fn$;

create or replace function ua_holidays(p_batch uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $fn$
declare v_file text;
begin
  select file_name into v_file from upload_batch where id = p_batch;
  insert into holiday (day, name, applies_to, confirmed, source, batch_id)
  select ul_txt(raw,'date')::date, ul_txt(raw,'name'),
         coalesce(ul_txt(raw,'scope'), 'ALL'),
         lower(coalesce(raw->>'confirmed','yes')) in ('yes','true'),
         'bulk upload: ' || v_file, p_batch
    from upload_row where batch_id = p_batch
  on conflict (day) do update
    set name = excluded.name, applies_to = excluded.applies_to,
        confirmed = excluded.confirmed, source = excluded.source, batch_id = excluded.batch_id;
end $fn$;

-- =====================================================================
-- The dispatchers. upload_validate and upload_apply keep their signatures
-- and their guarantees; they now route by kind instead of carrying every
-- kind's logic inline.
-- =====================================================================

create or replace function upload_validate(p_batch uuid)
returns table(rows_total integer, rows_ok integer, rows_error integer)
language plpgsql set search_path to 'public' as $function$
declare v_kind text; v_total int; v_ok int; v_bad int;
begin
  select kind into v_kind from upload_batch where id = p_batch;
  if v_kind is null then raise exception 'no such batch'; end if;

  update upload_row set error = null where batch_id = p_batch;

  case v_kind
    when 'Chairs'               then perform uv_chairs(p_batch);
    when 'People'               then perform uv_people(p_batch);
    when 'Geography'            then perform uv_geography(p_batch);
    when 'Clients and branches' then perform uv_clients(p_batch);
    when 'Assignments'          then perform uv_assignments(p_batch);
    when 'Rates'                then perform uv_rates(p_batch);
    when 'Collections'          then perform uv_collections(p_batch);
    when 'KPI targets'          then perform uv_kpi_targets(p_batch);
    when 'Past performance'     then perform uv_past_perf(p_batch);
    when 'Opening balances'     then perform uv_opening(p_batch);
    when 'Holidays'             then perform uv_holidays(p_batch);
    else
      update upload_row set error = 'no loader is implemented for this file kind yet'
       where batch_id = p_batch;
  end case;

  select count(*)::int,
         count(*) filter (where error is null)::int,
         count(*) filter (where error is not null)::int
    into v_total, v_ok, v_bad
    from upload_row where batch_id = p_batch;

  update upload_batch b set rows_total = v_total, rows_ok = v_ok, rows_error = v_bad
   where b.id = p_batch;

  rows_total := v_total; rows_ok := v_ok; rows_error := v_bad;
  return next;
end $function$;

create or replace function upload_apply(p_batch uuid, p_actor uuid)
returns table(applied integer)
language plpgsql set search_path to 'public' as $function$
declare v_kind text; v_state text; v_err int;
begin
  select kind, state, rows_error into v_kind, v_state, v_err
    from upload_batch where id = p_batch for update;
  if v_kind is null then raise exception 'no such batch'; end if;
  if v_state = 'APPLIED' then raise exception 'batch already applied'; end if;
  if v_err > 0 then
    raise exception 'file has % errored row(s); a file with any error applies zero rows', v_err
      using errcode = 'check_violation';
  end if;

  case v_kind
    when 'Chairs'               then perform ua_chairs(p_batch, p_actor);
    when 'People'               then perform ua_people(p_batch, p_actor);
    when 'Geography'            then perform ua_geography(p_batch, p_actor);
    when 'Clients and branches' then perform ua_clients(p_batch, p_actor);
    when 'Assignments'          then perform ua_assignments(p_batch, p_actor);
    when 'Rates'                then perform ua_rates(p_batch, p_actor);
    when 'Collections'          then perform ua_collections(p_batch, p_actor);
    when 'KPI targets'          then perform ua_kpi_targets(p_batch, p_actor);
    when 'Past performance'     then perform ua_past_perf(p_batch, p_actor);
    when 'Opening balances'     then perform ua_opening(p_batch, p_actor);
    when 'Holidays'             then perform ua_holidays(p_batch, p_actor);
    else raise exception 'no loader is implemented for %', v_kind;
  end case;

  update upload_batch b set state = 'APPLIED', applied_at = now(), applied_by = p_actor
   where b.id = p_batch;
  select b.rows_ok into applied from upload_batch b where b.id = p_batch;
  return next;
end $function$;

-- "has_errors" was being reported for every check violation, including ones
-- that have nothing to do with errored rows - which sends the person looking
-- at their file when the fault is in the loader. Only our own message means
-- the file had errors.
create or replace function upload_apply_audited(p_batch uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_applied int;
begin
  select applied into v_applied from upload_apply(p_batch, p_actor);
  insert into audit_entry (actor_id, action, entity_type, entity_id, entity_ref, new_value)
  values (p_actor, 'UPLOAD_APPLIED', 'upload_batch', p_batch, p_batch::text,
          jsonb_build_object('applied', v_applied));
  return jsonb_build_object('applied', v_applied, 'note', 'Loaded.');
exception
  when check_violation then
    if sqlerrm like '%applies zero rows%' then
      return jsonb_build_object('error','has_errors','reason', sqlerrm);
    end if;
    return jsonb_build_object('error','apply_failed',
      'reason','The file passed validation but the database refused a row: ' || sqlerrm,
      'hint','Nothing was written. This is a gap in the loader, not in your file.');
  when others then
    return jsonb_build_object('error','apply_failed',
      'reason','The file passed validation but the database refused a row: ' || sqlerrm,
      'hint','Nothing was written. This is a gap in the loader, not in your file.');
end $fn$;

-- ------------------------------------------------------------- exposure
do $g$
declare f text;
begin
  foreach f in array array['upload_template(text)','csv_cell(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $g$;
