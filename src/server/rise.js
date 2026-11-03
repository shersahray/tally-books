'use strict';
// Read-only Rise connector. No payroll writes or automatic bookkeeping postings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError } = require('./validate');
const BASE = 'https://api.risepeople.com/v1';
class Rise {
  constructor(dir, opts = {}) {
    this.file = path.join(dir, 'rise.json');
    this.keyFile = path.join(dir, 'rise.key');
    this.fetch = opts.fetch || fetch;
    this.data = { clientId: '', enabled: [], connections: {} };
    if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.states = new Map();
    this.refreshes = new Map();
    this.generations = new Map();
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    fs.chmodSync(this.file, 0o600);
  }
  key() {
    if (!fs.existsSync(this.keyFile)) {
      if (Object.keys(this.data.connections).length) throw new ValidationError('Rise encryption key is missing. Restore it before reconnecting.', 409);
      fs.writeFileSync(this.keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    const key = fs.readFileSync(this.keyFile);
    if (key.length !== 32) throw new ValidationError('Rise encryption key is invalid.', 409);
    return key;
  }
  seal(cid, tokens) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(cid));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  unseal(cid, value) {
    const b = Buffer.from(value, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', this.key(), b.subarray(0, 12));
    cipher.setAAD(Buffer.from(cid)); cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString());
  }
  status(cid) {
    if (cid) { const c = this.data.connections[cid]; return { configured: !!this.data.clientId, enabled: this.data.enabled.includes(cid), connected: !!c, since: c ? c.since : 0, mode: 'read-only' }; }
    return { configured: !!this.data.clientId, clientIdHint: this.data.clientId ? '…' + this.data.clientId.slice(-4) : '', connections: Object.keys(this.data.connections).length, mode: 'read-only' };
  }
  update(body) {
    if (!body || typeof body !== 'object' || typeof body.clientId !== 'string' || !/^[A-Za-z0-9_.~-]{0,200}$/.test(body.clientId)) throw new ValidationError('Enter a valid Rise public OAuth client ID.');
    if (Object.keys(this.data.connections).length) throw new ValidationError('Disconnect Rise companies before changing the application.', 409);
    this.data.clientId = body.clientId;
    this.states.clear(); this.save(); return this.status();
  }
  async enable(cid, on) {
    if (typeof on !== 'boolean') throw new ValidationError('Enabled must be true or false.');
    if (!on) this.data.enabled = this.data.enabled.filter(id => id !== cid);
    if (!on) await this.remove(cid);
    this.data.enabled = this.data.enabled.filter(id => id !== cid);
    if (on) this.data.enabled.push(cid);
    this.save();
  }
  need(cid) { if (!this.data.enabled.includes(cid)) throw new ValidationError('Rise payroll integration is not enabled for this company. Ask the administrator.', 403); }
  start(cid, userId, redirectUri) {
    this.need(cid);
    if (!this.data.clientId) throw new ValidationError('The administrator must configure the Rise application first.', 409);
    let u; try { u = new URL(redirectUri); } catch { throw new ValidationError('Set the server public URL first.', 409); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) throw new ValidationError('Rise requires an HTTPS callback address.', 409);
    for (const [k, v] of this.states) if (v.expires < Date.now() || (v.cid === cid && v.userId === userId)) this.states.delete(k);
    if (this.states.size >= 1000) throw new ValidationError('Too many pending connections. Try again later.', 429);
    const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(32).toString('base64url');
    this.states.set(state, { cid, userId, verifier, redirectUri, expires: Date.now() + 600000, clientId: this.data.clientId, generation: this.generations.get(cid) || 0 });
    const url = new URL(BASE + '/oauth/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.data.clientId, redirect_uri: redirectUri, scope: 'reports:read', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return url.toString();
  }
  async request(endpoint, init) {
    let res, body;
    try {
      res = await this.fetch(BASE + endpoint, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
      body = await res.json().catch(e => { if (endpoint === '/oauth/revoke' && res.ok) return {}; throw e; });
    } catch { throw new ValidationError('Could not reach Rise or read its response. Try again.', 502); }
    if (!res.ok) throw new ValidationError(res.status === 401 ? 'Rise authorization expired. Reconnect this company.' : res.status === 403 ? 'Rise denied access. Confirm API access and permissions with Rise.' : res.status === 429 ? 'Rise rate limit reached. Try again later.' : 'Rise could not complete the request. Try again or contact Rise.', res.status === 429 ? 429 : 502);
    return body;
  }
  async token(params) {
    const t = await this.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, client_id: this.data.clientId }).toString() });
    if (typeof t.access_token !== 'string' || !t.access_token || !Number.isFinite(t.expires_in) || t.expires_in <= 0 || (t.token_type && t.token_type.toLowerCase() !== 'bearer')) throw new ValidationError('Rise returned an invalid token response.', 502);
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires: Date.now() + t.expires_in * 1000 };
  }
  async finish(q, allowed) {
    const s = this.states.get(q.state); this.states.delete(q.state);
    if (!s || s.expires < Date.now() || s.clientId !== this.data.clientId || !allowed(s)) throw new ValidationError('This Rise sign-in expired or access changed. Start again.', 403);
    this.need(s.cid);
    if (q.error || typeof q.code !== 'string' || !q.code || q.code.length > 4096) throw new ValidationError('Rise sign-in was cancelled or incomplete.');
    const t = await this.token({ grant_type: 'authorization_code', code: q.code, code_verifier: s.verifier, redirect_uri: s.redirectUri });
    this.need(s.cid);
    if (!allowed(s) || s.clientId !== this.data.clientId || s.generation !== (this.generations.get(s.cid) || 0)) throw new ValidationError('Access changed during sign-in. Start again.', 403);
    this.data.connections[s.cid] = { since: Date.now(), tokens: this.seal(s.cid, t) }; this.save();
    return s.cid;
  }
  async access(cid) {
    this.need(cid);
    const c = this.data.connections[cid];
    if (!c) throw new ValidationError('Connect this company to Rise first.', 409);
    let t = this.unseal(cid, c.tokens);
    if (t.expires > Date.now() + 60000) return t.access_token;
    if (!t.refresh_token) throw new ValidationError('Rise connection expired. Reconnect this company.', 409);
    if (!this.refreshes.has(cid)) {
      const work = (async () => {
        const next = await this.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
        this.need(cid);
        if (this.data.connections[cid] !== c) throw new ValidationError('Rise connection changed. Try again.', 409);
        next.refresh_token = next.refresh_token || t.refresh_token;
        c.tokens = this.seal(cid, next); this.save(); return next.access_token;
      })().finally(() => this.refreshes.delete(cid));
      this.refreshes.set(cid, work);
    }
    return this.refreshes.get(cid);
  }
  async preview(cid) {
    const connection = this.data.connections[cid], token = await this.access(cid);
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const [employees, reports] = await Promise.all([this.request('/employees?page[number]=1&page[size]=100', { headers }), this.request('/reports', { headers })]);
    this.need(cid);
    if (this.data.connections[cid] !== connection) throw new ValidationError('Rise connection changed. Try again.', 409);
    if (!Array.isArray(employees.data) || !Array.isArray(reports.data)) throw new ValidationError('Unexpected Rise response. Confirm the API schema with Rise.', 502);
    const text = x => String(x || '').slice(0, 200);
    return { employees: employees.data.slice(0, 100).map(e => ({ id: text(e.id), name: text([e.attributes?.first_name, e.attributes?.last_name].filter(Boolean).join(' ')), status: text(e.attributes?.status) })), reports: reports.data.slice(0, 100).map(r => ({ id: text(r.id), title: text(r.attributes?.title || r.title) })), partial: !!employees.links?.next || !!reports.links?.next || employees.data.length > 100 || reports.data.length > 100, mode: 'read-only' };
  }
  async remove(cid) {
    this.generations.set(cid, (this.generations.get(cid) || 0) + 1);
    const c = this.data.connections[cid];
    delete this.data.connections[cid];
    for (const [k, v] of this.states) if (v.cid === cid) this.states.delete(k);
    this.save();
    let revoked = !c;
    if (c) try { const t = this.unseal(cid, c.tokens); await this.request('/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.data.clientId, token: t.refresh_token || t.access_token }).toString() }); revoked = true; } catch { /* local disconnect still succeeds */ }
    return { ...this.status(cid), revoked };
  }
}
module.exports = { Rise };
