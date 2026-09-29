#!/usr/bin/env node
'use strict';
// Command-line entry point: `npm start` or `node src/server/index.js`.

const path = require('node:path');
const { createApp } = require('./app');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Tally Books needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const password = process.env.APP_PASSWORD || '';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !password) {
  console.warn('Warning: the server is reachable from other computers but APP_PASSWORD is not set.');
}

const server = createApp({ dataDir: DATA_DIR, password, demo: args.has('--demo') });
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Tally Books is already running at http://localhost:${PORT}`);
    if (args.has('--open')) openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 1500);
  } else { console.error(err); process.exit(1); }
});
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Tally Books is running at http://${shown}:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log('Keep this window open while you use Tally Books. Close it (or press Ctrl+C) to stop.');
  if (args.has('--open')) openBrowser(`http://localhost:${PORT}`);
});

// Open the app in the default browser (used by the Start Tally Books shortcuts).
function openBrowser(url) {
  const { spawn } = require('node:child_process');
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch { /* the address is printed above */ }
}

const stop = () => server.shutdown().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
