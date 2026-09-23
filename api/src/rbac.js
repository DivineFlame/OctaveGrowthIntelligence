// Pure role/permission decision logic, pulled out of server.js so it's
// unit testable directly - see api/test/ and README.md "Hardening notes"
// for why server.js itself can't safely be require()'d in a test. These
// functions take plain values (a role string, a roles array, a flag
// value) and return a plain answer; server.js's middleware/route handlers
// wrap them with the actual req/res/audit-log side effects.

// What every JWT access/refresh token actually carries as its claims.
// Baked in at login/signup/refresh time (rather than looked up from the
// roles table on every request) so a route can read req.user.can_view_revenue
// etc. without a DB round trip - see server.js's authMiddleware. No
// tenant_id any more (single company - see README "Hardening notes" on
// removing multi-tenancy); every user simply belongs to the one company.
function userClaims(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    max_history_days: user.max_history_days ?? null,
    can_view_revenue: !!user.can_view_revenue,
    can_view_integrations: !!user.can_view_integrations,
    can_approve_content: !!user.can_approve_content
  };
}

// True if `userRole` is in `allowedRoles`, OR (when `flag` is given and
// truthy on the user) their per-role flag from the roles table grants it -
// lets a role the hardcoded allowedRoles list doesn't name still qualify
// if an Admin has granted it that flag via PATCH /users/:userId/role,
// without loosening anyone else. Used by server.js's roleOrFlag()
// middleware factory.
function hasRoleOrFlag(userRole, allowedRoles, flagValue) {
  return allowedRoles.includes(userRole) || !!flagValue;
}

// True if `callerRole` is allowed to grant `targetRoleName` to someone
// (via POST /users or PATCH /users/:userId/role). Only a Super Admin can
// grant the Super Admin role - kept as a safety rule even after removing
// multi-tenancy (see README "Hardening notes" - this originally closed a
// cross-tenant privilege-escalation bug; with one company left, the same
// check still stops IT_ADMIN/DEPT_ADMIN from minting themselves or an
// accomplice the top role). Every other role transition (including
// IT_ADMIN/DEPT_ADMIN granting each other's roles) is left to the
// caller's existing USER_MANAGER_ROLES check, since the roles table
// already gives IT_ADMIN the same permission flags as SUPER_ADMIN.
function canGrantRole(callerRole, targetRoleName) {
  if (targetRoleName === 'SUPER_ADMIN' && callerRole !== 'SUPER_ADMIN') return false;
  return true;
}

module.exports = { userClaims, hasRoleOrFlag, canGrantRole };
