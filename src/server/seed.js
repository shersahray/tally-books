'use strict';
// Default chart of accounts (set up for a Canadian small business charging HST) and optional example data.

const DEFAULT_COMPANY = { name: 'My Business', fyStart: 1, taxName: 'HST', taxRate: 13, terms: 30, currency: '$', bn: '', province: 'ON' };

const DEFAULT_ACCOUNTS = [
  ['1000', 'Chequing', 'Asset', 'bank'],
  ['1010', 'Savings', 'Asset', 'bank'],
  ['1200', 'Accounts receivable', 'Asset', 'ar'],
  ['1300', 'Prepaid expenses', 'Asset', ''],
  ['1500', 'Equipment', 'Asset', 'capital'],
  ['2000', 'Accounts payable', 'Liability', 'ap'],
  ['2100', 'Credit card', 'Liability', 'card'],
  ['2200', 'HST payable', 'Liability', 'tax'],
  ['2400', 'Loan payable', 'Liability', ''],
  ['3000', "Owner's equity", 'Equity', ''],
  ['3100', "Owner's draws", 'Equity', ''],
  ['3900', 'Opening balance equity', 'Equity', 'ob'],
  ['4000', 'Sales', 'Income', ''],
  ['4100', 'Service revenue', 'Income', ''],
  ['4900', 'Other income', 'Income', ''],
  ['5000', 'Cost of goods sold', 'Cost of Goods Sold', ''],
  ['6000', 'Advertising and marketing', 'Expense', ''],
  ['6100', 'Bank charges', 'Expense', ''],
  ['6200', 'Insurance', 'Expense', ''],
  ['6300', 'Meals and entertainment', 'Expense', ''],
  ['6400', 'Office supplies', 'Expense', ''],
  ['6500', 'Professional fees', 'Expense', ''],
  ['6600', 'Rent', 'Expense', ''],
  ['6700', 'Software and subscriptions', 'Expense', ''],
  ['6800', 'Telephone and internet', 'Expense', ''],
  ['6900', 'Travel', 'Expense', ''],
  ['7000', 'Vehicle expenses', 'Expense', ''],
  ['7100', 'Wages and salaries', 'Expense', ''],
  ['7200', 'Utilities', 'Expense', ''],
];

// Non-profit organizations and registered charities: revenue by source, and net assets instead of owner's equity.
const NPO_ACCOUNTS = [
  ['1000', 'Chequing', 'Asset', 'bank'],
  ['1010', 'Savings', 'Asset', 'bank'],
  ['1200', 'Accounts receivable', 'Asset', 'ar'],
  ['1250', 'Grants receivable', 'Asset', ''],
  ['1300', 'Prepaid expenses', 'Asset', ''],
  ['1500', 'Equipment', 'Asset', 'capital'],
  ['2000', 'Accounts payable', 'Liability', 'ap'],
  ['2100', 'Credit card', 'Liability', 'card'],
  ['2200', 'HST payable', 'Liability', 'tax'],
  ['2500', 'Deferred contributions', 'Liability', ''],
  ['3000', 'Unrestricted net assets', 'Equity', ''],
  ['3100', 'Internally restricted net assets', 'Equity', ''],
  ['3900', 'Opening balance net assets', 'Equity', 'ob'],
  ['4000', 'Donations', 'Income', ''],
  ['4100', 'Government grants', 'Income', ''],
  ['4150', 'Other grants', 'Income', ''],
  ['4200', 'Membership fees', 'Income', ''],
  ['4300', 'Program and service fees', 'Income', ''],
  ['4400', 'Fundraising events', 'Income', ''],
  ['4900', 'Interest and other income', 'Income', ''],
  ['6000', 'Advertising and promotion', 'Expense', ''],
  ['6100', 'Bank charges', 'Expense', ''],
  ['6200', 'Insurance', 'Expense', ''],
  ['6300', 'Fundraising expenses', 'Expense', ''],
  ['6400', 'Office supplies', 'Expense', ''],
  ['6500', 'Professional fees', 'Expense', ''],
  ['6600', 'Rent', 'Expense', ''],
  ['6700', 'Software and subscriptions', 'Expense', ''],
  ['6800', 'Telephone and internet', 'Expense', ''],
  ['6900', 'Travel', 'Expense', ''],
  ['7000', 'Program supplies', 'Expense', ''],
  ['7100', 'Wages and salaries', 'Expense', ''],
  ['7200', 'Utilities', 'Expense', ''],
  ['7300', 'Gifts to qualified donees', 'Expense', ''],
];
const NPO_NAMES_FR = {
  1250: 'Subventions à recevoir', 2500: 'Apports reportés', 3000: 'Actifs nets non affectés', 3100: 'Actifs nets grevés d’affectations internes',
  3900: 'Actifs nets d’ouverture', 4000: 'Dons', 4100: 'Subventions gouvernementales', 4150: 'Autres subventions', 4200: 'Cotisations des membres',
  4300: 'Revenus de programmes et de services', 4400: 'Activités de financement', 4900: 'Intérêts et autres revenus', 6000: 'Publicité et promotion',
  6300: 'Frais de collecte de fonds', 7000: 'Fournitures de programmes', 7300: 'Dons à des donataires reconnus',
};

