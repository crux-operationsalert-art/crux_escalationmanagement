// Bulk upload. The lifecycle the Data setup screen already describes:
//
//   "Validate -> preview -> apply · nothing is written before you have seen
//    the preview"
//   "A file with any error applies zero rows — there is no partial load."
//
// The validators and the appliers live in the database (upload_validate,
// upload_apply) so the guarantee holds even if somebody loads a file by
// another route. This file parses the CSV, keeps the row numbers the person
// sees in their spreadsheet, and hands the rest over.
const { Router } = require('express');
const { one, many, tx } = require('../db');

const r = Router();

// Uploads replace masters wholesale and carry personal data. Administrator
// work, like the reopen path.
function requireAdmin(req, res, next) {
  if (req.person && req.person.app_role === 'ADMIN') return next();
  return res.status(403).json({ error: 'admin_only',
    reason: 'Loading masters is administrator work.' });
}

// The exact headers each loader reads, with the rule for every column, taken
// from the template generator in the application so a file is right before it
// is uploaded rather than rejected after.
const SPEC = {
  'People': [
    ['employee_no', 'EMP-0114', 'Required, unique. Your own numbering; it becomes the person key.'],
    ['full_name', 'Amit Kulkarni', 'Required.'],
    ['work_email', 'amit.kulkarni@cruxindia.co.in', 'Required, unique. Checked for near-duplicates — a misspelt domain is rejected, not accepted as a second person.'],
    ['mobile', '9021469966', 'Required. Used for sign-in by OTP where there is no Google account.'],
    ['chair', 'Branch Manager — Pune', 'Required. Must already exist in the structure.'],
    ['reports_to_employee_no', 'EMP-0088', 'Required except for the top chair.'],
    ['date_of_joining', '2023-01-12', 'YYYY-MM-DD. Roll-ups count from this date, never before it.'],
    ['employment_type', 'Employee', 'Employee, Partner, Intern or Contract.'],
  ],
  'Geography': [
    ['group', 'Zone A', 'Optional.'],
    ['region', 'West', 'Optional. East, West, North, South, Central or North-East.'],
    ['zone', 'Pune', 'Required, unique after trimming.'],
    ['state', 'Maharashtra', 'Optional.'],
    ['city', 'Pune', 'Optional.'],
  ],
  'Clients and branches': [
    ['client_code', 'SBI', 'Required, unique.'],
    ['client_name', 'State Bank of India', 'Required.'],
    ['branch_code', 'SBIN0030421', 'Required and unique within the client.'],
    ['branch_name', 'Kothrud', 'Required.'],
    ['zone', 'Pune', 'Required. Must exist in the Geography file.'],
    ['address', 'Kothrud, Pune 411038', 'Optional.'],
    ['status', 'ACTIVE', 'ACTIVE or INACTIVE.'],
  ],
  'Assignments': [
    ['client_code', 'SBI', 'Required. Must exist.'],
    ['zone', 'Pune', 'Required. Must exist.'],
    ['product', 'Home loan', 'Optional. Blank means every product for that client at that location.'],
    ['handler_employee_no', 'EMP-0114', 'Required. Must exist in People.'],
    ['location_head_employee_no', 'EMP-0088', 'Optional.'],
    ['effective_from', '2026-04-01', 'Required, YYYY-MM-DD.'],
    ['effective_to', '', 'Blank for open-ended. Overlapping dates on the same client, zone and product is an error.'],
  ],
  'Rates': [
    ['client_code', 'SBI', 'Required. Must already exist.'],
    ['zone', 'Pune', 'Blank means every location for this client.'],
    ['rate', '196.00', 'Required. Non-negative, up to two decimals.'],
    ['currency', 'INR', 'Optional, defaults to INR.'],
    ['effective_from', '2026-07-01', 'Required. Records before this date keep the rate that applied then.'],
    ['effective_to', '', 'Blank for open-ended. Must be after effective_from.'],
    ['reason', 'Revised on renewal', 'Recommended. Stored against the rate version.'],
  ],
  'Collections': [
    ['period', '2026-09', 'Required, YYYY-MM.'],
    ['client_code', 'SBI', 'Required.'],
    ['zone', 'Pune', 'Required.'],
    ['billed', '540960.00', 'Required. What was invoiced.'],
    ['collected', '412300.00', 'Required. What was received.'],
  ],
  'KPI targets': [
    ['period', '2026-09', 'Required, YYYY-MM.'],
    ['employee_no', 'EMP-0114', 'Required.'],
    ['kpi_name', 'Field verifications completed', 'Required. Must match a KPI on that chair.'],
    ['target', '1200', 'Required.'],
    ['unit', 'count', 'count, %, score or ₹ lakh.'],
    ['sub_category', 'SBI · Pune', 'Optional. Sub-category targets must add up to the KPI target.'],
  ],
  'Past performance': [
    ['file_part', 'mtd', 'Required. One of mtd, revenue or collections. Load mtd first.'],
    ['period', '2026-08', 'Required, YYYY-MM. Load oldest month first.'],
    ['employee_no', 'EMP-0114', 'Required for file_part = mtd.'],
    ['kpi_name', 'Field verifications completed', 'Required for mtd. Must match a loaded KPI target.'],
    ['sub_category', 'SBI · Pune', 'Optional.'],
    ['client_code', 'SBI', 'Required for revenue and collections.'],
    ['location_code', 'PUN', 'Required for revenue and collections.'],
    ['branch_code', 'BR-00747', 'Optional.'],
    ['target', '1050', 'Optional on mtd.'],
    ['achieved', '1092', 'Required for mtd.'],
    ['mtd_achieved', '1092', 'Required for mtd.'],
    ['invoiced_inr', '1842000', 'Required for revenue. Whole rupees, no commas.'],
    ['realised_inr', '1610000', 'Required for revenue.'],
    ['opening_outstanding_inr', '940000', 'Required for collections.'],
    ['collected_inr', '612000', 'Required for collections.'],
    ['closing_outstanding_inr', '328000', 'Required for collections. Opening minus collected must equal closing.'],
    ['owner_employee_no', 'EMP-0114', 'Recommended on revenue and collections.'],
    ['source', 'Force1 export', 'Recommended. Where the number came from.'],
  ],
  'Holidays': [
    ['date', '2026-11-08', 'Required, YYYY-MM-DD.'],
    ['name', 'Diwali', 'Required.'],
    ['scope', 'Festival', 'National, Festival, or a state name.'],
    ['confirmed', 'no', 'yes or no. A moon-sighting date stays no until it is fixed: an unconfirmed day is shown but never shortens a deadline.'],
  ],
  'Opening balances': [
    ['record_type', 'escalation', 'escalation, ogl_assignment or claim.'],
    ['reference', 'ESC-00193', 'Required, unique.'],
    ['created_at', '2026-08-27T15:26:00', 'Required. The real creation time — clocks are computed from this.'],
    ['current_state', 'OPEN', 'Must be a state that type actually has.'],
    ['owner_employee_no', 'EMP-0114', 'Required.'],
    ['client_code', 'SBI', 'Optional.'],
    ['zone', 'Pune', 'Optional.'],
  ],
};

