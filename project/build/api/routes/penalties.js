// Penalty engine. Administrator, HR and Finance may add, edit and delete rules
// with no approval step (may_edit_penalty_rule in the schema decides, not this
// file). An amount, once instanced, is frozen: a later rule change never
// rewrites history.
const { Router } = require('express');
const { one, many, tx } = require('../db');
const { requireChair } = require('../scope');

const r = Router();

const mayEdit = async (personId) =>
  (await one(`select may_edit_penalty_rule($1) as ok`, [personId])).ok;

r.get('/rules', requireChair, async (req, res) => {
  res.json({
    rules: await many(`select * from penalty_rule order by code`),
    mayEdit: await mayEdit(req.person.id),
  });
});

r.put('/rules/:id', requireChair, async (req, res, next) => {
  try {
    if (!(await mayEdit(req.person.id)))
      return res.status(403).json({ error: 'not_permitted', reason: 'Administrator, HR and Finance own the penalty rules.' });
    const { label, amount, cutoffDay, frequency, appliesToList, recoveredBy, active } = req.body;
    const out = await tx(req.person.id, async (t) => {
      const before = (await t.q(`select * from penalty_rule where id = $1`, [req.params.id])).rows[0];
      const after = (await t.q(
        `update penalty_rule set label=$2, amount=$3, cutoff_day=$4, frequency=$5,
                applies_to_list=$6, recovered_by=$7, active=$8
          where id = $1 returning *`,
        [req.params.id, label, amount, cutoffDay, frequency, appliesToList, recoveredBy, active]
      )).rows[0];
      await t.audit('PENALTY_RULE_EDITED', 'penalty_rule', before.code, before, after);
      return after;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Instancing freezes the amount and routes recovery: partners are billed by
// Finance, employees recovered through payroll by HR.
r.post('/instance', requireChair, async (req, res, next) => {
  const { ruleId, personId, period, note } = req.body;
  try {
    const out = await tx(req.person.id, async (t) => {
      const rule = (await t.q(`select code, amount, active from penalty_rule where id = $1`, [ruleId])).rows[0];
      if (!rule || !rule.active) throw Object.assign(new Error('rule_inactive'), { status: 400 });
      const route = (await t.q(`select penalty_recovery_for($1,$2) as via`, [personId, ruleId])).rows[0].via;
      const pi = (await t.q(
        `insert into penalty_instance (rule_id, person_id, period, amount, state, recovered_by, note, raised_by, at)
         values ($1,$2,$3,$4,'RAISED',$5,$6,$7,now()) returning id, amount, recovered_by`,
        [ruleId, personId, period, rule.amount, route, note || null, req.person.id]
      )).rows[0];
      await t.audit('PENALTY_RAISED', 'person', personId, null,
        { rule: rule.code, amount: pi.amount, period, recoveredBy: route });
      return pi;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.get('/ledger', requireChair, async (req, res) => {
  const scopeIds = req.scope.subtreeIds;
  res.json({
    ledger: await many(
      `select pi.id, pi.period, pi.amount, pi.state, pi.recovered_by, r.code, r.label,
              p.full_name, p.employee_type
         from penalty_instance pi
         join penalty_rule r on r.id = pi.rule_id
         join person p on p.id = pi.person_id
         join chair_holder chh on chh.person_id = p.id and chh.to_date is null
        where chh.chair_id = any($1)
        order by pi.period desc, p.full_name`,
      [scopeIds.length ? scopeIds : [req.scope.primaryChair.id]]
    ),
  });
});

module.exports = r;
