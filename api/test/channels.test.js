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

test('validateChannelConfig is a no-op for quora (permanently unimplemented)', () => {
  // Configuring an unimplemented channel is allowed to save a row - it's
  // only publishToChannel that refuses to actually send anything - so
  // validation must not throw here even with an empty config. youtube
  // used to be included in this test before it was implemented; now that
  // it has real required fields, an empty config correctly throws (see
  // the next test) just like any other implemented channel.
  assert.doesNotThrow(() => validateChannelConfig('quora', {}));
});

test('validateChannelConfig treats youtube like any other implemented channel - empty config is rejected', () => {
  assert.throws(
    () => validateChannelConfig('youtube', {}),
    /missing required field\(s\): client_id, client_secret, refresh_token/
  );
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

test('validateChannelConfig(email): SMTP fields are required, IMAP fields are not - a send-only config is valid', () => {
  // The email channel's inbound IMAP fields (imap_host/imap_user/imap_pass
  // etc - see email-poller.js) are deliberately optional: plenty of setups
  // only ever want to send, not poll a mailbox for replies. Only the SMTP
  // fields should ever appear in a "missing required field(s)" error.
  assert.throws(
    () => validateChannelConfig('email', {}),
    /missing required field\(s\): smtp_host, smtp_port, smtp_user, smtp_pass, from_email/
  );
  assert.doesNotThrow(() =>
    validateChannelConfig('email', {
      smtp_host: 'smtp.example.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'a@example.com'
    })
  );
});

test('email channel: imap_pass round-trips as a secret field, alongside smtp_pass', () => {
  const raw = { smtp_host: 'smtp.example.com', smtp_pass: 'smtp-secret', imap_host: 'imap.example.com', imap_pass: 'imap-secret' };
  const encrypted = encryptChannelSecrets('email', raw, fakeEncrypt);
  assert.equal(encrypted.smtp_host, 'smtp.example.com');
  assert.equal(encrypted.imap_host, 'imap.example.com');
  assert.equal(encrypted.smtp_pass, 'ENC(smtp-secret)');
  assert.equal(encrypted.imap_pass, 'ENC(imap-secret)');

  const masked = maskChannelSecrets('email', encrypted);
  assert.equal(masked.imap_pass, '••••••••');

  const decrypted = decryptChannelSecrets('email', encrypted, fakeDecrypt);
  assert.deepEqual(decrypted, raw);
});

test('publishToChannel refuses an unimplemented channel with a clear error, never a silent fake success', () => {
  // This is the exact bug class this codebase's README documents fixing
  // elsewhere (Paperclip's old /transform endpoint used to fabricate a
  // fake success response) - this test pins the honest-failure behavior
  // for quora (permanently unimplemented - Quora has no posting API) so
  // it can't quietly regress into a fake success. youtube used to be
  // pinned here too before it was implemented - see the youtube-specific
  // tests below instead.
  return assert.rejects(() => publishToChannel('quora', { config: {} }), /not implemented yet/);
});

// --- YouTube: real resumable-upload publishing --------------------------
// No live Google credentials exist in this environment (same situation as
// every other real-API channel here - see facebook/instagram/linkedin
// above, none of which are hit against the real API in tests either), so
// these mock `global.fetch` to verify the actual HTTP protocol this code
// speaks: refresh a token, initiate a resumable upload session, PUT the
// file to the URL that session hands back - not just that some function
// gets called.
const fsForYoutubeTests = require('fs');
const osForYoutubeTests = require('os');
const pathForYoutubeTests = require('path');

async function withTempVideoFile(fn) {
  // fn(filePath) returns a Promise (every caller below passes an async
  // publishToChannel(...) chain) - must be awaited before the temp file
  // is deleted, otherwise cleanup races the async publishYouTube() call
  // that's still reading the file mid-flight and it 404s on its own
  // fixture. A bare `try { return fn(filePath) } finally { rmSync }`
  // does NOT wait for that promise; only `await` does.
  const filePath = pathForYoutubeTests.join(osForYoutubeTests.tmpdir(), `oc-yt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  fsForYoutubeTests.writeFileSync(filePath, Buffer.from('fake mp4 bytes for a test, never actually decoded'));
  try {
    return await fn(filePath);
  } finally {
    fsForYoutubeTests.rmSync(filePath, { force: true });
  }
}

test('publishToChannel(youtube): rejects when no file is attached', () => {
  return assert.rejects(
    () => publishToChannel('youtube', { config: {}, title: 't', text: '', filePath: null, mimeType: null }),
    /requires a video file/
  );
});

test('publishToChannel(youtube): rejects a non-video file with a clear error, before any network call', () => {
  return withTempVideoFile((filePath) => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; throw new Error('fetch should not have been called'); };
    return assert.rejects(
      () => publishToChannel('youtube', { config: {}, title: 't', text: '', filePath, mimeType: 'image/png' }),
      /only accepts video files/
    ).finally(() => {
      global.fetch = originalFetch;
      assert.equal(fetchCalled, false, 'a non-video mimeType must be rejected before the OAuth token call');
    });
  });
});

test('publishToChannel(youtube): a failed OAuth token refresh surfaces Google\'s own error message', () => {
  return withTempVideoFile((filePath) => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
      };
    };
    return assert.rejects(
      () => publishToChannel('youtube', {
        config: { client_id: 'id', client_secret: 'secret', refresh_token: 'stale' },
        title: 't', text: '', filePath, mimeType: 'video/mp4'
      }),
      /Token has been expired or revoked/
    ).finally(() => { global.fetch = originalFetch; });
  });
});

test('publishToChannel(youtube): full resumable upload flow - refresh token, init session, PUT bytes, return id/url', () => {
  return withTempVideoFile((filePath) => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'fresh-access-token' }) };
      }
      if (String(url).startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
        assert.equal(opts.headers.Authorization, 'Bearer fresh-access-token', 'must use the just-refreshed access token, not a stored one');
        return {
          ok: true,
          headers: { get: (name) => (name === 'location' ? 'https://upload.example.com/session/xyz' : null) }
        };
      }
      if (url === 'https://upload.example.com/session/xyz') {
        assert.equal(opts.method, 'PUT');
        return { ok: true, json: async () => ({ id: 'dQw4w9WgXcQ' }) };
      }
      throw new Error(`unexpected fetch call in test: ${url}`);
    };

    return publishToChannel('youtube', {
      config: { client_id: 'id', client_secret: 'secret', refresh_token: 'rt', privacy_status: 'private' },
      title: 'Test video', text: 'A description', filePath, mimeType: 'video/mp4'
    }).then((result) => {
      assert.equal(result.externalId, 'dQw4w9WgXcQ');
      assert.equal(result.externalUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      assert.equal(calls.length, 3, 'expected exactly 3 HTTP calls: token refresh, session init, byte upload');
    }).finally(() => { global.fetch = originalFetch; });
  });
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
