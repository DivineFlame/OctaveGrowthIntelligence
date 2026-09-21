'use strict';

/**
 * Minimal, dependency-free Prometheus-style metrics.
 *
 * Deliberately hand-rolled instead of pulling in prom-client: the app's
 * needs here are a handful of counters and one latency histogram, and
 * keeping this dependency-free means it needs no npm install to verify,
 * matches the rest of this codebase's "use node:test, not a framework"
 * philosophy, and is trivially unit-testable as pure functions.
 */

const startTime = Date.now();

// route -> method -> status class ("2xx","4xx","5xx") -> count
const httpRequestsTotal = new Map();

// `${method} ${route}` -> { sum, count, buckets: Map(bound->count) }
// Bucketed on record so render stays O(series), not O(samples).
const HISTOGRAM_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const httpRequestDuration = new Map();

let errorsTotal = 0;

function statusClass(code) {
  return `${Math.floor(code / 100)}xx`;
}

function normalizeRoute(req) {
  // Prefer the matched Express route pattern (e.g. "/users/:userId/role")
  // over the raw path, so "/users/abc" and "/users/def" collapse into one
  // series instead of creating unbounded cardinality per unique id.
  if (req.route && req.route.path) {
    const base = req.baseUrl || '';
    return base + req.route.path;
  }
  return '__unmatched__';
}

function recordRequest(method, route, statusCode, durationSeconds) {
  const cls = statusClass(statusCode);
  if (!httpRequestsTotal.has(route)) httpRequestsTotal.set(route, new Map());
  const byMethod = httpRequestsTotal.get(route);
  if (!byMethod.has(method)) byMethod.set(method, new Map());
  const byClass = byMethod.get(method);
  byClass.set(cls, (byClass.get(cls) || 0) + 1);

  const key = `${method} ${route}`;
  if (!httpRequestDuration.has(key)) {
    httpRequestDuration.set(key, { sum: 0, count: 0, buckets: new Map(HISTOGRAM_BUCKETS.map((b) => [b, 0])) });
  }
  const hist = httpRequestDuration.get(key);
  hist.sum += durationSeconds;
  hist.count += 1;
  for (const bound of HISTOGRAM_BUCKETS) {
    if (durationSeconds <= bound) hist.buckets.set(bound, hist.buckets.get(bound) + 1);
  }
}

function recordError() {
  errorsTotal += 1;
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderMetrics() {
  const lines = [];

  lines.push('# HELP orgcomms_http_requests_total Total HTTP requests by route, method and status class');
  lines.push('# TYPE orgcomms_http_requests_total counter');
  for (const [route, byMethod] of httpRequestsTotal) {
    for (const [method, byClass] of byMethod) {
      for (const [cls, count] of byClass) {
        lines.push(
          `orgcomms_http_requests_total{route="${escapeLabel(route)}",method="${escapeLabel(method)}",status="${cls}"} ${count}`
        );
      }
    }
  }

  lines.push('# HELP orgcomms_http_request_duration_seconds HTTP request duration in seconds');
  lines.push('# TYPE orgcomms_http_request_duration_seconds histogram');
  for (const [key, hist] of httpRequestDuration) {
    const [method, ...routeParts] = key.split(' ');
    const route = routeParts.join(' ');
    let cumulative = 0;
    for (const bound of HISTOGRAM_BUCKETS) {
      cumulative = hist.buckets.get(bound);
      lines.push(
        `orgcomms_http_request_duration_seconds_bucket{route="${escapeLabel(route)}",method="${escapeLabel(method)}",le="${bound}"} ${cumulative}`
      );
    }
    lines.push(
      `orgcomms_http_request_duration_seconds_bucket{route="${escapeLabel(route)}",method="${escapeLabel(method)}",le="+Inf"} ${hist.count}`
    );
    lines.push(
      `orgcomms_http_request_duration_seconds_sum{route="${escapeLabel(route)}",method="${escapeLabel(method)}"} ${hist.sum}`
    );
    lines.push(
      `orgcomms_http_request_duration_seconds_count{route="${escapeLabel(route)}",method="${escapeLabel(method)}"} ${hist.count}`
    );
  }

  lines.push('# HELP orgcomms_errors_total Total server-side (5xx) errors handled by serverError()');
  lines.push('# TYPE orgcomms_errors_total counter');
  lines.push(`orgcomms_errors_total ${errorsTotal}`);

  lines.push('# HELP orgcomms_process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE orgcomms_process_uptime_seconds gauge');
  lines.push(`orgcomms_process_uptime_seconds ${(Date.now() - startTime) / 1000}`);

  const mem = process.memoryUsage();
  lines.push('# HELP orgcomms_process_resident_memory_bytes Resident memory size in bytes');
  lines.push('# TYPE orgcomms_process_resident_memory_bytes gauge');
  lines.push(`orgcomms_process_resident_memory_bytes ${mem.rss}`);
  lines.push('# HELP orgcomms_process_heap_used_bytes V8 heap used in bytes');
  lines.push('# TYPE orgcomms_process_heap_used_bytes gauge');
  lines.push(`orgcomms_process_heap_used_bytes ${mem.heapUsed}`);

  return lines.join('\n') + '\n';
}

// Test-only: resets all in-memory state so tests don't bleed into each other.
function _reset() {
  httpRequestsTotal.clear();
  httpRequestDuration.clear();
  errorsTotal = 0;
}

module.exports = { recordRequest, recordError, renderMetrics, normalizeRoute, _reset };
