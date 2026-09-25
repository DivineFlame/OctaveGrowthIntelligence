// Talks to the real OrgComms API using the same session the overlay app
// (overlay.html) manages - reads straight from localStorage on every call
// (not just the one-time window.__ORGCOMMS_COMPANY__/__ORGCOMMS_SESSION__
// snapshot the pre-mount script sets) so a token refresh or logout done by
// the overlay is picked up immediately, mirroring overlay.html's own
// doFetch()/api() helpers exactly (same 401 -> refresh -> retry -> reload
// on failure behavior) so both halves of the page share one session
// lifecycle instead of drifting apart.
const SESSION_KEY = 'orgcomms_session';

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(s) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* best-effort, same as overlay.html */
  }
}

async function doFetch(session, path, opts) {
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers = Object.assign({}, isFormData ? {} : { 'Content-Type': 'application/json' }, opts.headers || {});
  if (session && session.token) headers['Authorization'] = 'Bearer ' + session.token;
  const res = await fetch(session.apiBase.replace(/\/$/, '') + path, {
    method: opts.method || 'GET',
    headers,
    body: isFormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body / not JSON */
  }
  return { res, data };
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function apiCall(path, opts = {}) {
  const session = loadSession();
  if (!session || !session.token) {
    throw new ApiError('Not signed in', 401);
  }

  let first = await doFetch(session, path, opts);

  if (first.res.status === 401 && session.refresh) {
    try {
      const refreshRes = await fetch(session.apiBase.replace(/\/$/, '') + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: session.refresh }),
      });
      const refreshData = await refreshRes.json();
      if (refreshRes.ok && refreshData.token) {
        session.token = refreshData.token;
        saveSession(session);
        first = await doFetch(session, path, opts);
      } else {
        localStorage.removeItem(SESSION_KEY);
        location.reload();
        throw new ApiError('Session expired, please sign in again', 401);
      }
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
      location.reload();
      throw e;
    }
  }

  if (!first.res.ok) {
    throw new ApiError((first.data && first.data.error) || `Request failed: ${first.res.status}`, first.res.status);
  }
  return first.data;
}

export function currentCompany() {
  const session = loadSession();
  return (session && session.company) || null;
}

export function currentUser() {
  const session = loadSession();
  return session || null;
}

// --- Typed endpoint helpers -------------------------------------------

export const api = {
  company: () => apiCall('/company'),
  products: () => apiCall('/products'),
  productContent: (productId) => apiCall(`/products/${productId}/content`),
  channelSpec: () => apiCall('/channels/spec'),
  productChannels: (productId) => apiCall(`/products/${productId}/channels`),

  // params: { product_id, channel, inquiry_only } - all optional, dropped
  // when falsy so a plain api.leads() still hits GET /leads unfiltered.
  leads: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.product_id) qs.set('product_id', params.product_id);
    if (params.channel) qs.set('channel', params.channel);
    if (params.inquiry_only) qs.set('inquiry_only', 'true');
    const q = qs.toString();
    return apiCall(`/leads${q ? `?${q}` : ''}`);
  },
  leadMessages: (leadId) => apiCall(`/leads/${leadId}/messages`),
  // Bulk-deletes selected Inbox/Leads rows - a real delete (DB row +, for
  // an IMAP-sourced email, the actual mailbox message), not the separate
  // PII-erasure DELETE /leads/:id. See server.js's comment on
  // POST /leads/delete-selected for why these are two different routes.
  deleteLeads: (ids) => apiCall('/leads/delete-selected', { method: 'POST', body: { ids } }),
  // `files` (optional) is an array of File objects from the reply
  // composer's attach button - switches to a multipart request only when
  // there's actually something to attach, so the common no-attachment
  // case stays a plain JSON POST exactly as before.
  replyToLead: (leadId, body, channel, files) => {
    if (files && files.length) {
      const form = new FormData();
      form.append('body', body);
      if (channel) form.append('channel', channel);
      files.forEach((f) => form.append('attachments', f));
      return apiCall(`/leads/${leadId}/reply`, { method: 'POST', body: form });
    }
    return apiCall(`/leads/${leadId}/reply`, { method: 'POST', body: channel ? { body, channel } : { body } });
  },

  uploadContent: (file, { productId, brandKit } = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (productId) form.append('product_id', productId);
    if (brandKit) form.append('brand_kit', JSON.stringify(brandKit));
    return apiCall('/content/upload', { method: 'POST', body: form });
  },

  transformContent: (assetId, channels) =>
    apiCall(`/content/${assetId}/transform`, { method: 'POST', body: { channels } }),

  approveVariant: (variantId, action, comment) =>
    apiCall(`/content/variants/${variantId}/approve`, { method: 'POST', body: { action, comment } }),

  // Super Admin / IT Admin only server-side - callers should expect a 403
  // for any other role and treat it as "not available", not an error to
  // surface loudly.
  integrations: () => apiCall('/integrations'),
};
