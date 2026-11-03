'use strict';
// Connection from this Bookkeeping server to the Sumlora for Excel administration API.
//
// Server to server only: the browser never sees the signing secret or calls the Excel API.
// Each request is signed with HMAC-SHA256 over method, path, timestamp, a random nonce,
// the platform administrator's username and the SHA-256 of the body. The Excel API checks
// the signature, a 5-minute window and that the nonce was not used before.
//
// Nothing here changes Bookkeeping data, desktop licences or customer access.
//
// Environment (all three, or the Excel tab stays "not connected"):
//   EXCEL_ADMIN_API_URL     https://<excel-api-host>
//   EXCEL_ADMIN_KEY_ID      the key id, e.g. k1 (must match EXCEL_ADMIN_HMAC_KEYS on the Excel API)
//   EXCEL_ADMIN_HMAC_SECRET the same base64 secret (32+ random bytes)

const crypto = require('node:crypto');

const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalString({ method, path, timestamp, nonce, actor, body }) {
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  return [String(method).toUpperCase(), path, String(timestamp), nonce, actor, bodyHash].join('\n');
}

function signAdminRequest({ keyId, secret, method, path, actor, body = '', now = Date.now(), nonce }) {
  const timestamp = Math.floor(now / 1000);
  const n = nonce || crypto.randomBytes(18).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(canonicalString({ method, path, timestamp, nonce: n, actor, body })).digest('hex');
  return { 'x-sumlora-key-id': keyId, 'x-sumlora-timestamp': String(timestamp), 'x-sumlora-nonce': n,
    'x-sumlora-actor': actor, 'x-sumlora-signature': signature };
}

/** The Excel API accepts actor names of letters, digits and . _ @ + - (max 100). */
function actorFor(user) {
  const raw = String((user && user.username) || 'platform-admin');
  return raw.replace(/[^A-Za-z0-9._@+-]/g, '_').slice(0, 100) || 'platform-admin';
}

function loadExcelAdminConfig(env = process.env) {
  const url = env.EXCEL_ADMIN_API_URL;
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { throw new Error('EXCEL_ADMIN_API_URL is not a valid URL.'); }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:' && env.EXCEL_ADMIN_ALLOW_LOCAL_HTTP === '1'))
    throw new Error('EXCEL_ADMIN_API_URL must use https.');
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('EXCEL_ADMIN_API_URL must be just the server address.');
  const keyId = env.EXCEL_ADMIN_KEY_ID || '';
  if (!KEY_ID.test(keyId)) throw new Error('EXCEL_ADMIN_KEY_ID is missing or invalid.');
  const b64 = String(env.EXCEL_ADMIN_HMAC_SECRET || '').trim();
  const secret = Buffer.from(b64, 'base64');
  if (secret.length < 32 || secret.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, ''))
    throw new Error('EXCEL_ADMIN_HMAC_SECRET must be base64 and at least 32 bytes.');
  return { baseUrl: u.origin, keyId, secret };
}

