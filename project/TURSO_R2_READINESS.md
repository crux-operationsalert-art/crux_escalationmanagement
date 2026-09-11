# TURSO + R2 READINESS ASSESSMENT

**Asked:** are we ready to create the database on Turso, storage on Cloudflare R2,
with an aggregated MIS / dashboard layer on top?

**Answer: ready to start, but not by running `build/schema.sql` as it stands —
and one decision must be made before any code is written, because it cannot be
undone cheaply afterwards.**

---

## 1. Verdict by component

| Component | Verdict | Why |
|---|---|---|
| **Turso for the database** | **Decided against \u2014 see \u00a710** | Its one real benefit (edge reads) is unusable for the paths that matter, and its one real cost (losing the coverage trigger) hits the guarantee that fixed an original defect. |
| **Postgres for the database** | **Chosen** | `build/schema.sql` runs as-is: 86 tables, 6 functions, the trigger, 44 checks, 153 foreign keys. Zero translation, zero enforcement lost, same free tier. |
| **R2 for storage** | **Right choice, nothing blocking** | Documents are write-once, read-rarely, and never need server-side processing. R2's zero egress fee matters because HR and clients re-download the same letters. |
| **Aggregated MIS layer** | **Do not build it yet** | See §4. At current and near-future volume it adds a staleness bug and a second source of truth for no measurable gain. |
| **The application above it** | **Ready** | Every screen already reads through `CruxDB`. One adapter swap. |

---

## 2. The schema needs translating, and one part of it does not translate at all

Counted in `build/schema.sql` (85 tables, 65 KB).

### 2a. Mechanical — type and syntax changes

| Postgres construct | Uses | Turso / libSQL equivalent |
|---|---|---|
| `uuid` column type | 245 | `TEXT` — SQLite has no uuid type |
| `gen_random_uuid()` | 70 | `lower(hex(randomblob(16)))`, or generate in the app |
| `create type … as enum` | 6 | Drop the type; `TEXT NOT NULL CHECK (col IN (…))` |
| `timestamptz` | 114 | `TEXT`, ISO-8601 UTC — see §3 |
| `date` | 27 | `TEXT`, `YYYY-MM-DD`. Distinct from the above and easy to miss |
| `numeric` | **29** (only 4 with precision) | `INTEGER` paise for money, `REAL` for scores — see §3 |
| `jsonb` | 9 | `TEXT` with SQLite's `json_*()` functions |
| `bytea` | 2 | `BLOB` — both are security-relevant: `ai_key.key_encrypted`, `otp_challenge.code_hash` |
| `smallint` | 2 | `INTEGER` |
| `text[]` arrays | 5 | A child table. Never a delimited string — that is how the old tool got CSV inside cells |
| `add column if not exists` | 10 | SQLite has no `IF NOT EXISTS` for columns, and permits **one** `ADD COLUMN` per statement. 4 statements add several at once and must be split |
| `create index on …` (unnamed) | 3 | SQLite requires an index name |
| `comment on …` | 24 | No equivalent. Keep as migration comments or a `_schema_notes` table |
| `check` constraints | 44 | **Supported** — keep every one |
| `references` | 153 | **Supported**, but silently ignored unless `PRAGMA foreign_keys = ON` is set **per connection** |

A schema that declares 153 foreign keys and then ignores them is worse than one
that never claimed them. Set the pragma in the connection factory, not in the
migration.

### 2b. Does not translate — enforcement moves from the database to the API

**This is the one part of the migration that genuinely weakens a guarantee the
rest of the design leans on.** SQLite and libSQL have **no stored functions and
no procedural language**. Six functions and one trigger cannot be converted:

