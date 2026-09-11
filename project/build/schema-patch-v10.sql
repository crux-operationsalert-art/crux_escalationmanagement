-- =====================================================================
-- CRUX — schema patch v10
-- The hosted upload service.
--
-- The Express API in build/api owns the same lifecycle, but it needs a
-- machine to run on. These functions let a thin HTTP shell — an edge
-- function inside Supabase's own network — drive the identical lifecycle
-- without a server: one round trip per step, each step a single
-- transaction, so a staged batch and its audit row still commit together
-- or not at all.
--
-- Nothing here loosens a rule. upload_validate and upload_apply are
-- unchanged and still hold the guarantee: a file with any error applies
-- zero rows.
-- Run after schema-patch-v9.sql.
-- =====================================================================

-- ------------------------------------------------------------- sign-in
-- The password check is split across two calls on purpose. The salt is
-- public by construction — it is meaningless without the password — but
-- the stored hash never leaves the database, so a caller cannot take the
-- hash away and grind it offline. The comparison happens here.

create or replace function auth_salt(p_email text)
returns text language sql stable security definer set search_path = public as $$
  select password_salt from person
   where lower(work_email) = lower(p_email)
     and employment_status = 'ACTIVE'
     and superseded_by is null
$$;

-- The caller hashes the attempt with that salt and sends the result. It
-- also mints its own session token and sends only the SHA-256 of it, so
-- the raw token exists in exactly two places: the browser, and nowhere.
create or replace function auth_login(p_email text, p_hash text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p person%rowtype;
begin
  select * into p from person
   where lower(work_email) = lower(p_email)
     and employment_status = 'ACTIVE'
     and superseded_by is null;

  if not found or p.password_hash is null then
    return jsonb_build_object('error','no_password',
      'reason','That address has no password set. It signs in with Google.');
  end if;

  -- length-independent comparison: both sides are fixed-width hex
  if length(p.password_hash) <> length(p_hash)
     or p.password_hash <> p_hash then
    return jsonb_build_object('error','bad_credentials',
      'reason','Wrong address or password.');
  end if;

  insert into auth_session (person_id, expires_at, source, token_hash)
  values (p.id, now() + interval '7 days', 'PASSWORD', p_token_hash);

  return jsonb_build_object(
    'id', p.id, 'full_name', p.full_name,
    'work_email', p.work_email, 'app_role', p.app_role);
end $$;

-- Who is holding this token, if anyone. Touches last_seen_at so an
-- abandoned session is visible as abandoned.
create or replace function auth_whoami(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_person uuid; p person%rowtype;
begin
  update auth_session s set last_seen_at = now()
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
   returning s.person_id into v_person;
  if v_person is null then return null; end if;

  select * into p from person
   where id = v_person and employment_status = 'ACTIVE' and superseded_by is null;
  if not found then return null; end if;

  return jsonb_build_object(
    'id', p.id, 'full_name', p.full_name,
    'work_email', p.work_email, 'app_role', p.app_role);
end $$;

create or replace function auth_signout(p_token_hash text)
returns void language sql security definer set search_path = public as $$
  update auth_session set revoked_at = now()
   where token_hash = p_token_hash and revoked_at is null
$$;

-- ------------------------------------------------------------- staging
-- Parse happens in the caller, because row numbers have to be the ones the
-- person sees in their spreadsheet. Everything after that is one
-- transaction: the batch, its rows, the validation, and the audit entry.
create or replace function upload_stage(
  p_kind text, p_file text, p_rows jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid;
  v_total int; v_ok int; v_bad int;
  v_impl boolean;
begin
  select implemented into v_impl from upload_kind where kind = p_kind;
  if not found then
    return jsonb_build_object('error','bad_kind',
      'reason','Unknown file kind. The kinds list gives them in load order.');
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('error','empty_file',
      'reason','The file has a header but no data rows.');
  end if;

  insert into upload_batch (kind, file_name, uploaded_by)
  values (p_kind, coalesce(nullif(p_file,''),'upload.csv'), p_actor)
  returning id into v_batch;

  -- row_no is the spreadsheet line: header is line 1, so data starts at 2
  insert into upload_row (batch_id, row_no, raw)
  select v_batch, ord + 1, val
    from jsonb_array_elements(p_rows) with ordinality as t(val, ord);

  select rows_total, rows_ok, rows_error
    into v_total, v_ok, v_bad
    from upload_validate(v_batch);

  insert into audit_entry (actor_id, action, entity_type, entity_id, entity_ref, new_value)
  values (p_actor, 'UPLOAD_STAGED', 'upload_batch', v_batch, v_batch::text,
          jsonb_build_object('kind', p_kind, 'rows', v_total, 'errors', v_bad));

  return jsonb_build_object(
    'batchId', v_batch,
    'rows_total', v_total, 'rows_ok', v_ok, 'rows_error', v_bad,
    'implemented', v_impl,
    'applicable', v_impl and v_bad = 0,
    'errors', coalesce((
      select jsonb_agg(jsonb_build_object('row_no', row_no, 'error', error, 'raw', raw)
                       order by row_no)
        from (select row_no, error, raw from upload_row
               where batch_id = v_batch and error is not null
               order by row_no limit 200) e), '[]'::jsonb),
    'sample', coalesce((
      select jsonb_agg(jsonb_build_object('row_no', row_no, 'raw', raw) order by row_no)
        from (select row_no, raw from upload_row
               where batch_id = v_batch and error is null
               order by row_no limit 20) s), '[]'::jsonb));
end $$;

-- The preview, re-readable after the fact so a batch can be looked at again
-- before anybody commits to it.
create or replace function upload_preview(p_batch uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'batch', to_jsonb(b),
    'errors', coalesce((
      select jsonb_agg(jsonb_build_object('row_no', row_no, 'error', error, 'raw', raw)
                       order by row_no)
        from (select row_no, error, raw from upload_row
               where batch_id = b.id and error is not null
               order by row_no limit 200) e), '[]'::jsonb),
    'sample', coalesce((
      select jsonb_agg(jsonb_build_object('row_no', row_no, 'raw', raw) order by row_no)
        from (select row_no, raw from upload_row
               where batch_id = b.id and error is null
               order by row_no limit 20) s), '[]'::jsonb))
  from upload_batch b where b.id = p_batch
$$;

-- Apply, with its audit row in the same transaction. upload_apply itself
-- is untouched — it still refuses a batch carrying any errored row.
create or replace function upload_apply_audited(p_batch uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_applied int;
begin
  select applied into v_applied from upload_apply(p_batch, p_actor);

  insert into audit_entry (actor_id, action, entity_type, entity_id, entity_ref, new_value)
  values (p_actor, 'UPLOAD_APPLIED', 'upload_batch', p_batch, p_batch::text,
          jsonb_build_object('applied', v_applied));

  return jsonb_build_object('applied', v_applied, 'note', 'Loaded.');
exception
  when check_violation then
    return jsonb_build_object('error','has_errors','reason', sqlerrm);
end $$;

create or replace function upload_cancel(p_batch uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update upload_batch set state = 'CANCELLED'
   where id = p_batch and state = 'PREVIEW'
   returning id into v_id;
  if v_id is null then
    return jsonb_build_object('error','not_cancellable',
      'reason','Only a batch still in preview can be cancelled.');
  end if;
  insert into audit_entry (actor_id, action, entity_type, entity_id, entity_ref)
  values (p_actor, 'UPLOAD_CANCELLED', 'upload_batch', p_batch, p_batch::text);
  return jsonb_build_object('id', v_id, 'state', 'CANCELLED');
end $$;

-- What an administrator has loaded, most recent first.
create or replace function upload_history(p_limit int default 25)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.uploaded_at desc), '[]'::jsonb)
    from (select b.id, b.kind, b.file_name, b.state, b.uploaded_at,
                 b.rows_total, b.rows_ok, b.rows_error, p.full_name as uploaded_by
            from upload_batch b left join person p on p.id = b.uploaded_by
           order by b.uploaded_at desc limit p_limit) x
$$;

create or replace function upload_kinds()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(k) order by k.load_order), '[]'::jsonb)
    from (select kind, load_order, needs, implemented from upload_kind) k
$$;

-- ------------------------------------------------------------- exposure
-- These are the only entry points the hosted shell may call, and it calls
-- them as service_role. Nothing is granted to anon or authenticated: the
-- shell authenticates the person itself and then acts on their behalf.
do $$
declare f text;
begin
  foreach f in array array[
    'auth_salt(text)','auth_login(text,text,text)','auth_whoami(text)',
    'auth_signout(text)','upload_stage(text,text,jsonb,uuid)',
    'upload_preview(uuid)','upload_apply_audited(uuid,uuid)',
    'upload_cancel(uuid,uuid)','upload_history(integer)','upload_kinds()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

comment on function upload_stage is
  'Stage and validate one file in a single transaction. The batch, its rows '
  'and the audit entry commit together; nothing reaches a master table.';
comment on function auth_login is
  'Compares a caller-computed hash against the stored one. The stored hash '
  'never leaves the database, and the raw session token never enters it.';
