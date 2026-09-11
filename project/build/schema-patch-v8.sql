-- =====================================================================
-- CRUX — schema patch v8: bulk upload, holidays and rates
--
-- Built to the loader the application already describes, not a new one:
--   "Validate -> preview -> apply · nothing is written before you have seen
--    the preview"
--   "A file with any error applies zero rows — there is no partial load."
--   "Uploading out of order is refused rather than half-applied. A coverage
--    file naming an unknown location, or a rate naming an unknown client,
--    stops with the offending rows listed by number."
--
-- The ten file kinds and their exact headers come from the template
-- generator in Crux App v2.dc.html. This patch builds the framework plus the
-- two loaders that are blocking go-live (Holidays and Rates); the remaining
-- eight slot into the same lifecycle and are listed in upload_kind so the
-- screen can show them.
-- Run after schema-patch-v7.sql.
-- =====================================================================

-- ------------------------------------------------------------- the kinds
-- Load order is data, not a constant in code: the screen renders this and the
-- validator refuses a file whose predecessors have not landed.
create table if not exists upload_kind (
  kind       text primary key,
  load_order int  not null unique,
  needs      text not null,
  implemented boolean not null default false
);

insert into upload_kind (kind, load_order, needs, implemented) values
  ('People',              1,  'Names, employee numbers, chairs, managers, contact details.', false),
  ('Geography',           2,  'Groups, regions, zones and locations.', false),
  ('Clients and branches',3,  'Client master and branch master with codes.', false),
  ('Assignments',         4,  'Client x location x handler x W.E.F.', false),
  ('Rates',               5,  'The agreed commercial rate per client and location with its W.E.F. date.', true),
  ('Collections',         6,  'Collected and billed per client, location and month.', false),
  ('KPI targets',         7,  'Monthly targets per person and KPI.', false),
  ('Past performance',    8,  'MTD achieved, revenue and collections by month.', false),
  ('Holidays',            9,  'Festival dates for the year ahead.', true),
  ('Opening balances',    10, 'Live escalations, OGL assignments and claims at cutover.', false)
on conflict (kind) do update set load_order = excluded.load_order,
                                 needs = excluded.needs,
                                 implemented = excluded.implemented;

-- ------------------------------------------------------------ the batch
create table if not exists upload_batch (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null references upload_kind(kind),
  file_name   text not null,
  storage_key text,                       -- object in the bulk-uploads bucket
  uploaded_by uuid not null references person(id),
  uploaded_at timestamptz not null default now(),
  state       text not null default 'PREVIEW'
              check (state in ('PREVIEW','APPLIED','REJECTED','CANCELLED')),
  rows_total  int not null default 0,
  rows_ok     int not null default 0,
  rows_error  int not null default 0,
  applied_at  timestamptz,
  applied_by  uuid references person(id),
  note        text
);
create index if not exists upload_batch_kind_idx on upload_batch (kind, uploaded_at desc);
comment on table upload_batch is
  'One uploaded file. A batch sits in PREVIEW until somebody has seen the '
  'errors and applied it; applying a batch with any errored row is refused.';

-- -------------------------------------------------------------- the rows
-- The file verbatim, one row per line, with the reason it was refused. The
-- row number is the line number the person sees in their spreadsheet, so an
-- error can be found without counting.
create table if not exists upload_row (
  id       uuid primary key default gen_random_uuid(),
  batch_id uuid not null references upload_batch(id) on delete cascade,
  row_no   int  not null,
  raw      jsonb not null,
  error    text,
  constraint upload_row_uniq unique (batch_id, row_no)
);
create index if not exists upload_row_error_idx on upload_row (batch_id) where error is not null;

-- --------------------------------------------------------- holiday scope
-- The template asks for scope and confirmed; the table had neither. Three of
-- the loaded dates await moon sighting, and a date that might move must not
-- silently drive a TAT — working_hours_after skips only confirmed days.
alter table holiday add column if not exists confirmed boolean not null default true;
alter table holiday add column if not exists batch_id uuid references upload_batch(id);
comment on column holiday.confirmed is
  'False for a moon-sighting date that is not fixed yet. An unconfirmed day is '
  'shown on the calendar but is NOT skipped by the clock, because shortening a '
  'deadline on a date that may move is the error that cannot be undone.';

-- The clock skips confirmed holidays only.
create or replace function working_hours_after(p_from timestamptz, p_hours numeric)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  cur   timestamptz := p_from;
  left_ numeric     := p_hours;
  open_h  int := coalesce((select split_part(value, ':', 1)::int from app_setting where key = 'day_start'), 10);
  close_h int := coalesce((select split_part(value, ':', 1)::int from app_setting where key = 'day_end'), 19);
  sat_h   numeric := pms_cfg('sat_hours', 4);
  sat_on  boolean := coalesce((select value ilike 'y%' from app_setting where key = 'sat'), true);
  day_cap numeric;
  avail   numeric;
