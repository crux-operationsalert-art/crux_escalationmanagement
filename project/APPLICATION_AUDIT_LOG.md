# APPLICATION AUDIT LOG

Newest audit first. Each entry records what was **proved**, what was **fixed**,
and what remains — never what was assumed.

---

# AUDIT 13 — Sign-in leaderboard and name hygiene · 9 Sep 2026

Both defects were on the **sign-in screen** — the first thing every user sees —
and both had passed every earlier scan.

## 1. The leaderboard crowned the wrong zone

`topPerformers()` opened with `if (!r.mtd || !r.allocation) return;`, which drops
a row from **both** sums. So a branch with a target that delivered nothing was
excluded from its zone's denominator, and the zone was credited for work it had
a target for and did not do.

Two of five percentages were inflated, and both errors changed the order:

| Zone | mtd / allocation | Correct | Was shown |
|---|---|---|---|
| Surat | 213 / 1540 | **13.8%** | 14% |
| Lucknow / ROUP | 804 / 6160 | **13.1%** | 14% ❌ |
| Pune | 804 / 6700 | 12.0% | 12% |
| Chhatrapati Sambhajinagar | 556 / 5320 | 10.5% | 11% |
| Raipur | 140 / 1380 | **10.1%** | 11% ❌ |

Lucknow took the ★ and "leading this month" when **Surat actually leads**, and
Raipur was placed above Chhatrapati. A motivational leaderboard that names the
wrong winner is worse than none — someone notices they were beaten by a zone
that did not beat them.

Fixed: every row contributes to both sides; the `tgt > 0` filter after
aggregation already handled zones with no target. Verified against the figures
above, now exact.

## 2. `Chhatrapati SambhajinaJar` — corrupted in the master, not the display

A capital J where "ga" belongs, from the extraction. Corrected to **Chhatrapati
Sambhajinagar** (the renamed Aurangabad) in the seed, so it is right in the zone
master and therefore in every MIS grouping, not patched at the view.

**Why every earlier scan missed it:** the duplicate and blank scans look for
names that repeat or are absent. A corrupted name is neither — it is unique, so
it looks clean. That is the gap, not an oversight in any one scan.

## 3. New check: `name_hygiene`

Added `CruxDB.nameDefects()` and a readiness check, covering what the existing
scans structurally cannot:

- **Intra-word capitals** — `SambhajinaJar`, and the same shape as the
  `cruxInida` typo that once held 583 coverage rows.
- **Stray whitespace** — trims on load, but two names differing only by spacing
  never match.
- **Overlapping zone names** — one name that is a prefix of another.

That third check immediately found two pairs the audits had not:

| | Business | Periods |
|---|---|---|
| `Bhopal` | 1,431 mtd, 23 rows | 2026-03 → 2026-09 |
| `Bhopal MP Zone` | 5,909 mtd, 57 rows | 2025-09 → 2026-09 |
| `Mumbai` | 28,208 mtd, 138 rows | 2025-09 → 2026-09 |
| `Mumbai + Goa Zone` | 17,219 mtd, 96 rows | 2026-02 → 2026-09 |

Either one place is counted twice — in which case national totals are inflated —
or a city sits alongside its own zone, which is the mixed-level problem already
seen with "Rest of Maharashtra". **Both carry substantial business and overlap in
period, so it is not guessable.** Surfaced for decision rather than merged:
merging would restate every historical total, and this project has held
Chhattisgarh unassigned for the same reason.

Their ids also collide by prefix (`ZN-BHOPAL` inside `ZN-BHOPAL_MP_ZONE`), which
is why any prefix-matching code must match on id equality, not `indexOf`.

---

# FINDING — the contested zones are double counting, not a hierarchy · 9 Sep 2026

Todo 46 asked whether `Bhopal` / `Bhopal MP Zone` and `Mumbai` / `Mumbai + Goa
Zone` are duplicates or a city inside its zone. Tested rather than guessed, and
the answer is neither of the options offered.

| | rows | periods | Sep MTD | clients | assignments |
|---|---|---|---|---|---|
| Bhopal | 23 | 2026-03 → 2026-09 | 34 | 11 | 11 |
| Bhopal MP Zone | 57 | **2025-09** → 2026-09 | 270 | 11 | 11 |
| Mumbai | 138 | **2025-09** → 2026-09 | 658 | 24 | 24 |
| Mumbai + Goa Zone | 96 | 2026-02 → 2026-09 | 724 | 24 | 24 |

**The decisive test: in 2026-09, all 11 Bhopal clients appear on *both* sides, and
all 24 Mumbai clients appear on *both* sides.** Same client, same period, two
zone names.

That rules out a city-inside-a-zone reading. If `Bhopal` were a city within
`Bhopal MP Zone`, the zone would be the parent and its total would contain the
city's — instead they are 270 and 34, unequal, with the same eleven clients
listed separately under each.

