# Crux — escalation, compliance and performance management

This repository holds the rebuild of the Crux India operations tool that
currently runs on Google Apps Script over a 26-tab spreadsheet (1,413 branches,
55 users).

## Bulk upload is live

**https://oxpwqfbtbxlvuqpztbwg.supabase.co/functions/v1/crux**

Open it, sign in, load a CSV. Validate → preview → apply, and a file with any
error applies zero rows.

It runs as a Supabase Edge Function, inside the same network as the database,
so there is no server to keep alive and nothing to deploy before using it. It
authenticates people itself; the service key stays inside the function and
never reaches the browser. Five failed sign-ins from one address or one IP
in fifteen minutes locks that door for fifteen minutes.

Ten file kinds are defined, in load order — People, Geography, Clients and
branches, Assignments, Rates, Collections, KPI targets, Past performance,
Holidays, Opening balances. Each has a **Download template** button that gives
you the exact headers, one example row, and the rule for every column.
Loaders are implemented for Holidays and Rates; the rest validate and tell you
plainly that no loader exists yet rather than pretending to load.

---

## Status

| Piece | Where | Live? |
|---|---|---|
| Database — 103 tables, RLS, functions | Supabase `crux`, ap-south-1 | **Yes** |
| Bulk upload — validate, preview, apply | Edge function, URL above | **Yes** |
| PMS appraisal cascade and scoring | Database functions | **Yes** |
| Sample data — 47 rows, 17 tables | Seeded | **Yes** |
| Express API — cases, matrix, PMS, people, penalties | `project/build/api` | No — code only, needs a host |
| Front end | `project/*.dc.html` | No — prototypes |

The edge function covers upload and sign-in. Everything else in the Express API
still needs a machine to run on; see *Running the full API* below.

---

## Signing in

Google Workspace SSO is the intended route: `auth_gate()` refuses any address
that is not an active `@cruxindia.co.in` person already on the people master.
Sign-in matches a person, it never creates one.

Until the Workspace OAuth client is configured, a seeded sample administrator
(`sample.md@example.invalid`) exists so the tool can be used. Its password is
**not published here** — the upload URL is public, and that account is an
administrator, so a password in this file would be a password in everybody's
hands. It was handed over separately.

Clear it before real data goes in:

```sql
update person set password_hash = null, password_salt = null
 where work_email = 'sample.md@example.invalid';
```

---

## Running the full API

The Express API carries the rest of the application — cases, the escalation
matrix, PMS, people and penalties. It needs a host:

```bash
cd project/build/api
npm install
export DATABASE_URL='postgresql://postgres.oxpwqfbtbxlvuqpztbwg:<DB-PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
npm start          # :3000, or $PORT
```

`npm run worker` runs the outbox and scheduled jobs in a second process.
`CORS_ORIGINS` must list the origin the front end is served from.

---

## Sample data

47 rows across 17 tables so the screens are not empty. Every address is
`@example.invalid` (RFC 2606), so nothing can reach a real inbox by accident.
`sample_purge()` removes every sample row and leaves real rows alone. Run it
before real data goes in.

## Holidays

Six statutory Indian holidays are loaded and **confirmed** — Republic Day,
Independence Day and Gandhi Jayanti for 2026 and 2027. Only confirmed holidays
stop the working-hours clock, so festival dates that move with a moon sighting
can be loaded now as unconfirmed and confirmed later without disturbing any
deadline already counted.

---

## Before go-live

1. Configure the Google Workspace OAuth client.
2. Load people, chairs and coverage by bulk upload, in load order.
3. Load the full holiday calendar and the rate card.
4. `sample_purge()`, and clear the sample administrator's password.
5. Deploy the Express API and point the front end at it.

---

## Layout

```
project/build/schema.sql            base schema — 103 tables
project/build/schema-patch-v3..v11  applied in order after it
project/build/supabase/             RLS, auth gate, storage buckets
project/build/supabase/functions/   the live edge function
project/build/api/                  Express API, no ORM
project/build/migration/            Sheets → Postgres migration SQL
project/*.dc.html                   design prototypes
project/*.md                        audit log, runbook, go-live plan
chats/                              the design conversations behind it
```

## Where this came from

This started as a handoff bundle from Claude Design. The prototypes in
`project/` are HTML/CSS/JS mock-ups — the specification for the interface, with
`chats/` recording the decisions behind them. `project/build/` is the real
implementation built against that specification.
