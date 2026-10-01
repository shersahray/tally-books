'use strict';
// The desktop app's choice of where the books are, run against a stand-in for Electron.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { serverOrigin } = require('../electron/connection');
const { createApp } = require('../src/server/app');

test('server addresses: HTTPS only, tidied to the origin', () => {
  assert.equal(serverOrigin('books.firm.ca'), 'https://books.firm.ca');
  assert.equal(serverOrigin(' https://books.firm.ca:8443/some/page?x=1 '), 'https://books.firm.ca:8443');
  assert.equal(serverOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.throws(() => serverOrigin('http://books.firm.ca'), /https:\/\//);
  assert.throws(() => serverOrigin('http://192.168.1.20'), /https:\/\//);
  assert.throws(() => serverOrigin('https://me:pw@books.firm.ca'), /user name and password/);
  assert.throws(() => serverOrigin(''), /Enter/);
});

// ---- a small stand-in for the parts of Electron main.js uses ----
let userData, office, officeUrl, handlers, win, readyFns, opened, menus, pickReply;
function fakeElectron() {
  handlers = {}; readyFns = []; opened = []; menus = [];
  class BrowserWindow {
    constructor(o) { win = this; this.opts = o; this.loads = []; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; }; }
    async loadURL(u) { this.loads.push(u); }
    async loadFile(f, o) { this.loads.push('file://' + f + '?page=' + o.query.page); }
    isMinimized() { return false; } focus() {}
  }
  return {
    app: {
      requestSingleInstanceLock: () => true, on() {}, quit() {},
      whenReady: () => ({ then: fn => { readyFns.push(fn); return { catch() {} }; } }),
      getPath: () => userData,
    },
    BrowserWindow, Menu: { setApplicationMenu: m => menus.push(m), buildFromTemplate: t => t },
    shell: { openExternal: u => opened.push(u), openPath() {} }, dialog: { showErrorBox() {}, showOpenDialog: async () => pickReply },
    ipcMain: { handle: (n, fn) => { handlers[n] = fn; } },
    net: { fetch: (u, o) => fetch(u, o) },
    nativeTheme: { shouldUseDarkColors: false },
  };
}
const fromPage = { senderFrame: { url: 'file:///app/electron/connect.html?page=setup' } };
const fromServer = u => ({ senderFrame: { url: u } });
async function launch() {
  const fake = fakeElectron();
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : orig.call(this, req, ...rest); };
  try { delete require.cache[require.resolve('../electron/main.js')]; require('../electron/main.js'); } finally { Module._load = orig; }
  await readyFns[0]();
}
const last = () => win.loads[win.loads.length - 1];
const fileMenu = () => menus[menus.length - 1].find(m => m.label === 'File').submenu.map(i => i.label).filter(Boolean);

before(async () => {
  office = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tally-office-')), autoBackup: false });
  await new Promise(r => office.listen(0, '127.0.0.1', r));
  officeUrl = `http://localhost:${office.address().port}`;
});
after(async () => { await office.shutdown(); });

test('first start asks where the books are; connecting to the office server opens it', async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-desk-'));
  await launch();
  assert.match(last(), /connect\.html\?page=setup$/);
  assert.equal(win.opts.webPreferences.contextIsolation, true);
  assert.equal(win.opts.webPreferences.nodeIntegration, false);
  assert.deepEqual((await handlers['desktop:info'](fromPage)).mode, '');

  assert.match((await handlers['desktop:use-server'](fromPage, 'http://books.example.ca')).error, /https/);
  assert.match((await handlers['desktop:use-server'](fromPage, 'http://localhost:1')).error, /didn’t answer|Couldn’t connect/);
  const r = await handlers['desktop:use-server'](fromPage, officeUrl + '/anything');
  assert.deepEqual(r, { ok: true });
  assert.equal(last(), officeUrl + '/');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8')), { mode: 'server', serverUrl: officeUrl });
  assert.ok(!fs.existsSync(path.join(userData, 'companies.json')), 'no books are kept on this computer');
  assert.deepEqual(fileMenu(), ['Where the books are…', 'Reconnect to the server']);

  // Pages from the server can't change where the books are.
  assert.equal(await handlers['desktop:info'](fromServer(officeUrl + '/')), null);
  assert.equal((await handlers['desktop:use-server'](fromServer(officeUrl + '/'), 'https://evil.example')).error, 'Not allowed.');

  // Links elsewhere open in the browser; the server's own pages stay in the window.
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  let e = ev(); win.webContents.emit('will-navigate', e, officeUrl + '/#co_1'); assert.equal(e.prevented, false);
  e = ev(); win.webContents.emit('will-navigate', e, 'https://www.canada.ca/'); assert.equal(e.prevented, true);
  e = ev(); win.webContents.emit('will-navigate', e, officeUrl + '.evil.example/'); assert.equal(e.prevented, true, 'look-alike address');
  assert.deepEqual(opened, ['https://www.canada.ca/', officeUrl + '.evil.example/']);
  win.openHandler({ url: 'file:///etc/passwd' }); assert.equal(opened.length, 2, 'only web and mail links open outside');

  // The server goes away: the offline page, with the reason; Try again reconnects.
  win.webContents.emit('did-fail-load', {}, -102, 'net::ERR_CONNECTION_REFUSED', officeUrl + '/', true);
  await new Promise(r => setImmediate(r));
  assert.match(last(), /page=offline$/);
  assert.match((await handlers['desktop:info'](fromPage)).error, /didn’t answer/);
  await handlers['desktop:retry'](fromPage);
  assert.equal(last(), officeUrl + '/');

  // Next start goes straight to the server.
  await launch();
  assert.equal(last(), officeUrl + '/');
});

