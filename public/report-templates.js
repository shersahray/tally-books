/*
 * The wording of the report that goes with a year-end file's financial statements, kept in one place.
 *
 * Each template has an id, the engagement type it's for, and the date it applies from. When professional standards
 * change, add a new version here (keep the old ones: a final file stays with the wording it was finalized with).
 * Files that aren't final, and whose wording the accountant hasn't customized, pick up the newest version by themselves.
 *
 * The wording is Sumlora's own, written to cover what CSRS 4200 asks a compilation engagement report to say. Firms can
 * replace it, in any file, with their own approved wording. The accountant reviews it before the file is made final.
 *
 * Placeholders: {entity} {yearEnd} {statements} (e.g. "the balance sheet of X as at …, and the statement of income and
 * retained earnings for the year then ended") {firm} {city}.
 * Works in the browser (window.TallyReportTemplates) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyReportTemplates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TEMPLATES = [
    {
      id: 'compilation-v1', kind: 'compilation', from: '2021-12-14', title: 'Compilation engagement report', label: 'Compilation engagement report (CSRS 4200), Sumlora wording v1',
      text: `To the management of {entity}

At management’s request and using information management gave us, we compiled {statements}, and Note 1, which describes the basis of accounting used.

Management is responsible for this financial information, for the accuracy and completeness of the information used to prepare it, and for choosing the basis of accounting.

We carried out this engagement under Canadian Standard on Related Services (CSRS) 4200, Compilation Engagements, and met the relevant ethical requirements. Our role was to help management prepare the financial information.

This was not an audit or a review, and we were not required to verify the information management provided. We therefore give no audit opinion, no review conclusion, and no assurance of any kind on this financial information.

Readers should note that this financial information may not suit their purposes.`,
    },
    {
      id: 'internal-v1', kind: 'internal', from: '2000-01-01', title: 'Notice to the reader', label: 'Internal financial statements, Sumlora wording v1',
      text: `These financial statements of {entity} for the year ended {yearEnd} were prepared for management’s internal use.

They have not been audited, reviewed or compiled under CSRS 4200, and no assurance is given on them. They may not be suitable for any other purpose.`,
    },
  ];
  const BY_ID = Object.fromEntries(TEMPLATES.map(t => [t.id, t]));
  /** The newest template for an engagement type that applies on a date (YYYY-MM-DD). */
  function current(kind, date) {
    const list = TEMPLATES.filter(t => t.kind === kind && (!date || t.from <= date)).sort((a, b) => b.from.localeCompare(a.from));
    return list[0] || TEMPLATES.find(t => t.kind === 'compilation');
  }
  /** Fill a template's placeholders. ctx: { entity, yearEnd, statements, firm, city }. */
  const render = (t, ctx) => String((t && t.text) || '').replace(/\{(entity|yearEnd|statements|firm|city)\}/g, (_, k) => (ctx && ctx[k]) || '');
  return { TEMPLATES, BY_ID, current, render };
});
