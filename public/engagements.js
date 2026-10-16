'use strict';
/* ---------- Year-end files (the accountant's working file) ----------
 * One file for each year-end of a company: a snapshot of the trial balance (with the prior year), each account on a
 * leadsheet, and the accountant's adjusting entries. The math is in engagements-calc.js (shared with the server).
 * Firm staff only; clients never see this screen or its records. "Coming soon" for now (plans.js).
 */
const YF={open:null,tab:'tb'};
const yfOn=()=>feat('yearEndFiles')&&!!(ME&&ME.role!=='client');
const yfEdit=()=>yfOn()&&!(ME&&ME.readOnly)&&perm('accounting','edit');
const yfFile=id=>S.engagements.find(x=>x.id===id);
const yfLead=c=>TallyEngage.BY_CODE[c]?TallyEngage.BY_CODE[c].label:c;
const yfKind=k=>TallyEngage.KINDS[k]||'Compilation';

/** The books' trial balance at a year-end, as snapshot lines (with the prior year's), or an error. */
function yfSnapshotLines(yearEnd){
  const pe=addDays(fyStartOf(yearEnd),-1);
  const cur=casewareRows(yearEnd),pri=casewareRows(pe);
  const pv=id=>{const x=pri.rows.find(y=>y.a.id===id);return x?x.v:0};
  const lines=[];
  for(const{a,v}of cur.rows){const p=pv(a.id);if(Math.abs(v)<0.005&&Math.abs(p)<0.005)continue;lines.push({account:a.id,code:a.code||'',name:a.name,type:a.type,detail:a.detail||'',gifi:a.gifi||'',cur:r2(v),prior:r2(p)})}
  if(Math.abs(cur.re)>=0.005||Math.abs(pri.re)>=0.005)lines.push({account:TallyEngage.RE_OPEN,code:'',name:'Retained earnings, beginning of year',type:'Equity',detail:'',gifi:'3600',cur:r2(cur.re),prior:r2(pri.re)});
  const tc=r2(lines.reduce((s,l)=>s+l.cur,0)),tp=r2(lines.reduce((s,l)=>s+l.prior,0));
  if(Math.abs(tc)>=0.01||Math.abs(tp)>=0.01)throw new Error('The trial balance doesn’t add up to zero. Check for unbalanced entries before taking the snapshot.');
  return{lines,priorEnd:pe};
}
const yfSnapshot=yearEnd=>{const{lines,priorEnd}=yfSnapshotLines(yearEnd);return{takenAt:Date.now(),by:ME?ME.name:'',priorEnd,lines}};

/** Accounts whose balance in the books no longer matches the snapshot plus the adjustments already posted. */
function yfChanged(f){
  let now;try{now=yfSnapshotLines(f.yearEnd).lines}catch(e){return null}
  const posted={};for(const j of f.ajes||[])if(j.entryId&&S.entries.some(e=>e.id===j.entryId))for(const l of j.lines)posted[l.account]=r2((posted[l.account]||0)+l.debit-l.credit);
  const cur={};for(const l of now)cur[l.account]=r2(l.cur-(posted[l.account]||0));
  return TallyEngage.changedSince(f,cur);
}

function vYearFiles(){
  if(!yfOn())return head('Year-end files','')+`<div class="empty"><b>Year-end files are coming soon</b>The accountant’s year-end working file, with the trial balance, leadsheets and adjusting entries.</div>`;
  const f=YF.open&&yfFile(YF.open);
  if(f)return yfDetail(f);
  YF.open=null;
  const list=S.engagements.slice().sort((a,b)=>b.yearEnd.localeCompare(a.yearEnd));
  const rows=list.map(f=>{const tb=TallyEngage.workingTb(f,S.accounts);return `<tr class="click" data-yfopen="${esc(f.id)}"><td>${esc(fmtDate(f.yearEnd))}</td><td>${esc(T(yfKind(f.kind)))}</td><td>${f.status==='final'?`<span class="pill paid">${esc(T('Final'))}</span>`:`<span class="pill open">${esc(T('In progress'))}</span>`}</td><td class="n">${(f.ajes||[]).length}</td><td class="n">${mcell(TallyEngage.netIncome(tb,'final'))}</td><td class="muted">${esc(fmtDate(iso(new Date(f.snapshot.takenAt))))}</td></tr>`}).join('');
  return head('Year-end files','The accountant’s working file for each year-end. Clients don’t see these.',yfEdit()?'<button class="btn primary" data-yfnew>+ New year-end file</button>':'')+
    `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Year-end</th><th>Engagement</th><th>Status</th><th class="n">Adjusting entries</th><th class="n">Net income (adjusted)</th><th>Snapshot taken</th></tr></thead><tbody>${rows||emptyRow(6,'No year-end files yet','Start one for a year-end: Sumlora takes the trial balance from the books, puts each account on a leadsheet, and you make your adjusting entries.')}</tbody></table></div></div>`;
}

