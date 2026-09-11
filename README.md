# Crux — escalation, compliance and performance management

This repository holds the rebuild of the Crux India operations tool that
currently runs on Google Apps Script over a 26-tab spreadsheet (1,413 branches,
55 users).

**Nothing in this repository is hosted.** GitHub stores the code; it does not
run it. See *Status* below for what is live and what is not.

---

## Status

| Piece | Where it is | Live? |
|---|---|---|
| Database schema (103 tables, RLS, functions) | Supabase project `crux`, region `ap-south-1` | **Yes** — applied and running |
| Bulk-upload engine (`upload_validate` / `upload_apply`) | Same database | **Yes** — the SQL side works |
| PMS appraisal cascade (`pms_cascade_apply`, `pms_cycle_score`) | Same database | **Yes** |
| Sample/dummy data (47 rows, 17 tables) | Same database, seeded | **Yes** |
| Express API (`project/build/api`) | This repo only | **No** — it has no URL until someone starts it |
| Front end | `project/*.dc.html` prototypes | **No** — prototypes, not a built app |

So: you can already run a bulk upload *against the database*, but there is no
web address to open, because the API is not deployed anywhere. Starting it is
the section below.

---

## Running the API

```bash
cd project/build/api
npm install
export DATABASE_URL='postgresql://postgres.oxpwqfbtbxlvuqpztbwg:<DB-PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
npm start          # listens on :3000, or $PORT
curl localhost:3000/health
```

`<DB-PASSWORD>` is the database password set when the Supabase project was
created (Supabase dashboard → Project Settings → Database → Reset password if
it is not to hand).

Sign in without Google SSO, using the seeded sample administrator:

```bash
curl -s localhost:3000/auth/password \
  -H 'content-type: application/json' \
  -d '{"email":"sample.md@example.invalid","password":"CruxSample2026!"}'
```

That returns a bearer token. Every `/api/...` route wants it as
`Authorization: Bearer <token>`.

Optional: `npm run worker` runs the outbox/scheduled-job worker in a second
process. `CORS_ORIGINS` must list the origin the front end is served from.

---

## Loading real data

Bulk upload is the mechanism — validate, preview, then apply, and **a file with
any error applies zero rows**. Ten upload kinds are defined, with a load order
(people before chairs, chairs before coverage, and so on).

```
GET  /api/upload/kinds                 the ten kinds and their columns
GET  /api/upload/template/:kind        a CSV header row to fill in
POST /api/upload/:kind                 upload a CSV, creates a batch
GET  /api/upload/batch/:id             validation result, row by row
POST /api/upload/batch/:id/apply       commit it
```

All of them are administrator-only.

The database already holds six statutory Indian holidays (Republic Day,
Independence Day, Gandhi Jayanti — 2026 and 2027) as *confirmed* rows. Only
confirmed holidays stop the working-hours clock, so the restricted and regional
days can be loaded and confirmed later without disturbing anything already
counted.

## Sample data

47 rows across 17 tables, seeded so the screens are not empty. Every address is
`@example.invalid` (RFC 2606), so nothing can be posted to a real inbox by
accident.

```
GET  /api/sample          what is currently seeded
POST /api/sample/seed
POST /api/sample/purge    removes every sample row, leaves real rows alone
```

Purge the sample data before real data goes in.

---

## Before go-live

1. Set the Google Workspace OAuth client so SSO works (`auth_gate()` refuses any
   address that is not an active `@cruxindia.co.in` person on the master).
2. Load the real people master, chairs and coverage by bulk upload.
3. Load the full holiday calendar and the rate card.
4. Purge sample data; remove the sample administrator's password.
5. Deploy the API somewhere with a URL, and point the front end at it.

---

## Layout

```
project/build/schema.sql            base schema — 103 tables
project/build/schema-patch-v3..v9   applied in order after it
project/build/supabase/             RLS policies, auth gate, storage buckets
project/build/api/                  Express API, no ORM
project/build/migration/            Sheets → Postgres migration SQL
project/*.dc.html                   the design prototypes
project/*.md                        audit log, runbook, go-live plan
chats/                              the design conversations this came from
```

---

## Where this came from

This started as a handoff bundle from Claude Design. The prototypes in
`project/` are HTML/CSS/JS mock-ups, not production code — they are the
specification for the interface, and `chats/` records the decisions behind
them. The backend in `project/build/` is the real implementation built against
that specification.
