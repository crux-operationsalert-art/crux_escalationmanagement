# Statement of Work — Crux Escalation Matrix

Single source of truth for this engagement. Section numbers are the brief's.

| | |
|---|---|
| **Objective** | Close the P0 authentication incident, then complete the escalation, performance-management, scoring and reporting behaviour the brief specifies, and get it live on the existing URL. |
| **Status** | Code complete and tested. **Not deployed.** The deploy needs two Runs in the Apps Script editor — see `DEPLOY.md`. |
| **Branch** | `claude/full-stack-execution-x9z1qd` · PR #1 · head `a1f7dc4` |
| **Tests** | 228 across eight suites, all passing (`bash test/run-all.sh`) |

## Systems

| Thing | ID | Notes |
|---|---|---|
| Datastore | `18NXfmfPZh…UJb2s` | Google Sheet, owned by `shantanu.suravase` |
| Script project | `1pueB41g1P…aSONbnFB` | owned by `operations.alert` |
| Web app | `/exec` …`FJcb` | **Must not change** — already shared with every user |

## Scope and boundaries

**In scope:** everything in `src/`, the datastore schema, mail routing, and the
deployment runbook.

**Out of scope, deliberately:** the `/exec` URL (fixed); `ANYONE_ANONYMOUS` access
mode (required — the same `doGet` serves the read-only client portal to client
contacts who have no Google account); and any change that removes approved
functionality.

**Constraints carried throughout:** deploy only by updating the existing
deployment, never "New deployment"; no secrets in the repo or in output; no
parallel engines — complete or consolidate what exists rather than adding a second
implementation; no TODOs, dead routes, fake success messages or placeholder logic.

---

## Requirement → work → evidence → verification

Verification is stated at one of three honest levels: **T** asserted by a test,
**I** verified by reading the code (file:line given), **D** cannot be confirmed
until it is deployed.

### §3 — P0: unauthorised session access

| Requirement | Work | Evidence | V |
|---|---|---|---|
| Root-cause the incident | Out-of-domain visitors were authenticated from a permanent `?t=` token matched against `USERS.AccessToken`: never expired, unlimited reuse, bound to no browser, and it identified admins as readily as anyone. Both admin rows held live tokens. | PR #1 body | T |
| Enforce server-side | Identity has two sources and no fallback: Google `getActiveUser()` (the only source that may be ADMIN) or a server-minted session from a single-use, expiring invite code. | `Auth.gs:15,39,46,108` | T |
| Never inherit a session | A session can never carry admin rights — re-asserted on **every** call, not just at sign-in. | `Session.gs:82,130,214` | T |
| No stranger provisioning | Removed auto-creation of a `USERS` row for anyone who loaded the page, and the "first arrival becomes ADMIN" bootstrap. Bootstrap is now a fixed allowlist. | `Auth.gs:79-82,1177` | T |
| Reproduce, then confirm fixed | `test/security.test.js` runs the **old** logic first and demonstrates the bypass, then asserts the new logic refuses it. 41 tests. | `test/security.test.js` | T |
| 11 enumerated scenarios | Covered in the suite. The five that involve a real browser session are listed as hand-checks in `DEPLOY.md` §6. | — | T + D |

### §5–§6 — Matrix and routing

| Requirement | Work | Evidence | V |
|---|---|---|---|
| Client → Location/Branch → Matrix, not client-wide | Three-tier resolver. | `Clients.gs:585,628` | T |
| Head office email | Did not exist. Added, with level-5 resolution order: matrix L5 → client's own `HeadOfficeEmail` → `HEAD_OFFICE_EMAIL` setting. | `Clients.gs:597-617`, `Sheets.gs:17` | T |
| Matrix drives mail | A populated matrix previously had no effect on recipients. `BRANCH_RECIPIENT` now accepts `HEAD_OFFICE` and `MATRIX_1…5`. | `Scheduler.gs:213` | T |

### §7–§9 — Warnings and strikes

| Requirement | Work | Evidence | V |
|---|---|---|---|
| One warning model | Single set of handlers; no second implementation. | `Escalation.gs:468-715` | I |
| Warnings without an escalation | Already correct in HEAD; verified rather than rebuilt. | `Escalation.gs:488,715` | T |
| One 3-strike engine | Already connected. **Found and fixed a real defect:** hour buckets were floored in UTC against a window evaluated in IST (+05:30), so a 7-hour day measured 6.5 and every strike landed late — invisible in any whole-hour timezone. | `Scheduler.gs:736,760` | T |
| Zero strikes on live escalations | **Correct, not a broken engine.** ESC-00022 had human activity to 20 Aug 10:23, so the clock legitimately restarted; strike 1 due 25 Aug, 2 on 29 Aug, 3 on 3 Sep. Thresholds asserted against the real record. | `test/scoring.test.js` | T |

