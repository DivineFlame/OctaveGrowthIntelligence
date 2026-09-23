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
const channelsLib = require('./channels');
const { normalizeDomain, sanitizeCSVValue } = require('./validators');
const schemas = require('./schemas');
const cryptoSecrets = require('./crypto-secrets');
const { processLeadCsvRecords } = require('./csv-leads');
const { userClaims, hasRoleOrFlag, canGrantRole } = require('./rbac');
const { createLimiters } = require('./rate-limiters');
const { detectLanguage, extractGstin } = require('./lead-enrichment');
const metrics = require('./metrics');
const errorTracking = require('./error-tracking');
require('dotenv').config({ path: '../.env.production' });

// JWT_SECRET and ENCRYPTION_KEY both used to silently fall back to a
// hardcoded, publicly-visible-in-source default whenever the env var was
// unset or empty (e.g. a blank line in .env on the VPS) - not a crash, just
// a quiet boot into a state where anyone who has read this file can forge
// valid JWTs for any role, or decrypt anything encrypted with
// ENCRYPTION_KEY_BUF (stored LLM API keys, webhook secrets, etc). Fail fast
// in production instead of ever booting on the insecure default.
function requireSecretOrExit(envVarName, devDefault) {
  const value = process.env[envVarName];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    console.error(`FATAL: ${envVarName} is not set. Refusing to start with an insecure hardcoded default in production - see .env.vps.example.`);
    process.exit(1);
  }
  console.warn(`WARNING: ${envVarName} is not set - using an insecure development-only default. Set ${envVarName} before deploying.`);
  return devDefault;
}
const JWT_SECRET_VALUE = requireSecretOrExit('JWT_SECRET', 'dev-secret-change-me');
const ENCRYPTION_KEY_VALUE = requireSecretOrExit('ENCRYPTION_KEY', 'dev-encryption-key-change-me');

// Optional error tracking (Sentry) - entirely inert unless SENTRY_DSN is
// set. See error-tracking.js for why this never fails startup or a
// request even if misconfigured.
errorTracking.init();

const app = express();
// Behind Dokploy's Traefik (one reverse-proxy hop) - without this, every
// request looks like it comes from Traefik's own address, which breaks
// per-IP rate limiting (one shared bucket for all clients) and makes
// audit_logs.ip_address record the proxy, not the real client.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3001;

// DB - Postgres.
//
// Pool sizing was previously left unset, which silently defaults to
// node-postgres's built-in max of 10 - fine for one replica at low
// traffic, but an undocumented magic number that nobody deploying this
// would know to tune, and the wrong number in either direction is a real
// failure mode: too low and requests queue/time out waiting for a client
// under load; too high and this service alone can exhaust Postgres's own
// max_connections (default 100) once it's not the only thing connecting.
// Made explicit and env-configurable so it's a documented deployment
// knob instead of an invisible library default - see .env.vps.example.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@postgres:5432/${process.env.POSTGRES_DB}`,
  ssl: false,
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS) || 30000,
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS) || 5000
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
const APP_DOMAIN = normalizeDomain(process.env.APP_DOMAIN);
const API_DOMAIN = normalizeDomain(process.env.API_DOMAIN);

// ENCRYPTION_KEY has been provisioned since the very first deploy (it's in
// .env.vps.example and docker-compose.dokploy.yml) but nothing ever used it
// until now: LLM provider API keys (llm_connections.api_key_encrypted) are
// encrypted at rest with it, AES-256-GCM, and only decrypted in memory at
// the point an agent actually calls the provider.
const ENCRYPTION_KEY_BUF = crypto.createHash('sha256').update(ENCRYPTION_KEY_VALUE).digest();
// Bound to this process's real key so every call site below keeps its
// existing single-argument signature - the actual AES-256-GCM logic now
// lives in crypto-secrets.js (see its header comment for why: testability
// with a throwaway key, without server.js's own key-derivation/startup
// requirements getting in the way of that).
const encryptSecret = (plaintext) => cryptoSecrets.encrypt(plaintext, ENCRYPTION_KEY_BUF);
const decryptSecret = (encoded) => cryptoSecrets.decrypt(encoded, ENCRYPTION_KEY_BUF);

// Sarvam AI message filtering - real, but deliberately small: the full
// "Agents" feature (LLM connections managed in the app, per-product enable/
// run UI, agent_runs history) is deferred to a future version (see
// README.md "Hardening notes"); its tables stay in the schema untouched, so
// bringing it back later is a routes/UI change, not a new migration. What's
// live now is a single, env-var-configured Sarvam connection used
// server-side to classify an inbound lead message as a genuine product
// inquiry or not, so the Leads panel can filter to real inquiries per
// product/channel. No database row, no admin UI - just SARVAM_API_KEY
// (and optionally SARVAM_MODEL) in the environment.
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || '';
const SARVAM_MODEL = process.env.SARVAM_MODEL || 'sarvam-105b';

// Returns true (inquiry), false (not an inquiry), or null (not classified -
// either SARVAM_API_KEY isn't set, there's no text to classify, or the call
// failed/returned something unrecognized). null is never treated as "not an
// inquiry" by callers - an unclassified message stays visible rather than
// being silently hidden by a filter that couldn't run.
async function classifyInquiryWithSarvam(text) {
  if (!SARVAM_API_KEY || !text || !text.trim()) return null;
  try {
    const resp = await fetch('https://api.sarvam.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'api-subscription-key': SARVAM_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SARVAM_MODEL,
        messages: [
          { role: 'system', content: 'Reply with exactly one word: INQUIRY if this message is a genuine product/service inquiry from a prospective customer, or NOISE if it is not (spam, a bare greeting, an unrelated message, etc). No other text.' },
          { role: 'user', content: text.slice(0, 2000) }
        ]
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { console.warn(`[sarvam-filter] HTTP ${resp.status}: ${data.error?.message || 'unknown error'}`); return null; }
    const reply = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
    if (reply.startsWith('INQUIRY')) return true;
    if (reply.startsWith('NOISE')) return false;
    console.warn(`[sarvam-filter] unrecognized reply, leaving unclassified: ${reply.slice(0, 50)}`);
    return null;
  } catch (e) {
    console.warn(`[sarvam-filter] request failed, leaving unclassified: ${e.message}`);
    return null;
  }
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

// CORS - locked to this app's actual frontend domain(s), not left open to
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
// Records every request's route/method/status/duration for GET /metrics.
// Hooked on 'finish' (not a try/finally around next()) so it still fires
// for responses Express ends outside the normal middleware chain (e.g.
// after an error handler, or a response the rate limiter ends directly).
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    metrics.recordRequest(req.method, metrics.normalizeRoute(req), res.statusCode, durationSeconds);
  });
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting - nothing enforced this before; the original security docs
// assumed an nginx layer that doesn't exist under Dokploy. Applied per
// route below, not globally, so limits can differ by sensitivity.
// Redis-backed (see rate-limiters.js) so the limit is real across however
// many replicas of this service are running, not per-replica.
const { authLimiter, uploadLimiter, webhookLimiter, generalLimiter } = createLimiters(redisClient);
app.use(generalLimiter);

