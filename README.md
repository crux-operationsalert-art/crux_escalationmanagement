# Crux — escalation, compliance and performance management

This repository holds the rebuild of the Crux India operations tool that
currently runs on Google Apps Script over a 26-tab spreadsheet (1,413 branches,
55 users).

## The tool is live

**https://oxpwqfbtbxlvuqpztbwg.supabase.co/functions/v1/crux**

Sign in with your Crux Google account, or with a password. Eight screens:
Today, Escalations, OGL, Matrix, Performance, People, Penalties, and Data setup
for administrators.

It runs as Supabase Edge Functions, inside the same network as the database, so
there is no server to keep alive. Sign-in happens in the function itself; the
service key never reaches the browser. Five failed attempts from one address or
one IP in fifteen minutes locks that door for fifteen minutes.

The page itself lives in the `app_page` table, not in the function, so changing
a screen is an `UPDATE` rather than a redeploy.

### Signing in with Google

`auth_gate()` refuses any address that is not an active `@cruxindia.co.in`
person already on the people master. Sign-in matches a person; it never creates
one. The credential is verified *by Google* rather than decoded here — a token
this process merely reads is a token anyone can forge.

### Loading data

Data setup carries the uploader. **Eleven file kinds, all implemented**, in load
order:

| | Kind | Loads |
|---|---|---|
| 1 | Chairs | the chair structure, each reporting to another |
| 2 | People | the people master, seated in their chairs |
| 3 | Geography | zones under states, with region and group |
| 4 | Clients and branches | client master and branch master |
| 5 | Assignments | client × zone × handler, with a location head |
| 6 | Rates | the commercial rate per client and location |
| 7 | Collections | billed and collected per client, zone and month |
| 8 | KPI targets | monthly targets per person and KPI |
| 9 | Past performance | MTD, revenue and collections history |
| 10 | Opening balances | live escalations, OGL assignments and claims at cutover |
| 11 | Holidays | the festival calendar (load any time) |

Each has a **Download template** button giving the exact headers, one example
row, and the rule for every column. Load them in order: People needs Chairs,
Clients needs Geography, Assignments needs both plus People.

Chairs was not in the original ten. The People template said the chair "must
already exist" and nothing could create one, so no person could be loaded at
all.

---

## Status

| Piece | Where | Live? |
|---|---|---|
| Database — 103 tables, RLS, functions | Supabase `crux`, ap-south-1 | **Yes** |
| Bulk upload — all eleven kinds | Edge function, URL above | **Yes** |
| PMS appraisal cascade and scoring | Database functions | **Yes** |
| Dummy dataset — 17 people, 5 clients, 16 branches | Loaded through the uploader | **Yes** |
| Indian holiday calendar 2026–27 | 26 days, 6 confirmed | **Yes** |
| The rest of the API — cases, matrix, PMS, people, penalties | Edge function `api` | **Yes** |
| Front end — eight screens | Edge function `crux` | **Yes** |
| Scheduled jobs — auto-close, SLA sweep | `pg_cron`, every 15 min | **Yes** |
| Google sign-in | Configured | **Yes** |
| Sending e-mail | — | No — needs mail credentials |

Nothing needs a host any more. The Express app in `project/build/api` is still
the reference implementation, but its route files now run inside Supabase as
well; see *The API* below.

---

## Signing in

Google Workspace SSO is the intended route: `auth_gate()` refuses any address
that is not an active `@cruxindia.co.in` person already on the people master.
Sign-in matches a person, it never creates one.

A seeded sample administrator (`sample.md@example.invalid`) exists so the tool
could be used before SSO was configured. Its password is **not published here** —
the URL is public and that account is an administrator. Clear it once a real
person can sign in:

```sql
update person set password_hash = null, password_salt = null
 where work_email = 'sample.md@example.invalid';
```

## Emptying the tool

**Data setup → Empty the tool.** It shows you exactly which tables and how many
rows would go, then asks you to type `DELETE ALL DATA`.

It is deliberately not a purge of "rows that look like demo data" — once real
data is loaded through the same uploader it carries the same marks, and a purge
that guesses would one day take the real thing. It empties the operational and
master tables and keeps three things: configuration, the audit trail, and the
account of whoever runs it along with the chair they sit in.

---

## The API

