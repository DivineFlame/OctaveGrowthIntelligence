// Real channel publishing integrations. Each channel's config is stored in
// product_channels.config (JSONB) with its secret fields encrypted at rest
// via encryptSecret/decryptSecret (same AES-256-GCM helper server.js
// already uses for llm_connections.api_key_encrypted - passed in here
// rather than re-implemented, so there's one key and one algorithm for
// every secret this app stores).
//
// Status, honestly:
//   - email, whatsapp, facebook, linkedin: real API calls against the
//     provider's real, documented endpoint. They will work once you supply
//     real credentials (see each CHANNEL_SPECS entry for exactly what's
//     needed and how to get it).
//   - instagram: also real, but the Instagram Graph API requires the image
//     to already be reachable at a public URL - it does not accept direct
//     file upload the way Facebook's /photos endpoint does. This app now
//     exposes GET /public/content-assets/:assetId/file (unauthenticated,
//     relying on the asset's UUID being unguessable) specifically so
//     Instagram has something to fetch; see publishInstagram() below for
//     the exact requirement (API_DOMAIN or APP_DOMAIN must be a real,
//     internet-reachable domain, not localhost).
//   - youtube: real, using the YouTube Data API v3's resumable upload
//     protocol - initiate a session, then PUT the video bytes to the URL
//     it hands back. Needs a Google OAuth refresh_token (not a short-lived
//     access token - see publishYouTube() and CHANNEL_SPECS.youtube.help),
//     obtained once via Google's OAuth consent flow for the channel-owning
//     account, outside this app.
//   - quora: NOT implemented, and can't be - as of this writing, Quora has
//     no public API for posting content at all. This channel stays a
//     manual/placeholder entry permanently, not a gap to eventually fill.

const fs = require('fs');

