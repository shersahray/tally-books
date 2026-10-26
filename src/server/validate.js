'use strict';
const GIFI = require('../../public/gifi.js');
const PLANS = require('../../public/plans.js');
const IND = require('../../public/industries.js');
const RECUR = require('../../public/recurring-calc.js');
const REPFILTER = require('../../public/report-filters.js');
const TAGS = require('../../public/tags.js');
const APPROVALS = require('../../public/approvals.js');
const DEP = require('../../public/deposits-calc.js');
const PAYCALC = require('../../public/payroll-calc.js');
const DELAYED = require('../../public/delayed-calc.js');
const WF = require('../../public/workflows.js');
const ENGAGE = require('../../public/engagements-calc.js');
// Server-side rules that keep the books consistent no matter what the client sends.

const TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Cost of Goods Sold', 'Expense'];
const DETAILS = {
  Asset: ['', 'bank', 'ar', 'capital'],
  Liability: ['', 'card', 'ap', 'tax', 'qst', 'pst', 'payroll_cra', 'payroll_rq', 'payroll_other', 'vacation_payable', 'wsib_payable', 'eht_payable', 'custdep'],
  Equity: ['', 'ob'],
  Income: [''],
  'Cost of Goods Sold': [''],
  Expense: ['', 'wages', 'payroll_tax', 'wsib', 'eht'],
};
const ENTRY_TYPES = ['invoice', 'salesreceipt', 'invadjust', 'bill', 'payment', 'billpayment', 'expense', 'deposit', 'transfer', 'journal', 'taxpayment', 'payrun', 'payremit', 'credit', 'vcredit', 'refund', 'vrefund', 'qmadjust', 'custdeposit', 'depapply', 'deprefund'];
const PAY_PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const PAY_FREQ = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
const ID_RE = /^[A-Za-z0-9_.:@+~-]{1,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const cents = n => Math.round(Number(n) * 100);
// Match the forms' r2() for computed products such as 1.005 and foreign-currency amounts.
const computedCents = n => Math.round(Number(n) * 100 + Number.EPSILON * 100);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isDate = s => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
};
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).slice(0, max));

/** Tags on a transaction, invoice, bill or bank rule: known tag ids of the company, at most 20. Sets or removes out.tags. */
function withTags(out, data, store) {
  let tags;
  try {
    const has = data.tags !== undefined && data.tags !== null && !(Array.isArray(data.tags) && !data.tags.length);
    const known = has && store && typeof store.getSetting === 'function' ? ((store.getSetting('company') || {}).tags || []).map(t => t.id) : [];
    tags = TAGS.cleanTags(data.tags, known);
  } catch (e) { throw new ValidationError(e.message); }
  if (tags) out.tags = tags; else delete out.tags;
  return out;
}

/** Classes on lines (company setting classPerLine): each line's cls is '' (no class) or one of the company's classes.
    Checked whatever the setting says, since turning it off keeps the classes already on lines. A class the record
    already had on a line stays allowed, so an old transaction can still be saved after its class was removed. */
function checkLineClasses(lines, store, prev) {
  if (!Array.isArray(lines) || !lines.some(l => isObj(l) && l.cls !== undefined)) return;
  const known = new Set(((store && typeof store.getSetting === 'function' ? store.getSetting('company') : null) || {}).classes?.map(c => c.id) || []);
  for (const l of [...((prev && prev.lines) || []), ...((prev && prev.form && prev.form.lines) || [])]) if (l && typeof l.cls === 'string' && l.cls) known.add(l.cls);
  lines.forEach((l, i) => {
    if (!isObj(l) || l.cls === undefined) return;
    if (l.cls === null || l.cls === '') { l.cls = ''; return; }
    if (typeof l.cls !== 'string' || !known.has(l.cls)) throw new ValidationError(`Line ${i + 1} has a class that doesn’t exist. Add it under Settings first.`);
  });
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ValidationError('Invalid record id.');
}

function validateAccount(data, store, id) {
  if (!str(data.name).trim()) throw new ValidationError('An account needs a name.');
  if (!TYPES.includes(data.type)) throw new ValidationError(`Account type must be one of: ${TYPES.join(', ')}.`);
  const detail = data.detail || '';
  if (!DETAILS[data.type].includes(detail)) throw new ValidationError(`"${detail}" is not a valid detail for ${data.type} accounts.`);
  const code = str(data.code, 20).trim();
  if (code && store.list('accounts').some(a => a.id !== id && a.code === code)) {
    throw new ValidationError(`Account code ${code} is already used.`, 409);
  }
  const prev = store.get('accounts', id);
  if (prev && prev.type !== data.type && store.accountUsed(id)) {
    throw new ValidationError('This account has transactions, so its type can’t change.', 409);
  }
  const cf = ['operating', 'investing', 'financing'].includes(data.cf) ? data.cf : '';
  // GIFI code for the T2 return. A new account added without one (by payroll or sales tax, say) gets a likely one.
  let gifi = data.gifi === undefined || data.gifi === null ? (prev ? prev.gifi || '' : GIFI.suggest({ ...data, detail })) : str(data.gifi, 8).trim();
  const bad = GIFI.problem(gifi, data.type);
  if (bad) {
    if (data.gifi === undefined || data.gifi === null) gifi = ''; // kept from before a type change, or a suggestion: just drop it
    else throw new ValidationError(bad);
  }
  // A bank or credit card account can be in another currency (US dollars, say). Everything else is in Canadian dollars.
  const currency = ['bank', 'card'].includes(detail) && CURRENCY_RE.test(String(data.currency || '')) && data.currency !== 'CAD' ? data.currency : '';
  if (prev && (prev.currency || '') !== currency && store.accountUsed(id)) throw new ValidationError('This account has transactions, so its currency can’t change.', 409);
  const out = { ...data, name: str(data.name, 120).trim(), code, detail, desc: str(data.desc), cf, gifi, active: data.active !== false };
  if (currency) out.currency = currency; else delete out.currency;
  return out;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
function validateContact(data, store, id) {
  if (!str(data.name).trim()) throw new ValidationError('A contact needs a name.');
  if (!['customer', 'vendor'].includes(data.kind)) throw new ValidationError('Contact kind must be customer or vendor.');
  const out = { ...data, name: str(data.name, 160).trim() };
  const cur = CURRENCY_RE.test(String(data.currency || '')) && data.currency !== 'CAD' ? data.currency : '';
  const prev = store && id ? store.get('contacts', id) : null;
  if (prev && (prev.currency || '') !== cur && store.list('docs').some(d => d.contactId === id)) throw new ValidationError('This customer or vendor has invoices or bills, so their currency can’t change.', 409);
  if (cur) out.currency = cur; else delete out.currency;
  return out;
}

const DOC_KINDS = ['invoice', 'sreceipt', 'bill', 'credit', 'vcredit'];
// What a credit can be used against: a customer credit note against invoices, a vendor credit against bills.
const CREDIT_FOR = { credit: 'invoice', vcredit: 'bill' };
/** Amount already settled on a document: payments and refunds pointing at it, and credits used on it (or, for a credit, used from it). */
function settledOn(store, docId, exceptCreditId, exceptEntryId) {
  let s = 0;
  for (const e of store.list('entries')) if (e.applyTo === docId && e.id !== exceptEntryId) s += Number(e.amount) || 0;
  for (const c of store.list('docs')) {
    if (!c.applied || c.id === exceptCreditId) continue;
    for (const a of c.applied) if (a.docId === docId || c.id === docId) s += Number(a.amount) || 0;
  }
  return Math.round(s * 100) / 100;
}
function validateDoc(data, store, id) {
  if (!DOC_KINDS.includes(data.kind)) throw new ValidationError('Document kind must be invoice, sales receipt, bill, credit note or vendor credit.');
  // A sales receipt is paid on the spot: it says which bank or cash account the money went into.
  if (data.kind === 'sreceipt') {
    const b = store.get('accounts', String(data.depositTo || ''));
    if (!b || (b.detail !== 'bank' && b.detail !== 'card' && !(b.type === 'Asset' && !b.detail))) throw new ValidationError('Choose the bank or cash account the money went into.');
  }
  if (data.applied !== undefined) {
    const target = CREDIT_FOR[data.kind];
    if (!target) throw new ValidationError('Only credit notes and vendor credits can be applied to other documents.');
    if (!Array.isArray(data.applied)) throw new ValidationError('Applied credits must be a list.');
    const seen = new Set();
    let used = 0;
    data.applied = data.applied.map(a => {
      const amt = Math.round(Number(a && a.amount) * 100) / 100;
      const doc = a && store.get('docs', String(a.docId));
      if (!doc || doc.kind !== target) throw new ValidationError(`A credit can only be applied to ${target === 'invoice' ? 'invoices' : 'bills'}.`);
      if (!(amt > 0)) throw new ValidationError('Applied amounts must be above zero.');
      if (seen.has(doc.id)) throw new ValidationError('The same document is listed twice.');
      seen.add(doc.id);
      if (data.contactId && doc.contactId && doc.contactId !== data.contactId) throw new ValidationError('A credit can only be applied to the same customer’s or vendor’s documents.');
      const left = Math.round(((Number(doc.total) || 0) - settledOn(store, doc.id, id)) * 100) / 100;
      if (amt > left + 0.004) throw new ValidationError(`That’s more than the ${left.toFixed(2)} still owing on ${doc.number ? '#' + doc.number : 'that document'}.`);
      used += amt;
      return { docId: doc.id, amount: amt };
    });
    const refunds = store.list('entries').filter(e => e.applyTo === id).reduce((t, e) => t + (Number(e.amount) || 0), 0);
    if (used + refunds > (Number(data.total) || 0) + 0.004) throw new ValidationError('More of this credit is used than it’s worth.');
  }
  if (!isDate(data.date)) throw new ValidationError('Document date must be YYYY-MM-DD.');
  if (data.due && !isDate(data.due)) throw new ValidationError('Due date must be YYYY-MM-DD.');
  // In another currency: its amounts are in that currency, and fx is how many Canadian dollars one unit was worth that day.
  if (data.currency && data.currency !== 'CAD') {
    if (!CURRENCY_RE.test(String(data.currency))) throw new ValidationError('That currency code isn’t valid.');
    const fx = Number(data.fx);
    if (!(fx > 0) || fx > 100000) throw new ValidationError('Enter the exchange rate for the document’s currency.');
    data.fx = Math.round(fx * 1e6) / 1e6;
  } else { delete data.currency; delete data.fx; }
  if (!Number.isFinite(Number(data.total))) throw new ValidationError('Document total must be a number.');
  if (!Array.isArray(data.lines)) throw new ValidationError('Document lines must be a list.');
  // Full line-based documents, including carried balances with a summary line, must agree with their totals.
  if (data.lines.length) {
    let sub = 0;
    for (const l of data.lines) {
      if (!isObj(l) || !Number.isFinite(Number(l.qty)) || !Number.isFinite(Number(l.rate))) throw new ValidationError('Each document line needs a valid quantity and rate.');
      const n = computedCents(Number(l.qty) * Number(l.rate));
      if (!Number.isSafeInteger(n)) throw new ValidationError('Document line amount is too large.');
      sub += n;
    }
    const tax = cents(data.tax || 0);
    if (!Number.isSafeInteger(sub) || !Number.isSafeInteger(tax) || cents(data.total) !== sub + tax) throw new ValidationError('Document total must equal its line subtotal plus tax.');
    if (data.sub !== undefined && (!Number.isFinite(Number(data.sub)) || cents(data.sub) !== sub)) throw new ValidationError('Document subtotal doesn’t match its lines.');
    if (data.taxParts !== undefined) {
      if (!Array.isArray(data.taxParts) || data.taxParts.some(p => !isObj(p) || !Number.isFinite(Number(p.amount)) || !Number.isFinite(Number(p.rate)) || Number(p.rate) < 0 || Number(p.rate) > 100) || data.taxParts.reduce((s, p) => s + cents(p.amount), 0) !== tax) throw new ValidationError('Document tax parts don’t match its tax total.');
    }
    data.sub = sub / 100;
  }
  const settled = settledOn(store, id);
  if (!CREDIT_FOR[data.kind] && Number(data.total) < settled - 0.004) throw new ValidationError('The total can’t be less than the amount already settled.');
  const previous = id && store.get('docs', id);
  if (settled > 0 && previous && ((previous.currency || '') !== (data.currency || '') || Number(previous.fx || 1) !== Number(data.fx || 1))) throw new ValidationError('Remove the settlements before changing the document’s currency or exchange rate.', 409);
  checkLineClasses(data.lines, store, id && store.get('docs', id));
  checkDelayedLines(data, store, id);
  // Bill approvals (approvals.js): only on bills. The server decides it on every save (see applyWrite); this checks its shape.
  if (data.approval !== undefined) {
    if (data.kind !== 'bill') delete data.approval;
    else { try { data.approval = APPROVALS.cleanApproval(data.approval); } catch (e) { throw new ValidationError(e.message); } if (data.approval === undefined) delete data.approval; }
  }
  return withTags(data, data, store);
}

function validateEntry(data, store, id) {
  if (!ENTRY_TYPES.includes(data.type)) throw new ValidationError(`Unknown transaction type "${data.type}".`);
  if (!isDate(data.date)) throw new ValidationError('Transaction date must be YYYY-MM-DD.');
  if (!Array.isArray(data.lines) || data.lines.length < 2) throw new ValidationError('A transaction needs at least two lines.');
  const accountIds = new Set(store.list('accounts').map(a => a.id));
  let dr = 0, cr = 0;
  const lines = data.lines.map((l, i) => {
    if (!isObj(l)) throw new ValidationError(`Line ${i + 1} is not valid.`);
    if (!accountIds.has(l.account)) throw new ValidationError(`Line ${i + 1} uses an account that doesn’t exist.`);
    const d = cents(l.debit || 0), c = cents(l.credit || 0);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) throw new ValidationError(`Line ${i + 1} has an invalid amount.`);
    if (d && c) throw new ValidationError(`Line ${i + 1} has both a debit and a credit.`);
    dr += d; cr += c;
    return { ...l, debit: d / 100, credit: c / 100 };
  });
  const prevE = id && store.get('entries', id);
  checkLineClasses(lines, store, prevE);
  if (isObj(data.form) && Array.isArray(data.form.lines)) checkLineClasses(data.form.lines, store, prevE);
  if (dr !== cr) throw new ValidationError(`Debits and credits don’t balance (off by ${((dr - cr) / 100).toFixed(2)}).`);
  if (dr === 0) throw new ValidationError('A transaction needs an amount.');
  if (data.clear !== undefined) {
    if (!isObj(data.clear)) throw new ValidationError('Cleared status must be an object.');
    const used = new Set(lines.map(l => l.account));
    for (const [acct, v] of Object.entries(data.clear)) {
      if (!used.has(acct)) throw new ValidationError('Cleared status refers to an account this transaction doesn’t use.');
      if (v !== 'c' && v !== 'r') throw new ValidationError('Cleared status must be "c" (cleared) or "r" (reconciled).');
    }
  }
  if (data.applyTo) {
    const doc = store.get('docs', data.applyTo);
    const wants = { payment: 'invoice', billpayment: 'bill', refund: 'credit', vrefund: 'vcredit', depapply: 'invoice' }[data.type];
    if (!wants) throw new ValidationError('Only payments, refunds and applied deposits can settle a document.');
    if (doc && wants && doc.kind !== wants) throw new ValidationError(data.type === 'refund' || data.type === 'vrefund' ? 'A refund has to come from a credit.' : `A payment has to go to ${wants === 'invoice' ? 'an invoice' : 'a bill'}.`);
    // Never more than what's left on it (after other payments, refunds and credits).
    if (doc && wants) {
      const left = Math.round(((Number(doc.total) || 0) - settledOn(store, doc.id, null, id)) * 100) / 100;
      if (Number(data.amount) > left + 0.004) throw new ValidationError(`That’s more than the ${left.toFixed(2)} ${doc.kind === 'credit' || doc.kind === 'vcredit' ? 'left on the credit' : 'still owing'}.`);
    }
    if (!doc) throw new ValidationError('The invoice or bill this payment applies to doesn’t exist.');
    if (!Number.isFinite(Number(data.amount)) || !(cents(data.amount) > 0)) throw new ValidationError('Payment amount must be above zero.');
    data.amount = cents(data.amount) / 100;
    if (doc.currency && data.type !== 'depapply' && data.currency !== doc.currency) throw new ValidationError('The payment must use the document’s currency and exchange information.');
    if (data.contactId && doc.contactId && data.contactId !== doc.contactId) throw new ValidationError('The payment must use the document’s customer or vendor.');
    const receive = data.type === 'payment' || data.type === 'vrefund';
    const detail = wants === 'invoice' || wants === 'credit' ? 'ar' : 'ap';
    const control = store.list('accounts').filter(a => a.detail === detail).map(a => a.id);
    const net = lines.filter(l => control.includes(l.account)).reduce((s, l) => s + cents(l.debit) - cents(l.credit), 0);
    const home = computedCents(Number(data.amount) * (doc.currency ? Number(doc.fx) : 1));
    const controlDebit = data.type === 'billpayment' || data.type === 'refund';
    if (!Number.isSafeInteger(home) || net !== (controlDebit ? home : -home)) throw new ValidationError('The payment amount doesn’t match its receivable or payable posting.');
    if (data.type !== 'depapply') {
      const banks = lines.filter(l => { const a = store.get('accounts', l.account); return a && (a.detail === 'bank' || a.detail === 'card'); });
      const bank = data.bank || (banks.length === 1 ? banks[0].account : '');
      if (!bank || !banks.some(l => l.account === bank) || banks.some(l => l.account !== bank)) throw new ValidationError('Choose the payment’s bank or credit card account.');
      const bankRecord = store.get('accounts', bank);
      if (bankRecord.currency) {
        if (bankRecord.currency !== doc.currency || banks.some(l => !l.fx || l.fx.cur !== bankRecord.currency || !Number.isFinite(Number(l.fx.amt)))) throw new ValidationError('A foreign bank payment needs matching foreign-currency amounts.');
        if (banks.reduce((s, l) => s + cents(l.fx.amt) * (cents(l.debit) > 0 ? 1 : -1), 0) !== (receive ? cents(data.amount) : -cents(data.amount))) throw new ValidationError('The payment doesn’t match its foreign bank amount.');
      }
      const bankNet = banks.reduce((s, l) => s + cents(l.debit) - cents(l.credit), 0);
      const cash = doc.currency ? (data.cad !== undefined ? cents(data.cad) : computedCents(Number(data.amount) * Number(data.fx))) : cents(data.amount);
      if (!(cash > 0) || !Number.isSafeInteger(cash) || bankNet !== (receive ? cash : -cash)) throw new ValidationError('The payment amount doesn’t match its bank posting.');
    }
  }
  // A remittance payment is for one agency and one remitting period (payroll-calc.js period keys). The key stays on the
  // payment, so a change of remitting frequency later doesn't unmatch it.
  if (data.type === 'payremit') {
    if (!['cra', 'rq'].includes(data.agency)) throw new ValidationError('A remittance is paid to CRA or Revenu Québec.');
    if (!PAYCALC.periodOfKey(data.period)) throw new ValidationError('The remitting period isn’t valid.');
  }
  // Adjusting entries are marked for the working trial balance; a reversing entry points at the one it undoes.
  const out = { ...data, lines };
  if (DEP.TYPES.includes(data.type)) validateDepositEntry(out, store, id);
  if (data.adjusting !== undefined) out.adjusting = !!data.adjusting;
  if (data.reverseOn !== undefined && data.reverseOn !== '') {
    if (!isDate(data.reverseOn) || data.reverseOn <= data.date) throw new ValidationError('The reversing date has to be after the entry’s date.');
  }
  if (data.reversalOf !== undefined) out.reversalOf = str(data.reversalOf, 60);
  return withTags(out, data, store);
}

