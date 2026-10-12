'use strict';
// Import data from a spreadsheet: column matching (English and French), dates, tax codes, grouping lines into
// invoices, bills and journal entries, the problems each row can have, and the import itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const I = require('../public/importer.js');
const BP = require('../public/bankparse.js');
const CV = require('../public/convert-parse.js');
const { createApp } = require('../src/server/app');

const ACCTS = [
  { id: 'a1000', code: '1000', name: 'Chequing', type: 'Asset', detail: 'bank' },
  { id: 'a1200', code: '1200', name: 'Accounts receivable', type: 'Asset', detail: 'ar' },
  { id: 'a1500', code: '1500', name: 'Equipment', type: 'Asset', detail: 'capital' },
  { id: 'a2000', code: '2000', name: 'Accounts payable', type: 'Liability', detail: 'ap' },
  { id: 'a2200', code: '2200', name: 'HST payable', type: 'Liability', detail: 'tax' },
  { id: 'a4000', code: '4000', name: 'Sales', type: 'Income' },
  { id: 'a4100', code: '4100', name: 'Consulting income', type: 'Income' },
  { id: 'a6000', code: '6000', name: 'Advertising', type: 'Expense' },
  { id: 'a6400', code: '6400', name: 'Office supplies', type: 'Expense' },
];
const CO = { taxName: 'HST', taxRate: 13, terms: 30 };
const csv = s => ({ rows: BP.parseCSV(s), header: 0 });
const run = (type, text, opts = {}, ex = {}) => {
  const t = csv(text);
  return I.check(type, t, I.guessMapping(type, t.rows[0]), { company: CO, ...opts, existing: { accounts: ACCTS, contacts: [], items: [], docs: [], entries: [], ...ex } });
};
const codes = r => r.problems.map(p => p.code);

test('columns are matched from English and French headings', () => {
  assert.deepEqual(I.guessMapping('customers', ['Nom', 'Courriel', 'Téléphone', 'Ville', 'Code postal']), { name: 0, email: 1, phone: 2, city: 3, postal: 4 });
  assert.deepEqual(I.guessMapping('customers', ['Customer', 'E-mail', 'Phone']), { name: 0, email: 1, phone: 2 });
  assert.deepEqual(I.guessMapping('invoices', ['No de facture', 'Client', 'Date', 'Description', 'Montant', 'Compte de revenus', 'Code de taxe']),
    { number: 0, contact: 1, date: 2, desc: 3, amount: 4, account: 5, taxCode: 6 });
  // QuickBooks Online's own import headings.
  assert.deepEqual(I.guessMapping('invoices', ['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount', 'ItemTaxCode']),
    { number: 0, contact: 1, date: 2, due: 3, desc: 4, qty: 5, rate: 6, amount: 7, taxCode: 8 });
  assert.deepEqual(I.guessMapping('journal', ['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name']),
    { number: 0, date: 1, account: 2, debit: 3, credit: 4, desc: 5, name: 6 });
  assert.deepEqual(I.guessMapping('journal', ['No d’écriture', 'Date', 'Compte', 'Débit', 'Crédit']), { number: 0, date: 1, account: 2, debit: 3, credit: 4 });
  assert.equal(I.guessMapping('bills', ['Vendor', 'Bill date', 'Montant']).amount, 2);
  assert.equal(I.guessMapping('customers', ['Name*', 'Email (main)']).email, 1, 'stars and notes in brackets are ignored');
  // Missing required columns.
  assert.deepEqual(I.missingFields('invoices', { contact: 0 }), ['date', 'amount']);
  assert.deepEqual(I.missingFields('journal', { date: 0, account: 1 }), ['debit']);
  // The heading row is found under a title.
  assert.equal(I.findHeader([['Customer list'], [''], ['Name', 'Email', 'Phone'], ['A', 'a@b.ca', '1']], 'customers'), 2);
});

test('templates read back with their own headings, in both languages', () => {
  for (const type of I.TYPES) for (const lang of ['en', 'fr']) {
    const rows = BP.parseCSV(I.template(type, lang));
    const map = I.guessMapping(type, rows[0]);
    assert.deepEqual(I.missingFields(type, map), [], `${type} ${lang}`);
    assert.ok(rows.length >= 3, `${type} has examples`);
  }
  assert.match(I.template('invoices', 'fr').split('\r\n')[0], /^No de facture,Client\*,Date de facture\*/);
});

test('dates: ISO, day/month, month/day (asked when unclear) and Excel serial numbers', () => {
  assert.equal(I.parseDate('2026-09-30'), '2026-09-30');
  assert.equal(I.parseDate('30/09/2026'), '2026-09-30');
  assert.equal(I.parseDate('09/30/2026'), '2026-09-30');
  assert.equal(I.parseDate('03/04/2026', 'dmy'), '2026-04-03');
  assert.equal(I.parseDate('03/04/2026', 'mdy'), '2026-03-04');
  assert.equal(I.parseDate('46295'), '2026-09-30', 'Excel serial');
  assert.equal(I.parseDate('Sep 30, 2026'), '2026-09-30');
  assert.equal(I.parseDate('31/31/2026'), null);
  assert.equal(I.parseDate('soon'), null);
  assert.equal(I.dateFormatOf(['30/09/2026', '01/10/2026']), 'dmy');
  assert.equal(I.dateFormatOf(['09/30/2026', '10/01/2026']), 'mdy');
  assert.equal(I.dateFormatOf(['03/04/2026', '05/06/2026']), 'ask');
  assert.equal(I.dateFormatOf(['2026-01-01']), 'auto');
  // In a file: unclear dates are a problem until the format is chosen.
  const text = 'Name,Date,Account,Debit,Credit\nX,03/04/2026,Chequing,10,\nX,03/04/2026,Sales,,10\n'.replace(/Name/, 'Journal no.');
  let r = run('journal', text);
  assert.equal(r.dateFormat, 'ask');
  assert.ok(r.rows.every(x => codes(x).includes('date-format')));
  r = run('journal', text, { dateFormat: 'dmy' });
  assert.equal(r.groups[0].date, '2026-04-03');
  assert.equal(r.counts.ok, 2);
  // A bad date is reported with its value.
  r = run('journal', 'Journal no.,Date,Account,Debit,Credit\nJ1,2026-02-30,Chequing,10,\nJ1,2026-02-30,Sales,,10\n');
  assert.deepEqual(r.rows[0].problems[0], { code: 'date', value: '2026-02-30' });
});

