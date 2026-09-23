// Unit tests for api/src/rbac.js - see its header comment for why these
// were pulled out of server.js. canGrantRole() in particular is the fix
// for a real, previously-exploitable bug (see README.md "Hardening
// notes": originally "Cross-tenant privilege escalation via role
// assignment", kept as a safety rule after removing multi-tenancy - see
// rbac.js's own comment) - this file exists so that fix has a fast,
// direct test pinning it, not just the manual verification it originally
// shipped with.
const test = require('node:test');
const assert = require('node:assert/strict');
const { userClaims, hasRoleOrFlag, canGrantRole } = require('../src/rbac');

test('userClaims shapes only the expected fields and coerces booleans', () => {
  const claims = userClaims({
    id: 'u1', role: 'DEPT_ADMIN', email: 'a@b.com',
    max_history_days: 90, can_view_revenue: 1, can_view_integrations: 0, can_approve_content: null,
    password_hash: 'should-never-appear-in-a-jwt' // extra DB field a real user row would have
  });
  assert.deepEqual(claims, {
    id: 'u1', role: 'DEPT_ADMIN', email: 'a@b.com',
    max_history_days: 90, can_view_revenue: true, can_view_integrations: false, can_approve_content: false
  });
  assert.equal('password_hash' in claims, false, 'userClaims must not leak fields it was not given, like a password hash');
  assert.equal('tenant_id' in claims, false, 'userClaims must not carry a tenant_id any more (multi-tenancy removed)');
});

test('userClaims defaults max_history_days to null when unset (not 0/undefined)', () => {
  const claims = userClaims({ id: 'u1', role: 'SUPER_ADMIN', email: 'a@b.com' });
  assert.equal(claims.max_history_days, null, 'SUPER_ADMIN/IT_ADMIN store NULL for unlimited history, not 0');
});

test('userClaims treats max_history_days of 0 as 0, not null (nullish coalescing, not ||)', () => {
  const claims = userClaims({ id: 'u1', role: 'X', email: 'a@b.com', max_history_days: 0 });
  assert.equal(claims.max_history_days, 0);
});

test('hasRoleOrFlag allows a role that is directly in the allowed list', () => {
  assert.equal(hasRoleOrFlag('SUPER_ADMIN', ['SUPER_ADMIN', 'IT_ADMIN'], undefined), true);
});

test('hasRoleOrFlag denies a role that is neither in the list nor has the flag', () => {
  assert.equal(hasRoleOrFlag('CONTENT_CREATOR', ['SUPER_ADMIN', 'IT_ADMIN'], false), false);
});

test('hasRoleOrFlag allows a role outside the list when its per-role flag is set', () => {
  // The whole point of roleOrFlag() in server.js: an Admin can grant a
  // role like HR_ADMIN the can_view_integrations flag via PATCH
  // /users/:userId/role, and that role should then pass this check even
  // though it's not one of the hardcoded ['SUPER_ADMIN', 'IT_ADMIN'].
  assert.equal(hasRoleOrFlag('HR_ADMIN', ['SUPER_ADMIN', 'IT_ADMIN'], true), true);
});

test('canGrantRole blocks a non-Super-Admin from granting the Super Admin role', () => {
  // Regression test for the privilege-escalation fix this closed - even
  // with multi-tenancy removed, IT_ADMIN and DEPT_ADMIN share
  // USER_MANAGER_ROLES with SUPER_ADMIN (so they can manage users at all),
  // and without this check either could still mint themselves or an
  // accomplice the company's single top role.
  assert.equal(canGrantRole('IT_ADMIN', 'SUPER_ADMIN'), false);
  assert.equal(canGrantRole('DEPT_ADMIN', 'SUPER_ADMIN'), false);
  assert.equal(canGrantRole('APPROVER', 'SUPER_ADMIN'), false);
});

test('canGrantRole allows a Super Admin to grant the Super Admin role', () => {
  assert.equal(canGrantRole('SUPER_ADMIN', 'SUPER_ADMIN'), true);
});

test('canGrantRole allows granting any non-Super-Admin role regardless of caller', () => {
  // IT_ADMIN already has the same permission flags as SUPER_ADMIN in the
  // roles table, so IT_ADMIN granting IT_ADMIN (or any other role) doesn't
  // cross a privilege boundary the way minting a SUPER_ADMIN does - only
  // the SUPER_ADMIN role itself is gated.
  for (const role of ['IT_ADMIN', 'DEPT_ADMIN', 'APPROVER', 'CONTENT_CREATOR', 'HR_ADMIN', 'SALES_LEAD']) {
    assert.equal(canGrantRole('IT_ADMIN', role), true, `IT_ADMIN should be able to grant ${role}`);
    assert.equal(canGrantRole('DEPT_ADMIN', role), true, `DEPT_ADMIN should be able to grant ${role}`);
  }
});
