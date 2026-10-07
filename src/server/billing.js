'use strict';
/*
 * Paying for Sumlora on an online server, through the server owner's own Stripe account.
 *
 * - A firm (other than the server owner's) pays for each company it keeps, each month, on its firm's plan
 *   (Essentials or Plus). Companies whose client pays for themselves aren't counted.
 * - A company can be marked "the client pays": its client pays for that one company.
 * - A free trial (14 days unless changed) the first time; the card is taken at the start, on Stripe's page.
 *
 * Nothing changes until the administrator adds a Stripe key in Settings. The key and the price ids stay in
 * billing.json in the per-computer folder, readable only by the server's account.
 *
 * No webhook is needed: a subscription's state is read back from Stripe after checkout, when people sign in
 * (at most every few hours), and twice a day for everyone.
 */
const fs = require('node:fs');
const path = require('node:path');
const stripe = require('./stripe');
const { ValidationError } = require('./validate');
const PLANS = require('../../public/plans.js');

const GRACE_MS = 7 * 864e5;        // a failed payment: a week to fix the card before access stops
const STALE_MS = 6 * 3600e3;       // read a subscription again after this long

class Billing {
  constructor(dir, o = {}) {
    this.file = path.join(dir, 'billing.json');
    this.fetch = o.fetch || ((...a) => fetch(...a));
    this.data = { key: '', amounts: { essentials: 1500, plus: 3000 }, trialDays: 14, prices: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    // Add-ons (plans.js ADDONS) have a price too, per company per month.
    for (const [k, a] of Object.entries(PLANS.ADDONS)) if (!(this.data.amounts[k] > 0)) this.data.amounts[k] = a.cents;
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }
  configured() { return !!this.data.key; }
  /** What the administrator sees. Never the key itself. */
  status() {
    const p = stripe.publicStripe({ key: this.data.key });
    return { configured: p.configured, mode: p.mode || '', ending: p.ending || '', amounts: this.data.amounts, trialDays: this.data.trialDays };
  }
  /** Prices and trial, for the screens where people subscribe. */
  offer() { return { amounts: this.data.amounts, trialDays: this.data.trialDays, currency: 'CAD' }; }
  async update(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Send the subscription settings as an object.');
    const next = { ...this.data, amounts: { ...this.data.amounts } };
    if (body.key !== undefined) {
      const k = String(body.key || '').trim();
      if (k && !stripe.validKey(k)) throw new ValidationError('That doesn’t look like a Stripe key. It starts with sk_ or rk_ (live or test).');
      if (k && k !== this.data.key) {
        try { await stripe.call({ key: k }, this.fetch, 'GET', 'prices', { limit: 1 }); }
        catch (e) { throw new ValidationError(e.status === 400 ? 'Stripe didn’t accept that key, or it doesn’t have the permissions Sumlora needs (Products, Prices, Customers, Checkout Sessions, Subscriptions and the Customer portal).' : e.message); }
        next.prices = {}; // prices belong to a Stripe account
      }
      next.key = k;
    }
    for (const plan of [...Object.keys(PLANS.PLANS), ...Object.keys(PLANS.ADDONS)]) {
      if (!body.amounts || body.amounts[plan] === undefined) continue;
      const c = Math.round(Number(body.amounts[plan]) * 100);
      if (!Number.isFinite(c) || c < 100 || c > 100000) throw new ValidationError(PLANS.ADDONS[plan] ? 'Each add-on’s price must be between $1 and $1,000 a month.' : 'Each plan’s price must be between $1 and $1,000 a month.');
      if (c !== next.amounts[plan]) { next.amounts[plan] = c; delete next.prices[plan]; }
    }
    if (body.trialDays !== undefined) {
      const d = Number(body.trialDays);
      if (!Number.isInteger(d) || d < 0 || d > 60) throw new ValidationError('The free trial must be between 0 and 60 days.');
      next.trialDays = d;
    }
    this.data = next;
    this.save();
    return this.status();
  }
  async call(method, p, params) {
    if (!this.configured()) throw new ValidationError('Subscriptions aren’t set up on this server.', 409);
    try { return await stripe.call({ key: this.data.key }, this.fetch, method, p, params); }
    catch (e) {
      if (e.status === 400 && /didn’t accept the key/.test(e.message)) throw new ValidationError('Stripe didn’t accept the server’s subscription key. The administrator can check it in Settings.', 502);
      throw e;
    }
  }
  /** The Stripe price for a plan, made the first time it's needed. */
  async price(plan) {
    plan = PLANS.planOf(plan);
    const amount = this.data.amounts[plan];
    const have = this.data.prices[plan];
    if (have && have.amount === amount) return have.id;
    const p = await this.call('POST', 'prices', { currency: 'cad', unit_amount: amount, recurring: { interval: 'month' }, nickname: `Sumlora ${PLANS.PLANS[plan].label} (per company, monthly)`,
      product_data: { name: `Sumlora ${PLANS.PLANS[plan].label}` }, metadata: { sumlora_plan: plan } });
    this.data.prices[plan] = { id: p.id, amount };
    this.save();
    return p.id;
  }
  /** The Stripe price for an add-on, made the first time it's needed. Marked so its line on a subscription can be told apart. */
  async addonPrice(key) {
    const a = PLANS.ADDONS[key];
    if (!a) throw new ValidationError('That add-on doesn’t exist.');
    const amount = this.data.amounts[key], have = this.data.prices[key];
    if (have && have.amount === amount) return have.id;
    const p = await this.call('POST', 'prices', { currency: 'cad', unit_amount: amount, recurring: { interval: 'month' }, nickname: `Sumlora ${a.label} (per company, monthly)`,
      product_data: { name: `Sumlora ${a.label}` }, metadata: { sumlora_addon: key } });
    this.data.prices[key] = { id: p.id, amount };
    this.save();
    return p.id;
  }
  /**
   * Stripe's checkout page for a new subscription.
   * @param {object} o  { kind: 'firm'|'company', id, plan, quantity, email, customer, trial, base, assistant (companies with the AI assistant) }
   */
  async checkout(o) {
    const price = await this.price(o.plan);
    const extra = o.assistant > 0 ? { 'line_items[1][price]': await this.addonPrice('assistant'), 'line_items[1][quantity]': o.assistant } : {};
    const params = {
      mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': Math.max(1, o.quantity || 1), ...extra,
      success_url: `${o.base}/?billing=done&session={CHECKOUT_SESSION_ID}`, cancel_url: `${o.base}/?billing=cancelled`,
      client_reference_id: `${o.kind}:${o.id}`, payment_method_collection: 'always', allow_promotion_codes: 'true',
      subscription_data: { metadata: { sumlora_kind: o.kind, sumlora_id: o.id, sumlora_plan: PLANS.planOf(o.plan) }, ...(o.trial && this.data.trialDays ? { trial_period_days: this.data.trialDays } : {}) },
      ...(o.customer ? { customer: o.customer } : o.email && /@/.test(o.email) ? { customer_email: o.email } : {}),
    };
    const s = await this.call('POST', 'checkout/sessions', params);
    return s.url;
  }
  /** After checkout: what was bought, and its subscription. */
  async finish(sessionId) {
    if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(String(sessionId || ''))) throw new ValidationError('That payment page link isn’t valid.');
    const s = await this.call('GET', `checkout/sessions/${sessionId}`, { 'expand[]': 'subscription' });
    if (s.status !== 'complete' || !s.subscription) throw new ValidationError('The payment wasn’t finished. Try again.', 409);
    const [kind, id] = String(s.client_reference_id || '').split(':');
    return { kind, id, record: recordOf(typeof s.subscription === 'object' ? s.subscription : await this.call('GET', `subscriptions/${s.subscription}`), s.customer) };
  }
  /** Read a subscription's state again. */
  async refresh(rec) {
    const sub = await this.call('GET', `subscriptions/${rec.sub}`);
    return recordOf(sub, rec.customer, rec);
  }
  /** A firm's number of companies changed. */
  async setQuantity(rec, quantity) {
    const q = Math.max(1, quantity);
    if (rec.quantity === q) return rec;
    const sub = await this.call('POST', `subscriptions/${rec.sub}`, { 'items[0][id]': rec.item, 'items[0][quantity]': q });
    return recordOf(sub, rec.customer, rec);
  }
  /**
   * Set how many companies on a subscription have an add-on: adds, changes or removes its line.
   * Stripe prorates the change on the next invoice.
   */
  async setAddon(rec, key, quantity) {
    const q = Math.max(0, quantity | 0), have = (rec.addons || {})[key];
    if ((have ? have.quantity : 0) === q) return rec;
    let params;
    if (!q) params = { 'items[0][id]': have.item, 'items[0][deleted]': 'true' };
    else if (have) params = { 'items[0][id]': have.item, 'items[0][quantity]': q };
    else params = { 'items[0][price]': await this.addonPrice(key), 'items[0][quantity]': q };
    const sub = await this.call('POST', `subscriptions/${rec.sub}`, params);
    return recordOf(sub, rec.customer, rec);
  }
  /** Stripe's page to change the card, see invoices or cancel. */
  async portal(customer, base) {
    const s = await this.call('POST', 'billing_portal/sessions', { customer, return_url: `${base}/` });
    return s.url;
  }
}

