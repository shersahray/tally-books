'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Store}=require('../src/server/db');
const {AuditEvidenceService,keyFromEnv,seal,open}=require('../src/server/audit-service');
const key=crypto.randomBytes(32);
const user={id:'acct',username:'accountant@example.test',name:'Accountant',role:'staff'};
const company={id:'firm-a-company',firmId:'firm-a',auditAiEntitled:true};
const context={user,company,firmActive:true,canSeeCompany:()=>true};
test('storage key is strict 32-byte hex and ciphertext binds to company',()=>{
 assert.equal(keyFromEnv('abc'),null);
 assert.equal(keyFromEnv(key.toString('hex')).length,32);
 const encrypted=seal(Buffer.from('private evidence'),key,'a');
 assert.equal(open(encrypted,key,'a').toString(),'private evidence');
 assert.throws(()=>open(encrypted,key,'b'));
 assert.ok(!encrypted.includes(Buffer.from('private evidence')));
});
test('review is audited, tenant checks gate reads and edits',()=>{
 const store=new Store(':memory:');
 try {
  const svc=new AuditEvidenceService({key});
  const bytes=Buffer.from('PDF sensitive');
  store.putFile('audit-ai-test',{mediaType:'application/octet-stream',name:'encrypted-evidence',data:seal(bytes,key,company.id)});
  store.putSetting('audit-ai-evidence',[{id:'test',name:'test.pdf',reviewStatus:'pending',fields:{amountCents:12500}}]);
  assert.equal(svc.list({context,store}).length,1);
  assert.equal(svc.download({context,store,id:'test'}).bytes.toString(),'PDF sensitive');
  assert.throws(()=>svc.list({context:{...context,company:{...company,auditAiEntitled:false}},store}),/unavailable/);
  assert.throws(()=>svc.download({context:{...context,canSeeCompany:()=>false},store,id:'test'}),/unavailable/);
  assert.throws(()=>svc.review({context:{...context,user:{...user,role:'client'}},store,id:'test',decision:'approved',note:''}),/Reviewer/);
  const reviewed=svc.review({context,store,id:'test',decision:'approved',note:'checked supporting documentation'});
  assert.equal(reviewed.reviewStatus,'approved');
  assert.equal(store.auditList({collection:'audit-ai'}).length,1);
  assert.equal(svc.match({context,store,transactions:[{id:'txn1',amount:125}]} )[0].candidates[0].documentId,'test');
 } finally {store.close();}
});
