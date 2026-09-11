# OGL ASSIGNMENT — IMPLEMENTATION SPECIFICATION
Ops-to-Ops verification assignment · target: Postgres `build/schema.sql`
5 September 2026 · v1.0 · implementation-ready

**Scope.** A new module in the system being built in this session. The Google Sheets application is a migration source only; nothing here is an ALTER against a tab.

**Naming.** The entity is `verification_case`, not `case` — `case` is already the escalation case in `build/schema.sql`, and `case` is a reserved word in SQL besides.

**The one idea to hold on to.** `current_state` is the operational position and nothing else. `sla_status`, `escalation_level`, `priority_bucket` and `open_request_type` are *orthogonal attributes*, not states. A breached assignment is still `IN_PROGRESS` and still shows its operator the correct next action. Every defect in the old system's workflow came from collapsing these into one status column.

---

## 1. STATE MODEL

Fourteen states. Only these transitions exist; anything else is refused by the transition service with a named reason.

| From | To | Trigger | Guard |
|---|---|---|---|
| — | DRAFT | create | assignor holds a chair with `can_assign` |
| DRAFT | SUBMITTED | submit | all mandatory fields; ≥1 verification requirement; every requirement has a Point ID; duplicate check passed |
| SUBMITTED | ASSIGNED | resolve target location | location active for that client (`CLIENT_ACTIVATION`) |
| ASSIGNED | ACCEPTED | accept | actor holds an assignee-side chair for the target location |
| ACCEPTED | IN_PROGRESS | start / allocate | allocatee is active and in the target location |
| IN_PROGRESS | AWAITING_INFORMATION | RFI raised | no other request open |
| AWAITING_INFORMATION | IN_PROGRESS | RFI answered or rejected | — |
| IN_PROGRESS | DELAY_REVIEW | delay reported | `delay_count < 3` |
| DELAY_REVIEW | IN_PROGRESS | delay accepted, denied, or auto-accepted | — |
| IN_PROGRESS / REWORK | COMPLETED | completion submitted | every requirement reported; evidence present per channel |
| COMPLETED | UNDER_REVIEW | automatic, same transaction | — |
| UNDER_REVIEW | CLOSED | accepted | **no requirement incomplete and no request pending** |
| UNDER_REVIEW | REWORK | dispute raised | `dispute_count < 2` |
| REWORK | COMPLETED | rework submitted | as COMPLETED |
| UNDER_REVIEW | ARBITRATION | 3rd dispute attempt | arbiter = lowest common manager of both parties |
| ARBITRATION | CLOSED / REWORK | arbitration decided | arbiter only |
| CLOSED | REOPENED | reopen | Ops Head or Admin, ≤7 days, reason required |
| REOPENED | IN_PROGRESS | re-allocate | new `sla_instance`, next cycle |
| any pre-COMPLETED | CANCELLED | cancel | assignor or Admin; **no request pending** |

**The transition service is the sole writer of `current_state`.** No endpoint, trigger, job or migration script updates that column directly. Enforced by `REVOKE UPDATE (current_state) ON assignment FROM app_write` and granting it only to the transition role.

---

## 2. DDL

Append to `build/schema.sql`. Every index carries the query that justifies it — an index without a named query does not go in.

### 2.1 Reference and calendar

```sql
-- Business calendar. The old system hardcoded 10:00–17:00 and read an empty
-- HOLIDAYS tab, so the holiday exclusion never once fired.
create table business_calendar (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  geo_node_id     uuid references geo_node(id),
  window_start    time not null default '10:00',
  window_end      time not null default '17:00',
  works_saturday  boolean not null default false,
  works_sunday    boolean not null default false,
  timezone        text not null default 'Asia/Kolkata',
  effective_from  date not null,
  effective_to    date,
  check (window_end > window_start)
);

create table calendar_holiday (
  calendar_id  uuid not null references business_calendar(id) on delete cascade,
  holiday_date date not null,
  name         text not null,
  primary key (calendar_id, holiday_date)
);

-- GO-LIVE GATE: no TAT may be enforced until every calendar in use has
-- holidays loaded for the current and next financial year. Checked by
-- assert_calendar_ready() in the deploy script, not by convention.

create table reason_taxonomy (
  id                  uuid primary key default gen_random_uuid(),
  context             text not null,   -- RFI | DELAY | DISPUTE | CANCEL | REASSIGN | REOPEN | ATTRIBUTION
  code                text not null,
  label               text not null,
  requires_remarks    boolean not null default true,
  implied_attribution text,            -- ASSIGNEE | ASSIGNOR | EXTERNAL | CUSTOMER | APPROVED_HOLD | SYSTEM | null
  active              boolean not null default true,
  unique (context, code)
);

create table verification_type (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,  -- RESIDENT | BUSINESS | EMPLOYEE | QUOTATION
  label          text not null,
  requires_point_id boolean not null default true,
  active         boolean not null default true
);

-- Hierarchy as a closure table. USERS.Manager was an adjacency list walked in
-- script; "My team" and arbitration's lowest-common-manager both need ancestry
-- in one query.
create table org_unit_closure (
  ancestor_id   uuid not null references org_unit(id) on delete cascade,
  descendant_id uuid not null references org_unit(id) on delete cascade,
  depth         int  not null,
  primary key (ancestor_id, descendant_id)
);
create index on org_unit_closure (descendant_id, depth);   -- q: ancestors of X
```

### 2.2 Case, parties, requirements

