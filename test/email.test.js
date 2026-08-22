/**
 * email.test.js — the send/retry lifecycle (section 37).
 *
 * The live EMAIL_LOG holds 192 rows: 181 SENT and 11 FAILED. All eleven failures
 * are the same sender-alias permission error from 19 August, all still sitting at
 * Attempt 1 despite RETRY_LIMIT being 10 -- nothing ever re-attempted them, so
 * eleven escalation, people and test emails were never delivered and nothing
 * surfaced that. These tests cover the repair.
 *
 * Run: node test/email.test.js
 */
const assert = require('assert');
const { createSandbox } = require('./gas-harness');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32mPASS\x1b[0m ' + name); pass++; }
  catch (e) { console.log('  \x1b[31mFAIL\x1b[0m ' + name + '\n         ' + e.message); fail++; }
}
function section(t) { console.log('\n' + t); }

const FILES = ['Utils.gs', 'Session.gs', 'Auth.gs', 'Clients.gs', 'Email.gs'];

/**
 * Sandbox where GmailApp.sendEmail can be made to fail on demand, so the whole
 * send -> log -> retry -> deliver path runs for real rather than being stubbed at
 * the sendEmail_ boundary.
 */
function boot() {
  const s = createSandbox({ activeUser: 'shantanu.suravase@cruxindia.co.in', files: FILES });
  s.__outbox = [];
  s.__failNext = 0;
  s.GmailApp = {
    sendEmail: (to, subject, plain, opts) => {
      if (s.__failNext > 0) {
        s.__failNext--;
        throw new Error('The script does not have permission to perform that action.');
      }
      s.__outbox.push({ to, subject, plain, html: (opts || {}).htmlBody || '' });
    },
  };
  s.appendSignatureOnce_ = (h) => h;
  s.signatureLogoBlob_ = () => null;
  s.gmailAliasAvailable_ = () => true;
  s.sentKeyIndex_ = (() => { const idx = {}; return () => idx; })();
  s.__tables.EMAIL_LOG.length = 0;
  s.setSetting_('DRY_RUN', 'false', 't');
  s.setSetting_('FROM_ADDRESS', '', 't');
  return s;
}
const logs = (s) => s.__tables.EMAIL_LOG;
const send = (s, over) => s.sendEmail_(Object.assign({
  type: 'RAISED_ESCALATION', to: ['bm@acme.example'], cc: ['cc@acme.example'],
  subject: 'Escalation ESC-00099 raised',
  htmlBody: '<p>The real escalation content that must reach the recipient.</p>',
  trigger: 'test',
}, over || {}));

/* ==================================================================== */
section('1. A successful send');

test('a good send is delivered and logged SENT', () => {
  const s = boot();
  const r = send(s);
  assert.strictEqual(r.status, 'SENT');
  assert.strictEqual(s.__outbox.length, 1);
  assert.strictEqual(logs(s).length, 1);
  assert.strictEqual(logs(s)[0].Status, 'SENT');
});

test('a successful send stores no retry body', () => {
  const s = boot();
  send(s);
  assert.strictEqual(String(logs(s)[0].RetryBody || ''), '',
    'the body must only be kept while a send is retryable');
  assert.strictEqual(String(logs(s)[0].NextRetryAt || ''), '');
});

/* ==================================================================== */
section('2. A failed send');

test('a failed send is logged FAILED with the error', () => {
  const s = boot(); s.__failNext = 1;
  const r = send(s);
  assert.strictEqual(r.status, 'FAILED');
  assert.strictEqual(logs(s)[0].Status, 'FAILED');
  assert.ok(/does not have permission/.test(logs(s)[0].Error), logs(s)[0].Error);
  assert.strictEqual(s.__outbox.length, 0, 'nothing was delivered');
});

