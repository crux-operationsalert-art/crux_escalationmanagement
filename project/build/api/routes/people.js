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

// Hiring: the requesting manager raises it, the chain approves, HR seats the
// person. Nobody is created by a sign-in.
r.post('/request', requireChair, async (req, res, next) => {
  const { fullName, chairId, designationId, employeeType, justification } = req.body;
  try {
    if (!(await mayWriteChair(req.scope, chairId))) return res.status(403).json({ error: 'out_of_subtree' });
    const out = await tx(req.person.id, async (t) => {
      const pr = (await t.q(
        `insert into person_request (full_name, chair_id, designation_id, employee_type, justification,
                                     requested_by, created_at, due_at, stage)
         values ($1,$2,$3,$4,$5,$6, now(), now() + interval '48 hours', 'MANAGER_APPROVAL')
         returning id, due_at`,
        [fullName, chairId, designationId, employeeType || 'EMPLOYEE', justification, req.person.id]
      )).rows[0];
      await t.audit('PERSON_REQUESTED', 'chair', chairId, null, { fullName, dueAt: pr.due_at });
      return pr;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// HR seats the approved request: person row, chair_holder row, activation code.
r.post('/request/:id/seat', requireChair, async (req, res, next) => {
  try {
    if (req.person.department !== 'Human Resources' && req.person.app_role !== 'ADMIN')
      return res.status(403).json({ error: 'hr_only' });
    const { workEmail } = req.body;
    const seated = await tx(req.person.id, async (t) => {
      const pr = (await t.q(`select * from person_request where id = $1 and stage = 'HR_APPROVAL' for update`, [req.params.id])).rows[0];
      if (!pr) throw Object.assign(new Error('not_approved'), { status: 409, reason: 'This request has not reached HR approval.' });
      const p = (await t.q(
        `insert into person (full_name, work_email, designation_id, employee_type, employment_status)
         values ($1,$2,$3,$4,'ACTIVE') returning id`,
        [pr.full_name, workEmail.toLowerCase(), pr.designation_id, pr.employee_type]
      )).rows[0];
      await t.q(
        `insert into chair_holder (chair_id, person_id, is_primary, from_date) values ($1,$2,true,current_date)`,
        [pr.chair_id, p.id]
      );
      await t.q(`update person_request set stage = 'SEATED', person_id = $2 where id = $1`, [pr.id, p.id]);
      await t.audit('PERSON_SEATED', 'chair', pr.chair_id, null, { personId: p.id, email: workEmail });
      return { personId: p.id, email: workEmail.toLowerCase() };
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
         values ($1, now(), $2, $3, coalesce($4,'UNCLASSIFIED'), $5) returning id`,
        [req.params.personId, kind || 'NOTE', note, noteClass || null, req.person.id]
      )).rows[0];
      await t.audit('PERSON_NOTE_ADDED', 'person', req.params.personId, null, { kind, noteClass });
      return e;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

module.exports = r;
