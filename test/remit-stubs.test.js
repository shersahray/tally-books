'use strict';
// Remitting schedules (monthly, quarterly, accelerated threshold 1 and 2; Revenu Québec's own frequency), due dates moved
// off weekends and holidays, and emailed pay stubs (the PDF, and one mail route call per employee).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const P = require('../public/payroll-calc.js');
const PDF = require('../public/pdf.js');
const PS = require('../public/paystub.js');
const B = require('../public/batch.js');
const { createApp } = require('../src/server/app');

/* ---------- period keys ---------- */
test('period keys for each frequency, including month and year ends', () => {
  assert.equal(P.remitKey('2026-10-09', 'monthly'), '2026-10');
  assert.equal(P.remitKey('2026-11-06', 'quarterly'), '2026-Q4');
  assert.equal(P.remitKey('2026-10-15', 'accel1'), '2026-10-H1');
  assert.equal(P.remitKey('2026-10-16', 'accel1'), '2026-10-H2');
  assert.equal(P.remitKey('2026-10-07', 'accel2'), '2026-10-W1');
  assert.equal(P.remitKey('2026-10-08', 'accel2'), '2026-10-W2');
  assert.equal(P.remitKey('2026-10-21', 'accel2'), '2026-10-W3');
  assert.equal(P.remitKey('2026-10-22', 'accel2'), '2026-10-W4');
  assert.equal(P.remitKey('2026-10-31', 'accel2'), '2026-10-W4', 'the 29th to 31st are in the last period');
  assert.equal(P.remitKey('2026-12-31', 'annual'), '2026');
  assert.deepEqual(P.periodOfKey('2026-02-W4'), { freq: 'accel2', from: '2026-02-22', to: '2026-02-28' });
  assert.deepEqual(P.periodOfKey('2028-02-H2'), { freq: 'accel1', from: '2028-02-16', to: '2028-02-29' });
  assert.deepEqual(P.periodOfKey('2026-Q1'), { freq: 'quarterly', from: '2026-01-01', to: '2026-03-31' });
  for (const bad of ['', '2026-13', '2026-10-H3', '2026-10-W5', '2026-Q5', 'x']) assert.equal(P.periodOfKey(bad), null, bad);
  // What a bank asks for as the remitting period.
  assert.equal(P.remitPeriodEnd('2026-09'), '2026-09');
  assert.equal(P.remitPeriodEnd('2026-Q3'), '2026-09');
  assert.equal(P.remitPeriodEnd('2026-10-H2'), '2026-10-31');
  assert.equal(P.remitPeriodEnd('2026-10-W2'), '2026-10-14');
});

/* ---------- CRA due dates ---------- */
test('CRA due dates: regular, quarterly, threshold 1 and threshold 2, moved off weekends and holidays', () => {
  const due = (k, prov) => P.remitDueFor(k, 'cra', prov);
  // Regular: the 15th of the next month. Nov 15, 2026 is a Sunday → Monday the 16th; Aug 15, 2026 a Saturday → the 17th.
  assert.equal(due('2026-09'), '2026-10-15');
  assert.equal(due('2026-10'), '2026-11-16');
  assert.equal(due('2026-07'), '2026-08-17');
  assert.equal(due('2026-12'), '2027-01-15', 'year boundary');
  assert.equal(P.remittanceDue('2026-12-31'), '2027-01-15');
  // Quarterly.
  assert.equal(due('2026-Q4'), '2027-01-15');
  assert.equal(due('2027-Q1'), '2027-04-15');
  // Threshold 1: the 25th, and the 10th of the next month.
  assert.equal(due('2026-09-H1'), '2026-09-25');
  assert.equal(due('2026-10-H1'), '2026-10-26', 'Oct 25, 2026 is a Sunday');
  assert.equal(due('2026-10-H2'), '2026-11-10');
  assert.equal(due('2026-12-H1'), '2026-12-28', 'Dec 25 (Christmas, a Friday), then the weekend: Monday the 28th (CRA lists Boxing Day on Saturday the 26th)');
  assert.equal(due('2026-12-H2'), '2027-01-11', 'Jan 10, 2027 is a Sunday; year boundary');
  // Threshold 2: the 3rd working day after the 7th, 14th, 21st and the last day.
  assert.equal(due('2026-09-W1'), '2026-09-10');
  assert.equal(due('2026-10-W1'), '2026-10-13', 'Oct 7 (Wed): 8, 9, then Thanksgiving Monday the 12th is skipped');
  assert.equal(due('2026-03-W4'), '2026-04-07', 'Mar 31: Apr 1, 2, then Good Friday and Easter Monday are skipped');
  assert.equal(due('2026-12-W4'), '2027-01-06', 'Dec 31: Jan 1 is a holiday, then 4, 5, 6');
  assert.equal(due('2026-12-W3'), '2026-12-24', 'Dec 21: 22, 23, 24');
  // Saint-Jean-Baptiste Day is a CRA holiday in Quebec only.
  assert.equal(due('2026-06-W3'), '2026-06-24');
  assert.equal(due('2026-06-W3', 'QC'), '2026-06-25');
  // The Civic Holiday everywhere but Quebec (Aug 3, 2026): July's last period ends Fri the 31st.
  assert.equal(due('2026-07-W4'), '2026-08-06');
  assert.equal(due('2026-07-W4', 'QC'), '2026-08-05');
});