function yfDetail(f){
  const edit=yfEdit()&&f.status!=='final',tb=TallyEngage.workingTb(f,S.accounts);
  const ch=f.status==='final'?[]:yfChanged(f);
  const unposted=(f.ajes||[]).filter(j=>!j.entryId||!S.entries.some(e=>e.id===j.entryId)).length;
  const acts=yfEdit()?(f.status==='final'?'<button class="btn" data-yfact="reopen">Reopen</button>':`<button class="btn" data-yfact="retake">Take the snapshot again</button><button class="btn" data-yfact="final">Mark final</button>`)+(f.status!=='final'?'<button class="btn danger" data-yfact="delete">Delete</button>':''):'';
  let h=head(`Year-end ${fmtDate(f.yearEnd)}`,`${esc(T(yfKind(f.kind)))} · ${f.status==='final'?esc(T('Final'))+(f.finalBy?' · '+esc(f.finalBy):''):esc(T('In progress'))} · ${esc(T('Snapshot taken'))} ${esc(fmtDate(iso(new Date(f.snapshot.takenAt))))}${f.snapshot.by?' · '+esc(f.snapshot.by):''}`,`<button class="btn" data-yfback>All year-end files</button>${acts}`);
  if(ch===null)h+=`<div class="banner err"><span>The books’ trial balance doesn’t add up to zero right now, so it can’t be compared with the snapshot.</span></div>`;
  else if(ch.length)h+=`<div class="banner"><span><b>The books changed since the snapshot.</b> ${ch.length} account${ch.length===1?'':'s'} no longer match${ch.length===1?'es':''} (${ch.slice(0,3).map(x=>esc(x.name||acct(x.account)?.name||'')).join(', ')}${ch.length>3?'…':''}). Take the snapshot again to bring the changes in; your leadsheets and adjusting entries are kept.</span>${edit?'<button class="btn sm" data-yfact="retake">Take the snapshot again</button>':''}</div>`;
  const ni=c=>TallyEngage.netIncome(tb,c);
  h+=`<div class="chips"><div class="chip"><div class="lbl">${esc(T('Net income before adjustments'))}</div><div class="val">${mcell(ni('cur'))}</div></div><div class="chip"><div class="lbl">${esc(T('Adjustments'))}</div><div class="val">${mcell(r2(ni('final')-ni('cur')))}</div></div><div class="chip"><div class="lbl">${esc(T('Net income, adjusted'))}</div><div class="val">${mcell(ni('final'))}</div></div><div class="chip"><div class="lbl">${esc(T('Prior year'))}</div><div class="val">${mcell(ni('prior'))}</div></div></div>`;
  const tabs=[['tb','Trial balance'],['ls','Leadsheets'],['aje',`Adjusting entries${unposted?` (${unposted} not posted)`:''}`]];
  h+=`<div class="tabs" role="tablist">${tabs.map(([k,v])=>`<button role="tab" data-yftab="${k}" aria-selected="${YF.tab===k}">${esc(v)}</button>`).join('')}</div>`;
  return h+(YF.tab==='ls'?yfLeadsheets(f):YF.tab==='aje'?yfAjes(f,edit):yfTb(f,tb,edit));
}

