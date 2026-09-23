// Unit tests for api/src/lead-enrichment.js - see validators.test.js for why
// these small pure helpers were pulled out of server.js in the first place.

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguage, extractGstin, gstinChecksum } = require('../src/lead-enrichment');

test('detectLanguage returns null for empty/whitespace/no-letters text', () => {
  assert.equal(detectLanguage(''), null);
  assert.equal(detectLanguage('   '), null);
  assert.equal(detectLanguage('12345 !!!'), null);
  assert.equal(detectLanguage(undefined), null);
  assert.equal(detectLanguage(null), null);
});

test('detectLanguage returns en for Latin-script text', () => {
  assert.equal(detectLanguage('Interested in your product, please call me'), 'en');
});

test('detectLanguage detects Devanagari script (Hindi/Marathi)', () => {
  assert.equal(detectLanguage('मुझे आपके उत्पाद में दिलचस्पी है'), 'hi_or_mr');
});

test('detectLanguage detects Tamil script', () => {
  assert.equal(detectLanguage('உங்கள் தயாரிப்பில் எனக்கு ஆர்வம் உள்ளது'), 'ta');
});

test('detectLanguage prefers the first non-Latin script it finds over English boilerplate mixed in', () => {
  // A common real-world shape: a lead types mostly in their own language
  // but keeps an English brand/product name inline.
  assert.equal(detectLanguage('Octave प्रोडक्ट के बारे में जानकारी चाहिए'), 'hi_or_mr');
});

// '27AAPFU0939F1Z' is a 14-char GSTIN prefix built to the real spec (2-digit
// state code, 10-char PAN, 1-digit entity number, fixed 'Z') - not a real
// registered number, just a structurally valid one to compute a checksum
// against. See gstinChecksum's own header comment for the algorithm.
const VALID_PREFIX14 = '27AAPFU0939F1Z';

test('gstinChecksum computes a single checksum character for a 14-char prefix', () => {
  const check = gstinChecksum(VALID_PREFIX14);
  assert.equal(typeof check, 'string');
  assert.equal(check.length, 1);
});

test('extractGstin finds a GSTIN-shaped number in free text and reports a correct checksum as valid', () => {
  const check = gstinChecksum(VALID_PREFIX14);
  const gstin = VALID_PREFIX14 + check;
  const result = extractGstin(`Please send invoice to our GST number ${gstin} at the earliest`);
  assert.ok(result);
  assert.equal(result.gstin, gstin);
  assert.equal(result.valid, true);
});

test('extractGstin flags a tampered checksum as invalid without throwing', () => {
  const check = gstinChecksum(VALID_PREFIX14);
  const wrongCheck = check === '0' ? '1' : '0';
  const gstin = VALID_PREFIX14 + wrongCheck;
  const result = extractGstin(`GSTIN: ${gstin}`);
  assert.ok(result);
  assert.equal(result.gstin, gstin);
  assert.equal(result.valid, false);
});

test('extractGstin returns null when no GSTIN-shaped substring is present', () => {
  assert.equal(extractGstin('Just interested in a demo, no GST details yet'), null);
  assert.equal(extractGstin(''), null);
  assert.equal(extractGstin(undefined), null);
});
