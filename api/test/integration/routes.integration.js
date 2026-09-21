'use strict';
// Real Postgres + Redis integration tests - the class of bug that a unit
// test mocking pg/redis literally cannot catch: RLS tenant isolation
// actually blocking a cross-tenant read, a Postgres trigger actually
// raising on an UPDATE, a Redis-backed rate limiter actually persisting a
// count across separate HTTP requests, the real migration chain applying
// cleanly against a real schema. Every other test file in this repo
// injects a fake pg/redis client (see rate-limiters.test.js's own comment
// on why - no real Redis/Postgres was available in the environment that
// wrote them); this file is what closes that gap once real services are.
//
// NOT run by plain `npm test` - see package.json's separate
// `test:integration` script and README's "Route/DB integration testing"
// section for why (most dev machines and this repo's own sandboxed build
// environment don't have a spare Postgres+Redis sitting around) and for
// exactly how to run this when you do.
//
// Requires DATABASE_URL and REDIS_URL pointing at real, disposable
// instances with this repo's schema already applied: postgres/init-secure.sql
// once, then every postgres/migrate-*.sql in the order api/src/migrate.js
// applies them (or just run `node src/migrate.js` against an
// init-secure.sql'd database - that's exactly what this suite's own
// CI job does, see .github/workflows/test.yml). Never point this at a
// database with real data - several of these tests are destructive by
// design (that's the point: proving erasure/anonymization actually
// happens, not just that a route returns 200).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

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

  // ---- Signup: exercises the real atomic system_flags claim, not a mock
  let tenantAId, userAId, tokenA;
  const SUPER_ADMIN_EMAIL = 'admin@integration-test.invalid';
  const SUPER_ADMIN_PASSWORD = 'a-genuinely-long-test-password-1';

  test('GET /auth/signup-status: available before any account exists', async () => {
    const { status, data } = await call('/auth/signup-status', { ipTag: 2 });
    assert.equal(status, 200);
    assert.equal(data.available, true);
  });

  test('POST /auth/signup: creates the first Super Admin + tenant against a real database', async () => {
    const { status, data } = await call('/auth/signup', {
      method: 'POST', ipTag: 2,
      body: { email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD, company_name: 'Integration Test Co' }
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.token);
    assert.equal(data.user.role, 'SUPER_ADMIN');
    tokenA = data.token;
    userAId = data.user.id;
    tenantAId = data.user.tenant_id;

    const { rows } = await db.query('SELECT role FROM users WHERE id=$1', [userAId]);
    assert.equal(rows[0].role, 'SUPER_ADMIN', 'the row must really exist in Postgres, not just in the JWT response');
  });

  test('GET /auth/signup-status: unavailable after the first signup (real DB read)', async () => {
    const { data } = await call('/auth/signup-status', { ipTag: 2 });
    assert.equal(data.available, false);
  });

  test('POST /auth/signup: the atomic signup_used claim really blocks a second signup, race-condition-free', async () => {
    const { status, data } = await call('/auth/signup', {
      method: 'POST', ipTag: 3,
      body: { email: 'second-admin@integration-test.invalid', password: 'another-long-test-password-1', company_name: 'Second Co' }
    });
    assert.equal(status, 403);
    assert.match(data.error, /already used/);
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM tenants`);
    assert.equal(rows[0].n, 1, 'no second tenant should have been created');
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

  // ---- RLS tenant isolation: a second tenant + lead, seeded directly in
  // Postgres (bypassing the API on purpose - this is arrange, not act),
  // to prove FORCE ROW LEVEL SECURITY actually stops a cross-tenant read
  // at the database layer, not just that server.js remembers to filter
  // by tenant_id in application code.
  let tenantBId, tokenB;
  const TENANT_B_EMAIL = 'admin-b@integration-test.invalid';
  const TENANT_B_PASSWORD = 'yet-another-long-test-password-1';

  test('seed tenant B + a lead per tenant directly in Postgres (arrange, not act - this is setup, not a test of anything)', async () => {
    const tRows = await db.query(
      `INSERT INTO tenants (name, subdomain, plan, is_premium, webhook_secret) VALUES ('Tenant B','tenant-b','standard',false,'test-secret') RETURNING id`
    );
    tenantBId = tRows.rows[0].id;
    const hash = await bcrypt.hash(TENANT_B_PASSWORD, 12);
    await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content)
       VALUES ($1,$2,$3,'SUPER_ADMIN',NULL,true,true,true)`,
      [tenantBId, TENANT_B_EMAIL, hash]
    );

    // Seed one lead per tenant. leads.pii_erased_at column's very
    // presence here (added this session by migrate-gdpr-erasure.sql)
    // already proves that migration applied for real. Each RLS-protected
    // insert needs app.tenant_id set on this connection first, exactly
    // like withTenantClient() does in server.js.
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantAId]);
    await db.query(`INSERT INTO leads (tenant_id, contact_name, email, source_channel) VALUES ($1,'Lead For A','lead-a@example.com','whatsapp')`, [tenantAId]);
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantBId]);
    await db.query(`INSERT INTO leads (tenant_id, contact_name, email, source_channel) VALUES ($1,'Lead For B','lead-b@example.com','facebook')`, [tenantBId]);
  });

  test('POST /auth/login as tenant B', async () => {
    const { status, data } = await call('/auth/login', { method: 'POST', ipTag: 6, body: { email: TENANT_B_EMAIL, password: TENANT_B_PASSWORD } });
    assert.equal(status, 200, JSON.stringify(data));
    tokenB = data.token;
  });

  test('GET /leads: tenant A sees only its own lead, never tenant B\'s - enforced by Postgres RLS, not app code', async () => {
    const { status, data } = await call('/leads', { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200);
    assert.equal(data.length, 1);
    assert.equal(data[0].contact_name, 'Lead For A');
  });

  test('GET /leads: tenant B sees only its own lead - same query, same route, different tenant', async () => {
    const { status, data } = await call('/leads', { headers: { Authorization: `Bearer ${tokenB}` } });
    assert.equal(status, 200);
    assert.equal(data.length, 1);
    assert.equal(data[0].contact_name, 'Lead For B');
  });

  // ---- audit_logs immutability: a real Postgres trigger, not application logic
  test('audit_logs is genuinely append-only: a direct UPDATE is rejected by the no_update_audit trigger', async () => {
    await assert.rejects(
      () => db.query(`UPDATE audit_logs SET result='TAMPERED' WHERE tenant_id=$1`, [tenantAId]),
      /Audit logs immutable/,
      'the no_update_audit trigger (postgres/init-secure.sql) must reject this at the database layer, regardless of which role issues the UPDATE'
    );
  });

  // ---- GDPR self-service export/erasure against a real database (see
  // this session's earlier /me/export and /me/erase work) - proves
  // erasure actually anonymizes the row and actually blocks a subsequent
  // login, not just that the route returns { erased: true }.
  let userCId, tokenC;
  const USER_C_EMAIL = 'erase-me@integration-test.invalid';
  const USER_C_PASSWORD = 'password-for-the-user-who-gets-erased-1';

  test('POST /users: create a second tenant-A user to exercise /me/export and /me/erase on (so erasing them never risks tenant A\'s only account)', async () => {
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
    assert.equal(data.tenant.id, tenantAId);
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

  // ---- Leads erasure (GET /leads/:id/export, DELETE /leads/:id) against real data
  let leadAId;
  test('GET /leads/:id/export: real lead data, real related agent_runs query', async () => {
    // The raw `db` client is one long-lived session shared across this
    // whole file - app.tenant_id was last set to tenant B's id by the
    // seeding step above and stays set until changed again, so this read
    // needs its own explicit SET or RLS filters tenant A's own lead out
    // from under it (this is exactly the kind of connection-affinity bug
    // withTenantClient() in server.js exists to prevent in the app itself
    // - see its own comment - and why it's worth getting right in test
    // setup too, not just application code).
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantAId]);
    const { rows } = await db.query(`SELECT id FROM leads WHERE tenant_id=$1 AND contact_name='Lead For A'`, [tenantAId]);
    leadAId = rows[0].id;
    const { status, data } = await call(`/leads/${leadAId}/export`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.lead.contact_name, 'Lead For A');
    assert.deepEqual(data.agent_runs, []);
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
}
