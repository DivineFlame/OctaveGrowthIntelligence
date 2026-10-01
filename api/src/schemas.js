// Request-body validation schemas, pulled out of server.js so they can be
// unit tested directly (server.js itself connects to Postgres/Redis and
// calls app.listen() as a side effect of being required, so it can't
// safely be `require()`d from a test - see api/test/ and README.md
// "Hardening notes"). Behavior is unchanged from the inline `schemas`
// object these replaced; only the location moved. Used via the validate()
// middleware in server.js.
const { z } = require('zod');

const schemas = {
  createUser: z.object({
    email: z.string().trim().toLowerCase().email().max(255),
    password: z.string().min(12).max(200),
    role: z.string().trim().min(1).max(50),
    // Who this user reports to - drives both the reporting hierarchy and
    // (see hierarchy.js) their inherited product/service access. Optional/
    // nullable: a brand new user can be created at the top of the chain
    // (no reporting head yet) and assigned one afterward via PATCH
    // /users/:userId/reports-to.
    reports_to: z.string().uuid().optional().nullable()
  }),
  updateReportsTo: z.object({
    reports_to: z.string().uuid().nullable()
  }),
  // Bulk "Assign to" action in the Inbox (Manager/Admin only) - the only
  // way a lead becomes visible to one of the Manager's reports, per the
  // spec's bulk-only design (reuses the same multi-select UI as
  // bulk-delete rather than a per-lead picker).
  bulkAssignLeads: z.object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    assigned_to: z.string().uuid()
  }),
  createProduct: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable()
  }),
  // Deleting a Product/Service permanently removes its channels, members,
  // uploaded content and leads too (see DELETE /products/:id) - requiring
  // the caller to retype the product's exact current name is a
  // deliberate extra confirmation step for something this destructive and
  // irreversible, the same "type the name to confirm" pattern other tools
  // use for deleting a whole project/repo, not just a single record.
  deleteProduct: z.object({
    confirm_name: z.string().trim().min(1).max(200)
  }),
  addProductMember: z.object({
    user_id: z.string().uuid(),
    role: z.enum(['ADMIN', 'MEMBER']).optional()
  }),
  configureChannel: z.object({
    channel: z.string().trim().min(1).max(30),
    config: z.record(z.any()).optional()
  }),
  // createLlmConnection/createAgent/updateAgent removed along with the
  // Agents feature's routes/UI (see README.md "Hardening notes" - deferred
  // to a future version; the underlying agents/llm_connections/
  // product_agents/agent_runs tables are untouched, so re-adding this is a
  // routes/UI change, not a new migration).
  approveVariant: z.object({
    action: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGE']),
    comment: z.string().trim().max(2000).optional()
  }),
  // Keep this enum in sync with PRODUCT_CHANNELS in server.js - a variant's
  // `channel` has to equal one of those values, or the internal publish
  // route (POST /internal/content-variants/:variantId/publish) can never
  // find the matching product_channels row for it.
  transformContent: z.object({
    channels: z.array(z.enum(['whatsapp', 'facebook', 'instagram', 'linkedin', 'youtube', 'email'])).min(1).max(6).optional() // web_form is inbound-only (see api/src/channels.js) - nothing to generate a content variant for, so it's deliberately not a valid transform target
  }),
  replyToLead: z.object({
    body: z.string().trim().min(1).max(5000),
    channel: z.string().trim().max(20).optional(),
    // WhatsApp replies always send a Meta-approved template (see
    // channels.js's publishWhatsApp comment) - the composer sends the
    // chosen template's name plus the values for its {{1}}, {{2}}, ...
    // placeholders; `body` above still carries the rendered preview text
    // for the thread's own display/history.
    template_name: z.string().trim().min(1).max(200).optional(),
    template_params: z.array(z.string().trim().max(500)).max(10).optional()
  }),
  // Bulk-delete for the Inbox's "select and delete" action - capped at
  // 100 so one request can't be used to walk the whole leads table.
  deleteSelectedLeads: z.object({
    ids: z.array(z.string().uuid()).min(1).max(100)
  }),
  // "Find leads" in the Leads screen (POST /leads/discover) - a plain
  // search term plus an optional free-text location, run against
  // whatever lead-discovery provider is configured via env vars (see
  // lead-generation.js). max_results is capped independently again in
  // lead-generation.js (HARD_MAX_RESULTS) - the limit here just keeps an
  // obviously-bad request from reaching that module at all.
  discoverLeads: z.object({
    query: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).optional(),
    product_id: z.string().uuid().optional().nullable(),
    max_results: z.number().int().min(1).max(100).optional()
  })
};

module.exports = schemas;
