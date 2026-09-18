// Unit tests for api/src/channels.js - the one module in this codebase
// that's already a clean, side-effect-free export (no DB/Redis connection,
// no app.listen()), so it's the safe place to start a real test suite
// without refactoring the monolithic server.js just to make it testable.
//
// Run with: npm test (from api/), or `node --test test/` directly.
// Node's built-in test runner (node:test) - no new dependency to audit or
// keep patched, matching this app's fairly conservative dependency list.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHANNEL_SPECS,
  validateChannelConfig,
  encryptChannelSecrets,
  maskChannelSecrets,
  decryptChannelSecrets,
  publishToChannel
} = require('../src/channels');

// A fake, reversible "encryption" for tests - channels.js takes
// encryptSecret/decryptSecret as injected functions (the real ones in
// server.js do AES-256-GCM), so tests don't need real crypto or a key.
const fakeEncrypt = (s) => `ENC(${s})`;
const fakeDecrypt = (s) => s.replace(/^ENC\(|\)$/g, '');

test('validateChannelConfig rejects an unknown channel', () => {
  assert.throws(() => validateChannelConfig('carrier_pigeon', {}), /Unknown channel: carrier_pigeon/);
});

test('validateChannelConfig is a no-op for unimplemented channels (youtube, quora)', () => {
  // Configuring an unimplemented channel is allowed to save a row - it's
  // only publishToChannel that refuses to actually send anything (see
  // below) - so validation must not throw here even with an empty config.
  assert.doesNotThrow(() => validateChannelConfig('youtube', {}));
  assert.doesNotThrow(() => validateChannelConfig('quora', {}));
});

test('validateChannelConfig lists every missing required field by name', () => {
  assert.throws(
    () => validateChannelConfig('facebook', { page_id: 'p1' }), // access_token missing
    /missing required field\(s\): access_token/
  );
  assert.throws(
    () => validateChannelConfig('whatsapp', {}), // both required fields missing
    /phone_number_id, access_token/
  );
});

test('validateChannelConfig passes once every required field is present', () => {
  assert.doesNotThrow(() => validateChannelConfig('facebook', { page_id: 'p1', access_token: 'tok' }));
  assert.doesNotThrow(() => validateChannelConfig('whatsapp', { phone_number_id: '123', access_token: 'tok' }));
});

test('validateChannelConfig treats a blank/whitespace-only required field as missing', () => {
  assert.throws(
    () => validateChannelConfig('facebook', { page_id: 'p1', access_token: '   ' }),
    /missing required field\(s\): access_token/
  );
});

test('encrypt/decrypt round-trips every secret field and leaves non-secret fields untouched', () => {
  const raw = { phone_number_id: '123456', access_token: 'super-secret-token' };
  const encrypted = encryptChannelSecrets('whatsapp', raw, fakeEncrypt);
  assert.equal(encrypted.phone_number_id, '123456', 'non-secret field must not be touched');
  assert.equal(encrypted.access_token, 'ENC(super-secret-token)', 'secret field must be encrypted');

  const decrypted = decryptChannelSecrets('whatsapp', encrypted, fakeDecrypt);
  assert.deepEqual(decrypted, raw, 'decrypting the encrypted config must reproduce the original exactly');
});

test('encryptChannelSecrets does not mutate the config object passed in', () => {
  const raw = { phone_number_id: '123456', access_token: 'super-secret-token' };
  const copy = { ...raw };
  encryptChannelSecrets('whatsapp', raw, fakeEncrypt);
  assert.deepEqual(raw, copy, 'the caller\'s original object must be unchanged (shallow-copy contract)');
});

test('maskChannelSecrets hides every secret field and leaves non-secret fields visible', () => {
  const raw = { phone_number_id: '123456', access_token: 'super-secret-token' };
  const masked = maskChannelSecrets('whatsapp', raw);
  assert.equal(masked.phone_number_id, '123456');
  assert.equal(masked.access_token, '••••••••');
});

test('maskChannelSecrets leaves an empty secret field empty rather than masking nothing', () => {
  const masked = maskChannelSecrets('whatsapp', { phone_number_id: '123456', access_token: '' });
  assert.equal(masked.access_token, '', 'an unset secret should stay unset, not show a fake mask');
});

test('publishToChannel refuses an unimplemented channel with a clear error, never a silent fake success', () => {
  // This is the exact bug class this codebase's README documents fixing
  // elsewhere (Paperclip's old /transform endpoint used to fabricate a
  // fake success response) - this test pins the honest-failure behavior
  // for youtube/quora so it can't quietly regress into a fake success.
  return Promise.all([
    assert.rejects(() => publishToChannel('youtube', { config: {} }), /not implemented yet/),
    assert.rejects(() => publishToChannel('quora', { config: {} }), /not implemented yet/)
  ]);
});

test('publishToChannel refuses an unknown channel', () => {
  return assert.rejects(() => publishToChannel('carrier_pigeon', { config: {} }), /Unknown channel: carrier_pigeon/);
});

test('CHANNEL_SPECS keys match the channel vocabulary the rest of the app assumes', () => {
  // A real bug this session found and fixed: content_variants.channel and
  // product_channels.channel used to be generated from two different,
  // disconnected vocabularies (e.g. 'instagram-feed' vs 'instagram'), so a
  // generated variant's channel could never match a product_channels row
  // and publishing would silently never find its config. This pins the
  // canonical channel list (also hardcoded as PRODUCT_CHANNELS and the
  // transformContent zod schema in server.js, and SPECS in
  // paperclip/transformer.py - see the comments there for why it can't
  // just import this list directly) so a future change to one without the
  // others fails a test instead of failing silently in production.
  const expected = ['whatsapp', 'facebook', 'instagram', 'linkedin', 'youtube', 'quora', 'email'];
  assert.deepEqual(
    Object.keys(CHANNEL_SPECS).sort(),
    [...expected].sort(),
    'CHANNEL_SPECS must define exactly the channels PRODUCT_CHANNELS/transformContent/Paperclip SPECS also assume'
  );
});

test('every implemented channel spec\'s secret fields are a subset of its declared fields', () => {
  for (const [channel, spec] of Object.entries(CHANNEL_SPECS)) {
    if (!spec.implemented) continue;
    for (const f of spec.fields) {
      assert.ok('key' in f && 'label' in f, `${channel}: every field needs a key and label`);
    }
    // At least the access credential should be marked secret for any
    // implemented channel - guards against a future field addition that
    // forgets `secret: true` and ends up stored/returned in plaintext.
    const hasSecretField = spec.fields.some(f => f.secret);
    assert.ok(hasSecretField, `${channel}: an implemented channel should have at least one field marked secret`);
  }
});
