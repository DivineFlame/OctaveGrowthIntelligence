// Unit tests for api/src/crypto-secrets.js - the AES-256-GCM helpers used
// to encrypt every secret this app stores at rest (LLM provider API keys,
// channel access tokens/SMTP passwords, webhook secrets). This is the one
// piece of crypto in the whole codebase, so it's worth pinning its actual
// security properties with tests, not just "it round-trips" - a wrong key
// or a tampered ciphertext failing loudly is the entire point of using an
// authenticated cipher (GCM) instead of plain AES-CBC.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { encrypt, decrypt } = require('../src/crypto-secrets');

const KEY = crypto.randomBytes(32); // a throwaway 256-bit test key, not the real ENCRYPTION_KEY

test('encrypt then decrypt reproduces the original plaintext', () => {
  const secret = 'sk-super-secret-llm-api-key-1234567890';
  const encrypted = encrypt(secret, KEY);
  assert.equal(decrypt(encrypted, KEY), secret);
});

test('encrypting the same plaintext twice never produces the same ciphertext', () => {
  // The random 12-byte IV is what guarantees this - without it, two
  // channels sharing one access token would store identical ciphertext,
  // which leaks that they're equal even to someone who can't decrypt
  // either one.
  const secret = 'same-value-both-times';
  const a = encrypt(secret, KEY);
  const b = encrypt(secret, KEY);
  assert.notEqual(a, b, 'two encryptions of the same plaintext must differ (random IV)');
  // ...but both must still decrypt back to the same original value.
  assert.equal(decrypt(a, KEY), secret);
  assert.equal(decrypt(b, KEY), secret);
});

test('decrypting with the wrong key fails loudly instead of returning garbage', () => {
  const encrypted = encrypt('a real secret', KEY);
  const wrongKey = crypto.randomBytes(32);
  assert.throws(() => decrypt(encrypted, wrongKey));
});

test('a tampered ciphertext fails to decrypt (GCM auth tag catches it)', () => {
  const encrypted = encrypt('a real secret', KEY);
  const raw = Buffer.from(encrypted, 'base64');
  // Flip one byte inside the ciphertext portion (after the 12-byte IV and
  // 16-byte auth tag) - if this silently decrypted to corrupted-but-
  // readable output instead of throwing, that would mean the auth tag
  // isn't actually being checked, which is the entire reason to use GCM
  // over an unauthenticated mode.
  raw[raw.length - 1] ^= 0xff;
  const tampered = raw.toString('base64');
  assert.throws(() => decrypt(tampered, KEY));
});

test('a tampered auth tag fails to decrypt', () => {
  const encrypted = encrypt('a real secret', KEY);
  const raw = Buffer.from(encrypted, 'base64');
  raw[15] ^= 0xff; // byte 15 is inside the 16-byte auth tag (bytes 12-27)
  const tampered = raw.toString('base64');
  assert.throws(() => decrypt(tampered, KEY));
});

test('handles empty-string plaintext', () => {
  const encrypted = encrypt('', KEY);
  assert.equal(decrypt(encrypted, KEY), '');
});

test('handles unicode plaintext correctly', () => {
  const secret = 'clé secrète 🔑 密钥';
  const encrypted = encrypt(secret, KEY);
  assert.equal(decrypt(encrypted, KEY), secret);
});