const CHANNEL_SPECS = {
  email: {
    label: 'Email',
    implemented: true,
    fields: [
      { key: 'smtp_host', label: 'SMTP host', required: true },
      { key: 'smtp_port', label: 'SMTP port', required: true, default: '587' },
      { key: 'smtp_secure', label: 'Use TLS', type: 'boolean', required: false, default: 'false' },
      { key: 'smtp_user', label: 'SMTP username', required: true },
      { key: 'smtp_pass', label: 'SMTP password', required: true, secret: true },
      { key: 'from_email', label: 'From address', required: true },
      { key: 'to_default', label: 'Default recipient (optional, or pass one per-publish)', required: false },
      // Inbound - optional. Leaving these blank keeps the channel
      // send-only (SMTP above); setting imap_host/imap_user/imap_pass
      // turns on real IMAP polling (see email-poller.js) that turns new
      // messages in this mailbox into leads, same as any other channel's
      // webhook. Deliberately not required, since plenty of setups only
      // ever need to send.
      { key: 'imap_host', label: 'IMAP host (leave blank to skip inbound fetching)', required: false },
      { key: 'imap_port', label: 'IMAP port', required: false, default: '993' },
      { key: 'imap_secure', label: 'Use TLS', type: 'boolean', required: false, default: 'true' },
      { key: 'imap_user', label: 'IMAP username (often the same as SMTP username)', required: false },
      { key: 'imap_pass', label: 'IMAP password (often the same as SMTP password, or an app password)', required: false, secret: true },
      { key: 'imap_mailbox', label: 'Mailbox to poll (default INBOX)', required: false, default: 'INBOX' }
    ],
    help: 'Any SMTP-speaking provider works for sending (SendGrid, SES, Mailgun, Postmark, Gmail with an app password, your own mail server) - this uses plain SMTP, not a vendor-specific REST API. To also turn replies into leads, fill in the IMAP fields too - use a dedicated mailbox for this if you can, since IMAP\'s "unread" flag is shared with whatever else reads that inbox (your own mail client marking a message read makes it invisible to the poller).'
  },
  whatsapp: {
    label: 'WhatsApp Business (via Vobiz)',
    implemented: true,
    fields: [
      { key: 'auth_id', label: 'Vobiz Auth ID (e.g. MA_XXXXXXXX)', required: true },
      { key: 'auth_token', label: 'Vobiz Auth Token', required: true, secret: true },
      { key: 'channel_id', label: 'Vobiz WhatsApp Channel ID', required: true },
      { key: 'waba_id', label: 'WhatsApp Business Account ID (WABA ID)', required: true },
      { key: 'default_recipient', label: "Default recipient (E.164, e.g. +919876543210)", required: false },
      // Lead replies (POST /leads/:id/reply) always pick their own
      // template per-message via the Inbox composer - see
      // GET /channels/whatsapp/templates. Studio's content pipeline has
      // no per-post template picker, so it needs one template configured
      // once here instead: get a single-variable template like
      // "{{1}}" approved in Vobiz specifically for broadcasting your own
      // generated copy through, and set its name/language below. Every
      // WhatsApp send this app makes - lead reply or Studio broadcast -
      // goes through an approved template; there is no free-text path.
      { key: 'broadcast_template_name', label: 'Broadcast template name (for Studio > Content publishing - a generic single-variable template)', required: false },
      { key: 'broadcast_template_language', label: 'Broadcast template language code', required: false, default: 'en_US' }
    ],
    help: 'From the Vobiz Console (console.vobiz.ai): Auth ID and Auth Token are under Settings > API. Channel ID is under Channels > WhatsApp (create one there if you haven\'t already). WABA ID comes from Meta\'s WhatsApp Manager (business.facebook.com > WhatsApp Accounts > Settings > Business Info) or is shown alongside the channel in Vobiz. Meta requires every business-initiated WhatsApp message to use an approved template - this app never sends free text. Lead replies pick a template per-message in the Inbox; Studio > Content publishing instead uses the single broadcast_template_name/language configured here (get a generic single-variable template like "{{1}}" approved for this purpose in Vobiz, then set its name here) - your generated post text becomes that template\'s one parameter. Sync/check template approval status in Vobiz under Channels > WhatsApp > Templates.'
  },
  facebook: {
    label: 'Facebook Page',
    implemented: true,
    fields: [
      { key: 'page_id', label: 'Page ID', required: true },
      { key: 'access_token', label: 'Page access token', required: true, secret: true }
    ],
    help: 'From a Meta Developer App (developers.facebook.com) - needs the pages_manage_posts permission on the target Page, which requires Meta App Review for anything beyond your own test Pages.'
  },
  instagram: {
    label: 'Instagram Business',
    implemented: true,
    fields: [
      { key: 'ig_user_id', label: 'Instagram Business Account ID', required: true },
      { key: 'access_token', label: 'Access token', required: true, secret: true }
    ],
    help: 'Same Meta Developer App as Facebook, with instagram_content_publish permission. Requires the asset to be reachable at a public URL - see publishInstagram() - so APP_DOMAIN/API_DOMAIN must be a real public domain, not localhost.'
  },
  linkedin: {
    label: 'LinkedIn Organization',
    implemented: true,
    fields: [
      { key: 'organization_urn', label: 'Organization URN (e.g. urn:li:organization:12345)', required: true },
      { key: 'access_token', label: 'OAuth access token', required: true, secret: true }
    ],
    help: 'From a LinkedIn Developer App with the Community Management API product added and w_organization_social scope. LinkedIn gates organization-posting access behind an application/review process - this is real, correct API usage against their UGC Posts endpoint, but LinkedIn itself is the approval bottleneck, not this code.'
  },
  youtube: {
    label: 'YouTube',
    implemented: true,
    fields: [
      { key: 'client_id', label: 'Google OAuth Client ID', required: true },
      { key: 'client_secret', label: 'Google OAuth Client Secret', required: true, secret: true },
      { key: 'refresh_token', label: 'OAuth refresh token (see help)', required: true, secret: true },
      { key: 'privacy_status', label: 'Privacy status (public/unlisted/private)', required: false, default: 'unlisted' },
      { key: 'category_id', label: 'YouTube category ID (optional, default 22 = People & Blogs)', required: false, default: '22' }
    ],
    help: 'Uses the YouTube Data API v3 resumable upload protocol. Create an OAuth 2.0 Client ID in Google Cloud Console (Desktop app type is simplest) with the YouTube Data API v3 enabled, then run Google\'s OAuth consent flow once (with offline access) for the channel-owning Google account to get a refresh_token - store that here, not a short-lived access token, since access tokens expire in about an hour and this app refreshes one automatically on every publish. Only accepts video files; publishing a non-video asset to this channel fails with a clear error before any API call is made.'
  },
  quora: {
    label: 'Quora',
    implemented: false,
    fields: [],
    help: 'Cannot be implemented - Quora has no public API for posting content. This channel is permanently manual/placeholder.'
  }
};