const yfName=r=>`<span translate="no">${esc((r.code?r.code+' ':'')+r.name)}</span>`;
function yfTb(f,tb,edit){
  const opts=sel=>TallyEngage.LEADSHEETS.map(l=>`<option value="${l.code}" ${l.code===sel?'selected':''}>${esc(l.code+' · '+T(l.label))}</option>`).join('');
  const sum=k=>r2(tb.reduce((s,r)=>s+r[k],0));
  const rows=tb.map(r=>`<tr><td>${yfName(r)}${r.gifi?` <span class="muted mono" style="font-size:12px">${esc(r.gifi)}</span>`:''}</td><td>${edit?`<select data-yfmap="${esc(r.account)}" aria-label="Leadsheet">${opts(r.lead)}</select>`:esc(r.lead+' · '+T(yfLead(r.lead)))}</td><td class="n">${mcell(r.prior)}</td><td class="n">${mcell(r.cur)}</td><td class="n">${r.adj?mcell(r.adj):''}</td><td class="n"><b>${mcell(r.final)}</b></td></tr>`).join('');
  return `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Account</th><th>Leadsheet</th><th class="n">Prior year</th><th class="n">Unadjusted</th><th class="n">Adjustments</th><th class="n">Adjusted</th></tr></thead><tbody>${rows}<tr class="tot"><td colspan="2">${esc(T('Total (debits less credits)'))}</td><td class="n">${mcell(sum('prior'))}</td><td class="n">${mcell(sum('cur'))}</td><td class="n">${mcell(sum('adj'))}</td><td class="n">${mcell(sum('final'))}</td></tr></tbody></table></div></div><div class="muted" style="font-size:13px;margin-top:8px">Debits are positive and credits are in brackets. Each account’s leadsheet is suggested from its type, GIFI code and name; change it here and it’s remembered for this file.</div>`;
}
function yfLeadsheets(f){
  const pct=(a,b)=>Math.abs(b)<0.005?'':`${Math.round((a-b)/Math.abs(b)*1000)/10}%`;
  let rows='';
  for(const ls of TallyEngage.leadsheets(f,S.accounts)){
    rows+=`<tr class="sec"><td colspan="6">${esc(ls.code)} · ${esc(T(ls.label))}</td></tr>`;
    for(const r of ls.lines)rows+=`<tr><td style="padding-left:28px">${yfName(r)}</td><td class="n">${mcell(r.prior)}</td><td class="n">${mcell(r.cur)}</td><td class="n">${r.adj?mcell(r.adj):''}</td><td class="n">${mcell(r.final)}</td><td class="n muted">${pct(r.final,r.prior)}</td></tr>`;
    rows+=`<tr class="tot"><td>${esc(T('Total'))} ${esc(ls.code)}</td><td class="n">${mcell(ls.prior)}</td><td class="n">${mcell(ls.cur)}</td><td class="n">${ls.adj?mcell(ls.adj):''}</td><td class="n">${mcell(ls.final)}</td><td class="n muted">${pct(ls.final,ls.prior)}</td></tr>`;
  }
  return `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Leadsheet</th><th class="n">Prior year</th><th class="n">Unadjusted</th><th class="n">Adjustments</th><th class="n">Adjusted</th><th class="n">Change</th></tr></thead><tbody>${rows||emptyRow(6,'Nothing to show','The trial balance has no balances.')}</tbody></table></div></div>`;
}
function yfAjes(f,edit){
  const list=(f.ajes||[]).slice().sort((a,b)=>a.num-b.num);
  const posted=j=>j.entryId&&S.entries.some(e=>e.id===j.entryId);
  const rows=list.map(j=>{const amt=r2(j.lines.reduce((s,l)=>s+l.debit,0));
    return `<tr><td class="mono">AJE ${j.num}</td><td>${esc(fmtDate(j.date))}</td><td>${esc(j.memo)}<div class="muted" style="font-size:12.5px">${j.lines.map(l=>`${esc(acct(l.account)?.name||'')} ${l.debit?money(l.debit):'('+money(l.credit)+')'}`).join(' · ')}</div></td><td class="n">${money(amt)}</td><td>${posted(j)?`<span class="pill paid">${esc(T('Posted to the books'))}</span>`:`<span class="pill quiet">${esc(T('In this file only'))}</span>`}</td><td class="n" style="white-space:nowrap">${edit&&!posted(j)?`<button class="btn sm" data-yfpost="${esc(j.id)}">Post to the books</button><button class="btn sm" data-yfaje="${esc(j.id)}">Edit</button><button class="btn sm" data-yfajedel="${esc(j.id)}">Delete</button>`:''}</td></tr>`}).join('');
  return `<div class="panel"><div class="toolbar"><span class="grow muted">Adjusting entries change this file’s leadsheets right away. Post one to the books when the client’s ledger should have it too.</span>${edit?'<button class="btn primary" data-yfaje="new">+ Adjusting entry</button>':''}</div><div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Date</th><th>Description</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows||emptyRow(6,'No adjusting entries yet','Add amortization, accruals, prepaid expenses, shareholder loan or income tax entries here.')}</tbody></table></div></div>`;
}

