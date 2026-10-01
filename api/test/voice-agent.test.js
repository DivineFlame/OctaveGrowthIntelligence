// Unit tests for api/src/voice-agent.js (Octave Voice Agent / Sarvam
// outbound calling) - see lead-enrichment.test.js for why these small
// pure helpers are pulled out of server.js and tested directly. Only the
// env-free, network-free pieces are covered here (config detection, phone
// normalization, request payload shape, webhook parsing); initiateCall()'s
// actual HTTP call is exercised indirectly via the integration tests
// hitting POST /leads/:id/call against a deliberately unconfigured env
// (see routes.integration.js), same as classifyInquiryWithSarvam has no
// direct unit test for its network call either.

const test = require('node:test');
const assert = require('node:assert/strict');
const voiceAgent = require('../src/voice-agent');

const FULL_CONFIG = {
  apiKey: 'key123',
  orgId: 'org1',
  workspaceId: 'ws1',
  appId: 'app1',
  appVersion: 1,
  connectionId: 'conn1',
  agentPhoneNumber: '+911234567890',
  greeting: '',
  language: '',
  webhookSecret: ''
};

test('isConfigured is true only when every required field is set', () => {
  assert.equal(voiceAgent.isConfigured(FULL_CONFIG), true);
  for (const key of ['apiKey', 'orgId', 'workspaceId', 'appId', 'connectionId', 'agentPhoneNumber']) {
    assert.equal(voiceAgent.isConfigured({ ...FULL_CONFIG, [key]: '' }), false, `expected false with ${key} missing`);
  }
});

test('missingFields lists only the unset required fields, in order', () => {
  assert.deepEqual(voiceAgent.missingFields({ ...FULL_CONFIG, orgId: '', connectionId: '' }), ['orgId', 'connectionId']);
  assert.deepEqual(voiceAgent.missingFields(FULL_CONFIG), []);
});

test('getVoiceConfig reads from process.env fresh (not cached at require time)', () => {
  const prev = process.env.SARVAM_VOICE_ORG_ID;
  try {
    process.env.SARVAM_VOICE_ORG_ID = 'org-from-env';
    assert.equal(voiceAgent.getVoiceConfig().orgId, 'org-from-env');
  } finally {
    if (prev === undefined) delete process.env.SARVAM_VOICE_ORG_ID;
    else process.env.SARVAM_VOICE_ORG_ID = prev;
  }
});

test('getVoiceConfig defaults SARVAM_VOICE_APP_VERSION to 1 when unset or non-numeric', () => {
  const prev = process.env.SARVAM_VOICE_APP_VERSION;
  try {
    delete process.env.SARVAM_VOICE_APP_VERSION;
    assert.equal(voiceAgent.getVoiceConfig().appVersion, 1);
    process.env.SARVAM_VOICE_APP_VERSION = 'not-a-number';
    assert.equal(voiceAgent.getVoiceConfig().appVersion, 1);
    process.env.SARVAM_VOICE_APP_VERSION = '3';
    assert.equal(voiceAgent.getVoiceConfig().appVersion, 3);
  } finally {
    if (prev === undefined) delete process.env.SARVAM_VOICE_APP_VERSION;
    else process.env.SARVAM_VOICE_APP_VERSION = prev;
  }
});

test('normalizePhoneForCall assumes +91 for a bare 10-digit Indian number', () => {
  assert.equal(voiceAgent.normalizePhoneForCall('9876543210'), '+919876543210');
  assert.equal(voiceAgent.normalizePhoneForCall('98765 43210'), '+919876543210');
  assert.equal(voiceAgent.normalizePhoneForCall('(987) 654-3210'), '+919876543210');
});

test('normalizePhoneForCall strips a leading 0 off an 11-digit domestic-style number', () => {
  assert.equal(voiceAgent.normalizePhoneForCall('09876543210'), '+919876543210');
});

test('normalizePhoneForCall keeps an already-E.164 number as-is', () => {
  assert.equal(voiceAgent.normalizePhoneForCall('+919876543210'), '+919876543210');
  assert.equal(voiceAgent.normalizePhoneForCall('+14155551234'), '+14155551234');
});

test('normalizePhoneForCall accepts 00-prefixed international dialing', () => {
  assert.equal(voiceAgent.normalizePhoneForCall('00919876543210'), '+919876543210');
});

test('normalizePhoneForCall returns null for empty, non-numeric, or implausible input', () => {
  assert.equal(voiceAgent.normalizePhoneForCall(''), null);
  assert.equal(voiceAgent.normalizePhoneForCall(null), null);
  assert.equal(voiceAgent.normalizePhoneForCall(undefined), null);
  assert.equal(voiceAgent.normalizePhoneForCall('call me maybe'), null);
  assert.equal(voiceAgent.normalizePhoneForCall('12'), null);
  assert.equal(voiceAgent.normalizePhoneForCall('1'.repeat(20)), null);
});

