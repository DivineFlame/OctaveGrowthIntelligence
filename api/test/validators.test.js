// Unit tests for api/src/validators.js - see channels.test.js for why
// these small pure helpers were pulled out of server.js in the first
// place (server.js itself can't safely be require()'d in a test).

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDomain, sanitizeCSVValue } = require('../src/validators');

test('normalizeDomain strips http(s):// and trailing slashes', () => {
  assert.equal(normalizeDomain('https://api.example.com'), 'api.example.com');
  assert.equal(normalizeDomain('http://api.example.com/'), 'api.example.com');
  assert.equal(normalizeDomain('api.example.com'), 'api.example.com');
  assert.equal(normalizeDomain('https://api.example.com///'), 'api.example.com');
});

test('normalizeDomain trims whitespace', () => {
  assert.equal(normalizeDomain('  api.example.com  '), 'api.example.com');
});

test('normalizeDomain handles unset/empty input without throwing', () => {
  assert.equal(normalizeDomain(undefined), '');
  assert.equal(normalizeDomain(null), '');
  assert.equal(normalizeDomain(''), '');
});

test('sanitizeCSVValue prefixes formula-injection characters with a quote', () => {
  // These are the characters Excel/Sheets treat as a formula prefix when a
  // .csv is opened/exported - the app has to defuse them on the way in, or
  // a crafted lead name like "=cmd|'/c calc'!A0" becomes a live formula for
  // whoever opens an export later.
  assert.equal(sanitizeCSVValue('=cmd|/c calc'), "'=cmd|/c calc");
  assert.equal(sanitizeCSVValue('+1234'), "'+1234");
  assert.equal(sanitizeCSVValue('-1234'), "'-1234");
  assert.equal(sanitizeCSVValue('@SUM(A1:A9)'), "'@SUM(A1:A9)");
});

test('sanitizeCSVValue strips HTML tags', () => {
  assert.equal(sanitizeCSVValue('<script>alert(1)</script>Acme Corp'), 'alert(1)Acme Corp');
  assert.equal(sanitizeCSVValue('Acme <b>Corp</b>'), 'Acme Corp');
});

test('sanitizeCSVValue trims whitespace on an otherwise-safe value', () => {
  assert.equal(sanitizeCSVValue('  Acme Corp  '), 'Acme Corp');
});

test('sanitizeCSVValue leaves non-string input (numbers, null) untouched', () => {
  assert.equal(sanitizeCSVValue(42), 42);
  assert.equal(sanitizeCSVValue(null), null);
  assert.equal(sanitizeCSVValue(undefined), undefined);
});
