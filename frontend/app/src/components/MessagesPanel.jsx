import React, { useEffect, useRef, useState } from 'react';
import {
  Facebook,
  Instagram,
  Linkedin,
  Youtube,
  MessageCircle,
  Mail,
  Globe,
  Send,
  Inbox as InboxIcon,
  Bold,
  Italic,
  Underline,
  List,
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '../lib/api.js';

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB, matches the API's per-file limit
const ATTACHMENT_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,application/pdf';

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Renders the same tiny formatting subset as the API's reply-formatting.js
// (**bold**, *italic*/_italic_, __underline__, "- " bullet lines) but as
// real React elements built from plain text - never dangerouslySetInnerHTML
// - so a lead's own words can never inject markup into this app's own UI.
// Kept deliberately in lockstep with reply-formatting.js's rules; if one
// changes, the other should too.
function renderInline(line, keyPrefix) {
  const nodes = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|(?:\*|_)([^*_]+?)(?:\*|_)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(<strong key={`${keyPrefix}-${i++}`}>{m[1]}</strong>);
    else if (m[2] !== undefined) nodes.push(<u key={`${keyPrefix}-${i++}`}>{m[2]}</u>);
    else nodes.push(<em key={`${keyPrefix}-${i++}`}>{m[3]}</em>);
    last = re.lastIndex;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}

function renderFormattedBody(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let listBuffer = null;
  let paraBuffer = [];

  function flushList() {
    if (listBuffer) {
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="my-1 list-disc pl-4">
          {listBuffer.map((text, i) => (
            <li key={i}>{renderInline(text, `li-${blocks.length}-${i}`)}</li>
          ))}
        </ul>
      );
      listBuffer = null;
    }
  }
  function flushPara() {
    if (paraBuffer.length) {
      const idx = blocks.length;
      blocks.push(
        <p key={`p-${idx}`} className={idx > 0 ? 'mt-1' : ''}>
          {paraBuffer.map((text, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <br /> : null}
              {renderInline(text, `p-${idx}-${i}`)}
            </React.Fragment>
          ))}
        </p>
      );
      paraBuffer = [];
    }
  }

  for (const rawLine of lines) {
    const bulletMatch = /^\s*-\s+(.*)$/.exec(rawLine);
    if (bulletMatch) {
      flushPara();
      if (!listBuffer) listBuffer = [];
      listBuffer.push(bulletMatch[1]);
      continue;
    }
    flushList();
    if (rawLine.trim() === '') {
      flushPara();
      continue;
    }
    paraBuffer.push(rawLine);
  }
  flushList();
  flushPara();

  return blocks.length ? blocks : null;
}

const CHANNEL_ICONS = {
  whatsapp: MessageCircle,
  facebook: Facebook,
  instagram: Instagram,
  linkedin: Linkedin,
  youtube: Youtube,
  email: Mail,
  quora: Globe,
};

