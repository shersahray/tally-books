/*
 * Browser-only stand-in for the Sumlora server, used by the online demo.
 * It answers the app's /api/... requests from memory, starting from example companies.
 * Nothing is saved: reloading the page starts over.
 */
(function () {
  'use strict';
  const DATA = window.__TALLY_DEMO__;
  const PROVS = DATA.provinces, DEFAULT_ACCOUNTS = DATA.defaultAccounts;
  const COLS = ['accounts', 'contacts', 'employees', 'rules', 'docs', 'entries', 'bankTxns', 'recons', 'filings', 'payruns'];
  const clone = o => JSON.parse(JSON.stringify(o));
  const cos = DATA.companies.map(c => ({ ...c.entry }));
  const books = {};
  DATA.companies.forEach(c => { books[c.entry.id] = clone(c.state); books[c.entry.id].rev = 1; books[c.entry.id].company.ai = true; });
  const templates = Object.fromEntries(DATA.companies.map(c => [c.state.company.province, c.state]));

  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const r2 = n => Math.round(n * 100) / 100;
  const rid = p => p + Math.random().toString(16).slice(2, 14);
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  const codes = {}; // demo only: kept in this page, never saved
  function summary(c) {
    const b = books[c.id], s = b.company, paid = {};
    for (const e of b.entries) if (e.applyTo) paid[e.applyTo] = (paid[e.applyTo] || 0) + (+e.amount || 0);
    let overdueCount = 0, overdue = 0, receivable = 0, payable = 0;
    const t = todayIso();
    for (const d of b.docs) {
      const bal = r2((+d.total || 0) - (paid[d.id] || 0)); if (bal <= 0.004) continue;
      if (d.kind === 'invoice') { receivable += bal; if (d.due && d.due < t) { overdueCount++; overdue += bal; } } else payable += bal;
    }
    const recons = b.recons.map(r => r.statementDate).sort();
    return { ...c, name: s.name, province: s.province, taxName: s.taxName, taxRate: s.taxRate, fyStart: s.fyStart,
      toReview: b.bankTxns.filter(x => x.status === 'new').length, overdueCount, overdue: r2(overdue),
      receivable: r2(receivable), payable: r2(payable), lastReconciled: recons[recons.length - 1] || '',
      lastEntry: b.entries.reduce((m, e) => (e.date > m ? e.date : m), ''), transactions: b.entries.length, hasCode: !!codes[c.id] };
  }

  function check(b, w) {
    if (!COLS.includes(w.collection)) throw new ApiError(404, 'Unknown collection.');
    if (w.op === 'set' && w.collection === 'entries') {
      let dr = 0, cr = 0;
      for (const l of w.data.lines || []) { dr += Math.round((+l.debit || 0) * 100); cr += Math.round((+l.credit || 0) * 100); }
      if (dr !== cr) throw new ApiError(400, 'Debits and credits don’t balance.');
      if (!dr) throw new ApiError(400, 'A transaction needs an amount.');
    }
    if (w.op === 'delete') {
      if (w.collection === 'accounts' && b.entries.some(e => (e.lines || []).some(l => l.account === w.id))) throw new ApiError(409, 'This account has transactions, so it can’t be deleted. Mark it inactive instead.');
      if (w.collection === 'contacts' && (b.docs.some(d => d.contactId === w.id) || b.entries.some(e => e.contactId === w.id))) throw new ApiError(409, 'This contact appears on transactions, so it can’t be deleted.');
      if (w.collection === 'employees' && b.payruns.some(r => r.lines.some(l => l.employeeId === w.id))) throw new ApiError(409, 'This employee has been paid, so they can’t be deleted. Mark them inactive instead.');
      if (w.collection === 'docs' && b.entries.some(e => e.applyTo === w.id)) throw new ApiError(409, 'Delete the payments on this invoice or bill first.');
    }
  }
  function apply(b, w) {
    check(b, w);
    const arr = b[w.collection], i = arr.findIndex(x => x.id === w.id);
    if (w.op === 'set') { const rec = { ...w.data, id: w.id }; if (i >= 0) arr[i] = rec; else arr.push(rec); }
    else {
      if (i >= 0) arr.splice(i, 1);
      if (w.collection === 'entries') b.bankTxns.forEach(t => { if (t.entryId === w.id) { t.status = 'new'; t.entryId = ''; } });
    }
  }
  function transact(id, fn) { const work = clone(books[id]); fn(work); work.rev = (books[id].rev || 0) + 1; books[id] = work; return { ok: true, rev: work.rev }; }

  function createCompany(body) {
    const name = String(body.name || '').trim(); if (!name) throw new ApiError(400, 'Give the company a name.');
    const p = PROVS[body.province] || {};
    const company = { name, fyStart: +body.fyStart || 1, taxName: body.taxName || p.taxName || 'HST', taxRate: body.taxRate ?? p.taxRate ?? 13,
      qstRate: p.qstRate || 0, terms: 30, currency: '$', bn: '', province: body.province || '', filingFreq: 'quarterly', orgType: ['npo', 'charity'].includes(body.orgType) ? body.orgType : 'business' };
    const id = rid('co_'), b = { company };
    if (/^\d{4}$/.test(String(body.code || ''))) { codes[id] = String(body.code); company.hasCode = true; }
    COLS.forEach(c => (b[c] = []));
    if (body.copyFrom && books[body.copyFrom]) b.accounts = clone(books[body.copyFrom].accounts).map(a => { delete a.importMap; delete a.lastStatement; return a; });
    else {
      const split = company.qstRate > 0;
      b.accounts = DEFAULT_ACCOUNTS.map(([code, n, type, detail]) => ({ id: 'a' + code, code, name: detail === 'tax' ? (split ? 'GST payable' : `${company.taxName} payable`) : n, type, detail, desc: '', active: true }));
      if (split) b.accounts.push({ id: 'a2210', code: '2210', name: 'QST payable', type: 'Liability', detail: 'qst', desc: '', active: true });
    }
    const tpl = templates[company.province];
    if (body.examples && tpl && !body.copyFrom) ['contacts', 'employees', 'rules', 'docs', 'entries', 'bankTxns'].forEach(c => (b[c] = clone(tpl[c])));
    b.rev = 1; books[id] = b;
    const entry = { id, name, archived: false, created: Date.now() }; cos.push(entry);
    return entry;
  }

  const auditLogs = {};
  // The demo's firms (see /api/firms below).
  let demoSignups = 'approval', demoDefaultPlan = 'essentials', m0;
  const day = 864e5;
  let demoFirms = [
    { id: 'f_demo', name: 'Demo firm', status: 'active', ai: true, aiCapUsd: 10, plan: 'plus', created: Date.now() - 90 * day, users: 1, companies: 0, owner: { name: 'Demo user', username: 'demo' }, lastLogin: Date.now(), aiSpentUsd: 0, main: true },
    { id: 'f_north', name: 'North Ledger Bookkeeping (example)', status: 'pending', ai: false, aiCapUsd: 10, plan: 'essentials', created: Date.now() - 2 * 3600e3, users: 1, companies: 0, owner: { name: 'Nora Example', username: 'nora@example.com' }, lastLogin: 0, aiSpentUsd: 0 },
    { id: 'f_coast', name: 'Coast Accounting (example)', status: 'active', ai: true, aiCapUsd: 25, plan: 'plus', created: Date.now() - 40 * day, users: 4, companies: 12, owner: { name: 'Cal Example', username: 'cal@example.com' }, lastLogin: Date.now() - 3 * day, aiSpentUsd: 6.4 },
  ];
  // Licence codes: a made-up key and codes that don't turn anything on (the demo has no private key).
  const demoLic = { key: { publicKey: 'DEMO-public-key-shown-here-in-your-own-copy', created: Date.now() - 30 * day }, issued: [
    { id: 'd1', name: 'Harbour Yoga (example)', email: 'owner@example.com', plan: 'plus', kind: 'business', until: new Date(Date.now() + 200 * day).toISOString().slice(0, 10), issued: new Date(Date.now() - 165 * day).toISOString().slice(0, 10), note: '', code: 'TB1-DEMO.example-code-not-real' },
    { id: 'd2', name: 'Birch Bookkeeping (example)', email: '', plan: 'essentials', kind: 'firm', until: new Date(Date.now() + 12 * day).toISOString().slice(0, 10), issued: new Date(Date.now() - 353 * day).toISOString().slice(0, 10), note: 'Paid by e-transfer', code: 'TB1-DEMO.example-code-not-real' },
  ] };
  let auditSeq = 0;
  function route(url, method, body) {
    const path = url.split('?')[0];
    if (path === '/api/health') return { ok: true };
    const demoUser = { id: 'u_demo', name: 'Demo user', username: 'demo', role: 'owner', companies: [], disabled: false, lastLogin: Date.now(), mustChange: false, platformAdmin: true, firmName: demoFirms[0].name, firmId: 'f_demo', firmPlan: demoFirms[0].plan };
    if (path === '/api/auth/me') return { user: demoUser, idleMinutes: 480, licence: { on: false, state: 'off', canEnter: false, canIssue: true } };
    // The administrator's Overview, from the made-up firms and licences above.
    if (path === '/api/overview') {
      const act = demoFirms.filter(f => f.status === 'active'), iso = d => new Date(d).toISOString().slice(0, 10);
      return { firms: { total: demoFirms.length, active: act.length, pending: demoFirms.filter(f => f.status === 'pending').length, suspended: demoFirms.filter(f => f.status === 'suspended').length,
          people: demoFirms.reduce((t, f) => t + f.users, 0), companies: demoFirms.reduce((t, f) => t + (f.main ? cos.length : f.companies), 0), newThisMonth: 1, activeLast30: 2,
          byPlan: { essentials: act.filter(f => f.plan === 'essentials').length, plus: act.filter(f => f.plan === 'plus').length },
          recent: demoFirms.filter(f => !f.main).map(f => ({ name: f.name, created: f.created })) },
        ai: { totalUsd: 6.4, top: [{ name: 'Coast Accounting (example)', usd: 6.4 }] },
        licences: { made: demoLic.issued.length, active: 2, endingSoon: 1, ended: 0, byPlan: { essentials: 1, plus: 1 }, byKind: { firm: 1, business: 1 },
          due: demoLic.issued.filter(l => l.until <= iso(Date.now() + 30 * day)).map(({ id, name, email, plan, until }) => ({ id, name, email, plan, until })) } };
    }
    if (path === '/api/overview/downloads') return { repo: 'example', releases: [{ tag: 'v1.3.1', published: new Date(Date.now() - 3 * day).toISOString(), installs: 41, windows: 37, mac: 3, linux: 1 }, { tag: 'v1.3.0', published: new Date(Date.now() - 20 * day).toISOString(), installs: 63, windows: 58, mac: 4, linux: 1 }], totals: { installs: 104, windows: 95, mac: 7, linux: 2 } };
    if (path === '/api/licence') return { on: false, state: 'off', canEnter: false, canIssue: true };
    if (path === '/api/licences' && method === 'GET') return { ...demoLic, issued: demoLic.issued.slice().reverse(), licensing: false, inBuild: null };
    if (path === '/api/licences' && method === 'POST') {
      if (!String(body.name || '').trim()) throw new ApiError(400, 'Enter who the licence is for (the client’s business name).');
      const rec = { id: 'd' + (demoLic.issued.length + 1), name: String(body.name).trim(), email: body.email || '', plan: body.plan, kind: body.kind || 'firm', until: body.until, issued: new Date().toISOString().slice(0, 10), note: body.note || '', code: 'TB1-DEMO.example-code-not-real-made-in-your-own-copy', ...(body.renews ? { renews: body.renews } : {}) };
      demoLic.issued.push(rec);
      return { licence: rec };
    }
    if (path.startsWith('/api/licences')) throw new ApiError(400, 'Your licence key is made in your own copy of Sumlora, not in the demo.');
    if (path === '/api/auth/logout') return { ok: true };
    if (path === '/api/users' && method === 'GET') return { users: [demoUser], idleMinutes: 480, firm: demoFirms[0] };
    if (path === '/api/security/log') return { log: [] };
    // Firms: two made-up firms so the administrator's page has something to show. Changes last until the page reloads.
    if (path === '/api/firm') {
      if (method === 'PUT') { const n = String((body && body.name) || '').trim(); if (!n) throw new ApiError(400, 'Enter the firm’s name.'); demoFirms[0].name = n; }
      return { ok: true, firm: demoFirms[0] };
    }
    if (path === '/api/firms' && method === 'GET') return { firms: demoFirms.map(f => (f.main ? { ...f, companies: cos.length } : f)), signups: demoSignups, defaultPlan: demoDefaultPlan, myFirm: 'f_demo' };
    if (path === '/api/firms/settings') { if (body.signups) demoSignups = body.signups; if (body.defaultPlan) demoDefaultPlan = body.defaultPlan; return { ok: true, signups: demoSignups, defaultPlan: demoDefaultPlan }; }
    m0 = path.match(/^\/api\/firms\/([^/]+)$/);
    if (m0) {
      const f = demoFirms.find(x => x.id === decodeURIComponent(m0[1]));
      if (!f) throw new ApiError(404, 'That firm doesn’t exist.');
      if (method === 'DELETE') { if (f.companies) throw new ApiError(409, 'This firm has companies, so it can’t be removed. Their books are kept while it’s suspended.'); demoFirms = demoFirms.filter(x => x !== f); return { ok: true }; }
      if (f.main && body.status && body.status !== 'active') throw new ApiError(409, 'You can’t suspend your own firm.');
      for (const k of ['status', 'ai', 'aiCapUsd', 'name', 'plan']) if (body[k] !== undefined) f[k] = body[k];
      return { ok: true, firm: f };
    }
    if (path.startsWith('/api/users') || path.startsWith('/api/auth') || path === '/api/security') throw new ApiError(400, 'Users and passwords aren’t available in the demo.');
    if (path.startsWith('/api/backups')) {
      if (method === 'GET') return { enabled: true, folder: 'Demo', target: 'Not available in the demo: nothing is saved', keepDays: 30, lastRun: Date.now(), lastCount: cos.length, lastError: '', suggestions: [] };
      throw new ApiError(400, 'Backups aren’t available in the demo, because nothing in it is saved.');
    }
    // AI suggestions: the demo can't call Claude, so it makes simple keyword guesses to show how the screen works.
    if (path === '/api/ai') {
      if (method === 'GET') return { configured: true, demo: true, model: 'claude-haiku-4-5', capUsd: 20, spentUsd: 0, linesThisMonth: 0, source: 'env', keyHint: '(demo)', models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (lowest cost)' }, { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (more accurate)' }] };
      throw new ApiError(400, 'AI settings aren’t available in the demo.');
    }
    if (path === '/api/companies' && method === 'GET') return { companies: cos.map(summary), provinces: PROVS, pendingFirms: demoFirms.filter(f => f.status === 'pending').length };
    if (path === '/api/companies' && method === 'POST') return { ok: true, company: summary(createCompany(body)) };
    let m = path.match(/^\/api\/companies\/([^/]+)$/);
    if (m && method === 'PUT') { const c = cos.find(x => x.id === decodeURIComponent(m[1])); if (!c) throw new ApiError(404, 'No such company.'); if (body.archived !== undefined) c.archived = !!body.archived; return { ok: true, company: summary(c) }; }
    m = path.match(/^\/api\/c\/([^/]+)(\/.*)$/);
    if (!m) throw new ApiError(404, 'Not found');
    const id = decodeURIComponent(m[1]), rest = m[2], b = books[id];
    if (!b) throw new ApiError(404, 'That company doesn’t exist.');
    // A simple activity log kept in memory, like the real one.
    const log = (auditLogs[id] = auditLogs[id] || []);
    const note = w => {
      const before = (b[w.collection] || []).find(x => x.id === w.id);
      const d = w.data || before || {};
      log.unshift({ seq: ++auditSeq, at: Date.now(), username: 'demo', name: 'Demo user', action: w.op === 'delete' ? 'delete' : before ? 'change' : 'add', collection: w.collection, record_id: w.id,
        summary: [d.type || d.kind || '', d.number ? '#' + d.number : '', d.name || '', d.date || '', d.memo || ''].filter(Boolean).join(' ').slice(0, 120), before: before && clone(before), after: w.op === 'set' ? clone(w.data) : undefined });
    };
    if (rest.split('?')[0] === '/audit') return { rows: log.slice(0, 200).map(({ before, after, ...r }) => r), users: log.length ? [{ username: 'demo', name: 'Demo user' }] : [] };
    const am = rest.match(/^\/audit\/(\d+)$/);
    if (am) { const row = log.find(x => x.seq === Number(am[1])); if (!row) throw new ApiError(404, 'Not found'); return row; }
    if (rest === '/state') return { ...clone(b), companyId: id };
    let r = rest.match(/^\/records\/([A-Za-z]+)\/([^/]+)$/);
    if (r && method === 'PUT') { const w0 = { op: 'set', collection: r[1], id: decodeURIComponent(r[2]), data: body }; note(w0); return transact(id, w => apply(w, w0)); }
    if (r && method === 'DELETE') { const w0 = { op: 'delete', collection: r[1], id: decodeURIComponent(r[2]) }; note(w0); return transact(id, w => apply(w, w0)); }
    if (rest === '/batch') { body.writes.forEach(note); return transact(id, w => body.writes.forEach(x => apply(w, x))); }
    if (rest === '/settings') { const out = transact(id, w => { w.company = { ...w.company, ...body }; }); cos.find(c => c.id === id).name = body.name; return out; }
    if (rest === '/bank/import') {
      let added = 0, skipped = 0; const seen = {};
      const out = transact(id, w => {
        for (const row of body.rows) {
          let key = row.fitid ? 'f:' + row.fitid : `${row.date}|${(+row.amount).toFixed(2)}|${String(row.desc || '').toLowerCase()}`;
          seen[key] = (seen[key] || 0) + 1; if (!row.fitid && seen[key] > 1) key += '#' + seen[key];
          const bid = 'b_' + body.account + '_' + [...key].reduce((h, ch) => ((h * 31) + ch.charCodeAt(0)) >>> 0, 7).toString(16);
          if (w.bankTxns.some(t => t.id === bid)) { skipped++; continue; }
          w.bankTxns.push({ id: bid, account: body.account, date: row.date, amount: r2(+row.amount), desc: String(row.desc || '').slice(0, 300), fitid: row.fitid || '', status: 'new', entryId: '', imported: Date.now(), file: body.fileName || '' });
          added++;
        }
      });
      return { ...out, added, skipped };
    }
    if (rest === '/attachments') throw new ApiError(400, 'Attaching files isn’t available in the demo, because nothing in it is saved.');
    if (rest === '/questions' && method === 'POST') {
      const list = books[id].questions || [], rec = (books[id][body.target] || []).find(x => x.id === body.targetId);
      if (!rec) throw new ApiError(404, 'That transaction isn’t here any more.');
      const text = String(body.text || '').trim(); if (!text) throw new ApiError(400, 'Type your question.');
      const q = { id: rid('q_'), target: body.target, targetId: body.targetId, status: 'open', created: Date.now(), label: `${rec.date || ''} · ${rec.type || rec.kind || ''}${rec.memo ? ' · ' + rec.memo : ''}`,
        thread: [{ by: 'demo', name: 'Demo user', role: 'owner', at: Date.now(), text }] };
      return transact(id, w => { w.questions = [...list, q]; });
    }
    m = rest.match(/^\/questions\/([^/]+)(?:\/(reply|resolve|reopen))?$/);
    if (m) return transact(id, w => {
      w.questions = (w.questions || []).map(q => q.id !== m[1] ? q : m[2] === 'reply' ? { ...q, status: 'open', thread: [...q.thread, { by: 'demo', name: 'Demo user', role: 'owner', at: Date.now(), text: String(body.text || '') }] } : { ...q, status: m[2] === 'resolve' ? 'resolved' : 'open' });
      if (method === 'DELETE') w.questions = w.questions.filter(q => q.id !== m[1]);
    });
    if (rest === '/receipts' || /^\/receipts\/[^/]+\/read$/.test(rest)) throw new ApiError(400, 'Sending receipts isn’t available in the demo, because nothing in it is saved. In Sumlora, receipts go to this screen from a phone or a computer.');
    if (rest === '/closing') { const out = transact(id, w => { w.company = { ...w.company, closingDate: body.date || '', closingPassword: body.password !== undefined ? !!body.password : !!w.company.closingPassword }; }); return out; }
    if (rest === '/closing/unlock') return { ok: true, minutes: 15 };
    if (rest === '/code') {
      if (!body.remove && !/^\d{4}$/.test(String(body.code))) throw new ApiError(400, 'The company code has to be 4 digits.');
      if (body.remove) delete codes[id]; else codes[id] = String(body.code);
      return transact(id, w => { w.company = { ...w.company, hasCode: !body.remove }; });
    }
    if (rest === '/code/check') { if (codes[id] && String(body.code) !== codes[id]) throw new ApiError(403, 'That code isn’t right for this company.'); return { ok: true }; }
    if (rest === '/mail' && method === 'GET') return { configured: false, sentToday: 0 };
    if (rest.startsWith('/mail') || rest === '/logo') throw new ApiError(400, 'Email and logos aren’t available in the demo, because nothing in it is saved. You can still download invoices and statements as PDFs.');
    if (rest === '/import') throw new ApiError(400, 'Importing isn’t available in the demo, because nothing in it is saved. You can still choose files to see how they’re read and checked.');
    if (rest === '/ai/read') throw new ApiError(400, 'Reading receipts needs a Claude API key, so it isn’t available in the demo. Try “Suggest with AI” under Banking instead.');
    if (rest === '/ai/suggest') {
      if (!b.company.ai) throw new ApiError(409, 'AI suggestions are turned off for this company. Turn them on in Settings.');
      const fr = b.company.lang === 'fr';
      const guess = [[/TIM HORTONS|STARBUCKS|RESTAURANT|CAFE/i, 'a6300', fr ? 'Café ou restaurant : repas (démo)' : 'Coffee shop or restaurant: meals (demo)'],
        [/STAPLES|BUREAU EN GROS|AMAZON/i, 'a6400', fr ? 'Fournitures de bureau (démo)' : 'Office supplies store (demo)'],
        [/BELL|ROGERS|TELUS|VIDEOTRON/i, 'a6800', fr ? 'Fournisseur de téléphone (démo)' : 'Phone provider (demo)'],
        [/FEE|FRAIS|INTEREST|INTÉRÊT/i, 'a6100', fr ? 'Frais bancaires (démo)' : 'Bank charge (demo)']];
      let count = 0;
      const out = transact(id, w => {
        for (const bid of body.ids) {
          const t = w.bankTxns.find(x => x.id === bid); if (!t || t.status !== 'new') continue;
          const g = guess.find(([re]) => re.test(t.desc)) || [null, t.amount > 0 ? 'a4000' : 'a6400', fr ? 'Supposition de la démo, à vérifier' : 'Demo guess: check this one'];
          if (!w.accounts.some(a => a.id === g[1])) continue;
          t.ai = { account: g[1], contactId: '', tax: g[1] !== 'a6100' && !!(+w.company.taxRate), confidence: g[0] ? 'medium' : 'low', reason: g[2], model: 'demo', at: Date.now() };
          count++;
        }
      });
      return { ...out, count, usd: 0 };
    }
    if (rest === '/examples') throw new ApiError(400, 'The demo companies already include example data. Create a new Ontario or Quebec company with “Add example data” ticked to get another copy.');
    if (rest === '/backup') return { format: 'tally-books-backup', version: 1, exportedAt: new Date().toISOString(), ...clone(b) };
    if (rest === '/restore') { if (body.format !== 'tally-books-backup') throw new ApiError(400, 'That file isn’t a Sumlora backup.'); return transact(id, w => { w.company = body.company; COLS.forEach(c => (w[c] = clone(body[c] || []))); }); }
    throw new ApiError(404, 'Not found');
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/api/')) return realFetch(url, opts);
    try { return json(200, route(u, (opts.method || 'GET').toUpperCase(), opts.body ? JSON.parse(opts.body) : null)); }
    catch (e) { return json(e.status || 500, { error: e.message }); }
  };
  window.EventSource = undefined; // no live updates needed: there is only this page
})();