```sql
create table verification_case (
  id                uuid primary key default gen_random_uuid(),
  force1_case_id    text not null unique,      -- externally supplied; manual entry is the day-one path
  client_id         uuid not null references client(id),
  branch_id         uuid references branch(id),
  applicant_name    text not null,
  applicant_contact text not null,
  applicant_address text not null,
  pincode           text not null,
  completeness_score int,                      -- shown to the assignor at create time
  created_by        uuid not null references person(id),
  created_at        timestamptz not null default now()
);
create index on verification_case (client_id, created_at desc);

create table case_party (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references verification_case(id) on delete cascade,
  party_role text not null,   -- APPLICANT | CO_APPLICANT | GUARANTOR
  seq_no     int  not null,
  name       text not null,
  contact    text,
  address    text,
  same_as_applicant boolean not null default false,
  unique (case_id, party_role, seq_no)
);
-- A guarantor who is also a co-applicant is ONE party row with two
-- requirement rows against it. Two party rows would double-count the person
-- on every report.

create table case_verification_requirement (
  id                   uuid primary key default gen_random_uuid(),
  case_id              uuid not null references verification_case(id) on delete cascade,
  party_id             uuid not null references case_party(id),
  verification_type_id uuid not null references verification_type(id),
  force1_point_id      text not null,        -- keyed by hand · NOT unique, see §2.3a
  attempt_no           int  not null default 1,
  lineage              text not null default 'ORIGINAL',  -- ORIGINAL | REVISIT | REOPENED
  supersedes_id        uuid references case_verification_requirement(id),
  status               text not null default 'PENDING',  -- PENDING|IN_PROGRESS|REPORTED|DISPUTED|CLOSED|CANCELLED|SUPERSEDED
  unique (force1_point_id, attempt_no)
);
create index on case_verification_requirement (case_id, status);
create index on case_verification_requirement (force1_point_id, attempt_no desc);
-- Point ID is mandatory for every SELECTED verification and prohibited for
-- unselected ones. It is entered by hand, so it is NOT globally unique --
-- a repeat of the same Point ID is a legitimate business event.

-- Only one attempt of a point may be live at a time:
create unique index on case_verification_requirement (force1_point_id)
  where status in ('PENDING','IN_PROGRESS','REPORTED','DISPUTED');
```

### 2.3a Repeat Point ID — revisit triage

Point IDs are keyed by hand and the **same case ID or Point ID can legitimately recur**. A repeat is therefore not a duplicate to refuse — it is a decision to route, and the decision belongs to the assignor, not the system.

```sql
create table repeat_point_decision (
  id                uuid primary key default gen_random_uuid(),
  force1_point_id   text not null,
  prior_requirement_id uuid not null references case_verification_requirement(id),
  new_requirement_id   uuid references case_verification_requirement(id),
  address_match     text not null,     -- EXACT | NORMALISED | FUZZY | DIFFERENT
  match_score       int,
  proposed          text not null,     -- system's suggestion
  decision          text,              -- REVISIT | REOPEN | NEW_ASSIGNMENT | REFUSED_DUPLICATE
  decided_by        uuid references person(id),
  decided_at        timestamptz,
  reason            text,
  asked_at          timestamptz not null default now(),
  unique (force1_point_id, prior_requirement_id, asked_at)
);
create index on repeat_point_decision (decision, asked_at) where decision is null;
```

**Flow on entry of a Point ID that already exists:**

1. Compare the address on the new entry against the prior attempt: `EXACT` / `NORMALISED` (case, punctuation, abbreviations) / `FUZZY` (score shown) / `DIFFERENT`.
2. **Same address + a prior closed log → the system proposes REVISIT** and says so plainly.
3. **The proposal is never auto-applied.** A `repeat_point_decision` row is written with `decision = null` and the **assignor** is asked to choose:
   - **Revisit** — a new `case_verification_requirement` with `attempt_no + 1`, `lineage = REVISIT`, `supersedes_id` pointing at the prior attempt. The prior attempt stays `CLOSED` and fully readable. Fresh `sla_instance`, cycle 1 — a revisit is new work, not a continuation.
   - **Reopen / overwrite the previous** — the prior requirement returns to the workflow, `lineage = REOPENED`, prior status moves to `SUPERSEDED`, and **the prior completion row is retained** under its own cycle. "Overwrite" is a workflow word, never a storage one: nothing is deleted, the earlier report stays retrievable.
   - **New assignment** — unrelated work at a genuinely different address.
   - **Refused duplicate** — keyed in error.
4. If the address is `DIFFERENT`, the system proposes NEW_ASSIGNMENT instead and does not offer Revisit without a reason.

The assignee cannot make this call and is not shown the choice — they see the outcome. Until the assignor decides, the new entry sits in DRAFT and no clock starts. **Undecided rows are a queue with an owner**, not a silent backlog: `repeat_point_decision` where `decision is null` appears in the assignor's Action Required tab.

This replaces the hard `unique (force1_point_id)` refuse in the earlier draft, which would have blocked legitimate repeat work.

### 2.3 Assignment