| Object | Kind | What it enforces today |
|---|---|---|
| `coverage_resolve` | `sql stable` | Expands a scoped coverage rule to the branch set it covers |
| `coverage_no_overlap` | **`plpgsql`** | Rejects a coverage rule that would give two people the same branch in the same role |
| `coverage_rule_no_overlap` | **trigger**, before insert/update | Runs the above on **every write**, whatever the caller |
| `may_edit_penalty_rule` | `sql stable` | Whether this actor may change this penalty rule |
| `penalty_recovery_for` | `sql stable` | Whether a rule recovers via payroll or billing |
| `pms_window_may_open` | `sql stable` | Whether a submission window may open for a person and period |
| `pms_attribute_balance` | `sql stable` | The KPI/attribute weighting split for a chair |

**The trigger is the loss that matters.** This project states throughout that
overlapping coverage is *"refused at write time"* and *"enforced by the database,
not by convention"* — and it is, today, by that trigger. It is also the condition
that leaves an escalation with two owners or none, which is the failure the
coverage model exists to prevent.

A SQLite trigger cannot readily perform the relational scope intersection
`coverage_resolve` does. So on Turso:

- The overlap check **must be reimplemented in the API**, inside the same
  transaction as the insert, with the write refused on conflict.
- That is a real reduction in guarantee: a direct database write, a migration
  script, or a second service bypasses it. Postgres could not be bypassed.
- **Mitigate, do not pretend.** Add a nightly integrity job that scans
  `coverage_rule` for overlaps and raises them as a Data setup gap, so a bypass
  is detected within a day rather than discovered by an ownerless escalation.
- The five `sql stable` functions are simpler: they are pure lookups and become
  either SQL views or small API functions. No guarantee is lost, only locality.

**If this trade is unacceptable, that is the argument for Postgres** (Supabase or
Neon) over Turso. It is a legitimate reason to choose differently, and it is the
only one in this assessment. Everything else favours Turso.

## 3. The decision that must be made first: how money is stored

`build/schema.sql` stores money as `numeric(12,2)`. **SQLite has no decimal
type**, so this must be decided rather than translated by habit.

**First, correcting myself.** My initial reasoning was that `REAL` would drift on
`revenue = mtd × rate`. I measured it before writing this, and that is wrong at
this scale:

| Operation | Measured error |
|---|---|
| `196.37 × 2760` in float | 1 × 10⁻¹⁰ |
| Summing 1,373 values of `196.37` | 4 × 10⁻⁹ |
| `revenue ÷ mtd × mtd` round trip | exactly 0 |

Those are invisible against rupees. Float precision is **not** the problem here,
and I would have been asserting a risk that does not exist.

**The real error is rounding, and it is four orders of magnitude larger.** Storing
a *derived* rate rounded to two decimals and then multiplying by it:

```
revenue 540,959.87  ÷  mtd 2,760   =  195.9999...  →  stored as 196.00
196.00 × 2,760                      =  540,960.00
                                       loss: ₹0.13 on one row
```

Thirteen paise per row, on 1,373 rows, in one direction — and it appears as a
genuine discrepancy between stored revenue and revenue recomputed from the rate.
That is exactly the kind of unexplainable gap this rebuild exists to remove, and
it has nothing to do with the storage type.

### So the decision is two decisions

**1. Never store a *newly configured* rate as a derived one — and do not drop the
153 that already exist.**

I first wrote "the derived rate is a view expression, never a column". Measured
against the shipped data, following that literally would break rate resolution:

| | |
|---|---|
| Rows in `rate` | 153 |
| …with `origin = 'DERIVED'` | **153 — all of them** |
| Trading pairs this period | 144 |
| …resolving their rate from a derived row | **101** |
| Pairs left with no rate if derived rows are dropped | **144 — every one** |

Exceptions would go from 45 to 144. That is worse than the 317→45 defect fixed in
Audit 08, and my own handover note would have caused it.

**What to actually do.** Keep the 153 derived rows in `rate`, with `origin`
retained as a first-class column, because they are the only rate the business
currently has and the MIS depends on them. The rule applies going forward:

- `origin = 'CONFIGURED'` — a commercial rate somebody agreed. Stored, versioned,
  effective-dated. This is what should exist.
- `origin = 'DERIVED'` — revenue ÷ MTD, recorded so resolution has something to
  answer with today. **Labelled everywhere it surfaces**, and it cannot validate
  revenue because it was computed from it.
