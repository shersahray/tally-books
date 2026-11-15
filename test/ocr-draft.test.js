'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { draftFromText, readLocal } = require('../src/server/ocr-draft');

const sample = `NORTHSHORE FOOD SUPPLIES
INVOICE NO: INV-TEST-3001
Invoice Date: 2026-11-14
Due Date: 2026-12-14
Subtotal: $250.00
GST (5%): $12.50
QST (9.975%): $24.94
Total: $287.44`;

test('offline PDF text gives reconciled low-confidence draft without categorization', () => {
  const d = draftFromText(sample);
  assert.equal(d.number, 'INV-TEST-3001');
  assert.equal(d.date, '2026-11-14');
  assert.equal(d.dueDate, '2026-12-14');
  assert.equal(d.total, 287.44);
  assert.deepEqual(d.taxes, [{ name: 'GST', amount: 12.5 }, { name: 'QST', amount: 24.94 }]);
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].amount, 250);
  assert.equal(d.lines[0].account, '');
  assert.equal(d.confidence, 'low');
  assert.equal(d.vendorName, '');
});

test('missing or contradictory totals do not create misleading draft expenses', () => {
  const d = draftFromText(sample.replace('$287.44', '$299.99'));
  assert.equal(d.total, 299.99);
  assert.deepEqual(d.lines, []);
  assert.match(d.reason, /could not be reconciled/i);
});

test('avoid interpreting tax registration numbers as tax charged', () => {
  const d = draftFromText('GST No: 123456789\nInvoice No: ABC-7\nTotal: $15.00');
  assert.deepEqual(d.taxes, []);
  assert.deepEqual(d.lines, []);
});

test('offline OCR rejects invalid input before spawning utilities', async () => {
  await assert.rejects(() => readLocal({ mediaType: 'application/pdf', data: '' }), /empty, invalid/);
  await assert.rejects(() => readLocal({ mediaType: 'application/octet-stream', data: 'aGVsbG8=' }), /supported photo/);
});
