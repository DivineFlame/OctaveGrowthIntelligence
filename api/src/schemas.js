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
    role: z.string().trim().min(1).max(50)
  }),
  createProduct: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable()
  }),
  addProductMember: z.object({
    user_id: z.string().uuid(),
    role: z.enum(['ADMIN', 'MEMBER']).optional()
  }),
  configureChannel: z.object({
    channel: z.string().trim().min(1).max(30),
    config: z.record(z.any()).optional()
  }),
  createLlmConnection: z.object({
    name: z.string().trim().min(1).max(100),
    provider: z.string().trim().min(1).max(30),
    api_key: z.string().min(1).max(2000),
    base_url: z.string().trim().url().max(500).optional()
  }),
  createAgent: z.object({
    name: z.string().trim().min(1).max(100),
    llm_connection_id: z.string().uuid(),
    model: z.string().trim().max(100).optional().nullable(),
    system_prompt: z.string().max(20000).optional().nullable(),
    config: z.record(z.any()).optional()
  }),
  updateAgent: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().max(100).optional().nullable(),
    system_prompt: z.string().max(20000).optional().nullable(),
    config: z.record(z.any()).optional(),
    active: z.boolean().optional()
  }),
  approveVariant: z.object({
    action: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGE']),
    comment: z.string().trim().max(2000).optional()
  }),
  // Keep this enum in sync with PRODUCT_CHANNELS in server.js - a variant's
  // `channel` has to equal one of those values, or the internal publish
  // route (POST /internal/content-variants/:variantId/publish) can never
  // find the matching product_channels row for it.
  transformContent: z.object({
    channels: z.array(z.enum(['whatsapp', 'facebook', 'instagram', 'linkedin', 'youtube', 'quora', 'email'])).min(1).max(7).optional()
  }),
  replyToLead: z.object({
    body: z.string().trim().min(1).max(5000),
    channel: z.string().trim().max(20).optional()
  })
};

module.exports = schemas;
