'use strict';
// Conservative, no-network extraction of fields from locally recognized invoice text.
// This is deliberately a low-confidence draft: tax recoverability, vendors and accounts
// always require human review. Never infer sales tax from provincial rates.
const { sanitizeDraft, ValidationError } = require('./validate');
const { recognize } = require('./local-ocr');

function money(s) {
  const v = String(s || '').replace(/[$\s\u00a0]/g, '').replace(/,/g, '');
  return /^\d{1,9}(?:\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) / 100 : null;
}
function date(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(\d{4})[-/](\d\d?)[-/](\d\d?)$/);
  if (!m) return '';
  const d = [m[1], m[2].padStart(2, '0'), m[3].padStart(2, '0')].join('-');
  const v = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(+v) && v.toISOString().slice(0, 10) === d ? d : '';
}
function field(lines, re) {
  for (const s of lines) {
    const m = s.match(re);
    if (m) return m[1].trim();
  }
  return '';
}
function amountField(lines, re) {
  const v = field(lines, re);
  return v ? money(v) : null;
}
function draftFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 200);
  // Require explicit, labelled totals to avoid picking a line item or tax registration number.
  const total = amountField(lines, /^(?:grand\s+total|invoice\s+total|amount\s+due|balance\s+due|total\s+(?:due|payable)|total(?:\s+cad)?\s*[:：]?)\s*\$?\s*([\d,]+\.\d{2})\s*(?:CAD)?$/i);
  const subtotal = amountField(lines, /^(?:sub\s*-?\s*total|sous[- ]total)\s*[:：]?\s*\$?\s*([\d,]+\.\d{2})\s*(?:CAD)?$/i);
  const patterns = [
    ['GST', /^(?:gst|tps)(?:\s*\(?5(?:\.0+)?%\)?)?\s*[:：]?\s*\$?\s*([\d,]+\.\d{2})\s*$/i],
    ['QST', /^(?:qst|tvq)(?:\s*\(?9\.975%\)?)?\s*[:：]?\s*\$?\s*([\d,]+\.\d{2})\s*$/i],
    ['HST', /^(?:hst|tvh)(?:\s*\(?\d+(?:\.\d+)?%\)?)?\s*[:：]?\s*\$?\s*([\d,]+\.\d{2})\s*$/i],
    ['PST', /^(?:pst|tvp)(?:\s*\(?\d+(?:\.\d+)?%\)?)?\s*[:：]?\s*\$?\s*([\d,]+\.\d{2})\s*$/i],
  ];
  const taxes = patterns.flatMap(([name, re]) => {
    const n = amountField(lines, re);
    return n !== null && n > 0 ? [{ name, amount: n }] : [];
  });
  const sumTaxes = Math.round(taxes.reduce((s, v) => s + v.amount, 0) * 100);
  const sumBase = subtotal === null ? null : Math.round(subtotal * 100);
  const reconciled = total !== null && sumBase !== null && Math.round(total * 100) === sumBase + sumTaxes;
  const number = field(lines, /^(?:invoice\s*(?:no\.?|number|#)|facture\s*(?:n[°o]\.?|#)|inv\.?\s*#)\s*[:：#-]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,39})/i);
  const invoiceDate = date(field(lines, /^(?:invoice\s+date|date\s+de\s+facture|date)\s*[:：]?\s*(\d{4}[-/]\d\d?[-/]\d\d?)/i));
  const dueDate = date(field(lines, /^(?:due\s+date|payment\s+due|date\s+d['’]échéance)\s*[:：]?\s*(\d{4}[-/]\d\d?[-/]\d\d?)/i));
  // Vendor names are too layout-dependent to guess safely from a PDF's top lines.
  const x = { paid: false, vendorName: '', date: invoiceDate, dueDate, number,
    currency: 'CAD', total: total || 0, taxes, confidence: 'low',
    lines: reconciled && subtotal > 0 ? [{ description: 'Invoice subtotal — verify items and account', amount: subtotal, account: '', taxable: false }] : [],
    reason: reconciled ? 'Local OCR only: totals reconcile. Verify supplier, items, accounts and GST/HST/QST eligibility before saving.' :
      'Local OCR only: totals could not be reconciled. Check the PDF and enter or correct amounts manually before saving.' };
  return sanitizeDraft(x);
}
async function readLocal(file) {
  const type = String(file && file.mediaType || '');
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) throw new ValidationError('Choose a PDF or supported photo.', 400);
  const data = String(file && file.data || '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(data) || data.length * .75 > 10 * 1024 * 1024) throw new ValidationError('The document is empty, invalid or over 10 MB.', 400);
  const ocr = await recognize(file);
  if (!ocr.text || ocr.text.trim().length < 15) throw new ValidationError('Local OCR could not read this document. Check Tesseract/Poppler or use a clearer PDF.', 422);
  return { draft: draftFromText(ocr.text), usd: 0, mode: 'ocr', engine: ocr.engine };
}
module.exports = { draftFromText, readLocal };
