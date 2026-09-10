// PMS. 44 admin settings drive it and no number lives here: every threshold,
// weight and cap is read from setting(). Bottom-up closure is enforced by
// pms_window_may_open() in the schema, not by a check in this file.
//
// Scoping, which is the thing this file gets asked about most: a score belongs
// to a PERSON, not to a chair. One person holding two chairs still carries one
// score — "so one person cannot carry two different numbers depending on who is
// looking". pms_cycle is unique on (person_id, period) and every child row
// hangs off cycle_id. The chair is still how AUTHORITY is resolved (D7: a
// manager may act on chairs at or below their own), so the endpoints below are
// addressed by chair and resolve chair -> holder -> cycle before writing.
const { Router } = require('express');
const { one, many, tx } = require('../db');
const { requireChair, mayWriteChair } = require('../scope');

const r = Router();
// app_setting is the only copy — the appraisal engine, the Settings screen and
// this file all read the same row.
const setting = async (k, d) => {
  const s = await one(`select value from app_setting where key = $1`, [k]);
  return s ? s.value : d;
};

// The person currently sitting in a chair. Primary holder wins the tie.
const holderOf = (chairId) => one(
  `select person_id from chair_holder
    where chair_id = $1 and to_date is null
    order by is_primary desc, from_date asc
    limit 1`,
  [chairId]
);

// The chair a person currently sits in. Authority is resolved against this.
const chairOf = (personId) => one(
  `select chair_id from chair_holder
    where person_id = $1 and to_date is null
    order by is_primary desc, from_date asc
    limit 1`,
  [personId]
);

// A cycle, with the chair its person currently sits in — that chair is what the
// caller's write authority is checked against.
const cycleScope = (cycleId) => one(
  `select c.id, c.person_id, c.period, coalesce(c.chair_id, ch.chair_id) as chair_id
     from pms_cycle c
     left join chair_holder ch
       on ch.person_id = c.person_id and ch.to_date is null and ch.is_primary
    where c.id = $1`,
  [cycleId]
);

// Your own current cycle. Scoped to the signed-in person: a cycle is personal,
// so there is no such thing as "the" open cycle shared across everybody.
r.get('/cycle/current', requireChair, async (req, res, next) => {
  try {
    const cycle = await one(
      `select * from pms_cycle
        where person_id = $1 and state <> 'CLOSED'
        order by period desc limit 1`,
      [req.person.id]
    );
    if (!cycle) return res.json({ cycle: null, empty: 'No cycle is open. HR opens the window.' });

    const [mayOpen, components, score, ledger] = await Promise.all([
      one(`select pms_window_may_open($1, $2) as ok`, [req.person.id, cycle.period]),
      many(
        `select kind, raw, weight_pct, note from pms_component
          where cycle_id = $1 order by kind`,
        [cycle.id]
      ),
      one(`select * from pms_cycle_score($1)`, [cycle.id]),
      many(
        `select source_kind, half, points, reason, applied, over_cap, at
           from pms_adjustment where cycle_id = $1 order by at, id`,
        [cycle.id]
      ),
    ]);

    res.json({
      cycle, components, score, ledger,
      mayOpen: mayOpen.ok,
      blocked: mayOpen.ok ? null : 'Someone below you has not closed. Your window opens when they do.',
      cap: Number(await setting('pms_cut_cap', '2')),
      // final is null, not zero, when HR has not set the cycle's bases yet
      unscored: score && score.final === null
        ? 'Your cycle is open but its starting scores have not been set yet.'
        : null,
    });
  } catch (e) { next(e); }
});

