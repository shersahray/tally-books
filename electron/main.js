'use strict';
/* Desktop wrapper. Two ways to work:
 *  - "On this computer": starts the same server privately on this computer (127.0.0.1) and shows it in a window.
 *  - "On our office server": keeps no books here; the window opens your firm's Sumlora server
 *    (the server version, over HTTPS), so everyone in every office works in the same books.
 * The choice is saved in desktop.json in the app's data folder and can be changed from File → Where the books are.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, net, nativeTheme } = require('electron');
const { serverOrigin, netMessage } = require('./connection');
const folders = require('./datafolder');
const { setupUpdates, updatesOn, buildInfo } = require('./updater');
let updates = null;

// Before the new name, the app's own folder was "Tally Books" (in AppData\Roaming). Copies installed then keep
// their books, their choice of where the books are and their licence there. Must run before the app starts.
try {
  const old = path.join(app.getPath('appData'), 'Tally Books');
  if (fs.existsSync(path.join(old, 'desktop.json')) || folders.hasBooks(old) || fs.existsSync(path.join(old, 'licence.json'))) app.setPath('userData', old);
} catch { /* the standard folder */ }

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
    dialog.showErrorBox('Sumlora could not start', String(err && err.stack || err));
    app.quit();
  });
}

// The app's own folder holds desktop.json (and Electron's files). The books are there too unless
// someone chose another folder (File → Where the books are → Choose folder).
const appDir = () => app.getPath('userData');
const configFile = () => path.join(appDir(), 'desktop.json');
const dataDir = () => { const c = readConfig(); return (c && c.dataDir) || appDir(); };
function readConfig() {
  try { const c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); return c && (c.mode === 'local' || c.mode === 'server') ? c : null; } catch { return null; }
}
function saveConfig(c) {
  fs.mkdirSync(appDir(), { recursive: true });
  const tmp = configFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, configFile());
}
const hasLocalBooks = () => folders.hasBooks(dataDir());

