'use strict';
/* ---------- Year-end files: checks Sumlora can do because it has the books ----------
 * The year-end bank balance against the bank itself (bank feeds), revenue against the GST/HST returns filed, shareholder
 * loans and subsection 15(2), invoices and bills just after the year-end (cut-off), and large transactions after it
 * (subsequent events). Each is a pointer for the accountant, shown on its working paper and on the Analysis tab.
 */
const YF_BANK={};
const yfMin=f=>(f.materiality&&f.materiality.amount>0?f.materiality.amount:1000);
const yfFromBooks=f=>!f.snapshot.source||f.snapshot.source==='books';

function yfBankPanel(f,edit){
  if(!yfFromBooks(f))return'';
  const r=YF_BANK[f.id],tb=TallyEngage.workingTb(f,S.accounts);
  let rows='';
  if(r&&r.accounts){for(const x of r.accounts){
    if(x.error){rows+=`<tr><td colspan="4" class="neg">${esc(x.institution)}: ${esc(x.error)}</td></tr>`;continue}
    const line=tb.find(l=>l.account===x.account),books=line?line.final:0,diff=r2(books-x.bankAtYearEnd),ok=Math.abs(diff)<0.01;
    rows+=`<tr><td>${esc(x.name)}<div class="muted" style="font-size:12px">${esc(x.institution)} · ${esc(T('bank balance now'))} ${money(x.bankNow)} (${esc(fmtDate(x.asOf))}), ${x.linesAfter} ${esc(T('bank lines after the year-end'))}</div></td><td class="n">${money(books)}</td><td class="n">${money(x.bankAtYearEnd)}</td><td>${ok?`<span class="pos">✓ ${esc(T('Agrees'))}</span>${edit?` <button class="btn sm" data-yfbanktick="${esc(x.account)}">${esc(T('Tick as agreed'))}</button>`:''}`:`<span class="neg">${esc(T('Difference'))} ${money(diff)}</span>`}</td></tr>`}}
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Checked against the bank'))}</b><button class="btn sm" data-yfbankcheck>${esc(T(r?'Check again':'Check with the bank'))}</button></div>
    ${r&&r.accounts&&!r.accounts.length?`<div class="pad muted">${esc(T('No bank feeds are connected for this company, so there’s nothing to compare. Attach the bank statements instead.'))}</div>`:''}
    ${rows?`<div class="tbl-wrap"><table><thead><tr><th>${esc(T('Account'))}</th><th class="n">${esc(T('In the file'))}</th><th class="n">${esc(T('Bank at the year-end'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="pad muted" style="font-size:12px">${esc(T('The bank’s balance today, less the bank lines it sent dated after the year-end. A difference can mean missing bank lines, or items not yet cleared; agree it to the bank statement.'))}</div>`:''}
    ${r?'':`<div class="pad muted">${esc(T('For accounts with a bank feed, Sumlora works out the year-end balance from the bank’s own figures.'))}</div>`}</div>`;
}
function yfGstPanel(f){
  if(!yfFromBooks(f))return'';
  const g=TallyEngage.gstCheck(f,S.accounts,S.filings,fyStartOf(f.yearEnd));
  if(!g.counted&&!g.partial)return`<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Revenue and GST/HST returns'))}</b></div><div class="pad muted">${esc(T('No GST/HST returns are recorded in Sumlora for this year.'))}</div></div>`;
  const ok=Math.abs(g.diff)<1;
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Revenue and GST/HST returns'))}</b></div><div class="tbl-wrap"><table><tbody><tr><td>${esc(T('Revenue in the file'))}</td><td class="n">${money(g.revenue)}</td></tr><tr><td>${esc(T('Sales reported on the returns (line 101)'))} · ${g.counted} ${esc(T(g.counted===1?'return':'returns'))}</td><td class="n">${money(g.reported)}</td></tr><tr class="tot"><td>${esc(T('Difference'))}</td><td class="n">${ok?'<span class="pos">✓</span> ':''}${money(g.diff)}</td></tr></tbody></table></div>${g.partial?`<div class="pad muted" style="font-size:12px">${g.partial} ${esc(T('return(s) cover periods partly outside the year and aren’t counted.'))}</div>`:''}${ok?'':`<div class="pad muted" style="font-size:12px">${esc(T('Explain the difference: exempt or zero-rated sales, revenue not subject to GST/HST, adjusting entries, or a return to amend.'))}</div>`}</div>`;
}
function yfLoansPanel(f){
  const list=TallyEngage.shareholderLoans(f,S.accounts,yfActivity(f));
  if(!list.length)return'';
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Shareholder loans'))}</b></div><div class="tbl-wrap"><table><thead><tr><th>${esc(T('Account'))}</th><th class="n">${esc(T('Opening'))}</th><th class="n">${esc(T('Advances'))}</th><th class="n">${esc(T('Repayments'))}</th><th class="n">${esc(T('Closing'))}</th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(x.name)}</td><td class="n">${mcell(x.open)}</td><td class="n">${money(x.advances)}</td><td class="n">${money(x.repayments)}</td><td class="n">${mcell(x.close)}</td></tr>${x.notes.map(n=>`<tr><td colspan="5"><div class="banner" style="margin:0"><span>${esc(n)}</span></div></td></tr>`).join('')}`).join('')}</tbody></table></div><div class="pad muted" style="font-size:12px">${esc(T('Debit balances are owed by the shareholder to the company. Pointers only: check the facts and the exceptions in subsection 15(2).'))}</div></div>`;
}
function yfAfterPanel(f){
  if(!yfFromBooks(f))return'';
  const min=yfMin(f),cut=TallyEngage.cutoff(S.docs,f.yearEnd,min),sub=TallyEngage.subsequent(S.entries,f.yearEnd,min);
  const docRow=d=>`<tr class="click" data-doc="${esc(d.id)}"><td>${esc(fmtDate(d.date))}</td><td>${esc(T(d.kind==='invoice'?'Invoice':'Bill'))} ${esc(d.number)}</td><td class="n">${money(d.total)}</td></tr>`;
  const entRow=e=>`<tr class="click" data-entry="${esc(e.id)}"><td>${esc(fmtDate(e.date))}</td><td>${esc(e.memo||e.type)}</td><td class="n">${money(e.amount)}</td></tr>`;
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Invoices and bills just after the year-end (cut-off)'))}</b><span class="muted">${esc(T('over'))} ${money(min)}</span></div><div class="tbl-wrap"><table><tbody>${cut.map(docRow).join('')||emptyRow(3,'None found','No invoices or bills over the threshold in the 45 days after the year-end.')}</tbody></table></div><div class="pad muted" style="font-size:12px">${esc(T('Check whether any of these are for goods or services of the year, and should be accrued.'))}</div></div>
    <div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Large transactions after the year-end'))}</b><span class="muted">${esc(T('over'))} ${money(min)}</span></div><div class="tbl-wrap"><table><tbody>${sub.map(entRow).join('')||emptyRow(3,'None found','No transactions over the threshold after the year-end.')}</tbody></table></div><div class="pad muted" style="font-size:12px">${esc(T('Consider whether any is a subsequent event to adjust for or disclose.'))}</div></div>`;
}
async function yfChecksClick(e,t,d,f){
  if(t.hasAttribute('data-yfbankcheck')){try{YF_BANK[f.id]=await api('GET',`/api/engagements/${encodeURIComponent(f.id)}/bankcheck`)}catch(err){toast(err.message,true)}renderMain();return true}
  if(d.yfbanktick){const w={...((f.wps||{}).A||{})};w.ticks={...(w.ticks||{}),[d.yfbanktick]:'agreed'};w.notes=(w.notes?w.notes+'\n':'')+`${(acct(d.yfbanktick)||{}).name||''}: agreed to the bank’s own balance at ${fmtDate(f.yearEnd)} through the bank feed (${fmtDate(today())}).`;
    if(await yfSave(f,{wps:{...(f.wps||{}),A:w}}))toast('Ticked as agreed to the bank');return true}
  return false;
}

