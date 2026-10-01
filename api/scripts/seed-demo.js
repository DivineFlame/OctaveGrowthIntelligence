'use strict';
// Seeds a fully-navigable demo: a handful of signed-in-ready users, two
// Products/Services, every channel in a "configured" state, leads across
// every intake path this app has (webhooks, CSV/Excel import, automated
// discovery, a web form), a few voice-call and lead-discovery run
// histories, and a Content Studio asset moving through its whole
// approve/publish lifecycle. Point it at a disposable demo database (the
// `demo` branch's own deploy, never a real company's database) after
// running the usual migrations - see DEMO.md for the exact steps and the
// login credentials this creates.
//
// HONESTY NOTE, read before relying on this for a walkthrough: everything
// this script writes is data this app already knows how to display -
// lead lists, thread history, call logs, content variants, audit trail -
// so every *screen* in the app has something real to show without any
// live third-party credentials. It does NOT fake a working integration.
// The channel configs below are syntactically valid but use made-up
// hostnames/tokens (smtp.demo-octave.invalid, etc) - so a *new* outbound
// action (sending a reply, publishing new content, placing a new voice
// call, running a new "Find leads" search) will fail against those fake
// endpoints exactly like it would with no credentials at all, the same
// honest "not actually configured" behavior the rest of this app already
// has for an unset SARVAM_VOICE_*/APIFY_API_TOKEN. Only the *historical*
// records (past calls, past discovery runs, past messages) are faked -
// nothing here pretends a live call to Sarvam, Apify, Meta, or an SMTP
// server actually happened.
//
// Idempotent in the common case: re-running it after the first seed
// detects the demo admin's email already exists and exits without
// writing anything twice. It refuses to run at all against a database
// that already has real signup/users data under some OTHER email (the
// signature of an actual deployment, not a fresh demo database) unless
// you pass --force - this script is destined for a disposable demo
// database, not a safety net for a production one.

const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cryptoSecrets = require('../src/crypto-secrets');
const channelsLib = require('../src/channels');
const { detectLanguage, extractGstin } = require('../src/lead-enrichment');

const FORCE = process.argv.includes('--force');
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'OctaveDemo#2026';
const DEMO_DOMAIN = 'demo.octave.invalid'; // a domain that can never resolve - every demo email/channel endpoint below lives under it so nothing here is one typo away from a real address

// ---- Identity -------------------------------------------------------------
// Four users covering the roles this app's hierarchy/RBAC actually
// branches on: a company-wide Admin, a Manager (DEPT_ADMIN - owns both
// demo products, can approve content, can see/assign the reports below),
// and two of that Manager's reports (a Sales rep and a Content creator) -
// see README.md "User hierarchy". All four share one password so a demo
// walkthrough only has to remember one thing.
const USERS = [
  { key: 'admin', email: 'admin@demo.octave', role: 'SUPER_ADMIN', reportsTo: null },
  { key: 'manager', email: `manager@${DEMO_DOMAIN}`, role: 'DEPT_ADMIN', reportsTo: 'admin' },
  { key: 'sales', email: `sales@${DEMO_DOMAIN}`, role: 'SALES_LEAD', reportsTo: 'manager' },
  { key: 'creator', email: `creator@${DEMO_DOMAIN}`, role: 'CONTENT_CREATOR', reportsTo: 'manager' }
];

const PRODUCTS = [
  { key: 'furnishings', name: 'Aarav Home Furnishings', description: 'D2C furniture brand - WhatsApp/Instagram-led sales with a website contact form.' },
  { key: 'kitchen', name: 'Nimbus Cloud Kitchen', description: 'Multi-city cloud kitchen - email/LinkedIn B2B catering leads plus inbound calls.' }
];

const ALL_CHANNELS = ['whatsapp', 'facebook', 'instagram', 'linkedin', 'youtube', 'web_form', 'email'];