/** Is a Sumlora server answering there? */
async function checkServer(o) {
  let r;
  try { r = await net.fetch(o + '/api/health', { signal: AbortSignal.timeout(10000), cache: 'no-store' }); } catch (e) { throw new Error(netMessage(e)); }
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || !j || j.ok !== true) throw new Error('Something answered at that address, but it isn’t Sumlora. Check the address.');
}
async function startLocal() {
  if (server) return;
  const { createApp } = require('../src/server/app');
  // Licence codes: the installed app checks them with the seller's public key, written into the build (see licence.js).
  const licenceKeys = app.isPackaged ? (buildInfo().licenceKeys || []) : [];
  const trial = app.isPackaged ? buildInfo().licenceTrialDays : undefined;
  server = createApp({ dataDir: dataDir(), licenceDir: appDir(), licenceKeys, requireTerms: true, licenceTrialDays: Number.isInteger(trial) ? trial : undefined });
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
    // A chosen folder that isn't there (a drive that's unplugged or not connected): say so rather than start empty books.
    if (c.dataDir && !fs.existsSync(c.dataDir)) { lastError = ''; return showConnect('missing'); }
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
    title: 'Sumlora',
    backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? '#0c131d' : '#eef3f4',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });

  // Stay on the books' own address; anything else opens in the default browser.
  const inside = target => !!origin && (target === origin || target.startsWith(origin + '/'));
  win.webContents.setWindowOpenHandler(({ url: target, referrer }) => {
    // Bank feeds: some banks sign in through a pop-up opened by Plaid's window. It has to stay in the app to report back.
    if (/^https:\/\//i.test(target) && /^https:\/\/cdn\.plaid\.com\//i.test((referrer && referrer.url) || '')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 760, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    }
    // The Terms of service and Privacy policy open in the normal browser, to read alongside the app.
    if (inside(target) && /\/legal\/[a-z-]+\.html$/.test(new URL(target).pathname)) { shell.openExternal(target); return { action: 'deny' }; }
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
    return { mode: c ? c.mode : '', serverUrl: (c && c.serverUrl) || '', lastServerUrl: (c && (c.serverUrl || c.lastServerUrl)) || '', hasLocalBooks: fs.existsSync(dataDir()) && hasLocalBooks(), dataDir: dataDir(), standardDir: !(c && c.dataDir), error: lastError };
  });
  ipcMain.handle('desktop:use-local', async e => {
    if (!fromConnectPage(e)) return { error: 'Not allowed.' };
    const c = readConfig() || {};
    saveConfig({ mode: 'local', lastServerUrl: c.serverUrl || c.lastServerUrl || '', ...(c.dataDir ? { dataDir: c.dataDir } : {}) });
    await openBooks();
    return { ok: true };
  });
  ipcMain.handle('desktop:use-server', async (e, input) => {
    if (!fromConnectPage(e)) return { error: 'Not allowed.' };
    try {
      const o = serverOrigin(input);
      await checkServer(o);
      const c = readConfig() || {};
      saveConfig({ mode: 'server', serverUrl: o, ...(c.dataDir ? { dataDir: c.dataDir } : {}) });
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

  // Choosing the folder for the books on this computer. Only a folder picked in the system's own
  // folder window can be used, so a page can't point the books somewhere on its own.
  let picked = null, busy = false;
  ipcMain.handle('desktop:pick-folder', async e => {
    if (!fromConnectPage(e)) return { error: 'Not allowed.' };
    if (busy) return { error: 'The books are being moved. Wait a moment.' };
    const fr = /^fr/i.test(app.getLocale ? app.getLocale() : '');
    const r = await dialog.showOpenDialog(win, {
      title: fr ? 'Dossier des livres' : 'Folder for the books',
      defaultPath: fs.existsSync(dataDir()) ? dataDir() : appDir(),
      buttonLabel: fr ? 'Choisir ce dossier' : 'Choose this folder',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) { picked = null; return { cancel: true }; }
    try { fs.mkdirSync(r.filePaths[0], { recursive: true }); } catch { /* checked next */ }
    const check = folders.checkFolder(r.filePaths[0], dataDir(), { standard: appDir() });
    picked = check.target && !check.same ? check : null;
    return { ...check, hasBooks: fs.existsSync(dataDir()) && hasLocalBooks() };
  });
  ipcMain.handle('desktop:use-folder', async (e, how) => {
    if (!fromConnectPage(e)) return { error: 'Not allowed.' };
    if (busy) return { error: 'The books are being moved. Wait a moment.' };
    if (!picked) return { error: 'Choose a folder.' };
    const check = picked; picked = null;
    busy = true;
    try { return await useFolder(check, how); } finally { busy = false; }
  });
  async function useFolder(check, how) {
    const c = readConfig() || {};
    const keep = { lastServerUrl: c.serverUrl || c.lastServerUrl || '' };
    const conf = dir => (check.standard || folders.same(dir, appDir()) ? { mode: 'local', ...keep } : { mode: 'local', ...keep, dataDir: dir });
    const from = dataDir();
    if (how === 'open' || check.booksThere || !fs.existsSync(from) || !folders.hasBooks(from)) {
      // Use that folder as it is (its own books, or new empty books). The books here stay where they are.
      await stopLocal(); // the private server still has the old folder open
      saveConfig(conf(check.target));
      await openBooks();
      return { ok: true };
    }
    // Move: close the books, copy them, check every file, open them from the new folder, then remove the old copy.
    await stopLocal();
    let items;
    try { items = folders.copyBooks(from, check.target); } catch (err) {
      await openBooks();
      return { error: 'The books couldn’t be moved, so they stay where they were. ' + err.message };
    }
    saveConfig(conf(check.target));
    try { await openBooks(); } catch (err) {
      await stopLocal();
      folders.removeBooks(check.target, folders.BOOK_ITEMS); // the copy, and anything the new server started there
      saveConfig(c.mode ? c : { mode: 'local' });
      await openBooks();
      return { error: 'The books couldn’t be opened from the new folder, so they stay where they were.' };
    }
    const left = folders.removeBooks(from, items);
    if (left.length) {
      const fr = /^fr/i.test(app.getLocale ? app.getLocale() : '');
      dialog.showMessageBox(win, { type: 'warning', message: fr ? 'Les livres ont été déplacés.' : 'Your books were moved.',
        detail: (fr ? 'L’ancienne copie n’a pas pu être entièrement supprimée. Vous pouvez supprimer ces éléments vous-même :\n' : 'The old copy couldn’t all be removed. You can delete these yourself:\n') + left.map(n => path.join(from, n)).join('\n') }).catch(() => {});
    }
    return { ok: true };
  }

  await openBooks();
  startUpdates();
}

/** Automatic updates: the installed, signed Windows app only (see updater.js). */
function startUpdates() {
  if (!updatesOn({ isPackaged: app.isPackaged })) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  const fr = /^fr/i.test(app.getLocale ? app.getLocale() : '');
  updates = setupUpdates({ autoUpdater, dialog, window: () => win, localServer: () => server, fr, log: m => console.log(m) });
  buildMenu();
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
        ...(updates ? [{ label: L('Check for updates…', 'Rechercher des mises à jour…'), click: () => updates.check() }] : []),
        ...(app.getVersion ? [{ label: `${L('Version', 'Version')} ${app.getVersion()}`, enabled: false }] : []),
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
app.on('before-quit', () => {
  if (updates) updates.beforeQuit();
  if (server) { server.shutdown(); server = null; }
});

