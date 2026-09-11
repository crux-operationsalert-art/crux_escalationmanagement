-- =====================================================================
-- CRUX — schema patch v17
-- Mail: the transport, and a route to it that needs no Workspace admin.
--
-- The outbox has existed since the base schema and has never had a way
-- out of the building. This patch gives it one, and deliberately gives it
-- more than one, because the person who administers this tool does not
-- administer the Google Workspace it sits in and cannot be made to wait
-- for somebody who does.
--
--   * An HTTPS transactional provider — resend, sendgrid, brevo,
--     postmark. Needs a domain and DNS, which the tool admin can obtain,
--     and no Workspace console at all.
--   * gmail_oauth — the Gmail API on the administrator's own mailbox,
--     using the OAuth client that already exists for sign-in. Adding the
--     gmail.send scope to a client in Testing mode, for oneself as a test
--     user, is a thing an ordinary account can do.
--
-- SMTP is deliberately absent. An edge function may open an HTTPS request
-- and nothing else; there is no socket to port 587 from here. A Gmail app
-- password is therefore not a route this tool can take, whatever the
-- internet says, and saying so now is cheaper than finding out later.
--
-- Nothing here stores a key in a file. Keys are app_setting rows flagged
-- secret, written through mail_configure and never read back out to a
-- browser — mail_status answers whether a key is set, not what it is.
-- Run after schema-patch-v16.sql.
-- =====================================================================

-- ------------------------------------------------------------ settings
insert into app_setting (key, value, plain_language, group_name, secret, editable_by)
values
  ('mail_oauth_client_id', '',
   'The OAuth client that sends mail, if you are sending through Gmail. Usually the same client as sign-in.',
   'Mail', false, 'ADMIN'),
  ('mail_oauth_refresh_token', '',
   'The long-lived grant from the mailbox that sends. Obtained once, by consenting in a browser; never shown again.',
   'Mail', true, 'ADMIN')
on conflict (key) do nothing;

-- ---------------------------------------------------------- the sender's view
-- service_role only. This is the one function that hands out secrets, and
-- it exists so the sending function can get them without the browser ever
-- being on the path.
create or replace function mail_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from app_setting
   where key in ('mail_provider','mail_from','mail_from_name','mail_reply_to',
                 'mail_api_key','mail_daily_cap',
                 'mail_oauth_client_id','mail_oauth_client_secret',
                 'mail_oauth_refresh_token','google_client_id')
$$;

-- ---------------------------------------------------------- the admin's view
-- Everything the Mail screen needs and not one character of any key.
create or replace function mail_status()
returns jsonb language sql stable security definer set search_path = public as $$
  with s as (select key, value from app_setting where key like 'mail%' or key = 'google_client_id')
  select jsonb_build_object(
    'provider',  nullif((select value from s where key='mail_provider'), ''),
    'from',      nullif((select value from s where key='mail_from'), ''),
    'fromName',  nullif((select value from s where key='mail_from_name'), ''),
    'replyTo',   nullif((select value from s where key='mail_reply_to'), ''),
    -- whether, never what
    'keySet',    coalesce(nullif((select value from s where key='mail_api_key'), ''), '') <> '',
    'oauthSet',  coalesce(nullif((select value from s where key='mail_oauth_refresh_token'), ''), '') <> ''
                 and coalesce(nullif((select value from s where key='mail_oauth_client_secret'), ''), '') <> '',
    'oauthClientId', coalesce(nullif((select value from s where key='mail_oauth_client_id'), ''),
                              nullif((select value from s where key='google_client_id'), '')),
    'ready',     case
                   when (select value from s where key='mail_provider') = 'gmail_oauth'
                     then coalesce(nullif((select value from s where key='mail_oauth_refresh_token'), ''), '') <> ''
                   when coalesce((select value from s where key='mail_provider'), '') <> ''
                     then coalesce(nullif((select value from s where key='mail_api_key'), ''), '') <> ''
                          and coalesce(nullif((select value from s where key='mail_from'), ''), '') <> ''
                   else false end,
    'cap',       coalesce(nullif((select value from s where key='mail_daily_cap'), ''), '1500')::int,
    'sentToday', coalesce((select recipients_sent from mail_budget where day = current_date), 0),
    'queued',    (select count(*) from outbox where state = 'QUEUED'),
    'deferred',  (select count(*) from outbox where state = 'DEFERRED'),
    'sent',      (select count(*) from outbox where state = 'SENT'),
    'abandoned', (select count(*) from outbox where state = 'ABANDONED'),
    'lastError', (select last_error from outbox
                   where last_error is not null order by created_at desc limit 1),
    'recent',    coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
                    select template_key, recipient, subject, state, attempts,
                           last_error, sent_at, created_at
                      from outbox order by created_at desc limit 20) x), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------- writing