/* ---------- forms and actions ---------- */
function yfNewForm(){
  const t=today(),lastEnd=fyEndOf(addDays(fyStartOf(t),-1));
  const taken=new Set(S.engagements.map(x=>x.yearEnd));
  const f=openModal('New year-end file',`<div class="fields">${fld('yfEnd','Year-end',`<input type="date" id="yfEnd" value="${taken.has(lastEnd)?'':lastEnd}" required>`)}${fld('yfKind','Engagement',`<select id="yfKind">${Object.entries(TallyEngage.KINDS).map(([k,v])=>`<option value="${k}">${esc(T(v))}</option>`).join('')}</select>`)}</div><div class="muted" style="font-size:13px">Sumlora takes the trial balance at this date, with the prior year for comparatives, and keeps it as it is now. If the books change later, you can take the snapshot again.</div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Start</button>');
  f.onsubmit=async e=>{e.preventDefault();const ye=$('#yfEnd',f).value;if(!ye)return f.err('Choose the year-end date.');
    if(taken.has(ye))return f.err('There’s already a year-end file for that date.');
    let snapshot;try{snapshot=yfSnapshot(ye)}catch(err){return f.err(err.message)}
    const id=uid();
    if(await put('engagements',id,{yearEnd:ye,kind:$('#yfKind',f).value,status:'open',snapshot,map:{},ajes:[],notes:'',created:Date.now()})){closeModal();YF.open=id;YF.tab='tb';renderMain()}};
}
const yfSave=(f,patch)=>put('engagements',f.id,{...f,...patch});

function yfAjeForm(f,j){
  const accts=acctOptions;
  const line=l=>`<tr><td><select data-ajacct aria-label="Account"><option value="">Choose…</option>${accts(l&&l.account)}</select></td><td><input type="number" step="0.01" min="0" data-ajdr value="${l&&l.debit?l.debit:''}" aria-label="Debit"></td><td><input type="number" step="0.01" min="0" data-ajcr value="${l&&l.credit?l.credit:''}" aria-label="Credit"></td><td><input type="text" data-ajmemo value="${esc(l&&l.memo||'')}" aria-label="Memo"></td></tr>`;
  const ls=j?j.lines:[null,null];
  const m=openModal(j?`Edit AJE ${j.num}`:'New adjusting entry',`<div class="fields">${fld('ajDate','Date',`<input type="date" id="ajDate" value="${esc(j?j.date:f.yearEnd)}">`)}${fld('ajMemo','Description',`<input type="text" id="ajMemo" value="${esc(j?j.memo:'')}" placeholder="e.g. Amortization for the year" maxlength="300">`,true)}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th><th>Memo</th></tr></thead><tbody data-ajlines>${ls.map(line).join('')}</tbody><tfoot><tr class="tot"><td><button type="button" class="btn sm" data-ajadd>+ Line</button></td><td class="n" data-ajtdr></td><td class="n" data-ajtcr></td><td></td></tr></tfoot></table></div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>','wide');
  const read=()=>$$('[data-ajlines] tr',m).map(tr=>({account:$('[data-ajacct]',tr).value,debit:r2($('[data-ajdr]',tr).value),credit:r2($('[data-ajcr]',tr).value),memo:$('[data-ajmemo]',tr).value.trim()})).filter(l=>l.account&&(l.debit||l.credit));
  const tot=()=>{const l=read();$('[data-ajtdr]',m).textContent=money(l.reduce((s,x)=>s+x.debit,0));$('[data-ajtcr]',m).textContent=money(l.reduce((s,x)=>s+x.credit,0))};
  m.addEventListener('input',tot);m.addEventListener('change',tot);tot();
  $('[data-ajadd]',m).onclick=()=>{$('[data-ajlines]',m).insertAdjacentHTML('beforeend',line(null))};
  m.onsubmit=async e=>{e.preventDefault();const lines=read();
    if(lines.some(l=>l.debit&&l.credit))return m.err('A line can have a debit or a credit, not both.');
    const out={id:j?j.id:uid(),num:j?j.num:Math.max(0,...(f.ajes||[]).map(x=>x.num))+1,date:$('#ajDate',m).value||f.yearEnd,memo:$('#ajMemo',m).value.trim(),lines,entryId:''};
    const bad=TallyEngage.ajeProblem(out);if(bad)return m.err(bad);
    const ajes=(f.ajes||[]).filter(x=>x.id!==out.id).concat(out);
    if(await yfSave(f,{ajes}))closeModal()};
}

/** Post an adjusting entry to the client's books as an adjusting journal entry, and remember which entry it made. */
async function yfPost(f,j){
  if(!await confirmBox(`Post AJE ${j.num} to the books?`,`It becomes an adjusting journal entry dated ${fmtDate(j.date)} in the client’s ledger, where the client can see it.`,'Post'))return;
  const eid=uid();
  const entry={type:'journal',date:j.date,ref:`AJE ${j.num}`,memo:`Year-end adjustment: ${j.memo||'AJE '+j.num}`,contactId:'',adjusting:true,created:Date.now(),lines:j.lines.map(l=>({account:l.account,debit:l.debit,credit:l.credit,memo:l.memo||''}))};
  const ajes=f.ajes.map(x=>x.id===j.id?{...x,entryId:eid}:x);
  if(await batch([{op:'set',collection:'entries',id:eid,data:entry},{op:'set',collection:'engagements',id:f.id,data:{...f,ajes}}]))toast(`AJE ${j.num} posted to the books`);
}

async function yfClick(e,t,d){
  if(t.hasAttribute('data-yfnew')){yfNewForm();return true}
  if(d.yfopen){YF.open=d.yfopen;YF.tab='tb';renderMain();return true}
  if(t.hasAttribute('data-yfback')){YF.open=null;renderMain();return true}
  if(d.yftab){YF.tab=d.yftab;renderMain();return true}
  const f=YF.open&&yfFile(YF.open);if(!f)return false;
  if(d.yfaje){yfAjeForm(f,d.yfaje==='new'?null:f.ajes.find(x=>x.id===d.yfaje));return true}
  if(d.yfajedel){const j=f.ajes.find(x=>x.id===d.yfajedel);if(j&&await confirmBox(`Delete AJE ${j.num}?`,'It comes off this file’s leadsheets.'))await yfSave(f,{ajes:f.ajes.filter(x=>x.id!==j.id)});return true}
  if(d.yfpost){const j=f.ajes.find(x=>x.id===d.yfpost);if(j)await yfPost(f,j);return true}
  if(d.yfact==='retake'){
    let snapshot;try{snapshot=yfSnapshot(f.yearEnd)}catch(err){toast(err.message,true);return true}
    // Adjustments already posted to the books are in the new snapshot, so take them out to keep them from counting twice.
    const posted={};for(const j of f.ajes||[])if(j.entryId&&S.entries.some(x=>x.id===j.entryId))for(const l of j.lines)posted[l.account]=r2((posted[l.account]||0)+l.debit-l.credit);
    snapshot.lines=snapshot.lines.map(l=>({...l,cur:r2(l.cur-(posted[l.account]||0))}));
    if(await confirmBox('Take the snapshot again?','The trial balance is taken from the books again. Leadsheets and adjusting entries are kept.','Take snapshot')&&await yfSave(f,{snapshot}))toast('Snapshot taken');
    return true}
  if(d.yfact==='final'){if(await confirmBox('Mark this year-end file final?','It can’t be changed until it’s reopened.','Mark final'))await yfSave(f,{status:'final',finalAt:Date.now(),finalBy:ME?ME.name:''});return true}
  if(d.yfact==='reopen'){await yfSave(f,{status:'open'});return true}
  if(d.yfact==='delete'){if(await confirmBox('Delete this year-end file?','The snapshot, leadsheets and adjusting entries in it are deleted. Entries already posted to the books stay in the books.')&&await del('engagements',f.id)){YF.open=null;renderMain()}return true}
  return false;
}
/** Leadsheet changes on the trial balance tab. */
function yfBind(m){
  $$('[data-yfmap]',m).forEach(s=>s.onchange=async()=>{const f=yfFile(YF.open);if(!f)return;await yfSave(f,{map:{...(f.map||{}),[s.dataset.yfmap]:s.value}})});
}
