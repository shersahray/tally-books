'use strict';
/* ---------- Activity log: every change to the open company's books, who made it and when ----------
   Kept by the server (see the audit table in db.js); owners and staff can read it, clients can't. */
S.act={rows:[],users:[],user:'',collection:'',done:false,loading:false,co:null};
const ACT_COL={entries:'Transaction',docs:'Invoice or bill',accounts:'Account',contacts:'Customer or vendor',employees:'Employee',payruns:'Pay run',bankTxns:'Bank line',rules:'Bank rule',recons:'Reconciliation',filings:'Sales tax filing',settings:'Company settings'};
const ACT_ACTION={create:'Created company',add:'Added',change:'Changed',delete:'Deleted',settings:'Changed',import:'Imported',restore:'Restored backup',examples:'Loaded examples'};

async function loadActivity(more){
  const A=S.act;if(A.loading)return;
  if(!more||A.co!==CO){A.rows=[];A.done=false;A.co=CO}
  A.loading=true;
  const q=new URLSearchParams({limit:'200'});
  if(A.user)q.set('user',A.user);if(A.collection)q.set('collection',A.collection);
  if(more&&A.rows.length)q.set('before',A.rows[A.rows.length-1].seq);
  try{const r=await api('GET','/api/audit?'+q);A.rows=A.rows.concat(r.rows);A.users=r.users;A.done=r.rows.length<200}
  catch(e){toast(e.message,true)}
  A.loading=false;if(S.view==='activity')renderMain();
}
function showActivity(){S.act.user='';S.act.collection='';go('activity');loadActivity()}
function vActivity(){
  const A=S.act;
  const opts=(list,sel)=>list.map(([k,v])=>`<option value="${esc(k)}" ${sel===k?'selected':''}>${esc(v)}</option>`).join('');
  return `<button class="btn ghost sm" data-go="settings" style="margin-bottom:8px">← Settings</button>`+head('Activity log','Every change to these books: who made it, when, and what it was before',`<button class="btn" data-actcsv ${A.rows.length?'':'disabled'}>Export CSV</button>`)+
  `<div class="panel"><div class="toolbar">
    <select id="actUser" aria-label="Person"><option value="">Everyone</option>${opts(A.users.map(u=>[u.username,u.name+' ('+u.username+')']),A.user)}</select>
    <select id="actCol" aria-label="Kind of record"><option value="">All kinds of records</option>${opts(Object.entries(ACT_COL),A.collection)}</select>
    <span class="grow"></span></div>
  <div class="tbl-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>
  ${A.rows.length?A.rows.map(r=>`<tr class="click" data-act-row="${r.seq}"><td class="muted" style="white-space:nowrap">${fmtWhen(r.at)}</td><td>${esc(r.name)}</td><td>${ACT_ACTION[r.action]||esc(r.action)}</td><td>${esc(ACT_COL[r.collection]||r.collection||'')}</td><td class="trunc">${esc(r.summary)}</td></tr>`).join(''):emptyRow(5,A.loading?'Loading…':'No changes recorded',A.loading?'':'Changes made from now on are listed here.')}
  </tbody></table></div>${A.rows.length&&!A.done?`<div class="pad"><button class="btn" data-actmore ${A.loading?'disabled':''}>Show older changes</button></div>`:''}</div>`;
}
async function actClick(e,t,d){
  if(d.actRow){actDetail(+d.actRow);return true}
  if(t.hasAttribute('data-actmore')){loadActivity(true);return true}
  if(t.hasAttribute('data-actcsv')){actCSV();return true}
  return false;
}
function bindActivity(m){
  const u=$('#actUser',m),c=$('#actCol',m);
  if(u)u.onchange=()=>{S.act.user=u.value;loadActivity()};
  if(c)c.onchange=()=>{S.act.collection=c.value;loadActivity()};
}
/* One change: the fields that differ, before and after. */
async function actDetail(seq){
  let r;try{r=await api('GET','/api/audit/'+seq)}catch(e){return toast(e.message,true)}
  const b=r.before||{},a=r.after||{};
  const show=v=>{if(v===undefined)return '<span class="muted">—</span>';if(v&&typeof v==='object')return `<code class="json">${esc(JSON.stringify(v,null,1)).slice(0,1500)}</code>`;return esc(String(v))};
  const label=k=>({terms:'Payment terms (days)',fyStart:'Fiscal year starts (month)',taxName:'Sales tax name',taxRate:'Sales tax rate',qstRate:'QST rate',filingFreq:'Sales tax filing',bn:'Business number',province:'Province',currency:'Currency',payroll:'Payroll settings',lines:'Lines',date:'Date',ref:'Number / reference',memo:'Memo',contactId:'Customer or vendor',name:'Name',amount:'Amount',total:'Total',status:'Status',type:'Type',account:'Account',desc:'Description'})[k]||k;
  const keys=[...new Set([...Object.keys(b),...Object.keys(a)])].filter(k=>k!=='created'&&JSON.stringify(b[k])!==JSON.stringify(a[k]));
  const target=r.collection==='entries'&&S.entries.find(x=>x.id===r.record_id)||r.collection==='docs'&&S.docs.find(x=>x.id===r.record_id);
  const f=openModal(`${ACT_ACTION[r.action]||r.action}: ${ACT_COL[r.collection]||r.collection||''}`,`
    <div class="muted">${esc(r.name)} (${esc(r.username)}) · ${fmtWhen(r.at)}</div>
    <div>${esc(r.summary)}</div>
    ${keys.length?`<div class="tbl-wrap"><table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${keys.map(k=>`<tr><td>${esc(label(k))}</td><td>${show(b[k])}</td><td>${show(a[k])}</td></tr>`).join('')}</tbody></table></div>`:''}`,
    `${target?'<button type="button" class="btn left" data-actopen>Open it</button>':'<span class="left"></span>'}<button type="button" class="btn primary" data-close>Close</button>`,'wide');
  const o=$('[data-actopen]',f);if(o)o.onclick=()=>{closeModal();r.collection==='docs'?docForm(target.kind,target):openEntry(target)};
}
function actCSV(){
  const rows=[['When','Username','Name','Action','Record','Details']].concat(S.act.rows.map(r=>[new Date(r.at).toISOString(),r.username,r.name,ACT_ACTION[r.action]||r.action,ACT_COL[r.collection]||r.collection,r.summary]));
  const text=rows.map(row=>row.map(v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');
  saveFile(`activity-log_${today()}.csv`,new Blob(['﻿'+text],{type:'text/csv;charset=utf-8'}));
}
