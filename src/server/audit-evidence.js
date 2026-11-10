'use strict';
// Sumlora Audit AI: deterministic evidence extraction + matching foundation.
// Pure functions: no external calls, persistence, or changes to accounting entries.
const crypto = require('node:crypto');
const MAX_TEXT = 200000;
const money = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/[,$\s]/g, '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
};
const norm = value => String(value ?? '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9]/g, '');
const isoDate = value => {
  const s = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
  }
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!m) return null;
  return isoDate(m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0'));
};
function extractInvoiceFields(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new TypeError('Document text must be nonempty and within 200000 characters');
  const find = regex => text.match(regex)?.[1]?.trim() || null;
  const invoiceNumber = find(/(?:invoice\s*(?:no\.?|number|#)|inv\s*#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{1,39})/i);
  const date = isoDate(find(/(?:invoice\s*date|date)\s*[:#-]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/i));
  const totalRaw = find(/(?:amount\s+due|invoice\s+total|grand\s+total|total\s+due)\s*[:$\s]*(-?[\d,]+\.\d{2})/i);
  const taxRaw = find(/(?:GST\/HST|GST|HST|QST)\s*[:$\s]*(-?[\d,]+\.\d{2})/i);
  const vendor = find(/(?:supplier|vendor|from)\s*:\s*([^\r\n]{2,100})/i);
  const amountCents = money(totalRaw), taxCents = money(taxRaw);
  return {invoiceNumber, date, vendor, amountCents, taxCents, currency:'CAD',
    source:'document-text', status: amountCents === null ? 'needs-review' : 'extracted',
    warnings:[...(amountCents === null ? ['Total amount not located'] : []), ...(!invoiceNumber ? ['Invoice number not located'] : [])]};
}
function fingerprint(document) {
  const text = String(document.text ?? '');
  return crypto.createHash('sha256').update(text).digest('hex');
}
function matchEvidence(transactions, documents, opts = {}) {
  if (!Array.isArray(transactions) || !Array.isArray(documents) || transactions.length > 10000 || documents.length > 10000) throw new TypeError('Expected bounded arrays of transactions and documents');
  const toleranceCents = opts.toleranceCents ?? 0;
  if (!Number.isSafeInteger(toleranceCents) || toleranceCents < 0 || toleranceCents > 10000) throw new TypeError('Invalid tolerance');
  const seen = new Set();
  const evidence = documents.map(doc => {
    if (!doc || typeof doc.id !== 'string' || !doc.id || seen.has(doc.id)) throw new TypeError('Document IDs must be unique nonempty strings');
    seen.add(doc.id);
    const fields = doc.fields ?? extractInvoiceFields(doc.text);
    return {id:doc.id, fields, fingerprint: doc.text ? fingerprint(doc) : null};
  });
  return transactions.map(tx => {
    if (!tx || typeof tx.id !== 'string' || !tx.id) throw new TypeError('Transaction ID required');
    const amount = money(tx.amount);
    if (amount === null) return {transactionId:tx.id,status:'invalid-amount',candidates:[]};
    const candidates = evidence.flatMap(doc => {
      if (!Number.isSafeInteger(doc.fields.amountCents) || Math.abs(amount - doc.fields.amountCents) > toleranceCents) return [];
      const refMatch = Boolean(norm(tx.invoiceNumber) && norm(tx.invoiceNumber) === norm(doc.fields.invoiceNumber));
      const vendorMatch = Boolean(norm(tx.vendor) && norm(tx.vendor) === norm(doc.fields.vendor));
      const dateMatch = Boolean(isoDate(tx.date) && isoDate(tx.date) === isoDate(doc.fields.date));
      const score = 50 + (refMatch ? 30 : 0) + (vendorMatch ? 15 : 0) + (dateMatch ? 5 : 0);
      return [{documentId:doc.id,score,amountDifferenceCents:amount-doc.fields.amountCents,matchedOn:['amount',...(refMatch?['invoiceNumber']:[]),...(vendorMatch?['vendor']:[]),...(dateMatch?['date']:[])],fingerprint:doc.fingerprint}];
    }).sort((a,b)=>b.score-a.score || a.documentId.localeCompare(b.documentId));
    // Amount-only matches are not trustworthy; never auto approve evidence.
    const best = candidates[0];
    const ambiguous = best && candidates.length > 1 && candidates[1].score === best.score;
    return {transactionId:tx.id,status:!best?'unmatched':ambiguous?'ambiguous':best.score>=80?'suggested-match':'needs-review',candidates,reviewStatus:'pending'};
  });
}
module.exports = {extractInvoiceFields,matchEvidence,money,isoDate,fingerprint};
