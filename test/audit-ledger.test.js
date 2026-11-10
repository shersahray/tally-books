'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ledgerCandidates}=require('../src/server/audit-ledger');
test('returns balanced read-only entries with verification warning',()=>{
 const rows=ledgerCandidates([{id:'j1',date:'2026-10-28',ref:'INV-1',lines:[{account:'expense',debit:100,credit:0},{account:'bank',debit:0,credit:100}]},{id:'bad',lines:[{debit:5,credit:0}]}]);
 assert.equal(rows.length,1);assert.equal(rows[0].amount,100);assert.equal(rows[0].invoiceNumber,'INV-1');assert.match(rows[0].warning,/verify/i);
});
test('rejects unbounded limits and invalid inputs',()=>{
 assert.throws(()=>ledgerCandidates(null),/Invalid/);
 assert.throws(()=>ledgerCandidates([],{limit:999}),/Invalid/);
});
