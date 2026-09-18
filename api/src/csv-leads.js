// Turns raw parsed CSV rows (from csv-parse, one plain object per row with
// whatever headers the uploaded file actually used) into the sanitized,
// deduplicated, validated set that POST /leads/upload-csv actually inserts.
// Pulled out of that route handler as a pure function - it doesn't touch
// the DB, file system, or request/response objects, so unlike most of
// server.js it's safely testable in isolation (see api/test/ and
// README.md "Hardening notes" for why the rest of server.js isn't).
const { sanitizeCSVValue } = require('./validators');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalizes every column name to lowercase-letters-only (so "Company Name",
// "company_name" and "COMPANY-NAME" all become "company_name") and runs
// every value through sanitizeCSVValue (CSV-formula-injection prefixing +
// HTML stripping - see validators.js).
function sanitizeCsvRecord(record) {
  const obj = {};
  for (const k in record) {
    obj[k.toLowerCase().replace(/[^a-z]/g, '_')] = sanitizeCSVValue(record[k]);
  }
  return obj;
}

// Sanitizes every record, then validates and deduplicates by phone+email
// (case-insensitive). A row with an email that doesn't look like an email
// is rejected outright rather than imported with garbage data; a row whose
// phone+email pair was already seen earlier in the same file is counted as
// a duplicate and skipped, not inserted twice. Returns counts alongside
// the rows actually destined for insertion, matching what the route's
// response and its csv_uploads audit row report back to the uploader.
function processLeadCsvRecords(records) {
  const sanitized = records.map(sanitizeCsvRecord);

  const seen = new Set();
  let dup = 0, valid = 0, invalid = 0;
  const toInsert = [];
  for (const row of sanitized) {
    const phone = row.phone || row.mobile || row.phone_number || '';
    const email = row.email || '';
    if (email && !EMAIL_REGEX.test(email)) { invalid++; continue; }
    const key = `${phone}|${email}`.toLowerCase();
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    toInsert.push(row);
    valid++;
  }

  return { sanitized, toInsert, valid, dup, invalid };
}

module.exports = { sanitizeCsvRecord, processLeadCsvRecords, EMAIL_REGEX };
