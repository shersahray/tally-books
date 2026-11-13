'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSeoStudio, metadata, keywordPlan } = require('../src/server/seo-studio');

test('SEO metadata audit identifies title, description, canonical, H1 and noindex', () => {
  const url = 'https://sumlora.ca/';
  const html = '<title>Sumlora</title><meta name="description" content="Canadian bookkeeping software"><link rel="canonical" href="https://sumlora.ca/"><h1>Welcome</h1>';
  const page = metadata(html, url);
  assert.equal(page.title, 'Sumlora');
  assert.equal(page.description, 'Canadian bookkeeping software');
  assert.deepEqual(page.issues, []);
  const bad = metadata('<title>Test</title><h1>A</h1><h1>B</h1><meta name="robots" content="noindex">', url);
  assert.ok(bad.issues.some(x => x.includes('noindex')));
  assert.ok(bad.issues.some(x => x.includes('H1')));
});
test('SEO audit counts displayed characters after decoding HTML entities', () => {
  const url = 'https://sumlora.ca/';
  const page = metadata('<title>Canadian Bookkeeping Software for Businesses &amp; Firms | Sumlora</title>' +
    '<meta name="description" content="Accounting &amp; software">' +
    '<link rel="canonical" href="https://sumlora.ca/"><h1>Welcome</h1>', url);
  assert.equal(page.title, 'Canadian Bookkeeping Software for Businesses & Firms | Sumlora');
  assert.equal(page.description, 'Accounting & software');
  assert.equal(page.issues.some(issue => issue.startsWith('Long page title')), false);
});
test('keyword planning is clearly curated rather than claimed search volume', () => {
  const result = keywordPlan('audit');
  assert.ok(result.some(x => x.keywords.includes('excel audit automation')));
  assert.ok(result.every(x => /not live search-volume/.test(x.note)));
});
test('SEO studio saves private review-only outlines and audit without publishing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlora-seo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeFetch = async url => ({
    status: 200, ok: true,
    headers: { get: name => name === 'content-type' ? 'text/html' : '' },
    text: async () => url.endsWith('robots.txt') ? 'User-agent: *' :
      url.endsWith('sitemap.xml') ? '<urlset></urlset>' :
      '<title>Sumlora</title><meta name="description" content="Canadian accounting tools"><link rel="canonical" href="' + url + '"><h1>Sumlora</h1>'
  });
  const studio = createSeoStudio(dir, { fetchImpl: fakeFetch });
  const item = await studio.draft({ topic: 'Canadian accounting tools', keyword: 'accounting software canada' });
  assert.equal(item.mode, 'outline');
  assert.equal(item.status, 'needs-review');
  assert.equal(item.published, false);
  assert.equal(studio.state().drafts.length, 1);
  const audit = await studio.audit();
  assert.equal(audit.issueCount, 0);
  assert.equal(audit.pages.length, 7);
  assert.equal(studio.state().lastAudit.checkedAt, audit.checkedAt);
  assert.equal(fs.existsSync(path.join(dir, 'seo-studio.json')), true);
});
test('AI generation without configured key fails rather than pretending an AI article was written', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlora-seo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const studio = createSeoStudio(dir);
  await assert.rejects(() => studio.draft({ topic: 'Canadian bookkeeping platforms', keyword: 'bookkeeping software', generateAI: true }), /not configured/i);
  assert.equal(studio.state().drafts.length, 0);
});
