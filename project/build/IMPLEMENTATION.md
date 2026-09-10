# Crux Escalation Matrix — implementation plan

Everything here follows from the audit in `Crux Rebuild Blueprint.dc.html` and the decisions recorded in `PROJECT_STATE.md`. Design of the tool itself is the prototype `Crux App.dc.html`; the data layer is `build/schema.sql`.

---

## 0. Do this before anything is built

Case **ESC-00193** is still chasing. It has produced 1,889 e-mails to one colleague since 25 Aug (latest 3 Sep 11:51) and is what exhausted the Gmail quota, taking 86% of all outbound mail with it. Close the case or disable the strike sweep. No rebuild changes today's damage.

Second: `AUTOMATION_PAUSED` is currently `FALSE`, so the sweep is live.

---

## 1. Stack

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Database | **Postgres — Supabase free tier** | The deliverable of this rebuild is a set of unique constraints and one overlap trigger. Only a real database can hold them. 1,413 branches and ~6k audit rows fit the free tier with room to spare. |
| App | **One server-rendered app** (Next.js on Vercel free tier, or Node + Express + templates) | No SPA bootstrap payload. Works on a phone as ordinary HTML. Deployable by you from GitHub, which you already have. |
| Worker | **One scheduled worker** (Vercel Cron / GitHub Actions schedule) hitting internal job endpoints | Replaces `tick()` and its single script lock. Jobs are idempotent, so a duplicate trigger is harmless. |
| Mail | **Gmail API as `operations.alert@`** via a service account with domain-wide delegation | Your constraint. Free, and keeps the sender identity clients already recognise. |
| Auth | **Google Workspace OIDC** for staff · **email + password** accounts created by admin for field staff · **signed portal links** for clients | Matches the three populations you described. |
| Files | Postgres + Supabase storage for the logo asset | No Drive dependency for a 140px image. |

**Not chosen:** a queue service, Redis, a separate API tier, a mail vendor. At this size each would be complexity with no return. Revisit only when eligible recipients pass ~1,200/month.

---

## 2. Repository layout

```
crux-escalation/
  app/                     routes, server-rendered
    today/  clients/  cases/  people/  reports/  operations/  portal/
  lib/
    rules/                 ← ALL business rules live here, nowhere else
      dispatch.ts            R-01 eligibility gate
      mail-budget.ts         R-02 sender budget
      chase.ts               R-03 clock, R-04 idempotency
      autoclose.ts           R-05
      routing.ts             R-06 category → desk → head
      coverage.ts            R-07 overlap refusal
      matrix-chase.ts        R-08
      ai-budget.ts           R-09
    repo/                  one module per entity, the only place SQL runs
    mail/                  templates + Gmail transport
    audit.ts               every write goes through this
  jobs/
    outbox-worker.ts  monthly-dispatch.ts  case-chase.ts
    matrix-chase.ts   monthly-summary.ts   ai-anomalies.ts
  migrations/            schema.sql + numbered migrations
  migration/             one-time import from the sheet export
  test/
```

Rule of the codebase: **a route handler may not contain a business rule, and a job may not contain one either.** Both call `lib/rules`. That single constraint is what stops the current situation, where the same rule exists in several functions.

---

## 3. Build order

### P0 — weeks 1–4 · stop the bleeding, move the core
1. Schema + `audit_entry` + `migration_merge` (`build/schema.sql` as-is).
2. **Outbox and worker first**, before any UI: unique `idempotency_key`, `mail_budget` per day, quota error → `DEFERRED` with `not_before = tomorrow`, terminal `ABANDONED` after N attempts with an alert to the admin.
3. Migration (see §4) with a merge log and `source_ref` on every row.
4. Auth: Workspace OIDC + admin-created password accounts + signed portal links (hash only in `portal_link`).
5. Clients → branches → matrix editor, with the completeness gate live at the field.
6. Monthly dispatch over `dispatch_eligible_branch` (≈693 branches, one 09:00 window).
7. Automation health page + failure alerts + one-click re-run.
8. Client portal, account-free.

**P0 exit test:** run one dispatch in parallel with the old app and reconcile recipient-for-recipient against `delivery`.

### P1 — weeks 5–8 · first production version
Cases end to end (raise → route → chase → resolve → 7-day auto-close); Today per role; the four-channel incomplete-matrix chase; coverage editor with overlap refusal; case register and monthly summary as print documents; full-workbook export; audit search.

### P2 — weeks 9–12 · performance module, properly
Windows as records; targets, KPIs, attributes; person events (warning, PIP, appreciation); scorecard; warning and notice letters as print documents; the six AI features behind a monthly cap.

### P3 — later
Read-only API for the sibling tools; archive of pre-previous-FY data hidden from normal screens; WhatsApp/SMS (deliberately excluded now); client-facing PDF of the matrix (you chose e-mail body only).

Cut-over: hard switch on a month boundary, old app disabled, once P0's parallel dispatch reconciles.

---

## 4. Migration

Source: the 9.5 MB `.xlsx` export (26 tabs), already parsed — see `source/datastore-schema.md` and `source/audit-*.json`.

Order: `geo_node` → `client` → `client_zone` → `branch` → `branch_contact` → `person` → `designation`/`desk` → `coverage_rule` → `matrix_contact` → `category` → `case` → `case_event` → `person_event` → history tables.

Rules:
- **Drop 198,890 wholly empty rows** (99,917 in BRANCHES, 98,973 in BRANCH_ASSIGNMENTS). Nothing is lost: they contain no values.
- **Auto-merge by rule, log every merge** in `migration_merge`, mark the loser `superseded_by` — never delete. First merge: `aniket.chalke@cruxinida.co.in` (583 coverage rows) into `aniket.chalke@cruxindia.co.in`.
- **Collapse 1,729 assignment rows to ~40 coverage rules**, most specific wins, every collapse logged. Reconcile against `USERS.Scope*` (50 of 55 rows); where they disagree the explicit branch row wins and the discrepancy is logged for review.
- **`ESCALATION_MATRIX.Level` casts from `1.0` to integer.** 70 client-scope rows keep `branch_id` null.
- **`Copy of PEOPLE_EVENTS` is a primary source, not a backup**: 449 NOTE rows exist nowhere else. Migrate with `source_ref = 'Copy of PEOPLE_EVENTS!row'`.
- **217 branches with no code** get `<CLIENTCODE>-<SEQ>` and a review flag; the unique constraint then holds.
- **1,794 stale `DISPATCH_QUEUE` PENDING rows** for elapsed months become `ABANDONED` with a reason. Do not resend them.
- **Not migrated:** `Sheet4` (debug scratchpad), `SCORE_LEDGER` (0 rows), `WARNINGS` (0 rows), `HOLIDAYS` (0 rows — create empty and **populate before go-live**, because rule R-03 claims to use it), `EMAIL_LOG.RetryBody` (bodies do not belong in a ledger).
- **Requires a human decision:** `Rest of Maharashtra` and `Indore-MPCG` are not a single geographic level; `Audit/Quality` desk ownership (Operations or Compliance).

Every migrated row carries `source_ref = '<tab>!<row>'`. Backward traceability is a hard requirement, not a nice-to-have.

---

## 5. Rules, restated as code contracts

