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

// "Elevated" roles - the two company-wide Admins (SUPER_ADMIN/IT_ADMIN)
// plus DEPT_ADMIN (Manager, who gets real authority over whichever
// product(s) they're a member of via product_members). Mirrors
// USER_ADMIN_ROLES + DEPT_ADMIN in server.js - kept as a plain array here
// rather than imported, to avoid a require cycle between rbac.js and
// server.js; if that set changes there, update this one too (rbac.test.js
// pins the exact set so a drift shows up as a failing test).
const ELEVATED_ROLES = ['SUPER_ADMIN', 'IT_ADMIN', 'DEPT_ADMIN'];

// True if `callerRole` is allowed to grant `targetRoleName` to someone
// (via POST /users or PATCH /users/:userId/role). Two rules:
//  1. Only a Super Admin can grant the Super Admin role - kept as a
//     safety rule even after removing multi-tenancy (see README
//     "Hardening notes" - this originally closed a cross-tenant
//     privilege-escalation bug; with one company left, the same check
//     still stops IT_ADMIN from minting themselves or an accomplice the
//     top role).
//  2. Only SUPER_ADMIN/IT_ADMIN can grant any ELEVATED_ROLES value at all
//     (including DEPT_ADMIN/"Manager"). This closes a gap the
//     user-hierarchy feature would otherwise open: HR_ADMIN was added to
//     POST /users' allowed callers so HR can do its one stated job ("User
//     Creation"), but HR_ADMIN is a much lower-privileged role than the
//     old USER_MANAGER_ROLES set that used to gate this route - without
//     this check, HR could mint a brand-new IT_ADMIN or DEPT_ADMIN
//     account outright. Granting any *non*-elevated role (HR_ADMIN,
//     SALES_LEAD, CONTENT_CREATOR, APPROVER) is unrestricted by caller,
//     same as before.
function canGrantRole(callerRole, targetRoleName) {
  if (targetRoleName === 'SUPER_ADMIN' && callerRole !== 'SUPER_ADMIN') return false;
  if (ELEVATED_ROLES.includes(targetRoleName) && !['SUPER_ADMIN', 'IT_ADMIN'].includes(callerRole)) return false;
  return true;
}

module.exports = { userClaims, hasRoleOrFlag, canGrantRole, ELEVATED_ROLES };
