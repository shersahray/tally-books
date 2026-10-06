'use strict';
/*
 * Bank feeds through Plaid: a client signs in to their bank in Plaid's own window, and new transactions
 * arrive in Banking → For review every few hours. Nothing is added to the books until a person reviews it.
 *
 * Secrets stay on this server, in plaid.json in the data folder (readable only by this account):
 *   - the server's Plaid keys (client ID and secret), entered by the server's administrator, or from
 *     PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV;
 *   - each bank connection's access token and sync position.
 * They are never sent to a browser, and never written into a company's books, backups or year-end package.
 * What a company keeps is only what people need to see: the bank's name, its accounts and which Sumlora
 * account each one feeds.
 *
 * Plaid's amounts are positive when money leaves the account. Sumlora's bank lines are the other way round
 * (money in is positive), so amounts are flipped on the way in.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError } = require('./validate');

const HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const MAX_ITEMS_PER_COMPANY = 10;
const MAX_PAGES = 40;            // 40 × 500 = 20,000 changes in one sync, plenty for two years of a busy account
const DAYS_REQUESTED = 730;      // ask the bank for up to two years; each account's start date decides what comes in

class Plaid {
  /**
   * @param {string} dir  Where plaid.json is kept: the app's own per-computer folder when there is one (never a shared books folder).
   * @param {object} [o]
   * @param {object} [o.env]     { clientId, secret, env } from environment variables (take priority over Settings)
   * @param {Function} [o.fetch] stand-in for fetch (tests)
   */
  constructor(dir, o = {}) {
    this.file = path.join(dir, 'plaid.json');
    this.env = o.env || {};
    this.fetch = o.fetch || ((...a) => fetch(...a));
    this.data = { clientId: '', secret: '', env: 'sandbox', items: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    if (!this.data.items || typeof this.data.items !== 'object') this.data.items = {};
    this.busy = new Set();        // item ids being synced right now
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }
  keys() {
    const clientId = this.env.clientId || this.data.clientId, secret = this.env.secret || this.data.secret;
    const env = HOSTS[this.env.env] ? this.env.env : HOSTS[this.data.env] ? this.data.env : 'sandbox';
    return { clientId, secret, env };
  }
  configured() { const k = this.keys(); return !!(k.clientId && k.secret); }

  /** What a browser may see. Never the secret or an access token. */
  status(full) {
    const k = this.keys(), out = { configured: this.configured(), env: k.env };
    if (full) {
      const items = Object.values(this.data.items);
      Object.assign(out, {
        source: this.env.clientId ? 'env' : k.clientId ? 'settings' : '',
        clientIdHint: k.clientId ? '…' + k.clientId.slice(-4) : '',
        connections: items.length,
        accounts: items.reduce((n, i) => n + Object.values(i.links || {}).filter(Boolean).length, 0),
      });
    }
    return out;
  }
  update(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Send the bank feed settings as an object.');
    if (body.clientId !== undefined) {
      const v = String(body.clientId || '').trim();
      if (v && !/^[A-Za-z0-9]{16,64}$/.test(v)) throw new ValidationError('That doesn’t look like a Plaid client ID. Copy it from Plaid’s dashboard → Developers → Keys.');
      this.data.clientId = v;
    }
    if (body.secret !== undefined) {
      const v = String(body.secret || '').trim();
      if (v && !/^[A-Za-z0-9]{16,64}$/.test(v)) throw new ValidationError('That doesn’t look like a Plaid secret. Copy it from Plaid’s dashboard → Developers → Keys.');
      this.data.secret = v;
    }
    if (body.env !== undefined) {
      if (!HOSTS[body.env]) throw new ValidationError('Choose Sandbox (test banks) or Production (real banks).');
      if (body.env !== this.data.env && Object.keys(this.data.items).length) throw new ValidationError('Disconnect every bank feed before switching between Sandbox and Production.');
      this.data.env = body.env;
    }
    this.save();
    return this.status(true);
  }

  /** One call to Plaid's API. Errors come back as plain sentences, with Plaid's code kept for decisions. */
  async call(endpoint, body) {
    const k = this.keys();
    if (!k.clientId || !k.secret) throw new ValidationError('Bank feeds aren’t set up yet. The server’s administrator adds the Plaid keys in Settings.', 409);
    let res;
    try {
      res = await this.fetch(HOSTS[k.env] + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Plaid-Version': '2020-09-14' }, body: JSON.stringify({ client_id: k.clientId, secret: k.secret, ...body }) });
    } catch { throw new ValidationError('Couldn’t reach Plaid. Check the server’s internet connection and try again.', 502); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new ValidationError(friendly(j), res.status === 400 || res.status === 401 ? 400 : 502);
      e.plaidCode = j.error_code || ''; e.plaidType = j.error_type || '';
      throw e;
    }
    return j;
  }

  /** A short-lived token that opens Plaid's bank sign-in window. With an item, it reopens that bank (to sign in again). */
  async linkToken({ userId, lang, itemId, companyId }) {
    const body = {
      client_name: 'Sumlora', language: lang === 'fr' ? 'fr' : 'en', country_codes: ['CA', 'US'],
      user: { client_user_id: crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32) },
    };
    if (itemId) {
      const it = this.item(itemId, companyId);
      body.access_token = it.accessToken;
    } else {
      if (this.forCompany(companyId).length >= MAX_ITEMS_PER_COMPANY) throw new ValidationError(`A company can have up to ${MAX_ITEMS_PER_COMPANY} bank connections.`);
      body.products = ['transactions'];
      body.transactions = { days_requested: DAYS_REQUESTED };
    }
    const j = await this.call('/link/token/create', body);
    return j.link_token;
  }

  /** After the person signs in: swap the one-time token for a lasting one, and list the bank's accounts. */
  async connect({ publicToken, institution, companyId, firmId, userName }) {
    if (!/^public-[A-Za-z0-9-]{8,200}$/.test(String(publicToken || ''))) throw new ValidationError('The bank sign-in didn’t finish. Try again.');
    const ex = await this.call('/item/public_token/exchange', { public_token: publicToken });
    let accounts;
    try { accounts = await this.accounts(ex.access_token); }
    catch (e) { await this.call('/item/remove', { access_token: ex.access_token }).catch(() => {}); throw e; }
    const id = 'pi_' + crypto.randomBytes(9).toString('hex');
    this.data.items[id] = {
      companyId, firmId: firmId || '', plaidItemId: ex.item_id, accessToken: ex.access_token, cursor: '',
      institution: String((institution && institution.name) || 'Bank').slice(0, 100), accounts, links: {}, starts: {},
      status: 'ok', error: '', lastSync: 0, created: Date.now(), by: String(userName || '').slice(0, 100),
    };
    this.save();
    return this.publicItem(id);
  }
  async accounts(accessToken) {
    const j = await this.call('/accounts/get', { access_token: accessToken });
    return (j.accounts || []).filter(a => /^[A-Za-z0-9_-]{1,100}$/.test(String(a.account_id || ''))).map(a => ({ id: String(a.account_id), name: String(a.name || a.official_name || 'Account').slice(0, 100), mask: String(a.mask || '').slice(0, 8), type: String(a.type || ''), subtype: String(a.subtype || ''), currency: String((a.balances && a.balances.iso_currency_code) || '') }));
  }

  item(id, companyId) {
    const it = this.data.items[id];
    if (!it || it.companyId !== companyId) throw new ValidationError('That bank connection doesn’t exist.', 404);
    return it;
  }
  forCompany(companyId) { return Object.keys(this.data.items).filter(id => this.data.items[id].companyId === companyId); }
  /** What the browser sees about a connection. */
  publicItem(id) {
    const it = this.data.items[id];
    return { id, institution: it.institution, accounts: it.accounts, links: it.links || {}, starts: it.starts || {}, status: it.status, error: it.error || '', lastSync: it.lastSync || 0, created: it.created, by: it.by || '' };
  }
  list(companyId) { return this.forCompany(companyId).map(id => this.publicItem(id)); }

  /** Which Sumlora account each bank account feeds, and from what date. */
  setLinks(id, companyId, links, starts) {
    const it = this.item(id, companyId);
    const known = new Set(it.accounts.map(a => a.id));
    const nl = {}, ns = {};
    for (const [k, v] of Object.entries(links || {})) if (known.has(k) && v) nl[k] = String(v);
    for (const [k, v] of Object.entries(starts || {})) if (known.has(k) && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) ns[k] = String(v);
    // A newly linked account, or an earlier start date: read the bank's history again from the beginning.
    // Lines already brought in are recognised and skipped, so nothing comes in twice.
    const wider = Object.keys(nl).some(k => !it.links[k] || it.links[k] !== nl[k] || (ns[k] || '') < (it.starts[k] || ''));
    it.links = nl; it.starts = ns;
    if (wider) { it.cursor = ''; it.gen = (it.gen || 0) + 1; }
    this.save();
    return this.publicItem(id);
  }

  async remove(id, companyId) {
    const it = this.item(id, companyId);
    // Removing the connection at Plaid stops its monthly charge. If Plaid can't be reached, forget it here anyway.
    let warning = '';
    try { await this.call('/item/remove', { access_token: it.accessToken }); }
    catch (e) { if (e.plaidCode !== 'ITEM_NOT_FOUND') warning = 'Plaid couldn’t be reached, so the connection may still show in Plaid’s dashboard. Remove it there to stop its monthly charge.'; }
    delete this.data.items[id];
    this.save();
    return { warning };
  }
  /** The company's books were replaced (restore or conversion): read every bank's history again. Lines already in are recognised. */
  resetCompany(companyId) {
    let n = 0;
    for (const id of this.forCompany(companyId)) { const it = this.data.items[id]; it.cursor = ''; it.gen = (it.gen || 0) + 1; n++; }
    if (n) this.save();
  }
  /** A company was removed: drop its connections too. */
  async removeCompany(companyId) { for (const id of this.forCompany(companyId)) await this.remove(id, companyId).catch(() => {}); }

  /**
   * Fetch what changed at the bank since the last sync. Returns the changes for the caller to write into the
   * company's books; the new position is only saved once they're written (commit), so nothing is lost if writing fails.
   */
  async pull(id, companyId) {
    const it = this.item(id, companyId);
    if (this.busy.has(id)) return null;
    this.busy.add(id);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let cursor = it.cursor || '';
        const gen = it.gen || 0, added = [], modified = [], removed = [];
        try {
          for (let page = 0; ; page++) {
            if (page >= MAX_PAGES) break;
            const j = await this.call('/transactions/sync', { access_token: it.accessToken, count: 500, ...(cursor ? { cursor } : {}) });
            added.push(...(j.added || [])); modified.push(...(j.modified || [])); removed.push(...(j.removed || []));
            cursor = j.next_cursor || cursor;
            if (!j.has_more) break;
          }
          return { added, modified, removed, cursor, gen };
        } catch (e) {
          // The bank changed things while we were paging: start again from where this sync began.
          if (e.plaidCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt === 0) continue;
          if (e.plaidCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') e.message = 'The bank was updating while Sumlora read it. Try again in a minute.';
          it.status = e.plaidCode === 'ITEM_LOGIN_REQUIRED' || e.plaidCode === 'PENDING_EXPIRATION' ? 'login' : 'error';
          it.error = it.status === 'login' ? 'The bank needs you to sign in again.' : e.message;
          this.save();
          throw e;
        }
      }
      return null;
    } finally { this.busy.delete(id); }
  }
  /** Save the new position. If the accounts were relinked during the sync, keep the reset so history is read again. */
  commit(id, changes) {
    const it = this.data.items[id]; if (!it) return;
    if ((it.gen || 0) === (changes.gen || 0)) it.cursor = changes.cursor;
    it.status = 'ok'; it.error = ''; it.lastSync = Date.now();
    this.save();
  }
  /** Signed in again through Plaid's window: clear the warning; the next sync picks up where it stopped. */
  reconnected(id, companyId) {
    const it = this.item(id, companyId);
    it.status = 'ok'; it.error = '';
    this.save();
    return this.publicItem(id);
  }
}

