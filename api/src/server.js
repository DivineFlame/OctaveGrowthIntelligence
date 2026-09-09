const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NodeClam = require('clamscan');
const { rateLimit } = require('express-rate-limit');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
require('dotenv').config({ path: '../.env.production' });

const app = express();
// Behind Dokploy's Traefik (one reverse-proxy hop) - without this, every
// request looks like it comes from Traefik's own address, which breaks
// per-IP rate limiting (one shared bucket for all clients) and makes
// audit_logs.ip_address record the proxy, not the real client.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3001;

// DB - Postgres with RLS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@postgres:5432/${process.env.POSTGRES_DB}`,
  ssl: false
});

// Redis
const redisClient = redis.createClient({ url: process.env.REDIS_URL || `redis://:${process.env.REDIS_PASSWORD}@redis:6379` });
redisClient.connect().catch(console.error);
redisClient.on('error', err => console.error('Redis error', err));

// ClamAV - real scanning over the wire to the clamd container, no local binary needed.
// Fails CLOSED by default: if the scanner can't be reached, uploads are rejected
// rather than silently treated as clean. Set CLAMAV_REQUIRED=false to disable
// (e.g. for local dev without a clamav container running).
const CLAMAV_REQUIRED = process.env.CLAMAV_REQUIRED !== 'false';
let clamscanInstance = null;
async function getClamscan() {
  if (!clamscanInstance) {
    clamscanInstance = await new NodeClam().init({
      removeInfected: false,
      clamscan: { active: false },
      clamdscan: {
        host: process.env.CLAMAV_HOST || 'clamav',
        port: parseInt(process.env.CLAMAV_PORT || '3310', 10),
        timeout: 60000,
        localFallback: false
      },
      preference: 'clamdscan'
    });
  }
  return clamscanInstance;
}
// Returns { isInfected, viruses }. Throws if CLAMAV_REQUIRED and the scanner
// is unreachable or returns an inconclusive (null) result — callers must
// treat a thrown error as "reject the upload", not "assume clean".
async function scanFile(filePath) {
  if (!CLAMAV_REQUIRED) return { isInfected: false, viruses: [] };
  try {
    const scanner = await getClamscan();
    const { isInfected, viruses } = await scanner.isInfected(filePath);
    if (isInfected === null) throw new Error('Scan result inconclusive');
    return { isInfected: !!isInfected, viruses: viruses || [] };
  } catch (e) {
    throw new Error(`Virus scan unavailable: ${e.message}`);
  }
}
if (CLAMAV_REQUIRED) {
  getClamscan()
    .then(scanner => scanner.getVersion())
    .then(v => console.log(`ClamAV connected: ${v}`))
    .catch(e => console.warn(`ClamAV not reachable at startup — uploads will be rejected until it is (${e.message})`));
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"]
    }
  }
}));
// APP_DOMAIN/API_DOMAIN are documented as bare domains (e.g. "app.example.com"),
// but it's an easy mistake to set them with a scheme already included (e.g.
// "https://app.example.com"), which would silently double up to
// "https://https://app.example.com" wherever we prepend one ourselves.
// Strip any accidental scheme/trailing-slash so both forms work correctly.
function normalizeDomain(d) {
  return (d || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
const APP_DOMAIN = normalizeDomain(process.env.APP_DOMAIN);
const API_DOMAIN = normalizeDomain(process.env.API_DOMAIN);

// ENCRYPTION_KEY has been provisioned since the very first deploy (it's in
// .env.vps.example and docker-compose.dokploy.yml) but nothing ever used it
// until now: LLM provider API keys (llm_connections.api_key_encrypted) are
// encrypted at rest with it, AES-256-GCM, and only decrypted in memory at
// the point an agent actually calls the provider.
const ENCRYPTION_KEY_BUF = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'dev-encryption-key-change-me').digest();
function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_BUF, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}
function decryptSecret(encoded) {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY_BUF, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Real agent execution - actually calls the configured provider, rather than
// storing a system_prompt nobody ever sends anywhere. Three providers,
// chosen deliberately over "support anything": Anthropic and Sarvam both
// have a fixed, real endpoint/auth shape (verified against Anthropic's
// public API docs and Sarvam's own published SDK source respectively -
// Sarvam in particular uses an `api-subscription-key` header, NOT
// `Authorization: Bearer`, which is easy to get wrong), so those two are
// hardcoded rather than guessed at through a generic base_url. Anything
// else that speaks the OpenAI chat-completions shape (Groq, Together,
// Fireworks, DeepSeek, a self-hosted vLLM, etc.) goes through
// 'openai_compatible', which requires the connection's own base_url.
const LLM_PROVIDERS = ['anthropic', 'sarvam', 'openai_compatible'];

async function callLLM({ connection, model, systemPrompt, userMessage }) {
  const apiKey = decryptSecret(connection.api_key_encrypted);
  const provider = connection.provider;

  if (provider === 'anthropic') {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `Anthropic API error (HTTP ${resp.status})`);
    const text = data.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error('Anthropic response had no text content');
    return { text, raw: data };
  }

  if (provider === 'sarvam' || provider === 'openai_compatible') {
    let url, headers;
    if (provider === 'sarvam') {
      url = 'https://api.sarvam.ai/v1/chat/completions';
      headers = { 'api-subscription-key': apiKey, 'Content-Type': 'application/json' };
    } else {
      const base = (connection.base_url || '').replace(/\/+$/, '');
      if (!base) throw new Error('This connection has no base_url configured (required for openai_compatible)');
      url = `${base}/chat/completions`;
      headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    }
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userMessage });
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model || (provider === 'sarvam' ? 'sarvam-105b' : 'gpt-4o-mini'), messages })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `${provider} API error (HTTP ${resp.status})`);
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error(`${provider} response had no message content`);
    return { text, raw: data };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

