// D7: the chair, not the person, drives everything.
// D8: no chair may borrow another chair's data. A read with no scope returns an
// empty set and a reason — never a fallback to somebody else's dashboard.
const { many, one } = require('./db');

// The chairs a person currently occupies, with the subtree each one owns.
async function chairsFor(personId) {
  return many(
    `select ch.id, ch.code, ch.title, ch.parent_id, chh.is_primary
       from chair_holder chh
       join chair ch on ch.id = chh.chair_id
      where chh.person_id = $1 and chh.to_date is null
      order by chh.is_primary desc, ch.title`,
    [personId]
  );
}

// Every chair at or below a given chair. This is what "my team" means, and it
// is also the write boundary for KPI targets and PMS adjustments.
async function subtree(chairId) {
  return many(
    `with recursive t as (
        select id from chair where id = $1
        union all
        select c.id from chair c join t on c.parent_id = t.id)
      select id from t`,
    [chairId]
  );
}

// The branches a person may see, from coverage_rule only. Two people with the
// same designation and different coverage see different branches; that is the
// point.
async function branchScope(personId) {
  return many(
    `select distinct b.id, b.code, b.name, b.client_id, b.status
       from coverage_rule r
       cross join lateral coverage_resolve(r) cr(branch_id)
       join branch b on b.id = cr.branch_id
      where r.person_id = $1
        and (r.effective_to is null or r.effective_to >= current_date)`,
    [personId]
  );
}

// HR sees people and never client data; Operations owns the matrix; Finance and
// Compliance get branch details and contacts only. Driven by the table, so a
// policy change is a row, not a deploy.
async function clientViewKind(personId) {
  const r = await one(
    `select coalesce(p2.view_kind, 'none') as view_kind
       from person p
       left join client_view_policy p2 on p2.department = p.department
      where p.id = $1`,
    [personId]
  );
  return r ? r.view_kind : 'none';
}

// Attached to every request. Handlers read req.scope and never re-derive it.
function middleware() {
  return async (req, res, next) => {
    if (!req.person) return next();
    try {
      const [chairs, clientView] = await Promise.all([
        chairsFor(req.person.id),
        clientViewKind(req.person.id),
      ]);
      const primary = chairs.find((c) => c.is_primary) || chairs[0] || null;
      req.scope = {
        personId: req.person.id,
        chairs,
        primaryChair: primary,
        clientView,
        chairIds: chairs.map((c) => c.id),
        subtreeIds: primary ? (await subtree(primary.id)).map((r) => r.id) : [],
        branchIds: null, // resolved lazily; 1,413 rows is cheap but not free
        async branches() {
          if (!this.branchIds) this.branchIds = await branchScope(req.person.id);
          return this.branchIds;
        },
      };
      next();
    } catch (e) { next(e); }
  };
}

// The empty state says why it is empty. A new chair with no coverage yet is a
// real, expected condition — it is not an error and it is not somebody else's data.
function emptyReason(scope) {
  if (!scope) return 'Not signed in.';
  if (!scope.chairs.length) return 'You do not hold a chair yet. Ask HR to seat you before this page can show anything.';
  return 'This chair has no coverage assigned. Operations assigns coverage; nothing is shown until it does.';
}

function requireChair(req, res, next) {
  if (!req.scope || !req.scope.chairs.length)
    return res.status(403).json({ error: 'no_chair', reason: emptyReason(req.scope) });
  next();
}

// Write guard: may this request touch this chair?
async function mayWriteChair(scope, chairId) {
  if (!scope) return false;
  if (scope.chairIds.includes(chairId)) return true;
  return scope.subtreeIds.includes(chairId);
}

module.exports = { chairsFor, subtree, branchScope, clientViewKind, middleware, requireChair, mayWriteChair, emptyReason };
