#!/bin/bash
# Encrypts and backs up this deployment's .env file - the one piece of
# durable state that has NO automated backup anywhere else in this repo
# (postgres/backup/backup.sh covers Postgres/Redis/recordings, not
# secrets), and deliberately so: writing decrypted secrets into a daily,
# less-guarded backup volume is its own risk, so this stays manual and
# always encrypted at rest.
#
# What's actually at stake if .env is lost with no copy:
#   - ENCRYPTION_KEY: every channel credential already stored in
#     product_channels.config (WhatsApp/Facebook/Instagram/LinkedIn/
#     YouTube/email tokens and passwords) becomes permanently
#     undecryptable - not just hard to recover, mathematically impossible.
#     Every channel on every product has to be reconfigured from scratch.
#     This is the one that actually matters here.
#   - JWT_SECRET: every existing login session is invalidated the moment
#     you change it (rotating it is the normal fix, not a disaster) -
#     annoying, not catastrophic. Everyone just logs in again.
#   - POSTGRES_PASSWORD / REDIS_PASSWORD / INTERNAL_API_SECRET: regenerate
#     and update both the .env and the running containers together: these
#     just need to match, they're not decrypting anything stored.
#   - SARVAM_API_KEY: recoverable from the Sarvam AI dashboard, not stored
#     anywhere else by this app.
# ENCRYPTION_KEY is the one genuinely irreplaceable secret; back this up
# before you need it, not after.
#
# Usage (from the VPS, in the directory containing .env):
#   GPG_RECIPIENT=you@example.com ./scripts/backup-secrets.sh
#     - encrypts to that GPG public key (recommended - no passphrase to
#       separately remember/lose). Requires that key already imported
#       (gpg --list-keys) on this machine.
#   ./scripts/backup-secrets.sh
#     - no GPG_RECIPIENT set: falls back to symmetric encryption
#       (gpg -c), prompts for a passphrase interactively. Store that
#       passphrase somewhere other than this VPS (a password manager) -
#       a passphrase kept only on the same disk as the encrypted file
#       defeats the point.
#
# Either way, move the resulting .env.<date>.gpg off this VPS afterward
# (download it, or set RCLONE_REMOTE to ship it - see
# postgres/backup/backup.sh for what that variable does. Encrypted, so
# shipping it to the same remote as the other backups is fine).
set -euo pipefail

ENV_FILE="${1:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE not found. Run this from the directory containing your .env, or pass its path: $0 /path/to/.env" >&2
  exit 1
fi

if ! command -v gpg >/dev/null 2>&1; then
  echo "gpg is not installed on this machine. Install it first (e.g. apt-get install -y gnupg / apk add gnupg)." >&2
  exit 1
fi

DATE=$(date +%Y%m%d_%H%M%S)
OUT_DIR=${BACKUP_DIR:-./secrets-backups}
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/env_${DATE}.gpg"

if [ -n "${GPG_RECIPIENT:-}" ]; then
  gpg --yes --output "$OUT" --encrypt --recipient "$GPG_RECIPIENT" "$ENV_FILE"
else
  echo "GPG_RECIPIENT not set - falling back to symmetric encryption. You'll be prompted for a passphrase; store it somewhere other than this VPS." >&2
  gpg --yes --output "$OUT" --symmetric "$ENV_FILE"
fi

chmod 600 "$OUT"
echo "Encrypted secrets backup: $OUT"
echo "Decrypt with: gpg --output .env --decrypt $OUT"

if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  if rclone copyto "$OUT" "${RCLONE_REMOTE%/}/$(basename "$OUT")"; then
    echo "Shipped to $RCLONE_REMOTE"
  else
    echo "WARNING: off-host copy to $RCLONE_REMOTE failed - the local encrypted file above is still good, copy it off this VPS by hand." >&2
  fi
else
  echo "Not shipped off-host (set RCLONE_REMOTE + have rclone installed to do that automatically). Move $OUT off this VPS yourself - e.g. scp it to your laptop, or into a password manager's file storage."
fi