// The same chart in French, for companies whose books are kept in French.
const ACCOUNT_NAMES_FR = {
  1000: 'Compte chèques', 1010: 'Compte d’épargne', 1200: 'Comptes clients', 1300: 'Charges payées d’avance', 1500: 'Matériel',
  2000: 'Comptes fournisseurs', 2100: 'Carte de crédit', 2400: 'Emprunt à payer', 3000: 'Capital du propriétaire', 3100: 'Retraits du propriétaire',
  3900: 'Capitaux propres d’ouverture', 4000: 'Ventes', 4100: 'Revenus de services', 4900: 'Autres revenus', 5000: 'Coût des marchandises vendues',
  6000: 'Publicité et marketing', 6100: 'Frais bancaires', 6200: 'Assurances', 6300: 'Repas et représentation', 6400: 'Fournitures de bureau',
  6500: 'Honoraires professionnels', 6600: 'Loyer', 6700: 'Logiciels et abonnements', 6800: 'Téléphone et Internet', 6900: 'Frais de déplacement',
  7000: 'Frais de véhicule', 7100: 'Salaires', 7200: 'Services publics',
};
const TAX_NAME_FR = { HST: 'TVH', GST: 'TPS', 'GST/QST': 'TPS/TVQ', QST: 'TVQ' };

// Sales tax by province or territory. Rates are the combined recoverable tax a business charges.
const PROVINCES = {
  ON: { name: 'Ontario', taxName: 'HST', taxRate: 13 },
  NS: { name: 'Nova Scotia', taxName: 'HST', taxRate: 14 },
  NB: { name: 'New Brunswick', taxName: 'HST', taxRate: 15 },
  NL: { name: 'Newfoundland and Labrador', taxName: 'HST', taxRate: 15 },
  PE: { name: 'Prince Edward Island', taxName: 'HST', taxRate: 15 },
  QC: { name: 'Quebec', taxName: 'GST/QST', taxRate: 14.975, qstRate: 9.975 },
  BC: { name: 'British Columbia', taxName: 'GST', taxRate: 5 },
  AB: { name: 'Alberta', taxName: 'GST', taxRate: 5 },
  SK: { name: 'Saskatchewan', taxName: 'GST', taxRate: 5 },
  MB: { name: 'Manitoba', taxName: 'GST', taxRate: 5 },
  YT: { name: 'Yukon', taxName: 'GST', taxRate: 5 },
  NT: { name: 'Northwest Territories', taxName: 'GST', taxRate: 5 },
  NU: { name: 'Nunavut', taxName: 'GST', taxRate: 5 },
};

/**
 * Set up a new set of books once: company settings plus a chart of accounts.
 * @param {Store} store
 * @param {object} [init]
 * @param {object} [init.company]   settings to start with (name, fyStart, taxName, taxRate, ...)
 * @param {Array}  [init.accounts]  accounts to copy instead of the default chart ({id, ...data})
 */
function seedDefaults(store, init = {}) {
  if (store.getMeta('seeded')) return false;
  const company = { ...DEFAULT_COMPANY, ...(init.company || {}) };
  store.transaction(() => {
    if (!store.getSetting('company')) store.putSetting('company', company);
    if (store.list('accounts').length === 0) {
      if (init.accounts && init.accounts.length) {
        for (const a of init.accounts) {
          const { id, importMap, lastStatement, ...data } = a;
          store.put('accounts', id, data);
        }
      } else {
        const split = Number(company.qstRate) > 0, fr = company.lang === 'fr';
        const npo = company.orgType === 'npo' || company.orgType === 'charity';
        for (const [code, name, type, detail] of npo ? NPO_ACCOUNTS : DEFAULT_ACCOUNTS) {
          const tn = company.taxName || 'Sales tax';
          const label = detail === 'tax'
            ? (fr ? (split ? 'TPS à payer' : `${TAX_NAME_FR[tn] || tn} à payer`) : (split ? 'GST payable' : `${tn} payable`))
            : (fr ? (npo && NPO_NAMES_FR[code]) || ACCOUNT_NAMES_FR[code] || name : name);
          store.put('accounts', 'a' + code, { code, name: label, type, detail, desc: '', active: true });
        }
        if (split) store.put('accounts', 'a2210', { code: '2210', name: fr ? 'TVQ à payer' : 'QST payable', type: 'Liability', detail: 'qst', desc: '', active: true });
      }
    }
    store.putMeta('seeded', new Date().toISOString());
  });
  return true;
}

