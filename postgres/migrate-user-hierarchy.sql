-- User reporting hierarchy + per-lead assignment.
--
-- Admin creates users and sets who reports to whom (users.reports_to);
-- that chain is also how a user's product/service access is resolved -
-- live, not copied - see resolveEffectiveProductIds() in
-- api/src/hierarchy.js. Nullable: NULL means "top of the chain" (a
-- company-wide Admin, or a user not yet assigned a reporting head).
-- ON DELETE SET NULL rather than CASCADE - deleting a manager should
-- orphan their reports back to the top, not delete/disable them too
-- (this app has no user-delete route today, only disable, but the FK
-- shouldn't assume that stays true forever).
ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_reports_to ON users(reports_to);

-- Which user a lead has been assigned to (bulk "Assign to" action in the
-- Inbox, by a Manager/Admin - see POST /leads/bulk-assign). NULL = not yet
-- assigned - visible only to the Manager/Admin who can see the whole
-- product's Inbox, not to their non-manager reports (see GET /leads'
-- visibility filter in server.js). ON DELETE SET NULL so disabling/
-- reassigning a departing user's account doesn't delete the leads they
-- were working.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);
