'use strict';

/**
 * Optional error tracking (Sentry), following the same pattern as the
 * off-host backup shipping in postgres/backup/backup.sh: entirely inert
 * unless explicitly configured (SENTRY_DSN), and a failure to initialize
 * or report never breaks the request it happened on - error tracking
 * losing an error is bad, but it is never as bad as the API going down
 * because the error tracker itself threw.
 */

let Sentry = null;
let enabled = false;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    enabled = false;
    return false;
  }
  try {
    // eslint-disable-next-line global-require
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE || undefined,
      // Purely error tracking, not tracing/APM - keep this at 0 so the
      // dependency never adds per-request overhead or sends span data
      // nobody asked for.
      tracesSampleRate: 0,
    });
    enabled = true;
    console.log('[error-tracking] Sentry initialized (SENTRY_DSN set)');
  } catch (e) {
    console.error('[error-tracking] SENTRY_DSN is set but Sentry failed to initialize - continuing without error tracking:', e.message);
    Sentry = null;
    enabled = false;
  }
  return enabled;
}

function captureError(err, context) {
  if (!enabled || !Sentry) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch (e) {
    // Never let a broken error-reporting path mask or throw over the
    // original error it was trying to report.
    console.error('[error-tracking] captureException failed:', e.message);
  }
}

function isEnabled() {
  return enabled;
}

// Test-only.
function _reset() {
  Sentry = null;
  enabled = false;
}

module.exports = { init, captureError, isEnabled, _reset };