test('choosing this computer runs the private server; earlier users keep their books here', async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-desk-'));
  await launch();
  await handlers['desktop:use-local'](fromPage);
  assert.match(last(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const h = await (await fetch(last() + 'api/health')).json();
  assert.equal(h.ok, true);
  assert.deepEqual(fileMenu(), ['Where the books are…', 'Show data folder']);
  // Books made here (an owner account), then switching to the office server stops the private one.
  const local = last();
  const su = await fetch(local + 'api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: local.slice(0, -1) }, body: JSON.stringify({ name: 'Me', username: 'me@example.com', password: 'correct horse battery staple' }) });
  assert.equal(su.status, 200);
  await handlers['desktop:use-server'](fromPage, officeUrl);
  await assert.rejects(fetch(local + 'api/health'));
  const info = await handlers['desktop:info'](fromPage);
  assert.equal(info.hasLocalBooks, true, 'the books made here stay here');

  // Someone who used the app before this choice existed: straight to their books, no question.
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-desk-'));
  fs.writeFileSync(path.join(userData, 'companies.json'), JSON.stringify({ version: 1, companies: [] }));
  await launch();
  assert.match(last(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8')).mode, 'local');
  await handlers['desktop:use-server'](fromPage, officeUrl); // stop it
});

const folders = require('../electron/datafolder');

test('folder warnings: cloud-synced and network folders', () => {
  assert.deepEqual(folders.folderWarnings('C:\\Users\\sher\\OneDrive - Firm\\Books', 'win32'), ['sync']);
  assert.deepEqual(folders.folderWarnings('/Users/sher/Library/CloudStorage/GoogleDrive-sher@x.ca/My Drive/Books', 'darwin'), ['sync']);
  assert.deepEqual(folders.folderWarnings('/Users/sher/Dropbox/Books', 'darwin'), ['sync']);
  assert.deepEqual(folders.folderWarnings('\\\\nas\\accounting\\Books', 'win32'), ['network']);
  assert.deepEqual(folders.folderWarnings('D:\\Tally Books', 'win32'), []);
  assert.deepEqual(folders.folderWarnings('D:\\Box\\Sync\\MEGA', 'win32'), [], 'ordinary folder names');
});

test('choosing a folder moves the books there, checked, and back again', async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-desk-'));
  fs.mkdirSync(path.join(userData, 'GPUCache')); // Electron's own files stay put
  await launch();
  await handlers['desktop:use-local'](fromPage);
  let local = last();
  const su = await fetch(local + 'api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: local.slice(0, -1) }, body: JSON.stringify({ name: 'Me', username: 'me@example.com', password: 'correct horse battery staple' }) });
  assert.equal(su.status, 200);
  const before = fs.readFileSync(path.join(userData, 'users.json'), 'utf8');

  // Pages from a server can't do this; nothing happens without a folder picked in the system window.
  assert.equal((await handlers['desktop:pick-folder'](fromServer(local))).error, 'Not allowed.');
  assert.equal((await handlers['desktop:use-folder'](fromPage, 'move')).error, 'Choose a folder.');
  pickReply = { canceled: true, filePaths: [] };
  assert.deepEqual(await handlers['desktop:pick-folder'](fromPage), { cancel: true });
  pickReply = { canceled: false, filePaths: [userData] };
  assert.equal((await handlers['desktop:pick-folder'](fromPage)).same, true);

  // A folder with other files in it: the books go in a "Tally Books" folder inside it.
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-drive-'));
  fs.writeFileSync(path.join(drive, 'notes.txt'), 'mine');
  pickReply = { canceled: false, filePaths: [drive] };
  const chk = await handlers['desktop:pick-folder'](fromPage);
  assert.equal(chk.target, path.join(drive, 'Tally Books'));
  assert.equal(chk.hasBooks, true);
  assert.equal(chk.booksThere, false);
  assert.deepEqual(chk.warnings, []);
  assert.deepEqual(await handlers['desktop:use-folder'](fromPage, 'move'), { ok: true });
  const moved = path.join(drive, 'Tally Books');
  assert.equal(fs.readFileSync(path.join(moved, 'users.json'), 'utf8'), before, 'copied exactly');
  assert.ok(fs.existsSync(path.join(moved, 'companies')));
  assert.ok(!fs.existsSync(path.join(userData, 'users.json')), 'removed from the old folder');
  assert.ok(!fs.existsSync(path.join(userData, 'companies')));
  assert.ok(fs.existsSync(path.join(userData, 'GPUCache')), 'Electron’s files are left alone');
  assert.ok(fs.existsSync(path.join(drive, 'notes.txt')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8')).dataDir, moved);
  await assert.rejects(fetch(local + 'api/health'), 'the old private server stopped');
  local = last();
  assert.equal((await (await fetch(local + 'api/health')).json()).ok, true);
  const again = await fetch(local + 'api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: local.slice(0, -1) }, body: JSON.stringify({ name: 'X', username: 'x@example.com', password: 'correct horse battery staple' }) });
  assert.notEqual(again.status, 200, 'the owner account came along, so setup is already done');
  assert.equal((await handlers['desktop:info'](fromPage)).dataDir, moved);

  // Next start opens them from there.
  await handlers['desktop:use-server'](fromPage, officeUrl); // stop this instance's private server first
  fs.writeFileSync(path.join(userData, 'desktop.json'), JSON.stringify({ mode: 'local', dataDir: moved }));
  await launch();
  assert.match(last(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await handlers['desktop:info'](fromPage)).dataDir, moved);

  // Back to the standard folder.
  pickReply = { canceled: false, filePaths: [userData] };
  const back = await handlers['desktop:pick-folder'](fromPage);
  assert.equal(back.target, userData);
  assert.deepEqual(await handlers['desktop:use-folder'](fromPage, 'move'), { ok: true });
  assert.equal(fs.readFileSync(path.join(userData, 'users.json'), 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8')).dataDir, undefined);
  assert.ok(!fs.existsSync(path.join(moved, 'users.json')));

  // A folder that already has books opens them; the books here stay.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-other-'));
  fs.writeFileSync(path.join(other, 'companies.json'), JSON.stringify({ version: 1, companies: [] }));
  pickReply = { canceled: false, filePaths: [other] };
  assert.equal((await handlers['desktop:pick-folder'](fromPage)).booksThere, true);
  assert.deepEqual(await handlers['desktop:use-folder'](fromPage, 'open'), { ok: true });
  assert.ok(fs.existsSync(path.join(userData, 'users.json')), 'nothing moved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8')).dataDir, other);
  const opened2 = last();
  const setupOther = await fetch(opened2 + 'api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: opened2.slice(0, -1) }, body: JSON.stringify({ name: 'Y', username: 'y@example.com', password: 'correct horse battery staple' }) });
  assert.equal(setupOther.status, 200, 'the server now serves the other folder (no owner there yet)');
  assert.ok(fs.existsSync(path.join(other, 'users.json')));

  // The folder goes missing (an unplugged drive): say so instead of starting empty books.
  await handlers['desktop:use-server'](fromPage, officeUrl); // stop the private server
  fs.writeFileSync(path.join(userData, 'desktop.json'), JSON.stringify({ mode: 'local', dataDir: path.join(other, 'gone') }));
  await launch();
  assert.match(last(), /page=missing$/);
  assert.ok(!fs.existsSync(path.join(other, 'gone')));
});

test('a copy that can’t finish leaves both folders as they were', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-b-'));
  fs.writeFileSync(path.join(a, 'companies.json'), '{}'); fs.mkdirSync(path.join(a, 'companies')); fs.writeFileSync(path.join(a, 'companies', 'c1.db'), 'x');
  fs.writeFileSync(path.join(a, 'users.json'), '{}');
  fs.writeFileSync(path.join(b, 'users.json'), 'theirs');
  assert.throws(() => folders.copyBooks(a, b), /already has users\.json/);
  assert.deepEqual(fs.readdirSync(b), ['users.json']);
  assert.equal(fs.readFileSync(path.join(b, 'users.json'), 'utf8'), 'theirs');
  assert.ok(fs.existsSync(path.join(a, 'companies', 'c1.db')));
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-c-'));
  fs.mkdirSync(path.join(c, 'companies'));
  assert.equal(folders.checkFolder(c, a).target, path.join(c, 'Tally Books'), 'their own files are left alone');
  fs.mkdirSync(path.join(c, 'Tally Books', 'companies'), { recursive: true });
  assert.equal(folders.checkFolder(c, a).error, 'That folder has part of a Tally Books data folder in it. Choose an empty folder.');
});