It also rules out a plain duplicate. One name in each pair carries the full
13-month history and the other appears mid-year (`Bhopal MP Zone` from the
start, `Bhopal` from 2026-03; `Mumbai` from the start, `Mumbai + Goa Zone` from
2026-02). So the tracker was **renamed mid-year and both names kept receiving
entries** — for the same clients, in the same months.

**Consequence, stated plainly: September MTD for these two places is being
counted twice in the source workbook.** The verified 11,334 national figure
reconciles to the tracker, so the tracker's own total carries the same
double count.

**What I have NOT done:** silently merged them or deleted rows. Both would change
a figure this project has spent several audits verifying, on my inference rather
than on your knowledge of the business.

**What the next session should do:** treat one name per pair as canonical
(`Bhopal MP Zone` and `Mumbai` — each has the unbroken history), map the other
as an alias so reports show one row per place, and then decide whether the
overlapping months are a double count to be removed or two genuinely separate
books. Only Crux can answer the second part; the evidence above is what it turns
on.

---

# DECISION — Postgres over Turso · 9 Sep 2026

Delegated to me. **Chosen: Postgres (Supabase or Neon free tier). R2 for
documents unchanged.** Full reasoning in `TURSO_R2_READINESS.md` §10; the short
version:

**Turso's benefit is unusable where it would count.** Its advantage is edge
reads, but §7 already established that the penalty engine, escalation clock and
outbox must read the primary — async replication means two replicas can disagree
about whether a cutoff passed, and a penalty is then applied twice or not at all.
That leaves edge reads serving only the dashboard, which measures at 0–2 ms.
There is nothing to optimise.

**Turso's cost lands on a guarantee that fixed an original defect.** The
`coverage_rule_no_overlap` trigger is what makes "overlaps refused at write time,
by the database, not by convention" true, and overlapping coverage is what leaves
an escalation with two owners or none. On Turso that becomes API-enforced and
bypassable, needing a reimplementation in every caller plus a nightly integrity
scan — new code and new failure modes to reach where Postgres starts.

**Postgres removes work rather than adding it:** `build/schema.sql` runs as-is
(86 tables, 6 functions, the trigger, 44 checks, 153 FKs), and the 29 money/score
column decisions become moot because `numeric(12,2)` is exact decimal. That also
deletes the rupees→paise seed conversion — a place to introduce a rounding error
into figures several audits went into making trustworthy.

**Unchanged:** never store a rounded derived rate and multiply by it. That was
the ₹0.13-per-row error, and it is a modelling rule, not a storage one.

`build/schema.libsql.sql` is **kept, not deleted** — if an offline field app ever
needs embedded replicas, the verified translation already exists. The decision
should be revisited only for that requirement.

`RUNBOOK.md` is rewritten for this path: 9 steps, with a sixth verification test
added for the coverage trigger, since that is the guarantee Postgres was chosen
to keep.

---

# AUDIT 12 — Templates, multi-period export, handover corrections · 9 Sep 2026

**Bulk upload templates were toasts.** All nine now download a real CSV with the
exact headers the loader reads, one filled example row to delete, and every
column's rule at the bottom. Verified by intercepting the download and reading
the file back: `Crux-template-People.csv`, 8 columns, 17 lines.

**Export handled one period only.** It now exports the current period, plus any
months ticked under "Compare with", or all 13 via a single button. Every row
carries a Period column, the total line is recomputed across the whole set
(weighted for rates, never averaged), and the filename states the range.

## Corrections to TURSO_R2_READINESS.md
The handover document was wrong in four ways, two of which would have caused
real damage if the next session followed it literally.

1. **"Never store a derived rate" would have broken rate resolution.** All 153
   `rate` rows are `origin:'DERIVED'`, and **101 of 144 trading pairs resolve
   from them**. Dropping them per my own instruction left **144 pairs with no
   rate** — exceptions from 45 to 144, worse than the defect fixed in Audit 08
   and introduced by the document meant to prevent such things. Now scoped to
   *new* rates, with what happens to the existing 153 spelled out.
2. **A float-drift claim I had not measured.** I asserted `REAL` would drift on
   `revenue = mtd × rate`. Measured: ~10⁻¹⁰, invisible. The real error is ₹0.13
   per row from **rounding a derived rate** — a different problem needing a
   different fix. Integer paise is still right, for equality and reconciliation
   rather than precision.
3. **`numeric` counted as 4 columns; it is 29.** The 25 bare ones include every
   money and score column, so the money decision's reach was understated ~6×.
4. **§2 claimed to be "the complete list" with "nothing here is a blocker".**
   Both false. Missing: 6 stored functions, 1 trigger, 2 `bytea`, 27 `date`,
   2 `smallint`, 3 unnamed indexes, 10 `add column if not exists`.

