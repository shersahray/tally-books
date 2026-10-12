/*
 * Sumlora direct deposit: a Payments Canada Standard 005 ("CPA-005", 1464-byte) file of payroll deposits.
 *
 * Works in the browser (window.TallyDD) and in Node (require) so the tests can check it.
 *
 * Sumlora never moves money: the employer uploads this file to their own business banking, where their
 * bank's EFT / direct deposit service pays each employee from the employer's account.
 *
 * Layout (positions are 1-based within the record):
 *   Every record:  1 type (A, C or Z) · 2–10 record count · 11–20 originator ID · 21–24 file creation number
 *   A header:      25–30 creation date (0YYDDD) · 31–35 destination data centre · 36–55 blank · 56–58 currency
 *   C credit:      up to 6 segments of 240 bytes from position 25 (this file writes one per record; the rest blank)
 *     segment:     1–3 transaction code · 4–13 amount in cents · 14–19 date funds available (0YYDDD)
 *                  20–28 payee institution and transit (0IIITTTTT) · 29–40 payee account (left-justified)
 *                  41–62 item trace (zeros) · 63–65 stored transaction type (zeros) · 66–80 originator short name
 *                  81–110 payee name · 111–140 originator long name · 141–150 originator ID
 *                  151–169 originator cross-reference · 170–178 return institution and transit (0IIITTTTT)
 *                  179–190 return account · 191–205 sundry information · 206–227 stored trace (blank)
 *                  228–229 settlement code (blank) · 230–240 invalid data element ID (zeros)
 *   Z trailer:     25–38 value of debits · 39–46 number of debits · 47–60 value of credits · 61–68 number of credits
 *                  69–112 error corrections (zeros)
 * Every record is 1464 bytes, ending with CR LF. Banks add their own rules on top of the standard (data centre,
 * how many segments per record, line endings), so send a test file through the bank before the first real one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyDD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RECORD = 1464, SEGMENT = 240;
  const PAYROLL_CODE = '200'; // CPA transaction code 200: payroll deposit

  const digits = v => String(v ?? '').replace(/\D/g, '');
  /** Plain uppercase ASCII: accents dropped (é → E), anything else a bank might refuse becomes a space. */
  const ascii = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9 &\-.,'/#]/g, ' ').replace(/\s+/g, ' ').trim();
  const left = (v, n) => String(v).slice(0, n).padEnd(n, ' ');
  const right0 = (v, n) => { const s = String(v); if (s.length > n) throw new Error(`${s} doesn’t fit in ${n} digits.`); return s.padStart(n, '0'); };
  const cents = a => Math.round(Number(a) * 100);

  /** 0YYDDD: century digit 0, two-digit year, day of the year. */
  function julian(date) {
    const [y, m, d] = String(date).split('-').map(Number);
    if (!y || !m || !d) throw new Error('Dates must be YYYY-MM-DD.');
    const day = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5) + 1;
    return '0' + String(y % 100).padStart(2, '0') + String(day).padStart(3, '0');
  }

  /* ---------- checks ---------- */
  /** An employee's or the employer's bank account: '' when fine, or which part is wrong. */
  function bankProblem(b) {
    if (!b || (!digits(b.inst) && !digits(b.transit) && !digits(b.account))) return 'missing';
    if (!/^\d{3}$/.test(digits(b.inst))) return 'inst';
    if (!/^\d{5}$/.test(digits(b.transit))) return 'transit';
    if (!/^\d{5,12}$/.test(digits(b.account))) return 'account';
    return '';
  }
  /** The employer's direct deposit setup: a list of what's missing or wrong ([] when ready). */
  function setupProblems(s) {
    const p = [];
    s = s || {};
    if (!/^[A-Za-z0-9]{10}$/.test(String(s.originatorId || '').trim())) p.push('originatorId');
    if (!/^\d{5}$/.test(digits(s.dataCentre))) p.push('dataCentre');
    if (!ascii(s.shortName)) p.push('shortName');
    if (!ascii(s.longName)) p.push('longName');
    if (bankProblem({ inst: s.returnInst, transit: s.returnTransit, account: s.returnAccount })) p.push('returnAccount');
    return p;
  }

  /*
   * cpa005({ setup, fileNo, created, payDate, payments })
   *   setup:    { originatorId, dataCentre, shortName, longName, returnInst, returnTransit, returnAccount, currency }
   *   fileNo:   file creation number, 1–9999 (each file sent to the bank needs a new one)
   *   created:  'YYYY-MM-DD' the file is made; payDate: 'YYYY-MM-DD' the money reaches employees
   *   payments: [{ name, inst, transit, account, amount, ref }]
   * Returns { text, count, total } — text is the whole file.
   */
  function cpa005({ setup, fileNo, created, payDate, payments }) {
    const bad = setupProblems(setup);
    if (bad.length) throw Object.assign(new Error('Direct deposit setup is incomplete: ' + bad.join(', ')), { code: 'SETUP', fields: bad });
    const n = Number(fileNo);
    if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error('The file creation number must be 1 to 9999.');
    if (!payments || !payments.length) throw new Error('There are no direct deposits in this pay run.');
    for (const p of payments) {
      const why = bankProblem(p);
      if (why) throw Object.assign(new Error(`${p.name}: bank account ${why === 'missing' ? 'is missing' : 'isn’t valid'}`), { code: 'BANK', name: p.name, why });
      if (!(cents(p.amount) > 0)) throw new Error(`${p.name}: the deposit must be more than $0.`);
    }

    const origin = String(setup.originatorId).trim().toUpperCase();
    const fcn = right0(n, 4);
    const head = (type, count) => type + right0(count, 9) + origin + fcn;
    const due = julian(payDate);
    const returnTo = '0' + digits(setup.returnInst) + digits(setup.returnTransit);
    const lines = [];

    let count = 1;
    lines.push(left(head('A', count) + julian(created) + digits(setup.dataCentre) + left('', 20) + left(ascii(setup.currency) || 'CAD', 3), RECORD));

    let total = 0;
    for (const p of payments) {
      const amt = cents(p.amount);
      total += amt;
      const seg =
        PAYROLL_CODE + right0(amt, 10) + due +
        '0' + digits(p.inst) + digits(p.transit) + left(digits(p.account), 12) +
        '0'.repeat(22) + '000' +
        left(ascii(setup.shortName), 15) + left(ascii(p.name), 30) + left(ascii(setup.longName), 30) +
        left(origin, 10) + left(ascii(p.ref), 19) +
        returnTo + left(digits(setup.returnAccount), 12) +
        left('', 15) + left('', 22) + left('', 2) + '0'.repeat(11);
      if (seg.length !== SEGMENT) throw new Error('Internal error: segment is ' + seg.length + ' bytes.');
      count++;
      lines.push(left(head('C', count) + seg, RECORD));
    }

    count++;
    lines.push(left(head('Z', count) + right0(0, 14) + right0(0, 8) + right0(total, 14) + right0(payments.length, 8) +
      right0(0, 14) + right0(0, 8) + right0(0, 14) + right0(0, 8), RECORD));

    for (const l of lines) if (l.length !== RECORD) throw new Error('Internal error: record is ' + l.length + ' bytes.');
    return { text: lines.join('\r\n') + '\r\n', count: payments.length, total: total / 100 };
  }

  /** Read a file back (for the tests and the on-screen check): { header, payments, trailer }. */
  function parse(text) {
    const recs = String(text).split(/\r?\n/).filter(Boolean);
    const out = { header: null, payments: [], trailer: null };
    for (const r of recs) {
      const t = r[0], common = { count: +r.slice(1, 10), originatorId: r.slice(10, 20), fileNo: +r.slice(20, 24) };
      if (t === 'A') out.header = { ...common, created: r.slice(24, 30), dataCentre: r.slice(30, 35), currency: r.slice(55, 58) };
      else if (t === 'C') {
        for (let i = 0; i < 6; i++) {
          const s = r.slice(24 + i * SEGMENT, 24 + (i + 1) * SEGMENT);
          if (!s.trim()) continue;
          out.payments.push({ code: s.slice(0, 3), amount: +s.slice(3, 13) / 100, due: s.slice(13, 19), inst: s.slice(20, 23), transit: s.slice(23, 28),
            account: s.slice(28, 40).trim(), shortName: s.slice(65, 80).trim(), name: s.slice(80, 110).trim(), longName: s.slice(110, 140).trim(),
            originatorId: s.slice(140, 150), ref: s.slice(150, 169).trim(), returnInst: s.slice(170, 173), returnTransit: s.slice(173, 178), returnAccount: s.slice(178, 190).trim() });
        }
      } else if (t === 'Z') out.trailer = { ...common, debitValue: +r.slice(24, 38) / 100, debitCount: +r.slice(38, 46), creditValue: +r.slice(46, 60) / 100, creditCount: +r.slice(60, 68) };
    }
    return out;
  }

  /** Mask an account number for screens and the activity log: •••• and the last 3 digits. */
  const mask = acct => { const d = digits(acct); return d ? '••••' + d.slice(-3) : ''; };

  return { cpa005, parse, julian, bankProblem, setupProblems, mask, ascii, RECORD, SEGMENT, PAYROLL_CODE };
});
