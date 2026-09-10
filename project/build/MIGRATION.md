# MIGRATION — run order, rules, merge log, gates
Companion to `build/schema.sql` and `build/IMPLEMENTATION.md`. Written 7 Sep 2026.

## Principle
Three rules govern every script here.
1. **Nothing is deleted.** Duplicates are superseded or collapsed; the loser is always named in the merge log with the rule that decided it.
2. **Nothing is guessed.** Where the sheet is ambiguous — a city that maps to two states, a branch with no code — a row goes to `migration_review` with the question and the context, and a human answers it before cut-over.
3. **Machine noise is not history.** The 1,740 `EMAIL_RETRY` rows and the 2,229 sends are imported as delivery/job history, never as audit entries and never as queued mail.

## Run order
| # | Script | Reads | Writes |
|---|---|---|---|
| 00 | `00_staging.sql` | the 26 xlsx tabs | `stg.*`, the normalisers |
| 10 | `10_geography.sql` | `stg.branches` | `geo_node`, `migration_review` |
| 20 | `20_people.sql` | `stg.users`, `stg.branch_assignments`, `stg.branches`, `stg.matrix` | `designation`, `person`, `migration_merge` |
| 30 | `30_clients_branches.sql` | `stg.clients`, `stg.branches` | `client`, `client_contact`, `client_zone`, `branch`, `branch_contact` |
| 40 | `40_matrix.sql` | `stg.matrix` | `matrix_contact` |
| 50 | `50_coverage.sql` | `stg.branch_assignments`, `stg.users` | `coverage_rule`, `stg.coverage_rejected` |
| 60 | `60_history.sql` | events, audit, e-mail, jobs, settings, holidays | `person_event`, `audit_entry`, `delivery`, `job_run`, `job_config`, `submission_window`, `holiday` |
| 70 | `70_reconcile.sql` | everything above | the gate views |

Each script is idempotent against a fresh app schema: truncate the app tables, reload `stg`, re-run. 50 must run after 30 because a coverage scope is only collapsible once the branches exist.

## Rules, by defect
**Defect 3 — identity by e-mail string**
- **P-01** every e-mail passes `stg.norm_email` first: lower, trim, and `cruxinida.co.in` → `cruxindia.co.in`.
- **P-02** an address that appears only in `BRANCH_ASSIGNMENTS` still becomes a person. The 583 coverage rows keep their owner.
- **P-03** twins (same normalised name, same local part) merge into the older row via `superseded_by`. The unique index on `lower(work_email)` then holds.
- **P-05** no `AccessToken` migrates. All 39 are logged as revoked.

**Defect 2 — 198,890 empty rows**
- **B-01/M-01** a row is real only if its key column carries a non-space character. Everything else is counted and dropped, never written.

**Defect 4 — history in a copy**
- **H-01** the copy tab and the live tab are unioned and deduped; each of the 449 rescued notes keeps `source_ref = 'Copy of PEOPLE_EVENTS!<row>'` and appears in the merge log.

**Defect 1 — e-mail storm**
- **H-03** zero rows enter `outbox`. Legacy sends become `delivery` rows with `entity_type = 'LEGACY_EMAIL_LOG'`.
- Every legacy job arrives in `job_config` **disabled with a reason**, so the kill switch is never invisible again.

**Duplication and ambiguity**
- **B-02** 217 code-less branches get `GEN-nnnn`, a note on the row, and a review question.
- **B-03** the sheet's `Dublicate` column is treated as a claim; duplicates are re-derived from (client, normalised name, city) and resolved by fill score then recency.
- **G-02** ROMG resolves to Maharashtra; Mumbai and Pune are ordinary cities under West → Maharashtra. ROMG is not a node.
- **G-03** Indore-MPCG splits by city into Central → Madhya Pradesh and Central → Chhattisgarh. A city not in the table becomes a review question, not a guess.
- **C-02** coverage collapses to the most specific scope that covers the observed branch set **exactly**; one extra branch and it falls to the next shape. `C-04` rejections are logged, and the earlier rule wins.

## Merge-log format
`migration_merge` is the record. One row per collapse, exported as CSV for sign-off:

`at, entity_type, rule, merged, kept_id, rows_moved, state`

- `rule` always starts with the rule code (`P-03`, `B-03`, `C-02`, `H-01`) followed by the sentence a human reads.
- `merged` is the sheet reference (`BRANCHES!4127`) or the superseded uuid.
- `state` is UNREVIEWED until someone sets `reviewed_by`/`reviewed_at`.

`migration_review` is the other half — the questions. `entity_ref` uses the same `TAB!row` form, so a reviewer can open the sheet at the row that raised it.

## Cut-over gates
Run `select * from migration_gate;` — **every row must read PASS**:
28 clients · 1,413 branches · 722 ACTIVE / 691 INACTIVE · 3,783 matrix rows · 693 branches complete at all five levels · 55 people · 3 open cases · 449 rescued notes · **0 queued mail** · **0 standing tokens**.

Then:
- `select * from migration_unaccounted;` must be **empty** — no real row may reach no table and no log.
- `select * from migration_open_questions;` must be **empty** — every review question answered.
- `select * from migration_coverage_shape;` should read roughly 40 rules, and `branches_covered` must not exceed 1,413.
- `select count(*) from stg.coverage_rejected;` — each row needs an Operations decision.

Cut-over is on a month boundary. The sheet goes read-only at the same moment; nothing is deleted from it.

## Known gap
The Apps Script sources (`Sheets.gs`, `Auth.gs`, `Clients.gs`, `Escalation.gs`, `Email.gs`, `Scheduler.gs`, `Import.gs`, `Utils.gs`, `Gemini.gs`) are still unverified — the uploaded `.docx` arrived 0 bytes. These scripts read the xlsx, which is fully audited, so the data mapping stands. What is missing is the **write** map: any tab a job wrote that is not in the 26 needs a staging table before cut-over.
