'use strict';
// The AI assistant add-on: off until an owner adds it, read-only answers worked out from the books,
// a monthly number of questions, and the add-on's line on a Stripe subscription.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/server/app');
const { Books, runTool, cleanHistory, fyStartOf, fyEndOf } = require('../src/server/assistant');
const { Billing, recordOf } = require('../src/server/billing');

let server, fake, base, dir, co, other, cookie = '', staffCookie = '', clientCookie = '';
const KEY = 'sk-ant-api03-' + 'q'.repeat(40);
const seen = [];       // request bodies the fake API received
let script = null;     // how the fake API answers the next question

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b); seen.push(j);
      const reply = script(j);
      res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body || reply));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-asst-'));
  server = createApp({ dataDir: dir, autoBackup: false, aiUrl: `http://127.0.0.1:${fake.address().port}/v1/messages` });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Maple Bakery', province: 'ON' })).json.company.id;
  other = (await call('POST', '/api/companies', { name: 'Other Co', province: 'ON' })).json.company.id;
  const invite = async (username, role, pw) => {
    const link = (await call('POST', '/api/users', { name: username, username, role, companies: [co], invite: true })).json.user.link;
    const a = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, password: pw }) });
    return a.headers.get('set-cookie').split(';')[0];
  };
  staffCookie = await invite('staff@example.com', 'staff', 'quiet maple ferry orbit');
  clientCookie = await invite('client@example.com', 'client', 'purple walrus harbour lantern');
  // Some books: $5,000 of sales and $1,200 of rent this year.
  const accts = (await state()).accounts;
  const bank = accts.find(a => a.detail === 'bank').id, sales = accts.find(a => a.type === 'Income').id, rent = accts.find(a => /rent/i.test(a.name) && a.type === 'Expense').id;
  const y = new Date().getFullYear();
  for (const [eid, date, dr, cr, amt, memo] of [['s1', `${y}-01-15`, bank, sales, 5000, 'Wedding cakes'], ['r1', `${y}-01-20`, rent, bank, 1200, 'January rent']]) {
    const w = await call('PUT', `/api/c/records/entries/${eid}`, { type: 'journal', date, memo, lines: [{ account: dr, debit: amt, credit: 0 }, { account: cr, debit: 0, credit: amt }] });
    assert.equal(w.status, 200, JSON.stringify(w.json));
  }
});
after(async () => { await server.shutdown(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, url, body, ck = cookie, cid = co) {
  const res = await fetch(base + url.replace('/c/', `/c/${cid}/`), { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), cookie: ck }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const state = async (ck = cookie) => (await call('GET', '/api/c/state', undefined, ck)).json;
const ask = (question, ck = cookie, extra = {}) => call('POST', '/api/c/assistant', { question, ...extra }, ck);

/** A fake Claude that asks for one tool, then answers with what the tool returned. */
const oneTool = (name, input, answer) => j => {
  const last = j.messages[j.messages.length - 1];
  if (typeof last.content === 'string') return { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name, input }], usage: { input_tokens: 3000, output_tokens: 60 } };
  const result = JSON.parse(last.content[0].content);
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: answer(result) }], usage: { input_tokens: 3500, output_tokens: 80 } };
};

test('assistant: off unless an owner adds it; no button, no questions', async () => {
  assert.deepEqual((await state()).assistant, { on: false });
  assert.equal((await ask('How are we doing?')).status, 403);
  assert.equal((await call('PUT', `/api/companies/${co}`, { assistant: true }, staffCookie)).status, 403, 'staff can’t buy add-ons');
  assert.equal((await call('PUT', `/api/companies/${co}`, { assistant: true }, clientCookie)).status, 403, 'nor can a client');
  assert.equal(seen.length, 0, 'nothing was sent to the AI');
});

