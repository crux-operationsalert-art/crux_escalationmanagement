// =====================================================================
// Crux — the hosted bulk upload service.
//
// The Express API in build/api is the real one; it needs a machine. This
// is the same lifecycle with no machine to look after: it runs inside
// Supabase, next to the database, and every step it takes is one of the
// upload_* functions from schema-patch-v10.sql. It parses CSV, holds a
// session, and checks that the person is an administrator. It decides
// nothing else — validation and the all-or-nothing rule stay in the
// database, where they hold no matter who calls.
//
// JWT verification is off at the gateway because this function does its
// own: the browser has no Supabase key, and the service-role key never
// leaves this process.
// =====================================================================
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { Buffer } from "node:buffer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-crux-token",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      authorization: "Bearer " + SERVICE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(fn + ": " + r.status + " " + text);
  return text ? JSON.parse(text) : null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

// ------------------------------------------------------------- sessions
async function personFor(req: Request) {
  const token = req.headers.get("x-crux-token");
  if (!token) return null;
  return await rpc("auth_whoami", { p_token_hash: sha(token) });
}

function clientIp(req: Request) {
  const f = req.headers.get("x-forwarded-for");
  return f ? f.split(",")[0].trim() : null;
}

// ------------------------------------------------------------------ CSV
// Minimal RFC4180: quoted fields, embedded commas, doubled quotes, CRLF.
// Same parser as the Express route, deliberately — a file must behave the
// same way whichever door it comes through.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((rw) => rw.some((v) => String(v).trim() !== ""));
}

function rowsFromCsv(csv: string) {
  const grid = parseCsv(csv);
  if (grid.length < 2) return null;
  const header = grid[0].map((h) => String(h).trim());
  return grid.slice(1).map((line) =>
    Object.fromEntries(header.map((h, i) => [h, line[i] === undefined ? "" : line[i]]))
  );
}

