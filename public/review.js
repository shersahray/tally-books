'use strict';
/* ---------- Accountant tools: attachments, bulk reclassify, the Review page, questions to the client ---------- */

/* ---------- attachments ----------
   PDFs and photos on any saved transaction, invoice or bill. Shown at the bottom of its form, with questions. */
const kb=n=>n<1024*1024?`${Math.max(1,Math.round(n/1024))} KB`:`${(n/1024/1024).toFixed(1)} MB`;
const fileUrl=id=>`/api/c/${encodeURIComponent(CO)}/files/${encodeURIComponent(id)}`;
function extrasHTML(target,id){
  const staff=ME&&ME.role!=='client',files=S.attachments.filter(a=>a.target===target&&a.targetId===id);
  const qs=S.questions.filter(q=>q.target===target&&q.targetId===id&&q.status!=='resolved');
  return `<div class="extras" data-extras="${target}|${id}">
    <div class="extras-row"><span class="flabel">Attachments</span>
      ${files.map(a=>`<span class="att"><a href="${fileUrl(a.fileId)}" target="_blank" rel="noopener" translate="no">${esc(a.name)}</a><span class="muted">${kb(a.size)}</span>${staff&&!ME.readOnly?`<button type="button" class="link" data-attdel="${a.id}" aria-label="Remove ${esc(a.name)}">×</button>`:''}</span>`).join('')||'<span class="muted">None</span>'}
      ${staff&&!ME.readOnly?`<button type="button" class="btn sm ghost" data-attadd>Attach file</button><input type="file" data-attfile accept="application/pdf,image/jpeg,image/png,image/webp" multiple hidden>`:''}</div>
    <div class="extras-row"><span class="flabel">Questions</span>${qs.length?qs.map(q=>`<button type="button" class="link" data-qopen="${q.id}">${q.status==='answered'?'Answered':'Waiting for an answer'}: “${esc(q.thread[q.thread.length-1].text.slice(0,60))}”</button>`).join(' · '):'<span class="muted">None open</span>'}
      ${ME&&!ME.readOnly?`<button type="button" class="btn sm ghost" data-qask>${staff?'Ask the client':'Ask your bookkeeper'}</button>`:''}</div>
  </div>`;
}
/** Add the attachments and questions strip to the form that's open, for a saved record. */
function addExtras(target,id){
  const m=$('#modalRoot .modal .mbody');if(!m||!id||!S[target].some(x=>x.id===id))return;
  const old=$('[data-extras]',m);if(old)old.remove();
  m.insertAdjacentHTML('beforeend',extrasHTML(target,id));
  const box=$('[data-extras]',m);
  box.onclick=async e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-attadd')){$('[data-attfile]',box).click();return}
    if(b.dataset.attdel){const a=S.attachments.find(x=>x.id===b.dataset.attdel);if(!a||!await confirmBox('Remove this file?',a.name,'Remove'))return;if(await del('attachments',a.id)){addExtras(target,id);toast('File removed')}return}
    if(b.hasAttribute('data-qask')){askForm(target,id,()=>addExtras(target,id));return}
    if(b.dataset.qopen){questionView(b.dataset.qopen,()=>addExtras(target,id))}
  };
  const inp=$('[data-attfile]',box);
  if(inp)inp.onchange=async()=>{
    const files=[...inp.files];inp.value='';let ok=0,bad=false;
    for(const file of files){
      if(file.size>10*1024*1024){toast(`${file.name} is over 10 MB.`,true);bad=true;continue}
      try{await api('POST','/api/attachments',{target,targetId:id,fileName:file.name,data:await fileB64(file)});ok++}catch(err){toast(err.message,true);bad=true;break}
    }
    if(!ok)return;
    await load();addExtras(target,id);if(!bad)toast(ok===1?'File attached':'Files attached');
  };
}