function validateChannelConfig(channel, config) {
  const spec = CHANNEL_SPECS[channel];
  if (!spec) throw new Error(`Unknown channel: ${channel}`);
  if (!spec.implemented) return; // nothing to validate for a channel with no fields
  const missing = spec.fields.filter(f => f.required && !String((config || {})[f.key] || '').trim()).map(f => f.key);
  if (missing.length) throw new Error(`${spec.label}: missing required field(s): ${missing.join(', ')}`);
}

// Encrypts every field flagged `secret` in a channel's spec, in place on a
// shallow copy - called right before a channel config is persisted.
function encryptChannelSecrets(channel, config, encryptSecret) {
  const spec = CHANNEL_SPECS[channel];
  const out = Object.assign({}, config || {});
  if (!spec) return out;
  for (const f of spec.fields) {
    if (f.secret && out[f.key]) out[f.key] = encryptSecret(String(out[f.key]));
  }
  return out;
}

// Masks every `secret` field before a channel config is ever returned to
// the frontend - the decrypted value only ever exists in memory inside
// publishToChannel(), never in an API response.
function maskChannelSecrets(channel, config) {
  const spec = CHANNEL_SPECS[channel];
  const out = Object.assign({}, config || {});
  if (!spec) return out;
  for (const f of spec.fields) {
    if (f.secret && out[f.key]) out[f.key] = '••••••••';
  }
  return out;
}

function decryptChannelSecrets(channel, config, decryptSecret) {
  const spec = CHANNEL_SPECS[channel];
  const out = Object.assign({}, config || {});
  if (!spec) return out;
  for (const f of spec.fields) {
    if (f.secret && out[f.key]) out[f.key] = decryptSecret(out[f.key]);
  }
  return out;
}

