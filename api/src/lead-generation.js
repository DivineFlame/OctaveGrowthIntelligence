'use strict';
// Automated lead discovery - searches for businesses matching a query/
// location and returns them in the same shape a manually-entered lead
// has, so the route that calls this (POST /leads/discover in server.js)
// can insert them into `leads` exactly like any other source. Runs on a
// third-party scraping platform; which one, and how it's configured, is
// entirely environment variables (same philosophy as SARVAM_API_KEY/
// SARVAM_VOICE_* - see voice-agent.js's module comment) - no DB row, no
// admin UI, and deliberately nothing provider-specific in any string this
// module returns to a caller, since the UI must never name the provider
// (see README.md "Finding leads automatically"). Leave APIFY_API_TOKEN
// unset and the feature is simply unavailable (isConfigured()
// false); nothing else in the app changes behavior.

const RUN_SYNC_BASE = 'https://api.apify.com/v2/actors';
const DEFAULT_ACTOR_ID = 'compass/google-maps-extractor';
const DEFAULT_MAX_RESULTS = 30;
const HARD_MAX_RESULTS = 100; // this app's own ceiling, independent of whatever the provider would allow - keeps one request bounded in cost and time
const RUN_TIMEOUT_MS = 115000; // the sync run-and-get-dataset-items call can legitimately take a couple of minutes; AbortController still caps it so a stalled provider can't hang the request indefinitely

function env(name, fallback = '') {
  const v = process.env[name];
  return (v === undefined || v === null || v === '') ? fallback : v;
}

// Everything needed to run a discovery search. Read fresh on every call
// (not cached at require-time) - same reasoning as voice-agent.js's
// getVoiceConfig(), and what keeps this independently unit-testable.
function getDiscoveryConfig() {
  const maxResults = parseInt(env('APIFY_MAX_RESULTS', String(DEFAULT_MAX_RESULTS)), 10);
  return {
    apiToken: env('APIFY_API_TOKEN'),
    actorId: env('APIFY_ACTOR_ID', DEFAULT_ACTOR_ID),
    maxResults: Number.isFinite(maxResults) && maxResults > 0 ? Math.min(maxResults, HARD_MAX_RESULTS) : DEFAULT_MAX_RESULTS,
    language: env('APIFY_LANGUAGE', 'en')
  };
}

function isConfigured(config = getDiscoveryConfig()) {
  return !!config.apiToken;
}

function missingFields(config = getDiscoveryConfig()) {
  return config.apiToken ? [] : ['APIFY_API_TOKEN'];
}

// Pure builder, split out from findLeads() so the exact request shape is
// unit-testable without a network call - mirrors voice-agent.js's
// buildOutboundCallPayload(). Input field names match the Google Maps
// Extractor actor's documented input schema; a differently-configured
// actor (APIFY_ACTOR_ID) that expects different field names
// would need this adjusted, but the default covers the common case.
function buildDiscoveryInput({ query, location, maxResults }, config = getDiscoveryConfig()) {
  const limit = Math.min(Math.max(1, maxResults || config.maxResults), HARD_MAX_RESULTS);
  const input = {
    searchStringsArray: [query],
    maxCrawledPlacesPerSearch: limit,
    language: config.language || 'en'
  };
  if (location) input.locationQuery = location;
  return input;
}

function actorRunUrl(actorId, apiToken) {
  // The provider's actor-id path segment uses ~ in place of the slug's /
  // (e.g. "owner/name" -> "owner~name").
  const pathId = String(actorId).replace(/\//g, '~');
  return `${RUN_SYNC_BASE}/${encodeURIComponent(pathId).replace(/%7E/g, '~')}/run-sync-get-dataset-items?token=${encodeURIComponent(apiToken)}`;
}

// Maps one result item (whatever shape the configured actor returns) into
// a lead-shaped object. Deliberately lenient/defensive - this app has no
// control over what a third-party scraper returns, and a missing field
// should just come through blank, never throw and lose the whole batch.
function mapResultToLead(item) {
  if (!item || typeof item !== 'object') return null;
  const companyName = item.title || item.name || item.companyName || '';
  if (!companyName) return null;
  const phone = item.phoneUnformatted || item.phone || '';
  const website = item.website || item.url || '';
  const addressParts = [item.address, item.city, item.state].filter(Boolean);
  const category = item.categoryName || (Array.isArray(item.categories) ? item.categories[0] : '') || '';
  return {
    company_name: String(companyName).slice(0, 500),
    phone: String(phone).slice(0, 50),
    website: String(website).slice(0, 500),
    address: addressParts.join(', ').slice(0, 1000),
    category: String(category).slice(0, 200)
  };
}

// Runs one discovery search and returns lead-shaped results. Throws a
// plain, caller-facing Error (never silently returns an empty list) for
// missing config, a rejected request, a timeout, or a response that isn't
// a usable array - same "visibly fail, let the route decide what to do
// with it" pattern as voice-agent.js's initiateCall(). The error messages
// below are intentionally generic (no provider name) since they can
// surface to the UI - see the module comment and README.md.
async function findLeads({ query, location, maxResults }, config = getDiscoveryConfig()) {
  if (!query || !String(query).trim()) {
    throw new Error('A search term is required (e.g. "plumbers" or "dental clinics").');
  }
  if (!isConfigured(config)) {
    throw new Error('Lead discovery is not configured yet.');
  }

  const url = actorRunUrl(config.actorId, config.apiToken);
  const input = buildDiscoveryInput({ query, location, maxResults }, config);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  let resp, data;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal
    });
    try { data = await resp.json(); } catch { data = null; }
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'timed out' : (e.message || 'request failed');
    throw new Error(`Could not reach the lead discovery service (${reason}).`);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const detail = (data && (data.error?.message || data.message)) || `HTTP ${resp.status}`;
    throw new Error(`Lead discovery request was rejected: ${detail}`);
  }
  if (!Array.isArray(data)) {
    throw new Error('Lead discovery returned an unexpected response.');
  }

  const leads = [];
  for (const item of data) {
    const lead = mapResultToLead(item);
    if (lead) leads.push(lead);
  }
  return leads;
}

module.exports = {
  getDiscoveryConfig,
  isConfigured,
  missingFields,
  buildDiscoveryInput,
  actorRunUrl,
  mapResultToLead,
  findLeads
};