test('assistant: an owner adds it; it answers from the books with links to the report', async () => {
  const on = await call('PUT', `/api/companies/${co}`, { assistant: true });
  assert.equal(on.status, 200); assert.equal(on.json.company.assistant, true);
  let st = (await state()).assistant;
  assert.equal(st.on, true); assert.equal(st.ready, false, 'no API key yet');
  assert.equal((await ask('Net income?')).status, 409);
  assert.equal((await call('PUT', '/api/ai', { apiKey: KEY })).status, 200);
  st = (await state()).assistant;
  assert.deepEqual({ ready: st.ready, used: st.used, cap: st.cap }, { ready: true, used: 0, cap: 100 });

  script = oneTool('profit_and_loss', {}, r => `Net income is **$${r.netIncome.toFixed(2)}** this fiscal year.`);
  const r = await ask('What is our net income this year?', staffCookie);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.answer, /\$3800\.00/, 'sales 5,000 less rent 1,200');
  assert.equal(r.json.links[0].view, 'reports'); assert.equal(r.json.links[0].tab, 'pl');
  assert.equal(r.json.assistant.used, 1);
  // What Claude was given: the rules, the chart of accounts (cached), the tools, but no ledger dump.
  const first = seen[0];
  assert.match(first.system[0].text, /Never estimate, invent/); assert.equal(first.system[1].cache_control.type, 'ephemeral');
  assert.ok(first.tools.some(t => t.name === 'open_invoices_and_bills'));
  assert.ok(!JSON.stringify(first).includes('Wedding cakes'), 'transactions are only sent when a tool needs them');
  // The tool result went back as a tool_result for the right call.
  assert.equal(seen[1].messages[2].content[0].tool_use_id, 'tu_1');
  // Recorded in the company's activity.
  const act = (await call('GET', '/api/c/audit')).json;
  assert.ok(JSON.stringify(act).includes('asked the AI assistant: What is our net income this year?'));
});

test('assistant: clients of the company can ask too; a different company can’t be reached', async () => {
  script = oneTool('search_transactions', { text: 'rent' }, r => `Found ${r.count} transaction totalling $${r.total}.`);
  const r = await ask('How much rent?', clientCookie);
  assert.equal(r.status, 200); assert.match(r.json.answer, /Found 1 transaction totalling \$1200/);
  assert.equal((await ask('Hi', cookie.replace(/.$/, 'x'))).status, 401);
  assert.equal((await call('POST', '/api/c/assistant', { question: 'x' }, cookie, other)).status, 403, 'the add-on is per company');
});

test('assistant: a monthly number of questions; failed questions aren’t counted', async () => {
  script = () => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
  const before = (await state()).assistant.used;
  assert.equal((await ask('Anything')).status, 503);
  assert.equal((await state()).assistant.used, before, 'refunded');
  assert.equal((await ask('   ')).status, 400);
  assert.equal((await state()).assistant.used, before);
  assert.equal((await call('PUT', '/api/ai', { assistantCap: -1 })).status, 400);
  assert.equal((await call('PUT', '/api/ai', { assistantCap: before + 1 })).status, 200);
  script = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fine.' }], usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal((await ask('One more')).status, 200);
  const r = await ask('And another');
  assert.equal(r.status, 429); assert.match(r.json.error, /questions for this month/);
  assert.equal((await state()).assistant.left, 0);
  await call('PUT', '/api/ai', { assistantCap: 100 });
});

test('assistant: turning it off hides it again', async () => {
  assert.equal((await call('PUT', `/api/companies/${co}`, { assistant: false })).status, 200);
  assert.deepEqual((await state()).assistant, { on: false });
  assert.equal((await ask('Still there?')).status, 403);
  await call('PUT', `/api/companies/${co}`, { assistant: true });
});

