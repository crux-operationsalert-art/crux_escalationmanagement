# Crux — escalation, compliance and performance management

This repository holds the rebuild of the Crux India operations tool that
currently runs on Google Apps Script over a 26-tab spreadsheet (1,413 branches,
55 users).

## The tool is live

**https://oxpwqfbtbxlvuqpztbwg.supabase.co/functions/v1/crux**

Sign in with your Crux Google account, or with a password. Nine screens:
Today, Escalations, OGL, Matrix, Performance, People, Penalties, and — for
administrators — Data setup and Mail.

It runs as Supabase Edge Functions, inside the same network as the database, so
there is no server to keep alive. Sign-in happens in the function itself; the
service key never reaches the browser. Five failed attempts from one address or
one IP in fifteen minutes locks that door for fifteen minutes.

The page itself lives in the `app_page` table, not in the function, so changing
a screen is an `UPDATE` rather than a redeploy.
`project/build/supabase/functions/crux/app.html` is the readable source of that
page; the installed copy is the same program with its stylesheet comments and
indentation stripped.

### Signing in with Google

`auth_gate()` refuses any address that is not an active `@cruxindia.co.in`
person already on the people master. Sign-in matches a person; it never creates
one. The credential is verified *by Google* rather than decoded here — a token
this process merely reads is a token anyone can forge.

### Loading data

Data setup carries the uploader. **Thirteen file kinds, all implemented**, in
load order:

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
| 12 | SLA rules | the TAT per client, verification type, zone and priority |
| 13 | Escalation matrix | who is told, at which level, for which client and zone |

Each has a **Download template** button giving the exact headers, one example
row, and the rule for every column. Load them in order: People needs Chairs,
Clients needs Geography, Assignments needs both plus People.

Chairs was not in the original ten. The People template said the chair "must
already exist" and nothing could create one, so no person could be loaded at
all. SLA rules and the escalation matrix were not there either, which meant
every assignment took the one cutover rule at 1,440 minutes and every
escalation fell back to the reporting line.

Which function handles a kind is now a column on the kind, so a fourteenth is
two rows and a pair of functions — not an edit to two dispatchers and a
redeploy.

---

## Status

| Piece | Where | Live? |
|---|---|---|
| Database — 103 tables, RLS, functions | Supabase `crux`, ap-south-1 | **Yes** |
| Bulk upload — all thirteen kinds | Edge function, URL above | **Yes** |
| PMS appraisal cascade and scoring | Database functions | **Yes** |
| Dummy dataset — 17 people, 5 clients, 16 branches | Loaded through the uploader | **Yes** |
| Indian holiday calendar 2026–27 | 26 days, 6 confirmed | **Yes** |
| The rest of the API — cases, matrix, PMS, people, penalties | Edge function `api` | **Yes** |
| Front end — nine screens | Edge function `crux` | **Yes** |
| OGL engine — pause, auto-accept, escalation, strikes | Database functions | **Yes** |
| Scheduled jobs — auto-close, SLA, sub-TAT, escalation, strikes | `pg_cron`, every 15 min | **Yes** |
| Google sign-in | Configured | **Yes** |
| Mail — outbox, sender, four providers + Gmail | Edge function `mail`, every minute | **Yes** |
| A mail provider chosen and its key pasted in | Data setup → Mail | Yours to do |

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

`npm run worker` is no longer needed for anything. `pg_cron` calls
`crux_tick()` every fifteen minutes for auto-close, the SLA sweep, sub-TATs,
escalation and strikes, and `crux_mail_tick()` every minute to drain the
outbox through the `mail` function. Nothing here needs a machine.

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

### Raising one

**OGL → Raise an assignment.** One screen: the case, the applicant, where it is
to be verified, and the points to verify. It becomes a `verification_case` with
its parties and requirements, and an assignment in `DRAFT` with no clock
running.

Until v20 the only way an assignment existed was the cutover loader. That is
fine for a migration and useless for a Tuesday.

### The repeated Point ID

Point IDs are keyed by hand, and the same one legitimately recurs. A repeat is
therefore **not a duplicate to refuse** — it is a decision to route, and the
decision belongs to the assignor.

On entry of a Point ID that has been used before, the tool compares the address
against the previous attempt and proposes:

