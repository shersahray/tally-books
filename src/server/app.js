'use strict';
// HTTP server: JSON API + static files. No third-party dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, COLLECTIONS } = require('./db');
const { validateRecord, checkDelete, validateCompany, bankAccount, isDate, ValidationError } = require('./validate');
const { seedDefaults, exampleRecords, DEFAULT_COMPANY } = require('./seed');

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
 * @param {string} opts.dbPath        SQLite file path (or ':memory:')
 * @param {string} [opts.password]    If set, HTTP Basic auth is required (any username).
 * @param {string} [opts.publicDir]   Directory of static files to serve.
 * @param {boolean} [opts.demo]       Load example data on first run.
 */
function createApp(opts) {
  const store = new Store(opts.dbPath);
  const firstRun = seedDefaults(store);
  if (firstRun && opts.demo) loadExamples(store);
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const clients = new Set();
  let rev = Number(store.getMeta('rev') || 0);

  function bump() {
    rev += 1;
    store.putMeta('rev', rev);
    const msg = `data: ${JSON.stringify({ rev })}\n\n`;
    for (const res of clients) res.write(msg);
  }

  function state() {
    const out = { rev, company: { ...DEFAULT_COMPANY, ...(store.getSetting('company') || {}) } };
    for (const c of COLLECTIONS) out[c] = store.list(c);
    return out;
  }

  function applyWrite(w) {
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

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, rev })],
    ['GET', /^\/api\/state$/, () => state()],
    ['PUT', /^\/api\/records\/([A-Za-z]+)\/([^/]+)$/, async (req, m) => {
      const data = await readJson(req);
      store.transaction(() => applyWrite({ op: 'set', collection: m[1], id: decodeURIComponent(m[2]), data }));
      bump();
      return { ok: true, rev };
    }],
    ['DELETE', /^\/api\/records\/([A-Za-z]+)\/([^/]+)$/, (req, m) => {
      store.transaction(() => applyWrite({ op: 'delete', collection: m[1], id: decodeURIComponent(m[2]) }));
      bump();
      return { ok: true, rev };
    }],
    ['POST', /^\/api\/batch$/, async req => {
      const body = await readJson(req);
      if (!Array.isArray(body.writes) || !body.writes.length) throw new ValidationError('Send a non-empty "writes" list.');
      if (body.writes.length > 500) throw new ValidationError('At most 500 writes per batch.');
      store.transaction(() => body.writes.forEach(applyWrite));
      bump();
      return { ok: true, rev };
    }],
    ['PUT', /^\/api\/settings$/, async req => {
      store.putSetting('company', validateCompany(await readJson(req)));
      bump();
      return { ok: true, rev };
    }],
    ['POST', /^\/api\/bank\/import$/, async req => {
      const body = await readJson(req, 20 * 1024 * 1024);
      const result = store.transaction(() => importBankRows(store, body));
      if (result.added) bump();
      return { ok: true, rev, ...result };
    }],
    ['POST', /^\/api\/examples$/, () => {
      loadExamples(store);
      bump();
      return { ok: true, rev };
    }],
    ['GET', /^\/api\/backup$/, (req, m, res) => {
      const s = state();
      const body = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), company: s.company };
      for (const c of COLLECTIONS) body[c] = s[c];
      const name = `tally-books-backup-${new Date().toISOString().slice(0, 10)}.json`;
      send(res, 200, JSON.stringify(body, null, 2), { 'Content-Type': MIME['.json'], 'Content-Disposition': `attachment; filename="${name}"` });
    }],
    ['POST', /^\/api\/restore$/, async req => {
      const body = await readJson(req, 50 * 1024 * 1024);
      if (body.format !== BACKUP_FORMAT) throw new ValidationError('That file isn’t a Tally Books backup.');
      store.transaction(() => {
        store.clearAll();
        store.putSetting('company', validateCompany(body.company || {}));
        // COLLECTIONS is ordered so each record is checked against what it depends on.
        for (const c of COLLECTIONS) {
          for (const r of body[c] || []) {
            const { id, ...data } = r;
            store.put(c, id, validateRecord(c, id, data, store));
          }
        }
      });
      bump();
      return { ok: true, rev };
    }],
    ['GET', /^\/api\/events$/, (req, m, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 3000\ndata: ${JSON.stringify({ rev })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
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
        for (const [method, re, handler] of routes) {
          const m = url.pathname.match(re);
          if (m && method === req.method) {
            const out = await handler(req, m, res);
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
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
    }
  });

  server.on('close', () => store.close());
  /** Stop accepting requests, end live-update streams, and close the database. */
  server.shutdown = () => new Promise(resolve => {
    for (const res of clients) res.end();
    clients.clear();
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  server.store = store;
  return server;
}

function loadExamples(store) {
  const company = store.getSetting('company') || DEFAULT_COMPANY;
  const recs = exampleRecords(Number(company.taxRate) || 0);
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
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
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
