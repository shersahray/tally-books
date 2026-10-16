'use strict';
/* ---------- Year-end files (the accountant's working file) ----------
 * One file for each year-end of a company: a snapshot of the trial balance (with the prior year), each account on a
 * leadsheet, and the accountant's adjusting entries. The math is in engagements-calc.js (shared with the server).
 * Firm staff only; clients never see this screen or its records. "Coming soon" for now (plans.js).
 */
const YF={open:null,tab:'ov',wp:'',rn:{show:'open',who:'',pri:'',wp:''}};
const yfOn=()=>feat('yearEndFiles')&&!!(ME&&ME.role!=='client');
const yfEdit=()=>yfOn()&&!(ME&&ME.readOnly)&&perm('accounting','edit');
const yfFile=id=>S.engagements.find(x=>x.id===id);
const yfLead=c=>TallyEngage.BY_CODE[c]?TallyEngage.BY_CODE[c].label:c;
const yfKind=k=>TallyEngage.KINDS[k]||'Compilation';
const yfFinal=f=>TallyEngage.statusOf(f.status)==='final';
/** Can the signed-in person make this file final or reopen it (an owner, or the file's reviewer)? */
const yfLeadMe=f=>!!(ME&&(ME.role==='owner'||(f.team&&f.team.reviewer&&f.team.reviewer.id===ME.id)));
const yfStatusPill=f=>{const st=TallyEngage.statusOf(f.status);return `<span class="pill ${st==='final'?'paid':st==='progress'?'open':'partial'}">${esc(T(TallyEngage.STATUS_LABEL[st]))}</span>`};
const yfStamp=x=>x?`${esc(x.by)} · ${esc(fmtDate(iso(new Date(x.at))))}`:'';

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
/** A snapshot from the books. A file rolled forward keeps last year's final figures as its prior year. */
const yfSnapshot=(yearEnd,f)=>{const{lines,priorEnd}=yfSnapshotLines(yearEnd);const prev=f&&f.snapshot&&f.snapshot.priorSource==='file'&&f.rolledFrom&&yfFile(f.rolledFrom);
  return prev?{takenAt:Date.now(),by:ME?ME.name:'',priorEnd,lines:TallyEngage.withPriorFrom(lines,prev,S.accounts),source:'books',priorSource:'file'}:{takenAt:Date.now(),by:ME?ME.name:'',priorEnd,lines,source:'books'}};

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
  list.forEach(yfAutoSync);
  const due=yfEdit()&&yfDue();
  const rows=list.map(f=>{const tb=TallyEngage.workingTb(f,S.accounts),pg=TallyEngage.progress(f,S.accounts,S.attachments);return `<tr class="click" data-yfopen="${esc(f.id)}"><td>${esc(fmtDate(f.yearEnd))}</td><td>${esc(T(yfKind(f.kind)))}</td><td>${yfStatusPill(f)}</td><td class="n">${pg.pct}%</td><td class="n">${pg.openNotes||''}</td><td class="n">${mcell(TallyEngage.netIncome(tb,'final'))}</td><td class="muted">${esc([f.team&&f.team.preparer&&f.team.preparer.name,f.team&&f.team.reviewer&&f.team.reviewer.name].filter(Boolean).join(' / '))}</td></tr>`}).join('');
  return head('Year-end files','The accountant’s working file for each year-end. Clients don’t see these.',yfEdit()?'<button class="btn primary" data-yfnew>+ New year-end file</button>':'')+
    (due?`<div class="banner"><span><b>${esc(T('Year-end'))} ${esc(fmtDate(due))}</b> ${esc(T('has no file yet. Sumlora brings in the trial balance and puts every account on its working paper.'))}</span><button class="btn primary sm" data-yfstart="${due}">${esc(T('Start this year-end'))}</button></div>`:'')+
    `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Year-end</th><th>Engagement</th><th>Status</th><th class="n">Complete</th><th class="n">Open review notes</th><th class="n">Net income (adjusted)</th><th>Preparer / reviewer</th></tr></thead><tbody>${rows||emptyRow(7,'No year-end files yet','Start one for a year-end: Sumlora takes the trial balance from the books, puts each account on a leadsheet, and you make your adjusting entries.')}</tbody></table></div></div>`;
}

