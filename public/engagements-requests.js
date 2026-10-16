'use strict';
/* ---------- Year-end files: requests to the client, and the client's approval ----------
 * Staff list what they need for a year-end (the December bank statement, a loan statement, shareholder loan details…).
 * The client sees the list under Requests, answers each one and uploads files from the web or the phone app; each file
 * lands on the request's working paper. Staff accept or return each answer. Draft statements (and the representation
 * letter) can be sent the same way for the client to approve. The server stamps who did what (app.js).
 */
const YF_REQ_STATUS={open:'Waiting for the client',sent:'Answered by the client',accepted:'Accepted',returned:'Sent back to the client'};
// The usual requests for a compilation, each on its working paper.
const YF_PBC=[
  ['A','Bank statements for every account for the last month of the year (and the first month after)'],
  ['FF','Statements for each loan or line of credit at the year-end'],
  ['GG','Details of amounts paid to or received from shareholders during the year'],
  ['G','Invoices for equipment, vehicles or other assets bought in the year, and details of any sold'],
  ['D','Inventory count at the year-end, with costs'],
  ['RP','Transactions with related companies or family members during the year'],
  ['SUB','Anything important after the year-end: new loans, lawsuits, large purchases or sales'],
  ['GEN','Minute book updates and any changes in ownership'],
];
const yfReqs=f=>S.requests.filter(r=>r.engagementId===f.id).sort((a,b)=>(a.created?a.created.at:0)-(b.created?b.created.at:0));
const yfReqFiles=r=>S.attachments.filter(a=>a.target==='requests'&&a.targetId===r.id);
const yfReqPill=r=>`<span class="pill ${r.status==='accepted'?'paid':r.status==='sent'?'open':r.status==='returned'?'overdue':'partial'}">${esc(T(YF_REQ_STATUS[r.status]))}</span>`;
const yfFileLinks=list=>list.map(a=>`<a href="${esc(coUrl('/api/files/'+a.fileId))}" target="_blank" rel="noopener">${esc(a.name)}</a>`).join(' · ');

