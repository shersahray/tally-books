'use strict';
// Desktop wrapper: starts the same server privately on this computer and shows it in a window.

const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { createApp } = require('../src/server/app');

let server = null;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(start).catch(err => {
    dialog.showErrorBox('Tally Books could not start', String(err && err.stack || err));
    app.quit();
  });
}

async function start() {
  const dbPath = path.join(app.getPath('userData'), 'tally-books.db');
  server = createApp({ dbPath });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve); // random free port, reachable only from this computer
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    title: 'Tally Books',
    backgroundColor: '#eef2f0',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  // Open outside links in the default browser instead of inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); shell.openExternal(target); }
  });

  buildMenu(dbPath);
  await win.loadURL(url);
}

function buildMenu(dbPath) {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Show data file', click: () => shell.showItemInFolder(dbPath) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (server) { server.shutdown(); server = null; } });