test('buildOutboundCallPayload matches the documented instant-outbound/create shape', () => {
  const payload = voiceAgent.buildOutboundCallPayload(
    { toNumber: '+919876543210', leadName: 'Asha', leadCompany: 'Acme Co', webhookUrl: 'https://api.example.com/webhooks/voice/sarvam/sekrit', webhookMetadata: { lead_id: 'lead-1' } },
    FULL_CONFIG
  );
  assert.deepEqual(payload, {
    app_config: {
      app_id: 'app1',
      app_version: 1,
      connection_config: { connection_id: 'conn1', agent_phone_number: '+911234567890' },
      agent_variables: { lead_name: 'Asha', lead_company: 'Acme Co' }
    },
    user_config: { user_phone_number: '+919876543210' },
    webhook_config: { url: 'https://api.example.com/webhooks/voice/sarvam/sekrit', metadata: { lead_id: 'lead-1' } }
  });
});

test('buildOutboundCallPayload omits webhook_config entirely when no webhookUrl is given', () => {
  const payload = voiceAgent.buildOutboundCallPayload({ toNumber: '+919876543210' }, FULL_CONFIG);
  assert.equal('webhook_config' in payload, false);
});

test('buildOutboundCallPayload includes app_overrides only for the fields actually configured', () => {
  const withGreeting = voiceAgent.buildOutboundCallPayload(
    { toNumber: '+919876543210' },
    { ...FULL_CONFIG, greeting: 'Hi there', language: '' }
  );
  assert.deepEqual(withGreeting.app_config.app_overrides, { initial_bot_message: 'Hi there' });

  const withNeither = voiceAgent.buildOutboundCallPayload({ toNumber: '+919876543210' }, FULL_CONFIG);
  assert.equal('app_overrides' in withNeither.app_config, false);
});

test('initiateCall throws a clear error, without making a network call, when not configured', async () => {
  await assert.rejects(
    () => voiceAgent.initiateCall({ toNumber: '+919876543210' }, { ...FULL_CONFIG, orgId: '' }),
    /not fully configured.*orgId/s
  );
});

test('parseStatusWebhookPayload returns null without an attempt_id anywhere plausible', () => {
  assert.equal(voiceAgent.parseStatusWebhookPayload(null), null);
  assert.equal(voiceAgent.parseStatusWebhookPayload({}), null);
  assert.equal(voiceAgent.parseStatusWebhookPayload({ status: 'completed' }), null);
});

test('parseStatusWebhookPayload extracts top-level fields', () => {
  const parsed = voiceAgent.parseStatusWebhookPayload({
    attempt_id: 'att_1',
    status: 'completed',
    duration_seconds: 42,
    recording_url: 'https://example.com/rec.mp3',
    transcript_url: 'https://example.com/t.txt'
  });
  assert.equal(parsed.attemptId, 'att_1');
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.durationSeconds, 42);
  assert.equal(parsed.recordingUrl, 'https://example.com/rec.mp3');
  assert.equal(parsed.transcriptUrl, 'https://example.com/t.txt');
  assert.equal(parsed.errorMessage, null);
});

test('parseStatusWebhookPayload falls back to a nested `data` object and alternate field names', () => {
  const parsed = voiceAgent.parseStatusWebhookPayload({
    data: { attemptId: 'att_2', call_status: 'failed', duration: '7', failure_reason: 'no answer' }
  });
  assert.equal(parsed.attemptId, 'att_2');
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.durationSeconds, 7);
  assert.equal(parsed.errorMessage, 'no answer');
});

test('parseStatusWebhookPayload keeps the full raw payload regardless of what it extracted', () => {
  const body = { attempt_id: 'att_3', some_field_this_app_does_not_know_about: 'xyz' };
  const parsed = voiceAgent.parseStatusWebhookPayload(body);
  assert.deepEqual(parsed.raw, body);
});

// --- initiateCall's HTTP handling, with fetch mocked (no network calls) ---
// Covers what initiateCall() does with Sarvam's response, not what Sarvam
// actually returns in production - the "not fully configured" case above
// already covers the no-network-call path.

function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original; });
}

test('initiateCall resolves with attemptId on a 200 response carrying attempt_id', async () => {
  await withMockedFetch(
    async () => ({ ok: true, json: async () => ({ attempt_id: 'att_live_1' }) }),
    async () => {
      const result = await voiceAgent.initiateCall({ toNumber: '+919876543210' }, FULL_CONFIG);
      assert.deepEqual(result, { attemptId: 'att_live_1' });
    }
  );
});

test('initiateCall throws with Sarvam\'s own error message on a non-OK response', async () => {
  await withMockedFetch(
    async () => ({ ok: false, status: 422, json: async () => ({ message: 'agent_phone_number is not a valid connection' }) }),
    async () => {
      await assert.rejects(
        () => voiceAgent.initiateCall({ toNumber: '+919876543210' }, FULL_CONFIG),
        /agent_phone_number is not a valid connection/
      );
    }
  );
});

test('initiateCall throws when the response is OK but has no attempt_id', async () => {
  await withMockedFetch(
    async () => ({ ok: true, json: async () => ({}) }),
    async () => {
      await assert.rejects(
        () => voiceAgent.initiateCall({ toNumber: '+919876543210' }, FULL_CONFIG),
        /no attempt_id/
      );
    }
  );
});

test('initiateCall throws a readable error when the network request itself fails', async () => {
  await withMockedFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND apps.sarvam.ai'); },
    async () => {
      await assert.rejects(
        () => voiceAgent.initiateCall({ toNumber: '+919876543210' }, FULL_CONFIG),
        /Could not reach Sarvam/
      );
    }
  );
});