/** Check documents and their posting together after a batch, so an edit may replace both atomically.
    Standalone opening documents remain possible, but an existing posting cannot disagree or be duplicated. */
function checkDocumentPostings(store, writes) {
  const ids = new Set();
  for (const w of writes) {
    if (w.collection === 'docs' && w.op === 'set') ids.add(w.id);
    if (w.collection === 'entries' && w.op === 'set' && w.data && w.data.docId) ids.add(w.data.docId);
  }
  if (!ids.size) return;
  const linkedByDoc = new Map(), accounts = store.list('accounts');
  for (const e of store.list('entries')) if (ids.has(e.docId)) {
    if (!linkedByDoc.has(e.docId)) linkedByDoc.set(e.docId, []);
    linkedByDoc.get(e.docId).push(e);
  }
  for (const id of ids) {
    const doc = store.get('docs', id); if (!doc) continue;
    const linked = linkedByDoc.get(id) || [];
    if (!linked.length) continue;
    const kind = doc.kind === 'sreceipt' ? 'salesreceipt' : doc.kind;
    if (linked.length !== 1 || linked[0].type !== kind || linked[0].date !== doc.date) throw new ValidationError('A document must have one matching posting on its date.');
    const control = doc.kind === 'sreceipt' ? [doc.depositTo] : accounts.filter(a => a.detail === (['invoice', 'credit'].includes(doc.kind) ? 'ar' : 'ap')).map(a => a.id);
    const net = linked[0].lines.filter(l => control.includes(l.account)).reduce((s, l) => s + cents(l.debit) - cents(l.credit), 0);
    const expected = computedCents(Number(doc.total) * (doc.currency ? Number(doc.fx) : 1)) * (['invoice', 'sreceipt', 'vcredit'].includes(doc.kind) ? 1 : -1);
    // Migration with a trial balance already includes A/R or A/P. Its carried document has an
    // equal debit and credit to the same control, creating the subledger item without double counting.
    const neutralOpening = doc.carried && net === 0 && linked[0].lines.length === 2 && linked[0].lines.every(l => control.includes(l.account))
      && linked[0].lines.reduce((s, l) => s + cents(l.debit), 0) === Math.abs(expected)
      && linked[0].lines.reduce((s, l) => s + cents(l.credit), 0) === Math.abs(expected);
    if (neutralOpening) continue;
    if (!Number.isSafeInteger(expected) || net !== expected) throw new ValidationError('The document total doesn’t match its ledger posting. Save both together.');
  }
}

/* Deposits on estimates (deposits-calc.js): received (Dr bank, Cr Customer deposits), used on an invoice made for the
   same customer (Dr Customer deposits, Cr A/R) or refunded (Dr Customer deposits, Cr bank). Never more used or refunded
   than was received, and never more received than the estimate's total. */
function validateDepositEntry(out, store, id) {
  const est = store.get('estimates', String(out.estimateId || ''));
  if (!est) throw new ValidationError('The estimate this deposit belongs to doesn’t exist.');
  const amt = cents(out.amount) / 100;
  if (!(amt > 0)) throw new ValidationError('The deposit amount must be above zero.');
  if (out.lines.length !== 2) throw new ValidationError('A deposit has two lines.');
  const di = out.type === 'custdeposit' ? 1 : 0; // the Customer deposits line: credited when received, debited when used or refunded
  const dep = store.get('accounts', String(out.lines[di].account)), other = store.get('accounts', String(out.lines[1 - di].account));
  if (!dep || dep.detail !== 'custdep') throw new ValidationError('A deposit has to go through the Customer deposits account.');
  const want = DEP.lines(out.type, dep.id, other && other.id, amt);
  if (out.lines.some((l, i) => l.account !== want[i].account || cents(l.debit) !== cents(want[i].debit) || cents(l.credit) !== cents(want[i].credit))) throw new ValidationError('A deposit’s lines don’t match its amount.');
  if (out.type === 'depapply') {
    if (!other || other.detail !== 'ar') throw new ValidationError('A deposit used on an invoice comes off Accounts receivable.');
    const inv = store.get('docs', String(out.applyTo || ''));
    if (!inv || inv.kind !== 'invoice') throw new ValidationError('Choose the invoice to use the deposit on.');
    if (inv.contactId !== est.contactId) throw new ValidationError('A deposit can only be used on the same customer’s invoices.');
    if (inv.currency) throw new ValidationError('Deposits are in Canadian dollars, so they can’t be used on an invoice in another currency.');
  } else {
    if (!other || !(other.detail === 'bank' || (other.type === 'Asset' && !other.detail))) throw new ValidationError('Choose the bank account the money went into (or came out of).');
    if (other.currency) throw new ValidationError('Deposits are in Canadian dollars. Choose a Canadian dollar bank account.');
    delete out.applyTo;
    out.bank = other.id;
  }
  if (out.method !== undefined && out.method !== '' && !DEP.METHODS.includes(out.method)) throw new ValidationError('Unknown payment method.');
  const s = DEP.forEstimate(est.id, store.list('entries'), id);
  const received = s.received + (out.type === 'custdeposit' ? amt : 0), used = s.applied + s.refunded + (out.type === 'custdeposit' ? 0 : amt);
  if (out.type === 'custdeposit' && received > (Number(est.total) || 0) + 0.004) throw new ValidationError(`That’s more than the estimate’s total of ${(Number(est.total) || 0).toFixed(2)}.`);
  if (used > received + 0.004) throw new ValidationError(out.type === 'custdeposit' ? `${used.toFixed(2)} of this deposit has already been used or refunded.` : `Only ${Math.max(0, s.received - s.applied - s.refunded).toFixed(2)} of the deposit is available.`);
  Object.assign(out, { amount: amt, estimateId: est.id, contactId: est.contactId, ref: str(out.ref, 60), memo: str(out.memo, 300) });
}

function bankAccount(store, id) {
  const a = store.get('accounts', id);
  if (!a || (a.detail !== 'bank' && a.detail !== 'card')) throw new ValidationError('Choose a bank or credit card account.');
  return a;
}

const BANK_STATUS = ['new', 'added', 'matched', 'excluded'];
function validateBankTxn(data, store, id) {
  bankAccount(store, data.account);
  if (!isDate(data.date)) throw new ValidationError('Bank transaction date must be YYYY-MM-DD.');
  const amt = Number(data.amount);
  if (!Number.isFinite(amt) || amt === 0) throw new ValidationError('Bank transaction amount must be a non-zero number.');
  if (!BANK_STATUS.includes(data.status)) throw new ValidationError('Unknown bank transaction status.');
  if ((data.status === 'added' || data.status === 'matched') && !store.get('entries', data.entryId)) {
    throw new ValidationError('The transaction this bank line points to doesn’t exist.');
  }
  // AI suggestions are only written by the server's AI route; an edit can keep one but not make one up.
  const prev = id ? store.get('bankTxns', id) : null;
  const out = { ...data, amount: cents(amt) / 100, desc: str(data.desc, 300), entryId: data.status === 'added' || data.status === 'matched' ? data.entryId : '' };
  // What a line was added as is remembered for the next line from the same payee; its tags only if they still exist.
  if (isObj(out.cat) && out.cat.tags !== undefined) {
    const known = new Set(((store.getSetting && store.getSetting('company')) || {}).tags?.map(t => t.id) || []);
    const tags = (Array.isArray(out.cat.tags) ? out.cat.tags : []).map(String).filter(id => known.has(id)).slice(0, TAGS.MAX_PER_TXN);
    out.cat = { ...out.cat }; if (tags.length) out.cat.tags = tags; else delete out.cat.tags;
  }
  delete out.ai;
  if (data.ai && prev && prev.ai && JSON.stringify(prev.ai) === JSON.stringify(data.ai)) out.ai = prev.ai;
  return out;
}

function validateRule(data, store) {
  if (!str(data.text).trim()) throw new ValidationError('A rule needs text to look for.');
  if (!['any', 'in', 'out'].includes(data.direction || 'any')) throw new ValidationError('Rule direction must be any, in or out.');
  const a = store.get('accounts', data.account);
  if (!a) throw new ValidationError('Choose the account this rule should use.');
  if (a.detail === 'bank' || a.detail === 'card') throw new ValidationError('A rule can’t categorize into a bank or card account; use a transfer instead.');
  if (data.contactId && !store.get('contacts', data.contactId)) throw new ValidationError('The payee on this rule doesn’t exist.');
  return withTags({ ...data, text: str(data.text, 100).trim(), direction: data.direction || 'any', tax: data.tax === 'gst' ? 'gst' : !!data.tax, contactId: data.contactId || '', cls: str(data.cls, 40) }, data, store);
}

function validateRecon(data, store) {
  bankAccount(store, data.account);
  if (!isDate(data.statementDate)) throw new ValidationError('Statement date must be YYYY-MM-DD.');
  if (!Number.isFinite(Number(data.endingBalance))) throw new ValidationError('Ending balance must be a number.');
  if (!Array.isArray(data.entryIds)) throw new ValidationError('Reconciliation must list its transactions.');
  return data;
}

function validateFiling(data, store) {
  if (!['gst', 'qst', 'pst'].includes(data.tax)) throw new ValidationError('A filing must be for GST/HST, QST or PST.');
  if (!isDate(data.from) || !isDate(data.to) || data.from > data.to) throw new ValidationError('A filing needs a valid period.');
  if (!isDate(data.filedOn)) throw new ValidationError('Enter the date the return was filed.');
  if (!isObj(data.lines)) throw new ValidationError('A filing must include its return lines.');
  if (data.entryId && !store.get('entries', data.entryId)) throw new ValidationError('The payment or refund for this filing doesn’t exist.');
  if (data.qmEntryId) {
    const adj = store.get('entries', data.qmEntryId);
    if (!adj || adj.type !== 'qmadjust' || adj.tax !== data.tax) throw new ValidationError('The sales tax adjustment for this filing doesn’t exist.');
  }
  if (data.method !== undefined && !['quick', 'regular', 'charity', 'npo'].includes(data.method)) throw new ValidationError('Unknown filing method.');
  const clash = store.list('filings').find(f => f.tax === data.tax && f.from <= data.to && data.from <= f.to && f.id !== data.id);
  if (clash) throw new ValidationError(`That period overlaps a return already filed (${clash.from} to ${clash.to}).`, 409);
  return data;
}

