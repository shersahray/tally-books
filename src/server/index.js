#!/usr/bin/env node
'use strict';
// Command-line entry point: `npm start` or `node src/server/index.js`.

const path = require('node:path');
const { createApp } = require('./app');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Sumlora needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const password = process.env.APP_PASSWORD || '';
// Online servers (see deploy/azure): REQUIRE_2FA=everyone, TRUST_PROXY=1 behind Caddy,
// BACKUP_FOLDER for local copies and BACKUP_BLOB_URL for the off-site copy in Azure Storage.
const require2fa = process.env.REQUIRE_2FA || '';
const setupCode = process.env.SETUP_CODE || '';
if (setupCode && (setupCode.trim().length < 10 || /choose a phrase only you know/i.test(setupCode))) {
  console.error('SETUP_CODE is still the example or is too short. Choose your own phrase of at least 10 characters in /etc/tally-books.env.');
  process.exit(1);
}
const trustProxy = process.env.TRUST_PROXY === '1';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !trustProxy) {
  console.warn('Warning: the server is reachable from other computers without HTTPS. Put it behind an HTTPS proxy (see deploy/azure/README.md).');
}

const server = createApp({
  dataDir: DATA_DIR, password, demo: args.has('--demo'),
  require2fa, trustProxy,
  setupCode: setupCode || undefined,
  backupFolder: process.env.BACKUP_FOLDER || undefined,
  backupBlobUrl: process.env.BACKUP_BLOB_URL || undefined,
  aiKey: process.env.ANTHROPIC_API_KEY || undefined,
  mailAllowLocal: process.env.MAIL_ALLOW_LOCAL === '1', // testing only
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Sumlora is already running at http://localhost:${PORT}`);
    if (args.has('--open')) openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 1500);
  } else { console.error(err); process.exit(1); }
});
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Sumlora is running at http://${shown}:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  if (require2fa) console.log(`Two-step sign-in required for: ${require2fa}`);
  if (process.env.BACKUP_BLOB_URL) console.log(`Off-site backups: ${new URL(process.env.BACKUP_BLOB_URL).host}`);
  console.log('Keep this window open while you use Sumlora. Close it (or press Ctrl+C) to stop.');
  if (args.has('--open')) openBrowser(`http://localhost:${PORT}`);
});

// Open the app in the default browser (used by the Start Sumlora shortcuts).
function openBrowser(url) {
  const { spawn } = require('node:child_process');
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch { /* the address is printed above */ }
}

const stop = () => server.shutdown().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