test('a failed send keeps its body so it can be resent faithfully', () => {
  const s = boot(); s.__failNext = 1;
  send(s);
  assert.ok(/real escalation content/.test(logs(s)[0].RetryBody),
    'the original body must be captured');
  assert.ok(String(logs(s)[0].NextRetryAt || '').length > 0, 'a retry must be scheduled');
});

/* ==================================================================== */
section('3. Retry resends the ORIGINAL message');

test('a retry delivers the original body, not a placeholder', () => {
  const s = boot(); s.__failNext = 1;
  send(s);
  const res = s.retryEmail_({ logId: logs(s)[0].LogID }, null);
  assert.strictEqual(res.status, 'SENT');
  assert.strictEqual(s.__outbox.length, 1);
  assert.ok(/real escalation content/.test(s.__outbox[0].html),
    'the retry sent: ' + s.__outbox[0].html.slice(0, 120));
  assert.ok(!/See original log/.test(s.__outbox[0].html),
    'the old code sent a placeholder line and marked the row SENT');
});

test('a retry preserves the recipients and subject', () => {
  const s = boot(); s.__failNext = 1;
  send(s);
  s.retryEmail_({ logId: logs(s)[0].LogID }, null);
  assert.strictEqual(s.__outbox[0].to, 'bm@acme.example');
  assert.strictEqual(s.__outbox[0].subject, 'Escalation ESC-00099 raised');
});

test('a successful retry marks the original row and drops the stored body', () => {
  const s = boot(); s.__failNext = 1;
  send(s);
  const id = logs(s)[0].LogID;
  s.retryEmail_({ logId: id }, null);
  const row = s.findRowById_('EMAIL_LOG', 'LogID', id);
  assert.strictEqual(row.Status, 'SENT');
  assert.strictEqual(Number(row.Attempt), 2);
  assert.strictEqual(String(row.RetryBody || ''), '');
  assert.strictEqual(String(row.NextRetryAt || ''), '');
});

test('a retry that fails again schedules a later attempt and keeps the body', () => {
  const s = boot(); s.__failNext = 2;
  send(s);
  const id = logs(s)[0].LogID;
  s.retryEmail_({ logId: id }, null);
  const row = s.findRowById_('EMAIL_LOG', 'LogID', id);
  assert.strictEqual(row.Status, 'FAILED');
  assert.strictEqual(Number(row.Attempt), 2);
  assert.ok(/real escalation content/.test(row.RetryBody), 'the body must survive');
  assert.ok(String(row.NextRetryAt || '').length > 0);
});

test('an already-sent message is not resent', () => {
  const s = boot();
  send(s);
  const r = s.retryEmail_({ logId: logs(s)[0].LogID }, null);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(s.__outbox.length, 1, 'no duplicate delivery');
});

/* ==================================================================== */
section('4. The retry limit');

test('retries stop at RETRY_LIMIT and the row is marked abandoned', () => {
  const s = boot();
  s.setSetting_('RETRY_LIMIT', '3', 't');
  s.__failNext = 99;
  send(s);
  const id = logs(s)[0].LogID;
  for (let i = 0; i < 6; i++) { try { s.retryEmail_({ logId: id }, null); } catch (e) {} }
  const row = s.findRowById_('EMAIL_LOG', 'LogID', id);
  assert.ok(Number(row.Attempt) <= 3, 'attempts must not exceed the limit, got ' + row.Attempt);
  assert.ok(/abandoned after/.test(row.Error), row.Error);
  assert.strictEqual(String(row.RetryBody || ''), '', 'an abandoned row stops being retried');
});

test('an abandoned message still reports as FAILED, so it is never silent', () => {
  const s = boot();
  s.setSetting_('RETRY_LIMIT', '2', 't');
  s.__failNext = 99;
  send(s);
  const id = logs(s)[0].LogID;
  for (let i = 0; i < 5; i++) { try { s.retryEmail_({ logId: id }, null); } catch (e) {} }
  const row = s.findRowById_('EMAIL_LOG', 'LogID', id);
  assert.strictEqual(row.Status, 'FAILED',
    'a new FAILED_FINAL status would drop it from every dashboard and the digest');
});