```sql
create table assignment (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text not null unique,          -- OGL-00412
  case_id             uuid not null references verification_case(id),
  assignor_id         uuid not null references person(id),
  assignor_chair_id   uuid not null references chair(id),
  from_location_id    uuid not null references geo_node(id),
  to_location_id      uuid not null references geo_node(id),
  allocated_to_id     uuid references person(id),
  current_state       text not null default 'DRAFT',
  next_action_owner_id uuid references person(id),    -- drives the Action Required tab
  breach_cycle_no     int  not null default 1,
  delay_count         int  not null default 0,
  dispute_count       int  not null default 0,
  open_request_type   text,                            -- RFI | DELAY | DISPUTE | HOLD | null
  priority_score      int  not null default 0,
  priority_bucket     text not null default 'Normal',
  self_assign_reason  text,                            -- required when to_location = from_location
  created_at          timestamptz not null default now(),
  closed_at           timestamptz,
  check (delay_count <= 3),
  check (dispute_count <= 2),
  check (to_location_id <> from_location_id or self_assign_reason is not null)
);

-- q: the four queue tabs, each ordered by priority then age
create index on assignment (next_action_owner_id, priority_score desc, created_at)
  where closed_at is null;                                   -- Action Required
create index on assignment (assignor_id, created_at desc);   -- Assigned by me
create index on assignment (to_location_id, current_state, priority_score desc); -- My team / Assigned to me
create index on assignment (case_id);
-- q: only one live assignment per point
create unique index on assignment (case_id, current_state)
  where current_state in ('SUBMITTED','ASSIGNED','ACCEPTED','IN_PROGRESS');

create table assignment_completion (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references assignment(id),
  breach_cycle_no   int  not null,
  shared_at         timestamptz not null,
  submitted_at      timestamptz not null default now(),
  channel           text not null,          -- FORCE1 | EMAIL | WHATSAPP | OTHER
  recipient         text,
  message_ref       text,
  force1_ref        text,
  backdate_flagged  boolean not null default false,
  other_remarks     text,
  submitted_by      uuid not null references person(id),
  unique (assignment_id, breach_cycle_no)
);
-- INSERT ONLY. A dispute creates the next cycle's row; the disputed one stays
-- exactly as submitted. `shared_at` more than 2 hours before `submitted_at`
-- sets backdate_flagged — a flag, never a block.
```

### 2.4 SLA, clock, attribution

```sql
create table sla_rule (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null,
  version              int  not null,
  client_id            uuid references client(id),
  verification_type_id uuid references verification_type(id),
  geo_node_id          uuid references geo_node(id),
  qty_band_min         int,
  qty_band_max         int,
  priority             text,
  tat_business_minutes int  not null,
  grace_minutes        int  not null default 0,
  at_risk_pct          int  not null default 75,
  specificity          int  not null,   -- computed on write: 8/16/16/8/8 per dimension matched
  effective_from       date not null,
  effective_to         date,
  unique (code, version)
);
create index on sla_rule (client_id, verification_type_id, geo_node_id, specificity desc);

create table sla_instance (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references assignment(id),
  breach_cycle_no   int  not null,
  sla_rule_id       uuid not null references sla_rule(id),
  rule_trace        jsonb not null,     -- which dimensions matched, the specificity arithmetic, the runners-up
  calendar_id       uuid not null references business_calendar(id),
  tat_business_minutes int not null,    -- SNAPSHOT. A later rule change never moves a live clock.
  started_at        timestamptz not null,
  due_at            timestamptz not null,
  extended_to       timestamptz,        -- capped at due_at + 12 business hours
  stopped_at        timestamptz,
  sla_status        text not null default 'ON_TRACK',  -- ON_TRACK | AT_RISK | BREACHED
  unique (assignment_id, breach_cycle_no)
);
create index on sla_instance (sla_status, due_at) where stopped_at is null;  -- q: the sweep

create table sla_clock_segment (
  id              uuid primary key default gen_random_uuid(),
  sla_instance_id uuid not null references sla_instance(id),
  seq_no          int  not null,
  segment_state   text not null,        -- RUNNING | PAUSED
  attribution     text not null,        -- ASSIGNEE|ASSIGNOR|EXTERNAL|CUSTOMER|APPROVED_HOLD|SYSTEM|PENDING_REVIEW
  counts_to_sla   boolean not null,
  counts_to_strike boolean not null,
  reason_id       uuid references reason_taxonomy(id),
  reason_text     text,
  opened_at       timestamptz not null,
  closed_at       timestamptz,
  business_minutes int,                 -- written when the segment closes
  set_by          uuid references person(id),
  unique (sla_instance_id, seq_no)
);
-- One open segment at a time, enforced rather than assumed:
create unique index on sla_clock_segment (sla_instance_id) where closed_at is null;

-- Elapsed and exposure are DERIVED, never stored:
--   elapsed_sla    = sum(business_minutes) where counts_to_sla
--   strike_exposure= sum(business_minutes) where counts_to_strike and attribution='ASSIGNEE'
```

**Business-minute functions.** `add_business_minutes(ts, minutes, calendar_id)` and `business_minutes_between(a, b, calendar_id)`, both `IMMUTABLE` against a fixed calendar and both holiday-aware. Every due date and every segment length goes through them. No arithmetic on wall-clock timestamps anywhere in the codebase.

**TAT resolution.** Score every rule whose dimensions match: client 16, verification type 16, geography 8, quantity band 8, priority 8. Highest specificity wins; ties break on the newest `effective_from`, then the highest version. The whole computation is written to `rule_trace` including the runners-up — when someone asks in three months why an assignment got 26 hours and not 24, the answer is in the row.

### 2.5 Requests — one table, four kinds

