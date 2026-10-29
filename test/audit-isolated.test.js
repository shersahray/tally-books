'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runWorker}=require('../src/server/audit-isolated');
const pdf=Buffer.from('%PDF-1.4\n%%EOF');
test('isolated OCR worker fails closed without configured sandbox',async()=>{
 assert.throws(()=>runWorker(pdf,{command:''}),/not configured/);
});
test('worker output validated and subprocess protocol works',async()=>{
 const program="process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text:'Invoice total 100.00',pages:1,method:'pdf-text'})))";
 const result=await runWorker(pdf,{command:process.execPath,args:['-e',program]});
 assert.equal(result.pages,1);
 assert.match(result.text,/Invoice/);
});
test('malformed isolated worker output is rejected',async()=>{
 const program="process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('broken'))";
 await assert.rejects(runWorker(pdf,{command:process.execPath,args:['-e',program]}),/Invalid isolated PDF worker response/);
});