test('amounts and tax codes', () => {
  assert.equal(I.num('$1,234.56'), 1234.56);
  assert.equal(I.num('1 234,56'), 1234.56);
  assert.equal(I.num('(12.00)'), -12);
  assert.equal(I.num('12,5'), 12.5);
  assert.equal(I.num('abc'), null);
  const on = { taxName: 'HST', taxRate: 13 }, qc = { taxName: 'GST/QST', taxRate: 14.975, qstRate: 9.975 }, bc = { taxName: 'GST/PST', taxRate: 12, pstRate: 7 };
  const t = (s, c = on) => { const x = I.taxCode(s, c); return x.error || x.code; };
  assert.equal(t('HST'), 'std'); assert.equal(t('HST ON'), 'std'); assert.equal(t('13%'), 'std'); assert.equal(t('TVH'), 'std');
  assert.equal(t('Exempt'), 'exempt'); assert.equal(t('Exonéré'), 'exempt');
  assert.equal(t('Zero-rated'), 'zero'); assert.equal(t('Détaxé'), 'zero'); assert.equal(t('0%'), 'zero');
  assert.equal(t('Zero-rated export'), 'export');
  assert.equal(t('None'), 'none'); assert.equal(t('Out of scope'), 'none'); assert.equal(t('Aucune'), 'none');
  assert.equal(t(''), '');
  assert.equal(t('7%'), 'rate');
  assert.equal(t('Banana'), 'unknown');
  assert.equal(t('GST/QST', qc), 'std'); assert.equal(t('TPS/TVQ', qc), 'std'); assert.equal(t('QST', qc), 'std');
  assert.equal(t('GST', qc), 'gst', 'Quebec books charge both together');
  assert.equal(t('GST', bc), 'gst'); assert.equal(t('GST only', bc), 'gst'); assert.equal(t('PST', bc), 'std');
  assert.equal(t('GST', { taxName: 'GST', taxRate: 5 }), 'std');
});

test('customers and vendors: names, duplicates, email, default tax', () => {
  const r = run('customers', 'Name,Email,City,Province,Tax code\nMaple Dental,a@maple.ca,Ottawa,ON,\nmaple dental,,,,\n,x@y.ca,,,\nAcme US,bad-email,Buffalo,NY,Zero-rated export\nOld Client,,,,\n',
    {}, { contacts: [{ id: 'c1', name: 'Old Client', kind: 'customer' }, { id: 'v1', name: 'Acme US', kind: 'vendor' }] });
  assert.deepEqual(r.rows.map(x => x.status), ['ok', 'dup', 'error', 'error', 'dup']);
  assert.deepEqual(r.rows[1].problems[0], { code: 'dup', why: 'file', value: 'maple dental' });
  assert.deepEqual(codes(r.rows[2]), ['required']);
  assert.deepEqual(codes(r.rows[3]), ['email'], 'a vendor with the same name is fine');
  assert.equal(r.rows[4].problems[0].why, 'exists');
  assert.deepEqual(r.rows[0].record, { name: 'Maple Dental', kind: 'customer', email: 'a@maple.ca', phone: '', address: 'Ottawa, ON', notes: '', taxCode: '' });
  const v = run('vendors', 'Fournisseur,Courriel\nHydro Ottawa,\n');
  const { writes } = I.build(v, { uid: () => 'v9', now: 1 });
  assert.deepEqual(writes, [{ op: 'set', collection: 'contacts', id: 'v9', data: { name: 'Hydro Ottawa', kind: 'vendor', email: '', phone: '', address: '', notes: '', taxCode: '', created: 1 } }]);
});

test('products and services, and accounts', () => {
  const r = run('items', 'Name,Type,Sales price,Cost,Income account,Expense account,Tax code\nBookkeeping,Service,450,,Sales,,HST\nPaper,Product,12.99,8.50,4000,Office supplies,\nWidget,Inventory,1,,Sales,,\nNo accounts,Service,5,,,,\nWrong,Service,5,,Advertising,,\n');
  assert.deepEqual(r.rows.map(x => x.status), ['ok', 'ok', 'error', 'error', 'error']);
  assert.deepEqual(r.rows[1].record, { name: 'Paper', type: 'product', sku: '', desc: '', price: 12.99, cost: 8.5, incomeAccount: 'a4000', expenseAccount: 'a6400', taxCode: 'std', sold: true, bought: true, active: true });
  assert.deepEqual(codes(r.rows[2]), ['inventory']);
  assert.deepEqual(codes(r.rows[3]), ['item-acct']);
  assert.deepEqual(r.rows[4].problems[0], { code: 'account-kind', value: 'Advertising', need: 'income' });

  const a = run('accounts', 'Number,Name,Type,Detail type\n1010,Savings,Bank,\n6450,Software,Expense,\n1000,Petty cash,Bank,\n,Sales,Income,\n2100,Visa,Credit Card,\n1210,Accounts receivable - US,Accounts receivable (A/R),\n');
  assert.deepEqual(a.rows.map(x => x.status), ['ok', 'ok', 'error', 'dup', 'ok', 'ok']);
  assert.deepEqual([a.rows[0].record.type, a.rows[0].record.detail, a.rows[0].record.code], ['Asset', 'bank', '1010']);
  assert.deepEqual(codes(a.rows[2]), ['code-used']);
  assert.deepEqual([a.rows[4].record.type, a.rows[4].record.detail], ['Liability', 'card']);
  assert.deepEqual([a.rows[5].record.type, a.rows[5].record.detail], ['Asset', ''], 'the books already have an A/R account');
});