const numOr0 = v => (v === '' || v === null || v === undefined ? 0 : Number(v));
const optAmount = (v, label) => {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${label} must be zero or more.`);
  return cents(n) / 100;
};

function validateEmployee(data) {
  const name = str(data.name, 160).trim();
  if (!name) throw new ValidationError('An employee needs a name.');
  if (!PAY_PROVINCES.includes(data.prov)) throw new ValidationError('Choose the province or territory of employment.');
  if (!PAY_FREQ.includes(data.freq)) throw new ValidationError('Choose how often this employee is paid.');
  if (!['salary', 'hourly'].includes(data.payType)) throw new ValidationError('Pay type must be salary or hourly.');
  const out = { ...data, name, active: data.active !== false };
  for (const [k, label] of [['rate', 'Pay rate'], ['hours', 'Hours per pay'], ['rrsp', 'RRSP deduction'], ['union', 'Union dues'],
    ['td1Fed', 'Federal TD1 amount'], ['td1Prov', 'Provincial TD1 amount'], ['td1Qc', 'Quebec TP-1015.3 amount'],
    ['extraTax', 'Additional tax'], ['extraQcTax', 'Additional Quebec tax'], ['dependants', 'Dependants']]) out[k] = optAmount(data[k], label);
  if (data.hireDate && !isDate(data.hireDate)) throw new ValidationError('Hire date must be YYYY-MM-DD.');
  if (data.sin !== undefined && data.sin !== '') {
    const sin = String(data.sin).replace(/\D/g, '');
    if (sin.length !== 9) throw new ValidationError('A social insurance number has 9 digits.');
    out.sin = sin;
  } else out.sin = '';
  // Language for emailed pay stubs ('' = the company's).
  out.lang = ['en', 'fr'].includes(data.lang) ? data.lang : '';
  out.dental = [1, 2, 3, 4, 5].includes(Number(data.dental)) ? Number(data.dental) : 0; // 0 = not chosen yet
  // The address in parts, for the T4 and ROE files (the free-text `address` is kept too).
  if (data.addr !== undefined) out.addr = validateAddrParts(data.addr, name);
  // Direct deposit: the employee's bank account (institution, transit, account).
  out.payMethod = data.payMethod === 'deposit' ? 'deposit' : 'cheque';
  const bk = isObj(data.bank) ? data.bank : {};
  const bank = { inst: String(bk.inst ?? '').replace(/\D/g, ''), transit: String(bk.transit ?? '').replace(/\D/g, ''), account: String(bk.account ?? '').replace(/\D/g, '') };
  if (bank.inst || bank.transit || bank.account || out.payMethod === 'deposit') {
    if (!/^\d{3}$/.test(bank.inst)) throw new ValidationError(`${name}: the bank institution number has 3 digits.`);
    if (!/^\d{5}$/.test(bank.transit)) throw new ValidationError(`${name}: the bank transit (branch) number has 5 digits.`);
    if (!/^\d{5,12}$/.test(bank.account)) throw new ValidationError(`${name}: the bank account number has 5 to 12 digits.`);
    out.bank = bank;
  } else out.bank = null;
  out.pensionType = data.pensionType === 'rpp' ? 'rpp' : 'rrsp';
  const rppNo = String(data.rppNo ?? '').replace(/\D/g, '');
  if (rppNo.length > 7) throw new ValidationError('A pension plan registration number has up to 7 digits.');
  out.rppNo = rppNo;
  if (data.paByYear !== undefined) {
    if (!isObj(data.paByYear)) throw new ValidationError('Pension adjustments must be an object.');
    const pa = {};
    for (const [y, v] of Object.entries(data.paByYear)) {
      if (!/^\d{4}$/.test(y)) throw new ValidationError('Pension adjustments are by year.');
      const a = optAmount(v, 'Pension adjustment ' + y) || 0;
      if (a) pa[y] = a;
    }
    out.paByYear = pa;
  }
  if (data.vacMode !== undefined && data.vacMode !== '' && !['accrue', 'each', 'salary'].includes(data.vacMode)) throw new ValidationError('Choose how vacation pay is paid.');
  out.vacRate = optAmount(data.vacRate, 'Vacation pay rate');
  if (out.vacRate !== '' && out.vacRate > 100) throw new ValidationError('The vacation pay rate is a percentage, 100 or less.');
  out.vacOpening = optAmount(data.vacOpening, 'Vacation pay owed');
  // Overtime for a salaried employee (hourly employees always get it), and their workers' compensation rate group.
  if (data.otEligible !== undefined) out.otEligible = !!data.otEligible;
  if (data.wsibGroup !== undefined) out.wsibGroup = str(data.wsibGroup, 40);
  if (data.occupation !== undefined) out.occupation = str(data.occupation, 100).trim();
  if (data.termDate !== undefined && data.termDate !== '' && !isDate(data.termDate)) throw new ValidationError('The last day worked must be YYYY-MM-DD.');
  if (data.roes !== undefined) {
    if (!Array.isArray(data.roes) || data.roes.length > 50 || data.roes.some(r => !isObj(r) || JSON.stringify(r).length > 30000)) throw new ValidationError('The records of employment aren’t valid.');
    // The figures are numbers, the pay period type one letter.
    const n = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
    out.roes = data.roes.map(r => {
      const c = isObj(r.calc) ? r.calc : null;
      // Block 16 can be a specific code (E03, K12…) and block 17C needs Service Canada's code for the other money.
      if (r.reasonCode !== undefined && r.reasonCode !== '' && !/^[A-Z]\d{2}$/.test(String(r.reasonCode))) throw new ValidationError('The ROE reason code isn’t valid.');
      if (r.otherCd !== undefined && r.otherCd !== '' && !/^[A-Z]\d{2}$/.test(String(r.otherCd))) throw new ValidationError('The ROE other money code isn’t valid.');
      return { ...r, calc: c && { type: ['W', 'B', 'S', 'M'].includes(c.type) ? c.type : 'B', count: n(c.count), hours: n(c.hours), total: n(c.total), vacation: n(c.vacation), outside: n(c.outside),
        due: isDate(c.due) ? c.due : '', periods: (Array.isArray(c.periods) ? c.periods : []).slice(0, 60).filter(isObj).map(p => ({ n: n(p.n), from: isDate(p.from) ? p.from : '', to: isDate(p.to) ? p.to : '', amount: n(p.amount) })) } };
    });
  }
  if (data.openingYtd !== undefined) {
    if (!isObj(data.openingYtd)) throw new ValidationError('Opening year-to-date amounts must be an object.');
    const o = { year: parseInt(data.openingYtd.year, 10) || 0 };
    for (const [k, v] of Object.entries(data.openingYtd)) {
      if (k === 'year') continue;
      if (k === 'prov') { if (PAY_PROVINCES.includes(v)) o.prov = v; continue; }
      o[k] = optAmount(v, 'Opening year-to-date ' + k) || 0;
    }
    out.openingYtd = o;
  }
  return out;
}

const BENEFIT_KEYS = ['life', 'auto', 'nearcash', 'board', 'other']; // see BENEFIT_KINDS in payroll-calc.js
const PAY_KEYS = ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip', 'fedTax', 'provTax', 'qcTax'];
const ER_KEYS = ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip', 'hsf'];
function validatePayrun(data, store, id) {
  if (!isDate(data.payDate)) throw new ValidationError('Pay date must be YYYY-MM-DD.');
  if (data.from && !isDate(data.from) || data.to && !isDate(data.to) || (data.from && data.to && data.from > data.to)) throw new ValidationError('The pay period dates aren’t valid.');
  bankAccount(store, data.bank);
  if (!Array.isArray(data.lines) || !data.lines.length) throw new ValidationError('A pay run needs at least one employee.');
  const seen = new Set();
  let net = 0;
  const lines = data.lines.map((l, i) => {
    if (!isObj(l)) throw new ValidationError(`Pay run line ${i + 1} is not valid.`);
    const emp = store.get('employees', l.employeeId);
    if (!emp) throw new ValidationError(`Pay run line ${i + 1} is for an employee who doesn’t exist.`);
    if (seen.has(l.employeeId)) throw new ValidationError(`${emp.name} is in this pay run twice.`);
    seen.add(l.employeeId);
    const amt = (v, what) => { const n = numOr0(v); if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${emp.name}: ${what} must be zero or more.`); return cents(n); };
    const gross = amt(l.gross, 'gross pay');
    const ded = {}, er = {};
    let d = amt(l.rrsp, 'RRSP') + amt(l.union, 'union dues');
    for (const k of PAY_KEYS) { ded[k] = amt(l.ded && l.ded[k], k) / 100; d += cents(ded[k]); }
    for (const k of ER_KEYS) er[k] = amt(l.er && l.er[k], 'employer ' + k) / 100;
    const n = gross - d;
    if (n < 0) throw new ValidationError(`${emp.name}: deductions are more than gross pay.`);
    if (cents(l.net) !== n) throw new ValidationError(`${emp.name}: net pay doesn’t equal gross pay minus deductions.`);
    net += n;
    // Earnings broken down (regular, holiday, other, bonus, vacation pay): they have to add up to gross pay.
    const parts = {};
    for (const k of ['regular', 'holiday', 'overtime', 'other', 'bonus', 'allowance', 'vacPay', 'vacAccrued', 'holHours', 'otHours', 'hours', 'vacRate']) {
      if (l[k] === undefined || l[k] === '') continue;
      parts[k] = amt(l[k], { regular: 'regular pay', holiday: 'holiday pay', overtime: 'overtime pay', other: 'other pay', bonus: 'bonus', allowance: 'taxable allowance', vacPay: 'vacation pay', vacAccrued: 'vacation pay set aside', holHours: 'holiday hours', otHours: 'overtime hours', hours: 'hours', vacRate: 'vacation pay rate' }[k]) / 100;
    }
    if (parts.regular !== undefined && ['holiday', 'overtime', 'other', 'bonus', 'allowance', 'vacPay'].some(k => parts[k] !== undefined)) {
      const sum = ['regular', 'holiday', 'overtime', 'other', 'bonus', 'allowance', 'vacPay'].reduce((t, k) => t + cents(parts[k] || 0), 0);
      if (sum !== gross) throw new ValidationError(`${emp.name}: regular, holiday, overtime, other, bonus, allowance and vacation pay don’t add up to gross pay.`);
    }
    if (parts.otHours !== undefined && parts.hours !== undefined && parts.otHours > parts.hours) throw new ValidationError(`${emp.name}: overtime hours are more than the hours worked.`);
    // Taxable benefits not paid in cash: known kinds only, amounts zero or more.
    let benefits;
    if (l.benefits !== undefined) {
      if (!isObj(l.benefits)) throw new ValidationError(`${emp.name}: the taxable benefits aren’t valid.`);
      benefits = {};
      for (const [k, v] of Object.entries(l.benefits)) {
        if (!BENEFIT_KEYS.includes(k)) throw new ValidationError(`${emp.name}: unknown taxable benefit “${str(k, 30)}”.`);
        const c = amt(v, 'taxable benefits');
        if (c) benefits[k] = c / 100;
      }
    }
    const benCents = Object.values(benefits || {}).reduce((t, v) => t + cents(v), 0);
    for (const k of ['pensionable', 'insurable']) {
      if (l[k] === undefined) continue;
      const c = amt(l[k], k === 'pensionable' ? 'pensionable earnings' : 'insurable earnings');
      if (c > gross + benCents) throw new ValidationError(`${emp.name}: ${k === 'pensionable' ? 'pensionable' : 'insurable'} earnings are more than pay plus taxable benefits.`);
    }
    if (parts.vacRate !== undefined && parts.vacRate > 100) throw new ValidationError(`${emp.name}: the vacation pay rate is a percentage, 100 or less.`);
    const extra = { ...parts, ...(benefits ? { benefits } : {}) };
    if (l.vacMode !== undefined) { if (!['accrue', 'each'].includes(l.vacMode)) throw new ValidationError(`${emp.name}: unknown vacation pay method.`); extra.vacMode = l.vacMode; }
    if (extra.vacAccrued && l.vacMode !== 'accrue') throw new ValidationError(`${emp.name}: vacation pay is only set aside for employees whose vacation pay is set aside.`);
    if (l.holidays !== undefined) {
      if (!Array.isArray(l.holidays) || l.holidays.length > 12) throw new ValidationError(`${emp.name}: the holidays aren’t valid.`);
      extra.holidays = l.holidays.map(h => ({ date: isDate(h && h.date) ? h.date : '', name: str(h && h.name, 80) })).filter(h => h.date);
    }
    if (l.final !== undefined) extra.final = !!l.final;
    // When the pay stub was emailed (recorded by the mail route): kept as it was, never more than the last 10.
    if (l.sent !== undefined) extra.sent = (Array.isArray(l.sent) ? l.sent : []).filter(isObj).slice(-10).map(s => ({ at: Number(s.at) || 0, to: str(s.to, 200), by: str(s.by, 120) }));
    if (l.bonusVac !== undefined) extra.bonusVac = !!l.bonusVac;
    // Hours in each work week of the pay period (for overtime): up to 6 weeks, each 0 to 168 hours.
    if (l.weekHours !== undefined) {
      if (!Array.isArray(l.weekHours) || l.weekHours.length > 6 || l.weekHours.some(h => !Number.isFinite(Number(h)) || Number(h) < 0 || Number(h) > 168)) throw new ValidationError(`${emp.name}: the hours by week aren’t valid.`);
      extra.weekHours = l.weekHours.map(h => cents(Number(h)) / 100);
    }
    // Workers' compensation premium: insurable earnings no more than pay plus benefits, premium = earnings × rate per $100.
    if (l.wsib !== undefined && l.wsib !== null) {
      const w = l.wsib;
      if (!isObj(w)) throw new ValidationError(`${emp.name}: the workers’ compensation premium isn’t valid.`);
      const rate = Number(w.rate), ins = amt(w.insurable, 'workers’ compensation earnings'), prem = amt(w.premium, 'workers’ compensation premium');
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new ValidationError(`${emp.name}: the workers’ compensation rate isn’t valid.`);
      if (ins > gross + benCents) throw new ValidationError(`${emp.name}: workers’ compensation earnings are more than pay plus taxable benefits.`);
      if (Math.abs(prem - Math.round(ins * rate / 100)) > 1) throw new ValidationError(`${emp.name}: the workers’ compensation premium doesn’t match the earnings and rate.`);
      extra.wsib = { group: str(w.group, 40), rate, insurable: ins / 100, premium: prem / 100 };
    }
    return { ...l, ...extra, gross: gross / 100, rrsp: cents(numOr0(l.rrsp)) / 100, union: cents(numOr0(l.union)) / 100, ded, er, net: n / 100 };
  });
  if (data.entryId && !store.get('entries', data.entryId)) throw new ValidationError('The journal entry for this pay run doesn’t exist.');
  const out = { ...data, lines, totalNet: net / 100 };
  // Voiding: the pay run stays as it was, marked void, with a reversing entry that undoes its journal entry.
  const prev = id && store.get('payruns', id);
  if (prev && prev.void) {
    if (!isObj(data.void)) throw new ValidationError('This pay run is void. A void pay run can’t be brought back: post a new one.', 409);
    if (JSON.stringify(prev.lines) !== JSON.stringify(lines) || prev.payDate !== data.payDate || prev.entryId !== data.entryId || prev.void.date !== data.void.date || prev.void.entryId !== data.void.entryId) throw new ValidationError('A void pay run can’t be changed.', 409);
  }
  if (data.void !== undefined && data.void !== null && data.void !== false) {
    const v = data.void;
    if (!isObj(v) || !isDate(v.date)) throw new ValidationError('Choose the date of the reversing entry.');
    if (v.date < data.payDate) throw new ValidationError('The reversing entry can’t be dated before the pay date.');
    if (!prev) throw new ValidationError('Only a posted pay run can be voided.');
    if (!prev.void && (JSON.stringify(prev.lines) !== JSON.stringify(lines) || prev.payDate !== data.payDate)) throw new ValidationError('A pay run can’t be changed while it’s voided. Void it as it is.');
    const orig = data.entryId && store.get('entries', data.entryId);
    let entryId = '';
    if (orig) {
      const rev = store.get('entries', String(v.entryId || ''));
      if (!rev || rev.reversalOf !== orig.id || rev.date !== v.date) throw new ValidationError('A void pay run needs a reversing entry for its journal entry, dated the day it’s voided.');
      // The reversal has to undo the entry exactly: the same accounts, debits and credits swapped.
      const key = (ls, swap) => ls.map(l => `${l.account}|${cents(swap ? l.credit : l.debit)}|${cents(swap ? l.debit : l.credit)}`).sort().join(';');
      if (key(rev.lines, true) !== key(orig.lines, false)) throw new ValidationError('The reversing entry doesn’t undo the pay run’s journal entry.');
      entryId = rev.id;
    }
    out.void = { date: v.date, reason: str(v.reason, 200).trim(), entryId, at: Number(v.at) || Date.now() };
  } else delete out.void;
  return out;
}
/** A pay run can be deleted only while nothing depends on it: no later pay run for the same employees (their
    year-to-date amounts include it) and its bank payment not reconciled. Otherwise it's voided. */
function checkPayrunDelete(id, store) {
  const run = store.get('payruns', id);
  if (!run) return;
  // Pay runs for example employees go with the example data (Settings → Clear example data).
  if ((run.lines || []).length && run.lines.every(l => (store.get('employees', l.employeeId) || {}).example)) return;
  if (run.void) throw new ValidationError('A void pay run stays in the books with its reversing entry, so it can’t be deleted.', 409);
  const ids = new Set((run.lines || []).map(l => l.employeeId));
  const later = store.list('payruns').some(r => r.id !== id && !r.void && (r.payDate > run.payDate || (r.payDate === run.payDate && (r.created || 0) > (run.created || 0))) && (r.lines || []).some(l => ids.has(l.employeeId)));
  if (later) throw new ValidationError('Only the latest pay run can be deleted, because later pay runs used its year-to-date amounts. Void it instead.', 409);
  const e = run.entryId && store.get('entries', run.entryId);
  if (e && Object.values(e.clear || {}).includes('r')) throw new ValidationError('This pay run’s bank payment is reconciled, so it can’t be deleted. Void it instead.', 409);
}

/* Receipts: the file and what AI read are set by the server (upload and reading routes).
   An edit can change only the status, the note and which transaction or bill it's attached to. */