function yfDetail(f){
  const fin=yfFinal(f),edit=yfEdit()&&!fin,tb=TallyEngage.workingTb(f,S.accounts),st=TallyEngage.statusOf(f.status);
  yfAutoSync(f);
  const ch=fin?yfChanged(f):[];
  const unposted=(f.ajes||[]).filter(j=>!j.entryId||!S.entries.some(e=>e.id===j.entryId)).length;
  const next={progress:['ready','Ready for review'],ready:['reviewing','Start the review'],reviewing:['progress','Back to the preparer']}[st];
  const nextYe=fyEndOf(addDays(f.yearEnd,1)),rolled=S.engagements.some(x=>x.yearEnd===nextYe);
  const acts=yfEdit()?(fin?(yfLeadMe(f)?'<button class="btn" data-yfact="reopen">Reopen…</button>':'')+(rolled?'':`<button class="btn primary" data-yfroll="${nextYe}">${esc(T('Roll forward to'))} ${esc(fmtDate(nextYe))}</button>`):`${next?`<button class="btn" data-yfstatus="${next[0]}">${esc(T(next[1]))}</button>`:''}${yfLeadMe(f)?'<button class="btn primary" data-yfact="final">Make final</button>':''}<button class="btn danger" data-yfact="delete">Delete</button>`):'';
  let h=head(`Year-end ${fmtDate(f.yearEnd)}`,`${yfStatusPill(f)} ${esc(T(yfKind(f.kind)))} · ${esc(f.framework||'ASPE')}${fin&&f.finalBy?' · '+esc(T('Final'))+' '+esc(f.finalBy)+' '+esc(fmtDate(iso(new Date(f.finalAt)))):''} · ${esc(T('Snapshot taken'))} ${esc(fmtDate(iso(new Date(f.snapshot.takenAt))))}`,`<button class="btn" data-yfback>All year-end files</button>${acts}`);
  if(fin)h+=`<div class="banner"><span><b>This file is final and locked.</b> ${yfLeadMe(f)?'Reopen it, with a reason, to make changes.':'An owner or the file’s reviewer can reopen it.'}</span></div>`;
  if(ch===null||(!fin&&yfChanged(f)===null))h+=`<div class="banner err"><span>The books’ trial balance doesn’t add up to zero right now, so it can’t be brought in. Check for unbalanced entries.</span></div>`;
  else if(ch.length)h+=`<div class="banner"><span><b>The books changed after this file was made final.</b> ${ch.length} account${ch.length===1?'':'s'} no longer match${ch.length===1?'es':''} (${ch.slice(0,3).map(x=>esc(x.name||acct(x.account)?.name||'')).join(', ')}${ch.length>3?'…':''}). The file keeps its final figures; reopen it to bring the changes in.</span></div>`;
  const ni=c=>TallyEngage.netIncome(tb,c);
  h+=`<div class="chips"><div class="chip"><div class="lbl">${esc(T('Net income before adjustments'))}</div><div class="val">${mcell(ni('cur'))}</div></div><div class="chip"><div class="lbl">${esc(T('Adjustments'))}</div><div class="val">${mcell(r2(ni('final')-ni('cur')))}</div></div><div class="chip"><div class="lbl">${esc(T('Net income, adjusted'))}</div><div class="val">${mcell(ni('final'))}</div></div><div class="chip"><div class="lbl">${esc(T('Prior year'))}</div><div class="val">${mcell(ni('prior'))}</div></div></div>`;
  const pg=TallyEngage.progress(f,S.accounts,S.attachments);
  // [key, label, a count shown beside it]
  const tabs=[['ov','Overview',pg.pct+'%'],['tb','Trial balance'],['ls','Leadsheets'],['wp','Working papers',pg.unreviewed||''],['aje','Adjusting entries',unposted||''],['rn','Review notes',pg.openNotes||''],['an','Analysis'],['fs','Financial statements'],['gifi','GIFI'],['cl','Checklist']];
  h+=`<div class="tabs" role="tablist">${tabs.map(([k,v,n])=>`<button role="tab" data-yftab="${k}" aria-selected="${YF.tab===k}"><span>${esc(T(v))}</span>${n!==undefined&&n!==''?` <span class="count${k==='ov'?' info':''}">${esc(String(n))}</span>`:''}</button>`).join('')}</div>`;
  const V={ov:()=>yfOverview(f,edit,pg),ls:()=>yfLeadsheets(f),wp:()=>yfWorkpapers(f,edit),aje:()=>yfAjes(f,edit),rn:()=>yfReviewNotes(f,edit),an:()=>yfAnalysis(f,edit),fs:()=>yfStatements(f,edit),gifi:()=>yfGifi(f),cl:()=>yfChecklist(f,edit)}[YF.tab];
  return h+(V?V():yfTb(f,tb,edit));
}

const yfName=r=>`<span translate="no">${esc((r.code?r.code+' ':'')+r.name)}</span>`;
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
    return `<tr><td class="mono">AJE ${j.num}</td><td>${esc(fmtDate(j.date))}</td><td>${esc(j.memo)}${j.wp?` <span class="pill quiet">${esc(j.wp)}</span>`:''}${j.explanation?`<div style="font-size:12.5px">${esc(j.explanation)}</div>`:''}<div class="muted" style="font-size:12.5px">${j.lines.map(l=>`${esc(acct(l.account)?.name||(f.snapshot.lines.find(x=>x.account===l.account)||{}).name||'')} ${l.debit?money(l.debit):'('+money(l.credit)+')'}`).join(' · ')}</div></td><td class="n">${money(amt)}</td><td>${j.reviewedBy?`<span class="pill paid" title="${esc(T('Reviewed'))} ${yfStamp(j.reviewedBy)}">${esc(T('Reviewed'))}</span>`:`<span class="pill partial">${esc(T('Draft'))}</span>`} ${posted(j)?`<span class="pill paid">${esc(T('Posted'))}</span>`:''}${j.recurring?` <span class="pill quiet">${esc(T('Recurring'))}</span>`:''}<div class="muted" style="font-size:12px">${j.preparedBy?esc(T('Prepared'))+' '+yfStamp(j.preparedBy):''}${j.reviewedBy?'<br>'+esc(T('Reviewed'))+' '+yfStamp(j.reviewedBy):''}</div></td><td class="n" style="white-space:nowrap">${edit?`${j.reviewedBy?'':`<button class="btn sm" data-yfajerev="${esc(j.id)}">Mark reviewed</button>`}${posted(j)?'':`${j.lines.every(l=>acct(l.account))?`<button class="btn sm" data-yfpost="${esc(j.id)}">Post to the books</button>`:''}<button class="btn sm" data-yfaje="${esc(j.id)}">Edit</button><button class="btn sm" data-yfajedel="${esc(j.id)}">Delete</button>`}`:''}</td></tr>`}).join('');
  return yfRecurringPanel(f,edit)+`<div class="panel"><div class="toolbar"><span class="grow muted">Adjusting entries change this file’s leadsheets right away. Post one to the books when the client’s ledger should have it too.</span>${edit?'<button class="btn primary" data-yfaje="new">+ Adjusting entry</button>':''}</div><div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Date</th><th>Description</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows||emptyRow(6,'No adjusting entries yet','Add amortization, accruals, prepaid expenses, shareholder loan or income tax entries here.')}</tbody></table></div></div>`;
}

