#!/bin/bash
# =====================================================================================
#  Tally Books: set up an online server on Azure (Ubuntu Server 24.04 LTS)
#
#  Paste this whole file into "Custom data" (Advanced tab) when you create the virtual
#  machine. It runs once, on first start, and takes about 5 minutes. It installs:
#    - Node.js 22 and Tally Books (from GitHub), running as its own locked-down user
#    - Caddy, which gets a free HTTPS certificate and renews it automatically
#    - a nightly update at 3:15 a.m. (Toronto), run by a separate account that can't read the
#      books: new versions are tested before they go live, and the previous version comes
#      back if the new one doesn't start
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
umask 022
exec > >(tee -a /var/log/tally-setup.log) 2>&1
chmod 600 /var/log/tally-setup.log
echo "=== Tally Books setup started $(date) ==="
export DEBIAN_FRONTEND=noninteractive

# The setup code: letters, numbers, spaces, . _ - only. If it wasn't changed, make a random one
# (see it with Run command: grep SETUP_CODE /var/log/tally-setup.log).
SETUP_CODE=$(printf '%s' "$SETUP_CODE" | tr -cd 'A-Za-z0-9 ._-')
if [ ${#SETUP_CODE} -lt 10 ] || [ "$SETUP_CODE" = "choose a phrase only you know" ]; then
  SETUP_CODE="tally-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "SETUP_CODE was not changed, so a random one was made: $SETUP_CODE"
fi

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

# Two system users: "tally" runs the app and owns the books; "tallydeploy" installs updates
# and can't read the books or the settings file.
id tally >/dev/null 2>&1 || useradd --system --home-dir /var/lib/tally-books --shell /usr/sbin/nologin tally
id tallydeploy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/tallydeploy --create-home --shell /usr/sbin/nologin tallydeploy
mkdir -p /var/lib/tally-books/data /var/lib/tally-books/backups
chown -R tally:tally /var/lib/tally-books
chmod 700 /var/lib/tally-books

# The app: /opt/tally/app is the running version; next/ and prev/ appear during updates.
mkdir -p /opt/tally
if [ ! -d /opt/tally/app/.git ]; then
  git clone --depth 1 -b "$BRANCH" "$REPO" /opt/tally/app
fi
touch /opt/tally/restart-request
chown -R tallydeploy:tallydeploy /opt/tally
chmod 755 /opt/tally

# Settings. Secrets live here (readable by root and the app only), never in GitHub.
if [ ! -f /etc/tally-books.env ]; then
  cat > /etc/tally-books.env <<ENVFILE
PORT=3000
HOST=127.0.0.1
DATA_DIR=/var/lib/tally-books/data
BACKUP_FOLDER=/var/lib/tally-books/backups
REQUIRE_2FA=everyone
TRUST_PROXY=1
SETUP_CODE="${SETUP_CODE}"
# BACKUP_BLOB_URL is added with: tally-set-backup '<Blob SAS URL>'
ENVFILE
fi
chown root:tally /etc/tally-books.env
chmod 640 /etc/tally-books.env

cat > /etc/systemd/system/tally-books.service <<'UNIT'
[Unit]
Description=Tally Books
After=network-online.target
Wants=network-online.target

[Service]
User=tally
Group=tally
WorkingDirectory=/opt/tally/app
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
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
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
CADDY
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy

# Nightly update, run as "tallydeploy": download, run the tests, switch over, and roll back if
# the new version doesn't start. It asks for a restart by touching /opt/tally/restart-request,
# which a small root-owned unit watches, so the update account needs no admin rights at all.
mkdir -p /usr/local/lib/tally
cat > /usr/local/lib/tally/update.sh <<'UPDATE'
#!/bin/bash
set -euo pipefail
cd /opt/tally
restart() {
  touch /opt/tally/restart-request
  sleep 4
  for i in $(seq 1 25); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
git -C app fetch --depth 1 origin main
if [ "$(git -C app rev-parse HEAD)" = "$(git -C app rev-parse FETCH_HEAD)" ]; then
  echo "Already up to date ($(git -C app rev-parse --short HEAD))."; exit 0
fi
rm -rf next
git clone --depth 1 -b main "$(git -C app remote get-url origin)" next
if ! (cd next && node --test "test/*.test.js") > /opt/tally/last-test-run.log 2>&1; then
  echo "Tests failed; staying on the current version. See /opt/tally/last-test-run.log"
  rm -rf next; exit 1
fi
rm -rf prev
mv app prev
mv next app
if restart; then echo "Updated to $(git -C app rev-parse --short HEAD)."; exit 0; fi
echo "The new version didn't start; going back to the previous one."
rm -rf app; mv prev app
restart || true
exit 1
UPDATE
chmod 755 /usr/local/lib/tally/update.sh

cat > /etc/systemd/system/tally-update.service <<'UNIT'
[Unit]
Description=Update Tally Books from GitHub
After=network-online.target
[Service]
Type=oneshot
User=tallydeploy
Group=tallydeploy
Environment=HOME=/var/lib/tallydeploy
ExecStart=/usr/local/lib/tally/update.sh
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/opt/tally /var/lib/tallydeploy
InaccessiblePaths=/var/lib/tally-books /etc/tally-books.env
UNIT
cat > /etc/systemd/system/tally-update.timer <<'UNIT'
[Unit]
Description=Update Tally Books every night
[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/tally-restart.path <<'UNIT'
[Unit]
Description=Restart Tally Books when an update asks
[Path]
PathChanged=/opt/tally/restart-request
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/tally-restart.service <<'UNIT'
[Unit]
Description=Restart Tally Books
[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart tally-books
UNIT

# "tally-update" for Azure's Run command: update now and show what happened.
cat > /usr/local/bin/tally-update <<'HELPER'
#!/bin/bash
systemctl start tally-update.service
journalctl -u tally-update.service -n 12 --no-pager -o cat
HELPER
chmod 755 /usr/local/bin/tally-update

# "tally-set-backup" for Azure's Run command: turn on off-site backups.
cat > /usr/local/bin/tally-set-backup <<'HELPER'
#!/bin/bash
set -euo pipefail
URL="${1:-}"
case "$URL" in https://*.blob.core.windows.net/*\?*sig=*) ;; *) echo "Paste the Blob SAS URL of the container, in quotes."; exit 1;; esac
case "$URL" in *\"*|*\$*|*\`*) echo "That doesn't look like a SAS URL."; exit 1;; esac
SP=$(printf '%s' "$URL" | sed -n 's/.*[?&]sp=\([a-z]*\).*/\1/p')
case "$SP" in *d*|*l*|*r*) echo "Note: this token can also read, list or delete. A token with only Create and Write is safer (see the guide).";; esac
sed -i '/^BACKUP_BLOB_URL=/d; /^# BACKUP_BLOB_URL/d' /etc/tally-books.env
printf 'BACKUP_BLOB_URL="%s"\n' "$URL" >> /etc/tally-books.env
systemctl restart tally-books
sleep 3
echo "Off-site backups are on: ${URL%%\?*}"
echo "Open Tally Books > Settings and click Back up now to test it."
HELPER
chmod 755 /usr/local/bin/tally-set-backup

# "tally-status" for Azure's Run command: a quick health check.
cat > /usr/local/bin/tally-status <<'HELPER'
#!/bin/bash
echo "App:     $(systemctl is-active tally-books)  version $(git -C /opt/tally/app rev-parse --short HEAD) ($(git -C /opt/tally/app log -1 --format=%cd --date=short))"
echo "HTTPS:   $(systemctl is-active caddy)"
echo "Updates: next $(systemctl list-timers tally-update.timer --no-legend | awk '{print $1, $2, $3}')"
echo "Disk:    $(df -h /var/lib/tally-books | awk 'NR==2 {print $4 " free of " $2}')"
echo "Health:  $(curl -fsS http://127.0.0.1:3000/api/health || echo 'not answering')"
journalctl -u tally-books -n 15 --no-pager
HELPER
chmod 755 /usr/local/bin/tally-status

# Automatic security updates for Ubuntu (reboots at 4 a.m. if an update needs one).
cat > /etc/apt/apt.conf.d/52tally-unattended <<'APT'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
APT
systemctl enable --now unattended-upgrades

systemctl daemon-reload
systemctl enable --now tally-books
systemctl enable --now tally-update.timer
systemctl enable --now tally-restart.path
systemctl restart caddy
echo "=== Tally Books setup finished $(date). Open https://${DOMAIN} ==="
