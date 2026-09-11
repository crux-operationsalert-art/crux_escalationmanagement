# CRUX — RE-ARCHITECTURE PROJECT STATE
Living handover record. **[V]** verified from the system · **[I]** inferred · **[A]** assumed.

**Deliverables**
| File | What it is |
|---|---|
| `Crux App v2.dc.html` | The working prototype — 13 chairs, 115 tabs, 35 forms |
| `Crux Rebuild Blueprint.dc.html` | The audit and blueprint (findings → root cause → data model → roadmap) |
| `build/IMPLEMENTATION.md` | Build specification, 13 sections |
| `build/schema.sql` | Postgres schema with the constraints that make the old duplication impossible |
| `build/MIGRATION.md` + `build/migration/*.sql` | Run order, rules, merge-log format, cut-over gates (8 scripts, 00→70) |
| `build/schema-patch-v3.sql` | Additive patch: session hashes, outbox attempts, `setting`, `working_hours_after()`, PMS/request clocks |
| `build/schema-patch-v4.sql` | Additive patch: KPI cadence + accrual, offline filing (entry vs receipt time, 24h window as a constraint), `is_assigned_handler`, performance history, role-change history, OGL attachments, `value_correction` |
| `build/supabase/01_rls.sql` | Row-level security on 35 tables + the scope helper functions |
| `build/supabase/02_auth_storage.sql` | Sign-in gate (domain → people master → active) and four private storage buckets |
| `build/supabase/DEPLOY.md` | Phase-1 deploy runbook, seven steps, a verification query after each |
| `build/api/migrate.js` | The six-stage Supabase → AWS runner behind the in-product button |
| `AWS_INFRASTRUCTURE.md` | Phase-2 decisions, cost estimate, build order, business rules from the 10 Sep interview |
| `build/api/` | P0 persistence — Express + Postgres, no ORM. 13 files, `README.md` maps each to the defect it answers |
| `source/datastore-schema.md`, `source/audit-*.json` | Raw evidence from the 26-tab export |

## 0. ACCESS STATUS
| Resource | State |
|---|---|
| Datastore `.xlsx` (9.5 MB) | **FULLY AUDITED** — 26 tabs, every row parsed |
| Apps Script `Code.gs` + manifest | **VERIFIED** — ~90 RPC routes, role gates, auth model, job names |
| Sheets.gs · Auth.gs · Clients.gs · Escalation.gs · Email.gs · Scheduler.gs · Import.gs · Utils.gs · Gemini.gs · HTML files | **NOT VERIFIED — ACCESS LIMITATION.** The uploaded `.docx` arrived 0 bytes. Nothing in the blueprint depends on them; the migration scripts will want them |
| Org chart + RACI (188 processes, 70 chairs, 14 functions) | **INGESTED** |

## 1. REAL SCALE  [V]
1,413 branches · 28 clients · 55 users · 3 escalation cases · 3,783 matrix rows · 693 branches complete at all 5 levels · 722 ACTIVE / 691 INACTIVE.
**The original estimate of 200+ users and 10,000+ branches is wrong by an order of magnitude.** Design for ~1.5k branches with headroom.

## 2. THE FOUR DEFECTS  [V]
1. **E-mail storm.** 1,892 STRIKE_1 sends, 1,889 to one person, for one open case (ESC-00193), over nine days, from 77 idempotency keys. 1,925 of 2,229 sends FAILED; 1,849 hit the Gmail daily cap. `MONTHLY_DISPATCH` has succeeded **once, ever**. `STRIKE_SWEEP` = 1,690 of 1,707 job runs, 1,535 NOOP → held the script lock → `AUTOMATION_PAUSED` kill switch, 26 Aug.
2. **198,890 empty rows.** BRANCHES 101,330 / 1,413 real (40 MB XML); BRANCH_ASSIGNMENTS 100,702 / 1,729; AUDIT_LOG 103,275 / 5,913.
3. **Identity by e-mail string.** `aniket.chalke@crux**inida**.co.in` holds 583 coverage rows and exists in no USERS row. Coverage is defined twice — `USERS.Scope*` and BRANCH_ASSIGNMENTS — with no precedence.
4. **History in a copy.** "Copy of PEOPLE_EVENTS" holds 449 NOTE rows existing nowhere else; the live tab has 26.