| | |
|---|---|
| `EXACT` / `NORMALISED` | the same address written differently → **Revisit** proposed |
| `FUZZY` with a score | close but not the same → **Revisit** proposed, with the number shown |
| `DIFFERENT` | → **New assignment** proposed |

*14-B M.G. Road* against *14B MG Road* is `NORMALISED`. Against *14-C M.G.
Road* it is `FUZZY 89` — close, and not the same house. **The proposal is never
applied by itself.** The point waits, the assignment stays in `DRAFT`, no clock
starts, and the row appears under **Repeated Point IDs waiting on you** until
the assignor picks one of four: revisit, reopen, unrelated new work, or keyed
in error. Calling a `DIFFERENT` address a revisit needs a sentence saying why.

"Overwrite" is a workflow word and never a storage one: a reopen supersedes the
prior attempt and the earlier report stays retrievable under its own cycle.

### The engine

Four things that used to be tables with nothing behind them now work, and each
one is visible on the assignment's own screen.

**The conditional pause.** A request for information stops the clock only when
all three hold: less than half the TAT has gone, no pause has been granted on
this cycle, and the reason is one that may stop a clock. The arithmetic is run
**before** the assignee submits and shown in full — each condition, pass or
fail, with the number behind it. Credit is capped at 120 business minutes; a
pause that lasts longer than that costs the difference. A refusal names the
test that failed rather than saying no.

**Delay auto-accept.** The assignor has an hour of business time to review a
reported delay. If nobody does, it accepts itself — and the time that follows
is recorded as `PENDING_REVIEW`: it counts against the deadline, because it
passed, and against nobody's record until a person says whose it was. It lands
in **Confirm attribution** on the OGL screen and the assignor's manager is
told. **One auto-accept per assignment.** A second unreviewed delay escalates
instead of self-approving, because otherwise silence becomes a renewable
extension.

**Escalation.** One adapter, `raise_escalation`, called from one place. It
resolves a recipient by client + location + branch, then client + location,
then location, then by walking up the line from the assignee. It never drops a
delivery because the matrix is incomplete — and it never lets the gap stay
quiet either: the walk is recorded on the row and the exact missing key is
mailed to the administrators. The idempotency key is the hash of assignment,
cycle, level and trigger, so a sweep that runs twice raises one escalation.

**Strikes.** Generated when three things hold together: the instance is
breached past its grace, the assignee's *own* attributed minutes exceed the
whole TAT, and no stretch of time on that cycle is still waiting to be
attributed. A strike is waived, never deleted; the row stays visible with the
reason and who waived it.

All four run inside `crux_tick()`, every fifteen minutes.

### Doing the work

The assignee records a finding against **each** verification point — positive,
negative, partial, refer, or untraceable — and anything but a clean positive
has to say what was seen.

Completion is a **delivery**, not a state change somebody types: it asks how
the report went out (Force1, e-mail, WhatsApp, the client portal, by hand), to
whom, and with what reference. That reference is what makes *was it actually
sent?* answerable in three months without relying on anyone's memory.

A move to `COMPLETED` while any point has no finding on it is refused — by the
trigger, not by the function, so it holds for every caller including one
nobody has written yet. Accepting the report closes the case's points as well
as the assignment; closing one without the other is how a case ends up closed
with a point still open on somebody's list.

### Disputes and arbitration

A dispute sends the work back to `REWORK` and stays open as a finding until
somebody classifies it. **Upheld** means the report was wrong — that is a
strike. **Not upheld** means the dispute was wrong — that waives any strike on
that cycle, visibly, with the reason on the row.

A third dispute goes to `ARBITRATION`, and the arbiter is **computed**: the
lowest manager both parties report to, found by walking both reporting lines
until they meet. Nobody nominates an arbiter, because a nominated arbiter is
one of the parties' choice, which is the thing arbitration exists to avoid.
Arbitration to rework records the dispute as upheld; arbitration to closed
records it as not upheld and waives the strike.

## Mail

**Data setup → Mail.** The outbox has existed since the first schema and until
now had no way out of the building. It has one.

You do not administer the Google Workspace this sits in, and you do not need
to. Two of the three routes need nobody's permission but yours:

