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
const fs = require('node:fs');
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

  // ---- User hierarchy: reporting chain, live-mirrored product access,
  // cascading block, and bulk lead assignment (api/src/hierarchy.js) -
  // exactly the class of claim a mocked pool can't really prove ("a report
  // with no product_members of their own sees their Manager's products",
  // "disabling a Manager really disables their report's ability to log
  // in") - against a real database, like the Products/members section
  // above did for the plain admin/member case.
  let hProductId, managerId, tokenManager, reportId, tokenReport, outsiderId, tokenOutsider;
  const MANAGER_EMAIL = 'hmanager@integration-test.invalid';
  const MANAGER_PASSWORD = 'a-manager-long-test-password-1';
  const REPORT_EMAIL = 'hreport@integration-test.invalid';
  const REPORT_PASSWORD = 'a-report-long-test-password-1';
  const OUTSIDER_EMAIL = 'houtsider@integration-test.invalid';
  const OUTSIDER_PASSWORD = 'an-outsider-long-test-password-1';

  test('hierarchy setup: a product, a Manager (DEPT_ADMIN) assigned to it, a report of theirs, and an unrelated outsider', async () => {
    const product = await call('/products', { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: { name: 'Hierarchy Test Product' } });
    assert.equal(product.status, 200, JSON.stringify(product.data));
    hProductId = product.data.id;

    const manager = await call('/users', { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: { email: MANAGER_EMAIL, password: MANAGER_PASSWORD, role: 'DEPT_ADMIN' } });
    assert.equal(manager.status, 200, JSON.stringify(manager.data));
    managerId = manager.data.id;

    const assign = await call(`/products/${hProductId}/members`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: { user_id: managerId, role: 'MEMBER' } });
    assert.equal(assign.status, 200, JSON.stringify(assign.data));

    const report = await call('/users', { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: { email: REPORT_EMAIL, password: REPORT_PASSWORD, role: 'SALES_LEAD', reports_to: managerId } });
    assert.equal(report.status, 200, JSON.stringify(report.data));
    reportId = report.data.id;
    assert.equal(report.data.reports_to, managerId);

    const outsider = await call('/users', { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD, role: 'SALES_LEAD' } });
    assert.equal(outsider.status, 200, JSON.stringify(outsider.data));
    outsiderId = outsider.data.id;

    tokenManager = (await call('/auth/login', { method: 'POST', ipTag: 60, body: { email: MANAGER_EMAIL, password: MANAGER_PASSWORD } })).data.token;
    tokenReport = (await call('/auth/login', { method: 'POST', ipTag: 61, body: { email: REPORT_EMAIL, password: REPORT_PASSWORD } })).data.token;
    tokenOutsider = (await call('/auth/login', { method: 'POST', ipTag: 62, body: { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD } })).data.token;
    assert.ok(tokenManager && tokenReport && tokenOutsider, 'all three should be able to log in before the cascading-block test below disables two of them');
  });

  test("GET /products: a report with no product_members of their own live-mirrors their Manager's products, not the outsider's", async () => {
    const reportView = await call('/products', { headers: { Authorization: `Bearer ${tokenReport}` } });
    assert.equal(reportView.status, 200, JSON.stringify(reportView.data));
    assert.deepEqual(reportView.data.map(p => p.id), [hProductId]);

    const outsiderView = await call('/products', { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert.equal(outsiderView.status, 200);
    assert.deepEqual(outsiderView.data, [], 'the outsider reports to nobody and has no product_members of their own');
  });

  test('PATCH /users/:id/reports-to: rejects a cycle (the Manager cannot be made to report to their own report)', async () => {
    const { status, data } = await call(`/users/${managerId}/reports-to`, { method: 'PATCH', headers: { Authorization: `Bearer ${tokenA}` }, body: { reports_to: reportId } });
    assert.equal(status, 400, JSON.stringify(data));
    assert.match(data.error, /loop/);
  });

  test('PATCH /users/:id/reports-to: an Admin (top of the hierarchy) cannot be given a reporting head', async () => {
    const { status, data } = await call(`/users/${userAId}/reports-to`, { method: 'PATCH', headers: { Authorization: `Bearer ${tokenA}` }, body: { reports_to: managerId } });
    assert.equal(status, 400, JSON.stringify(data));
    assert.match(data.error, /top of the reporting hierarchy/);
  });

  test('GET /users/my-reports: the Manager sees their one report; the report themselves sees nobody', async () => {
    const managerView = await call('/users/my-reports', { headers: { Authorization: `Bearer ${tokenManager}` } });
    assert.equal(managerView.status, 200, JSON.stringify(managerView.data));
    assert.deepEqual(managerView.data.map(u => u.id), [reportId]);

    const reportView = await call('/users/my-reports', { headers: { Authorization: `Bearer ${tokenReport}` } });
    assert.equal(reportView.status, 200);
    assert.deepEqual(reportView.data, []);
  });

  let hLeadId;
  test('seed a lead on the hierarchy product (arrange, not act)', async () => {
    const { rows } = await db.query(
      `INSERT INTO leads (contact_name, email, source_channel, product_id) VALUES ('Hierarchy Lead','hlead@example.com','whatsapp',$1) RETURNING id`,
      [hProductId]
    );
    hLeadId = rows[0].id;
  });

  test("GET /leads: the Manager sees the whole product's inbox; the not-yet-assigned report does not", async () => {
    const managerView = await call('/leads', { headers: { Authorization: `Bearer ${tokenManager}` } });
    assert.equal(managerView.status, 200, JSON.stringify(managerView.data));
    assert.ok(managerView.data.some(l => l.id === hLeadId));

    const reportView = await call('/leads', { headers: { Authorization: `Bearer ${tokenReport}` } });
    assert.equal(reportView.data.some(l => l.id === hLeadId), false, 'not bulk-assigned to them yet');
  });

  test('POST /leads/bulk-assign: the Manager can only hand a lead to their own report, not to an outsider', async () => {
    const { status, data } = await call('/leads/bulk-assign', { method: 'POST', headers: { Authorization: `Bearer ${tokenManager}` }, body: { ids: [hLeadId], assigned_to: outsiderId } });
    assert.equal(status, 403, JSON.stringify(data));
  });

  test("POST /leads/bulk-assign: assigns the lead to the Manager's report", async () => {
    const { status, data } = await call('/leads/bulk-assign', { method: 'POST', headers: { Authorization: `Bearer ${tokenManager}` }, body: { ids: [hLeadId], assigned_to: reportId } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.assigned, 1);
  });

  test('GET /leads: the report now sees the lead assigned to them; the outsider still cannot see it at all', async () => {
    const reportView = await call('/leads', { headers: { Authorization: `Bearer ${tokenReport}` } });
    assert.ok(reportView.data.some(l => l.id === hLeadId));

    const outsiderView = await call('/leads', { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert.equal(outsiderView.data.some(l => l.id === hLeadId), false);
  });

  test('GET /leads/:id/messages and POST /leads/:id/reply: the assigned report can access the lead; the outsider is forbidden from both', async () => {
    const outsiderMessages = await call(`/leads/${hLeadId}/messages`, { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert.equal(outsiderMessages.status, 403, JSON.stringify(outsiderMessages.data));

    const outsiderReply = await call(`/leads/${hLeadId}/reply`, { method: 'POST', headers: { Authorization: `Bearer ${tokenOutsider}` }, body: { body: 'should not be allowed' } });
    assert.equal(outsiderReply.status, 403, JSON.stringify(outsiderReply.data));

    const reportMessages = await call(`/leads/${hLeadId}/messages`, { headers: { Authorization: `Bearer ${tokenReport}` } });
    assert.equal(reportMessages.status, 200, JSON.stringify(reportMessages.data));
  });

  test('PATCH /users/:id/status: disabling the Manager cascades to disable their report immediately, in one real transaction', async () => {
    const { status, data } = await call(`/users/${managerId}/status`, { method: 'PATCH', headers: { Authorization: `Bearer ${tokenA}` }, body: { disabled: true } });
    assert.equal(status, 200, JSON.stringify(data));

    const { rows } = await db.query('SELECT id, disabled FROM users WHERE id = ANY($1::uuid[])', [[managerId, reportId]]);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.disabled, true, `${row.id} should be cascaded-disabled`);

    const loginAttempt = await call('/auth/login', { method: 'POST', ipTag: 63, body: { email: REPORT_EMAIL, password: REPORT_PASSWORD } });
    assert.equal(loginAttempt.status, 401, 'the cascaded-disabled report must not be able to log in any more');
  });

  // Company Settings: name + logo, against the real /company row and real Postgres.
  // GET /company/logo is deliberately unauthenticated (this app is single-tenant, so
  // there is no cross-tenant leak risk), which is why these tests use raw fetch() for
  // that route instead of the call() helper's Authorization header.
  const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  test('PATCH /company: a regular member cannot rename the company', async () => {
    const { status, data } = await call('/company', { method: 'PATCH', headers: { Authorization: `Bearer ${tokenMember}` }, body: { name: 'Hijacked Co' } });
    assert.equal(status, 403, JSON.stringify(data));
  });

  test('PATCH /company: an Admin can rename the company', async () => {
    const { status, data } = await call('/company', { method: 'PATCH', headers: { Authorization: `Bearer ${tokenA}` }, body: { name: 'Renamed Integration Co' } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.name, 'Renamed Integration Co');

    const { rows } = await db.query('SELECT name FROM company WHERE id = $1', [data.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Renamed Integration Co');
  });

  test('GET /company/logo: 404s with no logo set, no auth required', async () => {
    const res = await fetch(`${BASE}/company/logo`);
    assert.equal(res.status, 404);
  });

  test('POST /company/logo: a regular member cannot upload a logo', async () => {
    const form = new FormData();
    form.append('logo', new Blob([Buffer.from(TINY_PNG_BASE64, 'base64')], { type: 'image/png' }), 'logo.png');
    const res = await fetch(`${BASE}/company/logo`, { method: 'POST', headers: { Authorization: `Bearer ${tokenMember}` }, body: form });
    assert.equal(res.status, 403);
  });

  test('POST /company/logo then GET /company/logo: an Admin uploads a real logo, then anyone (no auth) can fetch it', async () => {
    const pngBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
    const form = new FormData();
    form.append('logo', new Blob([pngBytes], { type: 'image/png' }), 'logo.png');
    const uploadRes = await fetch(`${BASE}/company/logo`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form });
    const uploadData = await uploadRes.json();
    assert.equal(uploadRes.status, 200, JSON.stringify(uploadData));
    assert.equal(uploadData.has_logo, true);

    const fetchRes = await fetch(`${BASE}/company/logo`);
    assert.equal(fetchRes.status, 200);
    assert.equal(fetchRes.headers.get('content-type'), 'image/png');
    const fetchedBytes = Buffer.from(await fetchRes.arrayBuffer());
    assert.equal(fetchedBytes.length, pngBytes.length, 'served logo bytes must match the uploaded PNG');

    const companyView = await call('/company', { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(companyView.status, 200, JSON.stringify(companyView.data));
    assert.equal(companyView.data.has_logo, true);
  });

  test('DELETE /company/logo: an Admin removes the logo, GET /company/logo 404s again', async () => {
    const { status, data } = await call('/company/logo', { method: 'DELETE', headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.has_logo, false);

    const fetchRes = await fetch(`${BASE}/company/logo`);
    assert.equal(fetchRes.status, 404);
  });

  // Website Web Form: dedicated per-product form_token/URL, against a
  // real database - not the shared company webhook_secret path (that's
  // covered by the webhook tests above/below). productId/tokenMember are
  // the ones set up earlier in this suite (POST /products, POST /users).
  let webFormToken;

  test('POST /products already gave this product a web_form channel row, configured, with its own form_token', async () => {
    const { status, data } = await call(`/products/${productId}/channels`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(status, 200, JSON.stringify(data));
    const webForm = data.find(c => c.channel === 'web_form');
    assert.ok(webForm, 'web_form channel row must exist from product creation');
    assert.equal(webForm.status, 'configured', 'web_form has no required fields, so it starts configured, not not_configured');
    assert.ok(webForm.config && typeof webForm.config.form_token === 'string' && webForm.config.form_token.length > 0);
    webFormToken = webForm.config.form_token;
  });

  test('POST /forms/:token: a real submission becomes a lead scoped to exactly this product, no product_id field needed', async () => {
    const res = await fetch(`${BASE}/forms/${webFormToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Web Form Visitor', email: 'visitor@integration-test.invalid', message: 'Interested in your product' })
    });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.channel, 'web_form');

    const { rows } = await db.query('SELECT product_id, source_channel, email FROM leads WHERE id=$1', [data.lead_id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].product_id, productId, 'the lead must be scoped to the product that owns this form_token, with no product_id field in the request');
    assert.equal(rows[0].source_channel, 'web_form');
    assert.equal(rows[0].email, 'visitor@integration-test.invalid');
  });

  test('POST /forms/:token: an unknown token 404s rather than guessing a product', async () => {
    const res = await fetch(`${BASE}/forms/not-a-real-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(res.status, 404);
  });

  test('POST /forms/:token: a plain HTML form submit (urlencoded, no JS) is accepted and can redirect to a configured thank-you page', async () => {
    const configureRes = await call(`/products/${productId}/channels`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
      body: { channel: 'web_form', config: { redirect_url: 'https://example.com/thanks' } }
    });
    assert.equal(configureRes.status, 200, JSON.stringify(configureRes.data));

    const params = new URLSearchParams({ name: 'Plain Form Visitor', phone: '+919876543210', message: 'Call me back' });
    const res = await fetch(`${BASE}/forms/${webFormToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });
    assert.equal(res.status, 303, 'a configured redirect_url must 303 a plain form submit rather than returning JSON');
    assert.equal(res.headers.get('location'), 'https://example.com/thanks');
  });

  test('POST /forms/:token: an allowed_origin rejects a submission from a different site', async () => {
    const configureRes = await call(`/products/${productId}/channels`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
      body: { channel: 'web_form', config: { redirect_url: '', allowed_origin: 'https://allowed.example.com' } }
    });
    assert.equal(configureRes.status, 200, JSON.stringify(configureRes.data));

    const res = await fetch(`${BASE}/forms/${webFormToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://not-allowed.example.com' },
      body: JSON.stringify({ name: 'Should be blocked' })
    });
    assert.equal(res.status, 403, JSON.stringify(await res.json().catch(() => ({}))));
  });

  test('POST /products/:id/channels/web_form/rotate-token: a regular member cannot rotate it', async () => {
    const { status, data } = await call(`/products/${productId}/channels/web_form/rotate-token`, { method: 'POST', headers: { Authorization: `Bearer ${tokenMember}` }, body: {} });
    assert.equal(status, 403, JSON.stringify(data));
  });

  test('POST /products/:id/channels/web_form/rotate-token: an Admin reissues the token - the old one 404s, the new one still creates leads for this product', async () => {
    const { status, data } = await call(`/products/${productId}/channels/web_form/rotate-token`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: {} });
    assert.equal(status, 200, JSON.stringify(data));
    const newToken = data.config.form_token;
    assert.ok(newToken && newToken !== webFormToken, 'rotating must actually change the token');

    const oldRes = await fetch(`${BASE}/forms/${webFormToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(oldRes.status, 404, 'the old token must stop working immediately after rotation');

    const newRes = await fetch(`${BASE}/forms/${newToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'After Rotation' }) });
    const newData = await newRes.json();
    assert.equal(newRes.status, 200, JSON.stringify(newData));

    const { rows } = await db.query('SELECT product_id FROM leads WHERE id=$1', [newData.lead_id]);
    assert.equal(rows[0].product_id, productId, 'the rotated token must still be scoped to the same product');
  });

  // DELETE /products/:id: a real cascading delete against a real database
  // - a fresh, disposable product of its own (not the shared productId
  // above, which later assertions in this file don't depend on staying
  // alive, but keeping this self-contained avoids any risk of that).
  let doomedProductId, doomedAssetId, doomedLeadId;

  test('POST /products (setup): create a disposable product with a member, a lead, and an uploaded content asset', async () => {
    const product = await call('/products', { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: { name: 'Doomed Product' } });
    assert.equal(product.status, 200, JSON.stringify(product.data));
    doomedProductId = product.data.id;

    const assign = await call(`/products/${doomedProductId}/members`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: { user_id: memberId, role: 'MEMBER' } });
    assert.equal(assign.status, 200, JSON.stringify(assign.data));

    // A real lead row scoped to this product - inserted directly rather
    // than through a channel/upload route, since all this test needs is
    // a row that exists with this product_id before the delete, and is
    // gone after it.
    const leadInsert = await db.query(
      `INSERT INTO leads (source_channel, company_name, contact_name, product_id, status) VALUES ('web_form','Doomed Co','Doomed Lead',$1,'NEW') RETURNING id`,
      [doomedProductId]
    );
    doomedLeadId = leadInsert.rows[0].id;

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'doomed.png');
    form.append('product_id', doomedProductId);
    const uploadRes = await fetch(`${BASE}/content/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form });
    const uploadData = await uploadRes.json();
    assert.equal(uploadRes.status, 200, JSON.stringify(uploadData));
    doomedAssetId = uploadData.asset.id;

    const { rows: fileRows } = await db.query('SELECT s3_key FROM content_assets WHERE id=$1', [doomedAssetId]);
    assert.ok(fs.existsSync(fileRows[0].s3_key), 'the uploaded file must really exist on disk before we assert it is gone after delete');
  });

  test('DELETE /products/:id: a regular member cannot delete a product', async () => {
    const { status, data } = await call(`/products/${doomedProductId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenMember}` }, body: { confirm_name: 'Doomed Product' } });
    assert.equal(status, 403, JSON.stringify(data));
  });

  test('DELETE /products/:id: the Admin must retype the exact product name to confirm', async () => {
    const { status, data } = await call(`/products/${doomedProductId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenA}` }, body: { confirm_name: 'the wrong name' } });
    assert.equal(status, 400, JSON.stringify(data));

    // Nothing was touched by the rejected attempt above.
    const { rows } = await db.query('SELECT id FROM products WHERE id=$1', [doomedProductId]);
    assert.equal(rows.length, 1);
  });

  test('DELETE /products/:id: with the correct name, the product and everything scoped to it is really gone', async () => {
    const { rows: fileRowsBefore } = await db.query('SELECT s3_key FROM content_assets WHERE id=$1', [doomedAssetId]);
    const filePath = fileRowsBefore[0].s3_key;

    const { status, data } = await call(`/products/${doomedProductId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenA}` }, body: { confirm_name: 'Doomed Product' } });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.leads_deleted, 1);
    assert.equal(data.content_assets_deleted, 1);

    const { rows: productRows } = await db.query('SELECT id FROM products WHERE id=$1', [doomedProductId]);
    assert.equal(productRows.length, 0, 'the product row itself must be gone');

    const { rows: memberRows } = await db.query('SELECT id FROM product_members WHERE product_id=$1', [doomedProductId]);
    assert.equal(memberRows.length, 0, 'product_members must cascade');

    const { rows: channelRows } = await db.query('SELECT id FROM product_channels WHERE product_id=$1', [doomedProductId]);
    assert.equal(channelRows.length, 0, 'product_channels (including its own dedicated web_form row/token) must cascade');

    const { rows: leadRows } = await db.query('SELECT id FROM leads WHERE id=$1', [doomedLeadId]);
    assert.equal(leadRows.length, 0, 'the lead must be really deleted, not just orphaned with product_id set to NULL');

    const { rows: assetRows } = await db.query('SELECT id FROM content_assets WHERE id=$1', [doomedAssetId]);
    assert.equal(assetRows.length, 0, 'the content asset row must be really deleted');

    // File cleanup happens asynchronously (fs.unlink, fire-and-forget)
    // right after the transaction commits - give it a moment before
    // asserting the file is gone from disk.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fs.existsSync(filePath), false, 'the real file backing the deleted content asset must be removed from disk too');

    // The regular member who used to be on this product is untouched -
    // only the product/its own data was deleted, not the user account.
    const { rows: userRows } = await db.query('SELECT id FROM users WHERE id=$1', [memberId]);
    assert.equal(userRows.length, 1);
  });

  test('DELETE /products/:id: an unknown product 404s', async () => {
    const { status } = await call(`/products/${doomedProductId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenA}` }, body: { confirm_name: 'Doomed Product' } });
    assert.equal(status, 404);
  });
}
