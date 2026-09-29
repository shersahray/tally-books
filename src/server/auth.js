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
    this.data = { version: 1, users: [], settings: { idleMinutes: 30, require2fa: 'off' } };
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = { ...this.data, ...d, settings: { ...this.data.settings, ...(d.settings || {}) } }; } catch { /* first run */ }
    this.forced2fa = ['owners', 'everyone'].includes(opts.require2fa) ? opts.require2fa : 'off';
    this.sessions = new Map(); // token -> { userId, created, lastSeen }
    this.failures = new Map(); // username -> { count, until }
    this.tickets = new Map();  // half-finished sign-ins waiting for a code: ticket -> { userId, created, tries }
  }

  /** Append one line to the sign-in log (kept to about 5 MB, with one older file). */
  log(event, detail = {}) {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n';
      try { if (fs.statSync(this.logFile).size > LOG_MAX) fs.renameSync(this.logFile, this.logFile + '.1'); } catch { /* no log yet */ }
      fs.appendFileSync(this.logFile, line, { mode: 0o600 });
    } catch { /* logging must never stop a sign-in */ }
  }
  readLog(limit = 500) {
    let text = '';
    for (const f of [this.logFile + '.1', this.logFile]) { try { text += fs.readFileSync(f, 'utf8'); } catch { /* none */ } }
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
  get idleMs() { return (this.data.settings.idleMinutes || 30) * 60 * 1000; }

  publicUser(u) {
    if (!u) return u;
    const twoStep = !!(u.totp && u.totp.enabled);
    return { id: u.id, name: u.name, username: u.username, role: u.role, companies: u.companies || [], readOnly: !!u.readOnly, disabled: !!u.disabled, created: u.created, lastLogin: u.lastLogin || 0,
      mustChange: !!u.mustChange, twoStep, mustEnroll: !twoStep && this.needs2fa(u), invited: !u.hash, recoveryLeft: twoStep ? (u.totp.recovery || []).length : 0,
      linkPending: u.invite && u.invite.expires > Date.now() ? u.invite.kind : '' };
  }
  list() { return this.data.users.map(u => this.publicUser(u)); }
  byId(id) { return this.data.users.find(u => u.id === id); }
  byName(username) { return this.data.users.find(u => u.username === cleanUsername(username)); }

  /** First-time setup: create the owner account. Only works while there are no users. */
  setup({ name, username, password }) {
    if (!this.needsSetup()) throw new AuthError('Setup is already done. Sign in instead.', 409);
    const u = this.addUser({ name, username, password, role: 'owner' });
    return u;
  }

  addUser({ name, username, password, role = 'staff', companies = [], mustChange = false, readOnly = false, invite = false }) {
    name = String(name || '').trim().slice(0, 80);
    username = cleanUsername(username);
    if (!name) throw new AuthError('Enter a name.', 400);
    if (!/^[a-z0-9._@+-]{3,80}$/.test(username)) throw new AuthError('The username (or email) must be 3–80 characters: letters, numbers, and . _ @ + - only.', 400);
    if (this.byName(username)) throw new AuthError('That username is already taken.', 409);
    if (!ROLES.includes(role)) throw new AuthError('Role must be owner, staff or client.', 400);
    companies = Array.isArray(companies) ? companies.map(String) : [];
    if (role === 'client' && !companies.length) throw new AuthError('Choose the company this client can see.', 400);
    const u = { id: 'u_' + crypto.randomBytes(8).toString('hex'), name, username, role, companies, readOnly: role !== 'owner' && !!readOnly, created: Date.now() };
    let link = '';
    if (invite) { link = this.setLink(u, 'invite'); }
    else {
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
  issueLink(id) {
    const u = this.byId(id);
    if (!u) throw new AuthError('That user doesn’t exist.', 404);
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
    this.failures.delete(u.username);
    this.save();
    this.log(kind === 'invite' ? 'invite-accepted' : 'password-reset', { username: u.username });
    return u;
  }

  updateUser(id, patch, actor) {
    const u = this.byId(id);
    if (!u) throw new AuthError('That user doesn’t exist.', 404);
    const owners = () => this.data.users.filter(x => x.role === 'owner' && !x.disabled);
    if (patch.name !== undefined) { const n = String(patch.name).trim().slice(0, 80); if (!n) throw new AuthError('Enter a name.', 400); u.name = n; }
    if (patch.role !== undefined) {
      if (!ROLES.includes(patch.role)) throw new AuthError('Role must be owner, staff or client.', 400);
      if (u.role === 'owner' && patch.role !== 'owner' && owners().length <= 1) throw new AuthError('There must always be at least one owner.', 409);
      u.role = patch.role;
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
      if (u.disabled) this.endSessionsFor(u.id);
    }
    if (patch.password !== undefined) {
      const problem = passwordProblem(patch.password, u);
      if (problem) throw new AuthError(problem, 400);
      Object.assign(u, hashPassword(patch.password));
      u.mustChange = u.id !== actor.id; // someone else set it: ask the user to choose their own
      this.endSessionsFor(u.id);
      this.failures.delete(u.username);
    }
    this.save();
    this.log('user-changed', { username: u.username, by: actor.username, changes: Object.keys(patch).filter(k => k !== 'password').concat(patch.password !== undefined ? ['password'] : []) });
    return this.publicUser(u);
  }

  changeOwnPassword(user, current, next) {
    const u = this.byId(user.id);
    if (!checkPassword(u, current)) throw new AuthError('Your current password isn’t right.', 400);
    const problem = passwordProblem(next, u);
    if (problem) throw new AuthError(problem, 400);
    if (checkPassword(u, next)) throw new AuthError('Choose a password different from your current one.', 400);
    Object.assign(u, hashPassword(next), { mustChange: false });
    this.save();
    this.log('password-changed', { username: u.username });
  }

  /* ---------- two-step sign-in ---------- */
  /** Start setting up an authenticator app: a new secret, not active until a code confirms it. */
  start2fa(user) {
    const u = this.byId(user.id);
    u.totpPending = { secret: base32(crypto.randomBytes(20)), created: Date.now() };
    this.save();
    const label = encodeURIComponent('Tally Books') + ':' + encodeURIComponent(u.username);
    return { secret: u.totpPending.secret, uri: `otpauth://totp/${label}?secret=${u.totpPending.secret}&issuer=${encodeURIComponent('Tally Books')}&algorithm=SHA1&digits=6&period=30` };
  }
  /** Confirm with a code from the app. Turns two-step sign-in on and returns one-time recovery codes. */
  confirm2fa(user, code) {
    const u = this.byId(user.id);
    if (!u.totpPending) throw new AuthError('Start again: choose Set up two-step sign-in.', 409);
    const st = matchStep(u.totpPending.secret, code);
    if (!st) throw new AuthError('That code isn’t right. Check the time on your phone is set automatically, then try the newest code.', 400);
    const recovery = newRecoveryCodes();
    u.totp = { secret: u.totpPending.secret, enabled: true, lastStep: st, recovery: recovery.map(sha256), since: Date.now() };
    delete u.totpPending;
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
    this.save();
    return { recovery };
  }
  disable2fa(user, password) {
    const u = this.byId(user.id);
    if (!checkPassword(u, password)) throw new AuthError('Your password isn’t right.', 400);
    if (this.needs2fa(u)) throw new AuthError('Two-step sign-in is required for your account, so it can’t be turned off.', 409);
    delete u.totp; delete u.totpPending;
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

  /** Throws if the account is locked. */
  checkLock(name) {
    const f = this.failures.get(name);
    if (f && f.until > Date.now()) {
      const mins = Math.ceil((f.until - Date.now()) / 60000);
      throw new AuthError(`Too many wrong tries. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`, 429);
    }
    return f;
  }
  /** Count a wrong password or code. Returns how many tries are left before the lock. */
  fail(name) {
    const f = this.failures.get(name);
    const n = (f && f.until && f.until <= Date.now() ? 0 : (f ? f.count : 0)) + 1; // a finished lock starts the count again
    this.failures.set(name, { count: n, until: n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
    if (n >= LOCK_AFTER) this.log('locked', { username: name });
    return LOCK_AFTER - n;
  }

  /**
   * Check a username and password.
   * Returns { token } for a new session, or { ticket } when the account also needs a code from the authenticator app.
   */
  login(username, password, meta = {}) {
    const name = cleanUsername(username);
    this.checkLock(name);
    const u = this.byName(name);
    const ok = u && !u.disabled && checkPassword(u, password);
    if (!u) hashPassword(password); // take the same time whether or not the user exists
    if (!ok) {
      const left = this.fail(name);
      this.log('login-failed', { username: name, ip: meta.ip, reason: u ? (u.disabled ? 'turned off' : 'wrong password') : 'no such user' });
      if (u && u.disabled) throw new AuthError('This account has been turned off. Ask the owner to turn it back on.', 403);
      throw new AuthError(left > 0 ? `The username or password isn’t right.${left <= 2 ? ` ${left} more tr${left === 1 ? 'y' : 'ies'} before the account is locked for 15 minutes.` : ''}` : 'Too many wrong tries. This account is locked for 15 minutes.', left > 0 ? 401 : 429);
    }
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
    if (!u || u.disabled || !u.totp) { this.tickets.delete(ticket); throw new AuthError('Enter your password again.', 401, { restart: true }); }
    this.checkLock(u.username);
    if (!this.checkSecondStep(u, code)) {
      t.tries++;
      const left = this.fail(u.username);
      this.log('code-failed', { username: u.username, ip: meta.ip });
      if (t.tries >= 3 || left <= 0) this.tickets.delete(ticket);
      throw new AuthError(left <= 0 ? 'Too many wrong tries. This account is locked for 15 minutes.' : t.tries >= 3 ? 'Too many wrong codes. Enter your password again.' : 'That code isn’t right. Codes change every 30 seconds; use the newest one.', left <= 0 ? 429 : 401, t.tries >= 3 ? { restart: true } : {});
    }
    this.tickets.delete(ticket);
    return this.startSession(u, meta);
  }
  startSession(u, meta = {}) {
    this.failures.delete(u.username);
    u.lastLogin = Date.now();
    this.save();
    this.log('login', { username: u.username, ip: meta.ip, twoStep: !!(u.totp && u.totp.enabled) });
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { userId: u.id, created: Date.now(), lastSeen: Date.now() });
    return token;
  }

  logout(token) { this.sessions.delete(token); }
  endSessionsFor(userId) { for (const [t, s] of this.sessions) if (s.userId === userId) this.sessions.delete(t); }

  /** The signed-in user for a request, or null. Refreshes the inactivity timer. */
  userFor(req, { touch = true } = {}) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const s = this.sessions.get(token);
    const now = Date.now();
    if (!s || now - s.lastSeen > this.idleMs || now - s.created > MAX_SESSION_MS) { if (s) this.sessions.delete(token); return null; }
    const u = this.byId(s.userId);
    if (!u || u.disabled) { this.sessions.delete(token); return null; }
    if (touch) s.lastSeen = now;
    return { ...this.publicUser(u), token };
  }

  canSee(user, companyId) {
    if (user.role === 'owner') return true;
    if (user.role === 'client') return user.companies.includes(companyId);
    return !user.companies.length || user.companies.includes(companyId);
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
