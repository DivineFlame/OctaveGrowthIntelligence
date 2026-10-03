# Disaster recovery runbook

This describes what to do when the VPS running OrgComms is lost, corrupted,
or needs to be rebuilt from scratch - and, just as important, what state
survives that and what doesn't. It's written from what's actually in this
repo (`docker-compose.vps.yml`, `scripts/`, `postgres/backup/`), not an
idealized setup - see "Known gaps" at the end for what isn't covered yet.

A backup nobody has restored is not a tested backup. If you make any
change to backup/restore behavior, re-run the "Rebuild from zero" drill
below against a throwaway VPS at least once.

## What's backed up, what isn't

| Data | Backed up? | How |
|---|---|---|
| Postgres (`pgdata` volume) | Yes, automatically | `postgres-backup` sidecar runs `pg_dump` daily, 7-day local retention in the `pgbackups` volume. Optional off-host shipping via `rclone` if `RCLONE_REMOTE` is set (see `postgres/backup/backup.sh`) - **unset by default**, meaning backups are local-only unless you've explicitly configured this. |
| `.env.production` (all secrets) | **No** | Not in git, not in any Docker volume, not touched by any backup script. See "Secrets: the real single point of failure" below - this is the most important thing in this document. |
| Redis (`redisdata` volume) | No | AOF persistence (`--appendonly yes`) protects against a container restart, but nothing backs up the volume itself. See "What losing Redis actually costs" below - it's not just a cache. |
| Uploaded files (`recordings` volume) | No | `content_assets` rows in Postgres point to files on this volume by path. If the volume is lost independently of the database, those rows become broken links. |
| ClamAV virus definitions (`clamav_data`) | No, and doesn't need to be | Re-downloaded automatically on container start; not user data. |

## Secrets: the real single point of failure