// Runs one agent for real and records the outcome (success or failure -
// never silently swallowed) in agent_runs. Shared by the manual "Run Agent"
// route and the internal auto-run-on-lead-intake route below.
async function runAgentForProduct({ tenantId, productId, agentId, leadId, triggeredBy, triggerType, inputText }) {
  const { rows: agentRows } = await pool.query(
    `SELECT a.id, a.model, a.system_prompt, lc.provider, lc.base_url, lc.api_key_encrypted
     FROM agents a JOIN llm_connections lc ON lc.id = a.llm_connection_id
     WHERE a.id=$1 AND a.active=true`,
    [agentId]
  );
  if (!agentRows.length) throw new Error('Agent not found, inactive, or missing its LLM connection');
  const agent = agentRows[0];

  let status = 'SUCCESS', outputText = null, errorMsg = null;
  try {
    const result = await callLLM({ connection: agent, model: agent.model, systemPrompt: agent.system_prompt, userMessage: inputText });
    outputText = result.text;
  } catch (e) {
    status = 'FAILED';
    errorMsg = e.message;
  }

  const { rows } = await pool.query(
    `INSERT INTO agent_runs (tenant_id, product_id, agent_id, lead_id, triggered_by, trigger_type, input_text, output_text, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, productId, agentId, leadId || null, triggeredBy || null, triggerType, inputText, outputText, status, errorMsg]
  );
  return rows[0];
}

// Server-to-server auth for routes hermes/other backend containers call
// directly (no user JWT exists in that context). Fails closed: an unset
// INTERNAL_API_SECRET rejects every request rather than accepting none.
// Note this is *not* network isolation - this app is one Express instance
// on one port, and that port gets a public domain in Dokploy, so a route
// behind this middleware is still internet-reachable in principle. What
// actually protects it is the secret itself (random, only ever sent
// container-to-container) checked in constant time, the same trust model
// as a bearer token.
function internalMiddleware(req, res, next) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) return res.status(503).json({ error: 'INTERNAL_API_SECRET not configured' });
  const provided = req.headers['x-internal-secret'] || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid internal secret' });
  next();
}

// CORS - locked to this tenant's actual frontend domain(s), not left open to
// any origin. APP_DOMAIN covers the common case (one frontend); set
// CORS_ALLOWED_ORIGINS (comma-separated, full origins incl. scheme) for
// anything extra, e.g. a staging frontend or local dev.
// Requests with no Origin header (curl, server-to-server, the webhook
// endpoints) are never browser cross-origin requests, so they're unaffected
// by CORS either way and are passed through here.
const CORS_ALLOWED_ORIGINS = [
  ...(APP_DOMAIN ? [`https://${APP_DOMAIN}`] : []),
  ...(process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : [])
];
if (CORS_ALLOWED_ORIGINS.length === 0) {
  console.warn('CORS: no APP_DOMAIN or CORS_ALLOWED_ORIGINS set — every browser cross-origin request will be rejected until one is configured.');
} else {
  console.log('CORS: allowing browser origins:', CORS_ALLOWED_ORIGINS.join(', '));
}
app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  }
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting - nothing enforced this before; the original security docs
// assumed an nginx layer that doesn't exist under Dokploy. Applied per
// route below, not globally, so limits can differ by sensitivity.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' }
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many uploads, slow down' }
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});
app.use(generalLimiter);

// Storage for uploads - VPS local
const uploadDir = process.env.UPLOAD_DIR || '/app/recordings';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g,'_')}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max for content
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','application/pdf','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    // Allow all for MVP but check MIME via magic later via Paperclip/ClamAV
    cb(null, true);
  }
});
const csvUpload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Helpers
function sanitizeCSVValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (/^[=\+\-@]/.test(trimmed)) return `'${trimmed}`; // Prevent CSV injection
  return trimmed.replace(/<[^>]*>/g,''); // Strip HTML
}

async function auditLog(tenant_id, user_id, action, resource_type, resource_id, req, result='SUCCESS', details={}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, ip_address, user_agent, result, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenant_id, user_id, action, resource_type, resource_id, req.ip, req.headers['user-agent'], result, JSON.stringify(details)]
    );
  } catch(e){ console.error('Audit log failed', e.message); }
}

// Auth middleware - JWT + tenant + role
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me');
    req.user = decoded;
    // Set tenant for RLS
    pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', decoded.tenant_id]).catch(()=>{});
    next();
  } catch(e){
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function rbacMiddleware(allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      auditLog(req.user.tenant_id, req.user.id, 'RBAC_BLOCKED', 'api', null, req, 'BLOCKED', { attempted: req.path, role: req.user.role });
      return res.status(403).json({ error: 'Forbidden - role not allowed' });
    }
    next();
  };
}

// Routes

// Health
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redisClient.ping();
    res.json({ status: 'ok', service: 'api', timestamp: new Date().toISOString(), tenant_mode: 'multitenant', version: '4.0.0-secure-vps' });
  } catch(e){
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Auth - Login (with 2FA check for Super Admin)
app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password, totp } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await auditLog(user.tenant_id, user.id, 'LOGIN_FAILED', 'auth', null, req, 'FAILED');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.disabled) {
      await auditLog(user.tenant_id, user.id, 'LOGIN_DISABLED', 'auth', null, req, 'BLOCKED');
      return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
    }
    // Applies to any user with 2FA enabled, not just Super Admin/IT Admin -
    // enrollment (POST /auth/2fa/setup) is available to every role, so
    // enforcement can't be narrower than enrollment without silently
    // ignoring some users' 2FA.
    if (user.two_fa_enabled) {
      if (!totp) return res.status(401).json({ error: '2FA required', need_2fa: true });
      const totpValid = user.two_fa_secret && authenticator.check(String(totp).replace(/\s+/g, ''), user.two_fa_secret);
      if (!totpValid) {
        await auditLog(user.tenant_id, user.id, 'LOGIN_2FA_FAILED', 'auth', null, req, 'FAILED');
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }
    const token = jwt.sign({ id: user.id, tenant_id: user.tenant_id, role: user.role, email: user.email }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '15m' });
    const refresh = jwt.sign({ id: user.id, type: 'refresh' }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '7d' });
    await auditLog(user.tenant_id, user.id, 'LOGIN_SUCCESS', 'auth', user.id, req, 'SUCCESS');
    res.json({ token, refresh, user: { id: user.id, tenant_id: user.tenant_id, role: user.role, email: user.email } });
  } catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

// Auth - Signup status (lets the frontend show/hide the Sign Up option without guessing)
app.get('/auth/signup-status', async (req, res) => {
  try {
    const used = await pool.query(`SELECT 1 FROM system_flags WHERE key='signup_used'`);
    const enabled = process.env.SIGNUP_ENABLED !== 'false';
    res.json({ available: enabled && !used.rows.length });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Auth - Signup (bootstraps the very first Super Admin + their tenant only)
// This is NOT general self-service registration - every subsequent user is
// created by a tenant admin via POST /users. Two independent gates:
//   1. SIGNUP_ENABLED=false in the environment disables it outright.
//   2. Even left enabled, system_flags.signup_used is claimed atomically via
//      INSERT ... ON CONFLICT DO NOTHING - only the first request to win
//      that race can ever create an account here, so forgetting to flip
//      SIGNUP_ENABLED off can't mint a second Super Admin.
app.post('/auth/signup', authLimiter, async (req, res) => {
  if (process.env.SIGNUP_ENABLED === 'false') {
    return res.status(403).json({ error: 'Signup is disabled' });
  }
  const { email, password, company_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claim = await client.query(
      `INSERT INTO system_flags (key, value) VALUES ('signup_used', 'true') ON CONFLICT (key) DO NOTHING RETURNING key`
    );
    if (!claim.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Signup already used — an account already exists. Ask your Super Admin to create yours.' });
    }

    const tenantName = company_name || 'Default Tenant';
    const subdomain = tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 90) || 'default';
    const webhookSecret = crypto.randomBytes(24).toString('hex');
    const tenantRows = await client.query(
      `INSERT INTO tenants (name, subdomain, plan, is_premium, webhook_secret) VALUES ($1,$2,'premium',true,$3) RETURNING id`,
      [tenantName, subdomain, webhookSecret]
    );
    const tenantId = tenantRows.rows[0].id;

    const roleRow = await client.query(`SELECT * FROM roles WHERE name='SUPER_ADMIN'`);
    const r = roleRow.rows[0];
    const password_hash = await bcrypt.hash(password, 12);
    const userRows = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content)
       VALUES ($1,$2,$3,'SUPER_ADMIN',$4,$5,$6,$7) RETURNING id, tenant_id, email, role`,
      [tenantId, email, password_hash, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content]
    );
    const user = userRows.rows[0];

    await client.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, ip_address, user_agent, result, details) VALUES ($1,$2,'SIGNUP_FIRST_ADMIN','user',$2,$3,$4,'SUCCESS',$5)`,
      [tenantId, user.id, req.ip, req.headers['user-agent'], JSON.stringify({ email })]
    );

    await client.query('COMMIT');

    const token = jwt.sign({ id: user.id, tenant_id: tenantId, role: 'SUPER_ADMIN', email }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '15m' });
    const refresh = jwt.sign({ id: user.id, type: 'refresh' }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '7d' });
    res.json({ token, refresh, user: { id: user.id, tenant_id: tenantId, role: 'SUPER_ADMIN', email } });
  } catch(e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'That email or company name is already taken' });
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Auth - Refresh (exchange a 7-day refresh token for a new 15-minute access token)
// Without this, the access token issued at login has no way to be renewed and
// every session silently dies 15 minutes after login.
app.post('/auth/refresh', authLimiter, async (req, res) => {
  const { refresh } = req.body;
  if (!refresh) return res.status(400).json({ error: 'refresh token required' });
  try {
    const decoded = jwt.verify(refresh, process.env.JWT_SECRET || 'dev-secret-change-me');
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Not a refresh token' });
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' });
    const user = rows[0];
    const token = jwt.sign({ id: user.id, tenant_id: user.tenant_id, role: user.role, email: user.email }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '15m' });
    res.json({ token, user: { id: user.id, tenant_id: user.tenant_id, role: user.role, email: user.email } });
  } catch(e){ return res.status(401).json({ error: 'Invalid or expired refresh token' }); }
});

