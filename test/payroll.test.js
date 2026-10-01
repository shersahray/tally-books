'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/payroll-calc.js');

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: got ${actual}, expected ${expected} ±${tol}`);
const on = (gross, extra = {}) => P.calc({ date: '2026-09-15', prov: 'ON', P: 26, gross, ...extra });

test('CPP and EI match the CRA T4032-ON biweekly tables', () => {
  for (const [gross, cpp, ei] of [[1500, 81.24, 24.45], [2500, 140.74, 40.75], [4000, 229.99, 65.20]]) {
    const r = on(gross);
    assert.equal(r.employee.cpp, cpp, 'CPP at ' + gross);
    assert.equal(r.employee.ei, ei, 'EI at ' + gross);
    assert.equal(r.employer.cpp, cpp);
    assert.equal(r.employer.ei, P.r2(ei * 1.4));
  }
});

test('Federal and Ontario tax match the T4032-ON biweekly tables (claim code 1, range midpoints)', () => {
  near(on(1515).employee.fedTax, 100.50, 0.05, 'federal at 1,515');
  near(on(2503).employee.fedTax, 243.20, 0.05, 'federal at 2,503');
  near(on(1505).employee.provTax, 62.75, 0.05, 'Ontario at 1,505');
  near(on(2493).employee.provTax, 130.85, 0.05, 'Ontario at 2,493');
});

test('Quebec matches the CRA T4032QC worked example (weekly $1,300, RRSP $80)', () => {
  const r = P.calc({ date: '2026-09-15', prov: 'QC', P: 52, gross: 1300, rrsp: 80 });
  assert.equal(r.employee.qpp, 77.66);
  assert.equal(r.employee.qpip, 5.59);
  assert.equal(r.employee.ei, 16.90);
  assert.equal(r.employee.fedTax, 95.01);
  assert.equal(r.annualTaxable, 62798.84);
  assert.equal(r.employee.cpp, 0);
  assert.equal(r.employee.provTax, 0);
  assert.ok(r.employee.qcTax > 0);
  assert.ok(r.notes.some(n => /WebRAS/.test(n)), 'Quebec tax is flagged for checking');
  assert.equal(r.employer.qpip, P.r2(1300 * 0.00602));
  assert.equal(r.employer.hsf, P.r2(1300 * 0.0165));
});

test('CPP stops at the yearly maximum and CPP2 starts above the YMPE', () => {
  const capped = on(4000, { ytd: { cpp: 4200, pensionable: 70000 } });
  assert.equal(capped.employee.cpp, 30.45);
  assert.equal(capped.employee.cpp2, 0, 'still under the YMPE after this pay');
  const second = on(4000, { ytd: { cpp: 4230.45, pensionable: 74000 } });
  assert.equal(second.employee.cpp, 0);
  assert.equal(second.employee.cpp2, P.r2((78000 - 74600) * 0.04));
  const done = on(4000, { ytd: { cpp: 4230.45, cpp2: 416, pensionable: 90000, ei: 1123.07 } });
  assert.equal(done.employee.cpp2, 0);
  assert.equal(done.employee.ei, 0);
});

test('Exemptions, extra tax and TD1 claim amounts', () => {
  const r = on(2000, { cppExempt: true, eiExempt: true });
  assert.equal(r.employee.cpp, 0);
  assert.equal(r.employee.ei, 0);
  assert.equal(on(2000, { extraTax: 50 }).employee.fedTax, P.r2(on(2000).employee.fedTax + 50));
  assert.equal(on(600, { td1Fed: 0, td1Prov: 0 }).employee.fedTax > on(600).employee.fedTax, true, 'claim code 0 withholds more');
  assert.equal(on(300).employee.fedTax, 0, 'low pay has no federal tax');
});

test('Every province produces sensible deductions', () => {
  for (const prov of P.PROVINCES) {
    const r = P.calc({ date: '2026-10-30', prov, freq: 'semimonthly', gross: 3500 });
    const tax = r.employee.fedTax + r.employee.provTax + r.employee.qcTax;
    assert.ok(tax > 300 && tax < 1100, `${prov} total tax ${tax}`);
    const split = P.remitSplit(r.employee, r.employer);
    if (prov === 'QC') assert.ok(split.rq > 0 && split.cra > 0);
    else assert.equal(split.rq, 0);
  }
});

test('Refuses pay dates without loaded rates, and remittance due dates', () => {
  assert.throws(() => P.calc({ date: '2027-01-15', prov: 'ON', gross: 1000 }), /aren't loaded/);
  assert.equal(P.remittanceDue('2026-09-30'), '2026-10-15');
  assert.equal(P.remittanceDue('2026-12-31'), '2027-01-15');
});

// A full year of biweekly pays, calculated with year-to-date amounts so maximums are respected.
function yearOfPays(emp, gross, prov) {
  const runs = [];
  const ytd = { pensionable: 0, cpp: 0, cpp2: 0, qpp: 0, qpp2: 0, ei: 0, qpip: 0, erQpip: 0 };
  for (let i = 0; i < 26; i++) {
    const d = new Date(Date.UTC(2026, 0, 9 + 14 * i)).toISOString().slice(0, 10);
    const r = P.calc({ date: '2026-07-15', prov, P: 26, gross, ytd: { ...ytd } });
    for (const k of ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip']) ytd[k] = P.r2(ytd[k] + r.employee[k]);
    ytd.pensionable += gross; ytd.erQpip = P.r2(ytd.erQpip + r.employer.qpip);
    const ded = r.employee, er = r.employer;
    const net = P.r2(gross - Object.values(ded).reduce((s, v) => s + v, 0));
    runs.push({ payDate: d, lines: [{ employeeId: emp, prov, gross, rrsp: 0, union: 0, ded, er, net }] });
  }
  return runs;
}

test('T4 boxes add up the year, with the right caps and checks', () => {
  const runs = yearOfPays('e1', 3000, 'ON'); // $78,000 a year: over the YMPE, under the YAMPE
  const ye = P.yearEnd({ year: 2026, employees: [{ id: 'e1', name: 'Pat', prov: 'ON', sin: '130 692 544', dental: 3 }], payruns: runs,
    remittances: [{ agency: 'cra', period: '2026-03', amount: 1000 }, { agency: 'cra', period: '2025-12', amount: 999 }] });
  assert.equal(ye.due, '2027-03-01', 'Feb 28, 2027 is a Sunday');
  const t4 = ye.slips[0].t4;
  assert.equal(t4[14], 78000);
  assert.equal(t4[16], 4230.45, 'CPP reaches the maximum');
  assert.equal(t4['16A'], P.r2((78000 - 74600) * 0.04));
  assert.equal(t4[18], 1123.07, 'EI reaches the maximum');
  assert.equal(t4[24], 68900, 'box 24 is capped at the maximum insurable earnings');
  assert.equal(t4[26], 78000, 'box 26 is capped at the YAMPE, not the YMPE');
  assert.equal(t4[45], 3);
  assert.equal(t4[17], 0);
  assert.deepEqual(ye.slips[0].checks, [], 'deductions match what CRA expects');
  assert.equal(ye.t4sum[88], 1);
  assert.equal(ye.t4sum[27], t4[16], 'employer CPP matches the employee');
  assert.equal(ye.t4sum[19], P.r2(runs.reduce((s, r) => s + r.lines[0].er.ei, 0)));
  assert.equal(ye.t4sum[82], 1000, 'only this year’s remittances count');
  assert.equal(ye.t4sum[80], P.r2(ye.t4sum[16] + ye.t4sum['16A'] + ye.t4sum[27] + ye.t4sum['27A'] + ye.t4sum[18] + ye.t4sum[19] + ye.t4sum[22]));
  assert.equal(ye.t4sum[86], P.r2(ye.t4sum[80] - 1000));
});

test('Quebec employees get a T4 with QPP and PPIP boxes, and an RL-1', () => {
  const runs = yearOfPays('q1', 4500, 'QC'); // $117,000 a year
  const ye = P.yearEnd({ year: 2026, employees: [{ id: 'q1', name: 'Dominique', prov: 'QC', sin: '130692551', dental: 1 }], payruns: runs, remittances: [] });
  const { t4, rl1 } = ye.slips[0];
  assert.equal(t4[16], 0); assert.equal(t4[17], 4479.30); assert.equal(t4['17A'], 416);
  assert.equal(t4[18], 895.70); assert.equal(t4[55], 442.90); assert.equal(t4[56], 103000); assert.equal(t4[26], 85000);
  assert.equal(t4[22], P.r2(runs.reduce((s, r) => s + r.lines[0].ded.fedTax, 0)), 'box 22 is federal tax only in Quebec');
  assert.equal(rl1.A, 117000); assert.equal(rl1['B.A'], 4479.30); assert.equal(rl1['B.B'], 416); assert.equal(rl1.G, 85000);
  assert.equal(rl1.H, 442.90); assert.equal(rl1.I, 103000); assert.equal(rl1.C, 895.70);
  assert.equal(rl1.E, P.r2(runs.reduce((s, r) => s + r.lines[0].ded.qcTax, 0)));
  assert.equal(ye.t4sum[27], 0, 'employer QPP goes to Revenu Québec, not box 27');
  const s = ye.rl1sum;
  assert.equal(s.payroll, 117000); assert.equal(s.hsfRate, 1.65); assert.equal(s.hsf, P.r2(117000 * 0.0165));
  assert.equal(s.cntBase, 103000, 'labour standards stop at the maximum per employee'); assert.equal(s.cnt, 61.8);
  assert.equal(s.qpipEmployer, 620.06);
  assert.deepEqual(ye.slips[0].checks, []);
});

test('Year-end checks: SIN, a province change and under-deducted EI', () => {
  const runs = [
    { payDate: '2026-03-06', lines: [{ employeeId: 'e2', prov: 'AB', gross: 2000, ded: { cpp: 110.99, ei: 10 }, er: { cpp: 110.99, ei: 14 } }] },
    { payDate: '2026-09-04', lines: [{ employeeId: 'e2', prov: 'BC', gross: 2000, ded: { cpp: 110.99, ei: 32.6 }, er: { cpp: 110.99, ei: 45.64 } }] },
  ];
  const ye = P.yearEnd({ year: 2026, employees: [{ id: 'e2', name: 'Lee', prov: 'BC', sin: '123' }], payruns: runs });
  assert.deepEqual(ye.slips.map(s => s.prov), ['AB', 'BC'], 'one T4 per province');
  const [ab, bc] = ye.slips;
  assert.ok(ab.checks.some(c => c.code === 'sin-invalid'));
  assert.ok(ab.checks.some(c => c.code === 'dental'), 'box 45 has to be chosen');
  assert.ok(!ab.checks.some(c => c.code === 'ei'), 'deduction checks cover all of an employee’s slips, on the last one');
  assert.ok(bc.checks.some(c => c.code === 'ei' && c.want === 65.2 && c.got === 42.6 && c.many));
  assert.equal(P.sinProblem(''), 'missing');
  assert.equal(P.hsfRateFor(3000000), 2.4176);
  assert.throws(() => P.yearEnd({ year: 2030, employees: [], payruns: [] }), /aren't loaded/);
});

const line = (employeeId, prov, gross, extra = {}) => ({ employeeId, prov, gross, rrsp: 0, union: 0, ded: {}, er: {}, ...extra });

test('Moving provinces: yearly maximums are shared across the employee’s slips, in date order', () => {
  const runs = [
    { payDate: '2026-03-31', lines: [line('m', 'ON', 60000)] },
    { payDate: '2026-10-30', lines: [line('m', 'QC', 40000)] },
  ];
  const ye = P.yearEnd({ year: 2026, employees: [{ id: 'm', name: 'Sam', prov: 'QC', sin: '130692544', dental: 1 }], payruns: runs });
  const [on, qc] = ye.slips;
  assert.equal(on.t4[24], 60000); assert.equal(on.t4[26], 60000);
  assert.equal(qc.t4[24], 8900, '68,900 − 60,000 already reported on the Ontario slip');
  assert.equal(qc.t4[26], 25000, '85,000 − 60,000');
  assert.equal(qc.t4[56], 40000, 'QPIP only counts Quebec earnings');
  assert.equal(qc.rl1.G, 14600, 'no QPP2 deducted, so G stops at the YMPE (74,600 − 60,000)');
  assert.ok(qc.checks.some(c => c.code === 'cpp2'), 'CPP2/QPP2 was owed on 60,000 to 85,000 and nothing was deducted');
});

test('Exemptions come from each pay, and box 28 only for a full year', () => {
  const runs = [
    { payDate: '2026-02-27', lines: [line('x', 'ON', 5000, { cppExempt: true })] },
    { payDate: '2026-06-30', lines: [line('x', 'ON', 5000, { cppExempt: false, ded: { cpp: 286.70 } })] },
  ];
  const emp = { id: 'x', name: 'Ari', prov: 'ON', sin: '130692544', dental: 1, cppExempt: false, eiExempt: true };
  const ye = P.yearEnd({ year: 2026, employees: [emp], payruns: runs });
  const t4 = ye.slips[0].t4;
  assert.equal(t4[26], 5000, 'only the pay CPP applied to is pensionable');
  assert.equal(t4[28].cppQpp, false, 'part-year exemption is not box 28');
  assert.equal(t4[28].ei, true, 'old pay lines without flags use the employee setting'); assert.equal(t4[24], 0);
  const full = P.yearEnd({ year: 2026, employees: [{ ...emp, cppExempt: true }], payruns: [{ payDate: '2026-02-27', lines: [line('x', 'ON', 5000, { cppExempt: true })] }] });
  assert.equal(full.slips[0].t4[28].cppQpp, true); assert.equal(full.slips[0].t4[26], 0);
});

test('Registered pension plans need the PA (box 52) and registration number (box 50)', () => {
  const runs = [{ payDate: '2026-05-15', lines: [line('r', 'ON', 4000, { rrsp: 200 })] }];
  const emp = { id: 'r', name: 'Kim', prov: 'ON', sin: '130692544', dental: 2, pensionType: 'rpp' };
  const bad = P.yearEnd({ year: 2026, employees: [emp], payruns: runs }).slips[0];
  assert.equal(bad.t4[20], 200);
  assert.ok(bad.checks.some(c => c.code === 'rpp-pa' && c.level === 'error'));
  assert.ok(bad.checks.some(c => c.code === 'rpp-no' && c.level === 'error'));
  const ye = P.yearEnd({ year: 2026, employees: [{ ...emp, rppNo: '1234567', paByYear: { 2026: 3100 } }], payruns: runs });
  assert.equal(ye.slips[0].t4[52], 3100); assert.equal(ye.slips[0].t4[50], '1234567'); assert.equal(ye.t4sum[52], 3100);
  assert.ok(!ye.slips[0].checks.some(c => /^rpp/.test(c.code)));
});

test('Health Services Fund rate comes from total payroll, applied to Quebec payroll', () => {
  const runs = [{ payDate: '2026-12-15', lines: [line('o', 'ON', 900000), line('q', 'QC', 200000)] }];
  const emps = [{ id: 'o', name: 'O', prov: 'ON', dental: 1 }, { id: 'q', name: 'Q', prov: 'QC', dental: 1 }];
  const R = P.yearEnd({ year: 2026, employees: emps, payruns: runs }).rl1sum;
  assert.equal(R.payroll, 200000); assert.equal(R.totalPayroll, 1100000);
  assert.equal(R.hsfRate, P.hsfRateFor(1100000)); assert.ok(R.hsfRate > 1.65);
  assert.equal(R.hsf, P.r2(200000 * R.hsfRate / 100));
  const withAssoc = P.yearEnd({ year: 2026, employees: emps, payruns: runs, assocPayroll: 2000000 }).rl1sum;
  assert.equal(withAssoc.hsfRate, P.hsfRateFor(3100000));
});

test('Earlier payroll: its own province, RRSP/RPP, union dues, a real zero and employer EI', () => {
  const emp = { id: 'p', name: 'Pat', prov: 'QC', sin: '000 000 000', dental: 1, pensionType: 'rpp', rppNo: '7654321', paByYear: { 2026: 900 },
    openingYtd: { year: 2026, prov: 'ON', gross: 20000, pensionable: 0, rrsp: 500, union: 120, ei: 326, erEi: 400, cpp: 0 } };
  const runs = [{ payDate: '2026-11-13', lines: [line('p', 'QC', 3000)] }];
  const ye = P.yearEnd({ year: 2026, employees: [emp], payruns: runs, remittances: [{ agency: 'cra', period: '2026-05', amount: 0 }] });
  const on = ye.slips.find(s => s.prov === 'ON');
  assert.ok(on, 'earlier payroll goes on the province it was earned in');
  assert.equal(on.t4[26], 0, 'a pensionable amount of 0 stays 0'); assert.equal(on.t4[20], 500); assert.equal(on.t4[44], 120);
  assert.equal(on.er.ei, 400);
  assert.ok(on.checks.some(c => c.code === 'sin-none' && c.level === 'warn'), '000 000 000 can still be filed');
});

test('A difference of $2 or less is neither owed nor refunded', () => {
  const runs = [{ payDate: '2026-04-15', lines: [line('d', 'ON', 1000, { ded: { fedTax: 100 } })] }];
  const emps = [{ id: 'd', name: 'D', prov: 'ON', dental: 1 }];
  const s1 = P.yearEnd({ year: 2026, employees: emps, payruns: runs, remittances: [{ agency: 'cra', period: '2026-04', amount: 98.5 }] }).t4sum;
  assert.equal(s1[86], 0); assert.equal(s1.difference, 1.5);
  const s2 = P.yearEnd({ year: 2026, employees: emps, payruns: runs, remittances: [{ agency: 'cra', period: '2026-04', amount: 97 }] }).t4sum;
  assert.equal(s2[86], 3);
  assert.equal(P.sinProblem('000000000'), 'none');
});

/* ---------- stage 3: holidays, vacation pay, ROE ---------- */
test('Public holidays by province, with Easter and Monday rules', () => {
  const on = P.holidays('ON', 2026).map(h => h.date + ' ' + h.key);
  assert.deepEqual(on, ['2026-01-01 newyear', '2026-02-16 family', '2026-04-03 goodfriday', '2026-05-18 victoria', '2026-07-01 canada',
    '2026-09-07 labour', '2026-10-12 thanksgiving', '2026-12-25 christmas', '2026-12-26 boxing']);
  const qc = P.holidays('QC', 2027).map(h => h.date);
  assert.deepEqual(qc, ['2027-01-01', '2027-03-26', '2027-05-24', '2027-06-24', '2027-07-01', '2027-09-06', '2027-10-11', '2027-12-25']);
  assert.equal(P.holidays('QC', 2029).find(h => h.key === 'canadaQc').date, '2029-07-02', 'July 1 on a Sunday moves to the 2nd in Quebec');
  assert.equal(P.holidays('BC', 2026).length, 11);
  assert.ok(P.holidays('BC', 2026).some(h => h.date === '2026-09-30'));
  assert.ok(!P.holidays('ON', 2026).some(h => h.date === '2026-09-30'));
  assert.equal(P.holidays('ON', 2025).find(h => h.key === 'goodfriday').date, '2025-04-18');
  assert.deepEqual(P.holidaysBetween('ON', '2026-12-20', '2027-01-02').map(h => h.date), ['2026-12-25', '2026-12-26', '2027-01-01']);
});

test('Holiday pay is 1/20 of the 4 weeks before the holiday’s week, spread across pay periods', () => {
  // Thanksgiving, Monday Oct 12 2026: its week starts Sunday Oct 11, so the window is Sep 13 – Oct 10.
  assert.deepEqual(P.holidayWindow('2026-10-12'), { from: '2026-09-13', to: '2026-10-10' });
  const r = P.holidayPay('2026-10-12', [
    { from: '2026-08-30', to: '2026-09-12', amount: 1400 }, // before the window
    { from: '2026-09-13', to: '2026-09-26', amount: 1400 },
    { from: '2026-09-27', to: '2026-10-10', amount: 1200 },
    { from: '2026-10-04', to: '2026-10-17', amount: 1400 }, // overlaps: 7 of 14 days
  ]);
  assert.equal(r.base, 1400 + 1200 + 700);
  assert.equal(r.pay, 165);
});

test('Vacation pay minimums follow years of service', () => {
  assert.equal(P.vacationRate('ON', '2022-03-01', '2027-02-28').rate, 4);
  assert.equal(P.vacationRate('ON', '2022-03-01', '2027-03-01').rate, 6);
  assert.equal(P.vacationRate('QC', '2023-06-01', '2026-06-01').rate, 6, 'Quebec: 6% after 3 years');
  assert.equal(P.vacationRate('SK', '', '2026-06-01').rate, 5.77);
  const ns = P.vacationRate('NS', '2010-01-01', '2026-06-01');
  assert.equal(ns.rate, 4); assert.equal(ns.known, false);
  assert.equal(P.serviceYears('2020-02-29', '2021-02-28'), 0);
});

test('ROE: insurable earnings and hours by pay period, newest first, vacation pay on leaving in 17A', () => {
  const lines = [
    { from: '2026-08-02', to: '2026-08-15', payDate: '2026-08-21', insurable: 2000, hours: 80 },
    // nothing paid for Aug 16 – 29
    { from: '2026-08-30', to: '2026-09-12', payDate: '2026-09-18', insurable: 2100, hours: 84 },
    { from: '2026-09-13', to: '2026-09-26', payDate: '2026-10-02', insurable: 2500, hours: 80, separationVac: 400 },
  ];
  const r = P.roe({ freq: 'biweekly', finalPeriodEnd: '2026-09-26', lines });
  assert.equal(r.type, 'B'); assert.equal(r.count, 27); assert.equal(r.periods.length, 27);
  assert.deepEqual(r.periods.slice(0, 4).map(p => [p.n, p.to, p.amount]), [[1, '2026-09-26', 2100], [2, '2026-09-12', 2100], [3, '2026-08-29', 0], [4, '2026-08-15', 2000]]);
  assert.equal(r.totalEarnings, 6200); assert.equal(r.hours, 244); assert.equal(r.vacation, 400);
  assert.equal(r.due, '2026-10-01');
  assert.equal(P.roe({ freq: 'monthly', finalPeriodEnd: '2026-08-31', lines }).outside, 2);
  assert.equal(P.roe({ freq: 'semimonthly', finalPeriodEnd: '2026-09-30', lines: [] }).count, 25);
});
