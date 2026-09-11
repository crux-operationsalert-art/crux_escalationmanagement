# STEP 0 — INSPECTION AND GAP LIST
Ops-to-Ops Verification Assignment · against the existing Crux system
5 September 2026 · **STOP POINT — awaiting confirmation before Step 1**

Marks: **[V]** verified from the export or the prototype source · **[I]** inferred · **[NV]** not verifiable with the access I have.

---

## PART A — COMMENT STATUS (10 open comments on `Crux App v2.dc.html`)

| # | Comment | Status |
|---|---|---|
| 1 | KPI editing and target setting in **all** chairs, not just HR | **Actioned** [V] — `canSetTargets` covers branch, region, national, function, admin and partner levels; the Set-targets form is reachable from Performance in every one of those chairs. Executives correctly cannot set their own. |
| 2 | Escalation matrix — sent for the month marker, why not, and retrigger | **NOT ACTIONED** — no dispatch-status view exists. Nothing in the app shows the month marker, per-branch sent/not-sent, the reason for a failure, or a retrigger control. This is the one substantive gap. |
| 3 | Branch/zonal contact database — client and branch level fields, auto-updated by visits, feeding FMEA and RAG | **Actioned** [V] — client level carries zonal manager name, number, e-mail, where they sit and a branches-under reconciliation; branch level carries branch ID, BM name/number/e-mail and POC name/number/e-mail. The visit form writes back to the branch record, and FMEA plus RAG-with-reason render per client. |
| 4 | Field is an attachment, not a text box | **Actioned** [V] — file fields render as file inputs (`file()` helper) in the visit and claim forms. |
| 5 | Visit form vs the live Google Form — many requirements missing | **Partly actioned, NOT VERIFIABLE** [NV] — the form now carries purpose, per-purpose outcomes, person met, contacts, amount, commitment date, VOC, findings, photographs and documents. I cannot open either Google Forms link (both need your Workspace session). **Export the form to CSV or paste its question list and I will reconcile field by field.** |
| 6 | Collection option and journey missing from visit type | **Actioned** [V] — "Collection" is a visit purpose, with a Collection-outcome list, amount collected/committed, commitment date and an acknowledgement attachment; commitment dates feed the FMEA line on missed collection commitments. |
| 7 | Attributes fed by AI reading the note, not just a daily KPI box | **Actioned** [V] — the open-note box sits under the daily update; the assistant files each note as an Attribute with a heading or as FYI, both landing in the monthly review. Visible on the PMS Attributes list with its source. |
| 8 | Retitle to "Daily update" | **Actioned** [V]. |
| 9 | Full KPI target vs achieved with % for all | **Actioned** [V] — target / achieved / % columns on the daily update and the roll-up, for every chair. |
| 10 | +/− buttons to add categories and sub-categories with fields | **Actioned** [V] — the target builder adds and removes KPIs and sub-categories; mandatory KPIs refuse deletion with a reason. |

**Open: #2 (build it) and #5 (needs the form export from you).** Everything else is in the prototype.

---

## PART B — INSPECTION OF THE EXISTING SYSTEM

### B0. What "the existing system" actually is

Three distinct things, and the spec's instruction to "extend the existing database" resolves differently against each:

1. **Production today** [V] — a Google Apps Script application over a 26-tab Google Sheets datastore. ~90 RPC routes. This is the live system. It has no constraints, no transactions, no indexes, 198,890 empty rows, and its automation is currently disabled by an `AUTOMATION_PAUSED` kill switch set on 26 August after an e-mail storm.
2. **The agreed migration target** [V] — `build/schema.sql`, Postgres, ~60 tables, already carrying the constraints that make the four known defects impossible. Decision D5. Not yet deployed.
3. **The prototype** [V] — `Crux App v2.dc.html`, 13 chairs, 115 tabs, 38 forms, in-memory. The screen inventory below is taken from it.

**This matters for every DDL instruction in your spec.** See Conflict 1.