/* ---------- staff: the Client requests tab ---------- */
function yfRequests(f,edit){
  const list=yfReqs(f),open=list.filter(r=>r.status==='open'||r.status==='returned').length;
  const ap=list.filter(r=>r.kind==='approval').slice(-1)[0];
  let h='';
  if(ap&&ap.approval)h+=`<div class="banner" style="background:${ap.approval.approved?'var(--info-soft)':'var(--warn-soft)'}"><span>${ap.approval.approved?'<span class="pos">✓</span> '+esc(T('The client approved the draft statements')):esc(T('The client didn’t approve the draft statements'))} · ${yfStamp(ap.approval)}${ap.clientNote?' · “'+esc(ap.clientNote)+'”':''}</span></div>`;
  const rows=list.map(r=>`<tr><td style="width:44px">${r.wp?`<button class="link" data-yfgowp="${esc(r.wp)}">${esc(r.wp)}</button>`:''}</td><td>${r.kind==='approval'?'<span class="pill quiet">'+esc(T('Approval'))+'</span> ':''}${esc(r.text)}${r.due?`<div class="muted" style="font-size:12px">${esc(T('By'))} ${esc(fmtDate(r.due))}</div>`:''}${r.clientNote?`<div style="font-size:12.5px">${esc(T('Client'))}: “${esc(r.clientNote)}”</div>`:''}${yfReqFiles(r).length?`<div style="font-size:12.5px">${yfFileLinks(yfReqFiles(r))}</div>`:''}${r.staffNote?`<div class="muted" style="font-size:12px">${esc(T('Note to the client'))}: ${esc(r.staffNote)}</div>`:''}</td><td>${yfReqPill(r)}<div class="muted" style="font-size:12px">${r.sent?esc(T('Answered'))+' '+yfStamp(r.sent):''}${r.decided?'<br>'+esc(T(YF_REQ_STATUS[r.status]))+' '+yfStamp(r.decided):''}</div></td><td class="n" style="white-space:nowrap">${edit?`${r.status==='sent'?`<button class="btn sm" data-yfreqdo="accepted" data-id="${esc(r.id)}">${esc(T('Accept'))}</button><button class="btn sm" data-yfreqdo="returned" data-id="${esc(r.id)}">${esc(T('Send back'))}</button>`:''}<button class="btn sm" data-yfreqedit="${esc(r.id)}">${esc(T('Edit'))}</button>`:''}</td></tr>`).join('');
  h+=`<div class="panel"><div class="toolbar" style="flex-wrap:wrap"><span class="grow muted">${esc(T('The client sees these under Requests, answers each one and sends files from the web or the Sumlora phone app. Files go straight onto the working paper.'))}</span>${edit?`${list.some(r=>r.kind==='document')?'':`<button class="btn sm" data-yfreqpbc>${esc(T('Add the usual requests'))}</button>`}<button class="btn sm" data-yfreqedit="new">+ ${esc(T('Request'))}</button><button class="btn sm" data-yfreqapprove>${esc(T('Send draft statements for approval'))}</button>${open?`<button class="btn primary sm" data-yfreqnotify>${esc(T('Email the client'))}</button>`:''}`:''}</div><div class="tbl-wrap"><table><thead><tr><th>WP</th><th>${esc(T('Request'))}</th><th>${esc(T('Status'))}</th><th></th></tr></thead><tbody>${rows||emptyRow(4,'No requests yet','Add the usual requests for a compilation, or your own.')}</tbody></table></div></div>`;
  return h;
}
function yfReqForm(f,r){
  const wps=TallyEngage.workingPapers(f,S.accounts);
  const m=openModal(r?'Request':'New request',`<div class="fields">${fld('yqWp','Working paper',`<select id="yqWp"><option value="">${esc(T('The whole file'))}</option>${wps.map(w=>`<option value="${esc(w.code)}" ${r&&r.wp===w.code?'selected':''}>${esc(w.code+' · '+T(w.label))}</option>`).join('')}</select>`)}${fld('yqDue','Needed by',`<input type="date" id="yqDue" value="${esc(r?r.due:'')}">`)}${fld('yqText','What you need',`<textarea id="yqText" rows="3" maxlength="2000">${esc(r?r.text:'')}</textarea>`,true)}${fld('yqNote','Note to the client',`<textarea id="yqNote" rows="2" maxlength="2000">${esc(r?r.staffNote:'')}</textarea>`,true)}</div>`,
    `${r?'<button type="button" class="btn danger" data-yqdel>Delete</button>':''}<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`);
  const d=$('[data-yqdel]',m);if(d)d.onclick=async()=>{if(await confirmBox('Delete this request?','The client won’t see it any more. Files already on the working paper stay there.')&&await del('requests',r.id))closeModal()};
  m.onsubmit=async e=>{e.preventDefault();const text=$('#yqText',m).value.trim();if(!text)return m.err('Say what you need from the client.');
    if(await put('requests',r?r.id:uid(),{...(r||{}),engagementId:f.id,kind:r?r.kind:'document',wp:$('#yqWp',m).value,due:$('#yqDue',m).value,text,staffNote:$('#yqNote',m).value.trim(),status:r?r.status:'open'}))closeModal()};
}
async function yfReqUpload(r,files){
  let n=0;
  for(const file of files){
    if(file.size>10*1024*1024){toast(`${file.name} is over 10 MB.`,true);continue}
    const data=await new Promise((res,rej)=>{const x=new FileReader();x.onload=()=>res(String(x.result).split(',')[1]||'');x.onerror=rej;x.readAsDataURL(file)});
    try{await api('POST',`/api/requests/${encodeURIComponent(r.id)}/files`,{fileName:file.name,data});n++}catch(err){toast(`${file.name}: ${err.message}`,true)}
  }
  if(n){await load();toast(n===1?'File sent':`${n} files sent`)}
}
/** Send the draft statements (and the representation letter) to the client to approve. */
async function yfSendForApproval(f){
  if(!await confirmBox('Send the draft statements for approval?','The client sees a request with the draft statements and the representation letter, and can approve them or send a question. Their answer is recorded with their name and the time.','Send'))return;
  await yfLoadLogo();
  const id=uid();
  if(!await put('requests',id,{engagementId:f.id,kind:'approval',wp:'GEN',text:`Please review the draft financial statements for the year ended ${fmtDate(f.yearEnd)} and the representation letter, then approve them or tell us what to change.`,status:'open'}))return;
  const toB64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(s)};
  try{
    await api('POST',`/api/requests/${id}/files`,{fileName:`Draft financial statements ${f.yearEnd}.pdf`,data:toB64(yfPdf(f))});
    const L=yfLetter(f,'representation'),doc=TallyPDF.create(),W0=doc.width,H0=doc.height,M=64;let y=M;
    for(const line of doc.wrap(L.text,W0-2*M,10.5)){if(y>H0-M){doc.addPage();y=M}doc.text(M,y,line,{size:10.5});y+=15}
    await api('POST',`/api/requests/${id}/files`,{fileName:`Representation letter ${f.yearEnd}.pdf`,data:toB64(doc.output())});
  }catch(err){toast(err.message,true)}
  await load();toast('Sent to the client for approval');
}
async function yfRequestsClick(e,t,d,f){
  if(d.yfreqedit){yfReqForm(f,d.yfreqedit==='new'?null:S.requests.find(x=>x.id===d.yfreqedit));return true}
  if(t.hasAttribute('data-yfreqpbc')){const w=[];for(const [wp,text] of YF_PBC)w.push({op:'set',collection:'requests',id:uid(),data:{engagementId:f.id,kind:'document',wp,text,status:'open',due:addDays(f.yearEnd,45)}});if(await batch(w))toast(`${w.length} requests added. Edit or delete any that don’t apply, then email the client.`);return true}
  if(d.yfreqdo){const r=S.requests.find(x=>x.id===d.id);if(!r)return true;let note=r.staffNote;
    if(d.yfreqdo==='returned'){note=prompt(T('What should the client fix or add?'),'')||'';if(!note)return true}
    await put('requests',r.id,{...r,status:d.yfreqdo,staffNote:note});return true}
  if(t.hasAttribute('data-yfreqapprove')){await yfSendForApproval(f);return true}
  if(t.hasAttribute('data-yfreqnotify')){try{const r=await api('POST',`/api/engagements/${encodeURIComponent(f.id)}/notify`);toast(`Emailed ${r.sent} client user${r.sent===1?'':'s'}`)}catch(err){toast(err.message,true)}return true}
  return false;
}

