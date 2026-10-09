'use strict';
// Sign-in security: user accounts, password hashing, sessions, lockout and roles.
//
// - Passwords are hashed with scrypt and a per-user salt; the plain password is never stored.
// - A session is a random 32-byte token in an HttpOnly, SameSite=Strict cookie.
// - Sessions end after a period of inactivity (auto-lock) and after 12 hours regardless.
// - 5 wrong passwords for an account lock it for 15 minutes.
// - Roles: "owner" manages users, security and backups and sees every company;
//   "staff" works in the companies they're given (all of them if none are picked);
//   "client" sees only the companies they're given, never all.
//   Staff and clients can also be "view only": they can look but not change anything.
// - Two-step sign-in: a 6-digit code from an authenticator app (TOTP, RFC 6238), with one-time
//   recovery codes. Owners can require it for owners or for everyone.
// - New users get a one-time invitation link to choose their own password; owners can also send
//   a password reset link. Links are stored only as hashes and expire.
// - Sign-ins, failures and account changes are written to signins.log in the data folder.

const fs = require('node:fs');
const path = require('node:path');
const PLANS = require('../../public/plans.js');
const crypto = require('node:crypto');

const COOKIE = 'tb_session';
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 10;
const ROLES = ['owner', 'staff', 'client'];
const TICKET_MS = 5 * 60 * 1000;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_MS = 24 * 60 * 60 * 1000;
const LOG_MAX = 5 * 1024 * 1024;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ---------- authenticator-app codes (TOTP, RFC 6238: SHA-1, 30 seconds, 6 digits) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(s).replace(/[\s=-]/g, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('Not base32');
    val = ((val << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, step, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
  return String(n).padStart(digits, '0');
}
const stepNow = (now = Date.now()) => Math.floor(now / 30000);
/** Which time step a code matches (allowing 30 seconds of clock drift either way), or 0. */
function matchStep(secret, code, now = Date.now()) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return 0;
  const s = stepNow(now);
  for (const st of [s, s - 1, s + 1]) {
    const a = Buffer.from(totp(secret, st)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return st;
  }
  return 0;
}
const newRecoveryCodes = () => Array.from({ length: 10 }, () => { const h = crypto.randomBytes(5).toString('hex'); return h.slice(0, 5) + '-' + h.slice(5); });

class AuthError extends Error {
  constructor(message, status = 401, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex') });

// The same check without blocking the server (used for sign-in, where many requests can arrive at once).
const scryptAsync = (pw, salt) => new Promise((res, rej) => crypto.scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function checkPasswordAsync(user, password) {
  const salt = user && user.hash && user.salt ? user.salt : 'no-such-user-salt';
  const key = await scryptAsync(password, salt); // same work whether or not the user exists
  if (!user || !user.hash || !user.salt) return false;
  return crypto.timingSafeEqual(key, Buffer.from(user.hash, 'hex'));
}
const MAX_FIELD = 200;
const LOCK_TOTAL = 50; // wrong tries for one account from all addresses together

function checkPassword(user, password) {
  if (!user.hash || !user.salt) { hashPassword(password); return false; } // invited, no password yet
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function passwordProblem(pw, user = {}) {
  pw = String(pw || '');
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  const lower = pw.toLowerCase();
  if ((user.username && lower.includes(String(user.username).toLowerCase())) || /^(.)\1+$/.test(pw) || ['password', '1234567890', 'qwertyuiop'].some(w => lower.includes(w))) {
    return 'That password is too easy to guess. Try a short phrase of a few unrelated words.';
  }
  return '';
}

const cleanUsername = u => String(u || '').trim().toLowerCase();

class Auth {
  /**
   * @param {string} dataDir
   * @param {object} [opts]
   * @param {string} [opts.require2fa]  'owners' or 'everyone': the least two-step sign-in allowed (for online servers)
   */
  constructor(dataDir, opts = {}) {
    this.file = path.join(dataDir, 'users.json');
    this.logFile = path.join(dataDir, 'signins.log');
    this.data = { version: 1, users: [], firms: [], settings: { idleMinutes: 30, require2fa: 'off', signups: 'off' } };
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = { ...this.data, ...d, settings: { ...this.data.settings, ...(d.settings || {}) } }; } catch { /* first run */ }
    if (!Array.isArray(this.data.firms)) this.data.firms = [];
    this.adoptFirm();
    this.forced2fa = ['owners', 'everyone'].includes(opts.require2fa) ? opts.require2fa : 'off';
    this.sessions = new Map(); // token -> { userId, created, lastSeen }
    this.failures = new Map(); // username -> { count, until }
    this.tickets = new Map();  // half-finished sign-ins waiting for a code: ticket -> { userId, created, tries }
  }

  /** Append one line to the sign-in log (kept to about 5 MB, with one older file). */
  log(event, detail = {}) {
    try {
      for (const k of Object.keys(detail)) if (typeof detail[k] === 'string') detail[k] = detail[k].slice(0, 120);
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n';
      try {
        if (fs.statSync(this.logFile).size > LOG_MAX) {
          for (const n of [3, 2, 1]) { try { fs.renameSync(n === 1 ? this.logFile : `${this.logFile}.${n - 1}`, `${this.logFile}.${n}`); } catch { /* none */ } }
        }
      } catch { /* no log yet */ }
      fs.appendFileSync(this.logFile, line, { mode: 0o600 });
    } catch { /* logging must never stop a sign-in */ }
  }
  readLog(limit = 500) {
    let text = '';
    for (const f of [this.logFile + '.3', this.logFile + '.2', this.logFile + '.1', this.logFile]) { try { text += fs.readFileSync(f, 'utf8'); } catch { /* none */ } }
    return text.split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  }

  /** Two-step sign-in rule in force: 'off', 'owners' or 'everyone' (the stricter of the setting and the server's minimum). */
  get policy2fa() {
    const rank = { off: 0, owners: 1, everyone: 2 };
    const set = this.data.settings.require2fa || 'off';
    return rank[this.forced2fa] > rank[set] ? this.forced2fa : set;
  }
  needs2fa(u) { const p = this.policy2fa; return p === 'everyone' || (p === 'owners' && u.role === 'owner'); }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  needsSetup() { return this.data.users.length === 0; }

  /* ---------- firms ----------
     Each firm has its own owners, staff, clients and companies, and never sees another firm's. The people who
     set up the server are its administrators: they approve new firms and look after server-wide settings. */
  /** Books from before firms existed: everyone becomes one firm, and its owners run the server. */
  adoptFirm() {
    if (!this.data.users.length || this.data.users.every(u => u.firmId)) return;
    let f = this.data.firms[0];
    if (!f) { f = this.newFirm('My firm', 'active', true, 'plus'); }
    for (const u of this.data.users) if (!u.firmId) u.firmId = f.id;
    if (!this.data.users.some(u => u.platformAdmin)) for (const u of this.data.users) if (u.role === 'owner' && u.firmId === f.id) u.platformAdmin = true;
    this.save();
  }
  newFirm(name, status, ai, plan) {
    const f = { id: 'f_' + crypto.randomBytes(6).toString('hex'), name: String(name || '').trim().slice(0, 120) || 'My firm', status, ai: !!ai, aiCapUsd: 10, plan: PLANS.planOf(plan), created: Date.now() };
    this.data.firms.push(f);
    return f;
  }
  /** The firm everything belonged to before firms existed (the first one). */
  get mainFirmId() { return this.data.firms[0] ? this.data.firms[0].id : ''; }
  firm(id) { return this.data.firms.find(f => f.id === id) || null; }
  firmUsers(id) { return this.data.users.filter(u => u.firmId === id); }
  /** The plan a firm gets when it signs itself up. */
  get defaultPlan() { return PLANS.PLANS[this.data.settings.defaultPlan] ? this.data.settings.defaultPlan : 'essentials'; }
  setDefaultPlan(v) {
    if (!PLANS.PLANS[v]) throw new AuthError('Choose one of the plans.', 400);
    this.data.settings.defaultPlan = v;
    this.save();
  }
  get signups() { return ['approval', 'open'].includes(this.data.settings.signups) ? this.data.settings.signups : 'off'; }
  setSignups(v) {
    if (!['off', 'approval', 'open'].includes(v)) throw new AuthError('Choose off, approval or open.', 400);
    this.data.settings.signups = v;
    this.save();
  }
  /**
   * A firm, or a business keeping its own books, signs itself up: a new firm and its owner.
   * Waits for an administrator's approval unless sign-ups are open.
   */
  signup({ firmName, name, username, password, kind }) {
    if (this.signups === 'off') throw new AuthError('New accounts can’t be created on this server.', 403);
    const business = kind === 'business';
    firmName = String(firmName || '').trim();
    if (!firmName) throw new AuthError(business ? 'Enter your business’s name.' : 'Enter your firm’s name.', 400);
    if (this.data.firms.filter(f => f.status === 'pending').length >= 100) throw new AuthError('Sign-ups are paused for now. Try again later.', 429);
    const f = this.newFirm(firmName, this.signups === 'open' ? 'active' : 'pending', false, this.defaultPlan);
    if (business) f.kind = 'business';
    try {
      const u = this.addUser({ name, username, password, role: 'owner', firmId: f.id, self: true });
      this.log('firm-signup', { username: u.username, firm: f.name, status: f.status });
      return { user: u, firm: f };
    } catch (e) {
      this.data.firms = this.data.firms.filter(x => x.id !== f.id);
      throw e;
    }
  }
  /** An administrator invites a firm: the firm is active straight away, and its owner gets an invitation link to choose a password. */
  inviteFirm({ firmName, name, username, plan }, actor) {
    firmName = String(firmName || '').trim();
    if (!firmName) throw new AuthError('Enter the firm’s name.', 400);
    const f = this.newFirm(firmName, 'active', false, PLANS.PLANS[plan] ? plan : this.defaultPlan);
    try {
      const u = this.addUser({ name, username, role: 'owner', firmId: f.id, invite: true });
      this.log('firm-invited', { username: u.username, firm: f.name, by: actor && actor.username });
      return { user: u, firm: f };
    } catch (e) {
      this.data.firms = this.data.firms.filter(x => x.id !== f.id);
      throw e;
    }
  }
  /** An administrator changes a firm: approve or suspend it, rename it, allow AI. */
  updateFirm(id, patch, actor) {
    const f = this.firm(id);
    if (!f) throw new AuthError('That firm doesn’t exist.', 404);
    if (patch.status !== undefined) {
      if (!['active', 'suspended'].includes(patch.status)) throw new AuthError('A firm can be active or suspended.', 400);
      if (f.id === actor.firmId && patch.status !== 'active') throw new AuthError('You can’t suspend your own firm.', 409);
      if (f.status === 'pending' && patch.status === 'active') f.approved = Date.now();
      f.status = patch.status;
      if (f.status !== 'active') for (const u of this.firmUsers(f.id)) this.endSessionsFor(u.id);
    }
    if (patch.name !== undefined) { const n = String(patch.name).trim().slice(0, 120); if (!n) throw new AuthError('Enter the firm’s name.', 400); f.name = n; }
    if (patch.ai !== undefined) f.ai = !!patch.ai;
    if (patch.plan !== undefined) {
      if (!PLANS.PLANS[patch.plan]) throw new AuthError('Choose one of the plans.', 400);
      f.plan = patch.plan;
    }
    if (patch.aiCapUsd !== undefined) {
      const c = Number(patch.aiCapUsd);
      if (!Number.isFinite(c) || c < 0 || c > 10000) throw new AuthError('The monthly AI limit must be between $0 and $10,000.', 400);
      f.aiCapUsd = Math.round(c * 100) / 100;
    }
    this.save();
    this.log('firm-changed', { by: actor.username, firm: f.name, changes: Object.keys(patch) });
    return f;
  }
  /** Remove a firm that never got going (waiting, declined or suspended, with no companies), and its people, so their usernames are free again. */
  deleteFirm(id, actor, companyCount) {
    const f = this.firm(id);
    if (!f) throw new AuthError('That firm doesn’t exist.', 404);
    if (f.id === actor.firmId) throw new AuthError('You can’t remove your own firm.', 409);
    if (f.status === 'active') throw new AuthError('Suspend the firm before removing it.', 409);
    if (companyCount) throw new AuthError('This firm has companies, so it can’t be removed. Their books are kept while it’s suspended.', 409);
    for (const u of this.firmUsers(f.id)) this.endSessionsFor(u.id);
    this.data.users = this.data.users.filter(u => u.firmId !== f.id);
    this.data.firms = this.data.firms.filter(x => x.id !== f.id);
    this.save();
    this.log('firm-deleted', { by: actor.username, firm: f.name });
  }
  /** Is this session still open (for live updates that outlast it)? */
  sessionAlive(token) {
    const s = token && this.sessions.get(token), now = Date.now();
    return !!(s && now - s.lastSeen <= this.idleMs && now - s.created <= MAX_SESSION_MS);
  }
  /** Why people in this firm can't sign in, or '' if they can. */
  firmBlock(u) {
    const f = this.firm(u.firmId);
    if (!f) return 'This account doesn’t belong to a firm. Ask the server’s administrator.';
    if (f.status === 'pending') return 'Your firm’s account is waiting for approval. You can sign in once it’s approved.';
    if (f.status === 'suspended') return 'Your firm’s account has been suspended. Contact the server’s administrator.';
    return '';
  }
  get idleMs() { return (this.data.settings.idleMinutes || 30) * 60 * 1000; }

  publicUser(u) {
    if (!u) return u;
    const twoStep = !!(u.totp && u.totp.enabled);
    const f = this.firm(u.firmId);
    return { id: u.id, name: u.name, username: u.username, role: u.role, companies: u.companies || [], readOnly: !!u.readOnly, disabled: !!u.disabled, created: u.created, lastLogin: u.lastLogin || 0,
      firmId: u.firmId || '', firmName: f ? f.name : '', firmPlan: (this.planOverride && this.planOverride()) || (f ? PLANS.planOf(f.plan) : 'plus'), platformAdmin: !!u.platformAdmin,
      lang: u.lang || '', theme: u.theme || '', mustChange: !!u.mustChange, twoStep, mustEnroll: !twoStep && this.needs2fa(u), invited: !u.hash, recoveryLeft: twoStep ? (u.totp.recovery || []).length : 0,
      linkPending: u.invite && u.invite.expires > Date.now() ? u.invite.kind : '', terms: u.terms ? { v: u.terms.v, at: u.terms.at } : null };
  }
  list(firmId) { return this.data.users.filter(u => u.firmId === firmId).map(u => this.publicUser(u)); }
  /** A user in the same firm as the person asking (anyone else counts as not existing). */
  inFirm(id, actor) { const u = this.byId(id); if (!u || u.firmId !== actor.firmId) throw new AuthError('That user doesn’t exist.', 404); return u; }
  /** Only an administrator can change an administrator's account (otherwise any owner could take it over with a reset link). */
  guardAdmin(u, actor) { if (u.platformAdmin && u.id !== actor.id && !actor.platformAdmin) throw new AuthError('Only the server’s administrator can change an administrator’s account.', 403); }
  activeAdmins() { return this.data.users.filter(x => x.platformAdmin && x.role === 'owner' && !x.disabled); }
  byId(id) { return this.data.users.find(u => u.id === id); }
  byName(username) { return this.data.users.find(u => u.username === cleanUsername(username)); }

  /** First-time setup: create the owner account. Only works while there are no users. */
  setup({ name, username, password, firmName }) {
    if (!this.needsSetup()) throw new AuthError('Setup is already done. Sign in instead.', 409);
    const f = this.data.firms[0] || this.newFirm(firmName || 'My firm', 'active', true, 'plus');
    if (firmName && String(firmName).trim()) f.name = String(firmName).trim().slice(0, 120);
    const u = this.addUser({ name, username, password, role: 'owner', firmId: f.id });
    this.byId(u.id).platformAdmin = true;
    this.save();
    return this.publicUser(this.byId(u.id));
  }

  addUser({ name, username, password, role = 'staff', companies = [], mustChange = false, readOnly = false, invite = false, firmId, self = false }) {
    if (!firmId || !this.firm(firmId)) throw new AuthError('Choose the firm for this person.', 400);
    name = String(name || '').trim().slice(0, 80);
    username = cleanUsername(username);
    if (!name) throw new AuthError('Enter a name.', 400);
    if (!/^[a-z0-9._@+-]{3,80}$/.test(username)) throw new AuthError('The username (or email) must be 3–80 characters: letters, numbers, and . _ @ + - only.', 400);
    if (this.byName(username)) throw new AuthError('That username is already taken.', 409);
    if (!ROLES.includes(role)) throw new AuthError('Role must be owner, staff or client.', 400);
    companies = Array.isArray(companies) ? companies.map(String) : [];
    if (role === 'client' && !companies.length) throw new AuthError('Choose the company this client can see.', 400);
    const u = { id: 'u_' + crypto.randomBytes(8).toString('hex'), firmId, name, username, role, companies, readOnly: role !== 'owner' && !!readOnly, created: Date.now() };
    let link = '';
    if (invite) { link = this.setLink(u, 'invite'); }
    else if (this.forced2fa !== 'off' && this.data.users.length && !self) {
      throw new AuthError('On this server, add people with an invitation link so they choose their own password.', 400);
    } else {
      const problem = passwordProblem(password, { username });
      if (problem) throw new AuthError(problem, 400);
      Object.assign(u, hashPassword(password), { mustChange: !!mustChange });
    }
    this.data.users.push(u);
    this.save();
    return { ...this.publicUser(u), ...(link ? { link } : {}) };
  }

  /* ---------- invitation and password reset links ---------- */
  setLink(u, kind) {
    const token = crypto.randomBytes(24).toString('base64url');
    u.invite = { hash: sha256(token), kind, expires: Date.now() + (kind === 'invite' ? INVITE_MS : RESET_MS) };
    return token;
  }
  /** A new invitation (someone who hasn't set a password) or password reset link. Returns the token. */
  issueLink(id, actor) {
    const u = this.inFirm(id, actor);
    this.guardAdmin(u, actor);
    if (u.disabled) throw new AuthError('Turn this account back on first.', 409);
    const token = this.setLink(u, u.hash ? 'reset' : 'invite');
    this.save();
    return { token, kind: u.invite.kind, expires: u.invite.expires };
  }
  userForLink(token) {
    const h = sha256(token || '');
    const u = this.data.users.find(x => x.invite && x.invite.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.invite.hash), Buffer.from(h)));
    if (!u || u.disabled || u.invite.expires < Date.now()) throw new AuthError('This link has expired or was already used. Ask for a new one.', 410);
    return u;
  }
  /** Remove someone who never signed in (an invitation sent to the wrong email, say). Anyone who has signed in is turned off instead, so the sign-in history stays complete. */
  removeUser(id, actor) {
    const u = this.inFirm(id, actor);
    this.guardAdmin(u, actor);
    if (u.id === actor.id) throw new AuthError('You can’t remove your own account.', 409);
    if (u.lastLogin) throw new AuthError('This person has signed in before, so they can’t be removed. Turn their account off instead.', 409);
    this.endSessionsFor(u.id);
    this.data.users = this.data.users.filter(x => x.id !== u.id);
    this.save();
    this.log('user-removed', { username: u.username, by: actor.username });
  }
  /** A company was removed: take it off everyone's list of companies. */
  dropCompany(cid) {
    let changed = false;
    for (const u of this.data.users) if ((u.companies || []).includes(cid)) { u.companies = u.companies.filter(x => x !== cid); changed = true; }
    if (changed) this.save();
  }
  /** A firm's Sumlora subscription (see billing.js). */
  setFirmBilling(id, rec, plan) {
    const f = this.firm(id);
    if (!f) return;
    f.billing = rec;
    if (plan && PLANS.PLANS[plan]) f.plan = plan;
    this.save();
  }
  /** Someone agreed to the Terms of service and Privacy policy: keep which version, when, and from where. */
  acceptTerms(id, version, ip) {
    const u = this.byId(id);
    if (!u) return;
    u.terms = { v: String(version), at: Date.now(), ip: String(ip || '').slice(0, 64) };
    this.save();
    this.log('terms-accepted', { username: u.username, version: String(version), ip: String(ip || '').slice(0, 64) });
  }
  peekLink(token) { const u = this.userForLink(token); return { name: u.name, username: u.username, kind: u.invite.kind }; }
  /** Set the password from a link. Returns the user (sign-in continues as with a password). */
  acceptLink(token, password) {
    const u = this.userForLink(token);
    const problem = passwordProblem(password, u);
    if (problem) throw new AuthError(problem, 400);
    const kind = u.invite.kind;
    Object.assign(u, hashPassword(password), { mustChange: false });
    delete u.invite;
    this.endSessionsFor(u.id);
    this.clearFailures(u.username);
    this.save();
    this.log(kind === 'invite' ? 'invite-accepted' : 'password-reset', { username: u.username });
    return u;
  }

  updateUser(id, patch, actor) {
    const u = this.inFirm(id, actor);
    this.guardAdmin(u, actor);
    const lastAdmin = u.platformAdmin && this.activeAdmins().length <= 1;
    if (patch.platformAdmin !== undefined) {
      if (!actor.platformAdmin) throw new AuthError('Only the server’s administrator can do that.', 403);
      if (patch.platformAdmin && u.role !== 'owner' && patch.role !== 'owner') throw new AuthError('Only an owner can be an administrator of the server.', 400);
      if (!patch.platformAdmin && lastAdmin) throw new AuthError('The server needs at least one administrator. Make someone else an administrator first.', 409);
    }
    if (lastAdmin && ((patch.role !== undefined && patch.role !== 'owner') || patch.disabled)) throw new AuthError('This is the server’s only administrator. Make someone else an administrator first.', 409);
    const owners = () => this.data.users.filter(x => x.firmId === u.firmId && x.role === 'owner' && !x.disabled);
    if (patch.name !== undefined) { const n = String(patch.name).trim().slice(0, 80); if (!n) throw new AuthError('Enter a name.', 400); u.name = n; }
    if (patch.role !== undefined) {
      if (!ROLES.includes(patch.role)) throw new AuthError('Role must be owner, staff or client.', 400);
      if (u.role === 'owner' && patch.role !== 'owner' && owners().length <= 1) throw new AuthError('There must always be at least one owner.', 409);
      u.role = patch.role;
      if (u.role !== 'owner') delete u.platformAdmin;
    }
    if (patch.platformAdmin !== undefined && u.role === 'owner') {
      if (patch.platformAdmin) u.platformAdmin = true; else delete u.platformAdmin;
    }
    if (patch.companies !== undefined) u.companies = Array.isArray(patch.companies) ? patch.companies.map(String) : [];
    if (u.role === 'client' && !(u.companies || []).length) throw new AuthError('Choose the company this client can see.', 400);
    if (patch.readOnly !== undefined) u.readOnly = !!patch.readOnly;
    if (u.role === 'owner') u.readOnly = false;
    if (patch.reset2fa) {
      if (u.id === actor.id) throw new AuthError('Turn off your own two-step sign-in from Account instead.', 409);
      delete u.totp; delete u.totpPending;
      this.endSessionsFor(u.id);
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled && u.id === actor.id) throw new AuthError('You can’t turn off your own account.', 409);
      if (patch.disabled && u.role === 'owner' && owners().length <= 1) throw new AuthError('There must always be at least one owner.', 409);
      u.disabled = !!patch.disabled;
      if (u.disabled) { this.endSessionsFor(u.id); delete u.invite; }
    }
    if (patch.password !== undefined) {
      if (u.id === actor.id) throw new AuthError('Change your own password from Account.', 409);
      if (this.forced2fa !== 'off') throw new AuthError('On this server, send a password reset link instead.', 400);
      const problem = passwordProblem(patch.password, u);
      if (problem) throw new AuthError(problem, 400);
      Object.assign(u, hashPassword(patch.password));
      delete u.invite;
      u.mustChange = true; // someone else set it: ask the user to choose their own
      this.endSessionsFor(u.id);
      this.clearFailures(u.username);
    }
    this.save();
    this.log('user-changed', { username: u.username, by: actor.username, changes: Object.keys(patch).filter(k => k !== 'password').concat(patch.password !== undefined ? ['password'] : []) });
    return this.publicUser(u);
  }

  changeOwnPassword(user, current, next) {
    const u = this.byId(user.id);
    if (String(current || '').length > MAX_FIELD) throw new AuthError('Your current password isn’t right.', 400);
    if (!checkPassword(u, current)) throw new AuthError('Your current password isn’t right.', 400);
    const problem = passwordProblem(next, u);
    if (problem) throw new AuthError(problem, 400);
    if (checkPassword(u, next)) throw new AuthError('Choose a password different from your current one.', 400);
    Object.assign(u, hashPassword(next), { mustChange: false });
    delete u.invite;
    this.endSessionsFor(u.id, user.token); // sign out everywhere else
    this.save();
    this.log('password-changed', { username: u.username });
  }

  /* ---------- two-step sign-in ---------- */
  /** Start setting up an authenticator app: a new secret, not active until a code confirms it. */
  start2fa(user, password) {
    const u = this.byId(user.id);
    // Replacing a working authenticator needs the password, so a stolen session can't take the account over.
    if (u.totp && u.totp.enabled && !checkPassword(u, password)) throw new AuthError('Enter your password to set up a new authenticator app.', 400);
    u.totpPending = { secret: base32(crypto.randomBytes(20)), created: Date.now() };
    this.save();
    const label = encodeURIComponent('Sumlora') + ':' + encodeURIComponent(u.username);
    return { secret: u.totpPending.secret, uri: `otpauth://totp/${label}?secret=${u.totpPending.secret}&issuer=${encodeURIComponent('Sumlora')}&algorithm=SHA1&digits=6&period=30` };
  }
  /** Confirm with a code from the app. Turns two-step sign-in on and returns one-time recovery codes. */
  confirm2fa(user, code) {
    const u = this.byId(user.id);
    if (!u.totpPending) throw new AuthError('Start again: choose Set up two-step sign-in.', 409);
    const st = matchStep(u.totpPending.secret, code);
    if (!st) throw new AuthError('That code isn’t right. Check the time on your phone is set automatically, then try the newest code.', 400);
    const recovery = newRecoveryCodes();
    const replacing = !!(u.totp && u.totp.enabled);
    u.totp = { secret: u.totpPending.secret, enabled: true, lastStep: st, recovery: recovery.map(sha256), since: Date.now() };
    delete u.totpPending;
    if (replacing) this.endSessionsFor(u.id, user.token);
    this.save();
    this.log('2fa-on', { username: u.username });
    return { recovery };
  }
  /** New recovery codes (the old ones stop working). Needs the current password. */
  newRecovery(user, password) {
    const u = this.byId(user.id);
    if (!checkPassword(u, password)) throw new AuthError('Your password isn’t right.', 400);
    if (!u.totp) throw new AuthError('Two-step sign-in isn’t on.', 409);
    const recovery = newRecoveryCodes();
    u.totp.recovery = recovery.map(sha256);
    this.endSessionsFor(u.id, user.token);
    this.save();
    this.log('recovery-codes-renewed', { username: u.username });
    return { recovery };
  }
  disable2fa(user, password) {
    const u = this.byId(user.id);
    if (!checkPassword(u, password)) throw new AuthError('Your password isn’t right.', 400);
    if (this.needs2fa(u)) throw new AuthError('Two-step sign-in is required for your account, so it can’t be turned off.', 409);
    delete u.totp; delete u.totpPending;
    this.endSessionsFor(u.id, user.token);
    this.save();
    this.log('2fa-off', { username: u.username });
  }
  /** A code from the app, or a recovery code (used once). */
  checkSecondStep(u, code) {
    const c = String(code || '').trim().toLowerCase();
    if (/^[0-9a-f]{5}-?[0-9a-f]{5}$/.test(c)) {
      const h = sha256(c.includes('-') ? c : c.slice(0, 5) + '-' + c.slice(5));
      const i = (u.totp.recovery || []).indexOf(h);
      if (i < 0) return false;
      u.totp.recovery.splice(i, 1);
      this.log('recovery-code-used', { username: u.username, left: u.totp.recovery.length });
      return true;
    }
    const st = matchStep(u.totp.secret, c);
    if (!st || st <= (u.totp.lastStep || 0)) return false; // each code works once
    u.totp.lastStep = st;
    return true;
  }

  /** Throws if the account is locked for this address (5 wrong tries), or for everyone (50 from all addresses). */
  checkLock(name, ip = '') {
    for (const key of [`${name}|${ip}`, name]) {
      const f = this.failures.get(key);
      if (f && f.until > Date.now()) {
        const mins = Math.ceil((f.until - Date.now()) / 60000);
        throw new AuthError(`Too many wrong tries. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`, 429);
      }
    }
  }
  /** Count a wrong password or code. Returns how many tries are left (from this address) before the lock. */
  fail(name, ip = '') {
    if (this.failures.size > 20000) { // keep memory bounded: forget finished locks and old counts
      const now = Date.now();
      for (const [k, f] of this.failures) if (!f.until || f.until < now) this.failures.delete(k);
      if (this.failures.size > 20000) this.failures.clear();
    }
    const bump = (key, limit) => {
      const f = this.failures.get(key);
      const n = (f && f.until && f.until <= Date.now() ? 0 : (f ? f.count : 0)) + 1; // a finished lock starts the count again
      this.failures.set(key, { count: n, until: n >= limit ? Date.now() + LOCK_MS : 0 });
      return n;
    };
    const total = bump(name, LOCK_TOTAL);
    const n = bump(`${name}|${ip}`, LOCK_AFTER);
    if (n === LOCK_AFTER || total === LOCK_TOTAL) this.log('locked', { username: name, ip, everywhere: total >= LOCK_TOTAL });
    return total >= LOCK_TOTAL ? 0 : LOCK_AFTER - n;
  }
  clearFailures(name) { for (const k of this.failures.keys()) if (k === name || k.startsWith(name + '|')) this.failures.delete(k); }

  /**
   * Check a username and password.
   * Returns { token } for a new session, or { ticket } when the account also needs a code from the authenticator app.
   */
  async login(username, password, meta = {}) {
    if (String(username || '').length > MAX_FIELD || String(password || '').length > MAX_FIELD) throw new AuthError('The username or password isn’t right.', 401);
    const name = cleanUsername(username);
    this.checkLock(name, meta.ip);
    const u = this.byName(name);
    const ok = (await checkPasswordAsync(u, password)) && !u.disabled;
    if (!ok) {
      const left = this.fail(name, meta.ip);
      this.log('login-failed', { username: name, ip: meta.ip, reason: u ? (u.disabled ? 'turned off' : 'wrong password') : 'no such user' });
      if (u && u.disabled) throw new AuthError('This account has been turned off. Ask the owner to turn it back on.', 403);
      throw new AuthError(left > 0 ? `The username or password isn’t right.${left <= 2 ? ` ${left} more tr${left === 1 ? 'y' : 'ies'} before the account is locked for 15 minutes.` : ''}` : 'Too many wrong tries. This account is locked for 15 minutes.', left > 0 ? 401 : 429);
    }
    const blocked = this.firmBlock(u);
    if (blocked) { this.log('login-blocked', { username: name, ip: meta.ip, reason: blocked }); throw new AuthError(blocked, 403); }
    if (u.totp && u.totp.enabled) {
      const ticket = crypto.randomBytes(24).toString('base64url');
      for (const [t, v] of this.tickets) if (Date.now() - v.created > TICKET_MS) this.tickets.delete(t);
      this.tickets.set(ticket, { userId: u.id, created: Date.now(), tries: 0 });
      return { ticket };
    }
    return { token: this.startSession(u, meta) };
  }
  /** Second step: the code for a ticket from login(). Returns a session token. */
  loginCode(ticket, code, meta = {}) {
    const t = this.tickets.get(ticket);
    if (!t || Date.now() - t.created > TICKET_MS) { this.tickets.delete(ticket); throw new AuthError('That took too long. Enter your password again.', 401, { restart: true }); }
    const u = this.byId(t.userId);
    if (!u || u.disabled || !u.totp || this.firmBlock(u)) { this.tickets.delete(ticket); throw new AuthError('Enter your password again.', 401, { restart: true }); }
    this.checkLock(u.username, meta.ip);
    if (!this.checkSecondStep(u, code)) {
      t.tries++;
      const left = this.fail(u.username, meta.ip);
      this.log('code-failed', { username: u.username, ip: meta.ip });
      if (t.tries >= 3 || left <= 0) this.tickets.delete(ticket);
      throw new AuthError(left <= 0 ? 'Too many wrong tries. This account is locked for 15 minutes.' : t.tries >= 3 ? 'Too many wrong codes. Enter your password again.' : 'That code isn’t right. Codes change every 30 seconds; use the newest one.', left <= 0 ? 429 : 401, t.tries >= 3 ? { restart: true } : {});
    }
    this.tickets.delete(ticket);
    return this.startSession(u, meta);
  }
  startSession(u, meta = {}) {
    this.clearFailures(u.username);
    u.lastLogin = Date.now();
    this.save();
    this.log('login', { username: u.username, ip: meta.ip, twoStep: !!(u.totp && u.totp.enabled) });
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { userId: u.id, created: Date.now(), lastSeen: Date.now() });
    return token;
  }

  logout(token) { this.sessions.delete(token); }
  /** End a user's sessions, except (optionally) the one they're using now. */
  endSessionsFor(userId, keepToken) { for (const [t, s] of this.sessions) if (s.userId === userId && t !== keepToken) this.sessions.delete(t); }

  /** The signed-in user for a request, or null. Refreshes the inactivity timer. */
  userFor(req, { touch = true } = {}) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const s = this.sessions.get(token);
    const now = Date.now();
    if (!s || now - s.lastSeen > this.idleMs || now - s.created > MAX_SESSION_MS) { if (s) this.sessions.delete(token); return null; }
    const u = this.byId(s.userId);
    if (!u || u.disabled || this.firmBlock(u)) { this.sessions.delete(token); return null; }
    if (touch) s.lastSeen = now;
    return { ...this.publicUser(u), token };
  }

  canSee(user, companyId) {
    if (user.role === 'owner') return true;
    if (user.role === 'client') return user.companies.includes(companyId);
    return !user.companies.length || user.companies.includes(companyId);
  }

  /** The user's own preferences (just the language for now). */
  setPrefs(user, { lang, theme }) {
    const u = this.byId(user.id);
    if (lang !== undefined) u.lang = lang === 'fr' ? 'fr' : 'en';
    if (theme !== undefined) u.theme = ['light', 'dark'].includes(theme) ? theme : 'auto';
    this.save();
    return this.publicUser(u);
  }

  setRequire2fa(v) {
    if (!['off', 'owners', 'everyone'].includes(v)) throw new AuthError('Choose off, owners or everyone.', 400);
    this.data.settings.require2fa = v;
    this.save();
  }

  setIdleMinutes(m) {
    const n = parseInt(m, 10);
    if (![5, 10, 15, 30, 60, 120, 240, 480].includes(n)) throw new AuthError('Choose one of the listed times.', 400);
    this.data.settings.idleMinutes = n;
    this.save();
  }
}

function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function sessionCookie(token, req, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}${maxAgeSec !== undefined ? `; Max-Age=${maxAgeSec}` : ''}`;
}

module.exports = { Auth, AuthError, sessionCookie, COOKIE, readCookie, MIN_PASSWORD, totp, base32, unbase32, matchStep };
