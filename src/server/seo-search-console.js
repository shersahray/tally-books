'use strict';
// Read-only Google Search Console reporting. Credentials remain server-side.
const crypto = require('node:crypto');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://www.googleapis.com/webmasters/v3/sites/';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const encoded = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const error = (message, status = 502) => Object.assign(new Error(message), { status });
function createSearchConsole(options = {}) {
  const env = options.env || process.env;
  const property = String(env.SEO_GSC_PROPERTY || 'sc-domain:sumlora.ca').trim();
  // Only permit the Sumlora property, never a user-submitted property.
  if (!['sc-domain:sumlora.ca', 'https://sumlora.ca/'].includes(property)) {
    throw error('SEO_GSC_PROPERTY must be the Sumlora domain or HTTPS URL-prefix property.', 500);
  }
  const email = String(env.SEO_GSC_CLIENT_EMAIL || '').trim();
  const privateKey = String(env.SEO_GSC_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const fetcher = options.fetchImpl || fetch;
  let token = '', expiry = 0;
  function configured() { return !!(email && privateKey); }
  async function accessToken() {
    if (!configured()) throw error('Search Console is not connected. Configure the server-side service account and grant it access to the Sumlora property.', 503);
    if (token && Date.now() < expiry - 60000) return token;
    const now = Math.floor(Date.now() / 1000);
    const head = encoded({ alg: 'RS256', typ: 'JWT' });
    const claims = encoded({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
    const payload = head + '.' + claims;
    let sig;
    try { sig = crypto.sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url'); }
    catch { throw error('Invalid Search Console service account private key.', 503); }
    const res = await fetcher(TOKEN_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: payload + '.' + sig }).toString() });
    if (!res.ok) throw error('Search Console token request failed (HTTP ' + res.status + '). Check the service account configuration.', 502);
    const out = await res.json();
    if (!out.access_token || !Number(out.expires_in)) throw error('Search Console returned an invalid access token response.');
    token = out.access_token; expiry = Date.now() + Math.min(Number(out.expires_in), 3600) * 1000;
    return token;
  }
  async function query(access, startDate, endDate, dimensions, limit = 25) {
    const res = await fetcher(API_ROOT + encodeURIComponent(property) + '/searchAnalytics/query', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions, type: 'web', rowLimit: limit, dataState: 'final' })
    });
    if (!res.ok) throw error(res.status === 403 ? 'Search Console denied access. Add the service account as a user of the selected property.' :
      'Search Console request failed (HTTP ' + res.status + ').', res.status === 403 ? 403 : 502);
    const data = await res.json();
    return (data.rows || []).map(r => ({ key: String((r.keys || [])[0] || '').slice(0, 300),
      clicks: Number(r.clicks || 0), impressions: Number(r.impressions || 0),
      ctr: Number(r.ctr || 0), position: Number(r.position || 0) }));
  }
  async function report() {
    const access = await accessToken();
    // End three days ago; Google's finalized Search Console data generally lags.
    const end = new Date(Date.now() - 3 * 86400000);
    const start = new Date(end.getTime() - 27 * 86400000);
    const startDate = start.toISOString().slice(0, 10), endDate = end.toISOString().slice(0, 10);
    const [aggregate, queries, pages] = await Promise.all([
      query(access, startDate, endDate, []),
      query(access, startDate, endDate, ['query'], 20),
      query(access, startDate, endDate, ['page'], 20)
    ]);
    return { property, startDate, endDate, checkedAt: new Date().toISOString(),
      totals: { clicks: aggregate[0]?.clicks || 0, impressions: aggregate[0]?.impressions || 0,
        ctr: aggregate[0]?.ctr || 0, position: aggregate[0]?.position || 0 },
      queries, pages, source: 'Google Search Console API', note: 'Finalized web search data; totals and dimension tables may differ due to privacy filtering and aggregation.' };
  }
  return { configured, report, property };
}
module.exports = { createSearchConsole };