/* ---------- example data, dated relative to today ---------- */
const r2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function daysAgo(n, now = new Date()) { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return iso(d); }

/**
 * Builds the example records. Returns a list of {collection, id, data}.
 * Account ids refer to the default chart; call only when those accounts exist.
 */
// Example data in French, for companies whose books are kept in French.
const EXAMPLE_FR = {
  'Maple Street Dental': 'Clinique dentaire Maple', 'Harbour Yoga Studio': 'Studio de yoga Harbour', 'Northline Office Supply': 'Fournitures de bureau Northline',
  'Cityview Property Management': 'Gestion immobilière Cityview', 'Opening balance': 'Solde d’ouverture', 'Monthly bookkeeping': 'Tenue de livres mensuelle',
  'Website refresh': 'Refonte du site Web', 'Hosting setup': 'Configuration de l’hébergement', 'Bookkeeping for Canadian subsidiary (export, no tax)': 'Tenue de livres pour la filiale canadienne (exportation, sans taxe)',
  'Office rent': 'Loyer du bureau', 'Printer paper and toner': 'Papier et encre d’imprimante', 'E-transfer': 'Virement Interac', 'Online': 'En ligne',
  'Monthly account fee': 'Frais mensuels du compte', 'Account fee': 'Frais de compte', 'Accounting software': 'Logiciel comptable', 'Monthly subscription': 'Abonnement mensuel',
  'Internet and phone': 'Internet et téléphone', 'Fibre internet and mobile': 'Internet fibre et cellulaire', 'Local ads': 'Publicité locale',
  'Community newsletter ad': 'Annonce dans le bulletin communautaire', 'Workshop fee': 'Frais d’atelier', 'Half-day bookkeeping workshop': 'Atelier de tenue de livres d’une demi-journée',
  'Credit card payment': 'Paiement de la carte de crédit', 'GST': 'TPS', 'QST': 'TVQ', 'Sales tax': 'Taxe de vente', 'collected': 'perçue', 'paid': 'payée', 'Chq 2214': 'Chèque 2214',
};