async function main() {
  const connectionString = process.env.DATABASE_URL
    || `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@postgres:5432/${process.env.POSTGRES_DB}`;
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  console.log('[seed-demo] connected');

  try {
    // --- Safety guard -----------------------------------------------------
    const adminEmail = USERS[0].email;
    const existingDemoAdmin = await client.query('SELECT id FROM users WHERE email=$1', [adminEmail]);
    if (existingDemoAdmin.rows.length) {
      console.log(`[seed-demo] ${adminEmail} already exists - demo data looks already seeded. Nothing to do.`);
      return;
    }

    // A previous run of this script may have seeded under an earlier
    // version of adminEmail (e.g. the admin account's domain changed
    // since). Recognize that case by its signature - the other three
    // demo accounts already exist under DEMO_DOMAIN - and repair it in
    // place with a rename instead of either refusing outright or trying
    // to re-run the whole seed (which would hit duplicate-email/duplicate-
    // product conflicts on everything that's already there).
    const legacyAdmin = await client.query(
      "SELECT id, email FROM users WHERE role='SUPER_ADMIN' AND email LIKE '%@demo.octave%' AND email<>$1",
      [adminEmail]
    );
    const otherDemoAccountsExist = await client.query(
      'SELECT 1 FROM users WHERE email=$1 OR email=$2',
      [USERS[1].email, USERS[2].email]
    );
    if (legacyAdmin.rows.length && otherDemoAccountsExist.rows.length) {
      await client.query('UPDATE users SET email=$1 WHERE id=$2', [adminEmail, legacyAdmin.rows[0].id]);
      console.log(`[seed-demo] renamed existing demo admin ${legacyAdmin.rows[0].email} -> ${adminEmail}. Demo data was already seeded - nothing else to do.`);
      return;
    }

    const anyOtherUser = await client.query('SELECT 1 FROM users LIMIT 1');
    if (anyOtherUser.rows.length && !FORCE) {
      console.error(
        '[seed-demo] This database already has user(s) that are not the demo users, and the demo admin ' +
        `(${adminEmail}) does not exist yet. Refusing to seed demo data into what looks like a real ` +
        'deployment\'s database. Re-run with --force if you are certain this is a disposable demo database.'
      );
      process.exitCode = 1;
      return;
    }

    // --- Required secrets ---------------------------------------------------
    // Same requirement the real app has at boot (requireSecretOrExit in
    // server.js) - ENCRYPTION_KEY has to be real for channel secrets to be
    // stored at all. Fail loudly here rather than silently writing
    // unencrypted/garbage config.
    const encryptionKeyValue = process.env.ENCRYPTION_KEY;
    if (!encryptionKeyValue) {
      console.error('[seed-demo] ENCRYPTION_KEY is not set - this must run with the same environment the api container runs with.');
      process.exitCode = 1;
      return;
    }
    const encryptionKeyBuf = crypto.createHash('sha256').update(encryptionKeyValue).digest();
    const encryptSecret = (plaintext) => cryptoSecrets.encrypt(plaintext, encryptionKeyBuf);

    await client.query('BEGIN');

    // --- Roles (idempotent - matches postgres/init-secure.sql's own seed) ---
    await client.query(
      `INSERT INTO roles VALUES
        ('HR_ADMIN',7,false,false,false,false,false),
        ('SALES_LEAD',30,true,false,false,false,false),
        ('CONTENT_CREATOR',30,false,false,false,false,false),
        ('APPROVER',90,true,false,true,false,false),
        ('DEPT_ADMIN',90,true,false,true,true,true),
        ('IT_ADMIN',NULL,true,true,true,true,true),
        ('SUPER_ADMIN',NULL,true,true,true,true,true)
       ON CONFLICT (name) DO NOTHING`
    );

    // --- Company --------------------------------------------------------
    const existingCompany = await client.query('SELECT id FROM company LIMIT 1');
    let companyId;
    if (existingCompany.rows.length) {
      companyId = existingCompany.rows[0].id;
      await client.query(`UPDATE company SET name='Octave Demo Co', is_premium=true WHERE id=$1`, [companyId]);
    } else {
      const webhookSecret = crypto.randomBytes(24).toString('hex');
      const companyRows = await client.query(
        `INSERT INTO company (name, is_premium, webhook_secret) VALUES ('Octave Demo Co', true, $1) RETURNING id`,
        [webhookSecret]
      );
      companyId = companyRows.rows[0].id;
    }

    // Signup is a one-shot bootstrap route (see server.js's comment on
    // POST /auth/signup) - claim it the same way a real signup would, so
    // the seeded admin is the only way into this demo, not an open
    // "create the first account" screen sitting next to already-seeded
    // data.
    await client.query(`INSERT INTO system_flags (key, value) VALUES ('signup_used', 'true') ON CONFLICT (key) DO NOTHING`);

    // --- Users ------------------------------------------------------------
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
    const userIds = {};
    for (const u of USERS) {
      const roleRow = await client.query('SELECT * FROM roles WHERE name=$1', [u.role]);
      const r = roleRow.rows[0];
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, role, max_history_days, can_view_revenue, can_view_integrations, can_approve_content, reports_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [u.email, passwordHash, u.role, r.max_history_days, r.can_view_revenue, r.can_view_integrations, r.can_approve_content, u.reportsTo ? userIds[u.reportsTo] : null]
      );
      userIds[u.key] = rows[0].id;
    }
    console.log(`[seed-demo] created ${USERS.length} users (password for all: ${DEMO_PASSWORD})`);

    // --- Products + their 7 channel rows (mirrors POST /products) --------
    const productIds = {};
    for (const p of PRODUCTS) {
      const { rows } = await client.query(
        'INSERT INTO products (name, description, created_by) VALUES ($1,$2,$3) RETURNING id',
        [p.name, p.description, userIds.admin]
      );
      productIds[p.key] = rows[0].id;
      for (const channel of ALL_CHANNELS) {
        const isWebForm = channel === 'web_form';
        const initialConfig = isWebForm ? { form_token: crypto.randomBytes(16).toString('hex') } : {};
        await client.query(
          `INSERT INTO product_channels (product_id, channel, status, config) VALUES ($1,$2,$3,$4) ON CONFLICT (product_id, channel) DO NOTHING`,
          [productIds[p.key], channel, isWebForm ? 'configured' : 'not_configured', JSON.stringify(initialConfig)]
        );
      }
    }

    // Manager administers both products; Sales/Creator each get one.
    for (const key of Object.values(productIds)) {
      await client.query(`INSERT INTO product_members (product_id, user_id, role) VALUES ($1,$2,'ADMIN') ON CONFLICT DO NOTHING`, [key, userIds.manager]);
    }
    await client.query(`INSERT INTO product_members (product_id, user_id, role) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [productIds.furnishings, userIds.sales]);
    await client.query(`INSERT INTO product_members (product_id, user_id, role) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [productIds.kitchen, userIds.creator]);

    // --- Configure every real-content channel with syntactically valid,
    // made-up credentials (see the honesty note at the top of this file) ---
    const DEMO_CHANNEL_CONFIG = {
      email: {
        smtp_host: 'smtp.' + DEMO_DOMAIN, smtp_port: '587', smtp_secure: 'true',
        smtp_user: 'notifications@' + DEMO_DOMAIN, smtp_pass: 'demo-smtp-password',
        from_email: 'leads@' + DEMO_DOMAIN, to_default: ''
      },
      whatsapp: {
        auth_id: 'MA00DEMO00000000000000000000000001', auth_token: 'demo-whatsapp-auth-token',
        channel_id: 'demo-channel-001', waba_id: 'demo-waba-001',
        default_recipient: '+919800000001', broadcast_template_name: 'demo_broadcast', broadcast_template_language: 'en_US'
      },
      facebook: { page_id: 'demo-fb-page-001', access_token: 'demo-fb-access-token' },
      instagram: { ig_user_id: 'demo-ig-account-001', access_token: 'demo-ig-access-token' },
      linkedin: { organization_urn: 'urn:li:organization:1000001', access_token: 'demo-li-access-token' }
      // youtube deliberately left 'not_configured' - a real Google OAuth
      // refresh_token can't be meaningfully faked, and "not yet connected"
      // is itself the honest, realistic state for a channel nobody has
      // gone through Google's consent flow for yet.
    };
    for (const productKey of Object.keys(productIds)) {
      for (const [channel, config] of Object.entries(DEMO_CHANNEL_CONFIG)) {
        const encrypted = channelsLib.encryptChannelSecrets(channel, config, encryptSecret);
        await client.query(
          `UPDATE product_channels SET status='configured', config=$1, updated_at=NOW() WHERE product_id=$2 AND channel=$3`,
          [JSON.stringify(encrypted), productIds[productKey], channel]
        );
      }
    }

    // --- Leads: one realistic batch per product, across every intake path
    // this app actually has. `note` is folded into the same rawText
    // detectLanguage()/extractGstin() would see in the real routes - never
    // stored as its own column, matching how CSV/Excel import already
    // discard it after enrichment.
    const CSV_UPLOAD_NOTE = 'Bulk-imported from a spreadsheet of trade-show sign-ups.';
    const LEADS_BY_PRODUCT = {
      furnishings: [
        { company: 'Rao Interiors', contact: 'Ananya Rao', phone: '+91 98450 11223', email: 'ananya@raointeriors.demo', channel: 'whatsapp', inquiry: true, note: 'Interested in the walnut dining set, GSTIN 29AAAPL1234C1Z5' },
        { company: 'Blue Lotus Hotels', contact: 'Vikram Shetty', phone: '080-4123-5566', email: 'vikram@bluelotus.demo', channel: 'email', inquiry: true, note: 'Need 40 rooms furnished, budget pending' },
        { company: '', contact: 'Priya Menon', phone: '9123456780', email: 'priya.menon@gmail.demo', channel: 'instagram', inquiry: true, note: 'DMed about the sofa in your last reel' },
        { company: 'Satyam Furnishings Pvt Ltd', contact: 'Ramesh Iyer', phone: '+919845550011', email: 'ramesh@satyamfurnish.demo', channel: 'facebook', inquiry: false, note: 'Just liked a post, not a real inquiry' },
        { company: '', contact: '', phone: '', email: 'webvisitor42@demo.octave.invalid', channel: 'web_form', inquiry: true, note: 'Submitted the Contact Us form on the website' },
        { company: 'Coral Bay Resorts', contact: 'Fatima Noor', phone: '+91 90000 44556', email: 'fatima@coralbay.demo', channel: 'linkedin', inquiry: null, note: 'Connection request with a note, unclassified yet' },
        { company: 'Heritage Woodworks', contact: 'Devika Nair', phone: '044-2345-6789', email: '', channel: 'csv_upload', inquiry: null, note: CSV_UPLOAD_NOTE + ' GSTIN 33AABCU9603R1ZM' },
        { company: 'Mehta Home Decor', contact: 'Karan Mehta', phone: '9988776655', email: 'karan@mehtahomedecor.demo', channel: 'excel_upload', inquiry: null, note: 'Spreadsheet import test row, no note' },
        { company: 'Ashoka Banquets', contact: 'Sunita Reddy', phone: '+91 98760 12121', email: 'sunita@ashokabanquets.demo', channel: 'lead_discovery', inquiry: null, note: 'Banquet hall, 120 covers, MG Road' },
        { company: 'Sharma Designs', contact: 'Rohit Sharma', phone: '7000011223', email: 'rohit@sharmadesigns.demo', channel: 'whatsapp', inquiry: true, note: 'Wants a quote for office furniture, 25 desks' }
      ],
      kitchen: [
        { company: 'TechNova Solutions', contact: 'Arjun Kapoor', phone: 'arjun@technova.demo', email: 'arjun@technova.demo', channel: 'email', inquiry: true, note: 'Daily lunch catering for 150 employees, GSTIN 07AAACT2727Q1ZS' },
        { company: 'Ivory Events', contact: 'Meera Pillai', phone: '+91 99000 55667', email: 'meera@ivoryevents.demo', channel: 'linkedin', inquiry: true, note: 'Corporate event catering RFP' },
        { company: '', contact: 'Zoya Khan', phone: '9321456780', email: 'zoya.k@demo.octave.invalid', channel: 'whatsapp', inquiry: true, note: 'Asked for the weekly tiffin menu and pricing' },
        { company: 'Greenfield Logistics', contact: 'Suresh Pillai', phone: '0124-4556677', email: 'suresh@greenfield.demo', channel: 'facebook', inquiry: false, note: 'Commented on a giveaway post' },
        { company: '', contact: '', phone: '', email: 'formlead07@demo.octave.invalid', channel: 'web_form', inquiry: true, note: 'Submitted the cloud kitchen partnership form' },
        { company: 'Orbit Startups Hub', contact: 'Lakshmi Narayanan', phone: '+91 98400 33221', email: 'lakshmi@orbitstartups.demo', channel: 'instagram', inquiry: null, note: 'Unclassified DM' },
        { company: 'BrightPath School', contact: 'Imran Siddiqui', phone: '080-6677-8899', email: '', channel: 'csv_upload', inquiry: null, note: CSV_UPLOAD_NOTE },
        { company: 'Falcon Analytics', contact: 'Divya Krishnan', phone: '9876501234', email: 'divya@falconanalytics.demo', channel: 'excel_upload', inquiry: null, note: 'Spreadsheet import test row' },
        { company: 'Mint Coworking', contact: 'Harsha Vardhan', phone: '+91 97400 22110', email: 'harsha@mintcoworking.demo', channel: 'lead_discovery', inquiry: null, note: 'Coworking space, 80 seats, HSR Layout' },
        { company: 'Solaris Energy Pvt Ltd', contact: 'Neha Agarwal', phone: '9000112233', email: 'neha@solarisenergy.demo', channel: 'email', inquiry: true, note: 'Weekly office lunch quote request' }
      ]
    };

    const leadIds = {}; // productKey -> array of { id, phone, company }
    const csvUploadIds = {}; // productKey -> upload id
    for (const [productKey, leads] of Object.entries(LEADS_BY_PRODUCT)) {
      leadIds[productKey] = [];
      const csvRowCount = leads.filter((l) => l.channel === 'csv_upload' || l.channel === 'excel_upload').length;
      const upload = await client.query(
        `INSERT INTO csv_uploads (uploaded_by, file_name, file_size, rows_total, rows_valid, rows_duplicate, rows_invalid, virus_scan_status, status)
         VALUES ($1,$2,$3,$4,$5,0,0,'CLEAN','COMPLETED') RETURNING id`,
        [userIds.manager, 'demo-leads-import.xlsx', 18432, csvRowCount, csvRowCount]
      );
      csvUploadIds[productKey] = upload.rows[0].id;

      for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        const rawText = [lead.company, lead.contact, lead.note].filter(Boolean).join(' ');
        const detectedLanguage = detectLanguage(rawText);
        const gstinResult = extractGstin(rawText);
        const isUpload = lead.channel === 'csv_upload' || lead.channel === 'excel_upload';
        const { rows } = await client.query(
          `INSERT INTO leads (company_name, contact_name, phone, email, source_channel, status, csv_upload_id, product_id, detected_language, gstin, gstin_valid, is_inquiry, assigned_to)
           VALUES ($1,$2,$3,$4,$5,'NEW',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            lead.company, lead.contact, lead.phone, lead.email, lead.channel,
            isUpload ? csvUploadIds[productKey] : null, productIds[productKey], detectedLanguage,
            gstinResult ? gstinResult.gstin : null, gstinResult ? gstinResult.valid : null,
            lead.inquiry, (i % 3 === 0) ? userIds.sales : null
          ]
        );
        leadIds[productKey].push({ id: rows[0].id, phone: lead.phone, company: lead.company || lead.contact || 'this lead' });
      }
    }
    console.log(`[seed-demo] created ${Object.values(LEADS_BY_PRODUCT).reduce((n, l) => n + l.length, 0)} leads across ${PRODUCTS.length} products`);

    // --- A short reply thread on the first couple of leads per product,
    // so the Thread view has something to show beyond an empty inbox. ---
    for (const productKey of Object.keys(leadIds)) {
      const [first, second] = leadIds[productKey];
      if (first) {
        await client.query(
          `INSERT INTO lead_messages (lead_id, direction, channel, body, sent_by) VALUES
             ($1,'inbound','whatsapp',$2,NULL),
             ($1,'outbound','whatsapp',$3,$4)`,
          [first.id, `Hi, is this still available? - ${first.company}`, 'Yes! Happy to share pricing - could you tell me your city and quantity needed?', userIds.sales]
        );
      }
      if (second) {
        await client.query(
          `INSERT INTO lead_messages (lead_id, direction, channel, body) VALUES ($1,'inbound','email',$2)`,
          [second.id, `Following up on our catering requirement - ${second.company}. Could someone call us back today?`]
        );
      }
    }

    // --- Automated discovery history (no live Apify call - see the
    // honesty note at the top of this file) ---
    await client.query(
      `INSERT INTO lead_discovery_runs (product_id, requested_by, query, location, status, leads_found, leads_imported, leads_duplicate, created_at) VALUES
         ($1,$2,'banquet halls','Bengaluru','COMPLETED',14,11,3,NOW() - INTERVAL '3 days'),
         ($3,$2,'coworking spaces','Bengaluru HSR Layout','COMPLETED',9,8,1,NOW() - INTERVAL '1 day'),
         ($3,$4,'cloud kitchens','Mumbai','FAILED',0,0,0,NOW() - INTERVAL '5 hours')`,
      [productIds.furnishings, userIds.manager, productIds.kitchen, userIds.admin]
    );
    await client.query(
      `UPDATE lead_discovery_runs SET error='Could not reach the lead discovery service (timed out).' WHERE status='FAILED' AND query='cloud kitchens'`
    );

    // --- Voice Agent call history (no live Sarvam call) ---
    const callableLeads = [...leadIds.furnishings, ...leadIds.kitchen].filter((l) => l.phone && /\d{6,}/.test(l.phone));
    if (callableLeads.length >= 3) {
      await client.query(
        `INSERT INTO voice_calls (lead_id, initiated_by, to_number, from_number, provider, attempt_id, status, duration_seconds, recording_url, created_at, updated_at) VALUES
           ($1,$2,$3,'+919800099001','sarvam','demo-attempt-001','completed',96,'https://demo.octave.invalid/recordings/demo-attempt-001.mp3', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`,
        [callableLeads[0].id, userIds.sales, callableLeads[0].phone]
      );
      await client.query(
        `INSERT INTO voice_calls (lead_id, initiated_by, to_number, from_number, provider, attempt_id, status, error, created_at, updated_at) VALUES
           ($1,$2,$3,'+919800099001','sarvam','demo-attempt-002','failed','The number did not answer.', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`,
        [callableLeads[1].id, userIds.manager, callableLeads[1].phone]
      );
      await client.query(
        `INSERT INTO voice_calls (lead_id, initiated_by, to_number, from_number, provider, attempt_id, status, created_at, updated_at) VALUES
           ($1,$2,$3,'+919800099001','sarvam','demo-attempt-003','ringing', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')`,
        [callableLeads[2].id, userIds.sales, callableLeads[2].phone]
      );
    }

    // --- Content Studio: a real tiny PNG per product, with variants moving
    // through the full DRAFT -> APPROVED -> PUBLISHED / REJECTED /
    // PUBLISH_FAILED lifecycle, so Studio has something to approve and
    // something already resolved either way. ---
    const uploadDir = process.env.UPLOAD_DIR || '/app/recordings';
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch { /* best-effort */ }
    // Smallest possible valid PNG (a 1x1 transparent pixel) - real bytes on
    // disk, not a fabricated file_size, so anything that actually reads the
    // file (a file-serving route, a resize) gets real image data back.
    const TINY_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUAAScY42YAAAAASUVORK5CYII=',
      'base64'
    );

    // Status values mirror exactly what the real transform/approve routes
    // produce (see POST /content/:assetId/transform and POST
    // /content/variants/:variantId/approve in server.js, and
    // StatusBadge.jsx for the UI's full set): a fresh transform starts
    // PENDING_APPROVAL, APPROVE/REJECT/REQUEST_CHANGE move it to
    // APPROVED/REJECTED/DRAFT, and only a later publish attempt moves an
    // APPROVED variant on to PUBLISHED or PUBLISH_FAILED. Each product
    // gets one PENDING_APPROVAL variant left exactly where a real
    // transform would leave it - so the Approve/Reject buttons in Studio
    // are genuinely clickable in this demo, writing a real approvals row
    // via the real route, no third-party credentials required.
    const CONTENT_PLAN = {
      furnishings: { title: 'New Collection Launch', variants: [
        { channel: 'whatsapp', status: 'PUBLISHED', publishedUrl: 'https://demo.octave.invalid/whatsapp/msg/demo-001' },
        { channel: 'instagram', status: 'APPROVED' },
        { channel: 'facebook', status: 'PENDING_APPROVAL' }
      ] },
      kitchen: { title: 'Weekly Catering Menu', variants: [
        { channel: 'email', status: 'PUBLISH_FAILED', publishError: 'Could not connect to smtp.demo.octave.invalid (demo credentials, not a real mail server).' },
        { channel: 'linkedin', status: 'REJECTED' },
        { channel: 'whatsapp', status: 'DRAFT', comment: 'Please shorten the opening line and resend for another look.' }
      ] }
    };

    for (const [productKey, plan] of Object.entries(CONTENT_PLAN)) {
      const fileName = `demo-${productKey}-${Date.now()}.png`;
      const diskPath = path.join(uploadDir, fileName);
      try { fs.writeFileSync(diskPath, TINY_PNG); } catch (e) { console.warn(`[seed-demo] could not write demo asset to ${diskPath}: ${e.message} (continuing - DB rows will still reference this path)`); }

      const asset = await client.query(
        `INSERT INTO content_assets (uploaded_by, product_id, file_name, file_size, mime_type, s3_key, virus_scan_status) VALUES ($1,$2,$3,$4,'image/png',$5,'CLEAN') RETURNING id`,
        [userIds.creator, productIds[productKey], `${plan.title}.png`, TINY_PNG.length, diskPath]
      );
      const assetId = asset.rows[0].id;

      for (const v of plan.variants) {
        const alreadyDecided = v.status !== 'PENDING_APPROVAL'; // PENDING_APPROVAL is where a fresh transform leaves it - no decision made yet
        const variant = await client.query(
          `INSERT INTO content_variants (asset_id, channel, spec, s3_key, title, status, approved_by, published_url, published_at, publish_error)
           VALUES ($1,$2,'1080x1080',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            assetId, v.channel, diskPath, plan.title, v.status,
            alreadyDecided ? userIds.manager : null,
            v.publishedUrl || null,
            v.status === 'PUBLISHED' ? new Date() : null,
            v.publishError || null
          ]
        );
        if (alreadyDecided) {
          // Matches exactly what POST /content/variants/:id/approve
          // itself writes: APPROVE -> 'APPROVED' (whether or not a later
          // publish attempt then succeeded/failed), REJECT -> 'REJECTED',
          // REQUEST_CHANGE -> 'DRAFT'.
          const approvalStatus = v.status === 'REJECTED' ? 'REJECTED' : v.status === 'DRAFT' ? 'DRAFT' : 'APPROVED';
          const comment = v.comment || (v.status === 'REJECTED' ? 'Not on-brand for this quarter - please rework the copy.' : 'Looks good, approved.');
          await client.query(
            `INSERT INTO approvals (variant_id, requested_by, approved_by, status, comment) VALUES ($1,$2,$3,$4,$5)`,
            [variant.rows[0].id, userIds.creator, userIds.manager, approvalStatus, comment]
          );
        }
      }
    }
    console.log('[seed-demo] created 2 content assets with variants across the full approve/publish lifecycle');

    // --- A handful of plausible audit log entries (SUPER_ADMIN/IT_ADMIN
    // only screen - GET /audit-logs) so that screen isn't empty either. ---
    await client.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, result, details, created_at) VALUES
         ($1,'CREATE_PRODUCT','product',$2,'SUCCESS','{"name":"Aarav Home Furnishings"}',NOW() - INTERVAL '6 days'),
         ($1,'CREATE_PRODUCT','product',$3,'SUCCESS','{"name":"Nimbus Cloud Kitchen"}',NOW() - INTERVAL '6 days'),
         ($4,'CONFIGURE_PRODUCT_CHANNEL','product',$2,'SUCCESS','{"channel":"whatsapp"}',NOW() - INTERVAL '5 days'),
         ($4,'IMPORT_EXCEL','csv_upload',$5,'SUCCESS','{"rows_total":5,"valid":5}',NOW() - INTERVAL '4 days'),
         ($1,'DISCOVER_LEADS','lead_discovery_run',NULL,'FAILED','{"query":"cloud kitchens","error":"timed out"}',NOW() - INTERVAL '5 hours')`,
      [userIds.admin, productIds.furnishings, productIds.kitchen, userIds.manager, csvUploadIds.furnishings]
    );

    await client.query('COMMIT');
    console.log('[seed-demo] done.');
    console.log('[seed-demo] log in with any of:');
    for (const u of USERS) console.log(`  ${u.email}  (${u.role})`);
    console.log(`  password: ${DEMO_PASSWORD}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[seed-demo] failed:', e);
  process.exitCode = 1;
});