// --------------------------------------------------------------- specs
// The exact headers each loader reads, with the rule for every column.
const SPEC: Record<string, [string, string, string][]> = {
  "People": [
    ["employee_no", "EMP-0114", "Required, unique. Your own numbering; it becomes the person key."],
    ["full_name", "Amit Kulkarni", "Required."],
    ["work_email", "amit.kulkarni@cruxindia.co.in", "Required, unique. Checked for near-duplicates — a misspelt domain is rejected, not accepted as a second person."],
    ["mobile", "9021469966", "Required. Used for sign-in by OTP where there is no Google account."],
    ["chair", "Branch Manager — Pune", "Required. Must already exist in the structure."],
    ["reports_to_employee_no", "EMP-0088", "Required except for the top chair."],
    ["date_of_joining", "2023-01-12", "YYYY-MM-DD. Roll-ups count from this date, never before it."],
    ["employment_type", "Employee", "Employee, Partner, Intern or Contract."],
  ],
  "Geography": [
    ["group", "Zone A", "Optional."],
    ["region", "West", "Optional. East, West, North, South, Central or North-East."],
    ["zone", "Pune", "Required, unique after trimming."],
    ["state", "Maharashtra", "Optional."],
    ["city", "Pune", "Optional."],
  ],
  "Clients and branches": [
    ["client_code", "SBI", "Required, unique."],
    ["client_name", "State Bank of India", "Required."],
    ["branch_code", "SBIN0030421", "Required and unique within the client."],
    ["branch_name", "Kothrud", "Required."],
    ["zone", "Pune", "Required. Must exist in the Geography file."],
    ["address", "Kothrud, Pune 411038", "Optional."],
    ["status", "ACTIVE", "ACTIVE or INACTIVE."],
  ],
  "Assignments": [
    ["client_code", "SBI", "Required. Must exist."],
    ["zone", "Pune", "Required. Must exist."],
    ["product", "Home loan", "Optional. Blank means every product for that client at that location."],
    ["handler_employee_no", "EMP-0114", "Required. Must exist in People."],
    ["location_head_employee_no", "EMP-0088", "Optional."],
    ["effective_from", "2026-04-01", "Required, YYYY-MM-DD."],
    ["effective_to", "", "Blank for open-ended. Overlapping dates on the same client, zone and product is an error."],
  ],
  "Rates": [
    ["client_code", "SBI", "Required. Must already exist."],
    ["zone", "Pune", "Blank means every location for this client."],
    ["rate", "196.00", "Required. Non-negative, up to two decimals."],
    ["currency", "INR", "Optional, defaults to INR."],
    ["effective_from", "2026-07-01", "Required. Records before this date keep the rate that applied then."],
    ["effective_to", "", "Blank for open-ended. Must be after effective_from."],
    ["reason", "Revised on renewal", "Recommended. Stored against the rate version."],
  ],
  "Collections": [
    ["period", "2026-09", "Required, YYYY-MM."],
    ["client_code", "SBI", "Required."],
    ["zone", "Pune", "Required."],
    ["billed", "540960.00", "Required. What was invoiced."],
    ["collected", "412300.00", "Required. What was received."],
  ],
  "KPI targets": [
    ["period", "2026-09", "Required, YYYY-MM."],
    ["employee_no", "EMP-0114", "Required."],
    ["kpi_name", "Field verifications completed", "Required. Must match a KPI on that chair."],
    ["target", "1200", "Required."],
    ["unit", "count", "count, %, score or ₹ lakh."],
    ["sub_category", "SBI · Pune", "Optional. Sub-category targets must add up to the KPI target."],
  ],
  "Past performance": [
    ["file_part", "mtd", "Required. One of mtd, revenue or collections. Load mtd first."],
    ["period", "2026-08", "Required, YYYY-MM. Load oldest month first."],
    ["employee_no", "EMP-0114", "Required for file_part = mtd."],
    ["kpi_name", "Field verifications completed", "Required for mtd. Must match a loaded KPI target."],
    ["sub_category", "SBI · Pune", "Optional."],
    ["client_code", "SBI", "Required for revenue and collections."],
    ["location_code", "PUN", "Required for revenue and collections."],
    ["branch_code", "BR-00747", "Optional."],
    ["target", "1050", "Optional on mtd."],
    ["achieved", "1092", "Required for mtd."],
    ["mtd_achieved", "1092", "Required for mtd."],
    ["invoiced_inr", "1842000", "Required for revenue. Whole rupees, no commas."],
    ["realised_inr", "1610000", "Required for revenue."],
    ["opening_outstanding_inr", "940000", "Required for collections."],
    ["collected_inr", "612000", "Required for collections."],
    ["closing_outstanding_inr", "328000", "Required for collections. Opening minus collected must equal closing."],
    ["owner_employee_no", "EMP-0114", "Recommended on revenue and collections."],
    ["source", "Force1 export", "Recommended. Where the number came from."],
  ],
  "Holidays": [
    ["date", "2026-11-08", "Required, YYYY-MM-DD."],
    ["name", "Diwali", "Required."],
    ["scope", "Festival", "National, Festival, or a state name."],
    ["confirmed", "no", "yes or no. A moon-sighting date stays no until it is fixed: an unconfirmed day is shown but never shortens a deadline."],
  ],
  "Opening balances": [
    ["record_type", "escalation", "escalation, ogl_assignment or claim."],
    ["reference", "ESC-00193", "Required, unique."],
    ["created_at", "2026-08-27T15:26:00", "Required. The real creation time — clocks are computed from this."],
    ["current_state", "OPEN", "Must be a state that type actually has."],
    ["owner_employee_no", "EMP-0114", "Required."],
    ["client_code", "SBI", "Optional."],
    ["zone", "Pune", "Optional."],
  ],
};

