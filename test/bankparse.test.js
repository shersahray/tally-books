'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/bankparse');

const run = (csv) => {
  const rows = P.parseCSV(csv);
  const map = P.guessMapping(rows);
  return { map, ...P.applyMapping(rows, map) };
};

test('dates in common formats', () => {
  assert.equal(P.parseDate('2026-09-15'), '2026-09-15');
  assert.equal(P.parseDate('09/15/2026'), '2026-09-15');
  assert.equal(P.parseDate('15/09/2026'), '2026-09-15');
  assert.equal(P.parseDate('03/04/2026', 'dmy'), '2026-04-03');
  assert.equal(P.parseDate('20260915'), '2026-09-15');
  assert.equal(P.parseDate('20260915120000[-5:EST]'), '2026-09-15');
  assert.equal(P.parseDate('15-Sep-2026'), '2026-09-15');
  assert.equal(P.parseDate('Sep 15, 2026'), '2026-09-15');
  assert.equal(P.parseDate('02/30/2026'), null);
  assert.equal(P.parseDate('Description'), null);
  assert.equal(P.detectDateFormat(['01/02/2026', '25/02/2026']), 'dmy');
  assert.equal(P.detectDateFormat(['01/02/2026', '02/25/2026']), 'mdy');
});

test('amounts in common formats', () => {
  assert.equal(P.parseAmount('$1,234.56'), 1234.56);
  assert.equal(P.parseAmount('(12.50)'), -12.5);
  assert.equal(P.parseAmount('-12.50'), -12.5);
  assert.equal(P.parseAmount('12.50-'), -12.5);
  assert.equal(P.parseAmount('-$45.00'), -45);
  assert.equal(P.parseAmount('12,50'), 12.5);
  assert.equal(P.parseAmount('1.234,56'), 1234.56);
  assert.equal(P.parseAmount(''), null);
  assert.equal(P.parseAmount('abc'), null);
});

test('headerless debit/credit export (TD style)', () => {
  const r = run([
    '09/02/2026,TIM HORTONS #1234,4.75,,5210.25',
    '09/03/2026,PAYROLL DEPOSIT,,2500.00,7710.25',
    '09/05/2026,"ROGERS ******1234",95.00,,7615.25',
  ].join('\n'));
  assert.deepEqual(r.map.cols, ['date', 'desc', 'out', 'in', '']);
  assert.equal(r.map.header, false);
  assert.deepEqual(r.rows.map(x => [x.date, x.amount, x.desc]), [
    ['2026-09-02', -4.75, 'TIM HORTONS #1234'],
    ['2026-09-03', 2500, 'PAYROLL DEPOSIT'],
    ['2026-09-05', -95, 'ROGERS ******1234'],
  ]);
});

test('headerless ISO dates with card number column (CIBC style)', () => {
  const r = run([
    '2026-09-10,AMAZON.CA MKTP,45.19,,4500********1234',
    '2026-09-12,PAYMENT THANK YOU,,500.00,4500********1234',
  ].join('\n'));
  assert.equal(r.rows[0].amount, -45.19);
  assert.equal(r.rows[1].amount, 500);
  assert.equal(r.rows[0].desc, 'AMAZON.CA MKTP');
});

test('header row with signed amount and two description columns (RBC style)', () => {
  const r = run([
    '"Account Type","Account Number","Transaction Date","Cheque Number","Description 1","Description 2","CAD$","USD$"',
    'Chequing,01234-5678901,9/14/2026,,"Online Banking transfer","TRANSFER 1234",-200.00,',
    'Chequing,01234-5678901,9/15/2026,,"Deposit","Harbour Yoga",1000.00,',
  ].join('\r\n'));
  assert.equal(r.map.header, true);
  assert.equal(r.map.cols[2], 'date');
  assert.equal(r.map.cols[6], 'amount');
  assert.equal(r.map.cols[7], '');
  assert.deepEqual(r.rows.map(x => [x.date, x.amount, x.desc]), [
    ['2026-09-14', -200, 'Online Banking transfer TRANSFER 1234'],
    ['2026-09-15', 1000, 'Deposit Harbour Yoga'],
  ]);
});

test('header with compact dates (BMO style) and title lines ignored', () => {
  const r = run([
    'Following data is valid as of 20260928',
    '',
    'First Bank Card,Transaction Type,Date Posted, Transaction Amount,Description',
    "'5555',DEBIT,20260920,-12.34,[DN]COFFEE SHOP",
    "'5555',CREDIT,20260921,100.00,[CW]E-TRANSFER",
  ].join('\n'));
  assert.equal(r.map.header, true);
  assert.equal(r.map.skip, 1); // blank lines are dropped by parseCSV
  assert.deepEqual(r.map.cols, ['', '', 'date', 'amount', 'desc']);
  assert.equal(r.map.dateFormat, 'compact');
  assert.deepEqual(r.rows.map(x => [x.date, x.amount, x.desc]), [
    ['2026-09-20', -12.34, '[DN]COFFEE SHOP'],
    ['2026-09-21', 100, '[CW]E-TRANSFER'],
  ]);
});

test('flip sign for card exports that show charges as positive', () => {
  const rows = P.parseCSV('Date,Description,Amount\n2026-09-01,GAS STATION,60.00\n2026-09-05,PAYMENT,-300.00');
  const m = P.guessMapping(rows);
  m.flip = true;
  const r = P.applyMapping(rows, m);
  assert.deepEqual(r.rows.map(x => x.amount), [-60, 300]);
});

test('reports unreadable lines', () => {
  const rows = P.parseCSV('Date,Description,Amount\n2026-09-01,OK,10\n2026-13-45,BAD DATE,5');
  const r = P.applyMapping(rows, P.guessMapping(rows));
  assert.equal(r.rows.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 3);
});

test('OFX (SGML) bank statement', () => {
  const ofx = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD<BANKACCTFROM><BANKID>001<ACCTID>12345</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901<DTEND>20260930
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902120000[-5:EST]<TRNAMT>-4.75<FITID>9001<NAME>TIM HORTONS<MEMO>POS PURCHASE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260903<TRNAMT>2500.00<FITID>9002<NAME>PAYROLL &amp; CO</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>7710.25<DTASOF>20260930</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  assert.equal(P.detectFormat(ofx, 'statement.qfx'), 'ofx');
  const r = P.parseOFX(ofx);
  assert.deepEqual(r.rows, [
    { date: '2026-09-02', amount: -4.75, desc: 'TIM HORTONS POS PURCHASE', fitid: '9001' },
    { date: '2026-09-03', amount: 2500, desc: 'PAYROLL & CO', fitid: '9002' },
  ]);
  assert.deepEqual(r.balance, { amount: 7710.25, date: '2026-09-30' });
  assert.equal(r.accountType, 'bank');
});

test('OFX (XML) credit card statement', () => {
  const ofx = `<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CCACCTFROM><ACCTID>4500</ACCTID></CCACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260910</DTPOSTED><TRNAMT>-45.19</TRNAMT><FITID>A1</FITID><NAME>AMAZON</NAME></STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>-845.19</BALAMT><DTASOF>20260930</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
  const r = P.parseOFX(ofx);
  assert.equal(r.accountType, 'card');
  assert.deepEqual(r.rows, [{ date: '2026-09-10', amount: -45.19, desc: 'AMAZON', fitid: 'A1' }]);
  assert.equal(r.balance.amount, -845.19);
});