Also: config tab as transaction store (`WINOVR:…`); "Sheet4" is a production debug scratchpad; 7 settings keys duplicate one recipient list; 39/55 users hold standing `AccessToken`s; HOLIDAYS and WARNINGS empty though rules claim to use them; 36 Zone values mix states/cities/compass (Goa + GOA); 217 branches without a code; `Dublicate` column (634×1, 390×2).

## 3. OWNER DECISIONS — all settled, none outstanding
**Product** · one app, two separated areas · escalation + dispatch + portal first · hard cut-over on a month boundary, date not fixed · nothing deleted outright.
**Platform** · free tiers only, real DB acceptable · Workspace SSO for most, admin-created email+password for field staff · account-free client portal (mandatory) · send from operations.alert@ (mandatory) · everything works on a phone · crisp corporate direction.
**Rules** · complete matrix = 5 levels with a name + one contact method · auto-close 7 days · incomplete-matrix chase on all four channels · strike clock unchanged (24 working hours, 10–17, weekends and holidays excluded) · 22 categories, category decides who hears first, level order unchanged · 6 desks (Ops, Finance, HR, IT, Compliance, MIS), heads by designation, primary flag breaks ties, vacancy → admin group + loud flag · MD office escalation-only · Fraud/Integrity + Data Privacy pinned to Compliance · **Audit/Quality → Operations** · coverage in mixed shapes, overlaps refused at write time, migration collapses to most-specific and logs the rest.
**Geography** · Crux Zone→State→City→Branch (N/S/E/W/Central/NE) + per-client zone names · **ROMG** = Maharashtra excluding Mumbai and Pune, which sit at West→Maharashtra→Mumbai/Pune · **Indore-MPCG** splits into Central→Madhya Pradesh and Central→Chhattisgarh.
**Penalties** · 7 rules · **HR and Finance may add, edit and delete without approval**, alongside Admin · applicability is multi-select and **includes franchise partners**, who are billed rather than deducted.
**PMS** · 5 KPIs (3 mandatory, 2 optional) with manager-defined sub-categories · Attributes fed by tasks, notes and appreciations · weighting and eligibility set by Admin/HR.
**Other** · all 6 AI features kept behind a monthly cap with grey-out · masters authoritative for CPV/Branch Visit/billing, manual export for now · current + previous FY live, older hidden · print-exact: MIS register, monthly summary, scorecard, warning letters · email + in-app only.

## 4. DECISION LOG
| # | Decision | Reason |
|---|---|---|
| D1 | One app, two separated areas | Shared only via people + reporting chain |
| D2 | Schema from the xlsx, not the live sheet | Text extraction truncates |
| D3 | **Outbox with a unique idempotency key is P0**, ahead of escalation-first | The storm was live and still sending |
| D4 | Single send window; multi-day spread only above 1,200 recipients | 693 eligible branches, not thousands |
| D5 | Postgres (Supabase free tier) | The unique constraints are the deliverable |
| D6 | Coverage as ~40 scoped rules, overlaps refused | Owner's choice + the 1,729-row cross-product |
| D7 | The chair, not the person, drives everything | Multi-chair people; routing by designation survives job changes |
| D8 | No chair may borrow another chair's data | A fallback made new chairs show a Branch Manager's dashboard; empty states now say so instead |
| D9 | AI keys form an ordered fallback chain | One key failing must never take a feature down |
| D10 | **Supabase now, AWS later — and the move is a product feature** | Two phases, one codebase. The migration is six gated stages behind an admin button, not a rewrite |
| D11 | Cadence belongs to the KPI, not to the update | Everybody files daily whatever their cadence; a count adds to its period, a rate replaces the period-to-date level |
| D12 | A manager files only their own numbers | Their team rolls up on its own. A manager's own line is never filled in from their team — blank means not filed, and it says so |
| D13 | **The MIS final count reads assigned handlers only** | Manager and team-leader filings are supervision. Adding them would count the same case at every level it passes through |
| D14 | Multi-AZ, device queue, and audit-with-old-value together | Zero data loss needs all three: the server, the phone, and the correction path each lose data differently |
| D15 | Offline filing counts for the entry day, within 24 hours | Beyond that, administrator reopen only. Enforced as a database constraint, not a client rule |

## 5. PROTOTYPE STATE  [V]
13 chairs × 115 tabs · 35 forms, all reachable · no blank screens, no crashes, no `undefined` in the UI.
Modules: Dashboard · Escalations (4 raise types) · Performance · Clients · My team · HR · Visits & claims · Ideathon · Penalty ledger · Reports · Configuration (9 tabs) · My profile.
Admin setup complete: assistant key chain with live testing and fallback, the 12-touchpoint AI register, and Gmail mailbox setup with connection test, signature builder, self-expiring test mode and bounce handling.