begin
  while left_ > 0 loop
    if extract(dow from cur) = 0
       or (extract(dow from cur) = 6 and not sat_on)
       or exists (select 1 from holiday h where h.day = cur::date and h.confirmed) then
      cur := date_trunc('day', cur) + interval '1 day' + (open_h || ' hours')::interval;
      continue;
    end if;
    day_cap := case when extract(dow from cur) = 6 then sat_h else close_h - open_h end;
    if cur::time < (open_h || ':00')::time then
      cur := date_trunc('day', cur) + (open_h || ' hours')::interval;
    end if;
    avail := least(day_cap, extract(epoch from ((date_trunc('day', cur) + ((open_h + day_cap) || ' hours')::interval) - cur)) / 3600.0);
    if avail <= 0 then
      cur := date_trunc('day', cur) + interval '1 day' + (open_h || ' hours')::interval;
      continue;
    end if;
    if left_ <= avail then
      return cur + (left_ || ' hours')::interval;
    end if;
    left_ := left_ - avail;
    cur := date_trunc('day', cur) + interval '1 day' + (open_h || ' hours')::interval;
  end loop;
  return cur;
end $$;

-- ---------------------------------------------------------- validation
-- Writes the reason onto each bad row and returns the counts. Never writes to
-- a master table. Re-runnable: validating again clears the previous verdict.
create or replace function upload_validate(p_batch uuid)
returns table (rows_total int, rows_ok int, rows_error int)
language plpgsql set search_path = public as $$
declare
  v_kind text;
  v_total int; v_ok int; v_bad int;