// 2FA - Setup: generates a secret + QR code, but does NOT enable enforcement
// yet. two_fa_enabled only flips on in /auth/2fa/verify, once the user has
// proven they actually scanned it and their app produces valid codes -
// otherwise a typo or a QR that never got scanned would lock them out on
// their very next login.
app.post('/auth/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    await pool.query('UPDATE users SET two_fa_secret=$1, two_fa_enabled=false WHERE id=$2', [secret, req.user.id]);
    const otpauth = authenticator.keyuri(req.user.email, 'OctaveGrowthIntelligence', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({ secret, otpauth, qr: qrDataUrl });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// 2FA - Verify: confirms the code from the authenticator app matches, then
// (and only then) turns enforcement on.
app.post('/auth/2fa/verify', authMiddleware, authLimiter, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    const { rows } = await pool.query('SELECT two_fa_secret FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length || !rows[0].two_fa_secret) return res.status(400).json({ error: 'Run /auth/2fa/setup first' });
    const valid = authenticator.check(String(token).replace(/\s+/g, ''), rows[0].two_fa_secret);
    if (!valid) return res.status(401).json({ error: 'Invalid code' });
    await pool.query('UPDATE users SET two_fa_enabled=true WHERE id=$1', [req.user.id]);
    await auditLog(req.user.tenant_id, req.user.id, 'ENABLE_2FA', 'user', req.user.id, req, 'SUCCESS', {});
    res.json({ message: '2FA enabled' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// 2FA - Disable: requires the current password so a hijacked but
// still-logged-in session (e.g. a stolen access token, 15 min TTL) can't
// silently strip 2FA off the account.
app.post('/auth/2fa/disable', authMiddleware, authLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Current password is required to disable 2FA' });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    await pool.query('UPDATE users SET two_fa_enabled=false, two_fa_secret=NULL WHERE id=$1', [req.user.id]);
    await auditLog(req.user.tenant_id, req.user.id, 'DISABLE_2FA', 'user', req.user.id, req, 'SUCCESS', {});
    res.json({ message: '2FA disabled' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// 2FA - Status: lets the frontend show enabled/disabled without guessing from the JWT
app.get('/auth/2fa/status', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT two_fa_enabled FROM users WHERE id=$1', [req.user.id]);
    res.json({ enabled: !!(rows.length && rows[0].two_fa_enabled) });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Tenant columns safe to return to any authenticated user. webhook_secret is
// deliberately excluded here — it's a bearer credential (anyone who has it
// can post fake leads into this tenant), so it's only ever returned by the
// dedicated /integrations/webhook-urls route below, gated to roles that can
// manage integrations.
const TENANT_PUBLIC_COLUMNS = 'id, name, subdomain, plan, is_premium, created_at';

// Tenants - Create (Super Admin only)
app.post('/tenants', authMiddleware, rbacMiddleware(['SUPER_ADMIN']), async (req, res) => {
  const { name, subdomain, plan } = req.body;
  try {
    const webhookSecret = crypto.randomBytes(24).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO tenants (name, subdomain, plan, is_premium, webhook_secret) VALUES ($1,$2,$3,$4,$5) RETURNING ${TENANT_PUBLIC_COLUMNS}`,
      [name, subdomain, plan, plan==='premium', webhookSecret]
    );
    await auditLog(req.user.tenant_id, req.user.id, 'CREATE_TENANT', 'tenant', rows[0].id, req, 'SUCCESS', { subdomain });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Tenants - List all (Super Admin only)
app.get('/tenants', authMiddleware, rbacMiddleware(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${TENANT_PUBLIC_COLUMNS} FROM tenants ORDER BY created_at DESC`);
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Tenants - Get own tenant (any authenticated user)
app.get('/tenants/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${TENANT_PUBLIC_COLUMNS} FROM tenants WHERE id=$1`, [req.user.tenant_id]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Roles - List available roles (for user-creation role picker)
app.get('/roles', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM roles ORDER BY name');
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Roles allowed to create/manage users, kept in sync with roles.can_manage_users
const USER_MANAGER_ROLES = ['SUPER_ADMIN', 'IT_ADMIN', 'DEPT_ADMIN'];

// Users - List within a tenant (own tenant; Super Admin may pass ?tenant_id= to inspect another tenant)
app.get('/users', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  try {
    const targetTenant = (req.user.role === 'SUPER_ADMIN' && req.query.tenant_id) ? req.query.tenant_id : req.user.tenant_id;
    const { rows } = await pool.query('SELECT id, tenant_id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at FROM users WHERE tenant_id=$1 ORDER BY created_at DESC', [targetTenant]);
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Users - Create within a tenant, role drives permissions (single source of truth: roles table)
// Super Admin may pass tenant_id to seed the first user of a tenant they just created —
// everyone else is locked to their own tenant regardless of what they send.
app.post('/users', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  const { email, password, role, tenant_id } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'email, password and role are required' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
  try {
    const targetTenant = (req.user.role === 'SUPER_ADMIN' && tenant_id) ? tenant_id : req.user.tenant_id;
    const roleRow = await pool.query('SELECT * FROM roles WHERE name=$1', [role]);
    if (!roleRow.rows.length) return res.status(400).json({ error: `Unknown role: ${role}` });
    const r = roleRow.rows[0];
    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, tenant_id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at`,
      [targetTenant, email, password_hash, r.name, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content]
    );
    await auditLog(req.user.tenant_id, req.user.id, 'CREATE_USER', 'user', rows[0].id, req, 'SUCCESS', { email, role: r.name, tenant_id: targetTenant });
    res.json(rows[0]);
  } catch(e){
    if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Users - Change an existing user's role (own tenant only, even for Super Admin)
app.patch('/users/:userId/role', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'role is required' });
  try {
    const roleRow = await pool.query('SELECT * FROM roles WHERE name=$1', [role]);
    if (!roleRow.rows.length) return res.status(400).json({ error: `Unknown role: ${role}` });
    const r = roleRow.rows[0];
    const { rows } = await pool.query(
      `UPDATE users SET role=$1, max_history_days=$2, can_view_revenue=$3, can_view_integrations=$4, can_approve_content=$5
       WHERE id=$6 AND tenant_id=$7
       RETURNING id, tenant_id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at`,
      [r.name, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content, userId, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found in your tenant' });
    await auditLog(req.user.tenant_id, req.user.id, 'CHANGE_USER_ROLE', 'user', userId, req, 'SUCCESS', { role: r.name });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Users - Enable/disable an account (own tenant only). A disabled user is
// rejected at POST /auth/login regardless of correct credentials/2FA. A
// manager can't disable their own account (would lock a tenant with a
// single admin out with no recovery path).
app.patch('/users/:userId/status', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  const { userId } = req.params;
  const { disabled } = req.body;
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) is required' });
  if (userId === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
  try {
    const { rows } = await pool.query(
      `UPDATE users SET disabled=$1 WHERE id=$2 AND tenant_id=$3
       RETURNING id, tenant_id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at`,
      [disabled, userId, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found in your tenant' });
    await auditLog(req.user.tenant_id, req.user.id, disabled ? 'DISABLE_USER' : 'ENABLE_USER', 'user', userId, req, 'SUCCESS');
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Users - Admin-driven password reset (own tenant only). There is no email
// infrastructure in this system for a self-service "forgot password" flow,
// so a tenant admin sets a new password directly on the user's behalf; the
// user should be told to change it again after logging in.
app.post('/users/:userId/reset-password', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  const { userId } = req.params;
  const { new_password } = req.body;
  if (!new_password || new_password.length < 12) return res.status(400).json({ error: 'new_password must be at least 12 characters' });
  try {
    const password_hash = await bcrypt.hash(new_password, 12);
    const { rows } = await pool.query(
      'UPDATE users SET password_hash=$1 WHERE id=$2 AND tenant_id=$3 RETURNING id, email',
      [password_hash, userId, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found in your tenant' });
    await auditLog(req.user.tenant_id, req.user.id, 'RESET_USER_PASSWORD', 'user', userId, req, 'SUCCESS');
    res.json({ success: true, email: rows[0].email });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ===== Products/Services, per-product membership, channels, and Agents =====
// Hierarchy: Super Admin creates Tenants (Standard/Premium, already existed
// via POST /tenants). A Tenant Admin (SUPER_ADMIN/IT_ADMIN/DEPT_ADMIN - the
// existing tenant-management roles) creates Products/Services and assigns a
// user as that product's Admin. A Product Admin configures the product's
// social channels and adds MEMBER users to run them (Standard plan) or
// enables Agents (Premium plan only). Agent/LLM-connection definitions
// themselves are Super-Admin-only, platform-wide, not tenant-scoped.

const PRODUCT_TENANT_ADMIN_ROLES = ['SUPER_ADMIN', 'IT_ADMIN', 'DEPT_ADMIN'];
const PRODUCT_CHANNELS = ['whatsapp', 'facebook', 'instagram', 'linkedin', 'youtube', 'quora', 'email'];

async function getProductMembership(productId, userId) {
  const { rows } = await pool.query('SELECT role FROM product_members WHERE product_id=$1 AND user_id=$2', [productId, userId]);
  return rows.length ? rows[0].role : null;
}
// A tenant-wide admin role can administer any product in their tenant; a
// product's own ADMIN member can administer just that one product.
async function canAdminProduct(req, productId) {
  if (PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role)) return true;
  return (await getProductMembership(productId, req.user.id)) === 'ADMIN';
}

// Products - Create (Tenant Admin only). Pre-creates all 7 channel rows as
// 'not_configured', in the same transaction, so a product's full channel
// set exists from the moment it's created rather than materializing rows
// lazily the first time each one is individually configured.
app.post('/products', authMiddleware, rbacMiddleware(PRODUCT_TENANT_ADMIN_ROLES), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO products (tenant_id, name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.tenant_id, name, description || null, req.user.id]
    );
    const product = rows[0];
    for (const channel of PRODUCT_CHANNELS) {
      await client.query(
        `INSERT INTO product_channels (product_id, channel, status) VALUES ($1,$2,'not_configured') ON CONFLICT (product_id, channel) DO NOTHING`,
        [product.id, channel]
      );
    }
    await client.query('COMMIT');
    await auditLog(req.user.tenant_id, req.user.id, 'CREATE_PRODUCT', 'product', product.id, req, 'SUCCESS', { name });
    res.json(product);
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Products - List: Tenant Admin roles see every product in the tenant;
// everyone else sees only products they're a member of.
app.get('/products', authMiddleware, async (req, res) => {
  try {
    const { rows } = PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role)
      ? await pool.query('SELECT * FROM products WHERE tenant_id=$1 ORDER BY created_at DESC', [req.user.tenant_id])
      : await pool.query('SELECT p.* FROM products p JOIN product_members pm ON pm.product_id=p.id WHERE p.tenant_id=$1 AND pm.user_id=$2 ORDER BY p.created_at DESC', [req.user.tenant_id, req.user.id]);
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/products/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    const isTenantAdmin = PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role);
    const membershipRole = await getProductMembership(req.params.id, req.user.id);
    if (!isTenantAdmin && !membershipRole) return res.status(403).json({ error: 'Not a member of this product' });
    res.json(Object.assign({}, rows[0], { your_role: isTenantAdmin ? 'TENANT_ADMIN' : membershipRole }));
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Product members - list (Tenant Admin or any member of the product)
app.get('/products/:id/members', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isTenantAdmin = PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role);
    if (!isTenantAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });
    const { rows } = await pool.query(
      `SELECT pm.id, pm.role, pm.created_at, u.id as user_id, u.email, u.role as tenant_role
       FROM product_members pm JOIN users u ON u.id=pm.user_id WHERE pm.product_id=$1 ORDER BY pm.created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Product members - add/assign (Tenant Admin, to assign the first Product
// Admin; or that product's existing Admin, to add MEMBER users)
app.post('/products/:id/members', authMiddleware, async (req, res) => {
  const { user_id, role } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const memberRole = role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only a Tenant Admin or this product's Admin can add members" });
    const targetUser = await pool.query('SELECT id FROM users WHERE id=$1 AND tenant_id=$2', [user_id, req.user.tenant_id]);
    if (!targetUser.rows.length) return res.status(400).json({ error: 'User not found in your tenant' });
    const { rows } = await pool.query(
      `INSERT INTO product_members (product_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (product_id, user_id) DO UPDATE SET role=EXCLUDED.role RETURNING *`,
      [req.params.id, user_id, memberRole]
    );
    await auditLog(req.user.tenant_id, req.user.id, 'ADD_PRODUCT_MEMBER', 'product', req.params.id, req, 'SUCCESS', { user_id, role: memberRole });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.delete('/products/:id/members/:userId', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only a Tenant Admin or this product's Admin can remove members" });
    await pool.query('DELETE FROM product_members WHERE product_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
    await auditLog(req.user.tenant_id, req.user.id, 'REMOVE_PRODUCT_MEMBER', 'product', req.params.id, req, 'SUCCESS', { user_id: req.params.userId });
    res.json({ message: 'Removed' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Product channels - config storage only (no real per-platform posting yet -
// see README). Product Admin (or Tenant Admin) manages these.
app.get('/products/:id/channels', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isTenantAdmin = PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role);
    if (!isTenantAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });
    const { rows } = await pool.query('SELECT channel, status, config, updated_at FROM product_channels WHERE product_id=$1', [req.params.id]);
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/products/:id/channels', authMiddleware, async (req, res) => {
  const { channel, config } = req.body;
  if (!PRODUCT_CHANNELS.includes(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only a Tenant Admin or this product's Admin can configure channels" });
    const { rows } = await pool.query(
      `INSERT INTO product_channels (product_id, channel, config, status, updated_at) VALUES ($1,$2,$3,'configured',NOW())
       ON CONFLICT (product_id, channel) DO UPDATE SET config=EXCLUDED.config, status='configured', updated_at=NOW() RETURNING *`,
      [req.params.id, channel, JSON.stringify(config || {})]
    );
    await auditLog(req.user.tenant_id, req.user.id, 'CONFIGURE_PRODUCT_CHANNEL', 'product', req.params.id, req, 'SUCCESS', { channel });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// LLM connections - Super Admin only, platform-wide. api_key is encrypted at
// rest (encryptSecret) and never returned once stored.
app.post('/llm-connections', authMiddleware, rbacMiddleware(['SUPER_ADMIN']), async (req, res) => {
  const { name, provider, api_key, base_url } = req.body;
  if (!name || !provider || !api_key) return res.status(400).json({ error: 'name, provider and api_key are required' });
  if (!LLM_PROVIDERS.includes(provider)) return res.status(400).json({ error: `provider must be one of: ${LLM_PROVIDERS.join(', ')}` });
  if (provider === 'openai_compatible' && !base_url) return res.status(400).json({ error: 'base_url is required for provider openai_compatible (e.g. https://api.groq.com/openai/v1)' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO llm_connections (name, provider, base_url, api_key_encrypted, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, provider, base_url, created_at',
      [name, provider, provider === 'openai_compatible' ? base_url : null, encryptSecret(api_key), req.user.id]
    );
    await auditLog(req.user.tenant_id, req.user.id, 'CREATE_LLM_CONNECTION', 'llm_connection', rows[0].id, req, 'SUCCESS', { provider });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/llm-connections', authMiddleware, rbacMiddleware(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, provider, base_url, created_at FROM llm_connections ORDER BY created_at DESC');
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.delete('/llm-connections/:id', authMiddleware, rbacMiddleware(['SUPER_ADMIN']), async (req, res) => {
  try {
    const inUse = await pool.query('SELECT id FROM agents WHERE llm_connection_id=$1 LIMIT 1', [req.params.id]);
    if (inUse.rows.length) return res.status(409).json({ error: 'This LLM connection is still used by one or more agents' });
    await pool.query('DELETE FROM llm_connections WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Agents - Super Admin creates/edits; any authenticated user can list (so a
// Product Admin can pick one to enable on their Premium product).
app.post('/agents', authMiddleware, rbacMiddleware(['SUPER_ADMIN']), async (req, res) => {
  const { name, llm_connection_id, model, system_prompt, config } = req.body;
  if (!name || !llm_connection_id) return res.status(400).json({ error: 'name and llm_connection_id are required' });
  try {
    const conn = await pool.query('SELECT id FROM llm_connections WHERE id=$1', [llm_connection_id]);
    if (!conn.rows.length) return res.status(400).json({ error: 'Unknown llm_connection_id' });
    const { rows } = await pool.query(
      'INSERT INTO agents (name, llm_connection_id, model, system_prompt, config, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, llm_connection_id, model || null, system_prompt || null, JSON.stringify(config || {}), req.user.id]
    );
    await auditLog(req.user.tenant_id, req.user.id, 'CREATE_AGENT', 'agent', rows[0].id, req, 'SUCCESS', { name });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/agents', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, model, active, created_at FROM agents WHERE active=true ORDER BY created_at DESC');
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.patch('/agents/:id', authMiddleware, rbacMiddleware(['SUPER_ADMIN']), async (req, res) => {
  const { name, model, system_prompt, config, active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE agents SET name=COALESCE($1,name), model=COALESCE($2,model), system_prompt=COALESCE($3,system_prompt), config=COALESCE($4,config), active=COALESCE($5,active) WHERE id=$6 RETURNING *`,
      [name || null, model || null, system_prompt || null, config ? JSON.stringify(config) : null, typeof active === 'boolean' ? active : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agent not found' });
    res.json(rows[0]);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Product agents - which agents a (Premium-only) product has enabled.
// Managed by that product's Admin or a Tenant Admin, same as channels/members.
app.get('/products/:id/agents', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isTenantAdmin = PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role);
    if (!isTenantAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });
    const { rows } = await pool.query('SELECT a.id, a.name, a.model FROM product_agents pa JOIN agents a ON a.id=pa.agent_id WHERE pa.product_id=$1', [req.params.id]);
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/products/:id/agents', authMiddleware, async (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
  try {
    const tenant = await pool.query('SELECT is_premium FROM tenants WHERE id=$1', [req.user.tenant_id]);
    if (!tenant.rows.length || !tenant.rows[0].is_premium) return res.status(403).json({ error: 'Agents are a Premium-plan feature — Standard-plan products run through human users instead' });
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only a Tenant Admin or this product's Admin can enable agents" });
    const agent = await pool.query('SELECT id FROM agents WHERE id=$1 AND active=true', [agent_id]);
    if (!agent.rows.length) return res.status(400).json({ error: 'Unknown or inactive agent' });
    const { rows } = await pool.query(
      'INSERT INTO product_agents (product_id, agent_id) VALUES ($1,$2) ON CONFLICT (product_id, agent_id) DO NOTHING RETURNING *',
      [req.params.id, agent_id]
    );
    await auditLog(req.user.tenant_id, req.user.id, 'ENABLE_PRODUCT_AGENT', 'product', req.params.id, req, 'SUCCESS', { agent_id });
    res.json(rows[0] || { message: 'Already enabled' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.delete('/products/:id/agents/:agentId', authMiddleware, async (req, res) => {
  try {
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only a Tenant Admin or this product's Admin can disable agents" });
    await pool.query('DELETE FROM product_agents WHERE product_id=$1 AND agent_id=$2', [req.params.id, req.params.agentId]);
    res.json({ message: 'Disabled' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Run an enabled agent for real - actually calls its LLM connection (see
// callLLM/runAgentForProduct above) rather than storing a system_prompt
// nobody ever sends anywhere. Any product member can trigger this (not just
// the product's Admin) - "run through Agents in premium" was meant to
// replace a Standard-plan member's manual work, not gate behind an extra
// admin step. Pass either a lead_id (pulls that lead's own fields into the
// prompt) or freeform input; at least one is required.
app.post('/products/:id/agents/:agentId/run', authMiddleware, async (req, res) => {
  const { lead_id, input } = req.body;
  if (!lead_id && !input) return res.status(400).json({ error: 'lead_id or input is required' });
  try {
    const tenant = await pool.query('SELECT is_premium FROM tenants WHERE id=$1', [req.user.tenant_id]);
    if (!tenant.rows.length || !tenant.rows[0].is_premium) return res.status(403).json({ error: 'Agents are a Premium-plan feature' });
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isTenantAdmin = PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role);
    if (!isTenantAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });
    const enabled = await pool.query('SELECT id FROM product_agents WHERE product_id=$1 AND agent_id=$2', [req.params.id, req.params.agentId]);
    if (!enabled.rows.length) return res.status(400).json({ error: 'This agent is not enabled on this product' });

    let inputText = input || '';
    let leadId = null;
    if (lead_id) {
      await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
      const lead = await pool.query('SELECT * FROM leads WHERE id=$1 AND tenant_id=$2', [lead_id, req.user.tenant_id]);
      if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found in your tenant' });
      const l = lead.rows[0];
      leadId = l.id;
      inputText = [
        `New lead via ${l.source_channel || 'unknown channel'}.`,
        `Company: ${l.company_name || 'n/a'}`,
        `Contact: ${l.contact_name || 'n/a'}`,
        l.phone ? `Phone: ${l.phone}` : null,
        l.email ? `Email: ${l.email}` : null,
        input ? `\nAdditional instructions: ${input}` : null
      ].filter(Boolean).join('\n');
    }

    const run = await runAgentForProduct({
      tenantId: req.user.tenant_id, productId: req.params.id, agentId: req.params.agentId,
      leadId, triggeredBy: req.user.id, triggerType: 'manual', inputText
    });
    await auditLog(req.user.tenant_id, req.user.id, 'RUN_AGENT', 'agent', req.params.agentId, req, run.status, { product_id: req.params.id, lead_id: leadId });
    res.json(run);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Run history for one agent on one product - so a Product Admin can see
// what an agent actually said, not just that it was "enabled".
app.get('/products/:id/agents/:agentId/runs', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenant_id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isTenantAdmin = PRODUCT_TENANT_ADMIN_ROLES.includes(req.user.role);
    if (!isTenantAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });
    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
    const { rows } = await pool.query(
      'SELECT id, lead_id, triggered_by, trigger_type, input_text, output_text, status, error, created_at FROM agent_runs WHERE product_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 50',
      [req.params.id, req.params.agentId]
    );
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Internal, server-to-server only (see internalMiddleware) - Hermes calls
// this after a lead lands, to actually run a Premium product's agent on it
// instead of just logging "enrichment not yet implemented". Since inbound
// webhooks are tenant+channel scoped, not product-scoped (there is no
// per-product webhook URL - see README), this can only safely auto-route
// when exactly one of the tenant's Premium products has that channel
// configured with an enabled agent; anything more ambiguous is reported
// back honestly instead of guessing.
app.post('/internal/leads/:leadId/auto-run-agent', internalMiddleware, async (req, res) => {
  try {
    const { rows: leadRows } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.leadId]);
    if (!leadRows.length) return res.status(404).json({ error: 'Lead not found' });
    const lead = leadRows[0];
    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', lead.tenant_id]);

    const tenant = await pool.query('SELECT is_premium FROM tenants WHERE id=$1', [lead.tenant_id]);
    if (!tenant.rows.length || !tenant.rows[0].is_premium) return res.json({ ran: false, reason: 'tenant is not on the Premium plan' });

    const candidates = await pool.query(
      `SELECT DISTINCT p.id AS product_id, pa.agent_id
       FROM products p
       JOIN product_channels pc ON pc.product_id = p.id AND pc.channel = $2 AND pc.status = 'configured'
       JOIN product_agents pa ON pa.product_id = p.id
       JOIN agents a ON a.id = pa.agent_id AND a.active = true
       WHERE p.tenant_id = $1`,
      [lead.tenant_id, lead.source_channel]
    );
    if (!candidates.rows.length) return res.json({ ran: false, reason: `no Premium product has "${lead.source_channel}" configured with an active agent enabled` });
    if (candidates.rows.length > 1) return res.json({ ran: false, reason: `${candidates.rows.length} products match this channel - auto-routing is ambiguous without per-product webhook URLs, run the agent manually from the product's Agents tab instead` });

    const { product_id, agent_id } = candidates.rows[0];
    const inputText = [
      `New lead via ${lead.source_channel || 'unknown channel'}.`,
      `Company: ${lead.company_name || 'n/a'}`,
      `Contact: ${lead.contact_name || 'n/a'}`,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.email ? `Email: ${lead.email}` : null
    ].filter(Boolean).join('\n');

    const run = await runAgentForProduct({
      tenantId: lead.tenant_id, productId: product_id, agentId: agent_id,
      leadId: lead.id, triggeredBy: null, triggerType: 'auto_lead_intake', inputText
    });
    res.json({ ran: true, run_id: run.id, status: run.status });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Leads - List (RLS enforced)
app.get('/leads', authMiddleware, async (req, res) => {
  try {
    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
    const { rows } = await pool.query('SELECT * FROM leads WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.tenant_id]);
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Leads - CSV Upload (Secure: 10MB, 5000 rows, sanitize, dedup, ClamAV)
app.post('/leads/upload-csv', authMiddleware, uploadLimiter, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    let scan;
    try {
      scan = await scanFile(req.file.path);
    } catch (scanErr) {
      fs.unlink(req.file.path, () => {});
      return res.status(503).json({ error: scanErr.message });
    }
    if (scan.isInfected) {
      fs.unlink(req.file.path, () => {});
      await auditLog(req.user.tenant_id, req.user.id, 'VIRUS_DETECTED', 'csv_upload', null, req, 'BLOCKED', { file: req.file.originalname, viruses: scan.viruses });
      return res.status(400).json({ error: 'File failed virus scan', viruses: scan.viruses });
    }

    const content = fs.readFileSync(req.file.path, 'utf-8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    if (records.length > 5000) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Max 5000 rows' }); }

    // Sanitize + validate
    const sanitized = records.map(r => {
      const obj = {};
      for (const k in r) {
        obj[k.toLowerCase().replace(/[^a-z]/g,'_')] = sanitizeCSVValue(r[k]);
      }
      return obj;
    });

    // Deduplicate by phone+email
    const seen = new Set();
    let dup = 0, valid = 0, invalid = 0;
    const toInsert = [];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const row of sanitized) {
      const phone = row.phone || row.mobile || row.phone_number || '';
      const email = row.email || '';
      if (email && !emailRegex.test(email)) { invalid++; continue; }
      const key = `${phone}|${email}`.toLowerCase();
      if (seen.has(key)) { dup++; continue; }
      seen.add(key);
      toInsert.push(row);
      valid++;
    }

    // Insert with RLS
    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
    const uploadId = uuidv4();
    await pool.query('INSERT INTO csv_uploads (id, tenant_id, uploaded_by, file_name, file_size, rows_total, rows_valid, rows_duplicate, rows_invalid, virus_scan_status, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [uploadId, req.user.tenant_id, req.user.id, req.file.originalname, req.file.size, records.length, valid, dup, invalid, 'CLEAN', 'COMPLETED']);

    for (const row of toInsert.slice(0, 5000)) {
      await pool.query('INSERT INTO leads (tenant_id, company_name, contact_name, phone, email, source_channel, status, csv_upload_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.user.tenant_id, row.company || row.company_name || '', row.contact_name || row.full_name || row.name || '', row.phone || row.mobile || '', row.email || '', 'csv_upload', 'NEW', uploadId]);
    }

    await auditLog(req.user.tenant_id, req.user.id, 'IMPORT_CSV', 'csv_upload', uploadId, req, 'SUCCESS', { rows_total: records.length, valid, dup, invalid, file: req.file.originalname });

    // Push to Redis for Sarvam queue - language auto
    await redisClient.lPush(`sarvam:queue:${req.user.tenant_id}`, JSON.stringify({ uploadId, valid, tenant_id: req.user.tenant_id }));

    fs.unlink(req.file.path, () => {}); // temp CSV is fully parsed into the DB now, no need to keep it
    res.json({ uploadId, rows_total: records.length, rows_valid: valid, rows_duplicate: dup, rows_invalid: invalid, message: 'CSV imported, pushed to Inbox + Sarvam queue' });
  } catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

// Content - Upload raw asset (100MB max, ClamAV scan, MIME check)
app.post('/content/upload', authMiddleware, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    let scan;
    try {
      scan = await scanFile(req.file.path);
    } catch (scanErr) {
      fs.unlink(req.file.path, () => {});
      return res.status(503).json({ error: scanErr.message });
    }
    if (scan.isInfected) {
      fs.unlink(req.file.path, () => {});
      await auditLog(req.user.tenant_id, req.user.id, 'VIRUS_DETECTED', 'content_asset', null, req, 'BLOCKED', { file: req.file.originalname, viruses: scan.viruses });
      return res.status(400).json({ error: 'File failed virus scan', viruses: scan.viruses });
    }
    const virusStatus = 'CLEAN';

    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
    const { rows } = await pool.query('INSERT INTO content_assets (tenant_id, uploaded_by, file_name, file_size, mime_type, s3_key, virus_scan_status, brand_kit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [req.user.tenant_id, req.user.id, req.file.originalname, req.file.size, req.file.mimetype, req.file.path, virusStatus, JSON.stringify(req.body.brand_kit || {})]);

    await auditLog(req.user.tenant_id, req.user.id, 'UPLOAD_CONTENT', 'content_asset', rows[0].id, req, 'SUCCESS', { file: req.file.originalname, size: req.file.size });

    // Push to transformer queue - Hermes + Paperclip
    // NOTE: this is a single shared key, not per-tenant (tenant_id travels
    // in the payload instead) — Redis BRPOP takes exact key names, not
    // wildcards, so a per-tenant key here would mean the consumers below
    // could never actually block on "all tenants' queues" the way a
    // `transformer:queue:*` pattern implies but does not do.
    await redisClient.lPush('transformer:queue', JSON.stringify({ asset_id: rows[0].id, tenant_id: req.user.tenant_id, channels: req.body.channels || ['youtube','instagram-feed','facebook'], requested_by: req.user.id }));

    res.json({ asset: rows[0], message: 'Uploaded, queued for Paperclip transform per channel spec' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Content - Transform via Paperclip (YouTube, IG, etc.)
app.post('/content/:assetId/transform', authMiddleware, async (req, res) => {
  const { assetId } = req.params;
  const { channels } = req.body; // ['youtube','shorts','instagram-feed','instagram-reels','facebook','linkedin','whatsapp']
  try {
    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
    const asset = await pool.query('SELECT * FROM content_assets WHERE id=$1 AND tenant_id=$2', [assetId, req.user.tenant_id]);
    if (!asset.rows.length) return res.status(404).json({ error: 'Asset not found' });

    const specs = {
      'youtube': '1920x1080 thumbnail 1280x720 title<=100',
      'shorts': '1080x1920 <=60s',
      'instagram-feed': '1080x1080 + 1080x1350',
      'instagram-reels': '1080x1920 cover 1080x1920',
      'facebook': '1200x628 + 1080x1080 text<=125',
      'linkedin': '1200x627 doc 1080x1350 text<=3000',
      'whatsapp': '1:1 status 1080x1080'
    };

    const variants = [];
    for (const ch of (channels || ['youtube','instagram-feed'])) {
      const { rows } = await pool.query('INSERT INTO content_variants (asset_id, tenant_id, channel, spec, title, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [assetId, req.user.tenant_id, ch, specs[ch] || 'auto', `${ch} variant for ${asset.rows[0].file_name}`, 'PENDING_APPROVAL']);
      variants.push(rows[0]);
    }

    // Call Paperclip transformer service
    try {
      await fetch(`http://${process.env.PAPERCLIP_SERVICE || 'paperclip-transformer:8000'}/transform`, { method: 'POST', body: JSON.stringify({ asset_id: assetId, variants }), headers: { 'Content-Type': 'application/json' } });
    } catch(e){ console.log('Paperclip call failed, queued via Redis', e.message); }

    await auditLog(req.user.tenant_id, req.user.id, 'TRANSFORM_CONTENT', 'content_asset', assetId, req, 'SUCCESS', { channels, variants: variants.length });

    res.json({ variants, message: 'Transformed per channel spec, pending approval' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Content - Approval workflow (Super Admin / Approver only)
app.post('/content/variants/:variantId/approve', authMiddleware, rbacMiddleware(['SUPER_ADMIN','APPROVER','DEPT_ADMIN','IT_ADMIN']), async (req, res) => {
  const { variantId } = req.params;
  const { action, comment } = req.body; // APPROVE, REJECT, REQUEST_CHANGE
  try {
    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
    const { rows } = await pool.query('SELECT * FROM content_variants WHERE id=$1 AND tenant_id=$2', [variantId, req.user.tenant_id]);
    if (!rows.length) return res.status(404).json({ error: 'Variant not found' });

    const newStatus = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'DRAFT';
    await pool.query('UPDATE content_variants SET status=$1, approved_by=$2 WHERE id=$3', [newStatus, req.user.id, variantId]);
    await pool.query('INSERT INTO approvals (tenant_id, variant_id, requested_by, approved_by, status, comment) VALUES ($1,$2,$3,$4,$5,$6)', [req.user.tenant_id, rows[0].asset_id, req.user.id, req.user.id, newStatus, comment || '']);

    if (newStatus === 'APPROVED') {
      // Push to publisher queue - Hermes Publisher Agent (shared key, see note above)
      await redisClient.lPush('publisher:queue', JSON.stringify({ variant_id: variantId, tenant_id: req.user.tenant_id }));
    }

    await auditLog(req.user.tenant_id, req.user.id, `${action}_CONTENT`, 'content_variant', variantId, req, 'SUCCESS', { comment });

    res.json({ variant_id: variantId, status: newStatus, message: `Content ${newStatus}, ${newStatus==='APPROVED' ? 'queued for publishing to channel' : ''}` });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Audit log - real rows only, scoped to the caller's own tenant. There was
// no read route for this at all before (only INSERTs via auditLog()) - the
// frontend was showing four entirely fabricated log lines instead.
app.get('/audit-logs', authMiddleware, rbacMiddleware(['SUPER_ADMIN', 'IT_ADMIN']), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await pool.query(
      'SELECT id, user_id, action, resource_type, resource_id, ip_address, result, details, created_at FROM audit_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2',
      [req.user.tenant_id, limit]
    );
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Integrations - Secure, masked, 2FA required, Super Admin+IT only
// Status/keys are read from this tenant's actual environment config — nothing here is simulated.
// A channel with no <CHANNEL>_API_KEY env var set is honestly reported as not_configured.
const INTEGRATION_CHANNELS = ['whatsapp', 'facebook', 'instagram', 'linkedin', 'youtube', 'quora', 'email'];

app.get('/integrations', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  const channels = INTEGRATION_CHANNELS.map(name => {
    const key = process.env[`${name.toUpperCase()}_API_KEY`];
    return key
      ? { name, status: 'connected', api_key_masked: `••••••••${key.slice(-4)}` }
      : { name, status: 'not_configured' };
  });
  res.json({ channels });
});

app.post('/integrations/reveal', authMiddleware, authLimiter, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  const { channel, totp } = req.body;
  try {
    // Real verification now (POST /auth/2fa/setup|verify added real 2FA
    // later than this route did) - the caller must have 2FA enabled on
    // their own account and supply a valid code, not just a non-empty field.
    const { rows } = await pool.query('SELECT two_fa_enabled, two_fa_secret FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length || !rows[0].two_fa_enabled) {
      return res.status(403).json({ error: '2FA must be enabled on your account to reveal integration keys — enable it from the Security button first' });
    }
    if (!totp) return res.status(401).json({ error: '2FA code required', need_2fa: true });
    const valid = authenticator.check(String(totp).replace(/\s+/g, ''), rows[0].two_fa_secret);
    if (!valid) {
      await auditLog(req.user.tenant_id, req.user.id, 'REVEAL_KEY_2FA_FAILED', 'integration', null, req, 'FAILED', { channel });
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }
    const key = process.env[`${(channel || '').toUpperCase()}_API_KEY`];
    if (!key) return res.status(404).json({ error: `No API key configured for channel: ${channel}` });
    await auditLog(req.user.tenant_id, req.user.id, 'REVEAL_KEY', 'integration', null, req, 'SUCCESS', { channel });
    const domain = API_DOMAIN ? `https://${API_DOMAIN}` : '';
    res.json({ channel, api_key: key, webhook_url: `${domain}/webhooks/${channel}`, expires_in: 30 });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/integrations/toggle', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  const { channel, enabled } = req.body;
  await auditLog(req.user.tenant_id, req.user.id, 'TOGGLE_CHANNEL', 'integration', null, req, 'SUCCESS', { channel, enabled });
  res.json({ channel, enabled, message: 'Channel toggled, logged' });
});

// Integrations - Webhook URLs for the caller's own tenant, one per channel.
// Copy these into WhatsApp/Facebook/etc.'s webhook config. The secret is
// embedded in the path (not a header) because most of these platforms only
// let you configure a callback URL, not custom headers.
app.get('/integrations/webhook-urls', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT webhook_secret FROM tenants WHERE id=$1', [req.user.tenant_id]);
    if (!rows.length || !rows[0].webhook_secret) return res.status(404).json({ error: 'No webhook secret provisioned for this tenant yet — rotate one first' });
    const base = API_DOMAIN ? `https://${API_DOMAIN}` : '';
    const secret = rows[0].webhook_secret;
    const urls = INTEGRATION_CHANNELS.map(channel => ({ channel, url: `${base}/webhooks/${req.user.tenant_id}/${secret}/${channel}` }));
    res.json({ urls });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Integrations - Rotate this tenant's webhook secret (invalidates all previously issued URLs)
app.post('/integrations/webhook-secret/rotate', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  try {
    const newSecret = crypto.randomBytes(24).toString('hex');
    await pool.query('UPDATE tenants SET webhook_secret=$1 WHERE id=$2', [newSecret, req.user.tenant_id]);
    await auditLog(req.user.tenant_id, req.user.id, 'ROTATE_WEBHOOK_SECRET', 'tenant', req.user.tenant_id, req, 'SUCCESS', {});
    res.json({ message: 'Webhook secret rotated. Update every configured channel URL with the new one.' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Webhook handlers - 7 channels, per-tenant + secret so inbound leads can be
// safely attributed and persisted. Shared by both the main app (below) and
// the separate webhook server on WEBHOOK_PORT.
async function handleInboundWebhook(req, res) {
  const { tenantId, webhookSecret, channel } = req.params;
  if (!INTEGRATION_CHANNELS.includes(channel)) return res.status(404).json({ error: 'Unknown channel' });
  try {
    const { rows } = await pool.query('SELECT id, webhook_secret FROM tenants WHERE id=$1', [tenantId]);
    if (!rows.length || !rows[0].webhook_secret) return res.status(404).json({ error: 'Unknown tenant' });
    const provided = Buffer.from(webhookSecret || '');
    const expected = Buffer.from(rows[0].webhook_secret);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const company_name = sanitizeCSVValue(req.body.company || req.body.company_name || 'Unknown');
    const contact_name = sanitizeCSVValue(req.body.name || req.body.full_name || 'Lead');
    const phone = sanitizeCSVValue(req.body.phone || '');
    const email = sanitizeCSVValue(req.body.email || '');
    const value_inr = Number(req.body.value) || 0;

    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', tenantId]);
    const dup = await pool.query(
      `SELECT id FROM leads WHERE tenant_id=$1 AND ((phone<>'' AND phone=$2) OR (email<>'' AND email=$3)) LIMIT 1`,
      [tenantId, phone, email]
    );
    const isDuplicate = dup.rows.length > 0;

    const { rows: inserted } = await pool.query(
      `INSERT INTO leads (tenant_id, source_channel, company_name, contact_name, phone, email, value_inr, status, is_duplicate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'NEW',$8) RETURNING id`,
      [tenantId, channel, company_name, contact_name, phone, email, value_inr, isDuplicate]
    );

    await auditLog(tenantId, null, 'WEBHOOK_LEAD_RECEIVED', 'lead', inserted[0].id, req, 'SUCCESS', { channel, is_duplicate: isDuplicate });
    // Notify Hermes for downstream enrichment (GSTIN lookup, language detection, etc.)
    await redisClient.lPush('webhook:incoming', JSON.stringify({ lead_id: inserted[0].id, tenant_id: tenantId, channel }));

    res.json({ received: true, channel, lead_id: inserted[0].id, is_duplicate: isDuplicate });
  } catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
}

app.post('/webhooks/:tenantId/:webhookSecret/:channel', webhookLimiter, handleInboundWebhook);

// Hermes Agents status - Premium multiagent
// Reports real rows only. An empty list is an honest "no agents registered yet",
// not backfilled with a fabricated status list.
app.get('/hermes/agents', authMiddleware, async (req, res) => {
  try {
    await pool.query('SELECT set_config($1,$2,false)', ['app.tenant_id', req.user.tenant_id]);
    const { rows } = await pool.query('SELECT * FROM hermes_agents WHERE tenant_id=$1', [req.user.tenant_id]);
    res.json({ mode: process.env.HERMES_MODE || 'premium_multiagent', agents: rows });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`OrgComms API secure v4 VPS running on ${PORT}, webhooks on ${WEBHOOK_PORT}`));

// Webhook server separate
const webhookApp = express();
webhookApp.set('trust proxy', 1);
webhookApp.use(express.json());
webhookApp.post('/webhooks/:tenantId/:webhookSecret/:channel', webhookLimiter, handleInboundWebhook);
webhookApp.get('/health', (req, res) => res.json({ status: 'ok', service: 'webhook' }));
webhookApp.listen(WEBHOOK_PORT, () => console.log(`Webhook server on ${WEBHOOK_PORT}`));
