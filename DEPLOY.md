# Deploying these changes

The code in `src/` is the Apps Script project
`1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB`, exported verbatim at
commit `5cec037` and changed from there. It has **not** been pushed back to Apps
Script: this session could read the project through the Drive connector but had no
write path to it, so nothing here is live yet.

Deploy by **updating the existing deployment**, never creating a new one — the
`/exec` URL is already shared with every user and must not change.

## 1. Push the code

```bash
clasp clone 1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB   # once
# copy src/* over the clone's files, then:
clasp push
```

`src/appsscript.json` is unchanged from what is live (`executeAs:
USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`). That access mode is deliberate —
the same `doGet` serves the read-only client portal (`?view=portal`) to client
contacts who have no Google account, so requiring sign-in would break every
portal link. See the note in `Code.gs`.

## 2. Update the deployment in place

Apps Script editor → **Deploy → Manage deployments** → the existing deployment →
pencil icon → **Version: New version** → Deploy.

Do *not* use "New deployment". That mints a new `/exec` URL.

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

## 5. Verify

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
bash test/run-all.sh      # 166 tests, no spreadsheet touched, no email sent
```

The suites run the real `src/*.gs` under Node with the Apps Script globals
stubbed (`test/gas-harness.js`). Sheet fixtures come from `$CRUX_CSV_DIR`
(default `/tmp/db/csv`), one CSV per tab; regenerate them by exporting the
datastore to XLSX and splitting each sheet to CSV. Without fixtures the
data-dependent tests are skipped or fail — the logic tests still run.
