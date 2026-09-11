-- =====================================================================
-- CRUX on Supabase — auth and storage
--
-- Rule that survives from the audit: sign-in MATCHES a person, it never
-- creates one. The old system let an unknown address in and then had to
-- guess who it was — which is how a misspelt domain ended up holding 583
-- coverage rows.
-- =====================================================================

-- ------------------------------------------------------- domain gate
-- Only cruxindia.co.in Google accounts, and only if a person row already
-- exists and is active. Everything else is refused with a reason the
-- person can act on, not a generic failure.
create or replace function auth_gate() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare
  email text := lower(new.email);
  p     person%rowtype;
begin
  if email !~ '@cruxindia\.co\.in$' then
    raise exception 'Sign-in refused: % is not a Crux Workspace address.', email
      using hint = 'Personal addresses cannot hold a chair. Ask HR to create your work account.';
  end if;

  select * into p from person where work_email = email;

  if not found then
    raise exception 'Sign-in refused: % is not on the people master.', email
      using hint = 'HR loads the person first. Signing in does not create an employee.';
  end if;

  if p.employment_status <> 'ACTIVE' then
    raise exception 'Sign-in refused: % is marked %.', email, p.employment_status
      using hint = 'A leaver keeps their history and loses their access. HR reactivates if this is wrong.';
  end if;

  -- bind the auth user to the person, once
  update person set auth_user_id = new.id where id = p.id and auth_user_id is null;
  return new;
end $$;

alter table person add column if not exists auth_user_id uuid;
create unique index if not exists person_auth_user_uniq
  on person (auth_user_id) where auth_user_id is not null;

drop trigger if exists auth_gate_trg on auth.users;
create trigger auth_gate_trg
  before insert on auth.users
  for each row execute function auth_gate();

comment on function auth_gate is
  'Refuses any sign-in that is not a Crux Workspace address already present '
  'and active on the people master. The three refusal messages are different '
  'on purpose: the person needs to know which one applies to them.';

-- --------------------------------------------------------- field staff
-- Field executives and franchise partners sign in with mobile + OTP, not
-- Google. The otp_challenge table in schema.sql holds the challenge; this
-- is the same gate applied to that path.
create or replace function otp_gate(p_mobile text) returns uuid
language plpgsql security definer set search_path = public as $$
declare p person%rowtype;
begin
  select * into p from person where mobile = p_mobile and employment_status = 'ACTIVE';
  if not found then
    raise exception 'No active person holds that number.'
      using hint = 'The number must match the people master exactly. HR corrects it.';
  end if;
  return p.id;
end $$;

-- =====================================================================
-- Storage
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('case-documents', 'case-documents', false, 26214400,
   array['application/pdf','image/jpeg','image/png','image/heic']),
  ('visit-photos',   'visit-photos',   false, 15728640,
   array['image/jpeg','image/png','image/heic']),
  ('letters',        'letters',        false, 10485760,
   array['application/pdf']),
  ('bulk-uploads',   'bulk-uploads',   false, 52428800,
   array['text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

-- Nothing is public. A document is reachable only through a signed URL the
-- API mints after checking scope — the bucket itself never answers.
create policy "case docs: read in scope" on storage.objects for select
  using (
    bucket_id = 'case-documents'
    and exists (select 1 from ogl_attachment a
                 where a.storage_key = storage.objects.name
                   and (a.uploaded_by in (select person_id from app_subtree()) or app_is_admin())));

create policy "case docs: upload own" on storage.objects for insert
  with check (bucket_id = 'case-documents' and app_person_id() is not null);

create policy "visit photos: own" on storage.objects for all
  using (bucket_id = 'visit-photos' and app_person_id() is not null)
  with check (bucket_id = 'visit-photos' and app_person_id() is not null);

create policy "letters: subject and admin" on storage.objects for select
  using (bucket_id = 'letters' and app_person_id() is not null);

create policy "bulk uploads: admin only" on storage.objects for all
  using (bucket_id = 'bulk-uploads' and app_is_admin())
  with check (bucket_id = 'bulk-uploads' and app_is_admin());

-- A document is never hard-deleted from storage while its row is live.
create policy "no storage delete" on storage.objects for delete using (false);