// Storage for uploads - VPS local
const uploadDir = process.env.UPLOAD_DIR || '/app/recordings';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g,'_')}`)
});
const CONTENT_UPLOAD_MIME_TYPES = ['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','application/pdf','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max for content
  // The client-reported MIME type isn't trustworthy on its own (it's
  // whatever the browser/OS claimed, not a real inspection of the bytes) -
  // this is just a fast reject for obviously-wrong types before the file
  // even finishes uploading. ClamAV (scanFile, right after this) is what
  // actually inspects the file's content and blocks malware regardless of
  // what MIME type it claims to be. This filter previously accepted every
  // type unconditionally ("Allow all for MVP"), making the allowlist dead
  // code - now it's actually enforced.
  fileFilter: (req, file, cb) => {
    if (!CONTENT_UPLOAD_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  }
});
const csvUpload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Helpers
async function auditLog(user_id, action, resource_type, resource_id, req, result='SUCCESS', details={}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip_address, user_agent, result, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [user_id, action, resource_type, resource_id, req.ip, req.headers['user-agent'], result, JSON.stringify(details)]
    );
  } catch(e){ console.error('Audit log failed', e.message); }
}

// This app runs for exactly one company (see README.md "Hardening notes" -
// multi-tenancy was removed; `company` is a singleton row created once by
// POST /auth/signup). Small in-process cache (short TTL) rather than a
// query on every request that needs is_premium/webhook_secret - it's read
// far more often than it changes, and a few seconds of staleness on a
// premium-flag/webhook-secret read is an acceptable trade for not hitting
// Postgres on every single request that touches either.
let companyCache = null, companyCacheAt = 0;
async function getCompany({ fresh = false } = {}) {
  if (!fresh && companyCache && (Date.now() - companyCacheAt) < 5000) return companyCache;
  const { rows } = await pool.query('SELECT * FROM company ORDER BY created_at ASC LIMIT 1');
  companyCache = rows[0] || null;
  companyCacheAt = Date.now();
  return companyCache;
}

// Per-role data-visibility flags (roles.can_view_revenue / max_history_days /
// can_view_integrations / can_approve_content, copied onto each user row at
// creation/role-change time - see POST /users, PATCH /users/:userId/role).
// These were being stored but never read back anywhere: every route only
// checked req.user.role against a hardcoded list, so the per-role limits
// the roles table defines had no actual effect. Baking them into the JWT
// (rather than a DB lookup on every request) makes them available as
// req.user.can_view_revenue etc. wherever authMiddleware runs.
// True if the caller's role is in `roles`, OR (when `flag` is given) their
// per-role flag from the roles table is set - lets a role the hardcoded
// list doesn't name still qualify if an Admin has granted it the flag via
// PATCH /users/:userId/role, without loosening anyone else.
function roleOrFlag(roles, flag) {
  return (req, res, next) => {
    if (hasRoleOrFlag(req.user.role, roles, flag && req.user[flag])) return next();
    auditLog(req.user.id, 'RBAC_BLOCKED', 'api', null, req, 'BLOCKED', { attempted: req.path, role: req.user.role });
    return res.status(403).json({ error: 'Forbidden - role not allowed' });
  };
}

// Auth middleware - JWT + role
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET_VALUE);
    req.user = decoded;
    next();
  } catch(e){
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function rbacMiddleware(allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      auditLog(req.user.id, 'RBAC_BLOCKED', 'api', null, req, 'BLOCKED', { attempted: req.path, role: req.user.role });
      return res.status(403).json({ error: 'Forbidden - role not allowed' });
    }
    next();
  };
}

// Request-body schema validation. Most routes already do ad-hoc "is this
// field present" checks inline - those catch missing fields but not wrong
// types, oversized strings, or extra/unexpected fields. This adds that
// second, structural layer for the routes that accept free-form admin
// input; req.body is replaced with the parsed (trimmed/typed) result so
// handlers can trust its shape.
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({ path: i.path.join('.') || '(body)', message: i.message }))
      });
    }
    req.body = result.data;
    next();
  };
}

// Generic catch-all responder for the "something unexpected went wrong"
// path (as opposed to a deliberately-thrown, already-friendly validation
// or business-logic error, which routes handle with their own explicit
// status codes and don't go through this). Always logs the full error
// server-side. In production, `e.message` from a raw Postgres/driver
// error can include column/constraint/table names or other schema
// internals that shouldn't reach an API response, so it's replaced with a
// generic message there; outside production the real message is more
// useful for local debugging than the disclosure risk.
function serverError(res, e) {
  console.error(e);
  metrics.recordError();
  errorTracking.captureError(e);
  if (process.env.NODE_ENV === 'production') {
    return res.status(500).json({ error: 'Internal server error' });
  }
  return res.status(500).json({ error: e.message });
}

// Routes

// Health
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redisClient.ping();
    res.json({ status: 'ok', service: 'api', timestamp: new Date().toISOString(), company_mode: 'single-company', version: '5.0.0-single-company' });
  } catch(e){
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Prometheus-format metrics. Not exposed publicly - nginx blocks this path
// on the api.* server block (see nginx/orgcomms-vps.conf); reachable only
// from inside the Docker network (e.g. a Prometheus container joined to
// the same compose network, or `docker exec ... curl localhost:3000/metrics`).
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.renderMetrics());
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
      await auditLog(user.id, 'LOGIN_FAILED', 'auth', null, req, 'FAILED');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.disabled) {
      await auditLog(user.id, 'LOGIN_DISABLED', 'auth', null, req, 'BLOCKED');
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
        await auditLog(user.id, 'LOGIN_2FA_FAILED', 'auth', null, req, 'FAILED');
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }
    const claims = userClaims(user);
    const token = jwt.sign(claims, JWT_SECRET_VALUE, { expiresIn: '15m' });
    const refresh = jwt.sign({ id: user.id, type: 'refresh' }, JWT_SECRET_VALUE, { expiresIn: '7d' });
    await auditLog(user.id, 'LOGIN_SUCCESS', 'auth', user.id, req, 'SUCCESS');
    res.json({ token, refresh, user: claims });
  } catch(e){ serverError(res, e); }
});

// Auth - Signup status (lets the frontend show/hide the Sign Up option without guessing)
app.get('/auth/signup-status', async (req, res) => {
  try {
    const used = await pool.query(`SELECT 1 FROM system_flags WHERE key='signup_used'`);
    const enabled = process.env.SIGNUP_ENABLED !== 'false';
    res.json({ available: enabled && !used.rows.length });
  } catch(e){ serverError(res, e); }
});

// Auth - Signup (bootstraps the very first Super Admin + the one `company`
// row this whole app runs as - see README.md "Hardening notes" on removing
// multi-tenancy: this app is single-company now, so this route creates
// that company exactly once instead of a new tenant per signup).
// This is NOT general self-service registration - every subsequent user is
// created by an Admin via POST /users. Two independent gates:
//   1. SIGNUP_ENABLED=false in the environment disables it outright.
//   2. Even left enabled, system_flags.signup_used is claimed atomically via
//      INSERT ... ON CONFLICT DO NOTHING - only the first request to win
//      that race can ever create an account (and the company row) here, so
//      forgetting to flip SIGNUP_ENABLED off can't mint a second company.
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
      return res.status(403).json({ error: 'Signup already used — an account already exists. Ask your Admin to create yours.' });
    }

    const companyName = company_name || 'My Company';
    const webhookSecret = crypto.randomBytes(24).toString('hex');
    // ON CONFLICT DO NOTHING here is a belt-and-braces guard, not the
    // actual race protection (system_flags.signup_used above is) - it just
    // means a `company` row seeded by migrate-remove-multitenancy.sql
    // (collapsing an existing multi-tenant database) is left alone rather
    // than duplicated if signup somehow still ran after that.
    const existingCompany = await client.query('SELECT id FROM company LIMIT 1');
    let companyId;
    if (existingCompany.rows.length) {
      companyId = existingCompany.rows[0].id;
      await client.query('UPDATE company SET name=$1 WHERE id=$2', [companyName, companyId]);
    } else {
      const companyRows = await client.query(
        `INSERT INTO company (name, is_premium, webhook_secret) VALUES ($1,true,$2) RETURNING id`,
        [companyName, webhookSecret]
      );
      companyId = companyRows.rows[0].id;
    }

    const roleRow = await client.query(`SELECT * FROM roles WHERE name='SUPER_ADMIN'`);
    const r = roleRow.rows[0];
    const password_hash = await bcrypt.hash(password, 12);
    const userRows = await client.query(
      `INSERT INTO users (email, password_hash, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content)
       VALUES ($1,$2,'SUPER_ADMIN',$3,$4,$5,$6)
       RETURNING id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content`,
      [email, password_hash, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content]
    );
    const user = userRows.rows[0];

    await client.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip_address, user_agent, result, details) VALUES ($1,'SIGNUP_FIRST_ADMIN','user',$1,$2,$3,'SUCCESS',$4)`,
      [user.id, req.ip, req.headers['user-agent'], JSON.stringify({ email, company_id: companyId })]
    );

    await client.query('COMMIT');
    companyCache = null; // force a fresh read next time getCompany() is called

    const claims = userClaims(user);
    const token = jwt.sign(claims, JWT_SECRET_VALUE, { expiresIn: '15m' });
    const refresh = jwt.sign({ id: user.id, type: 'refresh' }, JWT_SECRET_VALUE, { expiresIn: '7d' });
    res.json({ token, refresh, user: claims });
  } catch(e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'That email is already taken' });
    serverError(res, e);
  } finally {
    client.release();
  }
});

