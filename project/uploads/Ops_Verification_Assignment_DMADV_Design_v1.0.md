# Operations-to-Operations Verification Assignment
## Second-Level DMADV Design — Production-Grade Operating Process & System Architecture

Version 1.0 · Design baseline for build

---

# 0. STATEMENT OF WORK (LIVING DOCUMENT)

**Objective.** Convert the proposed Ops-to-Ops verification assignment process into a production-grade, implementable process and system design that is auditable, RACI-driven, hierarchy-aware, loophole-resistant and scalable, and that integrates into the existing Operations application, database, escalation matrix and 3-strike engine rather than running parallel to them.

**Scope.** Assignment lifecycle from case intake at the originating location to closure after report review. Includes SLA/TAT engine, delay/RFI/dispute handling, escalation and strike integration, RBAC/visibility, data model, audit, temporary participant access, dashboards, performance, security, FMEA, test and migration approach, and a self-contained Claude Design implementation prompt.

**Out of scope.** The field verification methodology itself, vendor/agency payout, Force1 internal case creation, HR disciplinary process beyond strike generation, and any non-Operations department workflow.

**Inputs.** The requirement brief (31 sections). Assumed existing assets: user/people master, organisation hierarchy, client master, branch master, location master, Force1 case reference, escalation matrix engine, 3-strike engine, notification service, audit facility.

**Assumptions (to be confirmed before build).**
1. A reusable escalation engine and 3-strike engine already exist and expose a callable interface or table contract.
2. Organisation hierarchy is stored as parent/child org units with user-to-org-unit membership.
3. Force1 Case ID and Point ID are externally generated and are stable identifiers.
4. The database is relational (Postgres/SQL Server assumed; syntax shown is Postgres-flavoured).
5. Operations runs a defined business calendar per location, including holidays.
6. Attachments are stored in object storage with a metadata row in the database.

**Deliverables.** This document, covering the 29 required outputs plus 18 verification scenarios and the Claude Design prompt.

**Methodology.** DMADV applied internally. Define → CTQ and scope. Measure → CTQ metrics, volume assumptions, VOC/VOE. Analyse → failure modes, loopholes, FMEA, bottlenecks. Design → process, state machine, rules engine, data model, RBAC, resilience. Verify → 18 end-to-end scenario walkthroughs plus acceptance criteria.

**Key decisions and rationale (Decision Log).**

| # | Decision | Rationale | Impact |
|---|---|---|---|
| D1 | Assignment is a bundle of **verification tasks**, keyed to Point IDs, not a copy of the case | Enables split-location assignment later without duplicating the case | Data model |
| D2 | `SLA_BREACHED` and `ESCALATED` removed from the primary state machine; modelled as orthogonal flags | A breach does not tell you what the operator must do next; conflating them destroys workflow state | State machine |
| D3 | RFI, Delay and Dispute consolidated into one `assignment_request` entity with a type discriminator | Identical lifecycle (raise → review → resolve, with own sub-TAT); avoids three near-identical tables, UIs and code paths | Data model, UI |
| D4 | SLA modelled as an append-only **clock-segment ledger** with attribution per segment | Only way to defend strike decisions and prove who owned the delay | SLA engine, strikes |
| D5 | Delay auto-accept produces a distinct `AUTO_ACCEPTED` outcome with `PENDING_ATTRIBUTION`, not a silent approval | Prevents end-of-day gaming and keeps assignor accountable | Delay engine |
| D6 | Strikes derive from **attributable** breach time above a grace threshold, deduplicated by `(assignment, breach_cycle)` | Prevents punishing users for assignor/customer/system delay and prevents duplicate strikes from retries | Strike engine |
| D7 | Queue ordering uses a materialised `priority_score` refreshed by tick job and on-event | Avoids recalculating TAT from history on every dashboard refresh | Performance |
| D8 | Temporary participants get a case-scoped, function-scoped, time-bound grant, never a role | Closes the "temp user sees the dashboard" loophole | Security |
| D9 | Report submission requires evidence (attachment or channel reference) for all non-system channels | WhatsApp/Email delivery is otherwise unprovable in a dispute | Process |
| D10 | TAT rules resolved by deterministic specificity score, snapshotted onto the SLA instance at assignment | Rule changes must never retroactively alter a live SLA | SLA engine |

**Open questions / dependencies.** Listed in full in Section 26 (Implementation Dependencies). Nothing in this design is blocked on them, but eight items require confirmation before schema freeze.

**Risks and known limitations.** Captured in Section 24 (FMEA) with residual risk after proposed controls.

**Validation / acceptance criteria.** Section 29.

**Status.** Design complete and self-audited against all 31 sections of the brief. Next action: confirm the eight dependency items, then run the Claude Design prompt in Section 33.

---

# 1. WHAT I AM CHANGING IN YOUR REQUIREMENTS, AND WHY

You asked to be challenged. These are the material changes. Business intent is preserved in every case.

### C1. `SLA BREACHED` and `ESCALATED` must not be workflow states
**Wrong because:** if a case in `AWAITING_INFORMATION` breaches and you move it to `SLA_BREACHED`, you have just erased the fact that the operator is waiting on the assignor. The queue then tells the user nothing actionable, and on resolution you have no defensible state to return to.
**Instead:** keep one lifecycle state, and carry `sla_status` (ON_TRACK / AT_RISK / BREACHED) and `escalation_level` (0–N) as independent attributes. Both are visible, filterable and colour-coded, and neither destroys workflow position.
**Operational impact:** a breached case still shows the operator the correct next action. **System impact:** simpler transition table, fewer illegal-transition defects, far simpler reporting.

### C2. Dispute as written is an unbounded loop and a blame weapon
**Wrong because:** unlimited disputes let an assignor keep a case in permanent rework, reset attention, and push a subordinate location toward strikes. A flat 2-hour corrective TAT on a wall clock also lands at 11pm.
**Instead:** (a) dispute reason drawn from a controlled taxonomy, free text only under "Other"; (b) maximum 2 disputes per assignment, the 3rd attempt routes to **Arbitration** by the next level above both parties; (c) corrective TAT of 2 hours is measured on the assignee location's business calendar; (d) every dispute is classified on resolution as *Upheld* or *Not Upheld*, and Not Upheld disputes are counted against the **assignor's** quality KPI.
**Operational impact:** disputes stay genuine and become measurable. **System impact:** one extra outcome field and one arbitration route.

### C3. Silent auto-accept of a delay is the single biggest gaming vector
**Wrong because:** an assignee who reports a delay at 17:55 knows nobody will review it, and the SLA extends itself. Nothing distinguishes "manager agreed" from "manager was asleep".
**Instead:** after 1 hour of no review the request resolves as `AUTO_ACCEPTED`, which grants a **provisional** extension but records `attribution = PENDING_REVIEW`. The clock segment is excluded from strike computation until a supervisor confirms attribution (bulk-confirmable next business morning). Auto-accepts are counted on the **assignor's** responsiveness KPI. Extension is capped at the lesser of the stated expected completion, 50% of the original TAT, or 12 business hours. Maximum one auto-accept per assignment; a second delay request needs a positive decision, and after 1 hour without one it escalates to the assignor's manager instead of self-approving.
**Operational impact:** delay reporting stays available but stops being free. **System impact:** one extra resolution enum and a cap calculation.

### C4. RFI must not stop the clock unconditionally
**Wrong because:** "RFI TAT = 2 hours, don't reset the SLA" is under-specified. If any RFI pauses the clock, an assignee raises a trivial RFI at hour 23 and buys time. If no RFI pauses the clock, the assignee is punished for the assignor's incomplete data.
**Instead:** a **conditional, capped, validated pause**. The clock pauses only when: the RFI is raised within the first 50% of elapsed TAT (a "good faith window"); and the assignor does not reject it as invalid. Pause credit equals actual assignor response time capped at 2 business hours. An RFI raised after the 50% window is recorded, routed and answered, but grants **zero** pause. An RFI rejected as "information was already provided" grants zero pause and is logged against the assignee's quality KPI. Maximum 2 pause-eligible RFIs per assignment.
**Operational impact:** the genuine data-quality problem gets fixed at source, the stalling tactic dies. **System impact:** RFI eligibility check at raise time plus a pause segment in the SLA ledger.

### C5. "Anyone from Executive to Ops Head may assign" is a scope loophole
**Wrong because:** unbounded assignment rights allow assigning to one's own location (defeating independence of verification), assigning to oneself, and cross-zone assignment that no manager sees.
**Instead:** assignment rights are role-granted but scope-bounded. Hard rules: an assignor may not assign to themselves; an assignment to the assignor's **own location** is blocked by default and requires a documented exception reason plus Branch Manager approval; assignment targets a **location queue**, not a named individual, unless the assignor's role carries `ASSIGN_TO_INDIVIDUAL`. The receiving location's Team Leader performs intake allocation.
**Operational impact:** verification independence is preserved and receiving locations control their own load. **System impact:** two validation rules and a location-queue intake step.

### C6. "Default TAT = 24 hours" needs a clock type or it is meaningless
**Wrong because:** 24 calendar hours from Friday 18:00 is Saturday 18:00, when nobody is working. Enforcing that generates fake breaches, fake strikes and a credibility collapse in the first week.
**Instead:** every TAT rule carries `clock_type` of `BUSINESS` or `CALENDAR`. Default is **24 business hours** against the **assignee location's** calendar. Client contracts that genuinely require calendar hours are configured explicitly per rule. Calendars, shifts and holidays are Admin-maintained masters.
**Operational impact:** breaches become real and defensible. **System impact:** a business-calendar function plus a per-location holiday master.

### C7. Not every breach should produce a strike
**Wrong because:** "every applicable SLA breach must feed the 3-strike system" punishes people for assignor delay, customer delay and system outages, and a single retry storm can produce three strikes in ten seconds.
**Instead:** a strike is generated only when **attributable assignee time** exceeds the TAT plus a configurable grace (default 15 minutes), and only once per `(assignment_id, breach_cycle_no)`, enforced by a unique key. Reopened/rework cycles increment `breach_cycle_no` so a rework breach is a genuinely separate event rather than a duplicate. Strikes carry a waiver path with an approving authority.
**Operational impact:** strikes become credible, so they change behaviour. **System impact:** strike generation reads the attribution ledger, not the raw due date.

### C8. Sorting by raw TAT is not the only weakness; the queue needs one number
**Instead of** sorting on a TAT column, every assignment carries a materialised integer `priority_score` and a derived `priority_bucket`. The score composes breach state, rework/P1 status, consumed percentage, unactioned age, escalation level, client criticality and strike exposure. Full formula in Section 5.4.

### C9. "Report Shared Via: WhatsApp" without evidence is undefendable
**Instead:** submission requires either a system-held report attachment or a channel reference. Force1 captures the system reference automatically. Email requires the recipient address and either a message reference or a screenshot. WhatsApp requires a screenshot and the recipient number. "Other" requires remarks plus an attachment. **Recommendation for target state:** the report should be uploaded into the application as the system of record, with WhatsApp/Email demoted to notification channels rather than delivery mechanisms. This is the single highest-value change for dispute defence and for future automation.

### C10. Escalation only on breach is purely reactive
**Instead:** add non-punitive pre-breach nudges at 50%, 75% and 90% of consumed TAT (notification only, no escalation level, no strike) and reserve the escalation matrix for the actual breach and subsequent levels. Roughly 60–70% of would-be breaches are recoverable at the 75% mark.

### C11. Do not build a parallel escalation or notification stack
Confirmed and adopted. The design calls the existing engines through a thin adapter with an idempotency key, so the workflow never owns escalation routing logic.

---

# 2. EXECUTIVE PROCESS ARCHITECTURE

Five layers. Complexity lives in layers 3 and 4; the user only ever touches layer 1.