function templateCsv(kind: string) {
  const spec = SPEC[kind];
  if (!spec) return null;
  const esc = (v: string) =>
    /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return [
    ["Crux bulk upload template", kind].map(esc).join(","),
    ["Row below the header is an example - delete it before uploading."].map(esc).join(","),
    ["A file with any error applies zero rows."].map(esc).join(","),
    "",
    spec.map((c) => esc(c[0])).join(","),
    spec.map((c) => esc(c[1])).join(","),
    "",
    "NOTES",
    ...spec.map((c) => [c[0], c[2]].map(esc).join(",")),
  ].join("\n");
}

// ------------------------------------------------------------- handler
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  // served at /functions/v1/crux/... — everything before the name is gateway
  const path = url.pathname.replace(/^.*?\/crux/, "") || "/";

  try {
    if (path === "/" || path === "") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", ...CORS },
      });
    }

    if (path === "/api/health") {
      const kinds = await rpc("upload_kinds", {});
      return json({ ok: true, kinds: kinds.length, at: new Date().toISOString() });
    }

    // ------------------------------------------------------------ login
    if (path === "/api/login" && req.method === "POST") {
      const { email, password } = await req.json();
      if (!email || !password) return json({ error: "missing" }, 400);

      const salt = await rpc("auth_salt", { p_email: String(email) });
      // An unknown address still costs a hash and still records an attempt,
      // so the endpoint cannot be used to find out who works here.
      const saltBuf = salt ? Buffer.from(salt, "hex") : randomBytes(16);
      const hash = scryptSync(String(password), saltBuf, 64).toString("hex");

      const token = randomBytes(32).toString("base64url");
      const out = await rpc("auth_login", {
        p_email: String(email),
        p_hash: hash,
        p_token_hash: sha(token),
        p_ip: clientIp(req),
      });
      if (out && out.error) return json(out, out.error === "locked_out" ? 429 : 403);
      return json({ token, person: out });
    }

    if (path === "/api/logout" && req.method === "POST") {
      const t = req.headers.get("x-crux-token");
      if (t) await rpc("auth_signout", { p_token_hash: sha(t) });
      return json({ ok: true });
    }

    // --------------------------------------------- everything below: auth
    const person = await personFor(req);
    if (!person) {
      return json({ error: "not_signed_in", reason: "Sign in first." }, 401);
    }

    if (path === "/api/me") return json(person);

    // Templates are readable by anyone signed in — knowing the column names
    // is how a file gets prepared before the administrator loads it.
    if (path === "/api/kinds") return json({ kinds: await rpc("upload_kinds", {}) });

    if (path === "/api/template") {
      const kind = url.searchParams.get("kind") || "";
      const csv = templateCsv(kind);
      if (!csv) return json({ error: "no_template", reason: "No template for " + kind }, 404);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition":
            'attachment; filename="crux-' +
            kind.replace(/\s+/g, "-").toLowerCase() + '-template.csv"',
          ...CORS,
        },
      });
    }

    // ---------------------------------------- administrator work from here
    // Uploads replace masters wholesale and carry personal data.
    if (person.app_role !== "ADMIN") {
      return json({ error: "admin_only", reason: "Loading masters is administrator work." }, 403);
    }

    if (path === "/api/history") {
      return json({ batches: await rpc("upload_history", { p_limit: 25 }) });
    }

    if (path === "/api/upload" && req.method === "POST") {
      const body = await req.json();
      const rows = Array.isArray(body.rows) ? body.rows : rowsFromCsv(String(body.csv || ""));
      if (!rows || !rows.length) {
        return json({ error: "empty_file", reason: "That file has a header but no data rows." }, 400);
      }
      const out = await rpc("upload_stage", {
        p_kind: String(body.kind || ""),
        p_file: String(body.fileName || "upload.csv"),
        p_rows: rows,
        p_actor: person.id,
      });
      if (out && out.error) return json(out, 400);
      out.note = out.rows_error > 0
        ? out.rows_error + " row(s) must be fixed first — a file with any error applies zero rows."
        : (out.implemented
            ? "Nothing has been written yet. Apply to load these rows."
            : "This file validated, but no loader is implemented for this kind yet.");
      return json(out, 201);
    }

    if (path === "/api/batch") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      const out = await rpc("upload_preview", { p_batch: id });
      if (!out) return json({ error: "not_found" }, 404);
      return json(out);
    }

    if (path === "/api/apply" && req.method === "POST") {
      const { id } = await req.json();
      if (!id) return json({ error: "missing_id" }, 400);
      const out = await rpc("upload_apply_audited", { p_batch: id, p_actor: person.id });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/cancel" && req.method === "POST") {
      const { id } = await req.json();
      if (!id) return json({ error: "missing_id" }, 400);
      const out = await rpc("upload_cancel", { p_batch: id, p_actor: person.id });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    return json({ error: "no_route", path }, 404);
  } catch (e) {
    console.error("[crux]", e);
    return json({ error: "server_error", reason: String((e as Error).message) }, 500);
  }
});