const RECEIPT_STATUS = ['inbox', 'done', 'discarded'];
/** What AI read from a receipt, cleaned: only known shapes, lengths and real ids. Used for AI answers and restores. */
function sanitizeDraft(x, { accounts, vendors } = {}) {
  x = isObj(x) ? x : {};
  const amt = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
  const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const ok = (set, v) => (v && (!set || set.has(String(v))) ? String(v) : '');
  return {
    paid: x.paid !== false,
    vendorName: str(x.vendorName, 120), vendorId: ok(vendors, x.vendorId),
    date: date(x.date), dueDate: date(x.dueDate), number: str(x.number, 40),
    currency: /^[A-Z]{3}$/.test(String(x.currency || '')) ? String(x.currency) : '',
    lines: (Array.isArray(x.lines) ? x.lines : []).slice(0, 30).filter(isObj).map(l => ({ description: str(l.description, 200), amount: amt(l.amount), account: ok(accounts, l.account), taxable: !!l.taxable })).filter(l => l.amount),
    taxes: (Array.isArray(x.taxes) ? x.taxes : []).slice(0, 6).filter(isObj).map(t => ({ name: str(t.name, 20), amount: amt(t.amount) })).filter(t => t.amount),
    total: amt(x.total),
    confidence: ['high', 'medium', 'low'].includes(x.confidence) ? x.confidence : 'low',
    reason: str(x.reason, 300),
  };
}
const RECEIPT_SERVER = ['fileId', 'fileName', 'mediaType', 'size', 'uploadedBy', 'uploadedByName', 'uploadedAt', 'readStatus', 'readError', 'draft', 'readAt', 'wasAttached', 'source', 'emailFrom', 'emailSubject'];
const RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
function validateReceipt(data, store, id) {
  const prev = store.get('receipts', id);
  if (!prev && !(data.fileId && store.hasFile(String(data.fileId)))) throw new ValidationError('Add receipts from the Receipts screen.');
  // A restored receipt can't share a photo with another one (deleting either would remove it).
  if (!prev && store.list('receipts').some(r => r.fileId === String(data.fileId))) throw new ValidationError('That photo already belongs to another receipt.');
  const base = {};
  if (prev) { for (const k of RECEIPT_SERVER) if (prev[k] !== undefined) base[k] = prev[k]; }
  else {
    Object.assign(base, { fileId: String(data.fileId), fileName: str(data.fileName, 120), mediaType: RECEIPT_TYPES.includes(data.mediaType) ? data.mediaType : 'image/jpeg',
      size: Number(data.size) || 0, uploadedBy: str(data.uploadedBy, 200), uploadedByName: str(data.uploadedByName, 200), uploadedAt: Number(data.uploadedAt) || Date.now(),
      readStatus: data.draft ? 'read' : 'off', readError: '', wasAttached: !!data.wasAttached });
    // Emailed in (kept through a backup and restore): who sent it and the subject.
    if (data.source === 'email') Object.assign(base, { source: 'email', emailFrom: str(data.emailFrom, 200), emailSubject: str(data.emailSubject, 200) });
    if (data.draft) base.draft = sanitizeDraft(data.draft);
  }
  const status = RECEIPT_STATUS.includes(data.status) ? data.status : 'inbox';
  const entryId = data.entryId ? String(data.entryId) : '', docId = data.docId ? String(data.docId) : '';
  if (entryId && !store.get('entries', entryId)) throw new ValidationError('The transaction for this receipt doesn’t exist.');
  if (docId && !store.get('docs', docId)) throw new ValidationError('The bill for this receipt doesn’t exist.');
  // Once a bookkeeper has attached it, a receipt stays proof: the client who sent it can't remove it any more.
  if (entryId || docId) base.wasAttached = true;
  return { ...base, status, note: str(data.note, 500), entryId, docId };
}

/* Products and services: saved once, picked on invoices, sales receipts, estimates and bills. */
const ITEM_TYPES = ['service', 'product', 'inventory'];
const TAX_CODE_LIST = ['std', 'gst', 'zero', 'export', 'exempt', 'none'];
function validateItem(data, store, id) {
  const name = str(data.name, 120).trim();
  if (!name) throw new ValidationError('Give the product or service a name.');
  if (store.list('items').some(i => i.id !== id && String(i.name || '').trim().toLowerCase() === name.toLowerCase())) throw new ValidationError('There’s already a product or service with that name.', 409);
  const money = (v, label) => {
    if (v === undefined || v === null || v === '') return '';
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new ValidationError(`${label} must be a number.`);
    return Math.round(n * 10000) / 10000;
  };
  const acct = (v, types, label) => {
    if (!v) return '';
    const a = store.get('accounts', String(v));
    if (!a || !types.includes(a.type)) throw new ValidationError(label);
    return a.id;
  };
  const out = {
    name, type: ITEM_TYPES.includes(data.type) ? data.type : 'service', sku: str(data.sku, 60).trim(),
    desc: str(data.desc, 500), price: money(data.price, 'The sales price'), cost: money(data.cost, 'The purchase cost'),
    incomeAccount: acct(data.incomeAccount, ['Income'], 'Choose an income account for the sales side.'),
    expenseAccount: acct(data.expenseAccount, ['Expense', 'Cost of Goods Sold', 'Asset'], 'Choose an expense account for the purchase side.'),
    taxCode: TAX_CODE_LIST.includes(data.taxCode) ? data.taxCode : 'std',
    sold: data.sold !== false, bought: !!data.bought, active: data.active !== false,
  };
  // Inventory: counted in stock. Bought into an inventory asset account; each sale moves its cost to cost of goods sold.
  if (out.type === 'inventory') {
    const asset = store.get('accounts', String(data.assetAccount || '')), cogs = store.get('accounts', String(data.cogsAccount || ''));
    if (!asset || asset.type !== 'Asset' || ['bank', 'card', 'ar'].includes(asset.detail)) throw new ValidationError('Choose the inventory asset account.');
    if (!cogs || !['Cost of Goods Sold', 'Expense'].includes(cogs.type)) throw new ValidationError('Choose the cost of goods sold account.');
    Object.assign(out, { bought: true, sold: true, assetAccount: asset.id, cogsAccount: cogs.id, expenseAccount: asset.id,
      qtyStart: Math.round((Number(data.qtyStart) || 0) * 10000) / 10000, valueStart: Math.max(0, Math.round((Number(data.valueStart) || 0) * 100) / 100),
      startDate: isDate(data.startDate) ? data.startDate : '', reorder: data.reorder === '' || data.reorder == null ? '' : Math.max(0, Number(data.reorder) || 0) });
    if (out.qtyStart < 0) throw new ValidationError('The starting quantity can’t be below zero.');
    if ((out.qtyStart || out.valueStart) && !out.startDate) throw new ValidationError('Enter the date of the starting quantity.');
  }
  if (!out.sold && !out.bought) throw new ValidationError('Tick whether you sell it, buy it, or both.');
  if (out.sold && !out.incomeAccount) throw new ValidationError('Choose an income account for the sales side.');
  if (out.bought && !out.expenseAccount) throw new ValidationError('Choose an expense account for the purchase side.');
  if (data.example) out.example = true;
  return out;
}

/* Budgets: an amount per income or expense account for each month of one fiscal year. */
function validateBudget(data, store) {
  const name = str(data.name, 80).trim();
  if (!name) throw new ValidationError('Give the budget a name.');
  if (!isDate(data.start) || data.start.slice(8) !== '01') throw new ValidationError('A budget starts on the first day of a fiscal year.');
  if (!isObj(data.amounts)) throw new ValidationError('Budget amounts must be an object.');
  const amounts = {};
  for (const [acct, months] of Object.entries(data.amounts).slice(0, 1000)) {
    const a = store.get('accounts', acct);
    if (!a || !['Income', 'Expense', 'Cost of Goods Sold'].includes(a.type)) throw new ValidationError('Budgets are for income and expense accounts.');
    if (!Array.isArray(months) || months.length !== 12) throw new ValidationError('Each account needs 12 months.');
    const m = months.map(v => (v === '' || v === null ? 0 : Math.round(Number(v) * 100) / 100));
    if (m.some(v => !Number.isFinite(v) || Math.abs(v) > 1e10)) throw new ValidationError('Budget amounts must be numbers.');
    if (m.some(v => v)) amounts[acct] = m;
  }
  return { name, start: data.start, amounts, ...(data.created ? { created: Number(data.created) || 0 } : {}) };
}
/* Mileage: one business trip. A claim (entryId) records it as an expense, once. */
function validateTrip(data, store) {
  if (!isDate(data.date)) throw new ValidationError('Trip date must be YYYY-MM-DD.');
  const km = Math.round(Number(data.km) * 10) / 10;
  if (!(km > 0) || km > 5000) throw new ValidationError('Enter the kilometres driven (up to 5,000 for one trip).');
  const purpose = str(data.purpose, 200).trim();
  if (!purpose) throw new ValidationError('Enter the business purpose of the trip.');
  if (data.contactId && !store.get('contacts', String(data.contactId))) throw new ValidationError('That customer or vendor doesn’t exist.');
  return { date: data.date, km, purpose, from: str(data.from, 120).trim(), to: str(data.to, 120).trim(), vehicle: str(data.vehicle, 60).trim(), contactId: data.contactId ? String(data.contactId) : '', roundTrip: !!data.roundTrip, entryId: data.entryId ? str(data.entryId, 120) : '', ...(data.created ? { created: Number(data.created) || 0 } : {}) };
}
/* Purchase orders: not posted to the ledger. "Make bill" turns one into a bill and links them. */
const PO_STATUS = ['open', 'closed'];
function validatePo(data, store) {
  if (!isDate(data.date)) throw new ValidationError('Purchase order date must be YYYY-MM-DD.');
  if (data.expected && !isDate(data.expected)) throw new ValidationError('The expected date must be YYYY-MM-DD.');
  const c = store.get('contacts', String(data.contactId || ''));
  if (!c) throw new ValidationError('Choose the vendor for this purchase order.');
  const lines = docLines(data.lines);
  if (!lines.length) throw new ValidationError('Add at least one line.');
  for (const l of lines) if (l.account && !store.get('accounts', l.account)) throw new ValidationError('An account on this purchase order doesn’t exist.');
  return { ...data, number: str(data.number, 40), memo: str(data.memo, 2000), shipTo: str(data.shipTo, 300), lines, status: PO_STATUS.includes(data.status) ? data.status : 'open', billId: data.billId ? String(data.billId) : '' };
}

/* Projects: work for one customer. Transactions and time point at a project (proj). */
function validateProject(data, store) {
  const name = str(data.name, 120).trim();
  if (!name) throw new ValidationError('Give the project a name.');
  if (data.contactId && !store.get('contacts', String(data.contactId))) throw new ValidationError('That customer doesn’t exist.');
  const budget = data.budget === '' || data.budget === undefined || data.budget === null ? '' : Math.round(Number(data.budget) * 100) / 100;
  if (budget !== '' && !Number.isFinite(budget)) throw new ValidationError('The project budget must be a number.');
  return { name, contactId: data.contactId ? String(data.contactId) : '', status: ['active', 'done'].includes(data.status) ? data.status : 'active', start: isDate(data.start) ? data.start : '', end: isDate(data.end) ? data.end : '', budget, notes: str(data.notes, 2000), ...(data.created ? { created: Number(data.created) || 0 } : {}) };
}
/* Time: hours someone worked, for a customer and project, billable or not. invoiceId once billed. */
function validateTime(data, store) {
  if (!isDate(data.date)) throw new ValidationError('Date must be YYYY-MM-DD.');
  const hours = Math.round(Number(data.hours) * 100) / 100;
  if (!(hours > 0) || hours > 24) throw new ValidationError('Enter the hours worked (up to 24 in a day).');
  const who = str(data.who, 80).trim();
  if (!who) throw new ValidationError('Enter who did the work.');
  if (data.contactId && !store.get('contacts', String(data.contactId))) throw new ValidationError('That customer doesn’t exist.');
  if (data.projectId && !store.get('projects', String(data.projectId))) throw new ValidationError('That project doesn’t exist.');
  if (data.itemId && !store.get('items', String(data.itemId))) throw new ValidationError('That service doesn’t exist.');
  const rate = data.rate === '' || data.rate === undefined || data.rate === null ? 0 : Math.round(Number(data.rate) * 100) / 100;
  if (!Number.isFinite(rate) || rate < 0) throw new ValidationError('The rate must be a number.');
  const cost = data.cost === '' || data.cost === undefined || data.cost === null ? 0 : Math.round(Number(data.cost) * 100) / 100;
  if (!Number.isFinite(cost) || cost < 0) throw new ValidationError('The cost rate must be a number.');
  return { date: data.date, hours, who, desc: str(data.desc, 500), contactId: data.contactId ? String(data.contactId) : '', projectId: data.projectId ? String(data.projectId) : '', itemId: data.itemId ? String(data.itemId) : '', rate, cost, billable: !!data.billable, invoiceId: data.invoiceId ? str(data.invoiceId, 120) : '', ...(data.created ? { created: Number(data.created) || 0 } : {}) };
}
/* Fixed assets: the register for book amortization and the CCA (capital cost allowance) schedule. */
function validateAsset(data, store) {
  const name = str(data.name, 120).trim();
  if (!name) throw new ValidationError('Give the asset a name.');
  if (!isDate(data.acquired)) throw new ValidationError('Enter the date the asset was bought (available for use).');
  const cost = Math.round(Number(data.cost) * 100) / 100;
  if (!(cost > 0) || cost > 1e10) throw new ValidationError('Enter what the asset cost.');
  const acct = (v, types, msg) => { const a = store.get('accounts', String(v || '')); if (!a || !types.includes(a.type)) throw new ValidationError(msg); return a.id; };
  const out = {
    name, acquired: data.acquired, cost, ccaClass: str(data.ccaClass, 10).trim(), ccaRate: Math.max(0, Math.min(100, Number(data.ccaRate) || 0)),
    firstYear: ['half', 'full', 'aiip'].includes(data.firstYear) ? data.firstYear : 'half',
    method: ['straight', 'declining', 'none'].includes(data.method) ? data.method : 'straight',
    life: Math.max(0, Math.min(100, Number(data.life) || 0)), rate: Math.max(0, Math.min(100, Number(data.rate) || 0)), salvage: Math.max(0, Math.round((Number(data.salvage) || 0) * 100) / 100),
    assetAccount: acct(data.assetAccount, ['Asset'], 'Choose the asset account the cost is in.'),
    accumAccount: data.method === 'none' ? str(data.accumAccount, 40) : acct(data.accumAccount, ['Asset'], 'Choose the accumulated amortization account.'),
    expenseAccount: data.method === 'none' ? str(data.expenseAccount, 40) : acct(data.expenseAccount, ['Expense'], 'Choose the amortization expense account.'),
    opening: Math.max(0, Math.round((Number(data.opening) || 0) * 100) / 100), openingFy: isDate(data.openingFy) ? data.openingFy : '',
    disposalEntry: data.disposalEntry ? str(data.disposalEntry, 120) : '',
    disposed: isDate(data.disposed) ? data.disposed : '', proceeds: Math.max(0, Math.round((Number(data.proceeds) || 0) * 100) / 100),
    notes: str(data.notes, 1000), posted: isObj(data.posted) ? Object.fromEntries(Object.entries(data.posted).filter(([y, v]) => /^\d{4}$/.test(y)).slice(0, 100).map(([y, v]) => [y, str(v, 120)])) : {},
    ...(data.created ? { created: Number(data.created) || 0 } : {}),
  };
  if (out.method === 'straight' && !(out.life > 0)) throw new ValidationError('Enter the useful life in years.');
  if (out.method === 'declining' && !(out.rate > 0)) throw new ValidationError('Enter the amortization rate.');
  if (out.disposed && out.disposed < out.acquired) throw new ValidationError('The disposal date is before the date it was bought.');
  return out;
}

/* Scrap yard: a vehicle bought for parts and scrap (the Scrap yard add-on, scrapyard.js).
   Its purchase is posted as an expense entry (buyEntry): the cost into the vehicles-in-yard inventory account, any
   GST/HST the seller charged to the tax account, paid from a bank, card or cash account. When the car is finished
   (crushed, or sold whole), doneEntry moves its cost to cost of goods sold. Parts pulled from it are listed on it. */
