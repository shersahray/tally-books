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

  /* ---------- year-end: T4 and RL-1 slips and summaries ----------
     Box rules from CRA's "Filling out the T4 slip" and Revenu Québec's RL-1 guide (RL-1.G).
     A separate T4 (and RL-1) is made for each province an employee worked in during the year. */
  const YEAR_LIMITS = {
    2026: { ympe: 74600, yampe: 85000, exemption: 3500, cppRate: 0.0595, cppMax: 4230.45, qppRate: 0.063, qppMax: 4479.30, cpp2Rate: 0.04,
      eiMax: 68900, eiRate: 0.0163, eiRateQc: 0.013, qpipMax: 103000, qpipRate: 0.0043, cntRate: 0.0006, cntMax: 103000 },
  };
  /** SIN check (Luhn). Returns '' when fine, or what's wrong. */
  function sinProblem(sin) {
    const d = String(sin || '').replace(/\D/g, '');
    if (!d) return 'missing';
    if (d.length !== 9) return 'invalid';
    let sum = 0;
    for (let i = 0; i < 9; i++) { let n = +d[i]; if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    return sum % 10 === 0 && d[0] !== '0' && d[0] !== '8' ? '' : 'invalid';
  }
  /** Slips are due the last day of February; on a weekend, the next Monday. */
  function slipsDue(year) {
    const d = new Date(Date.UTC(year + 1, 2, 0)); // last day of February
    const dow = d.getUTCDay();
    if (dow === 6) d.setUTCDate(d.getUTCDate() + 2); else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  /** Health Services Fund rate from total Quebec payroll (Revenu Québec's table). */
  function hsfRateFor(payroll, primary) {
    if (payroll <= 1000000) return primary ? 1.25 : 1.65;
    if (payroll >= 7800000) return 4.26;
    const m = payroll / 1000000;
    return Math.round((primary ? 0.8074 + 0.4426 * m : 1.2662 + 0.3838 * m) * 10000) / 10000;
  }

  /*
   * yearEnd({ year, employees, payruns, remittances, hsfPrimary })
   *   employees: [{ id, name, prov, sin, address, cppExempt, eiExempt, qpipExempt, pensionType ('rrsp'|'rpp'), dental (1–5), openingYtd }]
   *   payruns:   pay runs as stored ({ payDate, lines:[{ employeeId, prov, gross, pensionable, insurable, rrsp, union, ded, er }] })
   *   remittances: [{ agency: 'cra'|'rq', period: 'YYYY-MM' | 'YYYY-Qn', amount }]
   * Returns { slips, t4sum, rl1sum, due, limits }.
   */
  function yearEnd({ year, employees, payruns, remittances = [], hsfPrimary = false }) {
    const L = YEAR_LIMITS[year];
    if (!L) { const e = new Error(`Year-end limits for ${year} aren't loaded yet.`); e.code = 'NO_RATES'; throw e; }
    const empById = new Map(employees.map(e => [e.id, e]));
    const acc = new Map(); // `${employeeId}|${prov}` -> running totals
    const blank = () => ({ gross: 0, pensionable: 0, insurable: 0, rrsp: 0, union: 0, ded: {}, er: {} });
    const add = (o, k, v) => { o[k] = r2((o[k] || 0) + num(v)); };
    const bucket = (id, prov) => { const k = id + '|' + prov; if (!acc.has(k)) acc.set(k, { employeeId: id, prov, ...blank() }); return acc.get(k); };
    for (const e of employees) {
      const o = e.openingYtd;
      if (!o || Number(o.year) !== year || !num(o.gross)) continue;
      const b = bucket(e.id, e.prov);
      add(b, 'gross', o.gross); add(b, 'pensionable', o.pensionable || o.gross); add(b, 'insurable', o.insurable || o.gross);
      for (const k of ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip', 'fedTax', 'provTax', 'qcTax']) add(b.ded, k, o[k]);
      // Employer shares weren't entered for earlier payroll: CPP/QPP match the employee, EI is 1.4 times.
      for (const k of ['cpp', 'cpp2', 'qpp', 'qpp2']) add(b.er, k, o[k]);
      add(b.er, 'ei', r2(num(o.ei) * 1.4)); add(b.er, 'qpip', o.erQpip);
    }
    for (const r of payruns) {
      if (String(r.payDate).slice(0, 4) !== String(year)) continue;
      for (const l of r.lines || []) {
        const e = empById.get(l.employeeId) || { id: l.employeeId };
        const b = bucket(l.employeeId, l.prov || e.prov);
        add(b, 'gross', l.gross); add(b, 'pensionable', l.pensionable ?? l.gross); add(b, 'insurable', l.insurable ?? l.gross);
        add(b, 'rrsp', l.rrsp); add(b, 'union', l.union);
        for (const [k, v] of Object.entries(l.ded || {})) add(b.ded, k, v);
        for (const [k, v] of Object.entries(l.er || {})) add(b.er, k, v);
      }
    }
    const slips = [];
    for (const b of acc.values()) {
      const e = empById.get(b.employeeId) || {};
      const qc = b.prov === 'QC', d = k => r2(b.ded[k] || 0);
      const rpp = e.pensionType === 'rpp' ? r2(b.rrsp) : 0;
      const t4 = {
        10: b.prov, 12: String(e.sin || '').replace(/\D/g, ''), 14: r2(b.gross),
        16: qc ? 0 : d('cpp'), '16A': qc ? 0 : d('cpp2'), 17: qc ? d('qpp') : 0, '17A': qc ? d('qpp2') : 0,
        18: d('ei'), 20: rpp, 22: r2(d('fedTax') + (qc ? 0 : d('provTax'))),
        24: e.eiExempt ? 0 : r2(Math.min(b.insurable, L.eiMax)),
        26: e.cppExempt ? 0 : r2(Math.min(b.pensionable, L.yampe)),
        28: { cppQpp: !!e.cppExempt, ei: !!e.eiExempt, ppip: qc && !!e.qpipExempt },
        44: r2(b.union), 45: e.dental || 1,
        55: qc ? d('qpip') : 0, 56: qc ? (e.qpipExempt ? 0 : r2(Math.min(b.insurable, L.qpipMax))) : 0,
      };
      const rl1 = qc ? {
        A: r2(b.gross), 'B.A': d('qpp'), 'B.B': d('qpp2'), C: d('ei'), D: rpp, E: d('qcTax'), F: r2(b.union),
        G: e.cppExempt ? 0 : r2(Math.min(b.pensionable, d('qpp2') > 0 ? L.yampe : L.ympe)),
        H: d('qpip'), I: e.qpipExempt ? 0 : r2(Math.min(b.insurable, L.qpipMax)),
      } : null;
      // Checks, like CRA's pensionable and insurable earnings review (PIER).
      const checks = [];
      const sp = sinProblem(e.sin);
      if (sp) checks.push({ level: 'error', code: 'sin-' + sp });
      const diff = (got, want) => Math.abs(r2(got) - r2(want)) > 1;
      if (!e.eiExempt) {
        const want = r2(Math.min(b.insurable, L.eiMax) * (qc ? L.eiRateQc : L.eiRate));
        if (diff(d('ei'), want)) checks.push({ level: 'warn', code: 'ei', got: d('ei'), want });
      }
      if (!e.cppExempt) {
        const rate = qc ? L.qppRate : L.cppRate, max = qc ? L.qppMax : L.cppMax;
        const want = r2(Math.max(0, Math.min(max, rate * (Math.min(b.pensionable, L.ympe) - L.exemption))));
        const got = qc ? d('qpp') : d('cpp');
        if (diff(got, want)) checks.push({ level: 'info', code: 'cpp', got, want });
        const want2 = r2(Math.max(0, Math.min(b.pensionable, L.yampe) - L.ympe) * L.cpp2Rate);
        const got2 = qc ? d('qpp2') : d('cpp2');
        if (diff(got2, want2)) checks.push({ level: 'warn', code: 'cpp2', got: got2, want: want2 });
      }
      if (qc && !e.qpipExempt) {
        const want = r2(Math.min(b.insurable, L.qpipMax) * L.qpipRate);
        if (diff(d('qpip'), want)) checks.push({ level: 'warn', code: 'qpip', got: d('qpip'), want });
      }
      slips.push({ employeeId: b.employeeId, name: e.name || '', address: e.address || '', prov: b.prov, t4, rl1, er: { ...b.er }, checks });
    }
    slips.sort((a, b) => a.name.localeCompare(b.name) || a.prov.localeCompare(b.prov));

    const sum = (list, f) => r2(list.reduce((s, x) => s + num(f(x)), 0));
    const remitted = ag => sum(remittances.filter(x => x.agency === ag && String(x.period).startsWith(String(year))), x => x.amount);
    const t4sum = {
      88: slips.length, 14: sum(slips, s => s.t4[14]), 16: sum(slips, s => s.t4[16]), '16A': sum(slips, s => s.t4['16A']),
      17: sum(slips, s => s.t4[17]), '17A': sum(slips, s => s.t4['17A']), 18: sum(slips, s => s.t4[18]),
      19: sum(slips, s => s.er.ei), 20: sum(slips, s => s.t4[20]), 22: sum(slips, s => s.t4[22]),
      27: sum(slips.filter(s => s.prov !== 'QC'), s => s.er.cpp), '27A': sum(slips.filter(s => s.prov !== 'QC'), s => s.er.cpp2),
    };
    t4sum[80] = r2(t4sum[16] + t4sum['16A'] + t4sum[27] + t4sum['27A'] + t4sum[18] + t4sum[19] + t4sum[22]);
    t4sum[82] = remitted('cra');
    const t4diff = r2(t4sum[80] - t4sum[82]);
    t4sum[84] = t4diff < 0 ? -t4diff : 0; // overpayment
    t4sum[86] = t4diff > 0 ? t4diff : 0;  // balance due

    const qcs = slips.filter(s => s.rl1);
    let rl1sum = null;
    if (qcs.length) {
      const payroll = sum(qcs, s => s.rl1.A);
      const rate = hsfRateFor(payroll, hsfPrimary);
      const hsf = r2(payroll * rate / 100), hsfPaid = sum(qcs, s => s.er.hsf);
      // Labour standards: 0.06% of each employee's pay up to the maximum (per employee, all their Quebec slips together).
      const perEmp = new Map(); qcs.forEach(s => perEmp.set(s.employeeId, (perEmp.get(s.employeeId) || 0) + s.rl1.A));
      const cntBase = r2([...perEmp.values()].reduce((t, a) => t + Math.min(a, L.cntMax), 0));
      rl1sum = {
        slips: qcs.length, payroll,
        qppEmployee: sum(qcs, s => s.rl1['B.A']), qppEmployer: sum(qcs, s => s.er.qpp),
        qpp2Employee: sum(qcs, s => s.rl1['B.B']), qpp2Employer: sum(qcs, s => s.er.qpp2),
        qpipEmployee: sum(qcs, s => s.rl1.H), qpipEmployer: sum(qcs, s => s.er.qpip),
        qcTax: sum(qcs, s => s.rl1.E), hsfRate: rate, hsf, hsfPaid, hsfBalance: r2(hsf - hsfPaid),
        cntBase, cnt: r2(cntBase * L.cntRate), wsdrf: payroll > 2000000,
      };
      rl1sum.total = r2(rl1sum.qppEmployee + rl1sum.qppEmployer + rl1sum.qpp2Employee + rl1sum.qpp2Employer + rl1sum.qpipEmployee + rl1sum.qpipEmployer + rl1sum.qcTax + rl1sum.hsf);
      rl1sum.remitted = remitted('rq');
      rl1sum.balance = r2(rl1sum.total - rl1sum.remitted);
    }
    return { year, slips, t4sum, rl1sum, due: slipsDue(year), limits: L };
  }

  return { calc, remitSplit, remittanceDue, tableFor, FREQUENCIES, FREQ_LABEL, PROVINCES, EMPLOYEE_ITEMS, EMPLOYER_ITEMS, TABLES, r2,
    yearEnd, sinProblem, slipsDue, hsfRateFor, YEAR_LIMITS };
});
