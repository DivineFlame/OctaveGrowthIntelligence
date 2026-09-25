// Unit tests for api/src/reply-formatting.js - see lead-enrichment.test.js
// for why these small pure helpers are pulled out of server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatReplyHtml, escapeHtml } = require('../src/reply-formatting');

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(escapeHtml('<script>alert(1)</script> & "quoted" \'x\''),
    '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;x&#39;');
});

test('escapeHtml treats null/undefined as empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('formatReplyHtml wraps plain text in a paragraph', () => {
  assert.equal(formatReplyHtml('hello there'), '<p>hello there</p>');
});

test('formatReplyHtml renders **bold**, *italic*/_italic_, and __underline__', () => {
  assert.equal(formatReplyHtml('**bold** and *italic* and _also italic_ and __underline__'),
    '<p><strong>bold</strong> and <em>italic</em> and <em>also italic</em> and <u>underline</u></p>');
});

test('formatReplyHtml groups consecutive "- " lines into one <ul>', () => {
  assert.equal(formatReplyHtml('- one\n- two\n- three'),
    '<ul><li>one</li><li>two</li><li>three</li></ul>');
});

test('formatReplyHtml separates paragraphs on a blank line and uses <br> for a single newline', () => {
  assert.equal(formatReplyHtml('line one\nline two\n\nsecond paragraph'),
    '<p>line one<br>line two</p>\n<p>second paragraph</p>');
});

test('formatReplyHtml interleaves paragraphs and bullet lists in source order', () => {
  assert.equal(formatReplyHtml('intro\n- a\n- b\noutro'),
    '<p>intro</p>\n<ul><li>a</li><li>b</li></ul>\n<p>outro</p>');
});

test('formatReplyHtml escapes HTML before applying formatting tokens - never emits attacker HTML', () => {
  const out = formatReplyHtml('<img src=x onerror=alert(1)> **<b>nope</b>**');
  // No actual tag survives unescaped - "onerror" as inert escaped text
  // inside &lt;img ...&gt; is harmless; an unescaped <img ...> attribute
  // would not be.
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(out.includes('<strong>&lt;b&gt;nope&lt;/b&gt;</strong>'));
});

test('formatReplyHtml handles empty/whitespace-only input without throwing', () => {
  assert.equal(formatReplyHtml(''), '');
  assert.equal(formatReplyHtml(null), '');
  assert.equal(formatReplyHtml(undefined), '');
});
