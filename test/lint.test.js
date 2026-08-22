/**
 * lint.test.js — structural checks that Apps Script cannot do for itself.
 *
 * Every .gs file shares ONE global namespace at runtime. A function or var
 * declared twice does not error: the later declaration silently replaces the
 * earlier one, and which file counts as "later" is the project's file order, not
 * anything visible in the code. That is how 'windows.reopen' ended up bound to a
 * dead handler, and how a second dedupeEmails_ came within one commit of
 * shadowing the real one and breaking CC exclusion.
 *
 * These tests make that class of mistake fail loudly instead.
 *
 * Run: node test/lint.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32mPASS\x1b[0m ' + name); pass++; }
  catch (e) { console.log('  \x1b[31mFAIL\x1b[0m ' + name + '\n         ' + e.message); fail++; }
}
function section(t) { console.log('\n' + t); }

const gsFiles = fs.readdirSync(SRC).filter(f => f.endsWith('.gs'));
const source = {};
gsFiles.forEach(f => { source[f] = fs.readFileSync(path.join(SRC, f), 'utf8'); });

/**
 * Blank out comments and string bodies so declarations quoted inside them are not
 * counted, preserving line structure.
 *
 * This must be ONE left-to-right pass. Running a single-quote regex before a
 * double-quote one treats the apostrophe in "that client's matrix" as a string
 * opener and swallows everything to the next apostrophe -- several lines later,
 * taking real declarations with it.
 */
