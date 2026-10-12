/*
 * Sumlora recurring transactions: the schedule and the checks that don't need the screen.
 *
 * Works in the browser (window.TallyRecurring) and in Node (require), so the server validates recurring
 * journal entries with the same rule the form uses, and the tests can check the schedule.
 *
 * A template has: every ('week' | 'month' | 'quarter' | 'year'), n (1-12), next (YYYY-MM-DD), end (optional),
 * day (the day of the month to keep; 31 = the last day, so month-end stays month-end), active, mode.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyRecurring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Dates are worked out in UTC so a time zone or daylight saving change can't move a day.
  const parse = s => { const [y, m, d] = String(s).split('-').map(Number); return { y, m, d }; };
  const iso = t => t.toISOString().slice(0, 10);
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
  const cents = n => Math.round((Number(n) || 0) * 100);

  /** The day of the month a schedule starting on `date` keeps: the date's day, or 31 when it's the month's last day. */
  function dayFor(date) {
    const { y, m, d } = parse(date);
    return d === lastDay(y, m) ? 31 : d;
  }

  /** The date after `date` on the schedule. Months keep the template's day, or the month's last day when it's shorter. */
  function after(r, date) {
    const n = Math.max(1, Math.round(+r.n || 1)), { y, m, d } = parse(date);
    if (r.every === 'week') return iso(new Date(Date.UTC(y, m - 1, d + 7 * n)));
    const months = n * (r.every === 'quarter' ? 3 : r.every === 'year' ? 12 : 1), day = +r.day || d;
    const t = new Date(Date.UTC(y, m - 1 + months, 1)), ty = t.getUTCFullYear(), tm = t.getUTCMonth() + 1;
    return iso(new Date(Date.UTC(ty, tm - 1, Math.min(day, lastDay(ty, tm)))));
  }

  /** Whether one is waiting on `today`: active, the next date has come, and it hasn't ended. */
  const isDue = (r, today) => r.active !== false && r.next <= today && (!r.end || r.next <= r.end);

  /**
   * The dates to catch up on, from the template's next date to today (at most `max`, so a template left alone
   * for years doesn't make hundreds at once). A date on or before the closing date is marked closed: it's
   * skipped, not made, because the books can't change there. `next` is where the schedule goes after them.
   */
  function plan(r, today, closingDate, max = 60) {
    const dates = [];
    let next = r.next;
    if (r.active === false) return { dates, next };
    while (next <= today && (!r.end || next <= r.end) && dates.length < max) {
      const a = after(r, next);
      dates.push({ date: next, closed: !!closingDate && next <= closingDate, after: a });
      next = a;
    }
    return { dates, next };
  }

  /** The lines of a journal entry with an amount, as posting lines (debit and credit rounded to cents). */
  const journalLines = lines => (Array.isArray(lines) ? lines : []).filter(l => l && (cents(l.debit) || cents(l.credit)))
    .map(l => ({ account: String(l.account || ''), debit: cents(l.debit) / 100, credit: cents(l.credit) / 100, memo: String(l.memo || '').slice(0, 500) }));

  /** What's wrong with a journal entry's lines, in plain words, or '' when it balances. */
  function journalProblem(lines) {
    const ls = (Array.isArray(lines) ? lines : []).filter(l => l && typeof l === 'object' && (l.account || +l.debit || +l.credit));
    let dr = 0, cr = 0, n = 0;
    for (const l of ls) {
      const d = Number(l.debit || 0), c = Number(l.credit || 0);
      if (!Number.isFinite(d) || !Number.isFinite(c)) return 'Line amounts must be numbers.';
      if (!l.account) return 'Every line with an amount needs an account.';
      if (d && c) return 'Put each line in either Debit or Credit, not both.';
      if (d < 0 || c < 0) return 'Use positive amounts; switch columns instead of using negatives.';
      if (d || c) n++;
      dr += cents(d); cr += cents(c);
    }
    if (n < 2 || !dr || !cr) return 'A journal entry needs at least one debit and one credit.';
    if (dr !== cr) return `Debits and credits are out by ${((dr - cr) / 100).toFixed(2)}.`;
    return '';
  }

  /** A transfer's posting: into `to`, out of `from`. */
  const transferLines = t => [{ account: t.to, debit: cents(t.amount) / 100, credit: 0 }, { account: t.from, debit: 0, credit: cents(t.amount) / 100 }];

  /** The total of a journal entry or transfer template (invoices, bills, expenses and deposits need sales tax, so the screen works those out). */
  function total(r) {
    if (r.kind === 'transfer') return cents(r.amount) / 100;
    if (r.kind === 'journal') return journalLines(r.lines).reduce((s, l) => s + cents(l.debit), 0) / 100;
    return 0;
  }

  return { dayFor, after, isDue, plan, journalLines, journalProblem, transferLines, total };
});