// An adjustment past the shared monthly cap is still recorded — and flagged to
// HR. The old system would have silently dropped it.
//
// `half` is which half of the score the movement comes out of. Attributes are
// spent first and floor at zero; that floor is what pushes the cost into the KPI
// half instead of into negative numbers.
r.post('/adjustment', requireChair, async (req, res, next) => {
  const { cycleId, kind, half, points, reason } = req.body;
  try {
    if (!reason) return res.status(400).json({ error: 'reason_required' });
    if (!['ESCALATION', 'WARNING', 'APPRECIATION', 'ASSISTANCE'].includes(kind))
      return res.status(400).json({ error: 'bad_kind',
        reason: 'An adjustment is caused by an escalation, warning, appreciation or assistance request.' });
    const theHalf = (half || 'ATTRIBUTE').toUpperCase();
    if (!['ATTRIBUTE', 'KPI'].includes(theHalf))
      return res.status(400).json({ error: 'bad_half', reason: 'A movement comes out of ATTRIBUTE or KPI.' });

    const target = await cycleScope(cycleId);
    if (!target) return res.status(404).json({ error: 'no_such_cycle' });
    if (!(await mayWriteChair(req.scope, target.chair_id)))
      return res.status(403).json({ error: 'out_of_subtree',
        reason: 'You may only adjust chairs at or below your own.' });

    const out = await tx(req.person.id, async (t) => {
      const cap = Number(await setting('pms_monthly_cap', '2'));
      // the cap is shared across escalations and warnings together, per cycle
      const used = (await t.q(
        `select coalesce(sum(abs(points)),0) as used from pms_adjustment
          where cycle_id = $1 and applied`, [cycleId]
      )).rows[0].used;
      const overCap = Number(used) + Math.abs(points) > cap;

      const a = (await t.q(
        `insert into pms_adjustment
           (cycle_id, source_kind, half, points, reason, actor_id, over_cap, capped)
         values ($1,$2,$3,$4,$5,$6,$7,$7) returning id, half, points, over_cap`,
        [cycleId, kind, theHalf, points, reason, req.person.id, overCap]
      )).rows[0];

      await t.audit('PMS_ADJUSTED', 'person', target.person_id, null,
        { points, kind, half: theHalf, overCap });

      // past the cap the movement still stands; HR is told rather than the row
      // being dropped
      if (overCap) await t.q(
        `insert into notification (person_id, at, kind, text)
         select p.id, now(), 'PMS_OVER_CAP', $1
           from person p where p.department = 'Human Resources'
            and p.employment_status = 'ACTIVE'`,
        ['An adjustment of ' + points + ' exceeded the ' + cap
          + '-point shared monthly cap and was recorded anyway.']
      );
      return { id: a.id, half: a.half, overCap, cap };
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// Raising an escalation, warning, appreciation or approved idea against a
// person, and letting it move their score automatically.
//
// The cascade itself lives in the database (pms_cascade_apply): Attributes
// absorb first and floor at zero, the remainder spills into KPI at that kind's
// rate, and the month's spill is capped — what the cap refuses is recorded and
// flagged to HR rather than dropped. Every number it uses is an app_setting
// row, so changing a rule is a config edit and never a deploy.
//
// Deliberately NOT wired to case creation: an escalation that has only been
// alleged must not dock somebody's appraisal before it is upheld. The caller
// fires this when the outcome is decided.
r.post('/raise', requireChair, async (req, res, next) => {
  const { kind, aboutPersonId, body, caseId, period } = req.body;
  try {
    if (!['ESCALATION', 'WARNING', 'APPRECIATION', 'ASSISTANCE'].includes(kind))
      return res.status(400).json({ error: 'bad_kind' });
    if (!aboutPersonId) return res.status(400).json({ error: 'about_person_required' });
    if (aboutPersonId === req.person.id)
      return res.status(403).json({ error: 'not_about_yourself',
        reason: 'You cannot raise something against yourself that moves your own score.' });

    const chair = await chairOf(aboutPersonId);
    if (!chair) return res.status(409).json({ error: 'person_unseated',
      reason: 'That person holds no chair, so there is no line of authority to check this against.' });
    if (!(await mayWriteChair(req.scope, chair.chair_id)))
      return res.status(403).json({ error: 'out_of_subtree',
        reason: 'You may only raise this against chairs at or below your own.' });

    // the period a cycle is keyed by is the first of the month
    const p = period || new Date().toISOString().slice(0, 7) + '-01';

    const out = await tx(req.person.id, async (t) => {
      // A raisable must land somewhere even if HR has not opened the window
      // yet — the movement is evidence and cannot be lost. The cycle is
      // created PENDING; its bases stay unset until HR opens it.
      const cycle = (await t.q(
        `insert into pms_cycle (person_id, period, chair_id, state)
         values ($1, $2, $3, 'PENDING')
         on conflict (person_id, period) do update set person_id = excluded.person_id
         returning id`,
        [aboutPersonId, p, chair.chair_id]
      )).rows[0];

      const ref = (await t.q(
        `select 'RSE-' || lpad((coalesce(max(substring(ref from 5)::int),0)+1)::text, 5, '0') as ref
           from raisable`
      )).rows[0].ref;

      const rs = (await t.q(
        `insert into raisable (kind, ref, raised_by, about_person, case_id, body)
         values ($1,$2,$3,$4,$5,$6) returning id, ref`,
        [kind, ref, req.person.id, aboutPersonId, caseId || null, body || null]
      )).rows[0];

      // ASSISTANCE carries no score impact of its own; it becomes a task on
      // the responder and only escalates if it is ignored.
      let movements = [];
      if (kind !== 'ASSISTANCE') {
        movements = (await t.q(
          `select * from pms_cascade_apply($1,$2,$3,$4,$5)`,
          [cycle.id, kind, rs.id, req.person.id, rs.ref + ' — ' + kind.toLowerCase()]
        )).rows;
        const applied = movements.filter((m) => m.applied)
          .reduce((s, m) => s + Number(m.points), 0);
        await t.q(`update raisable set pms_points = $2 where id = $1`, [rs.id, applied]);
      }

      await t.audit('RAISABLE_RAISED', 'person', aboutPersonId, null,
        { kind, ref: rs.ref, movements });
      return { ref: rs.ref, cycleId: cycle.id, movements };
    });

    // what the cap refused is HR's business, not a silent no-op
    if (out.movements.some((m) => !m.applied)) {
      await tx(req.person.id, (t) => t.q(
        `insert into notification (person_id, at, kind, text)
         select p.id, now(), 'PMS_OVER_CAP', $1 from person p
          where p.department = 'Human Resources' and p.employment_status = 'ACTIVE'`,
        [out.ref + ' went beyond the monthly cascade cap. It is recorded against the cycle but was not taken off the score.']
      ));
    }
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// KPI targets are set BY THE MANAGER and are read-only to the holder. The
// database enforces the same thing (kpi_target_not_self), so a mistake here
// cannot let somebody set their own number.
r.put('/kpi/:kpiId/target', requireChair, async (req, res, next) => {
  const { chairId, period, target } = req.body;
  try {
    if (!(await mayWriteChair(req.scope, chairId)) || req.scope.chairIds.includes(chairId))
      return res.status(403).json({ error: 'not_your_target',
        reason: 'A target is set by your manager, not by you.' });

    const holder = await holderOf(chairId);
    if (!holder) return res.status(409).json({ error: 'chair_empty',
      reason: 'Nobody holds that chair yet, so there is nobody to carry the target.' });

    const out = await tx(req.person.id, async (t) => {
      const before = (await t.q(
        `select target_value from kpi_target where kpi_id = $1 and period = $2`,
        [req.params.kpiId, period])).rows[0];
      await t.q(
        `insert into kpi_target (kpi_id, person_id, period, target_value, set_by, set_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (kpi_id, period) do update
            set target_value = excluded.target_value, person_id = excluded.person_id,
                set_by = excluded.set_by, set_at = now()`,
        [req.params.kpiId, holder.person_id, period, target, req.person.id]
      );
      await t.audit('KPI_TARGET_SET', 'kpi', req.params.kpiId, before || null, { period, target });
      return { ok: true };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// The daily filing. One submission per person per day carrying every KPI figure
// — the whole day is one act, one window and one 23:59 cutoff, which is why the
// values arrive together rather than one row per KPI.
//
// entered_at is when the person typed it (from the device) and received_at is
// when the server got it. A filing that reaches the server more than 24 hours
// after it was entered is refused by the database; past that window it has to
// come through the administrator reopen path, which records a reason.
r.post('/daily', requireChair, async (req, res, next) => {
  const { countDate, values, reopenReason, enteredAt, enteredOffline, deviceRef, syncAttempts } = req.body;
  try {
    if (!values || typeof values !== 'object')
      return res.status(400).json({ error: 'values_required',
        reason: 'A daily filing carries the figures for the day.' });

    const out = await tx(req.person.id, async (t) => {
      const existing = (await t.q(
        `select id, locked_at from daily_count
          where person_id = $1 and count_date = $2 for update`,
        [req.person.id, countDate]
      )).rows[0];
      if (existing && existing.locked_at && !reopenReason)
        throw Object.assign(new Error('day_locked'), { status: 409,
          reason: 'That day is locked. Reopening needs a reason.' });

      const row = (await t.q(
        `insert into daily_count
           (person_id, count_date, values, entered_at, entered_offline, device_ref,
            sync_attempts, locked_at, reopened_by, reopen_reason)
         values ($1,$2,$3, coalesce($4::timestamptz, now()), coalesce($5,false), $6,
                 coalesce($7,0), now(), $8, $9)
         on conflict (person_id, count_date) do update
            set values = excluded.values, entered_at = excluded.entered_at,
                entered_offline = excluded.entered_offline, device_ref = excluded.device_ref,
                sync_attempts = excluded.sync_attempts, locked_at = now(),
                reopened_by = excluded.reopened_by, reopen_reason = excluded.reopen_reason
         returning id, count_date, locked_at`,
        [req.person.id, countDate, JSON.stringify(values), enteredAt || null,
         enteredOffline ?? null, deviceRef || null, syncAttempts ?? null,
         reopenReason ? req.person.id : null, reopenReason || null]
      )).rows[0];

      await t.audit(reopenReason ? 'DAILY_REOPENED' : 'DAILY_UPDATE_FILED', 'daily_count', countDate,
        existing || null, { reason: reopenReason || null });
      return row;
    });
    res.status(201).json(out);
  } catch (e) {
    // daily_count_sync_window: the filing is older than the 24-hour window
    if (e && e.code === '23514' && /sync_window/.test(e.constraint || ''))
      return res.status(409).json({ error: 'sync_window_closed',
        reason: 'This filing is more than 24 hours old. An administrator has to reopen the day.' });
    next(e);
  }
});

// A dispute freezes the score and pulls HR in, on a working-hours clock.
r.post('/dispute', requireChair, async (req, res, next) => {
  const { cycleId, reason } = req.body;
  try {
    if (!reason) return res.status(400).json({ error: 'reason_required' });
    const target = await cycleScope(cycleId);
    if (!target) return res.status(404).json({ error: 'no_such_cycle' });
    if (target.person_id !== req.person.id && !(await mayWriteChair(req.scope, target.chair_id)))
      return res.status(403).json({ error: 'not_yours' });

    const hrs = Number(await setting('pms_dispute_hrs', '48'));
    const out = await tx(req.person.id, async (t) => {
      const d = (await t.q(
        `insert into pms_dispute (cycle_id, raised_by, reason, hr_due)
         values ($1,$2,$3, working_hours_after(now(), $4))
         returning id, hr_due`,
        [cycleId, req.person.id, reason, hrs]
      )).rows[0];
      await t.audit('PMS_DISPUTE_OPENED', 'person', target.person_id, null,
        { reason, hrDue: d.hr_due });
      return d;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// Missed the window and asks HR to reopen it. Unanswered requests become
// escalations against HR, so the clock is recorded rather than implied.
r.post('/exception', requireChair, async (req, res, next) => {
  const { cycleId, reason } = req.body;
  try {
    if (!reason) return res.status(400).json({ error: 'reason_required' });
    const target = await cycleScope(cycleId);
    if (!target) return res.status(404).json({ error: 'no_such_cycle' });
    if (target.person_id !== req.person.id && !(await mayWriteChair(req.scope, target.chair_id)))
      return res.status(403).json({ error: 'out_of_subtree' });

    const hrs = Number(await setting('pms_exc_hrs', '48'));
    const out = await tx(req.person.id, async (t) => {
      const e = (await t.q(
        `insert into pms_exception (cycle_id, requested_by, reason, hr_due, due_at, state)
         values ($1,$2,$3, working_hours_after(now(), $4), working_hours_after(now(), $4), 'PENDING')
         returning id, hr_due, due_at`,
        [cycleId, req.person.id, reason, hrs]
      )).rows[0];
      await t.audit('PMS_EXCEPTION_REQUESTED', 'person', target.person_id, null,
        { reason, dueAt: e.due_at });
      return e;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

module.exports = r;