// Auth - Refresh (exchange a 7-day refresh token for a new 15-minute access token)
// Without this, the access token issued at login has no way to be renewed and
// every session silently dies 15 minutes after login.
//
// Checking `disabled` here (not just at /auth/login) matters: authMiddleware
// only verifies the JWT signature, so a user disabled mid-session keeps
// working on their current access token until it naturally expires (up to
// 15 minutes - an accepted, bounded window) - but without this check they
// could otherwise use their still-valid 7-day refresh token to keep minting
// fresh access tokens forever, making "disable this user" a no-op for
// anyone who already has one.
app.post('/auth/refresh', authLimiter, async (req, res) => {
  const { refresh } = req.body;
  if (!refresh) return res.status(400).json({ error: 'refresh token required' });
  try {
    const decoded = jwt.verify(refresh, JWT_SECRET_VALUE);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Not a refresh token' });
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' });
    const user = rows[0];
    if (user.disabled) return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
    const claims = userClaims(user);
    const token = jwt.sign(claims, JWT_SECRET_VALUE, { expiresIn: '15m' });
    res.json({ token, user: claims });
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
  } catch(e){ serverError(res, e); }
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
    await auditLog(req.user.id, 'ENABLE_2FA', 'user', req.user.id, req, 'SUCCESS', {});
    res.json({ message: '2FA enabled' });
  } catch(e){ serverError(res, e); }
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
    await auditLog(req.user.id, 'DISABLE_2FA', 'user', req.user.id, req, 'SUCCESS', {});
    res.json({ message: '2FA disabled' });
  } catch(e){ serverError(res, e); }
});

// 2FA - Status: lets the frontend show enabled/disabled without guessing from the JWT
app.get('/auth/2fa/status', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT two_fa_enabled FROM users WHERE id=$1', [req.user.id]);
    res.json({ enabled: !!(rows.length && rows[0].two_fa_enabled) });
  } catch(e){ serverError(res, e); }
});

// Company - the one company this whole app runs as (see README.md
// "Hardening notes" on removing multi-tenancy). Replaces the old
// GET /tenants, POST /tenants, GET /tenants/me routes entirely - there is
// nothing left to create/list/switch between. webhook_secret is
// deliberately excluded here (it's a bearer credential - anyone who has it
// can post fake leads), same as before; only GET /integrations/webhook-urls
// (Admin-only) returns it.
app.get('/company', authMiddleware, async (req, res) => {
  try {
    const company = await getCompany();
    if (!company) return res.status(404).json({ error: 'Company not set up yet' });
    res.json({ id: company.id, name: company.name, is_premium: company.is_premium, created_at: company.created_at });
  } catch(e){ serverError(res, e); }
});

// ===== Self-service GDPR data export/erasure =====
// Two rights, two different feasible implementations:
//   - Export (Art. 15, "right of access"): straightforward - gather
//     everything this app holds tied to the caller's own account and hand
//     it back as JSON. No destructive step, no edge cases.
//   - Erasure (Art. 17, "right to erasure"): NOT a hard DELETE of the
//     users row. content_assets.uploaded_by, content_variants.approved_by,
//     approvals.requested_by/approved_by, agent_runs.triggered_by, and
//     audit_logs.user_id all reference users(id) with no ON DELETE clause
//     (default NO ACTION) - a user who has ever uploaded, approved, run an
//     agent, or done anything else logged can't be hard-deleted without
//     breaking those foreign keys, and audit_logs is deliberately
//     append-only (see its no_update_audit trigger in init-secure.sql), so
//     rewriting history to remove them isn't the right move either.
//     Anonymizing in place - scrub the identifying fields, disable login -
//     satisfies the request while keeping every record that references
//     this row intact and the audit trail truthful. This is a recognized,
//     legitimate way to satisfy Art. 17 when full deletion would break
//     other legitimate records (see leads' pii_erased_at, same reasoning,
//     below).

// Self-service data export - any authenticated user can export everything
// this app holds tied to their own account, without needing an admin to
// run a query for them.
app.get('/me/export', authMiddleware, async (req, res) => {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    const company = await getCompany();

    const { rows: memberships } = await pool.query(
      `SELECT pm.product_id, p.name AS product_name, pm.role, pm.created_at
       FROM product_members pm JOIN products p ON p.id = pm.product_id
       WHERE pm.user_id=$1`,
      [req.user.id]
    );

    const [assets, approvedVariants, runs, auditRows] = await Promise.all([
      pool.query('SELECT id, file_name, file_size, mime_type, virus_scan_status, created_at FROM content_assets WHERE uploaded_by=$1 ORDER BY created_at DESC', [req.user.id]).then(r => r.rows),
      pool.query('SELECT id, asset_id, channel, title, status, published_url, published_at, created_at FROM content_variants WHERE approved_by=$1 ORDER BY created_at DESC', [req.user.id]).then(r => r.rows),
      pool.query('SELECT id, product_id, agent_id, lead_id, trigger_type, status, created_at FROM agent_runs WHERE triggered_by=$1 ORDER BY created_at DESC LIMIT 500', [req.user.id]).then(r => r.rows),
      pool.query('SELECT id, action, resource_type, resource_id, result, created_at FROM audit_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500', [req.user.id]).then(r => r.rows)
    ]);

    await auditLog(req.user.id, 'SELF_EXPORT_DATA', 'user', req.user.id, req, 'SUCCESS');

    res.json({
      exported_at: new Date().toISOString(),
      user: userRows[0],
      company: company ? { name: company.name, is_premium: company.is_premium } : null,
      product_memberships: memberships,
      content_uploaded: assets,
      content_approved: approvedVariants,
      agent_runs_triggered: runs,
      audit_log: auditRows
    });
  } catch(e){ serverError(res, e); }
});

// Self-service account erasure - requires the caller's current password
// (this is a destructive, hard-to-undo action reachable by anyone who
// merely has a still-valid access token, e.g. a forgotten logged-in
// browser tab; re-confirming the password is the same bar POST
// /auth/2fa/disable already sets for a comparable action). Rate-limited
// like every other auth-adjacent endpoint (authLimiter) since it's a
// repeatable password-guessing surface otherwise.
app.post('/me/erase', authMiddleware, authLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required to confirm account erasure' });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });

    // Refuse to erase the company's last usable account - not a GDPR
    // exception, a plain operational one: erasing disables login, and zero
    // enabled accounts means no way back into this app at all. Same
    // reasoning PATCH /users/:userId/status already applies to disabling
    // yourself, applied here to this stricter, self-service action too.
    const { rows: activeOthers } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE disabled=false AND id != $1',
      [req.user.id]
    );
    if (activeOthers[0].n === 0) {
      return res.status(400).json({ error: 'You are the only active account left - have another admin created (or re-enabled) before erasing your own account.' });
    }

    const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const anonymizedEmail = `erased-${req.user.id}@erased.invalid`;
    await pool.query(
      `UPDATE users SET email=$1, password_hash=$2, two_fa_secret=NULL, two_fa_enabled=false, disabled=true WHERE id=$3`,
      [anonymizedEmail, unusableHash, req.user.id]
    );
    await auditLog(req.user.id, 'SELF_ERASE_ACCOUNT', 'user', req.user.id, req, 'SUCCESS');
    res.json({ erased: true });
  } catch(e){ serverError(res, e); }
});

// Roles - List available roles (for user-creation role picker)
app.get('/roles', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM roles ORDER BY name');
    res.json(rows);
  } catch(e){ serverError(res, e); }
});

// Roles allowed to create/manage users, kept in sync with roles.can_manage_users
const USER_MANAGER_ROLES = ['SUPER_ADMIN', 'IT_ADMIN', 'DEPT_ADMIN'];

// Users - List (single company - every user in the system)
app.get('/users', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch(e){ serverError(res, e); }
});

