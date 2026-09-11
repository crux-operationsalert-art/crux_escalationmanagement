-- =====================================================================
-- CRUX — schema patch v22
-- Evidence.
--
-- The storage buckets have been sitting there since the Supabase setup
-- went in, each with its own MIME allow-list and size limit, and nothing
-- could write to any of them. A field verification without a photograph
-- is one person's word.
--
-- The browser never holds a key. It asks for a URL that is good for one
-- file, in one place, for a few minutes, and puts the bytes there itself;
-- the key is computed here and cannot be supplied, because a caller who
-- names their own path can name somebody else's.
--
-- Run after schema-patch-v21.sql.
-- =====================================================================

alter table ogl_attachment
  add column if not exists requirement_id uuid references case_verification_requirement(id),
  add column if not exists caption text;

create index if not exists ogl_attachment_live
  on ogl_attachment (assignment_id, uploaded_at desc) where removed_at is null;

alter table ogl_attachment enable row level security;
alter table ogl_attachment force row level security;
revoke all on table ogl_attachment from anon, authenticated;

-- The extensions this accepts agree with what the buckets accept, and the
-- size limit goes back to the browser, so nobody picks a file, waits for it
-- to upload, and is told no at the end.
create or replace function ogl_attach_begin(
  p_assignment uuid, p_actor uuid, p_file_name text,
  p_doc_kind text default 'EVIDENCE', p_requirement uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; v_ext text; v_key text; v_may boolean;
  v_bucket text; v_limit bigint;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;

  v_may := p_actor in (a.assignor_id, a.allocated_to_id)
        or (select app_role from person where id = p_actor) = 'ADMIN'
        or exists (select 1 from temp_participant_grant g
                    where g.assignment_id = p_assignment and g.person_id = p_actor
                      and g.revoked_at is null and g.expires_at > now());
  if not v_may then
    return jsonb_build_object('error','not_yours',
      'reason','Only the people working on this assignment may attach to it.');
  end if;
  if a.current_state in ('CLOSED','CANCELLED') then
    return jsonb_build_object('error','finished',
      'reason','This assignment is ' || a.current_state || '. Reopen it first.');
  end if;
  if coalesce(btrim(coalesce(p_file_name,'')),'') = '' then
    return jsonb_build_object('error','no_file_name');
  end if;

  v_ext := lower(coalesce(substring(p_file_name from '\.([A-Za-z0-9]{1,5})$'), 'bin'));
  v_bucket := case v_ext
                when 'pdf' then 'case-documents'
                when 'jpg' then 'visit-photos' when 'jpeg' then 'visit-photos'
                when 'png' then 'visit-photos' when 'heic' then 'visit-photos'
                else null end;
  if v_bucket is null then
    return jsonb_build_object('error','unsupported_type',
      'reason','Attach a photograph (jpg, png or heic) or a PDF. "' || v_ext || '" is neither.');
  end if;

  select file_size_limit into v_limit from storage.buckets where id = v_bucket;

  -- assignment/cycle/uuid: readable enough to find by hand, and impossible
  -- to guess your way into
  v_key := a.ref || '/' || a.breach_cycle_no || '/' ||
           gen_random_uuid()::text || '.' || v_ext;

  return jsonb_build_object('bucket', v_bucket, 'key', v_key, 'ext', v_ext,
    'ref', a.ref, 'cycle', a.breach_cycle_no, 'max_bytes', v_limit,
    'mime', case v_ext when 'pdf' then 'application/pdf'
                       when 'png' then 'image/png'
                       when 'heic' then 'image/heic'
                       else 'image/jpeg' end);
end $fn$;

create or replace function ogl_attach_done(
  p_assignment uuid, p_actor uuid, p_key text, p_file_name text,
  p_mime text default null, p_bytes bigint default null,
  p_doc_kind text default 'EVIDENCE', p_requirement uuid default null,
  p_caption text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare a assignment%rowtype; v_id uuid;
begin
  select * into a from assignment where id = p_assignment;
  if not found then return jsonb_build_object('error','no_such_assignment'); end if;
  -- the key has to be one we would have issued for this assignment
  if p_key not like (a.ref || '/%') then
    return jsonb_build_object('error','key_mismatch',
      'reason','That storage key does not belong to this assignment.');
  end if;

  insert into ogl_attachment (assignment_id, requirement_id, doc_kind, file_name,
    party_kind, party_seq, storage_key, mime, bytes, uploaded_by, uploaded_at, caption)
  values (p_assignment, p_requirement, upper(coalesce(nullif(btrim(p_doc_kind),''),'EVIDENCE')),
    btrim(p_file_name), 'APPLICANT', 1, p_key, p_mime, p_bytes, p_actor, now(), p_caption)
  returning id into v_id;

  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (p_assignment, 'EVIDENCE_ATTACHED', p_actor,
          jsonb_build_object('attachment', v_id, 'file', btrim(p_file_name),
                             'requirement', p_requirement, 'bytes', p_bytes));

  return jsonb_build_object('id', v_id, 'file_name', btrim(p_file_name));
end $fn$;

create or replace function ogl_attachments(p_assignment uuid, p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare d jsonb;
begin
  -- borrow ogl_detail's scoping rather than write a second version of it
  d := ogl_detail(p_assignment, p_person);
  if d ? 'error' then return d; end if;

  return jsonb_build_object('attachments', coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'file_name', t.file_name,
             'doc_kind', t.doc_kind, 'caption', t.caption, 'bytes', t.bytes,
             'mime', t.mime, 'key', t.storage_key,
             'bucket', case when t.storage_key like '%.pdf' then 'case-documents' else 'visit-photos' end,
             'point', (select r.force1_point_id from case_verification_requirement r
                        where r.id = t.requirement_id),
             'by', (select full_name from person where id = t.uploaded_by),
             'at', t.uploaded_at) order by t.uploaded_at desc)
      from ogl_attachment t
     where t.assignment_id = p_assignment and t.removed_at is null), '[]'::jsonb));
end $fn$;

-- Removed, not deleted: the row stays and says who took it down.
create or replace function ogl_attach_remove(p_attachment uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare t ogl_attachment%rowtype; a assignment%rowtype;
begin
  select * into t from ogl_attachment where id = p_attachment;
  if not found then return jsonb_build_object('error','no_such_attachment'); end if;
  select * into a from assignment where id = t.assignment_id;
  if p_actor not in (t.uploaded_by, a.assignor_id)
     and (select app_role from person where id = p_actor) is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_yours',
      'reason','The person who attached it, the assignor, or an administrator.');
  end if;
  update ogl_attachment set removed_at = now(), removed_by = p_actor
   where id = p_attachment and removed_at is null;
  insert into assignment_event (assignment_id, event_type, actor_id, payload)
  values (t.assignment_id, 'EVIDENCE_REMOVED', p_actor,
          jsonb_build_object('attachment', p_attachment, 'file', t.file_name));
  return jsonb_build_object('id', p_attachment, 'removed', true);
end $fn$;

do $do$
declare f text;
begin
  foreach f in array array[
    'ogl_attach_begin(uuid,uuid,text,text,uuid)',
    'ogl_attach_done(uuid,uuid,text,text,text,bigint,text,uuid,text)',
    'ogl_attachments(uuid,uuid)','ogl_attach_remove(uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
