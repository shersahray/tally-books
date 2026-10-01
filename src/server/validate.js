'use strict';
// Server-side rules that keep the books consistent no matter what the client sends.

const TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Cost of Goods Sold', 'Expense'];
const DETAILS = {
  Asset: ['', 'bank', 'ar'],
  Liability: ['', 'card', 'ap', 'tax', 'qst', 'payroll_cra', 'payroll_rq', 'payroll_other'],
  Equity: ['', 'ob'],
  Income: [''],
  'Cost of Goods Sold': [''],
  Expense: ['', 'wages', 'payroll_tax'],
};
const ENTRY_TYPES = ['invoice', 'bill', 'payment', 'billpayment', 'expense', 'deposit', 'transfer', 'journal', 'taxpayment', 'payrun', 'payremit'];
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
    if (!doc) throw new ValidationError('The invoice or bill this payment applies to doesn’t exist.');
    if (!(Number(data.amount) > 0)) throw new ValidationError('Payment amount must be above zero.');
  }
  return { ...data, lines };
}

function bankAccount(store, id) {
  const a = store.get('accounts', id);
  if (!a || (a.detail !== 'bank' && a.detail !== 'card')) throw new ValidationError('Choose a bank or credit card account.');
  return a;
}

const BANK_STATUS = ['new', 'added', 'matched', 'excluded'];
function validateBankTxn(data, store) {
  bankAccount(store, data.account);
  if (!isDate(data.date)) throw new ValidationError('Bank transaction date must be YYYY-MM-DD.');
  const amt = Number(data.amount);
  if (!Number.isFinite(amt) || amt === 0) throw new ValidationError('Bank transaction amount must be a non-zero number.');
  if (!BANK_STATUS.includes(data.status)) throw new ValidationError('Unknown bank transaction status.');
  if ((data.status === 'added' || data.status === 'matched') && !store.get('entries', data.entryId)) {
    throw new ValidationError('The transaction this bank line points to doesn’t exist.');
  }
  return { ...data, amount: cents(amt) / 100, desc: str(data.desc, 300), entryId: data.status === 'added' || data.status === 'matched' ? data.entryId : '' };
}

function validateRule(data, store) {
  if (!str(data.text).trim()) throw new ValidationError('A rule needs text to look for.');
  if (!['any', 'in', 'out'].includes(data.direction || 'any')) throw new ValidationError('Rule direction must be any, in or out.');
  const a = store.get('accounts', data.account);
  if (!a) throw new ValidationError('Choose the account this rule should use.');
  if (a.detail === 'bank' || a.detail === 'card') throw new ValidationError('A rule can’t categorize into a bank or card account; use a transfer instead.');
  if (data.contactId && !store.get('contacts', data.contactId)) throw new ValidationError('The payee on this rule doesn’t exist.');
  return { ...data, text: str(data.text, 100).trim(), direction: data.direction || 'any', tax: !!data.tax, contactId: data.contactId || '' };
}

function validateRecon(data, store) {
  bankAccount(store, data.account);
  if (!isDate(data.statementDate)) throw new ValidationError('Statement date must be YYYY-MM-DD.');
  if (!Number.isFinite(Number(data.endingBalance))) throw new ValidationError('Ending balance must be a number.');
  if (!Array.isArray(data.entryIds)) throw new ValidationError('Reconciliation must list its transactions.');
  return data;
}

function validateFiling(data, store) {
  if (!['gst', 'qst'].includes(data.tax)) throw new ValidationError('A filing must be for GST/HST or QST.');
  if (!isDate(data.from) || !isDate(data.to) || data.from > data.to) throw new ValidationError('A filing needs a valid period.');
  if (!isDate(data.filedOn)) throw new ValidationError('Enter the date the return was filed.');
  if (!isObj(data.lines)) throw new ValidationError('A filing must include its return lines.');
  if (data.entryId && !store.get('entries', data.entryId)) throw new ValidationError('The payment or refund for this filing doesn’t exist.');
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
  out.dental = [1, 2, 3, 4, 5].includes(Number(data.dental)) ? Number(data.dental) : 1;
  out.pensionType = data.pensionType === 'rpp' ? 'rpp' : 'rrsp';
  if (data.openingYtd !== undefined) {
    if (!isObj(data.openingYtd)) throw new ValidationError('Opening year-to-date amounts must be an object.');
    const o = { year: parseInt(data.openingYtd.year, 10) || 0 };
    for (const [k, v] of Object.entries(data.openingYtd)) if (k !== 'year') o[k] = optAmount(v, 'Opening year-to-date ' + k) || 0;
    out.openingYtd = o;
  }
  return out;
}