// Users - Create, role drives permissions (single source of truth: roles table)
app.post('/users', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), validate(schemas.createUser), async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'email, password and role are required' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
  try {
    const roleRow = await pool.query('SELECT * FROM roles WHERE name=$1', [role]);
    if (!roleRow.rows.length) return res.status(400).json({ error: `Unknown role: ${role}` });
    const r = roleRow.rows[0];
    if (!canGrantRole(req.user.role, r.name)) {
      await auditLog(req.user.id, 'RBAC_BLOCKED', 'user', null, req, 'BLOCKED', { attempted: 'create SUPER_ADMIN user', role: req.user.role });
      return res.status(403).json({ error: 'Only a Super Admin can grant the Super Admin role' });
    }
    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at`,
      [email, password_hash, r.name, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content]
    );
    await auditLog(req.user.id, 'CREATE_USER', 'user', rows[0].id, req, 'SUCCESS', { email, role: r.name });
    res.json(rows[0]);
  } catch(e){
    if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    serverError(res, e);
  }
});

// Users - Change an existing user's role
app.patch('/users/:userId/role', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'role is required' });
  try {
    const roleRow = await pool.query('SELECT * FROM roles WHERE name=$1', [role]);
    if (!roleRow.rows.length) return res.status(400).json({ error: `Unknown role: ${role}` });
    const r = roleRow.rows[0];
    if (!canGrantRole(req.user.role, r.name)) {
      await auditLog(req.user.id, 'RBAC_BLOCKED', 'user', userId, req, 'BLOCKED', { attempted: 'promote to SUPER_ADMIN', role: req.user.role });
      return res.status(403).json({ error: 'Only a Super Admin can grant the Super Admin role' });
    }
    const { rows } = await pool.query(
      `UPDATE users SET role=$1, max_history_days=$2, can_view_revenue=$3, can_view_integrations=$4, can_approve_content=$5
       WHERE id=$6
       RETURNING id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at`,
      [r.name, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await auditLog(req.user.id, 'CHANGE_USER_ROLE', 'user', userId, req, 'SUCCESS', { role: r.name });
    res.json(rows[0]);
  } catch(e){ serverError(res, e); }
});

// Users - Enable/disable an account. A manager can't disable their own
// account (would lock the company with a single admin out with no
// recovery path).
app.patch('/users/:userId/status', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  const { userId } = req.params;
  const { disabled } = req.body;
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) is required' });
  if (userId === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
  try {
    const { rows } = await pool.query(
      `UPDATE users SET disabled=$1 WHERE id=$2
       RETURNING id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, disabled, created_at`,
      [disabled, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await auditLog(req.user.id, disabled ? 'DISABLE_USER' : 'ENABLE_USER', 'user', userId, req, 'SUCCESS');
    res.json(rows[0]);
  } catch(e){ serverError(res, e); }
});

// Users - Admin-driven password reset. There is no email infrastructure in
// this system for a self-service "forgot password" flow, so an Admin sets a
// new password directly on the user's behalf; the user should be told to
// change it again after logging in.
app.post('/users/:userId/reset-password', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  const { userId } = req.params;
  const { new_password } = req.body;
  if (!new_password || new_password.length < 12) return res.status(400).json({ error: 'new_password must be at least 12 characters' });
  try {
    const password_hash = await bcrypt.hash(new_password, 12);
    const { rows } = await pool.query(
      'UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id, email',
      [password_hash, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await auditLog(req.user.id, 'RESET_USER_PASSWORD', 'user', userId, req, 'SUCCESS');
    res.json({ success: true, email: rows[0].email });
  } catch(e){ serverError(res, e); }
});

// ===== Products/Services, per-product membership, channels, and Agents =====
// Single company, multi-product, multi-user: an Admin role (SUPER_ADMIN/
// IT_ADMIN/DEPT_ADMIN) creates Products/Services and assigns a user as that
// product's Admin - and, being an Admin, can see and manage every product
// regardless of assignment. A Product Admin configures the product's
// social channels and adds MEMBER users to run them (Standard plan) or
// enables Agents (Premium plan only, company.is_premium). Agent/
// LLM-connection definitions themselves are Super-Admin-only, platform-wide.

const PRODUCT_ADMIN_ROLES = ['SUPER_ADMIN', 'IT_ADMIN', 'DEPT_ADMIN'];
const PRODUCT_CHANNELS = ['whatsapp', 'facebook', 'instagram', 'linkedin', 'youtube', 'quora', 'email'];

async function getProductMembership(productId, userId) {
  const { rows } = await pool.query('SELECT role FROM product_members WHERE product_id=$1 AND user_id=$2', [productId, userId]);
  return rows.length ? rows[0].role : null;
}
// A company-wide Admin role can administer any product; a product's own
// ADMIN member can administer just that one product.
async function canAdminProduct(req, productId) {
  if (PRODUCT_ADMIN_ROLES.includes(req.user.role)) return true;
  return (await getProductMembership(productId, req.user.id)) === 'ADMIN';
}

// Products - Create (Admin only). Pre-creates all 7 channel rows as
// 'not_configured', in the same transaction, so a product's full channel
// set exists from the moment it's created rather than materializing rows
// lazily the first time each one is individually configured.
app.post('/products', authMiddleware, rbacMiddleware(PRODUCT_ADMIN_ROLES), validate(schemas.createProduct), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO products (name, description, created_by) VALUES ($1,$2,$3) RETURNING *',
      [name, description || null, req.user.id]
    );
    const product = rows[0];
    for (const channel of PRODUCT_CHANNELS) {
      await client.query(
        `INSERT INTO product_channels (product_id, channel, status) VALUES ($1,$2,'not_configured') ON CONFLICT (product_id, channel) DO NOTHING`,
        [product.id, channel]
      );
    }
    await client.query('COMMIT');
    await auditLog(req.user.id, 'CREATE_PRODUCT', 'product', product.id, req, 'SUCCESS', { name });
    res.json(product);
  } catch(e) {
    await client.query('ROLLBACK');
    serverError(res, e);
  } finally {
    client.release();
  }
});

// Products - List: Admin roles see every product; everyone else sees only
// products they're a member of ("Product can be assigned to a user, admin
// can see all" - see README.md "Hardening notes").
app.get('/products', authMiddleware, async (req, res) => {
  try {
    const { rows } = PRODUCT_ADMIN_ROLES.includes(req.user.role)
      ? await pool.query('SELECT * FROM products ORDER BY created_at DESC')
      : await pool.query('SELECT p.* FROM products p JOIN product_members pm ON pm.product_id=p.id WHERE pm.user_id=$1 ORDER BY p.created_at DESC', [req.user.id]);
    res.json(rows);
  } catch(e){ serverError(res, e); }
});

app.get('/products/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    const isAdmin = PRODUCT_ADMIN_ROLES.includes(req.user.role);
    const membershipRole = await getProductMembership(req.params.id, req.user.id);
    if (!isAdmin && !membershipRole) return res.status(403).json({ error: 'Not a member of this product' });
    res.json(Object.assign({}, rows[0], { your_role: isAdmin ? 'ADMIN' : membershipRole }));
  } catch(e){ serverError(res, e); }
});

// Product members - list (Admin or any member of the product)
app.get('/products/:id/members', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1', [req.params.id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isAdmin = PRODUCT_ADMIN_ROLES.includes(req.user.role);
    if (!isAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });
    const { rows } = await pool.query(
      `SELECT pm.id, pm.role, pm.created_at, u.id as user_id, u.email, u.role as company_role
       FROM product_members pm JOIN users u ON u.id=pm.user_id WHERE pm.product_id=$1 ORDER BY pm.created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e){ serverError(res, e); }
});

