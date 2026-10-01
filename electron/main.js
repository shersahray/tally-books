'use strict';
/* Desktop wrapper. Two ways to work:
 *  - "On this computer": starts the same server privately on this computer (127.0.0.1) and shows it in a window.
 *  - "On our office server": keeps no books here; the window opens your firm's Tally Books server
 *    (the server version, over HTTPS), so everyone in every office works in the same books.
 * The choice is saved in desktop.json in the app's data folder and can be changed from File → Where the books are.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, net } = require('electron');
const { serverOrigin, netMessage } = require('./connection');

let server = null;    // the private server, in "this computer" mode only
let win = null;
let origin = '';      // where the books are open: http://127.0.0.1:<port> or https://your-server
let lastError = '';
const CONNECT_PAGE = path.join(__dirname, 'connect.html');

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

const dataDir = () => app.getPath('userData');
const configFile = () => path.join(dataDir(), 'desktop.json');
function readConfig() {
  try { const c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); return c && (c.mode === 'local' || c.mode === 'server') ? c : null; } catch { return null; }
}
function saveConfig(c) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}
const hasLocalBooks = () => ['companies.json', 'users.json', 'tally-books.db'].some(f => fs.existsSync(path.join(dataDir(), f)));

/** Is a Tally Books server answering there? */
async function checkServer(o) {
  let r;
  try { r = await net.fetch(o + '/api/health', { signal: AbortSignal.timeout(10000), cache: 'no-store' }); } catch (e) { throw new Error(netMessage(e)); }
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || !j || j.ok !== true) throw new Error('Something answered at that address, but it isn’t Tally Books. Check the address.');
}
async function startLocal() {
  if (server) return;
  const { createApp } = require('../src/server/app');
  server = createApp({ dataDir: dataDir() });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve); // random free port, reachable only from this computer
  });
}
async function stopLocal() { if (server) { const s = server; server = null; await s.shutdown(); } }

/** Open the books the saved way, or ask where they are. */
async function openBooks() {
  const c = readConfig();
  if (!c) return showConnect('setup');
  if (c.mode === 'local') {
    await startLocal();
    origin = `http://127.0.0.1:${server.address().port}`;
  } else {
    await stopLocal();
    origin = c.serverUrl;
  }
  buildMenu();
  lastError = '';
  try { await win.loadURL(origin + '/'); } catch { /* did-fail-load shows the page */ }
}
function showConnect(page) {
  origin = '';
  buildMenu();
  return win.loadFile(CONNECT_PAGE, { query: { page } });
}

async function start() {
  // People who used the app before this choice existed keep their books on this computer.
  if (!readConfig() && hasLocalBooks()) saveConfig({ mode: 'local' });

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    title: 'Tally Books',
    backgroundColor: '#eef2f0',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });

  // Stay on the books' own address; anything else opens in the default browser.
  const inside = target => !!origin && (target === origin || target.startsWith(origin + '/'));
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!inside(target) && /^(https?|mailto):/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!inside(target)) { e.preventDefault(); if (/^(https?|mailto):/i.test(target)) shell.openExternal(target); }
  });
  win.webContents.on('will-redirect', (e, target) => {
    if (origin && !inside(target)) { e.preventDefault(); lastError = 'The server sent the app to a different address. Check the server address.'; showConnect('offline'); }
  });
  // Couldn't reach the office server: say so, with Try again and Change server.
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !origin || !inside(url)) return; // -3: replaced by another page
    lastError = netMessage(new Error(desc));
    showConnect('offline');
  });

  // The connection page (and only that page, a file inside the app) can change where the books are.
  const fromConnectPage = e => { try { return new URL(e.senderFrame.url).protocol === 'file:'; } catch { return false; } };
  ipcMain.handle('desktop:info', e => {
    if (!fromConnectPage(e)) return null;
    const c = readConfig();
    return { mode: c ? c.mode : '', serverUrl: (c && c.serverUrl) || '', lastServerUrl: (c && (c.serverUrl || c.lastServerUrl)) || '', hasLocalBooks: hasLocalBooks(), error: lastError };
  });
  ipcMain.handle('desktop:use-local', async e => {
    if (!fromConnectPage(e)) return { error: 'Not allowed.' };
    const c = readConfig() || {};
    saveConfig({ mode: 'local', lastServerUrl: c.serverUrl || c.lastServerUrl || '' });
    await openBooks();
    return { ok: true };
  });
  ipcMain.handle('desktop:use-server', async (e, input) => {
    if (!fromConnectPage(e)) return { error: 'Not allowed.' };
    try {
      const o = serverOrigin(input);
      await checkServer(o);
      saveConfig({ mode: 'server', serverUrl: o });
      await openBooks();
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('desktop:retry', async e => {
    if (!fromConnectPage(e)) return { error: 'Not allowed.' };
    await openBooks();
    return { ok: true };
  });
  ipcMain.handle('desktop:change', e => (fromConnectPage(e) ? showConnect('setup') : null));

  await openBooks();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const c = readConfig();
  const fr = /^fr/i.test(app.getLocale ? app.getLocale() : '');
  const L = (en, f) => (fr ? f : en);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: L('File', 'Fichier'),
      submenu: [
        { label: L('Where the books are…', 'Où sont les livres…'), click: () => { lastError = ''; showConnect('setup'); } },
        ...(c && c.mode === 'local' ? [{ label: L('Show data folder', 'Afficher le dossier des données'), click: () => shell.openPath(dataDir()) }] : []),
        ...(c && c.mode === 'server' ? [{ label: L('Reconnect to the server', 'Se reconnecter au serveur'), click: () => openBooks() }] : []),
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

