'use strict';
// Octave Voice Agent - outbound calling to a lead's phone number, placed
// from the Inbox/Leads UI, via Sarvam AI's Conversations (Voice Agents)
// product (https://docs.sarvam.ai/conversations). Same configuration
// philosophy as SARVAM_API_KEY/SARVAM_MODEL's inquiry classifier in
// server.js: everything needed to place a call lives in environment
// variables, read fresh on every call (not cached at require-time) so
// this stays independently unit-testable the same way lead-enrichment.js
// is - no database row, no admin UI, no per-product config. Leave the
// required vars unset and calling is simply unavailable (isConfigured()
// false); nothing else in the app changes behavior.
//
// Honesty note on the webhook payload shape: Sarvam's publicly fetchable
// docs confirm the outbound-call creation request/response shape and the
// existence of a webhook_config.url callback, but do not spell out the
// exact field names Sarvam posts back with on call status updates. Rather
// than guess a precise schema and silently drop whatever doesn't match,
// parseStatusWebhookPayload() below checks a handful of plausible field
// names for each piece of information and keeps the full raw payload
// alongside whatever it managed to extract - see its own comment.

const OUTBOUND_CREATE_BASE = 'https://apps.sarvam.ai/api/outbounds/v1';

function env(name, fallback = '') {
  const v = process.env[name];
  return (v === undefined || v === null) ? fallback : v;
}

// The set of env vars required to actually place a call. SARVAM_API_KEY
// is shared with the existing text-inquiry classifier (same Sarvam
// account); everything else here is specific to the voice agent and has
// no other use in this app.
function getVoiceConfig() {
  return {
    apiKey: env('SARVAM_API_KEY'),
    orgId: env('SARVAM_VOICE_ORG_ID'),
    workspaceId: env('SARVAM_VOICE_WORKSPACE_ID'),
    appId: env('SARVAM_VOICE_APP_ID'),
    appVersion: parseInt(env('SARVAM_VOICE_APP_VERSION', '1'), 10) || 1,
    connectionId: env('SARVAM_VOICE_CONNECTION_ID'),
    agentPhoneNumber: env('SARVAM_VOICE_AGENT_PHONE_NUMBER'),
    // Optional - left out of the request entirely when unset, so Sarvam's
    // own agent-configured greeting/language (set in the indus.sarvam.ai
    // dashboard when "Octave Voice Agent" was built) is used as-is.
    greeting: env('SARVAM_VOICE_GREETING'),
    language: env('SARVAM_VOICE_LANGUAGE'),
    // Gates the inbound status webhook (see parseStatusWebhookPayload's
    // caller in server.js) - calls still work with this unset, there's
    // just no live status/recording update after the call is placed.
    webhookSecret: env('SARVAM_VOICE_WEBHOOK_SECRET')
  };
}

// The subset actually required to place a call - agentPhoneNumber doubles
// as "is this provisioned at all", since a connection with no caller ID
// can't originate a call.
const REQUIRED_FIELDS = ['apiKey', 'orgId', 'workspaceId', 'appId', 'connectionId', 'agentPhoneNumber'];

function isConfigured(config = getVoiceConfig()) {
  return REQUIRED_FIELDS.every((k) => !!config[k]);
}

function missingFields(config = getVoiceConfig()) {
  return REQUIRED_FIELDS.filter((k) => !config[k]);
}

// ---- Phone normalization ------------------------------------------------
// leads.phone is free-text (CSV import, webhook payload, web form, manual
// entry) - not guaranteed E.164. Sarvam's API needs a real E.164 number.
// This app is scoped to the Indian market throughout (GSTIN extraction,
// INR pricing, etc - see lead-enrichment.js, README.md), so a bare
// 10-digit number is assumed Indian and given a +91 prefix; anything
// already carrying a country code (a leading + or 91/0 prefix on a
// longer number) is normalized, not reinterpreted. Returns null, never a
// guess, for anything that doesn't resolve to a plausible E.164 shape -
// callers should treat null as "can't call this lead", not retry with a
// mangled number.
function normalizePhoneForCall(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let digits = raw.trim().replace(/[\s\-().]/g, '');
  if (!digits) return null;

  let hadPlus = digits.startsWith('+');
  if (hadPlus) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);

  if (!/^\d+$/.test(digits)) return null;

  if (digits.length === 10) {
    digits = '91' + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = '91' + digits.slice(1);
  }
  // else: assume whatever country code is already present (12+ digits,
  // or already had a leading +) and leave it alone.

  if (digits.length < 10 || digits.length > 15) return null;
  return '+' + digits;
}