// Minimal RFC4180 parser: quoted fields, embedded commas, doubled quotes,
// CRLF. Small enough to read, which is why it is here rather than a package.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((rw) => rw.some((v) => String(v).trim() !== ''));
}

r.get('/kinds', async (_req, res, next) => {
  try {
    res.json({ kinds: await many(
      `select kind, load_order, needs, implemented from upload_kind order by load_order`) });
  } catch (e) { next(e); }
});

// A real file with the exact headers, one example row, and every rule — so
// the file is right before it is uploaded rather than rejected after.
r.get('/template/:kind', (req, res) => {
  const spec = SPEC[req.params.kind];
  if (!spec) return res.status(404).json({ error: 'no_template', reason: 'No template for ' + req.params.kind });
  const esc = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const lines = [
    ['Crux bulk upload template', req.params.kind].map(esc).join(','),
    ['Row below the header is an example - delete it before uploading.'].map(esc).join(','),
    ['A file with any error applies zero rows.'].map(esc).join(','),
    '',
    spec.map((c) => esc(c[0])).join(','),
    spec.map((c) => esc(c[1])).join(','),
    '',
    'NOTES',
    ...spec.map((c) => [c[0], c[2]].map(esc).join(',')),
  ];
  res.type('text/csv')
     .set('content-disposition', `attachment; filename="crux-${req.params.kind.replace(/\s+/g, '-').toLowerCase()}-template.csv"`)
     .send(lines.join('\n'));
});