### B1. Existing screen inventory [V]
Twelve modules, scoped by chair: Dashboard · Escalations (4 raise types) · Performance/PMS · Clients (matrix or contacts view per department) · My team · HR · Visits & claims · Ideathon · Penalty ledger · Reports · Configuration (9 tabs) · My profile. 38 forms. Navigation is grouped and driven by `PERSONAS[chair].nav`.

**There is no assignment domain.** No assignment screen, route, queue, state, status chip, or form. No case, no applicant, no verification type, no point ID, no TAT clock, no dispute. **This is a new module, not a change to existing screens.** The existing screens it will reuse: the app shell and chair-scoped nav, people, clients, branches, penalty ledger, PMS roll-up, notifications.

### B2. Existing database — actual schema, 26 tabs [V]

| Tab | Real rows | Key columns |
|---|---|---|
| USERS | 55 | UserID, Email, Mobile, Designation, Role, Manager, Status, ScopeZones, ScopeLocations, Scope*, AccessToken |
| CLIENTS | 28 | ClientID, ClientName, ClientCode, ClientEmail, DefaultLocationHead, **EffectiveFrom/To** |
| BRANCHES | 1,413 of 101,330 | BranchID, ClientID, BranchName, BranchCode, Address, CruxPOC*, BranchManager*, `Dublicate` |
| BRANCH_ASSIGNMENTS | 1,729 of 100,702 | AssignmentID, PersonEmail, AssignmentRole, RegionID, BranchID, ClientID, **EffectiveFrom/To** |
| CRUX_REGIONS | 34 | RegionID, RegionName, Active |
| ESCALATION_MATRIX | 3,783 | MatrixID, ClientID, Level, LevelName, ContactName, Mobile, Email, BranchID, Location |
| ESCALATIONS | 3 | 27 columns incl. Category, Severity, EscalatedAgainst, Assigned* |
| ESCALATION_HISTORY | 378 | field-level old/new value |
| DISPATCH_QUEUE | 12,080 | MonthKey, Granularity, ClientID, BranchID, Recipient, Status, Attempt, PlannedAt, SentAt, Error, **IdempotencyKey** |
| EMAIL_LOG | 2,229 | ToAddr, Trigger, Status, Attempt, Error, MessageRef, **IdempotencyKey** |
| EMAIL_TEMPLATES | 5 | Key, Subject, Body |
| REMINDER_LOG | 1,707 | JobKey, Type, Month, ExecutedAt, Result |
| AUDIT_LOG | 5,913 of 103,275 | 8 columns; 1,740 are EMAIL_RETRY machine noise |
| TARGETS | 102 | PersonEmail, MonthKey, TargetValue, AchievedValue, Category, SubCategory, ClientID |
| KPI_DEFS | 19 | KpiID, PersonEmail, Category, Position |
| SCORES / SCORE_LEDGER | 2 / 0 | monthly PMS score and its delta ledger |
| ATTRIBUTE_POINTS | 6 | PersonEmail, MonthKey, Attribute, SelfRating, ManagerRating |
| PEOPLE_EVENTS | 26 | + **"Copy of PEOPLE_EVENTS" 451 rows, 449 NOTEs existing nowhere else** |
| WARNINGS | **0** | WarningID, EscalationID, PersonEmail, **StrikeLevel**, Summary, FactsJson, AcknowledgedAt |
| HOLIDAYS | **0** | HolidayID, Date, Name, Status |
| SESSIONS | 7 | SessionID, PersonEmail, ExpiresAt, Fingerprint, RevokedAt |
| CLIENT_ACTIVATION | 635 | ClientID, Location, Active |
| SETTINGS | 64 | Key/Value — **including transaction rows (`WINOVR:…`)** |
| Sheet4 | 12 | production debug scratchpad |

**No primary keys, no foreign keys, no indexes, no unique constraints, no check constraints, no relationships enforced anywhere.** Every relationship in the list above is by string match, mostly on e-mail address.