test('invoices: lines with the same number are one invoice, tax per line, problems hold back the whole invoice', () => {
  const text = [
    'Invoice no.,Customer,Invoice date,Due date,Description,Qty,Rate,Amount,Income account,Tax code',
    '1001,Maple Dental,2026-09-01,2026-10-01,Bookkeeping,1,450,450,Sales,HST',
    '1001,Maple Dental,2026-09-01,,Adjustments,2,75,150,4100,Exempt',
    '1002,Maple Dental,2026-09-02,,Consulting,3,,360,Consulting income,Zero-rated',
    '1003,Maple Dental,2026-09-03,,Good line,1,10,,Sales,HST',
    '1003,Maple Dental,2026-09-03,,Bad line,1,10,,Nowhere,HST',
    '1004,Nobody Inc,2026-09-04,,Thing,1,10,,Sales,',
    '1005,Maple Dental,2026-09-05,,Off,2,10,25,Sales,HST',
    '900,Maple Dental,2026-09-05,,Old,1,10,,Sales,HST',
    '1006,Other Co,2026-09-05,,Mixed,1,10,,Sales,HST',
    '1006,Maple Dental,2026-09-05,,Mixed,1,10,,Sales,HST',
  ].join('\n');
  const ex = { contacts: [{ id: 'c1', name: 'Maple Dental', kind: 'customer' }, { id: 'c2', name: 'Other Co', kind: 'customer' }], docs: [{ id: 'd0', kind: 'invoice', number: '900', contactId: 'c1' }] };
  const r = run('invoices', text, {}, ex);
  const g = n => r.groups.find(x => x.number === n);
  assert.equal(r.groups.length, 7);
  assert.deepEqual([g('1001').status, g('1001').lines.length, g('1001').due, g('1001').contactId], ['ok', 2, '2026-10-01', 'c1']);
  assert.deepEqual(g('1001').lines.map(l => [l.account, l.qty, l.rate, l.taxCode]), [['a4000', 1, 450, 'std'], ['a4100', 2, 75, 'exempt']]);
  assert.deepEqual(g('1002').lines[0], { qty: 3, rate: 120, desc: 'Consulting', account: 'a4100', taxCode: 'zero' });
  assert.equal(g('1002').due, '2026-10-02', 'no due date: the company’s terms');
  assert.equal(g('1003').status, 'error');
  assert.deepEqual(r.rows[3].problems, [{ code: 'group', kind: 'invoice' }]);
  assert.equal(r.rows[3].status, 'skip');
  assert.deepEqual(r.rows[4].problems, [{ code: 'account', value: 'Nowhere' }]);
  assert.deepEqual(r.rows[5].problems, [{ code: 'contact', value: 'Nobody Inc', kind: 'customer' }]);
  assert.deepEqual(codes(r.rows[6]), ['qty-rate']);
  assert.equal(g('900').status, 'dup');
  assert.deepEqual(r.rows[7].problems, [{ code: 'dup', why: 'exists', value: '900', kind: 'invoice' }]);
  assert.deepEqual(codes(r.rows[9]), ['group-contact']);
  assert.equal(r.counts.records, 2);
  // Adding new customers: Nobody Inc's invoice is then fine.
  const r2 = run('invoices', text, { addContacts: true }, ex);
  assert.equal(r2.groups.find(x => x.number === '1004').status, 'ok');
  assert.deepEqual(r2.newContacts, [{ name: 'Nobody Inc', kind: 'customer' }]);
  // Without a tax account, taxed lines can't be posted.
  const r3 = run('invoices', text, { taxMissing: 'HST' }, ex);
  assert.ok(codes(r3.rows[0]).includes('tax-acct'));
  assert.ok(!codes(r3.rows[2]).includes('tax-acct'), 'zero-rated lines need no tax account');
});

test('invoices: no number gets the next one; a customer’s default tax code and a product fill in the line', () => {
  const ex = { contacts: [{ id: 'c1', name: 'US Co', kind: 'customer', taxCode: 'export' }], docs: [{ id: 'd', kind: 'invoice', number: '1050' }],
    items: [{ id: 'i1', name: 'Bookkeeping', price: 450, incomeAccount: 'a4000', taxCode: 'std', sold: true }] };
  const r = run('invoices', 'Customer,Date,Product/service,Qty\nUS Co,2026-09-01,Bookkeeping,2\nUS Co,2026-09-01,Bookkeeping,1\nUS Co,2026-09-02,Bookkeeping,1\n', {}, ex);
  assert.deepEqual(r.groups.map(g => [g.number, g.lines.length]), [['1051', 2], ['1052', 1]], 'rows with no number join the one above with the same customer and date');
  assert.deepEqual(r.groups[0].lines[0], { item: 'i1', qty: 2, rate: 450, desc: 'Bookkeeping', account: 'a4000', taxCode: 'export' });
});