- **Never round a derived rate and then multiply by it.** That is the ₹0.13-per-row
  error above. Where a derived rate must be shown, compute it at full precision on
  read from `revenue_paise ÷ mtd`; where it must be stored for resolution, store
  the unrounded value and treat it as diagnostic.
- A `CONFIGURED` rate for a client and zone **supersedes** the derived row for
  that pair from its effective date. The derived row stays in history so an
  earlier period still resolves as it did when it was reported.

So: derived rates are a documented, labelled, temporary state — not a thing to
delete, and not a thing to trust.

**2. Store money as `INTEGER` paise.**
Not for float precision, which `REAL` would survive at this scale, but because:
- **Equality and reconciliation work.** `540959.9999999999 = 540960` is false in
  every language. Integers compare and sum without an epsilon.
- **Aggregation is order-independent.** A zone total and the sum of its clients
  match by construction, not by luck.
- **It removes the temptation** to store a rounded rate, which is the error that
  actually costs money.

**Scope of this decision is larger than §2 first said.** The schema has **29
`numeric` columns, only 4 of them with declared precision** — the other 25 are
bare `numeric`, and they include every money and score column:
`penalty_rule.amount`, `penalty.amount`, `claim.amount`, `kpi_target.target_value`,
`daily_count.value` and all `pms_*` scores. All 29 need a deliberate type, not 4.

Scores are not money and should not be paise: use `REAL` for a 1–10 score, or
`INTEGER` tenths if exact comparison matters.

**Timestamps:** ISO-8601 UTC text, not epoch integers. The working-hour clock
reasons in local calendar dates (see the `isoDate()` fix in the audit log), and
text timestamps sort correctly, read plainly in a query result, and survive a dump.

## 4. On the aggregated MIS layer — do not build it yet

The instinct is right that reporting should not re-read raw rows forever. But
building it now would be premature, for three measurable reasons.

**It is not slow.** Current volume is 1,373 business rows across 13 periods.
Profiled in the prototype, the entire reporting layer — rate resolution,
grouping, weighted aggregation across every dimension — runs in **0–2 ms**. The
~850 ms per screen was DOM reconciliation, not data work. In SQLite, a
`GROUP BY` over even 100,000 rows is single-digit milliseconds.

**It reintroduces the thing this rebuild removed.** A pre-aggregated table is a
second copy of a figure that already exists. The moment a rate is corrected, a
placeholder is purged, or a source defect is fixed, every aggregate built from it
is silently wrong until rebuilt. The old system's central failure was the same
fact living in several places; a roll-up table is that pattern with better
intentions.

**The correct trigger is measurement, not anticipation.** Add it when a real
query on real volume is measurably slow, and then add it as a **cache that can be
dropped and rebuilt from source**, never as a table anyone writes to directly.

**What to do instead, now:**
- One SQL view per reporting shape (`v_mis_rows`, `v_tenday`, `v_organic`), so
  the aggregation logic lives in one place and the API just selects from it.
- Index `business_record (period, client_id, geo_node_id)` and
  `rate (client_id, geo_node_id, effective_from desc)`.
- Measure. If a view exceeds ~200 ms at realistic volume, *then* materialise that
  one view — with a documented rebuild command and a staleness timestamp shown in
  the UI.

**When it will genuinely be needed:** daily updates from ~200 people will add
roughly 60,000 rows a year. Turso handles that comfortably. The first real
pressure will come from *per-person daily history* over several years, not from
the monthly business rows — so that is the table to watch.

---

## 5. R2 — what to get right

R2 is the right choice, mainly because egress is free and these files are
downloaded repeatedly (appointment letters, signed KPI documents, partner
agreements, claim bills, visit photographs).

Three things to settle:

1. **Private bucket, signed URLs only.** No file should be reachable by guessing
   a path. A claim bill and a partner agreement are both confidential; a public
   bucket with unguessable names is not access control.