-- The key arrives here and stops here. A blank argument leaves the stored
-- value alone, so re-saving the from address does not silently wipe a key
-- the screen was never allowed to show.
create or replace function mail_configure(
  p_actor uuid, p_provider text default null, p_from text default null,
  p_from_name text default null, p_reply_to text default null,
  p_api_key text default null, p_cap text default null,
  p_oauth_client_id text default null, p_oauth_client_secret text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role role_kind; v_changed text[] := '{}';
begin
  select app_role into v_role from person
   where id = p_actor and employment_status = 'ACTIVE' and superseded_by is null;
  if v_role is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_admin',
      'reason','Mail settings are an administrator''s to change.');
  end if;

  if p_provider is not null then
    if p_provider <> '' and p_provider not in
       ('resend','sendgrid','brevo','postmark','gmail_oauth') then
      return jsonb_build_object('error','unknown_provider',
        'reason','Known providers are resend, sendgrid, brevo, postmark and gmail_oauth.');
    end if;
    update app_setting set value = p_provider, updated_by = p_actor, updated_at = now()
     where key = 'mail_provider';
    v_changed := v_changed || 'provider';
  end if;

  if p_from is not null then
    if p_from <> '' and p_from !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      return jsonb_build_object('error','bad_from',
        'reason','The from address does not look like an address.');
    end if;
    update app_setting set value = p_from, updated_by = p_actor, updated_at = now()
     where key = 'mail_from';
    v_changed := v_changed || 'from';
  end if;

  if p_from_name is not null then
    update app_setting set value = p_from_name, updated_by = p_actor, updated_at = now()
     where key = 'mail_from_name'; v_changed := v_changed || 'from_name';
  end if;
  if p_reply_to is not null then
    update app_setting set value = p_reply_to, updated_by = p_actor, updated_at = now()
     where key = 'mail_reply_to'; v_changed := v_changed || 'reply_to';
  end if;
  if p_oauth_client_id is not null then
    update app_setting set value = p_oauth_client_id, updated_by = p_actor, updated_at = now()
     where key = 'mail_oauth_client_id'; v_changed := v_changed || 'oauth_client_id';
  end if;

  -- a blank secret means "leave it alone", not "clear it". Clearing is its
  -- own verb, below, so it cannot happen by a form submitting an empty box.
  if coalesce(p_api_key,'') <> '' then
    update app_setting set value = p_api_key, updated_by = p_actor, updated_at = now()
     where key = 'mail_api_key'; v_changed := v_changed || 'api_key';
  end if;
  if coalesce(p_oauth_client_secret,'') <> '' then
    update app_setting set value = p_oauth_client_secret, updated_by = p_actor, updated_at = now()
     where key = 'mail_oauth_client_secret'; v_changed := v_changed || 'oauth_client_secret';
  end if;

  if p_cap is not null and p_cap ~ '^\d+$' then
    update app_setting set value = p_cap, updated_by = p_actor, updated_at = now()
     where key = 'mail_daily_cap';
    update mail_budget set cap = p_cap::int where day = current_date;
    v_changed := v_changed || 'cap';
  end if;

  insert into audit_entry (actor_id, action, entity_type, entity_ref, new_value)
  values (p_actor, 'MAIL_CONFIGURED', 'app_setting', 'mail',
          jsonb_build_object('changed', v_changed));   -- names, never values

  return mail_status() || jsonb_build_object('changed', to_jsonb(v_changed));
end $$;

