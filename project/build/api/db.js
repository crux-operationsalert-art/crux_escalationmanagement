// Postgres only. No ORM: the constraints in schema.sql are the product, and an
// ORM that "helpfully" retries or upserts around a unique index would undo the
// one thing this rebuild is for.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 8,                     // Supabase free tier: keep well under the cap
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
});

pool.on('error', (e) => console.error('[db] idle client error', e.message));

async function q(text, params) {
  const t0 = Date.now();
  const r = await pool.query(text, params);
  const ms = Date.now() - t0;
  if (ms > 500) console.warn('[db] slow %dms %s', ms, text.slice(0, 90).replace(/\s+/g, ' '));
  return r;
}

// Every write path runs in a transaction that also carries the actor, so an
// audit row can never be committed without the change it describes.
async function tx(actorId, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('select set_config($1, $2, true)', ['crux.actor_id', actorId || '']);
    const out = await fn({
      q: (t, p) => c.query(t, p),
      audit: (action, entityType, entityRef, oldV, newV) =>
        c.query(
          `insert into audit_entry (actor_id, action, entity_type, entity_ref, old_value, new_value)
           values ($1,$2,$3,$4,$5,$6)`,
          [actorId || null, action, entityType, entityRef, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null]
        ),
    });
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const one = async (text, params) => (await q(text, params)).rows[0] || null;
const many = async (text, params) => (await q(text, params)).rows;

module.exports = { pool, q, tx, one, many };
