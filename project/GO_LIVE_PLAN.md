# GO-LIVE PLAN — what to do, in what order, and where

> **STATUS 9 Sep 2026 — CLEARED TO PROCEED.**
> Audit 09 passed: 265 buttons with 0 orphans, 16 chairs × 182 tab renders with
> 0 blank screens, 0 dead bindings, 0 cross-screen leaks. Three blockers remain
> and **all three are data decisions, not code** — a configured commercial rate,
> removing the tagged placeholders, and a real database adapter. Nothing further
> in this prototype needs building before Step 2.
>
> **One build requirement discovered by measurement:** ~850 ms per screen render,
> caused by thirteen screens living in one template. Profiling showed every view
> model runs in 0–2 ms, so this is DOM reconciliation, not logic. **Code-split
> per route in the real app.** It does not carry over from the prototype.



**Short answer: database first, and not in this design tool. Do the data
decisions here, then build in Claude Code.**

Reason: the application already fetches everything through one seam
(`CruxDB.select/insert/update/remove`). That was the whole point of the data
layer. So connecting a real database is a *one-line* change — but only if the
database serves the shape the seam already expects. Write code first and you
will be coding against a shape you then have to change.

---

## Where each piece of work belongs

| Work | Where | Why there |
|---|---|---|
| Confirm holidays, enter agreed rates, map zones, clear source defects | **Here, in Data setup** | These are decisions, not code. Each one is cheap now and expensive after the schema is loaded, because every correction then needs a migration. The change log becomes your seed script. |
| Repo, migrations, API, auth, deployment | **Claude Code** | It has a filesystem, can run `psql`, `npm`, `git`, and can execute tests. This design tool cannot. |
| Screen-by-screen rebuild | **Claude Code**, using this prototype as the specification | Every screen here is already resolved down to copy, states, permissions and edge cases. Rebuilding from a live spec is faster than re-deciding. |
| Anything structural | **Not Claude chat** | No filesystem, no repo, no ability to run anything. Fine for questions, wrong for building. |

---

## The order

### Step 1 — finish the data decisions (here, ~1 sitting)
Open **Data setup** and clear the three blocking checks:

1. **Holidays** — 20 loaded, 16 for 2026 from the DoPT list. Three
   (Id-ul-Fitr, Bakrid, Muharram) are moon-sighting dependent and marked
   unconfirmed; confirm or shift them. Add any Crux-specific or state closures.
2. **Agreed rates** — all 153 are currently *derived* (revenue ÷ MTD). Enter the
   contracted rate for at least the largest clients. Until then revenue cannot
   be validated, only restated.
3. **Zone mapping** — 31 zones have no group, 38 no region. The workbook never
   said; someone must.

Then **export the change log**. That file is your seed correction script.

### Step 2 — database (Claude Code)
- `build/schema.sql` already defines every table, constraint and index.
  Run it on Postgres. Supabase free tier is sufficient at this volume
  (1,373 business rows, 153 rates, 50 zones).
- Generate a seed migration from `crux-data.js` — the tables are already
  normalized and named to match the schema.
- Apply the exported change log so the database starts in the state you signed
  off, not the state the workbook was in.

### Step 3 — thin API (Claude Code)
Implement exactly four operations per table:

```
GET    /api/:table?...where     → select
POST   /api/:table              → insert
PATCH  /api/:table/:id          → update
DELETE /api/:table/:id          → remove
```

Nothing clever. The application does not need more, because the seam does not
expose more. **Scope must be enforced here**, in the query — the prototype
demonstrates the correct semantics but proves nothing about enforcement.

### Step 4 — flip the switch (one line)
```js
CruxDB.use({
  name: 'postgres',
  select: (t, w) => fetch('/api/' + t + '?' + new URLSearchParams(w || {})).then(r => r.json()),
  insert: (t, row) => post('/api/' + t, row),
  update: (t, id, patch) => patch('/api/' + t + '/' + id, patch),
  remove: (t, id) => del('/api/' + t + '/' + id)
});
```
The readiness check flips `adapter` to pass at this point. No screen, view model
or calculation changes.

### Step 5 — port the screens (Claude Code)
Use this prototype as the specification, screen by screen. `Data setup`,
`MIS dashboard`, `10-day view` and `Rate master` are the ones that already read
live data and should be ported first — they prove the whole chain end to end.

### Step 6 — re-run the audits that a prototype cannot pass
`APPLICATION_AUDIT_LOG.md` §E lists five checks explicitly marked
**NOT TESTABLE IN CURRENT ENVIRONMENT**: permission enforcement, penetration
tests, idempotency, interruption recovery, and performance at volume. All five
become testable in Step 3 and must be run before anyone relies on the tool.

---

## What I would not do

- **Do not rebuild the screens first.** They are the cheap part now — every
  decision is already made and written down. The data is the expensive part.
- **Do not skip the change log.** Without it, the corrections made in Data setup
  are lost and have to be re-decided against a live database, where mistakes
  cost more.
- **Do not treat the derived rates as commercial rates.** They are computed
  *from* revenue, so they cannot validate it. This is the single most likely
  source of false confidence in the numbers.
- **Do not port the escalation, joining, OGL or appraisal fixtures as data.**
  Those screens still run on illustrative fixtures. Only the MIS chain
  (zones, clients, business, rates, ten-day, holidays) is real.

---

## Evidence correcting one assumption

The rate model was expected to change often. It does not. Across 12 months and
153 client–zone pairs, **152 show exactly one rate for their entire history**;
28 of those are unchanged across all 12 months. The single exception —
BOM · Mumbai — reads ₹1,000 in Oct 2025 and ₹750 in the other eleven months.
A value that reverts after one month is an error or a one-off adjustment, not a
repricing, so it is recorded in `rate_anomaly` and flagged rather than turned
into a rate version.

What changes month to month is **volume**, not price. That is why revenue moves.
The practical consequence: rate versioning is real and supported, but it will be
used rarely — so the effort belongs in getting the *agreed* rates entered once,
not in building elaborate rate-change workflows.
