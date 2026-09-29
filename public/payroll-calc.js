/*
 * Tally Books payroll calculator.
 *
 * Works in the browser (window.TallyPayroll) and in Node (require) so the tests can check it.
 *
 * Rates: pay dates from 1 July to 31 December 2026.
 *   - Federal, provincial (outside Quebec), CPP, CPP2, EI: CRA T4127 "Payroll Deductions Formulas",
 *     123rd edition, effective July 1, 2026 (Option 1, annualized tax on regular pay).
 *   - QPP, QPP2, QPIP, Quebec EI rate: Revenu Québec / Retraite Québec 2026 rates.
 *   - Quebec income tax: Revenu Québec TP-1015.F method (annualized). Not yet checked line by line
 *     against WebRAS, so the result carries a "check" note.
 * Every amount this returns is a suggestion; the pay-run screen lets the user override any of them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyPayroll = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const trunc2 = n => Math.floor(n * 100 + 1e-7) / 100;
  const pos = n => (n > 0 ? n : 0);

  const Y2026H2 = {
    label: 'July–December 2026',
    from: '2026-07-01', to: '2026-12-31',
    cpp: { ympe: 74600, exemption: 3500, rate: 0.0595, baseRate: 0.0495, max: 4230.45, baseMaxCredit: 3519.45 },
    qpp: { ympe: 74600, exemption: 3500, rate: 0.063, baseRate: 0.053, max: 4479.30, baseMaxCredit: 3768.30 },
    cpp2: { yampe: 85000, rate: 0.04, max: 416 },
    ei: { mie: 68900, rate: 0.0163, max: 1123.07, qcRate: 0.013, qcMax: 895.70, employer: 1.4 },
    qpip: { mie: 103000, rate: 0.0043, max: 442.90, erRate: 0.00602, erMax: 620.06 },
    fed: {
      A: [0, 58523, 117045, 181440, 258482],
      R: [0.14, 0.205, 0.26, 0.29, 0.33],
      K: [0, 3804, 10241, 15685, 26024],
      bpaMax: 16452, bpaMin: 14829, cea: 1501, qcAbatement: 0.165
    },
    prov: {
      AB: { A: [0, 61200, 154259, 185111, 246813, 370220], V: [.08, .10, .12, .13, .14, .15], K: [0, 1224, 4309, 6160, 8628, 12331], bpa: 22769, k5pThreshold: 4896, k5pRate: 0.25 },
      BC: { A: [0, 50363, 100728, 115648, 140430, 190405, 265545], V: [.0614, .077, .105, .1229, .147, .168, .205], K: [0, 786, 3606, 5676, 9061, 13059, 22884], bpa: 13216 },
      MB: { A: [0, 47000, 100000], V: [.108, .1275, .174], K: [0, 917, 5567], bpa: 15780, bpaPhaseOut: [200000, 400000] },
      NB: { A: [0, 52333, 104666, 193861], V: [.094, .14, .16, .195], K: [0, 2407, 4501, 11286], bpa: 13664 },
      NL: { A: [0, 44678, 89354, 159528, 223340, 285319, 570638, 1141275], V: [.087, .145, .158, .178, .198, .208, .213, .218], K: [0, 2591, 3753, 6943, 11410, 14263, 17117, 22823], bpa: 15000 },
      NS: { A: [0, 30995, 61991, 97417, 157124], V: [.0879, .1495, .1667, .175, .21], K: [0, 1909, 2976, 3784, 9283], bpa: 11932 },
      NT: { A: [0, 53003, 106009, 172346], V: [.059, .086, .122, .1405], K: [0, 1431, 5247, 8436], bpa: 18198 },
      NU: { A: [0, 55801, 111602, 181439], V: [.04, .07, .09, .115], K: [0, 1674, 3906, 8442], bpa: 19659 },
      ON: { A: [0, 53891, 107785, 150000, 220000], V: [.0505, .0915, .1116, .1216, .1316], K: [0, 2210, 4376, 5876, 8076], bpa: 12989,
        surtax: [[5818, 0.20], [7446, 0.36]], reduction: { base: 300, perDependant: 554 } },
      PE: { A: [0, 33928, 65820, 106890, 142520, 200000], V: [.095, .1347, .166, .1762, .19, .21], K: [0, 1347, 3407, 4497, 6464, 10464], bpa: 15000 },
      SK: { A: [0, 54532, 155805], V: [.105, .125, .145], K: [0, 1091, 4207], bpa: 20381 },
      YT: { A: [0, 58523, 117045, 181440, 500000], V: [.064, .09, .109, .128, .15], K: [0, 1522, 3745, 7193, 18193], bpa: null /* = federal BPA */, ceaRate: 0.064 }
    },
    qc: {
      A: [0, 54345, 108680, 132245], T: [.14, .19, .24, .2575], K: [0, 2717.25, 8151.25, 10465.54],
      bpa: 18952, creditRate: 0.14, employmentDeduction: { rate: 0.06, max: 1450 }
    }
  };

  const TABLES = [Y2026H2];
  const FREQUENCIES = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
  const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Monthly' };
  const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

  function tableFor(date) {
    return TABLES.find(t => date >= t.from && date <= t.to) || null;
  }

  // Pick the bracket for annual income A: returns {rate, k}.
  function bracket(A, thresholds, rates, ks) {
    let i = 0;
    for (let j = 0; j < thresholds.length; j++) if (A > thresholds[j]) i = j;
    return { rate: rates[i], k: ks[i] };
  }

  function federalBpa(t, NI) {
    const f = t.fed;
    const lo = f.A[3], hi = f.A[4];
    if (NI <= lo) return f.bpaMax;
    if (NI >= hi) return f.bpaMin;
    return f.bpaMax - (NI - lo) * (f.bpaMax - f.bpaMin) / (hi - lo);
  }

  function ontarioHealthPremium(A) {
    if (A <= 20000) return 0;
    if (A <= 36000) return Math.min(300, 0.06 * (A - 20000));
    if (A <= 48000) return Math.min(450, 300 + 0.06 * (A - 36000));
    if (A <= 72000) return Math.min(600, 450 + 0.25 * (A - 48000));
    if (A <= 200000) return Math.min(750, 600 + 0.25 * (A - 72000));
    return Math.min(900, 750 + 0.25 * (A - 200000));
  }

  const num = v => (v === undefined || v === null || v === '' || isNaN(+v) ? 0 : +v);
  const optNum = v => (v === undefined || v === null || v === '' || isNaN(+v) ? null : +v);

  /*
   * calc(input) → deductions for one pay.
   * input: {
   *   date: 'YYYY-MM-DD' (pay date), prov: 'ON' | 'QC' | …, P: pay periods per year (or freq: 'biweekly'),
   *   gross: taxable earnings this pay, pensionable, insurable (default = gross),
   *   rrsp: RRSP/RPP deducted at source this pay, union: union dues this pay,
   *   td1Fed, td1Prov: TD1 total claim amounts (blank = basic personal amount), td1Qc (TP-1015.3, blank = basic),
   *   dependants: Ontario tax reduction dependants (default 0),
   *   extraTax: additional federal tax requested (TD1), extraQcTax: additional Quebec tax (TP-1015.3),
   *   cppExempt, eiExempt, qpipExempt: true when not deducted,
   *   ytd: { pensionable, cpp, cpp2, qpp, qpp2, ei, qpip, erQpip } before this pay,
   *   hsfRate: Quebec Health Services Fund employer rate in % (default 1.65)
   * }
   */
  function calc(input) {
    const t = tableFor(input.date || '');
    if (!t) {
      const err = new Error(`Payroll rates for ${input.date || 'that date'} aren't loaded yet. This version has ${TABLES.map(x => x.label).join(', ')}.`);
      err.code = 'NO_RATES';
      throw err;
    }
    const prov = String(input.prov || 'ON').toUpperCase();
    if (!PROVINCES.includes(prov)) throw new Error('Unknown province of employment: ' + prov);
    const qc = prov === 'QC';
    const P = input.P || FREQUENCIES[input.freq] || 26;
    const gross = r2(num(input.gross));
    const PI = input.pensionable == null ? gross : r2(num(input.pensionable));
    const IE = input.insurable == null ? gross : r2(num(input.insurable));
    const F = r2(num(input.rrsp));
    const U1 = r2(num(input.union));
    const ytd = input.ytd || {};
    const notes = [];

    // ---- CPP / QPP (first and second additional) ----
    const pp = qc ? t.qpp : t.cpp;
    const exemption = trunc2(pp.exemption / P);
    let C = 0, C2 = 0;
    if (!input.cppExempt) {
      C = r2(Math.max(0, Math.min(pp.max - num(qc ? ytd.qpp : ytd.cpp), pp.rate * (PI - exemption))));
      const piYtd = num(ytd.pensionable);
      const W = Math.max(piYtd, pp.ympe);
      const upper = Math.min(piYtd + PI, t.cpp2.yampe);
      C2 = r2(Math.max(0, Math.min(t.cpp2.max - num(qc ? ytd.qpp2 : ytd.cpp2), (upper - W) * t.cpp2.rate)));
    }

    // ---- EI and QPIP ----
    const eiRate = qc ? t.ei.qcRate : t.ei.rate;
    const eiMax = qc ? t.ei.qcMax : t.ei.max;
    const EI = input.eiExempt ? 0 : r2(Math.max(0, Math.min(eiMax - num(ytd.ei), eiRate * IE)));
    let QPIP = 0, erQPIP = 0;
    if (qc && !input.qpipExempt) {
      QPIP = r2(Math.max(0, Math.min(t.qpip.max - num(ytd.qpip), t.qpip.rate * IE)));
      erQPIP = r2(Math.max(0, Math.min(t.qpip.erMax - num(ytd.erQpip), t.qpip.erRate * IE)));
    }

    // ---- Federal income tax ----
    const F5 = r2(C * ((qc ? t.qpp.rate - t.qpp.baseRate : t.cpp.rate - t.cpp.baseRate) / pp.rate) + C2);
    const A = pos(P * (gross - F - F5 - U1));
    const fb = bracket(A, t.fed.A, t.fed.R, t.fed.K);
    const lowFed = t.fed.R[0];
    const tdFed = optNum(input.td1Fed);
    const K1 = lowFed * (tdFed == null ? federalBpa(t, A) : tdFed);
    const cppCredit = Math.min(P * C * (pp.baseRate / pp.rate), pp.baseMaxCredit);
    const eiCredit = Math.min(P * EI, eiMax);
    const qpipCredit = qc ? Math.min(P * QPIP, t.qpip.max) : 0;
    const K2 = lowFed * (cppCredit + eiCredit + qpipCredit);
    const K4 = Math.min(lowFed * A, lowFed * t.fed.cea);
    const T3 = pos(fb.rate * A - fb.k - K1 - K2 - K4);
    const T1 = qc ? T3 - t.fed.qcAbatement * T3 : T3;
    const fedTax = r2(T1 / P + num(input.extraTax));

    // ---- Provincial income tax (outside Quebec) ----
    let provTax = 0, qcTax = 0;
    if (!qc) {
      const p = t.prov[prov];
      const pb = bracket(A, p.A, p.V, p.K);
      const low = p.V[0];
      let bpa = p.bpa == null ? federalBpa(t, A) : p.bpa;
      if (p.bpaPhaseOut) {
        const [lo, hi] = p.bpaPhaseOut;
        if (A >= hi) bpa = 0; else if (A > lo) bpa = p.bpa * (1 - (A - lo) / (hi - lo));
      }
      const tdProv = optNum(input.td1Prov);
      const K1P = low * (tdProv == null ? bpa : tdProv);
      const K2P = low * (cppCredit + eiCredit);
      const K4P = p.ceaRate ? Math.min(p.ceaRate * A, p.ceaRate * t.fed.cea) : 0;
      const K5P = p.k5pThreshold ? pos((K1P + K2P - p.k5pThreshold) * p.k5pRate) : 0;
      const T4 = pos(pb.rate * A - pb.k - K1P - K2P - K4P - K5P);
      let T2 = T4;
      if (prov === 'ON') {
        let V1 = 0;
        for (const [over, rate] of p.surtax) V1 += rate * pos(T4 - over);
        const V2 = ontarioHealthPremium(A);
        const Y = p.reduction.perDependant * num(input.dependants);
        const S = pos(Math.min(T4 + V1, 2 * (p.reduction.base + Y) - (T4 + V1)));
        T2 = pos(T4 + V1 + V2 - S);
      } else if (prov === 'BC') {
        let S = 0;
        if (A <= 25570) S = Math.min(T4, 805);
        else if (A <= 44952) S = Math.min(T4, pos(805 - (A - 25570) * 0.0356));
        T2 = pos(T4 - S);
      }
      provTax = r2(T2 / P);
    } else {
      // ---- Quebec income tax (Revenu Québec TP-1015.F) ----
      const q = t.qc;
      const CSA = C * ((t.qpp.rate - t.qpp.baseRate) / t.qpp.rate) + C2;
      const H = Math.min(q.employmentDeduction.rate * P * gross, q.employmentDeduction.max);
      const I = pos(P * (gross - F - CSA) - H);
      const qb = bracket(I, q.A, q.T, q.K);
      const tdQc = optNum(input.td1Qc);
      const E = tdQc == null ? q.bpa : tdQc;
      qcTax = r2(pos((qb.rate * I - qb.k - q.creditRate * E) / P) + num(input.extraQcTax));
      notes.push('Quebec income tax follows Revenu Québec’s formula but hasn’t been checked against WebRAS yet. Compare with WebRAS before your first Quebec pay run.');
    }

    // ---- Employer contributions ----
    const erCPP = C, erCPP2 = C2;
    const erEI = r2(EI * t.ei.employer);
    const hsfRate = qc ? (input.hsfRate == null ? 1.65 : num(input.hsfRate)) : 0;
    const HSF = qc ? r2(gross * hsfRate / 100) : 0;

    const employee = { cpp: qc ? 0 : C, cpp2: qc ? 0 : C2, qpp: qc ? C : 0, qpp2: qc ? C2 : 0, ei: EI, qpip: QPIP, fedTax, provTax, qcTax };
    const employer = { cpp: qc ? 0 : erCPP, cpp2: qc ? 0 : erCPP2, qpp: qc ? erCPP : 0, qpp2: qc ? erCPP2 : 0, ei: erEI, qpip: erQPIP, hsf: HSF };
    return {
      table: t.label, prov, P, quebec: qc,
      gross, pensionable: PI, insurable: IE, rrsp: F, union: U1,
      employee, employer,
      annualTaxable: r2(A), notes
    };
  }

  // Split a pay's deductions between CRA and Revenu Québec. Works on (possibly overridden) amounts.
  function remitSplit(employee, employer) {
    const e = employee || {}, r = employer || {};
    const n = k => num(e[k]), m = k => num(r[k]);
    return {
      cra: r2(n('cpp') + n('cpp2') + m('cpp') + m('cpp2') + n('ei') + m('ei') + n('fedTax') + n('provTax')),
      rq: r2(n('qpp') + n('qpp2') + m('qpp') + m('qpp2') + n('qpip') + m('qpip') + n('qcTax') + m('hsf'))
    };
  }

  // Employee deductions in display order, with the agency each is remitted to.
  const EMPLOYEE_ITEMS = [
    ['cpp', 'CPP', 'cra'], ['cpp2', 'CPP2', 'cra'], ['qpp', 'QPP', 'rq'], ['qpp2', 'QPP2', 'rq'],
    ['ei', 'EI', 'cra'], ['qpip', 'QPIP', 'rq'],
    ['fedTax', 'Federal income tax', 'cra'], ['provTax', 'Provincial income tax', 'cra'], ['qcTax', 'Quebec income tax', 'rq']
  ];
  const EMPLOYER_ITEMS = [
    ['cpp', 'CPP (employer)', 'cra'], ['cpp2', 'CPP2 (employer)', 'cra'], ['qpp', 'QPP (employer)', 'rq'], ['qpp2', 'QPP2 (employer)', 'rq'],
    ['ei', 'EI (employer)', 'cra'], ['qpip', 'QPIP (employer)', 'rq'], ['hsf', 'Health Services Fund', 'rq']
  ];

  // Regular remitters: due the 15th of the month after the pay date (both CRA and Revenu Québec).
  function remittanceDue(payDate) {
    const [y, m] = payDate.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, '0')}-15`;
  }

  return { calc, remitSplit, remittanceDue, tableFor, FREQUENCIES, FREQ_LABEL, PROVINCES, EMPLOYEE_ITEMS, EMPLOYER_ITEMS, TABLES, r2 };
});
