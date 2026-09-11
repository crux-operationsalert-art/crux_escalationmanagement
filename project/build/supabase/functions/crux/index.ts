// =====================================================================
// Crux — the front door.
//
// Serves the application and handles sign-in, bulk upload, the OGL
// workflow, mail settings and the data reset. The page itself lives in
// app_page, not in this file, so changing a screen is an UPDATE rather
// than a redeploy.
//
// JWT verification is off at the gateway because this function does its
// own: the browser holds no Supabase key, and the service-role key never
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

async function personFor(req: Request) {
  const token = req.headers.get("x-crux-token");
  if (!token) return null;
  return await rpc("auth_whoami", { p_token_hash: sha(token) });
}

function clientIp(req: Request) {
  const f = req.headers.get("x-forwarded-for");
  return f ? f.split(",")[0].trim() : null;
}

// The address Google must redirect back to. It is derived from the request
// rather than configured, so it is right in whatever environment this runs
// in - and it is the exact string that has to be listed as an authorised
// redirect URI on the OAuth client.
function redirectUri(url: URL) {
  return url.origin + "/functions/v1/crux/api/mail/oauth/callback";
}

// A page for a browser that arrived by redirect and has no application
// around it. Plain, theme-aware, and it says what happened.
const notice = (msg: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crux · Mail</title>
<style>
:root{color-scheme:light dark}
body{margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.box{max-width:520px;border:1px solid #8884;border-radius:12px;padding:24px}
h1{font-size:17px;margin:0 0 10px}
p{margin:0;opacity:.85}
</style>
<div class="box"><h1>Crux · Mail</h1><p>${
      msg.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    }</p></div>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...CORS } },
  );

// Drive a drain by hand. The scheduler does this every minute; an
// administrator who has just pasted a key should not have to wait for it.
async function drainNow() {
  const r = await fetch(SUPABASE_URL.replace("/rest/v1", "") +
      "/functions/v1/mail?limit=25", {
    method: "POST",
    headers: { authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY },
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: "sender_unreachable", raw: t.slice(0, 300) }; }
}

// ----------------------------------------------------------- storage
// The browser never gets a key. It gets a URL that is good for one file,
// in one place, for a few minutes, and then stops working.
async function signUpload(bucket: string, key: string) {
  const r = await fetch(SUPABASE_URL + "/storage/v1/object/upload/sign/" +
      bucket + "/" + key, {
    method: "POST",
    headers: { authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY,
               "content-type": "application/json" },
    body: "{}",
  });
  const t = await r.text();
  if (!r.ok) throw new Error("sign upload: " + r.status + " " + t.slice(0, 200));
  const j = JSON.parse(t);
  return SUPABASE_URL + "/storage/v1" + j.url;
}

