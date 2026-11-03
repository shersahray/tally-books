'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Registry}=require('../src/server/companies');
test('Audit AI premium entitlement defaults off and persists across registry restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sumlora-audit-registry-'));
 try {
  const a=new Registry(dir), company=a.create('Example company','firm-a');
  assert.notEqual(a.get(company.id).auditAiEntitled,true);
  a.update(company.id,{auditAiEntitled:true});
  const b=new Registry(dir);
  assert.equal(b.get(company.id).auditAiEntitled,true);
  b.update(company.id,{auditAiEntitled:false});
  const c=new Registry(dir);
  assert.equal(c.get(company.id).auditAiEntitled,false);
  c.update(company.id,{auditAiEntitled:'true'});
  assert.equal(c.get(company.id).auditAiEntitled,false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