function recordOf(sub, customer, prev = {}) {
  // The plan's line, and a line for each add-on (its price is marked with the add-on's name).
  const items = (sub.items && sub.items.data) || [];
  const addonOf = it => (it && it.price && it.price.metadata && it.price.metadata.sumlora_addon) || '';
  const item = items.find(it => !addonOf(it));
  const addons = {};
  for (const it of items) if (addonOf(it)) addons[addonOf(it)] = { item: String(it.id), quantity: Number(it.quantity) || 0 };
  const status = String(sub.status || '');
  const rec = {
    customer: String((sub.customer && sub.customer.id) || sub.customer || customer || prev.customer || ''),
    sub: String(sub.id), item: item ? String(item.id) : prev.item || '', quantity: item ? Number(item.quantity) || 1 : prev.quantity || 1,
    status, cancelAtEnd: !!sub.cancel_at_period_end, trialEnd: sub.trial_end ? sub.trial_end * 1000 : 0,
    periodEnd: (sub.current_period_end || (item && item.current_period_end) || 0) * 1000, checked: Date.now(),
    hadTrial: !!(prev.hadTrial || sub.trial_end), plan: (sub.metadata && sub.metadata.sumlora_plan) || prev.plan || '', addons,
  };
  rec.pastDueSince = status === 'past_due' ? prev.pastDueSince || Date.now() : 0;
  return rec;
}
/** Does this subscription let people in? Trial, active, or a failed payment still within its week of grace. */
function paid(rec) {
  if (!rec || !rec.sub) return false;
  if (rec.status === 'active' || rec.status === 'trialing') return true;
  return rec.status === 'past_due' && Date.now() - (rec.pastDueSince || Date.now()) < GRACE_MS;
}
const stale = rec => !!(rec && rec.sub && Date.now() - (rec.checked || 0) > STALE_MS);
/** In plain words, for the screens. */
function describe(rec) {
  if (!rec || !rec.sub) return { state: 'none' };
  return { state: paid(rec) ? (rec.status === 'past_due' ? 'pastdue' : rec.status) : 'stopped', status: rec.status, trialEnd: rec.trialEnd, periodEnd: rec.periodEnd, cancelAtEnd: rec.cancelAtEnd, quantity: rec.quantity, hadTrial: !!rec.hadTrial, graceUntil: rec.pastDueSince ? rec.pastDueSince + GRACE_MS : 0 };
}

module.exports = { Billing, paid, stale, describe, recordOf };
