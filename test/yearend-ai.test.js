'use strict';
require('./setup-payroll-on');
// Year-end files: AI suggestions are suggestions (nothing saved), for staff with AI on, through the firm's AI budget.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createApp } = require('../src/server/app');
const KEY = 'sk-ant-api03-' + 'x'.repeat(40);
let server, fake, base, dir, co, cookie, asked = [], reply = '';
const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-yf-ai-'));
  fake = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { asked.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: reply }], usage: { input_tokens: 1000, output_tokens: 200 }, stop_reason: 'end_turn' })); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, autoWorkflows: false, aiUrl: `http://127.0.0.1:${fake.address().port}/v1/messages` });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'AI Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/ai', { apiKey: KEY, capUsd: 50 });
  const st = (await call('GET', `/api/c/${co}/state`)).json;
  await call('PUT', `/api/c/${co}/settings`, { ...st.company, ai: true });
  const bank = st.accounts.find(a => a.detail === 'bank').id, sales = st.accounts.find(a => a.type === 'Income').id;
  assert.equal((await call('PUT', `/api/c/${co}/records/engagements/y1`, { yearEnd: '2025-12-31', snapshot: { lines: [{ account: bank, name: 'Chequing', type: 'Asset', cur: 5000, prior: 1000 }, { account: sales, name: 'Sales', type: 'Income', cur: -5000, prior: -1000 }] } })).status, 200);
});
after(async () => { await server.shutdown(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('AI review points and a draft note come back as suggestions, and nothing in the file changes', async () => {
  const before0 = (await call('GET', `/api/c/${co}/state`)).json.engagements[0];
  reply = 'Here you go: {"points":[{"wp":"R","priority":"high","text":"Revenue rose 400%. Ask the client what changed."},{"wp":"ZZ","text":"Something else"}]}';
  let r = await call('POST', `/api/c/${co}/engagements/y1/ai`, { task: 'review' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.suggestion, true);
  assert.deepEqual(r.json.points.map(p => [p.wp, p.priority]), [['R', 'high'], ['', 'normal']]);
  assert.match(asked[0].system, /suggestions only/);
  assert.match(asked[0].messages[0].content, /Revenue/);
  reply = '{"title":"Capital assets","text":"Capital assets are recorded at cost and amortized over [useful lives]."}';
  r = await call('POST', `/api/c/${co}/engagements/y1/ai`, { task: 'note', title: 'Capital assets' });
  assert.match(r.json.text, /\[useful lives\]/);
  const after0 = (await call('GET', `/api/c/${co}/state`)).json.engagements[0];
  assert.deepEqual(after0, before0, 'the file is unchanged');
  assert.equal((await call('POST', `/api/c/${co}/engagements/nope/ai`, { task: 'review' })).status, 404);
});