async function publishEmail({ config, title, text, html, filePath, fileName, mimeType, attachments: extraAttachments, to, inReplyTo, references }, deps = {}) {
  // Lazily required so the dependency is only ever loaded by a product that
  // actually configures an email channel.
  const nodemailer = deps.nodemailer || require('nodemailer');
  const recipient = to || config.to_default;
  if (!recipient) throw new Error('No recipient: pass one when publishing, or set a default_recipient/to_default on the channel config');

  // Case-sensitive `=== 'true'` here used to silently treat a config saved
  // as "TRUE" (the field's own label reads "Use TLS (true/false)", with no
  // hint that case matters, and that's exactly what got typed and saved)
  // as false - so a port-465 (implicit TLS) account would get a plaintext
  // connection attempt, which the server would never respond to with a
  // valid SMTP greeting before timing out ("Greeting never received").
  // Normalize case/whitespace so "TRUE"/"True"/" true " all mean the same
  // thing as "true".
  const smtpSecure = String(config.smtp_secure || '').trim().toLowerCase() === 'true';

  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: parseInt(config.smtp_port, 10) || 587,
    secure: smtpSecure,
    auth: { user: config.smtp_user, pass: config.smtp_pass }
  });

  const attachments = [];
  if (filePath && fs.existsSync(filePath)) {
    attachments.push({ filename: fileName || 'attachment', path: filePath, contentType: mimeType || undefined });
  }
  // Lead replies (POST /leads/:id/reply) can carry several image/PDF
  // attachments at once, unlike the single content-asset file this
  // function originally only ever sent - kept as a separate param rather
  // than overloading filePath so both call sites stay simple.
  for (const a of (extraAttachments || [])) {
    if (a && a.filePath && fs.existsSync(a.filePath)) {
      attachments.push({ filename: a.fileName || 'attachment', path: a.filePath, contentType: a.mimeType || undefined });
    }
  }

  const info = await transporter.sendMail({
    from: config.from_email,
    to: recipient,
    subject: title || 'New content from OrgComms',
    text: text || title || '',
    // html is optional (only the reply composer's formatting toolbar
    // produces it - see reply-formatting.js) - nodemailer sends a
    // multipart message with both when it's present, and mail clients
    // that can't render HTML fall back to the plain-text part above.
    html: html || undefined,
    // Threads a lead reply into the same email conversation the lead's
    // own message started, instead of it landing as a brand-new one in
    // their inbox - see migrate-lead-email-threading.sql and
    // POST /leads/:id/reply's comment on how this chain is built. Both
    // are undefined (nodemailer omits the header entirely) for the first
    // message in a conversation, or any send that isn't a lead reply.
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
    attachments
  });

  return { externalId: info.messageId, externalUrl: null };
}

const VOBIZ_API_BASE = 'https://api.vobiz.ai/api/v1';

function vobizHeaders(config) {
  return {
    'X-Auth-ID': config.auth_id,
    'X-Auth-Token': config.auth_token,
    'Content-Type': 'application/json'
  };
}

// Vobiz's error responses aren't consistently shaped - sometimes
// { message: "..." }, sometimes { error: "..." }, and sometimes
// { error: { message, code } } or { errors: [...] } (an object/array
// where a plain string was assumed used to produce a useless
// "Error: [object Object]" once thrown, with the real reason lost).
// Digs through every shape actually seen and falls back to the raw
// response body (or just the HTTP status) rather than ever losing the
// underlying reason.
function vobizErrorMessage(data, status, fallbackLabel) {
  const fallback = `Vobiz API error ${fallbackLabel} (HTTP ${status})`;
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.message === 'string' && data.message) return data.message;
  if (typeof data.error === 'string' && data.error) return data.error;
  if (data.error && typeof data.error === 'object') {
    if (typeof data.error.message === 'string' && data.error.message) return data.error.message;
    try { return JSON.stringify(data.error); } catch (e) { /* fall through to below */ }
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    return data.errors.map((e) => (e && (e.message || e.detail)) || JSON.stringify(e)).join('; ');
  }
  try {
    const raw = JSON.stringify(data);
    return raw && raw !== '{}' ? `${fallback}: ${raw}` : fallback;
  } catch (e) {
    return fallback;
  }
}

