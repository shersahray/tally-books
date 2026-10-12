/*
 * Workflow reminders (like QuickBooks Online Advanced's workflow automation): simple "when this happens, remind
 * someone" rules. Each company turns on ready-made templates and adjusts them (Settings → Workflows); the server
 * checks them every hour and when the company is opened, and puts reminders in each person's Reminders list.
 * Works in the browser (window.TallyWorkflows, used by the demo) and in Node (require), so the tests can check it.
 *
 * Company setting `workflows`: { rules: { <template>: { on, days, repeat, who, people, digest, customer } } }
 *   days      the template's N: days overdue, days before it's due, or days waiting
 *   repeat    invoices only: remind again every this many days while it stays overdue (0 = once)
 *   who       owners | staff (everyone at the firm who can open these books) | people (chosen) | approvers (bills waiting)
 *   digest    also email each person a daily digest of new reminders (through the server's mailbox)
 *   customer  overdue invoices and estimates only: also email the customer (from the company's own mailbox)
 * Reminders (company setting `reminders`, written only by the server): { items: { <key>: reminder }, cust: { <record>: day } }
 *   A reminder's key is its rule, its record and the date it's about (a due date, a sending), so checking again never
 *   repeats one. A reminder whose reason has gone (the invoice was paid) is marked done and leaves everyone's list.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./roles.js'), require('./payroll-calc.js'));
  else root.TallyWorkflows = factory(root.TallyRoles, root.TallyPayroll);
})(typeof self !== 'undefined' ? self : this, function (ROLES, PR) {
  'use strict';
  const PRx = () => PR || (typeof self !== 'undefined' && self.TallyPayroll); // loaded after this file in the browser

  // The ready-made rules. area: who can be reminded (custom roles that can view it); feature: also needs that plan feature.
  const TEMPLATES = {
    invoiceOverdue: { area: 'sales', days: 7, repeat: 7, who: 'staff', customer: true, label: 'Invoice overdue', desc: 'Remind when an invoice is overdue, and again while it stays unpaid. Can also email the customer a payment reminder.', daysLabel: 'Days overdue' },
    billDue: { area: 'expenses', days: 3, who: 'staff', label: 'Bill coming due', desc: 'Remind the people who pay bills before a bill is due.', daysLabel: 'Days before it’s due' },
    billApproval: { area: 'expenses', days: 2, who: 'approvers', feature: 'billApprovals', label: 'Bill waiting for approval', desc: 'Remind the approvers when a bill has waited too long for approval.', daysLabel: 'Days waiting' },
    bankReview: { area: 'banking', days: 7, who: 'staff', label: 'Bank lines to review', desc: 'Remind when bank lines have waited in For review.', daysLabel: 'Days waiting' },
    estimateFollowup: { area: 'sales', days: 7, who: 'staff', customer: true, label: 'Estimate not accepted', desc: 'Remind to follow up on an estimate that was sent and isn’t accepted yet. Can also email the customer.', daysLabel: 'Days after it was sent' },
    payrollRemit: { area: 'payroll', days: 5, who: 'staff', feature: 'payroll', label: 'Payroll remittance coming due', desc: 'Remind before source deductions are due to CRA or Revenu Québec.', daysLabel: 'Days before it’s due' },
    salesTaxDue: { area: 'salestax', days: 7, who: 'staff', label: 'Sales tax return coming due', desc: 'Remind before a GST/HST, QST or PST return is due.', daysLabel: 'Days before it’s due' },
    receiptsInbox: { area: 'expenses', days: 3, who: 'staff', label: 'Receipts not dealt with', desc: 'Remind when receipts have waited in the Receipts inbox.', daysLabel: 'Days waiting' },
  };
  const KEYS = Object.keys(TEMPLATES);
  const WHO = { owners: 'Owners', staff: 'Everyone with access', people: 'Chosen people', approvers: 'Bill approvers' };
  const MAX_PEOPLE = 100, MAX_ITEMS = 3000, KEEP_DONE_DAYS = 60, LATE_WINDOW = 30;
  const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const int = (v, lo, hi, dflt) => { if (v === undefined || v === null || v === '') return dflt; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) return NaN; return n; };

  /** The `workflows` company setting, checked. Throws a plain-English Error when something's wrong. */
  function clean(s) {
    if (s === undefined || s === null) return { rules: {} };
    if (!isObj(s)) throw new Error('Workflow settings must be an object.');
    const src = s.rules === undefined ? {} : s.rules;
    if (!isObj(src)) throw new Error('Workflow rules must be an object.');
    const rules = {};
    for (const [k, r] of Object.entries(src)) {
      const t = TEMPLATES[k];
      if (!t) continue; // a template that no longer exists
      if (!isObj(r)) throw new Error('Each workflow rule must be an object.');
      const days = int(r.days, 0, 365, t.days);
      if (Number.isNaN(days)) throw new Error(`${t.label}: enter a number of days from 0 to 365.`);
      const out = { on: !!r.on, days };
      if (t.repeat !== undefined) {
        const rep = int(r.repeat, 0, 365, t.repeat);
        if (Number.isNaN(rep)) throw new Error(`${t.label}: remind again every 0 to 365 days (0 = once).`);
        out.repeat = rep;
      }
      const who = r.who === undefined ? t.who : r.who;
      if (!WHO[who] || (who === 'approvers' && k !== 'billApproval')) throw new Error(`${t.label}: choose who gets reminded.`);
      out.who = who;
      const people = [...new Set((Array.isArray(r.people) ? r.people : []).map(x => String(x || '').slice(0, 80)).filter(Boolean))];
      if (people.length > MAX_PEOPLE) throw new Error(`${t.label}: choose at most ${MAX_PEOPLE} people.`);
      if (who === 'people' && out.on && !people.length) throw new Error(`${t.label}: choose at least one person to remind.`);
      out.people = who === 'people' ? people : [];
      out.digest = !!r.digest;
      if (t.customer) out.customer = !!r.customer;
      rules[k] = out;
    }
    return { rules };
  }
  /** A rule with the template's defaults filled in (off unless turned on). */
  function rule(settings, key) {
    const t = TEMPLATES[key], r = ((settings && settings.rules) || {})[key] || {};
    return { on: !!r.on, days: r.days ?? t.days, ...(t.repeat !== undefined ? { repeat: r.repeat ?? t.repeat } : {}), who: r.who || t.who, people: r.people || [], digest: !!r.digest, ...(t.customer ? { customer: !!r.customer } : {}) };
  }
  const anyOn = settings => KEYS.some(k => rule(settings, k).on);

  /* ---------- dates (YYYY-MM-DD, local) ---------- */
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const pd = s => new Date(s + 'T12:00:00');
  const dayOf = ms => iso(new Date(Number(ms) || 0));
  const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

  /* ---------- what's open in the books ---------- */
  /** What's still owing on each invoice and bill: payments and credits used, like the company list's summary. */
  function balances(docs, entries) {
    const paid = {};
    for (const e of entries) if (e.applyTo) paid[e.applyTo] = (paid[e.applyTo] || 0) + (Number(e.amount) || 0);
    for (const c of docs) for (const a of c.applied || []) { paid[a.docId] = (paid[a.docId] || 0) + (Number(a.amount) || 0); paid[c.id] = (paid[c.id] || 0) + (Number(a.amount) || 0); }
    const byId = new Map(docs.map(d => [d.id, d]));
    return id => { const d = byId.get(id); return d ? r2((Number(d.total) || 0) - (paid[id] || 0)) : 0; };
  }
  /**
   * Source deductions owed for each agency and remitting period, worked out as on Payroll → Remittances (payroll.js):
   * void pay runs left out, CRA and Revenu Québec each on their own frequency (Revenu Québec's is CRA's unless set),
   * accelerated periods, due dates moved to the next business day, and a pay date inside a period paid under an
   * earlier frequency kept in that period. company: the company settings (payroll and province).
   */
  function remittances(payruns, entries, company) {
    const P = PRx(), m = {}, pc = (company && company.payroll) || {}, prov = (company && company.province) || '';
    const freqOf = ag => (ag === 'rq' ? (pc.remitFreqRq || pc.remitFreq || 'monthly') : (pc.remitFreq || 'monthly'));
    const paidKeys = ag => [...new Set(entries.filter(e => e.type === 'payremit' && e.agency === ag).map(e => e.period))];
    const paid = { cra: paidKeys('cra'), rq: paidKeys('rq') };
    for (const r of payruns) {
      if (!isDate(r.payDate) || r.void) continue; // a void pay run owes nothing
      for (const ag of ['cra', 'rq']) {
        const owed = r2((r.lines || []).reduce((s, l) => s + (P.remitSplit(l.ded || {}, l.er || {})[ag] || 0), 0));
        if (!owed) continue;
        const p = P.remitPeriodFor(r.payDate, freqOf(ag), ag, prov, paid[ag]);
        const x = m[ag + '|' + p.key] = m[ag + '|' + p.key] || { agency: ag, key: p.key, due: p.due, owed: 0, paid: 0 };
        x.owed = r2(x.owed + owed);
      }
    }
    for (const e of entries) if (e.type === 'payremit' && m[e.agency + '|' + e.period]) m[e.agency + '|' + e.period].paid = r2(m[e.agency + '|' + e.period].paid + (Number(e.amount) || 0));
    return Object.values(m).map(x => ({ ...x, bal: r2(x.owed - x.paid) }));
  }
  /** Sales tax returns and when they're due (as on the Sales tax page), with whether each was filed. */
  function taxReturns(company, accounts, entries, filings, today) {
    const by = d => accounts.find(a => a.detail === d);
    if (!by('tax')) return [];
    const taxes = by('qst') && Number(company.qstRate) > 0 ? ['gst', 'qst'] : by('pst') && Number(company.pstRate) > 0 ? ['gst', 'pst'] : ['gst'];
    const ids = new Set(accounts.filter(a => ['tax', 'qst', 'pst'].includes(a.detail)).map(a => a.id));
    let first = today;
    for (const e of entries) if (!e.opening && e.date < first && (e.lines || []).some(l => ids.has(l.account))) first = e.date;
    for (const f of filings) if (f.from < first) first = f.from;
    const fy = Number(company.fyStart) || 1, fd = pd(first);
    const fyStart = `${fd.getMonth() + 1 < fy ? fd.getFullYear() - 1 : fd.getFullYear()}-${pad(fy)}-01`;
    const out = [];
    for (const k of taxes) {
      const freq = k === 'pst' ? company.pstFreq : company.filingFreq;
      const step = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }[freq || 'quarterly'] || 3;
      const mb = k === 'pst' && ['MB', 'SK'].includes(company.province);
      let d = pd(fyStart);
      const end = pd(today);
      for (let n = 0; d <= end && n < 400; n++) {
        const to = new Date(d.getFullYear(), d.getMonth() + step, 0);
        const due = mb ? new Date(to.getFullYear(), to.getMonth() + 1, 20) : k === 'pst' ? new Date(to.getFullYear(), to.getMonth() + 2, 0) : new Date(to.getFullYear(), to.getMonth() + (step === 12 ? 4 : 2), 0);
        if (iso(to) >= first) out.push({ tax: k, from: iso(d), to: iso(to), due: iso(due), filed: filings.some(f => f.tax === k && f.from === iso(d) && f.to === iso(to)),
          label: k === 'qst' ? 'QST' : k === 'pst' ? (company.pstName || 'PST') : taxes.length > 1 ? 'GST' : (company.taxName || 'GST/HST') });
        d = new Date(d.getFullYear(), d.getMonth() + step, 1);
      }
    }
    return out;
  }

  /* ---------- who gets reminded ---------- */
  /**
   * people: everyone at the firm who can open these books: [{ id, role, perms, username, approver }]. Clients never.
   * Only people whose role can view the rule's area are reminded. A bill waiting for approval isn't sent to the person
   * who entered it (they can't approve it), unless they're the only owner.
   */
  function recipients(r, t, people, hit, owners) {
    let list = people.filter(p => p && p.role !== 'client');
    if (r.who === 'owners') list = list.filter(p => p.role === 'owner');
    else if (r.who === 'people') list = list.filter(p => r.people.includes(p.id));
    else if (r.who === 'approvers') list = list.filter(p => p.approver);
    list = list.filter(p => ROLES.can(p.perms || null, t.area, 'view'));
    if (hit && hit.enteredBy) list = list.filter(p => p.username !== hit.enteredBy || (p.role === 'owner' && owners <= 1));
    return list.map(p => p.id).sort();
  }

  /* ---------- the rules ---------- */
  /**
   * What each rule that's on finds in the books today. books: { company, accounts, contacts, docs, entries, estimates,
   * bankTxns, receipts, payruns, filings }. features: { payroll, billApprovals } (on for this company, and for bill
   * approvals, turned on in its settings). Returns [{ key, rule, area, col, id, due, vars, to }].
   */
  function evaluate({ settings, books, people = [], today, features = {}, owners = 1 }) {
    const out = [], b = { docs: [], entries: [], estimates: [], bankTxns: [], receipts: [], payruns: [], filings: [], accounts: [], contacts: [], company: {}, ...books };
    const name = id => ((b.contacts.find(c => c.id === id) || {}).name || '');
    const bal = balances(b.docs, b.entries);
    for (const k of KEYS) {
      const r = rule(settings, k), t = TEMPLATES[k];
      if (!r.on || (t.feature && !features[t.feature])) continue;
      const add = (key, col, id, due, vars, extra) => out.push({ key: k + '|' + key, rule: k, area: t.area, col, id, due, vars, to: recipients(r, t, people, extra, owners) });
      if (k === 'invoiceOverdue') {
        for (const d of b.docs) {
          if (d.kind !== 'invoice' || !isDate(d.due)) continue;
          const late = daysBetween(d.due, today), left = bal(d.id);
          const n = Math.max(1, r.days); // overdue means at least a day late
          if (left <= 0.004 || late < n) continue;
          const cycle = r.repeat > 0 ? Math.floor((late - n) / r.repeat) : 0;
          add(`${d.id}|${d.due}|${cycle}`, 'docs', d.id, d.due, { number: d.number || '', who: name(d.contactId), amount: left, currency: d.currency || '' });
        }
      } else if (k === 'billDue') {
        for (const d of b.docs) {
          if (d.kind !== 'bill' || !isDate(d.due)) continue;
          const until = daysBetween(today, d.due), left = bal(d.id);
          if (left <= 0.004 || until > r.days || until < -LATE_WINDOW) continue;
          add(`${d.id}|${d.due}`, 'docs', d.id, d.due, { number: d.number || '', who: name(d.contactId), amount: left, currency: d.currency || '' });
        }
      } else if (k === 'billApproval') {
        for (const d of b.docs) {
          const a = d.kind === 'bill' && isObj(d.approval) ? d.approval : null;
          if (!a || a.status !== 'waiting') continue;
          const sent = (a.history || []).filter(h => ['submitted', 'resubmitted', 'changed'].includes(h.action)).pop();
          const since = sent && sent.at ? dayOf(sent.at) : d.date;
          if (!isDate(since) || daysBetween(since, today) < r.days) continue;
          add(`${d.id}|${since}`, 'docs', d.id, since, { number: d.number || '', who: name(d.contactId), amount: r2(d.total), currency: d.currency || '' }, { enteredBy: a.enteredBy });
        }
      } else if (k === 'bankReview') {
        const by = {};
        for (const x of b.bankTxns) {
          if (x.status !== 'new') continue;
          const since = x.imported ? dayOf(x.imported) : x.date;
          if (!isDate(since) || daysBetween(since, today) < r.days) continue;
          const g = by[x.account] = by[x.account] || { count: 0, since };
          g.count++; if (since < g.since) g.since = since;
        }
        for (const [acct, g] of Object.entries(by)) add(acct, 'bankTxns', acct, g.since, { count: g.count, account: ((b.accounts.find(a => a.id === acct) || {}).name || ''), days: r.days });
      } else if (k === 'estimateFollowup') {
        for (const x of b.estimates) {
          if ((x.status || 'open') !== 'open' || x.invoiceId || (x.expires && x.expires < today)) continue;
          const s = (x.sent || []).filter(e => e && e.what !== 'followup').pop();
          const sent = s && s.at ? dayOf(s.at) : x.date;
          if (!isDate(sent) || daysBetween(sent, today) < r.days) continue;
          add(`${x.id}|${sent}`, 'estimates', x.id, sent, { number: x.number || '', who: name(x.contactId), amount: r2(x.total) });
        }
      } else if (k === 'payrollRemit') {
        for (const x of remittances(b.payruns, b.entries, b.company)) {
          const until = daysBetween(today, x.due);
          if (x.bal <= 0.004 || until > r.days || until < -LATE_WINDOW) continue;
          add(`${x.agency}|${x.key}`, 'payroll', x.agency, x.due, { agency: x.agency, period: x.key, amount: x.bal });
        }
      } else if (k === 'salesTaxDue') {
        for (const x of taxReturns(b.company, b.accounts, b.entries, b.filings, today)) {
          const until = daysBetween(today, x.due);
          if (x.filed || until > r.days || until < -LATE_WINDOW) continue;
          add(`${x.tax}|${x.to}`, 'salestax', x.tax, x.due, { tax: x.label, from: x.from, to: x.to });
        }
      } else if (k === 'receiptsInbox') {
        let count = 0, since = '';
        for (const x of b.receipts) {
          if (x.status !== 'inbox') continue;
          const s = x.uploadedAt ? dayOf(x.uploadedAt) : '';
          if (!isDate(s) || daysBetween(s, today) < r.days) continue;
          count++; if (!since || s < since) since = s;
        }
        if (count) add('inbox', 'receipts', '', since, { count, days: r.days });
      }
    }
    return out;
  }

  /* ---------- the stored reminders ---------- */
  /** The stored reminders, tidied (only the server writes them, but a damaged value mustn't break anything). */
  function cleanStore(s) {
    s = isObj(s) ? s : {};
    const items = {};
    for (const [k, r] of Object.entries(isObj(s.items) ? s.items : {})) if (isObj(r) && TEMPLATES[r.rule] && Array.isArray(r.to)) items[k] = { dismissed: {}, snooze: {}, mailed: {}, ...r, key: k };
    return { items, cust: isObj(s.cust) ? { ...s.cust } : {}, digest: isObj(s.digest) ? { ...s.digest } : {} };
  }
  /**
   * Bring the stored reminders up to date with what the rules found now. New ones are added (each key once); ones still
   * found keep their dismissed and snoozed marks and get today's figures and people; ones no longer found are marked done.
   * Returns { store, created, changed }.
   */
  function sync(prev, hits, now = Date.now()) {
    const s = cleanStore(prev), items = { ...s.items }, created = [], seen = new Set();
    let changed = false;
    for (const h of hits) {
      if (seen.has(h.key)) continue;
      seen.add(h.key);
      const cur = items[h.key];
      if (cur && !cur.done) {
        if (JSON.stringify([cur.vars, cur.to, cur.due]) !== JSON.stringify([h.vars, h.to, h.due])) { items[h.key] = { ...cur, vars: h.vars, to: h.to, due: h.due }; changed = true; }
        continue;
      }
      if (!h.to.length) continue; // nobody who can see it to remind
      const r = { key: h.key, rule: h.rule, area: h.area, col: h.col, id: h.id, due: h.due, vars: h.vars, to: h.to, created: now, done: 0, dismissed: {}, snooze: {}, mailed: {} };
      items[h.key] = r; created.push(r); changed = true;
    }
    for (const [k, r] of Object.entries(items)) if (!r.done && !seen.has(k)) { items[k] = { ...r, done: now }; changed = true; }
    // Keep done reminders for a while (so the same one isn't made again by a brief change), then let them go.
    for (const [k, r] of Object.entries(items)) if (r.done && now - r.done > KEEP_DONE_DAYS * 864e5) { delete items[k]; changed = true; }
    const keys = Object.keys(items);
    if (keys.length > MAX_ITEMS) {
      keys.sort((a, b) => (items[a].done ? 0 : 1) - (items[b].done ? 0 : 1) || items[a].created - items[b].created).slice(0, keys.length - MAX_ITEMS).forEach(k => delete items[k]);
      changed = true;
    }
    return { store: { items, cust: s.cust, digest: s.digest }, created, changed };
  }
  /** Is this reminder in this person's list today (theirs, not done, not dismissed, not snoozed past today)? */
  const shows = (r, uid, today) => !r.done && r.to.includes(uid) && !r.dismissed[uid] && !(r.snooze[uid] && r.snooze[uid] > today);
  /** This person's reminders, newest first. canView(area) leaves out what their role can no longer see. */
  function forUser(store, uid, today, canView = () => true) {
    return Object.values(cleanStore(store).items).filter(r => shows(r, uid, today) && canView(r.area))
      .sort((a, b) => b.created - a.created || a.key.localeCompare(b.key)).slice(0, 200)
      .map(({ key, rule: k, area, col, id, due, vars, created }) => ({ key, rule: k, area, col, id, due, vars, created }));
  }
  /** Dismiss a reminder, or snooze it for some days. Throws a plain-English Error when it can't. */
  function act(store, key, uid, action, days, today) {
    const s = cleanStore(store), r = s.items[String(key || '')];
    if (!r || r.done || !r.to.includes(uid)) throw new Error('That reminder isn’t in your list any more.');
    if (action === 'dismiss') r.dismissed = { ...r.dismissed, [uid]: Date.now() };
    else if (action === 'snooze') {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error('Snooze for 1 to 30 days.');
      r.snooze = { ...r.snooze, [uid]: addDays(today, n) };
    } else throw new Error('Choose dismiss or snooze.');
    return s;
  }

  /* ---------- words ---------- */
  const DEF_FMT = lang => ({
    money: (n, cur) => { try { return new Intl.NumberFormat(lang === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur || 'CAD' }).format(Number(n) || 0); } catch (e) { return '$' + (Number(n) || 0).toFixed(2); } },
    date: s => (isDate(s) ? pd(s).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : ''),
  });
  const AGENCY = { cra: 'CRA', rq: 'Revenu Québec' };
  const AGENCY_FR = { cra: 'l’ARC', rq: 'Revenu Québec' };
  /** One line for a reminder, in English or French. fmt: { money(n, currency), date(iso) } (the server's own by default). */
  function describe(r, lang = 'en', today, fmt) {
    const f = fmt || DEF_FMT(lang), v = r.vars || {}, fr = lang === 'fr';
    const num = v.number ? (fr ? ` no ${v.number}` : ` #${v.number}`) : '';
    const who = v.who || '';
    const late = today && isDate(r.due) ? daysBetween(r.due, today) : 0;
    const s = (n, one, many) => (n === 1 ? one : many);
    switch (r.rule) {
      case 'invoiceOverdue': return fr ? `La facture${num}${who ? ` de ${who}` : ''} est en retard de ${late} ${s(late, 'jour', 'jours')} (${f.money(v.amount, v.currency)} à recevoir).`
        : `Invoice${num}${who ? ` for ${who}` : ''} is ${late} ${s(late, 'day', 'days')} overdue (${f.money(v.amount, v.currency)} owing).`;
      case 'billDue': return late > 0 ? (fr ? `La facture fournisseur${num}${who ? ` de ${who}` : ''} de ${f.money(v.amount, v.currency)} était payable le ${f.date(r.due)}.` : `Bill${num}${who ? ` from ${who}` : ''} for ${f.money(v.amount, v.currency)} was due ${f.date(r.due)}.`)
        : (fr ? `La facture fournisseur${num}${who ? ` de ${who}` : ''} de ${f.money(v.amount, v.currency)} est payable le ${f.date(r.due)}.` : `Bill${num}${who ? ` from ${who}` : ''} for ${f.money(v.amount, v.currency)} is due ${f.date(r.due)}.`);
      case 'billApproval': return fr ? `La facture fournisseur${num}${who ? ` de ${who}` : ''} de ${f.money(v.amount, v.currency)} attend une approbation depuis le ${f.date(r.due)}.`
        : `Bill${num}${who ? ` from ${who}` : ''} for ${f.money(v.amount, v.currency)} has waited for approval since ${f.date(r.due)}.`;
      case 'bankReview': return fr ? `${v.count} ${s(v.count, 'opération bancaire', 'opérations bancaires')}${v.account ? ` dans ${v.account}` : ''} ${s(v.count, 'attend', 'attendent')} d’être ${s(v.count, 'vérifiée', 'vérifiées')} depuis ${v.days} jours ou plus.`
        : `${v.count} bank ${s(v.count, 'line', 'lines')}${v.account ? ` in ${v.account}` : ''} ${s(v.count, 'has', 'have')} waited ${v.days} days or more for review.`;
      case 'estimateFollowup': return fr ? `La soumission${num}${who ? ` pour ${who}` : ''} (${f.money(v.amount)}) envoyée le ${f.date(r.due)} n’est pas encore acceptée.`
        : `Estimate${num}${who ? ` for ${who}` : ''} (${f.money(v.amount)}) sent ${f.date(r.due)} isn’t accepted yet.`;
      case 'payrollRemit': return fr ? `Les retenues à la source à verser à ${AGENCY_FR[v.agency] || v.agency} pour ${v.period} (${f.money(v.amount)}) sont dues le ${f.date(r.due)}.`
        : `Source deductions for ${AGENCY[v.agency] || v.agency} for ${v.period} (${f.money(v.amount)}) are due ${f.date(r.due)}.`;
      case 'salesTaxDue': return fr ? `La déclaration de ${v.tax === 'GST/HST' ? 'TPS/TVH' : v.tax === 'GST' ? 'TPS' : v.tax === 'QST' ? 'TVQ' : v.tax} du ${f.date(v.from)} au ${f.date(v.to)} est à produire au plus tard le ${f.date(r.due)}.`
        : `The ${v.tax} return for ${f.date(v.from)} to ${f.date(v.to)} is due ${f.date(r.due)}.`;
      case 'receiptsInbox': return fr ? `${v.count} ${s(v.count, 'reçu attend', 'reçus attendent')} dans la boîte de réception des reçus depuis ${v.days} jours ou plus.`
        : `${v.count} ${s(v.count, 'receipt has', 'receipts have')} waited ${v.days} days or more in the Receipts inbox.`;
      default: return '';
    }
  }
  /**
   * The email to a customer: a payment reminder for an overdue invoice (the same words as Sales → Send reminder,
   * without the attachment) or a follow-up on an estimate. v: { company, name, num, amount, due, pay }.
   */
  function customerEmail(kind, v, lang = 'en') {
    const fr = lang === 'fr', co = v.company;
    const pay = v.pay ? `\n\n${v.pay}` : '';
    if (kind === 'invoice') return fr
      ? [`Rappel : facture ${v.num} en souffrance`, `Bonjour ${v.name},\n\nNous vous rappelons que la facture ${v.num}, d’un solde de ${v.amount}, était payable le ${v.due}. Si vous l’avez déjà réglée, merci et veuillez ne pas tenir compte de ce message.${pay}\n\nMerci,\n${co}`]
      : [`Reminder: invoice ${v.num} is past due`, `Hello ${v.name},\n\nThis is a friendly reminder that invoice ${v.num}, with ${v.amount} still owing, was due on ${v.due}. If you’ve already paid, thank you, and please disregard this message.${pay}\n\nThank you,\n${co}`];
    return fr
      ? [`Suivi : soumission ${v.num} de ${co}`, `Bonjour ${v.name},\n\nJe fais un suivi au sujet de la soumission ${v.num} de ${v.amount}${v.due ? `, valide jusqu’au ${v.due}` : ''}. N’hésitez pas à me faire part de vos questions, ou à me dire si vous souhaitez aller de l’avant.${pay}\n\nMerci,\n${co}`]
      : [`Following up: estimate ${v.num} from ${co}`, `Hello ${v.name},\n\nI’m following up on estimate ${v.num} for ${v.amount}${v.due ? `, good until ${v.due}` : ''}. Let me know if you have any questions, or if you’d like to go ahead.${pay}\n\nThank you,\n${co}`];
  }
  /**
   * Can the customer be emailed about this record now? last: { day, ok } from the last try, or nothing. A sent email is
   * sent again only after `every` days (0 = never); a try that failed is tried again the next day.
   */
  const customerDue = (last, today, every) => !last || (last.ok ? every > 0 && daysBetween(last.day, today) >= every : daysBetween(last.day, today) >= 1);

  return { TEMPLATES, KEYS, WHO, fmt: DEF_FMT, clean, rule, anyOn, evaluate, recipients, remittances, taxReturns, balances, cleanStore, sync, shows, forUser, act, describe, customerEmail, customerDue, dayOf, addDays, daysBetween };
});