**Layer 1 — Experience.** Four queues (My Assignments Out, My Team's Assignments, Work Assigned To Me, Action Required), one assignment creation form with progressive disclosure, one case detail screen with a context-aware action bar, one control tower. Every screen shows at most the actions that are legal in the current state for the current role.

**Layer 2 — Workflow.** A single state machine over `assignment`, driven by a guarded transition table. No code path may write `current_state` except the transition service.

**Layer 3 — Rules engine.** TAT resolution, SLA clock and attribution, priority scoring, duplicate detection, escalation level determination, strike eligibility. All configuration-driven and Admin-maintainable without a developer.

**Layer 4 — Integration.** Adapters to the existing escalation engine, 3-strike engine, notification service, Force1 case reference, user/org master. Each adapter is idempotent and each call is recorded.

**Layer 5 — Evidence.** Append-only event store, immutable audit log, SLA clock-segment ledger, attachment vault. Nothing in this layer supports UPDATE or DELETE for business users.

**Principle:** the operator sees a queue, a coloured chip and two or three buttons. Everything else is derived.

---

# 3. END-TO-END PROCESS FLOW

```
CASE RECEIVED at Originating Location
        │
        ▼
[Assignor] Creates Assignment ─── duplicate check ──► blocked / warn+override / clean
        │                                                       │
        │  validation: ≥1 verification, Point ID per            │ override reason
        │  verification, applicant complete, target ≠ self      │ + audit
        ▼
   TAT ENGINE resolves rule → snapshot → SLA instance created
        │                    (rule id, value, clock type, calendar, start, due)
        ▼
  ASSIGNED (location queue)  ── pre-breach nudges at 50/75/90% ──►
        │
        ├─► [Assignee TL] Allocates to executive
        ▼
  ACCEPTED ──► IN_PROGRESS
        │
        ├──► Request More Details ──► AWAITING_INFORMATION ──► (Assignor responds ≤2h) ──► IN_PROGRESS
        │                                      └─ pause credited only if eligible
        │
        ├──► Report Delay ──► DELAY_REVIEW ──► Accept / Deny / Auto-Accept(1h) ──► IN_PROGRESS
        │                                       └─ extension capped, attribution recorded
        ▼
  COMPLETED (report + evidence submitted)  ──► SLA clock stops
        │
        ▼
  UNDER_REVIEW  (Assignor review TAT: 4 business hours, own sub-SLA)
        │
        ├── Accept ──────────────────► CLOSED
        ├── Dispute ──► REWORK (P1, 2 business-hour corrective TAT) ──► COMPLETED ──► UNDER_REVIEW
        │                └─ 3rd dispute attempt ──► ARBITRATION
        └── No action in 4h ──► auto-nudge, then escalation to assignor's manager
                                (never auto-close; see Section 22)

ORTHOGONAL, RUNNING THROUGHOUT:
  sla_status: ON_TRACK → AT_RISK → BREACHED  (breach → escalation engine → strike eligibility)
  escalation_level: 0 → 1 → 2 → 3            (matrix resolved by client + location + level)
```

---

# 4. DETAILED WORKFLOW

### 4.1 Assignment creation (Assignor)
1. Enter or look up Force1 Case ID. If the case exists in the local `case` table, all case, applicant, co-applicant and guarantor data is loaded read-only. **Nothing is re-keyed.**
2. If the case is new, capture Case block (Force1 Case ID, Client, Branch, Vendor Branch Name optional), Applicant block, Co-applicant block (0..n, "Same as Applicant" copy helper), Guarantor block (0..1, expandable to 0..n by the same child model).
3. Select verifications (multi-select from active verification types). For each selected type, a Point ID row appears and is mandatory. The form cannot be submitted with a selected verification lacking a Point ID, or a Point ID entered against an unselected verification.
4. Select target location. System blocks self-assignment and own-location assignment (override path per C5).
5. Duplicate engine runs. Hard block, soft warning or clean (Section 15).
6. On submit: assignment created, one `assignment_task` per Point ID, TAT resolved and snapshotted, SLA instance opened, first clock segment opened with `attribution = ASSIGNEE`, event `ASSIGNMENT_CREATED` written, notification queued to the target location queue.

**Mandatory fields at creation are deliberately minimal:** Force1 Case ID, Client, Branch, ≥1 verification with Point ID, applicant name, contact, address, pincode, target location. Landmark, Maps link, vendor branch and address-verified indicator are optional but scored into a **Data Completeness Score** shown to the assignor, because incomplete data is the root cause of most RFIs. Locations with a low average completeness score surface on the control tower.

### 4.2 Intake (Assignee side)
The assignment lands in the location queue. The Team Leader allocates it to an executive, or an executive self-picks if the location is configured for pull-based allocation. Allocation is an event, not a state change. Acceptance is required within an `acceptance_sla` (default 30 minutes of business time) after which the case rises to the `UNACTIONED` priority bucket and the TL is notified.

### 4.3 Execution
The assignee performs verification offline and returns to the system for exactly one of three actions: Complete, Request More Details, Report Delay. Nothing else is available.

### 4.4 Completion
Requires Report Shared Date, Report Shared Time, Report Shared Via (multi-select), evidence per C9, and remarks if "Other" is selected. Report Shared Date/Time cannot be in the future and cannot precede the assignment creation time. If the stated share time is materially earlier than the system submission time (configurable, default 2 hours), the discrepancy is flagged for review rather than blocked, because back-dating is the classic SLA-evasion move.

### 4.5 Review and closure
Assignor accepts, disputes, or escalates. Acceptance closes the assignment and stops all clocks. The assignment cannot be closed while any child task is incomplete or any request is open.

---
# 5. STATE MACHINE

### 5.1 Design rule
`current_state` is the operational position. `sla_status`, `escalation_level`, `priority_bucket` and `open_request_type` are orthogonal attributes. Only the transition service may write `current_state`, and only via a row in the transition table. Any attempted transition not present in the table is rejected, logged as `ILLEGAL_TRANSITION_ATTEMPT` and surfaced to the security dashboard.

### 5.2 States

| State | Entered by | How entered | Allowed next | Required info | Automatic actions | SLA treatment | Notify | Audit event |
|---|---|---|---|---|---|---|---|---|
| `DRAFT` | Assignor | Save incomplete form | SUBMITTED, CANCELLED | None | Auto-purge after 7 days | No clock | None | DRAFT_SAVED |
| `SUBMITTED` | Assignor | Submit (validation + duplicate pass) | ASSIGNED, CANCELLED | Full validation set | TAT resolve, SLA open, task rows created | Clock **starts** | Target location queue | ASSIGNMENT_CREATED |
| `ASSIGNED` | System | Routed to location queue | ACCEPTED, REASSIGNED, CANCELLED | None | Acceptance SLA timer, unactioned promotion | Running, ASSIGNEE | Location TL + members | ASSIGNMENT_ROUTED |
| `ACCEPTED` | Assignee | Accept action | IN_PROGRESS, AWAITING_INFORMATION, DELAY_REVIEW | Acceptor identity | Acceptance timer stops | Running, ASSIGNEE | Assignor | ASSIGNMENT_ACCEPTED |
| `IN_PROGRESS` | Assignee | Auto on accept, or on request resolution | COMPLETED, AWAITING_INFORMATION, DELAY_REVIEW, CANCELLED | None | Pre-breach nudges | Running, ASSIGNEE | None | WORK_STARTED |
| `AWAITING_INFORMATION` | Assignee | Raise RFI | IN_PROGRESS, CANCELLED | Reason code, remarks if Other | RFI sub-TAT 2h to assignor | Paused **only if eligible**, attribution ASSIGNOR | Assignor + their TL | RFI_RAISED |
| `DELAY_REVIEW` | Assignee | Report delay | IN_PROGRESS | Reason, category, remarks, expected completion | 1h review timer, auto-accept at expiry | Continues running; extension applied on resolution | Assignor | DELAY_REPORTED |
| `COMPLETED` | Assignee | Submit report + evidence | UNDER_REVIEW | Share date/time/via, evidence | All tasks must be complete | Clock **stops** | Assignor | WORK_COMPLETED |
| `UNDER_REVIEW` | System | Auto on completion | CLOSED, REWORK, ARBITRATION | None | Review sub-SLA 4 business hours | Assignor sub-clock, attribution ASSIGNOR | Assignor | REVIEW_STARTED |
| `REWORK` | Assignor | Dispute (≤2 times) | COMPLETED, ARBITRATION, CANCELLED | Dispute reason code | Priority forced P1, 2 business-hour corrective TAT, `breach_cycle_no`++ | **New** corrective clock; original SLA record preserved untouched | Assignee + their TL | DISPUTE_RAISED |
| `ARBITRATION` | System | 3rd dispute attempt, or review SLA breach | CLOSED, REWORK | Arbiter decision + reason | Routed to lowest common manager | Clock attribution EXTERNAL_REVIEW | Both parties + arbiter | ARBITRATION_OPENED |
| `CLOSED` | Assignor / Arbiter | Accept, or arbitration decision | REOPENED (privileged only) | Acceptance confirmation | All clocks stopped, record sealed | Final | Both parties | ASSIGNMENT_CLOSED |
| `REOPENED` | Ops Head / Admin | Privileged reopen with reason | IN_PROGRESS | Mandatory reason + approver | `breach_cycle_no`++, new SLA cycle | New cycle, original preserved | All parties | ASSIGNMENT_REOPENED |
| `CANCELLED` | Assignor (pre-accept) or Ops Head | Cancel with reason | — | Mandatory reason | Clocks stopped, no strike | Terminal | Both parties | ASSIGNMENT_CANCELLED |

**Deliberately absent:** `SLA_BREACHED` and `ESCALATED` (see C1).

### 5.3 Illegal transitions worth naming explicitly
- `ASSIGNED → COMPLETED` (cannot complete work never accepted).
- `AWAITING_INFORMATION → COMPLETED` (must return to IN_PROGRESS so the pause segment closes and attribution is recorded).
- `CLOSED → anything` except privileged `REOPENED`.
- Any transition performed by a user who is neither the current owner, nor in the owner's management chain, nor Admin.

### 5.4 Priority score (queue ordering)

```
priority_score =
    bucket_weight
  + min(sla_consumed_pct, 200)          -- overrun counts, capped
  + escalation_level * 25
  + client_criticality_weight           -- 0..30, from client master
  + min(unactioned_minutes / 10, 40)    -- pressure to accept
  + strike_exposure_weight              -- 15 if this location is on strike 2

bucket_weight:
  BREACHED_OPEN        1000
  REWORK_P1             850
  ACTION_DUE_ON_ME      700   -- RFI to answer, delay to review, report to review
  AT_RISK (>=85%)       600
  UNACTIONED            450
  RUNNING               200
  PAUSED                100
  CLOSED                  0

ORDER BY priority_score DESC, sla_due_at ASC, assignment_id ASC
```

`priority_score`, `priority_bucket`, `sla_consumed_pct` and `sla_status` are **materialised columns** on `assignment`, refreshed by (a) the transition service on every event and (b) a 5-minute tick job that only touches rows where `sla_status <> 'CLOSED'` and `next_recompute_at <= now()`. Dashboards never recompute from history. This is the single most important performance decision in the design.

---

# 6. SLA / TAT ENGINE

### 6.1 Rule resolution — deterministic specificity scoring

`sla_rule` dimensions, each nullable (NULL = wildcard):
`client_id`, `verification_type_id`, `point_qty_min`, `point_qty_max`, `assignee_location_id`, `branch_id`, `case_priority`.

Resolution algorithm:
1. Select active rules where `effective_from <= now() < coalesce(effective_to, 'infinity')`.
2. Discard any rule where a non-NULL dimension does not match the assignment exactly.
3. Score each surviving rule: `client_id` 32, `verification_type_id` 16, quantity band 8, `assignee_location_id` 4, `branch_id` 2, `case_priority` 1. Sum the weights of non-NULL matched dimensions.
4. Highest score wins. Tie → latest `effective_from`. Still tied → lowest `sla_rule_id`. Deterministic in all cases.
5. If no rule survives, use the system default: **24 business hours, assignee location calendar**, and record `resolution_source = 'SYSTEM_DEFAULT'`.

This produces exactly your stated hierarchy (Client + Type + Qty → Client + Type → Client → Default) and extends cleanly to location and branch overrides without any change to the algorithm.

**Multi-verification assignments:** where several verification types are bundled, the resolved TAT is `MAX(rule TAT per type)` plus a configurable `additional_point_increment` per point beyond the first (default 0). The rule that produced the maximum is recorded as the governing rule; all evaluated candidates are stored in `sla_instance.resolution_trace` (JSON) so any TAT can be explained years later without re-running the engine.

### 6.2 Snapshot immutability
At creation, `sla_instance` stores: `sla_rule_id`, `tat_value_minutes`, `clock_type`, `calendar_id`, `sla_start_at`, `sla_due_at`, `resolution_source`, `resolution_trace`, `breach_cycle_no`. **These are immutable.** A later change to the rule master never touches a live or historic SLA instance (Scenario 18). Recalculation of a live assignment is possible only via an Admin `SLA_RECALCULATED` event with a mandatory reason, which writes a new SLA instance version and preserves the old one.

### 6.3 Business calendar
`business_calendar` (location-linked) holds working days, shift start/end, and a holiday table. `add_business_minutes(start_ts, minutes, calendar_id)` and `business_minutes_between(a, b, calendar_id)` are the only two functions used. Both are deterministic and unit-tested against a fixture set including year boundaries, DST and multi-day holidays.

### 6.4 The clock-segment ledger (core control)

```
sla_clock_segment
  segment_id PK
  sla_instance_id FK
  seq_no                     -- append order, unique per instance
  segment_start_at
  segment_end_at             -- NULL while open; exactly one open segment per instance
  clock_state                -- RUNNING | PAUSED
  attribution                -- ASSIGNEE | ASSIGNOR | CUSTOMER | EXTERNAL_DEPENDENCY
                             -- | APPROVED_HOLD | SYSTEM_OUTAGE | PENDING_REVIEW
  reason_code
  source_event_id FK
  business_minutes           -- computed on close, stored
  counts_toward_sla BOOLEAN  -- derived from attribution + policy
  counts_toward_strike BOOLEAN
```

Elapsed SLA time = `SUM(business_minutes) WHERE counts_toward_sla`. Strike-attributable time = `SUM(business_minutes) WHERE counts_toward_strike AND attribution = 'ASSIGNEE'`. Breach = elapsed > `tat_value_minutes`. Strike eligibility = strike-attributable time > `tat_value_minutes + grace_minutes`.

Because the ledger is append-only and every segment cites the event that opened it, any strike, breach or waiver can be reconstructed and defended to the minute.

### 6.5 SLA attribution policy (Section 22 of brief)

| Attribution | Trigger | Counts to SLA | Counts to strike | Who owns it | KPI it lands on |
|---|---|---|---|---|---|
| `ASSIGNEE` | Default running state | Yes | Yes | Assignee | Assignee TAT compliance |
| `ASSIGNOR` | Eligible RFI pause; review sub-SLA | No | No | Assignor | Assignor responsiveness |
| `CUSTOMER` | Delay category = customer unavailable/refused, **with evidence** | No | No | Client | Client data/access quality |
| `EXTERNAL_DEPENDENCY` | Delay category = police verification, records office, weather, bandh | No | No | Neither | External friction rate |
| `APPROVED_HOLD` | Explicit hold approved by Branch Manager+ | No | No | Approver | Hold volume by approver |
| `SYSTEM_OUTAGE` | Platform incident window, applied in bulk by Admin | No | No | IT | Availability |
| `PENDING_REVIEW` | Auto-accepted delay, unconfirmed | **Yes** | **No** | Assignor to resolve | Auto-accept rate (assignor) |

`PENDING_REVIEW` counting toward SLA but not toward strike is intentional: the case still looks late on the control tower so it stays visible, but nobody is punished until a human confirms who owned the time.

**Guard against attribution abuse:** only the delay/RFI resolution service and Admin bulk-outage tooling may write non-`ASSIGNEE` attribution. No screen exposes attribution as a free field. Every non-`ASSIGNEE` segment requires a `source_event_id`. Segments where a user's own delay request set a non-assignee attribution are sampled for QA at a configurable rate (default 10%).

---

# 7. DELAY MANAGEMENT

**Raise.** Assignee supplies delay reason (from taxonomy), delay category (which drives proposed attribution), remarks, expected completion. Expected completion must be in the future and within the extension cap. State → `DELAY_REVIEW`. A `assignment_request` row of type `DELAY` is created with its own 1-hour review sub-TAT.

**Review.** The assignor (or, if unavailable, anyone in the assignor's chain, or the assignor's location TL) sees the item in the **Action Required** queue with bucket weight 700.
- **Accept:** `sla_due_at` extended to `min(expected_completion, sla_start + 1.5 × TAT, sla_due + 12 business hours)`. A segment closes and a new one opens with the attribution implied by the delay category. Event `DELAY_ACCEPTED`.
- **Deny:** mandatory reason. No extension, no attribution change. The assignee is notified and remains on the original clock. Event `DELAY_DENIED`. Denied delays count on the assignee's quality KPI.
- **Auto-accept at 1 hour:** resolution `AUTO_ACCEPTED`, provisional extension applied, attribution `PENDING_REVIEW`, event `DELAY_AUTO_ACCEPTED`. Notified to the assignor **and their manager**. Appears in the assignor's "Confirm Attribution" tray for bulk confirmation.

**Caps.** One auto-accept per assignment. A second delay request that goes unreviewed for 1 hour escalates to the assignor's manager and does not self-approve. Maximum 3 delay requests per assignment; the 4th is blocked and the assignment routes to arbitration.

**Why the caps matter:** without them, delay reporting is an unlimited SLA printing press.

---

# 8. RFI MANAGEMENT

**Raise.** Reason from taxonomy (Address incomplete, Contact details incomplete, Point ID missing/incorrect, Verification requirement unclear, Applicant information mismatch, Other). "Other" requires remarks. The assignee may attach a screenshot. State → `AWAITING_INFORMATION`. `assignment_request` of type `RFI` with 2-hour sub-TAT to the assignor.

**Pause eligibility check at raise time (C4):**
```
pause_eligible =
      (sla_consumed_pct <= 50)
  AND (pause_eligible_rfi_count_on_assignment < 2)
  AND (reason_code <> 'OTHER' OR remarks_length >= 20)
```
The assignee sees the outcome before submitting: "This request will pause your clock" or "This request will be sent, but your clock keeps running because more than half the TAT has already elapsed." Transparency here is what stops arguments later.

**Respond.** Assignor supplies corrected data. If a Point ID or address is corrected, the correction writes to the case/party record and is audited as a data change with before/after values. State → `IN_PROGRESS`, pause segment closes with `business_minutes` capped at 120.

**Reject as invalid.** If the assignor asserts the information was already supplied, they reject with reason. No pause is credited, any provisional pause segment is closed with `counts_toward_sla = true`, and the RFI counts on the assignee's quality KPI. This is the control that prevents nuisance RFIs.

**Assignor non-response.** At 2 hours, the RFI breaches its own sub-SLA and escalates to the assignor's manager. The parent assignment clock remains paused with `ASSIGNOR` attribution up to the 120-minute cap, then resumes with `ASSIGNEE` attribution but with a permanent flag `assignor_rfi_breach = true` that suppresses strike generation for this cycle. Nobody is punished for the other side's silence.

---

# 9. DISPUTE / REWORK MANAGEMENT

**Raise.** Only from `UNDER_REVIEW`, only by the assignor or their management chain. Reason code mandatory from taxonomy: Report incomplete, Wrong address verified, Wrong person verified, Evidence missing/illegible, Findings inconsistent, Point ID mismatch, Other (remarks mandatory). Optional annotated attachment.

**Effects.**
- New `assignment_request` of type `DISPUTE`.
- State → `REWORK`. `priority_override = 'P1'`, `breach_cycle_no` incremented.
- A **new** SLA instance is created for the corrective cycle: 2 business hours, assignee location calendar. The original SLA instance is untouched, retains its own status and its own breach record. This satisfies "the SLA must not be overwritten" literally and structurally.
- The original completion record (`assignment_completion` row) is retained in full and marked `superseded_by`, never edited or deleted.
- Notification to assignee, assignee TL, and the assignor's own manager (so that dispute volume is visible upward).

**Resolution and classification.** When the reworked report is accepted, the assignor must classify the dispute as `UPHELD` (the rework confirmed the defect) or `NOT_UPHELD` (the original report was adequate). Not-upheld disputes count on the assignor's quality KPI and are reported by assignor and by location. Without this, disputing is free.

**Cap.** Two disputes per assignment. The third attempt opens `ARBITRATION` with the lowest common manager of both parties as arbiter, who may close, order one final rework, or void the strike exposure of either side.

**Strike treatment during rework:** a corrective-cycle breach generates a strike only if attributable to the assignee and only once for that `breach_cycle_no`. A dispute classified `NOT_UPHELD` retroactively voids any strike generated in that cycle, via a `STRIKE_WAIVED` event citing the arbitration or classification decision. The strike row is never deleted.

---

# 10. ESCALATION ENGINE

### 10.1 Integration stance
The existing escalation engine remains the system of record for routing and notification. This workflow contributes **triggers** and **context**, through a single adapter:

```
raise_escalation(
  source_module      = 'OPS_VERIFICATION_ASSIGNMENT',
  source_ref_type    = 'ASSIGNMENT',
  source_ref_id      = assignment_id,
  client_id, location_id, branch_id,
  escalation_level, trigger_code, occurred_at,
  idempotency_key    = hash(assignment_id, breach_cycle_no, level, trigger_code)
)
```
The idempotency key is the defence against retry storms, duplicate background job runs and application restarts. A repeat call with the same key returns the existing escalation and writes an `ESCALATION_DUPLICATE_SUPPRESSED` event.

### 10.2 Matrix resolution (client + location + level + role/user)

`escalation_matrix` keys: `client_id` (nullable), `location_id` (nullable), `branch_id` (nullable), `escalation_level`, `role_id` or `user_id`, `sequence_no`, `effective_from/to`.

Resolution uses the same specificity-scoring pattern as TAT, which keeps the mental model consistent for Admin:
1. Client + Branch + Level
2. Client + Location + Level
3. Client + Level
4. Location + Level
5. Global default matrix for Level

**Fallback when nothing is configured (Scenario 15):** resolve to the **organisation hierarchy** of the assignee's location, walking up from the location's Team Leader → Branch Manager → Zonal Manager → Operations Head, taking the person at the depth corresponding to the escalation level. Simultaneously raise a `CONFIG_GAP` alert to Admin and the Ops Head naming the exact missing key (`client X + location Y + level N`), and write an `ESCALATION_FALLBACK_USED` event on the assignment. The case never stalls, and the configuration gap becomes visible rather than silent. Config-gap counts are a control tower KPI.

**Unavailable escalation manager (inactive, on leave, exited):** the resolver checks user status and an out-of-office/delegation table. Order: named user → their active delegate → their manager → next level up. Every substitution writes `ESCALATION_TARGET_SUBSTITUTED` with the reason. An escalation is never sent to a dead mailbox without a fallback.

### 10.3 Level progression

| Level | Trigger | Target | Notification |
|---|---|---|---|
| Pre-0 | 50 / 75 / 90% consumed | Assignee, then assignee TL at 90% | In-app + push. **No escalation record.** |
| 1 | Breach confirmed (attributable) | Assignee TL + Assignor | In-app + email |
| 2 | Breach + 50% of TAT again, or 2nd corrective breach | Branch Manager both sides | In-app + email |
| 3 | Breach + 100% of TAT again | Zonal Manager | In-app + email + daily digest to Ops Head |
| 4 | Breach + 200%, or arbitration deadlock | Operations Head | Immediate, with full case pack |

Progression is evaluated by the same 5-minute tick job that maintains priority score, using the materialised columns. It never scans the event history.

---

# 11. THREE-STRIKE INTEGRATION

### 11.1 Model
Strikes are **events**, never columns on the assignment. `strike_event` preserves: case, assignment, verification task, subject user, subject location, client, trigger code, occurred_at, strike_number (within the rolling window), escalation level at the time, attributable minutes, resolution, waiver flag, waiver reason, approving authority, and the `sla_instance_id` and `breach_cycle_no` that produced it.

### 11.2 Eligibility (not every breach)
```
strike_eligible =
      attributable_assignee_minutes > tat_value_minutes + grace_minutes
  AND assignor_rfi_breach = false
  AND cancellation_flag = false
  AND system_outage_overlap = false
  AND dispute_classification <> 'NOT_UPHELD'
```

### 11.3 Duplicate prevention (explicitly required)
Three layers:
1. **Unique constraint** `UNIQUE (assignment_id, breach_cycle_no, trigger_code)` on `strike_event`. A duplicate insert fails at the database, not in application logic.
2. **Idempotency key** on the strike engine adapter, identical pattern to escalation.
3. **Single-writer rule.** Only the SLA monitor job writes strikes, running under an advisory lock so two application instances cannot both process the same batch.

A rework cycle increments `breach_cycle_no`, so a genuine second failure on the same assignment is a distinct strike rather than a suppressed duplicate. This is the subtle case that most implementations get wrong in one direction or the other.

### 11.4 Strike subject
The strike attaches to the **assignee location** and to the **allocated individual** at the time of breach, captured as a point-in-time snapshot. If the individual has since transferred (Scenario 14) or exited, the strike remains attached to the historical identity and location and does not follow them into a new team's metrics. Location-level and individual-level strike counts are reported separately.

### 11.5 Window and waiver
Strike count is evaluated over a rolling configurable window (default 90 days) per subject. Strike 3 within the window triggers the existing 3-strike consequence process. Waiver requires Branch Manager or above, mandatory reason, and writes `STRIKE_WAIVED`; the original row survives with `is_waived = true`. Waiver rates by approver are a control tower KPI, because an unmonitored waiver path is itself a loophole.

---

# 12. RACI

### 12.1 Matrix

| Action | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| Create assignment | Assignor (Executive+) | Assignor's Team Leader | — | Assignee location TL |
| Approve own-location assignment exception | Assignor | Branch Manager (approves) | — | Ops Head (digest) |
| Allocate to executive | Assignee location TL | Assignee Branch Manager | — | Assignor |
| Accept assignment | Assignee | Assignee TL | — | Assignor |
| Request more details | Assignee | Assignee TL | — | Assignor TL |
| Respond to RFI | Assignor | Assignor TL | — | Assignee |
| Reject RFI as invalid | Assignor | Assignor TL | — | Assignee TL |
| Report delay | Assignee | Assignee TL | — | Assignor |
| Accept / deny delay | Assignor | Assignor TL | Assignee TL where category = external | Assignee |
| Confirm auto-accepted attribution | Assignor | Assignor Branch Manager | — | Ops MIS |
| Complete + share report | Assignee | Assignee TL | — | Assignor |
| Review report | Assignor | Assignor TL | — | Assignee |
| Dispute | Assignor | Assignor Branch Manager | — | Assignee TL, Assignor's manager |
| Classify dispute outcome | Assignor | Assignor Branch Manager | — | Quality MIS |
| Arbitrate | Lowest common manager | Zonal Manager | Both TLs | Both parties |
| Escalate manually | Any party | Their own TL | — | Matrix targets |
| Override SLA / recalculate | Admin | Operations Head | Branch Manager of affected location | Both parties, audit |
| Apply system-outage attribution in bulk | Admin | Operations Head | IT | All affected users |
| Waive strike | Branch Manager+ | Zonal Manager | Assignee TL | Ops MIS, HR interface |
| Reopen closed assignment | Ops Head or Admin | Operations Head | Both TLs | Both parties |
| Close | Assignor (via accept) | Assignor TL | — | Assignee |
| Cancel | Assignor pre-accept; Ops Head thereafter | Branch Manager | Assignee TL | Assignee |
| Modify TAT rules | Admin | Operations Head | Client servicing | All Ops managers |
| Modify escalation matrix | Admin | Operations Head | Affected Branch Managers | All Ops managers |
| Grant temporary participant access | Assignor (invite) | Assignee Branch Manager (approve) | — | Security/Admin log |
| Export data | Role-gated | Operations Head | — | Security log |

### 12.2 RACI conflicts identified and resolved

**Conflict 1 — the assignor is both requester and judge.** The assignor creates the work, disputes the output, and closes the case. Nothing constrains them. **Resolution:** dispute outcome classification plus the 2-dispute cap plus arbitration by a neutral manager, and a "Not Upheld" KPI on the assignor. The judge is now measured.

**Conflict 2 — auto-accept has no Accountable party.** As written, if the assignor does nothing, the system approves and no one is answerable. **Resolution:** `PENDING_REVIEW` attribution plus a confirmation tray plus an auto-accept-rate KPI on the assignor and a notification to their manager. Accountability restored without blocking the assignee.

**Conflict 3 — "anyone from Executive to Ops Head may assign" makes everyone Responsible and no one Accountable.** **Resolution:** the assignor's Team Leader is Accountable for every assignment their team creates, and assignment quality (RFI rate, data completeness score) is reported at team level.

**Conflict 4 — Admin is Responsible for SLA override and also for the audit configuration.** A single Admin could alter an SLA and suppress the trace. **Resolution:** audit configuration is a separate permission from operational configuration, held by a different person; audit tables are append-only at the database grant level; SLA override requires Ops Head as Accountable with a mandatory reason surfaced on a daily override report.

**Conflict 5 — Team Leader is Accountable for acceptance but the case is delivered to a location queue with no named owner.** Between routing and allocation, nobody owns the clock. **Resolution:** the acceptance SLA is owned by the location TL by default, and unallocated items surface in the TL's queue at `UNACTIONED` weight after 30 business minutes.

---

# 13. RBAC / VISIBILITY MODEL

### 13.1 Composition
Access = **Role** (what actions) × **Scope** (whose records) × **State** (is the action legal now) × **Ownership** (are you a party to this record).

All four must pass. Most access defects come from systems that check only the first.

### 13.2 Roles and permission bundles

| Permission | Exec | TL | Branch Mgr | Zonal Mgr | Ops Head | Admin |
|---|---|---|---|---|---|---|
| CREATE_ASSIGNMENT | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| ASSIGN_TO_INDIVIDUAL | — | ✓ | ✓ | ✓ | ✓ | — |
| ACCEPT / EXECUTE / COMPLETE | ✓ | ✓ | ✓ | — | — | — |
| RAISE_RFI / REPORT_DELAY | ✓ | ✓ | ✓ | — | — | — |
| REVIEW_DELAY / RESPOND_RFI | ✓ (own) | ✓ (team) | ✓ | ✓ | ✓ | — |
| DISPUTE | ✓ (own) | ✓ (team) | ✓ | ✓ | ✓ | — |
| ARBITRATE | — | — | ✓ | ✓ | ✓ | — |
| ESCALATE_MANUAL | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| REASSIGN | — | ✓ (own loc) | ✓ | ✓ | ✓ | — |
| OVERRIDE_DUPLICATE | — | ✓ | ✓ | ✓ | ✓ | — |
| WAIVE_STRIKE | — | — | ✓ | ✓ | ✓ | — |
| REOPEN_CLOSED | — | — | — | — | ✓ | ✓ |
| SLA_OVERRIDE / RECALC | — | — | — | — | Approve | Execute |
| INVITE_TEMP_PARTICIPANT | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| APPROVE_TEMP_PARTICIPANT | — | — | ✓ | ✓ | ✓ | ✓ |
| MASTER_CONFIG (TAT, matrix, taxonomy) | — | — | — | — | Approve | ✓ |
| AUDIT_CONFIG | — | — | — | — | — | Separate holder |
| EXPORT | — | ✓ (team, masked) | ✓ | ✓ | ✓ | ✓ |
| VIEW_CONTROL_TOWER | Own | Team | Branch | Zone | All | All |

### 13.3 Scope resolution without recursive queries
Maintain an `org_unit_closure` table (`ancestor_id`, `descendant_id`, `depth`), refreshed on hierarchy change. Row-level visibility becomes a join, not a recursive CTE:

```sql
-- Queue B: team / subordinate hierarchy
SELECT a.* FROM assignment a
JOIN org_unit_closure c ON c.descendant_id = a.assignor_org_unit_id
WHERE c.ancestor_id = :my_org_unit_id
  AND a.priority_bucket <> 'CLOSED'
ORDER BY a.priority_score DESC, a.sla_due_at ASC;
```

No email-ID hard-coding anywhere. Visibility derives entirely from `role`, `org_unit_closure`, `user_location_assignment` and record ownership.

### 13.4 The four queues

| Queue | Definition | Predicate |
|---|---|---|
| **A. Assigned by Me** | Cases I created | `assignor_user_id = :me` |
| **B. My Team's Assignments** | Created by anyone at or below me | closure join above, requires TL+ |
| **C. Assigned to Me** | Work my location or I must perform | `assignee_location_id IN :my_locations` (+ `allocated_user_id = :me` if allocated) |
| **D. Action Required** | Anything awaiting **my** decision, from any queue | `next_action_owner_id = :me` OR `next_action_role_scope` matches |

Queue D is the addition to your specification and is the highest-value UI change in the design. Without it, an assignor with 400 open cases must hunt through Queue A for the 6 delay reviews that expire in an hour. `next_action_owner_id` is a materialised column maintained by the transition service.

Every queue supports grouping by **Location** and **Client** (server-side grouped counts, not client-side), plus filters on verification type, SLA status, escalation level, ageing band and date range, and free-text search on Force1 Case ID, Point ID, applicant name and contact number.

---

# 14. DATABASE / ENTITY ARCHITECTURE

### 14.1 Verdict on your proposed entity list

**Reused from existing masters, not rebuilt:** `users`, `organisation`/`org_unit`, `location`, `client`, `branch`. This design adds only foreign keys and, where the existing masters lack them, small extension tables (for example `location_calendar_map`) rather than new copies.

**Consolidated:** `information_request` + `delay_request` + `dispute` → **one** `assignment_request` table with a `request_type` discriminator. All three share the same lifecycle (raised → pending review → resolved, each with its own sub-TAT, reason taxonomy, resolver and audit trail). Three tables would mean three UIs, three notification paths, three sub-SLA implementations and three sets of bugs. Type-specific fields live in a JSONB `payload` with a per-type schema check constraint.

**Split:** `assignment` → `assignment` + `assignment_task` (one per verification point). This is what makes Section 16 of your brief possible. Also `sla_instance` → `sla_instance` + `sla_clock_segment`.

**Separated by purpose:** `assignment_event` (domain event stream that drives workflow and analytics) is distinct from `audit_log` (security-grade, table-agnostic change record covering master data too). Merging them produces a table that is both too hot and too cold.

**Added, not in your list:** `business_calendar` + `calendar_holiday`, `org_unit_closure`, `notification_outbox`, `temp_participant_grant`, `duplicate_override`, `assignment_completion`, `reason_taxonomy`, `user_delegation`.

**Deferred:** a separate `verification_point` master is not needed, because Point IDs originate in Force1. `assignment_task` stores the Point ID with a uniqueness constraint. Introducing a local point master would create a synchronisation problem with no benefit.

### 14.2 Entity catalogue

Legend for mutability: **I** = immutable after insert, **M** = mutable, **S** = system-maintained only.

---
**`case`** — the parent record for a Force1 case. Never duplicated per assignment.
- PK `case_id` (surrogate). Natural key `force1_case_id` UNIQUE.
- Fields: `force1_case_id` (I), `client_id` (I), `branch_id` (I), `vendor_branch_name` (M), `originating_location_id` (I), `created_by_user_id` (I), `created_at` (I), `case_status` (S), `data_completeness_score` (S).
- Relationships: 1→n `case_party`, 1→n `case_verification_requirement`, 1→n `assignment`.
- Owner: originating location. Indexes: `force1_case_id` UNIQUE, `(client_id, created_at)`, `(originating_location_id, case_status)`.
- Volume: 1× per real case. Retention: 7 years, then archive partition.

**`case_party`** — applicant, co-applicants, guarantors. **This replaces CoApplicant1/2/3 columns entirely.**
- PK `party_id`. FK `case_id`.
- Fields: `party_role` (APPLICANT | CO_APPLICANT | GUARANTOR), `party_seq`, `name`, `contact_number`, `address_line`, `landmark`, `pincode`, `google_maps_url`, `address_verified_with` (BANK | CUSTOMER | NOT_VERIFIED), `same_as_party_id` (self-FK for "Same as Applicant"), `is_active`.
- All fields M but every change writes to `audit_log` with before/after.
- Constraint: exactly one `APPLICANT` per case; 0..n co-applicants; 0..n guarantors (your brief said one, the model supports many at zero extra cost).
- Indexes: `(case_id, party_role)`, `contact_number` (search), `pincode`.
- Volume: ~2.5 rows per case. Retention: with case.

**`verification_type`** — master. PK `verification_type_id`, `code`, `name`, `is_active`, `display_order`. Tiny, cached in memory, Admin-maintained. Adding "Quotation Verification" or a new type is a data change, never a code change.

**`case_verification_requirement`** — what needs verifying on this case, at point granularity. Independent of who it is assigned to.
- PK `requirement_id`. FK `case_id`, `verification_type_id`.
- Fields: `force1_point_id` (I), `requirement_status` (S: UNASSIGNED | ASSIGNED | COMPLETED | CANCELLED), `subject_party_id` (which party this point relates to, nullable).
- Constraint: `UNIQUE (case_id, verification_type_id, force1_point_id)`.
- **This is the entity that enables split-location assignment.** Different requirements on the same case can point to different assignments, with no case duplication.
- Indexes: `(case_id)`, `(force1_point_id)`, partial index on `requirement_status = 'UNASSIGNED'`.

**`assignment`** — one dispatch of one or more requirements to one location. The workflow aggregate root.
- PK `assignment_id`. FK `case_id`.
- Immutable: `assignor_user_id`, `assignor_org_unit_id`, `assignor_location_id`, `assignee_location_id`, `created_at`.
- Mutable by transition service only (S): `current_state`, `allocated_user_id`, `priority_override`, `breach_cycle_no`, `next_action_owner_id`, `next_action_due_at`.
- Materialised for performance (S): `sla_due_at`, `sla_status`, `sla_consumed_pct`, `priority_bucket`, `priority_score`, `escalation_level`, `open_request_type`, `next_recompute_at`.
- Indexes (queue-shaped, this is where dashboard speed comes from):
  - `(assignee_location_id, priority_bucket, priority_score DESC, sla_due_at)` — Queue C
  - `(assignor_user_id, priority_bucket, priority_score DESC)` — Queue A
  - `(assignor_org_unit_id, priority_bucket, priority_score DESC)` — Queue B
  - `(next_action_owner_id, next_action_due_at)` WHERE next_action_owner_id IS NOT NULL — Queue D
  - `(next_recompute_at)` WHERE current_state NOT IN ('CLOSED','CANCELLED') — tick job
  - `(client_id, assignee_location_id, created_at)` — reporting
- Volume: the hottest table. Design target below. Retention: hot 12 months, then monthly range partitions.

**`assignment_task`** — one row per verification point in the assignment.
- PK `task_id`. FK `assignment_id`, `requirement_id`.
- Fields: `task_status`, `completed_at`, `completed_by_user_id`, `findings_summary`.
- Constraint: partial unique index preventing two active tasks on the same requirement (see Section 15).
- An assignment cannot reach `COMPLETED` while any task is incomplete.

**`assignment_completion`** — the report submission record. One row per completion attempt; **never updated**.
- PK `completion_id`. FK `assignment_id`, `breach_cycle_no`.
- Fields: `report_shared_date`, `report_shared_time`, `report_shared_via` (array), `other_remarks`, `submitted_by`, `submitted_at`, `evidence_attachment_ids`, `channel_reference`, `superseded_by_completion_id`, `backdate_flag`.
- A dispute supersedes rather than overwrites. This is what preserves "original completion remains in audit history".

**`assignment_request`** — consolidated RFI / DELAY / DISPUTE / HOLD.
- PK `request_id`. FK `assignment_id`.
- Fields: `request_type`, `reason_code` (FK `reason_taxonomy`), `remarks`, `payload` JSONB, `raised_by`, `raised_at`, `sub_tat_minutes`, `sub_due_at`, `status` (PENDING | ACCEPTED | DENIED | AUTO_ACCEPTED | REJECTED_INVALID | EXPIRED), `resolved_by`, `resolved_at`, `resolution_reason`, `pause_eligible`, `attribution_applied`, `outcome_classification`.
- Constraint: at most one PENDING request per assignment (a case cannot simultaneously await information and await delay review; the UI enforces this too).
- Indexes: `(assignment_id, status)`, `(status, sub_due_at)` WHERE status = 'PENDING' — this single partial index drives the entire sub-SLA monitor.

**`sla_rule`** — Admin-maintained TAT configuration. Fields per Section 6.1 plus `tat_minutes`, `clock_type`, `grace_minutes`, `effective_from/to`, `created_by`, `approved_by`. Small table, fully cached, versioned rather than edited in place.

**`sla_instance`** — per assignment per breach cycle. Immutable snapshot per Section 6.2. Indexes: `(assignment_id, breach_cycle_no)` UNIQUE, `(sla_status, sla_due_at)` partial on open.

**`sla_clock_segment`** — append-only ledger per Section 6.4. Constraint: exactly one open segment per instance, enforced by a partial unique index on `(sla_instance_id) WHERE segment_end_at IS NULL`. High volume (3–6 rows per assignment). Partitioned by month.

**`assignment_event`** — the domain event stream. PK `event_id`, FK `assignment_id`, `event_type`, `actor_user_id` (nullable for system), `actor_type` (USER | SYSTEM | TEMP_PARTICIPANT | INTEGRATION), `occurred_at`, `previous_state`, `new_state`, `reason_code`, `remarks`, `source_channel` (WEB | MOBILE | API | JOB), `correlation_id`, `payload` JSONB. **INSERT only**; UPDATE and DELETE revoked at the grant level. Highest-volume table. Partitioned monthly, indexed `(assignment_id, occurred_at)` and `(event_type, occurred_at)`.

**`escalation_matrix`** — per Section 10.2.
**`escalation_instance`** — the adapter's local record of each escalation raised, with `idempotency_key` UNIQUE, external escalation reference, `fallback_used` flag.
**`strike_event`** — per Section 11.1, with `UNIQUE (assignment_id, breach_cycle_no, trigger_code)`.
**`attachment`** — PK `attachment_id`, polymorphic owner (`owner_type`, `owner_id`), object-storage key, `content_hash` (SHA-256, for dedupe and tamper detection), `mime_type`, `size_bytes`, `virus_scan_status`, `uploaded_by`, `uploaded_at`. Immutable; replacement is a new row.
**`notification_outbox`** — transactional outbox. `status`, `attempts`, `next_attempt_at`, `channel`, `recipient_ref`, `template_code`, `payload`, `dedupe_key` UNIQUE.
**`notification_delivery`** — per-attempt result, provider reference, failure reason.
**`audit_log`** — table-agnostic change log for master data and any non-workflow mutation: `table_name`, `record_pk`, `column_name`, `old_value`, `new_value`, `changed_by`, `changed_at`, `change_reason`, `session_id`, `ip_address`. Append-only, write-once storage.
**`temp_participant_grant`** — Section 17.
**`duplicate_override`** — Section 15.
**`reason_taxonomy`** — every reason code in one Admin-maintained table with `context` (RFI | DELAY | DISPUTE | CANCEL | OVERRIDE | WAIVER), `code`, `label`, `requires_remarks`, `implied_attribution`, `is_active`. Adding a delay reason is configuration, not a release.
**`org_unit_closure`**, **`business_calendar`**, **`calendar_holiday`**, **`user_delegation`** — supporting masters.

### 14.3 Volume and retention targets

| Table | Rows per 100k cases/yr | Growth | Retention |
|---|---|---|---|
| case | 100k | linear | 7 yr, archive after 12 mo |
| case_party | 250k | linear | with case |
| case_verification_requirement | 180k | linear | with case |
| assignment | 130k (incl. reassignment) | linear | hot 12 mo, partitioned |
| assignment_task | 180k | linear | with assignment |
| assignment_request | 60k | linear | with assignment |
| sla_clock_segment | 500k | 4–5× assignments | hot 12 mo, partitioned |
| assignment_event | 1.6M | 12–15× assignments | hot 6 mo, then cold partitions |
| audit_log | 900k | variable | 7 yr, WORM storage |
| notification_outbox | 800k | purge on success after 30 days | 30 days |

---

# 15. DUPLICATE PREVENTION

Three tiers, because a single hard block is either too loose or unusable.

**Tier 1 — Hard block, enforced at the database.**
```sql
CREATE UNIQUE INDEX ux_active_point_assignment
  ON assignment_task (requirement_id)
  WHERE task_status IN ('PENDING','IN_PROGRESS','AWAITING_INFO','REWORK');
```
The same Force1 Case ID + Point ID cannot have two active assignments. Because `requirement_id` is unique on `(case_id, verification_type_id, force1_point_id)`, this closes the loophole at the level where it matters and survives concurrent submissions, retries and API calls. The application also checks first, so the user gets a clean message rather than a constraint error, but **the database is the enforcement point, not the UI.**

**Tier 2 — Soft warning with controlled override.** Triggered by:
- Same case + point completed or closed within the last 7 days (configurable).
- Same client + same applicant contact number + same pincode + different case, within 30 days (likely re-submission under a new case ID).
- Same case assigned to a second location while an assignment is already active on other points (legitimate, but worth confirming).

The user sees the matching records with a link, and must either cancel or override. Override requires `OVERRIDE_DUPLICATE` permission, a reason from taxonomy, and free text. It writes a `duplicate_override` row (`attempted_key`, `matched_assignment_ids`, `override_reason`, `overridden_by`, `approved_by`, `at`) plus an `ASSIGNMENT_DUPLICATE_OVERRIDDEN` event. Override rates by user and location are a control tower KPI, because a warning nobody measures is a warning everybody clicks through.

**Tier 3 — Idempotency on submit.** The creation form carries a client-generated `request_uuid`. The submit endpoint stores it with a unique constraint and returns the original result on repeat. This kills the double-click and the "network timed out so I pressed it again" duplicate, which in practice is more common than deliberate duplication.

---

# 16. AUDIT ARCHITECTURE

**Two streams, one truth.**
- `assignment_event` records **what happened to the work** and drives the timeline UI, analytics and SLA reconstruction.
- `audit_log` records **what changed in the data**, column by column, including master data and party corrections made during RFI responses.

**Every event carries:** actor (user, system, temp participant or integration), timestamp (UTC stored, local rendered), action, previous state, new state, reason code and remarks, source channel, correlation ID linking all rows produced by one user action, and the relevant reference (assignment, task, request, SLA instance, strike, escalation).

**Covered events (your Section 20 list, in full):** create, assign, route, reassign, allocate, accept, request more details, provide more details, RFI reject-invalid, delay report, delay accept, delay deny, delay auto-accept, attribution confirm, completion, report shared, dispute, dispute classification, rework submit, arbitration open/decide, escalate (manual and automatic), escalation fallback used, escalation target substituted, SLA breach, SLA recalculation, strike generated, strike waived, duplicate override, temp grant issued/used/revoked/expired, reopen, cancel, closure, illegal transition attempt, export.

**Immutability controls.** No application role holds UPDATE or DELETE on `assignment_event`, `audit_log`, `sla_clock_segment`, `strike_event` or `assignment_completion`. Corrections are new compensating events that reference the original. Daily hash-chaining of `audit_log` (each row stores the hash of the previous row's hash plus its own content) makes silent tampering detectable. Attachments carry a content hash for the same reason.

**Retention.** Events hot for 6 months and queryable for 7 years from cold partitions. Audit log to WORM storage. Any purge requires Ops Head plus audit-config holder, and the purge itself is audited.

---

# 17. TEMPORARY / NON-USER PARTICIPANT ACCESS

### 17.1 The rule
```
IF person exists in People/User master → use that identity.
   Reactivate or scope-extend; never create a second person record.
IF person has no application access → issue a case-scoped,
   function-scoped, time-bound GRANT. Never a role. Never an account.
```

### 17.2 Identity resolution at invite time
The inviter searches by mobile number, employee code, or name plus location. The system performs deterministic matching on mobile and employee code, then fuzzy matching on name plus location, and presents candidates. Creating a new person is only possible after a "no match" confirmation, and the new record is flagged `unverified_identity` for Admin review. This is the control that prevents the master data from silently duplicating people, which is the failure mode that eventually breaks every hierarchy report.

### 17.3 Grant model
```
temp_participant_grant
  grant_id PK
  person_id            -- FK to existing people master, always
  assignment_id        -- scope: exactly one assignment
  permitted_actions    -- explicit array, e.g. {VIEW_ASSIGNMENT_SUMMARY,
                       --   UPLOAD_EVIDENCE, SUBMIT_COMPLETION}
  purpose_code, invited_by, approved_by
  activated_at, expires_at        -- default 24h, hard ceiling 72h
  max_uses, use_count
  auth_method          -- OTP to registered mobile
  revoked_at, revoked_by, revoke_reason
  last_used_at, last_used_ip, device_fingerprint
```

### 17.4 Enforcement (closing the loophole you flagged)
1. Grants issue a **token with a distinct principal type** (`TEMP_PARTICIPANT`). This principal type has **no role bindings at all**, so it cannot inherit any queue, dashboard or list permission by accident.
2. Every data access by this principal is filtered by `assignment_id = grant.assignment_id` at the repository layer, enforced by a mandatory scope predicate rather than by each query remembering to add a WHERE clause.
3. The temp participant lands on a **single-purpose screen**: assignment summary, the specific action, submit. No navigation, no search, no export, no queue, no case list, no other party's details beyond what the task requires.
4. PII minimisation: address and contact are shown only for the party relevant to the assigned point. Full case data is never rendered.
5. Access requires OTP to the registered mobile on the master record, not to a number typed at invite time. This prevents an inviter from redirecting someone else's identity to their own phone.
6. Expiry is enforced server-side on every request, not by a client timer. Session termination is immediate on revoke.
7. Rate limits and anomaly detection: more than N grants issued by one inviter per day, grants used from unexpected geographies, or repeated failed OTP attempts raise a security alert.
8. All grant activity writes to both `assignment_event` and `audit_log` with `actor_type = 'TEMP_PARTICIPANT'`, so temp actions are visually distinct in the case timeline.

**Recommendation:** cap `permitted_actions` for temp participants to evidence upload and status view in phase 1, and require a permanent user to countersign the completion. Allowing a non-user to close a verification is a control weakness that is hard to defend in an audit, and the operational benefit is small.

---

# 18. NOTIFICATION ARCHITECTURE

**Transactional outbox.** The workflow never calls the notification provider inside its transaction. It writes to `notification_outbox` in the same transaction as the state change, and a dispatcher polls and sends. This guarantees that a notification is never lost because the provider was slow, and never sent for a transaction that rolled back.

**Delivery.** In-app is the system of record and is always written. Email and push are best-effort. Retry with exponential backoff (1m, 5m, 15m, 1h, 4h), maximum 5 attempts, then `FAILED` with an alert to Admin. `dedupe_key = hash(assignment_id, event_type, recipient_id, breach_cycle_no)` prevents duplicate sends from job retries.

**A failed notification never blocks the workflow and never excuses an SLA.** This is a deliberate policy decision, and the reason the in-app queue is authoritative: the case is visible in the recipient's queue regardless of whether email left the building. Where a notification fails for a **decision-required** item (delay review, RFI), the sub-SLA timer is suspended for the failure window and an alternate recipient (the manager) is notified, so nobody is auto-accepted purely because email was down. See Scenario 17.

**Digest strategy.** Individual events notify immediately. Managers receive a rolled-up digest (hourly for at-risk, daily for strikes, overrides, config gaps and auto-accepts). Without digesting, a manager of 40 people receives several hundred emails a day and stops reading all of them, which converts the notification system into a liability.

**Templates** are Admin-editable per `template_code` with variable substitution and per-role channel preferences.

---

# 19. DASHBOARD / QUEUE DESIGN

### 19.1 Operator view
Four tabs (A/B/C/D per Section 13.4), each with a coloured count chip. Within a tab: group-by control (Location | Client | None), a single-line filter bar, and rows showing Force1 Case ID, client, verification types as icons, applicant name, target/source location, ageing chip, SLA chip (green/amber/red with remaining time), escalation chip, and a single primary action button appropriate to the state. Bulk select for accept and allocate only.

### 19.2 Control tower (management)
Slices: Assigned, Accepted, Pending, At Risk, Breached, Delayed, Information Pending, Disputed, Escalated, Rework, Completed, Closed. Every slice pivots by client, location, branch, person, verification type, TAT band, ageing band, strike count and escalation level. Drill-through from any cell to the underlying list, and from any list row to the case timeline.

Served from a **materialised summary table** refreshed every 5 minutes (`ops_assignment_summary`, keyed by date × location × client × state × sla_status), not from live aggregation over the transaction table. Drill-through hits the live table with the queue indexes. This keeps the executive dashboard at sub-second load regardless of history size.

### 19.3 Management KPIs (recurring failure detection)

| KPI | Formula | Reveals |
|---|---|---|
| TAT compliance % | closed within attributable TAT ÷ closed | Baseline performance |
| Attributable breach % by location | strike-eligible breaches ÷ assignments received | True assignee performance |
| **RFI rate by assignor team** | RFIs raised ÷ assignments created | Upstream data quality, the biggest root cause |
| RFI rejection rate | RFIs rejected invalid ÷ RFIs raised | Nuisance RFI behaviour |
| Data completeness score by assignor | optional fields populated | Predicts RFI rate before it happens |
| Delay rate and delay mix by category | delay requests ÷ assignments | Genuine friction vs SLA management |
| **Auto-accept rate by assignor** | auto-accepted ÷ delay requests | Manager disengagement |
| Delay-to-completion accuracy | actual completion vs stated expected completion | Whether delay estimates are honest |
| Dispute rate and **not-upheld dispute %** | by assignor and location | Whether disputes are genuine |
| Rework cycle time | REWORK → COMPLETED | Corrective responsiveness |
| First-time-right % | closed with zero disputes and zero RFIs | The best single quality measure |
| Acceptance latency (p50/p90) | routed → accepted | Intake discipline |
| Duplicate override rate by user | overrides ÷ warnings shown | Control erosion |
| Strike waiver rate by approver | waived ÷ generated | Waiver-path abuse |
| Escalation config-gap count | fallback escalations | Missing matrix configuration |
| Escalation effectiveness | % resolved within one level | Whether escalation does anything |
| SLA override count by Admin | absolute | Privileged action monitoring |
| Backdated report flag rate | flagged completions ÷ completions | SLA evasion attempts |

The four KPIs I would put on the Ops Head's single page: **RFI rate by assignor team**, **attributable breach % by location**, **not-upheld dispute %**, and **auto-accept rate**. Those four detect the majority of recurring process failures in this workflow.

---

# 20. PERFORMANCE / SCALABILITY DESIGN

**Design targets.** 10× current volume assumed. 500k assignments/year, 2,000 concurrent users at peak, queue load p95 under 800ms, control tower under 2s, SLA monitor sweep under 60s.

1. **No TAT recalculation on read.** `sla_due_at`, `sla_consumed_pct`, `sla_status`, `priority_bucket` and `priority_score` are materialised columns. Reads are index scans with no arithmetic over history.
2. **Bounded recompute set.** The 5-minute tick job processes only `WHERE next_recompute_at <= now() AND current_state NOT IN ('CLOSED','CANCELLED')`, and sets `next_recompute_at` adaptively: 1 minute when within 10% of due, 5 minutes when at risk, 30 minutes when comfortably on track. On a 500k/year book with roughly 8k open items, each sweep touches hundreds of rows, not millions.
3. **Queue-shaped covering indexes** per Section 14.2. Every queue query must be satisfiable by one index; any query plan showing a sequential scan on `assignment` fails the build gate.
4. **Keyset pagination** (`WHERE (priority_score, assignment_id) < (:last_score, :last_id)`) rather than OFFSET, which degrades badly past page 20.
5. **Partitioning.** `assignment_event`, `sla_clock_segment`, `audit_log` and `notification_outbox` range-partitioned by month, with automated partition creation and detachment to cold storage.
6. **Separation of reads.** Control tower and exports run against a read replica or the summary table. Operational writes are never blocked by a manager running a 12-month export.
7. **Caching.** Masters (clients, locations, verification types, TAT rules, escalation matrix, taxonomy, calendars) are cached in application memory with a version-stamp invalidation channel. Rule resolution therefore does not touch the database at all.
8. **Single-writer background jobs** under advisory locks, with sharding by `assignment_id % N` for horizontal scale.
9. **Event processing** is asynchronous for everything non-critical (notifications, summary refresh, analytics). Synchronous only for state transition, SLA segment writes and constraint enforcement.
10. **Archival.** Assignments closed more than 12 months ago move to archive partitions with the same schema, so historic queries work unchanged but never touch hot pages.

**Anti-pattern explicitly prohibited in this design:** computing SLA status by scanning `assignment_event` or `sla_clock_segment` during a page load. The ledger is the evidence, the materialised column is the operational value, and they are reconciled by a nightly consistency job that reports any drift.

---

# 21. SECURITY DESIGN

| Vector | Control |
|---|---|
| Row-level visibility | Mandatory scope predicate injected at the repository layer; no query may execute against `assignment` without a scope filter. Enforced by a unit test that fails the build on violation. |
| Role-based access | Permission checked server-side on every action. UI hiding is cosmetic only. |
| Hierarchy restrictions | `org_unit_closure` join; hierarchy changes propagate on next refresh with an audited effective date. |
| Location restrictions | `user_location_assignment` with validity dates; historic records remain visible via the assignment's snapshotted location, not the user's current one. |
| Temporary access | Distinct principal type, no role bindings, single-assignment scope, OTP to master-record mobile, server-side expiry, per-request scope enforcement (Section 17.4). |
| Attachment security | Object storage with private ACL, time-limited signed URLs (5 min) issued only after a permission check, content hash stored, virus scan before availability, no direct object keys exposed to the client. |
| Audit protection | No UPDATE/DELETE grants on audit and event tables; hash chaining; separate audit-config permission holder; WORM storage. |
| Impersonation | Support impersonation requires Ops Head approval, is time-boxed, is banner-visible to the impersonator, and writes `acting_as_user_id` on every event. Impersonated users cannot perform SLA override, strike waiver or config changes. |
| Unauthorised reassignment | Reassignment permitted only within scope, reason mandatory, both locations notified, SLA continuity rules applied (Section 22), fully audited. |
| Unauthorised SLA override | Two-person rule: Admin executes, Ops Head approves. Daily override report. Never available from an operator screen. |
| Unauthorised closure | Closure permitted only to the assignor or their chain, only from `UNDER_REVIEW`, only with all tasks complete and no open requests. |
| Data export | Role-gated, row-limited, PII-masked below Branch Manager, watermarked with the requester's identity, logged with row counts, and rate-limited. Bulk export of contact numbers requires Ops Head approval. |
| Injection / API abuse | Parameterised queries, per-user rate limits, request signing for integrations, idempotency keys on all mutating endpoints. |
| Session | Short-lived access token, refresh rotation, forced re-auth for privileged actions (override, waiver, config, export). |

---

# 22. EXCEPTION HANDLING & 23. FAILURE / RESILIENCE

Format: **Detection → Fallback → Recovery → Audit → Notification → Owner.**

| # | Failure mode | Detection | Fallback | Recovery | Audit | Notify | Owner |
|---|---|---|---|---|---|---|---|
| 1 | Duplicate click | `request_uuid` unique constraint | Return original result, no second record | None needed | `DUPLICATE_SUBMIT_SUPPRESSED` | Silent | Platform |
| 2 | Duplicate submission (retry/API) | Idempotency key on endpoint | Idempotent response | None | Event with correlation ID | Silent | Platform |
| 3 | Two users act simultaneously | Optimistic locking on `assignment.version` | Second write rejected with "state changed, refresh" | User re-reads current state | Both attempts logged; loser as `TRANSITION_CONFLICT` | Loser sees inline message | Platform |
| 4 | Notification failure | Outbox status + provider callback | In-app queue remains authoritative; alternate recipient for decision items | Retry ladder, then manual resend | `NOTIFICATION_FAILED` | Admin alert, manager for decision items | Platform |
| 5 | Email provider outage | Consecutive failure threshold | Suspend decision sub-SLAs for the outage window | Bulk resend after restoration; SLA credit applied via `SYSTEM_OUTAGE` segments | Outage window recorded and linked to affected assignments | Ops Head + all managers | IT |
| 6 | External integration failure (Force1) | Circuit breaker, health probe | Manual entry of case data permitted with `manual_entry_flag`; case reference validated later | Reconciliation job matches manual entries to Force1 | `INTEGRATION_FALLBACK_USED` | Admin | IT |
| 7 | Database outage | Health check, connection failures | Read-only degraded mode where possible; write queue rejected cleanly rather than partially | Post-restore consistency job; SLA clocks credited for the window | Outage segments appended to affected SLA instances | All users banner + Ops Head | IT |
| 8 | Application restart mid-transaction | Transactional boundaries; outbox | Uncommitted work rolls back cleanly; no half-states possible | Outbox dispatcher resumes | Nothing lost, correlation preserved | Silent | Platform |
| 9 | Delayed background job | Job heartbeat with expected-run monitor | On late run, timestamps are computed from `occurred_at`, never from job run time | Catch-up processing in order; idempotency prevents duplicates | `JOB_LATE` with lag; escalations dated correctly | Admin if lag > 15 min | Platform |
| 10 | Incorrect assignment (wrong location/case) | Assignee raises "Incorrect Assignment" | Returns to assignor as a reassignment request, not a rejection | Assignor corrects and reassigns | Full trail; original SLA closed with `ASSIGNOR` attribution | Both parties | Assignor TL |
| 11 | Employee transfer | Hierarchy/location effective-dated change | Open items remain with the individual for 3 days, then auto-return to the location queue | TL reallocates | `USER_TRANSFERRED`, historical location snapshot preserved | TL both locations | HR/Admin |
| 12 | Employee exit | User status = inactive | All open items immediately return to the location queue; strikes stay attached to the historical identity | TL reallocates within acceptance SLA | `USER_DEACTIVATED_REALLOCATION` | TL + Branch Manager | HR/Admin |
| 13 | Hierarchy change | Closure table refresh with effective date | Visibility recalculated forward only; historic access is not retroactively granted or removed | Refresh job | `HIERARCHY_CHANGED` with before/after | Affected managers | Admin |
| 14 | Unavailable escalation manager | Status + delegation check at resolve time | Delegate → manager → next level | Substitution recorded | `ESCALATION_TARGET_SUBSTITUTED` | Substitute + original | Admin |
| 15 | Missing escalation matrix | Resolver returns no match | Org-hierarchy fallback (Section 10.2) | Admin configures; alert clears | `ESCALATION_FALLBACK_USED` + `CONFIG_GAP` | Admin + Ops Head | Admin |
| 16 | TAT rule changed after assignment | Snapshot immutability | Live assignments keep their snapshot | Optional Admin recalculation, per-assignment, reasoned, versioned | `SLA_RULE_VERSIONED`; recalcs individually audited | Affected parties only if recalculated | Ops Head |
| 17 | Reopened record | Privileged reopen | New SLA cycle, `breach_cycle_no`++ | Normal flow resumes | `ASSIGNMENT_REOPENED` with reason and approver | Both parties | Ops Head |
| 18 | Attachment missing / upload failed | Post-upload verification against object storage + hash | Submission blocked with a clear message; draft preserved so nothing is re-keyed | Resume upload; chunked upload for poor connectivity | `ATTACHMENT_UPLOAD_FAILED` | User inline | Platform |
| 19 | Partial submission | Draft autosave every 30s | Draft preserved with all entered data | User resumes from draft | `DRAFT_SAVED` | Silent | Platform |
| 20 | Clock drift between servers | NTP monitoring | All timestamps from the database server, never the application server or client | Alert on drift > 1s | Drift logged | IT | IT |
| 21 | Bulk breach storm after outage | Breach count per minute threshold | Auto-suppress escalation and strikes above threshold pending Admin review | Admin applies outage attribution in bulk | Every suppression recorded | Ops Head immediately | Admin |
| 22 | Client master change (client merged/renamed) | Master change hook | Existing assignments keep the snapshotted client reference | Mapping table for reporting continuity | `MASTER_REMAPPED` | MIS | Admin |

**Failure mode 21 deserves emphasis.** Without it, a two-hour outage produces several hundred simultaneous breaches, several hundred escalations to the Ops Head, and a wave of unjustified strikes. That single event is capable of destroying trust in the system permanently, and a threshold-based circuit breaker costs very little to build.

---

# 24. FMEA

Severity, Occurrence and Detection on 1–10 (10 worst). RPN = S × O × D. Sorted by RPN descending.

| # | Failure mode | Cause | Effect | Current control | S | O | D | RPN | Proposed control | Residual |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Delay auto-accepted with no review, SLA silently extended | 1-hour timer with no accountability | SLA becomes meaningless; strikes unenforceable; gaming normalised | None in brief | 9 | 9 | 8 | **648** | `AUTO_ACCEPTED` distinct outcome, `PENDING_REVIEW` attribution, cap on extension, one per assignment, assignor KPI, manager notified | 72 |
| F2 | RFI used as a stalling device late in the TAT | Unconditional clock pause | Breaches disappear; assignor blamed for assignee delay | None in brief | 9 | 8 | 8 | **576** | 50% good-faith window, 2h cap, max 2 pause-eligible, reject-as-invalid path, assignee quality KPI | 64 |
| F3 | Strike raised for time the assignee did not control | "Every breach feeds 3-strike" | Unjust disciplinary action; system rejected by staff | None | 10 | 8 | 6 | **480** | Attribution ledger; strike only on attributable assignee time above grace; waiver with approver | 60 |
| F4 | Wall-clock TAT across nights/holidays generates fake breaches | Undefined clock type | Mass false breaches in week 1; credibility collapse | None | 9 | 9 | 5 | **405** | `clock_type` per rule, business calendar per location, default 24 business hours | 54 |
| F5 | Duplicate strikes from job retries or restarts | Non-idempotent strike generation | Wrongful third strike | None | 10 | 6 | 6 | **360** | Unique (assignment, breach_cycle, trigger), idempotency key, single-writer lock | 40 |
| F6 | Report claimed shared via WhatsApp, unprovable | No evidence requirement | Disputes unresolvable; SLA credit for work not delivered | Free-text only | 8 | 8 | 5 | **320** | Mandatory evidence per channel; target state = report in system | 48 |
| F7 | Temporary participant sees full operational data | Temp access granted as a role | Data breach; PII exposure | Not designed | 10 | 5 | 6 | **300** | Distinct principal type, no role bindings, single-assignment repository scope, OTP, expiry | 30 |
| F8 | Duplicate active assignment on same case+point | UI-only check | Duplicate field work, duplicate cost, conflicting reports | Warning only | 7 | 7 | 6 | **294** | Partial unique index at DB, idempotent submit, tiered warn+override with audit | 42 |
| F9 | Dispute loop keeps a case in permanent rework | Unlimited disputes | Assignee harassed; case never closes; strikes accumulate | None | 8 | 6 | 6 | **288** | 2-dispute cap, arbitration, outcome classification, assignor KPI | 48 |
| F10 | Dashboard recomputes TAT from history | Naive implementation | Timeouts at scale; unusable at 10× volume | None | 7 | 8 | 5 | **280** | Materialised columns, bounded tick job, queue indexes, summary table | 42 |
| F11 | Escalation not sent because matrix missing for location | Client-wide matrix only | Breach invisible to management | None | 8 | 7 | 5 | **280** | Specificity resolution + org-hierarchy fallback + CONFIG_GAP alert | 40 |
| F12 | Applicant data re-keyed per assignment, drifts apart | Flat assignment table | Contradictory records; verification against wrong address | None | 8 | 7 | 4 | **224** | Case → party → requirement → assignment model; no copying | 32 |
| F13 | Poor upstream data causes systemic RFIs | No feedback loop to the assignor | Chronic delay blamed on assignee | None | 7 | 8 | 4 | **224** | Data completeness score at creation, RFI rate KPI by assignor team | 42 |
| F14 | Escalation to a manager who has exited | Static matrix | Escalation into a void | None | 8 | 5 | 5 | **200** | Status + delegation resolution with substitution audit | 32 |
| F15 | Outage produces a breach and escalation storm | No circuit breaker | Hundreds of false escalations and strikes | None | 9 | 4 | 5 | **180** | Threshold suppression, bulk outage attribution, Ops Head alert | 27 |
| F16 | Report back-dated to escape breach | Free date/time entry | SLA evasion | None | 7 | 6 | 4 | **168** | Range validation, discrepancy flag vs submission time, flagged-rate KPI | 28 |
| F17 | Two users act on the same case simultaneously | No concurrency control | Lost update; contradictory state | None | 7 | 6 | 4 | **168** | Optimistic locking, single transition service, clear conflict message | 24 |
| F18 | Person created twice in the people master | Free-text invite | Broken hierarchy reporting; duplicate strikes | None | 6 | 7 | 4 | **168** | Deterministic + fuzzy match before create, unverified flag, Admin review | 28 |
| F19 | Employee transfers with open work | No handling | Work orphaned; SLA breaches with no owner | None | 7 | 5 | 4 | **140** | Auto-return to location queue after 3 days; historic snapshot preserved | 24 |
| F20 | Duplicate override becomes routine | Warning with no measurement | Control decays to a click-through | None | 6 | 6 | 4 | **144** | Permission-gated, reason mandatory, override-rate KPI by user | 24 |
| F21 | Notification failure blamed for missed SLA | Email-first design | SLA arguments; unenforceable targets | None | 6 | 6 | 4 | **144** | In-app queue authoritative; sub-SLA suspension for decision items only | 24 |
| F22 | TAT rule change alters live SLAs retroactively | Live rule lookup | Cases breach retrospectively | None | 8 | 4 | 4 | **128** | Snapshot immutability; reasoned recalculation only | 16 |
| F23 | Assignor closes a case without reading the report | Single-click accept | Quality failure passes through | None | 6 | 7 | 3 | **126** | Report open required before accept enabled; review dwell-time KPI | 28 |
| F24 | Admin alters SLA and suppresses the trace | Combined config + audit permission | Undetectable manipulation | None | 9 | 2 | 6 | **108** | Split permissions, append-only grants, hash chaining, daily override report | 18 |

**Priority for build:** F1 through F8 are non-negotiable in phase 1. F9 through F15 in phase 1 or early phase 2. The rest are hardening.

---

# 25. MEASURE & ANALYSE SUMMARY

### 25.1 CTQs (Critical to Quality)

| CTQ | Customer of the CTQ | Specification | Measured by |
|---|---|---|---|
| Verification report delivered within committed TAT | Client, originating location | ≥ 95% attributable compliance | TAT compliance % |
| Report is correct first time | Assignor, client | ≥ 90% first-time-right | FTR % |
| Assignment instructions are complete and actionable | Assignee | RFI rate ≤ 5% | RFI rate by assignor team |
| SLA outcomes are attributable and defensible | Assignee, HR, management | 100% of strikes traceable to attributable minutes | Strike audit sampling |
| Breaches are visible to the right manager without human action | Management | 100% automatic escalation, 0 config gaps | Escalation coverage |
| An operator can act without an SOP | Executive | ≤ 3 clicks to the correct action, ≤ 2 min training per action | Usability test |
| Queue reflects true urgency | All | Top 10 rows contain the 10 most urgent items | Priority precision check |
| No duplicate field work | Operations, finance | 0 duplicate active assignments | Duplicate index violations = 0 |
| History cannot be altered | Audit, compliance | 0 update/delete grants on evidence tables | Grant audit |

### 25.2 VOC / VOE (design assumptions to validate in UAT)
- **Voice of the Assignee:** "I get assignments with wrong addresses and no landmark, then I get blamed for the delay." → Data completeness score, RFI attribution, RFI rate KPI on the assignor.
- **Voice of the Assignor:** "I don't know a case is stuck until the client calls." → Pre-breach nudges, Queue D, at-risk digest.
- **Voice of the Team Leader:** "I can't see my team's load in one place." → Queue B with grouping and the team control tower slice.
- **Voice of the Ops Head:** "Escalations arrive too late and too many at once." → Level progression, digesting, config-gap reporting, storm suppression.
- **Voice of the Executive:** "I don't want a 50-page SOP." → Three actions maximum per state, guided forms, defaults.

### 25.3 Bottlenecks identified
1. **Assignor review after completion.** Unbounded in the original design. Now a 4-business-hour sub-SLA with its own escalation. This is the largest hidden queue in most Ops-to-Ops processes.
2. **Intake allocation at the receiving location.** Between routing and acceptance nobody owns the clock. Now covered by the acceptance SLA and the UNACTIONED bucket.
3. **Data quality at creation.** The upstream cause of RFIs, delays and disputes. Now measured and fed back.
4. **Manual escalation.** Removed entirely from the critical path.
5. **Attachment upload on poor connectivity.** Chunked upload plus draft preservation.

### 25.4 Automation opportunities (build-ready, phase 2+)
- Auto-creation of assignments from Force1 case events through an API, removing manual data entry and most data-quality defects.
- Auto-population of address and Maps link from pincode and geocoding.
- Auto-suggestion of the target location by pincode-to-location mapping.
- Auto-classification of delay reasons from historic patterns to pre-fill attribution.
- Predictive at-risk scoring (which assignments will breach, based on location load, time of day, verification type) to drive pre-emptive reallocation.
- Auto-extraction of report data from the uploaded document to prefill findings.

### 25.5 Loopholes closed (consolidated)
Late RFI to buy time (C4) · delay reported at end of day for silent auto-accept (C3) · unlimited disputes to reset attention (C2) · back-dated report share time (F16) · self-assignment or own-location assignment (C5) · duplicate assignment on the same point (Section 15) · temp participant privilege escalation (Section 17.4) · duplicate strikes from retries (Section 11.3) · Admin altering an SLA and suppressing the trace (Conflict 4) · strikes surviving a not-upheld dispute (Section 9) · escalation into an empty mailbox (Section 10.2) · TAT rule edits changing live SLAs (Section 6.2).

---

# 26. IMPLEMENTATION DEPENDENCIES

**Confirm before schema freeze (the eight open items):**
1. Interface contract of the existing escalation engine (table, service or event) and whether it supports an idempotency key.
2. Interface contract of the existing 3-strike engine, its rolling window definition, and whether it already stores strike events or only counters.
3. Structure of the existing organisation hierarchy: adjacency list, closure table, or denormalised levels.
4. Whether the user master already carries location assignment with validity dates, and whether a delegation/out-of-office concept exists.
5. Existing notification service capabilities: channels, templates, delivery callbacks, retry.
6. Existing audit facility: coverage, immutability guarantees, retention.
7. Force1 integration mode: API, file, or manual entry only, and whether Point IDs are retrievable at case level.
8. Database platform, version and partitioning support; whether read replicas exist.

**Sequenced build order.**
- **Phase 0 (foundation):** masters and calendars, `org_unit_closure`, reason taxonomy, TAT rule engine with resolution tests, event store and audit grants.
- **Phase 1 (core loop):** case/party/requirement model, assignment + tasks, state machine, SLA instance and clock segments, four queues, completion with evidence, duplicate prevention, audit timeline. This alone is a usable system.
- **Phase 2 (control):** RFI, delay with attribution and caps, dispute and rework, escalation adapter, strike adapter, pre-breach nudges, notification outbox.
- **Phase 3 (management):** control tower, summary table, KPIs, exports, storm suppression, bulk outage attribution.
- **Phase 4 (extension):** temporary participant access, split-location assignment on the same case, Force1 API automation, mobile optimisation.

Phase 1 and 2 together deliver the full business intent. Phase 3 makes it manageable. Phase 4 makes it strategic.

---

# 27. TESTING STRATEGY

**Unit.** Business calendar arithmetic (year boundaries, holidays, shift edges, DST). TAT specificity resolution with a fixture matrix of at least 40 rule combinations including ties. Priority score computation. Attribution derivation from every reason code.

**Contract.** Escalation and strike adapters tested against a stub for idempotency, duplicate suppression and fallback paths.

**State machine.** Exhaustive test over the transition table: every legal transition succeeds for the correct role and fails for every incorrect role; every illegal transition is rejected and logged. This is generated from the transition table, so it cannot drift from the implementation.

**Concurrency.** Two clients submitting the same creation form; two users accepting the same assignment; delay accept racing auto-accept at the 1-hour boundary; dispute racing closure; job retry during breach processing. Each must produce exactly one outcome and one event.

**SLA correctness.** Property-based test asserting that for any sequence of events, `SUM(segment business_minutes WHERE counts_toward_sla)` equals the materialised `sla_consumed`, and that exactly one segment is open at any time.

**Security.** Per-role access matrix test for every endpoint. Temp participant attempting to access any other assignment, any list endpoint, any export, and an expired grant. Attachment URL reuse after expiry. Scope-predicate omission test that fails the build.

**Performance.** Seeded database of 2 million assignments and 25 million events. Queue p95 under 800ms, control tower under 2s, tick sweep under 60s, no sequential scan on `assignment` in any queue plan.

**Data integrity.** Nightly reconciliation between the ledger and materialised columns must report zero drift. Duplicate index violation count must be zero.

**UAT.** Real operators from two locations run the 18 verification scenarios in Section 31 end to end, plus a blind usability test in which an executive who has never seen the system completes an assignment with no documentation.

---

# 28. MIGRATION CONSIDERATIONS

1. **Do not migrate open work into a half-built model.** Cut over by cohort: new assignments in the new system from day one, legacy items completed in the legacy path, with a combined read-only view for managers during the overlap.
2. **People first.** Run identity de-duplication on the people master before go-live. Migrating duplicate identities into a hierarchy-driven visibility model produces access defects that are extremely hard to trace afterwards.
3. **Backfill masters, not transactions.** Clients, locations, branches, verification types, calendars, TAT rules and the escalation matrix must be complete and reviewed before the first assignment. Run the escalation resolver in report-only mode across every client × location × level combination and fix every gap before go-live.
4. **Historic cases** load as `case` + `case_party` + `case_verification_requirement` with `case_status = 'HISTORIC'` and no SLA instances. Historic assignments load in `CLOSED` state with a synthetic `MIGRATED` event, and are excluded from KPI baselines for the first reporting period, clearly flagged.
5. **Strike history** migrates as `strike_event` rows with `source = 'MIGRATED'` so the rolling window is correct from day one. Getting this wrong either wipes accountability or triggers immediate third strikes.
6. **Parallel run** for two weeks on TAT calculation only: compute the new SLA outcome alongside the legacy one and reconcile differences before enforcement. Enforce strikes only after the parallel run passes.
7. **Rollback plan.** Feature flag per phase, per location. New assignment creation can be disabled without affecting in-flight work.
8. **Do not backfill attribution.** Legacy breaches have no ledger, so they cannot support strikes under the new rules. Mark them `attribution = UNKNOWN` and exclude them from strike eligibility rather than guessing.

---

# 29. ACCEPTANCE CRITERIA

The build is accepted when all of the following are demonstrably true.

**Functional**
1. All 18 verification scenarios in Section 31 pass end to end with the stated state, SLA, notification, audit, RACI and escalation outcomes.
2. Every state transition is executed only through the transition service; illegal transitions are rejected and logged.
3. TAT resolution returns the identical rule for identical inputs across 40 fixture cases, and the resolution trace is stored on every SLA instance.
4. No assignment can be created without at least one verification and a Point ID for each selected verification.
5. Two active assignments on the same case + point are impossible, verified by direct concurrent database insert attempts.
6. Completion is impossible without evidence for every non-system channel.
7. A dispute preserves the original completion record and the original SLA instance, both retrievable.
8. Auto-accepted delays produce `PENDING_REVIEW` attribution and appear in the assignor's confirmation tray.

**Control**
9. No strike is generated where attributable assignee minutes do not exceed TAT plus grace, proven on a sample of 100 breaches.
10. No duplicate strike exists for any `(assignment, breach_cycle, trigger)`, proven by constraint plus query.
11. Escalation succeeds for every client × location × level combination, including the fallback path with an alert.
12. Zero UPDATE or DELETE grants on `assignment_event`, `audit_log`, `sla_clock_segment`, `strike_event`, `assignment_completion`.
13. Every event carries actor, timestamp, action, previous state, new state, reason where applicable, source channel and correlation ID.

**Security**
14. A temporary participant token cannot retrieve any record outside its assignment, cannot reach any list or export endpoint, and stops working at expiry, proven by penetration test.
15. Every queue and detail endpoint enforces scope server-side; the scope-predicate test suite passes.
16. Privileged actions require re-authentication and appear on the daily privileged-action report.

**Performance**
17. Queue p95 under 800ms and control tower under 2s at 2 million assignments and 25 million events.
18. No query plan for any queue performs a sequential scan on `assignment`.
19. Nightly ledger-to-materialised reconciliation reports zero drift for 14 consecutive days.

**Usability**
20. An executive with no training and no SOP completes assignment creation, acceptance, RFI, delay report and completion without assistance, in a blind test with at least five participants.
21. Every screen exposes only the actions legal in the current state for the current role.

---

# 30. SIMPLICITY GUARANTEE (WHAT THE USER ACTUALLY SEES)

| Role | Screens they ever touch | Actions available at any moment | Mandatory fields |
|---|---|---|---|
| Executive (assignor) | Queue A, Queue D, Create form, Case timeline | Create, Respond to RFI, Review delay, Accept, Dispute | 9 at creation |
| Executive (assignee) | Queue C, Queue D, Case detail | Accept, Complete, Request details, Report delay | 3–5 per action |
| Team Leader | Queues A–D, Allocation view, Team slice | Above plus Allocate, Reassign, Override duplicate | Same |
| Branch Manager+ | Control tower, drill-through | Above plus Arbitrate, Waive strike, Approve exceptions | Reason codes only |
| Admin | Config screens | TAT rules, matrix, taxonomy, calendars, grants | Effective dates |

**Three rules enforced in the UI:** never show a button the user cannot legally press; never ask for information the system already holds; never require the user to remember a deadline the system can track. Everything else in this document is machinery the operator never sees.

---

# 31. DESIGN VERIFICATION — 18 SCENARIOS

Format per scenario: **State → User action → System action → SLA impact → Notification → Audit → RACI → Escalation.**

**S1 — Normal assignment.**
`SUBMITTED` → assignor submits a valid form → duplicate check clean, TAT resolved (Client + Resident Verification + 1 point → 24 business hours, rule 118 snapshotted), SLA instance opened, segment 1 opens `RUNNING/ASSIGNEE`, state `ASSIGNED` → clock starts at business-calendar time → target location queue notified in-app and by email; assignor sees confirmation → `ASSIGNMENT_CREATED`, `ASSIGNMENT_ROUTED`, `SLA_STARTED` → R: assignor, A: assignor TL, I: assignee TL → none. TL allocates, executive accepts within 30 min, completes at hour 19 with evidence, state `COMPLETED` → `UNDER_REVIEW`, assignor accepts within the 4-hour review SLA, state `CLOSED`. Total events: 9. No escalation, no strike.

**S2 — Assignee requests more information.**
`IN_PROGRESS` at 3 hours consumed (12.5%) → assignee raises RFI "Address incomplete" → eligibility passes (consumed ≤ 50%, first RFI); state `AWAITING_INFORMATION`; request row with 2-hour sub-TAT; segment 1 closes at 180 min `ASSIGNEE`, segment 2 opens `PAUSED/ASSIGNOR` → parent clock paused, cap 120 min → assignor and assignor TL notified, badge in Queue D at bucket 700 → `RFI_RAISED` → R: assignee, A: assignee TL, I: assignor TL → none. Assignor responds in 45 min, corrects the address (audited before/after on `case_party`), segment 2 closes at 45 min `ASSIGNOR/not counted`, segment 3 opens `RUNNING/ASSIGNEE`, state `IN_PROGRESS`. Effective TAT consumed remains 180 min. Assignor's RFI-rate KPI increments.

**S2b — Late RFI (the closed loophole).** Same request raised at 20 of 24 hours (83%). RFI is accepted and routed, but `pause_eligible = false`; the assignee is told this before submitting. Clock keeps running. Assignor still answers within 2 hours. If the assignee breaches, the breach is attributable and a strike is generated.

**S3 — Delay reported, assignor accepts.**
`IN_PROGRESS` at 18 hours → assignee reports delay, category "Customer unavailable at address", expected completion +6 hours, remarks and photo evidence → state `DELAY_REVIEW`, request with 1-hour review sub-TAT → clock continues running pending decision → assignor notified, Queue D bucket 700 → `DELAY_REPORTED` → R: assignee, A: assignee TL, C: assignee TL, I: assignor → none. Assignor accepts in 20 min: `sla_due_at` extended by 6 hours (within the cap of 1.5 × TAT), segment closes and a new segment opens with attribution `CUSTOMER` (not counted to SLA or strike), state `IN_PROGRESS`. Events: `DELAY_ACCEPTED`, `SLA_EXTENDED`, `ATTRIBUTION_APPLIED`. The client's data/access-quality KPI increments, which is where this delay genuinely belongs.

**S4 — Assignor ignores the delay for one hour.**
Same as S3 to the point of review. At 60 minutes the sub-SLA monitor resolves the request as `AUTO_ACCEPTED` → extension applied but capped at `min(expected completion, 50% of TAT, 12 business hours)`; new segment attribution `PENDING_REVIEW` (counts to SLA, does not count to strike); `auto_accept_used = true` so a second delay cannot self-approve → notification to assignee (extension granted), assignor (action was taken on your behalf) and **assignor's manager** (digest) → `DELAY_AUTO_ACCEPTED`, `ATTRIBUTION_PENDING_REVIEW` → R: system, A: assignor (still accountable), I: assignor's manager → no escalation level raised, but the item appears in the assignor's "Confirm Attribution" tray and on the auto-accept-rate KPI. When the assignor confirms next morning, attribution resolves to `CUSTOMER` or `ASSIGNEE` and strike eligibility recalculates for that cycle.

**S5 — Assignor denies the delay.**
`DELAY_REVIEW` → assignor selects Deny with mandatory reason "Address is complete, customer contacted successfully last week" → no extension, no attribution change, state returns to `IN_PROGRESS` on the original clock → assignee and assignee TL notified with the reason → `DELAY_DENIED` → R: assignor, A: assignor TL, I: assignee TL → none. The denied delay counts on the assignee's quality KPI. If the assignee subsequently breaches, the breach is fully attributable and a strike follows.

**S6 — Assignee misses the SLA.**
`IN_PROGRESS`, no open requests, attributable minutes reach 24 business hours → tick job sets `sla_status = 'BREACHED'`, `priority_bucket = 'BREACHED_OPEN'`, `priority_score` ≈ 1000+, state **unchanged** (still `IN_PROGRESS`, so the operator still knows what to do) → escalation adapter called with idempotency key, level 1, matrix resolved on client + location + level → assignee TL and assignor notified; case jumps to the top of every relevant queue → `SLA_BREACHED`, `ESCALATION_RAISED` → R: assignee, A: assignee TL, I: assignor, Branch Manager on digest → strike eligibility evaluated: attributable assignee minutes (24h) exceed TAT + 15 min grace, no assignor RFI breach, no outage → `strike_event` inserted with `UNIQUE(assignment, cycle 0, SLA_BREACH)`, strike number 2 of 3 in the rolling 90-day window for this executive. At breach + 12 hours, level 2 fires to both Branch Managers.

**S7 — Assignee completes, assignor disputes.**
`UNDER_REVIEW` → assignor opens the report (required before Accept enables), selects Dispute, reason "Evidence missing/illegible", attaches an annotated screenshot → state `REWORK`; `breach_cycle_no` 0 → 1; `priority_override = 'P1'`; **new** SLA instance created with 2 business hours on the assignee location calendar; original SLA instance and original `assignment_completion` row untouched, the completion marked `superseded_by` on rework submission → new corrective clock starts; the original clock is already stopped and its history is intact → assignee, assignee TL and the assignor's own manager notified → `DISPUTE_RAISED`, `SLA_CYCLE_OPENED` → R: assignor, A: assignor Branch Manager, I: assignee TL and assignor's manager → none yet. Assignee resubmits in 90 minutes; assignor accepts and must classify the dispute. Classified `UPHELD` → closed, assignee quality KPI hit. Classified `NOT_UPHELD` → closed, assignor quality KPI hit and any strike from cycle 1 is waived via `STRIKE_WAIVED`. A third dispute attempt on the same assignment is blocked and opens `ARBITRATION`.

**S8 — Assignment escalated (manual).**
`AWAITING_INFORMATION`, RFI sub-TAT breached at 2 hours with no assignor response → assignee presses Escalate (or the monitor does it automatically at the sub-TAT breach) → escalation adapter called for the **assignor's** hierarchy, since the failure is on that side; parent clock remains paused up to the 120-minute cap, then resumes with `ASSIGNEE` attribution but with `assignor_rfi_breach = true` set permanently → assignor's TL notified, then Branch Manager at the next level → `ESCALATION_RAISED`, `RFI_SUB_SLA_BREACHED` → R: assignee, A: assignee TL, I: assignor chain → escalation level 1 on the assignor side. Critically, if this assignment later breaches, the `assignor_rfi_breach` flag suppresses strike generation for the assignee. The person who caused the delay is the person the system pursues.

**S9 — Third strike generated.**
Breach occurs as in S6. Strike eligibility passes. `strike_event` inserted, and the strike engine adapter reports this is strike 3 within the rolling window for this individual → the existing 3-strike consequence process is invoked through the adapter; no parallel logic is built here → escalation level forced to 3 (Zonal Manager) with the full case pack; the individual's TL, Branch Manager, Zonal Manager and the HR interface are notified → `STRIKE_GENERATED` with strike number 3, attributable minutes, escalation level, SLA instance and breach cycle → R: system, A: Branch Manager, C: assignee TL, I: Zonal Manager, Ops Head, HR → the strike carries a waiver path requiring Branch Manager or above with a mandatory reason, and the waiver is itself reported. Because the strike cites the clock-segment ledger, the individual can be shown exactly which minutes were counted and why.

**S10 — Duplicate assignment attempted.**
Assignor creates an assignment for Force1 case FC-88210, Point ID P-4471, which already has an active assignment at another location → Tier 1: the partial unique index on `assignment_task(requirement_id)` blocks it; the application pre-check shows the message first, with a link to the existing assignment, its location, state and SLA → creation blocked, no SLA instance, no orphan rows → no notification to the other location (nothing happened) → `ASSIGNMENT_DUPLICATE_BLOCKED` with the attempted key → R: assignor, A: assignor TL → none. Variant: the previous assignment closed 3 days ago. Tier 2 fires a soft warning instead; the assignor with `OVERRIDE_DUPLICATE` selects a reason ("Client requested re-verification"), the assignment is created, `duplicate_override` is written and the override appears on the override-rate KPI. Variant: double-click. Tier 3 idempotency returns the original assignment with no second record.

**S11 — Person exists in the database but is not a current application user.**
Assignor needs a field colleague to upload evidence → invites by mobile number → identity resolution finds an exact mobile match in the people master → **the existing `person_id` is used; no new person record is created** → a `temp_participant_grant` is issued for this assignment only, permitted actions `{VIEW_ASSIGNMENT_SUMMARY, UPLOAD_EVIDENCE}`, 24-hour expiry, OTP to the mobile **on the master record**, approved by the assignee Branch Manager → no SLA impact → the invitee receives a link, the approver and the assignee TL are notified → `TEMP_GRANT_ISSUED`, then `TEMP_GRANT_USED` on each access, with `actor_type = 'TEMP_PARTICIPANT'` on any resulting event → R: invitee, A: assignee Branch Manager, I: Admin security log → none. The participant sees one screen for one assignment. Any attempt to reach a list, another assignment, or an export returns 403 and raises a security event.

**S12 — Person does not exist as an application user at all.**
Same flow, except identity resolution returns no deterministic match. Fuzzy candidates on name plus location are shown. The inviter confirms "none of these" → a new person record is created with `unverified_identity = true` and queued for Admin review, then the same grant model applies → the new record cannot be granted a role by this path under any circumstance; only Admin can promote a person to an application user, and that is a separate, audited action → `PERSON_CREATED_UNVERIFIED`, `TEMP_GRANT_ISSUED` → R: inviter, A: approver, C: Admin, I: security. This is the boundary that prevents the invite path from becoming a back door for account creation.

**S13 — Manager views the team queue.**
Team Leader opens Queue B → the closure-table join returns assignments created by every org unit at or below the TL, ordered by `priority_score DESC, sla_due_at ASC`, grouped by location or client on request → single index scan, keyset pagination, no TAT recomputation, p95 under 800ms at 2M rows → no state change, no SLA impact, no notification → `QUEUE_VIEWED` is not written (view events would swamp the event store); export **is** audited → R: TL, A: Branch Manager → none. A Zonal Manager sees the same structure one level wider. An Executive sees no Queue B at all.

**S14 — Employee changes location.**
HR updates the user's location with an effective date → the closure and location-assignment refresh runs → open assignments allocated to that individual remain with them for 3 business days (so in-flight fieldwork is not orphaned), then automatically return to the **original** location queue with `UNACTIONED` priority → SLA clocks continue uninterrupted; the transfer is not a valid reason to reset a clock → both TLs notified at the point of auto-return → `USER_TRANSFERRED`, `ASSIGNMENT_RETURNED_TO_QUEUE` → R: receiving TL, A: Branch Manager, I: both TLs → none unless the acceptance SLA is then missed. Historic assignments retain the snapshotted location, so past strikes and past performance stay with the location where the work actually happened and do not follow the individual into the new team's numbers.

**S15 — Escalation matrix missing for a location.**
Breach occurs; the resolver finds no matrix for client C + location L + level 1 → fallback walks the org hierarchy of the assignee location: Team Leader for level 1, Branch Manager for level 2, and so on → the escalation is delivered on time, so the case never stalls → the resolved fallback target is notified normally; **additionally** Admin and the Ops Head receive a `CONFIG_GAP` alert naming the exact missing key → `ESCALATION_FALLBACK_USED` on the assignment plus a config-gap record → R: system, A: Admin, I: Ops Head → escalation proceeds at the correct level. Config-gap count is a control tower KPI, so a missing matrix is visible within minutes rather than discovered during an audit.

**S16 — Two users act simultaneously.**
Assignee presses Complete at the same moment the assignor presses Dispute on a stale screen, or two executives both press Accept → both requests carry the `assignment.version` they read → the transition service processes them serially; the first commits and increments the version; the second fails the version check → the loser receives "This case was updated a moment ago by [name]. Refreshing." and sees the current state with the now-legal actions → exactly one state change, exactly one SLA effect → the winner's normal notifications fire; the loser receives none → the winning transition is recorded normally; the losing attempt is recorded as `TRANSITION_CONFLICT` with actor, attempted action and stale version → R: both, A: TL → none. No lost update is possible, and the conflict is visible in the timeline.

**S17 — Notification fails.**
A delay-review notification to the assignor fails: the email provider returns a hard bounce and the push token is stale → the outbox marks `FAILED` after the retry ladder → the in-app queue entry exists regardless, so the item is still visible in Queue D; because this is a **decision-required** item, the 1-hour auto-accept timer is suspended for the failure window and an alternate recipient (the assignor's TL) is notified → the assignee is not disadvantaged, and the assignor is not auto-accepted purely because email was down → `NOTIFICATION_FAILED` with provider reason, `SUB_SLA_SUSPENDED`, `ALTERNATE_RECIPIENT_NOTIFIED` → R: platform, A: Admin, I: assignor TL → none. Once the assignor acts, the timer resumes. If the provider is failing broadly, the outage threshold trips and decision sub-SLAs are suspended system-wide with an Ops Head alert.

**S18 — TAT rule changes after assignment.**
Admin edits the TAT for client C + Resident Verification from 24 to 12 hours, effective tomorrow → the rule is **versioned**, not edited: the old row is closed with `effective_to` and a new row is created → every live assignment keeps its snapshotted `tat_value_minutes`, `sla_due_at` and `sla_rule_id`; nothing recalculates and nothing breaches retrospectively → assignments created from the effective date resolve to the new rule → all Ops managers receive the configuration-change notice; no in-flight party is notified because nothing changed for them → `SLA_RULE_VERSIONED` with before/after in `audit_log` → R: Admin, A: Ops Head, C: client servicing, I: all Ops managers → none. If a specific live assignment genuinely must move to the new TAT, Admin performs a per-assignment `SLA_RECALCULATED` action with a mandatory reason and Ops Head approval, which creates a new SLA instance version and preserves the original. Bulk retroactive recalculation is not available in the product at all, because there is no safe use of it.

---

# 32. VERIFICATION AUDIT OF THIS DESIGN AGAINST THE BRIEF

| Brief section | Addressed in | Deviation from your wording |
|---|---|---|
| 1–2 Context & core process | 2, 3, 4 | Location-queue intake added |
| 3 Visibility | 13.3, 13.4, 19 | Queue D added; priority score replaces bucket sorting |
| 4 Assignor actions | 7, 9 | Dispute capped, classified, arbitration added |
| 5 Assignee actions | 4.4, 7, 8 | Evidence mandatory; RFI pause conditional |
| 6 Automatic breach | 5, 6, 10, 11 | Breach is a status, not a state; strikes conditional |
| 7 TAT design | 6.1–6.3 | `clock_type` added; snapshot immutability |
| 8 Case details | 4.1, 14.2 | Validation rules specified |
| 9–11 Applicant / co-applicant / guarantor | 14.2 `case_party` | Guarantor also modelled as 0..n |
| 12 Escalation architecture | 10 | Specificity resolution + hierarchy fallback |
| 13 Three-strike | 11 | Eligibility conditions added |
| 14 RACI | 12 | Five conflicts identified and resolved |
| 15–16 Database & data model | 14 | 3 entities consolidated, 2 split, 9 added |
| 17 Duplicate control | 15 | Three tiers, DB-enforced |
| 18 User access | 13 | Closure table; no email hard-coding |
| 19 Temporary participant | 17 | Distinct principal type; actions capped in phase 1 |
| 20 Audit | 16 | Two streams; hash chaining |
| 21 State machine | 5 | `SLA_BREACHED` / `ESCALATED` removed as states |
| 22 SLA attribution | 6.5 | `PENDING_REVIEW` attribution added |
| 23 Resilience | 22/23 | 22 failure modes; storm suppression added |
| 24 Performance | 20 | Materialised columns; bounded recompute |
| 25 Security | 21 | Impersonation and export controls added |
| 26 Reporting | 19 | Summary table; 18 KPIs |
| 27 Measure & analyse | 25, 24 | 24-row FMEA |
| 28 Design output | All | Complete |
| 29 Challenge | 1 | 11 challenges |
| 30 Simplicity | 30 | Complexity confined to layers 3–4 |
| 31 Verification | 31 | 18 scenarios plus S2b |
| 32 Claude Design prompt | 33 | Below |

---
```

---

*End of design document.*