**The omission that matters most.** SQLite has no stored functions or procedural
language, so `coverage_rule_no_overlap` — the trigger enforcing *"overlaps
refused at write time, by the database, not by convention"* — **cannot move to
Turso**. That guarantee becomes API-enforced and therefore bypassable by a
direct write, a migration or a second service. It is now stated in §1's verdict,
detailed in §2b with a nightly integrity scan as mitigation, and raised as a
decision step: accept the trade, or choose Postgres. **It is the only real
argument against Turso in the assessment**, and it was absent from the version I
handed over.

A handover document that has been wrong once should say so, so §8 now lists all
four corrections.

---

# AUDIT 11 — Final four comments · 9 Sep 2026

All eleven comments from this round are now actioned. Detector re-run after:
**270 buttons, 0 without a handler, 0 dead bindings of any kind, 80 forms with
none missing.**

**Hiring is no longer backfill-only.** The chair picker offered vacant chairs
only; it now offers vacant chairs (marked), every chair in scope for a second
person, and "a position not in the structure yet". Three request kinds, each
carrying the approval path that follows from it:
- *Backfill* — manager, then HR. The chair, its KPIs and its band already exist.
- *Additional headcount* — adds unbudgeted cost, so the function head and Finance
  approve as well.
- *New position* — changes the operating structure, so the chair, its band, KPIs
  and reporting line are defined and approved before sourcing opens.

The full lifecycle is shown on the request itself — raised → manager → (function
head → Finance → structure) → sourcing → screening → interviews → offer →
onboarding — each stage naming who acts. Onboarding hands to the **existing**
joining flow, the same one a self sign-up enters, so there is one onboarding
rather than two.

**L1–L5 was showing the wrong thing.** The tab titled "Level framework L1–L5"
rendered org-*tree depth*, which is why the mapping looked absent — it was
answering a different question under that heading. Now five real bands inside a
chair: what each does, how long it typically takes, and **what the next band
asks for**. The rule is stated plainly: only L5 is promoted to the next chair;
every other move is a band change inside the chair somebody already holds.

Bands are **derived from the record the tool already holds** — last monthly score
and whether a penalty applied — not entered by hand, so a band cannot be given
as a favour, and a band that looks wrong points at the record behind it.

**"Add a person" now states its write-through.** A person and a chair are one
act: the form lists the five things that update from the same record — org chart,
responsibility matrix, level band, roll-ups from the joining date, and
explicitly *not* coverage, because ownership of a client and location stays a
decision somebody makes.

**The automation builder now states its limits before you hit them.** Six things
a rule can express, and five it cannot — each with the reason and the way round
it: no integration yet, no judging free text (classify it first, then rule on
the category), nothing irreversible without a person, no unbounded loops (that is
a job, not a rule), and no changing the operating structure. Plus a
"draft it with the assistant" path that produces the closest expressible rule
and names what is missing — an administrator can approve a draft in minutes
where a description takes a week.

---

# AUDIT 10 — Comment round: export, layers, organic growth · 9 Sep 2026

## Actioned
**Export was a toast, not an export.** It now builds a real CSV and downloads
it, in the source tracker's column order with a weighted total line. The scope
filter runs **before** the file is built, so an export cannot widen access.
Excel's coloured, merged layout cannot be written from a browser — that is
applied server-side at build time, and the toast says so rather than implying
otherwise.

**Hierarchy extended to the bottom layer.** Team leader and Executive join
Group, Region, Zone, Client, Location head and Branch manager. A zone-and-client
figure belongs to the branch manager who owns it and cannot honestly be split
below them until those people file daily updates — so those rows read
"Not yet split · under <manager>" with a note explaining that they separate on
their own from go-live. The structure is right now; only the data is pending.

**Data setup tabs merged.** Zone mapping, Assignments and Rates answer one
question — who owns what, where, at what price, from when — so they are one
tab, "Coverage, owners & rates". Eight tabs became six, then seven with Bulk
upload.

**Bulk upload surfaced.** Nine masters in load order, each with a template and
the reason it must come when it does: a coverage file cannot reference a
location that does not exist yet. A file with any error applies zero rows.

**Organic growth and forecast — a new MIS tab.** Where no target was set, one is
derived from the business itself:
- **Seasonal**: the same month last year, grown by an admin-set floor (20%).
- **Run rate**: the average of the last three months.
- **Organic**: whichever is higher, labelled with which read won.
- **(d) The three read together**: target, 10th-day projection and organic —
  the **middle** of the three, so one wild read cannot carry the number.
- **Next month**: (d) plus the pace of remaining days, marked up by how far last
  month beat half its target, or eased back if it did not.

Verified live: target 1,27,786 · projection 5,394 · organic 16,106 → blended
**16,106**. The target is the outlier against an actual of 11,334, and the model
correctly discards it — which is the entire reason for taking the middle.