function exampleRecords(taxRate = 13, now = new Date(), qstRate = 0, province = '', lang = 'en') {
  const L = s => (lang === 'fr' && EXAMPLE_FR[s]) || s;
  const out = [];
  let created = now.getTime() - 90 * 864e5;
  const cr = () => (created += 60000);
  const rate = taxRate / 100;
  // Tax lines for a taxable amount: one GST/HST line, or GST + QST for Quebec companies.
  const taxLines = (base, side, memo) => {
    const parts = qstRate > 0 ? [['a2200', (taxRate - qstRate) / 100, 'GST'], ['a2210', qstRate / 100, 'QST']] : [['a2200', rate, 'Sales tax']];
    return parts.map(([account, r, name]) => ({ account, debit: side === 'debit' ? r2(base * r) : 0, credit: side === 'credit' ? r2(base * r) : 0, memo: `${L(name)} ${L(memo)}`.trim() })).filter(l => l.debit || l.credit);
  };
  const taxOn = base => taxLines(base, 'credit', '').reduce((s, l) => s + l.credit, 0);
  const add = (collection, id, data) => out.push({ collection, id, data: { example: true, created: cr(), contactId: '', ref: '', memo: '', ...data, ...(data.memo ? { memo: L(data.memo) } : {}), ...(data.ref ? { ref: L(data.ref) } : {}) } });

  [['c_maple', 'Maple Street Dental', 'customer', 'accounts@maplestreetdental.example'],
   ['c_harbour', 'Harbour Yoga Studio', 'customer', 'hello@harbouryoga.example'],
   ['c_north', 'Northline Office Supply', 'vendor', 'billing@northline.example'],
   ['c_city', 'Cityview Property Management', 'vendor', 'rent@cityviewpm.example'],
   ['c_cascade', 'Cascade Outfitters LLC (Seattle, WA)', 'customer', 'ap@cascadeoutfitters.example', 'export'],
  ].forEach(([id, name, kind, email, taxCode]) => out.push({ collection: 'contacts', id, data: { name: L(name), kind, email, phone: '', address: '', notes: '', taxCode: taxCode || '', example: true, created: cr() } }));

  add('entries', 'x_ob', { type: 'journal', date: daysAgo(89, now), memo: 'Opening balance',
    lines: [{ account: 'a1000', debit: 12000, credit: 0 }, { account: 'a3900', debit: 0, credit: 12000 }] });

  function doc(id, kind, number, contactId, date, due, lines) {
    // tax: true = standard rate, false = no tax, or a tax code such as 'export'
    const ls = lines.map(([desc, account, qty, rate_, tax]) => {
      const taxCode = typeof tax === 'string' ? tax : tax ? 'std' : 'none';
      return { desc: L(desc), account, qty, rate: rate_, taxCode, tax: taxCode === 'std' };
    });
    const sub = r2(ls.reduce((s, l) => s + l.qty * l.rate, 0));
    const taxable = ls.filter(l => l.tax).reduce((s, l) => s + l.qty * l.rate, 0);
    const tax = r2(taxOn(taxable));
    const total = r2(sub + tax);
    const g = {};
    ls.forEach(l => { const k = l.account + '|' + l.taxCode; g[k] = r2((g[k] || 0) + l.qty * l.rate); });
    const pl = [];
    if (kind === 'invoice') {
      pl.push({ account: 'a1200', debit: total, credit: 0 });
      Object.entries(g).forEach(([k, v]) => { const [a, taxCode] = k.split('|'); pl.push({ account: a, debit: 0, credit: v, taxCode }); });
      pl.push(...taxLines(taxable, 'credit', 'collected'));
    } else {
      Object.entries(g).forEach(([k, v]) => { const [a, taxCode] = k.split('|'); pl.push({ account: a, debit: v, credit: 0, taxCode }); });
      pl.push(...taxLines(taxable, 'debit', 'paid'));
      pl.push({ account: 'a2000', debit: 0, credit: total });
    }
    const c = cr();
    out.push({ collection: 'docs', id, data: { kind, number, contactId, date, due, memo: '', lines: ls, sub, tax, total, taxRate, example: true, created: c } });
    add('entries', 'd_' + id, { type: kind, date, ref: number, contactId, docId: id, lines: pl, created: c });
    return { id, total, contactId, number };
  }
  function pay(id, kind, d, date, amount, bank, ref) {
    const recv = kind === 'payment';
    add('entries', id, { type: kind, date, ref, contactId: d.contactId, applyTo: d.id, amount, bank,
      memo: lang === 'fr' ? `${recv ? 'Paiement de la facture' : 'Paiement de la facture fournisseur'} no ${d.number}` : `${recv ? 'Payment for invoice' : 'Payment of bill'} #${d.number}`,
      lines: recv ? [{ account: bank, debit: amount, credit: 0 }, { account: 'a1200', debit: 0, credit: amount }]
                  : [{ account: 'a2000', debit: amount, credit: 0 }, { account: bank, debit: 0, credit: amount }] });
  }
  function money(id, kind, date, bank, memo, lines) {
    const ls = lines.map(([account, desc, amount, tax]) => ({ account, desc: L(desc), amount, tax }));
    const sub = r2(ls.reduce((s, l) => s + l.amount, 0));
    const taxable = ls.filter(l => l.tax).reduce((s, l) => s + l.amount, 0);
    const tax = r2(taxOn(taxable));
    const total = r2(sub + tax);
    const pl = [];
    if (kind === 'expense') {
      ls.forEach(l => pl.push({ account: l.account, debit: l.amount, credit: 0 }));
      pl.push(...taxLines(taxable, 'debit', 'paid'));
      pl.push({ account: bank, debit: 0, credit: total });
    } else {
      pl.push({ account: bank, debit: total, credit: 0 });
      ls.forEach(l => pl.push({ account: l.account, debit: 0, credit: l.amount }));
      pl.push(...taxLines(taxable, 'credit', 'collected'));
    }
    add('entries', id, { type: kind, date, memo, form: { bank, lines: ls }, lines: pl });
    return total;
  }

  const i1 = doc('x_inv1001', 'invoice', '1001', 'c_maple', daysAgo(55, now), daysAgo(25, now), [['Monthly bookkeeping', 'a4100', 1, 1200, true]]);
  const i2 = doc('x_inv1002', 'invoice', '1002', 'c_harbour', daysAgo(44, now), daysAgo(14, now), [['Website refresh', 'a4100', 1, 2400, true], ['Hosting setup', 'a4100', 1, 150, true]]);
  doc('x_inv1003', 'invoice', '1003', 'c_maple', daysAgo(24, now), daysAgo(-6, now), [['Monthly bookkeeping', 'a4100', 1, 1200, true]]);
  doc('x_inv1004', 'invoice', '1004', 'c_cascade', daysAgo(20, now), daysAgo(-10, now), [['Bookkeeping for Canadian subsidiary (export, no tax)', 'a4100', 1, 900, 'export']]);
  doc('x_bill1', 'bill', 'R-0926', 'c_city', daysAgo(27, now), daysAgo(-3, now), [['Office rent', 'a6600', 1, 1800, true]]);
  const b2 = doc('x_bill2', 'bill', '55821', 'c_north', daysAgo(39, now), daysAgo(9, now), [['Printer paper and toner', 'a6400', 1, 240, true]]);
  pay('x_p1', 'payment', i1, daysAgo(31, now), i1.total, 'a1000', 'E-transfer');
  pay('x_p2', 'payment', i2, daysAgo(18, now), 1000, 'a1000', 'Chq 2214');
  pay('x_p3', 'billpayment', b2, daysAgo(23, now), b2.total, 'a1000', 'Online');
  money('x_e1', 'expense', daysAgo(70, now), 'a1000', 'Monthly account fee', [['a6100', 'Account fee', 19.95, false]]);
  const cc = money('x_e2', 'expense', daysAgo(47, now), 'a2100', 'Accounting software', [['a6700', 'Monthly subscription', 45, true]]);
  money('x_e3', 'expense', daysAgo(13, now), 'a1000', 'Internet and phone', [['a6800', 'Fibre internet and mobile', 95, true]]);
  money('x_e4', 'expense', daysAgo(6, now), 'a1000', 'Local ads', [['a6000', 'Community newsletter ad', 300, true]]);
  money('x_d1', 'deposit', daysAgo(65, now), 'a1000', 'Workshop fee', [['a4100', 'Half-day bookkeeping workshop', 800, true]]);
  // Bank lines waiting in "For review": two match existing records, two are new, one has a rule.
  const ads = r2(300 + taxOn(300)), rent = r2(1800 + taxOn(1800)), maple = r2(1200 + taxOn(1200));
  const bank = (id, days, amount, desc) => out.push({ collection: 'bankTxns', id, data: { account: 'a1000', date: daysAgo(days, now), amount, desc, fitid: '', status: 'new', entryId: '', imported: cr(), file: 'example', example: true } });
  bank('b_x1', 5, -ads, 'COMMUNITY NEWS ADVERTISING');
  bank('b_x2', 2, maple, 'E-TRANSFER MAPLE STREET DENTAL');
  bank('b_x3', 3, -4.75, 'TIM HORTONS #2231');
  bank('b_x4', 1, -r2(75 + taxOn(75)), 'ROGERS WIRELESS PAYMENT');
  bank('b_x5', 2, -rent, 'CITYVIEW PROPERTY MGMT PAD');
  out.push({ collection: 'rules', id: 'x_r1', data: { text: 'ROGERS', direction: 'out', account: 'a6800', contactId: '', tax: true, example: true, created: cr() } });
  add('entries', 'x_t1', { type: 'transfer', date: daysAgo(8, now), memo: 'Credit card payment', form: { from: 'a1000', to: 'a2100', amount: cc },
    lines: [{ account: 'a2100', debit: cc, credit: 0 }, { account: 'a1000', debit: 0, credit: cc }] });
  // Two employees so the Payroll screen has someone to pay.
  const prov = province || (qstRate > 0 ? 'QC' : 'ON');
  const emp = (id, data) => out.push({ collection: 'employees', id, data: { prov, freq: 'biweekly', active: true, hireDate: daysAgo(400, now), example: true, created: cr(), ...data } });
  emp('x_emp1', { name: 'Jordan Lee', email: 'jordan@example.com', payType: 'salary', rate: 58000, hours: 75, vacMode: 'salary', occupation: 'Studio manager' });
  emp('x_emp2', { name: 'Sam Patel', email: 'sam@example.com', payType: 'hourly', rate: 24.5, hours: 60, vacMode: 'accrue', occupation: 'Instructor' });
  return out;
}

module.exports = { seedDefaults, exampleRecords, DEFAULT_COMPANY, DEFAULT_ACCOUNTS, PROVINCES };
