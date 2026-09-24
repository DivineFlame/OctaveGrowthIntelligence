import React, { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { api, ApiError } from '../lib/api.js';

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

function LeadRow({ lead, active, onClick }) {
  const Icon = CHANNEL_ICONS[lead.source_channel] || Globe;
  return (
    <button
      onClick={onClick}
      className={`flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left text-[12px] transition-colors
        ${active
          ? 'border-brand/50 bg-brand/5'
          : 'border-transparent hover:bg-zinc-50 dark:hover:bg-white/[0.04]'}`}
    >
      <div className="flex items-center gap-2">
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
    </button>
  );
}

function Thread({ lead, onClose }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

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

  const send = async () => {
    if (!reply.trim()) return;
    setSending(true);
    setErr('');
    try {
      const sent = await api.replyToLead(lead.id, reply.trim());
      setMessages((prev) => [...prev, sent]);
      setReply('');
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
                  otherwise push past this bubble's max-width. */}
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
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

      <div className="flex items-center gap-2 border-t border-black/5 p-3 dark:border-white/[0.08]">
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Reply via ${lead.source_channel || 'the lead’s channel'}…`}
          className="flex-1 rounded-full border border-black/10 bg-transparent px-3.5 py-2 text-[12px] text-zinc-900 outline-none focus:border-brand dark:border-white/15 dark:text-white"
        />
        <button
          onClick={send}
          disabled={sending || !reply.trim()}
          aria-label="Send reply"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
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
          <div className="mb-2 px-1">
            <h2 className="text-[13px] font-semibold text-zinc-900 dark:text-white">{title}</h2>
            {subtitle ? <p className="text-[11px] text-zinc-500 dark:text-white/50">{subtitle}</p> : null}
          </div>
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