const PAY_KEYS = ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip', 'fedTax', 'provTax', 'qcTax'];
const ER_KEYS = ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip', 'hsf'];
function validatePayrun(data, store) {
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
    return { ...l, gross: gross / 100, rrsp: cents(numOr0(l.rrsp)) / 100, union: cents(numOr0(l.union)) / 100, ded, er, net: n / 100 };
  });
  if (data.entryId && !store.get('entries', data.entryId)) throw new ValidationError('The journal entry for this pay run doesn’t exist.');
  return { ...data, lines, totalNet: net / 100 };
}

function validateRecord(collection, id, data, store) {
  checkId(id);
  if (!isObj(data)) throw new ValidationError('Record body must be a JSON object.');
  switch (collection) {
    case 'accounts': return validateAccount(data, store, id);
    case 'contacts': return validateContact(data);
    case 'docs': return validateDoc(data);
    case 'entries': return validateEntry(data, store);
    case 'bankTxns': return validateBankTxn(data, store);
    case 'rules': return validateRule(data, store);
    case 'recons': return validateRecon(data, store);
    case 'filings': return validateFiling({ ...data, id }, store);
    case 'employees': return validateEmployee(data);
    case 'payruns': return validatePayrun(data, store);
    default: throw new ValidationError(`Unknown collection "${collection}".`, 404);
  }
}

function checkDelete(collection, id, store) {
  checkId(id);
  if (collection === 'accounts' && store.accountUsed(id)) {
    throw new ValidationError('This account has transactions, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  if (collection === 'accounts' && (store.list('bankTxns').some(b => b.account === id) || store.list('rules').some(r => r.account === id))) {
    throw new ValidationError('This account has imported bank transactions or bank rules, so it can’t be deleted. Mark it inactive instead.', 409);
  }
  if (collection === 'contacts' && (store.contactUsed(id) || store.list('rules').some(r => r.contactId === id))) {
    throw new ValidationError('This contact appears on transactions, so it can’t be deleted.', 409);
  }
  if (collection === 'employees' && store.list('payruns').some(r => (r.lines || []).some(l => l.employeeId === id))) {
    throw new ValidationError('This employee has been paid, so they can’t be deleted. Mark them inactive instead.', 409);
  }
  if (collection === 'entries' && store.list('payruns').some(r => r.entryId === id)) {
    throw new ValidationError('This transaction belongs to a pay run. Delete the pay run instead.', 409);
  }
  if (collection === 'docs' && store.hasPayments(id)) {
    throw new ValidationError('Delete the payments on this invoice or bill first.', 409);
  }
}

function validatePayrollSettings(p) {
  if (!isObj(p)) return { hsfRate: 1.65, remitFreq: 'monthly' };
  const hsf = Number(p.hsfRate);
  return {
    hsfRate: Number.isFinite(hsf) && hsf >= 0 && hsf <= 10 ? hsf : 1.65,
    remitFreq: ['monthly', 'quarterly'].includes(p.remitFreq) ? p.remitFreq : 'monthly',
    craAccount: str(p.craAccount, 20).toUpperCase().replace(/\s/g, ''),
    rqId: str(p.rqId, 20).toUpperCase().replace(/\s/g, ''),
    hsfPrimary: !!p.hsfPrimary,
  };
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
    province: /^[A-Z]{2}$/.test(data.province || '') ? data.province : '',
    qstRate: Math.max(0, Math.min(100, Number(data.qstRate) || 0)),
    filingFreq: ['monthly', 'quarterly', 'annual'].includes(data.filingFreq) ? data.filingFreq : 'quarterly',
    lang: data.lang === 'fr' ? 'fr' : 'en',
    payroll: validatePayrollSettings(data.payroll),
  };
}

module.exports = { validateRecord, checkDelete, validateCompany, bankAccount, ValidationError, TYPES, isDate };