## Defects found and fixed
1. **`d10` was 0 everywhere.** The ten-day table's column is `location`; the app
   mapped `t.loc`, which is not a field on it. Every 10th-day figure resolved to
   zero, so the **10-day management view had been silently blank since the data
   layer landed**, and the organic tab's projection read 0. Fixed and both
   recovered: d10 1,541, forecast 5,394, projected revenue ₹11,67,250.
2. **A two-read blend took the maximum.** With only two of the three reads
   available, `trio[trio.length - 1]` returned the higher — optimism, when the
   middle-of-three existed precisely to stop one read carrying the number. Now
   averaged.

## Still open from this round
Four comments are **not** yet built, and are named rather than quietly dropped:
hiring for any position with a full requisition-to-onboarding lifecycle;
"Add a person" writing through to the org chart; L1–L5 level mapping against
occupied chairs with promotion criteria; and an audit of what the automation
builder can and cannot express.

---

# AUDIT 09 — Full re-audit and stress test · 9 Sep 2026

**Verdict: PASS. Cleared to proceed to database creation.**

## Comment actioned
**Self-assignment of targets and KPIs.** Probed first rather than assumed, and
found the picture split: self-editing of KPIs was already blocked (`canKpi`
false for every chair, with the reason stated on screen), and target buttons
already appeared only against direct reports — 3 for a Branch Manager, 4 for the
National Head, 2 for HR, each matching their direct count. Verified that no
roster contains its own persona and that indirect reports carry no target
control.

What was genuinely missing was the second half: **"HR should be able to change
the KPIs on request"** — nobody could, HR included. Built as a request flow
rather than a second editor, because that is what "on request" means:

- Nobody edits their own KPI.
- A holder or their one-up manager raises a request with a stated reason.
- A holder's request must be endorsed by the one-up manager before HR sees it.
- HR applies or declines it, with a reason both parties are told.
- Applying changes the KPI from the next cadence period. Nothing already scored
  is restated, and the KPI keeps its previous definition in history.

Verified per chair: a Branch Manager sees "Endorse it" and "Where is it"; HR sees
"Apply or decline"; neither can edit their own.

## Audit result — orphan detector
| Measure | Count |
|---|---|
| Buttons | 265 · **0** without a handler |
| Handler bindings | 264 · **0** dead |
| `sc-for` lists | 199 · **0** dead |
| `sc-if` conditions | 303 · **0** dead |
| Value holes | 1,651 · **0** dead |
| Dead code (`unused*`) | **0** |
| Single-option selects | **0** |
| Buttons missing `type` | **0** |
| Cross-screen leaks | **0** |
| Forms | 77 defined, **0** referenced-but-missing |

## Stress test
**16 chairs × 182 tab renders. Zero blank screens, zero crashes, zero
`undefined`/`NaN`/`[object` reaching the UI.**

## Defects found and fixed this round
1. **A silent key collision.** `rateNote` was defined in both the Rate master
   and Data setup view models. Both spread into `renderVals`, and `misVM`
   spreads later — so **Data setup → Rates was displaying the Rate master's
   wording**, not its own. Setup keys are now namespaced (`setupRateNote`,
   `setupRateCount`, `setupRateRows`).
2. **An unreachable form.** An `oglCreate` form definition existed that no
   `form:'oglCreate'` reference ever opened — dead weight sharing a name with
   the live handler. Removed.
3. **Payload bloat.** The same placeholder note was stored on 941 rows and
   1,373 business rows each carried four zero-valued fields plus a duplicate of
   `mtd`. Hoisted to one note per table and defaulted on read: **717 KB → 497 KB**.

## A false positive I created and reverted
My collision detector flagged `addKpi` as duplicated. I renamed one — and broke
a live `{{ r.addKpi }}` row binding, because one definition is a row property
inside a map and the other is a top-level key. Reverted, and the detector now
excludes keys that are ever row-scoped. Worth recording: the detector is a tool,
not an oracle, and a flag needs confirming before acting on it.

## Performance — a real constraint, measured
**843–1,000 ms per tab render.** Profiled rather than guessed: every view model
runs in 0–2 ms, so the cost is **DOM reconciliation of thirteen screens held in
one template**, not logic. Gating `misVM` and `accessVM` to their own routes was
correct and kept, but immaterial to this number.

This is inherent to a single-file prototype and **does not carry into the build**
— a real app renders one route at a time. It is recorded as a build requirement:
**code-split per route**. It is also why the browser sweep had to run in slices.

## Still NOT TESTABLE — backend dependency
Unchanged from Audit 02 §E, and not counted as passes: permission enforcement,
penetration tests, idempotency, interruption recovery, performance at realistic
volume. All five become testable once the API exists.