/* ---------- questions ---------- */
/** A dialog over the one that's open (a question asked from inside a transaction keeps the transaction open). */
function subModal(title,body,foot){
  let r=$('#subRoot');if(!r){r=document.createElement('div');r.id='subRoot';document.body.appendChild(r)}
  r.innerHTML=`<div class="scrim" style="z-index:55"><form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" novalidate><header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header><div class="mbody">${body}<div class="err-msg" data-err></div></div><div class="mfoot">${foot}</div></form></div>`;
  const f=r.querySelector('form');
  const key=e=>{if(e.key==='Escape'){e.stopPropagation();f.close()}};
  f.close=()=>{r.innerHTML='';document.removeEventListener('keydown',key,true)};
  document.addEventListener('keydown',key,true);
  $$('[data-close]',f).forEach(b=>b.onclick=f.close);
  f.err=m=>{f.querySelector('[data-err]').textContent=m||''};
  setTimeout(()=>{const t=f.querySelector('textarea');t&&t.focus()},30);
  return f;
}
function askForm(target,id,after){
  const staff=ME.role!=='client';
  const f=subModal(staff?'Ask the client':'Ask your bookkeeper',`<div class="muted" style="font-size:13px">${staff?'The client sees the question under Questions, with the transaction, and can answer there.':'Your bookkeeper sees the question with the transaction.'}</div>
    ${fld('qText','Question',`<textarea id="qText" rows="4" maxlength="2000" placeholder="${staff?'e.g. What was this payment for? Do you have the receipt?':''}"></textarea>`,true)}`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Send</button>`);
  f.onsubmit=async e=>{e.preventDefault();const text=$('#qText',f).value.trim();if(!text)return f.err('Type your question.');
    try{await api('POST','/api/questions',{target,targetId:id,text});await load();f.close();toast('Question sent');after&&after()}catch(err){f.err(err.message)}};
}
const qTarget=q=>S[q.target]?.find(x=>x.id===q.targetId);
/** What the question is about, in the screen's language and format. */
function qLabel(q){
  const r=qTarget(q);if(!r)return q.label;
  if(q.target==='docs')return `${fmtDate(r.date)} · ${DOCL[r.kind]?.t||r.kind}${r.number?' #'+r.number:''} · ${contactName(r.contactId)} · ${money(r.total)}`;
  if(q.target==='bankTxns')return `${fmtDate(r.date)} · ${r.desc||''} · ${money(r.amount)}`;
  return `${fmtDate(r.date)} · ${TLABEL[r.type]||r.type}${r.ref?' #'+r.ref:''} · ${contactName(r.contactId)||r.memo||''} · ${money(entryTotal(r))}`;
}
function questionView(qid,after){
  const q=S.questions.find(x=>x.id===qid);if(!q)return;
  const staff=ME.role!=='client',rec=qTarget(q);
  const f=subModal('Question',`<div class="muted" style="font-size:13px" translate="no">${esc(qLabel(q))}</div>
    <div class="thread">${q.thread.map(m=>`<div class="msg ${m.role==='client'?'from-client':''}"><div class="who"><b translate="no">${esc(m.name)}</b> <span class="muted">${new Date(m.at).toLocaleString(LOC(),{dateStyle:'medium',timeStyle:'short'})}</span></div><div class="text">${esc(m.text)}</div></div>`).join('')}</div>
    ${q.status!=='resolved'&&!ME.readOnly?fld('qReply',staff?'Reply':'Your answer',`<textarea id="qReply" rows="3" maxlength="2000"></textarea>`,true):`<div class="pill paid" style="align-self:flex-start">Resolved</div>`}`,
    `${staff&&rec&&q.target!=='bankTxns'?'<button type="button" class="btn left" data-qgo>Open the transaction</button>':''}${staff&&!ME.readOnly?(q.status==='resolved'?'<button type="button" class="btn" data-qreopen>Reopen</button>':'<button type="button" class="btn" data-qresolve>Mark resolved</button>'):''}<button type="button" class="btn" data-close>Close</button>${q.status!=='resolved'&&!ME.readOnly?'<button type="submit" class="btn primary">Send</button>':''}`);
  const act=async p=>{try{await api('POST',`/api/questions/${encodeURIComponent(q.id)}/${p}`,{});await load();f.close();after&&after()}catch(err){f.err(err.message)}};
  const g=$('[data-qgo]',f);if(g)g.onclick=()=>{f.close();closeModal();q.target==='docs'?docForm(rec.kind,rec):openEntry(rec)};
  const rs=$('[data-qresolve]',f);if(rs)rs.onclick=()=>act('resolve');
  const ro=$('[data-qreopen]',f);if(ro)ro.onclick=()=>act('reopen');
  f.onsubmit=async e=>{e.preventDefault();const text=($('#qReply',f)||{}).value?.trim();if(!text)return f.err('Type your answer.');
    try{await api('POST',`/api/questions/${encodeURIComponent(q.id)}/reply`,{text});await load();f.close();toast('Sent');after&&after()}catch(err){f.err(err.message)}};
}
/** For the menu badge: questions waiting on this person. */
const questionsWaiting=()=>ME&&ME.role==='client'?S.questions.filter(q=>q.status==='open').length:S.questions.filter(q=>q.status==='answered').length;

/* ---------- bulk reclassify ----------
   Move amounts from one account to another on many transactions at once: the transaction lines, and the
   expense, deposit, invoice or bill they came from, so reopening one shows the new account. */
const SYS_DETAILS=['bank','card','ar','ap','tax','qst','payroll_cra','payroll_rq','payroll_other','vacation_payable','ob','wages','payroll_tax'];
const reclassOk=a=>a&&!SYS_DETAILS.includes(a.detail);
const NO_RECLASS=new Set(['payrun','payremit','taxpayment','qmadjust']);
function reclassForm(){
  const f0=S.tx,accts=a=>reclassOk(a)&&a.active!==false;
  const f=openModal('Reclassify transactions',`<div class="muted" style="font-size:13px">Move transactions from one account to another in one step, for example everything coded to Office supplies that should be Software. Bank, receivable, payable, sales tax and payroll accounts can’t be reclassified here.</div>
    <div class="fields">${fld('rcFrom','From account',`<select id="rcFrom"><option value="">Choose…</option>${acctOptions('',accts)}</select>`)}${fld('rcTo','To account',`<select id="rcTo"><option value="">Choose…</option>${acctOptions('',accts)}</select>`)}
      ${fld('rcD1','From date',`<input type="date" id="rcD1" value="${esc(f0.from||'')}">`)}${fld('rcD2','To date',`<input type="date" id="rcD2" value="${esc(f0.to||'')}">`)}
      ${fld('rcQ','Only those matching',`<input type="search" id="rcQ" value="${esc(f0.q||'')}" placeholder="Payee, memo or number (optional)">`,true)}</div>
    <div data-rclist></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" disabled>Reclassify</button>`,'wide');
  const btn=f.querySelector('[type=submit]');
  const matches=()=>{
    const from=$('#rcFrom',f).value,d1=$('#rcD1',f).value,d2=$('#rcD2',f).value,q=$('#rcQ',f).value.trim().toLowerCase();if(!from)return[];
    return S.entries.filter(e=>!NO_RECLASS.has(e.type)&&!e.opening&&(e.lines||[]).some(l=>l.account===from)&&(!d1||e.date>=d1)&&(!d2||e.date<=d2)&&(!q||[e.ref,e.memo,contactName(e.contactId),...(e.lines||[]).map(l=>l.memo||'')].join(' ').toLowerCase().includes(q)))
      .sort((a,b)=>b.date.localeCompare(a.date));
  };
  const amt=(e,id)=>r2((e.lines||[]).filter(l=>l.account===id).reduce((s,l)=>s+(+l.debit||0)-(+l.credit||0),0));
  const render=()=>{
    const from=$('#rcFrom',f).value,to=$('#rcTo',f).value,list=matches();
    $('[data-rclist]',f).innerHTML=!from?'':list.length?`<div class="tbl-wrap" style="max-height:320px;overflow:auto"><table><thead><tr><th style="width:32px"><input type="checkbox" data-rcall checked aria-label="All"></th><th>Date</th><th>Type</th><th>Payee / memo</th><th class="n">Amount on the account</th></tr></thead><tbody>${list.map(e=>`<tr><td><input type="checkbox" data-rcpick="${e.id}" checked aria-label="Include"></td><td style="white-space:nowrap">${fmtDate(e.date)}</td><td>${TLABEL[e.type]||e.type}</td><td class="trunc" translate="no">${esc(contactName(e.contactId)||e.memo||'')}</td><td class="n">${mcell(amt(e,from))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="muted">No transactions match.</div>';
    const sync=()=>{const n=$$('[data-rcpick]',f).filter(x=>x.checked).length;btn.disabled=!n||!to||to===from;btn.textContent=n?`Reclassify ${n} transaction${n===1?'':'s'}`:'Reclassify'};
    const all=$('[data-rcall]',f);if(all)all.onchange=()=>{$$('[data-rcpick]',f).forEach(x=>x.checked=all.checked);sync()};
    $$('[data-rcpick]',f).forEach(x=>x.onchange=sync);sync();
  };
  ['rcFrom','rcTo','rcD1','rcD2','rcQ'].forEach(id=>{const el=$('#'+id,f);el.oninput=el.onchange=render});render();
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const from=$('#rcFrom',f).value,to=$('#rcTo',f).value;if(!from||!to||from===to)return f.err('Choose two different accounts.');
    const ids=new Set($$('[data-rcpick]',f).filter(x=>x.checked).map(x=>x.dataset.rcpick));
    if(ids.size>RECLASS_MAX)return f.err(`Reclassify at most ${RECLASS_MAX} transactions at a time. Narrow the dates or untick some.`);
    const swap=l=>l.account===from?{...l,account:to}:l,target=acct(to);
    const writes=[],done=new Set();let moved=0,skipped=0;
    const write=en=>{if(!en||done.has(en.id))return;done.add(en.id);
      const data={...strip(en),lines:en.lines.map(swap)};
      if(en.form&&Array.isArray(en.form.lines))data.form={...en.form,lines:en.form.lines.map(swap)};
      writes.push({op:'set',collection:'entries',id:en.id,data});
      if(en.docId){const d=S.docs.find(x=>x.id===en.docId);if(d)writes.push({op:'set',collection:'docs',id:d.id,data:{...strip(d),lines:(d.lines||[]).map(swap)}})}};
    for(const en of S.entries.filter(x=>ids.has(x.id))){
      if(!reclassFits(en,target)){skipped++;continue}
      write(en);moved++;
      // Keep an entry and its automatic reversal in step.
      const pair=en.reversalOf?S.entries.find(x=>x.id===en.reversalOf):S.entries.find(x=>x.reversalOf===en.id);
      if(pair&&(pair.lines||[]).some(l=>l.account===from))write(pair);
    }
    if(!moved)return f.err(`${acctName(to)} can’t be used on these transactions (for example an income account on an expense). Choose another account.`);
    if(await batch(writes)){closeModal();toast(`Reclassified ${moved} transaction${moved===1?'':'s'} to ${acctName(to)}`+(skipped?`. ${skipped} skipped: the account doesn’t fit them.`:''))}
  };
}
const RECLASS_MAX=190;
/** Would the transaction's own form accept this account? (An income account can't go on an expense, and so on.) */
function reclassFits(en,a){
  if(!reclassOk(a))return false;
  if(en.docId){const d=S.docs.find(x=>x.id===en.docId);if(d)return DOC_ACCT_FILTER(saleKind(d.kind))(a)}
  const sys=a.detail==='bank'||a.detail==='card'||a.detail==='ar'||a.detail==='ap';
  if(en.type==='expense')return !sys&&a.type!=='Income';
  if(en.type==='deposit')return !sys&&a.type!=='Expense'&&a.type!=='Cost of Goods Sold';
  return true;
}

/* ---------- the Review page ----------
   What a bookkeeper checks before closing a month: amounts in suspense or uncategorized accounts, bank lines
   waiting a long time, possible duplicates, and questions to and from the client. */
S.review={tab:'check'};
const SUSPENSE=/uncategori[sz]ed|suspense|ask my accountant|to be classified|à classer|en suspens|non class/i;
function reviewItems(){
  const t=today(),old=addDays(t,-30);
  const sus=S.accounts.filter(a=>SUSPENSE.test(a.name));
  const uncategorized=S.entries.filter(e=>(e.lines||[]).some(l=>sus.some(a=>a.id===l.account))).sort((a,b)=>b.date.localeCompare(a.date));
  const waiting=S.bankTxns.filter(b=>b.status==='new'&&b.date<old).sort((a,b)=>a.date.localeCompare(b.date));
  const noAcct=S.entries.filter(e=>(e.lines||[]).some(l=>!acct(l.account)));
  // Possible duplicates: same kind, same amount and same payee (or memo), within 3 days.
  const dismissed=new Set(S.company.notDuplicates||[]),groups={};
  const kindOf=e=>({invoice:'sale',deposit:'sale',payment:'in',bill:'buy',expense:'buy',billpayment:'out'})[e.type];
  for(const e of S.entries){const k=kindOf(e);if(!k)continue;const key=`${k}|${r2(entryTotal(e))}|${e.contactId||String(e.memo||'').toLowerCase().trim()}`;(groups[key]=groups[key]||[]).push(e)}
  const dups=[];
  for(const g of Object.values(groups)){if(g.length<2)continue;g.sort((a,b)=>a.date.localeCompare(b.date));
    for(let i=1;i<g.length;i++){const a=g[i-1],b=g[i];if(daysBetween(a.date,b.date)<=3&&!dismissed.has([a.id,b.id].sort().join('|'))&&!(a.ref&&b.ref&&a.ref!==b.ref))dups.push([a,b])}}
  return{sus,uncategorized,waiting,noAcct,dups:dups.sort((x,y)=>y[1].date.localeCompare(x[1].date))};
}
const reviewCount=()=>{if(!ME||ME.role==='client')return 0;const r=reviewItems();return r.uncategorized.length+r.dups.length+r.noAcct.length};
function vReview(){
  const staff=ME&&ME.role!=='client',R=S.review;
  if(!staff)R.tab='questions';
  const qOpen=S.questions.filter(q=>q.status!=='resolved');
  const tabs=staff?[['check','Needs a look'],['questions',`Questions${qOpen.length?` (${qOpen.length})`:''}`]]:[];
  let h=head(staff?'Review':'Questions',staff?'Before you close a month: what needs a look, and questions to and from the client':'Questions from your bookkeeper about your transactions',staff?'<button class="btn" data-rvact="reclass">Reclassify transactions</button>':'')
    +(tabs.length?`<div class="tabs" role="tablist">${tabs.map(([k,v])=>`<button role="tab" data-rvtab="${k}" aria-selected="${R.tab===k}">${v}</button>`).join('')}</div>`:'');
  if(R.tab==='questions'){
    const list=S.questions.slice().sort((a,b)=>(a.status==='resolved')-(b.status==='resolved')||(b.thread[b.thread.length-1].at-a.thread[a.thread.length-1].at));
    const st=q=>q.status==='resolved'?'<span class="pill quiet">Resolved</span>':q.status==='answered'?`<span class="pill paid">${staff?'Answered':'Sent'}</span>`:`<span class="pill partial">${staff?'Waiting for the client':'Needs your answer'}</span>`;
    return h+`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Transaction</th><th>Latest message</th><th>Status</th><th></th></tr></thead><tbody>${list.length?list.map(q=>{const m=q.thread[q.thread.length-1];return `<tr class="click" data-qopen="${q.id}"><td class="trunc" translate="no">${esc(qLabel(q))}</td><td class="trunc"><span translate="no">${esc(m.name)}:</span> <span translate="no">${esc(m.text.slice(0,90))}</span></td><td>${st(q)}</td><td class="n"><button class="btn sm" data-qopen="${q.id}">${q.status==='open'&&!staff?'Answer':'Open'}</button></td></tr>`}).join(''):emptyRow(4,'No questions',staff?'Open a transaction and choose Ask the client.':'Nothing to answer right now.')}</tbody></table></div></div>`;
  }
  const r=reviewItems();
  const sec=(title,hint,body,n)=>`<div class="panel" style="margin-bottom:16px"><h3>${title} <span class="pill ${n?'partial':'paid'}">${n||'None'}</span></h3>${n?body:`<div class="pad muted" style="font-size:13px">${hint}</div>`}</div>`;
  const row=e=>`<tr class="click" data-entry="${e.id}"><td style="white-space:nowrap">${fmtDate(e.date)}</td><td>${TLABEL[e.type]||e.type}${e.ref?` <span class="mono muted">#${esc(e.ref)}</span>`:''}</td><td class="trunc" translate="no">${esc(contactName(e.contactId)||e.memo||'')}</td><td class="n">${money(entryTotal(e))}</td></tr>`;
  h+=sec('Uncategorized or in suspense',r.sus.length?'Nothing is in an uncategorized or suspense account.':'There’s no uncategorized or suspense account in this chart of accounts.',`<div class="tbl-wrap"><table><tbody>${r.uncategorized.slice(0,200).map(row).join('')}</tbody></table></div>`,r.uncategorized.length);
  h+=sec('Possible duplicates','No transactions look like duplicates.',`<div class="tbl-wrap"><table><thead><tr><th>First</th><th>Second</th><th class="n">Amount</th><th></th></tr></thead><tbody>${r.dups.slice(0,100).map(([a,b])=>`<tr><td><button class="link" data-entry="${a.id}">${fmtDate(a.date)} · ${TLABEL[a.type]||a.type}</button> <span class="muted" translate="no">${esc(contactName(a.contactId)||a.memo||'')}</span></td><td><button class="link" data-entry="${b.id}">${fmtDate(b.date)} · ${TLABEL[b.type]||b.type}</button> <span class="muted" translate="no">${esc(contactName(b.contactId)||b.memo||'')}</span></td><td class="n">${money(entryTotal(a))}</td><td class="n"><button class="btn sm ghost" data-notdup="${[a.id,b.id].sort().join('|')}">Not a duplicate</button></td></tr>`).join('')}</tbody></table></div>`,r.dups.length);
  h+=sec('Bank lines waiting more than 30 days','Every bank line from more than 30 days ago has been added or matched.',`<div class="tbl-wrap"><table><tbody>${r.waiting.slice(0,200).map(b=>`<tr><td style="white-space:nowrap">${fmtDate(b.date)}</td><td class="trunc" translate="no">${esc(b.desc||'')}</td><td class="n">${money(b.amount)}</td><td class="n"><button class="btn sm" data-go="banking">Review</button></td></tr>`).join('')}</tbody></table></div>`,r.waiting.length);
  if(r.noAcct.length)h+=sec('Posted to a deleted account','',`<div class="tbl-wrap"><table><tbody>${r.noAcct.map(row).join('')}</tbody></table></div>`,r.noAcct.length);
  return h;
}
async function reviewClick(e,t,d){
  if(d.rvtab){S.review.tab=d.rvtab;renderMain();return true}
  if(d.rvact==='reclass'){reclassForm();return true}
  if(d.qopen){e.stopPropagation();questionView(d.qopen,()=>renderMain());return true}
  if(d.notdup){if(await putCompany({...strip(S.company),notDuplicates:[...(S.company.notDuplicates||[]),d.notdup].slice(-500)}))toast('Marked as not a duplicate');return true}
  return false;
}