create or replace function mail_forget_secrets(p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role role_kind;
begin
  select app_role into v_role from person where id = p_actor;
  if v_role is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_admin');
  end if;
  update app_setting set value = '', updated_by = p_actor, updated_at = now()
   where key in ('mail_api_key','mail_oauth_client_secret','mail_oauth_refresh_token');
  insert into audit_entry (actor_id, action, entity_type, entity_ref)
  values (p_actor, 'MAIL_SECRETS_CLEARED', 'app_setting', 'mail');
  return mail_status();
end $$;

-- Written by the sending function after the browser consent round trip.
create or replace function mail_oauth_save(p_actor uuid, p_refresh_token text, p_from text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role role_kind;
begin
  select app_role into v_role from person where id = p_actor;
  if v_role is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_admin');
  end if;
  if coalesce(btrim(p_refresh_token),'') = '' then
    return jsonb_build_object('error','no_token',
      'reason','Google returned no refresh token. That happens when the mailbox '
             ||'has already consented once — revoke the grant at '
             ||'myaccount.google.com/permissions and try again.');
  end if;
  update app_setting set value = p_refresh_token, updated_by = p_actor, updated_at = now()
   where key = 'mail_oauth_refresh_token';
  if coalesce(btrim(p_from),'') <> '' then
    update app_setting set value = btrim(p_from), updated_by = p_actor, updated_at = now()
     where key = 'mail_from';
  end if;
  update app_setting set value = 'gmail_oauth', updated_by = p_actor, updated_at = now()
   where key = 'mail_provider';
  insert into audit_entry (actor_id, action, entity_type, entity_ref, new_value)
  values (p_actor, 'MAIL_OAUTH_GRANTED', 'app_setting', 'mail',
          jsonb_build_object('sends_as', p_from));
  return mail_status();
end $$;

-- ------------------------------------------------------------- enqueuing
-- The idempotency key is derived here and cannot be supplied. Same event,
-- same recipient, same day is one row however many times the caller asks —
-- the old system produced 1,892 sends from 77 keys by trusting its callers.
create or replace function mail_enqueue(
  p_template text, p_recipient text, p_subject text, p_body text,
  p_entity_type text default null, p_entity_id uuid default null,
  p_cc text default null, p_not_before timestamptz default now(),
  p_scope text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid;
begin
  if coalesce(btrim(p_recipient),'') = '' then
    return jsonb_build_object('error','no_recipient');
  end if;
  -- an address nobody can reach is not an error, but it is not a send either
  if lower(p_recipient) like '%@example.invalid' then
    return jsonb_build_object('skipped','placeholder_address','recipient',p_recipient);
  end if;

  v_key := encode(extensions.digest(concat_ws('|',
             p_template, lower(btrim(p_recipient)),
             coalesce(p_entity_type,''), coalesce(p_entity_id::text,''),
             coalesce(p_scope, current_date::text)), 'sha256'), 'hex');

  insert into outbox (idempotency_key, template_key, entity_type, entity_id,
                      recipient, cc_addr, subject, body, not_before)
  values (v_key, p_template, p_entity_type, p_entity_id,
          btrim(p_recipient), nullif(btrim(coalesce(p_cc,'')),''),
          p_subject, p_body, coalesce(p_not_before, now()))
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('duplicate', true, 'key', v_key);
  end if;
  return jsonb_build_object('id', v_id, 'key', v_key);
end $$;

-- One message to the person asking for it, so a provider can be proved
-- working without waiting for an escalation to happen.
create or replace function mail_test(p_actor uuid, p_to text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role role_kind; v_email text; v_name text; v_to text; r jsonb;
begin
  select app_role, work_email, full_name into v_role, v_email, v_name
    from person where id = p_actor;
  if v_role is distinct from 'ADMIN' then
    return jsonb_build_object('error','not_admin');
  end if;
  v_to := coalesce(nullif(btrim(coalesce(p_to,'')),''), v_email);

  r := mail_enqueue(
        'TEST', v_to,
        'Crux — test message',
        'This is a test from Crux, sent by ' || coalesce(v_name,'an administrator') ||
        ' at ' || to_char(ogl_ts(now()), 'DD Mon YYYY HH24:MI') || ' IST.' || E'\n\n' ||
        'If this reached you, the outbox has a way out of the building and ' ||
        'escalation mail will go the same way.',
        'app_setting', null, null, now(),
        -- scope by the minute, so a second test a minute later is a second send
        to_char(now(), 'YYYY-MM-DD HH24:MI'));

  if r ? 'skipped' then
    return jsonb_build_object('error','placeholder_address',
      'reason','That address is @example.invalid and cannot receive mail. '
             ||'Give a real one, or set your own work address on the people master.');
  end if;
  return r || jsonb_build_object('to', v_to);
end $$;

-- ---------------------------------------------------------------- exposure
do $$
declare f text;
begin
  foreach f in array array[
    'mail_settings()','mail_status()','mail_enqueue(text,text,text,text,text,uuid,text,timestamptz,text)',
    'mail_test(uuid,text)','mail_forget_secrets(uuid)','mail_oauth_save(uuid,text,text)',
    'mail_configure(uuid,text,text,text,text,text,text,text,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

comment on function mail_enqueue is
  'The only way into the outbox. The idempotency key is computed from the '
  'event, the recipient and the day and cannot be supplied by the caller, so '
  'the same notification asked for twice is one message.';
comment on function mail_status is
  'Everything the Mail screen shows. keySet and oauthSet answer whether a '
  'secret is present. No function returns one to a browser.';

-- ------------------------------------------------------------ scheduling
-- The sender runs as an edge function because only an edge function can
-- make an outbound HTTPS request. Nothing schedules an edge function, so
-- the database does it: pg_cron every minute, pg_net to knock on the door.
insert into app_setting (key, value, plain_language, group_name, secret, editable_by)
values ('function_base_url', 'https://oxpwqfbtbxlvuqpztbwg.supabase.co/functions/v1',
        'Where the tool answers. The scheduler calls the sender here.', 'Mail', false, 'ADMIN'),
       ('anon_key', '<the project''s publishable anon key>',
        'The public gateway key. Publishable by design - it opens no door on its own.', 'Mail', false, 'ADMIN'),
       ('mail_cron_secret', encode(extensions.gen_random_bytes(32),'hex'),
        'The shared secret the scheduler presents to the sender. Generated here; never typed by anyone.',
        'Mail', true, 'ADMIN')
on conflict (key) do nothing;

insert into job_config (job_key, enabled, cron)
values ('MAIL_DRAIN', true, '* * * * *')
on conflict (job_key) do nothing;

create or replace function mail_cron_secret()
returns text language sql stable security definer set search_path = public as $$
  select value from app_setting where key = 'mail_cron_secret'
$$;

create or replace function crux_mail_tick()
returns bigint language plpgsql security definer set search_path = public as $fn$
declare v_req bigint; v_url text; v_secret text; v_anon text;
begin
  if not coalesce((select enabled from job_config where job_key='MAIL_DRAIN'), true) then
    return null;
  end if;
  -- nothing waiting is the common case; do not wake the sender for it
  if not exists (select 1 from outbox where state in ('QUEUED','DEFERRED')) then
    return null;
  end if;

  select value into v_url    from app_setting where key = 'function_base_url';
  select value into v_secret from app_setting where key = 'mail_cron_secret';
  select value into v_anon   from app_setting where key = 'anon_key';

  select net.http_post(
    url := v_url || '/mail',
    headers := jsonb_build_object(
      'content-type','application/json',
      'authorization','Bearer ' || v_anon,
      'x-crux-cron', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into v_req;
  return v_req;
end $fn$;

revoke all on function crux_mail_tick() from public, anon, authenticated;
revoke all on function mail_cron_secret() from public, anon, authenticated;
grant execute on function crux_mail_tick() to service_role;
grant execute on function mail_cron_secret() to service_role;

comment on function crux_mail_tick is
  'The scheduler''s hand on the sender. It carries the shared secret out of '
  'app_setting rather than having it written into a cron command, where '
  'anybody who can list jobs would read it. Returns nothing when the outbox '
  'is empty: the common case must not wake the sender.';

select cron.schedule('crux-mail', '* * * * *', 'select crux_mail_tick()');