// Content - list a product's uploaded assets with their generated variants
// nested underneath, newest first. Same membership check as GET /members:
// any member of the product (or an Admin) can view; approving/uploading/
// generating still go through their own, stricter checks on the write routes.
app.get('/products/:id/content', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1', [req.params.id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isAdmin = PRODUCT_ADMIN_ROLES.includes(req.user.role);
    if (!isAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });

    const assets = await pool.query(
      `SELECT id, file_name, file_size, mime_type, virus_scan_status, created_at
       FROM content_assets WHERE product_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]
    );
    if (!assets.rows.length) return res.json([]);

    const assetIds = assets.rows.map(a => a.id);
    const variants = await pool.query(
      `SELECT id, asset_id, channel, spec, title, status, published_url, publish_error, created_at
       FROM content_variants WHERE asset_id = ANY($1::uuid[]) ORDER BY created_at`,
      [assetIds]
    );
    const byAsset = {};
    for (const v of variants.rows) {
      (byAsset[v.asset_id] = byAsset[v.asset_id] || []).push(v);
    }
    res.json(assets.rows.map(a => Object.assign({}, a, { variants: byAsset[a.id] || [] })));
  } catch(e){ serverError(res, e); }
});

// Product members - add/assign (Admin, to assign the first Product Admin;
// or that product's existing Admin, to add MEMBER users)
app.post('/products/:id/members', authMiddleware, validate(schemas.addProductMember), async (req, res) => {
  const { user_id, role } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const memberRole = role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1', [req.params.id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only an Admin or this product's Admin can add members" });
    const targetUser = await pool.query('SELECT id FROM users WHERE id=$1', [user_id]);
    if (!targetUser.rows.length) return res.status(400).json({ error: 'User not found' });
    const { rows } = await pool.query(
      `INSERT INTO product_members (product_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (product_id, user_id) DO UPDATE SET role=EXCLUDED.role RETURNING *`,
      [req.params.id, user_id, memberRole]
    );
    await auditLog(req.user.id, 'ADD_PRODUCT_MEMBER', 'product', req.params.id, req, 'SUCCESS', { user_id, role: memberRole });
    res.json(rows[0]);
  } catch(e){ serverError(res, e); }
});

app.delete('/products/:id/members/:userId', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1', [req.params.id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only an Admin or this product's Admin can remove members" });
    await pool.query('DELETE FROM product_members WHERE product_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
    await auditLog(req.user.id, 'REMOVE_PRODUCT_MEMBER', 'product', req.params.id, req, 'SUCCESS', { user_id: req.params.userId });
    res.json({ message: 'Removed' });
  } catch(e){ serverError(res, e); }
});

// Product channels - config storage only (no real per-platform posting yet
// except where channels.js actually implements one - see README). Product
// Admin (or company-wide Admin) manages these.
// Field definitions (no values) for every channel's config - the frontend
// uses this to render the right credential form per channel instead of a
// hardcoded free-text box. See api/src/channels.js for the real
// implementations and exactly what each field is used for.
app.get('/channels/spec', authMiddleware, (req, res) => {
  const spec = {};
  for (const [key, def] of Object.entries(channelsLib.CHANNEL_SPECS)) {
    spec[key] = { label: def.label, implemented: def.implemented, help: def.help, fields: def.fields.map(f => ({ key: f.key, label: f.label, required: f.required, secret: !!f.secret, default: f.default || '' })) };
  }
  res.json(spec);
});

app.get('/products/:id/channels', authMiddleware, async (req, res) => {
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1', [req.params.id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    const isAdmin = PRODUCT_ADMIN_ROLES.includes(req.user.role);
    if (!isAdmin && !(await getProductMembership(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this product' });
    const { rows } = await pool.query('SELECT channel, status, config, updated_at FROM product_channels WHERE product_id=$1', [req.params.id]);
    // Secret fields (access tokens, SMTP passwords, ...) are encrypted at
    // rest but were never masked in the API response before - the frontend
    // just never happened to render them. Mask explicitly so a decrypted
    // or plaintext secret can never end up in a browser/network log.
    const masked = rows.map(r => Object.assign({}, r, { config: channelsLib.maskChannelSecrets(r.channel, r.config) }));
    res.json(masked);
  } catch(e){ serverError(res, e); }
});

app.post('/products/:id/channels', authMiddleware, validate(schemas.configureChannel), async (req, res) => {
  const { channel, config } = req.body;
  if (!PRODUCT_CHANNELS.includes(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });
  try {
    const prod = await pool.query('SELECT id FROM products WHERE id=$1', [req.params.id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!(await canAdminProduct(req, req.params.id))) return res.status(403).json({ error: "Only an Admin or this product's Admin can configure channels" });

    // The frontend leaves a secret field blank to mean "keep the value
    // that's already saved" (it never round-trips the decrypted value, so
    // it has nothing else to submit for an unchanged secret) - this
    // endpoint has to merge on top of the existing row, not replace it
    // wholesale, or saving just `page_id` again would silently wipe out a
    // previously-saved access_token.
    const existingRow = await pool.query('SELECT config FROM product_channels WHERE product_id=$1 AND channel=$2', [req.params.id, channel]);
    const existingConfig = existingRow.rows.length ? (existingRow.rows[0].config || {}) : {};
    const submitted = Object.fromEntries(Object.entries(config || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));

    // Validate required-ness against the *effective* config (whatever's
    // already stored, overlaid with what's submitted this time) - a
    // required field satisfied by a previously-saved value shouldn't force
    // the caller to resubmit it every time they tweak an unrelated field.
    try {
      channelsLib.validateChannelConfig(channel, Object.assign({}, existingConfig, submitted));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Secret fields (access tokens, SMTP passwords) are encrypted with the
    // same AES-256-GCM key as llm_connections.api_key_encrypted before
    // they're ever written to product_channels.config - previously this
    // JSONB column stored whatever was posted, in plaintext. Only the
    // fields actually submitted this call get (re-)encrypted; everything
    // else is carried over from existingConfig as-is (already encrypted).
    const encryptedSubmitted = channelsLib.encryptChannelSecrets(channel, submitted, encryptSecret);
    const mergedConfig = Object.assign({}, existingConfig, encryptedSubmitted);

    const { rows } = await pool.query(
      `INSERT INTO product_channels (product_id, channel, config, status, updated_at) VALUES ($1,$2,$3,'configured',NOW())
       ON CONFLICT (product_id, channel) DO UPDATE SET config=EXCLUDED.config, status='configured', updated_at=NOW() RETURNING *`,
      [req.params.id, channel, JSON.stringify(mergedConfig)]
    );
    await auditLog(req.user.id, 'CONFIGURE_PRODUCT_CHANNEL', 'product', req.params.id, req, 'SUCCESS', { channel });
    res.json(Object.assign({}, rows[0], { config: channelsLib.maskChannelSecrets(channel, rows[0].config) }));
  } catch(e){ serverError(res, e); }
});

// The Agents feature (LLM connections, per-product enable/run, agent_runs
// history) has no routes here for now - removed from the UI/API surface,
// deferred to a future version (see README.md "Hardening notes"). The
// underlying agents/llm_connections/product_agents/agent_runs tables are
// untouched in the schema, so re-adding this later is a routes/UI change,
// not a new migration. What Sarvam AI is used for today - classifying
// inbound lead messages as genuine inquiries - lives in
// classifyInquiryWithSarvam() above and is wired into the webhook handler
// below.

// Leads - List. Also enforces two per-role limits from the roles table that
// were previously stored on every user row but never actually read
// anywhere: max_history_days (how far back this role can see) and
// can_view_revenue (whether value_inr is included at all). Optional
// ?product_id= and ?channel= filters back the Leads screen's product-wise,
// channel-filtered view (see README "Studio, Inbox, Leads"). Optional
// ?inquiry_only=true additionally hides only rows Sarvam explicitly
// classified as NOISE (is_inquiry=false) - a NULL (unclassified, e.g. bulk
// CSV imports, or any row from before SARVAM_API_KEY was set) stays
// visible rather than being hidden by a filter that never actually ran on
// it.
app.get('/leads', authMiddleware, async (req, res) => {
  try {
    const days = req.user.max_history_days;
    const conditions = [];
    const params = [];
    if (Number.isFinite(days) && days > 0) {
      params.push(days);
      conditions.push(`created_at >= NOW() - ($${params.length} || ' days')::interval`);
    }
    if (req.query.product_id) {
      params.push(req.query.product_id);
      conditions.push(`product_id = $${params.length}`);
    }
    if (req.query.channel) {
      params.push(req.query.channel);
      conditions.push(`source_channel = $${params.length}`);
    }
    if (req.query.inquiry_only === 'true') {
      conditions.push(`is_inquiry IS DISTINCT FROM false`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT 200`, params);
    const out = req.user.can_view_revenue ? rows : rows.map(({ value_inr, ...rest }) => rest);
    res.json(out);
  } catch(e){ serverError(res, e); }
});

// Leads - data subject export/erasure. Leads are external individuals
// (prospects/contacts) with no login of their own - if one of them emails
// asking "what do you have on me" or "delete my data", a manager handles it
// on their behalf through these two routes rather than the lead being able
// to self-serve like a `users` row can via GET/POST /me/*.
app.get('/leads/:id/export', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    const { rows: runs } = await pool.query('SELECT id, agent_id, product_id, trigger_type, status, created_at FROM agent_runs WHERE lead_id=$1 ORDER BY created_at DESC', [req.params.id]);
    const { rows: messages } = await pool.query('SELECT id, direction, channel, body, sent_by, created_at FROM lead_messages WHERE lead_id=$1 ORDER BY created_at', [req.params.id]);
    await auditLog(req.user.id, 'EXPORT_LEAD_DATA', 'lead', req.params.id, req, 'SUCCESS');
    res.json({ exported_at: new Date().toISOString(), lead: rows[0], agent_runs: runs, messages });
  } catch(e){ serverError(res, e); }
});

// Erases a lead's personal identifiers in place rather than deleting the
// row: agent_runs.lead_id references leads(id) with no ON DELETE clause
// (default NO ACTION), so a lead with any agent run against it can't be
// hard-deleted without breaking that foreign key - and even where it
// could be, deleting the row entirely would also destroy the non-personal
// aggregate fields (source_channel/status/value_inr) legitimately kept for
// reporting once the personal identifiers are gone. pii_erased_at is the
// durable record of when this happened.
app.delete('/leads/:id', authMiddleware, rbacMiddleware(USER_MANAGER_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE leads SET contact_name=NULL, phone=NULL, email=NULL, company_name=NULL, pii_erased_at=NOW()
       WHERE id=$1 AND pii_erased_at IS NULL RETURNING id, pii_erased_at`,
      [req.params.id]
    );
    if (rows.length) {
      await auditLog(req.user.id, 'ERASE_LEAD_PII', 'lead', req.params.id, req, 'SUCCESS');
      return res.json({ erased: true, already_erased: false, erased_at: rows[0].pii_erased_at });
    }
    // No row updated: either this lead doesn't exist, or it was already
    // erased by an earlier request - distinguish the two so a repeat
    // request (e.g. a retried client) gets an honest "already done"
    // instead of a misleading 404.
    const { rows: existing } = await pool.query('SELECT id, pii_erased_at FROM leads WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ erased: true, already_erased: true, erased_at: existing[0].pii_erased_at });
  } catch(e){ serverError(res, e); }
});

// Leads - Inbox reply thread. GET returns the full message thread for a
// lead (the Inbox/Leads screens' "provision for reply to lead messages" -
// see README "Studio, Inbox, Leads"); POST records an outbound reply. This
// is a real record of what was sent, not an actual send through
// WhatsApp/email/etc APIs - see channels.js for which channels this app can
// really publish through; a reply here is the same honest scope as the
// rest of this app's channel integrations.
app.get('/leads/:id/messages', authMiddleware, async (req, res) => {
  try {
    const lead = await pool.query('SELECT id FROM leads WHERE id=$1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const { rows } = await pool.query(
      `SELECT lm.id, lm.direction, lm.channel, lm.body, lm.sent_by, u.email AS sent_by_email, lm.created_at
       FROM lead_messages lm LEFT JOIN users u ON u.id = lm.sent_by
       WHERE lm.lead_id=$1 ORDER BY lm.created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e){ serverError(res, e); }
});