```sql
create table assignment_request (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references assignment(id),
  breach_cycle_no   int  not null,
  request_type      text not null,     -- RFI | DELAY | DISPUTE | HOLD
  seq_no            int  not null,
  raised_by         uuid not null references person(id),
  raised_at         timestamptz not null default now(),
  reason_id         uuid not null references reason_taxonomy(id),
  remarks           text,
  delay_category    text,              -- EXTERNAL_DEPENDENCY | CUSTOMER_UNAVAILABLE | APPROVED_HOLD | OWN_CAPACITY
  expected_completion timestamptz,
  sub_tat_minutes   int,               -- RFI 120, DELAY 60
  sub_tat_due_at    timestamptz,
  sub_tat_breached  boolean not null default false,
  pause_granted     boolean not null default false,
  pause_minutes_credited int not null default 0,
  resolution        text,              -- ANSWERED|REJECTED_INVALID|ACCEPTED|DENIED|AUTO_ACCEPTED|UPHELD|NOT_UPHELD
  resolved_by       uuid references person(id),
  resolved_at       timestamptz,
  resolution_remarks text,
  unique (assignment_id, request_type, breach_cycle_no, seq_no)
);
-- Only one request open per assignment, enforced:
create unique index on assignment_request (assignment_id) where resolved_at is null;
create index on assignment_request (sub_tat_due_at) where resolved_at is null and sub_tat_breached = false;
```

**Conditional pause — the rule, stated once.** An RFI pauses the clock only when *all three* hold: consumed < 50% of TAT at raise time; no pause already granted on this cycle; the reason is in the pause-eligible set. Credit is capped at 120 business minutes. The decision and its arithmetic are shown to the assignee **before** they submit, and written to the request row. This is what stops an RFI from being a free extension while still protecting a genuine one.

**Delay auto-accept.** One hour of assignor review. On expiry: `resolution = AUTO_ACCEPTED`, the new segment takes `attribution = PENDING_REVIEW` — counts to SLA, not to strike — the extension is capped at `due_at + 12 business hours`, and the item lands in the assignor's **Confirm Attribution** tray with their manager notified. **One auto-accept per assignment.** A second unreviewed delay escalates to the assignor's manager instead of self-approving; otherwise silence becomes a renewable extension.

### 2.6 Events, escalation, strikes

```sql
create table assignment_event (
  id              bigserial primary key,
  assignment_id   uuid not null references assignment(id),
  event_type      text not null,
  occurred_at     timestamptz not null default now(),
  actor_id        uuid references person(id),
  actor_chair_id  uuid references chair(id),
  is_system       boolean not null default false,
  from_state      text,
  to_state        text,
  payload         jsonb not null default '{}',
  session_id      uuid,
  ip_address      inet
) partition by range (occurred_at);
-- monthly partitions, created a quarter ahead by a job
create index on assignment_event (assignment_id, occurred_at);
create index on assignment_event (event_type, occurred_at desc);

revoke update, delete on assignment_event from app_write, app_read;
-- Append-only is a GRANT, not a policy document.
```

**Event catalogue** (34): ASSIGNMENT_CREATED · SUBMITTED · ALLOCATED · ACCEPTED · STATE_CHANGED · SLA_INSTANCE_CREATED · CLOCK_PAUSED · CLOCK_RESUMED · CLOCK_STOPPED · SEGMENT_ATTRIBUTED · RFI_RAISED · RFI_ANSWERED · RFI_REJECTED · SUB_TAT_STARTED · SUB_TAT_BREACHED · DELAY_REPORTED · DELAY_ACCEPTED · DELAY_DENIED · DELAY_AUTO_ACCEPTED · ATTRIBUTION_CONFIRMED · COMPLETED · REPORT_OPENED · REVIEW_ACCEPTED · DISPUTE_RAISED · DISPUTE_CLASSIFIED · ARBITRATION_OPENED · ARBITRATION_DECIDED · SLA_AT_RISK · SLA_BREACHED · ESCALATED · ESCALATION_FALLBACK_USED · STRIKE_GENERATED · STRIKE_WAIVED · REASSIGNED · CANCELLED · REOPENED.

```sql
-- The INTERNAL matrix. ESCALATION_MATRIX (3,783 rows) is the CLIENT's contact
-- directory and is reused as exactly that — it is not this table.
create table ogl_escalation_matrix (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid references client(id),
  location_id      uuid references geo_node(id),
  branch_id        uuid references branch(id),
  escalation_level int  not null check (escalation_level between 1 and 4),
  chair_id         uuid references chair(id),
  person_id        uuid references person(id),
  sequence_no      int  not null default 1,
  effective_from   date not null,
  effective_to     date,
  check (chair_id is not null or person_id is not null)
);
create unique index on ogl_escalation_matrix (client_id, location_id, branch_id, escalation_level, sequence_no)
  where effective_to is null;

create table escalation_instance (
  id               uuid primary key default gen_random_uuid(),
  assignment_id    uuid not null references assignment(id),
  breach_cycle_no  int  not null,
  escalation_level int  not null,
  trigger_code     text not null,      -- BREACH | SUB_TAT_BREACH | MANUAL | REPEAT_BREACH
  idempotency_key  text not null unique,   -- hash(assignment, cycle, level, trigger)
  resolved_to_id   uuid references person(id),
  fallback_used    boolean not null default false,
  fallback_reason  text,
  raised_at        timestamptz not null default now(),
  closed_at        timestamptz,
  closed_by        uuid references person(id)
);
create index on escalation_instance (assignment_id, escalation_level);
```

**Escalation is one adapter, called from one place.** `raise_escalation(assignment_id, level, trigger_code)` computes the idempotency key, inserts, and hands off to the notification outbox. No routing logic lives in the assignment workflow. The old engine is not called — it routes to client contacts, it has succeeded once ever, and it is currently switched off after producing 1,892 sends from 77 keys. The adapter boundary is what lets a different channel be added later without touching the workflow.

**Resolution order:** exact `client + location + branch` → `client + location` → `location` → **org-hierarchy walk from the assignee location**. If the walk is used: deliver anyway, write `ESCALATION_FALLBACK_USED`, and raise a `CONFIG_GAP` alert to Admin and Ops Head *naming the exact missing key*. Never drop an escalation because configuration is incomplete, and never let the gap stay invisible.

