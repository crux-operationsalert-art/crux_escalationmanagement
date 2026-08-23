# Deploying these changes

The code in `src/` is the Apps Script project
`1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB`, exported verbatim at
commit `5cec037` and changed from there. It is **not live yet**: as of 2026-08-23 the
project on Google is still byte-identical to `main` — the 19 files were compared and
only `Escalation.gs`, `PortalSvc.gs`, `Utils.gs`, `Index.html` and `Portal.html`
match `src/`, `Session.gs` is absent entirely, and nothing is half-written.

Deploy by **updating the existing deployment**, never creating a new one — the
`/exec` URL is already shared with every user and must not change.

> The earlier sharing exposures on both Google files are now closed; see
> [SECURITY-URGENT.md](SECURITY-URGENT.md) for the record and for the two
> follow-up checks that are still worth doing.

## 1. Install the code — two functions, already staged

`bootstrap.gs` is **already pasted into the live project**, and the manifest already
carries the two scopes it needs (`script.projects`, `script.deployments`). So the
remaining work is two Runs:

**1a.** Open the project, pick `step1_check` in the function dropdown, Run.
Authorise when prompted. **It writes nothing.** Read the Execution log; it ends with
`READY` or `NOT READY`, and a failure line says what to do.

**1b.** Once it says READY, pick `step2_deploy` and Run.

**1c.** Reload the editor. `bootstrap.gs` is gone and the manifest is back to the
clean scope set — that is the intended end state, not an error.

If `step1_check` fails on the very first line with HTTP 403, the Apps Script API is
switched off for the account. One toggle, once, then Run it again:
https://script.google.com/home/usersettings

What makes this safe to run: it downloads all 19 files *before* writing anything, so
a failed download cannot leave the project half-updated; it refuses to create a
deployment when it cannot find the existing one, because a new deployment means a
new `/exec` URL; and if it fails *after* writing the code it says so plainly and
names the manual finish rather than reporting success. All 19 raw URLs were verified
on 2026-08-23 to fetch unauthenticated and to byte-match this branch (742 KB), so
the download step will not be what fails.

### If `bootstrap.gs` is no longer in the project

Use `tools/deployer/` instead: a small, separate Apps Script project that does the
same job from the outside, so the production manifest is never hand-edited.

**a.** Turn the Apps Script API on for the account that owns the project, if it is
not already: https://script.google.com/home/usersettings

**b.** Go to https://script.new — a fresh, empty project. Name it `Crux deployer`.

**c.** Replace `Code.gs` with [`tools/deployer/Code.gs.txt`](tools/deployer/Code.gs.txt).

**d.** Gear icon (Project Settings) → tick *Show "appsscript.json" manifest file in
editor*. Open `appsscript.json`, replace all of it with
[`tools/deployer/appsscript.json.txt`](tools/deployer/appsscript.json.txt). Save.

**e.** Run `check` (writes nothing), then `deploy`. Keep the project — running
`deploy` again picks up later commits on the branch.

## 2. Or, the manual way (if you prefer clasp)

```bash
clasp clone 1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB   # once
# copy src/* over the clone's files, then:
clasp push
```

Then in the editor: **Deploy → Manage deployments** → the existing deployment →
pencil icon → **Version: New version** → Deploy.

Do *not* use "New deployment". That mints a new `/exec` URL.

Note that `clasp login --no-localhost` no longer works: it uses Google's
out-of-band OAuth redirect, which Google retired. `clasp login` on a machine with a
browser is fine.

`src/appsscript.json` differs from what is live only in dropping the two temporary
deploy scopes. The web app settings are unchanged (`executeAs: USER_DEPLOYING`,
`access: ANYONE_ANONYMOUS`). That access mode is deliberate — the same `doGet`
serves the read-only client portal (`?view=portal`) to client contacts who have no
Google account, so requiring sign-in would break every portal link. See the note in
`Code.gs`.

## 3. Run the migrations, in this order

From the editor's function dropdown. Each has a dry run that writes nothing —
read the Execution log before applying.