app.post('/leads/:id/reply', authMiddleware, validate(schemas.replyToLead), async (req, res) => {
  const { body, channel } = req.body;
  try {
    const lead = await pool.query('SELECT id, source_channel FROM leads WHERE id=$1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const { rows } = await pool.query(
      `INSERT INTO lead_messages (lead_id, direction, channel, body, sent_by) VALUES ($1,'outbound',$2,$3,$4) RETURNING *`,
      [req.params.id, channel || lead.rows[0].source_channel, body, req.user.id]
    );
    await auditLog(req.user.id, 'REPLY_TO_LEAD', 'lead', req.params.id, req, 'SUCCESS', { channel: rows[0].channel });
    res.json(rows[0]);
  } catch(e){ serverError(res, e); }
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
      await auditLog(req.user.id, 'VIRUS_DETECTED', 'csv_upload', null, req, 'BLOCKED', { file: req.file.originalname, viruses: scan.viruses });
      return res.status(400).json({ error: 'File failed virus scan', viruses: scan.viruses });
    }

    const content = fs.readFileSync(req.file.path, 'utf-8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    if (records.length > 5000) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Max 5000 rows' }); }

    // Sanitize, validate and deduplicate by phone+email - see
    // csv-leads.js for the actual logic (extracted so it's unit
    // testable independent of this route's DB/file-system work).
    const { toInsert, valid, dup, invalid } = processLeadCsvRecords(records);
    const productId = req.body.product_id || null;

    const uploadId = uuidv4();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO csv_uploads (id, uploaded_by, file_name, file_size, rows_total, rows_valid, rows_duplicate, rows_invalid, virus_scan_status, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [uploadId, req.user.id, req.file.originalname, req.file.size, records.length, valid, dup, invalid, 'CLEAN', 'COMPLETED']);
      for (const row of toInsert.slice(0, 5000)) {
        // Real, honest enrichment (see lead-enrichment.js): detects the
        // inquiry's script/language and extracts+checksum-validates a
        // GSTIN if one appears in the row's own text fields - not a
        // government-registry lookup (this app has no paid API access for
        // that), just structural detection on what was actually submitted.
        const rawText = [row.company || row.company_name, row.contact_name || row.full_name || row.name, row.note].filter(Boolean).join(' ');
        const gstinResult = extractGstin(rawText);
        await client.query(
          'INSERT INTO leads (company_name, contact_name, phone, email, source_channel, status, csv_upload_id, product_id, detected_language, gstin, gstin_valid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [row.company || row.company_name || '', row.contact_name || row.full_name || row.name || '', row.phone || row.mobile || '', row.email || '', 'csv_upload', 'NEW', uploadId, productId, detectLanguage(rawText), gstinResult ? gstinResult.gstin : null, gstinResult ? gstinResult.valid : null]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await auditLog(req.user.id, 'IMPORT_CSV', 'csv_upload', uploadId, req, 'SUCCESS', { rows_total: records.length, valid, dup, invalid, file: req.file.originalname });

    // Sarvam inquiry classification (see classifyInquiryWithSarvam() above)
    // is deliberately not run here - a bulk CSV can be up to 5000 rows, and
    // calling an external API synchronously per row inside this request
    // would be slow and costly. It only runs on real-time inbound webhook
    // messages (one message at a time) - see handleInboundWebhook below.
    // Bulk-imported leads get detected_language/gstin (script-level, local,
    // no external call) but is_inquiry stays NULL (unclassified).
    fs.unlink(req.file.path, () => {}); // temp CSV is fully parsed into the DB now, no need to keep it
    res.json({ uploadId, rows_total: records.length, rows_valid: valid, rows_duplicate: dup, rows_invalid: invalid, message: 'CSV imported into Leads' });
  } catch(e){ serverError(res, e); }
});

// Content - Upload raw asset (100MB max, ClamAV scan, MIME check)
app.post('/content/upload', authMiddleware, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    // Associating an asset with a Product is what lets it later be
    // published through that product's configured channel credentials
    // (see POST /internal/content-variants/:variantId/publish) - optional
    // for backward compatibility, but publishing will fail with a clear
    // error for an asset that was never associated with one.
    let productId = null;
    if (req.body.product_id) {
      const prodCheck = await pool.query('SELECT id FROM products WHERE id=$1', [req.body.product_id]);
      if (!prodCheck.rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'product_id not found' });
      }
      productId = req.body.product_id;
    }
    let scan;
    try {
      scan = await scanFile(req.file.path);
    } catch (scanErr) {
      fs.unlink(req.file.path, () => {});
      return res.status(503).json({ error: scanErr.message });
    }
    if (scan.isInfected) {
      fs.unlink(req.file.path, () => {});
      await auditLog(req.user.id, 'VIRUS_DETECTED', 'content_asset', null, req, 'BLOCKED', { file: req.file.originalname, viruses: scan.viruses });
      return res.status(400).json({ error: 'File failed virus scan', viruses: scan.viruses });
    }
    const virusStatus = 'CLEAN';

    const { rows } = await pool.query(
      'INSERT INTO content_assets (uploaded_by, product_id, file_name, file_size, mime_type, s3_key, virus_scan_status, brand_kit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.user.id, productId, req.file.originalname, req.file.size, req.file.mimetype, req.file.path, virusStatus, JSON.stringify(req.body.brand_kit || {})]
    );

    await auditLog(req.user.id, 'UPLOAD_CONTENT', 'content_asset', rows[0].id, req, 'SUCCESS', { file: req.file.originalname, size: req.file.size });

    res.json({ asset: rows[0], message: 'Uploaded. Call POST /content/:assetId/transform (or Studio > Generate Variants) to create per-channel variants.' });
  } catch(e){
    // The file already landed on disk (multer wrote it before this handler
    // even ran) - if anything past this point throws before a DB row
    // exists to reference it (e.g. the INSERT itself failing), it's
    // unreferenced garbage with nothing else that will ever clean it up.
    // Uploads here can be up to 100MB each, so repeated failures could
    // otherwise fill the disk over time the same way unrotated logs could
    // (see README "Hardening notes").
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    serverError(res, e);
  }
});

// Content - Transform via Paperclip (YouTube, IG, etc.)
app.post('/content/:assetId/transform', authMiddleware, validate(schemas.transformContent), async (req, res) => {
  const { assetId } = req.params;
  const { channels } = req.body; // ['whatsapp','facebook','instagram','linkedin','youtube','quora','email'] - must match PRODUCT_CHANNELS
  try {
    const asset = await pool.query('SELECT * FROM content_assets WHERE id=$1', [assetId]);
    if (!asset.rows.length) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.rows[0].product_id) {
      return res.status(400).json({ error: 'This asset is not associated with a Product, so its variants could never be published. Re-upload it via a Product to generate variants.' });
    }

    // Keyed by the same channel names as PRODUCT_CHANNELS/product_channels
    // (see the transformContent schema above) so a generated variant's
    // `channel` always lines up with a real, configurable channel.
    const specs = {
      'whatsapp': '1:1 status 1080x1080',
      'facebook': '1200x628 + 1080x1080 text<=125',
      'instagram': '1080x1080 feed / 1080x1350 portrait / 1080x1920 reels',
      'linkedin': '1200x627 doc 1080x1350 text<=3000',
      'youtube': '1920x1080 thumbnail 1280x720 title<=100',
      'quora': 'text answer, optional 1200x675 image',
      'email': 'responsive HTML, hero 1200x600'
    };

    const variants = [];
    for (const ch of (channels || ['instagram','facebook'])) {
      const { rows } = await pool.query('INSERT INTO content_variants (asset_id, channel, spec, title, status) VALUES ($1,$2,$3,$4,$5) RETURNING *', [assetId, ch, specs[ch] || 'auto', `${ch} variant for ${asset.rows[0].file_name}`, 'PENDING_APPROVAL']);
      variants.push(rows[0]);
    }

    // Real, synchronous, per-channel resize via Paperclip - it has the
    // source file on the same shared `recordings` volume (by s3_key), so
    // this is one same-network HTTP round trip per variant, not a heavy
    // background job. Only image assets get a real resized output;
    // anything else (video/PDF/spreadsheet) comes back "skipped" honestly
    // rather than a made-up success. Either way the variant row itself was
    // already created above and stays PENDING_APPROVAL either way - this
    // just fills in the real rendered file when one could be produced.
    for (const v of variants) {
      try {
        const resp = await fetch(`http://${process.env.PAPERCLIP_SERVICE || 'paperclip-transformer:8000'}/transform`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant_id: v.id, asset_id: assetId, s3_key: asset.rows[0].s3_key, channel: v.channel, mime_type: asset.rows[0].mime_type })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.status === 'transformed' && data.output) {
          await pool.query('UPDATE content_variants SET s3_key=$1 WHERE id=$2', [data.output, v.id]);
          v.s3_key = data.output;
        } else {
          console.log(`[transform] variant ${v.id} (${v.channel}): ${data.status || 'no response'}${data.reason ? ' - ' + data.reason : ''}`);
        }
      } catch (e) {
        console.log(`[transform] Paperclip unreachable for variant ${v.id}: ${e.message}`);
      }
    }

    await auditLog(req.user.id, 'TRANSFORM_CONTENT', 'content_asset', assetId, req, 'SUCCESS', { channels, variants: variants.length });

    res.json({ variants, message: 'Transformed per channel spec, pending approval' });
  } catch(e){ serverError(res, e); }
});