// =====================================================================
// The page. One file, no framework, no CDN — it has to work on a laptop
// in a branch office with a bad line.
// =====================================================================
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crux · Bulk upload</title>
<style>
:root{
  --bg:#f6f7f9; --card:#fff; --ink:#14171c; --mute:#666e7a; --line:#e3e6ea;
  --accent:#1d4ed8; --ok:#0f7b3d; --okbg:#e9f6ee; --bad:#b42318; --badbg:#fdecea;
  --warnbg:#fff6e5; --warn:#8a5a00;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0f1115; --card:#171a21; --ink:#e9ecf1; --mute:#98a1b0; --line:#262b35;
  --accent:#6f9bff; --ok:#4ade80; --okbg:#14301f; --bad:#ff8a80; --badbg:#331715;
  --warnbg:#33280f; --warn:#e8b657;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:21px;margin:0 0 2px;letter-spacing:-.01em}
.sub{color:var(--mute);font-size:13px;margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:20px;margin-bottom:16px}
label{display:block;font-size:12px;font-weight:600;text-transform:uppercase;
  letter-spacing:.05em;color:var(--mute);margin:0 0 6px}
input,select,button{font:inherit}
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;
  background:var(--bg);color:var(--ink)}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row>div{flex:1 1 220px;margin-bottom:14px}
button{padding:10px 16px;border-radius:8px;border:1px solid transparent;
  background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line);font-weight:500}
.msg{padding:11px 14px;border-radius:8px;font-size:14px;margin:12px 0}
.msg.ok{background:var(--okbg);color:var(--ok)}
.msg.bad{background:var(--badbg);color:var(--bad)}
.msg.warn{background:var(--warnbg);color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);
  vertical-align:top;white-space:nowrap}
th{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.scroll{overflow-x:auto;margin:0 -4px}
.who{display:flex;justify-content:space-between;align-items:center;gap:12px;
  font-size:13px;color:var(--mute);margin-bottom:16px;flex-wrap:wrap}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;
  font-weight:600;background:var(--bg);border:1px solid var(--line)}
.hide{display:none}
.drop{border:2px dashed var(--line);border-radius:10px;padding:26px;text-align:center;
  color:var(--mute);cursor:pointer}
.drop.over{border-color:var(--accent);color:var(--accent)}
.stats{display:flex;gap:20px;flex-wrap:wrap;margin:14px 0}
.stat b{display:block;font-size:22px;line-height:1.2}
.stat span{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}
</style></head><body><div class="wrap">

<h1>Crux · Bulk upload</h1>
<p class="sub">Validate, preview, then apply. A file with any error applies zero rows.</p>

<div id="loginCard" class="card">
  <div class="row">
    <div><label for="em">Work e-mail</label><input id="em" type="email" autocomplete="username"></div>
    <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"></div>
  </div>
  <button id="go">Sign in</button>
  <div id="loginMsg"></div>
</div>