// Lists this channel's WhatsApp templates from Vobiz, filtered down to
// only the ones Meta has actually APPROVED - a PENDING_REVIEW, REJECTED,
// DISABLED or PAUSED template is never a valid thing to send (Meta
// rejects it outright), so callers never need to re-filter this
// themselves. Backs GET /channels/whatsapp/templates (server.js, for the
// Inbox reply composer's template picker) and POST /leads/:id/reply's own
// server-side check that a reply's chosen template is really approved,
// not just whatever name a client happened to send.
//
// Each template's body text is also parsed for its "{{1}}", "{{2}}", ...
// placeholders (paramCount = how many distinct ones it uses) so the
// caller knows how many values it needs to collect before sending,
// without having to parse Vobiz's raw components shape itself.
async function listWhatsAppTemplates(config) {
  if (!config.channel_id) throw new Error('WhatsApp channel is missing its Vobiz Channel ID');
  // Every other Vobiz call in this file (publishWhatsApp's /messaging/messages,
  // registerWhatsAppWebhook's /messaging/webhooks) sits under the /messaging
  // prefix - this one was missing it (.../v1/channels/{id}/templates instead
  // of .../v1/messaging/channels/{id}/templates), which doesn't match any
  // route on Vobiz's side and got their API gateway's generic "Service not
  // found" back instead of an actual templates response or a real Vobiz
  // error. See https://www.vobiz.ai/docs/whatsapp/api/templates for the
  // documented path.
  const resp = await fetch(`${VOBIZ_API_BASE}/messaging/channels/${config.channel_id}/templates`, {
    headers: vobizHeaders(config)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(vobizErrorMessage(data, resp.status, 'listing templates'));

  const items = data.items || [];
  return items
    .filter((t) => t.status === 'APPROVED')
    .map((t) => {
      const components = (t.components && t.components.components) || [];
      const bodyComponent = components.find((c) => (c.type || '').toUpperCase() === 'BODY');
      const bodyText = (bodyComponent && bodyComponent.text) || '';
      const paramCount = new Set(bodyText.match(/\{\{\d+\}\}/g) || []).size;
      return { name: t.name, language: t.language, category: t.category, bodyText, paramCount };
    });
}

// Registers a webhook subscription with Vobiz so it actually starts
// POSTing inbound WhatsApp events (message.inbound, message.status,
// call.*) to this app - without this, nothing was ever wired up to
// receive them at all, which is the real reason no WhatsApp message
// ever showed up in the Inbox no matter how the channel itself was
// configured (publishWhatsApp only ever covered sending). One-time
// setup per Vobiz account, exposed as POST /channels/whatsapp/
// register-webhook (server.js) so an admin doesn't have to hand-craft
// this API call themselves. `secret` should be the same value used to
// gate every other channel's webhook URL (company.webhook_secret) -
// Vobiz signs its deliveries with it (X-Webhook-Signature, HMAC-SHA256
// of the raw body), reusing it here means there's only one secret to
// manage instead of a second one just for WhatsApp.
async function registerWhatsAppWebhook(config, url, secret) {
  const resp = await fetch(`${VOBIZ_API_BASE}/messaging/webhooks`, {
    method: 'POST',
    headers: vobizHeaders(config),
    body: JSON.stringify({ url, secret })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(vobizErrorMessage(data, resp.status, 'registering webhook'));
  return data;
}

// Sends a WhatsApp message through Vobiz (docs.vobiz.ai/whatsapp/api/send-message).
// Meta requires every business-initiated WhatsApp message to use an
// approved template - free text only works as a reply inside an
// existing 24h customer-service window, which this app has no reliable
// way to track, so this never sends a bare text message. Two ways in:
//   - template: { name, language, parameters } - an explicit, already-
//     chosen template (POST /leads/:id/reply's Inbox composer picks one
//     per message - see GET /channels/whatsapp/templates).
//   - text: a plain string with no template picked for it (the Studio
//     content pipeline's generated post copy, which has no per-post
//     template-picker UI) - wrapped as the single parameter of the
//     channel's configured broadcast_template_name/broadcast_template_language
//     (CHANNEL_SPECS.whatsapp above). Throws a clear, actionable error if
//     that isn't configured, rather than silently sending nothing or
//     falling back to a free-text call Meta would just reject anyway.
async function publishWhatsApp({ config, template, text, to }) {
  const recipient = (to || config.default_recipient || '').replace(/[^\d+]/g, '');
  if (!recipient) throw new Error('No recipient: pass one when publishing, or set a default_recipient on the channel config');
  if (!config.channel_id || !config.waba_id) throw new Error('WhatsApp channel is missing its Vobiz Channel ID / WABA ID - configure it under Studio > Channels');

  let resolvedTemplate = template && template.name ? template : null;
  if (!resolvedTemplate) {
    if (!text) throw new Error('Nothing to send: pass either a template or text');
    if (!config.broadcast_template_name) {
      throw new Error('WhatsApp requires an approved message template for every send - set a "Broadcast template name" on this channel (Studio > Channels > WhatsApp) to publish generated content through WhatsApp.');
    }
    resolvedTemplate = { name: config.broadcast_template_name, language: config.broadcast_template_language || 'en_US', parameters: [text] };
  }

  const body = {
    channel_id: config.channel_id,
    waba_id: config.waba_id,
    to: recipient,
    type: 'template',
    template: {
      name: resolvedTemplate.name,
      language: { code: resolvedTemplate.language || 'en_US' },
      components: (resolvedTemplate.parameters && resolvedTemplate.parameters.length)
        ? [{ type: 'body', parameters: resolvedTemplate.parameters.map((p) => ({ type: 'text', text: String(p) })) }]
        : []
    }
  };

  const resp = await fetch(`${VOBIZ_API_BASE}/messaging/messages`, {
    method: 'POST',
    headers: vobizHeaders(config),
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(vobizErrorMessage(data, resp.status, 'sending message'));
  return { externalId: data.id || null, externalUrl: null };
}

async function publishFacebook({ config, title, text, filePath, mimeType }) {
  const caption = [title, text].filter(Boolean).join('\n\n');

  if (filePath && fs.existsSync(filePath)) {
    const isVideo = (mimeType || '').startsWith('video/');
    const endpoint = isVideo ? 'videos' : 'photos';
    const form = new FormData();
    form.append('access_token', config.access_token);
    form.append(isVideo ? 'description' : 'caption', caption);
    form.append(isVideo ? 'source' : 'source', new Blob([fs.readFileSync(filePath)], { type: mimeType || 'application/octet-stream' }), 'upload');
    const resp = await fetch(`https://graph.facebook.com/v20.0/${config.page_id}/${endpoint}`, { method: 'POST', body: form });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `Facebook API error (HTTP ${resp.status})`);
    const id = data.post_id || data.id;
    return { externalId: id, externalUrl: id ? `https://www.facebook.com/${id}` : null };
  }

  const resp = await fetch(`https://graph.facebook.com/v20.0/${config.page_id}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: caption, access_token: config.access_token })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || `Facebook API error (HTTP ${resp.status})`);
  return { externalId: data.id, externalUrl: data.id ? `https://www.facebook.com/${data.id}` : null };
}

// Requires a public URL for the image (publicFileUrl, built by the caller
// from GET /public/content-assets/:assetId/file) - the Instagram Graph API
// has no direct-upload option, unlike Facebook's /photos endpoint.
async function publishInstagram({ config, title, text, publicFileUrl }) {
  if (!publicFileUrl) throw new Error('Instagram requires a public image URL - set APP_DOMAIN or API_DOMAIN to a real, internet-reachable domain (not localhost) so the asset can be fetched by Instagram');
  const caption = [title, text].filter(Boolean).join('\n\n');

  const createResp = await fetch(`https://graph.facebook.com/v20.0/${config.ig_user_id}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: publicFileUrl, caption, access_token: config.access_token })
  });
  const createData = await createResp.json().catch(() => ({}));
  if (!createResp.ok) throw new Error(createData.error?.message || `Instagram media-create error (HTTP ${createResp.status})`);

  const publishResp = await fetch(`https://graph.facebook.com/v20.0/${config.ig_user_id}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: createData.id, access_token: config.access_token })
  });
  const publishData = await publishResp.json().catch(() => ({}));
  if (!publishResp.ok) throw new Error(publishData.error?.message || `Instagram media-publish error (HTTP ${publishResp.status})`);

  return { externalId: publishData.id, externalUrl: null };
}

// YouTube Data API v3's resumable upload: initiate a session (step 1)
// which hands back a one-time upload URL, then PUT the actual video bytes
// to it (step 2). Sent as a single PUT, not chunked - this app already
// caps uploads at 100MB (see server.js's multer config), well within
// what a one-shot PUT to this endpoint supports, so there's no need for
// the chunked/resumable-on-failure complexity the protocol also allows.
async function publishYouTube({ config, title, text, filePath, mimeType }) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('YouTube requires a video file to upload - no file is attached to this content');
  if (!(mimeType || '').startsWith('video/')) throw new Error(`YouTube only accepts video files, got "${mimeType || 'unknown type'}"`);

  // Access tokens expire in ~1 hour, so this app never stores one - only
  // the long-lived refresh_token, redeemed for a fresh access token on
  // every publish (same reasoning as never persisting a short-lived
  // credential when a longer-lived one can fetch it on demand).
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: config.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok) throw new Error(tokenData.error_description || tokenData.error || `YouTube OAuth token refresh failed (HTTP ${tokenResp.status})`);
  const accessToken = tokenData.access_token;

  const fileBuffer = fs.readFileSync(filePath);
  const snippet = { title: (title || 'Untitled').slice(0, 100), description: text || '', categoryId: config.category_id || '22' };
  const status = { privacyStatus: config.privacy_status || 'unlisted' };

  const initResp = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(fileBuffer.length)
    },
    body: JSON.stringify({ snippet, status })
  });
  if (!initResp.ok) {
    const errData = await initResp.json().catch(() => ({}));
    throw new Error(errData.error?.message || `YouTube upload session init failed (HTTP ${initResp.status})`);
  }
  const uploadUrl = initResp.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube did not return a resumable upload URL');

  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(fileBuffer.length) },
    body: fileBuffer
  });
  const uploadData = await uploadResp.json().catch(() => ({}));
  if (!uploadResp.ok) throw new Error(uploadData.error?.message || `YouTube video upload failed (HTTP ${uploadResp.status})`);

  return { externalId: uploadData.id, externalUrl: uploadData.id ? `https://www.youtube.com/watch?v=${uploadData.id}` : null };
}

