// Small, pure, side-effect-free helpers pulled out of server.js so they
// can be unit tested directly (server.js itself connects to Postgres/Redis
// and calls app.listen() as a side effect of being required, so it can't
// safely be `require()`d from a test - see api/test/ and README.md
// "Hardening notes"). Behavior is unchanged from the inline versions these
// replaced; only the location moved.

// Strips a scheme and any trailing slash(es) so APP_DOMAIN/API_DOMAIN can
// be compared/used consistently regardless of how an operator wrote them
// in .env (with or without "https://", with or without a trailing "/").
function normalizeDomain(d) {
  return (d || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// Defends a CSV-imported string against two different things at once:
// CSV/formula injection (a value starting with =, +, - or @ gets
// interpreted as a formula by Excel/Sheets when the value is later
// exported or opened as CSV again - prefixing with a single quote forces
// it to be read as plain text) and any HTML the value might contain
// (stripped outright, since these values can end up rendered in the
// frontend - see the XSS fixes elsewhere in README.md "Hardening notes").
// Non-string input (e.g. already-parsed numbers/nulls) passes through
// unchanged.
function sanitizeCSVValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (/^[=\+\-@]/.test(trimmed)) return `'${trimmed}`; // Prevent CSV injection
  return trimmed.replace(/<[^>]*>/g, ''); // Strip HTML
}

module.exports = { normalizeDomain, sanitizeCSVValue };
