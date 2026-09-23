'use strict';
// Real Postgres + Redis integration tests - the class of bug that a unit
// test mocking pg/redis literally cannot catch: a Postgres trigger actually
// raising on an UPDATE, a Redis-backed rate limiter actually persisting a
// count across separate HTTP requests, the real migration chain (including
// the multi-tenancy-removal migration) applying cleanly against a real
// schema, "Admin sees every product / a regular user only their assigned
// ones" actually holding at the database layer. Every other test file in
// this repo injects a fake pg/redis client (see rate-limiters.test.js's own
// comment on why - no real Redis/Postgres was available in the environment
// that wrote them); this file is what closes that gap once real services
// are available.
//
// NOT run by plain `npm test` - see package.json's separate
// `test:integration` script and README's "Testing" section for why (most
// dev machines and this repo's own sandboxed build environment don't have a
// spare Postgres+Redis sitting around) and for exactly how to run this when
// you do.
//
// Requires DATABASE_URL and REDIS_URL pointing at real, disposable
// instances with this repo's schema already applied: postgres/init-secure.sql
// once, then every postgres/migrate-*.sql in the order api/src/migrate.js
// applies them (or just run `node src/migrate.js` against an
// init-secure.sql'd database - that's exactly what this suite's own CI job
// does, see .github/workflows/api-tests.yml). Never point this at a
// database with real data - several of these tests are destructive by
// design (that's the point: proving erasure/anonymization actually
// happens, not just that a route returns 200).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!DATABASE_URL || !REDIS_URL) {
  test('real Postgres/Redis integration tests - SKIPPED (DATABASE_URL/REDIS_URL not set)', { skip: 'set DATABASE_URL and REDIS_URL to a real, disposable Postgres/Redis to run this suite - see the file header comment' }, () => {});
} else {
  runSuite();
}

