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
    label: 'WhatsApp Business',
    implemented: true,
    fields: [
      { key: 'phone_number_id', label: 'Phone Number ID', required: true },
      { key: 'access_token', label: 'Permanent access token', required: true, secret: true },
      { key: 'default_recipient', label: "Default recipient (E.164, e.g. +919876543210)", required: false }
    ],
    help: 'From Meta\'s WhatsApp Business Platform (business.facebook.com) - create a WhatsApp Business Account, add a phone number, and generate a permanent access token (not the 24h test token) for it under System Users.'
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

async function publishEmail({ config, title, text, filePath, fileName, mimeType, to }) {
  // Lazily required so the dependency is only ever loaded by a product that
  // actually configures an email channel.
  const nodemailer = require('nodemailer');
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

  const info = await transporter.sendMail({
    from: config.from_email,
    to: recipient,
    subject: title || 'New content from OrgComms',
    text: text || title || '',
    attachments
  });

  return { externalId: info.messageId, externalUrl: null };
}

async function publishWhatsApp({ config, text, to }) {
  const recipient = (to || config.default_recipient || '').replace(/[^\d+]/g, '');
  if (!recipient) throw new Error('No recipient: pass one when publishing, or set a default_recipient on the channel config');

  const resp = await fetch(`https://graph.facebook.com/v20.0/${config.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { body: text || '' }
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || `WhatsApp API error (HTTP ${resp.status})`);
  return { externalId: data.messages?.[0]?.id || null, externalUrl: null };
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
async function publishToChannel(channel, { config, title, text, filePath, fileName, mimeType, publicFileUrl, to }) {
  const spec = CHANNEL_SPECS[channel];
  if (!spec) throw new Error(`Unknown channel: ${channel}`);
  if (!spec.implemented) throw new Error(`${spec.label} publishing is not implemented yet. ${spec.help}`);

  switch (channel) {
    case 'email': return publishEmail({ config, title, text, filePath, fileName, mimeType, to });
    case 'whatsapp': return publishWhatsApp({ config, text: text || title, to });
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
  publishToChannel
};