## Go-live blockers — 3, all data decisions
`readiness()` reports **1 of 7 checks passing, 3 blocking**:
1. **A configured commercial rate.** 153 rates, all derived from revenue ÷ MTD —
   which cannot validate revenue, because it is computed from it.
2. **Placeholder data removed.** 941 tagged rows and 1,047 tagged fields, all
   removable in one action once the real uploads land.
3. **A real database adapter.** Currently `memory`.

Non-blocking: 21 of 39 zones without a group, 27 without a region, 5 rows with
revenue in the MTD column, 1 zone name with a typo, 43 trading pairs without a
rate.

---

# AUDIT 08 — Exception count was 86% noise · 9 Sep 2026

**Defect:** the MIS reported "EXCEPTIONS 317 · need admin correction" when only
**45** rows needed anything. 272 of the 317 were zone × client pairs that did no
business that period — nothing to rate, nothing to correct.

Root cause: the `rate === null` branch in `misRows()` fired before anything
checked whether the row had any business, so every dormant pair raised
"No rate configured".

This is the inverse of the rule applied correctly everywhere else in the
previous round — targets read "not available", pace reads "month closed", share
reads "too early to read". Here absence was being reported as a defect, and the
45 rows that genuinely need a rate were buried among 272 that do not. An
exception count that is mostly noise is the quickest way to make people stop
reading it.

**Fixed:** exceptions are raised only on rows that traded (`mtd > 0 || rev > 0`).
Verified 317 → **45**, matching the independent count exactly.

**Also:** the count now states what it excluded — "45 of 144 trading pairs
cannot be validated against a rate. 326 pairs did no business this period and
raise nothing" — so a small number is not mistaken for missing data. The KPI
subtitle changed from "need admin correction" to "trading pairs needing a rate".

**Gap panel split into the two facts it was conflating:**
`traded_without_rate` 43 (actionable) and `dormant_pairs` 326 (expected).

**Two further defects found while fixing this:** `gaps()` counted the 8
aggregate roll-up rows in its zone denominators (47 instead of 39 real zones),
and a `real` binding existed only in `readiness()`. Both corrected.

**Source typo now surfaced, not silently preserved:** a detector flags zone
names with a capital letter inside a word — the signature of a typo — catching
`Chhatrapati SambhajinaJar`, where the J should be a g. These names appear on
reports clients see, so they should be corrected at source rather than aliased
in code.

---

# AUDIT 07 — Comment round: sample data, collections, assignments · 9 Sep 2026

Seven comments actioned. Detail in `build/IMPLEMENTATION.md` §19.

**Sample data is tagged and removable.** Every placeholder carries a flag and a
note; `CruxDB.samples()` counts them and `purgeSamples()` removes them exactly —
whole rows where the row is fake, single fields where only the field is. A new
**Sample data** tab shows the census and runs the purge, and readiness treats it
as blocking. Current: 461 people, 470 assignments, 1,047 collection figures.

**A real source defect found: handlers encoded into zone names.** The tracker
writes `Lucknow/ROUP - (Ajay Pathak)` and `NAGPUR (Sudhir)`, so one place
appears as several zones and **its numbers split**. Lucknow was three rows
understating at 390 + 402 + 12; it now reads one zone at 804. 42 → 39 real
zones, 179 rows repointed, ids cleaned. **57 real handler names recovered** and
promoted over placeholders. This is the same modelling error the assignment
comment describes — ownership had nowhere to live, so it went into the name.

**Collections** ride the MTD pipeline exactly: same table, same aggregation,
weighted percentage, three KPIs, two columns, sortable. Placeholder until the
upload lands, and absent figures read "not available" rather than zero.

**Assignments** are client × location with a W.E.F. date, a location head, bulk
upload, and an AI suggestion pass that proposes by distance, load and client
continuity but never assigns on its own.

**MIS**: Location head and Branch manager as dimensions; multi-period comparison
replacing the single previous month.

**Second-order defect caught while doing it.** A stale default still requested a
`loc` dimension and `dimLabel` fell back to the raw key, so rows printed
"AHMEDABAD loc" — the same class of leak fixed once before. The fallback now
renders "(unlabelled field: x)", so a missing label is visibly wrong instead of
quietly wrong.

**Already present, verified rather than rebuilt:** the sign-up journey (4 steps,
employee and partner variants) and the OGL create builder (17 fields, labelled
"New assignment", which is why it read as missing).

---

# AUDIT 06 — Period selection defect · 8 Sep 2026

Twelve months of history were loaded but the MIS could not read them. Four
linked defects, all now fixed and verified:

**1 · A silent default hid the history.** `CruxDB.business({})` fell back to
`opts.period || meta.period`, so a caller asking for *everything* got September.
The "load all periods" change had no effect until this was removed. Now it
filters only when a period is actually named.

