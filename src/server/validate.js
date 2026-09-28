'use strict';
// Server-side rules that keep the books consistent no matter what the client sends.

const TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Cost of Goods Sold', 'Expense'];
const DETAILS = {
  Asset: ['', 'bank', 'ar'],
  Liability: ['', 'card', 'ap', 'tax'],
  Equity: ['', 'ob'],
  Income: [''],
  'Cost of Goods Sold': [''],
  Expense: [''],
};
const ENTRY_TYPES = ['invoice', 'bill', 'payment', 'billpayment', 'expense', 'deposit', 'transfer', 'journal'];
const ID_RE = /^[A-Za-z0-9_.:@+~-]{1,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const cents = n => Math.round(Number(n) * 100);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).slice(0, max));

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
  return { ...data, name: str(data.name, 120).trim(), code, detail, desc: str(data.desc), active: data.active !== false };
}

function validateContact(data) {
  if (!str(data.name).trim()) throw new ValidationError('A contact needs a name.');
  if (!['customer', 'vendor'].includes(data.kind)) throw new ValidationError('Contact kind must be customer or vendor.');
  return { ...data, name: str(data.name, 160).trim() };
}

function validateDoc(data) {
  if (!['invoice', 'bill'].includes(data.kind)) throw new ValidationError('Document kind must be invoice or bill.');
  if (!isDate(data.date)) throw new ValidationError('Document date must be YYYY-MM-DD.');
  if (data.due && !isDate(data.due)) throw new ValidationError('Due date must be YYYY-MM-DD.');
  if (!Number.isFinite(Number(data.total))) throw new ValidationError('Document total must be a number.');
  if (!Array.isArray(data.lines)) throw new ValidationError('Document lines must be a list.');
  return data;
}

function validateEntry(data, store) {
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
  if (dr !== cr) throw new ValidationError(`Debits and credits don’t balance (off by ${((dr - cr) / 100).toFixed(2)}).`);
  if (dr === 0) throw new ValidationError('A transaction needs an amount.');
  if (data.applyTo) {
    const doc = store.get('docs', data.applyTo);
    if (!doc) throw new ValidationError('The invoice or bill this payment applies to doesn’t exist.');
    if (!(Number(data.amount) > 0)) throw new ValidationError('Payment amount must be above zero.');
  }
  return { ...data, lines };
}

function validateRecord(collection, id, data, store) {
  checkId(id);
  if (!isObj(data)) throw new ValidationError('Record body must be a JSON object.');
  switch (collection) {
    case 'accounts': return validateAccount(data, store, id);
    case 'contacts': return validateContact(data);
    case 'docs': return validateDoc(data);
    case 'entries': return validateEntry(data, store);
    default: throw new ValidationError(`Unknown collection "${collection}".`, 404);
  }
}

function checkDelete(collection, id, store) {
  checkId(id);
  if (collection === 'accounts' && store.accountUsed(id)) {
    throw new ValidationError('This account has transactions, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  if (collection === 'contacts' && store.contactUsed(id)) {
    throw new ValidationError('This contact appears on transactions, so it can’t be deleted.', 409);
  }
  if (collection === 'docs' && store.hasPayments(id)) {
    throw new ValidationError('Delete the payments on this invoice or bill first.', 409);
  }
}

function validateCompany(data) {
  if (!isObj(data)) throw new ValidationError('Settings must be a JSON object.');
  const fy = Number(data.fyStart);
  return {
    name: str(data.name, 120).trim() || 'My Business',
    fyStart: fy >= 1 && fy <= 12 ? Math.floor(fy) : 1,
    taxName: str(data.taxName, 20).trim() || 'Sales tax',
    taxRate: Math.max(0, Math.min(100, Number(data.taxRate) || 0)),
    terms: Math.max(0, Math.min(365, parseInt(data.terms, 10) || 0)),
    currency: str(data.currency, 4) || '$',
    bn: str(data.bn, 40).trim(),
  };
}

module.exports = { validateRecord, checkDelete, validateCompany, ValidationError, TYPES };
