// The matrix. Completeness is computed by branch_matrix_state and never stored
// (rule R-01), so "693 complete" is always a fact about the current rows.
const { Router } = require('express');
const { one, many, tx } = require('../db');
const { requireChair, emptyReason } = require('../scope');

const r = Router();

r.get('/branch/:branchId', requireChair, async (req, res) => {
  const branches = await req.scope.branches();
  if (!branches.some((b) => b.id === req.params.branchId))
    return res.status(403).json({ error: 'out_of_scope' });
  if (req.scope.clientView === 'none')
    return res.status(403).json({ error: 'no_client_view', reason: 'Your function does not see client data.' });

  const rows = await many(
    `select level, level_name, name, mobile, email, inherited
       from branch_effective_matrix where branch_id = $1 order by level`,
    [req.params.branchId]
  );
  const state = await one(`select complete_levels from branch_matrix_state where branch_id = $1`, [req.params.branchId]);
  res.json({
    levels: req.scope.clientView === 'contacts'
      ? rows.map(({ level, level_name, name, inherited }) => ({ level, level_name, name, inherited }))
      : rows,
    completeLevels: state ? state.complete_levels : 0,
    dispatchEligible: (state ? state.complete_levels : 0) === 5,
  });
});

r.put('/branch/:branchId/level/:level', requireChair, async (req, res, next) => {
  const { name, mobile, email, levelName } = req.body;
  try {
    const branches = await req.scope.branches();
    const b = branches.find((x) => x.id === req.params.branchId);
    if (!b) return res.status(403).json({ error: 'out_of_scope' });
    if (req.scope.clientView !== 'matrix')
      return res.status(403).json({ error: 'read_only', reason: 'Operations owns the matrix.' });

    const out = await tx(req.person.id, async (t) => {
      const before = (await t.q(
        `select name, mobile, email from matrix_contact where branch_id = $1 and level = $2`,
        [req.params.branchId, req.params.level]
      )).rows[0] || null;
      await t.q(
        `insert into matrix_contact (client_id, branch_id, level, level_name, name, mobile, email, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,now())
         on conflict (branch_id, level) where branch_id is not null
         do update set level_name = excluded.level_name, name = excluded.name,
                       mobile = excluded.mobile, email = excluded.email,
                       updated_by = excluded.updated_by, updated_at = now()`,
        [b.client_id, req.params.branchId, req.params.level,
         levelName || 'Level ' + req.params.level, name, mobile, email, req.person.id]
      );
      await t.audit('MATRIX_SET', 'branch', b.code + '#L' + req.params.level, before, { name, mobile, email });
      const s = (await t.q(`select complete_levels from branch_matrix_state where branch_id = $1`, [req.params.branchId])).rows[0];
      return { completeLevels: s.complete_levels, dispatchEligible: s.complete_levels === 5 };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// The incomplete-matrix chase list. All four channels, per the owner's rule.
r.get('/incomplete', requireChair, async (req, res) => {
  const branches = await req.scope.branches();
  if (!branches.length) return res.json({ branches: [], empty: emptyReason(req.scope) });
  const rows = await many(
    `select b.id, b.code, b.name, cl.name as client, s.complete_levels,
            5 - s.complete_levels as missing
       from branch b
       join client cl on cl.id = b.client_id
       join branch_matrix_state s on s.branch_id = b.id
      where b.id = any($1) and b.status = 'ACTIVE' and s.complete_levels < 5
      order by s.complete_levels, cl.name, b.name`,
    [branches.map((x) => x.id)]
  );
  res.json({ branches: rows });
});

module.exports = r;