function ChannelList({ channels, active, onSelect }) {
  return (
    <div className="space-y-1">
      <button
        onClick={() => onSelect(null)}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] font-medium transition-colors
          ${active === null ? 'bg-brand/10 text-brand' : 'text-zinc-600 hover:bg-zinc-50 dark:text-white/70 dark:hover:bg-white/[0.04]'}`}
      >
        <InboxIcon className="h-3.5 w-3.5" />
        All channels
      </button>
      {channels.map((c) => {
        const Icon = CHANNEL_ICONS[c.key] || Globe;
        const isOn = active === c.key;
        return (
          <button
            key={c.key}
            onClick={() => onSelect(c.key)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] font-medium transition-colors
              ${isOn ? 'bg-brand/10 text-brand' : 'text-zinc-600 hover:bg-zinc-50 dark:text-white/70 dark:hover:bg-white/[0.04]'}`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{c.label}</span>
            {c.status === 'configured' ? (
              <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title="Configured" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function LeadRow({ lead, active, onClick, selected, onToggleSelect }) {
  const Icon = CHANNEL_ICONS[lead.source_channel] || Globe;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left text-[12px] transition-colors
        ${active
          ? 'border-brand/50 bg-brand/5'
          : 'border-transparent hover:bg-zinc-50 dark:hover:bg-white/[0.04]'}`}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={!!selected}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleSelect(lead.id, e.target.checked)}
          aria-label={`Select ${lead.contact_name || lead.company_name || 'this lead'}`}
          className="h-3.5 w-3.5 shrink-0 accent-brand"
        />
        <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-white/50" />
        <span className="truncate font-medium text-zinc-900 dark:text-white">
          {lead.contact_name || lead.company_name || 'Unknown'}
        </span>
        {lead.is_inquiry === true ? (
          <span className="ml-auto shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            Inquiry
          </span>
        ) : lead.is_inquiry === false ? (
          <span className="ml-auto shrink-0 rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500">
            Noise
          </span>
        ) : null}
      </div>
      <span className="truncate text-zinc-500 dark:text-white/50">{lead.company_name || lead.email || lead.phone || '—'}</span>
      <span className="text-[10px] text-zinc-400 dark:text-white/30">{new Date(lead.created_at).toLocaleString()}</span>
    </div>
  );
}

function AttachmentChip({ name, mimeType, size, onRemove }) {
  const Icon = (mimeType || '').startsWith('image/') ? ImageIcon : FileText;
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-black/10 bg-black/[0.03] px-2.5 py-1 text-[11px] text-zinc-700 dark:border-white/15 dark:bg-white/[0.06] dark:text-white/80">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="max-w-[140px] truncate">{name}</span>
      {size != null ? <span className="text-zinc-400 dark:text-white/40">{formatBytes(size)}</span> : null}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="ml-0.5 text-zinc-400 hover:text-red-500 dark:text-white/40">
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

function Thread({ lead, onClose }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState([]); // File[]
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // WhatsApp never sends free text here - Meta requires every business-
  // initiated WhatsApp message to use a template Meta has already
  // approved (see channels.js's publishWhatsApp comment), so a WhatsApp
  // lead gets a template picker instead of the rich-text composer below.
  const isWhatsApp = lead.source_channel === 'whatsapp';
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesErr, setTemplatesErr] = useState('');
  // Set only when the fetch succeeded but came back with zero APPROVED
  // templates - server.js's diagnostics tell us why (no templates cached
  // for this channel_id at all vs. templates cached but none APPROVED
  // yet), instead of the old one-size-fits-all "sync/approve one" hint
  // that was equally shown whether or not that was actually the problem.
  const [templatesDiag, setTemplatesDiag] = useState(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState('');
  const [templateParams, setTemplateParams] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr('');
    api
      .leadMessages(lead.id)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : 'Failed to load messages');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  useEffect(() => {
    setSelectedTemplateName('');
    setTemplateParams([]);
    if (!isWhatsApp) {
      setTemplates([]);
      return;
    }
    if (!lead.product_id) {
      setTemplatesErr('This lead is not associated with a Product, so no WhatsApp channel credentials exist for it.');
      return;
    }
    let cancelled = false;
    setTemplatesLoading(true);
    setTemplatesErr('');
    setTemplatesDiag(null);
    api
      .whatsappTemplates(lead.product_id)
      .then((result) => {
        if (cancelled) return;
        // GET /channels/whatsapp/templates returns { templates, diagnostics }
        // - fall back to treating a bare array as the template list, in
        // case an older cached frontend bundle is talking to this API.
        const rows = Array.isArray(result) ? result : result.templates || [];
        setTemplates(rows);
        if (!Array.isArray(result) && rows.length === 0) setTemplatesDiag(result.diagnostics || null);
      })
      .catch((e) => {
        if (!cancelled) setTemplatesErr(e instanceof ApiError ? e.message : 'Failed to load WhatsApp templates');
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id, lead.product_id, isWhatsApp]);

  const selectedTemplate = templates.find((t) => t.name === selectedTemplateName) || null;

  const selectTemplate = (name) => {
    setSelectedTemplateName(name);
    const t = templates.find((tpl) => tpl.name === name);
    setTemplateParams(t ? Array(t.paramCount).fill('') : []);
  };

  const setTemplateParam = (idx, value) => {
    setTemplateParams((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  // Fills {{1}}, {{2}}, ... in the template's approved body text with
  // whatever's been typed so far, so the composer shows exactly what the
  // lead will receive - real WhatsApp template rendering, not a
  // reconstruction of it.
  const templatePreview = selectedTemplate
    ? selectedTemplate.bodyText.replace(/\{\{(\d+)\}\}/g, (m, n) => {
        const v = templateParams[Number(n) - 1];
        return v && v.trim() ? v : m;
      })
    : '';

  // Wraps the current textarea selection in the given markers (or inserts
  // an empty pair at the cursor when nothing's selected) - the same plain
  // tokens the API's reply-formatting.js parses, so what's typed here is
  // exactly what ends up formatted in the sent email.
  const wrapSelection = (before, after = before) => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart, selectionEnd, value } = el;
    const selected = value.slice(selectionStart, selectionEnd);
    const next = value.slice(0, selectionStart) + before + selected + after + value.slice(selectionEnd);
    setReply(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = selectionStart + before.length + selected.length + (selected ? after.length : 0);
      el.setSelectionRange(cursor, cursor);
    });
  };

  // Toggles "- " on every non-blank line the selection touches (or just
  // the current line, if nothing's selected) - un-bullets instead if every
  // touched line already has one.
  const toggleBullets = () => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart, selectionEnd, value } = el;
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineEndIdx = value.indexOf('\n', selectionEnd);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split('\n');
    const allBulleted = lines.every((l) => /^\s*-\s/.test(l) || l.trim() === '');
    const nextLines = lines.map((l) => {
      if (l.trim() === '') return l;
      return allBulleted ? l.replace(/^\s*-\s+/, '') : `- ${l}`;
    });
    const nextBlock = nextLines.join('\n');
    const next = value.slice(0, lineStart) + nextBlock + value.slice(lineEnd);
    setReply(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(lineStart, lineStart + nextBlock.length);
    });
  };

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    setErr('');
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setErr(`Up to ${MAX_ATTACHMENTS} attachments per reply.`);
      return;
    }
    const accepted = [];
    for (const f of incoming.slice(0, room)) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setErr(`"${f.name}" is over ${formatBytes(MAX_ATTACHMENT_BYTES)} - not attached.`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
    if (incoming.length > room) setErr(`Up to ${MAX_ATTACHMENTS} attachments per reply - only the first ${room} were added.`);
  };

  const removeAttachment = (idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx));

  const send = async () => {
    if (!reply.trim()) return;
    setSending(true);
    setErr('');
    try {
      const sent = await api.replyToLead(lead.id, reply.trim(), undefined, attachments);
      setMessages((prev) => [...prev, sent]);
      setReply('');
      setAttachments([]);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reply failed to send');
    } finally {
      setSending(false);
    }
  };

  const sendTemplate = async () => {
    if (!selectedTemplate || !templatePreview.trim()) return;
    setSending(true);
    setErr('');
    try {
      const sent = await api.replyToLead(lead.id, templatePreview, undefined, undefined, {
        name: selectedTemplate.name,
        params: templateParams
      });
      setMessages((prev) => [...prev, sent]);
      setSelectedTemplateName('');
      setTemplateParams([]);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reply failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col rounded-[12px] border border-black/5 bg-white dark:border-white/[0.08] dark:bg-[#121214]">
      <div className="flex items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/[0.08]">
        <div>
          <p className="text-[13px] font-semibold text-zinc-900 dark:text-white">
            {lead.contact_name || lead.company_name || 'Unknown'}
          </p>
          <p className="text-[11px] text-zinc-500 dark:text-white/50">
            {lead.source_channel} · {lead.phone || lead.email || 'no contact info on file'}
          </p>
        </div>
        <button onClick={onClose} className="text-[11px] text-zinc-500 hover:text-zinc-900 dark:text-white/50 dark:hover:text-white">
          Close
        </button>
      </div>

      <div className="flex-1 min-w-0 space-y-2 overflow-x-hidden overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="text-[12px] text-zinc-500 dark:text-white/50">Loading…</p>
        ) : messages.length ? (
          messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] min-w-0 overflow-hidden rounded-[10px] px-3 py-2 text-[12px] ${
                m.direction === 'outbound'
                  ? 'ml-auto bg-brand/10 text-zinc-900 dark:text-white'
                  : 'bg-zinc-50 text-zinc-900 dark:bg-white/[0.04] dark:text-white'
              }`}
            >
              {/* break-words (overflow-wrap: break-word) matters here specifically -
                  an email-sourced message can contain a long unbroken run of
                  characters (a tracking URL, an un-spaced run left over from a
                  template) that whitespace-pre-wrap alone won't wrap, and would
                  otherwise push past this bubble's max-width. Formatting (bold/
                  italic/underline/bullets) is rendered as real elements via
                  renderFormattedBody - never dangerouslySetInnerHTML, so this
                  stays safe even for an inbound message whose text happens to
                  contain the same markers. */}
              <div className="break-words leading-snug">{renderFormattedBody(m.body)}</div>
              {m.attachments && m.attachments.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.attachments.map((a, i) => (
                    <AttachmentChip key={i} name={a.name} mimeType={a.mimeType} size={a.size} />
                  ))}
                </div>
              ) : null}
              <p className="mt-1 text-[10px] text-zinc-400 dark:text-white/30">
                {m.direction === 'outbound' ? `You${m.sent_by_email ? ` (${m.sent_by_email})` : ''}` : 'Them'} ·{' '}
                {new Date(m.created_at).toLocaleString()}
              </p>
              {/* Outbound rows without a real send (channel not configured,
                  lead missing an email/phone, or the send itself failed)
                  used to render identically to a delivered reply - this
                  makes the difference visible instead of a silent failure.
                  Rows from before this was tracked have no send_status at
                  all, so only warn when we actually know it wasn't sent. */}
              {m.direction === 'outbound' && m.send_status && m.send_status !== 'sent' ? (
                <p className="mt-1 text-[10px] text-amber-500" title={m.send_error || ''}>
                  Not delivered{m.send_error ? `: ${m.send_error}` : ''}
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <p className="text-[12px] text-zinc-500 dark:text-white/50">No messages on this lead yet.</p>
        )}
      </div>

      {err ? <p className="px-4 text-[12px] text-red-500">{err}</p> : null}

      <div className="border-t border-black/5 p-3 dark:border-white/[0.08]">
        {isWhatsApp ? (
          <div>
            {/* Meta requires every business-initiated WhatsApp message to
                use a template it has already approved - free text (like
                the rich composer below) isn't a valid thing to send here,
                so this is a template picker instead: choose one, fill in
                its {{1}}, {{2}}, ... values, see exactly what will be
                sent, then send. */}
            {templatesLoading ? (
              <p className="text-[12px] text-zinc-500 dark:text-white/50">Loading approved templates…</p>
            ) : templatesErr ? (
              <p className="text-[12px] text-red-500">{templatesErr}</p>
            ) : templates.length === 0 ? (
              <div className="text-[12px] text-zinc-500 dark:text-white/50">
                {templatesDiag && templatesDiag.totalCached === 0 ? (
                  <p>
                    Vobiz has no templates cached for this channel at all (Channel ID{' '}
                    <code className="text-[11px]">{templatesDiag.channelId}</code>). Your approved templates
                    likely belong to a different channel in Vobiz - open Vobiz &gt; Messaging &gt; Templates,
                    open one of them, and check which Channel it's attached to, then match that Channel ID
                    here (Studio &gt; Channels &gt; WhatsApp).
                    {templatesDiag.synced === false ? ' (Also: the last sync-from-Meta call to Vobiz failed - see server logs.)' : ''}
                  </p>
                ) : templatesDiag && templatesDiag.totalCached > 0 ? (
                  <p>
                    Vobiz has {templatesDiag.totalCached} template(s) cached for this channel, but none are
                    APPROVED yet ({Object.entries(templatesDiag.statusCounts).map(([status, count]) => `${count} ${status}`).join(', ')}).
                    Approve one in Meta Business Manager, then refresh this thread.
                  </p>
                ) : (
                  <p>No approved WhatsApp templates yet. Sync/approve one in Vobiz (Messaging &gt; Templates), then refresh this thread.</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <select
                  value={selectedTemplateName}
                  onChange={(e) => selectTemplate(e.target.value)}
                  aria-label="Approved WhatsApp template"
                  className="w-full rounded-[10px] border border-black/10 bg-transparent px-3 py-2 text-[12px] text-zinc-900 outline-none focus:border-brand dark:border-white/15 dark:text-white"
                >
                  <option value="" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                    Choose an approved template…
                  </option>
                  {templates.map((t) => (
                    <option key={t.name} value={t.name} style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                      {t.name} ({t.language})
                    </option>
                  ))}
                </select>

                {selectedTemplate ? (
                  <>
                    {templateParams.map((val, i) => (
                      <input
                        key={i}
                        value={val}
                        onChange={(e) => setTemplateParam(i, e.target.value)}
                        placeholder={`Value for {{${i + 1}}}`}
                        className="w-full rounded-[10px] border border-black/10 bg-transparent px-3 py-2 text-[12px] text-zinc-900 outline-none focus:border-brand dark:border-white/15 dark:text-white"
                      />
                    ))}
                    <div className="rounded-[10px] border border-dashed border-black/10 bg-black/[0.02] px-3 py-2 text-[12px] leading-snug text-zinc-700 dark:border-white/15 dark:bg-white/[0.03] dark:text-white/80">
                      {templatePreview}
                    </div>
                  </>
                ) : null}

                <div className="flex justify-end">
                  <button
                    onClick={sendTemplate}
                    disabled={sending || !selectedTemplate || !templatePreview.trim()}
                    className="flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {sending ? 'Sending…' : 'Send template'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
        {attachments.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((f, i) => (
              <AttachmentChip key={i} name={f.name} mimeType={f.type} size={f.size} onRemove={() => removeAttachment(i)} />
            ))}
          </div>
        ) : null}

        <div className="mb-1.5 flex items-center gap-1">
          <button type="button" onClick={() => wrapSelection('**')} title="Bold" aria-label="Bold" className="rounded p-1.5 text-zinc-500 hover:bg-black/5 hover:text-zinc-900 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white">
            <Bold className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => wrapSelection('*')} title="Italic" aria-label="Italic" className="rounded p-1.5 text-zinc-500 hover:bg-black/5 hover:text-zinc-900 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white">
            <Italic className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => wrapSelection('__')} title="Underline" aria-label="Underline" className="rounded p-1.5 text-zinc-500 hover:bg-black/5 hover:text-zinc-900 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white">
            <Underline className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={toggleBullets} title="Bullet list" aria-label="Bullet list" className="rounded p-1.5 text-zinc-500 hover:bg-black/5 hover:text-zinc-900 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white">
            <List className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            title="Attach image or PDF"
            aria-label="Attach image or PDF"
            className="rounded p-1.5 text-zinc-500 hover:bg-black/5 hover:text-zinc-900 disabled:opacity-40 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              // Enter alone makes a new line, like any normal email/chat
              // composer once it's multi-line; Ctrl/Cmd+Enter or
              // Shift+Enter sends.
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
              if (files.length) addFiles(files);
            }}
            rows={3}
            placeholder={`Reply via ${lead.source_channel || 'the lead\u2019s channel'}\u2026 (**bold**, *italic*, __underline__, "- " for bullets)`}
            className="flex-1 resize-y rounded-[10px] border border-black/10 bg-transparent px-3.5 py-2 text-[12px] leading-normal text-zinc-900 outline-none focus:border-brand dark:border-white/15 dark:text-white"
          />
          <button
            onClick={send}
            disabled={sending || !reply.trim()}
            aria-label="Send reply (Ctrl/Cmd+Enter)"
            className="flex h-8 w-8 shrink-0 items-center justify-center self-end rounded-full bg-brand text-white disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

// Shared by Inbox and Leads - they differ only in default filtering
// (inquiryOnly) and copy. Left column: this product's channels (click one
// to narrow, "All channels" to clear - matches the "select channel,
// initially all selected" behavior asked for). Right column: the matching
// leads, each opening into its real message thread with a working reply
// box (GET/POST /leads/:id/messages, /leads/:id/reply).
export default function MessagesPanel({ productId, channelStatuses, inquiryOnly, title, subtitle }) {
  const [activeChannel, setActiveChannel] = useState(null);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [selectedLead, setSelectedLead] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState('');

  const toggleSelect = (id, checked) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // Real delete - removes the DB rows AND, for any selected lead that
  // came in over email/IMAP, the source message from the actual mailbox
  // too (see server.js's POST /leads/delete-selected). Irreversible, so
  // confirm() first, same pattern overlay.html already uses for its own
  // destructive actions (disabling a user, rotating the webhook secret).
  const deleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    const label = ids.length === 1 ? 'this email' : `these ${ids.length} emails`;
    if (!confirm(`Delete ${label}? This removes it from Octave and, for emails received here, deletes the message from the mailbox too. This can't be undone.`)) return;

    setDeleting(true);
    setDeleteErr('');
    try {
      const result = await api.deleteLeads(ids);
      const deletedSet = new Set(result.deleted || []);
      setLeads((prev) => prev.filter((l) => !deletedSet.has(l.id)));
      setSelectedIds(new Set());
      if (selectedLead && deletedSet.has(selectedLead.id)) setSelectedLead(null);
      if (result.failed && result.failed.length) {
        setDeleteErr(`${result.failed.length} of ${ids.length} could not be deleted (still referenced elsewhere).`);
      } else {
        const mailboxFailures = Object.values(result.mailbox || {}).filter((m) => m && !m.skipped && !m.ok);
        if (mailboxFailures.length) {
          setDeleteErr('Deleted here, but the mailbox message could not be removed for one or more emails (it may still appear in the mailbox).');
        }
      }
    } catch (e) {
      setDeleteErr(e instanceof ApiError ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!productId) {
      setLeads([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr('');
    api
      .leads({ product_id: productId, channel: activeChannel, inquiry_only: inquiryOnly })
      .then((rows) => {
        if (!cancelled) setLeads(rows);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : 'Failed to load messages');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId, activeChannel, inquiryOnly]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [productId, activeChannel, inquiryOnly]);

  if (!productId) {
    return (
      <div className="rounded-[12px] border border-black/5 bg-white p-6 text-center text-[13px] text-zinc-500 dark:border-white/[0.08] dark:bg-[#121214] dark:text-white/50">
        Select a product above to see its {title.toLowerCase()}.
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[180px_1fr]">
      <aside className="rounded-[12px] border border-black/5 bg-white p-2 dark:border-white/[0.08] dark:bg-[#121214]">
        <ChannelList channels={channelStatuses} active={activeChannel} onSelect={setActiveChannel} />
      </aside>

      <div className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
        <section className="rounded-[12px] border border-black/5 bg-white p-3 dark:border-white/[0.08] dark:bg-[#121214]">
          <div className="mb-2 flex items-start justify-between gap-2 px-1">
            <div>
              <h2 className="text-[13px] font-semibold text-zinc-900 dark:text-white">{title}</h2>
              {subtitle ? <p className="text-[11px] text-zinc-500 dark:text-white/50">{subtitle}</p> : null}
            </div>
            {selectedIds.size > 0 ? (
              <button
                type="button"
                onClick={deleteSelected}
                disabled={deleting}
                className="flex shrink-0 items-center gap-1 rounded-full border border-red-500/30 px-2.5 py-1 text-[11px] font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                {deleting ? 'Deleting…' : `Delete (${selectedIds.size})`}
              </button>
            ) : null}
          </div>
          {deleteErr ? <p className="mb-2 px-1 text-[11px] text-red-500">{deleteErr}</p> : null}
          {loading ? (
            <p className="px-1 text-[12px] text-zinc-500 dark:text-white/50">Loading…</p>
          ) : err ? (
            <p className="px-1 text-[12px] text-red-500">{err}</p>
          ) : leads.length ? (
            <div className="max-h-[520px] space-y-1 overflow-y-auto pr-1">
              {leads.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  active={selectedLead && selectedLead.id === lead.id}
                  onClick={() => setSelectedLead(lead)}
                  selected={selectedIds.has(lead.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          ) : (
            <p className="px-1 py-6 text-center text-[12px] text-zinc-500 dark:text-white/50">Nothing here yet.</p>
          )}
        </section>

        <section className="min-h-[300px]">
          {selectedLead ? (
            <Thread lead={selectedLead} onClose={() => setSelectedLead(null)} />
          ) : (
            <div className="flex h-full min-h-[300px] items-center justify-center rounded-[12px] border border-dashed border-black/10 text-[12px] text-zinc-400 dark:border-white/15 dark:text-white/30">
              Select a message to open its thread
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