**2 · Rows were relabelled rather than selected.** `misRows(m)` mapped
`{ m, ... }` over whatever was loaded, stamping the requested month onto
September's rows. Selecting August returned September's numbers under an August
heading — the worst class of reporting bug, because it looks right. Now
`.filter(b => b.period === m)` with `m:b.period`.

**3 · Two hardcoded periods.** `m` defaulted to `'2026-09'`, `prev` was a
ternary between two literals, and the picker held two hand-written buttons. All
three now derive from `CruxDB.periods()`: 13 months, previous = the next one
along the list, and the comparison can no longer be a month against itself.

**4 · Missing targets printed as zero.** The tracker carries allocations only
for the current period, so history showed Target 0 and Achievement 0% — a
missing target reading as a total miss. Target and shortfall now read
"not available" with the reason, achievement reads "n/a", and a banner explains
it. The earliest period reads "n/a" for previous rather than comparing to
nothing.

**Verified:** September 11,334 (prev 19,832) · August 19,832 (prev 18,637,
target not available) · September 2025 7,884 (prev n/a). August's figure matches
the workbook independently: 19,832 MTD, ₹1,41,14,260 revenue.

---

# AUDIT 05 — Rate history, holidays, sequencing · 8 Sep 2026

**Holidays:** the DoPT 2026 gazetted list is loaded (20 rows). Three Islamic
dates are marked unconfirmed pending moon sighting; two of the seventeen were
not verifiable and are deliberately absent rather than guessed. Verified against
the clock — Dussehra excluded, Diwali correctly immaterial (a Sunday).

**Rates — the assumption was wrong, and the evidence is unambiguous.** Twelve
months were recovered from the tracker's historical blocks (columns detected per
block by rate consistency, 94–100%). **152 of 153 client–zone pairs show exactly
one rate for their whole history**; 28 unchanged across all 12 months. The lone
exception reverts after a single month, which is an error signature, not a
repricing — it is flagged in a new `rate_anomaly` table rather than modelled as
a rate version, because doing so would rewrite what August reports.

So W.E.F. dates are now real (spread across all 12 months, each the month that
pair first traded) and versioning works — but it will be used rarely. What
changes monthly is volume, not price.

**History:** `business_record` now holds 1,373 rows across 13 periods, so
month-on-month reads real history rather than one fabricated prior month.

**Sequencing answered** in `GO_LIVE_PLAN.md`: data decisions here, then
database and API in Claude Code, then flip the adapter in one line, then port
screens. Not Claude chat for anything structural.

---

# AUDIT 04 — Go-live readiness · 8 Sep 2026

Admin can now correct everything the workbook could not state, through the same
adapter the reports read from. Detail in `build/IMPLEMENTATION.md` §17.

**New:** a write surface on the adapter (`insert`/`update`/`remove`), a change
log that doubles as the migration script, a computed `readiness()` verdict, and
a **Data setup** screen with six tabs — readiness, holidays, zone mapping,
rates, source defects, database connection.

**Verified end to end:** inserting a festival holiday moved the table 10 → 11,
recorded actor and reason, was immediately honoured by working-day arithmetic,
and flipped the readiness check from fail to pass — blockers 3 → 2, with no
reload and no application-code change.

**Two defects found while building it.** The nav renders from grouped key lists,
so a route in a persona's `nav` but in no group is unreachable — the new screen
was invisible until fixed, and the rest were swept (none orphaned).
`meta.rowCounts` was a restated literal that had already drifted from the
payload (478 vs 470); it is now derived.

**Remaining blockers, all data decisions, all visible in the app:** festival
holiday dates, at least one configured commercial rate, and a real database
adapter.

---

# AUDIT 03 — Data layer · 8 Sep 2026

**The blocker from Audit 02 is closed.** The owner supplied
`Vicky_Zonewise Monthly Business Tracker Sep 2026`, and the instruction was to
load it *dynamically* so connecting a real database later causes no confusion.

**Done:** `crux-data.js` holds the workbook as normalized tables behind an
adapter (`CruxDB`). Every screen fetches; nothing reads a literal. Replacing
`CruxDB.use({ select })` points the whole application at a live backend with no
change above that line. Full detail in `build/IMPLEMENTATION.md` §16.

**Blocker closed:** the holiday table is populated and actually used. 2 Oct 2026
is now correctly excluded from working-day arithmetic — the first time that
clause has ever fired. A timezone defect surfaced during verification
(`toISOString()` reports the previous day in IST, shifting every date key and
admitting a Sunday) and was fixed.

**Open item closed:** the forecast multiplier mapping is no longer an
assumption. The sheet's own figures verify it — Option A 5×, B 4×, C 3.5× (Base),
D 3.25× (Conservative) — applied to 10th-day **revenue**, not counts.

