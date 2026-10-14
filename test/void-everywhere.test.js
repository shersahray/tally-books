'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// A void pay run counts for nothing anywhere: ROEs, T4/RL-1 and the T4 XML, EHT, WSIB, remittances, the cash flow
// forecast's next pay, the payroll add-on's employees billed, workflow reminders and year-to-date on later stubs.
// Each feature was built on its own; this checks they agree once together.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../public/payroll-calc.js');
const X = require('../public/payroll-xml.js');
const PLANS = require('../public/plans.js');
const WF = require('../public/workflows.js');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
const ded0 = { cpp: 0, cpp2: 0, qpp: 0, qpp2: 0, ei: 0, qpip: 0, fedTax: 0, provTax: 0, qcTax: 0 }, er0 = { cpp: 0, cpp2: 0, qpp: 0, qpp2: 0, ei: 0, qpip: 0, hsf: 0 };
const line = (gross, extra = {}) => ({ employeeId: 'e1', name: 'Ana Lima', prov: 'ON', payType: 'hourly', hours: 80, gross, regular: gross, insurable: gross, pensionable: gross, rrsp: 0, union: 0,
  net: gross * 0.8, ded: { ...ded0, cpp: gross * 0.05, ei: gross * 0.016, fedTax: gross * 0.1 }, er: { ...er0, cpp: gross * 0.05, ei: gross * 0.0224 }, wsib: { group: 'g1', insurable: gross, premium: gross * 0.01 }, ...extra });
// Three biweekly runs: September 4 (live), September 18 (void, a huge amount by mistake), October 2 (live, the latest).
const runs = [
  { id: 'r1', payDate: '2026-09-04', from: '2026-08-22', to: '2026-09-04', freq: 'biweekly', created: 1, lines: [line(2000)] },
  { id: 'r2', payDate: '2026-09-18', from: '2026-09-05', to: '2026-09-18', freq: 'biweekly', created: 2, lines: [line(90000)], void: { date: '2026-09-19', reason: 'Wrong hours', entryId: 'v2' } },
  { id: 'r3', payDate: '2026-10-02', from: '2026-09-19', to: '2026-10-02', freq: 'biweekly', created: 3, lines: [line(2000)] },
];
// The void run is the latest of its own schedule (weekly): the forecast must not repeat it.
const voidWeekly = { id: 'r4', payDate: '2026-10-09', from: '2026-10-03', to: '2026-10-09', freq: 'weekly', created: 4, lines: [line(50000)], void: { date: '2026-10-10', reason: 'x', entryId: 'v4' } };
const employees = [{ id: 'e1', name: 'Ana Lima', prov: 'ON', freq: 'biweekly', payType: 'hourly', rate: 25, hours: 80, sin: '130692544', dental: 1, addr: { line1: '1 Main St', city: 'Ottawa', prov: 'ON', postal: 'K1A0B1', country: 'CAN' } }];

