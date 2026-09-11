-- =====================================================================
-- CRUX — schema patch v15
-- The clock-driven half, with no machine either.
--
-- Edge functions answer requests; they do not run a loop. That was the last
-- thing said to need a server. pg_cron runs inside the database, so the
-- scheduled work that needs no mail transport needs no machine.
--
-- What this does NOT cover: sending. Draining the outbox means talking to a
-- mail provider, and that needs credentials the system does not have yet.
-- The queue fills correctly and waits; nothing is silently dropped.
--
-- job_config is honoured rather than bypassed: a job an administrator has
-- switched off does not run, and the reason it was switched off stays
-- readable. The old system's sweep had no such switch, which is why a
-- runaway job could only be stopped by deleting it.
-- Run after schema-patch-v14.sql.
-- =====================================================================

create extension if not exists pg_cron;

create or replace function crux_tick() returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_run uuid; v_closed int := 0; v_risk int := 0; v_breached int := 0;
begin
  insert into job_run (job_key, started_at, state)
  values ('CRUX_TICK', now(), 'RUNNING') returning id into v_run;

  -- R-05: a resolved case closes itself seven days later, on the schedule set
  -- when it was resolved rather than by a sweep guessing at it.
  if coalesce((select enabled from job_config where job_key='AUTO_CLOSE'), true) then
    with done as (
      update "case" set status = 'CLOSED', closed_at = now(), last_activity_at = now()
       where status = 'RESOLVED' and auto_close_at is not null and auto_close_at <= now()
      returning id
    )
    insert into case_event (case_id, at, kind, note)
    select id, now(), 'AUTO_CLOSED', 'Closed automatically seven days after resolution.' from done;
    get diagnostics v_closed = row_count;
  end if;

  -- SLA status is derived from the clock, never typed in. AT_RISK is a
  -- percentage of the TAT in BUSINESS minutes, not of wall-clock time — an
  -- assignment raised on Friday afternoon is not at risk because a weekend
  -- happened.
  if coalesce((select enabled from job_config where job_key='SLA_SWEEP'), true) then
    update sla_instance si set sla_status = 'BREACHED'
      where si.stopped_at is null and si.sla_status <> 'BREACHED'
        and now() > coalesce(si.extended_to, si.due_at);
    get diagnostics v_breached = row_count;

    update sla_instance si set sla_status = 'AT_RISK'
      from sla_rule r
     where r.id = si.sla_rule_id
       and si.stopped_at is null and si.sla_status = 'ON_TRACK'
       and business_minutes_between(si.started_at, now(), si.calendar_id)
           >= si.tat_business_minutes * r.at_risk_pct / 100.0;
    get diagnostics v_risk = row_count;
  end if;

  update job_run set finished_at = now(), state = 'DONE',
         counts = jsonb_build_object('auto_closed', v_closed,
                                     'sla_at_risk', v_risk, 'sla_breached', v_breached)
   where id = v_run;

  return jsonb_build_object('auto_closed', v_closed,
                            'sla_at_risk', v_risk, 'sla_breached', v_breached);
exception when others then
  update job_run set finished_at = now(), state = 'FAILED', error = sqlerrm where id = v_run;
  raise;
end $fn$;

insert into job_config (job_key, enabled, cron)
values ('AUTO_CLOSE', true, '*/15 * * * *'), ('SLA_SWEEP', true, '*/15 * * * *')
on conflict (job_key) do nothing;

-- every quarter hour; each run records itself in job_run, so a job that stops
-- running is visible as a gap rather than as silence
select cron.schedule('crux-tick', '*/15 * * * *', $c$select crux_tick()$c$);