/** Plaid's errors, in words a bookkeeper can act on. */
function friendly(j) {
  const code = j && j.error_code;
  const map = {
    INVALID_API_KEYS: 'Plaid didn’t accept the keys. Check the client ID and secret in Settings, and that they’re for the chosen environment (Sandbox or Production).',
    ITEM_LOGIN_REQUIRED: 'The bank needs you to sign in again. Click “Sign in again” on this connection.',
    PENDING_EXPIRATION: 'The bank’s permission is about to end. Click “Sign in again” on this connection.',
    INSTITUTION_DOWN: 'The bank isn’t answering right now. Sumlora will try again later.',
    INSTITUTION_NOT_RESPONDING: 'The bank isn’t answering right now. Sumlora will try again later.',
    PRODUCT_NOT_READY: 'The bank is still sending its first transactions. Try again in a few minutes.',
    RATE_LIMIT_EXCEEDED: 'Too many requests to Plaid. Try again in a minute.',
    INVALID_ACCESS_TOKEN: 'This bank connection isn’t valid any more. Disconnect it and connect the bank again.',
    ITEM_NOT_FOUND: 'This bank connection isn’t valid any more. Disconnect it and connect the bank again.',
  };
  if (map[code]) return map[code];
  const msg = (j && (j.display_message || j.error_message)) || '';
  return msg ? `Plaid: ${String(msg).slice(0, 200)}` : 'Plaid couldn’t do that. Try again in a moment.';
}

