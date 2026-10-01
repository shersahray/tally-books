'use strict';
/* ---------- Sales tax: GST/HST and QST return worksheets, filing and payments ----------
 * The worksheet reads the tax account(s) for a period:
 *   sales (invoices, deposits)      -> tax collected       (GST/HST line 103, QST line 203)
 *   purchases (bills, expenses)     -> input tax credits   (line 106 / 206)
 *   journal entries                 -> adjustments         (104 and 107 / 204 and 207)
 *   sales tax payments (instalment) -> instalments paid    (110 / 210)
 * Filing a period saves a copy of its figures; paying or getting a refund posts a
 * "Sales tax payment" that clears the account.
 */
S.stax={tax:'gst',period:null,drill:'',manual:{}};

const TAX_LINES={
  gst:[
    ['90','Taxable sales made in Canada (including zero-rated supplies in Canada)','s90'],
    ['91','Exempt supplies, zero-rated exports and other sales and revenue','s91'],
    ['','Zero-rated exports (for example, US customers)','sExport','sub'],
    ['','Exempt supplies','sExempt','sub'],
    ['','Other revenue with no sales tax','sOther','sub'],
    ['101','Total sales and other revenue','=90+91'],
    ['103','GST/HST collected or collectible','collected'],
    ['104','Adjustments to be added to net tax','addAdj'],
    ['105','Total GST/HST and adjustments for period','=103+104'],
    ['106','GST/HST paid on qualifying expenses (input tax credits)','itc'],
    ['107','Adjustments to be deducted when determining net tax','dedAdj'],
    ['108','Total ITCs and adjustments','=106+107'],
    ['109','Net tax','=105-108'],
    ['110','Instalments and other annual filer payments made','instal'],
    ['111','Total GST/HST rebates','m:111'],
    ['112','Total other credits','=110+111'],
    ['113A','Balance','=109-112'],
    ['205','GST/HST due on real property or emission allowances','m:205'],
    ['405','Other GST/HST to be self-assessed','m:405'],
    ['113B','Total other debits','=205+405'],
    ['113C','Balance (positive: amount owing, negative: refund)','=113A+113B'],
  ],
  qst:[
    ['101','Total supplies (same as the GST/HST part)','sales'],
    ['203','QST collected or collectible','collected'],
    ['204','Adjustments to be added','addAdj'],
    ['205','Total QST and adjustments','=203+204'],
    ['206','Input tax refunds (ITRs)','itc'],
    ['207','Adjustments to be deducted','dedAdj'],
    ['208','Total ITRs and adjustments','=206+207'],
    ['209','Net tax','=205-208'],
    ['210','Instalments paid','instal'],
    ['211','Other credits and rebates','m:211'],
    ['213','Balance (positive: amount owing, negative: refund)','=209-210-211'],
  ],
};
const BAL_LINE={gst:'113C',qst:'213'};
// In Quebec, Revenu Québec administers the GST as well as the QST for most businesses.
const AGENCY={get gst(){return S.company.province==='QC'?'Revenu Québec':'CRA'},qst:'Revenu Québec'};
const SALE_TYPES=new Set(['invoice','deposit','payment']),BUY_TYPES=new Set(['bill','expense','billpayment']);

const taxesInUse=()=>byDetail('qst')&&+S.company.qstRate>0?['gst','qst']:['gst'];
const taxLabel=k=>k==='qst'?'QST':(taxesInUse().length>1?'GST':(S.company.taxName||'GST/HST'));
const taxAcctFor=k=>k==='qst'?byDetail('qst'):byDetail('tax');
const taxAcctIds=()=>new Set(S.accounts.filter(a=>a.detail==='tax'||a.detail==='qst').map(a=>a.id));

/* ---------- periods ---------- */
function filingPeriods(){
  const step={monthly:1,quarterly:3,annual:12}[S.company.filingFreq||'quarterly']||3;
  const ids=taxAcctIds();
  let first=today();
  // Opening balances brought over from other software aren't sales tax activity in Tally Books.
  for(const e of S.entries)if(!e.opening&&e.date<first&&(e.lines||[]).some(l=>ids.has(l.account)))first=e.date;
  for(const f of S.filings)if(f.from<first)first=f.from;
  const out=[];let d=pd(fyStartOf(first));const end=pd(today());
  while(d<=end&&out.length<400){
    const to=new Date(d.getFullYear(),d.getMonth()+step,0);
    const due=new Date(to.getFullYear(),to.getMonth()+(step===12?4:2),0); // 1 month after (3 for annual filers)
    if(iso(to)>=first)out.push({from:iso(d),to:iso(to),due:iso(due)}); // skip periods before the first activity
    d=new Date(d.getFullYear(),d.getMonth()+step,1);
  }
  return out.reverse();
}
const filingFor=(k,from,to)=>S.filings.find(f=>f.tax===k&&f.from===from&&f.to===to);
const filedPeriodOn=(date,k)=>S.filings.find(f=>(!k||f.tax===k)&&f.from<=date&&date<=f.to);