| Id | Rule | Enforced by |
|---|---|---|
| R-01 | Dispatch only branches with 5 complete levels (name + mobile or e-mail), active branch and active client | `dispatch_eligible_branch` view |
| R-02 | Daily recipient budget with reserve; quota error defers to tomorrow, never retries today | `mail_budget` + outbox worker |
| R-03 | 24 working hours between strikes, 10:00–17:00 IST, weekends and holidays excluded; strike 2 adds the desk, strike 3 addresses HR and copies the MD | `case.next_chase_at` + `holiday` |
| R-04 | One send per key, ever | `outbox_idempotency_uniq` |
| R-05 | Auto-close 7 days after resolution with no objection | `case.auto_close_at` |
| R-06 | Category → desk → desk primary; vacant desk ⇒ case `BLOCKED` and visible to admin, never silent | `category`, `desk`, `case_has_owner` |
| R-07 | Overlapping coverage cannot be created | `coverage_rule_no_overlap` trigger |
| R-08 | Incomplete matrix ⇒ weekly manager e-mail + blocking home task + location-head escalation at 14 days + line in monthly summary | `matrix-chase` job |
| R-09 | AI monthly call cap per feature; grey out with reset date when spent | `ai-budget` |

All of the above are rows an admin can change on the Operations → Configuration screen. **No rule change requires a deployment** — that was an explicit requirement.

---

## 6. Permissions

One policy table, not ~90 per-route opinions. Shape: `role × entity × action`, with row scope resolved from `coverage_rule`. Every entry must read as a sentence:

- A **Manager** may edit a `matrix_contact` for branches their coverage rules resolve to.
- A **Location Head** may raise and work a `case` for branches they cover.
- A **Viewer** may read `case` and reports within their scope, and write nothing.
- Only an **Admin** may edit `category`, `desk`, `job_config`, `template`, `holiday`, or grant an escalation exception.
- Nobody, including an Admin, may move a **pinned** category off Compliance.
- MD office is `escalation_only` — never a first recipient.

---

## 7. Verification before cut-over

1. Recipient reconciliation: one parallel dispatch, `delivery` vs the old `EMAIL_LOG`, recipient for recipient.
2. Constraint proof: attempt the known-bad writes — the misspelt-domain person, an overlapping coverage rule, a duplicate branch code, a duplicate idempotency key. All four must be refused.
3. Storm regression: force a chase on a resolved case and confirm zero sends; force 100 chase attempts in one window and confirm one send.
4. Traceability: pick 20 random migrated rows and walk each back to its sheet tab and row via `source_ref`.
5. Print: the four documents at Letter and A4, header repeating, nothing clipped.
6. Phone: every screen at 390×844, 44px targets, no horizontal scroll.

---

## 8. Still not verified

The `.gs` sources beyond `Code.gs` (Sheets, Auth, Clients, Escalation, Email, Scheduler, Import, Utils, Gemini, and the HTML files) — the uploaded `.docx` arrived as 0 bytes. Nothing above depends on them; the migration scripts will benefit from a function-level read, chiefly to confirm no business rule exists that this document has missed.


---

# v2 — organisation, daily counts and the penalty engine

Added 3 Sep 2026 from the attached operating structure and the review comments. Prototype: `Crux App v2.dc.html`. Schema additions are at the foot of `build/schema.sql`.

## What changed conceptually

The tool is no longer an escalation register with some admin around it. It is the **operating system for the chart**: 70 chairs, 188 owned processes, 14 functions. Three consequences run through everything:

1. **Ownership resolves through a chair, never a name.** `chair` → `chair_holder` → `person`. A chair has one primary holder, which is what breaks the "two people hold AVP Operations" tie. Vacate a chair and the work is visibly unowned rather than silently lost.
2. **Every department gets a different tool.** The dashboard, the nav, the client view, the reports and the escalation action set are all derived from the chair. HR has no client view at all; Operations owns the matrix; Finance and Business Development see branch contacts only (`client_view_policy`).
3. **Consequence is data.** Deadlines are not advice: `penalty_rule` and `penalty_instance` make the cost of missing one explicit, recoverable and auditable.

## Daily business count

`kpi_definition` → `kpi_target` (set by the manager, `check (set_by <> person_id)` so nobody sets their own) → `daily_count`.

- The target is rendered read-only to the holder. It is not a UI convention; the write path refuses it.
- The window closes at 23:59; the row is then stamped `locked_at`. Reopening requires an administrator **and** a reason (`daily_reopen_needs_reason`).
- Missing the window fires rule P-01 through the nightly penalty sweep.
- Roll-ups mark themselves *provisional* when any contributor has not submitted, which is what MIS reports on.

## Penalty engine

An administrator defines: the action, who it applies to (chair, department or everybody), how often it is checked, the cutoff date and time, the amount, and who recovers it. Seven rules ship as defaults (P-01 daily count, P-02 escalation TAT, P-03 targets not set, P-04 appraisal late, P-05 team details, P-06 matrix incomplete, P-07 letter not acknowledged).

Design rules that matter:
- `penalty_instance.amount` is **copied at firing time**. Changing a rule never rewrites history.
- `penalty_no_duplicate unique (rule_id, person_id, occurred_on, entity_id)` — the same miss cannot be charged twice.
- `evidence` is mandatory and states what proves it ("no daily_count for 2026-09-01"), so a dispute is arguable on fact.
- HR recovers P-01 to P-05 and P-07 through payroll; **Finance recovers P-06** by billing. The ledger is filtered by `recovered_by`, so each function sees only what it collects.
- A waiver needs an author and a reason (`penalty_waiver_needs_reason`). Disputed lines are held, not collected.

## Escalations, not cases

Renamed throughout. The action set is generated from the **part the viewer plays** (`escalation_party`, `escalation_action`), not from their app role:

| Part | Actions |
|---|---|
| Raiser | Resolved — no action needed *(no PMS impact)* · Withdraw *(no PMS impact, reverses P-02)* · Escalate a level *(locked until 7 working days with no response)* · Needs immediate action *(alerts HR and the respondent's manager, TAT drops to 24h)* · Add update |
| Person concerned | Accept and resolve · Dispute *(routes to the raiser's manager + HR, pauses the clock, holds P-02)* · Add update *(clock keeps running)* |
| Their manager | Act on their behalf · Resolve on their behalf · **Issue a warning letter directly** · Refer to HR |
| HR | Decide a dispute *(sets the PMS outcome)* · Issue a letter · Waive a penalty · Close with outcome |
| Desk | Take ownership · Add update · Return to Operations *(flags the category for admin review)* |
| Administrator | Reassign desk *(pinned categories excepted)* · Reopen a locked window *(reason required)* · Adjust a penalty |

`escalation_action.pms_impact` is what makes "resolved, no action needed" meaningfully different from "resolved" — the first deliberately does not touch the performance score.

## Clients, locations, branches

`client` → `client_zone` / location → `branch` → `matrix_contact`. Two additions:

- **Add location** and **add branch** are first-class actions. A branch inherits the **client-level default matrix** until it has its own (`branch_effective_matrix`), so a new branch is dispatchable on the day it is created instead of silently missing from the dispatch.
- `dispatch_eligible_branch_v2` computes the five-level completeness test over the *effective* matrix — inherited or own — and reports which branches are leaning on the default.

## People

- The tree shows **direct reportees expanded, indirect collapsed** under the person they actually report to. An indirect reportee's target belongs to their own manager, and the UI says so.
- **Add person** writes a `person_request`, not a person: `AWAITING_HR` → `AWAITING_ADMIN` → `ACTIVE`. HR approves the chair and terms; the administrator creates the account. Rejection requires a reason.

## Notifications

`notification` + `push_subscription`. Anything carrying a deadline — daily count closing, escalation TAT, target cutoff, unacknowledged letter, job failure — is pushed as well as e-mailed; informational items are in-app only. Managers and administrators receive push by default.

## Build order revision

P0 is unchanged in intent but gains two items, because they are what makes the deadlines real:

- `chair`, `chair_holder`, `process` and the RACI import from the operating structure — everything else resolves through it.
- `penalty_rule` / `penalty_instance` with the nightly sweep, plus `daily_count` and `kpi_target`.

P1 gains the escalation action sets and letters; P2 keeps the appraisal and scorecard work, which now reads its inputs from `daily_count` and `penalty_instance` rather than asking anyone to retype them.

## Decisions taken — 3 Sep 2026

These four were open at the foot of the v2 notes. All are now settled and reflected in the prototype and the schema.

### 1 · Audit/Quality → Operations desk
Operations now receives **14 categories** (service delivery, delay/TAT, report quality, data accuracy, customer handling, communication, assignment/allocation, client/branch mapping, client requirements, escalation handling, vendor/partner, audit/quality, plus the two orphan groups folded in earlier). Compliance keeps **3**: compliance, fraud/integrity and data privacy — the last two `pinned`, unmovable by anyone including an administrator.

### 2 · Geography resolution
Two old "regions" were not a single level. They resolve as:

| Old value | Becomes |
|---|---|
| `MUMBAI` | West → Maharashtra → **Mumbai** |
| `Pune` | West → Maharashtra → **Pune** |
| `Rest of Maharashtra` | West → Maharashtra → **Rest of Maharashtra** (every Maharashtra city that is not Mumbai or Pune) |
| `Indore-MPCG` | **split in two**: Central → Madhya Pradesh · Central → Chhattisgarh |

Migration consequence: every branch currently tagged `Indore-MPCG` must be reassigned to whichever of the two states it is physically in. That cannot be inferred from the sheet, so the importer writes those branches to a review queue with their address, rather than guessing. `Nashik`, `Solapur`, `Kolhapur`, `Jalgaon`, `Latur`, `Aurangabad` and the other Maharashtra city values fold into **Rest of Maharashtra** as cities, which is what makes them a level rather than a leftover.

### 3 · Penalty rules — HR and Finance own them too
`penalty_rule` is writable by **Administrator, HR and Finance**, with **no approval layer**: add, edit and delete directly. Clocks, desks, categories and coverage stay administrator-only. In the prototype, opening the tool as Valsan P (HR) or Sneha Radhe (Finance) shows Configuration with the Penalty rules tab alone, and Edit / Delete on every rule.

Two guarantees remain regardless of who edits:
- `penalty_instance.amount` is copied at firing time, so changing a rule never rewrites what has already been charged.
- Deleting a rule stops it firing from that moment; instances already raised stay in the ledger with their evidence. Both actions are written to `audit_entry` with the actor.

Policy shape for the write path:

```
allowed_to_edit_penalty_rule = person.department in ('Human Resources','Finance & Accounts')
                               or person.app_role = 'ADMIN'
```

### 4 · Franchise partners are in scope
Penalties and daily counts apply to the four partner chairs as well as to employees. Two consequences:

- `penalty_rule.applies_to` becomes **multi-select**, not a single string. Options: Everybody, a department, a named chair, Managers with reportees, Executives, Team Leaders, Branch Managers, Regional Managers, **Franchise Partners**, Interns. A rule may carry several.
- Recovery differs by employment type: employees are recovered through payroll by HR; **partners are billed**, so their instances route to Finance regardless of the rule's default. `person.employee_type` drives this, and the ledger already filters by `recovered_by`.

Schema delta:

```sql
alter table penalty_rule
  drop column applies_to,
  add column applies_to text[] not null default '{Everybody}';

-- partners are billed, never deducted
create or replace function penalty_recovery_for(p_person uuid, p_rule uuid) returns text as $$
  select case when (select employee_type from person where id = p_person) = 'PARTNER'
              then 'FINANCE'
              else (select recovered_by from penalty_rule where id = p_rule) end;
$$ language sql stable;
```

## Still open

Nothing blocking. The only outstanding input is operational rather than architectural: the per-branch state for the branches currently tagged `Indore-MPCG`, which the migration review queue will collect at import time.


---

# v2.1 — performance, consequence and the rest of the operating tool

Second review round, 18 comments, all actioned in `Crux App v2.dc.html`. Schema additions at the foot of `build/schema.sql`.

## Performance management (the largest gap)

The old tool had scoring tables that were barely written to. The replacement makes the PMS the spine that the daily count, escalations, warnings, appreciations and tasks all feed.

**Structure.** Five KPIs per person — **three mandatory, two optional** (`kpi_definition.mandatory`, `position`). Each may carry **sub-categories** the manager defines — client, location, product, anything (`kpi_definition.parent_id`, `kpi_target.parent_target_id`). Achievement is shown as a percentage at both levels.

**Targets** are set by the manager and are read-only to the holder — enforced by `kpi_target.set_by <> person_id`, not by hiding a field. Last month sits beside each KPI when a manager sets the new one, so targets come from evidence.

**Attributes** are everything beyond the KPIs: tasks a manager assigns (`task`), appreciations received, and open notes. The final score is `kpi_score × kpi_percent + attr_score × attr_percent`, and the split lives in `pms_weighting` — set by Admin or HR **for everybody, for a chair, or for one person**. Impact of an escalation, warning or appreciation on the score is `pms_impact`, also Admin + HR owned. Nothing is hard-coded.

**Eligibility matrix** is optional per KPI (`kpi_eligibility`): a gate such as "TAT ≥ 85%", and on a miss either **deduct N points** or **fix a default score**. A manager sets it for their reportees; an administrator can set it for everybody or for selected teams.

**The open note is the interesting part.** Each day a person can write a free-text note alongside their numbers. Nightly, the assistant classifies it as an **Attribute** with a suggested heading, or as **FYI** — kept on record, not scored (`daily_note.classification`, `attribute_heading`, `model_reason`). Both are compiled into `pms_score.review_summary`, so when a manager scores 1–10 at month end they are reading evidence rather than remembering. The assistant never scores anyone; it only files and summarises.

## Four things you can raise, not one

`raisable` sits behind one menu: **escalation**, **warning letter**, **appreciation**, **request assistance**. Rules that matter:

- A warning may be raised by a manager against a direct or indirect reportee, by HR against anyone, or **automatically at strike 3** (`raisable.auto_source = 'STRIKE_3'`) — so the three-strike policy no longer depends on somebody remembering.
- An **assistance request becomes a task on the responder** (`request_task`). If it is not actioned by its due time, the three-strike clock runs and an escalation is raised **against the responder** automatically.
- Escalation, warning and appreciation all carry `pms_points` copied from `pms_impact` **at raise time**, so re-tuning the impact later never rewrites a closed month.

## My profile

Own employment, contact and document details; the tasks waiting on you in one list, whatever raised them — HR, another department's request, or a penalty rule cutoff. Raising a request from any department is done here, and the consequence of ignoring one is stated on the card rather than discovered later.

## Visits and expense claims

The visit form is **configuration per department** (`visit_form_field`) — an HR engagement visit and a Finance reconciliation visit ask different questions. Claims follow the chain you specified:

```
DRAFT → OPS_APPROVAL → HR_APPROVAL → ACCOUNTS → PAID
                                          ↘ DISPUTED → back to the raiser
```

`claim_paid_ref` forces a payment reference on PAID; `claim_dispute_reason` forces a reason on DISPUTED. A dispute sets the claim back to not-approved and returns it to whoever raised it, exactly as asked.

## Ideathon

Open to every chair, owned by Operational Excellence. `idea` moves SUBMITTED → IN_REVIEW → ACCEPTED → INITIATED (charter recorded) → DELIVERED, with ON_HOLD and REJECTED available at any point and a **mandatory reason** on both (`idea_decision_reason`). `idea_collaborator` carries the people invited in. The originator is always told what happened and why — the failure mode of every suggestion scheme is silence.

## HR workspace

Onboarding (`onboarding`), employee information, satisfaction (`pulse_response`) and performance. **No payroll**, as instructed. HR and the administrator share the roles panel: chair, designation, department, reporting line, app role and visibility — changing a chair re-resolves coverage, KPIs and desk membership in one move.

## Configuration — nothing hard-coded

`app_setting` holds every value the old tool buried in a script or a settings row, each with a `plain_language` line shown verbatim in the UI, and `editable_by` so HR and Finance can own penalty rules while clocks and desks stay with the administrator. Seven tabs: penalty rules, clocks and cutoffs, desks and categories, coverage and scope, e-mail and templates (sender alias — validated against the account's real aliases — reply-to, signature builder, logo, CC by role, versioned templates, test mode with a permanent banner, reminder days, dispatch granularity), assistant (provider, model, masked key, monthly cap, per-feature triggers), and jobs with **twelve re-runs**, each safe because every job is idempotent.

## Notifications that lead somewhere

Every alert carries a route and a guide key. Clicking one lands you on the screen where the work is done and opens a short step-by-step panel (`assist_guide`); the panel is dismissible and re-openable from **How do I do this?**, and its content follows the screen. Anything with a deadline is pushed as well as e-mailed.

## Provenance

Every dashboard figure states its source underneath — "from your daily counts, summed · target set by Nitish Bhope", "from live matrix completeness, rule R-01". A number nobody can trace is a number nobody trusts, and the old tool was full of them.

## Build order, revised again

P0 gains `app_setting` and `assist_guide` (they cost little and remove the hard-coding that caused the original mess). P1 gains the raisables, tasks, requests and claims. The PMS — KPIs, sub-categories, weighting, eligibility, notes and scoring — is the whole of P2 and should not be compressed: it is where the old tool's data was thinnest and the new tool's consequences are heaviest.


---

# 12. ADMIN SETUP — ASSISTANT KEYS, AI USES, MAILBOX  (added 3 Sep 2026)

## 12.1 Assistant key chain
```sql
create table ai_key (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,              -- gemini | claude | openai | azure | compatible
  model         text not null,
  key_encrypted bytea,                      -- null = empty slot
  endpoint      text,                        -- only for self-hosted/compatible
  chain_order   int  not null,
  scope         text not null default 'everything',  -- everything|short|long|fallback
  monthly_budget int not null default 0,
  used_this_month int not null default 0,
  state         text not null default 'untested',   -- healthy|untested|erroring|no_key
  last_tested_at timestamptz,
  last_latency_ms int,
  unique (chain_order)
);
```

**R-AI-1 · fallback chain.** Calls try keys in `chain_order`. A key that is spent, erroring or unset is skipped and the next takes the call. A feature never stops because one key ran out.
**R-AI-2 · exhaustion.** If every key is spent, assistant controls grey out with the reset date. The underlying work continues without AI — never a blocker.
**R-AI-3 · test before save.** Saving sends one minimal prompt and requires a reply. Untested keys are flagged and never placed first. The test costs one call and is written to `audit_entry`.
**R-AI-4 · scope.** A key may be restricted to short tasks, long reasoning or fallback only, so a costly model is not spent on classification.
Keys are encrypted at rest, shown masked, and never written to `audit_entry` or any log.

## 12.2 Where AI is used — 12 touchpoints
| Where | What | Mode | Model | Guard |
|---|---|---|---|---|
| Raise escalation | Suggests category → decides desk | on click | flash | user confirms before routing |
| Raise escalation | Drafts description | on click | flash | user edits before save |
| Escalation updates | Drafts update / resolution note | on click | flash | assistant never sends |
| Daily count · open note | Files as Attribute w/ heading, or FYI | nightly | flash | classifies only, never scores |
| Performance | Assembles monthly review summary | monthly | pro | manager still scores 1–10 |
| Ask the data | Answers a plain question | on click | pro | **strictly inside asker's coverage** |
| Weekly anomaly scan | Flags outliers | Mon 07:00 | pro | only scheduled use; flags not actions |
| Visit findings | Notes → findings + actions w/ owners | on click | flash | user approves before tasks created |
| Claims | Reads bill, fills amount + category | on upload | flash | user checks; original bill retained |
| Ideathon | Groups near-duplicate ideas | on click | pro | grouping only, never decides |
| Client matrix | Flags suspect contact | on save | flash | warning beside field, not a block |
| Monthly summary | Writes covering paragraph | monthly | pro | numbers from DB, never the model |

Server-side invariants: the assistant **drafts, classifies or summarises** and never routes, sends, scores, approves or closes; ask-the-data is coverage-scoped; report figures always come from the database.

## 12.3 Sending mailbox
```sql
create table mail_config (
  id smallint primary key default 1,
  mailbox text not null,
  auth_mode text not null,          -- service_account | oauth | smtp
  service_account_email text,
  delegation_client_id text,
  reply_to text,
  daily_budget int not null default 1800,
  used_today int not null default 0,
  signature_json jsonb,
  signature_logo_file uuid,         -- uploaded file, NOT a drive link
  test_mode boolean not null default false,
  test_address text,
  test_mode_expires_at timestamptz,
  bounce_strikes int not null default 3,
  last_tested_at timestamptz,
  check (id = 1)
);
create table mail_alias (id uuid primary key, address text unique, verified boolean);
```

- Service account + domain-wide delegation on `gmail.send`: sends as `operations.alert@` without holding a password, and survives a password change.
- **Connection test** sends to a sink address and reads the message id back — proves delivery, not merely valid-looking settings.
- Aliases chosen from what the mailbox owns, so a typed address cannot fail silently.
- Budget 1,800 of 2,000 with 200 reserved for interactive mail — the ceiling the old tool breached 1,849 times.
- Signature **built from fields**; logo must be an uploaded file. A Drive share link renders broken in mail clients, which is why the current tool's signature logo has never appeared.
- **Test mode** replaces every recipient with one address, shows a banner to all users, and self-expires (2h / 24h / manual) so it cannot silently swallow a month of client mail.
- **Bounce handling**: three hard bounces mark a recipient unreachable and raise a matrix task rather than retrying forever.

## 12.4 Access
All three areas are Administrator-only. Verified by sweep: no other chair — HR, Finance, MIS, Business Excellence, Legal, Operations, Partner — can reach them.

---

# 13. AUDIT & STRESS TEST RESULT — 3 Sep 2026

**Coverage:** 13 chairs × 115 tabs. Zero blank screens, zero crashes, zero `undefined`/`NaN` reaching the UI. 35 forms defined, all reachable, none referenced-but-missing.

**Verified per chair:** every chair shows its own dashboard headline, its own KPI set (5 KPIs, 3 mandatory + 2 optional) and its own alerts. No chair borrows another's identity — the earlier fallback that made new chairs display a Branch Manager's dashboard has been removed; a chair with no data states so rather than borrowing.

**Defects found and fixed this round**
1. Six new chairs borrowed `BM_P`/`ADM` dashboards, alerts, KPIs and penalty panels via a level-based fallback → each now has its own; missing data yields an explicit empty state.
2. `RM_W`, `OPS`, `HRH`, `FIN`, `MIS`, `ADM` had no KPI sets of their own → all six authored.
3. Assistant keys, AI-uses register and mailbox setup did not exist → built, with add/test/reorder, fallback chain, and three dedicated setup forms.

**Method note, now confirmed twice.** The preview intermittently serves a stale compiled copy: three "failures" this round (mailbox forms not routing, guide panel missing, badges absent) were all stale-runtime or case-sensitive-regex artefacts, not defects. Every finding is now re-checked after a forced reload before being treated as real.


---

# 14. AUTHENTICATION JOURNEY  (wired 3 Sep 2026)

The sign-in screen existed in the template but was **unreachable** — it rendered alongside the app rather than instead of it, so nobody ever saw it. Now gated on `session.authed`.

## 14.1 Three ways in  (revised 4 Sep — clients removed, mobile identity added)
| Route | Who | Mechanism |
|---|---|---|
| Google Workspace | most staff | Real Google account chooser popup. The tool asks Google who you are; it never presents a list of colleagues to pick from. Only cruxindia.co.in accepted. No password held. |
| User ID + password | field staff, franchise partners | **Identity is the mobile number, not an e-mail.** User ID chosen at activation and unique per person. Argon2id, rate-limited. |
| Invitation code | first-time users | Mobile + OTP → choose user ID → set password. Single-use code, 7-day expiry, exchanged once then destroyed. |

**Clients do not use this tool at all** — no client login, no portal journey. They receive the matrix in their monthly e-mail. Nothing client-facing needs building or maintaining.

### Why identity is the mobile number
Several people at one branch share a single inbox (`bo.pune@`, `bo.nagpur@` — confirmed in the datastore: 10 POC e-mails cover all 1,413 branches). An e-mail address therefore cannot identify a person, cannot carry a password reset, and cannot be an audit subject. `person.mobile` is unique and required; `person.user_id` is unique and chosen at activation; `person.email` is optional and explicitly **not** unique.

## 14.2 Rules
- **R-AUTH-1** An invite code is exchanged once and destroyed. It never becomes a standing credential — the defect that let anyone holding an admin's link become an admin.
- **R-AUTH-2** Password reset is by mobile OTP, never by e-mail, and never reveals whether a number is registered.
- **R-AUTH-3** `person.email` carries no uniqueness constraint and grants no access; `person.mobile` and `person.user_id` are both unique and are the only credentials.
- **R-AUTH-4** Session carries the **chair**, not a typed role. Multi-chair users switch seat inside one session; coverage, KPIs and desks re-resolve on switch.
- **R-AUTH-5** Sign-out clears the session and returns to the sign-in screen.

## 14.3 Forms added this round
`editRole` (HR + admin: chair, department, reporting line, visibility, employment type, second chair) · `weighting` (PMS split, eligibility behaviour, escalation/warning/appreciation impact) · `location` (name, zone, state, client, client's own zone name, coverage owner).

**Form count: 38, all reachable, all rendering in the shared modal overlay.**


---

# 14. MIS LAYER — AUDIT, ARCHITECTURE, IMPLEMENTATION  (7 Sep 2026)

## 14.1 Pre-build audit (Part 1)

**Finding A — the artefact is a design prototype, not a running application.**
There is no server, database or API. Parts 13 and 34 (server-side permission
enforcement, penetration testing) therefore cannot be *executed* — they are
**specified** here and must be re-tested against the real backend once built.
Anything claiming to be a security test result in a prototype is theatre.

**Finding B — no rate, revenue, MTD or business-volume entity exists.**
Grep of the whole application: `static RATE` / `static REVENUE` /
`static BUSINESS` / `resolveRate` — all absent. "revenue" and "MTD" appeared
only as incidental prose. So under the no-duplication rule (Part 1.4) these are
**net-new**, and there is no existing capability to extend.

**Finding C — the masters the MIS needs already exist and were reused.**
Employee, chair, client, location, geography (Zone → State → City), team and
reporting line are already modelled. The MIS references them; it does **not**
create employee, client or location tables of its own.

**Finding D — Reports already exists as a chair-scoped list of report cards.**
So MIS and the 10-day view were added as entries in that existing list, not as a
parallel section (Part 3). Rate master appears there only for Admin and Finance.

**Finding E — one real defect found and fixed during implementation.**
The achievement column rendered twice on rows matching two overlapping
conditions (`45.0% 45.0%`). Root cause: two `sc-if` branches where the second
condition was wrong. Fixed by removing the branch entirely — colour is styling,
not control flow — and pre-computing the tint in the view model.

## 14.2 Architecture (Part 4) — one engine, two views
```
BIZ (operational records: client, location, month, MTD, 10th-day, target, revenue)
        │
        ▼
resolveRate(client, location, date)      ← single implementation
        │
        ▼
misRows(month)   scope applied HERE, before any total
        │
        ├─ misAgg(rows)     weighted: total revenue ÷ total MTD
        └─ misGroup(rows, dims)  arbitrary hierarchy
        │
        ├──► MIS dashboard
        ├──► 10-day management view
        └──► future executive analytics
```
There is no second rate function, no second aggregation and no MIS-only data
store. A change to rate precedence cannot make the two views disagree.

## 14.3 Rate resolution (Parts 2, 5.1, 5.2)
Precedence, deterministic:
1. **exact** — client + that one location
2. **group** — client + selected locations
3. **client** — client, all locations
Within a tier, the latest `effective_from` not after the reporting date wins.
No match ⇒ `rate = null` and a **visible exception** — never another scope's rate.

- Reporting date for a month is its **last day**, so a W.E.F. change applies from
  the month it takes effect and never rewrites a closed month.
- **Future-dated rates are withheld.** Verified: CLI-00012 · Nagpur has a ₹172
  rate effective 2026-10-01; September resolves ₹164 (client-wide).
- **Stored revenue is the source value.** The derived rate (revenue ÷ MTD) is
  diagnostic only. Neither value is ever silently overwritten.
- **Zero MTD does not divide.** Derived rate is *not applicable*; stored revenue
  is preserved and the record is flagged.
- **Aggregate rate is weighted**, never an average of child rates. Verified:
  Nagpur = (318×170 + 520×164) ÷ 838 = **₹166.28**.

## 14.4 Scope enforcement (Parts 10, 11, 13)
`misScope()` resolves the chair's coverage and `misRows()` **filters before
aggregating**. A filter therefore cannot widen what a user sees — it can only
narrow an already-restricted set. Verified: the Pune Branch Manager's MIS shows
one location and one zone; the Nagpur partner sees Nagpur only.

> **Build requirement:** in the real system this predicate must live in the data
> query, not the client. The prototype demonstrates the intended semantics; it
> does not prove enforcement.

## 14.5 Forecast (Parts 16, 27)
All four workbook multipliers are retained in the engine — **3.25× Conservative,
3.5× Base, 4× Stretch, 5× kept as Aggressive**. Multipliers are configuration,
not code. Projected revenue resolves the rate **per record** and then sums;
applying one blended rate to a multi-location client would misstate it.
Verified: 3,724 × 3.5 = 13,034 MTD, ₹23,40,170 projected, implied ₹179.54.

## 14.6 OPEN — blocked on one file
`Vicky_Zonewise Monthly Business Tracker Sep 2026 As on 4 Sep 2026.xlsx` is
**not in the project**. Consequently Parts 2, 31 and 32 are **NOT VERIFIED**:
- which multiplier the business maps to Conservative / Base / Stretch;
- the Main Tracker's Zone A / Zone B / ROI / Pan India roll-up definitions;
- reconciliation of Target, Actual, MTD, Revenue, Achievement %, YTD.

The multiplier-to-label mapping above is the ascending-order default and is
Admin-editable. It must be confirmed against the workbook before go-live.


---

# 15. MIS UI/UX COMPLETION  (7 Sep 2026)

Continued from §14 without restarting. Nothing was rebuilt: the rate-resolution
layer, aggregation and scope predicate from §14 were reused unchanged, and the
work below is the interaction layer over them.

## 15.1 What was already done (§14) — kept as baseline
Rate master with scope + W.E.F. precedence · weighted aggregation · scope applied
before aggregation · exceptions surfaced not hidden · four retained forecast
multipliers · MIS and 10-day reading one engine · entries inside the existing
Reports list.

## 15.2 Added this pass
**Filter bar (Parts 15–17).** Compact `Filter` button opens a panel; selections
appear as removable chips with `Clear all`. Options are **dependent** — picking
North-East removes Pune from the location list (verified). Filters run inside
`misFilter()` over an already-scoped set, so a filter can only narrow.

**Sortable columns (Part 29).** Every metric header sorts, toggling desc→asc, with
an arrow indicator. Sorting is **within each parent group**, so the hierarchy
never breaks apart; the UI states this ("Sorted by Gap, within each parent group").

**Clickable KPIs (Part 7).** Each card re-sorts the table by its own metric —
Achievement sorts lowest-first, Shortfall largest-first. Verified.

**Comparison (Part 28).** `Compare with 2026-08` adds prior-period, change and
growth columns, joined by row id through `misPrevMap()` — the same grouping code,
so a comparison can never disagree with the base table.

**Customize drawer (Parts 12–14).** Row dimensions are added, removed and reset in
a panel, not permanently occupying the dashboard. It states the aggregation rule:
percentages and rates are **recomputed at each level, never summed or averaged**.

**Expand/collapse all (Part 8)** · verified 3 rows collapsed, 23 expanded.

**Empty state (Part 18).** Explains *why* there is nothing — no records in scope
versus no records matching filters — and offers `Clear filters`.

**Export preview (Part 37).** Shows period, scope, zone/location/client/row counts
and grouping before exporting, and states that rate columns are labelled
Configured / Derived / Weighted.

**Sticky hierarchy + headers (Part 11).** The row-label column is
`position:sticky;left:0` and survives horizontal scroll of the metric columns.

**10-day table (Part 26).** Full column set: 10th day, current MTD, added since,
Conservative, Base, Stretch, target, forecast %, gap. All three scenarios show
side by side; the selected one is emphasised.

**Deterministic insights (Part 27).** Largest gap to target, lowest achievement,
strongest growth — computed from permitted rows only, each clickable to re-sort.
No generated commentary.

**Rate history (Parts 34–35).** Per-client version list, oldest first, with scope,
effective range, author and reason. Future-dated versions are labelled
"not yet applied" (verified on RT-008, ₹172 effective 2026-10-01). The panel
states that a past month reports on the rate valid then.

**Report access management (Part 31).** Inherited access (chair, reporting line,
coverage rules) is shown **separately** from explicit grants, which is what makes
a permission audit possible. Grants carry scope, level, granter and date, and are
individually revocable. `View` cannot be switched off — remove the grant instead.
Export carries a written warning.

## 15.3 Defect found and fixed this pass
**Report state followed the chair.** Applying a client filter as the Branch
Manager and then switching to Admin carried the filter across, so an admin saw a
single client's 300 MTD instead of the company's 11,128. Same class as the
earlier location-stickiness bug. Switching chair or seat now clears filters,
sort, comparison and every open panel. Verified: chip gone, 23 rows restored.

## 15.4 Still not verifiable — unchanged from §14
- **Server-side enforcement (Parts 32, 43-permissions).** There is no backend in
  this artefact. `misScope()` demonstrates the intended predicate; the build must
  place it in the data query. A prototype cannot prove enforcement.
- **Excel reconciliation (Parts 2, 31, 32 of the prior brief).** The workbook is
  unavailable. Extension points are in place: `Component.SCENARIOS` is the
  multiplier table, `resolveRate` is the single rate authority, and
  `misAgg`/`misGroup` produce the roll-ups to reconcile. When the workbook
  arrives, confirm (a) which multiplier maps to Conservative/Base/Stretch and
  (b) the Zone A / Zone B / ROI / Pan India roll-up definitions.
  No data was invented to compensate.


## 15.5 Verifier round — three defects fixed (7 Sep 2026)

**1 · "Strongest growth" printed a decline.** `grownBest` took the top of a
descending sort with no positivity guard, so in a month where every entity
declined it labelled −9.5% as growth — and named the same entity as both lowest
achievement and strongest growth. Now guarded: positive growth prints as
"Strongest growth +x%", and when nothing grew the card re-labels itself
"Smallest decline … nothing grew this month". Verified on both screens.

**2 · Grey voids in the KPI strips.** The hairline divider lived on the grid
*container* (`background:#e2e0da; gap:1px`), so any short final row exposed it.
With `auto-fit` tracks, 8 and 12 cards leave voids at most widths — the 10-day
strip showed three cards' worth of solid grey. Fixed by moving the divider onto
the cells (`border-right`/`border-bottom`) and setting containers to `#fff`,
across all five affected grids. Verified: **0** divider-coloured grids remain on
either screen.

**3 · Copy contradicted the UI.** The note said management reads three scenarios
while a fourth (`Aggressive · 5×`) was selectable. The 5× case stays in
`Component.SCENARIOS` for reconciliation but is filtered out of the picker, and
the note now says so. Verified: three buttons offered, four retained in the engine.


---

# 16. DATA LAYER — real data, dynamically served  (8 Sep 2026)

The screens no longer read literals. `crux-data.js` holds the client's own data
as normalized tables behind an adapter, and every figure is fetched.

## 16.1 Source
| Workbook sheet | Table | Rows |
|---|---|---|
| Main Tracker | `geo_zone` | 50 (8 marked `is_aggregate`) |
| Main Tracker | `client` | 46 |
| Main Tracker | `business_record` | 470 |
| 10 Days Analysis | `tenday_snapshot` | 24 locations |
| 10 Days Analysis | `forecast_scenario` | 4 |
| Derived | `rate` | 141, all `origin:'DERIVED'` |
| Seeded | `holiday` | 10 fixed-date |

## 16.2 The adapter seam
```js
CruxDB.use({ async select(table, where){ return fetch('/api/' + table).then(r => r.json()); } });
```
Every method routes through `select(table, where)`. Replacing that one object
moves the whole application onto live data — no screen, no view model and no
calculation changes. The seed adapter is deliberately `async` so the screens
already handle "not loaded yet", which is what they must do when the data is
genuinely remote. Row counts are read from the payload via a getter, so `meta`
cannot drift from the data it describes.

## 16.3 Forecast multipliers — answered from the workbook, not assumed
The 10 Days Analysis sheet applies its multipliers to **10th-day revenue**, and
its own numbers verify the mapping (Assam: 244,200 × 5 = 1,221,000 = its 5×
column, and likewise 4×, 3.5×, 3.25×):

| Sheet label | Multiplier | Stance shown |
|---|---|---|
| Option A | 5 | Aggressive (retained, not offered) |
| Option B | 4 | Stretch |
| Option C | 3.5 | **Base** |
| Option D | 3.25 | Conservative |

This closes the open item from §14.6. The projection is on revenue, not counts.

## 16.4 Two data-quality defects found in the source
Both are **flagged and excluded from totals, never overwritten**:

1. **Roll-up rows counted as places.** Zone A, Zone B, West/East/North/South,
   ROI and Pan India are aggregates the tracker computes. They were being read
   as ordinary zones, so national MTD came out at 13,818,125 against a target of
   86,580 — a 15,960% achievement. They are now marked `is_aggregate` and
   excluded from record-level data; the application computes its own roll-ups.
2. **Revenue in the MTD column.** Five Gujarat Zone rows have `mtd === revenue_target`.
   The recorded value is preserved in `mtd_as_recorded`, `mtd` is set to 0, and
   `quality_flag:'MTD_LOOKS_LIKE_REVENUE'` is set. Needs a source correction.

After both: MTD **11,334**, revenue **₹46,81,620**, blended rate **₹413.06**,
achievement **8.9%** against a target of 1,27,786.

## 16.5 MIS dimensions now match the data
The workbook is zone × client. Location, product, manager and executive are not
in it, so they were removed as grouping options — an always-empty column is
worse than an absent one. Dimensions are **Group → Region → Zone → Client**.

## 16.6 Holiday blocker: CLOSED
`workingDays()` and `addWorkingHours()` read the holiday table. Verified:
- 14–18 Aug → 14, 17, 18 (Sat 15 and Sun 16 excluded)
- 1–5 Oct → 1, 5 only (**2 Oct, a Friday, excluded as Gandhi Jayanti** — the
  holiday clause firing for the first time in this system's history)
- 48 working hours from Thu 17 Sep 10:00 → **25 Sep 16:00 IST**

A timezone defect was found and fixed while verifying this: `toISOString()`
reports the previous day in IST, which shifted every date key by one and let a
Sunday through. All date keys are now built from local parts.

**Still required:** festival dates. Only fixed-date national holidays are
seeded; lunar dates move each year and were deliberately not invented. The gap
is reported in the app, and TAT figures should not be trusted until HR uploads
them.

## 16.7 Gaps surfaced in the application
| Gap | Count | Meaning |
|---|---|---|
| `zone_group` | 31 of 50 | no Zone A/B grouping on any Total row |
| `zone_region` | 38 of 50 | no East/West/North/South in the source |
| `holiday_festivals` | 1 | festival calendar absent |
| `rates_configured` | 0 of 141 | every rate is derived, none commercial |
| `aggregate_rows_excluded` | 8 of 50 | roll-ups held out of record data |
| `mtd_looks_like_revenue` | 5 of 470 | source mis-key, preserved and flagged |
| `zero_mtd_with_revenue` | 3 of 470 | revenue with no MTD; no division |


---

# 17. GO-LIVE READINESS — admin owns the basics  (8 Sep 2026)

The data layer answered what the workbook could say. **Data setup**
(Reports-adjacent, admin and MIS only) is where a person resolves what it could
not — through the same adapter the reports read from, so no correction has to be
made twice.

## 17.1 Write surface on the adapter
```js
CruxDB.insert(table, row, who, why)
CruxDB.update(table, id, patch, who, why)
CruxDB.remove(table, id, who, why)
CruxDB.canWrite()          // false against a read-only adapter
CruxDB.changeLog           // every correction, with before/after/actor/reason
CruxDB.readiness()         // computed go-live verdict
```
Reads and writes share one seam. `MemoryAdapter` implements all four; a real
adapter implements the same contract against the backend.

## 17.2 The change log IS the migration script
Every correction records table, row, before, after, actor and reason. Applied
after the first real load, the database starts in the state the owner signed
off — not the state the workbook was in. This is why corrections are recorded
rather than silently applied: a source fix later cannot be confused with a
decision made here.

## 17.3 Readiness — computed, not asserted
| Check | Blocking | State today |
|---|---|---|
| Festival holidays loaded | yes | fail until HR adds them |
| Every zone has a group | no | 31 of 42 real zones unmapped |
| Every zone has a region | no | 38 of 42 unmapped |
| At least one configured rate | yes | 0 configured, 141 derived |
| No unresolved source defects | no | 5 flagged rows |
| Connected to a real database | yes | adapter = memory |

Verdict shown in the app: **3 blocking items before this data can go live.**

## 17.4 What admin can now change
- **Holidays** — add or remove, national/festival/state-specific, confirmed or
  provisional. Every working-hour clock honours it from the next run.
- **Zone mapping** — set the group and region the workbook never stated, with a
  reason, recorded as a decision rather than as source data.
- **Rates** — enter the agreed commercial rate against any derived one. The
  derived figure is kept as a diagnostic, so revenue can finally be *checked*
  rather than restated.
- **Source defects** — correct a flagged row. `mtd_as_recorded` is preserved
  alongside the correction; nothing is overwritten.
- **Database connection** — shows the live adapter, the row counts it is
  serving, the exact `CruxDB.use({...})` snippet, and the change log to export.

## 17.5 Verified end to end
Inserting a festival holiday through the public API: table went 10 → 11, the
change log captured actor and reason, `workingDays()` honoured the date
immediately, and `readiness()` recomputed the festival check to pass and
blockers from 3 to 2 — without a reload and without touching application code.

## 17.6 Two defects found while building this
- **The nav renders from grouped key lists**, so a route present in a persona's
  `nav` array but absent from every group is unreachable — the new screen was
  invisible until `setup` was added to the Company group. Swept the rest: no
  other route is orphaned this way.
- **`meta.rowCounts` was a restated literal** and had already drifted from the
  payload (478 vs 470). It is now a getter over the data, so it cannot.


---

# 18. RATE HISTORY AND HOLIDAYS — from evidence  (8 Sep 2026)

## 18.1 The W.E.F. problem, and what the data actually says
The rate model was expected to change often, so a single `2026-09-01` start
date looked wrong. It was — but not for the expected reason.

The Main Tracker carries historical month blocks. Their columns are not evenly
spaced (the stride breaks after the second block), so the MTD column was
detected **per block by rate consistency** rather than assumed: for each
candidate column, the share of rows whose revenue ÷ MTD lands on a clean rate.
Twelve sequential months resolved at 94–100% consistency.

| Period | MTD col | Revenue col | Clean |
|---|---|---|---|
| 2026-08 | 18 | 20 | 98.8% |
| 2026-07 | 21 | 23 | 94.2% |
| 2026-06 | 25 | 26 | 99.0% |
| 2026-05 → 2025-09 | 28…52 | 29…53 | 96–100% |

**Finding: 152 of 153 client–zone pairs show exactly one rate across their
entire observed history.** 28 are unchanged across all 12 months. The one
exception, BOM · Mumbai, reads ₹1,000 in 2025-10 and ₹750 in the other eleven.

A value that reverts after a single month is a data error or a one-off
adjustment — not a repricing. Modelling it as a rate version would put a false
₹1,000 period into the history and change what August reports. It is therefore
recorded in a new `rate_anomaly` table and flagged.

## 18.2 What the rate table now holds
One row per client–zone, `effective_from` = the first month that rate is
observed, open-ended, carrying `months_observed` and `months_of_history` so a
reader can see the evidence behind the date. W.E.F. dates now spread across all
twelve months (64 from 2025-09, 25 from 2026-07, 19 from 2026-02, and so on) —
each one the month that pair first did business, which is a real effective date
rather than a placeholder.

**Consequence for the build:** versioning is supported and correct, but will be
used rarely. Effort belongs in entering the *agreed* commercial rates once, not
in rate-change workflows. What moves month to month is volume, not price.

## 18.3 Twelve months of history are now live
`business_record` holds 1,373 rows across 13 periods (2025-09 → 2026-09), so
month-on-month comparison reads real history instead of one fabricated prior
month. `CruxDB.periods()` returns what the data actually covers.

## 18.4 Holidays — the DoPT 2026 list
Twenty rows. Sixteen for 2026 from the DoPT Office Memorandum
(F.No.12/2/2023-JCA, 3 July 2025), verified against several published
reproductions of it, plus Maharashtra Day and the three national days for 2027.

Three are **marked unconfirmed** because they depend on moon sighting
(Id-ul-Fitr, Id-ul-Zuha, Muharram) and may shift by a day. Two of the seventeen
gazetted days are not seeded, because I could not verify them and would not
invent a date that silently changes a TAT.

Verified against the clock:
- Dussehra, Tue 20 Oct → working week returns 19, 21, 22, 23
- Diwali, Sun 8 Nov → correctly makes no difference, it is already a weekend
- Gandhi Jayanti, Fri 2 Oct → excluded

## 18.5 New in the data layer
```js
CruxDB.periods()     // every period the data covers, newest first
CruxDB.anomalies()   // values flagged rather than modelled
```
Plus a `rate_anomalies` readiness gap, and a holiday detail line that now
reports how many dates await moon-sighting confirmation.


---

# 19. SAMPLE DATA, COLLECTIONS, ASSIGNMENTS  (9 Sep 2026)

## 19.1 Sample data is tagged, counted and removable in one action
Where the workbook could not answer, placeholders fill the gap — but never
silently. Every one is tagged at the row (`is_sample`) or at the field
(`collection_is_sample`), with a note saying what replaces it.

```js
CruxDB.samples()       // census: table, rows, of, what replaces it
CruxDB.purgeSamples()  // removes tagged rows, nulls tagged fields, logs it
```
Removal is exact: whole rows where the row is a placeholder, single fields where
only that field is. A business row keeps its real MTD and revenue and loses only
its placeholder collections. **Data setup → Sample data** shows the census and
runs the purge; readiness carries it as a blocking check.

Current: 461 placeholder people, 470 placeholder assignments, 1,047 placeholder
collection figures.

## 19.2 A real defect found in the source: handlers encoded into zone names
The tracker writes the handler into the zone label — `Lucknow/ROUP - (Ajay
Pathak)`, `NAGPUR (Sudhir)`. That makes one place look like several zones, so
**its numbers split and every row understates**. Lucknow was three rows;
NAGPUR two.

This is the same modelling error the assignment comment describes: because
ownership had nowhere to live, it was pushed into the zone name.

Fixed by separating the two. Zone names are canonicalised and merged (42 → 39
real zones, 179 rows repointed, ids cleaned so a zone named NAGPUR is not
`ZN-NAGPUR_SUDHIR` in the database). Lucknow now reads as one zone with MTD
804 instead of 390 + 402 + 12 across three. **57 real handler names were
recovered this way** and replace placeholders.

## 19.3 Collections — the same pipeline as MTD
`collected` and `collection_target` sit on `business_record` beside `mtd` and
`revenue`, so one aggregation serves both: sums roll up, the percentage is
`collected ÷ billed` (never an average of percentages), and it appears as three
KPIs, two hierarchy columns and a sortable field. Figures are placeholder until
the collections upload lands; the KPI reads "not available" rather than zero
where they are absent.

## 19.4 Assignments — client and location together, effective-dated
**Data setup → Assignments**: one row per client × location with a handler, a
location head and a W.E.F. date. Several handlers on one location is normal and
expected; two on the same client *and* location is refused, because that is the
condition that leaves an escalation with two owners or none. A handover is a new
row dated ahead, never an edit, so a closed month cannot move.

Three ways in: assign one, **bulk upload** (validated with counts and row
numbers before anything is written; a file with any error applies zero rows), or
**suggest by location** — the assistant proposes a handler for each unassigned
pair from distance to base, current load and whether they already hold that
client elsewhere. It proposes; a person approves each row. Nothing is assigned by
the assistant alone, because an assignment decides whose numbers and whose
penalties these are.

## 19.5 MIS additions
- **Org layers as dimensions**: Location head and Branch manager join Group,
  Region, Zone and Client. Team leader and field executive appear once daily
  updates exist — a zone × client row cannot be split below the manager who owns
  it, so offering those levels now would produce empty rows.
- **Multi-period comparison**: any number of earlier periods can be ticked, each
  becoming a column with its own change against the current period. Replaces the
  single previous-month comparison.
- **Raw keys can no longer leak.** A stale default still requested a `loc`
  dimension, and `dimLabel` fell back to the raw key, so rows printed
  "AHMEDABAD loc". The fallback now reads "(unlabelled field: x)" — visibly
  wrong rather than quietly wrong — and the stale default is gone.

## 19.6 Sign-in panel
The marketing paragraph is replaced by a rotating quote and the genuine top five
zones by achievement, read live. The header only says "Great work" when somebody
actually beat plan; otherwise it says "Leading this month" and states that these
are part-month leaders, not finished results. `CruxDB.quote()` is a seam: a live
feed replaces it without the caller changing.