<div id="app" class="hide">
  <div class="who">
    <span>Signed in as <b id="who"></b> <span class="pill" id="role"></span></span>
    <button class="ghost" id="out">Sign out</button>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <label for="kind">File kind</label>
        <select id="kind"></select>
      </div>
      <div style="flex:0 0 auto;display:flex;align-items:flex-end">
        <button class="ghost" id="tpl">Download template</button>
      </div>
    </div>
    <div class="drop" id="drop">
      Drop a CSV here, or click to choose one
      <input id="file" type="file" accept=".csv,text/csv" class="hide">
    </div>
    <div id="upMsg"></div>
  </div>

  <div id="preview" class="card hide">
    <b id="pvTitle"></b>
    <div class="stats" id="pvStats"></div>
    <div id="pvMsg"></div>
    <div id="pvErrors"></div>
    <div id="pvSample"></div>
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
      <button id="apply">Apply</button>
      <button class="ghost" id="cancel">Cancel batch</button>
    </div>
  </div>

  <div class="card">
    <b>Recent loads</b>
    <div id="history" class="scroll"></div>
  </div>
</div>

</div><script>
var API = location.pathname.replace(/\\/$/, "");
var token = localStorage.getItem("cruxToken") || "";
var batch = null;

function el(id){ return document.getElementById(id); }
function esc(s){ return String(s===null||s===undefined?"":s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function msg(node, kind, text){ node.innerHTML = text
  ? '<div class="msg '+kind+'">'+esc(text)+'</div>' : ""; }

async function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({"content-type":"application/json"}, opts.headers||{});
  if (token) opts.headers["x-crux-token"] = token;
  var r = await fetch(API + path, opts);
  var ct = r.headers.get("content-type") || "";
  if (ct.indexOf("application/json") < 0) return { _raw: await r.text(), _status: r.status };
  var b = await r.json(); b._status = r.status; return b;
}

// ------------------------------------------------------------- sign in
el("go").onclick = async function(){
  var b = el("go"); b.disabled = true; msg(el("loginMsg"), "", "");
  try {
    var out = await api("/api/login", { method:"POST", body: JSON.stringify({
      email: el("em").value.trim(), password: el("pw").value }) });
    if (out.error) { msg(el("loginMsg"), "bad", out.reason || out.error); return; }
    token = out.token; localStorage.setItem("cruxToken", token);
    el("pw").value = "";
    start(out.person);
  } catch(e){ msg(el("loginMsg"), "bad", String(e)); }
  finally { b.disabled = false; }
};
el("pw").addEventListener("keydown", function(e){ if (e.key === "Enter") el("go").click(); });

el("out").onclick = async function(){
  await api("/api/logout", { method:"POST" });
  token = ""; localStorage.removeItem("cruxToken");
  el("app").classList.add("hide"); el("loginCard").classList.remove("hide");
};

function start(person){
  el("loginCard").classList.add("hide");
  el("app").classList.remove("hide");
  el("who").textContent = person.full_name;
  el("role").textContent = person.app_role;
  loadKinds(); loadHistory();
}

// --------------------------------------------------------------- kinds
async function loadKinds(){
  var out = await api("/api/kinds");
  if (!out.kinds) return;
  el("kind").innerHTML = out.kinds.map(function(k){
    return '<option value="'+esc(k.kind)+'">'+esc(k.load_order)+". "+esc(k.kind)+
      (k.implemented ? "" : "  (no loader yet)")+"</option>";
  }).join("");
}

el("tpl").onclick = function(){
  var kind = el("kind").value;
  fetch(API + "/api/template?kind=" + encodeURIComponent(kind),
        { headers: { "x-crux-token": token } })
    .then(function(r){ return r.blob(); })
    .then(function(b){
      var a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = "crux-" + kind.replace(/\\s+/g,"-").toLowerCase() + "-template.csv";
      document.body.appendChild(a); a.click(); a.remove();
    });
};

// -------------------------------------------------------------- upload
var drop = el("drop"), file = el("file");
drop.onclick = function(){ file.click(); };
drop.ondragover = function(e){ e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = function(){ drop.classList.remove("over"); };
drop.ondrop = function(e){
  e.preventDefault(); drop.classList.remove("over");
  if (e.dataTransfer.files[0]) send(e.dataTransfer.files[0]);
};
file.onchange = function(){ if (file.files[0]) send(file.files[0]); };

async function send(f){
  msg(el("upMsg"), "warn", "Reading " + f.name + "…");
  var csv = await f.text();
  msg(el("upMsg"), "warn", "Validating " + f.name + "…");
  var out = await api("/api/upload", { method:"POST", body: JSON.stringify({
    kind: el("kind").value, fileName: f.name, csv: csv }) });
  file.value = "";
  if (out.error) { msg(el("upMsg"), "bad", out.reason || out.error); return; }
  msg(el("upMsg"), "", "");
  batch = out.batchId;
  showPreview(out, f.name);
  loadHistory();
}

function showPreview(out, name){
  el("preview").classList.remove("hide");
  el("pvTitle").textContent = name + " · " + el("kind").value;
  el("pvStats").innerHTML =
    '<div class="stat"><b>'+out.rows_total+'</b><span>rows read</span></div>' +
    '<div class="stat"><b>'+out.rows_ok+'</b><span>would load</span></div>' +
    '<div class="stat"><b>'+out.rows_error+'</b><span>errors</span></div>';
  msg(el("pvMsg"), out.rows_error > 0 ? "bad" : "ok", out.note);

  el("pvErrors").innerHTML = !out.errors || !out.errors.length ? "" :
    '<div class="scroll"><table><tr><th>Line</th><th>Problem</th><th>Row</th></tr>' +
    out.errors.map(function(e){
      return "<tr><td>"+e.row_no+"</td><td>"+esc(e.error)+"</td><td>"+
        esc(JSON.stringify(e.raw))+"</td></tr>"; }).join("") + "</table></div>";

  el("pvSample").innerHTML = !out.sample || !out.sample.length ? "" :
    '<div class="scroll"><table><tr><th>Line</th><th>Would load</th></tr>' +
    out.sample.map(function(s){
      return "<tr><td>"+s.row_no+"</td><td>"+esc(JSON.stringify(s.raw))+"</td></tr>";
    }).join("") + "</table></div>";

  el("apply").disabled = !out.applicable;
}

el("apply").onclick = async function(){
  if (!batch) return;
  el("apply").disabled = true;
  var out = await api("/api/apply", { method:"POST", body: JSON.stringify({ id: batch }) });
  if (out.error) { msg(el("pvMsg"), "bad", out.reason || out.error); el("apply").disabled = false; return; }
  msg(el("pvMsg"), "ok", "Loaded " + out.applied + " row(s).");
  el("pvErrors").innerHTML = ""; el("pvSample").innerHTML = "";
  batch = null; loadHistory();
};

el("cancel").onclick = async function(){
  if (!batch) return;
  await api("/api/cancel", { method:"POST", body: JSON.stringify({ id: batch }) });
  el("preview").classList.add("hide"); batch = null; loadHistory();
};

// ------------------------------------------------------------- history
async function loadHistory(){
  var out = await api("/api/history");
  if (!out.batches) return;
  el("history").innerHTML = !out.batches.length
    ? '<p class="sub" style="margin:10px 0 0">Nothing loaded yet.</p>'
    : "<table><tr><th>When</th><th>Kind</th><th>File</th><th>State</th>" +
      "<th>Rows</th><th>Errors</th><th>By</th></tr>" +
      out.batches.map(function(b){
        return "<tr><td>" + esc(new Date(b.uploaded_at).toLocaleString()) +
          "</td><td>" + esc(b.kind) + "</td><td>" + esc(b.file_name) +
          "</td><td>" + esc(b.state) + "</td><td>" + esc(b.rows_total) +
          "</td><td>" + esc(b.rows_error) + "</td><td>" +
          esc(b.uploaded_by || "") + "</td></tr>"; }).join("") + "</table>";
}

// resume a session across a reload
if (token) api("/api/me").then(function(p){
  if (p && p.id) start(p); else { token=""; localStorage.removeItem("cruxToken"); }
});
</script></body></html>`;