2. **Store the key, never the URL.** The database holds
   `documents/2026/09/CLM-0412/bill-1.jpg`; the API mints a short-lived signed
   URL on request. Storing a URL bakes in an expiry and a hostname.
3. **One row per file in a `document` table**, with what it belongs to, who
   uploaded it, when, and its size and type. Otherwise there is no way to answer
   "what documents does this person have" without listing a bucket — and no way
   to enforce that a person only sees their own.

Cheque images and partner agreements should carry a retention marker, since they
are the files most likely to be subject to a policy later.

---

## 6. So: are we ready?

**Yes, with this sequence.** Nothing below needs the prototype changed.

| Step | Where | Blocking on |
|---|---|---|
| 1. Confirm: money as INTEGER paise, derived rates never stored | A decision, five minutes | You — §3 |
| 2. **Decide: accept the enforcement trade, or switch to Postgres** | A decision | You \u2014 §2b is the only real argument against Turso |
| 3. ~~Translate the schema~~ **not needed** \u2014 `build/schema.sql` runs as-is | \u2014 | `build/schema.libsql.sql` kept as a fallback (\u00a79) |
| 3a. ~~Reimplement coverage-overlap in the API~~ **not needed** | \u2014 | The trigger survives on Postgres |
| 4. Create the Postgres database, run `build/schema.sql` | Claude Code | A Turso account |
| 5. Seed from `crux-data.js`, apply the change log | Claude Code | You exporting the change log |
| 6. Four-operation API + views, scope enforced in the query | Claude Code | Nothing |
| 7. `CruxDB.use({...})` | One line | Step 6 |
| 8. R2 bucket, `document` table, signed-URL endpoint | Claude Code | A Cloudflare account |
| 9. Re-run the five not-testable checks | Claude Code | Step 6 |

**Still outstanding from you, unchanged:** at least one configured commercial rate,
purging the placeholders, and exporting the change log. Those clear two of the
three readiness blockers; the third (a real adapter) clears itself at step 6.

---

## 7. Two things I would not do

**Do not serve the penalty engine, the escalation clock or the outbox from
Turso's edge replicas.** Replication is asynchronous. For a dashboard that is
fine. For anything that starts a clock or charges money it is not — two replicas
will disagree about whether a cutoff has passed, and a penalty will be applied
twice or not at all. Read-your-writes matters there; point those reads at the
primary.

**Do not let the coverage-overlap check live only in one API path.** If it is
reimplemented (§2b) it must sit in the write transaction used by *every* caller —
the API, the bulk upload, and the migration seeding — not in the one form a
person happens to use. The trigger's whole value was that it could not be
bypassed; reimplementing it in a single code path recreates the guarantee only
for the path someone remembered.

---

## 9. The migration file is written: `build/schema.libsql.sql`

Generated by transformation from `build/schema.sql`, not by hand, so nothing was
missed by fatigue. 70 KB, **86 tables**, 40 indexes, 18 alters.

**What it converted**
- 22 enum-typed columns \u2192 `text` + a `check (col in (…))` carrying the same values
- 17 `create type` statements dropped
- 245 `uuid` \u2192 `text`; 70 `gen_random_uuid()` \u2192 `lower(hex(randomblob(16)))`
- 114 `timestamptz` and 27 `date` \u2192 `text`, the latter marked `/* YYYY-MM-DD */`
- 29 `numeric` \u2192 `integer` **each marked for per-column confirmation**, because
  scores are not paise and the file must not decide that silently
- 2 `bytea` \u2192 `blob`; 2 `smallint` \u2192 `integer`; 9 `jsonb` \u2192 `text`
- 24 `comment on` \u2192 `-- NOTE` lines, so the reasoning survives
- 3 unnamed indexes given names; 4 multi-column `ADD COLUMN` split; 10
  `if not exists` on columns removed
- `pragma foreign_keys = on;` at the top, with a note that it is **per connection**

