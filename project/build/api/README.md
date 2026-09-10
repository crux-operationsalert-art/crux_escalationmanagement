# crux-api — P0 persistence layer

Node + Express against `build/schema.sql`. No ORM: the unique indexes and
triggers in the schema *are* the rebuild, and an ORM that upserts around them
would undo it.

## Run
```
export DATABASE_URL=postgres://…            # Supabase free tier
npm install
npm run db:schema && npm run db:migrate && npm run db:gate
npm start          # API on :3000
npm run worker     # chase, auto-close, outbox drain
```

## What each file is for
| File | Defect it answers |
|---|---|
| `outbox.js` | **Defect 1.** `idempotencyKey()` is derived, never passed in; `outbox_idempotency_uniq` makes a duplicate physically impossible. `drain()` claims with `FOR UPDATE SKIP LOCKED` and stops at the daily cap. |
| `scope.js` | **D7/D8.** Every read is scoped by chair and `coverage_rule`. No scope returns an empty set *with a sentence saying why* — never a fallback to another chair's data. |
| `auth.js` | **Defect 3.** Sessions are rows that expire and revoke. No standing tokens. Sign-in *matches* a person; it never creates one. |
| `db.js` | Every write runs in `tx()`, which carries the actor, so an audit row cannot commit without its change. |
| `worker.js` | Chases are scheduled off `next_chase_at` (R-03), not swept for. Legacy jobs arrive disabled with a reason, and the worker honours that. |

## Environment
`DATABASE_URL` · `GOOGLE_CLIENT_ID` · `WORKSPACE_DOMAIN` · `GMAIL_SA_EMAIL` ·
`GMAIL_SA_KEY` · `MAIL_FROM=operations.alert@…` · `MAIL_DAILY_CAP` (default 1500) ·
`CHASE_HOURS` (default 24) · `CORS_ORIGINS` · `WORKER_INTERVAL_MS`.

## Not done here
- **Templates.** `renderBody()` is a one-liner; the `template` table drives it in P1.
- **Schema columns this code assumes and `schema.sql` does not yet declare:**
  `auth_session.token_hash`, `person.password_hash`/`password_salt`,
  `outbox.attempts`/`last_error`, `escalation_action.sets_status`/`valid_statuses`,
  `setting(key,value)`, `working_hours_after(ts, hours)`,
  `pms_adjustment.over_cap`, `person_event.note_class`/`actor_id`,
  `daily_count` unique on `(person_id, count_date)`, `kpi_target` unique on `(kpi_id, period)`.
  These are additive; they need one more schema patch before this runs.
- **WhatsApp** and the AI recommendation engine.
- Nothing in the prototype calls these endpoints yet. `Crux App v2.dc.html` is
  still self-contained, by design — wiring it is the next step, and it should be
  wired one module at a time against a loaded pilot database, not all at once.
