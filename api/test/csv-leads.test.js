// Unit tests for api/src/csv-leads.js - the sanitize/validate/dedup logic
// POST /leads/upload-csv runs every uploaded row through before any of it
// reaches the database. Extracted so this can be tested directly instead
// of only being checkable by actually uploading a CSV to a running server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCsvRecord, processLeadCsvRecords } = require('../src/csv-leads');

test('sanitizeCsvRecord normalizes column names to lowercase-letters-only', () => {
  const out = sanitizeCsvRecord({ 'Company Name': 'Acme', 'PHONE-NUMBER': '911234567890', 'E.Mail': 'a@b.com' });
  assert.deepEqual(out, { company_name: 'Acme', phone_number: '911234567890', e_mail: 'a@b.com' });
});

test('sanitizeCsvRecord also applies the CSV-formula-injection guard to a phone number starting with +', () => {
  // Same rule as every other value (see sanitizeCSVValue in validators.js)
  // - a leading "+" is one of the characters Excel/Sheets treats as a
  // formula prefix, and a phone number is exactly the kind of field a
  // real CSV export is likely to have one in.
  const out = sanitizeCsvRecord({ phone: '+911234567890' });
  assert.equal(out.phone, "'+911234567890");
});

test('sanitizeCsvRecord runs every value through sanitizeCSVValue (formula-injection + HTML)', () => {
  const out = sanitizeCsvRecord({ company: '=cmd|/c calc', notes: '<script>alert(1)</script>hi' });
  assert.equal(out.company, "'=cmd|/c calc");
  assert.equal(out.notes, 'alert(1)hi');
});

test('processLeadCsvRecords counts valid rows and returns them for insertion', () => {
  const result = processLeadCsvRecords([
    { company: 'Acme', email: 'a@acme.com', phone: '+911111111111' },
    { company: 'Beta', email: 'b@beta.com', phone: '+912222222222' }
  ]);
  assert.equal(result.valid, 2);
  assert.equal(result.dup, 0);
  assert.equal(result.invalid, 0);
  assert.equal(result.toInsert.length, 2);
});

test('processLeadCsvRecords rejects a row with a malformed email as invalid, not inserted', () => {
  const result = processLeadCsvRecords([
    { company: 'Acme', email: 'not-an-email', phone: '+911111111111' },
    { company: 'Beta', email: 'b@beta.com', phone: '+912222222222' }
  ]);
  assert.equal(result.invalid, 1);
  assert.equal(result.valid, 1);
  assert.equal(result.toInsert.length, 1);
  assert.equal(result.toInsert[0].company, 'Beta');
});

test('processLeadCsvRecords allows a row with no email at all (phone-only lead)', () => {
  const result = processLeadCsvRecords([{ company: 'Acme', phone: '+911111111111' }]);
  assert.equal(result.valid, 1);
  assert.equal(result.invalid, 0);
});

test('processLeadCsvRecords deduplicates by phone+email, case-insensitively', () => {
  const result = processLeadCsvRecords([
    { company: 'Acme', email: 'Same@Example.com', phone: '+911111111111' },
    { company: 'Acme (dup)', email: 'same@example.com', phone: '+911111111111' }
  ]);
  assert.equal(result.valid, 1);
  assert.equal(result.dup, 1);
  assert.equal(result.toInsert.length, 1);
  assert.equal(result.toInsert[0].company, 'Acme', 'the first occurrence should be kept, not the duplicate');
});

test('processLeadCsvRecords treats different phone+email pairs as distinct, even with a shared field', () => {
  const result = processLeadCsvRecords([
    { company: 'Acme', email: 'a@acme.com', phone: '+911111111111' },
    { company: 'Acme Branch', email: 'branch@acme.com', phone: '+911111111111' } // same phone, different email
  ]);
  assert.equal(result.dup, 0, 'sharing only one of phone/email should not count as a duplicate');
  assert.equal(result.valid, 2);
});

test('processLeadCsvRecords accepts phone under any of the recognized column aliases', () => {
  // mobile / phone_number are recognized fallbacks for the phone column,
  // since uploaded CSVs come from many different CRMs with different
  // header conventions.
  const a = processLeadCsvRecords([{ company: 'A', mobile: '+911111111111' }]);
  const b = processLeadCsvRecords([{ company: 'B', phone_number: '+912222222222' }]);
  assert.equal(a.valid, 1);
  assert.equal(b.valid, 1);
});

test('processLeadCsvRecords handles an empty file (zero records)', () => {
  const result = processLeadCsvRecords([]);
  assert.deepEqual(result, { sanitized: [], toInsert: [], valid: 0, dup: 0, invalid: 0 });
});