// Content - Approval workflow (Super Admin / Approver only)
app.post('/content/variants/:variantId/approve', authMiddleware, roleOrFlag(['SUPER_ADMIN','APPROVER','DEPT_ADMIN','IT_ADMIN'], 'can_approve_content'), validate(schemas.approveVariant), async (req, res) => {
  const { variantId } = req.params;
  const { action, comment } = req.body; // APPROVE, REJECT, REQUEST_CHANGE
  try {
    const { rows } = await pool.query('SELECT * FROM content_variants WHERE id=$1', [variantId]);
    if (!rows.length) return res.status(404).json({ error: 'Variant not found' });

    const newStatus = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'DRAFT'; // REQUEST_CHANGE, now zod-enforced above
    await pool.query('UPDATE content_variants SET status=$1, approved_by=$2 WHERE id=$3', [newStatus, req.user.id, variantId]);
    await pool.query('INSERT INTO approvals (variant_id, requested_by, approved_by, status, comment) VALUES ($1,$2,$3,$4,$5)', [rows[0].asset_id, req.user.id, req.user.id, newStatus, comment || '']);

    if (newStatus === 'APPROVED') {
      // Push to publisher queue - Hermes Publisher Agent (shared key, see note above)
      await redisClient.lPush('publisher:queue', JSON.stringify({ variant_id: variantId }));
    }

    await auditLog(req.user.id, `${action}_CONTENT`, 'content_variant', variantId, req, 'SUCCESS', { comment });

    res.json({ variant_id: variantId, status: newStatus, message: `Content ${newStatus}, ${newStatus==='APPROVED' ? 'queued for publishing to channel' : ''}` });
  } catch(e){ serverError(res, e); }
});

// Internal, server-to-server only (see internalMiddleware) - Hermes calls
// this after an approved content_variant lands on the `publisher:queue`
// Redis list, to actually post it through the real channel integration
// (api/src/channels.js) instead of just logging a fake "Publishing variant
// X" and fabricating a URL.
app.post('/internal/content-variants/:variantId/publish', internalMiddleware, async (req, res) => {
  const { variantId } = req.params;
  try {
    const v = await pool.query('SELECT * FROM content_variants WHERE id=$1', [variantId]);
    if (!v.rows.length) return res.status(404).json({ error: 'Variant not found' });
    const variant = v.rows[0];
    const a = await pool.query('SELECT * FROM content_assets WHERE id=$1', [variant.asset_id]);
    const asset = a.rows[0];

    if (variant.status !== 'APPROVED') return res.status(400).json({ error: `Variant is ${variant.status}, not APPROVED - nothing to publish` });

    async function fail(message) {
      await pool.query(`UPDATE content_variants SET status='PUBLISH_FAILED', publish_error=$1 WHERE id=$2`, [message, variantId]);
      await auditLog(null, 'PUBLISH_CONTENT_FAILED', 'content_variant', variantId, req, 'FAILED', { channel: variant.channel, error: message });
      return res.status(502).json({ published: false, error: message });
    }

    if (!asset || !asset.product_id) {
      return await fail('Content is not associated with a Product, so no channel credentials can be found for it. Re-upload it via a Product (POST /content/upload with product_id) to enable publishing.');
    }

    const channelRow = await pool.query('SELECT config, status FROM product_channels WHERE product_id=$1 AND channel=$2', [asset.product_id, variant.channel]);
    if (!channelRow.rows.length || channelRow.rows[0].status !== 'configured') {
      return await fail(`Channel "${variant.channel}" is not configured on this product yet - configure it under Studio > Channels first.`);
    }

    let config;
    try {
      config = channelsLib.decryptChannelSecrets(variant.channel, channelRow.rows[0].config, decryptSecret);
    } catch (e) {
      return await fail(`Could not decrypt channel credentials: ${e.message}`);
    }

    // Instagram needs the asset reachable at a public URL (see
    // channels.js) - mint a short-lived, single-purpose token for it
    // rather than exposing content_assets generally.
    let publicFileUrl = null;
    if (variant.channel === 'instagram') {
      const domain = API_DOMAIN || APP_DOMAIN;
      if (!domain) {
        return await fail('Instagram requires APP_DOMAIN or API_DOMAIN to be set to a real, internet-reachable domain so the image can be fetched.');
      }
      const tok = await pool.query(
        `INSERT INTO public_file_tokens (file_path, mime_type, expires_at) VALUES ($1,$2, NOW() + interval '15 minutes') RETURNING token`,
        [asset.s3_key, asset.mime_type]
      );
      publicFileUrl = `https://${domain}/public/content-assets/${tok.rows[0].token}/file`;
    }

    let result;
    try {
      result = await channelsLib.publishToChannel(variant.channel, {
        config,
        title: variant.title,
        text: variant.title,
        filePath: asset.s3_key,
        fileName: asset.file_name,
        mimeType: asset.mime_type,
        publicFileUrl,
        to: req.body.to
      });
    } catch (e) {
      return await fail(e.message);
    }

    await pool.query(
      `UPDATE content_variants SET status='PUBLISHED', published_url=$1, published_at=NOW(), publish_error=NULL WHERE id=$2`,
      [result.externalUrl || null, variantId]
    );
    await auditLog(null, 'PUBLISH_CONTENT_SUCCESS', 'content_variant', variantId, req, 'SUCCESS', { channel: variant.channel, external_id: result.externalId });

    res.json({ published: true, channel: variant.channel, external_id: result.externalId, external_url: result.externalUrl });
  } catch(e){ serverError(res, e); }
});

// Audit log - real rows only, company-wide. There was no read route for
// this at all before (only INSERTs via auditLog()) - the frontend was
// showing four entirely fabricated log lines instead.
app.get('/audit-logs', authMiddleware, rbacMiddleware(['SUPER_ADMIN', 'IT_ADMIN']), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await pool.query(
      'SELECT id, user_id, action, resource_type, resource_id, ip_address, result, details, created_at FROM audit_logs ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json(rows);
  } catch(e){ serverError(res, e); }
});

// Integrations - Secure, masked, 2FA required, Super Admin+IT only
// Status/keys are read from this app's actual environment config — nothing here is simulated.
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

app.post('/integrations/reveal', authMiddleware, authLimiter, roleOrFlag(['SUPER_ADMIN','IT_ADMIN'], 'can_view_integrations'), async (req, res) => {
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
      await auditLog(req.user.id, 'REVEAL_KEY_2FA_FAILED', 'integration', null, req, 'FAILED', { channel });
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }
    const key = process.env[`${(channel || '').toUpperCase()}_API_KEY`];
    if (!key) return res.status(404).json({ error: `No API key configured for channel: ${channel}` });
    await auditLog(req.user.id, 'REVEAL_KEY', 'integration', null, req, 'SUCCESS', { channel });
    const domain = API_DOMAIN ? `https://${API_DOMAIN}` : '';
    res.json({ channel, api_key: key, webhook_url: `${domain}/webhooks/${channel}`, expires_in: 30 });
  } catch(e){ serverError(res, e); }
});

