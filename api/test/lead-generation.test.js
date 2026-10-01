// Unit tests for api/src/lead-generation.js (automated lead discovery via
// a third-party scraping provider, configured entirely through APIFY_*
// env vars - see that module's header comment and README.md). Mirrors
// voice-agent.test.js's structure: pure/env-free pieces get direct
// assertions, the actual HTTP call is covered with fetch mocked, and the
// real network path (findLeads() against a real, unconfigured env) is
// exercised indirectly via the integration tests hitting POST
// /leads/discover - see routes.integration.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const leadGeneration = require('../src/lead-generation');

const FULL_CONFIG = {
  apiToken: 'token123',
  actorId: 'compass/google-maps-extractor',
  maxResults: 30,
  language: 'en'
};

test('isConfigured is true only when an API token is set', () => {
  assert.equal(leadGeneration.isConfigured(FULL_CONFIG), true);
  assert.equal(leadGeneration.isConfigured({ ...FULL_CONFIG, apiToken: '' }), false);
});

test('missingFields names the token when unset, and is empty otherwise', () => {
  assert.deepEqual(leadGeneration.missingFields({ ...FULL_CONFIG, apiToken: '' }), ['APIFY_API_TOKEN']);
  assert.deepEqual(leadGeneration.missingFields(FULL_CONFIG), []);
});

test('getDiscoveryConfig reads from process.env fresh (not cached at require time)', () => {
  const prev = process.env.APIFY_API_TOKEN;
  try {
    process.env.APIFY_API_TOKEN = 'token-from-env';
    assert.equal(leadGeneration.getDiscoveryConfig().apiToken, 'token-from-env');
  } finally {
    if (prev === undefined) delete process.env.APIFY_API_TOKEN;
    else process.env.APIFY_API_TOKEN = prev;
  }
});

test('getDiscoveryConfig defaults actorId, maxResults and language when unset', () => {
  const prev = { actor: process.env.APIFY_ACTOR_ID, max: process.env.APIFY_MAX_RESULTS, lang: process.env.APIFY_LANGUAGE };
  try {
    delete process.env.APIFY_ACTOR_ID;
    delete process.env.APIFY_MAX_RESULTS;
    delete process.env.APIFY_LANGUAGE;
    const config = leadGeneration.getDiscoveryConfig();
    assert.equal(config.actorId, 'compass/google-maps-extractor');
    assert.equal(config.maxResults, 30);
    assert.equal(config.language, 'en');
  } finally {
    if (prev.actor === undefined) delete process.env.APIFY_ACTOR_ID; else process.env.APIFY_ACTOR_ID = prev.actor;
    if (prev.max === undefined) delete process.env.APIFY_MAX_RESULTS; else process.env.APIFY_MAX_RESULTS = prev.max;
    if (prev.lang === undefined) delete process.env.APIFY_LANGUAGE; else process.env.APIFY_LANGUAGE = prev.lang;
  }
});

test('getDiscoveryConfig caps APIFY_MAX_RESULTS at the app\'s own hard ceiling', () => {
  const prev = process.env.APIFY_MAX_RESULTS;
  try {
    process.env.APIFY_MAX_RESULTS = '999';
    assert.equal(leadGeneration.getDiscoveryConfig().maxResults, 100);
    process.env.APIFY_MAX_RESULTS = 'not-a-number';
    assert.equal(leadGeneration.getDiscoveryConfig().maxResults, 30);
  } finally {
    if (prev === undefined) delete process.env.APIFY_MAX_RESULTS;
    else process.env.APIFY_MAX_RESULTS = prev;
  }
});

test('buildDiscoveryInput matches the Google Maps Extractor actor\'s documented input shape', () => {
  const input = leadGeneration.buildDiscoveryInput({ query: 'dental clinics', location: 'Mumbai' }, FULL_CONFIG);
  assert.deepEqual(input, {
    searchStringsArray: ['dental clinics'],
    maxCrawledPlacesPerSearch: 30,
    language: 'en',
    locationQuery: 'Mumbai'
  });
});

test('buildDiscoveryInput omits locationQuery entirely when no location is given', () => {
  const input = leadGeneration.buildDiscoveryInput({ query: 'plumbers' }, FULL_CONFIG);
  assert.equal('locationQuery' in input, false);
});