### §10–§14 — Performance management lifecycle

| Requirement | Work | Evidence | V |
|---|---|---|---|
| Monthly windows | `WINDOW_KINDS` — target setting and achievement update. | `Auth.gs:1852` | T |
| Reopen only to the 15th | **`windows.reopen` was bound twice.** The second binding silently won, making the richer handler dead code that referenced an undefined `WINDOW_RULES` and wrote `'OPEN'` where the guard tests `'OPEN:'` — so even its happy path reopened nothing. Consolidated to one handler with the cutoff rule. | `Auth.gs:1856,1859,1874`; `Code.gs:291` | T |
| HR closure | Present. | `Auth.gs:1572` | I |
| Configurable KPIs, max 5/person | Enforced. | `Auth.gs:1957,1988` | T |
| Max 50 client allocations per KPI | `KPI_ALLOCATION_MAX = 50`, enforced on write. | `Auth.gs:925,1960` | T |

### §17–§23 — Scoring and RAG

| Requirement | Work | Evidence | V |
|---|---|---|---|
| 75 target / 25 attribute | One authoritative calculation, ordered so the result is reproducible, with a ledger row per step. | `Auth.gs:1265-1272` | T |
| Escalation −1 attribute, then −2 target | Applied in that order once attribute is spent. | `Auth.gs:1270-1271` | T |
| Warning zeroes attribute, +5 target penalty | Applied. | `Auth.gs:1271` | T |
| Appreciation capped at 25 | +1 each, never above the ceiling. | `Auth.gs:1269` | T |
| Manager 50/50 pyramid roll-up | Half own attributes, half the reports' final scores — which already contain their own roll-ups, so the pyramid propagates without double counting. | `Auth.gs:1358,1382-1395` | T |
| Per-client allocation maths | Sums slices then divides **once**. Averaging slice percentages would let a tiny fully-achieved allocation offset a large missed one. | `Auth.gs:targetAchievement_` | T |
| RAG | **Regression I introduced and then fixed:** unrecorded achievement returned `0`, and `ragTargets_` tests `!== ''`, so unfilled KPIs showed as closed. Added `achievedRecorded` to distinguish "not recorded" from "recorded as zero". | `Auth.gs:1339,1744,1753` | T |

### §24–§27 — Appreciation and AI

| Requirement | Work | Evidence | V |
|---|---|---|---|
| Appreciation UI | Present, with month and all-time counters. | `App.html:2131` | I |
| Weekly appreciation monitoring | Did not exist. Added: ISO-week keyed, targets managers who have recognised nobody this month, AI body with a fixed fallback. Runs off the existing `tick()`. | `Scheduler.gs:64,1013,1029,1102` | T |
| PIP drafted from real data | Previously the model saw only a name, designation and department. Now assembles the actual record — targets and achievement per KPI per month, stored scores, escalations with status, warnings, prior PIPs — gated by `canViewPerson_`, with absences stated explicitly and the record named as the only permitted source of facts. | `Gemini.gs:549,678` | T |
| `attachAiDraft is not defined` | **Not a code defect** — correctly hoisted at depth 1. That error indicates a stale deployment, which is consistent with nothing having been deployed. | `App.html:3048` | I |

### §30–§39 — Invites, layout, schema, email, permissions

| Requirement | Work | Evidence | V |
|---|---|---|---|
| Invite / welcome | Single-use codes, 14-day expiry; admins refused a link and told to use their Crux Google account. | `Auth.gs:1649`, `Session.gs` | T |
| §32 Systemic scrolling audit | The shell grew with its content, carrying the nav ~1000px off the top (`top: -997px` on the dashboard, `top: 103px` after). One `overflow-x` existed against ~15 tables, so wide content scrolled the page sideways. Fixed frame with independent scroll panes; per-table scroll containers applied via MutationObserver so async tables are caught too. | `Styles.html`, `App.html` | T |
| §34/35 Schema and test-only code | New tables/columns added migration-safely (`ensureSpreadsheet_` appends missing headers). No TODO/FIXME/placeholder logic remains — the only matches are format strings, HTML `placeholder=` attributes, and comments describing the *old* placeholder bug. | grep, clean | I |
| §37 Email audit with retry | **Failed mail was never retried** (`RETRY_LIMIT=10`, all 11 live failures still at attempt 1), and manual retry sent the literal body `"(retry) See original log …"` then marked the row **SENT** — a retried escalation delivered nothing while the log claimed success. Now the original body is stored on failure and resent; backoff `[5,15,60,180,360,720×5]` min; abandonment stays `FAILED`, never silently SENT. | `Email.gs:190,223,236,269` | T |
| §39 Server-side permission matrix | 95 RPC routes, **zero duplicates**; every request passes `whoAmI_` then a route-level role gate. 68 routes carry an explicit role list, 28 are open to any authenticated user. | `Code.gs:205-222,262` | T |