test('bills: grouped by number and vendor; the same number from two vendors is two bills', () => {
  const ex = { contacts: [{ id: 'v1', name: 'Hydro', kind: 'vendor' }, { id: 'v2', name: 'Rogers', kind: 'vendor' }], docs: [{ id: 'b0', kind: 'bill', number: 'X1', contactId: 'v2' }] };
  const r = run('bills', 'Bill no.,Vendor,Bill date,Description,Amount,Expense account,Tax code\nA1,Hydro,30/09/2026,Power,100,Office supplies,HST\nA1,Rogers,30/09/2026,Phone,50,Advertising,HST\nA1,Hydro,30/09/2026,Fee,5,6000,Exempt\nX1,Hydro,30/09/2026,Ok,5,6000,HST\nX1,Rogers,30/09/2026,Dup,5,6000,HST\nB2,Hydro,30/09/2026,Laptop,1500,Equipment,HST\nB3,Hydro,30/09/2026,Wrong,10,Sales,HST\n', {}, ex);
  assert.deepEqual(r.groups.map(g => [g.number, g.contactId, g.lines.length, g.status]),
    [['A1', 'v1', 2, 'ok'], ['A1', 'v2', 1, 'ok'], ['X1', 'v1', 1, 'ok'], ['X1', 'v2', 1, 'dup'], ['B2', 'v1', 1, 'ok'], ['B3', 'v1', 1, 'error']]);
  assert.equal(r.groups[0].date, '2026-09-30');
  assert.equal(r.groups[4].lines[0].account, 'a1500', 'capital assets can go on a bill');
  assert.deepEqual(r.rows[6].problems, [{ code: 'account-kind', value: 'Sales', need: 'expense' }]);
});

test('journal entries: grouped by number, must balance; French headings; duplicates by number', () => {
  const r = run('journal', [
    'No d’écriture,Date,Compte,Débit,Crédit,Description,Nom',
    'JE-1,2026-09-30,Advertising,100,,Ad,',
    'JE-1,2026-09-30,1000 Chequing,,100,,',
    'JE-2,2026-09-30,Advertising,100,,,',
    'JE-2,2026-09-30,Chequing,,90,,',
    'JE-3,2026-09-30,Advertising,10,10,,',
    'JE-3,2026-09-30,Chequing,,10,,',
    'OLD,2026-09-30,Advertising,1,,,',
    'OLD,2026-09-30,Chequing,,1,,',
    'JE-4,2026-09-30,Advertising,-25,,,Maple Dental',
    'JE-4,2026-09-30,Chequing,25,,,',
    'JE-5,2026-09-30,Advertising,5,,,',
  ].join('\n'), {}, { entries: [{ id: 'e', type: 'journal', ref: 'old', lines: [] }], contacts: [{ id: 'c1', name: 'Maple Dental', kind: 'customer' }] });
  const g = n => r.groups.find(x => x.number === n);
  assert.equal(g('JE-1').status, 'ok');
  assert.deepEqual(g('JE-1').lines, [{ account: 'a6000', debit: 100, credit: 0, memo: 'Ad' }, { account: 'a1000', debit: 0, credit: 100, memo: '' }]);
  assert.equal(g('JE-2').status, 'error');
  assert.deepEqual(r.rows[3].problems, [{ code: 'unbalanced', value: 'JE-2', diff: 10 }]);
  assert.equal(r.rows[2].status, 'skip');
  assert.deepEqual(codes(r.rows[4]), ['both']);
  assert.equal(g('OLD').status, 'dup');
  assert.deepEqual([g('JE-4').status, g('JE-4').contactId, g('JE-4').lines[0].credit], ['ok', 'c1', 25], 'a negative debit is a credit');
  assert.deepEqual(codes(r.rows[10]), ['one-sided']);
  const { writes } = I.build(r, { uid: () => 'j' + Math.random(), now: 5 });
  assert.equal(writes.length, 2);
  assert.deepEqual({ ...writes[0].data, created: 0 }, { type: 'journal', date: '2026-09-30', ref: 'JE-1', memo: '', contactId: '', lines: [{ account: 'a6000', debit: 100, credit: 0, memo: 'Ad' }, { account: 'a1000', debit: 0, credit: 100, memo: '' }], created: 0, adjusting: false, reverseOn: '' });
  // Rows with no number: one entry until it balances.
  const r2 = run('journal', 'Date,Account,Amount\n2026-01-01,Advertising,50\n2026-01-01,Chequing,-50\n2026-01-01,Office supplies,20\n2026-01-01,Chequing,-20\n');
  assert.deepEqual(r2.groups.map(x => [x.status, x.lines.length]), [['ok', 2], ['ok', 2]]);
});

test('closing date and filed periods are flagged so the import asks first', () => {
  const r = run('journal', 'Journal no.,Date,Account,Debit,Credit\nJ1,2025-12-31,Advertising,10,\nJ1,2025-12-31,HST payable,,10\nJ2,2026-06-30,Advertising,10,\nJ2,2026-06-30,Chequing,,10\n',
    { company: { ...CO, closingDate: '2025-12-31' }, filed: [{ from: '2025-10-01', to: '2025-12-31' }, { from: '2026-04-01', to: '2026-06-30' }], taxAccounts: ['a2200'] });
  assert.deepEqual(r.warnings, [{ code: 'closed', count: 1, date: '2025-12-31' }, { code: 'filed', count: 1 }], 'J2 has no tax, so its filed period isn’t affected');
});

test('Excel files: dates as serial numbers, headings in French', async () => {
  // A minimal .xlsx with a date-styled cell, written by hand.
  const crcT = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const zip = files => { const parts = [], cen = []; let off = 0;
    for (const [name, content] of Object.entries(files)) { const raw = Buffer.from(content), d = zlib.deflateRawSync(raw), nb = Buffer.from(name);
      const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc(raw), 14); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc(raw), 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
      parts.push(h, nb, d); cen.push(c, nb); off += 30 + nb.length + d.length; }
    const cd = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(cen.length / 2, 8); e.writeUInt16LE(cen.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, e]); };
  const str = ['No d’écriture', 'Date', 'Compte', 'Débit', 'Crédit', 'J1', 'Advertising', 'Chequing'];
  const s = i => `<c t="s"><v>${i}</v></c>`, n = (v, st) => `<c${st ? ' s="1"' : ''}><v>${v}</v></c>`;
  const sheet = `<worksheet><sheetData><row>${[0, 1, 2, 3, 4].map(s).join('')}</row><row>${s(5)}${n(46295, 1)}${s(6)}${n(100)}<c/></row><row>${s(5)}${n(46295, 1)}${s(7)}<c/>${n(100)}</row></sheetData></worksheet>`;
  const buf = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>', 'xl/sharedStrings.xml': `<sst>${str.map(x => `<si><t>${x}</t></si>`).join('')}</sst>`, 'xl/worksheets/sheet1.xml': sheet });
  const [t] = await CV.readFile('je.xlsx', buf, async b => new Uint8Array(zlib.inflateRawSync(b)));
  const header = I.findHeader(t.rows, 'journal');
  const r = I.check('journal', { rows: t.rows, header }, I.guessMapping('journal', t.rows[header]), { existing: { accounts: ACCTS } });
  assert.deepEqual(r.groups.map(g => [g.number, g.date, g.status]), [['J1', '2026-09-30', 'ok']]);
  // A serial number left as a plain number (no date style) is still read as a date.
  assert.equal(I.parseDate('46295.0'), '2026-09-30');
});

