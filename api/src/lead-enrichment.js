// Real, honest lead enrichment - the two pieces mentioned in README.md's
// "Hardening notes" as previously unimplemented ("GSTIN lookup, language
// detection, and similar enrichment beyond that are still not
// implemented"). Both run on free text supplied with a lead (a webhook
// payload's message/note field, or a CSV row) with no external API call
// and no paid service - see the honesty notes on each function for exactly
// what that does and doesn't give you.
//
// Pulled out of server.js so both are independently unit-testable, same
// reasoning as validators.js/csv-leads.js.

// ---- Language detection -----------------------------------------------
// This is SCRIPT detection, not language identification - it looks at
// which Unicode block the text's letters fall in, which reliably tells
// Devanagari from Latin from Arabic, but can't tell Hindi from Marathi (both
// Devanagari), or Urdu from Arabic script generally, since those share a
// script but aren't the same language. Framed honestly as
// "detected_language" being a script-level signal for routing/filtering
// (e.g. "this inquiry wasn't in Latin script"), not a claim of full NLP
// language identification - there is no free, no-API-key language-ID
// service wired in here, and pretending script detection is more than
// that would be exactly the kind of fake-data-labeled-as-real-data this
// whole audit has been removing throughout the app.
const SCRIPT_RANGES = [
  ['hi_or_mr', /[ऀ-ॿ]/], // Devanagari (Hindi, Marathi, ...)
  ['bn', /[ঀ-৿]/], // Bengali/Assamese
  ['pa', /[਀-੿]/], // Gurmukhi (Punjabi)
  ['gu', /[઀-૿]/], // Gujarati
  ['or', /[଀-୿]/], // Odia
  ['ta', /[஀-௿]/], // Tamil
  ['te', /[ఀ-౿]/], // Telugu
  ['kn', /[ಀ-೿]/], // Kannada
  ['ml', /[ഀ-ൿ]/], // Malayalam
  ['ur_or_ar', /[؀-ۿ]/] // Arabic script (Urdu, Arabic)
];

// Returns a short code (see SCRIPT_RANGES) for the first non-Latin script
// found, 'en' if the text is Latin-script with at least one letter, or null
// for empty/whitespace-only/no-letters text (nothing to detect).
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const [code, re] of SCRIPT_RANGES) {
    if (re.test(trimmed)) return code;
  }
  return /[A-Za-z]/.test(trimmed) ? 'en' : null;
}

// ---- GSTIN extraction + checksum validation ----------------------------
// GSTIN format: 2-digit state code + 10-char PAN + 1-digit entity number +
// 'Z' (fixed) + 1 checksum character, 15 characters total. This extracts
// the first GSTIN-shaped substring from free text and verifies its
// checksum digit using GSTIN's published algorithm - a real structural/
// checksum validation, which confirms the number is well-formed, NOT that
// it is actually registered with the government. Real-time registry
// verification (is this GSTIN active, does the name match) would need a
// paid third-party API or GSP access this app has no credentials for -
// see README.md "Hardening notes" for that explicit limit, so this stays
// honestly scoped to "well-formed and checksum-correct", not "verified".
const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 15 chars total: 2-digit state code + 10-char PAN (5 letters, 4 digits, 1
// letter) + 1-digit entity number + 1 fixed 'Z' + 1 checksum character.
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z\d]\b/;

function gstinChecksum(gstin14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GSTIN_CHARSET.indexOf(gstin14[i]);
    if (code === -1) return null;
    const factor = (i % 2 === 0) ? 1 : 2;
    const product = factor * code;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkCode = (36 - (sum % 36)) % 36;
  return GSTIN_CHARSET[checkCode];
}

// Returns { gstin, valid } for the first GSTIN-shaped match in `text`, or
// null if no GSTIN-shaped substring is present at all.
function extractGstin(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.toUpperCase().match(GSTIN_RE);
  if (!match) return null;
  const gstin = match[0];
  const expected = gstinChecksum(gstin.slice(0, 14));
  return { gstin, valid: expected !== null && expected === gstin[14] };
}

module.exports = { detectLanguage, extractGstin, gstinChecksum };
