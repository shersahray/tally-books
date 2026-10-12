/*
 * Sumlora cash flow forecast: the money expected in and out of the bank over the next 30, 60 or 90 days,
 * like QuickBooks Online's Cash flow planner. This file is the arithmetic only (no screen), so the tests can
 * check it: the screen (cashforecast.js) gathers the open invoices and bills, recurring templates, pay runs,
 * sales tax returns and the company's own planned items, and this turns them into dated lines and a daily balance.
 *
 * Works in the browser (window.TallyForecast) and in Node (require). Dates are 'YYYY-MM-DD' strings, worked out
 * in UTC so a time zone or daylight saving change can't move a day. Amounts are Canadian dollars; a line's
 * amount is signed: + money in, − money out.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./recurring-calc.js'));
  else root.TallyForecast = factory(root.TallyRecurring);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const r2 = n => Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;
  const parse = s => String(s).split('-').map(Number);
  const iso = t => t.toISOString().slice(0, 10);
  const addDays = (s, n) => { const [y, m, d] = parse(s); return iso(new Date(Date.UTC(y, m - 1, d + n))); };
  const daysBetween = (a, b) => { const [y1, m1, d1] = parse(a), [y2, m2, d2] = parse(b); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5); };
  const monthEnd = (y, m) => iso(new Date(Date.UTC(y, m, 0))); // m is 1-12
  const pad = n => String(n).padStart(2, '0');
  const DAYS = [30, 60, 90];
  // Overdue invoices "assumed paid in the next 7 days" land on the 7th day: the latest the assumption allows.
  const OVERDUE_DAYS = 7;
  const MAX_DATES = 400; // a weekly schedule over 90 days needs 13; this only stops a bad template looping

  /**
   * Open invoices and bills, on the date the money is expected.
   * docs: [{ key, kind: 'invoice' | 'bill', label, contactId, due, amount (open balance, CAD) }]
   * opts: { today, end, overdue: 'week' | 'skip' (invoices only), lateDays: { contactId: days } }
   * An invoice is expected on its due date, plus the customer's average days late when given. An overdue invoice
   * is expected within the next 7 days, or left out. An overdue bill is always counted as paid now, since it's owed.
   */
  function docItems(docs, { today, end, overdue = 'week', lateDays = null }) {
    const out = [];
    for (const d of docs || []) {
      const amt = r2(d.amount);
      if (!(amt > 0) || !d.due) continue;
      const inv = d.kind === 'invoice';
      let date = d.due, note = '';
      if (inv && lateDays && lateDays[d.contactId] > 0 && d.due >= today) { date = addDays(d.due, Math.round(lateDays[d.contactId])); note = 'late'; }
      if (d.due < today) {
        if (inv && overdue === 'skip') continue;
        date = inv ? addDays(today, OVERDUE_DAYS) : today; note = 'overdue';
      }
      if (date > end) continue;
      out.push({ key: d.key, date, amount: inv ? amt : -amt, source: inv ? 'invoice' : 'bill', label: d.label, due: d.due, note });
    }
    return out;
  }

  /** The dates of a schedule (recurring-calc's template fields) from its next date up to `to`, at most MAX_DATES. */
  function scheduleDates(r, to) {
    const dates = [];
    if (!r || r.active === false || !r.next) return dates;
    let d = r.next;
    while (d <= to && (!r.end || d <= r.end) && dates.length < MAX_DATES) { dates.push(d); d = R.after(r, d); }
    return dates;
  }

  /**
   * Recurring templates: one line for each date in the window.
   * list: [{ id, label, amount (signed CAD), lag (days from the date to the money: an invoice's or bill's terms),
   *          every, n, next, end, day, active }]
   * A date already past (a template waiting for review) counts as today. A template's money that lands after the
   * window is left out.
   */
  function recurringItems(list, { today, end }) {
    const out = [];
    for (const r of list || []) {
      const amt = r2(r.amount);
      if (!amt) continue;
      for (const d of scheduleDates(r, end)) {
        let date = addDays(d, Math.max(0, Math.round(+r.lag || 0)));
        if (date < today) date = today;
        if (date > end) continue;
        out.push({ key: `rec:${r.id}:${d}`, date, amount: amt, source: 'recurring', label: r.label, made: d });
      }
    }
    return out;
  }

  /** The pay date after `date` on a pay schedule (the same steps as the pay run form's next date). */
  function nextPayDate(freq, date) {
    const [y, m, d] = parse(date);
    if (freq === 'weekly') return addDays(date, 7);
    if (freq === 'biweekly') return addDays(date, 14);
    if (freq === 'monthly') return monthEnd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
    // Twice a month: the 15th and the last day.
    if (d <= 15 && date !== monthEnd(y, m)) return monthEnd(y, m);
    return `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-15`;
  }
  /** The remitting period a pay date falls in, and when it's due: the 15th of the month after the month (or quarter). */
  function remitPeriod(date, freq) {
    const [y, m] = parse(date);
    if (freq === 'quarterly') {
      const q = Math.ceil(m / 3), last = q * 3;
      return { key: `${y}-Q${q}`, due: `${last === 12 ? y + 1 : y}-${pad(last === 12 ? 1 : last + 1)}-15` };
    }
    return { key: `${y}-${pad(m)}`, due: `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-15` };
  }
  // A schedule whose last pay run is more than two months old has probably stopped: nothing is estimated for it.
  const STALE_DAYS = 62;

  /**
   * Payroll: the next pay runs on each schedule, estimated from its last pay run (same net pay on each pay date),
   * the source deductions those runs will owe on their remittance due dates, and remittances already owed.
   * schedules: [{ freq, last: { payDate, net, cra, rq } }]   (cra / rq: deductions plus employer share owed)
   * unpaid: [{ agency, key, label, due, amount }]   remitFreq: 'monthly' | 'quarterly'
   */
  function payrollItems({ schedules = [], unpaid = [], remitFreq = 'monthly', today, end }) {
    const out = [], remit = new Map();
    for (const s of schedules) {
      const l = s && s.last;
      if (!l || !l.payDate || daysBetween(l.payDate, today) > STALE_DAYS) continue;
      let d = l.payDate, n = 0;
      while ((d = nextPayDate(s.freq, d)) <= end && n++ < MAX_DATES) {
        if (d < today) continue; // a missed pay date isn't guessed at
        if (r2(l.net) > 0) out.push({ key: `pay:${s.freq}:${d}`, date: d, amount: -r2(l.net), source: 'payroll', label: s.freq, est: true });
        const p = remitPeriod(d, remitFreq);
        for (const ag of ['cra', 'rq']) {
          if (!(r2(l[ag]) > 0)) continue;
          const k = `${ag}|${p.key}`, x = remit.get(k) || { agency: ag, key: p.key, due: p.due, amount: 0 };
          x.amount = r2(x.amount + r2(l[ag])); remit.set(k, x);
        }
      }
    }
    for (const x of unpaid) {
      const amt = r2(x.amount);
      if (!(amt > 0)) continue;
      const date = x.due && x.due > today ? x.due : today;
      if (date > end) continue;
      out.push({ key: `remit:${x.agency}:${x.key}`, date, amount: -amt, source: 'remit', label: x.agency, period: x.key, note: x.due && x.due < today ? 'overdue' : '' });
    }
    for (const x of remit.values()) {
      if (x.due > end) continue;
      out.push({ key: `remit:est:${x.agency}:${x.key}`, date: x.due < today ? today : x.due, amount: -x.amount, source: 'remit', label: x.agency, period: x.key, est: true });
    }
    return out;
  }

  /**
   * Sales tax returns not yet filed, on their due date: the net tax owing is money out, a refund is money in
   * (expected on the due date too, though it can come later). An overdue return counts as paid today.
   * list: [{ key, tax, from, to, due, amount (+ owing, − refund) }]
   */
  function taxItems(list, { today, end }) {
    const out = [];
    for (const x of list || []) {
      const amt = r2(x.amount);
      if (!amt || !x.due) continue;
      const date = x.due < today ? today : x.due;
      if (date > end) continue;
      out.push({ key: x.key || `tax:${x.tax}:${x.to}`, date, amount: -amt, source: 'tax', label: x.tax, from: x.from, to: x.to, note: x.due < today ? 'overdue' : x.to >= today ? 'sofar' : '' });
    }
    return out;
  }

  /**
   * The company's own planned money in or out: once, or repeating every few weeks, months, quarters or years.
   * planned: [{ id, name, dir: 'in' | 'out', amount, date, every: 'once' | 'week' | 'month' | 'quarter' | 'year', n, end }]
   * A one-off dated before today is in the past: it's left out (it either happened or the plan changed).
   */
  function plannedItems(planned, { today, end }) {
    const out = [];
    for (const p of planned || []) {
      const amt = r2(p.amount);
      if (!(amt > 0) || !p.date) continue;
      const sign = p.dir === 'in' ? 1 : -1;
      const sched = p.every === 'once' || !p.every ? null : { every: p.every, n: p.n || 1, day: R.dayFor(p.date), next: p.date, end: p.end || '' };
      let dates = sched ? scheduleDates(sched, end) : (p.date <= end ? [p.date] : []);
      dates = dates.filter(d => d >= today);
      for (const d of dates) out.push({ key: `plan:${p.id}:${d}`, date: d, amount: r2(sign * amt), source: 'planned', label: p.name, planId: p.id });
    }
    return out;
  }

  /**
   * The forecast: a balance for each day from today to today + days, and the same by week.
   * start: today's balance (CAD). items: lines from the functions above. off: keys of lines the user unticked
   * (they stay in the list, marked off, and don't count).
   * Returns { start, end, items (sorted, with .off), daily: [{date, balance}], weeks: [{from, to, in, out, end, items}],
   *           low: {date, balance}, below: first date the balance goes under $0 (or ''), totalIn, totalOut }
   */
  function project({ start = 0, items = [], today, days = 30, off = [] }) {
    days = DAYS.includes(+days) ? +days : 30;
    const end = addDays(today, days), skip = new Set(off || []);
    const list = items.filter(x => x && x.date <= end).map(x => ({ ...x, date: x.date < today ? today : x.date, amount: r2(x.amount), off: skip.has(x.key) }))
      .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount || String(a.key).localeCompare(String(b.key)));
    const byDay = new Map();
    for (const x of list) if (!x.off) byDay.set(x.date, r2((byDay.get(x.date) || 0) + x.amount));
    const daily = [];
    let bal = r2(start), low = null, below = '';
    for (let i = 0; i <= days; i++) {
      const date = addDays(today, i);
      bal = r2(bal + (byDay.get(date) || 0));
      daily.push({ date, balance: bal });
      if (!low || bal < low.balance) low = { date, balance: bal };
      if (!below && bal < -0.004) below = date;
    }
    const weeks = [];
    for (let i = 0; i <= days; i += 7) {
      const from = addDays(today, i), to = addDays(today, Math.min(days, i + 6));
      const its = list.filter(x => x.date >= from && x.date <= to), on = its.filter(x => !x.off);
      weeks.push({ from, to, in: r2(on.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0)), out: r2(-on.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0)),
        end: daily[Math.min(days, i + 6)].balance, items: its });
    }
    const on = list.filter(x => !x.off);
    return { start: r2(start), today, end, days, items: list, daily, weeks, low, below,
      totalIn: r2(on.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0)), totalOut: r2(-on.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0)) };
  }

  /**
   * A customer's average days late, from paid invoices: [{ contactId, due, paid }] (paid = the last payment's date).
   * Early payments count as 0. The latest `max` invoices per customer are used. Returns { contactId: days }.
   */
  function averageLate(paid, max = 12) {
    const by = {};
    for (const p of (paid || []).slice().sort((a, b) => String(b.paid).localeCompare(String(a.paid)))) {
      if (!p.contactId || !p.due || !p.paid) continue;
      const a = by[p.contactId] = by[p.contactId] || [];
      if (a.length < max) a.push(Math.max(0, daysBetween(p.due, p.paid)));
    }
    return Object.fromEntries(Object.entries(by).map(([k, a]) => [k, Math.round(a.reduce((s, x) => s + x, 0) / a.length)]).filter(([, v]) => v > 0));
  }

  return { DAYS, OVERDUE_DAYS, addDays, daysBetween, docItems, scheduleDates, recurringItems, nextPayDate, remitPeriod, payrollItems, taxItems, plannedItems, project, averageLate };
});