### B3. People already in the database [V]
- **55 rows in USERS**, all of them application users — there is no separate person/people master. 39 of the 55 hold standing `AccessToken`s.
- Identity keys: **e-mail string only.** No employee code column. Mobile exists but is not unique and not used as a key.
- **Duplicates are not detected at all.** `aniket.chalke@crux**inida**.co.in` (typo domain) holds 583 BRANCH_ASSIGNMENTS coverage rows and **exists in no USERS row** — a person who has coverage but no identity.
- BRANCHES carries a manual `Dublicate` column (634 marked ×1, 390 marked ×2), which is the closest thing to duplicate handling in the system.
- 449 NOTE rows about people survive only in a copied tab.

**Consequence for your IDENTITY RULE:** it cannot be honoured against the current data. There is no stable identity to match on and no way to tell whether a "new" person already exists. De-duplication of the people master must complete before any assignment goes live — which your migration section already requires.

### B4. Existing masters [V]

| Master | Key | Effective dates | Fit for reuse |
|---|---|---|---|
| CLIENTS | ClientID (28 real) | **Yes** | Reusable as-is |
| BRANCHES | BranchID (1,413) | No | Reusable; **217 have no BranchCode** |
| CRUX_REGIONS | RegionID (34) | No | **Not reusable as-is** — 36 Zone values mix states, cities and compass points, "Goa" and "GOA" both present |
| CLIENT_ACTIVATION | ClientID+Location (635) | Active flag only | Reusable as the client×location fact |
| Locations | **none** | — | No location master exists. Location is a free-text string on USERS.ScopeLocations, BRANCHES.Address and ESCALATION_MATRIX.Location |
| Verification types | **none** | — | Does not exist in any form |
| Org units | **none** | — | Does not exist |
| Roles | USERS.Role, free text | No | Exists as a string, not a table |

### B5. Role and hierarchy structure [V]
- Hierarchy is an **adjacency list by e-mail string**: `USERS.Manager` holds a manager's e-mail. No closure table, no levels column, no path. Depth-walking is done in script.
- Visibility is enforced **twice and inconsistently**: `USERS.ScopeZones` / `ScopeLocations` / `Scope*` columns, **and** BRANCH_ASSIGNMENTS rows. **No precedence rule exists between them.** 1,729 assignment rows against 55 users is a near cross-product.
- Role gates live in `Code.gs` as string comparisons on `USERS.Role`.
- The prototype and `build/schema.sql` replace all of this with `chair` + `chair_holder` + `coverage_rule` (decision D7: the chair routes, not the person) and refuse overlapping coverage at write time (D6).

### B6. Existing escalation matrix and engine [V]
- `ESCALATION_MATRIX`, 3,783 rows, is **a directory of the client's own contacts** (SPOC → Head Office, 5 levels, per client and per branch). It is **not** an internal routing matrix. 693 of 1,413 branches are complete at all five levels.
- The "engine" is `Escalation.gs` + `MONTHLY_DISPATCH` + `STRIKE_SWEEP`: it e-mails those client contacts a monthly matrix and chases incomplete ones. **`MONTHLY_DISPATCH` has succeeded exactly once, ever.** `STRIKE_SWEEP` ran 1,690 of 1,707 job runs, 1,535 of them NOOP, held the script lock, and is now disabled by kill switch.
- **Idempotency:** `DISPATCH_QUEUE.IdempotencyKey` and `EMAIL_LOG.IdempotencyKey` columns exist, but a sheet cannot carry a unique constraint. **77 keys produced 1,892 sends.** Idempotency was a convention, not a rule.
- There is **no internal Ops-to-Ops escalation routing** of any kind — no level ladder over Crux staff, no delegation table, no substitution.
- Service interface: `Escalation.gs` is [NV] (see access limitation).

