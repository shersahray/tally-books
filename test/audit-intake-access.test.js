'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validatePdf,extractPdf,MAX_PDF_BYTES}=require('../src/server/audit-pdf');
const {canUseAuditAI,requireAuditAI,changeAuditAI}=require('../src/server/audit-access');
test('PDF validation rejects spoofed, oversized, and non-PDF content',()=>{
 assert.throws(()=>validatePdf(Buffer.from('not a pdf')),/PDF signature|between/);
 assert.throws(()=>validatePdf(Buffer.alloc(MAX_PDF_BYTES+1)),/between/);
 assert.throws(()=>validatePdf(Buffer.from('%PDF-1.7\n%%EOF'),'image/png'),/Only application/);
 assert.equal(validatePdf(Buffer.from('%PDF-1.7\n%%EOF')),true);
});
test('OCR input rejects unsupported languages before execution',async()=>{
 await assert.rejects(extractPdf(Buffer.from('%PDF-1.7\n%%EOF'),{language:'../evil'}),/Unsupported/);
});
test('disabled by default and tenant boundary required',()=>{
 const user={id:'u',role:'staff',disabled:false}, company={id:'c',firmId:'f'};
 const ctx={user,company,firmActive:true,canSeeCompany:()=>true};
 assert.equal(canUseAuditAI(ctx),false);
 assert.throws(()=>requireAuditAI(ctx),/unavailable/);
 assert.equal(canUseAuditAI({...ctx,company:{...company,auditAiEntitled:true},canSeeCompany:()=>false}),false);
 assert.equal(canUseAuditAI({...ctx,company:{...company,auditAiEntitled:true}}),true);
 assert.equal(canUseAuditAI({...ctx,company:{...company,auditAiEntitled:true},firmActive:false}),false);
});
test('only active platform owner can change audit entitlement, and change is audited',()=>{
 let saved,logged;
 const company={id:'co'};
 const input={company,enabled:true,saveCompany:v=>saved=v,audit:v=>logged=v};
 assert.throws(()=>changeAuditAI({...input,actor:{role:'owner',platformAdmin:false}}),/administrator/);
 assert.equal(saved,undefined);
 const actor={id:'admin',role:'owner',platformAdmin:true,disabled:false};
 changeAuditAI({...input,actor});
 assert.equal(saved.auditAiEntitled,true);
 assert.equal(logged.kind,'audit-ai-entitlement');
 assert.equal(logged.actorId,'admin');
});

test('client portal users cannot access audit evidence even if company is entitled',()=>{
 const company={id:'co',auditAiEntitled:true};
 const user={id:'client',role:'client',disabled:false};
 assert.equal(canUseAuditAI({user,company,firmActive:true,canSeeCompany:()=>true}),false);
});
