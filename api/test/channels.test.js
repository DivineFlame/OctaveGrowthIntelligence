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
  publishToChannel,
  listWhatsAppTemplates,
  registerWhatsAppWebhook
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
    () => validateChannelConfig('whatsapp', {}), // required fields missing
    /auth_id, auth_token, channel_id, waba_id/
  );
});

test('validateChannelConfig passes once every required field is present', () => {
  assert.doesNotThrow(() => validateChannelConfig('facebook', { page_id: 'p1', access_token: 'tok' }));
  assert.doesNotThrow(() => validateChannelConfig('whatsapp', { auth_id: 'MA_1', auth_token: 'tok', channel_id: 'ch1', waba_id: 'wa1' }));
});

test('validateChannelConfig treats a blank/whitespace-only required field as missing', () => {
  assert.throws(
    () => validateChannelConfig('facebook', { page_id: 'p1', access_token: '   ' }),
    /missing required field\(s\): access_token/
  );
});

test('encrypt/decrypt round-trips every secret field and leaves non-secret fields untouched', () => {
  const raw = { channel_id: 'ch1', auth_token: 'super-secret-token' };
  const encrypted = encryptChannelSecrets('whatsapp', raw, fakeEncrypt);
  assert.equal(encrypted.channel_id, 'ch1', 'non-secret field must not be touched');
  assert.equal(encrypted.auth_token, 'ENC(super-secret-token)', 'secret field must be encrypted');

  const decrypted = decryptChannelSecrets('whatsapp', encrypted, fakeDecrypt);
  assert.deepEqual(decrypted, raw, 'decrypting the encrypted config must reproduce the original exactly');
});

test('encryptChannelSecrets does not mutate the config object passed in', () => {
  const raw = { channel_id: 'ch1', auth_token: 'super-secret-token' };
  const copy = { ...raw };
  encryptChannelSecrets('whatsapp', raw, fakeEncrypt);
  assert.deepEqual(raw, copy, 'the caller\'s original object must be unchanged (shallow-copy contract)');
});

test('maskChannelSecrets hides every secret field and leaves non-secret fields visible', () => {
  const raw = { channel_id: 'ch1', auth_token: 'super-secret-token' };
  const masked = maskChannelSecrets('whatsapp', raw);
  assert.equal(masked.channel_id, 'ch1');
  assert.equal(masked.auth_token, '••••••••');
});

test('maskChannelSecrets leaves an empty secret field empty rather than masking nothing', () => {
  const masked = maskChannelSecrets('whatsapp', { channel_id: 'ch1', auth_token: '' });
  assert.equal(masked.auth_token, '', 'an unset secret should stay unset, not show a fake mask');
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

// --- WhatsApp via Vobiz --------------------------------------------------
// Same fetch-mocking approach as the YouTube section below: no live Vobiz
// credentials exist here, so these verify the actual HTTP calls this code
// makes (method, URL, headers, body shape) against a fake fetch, not just
// that some function resolves.
const VOBIZ_CONFIG = { auth_id: 'MA_TEST', auth_token: 'tok', channel_id: 'chan-1', waba_id: 'waba-1', default_recipient: '+919876543210' };

test('listWhatsAppTemplates syncs from Meta first, then requests this channel\'s templates and returns only APPROVED ones, with parsed placeholder counts', () => {
  const originalFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async (url, opts) => {
    calledUrls.push(url);
    assert.equal(opts.headers['X-Auth-ID'], 'MA_TEST');
    assert.equal(opts.headers['X-Auth-Token'], 'tok');
    if (url === 'https://api.vobiz.ai/api/v1/messaging/channels/chan-1/templates/sync') {
      assert.equal(opts.method, 'POST');
      return { ok: true, json: async () => ({ synced: 5 }) };
    }
    assert.equal(url, 'https://api.vobiz.ai/api/v1/messaging/channels/chan-1/templates');
    return {
      ok: true,
      json: async () => ({
        items: [
          { name: 'order_confirmation', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: { components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} is confirmed.' }] } },
          { name: 'still_pending', language: 'en_US', category: 'MARKETING', status: 'PENDING_REVIEW', components: { components: [{ type: 'BODY', text: 'Not usable yet.' }] } }
        ]
      })
    };
  };
  return listWhatsAppTemplates(VOBIZ_CONFIG).then((templates) => {
    // Sync must happen before the list is fetched - a template just
    // approved in Meta wouldn't show up in Vobiz's cache otherwise (see
    // the comment on syncWhatsAppTemplates() in channels.js).
    assert.deepEqual(calledUrls, [
      'https://api.vobiz.ai/api/v1/messaging/channels/chan-1/templates/sync',
      'https://api.vobiz.ai/api/v1/messaging/channels/chan-1/templates'
    ]);
    assert.equal(templates.length, 1, 'the PENDING_REVIEW template must be filtered out');
    assert.equal(templates[0].name, 'order_confirmation');
    assert.equal(templates[0].paramCount, 2);
  }).finally(() => { global.fetch = originalFetch; });
});

test('listWhatsAppTemplates still returns the list even when the sync call itself fails', () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.endsWith('/sync')) return { ok: false, status: 429, json: async () => ({ message: 'Rate limited' }) };
    return { ok: true, json: async () => ({ items: [] }) };
  };
  return listWhatsAppTemplates(VOBIZ_CONFIG).then((templates) => {
    assert.deepEqual(templates, []);
  }).finally(() => { global.fetch = originalFetch; });
});

