'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
/*
 * Payroll checked against CRA's own published numbers (2026, Ontario).
 *
 * Sources:
 *   - T4127 Payroll Deductions Formulas, 123rd edition (July 1, 2026), Table 8.1: federal and provincial
 *     rates, thresholds and constants, and Table 8.2 basic personal amounts. Checked against TABLES below.
 *   - T4032-ON (January 1, 2026; Ontario and federal amounts are unchanged for July 2026):
 *       * the two step-by-step worked examples (weekly $1,300 with RRSP; weekly $1,600 above the YMPE),
 *       * the weekly lookup example (Sara, $615),
 *       * the CPP/CPP2 schedule example (biweekly $3,500),
 *       * biweekly federal and Ontario tax table rows, claim codes 0 and 1.
 *
 * About the tax tables: CRA builds them as if the pay were earned all year, so above the YMPE
 * (about $2,869 biweekly) they assume a full year of CPP2 and of the enhanced CPP deduction. The T4127
 * formulas (and PDOC) use what is actually deducted on the pay, which is what Sumlora does — see
 * worked example 2 — so table rows are only compared below the YMPE.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/payroll-calc.js');

const DATE = '2026-09-15';
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol + 1e-9, `${msg}: got ${actual}, expected ${expected} ±${tol}`);

test('Rate table matches T4127 (July 2026) Table 8.1 and 8.2', () => {
  const t = P.tableFor(DATE);
  assert.deepEqual(t.fed.A, [0, 58523, 117045, 181440, 258482]);
  assert.deepEqual(t.fed.R, [0.14, 0.205, 0.26, 0.29, 0.33]);
  assert.deepEqual(t.fed.K, [0, 3804, 10241, 15685, 26024]);
  assert.equal(t.fed.cea, 1501);
  assert.equal(t.fed.bpaMax, 16452);
  const on = t.prov.ON;
  assert.deepEqual(on.A, [0, 53891, 107785, 150000, 220000]);
  assert.deepEqual(on.V, [0.0505, 0.0915, 0.1116, 0.1216, 0.1316]);
  assert.deepEqual(on.K, [0, 2210, 4376, 5876, 8076]);
  assert.equal(on.bpa, 12989);
  assert.deepEqual(on.surtax, [[5818, 0.20], [7446, 0.36]]);
  assert.equal(on.reduction.base, 300);
  // Every other province's brackets, rates and constants (T4127 Table 8.1, July 2026).
  const want = {
    AB: [[0, 61200, 154259, 185111, 246813, 370220], [.08, .10, .12, .13, .14, .15], [0, 1224, 4309, 6160, 8628, 12331], 22769],
    BC: [[0, 50363, 100728, 115648, 140430, 190405, 265545], [.0614, .077, .105, .1229, .147, .168, .205], [0, 786, 3606, 5676, 9061, 13059, 22884], 13216],
    MB: [[0, 47000, 100000], [.108, .1275, .174], [0, 917, 5567], undefined],
    NB: [[0, 52333, 104666, 193861], [.094, .14, .16, .195], [0, 2407, 4501, 11286], 13664],
    NL: [[0, 44678, 89354, 159528, 223340, 285319, 570638, 1141275], [.087, .145, .158, .178, .198, .208, .213, .218], [0, 2591, 3753, 6943, 11410, 14263, 17117, 22823], 15000],
    NS: [[0, 30995, 61991, 97417, 157124], [.0879, .1495, .1667, .175, .21], [0, 1909, 2976, 3784, 9283], 11932],
    NT: [[0, 53003, 106009, 172346], [.059, .086, .122, .1405], [0, 1431, 5247, 8436], 18198],
    NU: [[0, 55801, 111602, 181439], [.04, .07, .09, .115], [0, 1674, 3906, 8442], 19659],
    PE: [[0, 33928, 65820, 106890, 142520, 200000], [.095, .1347, .166, .1762, .19, .21], [0, 1347, 3407, 4497, 6464, 10464], 15000],
    SK: [[0, 54532, 155805], [.105, .125, .145], [0, 1091, 4207], 20381],
    YT: [[0, 58523, 117045, 181440, 500000], [.064, .09, .109, .128, .15], [0, 1522, 3745, 7193, 18193], undefined],
  };
  for (const [prov, [A, V, K, bpa]] of Object.entries(want)) {
    assert.deepEqual(t.prov[prov].A, A, prov + ' thresholds');
    assert.deepEqual(t.prov[prov].V, V, prov + ' rates');
    assert.deepEqual(t.prov[prov].K, K, prov + ' constants');
    if (bpa !== undefined) assert.equal(t.prov[prov].bpa, bpa, prov + ' basic personal amount');
  }
});

test('T4032-ON worked example 1: weekly $1,300, RRSP $80, below the YMPE', () => {
  const r = P.calc({ date: DATE, prov: 'ON', P: 52, gross: 1300, rrsp: 80 });
  assert.equal(r.employee.cpp, 73.35);
  assert.equal(r.employee.cpp2, 0);
  assert.equal(r.employee.ei, 21.19);
  assert.equal(r.annualTaxable, 62798.84);
  assert.equal(r.employee.fedTax, 114.57);  // 5,957.85 / 52
  assert.equal(r.employee.provTax, 62.77);  // 3,264.26 / 52 (health premium $600)
  near(r.employee.fedTax + r.employee.provTax, 177.35, 0.01, 'total tax (CRA rounds the combined amount)');
});

test('T4032-ON worked example 2: weekly $1,600 after the CPP and EI maximums', () => {
  const r = P.calc({ date: DATE, prov: 'ON', P: 52, gross: 1600,
    ytd: { cpp: 4230.45, ei: 1123.07, cpp2: 24, pensionable: 75200 } });
  assert.equal(r.employee.cpp, 0);
  assert.equal(r.employee.ei, 0);
  assert.equal(r.employee.cpp2, 64);
  assert.equal(r.annualTaxable, 79872);
  // CRA uses the annual maximum CPP and EI credits once the maximums are reached.
  assert.equal(r.employee.fedTax, 180.89);  // 9,406.39 / 52
  assert.equal(r.employee.provTax, 95.34);  // 4,957.90 / 52 (health premium $750)
});

test('Credits use the annual maximum from the pay that reaches it', () => {
  // Pay 22 of the biweekly $3,500 example reaches the CPP maximum part way through the pay.
  const before = { cpp: 4205.04, ei: 1100, pensionable: 73500 };
  const r = P.calc({ date: DATE, prov: 'ON', P: 26, gross: 3500, ytd: before });
  assert.equal(r.employee.cpp, 25.41);
  assert.equal(r.employee.ei, 23.07);
  const capped = P.calc({ date: DATE, prov: 'ON', P: 26, gross: 3500,
    ytd: { cpp: 4230.45, ei: 1123.07, pensionable: 77000, cpp2: 96 } });
  // Same credits whether the maximum was reached on this pay or an earlier one; the only difference
  // in tax comes from CPP2 and the enhanced CPP deduction (F5A), not from the credits.
  const credits = x => x.employee.fedTax + x.employee.provTax;
  assert.ok(Math.abs(credits(r) - credits(capped)) < 15, `tax ${credits(r)} vs ${credits(capped)}`);
  // An exempt employee gets no credit at all.
  const exempt = P.calc({ date: DATE, prov: 'ON', P: 26, gross: 3500, cppExempt: true, eiExempt: true });
  assert.ok(exempt.employee.fedTax > P.calc({ date: DATE, prov: 'ON', P: 26, gross: 3500 }).employee.fedTax);
});

test('T4032-ON lookup example: weekly $615 (range $614–$618), claim code 1', () => {
  const r = P.calc({ date: DATE, prov: 'ON', P: 52, gross: 616 });
  near(r.employee.fedTax, 31.95, 0.05, 'federal');
  near(P.calc({ date: DATE, prov: 'ON', P: 52, gross: 615 }).employee.provTax, 22.05, 0.05, 'Ontario');
});

test('T4032-ON CPP/CPP2 schedule example: biweekly $3,500 for a full year', () => {
  let ytd = { cpp: 0, cpp2: 0, ei: 0, pensionable: 0 };
  const rows = [];
  for (let n = 1; n <= 26; n++) {
    const r = P.calc({ date: DATE, prov: 'ON', P: 26, gross: 3500, ytd });
    rows.push(r.employee);
    ytd = { cpp: P.r2(ytd.cpp + r.employee.cpp), cpp2: P.r2(ytd.cpp2 + r.employee.cpp2), ei: P.r2(ytd.ei + r.employee.ei), pensionable: ytd.pensionable + 3500 };
  }
  assert.ok(rows.slice(0, 21).every(e => e.cpp > 0 && e.cpp2 === 0), 'pays 1–21: CPP only');
  assert.ok(rows[21].cpp > 0 && rows[21].cpp2 === P.r2(2400 * 0.04), 'pay 22: CPP to the maximum, CPP2 on $2,400');
  assert.equal(rows[22].cpp2, 140, 'pay 23: CPP2 on $3,500');
  assert.equal(rows[25].cpp2, 0, 'CPP2 maximum reached before pay 26');
  assert.equal(ytd.cpp, 4230.45);
  assert.equal(ytd.cpp2, 416);
  assert.equal(ytd.ei, 1123.07);
});

test('T4032-ON biweekly tax table rows below the YMPE (range midpoints, claim codes 0 and 1)', () => {
  const fed = [[899, 903, 109.60, 21.05], [1195, 1203, 148.20, 59.60]];
  const ont = [[897, 901, 49.70, 18.50], [1193, 1201, 67.80, 42.60]];
  const run = (gross, cc0) => P.calc({ date: DATE, prov: 'ON', P: 26, gross, ...(cc0 ? { td1Fed: 0, td1Prov: 0 } : {}) }).employee;
  for (const [from, to, cc0, cc1] of fed) {
    const mid = (from + to) / 2;
    near(run(mid, true).fedTax, cc0, 0.05, `federal claim code 0 at ${mid}`);
    near(run(mid, false).fedTax, cc1, 0.05, `federal claim code 1 at ${mid}`);
  }
  for (const [from, to, cc0, cc1] of ont) {
    const mid = (from + to) / 2;
    near(run(mid, true).provTax, cc0, 0.05, `Ontario claim code 0 at ${mid}`);
    near(run(mid, false).provTax, cc1, 0.05, `Ontario claim code 1 at ${mid}`);
  }
});

test('Above the YMPE the per-pay formula differs from the tables, as T4127 intends', () => {
  // Table row $2,995–$3,019 (CC 0) assumes a full year of CPP2; a first pay of the year has none,
  // so the formula withholds a little more. Over the year the CPP2 pays bring it back.
  const r = P.calc({ date: DATE, prov: 'ON', P: 26, gross: 3007, td1Fed: 0, td1Prov: 0 }).employee;
  near(r.fedTax, 430.30, 1.0, 'federal within $1 of the table');
});

test('Tax never goes down when pay goes up (Ontario, biweekly)', () => {
  let last = -1;
  for (let g = 0; g <= 20000; g += 37) {
    const e = P.calc({ date: DATE, prov: 'ON', P: 26, gross: g }).employee;
    const tax = e.fedTax + e.provTax;
    assert.ok(tax >= last - 0.01, `tax dropped at ${g}: ${tax} < ${last}`);
    last = tax;
  }
});