**Two defects found in the source data,** both flagged rather than overwritten:
roll-up rows (Zone A/B, West, East, North, South, ROI, Pan India) were being
counted as places, producing a 15,960% achievement; and five Gujarat rows carry
the revenue target in the MTD column. Corrected figures: MTD 11,334, revenue
₹46,81,620, blended rate ₹413.06, achievement 8.9%.

**Still outstanding, and visible in the app rather than buried:** festival
holiday dates (not invented), 31 of 50 zones without a group, 38 without a
region, and 0 of 141 rates configured commercially — every rate is currently
derived from revenue ÷ MTD and is labelled as such.

---

# AUDIT 02 — Zero-gap interaction & journey audit · 8 Sep 2026

**Verdict: PASS on interaction integrity. NOT READY for database integration —
one genuine blocker remains (below).**

The previous audit was treated as void, as instructed. Every finding here was
re-derived from the current implementation.

## A. Method

Two attempts were discarded before one worked, which is worth recording so the
next session does not repeat them:

1. **Click every control in the browser.** Abandoned: each route render costs
   ~700 ms, so even one chair × 13 routes exceeds the 10 s execution ceiling.
2. **Encode the source as pixels and read it back through a screenshot.** Tried
   during recovery (below). Abandoned: the capture pipeline re-renders canvases
   and does not preserve exact pixel values — decoded bytes were corrupted at
   both 2×2 and 8×8 block sizes.
3. **Static analysis of template↔logic binding.** Adopted. Covers all 16 chairs
   and 13 routes at once, in ~1 s, and is re-runnable. Documented in
   `BUTTON_INTERACTION_REGISTER.md` §2.

## B. Defects found and fixed

### B1 · Rate master printed another screen's empty state
`Rate master` carried a block bound to **MIS** values:
`{{ misEmpty }}` (an unrelated flag), `{{ misEmptyText }}` (no producer → blank
message), and `display:{{ misTableShow }}` (no producer → `display:` is invalid
CSS, so the table rendered regardless).

Consequence: whenever the MIS had no rows in scope, Rate master showed
"Nothing to report" with **no explanation**, *above a fully populated table*.
Two contradictory states at once.

**Fixed:** own `rateEmpty` / `rateEmptyWhy` / `rateTableShow`, with an empty
state that explains the consequence (records cannot be validated and appear as
rate exceptions) and offers *Add the first rate*. Verified: 15 rows, empty state
correctly absent, both states never simultaneous.

### B2 · 10-day view gated its insights on the MIS's flag
`<sc-if value="{{ misHasInsights }}">` wrapped `{{ tenInsights }}`. The two
lists are computed separately, so the panel could render an empty bordered grid,
or hide populated content. **Fixed:** `tenHasInsights`. Verified: 2 insights
render, 0 empty grids.

### B3 · A primary CTA narrated a journey that already existed
*Add a rate* only printed a description of a form — while a rate form
**existed in the registry, unreachable**. This is the reverse-journey failure in
the mandate §7: functionality that exists but cannot be got to.
**Fixed:** the CTA opens the form; the form gained the four validations the
schema already promised (non-negative rate, end after start, no overlapping
period for the same scope, active locations). Verified: opens with 7 fields.

### B4 · Dead code masquerading as live
Five handlers named `unusedSsoIn`, `unusedEditRole`, `unusedWeighting`,
`unusedAddLocation`, `unusedAddPenalty` — none bound to anything. A future
reader cannot distinguish these from live code. **All five removed.**

### B5 · Two clean results worth recording
`0` buttons without a handler attribute, and `0` single-option dropdowns. Both
were suspected and both were clean — recorded so the next audit need not re-test
blind.

## C. Self-inflicted incident, and the fix that prevents recurrence

While applying B3, a `String.indexOf` used to find a statement terminator
matched **85,389 characters later**, deleting five whole functions
(`accessVM`, `signupVals`, `coverageVals`, `extra`, `rest` — 964 lines, 188
view-model keys, most of the PMS, clients, team, ledger, profile, visits,
ideathon and configuration screens).

**Recovered in full.** The browser had not reloaded, so the pre-write logic class
was still resolvable via `Component.toString()`; it was extracted in five passes
and spliced back. Verified after splice: parens 3761/3761, braces 2524/2524,
all five functions present, all seven main routes render, coverage master and
rate master both functional.

A second, smaller instance of the same class occurred during cleanup: a regex
with `[^)]*` severed a string containing a `)` and grafted its tail onto the next
property, producing `Unexpected token ')'`. Also found and repaired.

**Rule adopted (both cases had the same root cause — unbounded pattern matching
across a 924 KB file):**
- Never use `indexOf(delimiter, from)` to find the *end* of a construct. Bound
  every deletion to a single line (`/^...[^\n]*\n/m`) or to two literal anchors
  whose distance is checked before splicing.
