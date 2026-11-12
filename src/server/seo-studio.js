'use strict';
// Sumlora SEO Studio phase 1. Independent of every client-company ledger.
// Publishing is intentionally not implemented. The platform administrator owns this data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SITE = 'https://sumlora.ca';
const CLUSTERS = [
  ['Canadian bookkeeping software','canadian bookkeeping software','bookkeeping software canada','bookkeeping software for small business canada'],
  ['QuickBooks alternatives','quickbooks alternative canada','quickbooks alternatives for accountants','canadian accounting software alternatives'],
  ['Sales tax bookkeeping','gst hst bookkeeping software','gst qst bookkeeping quebec','canadian sales tax reconciliation'],
  ['Accounting firm workflows','bookkeeping software for accounting firms','client bookkeeping workflow canada','accountant client collaboration software'],
  ['Excel audit automation','excel audit automation','invoice matching in excel','audit working paper automation'],
  ['Receipt capture','receipt scanning bookkeeping software','digital receipt management canada','accounting receipt automation']
];
function clean(s, max = 160) { return String(s == null ? '' : s).trim().slice(0, max); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function attr(tag, key) {
  const m = tag.match(new RegExp('\\b' + escapeRe(key) + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[1] || m[2] || m[3] || '') : '';
}
function metadata(html, url) {
  const title = (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [,''])[1].replace(/<[^>]*>/g, '').trim();
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]);
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const description = attr(metas.find(x => attr(x, 'name').toLowerCase() === 'description') || '', 'content');
  const robots = attr(metas.find(x => attr(x, 'name').toLowerCase() === 'robots') || '', 'content');
  const canonical = attr(links.find(x => attr(x, 'rel').toLowerCase().split(/\s+/).includes('canonical')) || '', 'href');
  const h1 = [...html.matchAll(/<h1\b[^>]*>/gi)].length;
  const issues = [];
  if (!title) issues.push('Missing title tag');
  else if (title.length > 65) issues.push('Long page title (' + title.length + ' characters)');
  if (!description) issues.push('Missing meta description');
  else if (description.length > 165) issues.push('Long description (' + description.length + ' characters)');
  if (h1 !== 1) issues.push('Expected one H1; found ' + h1);
  if (!canonical) issues.push('Missing canonical URL');
  else if (canonical !== url) issues.push('Canonical differs from inspected URL: ' + canonical);
  if (/noindex/i.test(robots)) issues.push('Page has noindex directive');
  return { url, title: title.slice(0, 200), description: description.slice(0, 250), canonical, h1, robots, issues };
}
function keywordPlan(topic) {
  const q = clean(topic, 90).toLowerCase();
  return CLUSTERS.filter(c => !q || c.some(x => x.includes(q) || q.split(/\s+/).some(w => w.length > 3 && x.includes(w))))
    .map(([cluster, ...keywords]) => ({ cluster, keywords, intent: cluster === 'Sales tax bookkeeping' ? 'Informational / commercial' : 'Commercial / informational',
      note: 'Editorial suggestions, not live search-volume or ranking data' }));
}
function outline(topic, keyword, audience) {
  return '# ' + topic + '\n\n**Primary keyword:** ' + keyword + '\n**Audience:** ' + audience +
    '\n**Status:** Outline only — AI generation is not configured.\n\n## Introduction\nExplain the problem for Canadian readers.\n\n## Key considerations\n- Define the workflow and intended audience.\n- Include practical examples and limitations.\n- Identify Canadian-specific considerations that require verification.\n\n## How to evaluate a solution\nDescribe objective evaluation criteria without unsupported marketing claims.\n\n## Conclusion\nSummarize next steps and include an appropriate Sumlora call to action.\n\n**Editorial checklist:** Verify dates, tax rates, regulatory statements and product claims before publishing.';
}
function createSeoStudio(dataDir, options = {}) {
  const filename = path.join(dataDir, 'seo-studio.json');
  const fetcher = options.fetchImpl || fetch;
  function read() {
    try { const j = JSON.parse(fs.readFileSync(filename, 'utf8')); return { drafts: Array.isArray(j.drafts) ? j.drafts.slice(0, 100) : [], lastAudit: j.lastAudit || null }; }
    catch (e) { if (e.code === 'ENOENT') return { drafts: [], lastAudit: null }; throw e; }
  }
  function write(state) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temp = filename + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, filename); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  async function retrieve(url) {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'SumloraSEOStudio/1.0 (+https://sumlora.ca)' } });
    if (response.status !== 200) return { url, status: response.status, issues: ['HTTP status ' + response.status] };
    const type = response.headers.get('content-type') || '';
    if (!/text\/html/i.test(type)) return { url, status: 200, issues: ['Response is not HTML'] };
    const size = Number(response.headers.get('content-length') || 0);
    if (size > 750000) return { url, status: 200, issues: ['Page exceeds audit size limit'] };
    const html = (await response.text()).slice(0, 750000);
    return { status: 200, ...metadata(html, url) };
  }
  async function audit() {
    // Fixed allow-list: no user-supplied target URLs, DNS, redirects, or internal-network probes.
    const urls = [SITE + '/', SITE + '/bookkeeping', SITE + '/excel', SITE + '/about', SITE + '/contact'];
    const pages = [];
    for (const url of urls) {
      try { pages.push(await retrieve(url)); }
      catch (e) { pages.push({ url, status: 0, issues: ['Could not fetch page: ' + clean(e.message, 120)] }); }
    }
    const checks = [];
    for (const endpoint of ['/robots.txt', '/sitemap.xml']) {
      try {
        const response = await fetcher(SITE + endpoint, { redirect: 'manual', signal: AbortSignal.timeout(7000) });
        const body = response.status === 200 ? (await response.text()).slice(0, 150000) : '';
        checks.push({ path: endpoint, status: response.status, valid: response.status === 200 &&
          (endpoint === '/robots.txt' ? /user-agent:/i.test(body) : /<urlset\b|<sitemapindex\b/i.test(body)) });
      } catch { checks.push({ path: endpoint, status: 0, valid: false }); }
    }
    const out = { checkedAt: new Date().toISOString(), site: SITE, pages, checks,
      issueCount: pages.reduce((sum, p) => sum + p.issues.length, 0) + checks.filter(c => !c.valid).length };
    const state = read(); state.lastAudit = out; write(state); return out;
  }
  async function draft(input) {
    const topic = clean(input.topic, 130), keyword = clean(input.keyword, 90), audience = clean(input.audience || 'Canadian businesses and accounting firms', 110);
    if (topic.length < 5 || keyword.length < 3) throw Object.assign(new Error('Enter a topic and primary keyword.'), { status: 400 });
    const id = crypto.randomUUID();
    let content = outline(topic, keyword, audience), mode = 'outline';
    if (input.generateAI === true) {
      if (!options.aiKey) throw Object.assign(new Error('AI generation is not configured. Set ANTHROPIC_API_KEY on the server or use Create outline.'), { status: 503 });
      const response = await fetcher('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', 'x-api-key': options.aiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1300,
          system: 'You are an editorial assistant for a Canadian bookkeeping software provider. Write an original useful Markdown article draft, not a finished or published page. Never invent facts, prices, citations, tax rates, legal requirements, product features or testimonials. For uncertain Canadian accounting/tax facts insert [VERIFY]. No raw HTML. Include a descriptive title and relevant sections.',
          messages: [{ role: 'user', content: JSON.stringify({ topic, keyword, audience, style: 'Clear, practical, professional', callToAction: 'Learn more about Sumlora at sumlora.ca' }) }] })
      });
      if (!response.ok) throw Object.assign(new Error('AI provider error (' + response.status + '). No draft saved.'), { status: 502 });
      const result = await response.json();
      content = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').slice(0, 20000);
      if (!content) throw Object.assign(new Error('AI returned an empty draft.'), { status: 502 });
      mode = 'ai';
    }
    const item = { id, topic, keyword, audience, mode, status: 'needs-review', createdAt: new Date().toISOString(),
      content, published: false };
    const state = read(); state.drafts.unshift(item); state.drafts = state.drafts.slice(0, 100); write(state);
    return item;
  }
  return { state: read, audit, keywords: keywordPlan, draft };
}
module.exports = { createSeoStudio, metadata, keywordPlan };