const VEH_STATUS = ['yard', 'parting', 'done', 'sold'];
const PART_STATUS = ['stock', 'sold', 'scrapped'];
const ENV_CHECKS = ['fluids', 'battery', 'refrigerant', 'mercury', 'tires', 'airbags'];
function validateVehicle(data, store, id) {
  const stock = str(data.stock, 30).trim();
  if (!stock) throw new ValidationError('Give the vehicle a stock number.');
  if (store.list('vehicles').some(v => v.id !== id && String(v.stock).toLowerCase() === stock.toLowerCase())) throw new ValidationError(`Stock number ${stock} is already used.`, 409);
  const vin = str(data.vin, 20).toUpperCase().replace(/[\s-]/g, '');
  if (vin && !/^[A-Z0-9]{5,17}$/.test(vin)) throw new ValidationError('A VIN has only letters and numbers, up to 17 of them.');
  if (!isDate(data.bought)) throw new ValidationError('Enter the date the vehicle was bought.');
  const amt = (v, label) => { const n = Math.round((Number(v) || 0) * 100) / 100; if (!Number.isFinite(n) || n < 0 || n > 1e8) throw new ValidationError(`${label} must be a number of zero or more.`); return n; };
  const price = amt(data.price, 'The price paid'), tax = amt(data.tax, 'The GST/HST charged');
  const acct = (v, ok, msg) => { const a = store.get('accounts', String(v || '')); if (!a || !ok(a)) throw new ValidationError(msg); return a.id; };
  const invAccount = acct(data.invAccount, a => a.type === 'Asset' && !['bank', 'ar'].includes(a.detail) || a.type === 'Cost of Goods Sold' || a.type === 'Expense', 'Choose the account the vehicle’s cost goes to.');
  const payAccount = price || tax ? acct(data.payAccount, a => a.detail === 'bank' || a.detail === 'card' || (a.type === 'Asset' && !a.detail), 'Choose how the seller was paid (bank, cash or credit card).') : str(data.payAccount, 40);
  const sellerKind = data.sellerKind === 'business' ? 'business' : 'public';
  const s = isObj(data.seller) ? data.seller : {};
  const seller = { name: str(s.name, 120).trim(), address: str(s.address, 300).trim(), phone: str(s.phone, 40).trim(), idType: str(s.idType, 60).trim(), idNumber: str(s.idNumber, 40).trim(), gstNo: str(s.gstNo, 30).trim() };
  if (sellerKind === 'business') {
    if (!data.contactId || !store.get('contacts', String(data.contactId))) throw new ValidationError('Choose the business the vehicle was bought from.');
  } else if (!seller.name) throw new ValidationError('Enter the seller’s name.');
  if (tax && sellerKind === 'public' && !seller.gstNo) throw new ValidationError('GST/HST can only be claimed back when the seller charged it: enter their GST/HST number, or leave the tax at zero.');
  const status = VEH_STATUS.includes(data.status) ? data.status : 'yard';
  const doneDate = isDate(data.doneDate) ? data.doneDate : '';
  if ((status === 'done' || status === 'sold') && !doneDate) throw new ValidationError('Enter the date the vehicle was finished.');
  if (doneDate && doneDate < data.bought) throw new ValidationError('The date it was finished is before the date it was bought.');
  const env = isObj(data.env) ? data.env : {};
  const year = data.year === '' || data.year == null ? '' : Math.floor(Number(data.year));
  if (year !== '' && !(year >= 1900 && year <= 2100)) throw new ValidationError('Enter the model year (for example 2012).');
  const seen = new Set();
  const parts = (Array.isArray(data.parts) ? data.parts : []).filter(isObj).slice(0, 300).map(p => {
    const pid = str(p.id, 40);
    if (!pid || seen.has(pid)) throw new ValidationError('Each part needs its own id.');
    seen.add(pid);
    const name = str(p.name, 120).trim();
    if (!name) throw new ValidationError('Give each part a name.');
    return { id: pid, name, location: str(p.location, 60).trim(), price: amt(p.price, 'A part’s asking price'), status: PART_STATUS.includes(p.status) ? p.status : 'stock', docId: p.docId ? str(p.docId, 120) : '', added: isDate(p.added) ? p.added : '' };
  });
  return {
    stock, vin, year, make: str(data.make, 40).trim(), model: str(data.model, 60).trim(), colour: str(data.colour, 30).trim(), odometer: str(data.odometer, 20).trim(),
    plate: str(data.plate, 20).trim().toUpperCase(), ownership: str(data.ownership, 40).trim(),
    bought: data.bought, price, tax, invAccount, payAccount, sellerKind, contactId: sellerKind === 'business' ? String(data.contactId) : '', seller,
    payMethod: ['cash', 'cheque', 'etransfer', 'card', 'account', 'other'].includes(data.payMethod) ? data.payMethod : 'cash', ref: str(data.ref, 40).trim(),
    status, doneDate: status === 'done' || status === 'sold' ? doneDate : '', cogsAccount: data.cogsAccount ? str(data.cogsAccount, 40) : '',
    buyEntry: data.buyEntry ? str(data.buyEntry, 120) : '', doneEntry: data.doneEntry ? str(data.doneEntry, 120) : '',
    env: { ...Object.fromEntries(ENV_CHECKS.map(k => [k, !!env[k]])), date: isDate(env.date) ? env.date : '', by: str(env.by, 80).trim() },
    parts, notes: str(data.notes, 2000), ...(data.created ? { created: Number(data.created) || 0 } : {}),
  };
}

/*
 * Year-end files (engagements-calc.js): the accountant's working file for one year-end. The trial balance snapshot
 * is kept as it was taken (names and all), so it still reads the same if accounts are renamed later. It must add up
 * to zero. Adjusting entries must balance and use accounts in the books; one posted to the books keeps its entry's id.
 * A final file can't be changed, only reopened (status back to 'open').
 */
const ENG_MAX_LINES = 5000;
function validateEngagement(data, store, id) {
  if (!isDate(data.yearEnd)) throw new ValidationError('Choose the year-end date.');
  const kind = ENGAGE.KINDS[data.kind] ? data.kind : 'compilation';
  const status = ENGAGE.statusOf(data.status);
  const prev = id && store.get('engagements', id);
  const accountIds = new Set(store.list('accounts').map(a => a.id));
  const snap = isObj(data.snapshot) ? data.snapshot : null;
  if (!snap || !Array.isArray(snap.lines)) throw new ValidationError('Take the trial balance snapshot first.');
  // Where the trial balance came from: the books (it must balance, as the books do), or an import or typing it in,
  // where accounts can be the file's own (ids starting "x:") and a difference is allowed until the file is final.
  // 'qbo' and 'xero': brought in from the client's QuickBooks Online or Xero books (ledgers.js), like an import.
  const source = ['import', 'manual', 'qbo', 'xero'].includes(snap.source) ? snap.source : 'books';
  // The file's own accounts ("x:"): any line of an imported or typed-in trial balance, or a prior-year-only line brought
  // over from CaseWare (or another program) into a file that otherwise follows the books.
  const ownId = id => /^x:[A-Za-z0-9_-]{1,60}$/.test(id);
  const priorFromCw = snap.priorSource === 'caseware';
  const own = (id, line) => ownId(id) && (source !== 'books' || (priorFromCw && line && !Number(line.cur)));
  if (snap.lines.length > ENG_MAX_LINES) throw new ValidationError('That trial balance has too many lines.');
  let tc = 0, tp = 0;
  const seen = new Set();
  const lines = snap.lines.map((l, i) => {
    if (!isObj(l)) throw new ValidationError(`Trial balance line ${i + 1} is not valid.`);
    const account = str(l.account, 120);
    if (!account || seen.has(account)) throw new ValidationError(`Trial balance line ${i + 1} has no account, or the account is there twice.`);
    seen.add(account);
    if (account !== ENGAGE.RE_OPEN && !accountIds.has(account) && !own(account, l)) throw new ValidationError(`Trial balance line ${i + 1} uses an account that doesn’t exist.`);
    const cur = cents(l.cur || 0), prior = cents(l.prior || 0);
    if (!Number.isFinite(cur) || !Number.isFinite(prior) || Math.abs(cur) > 1e14 || Math.abs(prior) > 1e14) throw new ValidationError(`Trial balance line ${i + 1} has an invalid amount.`);
    tc += cur; tp += prior;
    return { account, code: str(l.code, 30).trim(), name: str(l.name, 200).trim() || 'Account', type: TYPES.includes(l.type) ? l.type : 'Expense',
      detail: str(l.detail, 30), gifi: /^\d{4}$/.test(String(l.gifi || '')) ? String(l.gifi) : '', cur: cur / 100, prior: prior / 100 };
  });
  if (tc !== 0 && (source === 'books' || status === 'final')) throw new ValidationError(`The trial balance doesn’t add up to zero (off by ${(tc / 100).toFixed(2)}).${source === 'books' ? ' Check for unbalanced entries in the books.' : ''}`);
  if (tp !== 0 && (source === 'books' || status === 'final')) throw new ValidationError(`The prior year’s trial balance doesn’t add up to zero (off by ${(tp / 100).toFixed(2)}).`);
  const lineIds = new Set(lines.map(l => l.account));
  const usable = id => accountIds.has(id) || (ownId(id) && (source !== 'books' || priorFromCw) && lineIds.has(id));
  const map = {};
  if (isObj(data.map)) for (const [k, v] of Object.entries(data.map).slice(0, ENG_MAX_LINES)) if (ENGAGE.BY_CODE[v] && (usable(k) || k === ENGAGE.RE_OPEN)) map[k] = v;
  const ajes = (Array.isArray(data.ajes) ? data.ajes : []).slice(0, 1000).map((j, i) => {
    if (!isObj(j)) throw new ValidationError(`Adjusting entry ${i + 1} is not valid.`);
    const jl = (Array.isArray(j.lines) ? j.lines : []).slice(0, 200).filter(l => isObj(l) && (Number(l.debit) || Number(l.credit))).map(l => {
      if (!usable(l.account)) throw new ValidationError(`Adjusting entry ${i + 1} uses an account that doesn’t exist.`);
      const d = cents(l.debit || 0), c = cents(l.credit || 0);
      if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0 || (d && c)) throw new ValidationError(`Adjusting entry ${i + 1} has an invalid amount.`);
      return { account: String(l.account), debit: d / 100, credit: c / 100, memo: str(l.memo, 200).trim() };
    });
    const out = { id: str(j.id, 40).trim() || `aje${i + 1}`, num: Math.max(1, Math.floor(Number(j.num) || i + 1)), date: isDate(j.date) ? j.date : data.yearEnd,
      memo: str(j.memo, 300).trim(), explanation: str(j.explanation, 2000), wp: ENG_WP(j.wp), lines: jl, entryId: j.entryId ? str(j.entryId, 120) : '',
      preparedBy: engStamp(j.preparedBy), reviewedBy: engStamp(j.reviewedBy), recurring: !!j.recurring, fromId: j.fromId ? str(j.fromId, 40) : '' };
    const bad = ENGAGE.ajeProblem(out);
    if (bad) throw new ValidationError(`Adjusting entry ${out.num}: ${bad}`);
    return out;
  });
  // Working papers: notes, comments, cross-references, tickmarks and sign-offs for each section.
  const wps = {};
  if (isObj(data.wps)) for (const [code, w] of Object.entries(data.wps).slice(0, 100)) {
    if (!ENG_WP(code) || !isObj(w)) continue;
    const ticks = {};
    if (isObj(w.ticks)) for (const [acc, t] of Object.entries(w.ticks).slice(0, 500)) if (ENGAGE.TICKS[t]) ticks[str(acc, 120)] = t;
    wps[code] = { status: ENGAGE.WP_STATUS[w.status] ? w.status : 'notstarted', notes: str(w.notes, 20000), comment: str(w.comment, 4000), refs: str(w.refs, 300).trim(),
      ticks, prepared: engStamp(w.prepared), reviewed: engStamp(w.reviewed) };
  }
  const reviewNotes = (Array.isArray(data.reviewNotes) ? data.reviewNotes : []).slice(0, 500).filter(isObj).map((n, i) => {
    const text = str(n.text, 4000).trim();
    if (!text) throw new ValidationError(`Review note ${i + 1} needs a description.`);
    const st = ENGAGE.NOTE_STATUS[n.status] ? n.status : 'open';
    return { id: str(n.id, 40).trim() || `rn${i + 1}`, num: Math.max(1, Math.floor(Number(n.num) || i + 1)), wp: ENG_WP(n.wp), text,
      assignee: str(n.assignee, 80), assigneeName: str(n.assigneeName, 120).trim(), priority: ENGAGE.PRIORITY[n.priority] ? n.priority : 'normal', status: st,
      created: engStamp(n.created), resolution: str(n.resolution, 4000), resolved: st === 'resolved' || st === 'closed' ? engStamp(n.resolved) : null };
  });
  const checklist = {};
  if (isObj(data.checklist)) for (const [k, v] of Object.entries(data.checklist).slice(0, 100)) if (/^[A-Za-z]{1,30}$/.test(k) && engStamp(v)) checklist[k] = engStamp(v);
  const s = isObj(data.signoffs) ? data.signoffs : {};
  const team = isObj(data.team) ? data.team : {};
  const person = p => (isObj(p) && p.id ? { id: str(p.id, 80), name: str(p.name, 120).trim() } : null);
  const ci = isObj(data.client) ? data.client : {};
  const client = Object.fromEntries(['legalName', 'operatingName', 'address', 'province', 'corpNumber', 'bn', 'contact', 'industry', 'owners'].map(k => [k, str(ci[k], k === 'address' || k === 'owners' ? 1000 : 200).trim()]));
  const out = {
    entity: ENGAGE.ENTITIES[data.entity] ? data.entity : '',
    layout: { expenses: isObj(data.layout) && data.layout.expenses === 'summary' ? 'summary' : 'detail' },
    materiality: isObj(data.materiality) ? { amount: Math.max(0, Math.min(1e9, Math.round(Number(data.materiality.amount) || 0))), pct: Math.max(0, Math.min(100, Number(data.materiality.pct) || 0)) } : null,
    yearEnd: data.yearEnd, rolledFrom: data.rolledFrom ? str(data.rolledFrom, 120) : '', kind, status, framework: ENGAGE.FRAMEWORKS[data.framework] ? data.framework : 'ASPE',
    client, team: { preparer: person(team.preparer), reviewer: person(team.reviewer) },
    snapshot: { takenAt: Number(snap.takenAt) || Date.now(), by: str(snap.by, 120).trim(), priorEnd: isDate(snap.priorEnd) ? snap.priorEnd : '', lines, source,
      // The prior year from last year's final file (roll forward) rather than the books.
      priorSource: ['file', 'caseware'].includes(snap.priorSource) ? snap.priorSource : 'books', fileName: str(snap.fileName, 120), ...(snap.bulk ? { bulk: true } : {}), ...(['qbo', 'xero'].includes(source) ? { pulledAt: Number(snap.pulledAt) || 0, ledgerName: str(snap.ledgerName, 120) } : {}),
      // The prior year brought over from a CaseWare export: kept when the current year follows the books again.
      ...(priorFromCw && isObj(snap.priorImport) ? { priorImport: Object.fromEntries(Object.entries(snap.priorImport).slice(0, ENG_MAX_LINES).filter(([k, v]) => (accountIds.has(k) || ownId(k) || k === ENGAGE.RE_OPEN) && Number.isFinite(Number(v))).map(([k, v]) => [k, Math.round(Number(v) * 100) / 100])), priorFile: str(snap.priorFile, 120) } : {}) },
    map, ajes, wps, reviewNotes, checklist, notes: str(data.notes, 5000),
    signoffs: { prepared: engStamp(s.prepared), reviewed: engStamp(s.reviewed) },
    unlocks: (Array.isArray(data.unlocks) ? data.unlocks : []).slice(-200).filter(isObj).map(u => ({ ...engStamp(u), reason: str(u.reason, 1000).trim() })).filter(u => u.at),
    // The financial statements' words: the compilation engagement report and the notes, written by the accountant.
    includeCashFlow: !!data.includeCashFlow,
    // Time spent on the engagement, the budget, and what was invoiced.
    time: (Array.isArray(data.time) ? data.time : []).slice(0, 2000).filter(isObj).map((t, i) => {
      const hours = Math.round((Number(t.hours) || 0) * 100) / 100;
      if (!(hours > 0) || hours > 24) throw new ValidationError(`Time entry ${i + 1}: enter between 0 and 24 hours.`);
      return { id: str(t.id, 40) || `t${i + 1}`, date: isDate(t.date) ? t.date : data.yearEnd, userId: str(t.userId, 80), name: str(t.name, 120).trim(), hours,
        rate: Math.max(0, Math.min(10000, Math.round((Number(t.rate) || 0) * 100) / 100)), note: str(t.note, 500).trim(), billed: isDate(t.billed) ? t.billed : '' };
    }),
    budget: isObj(data.budget) ? { hours: Math.max(0, Math.min(100000, Number(data.budget.hours) || 0)), fee: Math.max(0, Math.min(1e9, Math.round((Number(data.budget.fee) || 0) * 100) / 100)), rate: Math.max(0, Math.min(10000, Number(data.budget.rate) || 0)) } : null,
    letters: Object.fromEntries(['engagement', 'representation'].filter(k => isObj(data.letters) && isObj(data.letters[k])).map(k => { const l = data.letters[k]; return [k, { custom: !!l.custom, template: str(l.template, 60), date: isDate(l.date) ? l.date : '', text: str(l.text, 12000) }]; })),
    report: isObj(data.report) ? { custom: !!data.report.custom, template: str(data.report.template, 60), text: str(data.report.text, 8000), signer: str(data.report.signer, 120).trim(), city: str(data.report.city, 80).trim(), date: isDate(data.report.date) ? data.report.date : '' } : { text: '', signer: '', city: '', date: '' },
    fsNotes: (Array.isArray(data.fsNotes) ? data.fsNotes : []).slice(0, 30).filter(isObj).map(n => ({ title: str(n.title, 150).trim(), text: str(n.text, 8000) })).filter(n => n.title || n.text.trim()),
    finalAt: status === 'final' ? Number(data.finalAt) || Date.now() : 0, finalBy: status === 'final' ? str(data.finalBy, 120).trim() : '',
    ...(data.created ? { created: Number(data.created) || 0 } : {}),
  };
  // A final file is locked, except for the time spent on it and its budget (often recorded and invoiced afterwards).
  if (prev && ENGAGE.statusOf(prev.status) === 'final' && status === 'final') {
    const strip = x => { const { time, budget, finalAt, finalBy, ...rest } = x; return JSON.stringify(sortDeep(rest)); };
    if (strip(out) !== strip(validateEngagement({ ...prev, status: 'progress' }, store, null)).replace('"status":"progress"', '"status":"final"')) throw new ValidationError('This year-end file is final. Reopen it to make changes.', 409);
  }
  return out;
}
const sortDeep = v => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = sortDeep(v[k]); return o; }, {}) : v);
/** A sign-off or date stamp on a year-end file: { by (name), id (user), at (ms) }, or null. The server sets them (see app.js). */
function engStamp(x) { return isObj(x) && Number(x.at) > 0 ? { by: str(x.by, 120).trim(), id: str(x.id, 80), at: Number(x.at) } : null; }
/** A working paper's code (a leadsheet or one of the extra sections), or ''. */
function ENG_WP(code) { const c = String(code || ''); return ENGAGE.BY_CODE[c] || ENGAGE.EXTRA_WPS.some(x => x.code === c) ? c : ''; }

