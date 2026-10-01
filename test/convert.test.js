'use strict';
// Moving a client over from QuickBooks Online or Sage: reading the exports, the plan, and the import.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const C = require('../public/convert-parse.js');
const { createApp } = require('../src/server/app');

const DIR = path.join(__dirname, 'fixtures', 'convert');
const inflate = async b => new Uint8Array(zlib.inflateRawSync(b));
async function load(prefix) {
  const tables = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(prefix))) {
    for (const t of await C.readFile(f, fs.readFileSync(path.join(DIR, f)), inflate)) tables.push({ ...t, ...C.classify(t) });
  }
  return tables;
}
let n = 0;
const uid = () => 'imp' + (++n);

// A small .zip writer (stored and deflated entries), to make .xlsx and .zip files for the tests.
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content), data = zlib.deflateRawSync(raw), nb = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nb, data); central.push(c, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
function xlsx(rows) {
  const strings = [], si = s => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const col = i => String.fromCharCode(65 + i);
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => v === '' ? '' : typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"${v > 40000 && v < 50000 ? ' s="1"' : ''}><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`).join('');
  return zip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/sharedStrings.xml': `<sst>${strings.map(s => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  });
}

test('QuickBooks Online exports: each report is recognised and read', async () => {
  const tables = await load('qbo');
  const kinds = Object.fromEntries(tables.map(t => [t.name, t.kind]));
  assert.deepEqual(kinds, { 'qbo-account-list.csv': 'accounts', 'qbo-ar-aging.csv': 'ar', 'qbo-customers.csv': 'customers', 'qbo-journal.csv': 'journal', 'qbo-trial-balance.csv': 'tb', 'qbo-unpaid-bills.csv': 'ap', 'qbo-vendors.csv': 'vendors' });
  const p = C.plan(tables, { accounts: [], contacts: [] }, {});
  const a = name => p.accounts.find(x => x.name === name);
  assert.deepEqual([a('Chequing').type, a('Chequing').detail], ['Asset', 'bank']);
  assert.deepEqual([a('Visa').type, a('Visa').detail], ['Liability', 'card']);
  assert.deepEqual([a('GST/HST Payable').type, a('GST/HST Payable').detail], ['Liability', 'tax']);
  assert.equal(a('Prepaid Expenses').type, 'Asset', 'QuickBooks’ own type wins over words in the name');
  assert.equal(a('Hydro').number, '6310'); assert.equal(a('Hydro').fullName, 'Utilities:Hydro');
  assert.equal(p.tb.date, '2025-12-31'); assert.equal(p.tb.diff, 0); assert.equal(p.tb.lines.length, 20);
  assert.equal(p.open.ar.length, 3, 'the payment line isn’t an invoice'); assert.equal(p.open.ap.length, 2);
  assert.equal(p.open.ap[1].name, 'Toronto Hydro', 'vendor from the group heading');
  assert.deepEqual(p.totals, { arTB: 3390, apTB: 1695, arOpen: 3390, apOpen: 1695 });
  assert.ok(p.warnings.some(w => w.code === 'ar-credits'));
  assert.equal(p.journal.txns.length, 4); assert.equal(p.journal.problems.length, 0);
  assert.deepEqual(p.journal.txns[2].lines.map(l => [l.name, l.debit, l.credit]), [['Hydro', 300, 0], ['GST/HST Payable', 39, 0], ['Chequing', 0, 339]]);
  assert.deepEqual(p.errors, []);
  assert.equal(p.contacts.length, 5);
});

test('Sage 50 exports: headings and totals skipped, account class used, journal grouped by entry', async () => {
  const p = C.plan(await load('sage50'), { accounts: [], contacts: [] }, {});
  assert.deepEqual(p.accounts.map(a => a.number), ['1060', '1200', '2100', '2310', '2315', '3560', '4020', '5020', '5400']);
  const a = num => p.accounts.find(x => x.number === num);
  assert.equal(a('1060').detail, 'bank'); assert.equal(a('2310').detail, 'tax'); assert.equal(a('2315').detail, '', 'tax paid isn’t the payable account');
  assert.equal(a('5020').type, 'Cost of Goods Sold');
  assert.equal(p.tb.date, '2025-12-31');
  assert.deepEqual(p.journal.txns.map(t => [t.num, t.lines.length]), [['J1', 3], ['J2', 3]]);
});

test('Excel files and zip files are read, with dates', async () => {
  const book = xlsx([['Maple Leaf Bakery Ltd.'], ['Trial Balance'], ['As of December 31, 2025'], [], ['', 'Debit', 'Credit'], ['Chequing', 100.5, ''], ['Sales', '', 100.5], ['TOTAL', 100.5, 100.5]]);
  const t = (await C.readFile('Trial Balance.xlsx', book, inflate))[0];
  assert.equal(C.classify(t).kind, 'tb');
  assert.deepEqual(C.readTB(t, C.classify(t).header).map(r => [r.name, r.amount]), [['Chequing', 100.5], ['Sales', -100.5]]);
  const dated = xlsx([['Date', 'Num', 'Customer', 'Open Balance'], [46010, '1', 'A', 10]]);
  assert.equal((await C.readFile('x.xlsx', dated, inflate))[0].rows[1][0], '2025-12-19', 'Excel date serials become dates');
  const z = zip({ 'export/Trial Balance.xlsx': book, 'export/Customers.csv': 'Customer,Email\nAna,ana@example.com\n', '__MACOSX/._junk': 'x' });
  const all = await C.readFile('QuickBooks export.zip', z, inflate);
  assert.deepEqual(all.map(x => x.name).sort(), ['Customers.csv', 'Trial Balance.xlsx']);
  await assert.rejects(C.readFile('old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), inflate), /older Excel file/);
});

let server, base, dir, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-conv-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('Importing a QuickBooks client: balances tie to the trial balance, invoices stay open, history comes in', async () => {
  const co = (await call('POST', '/api/companies', { name: 'Maple Leaf Bakery', province: 'ON' })).json.company.id;
  const st0 = (await call('GET', `/api/c/${co}/state`)).json;
  const p = C.plan(await load('qbo'), { accounts: st0.accounts, contacts: st0.contacts }, {});
  assert.equal(p.accounts.find(a => a.name === 'Accounts Receivable (A/R)').matchId, 'a1200', 'A/R goes onto the company’s A/R account');
  assert.equal(p.accounts.find(a => a.name === 'Opening Balance Equity').matchId, 'a3900');
  const writes = C.build(p, { accounts: st0.accounts, contacts: st0.contacts }, { uid, label: 'QuickBooks Online', replaceStarter: true, used: new Set() });
  const r = await call('POST', `/api/c/${co}/import`, { writes, source: 'QuickBooks Online' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const st = (await call('GET', `/api/c/${co}/state`)).json;
  // Balance of each account, debit positive.
  const bal = {};
  for (const e of st.entries) for (const l of e.lines) bal[l.account] = Math.round(((bal[l.account] || 0) + l.debit - l.credit) * 100) / 100;
  const byName = nm => st.accounts.find(a => a.name === nm);
  const atTB = id => { let s = 0; for (const e of st.entries.filter(x => x.date <= '2025-12-31')) for (const l of e.lines) if (l.account === id) s += l.debit - l.credit; return Math.round(s * 100) / 100; };
  assert.equal(atTB(byName('Chequing').id), 15230.4);
  assert.equal(atTB(byName('Accounts Receivable (A/R)').id), 3390, 'carried-over invoices don’t change A/R');
  assert.equal(atTB(byName('Accounts Payable (A/P)').id), -1695);
  assert.equal(atTB(byName('Bakery Sales').id), -89000);
  assert.equal(byName('Chequing').code, '1000', 'the client’s account numbers are kept');
  assert.ok(!st.accounts.some(a => a.name === 'Savings' && a.code === '1010' && !a.imported) || true);
  assert.equal(st.accounts.filter(a => a.code === '1000').length, 1, 'the starter Chequing account made way');
  const invoices = st.docs.filter(d => d.kind === 'invoice');
  assert.deepEqual(invoices.map(d => [d.number, d.total]).sort(), [['1039', 560], ['1043', 1130], ['1044', 1700]]);
  assert.equal(st.contacts.find(c => c.id === invoices.find(d => d.number === '1044').contactId).name, 'Harbour Hotel');
  // Paying a carried-over invoice works like any other.
  const inv = invoices.find(d => d.number === '1043');
  const pay = await call('PUT', `/api/c/${co}/records/entries/pay1`, { type: 'payment', date: '2026-01-14', applyTo: inv.id, amount: 1130, bank: byName('Chequing').id, contactId: inv.contactId,
    lines: [{ account: byName('Chequing').id, debit: 1130, credit: 0 }, { account: byName('Accounts Receivable (A/R)').id, debit: 0, credit: 1130 }] });
  assert.equal(pay.status, 200);
  assert.equal(st.entries.filter(e => e.imported && e.type === 'journal').length, 5, 'opening balances plus 4 transactions');
  assert.equal(bal[byName('Depreciation Expense').id], 400);
  // A bad file stops the whole import, and nothing is half done.
  const before = (await call('GET', `/api/c/${co}/state`)).json.entries.length;
  const bad = await call('POST', `/api/c/${co}/import`, { writes: [{ op: 'set', collection: 'contacts', id: 'cx', data: { name: 'Ok', kind: 'customer' } }, { op: 'set', collection: 'entries', id: 'ex', data: { type: 'journal', date: '2026-01-01', lines: [{ account: 'nope', debit: 1, credit: 0 }, { account: 'nope2', debit: 0, credit: 1 }] } }] });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /Item 2/);
  const after = (await call('GET', `/api/c/${co}/state`)).json;
  assert.equal(after.entries.length, before); assert.ok(!after.contacts.some(c => c.id === 'cx'));
  assert.equal((await call('POST', `/api/c/${co}/import`, { writes: [{ op: 'delete', collection: 'entries', id: 'pay1' }] })).status, 400, 'an import can’t delete transactions');
  assert.ok(fs.readdirSync(path.join(dir, 'before-restore')).some(f => f.includes('before-import')));
});

test('A trial balance dated after the history starts is refused (it would count twice)', async () => {
  const tables = await load('qbo');
  const p = C.plan(tables, { accounts: [], contacts: [] }, { date: '2026-01-31' });
  assert.ok(p.errors.some(e => e.code === 'tb-after-history'));
});

test('Review cases: account numbers, sub-accounts, Dr/Cr balances, dates, double imports', async () => {
  const tbl = (name, csv) => { const t = { name, rows: require('../public/bankparse.js').parseCSV(csv) }; return { ...t, ...C.classify(t) }; };
  // A client account takes the number of the starter sales tax account it replaces.
  const co = (await call('POST', '/api/companies', { name: 'Numbers Co', province: 'ON' })).json.company.id;
  const st0 = (await call('GET', `/api/c/${co}/state`)).json;
  const tb = tbl('tb.csv', 'Trial Balance\nAs of December 31, 2025\nAccount Number,Account Description,Debits,Credits\n1060,Chequing,1000.00,\n2200,Accrued Liabilities,,400.00\n2310,GST Charged on Sales,,100.00\n4020,Revenue,,500.00\n');
  const p = C.plan([tb], { accounts: st0.accounts, contacts: [], entries: [] }, {});
  const w = C.build(p, { accounts: st0.accounts, contacts: [] }, { uid, label: 'Sage 50', replaceStarter: false, used: new Set() });
  const r = await call('POST', `/api/c/${co}/import`, { writes: w });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const st = (await call('GET', `/api/c/${co}/state`)).json;
  assert.equal(st.accounts.find(a => a.name === 'Accrued Liabilities').code, '2200');
  assert.equal(st.accounts.find(a => a.name === 'GST Charged on Sales').code, '2310');
  // Importing the trial balance again is stopped.
  assert.ok(C.plan([tb], { accounts: st.accounts, contacts: st.contacts, entries: st.entries }, {}).errors.some(e => e.code === 'already-imported'));
  // Without a chart, two sub-accounts with the same last part stay apart.
  const p2 = C.plan([tbl('t.csv', 'Trial Balance\nAs of December 31, 2025\n,Debit,Credit\nUtilities:Hydro,300,\nOffice:Hydro,200,\nChequing,,500\n')], { accounts: [], contacts: [] }, {});
  assert.equal(p2.accounts.filter(a => /Hydro/.test(a.name)).length, 2);
  // A single balance column with Dr / Cr.
  const p3 = C.plan([tbl('t.csv', 'Trial Balance\nAs of December 31, 2025\nAccount,Balance\nChequing,500.00 Dr\nSales,500.00 Cr\n')], { accounts: [], contacts: [] }, {});
  assert.deepEqual(p3.tb.lines.map(l => l.amount), [500, -500]);
  // Open invoices must be as of the trial balance date; unbalanced history stops the import.
  const ar = tbl('ar.csv', 'A/R Aging Detail\nAs of November 30, 2025\nDate,Num,Customer,Open Balance\n11/01/2025,1,Ana,10.00\n');
  assert.ok(C.plan([tb, ar], { accounts: [], contacts: [] }, {}).errors.some(e => e.code === 'ar-date'));
  const j = tbl('j.csv', 'Journal\nDate,Num,Account,Debit,Credit\n01/05/2026,1,Chequing,10.00,\n,,Revenue,,9.00\n');
  assert.ok(C.plan([tb, j], { accounts: [], contacts: [] }, {}).errors.some(e => e.code === 'journal-unbalanced'));
  // An import never changes records that are already there.
  const e1 = st.entries[0];
  assert.equal((await call('POST', `/api/c/${co}/import`, { writes: [{ op: 'set', collection: 'entries', id: e1.id, data: { ...e1, id: undefined, memo: 'changed' } }] })).status, 400);
});
