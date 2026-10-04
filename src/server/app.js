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
const mail = require('./mail');
const { Auth, AuthError, sessionCookie, readCookie, COOKIE } = require('./auth');
const { Licence, Issuer, localDay, addDays } = require('./licence');
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
 * @param {boolean} [opts.mailInsecureTls] Tests only: accept the test mail server's certificate.
 * @param {boolean} [opts.mailAllowLocal]  Tests only: allow a mail server on this computer or the local network.
 * @param {string} [opts.aiKey]     Claude API key for AI suggestions (otherwise an owner enters one in Settings).
 * @param {string} [opts.licenceDir]  Where the licence is kept (the desktop app's own folder, so it stays with the computer, not the books).
 * @param {number} [opts.licenceTrialDays] Days of free trial before a code is needed (default 30; 0 = a code from the start).
 * @param {string[]} [opts.licenceKeys] Public keys that sign licence codes (the installed desktop app): turns licensing on.
 * @param {string} [opts.setupCode]   If set, creating the first owner account needs this code (so a stranger can't claim a new server).
 */
function createApp(opts) {
  const reg = new Registry(opts.dataDir);
  const auth = new Auth(opts.dataDir, { require2fa: opts.require2fa });
  reg.adoptFirm(auth.mainFirmId);
  // Desktop licence codes (licence.js). With a licence, its plan is the plan for everything in this copy.
  // The first day and latest day seen are also kept with the books (users.json), so deleting licence.json doesn't start a new trial.
  const licence = new Licence(opts.licenceDir || opts.dataDir, { publicKeys: opts.licenceKeys || [], now: opts.now, trialDays: opts.licenceTrialDays,
    memo: { get: () => auth.data.settings.licenceDays, set: v => { const c = auth.data.settings.licenceDays || {}; if (c.firstDay !== v.firstDay || c.lastSeen !== v.lastSeen) { auth.data.settings.licenceDays = v; auth.save(); } } } });
  const issuer = new Issuer(opts.licenceDir || opts.dataDir, { now: opts.now });
  const licencePlan = () => (licence.on ? licence.status().plan : null);
  auth.planOverride = licencePlan;
  const licenceInfo = u => {
    const admin = !!(u && u.role === 'owner' && u.platformAdmin);
    return { ...licence.status(), canEnter: admin && licence.on, canIssue: admin && (!licence.on || licence.isIssuer()) };
  };
  const ownerOnly = u => { if (u.role !== 'owner') throw new ValidationError('Only an owner can do that.', 403); };
  // Server-wide settings (backups, the AI key, firms) belong to the server's administrators, not to each firm.
  const adminOnly = u => { if (u.role !== 'owner' || !u.platformAdmin) throw new ValidationError('Only the server’s administrator can do that.', 403); };
  /** Making licence codes: administrators, and in a licensed desktop copy only the seller's own (it holds the key). */
  const canIssue = u => { adminOnly(u); if (licence.on && !licence.isIssuer()) throw new ValidationError('Licence codes are made in your own copy of Sumlora.', 403); };
  /** Can this person see this company? Only companies of their own firm, and then as their role allows. */
  const canSeeCo = (user, cid) => { const c = reg.get(cid); return !!(c && user && c.firmId === user.firmId && auth.canSee(user, cid)); };
  /** AI costs the server's owner money, so each firm uses it only when an administrator allows it. */
  const PLANS = require('../../public/plans.js');
  /** Is a plan feature on for this company: in its firm's plan, and not switched off in its settings? */
  const featureOn = (cid, key, store) => {
    const c = reg.get(cid), f = c && auth.firm(c.firmId);
    const settings = (store || reg.store(cid)).getSetting('company') || {};
    return PLANS.featureOn(licencePlan() || (f ? f.plan : 'plus'), settings.features, key);
  };
  const needFeature = (cid, key, store) => {
    if (!featureOn(cid, key, store)) throw new ValidationError(`${PLANS.FEATURES[key].label} isn’t part of this company’s plan.`, 403);
  };
  const firmAi = cid => { const c = reg.get(cid); const f = c && auth.firm(c.firmId); return !!(f && f.ai) && featureOn(cid, 'ai'); };
  const needFirmAi = cid => {
    needFeature(cid, 'ai');
    if (!firmAi(cid)) throw new ValidationError('AI suggestions aren’t turned on for your firm. Ask the server’s administrator.', 403);
    const f = auth.firm(reg.get(cid).firmId);
    // Firms other than the administrators' each have a monthly limit, so one firm can't use the whole server's AI budget.
    if (f.id !== auth.mainFirmId && ai.firmSpent(f.id) >= (f.aiCapUsd ?? 10)) throw new ValidationError(`Your firm’s AI limit for this month, $${Number(f.aiCapUsd ?? 10).toFixed(2)}, has been reached. The server’s administrator can raise it.`, 429);
  };
  const chargeFirm = (cid, usd) => { const c = reg.get(cid); if (c) ai.addFirmUsage(c.firmId, usd); };
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
      if (!firmAi(q.cid)) { save({ readStatus: 'off', readError: 'AI isn’t turned on for this firm.' }); return; }
      // Each company gets up to 100 automatic reads a day, so one busy client can't use up everyone's AI budget.
      const aiKey = 'receipts-read:' + new Date().toISOString().slice(0, 10), readsToday = Number(ctx.store.getMeta(aiKey) || 0);
      if (!q.manual && readsToday >= 100) { save({ readStatus: 'off', readError: 'This company has had 100 receipts read today. The rest can be read from here.' }); return; }
      ctx.store.putMeta(aiKey, readsToday + 1);
      save({ readStatus: 'reading', readError: '' });
      try {
        const f = ctx.store.getFile(r.fileId);
        if (!f) throw new ValidationError('The photo for this receipt is missing.');
        try { needFirmAi(q.cid); } catch (e) { save({ readStatus: 'off', readError: e.message }); return; }
        const { draft, usd } = await ai.read(ctx.store, company, { fileName: r.fileName, mediaType: f.mediaType, data: f.data.toString('base64') });
        chargeFirm(q.cid, usd);
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
      // A stream outlives its session (sign-out, inactivity, a suspended firm): end it then.
      if (!u || u.disabled || auth.firmBlock(u) || !auth.sessionAlive(res.token)) { res.end(); clients.delete(res); continue; }
      if (msg.firmId && u.firmId !== msg.firmId) continue;
      if (msg.company && !canSeeCo(auth.publicUser(u), msg.company)) continue;
      res.write(line);
    }
  }
  // Behind Caddy, the last X-Forwarded-For entry is the address Caddy saw (earlier ones can be made up by the browser).
  const clientIp = req => (opts.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';
  // Wrong passwords or codes from one address: after 20 in 15 minutes, that address waits.
  const ipFails = new Map();
  const signupsByIp = new Map(); // address|day -> new firms signed up
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

  /* ---------- company code ----------
     An optional 4-digit code per company, so the team opens the right client's books.
     Owners and staff type it each time they open the company; clients never need it. */
  const CODE_TTL = 12 * 60 * 60 * 1000;
  const codeOpen = new Map(); // `${session}|${companyId}` -> expiry
  const codeFails = new Map();
  function hashCode(code) {
    code = String(code == null ? '' : code);
    if (!/^\d{4}$/.test(code)) throw new ValidationError('The company code has to be 4 digits.');
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: crypto.scryptSync(code, salt, 32).toString('hex') };
  }
  const hasCode = store => !!(store.getSetting('companyCode') || {}).hash;
  function codeGate(user, cid, store) {
    if (!user || user.role === 'client' || !hasCode(store)) return;
    const k = `${user.token}|${cid}`, t = codeOpen.get(k);
    if (t && t > Date.now()) return;
    codeOpen.delete(k);
    throw Object.assign(new ValidationError('Enter this company’s 4-digit code to open it.', 423), { codeRequired: true });
  }

  function createCompany(body, user) {
    const name = String(body.name || '').trim();
    if (!name) throw new ValidationError('Give the company a name.');
    if (body.code !== undefined && body.code !== '' && !/^\d{4}$/.test(String(body.code))) throw new ValidationError('The company code has to be 4 digits.');
    const preset = PROVINCES[body.province] || {};
    const company = validateCompany({
      ...DEFAULT_COMPANY, name, province: body.province || '',
      taxName: body.taxName || preset.taxName || DEFAULT_COMPANY.taxName,
      taxRate: body.taxRate ?? preset.taxRate ?? DEFAULT_COMPANY.taxRate,
      qstRate: body.province ? preset.qstRate || 0 : 0,
      filingFreq: body.filingFreq,
      fyStart: body.fyStart || 1,
      lang: body.lang,
      orgType: body.orgType,
    });
    let accounts = null;
    if (body.copyFrom) {
      const src = canSeeCo(user, body.copyFrom) && reg.store(body.copyFrom);
      if (!src) throw new ValidationError('The company to copy accounts from doesn’t exist.');
      accounts = src.list('accounts');
    }
    const entry = reg.create(company.name, user ? user.firmId : auth.mainFirmId);
    const store = reg.store(entry.id);
    seedDefaults(store, { company, accounts });
    if (body.examples && company.orgType === 'business') loadExamples(store);
    if (body.code !== undefined && body.code !== '') { store.putSetting('companyCode', hashCode(body.code)); codeOpen.set(`${user.token}|${entry.id}`, Date.now() + CODE_TTL); }
    store.audit(user, 'create', { summary: `company created${body.copyFrom ? ' with a copied chart of accounts' : ''}${body.examples ? ', with example data' : ''}` });
    broadcast({ companies: true, firmId: entry.firmId });
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
    const docs = store.list('docs');
    // Credits count on both sides: used on an invoice or bill, and as used up on the credit itself.
    for (const c of docs) for (const a of c.applied || []) { paid[a.docId] = (paid[a.docId] || 0) + (Number(a.amount) || 0); paid[c.id] = (paid[c.id] || 0) + (Number(a.amount) || 0); }
    for (const d of docs) {
      const bal = Math.round(((Number(d.total) || 0) - (paid[d.id] || 0)) * 100) / 100;
      if (bal <= 0.004) continue;
      if (d.kind === 'invoice') {
        receivable += bal;
        if (d.due && d.due < today) { overdueCount++; overdue += bal; }
      } else if (d.kind === 'bill') payable += bal;
      else if (d.kind === 'credit') receivable -= bal;
      else if (d.kind === 'vcredit') payable -= bal;
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
      hasCode: hasCode(store),
    };
  }

  async function checkCode(ctx, req) {
    const cc = ctx.store.getSetting('companyCode') || {};
    const k = `${ctx.user.token}|${ctx.id}`;
    if (ctx.user.role === 'client' || !cc.hash) return { ok: true };
    const body = (await readJson(req)) || {};
    const fk = `${ctx.user.username}|${ctx.id}`, f = codeFails.get(fk) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw new ValidationError('Too many wrong codes. Try again in 15 minutes.', 429);
    const got = await new Promise((res, rej) => crypto.scrypt(String(body.code || '').slice(0, 20), cc.salt, 32, (e, b) => (e ? rej(e) : res(b))));
    if (!crypto.timingSafeEqual(got, Buffer.from(cc.hash, 'hex'))) {
      f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 15 * 60 * 1000; }
      codeFails.set(fk, f);
      throw new ValidationError('That code isn’t right for this company.', 403);
    }
    codeFails.delete(fk);
    for (const [key, t] of codeOpen) if (t < Date.now()) codeOpen.delete(key);
    codeOpen.set(k, Date.now() + CODE_TTL);
    return { ok: true };
  }

  function state(ctx) {
    const cl = ctx.store.getSetting('closing') || {};
    const out = { rev: ctx.rev, companyId: ctx.id, company: { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}), closingDate: cl.date || '', closingPassword: !!cl.hash, hasCode: hasCode(ctx.store) } };
    for (const c of COLLECTIONS) out[c] = ctx.store.list(c);
    return out;
  }

  /* ---------- closing date ----------
     Transactions, bills and invoices, and pay runs dated on or before the closing date can't be added,
     changed or deleted, unless an owner or staff member unlocks the books for 15 minutes (with the
     closing password, if one is set). Ticking items as cleared or reconciled, or attaching a receipt,
     is still allowed. */
  const unlocks = new Map(); // `${session}|${store file}` -> expiry
  const unlockFails = new Map();
  const isUnlocked = (user, store) => { const k = `${user && user.token}|${store.file}`, t = unlocks.get(k); if (t && t > Date.now()) return true; unlocks.delete(k); return false; };
  const DATED = { entries: 'date', docs: 'date', payruns: 'payDate' };
  const canon = x => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {}) : v));
  const sameBut = (a, b) => { const drop = o => { const { clear, receiptId, applied, sent, id, ...rest } = o || {}; return canon(rest); }; return drop(a) === drop(b); };
  function closedCheck(store, w, data, user) {
    const field = DATED[w.collection];
    if (!field) return;
    const cl = store.getSetting('closing');
    if (!cl || !cl.date) return;
    const before = store.get(w.collection, w.id);
    const dates = [before && before[field], w.op === 'set' && data && data[field]].filter(Boolean);
    if (!dates.some(d => String(d) <= cl.date)) return;
    if (w.op === 'set' && before && sameBut(before, data)) return;
    if (isUnlocked(user, store)) return;
    const e = new ValidationError(user && user.role === 'client'
      ? `The books are closed through ${cl.date}. Ask your bookkeeper to make this change.`
      : `The books are closed through ${cl.date}. Unlock them to make this change.`, 423);
    e.closedThrough = cl.date;
    throw e;
  }

  function applyWrite(store, w, user, ctx) {
    const { op, collection, id } = w;
    if (!COLLECTIONS.includes(collection)) throw new ValidationError(`Unknown collection "${collection}".`, 404);
    // Plan features: payroll records, and the special sales tax methods on returns.
    if (ctx && op === 'set') {
      const d = w.data || {};
      if (collection === 'employees' || collection === 'payruns' || (collection === 'entries' && ['payrun', 'payremit'].includes(d.type))) needFeature(ctx.id, 'payroll', store);
      if (collection === 'filings' && ['quick', 'charity', 'npo'].includes(d.method)) {
        const prev = store.get('filings', id);
        if (!(prev && prev.method === d.method)) needFeature(ctx.id, 'specialTax', store);
      }
    }
    // Receipts are created only by the upload route (or a restore), never by a plain write.
    if (collection === 'receipts' && op === 'set' && !store.get('receipts', id)) throw new ValidationError('Add receipts from the Receipts screen.');
    // Attachments and questions have their own routes; a plain write can only delete an attachment.
    if (collection === 'attachments' && (op !== 'delete' || (user && user.role === 'client'))) throw new ValidationError('Attach files from the transaction.', 403);
    if (collection === 'questions') throw new ValidationError('Use Questions to ask or answer.', 403);
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
      closedCheck(store, w, data, user);
      store.put(collection, id, data);
      const after = collection === 'employees' ? hideSin(store.get(collection, id)) : store.get(collection, id);
      if (JSON.stringify(before) !== JSON.stringify(after)) store.audit(user, before ? 'change' : 'add', { collection, id, summary: auditSummary(collection, after), before, after });
    } else if (op === 'delete') {
      checkDelete(collection, id, store);
      closedCheck(store, w, null, user);
      store.delete(collection, id);
      if ((collection === 'receipts' || collection === 'attachments') && before && before.fileId) store.deleteFile(before.fileId);
      // A deleted transaction, invoice or bill takes its attached files and questions with it.
      if (collection === 'entries' || collection === 'docs') {
        for (const x of store.list('attachments').filter(x => x.target === collection && x.targetId === id)) { store.delete('attachments', x.id); store.deleteFile(x.fileId); }
        for (const q of store.list('questions').filter(q => q.target === collection && q.targetId === id)) store.delete('questions', q.id);
      }
      // A receipt attached to a deleted transaction or bill goes back to the inbox.
      if (collection === 'entries' || collection === 'docs') {
        const key = collection === 'entries' ? 'entryId' : 'docId';
        for (const r of store.list('receipts').filter(x => x[key] === id)) store.put('receipts', r.id, { ...r, [key]: '', status: 'inbox' });
      }
      if (before) store.audit(user, 'delete', { collection, id, summary: auditSummary(collection, before), before });
      if (collection === 'bankTxns') for (const q of store.list('questions').filter(q => q.target === 'bankTxns' && q.targetId === id)) store.delete('questions', q.id);
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

  // GitHub release download counts for the Overview page.
  let dlCache = null;
  const releasesRepo = () => {
    if (opts.releasesRepo) return opts.releasesRepo;
    try { const p = require('../../package.json').build.publish[0]; return `${p.owner}/${p.repo}`; } catch { return 'shersahray/tally-books'; }
  };
  async function downloadCounts() {
    if (dlCache && Date.now() - dlCache.at < 10 * 60 * 1000) return dlCache.data;
    const repo = releasesRepo();
    const get = opts.releasesFetch || (url => fetch(url, { headers: { 'User-Agent': 'Sumlora', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) }));
    let data;
    try {
      const r = await get(`https://api.github.com/repos/${repo}/releases?per_page=30`);
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const list = await r.json();
      const kind = n => (/\.exe$/i.test(n) ? 'windows' : /\.dmg$/i.test(n) ? 'mac' : /\.AppImage$/i.test(n) ? 'linux' : '');
      const releases = (Array.isArray(list) ? list : []).filter(x => !x.draft).map(x => {
        const t = { windows: 0, mac: 0, linux: 0 };
        let checks = 0;
        for (const a of x.assets || []) { const k = kind(a.name); if (k) t[k] += a.download_count || 0; if (a.name === 'latest.yml') checks = a.download_count || 0; }
        return { tag: x.tag_name, name: x.name || x.tag_name, published: x.published_at, prerelease: !!x.prerelease, ...t, installs: t.windows + t.mac + t.linux, updateChecks: checks };
      });
      const sum = k => releases.reduce((n, x) => n + x[k], 0);
      data = { repo, releases, totals: { installs: sum('installs'), windows: sum('windows'), mac: sum('mac'), linux: sum('linux') }, checkedAt: Date.now() };
    } catch (e) {
      data = { repo, error: 'Couldn’t get the download counts from GitHub right now. Try again later.', checkedAt: Date.now() };
      dlCache = { at: Date.now() - 9 * 60 * 1000, data }; // try again in a minute
      return data;
    }
    dlCache = { at: Date.now(), data };
    return data;
  }

  // Routes that work across companies.
  const globalRoutes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/auth\/me$/, req => {
      const user = auth.userFor(req);
      if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Please sign in.', 401, { setup: auth.needsSetup(), setupCode: auth.needsSetup() && !!opts.setupCode, signups: auth.signups !== 'off' && !auth.needsSetup() ? auth.signups : '',
        ...(auth.needsSetup() && licence.on ? { licenceSetup: { required: licence.trialDays === 0, trialDays: licence.trialDays } } : {}) });
      const { token, ...u } = user;
      return { user: u, idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.policy2fa, licence: licenceInfo(u) };
    }],
    ['POST', /^\/api\/auth\/setup$/, async (req, m, res) => {
      const body = await readJson(req);
      if (opts.setupCode && auth.needsSetup()) {
        const ip = clientIp(req);
        ipCheck(ip);
        const a = crypto.createHash('sha256').update(String(body.setupCode || '').trim()).digest(), b = crypto.createHash('sha256').update(String(opts.setupCode).trim()).digest();
        if (!crypto.timingSafeEqual(a, b)) { ipFail(ip); throw new AuthError('The setup code isn’t right. It’s the SETUP_CODE you chose when the server was set up.', 403); }
      }
      // Licensed desktop copy: the code the seller sent is checked before anything is created.
      const code = String(body.licenceCode || '').trim();
      if (licence.on && auth.needsSetup()) {
        if (code) licence.check(code);
        else if (licence.trialDays === 0) throw new ValidationError('Enter the licence code you received with Sumlora.', 400);
      }
      const u = auth.setup(body);
      reg.adoptFirm(auth.mainFirmId);
      if (licence.on && code) {
        const lic = licence.enter(code);
        auth.log('licence-entered', { by: u.username, licence: lic.id, name: lic.name, plan: lic.plan, until: lic.until });
      }
      const { token } = await auth.login(u.username, body.password, { ip: clientIp(req) });
      res.setHeader('Set-Cookie', sessionCookie(token, req));
      return { ok: true, user: u };
    }],
    // A new firm signs itself up (only when an administrator allows sign-ups).
    ['POST', /^\/api\/auth\/signup$/, async (req, m, res) => {
      const body = await readJson(req);
      const ip = clientIp(req);
      ipCheck(ip);
      const day = new Date().toISOString().slice(0, 10), k = `${ip}|${day}`;
      if ((signupsByIp.get(k) || 0) >= 5) throw new AuthError('Too many sign-up attempts from your network today. Try again tomorrow.', 429);
      signupsByIp.set(k, (signupsByIp.get(k) || 0) + 1); // every try counts, so sign-up can't be used to test which emails have accounts
      let out;
      try { out = auth.signup(body); } catch (e) {
        ipFail(ip);
        if (e.status === 409) throw new AuthError('That email can’t be used to sign up. If you already have an account, sign in instead.', 400);
        throw e;
      }
      const { user: u, firm } = out;
      if (signupsByIp.size > 5000) for (const key of signupsByIp.keys()) if (!key.endsWith(day)) signupsByIp.delete(key);
      if (firm.status !== 'active') return { ok: true, pending: true };
      return signIn(req, res, meta => auth.login(u.username, body.password, meta));
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
    ['GET', /^\/api\/users$/, (req, m, res, user) => { ownerOnly(user); return { users: auth.list(user.firmId), idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.data.settings.require2fa || 'off', forced2fa: auth.forced2fa, firm: auth.firm(user.firmId) }; }],
    ['POST', /^\/api\/users$/, async (req, m, res, user) => {
      ownerOnly(user);
      const b = await readJson(req);
      const mine = new Set(reg.list(user.firmId).map(c => c.id));
      if ((Array.isArray(b.companies) ? b.companies : []).some(id => !mine.has(String(id)))) throw new ValidationError('That company doesn’t exist.', 404);
      const u = auth.addUser({ ...b, mustChange: !b.invite, firmId: user.firmId, self: false });
      auth.log('user-added', { username: u.username, by: user.username, role: u.role });
      return { ok: true, user: u };
    }],
    ['PUT', /^\/api\/users\/([^/]+)$/, async (req, m, res, user) => {
      ownerOnly(user);
      const b = await readJson(req);
      if (b.companies !== undefined) { const mine = new Set(reg.list(user.firmId).map(c => c.id)); if ((Array.isArray(b.companies) ? b.companies : []).some(id => !mine.has(String(id)))) throw new ValidationError('That company doesn’t exist.', 404); }
      return { ok: true, user: auth.updateUser(decodeURIComponent(m[1]), b, user) };
    }],
    ['POST', /^\/api\/users\/([^/]+)\/link$/, (req, m, res, user) => {
      ownerOnly(user);
      const out = auth.issueLink(decodeURIComponent(m[1]), user);
      auth.log(out.kind === 'invite' ? 'invite-link' : 'reset-link', { username: auth.byId(decodeURIComponent(m[1])).username, by: user.username });
      return { ok: true, ...out };
    }],
    ['PUT', /^\/api\/security$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      if (b.idleMinutes !== undefined) auth.setIdleMinutes(b.idleMinutes);
      if (b.require2fa !== undefined) auth.setRequire2fa(b.require2fa);
      auth.log('security-changed', { by: user.username, ...b });
      return { ok: true, idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.data.settings.require2fa };
    }],
    ['GET', /^\/api\/security\/log$/, (req, m, res, user) => {
      ownerOnly(user);
      // A firm sees its own people's sign-ins; the server's administrators see everything.
      if (user.platformAdmin) return { log: auth.readLog(1000) };
      const names = new Set(auth.firmUsers(user.firmId).map(u => u.username));
      const serverWide = new Set(['firm-changed', 'firm-signup', 'firm-deleted', 'security-changed', 'ai-settings', 'licence-entered', 'licence-key-created', 'licence-key-copied', 'licence-key-restored', 'licence-made']);
      return { log: auth.readLog(5000).filter(e => !serverWide.has(e.event) && (names.has(e.username) || names.has(e.by))).slice(0, 1000) };
    }],
    // The administrator's overview: firms on this server, desktop licences sold, renewals due, AI use.
    ['GET', /^\/api\/overview$/, (req, m, res, user) => {
      adminOnly(user);
      const now = Date.now(), monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
      const firms = auth.data.firms.map(f => {
        const people = auth.firmUsers(f.id);
        return { id: f.id, name: f.name, status: f.status, plan: PLANS.planOf(f.plan), created: f.created || 0, people: people.length, companies: reg.list(f.id).length,
          lastLogin: Math.max(0, ...people.map(u => u.lastLogin || 0)), aiUsd: Math.round(ai.firmSpent(f.id) * 100) / 100, mine: f.id === user.firmId };
      });
      const count = (list, fn) => list.filter(fn).length;
      const out = {
        firms: {
          total: firms.length, active: count(firms, f => f.status === 'active'), pending: count(firms, f => f.status === 'pending'), suspended: count(firms, f => f.status === 'suspended'),
          people: firms.reduce((t, f) => t + f.people, 0), companies: firms.reduce((t, f) => t + f.companies, 0),
          newThisMonth: count(firms, f => f.created >= monthStart && !f.mine),
          activeLast30: count(firms, f => f.lastLogin >= now - 30 * 864e5),
          byPlan: Object.fromEntries(Object.keys(PLANS.PLANS).map(k => [k, count(firms, f => f.status === 'active' && f.plan === k)])),
          recent: firms.filter(f => !f.mine).sort((a, b) => b.created - a.created).slice(0, 5),
        },
        ai: { totalUsd: Math.round(firms.reduce((t, f) => t + f.aiUsd, 0) * 100) / 100, top: firms.filter(f => f.aiUsd > 0).sort((a, b) => b.aiUsd - a.aiUsd).slice(0, 5).map(f => ({ name: f.name, usd: f.aiUsd })) },
        licences: null,
      };
      // Desktop licences: only in the copy that makes the codes.
      if (!licence.on || licence.isIssuer()) {
        const info = issuer.info();
        if (info.key) {
          const today = localDay(new Date(now));
          const soon = addDays(today, 30), longAgo = addDays(today, -60);
          const renewedIds = new Set(info.issued.map(l => l.renews).filter(Boolean));
          const current = info.issued.filter(l => !renewedIds.has(l.id));
          out.licences = {
            made: info.issued.length,
            active: count(current, l => l.until >= today), endingSoon: count(current, l => l.until >= today && l.until <= soon), ended: count(current, l => l.until < today),
            byPlan: Object.fromEntries(Object.keys(PLANS.PLANS).map(k => [k, count(current, l => l.until >= today && l.plan === k)])),
            due: current.filter(l => l.until <= soon && l.until >= longAgo).sort((a, b) => a.until.localeCompare(b.until))
              .map(({ id, name, email, plan, until }) => ({ id, name, email, plan, until })),
          };
        } else out.licences = { noKey: true };
      }
      return out;
    }],
    // Installer downloads, from the GitHub releases the desktop app updates from (public counts; cached for 10 minutes).
    ['GET', /^\/api\/overview\/downloads$/, async (req, m, res, user) => {
      adminOnly(user);
      return downloadCounts();
    }],
    // Licence for this copy of the desktop app.
    ['GET', /^\/api\/licence$/, (req, m, res, user) => licenceInfo(user)],
    ['PUT', /^\/api\/licence$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      const lic = licence.enter(b.code);
      auth.log('licence-entered', { by: user.username, licence: lic.id, name: lic.name, plan: lic.plan, until: lic.until });
      return licenceInfo(user);
    }],
    // Making licence codes: the seller's own copy (or any server without licensing), administrators only.
    ['GET', /^\/api\/licences$/, (req, m, res, user) => { canIssue(user); return { ...issuer.info(), inBuild: licence.on ? licence.isIssuer() : null, licensing: licence.on }; }],
    ['POST', /^\/api\/licences\/key$/, (req, m, res, user) => {
      canIssue(user);
      if (licence.on) throw new ValidationError('Create your licence key in a copy of Sumlora that doesn’t ask for a licence code (your server, or the desktop app before licences were turned on). Here, bring back your key from a copy instead.', 409);
      const out = issuer.createKey();
      auth.log('licence-key-created', { by: user.username });
      return out;
    }],
    ['GET', /^\/api\/licences\/key\/download$/, (req, m, res, user) => {
      canIssue(user);
      const body = issuer.exportKey();
      auth.log('licence-key-copied', { by: user.username });
      send(res, 200, JSON.stringify(body, null, 2), { 'Content-Type': MIME['.json'], 'Content-Disposition': 'attachment; filename="sumlora-licence-key.json"', 'Cache-Control': 'no-store' });
    }],
    ['POST', /^\/api\/licences\/key\/restore$/, async (req, m, res, user) => {
      adminOnly(user);
      const body = await readJson(req, 4 * 1024 * 1024);
      const out = issuer.importKey(body, { mustMatch: licence.on ? licence.keyTexts : null });
      auth.log('licence-key-restored', { by: user.username });
      return { ...out, inBuild: licence.on ? licence.isIssuer() : null, licensing: licence.on };
    }],
    ['POST', /^\/api\/licences$/, async (req, m, res, user) => {
      canIssue(user);
      const b = await readJson(req);
      const rec = issuer.make({ name: b.name, email: b.email, plan: b.plan, until: b.until, note: b.note, renews: b.renews });
      auth.log('licence-made', { by: user.username, licence: rec.id, name: rec.name, plan: rec.plan, until: rec.until });
      return { licence: rec };
    }],
    // The signed-in person's firm: owners can rename it.
    ['GET', /^\/api\/firm$/, (req, m, res, user) => ({ firm: auth.firm(user.firmId) })],
    ['PUT', /^\/api\/firm$/, async (req, m, res, user) => {
      ownerOnly(user);
      const b = await readJson(req);
      return { ok: true, firm: auth.updateFirm(user.firmId, { name: b.name }, user) };
    }],
    // Firms on this server (administrators): approve sign-ups, suspend, allow AI, and whether new firms can sign up.
    ['GET', /^\/api\/firms$/, (req, m, res, user) => {
      adminOnly(user);
      const firms = auth.data.firms.map(f => {
        const people = auth.firmUsers(f.id), owner = people.find(u => u.role === 'owner');
        return { ...f, users: people.length, companies: reg.list(f.id).length, owner: owner ? { name: owner.name, username: owner.username } : null, lastLogin: Math.max(0, ...people.map(u => u.lastLogin || 0)),
          aiSpentUsd: Math.round(ai.firmSpent(f.id) * 100) / 100, main: f.id === auth.mainFirmId, plan: PLANS.planOf(f.plan) };
      });
      return { firms, signups: auth.signups, defaultPlan: auth.defaultPlan, myFirm: user.firmId, plans: PLANS.PLANS, features: PLANS.FEATURES };
    }],
    ['PUT', /^\/api\/firms\/settings$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      if (b.signups !== undefined) auth.setSignups(b.signups);
      if (b.defaultPlan !== undefined) auth.setDefaultPlan(b.defaultPlan);
      auth.log('security-changed', { by: user.username, ...(b.signups !== undefined ? { signups: b.signups } : {}), ...(b.defaultPlan !== undefined ? { defaultPlan: b.defaultPlan } : {}) });
      return { ok: true, signups: auth.signups, defaultPlan: auth.defaultPlan };
    }],
    ['PUT', /^\/api\/firms\/([^/]+)$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      const patch = {};
      for (const k of ['status', 'name', 'ai', 'aiCapUsd', 'plan']) if (b[k] !== undefined) patch[k] = b[k];
      const f = auth.updateFirm(decodeURIComponent(m[1]), patch, user);
      broadcast({ companies: true, firmId: f.id });
      return { ok: true, firm: f };
    }],
    ['DELETE', /^\/api\/firms\/([^/]+)$/, (req, m, res, user) => {
      adminOnly(user);
      const id = decodeURIComponent(m[1]);
      auth.deleteFirm(id, user, reg.list(id).length);
      return { ok: true };
    }],
    ['GET', /^\/api\/companies$/, (req, m, res, user) => ({ companies: reg.list(user.firmId).filter(c => canSeeCo(user, c.id)).map(summary), provinces: PROVINCES,
      ...(user.platformAdmin ? { pendingFirms: auth.data.firms.filter(f => f.status === 'pending').length } : {}) })],
    ['POST', /^\/api\/companies$/, async (req, m, res, user) => {
      ownerOnly(user);
      const entry = createCompany(await readJson(req), user);
      return { ok: true, company: summary(entry) };
    }],
    ['PUT', /^\/api\/companies\/([^/]+)$/, async (req, m, res, user) => {
      const body = await readJson(req);
      const id = decodeURIComponent(m[1]);
      if (!canSeeCo(user, id)) throw new ValidationError('That company doesn’t exist.', 404);
      if (body.archived !== undefined) ownerOnly(user);
      const patch = {};
      if (body.archived !== undefined) patch.archived = !!body.archived;
      if (body.opened) patch.lastOpened = Date.now();
      reg.update(id, patch);
      if (patch.archived !== undefined) broadcast({ companies: true, firmId: reg.get(id).firmId });
      return { ok: true, company: summary(reg.get(id)) };
    }],
    ['GET', /^\/api\/backups$/, (req, m, res, user) => {
      if (user.role === 'client') return { enabled: true, hidden: true };
      const st = backups.status();
      if (user.role === 'owner' && user.platformAdmin) return st;
      // Everyone else sees whether backups are working, not where they're kept or how many companies the server has.
      return { enabled: st.enabled, lastRun: st.lastRun, lastError: st.lastError ? 'The latest backup had a problem. The server’s administrator can see the details.' : '', limited: true };
    }],
    ['PUT', /^\/api\/backups$/, async (req, m, res, user) => { adminOnly(user); return backups.update(await readJson(req)); }],
    ['POST', /^\/api\/backups\/run$/, async (req, m, res, user) => {
      adminOnly(user);
      const r = backups.run();
      if (!r.ok) throw new ValidationError(r.error, 409);
      if (r.upload) { const up = await r.upload; delete r.upload; if (up.lastError) throw new ValidationError(up.lastError, 502); }
      return { ...r, status: backups.status() };
    }],
    ['POST', /^\/api\/backups\/open$/, (req, m, res, user) => {
      notClient(user);
      // Only for someone sitting at this computer: opens the folder in File Explorer / Finder.
      const ip = req.socket.remoteAddress || '';
      if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) throw new ValidationError('The backup folder can only be opened on the computer running Sumlora.', 403);
      const dir = fs.existsSync(backups.target()) ? backups.target() : backups.settings.folder;
      const { spawn } = require('node:child_process');
      const [cmd, args] = process.platform === 'win32' ? ['explorer', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
      try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* shown in the UI instead */ }
      return { ok: true, path: dir };
    }],
    ['GET', /^\/api\/ai$/, (req, m, res, user) => {
      const f = auth.firm(user.firmId), allowed = !!(f && f.ai);
      if (user.role === 'owner' && user.platformAdmin) return { ...ai.status(true), firmAllowed: allowed, admin: true };
      return { configured: ai.status().configured && allowed, firmAllowed: allowed };
    }],
    ['PUT', /^\/api\/ai$/, async (req, m, res, user) => {
      adminOnly(user);
      const body = await readJson(req);
      const st = ai.update(body);
      auth.log('ai-settings', { username: user.username, ip: clientIp(req), change: body.apiKey !== undefined ? (body.apiKey ? 'API key changed' : 'API key removed') : 'settings changed' });
      return st;
    }],
    ['GET', /^\/api\/events$/, (req, m, res, user) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.user = user; res.token = user.token;
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
      ctx.store.transaction(() => applyWrite(ctx.store, { op: 'set', collection: m[1], id: decodeURIComponent(m[2]), data }, ctx.user, ctx));
      return { ok: true, rev: ctx.bump() };
    }],
    ['DELETE', /^\/records\/([A-Za-z]+)\/([^/]+)$/, (ctx, req, m) => {
      ctx.store.transaction(() => applyWrite(ctx.store, { op: 'delete', collection: m[1], id: decodeURIComponent(m[2]) }, ctx.user, ctx));
      return { ok: true, rev: ctx.bump() };
    }],
    ['POST', /^\/batch$/, async (ctx, req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.writes) || !body.writes.length) throw new ValidationError('Send a non-empty "writes" list.');
      if (body.writes.length > 500) throw new ValidationError('At most 500 writes per batch.');
      ctx.store.transaction(() => body.writes.forEach(w => applyWrite(ctx.store, w, ctx.user, ctx)));
      return { ok: true, rev: ctx.bump() };
    }],
    ['PUT', /^\/settings$/, async (ctx, req) => {
      notClient(ctx.user);
      const before = ctx.store.getSetting('company');
      const company = validateCompany(await readJson(req));
      company.logoFile = (before && before.logoFile) || ''; // changed only through the logo route
      // Plan features: can't be turned on here when the plan doesn't include them (settings already saved stay as they were).
      if (company.quickMethod && company.quickMethod.on && !(before && before.quickMethod && before.quickMethod.on)) needFeature(ctx.id, 'specialTax', ctx.store);
      if (!featureOn(ctx.id, 'advancedReports', ctx.store) && JSON.stringify(company.savedReports || []) !== JSON.stringify((before && before.savedReports) || [])) {
        const added = (company.savedReports || []).some(r => !((before && before.savedReports) || []).some(b => b.id === r.id));
        if (added) needFeature(ctx.id, 'advancedReports', ctx.store);
      }
      ctx.store.transaction(() => {
        ctx.store.putSetting('company', company);
        ctx.store.audit(ctx.user, 'settings', { collection: 'settings', id: 'company', summary: 'company settings', before, after: company });
      });
      reg.update(ctx.id, { name: company.name });
      broadcast({ companies: true, firmId: (reg.get(ctx.id) || {}).firmId });
      return { ok: true, rev: ctx.bump() };
    }],
    // ---------- email from the company's own mailbox ----------
    ['GET', /^\/mail$/, ctx => {
      const m = ctx.store.getSetting('mail');
      return { ...mail.publicMail(m), sentToday: Number(ctx.store.getMeta('mail-sent:' + new Date().toISOString().slice(0, 10)) || 0) };
    }],
    ['PUT', /^\/mail$/, async (ctx, req) => {
      notClient(ctx.user);
      const body = (await readJson(req)) || {};
      const before = ctx.store.getSetting('mail');
      if (body.remove) {
        ctx.store.transaction(() => { ctx.store.putSetting('mail', {}); ctx.store.audit(ctx.user, 'mail', { collection: 'settings', id: 'mail', summary: 'email sending turned off' }); });
        return mail.publicMail(null);
      }
      const m = mail.validateMail(body, before || {}, { allowLocal: !!opts.mailAllowLocal });
      ctx.store.transaction(() => { ctx.store.putSetting('mail', m); ctx.store.audit(ctx.user, 'mail', { collection: 'settings', id: 'mail', summary: `email sending set up for ${m.fromEmail}${body.pass ? ' (password changed)' : ''}` }); });
      return mail.publicMail(m);
    }],
    ['POST', /^\/mail\/(test|send)$/, async (ctx, req, m) => {
      const cfg = ctx.store.getSetting('mail');
      if (!cfg || !cfg.host) throw new ValidationError('Set up email for this company first (Settings → Email).', 409);
      const dayKey = 'mail-sent:' + new Date().toISOString().slice(0, 10);
      const body = (await readJson(req, 12 * 1024 * 1024)) || {};
      const list = v => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map(x => String(x).trim()).filter(Boolean);
      const to = m[1] === 'test' ? list(body.to || cfg.fromEmail) : list(body.to), cc = m[1] === 'test' ? [] : list(body.cc);
      if (!to.length) throw new ValidationError('Enter who the email goes to.');
      if (to.length + cc.length > 10) throw new ValidationError('Send to at most 10 addresses at a time.');
      const bad = [...to, ...cc].find(x => !mail.EMAIL_RE.test(x));
      if (bad) throw new ValidationError(`“${bad.slice(0, 80)}” isn’t an email address.`);
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const subject = m[1] === 'test' ? `Test email from Sumlora (${company.name})` : String(body.subject || '').slice(0, 200);
      const text = m[1] === 'test' ? `This is a test from Sumlora. Email for ${company.name} is working.` : String(body.text || '').slice(0, 20000);
      if (!subject.trim()) throw new ValidationError('Enter a subject.');
      const attachments = [];
      let total = 0;
      for (const a of (m[1] === 'send' && Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5)) {
        const data = Buffer.from(String(a.data || ''), 'base64');
        if (data.slice(0, 4).toString('latin1') !== '%PDF') throw new ValidationError('Only PDF documents can be attached.');
        total += data.length;
        attachments.push({ name: String(a.name || 'document.pdf'), type: 'application/pdf', data });
      }
      if (total > 8 * 1024 * 1024) throw new ValidationError('The attachments are over 8 MB.', 413);
      // Each address counts toward 200 a day, counted before sending (so parallel sends and failures count too).
      const sentToday = Number(ctx.store.getMeta(dayKey) || 0);
      if (sentToday + to.length + cc.length > 200) throw new ValidationError('That’s 200 emails today for this company. Send the rest tomorrow.', 429);
      ctx.store.putMeta(dayKey, sentToday + to.length + cc.length);
      await mail.send(cfg, { to, cc, subject, text, attachments }, { insecureTls: !!opts.mailInsecureTls, allowLocal: !!opts.mailAllowLocal });
      const docIds = (Array.isArray(body.docIds) ? body.docIds : []).map(String).slice(0, 50);
      ctx.store.transaction(() => {
        for (const id of docIds) {
          const d = ctx.store.get('docs', id);
          if (d) ctx.store.put('docs', id, { ...d, sent: [...(d.sent || []).slice(-19), { at: Date.now(), to: to.join(', '), by: ctx.user.name || ctx.user.username, what: ['invoice', 'reminder', 'statement', 'credit'].includes(body.what) ? body.what : 'document' }] });
        }
        ctx.store.audit(ctx.user, 'email', { summary: `${m[1] === 'test' ? 'test email' : 'emailed'} “${subject.slice(0, 80)}” to ${to.join(', ').slice(0, 120)}` });
      });
      return { ok: true, rev: docIds.length ? ctx.bump() : ctx.rev };
    }],
    // ---------- logo on invoices ----------
    ['PUT', /^\/logo$/, async (ctx, req) => {
      notClient(ctx.user);
      const body = (await readJson(req, 3 * 1024 * 1024)) || {};
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!(data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)) throw new ValidationError('Choose a JPEG or PNG image for the logo.');
      if (data.length > 1024 * 1024) throw new ValidationError('The logo is over 1 MB. Try a smaller image.', 413);
      const company = ctx.store.getSetting('company') || {};
      const fileId = crypto.randomUUID();
      ctx.store.transaction(() => {
        ctx.store.putFile(fileId, { mediaType: 'image/jpeg', name: 'logo.jpg', data });
        if (company.logoFile) ctx.store.deleteFile(company.logoFile);
        ctx.store.putSetting('company', { ...company, logoFile: fileId });
        ctx.store.audit(ctx.user, 'settings', { collection: 'settings', id: 'company', summary: 'logo changed' });
      });
      return { ok: true, logoFile: fileId, rev: ctx.bump() };
    }],
    ['DELETE', /^\/logo$/, ctx => {
      notClient(ctx.user);
      const company = ctx.store.getSetting('company') || {};
      ctx.store.transaction(() => {
        if (company.logoFile) ctx.store.deleteFile(company.logoFile);
        ctx.store.putSetting('company', { ...company, logoFile: '' });
        ctx.store.audit(ctx.user, 'settings', { collection: 'settings', id: 'company', summary: 'logo removed' });
      });
      return { ok: true, rev: ctx.bump() };
    }],
    ['PUT', /^\/closing$/, async (ctx, req) => {
      ownerOnly(ctx.user);
      const body = (await readJson(req)) || {};
      const date = String(body.date || '');
      if (date && !isDate(date)) throw new ValidationError('Choose a closing date.');
      const before = ctx.store.getSetting('closing') || {};
      const next = { ...before, date, setBy: ctx.user.username, at: Date.now() };
      if (body.password !== undefined) {
        const pw = String(body.password || '');
        if (pw && pw.length < 6) throw new ValidationError('Use at least 6 characters for the closing password.');
        if (pw) { next.salt = crypto.randomBytes(16).toString('hex'); next.hash = crypto.scryptSync(pw, next.salt, 64).toString('hex'); }
        else { delete next.salt; delete next.hash; }
      }
      ctx.store.transaction(() => {
        ctx.store.putSetting('closing', next);
        ctx.store.audit(ctx.user, 'closing', { collection: 'settings', id: 'closing', summary: date ? `books closed through ${date}${next.hash ? ' (password set)' : ''}` : 'closing date removed', before: { date: before.date || '', password: !!before.hash }, after: { date, password: !!next.hash } });
      });
      for (const k of [...unlocks.keys()]) if (k.endsWith('|' + ctx.store.file)) unlocks.delete(k);
      return { ok: true, rev: ctx.bump() };
    }],
    ['PUT', /^\/code$/, async (ctx, req) => {
      ownerOnly(ctx.user);
      const body = (await readJson(req)) || {};
      const had = hasCode(ctx.store);
      ctx.store.transaction(() => {
        if (body.remove) ctx.store.putSetting('companyCode', {});
        else ctx.store.putSetting('companyCode', hashCode(body.code));
        ctx.store.audit(ctx.user, 'company-code', { collection: 'settings', id: 'companyCode', summary: body.remove ? 'company code removed' : had ? 'company code changed' : 'company code set' });
      });
      // Everyone else types the new code next time; the owner who changed it stays in.
      for (const k of [...codeOpen.keys()]) if (k.endsWith('|' + ctx.id)) codeOpen.delete(k);
      if (!body.remove) codeOpen.set(`${ctx.user.token}|${ctx.id}`, Date.now() + CODE_TTL);
      return { ok: true, rev: ctx.bump() };
    }],
    ['POST', /^\/closing\/unlock$/, async (ctx, req) => {
      notClient(ctx.user);
      const cl = ctx.store.getSetting('closing') || {};
      if (!cl.date) return { ok: true };
      const body = (await readJson(req)) || {};
      const fk = `${ctx.user.username}|${ctx.store.file}`, f = unlockFails.get(fk) || { n: 0, until: 0 };
      if (f.until > Date.now()) throw new ValidationError('Too many wrong closing passwords. Try again in 15 minutes.', 429);
      if (cl.hash) {
        const got = await new Promise((res, rej) => crypto.scrypt(String(body.password || '').slice(0, 200), cl.salt, 64, (e, k) => (e ? rej(e) : res(k))));
        if (!crypto.timingSafeEqual(got, Buffer.from(cl.hash, 'hex'))) {
          f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 15 * 60 * 1000; }
          unlockFails.set(fk, f);
          throw new ValidationError('That closing password isn’t right.', 403);
        }
      }
      unlockFails.delete(fk);
      unlocks.set(`${ctx.user.token}|${ctx.store.file}`, Date.now() + 15 * 60 * 1000);
      ctx.store.audit(ctx.user, 'unlock', { collection: 'settings', id: 'closing', summary: `unlocked the books closed through ${cl.date} for 15 minutes` });
      return { ok: true, minutes: 15 };
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
      needFirmAi(ctx.id);
      const body = await readJson(req);
      if (!Array.isArray(body.ids) || !body.ids.length) throw new ValidationError('Choose the bank lines to suggest categories for.');
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const { suggestions, usd } = await ai.suggest(ctx.store, company, body.ids.map(String));
      chargeFirm(ctx.id, usd);
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
      let canRead = ai.status().configured && company.ai && firmAi(ctx.id);
      try { if (canRead) needFirmAi(ctx.id); } catch { canRead = false; }
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
    /* Questions about a transaction: the team asks, the client answers (or the other way round), the team resolves.
       A message from the client marks it answered; one from the team marks it waiting for the client. */
    ['POST', /^\/questions$/, async (ctx, req) => {
      const body = (await readJson(req)) || {};
      const target = ['entries', 'docs', 'bankTxns'].includes(body.target) ? body.target : '';
      const rec = target && ctx.store.get(target, String(body.targetId || ''));
      if (!rec) throw new ValidationError('That transaction isn’t here any more.', 404);
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) throw new ValidationError('Type your question.');
      if (ctx.store.list('questions').filter(q => q.status !== 'resolved').length >= 500) throw new ValidationError('There are 500 open questions already. Resolve some first.', 409);
      const amount = rec.lines ? rec.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0) : Number(rec.total ?? rec.amount) || 0;
      const label = `${rec.date || ''} · ${target === 'docs' ? rec.kind + (rec.number ? ' #' + rec.number : '') : target === 'bankTxns' ? String(rec.desc || '').slice(0, 60) : rec.type + (rec.ref ? ' #' + rec.ref : '')} · $${Math.abs(amount).toFixed(2)}${rec.memo ? ' · ' + String(rec.memo).slice(0, 60) : ''}`;
      const client = ctx.user.role === 'client', id = crypto.randomUUID();
      const q = validateRecord('questions', id, { target, targetId: rec.id || String(body.targetId), status: client ? 'answered' : 'open', label, created: Date.now(),
        thread: [{ by: ctx.user.username, name: ctx.user.name || ctx.user.username, role: ctx.user.role, at: Date.now(), text }] }, ctx.store);
      ctx.store.transaction(() => { ctx.store.put('questions', id, q); ctx.store.audit(ctx.user, 'add', { collection: 'questions', id, summary: `question on ${label}`, after: q }); });
      return { ok: true, id, rev: ctx.bump() };
    }],
    ['POST', /^\/questions\/([A-Za-z0-9-]+)\/(reply|resolve|reopen)$/, async (ctx, req, m) => {
      const q = ctx.store.get('questions', m[1]);
      if (!q) throw new ValidationError('That question isn’t here any more.', 404);
      const client = ctx.user.role === 'client';
      let next;
      if (m[2] === 'reply') {
        const text = String(((await readJson(req)) || {}).text || '').trim().slice(0, 2000);
        if (!text) throw new ValidationError('Type your answer.');
        if (q.thread.length >= 100) throw new ValidationError('This conversation is long; start a new question.', 409);
        next = { ...q, status: client ? 'answered' : 'open', thread: [...q.thread, { by: ctx.user.username, name: ctx.user.name || ctx.user.username, role: ctx.user.role, at: Date.now(), text }] };
      } else {
        notClient(ctx.user);
        next = { ...q, status: m[2] === 'resolve' ? 'resolved' : 'open' };
      }
      ctx.store.transaction(() => { ctx.store.put('questions', q.id, validateRecord('questions', q.id, next, ctx.store)); ctx.store.audit(ctx.user, m[2], { collection: 'questions', id: q.id, summary: `${m[2]} question on ${q.label}` }); });
      return { ok: true, rev: ctx.bump() };
    }],
    ['DELETE', /^\/questions\/([A-Za-z0-9-]+)$/, (ctx, req, m) => {
      notClient(ctx.user);
      const q = ctx.store.get('questions', m[1]);
      if (q) ctx.store.transaction(() => { ctx.store.delete('questions', q.id); ctx.store.audit(ctx.user, 'delete', { collection: 'questions', id: q.id, summary: `question on ${q.label}`, before: q }); });
      return { ok: true, rev: ctx.bump() };
    }],
    // Attach a PDF or photo to a transaction, invoice or bill.
    ['POST', /^\/attachments$/, async (ctx, req) => {
      notClient(ctx.user);
      const body = (await readJson(req, 15 * 1024 * 1024)) || {};
      const target = body.target === 'docs' ? 'docs' : 'entries', targetId = String(body.targetId || '');
      const rec0 = ctx.store.get(target, targetId);
      if (!rec0) throw new ValidationError('Save the transaction first, then attach files to it.', 404);
      if (ctx.store.list('attachments').filter(x => x.target === target && x.targetId === targetId).length >= 20) throw new ValidationError('That’s 20 files on this transaction already.', 409);
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!data.length) throw new ValidationError('That file is empty.');
      if (data.length > 10 * 1024 * 1024) throw new ValidationError('That file is over 10 MB.', 413);
      const mediaType = sniffType(data);
      if (!mediaType) throw new ValidationError('Attach a PDF or a photo (JPEG, PNG or WebP).');
      const id = crypto.randomUUID(), fileId = crypto.randomUUID();
      const name = String(body.fileName || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 120);
      const rec = validateRecord('attachments', id, { target, targetId, fileId, name, mediaType, size: data.length, uploadedBy: ctx.user.username, uploadedByName: ctx.user.name || ctx.user.username, uploadedAt: Date.now() }, ctx.store);
      ctx.store.transaction(() => {
        ctx.store.putFile(fileId, { mediaType, name, data });
        ctx.store.put('attachments', id, rec);
        ctx.store.audit(ctx.user, 'add', { collection: 'attachments', id, summary: `attached ${name}`, after: rec });
      });
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
      needFirmAi(ctx.id);
      ai.precheck({ ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) });
      ctx.store.put('receipts', r.id, { ...r, readStatus: 'waiting', readError: '' });
      queueRead(ctx.id, r.id, true);
      return { ok: true, rev: ctx.bump() };
    }],
    // Read a receipt or bill with AI and return a draft. Nothing is saved; the file isn't kept.
    ['POST', /^\/ai\/read$/, async (ctx, req) => {
      notClient(ctx.user);
      needFirmAi(ctx.id);
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      ai.precheck(company); // before reading a large upload
      const body = (await readJson(req, 15 * 1024 * 1024)) || {};
      const out = await ai.read(ctx.store, company, body);
      chargeFirm(ctx.id, out.usd);
      ctx.store.audit(ctx.user, 'ai', { summary: `AI read ${String(body.fileName || 'a document').slice(0, 80)}` });
      return { ok: true, ...out };
    }],
    // Bringing a client over from QuickBooks or Sage: everything in one go, or nothing. A copy of the
    // books as they were is kept first (like a restore), in case the wrong files were used.
    ['POST', /^\/import$/, async (ctx, req) => {
      notClient(ctx.user);
      const body = await readJson(req, 60 * 1024 * 1024);
      if (!body || !Array.isArray(body.writes) || !body.writes.length) throw new ValidationError('There’s nothing to import.');
      if (body.writes.length > 100000) throw new ValidationError('That’s too much to import at once. Import the transaction history a year at a time.', 413);
      for (const w of body.writes) {
        if (!w || (w.collection !== 'accounts' && w.op === 'delete') || !['accounts', 'contacts', 'entries', 'docs'].includes(w.collection)) throw new ValidationError('An import can only add accounts, contacts, transactions and open invoices or bills.');
        // Only new contacts, transactions and bills; existing ones are never overwritten.
        if (w.collection !== 'accounts' && w.op === 'set' && ctx.store.get(w.collection, String(w.id))) throw new ValidationError('An import can only add new records, not change existing ones.');
      }
      const snapDir = path.join(opts.dataDir, 'before-restore');
      fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
      const snap = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), company: ctx.store.getSetting('company') };
      for (const c of COLLECTIONS) snap[c] = ctx.store.list(c);
      fs.writeFileSync(path.join(snapDir, `${ctx.id}-before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(snap), { mode: 0o600 });
      // Keep the 10 most recent copies per company.
      const mine = fs.readdirSync(snapDir).filter(f => f.startsWith(ctx.id + '-before-import-')).sort();
      for (const f of mine.slice(0, -10)) fs.rmSync(path.join(snapDir, f), { force: true });
      const counts = {};
      ctx.store.transaction(() => {
        body.writes.forEach((w, i) => {
          try { applyWrite(ctx.store, w, ctx.user, ctx); } catch (e) {
            if (e instanceof ValidationError) throw new ValidationError(`Item ${i + 1} (${w.collection}${w.data && (w.data.name || w.data.number || w.data.date) ? ': ' + String(w.data.name || w.data.number || w.data.date).slice(0, 60) : ''}): ${e.message}`, e.status);
            throw e;
          }
          if (w.op === 'set') counts[w.collection] = (counts[w.collection] || 0) + 1;
        });
        ctx.store.audit(ctx.user, 'import', { summary: `imported from ${String(body.source || 'another program').slice(0, 60)}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` });
      });
      broadcast({ companies: true, firmId: (reg.get(ctx.id) || {}).firmId });
      return { ok: true, rev: ctx.bump(), counts };
    }],
    ['POST', /^\/examples$/, ctx => {
      notClient(ctx.user);
      if ((ctx.store.getSetting('closing') || {}).date) throw new ValidationError('These books are closed, so example data can’t be added. Try it in a new company.', 423);
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
      if (body.format !== BACKUP_FORMAT) throw new ValidationError('That file isn’t a Sumlora backup.');
      const company = validateCompany(body.company || {});
      // Keep a copy of what's about to be replaced, in the data folder, in case the wrong file was chosen.
      const snapDir = path.join(opts.dataDir, 'before-restore');
      fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
      const snap = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), company: ctx.store.getSetting('company') };
      for (const c of COLLECTIONS) snap[c] = ctx.store.list(c);
      fs.writeFileSync(path.join(snapDir, `${ctx.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(snap), { mode: 0o600 });
      let skippedReceipts = 0;
      const usedFiles = new Set();
      ctx.store.transaction(() => {
        ctx.store.clearAll();
        ctx.store.putMeta('seeded', new Date().toISOString());
        ctx.store.putSetting('company', company);
        // COLLECTIONS is ordered so each record is checked against what it depends on.
        for (const c of COLLECTIONS) {
          for (const r of body[c] || []) {
            const { id, ...data } = r;
            if ((c === 'receipts' || c === 'attachments') && !(data.fileId && ctx.store.hasFile(String(data.fileId)))) { skippedReceipts++; continue; } // file isn't in this company's files
            if (c === 'attachments' && !ctx.store.get(data.target, String(data.targetId || ''))) continue;
            // Each file belongs to one record: a crafted backup can't make two records share (and later delete) one file.
            if (c === 'receipts' || c === 'attachments') { const k = String(data.fileId); if (usedFiles.has(k)) { skippedReceipts++; continue; } usedFiles.add(k); }
            ctx.store.put(c, id, validateRecord(c, id, data, ctx.store));
          }
        }
      });
      ctx.store.audit(ctx.user, 'restore', { summary: `restored a backup exported ${String(body.exportedAt || '').slice(0, 10) || 'on an unknown date'}` });
      reg.update(ctx.id, { name: company.name });
      broadcast({ companies: true, firmId: (reg.get(ctx.id) || {}).firmId });
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
        return send(res, 401, 'Sign in required', { 'WWW-Authenticate': 'Basic realm="Sumlora", charset="UTF-8"', 'Content-Type': 'text/plain' });
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req)) throw new ValidationError('Cross-site request blocked.', 403);
        // Everything except signing in needs a signed-in user.
        let user = null;
        if (!/^\/api\/(health|auth\/(me|setup|signup|login|login\/code|logout|link|link\/accept))$/.test(url.pathname)) {
          user = auth.userFor(req);
          if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Your session ended. Please sign in again.', 401, { setup: auth.needsSetup() });
          if (user.mustChange && !['/api/auth/password', '/api/auth/prefs', '/api/events'].includes(url.pathname)) throw new AuthError('Choose a new password before continuing.', 403, { mustChange: true });
          if (user.mustEnroll && !/^\/api\/(auth\/(password|prefs|2fa\/start|2fa\/confirm)|events)$/.test(url.pathname)) throw new AuthError('Set up two-step sign-in before continuing.', 403, { mustEnroll: true });
        }
        // Licence ended (desktop): the books stay open to read, print, export and back up, but not to change.
        if (user && licence.on && req.method !== 'GET' && !/^\/api\/(auth\/.*|licence|licences\/key\/restore|backups\/(run|open)|c\/[^/]+\/(code\/check|mail\/send))$/.test(url.pathname)) {
          const st = licence.status();
          if (!st.canChange) throw Object.assign(new ValidationError(st.state === 'none' ? 'Enter your licence code to start using Sumlora.' : st.state === 'trial-ended' ? 'The free trial has ended, so the books are view only. Enter a licence code to make changes.' : `The licence ended on ${st.until}, so the books are view only. Enter a renewal code to make changes.`, 402), { licence: true });
        }
        const cm = url.pathname.match(/^\/api\/c\/([^/]+)(\/.*)$/);
        if (cm) {
          const cid = decodeURIComponent(cm[1]);
          if (!canSeeCo(user, cid)) {
            const c = reg.get(cid);
            // Another firm's company is treated as not existing, so nobody can learn what other firms have.
            if (!c || c.firmId !== user.firmId) throw new ValidationError('That company doesn’t exist.', 404);
            throw new ValidationError('You don’t have access to that company.', 403);
          }
          if (user.readOnly && req.method !== 'GET' && cm[2] !== '/code/check') throw new ValidationError('Your account is view only, so you can’t make changes.', 403);
          const ctx = ctxFor(cid);
          ctx.user = user;
          if (req.method === 'POST' && cm[2] === '/code/check') return sendJson(res, 200, await checkCode(ctx, req));
          // An owner who forgot the code can still set a new one.
          if (!(req.method === 'PUT' && cm[2] === '/code' && user.role === 'owner')) codeGate(user, cid, ctx.store);
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
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message, ...(err.setup !== undefined ? { setup: err.setup } : {}), ...(err.setupCode ? { setupCode: true } : {}), ...(err.signups ? { signups: err.signups } : {}), ...(err.mustChange ? { mustChange: true } : {}), ...(err.mustEnroll ? { mustEnroll: true } : {}), ...(err.restart ? { restart: true } : {}), ...(err.closedThrough ? { closedThrough: err.closedThrough } : {}), ...(err.codeRequired ? { codeRequired: true } : {}), ...(err.licence ? { licence: true } : {}), ...(err.licenceSetup ? { licenceSetup: err.licenceSetup } : {}) });
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
