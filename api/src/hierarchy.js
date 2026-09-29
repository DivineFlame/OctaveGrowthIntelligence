// User reporting hierarchy: who reports to whom (users.reports_to), and
// the two things that chain drives - cascading block/unblock and
// "effective" product/service access - pulled out into their own,
// side-effect-free-ish module (same reasoning as rbac.js: server.js can't
// be require()'d in a test, so logic worth unit testing directly lives
// here instead). Every function takes a `pool`-like object
// ({query(text, params)}) as its first argument rather than importing
// api/src/db.js directly, so tests can pass a fake in-memory one instead
// of needing a real Postgres connection.
//
// The company-wide Admins: the only roles that bypass the reporting
// chain entirely and see/manage every product unconditionally. server.js
// imports this directly (as hierarchy.ADMIN_ROLES) rather than keeping
// its own copy, so there's exactly one source of truth for "who's an
// Admin" across product access, lead access, and user/reports-to admin
// rights (USER_ADMIN_ROLES there is this set plus DEPT_ADMIN, since a
// Manager keeps lead-management rights but not these).
const ADMIN_ROLES = ['SUPER_ADMIN', 'IT_ADMIN'];

// Guards against a corrupted or (despite wouldCreateCycle being enforced
// on every write) somehow-cyclic reports_to chain looping forever - 50
// is far beyond any real org chart this app will ever see.
const MAX_CHAIN_DEPTH = 50;

// Every user who directly or transitively reports to `userId` - not
// including `userId` itself. Used by cascading block (disabling someone
// disables every descendant immediately) and by cycle prevention when
// setting reports_to (a user can't be made to report to their own
// descendant - that would disconnect them from the rest of the company
// and/or create an unresolvable loop for resolveEffectiveProductIds()
// below).
async function getDescendantUserIds(pool, userId) {
  const descendants = [];
  const visited = new Set([userId]);
  let frontier = [userId];
  while (frontier.length) {
    const { rows } = await pool.query('SELECT id FROM users WHERE reports_to = ANY($1::uuid[])', [frontier]);
    const next = [];
    for (const row of rows) {
      if (visited.has(row.id)) continue; // belt-and-suspenders against bad existing data - shouldn't happen if every write goes through wouldCreateCycle
      visited.add(row.id);
      descendants.push(row.id);
      next.push(row.id);
    }
    frontier = next;
  }
  return descendants;
}

// True if setting `userId`'s reports_to to `candidateHeadId` would create
// a cycle - candidateHeadId is userId itself, or is already one of
// userId's descendants. Called before every reports_to write.
async function wouldCreateCycle(pool, userId, candidateHeadId) {
  if (!candidateHeadId) return false;
  if (candidateHeadId === userId) return true;
  const descendants = await getDescendantUserIds(pool, userId);
  return descendants.includes(candidateHeadId);
}

// A user's effective product/service access, resolved live rather than
// stored: their own product_members rows if they have any directly (this
// is how a Manager - or anyone else an Admin explicitly assigned - gets
// scoped to specific product(s)), otherwise walk up their reports_to
// chain until landing on someone who does, or on a company-wide Admin
// (implicitly every product), or running out of chain. Returns `null` to
// mean "every product" (Admin), or an array of product_id strings
// otherwise (possibly empty, meaning no access at all - e.g. a brand new
// user with no reports_to set yet and no direct assignment).
//
// Deliberately live, not copied onto the user once: a Manager gaining or
// losing a product immediately changes what every descendant can see,
// with no sync step anywhere else in the app.
async function resolveEffectiveProductIds(pool, userId) {
  const visited = new Set();
  let currentId = userId;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    if (!currentId || visited.has(currentId)) return []; // dead end, or a cycle slipping through despite wouldCreateCycle - fail closed, not open
    visited.add(currentId);

    const { rows: userRows } = await pool.query('SELECT id, role, reports_to FROM users WHERE id=$1', [currentId]);
    if (!userRows.length) return [];
    const user = userRows[0];

    if (ADMIN_ROLES.includes(user.role)) return null;

    const { rows: memberRows } = await pool.query('SELECT product_id FROM product_members WHERE user_id=$1', [currentId]);
    if (memberRows.length) return memberRows.map((r) => r.product_id);

    currentId = user.reports_to;
  }
  return [];
}

module.exports = { ADMIN_ROLES, MAX_CHAIN_DEPTH, getDescendantUserIds, wouldCreateCycle, resolveEffectiveProductIds };
