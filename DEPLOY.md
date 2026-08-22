# Deploying these changes

The code in `src/` is the Apps Script project
`1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB`, exported verbatim at
commit `5cec037` and changed from there. It has **not** been pushed back to Apps
Script: this session could read the project through the Drive connector but had no
write path to it, so nothing here is live yet.

Deploy by **updating the existing deployment**, never creating a new one — the
`/exec` URL is already shared with every user and must not change.

## 1. Install the code — the easy way (no local tooling)

`tools/bootstrap-deploy.gs` installs this repo into the Apps Script project from
inside the editor: it downloads the code from the public GitHub repo and writes it
back through the Apps Script API using the editor's own authorisation, then points
the **existing** deployment at the new version so the `/exec` URL is unchanged.

All 19 files were verified downloadable from
`raw.githubusercontent.com/crux-operationsalert-art/crux_escalationmanagement/claude/full-stack-execution-x9z1qd/src/`
(742 KB total).

**1a.** Turn the Apps Script API on for your account (one toggle, once):
https://script.google.com/home/usersettings

**1b.** In the Apps Script editor, open the manifest — the gear icon (Project
Settings) → tick *Show "appsscript.json" manifest file in editor* — then add these
two scopes to `oauthScopes`:

```json
"https://www.googleapis.com/auth/script.projects",
"https://www.googleapis.com/auth/script.deployments",
```

These let the project rewrite itself. Step 2 removes them again by installing the
clean manifest, so the finished project has no standing permission to modify
itself.

**1c.** Add a new script file called `bootstrap` and paste in the contents of
[`tools/bootstrap-deploy.gs`](tools/bootstrap-deploy.gs). Save.

**1d.** Run `step1_check`. It writes nothing. Authorise when prompted, then read
the Execution log: it confirms the API works, that all 19 files download, and
which deployment it would update. It ends with either `READY` or `NOT READY`.

**1e.** Once it says READY, run `step2_deploy`.

It writes the files, creates a version, and repoints the existing deployment. It
refuses to run if any file fails to download, and refuses to create a *new*
deployment if it cannot find the existing one — a new deployment would mean a new
`/exec` URL. Afterwards the bootstrap file and the two extra scopes are gone,
because the clean manifest replaced them; that is expected. To deploy again later,
paste it again.

## 2. Or, the manual way (if you prefer clasp)

```bash
clasp clone 1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB   # once
# copy src/* over the clone's files, then:
clasp push
```

Then in the editor: **Deploy → Manage deployments** → the existing deployment →
pencil icon → **Version: New version** → Deploy.

Do *not* use "New deployment". That mints a new `/exec` URL.

`src/appsscript.json` is otherwise unchanged from what is live (`executeAs:
USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`). That access mode is deliberate — the
same `doGet` serves the read-only client portal (`?view=portal`) to client contacts
who have no Google account, so requiring sign-in would break every portal link.
See the note in `Code.gs`.

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

Run the built-in self-check: **Admin → Setup → Preflight**.

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