test('abandonment is written to the audit trail', () => {
  const s = boot();
  s.setSetting_('RETRY_LIMIT', '2', 't');
  s.__failNext = 99;
  send(s);
  const id = logs(s)[0].LogID;
  for (let i = 0; i < 5; i++) { try { s.retryEmail_({ logId: id }, null); } catch (e) {} }
  assert.ok(s.__tables.AUDIT_LOG.some(r => r.Action === 'EMAIL_ABANDONED'));
});

/* ==================================================================== */
section('5. The automatic sweep');

test('the sweep resends everything that is due', () => {
  const s = boot(); s.setSetting_('RETRY_LIMIT', '5', 't');
  s.__failNext = 3;
  send(s, { subject: 'one', idempotencyKey: 'k1' });
  send(s, { subject: 'two', idempotencyKey: 'k2' });
  send(s, { subject: 'three', idempotencyKey: 'k3' });
  assert.strictEqual(logs(s).filter(r => r.Status === 'FAILED').length, 3);
  logs(s).forEach(r => { r.NextRetryAt = ''; });        // all due now
  const out = s.retryFailedEmails_();
  assert.strictEqual(out.attempted, 3);
  assert.strictEqual(out.sent, 3);
  assert.strictEqual(logs(s).filter(r => r.Status === 'FAILED').length, 0);
  assert.strictEqual(s.__outbox.length, 3);
});

test('the sweep does not touch a retry that is not yet due', () => {
  const s = boot(); s.__failNext = 1;
  send(s);
  // NextRetryAt was set to five minutes out by the failed send.
  const out = s.retryFailedEmails_();
  assert.strictEqual(out.attempted, 0, 'backoff must be respected');
});

test('the sweep is bounded per tick so an outage cannot burn the daily quota', () => {
  const s = boot(); s.setSetting_('RETRY_LIMIT', '9', 't');
  s.__failNext = 99;
  for (let i = 0; i < 12; i++) send(s, { idempotencyKey: 'k' + i });
  logs(s).forEach(r => { r.NextRetryAt = ''; });
  const out = s.retryFailedEmails_();
  assert.strictEqual(out.attempted, s.EMAIL_RETRY_PER_TICK,
    'expected at most ' + s.EMAIL_RETRY_PER_TICK + ' per tick, got ' + out.attempted);
});

test('the sweep skips rows with no captured body rather than sending a placeholder', () => {
  const s = boot(); s.__failNext = 1;
  send(s);
  logs(s)[0].RetryBody = '';
  logs(s)[0].NextRetryAt = '';
  assert.strictEqual(s.retryFailedEmails_().attempted, 0);
  assert.strictEqual(s.__outbox.length, 0);
});

/* ==================================================================== */
section('6. Against the real EMAIL_LOG');

test('the live log shows exactly the failure pattern this repairs', () => {
  const s = createSandbox({ activeUser: 'x', files: FILES });
  const rows = s.readTable_('EMAIL_LOG');
  assert.ok(rows.length > 150, 'expected the real log, got ' + rows.length);
  const failed = rows.filter(r => r.Status === 'FAILED');
  assert.ok(failed.length > 0, 'expected the recorded failures');
  failed.forEach(r => assert.strictEqual(Math.round(Number(r.Attempt)), 1,
    'every live failure is still on attempt 1: nothing ever retried them'));
  console.log('         (' + failed.length + ' failures, all at attempt 1, of ' +
    rows.length + ' sends)');
});

test('none of the live failures carry a body, so they need re-running not retrying', () => {
  const s = createSandbox({ activeUser: 'x', files: FILES });
  const failed = s.readTable_('EMAIL_LOG').filter(r => r.Status === 'FAILED');
  failed.forEach(r => assert.strictEqual(String(r.RetryBody || ''), '',
    'rows predating the fix have no captured body'));
});

/* ==================================================================== */
console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