test('listWhatsAppTemplates surfaces Vobiz\'s own error message on a failed request', () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Invalid auth token' }) });
  return assert.rejects(() => listWhatsAppTemplates(VOBIZ_CONFIG), /Invalid auth token/)
    .finally(() => { global.fetch = originalFetch; });
});

// Regression test for a real production error: Vobiz doesn't always
// return { message: "..." } or { error: "..." } as a plain string - a
// nested { error: { message, code } } shape (seen live, HTTP 500 on
// GET .../templates) used to produce a useless "Error: [object Object]"
// because `data.message || data.error` picked the object itself and
// `new Error(object)` stringifies to that. Every shape actually seen
// must still surface a readable reason.
test('listWhatsAppTemplates surfaces a readable message even when Vobiz nests the error as an object, not a string', () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { code: 'internal_error', message: 'Channel not fully provisioned yet' } }) });
  return assert.rejects(() => listWhatsAppTemplates(VOBIZ_CONFIG), /Channel not fully provisioned yet/)
    .finally(() => { global.fetch = originalFetch; });
});

test('listWhatsAppTemplates falls back to the raw body instead of "[object Object]" when the error shape is unrecognized', () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ status: 'unavailable' }) });
  return assert.rejects(() => listWhatsAppTemplates(VOBIZ_CONFIG), (err) => {
    assert.doesNotMatch(err.message, /\[object Object\]/);
    assert.match(err.message, /unavailable/);
    return true;
  }).finally(() => { global.fetch = originalFetch; });
});

test('registerWhatsAppWebhook POSTs the url/secret to Vobiz\'s webhook-subscription endpoint', () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://api.vobiz.ai/api/v1/messaging/webhooks');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['X-Auth-ID'], 'MA_TEST');
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ id: 'sub-1', url: captured.url, status: 'active' }) };
  };
  return registerWhatsAppWebhook(VOBIZ_CONFIG, 'https://octave.example.com/webhooks/sekret/whatsapp', 'sekret').then((result) => {
    assert.deepEqual(captured, { url: 'https://octave.example.com/webhooks/sekret/whatsapp', secret: 'sekret' });
    assert.equal(result.id, 'sub-1');
  }).finally(() => { global.fetch = originalFetch; });
});

test('registerWhatsAppWebhook surfaces Vobiz\'s own error message on failure', () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ message: 'url must be https' }) });
  return assert.rejects(
    () => registerWhatsAppWebhook(VOBIZ_CONFIG, 'http://not-https.example.com', 'sekret'),
    /url must be https/
  ).finally(() => { global.fetch = originalFetch; });
});

test('publishToChannel(whatsapp): a template reply sends type:"template" with the right recipient/name/language/parameters', () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://api.vobiz.ai/api/v1/messaging/messages');
    assert.equal(opts.method, 'POST');
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ id: 'msg-123' }) };
  };
  return publishToChannel('whatsapp', {
    config: VOBIZ_CONFIG,
    template: { name: 'order_confirmation', language: 'en_US', parameters: ['Priya', 'ORD-9'] },
    to: '+919876543210'
  }).then((result) => {
    assert.equal(result.externalId, 'msg-123');
    assert.equal(captured.type, 'template');
    assert.equal(captured.channel_id, 'chan-1');
    assert.equal(captured.waba_id, 'waba-1');
    assert.equal(captured.to, '+919876543210');
    assert.equal(captured.template.name, 'order_confirmation');
    assert.equal(captured.template.language.code, 'en_US');
    assert.deepEqual(captured.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Priya' }, { type: 'text', text: 'ORD-9' }] }]);
  }).finally(() => { global.fetch = originalFetch; });
});

test('publishToChannel(whatsapp): a Studio broadcast (text, no template chosen) wraps it as the configured broadcast template\'s one parameter - never sent as free text', () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ id: 'msg-456' }) };
  };
  const configWithBroadcastTemplate = Object.assign({}, VOBIZ_CONFIG, { broadcast_template_name: 'marketing_broadcast', broadcast_template_language: 'en_US' });
  return publishToChannel('whatsapp', { config: configWithBroadcastTemplate, text: 'Hello there', to: '+919876543210' }).then(() => {
    assert.equal(captured.type, 'template', 'must never fall back to a free-text send - Meta requires an approved template');
    assert.equal(captured.template.name, 'marketing_broadcast');
    assert.equal(captured.template.language.code, 'en_US');
    assert.deepEqual(captured.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Hello there' }] }]);
  }).finally(() => { global.fetch = originalFetch; });
});

test('publishToChannel(whatsapp): a Studio broadcast refuses with a clear, actionable error when no broadcast template is configured', () => {
  return assert.rejects(
    () => publishToChannel('whatsapp', { config: VOBIZ_CONFIG, text: 'Hello there', to: '+919876543210' }),
    /set a "Broadcast template name"/
  );
});

test('publishToChannel(whatsapp): Vobiz rejecting the send surfaces its own error message', () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ message: 'Template not approved for this WABA' }) });
  return assert.rejects(
    () => publishToChannel('whatsapp', { config: VOBIZ_CONFIG, template: { name: 'x' }, to: '+919876543210' }),
    /Template not approved for this WABA/
  ).finally(() => { global.fetch = originalFetch; });
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