/* ---------- worksheet ---------- */
function worksheet(k,from,to){
  const a=taxAcctFor(k);if(!a)return null;
  const v={collected:0,addAdj:0,itc:0,dedAdj:0,instal:0,sales:0,s90:0,s91:0,sExport:0,sExempt:0,sOther:0},src={collected:[],addAdj:[],itc:[],dedAdj:[],instal:[],sales:[],s90:[],s91:[],sExport:[],sExempt:[],sOther:[]};
  const push=(key,e,amt)=>{if(!amt)return;v[key]+=amt;src[key].push({e,amt})};
  const income=new Set(S.accounts.filter(x=>x.type==='Income').map(x=>x.id)),taxIds=taxAcctIds();
  for(const e of S.entries){
    if(e.date<from||e.date>to||e.opening)continue;
    let inc=0;const byCode={};
    // Older transactions have no tax code on their lines: taxed if the transaction charged sales tax.
    const legacy=(e.lines||[]).some(l=>taxIds.has(l.account)&&(+l.credit||0)>0)?'std':'none';
    for(const l of e.lines||[]){
      const dr=+l.debit||0,cr=+l.credit||0;
      if(income.has(l.account)){inc+=cr-dr;const code=l.taxCode||legacy;byCode[code]=(byCode[code]||0)+cr-dr}
      if(l.account!==a.id)continue;
      if(e.type==='taxpayment'){if(e.taxKind==='instalment'&&e.tax===k)push('instal',e,dr);continue}
      if(e.type==='journal'){push('addAdj',e,cr);push('dedAdj',e,dr)}
      else if(SALE_TYPES.has(e.type))push('collected',e,cr-dr);
      else if(BUY_TYPES.has(e.type))push('itc',e,dr-cr);
      else{push('collected',e,cr);push('itc',e,dr)}
    }
    if(inc)push('sales',e,inc);
    for(const[code,amt]of Object.entries(byCode)){
      if(!amt)continue;
      if(code==='std'||code==='zero')push('s90',e,amt);
      else{push('s91',e,amt);push(code==='export'?'sExport':code==='exempt'?'sExempt':'sOther',e,amt)}
    }
  }
  const filed=filingFor(k,from,to);
  const man=filed?filed.lines:(S.stax.manual[k+from]||{});
  const vals={};
  for(const[no,,how,sub]of TAX_LINES[k]){
    if(sub){vals['·'+how]=r2(v[how]);continue}
    if(how.startsWith('m:'))vals[no]=r2(+man[no]||0);
    else if(how.startsWith('=')){const parts=how.slice(1).split(/(?=[+-])/);vals[no]=r2(parts.reduce((s,p)=>{const sign=p[0]==='-'?-1:1;return s+sign*vals[p.replace(/^[+-]/,'')]},0))}
    else vals[no]=r2(v[how]);
  }
  return{account:a,vals:filed?filed.lines:vals,live:vals,src,filed};
}
function periodStatus(k,p){
  const f=filingFor(k,p.from,p.to);
  if(f)return{k:'paid',label:`Filed ${fmtDate(f.filedOn)}`};
  const t=today();
  if(p.to>=t)return{k:'quiet',label:'In progress'};
  if(p.due<t)return{k:'overdue',label:'Overdue'};
  if(daysBetween(t,p.due)<=14)return{k:'partial',label:`Due ${fmtDate(p.due)}`};
  return{k:'open',label:'Ready to file'};
}
function overdueReturns(){let n=0;for(const k of taxesInUse())for(const p of filingPeriods())if(periodStatus(k,p).k==='overdue'){const w=worksheet(k,p.from,p.to);if(w&&Object.values(w.live).some(x=>x))n++}return n}