test('buildDiscoveryInput respects a per-call maxResults, capped at the hard ceiling', () => {
  assert.equal(leadGeneration.buildDiscoveryInput({ query: 'x', maxResults: 5 }, FULL_CONFIG).maxCrawledPlacesPerSearch, 5);
  assert.equal(leadGeneration.buildDiscoveryInput({ query: 'x', maxResults: 500 }, FULL_CONFIG).maxCrawledPlacesPerSearch, 100);
});

test('actorRunUrl substitutes ~ for / in the actor slug and includes the token', () => {
  const url = leadGeneration.actorRunUrl('compass/google-maps-extractor', 'tok123');
  assert.equal(url, 'https://api.apify.com/v2/actors/compass~google-maps-extractor/run-sync-get-dataset-items?token=tok123');
});

test('mapResultToLead extracts the fields this app uses, defaulting anything missing', () => {
  const lead = leadGeneration.mapResultToLead({
    title: 'Acme Dental',
    phoneUnformatted: '+919876543210',
    website: 'https://acme.in',
    address: '123 MG Road',
    city: 'Mumbai',
    categoryName: 'Dentist'
  });
  assert.deepEqual(lead, {
    company_name: 'Acme Dental',
    phone: '+919876543210',
    website: 'https://acme.in',
    address: '123 MG Road, Mumbai',
    category: 'Dentist'
  });
});

test('mapResultToLead returns null for an item with no usable name', () => {
  assert.equal(leadGeneration.mapResultToLead({ phone: '123' }), null);
  assert.equal(leadGeneration.mapResultToLead(null), null);
  assert.equal(leadGeneration.mapResultToLead('not an object'), null);
});

test('mapResultToLead falls back to categories[0] when categoryName is absent', () => {
  const lead = leadGeneration.mapResultToLead({ title: 'Beta Co', categories: ['Plumber', 'Contractor'] });
  assert.equal(lead.category, 'Plumber');
});

test('findLeads throws without a network call when the query is blank', async () => {
  await assert.rejects(() => leadGeneration.findLeads({ query: '' }, FULL_CONFIG), /search term is required/);
  await assert.rejects(() => leadGeneration.findLeads({ query: '   ' }, FULL_CONFIG), /search term is required/);
});

test('findLeads throws a plain "not configured" error, without a network call, when unconfigured', async () => {
  await assert.rejects(
    () => leadGeneration.findLeads({ query: 'plumbers' }, { ...FULL_CONFIG, apiToken: '' }),
    /not configured/
  );
});

// --- findLeads's HTTP handling, with fetch mocked (no network calls) ---

function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original; });
}

test('findLeads maps a successful dataset response into lead-shaped objects', async () => {
  await withMockedFetch(
    async () => ({
      ok: true,
      json: async () => ([
        { title: 'Acme Dental', phone: '123' },
        { title: 'Beta Clinic', phone: '456' },
        { noUsableName: true } // dropped by mapResultToLead
      ])
    }),
    async () => {
      const leads = await leadGeneration.findLeads({ query: 'dentists', location: 'Pune' }, FULL_CONFIG);
      assert.equal(leads.length, 2);
      assert.equal(leads[0].company_name, 'Acme Dental');
      assert.equal(leads[1].company_name, 'Beta Clinic');
    }
  );
});

test('findLeads throws with the provider\'s own error message on a non-OK response', async () => {
  await withMockedFetch(
    async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API token' } }) }),
    async () => {
      await assert.rejects(
        () => leadGeneration.findLeads({ query: 'plumbers' }, FULL_CONFIG),
        /Invalid API token/
      );
    }
  );
});

test('findLeads throws a clear error when the response body isn\'t an array', async () => {
  await withMockedFetch(
    async () => ({ ok: true, json: async () => ({ not: 'an array' }) }),
    async () => {
      await assert.rejects(
        () => leadGeneration.findLeads({ query: 'plumbers' }, FULL_CONFIG),
        /unexpected response/
      );
    }
  );
});

test('findLeads wraps a network failure in a generic, provider-agnostic message', async () => {
  await withMockedFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    async () => {
      await assert.rejects(
        () => leadGeneration.findLeads({ query: 'plumbers' }, FULL_CONFIG),
        /Could not reach the lead discovery service/
      );
    }
  );
});