```sql
create table strike_event (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null references person(id),
  location_id      uuid references geo_node(id),      -- as at breach time, not as at now
  assignment_id    uuid references assignment(id),
  breach_cycle_no  int,
  trigger_code     text not null,     -- SLA_BREACH | SUB_TAT_BREACH | DISPUTE_UPHELD | MIGRATED
  occurred_at      timestamptz not null,
  attributable_minutes int,
  strike_no        int,               -- position in the rolling window at generation
  status           text not null default 'ACTIVE',  -- ACTIVE | WAIVED | EXPIRED
  waived_by        uuid references person(id),
  waived_reason    text,
  facts            jsonb not null default '{}',
  unique (assignment_id, breach_cycle_no, trigger_code)
);
create index on strike_event (person_id, occurred_at desc) where status = 'ACTIVE';
```

**Strike engine.** A sweep under `pg_advisory_xact_lock(hashtext('ogl_strike_sweep'))` — the old `STRIKE_SWEEP` held the script lock and ran 1,690 times to produce 1,535 no-ops. A strike is generated when: the instance is BREACHED past grace, and `strike_exposure` (assignee-attributed, strike-counting minutes) exceeds the TAT, and no `PENDING_REVIEW` segment is unresolved on that cycle. The unique constraint means the same sweep running twice cannot produce a second strike — the property the old system could not have, because a sheet cannot carry a unique index.

**Waiver, not deletion.** A dispute classified `NOT_UPHELD` sets `status = WAIVED` with a reason and counts on the *assignor's* quality KPI. The row stays visible as waived. Rolling window: 90 days, three active strikes triggers the warning ladder already in `build/schema.sql`.

### 2.7 Supporting tables

```sql
create table temp_participant_grant (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignment(id),
  person_id     uuid not null references person(id),
  granted_by    uuid not null references person(id),
  action_allowed text not null,     -- exactly one action
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  revoked_at    timestamptz
);
create index on temp_participant_grant (person_id, expires_at) where consumed_at is null and revoked_at is null;
-- Append-only, single-action, time-boxed, and it opens ONE screen showing ONE
-- assignment. It is not a role and cannot be widened into one.

create table duplicate_override (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references verification_case(id),
  matched_on    text not null,     -- POINT_ID | CASE_PLUS_TYPE | FUZZY_NAME_ADDRESS
  matched_ref   text,
  overridden_by uuid not null references person(id),
  reason        text not null,
  created_at    timestamptz not null default now()
);
-- Two tiers now that repeat Point IDs are legitimate (§2.3a):
--   case+type+party while a prior attempt is LIVE -- refuse; there is already
--     open work on that point and a second live assignment is never right
--   fuzzy name+address+pincode -- warn, proceed with a reason
-- A repeat Point ID against a CLOSED attempt is not handled here at all; it
-- goes to repeat_point_decision as a revisit/reopen choice for the assignor.
-- BRANCHES carried a hand-maintained `Dublicate` column; this replaces it
-- with a decision that has an author.

create table user_delegation (
  id           uuid primary key default gen_random_uuid(),
  from_person_id uuid not null references person(id),
  to_person_id   uuid not null references person(id),
  scope         text not null default 'OGL',
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  created_by    uuid not null references person(id),
  check (ends_at > starts_at)
);
-- A delegate acts in their own name with the delegation recorded on the
-- event. Nobody ever acts AS someone else.

create table attachment (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid references assignment(id),
  request_id    uuid references assignment_request(id),
  completion_id uuid references assignment_completion(id),
  kind          text not null,
  storage_ref   text not null,
  content_hash  text not null,
  byte_size     bigint not null,
  virus_scan_status text not null default 'PENDING',
  uploaded_by   uuid not null references person(id),
  uploaded_at   timestamptz not null default now()
);
create index on attachment (content_hash);
revoke update, delete on attachment from app_write;

-- 5-minute materialised summary. The Control Tower reads THIS, never the
-- transaction tables; a twelve-slice count over live rows on every dashboard
-- load is how you take the system down at 09:30.
create materialized view assignment_summary as
select a.to_location_id, vc.client_id, a.current_state, s.sla_status,
       a.open_request_type, a.priority_bucket,
       max(e.escalation_level) as max_escalation_level,
       count(*) as n
from assignment a
join verification_case vc on vc.id = a.case_id
left join sla_instance s on s.assignment_id = a.id and s.breach_cycle_no = a.breach_cycle_no
left join escalation_instance e on e.assignment_id = a.id
group by 1,2,3,4,5,6;
create unique index on assignment_summary (to_location_id, client_id, current_state, sla_status, open_request_type, priority_bucket);
```

**Priority score.** `age_weight + sla_pressure + escalation_level*100 + client_tier + rework_penalty`, recomputed on a tick and bucketed Breach / Attention / Normal. Buckets are what operators read; the number is for ordering and is shown small.

---

## 3. PERMISSIONS — Role × Scope × State × Ownership

The four dimensions are ANDed. All four must pass.

- **Role** — from the chair, never from a person. Chair routes; people rotate through chairs (decision D7).
- **Scope** — `coverage_rule` resolved through `org_unit_closure`. Overlapping coverage is refused at write time (D6). No e-mail address appears in any permission check.
- **State** — the action must be legal in `current_state`.
- **Ownership** — assignor, assignee, allocatee, escalation recipient, arbiter, or a temp grant.

