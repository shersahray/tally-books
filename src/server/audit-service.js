'use strict';
const crypto = require('node:crypto');
const {validatePdf,extractPdf} = require('./audit-pdf');
const {extractInvoiceFields,matchEvidence} = require('./audit-evidence');
const {requireAuditAI} = require('./audit-access');
const {scanPdf} = require('./audit-malware');
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
    if (this.index(store).length >= 500) throw Object.assign(new Error('Company evidence limit reached (500 files)'), {status:413});
    if (typeof name!=='string' || !/^[^\/\x00-\x1f]{1,150}\.pdf$/i.test(name)) throw new TypeError('Invalid PDF file name');
    const digest=crypto.createHash('sha256').update(bytes).digest('hex');
    if (this.index(store).some(item=>item.sha256===digest)) throw Object.assign(new Error('This PDF has already been uploaded for this company'),{status:409});
    await scanPdf(bytes);
    // Revalidate entitlement after slow scanning/extraction before persisting.
    const result=await extractPdf(bytes,{ocr});
    this.assertAccess(context);
    const fields=result.text.trim()?extractInvoiceFields(result.text):null;
    const id=crypto.randomUUID(),now=new Date().toISOString();
    const metadata={id,name,pages:result.pages,method:result.method,fields,sha256:digest,reviewStatus:'pending',created:now,createdBy:context.user.id};
    const encrypted=seal(bytes,this.key,context.company.id);
    store.transaction(()=>{
      this.assertAccess(context);
      if(this.index(store).length>=500 || this.index(store).some(item=>item.sha256===digest)) throw Object.assign(new Error('Evidence quota or duplicate changed during processing'),{status:409});
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
  deleteEvidence({context,store,id,reason}) {
    this.assertAccess(context);
    if(context.user.readOnly || !['owner','admin'].includes(context.user.role)) throw Object.assign(new Error('Owner or administrator required'),{status:403});
    if(typeof id!=='string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError('Invalid evidence ID');
    if(typeof reason!=='string' || reason.trim().length<5 || reason.length>500) throw new TypeError('Deletion reason required');
    const current=this.index(store),evidence=current.find(x=>x.id===id);
    if(!evidence)return null;
    store.transaction(()=>{
      const latest=this.index(store);
      if(!latest.some(x=>x.id===id))throw Object.assign(new Error('Evidence no longer exists'),{status:409});
      store.deleteFile('audit-ai-'+id);
      store.putSetting('audit-ai-evidence',latest.filter(x=>x.id!==id));
      const reviews=store.getSetting('audit-ai-pair-reviews')||{};
      store.putSetting('audit-ai-pair-reviews',Object.fromEntries(Object.entries(reviews).filter(([,v])=>v.evidenceId!==id)));
      store.audit(context.user,'audit-ai-evidence-deleted',{collection:'audit-ai',id,summary:'Evidence deleted: '+reason.trim(),before:{id,name:evidence.name,sha256:evidence.sha256},after:null});
    });
    return {id,deleted:true};
  }
  reviewPair({context,store,entryId,evidenceId,decision,note}) {
    this.assertAccess(context);
    if(context.user.readOnly || context.user.role==='client') throw Object.assign(new Error('Reviewer access required'),{status:403});
    if(!['approved','rejected'].includes(decision)||typeof note!=='string'||note.length>2000)throw new TypeError('Invalid review decision');
    if(typeof entryId!=='string'||typeof evidenceId!=='string'||entryId.length>120||evidenceId.length>120)throw new TypeError('Invalid pair');
    const entry=store.get('entries',entryId);
    const document=this.index(store).find(d=>d.id===evidenceId);
    if(!entry||!document)return null;
    const key=JSON.stringify([entryId,evidenceId]);
    const current=store.getSetting('audit-ai-pair-reviews')||{};
    if(Object.keys(current).length>=10000&&!Object.hasOwn(current,key))throw Object.assign(new Error('Review limit reached'),{status:413});
    const existing=current[key]||null;
    const reviewed={entryId,evidenceId,decision,note,reviewedAt:new Date().toISOString(),reviewedBy:context.user.id};
    store.transaction(()=>{
      // Re-check inside the transaction to avoid stale records across concurrent requests.
      if (!store.get('entries',entryId) || !this.index(store).some(x=>x.id===evidenceId)) throw Object.assign(new Error('Review target was removed'),{status:409});
      const latest=store.getSetting('audit-ai-pair-reviews')||{};
      if(Object.keys(latest).length>=10000&&!Object.hasOwn(latest,key)) throw Object.assign(new Error('Review limit reached'),{status:413});
      store.putSetting('audit-ai-pair-reviews',{...latest,[key]:reviewed});
      store.audit(context.user,'audit-ai-pair-review',{collection:'audit-ai',id:evidenceId,
        summary:'Accountant '+decision+' evidence for GL entry '+entryId,
        before:existing,after:reviewed});
    });
    return reviewed;
  }
  pairReviews({context,store}) {
    this.assertAccess(context);
    return Object.values(store.getSetting('audit-ai-pair-reviews')||{});
  }
  review({context,store,id,decision,note}) {
    this.assertAccess(context);
    if (context.user.role==='client' || context.user.readOnly) throw Object.assign(new Error('Reviewer access required'),{status:403});
    if (!['approved','rejected'].includes(decision) || typeof note!=='string' || note.length>2000) throw new TypeError('Invalid decision');
    const records=this.index(store),item=records.find(x=>x.id===id);
    if (!item) return null;
    // This is a review of the evidence document only, NOT an audit opinion or matched-transaction signoff.
    const updated={...item,reviewStatus:decision,reviewedBy:context.user.id,reviewedAt:new Date().toISOString(),note};
    store.transaction(()=>{
      store.putSetting('audit-ai-evidence',records.map(x=>x.id===id?updated:x));
      store.audit(context.user,'audit-ai-review',{collection:'audit-ai',id,summary:'Evidence '+decision,before:{reviewStatus:item.reviewStatus},after:{reviewStatus:decision,note}});
    });
    return updated;
  }
}
module.exports={AuditEvidenceService,keyFromEnv,seal,open};