class ExcelAdminError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const MESSAGES = {
  'tenant-already-registered': 'That Microsoft 365 organization already has a Sumlora for Excel firm.',
  'invalid-firm-name': 'Enter the firm’s name (2 to 120 characters).',
  'invalid-tenant-id': 'Enter the firm’s Microsoft 365 tenant ID (a GUID like 1a2b3c4d-…).',
  'invalid-budget-cents': 'The AI budget must be between $0 and $100,000 CAD, in cents.',
  'invalid-email': 'Enter a valid work email address.',
  'invalid-role': 'Choose a valid role.',
  'invalid-expiry-days': 'An invitation can last 1 to 30 days.',
  'reason-required': 'Give a reason for suspending the firm.',
  'invalid-reason': 'The reason must be 1 to 500 characters.',
  'firm-not-found': 'That Excel firm no longer exists.',
  'firm-suspended': 'That firm is suspended. Reactivate it first.',
  'already-suspended': 'That firm is already suspended.',
  'already-active': 'That firm is already active.',
  'already-a-member': 'That person is already an active member of the firm.',
  'invitation-already-pending': 'That email already has an open invitation. Cancel it first to send a new one.',
  'invitation-not-found': 'That invitation no longer exists.',
  'invitation-not-open': 'That invitation was already accepted or cancelled.',
  'invalid-limit': 'Invalid number of activity entries.',
  'invalid-id': 'Invalid firm or invitation.',
  'service-disabled': 'The Sumlora for Excel service is switched off.',
  'admin-api-not-configured': 'The Excel service is not set up to accept administrator requests yet.',
  'stale-request': 'This server’s clock is more than 5 minutes off. Check the server time.',
  'bad-signature': 'The Excel service rejected this server’s key. Check EXCEL_ADMIN_HMAC_SECRET on both servers.',
  'unknown-key': 'The Excel service does not know this server’s key id. Check EXCEL_ADMIN_KEY_ID.'
};
function friendly(err) {
  if (err instanceof ExcelAdminError) {
    if (MESSAGES[err.code]) return { message: MESSAGES[err.code], status: err.status >= 500 ? 503 : (err.status === 401 ? 502 : err.status) };
    if (err.status >= 500 || err.status === 0) return { message: 'The Sumlora for Excel service is not responding. Try again shortly.', status: 503 };
    return { message: `The Excel service refused the request (${err.code}).`, status: err.status === 401 ? 502 : err.status };
  }
  return { message: 'The Sumlora for Excel service is not responding. Try again shortly.', status: 503 };
}

function createExcelAdminClient({ baseUrl, keyId, secret, fetchImpl = fetch, timeoutMs = 8000 }) {
  async function call(method, path, body, actor) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = signAdminRequest({ keyId, secret, method, path, actor, body: raw });
    if (raw) headers['content-type'] = 'application/json';
    let res;
    try { res = await fetchImpl(baseUrl + path, { method, headers, body: raw || undefined, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new ExcelAdminError(0, 'unreachable'); }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new ExcelAdminError(res.status, (data && typeof data.error === 'string' && data.error.slice(0, 80)) || `http-${res.status}`);
    return data;
  }
  const firm = id => { if (!UUID.test(String(id))) throw new ExcelAdminError(400, 'invalid-id'); return `/v1/admin/firms/${id.toLowerCase()}`; };
  return {
    summary: actor => call('GET', '/v1/admin/summary', undefined, actor),
    listFirms: actor => call('GET', '/v1/admin/firms', undefined, actor),
    getFirm: (id, actor) => call('GET', firm(id), undefined, actor),
    createFirm: (input, actor) => call('POST', '/v1/admin/firms', input, actor),
    suspend: (id, reason, actor) => call('POST', `${firm(id)}/suspend`, { reason }, actor),
    reactivate: (id, reason, actor) => call('POST', `${firm(id)}/reactivate`, reason ? { reason } : {}, actor),
    setAiBudget: (id, input, actor) => call('PUT', `${firm(id)}/ai-budget`, input, actor),
    listInvitations: (id, actor) => call('GET', `${firm(id)}/invitations`, undefined, actor),
    invite: (id, input, actor) => call('POST', `${firm(id)}/invitations`, input, actor),
    revokeInvitation: (id, invId, actor) => { if (!UUID.test(String(invId))) throw new ExcelAdminError(400, 'invalid-id'); return call('POST', `${firm(id)}/invitations/${invId.toLowerCase()}/revoke`, undefined, actor); },
    audit: (id, limit, actor) => call('GET', `${firm(id)}/audit?limit=${Math.min(200, Math.max(1, Number(limit) || 50))}`, undefined, actor)
  };
}

module.exports = { signAdminRequest, canonicalString, actorFor, loadExcelAdminConfig, createExcelAdminClient, ExcelAdminError, friendly, MESSAGES };
