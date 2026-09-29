'use strict';
// HTTP server: JSON API + static files. No third-party dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { COLLECTIONS } = require('./db');
const { Registry } = require('./companies');
const { Backups } = require('./backups');
const { Auth, AuthError, sessionCookie, readCookie, COOKIE } = require('./auth');
const { validateRecord, checkDelete, validateCompany, bankAccount, isDate, ValidationError } = require('./validate');
const { seedDefaults, exampleRecords, DEFAULT_COMPANY, PROVINCES } = require('./seed');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const BACKUP_FORMAT = 'tally-books-backup';

/**
 * Create the app server.
 * @param {object} opts
 * @param {string} opts.dataDir       Folder holding companies.json and each company's database.
 * @param {string} [opts.password]    If set, HTTP Basic auth is required (any username).
 * @param {string} [opts.publicDir]   Directory of static files to serve.
 * @param {boolean} [opts.demo]       Create an example company on first run.
 */
function createApp(opts) {
  const reg = new Registry(opts.dataDir);
  const auth = new Auth(opts.dataDir);
  const ownerOnly = u => { if (u.role !== 'owner') throw new ValidationError('Only an owner can do that.', 403); };
  const backups = new Backups(opts.dataDir, reg);
  if (opts.backupFolder) backups.update({ folder: opts.backupFolder });
  if (opts.autoBackup !== false) backups.start();
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const clients = new Set();

  if (opts.demo && reg.list().length === 0) {
    createCompany({ name: 'Example Company', province: 'ON', examples: true });
  }

  function broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  }

  /** Company context: its store and a change counter that live views follow. */
  function ctxFor(id) {
    const store = reg.store(id);
    if (!store) throw new ValidationError('That company doesn’t exist. It may have been removed.', 404);
    seedDefaults(store); // no-op once set up
    return {
      id, store,
      get rev() { return Number(store.getMeta('rev') || 0); },
      bump() {
        const rev = Number(store.getMeta('rev') || 0) + 1;
        store.putMeta('rev', rev);
        broadcast({ company: id, rev });
        return rev;
      },
    };
  }

  function createCompany(body) {
    const name = String(body.name || '').trim();
    if (!name) throw new ValidationError('Give the company a name.');
    const preset = PROVINCES[body.province] || {};
    const company = validateCompany({
      ...DEFAULT_COMPANY, name, province: body.province || '',
      taxName: body.taxName || preset.taxName || DEFAULT_COMPANY.taxName,
      taxRate: body.taxRate ?? preset.taxRate ?? DEFAULT_COMPANY.taxRate,
      qstRate: body.province ? preset.qstRate || 0 : 0,
      filingFreq: body.filingFreq,
      fyStart: body.fyStart || 1,
    });
    let accounts = null;
    if (body.copyFrom) {
      const src = reg.store(body.copyFrom);
      if (!src) throw new ValidationError('The company to copy accounts from doesn’t exist.');
      accounts = src.list('accounts');
    }
    const entry = reg.create(company.name);
    const store = reg.store(entry.id);
    seedDefaults(store, { company, accounts });
    if (body.examples) loadExamples(store);
    broadcast({ companies: true });
    return entry;
  }

  function summary(c) {
    const store = reg.store(c.id);
    seedDefaults(store);
    const settings = { ...DEFAULT_COMPANY, ...(store.getSetting('company') || {}) };
    const entries = store.list('entries');
    const paid = {};
    for (const e of entries) if (e.applyTo) paid[e.applyTo] = (paid[e.applyTo] || 0) + (Number(e.amount) || 0);
    const t = new Date(); const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    let overdueCount = 0, overdue = 0, receivable = 0, payable = 0;
    for (const d of store.list('docs')) {
      const bal = Math.round(((Number(d.total) || 0) - (paid[d.id] || 0)) * 100) / 100;
      if (bal <= 0.004) continue;
      if (d.kind === 'invoice') {
        receivable += bal;
        if (d.due && d.due < today) { overdueCount++; overdue += bal; }
      } else payable += bal;
    }
    const recons = store.list('recons').map(r => r.statementDate).sort();
    return {
      ...c,
      name: settings.name,
      province: settings.province, taxName: settings.taxName, taxRate: settings.taxRate, fyStart: settings.fyStart,
      toReview: store.list('bankTxns').filter(b => b.status === 'new').length,
      overdueCount, overdue: Math.round(overdue * 100) / 100,
      receivable: Math.round(receivable * 100) / 100, payable: Math.round(payable * 100) / 100,
      lastReconciled: recons[recons.length - 1] || '',
      lastEntry: entries.reduce((m, e) => (e.date > m ? e.date : m), ''),
      transactions: entries.length,
    };
  }

  function state(ctx) {
    const out = { rev: ctx.rev, companyId: ctx.id, company: { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) } };
    for (const c of COLLECTIONS) out[c] = ctx.store.list(c);
    return out;
  }

  function applyWrite(store, w) {
    const { op, collection, id } = w;
    if (!COLLECTIONS.includes(collection)) throw new ValidationError(`Unknown collection "${collection}".`, 404);
    if (op === 'set') store.put(collection, id, validateRecord(collection, id, w.data, store));
    else if (op === 'delete') {
      checkDelete(collection, id, store);
      store.delete(collection, id);
      // A deleted transaction sends any bank lines linked to it back to "For review".
      if (collection === 'entries') {
        for (const b of store.bankTxnsForEntry(id)) store.put('bankTxns', b.id, { ...b, status: 'new', entryId: '' });
      }
    } else throw new ValidationError(`Unknown operation "${op}".`);
  }

  // Routes that work across companies.
  const globalRoutes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/auth\/me$/, req => {
      const user = auth.userFor(req);
      if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Please sign in.', 401, { setup: auth.needsSetup() });
      const { token, ...u } = user;
      return { user: u, idleMinutes: auth.data.settings.idleMinutes };
    }],
    ['POST', /^\/api\/auth\/setup$/, async (req, m, res) => {
      const body = await readJson(req);
      const u = auth.setup(body);
      const token = auth.login(u.username, body.password);
      res.setHeader('Set-Cookie', sessionCookie(token, req));
      return { ok: true, user: u };
    }],
    ['POST', /^\/api\/auth\/login$/, async (req, m, res) => {
      const body = await readJson(req);
      await new Promise(r => setTimeout(r, 250)); // slows down password guessing
      const token = auth.login(body.username, body.password);
      res.setHeader('Set-Cookie', sessionCookie(token, req));
      const { token: _, ...u } = auth.userFor({ headers: { cookie: `${COOKIE}=${token}` } });
      return { ok: true, user: u };
    }],
    ['POST', /^\/api\/auth\/logout$/, (req, m, res) => {
      auth.logout(readCookie(req, COOKIE));
      res.setHeader('Set-Cookie', sessionCookie('', req, 0));
      return { ok: true };
    }],
    ['POST', /^\/api\/auth\/password$/, async (req, m, res, user) => {
      const body = await readJson(req);
      auth.changeOwnPassword(user, body.current, body.password);
      return { ok: true };
    }],
    ['GET', /^\/api\/users$/, (req, m, res, user) => { ownerOnly(user); return { users: auth.list(), idleMinutes: auth.data.settings.idleMinutes }; }],
    ['POST', /^\/api\/users$/, async (req, m, res, user) => { ownerOnly(user); const b = await readJson(req); return { ok: true, user: auth.addUser({ ...b, mustChange: true }) }; }],
    ['PUT', /^\/api\/users\/([^/]+)$/, async (req, m, res, user) => { ownerOnly(user); return { ok: true, user: auth.updateUser(decodeURIComponent(m[1]), await readJson(req), user) }; }],
    ['PUT', /^\/api\/security$/, async (req, m, res, user) => { ownerOnly(user); auth.setIdleMinutes((await readJson(req)).idleMinutes); return { ok: true, idleMinutes: auth.data.settings.idleMinutes }; }],
    ['GET', /^\/api\/companies$/, (req, m, res, user) => ({ companies: reg.list().filter(c => auth.canSee(user, c.id)).map(summary), provinces: PROVINCES })],
    ['POST', /^\/api\/companies$/, async (req, m, res, user) => {
      ownerOnly(user);
      const entry = createCompany(await readJson(req));
      return { ok: true, company: summary(entry) };
    }],
    ['PUT', /^\/api\/companies\/([^/]+)$/, async (req, m, res, user) => {
      const body = await readJson(req);
      const id = decodeURIComponent(m[1]);
      if (!reg.get(id) || !auth.canSee(user, id)) throw new ValidationError('That company doesn’t exist.', 404);
      if (body.archived !== undefined) ownerOnly(user);
      const patch = {};
      if (body.archived !== undefined) patch.archived = !!body.archived;
      if (body.opened) patch.lastOpened = Date.now();
      reg.update(id, patch);
      if (patch.archived !== undefined) broadcast({ companies: true });
      return { ok: true, company: summary(reg.get(id)) };
    }],
    ['GET', /^\/api\/backups$/, () => backups.status()],
    ['PUT', /^\/api\/backups$/, async (req, m, res, user) => { ownerOnly(user); return backups.update(await readJson(req)); }],
    ['POST', /^\/api\/backups\/run$/, () => {
      const r = backups.run();
      if (!r.ok) throw new ValidationError(r.error, 409);
      return { ...r, status: backups.status() };
    }],
    ['POST', /^\/api\/backups\/open$/, req => {
      // Only for someone sitting at this computer: opens the folder in File Explorer / Finder.
      const ip = req.socket.remoteAddress || '';
      if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) throw new ValidationError('The backup folder can only be opened on the computer running Tally Books.', 403);
      const dir = fs.existsSync(backups.target()) ? backups.target() : backups.settings.folder;
      const { spawn } = require('node:child_process');
      const [cmd, args] = process.platform === 'win32' ? ['explorer', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
      try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* shown in the UI instead */ }
      return { ok: true, path: dir };
    }],
    ['GET', /^\/api\/events$/, (req, m, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 3000\ndata: ${JSON.stringify({ hello: true })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    }],
  ];

  // Routes inside one company: /api/c/<companyId>/...
  const companyRoutes = [
    ['GET', /^\/state$/, ctx => state(ctx)],
    ['PUT', /^\/records\/([A-Za-z]+)\/([^/]+)$/, async (ctx, req, m) => {
      const data = await readJson(req);
      ctx.store.transaction(() => applyWrite(ctx.store, { op: 'set', collection: m[1], id: decodeURIComponent(m[2]), data }));
      return { ok: true, rev: ctx.bump() };
    }],
    ['DELETE', /^\/records\/([A-Za-z]+)\/([^/]+)$/, (ctx, req, m) => {
      ctx.store.transaction(() => applyWrite(ctx.store, { op: 'delete', collection: m[1], id: decodeURIComponent(m[2]) }));
      return { ok: true, rev: ctx.bump() };
    }],
    ['POST', /^\/batch$/, async (ctx, req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.writes) || !body.writes.length) throw new ValidationError('Send a non-empty "writes" list.');
      if (body.writes.length > 500) throw new ValidationError('At most 500 writes per batch.');
      ctx.store.transaction(() => body.writes.forEach(w => applyWrite(ctx.store, w)));
      return { ok: true, rev: ctx.bump() };
    }],
    ['PUT', /^\/settings$/, async (ctx, req) => {
      const company = validateCompany(await readJson(req));
      ctx.store.putSetting('company', company);
      reg.update(ctx.id, { name: company.name });
      broadcast({ companies: true });
      return { ok: true, rev: ctx.bump() };
    }],
    ['POST', /^\/bank\/import$/, async (ctx, req) => {
      const body = await readJson(req, 20 * 1024 * 1024);
      const result = ctx.store.transaction(() => importBankRows(ctx.store, body));
      return { ok: true, rev: result.added ? ctx.bump() : ctx.rev, ...result };
    }],
    ['POST', /^\/examples$/, ctx => {
      loadExamples(ctx.store);
      return { ok: true, rev: ctx.bump() };
    }],
    ['GET', /^\/backup$/, (ctx, req, m, res) => {
      const s = state(ctx);
      const body = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), company: s.company };
      for (const c of COLLECTIONS) body[c] = s[c];
      const safe = String(s.company.name || 'books').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'books';
      const name = `${safe}-backup-${new Date().toISOString().slice(0, 10)}.json`;
      send(res, 200, JSON.stringify(body, null, 2), { 'Content-Type': MIME['.json'], 'Content-Disposition': `attachment; filename="${name}"` });
    }],
    ['POST', /^\/restore$/, async (ctx, req) => {
      const body = await readJson(req, 50 * 1024 * 1024);
      if (body.format !== BACKUP_FORMAT) throw new ValidationError('That file isn’t a Tally Books backup.');
      const company = validateCompany(body.company || {});
      ctx.store.transaction(() => {
        ctx.store.clearAll();
        ctx.store.putMeta('seeded', new Date().toISOString());
        ctx.store.putSetting('company', company);
        // COLLECTIONS is ordered so each record is checked against what it depends on.
        for (const c of COLLECTIONS) {
          for (const r of body[c] || []) {
            const { id, ...data } = r;
            ctx.store.put(c, id, validateRecord(c, id, data, ctx.store));
          }
        }
      });
      reg.update(ctx.id, { name: company.name });
      broadcast({ companies: true });
      return { ok: true, rev: ctx.bump() };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      if (opts.password && !authorized(req, opts.password)) {
        return send(res, 401, 'Sign in required', { 'WWW-Authenticate': 'Basic realm="Tally Books", charset="UTF-8"', 'Content-Type': 'text/plain' });
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req)) throw new ValidationError('Cross-site request blocked.', 403);
        // Everything except signing in needs a signed-in user.
        let user = null;
        if (!/^\/api\/(health|auth\/(me|setup|login|logout))$/.test(url.pathname)) {
          user = auth.userFor(req);
          if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Your session ended. Please sign in again.', 401, { setup: auth.needsSetup() });
          if (user.mustChange && url.pathname !== '/api/auth/password' && url.pathname !== '/api/events') throw new AuthError('Choose a new password before continuing.', 403, { mustChange: true });
        }
        const cm = url.pathname.match(/^\/api\/c\/([^/]+)(\/.*)$/);
        if (cm) {
          const cid = decodeURIComponent(cm[1]);
          if (!auth.canSee(user, cid)) throw new ValidationError('You don’t have access to that company.', 403);
          const ctx = ctxFor(cid);
          ctx.user = user;
          for (const [method, re, handler] of companyRoutes) {
            const m = cm[2].match(re);
            if (m && method === req.method) {
              const out = await handler(ctx, req, m, res);
              if (out !== undefined) sendJson(res, 200, out);
              return;
            }
          }
          return sendJson(res, 404, { error: 'Not found' });
        }
        for (const [method, re, handler] of globalRoutes) {
          const m = url.pathname.match(re);
          if (m && method === req.method) {
            const out = await handler(req, m, res, user);
            if (out !== undefined) sendJson(res, 200, out);
            return;
          }
        }
        return sendJson(res, 404, { error: 'Not found' });
      }
      return serveStatic(publicDir, url.pathname, req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message, ...(err.setup !== undefined ? { setup: err.setup } : {}), ...(err.mustChange ? { mustChange: true } : {}) });
    }
  });

  server.on('close', () => { backups.stop(); reg.closeAll(); });
  /** Stop accepting requests, end live-update streams, and close the databases. */
  server.shutdown = () => new Promise(resolve => {
    for (const res of clients) res.end();
    clients.clear();
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  server.registry = reg;
  server.backups = backups;
  server.auth = auth;
  return server;
}

function loadExamples(store) {
  const company = store.getSetting('company') || DEFAULT_COMPANY;
  const split = Number(company.qstRate) > 0 && store.get('accounts', 'a2210');
  const recs = exampleRecords(Number(company.taxRate) || 0, new Date(), split ? Number(company.qstRate) : 0);
  const order = ['contacts', 'rules', 'docs', 'entries', 'bankTxns'];
  recs.sort((a, b) => order.indexOf(a.collection) - order.indexOf(b.collection));
  try {
    store.transaction(() => recs.forEach(r => store.put(r.collection, r.id, validateRecord(r.collection, r.id, r.data, store))));
  } catch (err) {
    throw new ValidationError('Example data needs the default chart of accounts (codes 1000–7200). ' + err.message);
  }
}

/**
 * Add statement lines to "For review", skipping ones already imported.
 * A line's identity is the bank's FITID when the file has one, otherwise date + amount + description
 * (+ a counter, so two identical coffees on the same day both come in).
 */
function importBankRows(store, body) {
  const account = bankAccount(store, body.account);
  if (!Array.isArray(body.rows) || !body.rows.length) throw new ValidationError('The file has no transactions to import.');
  if (body.rows.length > 5000) throw new ValidationError('Import at most 5,000 transactions at a time.');
  const seen = new Map();
  let added = 0, skipped = 0;
  const now = Date.now();
  body.rows.forEach((r, i) => {
    const amount = Math.round(Number(r.amount) * 100) / 100;
    if (!isDate(r.date) || !Number.isFinite(amount) || amount === 0) throw new ValidationError(`Row ${i + 1} needs a valid date and a non-zero amount.`);
    const desc = String(r.desc || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    let key = r.fitid ? 'f:' + String(r.fitid).trim() : `${r.date}|${amount.toFixed(2)}|${desc.toLowerCase()}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (!r.fitid && n > 1) key += '#' + n;
    const id = 'b_' + crypto.createHash('sha1').update(account.id + '\u0000' + key).digest('hex').slice(0, 24);
    if (store.get('bankTxns', id)) { skipped++; return; }
    store.put('bankTxns', id, { account: account.id, date: r.date, amount, desc, fitid: r.fitid ? String(r.fitid) : '', status: 'new', entryId: '', imported: now, file: String(body.fileName || '').slice(0, 200) });
    added++;
  });
  return { added, skipped };
}

function authorized(req, password) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, tests)
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function readJson(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new ValidationError('Request is too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new ValidationError('Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
}

function serveStatic(dir, pathname, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(path.normalize(dir + path.sep))) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, req.method === 'HEAD' ? undefined : buf, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  });
}

module.exports = { createApp };