/* ---------- the firm's year-ends on one screen ---------- */
let YE_LIST=null;
const yeAny=()=>!!(ME&&ME.role!=='client'&&(TallyPlans.EARLY.some(k=>(ME.firmEarly||[]).includes(k))||!TallyPlans.comingSoon('yearEndFiles')));
async function showYearEnds(){S.view='yearends';YE_LIST=null;renderMain();try{YE_LIST=await api('GET','/api/yearends')}catch(e){toast(e.message,true)}if(S.view==='yearends')renderMain()}
function vYearEnds(){
  if(!YE_LIST)return head('Year-ends','Loading…');
  const t=YE_LIST.today,list=YE_LIST.companies,soon=d=>{const n=Math.round((new Date(d)-new Date(t))/864e5);return n<0?`<span class="neg">${esc(T('overdue'))} ${-n} ${esc(T('days'))}</span>`:n<=30?`<span class="neg">${n} ${esc(T('days'))}</span>`:`<span class="muted">${n} ${esc(T('days'))}</span>`};
  const can=!(ME&&ME.readOnly);
  const startable=list.filter(c=>!c.locked&&!c.file);
  const rows=list.map(c=>{const f=c.file;
    return `<tr><td><input type="checkbox" data-yesel="${esc(c.id)}" ${!can||c.locked||f?'disabled':''} aria-label="Choose"></td><td><button class="link" data-yeopen="${esc(c.id)}" ${f?`data-file="${esc(f.id)}"`:''}>${esc(c.name)}</button>${c.locked?` <span class="pill quiet">${esc(T('Code needed'))}</span>`:''}</td><td>${esc(fmtDate(c.lastEnd))}</td>
      <td>${f?`<span class="pill ${f.status==='final'?'paid':f.status==='progress'?'open':'partial'}">${esc(T(TallyEngage.STATUS_LABEL[f.status]))}</span> <span class="muted">${f.pct}%</span>`:c.locked?'':`<span class="muted">${esc(T('Not started'))}</span>${c.previous&&c.previous.status==='final'?` <span class="pill quiet">${esc(T('Ready to roll forward'))}</span>`:''}`}</td>
      <td class="muted">${f?esc([f.preparer,f.reviewer].filter(Boolean).join(' / ')):''}</td><td class="n">${f&&f.openNotes?f.openNotes:''}</td><td class="n">${f?`${f.waiting?`<span title="${esc(T('Waiting for the client'))}">${f.waiting} ⏳</span>`:''}${f.answered?` <span title="${esc(T('Answered by the client'))}">${f.answered} ✉</span>`:''}`:''}</td>
      <td>${esc(fmtDate(c.deadlines.t2))}<div style="font-size:12px">${f&&f.status==='final'?'':soon(c.deadlines.t2)}</div></td><td class="muted" style="font-size:12.5px">${esc(fmtDate(c.deadlines.balance))}<br>${esc(T('CCPC'))}: ${esc(fmtDate(c.deadlines.balanceCcpc))}</td></tr>`}).join('');
  return head('Year-ends',`${list.length} ${esc(T('companies'))} · ${list.filter(c=>c.file&&c.file.status==='final').length} ${esc(T('final'))} · ${startable.length} ${esc(T('not started'))}`,
    can&&startable.length?`<button class="btn primary" data-yestart>${esc(T('Start the selected year-ends'))}</button>`:'')+
    `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th style="width:32px">${can&&startable.length?`<input type="checkbox" data-yeall aria-label="All">`:''}</th><th>${esc(T('Company'))}</th><th>${esc(T('Last year-end'))}</th><th>${esc(T('Status'))}</th><th>${esc(T('Preparer / reviewer'))}</th><th class="n">${esc(T('Open review notes'))}</th><th class="n">${esc(T('Client requests'))}</th><th>${esc(T('T2 due'))}</th><th>${esc(T('Balance due'))}</th></tr></thead><tbody>${rows||emptyRow(9,'No companies with year-end files','Year-end files are on for companies whose firm’s plan includes them.')}</tbody></table></div></div>
    <div class="muted" style="font-size:12.5px;margin-top:8px">${esc(T('T2 return: 6 months after the year-end. Balance of tax: 2 months after, or 3 for many Canadian-controlled private corporations. Check each corporation’s own deadlines.'))}</div>`;
}
async function yeListClick(e,t,d){
  if(d.yeopen){await openCompany(d.yeopen,'yearfiles');if(d.file){YF.open=d.file;YF.tab='ov'}renderMain();return true}
  if(t.hasAttribute('data-yeall')){$$('[data-yesel]:not(:disabled)').forEach(x=>x.checked=t.checked);return false}
  if(t.hasAttribute('data-yestart')){const ids=$$('[data-yesel]').filter(x=>x.checked).map(x=>x.dataset.yesel);
    if(!ids.length){toast('Choose the companies to start.',true);return true}
    if(!await confirmBox(`Start ${ids.length} year-end file${ids.length===1?'':'s'}?`,'Each one brings in the trial balance from the books. A company whose last file is final rolls forward from it. Nothing changes in the books.','Start'))return true;
    try{const r=await api('POST','/api/yearends/start',{companies:ids});const ok=r.results.filter(x=>x.ok),bad=r.results.filter(x=>!x.ok);
      toast(`${ok.length} started${ok.filter(x=>x.rolled).length?` (${ok.filter(x=>x.rolled).length} rolled forward)`:''}${bad.length?`; ${bad.length} skipped: ${bad.map(x=>`${x.name||x.id}: ${x.error}`).join('; ')}`:''}`,!!bad.length)}catch(err){toast(err.message,true)}
    await showYearEnds();return true}
  return false;
}

