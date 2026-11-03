'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Store}=require('../src/server/db');
const {AuditEvidenceService,seal,open}=require('../src/server/audit-service');
const {canUseAuditAI}=require('../src/server/audit-access');
const key=crypto.randomBytes(32);
const userA={id:'ua',username:'a@example.test',role:'staff',firmId:'firm-a'};
const userB={id:'ub',username:'b@example.test',role:'staff',firmId:'firm-b'};
const companyA={id:'company-a',firmId:'firm-a',auditAiEntitled:true};
const companyB={id:'company-b',firmId:'firm-b',auditAiEntitled:true};
const ctx=(user,company)=>({user,company,firmActive:true,canSeeCompany:(u,id)=>u.firmId===company.firmId&&id===company.id});
test('cross-firm users cannot list, view, match, or review another company evidence',()=>{
 const storeA=new Store(':memory:'),storeB=new Store(':memory:');
 try{
  const service=new AuditEvidenceService({key});
  const contents=Buffer.from('confidential data from firm A');
  storeA.putFile('audit-ai-a',{mediaType:'application/octet-stream',name:'encrypted-evidence',data:seal(contents,key,companyA.id)});
  storeA.putSetting('audit-ai-evidence',[{id:'a',name:'evidence.pdf',fields:{amountCents:100},reviewStatus:'pending'}]);
  storeB.putSetting('audit-ai-evidence',[]);
  const own=ctx(userA,companyA),intruder=ctx(userB,companyA);
  assert.equal(canUseAuditAI(own),true);
  assert.equal(canUseAuditAI(intruder),false);
  assert.equal(service.download({context:own,store:storeA,id:'a'}).bytes.toString(),contents.toString());
  for(const fn of [
   ()=>service.list({context:intruder,store:storeA}),
   ()=>service.download({context:intruder,store:storeA,id:'a'}),
   ()=>service.match({context:intruder,store:storeA,transactions:[]}),
   ()=>service.review({context:intruder,store:storeA,id:'a',decision:'approved',note:''})
  ]) assert.throws(fn,/unavailable/);
  assert.equal(service.list({context:ctx(userB,companyB),store:storeB}).length,0);
  assert.throws(()=>open(storeA.getFile('audit-ai-a').data,key,companyB.id));
  assert.equal(storeA.getSetting('audit-ai-evidence')[0].reviewStatus,'pending');
 }finally{storeA.close();storeB.close();}
});
test('revoked and archived companies cannot access evidence; wrong key cannot decrypt',()=>{
 const store=new Store(':memory:');
 try{
  const service=new AuditEvidenceService({key});
  const context=ctx(userA,companyA);
  assert.throws(()=>service.list({context:{...context,company:{...companyA,auditAiEntitled:false}},store}),/unavailable/);
  assert.throws(()=>service.list({context:{...context,company:{...companyA,archived:true}},store}),/unavailable/);
  assert.throws(()=>service.list({context:{...context,firmActive:false},store}),/unavailable/);
  const ciphertext=seal(Buffer.from('private'),key,companyA.id);
  assert.throws(()=>open(ciphertext,crypto.randomBytes(32),companyA.id));
 }finally{store.close();}
});