/* ---------- the client's side: Requests ---------- */
const yfReqOn=()=>feat('yearEndFiles')&&S.requests.length>0;
function vRequests(){
  const client=ME&&ME.role==='client';
  const list=S.requests.slice().sort((a,b)=>(['open','returned','sent','accepted'].indexOf(a.status)-['open','returned','sent','accepted'].indexOf(b.status))||(a.due||'9').localeCompare(b.due||'9'));
  const can=!(ME&&ME.readOnly);
  const card=r=>{const files=yfReqFiles(r),done=r.status==='accepted'||(r.kind==='approval'&&!!r.approval);
    return `<div class="panel" style="margin-bottom:12px"><div class="pad" style="display:grid;gap:8px">
      <div style="display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap"><div><b>${esc(r.text)}</b><div class="muted" style="font-size:12.5px">${esc(T('Year-end'))} ${esc(fmtDate(r.yearEnd))}${r.due?' · '+esc(T('needed by'))+' '+esc(fmtDate(r.due)):''}</div></div>${yfReqPill(r)}</div>
      ${r.staffNote?`<div class="banner" style="margin:0"><span>${esc(T(r.status==='returned'?'Your accountant asks':'Note from your accountant'))}: ${esc(r.staffNote)}</span></div>`:''}
      ${files.length?`<div style="font-size:13px">${esc(T('Files'))}: ${yfFileLinks(files)}</div>`:''}
      ${r.kind==='approval'&&r.approval?`<div style="font-size:13px">${r.approval.approved?'<span class="pos">✓</span> '+esc(T('Approved')):esc(T('Not approved'))} · ${yfStamp(r.approval)}</div>`:''}
      ${can&&!done?`<label style="display:grid;gap:4px"><span class="flabel">${esc(T(r.kind==='approval'?'Questions or changes (optional)':'Note for your accountant (optional)'))}</span><textarea data-rqnote="${esc(r.id)}" rows="2" maxlength="2000">${esc(r.clientNote||'')}</textarea></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${r.kind==='approval'?`<button class="btn primary sm" data-rqapprove="${esc(r.id)}">${esc(T('I approve'))}</button><button class="btn sm" data-rqreject="${esc(r.id)}">${esc(T('I have changes'))}</button>`:`<label class="btn sm">${esc(T('Add files…'))}<input type="file" data-rqfiles="${esc(r.id)}" hidden multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.docx"></label><button class="btn primary sm" data-rqsend="${esc(r.id)}">${esc(T(r.status==='sent'?'Send again':'Send to my accountant'))}</button>`}</div>`:''}
    </div></div>`};
  return head('Requests',client?'What your accountant needs from you for the year-end. Send files from here or from the Sumlora app on your phone.':'Requests to the client from the year-end files.')+(list.map(card).join('')||`<div class="empty"><b>${esc(T('No requests'))}</b></div>`);
}
async function rqClick(e,t,d){
  const r=id=>S.requests.find(x=>x.id===id),note=id=>{const x=$(`[data-rqnote="${id}"]`);return x?x.value:''};
  if(d.rqsend){const x=r(d.rqsend);if(!yfReqFiles(x).length&&!note(x.id).trim()&&!await confirmBox('Send without a file?','Your accountant asked for a document. Send anyway, with no file or note?','Send'))return true;
    if(await put('requests',x.id,{...x,clientNote:note(x.id),status:'sent'}))toast('Sent to your accountant');return true}
  if(d.rqapprove||d.rqreject){const x=r(d.rqapprove||d.rqreject),ok=!!d.rqapprove;
    if(!ok&&!note(x.id).trim()){toast('Write what should change.',true);return true}
    if(ok&&!await confirmBox('Approve the draft statements?','You confirm you’ve read the draft financial statements and the representation letter, and they’re right to the best of your knowledge.','I approve'))return true;
    if(await put('requests',x.id,{...x,clientNote:note(x.id),approval:{approved:ok}}))toast(ok?'Approved. Thank you.':'Sent to your accountant');return true}
  return false;
}
function rqBind(m){$$('[data-rqfiles]',m).forEach(inp=>inp.onchange=()=>{const files=[...inp.files];inp.value='';const x=S.requests.find(y=>y.id===inp.dataset.rqfiles);if(x&&files.length)yfReqUpload(x,files)})}