## 6. PMS ENGINE — BUILT AND SCHEMA'D  [V]
44 admin settings drive it; no number is in code. Working week Mon–Sat 10:00–19:00, Saturday a half day of 4h (`sat` / `sat_hours`, both settings). Bell curve 5/15/60/15/5, employees only, partners and probationers reported outside the band. Cascade: Attributes first, zero floor, then KPI points, 2-point shared monthly cap — past the cap the movement is still recorded and flagged to HR. Team contributes 50% of a manager's Attribute half. Probation floor 5. Bottom-up closure: a manager's window will not open while anyone below is unclosed.

`build/schema.sql` **Part 4** now carries this: `holiday`, `pms_cycle` (+ `pms_window_may_open()`), `pms_component`, `pms_adjustment` (+ `pms_attribute_balance()`), `pms_dispute`, `pms_exception`, `pms_curve_band` / `pms_band_result`, `automation` / `automation_run`, hiring columns on `person_request`, the `chair_status` view the org chart reads, and audit scope columns (`chair_id`, `scope_path`, `sentence`).

Mobile: below 760px the six wide registers fold their secondary columns into the primary cell instead of scrolling sideways.

## 7. MIGRATION — WRITTEN  [V]  (7 Sep 2026)
`build/migration/` 00 staging → 10 geography → 20 people → 30 clients+branches → 40 matrix → 50 coverage → 60 history → 70 reconcile. Idempotent: truncate app tables, reload `stg`, re-run.