test('rows not imported come back as a CSV with the problem', () => {
  const t = csv('Name,Email\nGood,\nBad,nope\n');
  const r = I.check('customers', t, I.guessMapping('customers', t.rows[0]), { existing: {} });
  assert.equal(I.leftoverCsv(t, r, p => p.code), 'Name,Email,Problem\r\nBad,nope,email\r\n');
});

/* ---------- the import itself, through the API ---------- */
// The invoice form's own posting code (app.js), so an imported invoice is saved exactly like one made in the form.
function formCode(state) {
  const el = () => new Proxy(function () {}, { get: (t, k) => k === 'querySelectorAll' ? () => [] : k === 'addEventListener' ? () => {} : k === Symbol.toPrimitive ? () => '' : el(), set: () => true, apply: () => el() });
  const ctx = { document: { querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, documentElement: { setAttribute() {} }, createElement: () => el(), body: el() },
    navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} }, location: {}, MutationObserver: class { observe() {} }, Document: class {}, NodeFilter: {}, console,
    requestAnimationFrame: () => 0, setTimeout, clearTimeout, Intl, fetch: () => Promise.reject(new Error('offline')) };
  ctx.window = ctx; vm.createContext(ctx);
  const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext(pub('i18n.js') + ';' + pub('app.js') + ';this.S=S;this.H={calcLines,docPostLines,docRecord};', ctx);
  Object.assign(ctx.S, state);
  return ctx.H;
}

let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-importer-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Import Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const state = async () => (await call('GET', '/api/c/state')).json;