- After any structural edit, assert paren and brace balance before saving.

## D. Six Sigma — measured, not asserted

The mandate rejected the previous review for naming Lean concepts without
measuring anything. Two workflows have hard before/after numbers:

### Add a rate (Admin)
| | Before | After |
|---|---|---|
| Screens | 1 | 1 |
| Controls to reach the form | ∞ — unreachable | 1 |
| Fields | n/a | 7 |
| Error opportunities prevented at entry | 0 | 4 (negative rate, inverted dates, overlapping period, inactive location) |

The improvement is not fewer clicks; it is a journey existing at all.

### Interaction integrity (whole app)
| | Before | After |
|---|---|---|
| Bindings resolving to nothing | 5 | **0** |
| Screens showing another screen's state | 2 | **0** |
| Dead handlers | 5 | **0** |
| Contradictory simultaneous states | 1 | **0** |

### Waste removed (Lean categories, only where real)
- **Defects:** 3 silent-render defects (B1, B2) — invalid CSS and blank text that
  no console error would ever surface.
- **Over-processing:** 5 dead handlers carrying maintenance cost for no outcome.
- **Motion:** 1 unreachable form — work done, then walled off.

No other Lean category produced a finding worth acting on this round, and none
is claimed.

## E. NOT TESTABLE IN CURRENT ENVIRONMENT — BACKEND DEPENDENCY

Stated plainly, per mandate §38. These are **not** passes:

- **Permission enforcement.** Scope is applied in `misRows()` *before*
  aggregation, so a filter can only narrow. That is the correct *semantics*, and
  it is demonstrated. It is **not enforcement** — there is no server, no query
  layer and no API. Row-level security must be re-tested against the real data
  layer.
- **Penetration tests** (§34: URL tampering, parameter injection, direct
  endpoint calls, unauthorised export). No endpoints exist to attack.
- **Double-submit / idempotency.** The outbox unique-key design is specified in
  `build/schema.sql`; it cannot be exercised without a database.
- **Interruption and recovery** (§19: refresh, connection loss, partial submit).
  There is no persistence to lose.
- **Performance at volume** (§28). 1,413 branches of fixture data prove nothing
  about query plans.

## F. Genuine blocker

**The holiday calendar is empty (0 dates).** Every working-hour clock in the
system — escalation response, three-strike chase, penalty cutoffs — is
documented as excluding weekends *and holidays*. With an empty table the holiday
clause has never once fired, in the old tool or this one. Until it is populated
for the current and next year, **no TAT or penalty is being computed correctly**,
and every downstream figure inherits that error.

This is data, not code. It is surfaced in Configuration → Clocks and in
Bulk upload with a `Blocker` flag rather than being hidden.

### Also outstanding, decided by the owner rather than by code
- **Chhattisgarh is in two zones** (ROMG and Indore-MPCG). Coverage cannot
  overlap, so the tool refuses to resolve it either way and holds Raipur
  branches visible-but-unassigned. Needs one decision.
- **217 branches have no code**, so they cannot be foreign-key targets.
- **4 penalty amounts** are unset pending HR/Finance confirmation.
- **`Vicky_Zonewise Monthly Business Tracker Sep 2026.xlsx` is not in the
  project**, so Excel reconciliation (mandate parts 2, 31, 32) is **NOT
  VERIFIED** — including which multiplier maps to Conservative / Base / Stretch.
  The current mapping is the ascending-order default and is admin-editable.

## G. Scorecard

Real numbers only. "—" means not measured this round rather than zero.

| Area | Found | Fixed | Remaining | Severity |
|---|---|---|---|---|
| Orphan interactions | 5 | 5 | 0 | high |
| Broken journeys | 1 | 1 | 0 | high |
| Cross-screen state leaks | 2 | 2 | 0 | high |
| Silent-render defects | 3 | 3 | 0 | medium |
| Dead code | 5 | 5 | 0 | low |
| Self-inflicted regressions | 2 | 2 | 0 | critical |
| Data blockers | 4 | 0 | 4 | high — owner decision |
| Backend-dependent checks | 5 | 0 | 5 | not testable |
| Accessibility (contrast, 44 px targets) | — | — | — | closed in audit 01 |

## H. Final decision

**NOT READY for database integration.** Interaction integrity is clean and
provable; the remaining blockers are the empty holiday calendar, the
Chhattisgarh zone conflict, 217 missing branch codes, and 4 unset penalty
amounts. None is a coding problem — all four need a decision or a data load, and
all four are visible in the application rather than buried in a document.

---

# AUDIT 01 — earlier rounds

Contrast and touch-target remediation (677 undersized targets normalised to
44 px; every text colour computed against its actual ground and lifted above
4.5:1 across both DC files), MIS single-clock refactor, and the as-on-date
correction. Recorded in `build/IMPLEMENTATION.md` §15.
