// P0, ahead of everything else (decision D3).
// The storm: 1,892 STRIKE_1 sends, 1,889 to one person, for one open case, over
// nine days, from 77 idempotency keys — because uniqueness was a convention.
// Here the key is a unique index and enqueue is the only way to send.
const crypto = require('crypto');
const { q, one, many, tx } = require('./db');

const DAILY_CAP = Number(process.env.MAIL_DAILY_CAP || 1500);   // Gmail cap, minus headroom
const BATCH = Number(process.env.MAIL_BATCH || 100);
const SPREAD_ABOVE = 1200;                                       // D4: one window below this

// The key is derived, never passed in. Same event + same recipient + same day
// = same key = one row, forever. This single function is the fix for defect 1.
function idempotencyKey({ templateKey, recipient, entityType, entityId, period }) {
  const basis = [templateKey, String(recipient).toLowerCase(), entityType, entityId, period || dayStamp()].join('|');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 40);
}
const dayStamp = (d = new Date()) => d.toISOString().slice(0, 10);

// Returns {queued:true} or {queued:false, reason:'duplicate'} — never throws on
// a duplicate, because a caller retrying is normal and must be harmless.
async function enqueue(actorId, msg) {
  const key = idempotencyKey(msg);
  const r = await one(
    `insert into outbox (idempotency_key, template_key, recipient, subject, body, entity_type, entity_id, not_before, state)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8, now()), 'QUEUED')
     on conflict (idempotency_key) do nothing
     returning id`,
    [key, msg.templateKey, String(msg.recipient).toLowerCase(), msg.subject, msg.body,
     msg.entityType, msg.entityId, msg.notBefore || null]
  );
  if (!r) return { queued: false, reason: 'duplicate', key };
  return { queued: true, id: r.id, key };
}

// A run claims rows with FOR UPDATE SKIP LOCKED, so two workers cannot send the
// same row and neither holds a lock the other waits on. STRIKE_SWEEP held the
// script lock for 1,690 runs; nothing here can.
async function drain(send) {
  const day = dayStamp();
  const budget = await one(
    `insert into mail_budget (day, recipients_sent) values ($1, 0)
     on conflict (day) do update set recipients_sent = mail_budget.recipients_sent
     returning recipients_sent`,
    [day]
  );
  let remaining = DAILY_CAP - budget.recipients_sent;
  if (remaining <= 0) return { sent: 0, held: 'daily_cap_reached' };

  const run = await one(
    `insert into job_run (job_key, started_at, state) values ('OUTBOX_DRAIN', now(), 'RUNNING') returning id`
  );
  let sent = 0, failed = 0;

  try {
    for (;;) {
      if (remaining <= 0) break;
      const rows = await many(
        `with claimed as (
           select id from outbox
            where state = 'QUEUED' and not_before <= now()
            order by not_before
            limit least($1, $2)
            for update skip locked)
         update outbox o set state = 'SENDING', attempts = o.attempts + 1
          from claimed c where o.id = c.id
         returning o.*`,
        [BATCH, remaining]
      );
      if (!rows.length) break;

      for (const m of rows) {
        try {
          const res = await send(m);
          await q(`update outbox set state = 'SENT', sent_at = now() where id = $1`, [m.id]);
          await q(
            `insert into delivery (outbox_id, at, channel, recipient, state, entity_type, entity_id)
             values ($1, now(), 'EMAIL', $2, 'SENT', $3, $4)`,
            [m.id, m.recipient, m.entity_type, m.entity_id]
          );
          sent++; remaining--;
          if (res && res.messageId) { /* provider id kept in delivery.error=null path */ }
        } catch (e) {
          failed++;
          const dead = m.attempts >= 4 || /invalid|not found|no such user/i.test(e.message);
          await q(
            `update outbox set state = $2, last_error = $3,
                    not_before = case when $2 = 'QUEUED' then now() + (power(3, o.attempts) || ' minutes')::interval else not_before end
               from outbox o where outbox.id = $1 and o.id = $1`,
            [m.id, dead ? 'FAILED' : 'QUEUED', e.message.slice(0, 300)]
          );
          await q(
            `insert into delivery (outbox_id, at, channel, recipient, state, error, entity_type, entity_id)
             values ($1, now(), 'EMAIL', $2, 'FAILED', $3, $4, $5)`,
            [m.id, m.recipient, e.message.slice(0, 300), m.entity_type, m.entity_id]
          );
        }
      }
      await q(`update mail_budget set recipients_sent = recipients_sent + $2 where day = $1`, [day, sent]);
    }
    await q(`update job_run set finished_at = now(), state = $2, note = $3 where id = $1`,
      [run.id, sent || failed ? 'OK' : 'NOOP', `sent=${sent} failed=${failed}`]);
  } catch (e) {
    await q(`update job_run set finished_at = now(), state = 'ERROR', note = $2 where id = $1`, [run.id, e.message]);
    throw e;
  }
  return { sent, failed };
}

// MONTHLY_DISPATCH succeeded once, ever. It now enqueues in one pass against
// dispatch_eligible_branch_v2 and spreads over days only above 1,200 recipients.
async function planMonthlyDispatch(actorId, period) {
  const targets = await many(
    `select e.branch_id, e.client_id, m.email, m.name
       from dispatch_eligible_branch_v2 e
       join branch_effective_matrix m on m.branch_id = e.branch_id and m.level = 1
      where coalesce(btrim(m.email),'') <> ''`
  );
  const spread = targets.length > SPREAD_ABOVE;
  let queued = 0, duplicates = 0;
  for (const [i, t] of targets.entries()) {
    const notBefore = spread ? new Date(Date.now() + Math.floor(i / SPREAD_ABOVE) * 864e5) : null;
    const r = await enqueue(actorId, {
      templateKey: 'MONTHLY_DISPATCH', recipient: t.email,
      entityType: 'branch', entityId: t.branch_id, period,
      subject: 'Monthly register — ' + period, body: null, notBefore,
    });
    r.queued ? queued++ : duplicates++;
  }
  await tx(actorId, (t) => t.audit('MONTHLY_DISPATCH_PLANNED', 'period', period,
    null, { eligible: targets.length, queued, duplicates, spread }));
  return { eligible: targets.length, queued, duplicates, spread };
}

module.exports = { enqueue, drain, planMonthlyDispatch, idempotencyKey, DAILY_CAP };