/* ---------- forms and actions ---------- */
function yfNewForm(){
  const t=today(),lastEnd=fyEndOf(addDays(fyStartOf(t),-1));
  const taken=new Set(S.engagements.map(x=>x.yearEnd));
  const f=openModal('New year-end file',`<div class="fields">${fld('yfEnd','Year-end',`<input type="date" id="yfEnd" value="${taken.has(lastEnd)?'':lastEnd}" required>`)}${fld('yfKind','Engagement',`<select id="yfKind">${Object.entries(TallyEngage.KINDS).map(([k,v])=>`<option value="${k}">${esc(T(v))}</option>`).join('')}</select>`)}${fld('yfSrc','Trial balance from',`<select id="yfSrc"><option value="books">${esc(T('Sumlora’s books'))}</option><option value="import">${esc(T('An Excel or CSV file'))}</option><option value="manual">${esc(T('I’ll type it in'))}</option></select><input type="file" id="yfFile" accept=".xlsx,.csv,.txt" hidden style="margin-top:6px">`)}${fld('yfFw','Accounting framework',`<select id="yfFw">${Object.entries(TallyEngage.FRAMEWORKS).map(([k,v])=>`<option value="${k}" ${k===(S.company.orgType==='npo'||S.company.orgType==='charity'?'ASNPO':'ASPE')?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}</div><div class="muted" style="font-size:13px">Sumlora brings in the trial balance at this date, with the prior year for comparatives, and puts every account on its working paper. Until the file is final, changes in the books come in by themselves.</div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Start</button>');
  $('#yfSrc',f).onchange=()=>{$('#yfFile',f).hidden=$('#yfSrc',f).value!=='import'};
  f.onsubmit=async e=>{e.preventDefault();const ye=$('#yfEnd',f).value;if(!ye)return f.err('Choose the year-end date.');
    if(taken.has(ye))return f.err('There’s already a year-end file for that date.');
    const src=$('#yfSrc',f).value;let lines=null,fileName='';
    if(src==='import'){const file=$('#yfFile',f).files[0];if(!file)return f.err('Choose the trial balance file.');try{lines=await yfReadTbFile(file);fileName=file.name}catch(err){return f.err(err.message)}}
    if(src==='manual')lines=[];
    const err=await yfCreate(ye,$('#yfKind',f).value,$('#yfFw',f).value,null,lines?{source:src,lines,fileName}:null);if(err)return f.err(err);closeModal()};
}
const yfDefaultFw=()=>S.company.orgType==='npo'||S.company.orgType==='charity'?'ASNPO':'ASPE';
/**
 * Make a year-end file straight from the books: the trial balance (and prior year) at the year-end, each account on its
 * working paper, and last year's file's mapping, notes, report wording, client details and reviewer. Returns an error, or ''.
 */
async function yfCreate(ye,kind='compilation',framework=yfDefaultFw(),from=null,own=null){
  let snapshot;
  // Rolling forward a file whose trial balance wasn't from the books: last year's figures become the prior year, and
  // this year's balances are imported or typed in.
  if(!own&&from&&from.snapshot&&from.snapshot.source&&from.snapshot.source!=='books')own={source:'manual',lines:TallyEngage.withPriorFrom([],from,S.accounts)};
  if(own)snapshot={takenAt:Date.now(),by:ME?ME.name:'',priorEnd:addDays(fyStartOf(ye),-1),lines:own.lines,source:own.source,fileName:own.fileName||'',priorSource:from?'file':'books'};
  else{try{snapshot=yfSnapshot(ye)}catch(err){return err.message}}
  const id=uid();
  // Last year's file (if there is one) gives this one its mapping, notes and report wording; recurring entries are suggested, not copied.
  const prev=from||S.engagements.filter(x=>x.yearEnd<ye).sort((a,b)=>b.yearEnd.localeCompare(a.yearEnd))[0];
  // Rolled forward from a final file: its adjusted figures are this year's prior year.
  if(from&&yfFinal(from)&&snapshot.source==='books'){snapshot.lines=TallyEngage.withPriorFrom(snapshot.lines,from,S.accounts);snapshot.priorSource='file'}
  const me=ME?{id:ME.id,name:ME.name}:null;
  const data={yearEnd:ye,kind,framework,status:'progress',snapshot,map:prev?{...prev.map}:{},ajes:[],notes:'',created:Date.now(),
    client:yfClientDefaults(prev),team:{preparer:me,reviewer:prev&&prev.team?prev.team.reviewer:null},fsNotes:prev?prev.fsNotes||[]:[],report:prev&&prev.report?{...prev.report,date:''}:undefined,
    wps:{},reviewNotes:[],checklist:{},signoffs:{},rolledFrom:prev?prev.id:'',includeCashFlow:prev?!!prev.includeCashFlow:false};
  if(!await put('engagements',id,data))return'Couldn’t save the year-end file.';
  YF.open=id;YF.tab=own&&own.source==='manual'?'tb':'wp';YF.wp='';renderMain();
  toast((own&&own.source==='manual'?'Type the trial balance in, then save it':`Trial balance brought in: ${snapshot.lines.length} accounts on their working papers`)+(prev&&(prev.ajes||[]).some(j=>j.recurring)?'. Last year’s recurring entries are on the Adjusting entries tab.':''));
  return'';
}
/** The last fiscal year-end that has passed, when it has no year-end file yet (offered as a one-click start). */
function yfDue(){const t=today(),ye=fyEndOf(addDays(fyStartOf(t),-1));return S.engagements.some(x=>x.yearEnd===ye)?'':ye}

/*
 * The trial balance follows the books by itself: while a file isn't final, any change in the books since the last
 * update is brought in when the file is looked at (entries already posted from the file aren't counted twice).
 * A working paper whose figures changed after it was reviewed goes back for review.
 */
const YF_SYNC=new Set();
function yfAutoSync(f){
  if(!yfEdit()||yfFinal(f)||YF_SYNC.has(f.id)||(f.snapshot.source&&f.snapshot.source!=='books'))return;
  const ch=yfChanged(f);if(!ch||!ch.length)return;
  let snapshot;try{snapshot=yfSnapshot(f.yearEnd,f)}catch(err){return}
  const posted={};for(const j of f.ajes||[])if(j.entryId&&S.entries.some(x=>x.id===j.entryId))for(const l of j.lines)posted[l.account]=r2((posted[l.account]||0)+l.debit-l.credit);
  snapshot.lines=snapshot.lines.map(l=>({...l,cur:r2(l.cur-(posted[l.account]||0))}));
  const leads=new Set(ch.flatMap(x=>{const line=(f.snapshot.lines.find(l=>l.account===x.account)||snapshot.lines.find(l=>l.account===x.account)||{account:x.account});return [TallyEngage.leadOf(f,line),TallyEngage.leadOf(f,{...line,...(acct(x.account)||{}),account:x.account})]}));
  const wps={...(f.wps||{})};let undone=0;
  for(const k of leads)if(wps[k]&&wps[k].reviewed){wps[k]={...wps[k],reviewed:null,status:'progress'};undone++}
  YF_SYNC.add(f.id);
  setTimeout(async()=>{
    // A failed update isn't tried again in a loop; it's tried again the next time Sumlora is opened.
    const ok=await yfSave(f,{snapshot,wps});if(ok)YF_SYNC.delete(f.id);
    if(ok)toast(`Trial balance updated from the books (${ch.length} account${ch.length===1?'':'s'})`+(undone?`. ${undone} working paper${undone===1?'':'s'} back for review.`:''));
  },0);
}
const yfSave=(f,patch)=>put('engagements',f.id,{...f,...patch});

function yfAjeForm(f,j){
  const own=f.snapshot.source&&f.snapshot.source!=='books';
  const accts=own?sel=>f.snapshot.lines.filter(l=>l.account!==TallyEngage.RE_OPEN).map(l=>`<option value="${esc(l.account)}" ${l.account===sel?'selected':''}>${esc((l.code?l.code+' · ':'')+l.name)}</option>`).join(''):acctOptions;
  const line=l=>`<tr><td><select data-ajacct aria-label="Account"><option value="">Choose…</option>${accts(l&&l.account)}</select></td><td><input type="number" step="0.01" min="0" data-ajdr value="${l&&l.debit?l.debit:''}" aria-label="Debit"></td><td><input type="number" step="0.01" min="0" data-ajcr value="${l&&l.credit?l.credit:''}" aria-label="Credit"></td><td><input type="text" data-ajmemo value="${esc(l&&l.memo||'')}" aria-label="Memo"></td></tr>`;
  const ls=j?j.lines:[null,null];
  const m=openModal(j?`Edit AJE ${j.num}`:'New adjusting entry',`<div class="fields">${fld('ajDate','Date',`<input type="date" id="ajDate" value="${esc(j?j.date:f.yearEnd)}">`)}${fld('ajWp','Working paper',`<select id="ajWp"><option value="">None</option>${TallyEngage.LEADSHEETS.map(l=>`<option value="${l.code}" ${j&&j.wp===l.code?'selected':''}>${esc(l.code+' · '+T(l.label))}</option>`).join('')}</select>`)}${fld('ajMemo','Description',`<input type="text" id="ajMemo" value="${esc(j?j.memo:'')}" placeholder="e.g. Amortization for the year" maxlength="300">`,true)}${fld('ajExp','Explanation',`<textarea id="ajExp" rows="2" maxlength="2000" placeholder="Why the entry is needed, and where the figure comes from">${esc(j&&j.explanation||'')}</textarea>`,true)}<label class="check" style="grid-column:1/-1"><input type="checkbox" id="ajRec" ${j&&j.recurring?'checked':''}> Recurring: suggest it again in next year’s file</label></div>
    <div class="tbl-wrap"><table><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th><th>Memo</th></tr></thead><tbody data-ajlines>${ls.map(line).join('')}</tbody><tfoot><tr class="tot"><td><button type="button" class="btn sm" data-ajadd>+ Line</button></td><td class="n" data-ajtdr></td><td class="n" data-ajtcr></td><td></td></tr></tfoot></table></div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>','wide');
  const read=()=>$$('[data-ajlines] tr',m).map(tr=>({account:$('[data-ajacct]',tr).value,debit:r2($('[data-ajdr]',tr).value),credit:r2($('[data-ajcr]',tr).value),memo:$('[data-ajmemo]',tr).value.trim()})).filter(l=>l.account&&(l.debit||l.credit));
  const tot=()=>{const l=read();$('[data-ajtdr]',m).textContent=money(l.reduce((s,x)=>s+x.debit,0));$('[data-ajtcr]',m).textContent=money(l.reduce((s,x)=>s+x.credit,0))};
  m.addEventListener('input',tot);m.addEventListener('change',tot);tot();
  $('[data-ajadd]',m).onclick=()=>{$('[data-ajlines]',m).insertAdjacentHTML('beforeend',line(null))};
  m.onsubmit=async e=>{e.preventDefault();const lines=read();
    if(lines.some(l=>l.debit&&l.credit))return m.err('A line can have a debit or a credit, not both.');
    const out={...(j||{}),id:j?j.id:uid(),num:j?j.num:Math.max(0,...(f.ajes||[]).map(x=>x.num))+1,date:$('#ajDate',m).value||f.yearEnd,memo:$('#ajMemo',m).value.trim(),explanation:$('#ajExp',m).value,wp:$('#ajWp',m).value,recurring:$('#ajRec',m).checked,lines,entryId:j?j.entryId||'':''};
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
  if(d.yfstart){const err=await yfCreate(d.yfstart);if(err)toast(err,true);return true}
  if(d.yfroll){const src=yfFile(YF.open);if(!await confirmBox(`Roll forward to ${fmtDate(d.yfroll)}?`,'A new year-end file starts from the books. This year’s final figures become its prior year, and the mapping, notes, report wording, client details, team and recurring entries carry over. This file stays exactly as it is.','Roll forward'))return true;
    const err=await yfCreate(d.yfroll,src.kind,src.framework,src);if(err)toast(err,true);return true}
  if(d.yfprioruse){const f=yfFile(YF.open),prev=f&&yfFile(f.rolledFrom||d.yfprioruse);if(!f||!prev)return true;
    if(await confirmBox('Use last year’s final figures as the prior year?','The prior-year column is replaced with the adjusted figures from last year’s final file. The current year still comes from the books.','Use them'))await yfSave(f,{rolledFrom:prev.id,snapshot:{...f.snapshot,lines:TallyEngage.withPriorFrom(f.snapshot.lines,prev,S.accounts),priorSource:'file'}});return true}
  if(d.yfopen){YF.open=d.yfopen;YF.tab='tb';renderMain();return true}
  if(t.hasAttribute('data-yfback')){YF.open=null;renderMain();return true}
  if(d.yftab){YF.tab=d.yftab;renderMain();return true}
  const f=YF.open&&yfFile(YF.open);if(!f)return false;
  if(t.hasAttribute('data-yfwords')){yfWordsForm(f);return true}
  if(t.hasAttribute('data-yfpackage')){const safe=String(S.company.name||'company').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();saveFile(`${safe}-engagement-package-${f.yearEnd}.pdf`,new Blob([yfPdf(f,true)],{type:'application/pdf'}));return true}
  if(d.yfxlsx){yfXlsx(f,d.yfxlsx);return true}
  if(t.hasAttribute('data-yfpdf')){const safe=String(S.company.name||'company').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();saveFile(`${safe}-financial-statements-${f.yearEnd}.pdf`,new Blob([yfPdf(f)],{type:'application/pdf'}));return true}
  if(t.hasAttribute('data-yfgificsv')){yfGifiCsv(f);return true}
  if(t.hasAttribute('data-yfgifiedit')){gifiForm();return true}
  if(d.yfaje){yfAjeForm(f,d.yfaje==='new'?null:f.ajes.find(x=>x.id===d.yfaje));return true}
  if(d.yfajedel){const j=f.ajes.find(x=>x.id===d.yfajedel);if(j&&await confirmBox(`Delete AJE ${j.num}?`,'It comes off this file’s leadsheets.'))await yfSave(f,{ajes:f.ajes.filter(x=>x.id!==j.id)});return true}
  if(d.yfpost){const j=f.ajes.find(x=>x.id===d.yfpost);if(j)await yfPost(f,j);return true}
  if(d.yfact==='final'){const pg=TallyEngage.progress(f,S.accounts,S.attachments);
    if(pg.openNotes){toast(`Resolve or close the ${pg.openNotes} open review note${pg.openNotes===1?'':'s'} first`,true);return true}
    if(await confirmBox('Make this year-end file final?',`The checklist is ${pg.pct}% complete. Everything in the file is locked until it’s reopened with a reason.`,'Make final'))await yfSave(f,{status:'final',report:{...(f.report||{}),text:yfReportText(f),template:yfTemplate(f).id,custom:!!(f.report&&f.report.custom)}});return true}
  if(d.yfact==='reopen'){yfReopenForm(f);return true}
  if(d.yfstatus){await yfSave(f,{status:d.yfstatus});return true}
  if(d.yfajerev){await yfSave(f,{ajes:f.ajes.map(x=>x.id===d.yfajerev?{...x,reviewedBy:{at:1}}:x)});return true}
  if(await yfReviewClick(e,t,d,f))return true;
  if(await yfAnalysisClick(e,t,d,f))return true;
  if(d.yfact==='delete'){if(await confirmBox('Delete this year-end file?','The snapshot, leadsheets and adjusting entries in it are deleted. Entries already posted to the books stay in the books.')&&await del('engagements',f.id)){YF.open=null;renderMain()}return true}
  return false;
}
/** Leadsheet changes on the trial balance tab. */
function yfBind(m){
  if(typeof yfReviewBind==='function')yfReviewBind(m);
  const f0=YF.open&&yfFile(YF.open);if(f0&&YF.tab==='tb'&&typeof yfTbBind==='function')yfTbBind(m,f0);
  $$('[data-yfmap]',m).forEach(s=>s.onchange=async()=>{const f=yfFile(YF.open);if(!f)return;await yfSave(f,{map:{...(f.map||{}),[s.dataset.yfmap]:s.value}})});
}

/* ---------- financial statements, notes and GIFI ---------- */
/** The default compilation engagement report: the elements CSRS 4200 asks for, in Sumlora's own words. Replace it with your firm's approved wording. */
/** The statements the report covers, in words. */
function yfStatementWords(f){
  const co=(f.client&&f.client.legalName)||S.company.name||'the company',ye=fmtDate(f.yearEnd);
  const others=['the statement of income and retained earnings',...(f.includeCashFlow?['the statement of cash flows']:[])];
  return `the balance sheet of ${co} as at ${ye}, ${others.join(' and ')} for the year then ended`;
}
/** The report's template: the one the file was finalized with, else the newest for its engagement type. */
const yfTemplate=f=>(f.report&&f.report.template&&yfFinal(f)&&TallyReportTemplates.BY_ID[f.report.template])||TallyReportTemplates.current(f.kind||'compilation',f.yearEnd);
function yfDefaultReport(f){
  return TallyReportTemplates.render(yfTemplate(f),{entity:(f.client&&f.client.legalName)||S.company.name||'the company',yearEnd:fmtDate(f.yearEnd),statements:yfStatementWords(f),firm:(f.report&&f.report.signer)||'',city:(f.report&&f.report.city)||''});
}
/** Customized wording, the frozen wording of a final file, or the central template. */
const yfReportText=f=>{const r=f.report||{};const custom=r.custom||(r.text&&!r.template);return (custom||yfFinal(f))&&r.text?r.text:yfDefaultReport(f)};
const yfDefaultNotes=()=>[{title:'Basis of accounting',text:'The financial information is prepared on the historical cost basis, using the accrual basis of accounting. Revenue is recognized when services are performed or goods are delivered. Capital assets are recorded at cost and amortized over their useful lives. Income taxes are recorded using the taxes payable method.'}];
const yfReport=f=>({text:yfReportText(f),title:yfTemplate(f).title,custom:!!(f.report&&(f.report.custom||(f.report.text&&!f.report.template))),signer:(f.report&&f.report.signer)||(typeof ME!=='undefined'&&ME?ME.firmName||'':''),city:(f.report&&f.report.city)||'',date:(f.report&&f.report.date)||''});
const yfNotes=f=>f.fsNotes&&f.fsNotes.length?f.fsNotes:yfDefaultNotes();

/** The statements as rows ({cls, label, cur, prior}) for the screen and the PDF. */
/** The statement of cash flows as rows (this year only; a prior-year column would need the year before it). */
function yfCfRows(f){
  const cf=TallyEngage.cashFlow(f,S.accounts),row=(cls,label,v)=>({cls,label,cur:v===undefined?null:v,prior:null});
  const R=[row('sec','Operating activities'),row('item','Net income',cf.net)];
  if(Math.abs(cf.amort)>=0.005)R.push(row('item','Amortization (not a cash expense)',cf.amort));
  if(cf.wc.length){R.push(row('sub','Changes in non-cash working capital'));cf.wc.forEach(([l,v])=>R.push(row('item',l,v)))}
  R.push(row('tot','Cash from operating activities',cf.operating));
  if(cf.investing.length){R.push(row('sec','Investing activities'));cf.investing.forEach(([l,v])=>R.push(row('item',l,v)));R.push(row('tot','Cash from investing activities',cf.inv))}
  if(cf.financing.length){R.push(row('sec','Financing activities'));cf.financing.forEach(([l,v])=>R.push(row('item',l,v)));R.push(row('tot','Cash from financing activities',cf.fin))}
  R.push(row('spacer',''),row('item','Change in cash',cf.change),row('item','Cash, beginning of year',cf.begin));
  if(Math.abs(cf.gap)>=0.01)R.push(row('item','Not explained by the changes above',cf.gap));
  R.push(row('grand','Cash, end of year',cf.end));
  return R;
}
function yfRows(f){
  const st=TallyEngage.statements(f,S.accounts),bs=st.bs,is=st.is,re=st.re,nz=x=>Math.abs(x.cur)>=0.005||Math.abs(x.prior)>=0.005;
  const row=(cls,label,x)=>({cls,label,cur:x?x.cur:null,prior:x?x.prior:null});
  const B=[row('sec','Assets')];
  for(const g of bs.groups.filter(g=>g.key==='ca'||g.key==='la')){if(!g.lines.length)continue;B.push(row('sub',g.label));g.lines.forEach(l=>B.push(row('item',l.label,l)));B.push(row('tot','Total '+g.label.toLowerCase(),g.total))}
  B.push(row('grand','Total assets',bs.assets),row('spacer',''),row('sec','Liabilities'));
  for(const g of bs.groups.filter(g=>g.key==='cl'||g.key==='ll')){if(!g.lines.length)continue;B.push(row('sub',g.label));g.lines.forEach(l=>B.push(row('item',l.label,l)));B.push(row('tot','Total '+g.label.toLowerCase(),g.total))}
  B.push(row('tot','Total liabilities',bs.liabilities),row('spacer',''),row('sec','Shareholders’ equity'));
  if(nz(bs.shareCapital))B.push(row('item','Share capital',bs.shareCapital));
  B.push(row('item','Retained earnings',bs.retained),row('tot','Total shareholders’ equity',bs.equity),row('spacer',''),row('grand','Total liabilities and shareholders’ equity',bs.totalLE));
  const I=[row('item','Revenue',is.revenue)];
  if(nz(is.cos))I.push(row('item','Cost of sales',is.cos),row('tot','Gross profit',is.gross));
  if(is.opex.length){I.push(row('sec','Operating expenses'));is.opex.forEach(x=>I.push(row('item',x.label,x)));I.push(row('tot','Total operating expenses',is.opexTotal))}
  if(nz(is.other))I.push(row('item','Other income (expenses)',is.other));
  if(nz(is.taxes))I.push(row('tot','Income before income taxes',is.beforeTax),row('item','Income taxes',is.taxes));
  I.push(row('grand','Net income',is.net),row('spacer',''),row('item','Retained earnings, beginning of year',re.opening),row('item','Net income',re.net));
  if(nz(re.dividends))I.push(row('item','Dividends',{cur:-re.dividends.cur,prior:-re.dividends.prior}));
  if(nz(re.other))I.push(row('item','Other changes',re.other));
  I.push(row('grand','Retained earnings, end of year',re.closing));
  return{st,bs:B,is:I};
}
const yfPriorEnd=f=>f.snapshot.priorEnd||addDays(fyStartOf(f.yearEnd),-1);
function yfTable(rows,f){
  const c=v=>v===null?'':mcell(v);
  return `<table><thead><tr><th></th><th class="n">${esc(fmtDate(f.yearEnd))}</th><th class="n">${esc(fmtDate(yfPriorEnd(f)))}</th></tr></thead><tbody>${rows.map(r=>r.cls==='spacer'?'<tr class="spacer"><td colspan="3"></td></tr>':`<tr class="${r.cls==='sub'?'sec':r.cls}"><td>${esc(T(r.label))}</td><td class="n">${c(r.cur)}</td><td class="n">${c(r.prior)}</td></tr>`).join('')}</tbody></table>`;
}
function yfStatements(f,edit){
  const{st,bs,is}=yfRows(f),rp=yfReport(f),notes=yfNotes(f);
  const co=esc(S.company.name||''),off=st.bs.off;
  let h=`<div class="panel" style="margin-bottom:16px"><div class="toolbar"><span class="grow muted">Built from the adjusted leadsheets, with the prior year beside each figure.</span><label class="check"><input type="checkbox" data-yfcf ${f.includeCashFlow?'checked':''} ${edit?'':'disabled'}> ${esc(T('Statement of cash flows'))}</label>${edit?'<button class="btn" data-yfwords>Edit the report and notes</button>':''}<button class="btn" data-yfxlsx="ls">Leadsheets (Excel)</button><button class="btn" data-yfpackage>Engagement package (PDF)</button><button class="btn primary" data-yfpdf>Statements (PDF)</button></div></div>`;
  if(Math.abs(off.cur)>=0.01||Math.abs(off.prior)>=0.01)h+=`<div class="banner err"><span><b>The balance sheet doesn’t balance</b> (off by ${money(off.cur)} this year, ${money(off.prior)} last year). Check the leadsheets of equity accounts.</span></div>`;
  h+=`<div class="panel report" style="margin-bottom:16px"><div class="rh"><b>${esc(T(rp.title))}</b><span>${esc(rp.custom?T('Your firm’s wording'):yfTemplate(f).label)}</span></div><div class="pad" style="white-space:pre-wrap;line-height:1.55">${esc(rp.text)}</div><div class="pad muted">${esc(rp.signer||'')}${rp.city?'<br>'+esc(rp.city):''}${rp.date?'<br>'+esc(fmtDate(rp.date)):''}</div></div>`;
  h+=`<div class="panel report" style="margin-bottom:16px"><div class="rh"><b>${co}</b><span>${esc(T('Balance sheet'))} · ${esc(T('As at'))} ${esc(fmtDate(f.yearEnd))}</span></div><div class="tbl-wrap">${yfTable(bs,f)}</div></div>`;
  h+=`<div class="panel report" style="margin-bottom:16px"><div class="rh"><b>${co}</b><span>${esc(T('Statement of income and retained earnings'))} · ${esc(T('Year ended'))} ${esc(fmtDate(f.yearEnd))}</span></div><div class="tbl-wrap">${yfTable(is,f)}</div></div>`;
  if(f.includeCashFlow)h+=`<div class="panel report" style="margin-bottom:16px"><div class="rh"><b>${co}</b><span>${esc(T('Statement of cash flows'))} · ${esc(T('Year ended'))} ${esc(fmtDate(f.yearEnd))}</span></div><div class="tbl-wrap">${yfTable(yfCfRows(f),f)}</div></div>`;
  h+=`<div class="panel report"><div class="rh"><b>${co}</b><span>${esc(T('Notes to the financial information'))} · ${esc(T('Year ended'))} ${esc(fmtDate(f.yearEnd))}</span></div><div class="pad">${notes.map((n,i)=>`<p><b>${i+1}. ${esc(n.title)}</b></p><p style="white-space:pre-wrap;line-height:1.55">${esc(n.text)}</p>`).join('')}</div></div>`;
  return h;
}
function yfWordsForm(f){
  const rp=yfReport(f),notes=yfNotes(f);
  const noteHTML=(n,i)=>`<div class="field" style="grid-column:1/-1" data-ynote><label>Note ${i+1}${feat('ai')?` <button type="button" class="btn sm" data-ynai>${esc(T('Draft with AI'))}</button> <span class="muted" data-ynaimsg style="font-size:12px"></span>`:''}</label><input type="text" data-ntitle value="${esc(n.title)}" placeholder="Title, e.g. Capital assets" maxlength="150"><textarea data-ntext rows="4" maxlength="8000" style="margin-top:6px">${esc(n.text)}</textarea></div>`;
  const m=openModal('Report and notes',`<div class="fields"><label class="check" style="grid-column:1/-1"><input type="checkbox" id="yrCustom" ${rp.custom?'checked':''}> ${esc(T('Use my own wording for this file'))}</label>${fld('yrText',rp.title,`<textarea id="yrText" rows="12" maxlength="8000" ${rp.custom?'':'readonly'}>${esc(rp.text)}</textarea><span class="hint" data-yrhint>${esc(rp.custom?T('Your wording is kept as you write it.'):T('Standard wording')+': '+yfTemplate(f).label+'. '+T('It updates by itself when Sumlora’s wording is updated for new standards, until the file is final.'))}</span>`,true)}${fld('yrSigner','Signed by (firm)',`<input type="text" id="yrSigner" value="${esc(rp.signer)}" maxlength="120">`)}${fld('yrCity','City',`<input type="text" id="yrCity" value="${esc(rp.city)}" maxlength="80" placeholder="e.g. Ottawa, Ontario">`)}${fld('yrDate','Report date',`<input type="date" id="yrDate" value="${esc(rp.date)}">`)}</div><div class="fields" data-ynotes>${notes.map(noteHTML).join('')}</div><button type="button" class="btn sm" data-ynadd>+ Note</button>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>','wide');
  m.addEventListener('click',async e=>{const b=e.target.closest('[data-ynai]');if(!b)return;const box=b.closest('[data-ynote]'),ti=$('[data-ntitle]',box),ta=$('[data-ntext]',box),msg=$('[data-ynaimsg]',box);
    if(!ti.value.trim())return m.err('Give the note a title first, e.g. Capital assets.');
    b.disabled=true;msg.textContent=T('Drafting…');const txt=await yfAiNote(f,ti.value.trim());b.disabled=false;
    if(txt){ta.value=txt;msg.textContent=T('AI draft – check and edit it; fill in anything in [brackets]. Nothing is saved until you save.')}else msg.textContent=''});
  $('#yrCustom',m).onchange=()=>{const on=$('#yrCustom',m).checked,ta=$('#yrText',m);ta.readOnly=!on;if(!on)ta.value=yfDefaultReport({...f,report:{...(f.report||{}),custom:false,text:''}});$('[data-yrhint]',m).textContent=on?T('Your wording is kept as you write it.'):T('Standard wording')+': '+yfTemplate(f).label};
  $('[data-ynadd]',m).onclick=()=>{const box=$('[data-ynotes]',m);box.insertAdjacentHTML('beforeend',noteHTML({title:'',text:''},box.children.length))};
  m.onsubmit=async e=>{e.preventDefault();
    const fsNotes=$$('[data-ynote]',m).map(x=>({title:$('[data-ntitle]',x).value.trim(),text:$('[data-ntext]',x).value})).filter(n=>n.title||n.text.trim());
    const custom=$('#yrCustom',m).checked;
    const report={custom,template:yfTemplate(f).id,text:custom?$('#yrText',m).value:'',signer:$('#yrSigner',m).value.trim(),city:$('#yrCity',m).value.trim(),date:$('#yrDate',m).value};
    if(await yfSave(f,{report,fsNotes}))closeModal()};
}

/** The statements package as a PDF: cover, compilation engagement report, balance sheet, income and retained earnings, notes. */
/** The statements package as a PDF; with full, the whole engagement package for the firm's own file. */
function yfPdf(f,full=false){
  const{bs,is}=yfRows(f),rp=yfReport(f),notes=yfNotes(f),co=S.company.name||'';
  const doc=TallyPDF.create(),W0=doc.width,H0=doc.height,M=56,C1=W0-M-110,C2=W0-M;
  let fresh=true,y=0;const page=()=>{if(fresh)fresh=false;else doc.addPage();y=M};
  const title=(t,sub)=>{page();doc.text(W0/2,y,co,{size:14,bold:true,align:'center'});y+=18;doc.text(W0/2,y,tl(t),{size:12,bold:true,align:'center'});y+=15;if(sub){doc.text(W0/2,y,sub,{size:10,align:'center',color:'#555555'});y+=12}y+=18};
  const para=(text,size=10)=>{for(const line of doc.wrap(text,W0-2*M,size)){if(y>H0-M){page()}doc.text(M,y,line,{size});y+=size*1.45}};
  // Cover
  page();y=250;doc.text(W0/2,y,co,{size:22,bold:true,align:'center'});y+=34;doc.text(W0/2,y,tl('Financial statements'),{size:15,align:'center'});y+=22;doc.text(W0/2,y,`${tl('Year ended')} ${fmtDate(f.yearEnd)}`,{size:11,align:'center',color:'#555555'});
  // Report
  title(rp.title);para(rp.text);y+=18;
  for(const l of [rp.signer,rp.city,rp.date?fmtDate(rp.date):''].filter(Boolean)){doc.text(M,y,l,{size:10});y+=14}
  // Statements
  const table=(rows,t,sub)=>{
    const headRow=()=>{doc.text(C1,y,fmtDate(f.yearEnd),{size:9,bold:true,align:'right'});doc.text(C2,y,fmtDate(yfPriorEnd(f)),{size:9,bold:true,align:'right'});y+=6;doc.line(M,y,W0-M,y,{color:'#999999'});y+=14};
    title(t,sub);headRow();
    for(const r of rows){
      if(y>H0-M-20){title(t,sub);headRow()}
      if(r.cls==='spacer'){y+=6;continue}
      const bold=['sec','sub','tot','grand'].includes(r.cls),ind=r.cls==='item'?14:0;
      if(r.cls==='tot'||r.cls==='grand')doc.line(C1-90,y-9,W0-M,y-9,{color:'#bbbbbb'});
      doc.text(M+ind,y,tl(r.label),{size:10,bold});
      if(r.cur!==null){doc.text(C1,y,money(r.cur),{size:10,bold:r.cls==='grand',align:'right'});if(r.prior!==null)doc.text(C2,y,money(r.prior),{size:10,bold:r.cls==='grand',align:'right'})}
      if(r.cls==='grand'){doc.line(C1-90,y+4,W0-M,y+4,{color:'#555555'});doc.line(C1-90,y+6,W0-M,y+6,{color:'#555555'})}
      y+=r.cls==='sec'?16:14;
    }
  };
  table(bs,'Balance sheet',`${tl('As at')} ${fmtDate(f.yearEnd)}`);
  table(is,'Statement of income and retained earnings',`${tl('Year ended')} ${fmtDate(f.yearEnd)}`);
  if(f.includeCashFlow)table(yfCfRows(f),'Statement of cash flows',`${tl('Year ended')} ${fmtDate(f.yearEnd)}`);
  // Notes
  title('Notes to the financial information',`${tl('Year ended')} ${fmtDate(f.yearEnd)}`);
  notes.forEach((n,i)=>{if(y>H0-M-40)page();doc.text(M,y,`${i+1}. ${n.title}`,{size:10,bold:true});y+=15;para(n.text);y+=10});
  if(full)yfPackagePages(f,{doc,W0,H0,M,title,para,page,getY:()=>y,setY:v=>{y=v}});
  const pages=doc.pageCount(),foot=f.kind==='internal'?tl('Unaudited – prepared for management’s internal use'):tl('Unaudited – see compilation engagement report');
  for(let i=1;i<pages;i++){doc.goto(i);doc.text(W0/2,H0-28,`${foot} · ${i+1}`,{size:8,align:'center',color:'#888888'})}
  return doc.output();
}

function yfGifi(f){
  const g=TallyEngage.gifi(f,S.accounts);
  let h='';
  if(g.missing.length)h+=`<div class="banner"><span><b>${g.missing.length} account${g.missing.length===1?' has':'s have'} no GIFI code</b> and ${g.missing.length===1?'is':'are'} left out: ${g.missing.slice(0,4).map(x=>esc(x.name)).join(', ')}${g.missing.length>4?'…':''}.</span>${yfEdit()?'<button class="btn sm" data-yfgifiedit>Fill in GIFI codes</button>':''}</div>`;
  else if(!g.agrees)h+=`<div class="banner err"><span>The GIFI totals don’t agree with the financial statements. Check the GIFI codes of accounts on the balance sheet and income statement.</span></div>`;
  const rows=g.lines.map(l=>`<tr${l.total?' class="tot"':''}><td>${l.schedule}</td><td class="mono">${l.code}</td><td>${esc(TallyGIFI.describe(l.code,isFr()?'fr':'en'))}</td><td class="n">${mcell(l.cur)}</td><td class="n">${mcell(l.prior)}</td></tr>`).join('');
  return h+`<div class="panel"><div class="toolbar"><span class="grow muted">T2 Schedule 100 (balance sheet) and Schedule 125 (income statement) from the adjusted figures. Amounts are positive in their normal direction.</span><button class="btn primary" data-yfgificsv>Download CSV</button></div><div class="tbl-wrap"><table><thead><tr><th>Schedule</th><th>GIFI</th><th>Description</th><th class="n">${esc(fmtDate(f.yearEnd))}</th><th class="n">${esc(fmtDate(yfPriorEnd(f)))}</th></tr></thead><tbody>${rows||emptyRow(5,'Nothing to show','The trial balance has no balances.')}</tbody></table></div></div>`;
}
function yfGifiCsv(f){
  const g=TallyEngage.gifi(f,S.accounts);
  const rows=[['Schedule','GIFI code','Description','Current year','Prior year'],...g.lines.map(l=>[l.schedule,l.code,TallyGIFI.describe(l.code,'en'),l.cur.toFixed(2),l.prior.toFixed(2)])];
  const csv='﻿'+rows.map(r=>r.map(v=>{const s=String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');
  const safe=String(S.company.name||'company').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();
  saveFile(`${safe}-gifi-${f.yearEnd}.csv`,new Blob([csv],{type:'text/csv'}));
}