| Route | What it needs |
|---|---|
| **A transactional provider** — Resend, Brevo, SendGrid, Postmark | An account, and two or three DNS records on a domain you control: SPF, DKIM, usually DMARC. No Workspace console. This is the route that scales and the one whose failures you can read. |
| **Gmail, your own mailbox** | The OAuth client you already own, with the `gmail.send` scope added and this tool's callback listed as an authorised redirect. You consent for your own mailbox. Google's own sending limits apply. |
| **SMTP, or a Gmail app password** | **Not possible here.** This runs as an edge function, which may make an HTTPS request and nothing else. There is no socket to port 587 from inside it, so an app password has nowhere to go. |

### Where the API key comes from

It is **not** a Google key, and you do not need the Google Console for it. You
sign up with the provider yourself and the key is on their dashboard within a
minute of registering — Resend calls it *API Keys*, Brevo *SMTP & API → API
Keys*, SendGrid *Settings → API Keys*, Postmark *Servers → API Tokens*.

**If you control no DNS either**, use *single sender verification*: you add one
address, the provider emails a confirmation link to it, you click the link, and
that address can send. Brevo, SendGrid and Postmark all work this way, and no
administrator of anything is involved — only somebody who can open the mailbox.
Free tiers run to a few hundred messages a day, which covers escalation traffic
comfortably.

Authenticating the domain (SPF, DKIM) later improves deliverability and raises
the limits. It is worth doing, and it is not a blocker for going live.

### Setting up a provider

1. Open **Mail**, choose the provider, fill in the from address and name.
2. Paste the API key and **Save**. The key goes into the database and is read
   only by the sender; nothing in the tool will show it to you again.
3. **Send me a test.** It queues a message and drains the queue immediately, so
   the answer you get is the real one, not a promise.

### Setting up Gmail instead

1. In your Google Cloud project, on the OAuth client you already have: add the
   scope `https://www.googleapis.com/auth/gmail.send`, and add
   `https://oxpwqfbtbxlvuqpztbwg.supabase.co/functions/v1/crux/api/mail/oauth/callback`
   to the authorised redirect URIs.
2. In **Mail**, choose *Gmail (your own mailbox)*, paste the client id and
   client secret, **Save**.
3. **Connect Gmail**, consent in the tab that opens, come back, send a test.

If Google says it returned no refresh token, that mailbox has consented before:
revoke the grant at myaccount.google.com/permissions and connect again.

### How it behaves

`pg_cron` wakes the sender every minute, and only when something is waiting.
Each message carries an idempotency key derived from the event, the recipient
and the day — **not** supplied by the caller — so the same notification asked
for twice is one message. A failure defers with a widening backoff and gives up
after six attempts, with the provider's own error text on the row. A daily cap
holds the whole queue rather than letting a loop empty the account.

An address ending `.invalid`, `.test` or `.example` is skipped, not attempted.
That is why the demo data queues nothing: every seeded address is
`@example.invalid` by design.

With no provider configured the sender does not touch the queue at all — it
reports `no_transport_configured` and leaves every message intact, so nothing
burns an attempt before anybody has set one up.

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
2. ~~Close the doors the linter found open.~~ Done — patch v19.
3. **Choose a mail provider and paste its key** (Mail), then send yourself a
   test. Until this is done the tool works and tells nobody. If you control no
   DNS, use single sender verification — see *Where the API key comes from*.
4. Load people, chairs and coverage by bulk upload, in load order.
5. Load the full holiday calendar and the rate card.
6. **Load SLA rules.** Without them every assignment gets the cutover default
   of 1,440 business minutes, and every deadline in the tool is fiction.
7. **Load the escalation matrix.** Not strictly required — escalation falls
   back to the reporting line and says so — but every fallback raises a
   configuration alert, and you will get tired of them.
8. `sample_purge()`, and clear the sample administrator's password.

---

## Layout

```
project/build/schema.sql            base schema — 103 tables
project/build/schema-patch-v3..v20  applied in order after it
project/build/supabase/             RLS, auth gate, storage buckets
project/build/supabase/functions/   the three live edge functions
  crux/   the front door: the page, sign-in, upload, OGL, mail settings
  api/    the ported Express routes
  mail/   the sender
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