### B7. Existing 3-strike logic [V]
- Strikes exist **only as e-mail sends**. `EMAIL_LOG.Trigger = 'STRIKE_1'` — 1,892 of them, 1,889 to one person, for one open case, over nine days.
- `WARNINGS.StrikeLevel` is the only structural home for a strike, and **the table is empty**.
- **Strikes are neither events nor counters. There is no store, no rolling window, no uniqueness, no waiver, no attribution.** The clock is hardcoded in script: 24 working hours, 10:00–17:00, weekends and holidays excluded — and `HOLIDAYS` is empty, so the exclusion never fires.

### B8. Existing notification logic [V]
- One channel: **Gmail**, via Apps Script. 5 templates in `EMAIL_TEMPLATES`. Delivery status in `EMAIL_LOG.Status` with `Attempt` and `Error`.
- **1,925 of 2,229 sends FAILED; 1,849 of those hit the Gmail daily quota.**
- Retry is a job loop (`REMINDER_LOG`), not a ladder, and every retry writes an AUDIT_LOG row.
- No outbox, no dedupe key enforcement, no per-day budget, no bounce handling, no in-app channel.
- 7 SETTINGS keys duplicate one recipient list.

### B9. Existing audit capability [V]
- `AUDIT_LOG`, 8 columns, 5,913 real rows. **1,740 of them are EMAIL_RETRY** — machine noise, not user action.
- `ESCALATION_HISTORY` (378 rows) is the only true before/after field-level log, and it covers escalations only.
- **Nothing is immutable** — it is a spreadsheet; any editor can rewrite any row. No hash chain, no session, no IP, no change reason, no retention policy.
- No column-level audit for people, targets, matrix, clients or branches.

### B10. Existing Force1 case structure [V]
**Force1 appears nowhere.** No Case ID, no Point ID, no case table, no integration, no credentials, no field mapping in any of the 26 tabs or in the prototype. [NV] on whether an API exists — I have never been shown one.

---

## PART C — GAP LIST

### C1. Exists and reusable as-is
| Thing | Where | Note |
|---|---|---|
| Client master | CLIENTS, 28 rows, has effective dates | Foreign-key target for `case.client_id` |
| Branch master | BRANCHES, 1,413 real rows | Foreign-key target; 217 need a code |
| Client × location activation | CLIENT_ACTIVATION, 635 rows | Constrains valid assignee locations |
| Client contact matrix | ESCALATION_MATRIX, 3,783 rows | Reusable as the **client-facing** contact ladder |
| Chair / chair_holder / process / RACI | `build/schema.sql` + prototype, 70 chairs, 188 processes | The routing key for every role in your spec |
| Penalty rule + instance engine | `build/schema.sql`, 7 rules, ledger | Reusable for assignment-related penalties |
| Outbox + delivery + mail_budget | `build/schema.sql`, unique idempotency key | Already the transactional outbox your spec asks for |
| PMS: kpi_definition, kpi_target, daily_count, task, daily_note, pms_weighting | `build/schema.sql` + prototype | Where your quality-KPI outcomes land |
| audit_entry, job_run, job_config, migration_merge, migration_review | `build/schema.sql` | Foundations to extend |

