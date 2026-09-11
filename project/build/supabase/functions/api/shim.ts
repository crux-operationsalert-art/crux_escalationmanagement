// =====================================================================
// The shim that lets build/api's route files run with no machine.
//
// The Express routes are the real implementation and they are correct.
// Rewriting them in another shape would mean re-deriving every decision
// they encode, and the re-derivation is where the mistakes come from. So
// the routes are carried across almost unchanged and this file supplies
// what they expect: a Router, a req/res pair, and a db module whose q,
// one, many and tx behave exactly as build/api/db.js does — including tx
// carrying the actor, so an audit row still cannot commit without the
// change it describes.
// =====================================================================
import postgres from "npm:postgres@3.4.5";

const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;

// prepare:false because the connection goes through a pooler; max 2 because an
// edge instance is short-lived and the free tier's connection cap is not.
export const sql = postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20 });

// ------------------------------------------------------------------ db
export async function q(text: string, params: unknown[] = []) {
  const rows = await sql.unsafe(text, params as never[]);
  return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
}
export const one = async (t: string, p: unknown[] = []) => (await q(t, p)).rows[0] ?? null;
export const many = async (t: string, p: unknown[] = []) => (await q(t, p)).rows;

export async function tx<T>(actorId: string | null, fn: (t: {
  q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  audit: (action: string, entityType: string, entityRef: unknown,
          oldV?: unknown, newV?: unknown) => Promise<unknown>;
}) => Promise<T>): Promise<T> {
  return await sql.begin(async (c) => {
    await c.unsafe(`select set_config($1, $2, true)`, ["crux.actor_id", actorId || ""] as never[]);
    const t = {
      q: async (text: string, params: unknown[] = []) => ({
        rows: (await c.unsafe(text, params as never[])) as unknown as Record<string, unknown>[],
      }),
      audit: (action: string, entityType: string, entityRef: unknown,
              oldV?: unknown, newV?: unknown) =>
        c.unsafe(
          `insert into audit_entry (actor_id, action, entity_type, entity_ref, old_value, new_value)
           values ($1,$2,$3,$4,$5,$6)`,
          [actorId || null, action, entityType,
           entityRef == null ? null : String(entityRef),
           oldV ? JSON.stringify(oldV) : null,
           newV ? JSON.stringify(newV) : null] as never[],
        ),
    };
    return await fn(t);
  }) as T;
}

// -------------------------------------------------------------- router
export type Req = {
  method: string; path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  person: Record<string, unknown> | null;
  scope: Scope | null;
  get: (h: string) => string | null;
};

export class Res {
  _status = 200;
  _type: string | null = null;
  _done: Response | null = null;
  status(n: number) { this._status = n; return this; }
  type(t: string) { this._type = t.includes("/") ? t : ({ csv: "text/csv", json: "application/json" }[t] ?? t); return this; }
  set(_h: string, _v: string) { return this; }
  json(body: unknown) {
    this._done = new Response(JSON.stringify(body), {
      status: this._status,
      headers: { "content-type": "application/json", ...CORS },
    });
    return this;
  }
  send(body: string) {
    this._done = new Response(body, {
      status: this._status,
      headers: { "content-type": this._type || "text/plain; charset=utf-8", ...CORS },
    });
    return this;
  }
  sendStatus(n: number) { this._status = n; this._done = new Response(null, { status: n, headers: CORS }); return this; }
}

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-crux-token",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
};

type Handler = (req: Req, res: Res, next: (e?: unknown) => void) => unknown;
type Route = { method: string; re: RegExp; keys: string[]; handlers: Handler[] };

class _Router {
  routes: Route[] = [];
  private add(method: string, path: string, handlers: Handler[]) {
    const keys: string[] = [];
    const re = new RegExp(
      "^" + path.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$",
    );
    this.routes.push({ method, re, keys, handlers });
  }
  get(p: string, ...h: Handler[]) { this.add("GET", p, h); }
  post(p: string, ...h: Handler[]) { this.add("POST", p, h); }
  put(p: string, ...h: Handler[]) { this.add("PUT", p, h); }
  delete(p: string, ...h: Handler[]) { this.add("DELETE", p, h); }

  // Declaration order is the match order, exactly as Express does it, so
  // /request/:id/approve still wins over /:personId/note.
  async handle(req: Req, res: Res): Promise<boolean> {
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = req.path.match(r.re);
      if (!m) continue;
      req.params = {};
      r.keys.forEach((k, i) => (req.params[k] = decodeURIComponent(m[i + 1])));
      for (const h of r.handlers) {
        let passed = false;
        let thrown: unknown = null;
        await h(req, res, (e?: unknown) => { if (e) thrown = e; else passed = true; });
        if (thrown) throw thrown;
        if (res._done) return true;
        if (!passed) return true;   // handler ended without responding
      }
      return true;
    }
    return false;
  }
}

// Express exports Router as a callable, and every route file calls it that
// way. Keeping that is the difference between a mechanical port and a rewrite.
export function Router(): _Router { return new _Router(); }
export type RouterT = _Router;

// -------------------------------------------------------------- outbox
// The key is derived, never passed in: same event + same recipient + same day
// = same key = one row. A caller retrying is normal and must be harmless.
export async function enqueue(_actorId: string | null, msg: Record<string, any>) {
  const day = new Date().toISOString().slice(0, 10);
  const basis = [msg.templateKey, String(msg.recipient).toLowerCase(),
                 msg.entityType, msg.entityId, msg.period || day].join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  const key = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
  const r = await one(
    `insert into outbox (idempotency_key, template_key, recipient, subject, body,
                         entity_type, entity_id, not_before, state)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8, now()), 'QUEUED')
     on conflict (idempotency_key) do nothing
     returning id`,
    [key, msg.templateKey, String(msg.recipient).toLowerCase(), msg.subject,
     msg.body ? JSON.stringify(msg.body) : null,
     msg.entityType, msg.entityId, msg.notBefore || null],
  );
  return r ? { queued: true, id: r.id, key } : { queued: false, reason: "duplicate", key };
}

// ------------------------------------------------------------ activation
export async function issueActivation(personId: string, actorId: string) {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const basis = personId + ":" + code;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  const hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  await tx(actorId, async (t) => {
    await t.q(
      `insert into person_event (person_id, kind, note, at) values ($1,'ACTIVATION_ISSUED',$2, now())`,
      [personId, "Activation code issued, valid 15 minutes"]);
    await t.q(
      `insert into auth_session (person_id, expires_at, source, token_hash)
       values ($1, now() + interval '15 minutes', 'ACTIVATION_OTP', $2)`,
      [personId, hash]);
    await t.audit("ACTIVATION_ISSUED", "person", personId, null, { channel: "email" });
  });
  return code;   // handed to the outbox, never logged
}
