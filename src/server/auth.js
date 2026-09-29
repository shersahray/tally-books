'use strict';
// Sign-in security: user accounts, password hashing, sessions, lockout and roles.
//
// - Passwords are hashed with scrypt and a per-user salt; the plain password is never stored.
// - A session is a random 32-byte token in an HttpOnly, SameSite=Strict cookie.
// - Sessions end after a period of inactivity (auto-lock) and after 12 hours regardless.
// - 5 wrong passwords for an account lock it for 15 minutes.
// - Roles: "owner" manages users, security and backups and sees every company;
//   "staff" works only in the companies they're given.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIE = 'tb_session';
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 10;

class AuthError extends Error {
  constructor(message, status = 401, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex') });

function checkPassword(user, password) {
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
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.data = { version: 1, users: [], settings: { idleMinutes: 30 } };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* first run */ }
    this.sessions = new Map(); // token -> { userId, created, lastSeen }
    this.failures = new Map(); // username -> { count, until }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  needsSetup() { return this.data.users.length === 0; }
  get idleMs() { return (this.data.settings.idleMinutes || 30) * 60 * 1000; }

  publicUser(u) {
    return u && { id: u.id, name: u.name, username: u.username, role: u.role, companies: u.companies || [], disabled: !!u.disabled, created: u.created, lastLogin: u.lastLogin || 0, mustChange: !!u.mustChange };
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

  addUser({ name, username, password, role = 'staff', companies = [], mustChange = false }) {
    name = String(name || '').trim().slice(0, 80);
    username = cleanUsername(username);
    if (!name) throw new AuthError('Enter a name.', 400);
    if (!/^[a-z0-9._@+-]{3,80}$/.test(username)) throw new AuthError('The username (or email) must be 3–80 characters: letters, numbers, and . _ @ + - only.', 400);
    if (this.byName(username)) throw new AuthError('That username is already taken.', 409);
    if (!['owner', 'staff'].includes(role)) throw new AuthError('Role must be owner or staff.', 400);
    const problem = passwordProblem(password, { username });
    if (problem) throw new AuthError(problem, 400);
    const u = { id: 'u_' + crypto.randomBytes(8).toString('hex'), name, username, role, companies: Array.isArray(companies) ? companies.map(String) : [], ...hashPassword(password), created: Date.now(), mustChange: !!mustChange };
    this.data.users.push(u);
    this.save();
    return this.publicUser(u);
  }

  updateUser(id, patch, actor) {
    const u = this.byId(id);
    if (!u) throw new AuthError('That user doesn’t exist.', 404);
    const owners = () => this.data.users.filter(x => x.role === 'owner' && !x.disabled);
    if (patch.name !== undefined) { const n = String(patch.name).trim().slice(0, 80); if (!n) throw new AuthError('Enter a name.', 400); u.name = n; }
    if (patch.role !== undefined) {
      if (!['owner', 'staff'].includes(patch.role)) throw new AuthError('Role must be owner or staff.', 400);
      if (u.role === 'owner' && patch.role !== 'owner' && owners().length <= 1) throw new AuthError('There must always be at least one owner.', 409);
      u.role = patch.role;
    }
    if (patch.companies !== undefined) u.companies = Array.isArray(patch.companies) ? patch.companies.map(String) : [];
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
  }

  /** Check a username and password. Returns a new session token. */
  login(username, password) {
    const name = cleanUsername(username);
    const f = this.failures.get(name);
    if (f && f.until > Date.now()) {
      const mins = Math.ceil((f.until - Date.now()) / 60000);
      throw new AuthError(`Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`, 429);
    }
    const u = this.byName(name);
    const ok = u && !u.disabled && checkPassword(u, password);
    if (!u) hashPassword(password); // take the same time whether or not the user exists
    if (!ok) {
      const n = (f && f.until && f.until <= Date.now() ? 0 : (f ? f.count : 0)) + 1; // a finished lock starts the count again
      this.failures.set(name, { count: n, until: n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
      if (u && u.disabled) throw new AuthError('This account has been turned off. Ask the owner to turn it back on.', 403);
      const left = LOCK_AFTER - n;
      throw new AuthError(left > 0 ? `The username or password isn’t right.${left <= 2 ? ` ${left} more tr${left === 1 ? 'y' : 'ies'} before the account is locked for 15 minutes.` : ''}` : 'Too many wrong passwords. This account is locked for 15 minutes.', left > 0 ? 401 : 429);
    }
    this.failures.delete(name);
    u.lastLogin = Date.now();
    this.save();
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

  canSee(user, companyId) { return user.role === 'owner' || !user.companies.length || user.companies.includes(companyId); }

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

module.exports = { Auth, AuthError, sessionCookie, COOKIE, readCookie, MIN_PASSWORD };
