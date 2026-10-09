/*
 * Sumlora plans. Each firm on a server has a plan; the plan decides which extra features its companies
 * can use, and inside that, each company can switch features off (a client who doesn't need payroll).
 * Works in the browser (window.TallyPlans) and in Node (require), so the server enforces the same rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyPlans = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Features beyond everyday bookkeeping. Bookkeeping itself (accounts, transactions, banking,
  // invoices and bills, GST/HST and QST returns, the standard reports, CaseWare export) is in every plan.
  const FEATURES = {
    payroll: { label: 'Payroll', desc: 'Pay runs, source deductions and remittances, vacation and holiday pay, ROE, T4 and RL-1' },
    ai: { label: 'AI suggestions', desc: 'Categories for bank lines and receipts read by AI' },
    advancedReports: { label: 'Advanced reports', desc: 'Comparisons by period, cash flow statement, saved reports, report packages and the working trial balance' },
    specialTax: { label: 'Special sales tax methods', desc: 'Quick Method, and the net tax calculation and rebates for charities and non-profits' },
    projects: { label: 'Projects and time', desc: 'Projects with their income, costs and profit; time tracking billed to customers' },
    inventory: { label: 'Inventory', desc: 'Quantities on hand, average cost, cost of goods sold posted on each sale' },
    multiCurrency: { label: 'Multi-currency', desc: 'Customers, vendors and bank accounts in US dollars and other currencies, with exchange gains and losses' },
    fixedAssets: { label: 'Fixed assets and CCA', desc: 'Asset register, amortization entries and the capital cost allowance schedule' },
  };
  const PLANS = {
    essentials: { label: 'Essentials', features: [] },
    plus: { label: 'Plus', features: ['payroll', 'ai', 'advancedReports', 'specialTax', 'projects', 'inventory', 'multiCurrency', 'fixedAssets'] },
  };
  // Add-ons: bought separately for each company, on top of either plan. Off unless an owner turns one on.
  // cents is the default monthly price per company; the server's administrator can change it in Settings.
  const ADDONS = {
    assistant: { label: 'AI assistant', desc: 'Ask questions about the books in plain words and get answers with the numbers, plus links to the right report', cents: 500 },
    // Turned on by itself when a company is set up as a scrap yard (industries.js), or by an owner in Settings.
    scrapyard: { label: 'Scrap yard', desc: 'For scrap yards and auto recyclers: vehicles bought by VIN, purchase vouchers for sellers paid in cash, parts pulled from each car, weigh tickets, an environmental checklist and profit per vehicle', cents: 1000 },
  };
  /** The add-on that comes with a type of business (industries.js), if any. */
  const ADDON_FOR_INDUSTRY = { scrapyard: 'scrapyard' };
  const planOf = p => (PLANS[p] ? p : 'plus');
  /** Does the firm's plan include this feature? */
  const inPlan = (plan, key) => PLANS[planOf(plan)].features.includes(key);
  /** Is the feature on for this company: in the plan, and not switched off in the company's settings? */
  const featureOn = (plan, companyFeatures, key) => inPlan(plan, key) && !(companyFeatures && companyFeatures[key] === false);

  return { FEATURES, PLANS, ADDONS, ADDON_FOR_INDUSTRY, planOf, inPlan, featureOn };
});