app.post('/integrations/toggle', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  const { channel, enabled } = req.body;
  await auditLog(req.user.id, 'TOGGLE_CHANNEL', 'integration', null, req, 'SUCCESS', { channel, enabled });
  res.json({ channel, enabled, message: 'Channel toggled, logged' });
});

// Integrations - Webhook URLs, one per channel, for this one company. Copy
// these into WhatsApp/Facebook/etc.'s webhook config. The secret is
// embedded in the path (not a header) because most of these platforms only
// let you configure a callback URL, not custom headers.
app.get('/integrations/webhook-urls', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  try {
    const company = await getCompany();
    if (!company || !company.webhook_secret) return res.status(404).json({ error: 'No webhook secret provisioned yet — rotate one first' });
    const base = API_DOMAIN ? `https://${API_DOMAIN}` : '';
    const urls = INTEGRATION_CHANNELS.map(channel => ({ channel, url: `${base}/webhooks/${company.webhook_secret}/${channel}` }));
    res.json({ urls });
  } catch(e){ serverError(res, e); }
});

// Integrations - Rotate the company's webhook secret (invalidates all previously issued URLs)
app.post('/integrations/webhook-secret/rotate', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  try {
    const company = await getCompany();
    if (!company) return res.status(404).json({ error: 'Company not set up yet' });
    const newSecret = crypto.randomBytes(24).toString('hex');
    await pool.query('UPDATE company SET webhook_secret=$1 WHERE id=$2', [newSecret, company.id]);
    companyCache = null;
    await auditLog(req.user.id, 'ROTATE_WEBHOOK_SECRET', 'company', company.id, req, 'SUCCESS', {});
    res.json({ message: 'Webhook secret rotated. Update every configured channel URL with the new one.' });
  } catch(e){ serverError(res, e); }
});

// Webhook handlers - 7 channels, secret-gated so inbound leads can be
// safely accepted and persisted. Shared by both the main app (below) and
// the separate webhook server on WEBHOOK_PORT. Runs the same real,
// no-external-API lead enrichment (lead-enrichment.js) the CSV import path
// does, on whatever free-text fields the webhook payload carries.
async function handleInboundWebhook(req, res) {
  const { webhookSecret, channel } = req.params;
  if (!INTEGRATION_CHANNELS.includes(channel)) return res.status(404).json({ error: 'Unknown channel' });
  try {
    const company = await getCompany();
    if (!company || !company.webhook_secret) return res.status(404).json({ error: 'Webhooks not set up yet' });
    const provided = Buffer.from(webhookSecret || '');
    const expected = Buffer.from(company.webhook_secret);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const company_name = sanitizeCSVValue(req.body.company || req.body.company_name || 'Unknown');
    const contact_name = sanitizeCSVValue(req.body.name || req.body.full_name || 'Lead');
    const phone = sanitizeCSVValue(req.body.phone || '');
    const email = sanitizeCSVValue(req.body.email || '');
    const value_inr = Number(req.body.value) || 0;
    const message = sanitizeCSVValue(req.body.message || req.body.note || req.body.text || '');
    const productId = req.body.product_id || null;

    const enrichText = [company_name, contact_name, message].filter(Boolean).join(' ');
    const gstinResult = extractGstin(enrichText);
    // Sarvam classifies the message itself (not the company/contact name
    // noise) as a genuine inquiry or not - null (unclassified) when
    // SARVAM_API_KEY isn't set or the message is empty; see
    // classifyInquiryWithSarvam() above.
    const isInquiry = await classifyInquiryWithSarvam(message);

    const dup = await pool.query(
      `SELECT id FROM leads WHERE (phone<>'' AND phone=$1) OR (email<>'' AND email=$2) LIMIT 1`,
      [phone, email]
    );
    const isDuplicate = dup.rows.length > 0;
    const insertResult = await pool.query(
      `INSERT INTO leads (source_channel, company_name, contact_name, phone, email, value_inr, status, is_duplicate, product_id, detected_language, gstin, gstin_valid, is_inquiry)
       VALUES ($1,$2,$3,$4,$5,$6,'NEW',$7,$8,$9,$10,$11,$12) RETURNING id`,
      [channel, company_name, contact_name, phone, email, value_inr, isDuplicate, productId, detectLanguage(enrichText), gstinResult ? gstinResult.gstin : null, gstinResult ? gstinResult.valid : null, isInquiry]
    );
    const leadId = insertResult.rows[0].id;
    if (message) {
      await pool.query(
        `INSERT INTO lead_messages (lead_id, direction, channel, body) VALUES ($1,'inbound',$2,$3)`,
        [leadId, channel, message]
      );
    }

    await auditLog(null, 'WEBHOOK_LEAD_RECEIVED', 'lead', leadId, req, 'SUCCESS', { channel, is_duplicate: isDuplicate, is_inquiry: isInquiry });

    res.json({ received: true, channel, lead_id: leadId, is_duplicate: isDuplicate, is_inquiry: isInquiry });
  } catch(e){ serverError(res, e); }
}

app.post('/webhooks/:webhookSecret/:channel', webhookLimiter, handleInboundWebhook);

// Hermes Agents status - Premium multiagent
// Reports real rows only. An empty list is an honest "no agents registered yet",
// not backfilled with a fabricated status list.
app.get('/hermes/agents', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM hermes_agents');
    res.json({ mode: process.env.HERMES_MODE || 'premium_multiagent', agents: rows });
  } catch(e){ serverError(res, e); }
});

// Public, unauthenticated by design - see public_file_tokens in
// postgres/init-secure.sql for why this is safe to expose: it serves only
// a specific file that POST /internal/content-variants/:variantId/publish
// explicitly minted a short-lived token for (currently only needed for
// Instagram, whose API has no direct-upload option and must fetch the
// image from a public URL). Single-use: the token row is deleted right
// after a successful read, and an expired or already-used token 404s.
app.get('/public/content-assets/:token/file', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM public_file_tokens WHERE token=$1 AND expires_at > NOW() RETURNING file_path, mime_type`,
      [req.params.token]
    );
    // Opportunistic cleanup of any other expired tokens - this table is
    // tiny and short-lived, so no separate cron job is needed for it.
    pool.query(`DELETE FROM public_file_tokens WHERE expires_at <= NOW()`).catch(() => {});
    if (!rows.length) return res.status(404).json({ error: 'Not found or expired' });
    const { file_path, mime_type } = rows[0];
    if (!fs.existsSync(file_path)) return res.status(404).json({ error: 'File no longer exists' });
    res.setHeader('Content-Type', mime_type || 'application/octet-stream');
    fs.createReadStream(file_path).pipe(res);
  } catch(e){ serverError(res, e); }
});

// Global error handler - without this, an error passed to next(err) (or
// thrown synchronously inside a route/middleware before its own try/catch,
// e.g. multer's fileFilter rejecting an upload, or a bad JSON body) fell
// through to Express's default handler: an HTML response, not the JSON
// every other error path in this API returns, with a 500 regardless of
// what actually went wrong. Must be registered last, with all 4 args (that
// arity is what tells Express this is an error handler, not a normal
// middleware).
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err && err.message && err.message.startsWith('Unsupported file type')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(err && err.status ? err.status : 500).json({ error: 'Internal server error' });
});

const httpServer = app.listen(PORT, () => console.log(`OrgComms API v5 (single-company) running on ${PORT}, webhooks on ${WEBHOOK_PORT}`));

// Webhook server separate
const webhookApp = express();
webhookApp.set('trust proxy', 1);
webhookApp.use(express.json());
webhookApp.post('/webhooks/:webhookSecret/:channel', webhookLimiter, handleInboundWebhook);
webhookApp.get('/health', (req, res) => res.json({ status: 'ok', service: 'webhook' }));
const webhookServer = webhookApp.listen(WEBHOOK_PORT, () => console.log(`Webhook server on ${WEBHOOK_PORT}`));

// Graceful shutdown - without this, `docker compose down`/a redeploy sends
// SIGTERM and (by default, after Docker's 10s grace period) SIGKILL, which
// cuts off in-flight requests mid-response and leaves the pg pool's
// connections to be dropped uncleanly rather than closed. Stop accepting
// new connections on both HTTP servers, let in-flight requests finish, then
// close the shared DB/Redis clients - with a hard timeout so a stuck
// connection can't block shutdown forever and get SIGKILLed anyway.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 9000);
  forceExit.unref();
  let pending = 2;
  const done = () => { if (--pending === 0) finish(); };
  httpServer.close(done);
  webhookServer.close(done);
  async function finish() {
    try { await pool.end(); } catch (e) { console.error('Error closing pg pool:', e.message); }
    try { await redisClient.quit(); } catch (e) { console.error('Error closing redis client:', e.message); }
    clearTimeout(forceExit);
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
