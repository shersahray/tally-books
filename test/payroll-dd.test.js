'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DD = require('../public/payroll-dd.js');

const setup = { originatorId: 'ABC1234567', dataCentre: '00330', shortName: 'Maple Café', longName: 'Maple Café Inc.',
  returnInst: '003', returnTransit: '00102', returnAccount: '1234567' };
const payments = [
  { name: 'Hélène Tremblay', inst: '004', transit: '12345', account: '9876543', amount: 1523.47, ref: 'PAY 2026-10-15' },
  { name: 'Sam Lee', inst: '001', transit: '00011', account: '123456789012', amount: 980, ref: 'PAY 2026-10-15' },
];
const make = (extra = {}) => DD.cpa005({ setup, fileNo: 7, created: '2026-10-13', payDate: '2026-10-15', payments, ...extra });

test('Julian dates are 0YYDDD', () => {
  assert.equal(DD.julian('2026-01-01'), '026001');
  assert.equal(DD.julian('2026-10-15'), '026288');
  assert.equal(DD.julian('2028-12-31'), '028366', 'leap year');
});

test('Every record is 1464 bytes, ends with CR LF, and the counts run A, C…, Z', () => {
  const { text, count, total } = make();
  assert.equal(count, 2);
  assert.equal(total, 2503.47);
  assert.ok(text.endsWith('\r\n'));
  const recs = text.split('\r\n').filter(Boolean);
  assert.deepEqual(recs.map(r => r.length), [1464, 1464, 1464, 1464]);
  assert.deepEqual(recs.map(r => r[0]), ['A', 'C', 'C', 'Z']);
  assert.deepEqual(recs.map(r => r.slice(1, 10)), ['000000001', '000000002', '000000003', '000000004']);
  for (const r of recs) assert.equal(r.slice(10, 24), 'ABC12345670007', 'originator ID and file number on every record');
  assert.ok(/^[\x20-\x7e]+$/.test(recs.join('')), 'plain ASCII only');
});

test('Header: creation date, data centre, currency', () => {
  const a = make().text.split('\r\n')[0];
  assert.equal(a.slice(24, 30), '026286');
  assert.equal(a.slice(30, 35), '00330');
  assert.equal(a.slice(35, 55), ' '.repeat(20));
  assert.equal(a.slice(55, 58), 'CAD');
  assert.equal(a.slice(58).trim(), '');
});

test('Credit segment: every field in its position', () => {
  const c = make().text.split('\r\n')[1];
  const s = c.slice(24, 24 + 240);
  assert.equal(s.slice(0, 3), '200', 'payroll deposit');
  assert.equal(s.slice(3, 13), '0000152347', 'amount in cents');
  assert.equal(s.slice(13, 19), '026288', 'date funds are available');
  assert.equal(s.slice(19, 28), '000412345', 'institution and transit');
  assert.equal(s.slice(28, 40), '9876543     ', 'account, left-justified');
  assert.equal(s.slice(40, 65), '0'.repeat(25), 'item trace and stored transaction type');
  assert.equal(s.slice(65, 80), 'MAPLE CAFE     ', 'short name, accents removed');
  assert.equal(s.slice(80, 110), 'HELENE TREMBLAY'.padEnd(30));
  assert.equal(s.slice(110, 140), 'MAPLE CAFE INC.'.padEnd(30));
  assert.equal(s.slice(140, 150), 'ABC1234567');
  assert.equal(s.slice(150, 169), 'PAY 2026-10-15'.padEnd(19));
  assert.equal(s.slice(169, 178), '000300102', 'return institution and transit');
  assert.equal(s.slice(178, 190), '1234567     ');
  assert.equal(s.slice(190, 229), ' '.repeat(39), 'sundry, stored trace, settlement code');
  assert.equal(s.slice(229, 240), '0'.repeat(11), 'invalid data element ID');
  assert.equal(c.slice(264).trim(), '', 'the other five segments are blank');
});

test('Trailer totals the credits', () => {
  const z = make().text.split('\r\n')[3];
  assert.equal(z.slice(24, 38), '0'.repeat(14));
  assert.equal(z.slice(38, 46), '0'.repeat(8));
  assert.equal(z.slice(46, 60), '00000000250347');
  assert.equal(z.slice(60, 68), '00000002');
  assert.equal(z.slice(68, 112), '0'.repeat(44));
});

test('Reading a file back gives the same payments', () => {
  const p = DD.parse(make().text);
  assert.equal(p.header.fileNo, 7);
  assert.equal(p.payments.length, 2);
  assert.deepEqual(p.payments.map(x => [x.name, x.inst, x.transit, x.account, x.amount]),
    [['HELENE TREMBLAY', '004', '12345', '9876543', 1523.47], ['SAM LEE', '001', '00011', '123456789012', 980]]);
  assert.equal(p.trailer.creditValue, 2503.47);
  assert.equal(p.trailer.creditCount, 2);
});

test('Amounts are exact in cents (no floating-point drift)', () => {
  const r = DD.cpa005({ setup, fileNo: 1, created: '2026-10-13', payDate: '2026-10-15',
    payments: [{ name: 'A', inst: '001', transit: '00011', account: '1234567', amount: 0.1 + 0.2 }, { name: 'B', inst: '001', transit: '00011', account: '1234567', amount: 1005.005 }] });
  const p = DD.parse(r.text);
  assert.deepEqual(p.payments.map(x => x.amount), [0.3, 1005.01]);
  assert.equal(p.trailer.creditValue, 1005.31);
});

test('Refuses incomplete setup, bad bank accounts, zero deposits and bad file numbers', () => {
  assert.deepEqual(DD.setupProblems({}), ['originatorId', 'dataCentre', 'shortName', 'longName', 'returnAccount']);
  assert.deepEqual(DD.setupProblems(setup), []);
  assert.throws(() => make({ setup: { ...setup, originatorId: 'SHORT' } }), e => e.code === 'SETUP');
  assert.throws(() => make({ payments: [{ ...payments[0], transit: '123' }] }), e => e.code === 'BANK' && e.why === 'transit');
  assert.throws(() => make({ payments: [{ ...payments[0], inst: '' , transit: '', account: '' }] }), e => e.why === 'missing');
  assert.throws(() => make({ payments: [{ ...payments[0], amount: 0 }] }), /more than \$0/);
  assert.throws(() => make({ fileNo: 10000 }), /1 to 9999/);
  assert.throws(() => make({ payments: [] }), /no direct deposits/);
});

test('Bank account checks and masking', () => {
  assert.equal(DD.bankProblem({ inst: '003', transit: '12345', account: '1234567' }), '');
  assert.equal(DD.bankProblem({ inst: '3', transit: '12345', account: '1234567' }), 'inst');
  assert.equal(DD.bankProblem({ inst: '003', transit: '12345', account: '1234567890123' }), 'account');
  assert.equal(DD.bankProblem({ inst: '003', transit: '12-345', account: '123-4567' }), '', 'dashes and spaces are ignored');
  assert.equal(DD.mask('1234567'), '••••567');
  assert.equal(DD.mask(''), '');
});