/* ---------- the tools, on books in memory ---------- */
function memStore(data) { return { list: c => data[c] || [] }; }
const ACC = [
  { id: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank' }, { id: 'ar', name: 'Accounts receivable', type: 'Asset', detail: 'ar' },
  { id: 'ap', name: 'Accounts payable', type: 'Liability', detail: 'ap' }, { id: 'hst', name: 'HST payable', type: 'Liability', detail: 'tax' },
  { id: 'cap', name: 'Share capital', type: 'Equity' }, { id: 'sales', name: 'Sales', type: 'Income' },
  { id: 'cogs', name: 'Flour and sugar', type: 'Cost of Goods Sold' }, { id: 'rent', name: 'Rent', type: 'Expense' }, { id: 'fuel', name: 'Fuel', type: 'Expense' },
];
const je = (id, date, lines, extra = {}) => ({ id, type: 'journal', date, lines: lines.map(([account, debit, credit]) => ({ account, debit, credit })), ...extra });
const BOOKS = {
  accounts: ACC,
  contacts: [{ id: 'c1', name: 'Cafe Nord', kind: 'customer' }, { id: 'v1', name: 'Petro Station', kind: 'vendor' }, { id: 'v2', name: 'Landlord Inc', kind: 'vendor' }],
  entries: [
    je('o', '2025-03-01', [['bank', 1000, 0], ['cap', 0, 1000]]),
    je('p', '2025-06-01', [['bank', 500, 0], ['sales', 0, 500]]),                          // last fiscal year's profit
    je('i1', '2026-02-01', [['ar', 1130, 0], ['sales', 0, 1000], ['hst', 0, 130]], { type: 'invoice', contactId: 'c1', ref: '101' }),
    je('pay', '2026-02-20', [['bank', 500, 0], ['ar', 0, 500]], { type: 'payment', contactId: 'c1', applyTo: 'd1', amount: 500 }),
    je('f1', '2026-03-03', [['fuel', 80, 0], ['bank', 0, 80]], { type: 'expense', contactId: 'v1', memo: 'Gas for deliveries' }),
    je('f2', '2026-04-03', [['fuel', 70, 0], ['bank', 0, 70]], { type: 'expense', contactId: 'v1' }),
    je('b1', '2026-04-01', [['rent', 1200, 0], ['ap', 0, 1200]], { type: 'bill', contactId: 'v2' }),
    je('cg', '2026-04-10', [['cogs', 200, 0], ['bank', 0, 200]], { type: 'expense' }),
  ],
  docs: [
    { id: 'd1', kind: 'invoice', number: '101', contactId: 'c1', date: '2026-02-01', due: '2026-03-03', total: 1130 },
    { id: 'd2', kind: 'bill', contactId: 'v2', date: '2026-04-01', due: '2026-05-01', total: 1200 },
  ],
};
const NOW = Date.parse('2026-06-15T12:00:00');
const books = () => new Books(memStore(BOOKS), { name: 'Maple', fyStart: 1 }, NOW);
const tool = (name, input) => { const o = runTool(books(), name, input); return { ...o, data: JSON.parse(o.text) }; };

test('assistant tools: profit and loss and balance sheet match, and the balance sheet balances', () => {
  const pl = tool('profit_and_loss', {}).data;
  assert.equal(pl.from, '2026-01-01'); assert.equal(pl.to, '2026-06-15');
  assert.equal(pl.sections.Income.total, 1000); assert.equal(pl.sections['Cost of Goods Sold'].total, 200); assert.equal(pl.sections.Expense.total, 1350);
  assert.equal(pl.grossProfit, 800); assert.equal(pl.netIncome, -550);
  assert.deepEqual(pl.sections.Expense.accounts.map(a => a.account), ['Rent', 'Fuel'], 'largest first');
  const bs = tool('balance_sheet', { as_of: '2026-06-15' }).data;
  assert.equal(bs.sections.Equity.retainedEarnings, 500); assert.equal(bs.sections.Equity.netIncomeThisFiscalYear, -550);
  assert.equal(bs.sections.Asset.total, bs.liabilitiesAndEquity, 'assets = liabilities + equity');
  assert.equal(bs.sections.Asset.total, 1650 + 630);
});

test('assistant tools: balances, activity, search, totals by vendor, open invoices', () => {
  const cash = tool('account_balances', { type: 'bank_and_cards' }).data.accounts;
  assert.deepEqual(cash.map(a => [a.account, a.amount, a.kind]), [['Chequing', 1650, 'bank']]);
  const act = tool('account_activity', { account_id: 'fuel', from: '2026-01-01', to: '2026-12-31' });
  assert.equal(act.data.closing, 150); assert.equal(act.data.transactions[0].date, '2026-04-03', 'newest first');
  assert.equal(act.link.view, 'register');
  assert.equal(tool('account_activity', { account_id: 'nope' }).data.error.includes('No account'), true);
  const s = tool('search_transactions', { text: 'deliveries' }).data;
  assert.equal(s.count, 1); assert.equal(s.total, 80); assert.equal(s.transactions[0].contact, 'Petro Station');
  assert.equal(tool('search_transactions', { contact_id: 'v1', min_amount: 75 }).data.count, 1);
  const v = tool('totals_by_contact', { side: 'vendors' }).data;
  assert.deepEqual(v.rows.map(r => [r.name, r.amount]), [['Landlord Inc', 1200], ['(no customer or vendor)', 200], ['Petro Station', 150]]);
  const inv = tool('open_invoices_and_bills', { kind: 'invoices' });
  assert.equal(inv.data.total, 630); assert.equal(inv.data.items[0].daysOverdue, 104); assert.equal(inv.data.aging['61-90'] + inv.data.aging.over90, 630);
  assert.deepEqual(inv.link, { view: 'sales', status: 'unpaid' });
  assert.equal(tool('open_invoices_and_bills', { kind: 'bills', overdue_only: true }).data.total, 1200);
  assert.equal(tool('profit_and_loss', { from: '2026-05-01', to: '2026-01-01' }).data.error, 'The start date is after the end date.');
});

test('assistant: conversation history is cleaned; fiscal years work out', () => {
  assert.deepEqual(cleanHistory([{ role: 'assistant', text: 'hi' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'c' }, { role: 'system', text: 'x' }, { role: 'user', text: 'dangling' }]),
    [{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'c' }]);
  assert.deepEqual(cleanHistory('nope'), []);
  assert.equal(fyStartOf('2026-03-15', 4), '2025-04-01'); assert.equal(fyEndOf('2026-03-15', 4), '2026-03-31');
  assert.equal(fyStartOf('2026-03-15', 1), '2026-01-01'); assert.equal(fyEndOf('2026-03-15', 1), '2026-12-31');
});

/* ---------- the add-on on a Stripe subscription ---------- */
test('billing: the add-on has its own price and its own line on a subscription', async () => {
  const calls = [];
  const sub = { id: 'sub_1', status: 'active', customer: 'cus_1', current_period_end: 1900000000, metadata: { sumlora_plan: 'plus' }, items: { data: [{ id: 'si_plan', quantity: 3, price: { id: 'price_plan', metadata: { sumlora_plan: 'plus' } } }] } };
  const fakeFetch = async (url, init) => {
    const u = new URL(url), body = new URLSearchParams(init.body || ''), p = u.pathname.replace('/v1/', '');
    calls.push({ p, body: Object.fromEntries(body) });
    const ok = j => ({ ok: true, status: 200, json: async () => j });
    if (p === 'prices') return ok({ id: 'price_' + calls.length });
    if (p === 'checkout/sessions') return ok({ id: 'cs_x', url: 'https://checkout.stripe.com/x' });
    if (p === 'subscriptions/sub_1') {
      const items = sub.items.data;
      if (body.get('items[0][deleted]')) sub.items.data = items.filter(i => i.id !== body.get('items[0][id]'));
      else if (body.get('items[0][id]')) items.find(i => i.id === body.get('items[0][id]')).quantity = +body.get('items[0][quantity]');
      else items.push({ id: 'si_addon', quantity: +body.get('items[0][quantity]'), price: { id: body.get('items[0][price]'), metadata: { sumlora_addon: 'assistant' } } });
      return ok(sub);
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'nf' } }) };
  };
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-asst-bill-'));
  try {
    const b = new Billing(bdir, { fetch: fakeFetch });
    assert.equal(b.data.amounts.assistant, 500, '$5 a month by default');
    b.data.key = 'sk_test_' + 'z'.repeat(24);
    await assert.rejects(b.update({ amounts: { assistant: 0 } }), /add-on’s price/);
    await b.update({ amounts: { assistant: 7 } });
    assert.equal(b.data.amounts.assistant, 700);

    let rec = recordOf(sub, 'cus_1');
    assert.equal(rec.item, 'si_plan'); assert.deepEqual(rec.addons, {});
    rec = await b.setAddon(rec, 'assistant', 2);
    const priceCall = calls.find(c => c.p === 'prices');
    assert.equal(priceCall.body['metadata[sumlora_addon]'], 'assistant'); assert.equal(priceCall.body.unit_amount, '700');
    assert.deepEqual(rec.addons.assistant, { item: 'si_addon', quantity: 2 }); assert.equal(rec.item, 'si_plan', 'the plan line is still the plan line');
    rec = await b.setQuantity(rec, 4);
    assert.equal(sub.items.data.find(i => i.id === 'si_plan').quantity, 4); assert.equal(rec.addons.assistant.quantity, 2);
    rec = await b.setAddon(rec, 'assistant', 3);
    assert.equal(rec.addons.assistant.quantity, 3);
    const n = calls.length; await b.setAddon(rec, 'assistant', 3); assert.equal(calls.length, n, 'no change, no call');
    rec = await b.setAddon(rec, 'assistant', 0);
    assert.deepEqual(rec.addons, {}); assert.equal(sub.items.data.length, 1);
    // A new subscription includes the add-on for the companies that have it.
    await b.checkout({ kind: 'firm', id: 'f1', plan: 'plus', quantity: 5, assistant: 2, email: 'a@b.ca', trial: true, base: 'https://x' });
    const cs = calls.filter(c => c.p === 'checkout/sessions').pop().body;
    assert.equal(cs['line_items[1][quantity]'], '2'); assert.ok(cs['line_items[1][price]']);
    await b.checkout({ kind: 'firm', id: 'f1', plan: 'plus', quantity: 5, assistant: 0, email: 'a@b.ca', trial: true, base: 'https://x' });
    assert.equal(calls.filter(c => c.p === 'checkout/sessions').pop().body['line_items[1][price]'], undefined);
  } finally { fs.rmSync(bdir, { recursive: true, force: true }); }
});