// Upload: parse, stage, validate. Writes nothing to any master table — the
// batch sits in PREVIEW until somebody has looked at it.
r.post('/', requireAdmin, async (req, res, next) => {
  const { kind, fileName, csv, rows } = req.body;
  try {
    const k = await one(`select kind, implemented from upload_kind where kind = $1`, [kind]);
    if (!k) return res.status(400).json({ error: 'bad_kind',
      reason: 'Unknown file kind. GET /api/upload/kinds lists them in load order.' });
    if (!csv && !Array.isArray(rows))
      return res.status(400).json({ error: 'no_file', reason: 'Send csv text or a rows array.' });

    // header row is line 1 of the sheet, so data starts at line 2 — the row
    // numbers reported back are the ones the person can see
    let parsed = rows;
    if (!parsed) {
      const grid = parseCsv(csv);
      if (grid.length < 2) return res.status(400).json({ error: 'empty_file' });
      const header = grid[0].map((h) => String(h).trim());
      parsed = grid.slice(1).map((line) =>
        Object.fromEntries(header.map((h, i) => [h, line[i] === undefined ? '' : line[i]])));
    }
    if (!parsed.length) return res.status(400).json({ error: 'empty_file' });

    const out = await tx(req.person.id, async (t) => {
      const batch = (await t.q(
        `insert into upload_batch (kind, file_name, uploaded_by) values ($1,$2,$3) returning id`,
        [kind, fileName || 'upload.csv', req.person.id]
      )).rows[0];

      for (const [i, row] of parsed.entries()) {
        await t.q(`insert into upload_row (batch_id, row_no, raw) values ($1,$2,$3)`,
          [batch.id, i + 2, JSON.stringify(row)]);
      }
      const counts = (await t.q(`select * from upload_validate($1)`, [batch.id])).rows[0];
      await t.audit('UPLOAD_STAGED', 'upload_batch', batch.id, null,
        { kind, rows: counts.rows_total, errors: counts.rows_error });
      return { batchId: batch.id, ...counts };
    });

    const errors = await many(
      `select row_no, error, raw from upload_row where batch_id = $1 and error is not null
        order by row_no limit 200`, [out.batchId]);

    res.status(201).json({
      ...out, errors,
      implemented: k.implemented,
      applicable: k.implemented && out.rows_error === 0,
      note: out.rows_error > 0
        ? `${out.rows_error} row(s) must be fixed first — a file with any error applies zero rows.`
        : (k.implemented ? 'Nothing has been written yet. Apply to load these rows.'
                         : 'This file validated, but no loader is implemented for this kind yet.'),
    });
  } catch (e) { next(e); }
});

// The preview: what would be written, and every row that would stop it.
r.get('/:id', requireAdmin, async (req, res, next) => {
  try {
    const batch = await one(`select * from upload_batch where id = $1`, [req.params.id]);
    if (!batch) return res.status(404).json({ error: 'not_found' });
    const errors = await many(
      `select row_no, error, raw from upload_row where batch_id = $1 and error is not null
        order by row_no limit 200`, [req.params.id]);
    const sample = await many(
      `select row_no, raw from upload_row where batch_id = $1 and error is null
        order by row_no limit 20`, [req.params.id]);
    res.json({ batch, errors, sample });
  } catch (e) { next(e); }
});

// Apply. All or nothing — the database refuses a batch with any errored row.
r.post('/:id/apply', requireAdmin, async (req, res, next) => {
  try {
    const out = await tx(req.person.id, async (t) => {
      const applied = (await t.q(`select * from upload_apply($1,$2)`,
        [req.params.id, req.person.id])).rows[0];
      await t.audit('UPLOAD_APPLIED', 'upload_batch', req.params.id, null, applied);
      return applied;
    });
    res.json({ ...out, note: 'Loaded.' });
  } catch (e) {
    if (e && e.code === '23514')
      return res.status(409).json({ error: 'has_errors', reason: e.message });
    next(e);
  }
});

r.post('/:id/cancel', requireAdmin, async (req, res, next) => {
  try {
    const out = await tx(req.person.id, async (t) => {
      const b = (await t.q(
        `update upload_batch set state = 'CANCELLED' where id = $1 and state = 'PREVIEW'
         returning id, state`, [req.params.id])).rows[0];
      if (!b) throw Object.assign(new Error('not_cancellable'), { status: 409 });
      await t.audit('UPLOAD_CANCELLED', 'upload_batch', req.params.id, null, null);
      return b;
    });
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = r;
