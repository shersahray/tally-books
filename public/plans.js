/*
 * Tally Books plans. Each firm on a server has a plan; the plan decides which extra features its companies
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
  };
  const PLANS = {
    essentials: { label: 'Essentials', features: [] },
    plus: { label: 'Plus', features: ['payroll', 'ai', 'advancedReports', 'specialTax'] },
  };
  const planOf = p => (PLANS[p] ? p : 'plus');
  /** Does the firm's plan include this feature? */
  const inPlan = (plan, key) => PLANS[planOf(plan)].features.includes(key);
  /** Is the feature on for this company: in the plan, and not switched off in the company's settings? */
  const featureOn = (plan, companyFeatures, key) => inPlan(plan, key) && !(companyFeatures && companyFeatures[key] === false);

  return { FEATURES, PLANS, planOf, inPlan, featureOn };
});
