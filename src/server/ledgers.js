'use strict';
/*
 * Other bookkeeping programs a client's books are kept in: QuickBooks Online and Xero.
 * A firm connects a client's file once (OAuth, through Intuit's or Xero's own sign-in), and its year-end file can then
 * bring in the trial balance at the year-end and at the prior year-end, with each account's type, without exporting
 * anything. Read-only: Sumlora never changes the client's books there.
 *
 * The server's administrator adds the app keys (an Intuit Developer app and a Xero app) in Settings. The keys and each
 * connection's tokens stay on the server, in ledgers.json (readable by the server only).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError } = require('./validate');

const URLS = {
  qbo: {
    authorize: 'https://appcenter.intuit.com/connect/oauth2',
    token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revoke: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
    api: { production: 'https://quickbooks.api.intuit.com', sandbox: 'https://sandbox-quickbooks.api.intuit.com' },
    scope: 'com.intuit.quickbooks.accounting',
  },
  xero: {
    authorize: 'https://login.xero.com/identity/connect/authorize',
    token: 'https://identity.xero.com/connect/token',
    connections: 'https://api.xero.com/connections',
    api: 'https://api.xero.com/api.xro/2.0',
    scope: 'offline_access accounting.reports.read accounting.settings.read',
  },
};
const NAMES = { qbo: 'QuickBooks Online', xero: 'Xero' };

// Each program's account types, as Sumlora's.
const QBO_TYPES = {
  Bank: ['Asset', 'bank'], 'Accounts Receivable': ['Asset', 'ar'], 'Other Current Asset': ['Asset', ''], 'Fixed Asset': ['Asset', 'capital'], 'Other Asset': ['Asset', ''],
  'Accounts Payable': ['Liability', 'ap'], 'Credit Card': ['Liability', 'card'], 'Other Current Liability': ['Liability', ''], 'Long Term Liability': ['Liability', ''],
  Equity: ['Equity', ''], Income: ['Income', ''], 'Other Income': ['Income', ''], 'Cost of Goods Sold': ['Cost of Goods Sold', ''], Expense: ['Expense', ''], 'Other Expense': ['Expense', ''],
};
const XERO_TYPES = {
  BANK: ['Asset', 'bank'], CURRENT: ['Asset', ''], FIXED: ['Asset', 'capital'], NONCURRENT: ['Asset', ''], PREPAYMENT: ['Asset', ''], INVENTORY: ['Asset', ''],
  CURRLIAB: ['Liability', ''], LIABILITY: ['Liability', ''], TERMLIAB: ['Liability', ''], PAYGLIABILITY: ['Liability', ''], SUPERANNUATIONLIABILITY: ['Liability', ''], WAGESPAYABLELIABILITY: ['Liability', ''],
  EQUITY: ['Equity', ''], REVENUE: ['Income', ''], SALES: ['Income', ''], OTHERINCOME: ['Income', ''],
  EXPENSE: ['Expense', ''], OVERHEADS: ['Expense', ''], DEPRECIATN: ['Expense', ''], DIRECTCOSTS: ['Cost of Goods Sold', ''],
};
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

class Ledgers {
  /**
   * @param {string} dir where ledgers.json is kept
   * @param {object} [o] { fetch (tests), urls (tests: replaces URLS) }
   */
  constructor(dir, o = {}) {
    this.file = path.join(dir, 'ledgers.json');
    this.fetch = o.fetch || ((...a) => fetch(...a));
    this.urls = o.urls || URLS;
    this.data = { keys: {}, connections: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    this.states = new Map(); // OAuth state -> { companyId, provider, userId, exp }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }
  configured(p) { const k = this.data.keys[p]; return !!(k && k.clientId && k.secret); }
  /** For the administrator's settings. */
  status() {
    const out = {};
    for (const p of ['qbo', 'xero']) { const k = this.data.keys[p] || {}; out[p] = { configured: this.configured(p), clientIdHint: k.clientId ? '…' + String(k.clientId).slice(-4) : '', env: k.env || 'production' }; }
    out.connections = Object.keys(this.data.connections).length;
    return out;
  }
  update(body) {
    for (const p of ['qbo', 'xero']) {
      const b = body && body[p];
      if (!b || typeof b !== 'object') continue;
      const k = { ...(this.data.keys[p] || {}) };
      for (const f of ['clientId', 'secret']) if (b[f] !== undefined) {
        const v = String(b[f]).trim();
        if (v && !/^[A-Za-z0-9_\-.~+/=]{8,200}$/.test(v)) throw new ValidationError(`That ${NAMES[p]} ${f === 'clientId' ? 'client ID' : 'secret'} doesn’t look right. Copy it again from the developer site.`);
        k[f] = v;
      }
      if (p === 'qbo' && b.env !== undefined) k.env = b.env === 'sandbox' ? 'sandbox' : 'production';
      if (!k.clientId && !k.secret) delete this.data.keys[p]; else this.data.keys[p] = k;
    }
    this.save();
    return this.status();
  }
  /** What a company's screen sees: the connection, without its tokens. */
  connection(companyId) {
    const c = this.data.connections[companyId];
    return { configured: { qbo: this.configured('qbo'), xero: this.configured('xero') }, connected: !!c, provider: c ? c.provider : '', providerName: c ? NAMES[c.provider] : '', name: c ? c.name : '', since: c ? c.since : 0, by: c ? c.by : '' };
  }
  /** The sign-in address to send the person to. redirectUri: this server's callback. */
  authorizeUrl(provider, companyId, user, redirectUri) {
    if (!NAMES[provider]) throw new ValidationError('Choose QuickBooks Online or Xero.');
    if (!this.configured(provider)) throw new ValidationError(`${NAMES[provider]} isn’t set up on this server yet. The administrator adds the app keys in Settings.`, 409);
    if (!redirectUri) throw new ValidationError('This server’s web address isn’t set, so the sign-in can’t come back to it. The administrator sets it with the email settings.', 409);
    const state = crypto.randomBytes(24).toString('hex');
    for (const [k, v] of this.states) if (v.exp < Date.now()) this.states.delete(k);
    this.states.set(state, { companyId, provider, userId: user.id, by: user.name || user.username, redirectUri, exp: Date.now() + 15 * 60 * 1000 });
    const u = new URL(this.urls[provider].authorize);
    u.search = new URLSearchParams({ client_id: this.data.keys[provider].clientId, response_type: 'code', scope: this.urls[provider].scope, redirect_uri: redirectUri, state }).toString();
    return u.toString();
  }
  async tokenCall(provider, params) {
    const k = this.data.keys[provider];
    const res = await this.fetch(this.urls[provider].token, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${k.clientId}:${k.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params).toString() });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new ValidationError(`${NAMES[provider]} didn’t accept the sign-in${j.error ? ` (${j.error})` : ''}. Try connecting again.`, 502);
    return j;
  }
  /**
   * The sign-in came back. The session cookie doesn't come along (it's SameSite=Strict and this is a visit from Intuit's or
   * Xero's site), so the proof is the state: random, used once, and only good for 15 minutes for the company and person
   * who started it. Swap the code for tokens and keep the connection.
   */
  async finish(query) {
    const st = this.states.get(String(query.state || ''));
    this.states.delete(String(query.state || ''));
    if (!st || st.exp < Date.now()) throw new ValidationError('That sign-in link has expired or isn’t yours. Start connecting again from Sumlora.', 400);
    if (query.error) throw new ValidationError(`The connection wasn’t made (${String(query.error).slice(0, 80)}).`, 400);
    const j = await this.tokenCall(st.provider, { grant_type: 'authorization_code', code: String(query.code || ''), redirect_uri: st.redirectUri });
    const c = { provider: st.provider, access: j.access_token, refresh: j.refresh_token || '', expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000, since: Date.now(), by: st.by, name: '' };
    if (st.provider === 'qbo') {
      c.realmId = String(query.realmId || '');
      if (!/^\d{1,30}$/.test(c.realmId)) throw new ValidationError('QuickBooks didn’t say which company was connected. Try again.', 400);
    } else {
      const res = await this.fetch(this.urls.xero.connections, { headers: { Authorization: 'Bearer ' + c.access, Accept: 'application/json' } });
      const list = await res.json().catch(() => []);
      const t = Array.isArray(list) && list.find(x => x.tenantType === 'ORGANISATION') || (Array.isArray(list) ? list[0] : null);
      if (!t) throw new ValidationError('Xero didn’t share an organisation. Try again and choose one.', 400);
      c.tenantId = String(t.tenantId); c.name = String(t.tenantName || '').slice(0, 120);
    }
    this.data.connections[st.companyId] = c;
    this.save();
    if (st.provider === 'qbo') { try { c.name = await this.qboName(st.companyId); this.save(); } catch { /* the name is only for show */ } }
    return { companyId: st.companyId, provider: st.provider, by: st.by, name: c.name };
  }
  async remove(companyId) {
    const c = this.data.connections[companyId];
    if (!c) return;
    delete this.data.connections[companyId];
    this.save();
    if (c.provider === 'qbo' && this.configured('qbo')) {
      const k = this.data.keys.qbo;
      await this.fetch(this.urls.qbo.revoke, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${k.clientId}:${k.secret}`).toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ token: c.refresh || c.access }) }).catch(() => {});
    }
  }
  /** A fresh access token for the company's connection (refreshed when it's about to run out). */
  async token(companyId) {
    const c = this.data.connections[companyId];
    if (!c) throw new ValidationError('This company isn’t connected to QuickBooks Online or Xero.', 404);
    if (c.expiresAt > Date.now()) return c;
    if (!c.refresh) throw new ValidationError(`The ${NAMES[c.provider]} connection has expired. Connect again.`, 401);
    try {
      const j = await this.tokenCall(c.provider, { grant_type: 'refresh_token', refresh_token: c.refresh });
      Object.assign(c, { access: j.access_token, refresh: j.refresh_token || c.refresh, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 });
      this.save();
      return c;
    } catch (e) { throw new ValidationError(`The ${NAMES[c.provider]} connection has expired. Connect again.`, 401); }
  }
  async get(companyId, url, extra = {}, retried = false) {
    const c = await this.token(companyId);
    const res = await this.fetch(url, { headers: { Authorization: 'Bearer ' + c.access, Accept: 'application/json', ...extra } });
    const j = await res.json().catch(() => ({}));
    // Turned down before its time (revoked, or the clock's off): refresh once and try again.
    if (res.status === 401 && !retried) { c.expiresAt = 0; return this.get(companyId, url, extra, true); }
    if (res.status === 401) throw new ValidationError(`${NAMES[c.provider]} asked to sign in again. Connect again.`, 401);
    if (!res.ok) throw new ValidationError(`${NAMES[c.provider]} answered ${res.status}. Try again in a moment.`, 502);
    return j;
  }
  qboBase(c) { return `${this.urls.qbo.api[(this.data.keys.qbo || {}).env === 'sandbox' ? 'sandbox' : 'production']}/v3/company/${c.realmId}`; }
  async qboName(companyId) {
    const c = this.data.connections[companyId];
    const j = await this.get(companyId, `${this.qboBase(c)}/companyinfo/${c.realmId}?minorversion=70`);
    return String((j.CompanyInfo && (j.CompanyInfo.LegalName || j.CompanyInfo.CompanyName)) || '').slice(0, 120);
  }
  /**
   * The trial balance at a date, for the fiscal year starting fyStart: [{ id, code, name, type, detail, amount }]
   * (debits positive). Balance sheet accounts as at the date; income and expenses for the fiscal year to the date.
   */
  async trialBalance(companyId, fyStart, date) {
    const c = this.data.connections[companyId];
    if (!c) throw new ValidationError('This company isn’t connected to QuickBooks Online or Xero.', 404);
    return c.provider === 'qbo' ? this.qboTB(companyId, c, fyStart, date) : this.xeroTB(companyId, c, date);
  }
  async qboTB(companyId, c, fyStart, date) {
    const base = this.qboBase(c);
    const q = encodeURIComponent('select Id, Name, AcctNum, AccountType, AccountSubType from Account startposition 1 maxresults 1000');
    const acc = await this.get(companyId, `${base}/query?query=${q}&minorversion=70`);
    const types = new Map(((acc.QueryResponse || {}).Account || []).map(a => [String(a.Id), a]));
    const tb = await this.get(companyId, `${base}/reports/TrialBalance?start_date=${fyStart}&end_date=${date}&accounting_method=Accrual&minorversion=70`);
    const out = [];
    const walk = rows => { for (const r of rows || []) {
      if (r.Rows && r.Rows.Row) walk(r.Rows.Row);
      const cd = r.ColData;
      if (!cd || !cd[0] || !cd[0].id) continue;
      const a = types.get(String(cd[0].id)) || {};
      const [type, detail] = QBO_TYPES[a.AccountType] || ['Expense', ''];
      const amount = r2(num(cd[1] && cd[1].value) - num(cd[2] && cd[2].value));
      if (Math.abs(amount) < 0.005) continue;
      out.push({ id: String(cd[0].id), code: String(a.AcctNum || ''), name: String(a.Name || cd[0].value || '').slice(0, 200), type, detail, retained: a.AccountSubType === 'RetainedEarnings', amount });
    } };
    walk((tb.Rows || {}).Row);
    return out;
  }
  async xeroTB(companyId, c, date) {
    const h = { 'xero-tenant-id': c.tenantId };
    const acc = await this.get(companyId, `${this.urls.xero.api}/Accounts`, h);
    const types = new Map((acc.Accounts || []).map(a => [String(a.AccountID), a]));
    const tb = await this.get(companyId, `${this.urls.xero.api}/Reports/TrialBalance?date=${date}`, h);
    const rep = (tb.Reports || [])[0] || {}, out = [];
    const walk = rows => { for (const r of rows || []) {
      if (r.Rows) walk(r.Rows);
      if (r.RowType !== 'Row' || !r.Cells || !r.Cells[0]) continue;
      const attr = (r.Cells[0].Attributes || []).find(x => x.Id === 'account');
      const a = attr ? types.get(String(attr.Value)) || {} : {};
      const [type, detail] = XERO_TYPES[a.Type] || (/retained/i.test(r.Cells[0].Value) ? ['Equity', ''] : ['Expense', '']);
      // The year-to-date columns: balances for the balance sheet, the year so far for income and expenses.
      const amount = r2(num(r.Cells[3] && r.Cells[3].Value) - num(r.Cells[4] && r.Cells[4].Value));
      if (Math.abs(amount) < 0.005) continue;
      const name = String(a.Name || r.Cells[0].Value || '').replace(/\s*\([^)]*\)\s*$/, '');
      out.push({ id: attr ? String(attr.Value) : 'xero-' + name, code: String(a.Code || ''), name: name.slice(0, 200), type, detail, retained: /retained earnings/i.test(name) && type === 'Equity', amount });
    } };
    walk(rep.Rows);
    return out;
  }
}

module.exports = { Ledgers, NAMES, QBO_TYPES, XERO_TYPES, URLS };
