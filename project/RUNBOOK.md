# RUNBOOK — creating the database and going live

> **Superseded in part.** Sections 1–2 (Supabase/Neon + Cloudflare R2) are no
> longer the plan. The platform is AWS: RDS Postgres Multi-AZ in `ap-south-1`,
> EC2, S3. See **`AWS_INFRASTRUCTURE.md`**. Section 0 still stands; sections 3
> onward are platform-independent and still current.

Concrete steps, in order. Each one is verifiable before the next.

**Database: Postgres** (Supabase or Neon free tier). Reasoning in
`TURSO_R2_READINESS.md` §10. **Storage: Cloudflare R2**, unchanged.

---

## 0. Rotate the token you pasted into chat — before anything else

The Turso API token in that message grants full control of your Turso
organisation: create, read and drop any database. It is now in a chat
transcript, so treat it as public.

1. Turso dashboard → **Settings → API Tokens** → revoke it.
2. You no longer need a Turso token for this build, but revoke it regardless.
3. **Do not paste the next one anywhere.** Credentials belong in `.env`, and
   `.env` goes in `.gitignore` *before* the first commit:

```
DATABASE_URL=postgresql://user:pass@host/crux?sslmode=require
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=crux-documents
```

---

## 1. Create the database

**Supabase** — free tier, includes auth and a SQL editor:
```
supabase.com → New project → copy the connection string (Settings → Database)
```

**Or Neon** — free tier, faster to provision, no bundled auth:
```
neon.tech → New project → copy the pooled connection string
```

Either is fine. Supabase if you want its auth; Neon if you are building auth
yourself.

**Verify:** `psql "$DATABASE_URL" -c "select version()"` prints a Postgres 15+
banner.

---

## 2. Run the schema — no translation needed

`build/schema.sql` runs as-is. 86 tables, 6 functions, 1 trigger, 44 check
constraints, 153 foreign keys.

```bash
psql "$DATABASE_URL" -f build/schema.sql
```

**Verify:**
```bash
psql "$DATABASE_URL" -c "select count(*) from information_schema.tables where table_schema='public'"
# expect 86

psql "$DATABASE_URL" -c "select tgname from pg_trigger where not tgisinternal"
# expect coverage_rule_no_overlap — this is the guarantee, confirm it exists
```

If the trigger is missing, stop. It is what makes "overlaps refused at write
time" true, and everything about coverage ownership depends on it.

Ignore `build/schema.libsql.sql` — it is a kept fallback for a future embedded
or offline requirement, not part of this path.

---

## 3. Seed from the data layer

`crux-data.js` holds the real extracted data as normalized tables with the same
names as the schema. Write one script that reads `SEED` and inserts it in this
order — later tables reference earlier ones:

```
geo_zone → client → person → assignment → rate → business_record
→ tenday_snapshot → holiday → forecast_scenario → rate_anomaly
```

**No money conversion.** Postgres `numeric(12,2)` is exact decimal, so insert the
rupee values as they are. (This is one of the reasons Postgres was chosen — the
paise conversion was a place to introduce error.)

**One conversion the script does need:** the payload uses `cs:1` as a compact
flag for placeholder collections. Insert it as `collection_is_sample`.

**Verify** against figures already checked in this project:

```sql
select sum(mtd) from business_record where period='2026-09';   -- 11334
select sum(mtd) from business_record where period='2026-08';   -- 19832
select sum(revenue) from business_record where period='2026-09'; -- 46816200.00
select count(*) from rate;                                     -- 153
select count(*) from geo_zone where not is_aggregate;           -- 39
```

If September MTD is not 11,334, stop and find out why. Everything downstream
inherits a bad seed.

---

## 4. Apply the change log

First, in the app: **Data setup → Database connection → Export change log**. That
file records every correction made by hand — merges, zone mappings, confirmed
holidays — with who made it and why.

Apply it after the seed. The database then starts in the state you signed off,
not the state the workbook was in.

---

## 5. The API — four operations and nothing more

The application speaks through one seam, so the surface is fixed:

```
GET    /api/:table?<where>   → select
POST   /api/:table           → insert
PATCH  /api/:table/:id       → update
DELETE /api/:table/:id       → remove
```