Rule codes, one per audited defect: **P-01/02/03/05** identity (typo-domain normalisation before any comparison, coverage-only e-mails still become people, twins superseded not deleted, zero tokens migrate) · **B-01/02/03** branches (a row is real only if its key column is non-blank; 217 code-less get `GEN-nnnn` + a review question; the sheet's `Dublicate` column is a claim, duplicates re-derived and resolved by fill score then recency) · **G-02/03** geography (ROMG resolves to Maharashtra and is not a node; Indore-MPCG splits by city, unknown city → review) · **M-02/03** matrix (one row per branch+level, completeness never stored) · **C-02/04** coverage (collapse to the most specific scope covering the observed set *exactly*; overlap rejections logged, earlier rule wins) · **H-01→05** history (449 notes rescued from the copy tab, `EMAIL_RETRY` → delivery not audit, **zero rows enter `outbox`**, legacy jobs arrive disabled *with a reason*, Sheet4 archived not migrated).

Gates in `migration_gate`: 28 · 1,413 · 722/691 · 3,783 · 693 · 55 · 3 · 449 · **0 queued mail** · **0 standing tokens** — all must read PASS, with `migration_unaccounted` and `migration_open_questions` empty.

## 8. PERSISTENCE — WRITTEN  [V]  (7 Sep 2026)
`build/api/` — Express + Postgres, no ORM (an ORM upserting around the unique indexes would undo the whole rebuild). `db.js` `tx()` carries the actor, so an audit row cannot commit without its change. `outbox.js` derives the idempotency key from event+recipient+day — it is never passed in, so a caller retrying is harmless; `drain()` claims with `FOR UPDATE SKIP LOCKED` and stops at the daily cap. `scope.js` scopes every read by chair + `coverage_rule` and returns an empty set *with a sentence* when there is none (D8). `auth.js` — Workspace SSO matches a person and never creates one; field staff get an activation OTP; sessions are hashed rows that expire. `worker.js` chases off `next_chase_at` (R-03) and honours `job_config.enabled`, so no job can hold a lock or pause silently. Routes: cases, matrix, pms, people, penalties, plus `/api/ops/mail` — the two numbers that would have caught the storm.

`build/schema-patch-v3.sql` supplies what this code assumes: `auth_session.token_hash`, `person.password_*`, `outbox.attempts/last_error`, `escalation_action.sets_status/valid_statuses`, the `setting` table (44 PMS numbers, seeded), `working_hours_after()` as the single definition of the strike clock, `pms_adjustment.over_cap`, `pms_exception.due_at`, `person_event.note_class`, and the daily-count/KPI-target unique indexes. Run order: `schema.sql` → `schema-patch-v3.sql` → `migration/`.

## 9. REMAINING WORK
1. **The prototype is not wired to the API.** `Crux App v2.dc.html` is still self-contained, by design. Wire it one module at a time against a loaded pilot database — escalations first, then matrix — not all at once. Re-ingest the Apps Script sources → function inventory, per-sheet **write** map, business-rule cross-check. Blocked on the 0-byte `.docx`. The data mapping stands without it; what is missing is any tab a job wrote that is not among the 26.
3. Build P0: persistence, Workspace SSO + activation OTP, pilot-branch bulk load.
4. WhatsApp channel (setting `whatsapp` still reads Not connected) and the AI recommendation engine, which is rule-based pattern matching in the prototype.

## 11. CHANGE REQUESTS — 10 Sep 2026  [V]
Six from the team, all built and verified in the running app.

**Daily update for everyone.** The daily card was gated on persona; it is now on every chair. Each KPI carries a cadence chip stating whether today's figure adds to the period or replaces the period-to-date level. Attributes are filed by everybody regardless of cadence — a chair with no numeric KPI still gets the notes half. A fourteen-day filing strip shows the record: filed, missed, today open, weekly off.

**Roll-up to the base.** The two-level card became a full-depth tree with expand-to-the-base and collapse-all. Four columns per row: Own, Team below, Head, Own+team. Verified reaching individual field executives.

**MIS basis.** The roll-up carries a separate assigned-handlers-only total with a filed count; the MIS screen states the basis in its header. `coverage_rule.is_assigned_handler` has a unique index so one client × location cannot have two, and `daily_count.counts_to_mis` is set from coverage at insert time — deliberately denormalised so a coverage edit months later cannot change what a published report meant.

**Team chart.** Cards show headcount below (whole subtree, not direct reports), current number, PMS score and a six-month trend. The chair panel adds PMS history and the role-change table. History is keyed to the person: a chair with nobody in it shows nothing rather than the last occupant's figures, and a placeholder holder ("Incumbents exist · count UNKNOWN") gets no panel at all.

**Past-performance bulk upload.** Three templates — MTD achieved, revenue, collections — with full column rules, in the dropdown and at step 8 of the load order. Collections carries a balance check as a table constraint.

**Comments resolved.** "Confirm attribution" rewritten to lead with the plain question and the consequence of not deciding; "Confirm all" demoted to the footer and relabelled so it cannot be clicked as a generic dismiss. OGL attachments added per party (applicant, each co-applicant, each guarantor) and for the case as a whole — filed per party because an RFI asks for one party's paperwork, not the whole file.

## 12. PLATFORM — TWO PHASES  [V]  (10 Sep 2026)
**Phase 1, now: Supabase.** `build/supabase/DEPLOY.md` is the runbook. Schema → patches → RLS → auth → masters → API → point the app at it. The one check that matters most is `set role anon; select * from person;` returning permission denied: the API already scopes every read, and RLS is what protects against a mistake in an endpoint written six months from now.

**Phase 2, later: AWS.** `AWS_INFRASTRUCTURE.md` holds the decisions — ap-south-1, Multi-AZ RDS, EC2, 35-day backups, prod + staging, ~$287/month against a $300–500 ceiling. The move is **Data setup → Move to AWS** in the product: six gated stages backed by `build/api/migrate.js`. Stages 1–5 build and verify a copy while Supabase keeps serving and are safe to re-run; re-running one clears everything downstream of it, so a green Verify can never sit above a copy that has since changed. Cutover will not unlock until row counts **and** content checksums match on every table, and Supabase stays read-only for 30 days afterwards as the fallback.

To finish the wiring: replace the single `setTimeout` in `awsMoveVals()` with `POST /admin/migrate/<stage>`. Everything else on that screen already reads the shape the endpoint returns.

**Two things to watch.** If `is_assigned_handler` is set on no coverage row, every MIS total reads zero — correctly, but it will look broken. And every offline filing older than 24 hours routes through one administrator; when he is on leave nothing moves. Both were deliberate owner decisions; the second is worth revisiting after a month of real volume.

## 13. STILL OPEN — needs the owner, not code
1. **Domain name and its current DNS host.** Blocks Route 53 and the TLS certificate only; phase 1 and AWS steps 1–6 run without it.
2. **Who holds AWS create rights** for RDS, S3, Route 53 and ACM.

## 10. METHOD NOTE
The preview intermittently serves a stale compiled copy. Several apparent failures across these sessions were stale-runtime artefacts, not defects. **Always force a reload before treating a finding as real.**
