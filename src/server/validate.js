'use strict';
// Server-side rules that keep the books consistent no matter what the client sends.

const TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Cost of Goods Sold', 'Expense'];
const DETAILS = {
  Asset: ['', 'bank', 'ar', 'capital'],
  Liability: ['', 'card', 'ap', 'tax', 'qst', 'payroll_cra', 'payroll_rq', 'payroll_other', 'vacation_payable'],
  Equity: ['', 'ob'],
  Income: [''],
  'Cost of Goods Sold': [''],
  Expense: ['', 'wages', 'payroll_tax'],
};
const ENTRY_TYPES = ['invoice', 'bill', 'payment', 'billpayment', 'expense', 'deposit', 'transfer', 'journal', 'taxpayment', 'payrun', 'payremit', 'credit', 'vcredit', 'refund', 'vrefund', 'qmadjust'];
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

const DOC_KINDS = ['invoice', 'bill', 'credit', 'vcredit'];
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
  if (!DOC_KINDS.includes(data.kind)) throw new ValidationError('Document kind must be invoice, bill, credit note or vendor credit.');
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
  if (!Number.isFinite(Number(data.total))) throw new ValidationError('Document total must be a number.');
  if (!Array.isArray(data.lines)) throw new ValidationError('Document lines must be a list.');
  return data;
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
    const wants = { payment: 'invoice', billpayment: 'bill', refund: 'credit', vrefund: 'vcredit' }[data.type];
    if (doc && wants && doc.kind !== wants) throw new ValidationError(data.type === 'refund' || data.type === 'vrefund' ? 'A refund has to come from a credit.' : `A payment has to go to ${wants === 'invoice' ? 'an invoice' : 'a bill'}.`);
    // Never more than what's left on it (after other payments, refunds and credits).
    if (doc && wants) {
      const left = Math.round(((Number(doc.total) || 0) - settledOn(store, doc.id, null, id)) * 100) / 100;
      if (Number(data.amount) > left + 0.004) throw new ValidationError(`That’s more than the ${left.toFixed(2)} ${doc.kind === 'credit' || doc.kind === 'vcredit' ? 'left on the credit' : 'still owing'}.`);
    }
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
  out.dental = [1, 2, 3, 4, 5].includes(Number(data.dental)) ? Number(data.dental) : 0; // 0 = not chosen yet
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
  if (data.occupation !== undefined) out.occupation = str(data.occupation, 100).trim();
  if (data.termDate !== undefined && data.termDate !== '' && !isDate(data.termDate)) throw new ValidationError('The last day worked must be YYYY-MM-DD.');
  if (data.roes !== undefined) {
    if (!Array.isArray(data.roes) || data.roes.length > 50 || data.roes.some(r => !isObj(r) || JSON.stringify(r).length > 30000)) throw new ValidationError('The records of employment aren’t valid.');
    // The figures are numbers, the pay period type one letter.
    const n = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
    out.roes = data.roes.map(r => {
      const c = isObj(r.calc) ? r.calc : null;
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
    // Earnings broken down (regular, holiday, other, bonus, vacation pay): they have to add up to gross pay.
    const parts = {};
    for (const k of ['regular', 'holiday', 'other', 'bonus', 'vacPay', 'vacAccrued', 'holHours', 'hours', 'vacRate']) {
      if (l[k] === undefined || l[k] === '') continue;
      parts[k] = amt(l[k], { regular: 'regular pay', holiday: 'holiday pay', other: 'other pay', bonus: 'bonus', vacPay: 'vacation pay', vacAccrued: 'vacation pay set aside', holHours: 'holiday hours', hours: 'hours', vacRate: 'vacation pay rate' }[k]) / 100;
    }
    if (parts.regular !== undefined && ['holiday', 'other', 'bonus', 'vacPay'].some(k => parts[k] !== undefined)) {
      const sum = ['regular', 'holiday', 'other', 'bonus', 'vacPay'].reduce((t, k) => t + cents(parts[k] || 0), 0);
      if (sum !== gross) throw new ValidationError(`${emp.name}: regular, holiday, other, bonus and vacation pay don’t add up to gross pay.`);
    }
    if (parts.vacRate !== undefined && parts.vacRate > 100) throw new ValidationError(`${emp.name}: the vacation pay rate is a percentage, 100 or less.`);
    const extra = { ...parts };
    if (l.vacMode !== undefined) { if (!['accrue', 'each'].includes(l.vacMode)) throw new ValidationError(`${emp.name}: unknown vacation pay method.`); extra.vacMode = l.vacMode; }
    if (extra.vacAccrued && l.vacMode !== 'accrue') throw new ValidationError(`${emp.name}: vacation pay is only set aside for employees whose vacation pay is set aside.`);
    if (l.holidays !== undefined) {
      if (!Array.isArray(l.holidays) || l.holidays.length > 12) throw new ValidationError(`${emp.name}: the holidays aren’t valid.`);
      extra.holidays = l.holidays.map(h => ({ date: isDate(h && h.date) ? h.date : '', name: str(h && h.name, 80) })).filter(h => h.date);
    }
    if (l.final !== undefined) extra.final = !!l.final;
    return { ...l, ...extra, gross: gross / 100, rrsp: cents(numOr0(l.rrsp)) / 100, union: cents(numOr0(l.union)) / 100, ded, er, net: n / 100 };
  });
  if (data.entryId && !store.get('entries', data.entryId)) throw new ValidationError('The journal entry for this pay run doesn’t exist.');
  return { ...data, lines, totalNet: net / 100 };
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
const RECEIPT_SERVER = ['fileId', 'fileName', 'mediaType', 'size', 'uploadedBy', 'uploadedByName', 'uploadedAt', 'readStatus', 'readError', 'draft', 'readAt', 'wasAttached'];
function validateReceipt(data, store, id) {
  const prev = store.get('receipts', id);
  if (!prev && !(data.fileId && store.hasFile(String(data.fileId)))) throw new ValidationError('Add receipts from the Receipts screen.');
  // A restored receipt can't share a photo with another one (deleting either would remove it).
  if (!prev && store.list('receipts').some(r => r.fileId === String(data.fileId))) throw new ValidationError('That photo already belongs to another receipt.');
  const base = {};
  if (prev) { for (const k of RECEIPT_SERVER) if (prev[k] !== undefined) base[k] = prev[k]; }
  else {
    Object.assign(base, { fileId: String(data.fileId), fileName: str(data.fileName, 120), mediaType: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(data.mediaType) ? data.mediaType : 'image/jpeg',
      size: Number(data.size) || 0, uploadedBy: str(data.uploadedBy, 200), uploadedByName: str(data.uploadedByName, 200), uploadedAt: Number(data.uploadedAt) || Date.now(),
      readStatus: data.draft ? 'read' : 'off', readError: '', wasAttached: !!data.wasAttached });
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

function validateRecord(collection, id, data, store) {
  checkId(id);
  if (!isObj(data)) throw new ValidationError('Record body must be a JSON object.');
  switch (collection) {
    case 'accounts': return validateAccount(data, store, id);
    case 'contacts': return validateContact(data);
    case 'docs': return validateDoc(data, store, id);
    case 'entries': return validateEntry(data, store, id);
    case 'bankTxns': return validateBankTxn(data, store, id);
    case 'rules': return validateRule(data, store);
    case 'recons': return validateRecon(data, store);
    case 'filings': return validateFiling({ ...data, id }, store);
    case 'employees': return validateEmployee(data);
    case 'payruns': return validatePayrun(data, store);
    case 'receipts': return validateReceipt(data, store, id);
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
  if (collection === 'contacts' && (store.contactUsed(id) || store.list('rules').some(r => r.contactId === id))) {
    throw new ValidationError('This contact appears on transactions, so it can’t be deleted.', 409);
  }
  if (collection === 'employees' && store.list('payruns').some(r => (r.lines || []).some(l => l.employeeId === id))) {
    throw new ValidationError('This employee has been paid, so they can’t be deleted. Mark them inactive instead.', 409);
  }
  if (collection === 'entries' && store.list('payruns').some(r => r.entryId === id)) {
    throw new ValidationError('This transaction belongs to a pay run. Delete the pay run instead.', 409);
  }
  if (collection === 'docs' && store.list('docs').some(c => (c.applied || []).some(a => a.docId === id))) {
    throw new ValidationError('A credit is applied to this document. Remove it from the credit first.', 409);
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
    assocPayroll: optAmount(p.assocPayroll, 'Associated employers’ payroll') || 0,
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
    ai: !!data.ai,
    // Shown on invoices, credit notes and statements.
    address: str(data.address, 300).trim(),
    phone: str(data.phone, 40).trim(),
    email: str(data.email, 120).trim(),
    website: str(data.website, 120).trim(),
    invoiceNote: str(data.invoiceNote, 1000).trim(),
    logoFile: /^[A-Za-z0-9-]{0,64}$/.test(String(data.logoFile || '')) ? String(data.logoFile || '') : '',
    payroll: validatePayrollSettings(data.payroll),
    quickMethod: validateQuickMethod(data.quickMethod),
  };
}
/** Quick Method of accounting for GST/HST and QST. Rates blank = the published rate for the business type. */
function validateQuickMethod(q) {
  if (!isObj(q)) return { on: false };
  const rate = v => (v === '' || v === null || v === undefined ? '' : Math.max(0, Math.min(20, Number(v) || 0)));
  const from = isDate(q.from) ? q.from : '';
  if (q.on && !from) throw new ValidationError('Choose the date you start using the Quick Method.');
  return { on: !!q.on, from, type: q.type === 'goods' ? 'goods' : 'services', gstRate: rate(q.gstRate), qstRate: rate(q.qstRate), credit: q.credit !== false };
}

module.exports = { validateRecord, checkDelete, validateCompany, bankAccount, ValidationError, TYPES, isDate, str, sanitizeDraft };