Two rules that matter more than the endpoints:

1. **Scope is enforced in the query, not in the response.** Add the chair's
   coverage predicate to the SQL `WHERE`. Never fetch-then-filter: a bug in the
   filter becomes a data leak, and an export bypasses it entirely.
   Postgres row-level security is worth considering here — it enforces scope
   even if a route forgets to.
2. **Let the database do the work it already knows how to do.** `coverage_resolve`,
   `coverage_no_overlap`, `may_edit_penalty_rule`, `penalty_recovery_for`,
   `pms_window_may_open` and `pms_attribute_balance` are in the schema and
   tested by constraint. Call them; do not reimplement them in application code
   where they can drift.

---

## 6. Point the app at it — one line

```js
CruxDB.use({
  name: 'postgres',
  select: (t, w) => fetch(`/api/${t}?` + new URLSearchParams(w || {})).then(r => r.json()),
  insert: (t, row)      => api('POST',   `/api/${t}`, row),
  update: (t, id, patch)=> api('PATCH',  `/api/${t}/${id}`, patch),
  remove: (t, id)       => api('DELETE', `/api/${t}/${id}`)
});
```

Nothing above this line changes. **Verify:** Data setup → Go-live readiness shows
`adapter: postgres` and the adapter check flips to pass.

---

## 7. R2 for documents

```bash
wrangler r2 bucket create crux-documents
```

Keep it **private**. Three rules:

- **Signed URLs only**, expiring in minutes. A partner agreement and a claim bill
  are both confidential; an unguessable path is not access control.
- **Store the key, never the URL** — `documents/2026/09/CLM-0412/bill-1.jpg`. A
  stored URL bakes in a hostname and an expiry.
- **One row per file** in a `document` table: what it belongs to, who uploaded
  it, when, size, type. Otherwise "what documents does this person have" needs a
  bucket listing, and there is no way to enforce that they see only their own.

---

## 8. Run the five checks a prototype could not

Marked **NOT TESTABLE IN CURRENT ENVIRONMENT** throughout the audit log. They
become real tests now, and none should be assumed:

| Check | What proves it |
|---|---|
| Permission enforcement | Call the API directly as user A with user B's ids. Expect empty results, not filtered ones. |
| Parameter tampering | Change a zone id in a query string. Expect a refusal, not a wider answer. |
| Export scope | Export as a branch manager. The file must contain their rows only. |
| Idempotency | POST the same outbox row twice. The unique key must reject the second. |
| Interruption | Kill the request mid-write. No half-written record should remain. |
| Coverage overlap | Insert two rules covering one branch in the same role. **The trigger must refuse it.** |

That last one is new to this path and worth running first — it is the guarantee
Postgres was chosen to keep.

---

## 9. What still needs you

**One thing, and it is not about data: rotate the Turso API token** you pasted
into chat. Everything else is seeded with sample data you replace as admin, per
your instruction.

### Deliberately *not* asked of you now

I had been listing three more. Two were wrong to ask, and one was premature:

| I had asked for | Why it was wrong |
|---|---|
| Enter a configured commercial rate | **Now seeded.** 6 sample `CONFIGURED` rates exist on real trading pairs, each set to the rate that pair is already observed at, so the resolution path is exercised without fabricating a variance. Marked `is_sample`. |
| Purge the placeholders | **The opposite of your instruction.** You asked for dummy data to be kept until you update it. Purge is a button for *after* the real upload, not a prerequisite. |
| Export the change log | **Premature.** The log records corrections made by hand. With everything seeded there is nothing to export yet; do it after you make real corrections, before step 4. |

### How the sample data is replaced

Everything seeded as a placeholder carries `is_sample`, and
**Data setup → Sample data → Purge** removes exactly those rows and fields —
whole rows where the row itself is a placeholder, single fields where only that
field is. It covers `person`, `assignment`, `rate` and the collection columns.
So the sequence is: build on the sample data, upload the real masters, then
purge. Not purge first.

Everything else is decided. The 29 money/score column types are moot on Postgres
(`numeric` is exact), the schema needs no translation, and the coverage
enforcement stays in the database where it belongs.
