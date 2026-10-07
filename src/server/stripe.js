'use strict';
/* Online card payments through the company's own Stripe account.
 *
 * Each invoice gets a Stripe Payment Link for its balance (a one-off price, usable once). Sumlora never
 * sees card details: the customer pays on Stripe's page. Payments are found by asking Stripe for the
 * completed checkout sessions of each link (no webhook, so it works on a desktop with no public address).
 * The key is a restricted key the bookkeeper creates in Stripe; it stays on the server.
 */
const API = 'https://api.stripe.com/v1/';
const KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,200}$/;

class StripeError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Stripe takes form-encoded bodies with bracketed keys: line_items[0][price]=…
function encode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

async function call(cfg, fetchFn, method, path, params) {
  const q = params ? encode(params) : '';
  const url = API + path + (method === 'GET' && q ? '?' + q : '');
  let r, j = null;
  try {
    r = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${cfg.key}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      body: method === 'GET' ? undefined : q,
      signal: AbortSignal.timeout(20000),
    });
    j = await r.json().catch(() => null);
  } catch (e) {
    throw new StripeError('Can’t reach Stripe. Check the internet connection and try again.');
  }
  if (!r.ok) {
    const msg = j && j.error && j.error.message ? String(j.error.message).slice(0, 300) : `Stripe answered ${r.status}.`;
    throw new StripeError(r.status === 401 ? 'Stripe didn’t accept the key. Check it in Settings → Online payments.' : r.status === 403 ? `The Stripe key doesn’t have the permissions Sumlora needs. ${msg}` : `Stripe: ${msg}`, r.status === 401 || r.status === 403 ? 400 : 502);
  }
  return j || {};
}

function validKey(key) { return KEY_RE.test(String(key || '').trim()); }
function publicStripe(cfg) {
  if (!cfg || !cfg.key) return { configured: false };
  return { configured: true, mode: /_test_/.test(cfg.key) ? 'test' : 'live', ending: cfg.key.slice(-4), connected: cfg.connected || '' };
}

/** Check a key works: list one payment link (needs the Payment Links permission). */
async function check(cfg, fetchFn) { await call(cfg, fetchFn, 'GET', 'payment_links', { limit: 1 }); }

/** A link to pay `cents` (CAD) once. */
async function createLink(cfg, fetchFn, { cents, name, docId, company }) {
  const price = await call(cfg, fetchFn, 'POST', 'prices', { currency: 'cad', unit_amount: cents, product_data: { name: String(name).slice(0, 250) } });
  const link = await call(cfg, fetchFn, 'POST', 'payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    restrictions: { completed_sessions: { limit: 1 } },
    metadata: { sumlora_doc: docId },
    payment_intent_data: { description: String(name).slice(0, 250), metadata: { sumlora_doc: docId } },
    inactive_message: `This invoice from ${String(company || '').slice(0, 100)} has been paid or replaced. Contact them for a new link.`,
  });
  if (!link.url || !link.id) throw new StripeError('Stripe didn’t return a payment link.');
  return { id: link.id, url: link.url };
}

async function deactivate(cfg, fetchFn, id) { await call(cfg, fetchFn, 'POST', `payment_links/${encodeURIComponent(id)}`, { active: false }); }

/** Paid checkout sessions for a link: [{ id, cents, created (seconds) }]. */
async function paidSessions(cfg, fetchFn, linkId) {
  const j = await call(cfg, fetchFn, 'GET', 'checkout/sessions', { payment_link: linkId, status: 'complete', limit: 100 });
  return (j.data || []).filter(s => s.payment_status === 'paid' && String(s.currency || 'cad').toLowerCase() === 'cad')
    .map(s => ({ id: String(s.id), cents: Math.round(Number(s.amount_total) || 0), created: Number(s.created) || 0 }));
}

module.exports = { validKey, publicStripe, check, createLink, deactivate, paidSessions, StripeError, encode, call };