/* ---------- views ---------- */
function vSalesTax(){
  const T=S.stax,taxes=taxesInUse();if(!taxes.includes(T.tax))T.tax='gst';
  const freq={monthly:'monthly',quarterly:'quarterly',annual:'annual'}[S.company.filingFreq||'quarterly'];
  let h=head('Sales tax',`Files ${freq}${S.company.bn?` · BN ${esc(S.company.bn)}`:''} · <button class="link" data-go="settings">Change in Settings</button>`,
    `<button class="btn" data-stact="instalment">Record instalment</button>`);
  if(S.company.province==='QC'&&!byDetail('qst'))h+=`<div class="banner"><span><b>Track GST and QST separately?</b> This Quebec company records both taxes in one account. Split them to get a separate QST return worksheet.</span><button class="btn sm" data-stact="split-qst">Set up QST account</button></div>`;
  if(!taxAcctFor('gst'))return h+`<div class="panel"><div class="empty"><b>No sales tax account</b>Add a Liability account with the detail “Sales tax payable” in Chart of accounts.</div></div>`;
  if(taxes.length>1)h+=`<div class="tabs" role="tablist">${taxes.map(k=>`<button role="tab" data-sttax="${k}" aria-selected="${T.tax===k}">${k==='qst'?'QST (Revenu Québec)':`GST (${AGENCY.gst})`}</button>`).join('')}</div>`;
  if(T.period){const[from,to]=T.period.split('|');return h+vWorksheet(T.tax,from,to)}
  const k=T.tax,periods=filingPeriods();
  const bal=r2(-rawBal(taxAcctFor(k).id));
  h+=`<div class="chips"><div class="chip"><div class="lbl">${esc(taxLabel(k))} account balance today</div><div class="val">${mcell(bal)}</div><div class="lbl">${bal>=0?`Owing to ${AGENCY[k]} if positive`:`Refund due from ${AGENCY[k]}`}</div></div>
    <div class="chip"><div class="lbl">Returns overdue</div><div class="val ${overdueReturns()?'neg':''}">${overdueReturns()}</div></div></div>`;
  return h+`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Period</th><th>Due</th><th class="n">Collected</th><th class="n">Credits (ITCs)</th><th class="n">Net tax</th><th>Status</th><th></th></tr></thead><tbody>${periods.length?periods.map(p=>{
    const w=worksheet(k,p.from,p.to),st=periodStatus(k,p),net=w.vals[k==='qst'?'209':'109'];
    const ln=k==='qst'?['203','206']:['103','106'];
    return `<tr class="click" data-stperiod="${p.from}|${p.to}"><td style="white-space:nowrap"><b>${fmtDate(p.from)} – ${fmtDate(p.to)}</b></td><td style="white-space:nowrap" class="${st.k==='overdue'?'neg':'muted'}">${fmtDate(p.due)}</td><td class="n">${money(w.vals[ln[0]])}</td><td class="n">${money(w.vals[ln[1]])}</td><td class="n"><b>${mcell(net)}</b></td><td><span class="pill ${st.k}">${st.label}</span></td><td class="n"><button class="btn sm" data-stperiod="${p.from}|${p.to}">${w.filed?'View':'Open worksheet'}</button></td></tr>`}).join(''):emptyRow(7,'No periods yet','Periods appear once there are transactions with sales tax.')}</tbody></table></div></div>
    <div class="muted" style="font-size:13px;margin-top:12px">Periods follow your fiscal year-end and filing frequency. A return is due one month after the period ends (three months for annual filers). These figures help you file; submit the return on ${k==='qst'||AGENCY.gst!=='CRA'?'Revenu Québec’s My Account for businesses':'CRA My Business Account or GST/HST NETFILE'}.</div>`;
}