| # | Dry run | Apply | What it does |
|---|---|---|---|
| M2 | `retireLegacyTokensDryRun` | `retireLegacyTokens` | **Do this first.** Invalidates every permanent URL token already in the wild and flags who needs a fresh invite. Deploying the code alone leaves those URLs working until first use. |
| M3 | `canonicaliseLocationsDryRun` | `canonicaliseLocations` | Collapses `PUNE`/`Pune`/`pune` to one spelling per client in BRANCHES and ESCALATION_MATRIX. |
| M4 | `purgeOrphanHistoryDryRun` | `purgeOrphanHistory` | Removes the 166 ESCALATION_HISTORY rows whose parent escalation no longer exists (self-test residue). Only ever touches rows with a missing parent. |
| M5 | `normaliseTargetAllocationsDryRun` | `normaliseTargetAllocations` | Fills the new TARGETS allocation columns and reports any KPI holding both a combined figure and per-client slices. |

New sheets and columns are created automatically on first load
(`ensureSpreadsheet_` appends missing headers), so there is nothing to add by
hand. The new `SESSIONS` sheet appears on the first request after deploy.

## 4. Re-invite everyone

After M2 nobody outside the Crux Workspace domain can sign in until they get a
fresh link. In the app: **Admin → Users → Invite** for each person marked
`NEEDS_REINVITE`. Administrators are marked `NOT_REQUIRED` and need no link —
they sign in with their Crux Google account.

Invite codes are now single-use and expire after 14 days.

## 5. New settings worth reviewing

All are created automatically with the defaults below on first load; change them in
**Admin → Settings**.

| Setting | Default | What it does |
|---|---|---|
| `HEAD_OFFICE_EMAIL` | *(blank)* | Crux head office mailbox, used for a level-5 escalation when the client has no head office of its own and the matrix names nobody at level 5. |
| `HEAD_OFFICE_CC` | *(blank)* | Always copied on a head-office escalation. |
| `APPRECIATION_NUDGE_ENABLED` | `true` | Weekly reminder to managers who have recognised nobody this month. |
| `APPRECIATION_NUDGE_DAY` | `1` | ISO day of week for it. 1 = Monday. |
| `APPRECIATION_NUDGE_HOUR` | `11` | Earliest hour it may go out. |
| `BRANCH_RECIPIENT` | `BRANCH_MANAGER,CRUX_POC` | Now also accepts `HEAD_OFFICE` and `MATRIX_1`…`MATRIX_5`, which route to whoever the escalation matrix names at that level for the branch. |

**No new trigger is needed.** The existing five-minute `tick()` now also runs the
weekly appreciation nudge, the failed-email retry sweep and session housekeeping.
If triggers were never installed, **Admin → Setup → Install triggers**.

Per-client KPI allocation is available from **Team → Targets**: each KPI is either
one combined figure or up to 50 client / sub-category slices, never both.
Admin → Setup also gains **Preview appreciation nudge** (computes who would be
reminded, sends nothing) and **Run appreciation nudge**.

## 6. Verify

**First, the one thing the two security fixes could have broken.** The web app runs
`executeAs: USER_DEPLOYING`, so it reaches the datastore as whichever account last
deployed it. The spreadsheet is owned by `shantanu.suravase@cruxindia.co.in` and is
now *Restricted*, while the script project is owned by
`operations.alert@cruxindia.co.in`. Until it was restricted, the sheet was readable
by anyone, which masked whether the deploying account has real access.

So if `step2_deploy` is run by an account that is not the sheet's owner, check
straight afterwards that the app can still read *and write* the sheet — load any
screen that writes (raise a test escalation, or Admin → Setup → Preflight). If it
errors on the spreadsheet, the fix is to share the sheet as **Editor** with the
account that deployed, not to loosen the sharing again.

Then run the built-in self-check: **Admin → Setup → Preflight**.

Then confirm the P0 fix by hand, which is the scenario that was reported:

1. Take an invite link and open it once — it should work.
2. Open the *same* link again, or from another browser — it must be refused with
   "already been used or has expired".
3. Confirm the address bar no longer contains `?t=…` after the page loads.
4. Try an administrator's old link — it must be refused, not grant admin.
5. Sign in as a Google account with no profile — it must show "No access to this
   tool" and create no USERS row.

## Local tests

```bash
bash test/run-all.sh      # 228 tests, no spreadsheet touched, no email sent
```

The suites run the real `src/*.gs` under Node with the Apps Script globals
stubbed (`test/gas-harness.js`). Sheet fixtures come from `$CRUX_CSV_DIR`
(default `/tmp/db/csv`), one CSV per tab; regenerate them by exporting the
datastore to XLSX and splitting each sheet to CSV. Without fixtures the
data-dependent tests are skipped or fail — the logic tests still run.
