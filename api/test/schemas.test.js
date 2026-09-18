// Unit tests for api/src/schemas.js - the zod validation schemas the
// validate() middleware in server.js runs request bodies through. These
// are pure (no DB/network), so they can be tested directly the same way
// server.js's route handlers were verified by hand throughout this
// project's "Hardening notes" - except now it's a test that keeps
// checking it, not a one-time manual check.

const test = require('node:test');
const assert = require('node:assert/strict');
const schemas = require('../src/schemas');

test('createTenant accepts a valid payload and normalizes the subdomain', () => {
  const result = schemas.createTenant.safeParse({ name: 'Acme', subdomain: 'ACME-Corp', plan: 'standard' });
  assert.ok(result.success);
  assert.equal(result.data.subdomain, 'acme-corp', 'subdomain should be lowercased');
});

test('createTenant rejects a subdomain with characters outside [a-z0-9-]', () => {
  const result = schemas.createTenant.safeParse({ name: 'Acme', subdomain: 'acme corp!', plan: 'standard' });
  assert.equal(result.success, false);
});

test('createTenant rejects an unknown plan', () => {
  const result = schemas.createTenant.safeParse({ name: 'Acme', subdomain: 'acme', plan: 'enterprise' });
  assert.equal(result.success, false, 'plan must be exactly "standard" or "premium"');
});

test('createUser enforces the 12-character minimum password length', () => {
  const short = schemas.createUser.safeParse({ email: 'a@b.com', password: 'short1234567', role: 'DEPT_ADMIN' });
  assert.equal(short.success, true, 'sanity check: 12 chars should pass');
  const tooShort = schemas.createUser.safeParse({ email: 'a@b.com', password: 'short12345', role: 'DEPT_ADMIN' });
  assert.equal(tooShort.success, false, '10 chars should fail the min(12) rule');
});

test('createUser normalizes email to lowercase and rejects a malformed one', () => {
  const ok = schemas.createUser.safeParse({ email: 'Someone@EXAMPLE.com', password: 'a-long-enough-password', role: 'MEMBER' });
  assert.ok(ok.success);
  assert.equal(ok.data.email, 'someone@example.com');

  const bad = schemas.createUser.safeParse({ email: 'not-an-email', password: 'a-long-enough-password', role: 'MEMBER' });
  assert.equal(bad.success, false);
});

test('createUser does not require tenant_id, but rejects a non-UUID one', () => {
  const withoutTenant = schemas.createUser.safeParse({ email: 'a@b.com', password: 'a-long-enough-password', role: 'MEMBER' });
  assert.ok(withoutTenant.success);

  const badTenant = schemas.createUser.safeParse({ email: 'a@b.com', password: 'a-long-enough-password', role: 'MEMBER', tenant_id: 'not-a-uuid' });
  assert.equal(badTenant.success, false);
});

test('addProductMember requires a UUID user_id and restricts role to ADMIN/MEMBER', () => {
  assert.equal(schemas.addProductMember.safeParse({ user_id: 'not-a-uuid' }).success, false);
  assert.ok(schemas.addProductMember.safeParse({ user_id: '11111111-1111-1111-1111-111111111111' }).success);
  assert.equal(
    schemas.addProductMember.safeParse({ user_id: '11111111-1111-1111-1111-111111111111', role: 'OWNER' }).success,
    false,
    'role must be exactly ADMIN or MEMBER, nothing else'
  );
});

test('transformContent only accepts the canonical channel vocabulary', () => {
  // Pins the same channel-vocabulary bug covered from the other side in
  // channels.test.js (CHANNEL_SPECS keys) - transformContent's enum here
  // is a second, independently-maintained copy of that same list (the
  // comment above it in schemas.js explains why it can't just import
  // CHANNEL_SPECS directly), so this test exists to catch the two drifting
  // apart again the way they did before this codebase's channel-vocabulary
  // fix.
  const ok = schemas.transformContent.safeParse({ channels: ['whatsapp', 'email'] });
  assert.ok(ok.success);

  const bad = schemas.transformContent.safeParse({ channels: ['instagram-feed'] }); // the old, disconnected vocabulary
  assert.equal(bad.success, false);

  const empty = schemas.transformContent.safeParse({ channels: [] });
  assert.equal(empty.success, false, 'min(1) - an empty channel list is meaningless');
});

test('transformContent channels field is optional (defaults handled by the route, not the schema)', () => {
  assert.ok(schemas.transformContent.safeParse({}).success);
});

test('createLlmConnection requires a non-empty api_key and a valid base_url when given', () => {
  assert.equal(schemas.createLlmConnection.safeParse({ name: 'x', provider: 'openai', api_key: '' }).success, false);
  assert.ok(schemas.createLlmConnection.safeParse({ name: 'x', provider: 'openai', api_key: 'sk-abc' }).success);
  assert.equal(
    schemas.createLlmConnection.safeParse({ name: 'x', provider: 'openai_compatible', api_key: 'sk-abc', base_url: 'not-a-url' }).success,
    false
  );
});

test('approveVariant restricts action to the three real workflow states', () => {
  for (const action of ['APPROVE', 'REJECT', 'REQUEST_CHANGE']) {
    assert.ok(schemas.approveVariant.safeParse({ action }).success, `${action} should be valid`);
  }
  assert.equal(schemas.approveVariant.safeParse({ action: 'MAYBE' }).success, false);
});