test('API: an imported invoice posts the same balanced entry as one made in the form', async () => {
  let st = await state();
  const H = formCode({ accounts: st.accounts, company: st.company, items: [], docs: [] });
  const text = 'Invoice no.,Customer,Invoice date,Description,Qty,Rate,Income account,Tax code\n2001,New Client,2026-09-01,Work,2,100,Sales,HST\n2001,New Client,2026-09-01,Extra,1,50,Sales,Exempt\n';
  const t = csv(text), map = I.guessMapping('invoices', t.rows[0]);
  const opts = { addContacts: true, company: st.company, existing: { accounts: st.accounts, contacts: st.contacts, items: st.items, docs: st.docs, entries: st.entries } };
  const res = I.check('invoices', t, map, opts);
  assert.equal(res.counts.records, 1, JSON.stringify(res.rows.map(r => r.problems)));
  const ar = st.accounts.find(a => a.detail === 'ar'), sales = st.accounts.find(a => a.name === 'Sales' || a.code === '4000');
  let n = 0;
  const { writes, counts } = I.build(res, { uid: () => 'imp' + (++n), now: 1000, ...H, arId: ar.id });
  assert.deepEqual(counts, { contacts: 1, docs: 1, entries: 1 });
  const r = await call('POST', '/api/c/import', { writes, source: 'a spreadsheet', addOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  const doc = st.docs.find(d => d.number === '2001'), entry = st.entries.find(e => e.docId === doc.id);
  assert.equal(st.contacts.find(c => c.id === doc.contactId).name, 'New Client');
  assert.deepEqual([doc.sub, doc.tax, doc.total], [250, 26, 276]);
  const dr = entry.lines.reduce((s, l) => s + l.debit, 0), cr = entry.lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(Math.round(dr * 100), Math.round(cr * 100), 'balanced');
  // The form, given the same lines, makes the same posting.
  const c = H.calcLines([{ desc: 'Work', account: sales.id, qty: 2, rate: 100, taxCode: 'std' }, { desc: 'Extra', account: sales.id, qty: 1, rate: 50, taxCode: 'exempt' }], x => x.qty * x.rate, false);
  assert.deepEqual(entry.lines, JSON.parse(JSON.stringify(H.docPostLines('invoice', c, ar.id))));
  assert.deepEqual(entry.lines.map(l => [l.account, l.debit, l.credit, l.taxCode || '']), [[ar.id, 276, 0, ''], [sales.id, 0, 200, 'std'], [sales.id, 0, 50, 'exempt'], [st.accounts.find(a => a.detail === 'tax').id, 0, 26, '']]);
  assert.deepEqual(doc.lines.map(l => [l.desc, l.qty, l.rate, l.taxCode, l.tax]), [['Work', 2, 100, 'std', true], ['Extra', 1, 50, 'exempt', false]]);
  assert.equal(doc.due, '2026-10-01');

  // Importing the same file again: the invoice is a duplicate and nothing is written.
  const again = I.check('invoices', t, map, { ...opts, existing: { accounts: st.accounts, contacts: st.contacts, items: st.items, docs: st.docs, entries: st.entries } });
  assert.deepEqual([again.counts.records, again.groups[0].status], [0, 'dup']);
  assert.equal(again.newContacts.length, 0, 'the customer is there now');
});

test('API: an add-only import never changes or deletes what’s there, and respects the closing date', async () => {
  let st = await state();
  const acct = st.accounts[0];
  let r = await call('POST', '/api/c/import', { writes: [{ op: 'set', collection: 'accounts', id: acct.id, data: { ...acct, name: 'Renamed' } }], addOnly: true });
  assert.equal(r.status, 400, 'an existing account isn’t changed');
  r = await call('POST', '/api/c/import', { writes: [{ op: 'delete', collection: 'contacts', id: st.contacts[0].id }], addOnly: true });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/c/import', { writes: [{ op: 'set', collection: 'employees', id: 'e1', data: { name: 'X' } }], addOnly: true });
  assert.equal(r.status, 400, 'only the import’s own kinds of records');
  r = await call('POST', '/api/c/import', { writes: [{ op: 'set', collection: 'items', id: 'it1', data: { name: 'Thing', type: 'service', incomeAccount: 'a4000', sold: true } }, { op: 'set', collection: 'items', id: 'it1', data: { name: 'Thing 2', type: 'service', incomeAccount: 'a4000', sold: true } }], addOnly: true });
  assert.equal(r.status, 400, 'the same id twice');
  r = await call('POST', '/api/c/import', { writes: [{ op: 'set', collection: 'items', id: 'it1', data: { name: 'Thing', type: 'service', incomeAccount: 'a4000', sold: true } }], addOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await state()).items.find(i => i.id === 'it1').name, 'Thing');
  // Closed books: refused with the date, so the app can offer to unlock them.
  assert.equal((await call('PUT', '/api/c/closing', { date: '2026-06-30' })).status, 200);
  const j = { type: 'journal', date: '2026-06-01', ref: 'JE-9', memo: '', lines: [{ account: 'a6000', debit: 5, credit: 0 }, { account: 'a1000', debit: 0, credit: 5 }] };
  r = await call('POST', '/api/c/import', { writes: [{ op: 'set', collection: 'entries', id: 'je9', data: j }], addOnly: true });
  assert.equal(r.status, 423);
  assert.equal(r.json.closedThrough, '2026-06-30');
  assert.ok(!(await state()).entries.some(e => e.id === 'je9'), 'nothing was added');
  r = await call('POST', '/api/c/import', { writes: [{ op: 'set', collection: 'entries', id: 'je9', data: { ...j, date: '2026-07-01' } }], addOnly: true });
  assert.equal(r.status, 200);
});

/* ---------- sales receipts, credit notes, vendor credits, inventory items, tags and classes ---------- */
const CO2 = { ...CO, tags: [{ id: 't1', name: 'Trade show', group: '' }, { id: 't2', name: 'Spring fair', group: 'g1' }], tagGroups: [{ id: 'g1', name: 'Event' }],
  classes: [{ id: 'k1', name: 'Ottawa', active: true }, { id: 'k2', name: 'Toronto', active: true }] };

test('QuickBooks and French headings for the new kinds', () => {
  assert.deepEqual(I.guessMapping('sreceipts', ['SalesReceiptNo', 'Customer', 'SalesReceiptDate', 'DepositToAccountName', 'ItemDescription', 'ItemAmount', 'ItemTaxCode', 'Class', 'Tags']),
    { number: 0, contact: 1, date: 2, bank: 3, desc: 4, amount: 5, taxCode: 6, cls: 7, tags: 8 });
  assert.deepEqual(I.guessMapping('credits', ['CreditMemoNo', 'Customer', 'CreditMemoDate', 'ItemAmount']), { number: 0, contact: 1, date: 2, amount: 3 });
  assert.deepEqual(I.guessMapping('vcredits', ['No de crédit', 'Fournisseur', 'Date', 'Montant', 'Compte de dépenses', 'Catégorie analytique', 'Étiquettes']),
    { number: 0, contact: 1, date: 2, amount: 3, account: 4, cls: 5, tags: 6 });
  assert.deepEqual(I.guessMapping('inventory', ['Product/Service Name', 'SKU', 'Sales Price / Rate', 'Purchase Cost', 'Quantity On Hand', 'Quantity as-of Date', 'Inventory Asset Account', 'Reorder Point']),
    { name: 0, sku: 1, price: 2, cost: 3, qty: 4, asOf: 5, assetAccount: 6, reorder: 7 });
  assert.deepEqual(I.guessMapping('inventory', ['Nom', 'Quantité en main', 'Valeur totale', 'Au', 'Compte d’actif de stock']), { name: 0, qty: 1, value: 2, asOf: 3, assetAccount: 4 });
  assert.deepEqual(I.missingFields('credits', { contact: 0, date: 1 }), ['amount']);
});

test('sales receipts: paid into a bank account; numbers follow SR-; tags and line classes', () => {
  const accts = [...ACCTS, { id: 'a1010', code: '1010', name: 'Savings', type: 'Asset', detail: 'bank' }];
  const text = 'Sales receipt no.,Customer,Date,Deposit to,Description,Amount,Income account,Tax code,Class,Tags\n'
    + ',Walk-in,2026-09-02,Savings,Paper,20,Sales,HST,Ottawa,"Trade show; Event: Spring fair"\n'
    + ',Walk-in,2026-09-02,,Toner,30,Sales,HST,Toronto,\n'
    + 'SR-7,Walk-in,2026-09-03,,Pens,5,Sales,HST,,\n'
    + 'SR-8,Walk-in,2026-09-03,Advertising,Pens,5,Sales,HST,,\n';
  const ex = { accounts: accts, contacts: [{ id: 'c1', name: 'Walk-in', kind: 'customer' }], docs: [{ id: 'x', kind: 'sreceipt', number: 'SR-1004' }] };
  const r = run('sreceipts', text, { company: CO2 }, ex);
  assert.deepEqual(r.groups.map(g => [g.number, g.status, g.bank || '']), [['SR-1005', 'ok', 'a1010'], ['SR-7', 'ok', 'a1000'], ['SR-8', 'error', 'a1000']]);
  assert.deepEqual(r.groups[0].tags, ['t1', 't2'], 'a tag by its name, or Group: Name');
  assert.deepEqual(r.groups[0].lines.map(l => l.cls), ['k1', 'k2']);
  assert.equal(r.groups[1].lines[0].cls, undefined, 'no class in the file: no line class');
  assert.deepEqual(codes(r.rows[3]), ['bank']);
  let n = 0;
  const H = { uid: () => 'u' + (++n), now: 1, calcLines: ls => ({ ls }), docRecord: c => ({ lines: c.ls }), docPostLines: (k, c, ctl) => [{ ctl, k }] };
  const { writes } = I.build(r, H);
  const doc = writes.find(w => w.collection === 'docs'), ent = writes.find(w => w.collection === 'entries');
  assert.deepEqual([doc.data.kind, doc.data.depositTo, doc.data.tags, ent.data.type, ent.data.tags, ent.data.lines[0].ctl], ['sreceipt', 'a1010', ['t1', 't2'], 'salesreceipt', ['t1', 't2'], 'a1010']);
});

test('credit notes and vendor credits group like invoices and bills; numbers CN-; no due date', () => {
  const ex = { contacts: [{ id: 'c1', name: 'Maple', kind: 'customer' }, { id: 'v1', name: 'Rogers', kind: 'vendor' }], docs: [{ id: 'cn', kind: 'credit', number: 'CN-1010' }, { id: 'vc', kind: 'vcredit', number: 'R1', contactId: 'v1' }] };
  const r = run('credits', 'Customer,Date,Description,Amount,Income account,Tax code\nMaple,2026-09-01,Refund,40,Sales,HST\nMaple,2026-09-01,More,10,Sales,HST\n', {}, ex);
  assert.deepEqual(r.groups.map(g => [g.number, g.lines.length, g.due, g.status]), [['CN-1011', 2, '', 'ok']]);
  const v = run('vcredits', 'Credit no.,Vendor,Date,Description,Amount,Expense account,Tax code\nR1,Rogers,2026-09-01,Dup,5,Advertising,HST\nR2,Rogers,2026-09-01,Outage,20,Advertising,HST\n', {}, ex);
  assert.deepEqual(v.groups.map(g => [g.number, g.status]), [['R1', 'dup'], ['R2', 'ok']]);
  assert.deepEqual(v.rows[0].problems, [{ code: 'dup', why: 'exists', value: 'R1', kind: 'vcredit' }]);
});

test('unknown tags and classes are problems unless “add new” is ticked; then they’re added with the import', () => {
  const text = 'Journal no.,Date,Account,Debit,Credit,Class,Tags\nJ1,2026-09-30,Advertising,10,,Montreal,"Trade show, Gala"\nJ1,2026-09-30,Chequing,,10,,\n';
  let r = run('journal', text, { company: CO2 });
  assert.deepEqual(r.rows[0].problems, [{ code: 'tag', value: 'Gala' }, { code: 'class', value: 'Montreal' }]);
  assert.deepEqual([r.groups[0].status, r.unknownTags, r.unknownClasses], ['error', 1, 1]);
  r = run('journal', text, { company: CO2, addTags: true });
  assert.deepEqual(codes(r.rows[0]), ['class'], 'tags added, the class still unknown');
  r = run('journal', text, { company: CO2, addTags: true, addClasses: true });
  assert.equal(r.groups[0].status, 'ok');
  assert.deepEqual([r.newTags, r.newClasses], [['Gala'], ['Montreal']]);
  let n = 0;
  const nl = I.newLists(r, CO2, () => 'n' + (++n));
  assert.deepEqual(nl.added, { tags: 1, classes: 1 });
  assert.deepEqual(nl.tags.at(-1), { id: 'n1', name: 'Gala', group: '' });
  assert.deepEqual(nl.classes.at(-1), { id: 'n2', name: 'Montreal', active: true });
  assert.throws(() => I.build(r, { uid: () => 'x', now: 1 }), /Add the new tags/);
  const { writes } = I.build(r, { uid: () => 'e' + (++n), now: 1, tagIds: nl.tagIds, classIds: nl.classIds });
  assert.deepEqual(writes[0].data.tags, ['t1', 'n1']);
  assert.deepEqual(writes[0].data.lines.map(l => l.cls), ['n2', ''], 'one line with a class: the other is “no class”');
  // A new tag written as Group: Name goes in that group.
  const r2 = run('journal', 'Date,Account,Amount,Tags\n2026-01-01,Advertising,5,Event: Gala\n2026-01-01,Chequing,-5,\n', { company: CO2, addTags: true });
  assert.deepEqual(I.newLists(r2, CO2, () => 'z').tags.at(-1), { id: 'z', name: 'Gala', group: 'g1' });
  // More than 20 tags on one entry.
  const many = Array.from({ length: 21 }, (_, i) => 'T' + i).join(';');
  const r3 = run('journal', `Date,Account,Amount,Tags\n2026-01-01,Advertising,5,"${many}"\n2026-01-01,Chequing,-5,\n`, { company: CO2, addTags: true });
  assert.ok(codes(r3.rows[0]).includes('tags-many'));
});

test('inventory items: quantity on hand, value and date; accounts found or the usual ones', () => {
  const accts = [...ACCTS, { id: 'a1400', code: '1400', name: 'Inventory', type: 'Asset' }, { id: 'a5000', code: '5000', name: 'Cost of goods sold', type: 'Cost of Goods Sold' }];
  const text = 'Name,SKU,Sales price,Cost,Quantity on hand,Total value,As of,Inventory asset account,Reorder point\n'
    + 'Paper,P1,12.99,8.50,40,,2026-09-30,,10\n'
    + 'Toner,T1,89,52,6,300,30/09/2026,Inventory,\n'
    + 'Pens,,2,1,5,,,,\n'
    + 'Bad,,2,1,-1,,2026-09-30,Chequing,\n'
    + 'Widget,,1,,,,,,\n';
  const r = run('inventory', text, {}, { accounts: accts, items: [{ id: 'i0', name: 'Widget' }] });
  assert.deepEqual(r.rows.map(x => x.status), ['ok', 'ok', 'error', 'error', 'dup']);
  assert.deepEqual(r.rows[0].record, { name: 'Paper', type: 'inventory', sku: 'P1', desc: '', price: 12.99, cost: 8.5, incomeAccount: 'a4000', assetAccount: 'a1400', cogsAccount: 'a5000', expenseAccount: 'a1400',
    qtyStart: 40, valueStart: 340, startDate: '2026-09-30', reorder: 10, taxCode: 'std', sold: true, bought: true, active: true }, 'no value: quantity × cost');
  assert.deepEqual([r.rows[1].record.valueStart, r.rows[1].record.startDate], [300, '2026-09-30']);
  assert.deepEqual(r.rows[2].problems, [{ code: 'required', field: 'asOf' }]);
  assert.deepEqual(codes(r.rows[3]), ['account-kind', 'negative']);
  // No inventory account in the books: say so.
  assert.deepEqual(codes(run('inventory', 'Name\nX\n').rows[0]), ['inv-acct', 'inv-acct']);
  // The plain products import still points inventory rows here.
  assert.deepEqual(codes(run('items', 'Name,Type,Income account\nW,Inventory,Sales\n').rows[0]), ['inventory']);
});

test('API: an imported inventory item starts with its stock; sales receipts, credits and tags import through the server', async () => {
  let st = await state();
  const r0 = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'accounts', id: 'a1400', data: { code: '1400', name: 'Inventory', type: 'Asset', active: true } }] });
  assert.equal(r0.status, 200, JSON.stringify(r0.json));
  assert.equal((await call('PUT', '/api/c/settings', { ...st.company, tags: [{ id: 'tg1', name: 'Trade show', group: '' }], classes: [{ id: 'cl1', name: 'Ottawa', active: true }] })).status, 200);
  st = await state();
  const ex = () => ({ accounts: st.accounts, contacts: st.contacts, items: st.items, docs: st.docs, entries: st.entries });
  // Inventory
  let t = csv('Name,Cost,Quantity on hand,As of\nGadget,4,10,2026-09-30\n');
  let res = I.check('inventory', t, I.guessMapping('inventory', t.rows[0]), { company: st.company, existing: ex() });
  let out = I.build(res, { uid: () => 'inv1', now: 1 });
  let r = await call('POST', '/api/c/import', { writes: out.writes, addOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  const it = st.items.find(i => i.id === 'inv1');
  assert.deepEqual([it.type, it.qtyStart, it.valueStart, it.startDate, it.assetAccount, it.cogsAccount], ['inventory', 10, 40, '2026-09-30', 'a1400', st.accounts.find(a => a.type === 'Cost of Goods Sold').id]);
  // Sales receipt with a tag and a class on the line, the form's own posting.
  const H = formCode({ accounts: st.accounts, company: st.company, items: st.items, docs: st.docs });
  t = csv('Sales receipt no.,Customer,Date,Description,Amount,Income account,Tax code,Class,Tags\nSR-50,Walk-in,2026-09-02,Paper,100,Sales,HST,Ottawa,Trade show\n');
  res = I.check('sreceipts', t, I.guessMapping('sreceipts', t.rows[0]), { addContacts: true, company: st.company, existing: ex() });
  assert.equal(res.counts.records, 1, JSON.stringify(res.rows.map(x => x.problems)));
  let n = 0;
  out = I.build(res, { uid: () => 'sr' + (++n), now: 2, ...H });
  r = await call('POST', '/api/c/import', { writes: out.writes, addOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  const sr = st.docs.find(d => d.number === 'SR-50'), se = st.entries.find(e => e.docId === sr.id);
  const bank = st.accounts.find(a => a.detail === 'bank' && a.code === '1000');
  assert.deepEqual([sr.kind, sr.depositTo, sr.tags, se.type, se.tags, sr.total], ['sreceipt', bank.id, ['tg1'], 'salesreceipt', ['tg1'], 113]);
  assert.deepEqual(se.lines.map(l => [l.account, l.debit, l.credit, l.cls]), [[bank.id, 113, 0, undefined], [st.accounts.find(a => a.code === '4000').id, 0, 100, 'cl1'], [st.accounts.find(a => a.detail === 'tax').id, 0, 13, undefined]]);
  // Credit note: open, available for the customer.
  t = csv('Customer,Date,Description,Amount,Income account,Tax code\nWalk-in,2026-09-03,Return,10,Sales,HST\n');
  res = I.check('credits', t, I.guessMapping('credits', t.rows[0]), { company: st.company, existing: ex() });
  out = I.build(res, { uid: () => 'cn' + (++n), now: 3, ...H, arId: st.accounts.find(a => a.detail === 'ar').id });
  r = await call('POST', '/api/c/import', { writes: out.writes, addOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  const cn = st.docs.find(d => d.kind === 'credit');
  assert.deepEqual([cn.number, cn.total, cn.applied], ['CN-1001', 11.3, []]);
  const ce = st.entries.find(e => e.docId === cn.id);
  assert.deepEqual(ce.lines.at(-1), { account: st.accounts.find(a => a.detail === 'ar').id, debit: 0, credit: 11.3 }, 'A/R is credited');
  // An unknown tag id is refused by the server.
  r = await call('POST', '/api/c/import', { writes: [{ op: 'set', collection: 'entries', id: 'jx', data: { type: 'journal', date: '2026-09-30', ref: '', memo: '', tags: ['nope'], lines: [{ account: 'a6000', debit: 1, credit: 0 }, { account: 'a1000', debit: 0, credit: 1 }] } }], addOnly: true });
  assert.equal(r.status, 400);
});
