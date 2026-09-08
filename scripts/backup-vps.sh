#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p $BACKUP_DIR
docker exec orgcomms-postgres pg_dump -U orgcomms orgcomms_prod | gzip > $BACKUP_DIR/postgres_${DATE}.sql.gz
find $BACKUP_DIR -name "*.gz" -mtime +7 -delete
echo "Backup $BACKUP_DIR/postgres_${DATE}.sql.gz"