function vWorksheet(k,from,to){
  const w=worksheet(k,from,to),T=S.stax,bl=BAL_LINE[k],bal=w.vals[bl];
  const filed=w.filed,st=periodStatus(k,filingPeriods().find(p=>p.from===from)||{from,to,due:to});
  const changed=filed&&TAX_LINES[k].some(([no,,how,sub])=>!sub&&!how.startsWith('m:')&&no in filed.lines&&Math.abs((w.live[no]||0)-(filed.lines[no]||0))>0.004);
  const drillable={sales:1,collected:1,addAdj:1,itc:1,dedAdj:1,instal:1,s90:1,s91:1,sExport:1,sExempt:1,sOther:1};
  let rows='';
  for(const[no,label,how,sub]of TAX_LINES[k]){
    if(sub){const val=w.vals['·'+how]||0;if(!val&&how!=='sExport')continue;
      rows+=`<tr class="subline"><td></td><td>${label}</td><td class="n">${val?`<button class="link" data-stdrill="${how}">${money(val)}</button>`:'<span class="muted">$0.00</span>'}</td></tr>`;
      if(T.drill===how)rows+=`<tr><td></td><td colspan="2">${drillTable(w.src[how])}</td></tr>`;continue}
    const total=how.startsWith('=')||no===bl,val=w.vals[no];
    let cell;
    if(how.startsWith('m:')&&!filed)cell=`<input type="number" step="0.01" data-stman="${no}" value="${val||''}" placeholder="0.00" style="width:130px" aria-label="Line ${no}">`;
    else if(drillable[how]&&val)cell=`<button class="link" data-stdrill="${how}">${money(val)}</button>`;
    else cell=mcell(val);
    rows+=`<tr class="${no===bl?'grand':total?'tot':'item'}"><td class="mono" style="width:60px">${no}</td><td>${label}</td><td class="n">${cell}</td></tr>`;
    if(T.drill===how&&drillable[how])rows+=`<tr><td></td><td colspan="2">${drillTable(w.src[how])}</td></tr>`;
  }
  const outcome=bal>0.004?`Amount owing to ${AGENCY[k]}: <b>${money(bal)}</b> (line ${k==='gst'?'115':bl})`:bal<-0.004?`Refund claimed from ${AGENCY[k]}: <b>${money(-bal)}</b> (line ${k==='gst'?'114':bl})`:'Nothing owing and no refund';
  const pay=filed&&filed.entryId?S.entries.find(e=>e.id===filed.entryId):null;
  return `<button class="btn ghost sm" data-stback style="margin-bottom:8px">← All periods</button>
  <div class="panel report" style="max-width:820px">
    ${rh(`${k==='qst'?'QST return':'GST/HST return'} worksheet`,`${fmtDate(from)} – ${fmtDate(to)}${S.company.bn?` · BN ${esc(S.company.bn)}`:''}`)}
    <div class="pad" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center"><span class="pill ${st.k}">${st.label}</span>${pay?`<span class="muted">${pay.taxKind==='refund'?'Refund received':'Paid'} ${fmtDate(pay.date)} · ${money(entryTotal(pay))}</span>`:''}</div>
    ${changed?`<div class="banner err" style="margin:0 16px 12px"><span>Transactions in this period changed after it was filed. The figures below are what you filed; the books now show net tax of ${money(w.live[k==='qst'?'209':'109'])}. You may need to file an amended return.</span></div>`:''}
    <div class="tbl-wrap"><table class="ws">${rows}</table></div>
    <div class="pad" style="text-align:center">${outcome}</div>
    <div class="toolbar" style="border-top:1px solid var(--line);border-bottom:0;justify-content:flex-end">
      <button class="btn sm" data-stact="export">Export CSV</button>
      ${filed?`${!filed.entryId&&Math.abs(filed.lines[bl])>0.004?`<button class="btn sm" data-stact="pay-later">Record ${filed.lines[bl]>0?'payment':'refund'}</button>`:''}<button class="btn sm danger" data-stact="unfile">Undo filing</button>`
        :to>=today()?`<span class="muted" style="font-size:13px">You can file once the period ends on ${fmtDate(to)}.</span>`
        :`<button class="btn sm primary" data-stact="file">Mark as filed${Math.abs(bal)>0.004?` and record ${bal>0?'payment':'refund'}`:''}</button>`}
    </div>
  </div>
  ${k==='qst'?'<div class="muted" style="font-size:13px;margin-top:10px">QST line numbers follow Revenu Québec’s FPZ-500 return. Check them against the current form before filing.</div>':''}`;
}
function drillTable(items){
  if(!items.length)return '';
  const tot=r2(items.reduce((s,x)=>s+x.amt,0));
  return `<div class="tbl-wrap" style="border:1px solid var(--line);border-radius:6px;margin:4px 0 10px"><table><tbody>${items.sort((a,b)=>a.e.date.localeCompare(b.e.date)).map(({e,amt})=>`<tr class="click" data-entry="${e.id}"><td style="white-space:nowrap">${fmtDate(e.date)}</td><td>${TLABEL[e.type]||e.type}${e.ref?` <span class="mono muted">#${esc(e.ref)}</span>`:''}</td><td class="trunc">${esc(contactName(e.contactId)||e.memo||'')}</td><td class="n">${mcell(amt)}</td></tr>`).join('')}<tr><td colspan="3" class="muted">${items.length} transaction${items.length===1?'':'s'}</td><td class="n"><b>${money(tot)}</b></td></tr></tbody></table></div>`;
}