/*
 * A request to the client from a year-end file: a document to send (bank statement, loan statement…) or the draft
 * statements to approve. The client sees it, answers it and uploads files; the server stamps who did what (app.js).
 */
const REQ_STATUS = ['open', 'sent', 'accepted', 'returned'];
function validateRequest(data, store) {
  const engagementId = str(data.engagementId, 120);
  const e = store.get('engagements', engagementId);
  if (!e) throw new ValidationError('That year-end file doesn’t exist.');
  const text = str(data.text, 2000).trim();
  if (!text) throw new ValidationError('Say what you need from the client.');
  return {
    engagementId, yearEnd: e.yearEnd, kind: data.kind === 'approval' ? 'approval' : 'document', wp: ENG_WP(data.wp), text,
    due: isDate(data.due) ? data.due : '', status: REQ_STATUS.includes(data.status) ? data.status : 'open',
    clientNote: str(data.clientNote, 2000), staffNote: str(data.staffNote, 2000),
    created: engStamp(data.created), sent: engStamp(data.sent), decided: engStamp(data.decided),
    approval: isObj(data.approval) && engStamp(data.approval) ? { ...engStamp(data.approval), approved: !!data.approval.approved } : null,
  };
}


/** Daily employee time and tip entry (independent of posted payroll). */
function validateWorkshift(data, store) {
  if (!isDate(data.date)) throw new ValidationError('Enter a valid work date.');
  const employeeId = String(data.employeeId || '');
  if (!store.get('employees', employeeId)) throw new ValidationError('Choose an existing employee.');
  const start = String(data.start || ''), end = String(data.end || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) throw new ValidationError('Enter start and end times as HH:MM.');
  const minutes = t => Number(t.slice(0,2))*60 + Number(t.slice(3,5));
  let duration = minutes(end) - minutes(start);
  if (duration <= 0) duration += 1440; // overnight work
  const breakMinutes = Number(data.breakMinutes || 0);
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= duration) throw new ValidationError('Break minutes must be shorter than the shift.');
  const workedMinutes = duration - breakMinutes;
  if (workedMinutes > 1440) throw new ValidationError('A shift cannot exceed 24 hours.');
  const tips = Number(data.tips || 0);
  if (!Number.isFinite(tips) || tips < 0 || tips > 1000000 || Math.round(tips*100)/100 !== tips) throw new ValidationError('Enter a non-negative tip amount with at most two decimals.');
  const tipType = data.tipType === 'direct' ? 'direct' : 'controlled';
  return {date:data.date, employeeId, start, end, breakMinutes, workedMinutes, tips, tipType, notes:String(data.notes||'').slice(0,300)};
}

function validateRecord(collection, id, data, store) {
  checkId(id);
  if (!isObj(data)) throw new ValidationError('Record body must be a JSON object.');
  switch (collection) {
    case 'accounts': return validateAccount(data, store, id);
    case 'contacts': return validateContact(data, store, id);
    case 'items': return validateItem(data, store, id);
    case 'budgets': return validateBudget(data, store);
    case 'trips': return validateTrip(data, store);
    case 'pos': return validatePo(data, store);
    case 'projects': return validateProject(data, store);
    case 'times': return validateTime(data, store);
    case 'assets': return validateAsset(data, store);
    case 'vehicles': return validateVehicle(data, store, id);
    case 'docs': return validateDoc(data, store, id);
    case 'entries': return validateEntry(data, store, id);
    case 'bankTxns': return validateBankTxn(data, store, id);
    case 'rules': return validateRule(data, store);
    case 'recons': return validateRecon(data, store);
    case 'filings': return validateFiling({ ...data, id }, store);
    case 'employees': return validateEmployee(data);
    case 'payruns': return validatePayrun(data, store, id);
    case 'workshifts': return validateWorkshift(data, store);
    case 'receipts': return validateReceipt(data, store, id);
    case 'attachments': return validateAttachment(data, store);
    case 'questions': return validateQuestion(data, store);
    case 'estimates': return validateEstimate(data, store, id);
    case 'recurring': return validateRecurring(data, store, id);
    case 'delayed': return validateDelayed(data, store, id);
    case 'engagements': return validateEngagement(data, store, id);
    case 'requests': return validateRequest(data, store);
    default: throw new ValidationError(`Unknown collection "${collection}".`, 404);
  }
}

