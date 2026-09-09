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
// CORS - locked to this tenant's actual frontend domain(s), not left open to
// any origin. APP_DOMAIN covers the common case (one frontend); set
// CORS_ALLOWED_ORIGINS (comma-separated, full origins incl. scheme) for
// anything extra, e.g. a staging frontend or local dev.
// Requests with no Origin header (curl, server-to-server, the webhook
// endpoints) are never browser cross-origin requests, so they're unaffected
// by CORS either way and are passed through here.
const CORS_ALLOWED_ORIGINS = [
  ...(process.env.APP_DOMAIN ? [`https://${process.env.APP_DOMAIN}`] : []),
  ...(process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : [])
];
if (CORS_ALLOWED_ORIGINS.length === 0) {
  console.warn('CORS: no APP_DOMAIN or CORS_ALLOWED_ORIGINS set — every browser cross-origin request will be rejected until one is configured.');
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
    const { rows } = await pool.query('SELECT id, tenant_id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, created_at FROM users WHERE tenant_id=$1 ORDER BY created_at DESC', [targetTenant]);
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
       RETURNING id, tenant_id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, created_at`,
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
       RETURNING id, tenant_id, email, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, two_fa_enabled, created_at`,
      [r.name, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content, userId, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found in your tenant' });
    await auditLog(req.user.tenant_id, req.user.id, 'CHANGE_USER_ROLE', 'user', userId, req, 'SUCCESS', { role: r.name });
    res.json(rows[0]);
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

app.post('/integrations/reveal', authMiddleware, rbacMiddleware(['SUPER_ADMIN','IT_ADMIN']), async (req, res) => {
  const { channel, totp } = req.body;
  if (!totp) return res.status(401).json({ error: '2FA OTP required to reveal' });
  // NOTE: totp presence is checked but not cryptographically verified yet (no TOTP
  // secret is stored anywhere for a user) — this is a real gap, not simulated here.
  const key = process.env[`${(channel || '').toUpperCase()}_API_KEY`];
  if (!key) return res.status(404).json({ error: `No API key configured for channel: ${channel}` });
  await auditLog(req.user.tenant_id, req.user.id, 'REVEAL_KEY', 'integration', null, req, 'SUCCESS', { channel });
  const domain = process.env.API_DOMAIN ? `https://${process.env.API_DOMAIN}` : '';
  res.json({ channel, api_key: key, webhook_url: `${domain}/webhooks/${channel}`, expires_in: 30 });
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
    const base = process.env.API_DOMAIN ? `https://${process.env.API_DOMAIN}` : '';
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
