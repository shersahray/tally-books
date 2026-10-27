'use strict';
const zlib = require('node:zlib');
// HTTP server: JSON API + static files. No third-party dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { COLLECTIONS } = require('./db');
const { Registry } = require('./companies');
const { Backups } = require('./backups');
const { AI } = require('./ai');
const { YearEndUsage } = require('./usage');
const assistant = require('./assistant');
const mail = require('./mail');
const stripe = require('./stripe');
const { Plaid, applyChanges: applyFeed, feedTwin } = require('./plaid');
const { Ledgers } = require('./ledgers');
const escHtml = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const inbound = require('./inbound');
const { TERMS_VERSION, TERMS_DRAFT } = require('./legal');
const { Billing, paid: billingPaid, stale: billingStale, describe: billingDescribe } = require('./billing');
const { Auth, AuthError, sessionCookie, readCookie, COOKIE } = require('./auth');
const employeeAuth = require('./employee-auth');
const { Licence, Issuer, localDay, addDays } = require('./licence');
const { validateRecord, checkDocumentPostings, checkDelete, validateCompany, bankAccount, isDate, ValidationError, settledOn } = require('./validate');
const { seedDefaults, exampleRecords, DEFAULT_COMPANY, PROVINCES } = require('./seed');
const DEP = require('../../public/deposits-calc.js');
const DELAYED = require('../../public/delayed-calc.js');
const ENGAGE = require('../../public/engagements-calc.js');
const dayBeforeIso = s => { const d = new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

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
 * @param {Function} [opts.stripeFetch]    Tests only: answers in place of Stripe's API.
 * @param {string}  [opts.publicUrl]       The address people sign in at (https://app.sumlora.ca), for links in "Forgot your password?" emails.
 * @param {boolean} [opts.mailInsecureTls] Tests only: accept the test mail server's certificate.
 * @param {boolean} [opts.mailAllowLocal]  Tests only: allow a mail server on this computer or the local network.
 * @param {string} [opts.aiKey]     Claude API key for AI suggestions (otherwise an owner enters one in Settings).
 * @param {object} [opts.plaid]     Plaid keys for bank feeds: { clientId, secret, env } (otherwise the administrator enters them in Settings).
 * @param {Function} [opts.plaidFetch] Tests only: answers in place of Plaid's API.
 * @param {Function} [opts.ledgerFetch] Tests only: answers in place of QuickBooks Online's and Xero's APIs (with opts.ledgerUrls).
 * @param {boolean} [opts.autoFeeds] Sync bank feeds every few hours (default true; tests turn it off).
 * @param {boolean} [opts.autoWorkflows] Check workflow reminders every hour (default true; tests turn it off).
 * @param {Function} [opts.billingFetch] Tests only: answers in place of Stripe's API for Sumlora subscriptions.
 * @param {boolean} [opts.requireTerms] People must agree to the Terms of service and Privacy policy before using Sumlora (the server and the desktop app turn this on).
 * @param {string} [opts.licenceDir]  Where the licence is kept (the desktop app's own folder, so it stays with the computer, not the books).
 * @param {number} [opts.licenceTrialDays] Days of free trial before a code is needed (default 30; 0 = a code from the start).
 * @param {string[]} [opts.licenceKeys] Public keys that sign licence codes (the installed desktop app): turns licensing on.
 * @param {string} [opts.setupCode]   If set, creating the first owner account needs this code (so a stranger can't claim a new server).
 */
function createApp(opts) {
  const reg = new Registry(opts.dataDir);
  const stripeFetch = opts.stripeFetch || ((...a) => fetch(...a)); // tests pass a stand-in for Stripe
  /** The Customer deposits account (a current liability), made the first time a deposit comes in online. Same rule as the app's depAccount(). */
  const depAccount = ctx => {
    const all = ctx.store.list('accounts');
    const have = all.find(a => a.detail === 'custdep' && a.active !== false) || all.find(a => a.detail === 'custdep');
    if (have) return have.id;
    const named = all.find(a => a.type === 'Liability' && !a.detail && DEP.NAME_RE.test(a.name));
    if (named) { applyWrite(ctx.store, { op: 'set', collection: 'accounts', id: named.id, data: { ...named, detail: 'custdep' } }, ctx.user, ctx); return named.id; }
    const id = all.some(a => a.id === 'a2345') ? crypto.randomUUID() : 'a2345';
    const fr = (ctx.store.getSetting('company') || {}).lang === 'fr';
    applyWrite(ctx.store, { op: 'set', collection: 'accounts', id, data: { code: all.some(a => a.code === '2345') ? '' : '2345', name: fr ? 'Dépôts des clients' : 'Customer deposits', type: 'Liability', detail: 'custdep', active: true, desc: DEP.ACCOUNT_DESC } }, ctx.user, ctx);
    return id;
  };
  /** Every Stripe link an invoice has had (the current one included); closedAt marks the current one as turned off. */
  const payLinkList = (d, closedAt) => {
    const list = (Array.isArray(d.payLinks) ? d.payLinks : []).slice(-30);
    if (d.payLink && d.payLink.id && !list.some(l => l.id === d.payLink.id)) list.push({ id: d.payLink.id, cents: d.payLink.cents, created: d.payLink.created });
    return closedAt && d.payLink ? list.map(l => (l.id === d.payLink.id && !l.closed ? { ...l, closed: closedAt } : l)) : list;
  };
  const auth = new Auth(opts.dataDir, { require2fa: opts.require2fa });
  reg.adoptFirm(auth.mainFirmId);
  // Seed, Grow and Thrive (plans.js): a company that already has employees or pay runs gets the Payroll add-on, so it keeps
  // payroll whatever plan its firm is on. Firms keeping an old price aren't billed for it until the administrator says so
  // (addonBilled below). Done once, when the server first starts with this version.
  if (!reg.data.payrollAddonDone) {
    for (const c of reg.list()) {
      if (c.payroll !== undefined) continue;
      try { const st = reg.store(c.id); if (st && (st.list('employees').length || st.list('payruns').length)) c.payroll = true; } catch { /* a damaged file is left as it is */ }
    }
    reg.data.payrollAddonDone = true;
    reg.save();
  }
  // Desktop licence codes (licence.js). With a licence, its plan is the plan for everything in this copy.
  // The first day and latest day seen are also kept with the books (users.json), so deleting licence.json doesn't start a new trial.
  const licence = new Licence(opts.licenceDir || opts.dataDir, { publicKeys: opts.licenceKeys || [], now: opts.now, trialDays: opts.licenceTrialDays,
    memo: { get: () => auth.data.settings.licenceDays, set: v => { const c = auth.data.settings.licenceDays || {}; if (c.firstDay !== v.firstDay || c.lastSeen !== v.lastSeen) { auth.data.settings.licenceDays = v; auth.save(); } } } });
  const issuer = new Issuer(opts.licenceDir || opts.dataDir, { now: opts.now });
  const licencePlan = () => (licence.on ? licence.status().plan : null);
  auth.planOverride = licencePlan;
  /** Desktop licences limit companies: one for a single business; for a firm, its number of active client companies. */
  const checkCompanyLimit = ({ restoring = false } = {}) => {
    if (!licence.on) return;
    const st = licence.status();
    if (st.kind === 'business' && !restoring && reg.list().length >= 1) throw new ValidationError('This licence is for one business, so it has one company. To keep books for more companies, ask for a firm licence.', 403);
    if (st.kind === 'firm' && st.maxCompanies && reg.list().filter(c => !c.archived).length >= st.maxCompanies) {
      throw new ValidationError(`This licence covers up to ${st.maxCompanies} client companies, and all ${st.maxCompanies} are in use. Archive a company you no longer work on, or ask for a licence with more companies.`, 403);
    }
  };
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
  const IND = require('../../public/industries.js');
  const ROLES = require('../../public/roles.js');
  const APPROVALS = require('../../public/approvals.js');
  /* Custom roles (public/roles.js): a staff member with one of the firm's own roles sees and changes only
     the areas it allows. Owners, plain staff and clients have no perms, so nothing here limits them. */
  const canArea = (user, area, level = 'view') => !(user && user.perms) || ROLES.can(user.perms, area, level);
  const needArea = (user, area, level = 'edit') => {
    if (!canArea(user, area, level)) throw new ValidationError(level === 'edit' ? `Your role doesn’t allow changes in ${ROLES.AREAS[area].label}.` : `Your role doesn’t include ${ROLES.AREAS[area].label}.`, 403);
  };
  /** Every area at this level (for things that touch the whole books, like a backup or example data). */
  /** Edit in the areas a write touches (roles.js writeAreas; a list there means any one of them). */
  const needWrite = (user, col, data, prev) => { for (const a of ROLES.writeAreas(col, data, prev)) { const any = Array.isArray(a) ? a : [a]; if (!any.some(x => canArea(user, x, 'edit'))) needArea(user, any[0], 'edit'); } };
  const needAllAreas = (user, level) => { for (const a of Object.keys(ROLES.AREAS)) needArea(user, a, level); };
  /**
   * Add-ons that bring a plan feature (payroll on Seed or Grow) for this company. A desktop licence's plan decides
   * everything there (add-ons aren't sold with licence codes), so they bring nothing on a licensed copy.
   */
  const featureAddons = c => (licence.on || !c ? {} : Object.fromEntries(Object.entries(PLANS.ADDONS).filter(([, a]) => a.feature).map(([k]) => [k, !!c[k]])));
  /** Is a plan feature on for this company: in its firm's plan (or an add-on), and not switched off in its settings? */
  const featureOn = (cid, key, store) => {
    const c = reg.get(cid), f = c && auth.firm(c.firmId);
    const settings = (store || reg.store(cid)).getSetting('company') || {};
    return PLANS.featureOn(licencePlan() || (f ? f.plan : 'thrive'), settings.features, key, featureAddons(c), f && f.early);
  };
  /** In the plan or an add-on, whatever the company's own switches say (for "can it be used at all?"). */
  const companyHas = (cid, key) => { const c = reg.get(cid), f = c && auth.firm(c.firmId); return PLANS.hasFeature(licencePlan() || (f ? f.plan : 'thrive'), key, featureAddons(c), f && f.early); };
  const needAddon = (cid, key) => {
    if (!(reg.get(cid) || {})[key]) throw new ValidationError(`The ${PLANS.ADDONS[key].label} add-on isn’t on for this company. An owner can add it in Settings.`, 403);
  };
  const needFeature = (cid, key, store) => {
    if (featureOn(cid, key, store)) return;
    if (PLANS.comingSoon(key) && !companyHas(cid, key)) throw new ValidationError(`${PLANS.FEATURES[key].label} is coming soon to Sumlora. It isn’t available yet.`, 403);
    // Payroll on Seed or Grow: say how to get it (the add-on), not just that it's missing.
    if (key === 'payroll' && !licence.on && !companyHas(cid, key)) throw new ValidationError('Payroll isn’t part of this company’s plan. An owner can add the Payroll add-on in Settings → Features.', 403);
    throw new ValidationError(`${PLANS.FEATURES[key].label} isn’t part of this company’s plan.`, 403);
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
  /* ---------- Paying for Sumlora (online server; nothing changes until the administrator adds a Stripe key) ---------- */
  const billing = new Billing(opts.licenceDir || opts.dataDir, { fetch: opts.billingFetch });
  /* Bank of Canada exchange rates, cached for a day (past dates don't change). */
  const fxCache = new Map();
  async function fxRate(cur, date) {
    const k = cur + '|' + date, hit = fxCache.get(k);
    if (hit && (hit.final || Date.now() - hit.at < 3600e3)) return hit.v;
    const start = new Date(Date.parse(date + 'T12:00:00Z') - 10 * 864e5).toISOString().slice(0, 10);
    const url = `https://www.bankofcanada.ca/valet/observations/FX${cur}CAD/json?start_date=${start}&end_date=${date}`;
    let j;
    try { const r = await (opts.fxFetch || fetch)(url, { headers: { Accept: 'application/json' } }); if (r.status === 404) throw Object.assign(new Error('nf'), { nf: true }); if (!r.ok) throw new Error('http ' + r.status); j = await r.json(); }
    catch (e) { throw new ValidationError(e.nf ? `The Bank of Canada doesn’t publish a rate for ${cur}. Enter the rate yourself.` : 'The Bank of Canada couldn’t be reached. Enter the rate yourself, or try again.', 502); }
    const obs = (j.observations || []).filter(o => o.d <= date && o['FX' + cur + 'CAD'] && o['FX' + cur + 'CAD'].v).sort((a, b) => a.d.localeCompare(b.d));
    const last = obs[obs.length - 1];
    if (!last) throw new ValidationError(`No Bank of Canada rate for ${cur} around that date. Enter the rate yourself.`, 404);
    const v = { cur, date: last.d, rate: Number(last['FX' + cur + 'CAD'].v), source: 'Bank of Canada' };
    fxCache.set(k, { v, at: Date.now(), final: last.d === date || date < new Date().toISOString().slice(0, 10) });
    if (fxCache.size > 5000) fxCache.clear();
    return v;
  }
  /* The server's own mailbox, for invitation and password reset emails (set by the administrator).
     Kept in sysmail.json next to the server's other private settings, readable only by the server's account. */
  const sysMailFile = path.join(opts.licenceDir || opts.dataDir, 'sysmail.json');
  const sysMail = { get() { try { return JSON.parse(fs.readFileSync(sysMailFile, 'utf8')); } catch { return null; } },
    set(m) { const tmp = sysMailFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m || {}), { mode: 0o600 }); fs.renameSync(tmp, sysMailFile); try { fs.chmodSync(sysMailFile, 0o600); } catch { /* Windows */ } } };
  const sysMailSent = new Map(); // firm|day -> emails sent through the server's mailbox
  /**
   * The address reset links in "Forgot your password?" emails point to: PUBLIC_URL if it's set, otherwise the address the
   * administrator uses when setting up (or looking at) the mailbox. Never the address in a stranger's request, which they
   * could make up to send people a link to their own site.
   */
  const appUrl = () => { try { const v = opts.publicUrl || (sysMail.get() || {}).appUrl || ''; return v ? new URL(v).origin : ''; } catch { return ''; } };
  const forgotReady = () => { const c = sysMail.get(); return !!(c && c.host && appUrl()); };
  const forgotByIp = new Map(); // address|hour -> reset requests
  /** The "Forgot your password?" email, in the person's own language. */
  const forgotEmail = (u, url) => {
    const first = String(u.name || '').split(' ')[0] || u.username;
    if (u.lang === 'fr') return { subject: 'Réinitialiser votre mot de passe Sumlora', text: `Bonjour ${first},\n\nQuelqu’un (probablement vous) a demandé à réinitialiser le mot de passe de votre compte Sumlora. Ouvrez ce lien pour choisir un nouveau mot de passe (il fonctionne une fois, pendant une heure) :\n\n${url}\n\nVotre nom d’utilisateur est ${u.username}.\n\nSi vous n’avez rien demandé, ignorez ce courriel : votre mot de passe ne change pas.\n` };
    return { subject: 'Reset your Sumlora password', text: `Hi ${first},\n\nSomeone (probably you) asked to reset the password for your Sumlora account. Open this link to choose a new password (it works once, for one hour):\n\n${url}\n\nYour username is ${u.username}.\n\nIf you didn’t ask for this, ignore this email: your password stays the same.\n` };
  };
  const firmExempt = fid => fid === auth.mainFirmId;            // the server owner's own firm doesn't pay itself
  const firmNeedsPay = f => billing.configured() && !!f && f.status === 'active' && !firmExempt(f.id) && !billingPaid(f.billing);
  const coNeedsPay = c => billing.configured() && !!c && c.payer === 'client' && !billingPaid(c.billing);
  /** Companies a firm pays for: the ones it keeps that aren't archived and whose client doesn't pay. At least one. */
  const firmCount = fid => Math.max(1, reg.list(fid).filter(c => !c.archived && c.payer !== 'client').length);
  /** The plan a company is paid for on, and the old price it keeps (if any): the client's own, or its firm's. */
  const payPlan = c => { const f = auth.firm(c.firmId) || {}; return c.payer === 'client' ? { plan: PLANS.planOf(c.clientPlan || f.plan), legacy: c.clientLegacy || '' } : { plan: PLANS.planOf(f.plan), legacy: f.legacy || '' }; };
  /**
   * Is a company billed for an add-on it has on? Not when its plan already includes it (payroll's base fee on Thrive),
   * and not payroll at all for a firm keeping an old price, until the administrator turns payroll billing on.
   */
  const addonBilled = (c, key) => {
    if (!c[key]) return false;
    const { plan, legacy } = payPlan(c);
    if (PLANS.addonIncluded(plan, key)) return false;
    if (key === 'payroll' && legacy && !(auth.firm(c.firmId) || {}).billPayroll) return false;
    return true;
  };
  /** Is a company billed for each employee it pays (payroll in its plan or add-on, and not kept free on an old price)? */
  const employeesBilled = c => {
    const { plan, legacy } = payPlan(c);
    if (!PLANS.hasFeature(plan, 'payroll', { payroll: !!c.payroll })) return false;
    return !(legacy && !(auth.firm(c.firmId) || {}).billPayroll);
  };
  /** Employees paid in a month (YYYY-MM) in these companies, for those billed for them. */
  const employeesPaidIn = (list, month) => list.filter(employeesBilled).reduce((t, c) => { const st = reg.store(c.id); return t + (st ? PLANS.employeesPaid(st.list('payruns'), month) : 0); }, 0);
  /** Of those, the companies billed for an add-on (the AI assistant, the scrap yard tools, payroll…). */
  const firmAddons = (fid, key) => reg.list(fid).filter(c => !c.archived && c.payer !== 'client' && addonBilled(c, key)).length;
  const firmAssistants = fid => firmAddons(fid, 'assistant');
  /** How many companies are billed for each add-on, for a subscription: { assistant: 2, scrapyard: 1, payroll: 0 }. */
  const addonCounts = list => Object.fromEntries(Object.keys(PLANS.ADDONS).map(k => [k, list.filter(c => addonBilled(c, k)).length]));
  /** The address people come back to after Stripe's pages. */
  const originOf = req => {
    const proto = (opts.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || (req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:\[\]-]/g, '');
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  };
  /** A firm's plan or price changed: its subscription's plan line moves to the new price, and its add-ons follow. */
  async function syncFirmPlan(fid) {
    const f = auth.firm(fid);
    if (!billing.configured() || !f || firmExempt(fid) || !f.billing || !billingPaid(f.billing)) return;
    try { auth.setFirmBilling(fid, await billing.setPlan(f.billing, PLANS.priceKey(f.plan, f.legacy), f.plan)); } catch (e) { console.error('Sumlora subscription: couldn’t change the plan:', e.message); }
    await syncFirmCount(fid);
  }
  /**
   * Payroll's charge for each employee paid in a month, added to each subscription's next invoice once the month is over.
   * Runs with the twice-daily check; each subscription remembers the last month charged, so a month is never charged twice.
   * A free trial doesn't pay for employees, and nor does the month before a subscription started.
   */
  async function chargePayrollEmployees(now = new Date()) {
    if (!billing.configured()) return;
    const month = PLANS.prevMonth(now.toISOString().slice(0, 10));
    const charge = async (rec, list, save) => {
      if (!rec || !rec.sub || !billingPaid(rec) || rec.employeesBilled === month) return;
      if (rec.employeesBilled === undefined) { save({ ...rec, employeesBilled: month }); return; } // started before this charge existed
      if (rec.status === 'trialing') { save({ ...rec, employeesBilled: month, employees: { month, count: 0 } }); return; }
      try { save(await billing.chargeEmployees(rec, month, employeesPaidIn(list, month))); } catch (e) { console.error('Sumlora subscription: couldn’t charge payroll employees:', e.message); }
    };
    for (const f of auth.data.firms) {
      if (f.status !== 'active' || firmExempt(f.id)) continue;
      await charge(f.billing, reg.list(f.id).filter(c => c.payer !== 'client'), rec => auth.setFirmBilling(f.id, rec));
    }
    for (const c of reg.list()) if (c.payer === 'client') await charge(c.billing, [c], rec => reg.update(c.id, { billing: rec }));
  }
  /** Keep a firm's subscription at its number of companies (quietly: a Stripe hiccup is retried at the next change or check). */
  async function syncFirmCount(fid) {
    const f = auth.firm(fid);
    if (!billing.configured() || !f || firmExempt(fid) || !f.billing || !billingPaid(f.billing)) return;
    try { auth.setFirmBilling(fid, await billing.setQuantity(f.billing, firmCount(fid))); } catch (e) { console.error('Sumlora subscription: couldn’t update the number of companies:', e.message); }
    // Add-ons on sale, plus any still on the subscription that aren't sold any more (payroll while it's coming soon), taken off.
    const dropped = Object.keys((f.billing && f.billing.addons) || {}).filter(k => !PLANS.ADDONS[k]);
    for (const k of [...Object.keys(PLANS.ADDONS), ...dropped]) {
      try { auth.setFirmBilling(fid, await billing.setAddon(auth.firm(fid).billing, k, PLANS.ADDONS[k] ? firmAddons(fid, k) : 0)); } catch (e) { console.error(`Sumlora subscription: couldn’t update the ${(PLANS.ADDONS[k] || { label: k }).label} add-on:`, e.message); }
    }
  }
  /**
   * Turn an add-on (plans.js ADDONS) on or off for a company, and keep the subscription that pays for it in step.
   * Turning it on must reach Stripe first (so it isn't used unpaid); turning it off never waits on Stripe.
   * No Stripe key, the server owner's own firm, or a subscription not started yet: just the switch
   * (a subscription started later includes the add-on).
   */
  async function setAddonFor(cid, key, on) {
    const c = reg.get(cid), f = auth.firm(c.firmId);
    if (!!c[key] === on) return;
    if (on && PLANS.ADDONS[key].feature && licence.on) throw new ValidationError(`With a licence code, ${PLANS.FEATURES[PLANS.ADDONS[key].feature].label.toLowerCase()} comes with the plan in the code.`, 409);
    const clientPays = c.payer === 'client';
    const rec = clientPays ? c.billing : f && f.billing;
    const billed = billing.configured() && !(clientPays ? false : firmExempt(c.firmId)) && rec && rec.sub && billingPaid(rec);
    // Included in the plan (payroll on Thrive) or kept free on an old price: just the switch.
    if (!billed || (on && !addonBilled({ ...c, [key]: true }, key))) { reg.update(cid, { [key]: on }); return; }
    if (on) {
      const next = await billing.setAddon(rec, key, clientPays ? 1 : firmAddons(c.firmId, key) + (c.archived ? 0 : 1));
      reg.update(cid, { [key]: true });
      if (clientPays) reg.update(cid, { billing: next }); else auth.setFirmBilling(c.firmId, next);
      return;
    }
    reg.update(cid, { [key]: false });
    if (clientPays) { try { reg.update(cid, { billing: await billing.setAddon(rec, key, 0) }); } catch (e) { console.error(`Sumlora subscription: couldn’t remove the ${PLANS.ADDONS[key].label} add-on:`, e.message); } }
    else await syncFirmCount(c.firmId);
  }
  const setAssistant = (cid, on) => setAddonFor(cid, 'assistant', on);
  /** Can people in this company ask the AI assistant, and how many questions are left this month? */
  function assistantInfo(cid, store) {
    const c = reg.get(cid);
    if (!c || !c.assistant) return { on: false };
    const cap = Number(ai.settings.assistantCap ?? assistant.DEFAULT_CAP), used = Number(store.getMeta('assistant-q:' + assistant.month(Date.now())) || 0);
    return { on: true, ready: ai.status().configured, used, cap, left: Math.max(0, cap - used) };
  }
  /** Read subscriptions again from Stripe when they're a few hours old (or all of them, for the twice-daily check). */
  async function refreshBilling(firmIds, companyIds, all) {
    if (!billing.configured()) return;
    for (const fid of firmIds) {
      const f = auth.firm(fid);
      if (f && f.billing && (all || billingStale(f.billing))) { try { auth.setFirmBilling(fid, await billing.refresh(f.billing)); } catch { /* try again later */ } }
    }
    for (const cid of companyIds) {
      const c = reg.get(cid);
      if (c && c.billing && (all || billingStale(c.billing))) { try { reg.update(cid, { billing: await billing.refresh(c.billing) }); } catch { /* try again later */ } }
    }
  }
  // Terms of service and Privacy policy: has this person agreed to the current version?
  const requireTerms = !!opts.requireTerms;
  const termsOk = u => !requireTerms || !!(u && u.terms && u.terms.v === TERMS_VERSION);
  const needAgreement = body => { if (requireTerms && body.acceptTerms !== true) throw new ValidationError('Tick the box to agree to the Terms of service and Privacy policy.'); };
  const notClient = u => { if (u.role === 'client') throw new ValidationError('Only your bookkeeper can do that.', 403); };
  const backups = new Backups(opts.dataDir, reg, { blobUrl: opts.backupBlobUrl });
  const ai = new AI(opts.dataDir, { envKey: opts.aiKey, apiUrl: opts.aiUrl });
  // Year-end files started, per firm, for charging per file (usage.js).
  const yeUsage = new YearEndUsage(opts.dataDir);
  /** Count a year-end file as started (once per company and year-end). */
  function countYearEnd(cid, store, e, by) {
    const c = reg.get(cid), f = c && auth.firm(c.firmId), s = store.getSetting('company') || {};
    yeUsage.record({ firmId: c ? c.firmId : '', firmName: f ? f.name : '', companyId: cid, companyName: s.name || (c && c.name) || '', yearEnd: e.yearEnd, startedAt: e.created || Date.now(), by: by || '', fileId: e.id || '' });
  }
  /** Files started before counting began: counted once, from each file's own start date. */
  function backfillYearEnds() {
    if (yeUsage.data.backfilled) return;
    for (const c of reg.list()) {
      let store; try { store = reg.store(c.id); } catch { continue; }
      if (!store) continue;
      for (const e of store.list('engagements')) countYearEnd(c.id, store, { ...e, created: e.created || (e.snapshot && e.snapshot.takenAt) || 0 }, (e.team && e.team.preparer && e.team.preparer.name) || '');
    }
    yeUsage.data.backfilled = true; yeUsage.save();
  }
  // Plaid's keys and the banks' access tokens stay with this computer (the licence folder on desktop), never in a books folder that may be shared.
  const plaid = new Plaid(opts.licenceDir || opts.dataDir, { env: opts.plaid || {}, fetch: opts.plaidFetch });
  // QuickBooks Online and Xero connections, for year-end files of clients whose books are kept there (ledgers.js).
  const ledgers = new Ledgers(opts.licenceDir || opts.dataDir, { fetch: opts.ledgerFetch, urls: opts.ledgerUrls });
  // Receipts by email: the server's settings and each company's address (inbound.js), kept with the server like Plaid's keys.
  const inSet = new inbound.InboundSettings(opts.licenceDir || opts.dataDir);
  /** Bring one bank connection's new transactions into its company's "For review". */
  async function syncFeed(cid, itemId, user) {
    const it = plaid.item(itemId, cid);
    const changes = await plaid.pull(itemId, cid);
    if (!changes) return { added: 0, updated: 0, removed: 0, busy: true };
    if (!plaid.data.items[itemId]) return { added: 0, updated: 0, removed: 0, gone: true }; // disconnected while it ran
    const ctx = ctxFor(cid);
    const r = ctx.store.transaction(() => {
      const out = applyFeed(ctx.store, it, changes, it.institution);
      if (out.added) ctx.store.audit(user || { username: 'bank feed', name: 'Bank feed' }, 'import', { collection: 'bankTxns', summary: `bank feed from ${it.institution}: ${out.added} new bank line(s)` });
      return out;
    });
    plaid.commit(itemId, changes);
    if (r.added || r.updated || r.removed) ctx.bump();
    return r;
  }
  /** Every few hours: sync every connection of every company that isn't archived. One bad connection doesn't stop the rest. */
  async function syncAllFeeds() {
    if (!plaid.configured()) return;
    if (licence.on && !licence.status().canChange) return; // the books are view only until the licence is renewed
    for (const [id, it] of Object.entries(plaid.data.items)) {
      if (closing) return;
      const c = reg.get(it.companyId);
      if (!c || c.archived || it.status === 'login') continue;
      try { await syncFeed(it.companyId, id); } catch { /* kept on the connection as its status */ }
    }
  }
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
  /* ---------- Workflow reminders (workflows.js, Plus) ----------
     Each company's rules are checked every hour and when someone opens the company. What they find goes into the
     company's `reminders` setting (only the server writes it), keyed by rule + record + date so a reminder is made once.
     Customer emails go from the company's own mailbox (counted in its 200 a day); digests to staff from the server's. */
  const WF = require('../../public/workflows.js');
  const WF_USER = { username: 'workflow', name: 'Workflow reminders' };
  const wfToday = () => localDay(opts.now ? opts.now() : new Date());
  const wfBusy = new Set(), wfOpened = new Map(); // companies being checked; when each was last checked on opening
  /** Everyone at the firm who can open these books (not clients), as the rules see them. */
  function wfPeople(cid, settings) {
    const c = reg.get(cid), ap = APPROVALS.clean(settings.approvals);
    return auth.firmUsers(c.firmId).filter(u => !u.disabled && u.role !== 'client').map(u => auth.publicUser(u)).filter(u => auth.canSee(u, cid))
      .map(u => ({ id: u.id, role: u.role, perms: u.perms, username: u.username, name: u.name, lang: u.lang, approver: u.role === 'owner' || ap.approvers.includes(u.id) || !!u.approveBills }));
  }
  const wfMailOpts = () => ({ insecureTls: !!opts.mailInsecureTls, allowLocal: !!opts.mailAllowLocal });
  /** Check one company's rules now: add new reminders, close finished ones, send what's due. Returns what it did. */
  async function checkWorkflows(cid) {
    if (wfBusy.has(cid) || closing) return { skipped: true };
    const c = reg.get(cid);
    if (!c || c.archived || !featureOn(cid, 'workflows')) return { skipped: true };
    if (licence.on && !licence.status().canChange) return { skipped: true }; // view only until the licence is renewed
    wfBusy.add(cid);
    try {
      const ctx = ctxFor(cid), store = ctx.store, today = wfToday(), now = opts.now ? opts.now().getTime() : Date.now();
      const settings = { ...DEFAULT_COMPANY, ...(store.getSetting('company') || {}) }, wf = WF.clean(settings.workflows);
      const prev = store.getSetting('reminders');
      if (!WF.anyOn(wf) && !Object.values(WF.cleanStore(prev).items).some(r => !r.done)) return { created: 0, emailed: 0, digests: 0 };
      const people = wfPeople(cid, settings);
      const books = { company: settings };
      for (const k of ['accounts', 'contacts', 'docs', 'entries', 'estimates', 'bankTxns', 'receipts', 'payruns', 'filings']) books[k] = store.list(k);
      const features = { payroll: featureOn(cid, 'payroll', store), billApprovals: APPROVALS.active(settings.approvals, featureOn(cid, 'billApprovals', store)) };
      const hits = WF.evaluate({ settings: wf, books, people, today, features, owners: people.filter(p => p.role === 'owner').length });
      const res = WF.sync(prev, hits, now);
      let next = res.store, changed = res.changed;
      for (const r of res.created) if (WF.rule(wf, r.rule).digest) r.digest = true;
      if (changed) store.putSetting('reminders', next);
      // Emails to customers: overdue invoices and estimates whose rule says so, at most once per repeat (or once per due date).
      let emailed = 0;
      const cfg = store.getSetting('mail');
      for (const r of Object.values(next.items)) {
        if (r.done || !['invoiceOverdue', 'estimateFollowup'].includes(r.rule)) continue;
        const rule = WF.rule(wf, r.rule);
        if (!rule.customer || !cfg || !cfg.host) continue;
        const ck = `${r.col}|${r.id}|${r.due}`, last = next.cust[ck];
        const every = r.rule === 'invoiceOverdue' ? rule.repeat : 0;
        if (!WF.customerDue(last, today, every)) continue;
        const rec = store.get(r.col, r.id), ct = rec && store.get('contacts', rec.contactId);
        if (!rec) continue;
        const to = ct && String(ct.email || '').split(/[,;]/)[0].trim();
        const mark = (ok, why) => { next = { ...next, cust: { ...next.cust, [ck]: { day: today, ok } } }; changed = true; if (why) store.audit(WF_USER, 'email', { collection: r.col, id: r.id, summary: `workflow: ${why}` }); };
        const what = r.rule === 'invoiceOverdue' ? `payment reminder for invoice${rec.number ? ' #' + rec.number : ''}` : `follow-up on estimate${rec.number ? ' #' + rec.number : ''}`;
        if (!to || !mail.EMAIL_RE.test(to)) { mark(false, last ? '' : `no ${what} sent: the customer has no email address`); continue; } // logged once, tried again each day
        const dayKey = 'mail-sent:' + new Date(now).toISOString().slice(0, 10), sentToday = Number(store.getMeta(dayKey) || 0);
        if (sentToday + 1 > 200) { mark(false, `no ${what} sent: this company’s 200 emails today are used up`); continue; }
        store.putMeta(dayKey, sentToday + 1);
        const lang = settings.lang === 'fr' ? 'fr' : 'en', f = WF.fmt(lang);
        const pay = settings.etransfer ? (lang === 'fr' ? `Paiement par virement Interac à ${settings.etransfer}${rec.number ? ` (indiquez ${r.col === 'docs' ? 'la facture' : 'la soumission'} ${rec.number})` : ''}.` : `Pay by Interac e-Transfer to ${settings.etransfer}${rec.number ? ` (include ${r.col === 'docs' ? 'invoice' : 'estimate'} ${rec.number} in the message)` : ''}.`) : '';
        const [subject, text] = WF.customerEmail(r.col === 'docs' ? 'invoice' : 'estimate', { company: settings.name, name: ct.name, num: rec.number || '', amount: f.money(r.col === 'docs' ? r.vars.amount : rec.total, rec.currency), due: f.date(r.col === 'docs' ? rec.due : rec.expires), pay }, lang);
        try {
          await mail.send(cfg, { to: [to], subject, text }, wfMailOpts());
          const cur = store.get(r.col, r.id);
          store.transaction(() => {
            if (cur) store.put(r.col, r.id, { ...cur, sent: [...(cur.sent || []).slice(-19), { at: Date.now(), to, by: WF_USER.name, what: r.col === 'docs' ? 'reminder' : 'followup' }] });
            mark(true, `emailed ${what} to ${to}`);
          });
          emailed++;
        } catch (e) { mark(false, `couldn’t email ${what} to ${to}: ${String(e.message).slice(0, 120)}`); }
      }
      // Daily digest to staff (from the server's mailbox): new reminders since their last one, at most one a day per company.
      let digests = 0;
      const sys = sysMail.get();
      if (sys && sys.host) {
        const dg = { ...(next.digest || {}) };
        for (const p of people) {
          if (dg[p.id] === today || !mail.EMAIL_RE.test(p.username)) continue;
          const mine = Object.values(next.items).filter(r => r.digest && !r.mailed[p.id] && WF.shows(r, p.id, today));
          if (!mine.length) continue;
          const key = c.firmId + '|' + today, n = sysMailSent.get(key) || 0;
          if (n >= 100) break;
          sysMailSent.set(key, n + 1);
          const lang = (p.lang || settings.lang) === 'fr' ? 'fr' : 'en';
          const lines = mine.slice(0, 50).map(r => '• ' + WF.describe(r, lang, today)).join('\n');
          const subject = lang === 'fr' ? `Rappels pour ${settings.name} : ${mine.length}` : `Reminders for ${settings.name}: ${mine.length}`;
          const text = lang === 'fr' ? `Bonjour ${p.name},\n\nNouveaux rappels pour ${settings.name} :\n\n${lines}\n\nOuvrez Sumlora pour les voir dans Rappels.` : `Hello ${p.name},\n\nNew reminders for ${settings.name}:\n\n${lines}\n\nOpen Sumlora to see them under Reminders.`;
          try { await mail.send(sys, { to: [p.username], subject, text }, wfMailOpts()); digests++; } catch (e) { console.error('Workflow digest couldn’t be emailed:', e.message); }
          dg[p.id] = today; // tried today, sent or not: at most one a day
          for (const r of mine) next.items[r.key] = { ...r, mailed: { ...r.mailed, [p.id]: now } };
          changed = true;
        }
        next = { ...next, digest: dg };
      }
      if (changed) { store.putSetting('reminders', next); ctx.bump(); }
      return { created: res.created.length, emailed, digests };
    } finally { wfBusy.delete(cid); }
  }
  /** Every hour: every company that isn't archived. One company's problem doesn't stop the rest. */
  async function checkAllWorkflows() {
    for (const c of reg.list()) {
      if (closing) return;
      try { await checkWorkflows(c.id); } catch (e) { if (e.status !== 404) console.error('Workflow reminders:', e.message); }
    }
  }
  /** When someone opens a company: check it (at most every 5 minutes), without making them wait. */
  function checkWorkflowsSoon(cid) {
    const t = wfOpened.get(cid) || 0;
    if (Date.now() - t < 5 * 60e3) return;
    wfOpened.set(cid, Date.now());
    setImmediate(() => checkWorkflows(cid).catch(e => { if (e.status !== 404) console.error('Workflow reminders:', e.message); }));
  }
  let wfTimer = null;
  if (opts.autoWorkflows !== false) {
    setTimeout(() => checkAllWorkflows().catch(() => {}), 60 * 1000).unref();
    wfTimer = setInterval(() => checkAllWorkflows().catch(() => {}), 60 * 60 * 1000);
    wfTimer.unref();
  }
  let closing = false;
  if (opts.backupFolder) backups.update({ folder: opts.backupFolder });
  if (opts.autoBackup !== false) backups.start();
  // Twice a day, read every subscription again from Stripe (trials ending, cards failing, cancellations).
  let billTimer = null;
  if (opts.autoFeeds !== false) {
    billTimer = setInterval(() => refreshBilling(auth.data.firms.map(f => f.id), reg.list().filter(c => c.billing).map(c => c.id), true).then(() => chargePayrollEmployees()).catch(() => {}), 12 * 3600e3);
    billTimer.unref();
  }
  let feedTimer = null;
  if (opts.autoFeeds !== false) {
    setTimeout(() => syncAllFeeds().catch(() => {}), 2 * 60 * 1000).unref();
    feedTimer = setInterval(() => syncAllFeeds().catch(() => {}), 4 * 60 * 60 * 1000);
    feedTimer.unref();
  }
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
      industry: body.industry,
      // A type of business can bring its own fields (a scrap yard's weigh ticket number).
      customFields: ((IND.INDUSTRIES[body.industry] || {}).fields || []).map(x => ({ label: body.lang === 'fr' ? x.fr || x.label : x.label, sales: x.sales, purchase: x.purchase })),
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
    if (!accounts) seedIndustryItems(store, company);
    if (body.examples && company.orgType === 'business') loadExamples(store);
    if (body.code !== undefined && body.code !== '') { store.putSetting('companyCode', hashCode(body.code)); codeOpen.set(`${user.token}|${entry.id}`, Date.now() + CODE_TTL); }
    store.audit(user, 'create', { summary: `company created${body.copyFrom ? ' with a copied chart of accounts' : ''}${body.examples ? ', with example data' : ''}` });
    broadcast({ companies: true, firmId: entry.firmId });
    return entry;
  }

  /** The products a type of business starts with (a scrap yard's metals by weight), on its own accounts. */
  function seedIndustryItems(store, company) {
    const ind = IND.INDUSTRIES[company.industry];
    if (!ind || !ind.items || store.list('items').length) return;
    const byCode = code => (store.list('accounts').find(a => a.code === code) || {}).id || '';
    store.transaction(() => ind.items.forEach(([name, inc, exp, fr], i) => {
      const data = validateRecord('items', 'i' + (i + 1), { name: company.lang === 'fr' ? fr || name : name, type: 'service', sold: true, incomeAccount: byCode(inc), bought: !!exp, expenseAccount: exp ? byCode(exp) : '', taxCode: 'std' }, store);
      store.put('items', 'i' + (i + 1), data);
    }));
  }

  /** The client list's figures, without the ones a custom role can't see. */
  function roleSummary(user, c) {
    if (!user.perms) return c;
    const out = { ...c };
    if (!canArea(user, 'sales', 'view')) Object.assign(out, { overdueCount: 0, overdue: 0, receivable: 0 });
    if (!canArea(user, 'expenses', 'view')) out.payable = 0;
    if (!canArea(user, 'banking', 'view')) Object.assign(out, { toReview: 0, lastReconciled: '' });
    return out;
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
      if (d.kind === 'sreceipt') continue;
      const bal = Math.round(((Number(d.total) || 0) - (paid[d.id] || 0)) * (Number(d.fx) || 1) * 100) / 100; // in Canadian dollars
      if (bal <= 0.004) continue;
      if (d.kind === 'invoice') {
        receivable += bal;
        if (d.due && d.due < today) { overdueCount++; overdue += bal; }
      } else if (d.kind === 'bill') payable += bal;
      else if (d.kind === 'credit') receivable -= bal;
      else if (d.kind === 'vcredit') payable -= bal;
    }
    // Deposits received on estimates and not used yet are a credit for the customer.
    for (const v of Object.values(DEP.byCustomer(store.list('estimates'), entries))) receivable -= v;
    const recons = store.list('recons').map(r => r.statementDate).sort();
    const { billing: bill, ...entry } = c;
    return {
      ...entry,
      payer: c.payer === 'client' ? 'client' : 'firm', billing: c.payer === 'client' ? billingDescribe(bill) : undefined,
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

  /** An employee record with the bank account number masked (•••• and the last 3 digits). */
  function maskPrivate(r) {
    if (!r || !r.bank || !r.bank.account) return r;
    return { ...r, bank: { ...r.bank, account: '••••' + String(r.bank.account).slice(-3) } };
  }

  /**
   * What a custom role can't see is left out of the books sent to the browser (as empty lists, so every screen still works).
   * The ledger (all transactions) comes with Reports, Accounting, Banking or Sales tax, which need every posting for their totals;
   * otherwise transactions follow their own area. Invoices, bills, customers, vendors, payroll and the rest follow their area.
   */
  function roleView(user, out) {
    const see = a => canArea(user, a, 'view');
    const ledger = see('reports') || see('accounting') || see('banking') || see('salestax');
    for (const c of COLLECTIONS) {
      if (c === 'accounts' || c === 'attachments' || c === 'questions' || (c === 'entries' && ledger)) continue;
      out[c] = (out[c] || []).filter(r => (c === 'items' ? see('sales') || see('expenses') : see(ROLES.recordArea(c, r))));
    }
    // Files and questions go with the transaction they're on.
    const ids = { entries: new Set(out.entries.map(r => r.id)), docs: new Set(out.docs.map(r => r.id)), bankTxns: new Set(out.bankTxns.map(r => r.id)), engagements: new Set((out.engagements || []).map(r => r.id)), requests: new Set((out.requests || []).map(r => r.id)) };
    const onSeen = x => !!(ids[x.target] && ids[x.target].has(x.targetId));
    out.attachments = out.attachments.filter(onSeen);
    out.questions = out.questions.filter(onSeen);
    // Payroll at View: social insurance numbers and bank account numbers stay hidden. Without Payroll, its settings too.
    if (see('payroll') && !canArea(user, 'payroll', 'edit')) out.employees = out.employees.map(e => maskPrivate(e.sin ? { ...e, sin: '•••••' + String(e.sin).slice(-3) } : e));
    if (!see('payroll')) { out.company = { ...out.company }; delete out.company.payroll; }
  }

  /**
   * Company settings from someone with a custom role: each setting belongs to an area (payroll settings to Payroll,
   * saved reports to Reports, the rest to Settings). Settings in an area they can't see were never sent, so they're
   * kept as they were; changing one in an area they can only view is refused.
   */
  /** The tag list only grew: every tag and group already there is unchanged, and nothing was removed. */
  function tagsOnlyAdded(before, after) {
    const same = (a, b) => (a || []).every(x => (b || []).some(y => JSON.stringify(x) === JSON.stringify(y)));
    return same(before.tags, after.tags) && same(before.tagGroups, after.tagGroups);
  }
  function roleSettings(user, company, before) {
    for (const k of Object.keys(company)) {
      const a = ROLES.settingArea(k);
      if (canArea(user, a, 'edit')) continue;
      if (!canArea(user, a, 'view')) { company[k] = before[k]; continue; }
      if (JSON.stringify(company[k]) !== JSON.stringify(before[k])) needArea(user, a, 'edit');
    }
  }

  /** An activity log row someone with a custom role may see: changes to records in areas their role can view. */
  function auditVisible(user, r) {
    if (!user.perms || !r.collection || !COLLECTIONS.includes(r.collection)) return true;
    if (r.collection === 'contacts' || r.collection === 'items') return canArea(user, 'sales', 'view') || canArea(user, 'expenses', 'view');
    const word = String(r.summary || '').split(' ')[0]; // summaries start with the kind of record: "invoice #1001 …", "payrun 2026-…"
    const rec = r.after || r.before || { type: word, kind: word };
    return ['attachments', 'questions'].includes(r.collection) || canArea(user, ROLES.recordArea(r.collection, rec), 'view');
  }

  function state(ctx) {
    const cl = ctx.store.getSetting('closing') || {};
    const out = { rev: ctx.rev, companyId: ctx.id, company: { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}), closingDate: cl.date || '', closingPassword: !!cl.hash, hasCode: hasCode(ctx.store) } };
    for (const c of COLLECTIONS) out[c] = ctx.store.list(c);
    // Clients and view-only users see only the last 3 digits of employees' bank accounts.
    if (ctx.user && (ctx.user.role === 'client' || ctx.user.readOnly) && out.employees) out.employees = out.employees.map(maskPrivate);
    if (ctx.user && ctx.user.perms) roleView(ctx.user, out);
    // Year-end files are the accountant's: clients never get them, and nobody does while the feature is off.
    const yfOn = featureOn(ctx.id, 'yearEndFiles', ctx.store);
    // Requests to the client: the client and staff see them while the feature is on.
    if (!ctx.user || !yfOn) { out.requests = []; out.attachments = out.attachments.filter(a => a.target !== 'requests'); }
    if (!ctx.user || ctx.user.role === 'client' || !yfOn) {
      out.engagements = [];
      out.attachments = out.attachments.filter(a => a.target !== 'engagements');
    } else {
      // The firm's people who can open these books, to assign as preparer or reviewer.
      out.team = wfPeople(ctx.id, ctx.store.getSetting('company') || {}).map(u => ({ id: u.id, name: u.name || u.username, role: u.role }));
    }
    out.assistant = assistantInfo(ctx.id, ctx.store);
    // Bill approvals: how many owners the firm has (one owner may approve their own bills).
    const cf = reg.get(ctx.id);
    out.approvalOwners = cf ? auth.firmUsers(cf.firmId).filter(u => u.role === 'owner' && !u.disabled).length : 1;
    // Add-ons on for this company (the AI assistant has its own details above).
    const co = reg.get(ctx.id) || {};
    out.addons = Object.fromEntries(Object.keys(PLANS.ADDONS).map(k => [k, !!co[k]]));
    // Add-ons that bring a plan feature here (payroll on Seed or Grow), for the screens' feature checks.
    out.featureAddons = featureAddons(co);
    // Workflow reminders for the person asking (only what their role can still see).
    out.reminders = ctx.user && ctx.user.role !== 'client' && featureOn(ctx.id, 'workflows', ctx.store)
      ? WF.forUser(ctx.store.getSetting('reminders'), ctx.user.id, wfToday(), a => canArea(ctx.user, a, 'view')) : [];
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
  const sameBut = (a, b) => { const drop = o => { const { clear, receiptId, applied, sent, id, tags, ...rest } = o || {}; return canon(rest); }; return drop(a) === drop(b); };
  function closedCheck(store, w, data, user) {
    const field = DATED[w.collection];
    if (!field) return;
    const cl = store.getSetting('closing');
    if (!cl || !cl.date) return;
    const before = store.get(w.collection, w.id);
    const dates = [before && before[field], w.op === 'set' && data && data[field]].filter(Boolean);
    if (!dates.some(d => String(d) <= cl.date)) return;
    if (w.op === 'set' && before && sameBut(before, data)) return;
    // Voiding a pay run from a closed period is allowed: nothing in it changes, and its reversing entry is dated
    // in an open period (that entry is checked on its own).
    if (w.op === 'set' && w.collection === 'payruns' && before && !before.void && data && data.void) {
      const { void: _v, ...rest } = data;
      if (sameBut(before, rest)) return;
    }
    if (isUnlocked(user, store)) return;
    const e = new ValidationError(user && user.role === 'client'
      ? `The books are closed through ${cl.date}. Ask your bookkeeper to make this change.`
      : `The books are closed through ${cl.date}. Unlock them to make this change.`, 423);
    e.closedThrough = cl.date;
    throw e;
  }

  /** Close the delayed charges and credits an invoice's lines came from (line.dl), and open the ones taken off it. */
  function syncDelayed(store, docId, doc) {
    const list = store.list('delayed');
    if (!list.length) return;
    for (const u of DELAYED.sync(list, docId, doc)) store.put('delayed', u.id, u.data);
  }

  /*
   * Year-end files: the server signs every sign-off, review and tick with who did it and when, so they can't be
   * made up in someone else's name. Only an owner or the file's reviewer can make a file final or reopen it,
   * a final file needs no open review notes, and reopening one needs a reason, which is kept with who and when.
   */
  const isLead = (user, f) => user.role === 'owner' || !!(f && f.team && f.team.reviewer && f.team.reviewer.id === user.id);
  function stampEngagement(prev, data, user) {
    const now = opts.now ? +opts.now() : Date.now(), me = { by: user.name || user.username, id: user.id, at: now };
    const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    const sign = (before, after) => (same(before, after) ? before || null : after ? me : null);
    const d = { ...data }, p = prev || {};
    d.wps = Object.fromEntries(Object.entries(d.wps && typeof d.wps === 'object' ? d.wps : {}).map(([k, w]) => {
      const pw = (p.wps || {})[k] || {};
      return [k, { ...w, prepared: sign(pw.prepared, w && w.prepared), reviewed: sign(pw.reviewed, w && w.reviewed) }];
    }));
    const pAje = new Map((p.ajes || []).map(j => [j.id, j]));
    d.ajes = (Array.isArray(d.ajes) ? d.ajes : []).map(j => {
      const pj = pAje.get(j && j.id);
      if (!pj) return { ...j, preparedBy: me, reviewedBy: null };
      // A change to the entry itself undoes its review.
      const changed = !same([pj.date, pj.memo, pj.lines], [j.date, j.memo, j.lines]);
      return { ...j, preparedBy: pj.preparedBy || me, reviewedBy: changed ? null : sign(pj.reviewedBy, j.reviewedBy) };
    });
    const pNote = new Map((p.reviewNotes || []).map(n => [n.id, n]));
    d.reviewNotes = (Array.isArray(d.reviewNotes) ? d.reviewNotes : []).map(n => {
      const pn = pNote.get(n && n.id), done = n && (n.status === 'resolved' || n.status === 'closed');
      const wasDone = pn && (pn.status === 'resolved' || pn.status === 'closed');
      return { ...n, created: pn ? pn.created : me, resolved: done ? (wasDone ? pn.resolved : me) : null };
    });
    d.checklist = Object.fromEntries(Object.entries(d.checklist && typeof d.checklist === 'object' ? d.checklist : {}).map(([k, v]) => [k, sign((p.checklist || {})[k], v)]).filter(([, v]) => v));
    const ps = p.signoffs || {}, ds = d.signoffs || {};
    d.signoffs = { prepared: sign(ps.prepared, ds.prepared), reviewed: sign(ps.reviewed, ds.reviewed) };
    if (!same(ps.reviewed, d.signoffs.reviewed) && d.signoffs.reviewed && !isLead(user, d)) throw new ValidationError('Only an owner or this file’s reviewer can sign it off as reviewed.', 403);
    // Final and reopened.
    const was = ENGAGE.statusOf(p.status), now2 = ENGAGE.statusOf(d.status);
    d.unlocks = p.unlocks || [];
    if (was !== 'final' && now2 === 'final') {
      if (!isLead(user, d)) throw new ValidationError('Only an owner or this file’s reviewer can make it final.', 403);
      if ((d.reviewNotes || []).some(ENGAGE.openNote)) throw new ValidationError('Resolve or close the open review notes before making the file final.', 409);
      d.finalAt = now; d.finalBy = me.by;
    } else if (was === 'final' && now2 !== 'final') {
      if (!isLead(user, p)) throw new ValidationError('Only an owner or this file’s reviewer can reopen it.', 403);
      const reason = String(d.unlockReason || '').trim();
      if (!reason) throw new ValidationError('Say why the file is being reopened.');
      d.unlocks = [...d.unlocks, { ...me, reason: reason.slice(0, 1000) }];
    } else if (was === 'final') { d.finalAt = p.finalAt; d.finalBy = p.finalBy; }
    delete d.unlockReason;
    return d;
  }
  /** What changed on a year-end file, in words, for the activity log ("AJE 4 created; working paper C reviewed"). */
  function engagementChanges(b, a) {
    if (!a) return ['deleted'];
    // A new file: "created", plus whatever it starts with (adjusting entries, sign-offs…).
    if (!b) { const rest = engagementChanges({ status: a.status, snapshot: a.snapshot, map: a.map, report: a.report, fsNotes: a.fsNotes, client: a.client, team: a.team, framework: a.framework, kind: a.kind, checklist: a.checklist }, a); return ['created', ...rest.filter(x => x !== 'changed')]; }
    const out = [], same = (x, y) => JSON.stringify(x || null) === JSON.stringify(y || null);
    const was = ENGAGE.statusOf(b.status), now = ENGAGE.statusOf(a.status);
    if (was !== now) out.push(now === 'final' ? 'made final' : was === 'final' ? `reopened: ${((a.unlocks || []).slice(-1)[0] || {}).reason || ''}` : `status ${ENGAGE.STATUS_LABEL[now].toLowerCase()}`);
    if (!same(b.snapshot && b.snapshot.lines, a.snapshot && a.snapshot.lines)) {
      const pb = new Map(((b.snapshot || {}).lines || []).map(l => [l.account, l]));
      const ch = ((a.snapshot || {}).lines || []).filter(l => !pb.has(l.account) || pb.get(l.account).cur !== l.cur).slice(0, 3).map(l => `${l.code ? l.code + ' ' : ''}${l.name} ${pb.has(l.account) ? '$' + pb.get(l.account).cur.toFixed(2) : '$0.00'} → $${l.cur.toFixed(2)}`);
      out.push('trial balance updated from the books' + (ch.length ? ` (${ch.join(', ')})` : ''));
    }
    const ba = new Map((b.ajes || []).map(j => [j.id, j])), aa = new Map((a.ajes || []).map(j => [j.id, j]));
    for (const j of a.ajes || []) {
      const pj = ba.get(j.id);
      if (!pj) out.push(`AJE ${j.num} created`);
      else {
        if (!same([pj.date, pj.memo, pj.lines], [j.date, j.memo, j.lines])) out.push(`AJE ${j.num} changed`);
        if (!pj.reviewedBy && j.reviewedBy) out.push(`AJE ${j.num} reviewed`);
        if (!pj.entryId && j.entryId) out.push(`AJE ${j.num} posted to the books`);
      }
    }
    for (const j of b.ajes || []) if (!aa.has(j.id)) out.push(`AJE ${j.num} deleted`);
    const label = c => (ENGAGE.BY_CODE[c] || ENGAGE.EXTRA_WPS.find(x => x.code === c) || { label: c }).label;
    for (const [k, w] of Object.entries(a.wps || {})) {
      const pw = (b.wps || {})[k] || {};
      if (!pw.prepared && w.prepared) out.push(`working paper ${label(k)} prepared`);
      if (!pw.reviewed && w.reviewed) out.push(`working paper ${label(k)} reviewed`);
      if (pw.reviewed && !w.reviewed) out.push(`working paper ${label(k)} review removed`);
      const txt = x => [x.notes || '', x.comment || '', x.refs || '', x.ticks || {}];
      if (!same(txt(pw), txt(w))) out.push(`working paper ${label(k)} notes changed`);
    }
    const bn = new Map((b.reviewNotes || []).map(n => [n.id, n]));
    for (const n of a.reviewNotes || []) { const pn = bn.get(n.id); if (!pn) out.push(`review note ${n.num} added`); else if (pn.status !== n.status) out.push(`review note ${n.num} ${ENGAGE.NOTE_STATUS[n.status].toLowerCase()}`); }
    for (const k of ['prepared', 'reviewed']) { const x = (b.signoffs || {})[k], y = (a.signoffs || {})[k]; if (!x && y) out.push(`file signed off as ${k}`); if (x && !y) out.push(`${k} sign-off removed`); }
    if (!same(b.map, a.map)) out.push('account mapping changed');
    if (!same([b.report, b.fsNotes], [a.report, a.fsNotes])) out.push('report or notes changed');
    if (!same([b.client, b.team, b.framework, b.kind], [a.client, a.team, a.framework, a.kind])) out.push('engagement details changed');
    if (!same(b.checklist, a.checklist)) out.push('checklist ticked');
    return out.length ? out : ['changed'];
  }

  function applyWrite(store, w, user, ctx) {
    const { op, collection, id } = w;
    if (!COLLECTIONS.includes(collection)) throw new ValidationError(`Unknown collection "${collection}".`, 404);
    // Custom roles: Edit in the area of the record, before and after the change (an invoice turned into a bill needs both).
    if (user && user.perms) {
      const prev = store.get(collection, id);
      if (collection === 'attachments') { const x = prev || {}; const t = x.target && store.get(x.target, x.targetId); needArea(user, ROLES.recordArea(x.target || 'entries', t), 'edit'); }
      else needWrite(user, collection, op === 'set' ? w.data || {} : null, prev);
    }
    // Year-end files: the firm's staff only, and only with the feature on (it's coming soon for now).
    if (collection === 'engagements') {
      if (!user || user.role === 'client') throw new ValidationError('Year-end files are for the firm’s accountants.', 403);
      if (ctx) needFeature(ctx.id, 'yearEndFiles', store);
      if (op === 'set') w.data = stampEngagement(store.get('engagements', id), w.data || {}, user);
    }
    // Requests to the client: staff make and decide them; a client can only answer one (a note, "sent", or approving
    // the draft statements), and the server stamps who did it and when.
    if (collection === 'requests') {
      if (ctx) needFeature(ctx.id, 'yearEndFiles', store);
      const prev = store.get('requests', id), now = opts.now ? +opts.now() : Date.now();
      const me = user ? { by: user.name || user.username, id: user.id, at: now } : null;
      if (user && user.role === 'client') {
        if (op !== 'set' || !prev) throw new ValidationError('Your accountant sends the requests.', 403);
        const d = w.data || {}, next = { ...prev, clientNote: String(d.clientNote ?? prev.clientNote ?? '') };
        if (d.status === 'sent' && ['open', 'returned'].includes(prev.status)) { next.status = 'sent'; next.sent = me; }
        if (prev.kind === 'approval' && d.approval && typeof d.approval.approved === 'boolean' && prev.status !== 'accepted') { next.approval = { ...me, approved: d.approval.approved }; next.status = 'sent'; next.sent = me; }
        w.data = next;
      } else if (op === 'set') {
        const d = { ...(w.data || {}) };
        d.created = prev ? prev.created : me; d.sent = prev ? prev.sent : null; d.approval = prev ? prev.approval : null;
        d.decided = prev && prev.status === d.status ? prev.decided : ['accepted', 'returned'].includes(d.status) ? me : null;
        w.data = d;
      }
    }
    // A year-end file's documents can't be removed once the file is final.
    if (collection === 'attachments' && op === 'delete') {
      const at = store.get('attachments', id), e = at && at.target === 'engagements' && store.get('engagements', at.targetId);
      if (e && ENGAGE.statusOf(e.status) === 'final') throw new ValidationError('This year-end file is final. Reopen it to remove documents.', 409);
    }
    // Plan features: payroll records, and the special sales tax methods on returns.
    if (ctx && op === 'set') {
      const d = w.data || {};
      if (collection === 'shiftworkers' && ctx) {
        const rawPhone=String(d.phone||'').replace(/[^0-9]/g,'');
        const phone=rawPhone.length===10?'+1'+rawPhone:rawPhone.length===11&&rawPhone.startsWith('1')?'+'+rawPhone:'';
        if(phone && store.list('shiftworkers').some(existing=>existing.id!==id&&existing.active!==false&&existing.phone===phone)) throw new ValidationError('This phone number is already assigned to an active team member.',409);
      }
      if (collection === 'shiftworkers' || collection === 'workshifts') {
         const cfg=store.getSetting('company') || {};
         if (!cfg.features || cfg.features.timesheets !== true) throw new ValidationError('Timesheets & Tips is not enabled for this company.',403);
       }
       if (collection === 'employees' || collection === 'payruns' || (collection === 'entries' && ['payrun', 'payremit'].includes(d.type))) needFeature(ctx.id, 'payroll', store);
      if (collection === 'projects' || collection === 'times') needFeature(ctx.id, 'projects', store);
      if (collection === 'assets') needFeature(ctx.id, 'fixedAssets', store);
      if (collection === 'budgets') needFeature(ctx.id, 'budgets', store);
      if (collection === 'vehicles') needAddon(ctx.id, 'scrapyard');
      if (collection === 'items' && d.type === 'inventory') needFeature(ctx.id, 'inventory', store);
      if (collection === 'filings' && ['quick', 'charity', 'npo'].includes(d.method)) {
        const prev = store.get('filings', id);
        if (!(prev && prev.method === d.method)) needFeature(ctx.id, 'specialTax', store);
      }
    }
    // Bill approvals (approvals.js): the server decides a bill's approval on every save; a bill waiting for approval
    // (or rejected) can't be paid. Payments already on it stay as they are and can still be ticked as cleared.
    if (op === 'set' && collection === 'docs' && w.data && w.data.kind === 'bill') {
      const prev = store.get('docs', id), settings = (store.getSetting('company') || {}).approvals;
      const on = !!ctx && !ctx.importing && APPROVALS.active(settings, featureOn(ctx.id, 'billApprovals', store));
      const a = APPROVALS.onSave(prev && prev.kind === 'bill' ? prev : null, w.data, settings, on, user);
      w.data = { ...w.data }; if (a) w.data.approval = a; else delete w.data.approval;
    }
    if (op === 'set' && collection === 'entries' && w.data && w.data.type === 'billpayment' && w.data.applyTo && ctx && !ctx.importing) {
      const doc = store.get('docs', String(w.data.applyTo)), prev = store.get('entries', id);
      const more = !prev || prev.applyTo !== w.data.applyTo || (Number(w.data.amount) || 0) > (Number(prev.amount) || 0) + 0.004;
      if (more && APPROVALS.held(doc, APPROVALS.active((store.getSetting('company') || {}).approvals, featureOn(ctx.id, 'billApprovals', store)))) {
        throw new ValidationError(doc.approval.status === 'rejected'
          ? `Bill${doc.number ? ' #' + doc.number : ''} was rejected, so it can’t be paid. Correct it and send it for approval again.`
          : `Bill${doc.number ? ' #' + doc.number : ''} is waiting for approval, so it can’t be paid yet.`, 409);
      }
    }
    // Receipts are created only by the upload route (or a restore), never by a plain write.
    if (collection === 'receipts' && op === 'set' && !store.get('receipts', id)) throw new ValidationError('Add receipts from the Receipts screen.');
    // Attachments and questions have their own routes; a plain write can only delete an attachment.
    if (collection === 'attachments' && (op !== 'delete' || (user && user.role === 'client'))) throw new ValidationError('Attach files from the transaction.', 403);
    if (collection === 'questions') throw new ValidationError('Use Questions to ask or answer.', 403);
    // A recurring transaction being made: if another window already made this date, don't make it again.
    if ((collection === 'docs' || collection === 'entries') && op === 'set' && w.data && w.data.recurringNew) {
      if (store.get(collection, id)) throw new ValidationError('That recurring transaction was already made.', 409);
      w.data = { ...w.data }; delete w.data.recurringNew;
    }
    if (collection === 'receipts' && user && user.role === 'client') {
      // Clients can add a note to, or remove, a receipt they sent that hasn't been dealt with yet.
      const r = store.get('receipts', id);
      const own = r && r.uploadedBy === user.username && r.status === 'inbox' && !r.entryId && !r.docId && !r.wasAttached;
      const noteOnly = op === 'set' && own && w.data && (w.data.status || 'inbox') === 'inbox' && !w.data.entryId && !w.data.docId;
      if (!(op === 'delete' ? own : noteOnly)) throw new ValidationError('Your bookkeeper takes care of receipts once they’re sent.', 403);
    }
    // Social insurance numbers never go into the activity log in full.
    // Nor do the ID numbers of people who sold a vehicle to a scrap yard.
    // Nor do employees' bank account numbers (direct deposit).
    const hideSin = r => maskPrivate(r && r.sin ? { ...r, sin: '•••••' + String(r.sin).slice(-3) } : r && r.seller && r.seller.idNumber ? { ...r, seller: { ...r.seller, idNumber: '•••••' + String(r.seller.idNumber).slice(-3) } } : r);
    // Someone who only sees masked bank numbers saves them back unchanged: keep the real ones.
    if (collection === 'employees' && op === 'set' && w.data && w.data.bank && /•/.test(String(w.data.bank.account || ''))) {
      const cur = store.get('employees', id);
      w.data = { ...w.data, bank: { ...w.data.bank, account: cur && cur.bank ? cur.bank.account : '' } };
    }
    const masked = collection === 'employees' || collection === 'vehicles';
    const before = masked ? hideSin(store.get(collection, id)) : store.get(collection, id);
    if (op === 'set') {
      if (collection === 'docs') {
        if (w.data && w.data.carried && !(before && before.carried) && !(ctx && ctx.importing)) throw new ValidationError('Opening-balance documents can only be created through the migration import.');
        if (before && before.carried && !(ctx && ctx.importing)) {
          if (Number(w.data.total) !== Number(before.total) || (w.data.currency || '') !== (before.currency || '') || Number(w.data.fx || 1) !== Number(before.fx || 1)) throw new ValidationError('A carried opening balance can’t be changed. Correct it through the migration workflow.', 409);
          w.data = { ...w.data, carried: true };
        }
      }
      const data = validateRecord(collection, id, w.data, store);
      closedCheck(store, w, data, user);
      store.put(collection, id, data);
      if (collection === 'docs') syncDelayed(store, id, data);
      // A year-end file started (or moved to a year-end not counted yet): counted for charging, once the change is saved.
      if (collection === 'engagements' && ctx && data.yearEnd && (!before || before.yearEnd !== data.yearEnd)) {
        const by = user ? user.name || user.username : '';
        store.afterCommit(() => countYearEnd(ctx.id, store, { ...data, id, created: Date.now() }, by));
      }
      const after = masked ? hideSin(store.get(collection, id)) : store.get(collection, id);
      if (JSON.stringify(before) !== JSON.stringify(after)) store.audit(user, before ? 'change' : 'add', { collection, id, summary: collection === 'engagements' ? `year-end file ${after.yearEnd}: ${engagementChanges(before, after).join('; ')}`.slice(0, 500) : auditSummary(collection, after), before, after });
    } else if (op === 'delete') {
      checkDelete(collection, id, store);
      closedCheck(store, w, null, user);
      store.delete(collection, id);
      if ((collection === 'receipts' || collection === 'attachments') && before && before.fileId) store.deleteFile(before.fileId);
      // A deleted transaction, invoice or bill takes its attached files and questions with it.
      // A deleted year-end file takes its requests to the client (and their files) with it.
      if (collection === 'engagements') for (const r of store.list('requests').filter(r => r.engagementId === id)) {
        for (const x of store.list('attachments').filter(x => x.target === 'requests' && x.targetId === r.id)) { store.delete('attachments', x.id); store.deleteFile(x.fileId); }
        store.delete('requests', r.id);
      }
      if (collection === 'requests') for (const x of store.list('attachments').filter(x => x.target === 'requests' && x.targetId === id)) { store.delete('attachments', x.id); store.deleteFile(x.fileId); }
      if (collection === 'entries' || collection === 'docs' || collection === 'engagements') {
        for (const x of store.list('attachments').filter(x => x.target === collection && x.targetId === id)) { store.delete('attachments', x.id); store.deleteFile(x.fileId); }
        for (const q of store.list('questions').filter(q => q.target === collection && q.targetId === id)) store.delete('questions', q.id);
      }
      // A receipt attached to a deleted transaction or bill goes back to the inbox.
      if (collection === 'entries' || collection === 'docs') {
        const key = collection === 'entries' ? 'entryId' : 'docId';
        for (const r of store.list('receipts').filter(x => x[key] === id)) store.put('receipts', r.id, { ...r, [key]: '', status: 'inbox' });
      }
      // An estimate turned into a deleted invoice goes back to accepted, ready to invoice again.
      if (collection === 'docs') for (const x of store.list('estimates').filter(x => x.invoiceId === id)) store.put('estimates', x.id, { ...x, invoiceId: '' });
      // Delayed charges and credits on a deleted invoice are open again, ready for the next one.
      if (collection === 'docs') syncDelayed(store, id, null);
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
      case 'estimates': return `estimate ${d.number ? '#' + d.number + ' ' : ''}${d.date} ${amt(d.total)}`;
      case 'recurring': return `recurring ${d.kind} “${String(d.name || '').slice(0, 60)}”, next ${d.next}`;
      case 'delayed': return `${d.kind === 'credit' ? 'delayedcredit' : 'delayedcharge'} ${d.number ? '#' + d.number + ' ' : ''}${d.date} ${amt(d.amount)}${d.invoiceId ? ' (on an invoice)' : ''}`;
      case 'entries': return `${d.type} ${d.date}${d.ref ? ' #' + d.ref : ''} ${amt(tot(d))}${d.memo ? ' · ' + String(d.memo).slice(0, 60) : ''}`;
      case 'docs': return `${d.kind}${d.number ? ' #' + d.number : ''} ${d.date} ${amt(d.total)}`;
      case 'accounts': return `${d.code ? d.code + ' ' : ''}${d.name}`;
      case 'contacts': case 'employees': return d.name || '';
      case 'vehicles': return `vehicle ${d.stock}${d.vin ? ' VIN ' + d.vin : ''} ${[d.year, d.make, d.model].filter(Boolean).join(' ')} ${amt(d.price)} (${d.status})`;
      case 'bankTxns': return `${d.date} ${amt(d.amount)} ${String(d.desc || '').slice(0, 50)} (${d.status})`;
      case 'rules': return `when "${d.text}"`;
      case 'recons': return `statement ${d.statementDate} ending ${amt(d.endingBalance)}`;
      case 'filings': return `${d.tax === 'qst' ? 'QST' : d.tax === 'pst' ? 'PST' : 'GST/HST'} ${d.from} to ${d.to}`;
      case 'payruns': return `pay date ${d.payDate}, ${(d.lines || []).length} employee(s)`;
      case 'engagements': return `year-end file ${d.yearEnd}`;
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
      if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Please sign in.', 401, { setup: auth.needsSetup(), setupCode: auth.needsSetup() && !!opts.setupCode, signups: auth.signups !== 'off' && !auth.needsSetup() ? auth.signups : '', forgot: !auth.needsSetup() && forgotReady(),
        ...(auth.needsSetup() && licence.on ? { licenceSetup: { required: licence.trialDays === 0, trialDays: licence.trialDays } } : {}) });
      const { token, ...u } = user;
      return { user: u, idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.policy2fa, licence: licenceInfo(u),
        terms: requireTerms ? { version: TERMS_VERSION, draft: TERMS_DRAFT, accepted: termsOk(u), before: !!(u.terms && u.terms.v) } : null };
    }],
    // Agree to the current Terms of service and Privacy policy (asked once per version).
    ['POST', /^\/api\/auth\/terms$/, async (req, m, res, user) => {
      const body = await readJson(req);
      if (body.version !== TERMS_VERSION) throw new ValidationError('The terms have changed since this page opened. Reload the page to read the current version.', 409);
      needAgreement({ acceptTerms: body.accept });
      auth.acceptTerms(user.id, TERMS_VERSION, clientIp(req));
      return { ok: true, version: TERMS_VERSION };
    }],
    ['POST', /^\/api\/auth\/setup$/, async (req, m, res) => {
      const body = await readJson(req);
      needAgreement(body);
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
      if (body.acceptTerms === true) auth.acceptTerms(u.id, TERMS_VERSION, clientIp(req));
      reg.adoptFirm(auth.mainFirmId);
      if (licence.on && code) {
        const lic = licence.enter(code);
        auth.log('licence-entered', { by: u.username, licence: lic.id, name: lic.name, plan: lic.plan, until: lic.until });
      }
      const { token } = await auth.login(u.username, body.password, { ip: clientIp(req) });
      res.setHeader('Set-Cookie', sessionCookie(token, req));
      return { ok: true, user: u };
    }],
    // A new firm, or a business keeping its own books, signs itself up (only when an administrator allows sign-ups).
    // A business gets its company made straight away, so it lands in its own books (after the free trial is started).
    ['POST', /^\/api\/auth\/signup$/, async (req, m, res) => {
      const body = await readJson(req);
      const ip = clientIp(req);
      ipCheck(ip);
      needAgreement(body);
      const business = body.kind === 'business';
      if (business && !PROVINCES[body.province]) throw new ValidationError('Choose your business’s province or territory.');
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
      if (body.acceptTerms === true) auth.acceptTerms(u.id, TERMS_VERSION, ip);
      if (business) {
        try { checkCompanyLimit(); createCompany({ name: firm.name, province: body.province }, { ...u, firmId: firm.id }); syncFirmCount(firm.id); }
        catch (e) { console.error('Sign-up: couldn’t create the business’s company:', e.message); } // they can add it themselves
      }
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
      return signIn(req, res, async meta => {
        if (auth.peekLink(body.token).kind === 'invite') needAgreement(body); // a password reset doesn't ask again
        const u = auth.acceptLink(body.token, body.password);
        if (body.acceptTerms === true) auth.acceptTerms(u.id, TERMS_VERSION, meta.ip);
        return auth.login(u.username, body.password, meta);
      });
    }],
    // "Forgot your password?" on the sign-in screen. If the email belongs to an account that can sign in, a reset link
    // (good for an hour) goes to it from the server's mailbox. The answer is the same either way and the email goes out
    // after replying, so neither the words nor the time taken show whether an account exists. Two-step sign-in still applies.
    ['POST', /^\/api\/auth\/forgot$/, async req => {
      const body = (await readJson(req)) || {};
      const ip = clientIp(req);
      ipCheck(ip);
      const cfg = sysMail.get(), base = appUrl();
      if (!cfg || !cfg.host || !base) throw new ValidationError('Ask your bookkeeper or the account owner for a reset link.', 409);
      const hour = Math.floor(Date.now() / 3600000), k = `${ip}|${hour}`;
      if ((forgotByIp.get(k) || 0) >= 5) throw new AuthError('Too many reset requests from your network. Try again in an hour.', 429);
      forgotByIp.set(k, (forgotByIp.get(k) || 0) + 1);
      if (forgotByIp.size > 5000) for (const key of forgotByIp.keys()) if (!key.endsWith('|' + hour)) forgotByIp.delete(key);
      await new Promise(r => setTimeout(r, 250));
      const name = String(body.username || '').trim().toLowerCase().slice(0, 200);
      const day = 'forgot|' + new Date().toISOString().slice(0, 10), sent = sysMailSent.get(day) || 0;
      if (mail.EMAIL_RE.test(name) && sent < 300) {
        const out = auth.forgotLink(name, ip);
        if (out) {
          sysMailSent.set(day, sent + 1);
          const msg = forgotEmail(out.user, `${base}/#link=${encodeURIComponent(out.token)}`);
          mail.send(cfg, { to: [out.user.username], ...msg }, { insecureTls: !!opts.mailInsecureTls, allowLocal: !!opts.mailAllowLocal })
            .catch(e => console.error('Forgot password: couldn’t send the reset email:', e.message));
        }
      }
      return { ok: true };
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
    ['GET', /^\/api\/users$/, (req, m, res, user) => { ownerOnly(user); const { roles, ...firm } = auth.firm(user.firmId) || {}; return { users: auth.list(user.firmId), idleMinutes: auth.data.settings.idleMinutes, require2fa: auth.data.settings.require2fa || 'off', forced2fa: auth.forced2fa, firm, roles: auth.roles(user.firmId), customRoles: auth.firmHas(user.firmId, 'customRoles') }; }],
    // Custom roles (Users & security → Roles): owners only, and only on a plan that includes them.
    ['GET', /^\/api\/roles$/, (req, m, res, user) => { ownerOnly(user); return { roles: auth.roles(user.firmId), available: auth.firmHas(user.firmId, 'customRoles') }; }],
    ['POST', /^\/api\/roles$/, async (req, m, res, user) => { ownerOnly(user); return { ok: true, role: auth.addRole(await readJson(req), user) }; }],
    ['PUT', /^\/api\/roles\/([A-Za-z0-9_]+)$/, async (req, m, res, user) => { ownerOnly(user); return { ok: true, role: auth.updateRole(m[1], await readJson(req), user) }; }],
    ['DELETE', /^\/api\/roles\/([A-Za-z0-9_]+)$/, (req, m, res, user) => { ownerOnly(user); auth.removeRole(m[1], user); return { ok: true }; }],
    ['POST', /^\/api\/users$/, async (req, m, res, user) => {
      ownerOnly(user);
      const b = await readJson(req);
      const mine = new Set(reg.list(user.firmId).map(c => c.id));
      if ((Array.isArray(b.companies) ? b.companies : []).some(id => !mine.has(String(id)))) throw new ValidationError('That company doesn’t exist.', 404);
      const u = auth.addUser({ ...b, mustChange: !b.invite, firmId: user.firmId, self: false });
      auth.log('user-added', { username: u.username, by: user.username, role: u.roleName ? `${u.role} (${u.roleName})` : u.role });
      // "They pay for Sumlora for this company": the client starts a subscription for it when they first sign in.
      if (u.role === 'client' && b.clientPays === true) {
        const plan = PLANS.PLANS[b.clientPlan] || PLANS.LEGACY[b.clientPlan] ? PLANS.planOf(b.clientPlan) : PLANS.planOf((auth.firm(user.firmId) || {}).plan);
        for (const cid of u.companies || []) reg.update(cid, { payer: 'client', clientPlan: plan });
        syncFirmCount(user.firmId);
      }
      return { ok: true, user: u };
    }],
    ['PUT', /^\/api\/users\/([^/]+)$/, async (req, m, res, user) => {
      ownerOnly(user);
      const b = await readJson(req);
      if (b.companies !== undefined) { const mine = new Set(reg.list(user.firmId).map(c => c.id)); if ((Array.isArray(b.companies) ? b.companies : []).some(id => !mine.has(String(id)))) throw new ValidationError('That company doesn’t exist.', 404); }
      return { ok: true, user: auth.updateUser(decodeURIComponent(m[1]), b, user) };
    }],
    ['DELETE', /^\/api\/users\/([^/]+)$/, (req, m, res, user) => {
      ownerOnly(user);
      auth.removeUser(decodeURIComponent(m[1]), user);
      return { ok: true };
    }],
    ['POST', /^\/api\/users\/([^/]+)\/link$/, (req, m, res, user) => {
      ownerOnly(user);
      const out = auth.issueLink(decodeURIComponent(m[1]), user);
      auth.log(out.kind === 'invite' ? 'invite-link' : 'reset-link', { username: auth.byId(decodeURIComponent(m[1])).username, by: user.username });
      return { ok: true, ...out };
    }],
    ['POST', /^\/api\/users\/([^/]+)\/unlock$/, (req, m, res, user) => {
      ownerOnly(user);
      return { ok: true, user: auth.unlock(decodeURIComponent(m[1]), user) };
    }],
    // The server's mailbox: the administrator sets it up; everyone else only learns whether it's there.
    ['GET', /^\/api\/sysmail$/, (req, m, res, user) => {
      const cfg = sysMail.get();
      if (user.role === 'owner' && user.platformAdmin) {
        if (cfg && cfg.host && !cfg.appUrl && !opts.publicUrl) sysMail.set({ ...cfg, appUrl: originOf(req) }); // set up before reset emails existed
        return { ...mail.publicMail(cfg), admin: true, appUrl: appUrl(), forgot: forgotReady() };
      }
      return { configured: !!(cfg && cfg.host) };
    }],
    ['PUT', /^\/api\/sysmail$/, async (req, m, res, user) => {
      adminOnly(user);
      const body = (await readJson(req)) || {};
      if (body.remove) { sysMail.set({}); auth.log('security-changed', { by: user.username, change: 'invitation email turned off' }); return mail.publicMail(null); }
      const cfg = mail.validateMail(body, sysMail.get() || {}, { allowLocal: !!opts.mailAllowLocal });
      sysMail.set({ ...cfg, appUrl: originOf(req) });
      auth.log('security-changed', { by: user.username, change: `invitation email set up for ${cfg.fromEmail}` });
      return { ...mail.publicMail(cfg), admin: true, appUrl: appUrl(), forgot: forgotReady() };
    }],
    ['POST', /^\/api\/sysmail\/test$/, async (req, m, res, user) => {
      adminOnly(user);
      const cfg = sysMail.get();
      if (!cfg || !cfg.host) throw new ValidationError('Set up the mailbox first.', 409);
      await mail.send(cfg, { to: [cfg.fromEmail], subject: 'Test email from Sumlora', text: 'This is a test. Sumlora can now email invitation and password reset links from this mailbox.' }, { insecureTls: !!opts.mailInsecureTls, allowLocal: !!opts.mailAllowLocal });
      return { ok: true };
    }],
    // Email someone their invitation or password reset link, from the server's mailbox. The sender must hold the
    // current link (the one just shown to them), it goes only to that person's own email, and the message has to contain it.
    ['POST', /^\/api\/users\/([^/]+)\/email-link$/, async (req, m, res, user) => {
      ownerOnly(user);
      const cfg = sysMail.get();
      if (!cfg || !cfg.host) throw new ValidationError('Invitation email isn’t set up on this server. Copy the link and send it yourself.', 409);
      const b = (await readJson(req)) || {};
      const target = auth.byId(decodeURIComponent(m[1]));
      if (!target || (target.firmId !== user.firmId && !user.platformAdmin)) throw new ValidationError('That user doesn’t exist.', 404);
      let holder;
      try { holder = auth.userForLink(String(b.token || '')); } catch (e) { throw new ValidationError('This link has expired or was replaced. Make a new one first.', 410); }
      if (holder.id !== target.id) throw new ValidationError('That link belongs to someone else.', 400);
      if (!mail.EMAIL_RE.test(target.username)) throw new ValidationError('This person’s username isn’t an email address. Copy the link and send it yourself.', 400);
      const text = String(b.text || '').slice(0, 5000), subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200).trim();
      if (!subject || !text.includes(String(b.token))) throw new ValidationError('The message has to include the link.', 400);
      const key = user.firmId + '|' + new Date().toISOString().slice(0, 10);
      const n = sysMailSent.get(key) || 0;
      if (n >= 100) throw new ValidationError('That’s 100 invitation emails today for your firm. Send the rest tomorrow, or copy the links.', 429);
      sysMailSent.set(key, n + 1);
      if (sysMailSent.size > 5000) sysMailSent.clear();
      const replyTo = mail.EMAIL_RE.test(user.username) ? user.username : cfg.replyTo;
      await mail.send({ ...cfg, replyTo }, { to: [target.username], subject, text }, { insecureTls: !!opts.mailInsecureTls, allowLocal: !!opts.mailAllowLocal });
      auth.log(holder.invite && holder.invite.kind === 'reset' ? 'reset-link' : 'invite-link', { username: target.username, by: user.username, emailed: true });
      return { ok: true, to: target.username };
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
      const serverWide = new Set(['firm-changed', 'firm-signup', 'firm-deleted', 'security-changed', 'ai-settings', 'plaid-settings', 'ledger-settings', 'inbound-settings', 'licence-entered', 'licence-key-created', 'licence-key-copied', 'licence-key-restored', 'licence-made']);
      return { log: auth.readLog(5000).filter(e => !serverWide.has(e.event) && (names.has(e.username) || names.has(e.by))).slice(0, 1000) };
    }],
    // The administrator's overview: firms on this server, desktop licences sold, renewals due, AI use.
    ['GET', /^\/api\/overview$/, (req, m, res, user) => {
      adminOnly(user);
      const now = opts.now ? +opts.now() : Date.now(), day = new Date(now), monthStart = new Date(day.getFullYear(), day.getMonth(), 1).getTime();
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
        subs: null,
      };
      // Online subscriptions (Stripe): firms that pay per company, and single businesses whose client pays.
      if (billing.configured()) {
        const amounts = billing.offer().amounts, week = now + 7 * 864e5;
        const row = (kind, id, name, plan, rec, firm, legacy) => {
          const d = billingDescribe(rec), state = d.state;
          const qty = kind === 'firm' ? firmCount(id) : 1, monthly = (amounts[PLANS.priceKey(plan, legacy)] || 0) * qty / 100;
          const next = state === 'trialing' ? d.trialEnd : state === 'active' || state === 'pastdue' ? d.periodEnd : 0;
          return { kind, id, name, firm: firm || '', plan: PLANS.planOf(plan), state, quantity: qty, monthly, next: next || 0, cancelAtEnd: !!d.cancelAtEnd, graceUntil: d.graceUntil || 0 };
        };
        const rows = [
          ...auth.data.firms.filter(f => f.status === 'active' && !firmExempt(f.id)).map(f => row('firm', f.id, f.name, f.plan, f.billing, '', f.legacy)),
          ...reg.list().filter(c => c.payer === 'client' && !c.archived).map(c => { const f = auth.firm(c.firmId) || {}; return row('company', c.id, c.name, c.clientPlan || f.plan, c.billing, f.id === user.firmId ? '' : f.name, c.clientPlan ? c.clientLegacy : f.legacy); }),
        ];
        const by = s => rows.filter(r => r.state === s);
        const due = rows.filter(r => r.state === 'pastdue' || ((r.state === 'trialing' || r.state === 'active') && r.next && r.next <= week))
          .sort((a, b) => (a.state === 'pastdue' ? 0 : 1) - (b.state === 'pastdue' ? 0 : 1) || a.next - b.next);
        out.subs = {
          total: rows.length, paying: by('active').length, trial: by('trialing').length, failed: by('pastdue').length, stopped: by('stopped').length, notStarted: by('none').length,
          firms: rows.filter(r => r.kind === 'firm' && ['active', 'trialing', 'pastdue'].includes(r.state)).length,
          companies: rows.filter(r => r.kind === 'company' && ['active', 'trialing', 'pastdue'].includes(r.state)).length,
          monthly: Math.round(rows.filter(r => r.state === 'active' || r.state === 'pastdue').reduce((t, r) => t + r.monthly, 0) * 100) / 100,
          trialMonthly: Math.round(by('trialing').reduce((t, r) => t + r.monthly, 0) * 100) / 100,
          due, waiting: by('none').slice(0, 10), rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
        };
      }
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
            byPlan: Object.fromEntries(Object.keys(PLANS.PLANS).map(k => [k, count(current, l => l.until >= today && PLANS.planOf(l.plan) === k)])),
            byKind: { firm: count(current, l => l.until >= today && (l.kind || 'firm') === 'firm'), business: count(current, l => l.until >= today && l.kind === 'business') },
            due: current.filter(l => l.until <= soon && l.until >= longAgo).sort((a, b) => a.until.localeCompare(b.until))
              .map(({ id, name, email, plan, kind, until }) => ({ id, name, email, plan: PLANS.planOf(plan), kind: kind || 'firm', until })),
          };
        } else out.licences = { noKey: true };
      }
      return out;
    }],
    // Year-end files started, by firm and month, for charging per file. month: YYYY-MM (this month when left out).
    ['GET', /^\/api\/overview\/yearends$/, (req, m, res, user) => {
      adminOnly(user);
      backfillYearEnds();
      const q = new URL(req.url, 'http://x').searchParams, now = opts.now ? opts.now() : new Date();
      const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : localDay(now).slice(0, 7);
      const all = yeUsage.list().map(x => ({ ...x, month: localDay(new Date(x.startedAt)).slice(0, 7) }));
      const months = [...new Set([localDay(now).slice(0, 7), ...all.map(x => x.month)])].sort().reverse();
      const by = new Map();
      for (const x of all.filter(x => x.month === month).sort((a, b) => a.startedAt - b.startedAt)) {
        const f = auth.firm(x.firmId);
        const row = by.get(x.firmId) || { firmId: x.firmId, firmName: f ? f.name : x.firmName || 'Removed firm', mine: x.firmId === user.firmId, exempt: firmExempt(x.firmId), files: [] };
        row.files.push({ companyId: x.companyId, companyName: (reg.get(x.companyId) || {}).name || x.companyName, yearEnd: x.yearEnd, startedAt: x.startedAt, by: x.by });
        by.set(x.firmId, row);
      }
      const firms = [...by.values()].map(r => ({ ...r, count: r.files.length })).sort((a, b) => (a.exempt - b.exempt) || b.count - a.count || a.firmName.localeCompare(b.firmName));
      return { month, months, firms, total: firms.reduce((t, r) => t + r.count, 0), billable: firms.filter(r => !r.exempt).reduce((t, r) => t + r.count, 0) };
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
      const rec = issuer.make({ name: b.name, email: b.email, plan: b.plan, kind: b.kind || 'firm', maxCompanies: b.maxCompanies ?? null, period: b.period || 'annual', until: b.until, note: b.note, renews: b.renews });
      auth.log('licence-made', { by: user.username, licence: rec.id, name: rec.name, plan: rec.plan, kind: rec.kind, until: rec.until });
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
    // The firm's logo, for the compilation report and letters in year-end files (a small JPEG, made in the browser).
    ['GET', /^\/api\/firm\/logo$/, (req, m, res, user) => {
      if (!user || user.role === 'client') throw new ValidationError('Not found.', 404);
      const f = auth.firm(user.firmId);
      if (!f || !f.logo) throw new ValidationError('No logo yet.', 404);
      const buf = Buffer.from(f.logo, 'base64');
      send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
    }],
    ['PUT', /^\/api\/firm\/logo$/, async (req, m, res, user) => {
      if (!user || user.role !== 'owner') throw new ValidationError('Only an owner can change the firm’s logo.', 403);
      const body = (await readJson(req, 1024 * 1024)) || {};
      const data = body.data ? Buffer.from(String(body.data), 'base64') : null;
      if (data && !(data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)) throw new ValidationError('The logo must be a JPEG picture.');
      if (data && data.length > 300 * 1024) throw new ValidationError('That logo is over 300 KB. Try a smaller picture.', 413);
      auth.setFirmLogo(user.firmId, data ? data.toString('base64') : '', user);
      return { ok: true, logo: !!data };
    }],
    ['GET', /^\/api\/firms$/, (req, m, res, user) => {
      adminOnly(user);
      const firms = auth.data.firms.map(f => {
        const people = auth.firmUsers(f.id), owner = people.find(u => u.role === 'owner');
        const { logo, ...fNoLogo } = f;
        return { ...fNoLogo, hasLogo: !!logo, users: people.length, companies: reg.list(f.id).length, owner: owner ? { name: owner.name, username: owner.username } : null, lastLogin: Math.max(0, ...people.map(u => u.lastLogin || 0)),
          aiSpentUsd: Math.round(ai.firmSpent(f.id) * 100) / 100, main: f.id === auth.mainFirmId, plan: PLANS.planOf(f.plan), legacy: f.legacy || '', billPayroll: !!f.billPayroll, early: f.early || [],
          payrollCompanies: reg.list(f.id).filter(c => !c.archived && c.payroll).length, billing: undefined, subscription: billingDescribe(f.billing) };
      });
      return { firms, signups: auth.signups, defaultPlan: auth.defaultPlan, myFirm: user.firmId, plans: PLANS.PLANS, legacy: PLANS.LEGACY, features: PLANS.FEATURES, addons: PLANS.ADDONS };
    }],
    ['PUT', /^\/api\/firms\/settings$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      if (b.signups !== undefined) auth.setSignups(b.signups);
      if (b.defaultPlan !== undefined) auth.setDefaultPlan(b.defaultPlan);
      auth.log('security-changed', { by: user.username, ...(b.signups !== undefined ? { signups: b.signups } : {}), ...(b.defaultPlan !== undefined ? { defaultPlan: b.defaultPlan } : {}) });
      return { ok: true, signups: auth.signups, defaultPlan: auth.defaultPlan };
    }],
    // Invite a firm: it's active straight away, and its owner gets an invitation link to choose a password.
    ['POST', /^\/api\/firms\/invite$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      const out = auth.inviteFirm({ firmName: b.firmName, name: b.name, username: b.email, plan: b.plan }, user);
      return { ok: true, firm: out.firm, user: out.user };
    }],
    ['PUT', /^\/api\/firms\/([^/]+)$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      const patch = {};
      for (const k of ['status', 'name', 'ai', 'aiCapUsd', 'plan', 'legacy', 'billPayroll', 'early']) if (b[k] !== undefined) patch[k] = b[k];
      const f = auth.updateFirm(decodeURIComponent(m[1]), patch, user);
      // A new plan or price reaches the firm's subscription; payroll billing changes its add-on line.
      if (patch.plan !== undefined || patch.legacy !== undefined) await syncFirmPlan(f.id);
      else if (patch.billPayroll !== undefined) await syncFirmCount(f.id);
      broadcast({ companies: true, firmId: f.id });
      const { logo, ...fNoLogo } = f;
      return { ok: true, firm: fNoLogo };
    }],
    // Sign-in help for another firm's owners (the administrator): their own owners look after everyone else in the firm.
    ['GET', /^\/api\/firms\/([^/]+)\/owners$/, (req, m, res, user) => {
      adminOnly(user);
      const f = auth.firm(decodeURIComponent(m[1]));
      if (!f) throw new ValidationError('That firm doesn’t exist.', 404);
      return { firm: { id: f.id, name: f.name, status: f.status }, owners: auth.firmUsers(f.id).filter(u => u.role === 'owner').map(u => auth.publicUser(u)) };
    }],
    ['POST', /^\/api\/firms\/([^/]+)\/owners\/([^/]+)\/(link|unlock|reset2fa)$/, (req, m, res, user) => {
      adminOnly(user);
      const fid = decodeURIComponent(m[1]), uid = decodeURIComponent(m[2]), u = auth.byId(uid);
      if (!u || u.firmId !== fid || u.role !== 'owner') throw new ValidationError('That user doesn’t exist.', 404);
      if (m[3] === 'unlock') return { ok: true, user: auth.unlock(uid, user, true) };
      if (m[3] === 'reset2fa') return { ok: true, user: auth.reset2fa(uid, user, true) };
      const out = auth.issueLink(uid, user, true);
      auth.log(out.kind === 'invite' ? 'invite-link' : 'reset-link', { username: u.username, by: user.username });
      return { ok: true, ...out, user: auth.publicUser(u) };
    }],
    ['DELETE', /^\/api\/firms\/([^/]+)$/, (req, m, res, user) => {
      adminOnly(user);
      const id = decodeURIComponent(m[1]);
      auth.deleteFirm(id, user, reg.list(id).length);
      return { ok: true };
    }],
    /*
     * The firm's year-ends on one screen: for each company the person can open, its last fiscal year-end, the year-end
     * file for it (status, progress, review notes, client requests, team) and the usual deadlines. Companies with a
     * 4-digit code not opened in this session show only their name and dates.
     */
    ['GET', /^\/api\/yearends$/, (req, m, res, user) => {
      if (!user || user.role === 'client') throw new ValidationError('Not found.', 404);
      const today = localDay(opts.now ? opts.now() : new Date()), out = [];
      for (const c of reg.list(user.firmId).filter(c => canSeeCo(user, c.id) && !c.archived)) {
        let ctx; try { ctx = ctxFor(c.id); } catch { continue; }
        if (!featureOn(c.id, 'yearEndFiles', ctx.store)) continue;
        const s = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
        const lastEnd = ENGAGE.fyEnd(dayBeforeIso(ENGAGE.fyStart(today, s.fyStart)), s.fyStart);
        const row = { id: c.id, name: s.name, orgType: s.orgType || 'business', lastEnd, deadlines: ENGAGE.deadlines(lastEnd) };
        try { codeGate(user, c.id, ctx.store); } catch { out.push({ ...row, locked: true }); continue; }
        const files = ctx.store.list('engagements').sort((a, b) => b.yearEnd.localeCompare(a.yearEnd));
        const f = files.find(x => x.yearEnd === lastEnd) || null, accounts = ctx.store.list('accounts'), atts = ctx.store.list('attachments'), reqs = ctx.store.list('requests');
        const sum = x => { const p = ENGAGE.progress(x, accounts, atts); return { id: x.id, yearEnd: x.yearEnd, status: ENGAGE.statusOf(x.status), pct: p.pct, openNotes: p.openNotes, preparer: (x.team && x.team.preparer && x.team.preparer.name) || '', reviewer: (x.team && x.team.reviewer && x.team.reviewer.name) || '',
          waiting: reqs.filter(r => r.engagementId === x.id && ['open', 'returned'].includes(r.status)).length, answered: reqs.filter(r => r.engagementId === x.id && r.status === 'sent').length, deadlines: ENGAGE.deadlines(x.yearEnd) }; };
        const prev = files.find(x => x.yearEnd < lastEnd);
        out.push({ ...row, file: f ? sum(f) : null, previous: prev ? { id: prev.id, yearEnd: prev.yearEnd, status: ENGAGE.statusOf(prev.status) } : null });
      }
      return { today, companies: out.sort((a, b) => a.deadlines.t2.localeCompare(b.deadlines.t2) || a.name.localeCompare(b.name)) };
    }],
    /*
     * Start the last fiscal year-end's file for several companies at once, straight from their books. A company whose
     * previous file is final rolls forward from it (its final figures become the prior year). Companies with a file
     * already, a locked code, or books that don't balance are skipped and say why.
     */
    ['POST', /^\/api\/yearends\/start$/, async (req, m, res, user) => {
      if (!user || user.role === 'client' || user.readOnly) throw new ValidationError('Only the firm’s staff can start year-end files.', 403);
      const body = (await readJson(req)) || {}, ids = Array.isArray(body.companies) ? body.companies.slice(0, 500).map(String) : [];
      const today = localDay(opts.now ? opts.now() : new Date()), results = [];
      for (const cid of ids) {
        const res1 = { id: cid };
        try {
          if (!canSeeCo(user, cid)) throw new ValidationError('You can’t open that company.', 403);
          const ctx = ctxFor(cid); ctx.user = user;
          codeGate(user, cid, ctx.store);
          if (user.perms) needArea(user, 'accounting', 'edit');
          needFeature(cid, 'yearEndFiles', ctx.store);
          const s = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
          const ye = ENGAGE.fyEnd(dayBeforeIso(ENGAGE.fyStart(today, s.fyStart)), s.fyStart);
          res1.name = s.name; res1.yearEnd = ye;
          const files = ctx.store.list('engagements');
          if (files.some(x => x.yearEnd === ye)) throw new ValidationError('There’s already a file for that year-end.', 409);
          const accounts = ctx.store.list('accounts'), tb = ENGAGE.tbFromEntries(ctx.store.list('entries'), accounts, ye, s.fyStart);
          if (Math.abs(tb.off) >= 0.01 || Math.abs(tb.offPrior) >= 0.01) throw new ValidationError('The books’ trial balance doesn’t add up to zero. Check for unbalanced entries.');
          const prev = files.filter(x => x.yearEnd < ye).sort((a, b) => b.yearEnd.localeCompare(a.yearEnd))[0];
          const roll = prev && ENGAGE.statusOf(prev.status) === 'final' && (!prev.snapshot || !prev.snapshot.source || prev.snapshot.source === 'books');
          const lines = roll ? ENGAGE.withPriorFrom(tb.lines, prev, accounts) : tb.lines;
          const me = { id: user.id, name: user.name || user.username };
          const data = {
            yearEnd: ye, kind: prev ? prev.kind : 'compilation', framework: prev ? prev.framework : (['npo', 'charity'].includes(s.orgType) ? 'ASNPO' : 'ASPE'), entity: prev ? prev.entity || '' : '', status: 'progress',
            snapshot: { takenAt: Date.now(), by: me.name, priorEnd: tb.priorEnd, lines, source: 'books', priorSource: roll ? 'file' : 'books', bulk: true },
            map: prev ? { ...(prev.map || {}) } : {}, ajes: [], wps: {}, reviewNotes: [], checklist: {}, signoffs: {}, notes: '', created: Date.now(),
            client: prev && prev.client && prev.client.legalName ? { ...prev.client } : { legalName: s.name, operatingName: '', address: s.address || '', province: s.province || '', corpNumber: '', bn: s.bn || '', contact: [s.email, s.phone].filter(Boolean).join(' · '), industry: s.industry || '', owners: '' },
            team: { preparer: me, reviewer: prev && prev.team ? prev.team.reviewer : null }, fsNotes: prev ? prev.fsNotes || [] : [], report: prev && prev.report ? { ...prev.report, date: '' } : undefined,
            rolledFrom: prev ? prev.id : '', includeCashFlow: prev ? !!prev.includeCashFlow : false, layout: prev ? prev.layout : undefined, materiality: prev ? prev.materiality : undefined,
          };
          const id = crypto.randomUUID();
          ctx.store.transaction(() => applyWrite(ctx.store, { op: 'set', collection: 'engagements', id, data }, user, ctx));
          ctx.bump();
          Object.assign(res1, { ok: true, fileId: id, rolled: !!roll, accounts: lines.length });
        } catch (e) { Object.assign(res1, { ok: false, error: e.message }); }
        results.push(res1);
      }
      return { results };
    }],
    ['GET', /^\/api\/companies$/, (req, m, res, user) => ({ companies: reg.list(user.firmId).filter(c => canSeeCo(user, c.id)).map(summary).map(c => roleSummary(user, c)), provinces: PROVINCES,
      ...(user.platformAdmin ? { pendingFirms: auth.data.firms.filter(f => f.status === 'pending').length } : {}) })],
    // Invite a single business in one step: its company, and its owner as a client who signs in to see it
    // (and, when subscriptions are on, pays for it themselves). Returns the invitation link to send.
    ['POST', /^\/api\/companies\/invite$/, async (req, m, res, user) => {
      ownerOnly(user);
      checkCompanyLimit();
      const b = await readJson(req);
      if (!String(b.name || '').trim()) throw new ValidationError('Enter the business’s name.');
      if (!String(b.person || '').trim()) throw new ValidationError('Enter the name of the person to invite.');
      const entry = createCompany({ name: b.name, province: b.province, lang: b.lang }, user);
      let u;
      try {
        u = auth.addUser({ name: b.person, username: b.email, role: 'client', companies: [entry.id], readOnly: false, invite: true, firmId: user.firmId });
      } catch (e) {
        reg.remove(entry.id);
        broadcast({ companies: true, firmId: entry.firmId });
        throw e;
      }
      auth.log('user-added', { username: u.username, by: user.username, role: u.role });
      const pays = billing.configured() && b.clientPays !== false;
      if (pays) reg.update(entry.id, { payer: 'client', clientPlan: PLANS.PLANS[b.plan] || PLANS.LEGACY[b.plan] ? PLANS.planOf(b.plan) : PLANS.planOf((auth.firm(user.firmId) || {}).plan) });
      syncFirmCount(user.firmId);
      return { ok: true, company: summary(reg.get(entry.id)), user: u, clientPays: pays };
    }],
    ['POST', /^\/api\/companies$/, async (req, m, res, user) => {
      ownerOnly(user);
      checkCompanyLimit();
      const body = await readJson(req);
      const entry = createCompany(body, user);
      // A type of business that comes with an add-on (a scrap yard) turns it on, unless the owner unticked it.
      const addon = PLANS.ADDON_FOR_INDUSTRY[(reg.store(entry.id).getSetting('company') || {}).industry];
      let addonError = '';
      if (addon && body[addon] !== false) {
        try { await setAddonFor(entry.id, addon, true); auth.log('addon-changed', { username: user.username, company: entry.id, addon, on: true }); }
        catch (e) { addonError = `The company was made, but the ${PLANS.ADDONS[addon].label} add-on couldn’t be added: ${e.message} Add it from Settings.`; }
      }
      syncFirmCount(user.firmId);
      return { ok: true, company: summary(reg.get(entry.id)), ...(addonError ? { addonError } : {}) };
    }],
    ['PUT', /^\/api\/companies\/([^/]+)$/, async (req, m, res, user) => {
      const body = await readJson(req);
      const id = decodeURIComponent(m[1]);
      if (!canSeeCo(user, id)) throw new ValidationError('That company doesn’t exist.', 404);
      const addonKeys = Object.keys(PLANS.ADDONS).filter(k => body[k] !== undefined);
      if (body.archived !== undefined || body.payer !== undefined || addonKeys.length) ownerOnly(user);
      const patch = {};
      if (body.archived !== undefined) patch.archived = !!body.archived;
      if (body.payer !== undefined) patch.payer = body.payer === 'client' ? 'client' : 'firm';
      // Bringing an archived company back counts against a firm licence's limit.
      if (patch.archived === false && reg.get(id).archived) checkCompanyLimit({ restoring: true });
      if (body.opened) { patch.lastOpened = Date.now(); checkWorkflowsSoon(id); }
      reg.update(id, patch);
      // Add-ons cost money each month, so they're only ever on when an owner turns them on here
      // (or picks a type of business that comes with one when making the company).
      for (const k of addonKeys) {
        await setAddonFor(id, k, body[k] === true);
        auth.log(k === 'assistant' ? 'assistant-changed' : 'addon-changed', { username: user.username, company: id, ...(k === 'assistant' ? {} : { addon: k }), on: body[k] === true });
        broadcast({ companies: true, firmId: reg.get(id).firmId });
      }
      if (patch.archived !== undefined) broadcast({ companies: true, firmId: reg.get(id).firmId });
      if (patch.archived !== undefined || patch.payer !== undefined) syncFirmCount(reg.get(id).firmId);
      return { ok: true, company: summary(reg.get(id)) };
    }],
    // Remove a company created by mistake: only while it has no transactions or documents (otherwise archive it).
    ['DELETE', /^\/api\/companies\/([^/]+)$/, async (req, m, res, user) => {
      ownerOnly(user);
      const id = decodeURIComponent(m[1]);
      if (!canSeeCo(user, id)) throw new ValidationError('That company doesn’t exist.', 404);
      const c = reg.get(id), store = reg.store(id);
      const used = ['entries', 'docs', 'estimates', 'recurring', 'delayed', 'bankTxns', 'receipts', 'payruns', 'filings', 'attachments'].some(k => store.list(k).length);
      if (used) throw new ValidationError('This company has transactions or documents, so it can’t be removed. Archive it instead to hide it from the list.', 409);
      if (c.billing && billingPaid(c.billing)) throw new ValidationError('This company’s client has a Sumlora subscription running. Cancel it first (Stripe → Subscriptions), then remove the company.', 409);
      await plaid.removeCompany(id).catch(() => {});
      await ledgers.remove(id).catch(() => {});
      inSet.drop(id);
      reg.remove(id);
      auth.dropCompany(id);
      auth.log('company-removed', { by: user.username, company: c.name });
      broadcast({ companies: true, firmId: c.firmId });
      syncFirmCount(c.firmId);
      return { ok: true };
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
    // Bank feeds (Plaid): the keys are the server's, set by its administrator. Others only learn whether feeds are available.
    ['GET', /^\/api\/plaid$/, (req, m, res, user) => {
      if (user.role === 'owner' && user.platformAdmin) return { ...plaid.status(true), admin: true };
      return { configured: plaid.configured() && user.role !== 'client' };
    }],
    ['PUT', /^\/api\/plaid$/, async (req, m, res, user) => {
      adminOnly(user);
      const body = await readJson(req);
      const st = plaid.update(body);
      auth.log('plaid-settings', { username: user.username, ip: clientIp(req), change: body.secret !== undefined || body.clientId !== undefined ? 'Plaid keys changed' : 'settings changed' });
      return st;
    }],
    // QuickBooks Online and Xero: the app keys are the server's, set by its administrator.
    ['GET', /^\/api\/ledgers$/, (req, m, res, user) => {
      if (user.role === 'owner' && user.platformAdmin) return { ...ledgers.status(), admin: true, redirectUri: appUrl() ? appUrl() + '/api/ledger/callback' : '' };
      const st = ledgers.status();
      return { qbo: { configured: st.qbo.configured }, xero: { configured: st.xero.configured } };
    }],
    ['PUT', /^\/api\/ledgers$/, async (req, m, res, user) => {
      adminOnly(user);
      const body = (await readJson(req)) || {};
      const st = ledgers.update(body);
      auth.log('ledger-settings', { username: user.username, ip: clientIp(req), change: ['qbo', 'xero'].filter(p => body[p]).map(p => p === 'qbo' ? 'QuickBooks Online keys changed' : 'Xero keys changed').join(', ') || 'settings changed' });
      return { ...st, admin: true, redirectUri: appUrl() ? appUrl() + '/api/ledger/callback' : '' };
    }],
    // Intuit or Xero sends the person back here after they allow the connection (no session cookie comes along: see ledgers.finish).
    ['GET', /^\/api\/ledger\/callback$/, async (req, m, res) => {
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const page = (title, text) => send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head><body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;line-height:1.5"><h1 style="font-size:22px">${escHtml(title)}</h1><p>${escHtml(text)}</p><p><a href="/">Back to Sumlora</a></p></body></html>`, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      try {
        const r = await ledgers.finish(q);
        const c = reg.get(r.companyId);
        auth.log('ledger-connected', { by: r.by, company: c ? c.name : r.companyId, provider: r.provider === 'qbo' ? 'QuickBooks Online' : 'Xero' });
        page(`Connected to ${r.provider === 'qbo' ? 'QuickBooks Online' : 'Xero'}`, `${r.name ? r.name + ' is' : 'The books are'} now connected to ${c ? c.name : 'the company'} in Sumlora. You can close this tab and go back to Sumlora.`);
      } catch (err) {
        if (!err.status) console.error(err);
        page('The connection wasn’t made', err.status ? err.message : 'Something went wrong on the server. Try connecting again.');
      }
    }],
    // Receipts by email: the administrator turns it on, names the domain and gets the webhook address for the mail provider.
    ['GET', /^\/api\/inbound$/, (req, m, res, user) => {
      if (!(user.role === 'owner' && user.platformAdmin)) return { ready: inSet.ready() };
      const st = inSet.status();
      return { ...st, admin: true, webhook: st.secret ? `${originOf(req)}/api/inbound/email/${st.secret}` : '' };
    }],
    ['PUT', /^\/api\/inbound$/, async (req, m, res, user) => {
      adminOnly(user);
      const body = await readJson(req);
      const st = inSet.update(body);
      auth.log('inbound-settings', { username: user.username, ip: clientIp(req), change: body.newSecret ? 'webhook secret changed' : `receipts by email ${st.on ? 'on' : 'off'} (${st.domain || 'no domain'})` });
      return { ...st, admin: true, webhook: `${originOf(req)}/api/inbound/email/${st.secret}` };
    }],
    // Sumlora subscriptions: the administrator's settings.
    ['GET', /^\/api\/billing$/, (req, m, res, user) => { adminOnly(user); return billing.status(); }],
    ['PUT', /^\/api\/billing$/, async (req, m, res, user) => {
      adminOnly(user);
      const body = await readJson(req);
      const st = await billing.update(body);
      auth.log('billing-settings', { username: user.username, ip: clientIp(req), change: body.key !== undefined ? 'Stripe key changed' : body.tax !== undefined && Object.keys(body).length === 1 ? `sales tax ${body.tax ? 'on' : 'off'}` : 'prices or trial changed' });
      return st;
    }],
    // Monthly invoices to the firms and clients using this server, for an administrator who's paid by e-Transfer
    // (or any way other than Stripe). The invoices are made in one of the administrator's own companies; the
    // browser builds them like any other invoice. This only reports who to bill and for what.
    ['GET', /^\/api\/invoicing$/, (req, m, res, user) => {
      adminOnly(user);
      const set = auth.data.settings.invoicing || {};
      const amounts = billing.offer().amounts;
      const ownCos = reg.list(user.firmId).filter(c => !c.archived).map(c => ({ id: c.id, name: c.name }));
      const emailOf = u => u && mail.EMAIL_RE.test(u.username) ? u.username : '';
      // Payroll employees are billed the month after they're paid (this month's invoice has last month's).
      const lastMonth = PLANS.prevMonth(new Date().toISOString().slice(0, 10));
      const customers = [];
      for (const f of auth.data.firms) {
        if (firmExempt(f.id) || f.status !== 'active') continue;
        const cos = reg.list(f.id).filter(c => !c.archived && c.payer !== 'client');
        const owner = auth.firmUsers(f.id).find(u => u.role === 'owner' && !u.disabled);
        customers.push({ key: 'firm:' + f.id, name: f.name, email: emailOf(owner), person: owner ? owner.name : '', plan: PLANS.planOf(f.plan), priceKey: PLANS.priceKey(f.plan, f.legacy),
          companies: cos.length, assistant: cos.filter(c => addonBilled(c, 'assistant')).length, addons: addonCounts(cos), employees: employeesPaidIn(cos, lastMonth), employeesMonth: lastMonth });
      }
      // Companies whose client pays for themselves (marked on the company), in any firm.
      for (const c of reg.list()) {
        if (c.archived || c.payer !== 'client') continue;
        const f = auth.firm(c.firmId);
        if (!f || f.status !== 'active') continue;
        const client = auth.data.users.find(u => u.role === 'client' && !u.disabled && (u.companies || []).includes(c.id));
        const pp = payPlan(c);
        customers.push({ key: 'co:' + c.id, name: c.name, email: emailOf(client), person: client ? client.name : '', plan: pp.plan, priceKey: PLANS.priceKey(pp.plan, pp.legacy),
          companies: 1, assistant: addonBilled(c, 'assistant') ? 1 : 0, addons: addonCounts([c]), employees: employeesPaidIn([c], lastMonth), employeesMonth: lastMonth });
      }
      return { companyId: ownCos.some(c => c.id === set.companyId) ? set.companyId : '', tax: set.tax !== false, companies: ownCos, amounts, plans: { ...PLANS.LEGACY, ...PLANS.PLANS }, addons: PLANS.ADDONS, units: PLANS.UNITS, customers };
    }],
    ['PUT', /^\/api\/invoicing$/, async (req, m, res, user) => {
      adminOnly(user);
      const b = await readJson(req);
      const set = { ...(auth.data.settings.invoicing || {}) };
      if (b.companyId !== undefined) {
        const id = String(b.companyId || '');
        if (id && !reg.list(user.firmId).some(c => c.id === id && !c.archived)) throw new ValidationError('Choose one of your own firm’s companies.');
        set.companyId = id;
      }
      if (b.tax !== undefined) set.tax = b.tax !== false;
      auth.data.settings.invoicing = set;
      auth.save();
      auth.log('security-changed', { by: user.username, change: 'monthly invoicing settings' });
      return { ok: true, companyId: set.companyId || '', tax: set.tax !== false };
    }],
    // What this person has to pay for (if anything), read fresh from Stripe when it's a few hours old.
    ['GET', /^\/api\/billing\/me$/, async (req, m, res, user) => {
      if (!billing.configured()) return { configured: false };
      const mine = user.role === 'client' ? reg.list(user.firmId).filter(c => canSeeCo(user, c.id) && c.payer === 'client' && !c.archived) : [];
      await refreshBilling([user.firmId], mine.map(c => c.id));
      const f = auth.firm(user.firmId);
      return { configured: true, offer: billing.offer(), plans: PLANS.PLANS, legacy: PLANS.LEGACY, addons: PLANS.ADDONS, units: PLANS.UNITS,
        firm: { exempt: firmExempt(user.firmId), needs: firmNeedsPay(f), plan: PLANS.planOf(f && f.plan), legacy: (f && f.legacy) || '', companies: firmCount(user.firmId), canPay: user.role === 'owner', ...billingDescribe(f && f.billing) },
        companies: mine.map(c => { const pp = payPlan(c); return { id: c.id, name: c.name, needs: coNeedsPay(c), plan: pp.plan, legacy: pp.legacy, ...billingDescribe(c.billing) }; }) };
    }],
    // Start (or restart) a subscription on Stripe's page. The free trial is only the first time.
    ['POST', /^\/api\/billing\/checkout$/, async (req, m, res, user) => {
      const b = await readJson(req);
      const f = auth.firm(user.firmId);
      if (b.kind === 'firm') {
        ownerOnly(user);
        if (firmExempt(user.firmId)) throw new ValidationError('Your firm doesn’t pay for Sumlora on this server.');
        if (billingPaid(f.billing)) throw new ValidationError('Your firm’s subscription is already running.');
        const plan = PLANS.PLANS[b.plan] ? b.plan : PLANS.planOf(f.plan);
        // The firm's own plan keeps its old price; another plan is at that plan's price.
        return { url: await billing.checkout({ kind: 'firm', id: f.id, plan, legacy: plan === PLANS.planOf(f.plan) ? f.legacy || '' : '', quantity: firmCount(f.id), addons: Object.fromEntries(Object.keys(PLANS.ADDONS).map(k => [k, firmAddons(f.id, k)])), email: user.username, customer: f.billing && f.billing.customer, trial: !(f.billing && f.billing.hadTrial), base: originOf(req) }) };
      }
      const c = reg.get(String(b.id || ''));
      if (b.kind !== 'company' || !c || !canSeeCo(user, c.id) || c.payer !== 'client') throw new ValidationError('That company doesn’t exist.', 404);
      if (billingPaid(c.billing)) throw new ValidationError('This company’s subscription is already running.');
      const pp = payPlan(c);
      return { url: await billing.checkout({ kind: 'company', id: c.id, plan: pp.plan, legacy: pp.legacy, quantity: 1, addons: addonCounts([c]), email: user.username, customer: c.billing && c.billing.customer, trial: !(c.billing && c.billing.hadTrial), base: originOf(req) }) };
    }],
    // Back from Stripe's page: record the subscription.
    ['POST', /^\/api\/billing\/finish$/, async (req, m, res, user) => {
      const b = await readJson(req);
      const r = await billing.finish(b.session);
      if (r.kind === 'firm' && r.id === user.firmId && user.role === 'owner') {
        auth.setFirmBilling(r.id, r.record, r.record.plan);
        auth.log('subscription-started', { username: user.username, firm: r.id, status: r.record.status });
        await syncFirmCount(r.id);
        return { ok: true, kind: 'firm', ...billingDescribe(auth.firm(r.id).billing) };
      }
      const c = reg.get(r.id);
      if (r.kind === 'company' && c && canSeeCo(user, c.id) && c.payer === 'client') {
        reg.update(c.id, { billing: r.record });
        auth.log('subscription-started', { username: user.username, company: c.id, status: r.record.status });
        return { ok: true, kind: 'company', ...billingDescribe(r.record) };
      }
      throw new ValidationError('That payment belongs to someone else.', 403);
    }],
    // Stripe's page to change the card, see invoices or cancel.
    ['POST', /^\/api\/billing\/portal$/, async (req, m, res, user) => {
      const b = await readJson(req);
      let rec = null;
      if (b.kind === 'firm') { ownerOnly(user); rec = (auth.firm(user.firmId) || {}).billing; }
      else { const c = reg.get(String(b.id || '')); if (c && canSeeCo(user, c.id) && c.payer === 'client' && user.role === 'client') rec = c.billing; }
      if (!rec || !rec.customer) throw new ValidationError('There’s no subscription to manage yet.', 404);
      return { url: await billing.portal(rec.customer, originOf(req)) };
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
    // Live clock sessions: server timestamps, committed atomically and recovered after refresh.
    ['POST', /^\/time\/clock-in$/, async (ctx, req) => {
      const cfg=ctx.store.getSetting('company')||{};
      if(cfg.features?.timesheets!==true)throw new ValidationError('Timesheets & Tips is disabled.',403);
      if(ctx.user.role==='client')throw new ValidationError('Manager or staff sign-in required.',403);
      needArea(ctx.user,'timesheets','edit');
      const {employeeId}=await readJson(req);
      if(typeof employeeId!=='string'||!ctx.store.get('shiftworkers',employeeId)||ctx.store.get('shiftworkers',employeeId).active===false)throw new ValidationError('Select an active team member.');
      let session;
      ctx.store.transaction(()=>{
        if(ctx.store.get('clockins',employeeId))throw new ValidationError('This team member is already clocked in.',409);
        session={employeeId,startedAt:new Date().toISOString(),startedBy:ctx.user.id||ctx.user.username};
        ctx.store.put('clockins',employeeId,session);
        ctx.store.audit(ctx.user,'set',{collection:'clockins',id:employeeId,summary:'Clocked in team member'});
      });
      ctx.bump();return {session};
    }],
    ['POST', /^\/time\/clock-out$/, async (ctx, req) => {
      const cfg=ctx.store.getSetting('company')||{};
      if(cfg.features?.timesheets!==true)throw new ValidationError('Timesheets & Tips is disabled.',403);
      if(ctx.user.role==='client')throw new ValidationError('Manager or staff sign-in required.',403);
      needArea(ctx.user,'timesheets','edit');
      const input=await readJson(req);const employeeId=String(input.employeeId||'');
      const breakMinutes=Number(input.breakMinutes||0),direct=Number(input.directTips||0),controlled=Number(input.controlledTips||0);
      if(!Number.isInteger(breakMinutes)||breakMinutes<0||![direct,controlled].every(v=>Number.isFinite(v)&&v>=0&&v<=1000000&&Math.abs(v*100-Math.round(v*100))<1e-6))throw new ValidationError('Invalid breaks or tips.');
      let saved;
      ctx.store.transaction(()=>{
        const open=ctx.store.get('clockins',employeeId);if(!open)throw new ValidationError('No active clock-in for this team member.',409);
        const startMs=Date.parse(open.startedAt),endMs=Date.now(),elapsed=Math.floor((endMs-startMs)/60000);
        if(!Number.isFinite(startMs)||elapsed<1||elapsed>1440)throw new ValidationError('Shift duration requires manager review (maximum 24 hours).',409);
        if(breakMinutes>=elapsed)throw new ValidationError('Break must be shorter than the shift.');
        const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
        const parts=ms=>Object.fromEntries(clock.formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
        const a=parts(startMs),b=parts(endMs);
        const data={date:a.year+'-'+a.month+'-'+a.day,employeeId,start:a.hour+':'+a.minute,end:b.hour+':'+b.minute,breakMinutes,workedMinutes:elapsed-breakMinutes,tips:direct+controlled,directTips:direct,controlledTips:controlled,tipType:controlled?'controlled':'direct',notes:'Server clock-in/out',startedAt:open.startedAt,endedAt:new Date(endMs).toISOString()};
        const id=crypto.randomUUID();
        saved={id,...data};
        ctx.store.put('workshifts',id,data);
        ctx.store.delete('clockins',employeeId);
        ctx.store.audit(ctx.user,'set',{collection:'workshifts',id,summary:'Clocked out team member'});
      });
      ctx.bump();return {shift:saved};
    }],
    ['GET', /^\/time\/summary$/, ctx => {
      const cfg = ctx.store.getSetting('company') || {};
      if (!cfg.features || cfg.features.timesheets !== true) throw new ValidationError('Timesheets & Tips is not enabled for this company.', 403);
      if (ctx.user.role === 'client') throw new ValidationError('Time clock requires an authorized staff account.', 403);
      needArea(ctx.user, 'timesheets', 'view');
      return { workers: ctx.store.list('shiftworkers').filter(w => w.active !== false).map(w => ({ id:w.id, name:w.name })), shifts: ctx.store.list('workshifts'), active: ctx.store.list('clockins').map(s=>({employeeId:s.employeeId,startedAt:s.startedAt})) };
    }],
    ['GET', /^\/state$/, ctx => state(ctx)],
    ['PUT', /^\/records\/([A-Za-z]+)\/([^/]+)$/, async (ctx, req, m) => {
      const data = await readJson(req);
      const w = { op: 'set', collection: m[1], id: decodeURIComponent(m[2]), data };
      ctx.store.transaction(() => { applyWrite(ctx.store, w, ctx.user, ctx); checkDocumentPostings(ctx.store, [w]); });
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
      ctx.store.transaction(() => {
        if (body.expectedRev !== undefined && (!Number.isSafeInteger(body.expectedRev) || body.expectedRev !== ctx.rev)) throw new ValidationError('The books changed while this calculation was open. Reload and calculate it again.', 409);
        body.writes.forEach(w => applyWrite(ctx.store, w, ctx.user, ctx));
        checkDocumentPostings(ctx.store, body.writes);
      });
      return { ok: true, rev: ctx.bump() };
    }],
    ['PUT', /^\/settings$/, async (ctx, req) => {
      notClient(ctx.user);
      const before = ctx.store.getSetting('company');
      const company = validateCompany(await readJson(req));
      company.logoFile = (before && before.logoFile) || ''; // changed only through the logo route
      if (ctx.user.perms) {
        const prev = validateCompany({ ...DEFAULT_COMPANY, ...(before || {}) });
        // Tags: anyone who can change transactions can add a new tag from a form; renaming or removing tags needs Accounting.
        const tagsChanged = JSON.stringify([prev.tags, prev.tagGroups]) !== JSON.stringify([company.tags, company.tagGroups]);
        if (tagsChanged && tagsOnlyAdded(prev, company) && ['sales', 'expenses', 'banking', 'accounting'].some(a => canArea(ctx.user, a, 'edit'))) { prev.tags = company.tags; prev.tagGroups = company.tagGroups; }
        else if (tagsChanged) needArea(ctx.user, 'accounting', 'edit'); // everyone sees the tags, so say no rather than quietly keep them
        roleSettings(ctx.user, company, prev);
      }
      // A tag still on transactions can't just disappear from the list (they'd point at nothing): take it off them first.
      const gone = new Set(((before && before.tags) || []).map(t => t.id).filter(id => !company.tags.some(t => t.id === id)));
      if (gone.size) {
        const on = r => Array.isArray(r && r.tags) && r.tags.some(id => gone.has(id));
        if (['entries', 'docs', 'rules', 'delayed', 'estimates', 'recurring'].some(c => ctx.store.list(c).some(on)) || ctx.store.list('bankTxns').some(b => on(b.cat))) throw new ValidationError('That tag is still on transactions. Remove it from them first.', 409);
      }
      // Plan features: can't be turned on here when the plan doesn't include them (settings already saved stay as they were).
      if (company.quickMethod && company.quickMethod.on && !(before && before.quickMethod && before.quickMethod.on)) needFeature(ctx.id, 'specialTax', ctx.store);
      // Classes are in Thrive: making one, or turning on classes on each line. Classes already made stay usable on every plan
      // (picked on transactions, renamed, turned off, in reports), so no one loses what they've sorted.
      const hadCls = new Set(((before && before.classes) || []).map(c => c.id));
      if (company.classes.some(c => !hadCls.has(c.id)) || (company.classPerLine && !(before && before.classPerLine))) needFeature(ctx.id, 'classes', ctx.store);
      // Bill approvals: only owners decide them (staff could otherwise make themselves approvers), and only on a plan that has them.
      // Approvers must be people in this firm.
      const firmId = (reg.get(ctx.id) || {}).firmId;
      const inFirm = a => ({ ...a, approvers: a.approvers.filter(uid => { const u = auth.byId(uid); return u && u.firmId === firmId && u.role !== 'client'; }) });
      company.approvals = inFirm(company.approvals);
      const prevAp = inFirm(APPROVALS.clean(before && before.approvals));
      if (JSON.stringify(company.approvals) !== JSON.stringify(prevAp)) {
        if (ctx.user.role !== 'owner') throw new ValidationError('Only an owner can change bill approvals.', 403);
        if (company.approvals.on && !prevAp.on) needFeature(ctx.id, 'billApprovals', ctx.store);
      }
      if (!featureOn(ctx.id, 'advancedReports', ctx.store) && JSON.stringify(company.savedReports || []) !== JSON.stringify((before && before.savedReports) || [])) {
        const added = (company.savedReports || []).some(r => !((before && before.savedReports) || []).some(b => b.id === r.id));
        if (added) needFeature(ctx.id, 'advancedReports', ctx.store);
      }
      // Workflow reminders: turned on or changed only when the plan includes them. Chosen people must be in this firm.
      company.workflows = { rules: Object.fromEntries(Object.entries(company.workflows.rules).map(([k, r]) => [k, { ...r, people: r.people.filter(uid => { const u = auth.byId(uid); return u && u.firmId === firmId && u.role !== 'client'; }) }])) };
      for (const [k, r] of Object.entries(company.workflows.rules)) if (r.on && r.who === 'people' && !r.people.length) throw new ValidationError(`${WF.TEMPLATES[k].label}: choose at least one person to remind.`);
      const prevWf = (() => { try { return WF.clean(before && before.workflows); } catch { return { rules: {} }; } })();
      if (JSON.stringify(company.workflows) !== JSON.stringify(prevWf) && WF.anyOn(company.workflows)) needFeature(ctx.id, 'workflows', ctx.store);
      // Payroll settings (remitting frequencies, overtime, EHT, WSIB, stub emails, direct deposit) change only when payroll
      // is on for this company (Thrive, or the Payroll add-on); settings saved earlier stay as they were.
      if (JSON.stringify(company.payroll) !== JSON.stringify(validateCompany({ ...DEFAULT_COMPANY, ...(before || {}) }).payroll)) needFeature(ctx.id, 'payroll', ctx.store);
      // The cash flow forecast's own settings (planned items, lines left out) change only when the plan includes it.
      if (JSON.stringify(company.cashForecast) !== JSON.stringify(validateCompany({ ...DEFAULT_COMPANY, ...(before || {}) }).cashForecast)) needFeature(ctx.id, 'cashForecast', ctx.store);
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
      return { ...mail.publicMail(m), sentToday: Number(ctx.store.getMeta('mail-sent:' + (opts.now ? opts.now() : new Date()).toISOString().slice(0, 10)) || 0) };
    }],
    ['PUT', /^\/mail$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'settings');
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
      // A test is part of setting up email; sending goes with what's sent (invoices, purchase orders, reports, pay stubs).
      if (m[1] === 'test') needArea(ctx.user, 'settings');
      else if (!['sales', 'expenses', 'reports', 'payroll'].some(a => canArea(ctx.user, a, 'view'))) needArea(ctx.user, 'sales', 'view');
      const cfg = ctx.store.getSetting('mail');
      if (!cfg || !cfg.host) throw new ValidationError('Set up email for this company first (Settings → Email).', 409);
      const dayKey = 'mail-sent:' + (opts.now ? opts.now() : new Date()).toISOString().slice(0, 10);
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
      // A pay stub: recorded on its pay run line, and it only goes to that employee's own email address.
      let stub = null;
      if (m[1] === 'send' && body.what === 'paystub') {
        needArea(ctx.user, 'payroll', 'view');
        needFeature(ctx.id, 'payroll', ctx.store);
        const run = ctx.store.get('payruns', String(body.payrunId || ''));
        const li = run ? (run.lines || []).findIndex(l => l.employeeId === String(body.employeeId || '')) : -1;
        if (li < 0) throw new ValidationError('That pay stub isn’t in this pay run.', 404);
        if (run.void) throw new ValidationError('That pay run was voided, so its pay stubs aren’t sent.', 409);
        const emp = ctx.store.get('employees', run.lines[li].employeeId) || {};
        if (to.length !== 1 || cc.length || to[0].toLowerCase() !== String(emp.email || '').trim().toLowerCase()) throw new ValidationError('A pay stub goes only to the employee’s own email address.');
        stub = { run, li };
      }
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
      // Estimates emailed are recorded too, so a workflow rule can follow up on ones sent and not accepted.
      const estIds = (Array.isArray(body.estimateIds) ? body.estimateIds : []).map(String).slice(0, 50);
      ctx.store.transaction(() => {
        for (const id of docIds) {
          const d = ctx.store.get('docs', id);
          if (d) ctx.store.put('docs', id, { ...d, sent: [...(d.sent || []).slice(-19), { at: Date.now(), to: to.join(', '), by: ctx.user.name || ctx.user.username, what: ['invoice', 'reminder', 'statement', 'credit', 'sreceipt', 'po'].includes(body.what) ? body.what : 'document' }] });
        }
        for (const id of estIds) {
          const x = ctx.store.get('estimates', id);
          if (x) ctx.store.put('estimates', id, { ...x, sent: [...(Array.isArray(x.sent) ? x.sent : []).slice(-19), { at: Date.now(), to: to.join(', '), by: ctx.user.name || ctx.user.username, what: 'estimate' }] });
        }
        if (stub) {
          const r = ctx.store.get('payruns', stub.run.id), l = r.lines[stub.li];
          ctx.store.put('payruns', r.id, { ...r, lines: r.lines.map((x, i) => (i === stub.li ? { ...l, sent: [...(l.sent || []).slice(-9), { at: Date.now(), to: to[0], by: ctx.user.name || ctx.user.username }] } : x)) });
        }
        ctx.store.audit(ctx.user, 'email', { summary: `${m[1] === 'test' ? 'test email' : 'emailed'} “${subject.slice(0, 80)}” to ${to.join(', ').slice(0, 120)}` });
      });
      return { ok: true, rev: docIds.length || estIds.length || stub ? ctx.bump() : ctx.rev };
    }],
    // ---------- workflow reminders ----------
    // Dismiss a reminder, or snooze it for some days: only in the list of the person asking.
    ['POST', /^\/reminders\/([^/]+)$/, async (ctx, req, m) => {
      notClient(ctx.user);
      needFeature(ctx.id, 'workflows', ctx.store);
      const body = (await readJson(req)) || {};
      let next;
      try { next = WF.act(ctx.store.getSetting('reminders'), decodeURIComponent(m[1]), ctx.user.id, body.action, body.days, wfToday()); }
      catch (e) { throw new ValidationError(e.message, /isn’t in your list/.test(e.message) ? 404 : 400); }
      ctx.store.putSetting('reminders', next);
      return { ok: true, rev: ctx.bump() };
    }],
    // Check the rules now (Settings → Workflows), instead of waiting for the hourly check.
    ['POST', /^\/workflows\/check$/, async ctx => {
      notClient(ctx.user); needArea(ctx.user, 'settings');
      needFeature(ctx.id, 'workflows', ctx.store);
      const out = await checkWorkflows(ctx.id);
      if (out.skipped) throw new ValidationError('The rules are being checked already. Try again in a moment.', 409);
      return { ok: true, ...out, rev: ctx.rev };
    }],
    // ---------- bill approvals ----------
    // The people who could be approvers (Settings → Bill approvals): owners and staff of the firm.
    ['GET', /^\/approvers$/, ctx => {
      notClient(ctx.user);
      const c = reg.get(ctx.id);
      return { people: auth.firmUsers(c.firmId).filter(u => u.role !== 'client' && !u.disabled && auth.canSee(u, ctx.id)).map(u => { const cr = auth.customRoleOf(u); return { id: u.id, name: u.name, username: u.username, role: u.role, roleName: cr ? cr.name : '', approveBills: !!(cr && cr.approveBills) }; }) };
    }],
    // Approve or reject a bill waiting for approval (with a comment), or send a rejected bill for approval again.
    ['POST', /^\/approvals\/([^/]+)$/, async (ctx, req, m) => {
      notClient(ctx.user);
      needFeature(ctx.id, 'billApprovals', ctx.store);
      const settings = (ctx.store.getSetting('company') || {}).approvals;
      if (!APPROVALS.clean(settings).on) throw new ValidationError('Bill approvals are turned off for this company.', 409);
      const body = (await readJson(req)) || {};
      const action = ['approve', 'reject', 'resubmit'].includes(body.action) ? body.action : '';
      if (!action) throw new ValidationError('Choose approve or reject.');
      const comment = String(body.comment || '').trim().slice(0, 500);
      const id = decodeURIComponent(m[1]), doc = ctx.store.get('docs', id);
      if (!doc || doc.kind !== 'bill') throw new ValidationError('That bill doesn’t exist.', 404);
      if (action === 'resubmit') {
        needArea(ctx.user, 'expenses', 'edit');
        if (!doc.approval || doc.approval.status !== 'rejected') throw new ValidationError('Only a rejected bill can be sent for approval again.', 409);
      } else {
        needArea(ctx.user, 'expenses', 'view');
        if (action === 'reject' && !comment) throw new ValidationError('Say why the bill is rejected, so the person who entered it knows what to fix.');
        const owners = auth.firmUsers((reg.get(ctx.id) || {}).firmId).filter(u => u.role === 'owner' && !u.disabled).length;
        const why = APPROVALS.whyNot(ctx.user, settings, doc, owners);
        if (why) throw new ValidationError(why, why.startsWith('This bill') ? 409 : 403);
      }
      const after = APPROVALS.decide(doc, action, ctx.user, comment);
      ctx.store.transaction(() => {
        ctx.store.put('docs', id, after);
        const word = { approve: 'approved', reject: 'rejected', resubmit: 'sent for approval again' }[action];
        ctx.store.audit(ctx.user, action, { collection: 'docs', id, summary: `bill${doc.number ? ' #' + doc.number : ''} ${doc.date} $${(Number(doc.total) || 0).toFixed(2)} ${word}${comment ? ': ' + comment.slice(0, 120) : ''}`, before: doc, after });
      });
      return { ok: true, status: after.approval.status, rev: ctx.bump() };
    }],
    // Batch "Mark as sent": invoices that went out some other way (by hand, by post, from another mailbox) get the
    // same "sent" record an email adds, with no address. Like the email record, it isn't a change to the books,
    // so it's allowed in a closed period.
    ['POST', /^\/docs\/mark-sent$/, async (ctx, req) => {
      needArea(ctx.user, 'sales'); // a change to the invoices, like sending them
      const body = (await readJson(req)) || {};
      if (!Array.isArray(body.docIds) || !body.docIds.length) throw new ValidationError('Pick at least one invoice.');
      if (body.docIds.length > 1000) throw new ValidationError('Mark at most 1,000 invoices at a time.');
      const ids = [...new Set(body.docIds.map(x => String(x).slice(0, 120)))];
      const docs = ids.map(id => ctx.store.get('docs', id));
      if (docs.some(d => !d)) throw new ValidationError('One of those invoices no longer exists. Refresh and try again.', 404);
      if (docs.some(d => d.kind !== 'invoice')) throw new ValidationError('Only invoices can be marked as sent.');
      const at = Date.now(), by = ctx.user.name || ctx.user.username;
      ctx.store.transaction(() => {
        for (const d of docs) ctx.store.put('docs', d.id, { ...d, sent: [...(d.sent || []).slice(-19), { at, to: '', by, what: 'marked' }] });
        ctx.store.audit(ctx.user, 'email', { summary: `marked ${docs.length} invoice${docs.length === 1 ? '' : 's'} as sent: ${docs.map(d => d.number || d.id).join(', ').slice(0, 160)}` });
      });
      return { ok: true, marked: docs.length, rev: ctx.bump() };
    }],
    // ---------- online payments (Stripe) ----------
    ['GET', /^\/pay$/, ctx => { const p = stripe.publicStripe(ctx.store.getSetting('stripe')); return ctx.user.role === 'client' ? { configured: p.configured } : p; }],
    ['PUT', /^\/pay$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'settings');
      const body = (await readJson(req)) || {};
      if (body.remove) {
        ctx.store.transaction(() => { ctx.store.putSetting('stripe', {}); ctx.store.audit(ctx.user, 'stripe', { collection: 'settings', id: 'stripe', summary: 'online payments turned off' }); });
        return stripe.publicStripe(null);
      }
      const key = String(body.key || '').trim();
      if (!stripe.validKey(key)) throw new ValidationError('That doesn’t look like a Stripe key. It starts with rk_live_ (or rk_test_ to try it out).');
      const cfg = { key, connected: new Date().toISOString().slice(0, 10) };
      try { await stripe.check(cfg, stripeFetch); } catch (e) { throw new ValidationError(e.message, e.status || 502); }
      ctx.store.transaction(() => { ctx.store.putSetting('stripe', cfg); ctx.store.audit(ctx.user, 'stripe', { collection: 'settings', id: 'stripe', summary: `online payments turned on (${/_test_/.test(key) ? 'test' : 'live'} key ending ${key.slice(-4)})` }); });
      return stripe.publicStripe(cfg);
    }],
    // A "Pay now" link for an invoice's balance. Kept while the balance is the same; replaced when it changes.
    ['POST', /^\/pay\/link$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'sales');
      const cfg = ctx.store.getSetting('stripe');
      if (!cfg || !cfg.key) throw new ValidationError('Turn on online payments first (Settings → Online payments).', 409);
      const body = (await readJson(req)) || {};
      // An invoice's balance, or the deposit still to be paid on an estimate.
      const est = body.estimateId !== undefined, col = est ? 'estimates' : 'docs';
      const doc = ctx.store.get(col, String((est ? body.estimateId : body.docId) || ''));
      if (est ? !doc : !doc || doc.kind !== 'invoice') throw new ValidationError(est ? 'Choose an estimate.' : 'Choose an invoice.');
      if (doc.currency) throw new ValidationError('Card payment links are for invoices in Canadian dollars.', 409);
      if (est && doc.invoiceId && ctx.store.get('docs', doc.invoiceId)) throw new ValidationError('This estimate is already an invoice. Send the invoice’s pay link instead.', 409);
      const cents = est ? Math.round(DEP.outstanding(doc, ctx.store.list('entries')) * 100) : Math.round(((Number(doc.total) || 0) - settledOn(ctx.store, doc.id)) * 100);
      if (cents < 50) throw new ValidationError(est ? 'There’s no deposit left to pay on this estimate.' : 'There’s nothing left to pay on this invoice.', 409);
      const cur = doc.payLink;
      if (cur && cur.active !== false && cur.cents === cents) return { url: cur.url, rev: ctx.rev };
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      let link;
      try { link = await stripe.createLink(cfg, stripeFetch, { cents, docId: doc.id, company: company.name, name: `${company.name} · ${est ? 'Deposit on estimate' : 'Invoice'} ${doc.number || ''}`.trim() }); }
      catch (e) { throw new ValidationError(e.message, e.status || 502); }
      // The old link is turned off, but kept on the list so a payment made through it before then is still found.
      const closed = cur && cur.id && cur.active !== false ? await stripe.deactivate(cfg, stripeFetch, cur.id).then(() => Date.now(), () => 0) : 0;
      ctx.store.transaction(() => {
        const d = ctx.store.get(col, doc.id);
        if (d) ctx.store.put(col, doc.id, { ...d, payLink: { id: link.id, url: link.url, cents, created: Date.now(), active: true }, payLinks: payLinkList(d, closed) });
        ctx.store.audit(ctx.user, 'stripe', { collection: col, id: doc.id, summary: `payment link for ${est ? 'the deposit on estimate' : 'invoice'} ${doc.number ? '#' + doc.number : doc.id}: $${(cents / 100).toFixed(2)}` });
      });
      return { url: link.url, rev: ctx.bump() };
    }],
    // Record payments made through the links: each paid checkout session becomes a payment into the Stripe account.
    // Every link an invoice has had is checked until it's been paid or has been turned off for a week, so a payment
    // made through an old link is still found. A payment that can't be recorded (more than what's owing) is kept on
    // the invoice as a problem to deal with, never dropped.
    ['POST', /^\/pay\/sync$/, async ctx => {
      notClient(ctx.user); needArea(ctx.user, 'sales');
      const cfg = ctx.store.getSetting('stripe');
      if (!cfg || !cfg.key) return { added: [], errors: [], rev: ctx.rev };
      const recorded = new Set(ctx.store.list('entries').filter(e => e.stripeSession).map(e => e.stripeSession));
      const week = 7 * 864e5, now = Date.now();
      // Invoices, and estimates with a deposit link (est: true; a payment there is a deposit received).
      const entriesNow = ctx.store.list('entries');
      const docs = [...ctx.store.list('docs').filter(d => d.kind === 'invoice' && (d.payLinks || d.payLink)),
        ...ctx.store.list('estimates').filter(d => d.payLinks || d.payLink).map(d => ({ ...d, est: true }))];
      const found = [], errors = [], closeNow = [];
      outer: for (const d of docs) {
        const known = new Set((d.payIssues || []).map(x => x.session));
        const balance = d.est ? Math.round(DEP.outstanding(d, entriesNow) * 100) : Math.round(((Number(d.total) || 0) - settledOn(ctx.store, d.id)) * 100);
        for (const l of payLinkList(d)) {
          if (l.done || (l.closed && now - l.closed > week)) continue;
          // The balance changed some other way (a payment entered by hand, the invoice edited): this link is out of date.
          if (d.payLink && d.payLink.id === l.id && d.payLink.active !== false && d.payLink.cents !== balance) closeNow.push({ d, l });
          try { for (const x of await stripe.paidSessions(cfg, stripeFetch, l.id)) if (!recorded.has(x.id) && !known.has(x.id)) found.push({ d, l, s: x }); }
          catch (e) { errors.push(e.message); break outer; }
        }
      }
      for (const c of closeNow) c.closedOk = await stripe.deactivate(cfg, stripeFetch, c.l.id).then(() => true, () => false);
      const added = [], issues = [];
      ctx.store.transaction(() => {
        let acc = ctx.store.list('accounts').find(a => a.stripe);
        const ar = ctx.store.list('accounts').find(a => a.detail === 'ar' && a.active !== false) || ctx.store.list('accounts').find(a => a.detail === 'ar');
        const touched = new Map(); // doc id -> { done: Set(link ids), issues: [] }
        const mark = (id, est) => { if (!touched.has(id)) touched.set(id, { done: new Set(), issues: [], col: est ? 'estimates' : 'docs' }); return touched.get(id); };
        for (const { d, l, s } of found) {
          const amount = s.cents / 100, t = new Date(s.created * 1000);
          const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
          mark(d.id, d.est).done.add(l.id);
          try {
            if (!acc) {
              const id = ctx.store.get('accounts', 'a1090') ? crypto.randomUUID() : 'a1090';
              applyWrite(ctx.store, { op: 'set', collection: 'accounts', id, data: { code: ctx.store.list('accounts').some(a => a.code === '1090') ? '' : '1090', name: 'Stripe', type: 'Asset', detail: 'bank', stripe: true, active: true,
                desc: 'Online payments received through Stripe, until Stripe pays them out to your bank. Record payouts as transfers to your bank, and Stripe’s fees as an expense.' } }, ctx.user, ctx);
              acc = ctx.store.get('accounts', id);
            }
            const id = 'stripe_' + s.id.replace(/[^A-Za-z0-9_]/g, '').slice(-80);
            if (d.est) {
              const dep = depAccount(ctx);
              applyWrite(ctx.store, { op: 'set', collection: 'entries', id, data: { type: 'custdeposit', date, ref: 'Stripe', memo: `Deposit paid online${d.number ? ' · estimate #' + d.number : ''}`, contactId: d.contactId || '', estimateId: d.id, amount, bank: acc.id, method: 'card',
                lines: DEP.lines('custdeposit', dep, acc.id, amount), stripeSession: s.id, created: Date.now() } }, ctx.user, ctx);
            } else applyWrite(ctx.store, { op: 'set', collection: 'entries', id, data: { type: 'payment', date, ref: 'Stripe', memo: `Paid online${d.number ? ' · invoice #' + d.number : ''}`, contactId: d.contactId || '', applyTo: d.id, amount, bank: acc.id,
              lines: [{ account: acc.id, debit: amount, credit: 0 }, { account: ar && ar.id, debit: 0, credit: amount }], stripeSession: s.id, created: Date.now() } }, ctx.user, ctx);
            added.push({ docId: d.id, number: d.number || '', amount, ...(d.est ? { estimate: true } : {}) });
          } catch (e) {
            // Usually: more than what's still owing (paid twice, or an old link after another payment). Kept for a person to sort out.
            const issue = { session: s.id, link: l.id, amount, date, error: String(e.message).slice(0, 200), at: Date.now() };
            mark(d.id, d.est).issues.push(issue); issues.push({ docId: d.id, number: d.number || '', ...issue, ...(d.est ? { estimate: true } : {}) });
          }
        }
        for (const c of closeNow) if (c.closedOk) { const m = mark(c.d.id, c.d.est); m.closed = m.closed || new Set(); m.closed.add(c.l.id); }
        for (const [id, m] of touched) {
          const cur = ctx.store.get(m.col, id); if (!cur) continue;
          const list = payLinkList(cur).map(l => ({ ...l, ...(m.done.has(l.id) ? { done: true } : {}), ...(m.closed && m.closed.has(l.id) && !l.closed ? { closed: Date.now() } : {}) }));
          const pl = cur.payLink && (m.done.has(cur.payLink.id) || (m.closed && m.closed.has(cur.payLink.id))) ? { ...cur.payLink, active: false } : cur.payLink;
          ctx.store.put(m.col, id, { ...cur, payLink: pl, payLinks: list, ...(m.issues.length ? { payIssues: [...(cur.payIssues || []), ...m.issues].slice(-20) } : {}) });
        }
      });
      for (const i of issues) errors.push(`A Stripe payment of $${i.amount.toFixed(2)} for ${i.estimate ? 'the deposit on estimate' : 'invoice'} ${i.number ? '#' + i.number : ''} couldn’t be recorded: ${i.error}`);
      return { added, issues, errors, rev: added.length || issues.length || closeNow.length ? ctx.bump() : ctx.rev };
    }],
    // A problem payment was dealt with by hand (refunded in Stripe, or recorded as a credit): stop showing it.
    ['POST', /^\/pay\/issue$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'sales');
      const body = (await readJson(req)) || {};
      const col = body.estimateId !== undefined ? 'estimates' : 'docs';
      const d = ctx.store.get(col, String((col === 'estimates' ? body.estimateId : body.docId) || ''));
      if (!d || !(d.payIssues || []).some(x => x.session === body.session)) throw new ValidationError('That payment problem isn’t on this invoice.', 404);
      ctx.store.transaction(() => {
        ctx.store.put(col, d.id, { ...d, payIssues: d.payIssues.map(x => (x.session === body.session ? { ...x, resolved: Date.now() } : x)) });
        ctx.store.audit(ctx.user, 'stripe', { collection: col, id: d.id, summary: `marked a Stripe payment problem on ${col === 'estimates' ? 'estimate' : 'invoice'} ${d.number ? '#' + d.number : d.id} as dealt with` });
      });
      return { ok: true, rev: ctx.bump() };
    }],
    // ---------- logo on invoices ----------
    ['PUT', /^\/logo$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'settings');
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
      notClient(ctx.user); needArea(ctx.user, 'settings');
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
      if (!ROLES.editsSomething(ctx.user.perms)) throw new ValidationError('Your role doesn’t allow changes.', 403);
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
    // Bank feeds for this company. Only the bookkeeper's team connects banks (each connection costs money each month).
    // Automatic feeds are in Grow and Thrive (Plaid charges for each connection). A company that connected a bank before
    // its firm moved to Seed keeps that connection working (signing in again to it too), but can't connect new ones.
    ['GET', /^\/feeds$/, ctx => { notClient(ctx.user); needArea(ctx.user, 'banking', 'view'); return { configured: plaid.configured(), items: plaid.list(ctx.id), canConnect: featureOn(ctx.id, 'bankFeeds', ctx.store), inPlan: companyHas(ctx.id, 'bankFeeds') }; }],
    ['POST', /^\/feeds\/link$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'banking');
      const body = await readJson(req);
      if (!body.itemId) needFeature(ctx.id, 'bankFeeds', ctx.store);
      const company = ctx.store.getSetting('company') || {};
      return { linkToken: await plaid.linkToken({ userId: ctx.user.id || ctx.user.username, lang: body.lang || company.lang, itemId: body.itemId ? String(body.itemId) : '', companyId: ctx.id }) };
    }],
    ['POST', /^\/feeds$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'banking');
      const body = await readJson(req);
      needFeature(ctx.id, 'bankFeeds', ctx.store);
      const c = reg.get(ctx.id);
      const item = await plaid.connect({ publicToken: body.publicToken, institution: body.institution, companyId: ctx.id, firmId: c && c.firmId, userName: ctx.user.name || ctx.user.username });
      ctx.store.audit(ctx.user, 'feed', { collection: 'settings', id: 'feeds', summary: `connected a bank feed: ${item.institution}` });
      return { item };
    }],
    ['PUT', /^\/feeds\/([A-Za-z0-9_]+)$/, async (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'banking');
      const body = await readJson(req);
      const links = {};
      for (const [k, v] of Object.entries(body.links || {})) {
        if (!v) continue;
        const a = ctx.store.get('accounts', String(v));
        if (!a || (a.detail !== 'bank' && a.detail !== 'card')) throw new ValidationError('A bank account can only feed a bank or credit card account in your chart of accounts.');
        links[k] = a.id;
      }
      const used = Object.values(links);
      if (new Set(used).size !== used.length) throw new ValidationError('Each Sumlora account can be fed by one bank account only.');
      for (const other of plaid.list(ctx.id)) if (other.id !== m[1]) for (const v of Object.values(other.links)) if (used.includes(v)) throw new ValidationError('That Sumlora account is already fed by another bank connection.');
      const item = plaid.setLinks(m[1], ctx.id, links, body.starts);
      ctx.store.audit(ctx.user, 'feed', { collection: 'settings', id: 'feeds', summary: `changed which accounts the ${item.institution} bank feed fills` });
      return { item };
    }],
    ['POST', /^\/feeds\/([A-Za-z0-9_]+)\/sync$/, async (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'banking');
      const r = await syncFeed(ctx.id, m[1], ctx.user);
      return { ...r, item: plaid.data.items[m[1]] ? plaid.publicItem(m[1]) : null, rev: ctx.rev };
    }],
    ['POST', /^\/feeds\/([A-Za-z0-9_]+)\/reconnected$/, (ctx, req, m) => { notClient(ctx.user); needArea(ctx.user, 'banking'); return { item: plaid.reconnected(m[1], ctx.id) }; }],
    ['DELETE', /^\/feeds\/([A-Za-z0-9_]+)$/, async (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'banking');
      const name = plaid.item(m[1], ctx.id).institution;
      const r = await plaid.remove(m[1], ctx.id);
      ctx.store.audit(ctx.user, 'feed', { collection: 'settings', id: 'feeds', summary: `disconnected the ${name} bank feed` });
      return { ok: true, ...r };
    }],
    ['POST', /^\/bank\/import$/, async (ctx, req) => {
      needArea(ctx.user, 'banking');
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
      notClient(ctx.user); // AI costs money: only the bookkeeper's team uses it needArea(ctx.user, 'banking');
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
    /*
     * Year-end files: AI suggestions for the accountant. 'review' gives review points from the leadsheets and the
     * analysis Sumlora already did; 'note' drafts one financial statement note. Nothing is saved: the screen shows the
     * suggestions as suggestions, and the accountant decides what to use. Firm staff with AI turned on only.
     */
    ['POST', /^\/engagements\/([A-Za-z0-9_-]+)\/ai$/, async (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'accounting', 'view');
      needFeature(ctx.id, 'yearEndFiles', ctx.store); needFirmAi(ctx.id);
      if (!ai.key()) throw new ValidationError('AI isn’t set up on this server yet. The server’s administrator adds the AI key in Settings.', 409);
      const f = ctx.store.get('engagements', m[1]);
      if (!f) throw new ValidationError('That year-end file doesn’t exist.', 404);
      const body = (await readJson(req)) || {};
      const task = body.task === 'note' ? 'note' : 'review';
      const accounts = ctx.store.list('accounts');
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const ls = ENGAGE.leadsheets(f, accounts).map(l => ({ leadsheet: `${l.code} ${l.label}`, prior: l.prior, unadjusted: l.cur, adjustments: l.adj, final: l.final, accounts: l.lines.map(r => `${r.name}: prior ${r.prior}, final ${r.final}`).slice(0, 25) }));
      const st = ENGAGE.statements(f, accounts);
      const ctxData = { entity: (f.client && f.client.legalName) || company.name, industry: (f.client && f.client.industry) || company.industry || '', province: company.province, yearEnd: f.yearEnd, framework: f.framework, engagement: f.kind,
        netIncome: st.is.net, revenue: st.is.revenue, leadsheets: ls, adjustingEntries: (f.ajes || []).map(j => ({ no: j.num, memo: j.memo, amount: j.lines.reduce((t, l) => t + l.debit, 0) })),
        findings: ENGAGE.analyze(f, accounts, ctx.store.list('attachments')).filter(x => x.kind !== 'checklist').map(x => x.text).slice(0, 30), notes: (f.fsNotes || []).map(n => n.title) };
      const rules = 'You assist a Canadian accountant preparing a year-end engagement (signs: balance sheet leadsheets are debit-positive; income and liabilities are negative in the figures). '
        + 'You make suggestions only; the accountant decides. Never state a professional conclusion as settled, never say the statements are correct or complete. Be specific to the figures. Plain English, short. '
        + (task === 'review'
          ? 'Reply with JSON only: {"points":[{"wp":"<leadsheet code or empty>","priority":"high|normal|low","text":"<one review point or question for the preparer or the client>"}]} with at most 10 points, most important first.'
          : `Reply with JSON only: {"title":"<note title>","text":"<draft note wording>"} drafting the financial statement note "${String(body.title || 'Significant accounting policies').slice(0, 120)}" for statements prepared under ${f.framework === 'ASNPO' ? 'ASNPO' : 'ASPE'}. Use only facts in the data; put [square brackets] where the accountant must supply a fact.`);
      const model = ai.settings.model;
      const req1 = { model, max_tokens: 1500, system: rules, messages: [{ role: 'user', content: 'Engagement data:\n' + JSON.stringify(ctxData) }] };
      const r = await ai.reserve(model, Math.ceil(JSON.stringify(req1).length / 3), req1.max_tokens, () => ai.call(req1));
      const usd = ai.record(r.usage || {}, 0, model);
      chargeFirm(ctx.id, usd);
      const text = (Array.isArray(r.content) ? r.content : []).filter(c => c.type === 'text').map(c => c.text).join('');
      let out = {};
      try { out = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { out = {}; }
      ctx.store.audit(ctx.user, 'ai', { collection: 'engagements', id: f.id, summary: `year-end file ${f.yearEnd}: asked AI for ${task === 'note' ? 'a draft note' : 'review points'}` });
      if (task === 'note') return { suggestion: true, title: String(out.title || body.title || '').slice(0, 150), text: String(out.text || '').slice(0, 8000) };
      const codes = new Set([...ENGAGE.LEADSHEETS.map(l => l.code), ...ENGAGE.EXTRA_WPS.map(x => x.code)]);
      return { suggestion: true, points: (Array.isArray(out.points) ? out.points : []).slice(0, 10).map(p => ({ wp: codes.has(String(p.wp || '').split(' ')[0]) ? String(p.wp).split(' ')[0] : '', priority: ['high', 'normal', 'low'].includes(p.priority) ? p.priority : 'normal', text: String(p.text || '').slice(0, 1000) })).filter(p => p.text) };
    }],
    // The AI assistant add-on: answers questions about these books. Read-only; see assistant.js.
    ['POST', /^\/assistant$/, async (ctx, req) => {
      needArea(ctx.user, 'reports', 'view'); // it answers from the whole books
      const info = assistantInfo(ctx.id, ctx.store);
      if (!info.on) throw new ValidationError('The AI assistant isn’t turned on for this company. An owner can add it in Settings.', 403);
      if (!info.ready) throw new ValidationError('The AI assistant isn’t set up on this server yet. The server’s administrator adds the AI key in Settings.', 409);
      if (info.left <= 0) throw new ValidationError(`This company has used its ${info.cap} AI assistant questions for this month. More are available on the 1st.`, 429);
      const f = auth.firm(reg.get(ctx.id).firmId);
      // Firms other than the administrators' still have their monthly AI spending limit.
      if (f && f.id !== auth.mainFirmId && ai.firmSpent(f.id) >= (f.aiCapUsd ?? 10)) throw new ValidationError(`Your firm’s AI limit for this month, $${Number(f.aiCapUsd ?? 10).toFixed(2)}, has been reached. The server’s administrator can raise it.`, 429);
      if (ai.spent() >= ai.settings.capUsd) throw new ValidationError(`This month’s AI limit of $${ai.settings.capUsd.toFixed(2)} has been reached. The server’s administrator can raise it in Settings.`, 429);
      const body = (await readJson(req)) || {};
      const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const key = 'assistant-q:' + assistant.month(Date.now());
      // Count the question before asking, so a burst of questions can't go past the monthly number.
      if (!String(body.question || '').trim()) throw new ValidationError('Type a question.');
      ctx.store.putMeta(key, Number(ctx.store.getMeta(key) || 0) + 1);
      let out;
      try { out = await assistant.ask(ai, ctx.store, company, { question: body.question, history: body.history, lang: body.lang === 'fr' ? 'fr' : ctx.user.lang }); }
      catch (e) { ctx.store.putMeta(key, Math.max(0, Number(ctx.store.getMeta(key) || 0) - 1)); throw e; } // a question that got no answer isn't counted
      chargeFirm(ctx.id, out.usd);
      ctx.store.audit(ctx.user, 'ai', { summary: `asked the AI assistant: ${String(body.question || '').trim().slice(0, 120)}` });
      return { answer: out.answer, links: out.links, assistant: assistantInfo(ctx.id, ctx.store) };
    }],
    // Receipts: a photo or PDF sent from the Receipts screen (often a client's phone).
    ['POST', /^\/receipts$/, async (ctx, req) => {
      // Count every upload today (deleted ones too), so the daily limit can't be dodged.
      needArea(ctx.user, 'expenses');
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
    // Receipts by email: this company's forwarding address, and who may send to it.
    // The address goes with the Receipts inbox (Expenses); who may send to it, and a new address, are Settings.
    ['GET', /^\/receipts\/email$/, ctx => {
      notClient(ctx.user); if (!canArea(ctx.user, 'settings', 'view')) needArea(ctx.user, 'expenses', 'view');
      const feature = featureOn(ctx.id, 'emailReceipts', ctx.store), cfg = ctx.store.getSetting('inboundEmail') || {};
      if (feature && inSet.ready()) inSet.ensure(ctx.id);
      return { feature, ready: inSet.ready(), address: feature ? inSet.address(ctx.id) : '', allowed: cfg.allowed || [], rejected: (cfg.rejected || []).slice(-10).reverse() };
    }],
    ['PUT', /^\/receipts\/email$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'settings');
      needFeature(ctx.id, 'emailReceipts', ctx.store);
      const body = (await readJson(req)) || {};
      const before = ctx.store.getSetting('inboundEmail') || {}, allowed = inbound.cleanAllowed(body.allowed);
      ctx.store.transaction(() => {
        ctx.store.putSetting('inboundEmail', { ...before, allowed });
        ctx.store.audit(ctx.user, 'settings', { collection: 'settings', id: 'inboundEmail', summary: allowed.length ? `receipts by email: only from ${allowed.join(', ')}`.slice(0, 300) : 'receipts by email: from anyone' });
      });
      return { ok: true, allowed };
    }],
    ['POST', /^\/receipts\/email\/new$/, ctx => {
      notClient(ctx.user); needArea(ctx.user, 'settings');
      needFeature(ctx.id, 'emailReceipts', ctx.store);
      if (!inSet.ready()) throw new ValidationError('Receipts by email aren’t set up on this server yet. Ask the server’s administrator.', 409);
      inSet.rotate(ctx.id);
      ctx.store.audit(ctx.user, 'settings', { collection: 'settings', id: 'inboundEmail', summary: 'receipts by email: new address made; the old one stopped working' });
      return { ok: true, address: inSet.address(ctx.id) };
    }],
    /* Questions about a transaction: the team asks, the client answers (or the other way round), the team resolves.
       A message from the client marks it answered; one from the team marks it waiting for the client. */
    ['POST', /^\/questions$/, async (ctx, req) => {
      const body = (await readJson(req)) || {};
      const target = ['entries', 'docs', 'bankTxns'].includes(body.target) ? body.target : '';
      const rec = target && ctx.store.get(target, String(body.targetId || ''));
      if (!rec) throw new ValidationError('That transaction isn’t here any more.', 404);
      needArea(ctx.user, ROLES.recordArea(target, rec), 'view');
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
      needArea(ctx.user, ROLES.recordArea(q.target, ctx.store.get(q.target, q.targetId)), 'view');
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
      if (q) needArea(ctx.user, ROLES.recordArea(q.target, ctx.store.get(q.target, q.targetId)));
      if (q) ctx.store.transaction(() => { ctx.store.delete('questions', q.id); ctx.store.audit(ctx.user, 'delete', { collection: 'questions', id: q.id, summary: `question on ${q.label}`, before: q }); });
      return { ok: true, rev: ctx.bump() };
    }],
    /*
     * Files for a request (the client's bank statement, or the draft statements staff send for approval). A file the
     * client sends also goes on the request's working paper in the year-end file, where staff see it.
     */
    ['POST', /^\/requests\/([A-Za-z0-9_-]+)\/files$/, async (ctx, req, m) => {
      needFeature(ctx.id, 'yearEndFiles', ctx.store);
      const r = ctx.store.get('requests', m[1]);
      if (!r) throw new ValidationError('That request doesn’t exist.', 404);
      const client = ctx.user.role === 'client';
      if (!client) needArea(ctx.user, 'accounting', 'edit');
      if (ctx.user.readOnly) throw new ValidationError('View-only users can’t send files.', 403);
      if (client && r.status === 'accepted') throw new ValidationError('Your accountant has already accepted this. Ask them before sending more.', 409);
      if (ctx.store.list('attachments').filter(x => x.target === 'requests' && x.targetId === r.id).length >= 30) throw new ValidationError('That’s 30 files on this request already.', 409);
      const body = (await readJson(req, 15 * 1024 * 1024)) || {};
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!data.length) throw new ValidationError('That file is empty.');
      if (data.length > 10 * 1024 * 1024) throw new ValidationError('That file is over 10 MB.', 413);
      const mediaType = sniffType(data, body.fileName);
      if (!mediaType) throw new ValidationError('Send a PDF, a photo, or an Excel (.xlsx) or Word (.docx) document.');
      const name = String(body.fileName || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 120);
      const e = ctx.store.get('engagements', r.engagementId);
      const by = { uploadedBy: ctx.user.username, uploadedByName: ctx.user.name || ctx.user.username, uploadedAt: Date.now() };
      ctx.store.transaction(() => {
        const id = crypto.randomUUID(), fileId = crypto.randomUUID();
        ctx.store.putFile(fileId, { mediaType, name, data });
        ctx.store.put('attachments', id, validateRecord('attachments', id, { target: 'requests', targetId: r.id, fileId, name, mediaType, size: data.length, ...by }, ctx.store));
        // From the client: a copy on the working paper (kept even if the request is later deleted).
        if (client && e) {
          const id2 = crypto.randomUUID(), fileId2 = crypto.randomUUID();
          ctx.store.putFile(fileId2, { mediaType, name, data });
          ctx.store.put('attachments', id2, validateRecord('attachments', id2, { target: 'engagements', targetId: e.id, wp: r.wp, fileId: fileId2, name, mediaType, size: data.length, ...by }, ctx.store));
        }
        ctx.store.audit(ctx.user, 'add', { collection: 'requests', id: r.id, summary: `year-end file ${r.yearEnd}: ${client ? 'client sent' : 'attached'} ${name} for request “${r.text.slice(0, 60)}”` });
      });
      return { ok: true, rev: ctx.bump() };
    }],
    /*
     * The year-end bank balance as the bank sees it, for accounts with a bank feed: the bank's balance now, less the bank
     * lines it sent dated after the year-end. Compared with the file's figure on the Cash working paper.
     */
    ['GET', /^\/engagements\/([A-Za-z0-9_-]+)\/bankcheck$/, async (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'accounting', 'view'); needFeature(ctx.id, 'yearEndFiles', ctx.store);
      const e = ctx.store.get('engagements', m[1]);
      if (!e) throw new ValidationError('That year-end file doesn’t exist.', 404);
      const out = [], now = new Date().toISOString().slice(0, 10);
      for (const it of plaid.list(ctx.id)) {
        let bal;
        try { bal = await plaid.balances(it.id, ctx.id); } catch (err) { out.push({ institution: it.institution, error: err.message }); continue; }
        for (const [pid, acct] of Object.entries(it.links || {})) {
          const b = bal.find(x => x.id === pid), a = ctx.store.get('accounts', acct);
          if (!b || !a || !Number.isFinite(b.current)) continue;
          const lines = ctx.store.list('bankTxns').filter(t => t.account === acct && t.feed && t.date > e.yearEnd);
          const after = Math.round(lines.reduce((t, x) => t + (Number(x.amount) || 0), 0) * 100) / 100;
          const credit = b.type === 'credit' || b.type === 'loan';
          // A card or loan: the bank's balance is what's owed (a credit in the books).
          const nowBooks = credit ? -b.current : b.current;
          out.push({ institution: it.institution, account: acct, name: a.name, type: b.type, bankNow: b.current, asOf: now, afterYearEnd: after, linesAfter: lines.length, bankAtYearEnd: Math.round((nowBooks - after) * 100) / 100, since: (it.starts || {})[pid] || '' });
        }
      }
      return { accounts: out };
    }],
    // The company's QuickBooks Online or Xero connection (for year-end files of clients whose books are kept there).
    ['GET', /^\/ledger$/, ctx => { notClient(ctx.user); needArea(ctx.user, 'accounting', 'view'); needFeature(ctx.id, 'yearEndFiles', ctx.store); return ledgers.connection(ctx.id); }],
    ['POST', /^\/ledger\/connect$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'accounting'); needFeature(ctx.id, 'yearEndFiles', ctx.store);
      const body = (await readJson(req)) || {};
      return { url: ledgers.authorizeUrl(String(body.provider || ''), ctx.id, ctx.user, appUrl() ? appUrl() + '/api/ledger/callback' : '') };
    }],
    ['DELETE', /^\/ledger$/, async ctx => {
      notClient(ctx.user); needArea(ctx.user, 'accounting'); needFeature(ctx.id, 'yearEndFiles', ctx.store);
      const was = ledgers.connection(ctx.id);
      await ledgers.remove(ctx.id);
      if (was.connected) auth.log('ledger-disconnected', { by: ctx.user.username, company: (reg.get(ctx.id) || {}).name, provider: was.providerName });
      return ledgers.connection(ctx.id);
    }],
    // The trial balance there at a date: ?start=fiscal year start&end=the date. Read-only.
    ['GET', /^\/ledger\/tb$/, async (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'accounting', 'view'); needFeature(ctx.id, 'yearEndFiles', ctx.store);
      const q = new URL(req.url, 'http://x').searchParams, iso = /^\d{4}-\d{2}-\d{2}$/;
      const start = String(q.get('start') || ''), end = String(q.get('end') || '');
      if (!iso.test(start) || !iso.test(end) || start > end) throw new ValidationError('Give the fiscal year’s start and the date, as YYYY-MM-DD.');
      const c = ledgers.connection(ctx.id);
      return { provider: c.provider, providerName: c.providerName, name: c.name, start, end, lines: await ledgers.trialBalance(ctx.id, start, end) };
    }],
    // Email the company's client users that there are requests waiting (from the server's mailbox).
    ['POST', /^\/engagements\/([A-Za-z0-9_-]+)\/notify$/, async (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'accounting', 'edit'); needFeature(ctx.id, 'yearEndFiles', ctx.store);
      const e = ctx.store.get('engagements', m[1]);
      if (!e) throw new ValidationError('That year-end file doesn’t exist.', 404);
      const open = ctx.store.list('requests').filter(r => r.engagementId === e.id && ['open', 'returned'].includes(r.status));
      if (!open.length) throw new ValidationError('There are no open requests to tell the client about.');
      const sys = sysMail.get(), base = appUrl();
      if (!sys || !sys.host) throw new ValidationError('Email isn’t set up on this server yet. The administrator sets it up under Settings.', 409);
      const c = reg.get(ctx.id), settings = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
      const people = auth.firmUsers(c.firmId).filter(u => u.role === 'client' && !u.disabled && auth.canSee(auth.publicUser(u), ctx.id) && mail.EMAIL_RE.test(u.username));
      if (!people.length) throw new ValidationError('No client user with an email address can open these books. Invite the client first, under Users & security.', 409);
      const firm = auth.firm(c.firmId) || {};
      let sent = 0;
      for (const p of people) {
        const fr = (p.lang || settings.lang) === 'fr';
        const lines = open.slice(0, 30).map(r => `• ${r.text}${r.due ? (fr ? ` (d’ici le ${r.due})` : ` (by ${r.due})`) : ''}`).join('\n');
        const subject = fr ? `${firm.name || 'Votre comptable'} : ${open.length} demande(s) pour la fin d’exercice de ${settings.name}` : `${firm.name || 'Your accountant'}: ${open.length} request(s) for ${settings.name}’s year-end`;
        const text = fr ? `Bonjour ${p.name},\n\nPour la fin d’exercice du ${e.yearEnd}, nous avons besoin de :\n\n${lines}\n\nOuvrez Sumlora${base ? ' (' + base + ')' : ''}, puis Demandes, pour envoyer les documents. Vous pouvez prendre des photos avec l’application Sumlora.\n\n${firm.name || ''}`
          : `Hello ${p.name},\n\nFor the year-end of ${e.yearEnd}, we need:\n\n${lines}\n\nOpen Sumlora${base ? ' (' + base + ')' : ''} and go to Requests to send them. You can take photos with the Sumlora app.\n\n${firm.name || ''}`;
        try { await mail.send(sys, { to: [p.username], subject, text }, wfMailOpts()); sent++; } catch (err) { console.error('Request email couldn’t be sent:', err.message); }
      }
      ctx.store.audit(ctx.user, 'email', { collection: 'engagements', id: e.id, summary: `year-end file ${e.yearEnd}: emailed ${sent} client user(s) about ${open.length} request(s)` });
      if (!sent) throw new ValidationError('The email couldn’t be sent. Check the server’s email settings.', 502);
      return { ok: true, sent };
    }],
    // Attach a PDF or photo to a transaction, invoice or bill.
    ['POST', /^\/attachments$/, async (ctx, req) => {
      notClient(ctx.user);
      const body = (await readJson(req, 15 * 1024 * 1024)) || {};
      const target = body.target === 'docs' ? 'docs' : body.target === 'engagements' ? 'engagements' : 'entries', targetId = String(body.targetId || '');
      const rec0 = ctx.store.get(target, targetId), eng = target === 'engagements';
      if (!rec0) throw new ValidationError(eng ? 'That year-end file doesn’t exist.' : 'Save the transaction first, then attach files to it.', 404);
      needArea(ctx.user, ROLES.recordArea(target, rec0), eng ? 'edit' : 'view');
      if (eng) { needFeature(ctx.id, 'yearEndFiles', ctx.store); if (ENGAGE.statusOf(rec0.status) === 'final') throw new ValidationError('This year-end file is final. Reopen it to add documents.', 409); }
      const max = eng ? 300 : 20;
      if (ctx.store.list('attachments').filter(x => x.target === target && x.targetId === targetId).length >= max) throw new ValidationError(`That’s ${max} files on this ${eng ? 'year-end file' : 'transaction'} already.`, 409);
      // A receipt from the Receipts inbox (photographed on a phone, emailed, or uploaded) attached to a working paper:
      // its file is copied, so the receipt keeps its own and either can be removed later.
      let fromReceipt = null;
      if (eng && body.receiptId) {
        needArea(ctx.user, 'expenses', 'view');
        fromReceipt = ctx.store.get('receipts', String(body.receiptId));
        const rf = fromReceipt && ctx.store.getFile(fromReceipt.fileId);
        if (!rf) throw new ValidationError('That receipt isn’t here any more.', 404);
        body.data = rf.data.toString('base64'); body.fileName = fromReceipt.fileName || rf.name || 'receipt';
      }
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!data.length) throw new ValidationError('That file is empty.');
      if (data.length > 10 * 1024 * 1024) throw new ValidationError('That file is over 10 MB.', 413);
      const mediaType = sniffType(data, eng ? body.fileName : '');
      if (!mediaType) throw new ValidationError(eng ? 'Attach a PDF, a photo, or an Excel (.xlsx) or Word (.docx) document.' : 'Attach a PDF or a photo (JPEG, PNG or WebP).');
      const id = crypto.randomUUID(), fileId = crypto.randomUUID();
      const name = String(body.fileName || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 120);
      const rec = validateRecord('attachments', id, { target, targetId, wp: body.wp, fileId, name, mediaType, size: data.length, uploadedBy: ctx.user.username, uploadedByName: ctx.user.name || ctx.user.username, uploadedAt: Date.now() }, ctx.store);
      ctx.store.transaction(() => {
        ctx.store.putFile(fileId, { mediaType, name, data });
        ctx.store.put('attachments', id, rec);
        ctx.store.audit(ctx.user, 'add', { collection: 'attachments', id, summary: eng ? `year-end file ${rec0.yearEnd}: attached ${name} to working paper ${rec.wp || '(file)'}${fromReceipt ? ' from Receipts' : ''}` : `attached ${name}`, after: rec });
      });
      return { ok: true, id, rev: ctx.bump() };
    }],
    ['GET', /^\/files\/([A-Za-z0-9-]+)$/, (ctx, req, m, res) => {
      const f = ctx.store.getFile(m[1]);
      if (!f) throw new ValidationError('That file isn’t here any more.', 404);
      const engDoc = ctx.store.list('attachments').find(x => x.fileId === m[1] && (x.target === 'engagements' || x.target === 'requests'));
      if (engDoc && ((engDoc.target === 'engagements' && ctx.user.role === 'client') || !featureOn(ctx.id, 'yearEndFiles', ctx.store))) throw new ValidationError('That file isn’t here any more.', 404);
      if (ctx.user.perms) { // a receipt is in Expenses; an attachment goes with its transaction (the logo is for everyone)
        const at = ctx.store.list('attachments').find(x => x.fileId === m[1]);
        if (at) needArea(ctx.user, ROLES.recordArea(at.target, ctx.store.get(at.target, at.targetId)), 'view');
        else if (ctx.store.list('receipts').some(x => x.fileId === m[1])) needArea(ctx.user, 'expenses', 'view');
      }
      const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', [OFFICE.xlsx]: 'xlsx', [OFFICE.docx]: 'docx' }[f.mediaType] || 'bin';
      const safe = (f.name || 'receipt').replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\.[A-Za-z0-9]+$/, '').slice(0, 60) || 'receipt';
      res.writeHead(200, { 'Content-Type': f.mediaType, 'Content-Length': f.data.length, 'Content-Disposition': `${ext === 'xlsx' || ext === 'docx' ? 'attachment' : 'inline'}; filename="${safe}.${ext}"`,
        'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
        // Photos open with nothing allowed to run. (A sandbox would stop the browser's PDF viewer, so PDFs get only the type check.)
        'Content-Security-Policy': f.mediaType === 'application/pdf' ? "frame-ancestors 'none'" : "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      res.end(f.data);
    }],
    ['POST', /^\/receipts\/([A-Za-z0-9-]+)\/read$/, (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'expenses');
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
      notClient(ctx.user); needArea(ctx.user, 'expenses');
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
      // A spreadsheet import (Import data) only adds: products and services too, and never touches an existing record, accounts included.
      const addOnly = body.addOnly === true;
      const cols = addOnly ? ['accounts', 'contacts', 'items', 'entries', 'docs'] : ['accounts', 'contacts', 'entries', 'docs'];
      const ids = new Set();
      for (const w of body.writes) {
        if (!w || ((addOnly || w.collection !== 'accounts') && w.op !== 'set') || !cols.includes(w.collection)) throw new ValidationError(addOnly ? 'An import can only add accounts, customers and vendors, products and services, invoices, bills and journal entries.' : 'An import can only add accounts, contacts, transactions and open invoices or bills.');
        // Only new contacts, transactions and bills; existing ones are never overwritten.
        if ((addOnly || w.collection !== 'accounts') && w.op === 'set' && ctx.store.get(w.collection, String(w.id))) throw new ValidationError('An import can only add new records, not change existing ones.');
        if (addOnly) { const k = w.collection + '/' + w.id; if (ids.has(k)) throw new ValidationError('The same record is listed twice in the import.'); ids.add(k); }
      }
      // Custom roles: Edit in the area of every record the import adds (each is checked again as it's written, but
      // saying so now means no copy of the books is made for an import that can't go ahead).
      if (ctx.user.perms) for (const w of body.writes) needWrite(ctx.user, w.collection, w.op === 'set' ? w.data || {} : null, ctx.store.get(w.collection, String(w.id)));
      const snapDir = path.join(opts.dataDir, 'before-restore');
      fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
      const snap = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), company: ctx.store.getSetting('company') };
      for (const c of COLLECTIONS) snap[c] = ctx.store.list(c);
      fs.writeFileSync(path.join(snapDir, `${ctx.id}-before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(snap), { mode: 0o600 });
      // Keep the 10 most recent copies per company.
      const mine = fs.readdirSync(snapDir).filter(f => f.startsWith(ctx.id + '-before-import-')).sort();
      for (const f of mine.slice(0, -10)) fs.rmSync(path.join(snapDir, f), { force: true });
      const counts = {};
      // Bills brought over from other software were already approved (and often paid) there: approvals don't apply.
      ctx.importing = true;
      ctx.store.transaction(() => {
        body.writes.forEach((w, i) => {
          try { applyWrite(ctx.store, w, ctx.user, ctx); } catch (e) {
            if (e instanceof ValidationError) {
              const x = new ValidationError(`Item ${i + 1} (${w.collection}${w.data && (w.data.name || w.data.number || w.data.date) ? ': ' + String(w.data.name || w.data.number || w.data.date).slice(0, 60) : ''}): ${e.message}`, e.status);
              if (e.closedThrough) x.closedThrough = e.closedThrough; // so the app can offer to unlock the books and try again
              throw x;
            }
            throw e;
          }
          if (w.op === 'set') counts[w.collection] = (counts[w.collection] || 0) + 1;
        });
        checkDocumentPostings(ctx.store, body.writes);
        ctx.store.audit(ctx.user, 'import', { summary: `imported from ${String(body.source || 'another program').slice(0, 60)}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` });
      });
      broadcast({ companies: true, firmId: (reg.get(ctx.id) || {}).firmId });
      return { ok: true, rev: ctx.bump(), counts };
    }],
    // Undo the chart of accounts an import brought in: removes the accounts the import created (not the
    // starter accounts it matched or renamed), but only those nothing uses. The rest stay and are listed.
    ['POST', /^\/accounts\/remove-imported$/, ctx => {
      notClient(ctx.user); needArea(ctx.user, 'accounting');
      const imported = ctx.store.list('accounts').filter(a => a.imported);
      if (!imported.length) throw new ValidationError('There are no imported accounts in these books.', 404);
      // Records that can name an account outside journal lines (items, bank rules, budgets, assets, payroll, settings).
      const refs = JSON.stringify(['items', 'docs', 'budgets', 'assets', 'employees', 'rules', 'recurring', 'estimates', 'pos', 'bankTxns', 'trips']
        .map(c => ctx.store.list(c))) + JSON.stringify(ctx.store.getSetting('company') || {});
      const removed = [], kept = [];
      ctx.store.transaction(() => {
        for (const a of imported) {
          if (refs.includes(JSON.stringify(a.id))) { kept.push(a.name); continue; }
          try { applyWrite(ctx.store, { op: 'delete', collection: 'accounts', id: a.id }, ctx.user, ctx); removed.push(a.name); }
          catch (e) { if (e instanceof ValidationError) kept.push(a.name); else throw e; }
        }
        if (removed.length) ctx.store.audit(ctx.user, 'import', { summary: `removed ${removed.length} imported account${removed.length === 1 ? '' : 's'}` });
      });
      return { ok: true, rev: ctx.bump(), removed: removed.length, kept };
    }],
    ['POST', /^\/examples$/, ctx => {
      notClient(ctx.user); needAllAreas(ctx.user, 'edit');
      if ((ctx.store.getSetting('closing') || {}).date) throw new ValidationError('These books are closed, so example data can’t be added. Try it in a new company.', 423);
      loadExamples(ctx.store);
      ctx.store.audit(ctx.user, 'examples', { summary: 'loaded example data' });
      return { ok: true, rev: ctx.bump() };
    }],
    ['GET', /^\/backup$/, (ctx, req, m, res) => {
      needAllAreas(ctx.user, 'view'); // a backup is the whole books
      const s = state(ctx);
      const body = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), company: s.company };
      for (const c of COLLECTIONS) body[c] = s[c];
      // Year-end files stay in a staff member's backup even while the feature is switched off, so a restore keeps them.
      body.engagements = ctx.user && ctx.user.role !== 'client' ? ctx.store.list('engagements') : [];
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
        // Delayed charges load before the invoices they're on, so link them again from the invoices' lines.
        for (const d of ctx.store.list('docs')) if ((d.lines || []).some(l => l && l.dl)) syncDelayed(ctx.store, d.id, d);
      });
      ctx.store.audit(ctx.user, 'restore', { summary: `restored a backup exported ${String(body.exportedAt || '').slice(0, 10) || 'on an unknown date'}` });
      reg.update(ctx.id, { name: company.name });
      broadcast({ companies: true, firmId: (reg.get(ctx.id) || {}).firmId });
      plaid.resetCompany(ctx.id); // the bank feed reads its history again; lines already in are recognised
      return { ok: true, rev: ctx.bump(), skippedReceipts };
    }],
    // Audit log for this company (owners and staff).
    // Exchange rates: the Bank of Canada's daily rate (Valet API), the latest on or before the date. Cached.
    ['GET', /^\/fx$/, async (ctx, req) => {
      const q = new URL(req.url, 'http://x').searchParams, cur = String(q.get('cur') || '').toUpperCase(), date = String(q.get('date') || '');
      if (!/^[A-Z]{3}$/.test(cur) || cur === 'CAD') throw new ValidationError('Choose a currency other than Canadian dollars.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Choose a date.');
      return fxRate(cur, date);
    }],
    ['GET', /^\/audit$/, (ctx, req) => {
      notClient(ctx.user); needArea(ctx.user, 'settings', 'view');
      const q = new URL(req.url, 'http://x').searchParams;
      const rows = ctx.store.auditList({ before: q.get('before'), from: q.get('from'), to: q.get('to'), username: q.get('user'), collection: q.get('collection'), recordId: q.get('record'), limit: q.get('limit') });
      return { rows: rows.filter(r => auditVisible(ctx.user, r)), users: ctx.store.auditUsers() };
    }],
    ['GET', /^\/audit\/(\d+)$/, (ctx, req, m) => {
      notClient(ctx.user); needArea(ctx.user, 'settings', 'view');
      const r = ctx.store.auditList({ before: Number(m[1]) + 1, limit: 1, full: true })[0];
      if (!r || r.seq !== Number(m[1]) || !auditVisible(ctx.user, r)) throw new ValidationError('That change isn’t in the log.', 404);
      return r;
    }],
  ];

  /* ---------- Receipts by email: the webhook the mail provider calls ----------
     Answers 200 for anything the provider shouldn't send again (an unknown address, a sender that isn't allowed,
     a company without the feature): the reason is in the answer and in that company's Settings → Receipts by email. */
  const inboundHits = new Map(); // company -> { since, n }: emails in the last hour
  function inboundRefuse(cid, from, reason) {
    try {
      const store = reg.store(cid), cfg = store.getSetting('inboundEmail') || {};
      store.putSetting('inboundEmail', { ...cfg, rejected: [...(cfg.rejected || []), { at: Date.now(), from: String(from || '').slice(0, 200), reason }].slice(-20) });
    } catch { /* the refusal is still answered */ }
    return reason;
  }
  async function inboundEmail(req, secret) {
    if (req.method !== 'POST' || !inSet.ready() || !inSet.secretOk(secret)) { req.resume(); return [404, { error: 'Not found' }]; }
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!/^(application\/json|multipart\/form-data)/.test(type)) { req.resume(); return [415, { error: 'Send Postmark’s JSON or SendGrid’s form.' }]; }
    if (Number(req.headers['content-length']) > inbound.LIMITS.request) { req.resume(); return [413, { error: 'That email is too large.' }]; }
    const raw = await readRaw(req, inbound.LIMITS.request);
    let mail;
    if (type.startsWith('application/json')) { let j; try { j = JSON.parse(raw.toString('utf8')); } catch { return [400, { error: 'That isn’t valid JSON.' }]; } mail = inbound.fromPostmark(j); }
    else mail = inbound.fromSendgrid(raw, req.headers['content-type']);
    const cids = [...new Set(mail.recipients.map(a => inSet.companyFor(a)).filter(Boolean))].slice(0, 5);
    if (!cids.length) return [200, { ok: false, ignored: 'No company has that address.' }];
    const total = mail.attachments.reduce((t, a) => t + a.data.length, 0);
    if (total > inbound.LIMITS.email) { cids.forEach(c => inboundRefuse(c, mail.fromEmail, 'The email was over 25 MB.')); return [413, { error: 'The attachments are over 25 MB.' }]; }
    const out = [];
    for (const cid of cids) {
      try { out.push({ company: cid, ...(await inboundDeliver(cid, mail)) }); }
      catch (e) { if (e.status === 429) return [429, { error: e.message }]; throw e; }
    }
    return [200, { ok: out.some(r => r.receipts && r.receipts.length), results: out }];
  }
  async function inboundDeliver(cid, mail) {
    const c = reg.get(cid), f = c && auth.firm(c.firmId);
    if (!c || c.archived || !f || f.status !== 'active') return { rejected: 'The company isn’t taking receipts.' };
    const h = inboundHits.get(cid);
    if (!h || Date.now() - h.since > 3600e3) inboundHits.set(cid, { since: Date.now(), n: 1 });
    else if (++h.n > inbound.LIMITS.perHour) throw new ValidationError('Too many emails for this company this hour. Try again later.', 429);
    if (inboundHits.size > 10000) for (const [k, v] of inboundHits) if (Date.now() - v.since > 3600e3) inboundHits.delete(k);
    if (!featureOn(cid, 'emailReceipts')) return { rejected: inboundRefuse(cid, mail.fromEmail, 'Receipts by email aren’t part of this company’s plan.') };
    if (licence.on && !licence.status().canChange) return { rejected: inboundRefuse(cid, mail.fromEmail, 'The books are view only until the licence is renewed.') };
    if (firmNeedsPay(f) || coNeedsPay(c)) return { rejected: inboundRefuse(cid, mail.fromEmail, 'The Sumlora subscription needs attention.') };
    const ctx = ctxFor(cid), cfg = ctx.store.getSetting('inboundEmail') || {};
    if (!mail.fromEmail) return { rejected: inboundRefuse(cid, '', 'The email had no sender.') };
    if (!inbound.senderAllowed(cfg.allowed, mail.fromEmail)) return { rejected: inboundRefuse(cid, mail.fromEmail, 'The sender isn’t on the list of allowed senders.') };
    // The files that can be receipts: PDFs and photos (by their first bytes), not too big, not a signature logo.
    const files = [], skipped = [];
    for (const a of mail.attachments) {
      const mediaType = inbound.sniffInbound(a.data);
      if (!mediaType) { if (!a.inline) skipped.push(`${a.name || 'file'}: not a PDF or photo`); continue; }
      if (a.inline && a.data.length < inbound.INLINE_MIN) continue;
      if (a.data.length > inbound.LIMITS.attachment) { skipped.push(`${a.name || 'file'}: over 10 MB`); continue; }
      if (files.length >= inbound.LIMITS.files) { skipped.push(`${a.name || 'file'}: more than ${inbound.LIMITS.files} files`); continue; }
      files.push({ data: a.data, mediaType, name: a.name });
    }
    if (!files.length) {
      if (skipped.length) return { rejected: inboundRefuse(cid, mail.fromEmail, `Nothing could be used: ${skipped.join('; ')}.`.slice(0, 300)), skipped };
      const body = String(mail.text || '').trim() || inbound.htmlToText(mail.html);
      if (!body) return { rejected: inboundRefuse(cid, mail.fromEmail, 'The email had no attachment and no text.') };
      files.push({ data: inbound.bodyPdf(mail), mediaType: 'application/pdf', name: (mail.subject || 'Email receipt').slice(0, 100) + '.pdf' });
    }
    // The same daily limit as the Receipts screen.
    const dayKey = 'receipts-sent:' + new Date().toISOString().slice(0, 10), sentToday = Number(ctx.store.getMeta(dayKey) || 0);
    if (sentToday + files.length > 300) return { rejected: inboundRefuse(cid, mail.fromEmail, 'That’s 300 receipts today for this company.') };
    const company = { ...DEFAULT_COMPANY, ...(ctx.store.getSetting('company') || {}) };
    let canRead = ai.status().configured && company.ai && firmAi(cid);
    try { if (canRead) needFirmAi(cid); } catch { canRead = false; }
    const who = { username: 'email', name: mail.fromName ? `${mail.fromName} (${mail.fromEmail})` : mail.fromEmail };
    const ids = [];
    ctx.store.transaction(() => {
      ctx.store.putMeta(dayKey, sentToday + files.length);
      for (const fl of files) {
        const id = crypto.randomUUID(), fileId = crypto.randomUUID();
        const fileName = String(fl.name || 'receipt').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'receipt';
        // AI reads PDFs and the usual photo types; an iPhone's HEIC photo is kept for the bookkeeper to look at.
        const readable = fl.mediaType !== 'image/heic';
        const rec = { fileId, fileName, mediaType: fl.mediaType, size: fl.data.length, uploadedBy: '', uploadedByName: mail.fromEmail, uploadedAt: Date.now(),
          readStatus: canRead && readable ? 'waiting' : 'off', readError: canRead && !readable ? 'AI can’t read HEIC photos. Open it to record it.' : '', status: 'inbox', note: '', entryId: '', docId: '',
          source: 'email', emailFrom: mail.fromEmail, emailSubject: mail.subject.slice(0, 200) };
        ctx.store.putFile(fileId, { mediaType: fl.mediaType, name: fileName, data: fl.data });
        ctx.store.put('receipts', id, rec);
        ctx.store.audit(who, 'add', { collection: 'receipts', id, summary: `Receipt emailed in from ${mail.fromEmail}`, after: rec });
        ids.push({ id, readable });
      }
    });
    for (const r of ids) if (canRead && r.readable) queueRead(cid, r.id);
    ctx.bump();
    return { receipts: ids.map(r => r.id), skipped };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // The mail provider's call: no session (nor the APP_PASSWORD prompt); the long secret in the address is the password.
      const im = url.pathname.match(/^\/api\/inbound\/email\/([^/]*)$/);
      if (im) { const [st, out] = await inboundEmail(req, im[1]); return sendJson(res, st, out); }
      if (opts.password && !authorized(req, opts.password)) {
        return send(res, 401, 'Sign in required', { 'WWW-Authenticate': 'Basic realm="Sumlora", charset="UTF-8"', 'Content-Type': 'text/plain' });
      }
      if (url.pathname.startsWith('/api/employee/')) {
        if(req.method!=='GET'&&!sameOrigin(req))throw new ValidationError('Cross-site request blocked.',403);
        // Employee sessions are separate and scoped to this route family only.
        // Refuse employee authentication on the main accounting host.
        const host=String(req.headers.host||'').split(':')[0].toLowerCase();
        if(host!=='time.sumlora.ca')throw new ValidationError('Employee portal only.',403);
        const api=url.pathname.slice('/api/employee/'.length);
        const findEmployee=(companyId,phone)=>{
          const c=reg.get(companyId),store=c&&reg.store(companyId);
          if(!store||(store.getSetting('company')||{}).features?.timesheets!==true)return null;
          const workers=store.list('shiftworkers').filter(w=>w.active!==false&&w.phone===phone);
          return workers.length===1?{worker:workers[0],store}:null;
        };
        if(req.method==='POST'&&api==='request-code'){
          const body=await readJson(req),phone=employeeAuth.normalizePhone(body.phone),companyId=String(body.companyId||'');
          if(!phone||!reg.get(companyId))throw new ValidationError('Enter a valid phone number and company.',400);
          employeeAuth.checkRate(clientIp(req),phone);
          const match=findEmployee(companyId,phone);
          // Do not reveal phone registration; send codes only to registered, active workers.
          if(match)await employeeAuth.verifyRequest('Verifications',{To:phone,Channel:'sms'});
          return sendJson(res,200,{ok:true,message:'If the phone is registered, a verification code has been sent.'});
        }
        if(req.method==='POST'&&api==='verify-code'){
          const body=await readJson(req),phone=employeeAuth.normalizePhone(body.phone),companyId=String(body.companyId||''),code=String(body.code||'');
          employeeAuth.checkRate(clientIp(req),phone);
          const match=findEmployee(companyId,phone);
          if(!match||!/^\d{4,10}$/.test(code))throw new AuthError('Verification failed.',401);
          const result=await employeeAuth.verifyRequest('VerificationCheck',{To:phone,Code:code});
          if(result.status!=='approved')throw new AuthError('Verification failed.',401);
          return sendJson(res,200,employeeAuth.setSession(res,companyId,match.worker.id));
        }
        if(req.method==='POST'&&api==='logout')return sendJson(res,200,employeeAuth.logout(req,res));
        const sess=employeeAuth.session(req);
        if(!sess)throw new AuthError('Please verify your phone to sign in.',401);
        const current=reg.get(sess.companyId),store=current&&reg.store(sess.companyId);
        const worker=store&&store.get('shiftworkers',sess.employeeId);
        if(!worker||worker.active===false||(store.getSetting('company')||{}).features?.timesheets!==true)throw new AuthError('Employee access is disabled.',403);
        if(req.method==='GET'&&api==='me')return sendJson(res,200,{employee:{id:worker.id,name:worker.name},companyId:sess.companyId});
        if(req.method==='GET'&&api==='shifts'){
          return sendJson(res,200,{active:store.get('clockins',worker.id)||null,shifts:store.list('workshifts').filter(x=>x.employeeId===worker.id).slice(-50)});
        }
        if(req.method==='POST'&&(api==='clock-in'||api==='clock-out')){
          const bodyForEmployee=api==='clock-out'?await readJson(req):{};
          let result;
          store.transaction(()=>{
            if(api==='clock-in'){
              if(store.get('clockins',worker.id))throw new ValidationError('Already clocked in.',409);
              result={employeeId:worker.id,startedAt:new Date().toISOString()};
              store.put('clockins',worker.id,result);
            }else{
              const open=store.get('clockins',worker.id);
              if(!open)throw new ValidationError('No active shift.',409);
              const input=bodyForEmployee;
              const elapsed=Math.floor((Date.now()-Date.parse(open.startedAt))/60000);
              if(elapsed<1||elapsed>1440)throw new ValidationError('Shift duration requires manager review.',409);
              const breaks=Number(input.breakMinutes||0),direct=Number(input.directTips||0),controlled=Number(input.controlledTips||0);
              if(!Number.isInteger(breaks)||breaks<0||breaks>=elapsed||![direct,controlled].every(x=>Number.isFinite(x)&&x>=0&&x<=1000000&&Math.abs(x*100-Math.round(x*100))<1e-6))throw new ValidationError('Invalid breaks or tips.',400);
              const dt=new Date(open.startedAt),ended=new Date();
              const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
              const parts=d=>Object.fromEntries(fmt.formatToParts(d).map(p=>[p.type,p.value]));
              const a=parts(dt),b=parts(ended);
              const row={employeeId:worker.id,date:a.year+'-'+a.month+'-'+a.day,start:a.hour+':'+a.minute,end:b.hour+':'+b.minute,breakMinutes:breaks,workedMinutes:elapsed-breaks,tips:direct+controlled,directTips:direct,controlledTips:controlled,tipType:controlled?'controlled':'direct',startedAt:open.startedAt,endedAt:ended.toISOString(),notes:'Employee mobile clock'};
              const id=crypto.randomUUID();store.put('workshifts',id,row);store.delete('clockins',worker.id);result={id,...row};
            }
          });
          return sendJson(res,200,{ok:true,result});
        }
        return sendJson(res,404,{error:'Not found'});
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req)) throw new ValidationError('Cross-site request blocked.', 403);
        // Everything except signing in needs a signed-in user.
        let user = null;
        if (!/^\/api\/(health|ledger\/callback|auth\/(me|setup|signup|login|login\/code|logout|link|link\/accept|forgot))$/.test(url.pathname)) {
          user = auth.userFor(req);
          if (!user) throw new AuthError(auth.needsSetup() ? 'Set up your owner account first.' : 'Your session ended. Please sign in again.', 401, { setup: auth.needsSetup(), forgot: !auth.needsSetup() && forgotReady() });
          if (user.mustChange && !['/api/auth/password', '/api/auth/prefs', '/api/events'].includes(url.pathname)) throw new AuthError('Choose a new password before continuing.', 403, { mustChange: true });
          if (user.mustEnroll && !/^\/api\/(auth\/(password|prefs|2fa\/start|2fa\/confirm)|events)$/.test(url.pathname)) throw new AuthError('Set up two-step sign-in before continuing.', 403, { mustEnroll: true });
          if (!termsOk(user) && !/^\/api\/(auth\/.*|events)$/.test(url.pathname)) throw new AuthError('Read and agree to the Terms of service and Privacy policy to continue.', 403, { mustAgree: true });
          // A firm that hasn't started (or has stopped) paying for Sumlora: only signing in and paying work.
          if (firmNeedsPay(auth.firm(user.firmId)) && !/^\/api\/(auth\/.*|billing(\/.*)?|events)$/.test(url.pathname)) {
            throw new AuthError(user.role === 'owner' ? 'Start your firm’s Sumlora subscription to continue.' : user.role === 'client' ? 'Your bookkeeper’s Sumlora subscription needs attention. Ask them to sign in.' : 'Your firm’s Sumlora subscription needs attention. Ask your firm’s owner.', 402, { billing: 'firm' });
          }
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
          // Dismissing or snoozing one's own reminder isn't a change to the books, so view-only people can do it too.
          if (user.readOnly && req.method !== 'GET' && cm[2] !== '/code/check' && !/^\/reminders\/[^/]+$/.test(cm[2])) throw new ValidationError('Your account is view only, so you can’t make changes.', 403);
          // A client who pays for this company opens it once their subscription is running. The bookkeeper's team isn't held up.
          if (user.role === 'client' && coNeedsPay(reg.get(cid))) throw new AuthError('Start your Sumlora subscription for this company to open it.', 402, { billing: 'company', companyId: cid });
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
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message, ...(err.setup !== undefined ? { setup: err.setup } : {}), ...(err.setupCode ? { setupCode: true } : {}), ...(err.signups ? { signups: err.signups } : {}), ...(err.forgot ? { forgot: true } : {}), ...(err.mustChange ? { mustChange: true } : {}), ...(err.mustEnroll ? { mustEnroll: true } : {}), ...(err.mustAgree ? { mustAgree: true } : {}), ...(err.billing ? { billing: err.billing, companyId: err.companyId || '' } : {}), ...(err.restart ? { restart: true } : {}), ...(err.closedThrough ? { closedThrough: err.closedThrough } : {}), ...(err.codeRequired ? { codeRequired: true } : {}), ...(err.licence ? { licence: true } : {}), ...(err.licenceSetup ? { licenceSetup: err.licenceSetup } : {}) });
    }
  });

  server.on('close', () => { closing = true; backups.stop(); if (feedTimer) clearInterval(feedTimer); if (wfTimer) clearInterval(wfTimer); if (billTimer) clearInterval(billTimer); reg.closeAll(); });
  /** Stop accepting requests, end live-update streams, and close the databases. */
  server.shutdown = () => new Promise(resolve => {
    for (const res of clients) res.end();
    clients.clear();
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  server.registry = reg;
  server.chargePayrollEmployees = chargePayrollEmployees;
  server.backups = backups;
  server.auth = auth;
  server.checkWorkflows = checkWorkflows; // tests: run the hourly check now
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
  const seen = new Map(), claimed = new Set();
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
    // Already brought in by the bank feed: keep the feed's line, and mark it so it isn't matched twice.
    const twin = feedTwin(store, account.id, r.date, amount, claimed);
    if (twin) { claimed.add(twin.id); store.put('bankTxns', twin.id, { ...twin, fileMatched: true }); skipped++; return; }
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

/** The request body as it came, up to a limit. */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new ValidationError('That email is too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
// Plaid's bank sign-in window (bank feeds) is the only outside script and frame allowed, and only from Plaid's own address.
const CSP = "default-src 'self'; script-src 'self' https://cdn.plaid.com; frame-src https://cdn.plaid.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://cdn.plaid.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function send(res, status, body, headers = {}) {
  const https = res.req && (res.req.headers['x-forwarded-proto'] === 'https' || res.req.socket.encrypted);
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}), ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj), headers = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  // Big answers (a company's whole books can be several MB) are compressed, which matters over the internet.
  const ae = (res.req && res.req.headers['accept-encoding']) || '';
  if (body.length < 16384 || !/\bgzip\b/.test(ae)) return send(res, status, body, headers);
  zlib.gzip(body, { level: 5 }, (err, gz) => err ? send(res, status, body, headers) : send(res, status, gz, { ...headers, 'Content-Encoding': 'gzip' }));
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
const OFFICE = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
/** A file's type from its first bytes. With a file name, an Excel or Word document (a zip with the right parts) too. */
function sniffType(b, name) {
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (name && b.length > 30 && b.readUInt32BE(0) === 0x504b0304) {
    const ext = String(name).toLowerCase().split('.').pop(), head = b.toString('latin1', 0, Math.min(b.length, 64 * 1024));
    if (ext === 'xlsx' && head.includes('xl/')) return OFFICE.xlsx;
    if (ext === 'docx' && head.includes('word/')) return OFFICE.docx;
    if ((ext === 'xlsx' || ext === 'docx') && head.includes('[Content_Types].xml')) return OFFICE[ext];
  }
  return '';
}