// ---- Outbound call request ----------------------------------------------
// Pure builder, split out from initiateCall() so the exact request shape
// is unit-testable without a network call. Mirrors the documented
// instant-outbound/create request body (docs.sarvam.ai/api-reference/
// instant-outbound/create).
function buildOutboundCallPayload({ toNumber, leadName, leadCompany, webhookUrl, webhookMetadata }, config = getVoiceConfig()) {
  const appOverrides = {};
  if (config.greeting) appOverrides.initial_bot_message = config.greeting;
  if (config.language) appOverrides.initial_language_name = config.language;

  const appConfig = {
    app_id: config.appId,
    app_version: config.appVersion,
    connection_config: {
      connection_id: config.connectionId,
      agent_phone_number: config.agentPhoneNumber
    },
    // Whatever the agent's own prompt wants to reference about who it's
    // calling - harmless to send even if the configured agent ignores
    // variables it doesn't use.
    agent_variables: {
      lead_name: leadName || '',
      lead_company: leadCompany || ''
    }
  };
  if (Object.keys(appOverrides).length) appConfig.app_overrides = appOverrides;

  const payload = {
    app_config: appConfig,
    user_config: { user_phone_number: toNumber }
  };
  if (webhookUrl) {
    payload.webhook_config = { url: webhookUrl, metadata: webhookMetadata || {} };
  }
  return payload;
}

// Places the call. Throws a plain Error with a caller-facing message on
// any failure (missing config, bad response, network/timeout) - never
// silently returns null, unlike classifyInquiryWithSarvam's intentional
// fail-open (a missed inquiry classification just leaves a lead
// unlabeled; a call the user explicitly asked for needs to visibly fail
// so the UI can say so). Callers decide what to do with that - see
// POST /leads/:id/call in server.js, which records the failure on the
// call row rather than hard-failing the HTTP response, same pattern as
// POST /leads/:id/reply's send_status/send_error.
async function initiateCall({ toNumber, leadName, leadCompany, webhookUrl, webhookMetadata }, config = getVoiceConfig()) {
  if (!isConfigured(config)) {
    throw new Error(`Octave Voice Agent is not fully configured - missing: ${missingFields(config).join(', ')} (see README.md "Octave Voice Agent" and .env.vps.example).`);
  }

  const payload = buildOutboundCallPayload({ toNumber, leadName, leadCompany, webhookUrl, webhookMetadata }, config);
  const url = `${OUTBOUND_CREATE_BASE}/orgs/${encodeURIComponent(config.orgId)}/workspaces/${encodeURIComponent(config.workspaceId)}/outbounds`;

  // Same reasoning as classifyInquiryWithSarvam's timeout: fetch() has no
  // built-in request timeout in Node, so an AbortController keeps a
  // stalled Sarvam response from hanging this request indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let resp, data;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    try { data = await resp.json(); } catch { data = {}; }
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'timed out' : (e.message || 'request failed');
    throw new Error(`Could not reach Sarvam to place the call (${reason}).`);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const detail = (data && (data.message || data.error || (Array.isArray(data.detail) && data.detail.map((d) => d.msg).join('; ')))) || `HTTP ${resp.status}`;
    throw new Error(`Sarvam rejected the call request: ${detail}`);
  }
  if (!data || !data.attempt_id) {
    throw new Error('Sarvam accepted the request but returned no attempt_id to track it by.');
  }
  return { attemptId: data.attempt_id };
}

// ---- Status webhook -------------------------------------------------------
// Best-effort extraction (see the module comment on why this is lenient
// rather than a strict schema): tries several plausible field names/
// nesting for each piece of information and returns whatever it found.
// `raw` always carries the untouched body, so nothing is lost even where
// a field name here turns out to be wrong once Sarvam's exact webhook
// shape is confirmed against a live account.
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return null;
}

function parseStatusWebhookPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const data = body.data && typeof body.data === 'object' ? body.data : body;

  const attemptId = firstDefined(body.attempt_id, data.attempt_id, body.attemptId, data.attemptId);
  if (!attemptId) return null;

  const status = firstDefined(body.status, data.status, body.call_status, data.call_status, body.event, body.event_type);
  const durationRaw = firstDefined(body.duration_seconds, data.duration_seconds, body.duration, data.duration, body.call_duration);
  const durationSeconds = durationRaw !== null && !Number.isNaN(Number(durationRaw)) ? Math.round(Number(durationRaw)) : null;
  const recordingUrl = firstDefined(body.recording_url, data.recording_url, body.recording, data.recording);
  const transcriptUrl = firstDefined(body.transcript_url, data.transcript_url, body.transcript, data.transcript);
  const errorMessage = firstDefined(body.error, data.error, body.error_message, data.error_message, body.failure_reason, data.failure_reason);

  return {
    attemptId: String(attemptId),
    status: status ? String(status) : null,
    durationSeconds,
    recordingUrl: recordingUrl ? String(recordingUrl) : null,
    transcriptUrl: transcriptUrl ? String(transcriptUrl) : null,
    errorMessage: errorMessage ? String(errorMessage) : null,
    raw: body
  };
}

module.exports = {
  getVoiceConfig,
  isConfigured,
  missingFields,
  normalizePhoneForCall,
  buildOutboundCallPayload,
  initiateCall,
  parseStatusWebhookPayload
};
