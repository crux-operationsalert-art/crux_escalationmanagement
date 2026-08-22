/**
 * gas-harness.js — run the real server-side sources under Node.
 *
 * Apps Script has no local test runner, so security behaviour was only ever
 * verifiable by clicking around the deployed app. This harness loads the actual
 * .gs files into a sandbox with the Apps Script globals stubbed and the real
 * exported sheet data behind an in-memory table layer, so auth decisions can be
 * asserted in CI instead of by hand.
 *
 * It is a TEST fixture. It is not part of the Apps Script project and is never
 * pushed to it (only src/ is).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CSV_DIR = process.env.CRUX_CSV_DIR || '/tmp/db/csv';

/* ---------------- minimal CSV reader (quoted fields, embedded newlines) ------ */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
}

function loadTables() {
  const tables = {};
  if (fs.existsSync(CSV_DIR)) {
    for (const f of fs.readdirSync(CSV_DIR)) {
      if (!f.endsWith('.csv')) continue;
      const rows = parseCsv(fs.readFileSync(path.join(CSV_DIR, f), 'utf8'));
      if (!rows.length) continue;
      const header = rows[0];
      tables[f.replace(/\.csv$/, '')] = rows.slice(1)
        .filter(r => r.some(c => String(c).trim() !== ''))
        .map(r => { const o = {}; header.forEach((h, i) => o[h] = r[i] === undefined ? '' : r[i]); return o; });
    }
  }
  return tables;
}

function createSandbox(opts = {}) {
  const tables = opts.tables || loadTables();
  tables.SESSIONS = tables.SESSIONS || [];
  const props = {};
  let seq = 0;

  // Identity the stub reports for Session.getActiveUser(). '' models the
  // out-of-domain case, which is the whole reason the token path exists.
  const state = { activeUser: opts.activeUser || '', effectiveUser: opts.effectiveUser || 'shantanu.suravase@cruxindia.co.in' };

  const sandbox = {
    console,
    Object, Array, String, Number, Boolean, Math, JSON, Date, RegExp, Error, isNaN, parseInt, parseFloat,
    __tables: tables,
    __state: state,

    Session: {
      getActiveUser: () => ({ getEmail: () => state.activeUser }),
      getEffectiveUser: () => ({ getEmail: () => state.effectiveUser }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      computeDigest: (_alg, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      formatDate: (d, _tz, fmt) => {
        const p = (n, w = 2) => String(n).padStart(w, '0');
        if (fmt === 'd') return String(d.getDate());
        if (fmt === 'yyyy/MM/dd') return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
        if (fmt === 'yyyy-MM') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+05:30`;
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => props[k] === undefined ? null : props[k],
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Logger: { log: (...a) => { if (process.env.CRUX_VERBOSE) console.log('[Logger]', ...a); } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.example/exec' }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    SpreadsheetApp: { openById: () => { throw new Error('not stubbed'); } },
    MailApp: { getRemainingDailyQuota: () => 1000 },
    GmailApp: {},
    HtmlService: {},
    UrlFetchApp: {},
  };

  // ---- in-memory table layer, replacing Sheets.gs -------------------------
  const api = {
    readTable_: (n) => (tables[n] = tables[n] || []).map(r => Object.assign({}, r)),
    invalidateTableCache_: () => {},
    ensureSpreadsheet_: () => ({ getUrl: () => 'https://sheets.example' }),
    appendRow_: (n, o) => { (tables[n] = tables[n] || []).push(Object.assign({}, o)); return o; },
    updateRowById_: (n, idField, idValue, patch) => {
      const rows = tables[n] = tables[n] || [];
      const want = String(idValue).toLowerCase();
      const r = rows.find(x => String(x[idField] || '').toLowerCase() === want);
      if (r) Object.assign(r, patch);
      return r;
    },
    findRowById_: (n, idField, idValue) => (tables[n] || [])
      .find(x => String(x[idField] || '').toLowerCase() === String(idValue).toLowerCase()) || null,
    deleteRowById_: (n, idField, idValue) => {
      const rows = tables[n] = tables[n] || [];
      const i = rows.findIndex(x => String(x[idField] || '') === String(idValue));
      if (i >= 0) rows.splice(i, 1);
    },
    getSetting_: (k, d) => {
      const r = (tables.SETTINGS || []).find(x => x.Key === k);
      const v = r ? String(r.Value || '') : '';
      return v !== '' ? v : (d === undefined ? '' : d);
    },
    getBoolSetting_: (k, d) => String(api.getSetting_(k, d)).toLowerCase() === 'true',
    setSetting_: (k, v, user) => {
      const rows = tables.SETTINGS = tables.SETTINGS || [];
      const r = rows.find(x => x.Key === k);
      if (r) { r.Value = v; r.UpdatedBy = user || ''; }
      else rows.push({ Key: k, Value: v, Description: '', UpdatedAt: '', UpdatedBy: user || '' });
    },
    logAudit_: (o) => {
      (tables.AUDIT_LOG = tables.AUDIT_LOG || []).push({
        LogID: 'AUD-' + (++seq), Timestamp: new Date().toISOString(), User: o.user || '',
        Action: o.action || '', Entity: o.entity || '', EntityID: o.entityId || '',
        OldValue: o.oldValue || '', NewValue: o.newValue || '',
      });
    },
    // Email is a side effect; capture it instead of sending.
    notifyPerson_: (email, subject, html) => {
      (tables.__SENT = tables.__SENT || []).push({ to: email, subject, html });
      return true;
    },
    nextScheduledJobs_: () => [],
    dashboardSummary_: () => ({}),
    // Lives in Email.gs, which pulls in the whole mail engine; the auth surface
    // only needs it for escaping, so provide the same behaviour directly.
    escHtml_: (x) => String(x === null || x === undefined ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  };
  Object.assign(sandbox, api);
  sandbox.__sent = () => tables.__SENT || [];

  vm.createContext(sandbox);
  // Load only what the auth surface needs. Sheets.gs is deliberately replaced by
  // the in-memory layer above so tests never touch a real spreadsheet.
  for (const f of (opts.files || ['Utils.gs', 'Session.gs', 'Auth.gs'])) {
    const code = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    try { vm.runInContext(code, sandbox, { filename: f }); }
    catch (e) { throw new Error(`loading ${f}: ${e.message}`); }
  }
  return sandbox;
}

module.exports = { createSandbox, loadTables, parseCsv };
