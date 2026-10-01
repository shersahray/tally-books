'use strict';
/* ---------- Receipts: snap on a phone, read by AI, matched, reviewed ----------
   Anyone on the company (including a client on their phone) can send a photo or PDF. If AI is on for
   the company, the server reads it in the background. Matching to transactions already in the books,
   to bank lines waiting for review, or to an unpaid bill happens here, live, so a receipt sent before
   the bank statement is imported still finds its match later. The bookkeeper approves each one. */
S.rc={show:'inbox',sending:'',busy:false};
const rcUrl=r=>coUrl('/api/files/'+encodeURIComponent(r.fileId));
const rcIsClient=()=>!!(ME&&ME.role==='client');
const rcDay=ms=>{const d=new Date(ms);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`};
const rcTitle=r=>(r.draft&&(contactName(r.draft.vendorId)||r.draft.vendorName))||r.fileName||'Receipt';

/* What this receipt could belong to, best first. */
function rcMatches(r){
  const d=r.draft;if(!d||!(d.total>0))return[];
  const amt=d.total,day=d.date||rcDay(r.uploadedAt||Date.now()),out=[];
  const taken=new Set(S.receipts.filter(x=>x.id!==r.id&&(x.entryId||x.docId)).flatMap(x=>[x.entryId,x.docId]).filter(Boolean));
  const near=(date,days)=>{const g=Math.abs(daysBetween(date,day));return g<=days?g:-1};
  for(const e of S.entries){
    if(taken.has(e.id)||e.receiptId||e.type==='invoice'||e.type==='bill')continue;
    const accts=[...new Set((e.lines||[]).map(l=>l.account).filter(id=>isBankAcct(acct(id))))];
    const hit=accts.find(id=>Math.abs(signedOn(e,id)+amt)<0.015);if(!hit)continue;
    const g=near(e.date,10);if(g<0)continue;
    out.push({kind:'entry',id:e.id,gap:g,date:e.date,type:TLABEL[e.type]||e.type,label:contactName(e.contactId)||e.memo||'',acct:hit});
  }
  for(const doc of S.docs){
    if(doc.kind!=='bill'||taken.has(doc.id)||doc.receiptId)continue;
    if(Math.abs((+doc.total||0)-amt)>=0.015)continue;
    const g=near(doc.date,30);if(g<0)continue;
    out.push({kind:'doc',id:doc.id,gap:g,date:doc.date,label:`${doc.number?'#'+doc.number+' · ':''}${contactName(doc.contactId)}`});
  }
  for(const b of S.bankTxns){
    if(b.status!=='new'||Math.abs(b.amount+amt)>=0.015)continue;
    const g=near(b.date,10);if(g<0)continue;
    out.push({kind:'bank',id:b.id,gap:g,date:b.date,label:b.desc,acct:b.account});
  }
  const rank={entry:0,doc:1,bank:2};
  return out.sort((x,y)=>x.gap-y.gap||rank[x.kind]-rank[y.kind]);
}

/* ---------- sending ---------- */
// Phone photos are made smaller (2,000 pixels on the long side) before they're sent: faster on mobile data,
// less storage, and cheaper for AI to read. PDFs go as they are.
async function rcShrink(file){
  if(file.type==='application/pdf'||/\.pdf$/i.test(file.name))return file;
  let url;
  try{
    url=URL.createObjectURL(file);
    const img=new Image();await new Promise((ok,no)=>{img.onload=ok;img.onerror=no;img.src=url});
    const k=Math.min(1,2000/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement('canvas');c.width=Math.round(img.naturalWidth*k);c.height=Math.round(img.naturalHeight*k);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    const blob=await new Promise(ok=>c.toBlob(ok,'image/jpeg',0.85));
    return blob?new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'}):file;
  }catch(e){return file}finally{if(url)URL.revokeObjectURL(url)}
}
async function rcSend(files){
  files=[...files];if(!files.length)return;
  let ok=0;
  for(let i=0;i<files.length;i++){
    S.rc.sending=files.length>1?`Sending ${i+1} of ${files.length}…`:'Sending…';renderMain();
    try{
      const f=await rcShrink(files[i]);
      if(f.size>10*1024*1024)throw new Error('That file is over 10 MB. Try a smaller photo or a shorter PDF.');
      await api('POST','/api/receipts',{fileName:f.name,mediaType:f.type,data:await fileB64(f)});ok++;
    }catch(e){toast(e.message,true)}
  }
  S.rc.sending='';S.rc.show='inbox';await load();
  if(ok)toast(ok===1?(rcIsClient()?'Receipt sent to your bookkeeper':'Receipt added'):(rcIsClient()?`${ok} receipts sent to your bookkeeper`:`${ok} receipts added`));
}

/* ---------- list ---------- */
function rcStatus(r){
  if(r.status==='done')return `<span class="pill paid">Done</span>`;
  if(r.status==='discarded')return `<span class="pill quiet">Discarded</span>`;
  if(r.readStatus==='waiting'||r.readStatus==='reading')return `<span class="pill partial">Reading…</span>`;
  if(rcIsClient())return `<span class="pill open">Sent</span>`;
  if(r.readStatus==='failed')return `<span class="pill overdue">Couldn’t read</span>`;
  if(r.readStatus!=='read')return `<span class="pill open">To review</span>`;
  const m=rcMatches(r);
  return m.length?`<span class="pill paid">Match found</span>`:`<span class="pill open">To review</span>`;
}
function rcCard(r){
  const d=r.draft&&Array.isArray(r.draft.lines)?r.draft:null,img=r.mediaType!=='application/pdf';
  const thumb=img?`<img src="${rcUrl(r)}" alt="" loading="lazy">`:`<span class="pdf">PDF</span>`;
  const m=!rcIsClient()&&r.status==='inbox'&&r.readStatus==='read'?rcMatches(r)[0]:null;
  const linked=r.entryId?S.entries.find(e=>e.id===r.entryId):null,doc=r.docId?S.docs.find(x=>x.id===r.docId):null;
  return `<button class="rc-card" data-rc="${r.id}">
    <span class="rc-thumb">${thumb}</span>
    <span class="rc-body"><b translate="no">${esc(rcTitle(r))}</b>
      <span class="rc-meta">${d&&d.total?`<span class="amt">${money(d.total)}</span> · `:''}${d&&d.date?fmtDate(d.date):`Sent on ${fmtDate(rcDay(r.uploadedAt))}`}${!rcIsClient()&&r.uploadedByName?` · <span translate="no">${esc(r.uploadedByName)}</span>`:''}</span>
      ${r.note?`<span class="rc-note" translate="no">${esc(r.note)}</span>`:''}
      ${m?`<span class="rc-match">${m.kind==='bank'?'Bank line':m.kind==='doc'?'Unpaid bill':'Already recorded'}: <span translate="no">${esc(m.label)}</span> · ${fmtDate(m.date)}</span>`:''}
      ${linked?`<span class="rc-match"><span>${TLABEL[linked.type]||linked.type}</span> · ${fmtDate(linked.date)}</span>`:doc?`<span class="rc-match"><span>Bill</span>${doc.number?` <span translate="no">#${esc(doc.number)}</span>`:''} · ${fmtDate(doc.date)}</span>`:''}
      ${r.readStatus==='failed'&&!rcIsClient()?`<span class="rc-err">${esc(r.readError||'Reading failed.')}</span>`:''}
    </span>
    <span class="rc-status">${rcStatus(r)}</span></button>`;
}
function vReceipts(){
  const cl=rcIsClient(),ro=ME&&ME.readOnly,B=S.rc;
  const all=S.receipts.slice().sort((a,b)=>(b.uploadedAt||0)-(a.uploadedAt||0));
  const counts={inbox:0,done:0,discarded:0};all.forEach(r=>counts[r.status]=(counts[r.status]||0)+1);
  const tabs=cl?[['inbox','Sent'],['done','Done']]:[['inbox','To review'],['done','Done'],['discarded','Discarded']];
  if(!tabs.some(t=>t[0]===B.show))B.show='inbox';
  const rows=all.filter(r=>r.status===B.show);
  const snap=ro?'':`<div class="rc-snap">
      <label class="btn primary big ${B.sending?'disabled':''}"><input type="file" accept="image/*" capture="environment" data-rcfile hidden ${B.sending?'disabled':''}>${B.sending?esc(B.sending):'Take a photo of a receipt'}</label>
      <label class="btn big ${B.sending?'disabled':''}"><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple data-rcfile hidden ${B.sending?'disabled':''}>Choose photos or PDFs</label>
    </div>`;
  const help=cl?'Take a photo of each receipt or bill. It goes straight to your bookkeeper, who records it and keeps it with your books.'
    :(typeof aiOn==='function'&&aiOn()?'Receipts sent here, from your phone or your clients’, are read by AI and matched to your books. Review each one to record it.':'Receipts sent here, from your phone or your clients’, wait for you to record them. Turn on AI suggestions in Settings to have them read and matched automatically.');
  return head('Receipts',esc(help))+snap+`<div class="tabs" role="tablist">${tabs.map(([k,v])=>`<button role="tab" data-rcshow="${k}" aria-selected="${B.show===k}">${v} (${counts[k]||0})</button>`).join('')}</div>
    <div class="rc-list">${rows.length?rows.map(rcCard).join(''):`<div class="panel"><div class="empty"><b>${B.show==='inbox'?(cl?'Nothing sent yet':'No receipts to review'):'Nothing here yet'}</b>${B.show==='inbox'?(cl?'Receipts you send appear here until your bookkeeper records them.':'Receipts you or your clients send appear here.'):''}</div></div>`}</div>`;
}

/* ---------- review ---------- */
function rcModal(r){
  const cl=rcIsClient(),d=r.draft&&Array.isArray(r.draft.lines)?r.draft:null,img=r.mediaType!=='application/pdf';
  const own=r.uploadedBy===(ME&&ME.username)&&r.status==='inbox'&&!r.entryId&&!r.docId&&!r.wasAttached;
  const pic=img?`<a href="${rcUrl(r)}" target="_blank" rel="noopener" class="rc-big"><img src="${rcUrl(r)}" alt="Receipt"></a>`:`<a class="btn" href="${rcUrl(r)}" target="_blank" rel="noopener">Open the PDF</a>`;
  let info='';
  if(d){
    const conf={high:'High',medium:'Medium',low:'Low'}[d.confidence]||'Low';
    info=`<table class="boxes"><tbody>
      <tr><td>Vendor</td><td translate="no">${esc(contactName(d.vendorId)||d.vendorName||'')}</td></tr>
      <tr><td>Date</td><td>${d.date?fmtDate(d.date):''}</td></tr>
      ${d.number?`<tr><td>Receipt or invoice no.</td><td translate="no">${esc(d.number)}</td></tr>`:''}
      ${d.lines.map(l=>`<tr><td translate="no">${esc(l.description)}</td><td class="n">${money(l.amount)}${l.account?` <span class="muted">· ${esc(acctName(l.account))}</span>`:''}</td></tr>`).join('')}
      ${d.taxes.map(t=>`<tr><td translate="no">${esc(t.name)}</td><td class="n">${money(t.amount)}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="n">${money(d.total)}${d.currency&&d.currency!=='CAD'?` <span translate="no">${esc(d.currency)}</span>`:''}</td></tr>
    </tbody></table>${cl?'':`<div class="muted" style="font-size:12.5px;margin-top:6px"><span>Read by AI · ${conf} confidence</span>${d.paid?'':' <span>· Not paid yet</span>'}${d.reason?` · <span translate="no">${esc(d.reason)}</span>`:''}</div>`}`;
  }else if(r.readStatus==='waiting'||r.readStatus==='reading')info='<div class="muted">AI is reading this receipt…</div>';
  else if(!cl)info=`<div class="muted">${r.readStatus==='failed'?`<span>${esc(r.readError||'Reading failed.')}</span>`:`<span>Not read by AI.</span>${r.readError?` <span>${esc(r.readError)}</span>`:''}`}</div>`;

  let acts='';
  if(!cl&&r.status==='inbox'){
    const ms=d?rcMatches(r):[];
    acts=ms.length?`<div class="rc-matches"><span class="flabel">Matches in your books</span>${ms.slice(0,4).map(m=>`<div class="rc-m"><span><b>${m.kind==='bank'?'Bank line waiting for review':m.kind==='doc'?'Unpaid bill':'Already recorded'}</b><br>${m.type?`<span>${esc(m.type)}</span> · `:''}<span translate="no">${esc(m.label)}</span> · ${fmtDate(m.date)}${m.acct?` · ${esc(acctName(m.acct))}`:''}</span>
      <button type="button" class="btn sm primary" data-rcuse="${m.kind}:${m.id}">${m.kind==='bank'?'Record and match':m.kind==='doc'?'Attach to bill':'Attach'}</button></div>`).join('')}</div>`
      :(d?`<div class="muted" style="font-size:13px">No matching transaction or bank line yet. If the bank statement isn’t imported yet, the match shows up once it is.</div>`:'');
  }
  const note=cl&&own||!cl&&r.status==='inbox'?`<div class="field"><label for="rcNote">Note</label><input type="text" id="rcNote" maxlength="500" value="${esc(r.note||'')}" placeholder="${cl?'For example: lunch with a client':'A note about this receipt'}"></div>`:(r.note?`<div class="muted" translate="no">${esc(r.note)}</div>`:'');
  const sent=`<div class="muted" style="font-size:12.5px">Sent ${fmtDate(rcDay(r.uploadedAt))}${r.uploadedByName?` by <span translate="no">${esc(r.uploadedByName)}</span>`:''}</div>`;
  const linked=r.entryId?S.entries.find(e=>e.id===r.entryId):null,doc=r.docId?S.docs.find(x=>x.id===r.docId):null;
  const body=`<div class="rc-review"><div class="rc-pic">${pic}</div><div class="rc-side">${info}${acts}${note}${sent}</div></div>`;
  let foot='';
  if(cl)foot=`${own?'<button type="button" class="btn danger left" data-rcdel>Delete</button>':'<span class="left"></span>'}${own?'<button type="button" class="btn" data-rcsavenote>Save note</button>':''}<button type="button" class="btn primary" data-close>Done</button>`;
  else if(r.status==='inbox')foot=`${r.entryId||r.docId?'<span class="left"></span>':'<button type="button" class="btn danger left" data-rcdel>Delete</button>'}<button type="button" class="btn" data-rcdiscard>Discard</button>${typeof aiOn==='function'&&aiOn()&&r.readStatus!=='reading'?`<button type="button" class="btn" data-rcread>${d?'Read again':'Read with AI'}</button>`:''}<button type="button" class="btn" data-rcrecord="bill">Record as bill</button><button type="button" class="btn primary" data-rcrecord="expense">Record as expense</button>`;
  else foot=`${linked?'<button type="button" class="btn left" data-rcopen>Open transaction</button>':doc?'<button type="button" class="btn left" data-rcopen>Open bill</button>':'<span class="left"></span>'}${r.status==='discarded'?'<button type="button" class="btn" data-rcrestore>Move back to review</button>':''}<button type="button" class="btn primary" data-close>Done</button>`;
  const f=openModal(rcTitle(r),body,foot,'wide');
  const noteVal=()=>{const n=$('#rcNote',f);return n?n.value.trim():r.note||''};
  const save=async(patch,msg)=>{if(await put('receipts',r.id,{...strip(r),...patch,note:noteVal()})){closeModal();if(msg)toast(msg)}};
  const on=(sel,fn)=>{const b=$(sel,f);if(b)b.onclick=fn};
  on('[data-rcsavenote]',()=>save({},'Note saved'));
  on('[data-rcdel]',async()=>{if(!await confirmBox('Delete this receipt?','The photo is removed too.'))return;if(await del('receipts',r.id)){closeModal();toast('Receipt deleted')}});
  on('[data-rcdiscard]',()=>save({status:'discarded'},'Receipt discarded'));
  on('[data-rcrestore]',()=>save({status:'inbox'},'Moved back to review'));
  on('[data-rcread]',async()=>{try{await api('POST',`/api/receipts/${encodeURIComponent(r.id)}/read`);closeModal();await load();toast('AI is reading the receipt')}catch(e){toast(e.message,true)}});
  on('[data-rcopen]',()=>{closeModal();if(linked)openEntry(linked);else if(doc)docForm('bill',doc)});
  $$('[data-rcrecord]',f).forEach(b=>b.onclick=()=>rcRecord(r,b.dataset.rcrecord,null,noteVal()));
  $$('[data-rcuse]',f).forEach(b=>b.onclick=async()=>{
    const[kind,id]=b.dataset.rcuse.split(':');
    if(kind==='bank'){const bt=S.bankTxns.find(x=>x.id===id);return rcRecord(r,'expense',bt,noteVal())}
    if(kind==='entry'){const e=S.entries.find(x=>x.id===id);if(!e)return;
      if(await batch([{op:'set',collection:'entries',id:e.id,data:{...e,receiptId:r.id}},{op:'set',collection:'receipts',id:r.id,data:{...strip(r),status:'done',entryId:e.id,note:noteVal()}}])){closeModal();toast('Receipt attached')}}
    if(kind==='doc'){const x=S.docs.find(y=>y.id===id);if(!x)return;
      if(await batch([{op:'set',collection:'docs',id:x.id,data:{...x,receiptId:r.id}},{op:'set',collection:'receipts',id:r.id,data:{...strip(r),status:'done',docId:x.id,note:noteVal()}}])){closeModal();toast('Receipt attached to the bill')}}
  });
}
// Open the expense or bill form filled in from the receipt. Saving it attaches the receipt, and
// (when it came from a bank line) matches that bank line too.
function rcRecord(r,kind,bankLine,note){
  closeModal();
  const d=r.draft||{paid:kind==='expense',vendorName:'',vendorId:'',date:'',dueDate:'',number:'',currency:'',lines:[],taxes:[],total:0,confidence:'low',reason:''};
  const onSaved=async id=>{
    const w=[{op:'set',collection:'receipts',id:r.id,data:{...strip(S.receipts.find(x=>x.id===r.id)||r),status:'done',[kind==='bill'?'docId':'entryId']:id,note}}];
    const b=bankLine&&S.bankTxns.find(x=>x.id===bankLine.id&&x.status==='new');
    const e=S.entries.find(x=>x.id===id);
    if(b&&e&&Math.abs(signedOn(e,b.account)-b.amount)<0.005){
      w.push({op:'set',collection:'entries',id:e.id,data:{...e,clear:{...(e.clear||{}),[b.account]:'c'}}});
      w.push({op:'set',collection:'bankTxns',id:b.id,data:{...b,status:'matched',entryId:e.id,made:false}});
    }
    if(await batch(w))toast(w.length>1?'Saved, with the receipt attached and the bank line matched':'Saved, with the receipt attached');
  };
  aiOpenDraft({...d,paid:kind==='expense',date:bankLine?bankLine.date:d.date},r.fileName,{receiptId:r.id,onSaved,bank:bankLine?bankLine.account:'',noAI:!r.draft});
}

function rcClick(e,t,d){
  if(d.rcshow){S.rc.show=d.rcshow;renderMain();return true}
  if(d.rc){const r=S.receipts.find(x=>x.id===d.rc);if(r)rcModal(r);return true}
  return false;
}
function bindReceipts(m){
  $$('[data-rcfile]',m).forEach(inp=>inp.onchange=()=>{const fs=[...inp.files];inp.value='';if(fs.length)rcSend(fs)});
}
// A small "View receipt" link for transaction and bill forms.
function rcLinkFor(x){const r=x&&x.receiptId&&S.receipts.find(y=>y.id===x.receiptId);return r?`<a class="btn sm" href="${rcUrl(r)}" target="_blank" rel="noopener">View receipt</a>`:''}