### §44–§47 — Consolidation, testing, deployment

| Requirement | Work | Evidence | V |
|---|---|---|---|
| No parallel engines | Apps Script shares one global namespace across all `.gs`, so a duplicate declaration silently shadows. **Zero duplicate top-level function names across all 14 `.gs` files**, and zero duplicate RPC bindings. Dead `reopenWindow_` deleted; a duplicate `dedupeEmails_` I had introduced was removed in favour of the existing `Utils.gs` two-arg version. | grep, clean | T |
| §45 Exhaustive testing | 228 tests: security 41, scoring 44, appreciation 35, matrix 28, layout 27, kpi 25, email 18, lint 10. Real `src/*.gs` under Node with Apps Script globals stubbed; layout renders the actual client in headless Chromium at 5 widths and measures geometry. No spreadsheet touched, no mail sent. | `test/` | T |
| §47 Production deployment | **Outstanding.** See below. |  |

---

## Open items

| # | Item | Owner | Why it is not done |
|---|---|---|---|
| 1 | Run `step1_check` then `step2_deploy` in the editor | **You** | No Google credential exists in this session. `script.googleapis.com` is now reachable (401, not the earlier proxy 403), so only a token is missing; `clasp login --no-localhost` cannot supply one because Google retired the out-of-band OAuth redirect, and the localhost flow needs your own browser session. `bootstrap.gs` is already pasted in and the manifest already carries the scopes, so two Runs remain. |
| 2 | Migrations M2–M5, **M2 first** | **You** | M2 (`retireLegacyTokens`) invalidates every `?t=` link in the wild. Until it runs, deploying the code alone leaves those links working until first use. Each has a dry run. |
| 3 | Re-invite everyone marked `NEEDS_REINVITE` | **You** | Follows M2. |
| 4 | Confirm the deploying account can read **and write** the sheet | **You** | The sheet is owned by one account and the script project by another. Restricting the sheet removed the public read that was masking whether the deploying account has real access. Fix by sharing the sheet as Editor — not by loosening sharing again. |
| 5 | Two post-exposure audits | **You** | The project was world-editable for a period: check version history for versions nobody recognises, and Admin → Settings for values nobody set. Closing the sharing does not answer either. |
| 6 | Hand-check the five browser-session P0 scenarios | **You** | Needs the deployed app. Listed in `DEPLOY.md` §6. |

## Risks and known limitations

- **Nothing is live.** Every fix above, including the P0, is inert until the deploy runs. This is the single largest open risk.
- **The `?t=` links stay valid until M2 runs**, even after deploying. Deploy and M2 belong together.
- **The temporary deploy scopes** (`script.projects`, `script.deployments`) are on the live manifest now. A completed `step2_deploy` removes them by overwriting the manifest from this branch; an abandoned one leaves them, and they should then be removed by hand.
- **The repo is public.** That is what lets `bootstrap.gs` fetch the source unauthenticated. It publishes the datastore ID and the `/exec` URL — neither is a secret now that the sheet is restricted and the URL is already shared, but it is worth making the repo private once the deploy is done.
- **Test fixtures are a point-in-time export** of the datastore (`$CRUX_CSV_DIR`). Assertions about live rows describe the data as exported, not as it stands today.

## Decision log

| Decision | Rationale |
|---|---|
| Keep `ANYONE_ANONYMOUS`; do not require sign-in | The same `doGet` serves the read-only client portal to client contacts with no Google account. I changed it to `ANYONE` and reverted. Requiring sign-in would break every portal link. |
| A session may never be ADMIN | Admin rights only via Google identity, re-checked per call, so a leaked invite code cannot reproduce the incident even in principle. |
| Deployer in a separate project, then use the in-project `bootstrap.gs` | `tools/deployer/` avoids hand-editing the production manifest. Once you had already pasted `bootstrap.gs` and added the scopes, that became the shorter path; the runbook now leads with it and keeps `tools/deployer/` as the fallback. |
| Abandoned mail stays `FAILED` | A row that says SENT when nothing was delivered is worse than a visible failure. |
| Sum allocations, then divide once | Averaging slice percentages misrepresents a revenue target. |
| Fix `achievedRecorded` rather than change `ragTargets_` | "Not recorded" and "recorded as zero" are genuinely different states; collapsing them was my own regression. |
| Did not pursue the clasp OAuth flow further | It needs the out-of-band redirect Google retired, and completing it by other means would mean handling your credentials. Not worth it against two Runs in the editor. |
