// One process, one loop, no script lock. STRIKE_SWEEP ran 1,690 times, 1,535 of
// them NOOP, holding the lock the whole while. Everything here is scheduled by
// a due-at column and claimed with SKIP LOCKED.
const { q, many, one, tx } = require('./db');
const outbox = require('./outbox');

const send = async (m) => {
  // Gmail API via the operations.alert@ service account (mandatory sender).
  const { google } = require('googleapis');
  const auth = new google.auth.JWT({
    email: process.env.GMAIL_SA_EMAIL,
    key: (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: process.env.MAIL_FROM,
  });
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = Buffer.from(
    `From: ${process.env.MAIL_FROM}\r\nTo: ${m.recipient}\r\nSubject: ${m.subject || ''}\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n\r\n` + renderBody(m)
  ).toString('base64url');
  const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { messageId: r.data.id };
};

const renderBody = (m) => `<p>${m.template_key}</p>`; // templates table drives this in P1

async function runJob(key, fn) {
  const cfg = await one(`select enabled, disabled_reason from job_config where job_key = $1`, [key]);
  if (cfg && !cfg.enabled) return console.log('[worker] %s disabled: %s', key, cfg.disabled_reason);
  const run = await one(`insert into job_run (job_key, started_at, state) values ($1, now(), 'RUNNING') returning id`, [key]);
  try {
    const note = await fn();
    await q(`update job_run set finished_at = now(), state = $2, note = $3 where id = $1`,
      [run.id, note && note.did ? 'OK' : 'NOOP', JSON.stringify(note || {})]);
  } catch (e) {
    await q(`update job_run set finished_at = now(), state = 'ERROR', note = $2 where id = $1`, [run.id, e.message]);
    console.error('[worker] %s failed', key, e.message);
  }
}

// R-03: chases are scheduled, never swept for. This selects only what is due.
const chase = () => runJob('CASE_CHASE', async () => {
  const due = await many(
    `select c.id, c.ref, c.strike_count, c.branch_id, m.email
       from "case" c
       left join branch_effective_matrix m on m.branch_id = c.branch_id and m.level = least(c.strike_count + 1, 5)
      where c.status in ('OPEN','IN_PROGRESS') and c.next_chase_at <= now()
      for update of c skip locked
      limit 200`
  );
  let queued = 0;
  for (const c of due) {
    if (c.email) {
      const r = await outbox.enqueue(null, {
        templateKey: 'STRIKE_' + (c.strike_count + 1), recipient: c.email,
        entityType: 'case', entityId: c.id, period: c.ref + ':S' + (c.strike_count + 1),
        subject: c.ref + ' — reminder ' + (c.strike_count + 1),
      });
      if (r.queued) queued++;
    }
    await q(
      `update "case" set strike_count = strike_count + 1,
              next_chase_at = working_hours_after(now(), $2), last_activity_at = now()
        where id = $1`,
      [c.id, Number(process.env.CHASE_HOURS || 24)]
    );
  }
  return { did: due.length > 0, due: due.length, queued };
});

// R-05: auto-close 7 days after resolution.
const autoClose = () => runJob('CASE_AUTOCLOSE', async () => {
  const r = await q(
    `update "case" set status = 'CLOSED', last_activity_at = now()
      where status = 'RESOLVED' and auto_close_at <= now() returning ref`
  );
  for (const row of r.rows)
    await tx(null, (t) => t.audit('CASE_AUTOCLOSED', 'case', row.ref, { status: 'RESOLVED' }, { status: 'CLOSED' }));
  return { did: r.rowCount > 0, closed: r.rowCount };
});

const drain = () => runJob('OUTBOX_DRAIN', async () => {
  const r = await outbox.drain(send);
  return { did: r.sent > 0, ...r };
});

async function tick() {
  await chase();
  await autoClose();
  await drain();
}

if (require.main === module) {
  const every = Number(process.env.WORKER_INTERVAL_MS || 60_000);
  tick().finally(() => setInterval(tick, every));
  console.log('crux worker, every %dms', every);
}
module.exports = { tick, send };