function runSuite() {
  const PORT = Number(process.env.TEST_API_PORT || 8391);
  const WEBHOOK_PORT = Number(process.env.TEST_WEBHOOK_PORT || 8392);
  const BASE = `http://127.0.0.1:${PORT}`;
  const JWT_SECRET = 'integration-test-jwt-secret-do-not-use-in-production';
  const ENCRYPTION_KEY = 'integration-test-encryption-key-value';

  let serverProcess;
  let db;

  // Every authLimiter-guarded route (login/signup/2FA/erase) shares one
  // Redis-backed budget keyed by client IP (see rate-limiters.js - it's
  // the same limiter instance reused across all of them, and
  // express-rate-limit's default key is IP-only, not IP+route). Real
  // behavior, not a test artifact - but it means tests that hit those
  // routes would silently interfere with each other's budget if they
  // shared one IP. `app.set('trust proxy', 1)` (server.js) honors one hop
  // of X-Forwarded-For, so each logical test "client" below gets its own
  // header value and therefore its own independent rate-limit bucket -
  // this mirrors how the real deployment gets a real client IP per
  // request through Traefik, not a test-only workaround.
  function ip(label) { return `10.77.0.${label}`; }
  async function call(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip(opts.ipTag || 1) }, opts.headers || {});
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  test.before(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();

    serverProcess = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: Object.assign({}, process.env, {
        DATABASE_URL,
        REDIS_URL,
        JWT_SECRET,
        ENCRYPTION_KEY,
        PORT: String(PORT),
        WEBHOOK_PORT: String(WEBHOOK_PORT),
        CLAMAV_REQUIRED: 'false', // no clamd in this test environment - see server.js's own escape hatch for this exact situation
        SIGNUP_ENABLED: 'true',
        NODE_ENV: 'development' // avoid requireSecretOrExit's production fail-fast path; JWT_SECRET/ENCRYPTION_KEY are set for real above regardless
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not report ready within 15s. Output so far:\n${out}`)), 15000);
      const onData = (d) => {
        out += d.toString();
        if (out.includes(`running on ${PORT}`)) { clearTimeout(timer); cleanup(); resolve(); }
      };
      const onExit = (code) => { clearTimeout(timer); cleanup(); reject(new Error(`server process exited early (code ${code}) before becoming ready. Output:\n${out}`)); };
      function cleanup() {
        serverProcess.stdout.off('data', onData);
        serverProcess.off('exit', onExit);
      }
      serverProcess.stdout.on('data', onData);
      serverProcess.stderr.on('data', (d) => { out += d.toString(); });
      serverProcess.on('exit', onExit);
    });
  });

  test.after(async () => {
    if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGTERM');
    if (db) await db.end();
  });

  test('GET /health reflects a real, live Postgres + Redis connection, not a mock', async () => {
    const { status, data } = await call('/health');
    assert.equal(status, 200);
    assert.equal(data.status, 'ok');
  });

  // ---- Rate limiting: proves the Redis-backed store actually persists a
  // count across independent HTTP requests/connections, not just that
  // passOnStoreError fails open when Redis is unreachable (already
  // covered by rate-limiters.test.js's mocked-fetch tests - this is the
  // real enforcement path those tests explicitly couldn't exercise).
  test('authLimiter (Redis-backed): the 11th request from one client within the window is blocked', async () => {
    const tag = 50; // dedicated IP bucket, untouched by any other test in this file
    let lastStatus = null;
    for (let i = 0; i < 10; i++) {
      const { status } = await call('/auth/login', { method: 'POST', ipTag: tag, body: { email: 'nobody@example.com', password: 'wrong-password-x' } });
      lastStatus = status;
      assert.notEqual(status, 429, `request ${i + 1}/10 should still be within budget, got 429 early`);
    }
    assert.equal(lastStatus, 401, 'the 10th request should fail on bad credentials, not be rate-limited yet');
    const eleventh = await call('/auth/login', { method: 'POST', ipTag: tag, body: { email: 'nobody@example.com', password: 'wrong-password-x' } });
    assert.equal(eleventh.status, 429, 'the 11th request in the window must be blocked by the real Redis-backed limiter');
  });

  // ---- Signup: exercises the real atomic system_flags claim AND the
  // singleton `company` row this app now runs as (see README.md
  // "Hardening notes" on removing multi-tenancy) - not a mock.
  let userAId, tokenA;
  const SUPER_ADMIN_EMAIL = 'admin@integration-test.invalid';
  const SUPER_ADMIN_PASSWORD = 'a-genuinely-long-test-password-1';

  test('GET /auth/signup-status: available before any account exists', async () => {
    const { status, data } = await call('/auth/signup-status', { ipTag: 2 });
    assert.equal(status, 200);
    assert.equal(data.available, true);
  });

  test('POST /auth/signup: creates the first Super Admin + the one company row against a real database', async () => {
    const { status, data } = await call('/auth/signup', {
      method: 'POST', ipTag: 2,
      body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD, company_name: 'Integration Test Co' }
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.token);
    assert.equal(data.user.role, 'SUPER_ADMIN');
    assert.equal('tenant_id' in data.user, false, 'JWT claims must not carry a tenant_id any more');
    tokenA = data.token;
    userAId = data.user.id;

    const { rows } = await db.query('SELECT role FROM users WHERE id=$1', [userAId]);
    assert.equal(rows[0].role, 'SUPER_ADMIN', 'the row must really exist in Postgres, not just in the JWT response');
    const companyRows = await db.query('SELECT name FROM company');
    assert.equal(companyRows.rows.length, 1, 'signup must create exactly one company row');
    assert.equal(companyRows.rows[0].name, 'Integration Test Co');
  });

  test('GET /auth/signup-status: unavailable after the first signup (real DB read)', async () => {
    const { data } = await call('/auth/signup-status', { ipTag: 2 });
    assert.equal(data.available, false);
  });

  test('POST /auth/signup: the atomic signup_used claim really blocks a second signup, race-condition-free, and no second company row is created', async () => {
    const { status, data } = await call('/auth/signup', {
      method: 'POST', ipTag: 3,
      body: { email: 'second-admin@integration-test.invalid', password: 'another-long-test-password-1', company_name: 'Second Co' }
    });
    assert.equal(status, 403);
    assert.match(data.error, /already used/);
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM company`);
    assert.equal(rows[0].n, 1, 'still exactly one company row - this app is single-company by design');
  });

  test('POST /auth/login: real bcrypt verification against the real password hash', async () => {
    const { status, data } = await call('/auth/login', { method: 'POST', ipTag: 4, body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD } });
    assert.equal(status, 200);
    assert.ok(data.token);
  });

  test('POST /auth/login: wrong password is rejected (not just accepted because a user row exists)', async () => {
    const { status } = await call('/auth/login', { method: 'POST', ipTag: 5, body: { email: SUPER_ADMIN_EMAIL, password: 'definitely-not-it' } });
    assert.equal(status, 401);
  });

  test('GET /company: any authenticated user can read the one company row, without its webhook_secret', async () => {
    const { status, data } = await call('/company', { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.name, 'Integration Test Co');
    assert.equal('webhook_secret' in data, false, 'webhook_secret is a bearer credential and must never appear here');
  });

  // ---- Products/members: "Product can be assigned to a user, admin can
  // see all" (see README.md "Hardening notes") - an Admin role sees every
  // product; a MEMBER user sees only the ones they're assigned to. Seeded
  // and verified against a real database, not application-code assertions
  // alone, since this replaced RLS tenant isolation as this app's actual
  // access-control boundary.
  let productId, memberId, tokenMember;
  const MEMBER_EMAIL = 'member@integration-test.invalid';
  const MEMBER_PASSWORD = 'a-different-long-test-password-1';

  test('POST /products: Admin creates a product', async () => {
    const { status, data } = await call('/products', {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
      body: { name: 'Integration Test Product' }
    });
    assert.equal(status, 200, JSON.stringify(data));
    productId = data.id;
  });

  test('POST /users: create a regular (non-admin) user not yet assigned to any product', async () => {
    const { status, data } = await call('/users', {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
      body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD, role: 'CONTENT_CREATOR' }
    });
    assert.equal(status, 200, JSON.stringify(data));
    memberId = data.id;
  });

  test('POST /auth/login as the regular member', async () => {
    const { status, data } = await call('/auth/login', { method: 'POST', ipTag: 11, body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD } });
    assert.equal(status, 200, JSON.stringify(data));
    tokenMember = data.token;
  });

  test('GET /products: an unassigned member sees no products; the Admin sees every product', async () => {
    const memberView = await call('/products', { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert.equal(memberView.status, 200);
    assert.deepEqual(memberView.data, []);

    const adminView = await call('/products', { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(adminView.status, 200);
    assert.ok(adminView.data.some(p => p.id === productId), 'Admin must see the product regardless of membership');
  });

  test('POST /products/:id/members: assigning the member grants them visibility into exactly that product', async () => {
    const assign = await call(`/products/${productId}/members`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
      body: { user_id: memberId, role: 'MEMBER' }
    });
    assert.equal(assign.status, 200, JSON.stringify(assign.data));

    const memberView = await call('/products', { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert.equal(memberView.data.length, 1);
    assert.equal(memberView.data[0].id, productId);
  });

  // ---- audit_logs immutability: a real Postgres trigger, not application logic
  test('audit_logs is genuinely append-only: a direct UPDATE is rejected by the no_update_audit trigger', async () => {
    await assert.rejects(
      () => db.query(`UPDATE audit_logs SET result='TAMPERED' WHERE user_id=$1`, [userAId]),
      /Audit logs immutable/,
      'the no_update_audit trigger (postgres/init-secure.sql) must reject this at the database layer, regardless of which role issues the UPDATE'
    );
  });

  // ---- GDPR self-service export/erasure against a real database - proves
  // erasure actually anonymizes the row and actually blocks a subsequent
  // login, not just that the route returns { erased: true }.
  let userCId, tokenC;
  const USER_C_EMAIL = 'erase-me@integration-test.invalid';
  const USER_C_PASSWORD = 'password-for-the-user-who-gets-erased-1';

  test('POST /users: create a second user to exercise /me/export and /me/erase on (so erasing them never risks the only account)', async () => {
    const { status, data } = await call('/users', {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
      body: { email: USER_C_EMAIL, password: USER_C_PASSWORD, role: 'CONTENT_CREATOR' }
    });
    assert.equal(status, 200, JSON.stringify(data));
    userCId = data.id;
  });

  test('POST /auth/login as the soon-to-be-erased user', async () => {
    const { status, data } = await call('/auth/login', { method: 'POST', ipTag: 7, body: { email: USER_C_EMAIL, password: USER_C_PASSWORD } });
    assert.equal(status, 200, JSON.stringify(data));
    tokenC = data.token;
  });

  test('GET /me/export: returns this user\'s real data from a real database', async () => {
    const { status, data } = await call('/me/export', { headers: { Authorization: `Bearer ${tokenC}` } });
    assert.equal(status, 200);
    assert.equal(data.user.email, USER_C_EMAIL);
    assert.equal(data.user.id, userCId);
    assert.equal(data.company.name, 'Integration Test Co');
  });

  test('POST /me/erase: wrong password is rejected, account is untouched', async () => {
    const { status } = await call('/me/erase', { method: 'POST', ipTag: 8, headers: { Authorization: `Bearer ${tokenC}` }, body: { password: 'not-the-real-password' } });
    assert.equal(status, 401);
    const { rows } = await db.query('SELECT email, disabled FROM users WHERE id=$1', [userCId]);
    assert.equal(rows[0].email, USER_C_EMAIL);
    assert.equal(rows[0].disabled, false);
  });

  test('POST /me/erase: with the correct password, really anonymizes the row in Postgres', async () => {
    const { status, data } = await call('/me/erase', { method: 'POST', ipTag: 9, headers: { Authorization: `Bearer ${tokenC}` }, body: { password: USER_C_PASSWORD } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.erased, true);

    const { rows } = await db.query('SELECT email, disabled, two_fa_secret FROM users WHERE id=$1', [userCId]);
    assert.match(rows[0].email, /^erased-.*@erased\.invalid$/);
    assert.equal(rows[0].disabled, true);
    assert.equal(rows[0].two_fa_secret, null);
  });

  test('POST /auth/login: the erased account can no longer log in with its original email', async () => {
    const { status } = await call('/auth/login', { method: 'POST', ipTag: 10, body: { email: USER_C_EMAIL, password: USER_C_PASSWORD } });
    assert.equal(status, 401, 'the original email no longer resolves to any account, and the account is disabled either way');
  });

  // ---- Leads: webhook intake (real enrichment, real dedupe), export/
  // erasure, and the Inbox reply thread - against real data.
  let leadAId;
  test('seed a lead directly in Postgres, tied to the product created above (arrange, not act)', async () => {
    const { rows } = await db.query(
      `INSERT INTO leads (contact_name, email, source_channel, product_id) VALUES ('Lead For Integration Test','lead-a@example.com','whatsapp',$1) RETURNING id`,
      [productId]
    );
    leadAId = rows.rows ? rows.rows[0].id : rows[0].id;
  });

  test('GET /leads: filters by ?product_id= for the Leads screen\'s product-wise view', async () => {
    const { status, data } = await call(`/leads?product_id=${productId}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.some(l => l.id === leadAId));
  });

  test('GET /leads/:id/export: real lead data, real related agent_runs/messages queries', async () => {
    const { status, data } = await call(`/leads/${leadAId}/export`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.lead.contact_name, 'Lead For Integration Test');
    assert.deepEqual(data.agent_runs, []);
    assert.deepEqual(data.messages, []);
  });

  test('POST /leads/:id/reply then GET /leads/:id/messages: a real reply is recorded and read back', async () => {
    const reply = await call(`/leads/${leadAId}/reply`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
      body: { body: 'Thanks for reaching out — when works for a quick call?' }
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    assert.equal(reply.data.direction, 'outbound');

    const { status, data } = await call(`/leads/${leadAId}/messages`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200);
    assert.equal(data.length, 1);
    assert.equal(data[0].body, 'Thanks for reaching out — when works for a quick call?');
    assert.equal(data[0].sent_by_email, SUPER_ADMIN_EMAIL);
  });

  test('DELETE /leads/:id: scrubs PII in place, sets pii_erased_at, keeps the row and non-PII fields', async () => {
    const { status, data } = await call(`/leads/${leadAId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.erased, true);
    assert.equal(data.already_erased, false);

    const { rows } = await db.query('SELECT contact_name, email, source_channel, pii_erased_at FROM leads WHERE id=$1', [leadAId]);
    assert.equal(rows[0].contact_name, null);
    assert.equal(rows[0].email, null);
    assert.equal(rows[0].source_channel, 'whatsapp', 'non-personal aggregate field must survive erasure');
    assert.ok(rows[0].pii_erased_at, 'pii_erased_at must be set as the durable erasure record');
  });

  test('DELETE /leads/:id: a repeat request reports already_erased instead of erasing again or 404ing', async () => {
    const { status, data } = await call(`/leads/${leadAId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200);
    assert.equal(data.already_erased, true);
  });

  // ---- Inbound webhook: real secret check, real enrichment, real dedupe -
  // against the real /company row and real Postgres, not a mock.
  test('POST /webhooks/:secret/:channel: rejects an unknown/wrong secret', async () => {
    const { status } = await call('/webhooks/not-the-real-secret/whatsapp', { method: 'POST', ipTag: 12, body: { name: 'X' } });
    assert.equal(status, 401);
  });

  test('POST /webhooks/:secret/:channel: a valid request creates a real lead with real enrichment applied', async () => {
    const secretRows = await db.query('SELECT webhook_secret FROM company');
    const secret = secretRows.rows[0].webhook_secret;
    const { status, data } = await call(`/webhooks/${secret}/whatsapp`, {
      method: 'POST', ipTag: 13,
      body: { name: 'Priya Sharma', phone: '+91-98765-43210', message: 'Interested in your product, GSTIN is 27AAPFU0939F1Z9' }
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.received, true);

    const { rows } = await db.query('SELECT contact_name, detected_language, gstin FROM leads WHERE id=$1', [data.lead_id]);
    assert.equal(rows[0].contact_name, 'Priya Sharma');
    assert.equal(rows[0].detected_language, 'en');
    assert.equal(rows[0].gstin, '27AAPFU0939F1Z9');

    const { rows: messages } = await db.query(`SELECT direction, body FROM lead_messages WHERE lead_id=$1`, [data.lead_id]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].direction, 'inbound');
  });
}
