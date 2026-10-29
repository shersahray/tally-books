'use strict';
// Private drafts never appear in report collections. Only explicit approval can post.
const crypto = require('node:crypto');
const { ValidationError, settledOn } = require('./validate');
const COL = '_automation';
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const words = s => String(s || '').toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(w => w.length > 1).slice(0, 2).join(' ');
const gap = (a,b) => Math.abs(Date.parse(a)-Date.parse(b))/86400000;
const fail = (s, status=409) => { throw new ValidationError(s,status); };
const cfg = s => ({on:false,background:false,ai:false,...s.getSetting('automation')});
const books = s => Object.fromEntries(['accounts','contacts','entries','docs','bankTxns','receipts','rules'].map(c=>[c,s.list(c)]));
// Conservative version: any book change requires refreshing before approval.
const basis = s => hash([books(s),s.getSetting('company'),s.getSetting('closing')]);
const acct = (b,id) => b.accounts.find(a=>a.id===id&&a.active!==false);
const isBank = a => a&&['bank','card'].includes(a.detail);
const freeReceipt = r => r.status==='inbox'&&!r.entryId&&!r.docId;
const signed = (e,id) => r2((e.lines||[]).filter(l=>l.account===id).reduce((s,l)=>s+(+l.debit||0)-(+l.credit||0),0));
function matches(b,line,s) {
  const linked = new Set(b.bankTxns.filter(x=>['added','matched'].includes(x.status)).map(x=>x.entryId));
  return [...b.entries.filter(e=>!linked.has(e.id)&&!e.clear?.[line.account]&&Math.abs(signed(e,line.account)-line.amount)<.005&&gap(e.date,line.date)<=10).map(e=>({kind:'entry',id:e.id})),
    ...b.docs.filter(d=>d.kind===(line.amount>0?'invoice':'bill')&&!d.currency&&Math.abs(r2(d.total-settledOn(s,d.id))-Math.abs(line.amount))<.005).map(d=>({kind:'doc',id:d.id}))];
}
function suggestion(b,line) {
  const rule=b.rules.find(r=>r.text&&String(line.desc||'').toLowerCase().includes(r.text.toLowerCase())&&(r.direction==='any'||(r.direction==='in')===(line.amount>0))&&acct(b,r.account));
  const k=words(line.desc), prev=k&&b.bankTxns.filter(x=>x.id!==line.id&&x.status==='added'&&x.cat&&words(x.desc)===k&&(x.amount>0)===(line.amount>0)).sort((a,b)=>(b.imported||0)-(a.imported||0))[0];
  const p=rule||(prev&&acct(b,prev.cat.account)&&prev.cat)||line.ai;
  return {kind:'category',account:p&&acct(b,p.account)?p.account:'',contactId:p?.contactId||'',cls:p?.cls||'',tags:Array.isArray(p?.tags)?p.tags:[],tax:p?.tax==='gst'?'gst':p?.tax?'std':'none',confidence:rule?'high':prev?'medium':p?.confidence||'low',reason:rule?`Bank rule: ${rule.text}`:prev?'Similar previous payee; verify category and tax.':p?.reason||'Choose a category and verify sales tax.'};
}
function prepare(s) {
  if(!cfg(s).on)return {count:0};
  const b=books(s), snapshot=basis(s), sources=[], used=new Set();
  const rejectedReceipts=new Set(s.list(COL).filter(d=>d.status==='rejected'&&d.receiptId).map(d=>d.receiptId));
  for(const line of b.bankTxns.filter(x=>x.status==='new')) {
    const candidates=b.receipts.filter(r=>freeReceipt(r)&&!rejectedReceipts.has(r.id)&&r.draft&&!r.draft.currency&&line.amount<0&&Math.abs(+r.draft.total+line.amount)<.005&&gap(r.draft.date,line.date)<=10);
    const unique=candidates.length===1&&b.bankTxns.filter(x=>x.status==='new'&&x.amount<0&&Math.abs(+candidates[0].draft.total+x.amount)<.005&&gap(candidates[0].draft.date,x.date)<=10).length===1;
    const receipt=unique?candidates[0]:null, m=matches(b,line,s), a=acct(b,line.account), warnings=[];
    if(receipt)used.add(receipt.id);
    if(!a||a.currency)warnings.push('Foreign currency or missing bank account: resolve in Banking.');
    if(m.length>1)warnings.push('Multiple existing transactions or bills may match: resolve in Banking.');
    if(candidates.length&&!unique)warnings.push('Ambiguous receipt match: resolve in Receipts.');
    let proposal=m.length===1?{kind:'match',target:m[0],confidence:'medium',reason:'Amount matches an existing entry or open document. Verify the payee and date.'}:suggestion(b,line);
    if(proposal.kind==='category'&&!proposal.account&&receipt?.draft?.lines?.length===1){
      const d=receipt.draft;proposal={...proposal,account:d.lines[0].account||'',contactId:d.vendorId||'',confidence:d.confidence||'low',reason:d.reason||'Receipt category; verify sales tax.',tax:'none'};
    }
    sources.push({id:`bank:${line.id}`,bankId:line.id,receiptId:receipt?.id||'',title:line.desc||'',date:line.date,amount:line.amount,proposal,warnings});
  }
  for(const r of b.receipts.filter(r=>freeReceipt(r)&&!used.has(r.id))) sources.push({id:`receipt:${r.id}`,bankId:'',receiptId:r.id,title:r.draft?.vendorName||r.fileName,date:r.draft?.date||'',amount:-(+r.draft?.total||0),proposal:{kind:'receipt',confidence:r.draft?.confidence||'low',reason:'Needs receipt review.'},warnings:[r.draft?'No unique bank match. Use Receipts to record an unpaid bill, choose a payment account or attach to an existing entry.':r.readError||'Receipt reading pending or disabled. Open Receipts to review.']});
  const active=new Set(sources.map(x=>x.id));
  s.transaction(()=>{
    for(const src of sources){const old=s.get(COL,src.id);if(old&&['approved','rejected'].includes(old.status))continue;
      if(old?.edited&&old.basis===snapshot)continue;
      const next={...src,basis:snapshot,status:'pending',version:old?.version||0,history:old?.history||[],preparedAt:old?.preparedAt||Date.now()};
      if(!old||hash([old.basis,old.proposal,old.warnings,old.receiptId])!==hash([snapshot,next.proposal,next.warnings,next.receiptId]))next.version++;
      s.put(COL,src.id,next);
    }
    for(const old of s.list(COL))if(old.status==='pending'&&!active.has(old.id))s.put(COL,old.id,{...old,status:'obsolete',version:old.version+1});
  });return {count:sources.length};
}
function taxes(s,amount,code,into){
  if(!['none','std','gst'].includes(code))fail('Choose a supported tax code.',400);
  const c=s.getSetting('company')||{}, accounts=s.list('accounts'), by=k=>accounts.find(a=>a.detail===k&&a.active!==false)?.id;
  let ps=[{account:by('tax'),rate:+c.taxRate||0,name:c.taxName||'Sales tax'}];
  if(+c.qstRate)ps=[{account:by('tax'),rate:r2(c.taxRate-c.qstRate),name:'GST'},{account:by('qst'),rate:+c.qstRate,name:'QST'}];
  else if(+c.pstRate)ps=[{account:by('tax'),rate:r2(c.taxRate-c.pstRate),name:'GST'},{account:by('pst'),rate:+c.pstRate,name:c.pstName||'PST',nonrecoverable:true}];
  if(code==='gst'){if(!(+c.pstRate>0))fail('GST only requires PST settings.',400);ps=ps.slice(0,1);}
  const rate=ps.reduce((s,p)=>s+p.rate,0), pre=code==='none'?amount:r2(amount/(1+rate/100));let left=r2(amount-pre);
  ps=ps.map((p,i)=>{const v=i===ps.length-1?left:r2((amount-pre)*p.rate/(rate||1));left=r2(left-v);return {...p,amount:v};}).filter(p=>p.amount);
  if(ps.some(p=>!p.account))fail('Set up every sales tax payable account before approval.');
  return {pre,net:r2(pre+(into?0:ps.filter(p=>p.nonrecoverable).reduce((s,p)=>s+p.amount,0))),parts:ps.filter(p=>into||!p.nonrecoverable)};
}
function writes(s,d){
  if(!d.bankId||d.warnings.length)fail('Resolve the flagged item in Banking or Receipts first.');
  const b=books(s),line=b.bankTxns.find(x=>x.id===d.bankId),a=line&&acct(b,line.account),p=d.proposal;
  if(!line||line.status!=='new'||!a||a.currency)fail('The bank line is no longer available.');
  if(p.contactId&&!b.contacts.some(c=>c.id===p.contactId))fail('The vendor or customer no longer exists.',400);
  const amount=Math.abs(line.amount),into=line.amount>0,w=[];let id=`auto-${crypto.randomUUID()}`,entry,made=true;
  if(p.kind==='match'){
    const m=matches(b,line,s);if(m.length!==1||m[0].id!==p.target.id||m[0].kind!==p.target.kind)fail('The proposed match changed. Refresh.');
    if(p.target.kind==='entry'){entry=b.entries.find(x=>x.id===p.target.id);id=entry.id;made=false;entry={...entry,clear:{...entry.clear,[a.id]:'c'}};}
    else {const doc=b.docs.find(x=>x.id===p.target.id),ctl=b.accounts.find(x=>x.detail===(into?'ar':'ap'));if(!ctl)fail('The control account is missing.');
      entry={type:into?'payment':'billpayment',date:line.date,contactId:doc.contactId,applyTo:doc.id,amount,bank:a.id,memo:`Payment for ${doc.kind} ${doc.number||''}`,lines:[{account:into?a.id:ctl.id,debit:amount,credit:0},{account:into?ctl.id:a.id,debit:0,credit:amount}],clear:{[a.id]:'c'}};
    }
  }else{
    if(matches(b,line,s).length)fail('An existing transaction or bill may match. Refresh and resolve it.');
    const cat=acct(b,p.account);if(!cat||isBank(cat)||['ar','ap','tax','qst','pst'].includes(cat.detail))fail('Choose an active category excluding bank, receivable, payable and tax control accounts.',400);
    const t=taxes(s,amount,p.tax,into),lines=into?[{account:a.id,debit:amount,credit:0},{account:cat.id,debit:0,credit:t.net,taxCode:p.tax}]:[{account:cat.id,debit:t.net,credit:0,taxCode:p.tax},{account:a.id,debit:0,credit:amount}];
    for(const x of t.parts)lines.push({account:x.account,debit:into?0:x.amount,credit:into?x.amount:0,memo:x.name+(into?' collected':' paid')});
    entry={type:into?'deposit':'expense',date:line.date,memo:line.desc,ref:'',contactId:p.contactId||'',created:Date.now(),clear:{[a.id]:'c'},lines,form:{bank:a.id,lines:[{account:cat.id,desc:line.desc,amount:t.pre,taxCode:p.tax,tax:p.tax!=='none'}]}};
  }
  if(p.kind==='category'){
    const c=s.getSetting('company')||{};
    if(p.cls){if(!(c.classes||[]).some(x=>x.id===p.cls&&x.active!==false))fail('The suggested class is no longer active. Resolve in Banking.');entry.cls=p.cls;}
    if(p.tags?.length){if(p.tags.some(id=>!(c.tags||[]).some(t=>t.id===id)))fail('The suggested tags changed. Resolve in Banking.');entry.tags=p.tags;}
  }
  if(d.receiptId){const r=s.get('receipts',d.receiptId);if(!r||!freeReceipt(r)||entry.receiptId||b.receipts.some(r=>r.entryId===id))fail('The receipt or transaction is already linked.');entry.receiptId=r.id;w.push({op:'set',collection:'receipts',id:r.id,data:{...r,status:'done',entryId:id}});}
  w.unshift({op:'set',collection:'entries',id,data:entry});
  w.push({op:'set',collection:'bankTxns',id:line.id,data:{...line,status:p.kind==='match'?'matched':'added',entryId:id,made,...(p.kind==='category'?{cat:{account:p.account,contactId:p.contactId||'',tax:p.tax==='gst'?'gst':p.tax==='std'}}:{})}});
  return w;
}
function current(s,id,version){
  if(!cfg(s).on)fail('Automation is disabled for this company.');const d=s.get(COL,id);if(!d)fail('Draft not found.',404);
  if(d.status!=='pending'||d.version!==version)fail('This draft changed or was already decided. Refresh.');
  if(d.basis!==basis(s))fail('The source or books changed. Refresh and review the updated draft.');return d;
}
function edit(s,id,body,user){s.transaction(()=>{const d=current(s,id,body.version);if(d.proposal.kind!=='category')fail('Resolve this match in Banking or Receipts.');
  const next={...d,proposal:{...d.proposal,account:String(body.account||''),contactId:String(body.contactId||''),tax:String(body.tax||'none')},edited:true,version:d.version+1,history:[...d.history,{action:'edited',by:user.username,at:Date.now()}]};
  writes(s,next);s.put(COL,id,next);s.audit(user,'automation-edit',{id,summary:'Edited automation draft',before:d,after:next});
});}
function decide(s,id,body,user,apply){s.transaction(()=>{const d=current(s,id,body.version), action=body.action,reason=String(body.reason||'').trim().slice(0,500);
  if(!['approve','reject'].includes(action))fail('Choose approve or reject.',400);if(action==='reject'&&!reason)fail('Give a rejection reason.',400);
  let posted=[];if(action==='approve'){posted=writes(s,d);apply(posted);}
  const next={...d,status:action==='approve'?'approved':'rejected',version:d.version+1,history:[...d.history,{action,by:user.username,at:Date.now(),reason}],postedIds:posted.filter(x=>x.collection==='entries').map(x=>x.id)};
  s.put(COL,id,next);s.audit(user,'automation-'+action,{id,summary:`${action==='approve'?'Approved and posted':'Rejected'} automation draft${reason?': '+reason:''}`,before:d,after:next});
});}
module.exports={cfg,prepare,suggestion,basis,writes,edit,decide,COL};