/* ---------- time, budget and billing ---------- */
function yfTime(f,edit){
  const list=(f.time||[]).slice().sort((a,b)=>b.date.localeCompare(a.date)),b=f.budget||{};
  const hrs=r2(list.reduce((t,x)=>t+x.hours,0)),val=r2(list.reduce((t,x)=>t+x.hours*x.rate,0)),unb=list.filter(x=>!x.billed),unbVal=r2(unb.reduce((t,x)=>t+x.hours*x.rate,0));
  const pct=(a,c)=>c>0?Math.round(a/c*100):0,bar=(a,c)=>c>0?`<div style="height:6px;background:var(--line);border-radius:3px;margin-top:6px"><div style="height:6px;width:${Math.min(100,pct(a,c))}%;background:${a>c?'var(--neg)':'var(--accent)'};border-radius:3px"></div></div>`:'';
  let h=`<div class="chips"><div class="chip"><div class="lbl">${esc(T('Hours'))}${b.hours?` / ${esc(T('budget'))} ${b.hours}`:''}</div><div class="val">${hrs}${b.hours?` <span class="muted" style="font-size:13px">${pct(hrs,b.hours)}%</span>`:''}</div>${bar(hrs,b.hours)}</div><div class="chip"><div class="lbl">${esc(T('Time at rates'))}${b.fee?` / ${esc(T('fee'))} ${money(b.fee)}`:''}</div><div class="val">${money(val)}</div>${bar(val,b.fee)}</div><div class="chip"><div class="lbl">${esc(T('Not invoiced yet'))}</div><div class="val">${money(unbVal)}</div></div></div>`;
  h+=`<div class="panel"><div class="toolbar" style="flex-wrap:wrap"><b class="grow">${esc(T('Time'))}</b>${edit?`<button class="btn sm" data-yfbudget>${esc(T('Budget'))}</button><button class="btn sm" data-yftime="new">+ ${esc(T('Time'))}</button>`:''}${unb.length||b.fee?`<button class="btn primary sm" data-yfbill>${esc(T('Invoice the client'))}</button>`:''}</div><div class="tbl-wrap"><table><thead><tr><th>${esc(T('Date'))}</th><th>${esc(T('Person'))}</th><th>${esc(T('Note'))}</th><th class="n">${esc(T('Hours'))}</th><th class="n">${esc(T('Rate'))}</th><th class="n">${esc(T('Amount'))}</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(fmtDate(x.date))}</td><td>${esc(x.name)}</td><td>${esc(x.note)}</td><td class="n">${x.hours}</td><td class="n">${money(x.rate)}</td><td class="n">${money(r2(x.hours*x.rate))}</td><td class="n">${x.billed?`<span class="pill paid">${esc(T('Invoiced'))}</span>`:edit?`<button class="btn sm" data-yftime="${esc(x.id)}">${esc(T('Edit'))}</button>`:''}</td></tr>`).join('')||emptyRow(7,'No time yet','Record time spent on this year-end, then invoice the client from your own Sumlora company.')}</tbody></table></div></div>`;
  return h;
}
function yfTimeForm(f,x){
  const team=S.team||[],b=f.budget||{},me=ME?ME.id:'';
  const m=openModal(x?'Time':'Add time',`<div class="fields">${fld('ytDate','Date',`<input type="date" id="ytDate" value="${esc(x?x.date:today())}">`)}${fld('ytWho','Person',`<select id="ytWho">${team.map(u=>`<option value="${esc(u.id)}" ${(x?x.userId:me)===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}</select>`)}${fld('ytHrs','Hours',`<input type="number" id="ytHrs" min="0.05" max="24" step="0.05" value="${esc(x?x.hours:'')}">`)}${fld('ytRate','Rate per hour',`<input type="number" id="ytRate" min="0" step="1" value="${esc(x?x.rate:b.rate||'')}">`)}${fld('ytNote','What was done',`<input type="text" id="ytNote" maxlength="500" value="${esc(x?x.note:'')}">`,true)}</div>`,
    `${x?'<button type="button" class="btn danger" data-ytdel>Delete</button>':''}<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`,'small');
  const dl=$('[data-ytdel]',m);if(dl)dl.onclick=async()=>{if(await yfSave(f,{time:(f.time||[]).filter(y=>y.id!==x.id)}))closeModal()};
  m.onsubmit=async e=>{e.preventDefault();const hours=+$('#ytHrs',m).value;if(!(hours>0&&hours<=24))return m.err('Enter the hours (up to 24).');
    const u=team.find(y=>y.id===$('#ytWho',m).value)||{id:me,name:ME?ME.name:''};
    const t={id:x?x.id:uid(),date:$('#ytDate',m).value||today(),userId:u.id,name:u.name,hours,rate:+$('#ytRate',m).value||0,note:$('#ytNote',m).value.trim(),billed:''};
    if(await yfSave(f,{time:(f.time||[]).filter(y=>y.id!==t.id).concat(t)}))closeModal()};
}
function yfBudgetForm(f){
  const b=f.budget||{};
  const m=openModal('Budget',`<div class="fields">${fld('ybH','Hours',`<input type="number" id="ybH" min="0" step="0.5" value="${esc(b.hours||'')}">`)}${fld('ybF','Fee',`<input type="number" id="ybF" min="0" step="10" value="${esc(b.fee||'')}">`)}${fld('ybR','Usual rate per hour',`<input type="number" id="ybR" min="0" step="1" value="${esc(b.rate||'')}">`)}</div>`,'<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>','small');
  m.onsubmit=async e=>{e.preventDefault();if(await yfSave(f,{budget:{hours:+$('#ybH',m).value||0,fee:+$('#ybF',m).value||0,rate:+$('#ybR',m).value||0}}))closeModal()};
}
/**
 * Invoice the client from the firm's own company in Sumlora: the time not invoiced yet (or the budgeted fee) goes onto a
 * new invoice there, opened for the accountant to check, choose the customer and save. The time is marked invoiced.
 */