function sandbox(payruns) {
  const ctx = { TallyPayroll: P, TallyXML: X, Math, String, Number, Date, Object, Array, JSON, Set, Map, Promise, Error, console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(`
    const S=${JSON.stringify({ company: { name: 'Co', province: 'ON', payroll: { remitFreq: 'monthly', wsib: { on: true, freq: 'quarterly', groups: [{ id: 'g1', name: 'Retail', rate: 1 }] } } }, employees, payruns, entries: [] })};
    const DETAILS={Liability:[],Expense:[]},TLABEL={};
    const r2=n=>Math.round(((+n)||0)*100)/100,pad=n=>String(n).padStart(2,'0'),pd=s=>new Date(s+'T12:00:00'),LOC=()=>'en-CA',today=()=>'2026-10-12';
    const iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
    const addDays=(s,n)=>{const d=pd(s);d.setDate(d.getDate()+n);return iso(d)},monthEnd=(y,m)=>iso(new Date(y,m,0));
    const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
    const money=n=>'$'+(+n||0).toFixed(2),fmtDate=s=>s,T=s=>s,emptyRow=(n,a)=>'<tr><td>'+a+'</td></tr>';
  ` + pub('payroll.js') + ';' + pub('payroll-roe.js') + ';this.S=S;this.remittances=remittances;this.ytdFor=ytdFor;this.stubData=stubData;this.roeLines=roeLines;this.vWsib=vWsib;this.ehtData=ehtData;this.paySchedules=paySchedules;this.vacBalance=vacBalance;', ctx);
  return ctx;
}

test('void pay runs: left out of remittances, year to date on later stubs, ROE lines, WSIB, EHT and the forecast’s next pay', () => {
  const c = sandbox([...runs, voidWeekly]);
  // Remittances: September is the first run only; the void one adds nothing.
  const rs = plain(c.remittances()).filter(x => x.agency === 'cra');
  const sep = rs.find(x => x.key === '2026-09');
  assert.equal(sep.gross, 2000);
  assert.equal(sep.owed, P.r2(2000 * (0.05 + 0.016 + 0.1 + 0.05 + 0.0224)));
  assert.ok(!rs.some(x => x.key === '2026-10' && x.gross > 2000), 'the void weekly run isn’t remitted');
  // Year to date on the October stub: r1 and r3 only.
  const st = plain(c.stubData(c.S.payruns[2], c.S.payruns[2].lines[0]));
  assert.deepEqual(st.gross, [2000, 4000]);
  assert.equal(c.ytdFor('e1', { payDate: '2026-12-31' }, false).gross, 4000);
  // ROE: the pay periods of the two live runs.
  assert.deepEqual(plain(c.roeLines(c.S.employees[0], true)).map(l => [l.payDate, l.insurable]), [['2026-09-04', 2000], ['2026-10-02', 2000]]);
  // WSIB report on Remittances: Q3 has 2000 of insurable earnings, not 92000.
  const w = c.vWsib();
  assert.match(w, /\$2000\.00/); assert.doesNotMatch(w, /92000|90000|50000/);
  // EHT: Ontario remuneration leaves the void runs out.
  assert.equal(c.ehtData(2026).total, 4000);
  // Cash flow forecast: each schedule's last live run (the void weekly run makes no schedule of its own).
  assert.deepEqual(plain(c.paySchedules()).map(s => [s.freq, s.last.payDate]), [['biweekly', '2026-10-02']]);
  // Vacation pay owed isn't touched by a void run.
  assert.equal(c.vacBalance('e1'), 0);
});

test('void pay runs: left out of T4 and RL-1 slips and the T4 XML', () => {
  const ye = P.yearEnd({ year: 2026, employees, payruns: [...runs, voidWeekly] });
  assert.equal(ye.slips.length, 1);
  assert.equal(ye.slips[0].t4[14], 4000);
  const out = X.t4Xml({ ye, employees, employer: { name: 'Co', bn: '123456789RP0001', addr: { line1: '1 Rideau St', city: 'Ottawa', prov: 'ON', postal: 'K1N8S7', country: 'CAN' } }, transmitter: { contact: 'Sher', phone: '613-555-1234', email: 'p@example.com' } });
  assert.match(out.xml, /<empt_incamt>4000\.00<\/empt_incamt>/);
  assert.doesNotMatch(out.xml, /9[0-9]000\.00|5[0-9]000\.00/);
});

test('void pay runs: not billed as payroll employees, and no workflow reminder for their remittance', () => {
  assert.equal(PLANS.employeesPaid([...runs, voidWeekly], '2026-09'), 1);
  assert.equal(PLANS.employeesPaid([voidWeekly], '2026-10'), 0);
  // Only a void run in October: nothing to remit, so nothing to remind about.
  const on = { rules: { payrollRemit: { on: true, days: 40 } } };
  const ev = payruns => WF.evaluate({ settings: on, books: { company: { name: 'Co', province: 'ON', payroll: { remitFreq: 'monthly' } }, payruns, entries: [] }, people: [{ id: 'u1', role: 'owner' }], today: '2026-10-12', features: { payroll: true } });
  assert.deepEqual(ev([voidWeekly]), []);
  const hits = ev([runs[1], runs[2]]);
  assert.deepEqual(hits.map(h => h.key), ['payrollRemit|cra|2026-10']);
  assert.equal(hits[0].vars.amount, P.r2(2000 * (0.05 + 0.016 + 0.1 + 0.05 + 0.0224)), 'only the live October run');
});

test('workflow reminders use the same periods and due dates as Payroll → Remittances', () => {
  const ev = (payroll, payruns, entries = []) => WF.evaluate({ settings: { rules: { payrollRemit: { on: true, days: 40 } } }, books: { company: { name: 'Co', province: 'ON', payroll }, payruns, entries },
    people: [{ id: 'u1', role: 'owner' }], today: '2026-10-12', features: { payroll: true } });
  const run = (id, payDate, qc) => ({ id, payDate, lines: [{ employeeId: 'e1', ded: qc ? { ...ded0, qpp: 50, qcTax: 70, fedTax: 30 } : { ...ded0, cpp: 50, fedTax: 100 }, er: qc ? { ...er0, qpp: 50, hsf: 10 } : { ...er0, cpp: 50 } }] });
  // Threshold 2: October 1–7 is due the 3rd business day after (Thanksgiving, October 12, is a CRA holiday).
  const a = ev({ remitFreq: 'accel2' }, [run('r1', '2026-10-02')]);
  assert.deepEqual(a.map(h => [h.key, h.due]), [['payrollRemit|cra|2026-10-W1', P.remitDueFor('2026-10-W1', 'cra', 'ON')]]);
  // Revenu Québec on its own frequency.
  const q = ev({ remitFreq: 'monthly', remitFreqRq: 'accel1' }, [run('r1', '2026-10-02', true)]);
  assert.deepEqual(q.map(h => h.key).sort(), ['payrollRemit|cra|2026-10', 'payrollRemit|rq|2026-10-H1']);
  // A pay date inside a period paid under an earlier frequency stays with that payment (nothing left to remind).
  const paid = ev({ remitFreq: 'accel1' }, [run('r1', '2026-09-25')], [{ type: 'payremit', agency: 'cra', period: '2026-09', amount: 200 }]);
  assert.deepEqual(paid, []);
});
