-- =====================================================================
-- CRUX — schema patch v11
-- Two things the first live test of the hosted uploader found.
--
-- 1. A date was checked by its shape, not by being a date. 2026-13-45
--    matched ^\d{4}-\d{2}-\d{2}$, passed the preview clean, and would have
--    reached the cast inside upload_apply — where it aborts the whole file
--    with a Postgres error rather than naming the row. The promise is that
--    the preview shows every problem; a row that only fails at apply time
--    breaks it.
--
-- 2. A present-but-unparseable effective_to on a Rates file fell through
--    every branch and was never reported at all.
--
-- Also adds login_attempt, because the hosted uploader answers on a public
-- URL and a password endpoint on a public URL needs a lock.
-- Run after schema-patch-v10.sql.
-- =====================================================================

-- ------------------------------------------------------------ real dates
create or replace function is_ymd(p text)
returns boolean language plpgsql immutable as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  perform p::date;
  return true;
exception when others then
  return false;
end $$;

comment on function is_ymd is
  'True only for a string that is both shaped like YYYY-MM-DD and an actual '
  'date. Rejects 2026-13-45 and 2027-02-29; accepts 2028-02-29.';

-- ------------------------------------------------------- the brute lock
create table if not exists login_attempt (
  id bigserial primary key,
  at timestamptz not null default now(),
  email text not null,
  ip text,
  ok boolean not null
);
create index if not exists login_attempt_email_at on login_attempt (email, at desc);
create index if not exists login_attempt_ip_at on login_attempt (ip, at desc);
alter table login_attempt enable row level security;
alter table login_attempt force row level security;
revoke all on login_attempt from anon, authenticated;

comment on table login_attempt is
  'Every sign-in attempt against the hosted shell. Five failures from one '
  'address or one IP in fifteen minutes stops the sixth being tried at all — '
  'the endpoint is public, so the lock has to live here, not in the caller.';

-- auth_login gains the client address, so a caller cannot dodge the lock by
-- simply declining to check it. Replaces the three-argument form from v10.
drop function if exists auth_login(text,text,text);

create or replace function auth_login(
  p_email text, p_hash text, p_token_hash text, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p person%rowtype; v_fails int;
begin
  select count(*) into v_fails from login_attempt
   where at > now() - interval '15 minutes' and ok = false
     and (email = lower(p_email) or (p_ip is not null and ip = p_ip));

  if v_fails >= 5 then
    return jsonb_build_object('error','locked_out',
      'reason','Too many failed attempts. Try again in fifteen minutes.');
  end if;

  select * into p from person
   where lower(work_email) = lower(p_email)
     and employment_status = 'ACTIVE'
     and superseded_by is null;

  if not found or p.password_hash is null
     or length(p.password_hash) <> length(p_hash)
     or p.password_hash <> p_hash then
    insert into login_attempt (email, ip, ok) values (lower(p_email), p_ip, false);
    -- one message for both cases: a different answer for "no such person"
    -- would turn this endpoint into a staff directory
    return jsonb_build_object('error','bad_credentials',
      'reason','Wrong address or password.');
  end if;

  insert into login_attempt (email, ip, ok) values (lower(p_email), p_ip, true);
  insert into auth_session (person_id, expires_at, source, token_hash)
  values (p.id, now() + interval '7 days', 'PASSWORD', p_token_hash);

  return jsonb_build_object('id', p.id, 'full_name', p.full_name,
    'work_email', p.work_email, 'app_role', p.app_role);
end $$;

revoke all on function auth_login(text,text,text,text) from public, anon, authenticated;
grant execute on function auth_login(text,text,text,text) to service_role;

-- --------------------------------------------------- validator, corrected
-- Only the date tests change. Everything else is v8's function verbatim.
create or replace function upload_validate(p_batch uuid)
returns table(rows_total integer, rows_ok integer, rows_error integer)
language plpgsql set search_path to 'public' as $function$
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
                      when not is_ymd(btrim(r2.raw->>'date')) then 'date must be a real date, written YYYY-MM-DD'
                 end,
                 case when nullif(btrim(r2.raw->>'name'),'') is null then 'name is required' end,
                 case when lower(coalesce(r2.raw->>'confirmed','no')) not in ('yes','no','true','false','')
                      then 'confirmed must be yes or no' end
               ), '') as msg
        from upload_row r2 where r2.batch_id = p_batch
      ) e
     where r.id = e.id and e.msg is not null;

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
                      then 'client_code ' || (r2.raw->>'client_code') || ' does not exist - load Clients first'
                 end,
                 case when nullif(btrim(r2.raw->>'zone'),'') is not null
                       and not exists (select 1 from geo_node g where lower(g.name) = lower(btrim(r2.raw->>'zone')))
                      then 'zone ' || (r2.raw->>'zone') || ' does not exist - load Geography first' end,
                 case when nullif(btrim(r2.raw->>'rate'),'') is null then 'rate is required'
                      when (r2.raw->>'rate') !~ '^\d+(\.\d{1,2})?$' then 'rate must be a non-negative number with at most two decimals'
                 end,
                 case when nullif(btrim(r2.raw->>'effective_from'),'') is null then 'effective_from is required'
                      when not is_ymd(btrim(r2.raw->>'effective_from')) then 'effective_from must be a real date, written YYYY-MM-DD'
                 end,
                 -- a present-but-unparseable effective_to used to fall through
                 -- every branch and reach the cast in upload_apply
                 case when nullif(btrim(r2.raw->>'effective_to'),'') is not null
                       and not is_ymd(btrim(r2.raw->>'effective_to'))
                      then 'effective_to must be a real date, written YYYY-MM-DD, or left blank' end,
                 case when nullif(btrim(r2.raw->>'effective_to'),'') is not null
                       and is_ymd(btrim(r2.raw->>'effective_to'))
                       and is_ymd(btrim(r2.raw->>'effective_from'))
                       and btrim(r2.raw->>'effective_to')::date <= btrim(r2.raw->>'effective_from')::date
                      then 'effective_to must be after effective_from' end
               ), '') as msg
        from upload_row r2 where r2.batch_id = p_batch
      ) e
     where r.id = e.id and e.msg is not null;

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
end $function$;

-- pg_net lets the database call the hosted function directly, which is how
-- the live endpoint was tested end to end.
create extension if not exists pg_net with schema extensions;