| Decide a repeat Point ID (revisit / reopen) | assignor chair | DRAFT | assignor — never the assignee |
| Bulk upload master data | admin (MASTER_CONFIG) | — | — |

| Action | Chair levels | State | Ownership |
|---|---|---|---|
| Create / submit | branch, region, national, admin, partner | — | own chair |
| Accept / allocate | assignee-side chair for the target location | ASSIGNED | assignee side |
| Start, complete | allocatee or assignee chair | ACCEPTED, IN_PROGRESS, REWORK | allocatee |
| Raise RFI, report delay | allocatee or assignee chair | IN_PROGRESS, REWORK | allocatee |
| Answer RFI, review delay, confirm attribution | assignor chair | AWAITING_INFORMATION, DELAY_REVIEW | assignor |
| Open report, accept, dispute | assignor chair | UNDER_REVIEW | assignor |
| Classify dispute | assignor chair | after rework | assignor |
| Decide arbitration | lowest common manager | ARBITRATION | arbiter only |
| Escalate manually | branch, region, national, admin | any open | either side |
| Reassign | assignor or admin | pre-COMPLETED | assignor |
| Cancel | assignor or admin | pre-COMPLETED, no request open | assignor |
| Reopen | Ops Head, admin | CLOSED ≤7 days | — |
| SLA override | Ops Head **countersigned** | any | not the requester |
| MASTER_CONFIG | admin | — | — |
| AUDIT_CONFIG | **separate holder** | — | — |

**Two hard separations.** An SLA override cannot be approved by whoever requested it. Nobody appears in their own escalation path — checked when a matrix row is written, not when it fires.

**AUDIT_CONFIG — as decided, with the risk named.**

Holders: **shantanu.suravase@cruxindia.co.in** and **operations.alert@cruxindia.co.in**, both also holding MASTER_CONFIG, each able to appoint further admins.

```sql
insert into config_grant (scope, person_id, may_delegate) values
  ('MASTER_CONFIG', :shantanu, true), ('AUDIT_CONFIG', :shantanu, true),
  ('MASTER_CONFIG', :ops_alert, true), ('AUDIT_CONFIG', :ops_alert, true);
```

This is a single-person-of-control arrangement: the same holder can change a rule and change the record of who changed it. At 55 people that is a reasonable trade, and it is your call to make — but it is the one control the schema cannot compensate for, so three things carry it instead:

1. **`operations.alert@` is a shared mailbox, not a person.** Any action taken under it is unattributable by construction. It must therefore be **AUDIT_CONFIG read-only** — receiving alerts, holding no write — or be replaced by a named human. Recommendation: leave it as the alert *recipient* and give the write grant only to a second named person. Tell me who and I will wire it.
2. **The audit trail is hash-chained and append-only at the GRANT level** (§5.3). Even a MASTER_CONFIG holder cannot silently rewrite it: `UPDATE` and `DELETE` are revoked for every application role, and a broken `prev_hash`/`row_hash` link is detectable by anyone with read access.
3. **Every AUDIT_CONFIG change, and every admin appointment, notifies both holders and writes an `audit_entry` with a mandatory reason.** Self-appointment is possible but never quiet.

When headcount allows, split AUDIT_CONFIG to Finance or a non-Operations chair. Recorded here as an accepted risk with a review date rather than a solved problem.

Every mutating endpoint re-checks all four dimensions server-side. The UI renders only legal actions — visible in the prototype's detail view — but the UI is a courtesy, not the control.

---

## 4. VALIDATION — four levels

1. **Field** — types, formats, ranges, pincode shape, future-date refusal on `shared_at`.
2. **Cross-field** — Point ID mandatory for selected verifications and prohibited otherwise; `expected_completion` in the future and within the extension cap; evidence required by channel (Force1 self-captures; Email needs a message reference *or* a screenshot; WhatsApp and Other need an attachment; Other needs remarks).
3. **Business rule** — the duplicate tiers; location active for that client; `delay_count < 3`; `dispute_count < 2`; one open request; close blocked while any requirement is incomplete; self-assignment needs a reason and Branch Manager approval.
4. **Database** — every rule above that *can* be a constraint, is one. The four production defects existed because a spreadsheet cannot carry constraints; a rule enforced only in application code is a rule that will eventually be broken by a script, a migration, or a support fix at 23:00.

---

## 5. IDENTITY, MIGRATION, AUDIT

### 5.1 Identity — the blocking gate

Current state: 55 USERS rows, e-mail-string identity, no employee code, no person/user separation. `aniket.chalke@cruxinida.co.in` — typo domain — holds **583 BRANCH_ASSIGNMENTS coverage rows and exists in no USERS row**. A person with coverage and no identity.

**No OGL assignment may be created until de-duplication completes.** Not a preference; the identity-reuse rule is unsatisfiable against this data.

```sql
alter table person add column employee_no text unique;
alter table person add column superseded_by uuid references person(id);
alter table person add column merge_reason text;
```

**Merge, for the 583-row case.** Never delete, never reassign in place:
1. Create the canonical `person` row with an issued `employee_no`.
2. Create the typo-domain identity as a real row too, marked `superseded_by` the canonical one, `merge_reason` recorded.
3. Rewrite the 583 coverage rows to the canonical id **inside one transaction**, writing a `migration_merge` row per rewrite with before and after.
4. Re-run the D6 overlap check. Merging two identities can create coverage overlap that neither had alone — that is the whole risk of this step and the reason it is checked after, not assumed.
5. Reconcile: 583 rows in, 583 rows accounted for, or the transaction rolls back.

