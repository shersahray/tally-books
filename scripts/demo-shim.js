/*
 * Browser-only stand-in for the Tally Books server, used by the online demo.
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
  DATA.companies.forEach(c => { books[c.entry.id] = clone(c.state); books[c.entry.id].rev = 1; });
  const templates = Object.fromEntries(DATA.companies.map(c => [c.state.company.province, c.state]));

  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const r2 = n => Math.round(n * 100) / 100;
  const rid = p => p + Math.random().toString(16).slice(2, 14);
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

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
      lastEntry: b.entries.reduce((m, e) => (e.date > m ? e.date : m), ''), transactions: b.entries.length };
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
      qstRate: p.qstRate || 0, terms: 30, currency: '$', bn: '', province: body.province || '', filingFreq: 'quarterly' };
    const id = rid('co_'), b = { company };
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

  function route(url, method, body) {
    const path = url.split('?')[0];
    if (path === '/api/health') return { ok: true };
    const demoUser = { id: 'u_demo', name: 'Demo user', username: 'demo', role: 'owner', companies: [], disabled: false, lastLogin: Date.now(), mustChange: false };
    if (path === '/api/auth/me') return { user: demoUser, idleMinutes: 480 };
    if (path === '/api/auth/logout') return { ok: true };
    if (path === '/api/users' && method === 'GET') return { users: [demoUser], idleMinutes: 480 };
    if (path.startsWith('/api/users') || path.startsWith('/api/auth') || path === '/api/security') throw new ApiError(400, 'Users and passwords aren’t available in the demo.');
    if (path.startsWith('/api/backups')) {
      if (method === 'GET') return { enabled: true, folder: 'Demo', target: 'Not available in the demo: nothing is saved', keepDays: 30, lastRun: Date.now(), lastCount: cos.length, lastError: '', suggestions: [] };
      throw new ApiError(400, 'Backups aren’t available in the demo, because nothing in it is saved.');
    }
    if (path === '/api/companies' && method === 'GET') return { companies: cos.map(summary), provinces: PROVS };
    if (path === '/api/companies' && method === 'POST') return { ok: true, company: summary(createCompany(body)) };
    let m = path.match(/^\/api\/companies\/([^/]+)$/);
    if (m && method === 'PUT') { const c = cos.find(x => x.id === decodeURIComponent(m[1])); if (!c) throw new ApiError(404, 'No such company.'); if (body.archived !== undefined) c.archived = !!body.archived; return { ok: true, company: summary(c) }; }
    m = path.match(/^\/api\/c\/([^/]+)(\/.*)$/);
    if (!m) throw new ApiError(404, 'Not found');
    const id = decodeURIComponent(m[1]), rest = m[2], b = books[id];
    if (!b) throw new ApiError(404, 'That company doesn’t exist.');
    if (rest === '/state') return { ...clone(b), companyId: id };
    let r = rest.match(/^\/records\/([A-Za-z]+)\/([^/]+)$/);
    if (r && method === 'PUT') return transact(id, w => apply(w, { op: 'set', collection: r[1], id: decodeURIComponent(r[2]), data: body }));
    if (r && method === 'DELETE') return transact(id, w => apply(w, { op: 'delete', collection: r[1], id: decodeURIComponent(r[2]) }));
    if (rest === '/batch') return transact(id, w => body.writes.forEach(x => apply(w, x)));
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
    if (rest === '/examples') throw new ApiError(400, 'The demo companies already include example data. Create a new Ontario or Quebec company with “Add example data” ticked to get another copy.');
    if (rest === '/backup') return { format: 'tally-books-backup', version: 1, exportedAt: new Date().toISOString(), ...clone(b) };
    if (rest === '/restore') { if (body.format !== 'tally-books-backup') throw new ApiError(400, 'That file isn’t a Tally Books backup.'); return transact(id, w => { w.company = body.company; COLS.forEach(c => (w[c] = clone(body[c] || []))); }); }
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