/* ---------- actions ---------- */
async function stClick(ev,t,d){
  const T=S.stax;
  if(d.sttax){T.tax=d.sttax;T.drill='';renderMain();return true}
  if(d.stperiod){ev.stopPropagation();T.period=d.stperiod;T.drill='';renderMain();window.scrollTo(0,0);return true}
  if(t.hasAttribute('data-stback')){T.period=null;T.drill='';renderMain();return true}
  if(d.stdrill){T.drill=T.drill===d.stdrill?'':d.stdrill;renderMain();return true}
  const[from,to]=(T.period||'|').split('|');
  switch(d.stact){
    case 'instalment':instalmentForm();return true;
    case 'split-qst':await splitQst();return true;
    case 'file':fileForm(T.tax,from,to,true);return true;
    case 'pay-later':fileForm(T.tax,from,to,false);return true;
    case 'unfile':await unfile(T.tax,from,to);return true;
    case 'export':{const w=worksheet(T.tax,from,to);const rows=[['Line','Description','Amount'],...TAX_LINES[T.tax].map(([no,label,how,sub])=>sub?['',`  of line 91: ${label}`,w.vals['·'+how]||0]:[no,label,w.vals[no]])];
      saveFile(`${T.tax==='qst'?'qst':'gst-hst'}-return_${from}_${to}.csv`,new Blob(['﻿'+rows.map(r=>r.map(v=>/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:v).join(',')).join('\r\n')],{type:'text/csv'}));return true}
  }
  return false;
}
function bindSalesTax(m){
  $$('[data-stman]',m).forEach(inp=>inp.onchange=()=>{const T=S.stax,[from]=T.period.split('|'),key=T.tax+from;T.manual[key]={...(T.manual[key]||{}),[inp.dataset.stman]:+inp.value||0};renderMain()});
}

