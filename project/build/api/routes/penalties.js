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

// The six decisions the rule editor asks for, in the editor's own order:
// who it applies to, the action, how often it is checked, the cutoff, the
// amount, who recovers it — plus the plain-language line shown to people.
// `cutoff` is a spec string ('23:59 same day', '3rd, 18:00', '48 working
// hours'), never a day number: a rule that fires on the 3rd at 18:00 cannot
// be expressed as an integer.
r.put('/rules/:id', requireChair, async (req, res, next) => {
  try {
    if (!(await mayEdit(req.person.id)))
      return res.status(403).json({ error: 'not_permitted', reason: 'Administrator, HR and Finance own the penalty rules.' });
    const { what, plainLanguage, amount, cutoffSpec, frequency, appliesToList, recoveredBy, active } = req.body;
    const out = await tx(req.person.id, async (t) => {
      const before = (await t.q(`select * from penalty_rule where id = $1`, [req.params.id])).rows[0];
      if (!before) throw Object.assign(new Error('not_found'), { status: 404 });
      // coalesce: an edit that omits a field leaves it alone rather than nulling
      // a not-null column out from under the rule.
      const after = (await t.q(
        `update penalty_rule set
                what            = coalesce($2, what),
                plain_language  = coalesce($3, plain_language),
                amount          = coalesce($4, amount),
                cutoff_spec     = coalesce($5, cutoff_spec),
                frequency       = coalesce($6, frequency),
                applies_to_list = coalesce($7, applies_to_list),
                recovered_by    = coalesce($8, recovered_by),
                active          = coalesce($9, active)
          where id = $1 returning *`,
        [req.params.id, what ?? null, plainLanguage ?? null, amount ?? null, cutoffSpec ?? null,
         frequency ?? null, appliesToList ?? null, recoveredBy ?? null,
         typeof active === 'boolean' ? active : null]
      )).rows[0];
      await t.audit('PENALTY_RULE_EDITED', 'penalty_rule', before.code, before, after);
      return after;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Instancing freezes the amount and routes recovery: partners are billed by
// Finance, employees recovered through payroll by HR.
// A penalty is never raised bare: the ledger shows the cutoff that was missed
// and the evidence that proves it, so both are required here rather than
// nullable. `evidence` is the sentence a disputing person argues against
// ('ESC-00193 · no response in 7 working days'), which is why it cannot be
// derived — the caller states it.
r.post('/instance', requireChair, async (req, res, next) => {
  const { ruleId, personId, period, occurredOn, cutoffMissed, evidence, entityType, entityId } = req.body;
  try {
    if (!evidence || !String(evidence).trim())
      return res.status(400).json({ error: 'evidence_required',
        reason: 'A penalty carries the evidence that proves it. The ledger shows this line to the person.' });

    const out = await tx(req.person.id, async (t) => {
      const rule = (await t.q(
        `select code, amount, active, cutoff_spec from penalty_rule where id = $1`, [ruleId])).rows[0];
      if (!rule || !rule.active) throw Object.assign(new Error('rule_inactive'), { status: 400 });

      // partners are billed by Finance, employees recovered through payroll by HR
      const route = (await t.q(`select penalty_recovery_for($1,$2) as via`, [personId, ruleId])).rows[0].via;

      const pi = (await t.q(
        `insert into penalty_instance
           (rule_id, person_id, period, occurred_on, cutoff_missed, evidence,
            entity_type, entity_id, amount, state, recovered_by)
         values ($1,$2,$3, coalesce($4::date, current_date), coalesce($5, $6), $7,
                 $8, $9, $10, 'APPLIED', $11)
         returning id, amount, recovered_by, occurred_on, cutoff_missed, evidence, state`,
        [ruleId, personId, period, occurredOn || null, cutoffMissed || null, rule.cutoff_spec,
         String(evidence).trim(), entityType || null, entityId || null, rule.amount, route]
      )).rows[0];

      await t.audit('PENALTY_RAISED', 'person', personId, null,
        { rule: rule.code, amount: pi.amount, period, recoveredBy: route,
          occurredOn: pi.occurred_on, evidence: pi.evidence });
      return pi;
    });
    res.status(201).json(out);
  } catch (e) {
    // penalty_no_duplicate (rule, person, occurred_on, entity) — the same
    // penalty raised twice for the same day is refused, not doubled.
    if (e && e.code === '23505')
      return res.status(409).json({ error: 'already_raised',
        reason: 'This rule has already been raised against this person for that date.' });
    next(e);
  }
});

r.get('/ledger', requireChair, async (req, res) => {
  const scopeIds = req.scope.subtreeIds;
  res.json({
    ledger: await many(
      `select pi.id, pi.period, pi.occurred_on, pi.cutoff_missed, pi.evidence,
              pi.amount, pi.state, pi.recovered_by, pi.recovered_at,
              r.code, r.what, r.plain_language,
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
