// Unit tests for api/src/hierarchy.js - reporting-chain resolution
// (descendants, cycle detection, effective product access), using a tiny
// fake in-memory "pool" instead of a real Postgres connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDescendantUserIds, wouldCreateCycle, resolveEffectiveProductIds } = require('../src/hierarchy');

// A fake pool whose query() understands exactly the three query shapes
// hierarchy.js actually issues - enough to drive these functions without
// a real database.
function makeFakePool({ users = [], memberships = {} } = {}) {
  return {
    async query(text, params) {
      if (text.includes('FROM users WHERE reports_to = ANY')) {
        const parents = new Set(params[0]);
        return { rows: users.filter((u) => parents.has(u.reports_to)).map((u) => ({ id: u.id })) };
      }
      if (text.includes('SELECT id, role, reports_to FROM users WHERE id=$1')) {
        const u = users.find((u) => u.id === params[0]);
        return { rows: u ? [u] : [] };
      }
      if (text.includes('SELECT product_id FROM product_members WHERE user_id=$1')) {
        const ids = memberships[params[0]] || [];
        return { rows: ids.map((product_id) => ({ product_id })) };
      }
      throw new Error(`unexpected query in test: ${text}`);
    }
  };
}

// admin -> manager -> { hr, social, rep1, rep2 } ; rep1 -> sub1 (a deeper report)
const USERS = [
  { id: 'admin', role: 'SUPER_ADMIN', reports_to: null },
  { id: 'manager', role: 'DEPT_ADMIN', reports_to: 'admin' },
  { id: 'hr', role: 'HR_ADMIN', reports_to: 'manager' },
  { id: 'social', role: 'CONTENT_CREATOR', reports_to: 'manager' },
  { id: 'rep1', role: 'SALES_LEAD', reports_to: 'manager' },
  { id: 'rep2', role: 'SALES_LEAD', reports_to: 'manager' },
  { id: 'sub1', role: 'SALES_LEAD', reports_to: 'rep1' }
];
const MEMBERSHIPS = { manager: ['prod-a', 'prod-b'] };

test('getDescendantUserIds returns every direct and transitive report, not the user themselves', async () => {
  const pool = makeFakePool({ users: USERS });
  const descendants = await getDescendantUserIds(pool, 'manager');
  assert.deepEqual(new Set(descendants), new Set(['hr', 'social', 'rep1', 'rep2', 'sub1']));
  assert.ok(!descendants.includes('manager'));
});

test('getDescendantUserIds returns an empty list for a leaf user with no reports', async () => {
  const pool = makeFakePool({ users: USERS });
  assert.deepEqual(await getDescendantUserIds(pool, 'sub1'), []);
});

test('wouldCreateCycle is false for a normal, non-conflicting reassignment', async () => {
  const pool = makeFakePool({ users: USERS });
  assert.equal(await wouldCreateCycle(pool, 'rep2', 'admin'), false);
});

test('wouldCreateCycle rejects making a user report to themselves', async () => {
  const pool = makeFakePool({ users: USERS });
  assert.equal(await wouldCreateCycle(pool, 'manager', 'manager'), true);
});

test('wouldCreateCycle rejects making a user report to their own descendant', async () => {
  const pool = makeFakePool({ users: USERS });
  // manager reporting to sub1 (a grandchild via rep1) would disconnect the
  // whole branch into a loop - must be rejected.
  assert.equal(await wouldCreateCycle(pool, 'manager', 'sub1'), true);
});

test('wouldCreateCycle allows clearing the reporting head (null)', async () => {
  const pool = makeFakePool({ users: USERS });
  assert.equal(await wouldCreateCycle(pool, 'rep1', null), false);
});

test('resolveEffectiveProductIds returns null ("every product") for a company-wide Admin role', async () => {
  const pool = makeFakePool({ users: USERS, memberships: MEMBERSHIPS });
  assert.equal(await resolveEffectiveProductIds(pool, 'admin'), null);
});

test('resolveEffectiveProductIds returns a user\'s own product_members rows when they have any, without walking further up', async () => {
  const pool = makeFakePool({ users: USERS, memberships: MEMBERSHIPS });
  assert.deepEqual(await resolveEffectiveProductIds(pool, 'manager'), ['prod-a', 'prod-b']);
});

// The core of the feature as specified: HR/Social Media/other reports have
// no product_members row of their own at all - their access is always
// exactly whatever their manager currently has, resolved live.
test('resolveEffectiveProductIds walks up to the nearest ancestor with direct product_members for a report with none of their own', async () => {
  const pool = makeFakePool({ users: USERS, memberships: MEMBERSHIPS });
  assert.deepEqual(await resolveEffectiveProductIds(pool, 'hr'), ['prod-a', 'prod-b']);
  assert.deepEqual(await resolveEffectiveProductIds(pool, 'social'), ['prod-a', 'prod-b']);
});

test('resolveEffectiveProductIds keeps walking through multiple levels of inheritance', async () => {
  const pool = makeFakePool({ users: USERS, memberships: MEMBERSHIPS });
  // sub1 -> rep1 (no products) -> manager (has products)
  assert.deepEqual(await resolveEffectiveProductIds(pool, 'sub1'), ['prod-a', 'prod-b']);
});

test('resolveEffectiveProductIds returns an empty array (no access) for a user with no reports_to and no direct assignment', async () => {
  const pool = makeFakePool({ users: [{ id: 'orphan', role: 'SALES_LEAD', reports_to: null }], memberships: {} });
  assert.deepEqual(await resolveEffectiveProductIds(pool, 'orphan'), []);
});

test('resolveEffectiveProductIds returns an empty array for a nonexistent user id rather than throwing', async () => {
  const pool = makeFakePool({ users: USERS, memberships: MEMBERSHIPS });
  assert.deepEqual(await resolveEffectiveProductIds(pool, 'ghost'), []);
});

test('resolveEffectiveProductIds fails closed on a cyclic chain instead of looping forever', async () => {
  const cyclic = [
    { id: 'a', role: 'SALES_LEAD', reports_to: 'b' },
    { id: 'b', role: 'SALES_LEAD', reports_to: 'a' }
  ];
  const pool = makeFakePool({ users: cyclic, memberships: {} });
  assert.deepEqual(await resolveEffectiveProductIds(pool, 'a'), []);
});