Resolution rules, in order: `employee_no` → verified e-mail → mobile + name → manual review queue. Fuzzy matches go to a human with both records side by side; no automatic merge on a fuzzy match, ever.

### 5.2a Geography — ROMG and Indore-MPCG

As given:

- **ROMG** (Rest of Maharashtra & Goa) — every location in **Maharashtra except Mumbai and Pune**, plus **Goa**, plus **Chhattisgarh**. Zonal chair: **Nitish Bhope**.
- **Indore-MPCG** — every location in **Madhya Pradesh**, plus **Chhattisgarh**.

```sql
-- Zone level
ROMG          -> states: MH (minus Mumbai, Pune), GA
INDORE_MPCG   -> states: MP
-- Mumbai and Pune are carved OUT of ROMG as their own leaves under MH and
-- attach to their own zones, not to ROMG.
```

**⚠ Chhattisgarh is in both definitions, and the schema will refuse it.**

`coverage_rule` refuses overlapping coverage at write time (decision D6), so Chhattisgarh cannot belong to ROMG and Indore-MPCG simultaneously. This is not a technicality to work around — it is the exact ambiguity that lets an assignment sit in two zones and be chased by neither, and it decides whose escalation ladder a Raipur breach climbs.

**Three ways to resolve it. I need you to pick one:**

| Option | What it means | Consequence |
|---|---|---|
| **A — CG under Indore-MPCG** | "MPCG" reads as Madhya Pradesh + Chhattisgarh, which is what the name says. ROMG = Maharashtra-minus-Mumbai-Pune + Goa only. | Cleanest. Nitish Bhope loses CG. |
| **B — CG under ROMG** | Nitish Bhope keeps CG as given. Indore-MPCG = Madhya Pradesh only and should be renamed **Indore-MP**. | Name and content agree again, but the label changes. |
| **C — CG splits by city** | e.g. Raipur and Bhilai to Indore-MPCG, the rest to ROMG. | Legitimate and supported — `geo_node` is city-level — but you must give me the city list. No default. |

Until this is answered, phase 2 loads Maharashtra, Goa and Madhya Pradesh, and **holds Chhattisgarh branches unassigned** with a named blocker rather than guessing. An unassigned branch is visible and fixable; a wrongly-assigned one is neither.

### 5.2 Migration sequence

| Phase | What | Gate |
|---|---|---|
| 0 | Deploy schema; load calendars and **holidays**; load `reason_taxonomy`, `verification_type`, `sla_rule` | `assert_calendar_ready()` passes |
| 1 | People de-duplication and merge; issue employee codes; build `org_unit_closure` | 583 rows reconciled; zero coverage overlaps |
| 2 | Geography: `geo_node` Zone→State→City→Branch from 34 CRUX_REGIONS rows per §5.2a; "Goa"/"GOA" collapse; 217 branches need codes | every branch resolves to one leaf; **zero coverage overlap** |
| 3 | Build `ogl_escalation_matrix` — **new internal ladder**, not a copy of the client directory | no person in their own path; level 1–4 complete per active client+location |
| 4 | Migrate 1,892 STRIKE_1 sends → a small set of de-duplicated `trigger_code = MIGRATED` rows so the 90-day window is correct on day one | count reconciled and signed off |
| 5 | OGL live for one client in one location. Force1 IDs keyed by hand | 2 weeks clean |
| 6 | All clients; Control Tower on | — |

### 5.3 Audit

`audit_entry` gains `session_id`, `ip_address`, `change_reason`, and a `prev_hash`/`row_hash` chain. `UPDATE` and `DELETE` revoked on `audit_entry`, `assignment_event`, `sla_clock_segment`, `assignment_completion`, `attachment` and `temp_participant_grant` for every application role. Column-level before/after on `assignment`, `sla_instance`, `ogl_escalation_matrix`, `person`, `coverage_rule` and `sla_rule`. Machine noise — the old AUDIT_LOG was 1,740 EMAIL_RETRY rows out of 5,913 — goes to `job_run`, not the audit trail. An audit trail you have to filter to read is not one.

---

## 6. TESTING

Six stages, as in `build/IMPLEMENTATION.md`: constraint tests (every rule above attempted and refused) · state-machine tests (all 21 legal transitions, and a sample of illegal ones refused with the right reason) · clock arithmetic across a weekend and a holiday · concurrency (the strike sweep run twice in parallel must produce one strike; two accepts on one assignment must produce one) · the 18 scenarios from your design document · load at 500k assignments and 5M events with keyset paging on every queue.

**On the 2M figure:** real scale is 55 users, 1,413 branches, 28 clients — roughly 130k assignments a year at 200 per user per month. Every index, partition and keyset page in this spec is built as specified because they cost nothing. The seed is 500k/5M. Say the word and I will run 2M/25M as a headroom check.

---

## 7. STILL OPEN

1. **ROMG and Indore-MPCG geography splits** — needed for phase 2; the leaf structure can't be finalised without them.
2. **Force1** — no API, no credentials, no field list, no statement of whether Point IDs are issued by Force1 or keyed by hand. Designed as externally-supplied unique strings with manual entry as the day-one path. Send a contract and I'll design to it.
3. **AUDIT_CONFIG holder** — must not be the Admin, and must not be whoever approves SLA overrides. Name them.
4. **Four penalty amounts** — carried over from the main build spec.
5. **Second AUDIT_CONFIG write-holder** — `operations.alert@` is a shared mailbox and cannot carry an attributable write grant. Name a second human, or confirm the mailbox stays read-only as the alert recipient.

