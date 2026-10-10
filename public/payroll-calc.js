/*
 * Sumlora payroll calculator.
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
   *   bonus: the part of gross that is a bonus or other non-periodic payment (taxed with CRA's bonus method),
   *   benefits: taxable benefits not paid in cash (group life insurance, automobile, gift cards…): taxed and,
   *     as the caller passes in pensionable/insurable, subject to CPP/QPP and EI/QPIP,
   *   ytd: { pensionable, cpp, cpp2, qpp, qpp2, ei, qpip, erQpip, bonus } before this pay,
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
    const benefits = r2(num(input.benefits));
    const taxable = r2(gross + benefits); // pay plus taxable benefits not paid in cash
    const bonus = r2(Math.min(Math.max(0, num(input.bonus)), gross));
    const PI = input.pensionable == null ? taxable : r2(num(input.pensionable));
    const IE = input.insurable == null ? gross : r2(num(input.insurable));
    // QPIP: all taxable benefits are insurable (not only the near-cash ones EI takes), so its base can be larger.
    const QI = input.qpipInsurable == null ? IE : r2(num(input.qpipInsurable));
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
      QPIP = r2(Math.max(0, Math.min(t.qpip.max - num(ytd.qpip), t.qpip.rate * QI)));
      erQPIP = r2(Math.max(0, Math.min(t.qpip.erMax - num(ytd.erQpip), t.qpip.erRate * QI)));
    }

    // ---- Income tax ----
    // Regular pay is annualized (× pay periods). A bonus is taxed with CRA's method for non-periodic
    // payments (T4127, Option 1): the year's tax with the bonus minus the year's tax without it.
    const F5 = r2(C * ((qc ? t.qpp.rate - t.qpp.baseRate : t.cpp.rate - t.cpp.baseRate) / pp.rate) + C2);
    const regular = r2(taxable - bonus);
    // CPP, EI and QPIP on regular pay alone: they give the credits and the CPP enhancement deduction (F5A)
    // for regular pay; what the bonus adds is F5B.
    const Creg = bonus > 0 && !input.cppExempt ? Math.max(0, Math.min(pp.max - num(qc ? ytd.qpp : ytd.cpp), pp.rate * (PI - bonus - exemption))) : C;
    const EIreg = bonus > 0 ? Math.max(0, Math.min(EI, eiRate * Math.max(0, IE - bonus))) : EI;
    const QPIPreg = bonus > 0 ? Math.max(0, Math.min(QPIP, t.qpip.rate * Math.max(0, QI - bonus))) : QPIP;
    // CPP2/QPP2 on regular pay alone (the second additional contribution is fully deductible, so it belongs in F5A).
    const C2reg = bonus > 0 && !input.cppExempt ? Math.max(0, Math.min(C2, (Math.min(num(ytd.pensionable) + PI - bonus, t.cpp2.yampe) - Math.max(num(ytd.pensionable), pp.ympe)) * t.cpp2.rate)) : C2;
    const F5A = bonus > 0 ? r2(Creg * ((qc ? t.qpp.rate - t.qpp.baseRate : t.cpp.rate - t.cpp.baseRate) / pp.rate) + C2reg) : F5;
    const F5B = r2(Math.max(0, F5 - F5A));
    const lowFed = t.fed.R[0];
    const tdFed = optNum(input.td1Fed);
    const cppCredit = Math.min(P * Creg * (pp.baseRate / pp.rate), pp.baseMaxCredit);
    const eiCredit = Math.min(P * EIreg, eiMax);
    const qpipCredit = qc ? Math.min(P * QPIPreg, t.qpip.max) : 0;
    /** Federal tax for a year at annual taxable income A (T1, after the Quebec abatement). */
    const fedYear = A => {
      const fb = bracket(A, t.fed.A, t.fed.R, t.fed.K);
      const K1 = lowFed * (tdFed == null ? federalBpa(t, A) : tdFed);
      const K2 = lowFed * (cppCredit + eiCredit + qpipCredit);
      const K4 = Math.min(lowFed * A, lowFed * t.fed.cea);
      const T3 = pos(fb.rate * A - fb.k - K1 - K2 - K4);
      return qc ? T3 - t.fed.qcAbatement * T3 : T3;
    };
    /** Provincial tax for a year at A (T2, outside Quebec), with Ontario's surtax and health premium and BC's reduction. */
    const provYear = A => {
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
      return T2;
    };
    const A = pos(P * (regular - F - F5A - U1));          // regular pay, annualized
    const B1 = r2(num(ytd.bonus));                        // bonuses already paid this year
    let fedBonus = 0, provBonus = 0, qcBonus = 0, bonusFlat = false;
    if (bonus > 0) {
      const Awo = A + B1, Aw = Awo + pos(bonus - F5B);
      if (Aw <= 5000) {
        bonusFlat = true;
        fedBonus = r2(bonus * (qc ? 0.10 : 0.15));          // CRA: 15% (10% in Quebec) when the year's income is $5,000 or less
      } else {
        fedBonus = r2(pos(fedYear(Aw) - fedYear(Awo)));
        if (!qc) provBonus = r2(pos(provYear(Aw) - provYear(Awo)));
      }
    }
    const fedTax = r2(fedYear(A) / P + fedBonus + num(input.extraTax));

    let provTax = 0, qcTax = 0;
    if (!qc) {
      provTax = r2(provYear(A) / P + provBonus);
    } else {
      // ---- Quebec income tax (Revenu Québec TP-1015.F) ----
      const q = t.qc;
      const CSA = C * ((t.qpp.rate - t.qpp.baseRate) / t.qpp.rate) + C2;
      const CSAreg = bonus > 0 ? Creg * ((t.qpp.rate - t.qpp.baseRate) / t.qpp.rate) : CSA, CSAb = Math.max(0, CSA - CSAreg);
      const tdQc = optNum(input.td1Qc);
      const E = tdQc == null ? q.bpa : tdQc;
      /** Quebec tax for a year: I is net income before the employment deduction; the deduction is worked out on the year's pay. */
      const qcYear = (income, pay) => {
        const H = Math.min(q.employmentDeduction.rate * pay, q.employmentDeduction.max);
        const I = pos(income - H);
        const qb = bracket(I, q.A, q.T, q.K);
        return pos(qb.rate * I - qb.k - q.creditRate * E);
      };
      const regIncome = P * (regular - F - CSAreg);
      qcTax = r2(qcYear(regIncome, P * regular) / P + num(input.extraQcTax));
      if (bonus > 0) {
        // Revenu Québec: 7% when the year's pay with the bonus is $18,952 or less; otherwise the difference.
        const yearPay = P * regular + B1 + bonus;
        qcBonus = yearPay <= 18952 ? r2(bonus * 0.07)
          : r2(pos(qcYear(regIncome + B1 + bonus - CSAb, yearPay) - qcYear(regIncome + B1, P * regular + B1)));
        qcTax = r2(qcTax + qcBonus);
      }
      notes.push('Quebec income tax follows Revenu Québec’s formula but hasn’t been checked against WebRAS yet. Compare with WebRAS before your first Quebec pay run.');
    }
    if (bonus > 0) notes.push(bonusFlat ? `The bonus is taxed at the flat ${qc ? '10%' : '15%'} rate, because the year’s income is $5,000 or less.` : 'The bonus is taxed with CRA’s method for bonuses: the year’s tax with the bonus minus the year’s tax without it.');

    // ---- Employer contributions ----
    const erCPP = C, erCPP2 = C2;
    const erEI = r2(EI * t.ei.employer);
    const hsfRate = qc ? (input.hsfRate == null ? 1.65 : num(input.hsfRate)) : 0;
    const HSF = qc ? r2(taxable * hsfRate / 100) : 0;

    const employee = { cpp: qc ? 0 : C, cpp2: qc ? 0 : C2, qpp: qc ? C : 0, qpp2: qc ? C2 : 0, ei: EI, qpip: QPIP, fedTax, provTax, qcTax };
    const employer = { cpp: qc ? 0 : erCPP, cpp2: qc ? 0 : erCPP2, qpp: qc ? erCPP : 0, qpp2: qc ? erCPP2 : 0, ei: erEI, qpip: erQPIP, hsf: HSF };
    return {
      table: t.label, prov, P, quebec: qc,
      gross, benefits, taxable, bonus, pensionable: PI, insurable: IE, rrsp: F, union: U1,
      employee, employer,
      annualTaxable: r2(A), bonusTax: { fed: fedBonus, prov: provBonus, qc: qcBonus }, notes
    };
  }

  /* Taxable benefits not paid in cash (CRA T4130; Revenu Québec). All are taxable and pensionable (CPP/QPP).
     EI: only near-cash benefits (gift cards) and board and lodging are insurable. T4 "other information" code
     and RL-1 box for each; all of them are also in T4 box 14 and RL-1 box A. */
  const BENEFIT_KINDS = [
    { k: 'life', label: 'Group term life insurance premiums', t4: 40, rl1: 'L', ei: false },
    { k: 'auto', label: 'Automobile benefit (standby charge and operating benefit)', t4: 34, rl1: 'W', ei: false },
    { k: 'nearcash', label: 'Gift cards and other near-cash gifts', t4: 40, rl1: 'L', ei: true },
    { k: 'board', label: 'Board and lodging', t4: 30, rl1: 'V', ei: true },
    { k: 'other', label: 'Other non-cash benefits', t4: 40, rl1: 'L', ei: false },
  ];

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

  /** The remitting period a bank or CRA asks for, as YYYY-MM: the month employees were paid,
      or the last month of the quarter for quarterly remitters. Takes a period key ('2026-09' or '2026-Q3'). */
  function remitPeriodEnd(key) {
    const q = /^(\d{4})-Q([1-4])$/.exec(key || '');
    return q ? `${q[1]}-${String(q[2] * 3).padStart(2, '0')}` : String(key || '').slice(0, 7);
  }
  /** Account number check for paying online: '' when fine, or what's wrong. CRA: 123456789RP0001; Revenu Québec: 1234567890RS0001. */
  function remitAccountProblem(agency, acct) {
    const a = String(acct || '').replace(/\s+/g, '').toUpperCase();
    if (!a) return 'missing';
    if (agency === 'rq') return /^\d{10}RS\d{4}$/.test(a) ? '' : 'format';
    return /^\d{9}RP\d{4}$/.test(a) ? '' : 'format';
  }

  /* ---------- year-end: T4 and RL-1 slips and summaries ----------
     Box rules from CRA's "Filling out the T4 slip" and Revenu Québec's RL-1 guide (RL-1.G).
     A separate T4 (and RL-1) is made for each province an employee worked in during the year. */
  const YEAR_LIMITS = {
    2026: { ympe: 74600, yampe: 85000, exemption: 3500, cppRate: 0.0595, cppMax: 4230.45, qppRate: 0.063, qppMax: 4479.30, cpp2Rate: 0.04,
      eiMax: 68900, eiRate: 0.0163, eiRateQc: 0.013, qpipMax: 103000, qpipRate: 0.0043, cntRate: 0.0006, cntMax: 103000 },
  };
  /** SIN check (Luhn). Returns '' when fine, 'none' for 000 000 000 (CRA's "not provided"), or what's wrong. */
  function sinProblem(sin) {
    const d = String(sin || '').replace(/\D/g, '');
    if (!d) return 'missing';
    if (d.length !== 9) return 'invalid';
    if (d === '000000000') return 'none';
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
  /** Health Services Fund rate (Revenu Québec's table). `payroll` is TOTAL payroll: every province,
      plus the payroll of associated employers. The rate is then applied to Quebec payroll only. */
  function hsfRateFor(payroll, primary) {
    if (payroll <= 1000000) return primary ? 1.25 : 1.65;
    if (payroll >= 7800000) return 4.26;
    const m = payroll / 1000000;
    return Math.round((primary ? 0.8074 + 0.4426 * m : 1.2662 + 0.3838 * m) * 10000) / 10000;
  }
  // The part of `amount` that fits under `cap` when `before` has already been counted.
  const slice = (before, amount, cap) => r2(Math.max(0, Math.min(before + amount, cap) - Math.min(before, cap)));

  /*
   * yearEnd({ year, employees, payruns, remittances, hsfPrimary, assocPayroll })
   *   employees: [{ id, name, prov, sin, address, cppExempt, eiExempt, qpipExempt, pensionType ('rrsp'|'rpp'), rppNo,
   *                 paByYear: { [year]: pension adjustment }, dental (1–5), openingYtd }]
   *   payruns:   pay runs as stored ({ payDate, lines:[{ employeeId, prov, gross, pensionable, insurable, rrsp, union, ded, er,
   *              cppExempt, eiExempt, qpipExempt }] }). The exempt flags on a line are what applied on that pay;
   *              lines saved before they were recorded fall back to the employee's current setting.
   *   remittances: [{ agency: 'cra'|'rq', period: 'YYYY-MM' | 'YYYY-Qn', amount }]
   *   assocPayroll: payroll of associated employers, for the Health Services Fund rate.
   * Returns { slips, t4sum, rl1sum, due, limits }.
   */
  function yearEnd({ year, employees, payruns, remittances = [], hsfPrimary = false, assocPayroll = 0 }) {
    const L = YEAR_LIMITS[year];
    if (!L) { const e = new Error(`Year-end limits for ${year} aren't loaded yet.`); e.code = 'NO_RATES'; throw e; }
    const empById = new Map(employees.map(e => [e.id, e]));
    const acc = new Map(); // `${employeeId}|${prov}` -> running totals
    const add = (o, k, v) => { o[k] = r2((o[k] || 0) + num(v)); };
    const bucket = (id, prov, date) => {
      const k = id + '|' + prov;
      if (!acc.has(k)) acc.set(k, { employeeId: id, prov, first: date, gross: 0, pi: 0, ie: 0, qi: 0, rrsp: 0, union: 0, ded: {}, er: {}, allowance: 0, ben: {},
        pays: 0, exC: 0, exE: 0, exQ: 0 });
      const b = acc.get(k); if (date < b.first) b.first = date; return b;
    };
    const has = v => v !== undefined && v !== null && v !== '';
    for (const e of employees) {
      const o = e.openingYtd;
      if (!o || Number(o.year) !== year || !num(o.gross)) continue;
      const prov = PROVINCES.includes(o.prov) ? o.prov : e.prov;
      const b = bucket(e.id, prov, year + '-01-00'); // earlier payroll comes before any pay run
      const noCpp = !num(o.cpp) && !num(o.cpp2) && !num(o.qpp) && !num(o.qpp2);
      const exC = !!e.cppExempt && noCpp, exE = !!e.eiExempt && !num(o.ei), exQ = !!e.qpipExempt && !num(o.qpip);
      b.pays++; if (exC) b.exC++; if (exE) b.exE++; if (exQ) b.exQ++;
      add(b, 'gross', o.gross);
      const pi = has(o.pensionable) ? o.pensionable : o.gross, ie = has(o.insurable) ? o.insurable : o.gross;
      add(b, 'pi', exC ? 0 : pi); add(b, 'ie', exE ? 0 : ie); add(b, 'qi', exQ ? 0 : ie);
      add(b, 'rrsp', o.rrsp); add(b, 'union', o.union);
      for (const k of ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip', 'fedTax', 'provTax', 'qcTax']) add(b.ded, k, o[k]);
      // Employer shares weren't all entered for earlier payroll: CPP/QPP match the employee; EI is 1.4 times unless entered.
      for (const k of ['cpp', 'cpp2', 'qpp', 'qpp2']) add(b.er, k, o[k]);
      add(b.er, 'ei', has(o.erEi) ? o.erEi : r2(num(o.ei) * 1.4)); add(b.er, 'qpip', o.erQpip);
    }
    for (const r of payruns) {
      if (String(r.payDate).slice(0, 4) !== String(year)) continue;
      for (const l of r.lines || []) {
        const e = empById.get(l.employeeId) || { id: l.employeeId };
        const b = bucket(l.employeeId, l.prov || e.prov, String(r.payDate));
        const flag = k => (l[k] === undefined ? !!e[k] : !!l[k]);
        const exC = flag('cppExempt'), exE = flag('eiExempt'), exQ = flag('qpipExempt');
        b.pays++; if (exC) b.exC++; if (exE) b.exE++; if (exQ) b.exQ++;
        const ie = l.insurable ?? l.gross;
        // QPIP (box 56, RL-1 I) also counts the benefits EI leaves out.
        const qi = r2(ie + BENEFIT_KINDS.filter(k => !k.ei).reduce((t, k) => t + num((l.benefits || {})[k.k]), 0));
        add(b, 'gross', l.gross); add(b, 'pi', exC ? 0 : (l.pensionable ?? l.gross)); add(b, 'ie', exE ? 0 : ie); add(b, 'qi', exQ ? 0 : qi);
        add(b, 'rrsp', l.rrsp); add(b, 'union', l.union); add(b, 'allowance', l.allowance);
        for (const [k, v] of Object.entries(l.benefits || {})) add(b.ben, k, v);
        for (const [k, v] of Object.entries(l.ded || {})) add(b.ded, k, v);
        for (const [k, v] of Object.entries(l.er || {})) add(b.er, k, v);
      }
    }

    // One T4 (and RL-1) per province. An employee's slips are worked out in date order, so the yearly
    // maximums for boxes 24, 26, 56 and RL-1 G and I are shared across their slips, not applied to each.
    const byEmp = new Map();
    for (const b of acc.values()) { if (!byEmp.has(b.employeeId)) byEmp.set(b.employeeId, []); byEmp.get(b.employeeId).push(b); }
    const slips = [];
    const diff = (got, want) => Math.abs(r2(got) - r2(want)) > 1;
    for (const [id, list] of byEmp) {
      list.sort((a, b) => a.first.localeCompare(b.first) || a.prov.localeCompare(b.prov));
      const e = empById.get(id) || {};
      const sp = sinProblem(e.sin);
      let cumPI = 0, cumIE = 0, cumQI = 0, exLeft = L.exemption, wantC = 0, wantC2 = 0, wantEI = 0, wantQ = 0;
      let gotC = 0, gotC2 = 0, gotEI = 0, gotQ = 0, anyC = false, anyE = false, anyQ = false;
      const empSlips = [];
      for (const b of list) {
        const qc = b.prov === 'QC', d = k => r2(b.ded[k] || 0);
        // Taxable benefits not paid in cash: in box 14 (RL-1 box A), and broken down by "other information" code.
        const benAll = r2(Object.values(b.ben).reduce((t, v) => t + num(v), 0));
        const codes = {}, rlCodes = {};
        if (b.allowance) codes[40] = r2(b.allowance);
        for (const kind of BENEFIT_KINDS) {
          const v = num(b.ben[kind.k]);
          if (!v) continue;
          codes[kind.t4] = r2((codes[kind.t4] || 0) + v);
          rlCodes[kind.rl1] = r2((rlCodes[kind.rl1] || 0) + v);
        }
        const rpp = e.pensionType === 'rpp' ? r2(b.rrsp) : 0;
        const box24 = slice(cumIE, b.ie, L.eiMax), box26 = slice(cumPI, b.pi, L.yampe);
        const box56 = qc ? slice(cumQI, b.qi, L.qpipMax) : 0;
        const c = qc ? d('qpp') : d('cpp'), c2 = qc ? d('qpp2') : d('cpp2');
        // Box 28: only when exempt for every pay on this slip, with nothing deducted.
        const ex28 = { cppQpp: b.pays > 0 && b.exC === b.pays && !c && !c2, ei: b.pays > 0 && b.exE === b.pays && !d('ei'),
          ppip: qc && b.pays > 0 && b.exQ === b.pays && !d('qpip') };
        const t4 = {
          10: b.prov, 12: String(e.sin || '').replace(/\D/g, ''), 14: r2(b.gross + benAll),
          16: qc ? 0 : c, '16A': qc ? 0 : c2, 17: qc ? c : 0, '17A': qc ? c2 : 0,
          18: d('ei'), 20: rpp, 22: r2(d('fedTax') + (qc ? 0 : d('provTax'))),
          24: ex28.ei ? 0 : box24, 26: ex28.cppQpp ? 0 : box26, 28: ex28,
          44: r2(b.union), 45: [1, 2, 3, 4, 5].includes(Number(e.dental)) ? Number(e.dental) : 0,
          50: '', 52: 0,
          55: qc ? d('qpip') : 0, 56: qc ? (ex28.ppip ? 0 : box56) : 0,
        };
        const rl1 = qc ? {
          A: r2(b.gross + benAll), 'B.A': d('qpp'), 'B.B': d('qpp2'), C: d('ei'), D: rpp, E: d('qcTax'), F: r2(b.union),
          G: ex28.cppQpp ? 0 : slice(cumPI, b.pi, c2 > 0 ? L.yampe : L.ympe),
          H: d('qpip'), I: ex28.ppip ? 0 : box56,
        } : null;

        // What CRA's pensionable and insurable earnings review (PIER) would expect, slip by slip.
        if (b.pi > 0) {
          anyC = true;
          const rate = qc ? L.qppRate : L.cppRate, max = qc ? L.qppMax : L.cppMax;
          const base = slice(cumPI, b.pi, L.ympe), ex = Math.min(exLeft, base); exLeft -= ex;
          const w = Math.max(0, Math.min(max - wantC, rate * (base - ex)));
          wantC = r2(wantC + w);
          wantC2 = r2(wantC2 + (slice(cumPI, b.pi, L.yampe) - slice(cumPI, b.pi, L.ympe)) * L.cpp2Rate);
        }
        if (b.ie > 0) { anyE = true; wantEI = r2(wantEI + box24 * (qc ? L.eiRateQc : L.eiRate)); }
        if (qc && b.qi > 0) { anyQ = true; wantQ = r2(wantQ + box56 * L.qpipRate); }
        gotC = r2(gotC + c); gotC2 = r2(gotC2 + c2); gotEI = r2(gotEI + d('ei')); if (qc) gotQ = r2(gotQ + d('qpip'));
        cumPI = r2(cumPI + b.pi); cumIE = r2(cumIE + b.ie); if (qc) cumQI = r2(cumQI + b.qi);

        const checks = [];
        if (sp === 'none') checks.push({ level: 'warn', code: 'sin-none' });
        else if (sp) checks.push({ level: 'error', code: 'sin-' + sp });
        if (!t4[45]) checks.push({ level: 'error', code: 'dental' });
        if (rpp > 0 && !String(e.rppNo || '').trim()) checks.push({ level: 'error', code: 'rpp-no' });
        if (rpp > 0) t4[50] = String(e.rppNo || '').replace(/\D/g, '');
        if (rl1) Object.assign(rl1, rlCodes);
        const s = { employeeId: id, name: e.name || '', address: e.address || '', prov: b.prov, t4, other: codes, rl1, er: { ...b.er }, checks };
        empSlips.push(s); slips.push(s);
      }
      // The pension adjustment goes on one slip (the last one), and the employee-wide checks with it.
      const last = empSlips[empSlips.length - 1], many = empSlips.length > 1;
      const pa = r2(num((e.paByYear || {})[year]));
      if (e.pensionType === 'rpp' && empSlips.some(s => s.t4[20] > 0)) {
        last.t4[52] = pa;
        if (!pa) last.checks.push({ level: 'error', code: 'rpp-pa' });
      } else if (pa) last.t4[52] = pa;
      if (anyE && diff(gotEI, wantEI)) last.checks.push({ level: 'warn', code: 'ei', got: gotEI, want: wantEI, many });
      if (anyC) {
        if (diff(gotC, wantC)) last.checks.push({ level: 'info', code: 'cpp', got: gotC, want: wantC, many, qc: last.prov === 'QC' });
        if (diff(gotC2, wantC2)) last.checks.push({ level: 'warn', code: 'cpp2', got: gotC2, want: wantC2, many });
      }
      if (anyQ && diff(gotQ, wantQ)) last.checks.push({ level: 'warn', code: 'qpip', got: gotQ, want: wantQ, many });
    }
    slips.sort((a, b) => a.name.localeCompare(b.name) || a.prov.localeCompare(b.prov));

    const sum = (list, f) => r2(list.reduce((s, x) => s + num(f(x)), 0));
    const remitted = ag => sum(remittances.filter(x => x.agency === ag && String(x.period).startsWith(String(year))), x => x.amount);
    const t4sum = {
      88: slips.length, 14: sum(slips, s => s.t4[14]), 16: sum(slips, s => s.t4[16]), '16A': sum(slips, s => s.t4['16A']),
      17: sum(slips, s => s.t4[17]), '17A': sum(slips, s => s.t4['17A']), 18: sum(slips, s => s.t4[18]),
      19: sum(slips, s => s.er.ei), 20: sum(slips, s => s.t4[20]), 22: sum(slips, s => s.t4[22]), 52: sum(slips, s => s.t4[52]),
      27: sum(slips.filter(s => s.prov !== 'QC'), s => s.er.cpp), '27A': sum(slips.filter(s => s.prov !== 'QC'), s => s.er.cpp2),
    };
    t4sum[80] = r2(t4sum[16] + t4sum['16A'] + t4sum[27] + t4sum['27A'] + t4sum[18] + t4sum[19] + t4sum[22]);
    t4sum[82] = remitted('cra');
    const t4diff = r2(t4sum[80] - t4sum[82]);
    t4sum.difference = t4diff;
    // CRA doesn't charge or refund a difference of $2 or less.
    t4sum[84] = t4diff < -2 ? -t4diff : 0; // overpayment
    t4sum[86] = t4diff > 2 ? t4diff : 0;   // balance due

    const qcs = slips.filter(s => s.rl1);
    let rl1sum = null;
    if (qcs.length) {
      const payroll = sum(qcs, s => s.rl1.A);
      const totalPayroll = r2(t4sum[14] + num(assocPayroll));
      const rate = hsfRateFor(totalPayroll, hsfPrimary);
      const hsf = r2(payroll * rate / 100), hsfPaid = sum(qcs, s => s.er.hsf);
      // Labour standards: 0.06% of each employee's pay up to the maximum (per employee, all their Quebec slips together).
      const perEmp = new Map(); qcs.forEach(s => perEmp.set(s.employeeId, (perEmp.get(s.employeeId) || 0) + s.rl1.A));
      const cntBase = r2([...perEmp.values()].reduce((t, a) => t + Math.min(a, L.cntMax), 0));
      rl1sum = {
        slips: qcs.length, payroll, totalPayroll, assocPayroll: r2(num(assocPayroll)),
        qppEmployee: sum(qcs, s => s.rl1['B.A']), qppEmployer: sum(qcs, s => s.er.qpp),
        qpp2Employee: sum(qcs, s => s.rl1['B.B']), qpp2Employer: sum(qcs, s => s.er.qpp2),
        qpipEmployee: sum(qcs, s => s.rl1.H), qpipEmployer: sum(qcs, s => s.er.qpip),
        qcTax: sum(qcs, s => s.rl1.E), hsfRate: rate, hsf, hsfPaid, hsfBalance: r2(hsf - hsfPaid),
        cntBase, cnt: r2(cntBase * L.cntRate), wsdrf: t4sum[14] > 2000000,
      };
      rl1sum.total = r2(rl1sum.qppEmployee + rl1sum.qppEmployer + rl1sum.qpp2Employee + rl1sum.qpp2Employer + rl1sum.qpipEmployee + rl1sum.qpipEmployer + rl1sum.qcTax + rl1sum.hsf);
      rl1sum.remitted = remitted('rq');
      rl1sum.balance = r2(rl1sum.total - rl1sum.remitted);
    }
    return { year, slips, t4sum, rl1sum, due: slipsDue(year), limits: L };
  }


  /* ---------- dates ---------- */
  const D = s => new Date(s + 'T00:00:00Z');
  const iso = d => d.toISOString().slice(0, 10);
  const addD = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5); // b − a
  const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  /** The nth weekday (0 = Sunday) of a month; n = -1 for the last. */
  function nthWeekday(y, m, wd, n) {
    if (n > 0) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return ymd(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); }
    const lastDay = new Date(Date.UTC(y, m, 0)), back = (lastDay.getUTCDay() - wd + 7) % 7;
    return ymd(y, m, lastDay.getUTCDate() - back);
  }
  function easter(y) { // Anonymous Gregorian algorithm
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    return ymd(y, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
  }

  /* ---------- public (statutory) holidays ----------
     The general holidays in each province's employment standards law, for employees under provincial law.
     Some provinces have more holidays for some workplaces, and some holidays move when they fall on a weekend;
     the pay-run screen shows each holiday so it can be left out. */
  const HOLIDAY_SETS = {
    ON: ['newyear', 'family', 'goodfriday', 'victoria', 'canada', 'labour', 'thanksgiving', 'christmas', 'boxing'],
    QC: ['newyear', 'goodfriday', 'patriots', 'stjean', 'canadaQc', 'labour', 'thanksgiving', 'christmas'],
    AB: ['newyear', 'family', 'goodfriday', 'victoria', 'canada', 'labour', 'thanksgiving', 'remembrance', 'christmas'],
    BC: ['newyear', 'family', 'goodfriday', 'victoria', 'canada', 'bcday', 'labour', 'truth', 'thanksgiving', 'remembrance', 'christmas'],
    MB: ['newyear', 'louisriel', 'goodfriday', 'victoria', 'canada', 'labour', 'truth', 'thanksgiving', 'christmas'],
    SK: ['newyear', 'family', 'goodfriday', 'victoria', 'canada', 'skday', 'labour', 'thanksgiving', 'remembrance', 'christmas'],
    NS: ['newyear', 'heritage', 'goodfriday', 'canada', 'labour', 'christmas'],
    NB: ['newyear', 'family', 'goodfriday', 'canada', 'nbday', 'labour', 'remembrance', 'christmas'],
    NL: ['newyear', 'goodfriday', 'canada', 'labour', 'remembrance', 'christmas'],
    PE: ['newyear', 'islander', 'goodfriday', 'canada', 'labour', 'truth', 'remembrance', 'christmas'],
    NT: ['newyear', 'goodfriday', 'victoria', 'indigenous', 'canada', 'civic', 'labour', 'truth', 'thanksgiving', 'remembrance', 'christmas'],
    NU: ['newyear', 'goodfriday', 'victoria', 'canada', 'nunavut', 'civic', 'labour', 'truth', 'thanksgiving', 'remembrance', 'christmas'],
    YT: ['newyear', 'goodfriday', 'victoria', 'indigenous', 'canada', 'discovery', 'labour', 'truth', 'thanksgiving', 'remembrance', 'christmas'],
  };
  const HOLIDAY_RULES = {
    newyear: ['New Year’s Day', y => ymd(y, 1, 1)],
    family: ['Family Day', y => nthWeekday(y, 2, 1, 3)],
    louisriel: ['Louis Riel Day', y => nthWeekday(y, 2, 1, 3)],
    heritage: ['Heritage Day', y => nthWeekday(y, 2, 1, 3)],
    islander: ['Islander Day', y => nthWeekday(y, 2, 1, 3)],
    goodfriday: ['Good Friday', y => addD(easter(y), -2)],
    victoria: ['Victoria Day', y => addD(ymd(y, 5, 25), -(((D(ymd(y, 5, 25)).getUTCDay() + 6) % 7) || 7))],
    patriots: ['National Patriots’ Day', y => addD(ymd(y, 5, 25), -(((D(ymd(y, 5, 25)).getUTCDay() + 6) % 7) || 7))],
    stjean: ['Fête nationale du Québec', y => (D(ymd(y, 6, 24)).getUTCDay() === 0 ? ymd(y, 6, 25) : ymd(y, 6, 24))], // June 25 when the 24th is a Sunday
    indigenous: ['National Indigenous Peoples Day', y => ymd(y, 6, 21)],
    canada: ['Canada Day', y => ymd(y, 7, 1)],
    canadaQc: ['Canada Day', y => (D(ymd(y, 7, 1)).getUTCDay() === 0 ? ymd(y, 7, 2) : ymd(y, 7, 1))], // Quebec: July 2 when July 1 is a Sunday
    nunavut: ['Nunavut Day', y => ymd(y, 7, 9)],
    civic: ['Civic Holiday', y => nthWeekday(y, 8, 1, 1)],
    bcday: ['British Columbia Day', y => nthWeekday(y, 8, 1, 1)],
    skday: ['Saskatchewan Day', y => nthWeekday(y, 8, 1, 1)],
    nbday: ['New Brunswick Day', y => nthWeekday(y, 8, 1, 1)],
    discovery: ['Discovery Day', y => nthWeekday(y, 8, 1, 3)],
    labour: ['Labour Day', y => nthWeekday(y, 9, 1, 1)],
    truth: ['National Day for Truth and Reconciliation', y => ymd(y, 9, 30)],
    thanksgiving: ['Thanksgiving', y => nthWeekday(y, 10, 1, 2)],
    remembrance: ['Remembrance Day', y => ymd(y, 11, 11)],
    christmas: ['Christmas Day', y => ymd(y, 12, 25)],
    boxing: ['Boxing Day', y => ymd(y, 12, 26)],
  };
  /** Public holidays for a province in a year: [{ date, name, key }] in date order. */
  function holidays(prov, year) {
    return (HOLIDAY_SETS[prov] || HOLIDAY_SETS.ON).map(k => ({ key: k, name: HOLIDAY_RULES[k][0], date: HOLIDAY_RULES[k][1](year) })).sort((a, b) => a.date.localeCompare(b.date));
  }
  /** Holidays between two dates (inclusive). */
  function holidaysBetween(prov, from, to) {
    const out = [];
    for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) for (const h of holidays(prov, y)) if (h.date >= from && h.date <= to) out.push(h);
    return out;
  }
  /** The 4 complete weeks (Sunday to Saturday) before the week a holiday falls in. */
  function holidayWindow(date) {
    const sunday = addD(date, -D(date).getUTCDay());
    return { from: addD(sunday, -28), to: addD(sunday, -1) };
  }
  /** Holiday pay: 1/20 of the wages earned in the 4 weeks before the holiday's week (Ontario and Quebec).
      `earnings`: [{ from, to, amount }] (pay periods, amounts counted for the holiday); each is spread evenly over its days. */
  function holidayPay(date, earnings) {
    const w = holidayWindow(date);
    let base = 0;
    for (const e of earnings) {
      if (!e.from || !e.to || e.to < w.from || e.from > w.to) continue;
      const days = daysBetween(e.from, e.to) + 1;
      const lo = e.from > w.from ? e.from : w.from, hi = e.to < w.to ? e.to : w.to;
      base += num(e.amount) * (daysBetween(lo, hi) + 1) / days;
    }
    return { base: r2(base), pay: r2(base / 20), window: w };
  }

  /* ---------- vacation pay ----------
     Suggested minimum by years of service. Where Sumlora doesn't know when the rate goes up, it suggests 4%
     and says to check. Always the minimum: an employer can pay more. */
  const VACATION = {
    ON: [[0, 4], [5, 6]], QC: [[0, 4], [3, 6]], BC: [[0, 4], [5, 6]], AB: [[0, 4], [5, 6]], MB: [[0, 4], [5, 6]],
    SK: [[0, 5.77], [10, 7.69]],
  };
  function serviceYears(hireDate, onDate) {
    if (!hireDate || !onDate || hireDate > onDate) return 0;
    const [hy, hm, hd] = hireDate.split('-').map(Number), [y, m, d] = onDate.split('-').map(Number);
    return y - hy - (m < hm || (m === hm && d < hd) ? 1 : 0);
  }
  function vacationRate(prov, hireDate, onDate) {
    const steps = VACATION[prov], years = serviceYears(hireDate, onDate);
    if (!steps) return { rate: 4, years, known: false };
    let rate = steps[0][1];
    for (const [y, r] of steps) if (years >= y) rate = r;
    return { rate, years, known: true, next: (steps.find(([y]) => y > years) || null) };
  }

  /* ---------- Record of Employment (ROE) ----------
     Service Canada's ROE: insurable earnings for the last pay periods (block 15C) and the insurable hours in them
     (block 15A). How many pay periods depends on how often the employee was paid. */
  const ROE_PERIODS = { weekly: 53, biweekly: 27, semimonthly: 25, monthly: 13 };
  const ROE_TYPE = { weekly: 'W', biweekly: 'B', semimonthly: 'S', monthly: 'M' };
  /** The pay periods ending on `end`, going back: [{ n, from, to }] with n = 1 for the final period. */
  function roePeriods(freq, end, count) {
    const out = [];
    let to = end;
    for (let n = 1; n <= count; n++) {
      let from;
      if (freq === 'weekly' || freq === 'biweekly') from = addD(to, freq === 'weekly' ? -6 : -13);
      else if (freq === 'monthly') from = to.slice(0, 8) + '01';
      else from = +to.slice(8) <= 15 ? to.slice(0, 8) + '01' : to.slice(0, 8) + '16';
      out.push({ n, from, to });
      to = addD(from, -1);
    }
    return out;
  }
  /*
   * roe({ freq, finalPeriodEnd, lines }) — lines: one per pay for this employee:
   *   { from, to, payDate, insurable, hours, separationVac }   (separationVac: vacation pay paid because they left; it goes in block 17A)
   * Returns { type, count, periods: [{ n, from, to, amount }], totalEarnings, hours, vacation, outside }.
   */
  function roe({ freq, finalPeriodEnd, lines }) {
    const count = ROE_PERIODS[freq] || 27;
    const periods = roePeriods(freq, finalPeriodEnd, count).map(p => ({ ...p, amount: 0, hours: 0 }));
    let vacation = 0, outside = 0;
    for (const l of lines) {
      const day = l.to || l.payDate;
      const p = periods.find(x => day >= x.from && day <= x.to);
      vacation = r2(vacation + num(l.separationVac));
      if (!p) { if (day > finalPeriodEnd) outside++; continue; }
      p.amount = r2(p.amount + Math.max(0, num(l.insurable) - num(l.separationVac)));
      p.hours = r2(p.hours + num(l.hours));
    }
    return {
      type: ROE_TYPE[freq] || 'B', count, periods,
      totalEarnings: r2(periods.reduce((t, p) => t + p.amount, 0)), hours: Math.round(periods.reduce((t, p) => t + p.hours, 0)),
      vacation, outside, due: addD(finalPeriodEnd, 5),
    };
  }
  const ROE_REASONS = [
    ['A', 'Shortage of work / end of contract or season'], ['B', 'Strike or lockout'], ['D', 'Illness or injury'], ['E', 'Quit'],
    ['F', 'Maternity'], ['G', 'Retirement'], ['H', 'Work-sharing'], ['J', 'Apprentice training'], ['K', 'Other'],
    ['M', 'Dismissal or suspension'], ['N', 'Leave of absence'], ['P', 'Parental'], ['Z', 'Compassionate care / family caregiver'],
  ];

  return { calc, remitSplit, remittanceDue, remitPeriodEnd, remitAccountProblem, tableFor, BENEFIT_KINDS, FREQUENCIES, FREQ_LABEL, PROVINCES, EMPLOYEE_ITEMS, EMPLOYER_ITEMS, TABLES, r2,
    yearEnd, sinProblem, slipsDue, hsfRateFor, YEAR_LIMITS,
    holidays, holidaysBetween, holidayWindow, holidayPay, vacationRate, serviceYears, roe, roePeriods, ROE_PERIODS, ROE_REASONS, addDays: addD, daysBetween };
});
