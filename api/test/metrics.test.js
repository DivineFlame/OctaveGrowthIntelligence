'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../src/metrics');

test.beforeEach(() => {
  metrics._reset();
});

test('recordRequest + renderMetrics: counts a request under its route, method and status class', () => {
  metrics.recordRequest('GET', '/health', 200, 0.01);
  const out = metrics.renderMetrics();
  assert.match(out, /orgcomms_http_requests_total\{route="\/health",method="GET",status="2xx"\} 1/);
});

test('recordRequest: two requests to the same series accumulate, not overwrite', () => {
  metrics.recordRequest('GET', '/health', 200, 0.01);
  metrics.recordRequest('GET', '/health', 200, 0.02);
  const out = metrics.renderMetrics();
  assert.match(out, /orgcomms_http_requests_total\{route="\/health",method="GET",status="2xx"\} 2/);
});

test('recordRequest: different status codes in the same 100s bucket collapse to one status class series, others stay separate', () => {
  metrics.recordRequest('GET', '/users', 200, 0.01);
  metrics.recordRequest('GET', '/users', 201, 0.01);
  metrics.recordRequest('GET', '/users', 404, 0.01);
  metrics.recordRequest('GET', '/users', 500, 0.01);
  const out = metrics.renderMetrics();
  assert.match(out, /orgcomms_http_requests_total\{route="\/users",method="GET",status="2xx"\} 2/);
  assert.match(out, /orgcomms_http_requests_total\{route="\/users",method="GET",status="4xx"\} 1/);
  assert.match(out, /orgcomms_http_requests_total\{route="\/users",method="GET",status="5xx"\} 1/);
});

test('recordRequest: histogram buckets are cumulative (le semantics) and +Inf equals total count', () => {
  metrics.recordRequest('POST', '/leads', 200, 0.005); // falls in every bucket >= 0.01
  metrics.recordRequest('POST', '/leads', 200, 3); // only falls in buckets >= 5 and +Inf
  const out = metrics.renderMetrics();
  assert.match(out, /orgcomms_http_request_duration_seconds_bucket\{route="\/leads",method="POST",le="0.01"\} 1/);
  assert.match(out, /orgcomms_http_request_duration_seconds_bucket\{route="\/leads",method="POST",le="5"\} 2/);
  assert.match(out, /orgcomms_http_request_duration_seconds_bucket\{route="\/leads",method="POST",le="\+Inf"\} 2/);
  assert.match(out, /orgcomms_http_request_duration_seconds_count\{route="\/leads",method="POST"\} 2/);
});

test('recordError: increments the orgcomms_errors_total counter', () => {
  metrics.recordError();
  metrics.recordError();
  const out = metrics.renderMetrics();
  assert.match(out, /orgcomms_errors_total 2/);
});

test('renderMetrics: emits process uptime and memory gauges even with zero requests recorded', () => {
  const out = metrics.renderMetrics();
  assert.match(out, /orgcomms_process_uptime_seconds \d/);
  assert.match(out, /orgcomms_process_resident_memory_bytes \d/);
  assert.match(out, /orgcomms_process_heap_used_bytes \d/);
});

test('normalizeRoute: uses the matched Express route pattern (with baseUrl), not the raw per-request path', () => {
  const req = { route: { path: '/:userId/role' }, baseUrl: '/users', path: '/abc123/role' };
  assert.equal(metrics.normalizeRoute(req), '/users/:userId/role');
});

test('normalizeRoute: falls back to a fixed label when no route matched (e.g. a 404)', () => {
  const req = { route: undefined, path: '/does/not/exist' };
  assert.equal(metrics.normalizeRoute(req), '__unmatched__');
});

test('renderMetrics: label values are escaped so a route/method containing a quote cannot break the exposition format', () => {
  metrics.recordRequest('GET', '/weird"route', 200, 0.01);
  const out = metrics.renderMetrics();
  assert.match(out, /route="\/weird\\"route"/);
});
