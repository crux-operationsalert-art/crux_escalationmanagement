-- =====================================================================
-- 60 · HISTORY — nothing is deleted, but machine noise does not become audit.
-- Defect 4: "Copy of PEOPLE_EVENTS" holds 449 NOTE rows that exist nowhere
-- else; the live tab holds 26. Rules:
--   H-01 the copy and the live tab are unioned, deduped on (person, at, note)
--   H-02 EMAIL_RETRY (1,740 of 5,913 AUDIT_LOG rows) is machine retry — it
--        becomes delivery history, not audit_entry (schema.sql note)
--   H-03 the e-mail storm is imported as history only. No outbox rows, no
--        idempotency keys, nothing queued. 1,892 STRIKE_1 sends stay dead.
--   H-04 SETTINGS keys 'WINOVR:*' were transactions in a config tab; they
--        become submission_window rows
--   H-05 Sheet4 is a debug scratchpad. It is archived, not migrated.
-- =====================================================================

-- H-01 · the rescued notes, source_ref keeps which tab they came from
insert into person_event (person_id, at, kind, note, source_ref)
select distinct on (pe.person_id, pe.at, pe.note)
       pe.person_id, pe.at, pe.kind, pe.note, pe.source_ref
from (
  select coalesce(p.superseded_by, p.id) as person_id, coalesce(stg.ts(e.at), now()) as at,
         upper(coalesce(nullif(btrim(e.kind),''),'NOTE')) as kind, btrim(e.note) as note,
         'PEOPLE_EVENTS!' || e.row_no as source_ref, 1 as pref
  from stg.people_events e join person p on p.work_email = stg.norm_email(e.person_email)
  where stg.present(e.note)
  union all
  select coalesce(p.superseded_by, p.id), coalesce(stg.ts(e.at), now()),
         upper(coalesce(nullif(btrim(e.kind),''),'NOTE')), btrim(e.note),
         'Copy of PEOPLE_EVENTS!' || e.row_no, 2
  from stg.people_events_copy e join person p on p.work_email = stg.norm_email(e.person_email)
  where stg.present(e.note)
) pe
order by pe.person_id, pe.at, pe.note, pe.pref;

insert into migration_merge (entity_type, kept_id, merged_key, rows_moved, rule)
select 'person_event', pe.id, pe.source_ref, 1,
       'H-01 rescued from the copy tab — this note existed in no live tab'
from person_event pe where pe.source_ref like 'Copy of PEOPLE_EVENTS!%';

-- H-02 · human actions only
insert into audit_entry (at, actor_id, action, entity_type, entity_ref, old_value, new_value)
select coalesce(stg.ts(a.at), now()), coalesce(p.superseded_by, p.id), upper(btrim(a.action)),
       lower(coalesce(nullif(btrim(a.entity_type),''),'unknown')), btrim(a.entity_ref),
       case when stg.present(a.old_value) then jsonb_build_object('text', a.old_value) end,
       case when stg.present(a.new_value) then jsonb_build_object('text', a.new_value) end
from stg.audit_log a left join person p on p.work_email = stg.norm_email(a.actor_email)
where stg.present(a.action) and upper(btrim(a.action)) not in ('EMAIL_RETRY','EMAIL_SEND','STRIKE_SWEEP','MONTHLY_DISPATCH');

-- H-02/H-03 · the storm, as delivery history with no queue behind it
insert into delivery (at, channel, recipient, state, error, entity_type, entity_id)
select coalesce(stg.ts(e.at), now()), 'EMAIL', stg.norm_email(e.recipient),
       case upper(coalesce(e.state,'')) when 'SENT' then 'SENT' else 'FAILED' end,
       nullif(btrim(e.error),''), 'LEGACY_EMAIL_LOG', null
from stg.email_log e where stg.present(e.recipient);

insert into job_run (job_key, started_at, finished_at, state, note)
select btrim(j.job_key), stg.ts(j.started_at), stg.ts(j.finished_at),
       upper(coalesce(nullif(btrim(j.state),''),'UNKNOWN')), nullif(btrim(j.note),'')
from stg.job_log j where stg.present(j.job_key);

-- every legacy job arrives disabled with the reason visible (no silent pause)
insert into job_config (job_key, enabled, disabled_reason)
select distinct btrim(job_key), false,
       'Migrated disabled. Re-enable only after the outbox has run one clean cycle (defect 1).'
from stg.job_log where stg.present(job_key)
on conflict (job_key) do nothing;

-- H-04 · window overrides out of the settings tab
insert into submission_window (kind, opens_at, closes_at, note)
select split_part(s.key, ':', 2), stg.ts(split_part(s.value, '|', 1)), stg.ts(split_part(s.value, '|', 2)),
       'Migrated from SETTINGS!' || s.row_no || ' — was a transaction in a config tab'
from stg.settings s where s.key like 'WINOVR:%'
on conflict do nothing;

-- H-04b · the 7 duplicate recipient-list keys collapse to one
insert into migration_merge (entity_type, kept_id, merged_key, rows_moved, rule)
select 'setting', gen_random_uuid(), s.key, 1,
       'H-04b duplicate recipient list — collapsed into notification.recipients'
from stg.settings s
where s.key in ('ALERT_TO','ALERT_CC','ESC_ALERT_TO','OPS_ALERT_TO','ADMIN_ALERT_TO','MIS_ALERT_TO','DAILY_ALERT_TO');

-- H-05 · the scratchpad is archived verbatim and never read again
create table if not exists stg.sheet4_archive as select * from stg.sheet4;
comment on table stg.sheet4_archive is 'Rule H-05. Production debug scratchpad, kept for evidence. Not a source for any app table.';

-- holidays and warnings were empty though the rules claimed to use them
insert into holiday (holiday_date, name)
select stg.ts(h.holiday_date)::date, coalesce(nullif(btrim(h.name),''),'Holiday')
from stg.holidays h where stg.present(h.holiday_date)
on conflict do nothing;

insert into migration_review (entity_type, entity_ref, question, context)
select 'holiday', 'HOLIDAYS', 'The strike clock excludes holidays but this tab is empty. Load the current FY calendar before cut-over.', null
where not exists (select 1 from stg.holidays where stg.present(holiday_date));