function yfBillForm(f){
  const cos=(typeof CO_LIST!=='undefined'?CO_LIST:[]).filter(c=>!c.archived&&c.id!==CO);
  if(!cos.length){toast('Add your firm’s own company in Sumlora first, to invoice from it.',true);return}
  let saved='';try{saved=localStorage.getItem('sumlora-billing-co')||''}catch(e){}
  const unb=(f.time||[]).filter(x=>!x.billed),val=r2(unb.reduce((t,x)=>t+x.hours*x.rate,0)),fee=(f.budget||{}).fee||0;
  const m=openModal('Invoice the client',`<div class="fields">${fld('ybCo','Invoice from (your firm’s company)',`<select id="ybCo">${cos.map(c=>`<option value="${esc(c.id)}" ${c.id===saved?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`,true)}${fld('ybWhat','Amount',`<select id="ybWhat">${unb.length?`<option value="time">${esc(T('Time not invoiced yet'))}: ${money(val)} (${r2(unb.reduce((t,x)=>t+x.hours,0))} h)</option>`:''}${fee?`<option value="fee">${esc(T('The budgeted fee'))}: ${money(fee)}</option>`:''}</select>`,true)}</div><div class="muted" style="font-size:13px">${esc(T('Sumlora opens a new invoice in that company with these lines. Choose the customer, check the tax and save it there.'))}</div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Open the invoice</button>');
  m.onsubmit=async e=>{e.preventDefault();const co=$('#ybCo',m).value,what=$('#ybWhat',m).value;try{localStorage.setItem('sumlora-billing-co',co)}catch(err){}
    const who=(f.client&&f.client.legalName)||S.company.name,ye=fmtDate(f.yearEnd);
    const lines=what==='fee'?[{desc:`Year-end financial statements for ${who}, year ended ${ye}`,qty:1,rate:fee}]
      :Object.values(unb.reduce((g,x)=>{const k=x.rate;g[k]=g[k]||{desc:`Year-end work for ${who}, year ended ${ye}`,qty:0,rate:x.rate};g[k].qty=r2(g[k].qty+x.hours);return g},{}));
    if(what==='time'&&!await yfSave(f,{time:(f.time||[]).map(x=>x.billed?x:{...x,billed:today()})}))return;
    closeModal();
    await openCompany(co,'sales');
    const inc=sortAccts(S.accounts.filter(a=>a.type==='Income'&&a.active!==false)),acc=(inc.find(a=>/fee|service|professional|honoraires/i.test(a.name))||inc[0]||{}).id||'';
    docForm('invoice',null,{lines:lines.map(l=>({...l,account:acc,taxCode:'std'})),memo:`Year-end ${f.yearEnd}`,note:`<div class="banner"><span>${esc(T('From the year-end file of'))} ${esc(who)}. ${esc(T('Choose the customer and check the tax before saving.'))}</span></div>`});
  };
}
async function yfTimeClick(e,t,d,f){
  if(d.yftime){yfTimeForm(f,d.yftime==='new'?null:(f.time||[]).find(x=>x.id===d.yftime));return true}
  if(t.hasAttribute('data-yfbudget')){yfBudgetForm(f);return true}
  if(t.hasAttribute('data-yfbill')){yfBillForm(f);return true}
  return false;
}

/* ---------- T2125 summary for a proprietor's or partner's T1 ---------- */
function yfT2125Csv(f){
  const rows=TallyEngage.t2125(f,S.accounts);
  const csv='﻿'+[['T2125 line','Description','Amount'],...rows.map(r=>[r.line,r.label,r.amount.toFixed(2)])].map(r=>r.map(v=>{const s=String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');
  const safe=String(S.company.name||'company').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();
  saveFile(`${safe}-T2125-${f.yearEnd}.csv`,new Blob([csv],{type:'text/csv'}));
}

/* ---------- year-over-year chart ---------- */
/** Bars for each income statement leadsheet and the biggest balance sheet ones, this year against last year. */
function yfChart(f){
  const ls=TallyEngage.leadsheets(f,S.accounts),sign=l=>l.side==='bs'?(l.type==='Asset'?1:-1):(l.type==='Income'?-1:1);
  const items=ls.filter(l=>!['RE','SC'].includes(l.code)).map(l=>({code:l.code,label:l.label,cur:r2(sign(l)*l.final),prior:r2(sign(l)*l.prior)})).filter(x=>Math.abs(x.cur)+Math.abs(x.prior)>=0.005).sort((a,b)=>Math.max(Math.abs(b.cur),Math.abs(b.prior))-Math.max(Math.abs(a.cur),Math.abs(a.prior))).slice(0,10);
  if(!items.length)return'';
  const max=Math.max(...items.flatMap(x=>[Math.abs(x.cur),Math.abs(x.prior)]))||1,W=560,rowH=34,L=170,bw=W-L-90,H=items.length*rowH+30;
  const bars=items.map((x,i)=>{const y=i*rowH+24,w1=Math.abs(x.cur)/max*bw,w0=Math.abs(x.prior)/max*bw,ch=x.prior?Math.round((x.cur-x.prior)/Math.abs(x.prior)*100):null;
    return `<text x="${L-8}" y="${y+12}" text-anchor="end" font-size="12" fill="currentColor">${esc(x.code+' '+T(x.label)).slice(0,28)}</text><rect x="${L}" y="${y}" width="${w0.toFixed(1)}" height="10" rx="2" fill="var(--line-strong)"><title>${esc(T('Prior year'))}: ${money(x.prior)}</title></rect><rect x="${L}" y="${y+12}" width="${w1.toFixed(1)}" height="10" rx="2" fill="var(--accent)"><title>${esc(T('This year'))}: ${money(x.cur)}</title></rect><text x="${L+Math.max(w0,w1)+6}" y="${y+20}" font-size="11.5" fill="${ch===null?'currentColor':Math.abs(ch)>=20?'var(--neg)':'currentColor'}">${ch===null?'new':(ch>0?'+':'')+ch+'%'}</text>`}).join('');
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('This year against last year'))}</b><span class="muted" style="font-size:12.5px"><span style="display:inline-block;width:10px;height:10px;background:var(--line-strong);border-radius:2px"></span> ${esc(T('Prior year'))} <span style="display:inline-block;width:10px;height:10px;background:var(--accent);border-radius:2px;margin-left:8px"></span> ${esc(T('This year'))}</span></div><div class="pad" style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;min-width:420px" role="img" aria-label="${esc(T('This year against last year'))}">${bars}</svg></div></div>`;
}
