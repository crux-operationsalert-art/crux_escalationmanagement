# AWS INFRASTRUCTURE — decisions and handoff

> **Phase 2.** Supabase runs the business now — see `build/supabase/DEPLOY.md`.
> AWS is the final home, and the move is a button in the product (Data setup
> → Move to AWS) backed by `build/api/migrate.js`. Nothing below changes; it
> is simply the second phase rather than the first.

Supersedes the Supabase/Neon + R2 plan in `RUNBOOK.md` §1–2. Everything from
§3 onward in that file (schema, seed, verification queries) still applies.

Decisions below were taken by the user across five rounds on 10 Sep 2026.
Nothing here is my inference — where a value is still open it says so.

---

## 1. Platform decisions

| Decision | Choice |
|---|---|
| Region | `ap-south-1` (Mumbai) |
| Account age | Over 12 months — no free tier, paid instances |
| Network | New VPC, two private subnets in different AZs |
| Database | RDS Postgres, **Multi-AZ** synchronous standby |
| Backup retention | **35 days** (maximum automated) |
| Read replica | No — single writer, revisit if reporting slows filing |
| API host | EC2, one small instance |
| Environments | Production + staging |
| Staging data | Real data, copied nightly, **same access list as production** |
| Object storage | S3 (replaces Cloudflare R2) |
| DNS / TLS | Route 53 + ACM — **domain still to be supplied** |
| Executor | Claude Code, scripted; user approves each step |
| Budget ceiling | $300–500 / month |

**Still open:** the domain name and its current DNS host, and who holds
create rights for RDS, S3, Route 53 and ACM. Neither blocks provisioning
the database and API — only the public hostname and certificate.

**Turso token:** rotated by the user. No further action.

---

## 2. Zero data loss — what actually delivers it

The requirement was stated as mandatory. Three mechanisms carry it, and they
protect against different failures.

**Multi-AZ synchronous standby.** Every committed write lands in a second
availability zone before the database confirms it. An instance or AZ failure
loses nothing committed. This is the reason for roughly half the monthly cost.

**35-day point-in-time recovery.** Protects against damage rather than
failure — a bad migration, a wrong bulk upload, a mistaken mass delete.
Recovers to any second in the window.

**Device-side queue.** The likeliest way a day's count disappears is not the
server. It is a field executive on patchy mobile data who taps submit and
walks away. The client writes the filing to local storage first, confirms to
the person that it is *queued*, and syncs when connectivity returns. Nothing
is considered filed until the server acknowledges, and the person can see
which of their filings are still waiting.

---

## 3. Business rules settled during the interview

These are application rules, not infrastructure, and they need to be encoded
in the API rather than left to the UI.

**Late sync.** A filing entered offline counts for the day it was *entered*,
provided it reaches the server within 24 hours. The entry timestamp comes
from the device and is stored alongside the server receipt time; both are
kept, and a filing whose device clock is implausible is flagged rather than
trusted.

**Beyond 24 hours.** Rejected at the API. It then follows the same reopen
path as any locked day: system administrator only. Note this is a single
person for the whole company — see the risk below.

**Late penalty.** Rule P-01 (₹200) applies regardless of cause, including a
genuine network failure. It is **disputable**, and the device sync log
attaches to the dispute automatically so the reviewer sees whether the phone
actually tried and failed.

**Corrections.** When a reopened day's figure changes, the table is
overwritten and the audit log stores **the previous value**, not merely the
fact of change. A disputed number always has an earlier version to compare
against.

**Restatement.** Roll-ups and reports restate silently when a late filing
lands. Exports carry no generation timestamp, by choice.

---

## 4. Cost estimate

Monthly, `ap-south-1`, on-demand. Estimates, not quotes.

