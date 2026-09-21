'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const errorTracking = require('../src/error-tracking');

test.beforeEach(() => {
  errorTracking._reset();
  delete process.env.SENTRY_DSN;
});

test('init: is a complete no-op when SENTRY_DSN is not set (the default, unconfigured state)', () => {
  const result = errorTracking.init();
  assert.equal(result, false);
  assert.equal(errorTracking.isEnabled(), false);
});

test('captureError: never throws when tracking is not enabled', () => {
  errorTracking.init(); // no DSN -> disabled
  assert.doesNotThrow(() => errorTracking.captureError(new Error('boom')));
  assert.doesNotThrow(() => errorTracking.captureError(new Error('boom'), { userId: '123' }));
});

test('init: a malformed/unusable SENTRY_DSN is caught, not thrown - the app must still boot', () => {
  process.env.SENTRY_DSN = 'not-a-valid-dsn-at-all';
  assert.doesNotThrow(() => errorTracking.init());
  // Whether the SDK accepts or rejects this string is up to @sentry/node's
  // own validation; either way init() must return without throwing and
  // isEnabled() must reflect whatever it decided, not leave state undefined.
  assert.equal(typeof errorTracking.isEnabled(), 'boolean');
});

test('isEnabled: reports false before init() has ever been called (post-reset)', () => {
  assert.equal(errorTracking.isEnabled(), false);
});
