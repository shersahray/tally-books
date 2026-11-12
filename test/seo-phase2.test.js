'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSearchConsole } = require('../src/server/seo-search-console');
const { createSeoStudio } = require('../src/server/seo-studio');

test('Google Search Console is disconnected until server credentials are supplied', () => {
  const gsc = createSearchConsole({ env: {} });
  assert.equal(gsc.configured(), false);
  assert.equal(gsc.property, 'sc-domain:sumlora.ca');
});
test('Google Search Console only targets Sumlora and returns real API-shaped read-only metrics', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const hits = [];
  const env = { SEO_GSC_CLIENT_EMAIL: 'seo@example.iam.gserviceaccount.com',
    SEO_GSC_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    SEO_GSC_PROPERTY: 'sc-domain:sumlora.ca' };
  const fetchImpl = async (url, options) => {
    hits.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token')
      return { ok: true, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ rows: body.dimensions.length
      ? [{ keys: [body.dimensions[0] === 'query' ? 'bookkeeping canada' : 'https://sumlora.ca/'],
           clicks: 9, impressions: 90, ctr: .1, position: 4.5 }]
      : [{ clicks: 18, impressions: 180, ctr: .1, position: 5.2 }] }) };
  };
  const gsc = createSearchConsole({ env, fetchImpl });
  const report = await gsc.report();
  assert.equal(report.totals.clicks, 18);
  assert.equal(report.queries[0].key, 'bookkeeping canada');
  assert.equal(report.pages[0].key, 'https://sumlora.ca/');
  assert.equal(hits.length, 4);
  assert.ok(hits.slice(1).every(h => h.url.includes('sc-domain%3Asumlora.ca')));
  assert.ok(hits.slice(1).every(h => h.options.headers.Authorization === 'Bearer test-token'));
});
test('SEO draft approval persists without publishing and audit runs once per week', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-phase2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    return { status: 200, headers: { get: x => x === 'content-type' ? 'text/html' : '' },
      text: async () => url.endsWith('robots.txt') ? 'User-agent: *' : url.endsWith('sitemap.xml') ? '<urlset />' :
        '<title>Sumlora</title><meta name="description" content="Bookkeeping"><link rel="canonical" href="' + url + '"><h1>Sumlora</h1>' };
  };
  const studio = createSeoStudio(dir, { fetchImpl });
  const d = await studio.draft({ topic: 'Bookkeeping in Canada', keyword: 'bookkeeping canada' });
  const reviewed = studio.updateDraft(d.id, { content: '# Updated article', status: 'approved', reviewNotes: 'Tax references checked.' });
  assert.equal(reviewed.status, 'approved');
  assert.equal(reviewed.published, false);
  assert.equal(studio.state().drafts[0].content, '# Updated article');
  await assert.rejects(async () => studio.updateDraft(d.id, { status: 'published' }), /Invalid draft status/);
  const first = await studio.auditIfDue();
  assert.equal(first.pages.length, 7);
  const oldCalls = calls;
  assert.deepEqual(await studio.auditIfDue(), { skipped: true });
  assert.equal(calls, oldCalls);
  assert.equal(studio.state().auditHistory.length, 1);
});
