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
  assert.throws(()=>svc.review({context:{...context,user:{...user,role:'client'}},store,id:'test',decision:'approved',note:''}),/unavailable/);
  const reviewed=svc.review({context,store,id:'test',decision:'approved',note:'checked supporting documentation'});
  assert.equal(reviewed.reviewStatus,'approved');
  assert.equal(store.auditList({collection:'audit-ai'}).length,1);
  assert.equal(svc.match({context,store,transactions:[{id:'txn1',amount:125}]} )[0].candidates[0].documentId,'test');
 } finally {store.close();}
});

test('per-company evidence limit rejects upload before scanning or extracting',async()=>{
 const svc=new AuditEvidenceService({key});
 const store={getSetting:name=>name==='audit-ai-evidence'?Array.from({length:500},(_,i)=>({id:String(i)})):null};
 await assert.rejects(svc.upload({context,store,bytes:Buffer.from('%PDF-1.7\n%%EOF'),name:'evidence.pdf'}),/limit reached/);
});

test('duplicate PDF is rejected before OCR processing',async()=>{
 const svc=new AuditEvidenceService({key});
 const bytes=Buffer.from('%PDF-1.7\n%%EOF');
 const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const store={getSetting:name=>name==='audit-ai-evidence'?[{id:'existing',sha256}]:null};
 await assert.rejects(svc.upload({context,store,bytes,name:'evidence.pdf'}),/already been uploaded/);
});

test('GL-entry to evidence pair review requires real records and writes audit trail',()=>{
 const store=new Store(':memory:');
 try {
  const svc=new AuditEvidenceService({key});
  store.put('entries','j1',{date:'2026-10-28',lines:[]});
  store.putSetting('audit-ai-evidence',[{id:'doc1',name:'invoice.pdf',reviewStatus:'pending'}]);
  assert.equal(svc.reviewPair({context,store,entryId:'missing',evidenceId:'doc1',decision:'approved',note:''}),null);
  assert.throws(()=>svc.reviewPair({context:{...context,user:{...user,readOnly:true}},store,entryId:'j1',evidenceId:'doc1',decision:'approved',note:''}),/Reviewer/);
  const result=svc.reviewPair({context,store,entryId:'j1',evidenceId:'doc1',decision:'approved',note:'Reviewed against GL'});
  assert.equal(result.decision,'approved');
  assert.equal(svc.pairReviews({context,store}).length,1);
  assert.equal(store.auditList({collection:'audit-ai'}).length,1);
  assert.throws(()=>svc.pairReviews({context:{...context,canSeeCompany:()=>false},store}),/unavailable/);
 } finally {store.close();}
});

test('GL pair review never changes source journal entry',()=>{
 const store=new Store(':memory:');
 try {
  const svc=new AuditEvidenceService({key});
  const original={date:'2026-10-28',memo:'Supplier',lines:[{accountId:'a1',debit:100,credit:0},{accountId:'a2',debit:0,credit:100}]};
  store.put('entries','j2',original);
  store.putSetting('audit-ai-evidence',[{id:'doc2',name:'proof.pdf',reviewStatus:'pending'}]);
  svc.reviewPair({context,store,entryId:'j2',evidenceId:'doc2',decision:'rejected',note:'Incorrect invoice'});
  assert.deepEqual((({id,...x})=>x)(store.get('entries','j2')),original);
  assert.equal(svc.pairReviews({context,store})[0].decision,'rejected');
  assert.equal(store.auditList({collection:'audit-ai'}).length,1);
 } finally {store.close();}
});

test('different GL/evidence pairs cannot collide through separators',()=>{
 const store=new Store(':memory:');
 try {
  const service=new AuditEvidenceService({key});
  store.put('entries','a:b',{date:'2026-10-28',lines:[]});
  store.put('entries','a',{date:'2026-10-28',lines:[]});
  store.putSetting('audit-ai-evidence',[{id:'c',name:'1.pdf'},{id:'b:c',name:'2.pdf'}]);
  service.reviewPair({context,store,entryId:'a:b',evidenceId:'c',decision:'approved',note:'first'});
  service.reviewPair({context,store,entryId:'a',evidenceId:'b:c',decision:'rejected',note:'second'});
  assert.equal(service.pairReviews({context,store}).length,2);
 }finally{store.close();}
});
