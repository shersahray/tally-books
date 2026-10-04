'use strict';
/* Licence codes for the desktop app.
 *
 * You (the seller) make a code for each client in your own Sumlora (the Licences page). A code says who
 * it's for, the plan (Essentials or Plus) and the last day it's good for, and it's signed with your private
 * key. The desktop app checks the signature with your public key, which the build puts in
 * electron/build-info.json, so it works without the internet and nobody else can make codes.
 *
 * A desktop copy with no code has a 30-day trial. When a licence ends, there are 14 more days to renew;
 * after that the books are view only: everything can still be opened, printed, exported and backed up,
 * but not changed, until a new code is entered. Books are never locked away.
 *
 * Licensing is only on when the app is given public keys (the installed, signed desktop app).
 * The server version (multi-firm) uses plans set on the Firms page instead.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIX = 'TB1-';
const TRIAL_DAYS = 30;
const GRACE_DAYS = 14;
const WARN_DAYS = 30;
const PLAN_CODES = { e: 'essentials', p: 'plus' };
const CODE_FOR_PLAN = { essentials: 'e', plus: 'p' };
// Who the licence is for: a bookkeeping firm (any number of client companies) or one business (one company).
const KINDS = { firm: 'f', business: 'b' };
const KIND_CODES = { f: 'firm', b: 'business' };

class LicenceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const b64u = buf => Buffer.from(buf).toString('base64url');
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
/** Today on this computer's calendar, as YYYY-MM-DD. */
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayNum = s => Math.round(Date.parse(s + 'T00:00:00Z') / 86400000);
const addDays = (s, n) => new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, data, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** A public key as text (the raw 32-byte Ed25519 key, base64url): what goes in the GitHub variable. */
const publicKeyText = keyObj => keyObj.export({ format: 'jwk' }).x;
function publicKeyFrom(text) {
  const x = String(text || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
  try { return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }); } catch { return null; }
}
function privateKeyFrom(jwk) {
  try { return crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, format: 'jwk' }); } catch { return null; }
}

/** Make a code. payload: { id, name, plan, until (YYYY-MM-DD), issued (YYYY-MM-DD), at (ms, when it was made) } */
function makeCode(payload, privateKey) {
  const body = Buffer.from(JSON.stringify({ v: 1, i: payload.id, n: payload.name, p: CODE_FOR_PLAN[payload.plan], u: payload.until, d: payload.issued, ...(payload.kind === 'business' ? { k: 'b' } : {}), ...(payload.at ? { t: Math.floor(payload.at / 1000) } : {}) }));
  const sig = crypto.sign(null, body, privateKey);
  return PREFIX + b64u(body) + '.' + b64u(sig);
}