### C2. Exists but needs extension
| Thing | Current state | Extension needed |
|---|---|---|
| Person identity | USERS, 55 rows, e-mail-string key, one orphan with 583 coverage rows | `person` + `employee_no` unique + de-dup + `superseded_by`; **complete before go-live** |
| Hierarchy | `USERS.Manager` adjacency by e-mail | `org_unit` + **`org_unit_closure`** (ancestor, descendant, depth) — required by your "My Team" queue and by arbitration's lowest-common-manager |
| Coverage / visibility | Two competing sources, no precedence | `coverage_rule`, overlaps refused at write time (D6); one precedence rule |
| Geography | CRUX_REGIONS, 34 mixed values | `geo_node` Zone→State→City→Branch; **ROMG and Indore-MPCG splits still undecided in detail** |
| Escalation matrix | Client contacts only | Add the **internal** matrix: `client_id, location_id, branch_id, escalation_level, role_id/user_id, sequence_no, effective_from/to` |
| Escalation instance | E-mail sends with an unenforced key | `escalation_instance` with `idempotency_key UNIQUE`, `fallback_used`, substitution audit |
| Audit | Mutable sheet, machine noise | `audit_log` append-only, hash-chained, before/after, session, IP, change reason; revoke UPDATE/DELETE |
| Notifications | Gmail only, 86% failure | Add `notification_outbox` dedupe enforcement, retry ladder, in-app channel, sub-SLA suspension on delivery failure |
| Business calendar | Hardcoded 10–17, HOLIDAYS empty | `business_calendar` + `calendar_holiday` per location, `add_business_minutes()`, `business_minutes_between()` — **the holiday table must be populated before any TAT is enforced** |
| Reason codes | 22 escalation categories in settings | `reason_taxonomy` with context, requires_remarks, implied_attribution |
| Attachments | Drive links in free text | `attachment` with content_hash, virus_scan_status, immutable |
| Case (naming) | `build/schema.sql` already has `case` = escalation case, `ref` UNIQUE | **Name collision** — see Conflict 7 |

### C3. Must be built new — the whole assignment domain
Nothing below exists in any form, in either the live system or the prototype.

**Tables (24):** `verification_case` · `case_party` · `verification_type` · `case_verification_requirement` · `assignment` · `assignment_task` · `assignment_completion` · `assignment_request` · `sla_rule` · `sla_instance` · `sla_clock_segment` · `assignment_event` · `strike_event` · `escalation_matrix` (internal) · `escalation_instance` · `temp_participant_grant` · `duplicate_override` · `reason_taxonomy` · `org_unit_closure` · `business_calendar` · `calendar_holiday` · `user_delegation` · `attachment` · `assignment_summary` (5-minute materialised control-tower table).

**Services (7):** transition service (sole writer of `current_state`) · TAT resolution with specificity scoring and trace · clock-segment ledger with attribution · request resolution (RFI/delay/dispute/hold, one table) · escalation adapter with idempotency and hierarchy fallback · strike generator under advisory lock · priority-score recompute tick.

**Screens (8):** S1 create/edit with progressive disclosure and 30-second autosave · S2 four-tab queue including **Action Required** · S3 detail with Timeline and SLA-ledger tabs · S4 ten action modals · S5 Control Tower · S6 Admin config · S7 temp-participant single-action screen · S8 Confirm Attribution tray.

**Plus:** the Force1 integration, which has no verified contract.

---

## PART D — CONFLICTS REQUIRING YOUR DECISION

**1. "Extend the existing database" — the existing database cannot hold this design.**
Your spec requires partial unique indexes, append-only grants, month-range partitioning, advisory locks, materialised columns and JSONB. Google Sheets has none of these; the four production defects exist *because* it has none of these. **Recommendation:** the object of extension is `build/schema.sql` on Postgres — already decision D5 — and your DDL becomes part of that schema rather than ALTERs against tabs. The live sheet is a **migration source**, not an extension target. Everything else in your spec then holds unchanged.

**2. "Reuse the existing escalation engine, do not build parallel routing."**
What exists is a monthly client-matrix dispatcher that has succeeded once, ever, and is presently switched off after sending 1,892 duplicate e-mails from 77 idempotency keys. It routes to *client* contacts; your design routes to *Crux managers*. **Recommendation:** honour the intent — one adapter, one idempotency key, no routing logic inside the assignment workflow — but the engine behind the adapter is the new escalation service on the new stack. Calling the Apps Script would inherit the storm. The matrix *data* is reused.

**3. "Route through the existing 3-strike engine."**
There is no engine and no strike store. Strikes exist only as e-mail sends; the one table with a `StrikeLevel` column is empty. **Recommendation:** `strike_event` becomes the system of record with `UNIQUE (assignment_id, breach_cycle_no, trigger_code)`; the 1,892 STRIKE_1 sends migrate as a small number of de-duplicated `MIGRATED` rows so the rolling window is right on day one.

