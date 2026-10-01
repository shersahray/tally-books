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
  const ye = P.yearEnd({ year: 2026, employees: [{ id: 'q1', name: 'Dominique', prov: 'QC', sin: '130692551' }], payruns: runs, remittances: [] });
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
  const ab = ye.slips[0];
  assert.ok(ab.checks.some(c => c.code === 'sin-invalid'));
  assert.ok(ab.checks.some(c => c.code === 'ei' && c.want === 32.6 && c.got === 10));
  assert.equal(P.sinProblem(''), 'missing');
  assert.equal(P.hsfRateFor(3000000), 2.4176);
  assert.throws(() => P.yearEnd({ year: 2030, employees: [], payruns: [] }), /aren't loaded/);
});