**What it refused to do silently**
- **7 not-portable blocks** \u2014 6 functions and the trigger \u2014 are commented out in
  place with the reason and a pointer to \u00a72b, rather than dropped. The trigger
  block states in full what guarantee is being lost.
- **`penalty_rule.applies_to_list text[]`** became a real child table,
  `penalty_rule_audience`, with the audience values as a check constraint and a
  commented seed statement to preserve current behaviour. A delimited string
  there is precisely how the old datastore ended up with CSV inside cells.

**Verified before writing:** no live `uuid`, `timestamptz`, `jsonb`, `bytea`,
`smallint`, `numeric(…)`, `create type`, `comment on`, unnamed index, function,
trigger or array remains; parentheses balance 807/807.

**The 29 money/score columns are now decided**, each with a deliberate default and
its reason inline, so an admin can change one knowingly:

| Kind | Type applied | Columns |
|---|---|---|
| Money | `integer` paise | 7 — `penalty_rule.amount`, `penalty_instance.amount`, `claim.amount`, `business_record.revenue`, `rate.value`, `rate_exception.configured`, `rate_exception.implied` |
| Score | `real` | 12 — every `pms_*` score, both weighting percentages, `pulse_response.score`, `kpi_eligibility.default_score`, `task.attribute_weight`, `share_pct`, `weight_pct` |
| Points | `integer` | 4 — `pms_impact.points`, `pms_adjustment.points`, `raisable.pms_points`, `kpi_eligibility.deduct_points` |
| KPI value | `real` | 5 — `target.target_value`, `target.achieved_value`, `kpi_target.target_value`, `daily_count.value`, `pms_component.raw` |

My first pass classified `rate.value` as a count. It is money — rupees per unit —
and storing a rate as a count would have rounded away the paise this whole
section argues about. Each column was then assigned individually rather than by
pattern.

**One decision still needs a person: §2b** — accept API-enforced coverage
overlap, or choose Postgres and keep the trigger.

**Step-by-step commands are in `RUNBOOK.md`.**

---

## 8. Corrections made to this document

Recorded because a handover document that has been wrong once should say so.

1. **"Never store a derived rate" would have broken rate resolution.** All 153
   rate rows are `DERIVED` and 101 of 144 trading pairs resolve from them.
   Following it literally took exceptions from 45 to 144 — worse than the defect
   fixed in Audit 08, caused by this document. §3 now scopes the rule to new
   rates and says what happens to the existing 153.
2. **"REAL would drift on revenue = mtd × rate" was unmeasured and wrong.**
   Measured error is ~10⁻¹⁰. The real error is ₹0.13 per row from rounding a
   derived rate — a different problem with a different fix.
3. **`numeric` was counted as 4 columns. It is 29**, and the 25 bare ones include
   every money and score column.
4. **§2 claimed to be "the complete list" with "nothing here is a blocker".**
   Both false: 6 stored functions, 1 trigger, `bytea`, `date`, `smallint`,
   unnamed indexes and multi-column `ADD COLUMN` were all missing, and the
   trigger is a genuine blocker to keeping a stated guarantee.


---

## 10. Decision: Postgres, not Turso — 9 Sep 2026

Delegated to me, so here is the reasoning rather than just the outcome.

### Turso's benefit is unusable where it would count

The reason to choose Turso over Postgres is edge replicas — reads served near the
user. But §7 of this document already establishes that the **penalty engine, the
escalation clock and the outbox must read the primary**, because Turso replicates
asynchronously and two replicas disagreeing about whether a cutoff has passed
means a penalty applied twice or not at all.

Those are precisely the parts of this system where correctness is not
negotiable. So the edge benefit applies only to dashboard reads — which, measured
in §4, already complete in **0–2 ms**. Optimising a 2 ms path is not worth
anything.

### Turso's cost lands on the guarantee that fixed an original defect

The `coverage_rule_no_overlap` trigger is what makes *"overlaps refused at write
time, by the database, not by convention"* true. Overlapping coverage is the
condition that leaves an escalation with two owners or none — one of the four
defects this rebuild exists to remove.

