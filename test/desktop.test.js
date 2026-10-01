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
let userData, office, officeUrl, handlers, win, readyFns, opened, menus;
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
    shell: { openExternal: u => opened.push(u), openPath() {} }, dialog: { showErrorBox() {} },
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