function payEntry(k,kind,amount,bank,date,from,to){
  const a=taxAcctFor(k);
  const lines=kind==='refund'?[{account:bank,debit:amount,credit:0},{account:a.id,debit:0,credit:amount}]:[{account:a.id,debit:amount,credit:0},{account:bank,debit:0,credit:amount}];
  const what=kind==='instalment'?'instalment':kind==='refund'?'refund':'payment';
  return{type:'taxpayment',tax:k,taxKind:kind,period:from?{from,to}:null,date,ref:'',memo:`${taxLabel(k)} ${what}${from?` for ${fmtDate(from)} – ${fmtDate(to)}`:''}`,contactId:'',lines,created:Date.now()};
}
function fileForm(k,from,to,filing){
  const w=worksheet(k,from,to),bl=BAL_LINE[k],bal=filing?w.vals[bl]:w.filed.lines[bl],kind=bal<0?'refund':'payment';
  const banks=sortAccts(S.accounts.filter(a=>a.detail==='bank'&&a.active!==false));
  const needMoney=Math.abs(bal)>0.004;
  const f=openModal(filing?`File ${k==='qst'?'QST':'GST/HST'} return`:`Record ${kind}`,`
    <div class="muted">${fmtDate(from)} – ${fmtDate(to)} · ${needMoney?(kind==='refund'?`refund of <b>${money(-bal)}</b> from ${AGENCY[k]}`:`<b>${money(bal)}</b> owing to ${AGENCY[k]}`):'nothing owing'}</div>
    <div class="fields">
      ${filing?fld('fOn','Date filed',`<input type="date" id="fOn" value="${today()}">`):''}
      ${needMoney?fld('fBank',kind==='refund'?'Deposited to':'Paid from',`<select id="fBank">${banks.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>`):''}
      ${needMoney?fld('fDate',kind==='refund'?'Date received':'Payment date',`<input type="date" id="fDate" value="${today()}">`):''}
      ${needMoney?fld('fAmt','Amount',`<input type="number" id="fAmt" step="0.01" value="${Math.abs(bal).toFixed(2)}">`):''}
    </div>
    ${needMoney&&filing?`<label class="check"><input type="checkbox" id="fNow" ${kind==='payment'?'checked':''}> Record the ${kind} now ${kind==='refund'?'(leave unticked until the refund arrives)':''}</label>`:''}
    <div class="muted" style="font-size:13px">${filing?'Filing saves a copy of these figures. If transactions in this period change later, the worksheet warns you.':''} The ${kind} is recorded as a sales tax payment that clears the ${esc(taxAcctFor(k).name)} account.</div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${filing?'Mark as filed':'Record '+kind}</button>`);
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const writes=[];let entryId=w.filed?.entryId||'';
    const now=needMoney&&(!filing||$('#fNow',f).checked);
    if(now){
      if(!banks.length)return f.err('Add a bank account first.');
      const amt=r2($('#fAmt',f).value);if(!(amt>0))return f.err('Enter the amount.');
      entryId=uid();writes.push({op:'set',collection:'entries',id:entryId,data:payEntry(k,kind,amt,$('#fBank',f).value,$('#fDate',f).value||today(),from,to)});
    }
    if(filing)writes.push({op:'set',collection:'filings',id:uid(),data:{tax:k,from,to,lines:w.vals,filedOn:$('#fOn',f).value||today(),entryId,created:Date.now()}});
    else writes.push({op:'set',collection:'filings',id:w.filed.id,data:{...w.filed,entryId}});
    if(await batch(writes)){closeModal();toast(filing?'Return marked as filed':`${kind==='refund'?'Refund':'Payment'} recorded`)}
  };
}
async function unfile(k,from,to){
  const f=filingFor(k,from,to);if(!f)return;
  const pay=f.entryId?S.entries.find(e=>e.id===f.entryId):null;
  if(!await confirmBox('Undo this filing?',`The period goes back to not filed${pay?`, and the ${pay.taxKind==='refund'?'refund':'payment'} of ${money(entryTotal(pay))} on ${fmtDate(pay.date)} is deleted`:''}. Use this if you marked it filed by mistake.`,'Undo filing'))return;
  const w=[{op:'delete',collection:'filings',id:f.id}];if(pay)w.push({op:'delete',collection:'entries',id:pay.id});
  if(await batch(w))toast('Filing undone');
}
function instalmentForm(){
  const banks=sortAccts(S.accounts.filter(a=>a.detail==='bank'&&a.active!==false)),taxes=taxesInUse();
  const f=openModal('Record instalment',`<div class="fields">
    ${taxes.length>1?fld('iTax','Tax',`<select id="iTax">${taxes.map(k=>`<option value="${k}">${k==='qst'?'QST':'GST'}</option>`).join('')}</select>`):''}
    ${fld('iDate','Date paid',`<input type="date" id="iDate" value="${today()}">`)}${fld('iAmt','Amount',`<input type="number" id="iAmt" step="0.01">`)}
    ${fld('iBank','Paid from',`<select id="iBank">${banks.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>`)}</div>
    <div class="muted" style="font-size:13px">Instalments reduce the balance on the return for the period they’re paid in (line ${taxes.length>1?'110 or 210':'110'}).</div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Record instalment</button>`);
  f.onsubmit=async e=>{e.preventDefault();const amt=r2($('#iAmt',f).value);if(!(amt>0))return f.err('Enter the amount paid.');if(!banks.length)return f.err('Add a bank account first.');
    const k=$('#iTax',f)?.value||'gst';
    if(await batch([{op:'set',collection:'entries',id:uid(),data:payEntry(k,'instalment',amt,$('#iBank',f).value,$('#iDate',f).value||today())}])){closeModal();toast('Instalment recorded')}};
}
async function splitQst(){
  if(!await confirmBox('Set up a separate QST account?','New transactions will post GST (5%) and QST (9.975%) to separate accounts, and you’ll get a QST return worksheet. Tax already recorded stays in the current account; move the QST part with a journal entry if you need past periods split.','Set up QST'))return;
  const main=byDetail('tax'),id=acct('a2210')?uid():'a2210';
  const writes=[{op:'set',collection:'accounts',id,data:{code:S.accounts.some(a=>a.code==='2210')?'':'2210',name:'QST payable',type:'Liability',detail:'qst',desc:'',active:true}}];
  if(main)writes.push({op:'set',collection:'accounts',id:main.id,data:{...main,name:'GST payable'}});
  if(await batch(writes)&&await putCompany({...strip(S.company),taxName:'GST/QST',taxRate:14.975,qstRate:9.975}))toast('QST is now tracked separately');
}

/* Warn before changing a transaction in a period whose return was filed. */
function filedWarning(entries){
  const ids=taxAcctIds();
  for(const e of entries){
    if(!e||e.type==='taxpayment'||!(e.lines||[]).some(l=>ids.has(l.account)))continue;
    const f=filedPeriodOn(e.date);if(f)return f;
  }
  return null;
}
