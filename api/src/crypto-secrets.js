// AES-256-GCM helpers for encrypting secrets at rest (LLM provider API
// keys, channel access tokens/SMTP passwords, webhook secrets - anywhere
// server.js needs to store a credential and read it back later rather
// than just hash-and-compare it). Pulled out of server.js as pure,
// key-injected functions (the key buffer is a parameter, not a module-
// level constant) so they can be unit tested directly with a throwaway
// test key - server.js itself can't safely be require()'d in a test (see
// api/test/ and README.md "Hardening notes"), and deriving the real key
// requires JWT_SECRET/ENCRYPTION_KEY to be set (see requireSecretOrExit in
// server.js), which a test shouldn't need to care about.
//
// Format: base64(iv[12 bytes] || authTag[16 bytes] || ciphertext). The
// random 12-byte IV is why encrypting the same plaintext twice with the
// same key never produces the same output - important so two identical
// stored secrets (e.g. two channels sharing one access token) don't leak
// that they're equal just by comparing ciphertext.
const crypto = require('crypto');

function encrypt(plaintext, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(encoded, keyBuf) {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