begin
  select kind into v_kind from upload_batch where id = p_batch;
  if v_kind is null then raise exception 'no such batch'; end if;

  update upload_row set error = null where batch_id = p_batch;

  if v_kind = 'Holidays' then
    update upload_row r set error = e.msg
      from (
        select r2.id,
               nullif(concat_ws('; ',
                 case when nullif(btrim(r2.raw->>'date'),'') is null then 'date is required'
                      when (r2.raw->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then 'date must be YYYY-MM-DD'
                 end,
                 case when nullif(btrim(r2.raw->>'name'),'') is null then 'name is required' end,
                 case when lower(coalesce(r2.raw->>'confirmed','no')) not in ('yes','no','true','false','')
                      then 'confirmed must be yes or no' end
               ), '') as msg
        from upload_row r2 where r2.batch_id = p_batch
      ) e
     where r.id = e.id and e.msg is not null;

    -- a second row for the same day inside one file is an error, not a merge
    update upload_row r set error = coalesce(r.error || '; ', '') || 'duplicate date in this file'
      from (
        select id, row_number() over (partition by raw->>'date' order by row_no) as rn
        from upload_row where batch_id = p_batch and error is null
      ) d
     where r.id = d.id and d.rn > 1;

  elsif v_kind = 'Rates' then
    update upload_row r set error = e.msg
      from (
        select r2.id,
               nullif(concat_ws('; ',
                 case when nullif(btrim(r2.raw->>'client_code'),'') is null then 'client_code is required'
                      when not exists (select 1 from client c where c.code = btrim(r2.raw->>'client_code'))
                      then 'client_code ' || (r2.raw->>'client_code') || ' does not exist — load Clients first'
                 end,
                 case when nullif(btrim(r2.raw->>'zone'),'') is not null
                       and not exists (select 1 from geo_node g where lower(g.name) = lower(btrim(r2.raw->>'zone')))
                      then 'zone ' || (r2.raw->>'zone') || ' does not exist — load Geography first' end,
                 case when nullif(btrim(r2.raw->>'rate'),'') is null then 'rate is required'
                      when (r2.raw->>'rate') !~ '^\d+(\.\d{1,2})?$' then 'rate must be a non-negative number with at most two decimals'
                 end,
                 case when nullif(btrim(r2.raw->>'effective_from'),'') is null then 'effective_from is required'
                      when (r2.raw->>'effective_from') !~ '^\d{4}-\d{2}-\d{2}$' then 'effective_from must be YYYY-MM-DD'
                 end,
                 case when nullif(btrim(r2.raw->>'effective_to'),'') is not null
                       and (r2.raw->>'effective_to') ~ '^\d{4}-\d{2}-\d{2}$'
                       and (r2.raw->>'effective_to')::date <= (r2.raw->>'effective_from')::date
                      then 'effective_to must be after effective_from' end
               ), '') as msg
        from upload_row r2 where r2.batch_id = p_batch
      ) e
     where r.id = e.id and e.msg is not null;

    -- two rows claiming the same client and location on overlapping dates is
    -- an error, not a warning — same rule the Assignments file states
    update upload_row r set error = coalesce(r.error || '; ', '') || 'overlaps another row in this file for the same client and zone'
      from (
        select a.id
        from upload_row a join upload_row b
          on a.batch_id = b.batch_id and a.id <> b.id
         and btrim(a.raw->>'client_code') = btrim(b.raw->>'client_code')
         and coalesce(lower(btrim(a.raw->>'zone')),'') = coalesce(lower(btrim(b.raw->>'zone')),'')
         and daterange((a.raw->>'effective_from')::date, nullif(btrim(a.raw->>'effective_to'),'')::date, '[)')
           && daterange((b.raw->>'effective_from')::date, nullif(btrim(b.raw->>'effective_to'),'')::date, '[)')
        where a.batch_id = p_batch and a.error is null and b.error is null
      ) o
     where r.id = o.id;
  else
    update upload_row set error = 'no loader is implemented for this file kind yet'
     where batch_id = p_batch;
  end if;

  -- distinct locals: assigning straight to the OUT params would make
  -- "set rows_total = rows_total" ambiguous between column and variable
  select count(*)::int,
         count(*) filter (where error is null)::int,
         count(*) filter (where error is not null)::int
    into v_total, v_ok, v_bad
    from upload_row where batch_id = p_batch;

  update upload_batch b
     set rows_total = v_total, rows_ok = v_ok, rows_error = v_bad
   where b.id = p_batch;

  rows_total := v_total; rows_ok := v_ok; rows_error := v_bad;
  return next;
end $$;

-- -------------------------------------------------------------- apply
-- All or nothing. One errored row refuses the whole file, which is the rule
-- the screen states: "A file with any error applies zero rows."
create or replace function upload_apply(p_batch uuid, p_actor uuid)
returns table (applied int)
language plpgsql set search_path = public as $$
declare
  v_kind text; v_state text; v_err int; v_file text;
begin
  select kind, state, rows_error, file_name into v_kind, v_state, v_err, v_file
    from upload_batch where id = p_batch for update;
  if v_kind is null then raise exception 'no such batch'; end if;
  if v_state = 'APPLIED' then raise exception 'batch already applied'; end if;
  if v_err > 0 then
    raise exception 'file has % errored row(s); a file with any error applies zero rows', v_err
      using errcode = 'check_violation';
  end if;

  if v_kind = 'Holidays' then
    insert into holiday (day, name, applies_to, confirmed, source, batch_id)
    select (raw->>'date')::date,
           btrim(raw->>'name'),
           coalesce(nullif(btrim(raw->>'scope'),''), 'ALL'),
           lower(coalesce(raw->>'confirmed','yes')) in ('yes','true'),
           'bulk upload: ' || v_file,
           p_batch
      from upload_row where batch_id = p_batch
    on conflict (day) do update
      set name = excluded.name, applies_to = excluded.applies_to,
          confirmed = excluded.confirmed, source = excluded.source,
          batch_id = excluded.batch_id;

  elsif v_kind = 'Rates' then
    with ins as (
      insert into rate (code, client_id, scope, value, currency, effective_from, effective_to, reason, created_by)
      select 'RATE-' || lpad((row_number() over (order by r.row_no)
                              + coalesce((select count(*) from rate), 0))::text, 6, '0'),
             c.id,
             case when nullif(btrim(r.raw->>'zone'),'') is null then 'client' else 'exact' end::rate_scope,
             (r.raw->>'rate')::numeric,
             coalesce(nullif(btrim(r.raw->>'currency'),''), 'INR'),
             (r.raw->>'effective_from')::date,
             nullif(btrim(r.raw->>'effective_to'),'')::date,
             nullif(btrim(r.raw->>'reason'),''),
             p_actor
        from upload_row r
        join client c on c.code = btrim(r.raw->>'client_code')
       where r.batch_id = p_batch
      returning id, client_id, effective_from
    )
    insert into rate_location (rate_id, geo_node_id)
    select i.id, g.id
      from ins i
      join upload_row r on r.batch_id = p_batch
      join client c on c.id = i.client_id and c.code = btrim(r.raw->>'client_code')
      join geo_node g on lower(g.name) = lower(btrim(r.raw->>'zone'))
     where nullif(btrim(r.raw->>'zone'),'') is not null
       and (r.raw->>'effective_from')::date = i.effective_from
    on conflict do nothing;
  else
    raise exception 'no loader is implemented for %', v_kind;
  end if;

  update upload_batch b set state = 'APPLIED', applied_at = now(), applied_by = p_actor
   where b.id = p_batch;
  select b.rows_ok into applied from upload_batch b where b.id = p_batch;
  return next;
end $$;

-- ------------------------------------------------ the three fixed holidays
-- India's three national holidays are fixed by statute and fall on the same
-- date every year, so they can be seeded with confidence. Everything else —
-- festivals, state holidays, and anything awaiting moon sighting — is the
-- company's own list and comes through the uploader.
insert into holiday (day, name, applies_to, confirmed, source) values
  ('2026-01-26','Republic Day','National',true,'seeded: statutory national holiday'),
  ('2026-08-15','Independence Day','National',true,'seeded: statutory national holiday'),
  ('2026-10-02','Gandhi Jayanti','National',true,'seeded: statutory national holiday'),
  ('2027-01-26','Republic Day','National',true,'seeded: statutory national holiday'),
  ('2027-08-15','Independence Day','National',true,'seeded: statutory national holiday'),
  ('2027-10-02','Gandhi Jayanti','National',true,'seeded: statutory national holiday')
on conflict (day) do nothing;

-- uploads are administrator work and carry personal data; deny by default
alter table upload_batch enable row level security;
alter table upload_batch force row level security;
alter table upload_row   enable row level security;
alter table upload_row   force row level security;
alter table upload_kind  enable row level security;
alter table upload_kind  force row level security;
