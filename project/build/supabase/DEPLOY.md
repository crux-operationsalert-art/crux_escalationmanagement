# Deploying the Crux backend to Supabase

Phase 1 of two. Supabase runs the business now; AWS is the final home and the
move is a button in the product (Data setup → Move to AWS), not a rewrite.

Run these in order. Each step is verifiable before the next.

---

## 1. Create the project

```
supabase.com → New project
  Name        crux
  Region      Mumbai (ap-south-1)   ← same region as the eventual AWS instance
  Password    generate, store in a password manager, never in chat
```

Copy the connection string from **Settings → Database → Connection string →
URI**. Use the **session** pooler for the API and the **direct** connection for
migrations — `pg_dump` and `psql -f` need the direct one.

## 2. Apply the schema

```bash
export SUPABASE_DB_URL='postgresql://postgres:…@db.….supabase.co:5432/postgres'

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f build/schema.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f build/schema-patch-v3.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f build/schema-patch-v4.sql
```

**Verify** before moving on:

```sql
select count(*) from information_schema.tables where table_schema='public';
-- expect 78

select conname from pg_constraint where not convalidated;
-- expect zero rows
```

`ON_ERROR_STOP=1` is not optional. Without it psql keeps going after a failed
statement and you end up with a half-built schema that looks fine.

## 3. Row-level security and auth

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f build/supabase/01_rls.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f build/supabase/02_auth_storage.sql
```

**Verify:**

```sql
select count(*) from pg_tables where schemaname='public' and rowsecurity;
-- expect 35

-- the anon key must reach nothing
set role anon;
select * from person limit 1;   -- expect: permission denied
reset role;
```

That last check matters more than it looks. The API already scopes every read,
but RLS is what protects you from a mistake in an endpoint written six months
from now.

## 4. Google sign-in

Supabase dashboard → **Authentication → Providers → Google**:

- Client ID and secret from the Google Cloud console
- Authorized redirect: `https://<project>.supabase.co/auth/v1/callback`
- **Skip nonce check:** off

Then **Authentication → Settings**:

- Disable email signup. The only way in is Google or the OTP path.
- Site URL and redirect allow-list set to your app origin.

The `auth_gate` trigger from `02_auth_storage.sql` refuses any address that is
not `@cruxindia.co.in` **and** already active on the people master. Test all
three refusals before you let anyone in — a personal address, an unknown work
address, and a person marked inactive. Each gives a different message on
purpose.

## 5. Load the masters

Order matters; each file is validated against the ones before it.

1. People
2. Geography and zones
3. Clients, then branches
4. Client × location activation
5. Coverage and scope — **set `is_assigned_handler` on exactly one row per
   client × location.** The MIS final count reads these rows and nothing else;
   if none is set, every MIS total reads zero, correctly.
6. Escalation matrices, client then internal
7. SLA rules, penalty rules
8. KPI targets
9. Past performance — MTD, then revenue, then collections
10. Holidays — **a go-live blocker.** The old tool read an empty holiday table,
    so the exclusion never fired and every TAT was silently wrong.
11. OGL live backlog, last

Templates for each are in the product: Data setup → Bulk upload → Template.

## 6. Deploy the API

```bash
cd build/api
npm install
export DATABASE_URL="$SUPABASE_DB_URL"
export GOOGLE_CLIENT_ID=…
export WORKSPACE_DOMAIN=cruxindia.co.in
export MAIL_FROM=operations.alert@cruxindia.co.in
export MAIL_DAILY_CAP=1500
npm start        # API
npm run worker   # chases, auto-close, outbox drain
```

Host it anywhere that holds a warm connection pool — Fly, Render, a small EC2.
Not Lambda: the daily filing burst opens more connections than a Postgres
instance will hold, and Supabase's pooler will start refusing.

**Verify:** sign in as three people at different levels and confirm each sees
only their own subtree. A branch manager who can see another branch's filings
means `coverage_rule` is wrong, not the API.

## 7. Point the app at it

One line in `crux-data.js`. That is the whole integration — the application
already speaks the shape these endpoints return.

---

## Environment

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Supabase → Settings → Database (session pooler) |
| `SUPABASE_DB_URL` | same, direct connection, for migrations only |
| `GOOGLE_CLIENT_ID` | Google Cloud console |
| `WORKSPACE_DOMAIN` | `cruxindia.co.in` |
| `MAIL_FROM` | `operations.alert@cruxindia.co.in` |
| `MAIL_DAILY_CAP` | `1500` — 1,800 cap less 200 reserved for interactive mail |
| `CORS_ORIGINS` | your app origin, comma separated |

`.env` goes in `.gitignore` **before** the first commit. Nothing above belongs
in chat, a ticket, or a screenshot.

---

## Phase 2 — the move to AWS

Already built. `build/api/migrate.js` backs the six stages behind
**Data setup → Move to AWS**, and `AWS_INFRASTRUCTURE.md` holds the decisions,
the cost estimate and the build order.

Add to the API when the AWS instance exists:

```bash
export AWS_DB_URL='postgresql://…@crux.….ap-south-1.rds.amazonaws.com/crux'
export MIGRATION_BUCKET='s3://crux-migration'
export AWS_REGION='ap-south-1'
```

```js
app.use('/admin/migrate', require('./migrate'));
```

Then replace the one `setTimeout` in `awsMoveVals()` in the application with
`POST /admin/migrate/<stage>`. Everything else on that screen already reads the
shape the endpoint returns.

Stages 1–5 are safe to run and re-run while the business keeps working on
Supabase. Only stage 6 changes where writes go, and it will not unlock until
row counts **and** content checksums match on every table.
