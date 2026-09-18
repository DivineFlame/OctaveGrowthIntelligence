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
//   - youtube: NOT implemented. YouTube Data API v3 upload is a resumable,
//     multi-request upload protocol (very different shape from the others
//     here) and needs a Google Cloud OAuth consent screen, not just an API
//     key. Flagged clearly rather than faked.
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
      { key: 'smtp_secure', label: 'Use TLS (true/false)', required: false, default: 'false' },
      { key: 'smtp_user', label: 'SMTP username', required: true },
      { key: 'smtp_pass', label: 'SMTP password', required: true, secret: true },
      { key: 'from_email', label: 'From address', required: true },
      { key: 'to_default', label: 'Default recipient (optional, or pass one per-publish)', required: false }
    ],
    help: 'Any SMTP-speaking provider works (SendGrid, SES, Mailgun, Postmark, Gmail with an app password, your own mail server) - this uses plain SMTP, not a vendor-specific REST API, so switching providers is just changing these fields.'
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
    implemented: false,
    fields: [],
    help: 'Not implemented - YouTube Data API v3 uploads use a resumable multi-request protocol and Google OAuth consent, a meaningfully different integration shape than the others. Configuring this channel saves the row but publishing to it will fail with a clear "not implemented" error until it is built.'
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
  // Lazily required so the dependency is only ever loaded by a tenant that
  // actually configures an email channel.
  const nodemailer = require('nodemailer');
  const recipient = to || config.to_default;
  if (!recipient) throw new Error('No recipient: pass one when publishing, or set a default_recipient/to_default on the channel config');

  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: parseInt(config.smtp_port, 10) || 587,
    secure: String(config.smtp_secure) === 'true',
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