**https://oxpwqfbtbxlvuqpztbwg.supabase.co/functions/v1/api**

```
/api/cases        raise, read, act on escalations
/api/matrix       the branch escalation matrix and its chase list
/api/pms          cycle, adjustments, raisables, daily filing, disputes
/api/people       org chart, team, the hiring chain, notes
/api/penalties    rules, instances, the ledger
/api/sample       what placeholder data is loaded, seed, purge
```

Sign in at the upload service and send its token as `x-crux-token` — one
session, both doors, and revoking it in one revokes it in the other.

These are the *same route files* as `project/build/api/routes`. A shim supplies
Router, req/res and a db module with the same `q`/`one`/`many`/`tx` contract, so
the routes were carried across rather than rewritten — a rewrite would mean
re-deriving every decision they encode, and that is where the mistakes come
from. `tx` still carries the actor, so an audit row still cannot commit without
the change it describes.

The Express app still runs if you want it on your own machine:

```bash
cd project/build/api && npm install
export DATABASE_URL='postgresql://postgres.oxpwqfbtbxlvuqpztbwg:<DB-PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
npm start          # :3000, or $PORT
```

`npm run worker` runs the outbox. Scheduled DB work no longer needs it:
`pg_cron` calls `crux_tick()` every fifteen minutes for auto-close and the SLA
sweep. Sending e-mail is the one thing still without a home — it needs mail
credentials, not a machine.

---

## The data that is in there now

All of it is dummy data, loaded through the uploader itself so the path is the
one you will use:

- 17 chairs and 17 people, MD down to field executives
- 12 zones across 11 states, with region and group
- 5 clients, 16 branches
- 14 assignments, 8 rates, 9 months of collections
- 12 KPI targets, 6 months of MTD history, revenue and collections
- 4 open escalations and 2 claims as opening balances

Every address is `@example.invalid` (RFC 2606), so nothing can reach a real
inbox by accident. Delete it when your own data is ready — `sample_purge()`
clears the seeded sample rows, and the dummy rows above carry
`source_ref = 'bulk upload'`.

## OGL — ops-to-ops verification

`ogl_assignment` used to be refused by the Opening balances loader because
there was nothing to load it into. There is now: a case with its parties and
verification points, an assignment with fourteen states, and an SLA clock
measured in business minutes.

The rule the module is built around: **`current_state` is the operational
position and nothing else.** SLA status, escalation level, priority bucket and
open request type are orthogonal attributes. A breached assignment is still
`IN_PROGRESS` and still shows its operator the correct next action — collapsing
those into one status column is where the old system's workflow went wrong.

`ogl_transition()` is the only thing that writes `current_state`. The spec
enforces that with a column grant; `service_role` bypasses a column grant, so
it is a trigger here — a direct `UPDATE` is refused whoever you are. A cutover
row is the one exception, and it arrives by `INSERT`, seated in the state it
was already in.

The clock counts business minutes against a working window, skipping weekends
and **confirmed** holidays only. A naive timestamp in an upload is read as
Asia/Kolkata, not UTC — a time typed in a Pune office is a Pune time.

Built but not yet driven by any endpoint: the conditional-pause arithmetic on
RFIs, delay auto-accept, the escalation sweep, and strike generation. Their
tables exist; the logic does not, and the module does not pretend otherwise.

## Holidays

26 days for 2026 and 2027. The three gazetted national days — Republic Day,
Independence Day, Gandhi Jayanti — are **confirmed**. Everything else, Diwali
and Id included, is loaded **unconfirmed** on its expected date.

Only a confirmed holiday stops the working-hours clock. So a festival whose
date moves with a moon sighting shows on the calendar, and shortens no
deadline, until somebody fixes it.

---

## Before go-live

1. ~~Configure the Google Workspace OAuth client.~~ Done.
2. Load people, chairs and coverage by bulk upload, in load order.
3. Load the full holiday calendar and the rate card.
4. `sample_purge()`, and clear the sample administrator's password.
5. Get mail credentials so the outbox can drain.

---

## Layout

```
project/build/schema.sql            base schema — 103 tables
project/build/schema-patch-v3..v16  applied in order after it
project/build/supabase/             RLS, auth gate, storage buckets
project/build/supabase/functions/   the two live edge functions
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
