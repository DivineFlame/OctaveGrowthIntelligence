# Automated Postgres + Redis + recordings backups, running as its own
# container on the `db` network - no host crontab, docker socket, or SSH
# access required. This replaces relying on someone remembering to set up
# scripts/backup-vps.sh in a host crontab (that script still works fine
# for a manual/one-off backup, e.g. right before a risky migration - see
# its own header). Started life covering only Postgres; extended to also
# cover the redisdata and recordings volumes (see backup.sh) since none of
# the three was backed up off the primary VPS disk before this.
FROM postgres:15-alpine
RUN apk add --no-cache dcron redis tar gzip
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
# Daily at 03:00 container time (UTC, unless TZ is set on the container).
RUN echo "0 3 * * * /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
CMD ["crond", "-f", "-l", "2"]
