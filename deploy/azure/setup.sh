#!/bin/bash
# =====================================================================================
#  Tally Books: set up an online server on Azure (Ubuntu Server 24.04 LTS)
#
#  Paste this whole file into "Custom data" (Advanced tab) when you create the virtual
#  machine. It runs once, on first start, and takes about 5 minutes. It installs:
#    - Node.js 22 and Tally Books (from GitHub), running as its own locked-down user
#    - Caddy, which gets a free HTTPS certificate and renews it automatically
#    - a nightly update at 3:15 a.m. (Toronto): new versions are tested before they go live,
#      and the previous version comes back if the new one doesn't start
#    - automatic Ubuntu security updates
#
#  EDIT THE THREE LINES BELOW before pasting.
# =====================================================================================
DOMAIN="yourname-books.canadacentral.cloudapp.azure.com"   # the web address (see the guide)
EMAIL="you@example.com"                                   # certificate expiry notices go here
SETUP_CODE="choose a phrase only you know"                # needed once, to create your owner account (letters, numbers, spaces)
# -------------------------------------------------------------------------------------
REPO="https://github.com/shersahray/tally-books.git"
BRANCH="main"

set -euo pipefail
exec > >(tee -a /var/log/tally-setup.log) 2>&1
echo "=== Tally Books setup started $(date) ==="
export DEBIAN_FRONTEND=noninteractive

timedatectl set-timezone America/Toronto || true
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

# Node.js 22 (NodeSource)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# A system user that owns the books and nothing else.
id tally >/dev/null 2>&1 || useradd --system --home-dir /var/lib/tally-books --shell /usr/sbin/nologin tally
mkdir -p /var/lib/tally-books/data /var/lib/tally-books/backups
chown -R tally:tally /var/lib/tally-books
chmod 700 /var/lib/tally-books

# The app itself.
if [ ! -d /opt/tally-books/.git ]; then
  git clone --depth 1 -b "$BRANCH" "$REPO" /opt/tally-books
fi

# Settings. Secrets live here (readable by root and the app only), never in GitHub.
if [ ! -f /etc/tally-books.env ]; then
  cat > /etc/tally-books.env <<EOF
PORT=3000
HOST=127.0.0.1
DATA_DIR=/var/lib/tally-books/data
BACKUP_FOLDER=/var/lib/tally-books/backups
REQUIRE_2FA=everyone
TRUST_PROXY=1
SETUP_CODE="${SETUP_CODE}"
# BACKUP_BLOB_URL is added with: tally-set-backup '<Blob SAS URL>'
EOF
fi
chown root:tally /etc/tally-books.env
chmod 640 /etc/tally-books.env

cat > /etc/systemd/system/tally-books.service <<'EOF'
[Unit]
Description=Tally Books
After=network-online.target
Wants=network-online.target

[Service]
User=tally
Group=tally
WorkingDirectory=/opt/tally-books
EnvironmentFile=/etc/tally-books.env
ExecStart=/usr/bin/node src/server/index.js
Restart=always
RestartSec=3
# Lock the service down: it can only write to its own data folder.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/var/lib/tally-books
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
{
	email ${EMAIL}
}

${DOMAIN} {
	encode gzip
	reverse_proxy 127.0.0.1:3000
	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
EOF
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy

# Nightly update: download, run the tests, switch over, and roll back if the new version doesn't start.
cat > /usr/local/bin/tally-update <<'EOF'
#!/bin/bash
set -euo pipefail
REPO_DIR=/opt/tally-books
cd "$REPO_DIR"
git fetch --depth 1 origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" ]; then echo "Already up to date."; exit 0; fi
NEXT=/opt/tally-books.next
rm -rf "$NEXT"
git clone --depth 1 -b main "$(git remote get-url origin)" "$NEXT"
cd "$NEXT"
if ! node --test "test/*.test.js" > /var/log/tally-update-tests.log 2>&1; then
  echo "Tests failed; staying on the current version. See /var/log/tally-update-tests.log"
  rm -rf "$NEXT"; exit 1
fi
rm -rf /opt/tally-books.prev
mv "$REPO_DIR" /opt/tally-books.prev
mv "$NEXT" "$REPO_DIR"
systemctl restart tally-books
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then echo "Updated to $(git -C "$REPO_DIR" rev-parse --short HEAD)."; exit 0; fi
  sleep 1
done
echo "New version didn't start; rolling back."
rm -rf "$REPO_DIR"; mv /opt/tally-books.prev "$REPO_DIR"
systemctl restart tally-books
exit 1
EOF
chmod 755 /usr/local/bin/tally-update

cat > /etc/systemd/system/tally-update.service <<'EOF'
[Unit]
Description=Update Tally Books from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/tally-update
EOF
cat > /etc/systemd/system/tally-update.timer <<'EOF'
[Unit]
Description=Update Tally Books every night
[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

# Helper: turn on off-site backups (run from Azure's "Run command").
cat > /usr/local/bin/tally-set-backup <<'EOF'
#!/bin/bash
set -euo pipefail
URL="${1:-}"
case "$URL" in https://*.blob.core.windows.net/*\?*sig=*) ;; *) echo "Paste the Blob SAS URL of the container, in quotes."; exit 1;; esac
sed -i '/^BACKUP_BLOB_URL=/d; /^# BACKUP_BLOB_URL/d' /etc/tally-books.env
printf 'BACKUP_BLOB_URL="%s"\n' "$URL" >> /etc/tally-books.env
systemctl restart tally-books
sleep 3
echo "Off-site backups are on: $(echo "$URL" | cut -d'?' -f1)"
echo "Open Tally Books > Settings and click Back up now to test it."
EOF
chmod 755 /usr/local/bin/tally-set-backup

# Helper: a quick health check (run from Azure's "Run command").
cat > /usr/local/bin/tally-status <<'EOF'
#!/bin/bash
echo "App:     $(systemctl is-active tally-books)  version $(git -C /opt/tally-books rev-parse --short HEAD) ($(git -C /opt/tally-books log -1 --format=%cd --date=short))"
echo "HTTPS:   $(systemctl is-active caddy)"
echo "Updates: next $(systemctl list-timers tally-update.timer --no-legend | awk '{print $1, $2, $3}')"
echo "Disk:    $(df -h /var/lib/tally-books | awk 'NR==2 {print $4 " free of " $2}')"
echo "Health:  $(curl -fsS http://127.0.0.1:3000/api/health || echo 'not answering')"
journalctl -u tally-books -n 15 --no-pager
EOF
chmod 755 /usr/local/bin/tally-status

# Automatic security updates for Ubuntu (reboots at 4 a.m. if an update needs one).
cat > /etc/apt/apt.conf.d/52tally-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
systemctl enable --now unattended-upgrades

systemctl daemon-reload
systemctl enable --now tally-books
systemctl enable --now tally-update.timer
systemctl restart caddy
echo "=== Tally Books setup finished $(date). Open https://${DOMAIN} ==="
