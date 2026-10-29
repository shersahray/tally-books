'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {extractInvoiceFields,matchEvidence,money,isoDate} = require('../src/server/audit-evidence');
test('extract labelled fields and preserve integer cents', () => {
 const r=extractInvoiceFields('Vendor: Acme Ltd\nInvoice #: ABC-123\nInvoice Date: 2026-10-28\nGST/HST $13.00\nInvoice Total $113.00');
 assert.equal(r.invoiceNumber,'ABC-123');
 assert.equal(r.amountCents,11300);
 assert.equal(r.taxCents,1300);
 assert.equal(r.vendor,'Acme Ltd');
 assert.equal(r.date,'2026-10-28');
});
test('matching is review-only and favours corroborating identifiers',()=>{
 const docs=[{id:'d1',text:'Vendor: Acme Ltd\nInvoice #: ABC-123\nInvoice Date: 2026-10-28\nInvoice Total $113.00'}, {id:'d2',text:'Vendor: Other\nInvoice #: XYZ-900\nInvoice Total $113.00'}];
 const r=matchEvidence([{id:'t1',amount:'113.00',vendor:'Acme Ltd',invoiceNumber:'ABC-123',date:'2026-10-28'}],docs);
 assert.equal(r[0].status,'suggested-match');
 assert.equal(r[0].reviewStatus,'pending');
 assert.equal(r[0].candidates[0].documentId,'d1');
 assert.equal(r[0].candidates[0].score,100);
});
test('identical amount-only candidates remain ambiguous',()=>{
 const docs=[{id:'d1',fields:{amountCents:10000}},{id:'d2',fields:{amountCents:10000}}];
 assert.equal(matchEvidence([{id:'t1',amount:100}],docs)[0].status,'ambiguous');
});
test('invalid amounts, missing docs, dates, and duplicate identifiers are handled',()=>{
 assert.equal(money('12.345'),null);
 assert.equal(isoDate('2026-02-30'),null);
 assert.equal(matchEvidence([{id:'t',amount:25}],[])[0].status,'unmatched');
 assert.equal(matchEvidence([{id:'t',amount:'oops'}],[])[0].status,'invalid-amount');
 assert.throws(()=>matchEvidence([], [{id:'a',fields:{}},{id:'a',fields:{}}]),/unique/);
 assert.throws(()=>extractInvoiceFields(''),/nonempty/);
});
