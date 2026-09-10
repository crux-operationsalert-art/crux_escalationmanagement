// People, chairs, the hiring chain, and the org chart the prototype reads.
const { Router } = require('express');
const { one, many, tx } = require('../db');
const { requireChair, mayWriteChair } = require('../scope');
const { issueActivation } = require('../auth');
const { enqueue } = require('../outbox');

const r = Router();

r.get('/me', (req, res) => {
  if (!req.person) return res.status(401).json({ error: 'sign_in_required' });
  res.json({ person: req.person, chairs: req.scope.chairs, primaryChair: req.scope.primaryChair, clientView: req.scope.clientView });
});

// The org chart. chair_status is a view, so the risk badge is never a stored
// number that drifted.
r.get('/org', requireChair, async (req, res) => {
  const rows = await many(
    `select ch.id, ch.code, ch.title, ch.parent_id,
            p.id as person_id, p.full_name, d.title as designation,
            s.state, s.overdue_days, s.vacant
       from chair ch
       left join chair_holder chh on chh.chair_id = ch.id and chh.to_date is null and chh.is_primary
       left join person p on p.id = chh.person_id
       left join designation d on d.id = p.designation_id
       left join chair_status s on s.chair_id = ch.id
      order by ch.title`
  );
  res.json({ chairs: rows });
});

r.get('/team', requireChair, async (req, res) => {
  if (!req.scope.subtreeIds.length) return res.json({ team: [] });
  const rows = await many(
    `select ch.id as chair_id, ch.title, p.id as person_id, p.full_name, p.work_email,
            s.state, s.overdue_days
       from chair ch
       left join chair_holder chh on chh.chair_id = ch.id and chh.to_date is null and chh.is_primary
       left join person p on p.id = chh.person_id
       left join chair_status s on s.chair_id = ch.id
      where ch.id = any($1) and ch.id <> $2
      order by ch.title`,
    [req.scope.subtreeIds, req.scope.primaryChair.id]
  );
  res.json({ team: rows });
});

// Adding a person: the manager raises it, HR approves the chair and terms, the
// administrator creates the account. Nobody is created by a sign-in.
//
// This is NOT the hire requisition (headcount against a chair, which carries a
// justification and a Finance approval) — that is a separate flow. A person
// request already names the person, so the work e-mail is captured here at
// raise time, not later at seating. The designation is carried by the chair.
r.post('/request', requireChair, async (req, res, next) => {
  const { fullName, workEmail, chairId, managerId, employeeType } = req.body;
  try {
    if (!(await mayWriteChair(req.scope, chairId))) return res.status(403).json({ error: 'out_of_subtree' });
    if (!fullName || !workEmail)
      return res.status(400).json({ error: 'name_and_email_required',
        reason: 'A person request names the person and their work address; HR approves against both.' });

    const out = await tx(req.person.id, async (t) => {
      const pr = (await t.q(
        `insert into person_request
           (full_name, work_email, chair_id, manager_id, requested_by, employee_type, state, due_at)
         values ($1, lower($2), $3, coalesce($4::uuid, $5::uuid), $5::uuid,
                 coalesce($6,'EMPLOYEE'), 'AWAITING_HR', now() + interval '48 hours')
         returning id, due_at, state`,
        [fullName, workEmail, chairId, managerId || null, req.person.id, employeeType || null]
      )).rows[0];
      await t.audit('PERSON_REQUESTED', 'chair', chairId, null,
        { fullName, workEmail: String(workEmail).toLowerCase(), dueAt: pr.due_at });
      return pr;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// HR approves the chair and the terms. Without this step nothing ever reaches
// the administrator, so the queue's 'Approve chair' action lands here.
r.post('/request/:id/approve', requireChair, async (req, res, next) => {
  try {
    if (req.person.department !== 'Human Resources' && req.person.app_role !== 'ADMIN')
      return res.status(403).json({ error: 'hr_only', reason: 'HR approves the chair and the terms.' });
    const out = await tx(req.person.id, async (t) => {
      const pr = (await t.q(
        `update person_request set state = 'AWAITING_ADMIN', hr_by = $2, hr_at = now()
          where id = $1 and state = 'AWAITING_HR'
          returning id, full_name, chair_id, state`,
        [req.params.id, req.person.id]
      )).rows[0];
      if (!pr) throw Object.assign(new Error('not_awaiting_hr'), { status: 409,
        reason: 'This request is not waiting on HR.' });
      await t.audit('PERSON_REQUEST_HR_APPROVED', 'chair', pr.chair_id, { state: 'AWAITING_HR' },
        { state: 'AWAITING_ADMIN' });
      return pr;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// The administrator creates the account once HR has approved: person row,
// chair_holder row, activation code. The address is the one HR approved on the
// request — it is not re-supplied here, so nobody can seat a different mailbox
// than the one that was reviewed.
r.post('/request/:id/seat', requireChair, async (req, res, next) => {
  try {
    if (req.person.app_role !== 'ADMIN')
      return res.status(403).json({ error: 'admin_only',
        reason: 'HR approves the chair; the administrator creates the account.' });
    const seated = await tx(req.person.id, async (t) => {
      const pr = (await t.q(
        `select * from person_request where id = $1 and state = 'AWAITING_ADMIN' for update`,
        [req.params.id])).rows[0];
      if (!pr) throw Object.assign(new Error('not_approved'), { status: 409,
        reason: 'This request has not been approved by HR yet.' });
      // manager_id carries the reporting line: RLS resolves a manager's subtree
      // through person.manager_id, so a person seated without it sees nobody.
      const p = (await t.q(
        `insert into person (full_name, work_email, manager_id, employee_type, employment_status)
         values ($1, lower($2), $3, $4, 'ACTIVE') returning id`,
        [pr.full_name, pr.work_email, pr.manager_id, pr.employee_type || 'EMPLOYEE']
      )).rows[0];
      await t.q(
        `insert into chair_holder (chair_id, person_id, is_primary, from_date) values ($1,$2,true,current_date)`,
        [pr.chair_id, p.id]
      );
      await t.q(
        `update person_request set state = 'ACTIVE', admin_by = $3, admin_at = now(), person_id = $2
          where id = $1`,
        [pr.id, p.id, req.person.id]);
      await t.audit('PERSON_SEATED', 'chair', pr.chair_id, { state: 'AWAITING_ADMIN' },
        { state: 'ACTIVE', personId: p.id, email: pr.work_email });
      return { personId: p.id, email: String(pr.work_email).toLowerCase() };
    });
    const code = await issueActivation(seated.personId, req.person.id);
    await enqueue(req.person.id, {
      templateKey: 'ACTIVATION', recipient: seated.email,
      entityType: 'person', entityId: seated.personId,
      subject: 'Activate your Crux account', body: { code },
    });
    res.status(201).json({ personId: seated.personId });
  } catch (e) { next(e); }
});

// Notes on a person. The 449 rescued notes live here too, and a note is
// classified before it can feed an Attribute score.
r.post('/:personId/note', requireChair, async (req, res, next) => {
  const { kind, note, noteClass } = req.body;
  try {
    const out = await tx(req.person.id, async (t) => {
      const e = (await t.q(
        `insert into person_event (person_id, at, kind, note, note_class, actor_id)
         values ($1, now(), $2, $3, coalesce($4::note_class,'UNCLASSIFIED'), $5) returning id`,
        [req.params.personId, kind || 'NOTE', note, noteClass || null, req.person.id]
      )).rows[0];
      await t.audit('PERSON_NOTE_ADDED', 'person', req.params.personId, null, { kind, noteClass });
      return e;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

module.exports = r;