/* ---------- Sumlora's own reports, attached to the working papers ---------- */
/**
 * Reports Sumlora already has for the year-end, made as PDFs and put on their working papers, so nobody has to ask the
 * client for them: the A/R and A/P listings by customer and vendor at the year-end, the bank reconciliation summary, and
 * the sales tax returns filed for the year. Attached again (replacing the earlier copy) whenever asked.
 */
function yfReportPdfs(f){
  const ye=f.yearEnd,fy=fyStartOf(ye),out=[];
  if(f.snapshot.source&&f.snapshot.source!=='books')return out;
  const byDetail=d=>new Set(S.accounts.filter(a=>a.detail===d).map(a=>a.id));
  const contactName2=id=>(S.contacts.find(c=>c.id===id)||{}).name||T('No customer or vendor');
  // Listing by customer or vendor: the account's postings up to the year-end, by the transaction's contact.
  const listing=(ids,sign)=>{const m=new Map();for(const p of postings()){if(!ids.has(p.account)||p.date>ye)continue;const k=p.e.contactId||'';m.set(k,r2((m.get(k)||0)+sign*(p.debit-p.credit)))}
    return [...m].filter(([,v])=>Math.abs(v)>=0.005).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({cls:'item',label:contactName2(k),data:true,cells:[v]}))};
  const tot=rows=>({cls:'grand',label:'Total',cells:[r2(rows.reduce((t,r)=>t+r.cells[0],0))]});
  const ar=listing(byDetail('ar'),1);if(ar.length)out.push({wp:'C',name:`A-R listing ${ye} (Sumlora).pdf`,r:{title:'Accounts receivable by customer',sub:`As at ${fmtDate(ye)}`,head:['Balance'],rows:[...ar,tot(ar)]}});
  const ap=listing(byDetail('ap'),-1);if(ap.length)out.push({wp:'BB',name:`A-P listing ${ye} (Sumlora).pdf`,r:{title:'Accounts payable by vendor',sub:`As at ${fmtDate(ye)}`,head:['Balance'],rows:[...ap,tot(ap)]}});
  // Bank reconciliation summary for each bank and card account.
  const banks=S.accounts.filter(a=>a.detail==='bank'||a.detail==='card'),rows=[];
  for(const a of banks){
    let book=0,unclr=0,n=0;for(const p of postings()){if(p.account!==a.id||p.date>ye)continue;const v=p.debit-p.credit;book+=v;if(!(p.e.clear&&p.e.clear[a.id]==='r')){unclr+=v;n++}}
    if(Math.abs(book)<0.005&&!n)continue;
    const rec=S.recons.filter(r=>r.account===a.id&&r.statementDate<=addDays(ye,40)).sort((x,y)=>y.statementDate.localeCompare(x.statementDate))[0];
    rows.push({cls:'sec',label:(a.code?a.code+' ':'')+a.name,cells:['','']},{cls:'item',label:`Balance in the books at ${fmtDate(ye)}`,cells:[r2(book),'']},{cls:'item',label:`Not yet reconciled at ${fmtDate(ye)} (${n} item${n===1?'':'s'})`,cells:[r2(unclr),'']},
      {cls:'item',label:rec?`Last reconciliation: statement of ${fmtDate(rec.statementDate)}`:'No reconciliation on file',cells:['',rec?+rec.endingBalance:'']});
  }
  if(rows.length)out.push({wp:'A',name:`Bank reconciliation summary ${ye} (Sumlora).pdf`,r:{title:'Bank reconciliation summary',sub:`As at ${fmtDate(ye)}`,head:['Books','Statement'],rows}});
  // Sales tax returns filed for periods in the year.
  const fil=S.filings.filter(x=>x.to>=fy&&x.from<=ye).sort((a,b)=>a.from.localeCompare(b.from));
  if(fil.length)out.push({wp:'CC',name:`Sales tax returns ${ye} (Sumlora).pdf`,r:{title:'Sales tax returns filed for the year',sub:`${fmtDate(fy)} – ${fmtDate(ye)}`,head:['Sales (101)','Tax collected (105)','Credits (108)','Net (109)'],
    rows:fil.map(x=>({cls:'item',data:true,label:`${x.tax==='qst'?'QST':x.tax==='pst'?'PST':'GST/HST'} ${fmtDate(x.from)} – ${fmtDate(x.to)}, filed ${fmtDate(x.filedOn)}`,cells:['101','105','108','109'].map(k=>x.lines&&x.lines[k]!==undefined&&x.lines[k]!==''?+x.lines[k]:'')}))}});
  return out;
}
async function yfAttachReports(f,quiet){
  const list=yfReportPdfs(f);if(!list.length){if(!quiet)toast('No Sumlora reports to attach for this year-end');return}
  const toB64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(s)};
  let n=0;
  for(const x of list){
    for(const old of S.attachments.filter(a=>a.target==='engagements'&&a.targetId===f.id&&a.name===x.name))try{await api('DELETE',`/api/records/attachments/${encodeURIComponent(old.id)}`)}catch(e){}
    try{await api('POST','/api/attachments',{target:'engagements',targetId:f.id,wp:x.wp,fileName:x.name,data:toB64(reportsPdf([x.r]))});n++}catch(err){if(!quiet)toast(err.message,true)}
  }
  await load();if(!quiet||n)toast(`${n} Sumlora report${n===1?'':'s'} attached to the working papers`);
}
