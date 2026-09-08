# OrgComms Security Audit & Fixes - v4 Premium
## Date: 2026 - 100 MSMEs Multitenant

VULNERABILITIES FOUND AND FIXED:

1. Secrets in plain .env -> Fixed: Docker Secrets + masked UI + 2FA Reveal + rotation 90d
2. API/Webhooks on landing -> Fixed: Clean dashboard, Integrations behind Super Admin+IT only
3. No RBAC in API -> Fixed: JWT role middleware, HR 7d no revenue no integrations, Sales 30d, etc 403
4. Postgres+Redis exposed 0.0.0.0 -> Fixed: Bind 127.0.0.1, internal network, UFW 22,80,443, RDS SG only EC2
5. No rate limiting / DoS -> Fixed: Nginx limit_req webhook 20r/s api 50r/s, CSV max 10MB 5000 rows, content 100MB
6. CSV Injection & Malware -> Fixed: Sanitize = + - @, email regex, ClamAV sidecar, MIME via libmagic
7. XSS / No validation -> Fixed: zod validation, CSP, X-Frame SAMEORIGIN, strip HTML
8. Containers as root -> Fixed: user 1001:1001, read_only rootfs, no-new-privileges, drop caps
9. No encryption -> Fixed: S3 KMS, RDS encrypted, EBS encrypted, TLS 1.2+, JWT encrypted
10. No audit log -> Fixed: audit_logs table append-only, 1 year retention
11. No backup -> Fixed: pg_dump daily to S3 versioned, PITR, restore script tested
12. Multitenant leak IDOR -> Fixed: RLS tenant_id = current_setting, middleware sets tenant from JWT
13. Content publish without approval -> Fixed: Draft->Pending Approval->Approved->Published, no direct publish
14. No 2FA weak auth -> Fixed: TOTP for Super Admin, session 30min, JWT 15min + refresh 7d
All fixed in this kit.
