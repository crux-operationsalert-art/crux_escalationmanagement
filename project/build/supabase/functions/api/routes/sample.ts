// Sample data. The Data setup screen states the contract:
//
//   "Sample data fills only what the workbook could not answer. Every
//    placeholder is tagged at the row, so it can be counted here and removed
//    in one action — nothing the tracker actually said is touched."
//   Purge: "Tagged rows only — nothing real is touched."
//
// The tagging and the purge are both in the database (sample_row,
// sample_seed, sample_purge), so the guarantee does not depend on this file
// being the only way in.

import { Router, q, one, many, tx, enqueue, issueActivation } from "../shim.ts";
import { requireChair, emptyReason, mayWriteChair } from "../scope.ts";
const r = Router();

function requireAdmin(req, res, next) {
  if (req.person && req.person.app_role === 'ADMIN') return next();
  return res.status(403).json({ error: 'admin_only',
    reason: 'Sample data is administrator work.' });
}

// What the tab shows: "N placeholder rows or fields", broken down.
r.get('/', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await many(`select table_name, rows from sample_count()`);
    res.json({
      tables: rows,
      total: rows.reduce((s, x) => s + Number(x.rows), 0),
      note: rows.length
        ? 'Every row here is tagged. Removing them touches nothing real.'
        : 'No placeholder data is loaded.',
    });
  } catch (e) { next(e); }
});

r.post('/seed', requireAdmin, async (req, res, next) => {
  try {
    const out = await tx(req.person.id, async (t) => {
      const rows = (await t.q(`select table_name, rows from sample_seed($1)`, [req.person.id])).rows;
      await t.audit('SAMPLE_SEEDED', 'sample_row', null, null,
        { tables: rows.length, rows: rows.reduce((s, x) => s + Number(x.rows), 0) });
      return rows;
    });
    res.status(201).json({ tables: out, total: out.reduce((s, x) => s + Number(x.rows), 0) });
  } catch (e) {
    if (/already loaded/.test(e.message || ''))
      return res.status(409).json({ error: 'already_loaded',
        reason: 'Sample data is already loaded. Remove it first.' });
    next(e);
  }
});

// One action, as the screen promises.
r.post('/purge', requireAdmin, async (req, res, next) => {
  try {
    const out = await tx(req.person.id, async (t) => {
      const rows = (await t.q(`select table_name, removed from sample_purge()`)).rows;
      await t.audit('SAMPLE_PURGED', 'sample_row', null,
        { rows: rows.reduce((s, x) => s + Number(x.removed), 0) }, null);
      return rows;
    });
    res.json({
      tables: out,
      total: out.reduce((s, x) => s + Number(x.removed), 0),
      note: 'Tagged rows only. Nothing real was touched.',
    });
  } catch (e) { next(e); }
});

export default r;