async function publishLinkedIn({ config, title, text }) {
  const body = {
    author: config.organization_urn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: [title, text].filter(Boolean).join('\n\n') },
        shareMediaCategory: 'NONE'
      }
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
  };
  const resp = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.access_token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify(body)
  });
  const postId = resp.headers.get('x-restli-id');
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.message || `LinkedIn API error (HTTP ${resp.status})`);
  }
  return { externalId: postId, externalUrl: postId ? `https://www.linkedin.com/feed/update/${postId}` : null };
}

// Single dispatch point. `config` must already be decrypted (see
// decryptChannelSecrets). Throws on any failure - callers persist the
// error message onto content_variants.publish_error rather than swallow it.
async function publishToChannel(channel, { config, title, text, html, filePath, fileName, mimeType, attachments, publicFileUrl, to, template, inReplyTo, references }, deps = {}) {
  const spec = CHANNEL_SPECS[channel];
  if (!spec) throw new Error(`Unknown channel: ${channel}`);
  if (!spec.implemented) throw new Error(`${spec.label} publishing is not implemented yet. ${spec.help}`);

  switch (channel) {
    case 'email': return publishEmail({ config, title, text, html, filePath, fileName, mimeType, attachments, to, inReplyTo, references }, deps);
    case 'whatsapp': return publishWhatsApp({ config, template, text: text || title, to });
    case 'facebook': return publishFacebook({ config, title, text, filePath, mimeType });
    case 'instagram': return publishInstagram({ config, title, text, publicFileUrl });
    case 'linkedin': return publishLinkedIn({ config, title, text });
    case 'youtube': return publishYouTube({ config, title, text, filePath, mimeType });
    default: throw new Error(`No publisher wired up for channel: ${channel}`);
  }
}

module.exports = {
  CHANNEL_SPECS,
  validateChannelConfig,
  encryptChannelSecrets,
  maskChannelSecrets,
  decryptChannelSecrets,
  publishToChannel,
  listWhatsAppTemplates,
  registerWhatsAppWebhook
};