### Closed by your decisions of 5 September
- **Force1** — Point IDs keyed by hand, repeats legitimate, revisit/reopen confirmed with the assignor. Specified in §2.3a; the global unique index is removed.
- **Penalty amounts** — placeholders stand until you finalise; loaded through bulk upload (§6a), not a code change.
- **Visit form** — this tool replaces the Google Form outright. No reconciliation needed; comment #5 closed.

---

## 6b. ORG CHART — the structure as live data

The operating structure stops being a document. `chair` already exists; these columns and tables make it renderable, editable and exportable.

```sql
alter table chair add column parent_chair_id uuid references chair(id);
alter table chair add column lane text;            -- Governance|Executive|Risk Operations|Finance|Assurance|Excellence & Technology|Commercial & People
alter table chair add column clearance_band text;  -- SG1..SG7

create table chair_dossier (
  chair_id      uuid primary key references chair(id) on delete cascade,
  owns          jsonb not null default '[]',
  does          jsonb not null default '[]',
  advises       jsonb not null default '[]',
  informed      jsonb not null default '[]',
  must_escalate jsonb not null default '[]',
  must_be_given jsonb not null default '[]',  -- [{what, from_chair_id}]
  updated_by    uuid references person(id),
  updated_at    timestamptz not null default now()
);

create table chair_kpi (
  id            uuid primary key default gen_random_uuid(),
  chair_id      uuid not null references chair(id) on delete cascade,
  name          text not null,
  unit          text not null,          -- PERCENT|COUNT|INR|DAYS|SCORE5
  target_value  numeric not null,
  cadence       text not null,          -- DAILY|WEEKLY|MONTHLY|QUARTERLY|ANNUAL
  direction     text not null default 'HIGHER_BETTER',
  weight        text not null default 'EQUAL',
  mandatory     boolean not null default false,  -- only HR may delete a mandatory KPI
  rationale     text,
  effective_from date not null,
  effective_to   date,
  unique (chair_id, name, effective_from)
);
create index on chair_kpi (chair_id) where effective_to is null;
```

**Three rules that make it stay true.**

1. **A chair KPI change applies from the next cadence period.** `kpi_target` rows already set for the current month keep their value — nobody is re-scored against a rule that moved mid-month. This is why `chair_kpi` is effective-dated rather than updated in place.
2. **The chart is derived, never maintained separately.** Reporting lines come from `chair.parent_chair_id`, holders from `chair_holder`, KPIs from `chair_kpi`, ownership counts from the RACI matrix. Adding a person or a KPI updates the chart in the same transaction; there is no rebuild step and no second copy to drift.
3. **The export is generated from the same query the screen renders.** HR, the AVP and above can download the whole structure as a standalone HTML file — dossiers, current holders, current KPI targets, current reporting lines, stamped with the moment of download. Because it is generated rather than authored, it cannot disagree with the tool. A chair with no written dossier renders its derived one and says so, rather than appearing blank.

Permission: read for every chair; `chair_dossier` and `chair_kpi` writes for HR, Ops Head, AVP and Admin; export for HR and level `national`/`admin`. Mandatory-KPI deletion is HR-only.

## 6a. BULK UPLOAD — admin data loading

All data currently in the tool is illustrative. Real data loads through an admin bulk upload, not a migration script, so you are never waiting on an engineer to correct a penalty amount or add a branch.

```sql
create table bulk_upload (
  id            uuid primary key default gen_random_uuid(),
  target        text not null,     -- PEOPLE|CLIENTS|BRANCHES|GEOGRAPHY|COVERAGE|ESCALATION_MATRIX|SLA_RULES|PENALTY_RULES|KPI_TARGETS|HOLIDAYS|VERIFICATION_TYPES|OGL_BACKLOG
  file_ref      text not null,
  content_hash  text not null,
  row_count     int  not null,
  mode          text not null,     -- INSERT_ONLY | UPSERT | REPLACE_SCOPE
  status        text not null default 'VALIDATING',  -- VALIDATING|PREVIEW|APPLIED|REJECTED|ROLLED_BACK
  valid_rows    int, error_rows int, warning_rows int,
  errors        jsonb not null default '[]',
  uploaded_by   uuid not null references person(id),
  uploaded_at   timestamptz not null default now(),
  applied_at    timestamptz, applied_by uuid references person(id),
  rolled_back_at timestamptz, rollback_reason text,
  unique (target, content_hash)     -- the same file cannot be applied twice
);
create index on bulk_upload (status, uploaded_at desc);
```

**Rules, in order:**
1. **Validate before anything is written.** Every row is checked against the same four validation levels as manual entry (§4). No constraint is relaxed for a bulk load — that is how the old datastore acquired 198,890 empty rows and a typo-domain identity.
2. **Preview is mandatory.** The admin sees valid / warning / error counts, the first 50 errors with row numbers and reasons, and a downloadable error file. Nothing is applied from the upload screen without passing through preview.
3. **All-or-nothing per file.** One transaction. A file with any error row applies zero rows.
4. **Reconciliation gate.** Rows in must equal rows accounted for, or the transaction rolls back — the same gate as the 583-row identity merge.
5. **Rollback window.** `REPLACE_SCOPE` uploads keep a snapshot for 7 days and can be reversed in one action with a reason.
6. **Order is enforced.** Geography → people → clients → branches → coverage → matrix → rules → targets. A coverage upload against unloaded geography is refused with the missing dependency named, not half-applied.
7. **`OGL_BACKLOG`** exists so live assignments can be loaded at cutover with their real `created_at` and cycle, without a clock starting retroactively.
8. Every upload writes an `audit_entry` with the file hash. Two admins uploading conflicting files is visible, not a race.