/** Read and check a code against the public keys. Returns the licence, or throws a LicenceError. */
function readCode(code, publicKeys) {
  // Codes arrive by email: ignore spaces, line breaks and quotes picked up when copying.
  const c = String(code || '').replace(/[\s"'“”‘’<>]/g, '');
  if (!c) throw new LicenceError('Paste the licence code.');
  if (!c.startsWith(PREFIX) || c.length > 1200) throw new LicenceError('That isn’t a Sumlora licence code. Copy the whole code from the email, starting with TB1-.');
  const [bodyText, sigText, extra] = c.slice(PREFIX.length).split('.');
  if (!bodyText || !sigText || extra !== undefined) throw new LicenceError('That code is incomplete. Copy the whole code from the email.');
  let body, sig;
  try { body = Buffer.from(bodyText, 'base64url'); sig = Buffer.from(sigText, 'base64url'); } catch { throw new LicenceError('That code is incomplete. Copy the whole code from the email.'); }
  const keys = (publicKeys || []).map(k => (typeof k === 'string' ? publicKeyFrom(k) : k)).filter(Boolean);
  if (sig.length !== 64 || !keys.some(k => { try { return crypto.verify(null, body, k, sig); } catch { return false; } })) {
    throw new LicenceError('That code isn’t valid. Check that it was copied completely, or ask for a new one.');
  }
  let p;
  try { p = JSON.parse(body.toString('utf8')); } catch { throw new LicenceError('That code isn’t valid.'); }
  if (!p || p.v !== 1 || !PLAN_CODES[p.p] || !isDay(p.u) || typeof p.n !== 'string' || typeof p.i !== 'string') throw new LicenceError('That code is from a newer version of Sumlora. Update the app, then enter it again.');
  if (p.k !== undefined && !KIND_CODES[p.k]) throw new LicenceError('That code is from a newer version of Sumlora. Update the app, then enter it again.');
  // Codes made before licence types existed are firm licences.
  return { id: p.i, name: p.n, plan: PLAN_CODES[p.p], kind: KIND_CODES[p.k || 'f'], until: p.u, issued: isDay(p.d) ? p.d : '', ...(Number.isInteger(p.t) ? { at: p.t * 1000 } : {}) };
}

/**
 * This computer's licence: the code entered, when the app was first used (for the trial),
 * and the latest date seen (so turning the clock back doesn't bring a licence back).
 */
class Licence {
  /**
   * @param {object} [o.memo] A second place to remember the first day and the latest day seen (the books'
   *   own settings), so deleting licence.json doesn't start a new trial or undo the clock check: { get(), set(v) }.
   */
  constructor(dataDir, { publicKeys = [], now = () => new Date(), memo = null, trialDays = TRIAL_DAYS } = {}) {
    this.file = path.join(dataDir, 'licence.json');
    this.issuerFile = path.join(dataDir, 'licence-issuer.json');
    this.keys = publicKeys.map(publicKeyFrom).filter(Boolean);
    this.keyTexts = this.keys.map(publicKeyText);
    this.now = now;
    this.memo = memo;
    // 0: no trial, a code is needed from the start (set with the SUMLORA_TRIAL_DAYS build variable).
    this.trialDays = Number.isInteger(trialDays) && trialDays >= 0 && trialDays <= 365 ? trialDays : TRIAL_DAYS;
    this.data = readJson(this.file) || {};
    // Whichever place remembers more: the earliest first day and the latest day seen.
    const m = (memo && memo.get()) || {};
    if (isDay(m.firstDay) && (!isDay(this.data.firstDay) || m.firstDay < this.data.firstDay)) this.data.firstDay = m.firstDay;
    if (isDay(m.lastSeen) && (!isDay(this.data.lastSeen) || m.lastSeen > this.data.lastSeen)) this.data.lastSeen = m.lastSeen;
    this.issuerCache = { mtime: -1, ok: false };
  }
  get on() { return this.keys.length > 0; }
  save() {
    writeJson(this.file, this.data);
    if (this.memo) try { this.memo.set({ firstDay: this.data.firstDay, lastSeen: this.data.lastSeen }); } catch { /* the licence file still has it */ }
  }
  /** Today, never earlier than a day already seen on this computer. */
  today() {
    const t = localDay(this.now());
    if (!isDay(this.data.lastSeen) || t > this.data.lastSeen) { this.data.lastSeen = t; if (!this.data.firstDay) this.data.firstDay = t; this.save(); return t; }
    return this.data.lastSeen;
  }
  /** Is this the seller's own copy: it holds the private key that matches the build? */
  isIssuer() {
    let mtime = 0;
    try { mtime = fs.statSync(this.issuerFile).mtimeMs; } catch { return false; }
    if (this.issuerCache.mtime === mtime) return this.issuerCache.ok;
    // It must hold the private key itself: the public key from the private key, and a test signature that the build's key accepts.
    let ok = false;
    const k = readJson(this.issuerFile), priv = k && k.key && k.key.d && privateKeyFrom(k.key);
    if (priv) {
      try {
        const pub = crypto.createPublicKey(priv), x = publicKeyText(pub), probe = crypto.randomBytes(32);
        const sig = crypto.sign(null, probe, priv);
        ok = this.keyTexts.includes(x) && this.keys.some(key => crypto.verify(null, probe, key, sig));
      } catch { ok = false; }
    }
    this.issuerCache = { mtime, ok };
    return ok;
  }
  current() {
    if (!this.data.code) return null;
    try { return readCode(this.data.code, this.keys); } catch { return null; }
  }
  status() {
    if (!this.on) return { on: false, state: 'off', plan: null, canChange: true };
    const today = this.today();
    if (this.isIssuer()) return { on: true, state: 'issuer', plan: 'plus', kind: 'firm', canChange: true, name: '', until: '' };
    const lic = this.current();
    if (lic) {
      const left = dayNum(lic.until) - dayNum(today);
      const base = { on: true, name: lic.name, plan: lic.plan, kind: lic.kind, until: lic.until, id: lic.id, daysLeft: left };
      if (left >= 0) return { ...base, state: 'active', canChange: true, renewSoon: left < WARN_DAYS };
      if (-left <= GRACE_DAYS) return { ...base, state: 'grace', canChange: true, readOnlyFrom: addDays(lic.until, GRACE_DAYS + 1) };
      return { ...base, state: 'ended', canChange: false };
    }
    if (this.trialDays === 0) return { on: true, state: 'none', plan: 'plus', kind: 'firm', canChange: false, needCode: true };
    const first = this.data.firstDay || today;
    const trialUntil = addDays(first, this.trialDays - 1);
    const left = dayNum(trialUntil) - dayNum(today);
    if (left >= 0) return { on: true, state: 'trial', plan: 'plus', kind: 'firm', until: trialUntil, daysLeft: left, canChange: true };
    return { on: true, state: 'trial-ended', plan: 'plus', kind: 'firm', until: trialUntil, canChange: false };
  }
  /** Check a code without entering it: a LicenceError if it can't be used here. */
  check(code) {
    if (!this.on) throw new LicenceError('This copy of Sumlora doesn’t use licence codes.', 409);
    const lic = readCode(code, this.keys);
    const real = localDay(this.now());
    const today = isDay(this.data.lastSeen) && this.data.lastSeen > real && !(lic.issued && lic.issued >= this.data.lastSeen) ? this.data.lastSeen : real;
    if (dayNum(lic.until) + GRACE_DAYS < dayNum(today)) throw new LicenceError(`That code ended on ${lic.until}. Ask for a renewal code.`);
    return lic;
  }

  /**
   * Enter a code. The newest code wins: a code made before the one already here is refused, so an old email
   * can't replace a renewal or a corrected code.
   */
  enter(code) {
    if (!this.on) throw new LicenceError('This copy of Sumlora doesn’t use licence codes.', 409);
    const lic = readCode(code, this.keys);
    const cur = this.current();
    const madeAt = l => l.at || dayNum(l.issued || '1970-01-01') * 86400000;
    if (cur && cur.id !== lic.id && madeAt(lic) < madeAt(cur)) throw new LicenceError(`This computer already has a newer licence code, until ${cur.until}. Enter the latest code you were sent.`, 409);
    // A code made after the one here (or the first code) also resets the latest day seen, so a clock that once
    // jumped ahead can't lock out someone who has paid: the code's own date is signed, so it can be trusted.
    if (lic.issued && (!cur || madeAt(lic) > madeAt(cur))) {
      const real = localDay(this.now());
      this.data.lastSeen = real > lic.issued ? real : lic.issued;
      this.save();
    }
    const today = this.today();
    if (dayNum(lic.until) + GRACE_DAYS < dayNum(today)) throw new LicenceError(`That code ended on ${lic.until}. Ask for a renewal code.`);
    this.data.code = String(code).replace(/[\s"'“”‘’<>]/g, '');
    this.data.entered = Date.now();
    this.save();
    return lic;
  }
}

/**
 * The seller's side: the private key that signs codes, and the list of codes made.
 * Kept in licence-issuer.json in the data folder, readable only by this user.
 */
class Issuer {
  constructor(dataDir, { now = () => new Date() } = {}) {
    this.file = path.join(dataDir, 'licence-issuer.json');
    this.now = now;
  }
  load() { return readJson(this.file); }
  save(d) { writeJson(this.file, d, 0o600); try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ } }
  info() {
    const d = this.load();
    if (!d || !d.key) return { key: null, issued: [] };
    return { key: { publicKey: d.key.x, created: d.created }, issued: (d.issued || []).slice().reverse() };
  }
  createKey() {
    if (this.load()) throw new LicenceError('You already have a licence key. Making a new one would stop every code you’ve made from working in new versions.', 409);
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    this.save({ format: 'tally-books-licence-key', key: { x: jwk.x, d: jwk.d }, created: Date.now(), issued: [] });
    return this.info();
  }
  /** A copy of the key, to keep somewhere safe (a USB key, a password manager). */
  exportKey() {
    const d = this.load();
    if (!d || !d.key) throw new LicenceError('There’s no licence key yet.', 404);
    return d;
  }
  /** Bring back a key from a copy, for example on a new computer. The codes made before come with it. */
  importKey(body, { mustMatch } = {}) {
    if (!body || body.format !== 'tally-books-licence-key' || !body.key || !privateKeyFrom(body.key)) throw new LicenceError('That isn’t a copy of a Sumlora licence key.');
    const pub = publicKeyText(crypto.createPublicKey(privateKeyFrom(body.key)));
    if (pub !== body.key.x) throw new LicenceError('That key file is damaged.');
    if (mustMatch && !mustMatch.includes(pub)) throw new LicenceError('That key doesn’t match this version of Sumlora.', 409);
    const cur = this.load();
    if (cur && cur.key && cur.key.x !== pub) throw new LicenceError('There’s already a different licence key here.', 409);
    // Only well-formed entries come in with the key (they're shown on the Licence codes page).
    const clean = x => (x && typeof x === 'object' && /^[0-9a-f]{6,20}$/.test(x.id) && CODE_FOR_PLAN[x.plan] && isDay(x.until) && isDay(x.issued) && typeof x.code === 'string' && x.code.startsWith(PREFIX)
      ? { id: x.id, name: String(x.name || '').slice(0, 80), email: String(x.email || '').slice(0, 120), plan: x.plan, kind: KINDS[x.kind] ? x.kind : 'firm', until: x.until, issued: x.issued, note: String(x.note || '').slice(0, 200), code: x.code.slice(0, 1200), ...(/^[0-9a-f]{6,20}$/.test(x.renews) ? { renews: x.renews } : {}) }
      : null);
    const issued = Array.isArray(body.issued) ? body.issued.map(clean).filter(Boolean).slice(-5000) : [];
    if (cur && Array.isArray(cur.issued)) for (const x of cur.issued) if (!issued.some(y => y.code === x.code)) issued.push(x);
    this.save({ format: 'tally-books-licence-key', key: { x: pub, d: body.key.d }, created: Number(body.created) || Date.now(), issued });
    return this.info();
  }
  /** Make a code for a client. */
  make({ name, email, plan, until, note, renews, kind = 'firm' }) {
    const d = this.load();
    if (!d || !d.key) throw new LicenceError('Create your licence key first.', 409);
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) throw new LicenceError('Enter who the licence is for (the client’s business name).');
    if (!CODE_FOR_PLAN[plan]) throw new LicenceError('Choose one of the plans.');
    if (!KINDS[kind]) throw new LicenceError('Choose who the licence is for: a firm or one business.');
    if (!isDay(until)) throw new LicenceError('Enter the last day the licence is good for.');
    const today = localDay(this.now());
    if (until < today) throw new LicenceError('The end date has already passed.');
    if (dayNum(until) - dayNum(today) > 5 * 366) throw new LicenceError('A licence can last at most five years.');
    const id = crypto.randomBytes(5).toString('hex');
    const code = makeCode({ id, name, plan, kind, until, issued: today, at: this.now().getTime() }, privateKeyFrom(d.key));
    const rec = { id, name, email: String(email || '').trim().slice(0, 120), plan, kind, until, issued: today, note: String(note || '').trim().slice(0, 200), code, ...(renews ? { renews: String(renews).slice(0, 20) } : {}) };
    d.issued = [...(d.issued || []), rec];
    this.save(d);
    return rec;
  }
}

module.exports = { Licence, Issuer, LicenceError, KINDS, makeCode, readCode, publicKeyFrom, localDay, addDays, TRIAL_DAYS, GRACE_DAYS };