| Item | Approx. |
|---|---|
| RDS `db.t4g.medium` Postgres, Multi-AZ | $120 |
| RDS storage, 100 GB gp3, Multi-AZ | $25 |
| Backup storage beyond allocated (35 days) | $10 |
| Staging RDS `db.t4g.small`, single-AZ | $30 |
| Staging storage, 50 GB | $10 |
| EC2 `t4g.medium` production API | $24 |
| EC2 `t4g.small` staging API | $12 |
| NAT gateway (private subnets need it) | $32 |
| Application Load Balancer | $18 |
| S3 documents + requests | $5 |
| Route 53 hosted zone + queries | $1 |
| **Total** | **≈ $287** |

Inside the $300–500 ceiling with room for growth. Three ways to cut if
needed: drop staging to on-demand start/stop (−$30), replace the NAT gateway
with a NAT instance (−$25), or run the API on the same subnet as the ALB and
drop the NAT entirely (−$32, at the cost of isolation).

---

## 5. Two risks worth naming

**Single administrator for reopens.** Every offline filing older than 24
hours, across every branch and franchise, unblocks through one person. When
he is on leave, field staff cannot get a missed day reopened at all. The user
chose this deliberately after being shown the alternatives. Recommend
revisiting after the first month of real usage — the volume will settle the
argument.

**Real appraisal data in staging.** The nightly copy carries live PMS scores,
salaries and penalty amounts. Access is restricted to the production list,
which contains the exposure, but the copy still doubles the number of places
that data exists. The nightly job should run into an encrypted snapshot
restore, not a `pg_dump` sitting on a developer machine.

---

## 6. Build order for Claude Code

Each step verifiable before the next. Stop and report on any failure.

**Phase 1 — Supabase, now.** `build/supabase/DEPLOY.md`, steps 1–7. The
application runs on it while AWS is built.

**Phase 2 — AWS, below.** Can be built in parallel; nothing here disturbs the
live Supabase instance until the cutover stage.

1. **VPC** — new, `10.0.0.0/16`, two public and two private subnets across
   `ap-south-1a` and `ap-south-1b`. NAT gateway in one public subnet.
   *Verify:* private subnet route table points 0.0.0.0/0 at the NAT.

2. **RDS Postgres** — `db.t4g.medium`, Multi-AZ, 100 GB gp3, 35-day backups,
   encryption at rest, in the private subnet group. No public accessibility.
   *Verify:* `SELECT 1` from an EC2 instance in the VPC; failover test with
   `reboot --force-failover` and confirm the endpoint recovers.

3. **Schema and seed** — run the migration and seed from `RUNBOOK.md` §3–4.
   *Verify:* the verification queries in §6 of that file return the expected
   row counts.

4. **EC2 API** — `t4g.medium`, private subnet, ALB in front. Secrets from
   Secrets Manager, never in the AMI or the repo.
   *Verify:* health endpoint through the ALB; connection pool holds steady
   under a simulated 50-concurrent-filing burst.

5. **S3** — `crux-documents`, versioning on, public access blocked, lifecycle
   to Infrequent Access at 90 days.
   *Verify:* presigned upload and download round-trip.

6. **Staging** — same stack, single-AZ, smaller instances. Nightly snapshot
   restore from production.
   *Verify:* restore completes and staging reports the same row counts as
   production did at snapshot time.

7. **Route 53 + ACM** — blocked on the domain. Do steps 1–6 without it and
   reach the API by ALB hostname in the interim.

8. **Point the app at it** — not a config change this time. Run the six stages
   behind Data setup → Move to AWS, in order. Stages 1–5 build and verify a
   copy while Supabase keeps serving; stage 6 cuts over and will not unlock
   until row counts and content checksums match on every table. Supabase stays
   read-only for 30 days afterwards as the fallback.

---

## 7. What Claude Code must not do

- Never write credentials into the repo. `.env` in `.gitignore` before the
  first commit; runtime secrets from Secrets Manager.
- Never make the RDS instance publicly accessible, even temporarily.
- Never apply a bulk upload partially. A file with any error applies zero
  rows — this is already the stated contract in the application and the API
  must honour it.
- Never hard-delete a KPI filing. Corrections overwrite the current row and
  write the previous value into the audit log.
