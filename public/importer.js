/*
 * Import from a spreadsheet (CSV or Excel .xlsx), like QuickBooks Online's Import data: customers, vendors,
 * products and services, inventory items, the chart of accounts, invoices, sales receipts, credit notes, bills,
 * vendor credits and journal entries. Transactions can carry tags, and a class on each line.
 *
 * This file is the pure part: guessing which column is which (English and French headings), reading
 * dates, amounts and tax codes, checking every row against the books (missing name, bad date, unknown
 * account or customer, unbalanced journal, duplicate…), grouping lines into documents, and turning the
 * good rows into writes. Reading the file itself is convert-parse.js; the screen is dataimport.js.
 *
 * Works in the browser (window.Importer) and in Node (require) so it can be tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bankparse.js'), require('./convert-parse.js'));
  else root.Importer = factory(root.BankParse, root.Convert);
})(typeof self !== 'undefined' ? self : this, function (BP, CV) {
  'use strict';
  const r2 = n => Math.round(((+n) || 0) * 100 + Number.EPSILON * 100) / 100;
  const norm = s => String(s == null ? '' : s).replace(/[\s\u00a0\u202f]+/g, ' ').trim();
  const fold = s => norm(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // A column heading as a lookup key: no accents, case or punctuation; "Name*" and "Date (MM/DD/YYYY)" are just "name" and "date".
  const headKey = s => fold(s).replace(/\([^)]*\)/g, ' ').replace(/[’‘`]/g, "'").replace(/\*+/g, ' ').replace(/[^a-z0-9#/' ]+/g, ' ').replace(/\s+/g, ' ').trim();

  /* ---------- what can be imported, and the columns of each ---------- */
  const TYPES = ['customers', 'vendors', 'items', 'inventory', 'accounts', 'invoices', 'sreceipts', 'credits', 'bills', 'vcredits', 'journal'];
  // The kinds of documents: what each is saved as, whether it's a sale, and the prefix of numbers given to ones with none.
  const DOCS = {
    invoices: { kind: 'invoice', sale: true, due: true, prefix: '' },
    sreceipts: { kind: 'sreceipt', sale: true, prefix: 'SR-' },
    credits: { kind: 'credit', sale: true, prefix: 'CN-' },
    bills: { kind: 'bill', sale: false, due: true },
    vcredits: { kind: 'vcredit', sale: false },
  };
  const isDoc = t => !!DOCS[t];
  // key, English heading, French heading, other headings it goes by, required
  const F = (key, en, fr, syn, req) => ({ key, en, fr, syn, req: !!req });
  const contactFields = cust => [
    F('name', 'Name', 'Nom', cust ? ['name', 'customer', 'customer name', 'display name', 'client', 'nom du client', 'company', 'company name', 'entreprise']
      : ['name', 'vendor', 'vendor name', 'supplier', 'supplier name', 'display name', 'fournisseur', 'nom du fournisseur', 'company', 'company name', 'entreprise'], true),
    F('email', 'Email', 'Courriel', ['email', 'e-mail', 'email address', 'main email', 'courriel', 'adresse courriel', 'adresse electronique']),
    F('phone', 'Phone', 'Téléphone', ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'cell', 'numero de telephone', 'cellulaire']),
    F('address', 'Address', 'Adresse', ['address', 'street', 'street address', 'billing address', 'billing street', 'address line 1', 'rue', 'adresse de facturation']),
    F('city', 'City', 'Ville', ['city', 'billing city', 'town']),
    F('province', 'Province', 'Province', ['province', 'state', 'province/state', 'prov', 'billing province', 'billing state', 'etat']),
    F('postal', 'Postal code', 'Code postal', ['postal code', 'zip', 'zip code', 'postcode', 'billing postal code']),
    F('country', 'Country', 'Pays', ['country', 'billing country']),
    F('taxCode', 'Default tax code', 'Code de taxe par défaut', ['tax code', 'sales tax', 'default sales tax', 'tax', 'code de taxe', 'taxe']),
    F('notes', 'Notes', 'Notes', ['note', 'remarques', 'commentaires', 'comments']),
  ];
  // Tags (several, with commas or semicolons between) and the class of each line, on every kind of transaction.
  const extraFields = () => [
    F('cls', 'Class', 'Catégorie analytique', ['class', 'line class', 'itemclass', 'item class', 'class name', 'location', 'department', 'division', 'categorie analytique', 'classe', 'emplacement', 'departement']),
    F('tags', 'Tags', 'Étiquettes', ['tags', 'tag', 'etiquettes', 'etiquette', 'mots cles']),
  ];
  const NUM_HEAD = {
    invoices: ['Invoice no.', 'No de facture', ['invoice no', 'invoiceno', 'invoice number', 'invoice #', 'invoice', 'no', 'number', 'num', 'ref', 'ref no', 'reference', 'numero de facture', 'no de facture', 'n de facture', 'facture', 'numero']],
    sreceipts: ['Sales receipt no.', 'No de reçu de vente', ['sales receipt no', 'salesreceiptno', 'sales receipt number', 'sales receipt #', 'receipt no', 'receipt number', 'no', 'number', 'num', 'ref', 'ref no', 'reference', 'numero de recu', 'no de recu', 'no de recu de vente', 'numero']],
    credits: ['Credit note no.', 'No de note de crédit', ['credit note no', 'credit memo no', 'creditmemono', 'credit memo number', 'credit note number', 'credit no', 'no', 'number', 'num', 'ref', 'ref no', 'reference', 'no de note de credit', 'numero de note de credit', 'numero']],
    bills: ['Bill no.', 'No de facture', ['bill no', 'billno', 'bill number', 'bill #', 'ref no', 'refno', 'ref', 'reference', 'no', 'number', 'num', 'numero de facture', 'no de facture', 'n de facture', 'facture', 'numero', 'no de reference']],
    vcredits: ['Credit no.', 'No de crédit', ['vendor credit no', 'vendorcreditno', 'vendor credit number', 'credit no', 'credit number', 'ref no', 'refno', 'ref', 'reference', 'no', 'number', 'num', 'no de credit', 'numero de credit', 'numero']],
  };
  const DATE_HEAD = {
    invoices: ['Invoice date', 'Date de facture', ['invoice date', 'invoicedate']], sreceipts: ['Date', 'Date', ['sales receipt date', 'salesreceiptdate', 'receipt date']],
    credits: ['Date', 'Date', ['credit memo date', 'creditmemodate', 'credit note date', 'credit date']], bills: ['Bill date', 'Date de facture', ['bill date', 'billdate']],
    vcredits: ['Date', 'Date', ['vendor credit date', 'vendorcreditdate', 'credit date']],
  };
  const docFields = type => {
    const { sale, due } = DOCS[type], [nEn, nFr, nSyn] = NUM_HEAD[type], [dEn, dFr, dSyn] = DATE_HEAD[type];
    return [
    F('number', nEn, nFr, nSyn),
    F('contact', sale ? 'Customer' : 'Vendor', sale ? 'Client' : 'Fournisseur', sale ? ['customer', 'customer name', 'client', 'nom du client', 'name', 'nom', 'display name']
      : ['vendor', 'vendor name', 'supplier', 'supplier name', 'fournisseur', 'nom du fournisseur', 'payee', 'name', 'nom'], true),
    F('date', dEn, dFr, [...dSyn, 'date', 'txn date', 'transaction date', 'date de la facture', 'date de transaction'], true),
    ...(due ? [F('due', 'Due date', 'Date d’échéance', ['due date', 'duedate', 'due', "date d'echeance", 'echeance'])] : []),
    // A sales receipt is paid on the spot: the bank or cash account the money went into.
    ...(type === 'sreceipts' ? [F('bank', 'Deposit to', 'Déposer dans', ['deposit to', 'deposit to account', 'deposittoaccount', 'deposittoaccountname', 'deposit to account name', 'deposit account', 'bank account', 'deposer dans', 'compte de depot', 'compte bancaire'])] : []),
    F('item', 'Product/service', 'Produit/service', ['product/service', 'item', 'product', 'service', 'item name', 'produit', 'article']),
    F('desc', 'Description', 'Description', ['description', 'item description', 'itemdescription', 'line description', 'desc', 'details', 'detail', 'libelle', 'linedescription', 'line description']),
    F('qty', 'Qty', 'Qté', ['qty', 'quantity', 'itemquantity', 'item quantity', 'quantite', 'qte']),
    F('rate', sale ? 'Rate' : 'Cost', 'Prix unitaire', sale ? ['rate', 'unit price', 'price', 'item rate', 'itemrate', 'prix', 'tarif']
      : ['cost', 'rate', 'unit cost', 'unit price', 'price', 'item rate', 'itemrate', 'cout', 'cout unitaire', 'prix', 'tarif']),
    F('amount', 'Amount', 'Montant', ['amount', 'item amount', 'itemamount', 'line amount', 'lineamount', 'line total', 'total', 'montant de la ligne']),
    F('account', sale ? 'Income account' : 'Expense account', sale ? 'Compte de revenus' : 'Compte de dépenses', sale ? ['income account', 'account', 'revenue account', 'compte', 'compte de produits']
      : ['expense account', 'account', 'category', 'expense category', 'compte', 'categorie', 'compte de charges']),
    F('taxCode', 'Tax code', 'Code de taxe', ['tax code', 'item tax code', 'itemtaxcode', 'linetaxcode', 'line tax code', 'taxcode', 'tax', 'sales tax', 'taxe', 'taxes']),
    ...extraFields(),
    F('memo', sale ? 'Message' : 'Memo', sale ? 'Message' : 'Note', sale ? ['message', 'memo', 'message on invoice', 'message displayed on invoice', 'message on sales receipt', 'message on credit memo', 'customer memo', 'note', 'notes'] : ['memo', 'note', 'notes', 'message', 'memo de la facture']),
    ];
  };
  const FIELDS = {
    customers: contactFields(true),
    vendors: contactFields(false),
    items: [
      F('name', 'Name', 'Nom', ['name', 'product/service name', 'product/service', 'item', 'item name', 'product', 'service', 'produit/service', 'produit', 'article', 'nom du produit'], true),
      F('type', 'Type', 'Type', ['type', 'item type', "type d'article"]),
      F('sku', 'SKU', 'UGS', ['sku', 'item code', 'product code', 'code', 'code de produit']),
      F('desc', 'Description', 'Description', ['description', 'sales description', 'salesdescription', 'desc', 'description des ventes']),
      F('price', 'Sales price', 'Prix de vente', ['sales price', 'sales price/rate', 'price', 'rate', 'unit price', 'prix', 'tarif']),
      F('cost', 'Cost', 'Coût', ['cost', 'purchase cost', 'unit cost', 'cout', "cout d'achat", "prix d'achat"]),
      F('incomeAccount', 'Income account', 'Compte de revenus', ['income account', 'revenue account', 'compte de produits']),
      F('expenseAccount', 'Expense account', 'Compte de dépenses', ['expense account', 'purchase account', 'compte de charges', "compte d'achats"]),
      F('taxCode', 'Tax code', 'Code de taxe', ['tax code', 'sales tax code', 'sales tax', 'tax', 'taxable', 'taxe']),
    ],
    // Inventory items (counted in stock), with the quantity on hand on a date, like QuickBooks Online's product import.
    inventory: [
      F('name', 'Name', 'Nom', ['name', 'product/service name', 'product/service', 'item', 'item name', 'product', 'produit/service', 'produit', 'article', 'nom du produit'], true),
      F('sku', 'SKU', 'UGS', ['sku', 'item code', 'product code', 'code', 'code de produit']),
      F('desc', 'Description', 'Description', ['description', 'sales description', 'salesdescription', 'desc', 'description des ventes']),
      F('price', 'Sales price', 'Prix de vente', ['sales price', 'sales price/rate', 'price', 'rate', 'unit price', 'prix', 'tarif']),
      F('cost', 'Cost', 'Coût', ['cost', 'purchase cost', 'unit cost', 'cout', "cout d'achat", "prix d'achat", 'cout unitaire']),
      F('qty', 'Quantity on hand', 'Quantité en main', ['quantity on hand', 'qty on hand', 'qtyonhand', 'on hand', 'quantity', 'qty', 'quantite en main', 'quantite', 'qte en main', 'qte']),
      F('value', 'Total value', 'Valeur totale', ['total value', 'value', 'inventory value', 'stock value', 'valeur totale', 'valeur', 'valeur du stock']),
      F('asOf', 'As of', 'Au', ['as of', 'as of date', 'quantity as of date', 'qty as of date', 'inventory start date', 'invstartdate', 'start date', 'date', 'date de depart', 'en date du']),
      F('incomeAccount', 'Income account', 'Compte de revenus', ['income account', 'revenue account', 'compte de produits']),
      F('assetAccount', 'Inventory asset account', 'Compte d’actif de stock', ['inventory asset account', 'inventoryassetaccount', 'asset account', 'inventory account', "compte d'actif", 'compte de stock', 'compte de stocks']),
      F('cogsAccount', 'Cost of goods sold account', 'Compte du coût des marchandises vendues', ['cost of goods sold account', 'cogs account', 'cogs', 'expense account', 'cost of sales account', 'compte du cout des marchandises vendues', 'compte cmv', 'compte de charges']),
      F('reorder', 'Reorder point', 'Point de commande', ['reorder point', 'reorder', 'reorder level', 'point de commande', 'seuil de commande']),
      F('taxCode', 'Tax code', 'Code de taxe', ['tax code', 'sales tax code', 'sales tax', 'tax', 'taxable', 'taxe']),
    ],
    accounts: [
      F('number', 'Number', 'Numéro', ['account number', 'number', 'code', 'account code', 'account #', 'acct no', 'no', '#', 'numero de compte', 'n de compte']),
      F('name', 'Name', 'Nom', ['account name', 'name', 'account', 'full name', 'nom du compte', 'compte'], true),
      F('type', 'Type', 'Type', ['type', 'account type', 'type de compte', 'category', 'categorie']),
      F('detail', 'Detail type', 'Type de détail', ['detail type', 'detail', 'sub type', 'subtype', 'type de detail']),
      F('desc', 'Description', 'Description', ['description', 'desc']),
    ],
    invoices: docFields('invoices'),
    sreceipts: docFields('sreceipts'),
    credits: docFields('credits'),
    bills: docFields('bills'),
    vcredits: docFields('vcredits'),
    journal: [
      F('number', 'Journal no.', 'No d’écriture', ['journal no', 'journalno', 'journal number', 'journal #', 'je no', 'je #', 'entry no', 'entry number', 'no', 'number', 'num', 'ref', 'reference', "no d'ecriture", "numero d'ecriture", "numero de l'ecriture", 'numero']),
      F('date', 'Date', 'Date', ['journal date', 'journaldate', 'date', 'entry date', "date de l'ecriture", "date d'ecriture"], true),
      F('account', 'Account', 'Compte', ['account', 'account name', 'accountname', 'account number', 'compte', 'nom du compte', 'numero de compte'], true),
      F('debit', 'Debit', 'Débit', ['debit', 'debits', 'dr', 'debit amount', 'montant au debit']),
      F('credit', 'Credit', 'Crédit', ['credit', 'credits', 'cr', 'credit amount', 'montant au credit']),
      F('amount', 'Amount', 'Montant', ['amount']),
      F('desc', 'Description', 'Description', ['description', 'line description', 'memo', 'memo/description', 'description de la ligne', 'libelle']),
      F('name', 'Name', 'Nom', ['name', 'customer/vendor', 'customer', 'vendor', 'client', 'fournisseur', 'contact', 'client/fournisseur']),
      ...extraFields(),
      F('memo', 'Journal memo', 'Mémo de l’écriture', ['journal memo', 'entry memo', "memo de l'ecriture"]),
    ],
  };
  const fieldsOf = type => FIELDS[type] || [];

  /** Which column holds each field, from the headings: { key: columnIndex }. English or French; exact names first. */
  function guessMapping(type, head) {
    const keys = (head || []).map(headKey), used = new Set(), map = {};
    const fs = fieldsOf(type).map(f => ({ f, syn: [...new Set([f.en, f.fr, ...f.syn].map(headKey))] }));
    for (const { f, syn } of fs) for (const s of syn) {
      const i = keys.findIndex((k, j) => k && k === s && !used.has(j));
      if (i >= 0) { map[f.key] = i; used.add(i); break; }
    }
    // Then headings that contain a name as a whole word ("Customer full name", "Montant HT").
    for (const { f, syn } of fs) {
      if (map[f.key] !== undefined) continue;
      for (const s of syn.filter(x => x.length >= 4)) {
        const re = new RegExp('(^| )' + s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '( |$)');
        const i = keys.findIndex((k, j) => re.test(k) && !used.has(j));
        if (i >= 0) { map[f.key] = i; used.add(i); break; }
      }
    }
    return map;
  }
  /** The heading row: the first of the first 15 rows that names at least two fields (0 if none does). */
  function findHeader(rows, type) {
    let best = 0, score = 1;
    for (let i = 0; i < Math.min((rows || []).length, 15); i++) {
      const n = Object.keys(guessMapping(type, rows[i])).length;
      if (n > score) { best = i; score = n; }
    }
    return best;
  }
  /** Fields that must have a column before rows can be checked. */
  function missingFields(type, map) {
    const out = fieldsOf(type).filter(f => f.req && map[f.key] === undefined).map(f => f.key);
    if (isDoc(type) && ['rate', 'amount'].every(k => map[k] === undefined)) out.push('amount');
    if (type === 'journal' && ['debit', 'credit', 'amount'].every(k => map[k] === undefined)) out.push('debit');
    return out;
  }

  /* ---------- templates ---------- */
  const SAMPLES = {
    customers: [['Maple Street Dental', 'billing@maplestreet.ca', '613-555-0142', '120 Maple St', 'Ottawa', 'ON', 'K1P 1A1', 'Canada', '', ''],
      ['Acme Supplies Inc. (US)', 'ap@acme.com', '', '1 Main St', 'Buffalo', 'NY', '14201', 'USA', 'Zero-rated export', 'US customer']],
    vendors: [['Hydro Ottawa', 'billing@hydroottawa.com', '613-555-0100', '', 'Ottawa', 'ON', '', 'Canada', '', ''],
      ['Rogers', '', '1-888-555-0199', '', '', '', '', '', '', 'Phone and internet']],
    items: [['Monthly bookkeeping', 'Service', 'BK-01', 'Bookkeeping, one month', '450', '', 'Sales', '', 'HST'],
      ['Printer paper', 'Product', 'PAP-500', 'Case of 500 sheets', '12.99', '8.50', 'Sales', 'Office supplies', 'HST']],
    inventory: [['Printer paper', 'PAP-500', 'Case of 500 sheets', '12.99', '8.50', '40', '340', '2026-09-30', 'Sales', 'Inventory', 'Cost of goods sold', '10', 'HST'],
      ['Toner cartridge', 'TN-221', 'Black toner', '89', '52', '6', '', '2026-09-30', 'Sales', 'Inventory', 'Cost of goods sold', '2', 'HST']],
    accounts: [['1010', 'Savings', 'Bank', '', 'High-interest savings'], ['6450', 'Software subscriptions', 'Expense', '', '']],
    invoices: [['1001', 'Maple Street Dental', '2026-09-01', '2026-10-01', '', 'Monthly bookkeeping, August', '1', '450', '450', 'Sales', 'HST', '', '', 'Thank you!'],
      ['1001', 'Maple Street Dental', '2026-09-01', '2026-10-01', '', 'Year-end adjustments', '2', '75', '150', 'Sales', 'HST', '', '', ''],
      ['1002', 'Acme Supplies Inc. (US)', '2026-09-03', '', '', 'Consulting', '3', '120', '360', 'Sales', 'Zero-rated', '', '', '']],
    sreceipts: [['SR-1001', 'Walk-in customer', '2026-09-02', 'Chequing', '', 'Printer paper', '2', '12.99', '25.98', 'Sales', 'HST', '', '', 'Thank you!'],
      ['SR-1002', 'Maple Street Dental', '2026-09-04', 'Chequing', '', 'Rush service', '1', '75', '75', 'Sales', 'HST', '', '', '']],
    credits: [['CN-1001', 'Maple Street Dental', '2026-09-10', '', 'Discount on August bookkeeping', '1', '50', '50', 'Sales', 'HST', '', '', 'Sorry for the delay'],
      ['CN-1002', 'Acme Supplies Inc. (US)', '2026-09-12', '', 'Consulting hour not used', '1', '120', '120', 'Sales', 'Zero-rated', '', '', '']],
    bills: [['H-20931', 'Hydro Ottawa', '2026-09-05', '2026-09-25', '', 'Electricity, August', '1', '180.40', '180.40', 'Utilities', 'HST', '', '', ''],
      ['R-8841', 'Rogers', '2026-09-08', '', '', 'Internet', '1', '95', '95', 'Telephone and internet', 'HST', '', '', ''],
      ['R-8841', 'Rogers', '2026-09-08', '', '', 'Late fee', '1', '5', '5', 'Bank charges', 'Exempt', '', '', '']],
    vcredits: [['RC-77', 'Rogers', '2026-09-15', '', 'Credit for an outage', '1', '20', '20', 'Telephone and internet', 'HST', '', '', ''],
      ['HC-310', 'Hydro Ottawa', '2026-09-20', '', 'Billing correction', '1', '12.40', '12.40', 'Utilities', 'HST', '', '', '']],
    journal: [['JE-1', '2026-09-30', 'Depreciation', '250', '', 'Monthly depreciation', '', '', '', 'September depreciation'],
      ['JE-1', '2026-09-30', 'Accumulated depreciation', '', '250', 'Monthly depreciation', '', '', '', ''],
      ['JE-2', '2026-09-30', 'Prepaid expenses', '1200', '', 'Insurance paid for the year', '', '', '', 'Reclass prepaid insurance'],
      ['JE-2', '2026-09-30', 'Insurance', '', '1200', '', '', '', '', '']],
  };
  // The columns a template has (Amount is left out of journal templates; Debit and Credit cover it).
  const TEMPLATE_KEYS = { journal: ['number', 'date', 'account', 'debit', 'credit', 'desc', 'name', 'cls', 'tags', 'memo'] };
  const csvCell = v => /[",\n;]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  /** A template CSV for a type, with headings in English or French and a few example rows. */
  function template(type, lang) {
    const keys = TEMPLATE_KEYS[type] || fieldsOf(type).map(f => f.key);
    const fs = keys.map(k => fieldsOf(type).find(f => f.key === k));
    const head = fs.map(f => (lang === 'fr' ? f.fr : f.en) + (f.req ? '*' : ''));
    return [head, ...(SAMPLES[type] || [])].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /* ---------- values ---------- */
  /** A number: 1,234.56 · 1 234,56 · $12 · (12.00) · -5 · 12.50- . Returns null when it isn't one. */
  function num(s) {
    let x = norm(s).replace(/[$€£\s]|CAD|USD/gi, '');
    if (!x) return null;
    let neg = false;
    if (/^\(.*\)$/.test(x)) { neg = true; x = x.slice(1, -1); }
    if (/^-/.test(x)) { neg = !neg; x = x.slice(1); } else if (/-$/.test(x)) { neg = !neg; x = x.slice(0, -1); }
    if (/^\+/.test(x)) x = x.slice(1);
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(x)) x = x.replace(/\./g, '').replace(',', '.'); // 1.234,56
    else if (/^\d+,\d{1,2}$/.test(x) || /^\d+,\d{4,}$/.test(x)) x = x.replace(',', '.'); // 12,5 · 0,3333
    else x = x.replace(/,/g, '');
    if (!/^\d*\.?\d+$/.test(x)) return null;
    const n = parseFloat(x);
    return neg ? -n : n;
  }
  const serialDate = n => { const d = new Date(Math.round((n - 25569) * 864e5)); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
  /** A date as YYYY-MM-DD. Takes 2026-09-30, 30/09/2026 or 09/30/2026 (fmt 'dmy' or 'mdy'), Sep 30, 2026, and Excel serial numbers. */
  function parseDate(v, fmt) {
    const s = norm(v);
    if (!s) return null;
    if (/^\d{5}(\.\d+)?$/.test(s)) { const n = +s; return n >= 20000 && n <= 80000 ? serialDate(n) : null; }
    return BP.parseDate(s, 'ymd') || BP.parseDate(s, fmt === 'dmy' || fmt === 'mdy' ? fmt : 'auto');
  }
  const slashDate = v => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(norm(v));
  /** How day/month dates are written: 'mdy', 'dmy', 'auto' (no such dates, or both read the same), or 'ask'. */
  function dateFormatOf(values) {
    const vals = values.map(norm).filter(slashDate);
    if (!vals.length) return 'auto';
    const m = vals.every(v => BP.parseDate(v, 'mdy')), d = vals.every(v => BP.parseDate(v, 'dmy'));
    if (m && !d) return 'mdy';
    if (d && !m) return 'dmy';
    if (!m && !d) return 'auto';
    return vals.some(v => BP.parseDate(v, 'mdy') !== BP.parseDate(v, 'dmy')) ? 'ask' : 'auto';
  }
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  /** A tax code from its name: HST, GST, QST, TPS/TVQ, Exempt, Zero-rated, Export, None… Returns { code } or { error }. */
  function taxCode(text, co) {
    const t = fold(text).replace(/\s+/g, ' ');
    if (!t) return { code: '' };
    const pst = +co.pstRate > 0, qst = +co.qstRate > 0, rate = +co.taxRate || 0;
    if (/^(none|no tax|non[- ]?taxable|not taxable|out of scope|hors champ|hors du champ|sans taxe|aucune( taxe)?|n|nt|non)$/.test(t)) return { code: 'none' };
    if (/export/.test(t)) return { code: 'export' };
    if (/^(zero|zero[- ]?rated|z|0 ?%?|0\.0+ ?%?|detaxe|detaxee|taux zero)\b/.test(t) || /zero[- ]?rated|detaxe/.test(t)) return { code: 'zero' };
    if (/^e$|\bexempt|\bexonere|exoneration/.test(t)) return { code: 'exempt' };
    const gstOnly = /(gst|tps) ?(only|seulement)/.test(t) || (pst && /^(gst|tps)( 5 ?%?)?$/.test(t));
    if (gstOnly) return pst ? { code: 'gst' } : qst ? { error: 'gst' } : { code: 'std' };
    if (qst && /^(gst|tps)( 5 ?%?)?$/.test(t)) return { error: 'gst' };
    const pct = (t.match(/(\d+(?:[.,]\d+)?) ?%/) || [])[1];
    if (pct !== undefined) {
      const p = +pct.replace(',', '.');
      if (p === 0) return { code: 'zero' };
      if (Math.abs(p - rate) < 0.001 || (qst && Math.abs(p - co.qstRate) < 0.001)) return { code: 'std' };
      if (pst && Math.abs(p - (rate - co.pstRate)) < 0.001) return { code: 'gst' };
      return { error: 'rate' };
    }
    if (/\b(hst|gst|qst|pst|rst|tps|tvh|tvq|tvp|tvd)\b/.test(t) || /^(s|std|standard|tax|taxable|taxe|taxes|taxe de vente|sales tax|y|yes|oui|t)$/.test(t) || t === fold(co.taxName || '')) return { code: 'std' };
    return { error: 'unknown' };
  }

  /* ---------- finding what a row refers to ---------- */
  const leaf = s => { const p = norm(s).split(/\s*:\s*/); return p[p.length - 1]; };
  /** An account by its code, its name, "code name", "code - name", or "Parent:Child". */
  function findAccount(text, accounts) {
    const t = norm(text);
    if (!t) return null;
    const f = fold(t);
    return accounts.find(a => a.code && String(a.code) === t)
      || accounts.find(a => fold(a.name) === f)
      || (() => { const s = CV.splitNumber(t); return s.number ? accounts.find(a => String(a.code) === s.number) || accounts.find(a => fold(a.name) === fold(s.name)) : null; })()
      || (t.includes(':') ? findAccount(leaf(t), accounts) : null)
      || null;
  }
  // Accounts each kind of line can use (the same as the forms): income on sales; expenses, cost of goods sold or other or capital assets on purchases.
  const SALE_ACCT = a => a.type === 'Income';
  const BUY_ACCT = a => a.type === 'Expense' || a.type === 'Cost of Goods Sold' || (a.type === 'Asset' && (!a.detail || a.detail === 'capital'));
  const findItem = (text, items) => { const f = fold(text); return f ? items.find(i => fold(i.name) === f) || items.find(i => i.sku && fold(i.sku) === f) || null : null; };

  /* ---------- tags and classes ----------
   * A Tags cell holds several names with commas or semicolons between ("Trade show; Event: Open house"). A tag is found
   * by its name or by "Group: Name". Names the books don't have are added when the person ticks "Add new tags"; else
   * the row has a problem. A Class cell holds one class name, added the same way with "Add new classes".
   * Tags and classes still to be added are kept as 'new:<name>' until build() gives them ids. */
  const NEW = 'new:';
  function tagFinder(co, add) {
    const tags = Array.isArray(co.tags) ? co.tags : [], groups = Array.isArray(co.tagGroups) ? co.tagGroups : [];
    const gName = id => (groups.find(g => g.id === id) || {}).name || '';
    const label = t => (t.group && gName(t.group) ? gName(t.group) + ': ' + t.name : t.name);
    return text => {
      const out = [], bad = [];
      for (const raw of norm(text).split(/\s*[;,]\s*/).map(norm).filter(Boolean)) {
        const f = fold(raw), t = tags.find(x => fold(label(x)) === f) || tags.find(x => fold(x.name) === f);
        if (t) out.push(t.id);
        else if (add) out.push(NEW + raw.slice(0, 82));
        else bad.push(raw);
      }
      return { ids: [...new Set(out)], bad };
    };
  }
  function classFinder(co, add) {
    const cs = Array.isArray(co.classes) ? co.classes : [];
    return text => {
      const t = norm(text);
      if (!t) return { id: '' };
      const c = cs.find(x => fold(x.name) === fold(t));
      return c ? { id: c.id } : add ? { id: NEW + t.slice(0, 60) } : { bad: t };
    };
  }
  /** Read a row's Tags and Class cells: problems for unknown ones, and the ids (or names still to add). */
  function tagsAndClass(row, ctx) {
    const c = row.cells;
    if (c.tags) {
      const t = ctx.tagOf(c.tags);
      t.bad.forEach(v => row.problems.push(P('tag', { value: v })));
      row.tags = t.ids;
    } else row.tags = [];
    if (c.cls) { const k = ctx.clsOf(c.cls); if (k.bad) row.problems.push(P('class', { value: k.bad })); else row.cls = k.id; }
  }
  /** The tags of a whole document or entry: every row's, each once (at most 20, as on a form). */
  function groupTags(g) {
    const ids = [...new Set(g.rows.flatMap(r => r.tags || []))];
    if (ids.length > MAX_TAGS) g.rows[0].problems.push(P('tags-many'));
    return ids;
  }
  const MAX_TAGS = 20;
  /** A class on every line when any line has one (a line without one is '', no class), so each posting line keeps its own. */
  function lineClasses(g) {
    if (!g.rows.some(r => r.cls)) return;
    for (const r of g.rows) r.line.cls = r.cls || '';
  }

  /* ---------- checking the rows ---------- */
  const P = (code, v) => ({ code, ...(v || {}) });
  /**
   * Check every row of a table against the books.
   * table: { rows, header }; map: { field: column }
   * opts: { dateFormat, addContacts, addTags, addClasses, existing: { accounts, contacts, items, docs, entries },
   *         company: { taxName, taxRate, qstRate, pstRate, terms, closingDate, tags, tagGroups, classes },
   *         taxMissing (name of a tax with no account, or ''), filed: [{ from, to }] (filed sales tax periods), taxAccounts: [ids] }
   * Returns { type, rows: [{ n, cells, problems, status, group }], groups, newContacts, counts, warnings, dateFormat }.
   * status: 'ok' | 'error' | 'dup' (already in the books or earlier in the file) | 'skip' (another line of its document has a problem).
   */
  function check(type, table, map, opts = {}) {
    const ex = { accounts: [], contacts: [], items: [], docs: [], entries: [], ...(opts.existing || {}) };
    const co = { taxRate: 13, terms: 30, ...(opts.company || {}) };
    const body = (table.rows || []).slice((table.header || 0) + 1);
    const get = (r, k) => map[k] === undefined ? '' : norm(r[map[k]]);
    const rows = [];
    body.forEach((r, i) => { if (r.some(c => norm(c))) rows.push({ n: (table.header || 0) + i + 2, raw: r, cells: {}, problems: [], status: 'ok' }); });
    for (const row of rows) for (const f of fieldsOf(type)) row.cells[f.key] = get(row.raw, f.key);
    // Dates: one format for the whole file, asked for when 03/04/2026 could be either.
    const dateKeys = ['date', 'due', 'asOf'].filter(k => map[k] !== undefined);
    const found = dateFormatOf(rows.flatMap(r => dateKeys.map(k => r.cells[k])));
    const fmt = opts.dateFormat === 'mdy' || opts.dateFormat === 'dmy' ? opts.dateFormat : found;
    const date = (row, k, req) => {
      const v = row.cells[k];
      if (!v) { if (req) row.problems.push(P('required', { field: k })); return ''; }
      if (fmt === 'ask' && slashDate(v)) { row.problems.push(P('date-format')); return ''; }
      const d = parseDate(v, fmt);
      if (!d) row.problems.push(P('date', { value: v }));
      return d || '';
    };
    const out = { type, rows, groups: [], newContacts: [], newTags: [], newClasses: [], warnings: [], dateFormat: found };
    const tagOf = tagFinder(co, !!opts.addTags), clsOf = classFinder(co, !!opts.addClasses);
    const check1 = isDoc(type) ? checkDocs : ({ customers: checkContacts, vendors: checkContacts, items: checkItems, inventory: checkInventory, accounts: checkAccounts, journal: checkJournal })[type];
    if (!check1) throw new Error('Unknown kind of import: ' + type);
    check1(out, { ex, co, opts, date, tagOf, clsOf });
    // Tags and classes still to be added, only those a good record uses (shown next to the "Add new…" boxes).
    const okRows = out.groups.length ? out.groups.filter(g => g.status === 'ok').flatMap(g => g.rows) : [];
    const want = (pick) => [...new Set(okRows.flatMap(pick).filter(x => x && String(x).startsWith(NEW)).map(x => x.slice(NEW.length)))];
    out.newTags = want(r => r.tags || []);
    out.newClasses = want(r => [r.cls]);
    // Names the file uses that the books don't have, whether or not they're added (to say how many the box would add).
    out.unknownTags = [...new Set(rows.flatMap(r => r.problems.filter(p => p.code === 'tag').map(p => p.value)).concat(out.newTags).map(fold))].length;
    out.unknownClasses = [...new Set(rows.flatMap(r => r.problems.filter(p => p.code === 'class').map(p => p.value)).concat(out.newClasses).map(fold))].length;
    for (const r of rows) if (r.status === 'ok' && r.problems.length) r.status = 'error';
    // Dated on or before the closing date, or in a period whose sales tax return was filed: the import asks first, as the forms do.
    const dates = out.groups.length ? out.groups.filter(g => g.status === 'ok').map(g => g.date) : [];
    if (co.closingDate) { const n = dates.filter(d => d && d <= co.closingDate).length; if (n) out.warnings.push({ code: 'closed', count: n, date: co.closingDate }); }
    if (opts.filed && opts.filed.length) {
      const n = out.groups.filter(g => g.status === 'ok' && g.taxed && opts.filed.some(f => f.from <= g.date && g.date <= f.to)).length;
      if (n) out.warnings.push({ code: 'filed', count: n });
    }
    out.counts = {
      rows: rows.length, ok: rows.filter(r => r.status === 'ok').length, error: rows.filter(r => r.status === 'error' || r.status === 'skip').length, dup: rows.filter(r => r.status === 'dup').length,
      records: out.groups.length ? out.groups.filter(g => g.status === 'ok').length : rows.filter(r => r.status === 'ok').length,
    };
    return out;
  }

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CONTACT_TAX = { std: '', gst: 'gst', zero: 'zero', export: 'export', exempt: 'exempt', none: 'none' };
  function checkContacts(out, { ex, co }) {
    const kind = out.type === 'customers' ? 'customer' : 'vendor';
    const have = new Set(ex.contacts.filter(c => c.kind === kind).map(c => fold(c.name))), seen = new Set();
    for (const row of out.rows) {
      const c = row.cells, k = fold(c.name);
      if (!k) { row.problems.push(P('required', { field: 'name' })); continue; }
      if (have.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'exists', value: c.name })); continue; }
      if (seen.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'file', value: c.name })); continue; }
      seen.add(k);
      if (c.email && !c.email.split(/[;,]\s*/).every(e => EMAIL.test(e))) row.problems.push(P('email', { value: c.email }));
      const t = taxCode(c.taxCode, co);
      if (t.error) row.problems.push(P('tax', { value: c.taxCode, why: t.error }));
      const place = [c.city, [c.province, c.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      row.record = { name: c.name.slice(0, 160), kind, email: c.email, phone: c.phone, address: [c.address, place, c.country].filter(Boolean).join('\n'), notes: c.notes, taxCode: CONTACT_TAX[t.code] || '' };
    }
  }

  function checkItems(out, { ex, co }) {
    const have = new Set(ex.items.map(i => fold(i.name))), seen = new Set();
    for (const row of out.rows) {
      const c = row.cells, k = fold(c.name);
      if (!k) { row.problems.push(P('required', { field: 'name' })); continue; }
      if (have.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'exists', value: c.name })); continue; }
      if (seen.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'file', value: c.name })); continue; }
      seen.add(k);
      const ty = fold(c.type);
      let type = 'service';
      if (/inventor|stock|inventaire/.test(ty) && !/non/.test(ty)) row.problems.push(P('inventory'));
      else if (/product|produit|goods|biens|non[- ]?inventor|non[- ]?stock|article/.test(ty)) type = 'product';
      else if (ty && !/service|bundle|groupe/.test(ty)) row.problems.push(P('item-type', { value: c.type }));
      const acct = (k2, ok, need) => {
        if (!c[k2]) return '';
        const a = findAccount(c[k2], ex.accounts);
        if (!a) { row.problems.push(P('account', { value: c[k2] })); return ''; }
        if (!ok(a)) { row.problems.push(P('account-kind', { value: c[k2], need })); return ''; }
        return a.id;
      };
      const inc = acct('incomeAccount', SALE_ACCT, 'income'), exp = acct('expenseAccount', a => ['Expense', 'Cost of Goods Sold', 'Asset'].includes(a.type), 'expense');
      if (!c.incomeAccount && !c.expenseAccount) row.problems.push(P('item-acct'));
      const money = k2 => { if (!c[k2]) return ''; const n = num(c[k2]); if (n === null) { row.problems.push(P('amount', { value: c[k2] })); return ''; } return n; };
      const price = money('price'), cost = money('cost');
      const t = taxCode(c.taxCode, co);
      if (t.error) row.problems.push(P('tax', { value: c.taxCode, why: t.error }));
      row.record = { name: c.name.slice(0, 120), type, sku: c.sku.slice(0, 60), desc: c.desc, price, cost, incomeAccount: inc, expenseAccount: exp, taxCode: t.code || 'std', sold: !!c.incomeAccount, bought: !!c.expenseAccount, active: true };
    }
  }

  // Inventory items: counted in stock, bought into an inventory asset account, each sale's cost to cost of goods sold.
  // The quantity on hand and its value on the As of date are the item's starting stock, saved as the product form saves it.
  const INV_ASSET = a => a.type === 'Asset' && !['bank', 'card', 'ar'].includes(a.detail);
  const INV_COGS = a => a.type === 'Cost of Goods Sold' || a.type === 'Expense';
  function checkInventory(out, { ex, co, date }) {
    const have = new Set(ex.items.map(i => fold(i.name))), seen = new Set();
    const live = ex.accounts.filter(a => a.active !== false), byCode = (a, b) => String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true });
    // Like the product form: the first income account, an asset account named for inventory, the first cost of goods sold account.
    const def = { incomeAccount: live.filter(SALE_ACCT).sort(byCode)[0], assetAccount: live.filter(a => INV_ASSET(a) && /inventor|stock/i.test(a.name)).sort(byCode)[0], cogsAccount: live.filter(a => a.type === 'Cost of Goods Sold').sort(byCode)[0] };
    for (const row of out.rows) {
      const c = row.cells, k = fold(c.name);
      if (!k) { row.problems.push(P('required', { field: 'name' })); continue; }
      if (have.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'exists', value: c.name })); continue; }
      if (seen.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'file', value: c.name })); continue; }
      seen.add(k);
      const acct = (key, ok, need) => {
        if (!c[key]) { if (def[key]) return def[key].id; row.problems.push(P('inv-acct', { need })); return ''; }
        const a = findAccount(c[key], ex.accounts);
        if (!a) { row.problems.push(P('account', { value: c[key] })); return ''; }
        if (!ok(a)) { row.problems.push(P('account-kind', { value: c[key], need })); return ''; }
        return a.id;
      };
      const inc = acct('incomeAccount', SALE_ACCT, 'income'), asset = acct('assetAccount', INV_ASSET, 'asset'), cogs = acct('cogsAccount', INV_COGS, 'cogs');
      const n = (key, min0) => { if (!c[key]) return ''; const v = num(c[key]); if (v === null) { row.problems.push(P('amount', { value: c[key] })); return ''; } if (min0 && v < 0) { row.problems.push(P('negative', { field: key })); return ''; } return v; };
      const price = n('price'), cost = n('cost', true), qty = n('qty', true), reorder = n('reorder', true);
      let value = n('value', true);
      // No value given: the quantity at its cost.
      if (value === '' && qty !== '' && cost !== '') value = r2(qty * cost);
      const asOf = date(row, 'asOf', false);
      if ((+qty || +value) && !asOf && !c.asOf) row.problems.push(P('required', { field: 'asOf' }));
      const t = taxCode(c.taxCode, co);
      if (t.error) row.problems.push(P('tax', { value: c.taxCode, why: t.error }));
      row.record = { name: c.name.slice(0, 120), type: 'inventory', sku: c.sku.slice(0, 60), desc: c.desc, price, cost, incomeAccount: inc, assetAccount: asset, cogsAccount: cogs, expenseAccount: asset,
        qtyStart: qty === '' ? 0 : Math.round(qty * 10000) / 10000, valueStart: value === '' ? 0 : r2(value), startDate: (+qty || +value) ? asOf : '', reorder, taxCode: t.code || 'std', sold: true, bought: true, active: true };
    }
  }

  const SUMLORA_TYPES = { asset: 'Asset', actif: 'Asset', liability: 'Liability', passif: 'Liability', equity: 'Equity', 'capitaux propres': 'Equity', income: 'Income', revenue: 'Income', revenus: 'Income', produits: 'Income',
    'cost of goods sold': 'Cost of Goods Sold', 'cout des produits vendus': 'Cost of Goods Sold', 'cout des ventes': 'Cost of Goods Sold', expense: 'Expense', expenses: 'Expense', depenses: 'Expense', charges: 'Expense' };
  const ONE_ONLY = ['ar', 'ap', 'tax', 'qst', 'pst', 'ob']; // books have one of each; a second would split the balance
  function checkAccounts(out, { ex }) {
    const names = new Set(ex.accounts.map(a => fold(a.name))), codes = new Set(ex.accounts.map(a => String(a.code || '')).filter(Boolean));
    const details = new Set(ex.accounts.map(a => a.detail).filter(Boolean)), seenN = new Set(), seenC = new Set();
    for (const row of out.rows) {
      const c = row.cells;
      let name = leaf(c.name), number = c.number;
      if (!number) { const s = CV.splitNumber(name); if (s.number) { number = s.number; name = s.name; } }
      const k = fold(name);
      if (!k) { row.problems.push(P('required', { field: 'name' })); continue; }
      if (names.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'exists', value: name })); continue; }
      if (seenN.has(k)) { row.status = 'dup'; row.problems.push(P('dup', { why: 'file', value: name })); continue; }
      seenN.add(k);
      if (number && (codes.has(number) || seenC.has(number))) row.problems.push(P('code-used', { value: number }));
      if (number) seenC.add(number);
      if (number.length > 20) row.problems.push(P('code-long', { value: number }));
      const g = CV.guessType({ srcType: c.type, srcDetail: c.detail, name, fullName: c.name, number });
      const exact = SUMLORA_TYPES[fold(c.type)];
      const type = exact || g.type;
      let detail = g.type === type ? g.detail || '' : '';
      if (ONE_ONLY.includes(detail) && details.has(detail)) detail = '';
      if (detail) details.add(detail);
      row.record = { type, detail, code: number, name: name.slice(0, 120), desc: c.desc, cf: '', active: true };
    }
  }

  // A sales receipt's money goes into a bank, card or cash account (the same accounts as the form).
  const DEPOSIT_ACCT = a => a.detail === 'bank' || a.detail === 'card' || (a.type === 'Asset' && !a.detail && /undeposited|cash|caisse|fonds non/i.test(a.name));
  // Invoices, sales receipts, credit notes, bills and vendor credits: one row per line; rows with the same number
  // (and customer or vendor) are one document.
  function checkDocs(out, { ex, co, opts, date, tagOf, clsOf }) {
    const D = DOCS[out.type], sale = D.sale, kind = D.kind, ck = sale ? 'customer' : 'vendor';
    const defBank = (ex.accounts.filter(a => a.detail === 'bank' && a.active !== false && !a.currency).sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true }))[0] || {}).id || '';
    const contacts = new Map();
    for (const c of ex.contacts) if (c.kind === ck && !contacts.has(fold(c.name))) contacts.set(fold(c.name), c);
    const okAcct = sale ? SALE_ACCT : BUY_ACCT, items = ex.items.filter(i => i.active !== false && (sale ? i.sold !== false : i.bought));
    const newC = new Map();
    for (const row of out.rows) {
      const c = row.cells, L = {};
      // Customer or vendor
      let contact = null;
      if (!c.contact) row.problems.push(P('required', { field: 'contact' }));
      else if ((contact = contacts.get(fold(c.contact)))) { if (contact.currency) row.problems.push(P('contact-cur', { value: c.contact })); }
      else if (opts.addContacts) { if (!newC.has(fold(c.contact))) newC.set(fold(c.contact), { name: c.contact.slice(0, 160), kind: ck }); }
      else row.problems.push(P('contact', { value: c.contact, kind: ck }));
      row.contactId = contact ? contact.id : '';
      row.date = date(row, 'date', true);
      row.due = D.due ? date(row, 'due', false) : '';
      if (out.type === 'sreceipts') {
        if (c.bank) { const b = findAccount(c.bank, ex.accounts); if (!b) row.problems.push(P('account', { value: c.bank })); else if (!DEPOSIT_ACCT(b) || b.currency) row.problems.push(P('bank', { value: c.bank })); else row.bank = b.id; }
      }
      tagsAndClass(row, { tagOf, clsOf });
      // Product or service
      const item = c.item ? findItem(c.item, items) : null;
      if (c.item && !item) row.problems.push(P('item', { value: c.item }));
      if (item) L.item = item.id;
      // Quantity, rate and amount: any two make the third.
      const n = k => { if (!c[k]) return null; const v = num(c[k]); if (v === null) row.problems.push(P('amount', { value: c[k] })); return v; };
      let qty = n('qty'), rate = n('rate');
      const amt = n('amount');
      if (rate === null && amt === null && item) { const d = sale ? item.price : item.cost; if (d !== '' && d != null) rate = +d; }
      if (rate === null && amt !== null) { const q = qty === null ? 1 : qty; rate = q ? amt / q : amt; if (!q) qty = 1; }
      if (qty === null) qty = 1;
      if (rate !== null && amt !== null && Math.abs(r2(qty * rate) - amt) > 0.011) row.problems.push(P('qty-rate'));
      if ((rate === null || !r2(qty * rate)) && !c.desc && !row.problems.some(p => p.code === 'amount')) row.problems.push(P('no-amount'));
      L.qty = qty; L.rate = rate === null ? 0 : Math.round(rate * 1e6) / 1e6;
      // Account: as written, or the product's. A line with only a description doesn't need one (it isn't posted).
      if (c.account) {
        const a = findAccount(c.account, ex.accounts);
        if (!a) row.problems.push(P('account', { value: c.account }));
        else if (!okAcct(a)) row.problems.push(P('account-kind', { value: c.account, need: sale ? 'income' : 'expense' }));
        else L.account = a.id;
      } else if (item && (sale ? item.incomeAccount : item.expenseAccount)) L.account = sale ? item.incomeAccount : item.expenseAccount;
      else if (r2(L.qty * L.rate)) row.problems.push(P('no-account', { sale }));
      L.desc = c.desc || (item ? item.desc || item.name : '');
      // Tax code: as written, or the customer's or vendor's default, then the product's, then the company's tax.
      const t = taxCode(c.taxCode, co);
      if (t.error) row.problems.push(P('tax', { value: c.taxCode, why: t.error }));
      L.taxCode = t.code || (contact && contact.taxCode) || (item && item.taxCode) || 'std';
      if (opts.taxMissing && (L.taxCode === 'std' || L.taxCode === 'gst') && r2(L.qty * L.rate)) row.problems.push(P('tax-acct', { name: opts.taxMissing }));
      row.line = L;
    }
    out.newContacts = [...newC.values()];
    // Group the lines. Rows with no number join the row above when it has the same customer or vendor and date.
    const groups = [], byKey = new Map();
    let last = null;
    for (const row of out.rows) {
      const num0 = row.cells.number, who = fold(row.cells.contact);
      let g;
      if (num0) {
        const key = sale ? fold(num0) : fold(num0) + '|' + who;
        g = byKey.get(key);
        if (!g) { g = { kind, number: num0, contactKey: who, rows: [] }; byKey.set(key, g); groups.push(g); }
      } else if (last && !last.number && last.contactKey === who && last.rows[0].date === row.date) g = last;
      else { g = { kind, number: '', contactKey: who, rows: [] }; groups.push(g); }
      g.rows.push(row); last = g;
      const first = g.rows[0];
      if (row !== first) {
        if (sale && who !== fold(first.cells.contact)) row.problems.push(P('group-contact', { value: num0 }));
        else if (row.date && first.date && row.date !== first.date) row.problems.push(P('group-date', { value: num0 }));
      }
    }
    // Numbers: invoices, sales receipts and credit notes with none get the next ones (as the forms do); a number already in the books is a duplicate.
    const nums = ex.docs.filter(d => d.kind === kind), pre = D.prefix || '';
    const numOf = n => { const s = String(n || ''); return pre && s.toUpperCase().startsWith(pre) ? parseInt(s.slice(pre.length)) || 0 : pre ? 0 : (/^\d+$/.test(s) ? +s : parseInt(s) || 0); };
    let next = sale ? Math.max(1000, ...nums.map(d => numOf(d.number)), ...groups.map(g => numOf(g.number))) : 0;
    for (const g of groups) {
      const first = g.rows[0], cid = first.contactId;
      Object.assign(g, { contactId: cid, newContact: cid ? '' : first.cells.contact, date: first.date, due: D.due ? g.rows.map(r => r.due).find(Boolean) || (first.date ? addDays(first.date, +co.terms || 0) : '') : '',
        memo: g.rows.map(r => r.cells.memo).find(Boolean) || '', lines: g.rows.map(r => r.line) });
      if (out.type === 'sreceipts') { g.bank = g.rows.map(r => r.bank).find(Boolean) || defBank; if (!g.bank && !first.problems.length) first.problems.push(P('no-bank')); }
      lineClasses(g);
      g.tags = groupTags(g);
      if (!g.number && sale) { g.number = pre + (++next); g.auto = true; }
      const dup = g.number && !g.auto && nums.find(d => fold(d.number) === fold(g.number) && (sale || (cid && d.contactId === cid)));
      const total = r2(g.lines.reduce((s, l) => s + r2((+l.qty || 0) * (+l.rate || 0)), 0));
      g.taxed = g.lines.some(l => (l.taxCode === 'std' || l.taxCode === 'gst') && r2(l.qty * l.rate));
      if (dup) { g.status = 'dup'; g.rows.forEach(r => { r.status = 'dup'; r.problems = [P('dup', { why: 'exists', value: g.number, kind })]; }); continue; }
      if (!g.rows.some(r => r.problems.length) && total <= 0) first.problems.push(P('total'));
      const bad = g.rows.some(r => r.problems.length);
      g.status = bad ? 'error' : 'ok';
      if (bad) g.rows.forEach(r => { if (!r.problems.length) { r.status = 'skip'; r.problems.push(P('group', { kind })); } });
    }
    out.groups = groups;
  }

  // Journal entries: rows with the same journal number are one entry, which has to balance.
  // Rows with no number join the entry above until it balances.
  function checkJournal(out, { ex, opts, date, tagOf, clsOf }) {
    for (const row of out.rows) {
      const c = row.cells;
      row.date = date(row, 'date', true);
      tagsAndClass(row, { tagOf, clsOf });
      let account = null;
      if (!c.account) row.problems.push(P('required', { field: 'account' }));
      else if (!(account = findAccount(c.account, ex.accounts))) row.problems.push(P('account', { value: c.account }));
      const n = k => { if (!c[k]) return 0; const v = num(c[k]); if (v === null) { row.problems.push(P('amount', { value: c[k] })); return 0; } return v; };
      let dr = n('debit'), cr = n('credit');
      if (!dr && !cr) { const a = n('amount'); if (a > 0) dr = a; else cr = -a; }
      if (dr < 0) { cr += -dr; dr = 0; }
      if (cr < 0) { dr += -cr; cr = 0; }
      dr = r2(dr); cr = r2(cr);
      if (dr && cr) row.problems.push(P('both'));
      else if (!dr && !cr && !row.problems.some(p => p.code === 'amount')) row.problems.push(P('no-amount'));
      let contactId = '';
      if (c.name) { const k = fold(c.name), ct = ex.contacts.find(x => fold(x.name) === k); if (ct) contactId = ct.id; else row.problems.push(P('contact', { value: c.name, kind: 'any' })); }
      row.line = { account: account ? account.id : '', debit: dr, credit: cr, memo: c.desc };
      row.contactId = contactId;
    }
    const groups = [], byKey = new Map(), bal = g => r2(g.rows.reduce((s, r) => s + r.line.debit - r.line.credit, 0));
    let open = null;
    for (const row of out.rows) {
      const no = row.cells.number;
      let g;
      if (no) { g = byKey.get(fold(no)); if (!g) { g = { kind: 'journal', number: no, rows: [] }; byKey.set(fold(no), g); groups.push(g); } open = null; }
      else if (open && open.rows[0].date === row.date && bal(open)) g = open;
      else { g = { kind: 'journal', number: '', rows: [] }; groups.push(g); open = g; }
      if (g.rows.length && row.date && g.rows[0].date && row.date !== g.rows[0].date) row.problems.push(P('group-date', { value: no }));
      g.rows.push(row);
    }
    for (const g of groups) {
      const first = g.rows[0];
      Object.assign(g, { date: first.date, memo: g.rows.map(r => r.cells.memo).find(Boolean) || '', contactId: g.rows.map(r => r.contactId).find(Boolean) || '', lines: g.rows.map(r => r.line) });
      lineClasses(g);
      g.tags = groupTags(g);
      const tax = new Set(opts.taxAccounts || []);
      g.taxed = g.lines.some(l => tax.has(l.account)); // only entries that move a sales tax account touch a return
      if (g.number && ex.entries.some(e => e.type === 'journal' && e.ref && fold(e.ref) === fold(g.number))) {
        g.status = 'dup'; g.rows.forEach(r => { r.status = 'dup'; r.problems = [P('dup', { why: 'exists', value: g.number, kind: 'journal' })]; }); continue;
      }
      if (!g.rows.some(r => r.problems.length)) {
        const d = r2(g.lines.reduce((s, l) => s + l.debit, 0)), c = r2(g.lines.reduce((s, l) => s + l.credit, 0));
        if (!d || !c) g.rows[g.rows.length - 1].problems.push(P('one-sided', { value: g.number }));
        else if (Math.abs(d - c) > 0.004) g.rows[g.rows.length - 1].problems.push(P('unbalanced', { value: g.number, diff: r2(d - c) }));
      }
      const bad = g.rows.some(r => r.problems.length);
      g.status = bad ? 'error' : 'ok';
      if (bad) g.rows.forEach(r => { if (!r.problems.length) { r.status = 'skip'; r.problems.push(P('group', { kind: 'journal' })); } });
    }
    out.groups = groups;
  }

  /* ---------- the writes ---------- */
  /**
   * The good rows as writes for one batch: new records only, never a change to one already there.
   * h: { uid, now }, and for invoices and bills the forms' own posting: { calcLines, docPostLines, docRecord, arId (or apId), invCosts? },
   * so an imported invoice is saved exactly as one made in the form.
   */
  function build(res, h) {
    const writes = [], counts = {}, now = h.now || Date.now();
    const add = (collection, data, id) => { id = id || h.uid(); writes.push({ op: 'set', collection, id, data }); counts[collection] = (counts[collection] || 0) + 1; return id; };
    const t = res.type;
    if (t === 'customers' || t === 'vendors' || t === 'items' || t === 'inventory' || t === 'accounts') {
      const col = t === 'items' || t === 'inventory' ? 'items' : t === 'accounts' ? 'accounts' : 'contacts';
      res.rows.filter(r => r.status === 'ok' && r.record).forEach((r, i) => add(col, col === 'contacts' ? { ...r.record, created: now + i } : r.record));
      return { writes, counts };
    }
    const good = res.groups.filter(g => g.status === 'ok');
    // New tags and classes get the ids newLists() gave them (they're added to the company's lists just before).
    const real = (x, ids) => { if (!String(x || '').startsWith(NEW)) return x; const id = ids && ids[fold(x.slice(NEW.length))]; if (!id) throw new Error('Add the new tags and classes first.'); return id; };
    for (const g of good) { g.tags = (g.tags || []).map(x => real(x, h.tagIds)); g.lines.forEach(l => { if (l.cls) l.cls = real(l.cls, h.classIds); }); }
    const tagsOf = g => (g.tags && g.tags.length ? { tags: g.tags } : {});
    if (t === 'journal') {
      good.forEach((g, i) => add('entries', { type: 'journal', date: g.date, ref: g.number, memo: g.memo, contactId: g.contactId, lines: g.lines.map(l => ({ account: l.account, debit: l.debit, credit: l.credit, memo: l.memo || '', ...(l.cls != null ? { cls: l.cls } : {}) })), created: now + i, adjusting: false, reverseOn: '', ...tagsOf(g) }));
      return { writes, counts };
    }
    const D = DOCS[t], sale = D.sale, kind = D.kind, sr = kind === 'sreceipt', ctl = sr ? 'bank' : sale ? h.arId : h.apId;
    if (!ctl) throw new Error(sale ? 'Add an Accounts receivable account in Chart of accounts first.' : 'Add an Accounts payable account in Chart of accounts first.');
    // New customers or vendors first, only those a good document uses.
    const newIds = new Map();
    for (const g of good) if (!g.contactId) {
      const k = fold(g.newContact);
      if (!newIds.has(k)) { const nc = res.newContacts.find(c => fold(c.name) === k); newIds.set(k, add('contacts', { name: nc ? nc.name : g.newContact, kind: sale ? 'customer' : 'vendor', created: now })); }
    }
    good.forEach((g, i) => {
      const c = h.calcLines(g.lines, x => (+x.qty || 0) * (+x.rate || 0), !sale);
      const id = h.uid();
      if (h.invCosts) h.invCosts(kind, c, g.date, id);
      // Tags go on the document and on its journal entry (reports add up journal entries), as the form does.
      const base = { date: g.date, contactId: g.contactId || newIds.get(fold(g.newContact)), memo: g.memo, ...tagsOf(g) };
      const created = now + 1 + i;
      add('docs', { ...base, kind, number: g.number, due: g.due || '', ...h.docRecord(c), ...(sr ? { depositTo: g.bank } : {}), ...(kind === 'credit' || kind === 'vcredit' ? { applied: [] } : {}), created }, id);
      add('entries', { ...base, type: sr ? 'salesreceipt' : kind, ref: g.number, docId: id, lines: h.docPostLines(kind, c, sr ? g.bank : ctl), created }, 'd_' + id);
    });
    return { writes, counts };
  }

  /**
   * The company's tag and class lists with the import's new ones added (only those a good record uses), and the id each
   * new name gets: { tags, classes, tagIds, classIds, added: { tags, classes } }. "Event: Spring fair" goes in the Event
   * group when the company has one, as on a form.
   */
  function newLists(res, co, uid) {
    const tags = (co.tags || []).slice(), classes = (co.classes || []).slice(), groups = co.tagGroups || [], tagIds = {}, classIds = {};
    for (const raw of res.newTags || []) {
      let name = raw, group = '';
      const m = raw.match(/^([^:]{1,40}):\s*(.+)$/);
      if (m) { const g = groups.find(x => fold(x.name) === fold(m[1])); if (g) { group = g.id; name = m[2]; } }
      name = norm(name).slice(0, 40);
      const same = tags.find(t => (t.group || '') === group && fold(t.name) === fold(name));
      if (same) { tagIds[fold(raw)] = same.id; continue; }
      const t = { id: uid(), name, group };
      tags.push(t); tagIds[fold(raw)] = t.id;
    }
    for (const raw of res.newClasses || []) {
      const same = classes.find(c => fold(c.name) === fold(raw));
      if (same) { classIds[fold(raw)] = same.id; continue; }
      const c = { id: uid(), name: norm(raw).slice(0, 60), active: true };
      classes.push(c); classIds[fold(raw)] = c.id;
    }
    return { tags, classes, tagIds, classIds, added: { tags: tags.length - (co.tags || []).length, classes: classes.length - (co.classes || []).length } };
  }

  /** The rows that weren't imported, as a CSV with what was wrong, to fix and import again. msg(problem) gives the text. */
  function leftoverCsv(table, res, msg) {
    const head = (table.rows[table.header || 0] || []).slice();
    const out = [[...head, 'Problem']];
    for (const r of res.rows) if (r.status !== 'ok') out.push([...r.raw.map(v => v == null ? '' : v), r.problems.map(msg).join(' ')]);
    return out.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  return { TYPES, DOCS, FIELDS, fieldsOf, guessMapping, findHeader, missingFields, template, num, parseDate, dateFormatOf, taxCode, findAccount, check, build, newLists, leftoverCsv, headKey };
});
