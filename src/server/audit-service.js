'use strict';
const crypto = require('node:crypto');
const {validatePdf,extractPdf} = require('./audit-pdf');
const {extractInvoiceFields,matchEvidence} = require('./audit-evidence');
const {requireAuditAI} = require('./audit-access');
const keyFromEnv = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return Buffer.from(value,'hex');
};
function seal(bytes,key,companyId) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('AUDIT_AI_STORAGE_KEY must be configured');
  const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(companyId));
  const payload=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),payload]);
}
function open(payload,key,companyId) {
  if (!Buffer.isBuffer(key) || key.length!==32 || !Buffer.isBuffer(payload) || payload.length<29) throw new Error('Invalid encrypted evidence');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,payload.subarray(0,12));
  decipher.setAAD(Buffer.from(companyId));
  decipher.setAuthTag(payload.subarray(12,28));
  return Buffer.concat([decipher.update(payload.subarray(28)),decipher.final()]);
}
class AuditEvidenceService {
  constructor({key}) { this.key=key; }
  assertAccess(context) { requireAuditAI(context); if (!this.key) throw new Error('Audit AI encrypted storage is not configured'); }
  index(store) { return store.getSetting('audit-ai-evidence') || []; }
  async upload({context,store,bytes,name,ocr=true}) {
    this.assertAccess(context);
    validatePdf(bytes);
    if (typeof name!=='string' || !/^[^\/\x00-\x1f]{1,150}\.pdf$/i.test(name)) throw new TypeError('Invalid PDF file name');
    const result=await extractPdf(bytes,{ocr});
    const fields=result.text.trim()?extractInvoiceFields(result.text):null;
    const id=crypto.randomUUID(),now=new Date().toISOString();
    const metadata={id,name,pages:result.pages,method:result.method,fields,reviewStatus:'pending',created:now,createdBy:context.user.id};
    const encrypted=seal(bytes,this.key,context.company.id);
    store.transaction(()=>{
      store.putFile('audit-ai-'+id,{mediaType:'application/octet-stream',name:'encrypted-evidence',data:encrypted});
      store.putSetting('audit-ai-evidence',[...this.index(store),metadata]);
      store.audit(context.user,'audit-ai-upload',{collection:'audit-ai',id,summary:'Encrypted evidence uploaded'});
    });
    return metadata;
  }
  list({context,store}) { this.assertAccess(context); return this.index(store); }
  download({context,store,id}) {
    this.assertAccess(context);
    const metadata=this.index(store).find(x=>x.id===id);
    if (!metadata) return null;
    const file=store.getFile('audit-ai-'+id);
    if (!file) return null;
    return {metadata,bytes:open(file.data,this.key,context.company.id)};
  }
  match({context,store,transactions}) {
    this.assertAccess(context);
    const docs=this.index(store).filter(x=>x.fields).map(x=>({id:x.id,fields:x.fields}));
    return matchEvidence(transactions,docs);
  }
  review({context,store,id,decision,note}) {
    this.assertAccess(context);
    if (context.user.role==='client' || context.user.readOnly) throw Object.assign(new Error('Reviewer access required'),{status:403});
    if (!['approved','rejected'].includes(decision) || typeof note!=='string' || note.length>2000) throw new TypeError('Invalid decision');
    const records=this.index(store),item=records.find(x=>x.id===id);
    if (!item) return null;
    const updated={...item,reviewStatus:decision,reviewedBy:context.user.id,reviewedAt:new Date().toISOString(),note};
    store.transaction(()=>{
      store.putSetting('audit-ai-evidence',records.map(x=>x.id===id?updated:x));
      store.audit(context.user,'audit-ai-review',{collection:'audit-ai',id,summary:'Evidence '+decision,before:{reviewStatus:item.reviewStatus},after:{reviewStatus:decision,note}});
    });
    return updated;
  }
}
module.exports={AuditEvidenceService,keyFromEnv,seal,open};