`JWT_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and
`INTERNAL_API_SECRET` all live only in `.env.production` on the VPS. None
of this repo's backup tooling touches that file.

- Losing `JWT_SECRET` is recoverable but disruptive: every existing session
  becomes invalid at once (every user has to log in again). Annoying, not
  catastrophic.
- **Losing `ENCRYPTION_KEY` is not recoverable.** `api/src/crypto-secrets.js`
  uses it (via `ENCRYPTION_KEY_BUF`) to encrypt integration secrets stored
  in Postgres - LLM API keys, webhook secrets, anything a tenant has
  connected. If this key is gone, those encrypted values in an otherwise
  perfectly restored database are permanently unreadable. There is no
  recovery path except every affected tenant re-entering those secrets
  from scratch.

**Action: keep an encrypted, off-VPS copy of `.env.production`** (a
password manager, a secrets vault, an encrypted file in cold storage -
anything that isn't "only on the VPS" and isn't plaintext in git). This
isn't optional infrastructure hardening, it's the difference between a
bad afternoon and permanently losing every tenant's connected
integrations. If this file doesn't exist anywhere except the VPS right
now, treat that as the most urgent item in this whole document.

## What losing Redis actually costs

Redis is mostly just a cache today. There used to be real job queues
(`redisClient.lPush` onto things like `publisher:queue`) sitting behind
the old `hermes-orchestrator` worker container, but that container and
every `lPush` call with it were removed - grep `api/src/server.js` for
`redisClient.` and you'll find only `connect()`/`ping()`/`quit()` now.
Content publishing happens synchronously in-process when a variant is
approved (`publishContentVariant()` in `api/src/server.js`), not via a
Redis-queued job, so there is no longer a job that can be sitting in
Redis at the moment the volume is lost.

What's actually in Redis now: rate-limiter counters
(`api/src/rate-limiters.js` - harmless to lose, everyone's limits just
reset) and whatever session/cache state the app keeps there. Losing the
`redisdata` volume just resets those - no in-flight work is lost with it.

**If a publish does fail** (a channel's API down, a token expired, a
network blip) it's recorded as `content_variants.status = 'PUBLISH_FAILED'`
with the error in `publish_error` - that's a Postgres row, not a Redis
job, so it survives a Redis incident fine, but it is *not* retried
automatically. Use `./scripts/recover-stuck-publishes.sh` (needs
`INTERNAL_API_SECRET`) to retry every `PUBLISH_FAILED` variant by hand.

## Restoring Postgres (data loss, corruption, bad migration)

This is the one fully scripted path in this repo.

```sh
# On the VPS, from the repo root, with the stack running:
./scripts/restore-vps.sh /opt/orgcomms/backups/postgres_YYYYMMDD_HHMMSS.sql.gz
```

- Finds the running `postgres` container by its Compose service label
  (works regardless of the project name Dokploy or `docker compose`
  assigns).
- **Destructive**: drops and recreates the `public` schema before
  loading the dump. Confirms interactively unless `CONFIRM=yes` is set.
- Backups live in the `pgbackups` volume (written by the
  `postgres-backup` sidecar) or wherever `scripts/backup-vps.sh` was
  pointed via `BACKUP_DIR` for an on-demand backup.

After restoring, run `./scripts/smoke-test.sh` against the live domain to
confirm the API is actually serving correctly against the restored data,
not just that the container is up.

## Rebuild from zero (VPS itself is gone)

1. **Provision a new VPS**, point DNS at it (`API_DOMAIN`/`APP_DOMAIN`
   from your old `.env.production` - reuse the same values so nothing
   downstream needs to change).
2. **Recover `.env.production`** from your off-VPS copy (see "Secrets"
   above). If you don't have one, this is where that gap gets expensive -
   you'll need to regenerate every secret and accept that any
   `ENCRYPTION_KEY`-encrypted data in a restored database is unreadable.
3. Clone the repo, then:
   ```sh
   ./scripts/setup-vps.sh yourdomain.com admin@yourdomain.com
   ```
   Installs Docker, nginx, certbot, ufw, fail2ban; requests TLS certs;
   installs the certbot-renewal and `backup-vps.sh` cron jobs.
4. `cp .env.production` into place (from step 2), then:
   ```sh
   ./scripts/deploy-vps.sh
   ```
   Refuses to start if `.env.production` still has any `CHANGE_ME`/
   `GENERATE` placeholder left in it. Brings up the full stack, including
   `all-channels` profile services, and runs a basic health check.
5. `postgres`/`redis` come up empty - **restore Postgres now**, before
   real traffic hits the new box:
   ```sh
   ./scripts/restore-vps.sh /path/to/latest/postgres_*.sql.gz
   ```
   (Copy the backup file to the new VPS first - from your off-host
   `rclone` destination if that was configured, or wherever the old
   VPS's `pgbackups` volume was extracted to before it was destroyed. If
   neither exists, there is no Postgres data to recover - this is the
   local-only-backups gap in the table above.)
6. Redis and `recordings` come up empty with no restore path (see the
   gaps above) - expect the manual queue-recovery step from "What losing
   Redis actually costs," and expect any `content_assets` rows whose
   underlying file lived only in the old VPS's `recordings` volume to
   have a broken download until re-uploaded.
7. Run `./scripts/smoke-test.sh https://api.yourdomain.com` to confirm
   the rebuilt stack is actually healthy before calling this done.

## Known gaps (honest, not yet fixed)

- **No off-VPS secrets backup exists by default.** See "Secrets" above -
  this is the single highest-value fix if you're prioritizing from this
  list.
- **Off-host Postgres backup shipping (`RCLONE_REMOTE`) is opt-in and
  unset by default** - out of the box, a backup and its only VPS are the
  same failure domain.
- **`redisdata` and `recordings` have no backup at all**, scripted or
  otherwise - see the impact sections above for what that costs in
  practice.
- **No scripted recovery for jobs stuck mid-queue** after a Redis loss -
  it's a manual Postgres query today, described above but not automated.