function strip(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i], c2 = code[i + 1];
    if (c === '/' && c2 === '*') {                    // block comment
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += code[k] === '\n' ? '\n' : ' ';
      i = stop; continue;
    }
    if (c === '/' && c2 === '/') {                    // line comment
      while (i < n && code[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Regex literal. Needed because src/ contains patterns like /^'/ -- without
    // this the apostrophe inside reads as a string opener and everything to the
    // next apostrophe is blanked, silently hiding real declarations. A slash
    // starts a regex only where a value is expected; after a value it is division.
    if (c === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1);
      const prevWord = /(?:^|[^\w$])(return|typeof|case|in|of|new|delete|void|throw)$/
        .test(out.replace(/\s+$/, ''));
      const startsValue = prev === '' || prevWord || '(,=:[!&|?{};+-*%<>~^'.indexOf(prev) !== -1;
      if (startsValue) {
        out += '/'; i++;
        let inClass = false;
        while (i < n) {
          const d = code[i];
          if (d === '\\') { out += '  '; i += 2; continue; }
          if (d === '\n') break;                  // unterminated: bail out safely
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { out += '/'; i++; break; }
          out += ' '; i++;
        }
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {         // string literal
      const q = c;
      out += q; i++;
      while (i < n) {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        if (code[i] === q) { out += q; i++; break; }
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Top-level `function name(` declarations, by name -> [file...].
 *
 * Keyed on column 0, which is the convention throughout src/: top-level
 * declarations start at the margin and nested ones are indented. Counting brace
 * depth instead does not work here, because regex quantifiers ({4}, {2,}) put
 * unbalanced braces into the token stream and the depth silently drifts.
 */
function topLevelFunctions() {
  const found = {};
  for (const f of gsFiles) {
    for (const line of strip(source[f]).split('\n')) {
      const m = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (m) (found[m[1]] = found[m[1]] || []).push(f);
    }
  }
  return found;
}

/* ==================================================================== */
section('1. One definition per name (Apps Script shares one global scope)');

test('no function is declared in more than one place', () => {
  const found = topLevelFunctions();
  const dupes = Object.keys(found)
    .filter(n => found[n].length > 1)
    .map(n => n + ' in ' + found[n].join(' + '));
  assert.deepStrictEqual(dupes, [],
    'these names silently shadow each other at runtime:\n         ' + dupes.join('\n         '));
});

test('no top-level var is declared in more than one place', () => {
  const found = {};
  for (const f of gsFiles) {
    for (const line of strip(source[f]).split('\n')) {
      const m = /^var\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (m) (found[m[1]] = found[m[1]] || []).push(f);
    }
  }
  const dupes = Object.keys(found).filter(n => found[n].length > 1)
    .map(n => n + ' in ' + found[n].join(' + '));
  assert.deepStrictEqual(dupes, [], 'duplicate globals:\n         ' + dupes.join('\n         '));
});

/* ==================================================================== */
section('2. The RPC registry');

test('no RPC route is bound twice', () => {
  const code = source['Code.gs'];
  const start = code.indexOf('var RPC_ROUTES');
  assert.ok(start > 0, 'RPC_ROUTES not found');
  const body = code.slice(start);
  const keys = [];
  const rx = /^\s*'([a-zA-Z.]+)':\s*\{/gm;
  let m;
  while ((m = rx.exec(body))) keys.push(m[1]);
  assert.ok(keys.length > 30, 'expected the full registry, found ' + keys.length);
  const seen = {}, dupes = [];
  keys.forEach(k => { if (seen[k]) dupes.push(k); seen[k] = 1; });
  assert.deepStrictEqual(dupes, [],
    'a duplicate key means the LAST binding silently wins: ' + dupes.join(', '));
});

test('every RPC handler names a function that exists', () => {
  const code = source['Code.gs'];
  const body = code.slice(code.indexOf('var RPC_ROUTES'));
  const defined = new Set(Object.keys(topLevelFunctions()));
  // Handlers are written as `return someHandler_(...)`.
  const called = new Set();
  const rx = /return\s+([A-Za-z_$][\w$]*_)\s*\(/g;
  let m;
  while ((m = rx.exec(body))) called.add(m[1]);
  const missing = [...called].filter(n => !defined.has(n));
  assert.deepStrictEqual(missing, [],
    'RPC routes point at functions that do not exist: ' + missing.join(', '));
});

/* ==================================================================== */
section('3. No dangling references to removed globals');

test('WINDOW_RULES is gone (it was never defined, only referenced)', () => {
  for (const f of gsFiles) {
    const code = strip(source[f]);
    assert.ok(!/\bWINDOW_RULES\b/.test(code),
      f + ' still references WINDOW_RULES, which no file defines');
  }
});

test('no server file reads the retired __t request field as an identity', () => {
  for (const f of gsFiles) {
    const code = strip(source[f]);
    assert.ok(!/whoAmI_\(\s*payload\s*&&\s*payload\.__t/.test(code),
      f + ' still authenticates from the retired URL token field');
  }
});

test('getEffectiveUser is never used to establish identity', () => {
  // Under executeAs: USER_DEPLOYING it always returns the publishing account, so
  // using it as an identity authenticates strangers as that administrator. It is
  // legitimate only in setup(), which a human runs from the editor.
  for (const f of gsFiles) {
    const code = strip(source[f]);
    const hits = (code.match(/getEffectiveUser\s*\(\s*\)/g) || []).length;
    if (!hits) continue;
    assert.ok(f === 'Code.gs' || f === 'Preflight.gs' || f === 'Email.gs',
      f + ' uses getEffectiveUser(); identity must come from getActiveUser()');
  }
});

/* ==================================================================== */
section('4. Schema and code agree');

test('every SCHEMA table name used by readTable_ is declared', () => {
  const schemaCode = source['Sheets.gs'];
  const declared = new Set();
  const rx = /^\s{2}([A-Z_]+):\s*\[/gm;
  let m;
  while ((m = rx.exec(schemaCode.slice(schemaCode.indexOf('var SCHEMA'))))) declared.add(m[1]);
  assert.ok(declared.size > 10, 'expected the SCHEMA block, found ' + declared.size);

  const used = new Set();
  for (const f of gsFiles) {
    const code = strip(source[f]);
    const r2 = /(?:readTable_|appendRow_|updateRowById_|findRowById_|deleteRowById_|invalidateTableCache_)\(\s*'([A-Z_]+)'/g;
    let m2;
    while ((m2 = r2.exec(code))) used.add(m2[1]);
  }
  const undeclared = [...used].filter(t => !declared.has(t));
  assert.deepStrictEqual(undeclared, [],
    'code reads or writes tables that SCHEMA does not declare, so the sheet will ' +
    'never be created: ' + undeclared.join(', '));
});

/* ==================================================================== */
section('5. Client bundle');

test('every attachAiDraft call site can see its definition', () => {
  const html = fs.readFileSync(path.join(SRC, 'App.html'), 'utf8');
  const lines = html.split('\n');
  let defDepth = null, depth = 0;
  const calls = [];
  lines.forEach((line, i) => {
    if (/function\s+attachAiDraft\s*\(/.test(line)) defDepth = depth;
    if (/[^\w.]attachAiDraft\s*\(/.test(line) && !/function\s+attachAiDraft/.test(line)) {
      calls.push({ line: i + 1, depth });
    }
    depth += (line.split('{').length - 1) - (line.split('}').length - 1);
  });
  assert.notStrictEqual(defDepth, null, 'attachAiDraft is not defined at all');
  assert.strictEqual(defDepth, 1,
    'attachAiDraft must sit at the top level of the SPA IIFE (depth 1) so hoisting ' +
    'reaches every call site; it is at depth ' + defDepth);
  assert.ok(calls.length >= 5, 'expected the known call sites, found ' + calls.length);
});

test('the client sends a session id, not a URL token', () => {
  const html = fs.readFileSync(path.join(SRC, 'App.html'), 'utf8');
  assert.ok(/payload\.__s/.test(html), 'the RPC wrapper must send __s');
  assert.ok(!/payload\.__t\s*=/.test(html), 'the RPC wrapper must no longer send __t');
  assert.ok(/sessionStorage/.test(html), 'the session id must live in sessionStorage');
  assert.ok(/replaceState/.test(html), 'the one-time code must be stripped from the URL');
});

/* ==================================================================== */
console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
