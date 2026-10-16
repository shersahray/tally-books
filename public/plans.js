/*
 * Sumlora plans. Each firm on a server has a plan; the plan decides which extra features its companies
 * can use, and inside that, each company can switch features off (a client who doesn't need payroll).
 * Three plans: Seed, Grow and Thrive. Payroll is hidden for now ("coming soon", see COMING_SOON below); when it's
 * turned back on it is in Thrive, and an add-on on Seed and Grow.
 * Works in the browser (window.TallyPlans) and in Node (require), so the server enforces the same rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyPlans = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * Features built but not offered yet. They stay out of every plan, add-on, price and menu, and the server refuses
   * them, while their code and any records already made are kept. To launch payroll, empty this list.
   * A test (or a server started with SUMLORA_PAYROLL=on) can turn payroll back on.
   * Year-end files (engagements-calc.js) are coming soon too; SUMLORA_YEAREND=on turns them on for tests.
   */
  const envOn = k => typeof process !== 'undefined' && process.env && process.env[k] === 'on';
  const COMING_SOON = [...(envOn('SUMLORA_PAYROLL') ? [] : ['payroll']), ...(envOn('SUMLORA_YEAREND') ? [] : ['yearEndFiles'])];
  const soon = key => COMING_SOON.includes(key);

  // Features beyond everyday bookkeeping. Bookkeeping itself (accounts, transactions, invoices, estimates and bills,
  // GST/HST and QST returns, bank statement import and reconciliation, bank rules, receipts, the standard reports,
  // CaseWare export, review tools, recurring transactions, imports, batch invoices, tags, report filters,
  // the transaction list and cash basis) is in every plan.
  const FEATURES = {
    // Plaid charges for each connected bank, so automatic feeds start at Grow. Statement import is in every plan.
    bankFeeds: { label: 'Automatic bank feeds', desc: 'Transactions come in from the bank by themselves every few hours, through Plaid' },
    ai: { label: 'AI suggestions', desc: 'Categories for bank lines and receipts read by AI' },
    advancedReports: { label: 'Advanced reports', desc: 'Comparisons by period, cash flow statement, saved reports, report packages and the working trial balance' },
    projects: { label: 'Projects and time', desc: 'Projects with their income, costs and profit; time tracking billed to customers' },
    fixedAssets: { label: 'Fixed assets and CCA', desc: 'Asset register, amortization entries and the capital cost allowance schedule' },
    specialTax: { label: 'Special sales tax methods', desc: 'Quick Method, and the net tax calculation and rebates for charities and non-profits' },
    budgets: { label: 'Budgets', desc: 'A budget for each fiscal year, and the Budget vs actual report' },
    inventory: { label: 'Inventory', desc: 'Quantities on hand, average cost, cost of goods sold posted on each sale' },
    multiCurrency: { label: 'Multi-currency', desc: 'Customers, vendors and bank accounts in US dollars and other currencies, with exchange gains and losses' },
    // Making classes needs Thrive; classes a company already has can still be picked and reported on.
    classes: { label: 'Classes', desc: 'Sort income and expenses by branch, location or department, on each transaction or each line, with the profit and loss by class' },
    billApprovals: { label: 'Bill approvals', desc: 'Bills over an amount, or from chosen vendors, wait for an owner or approver to approve them before they can be paid' },
    emailReceipts: { label: 'Receipts by email', desc: 'Each company gets its own email address: receipts forwarded to it go to the Receipts inbox' },
    cashForecast: { label: 'Cash flow forecast', desc: 'The money expected in the bank over the next 30, 60 or 90 days, from open invoices and bills, recurring transactions, payroll, sales tax and your own planned items' },
    // In Thrive; on Seed and Grow it comes with the Payroll add-on (ADDONS.payroll).
    payroll: { label: 'Payroll', desc: 'Pay runs, source deductions and remittances, vacation and holiday pay, ROE, T4 and RL-1', comingSoon: soon('payroll') },
    workflows: { label: 'Workflow reminders', desc: 'Rules that remind the right people about overdue invoices, bills coming due, bills waiting for approval, bank lines and receipts waiting, estimates to follow up, remittances and sales tax returns, and can email customers a payment reminder' },
    // The accountant's year-end working file: trial balance snapshot, leadsheets and adjusting entries. Firm staff only.
    yearEndFiles: { label: 'Year-end files', desc: 'The accountant’s year-end working file: the trial balance at the year-end, leadsheets, adjusting entries and comparatives. Clients never see it', comingSoon: soon('yearEndFiles') },
    // For the whole firm, not each company: owners define roles under Users & security (see roles.js).
    customRoles: { label: 'Custom roles', desc: 'Your own roles for staff, with None, View or Edit for sales, expenses, banking, payroll, reports, accounting, sales tax and settings', firm: true },
  };
  const GROW = ['bankFeeds', 'ai', 'advancedReports', 'projects', 'fixedAssets', 'specialTax', 'budgets'];
  const THRIVE = [...GROW, 'inventory', 'multiCurrency', 'classes', 'customRoles', 'billApprovals', 'emailReceipts', 'cashForecast', 'workflows', 'payroll', 'yearEndFiles'].filter(k => !soon(k));
  // cents: the default monthly price per company (the server's administrator can change it in Settings).
  const PLANS = {
    seed: { label: 'Seed', fr: 'Semis', cents: 1800, features: [], blurb: 'Everyday bookkeeping: invoices and bills, GST/HST and QST returns, bank statement import and reconciliation, receipts, reports and CaseWare export.' },
    grow: { label: 'Grow', fr: 'Croissance', cents: 4000, features: GROW, blurb: 'Everything in Seed, plus automatic bank feeds, AI suggestions, advanced reports, projects and time, fixed assets and CCA, special sales tax methods and budgets.' },
    thrive: { label: 'Thrive', fr: 'Prospérité', cents: 5500, features: THRIVE, blurb: 'Everything in Grow, plus ' + (soon('payroll') ? '' : 'payroll, ') + 'inventory, multi-currency, classes, custom roles, bill approvals, receipts by email, the cash flow forecast' + (soon('yearEndFiles') ? ' and workflow reminders.' : ', workflow reminders and year-end files.') },
  };
  /*
   * The plans before Seed, Grow and Thrive. A firm (or a company whose client pays) still on one of them moves to the
   * new plan with the same features or more, and keeps its old price (`legacy` on the firm) until the administrator
   * changes its plan or its price. Codes and records that say 'essentials' or 'plus' are read this way.
   */
  const LEGACY = {
    essentials: { label: 'Essentials', plan: 'seed', cents: 1500 },
    plus: { label: 'Plus', plan: 'thrive', cents: 3000 },
  };
  // Add-ons: bought separately for each company. Off unless an owner turns one on.
  // cents is the default monthly price per company; the server's administrator can change it in Settings.
  const ALL_ADDONS = {
    assistant: { label: 'AI assistant', desc: 'Ask questions about the books in plain words and get answers with the numbers, plus links to the right report', cents: 500 },
    // Turned on by itself when a company is set up as a scrap yard (industries.js), or by an owner in Settings.
    scrapyard: { label: 'Scrap yard', desc: 'For scrap yards and auto recyclers: vehicles bought by VIN, purchase vouchers for sellers paid in cash, parts pulled from each car, weigh tickets, an environmental checklist and profit per vehicle', cents: 1000 },
    // A base fee per company, plus each employee paid in the month (UNITS.payrollEmployees). Thrive includes the base fee.
    payroll: { label: 'Payroll', desc: 'Pay runs, source deductions and remittances, vacation and holiday pay, ROE, T4 and RL-1', cents: 2000, feature: 'payroll', includedIn: ['thrive'], unit: 'payrollEmployees' },
  };
  /** Prices per unit rather than per company: payroll's charge for each employee paid in a month, on any plan. */
  const ALL_UNITS = {
    payrollEmployees: { label: 'Payroll employees', desc: 'Each employee paid in the month', cents: 400, addon: 'payroll' },
  };
  // What's sold today: add-ons and unit prices for features that are coming soon are left out (not priced, not billed).
  const ADDONS = Object.fromEntries(Object.entries(ALL_ADDONS).filter(([, a]) => !(a.feature && soon(a.feature))));
  const UNITS = Object.fromEntries(Object.entries(ALL_UNITS).filter(([, u]) => !(u.addon && !ADDONS[u.addon])));
  /** The add-on that comes with a type of business (industries.js), if any. */
  const ADDON_FOR_INDUSTRY = { scrapyard: 'scrapyard' };
  /** A plan key, today's name for an old one, or Thrive (firms from before plans existed had everything). */
  const planOf = p => (PLANS[p] ? p : LEGACY[p] ? LEGACY[p].plan : 'thrive');
  /** The plan that first includes a feature (for "In the Grow plan" labels). */
  const planFor = key => ['seed', 'grow', 'thrive'].find(p => PLANS[p].features.includes(key)) || 'thrive';
  /** Does the firm's plan include this feature? */
  const inPlan = (plan, key) => PLANS[planOf(plan)].features.includes(key);
  /** Does the plan, or an add-on on this company ({ payroll: true }), give this feature? */
  const hasFeature = (plan, key, addons) => !soon(key) && (inPlan(plan, key) || Object.entries(ADDONS).some(([k, a]) => a.feature === key && !!(addons && addons[k])));
  /** Is the feature on for this company: in the plan (or an add-on), and not switched off in the company's settings? */
  const featureOn = (plan, companyFeatures, key, addons) => hasFeature(plan, key, addons) && !(companyFeatures && companyFeatures[key] === false);
  /** Does the plan already include this add-on's base fee (payroll on Thrive)? */
  const addonIncluded = (plan, key) => !!(ADDONS[key] && (ADDONS[key].includedIn || []).includes(planOf(plan)));
  /**
   * Employees paid in a month (YYYY-MM): distinct employees on pay runs dated that month, leaving out void ones.
   * Each one is billed once however many times they were paid.
   */
  const employeesPaid = (payruns, month) => {
    const ids = new Set();
    for (const r of payruns || []) {
      if (!r || r.void || r.status === 'void' || String(r.payDate || '').slice(0, 7) !== month) continue;
      for (const l of r.lines || []) if (l && l.employeeId) ids.add(l.employeeId);
    }
    return ids.size;
  };
  /** The month before a YYYY-MM-DD or YYYY-MM date, as YYYY-MM (employees are billed the month after they're paid). */
  const prevMonth = d => { const y = +String(d).slice(0, 4), m = +String(d).slice(5, 7); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
  /**
   * A firm or company record from before Seed, Grow and Thrive, moved over: { plan, legacy }.
   * 'essentials' → Seed and 'plus' → Thrive, each keeping its old price (legacy); anything else unchanged.
   */
  const migratePlan = (plan, legacy) => (LEGACY[plan] ? { plan: LEGACY[plan].plan, legacy: plan } : { plan: planOf(plan), legacy: LEGACY[legacy] ? legacy : '' });
  /** Which price a firm pays: its legacy price while it has one, otherwise its plan's. */
  const priceKey = (plan, legacy) => (LEGACY[legacy] ? legacy : planOf(plan));
  /** The plan's name, in French when asked. */
  const planLabel = (plan, lang) => { const p = PLANS[planOf(plan)]; return lang === 'fr' ? p.fr : p.label; };

  /** Is this feature built but not offered yet ("Coming soon")? */
  const comingSoon = soon;

  return { COMING_SOON, comingSoon, FEATURES, PLANS, LEGACY, ADDONS, UNITS, ADDON_FOR_INDUSTRY, planOf, planFor, inPlan, hasFeature, featureOn, addonIncluded, employeesPaid, prevMonth, migratePlan, priceKey, planLabel };
});
