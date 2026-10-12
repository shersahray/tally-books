/*
 * Custom roles: what a staff member with a firm's own role can see and change (like QuickBooks Online
 * Advanced's custom user roles). A role gives each area of the books None, View or Edit.
 * Owners, plain staff and clients don't have one; they keep working as before (null permissions = no limits here).
 * Works in the browser (window.TallyRoles) and in Node (require), so the server enforces the same rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyRoles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AREAS = {
    sales: { label: 'Sales', desc: 'Customers, invoices, sales receipts, credit notes, estimates, projects and payments received' },
    expenses: { label: 'Expenses', desc: 'Vendors, bills, expenses, vendor credits, purchase orders, mileage and receipts' },
    banking: { label: 'Banking', desc: 'Bank lines for review, bank rules, bank feeds, reconciliation, deposits and transfers' },
    payroll: { label: 'Payroll', desc: 'Employees and pay runs. With View, social insurance numbers and bank account numbers stay hidden.' },
    reports: { label: 'Reports', desc: 'Reports, budgets, saved reports and the AI assistant' },
    accounting: { label: 'Accounting', desc: 'Chart of accounts, journal entries, fixed assets, classes and the review tools' },
    salestax: { label: 'Sales tax', desc: 'GST/HST, QST and PST returns, filings and payments' },
    settings: { label: 'Settings', desc: 'Company settings, email, online payments, logo and the activity log' },
  };
  const LEVELS = ['none', 'view', 'edit'];
  const RANK = { none: 0, view: 1, edit: 2 };
  const MAX_ROLES = 30;

  /** Can someone with these permissions do this? null permissions (owners, plain staff, clients) aren't limited here. */
  const can = (perms, area, level = 'view') => !perms || RANK[perms[area] || 'none'] >= RANK[level];
  /** Has Edit in at least one area. */
  const editsSomething = perms => !perms || Object.keys(AREAS).some(a => perms[a] === 'edit');

  // Which area each kind of transaction belongs to.
  const ENTRY_AREA = {
    invoice: 'sales', salesreceipt: 'sales', payment: 'sales', credit: 'sales', refund: 'sales',
    bill: 'expenses', billpayment: 'expenses', expense: 'expenses', vcredit: 'expenses', vrefund: 'expenses',
    deposit: 'banking', transfer: 'banking',
    journal: 'accounting', invadjust: 'accounting',
    taxpayment: 'salestax', qmadjust: 'salestax',
    payrun: 'payroll', payremit: 'payroll',
  };
  const SALES_DOCS = ['invoice', 'sreceipt', 'credit'];

  /** The area a record belongs to, from its collection (and its kind or type where that matters). */
  function recordArea(col, r) {
    r = r || {};
    switch (col) {
      case 'accounts': case 'assets': return 'accounting';
      case 'contacts': return r.kind === 'vendor' ? 'expenses' : 'sales';
      case 'items': return r.sold === false && r.bought ? 'expenses' : 'sales';
      case 'docs': return SALES_DOCS.includes(r.kind) ? 'sales' : 'expenses';
      // Recurring invoices and bills, and recurring transactions (expense, deposit, transfer, journal entry).
      case 'recurring': return r.kind === 'invoice' ? 'sales' : r.kind === 'bill' ? 'expenses' : (ENTRY_AREA[r.kind] || 'accounting');
      case 'entries': return ENTRY_AREA[r.type] || 'accounting';
      case 'estimates': case 'projects': case 'times': return 'sales';
      case 'pos': case 'trips': case 'receipts': case 'vehicles': return 'expenses';
      case 'bankTxns': case 'rules': case 'recons': return 'banking';
      case 'employees': case 'payruns': return 'payroll';
      case 'filings': return 'salestax';
      case 'budgets': return 'reports';
      default: return 'accounting';
    }
  }

  /**
   * The areas a write needs Edit in. A transaction changed only by ticking it as cleared (reconciliation), or a
   * bank account's import settings, need Banking; anything else needs the area of the record before and after the change.
   */
  function writeAreas(col, data, before) {
    const bankOnly = BANK_FIELDS[col];
    if (bankOnly && data && before && JSON.stringify(sortKeys(data, bankOnly)) === JSON.stringify(sortKeys(before, bankOnly))) return ['banking'];
    const out = new Set();
    if (before) out.add(recordArea(col, before));
    if (data) out.add(recordArea(col, data));
    return [...out];
  }
  // Fields the Banking screens change on other records: cleared/reconciled marks on transactions, and the
  // statement import settings and last statement kept on a bank account.
  const BANK_FIELDS = { entries: ['clear'], accounts: ['importMap', 'lastStatement'] };
  const sortKeys = (o, skip) => Object.keys(o).filter(k => k !== 'id' && !skip.includes(k)).sort().reduce((m, k) => { m[k] = o[k]; return m; }, {});

  // Company settings that belong to an area other than Settings (saved from that area's screens).
  const SETTING_AREA = {
    payroll: 'payroll',
    quickMethod: 'salestax', qstRate: 'salestax', pstRate: 'salestax', pstName: 'salestax', pstFreq: 'salestax', filingFreq: 'salestax', taxName: 'salestax', taxRate: 'salestax',
    savedReports: 'reports',
    notDuplicates: 'accounting', classes: 'accounting', ccaOpening: 'accounting',
    mileage: 'expenses',
    lateFee: 'sales', invoiceNote: 'sales', docStyle: 'sales', customFields: 'sales', etransfer: 'sales',
  };
  const settingArea = key => SETTING_AREA[key] || 'settings';

  /** A role as saved: a name and a level for every area. Throws a plain-English Error when something's wrong. */
  function cleanRole(data, others = []) {
    data = data && typeof data === 'object' ? data : {};
    const name = String(data.name || '').trim().slice(0, 40);
    if (!name) throw new Error('Enter a name for the role.');
    if (others.some(r => r.name.toLowerCase() === name.toLowerCase())) throw new Error('There’s already a role with that name.');
    const src = data.perms && typeof data.perms === 'object' ? data.perms : {};
    const perms = Object.fromEntries(Object.keys(AREAS).map(a => [a, LEVELS.includes(src[a]) ? src[a] : 'none']));
    return { name, perms };
  }

  return { AREAS, LEVELS, MAX_ROLES, can, editsSomething, recordArea, writeAreas, settingArea, cleanRole, ENTRY_AREA };
});