async function signDownload(bucket: string, key: string, seconds = 900) {
  const r = await fetch(SUPABASE_URL + "/storage/v1/object/sign/" + bucket + "/" + key, {
    method: "POST",
    headers: { authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY,
               "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return SUPABASE_URL + "/storage/v1" + j.signedURL;
}

// ------------------------------------------------------------------ CSV
// Minimal RFC4180: quoted fields, embedded commas, doubled quotes, CRLF.
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

// ------------------------------------------------------------- handler
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/crux/, "") || "/";

  try {
    if (path === "/" || path === "") {
      const html = await rpc("app_html", { p_slug: "app" });
      return new Response(html ?? "<h1>No page installed.</h1>", {
        headers: { "content-type": "text/html; charset=utf-8", ...CORS },
      });
    }

    // The client id is not a secret — it is in the page source of every site
    // that uses Google sign-in. Serving it unauthenticated is what lets the
    // sign-in button render before anyone has signed in.
    if (path === "/api/config") return json(await rpc("app_config", {}));

    if (path === "/api/health") {
      const kinds = await rpc("upload_kinds", {});
      return json({ ok: true, kinds: kinds.length, at: new Date().toISOString() });
    }

    // ------------------------------------------------------------ sign in
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
        p_email: String(email), p_hash: hash,
        p_token_hash: sha(token), p_ip: clientIp(req),
      });
      if (out && out.error) return json(out, out.error === "locked_out" ? 429 : 403);
      return json({ token, person: out });
    }

    // Google sign-in. The credential is an ID token Google signed; it is
    // verified BY Google rather than parsed here, because a token this
    // process merely decodes is a token anyone can forge.
    if (path === "/api/google" && req.method === "POST") {
      const { credential } = await req.json();
      if (!credential) return json({ error: "missing_credential" }, 400);

      const cfg = await rpc("app_config", {});
      const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" +
        encodeURIComponent(String(credential)));
      if (!r.ok) {
        return json({ error: "bad_token",
          reason: "Google did not recognise that sign-in. Try again." }, 403);
      }
      const t = await r.json();

      if (t.aud !== cfg.googleClientId) {
        return json({ error: "wrong_audience",
          reason: "That sign-in was issued for a different application." }, 403);
      }
      if (t.email_verified !== "true" && t.email_verified !== true) {
        return json({ error: "email_unverified",
          reason: "Google has not verified that address." }, 403);
      }
      if (cfg.workspaceDomain && t.hd !== cfg.workspaceDomain) {
        return json({ error: "wrong_domain",
          reason: "Sign in with your " + cfg.workspaceDomain + " account.",
          hint: "A personal address cannot hold a chair." }, 403);
      }

      const token = randomBytes(32).toString("base64url");
      const out = await rpc("auth_google", {
        p_email: String(t.email), p_token_hash: sha(token), p_ip: clientIp(req),
      });
      if (out && out.error) return json(out, 403);
      return json({ token, person: out });
    }

    if (path === "/api/logout" && req.method === "POST") {
      const t = req.headers.get("x-crux-token");
      if (t) await rpc("auth_signout", { p_token_hash: sha(t) });
      return json({ ok: true });
    }

    // The callback is unauthenticated by necessity - Google sends the browser
    // here. The nonce is what proves who asked, and it is spent on arrival.
    if (path === "/api/mail/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || "";
      const err = url.searchParams.get("error");
      if (err) return notice("Google returned: " + err + ". Nothing was changed.");

      const actor = await rpc("mail_oauth_claim", { p_nonce: state });
      if (!actor) {
        return notice("That consent link had expired, or had already been used. " +
                      "Start again from the Mail screen.");
      }
      if (!code) return notice("Google sent no code back. Nothing was changed.");

      const cfg = await rpc("mail_settings", {});
      const body = new URLSearchParams({
        code: String(code),
        client_id: cfg.mail_oauth_client_id || cfg.google_client_id,
        client_secret: cfg.mail_oauth_client_secret,
        redirect_uri: redirectUri(url),
        grant_type: "authorization_code",
      });
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const tt = await tr.text();
      if (!tr.ok) return notice("Google refused the exchange: " + tt.slice(0, 300));
      const tok = JSON.parse(tt);

      // whose mailbox actually consented - not whose account asked
      let sendsAs = "";
      try {
        const who = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { authorization: "Bearer " + tok.access_token } });
        if (who.ok) sendsAs = (await who.json()).email ?? "";
      } catch { /* the address is a convenience; the grant is the point */ }

      const saved = await rpc("mail_oauth_save", {
        p_actor: actor, p_refresh_token: tok.refresh_token ?? "", p_from: sendsAs });
      if (saved && saved.error) return notice(saved.reason ?? saved.error);

      return notice("Gmail is connected" + (sendsAs ? " as " + sendsAs : "") +
                    ". You can close this tab and send a test message from the Mail screen.");
    }

    // --------------------------------------------- everything below: auth
    const person = await personFor(req);
    if (!person) {
      return json({ error: "not_signed_in", reason: "Sign in first." }, 401);
    }

    if (path === "/api/me") return json(person);
    if (path === "/api/kinds") return json({ kinds: await rpc("upload_kinds", {}) });
    if (path === "/api/refs") return json(await rpc("app_refs", { p_person: person.id }));
    if (path === "/api/ogl") {
      return json({ assignments: await rpc("ogl_list", { p_person: person.id }) });
    }

    // ------------------------------------------------------------ OGL
    // Scoping lives in the database: ogl_detail refuses an assignment that
    // belongs to another chair and says which relationship was missing.
    if (path === "/api/ogl/reasons") {
      return json({ reasons: await rpc("ogl_reasons", {
        p_context: url.searchParams.get("context") || null }) });
    }

    if (path === "/api/ogl/detail") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      const out = await rpc("ogl_detail", { p_assignment: id, p_person: person.id });
      if (out && out.error) return json(out, out.error === "not_yours" ? 403 : 404);
      return json(out);
    }

    if (path === "/api/ogl/actions") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      return json(await rpc("ogl_actions", { p_assignment: id, p_person: person.id }));
    }

    if (path === "/api/ogl/tray") {
      return json({ segments: await rpc("ogl_attribution_tray", { p_person: person.id }) });
    }

    if (path === "/api/ogl/strikes") {
      return json({ strikes: await rpc("ogl_strikes", {
        p_person: person.id, p_of: url.searchParams.get("of") || null }) });
    }

    // The pause arithmetic, asked for before anything is submitted. The
    // assignee sees which of the three conditions holds and which does not,
    // and then decides. Showing it afterwards would be showing a verdict.
    if (path === "/api/ogl/pause-preview" && req.method === "POST") {
      const { id, reason } = await req.json();
      if (!id || !reason) return json({ error: "missing" }, 400);
      return json(await rpc("ogl_pause_preview", { p_assignment: id, p_reason: reason }));
    }

    if (path === "/api/ogl/raise" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_request_raise", {
        p_assignment: b.id, p_type: b.type, p_actor: person.id,
        p_reason: b.reason, p_remarks: b.remarks ?? null,
        p_delay_category: b.category ?? null,
        p_expected_completion: b.expected ?? null,
      });
      if (out && out.error) return json(out, 409);
      return json(out, 201);
    }

    if (path === "/api/ogl/resolve" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_request_resolve", {
        p_request: b.request, p_resolution: b.resolution,
        p_actor: person.id, p_remarks: b.remarks ?? null, p_system: false,
      });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/transition" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_transition", {
        p_assignment: b.id, p_to: b.to, p_actor: person.id, p_reason: b.reason ?? null });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/attribute" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_attribution_confirm", {
        p_segment: b.segment, p_reason: b.reason,
        p_actor: person.id, p_remarks: b.remarks ?? null });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    // Raising one. The repeat Point ID check happens inside ogl_case_create:
    // a point that has been here before is held, not refused, and the
    // assignor is asked what it means before anything starts.
    if (path === "/api/ogl/create" && req.method === "POST") {
      const body = await req.json();
      const out = await rpc("ogl_case_create", { p_actor: person.id, p_payload: body });
      if (out && out.error) return json(out, 400);
      return json(out, 201);
    }

    if (path === "/api/ogl/decisions") {
      return json({ decisions: await rpc("ogl_pending_decisions", { p_person: person.id }) });
    }

    if (path === "/api/ogl/decide" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_repeat_decide", {
        p_decision: b.id, p_actor: person.id, p_choice: b.choice, p_reason: b.reason ?? null });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/submit" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_submit", { p_assignment: b.id, p_actor: person.id });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/allocate" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_allocate", {
        p_assignment: b.id, p_person: b.person, p_actor: person.id });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/arbiter") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      return json(await rpc("ogl_arbiter", { p_assignment: id }));
    }

    if (path === "/api/ogl/arbitrate" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_arbitrate", {
        p_assignment: b.id, p_actor: person.id, p_outcome: b.outcome, p_reason: b.reason ?? "" });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/dispute-classify" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_dispute_classify", {
        p_request: b.request, p_actor: person.id,
        p_outcome: b.outcome, p_reason: b.reason ?? "" });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/participant" && req.method === "POST") {
      const b = await req.json();
      const out = b.revoke
        ? await rpc("ogl_revoke_participant", { p_grant: b.grant, p_actor: person.id })
        : await rpc("ogl_grant_participant", {
            p_assignment: b.id, p_person: b.person, p_actor: person.id,
            p_reason: b.reason ?? "", p_hours: b.hours ?? 72 });
      if (out && out.error) return json(out, 403);
      return json(out);
    }

    // The assignee's own work: what was found, and where the report went.
    if (path === "/api/ogl/points") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      return json({ points: await rpc("ogl_open_points", { p_assignment: id }) });
    }

    if (path === "/api/ogl/report" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_report_point", {
        p_requirement: b.requirement, p_actor: person.id, p_outcome: b.outcome,
        p_remarks: b.remarks ?? null, p_findings: b.findings ?? {} });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/complete" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_complete", {
        p_assignment: b.id, p_actor: person.id, p_channel: b.channel,
        p_recipient: b.recipient ?? null, p_reference: b.reference ?? null,
        p_remarks: b.remarks ?? null });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    if (path === "/api/ogl/accept" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_review_accept", {
        p_assignment: b.id, p_actor: person.id, p_remarks: b.remarks ?? null });
      if (out && out.error) return json(out, 409);
      return json(out);
    }

    // ------------------------------------------------------- evidence
    // A field verification without a photograph is one person's word.
    if (path === "/api/ogl/attach/begin" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_attach_begin", {
        p_assignment: b.id, p_actor: person.id, p_file_name: b.fileName,
        p_doc_kind: b.kind ?? "EVIDENCE", p_requirement: b.requirement ?? null });
      if (out && out.error) return json(out, out.error === "not_yours" ? 403 : 400);
      return json({ ...out, uploadUrl: await signUpload(out.bucket, out.key) });
    }

    if (path === "/api/ogl/attach/done" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_attach_done", {
        p_assignment: b.id, p_actor: person.id, p_key: b.key, p_file_name: b.fileName,
        p_mime: b.mime ?? null, p_bytes: b.bytes ?? null,
        p_doc_kind: b.kind ?? "EVIDENCE", p_requirement: b.requirement ?? null,
        p_caption: b.caption ?? null });
      if (out && out.error) return json(out, 409);
      return json(out, 201);
    }

    if (path === "/api/ogl/attachments") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      const out = await rpc("ogl_attachments", { p_assignment: id, p_person: person.id });
      if (out && out.error) return json(out, 403);
      // a link the browser can open, and only for as long as it is looking
      for (const t of out.attachments ?? []) t.url = await signDownload(t.bucket, t.key);
      return json(out);
    }

    if (path === "/api/ogl/attach/remove" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_attach_remove", { p_attachment: b.id, p_actor: person.id });
      if (out && out.error) return json(out, 403);
      return json(out);
    }

    if (path === "/api/ogl/strike-waive" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("ogl_strike_waive", {
        p_strike: b.id, p_actor: person.id, p_reason: b.reason ?? "" });
      if (out && out.error) return json(out, 403);
      return json(out);
    }

    if (path === "/api/template") {
      const kind = url.searchParams.get("kind") || "";
      // The columns and their rules live in upload_column, so a new kind
      // needs a row, not a redeploy.
      const csv = await rpc("upload_template", { p_kind: kind });
      if (!csv) return json({ error: "no_template", reason: "No template for " + kind }, 404);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="crux-' +
            kind.replace(/\s+/g, "-").toLowerCase() + '-template.csv"',
          ...CORS,
        },
      });
    }

    // ---------------------------------------- administrator work from here
    // Uploads replace masters wholesale and carry personal data; mail
    // settings carry the key that speaks for the whole company.
    if (person.app_role !== "ADMIN") {
      return json({ error: "admin_only", reason: "Loading masters is administrator work." }, 403);
    }

    // ------------------------------------------------------------- mail
    // The keys go in and never come back out. mail_status answers whether a
    // secret is set, never what it is, and nothing here returns one.
    if (path === "/api/mail") return json(await rpc("mail_status", {}));

    if (path === "/api/mail/configure" && req.method === "POST") {
      const b = await req.json();
      const out = await rpc("mail_configure", {
        p_actor: person.id,
        p_provider: b.provider ?? null,
        p_from: b.from ?? null,
        p_from_name: b.fromName ?? null,
        p_reply_to: b.replyTo ?? null,
        p_api_key: b.apiKey ?? null,
        p_cap: b.cap ?? null,
        p_oauth_client_id: b.oauthClientId ?? null,
        p_oauth_client_secret: b.oauthClientSecret ?? null,
      });
      if (out && out.error) return json(out, 403);
      return json(out);
    }

    if (path === "/api/mail/test" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const out = await rpc("mail_test", { p_actor: person.id, p_to: b.to ?? null });
      if (out && out.error) return json(out, 400);
      // queue it and push it straight out, so the answer is the real answer
      const drained = await drainNow();
      return json({ ...out, drain: drained });
    }

    if (path === "/api/mail/drain" && req.method === "POST") {
      return json(await drainNow());
    }

    if (path === "/api/mail/forget" && req.method === "POST") {
      const out = await rpc("mail_forget_secrets", { p_actor: person.id });
      if (out && out.error) return json(out, 403);
      return json(out);
    }

    // ------------------------------------------- Gmail, without an admin
    // The consent round trip comes back as a plain redirect with no session
    // header on it, so the session is not what carries across: a one-time
    // nonce is, bound to this person and good for ten minutes.
    if (path === "/api/mail/oauth/start" && req.method === "POST") {
      const cfg = await rpc("mail_settings", {});
      const clientId = cfg.mail_oauth_client_id || cfg.google_client_id;
      if (!clientId || !cfg.mail_oauth_client_secret) {
        return json({ error: "client_not_set",
          reason: "Set the OAuth client id and secret first. They are the ones " +
                  "from your own Google Cloud project - the same client sign-in uses." }, 400);
      }
      const st = await rpc("mail_oauth_begin", { p_actor: person.id });
      if (st && st.error) return json(st, 403);

      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri(url));
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.send");
      // consent + offline is what produces a refresh token at all; without
      // prompt=consent a mailbox that has agreed once is given none
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("state", st.nonce);
      return json({ url: u.toString(), redirectUri: redirectUri(url) });
    }

    // ------------------------------------------------------------ upload
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

    // ------------------------------------------------------------- reset
    // Shown before it is done: the preview is the whole point, because this
    // is the one action in the tool that cannot be undone.
    if (path === "/api/reset/preview") {
      return json({ tables: await rpc("data_reset_preview", {}) });
    }

    if (path === "/api/reset" && req.method === "POST") {
      const { confirm } = await req.json();
      const out = await rpc("data_reset", { p_actor: person.id, p_confirm: String(confirm ?? "") });
      if (out && out.error) return json(out, out.error === "admin_only" ? 403 : 400);
      return json(out);
    }

    return json({ error: "no_route", path }, 404);
  } catch (e) {
    console.error("[crux]", e);
    return json({ error: "server_error", reason: String((e as Error).message) }, 500);
  }
});