On Turso that becomes API-enforced and therefore bypassable by a direct write, a
migration, or a second service. Mitigating it needs a reimplementation in every
caller's write transaction *plus* a nightly integrity scan — new code, new
failure modes, to get back to where Postgres starts.

### Postgres removes work rather than adding it

| | Turso | Postgres |
|---|---|---|
| Schema translation | 86 tables converted, then reviewed | **None — `build/schema.sql` runs as-is** |
| 6 functions + 1 trigger | Reimplemented in the API | **Kept** |
| 29 money/score columns | Each needs a type decision | **None — `numeric(12,2)` is exact decimal** |
| Seed conversion | Rupees → paise on every money column | **None** |
| Cost | Free tier | Free tier (Supabase or Neon) |

The money question disappears entirely. Postgres `numeric` is exact decimal, so
the equality-and-reconciliation argument for integer paise does not apply —
`numeric` sums and compares exactly. That removes 29 column decisions and a
seed-time multiplication, both of which were places to introduce a rounding
error into figures this project has spent several audits making trustworthy.

**What does *not* change:** never store a rounded derived rate and multiply by
it. That was the ₹0.13-per-row error, and it is a modelling rule, not a storage
one. It applies identically on Postgres.

### What is kept

- **R2 for documents is unaffected** and remains the right choice — object
  storage is independent of the database, and free egress genuinely matters for
  files that get re-downloaded.
- **`build/schema.libsql.sql` is kept, not deleted.** If embedded or edge
  replicas ever become a real requirement — an offline field app, say — the
  translation is already done and verified. It is a documented fallback rather
  than wasted work.

### Where this would be the wrong call

If the field executives need to work offline and sync later, Turso's embedded
replicas are genuinely the better answer and this decision should be revisited.
Nothing in the current requirement says that, so it is not being designed for.


---

## 11. AWS instead? — considered, and no · 9 Sep 2026

Asked whether to host the database on AWS rather than "an outside one".

**The premise is worth correcting first: Supabase and Neon both run on AWS.**
Both provision Postgres on AWS infrastructure, including `ap-south-1` (Mumbai).
So this is not a choice between AWS and something else — it is a choice between
AWS with the operational work done for you, and AWS with the work left to you.

### Raw RDS

| | |
|---|---|
| Cost | Free tier for **12 months**, then ~$15/month minimum for `db.t4g.micro` |
| Setup | VPC, subnet group, security group, parameter group, then connect |
| Against your constraint | You specified **no paid database budget**. RDS breaks that at month 13 — the moment the tool is embedded in operations and hardest to move |
| Against your deployment answer | You said you would deploy it yourself with clear instructions. Supabase is "new project, copy connection string"; RDS is four AWS resources first |

### Aurora Serverless v2

Minimum 0.5 ACU billed continuously, ~$43/month even idle. Not appropriate for
1,373 business rows.

### DynamoDB

**Wrong shape, not just wrong price.** This is a relational model: 86 tables,
153 foreign keys, 44 check constraints, 6 stored functions and the coverage
trigger. DynamoDB would mean discarding the relational model and reimplementing
every constraint in application code — which is precisely the trade §10 rejected
for Turso, at greater cost.

### S3 instead of R2

Works, but **S3 charges egress and R2 does not**. These files get re-downloaded:
appointment letters, signed KPI documents, partner agreements, claim bills,
visit photographs. R2 stays.

### When AWS would be the right call

Genuinely, and worth watching for:

- **Your other systems already live in an AWS account** — one vendor, one bill,
  one IAM model has real operational value.
- **A client contract mandates AWS-specific residency or audit evidence.** Some
  bank empanelment terms do.
- **You outgrow the free tier's connection limits** — at which point RDS is a
  sensible upgrade path *from* Supabase, since the schema is plain Postgres and
  moves with a `pg_dump`.

That last point is the reason this is a low-risk decision: nothing here is
locked to Supabase or Neon. The schema is standard Postgres, so moving to RDS
later is a dump and restore, not a rewrite.
