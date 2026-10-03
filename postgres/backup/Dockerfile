# Automated Postgres + Redis + recordings backups, running as its own
# container on the `db` network - no host crontab, docker socket, or SSH
# access required. This replaces relying on someone remembering to set up
# scripts/backup-vps.sh in a host crontab (that script still works fine
# for a manual/one-off backup, e.g. right before a risky migration - see
# its own header). Started life covering only Postgres; extended to also
# cover the redisdata and recordings volumes (see backup.sh) since none of
# the three was backed up off the primary VPS disk before this.
FROM postgres:15-alpine
# tini added specifically so crond is never PID 1: dcron calls setpgid()
# on itself during startup, which the kernel refuses (EPERM) for a
# process that is already its own session leader - which PID 1 always
# is inside a container. Without an init in front of it, that single
# setpgid call makes dcron exit immediately, Docker restarts the
# container (restart: unless-stopped), it crashes again right away, and
# the container sits crash-looping forever (visible as repeating
# "setpgid: Operation not permitted" lines in `docker logs`, and as
# "Restarting" in `docker ps`, instead of ever actually running a
# backup). tini becomes PID 1 instead and starts crond as its child, so
# crond is not a session leader and the same setpgid call succeeds.
RUN apk add --no-cache dcron redis tar gzip tini
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
# Daily at 03:00 container time (UTC, unless TZ is set on the container).
RUN echo "0 3 * * * /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["crond", "-f", "-l", "2"]