function checkDelete(collection, id, store) {
  checkId(id);
  if (collection === 'receipts') {
    const r = store.get('receipts', id);
    if (r && (r.entryId || r.docId)) throw new ValidationError('This receipt is attached to a transaction, so it’s kept as proof. Delete the transaction first if it’s wrong.', 409);
  }
  if (collection === 'accounts' && store.accountUsed(id)) {
    throw new ValidationError('This account has transactions, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  if (collection === 'accounts' && (store.list('bankTxns').some(b => b.account === id) || store.list('rules').some(r => r.account === id))) {
    throw new ValidationError('This account has imported bank transactions or bank rules, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  const onLines = r => (r.lines || []).some(l => l.account === id) || r.bank === id || r.from === id || r.to === id;
  if (collection === 'accounts' && store.list('engagements').some(e => (e.ajes || []).some(onLines) || ((e.snapshot || {}).lines || []).some(l => l.account === id && (l.cur || l.prior)))) {
    throw new ValidationError('This account is on a year-end file, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  if (collection === 'accounts' && (store.list('recurring').some(onLines) || store.list('estimates').some(onLines) || store.list('delayed').some(onLines))) {
    throw new ValidationError('This account is used on a recurring transaction or an estimate, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  if (collection === 'delayed') {
    const r = store.get('delayed', id), d = r && r.invoiceId && store.get('docs', r.invoiceId);
    if (d && (d.lines || []).some(l => l && l.dl === id)) throw new ValidationError(`This is on invoice${d.number ? ' #' + d.number : ''}. Take it off the invoice (or delete the invoice) first.`, 409);
  }
  if (collection === 'estimates' && DEP.forEstimate(id, store.list('entries')).list.length) {
    throw new ValidationError('This estimate has deposits recorded on it. Delete or refund them first.', 409);
  }
  if (collection === 'entries') {
    const e = store.get('entries', id);
    if (e && e.type === 'custdeposit') {
      const s = DEP.forEstimate(e.estimateId, store.list('entries'), id);
      if (s.applied + s.refunded > s.received + 0.004) throw new ValidationError('Part of this deposit has been used on an invoice or refunded. Delete that first.', 409);
    }
  }
  if (collection === 'entries' && store.list('trips').some(t => t.entryId === id)) {
    throw new ValidationError('This expense is a mileage claim. Undo the claim from Expenses → Mileage instead.', 409);
  }
  if (collection === 'projects') {
    const used = r => r.proj === id;
    if (store.list('entries').some(used) || store.list('docs').some(used) || store.list('times').some(t => t.projectId === id)) throw new ValidationError('This project has transactions or time on it, so it can’t be deleted. Mark it done instead.', 409);
  }
  if (collection === 'times') { const t = store.get('times', id); if (t && t.invoiceId && store.get('docs', t.invoiceId)) throw new ValidationError('This time is on an invoice. Delete the invoice first.', 409); }
  if (collection === 'assets') { const a = store.get('assets', id); if (a && Object.values(a.posted || {}).some(e => store.get('entries', e))) throw new ValidationError('Amortization for this asset is in the books. Delete those entries first (Fixed assets → the year → Undo).', 409); }
  if (collection === 'vehicles') { const v = store.get('vehicles', id); if (v && [v.buyEntry, v.doneEntry].some(e => e && store.get('entries', e))) throw new ValidationError('This vehicle’s purchase is in the books. Open the vehicle and use “Delete vehicle and its purchase” instead.', 409); }
  if (collection === 'entries' && store.list('vehicles').some(v => v.buyEntry === id || v.doneEntry === id)) throw new ValidationError('This transaction belongs to a vehicle in the scrap yard. Change it from Scrap yard → the vehicle instead.', 409);
  if (collection === 'docs' && store.list('vehicles').some(v => (v.parts || []).some(p => p.docId === id && p.status === 'sold'))) throw new ValidationError('A part pulled from a vehicle was sold on this. Mark the part back in stock first (Scrap yard → the vehicle).', 409);
  if (collection === 'entries' && store.list('assets').some(a => a.disposalEntry === id)) throw new ValidationError('This entry records an asset’s disposal. Undo it from Fixed assets instead.', 409);
  if (collection === 'entries' && store.list('assets').some(a => Object.values(a.posted || {}).includes(id))) throw new ValidationError('This is an amortization entry. Undo it from Fixed assets instead.', 409);
  if (collection === 'items') {
    const onIt = r => (r.lines || []).some(l => l.item === id);
    if (store.list('docs').some(onIt) || store.list('estimates').some(onIt) || store.list('recurring').some(onIt) || store.list('delayed').some(onIt) || store.list('pos').some(onIt) || store.list('entries').some(e => e.inv && e.inv.item === id)) throw new ValidationError('This product or service is on invoices, bills or estimates, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  if (collection === 'contacts' && (store.contactUsed(id) || store.list('rules').some(r => r.contactId === id))) {
    throw new ValidationError('This contact appears on transactions, so it can’t be deleted.', 409);
  }
  if (collection === 'employees' && store.list('payruns').some(r => (r.lines || []).some(l => l.employeeId === id))) {
    throw new ValidationError('This employee has been paid, so they can’t be deleted. Mark them inactive instead.', 409);
  }
  if (collection === 'entries' && store.list('payruns').some(r => r.entryId === id || (r.void && r.void.entryId === id))) {
    throw new ValidationError('This transaction belongs to a pay run. Delete the pay run instead.', 409);
  }
  if (collection === 'payruns') checkPayrunDelete(id, store);
  if (collection === 'docs' && store.list('docs').some(c => (c.applied || []).some(a => a.docId === id))) {
    throw new ValidationError('A credit is applied to this document. Remove it from the credit first.', 409);
  }
  if (collection === 'docs' && store.hasPayments(id)) {
    throw new ValidationError('Delete the payments on this invoice or bill first.', 409);
  }
}

/** Direct deposit setup (from the employer's bank) and the CPA-005 files made so far. */
function validateDirectDeposit(d) {
  if (!isObj(d)) return { files: [] };
  const dig = (v, n) => String(v ?? '').replace(/\D/g, '').slice(0, n);
  const files = (Array.isArray(d.files) ? d.files : []).filter(isObj).slice(-200).map(f => ({
    run: str(f.run, 60), no: Math.max(1, Math.min(9999, parseInt(f.no, 10) || 1)), date: isDate(f.date) ? f.date : '',
    count: Math.max(0, parseInt(f.count, 10) || 0), total: Math.round((Number(f.total) || 0) * 100) / 100 }));
  const last = parseInt(d.lastFileNo, 10);
  return {
    originatorId: str(d.originatorId, 10).trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
    dataCentre: dig(d.dataCentre, 5),
    shortName: str(d.shortName, 15).trim(),
    longName: str(d.longName, 30).trim(),
    returnInst: dig(d.returnInst, 3), returnTransit: dig(d.returnTransit, 5), returnAccount: dig(d.returnAccount, 12),
    lastFileNo: Number.isInteger(last) && last >= 0 && last <= 9999 ? last : 0,
    files,
  };
}

/** An address in parts (employee, or the employer for the T4 Summary): null when empty. */
function validateAddrParts(a, who) {
  if (a === null || a === '') return null;
  if (!isObj(a)) throw new ValidationError('The address isn’t valid.');
  const country = ['CAN', 'USA'].includes(a.country) ? a.country : 'CAN';
  const out = { line1: str(a.line1, 60).trim(), line2: str(a.line2, 60).trim(), city: str(a.city, 40).trim(),
    prov: str(a.prov, 2).trim().toUpperCase(), postal: str(a.postal, 10).toUpperCase().replace(country === 'CAN' ? /[\s-]/g : /\s+/g, ''), country };
  if (!out.line1 && !out.line2 && !out.city && !out.postal) return null;
  if (out.prov && (country === 'CAN' ? !PAY_PROVINCES.includes(out.prov) : !/^[A-Z]{2}$/.test(out.prov))) throw new ValidationError(`${who ? who + ': ' : ''}choose a province or territory.`);
  if (out.postal && country === 'CAN' && !/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(out.postal)) throw new ValidationError(`${who ? who + ': ' : ''}the postal code looks like A1A 1A1.`);
  return out;
}
/** Who sends the T4 XML file to CRA, and who CRA contacts about it (the T619 transmittal). */
function validateTransmitter(t) {
  if (!isObj(t)) return {};
  const email = v => { const s = str(v, 60).trim(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''; };
  return { repId: str(t.repId, 7).toUpperCase().replace(/[^A-Z0-9]/g, ''), name: str(t.name, 35).trim(), contact: str(t.contact, 35).trim(),
    phone: str(t.phone, 30).trim(), email: email(t.email), email2: email(t.email2) };
}

function validatePayrollSettings(p) {
  if (!isObj(p)) p = {}; // the same defaults, in the same shape, as an empty object (so "unchanged" compares equal)
  const hsf = Number(p.hsfRate);
  const out = {
    hsfRate: Number.isFinite(hsf) && hsf >= 0 && hsf <= 10 ? hsf : 1.65,
    // How often source deductions are remitted (payroll-calc.js REMIT_FREQS): CRA, and Revenu Québec on its own
    // ('' or left out: the same as CRA's).
    remitFreq: PAYCALC.REMIT_FREQS.cra.includes(p.remitFreq) ? p.remitFreq : 'monthly',
    craAccount: str(p.craAccount, 20).toUpperCase().replace(/\s/g, ''),
    rqId: str(p.rqId, 20).toUpperCase().replace(/\s/g, ''),
    hsfPrimary: !!p.hsfPrimary,
    assocPayroll: optAmount(p.assocPayroll, 'Associated employers’ payroll') || 0,
    dd: validateDirectDeposit(p.dd),
    transmitter: validateTransmitter(p.transmitter),
    employerAddr: isObj(p.employerAddr) ? validateAddrParts(p.employerAddr, 'Employer') : null,
    // Overtime: the company's own weekly threshold ('' = the province's rule).
    otThreshold: (() => { const n = Number(p.otThreshold); return p.otThreshold === '' || p.otThreshold == null || !Number.isFinite(n) ? '' : Math.min(168, Math.max(1, Math.round(n * 100) / 100)); })(),
    eht: validateEht(p.eht),
    wsib: validateWsib(p.wsib),
  };
  if (PAYCALC.REMIT_FREQS.rq.includes(p.remitFreqRq)) out.remitFreqRq = p.remitFreqRq;
  // Emailed pay stubs: the subject and message in each language (blank: Sumlora's own wording).
  if (isObj(p.stubMail)) {
    const m = {};
    for (const l of ['en', 'fr']) {
      const x = isObj(p.stubMail[l]) ? p.stubMail[l] : {};
      const subject = str(x.subject, 200).replace(/[\r\n]+/g, ' ').trim(), text = str(x.text, 2000).trim();
      if (subject || text) m[l] = { subject, text };
    }
    if (Object.keys(m).length) out.stubMail = m;
  }
  return out;
}
/** Ontario Employer Health Tax: eligible for the exemption, this employer's share of it, and associated employers' payroll. */
function validateEht(e) {
  if (!isObj(e)) return { eligible: true, exemption: '', groupPayroll: 0 };
  const ex = optAmount(e.exemption, 'EHT exemption');
  if (ex !== '' && ex > 1000000) throw new ValidationError('The EHT exemption is at most $1,000,000.');
  return { eligible: e.eligible !== false, exemption: ex, groupPayroll: optAmount(e.groupPayroll, 'Associated employers’ Ontario payroll') || 0 };
}
/** Workers' compensation (WSIB in Ontario): account, reporting frequency, maximum insurable earnings and rate groups. */
function validateWsib(w) {
  if (!isObj(w)) return { on: false, account: '', freq: 'quarterly', max: '', groups: [] };
  const groups = Array.isArray(w.groups) ? w.groups : [];
  if (groups.length > 20) throw new ValidationError('At most 20 workers’ compensation rate groups.');
  const seen = new Set();
  const out = groups.map((g, i) => {
    if (!isObj(g)) throw new ValidationError(`Rate group ${i + 1} isn’t valid.`);
    const id = str(g.id, 40).trim() || 'g' + (i + 1);
    if (seen.has(id)) throw new ValidationError('Two rate groups have the same id.');
    seen.add(id);
    const rate = Number(g.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new ValidationError(`Rate group ${i + 1}: the rate per $100 must be between 0 and 100.`);
    return { id, name: str(g.name, 80).trim(), code: str(g.code, 20).trim(), rate: Math.round(rate * 10000) / 10000 };
  });
  if (w.on && !out.length) throw new ValidationError('Add at least one rate group with its rate per $100 of insurable earnings.');
  return { on: !!w.on, account: str(w.account, 30).trim(), freq: ['monthly', 'quarterly', 'annual'].includes(w.freq) ? w.freq : 'quarterly', max: optAmount(w.max, 'Maximum insurable earnings'), groups: out };
}

function validateCompany(data) {
  if (!isObj(data)) throw new ValidationError('Settings must be a JSON object.');
  const fy = Number(data.fyStart);
  const out = {
    name: str(data.name, 120).trim() || 'My Business',
    fyStart: fy >= 1 && fy <= 12 ? Math.floor(fy) : 1,
    taxName: str(data.taxName, 20).trim() || 'Sales tax',
    taxRate: Math.max(0, Math.min(100, Number(data.taxRate) || 0)),
    terms: Math.max(0, Math.min(365, parseInt(data.terms, 10) || 0)),
    currency: str(data.currency, 4) || '$',
    bn: str(data.bn, 40).trim(),
    province: /^[A-Z]{2}$/.test(data.province || '') ? data.province : '',
    qstRate: Math.max(0, Math.min(100, Number(data.qstRate) || 0)),
    // Provincial sales tax (BC PST, Manitoba RST, Saskatchewan PST): charged on sales with GST, not recoverable on purchases.
    pstRate: Math.max(0, Math.min(20, Number(data.pstRate) || 0)),
    pstName: ['PST', 'RST'].includes(data.pstName) ? data.pstName : 'PST',
    pstFreq: ['monthly', 'quarterly', 'semiannual', 'annual'].includes(data.pstFreq) ? data.pstFreq : 'quarterly',
    filingFreq: ['monthly', 'quarterly', 'annual'].includes(data.filingFreq) ? data.filingFreq : 'quarterly',
    lang: data.lang === 'fr' ? 'fr' : 'en',
    ai: !!data.ai,
    // Shown on invoices, credit notes and statements.
    address: str(data.address, 300).trim(),
    phone: str(data.phone, 40).trim(),
    email: str(data.email, 120).trim(),
    website: str(data.website, 120).trim(),
    invoiceNote: str(data.invoiceNote, 1000).trim(),
    // Interac e-Transfer address printed on invoices ("how to pay").
    etransfer: /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(data.etransfer || '').trim()) ? String(data.etransfer).trim() : '',
    logoFile: /^[A-Za-z0-9-]{0,64}$/.test(String(data.logoFile || '')) ? String(data.logoFile || '') : '',
    payroll: validatePayrollSettings(data.payroll),
    quickMethod: validateQuickMethod(data.quickMethod, fy >= 1 && fy <= 12 ? Math.floor(fy) : 1, data.filingFreq),
    // Business, non-profit organization or registered charity: changes report wording and how sales tax is worked out.
    orgType: ['npo', 'charity'].includes(data.orgType) ? data.orgType : 'business',
    // Type of business chosen when the books were set up (industries.js).
    industry: IND.INDUSTRIES[data.industry] && !['npo', 'charity'].includes(data.orgType) ? data.industry : '',
    nonprofit: validateNonprofit(data.nonprofit),
    // Features switched off for this company (only "false" is stored: everything in the plan is on by default).
    features: Object.fromEntries(Object.keys(PLANS.FEATURES).filter(k => !PLANS.FEATURES[k].firm && isObj(data.features) && data.features[k] === false).map(k => [k, false])),
    notDuplicates: (Array.isArray(data.notDuplicates) ? data.notDuplicates : []).slice(-500).map(x => str(x, 130)).filter(Boolean),
    // How invoices, estimates, sales receipts and purchase orders look, and up to three fields of the company's own.
    docStyle: { color: /^#[0-9a-fA-F]{6}$/.test(isObj(data.docStyle) ? data.docStyle.color : '') ? data.docStyle.color : '#0a7369', layout: ['classic', 'bold', 'minimal'].includes(isObj(data.docStyle) && data.docStyle.layout) ? data.docStyle.layout : 'classic' },
    customFields: (Array.isArray(data.customFields) ? data.customFields : []).filter(isObj).slice(0, 3).map((f, i) => ({ id: 'f' + (i + 1), label: str(f.label, 30).trim(), sales: f.sales !== false, purchase: !!f.purchase })).filter(f => f.label),
    lateFee: validateLateFee(data.lateFee),
    // Bill approvals: on or off, which bills (over an amount, from some vendors) and who besides owners approves them.
    approvals: APPROVALS.clean(data.approvals),
    // Opening UCC for each CCA class, at the start of the first fiscal year Sumlora works out (from the last T2 Schedule 8).
    ccaOpening: isObj(data.ccaOpening) ? Object.fromEntries(Object.entries(data.ccaOpening).filter(([k, v]) => /^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(k) && isObj(v) && isDate(v.fy)).slice(0, 60).map(([k, v]) => [k, { fy: v.fy, ucc: Math.max(0, Math.round((Number(v.ucc) || 0) * 100) / 100) }])) : {},
    // Classes: a way to sort income and expenses (branch, department, line of business). One per transaction, or with
    // classPerLine one on each line (like QuickBooks Online), so one bill can be split between classes.
    classPerLine: !!data.classPerLine,
    // What the company calls its classes.
    classLabel: ['class', 'location', 'department', 'division'].includes(data.classLabel) ? data.classLabel : 'class',
    classes: (() => { const seen = new Set(); return (Array.isArray(data.classes) ? data.classes : []).filter(isObj).slice(0, 200).map(c => ({ id: str(c.id, 40), name: str(c.name, 60).trim(), active: c.active !== false })).filter(c => c.id && c.name && !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase())); })(),
    // Tags: labels on transactions, several per transaction, optionally in groups (tags.js).
    ...(() => { const t = TAGS.cleanList(data.tagGroups, data.tags); return { tagGroups: t.groups, tags: t.tags }; })(),
    mileage: isObj(data.mileage) ? { expenseAccount: str(data.mileage.expenseAccount, 40), payAccount: str(data.mileage.payAccount, 40), territories: !!data.mileage.territories, rates: isObj(data.mileage.rates) ? Object.fromEntries(Object.entries(data.mileage.rates).filter(([y, v]) => /^\d{4}$/.test(y) && isObj(v)).slice(0, 20).map(([y, v]) => [y, { first: Math.max(0, Math.min(5, Number(v.first) || 0)), after: Math.max(0, Math.min(5, Number(v.after) || 0)) }])) : {} } : { expenseAccount: '', payAccount: '', territories: false, rates: {} },
    // Reports' default accounting method: accrual (as the books are kept) or cash (invoices and bills when paid).
    reportBasis: data.reportBasis === 'cash' ? 'cash' : 'accrual',
    savedReports: (Array.isArray(data.savedReports) ? data.savedReports : []).slice(0, 30).filter(isObj).map(r => ({
      id: str(r.id, 40), name: str(r.name, 60).trim(), tab: ['pl', 'bs', 'cf', 'tb', 'gl', 'ar', 'ap', 'sc', 'si', 'ev', 'bva', 'iv', 'tl', 'tg'].includes(r.tab) ? r.tab : 'pl', ...(r.cls ? { cls: str(r.cls, 40) } : {}), ...(r.budget ? { budget: str(r.budget, 120) } : {}),
      period: ['month', 'lastmonth', 'quarter', 'ytd', 'fy', 'lastfy', 'all', 'custom'].includes(r.period) ? r.period : 'fy',
      from: isDate(r.from) ? r.from : '', to: isDate(r.to) ? r.to : '', compare: ['prev', 'prevyear', 'months', 'quarters', 'prevmonth', 'byclass', 'bycustomer'].includes(r.compare) ? r.compare : '', acct: str(r.acct, 40), ...(r.tbAdj ? { tbAdj: r.tbAdj === 'aje' ? 'aje' : true } : {}),
      ...(['accrual', 'cash'].includes(r.basis) ? { basis: r.basis } : {}),
      // Report filters (customers, vendors, accounts, classes, tags): lists of ids; anything else is dropped.
      ...(REPFILTER.clean(r.flt) ? { flt: REPFILTER.clean(r.flt) } : {}),
      ...(isObj(r.sort) && ['date', 'type', 'num', 'name', 'memo', 'acct', 'split', 'cls', 'amt'].includes(r.sort.col) ? { sort: { col: r.sort.col, dir: r.sort.dir === 'desc' ? 'desc' : 'asc' } } : {}),
    })).filter(r => r.id && r.name),
    cashForecast: validateCashForecast(data.cashForecast),
    // Workflow reminders (workflows.js): which ready-made rules are on, and how each is set.
    workflows: (() => { try { return WF.clean(data.workflows); } catch (e) { throw new ValidationError(e.message); } })(),
  };
  if (out.qstRate > 0 && out.pstRate > 0) throw new ValidationError('A company charges QST or PST, not both.');
  if (out.pstRate > 0 && out.pstRate >= out.taxRate) throw new ValidationError('The sales tax rate must include GST plus PST.');
  // Registered charities and qualifying non-profits can't use the Quick Method.
  if (out.quickMethod.on && (out.orgType === 'charity' || (out.orgType === 'npo' && out.nonprofit.qualifying))) out.quickMethod = { ...out.quickMethod, on: false };
  return out;
}
/**
 * Cash flow forecast (Reports → Cash flow forecast): how it's worked out, the company's own planned money in and
 * out, and the lines someone unticked to leave out. Planned items are refused when they're wrong, not dropped, so
 * the person saving one sees why.
 */
function validateCashForecast(c) {
  c = isObj(c) ? c : {};
  const planned = Array.isArray(c.planned) ? c.planned : [];
  if (planned.length > 100) throw new ValidationError('At most 100 planned items.');
  const ids = new Set();
  const out = planned.map(p => {
    if (!isObj(p)) throw new ValidationError('Each planned item must be an object.');
    const id = str(p.id, 40).trim(), name = str(p.name, 80).trim(), amount = Math.round((Number(p.amount) || 0) * 100) / 100;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || ids.has(id)) throw new ValidationError('Each planned item needs its own id.');
    ids.add(id);
    if (!name) throw new ValidationError('Give the planned item a name.');
    if (!['in', 'out'].includes(p.dir)) throw new ValidationError('A planned item is money in or money out.');
    if (!(amount > 0) || amount > 1e9) throw new ValidationError('Enter the planned amount (more than $0).');
    if (!isDate(p.date)) throw new ValidationError('Enter the date of the planned item.');
    const every = ['once', 'week', 'month', 'quarter', 'year'].includes(p.every) ? p.every : 'once';
    const n = Number(p.n === undefined || p.n === '' ? 1 : p.n);
    if (every !== 'once' && !(Number.isInteger(n) && n >= 1 && n <= 12)) throw new ValidationError('Repeat every 1 to 12 weeks, months, quarters or years.');
    const end = every !== 'once' && p.end ? p.end : '';
    if (end && (!isDate(end) || end < p.date)) throw new ValidationError('The planned item’s end date must be on or after its first date.');
    return { id, name, dir: p.dir, amount, date: p.date, every, ...(every !== 'once' ? { n } : {}), ...(end ? { end } : {}) };
  });
  return {
    days: [30, 60, 90].includes(Number(c.days)) ? Number(c.days) : 30,
    overdue: c.overdue === 'skip' ? 'skip' : 'week',
    late: !!c.late,
    cards: !!c.cards,
    planned: out,
    // Keys of forecast lines left out ("inv:<id>", "rec:<id>:<date>"…), newest kept.
    off: [...new Set((Array.isArray(c.off) ? c.off : []).filter(k => typeof k === 'string' && /^[A-Za-z0-9_:|.@+~-]{1,140}$/.test(k)))].slice(-500),
  };
}
/** Late fees on overdue invoices: a flat amount or a percentage of what's overdue, after some days of grace. */
function validateLateFee(l) {
  if (!isObj(l)) return { on: false, kind: 'flat', amount: 0, graceDays: 0, account: '' };
  const kind = l.kind === 'percent' ? 'percent' : 'flat';
  const amount = Math.round(Math.max(0, Number(l.amount) || 0) * 100) / 100;
  if (kind === 'percent' && amount > 30) throw new ValidationError('A late fee percentage can be at most 30%.');
  if (kind === 'flat' && amount > 10000) throw new ValidationError('A late fee can be at most $10,000.');
  if (l.on && !(amount > 0)) throw new ValidationError('Enter the late fee amount.');
  if (l.on && !l.account) throw new ValidationError('Choose the income account for late fees.');
  return { on: !!l.on, kind, amount, graceDays: Math.max(0, Math.min(90, parseInt(l.graceDays, 10) || 0)), account: str(l.account, 40) };
}
/** Non-profit and charity settings. itcPct: share of tax paid on purchases used in taxable activities (blank = all). */
function validateNonprofit(n) {
  n = isObj(n) ? n : {};
  const pct = n.itcPct === '' || n.itcPct === null || n.itcPct === undefined ? '' : Math.max(0, Math.min(100, Number(n.itcPct) || 0));
  return { qualifying: !!n.qualifying, charityNo: str(n.charityNo, 20).replace(/\s+/g, '').toUpperCase(), netTax: n.netTax === 'regular' ? 'regular' : 'charity', itcPct: pct, rebate: n.rebate !== false, capitalItc: n.capitalItc !== false };
}
/** Quick Method of accounting for GST/HST and QST. Rates blank = the published rate for the business type. */
function validateQuickMethod(q, fy, freq) {
  if (!isObj(q)) return { on: false };
  const rate = v => (v === '' || v === null || v === undefined ? '' : Math.max(0, Math.min(20, Number(v) || 0)));
  const from = isDate(q.from) ? q.from : '';
  if (q.on && !from) throw new ValidationError('Choose the date you start using the Quick Method.');
  if (q.on && fy) {
    // It starts on the first day of a reporting period.
    const step = { monthly: 1, quarterly: 3, annual: 12 }[freq] || 3, m = Number(from.slice(5, 7));
    if (from.slice(8) !== '01' || ((m - fy + 12) % 12) % step) throw new ValidationError('Start the Quick Method on the first day of a reporting period.');
  }
  return { on: !!q.on, from, type: q.type === 'goods' ? 'goods' : 'services', gstRate: rate(q.gstRate), qstRate: rate(q.qstRate), credit: q.credit !== false };
}

/* Files attached to a transaction, invoice or bill. Created by the upload route; the file itself is in the files table. */
const ATTACH_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const OFFICE_TYPES = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
function validateAttachment(data, store) {
  if (!isObj(data)) throw new ValidationError('An attachment must be an object.');
  if (!['entries', 'docs', 'engagements', 'requests'].includes(data.target) || !store.get(data.target, String(data.targetId || ''))) throw new ValidationError('That attachment isn’t on a transaction that exists.');
  // Year-end files (and the client's answers to their requests) also take Excel and Word documents.
  const types = ['engagements', 'requests'].includes(data.target) ? [...ATTACH_TYPES, ...OFFICE_TYPES] : ATTACH_TYPES;
  if (!types.includes(data.mediaType)) throw new ValidationError(data.target === 'engagements' ? 'Attach a PDF, a photo, or an Excel or Word document.' : 'Attachments are PDFs or photos.');
  return { target: data.target, targetId: String(data.targetId), ...(data.target === 'engagements' ? { wp: ENG_WP(data.wp) } : {}), fileId: str(data.fileId, 60), name: str(data.name, 120), mediaType: data.mediaType, size: Number(data.size) || 0,
    uploadedBy: str(data.uploadedBy, 120), uploadedByName: str(data.uploadedByName, 120), uploadedAt: Number(data.uploadedAt) || 0 };
}
/* A question about a transaction, invoice or bill, answered in a thread by the client or the team. */
/* Estimates (quotes): not posted to the ledger. Turning one into an invoice links them (invoiceId). */
const EST_STATUS = ['open', 'accepted', 'declined'];
function docLines(lines) {
  if (!Array.isArray(lines)) throw new ValidationError('Lines must be a list.');
  if (lines.length > 200) throw new ValidationError('Use at most 200 lines.');
  return lines.map(l => {
    if (!isObj(l)) throw new ValidationError('Each line must be an object.');
    const out = { desc: str(l.desc, 500), account: String(l.account || ''), taxCode: ['std', 'gst', 'zero', 'export', 'exempt', 'none'].includes(l.taxCode) ? l.taxCode : 'none' };
    if (l.item) out.item = str(l.item, 120);
    if (l.cls !== undefined && l.cls !== null) out.cls = typeof l.cls === 'string' ? l.cls.slice(0, 40) : '\u0000'; // checked by checkLineClasses
    if (l.qty !== undefined) out.qty = Number(l.qty) || 0;
    if (l.rate !== undefined) out.rate = Number(l.rate) || 0;
    if (l.amount !== undefined) out.amount = Number(l.amount) || 0;
    if (![out.qty, out.rate, out.amount].every(n => n === undefined || Number.isFinite(n))) throw new ValidationError('Line amounts must be numbers.');
    return out;
  });
}
function validateEstimate(data, store, id) {
  if (!isDate(data.date)) throw new ValidationError('Estimate date must be YYYY-MM-DD.');
  if (data.expires && !isDate(data.expires)) throw new ValidationError('The date the estimate is good until must be YYYY-MM-DD.');
  const c = store.get('contacts', String(data.contactId || ''));
  if (!c) throw new ValidationError('Choose the customer for this estimate.');
  if (!Number.isFinite(Number(data.total))) throw new ValidationError('Estimate total must be a number.');
  const lines = docLines(data.lines);
  for (const l of lines) if (l.account && !store.get('accounts', l.account)) throw new ValidationError('An account on this estimate doesn’t exist.');
  checkLineClasses(lines, store, id && store.get('estimates', id));
  if (data.invoiceId && !store.get('docs', String(data.invoiceId))) throw new ValidationError('The invoice made from this estimate doesn’t exist.');
  const out = { ...data, number: str(data.number, 40), memo: str(data.memo, 2000), lines, status: EST_STATUS.includes(data.status) ? data.status : 'open', invoiceId: data.invoiceId ? String(data.invoiceId) : '' };
  // When it was emailed (recorded by the server's mail route), for workflow follow-ups.
  if (data.sent !== undefined) out.sent = (Array.isArray(data.sent) ? data.sent : []).filter(isObj).slice(-20).map(e => ({ at: Number(e.at) || 0, to: str(e.to, 300), by: str(e.by, 120), what: ['estimate', 'followup'].includes(e.what) ? e.what : 'estimate' }));
  // Deposit requested: a percent of the total, or an amount up to the total.
  delete out.deposit;
  if (data.deposit && Number(data.deposit.value)) {
    const d = data.deposit, kind = d.kind === 'percent' ? 'percent' : 'amount', v = Math.round(Number(d.value) * 100) / 100;
    if (!(v > 0)) throw new ValidationError('The deposit requested must be above zero.');
    if (kind === 'percent' && v > 100) throw new ValidationError('The deposit requested can’t be more than 100%.');
    if (kind === 'amount' && v > (Number(data.total) || 0) + 0.004) throw new ValidationError('The deposit requested is more than the estimate’s total.');
    out.deposit = { kind, value: v };
  }
  // Once a deposit has been received, the customer stays, and the total can't drop below it.
  if (id) {
    const s = DEP.forEstimate(id, store.list('entries')), prev = store.get('estimates', id);
    if (s.list.length && prev && prev.contactId !== out.contactId) throw new ValidationError('A deposit has been received on this estimate, so its customer can’t change.', 409);
    if (s.received > (Number(out.total) || 0) + 0.004) throw new ValidationError(`The total can’t be less than the ${s.received.toFixed(2)} deposit received.`, 409);
  }
  // Its class and tags go with it to the invoice made from it.
  if (data.cls) {
    const prevE = id && store.get('estimates', id), known = new Set(((store.getSetting && store.getSetting('company')) || {}).classes?.map(x => x.id) || []);
    if (!known.has(String(data.cls)) && !(prevE && prevE.cls === data.cls)) throw new ValidationError('That class doesn’t exist. Add it under Settings first.');
    out.cls = String(data.cls);
  } else delete out.cls;
  return withTags(out, data, store);
}

/* Delayed charges and delayed credits (delayed-calc.js): noted for a customer, not in the books until they're added
   to an invoice. The invoice's lines say which ones are on it (line.dl); saving or deleting it closes or reopens them. */
function validateDelayed(data, store, id) {
  if (!DELAYED.KINDS.includes(data.kind)) throw new ValidationError('Choose a delayed charge or a delayed credit.');
  if (!isDate(data.date)) throw new ValidationError('The date must be YYYY-MM-DD.');
  const c = store.get('contacts', String(data.contactId || ''));
  if (!c || c.kind === 'vendor') throw new ValidationError('Choose the customer.');
  if (c.currency) throw new ValidationError('Delayed charges are in Canadian dollars. Bill a customer in another currency on an invoice.');
  const lines = docLines(data.lines).filter(l => l.account || l.desc || l.qty || l.rate);
  if (!lines.length) throw new ValidationError('Add at least one line.');
  for (const l of lines) {
    const a = store.get('accounts', l.account);
    if (!a || a.type !== 'Income') throw new ValidationError('Choose an income account on every line.');
    if (l.item && !store.get('items', l.item)) throw new ValidationError('A product or service on this doesn’t exist.');
    if (!Number.isFinite(l.qty || 0) || !Number.isFinite(l.rate || 0)) throw new ValidationError('Line amounts must be numbers.');
  }
  const prev = id && store.get('delayed', id);
  checkLineClasses(lines, store, prev);
  const amount = DELAYED.total({ lines });
  if (!(amount > 0)) throw new ValidationError('The amount has to be above zero.');
  // Linked to an invoice by saving the invoice (the server does it). A save here keeps a link only when that invoice
  // really has its lines (so a restore keeps the links, and nothing else can make one up).
  const onInv = invId => { const d = invId && store.get('docs', String(invId)); return d && d.kind === 'invoice' && (d.lines || []).some(l => l && l.dl === id) ? d : null; };
  const invDoc = onInv(data.invoiceId) || onInv(prev && prev.invoiceId), inv = invDoc ? invDoc.id : '';
  if (invDoc && invDoc.contactId !== String(data.contactId)) throw new ValidationError('This is on an invoice, so its customer can’t change. Take it off the invoice first.', 409);
  const known = new Set(((store.getSetting && store.getSetting('company')) || {}).classes?.map(x => x.id) || []);
  if (prev && prev.cls) known.add(prev.cls);
  const cls = data.cls && known.has(String(data.cls)) ? String(data.cls) : '';
  if (data.cls && !cls) throw new ValidationError('That class doesn’t exist. Add it under Settings first.');
  const out = { kind: data.kind, date: data.date, contactId: String(data.contactId), number: str(data.number, 40).trim(), memo: str(data.memo, 2000), lines, amount,
    status: inv ? 'closed' : 'open', invoiceId: inv, ...(cls ? { cls } : {}), created: Number(data.created) || Date.now() };
  if (data.example) out.example = true;
  return withTags(out, data, store);
}
/** An invoice's lines from delayed charges and credits (line.dl): each one this customer's, and not on another invoice. */
function checkDelayedLines(data, store, id) {
  const ids = new Set();
  for (const l of data.lines || []) {
    if (!isObj(l) || l.dl === undefined || l.dl === '' || l.dl === null) { if (isObj(l)) delete l.dl; continue; }
    if (data.kind !== 'invoice') throw new ValidationError('Delayed charges and credits go on invoices only.');
    const r = store.get('delayed', String(l.dl));
    if (!r || r.contactId !== data.contactId) throw new ValidationError('A delayed charge or credit on this invoice isn’t this customer’s.');
    if (r.invoiceId && r.invoiceId !== id && store.get('docs', r.invoiceId)) throw new ValidationError('A delayed charge or credit on this invoice is already on another invoice.', 409);
    l.dl = r.id; ids.add(r.id);
  }
}
/* Recurring transactions: a template and a schedule. The client makes each one when it's due (or reminds someone).
   Invoices and bills have a customer or vendor and item lines; expenses and deposits a bank or card account and
   category lines; transfers two accounts and an amount; journal entries debit and credit lines that must balance. */
const REC_KINDS = ['invoice', 'bill', 'expense', 'deposit', 'transfer', 'journal'], REC_EVERY = ['week', 'month', 'quarter', 'year'];
// A recurring transaction in another currency would need each day's exchange rate, which isn't known ahead.
function recBank(store, id, what) {
  const a = store.get('accounts', String(id || ''));
  if (!a || (a.detail !== 'bank' && a.detail !== 'card')) throw new ValidationError(`Choose ${what}.`);
  if (a.currency) throw new ValidationError('Recurring transactions use Canadian-dollar bank and card accounts.');
  return String(id);
}
function validateRecurring(data, store, id) {
  if (!REC_KINDS.includes(data.kind)) throw new ValidationError('A recurring transaction must be an invoice, bill, expense, deposit, transfer or journal entry.');
  if (!str(data.name).trim()) throw new ValidationError('Give the recurring transaction a name.');
  const doc = data.kind === 'invoice' || data.kind === 'bill', money = data.kind === 'expense' || data.kind === 'deposit';
  if (doc && !store.get('contacts', String(data.contactId || ''))) throw new ValidationError(`Choose the ${data.kind === 'invoice' ? 'customer' : 'vendor'}.`);
  if (!doc && data.contactId && !store.get('contacts', String(data.contactId))) throw new ValidationError('The payee on this recurring transaction doesn’t exist.');
  if (!REC_EVERY.includes(data.every)) throw new ValidationError('Choose how often: every week, month, quarter or year.');
  const n = Math.round(Number(data.n) || 1);
  if (n < 1 || n > 12) throw new ValidationError('Repeat every 1 to 12 weeks, months, quarters or years.');
  if (!isDate(data.next)) throw new ValidationError('Choose the date of the next one.');
  if (data.end && !isDate(data.end)) throw new ValidationError('The end date must be YYYY-MM-DD.');
  const day = data.day === undefined || data.day === '' || data.day === null || data.day === false ? undefined : Math.round(Number(data.day));
  if (day !== undefined && !(day >= 1 && day <= 31)) throw new ValidationError('The day of the month must be 1 to 31.');
  const out = { ...data, name: str(data.name, 100).trim(), memo: str(data.memo, 2000), n, end: data.end || '', mode: data.mode === 'remind' ? 'remind' : 'auto',
    email: data.kind === 'invoice' && !!data.email, active: data.active !== false, made: Math.max(0, Math.round(Number(data.made) || 0)) };
  if (day !== undefined) out.day = day; else delete out.day;
  if (!doc) out.contactId = data.contactId ? String(data.contactId) : '';
  if (data.ref !== undefined) out.ref = str(data.ref, 40).trim();
  if (doc || money) {
    const lines = docLines(data.lines);
    if (!lines.length) throw new ValidationError('Add at least one line.');
    for (const l of lines) if (!store.get('accounts', l.account)) throw new ValidationError('Choose an account on every line.');
    checkLineClasses(lines, store, id && store.get('recurring', id));
    out.lines = lines;
  }
  if (doc) out.terms = data.terms === '' || data.terms == null ? '' : Math.max(0, Math.min(365, Math.round(Number(data.terms) || 0)));
  if (money) {
    out.bank = recBank(store, data.bank, data.kind === 'expense' ? 'the bank or card account it’s paid from' : 'the bank account it goes into');
    if (!out.lines.some(l => l.amount)) throw new ValidationError('Add at least one line with an amount.');
    if (out.lines.some(l => l.account === out.bank)) throw new ValidationError('A line can’t use the bank or card account itself.');
  }
  if (data.kind === 'transfer') {
    out.from = recBank(store, data.from, 'the account the money comes from');
    out.to = recBank(store, data.to, 'the account the money goes to');
    if (out.from === out.to) throw new ValidationError('Pick two different accounts.');
    const amount = cents(data.amount);
    if (!(amount > 0)) throw new ValidationError('Enter an amount above zero.');
    out.amount = amount / 100;
    delete out.lines;
  }
  if (data.kind === 'journal') {
    // Each one made from it goes straight into the books, so it has to balance now (the journal entry rule).
    const bad = RECUR.journalProblem(data.lines);
    if (bad) throw new ValidationError(bad);
    out.lines = RECUR.journalLines(data.lines);
    for (const l of out.lines) if (!store.get('accounts', l.account)) throw new ValidationError('A line uses an account that doesn’t exist.');
    checkLineClasses(out.lines, store, id && store.get('recurring', id));
  }
  // The class and tags it gives what it makes (a class at the top, or one on each line with classes on each line).
  const prev = id && store.get('recurring', id);
  const known = new Set(((store.getSetting && store.getSetting('company')) || {}).classes?.map(x => x.id) || []);
  if (prev && prev.cls) known.add(prev.cls);
  if (data.cls) { if (!known.has(String(data.cls))) throw new ValidationError('That class doesn’t exist. Add it under Settings first.'); out.cls = String(data.cls); } else delete out.cls;
  return withTags(out, data, store);
}

function validateQuestion(data, store) {
  if (!isObj(data)) throw new ValidationError('A question must be an object.');
  if (!['entries', 'docs', 'bankTxns'].includes(data.target)) throw new ValidationError('A question has to be about a transaction.');
  if (!Array.isArray(data.thread) || !data.thread.length || data.thread.length > 100) throw new ValidationError('A question needs a message.');
  const thread = data.thread.filter(isObj).map(m => ({ by: str(m.by, 120), name: str(m.name, 120), role: ['owner', 'staff', 'client'].includes(m.role) ? m.role : 'staff', at: Number(m.at) || 0, text: str(m.text, 2000).trim() })).filter(m => m.text);
  if (!thread.length) throw new ValidationError('A question needs a message.');
  return { target: data.target, targetId: str(data.targetId, 60), status: ['open', 'answered', 'resolved'].includes(data.status) ? data.status : 'open', thread,
    label: str(data.label, 200), created: Number(data.created) || 0 };
}

module.exports = { validateRecord, checkDocumentPostings, checkDelete, validateCompany, bankAccount, ValidationError, TYPES, ENTRY_TYPES, isDate, str, sanitizeDraft, settledOn };

