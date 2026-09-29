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
