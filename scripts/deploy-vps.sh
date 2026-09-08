#!/bin/bash
set -e
if [ ! -f .env.production ]; then echo "Missing .env.production"; exit 1; fi
grep -q "CHANGE_ME\|GENERATE" .env.production && echo "Change secrets!" && exit 1 || echo "Secrets OK"
docker compose -f docker-compose.vps.yml --env-file .env.production up -d
docker compose -f docker-compose.vps.yml --env-file .env.production --profile all-channels up -d
sleep 30
docker ps
curl -f http://127.0.0.1:3000/health && echo "API OK" || echo "Check logs"
