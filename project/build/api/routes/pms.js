// PMS. 44 admin settings drive it and no number lives here: every threshold,
// weight and cap is read from setting(). Bottom-up closure is enforced by
// pms_window_may_open() in the schema, not by a check in this file.
const { Router } = require('express');
const { one, many, tx } = require('../db');
const { requireChair, mayWriteChair } = require('../scope');

const r = Router();
const setting = async (k, d) => {
  const s = await one(`select value from setting where key = $1`, [k]);
  return s ? s.value : d;
};

r.get('/cycle/current', requireChair, async (req, res) => {
  const chair = req.scope.primaryChair;
  const cycle = await one(`select * from pms_cycle where state <> 'CLOSED' order by period desc limit 1`);
  if (!cycle) return res.json({ cycle: null, empty: 'No cycle is open. HR opens the window.' });
  const mayOpen = await one(`select pms_window_may_open($1, $2) as ok`, [chair.id, cycle.id]);
  const components = await many(
    `select c.kind, c.label, c.weight, c.raw_score, c.weighted
       from pms_component c where c.cycle_id = $1 and c.chair_id = $2 order by c.kind, c.label`,
    [cycle.id, chair.id]
  );
  const balance = await one(`select pms_attribute_balance($1, $2) as balance`, [chair.id, cycle.id]);
  res.json({
    cycle, components, attributeBalance: balance.balance,
    mayOpen: mayOpen.ok,
    blocked: mayOpen.ok ? null : 'Someone below you has not closed. Your window opens when they do.',
    cap: Number(await setting('pms_monthly_cap', '2')),
  });
});

// An adjustment past the shared monthly cap is still recorded — and flagged to
// HR. The old system would have silently dropped it.
r.post('/adjustment', requireChair, async (req, res, next) => {
  const { chairId, cycleId, kind, points, reason } = req.body;
  try {
    if (!(await mayWriteChair(req.scope, chairId)))
      return res.status(403).json({ error: 'out_of_subtree', reason: 'You may only adjust chairs at or below your own.' });
    if (!reason) return res.status(400).json({ error: 'reason_required' });

    const out = await tx(req.person.id, async (t) => {
      const cap = Number(await setting('pms_monthly_cap', '2'));
      const used = (await t.q(
        `select coalesce(sum(abs(points)),0) as used from pms_adjustment
          where chair_id = $1 and cycle_id = $2`, [chairId, cycleId]
      )).rows[0].used;
      const overCap = Number(used) + Math.abs(points) > cap;
      const a = (await t.q(
        `insert into pms_adjustment (chair_id, cycle_id, kind, points, reason, actor_id, over_cap, at)
         values ($1,$2,$3,$4,$5,$6,$7,now()) returning id`,
        [chairId, cycleId, kind, points, reason, req.person.id, overCap]
      )).rows[0];
      await t.audit('PMS_ADJUSTED', 'chair', chairId, null, { points, kind, overCap });
      if (overCap) await t.q(
        `insert into notification (person_id, at, kind, title, body)
         select p.id, now(), 'PMS_OVER_CAP', 'Adjustment past the monthly cap',
                $2 from person p where p.department = 'Human Resources'`,
        [null, 'An adjustment of ' + points + ' exceeded the ' + cap + '-point shared cap and was recorded anyway.']
      );
      return { id: a.id, overCap, cap };
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// KPI targets are set BY THE MANAGER and are read-only to the holder.
r.put('/kpi/:kpiId/target', requireChair, async (req, res, next) => {
  const { chairId, period, target } = req.body;
  try {
    if (!(await mayWriteChair(req.scope, chairId)) || req.scope.chairIds.includes(chairId))
      return res.status(403).json({ error: 'not_your_target', reason: 'A target is set by your manager, not by you.' });
    const out = await tx(req.person.id, async (t) => {
      const before = (await t.q(`select target_value from kpi_target where kpi_id=$1 and period=$2`, [req.params.kpiId, period])).rows[0];
      await t.q(
        `insert into kpi_target (kpi_id, period, target_value, set_by, set_at)
         values ($1,$2,$3,$4,now())
         on conflict (kpi_id, period) do update set target_value = excluded.target_value, set_by = excluded.set_by, set_at = now()`,
        [req.params.kpiId, period, target, req.person.id]
      );
      await t.audit('KPI_TARGET_SET', 'kpi', req.params.kpiId, before || null, { period, target });
      return { ok: true };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Daily counts. A closed day reopens only with a reason (schema constraint).
r.post('/daily', requireChair, async (req, res, next) => {
  const { countDate, values, reopenReason } = req.body;
  try {
    const out = await tx(req.person.id, async (t) => {
      const existing = (await t.q(
        `select id, closed_at from daily_count where person_id = $1 and count_date = $2 for update`,
        [req.person.id, countDate]
      )).rows[0];
      if (existing && existing.closed_at && !reopenReason)
        throw Object.assign(new Error('day_closed'), { status: 409, reason: 'That day is closed. Reopening needs a reason.' });
      const row = (await t.q(
        `insert into daily_count (person_id, count_date, values, closed_at, reopened_by, reopen_reason)
         values ($1,$2,$3, now(), $4, $5)
         on conflict (person_id, count_date) do update
            set values = excluded.values, closed_at = now(),
                reopened_by = excluded.reopened_by, reopen_reason = excluded.reopen_reason
         returning id`,
        [req.person.id, countDate, JSON.stringify(values), reopenReason ? req.person.id : null, reopenReason || null]
      )).rows[0];
      await t.audit(reopenReason ? 'DAILY_REOPENED' : 'DAILY_CLOSED', 'daily_count', countDate,
        existing || null, { reason: reopenReason || null });
      return row;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// Disputes and exceptions. An exception request carries a 48-hour clock.
r.post('/dispute', requireChair, async (req, res, next) => {
  const { cycleId, componentId, claim } = req.body;
  try {
    const out = await tx(req.person.id, async (t) => {
      const d = (await t.q(
        `insert into pms_dispute (cycle_id, component_id, raised_by, claim, state, at)
         values ($1,$2,$3,$4,'OPEN',now()) returning id`,
        [cycleId, componentId, req.person.id, claim]
      )).rows[0];
      await t.audit('PMS_DISPUTE_OPENED', 'pms_component', componentId, null, { claim });
      return d;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.post('/exception', requireChair, async (req, res, next) => {
  const { cycleId, chairId, kind, reason } = req.body;
  try {
    if (!(await mayWriteChair(req.scope, chairId))) return res.status(403).json({ error: 'out_of_subtree' });
    const out = await tx(req.person.id, async (t) => {
      const e = (await t.q(
        `insert into pms_exception (cycle_id, chair_id, kind, reason, requested_by, created_at, due_at, state)
         values ($1,$2,$3,$4,$5, now(), now() + interval '48 hours', 'PENDING') returning id, due_at`,
        [cycleId, chairId, kind, reason, req.person.id]
      )).rows[0];
      await t.audit('PMS_EXCEPTION_REQUESTED', 'chair', chairId, null, { kind, dueAt: e.due_at });
      return e;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

module.exports = r;
