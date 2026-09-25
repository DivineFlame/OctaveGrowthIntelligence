// A deliberately tiny, safe subset of markdown for the lead-reply composer
// (see MessagesPanel.jsx's formatting toolbar and POST /leads/:id/reply).
// Only four constructs are recognized: **bold**, *italic* or _italic_,
// __underline__, and "- " bullet lines. Everything else is escaped and
// passed through untouched.
//
// This is intentionally NOT a general markdown or HTML sanitizer, and
// there is no contentEditable/dangerouslySetInnerHTML anywhere in this
// feature - the composer is a plain <textarea> that inserts these exact
// tokens, and this function only ever emits its own fixed set of tags
// around already-escaped text. That's what keeps a lead's own inbound
// messages (rendered as plain text, never through this function) and an
// admin's outbound replies both safe from injecting arbitrary HTML into
// an actual sent email.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

// Applies the three inline tokens to an already-escaped line. Order
// matters: bold's ** has to be pulled out before single-* italic, or
// **bold** would be read as an empty italic run either side of "bold".
function inlineFormat(escapedLine) {
  return escapedLine
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/(?:\*|_)([^*_]+?)(?:\*|_)/g, '<em>$1</em>');
}

// Converts the composer's plain-text body (with those tokens) into a
// small, valid HTML fragment - consecutive "- " lines become one <ul>,
// blank lines separate paragraphs, single newlines become <br>.
function formatReplyHtml(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let listBuffer = null; // array of <li> html while inside a bullet run

  function flushList() {
    if (listBuffer) {
      htmlParts.push('<ul>' + listBuffer.join('') + '</ul>');
      listBuffer = null;
    }
  }

  let paraBuffer = [];
  function flushPara() {
    if (paraBuffer.length) {
      htmlParts.push('<p>' + paraBuffer.join('<br>') + '</p>');
      paraBuffer = [];
    }
  }

  for (const rawLine of lines) {
    const bulletMatch = /^\s*-\s+(.*)$/.exec(rawLine);
    if (bulletMatch) {
      flushPara();
      if (!listBuffer) listBuffer = [];
      listBuffer.push('<li>' + inlineFormat(escapeHtml(bulletMatch[1])) + '</li>');
      continue;
    }
    flushList();
    if (rawLine.trim() === '') {
      flushPara();
      continue;
    }
    paraBuffer.push(inlineFormat(escapeHtml(rawLine)));
  }
  flushList();
  flushPara();

  return htmlParts.join('\n') || escapeHtml(body || '');
}

module.exports = { formatReplyHtml, escapeHtml };