test('CRA public holidays for due dates (2026, as CRA lists them) and slip due dates', () => {
  assert.deepEqual([...P.dueHolidays('cra', 2026, 'ON')], ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-18', '2026-07-01', '2026-08-03', '2026-09-07', '2026-09-30', '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-26']);
  assert.ok(P.dueHolidays('cra', 2026, 'QC').has('2026-06-24') && !P.dueHolidays('cra', 2026, 'QC').has('2026-08-03'));
  assert.equal(P.isBusinessDay('2026-10-12'), false, 'Thanksgiving');
  assert.equal(P.isBusinessDay('2026-10-17'), false, 'Saturday');
  assert.equal(P.isBusinessDay('2026-10-13'), true);
  assert.equal(P.nextBusinessDay('2027-01-01'), '2027-01-04');
  assert.equal(P.addBusinessDays('2026-12-31', 3), '2027-01-06');
  // T4 and RL-1 slips: the last day of February, or the next business day.
  assert.equal(P.slipsDue(2026), '2027-03-01', 'Feb 28, 2027 is a Sunday');
  assert.equal(P.slipsDue(2027), '2028-02-29', 'leap year');
  assert.equal(P.slipsDue(2025), '2026-03-02', 'Feb 28, 2026 is a Saturday');
});

/* ---------- Revenu Québec ---------- */
test('Revenu Québec: its own frequencies and closing days, matching its published 2026 schedule', () => {
  const pad = n => String(n).padStart(2, '0');
  const all = (f) => { const out = []; for (let m = 1; m <= 12; m++) out.push(...f(m)); return out.map(d => d.slice(5)).join(' '); };
  assert.equal(all(m => [1, 2, 3, 4].map(w => P.remitDueFor(`2026-${pad(m)}-W${w}`, 'rq'))),
    '01-12 01-19 01-26 02-04 02-11 02-18 02-25 03-04 03-11 03-18 03-25 04-07 04-10 04-17 04-24 05-05 05-12 05-20 05-26 06-03 06-10 06-17 06-25 07-06 07-10 07-17 07-24 08-05 08-12 08-19 08-26 09-03 09-10 09-17 09-24 10-05 10-13 10-19 10-26 11-04 11-12 11-18 11-25 12-03 12-10 12-17 12-29 01-07');
  assert.equal(all(m => [1, 2].map(h => P.remitDueFor(`2026-${pad(m)}-H${h}`, 'rq'))),
    '01-26 02-10 02-25 03-10 03-25 04-10 04-27 05-11 05-25 06-10 06-25 07-10 07-27 08-10 08-25 09-10 09-25 10-13 10-26 11-10 11-25 12-10 12-29 01-11');
  assert.equal(all(m => [P.remitDueFor(`2026-${pad(m)}`, 'rq')]), '02-16 03-16 04-15 05-15 06-15 07-15 08-17 09-15 10-15 11-16 12-15 01-15');
  assert.equal(P.remitDueFor('2026', 'rq'), '2027-01-15', 'yearly remitters');
  assert.ok(P.REMIT_FREQS.rq.includes('annual') && !P.REMIT_FREQS.cra.includes('annual'));
  // The same period can be due on different days: CRA works on Dec 28 and 29, Revenu Québec doesn't.
  assert.equal(P.remitDueFor('2026-12-H1', 'cra'), '2026-12-28');
  assert.equal(P.remitDueFor('2026-12-H1', 'rq'), '2026-12-29');
});

/* ---------- changing frequency mid-year ---------- */
test('changing frequency mid-year keeps recorded payments matched to their own period', () => {
  // Monthly until September, paid; then threshold 1 from October.
  const paid = ['2026-09'];
  assert.deepEqual(P.remitPeriodFor('2026-09-25', 'accel1', 'cra', '', paid), { key: '2026-09', freq: 'monthly', from: '2026-09-01', to: '2026-09-30', due: '2026-10-15' }, 'a late September pay stays with the paid month');
  assert.equal(P.remitPeriodFor('2026-10-09', 'accel1', 'cra', '', paid).key, '2026-10-H1');
  // The other way: half-months were paid, then back to monthly. October's first half stays its own period.
  const paid2 = ['2026-10-H1'];
  assert.equal(P.remitPeriodFor('2026-10-09', 'monthly', 'cra', '', paid2).key, '2026-10-H1');
  assert.equal(P.remitPeriodFor('2026-10-23', 'monthly', 'cra', '', paid2).key, '2026-10');
  // Nothing paid: the current frequency.
  assert.equal(P.remitPeriodFor('2026-09-25', 'accel2').key, '2026-09-W4');
  assert.equal(P.remitPeriodFor('2026-09-25', 'accel2').due, '2026-10-05');
});

/* ---------- payroll.js in a sandbox: remittances by period, and the stub's figures ---------- */
function payrollSandbox(state) {
  const vm = require('node:vm');
  const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const ctx = { TallyPayroll: P, TallyStub: PS, TallyPDF: PDF, Math, String, Number, Date, Object, Array, JSON, Set, Map, Promise, Error, console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(`
    const S=${JSON.stringify(state)};S.entries=S.entries||[];S.payruns=S.payruns||[];S.employees=S.employees||[];
    const DETAILS={Liability:[],Expense:[]},TLABEL={};
    const r2=n=>Math.round(((+n)||0)*100)/100,pad=n=>String(n).padStart(2,'0'),pd=s=>new Date(s+'T12:00:00'),LOC=()=>'en-CA',today=()=>'2026-10-12';
    const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
    const money=n=>'$'+(+n||0).toFixed(2),fmtDate=s=>s,T=s=>s;
  ` + pub('payroll.js') + ';this.S=S;this.remittances=remittances;this.remitPeriod=remitPeriod;this.stubData=stubData;this.stubHTML=stubHTML;', ctx);
  return ctx;
}
const ded0 = { cpp: 0, cpp2: 0, qpp: 0, qpp2: 0, ei: 0, qpip: 0, fedTax: 0, provTax: 0, qcTax: 0 }, er0 = { cpp: 0, cpp2: 0, qpp: 0, qpp2: 0, ei: 0, qpip: 0, hsf: 0 };
const runOn = (id, payDate, emp = 'e1', name = 'Ana Lima') => ({ id, payDate, freq: 'weekly', created: 1, lines: [{ employeeId: emp, name, gross: 1000, regular: 1000, rrsp: 0, union: 0, net: 800, ded: { ...ded0, cpp: 50, ei: 16, fedTax: 100, provTax: 34 }, er: { ...er0, cpp: 50, ei: 22.4 } }] });

test('remittance list: threshold 2 periods with PD7A figures; CRA and Revenu Québec each on their own frequency', () => {
  const qline = { employeeId: 'e2', name: 'Luc', gross: 1000, regular: 1000, rrsp: 0, union: 0, net: 800, ded: { ...ded0, qpp: 60, qpip: 5, ei: 13, fedTax: 50, qcTax: 72 }, er: { ...er0, qpp: 60, qpip: 7, ei: 18.2, hsf: 16.5 } };
  const runs = [runOn('r1', '2026-10-02'), runOn('r2', '2026-10-09'), runOn('r3', '2026-10-16'), { ...runOn('r4', '2026-10-23'), lines: [runOn('x', '2026-10-23').lines[0], qline] }];
  const c = payrollSandbox({ company: { name: 'Co', province: 'ON', payroll: { remitFreq: 'accel2', remitFreqRq: 'monthly' } }, payruns: runs, employees: [{ id: 'e1', name: 'Ana Lima' }, { id: 'e2', name: 'Luc', prov: 'QC' }] });
  const rs = plain(c.remittances());
  const cra = rs.filter(x => x.agency === 'cra').map(x => [x.key, x.due, x.owed, x.gross, x.lastEmps]);
  assert.deepEqual(cra.sort(), [
    ['2026-10-W1', '2026-10-13', 272.4, 1000, 1],
    ['2026-10-W2', '2026-10-19', 272.4, 1000, 1],
    ['2026-10-W3', '2026-10-26', 272.4, 1000, 1],
    ['2026-10-W4', '2026-11-04', 272.4 + 81.2, 2000, 2],
  ].map(x => [x[0], x[1], Math.round(x[2] * 100) / 100, x[3], x[4]]));
  const rq = rs.filter(x => x.agency === 'rq');
  assert.deepEqual(rq.map(x => [x.key, x.label, x.due, x.owed]), [['2026-10', 'October 2026', '2026-11-16', 220.5]]);
  assert.equal(rs.find(x => x.key === '2026-10-W2').label, '2026-10-08 – 2026-10-14');
});

test('remittance list after a change of frequency: old payments stay matched under their own period', () => {
  const runs = [runOn('r1', '2026-09-04'), runOn('r2', '2026-09-25'), runOn('r3', '2026-10-09'), runOn('r4', '2026-10-23')];
  const pay = (id, period, amount) => ({ id, type: 'payremit', agency: 'cra', period, amount, date: '2026-10-10', lines: [] });
  const c = payrollSandbox({ company: { name: 'Co', province: 'ON', payroll: { remitFreq: 'accel1' } }, payruns: runs, employees: [{ id: 'e1', name: 'Ana Lima' }],
    entries: [pay('p1', '2026-09', 544.8)] });
  const rs = plain(c.remittances()).map(x => [x.key, x.owed, x.paid, x.st.k]);
  assert.deepEqual(rs, [['2026-10-H2', 272.4, 0, 'open'], ['2026-10-H1', 272.4, 0, 'open'], ['2026-09', 544.8, 544.8, 'paid']]);
  // A payment for a period with no pay runs still shows, with its own due date.
  const c2 = payrollSandbox({ company: { name: 'Co', payroll: { remitFreq: 'monthly' } }, payruns: [], entries: [pay('p2', '2026-08-W2', 10)] });
  const x = plain(c2.remittances())[0];
  assert.deepEqual([x.key, x.due, x.paid, x.owed], ['2026-08-W2', '2026-08-19', 10, 0]);
});

/* ---------- pay stub PDF ---------- */
const plain = x => JSON.parse(JSON.stringify(x)); // out of the sandbox's realm, for deepEqual
const pdfText = bytes => Buffer.from(bytes).toString('latin1');
const stubState = () => ({
  company: { name: 'Maple Bakery', bn: '123456789RP0001', lang: 'en' },
  employees: [{ id: 'e1', name: 'Ana Lima', email: 'ana@example.com', sin: '046454286', address: '1 Main St\nOttawa ON', payMethod: 'deposit', bank: { inst: '003', transit: '47291', account: '9876543210' } },
    { id: 'e2', name: 'Éloïse Tremblay', email: 'eloise@example.com', lang: 'fr', sin: '130692544', prov: 'QC' }],
  payruns: [runOn('r1', '2026-09-25'), { ...runOn('r2', '2026-10-09'), from: '2026-09-26', to: '2026-10-09', lines: [{ ...runOn('x', '2026-10-09').lines[0], vacMode: 'accrue', vacAccrued: 40, vacRate: 4 }, { ...runOn('x', '2026-10-09', 'e2', 'Éloïse Tremblay').lines[0], bonus: 0 }] }],
});

test('stub PDF: the employee’s numbers, year to date, no SIN, only the last 3 digits of the bank account', () => {
  const c = payrollSandbox(stubState());
  const run = c.S.payruns[1], s = plain(c.stubData(run, run.lines[0]));
  assert.deepEqual([s.gross, s.totalDed, s.net, s.deposit], [[1000, 2000], [200, 400], 800, '210']);
  assert.deepEqual(s.deductions.map(r => [r.key, r.cur, r.ytd]), [['CPP', 50, 100], ['EI', 16, 32], ['Federal income tax', 100, 200], ['Provincial income tax', 34, 68]]);
  assert.deepEqual(s.vac, { balance: 40, set: 40, rate: 4 });
  const out = pdfText(PS.pdf(PDF, s, 'en'));
  assert.match(out, /^%PDF-1\.4/);
  assert.match(out, /\/Type \/Pages \/Kids \[\d+ 0 R\] \/Count 1/, 'one page, not a blank one first');
  for (const t of ['(Maple Bakery)', '(Ana Lima)', '(1 Main St)', '(Pay stub)', '(Federal income tax)', '($1,000.00)', '($2,000.00)', '($800.00)', '($200.00)', '($400.00)', '(Deposited to the account ending in 210)'])
    assert.ok(out.includes(t), t);
  assert.ok(!out.includes('046') && !/046.?454.?286/.test(out), 'no SIN');
  assert.ok(!out.includes('9876543') && !out.includes('(47291') && !out.includes(' 47291'), 'no full account or transit');
  // The printed stub has the same figures and no SIN either.
  const html = c.stubHTML(run, run.lines[0]);
  assert.ok(html.includes('Ana Lima') && html.includes('$800.00') && !html.includes('046454286') && !html.includes('046 454 286'));
  assert.match(html, /account ending in 210/);
});

test('stub PDF in French for an employee who reads French, with French amounts', () => {
  const c = payrollSandbox(stubState());
  const run = c.S.payruns[1], s = plain(c.stubData(run, run.lines[1]));
  const out = pdfText(PS.pdf(PDF, s, 'fr'));
  const enc = t => PDF.encode(t);
  for (const t of ['Relevé de paie', 'Éloïse Tremblay', 'Salaire net', 'Impôt fédéral', 'Cumul annuel']) assert.ok(out.includes(`(${enc(t)})`), t);
  assert.ok(out.includes(enc((800).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' }))), 'French amount format');
  assert.ok(!out.includes('130692544') && !out.includes('130 692 544'));
  assert.equal(s.deposit, '', 'paid by cheque: no account shown');
  // The email: the company's own wording in the employee's language, or Sumlora's.
  assert.deepEqual(PS.message(null, 'fr', { name: 'Éloïse', date: '9 oct. 2026', company: 'Maple' }), ['Votre relevé de paie du 9 oct. 2026', 'Bonjour Éloïse,\n\nVous trouverez ci-joint votre relevé de paie du 9 oct. 2026.\n\nMerci,\nMaple']);
  assert.deepEqual(PS.message({ en: { subject: 'Pay for {date}', text: '' } }, 'en', { name: 'Ana', date: 'Oct 9, 2026', company: 'Maple' })[0], 'Pay for Oct 9, 2026');
  assert.equal(PS.fileName('fr', '2026-10-09', 'Éloïse Tremblay'), 'Releve-de-paie-2026-10-09-Eloise-Tremblay.pdf');
  assert.deepEqual(PS.plan([{ employeeId: 'a' }, { employeeId: 'b' }], l => (l.employeeId === 'a' ? 'a@x.ca' : '')), { go: [{ employeeId: 'a' }], skip: [{ line: { employeeId: 'b' }, why: 'noemail' }] });
});

/* ---------- through the server: one mail route call per employee, "sent" on the pay run line ---------- */
let server, base, dir, co, cookie, smtp;
const got = [];
before(async () => {
  smtp = net.createServer(sock => {
    let mode = 'cmd', data = '', cur = { rcpt: [] }, buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (mode === 'data') { if (line === '.') { mode = 'cmd'; cur.data = data; got.push(cur); cur = { rcpt: [] }; data = ''; sock.write('250 queued\r\n'); } else data += line + '\r\n'; continue; }
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) sock.write('235 ok\r\n');
        else if (/^MAIL FROM/i.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT TO/i.test(line)) { cur.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { mode = 'data'; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('500 what\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-stubs-'));
  server = createApp({ dataDir: dir, autoBackup: false, mailAllowLocal: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Stub Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('settings: CRA and Revenu Québec frequencies, stub email wording; employee language; remittance periods checked', async () => {
  const s = (await call('GET', '/api/c/state')).json.company;
  let r = await call('PUT', '/api/c/settings', { ...s, payroll: { remitFreq: 'accel2', remitFreqRq: 'accel1', stubMail: { fr: { subject: 'Paie du {date}\nBcc: x', text: 'Bonjour {name}' }, en: { subject: '', text: '' } } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let p = (await call('GET', '/api/c/state')).json.company.payroll;
  assert.equal(p.remitFreq, 'accel2'); assert.equal(p.remitFreqRq, 'accel1');
  assert.deepEqual(p.stubMail, { fr: { subject: 'Paie du {date} Bcc: x', text: 'Bonjour {name}' } }, 'one line subject; blank language dropped');
  await call('PUT', '/api/c/settings', { ...s, payroll: { remitFreq: 'weekly', remitFreqRq: 'annual-ish' } });
  p = (await call('GET', '/api/c/state')).json.company.payroll;
  assert.equal(p.remitFreq, 'monthly'); assert.equal(p.remitFreqRq, undefined, 'unknown: the same as CRA');
  await call('PUT', '/api/c/settings', { ...s, payroll: { remitFreq: 'quarterly', remitFreqRq: 'annual' } });
  assert.equal((await call('GET', '/api/c/state')).json.company.payroll.remitFreqRq, 'annual');
  await call('PUT', '/api/c/settings', { ...s, payroll: { remitFreq: 'annual' } });
  assert.equal((await call('GET', '/api/c/state')).json.company.payroll.remitFreq, 'monthly', 'CRA has no yearly remitters');
  const emp = { name: 'Ana Lima', prov: 'ON', freq: 'weekly', payType: 'salary', rate: 52000, email: 'ana@example.com', sin: '046454286', lang: 'fr' };
  assert.equal((await call('PUT', '/api/c/records/employees/e1', emp)).status, 200);
  assert.equal((await call('PUT', '/api/c/records/employees/e3', { ...emp, name: 'Zed', lang: 'de' })).status, 200);
  const st = (await call('GET', '/api/c/state')).json;
  assert.equal(st.employees.find(e => e.id === 'e1').lang, 'fr');
  assert.equal(st.employees.find(e => e.id === 'e3').lang, '', 'unknown language: the company’s');
  // A remittance payment needs a known agency and a real period key.
  const acct = (id, code, name, type, detail) => call('PUT', `/api/c/records/accounts/${id}`, { code, name, type, detail });
  assert.equal((await acct('a2300', '2300', 'Payroll liabilities – CRA', 'Liability', 'payroll_cra')).status, 200);
  const pay = (period, agency = 'cra') => call('PUT', '/api/c/records/entries/rp1', { type: 'payremit', agency, period, amount: 10, bank: 'a1000', date: '2026-10-10', lines: [{ account: 'a2300', debit: 10, credit: 0 }, { account: 'a1000', debit: 0, credit: 10 }] });
  for (const k of ['2026-10-W3', '2026-10-H1', '2026-Q4', '2026-10', '2026']) assert.equal((await pay(k)).status, 200, k);
  for (const k of ['2026-10-W5', 'October', '']) assert.equal((await pay(k)).status, 400, k);
  assert.equal((await pay('2026-10', 'irs')).status, 400);
  assert.equal((await call('DELETE', '/api/c/records/entries/rp1')).status, 200);
});

test('email pay stubs: one mail route call per employee, no email skipped, "sent" recorded on the pay run line', async () => {
  for (const [id, name, email] of [['e1', 'Ana Lima', 'ana@example.com'], ['e2', 'Ben Roy', ''], ['e3', 'Cy Park', 'cy@example.com']])
    assert.equal((await call('PUT', `/api/c/records/employees/${id}`, { name, prov: 'ON', freq: 'weekly', payType: 'salary', rate: 52000, email, sin: '046454286' })).status, 200);
  const line = (employeeId, name) => ({ employeeId, name, gross: 1000, regular: 1000, rrsp: 0, union: 0, net: 800, ded: { ...ded0, cpp: 50, ei: 16, fedTax: 100, provTax: 34 }, er: { ...er0, cpp: 50, ei: 22.4 } });
  await call('PUT', '/api/c/records/accounts/a7110', { code: '7110', name: 'Employer payroll taxes', type: 'Expense', detail: 'payroll_tax' });
  const run = { payDate: '2026-10-09', freq: 'weekly', bank: 'a1000', entryId: 'pr1', lines: [line('e1', 'Ana Lima'), line('e2', 'Ben Roy'), line('e3', 'Cy Park')] };
  const entry = { type: 'payrun', date: '2026-10-09', lines: [{ account: 'a7100', debit: 3000, credit: 0 }, { account: 'a7110', debit: 217.2, credit: 0 }, { account: 'a2300', debit: 0, credit: 817.2 }, { account: 'a1000', debit: 0, credit: 2400 }] };
  let r = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'entries', id: 'pr1', data: entry }, { op: 'set', collection: 'payruns', id: 'run1', data: run }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await call('PUT', '/api/c/mail', { host: '127.0.0.1', port: smtp.address().port, security: 'none', user: 'pay@stubco.ca', pass: 'pw-123456', fromName: 'Stub Co' })).status, 200);
  const st = (await call('GET', '/api/c/state')).json;
  const emailOf = l => (st.employees.find(e => e.id === l.employeeId) || {}).email || '';
  const p = PS.plan(st.payruns[0].lines, emailOf);
  assert.deepEqual(p.go.map(l => l.name), ['Ana Lima', 'Cy Park']);
  assert.deepEqual(p.skip.map(s => [s.line.name, s.why]), [['Ben Roy', 'noemail']]);
  const before = got.length, calls = [];
  const results = await B.runSequential(p.go, async l => {
    calls.push(l.employeeId);
    const bytes = PS.pdf(PDF, { company: { name: 'Stub Co' }, payDate: '2026-10-09', name: l.name, earnings: [{ key: 'Regular pay', cur: 1000, ytd: null }], gross: [1000, 1000], benefits: null, deductions: [], totalDed: [200, 200], net: 800, vac: null, employer: [], deposit: '' });
    const [subject, text] = PS.message(null, 'en', { name: l.name, date: 'Oct 9, 2026', company: 'Stub Co' });
    const res = await call('POST', '/api/c/mail/send', { to: emailOf(l), subject, text, attachments: [{ name: PS.fileName('en', '2026-10-09', l.name), data: Buffer.from(bytes).toString('base64') }], what: 'paystub', payrunId: 'run1', employeeId: l.employeeId });
    if (res.status !== 200) { const e = new Error(res.json.error); e.status = res.status; throw e; }
  });
  assert.deepEqual(calls, ['e1', 'e3'], 'one call per employee, in order');
  assert.ok(results.every(x => x.ok), JSON.stringify(results.map(x => x.error)));
  const mails = got.slice(before);
  assert.deepEqual(mails.map(m => m.rcpt[0]), ['RCPT TO:<ana@example.com>', 'RCPT TO:<cy@example.com>']);
  assert.match(mails[0].data, /filename="Pay-stub-2026-10-09-Ana-Lima\.pdf"/);
  assert.match(mails[0].data, /Your pay stub for Oct 9, 2026/);
  const lines = (await call('GET', '/api/c/state')).json.payruns[0].lines;
  assert.equal(lines[0].sent.length, 1); assert.equal(lines[0].sent[0].to, 'ana@example.com'); assert.equal(lines[0].sent[0].by, 'Owner');
  assert.equal(lines[1].sent, undefined, 'skipped: no email');
  assert.equal(lines[2].sent.length, 1);
  assert.equal((await call('GET', '/api/c/mail')).json.sentToday, 2, 'counts toward the daily limit');
  // A stub only goes to that employee's own address, for a line in that pay run.
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  const send = b => call('POST', '/api/c/mail/send', { subject: 'Pay stub', text: 'x', attachments: [{ name: 's.pdf', data: pdf }], what: 'paystub', payrunId: 'run1', ...b });
  r = await send({ to: 'someone@else.com', employeeId: 'e1' });
  assert.equal(r.status, 400); assert.match(r.json.error, /own email address/);
  assert.equal((await send({ to: 'ana@example.com', cc: 'boss@example.com', employeeId: 'e1' })).status, 400);
  assert.equal((await send({ to: 'ana@example.com', employeeId: 'e9' })).status, 404);
  assert.equal((await send({ to: 'ana@example.com', employeeId: 'e1', payrunId: 'nope' })).status, 404);
  // A void pay run's stubs aren't sent (the screen hides the button; the server says no too).
  server.registry.store(co).put('payruns', 'runV', { ...run, void: { date: '2026-10-10', reason: 'Wrong', entryId: '' } });
  r = await send({ to: 'ana@example.com', employeeId: 'e1', payrunId: 'runV' });
  assert.equal(r.status, 409); assert.match(r.json.error, /voided/);
  server.registry.store(co).delete('payruns', 'runV');
  assert.equal(got.length, before + 2, 'nothing refused was sent');
  // Saving the pay run again keeps the record of what was sent, in its own shape only.
  const saved = (await call('GET', '/api/c/state')).json.payruns[0];
  r = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'payruns', id: 'run1', data: { ...saved, lines: saved.lines.map(l => (l.sent ? { ...l, sent: [...l.sent, { at: 'x', to: 'odd@example.com', extra: 1 }] } : l)) } }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s2 = (await call('GET', '/api/c/state')).json.payruns[0].lines[0].sent;
  assert.deepEqual(s2[1], { at: 0, to: 'odd@example.com', by: '' });
});

/* ---------- French ---------- */
test('French: the new screens’ text translates, numbers kept', () => {
  const vm = require('node:vm');
  const ctx = { navigator: { language: 'fr-CA' }, localStorage: { getItem: () => null, setItem() {} }, document: { addEventListener() {}, documentElement: { setAttribute() {} } },
    location: {}, MutationObserver: class { observe() {} }, Document: class {}, NodeFilter: {}, console };
  vm.createContext(ctx);
  const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext(pub('i18n.js') + ';' + pub('fr.js') + ';this.tr=tr;', ctx);
  const { tr } = ctx;
  assert.equal(tr('Twice a month (accelerated, threshold 1)'), 'Deux fois par mois (accéléré, seuil 1)');
  assert.equal(tr('Up to four times a month (accelerated, threshold 2)'), 'Jusqu’à quatre fois par mois (accéléré, seuil 2)');
  assert.equal(tr('Weekly (four times a month)'), 'Hebdomadaire (quatre fois par mois)');
  assert.equal(tr('Email 3 pay stubs?'), 'Envoyer 3 relevés de paie?');
  assert.equal(tr('Deposited to the account ending in 210'), 'Déposé dans le compte se terminant par 210');
  assert.equal(tr('Emailed 2026-10-09'), 'Envoyé le 2026-10-09');
  assert.equal(tr('Email pay stubs'), 'Envoyer les relevés de paie');
  assert.match(tr('CRA tells you which in your remitter letter. Threshold 1: average monthly withholding of $25,000 to $99,999.99; threshold 2: $100,000 or more.'), /^L’ARC vous l’indique.*Seuil 1 : .*25 000 \$ à 99 999,99 \$; seuil 2 : 100 000 \$ ou plus\.$/);
  assert.match(tr('Most banks list it as “Federal – payroll deductions – threshold 2” or similar. Search “payroll” when adding the payee.'), /seuil 2/);
  assert.match(tr('Four periods a month (1st–7th, 8th–14th, 15th–21st, 22nd–end), each due the 3rd business day after it ends.'), /^Quatre périodes/);
  assert.equal(tr('A pay stub goes only to the employee’s own email address.'), 'Un relevé de paie est envoyé seulement à l’adresse courriel de l’employé.');
});

test('stub with overtime, a bonus that earns vacation pay, on a void run: same rows in HTML and PDF, English and French', () => {
  const st = stubState();
  st.payruns[1] = { ...st.payruns[1], void: true, lines: [{ ...st.payruns[1].lines[0], payType: 'hourly', rate: 20, hours: 48, otHours: 4, regular: 880, overtime: 120, bonus: 0, gross: 1000 }, { ...st.payruns[1].lines[1], regular: 900, bonus: 100, bonusVac: true }] };
  const c = payrollSandbox(st);
  const run = c.S.payruns[1];
  const a = plain(c.stubData(run, run.lines[0])), b = plain(c.stubData(run, run.lines[1]));
  assert.equal(a.void, true);
  assert.deepEqual(a.earnings.slice(0, 2).map(r => [r.key, r.cur, r.h, r.rate]), [['Regular pay', 880, 44, 20], ['Overtime', 120, 4, 30]]);
  assert.ok(b.earnings.some(r => r.key === 'Bonus (earns vacation pay)' && r.cur === 100));
  const html = c.stubHTML(run, run.lines[0]);
  assert.match(html, /Regular, 44 h × \$20\.00/); assert.match(html, /Overtime, 4 h × \$30\.00/); assert.match(html, /<b>Void<\/b>/);
  assert.match(c.stubHTML(run, run.lines[1]), /Bonus \(earns vacation pay\)/);
  const en = pdfText(PS.pdf(PDF, a, 'en')), fr = pdfText(PS.pdf(PDF, a, 'fr')), frB = pdfText(PS.pdf(PDF, b, 'fr'));
  assert.ok(en.includes(`(${PDF.encode('Regular, 44 h × $20.00')})`), 'regular hours are the hours less overtime');
  assert.ok(en.includes(`(${PDF.encode('Overtime, 4 h × $30.00')})`));
  assert.ok(en.includes(`(${PDF.encode('Void: this pay run was cancelled.')})`));
  const m = n => PDF.encode((n).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' }));
  assert.ok(fr.includes(`(${PDF.encode('Heures supplémentaires, 4 h × ')}${m(30)})`));
  assert.ok(fr.includes(`(${PDF.encode('Annulée : cette paie a été annulée.')})`));
  assert.ok(frB.includes(`(${PDF.encode('Prime (donne droit à l’indemnité de vacances)')})`));
  // Void runs aren't remitted.
  assert.ok(!plain(c.remittances()).some(x => x.lastRun && x.lastRun.id === run.id));
});
