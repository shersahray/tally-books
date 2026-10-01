'use strict';
// HTTP server: JSON API + static files. No third-party dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { COLLECTIONS } = require('./db');
const { Registry } = require('./companies');
const { Backups } = require('./backups');
const { AI } = require('./ai');
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
 * @param {string} [opts.require2fa]  Least two-step sign-in allowed: 'owners' or 'everyone' (use 'everyone' online).
 * @param {boolean} [opts.trustProxy] Behind a reverse proxy (Caddy): take the client's address from X-Forwarded-For.
 * @param {string} [opts.backupBlobUrl] Azure Blob Storage container URL with a SAS token, for off-site backups.
 * @param {string} [opts.aiKey]     Claude API key for AI suggestions (otherwise an owner enters one in Settings).
 * @param {string} [opts.setupCode]   If set, creating the first owner account needs this code (so a stranger can't claim a new server).
 */
function createApp(opts) {
  const reg = new Registry(opts.dataDir);
  const auth = new Auth(opts.dataDir, { require2fa: opts.require2fa });
  const ownerOnly = u => { if (u.role !== 'owner') throw new ValidationError('Only an owner can do that.', 403); };
  const notClient = u => { if (u.role === 'client') throw new ValidationError('Only your bookkeeper can do that.', 403); };
  const backups = new Backups(opts.dataDir, reg, { blobUrl: opts.backupBlobUrl });
  const ai = new AI(opts.dataDir, { envKey: opts.aiKey, apiUrl: opts.aiUrl });
  // Receipts sent in are read by AI one at a time, in the order they arrive.
  const readQueue = [];
  let readBusy = false;
  function queueRead(cid, rid, manual) { if (!readQueue.some(q => q.cid === cid && q.rid === rid)) readQueue.push({ cid, rid, tries: 0, manual: !!manual }); setImmediate(nextRead); }
  // After a restart, receipts that were waiting or half-read go back in the queue.
  setImmediate(() => {
    for (const c of reg.list()) {
      try {
        const store = reg.store(c.id);
        for (const r of store.list('receipts')) if (r.status === 'inbox' && (r.readStatus === 'waiting' || r.readStatus === 'reading')) queueRead(c.id, r.id);
      } catch { /* a damaged company is reported when it's opened */ }
    }
  });
  async function nextRead() {
    if (readBusy || closing) return;
    const q = readQueue.shift(); if (!q) return;
    readBusy = true;
    let ctx = null, again = false;
    try {
      ctx = ctxFor(q.cid);
      const r = ctx.store.get('receipts', q.rid);
      if (!r) return;
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const save = patch => { const cur = ctx.store.get('receipts', q.rid); if (cur) { ctx.store.put('receipts', q.rid, { ...cur, ...patch }); ctx.bump(); } };
      if (r.status !== 'inbox') { if (r.readStatus === 'waiting' || r.readStatus === 'reading') save({ readStatus: 'off' }); return; }
      // Each company gets up to 100 automatic reads a day, so one busy client can't use up everyone's AI budget.
      const aiKey = 'receipts-read:' + new Date().toISOString().slice(0, 10), readsToday = Number(ctx.store.getMeta(aiKey) || 0);
      if (!q.manual && readsToday >= 100) { save({ readStatus: 'off', readError: 'This company has had 100 receipts read today. The rest can be read from here.' }); return; }
      ctx.store.putMeta(aiKey, readsToday + 1);
      save({ readStatus: 'reading', readError: '' });
      try {
        const f = ctx.store.getFile(r.fileId);
        if (!f) throw new ValidationError('The photo for this receipt is missing.');
        const { draft } = await ai.read(ctx.store, company, { fileName: r.fileName, mediaType: f.mediaType, data: f.data.toString('base64') });
        save({ readStatus: 'read', draft, readAt: Date.now() });
      } catch (e) {
        // Busy with another AI request: try again shortly.
        if (e.code === 'AI_BUSY' && q.tries < 20) { q.tries++; again = true; save({ readStatus: 'waiting' }); }
        else save({ readStatus: e.status === 409 || e.status === 429 ? 'off' : 'failed', readError: e.status && e.status < 500 || e.status === 502 || e.status === 503 ? e.message : 'Reading failed.' });
      }
    } catch (e) {
      if (e.status !== 404) console.error(e);
    } finally {
      readBusy = false;
      if (again) setTimeout(() => { readQueue.push(q); nextRead(); }, 3000).unref();
      else setImmediate(nextRead);
    }
  }
  let closing = false;
  if (opts.backupFolder) backups.update({ folder: opts.backupFolder });
  if (opts.autoBackup !== false) backups.start();
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const clients = new Set();

  if (opts.demo && reg.list().length === 0) {
    createCompany({ name: 'Example Company', province: 'ON', examples: true });
  }

  // Live updates go only to people who can see that company.
  function broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) {
      const u = res.user && auth.byId(res.user.id);
      if (!u || u.disabled) { res.end(); clients.delete(res); continue; }
      if (msg.company && !auth.canSee(auth.publicUser(u), msg.company)) continue;
      res.write(line);
    }
  }
  // Behind Caddy, the last X-Forwarded-For entry is the address Caddy saw (earlier ones can be made up by the browser).
  const clientIp = req => (opts.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';
  // Wrong passwords or codes from one address: after 20 in 15 minutes, that address waits.
  const ipFails = new Map();
  function ipCheck(ip) {
    const f = ipFails.get(ip);
    if (f && Date.now() - f.since < 15 * 60 * 1000 && f.count >= 20) throw new AuthError('Too many failed sign-ins from your network. Try again in 15 minutes.', 429);
  }
  function ipFail(ip) {
    const f = ipFails.get(ip);
    if (!f || Date.now() - f.since >= 15 * 60 * 1000) ipFails.set(ip, { count: 1, since: Date.now() }); else f.count++;
    if (ipFails.size > 10000) { const old = Date.now() - 15 * 60 * 1000; for (const [k, v] of ipFails) if (v.since < old) ipFails.delete(k); }
  }
  // At most 3 sign-ins at a time from one address and 50 overall, so a flood can't get round the limits.
  const inflight = new Map();
  let inflightAll = 0;
  async function signIn(req, res, fn) {
    const ip = clientIp(req);
    ipCheck(ip);
    if ((inflight.get(ip) || 0) >= 3 || inflightAll >= 50) throw new AuthError('Too many sign-in attempts at once. Wait a moment and try again.', 429);
    inflight.set(ip, (inflight.get(ip) || 0) + 1); inflightAll++;
    try {
      await new Promise(r => setTimeout(r, 250)); // slows down guessing
      let out;
      try { out = await fn({ ip }); } catch (e) { if (e.status === 401 || e.status === 429) ipFail(ip); throw e; }
      if (out.ticket) return { ok: true, needCode: true, ticket: out.ticket };
      const token = out.token || out;
      res.setHeader('Set-Cookie', sessionCookie(token, req));
      const { token: _, ...u } = auth.userFor({ headers: { cookie: `${COOKIE}=${token}` } });
      return { ok: true, user: u };
    } finally {
      const n = (inflight.get(ip) || 1) - 1;
      if (n > 0) inflight.set(ip, n); else inflight.delete(ip);
      inflightAll--;
    }
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

  function createCompany(body, user) {
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
      lang: body.lang,
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
    store.audit(user, 'create', { summary: `company created${body.copyFrom ? ' with a copied chart of accounts' : ''}${body.examples ? ', with example data' : ''}` });
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

  function applyWrite(store, w, user) {
    const { op, collection, id } = w;
    if (!COLLECTIONS.includes(collection)) throw new ValidationError(`Unknown collection "${collection}".`, 404);
    // Receipts are created only by the upload route (or a restore), never by a plain write.
    if (collection === 'receipts' && op === 'set' && !store.get('receipts', id)) throw new ValidationError('Add receipts from the Receipts screen.');
    if (collection === 'receipts' && user && user.role === 'client') {
      // Clients can add a note to, or remove, a receipt they sent that hasn't been dealt with yet.
      const r = store.get('receipts', id);
      const own = r && r.uploadedBy === user.username && r.status === 'inbox' && !r.entryId && !r.docId && !r.wasAttached;
      const noteOnly = op === 'set' && own && w.data && (w.data.status || 'inbox') === 'inbox' && !w.data.entryId && !w.data.docId;
      if (!(op === 'delete' ? own : noteOnly)) throw new ValidationError('Your bookkeeper takes care of receipts once they’re sent.', 403);
    }
    // Social insurance numbers never go into the activity log in full.
    const hideSin = r => (r && r.sin ? { ...r, sin: '•••••' + String(r.sin).slice(-3) } : r);
    const before = collection === 'employees' ? hideSin(store.get(collection, id)) : store.get(collection, id);
    if (op === 'set') {
      const data = validateRecord(collection, id, w.data, store);
      store.put(collection, id, data);
      const after = collection === 'employees' ? hideSin(store.get(collection, id)) : store.get(collection, id);
      if (JSON.stringify(before) !== JSON.stringify(after)) store.audit(user, before ? 'change' : 'add', { collection, id, summary: auditSummary(collection, after), before, after });
    } else if (op === 'delete') {
      checkDelete(collection, id, store);
      store.delete(collection, id);
      if (collection === 'receipts' && before && before.fileId) store.deleteFile(before.fileId);
      // A receipt attached to a deleted transaction or bill goes back to the inbox.
      if (collection === 'entries' || collection === 'docs') {
        const key = collection === 'entries' ? 'entryId' : 'docId';
        for (const r of store.list('receipts').filter(x => x[key] === id)) store.put('receipts', r.id, { ...r, [key]: '', status: 'inbox' });
      }
      if (before) store.audit(user, 'delete', { collection, id, summary: auditSummary(collection, before), before });
      // A deleted transaction sends any bank lines linked to it back to "For review".
      if (collection === 'entries') {
        for (const b of store.bankTxnsForEntry(id)) store.put('bankTxns', b.id, { ...b, status: 'new', entryId: '' });
      }
    } else throw new ValidationError(`Unknown operation "${op}".`);
  }

  // A one-line description of a record for the audit log.
  function auditSummary(col, d) {
    if (!d) return '';
    const amt = n => '$' + (Number(n) || 0).toFixed(2);
    const tot = e => (e.lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
    switch (col) {
      case 'entries': return `${d.type} ${d.date}${d.ref ? ' #' + d.ref : ''} ${amt(tot(d))}${d.memo ? ' · ' + String(d.memo).slice(0, 60) : ''}`;
      case 'docs': return `${d.kind}${d.number ? ' #' + d.number : ''} ${d.date} ${amt(d.total)}`;
      case 'accounts': return `${d.code ? d.code + ' ' : ''}${d.name}`;
      case 'contacts': case 'employees': return d.name || '';
      case 'bankTxns': return `${d.date} ${amt(d.amount)} ${String(d.desc || '').slice(0, 50)} (${d.status})`;
      case 'rules': return `when "${d.text}"`;
      case 'recons': return `statement ${d.statementDate} ending ${amt(d.endingBalance)}`;
      case 'filings': return `${d.tax === 'qst' ? 'QST' : 'GST/HST'} ${d.from} to ${d.to}`;
      case 'payruns': return `pay date ${d.payDate}, ${(d.lines || []).length} employee(s)`;
      default: return '';
    }
  }

  // Routes that work across companies.
  const globalRoutes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/auth\/me$/, req => {
      const user = auth.userFor(req);
      if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Please sign in.', 401, { setup: auth.needsSetup(), setupCode: auth.needsSetup() && !!opts.setupCode });
      const { token, ...u } = user;
      return { user: u, idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.policy2fa };
    }],
    ['POST', /^\/api\/auth\/setup$/, async (req, m, res) => {
      const body = await readJson(req);
      if (opts.setupCode && auth.needsSetup()) {
        const ip = clientIp(req);
        ipCheck(ip);
        const a = crypto.createHash('sha256').update(String(body.setupCode || '').trim()).digest(), b = crypto.createHash('sha256').update(String(opts.setupCode).trim()).digest();
        if (!crypto.timingSafeEqual(a, b)) { ipFail(ip); throw new AuthError('The setup code isn’t right. It’s the SETUP_CODE you chose when the server was set up.', 403); }
      }
      const u = auth.setup(body);
      const { token } = await auth.login(u.username, body.password, { ip: clientIp(req) });
      res.setHeader('Set-Cookie', sessionCookie(token, req));
      return { ok: true, user: u };
    }],
    ['POST', /^\/api\/auth\/login$/, async (req, m, res) => {
      const body = await readJson(req);
      return signIn(req, res, meta => auth.login(body.username, body.password, meta));
    }],
    ['POST', /^\/api\/auth\/login\/code$/, async (req, m, res) => {
      const body = await readJson(req);
      return signIn(req, res, async meta => ({ token: auth.loginCode(body.ticket, body.code, meta) }));
    }],
    // Invitation and password reset links: look one up, then set the password.
    ['POST', /^\/api\/auth\/link$/, async req => {
      const body = await readJson(req);
      ipCheck(clientIp(req));
      try { return auth.peekLink(body.token); } catch (e) { ipFail(clientIp(req)); throw e; }
    }],
    ['POST', /^\/api\/auth\/link\/accept$/, async (req, m, res) => {
      const body = await readJson(req);
      return signIn(req, res, async meta => auth.login(auth.acceptLink(body.token, body.password).username, body.password, meta));
    }],
    ['PUT', /^\/api\/auth\/prefs$/, async (req, m, res, user) => ({ ok: true, user: auth.setPrefs(user, await readJson(req)) })],
    ['POST', /^\/api\/auth\/2fa\/start$/, async (req, m, res, user) => auth.start2fa(user, (await readJson(req)).password)],
    ['POST', /^\/api\/auth\/2fa\/confirm$/, async (req, m, res, user) => ({ ok: true, ...auth.confirm2fa(user, (await readJson(req)).code) })],
    ['POST', /^\/api\/auth\/2fa\/disable$/, async (req, m, res, user) => { auth.disable2fa(user, (await readJson(req)).password); return { ok: true }; }],
    ['POST', /^\/api\/auth\/2fa\/recovery$/, async (req, m, res, user) => ({ ok: true, ...auth.newRecovery(user, (await readJson(req)).password) })],
    ['POST', /^\/api\/auth\/logout$/, (req, m, res) => {
      const u = auth.userFor(req, { touch: false });
      if (u) auth.log('logout', { username: u.username });
      auth.logout(readCookie(req, COOKIE));
      res.setHeader('Set-Cookie', sessionCookie('', req, 0));
      return { ok: true };
    }],
    ['POST', /^\/api\/auth\/password$/, async (req, m, res, user) => {
      const body = await readJson(req);
      auth.changeOwnPassword(user, body.current, body.password);
      return { ok: true };
    }],
    ['GET', /^\/api\/users$/, (req, m, res, user) => { ownerOnly(user); return { users: auth.list(), idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.data.settings.require2fa || 'off', forced2fa: auth.forced2fa }; }],
    ['POST', /^\/api\/users$/, async (req, m, res, user) => {
      ownerOnly(user);
      const b = await readJson(req);
      const u = auth.addUser({ ...b, mustChange: !b.invite });
      auth.log('user-added', { username: u.username, by: user.username, role: u.role });
      return { ok: true, user: u };
    }],
    ['PUT', /^\/api\/users\/([^/]+)$/, async (req, m, res, user) => { ownerOnly(user); return { ok: true, user: auth.updateUser(decodeURIComponent(m[1]), await readJson(req), user) }; }],
    ['POST', /^\/api\/users\/([^/]+)\/link$/, (req, m, res, user) => {
      ownerOnly(user);
      const out = auth.issueLink(decodeURIComponent(m[1]));
      auth.log(out.kind === 'invite' ? 'invite-link' : 'reset-link', { username: auth.byId(decodeURIComponent(m[1])).username, by: user.username });
      return { ok: true, ...out };
    }],
    ['PUT', /^\/api\/security$/, async (req, m, res, user) => {
      ownerOnly(user);
      const b = await readJson(req);
      if (b.idleMinutes !== undefined) auth.setIdleMinutes(b.idleMinutes);
      if (b.require2fa !== undefined) auth.setRequire2fa(b.require2fa);
      auth.log('security-changed', { by: user.username, ...b });
      return { ok: true, idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.data.settings.require2fa };
    }],
    ['GET', /^\/api\/security\/log$/, (req, m, res, user) => { ownerOnly(user); return { log: auth.readLog(1000) }; }],
    ['GET', /^\/api\/companies$/, (req, m, res, user) => ({ companies: reg.list().filter(c => auth.canSee(user, c.id)).map(summary), provinces: PROVINCES })],
    ['POST', /^\/api\/companies$/, async (req, m, res, user) => {
      ownerOnly(user);
      const entry = createCompany(await readJson(req), user);
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
    ['GET', /^\/api\/backups$/, (req, m, res, user) => {
      if (user.role === 'client') return { enabled: true, hidden: true };
      const st = backups.status();
      if (user.role === 'owner') return st;
      // Staff see whether backups are working, not where they're kept.
      return { enabled: st.enabled, lastRun: st.lastRun, lastCount: st.lastCount, lastError: st.lastError ? 'The latest backup had a problem. An owner can see the details.' : '', offsite: st.offsite ? { lastRun: st.offsite.lastRun, where: 'off-site storage' } : null, limited: true };
    }],
    ['PUT', /^\/api\/backups$/, async (req, m, res, user) => { ownerOnly(user); return backups.update(await readJson(req)); }],
    ['POST', /^\/api\/backups\/run$/, async (req, m, res, user) => {
      ownerOnly(user);
      const r = backups.run();
      if (!r.ok) throw new ValidationError(r.error, 409);
      if (r.upload) { const up = await r.upload; delete r.upload; if (up.lastError) throw new ValidationError(up.lastError, 502); }
      return { ...r, status: backups.status() };
    }],
    ['POST', /^\/api\/backups\/open$/, (req, m, res, user) => {
      notClient(user);
      // Only for someone sitting at this computer: opens the folder in File Explorer / Finder.
      const ip = req.socket.remoteAddress || '';
      if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) throw new ValidationError('The backup folder can only be opened on the computer running Tally Books.', 403);
      const dir = fs.existsSync(backups.target()) ? backups.target() : backups.settings.folder;
      const { spawn } = require('node:child_process');
      const [cmd, args] = process.platform === 'win32' ? ['explorer', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
      try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* shown in the UI instead */ }
      return { ok: true, path: dir };
    }],
    ['GET', /^\/api\/ai$/, (req, m, res, user) => (user.role === 'owner' ? ai.status(true) : { configured: ai.status().configured })],
    ['PUT', /^\/api\/ai$/, async (req, m, res, user) => {
      ownerOnly(user);
      const body = await readJson(req);
      const st = ai.update(body);
      auth.log('ai-settings', { username: user.username, ip: clientIp(req), change: body.apiKey !== undefined ? (body.apiKey ? 'API key changed' : 'API key removed') : 'settings changed' });
      return st;
    }],
    ['GET', /^\/api\/events$/, (req, m, res, user) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.user = user;
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
      ctx.store.transaction(() => applyWrite(ctx.store, { op: 'set', collection: m[1], id: decodeURIComponent(m[2]), data }, ctx.user));
      return { ok: true, rev: ctx.bump() };
    }],
    ['DELETE', /^\/records\/([A-Za-z]+)\/([^/]+)$/, (ctx, req, m) => {
      ctx.store.transaction(() => applyWrite(ctx.store, { op: 'delete', collection: m[1], id: decodeURIComponent(m[2]) }, ctx.user));
      return { ok: true, rev: ctx.bump() };
    }],
    ['POST', /^\/batch$/, async (ctx, req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.writes) || !body.writes.length) throw new ValidationError('Send a non-empty "writes" list.');
      if (body.writes.length > 500) throw new ValidationError('At most 500 writes per batch.');
      ctx.store.transaction(() => body.writes.forEach(w => applyWrite(ctx.store, w, ctx.user)));
      return { ok: true, rev: ctx.bump() };
    }],
    ['PUT', /^\/settings$/, async (ctx, req) => {
      notClient(ctx.user);
      const company = validateCompany(await readJson(req));
      const before = ctx.store.getSetting('company');
      ctx.store.transaction(() => {
        ctx.store.putSetting('company', company);
        ctx.store.audit(ctx.user, 'settings', { collection: 'settings', id: 'company', summary: 'company settings', before, after: company });
      });
      reg.update(ctx.id, { name: company.name });
      broadcast({ companies: true });
      return { ok: true, rev: ctx.bump() };
    }],
    ['POST', /^\/bank\/import$/, async (ctx, req) => {
      const body = await readJson(req, 20 * 1024 * 1024);
      const result = ctx.store.transaction(() => {
        const r = importBankRows(ctx.store, body);
        if (r.added) ctx.store.audit(ctx.user, 'import', { collection: 'bankTxns', summary: `imported ${r.added} bank line(s) from ${String(body.fileName || 'a file').slice(0, 100)}` });
        return r;
      });
      return { ok: true, rev: result.added ? ctx.bump() : ctx.rev, ...result };
    }],
    // AI suggestions for bank lines waiting for review. Suggestions are saved on each line; nothing is added to the books.
    ['POST', /^\/ai\/suggest$/, async (ctx, req) => {
      notClient(ctx.user); // AI costs money: only the bookkeeper's team uses it
      const body = await readJson(req);
      if (!Array.isArray(body.ids) || !body.ids.length) throw new ValidationError('Choose the bank lines to suggest categories for.');
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const { suggestions, usd } = await ai.suggest(ctx.store, company, body.ids.map(String));
      const n = Object.keys(suggestions).length;
      if (!n) return { ok: true, count: 0, usd, rev: ctx.rev };
      ctx.store.transaction(() => {
        for (const [id, sug] of Object.entries(suggestions)) {
          const b = ctx.store.get('bankTxns', id);
          if (b && b.status === 'new') ctx.store.put('bankTxns', id, { ...b, ai: sug });
        }
        ctx.store.audit(ctx.user, 'ai', { collection: 'bankTxns', summary: `AI suggested categories for ${n} bank line(s)` });
      });
      return { ok: true, count: n, usd, rev: ctx.bump() };
    }],
    // Receipts: a photo or PDF sent from the Receipts screen (often a client's phone).
    ['POST', /^\/receipts$/, async (ctx, req) => {
      // Count every upload today (deleted ones too), so the daily limit can't be dodged.
      const dayKey = 'receipts-sent:' + new Date().toISOString().slice(0, 10);
      const sentToday = Number(ctx.store.getMeta(dayKey) || 0);
      if (sentToday >= 300) throw new ValidationError('That’s 300 receipts today for this company. Send the rest tomorrow.', 429);
      const body = (await readJson(req, 15 * 1024 * 1024)) || {};
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!data.length) throw new ValidationError('That file is empty.');
      if (data.length > 10 * 1024 * 1024) throw new ValidationError('That file is over 10 MB. Try a smaller photo or a shorter PDF.', 413);
      const mediaType = sniffType(data);
      if (!mediaType) throw new ValidationError('Choose a PDF or a photo (JPEG, PNG or WebP).');
      const id = crypto.randomUUID(), fileId = crypto.randomUUID();
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const canRead = ai.status().configured && company.ai;
      const fileName = String(body.fileName || 'receipt').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 120);
      const rec = { fileId, fileName, mediaType, size: data.length, uploadedBy: ctx.user.username, uploadedByName: ctx.user.name || ctx.user.username, uploadedAt: Date.now(),
        readStatus: canRead ? 'waiting' : 'off', readError: '', status: 'inbox', note: String(body.note || '').slice(0, 500), entryId: '', docId: '' };
      ctx.store.transaction(() => {
        ctx.store.putMeta(dayKey, sentToday + 1);
        ctx.store.putFile(fileId, { mediaType, name: fileName, data });
        ctx.store.put('receipts', id, rec);
        ctx.store.audit(ctx.user, 'add', { collection: 'receipts', id, summary: `receipt ${fileName}`, after: rec });
      });
      if (canRead) queueRead(ctx.id, id);
      return { ok: true, id, rev: ctx.bump() };
    }],
    ['GET', /^\/files\/([A-Za-z0-9-]+)$/, (ctx, req, m, res) => {
      const f = ctx.store.getFile(m[1]);
      if (!f) throw new ValidationError('That file isn’t here any more.', 404);
      const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[f.mediaType] || 'bin';
      const safe = (f.name || 'receipt').replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\.[A-Za-z0-9]+$/, '').slice(0, 60) || 'receipt';
      res.writeHead(200, { 'Content-Type': f.mediaType, 'Content-Length': f.data.length, 'Content-Disposition': `inline; filename="${safe}.${ext}"`,
        'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
        // Photos open with nothing allowed to run. (A sandbox would stop the browser's PDF viewer, so PDFs get only the type check.)
        'Content-Security-Policy': f.mediaType === 'application/pdf' ? "frame-ancestors 'none'" : "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      res.end(f.data);
    }],
    ['POST', /^\/receipts\/([A-Za-z0-9-]+)\/read$/, (ctx, req, m) => {
      notClient(ctx.user);
      const r = ctx.store.get('receipts', m[1]);
      if (!r) throw new ValidationError('That receipt isn’t here any more.', 404);
      if (r.status !== 'inbox') throw new ValidationError('Only receipts waiting for review are read.', 409);
      ai.precheck({ ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) });
      ctx.store.put('receipts', r.id, { ...r, readStatus: 'waiting', readError: '' });
      queueRead(ctx.id, r.id, true);
      return { ok: true, rev: ctx.bump() };
    }],
    // Read a receipt or bill with AI and return a draft. Nothing is saved; the file isn't kept.
    ['POST', /^\/ai\/read$/, async (ctx, req) => {
      notClient(ctx.user);
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      ai.precheck(company); // before reading a large upload
      const body = (await readJson(req, 15 * 1024 * 1024)) || {};
      const out = await ai.read(ctx.store, company, body);
      ctx.store.audit(ctx.user, 'ai', { summary: `AI read ${String(body.fileName || 'a document').slice(0, 80)}` });
      return { ok: true, ...out };
    }],
    ['POST', /^\/examples$/, ctx => {
      notClient(ctx.user);
      loadExamples(ctx.store);
      ctx.store.audit(ctx.user, 'examples', { summary: 'loaded example data' });
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
      ownerOnly(ctx.user);
      if (body.format !== BACKUP_FORMAT) throw new ValidationError('That file isn’t a Tally Books backup.');
      const company = validateCompany(body.company || {});
      // Keep a copy of what's about to be replaced, in the data folder, in case the wrong file was chosen.
      const snapDir = path.join(opts.dataDir, 'before-restore');
      fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
      const snap = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), company: ctx.store.getSetting('company') };
      for (const c of COLLECTIONS) snap[c] = ctx.store.list(c);
      fs.writeFileSync(path.join(snapDir, `${ctx.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(snap), { mode: 0o600 });
      let skippedReceipts = 0;
      ctx.store.transaction(() => {
        ctx.store.clearAll();
        ctx.store.putMeta('seeded', new Date().toISOString());
        ctx.store.putSetting('company', company);
        // COLLECTIONS is ordered so each record is checked against what it depends on.
        for (const c of COLLECTIONS) {
          for (const r of body[c] || []) {
            const { id, ...data } = r;
            if (c === 'receipts' && !(data.fileId && ctx.store.hasFile(String(data.fileId)))) { skippedReceipts++; continue; } // photo isn't in this company's files
            ctx.store.put(c, id, validateRecord(c, id, data, ctx.store));
          }
        }
      });
      ctx.store.audit(ctx.user, 'restore', { summary: `restored a backup exported ${String(body.exportedAt || '').slice(0, 10) || 'on an unknown date'}` });
      reg.update(ctx.id, { name: company.name });
      broadcast({ companies: true });
      return { ok: true, rev: ctx.bump(), skippedReceipts };
    }],
    // Audit log for this company (owners and staff).
    ['GET', /^\/audit$/, (ctx, req) => {
      notClient(ctx.user);
      const q = new URL(req.url, 'http://x').searchParams;
      return { rows: ctx.store.auditList({ before: q.get('before'), from: q.get('from'), to: q.get('to'), username: q.get('user'), collection: q.get('collection'), recordId: q.get('record'), limit: q.get('limit') }), users: ctx.store.auditUsers() };
    }],
    ['GET', /^\/audit\/(\d+)$/, (ctx, req, m) => {
      notClient(ctx.user);
      const r = ctx.store.auditList({ before: Number(m[1]) + 1, limit: 1, full: true })[0];
      if (!r || r.seq !== Number(m[1])) throw new ValidationError('That change isn’t in the log.', 404);
      return r;
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
        if (!/^\/api\/(health|auth\/(me|setup|login|login\/code|logout|link|link\/accept))$/.test(url.pathname)) {
          user = auth.userFor(req);
          if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Your session ended. Please sign in again.', 401, { setup: auth.needsSetup() });
          if (user.mustChange && !['/api/auth/password', '/api/auth/prefs', '/api/events'].includes(url.pathname)) throw new AuthError('Choose a new password before continuing.', 403, { mustChange: true });
          if (user.mustEnroll && !/^\/api\/(auth\/(password|prefs|2fa\/start|2fa\/confirm)|events)$/.test(url.pathname)) throw new AuthError('Set up two-step sign-in before continuing.', 403, { mustEnroll: true });
        }
        const cm = url.pathname.match(/^\/api\/c\/([^/]+)(\/.*)$/);
        if (cm) {
          const cid = decodeURIComponent(cm[1]);
          if (!auth.canSee(user, cid)) throw new ValidationError('You don’t have access to that company.', 403);
          if (user.readOnly && req.method !== 'GET') throw new ValidationError('Your account is view only, so you can’t make changes.', 403);
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
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message, ...(err.setup !== undefined ? { setup: err.setup } : {}), ...(err.setupCode ? { setupCode: true } : {}), ...(err.mustChange ? { mustChange: true } : {}), ...(err.mustEnroll ? { mustEnroll: true } : {}), ...(err.restart ? { restart: true } : {}) });
    }
  });

  server.on('close', () => { closing = true; backups.stop(); reg.closeAll(); });
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
  const recs = exampleRecords(Number(company.taxRate) || 0, new Date(), split ? Number(company.qstRate) : 0, company.province, company.lang);
  const order = ['contacts', 'employees', 'rules', 'docs', 'entries', 'bankTxns'];
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

// Content Security Policy: scripts only from this server; fonts from Google Fonts.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function send(res, status, body, headers = {}) {
  const https = res.req && (res.req.headers['x-forwarded-proto'] === 'https' || res.req.socket.encrypted);
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}), ...headers });
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

/** What a file really is, from its first bytes (not what the browser claims). Only receipt types. */
function sniffType(b) {
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}