/**
 * Turn Plaid's changes into bank lines for one company. Only accounts linked to a Sumlora bank or card account
 * come in, only from each account's start date, and only once the bank has posted them (not while pending).
 * Lines already reviewed are never changed or removed; lines still waiting are updated or removed with the bank.
 * @returns {{added:number, updated:number, removed:number}}
 */
function applyChanges(store, item, changes, institution) {
  const links = item.links || {}, starts = item.starts || {}, now = Date.now();
  const idFor = (acct, tid) => 'b_' + crypto.createHash('sha1').update(acct + '\u0000p:' + tid).digest('hex').slice(0, 24);
  const byTid = new Map();
  for (const b of store.list('bankTxns')) if (b.ptid) byTid.set(b.ptid, b);
  const okAcct = id => { const a = store.get('accounts', id); return a && (a.detail === 'bank' || a.detail === 'card'); };
  // Lines imported from a statement file that the bank feed hasn't matched yet, by account and amount.
  const fromFiles = new Map();
  for (const b of store.list('bankTxns')) if (!b.feed && !b.ptid) { const k = b.account + '|' + Number(b.amount).toFixed(2); if (!fromFiles.has(k)) fromFiles.set(k, []); fromFiles.get(k).push(b); }
  const line = t => {
    const amount = -Math.round(Number(t.amount) * 100) / 100;
    const cur = t.iso_currency_code || t.unofficial_currency_code || '';
    let desc = String(t.merchant_name && t.name && !String(t.name).toLowerCase().includes(String(t.merchant_name).toLowerCase()) ? `${t.merchant_name} · ${t.name}` : (t.name || t.merchant_name || '')).replace(/\s+/g, ' ').trim();
    if (cur && cur !== 'CAD') desc = `${desc} (${cur})`;
    return { amount, desc: desc.slice(0, 300) };
  };
  let added = 0, updated = 0, removed = 0;
  for (const t of changes.added || []) {
    const acct = links[t.account_id];
    if (!acct || t.pending || !okAcct(acct)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.date || ''))) continue;
    if (starts[t.account_id] && t.date < starts[t.account_id]) continue;
    const { amount, desc } = line(t);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const id = idFor(acct, t.transaction_id);
    if (store.get('bankTxns', id) || byTid.has(t.transaction_id)) continue;
    // Already imported from a statement (same account and amount, within 3 days): mark that line as this one, don't add it twice.
    const same = (fromFiles.get(acct + '|' + amount.toFixed(2)) || []).find(b => !b.ptid && Math.abs(daysApart(b.date, t.date)) <= 3);
    if (same) { same.ptid = String(t.transaction_id); store.put('bankTxns', same.id, { ...same }); byTid.set(same.ptid, same); continue; }
    store.put('bankTxns', id, { account: acct, date: t.date, amount, desc, fitid: '', status: 'new', entryId: '', imported: now, file: `Bank feed · ${institution}`.slice(0, 200), feed: true, ptid: String(t.transaction_id) });
    added++;
  }
  for (const t of changes.modified || []) {
    const b = byTid.get(t.transaction_id); if (!b || b.status !== 'new' || t.pending) continue;
    const { amount, desc } = line(t);
    if (!Number.isFinite(amount) || amount === 0) continue;
    store.put('bankTxns', b.id, { ...b, date: t.date || b.date, amount, desc });
    updated++;
  }
  for (const r of changes.removed || []) {
    const b = byTid.get(r.transaction_id); if (!b || b.status !== 'new') continue;
    store.delete('bankTxns', b.id);
    removed++;
  }
  return { added, updated, removed };
}

function daysApart(a, b) { return (Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5; }

/**
 * A statement line being imported: is it already here from the bank feed (same account and amount, within 3 days)?
 * If so, that feed line is marked as matched (so it isn't used for a second statement line) and the statement line is skipped.
 */
function feedTwin(store, accountId, date, amount, claimed) {
  const k = Number(amount).toFixed(2);
  return store.list('bankTxns').find(b => b.feed && b.account === accountId && Number(b.amount).toFixed(2) === k && !b.fileMatched && !claimed.has(b.id) && Math.abs(daysApart(b.date, date)) <= 3) || null;
}

module.exports = { Plaid, applyChanges, feedTwin, HOSTS };