**4. The IDENTITY RULE cannot be satisfied against current data.**
E-mail-string identity, no employee code, an undetected typo-domain twin holding 583 coverage rows, and no person-vs-user separation. **Recommendation:** blocking prerequisite — de-duplicate the people master and issue employee codes before the first real assignment. Your migration section already says this; I am confirming it is a hard gate, not a nice-to-have.

**5. This is a new module, not a modification of existing screens.**
No existing screen changes behaviour except: nav gains an Assignments group; Control Tower is new; the penalty ledger and PMS gain assignment-sourced rows; notifications gain new templates. Say so now so "preserve existing functionality" is unambiguous.

**6. Force1 is entirely unverified.** [NV]
No API, no credentials, no field list, no sample payload, no statement of whether Point IDs are issued by Force1 or keyed by hand. **Recommendation:** design `force1_case_id` and `force1_point_id` as externally-supplied strings with `UNIQUE` and manual entry as the day-one path; treat the API as a later phase. Tell me if a contract exists and I will design to it instead.

**7. `case` name collision.**
`build/schema.sql` already defines `case` as the escalation case. Your spec's `case` is the Force1 verification case. **Recommendation:** `verification_case` for the new entity, leaving the escalation domain untouched.

**8. The 2-million-assignment performance test is two orders of magnitude past reality.**
Real scale: 55 users, 1,413 branches, 28 clients. Even at 200 assignments per user per month that is ~130k a year. **Recommendation:** build every index, partition and keyset page as specified — they cost nothing — but seed the performance test at 500k assignments and 5M events. I will run 2M/25M as a headroom check if you want the number.

**9. Six roles vs thirteen chairs.**
Your spec names Executive, Team Leader, Branch Manager, Zonal Manager, Operations Head, Admin. The settled model routes by chair, not by role or person (D7), and the prototype has 13. **Recommendation:** the six become *capability levels* mapped onto chairs; permission resolution stays Role × Scope × State × Ownership with the chair supplying role and scope. No hard-coded e-mail visibility anywhere — which the current system does do.

**10. AUDIT_CONFIG separated from MASTER_CONFIG, held by different people.**
Today there is effectively one administrator and 39 of 55 users hold standing access tokens. **Recommendation:** implement the separation in the permission model now and tell me who holds AUDIT_CONFIG — it cannot be the same person who holds MASTER_CONFIG, and it cannot be you if you also approve SLA overrides.

---

## PART E — WHAT I COULD NOT VERIFY
| Item | Why |
|---|---|
| `Sheets.gs`, `Auth.gs`, `Clients.gs`, `Escalation.gs`, `Email.gs`, `Scheduler.gs`, `Import.gs`, `Utils.gs`, `Gemini.gs`, all HTML files | The uploaded `.docx` arrived 0 bytes. `Code.gs` and the manifest were verified (~90 RPC routes, role gates, auth model, job names); the rest were not. Nothing in this gap list depends on them, but the migration scripts and the exact escalation service interface will. |
| Force1 API, Case ID and Point ID contract | Never provided |
| Live Google Form behind the visit form (comment #5) | Both links need your Workspace session |
| Whether any location or verification-type master exists outside the datastore | Only the 26 tabs were exported |
| Current row-level access enforcement in the deployed script | Inferred from `Code.gs` role gates only |

---

## NEXT — on your confirmation
Step 1 onward, in your stated order: screen architecture · user flows per role including error paths · DDL and ALTERs with per-index reasoning · the Role × Scope × State × Ownership matrix mapped to endpoints · TAT, ledger, attribution, priority, escalation, strikes and job schedules · validations at four levels · the event catalogue with payload shapes and the grant changes that enforce immutability · test scenarios including all 18 from your design document · the phased sequence with what ships at each phase · the final gap and risk list.

Confirm this gap list, resolve the ten conflicts (or tell me to proceed on my recommendations), and say whether comment #2's dispatch-status-and-retrigger screen should be built now or folded into the assignment phase.
