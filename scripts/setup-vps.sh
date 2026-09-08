#!/bin/bash
set -e
DOMAIN=${1:-yourdomain.com}
EMAIL=${2:-admin@yourdomain.com}
echo "=== OrgComms VPS Setup for $DOMAIN ==="
apt-get update -y
apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx ufw fail2ban htop
systemctl enable --now docker
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
mkdir -p /var/www/orgcomms/app /var/www/certbot /opt/orgcomms/backups
cp ./nginx/orgcomms-vps.conf /etc/nginx/sites-available/orgcomms || true
sed -i "s/yourdomain.com/$DOMAIN/g" /etc/nginx/sites-available/orgcomms
ln -sf /etc/nginx/sites-available/orgcomms /etc/nginx/sites-enabled/orgcomms
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
certbot certonly --webroot -w /var/www/certbot -d api.$DOMAIN -d app.$DOMAIN --email $EMAIL --agree-tos --no-eff-email --non-interactive || certbot --nginx -d api.$DOMAIN -d app.$DOMAIN --email $EMAIL --agree-tos --no-eff-email --non-interactive || true
(crontab -l 2>/dev/null | grep -v certbot; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
(crontab -l 2>/dev/null; echo "0 2 * * * cd /opt/orgcomms && bash scripts/backup-vps.sh >> /opt/orgcomms/logs/backup.log 2>&1") | crontab -
echo "Setup complete. Next: cp .env.vps.example .env.production && nano .env.production && bash scripts/deploy-vps.sh"
