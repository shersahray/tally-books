/*
 * Pay stubs as PDF files, for emailing each employee their stub, and the email that goes with it.
 * Works in the browser (window.TallyStub) and in Node (require) so the tests can check it.
 *
 * payroll.js builds the stub's figures once (stubData) and shows them as HTML on screen or for printing; this file
 * draws the same figures into a PDF with pdf.js, in the employee's language (English or French).
 * A stub never shows the employee's SIN. A bank account, when shown, is only its last 3 digits.
 *
 * stub = {
 *   company: { name, bn }, payDate, from, to, name, address,
 *   earnings: [row], gross: [cur, ytd],
 *   benefits: { rows: [row], total: [cur, ytd], qc } | null,
 *   deductions: [row], totalDed: [cur, ytd], net,
 *   vac: { balance, set, rate } | null, employer: [row], deposit: '123' | ''  (last 3 digits of the account)
 * }
 * row = { key, cur, ytd (null: no year-to-date), h, rate, names }; key is the English label (see LABELS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyStub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FR = {
    'Pay stub': 'Relevé de paie', 'Pay date': 'Date de paie', 'Period': 'Période', 'BN': 'NE',
    'Earnings': 'Gains', 'This pay': 'Cette paie', 'Year to date': 'Cumul annuel', 'Gross pay': 'Salaire brut',
    'Regular pay': 'Salaire régulier', 'Holiday pay': 'Indemnité de jour férié', 'Other pay': 'Autre rémunération', 'Bonus': 'Prime',
    'Taxable allowance': 'Allocation imposable', 'Vacation pay paid out': 'Indemnité de vacances versée', 'Vacation pay': 'Indemnité de vacances',
    'Taxable benefits (not paid to you)': 'Avantages imposables (non versés)', 'Total taxable benefits': 'Total des avantages imposables',
    'Included in your taxable income and on your T4. Tax on them is taken from your pay.': 'Inclus dans votre revenu imposable et sur votre T4. L’impôt sur ces avantages est retenu sur votre paie.',
    'Included in your taxable income and on your T4 and RL-1. Tax on them is taken from your pay.': 'Inclus dans votre revenu imposable et sur votre T4 et votre relevé 1. L’impôt sur ces avantages est retenu sur votre paie.',
    'Deductions': 'Retenues', 'None': 'Aucune', 'Total deductions': 'Total des retenues', 'Net pay': 'Salaire net',
    'Vacation pay owed to you after this pay:': 'Indemnité de vacances qui vous est due après cette paie :', 'Set aside this pay': 'Mise de côté sur cette paie',
    'Paid by your employer': 'Payé par votre employeur', 'Deposited to the account ending in': 'Déposé dans le compte se terminant par',
    'CPP': 'RPC', 'CPP2': 'RPC2', 'QPP': 'RRQ', 'QPP2': 'RRQ2', 'EI': 'AE', 'QPIP': 'RQAP',
    'Federal income tax': 'Impôt fédéral', 'Provincial income tax': 'Impôt provincial', 'Quebec income tax': 'Impôt du Québec',
    'RRSP / pension': 'REER / régime de retraite', 'Union dues': 'Cotisations syndicales',
    'CPP (employer)': 'RPC (employeur)', 'CPP2 (employer)': 'RPC2 (employeur)', 'QPP (employer)': 'RRQ (employeur)', 'QPP2 (employer)': 'RRQ2 (employeur)',
    'EI (employer)': 'AE (employeur)', 'QPIP (employer)': 'RQAP (employeur)', 'Health Services Fund': 'Fonds des services de santé',
    'Group term life insurance premiums': 'Primes d’assurance vie collective temporaire',
    'Automobile benefit (standby charge and operating benefit)': 'Avantage relatif à une automobile (frais pour droit d’usage et avantage relatif au fonctionnement)',
    'Gift cards and other near-cash gifts': 'Cartes-cadeaux et autres cadeaux quasi en espèces', 'Board and lodging': 'Pension et logement', 'Other non-cash benefits': 'Autres avantages non en espèces',
    'New Year’s Day': 'Jour de l’An', 'Family Day': 'Jour de la famille', 'Louis Riel Day': 'Journée Louis Riel', 'Heritage Day': 'Jour du patrimoine', 'Islander Day': 'Fête des Insulaires',
    'Good Friday': 'Vendredi saint', 'Victoria Day': 'Fête de la Reine', 'National Patriots’ Day': 'Journée nationale des patriotes', 'Fête nationale du Québec': 'Fête nationale du Québec',
    'National Indigenous Peoples Day': 'Journée nationale des peuples autochtones', 'Canada Day': 'Fête du Canada', 'Nunavut Day': 'Jour du Nunavut', 'Civic Holiday': 'Congé civique',
    'British Columbia Day': 'Jour de la Colombie-Britannique', 'Saskatchewan Day': 'Fête de la Saskatchewan', 'New Brunswick Day': 'Jour du Nouveau-Brunswick', 'Discovery Day': 'Jour de la découverte',
    'Labour Day': 'Fête du Travail', 'National Day for Truth and Reconciliation': 'Journée nationale de la vérité et de la réconciliation', 'Thanksgiving': 'Action de grâce',
    'Remembrance Day': 'Jour du Souvenir', 'Christmas Day': 'Noël', 'Boxing Day': 'Lendemain de Noël',
  };
  const t = (s, lang) => (lang === 'fr' && FR[s]) || s;
  const money = (n, lang) => (+n || 0).toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: 'CAD' });
  const date = (s, lang) => (s ? new Date(s + 'T12:00:00').toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const pct = (n, lang) => (lang === 'fr' ? String(n).replace('.', ',') + ' %' : n + '%');

  /** A row's label in a language: "Regular, 40 h × $25.00", "Holiday pay (Labour Day)", "Vacation pay (4%)". */
  function rowLabel(r, lang) {
    if (r.key === 'Regular pay' && r.h) return `${lang === 'fr' ? 'Régulier' : 'Regular'}, ${String(r.h).replace('.', lang === 'fr' ? ',' : '.')} h × ${money(r.rate, lang)}`;
    if (r.key === 'Holiday pay' && r.names && r.names.length) return `${t('Holiday pay', lang)} (${r.names.map(n => t(n, lang)).join(', ')})`;
    if (r.key === 'Vacation pay' && r.rate !== undefined) return `${t('Vacation pay', lang)} (${pct(r.rate, lang)})`;
    return t(r.key, lang);
  }

  /** Draw a stub into a PDF document (pdf.js). Returns the PDF document so several can share one file. */
  function draw(PDF, s, lang = 'en', into) {
    const pdf = into || PDF.create(); // a new document starts with its first page
    if (into) pdf.addPage();
    const L = 54, R = pdf.width - 54, C1 = R - 110, C2 = R;
    let y = 60;
    pdf.text(L, y, s.company.name || '', { size: 14, bold: true });
    pdf.text(R, y, t('Pay stub', lang), { size: 14, bold: true, align: 'right' });
    y += 16;
    if (s.company.bn) pdf.text(L, y, `${t('BN', lang)} ${s.company.bn}`, { size: 9, color: '#555555' });
    pdf.text(R, y, `${t('Pay date', lang)}${lang === 'fr' ? ' : ' : ' '}${date(s.payDate, lang)}`, { size: 9, color: '#555555', align: 'right' });
    if (s.from) { y += 12; pdf.text(R, y, `${t('Period', lang)} ${date(s.from, lang)} – ${date(s.to, lang)}`, { size: 9, color: '#555555', align: 'right' }); }
    y += 26;
    pdf.text(L, y, s.name || '', { size: 11, bold: true });
    for (const line of String(s.address || '').split(/\r?\n/).filter(Boolean).slice(0, 4)) { y += 12; pdf.text(L, y, line, { size: 9, color: '#555555' }); }
    y += 22;
    const table = (head, rows, foot) => {
      pdf.rect(L, y - 11, R - L, 16, { fill: '#f0f0f0' });
      pdf.text(L + 4, y, head, { size: 9, bold: true });
      pdf.text(C1, y, t('This pay', lang), { size: 9, bold: true, align: 'right' });
      pdf.text(C2 - 4, y, t('Year to date', lang), { size: 9, bold: true, align: 'right' });
      y += 16;
      if (!rows.length) { pdf.text(L + 4, y, t('None', lang), { size: 9, color: '#777777' }); y += 14; }
      for (const r of rows) {
        const label = rowLabel(r, lang), lines = pdf.wrap(label, C1 - 120 - L, 9.5);
        lines.forEach((ln, i) => pdf.text(L + 4, y + i * 11, ln, { size: 9.5 }));
        pdf.text(C1, y, money(r.cur, lang), { size: 9.5, align: 'right' });
        if (r.ytd !== null && r.ytd !== undefined) pdf.text(C2 - 4, y, money(r.ytd, lang), { size: 9.5, align: 'right' });
        y += 3 + lines.length * 11;
      }
      if (foot) {
        pdf.line(L, y - 8, R, y - 8);
        pdf.text(L + 4, y + 2, foot[0], { size: 9.5, bold: true });
        pdf.text(C1, y + 2, money(foot[1], lang), { size: 9.5, bold: true, align: 'right' });
        pdf.text(C2 - 4, y + 2, money(foot[2], lang), { size: 9.5, bold: true, align: 'right' });
        y += 16;
      }
      y += 12;
    };
    table(t('Earnings', lang), s.earnings, [t('Gross pay', lang), s.gross[0], s.gross[1]]);
    if (s.benefits) {
      table(t('Taxable benefits (not paid to you)', lang), s.benefits.rows, [t('Total taxable benefits', lang), s.benefits.total[0], s.benefits.total[1]]);
      const note = s.benefits.qc ? 'Included in your taxable income and on your T4 and RL-1. Tax on them is taken from your pay.' : 'Included in your taxable income and on your T4. Tax on them is taken from your pay.';
      for (const ln of pdf.wrap(t(note, lang), R - L, 8.5)) { pdf.text(L, y - 6, ln, { size: 8.5, color: '#555555' }); y += 10; }
      y += 6;
    }
    table(t('Deductions', lang), s.deductions, [t('Total deductions', lang), s.totalDed[0], s.totalDed[1]]);
    pdf.rect(L, y - 14, R - L, 24, { fill: '#e6f2f0' });
    pdf.text(L + 6, y + 2, t('Net pay', lang), { size: 12, bold: true });
    pdf.text(R - 6, y + 2, money(s.net, lang), { size: 12, bold: true, align: 'right' });
    y += 24;
    if (s.deposit) { pdf.text(L, y, `${t('Deposited to the account ending in', lang)} ${s.deposit}`, { size: 9, color: '#555555' }); y += 16; }
    if (s.vac) {
      pdf.text(L, y, `${t('Vacation pay owed to you after this pay:', lang)} ${money(s.vac.balance, lang)}`, { size: 9.5 });
      y += 12;
      pdf.text(L, y, `${t('Set aside this pay', lang)}${lang === 'fr' ? ' : ' : ': '}${money(s.vac.set, lang)}, ${lang === 'fr' ? 'à' : 'at'} ${pct(s.vac.rate, lang)}`, { size: 9, color: '#555555' });
      y += 20;
    }
    if (s.employer.length) table(t('Paid by your employer', lang), s.employer, null);
    return pdf;
  }
  /** One stub as PDF bytes. */
  function pdf(PDF, s, lang = 'en') { return draw(PDF, s, lang).output(); }

  /** Which pay run lines get an email: those whose employee has an email address. skip why: 'noemail'. */
  function plan(lines, emailOf) {
    const go = [], skip = [];
    for (const l of lines || []) (String(emailOf(l) || '').trim() ? go : skip).push(l);
    return { go, skip: skip.map(l => ({ line: l, why: 'noemail' })) };
  }

  /* The email: the company's own subject and message (Settings → Payroll) in the employee's language, or these.
     {name} is the employee's name, {date} the pay date, {company} the company's name. */
  const DEFAULT_MAIL = {
    en: { subject: 'Your pay stub for {date}', text: 'Hello {name},\n\nYour pay stub for {date} is attached.\n\nThank you,\n{company}' },
    fr: { subject: 'Votre relevé de paie du {date}', text: 'Bonjour {name},\n\nVous trouverez ci-joint votre relevé de paie du {date}.\n\nMerci,\n{company}' },
  };
  function message(settings, lang, v) {
    const l = lang === 'fr' ? 'fr' : 'en', own = (settings && settings[l]) || {};
    const fill = s => String(s).replace(/\{(name|date|company)\}/g, (m, k) => v[k] ?? '');
    return [fill(String(own.subject || '').trim() || DEFAULT_MAIL[l].subject), fill(String(own.text || '').trim() || DEFAULT_MAIL[l].text)];
  }
  /** The attached file's name: Pay-stub-2026-10-09-Ana-Lima.pdf (letters and digits only). */
  const fileName = (lang, payDate, name) => `${lang === 'fr' ? 'Releve-de-paie' : 'Pay-stub'}-${payDate}-${String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.pdf`;

  return { draw, pdf, plan, message, fileName, rowLabel, DEFAULT_MAIL, money, date };
});
