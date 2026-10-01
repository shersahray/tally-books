#!/usr/bin/env node
'use strict';
/*
 * Builds dist/demo.html: the whole app in one file, running entirely in the browser with
 * example companies and no server. Handy for showing the app to someone before they install it.
 *   node scripts/build-demo.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { DEFAULT_ACCOUNTS } = require('../src/server/seed');

const root = path.join(__dirname, '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-demo-'));
  const server = createApp({ dataDir: dir, demo: true, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Demo', username: 'demo-builder', password: 'demo build only ' + Date.now() }) });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const _fetch = fetch; const fetchA = (u, init = {}) => _fetch(u, { ...init, headers: { ...(init.headers || {}), cookie } });
  const post = (url, body) => fetchA(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('/api/companies', { name: 'Bistro Montréal inc.', province: 'QC', fyStart: 1, examples: true, lang: 'fr' });
  const list = await (await fetchA(base + '/api/companies')).json();
  const data = { provinces: list.provinces, defaultAccounts: DEFAULT_ACCOUNTS, companies: [] };
  for (const c of list.companies) {
    const state = await (await fetchA(`${base}/api/c/${c.id}/state`)).json();
    delete state.rev; delete state.companyId;
    data.companies.push({ entry: { id: c.id, name: c.name, archived: false, created: c.created }, state });
  }
  await server.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });

  const index = pub('index.html');
  const fonts = index.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];
  const body = index.split('<body>')[1].split('<script')[0].trim();
  const safe = s => s.replace(/<\/script/gi, '<\\/script');
  const html = `<title>Tally Books Demo</title>
<meta name="description" content="Try Tally Books in your browser. Example data; nothing is saved.">
${fonts}
<style>
${pub('styles.css')}
.demo-ribbon{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:70;background:var(--ink);color:var(--bg);font-size:12px;padding:6px 10px;border-radius:6px;opacity:.85;max-width:calc(100% - 24px)}
</style>
<script>${safe(pub('theme.js'))}</script>
${body}
<div class="demo-ribbon">Demo · example data · changes aren’t saved</div>
<script>window.__TALLY_DEMO__=${safe(JSON.stringify(data))};</script>
<script>${safe(fs.readFileSync(path.join(__dirname, 'demo-shim.js'), 'utf8'))}</script>
${['i18n.js', 'fr.js', 'gifi.js', 'bankparse.js', 'app.js', 'banking.js', 'ai.js', 'receipts.js', 'convert-parse.js', 'convert.js', 'pdf.js', 'docout.js', 'salestax.js', 'reports.js', 'review.js', 'payroll-calc.js', 'payroll.js', 'payroll-yearend.js', 'payroll-roe.js', 'activity.js', 'backups.js', 'qr.js', 'auth.js', 'companies.js'].map(f => `<script>\n${safe(pub(f))}\n</script>`).join('\n')}
`;
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'demo.html'), html);
  console.log(`Wrote dist/demo.html (${Math.round(html.length / 1024)} KB)`);
})();
