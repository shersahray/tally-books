'use strict';
/* ---------- Bring a client over from QuickBooks Online or Sage ----------
   Reads the exported reports (convert-parse.js), shows what will come in and whether it ties out,
   then imports everything in one go (POST /api/import, all or nothing). */
const CV_SOURCES={qbo:'QuickBooks Online',sage50:'Sage 50',sageacc:'Sage Accounting',other:'Another program'};
const CV_HELP={
  qbo:[
    'Reports → Account List: export to Excel.',
    'Reports → Trial Balance, as of the day before you start in Tally Books (usually the last fiscal year-end): export to Excel.',
    'Reports → A/R Aging Detail (or Open Invoices) and A/P Aging Detail (or Unpaid Bills), as of the same date.',
    'Reports → Customer Contact List and Vendor Contact List.',
    'Optional: Reports → Journal, from the day after the trial balance date to today, to bring this year’s transactions.',
  ],
  sage50:[
    'Reports → Lists → Chart of Accounts, then export it (File → Export, to Excel or a CSV file).',
    'Reports → Financials → Trial Balance, as at the day before you start in Tally Books (usually the last fiscal year-end).',
    'Customer Aged Detail and Vendor Aged Detail reports, as at the same date.',
    'Customer and Vendor lists (Reports → Lists).',
    'Optional: All Journal Entries, from the day after the trial balance date to today, to bring this year’s transactions.',
  ],
  sageacc:[
    'Settings → Chart of Accounts: export.',
    'Reporting → Trial Balance, as at the day before you start in Tally Books: export as CSV.',
    'Aged Debtors and Aged Creditors (detailed), as at the same date.',
    'Contacts: export customers and suppliers.',
    'Optional: the Journals or Audit trail report, from the day after the trial balance date to today.',
  ],
  other:[
    'A chart of accounts (account number, name and type).',
    'A trial balance as of the day before you start in Tally Books.',
    'Open invoices and unpaid bills as of the same date.',
    'Customer and vendor lists.',
    'Optional: a journal with each transaction’s date, account, debit and credit.',
  ],
};
const cvNew=()=>({source:'qbo',tables:[],dateFormat:'auto',date:'',replaceStarter:!S.entries.some(e=>!e.example),useJournal:true,edits:{},busy:false,done:null,reading:false});
S.cv=null;
// Unzip with a size limit, so a booby-trapped file can't fill the browser's memory.
const cvInflate=async b=>{
  const r=new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts=[];let n=0;
  for(;;){const{done,value}=await r.read();if(done)break;n+=value.length;if(n>150*1024*1024){r.cancel();throw new Error('A file inside is too large to read.')}parts.push(value)}
  const out=new Uint8Array(n);let o=0;for(const x of parts){out.set(x,o);o+=x.length}return out;
};

function cvPlan(){
  const C=S.cv;
  const tables=C.tables.filter(t=>t.kind!=='ignore');
  if(!tables.length)return null;
  const tb=tables.find(t=>t.kind==='tb');
  if(!C.date&&tb&&tb.asOf)C.date=tb.asOf;
  const p=Convert.plan(tables,{accounts:S.accounts,contacts:S.contacts,entries:S.entries},{date:C.date,dateFormat:C.dateFormat});
  for(const a of p.accounts){const e=C.edits[a.key];if(e&&!a.matchId)Object.assign(a,e)}
  p.useJournal=C.useJournal;
  return p;
}
async function cvAddFiles(files){
  const C=S.cv;C.reading=true;renderMain();
  for(const f of files){
    try{
      if(f.size>60*1024*1024)throw new Error(`${f.name} is too large.`);
      const tables=await Convert.readFile(f.name,new Uint8Array(await f.arrayBuffer()),cvInflate);
      if(!tables.length)toast(`Nothing Tally Books can read was found in ${f.name}.`,true);
      for(const t of tables){const c=Convert.classify(t);C.tables.push({...t,...c,id:uid(),from:f.name})}
    }catch(e){toast(e.message,true)}
  }
  C.reading=false;renderMain();
}

function cvWarn(w){
  const m=v=>money(v);
  switch(w.code){
    case 'tb-many':return 'More than one trial balance was chosen. Only the first one is used.';
    case 'tb-computed':return `“${w.name}” on the trial balance (${m(w.amount)}) is worked out from income and expenses, so it isn’t brought over. Tally Books works it out the same way.`;
    case 'tb-date':return 'Enter the date of the trial balance.';
    case 'tb-unbalanced':return Math.abs(w.diff)<=1?`The trial balance is off by ${m(w.diff)} (rounding). The difference goes to Opening balance equity.`:`The trial balance doesn’t balance (off by ${m(w.diff)}). Check that the file is the whole trial balance.`;
    case 'ar-credits':return w.count===1?`1 payment or credit on the receivables report (${m(w.total)}) isn’t applied to an invoice, so it isn’t brought over as an item. It’s still in the Accounts receivable balance.`:`${w.count} payments or credits on the receivables report (${m(w.total)}) aren’t applied to an invoice, so they aren’t brought over as items. They’re still in the Accounts receivable balance.`;
    case 'ap-credits':return w.count===1?`1 payment or credit on the payables report (${m(w.total)}) isn’t applied to a bill, so it isn’t brought over as an item. It’s still in the Accounts payable balance.`:`${w.count} payments or credits on the payables report (${m(w.total)}) aren’t applied to a bill, so they aren’t brought over as items. They’re still in the Accounts payable balance.`;
    case 'ar-noname':case 'ap-noname':return `${w.count} open item${w.count===1?' has':'s have'} no ${w.code==='ar-noname'?'customer':'vendor'} name, so ${w.count===1?'it comes':'they come'} in without one.`;
    case 'ar-diff':return `Open invoices add up to ${m(w.open)}, but Accounts receivable on the trial balance is ${m(w.tb)}. Check that both reports are as of the same date.`;
    case 'ap-diff':return `Unpaid bills add up to ${m(w.open)}, but Accounts payable on the trial balance is ${m(w.tb)}. Check that both reports are as of the same date.`;
    case 'journal-unbalanced':return `${w.count===1?'1 transaction in the journal doesn’t balance':`${w.count} transactions in the journal don’t balance`}${(w.first||[]).length?` (${w.first.map(x=>[x.date?fmtDate(x.date):'',x.num].filter(Boolean).join(' ')).filter(Boolean).join('; ')})`:''}. Check the journal export covers whole transactions, then choose it again.`;
    case 'ar-date':case 'ap-date':return `The ${w.code==='ar-date'?'open invoices':'unpaid bills'} report is as of ${fmtDate(w.asOf)}, but it needs to be as of ${fmtDate(w.want)}${w.history?' (the last day of the transaction history) or later':' (the trial balance date)'}.`;
    case 'already-imported':return 'Opening balances were already brought into these books. Importing a trial balance again would double them. Remove the trial balance file, or start a new company.';
    case 'ar-missing':return `The trial balance has ${money(w.tb)} in Accounts receivable, but no open invoices report was chosen, so there won’t be invoices to receive payments against.`;
    case 'ap-missing':return `The trial balance has ${money(w.tb)} in Accounts payable, but no unpaid bills report was chosen, so there won’t be bills to pay against.`;
    case 'gl':return 'A General Ledger report was chosen. Tally Books uses the Journal report for transaction history instead, because the General Ledger lists each transaction more than once.';
    case 'tb-after-history':return `The trial balance (as of ${fmtDate(w.tb)}) must be dated before the first transaction in the history (${fmtDate(w.from)}), or those transactions would count twice.`;
    case 'no-ar':return 'There are open invoices but no Accounts receivable account. Add one to the chart of accounts, or set an account’s detail to Accounts receivable below.';
    case 'no-ap':return 'There are unpaid bills but no Accounts payable account. Add one, or set an account’s detail to Accounts payable below.';
    default:return w.code;
  }
}

function vConvert(){
  if(!S.cv)S.cv=cvNew();
  const C=S.cv;
  if(ME&&ME.role==='client')return head('Bring over books')+`<div class="panel"><div class="empty"><b>Your bookkeeper does this</b></div></div>`;
  if(C.done)return head('Bring over from QuickBooks or Sage')+`<div class="panel" style="max-width:720px"><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <h3 style="margin:0">Done: the books are in Tally Books</h3>
    <div>${Object.entries(C.done.counts).map(([k,v])=>`<div>${({accounts:`${v} accounts`,contacts:`${v} customers and vendors`,entries:`${v} transactions`,docs:`${v} open invoices and bills`})[k]||v+' '+k}</div>`).join('')}</div>
    <div class="muted">${C.done.date?`Next: run the trial balance as of ${fmtDate(C.done.date)} and compare it with the one from the other program, then import bank statements from the day after.`:'Next: run the trial balance and compare it with the one from the other program, then import bank statements.'}</div>
    <div class="actions"><button class="btn primary" data-cvgo="reports">Open reports</button><button class="btn" data-cvgo="sales">Open invoices</button><button class="btn" data-cvact="again">Bring over more</button></div></div></div>`;
  const p=cvPlan();
  const hasTB=C.tables.some(t=>t.kind==='tb'),amb=C.tables.some(t=>t.kind!=='ignore'&&t.header>=0&&Convert.ambiguousDates(t,t.header));
  let h=head('Bring over from QuickBooks or Sage','Bring a client’s chart of accounts, customers and vendors, opening balances, open invoices and bills, and (if you like) this year’s transactions into these books.');
  // 1. Source and what to export
  h+=`<div class="panel" style="max-width:900px"><h3>1. Export the reports</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="actions">${Object.entries(CV_SOURCES).map(([k,v])=>`<button class="btn sm ${C.source===k?'primary':''}" data-cvsrc="${k}">${esc(v)}</button>`).join('')}</div>
    <ol class="steps">${CV_HELP[C.source].map(x=>`<li>${esc(x)}</li>`).join('')}</ol>
    <div class="muted" style="font-size:13px">Excel (.xlsx) and CSV files both work, and so does a .zip of them. Use the same date for the trial balance and the open invoices and bills. Nothing is changed in the other program.</div>
  </div></div>`;
  // 2. Files
  h+=`<div class="panel" style="max-width:900px;margin-top:16px"><h3>2. Choose the files</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div><label class="btn primary ${C.reading?'disabled':''}"><input type="file" multiple accept=".csv,.txt,.xlsx,.xls,.zip" data-cvfile hidden>${C.reading?'Reading…':'Choose files'}</label></div>
    ${C.tables.length?`<div class="tbl-wrap"><table><thead><tr><th>File</th><th>What it is</th><th class="n">Rows</th><th></th></tr></thead><tbody>${C.tables.map(t=>`<tr><td><span translate="no">${esc(t.name)}</span>${t.title?`<div class="muted" style="font-size:12px" translate="no">${esc(t.title.slice(0,120))}</div>`:''}</td>
      <td><select data-cvkind="${t.id}">${Convert.KINDS.map(k=>`<option value="${k}" ${t.kind===k?'selected':''}>${esc(Convert.KIND_LABEL[k])}</option>`).join('')}</select>${t.header<0&&t.kind!=='ignore'?'<div class="neg" style="font-size:12px">No column headings found in this file.</div>':''}</td>
      <td class="n">${Math.max(0,t.rows.length-(t.header+1))}</td><td class="n"><button class="btn sm ghost" data-cvrm="${t.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`:''}
    ${C.tables.length?`<div class="fields">
      ${fld('cvDate','Conversion date (trial balance date)',`<input type="date" id="cvDate" value="${esc(C.date)}"><span class="hint">Opening balances, open invoices and open bills are as of this date.</span>`)}
      ${amb||C.dateFormat!=='auto'?fld('cvFmt','Dates in these files are written',`<select id="cvFmt"><option value="auto" ${C.dateFormat==='auto'?'selected':''}>Choose…</option><option value="mdy" ${C.dateFormat==='mdy'?'selected':''}>Month/day/year (12/31/2025)</option><option value="dmy" ${C.dateFormat==='dmy'?'selected':''}>Day/month/year (31/12/2025)</option><option value="ymd" ${C.dateFormat==='ymd'?'selected':''}>Year-month-day (2025-12-31)</option></select><span class="hint">Some dates could be read either way. Check one in the other program.</span>`):''}
    </div>`:''}
  </div></div>`;
  if(!p)return h;
  // 3. Accounts
  const errs=[...p.errors],warns=p.warnings;
  if(amb&&C.dateFormat==='auto')errs.push({code:'date-format'});
  const tOpts=(a)=>TYPES.map(t=>`<option ${a.type===t?'selected':''}>${t}</option>`).join('');
  const dOpts=(a)=>(DETAILS[a.type]||[]).map(([k,v])=>`<option value="${k}" ${(a.detail||'')===k?'selected':''}>${esc(v)}</option>`).join('');
  h+=`<div class="panel" style="margin-top:16px"><h3>3. Check the accounts</h3><div class="pad muted" style="font-size:13px;padding-bottom:0">Each account’s type was worked out from the other program. Change any that look wrong; bank and credit card accounts need the right detail so statements can be imported into them.</div>
    <div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Account</th><th>Before</th><th>Type</th><th>Detail</th><th class="n">${p.tb&&p.tb.date?`Balance ${fmtDate(p.tb.date)}`:'Balance'}</th><th></th></tr></thead><tbody>
    ${p.accounts.map(a=>`<tr><td class="mono" translate="no">${esc(a.number)}</td><td translate="no">${esc(a.name)}${a.fullName!==a.name?`<div class="muted" style="font-size:12px">${esc(a.fullName)}</div>`:''}</td><td class="muted" translate="no">${esc([a.srcType,a.srcDetail].filter(Boolean).join(' · '))}</td>
      <td>${a.matchId?esc(a.type):`<select data-cvtype="${esc(a.key)}">${tOpts(a)}</select>`}</td><td>${a.matchId?esc(detailLabel(a)):`<select data-cvdet="${esc(a.key)}">${dOpts(a)}</select>`}</td>
      <td class="n">${a.balance?money(a.balance):''}</td><td>${a.matchId?`<span class="pill paid" title="${esc(acctName(a.matchId))}">${a.rename?'Uses this company’s account':'Already here'}</span>`:'<span class="pill open">New</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="pad"><label class="check"><input type="checkbox" id="cvStarter" ${C.replaceStarter?'checked':''}> Remove the starter accounts these books came with, if nothing uses them</label></div></div>`;
  // 4. Summary and checks
  const debits=p.tb?r2(p.tb.lines.filter(l=>l.amount>0).reduce((s,l)=>s+l.amount,0)):0;
  const newA=p.accounts.filter(a=>!a.matchId).length;
  const sumItems=list=>r2(list.reduce((s,i)=>s+i.open,0));
  h+=`<div class="panel" style="margin-top:16px;max-width:900px"><h3>4. What comes in</h3><div class="pad" style="display:flex;flex-direction:column;gap:10px">
    <table class="boxes"><tbody>
      <tr><td>Accounts</td><td>${p.accounts.length} (${newA} new)</td></tr>
      <tr><td>Customers and vendors</td><td>${p.contacts.filter(c=>c.kind==='customer').length} customers, ${p.contacts.filter(c=>c.kind==='vendor').length} vendors</td></tr>
      <tr><td>Opening balances</td><td>${p.tb?`${p.tb.lines.length} accounts as of ${p.tb.date?fmtDate(p.tb.date):'?'} · debits and credits ${money(debits)}`:'<span class="muted">No trial balance chosen</span>'}</td></tr>
      <tr><td>Open invoices</td><td>${p.open.ar.length?`<span>${p.open.ar.length} · ${money(sumItems(p.open.ar))}</span>${p.tb?` <span class="muted">(Accounts receivable ${money(p.totals.arTB)})</span>`:''}`:'<span class="muted">None</span>'}</td></tr>
      <tr><td>Unpaid bills</td><td>${p.open.ap.length?`<span>${p.open.ap.length} · ${money(sumItems(p.open.ap))}</span>${p.tb?` <span class="muted">(Accounts payable ${money(p.totals.apTB)})</span>`:''}`:'<span class="muted">None</span>'}</td></tr>
      <tr><td>Transaction history</td><td>${p.journal?`<label class="check"><input type="checkbox" id="cvJournal" ${C.useJournal?'checked':''}> ${p.journal.txns.length} transactions, ${p.journal.from?fmtDate(p.journal.from):''} to ${p.journal.to?fmtDate(p.journal.to):''}</label>`:'<span class="muted">None (optional)</span>'}</td></tr>
    </tbody></table>
    ${!hasTB?'<div class="banner" style="margin:0"><span>Without a trial balance, account balances start at zero, and open invoices and bills are balanced against Opening balance equity.</span></div>':''}
    ${errs.length?`<div class="banner err" style="margin:0;display:block">${errs.map(e=>`<div>${esc(e.code==='date-format'?'Choose how dates are written in these files (above).':cvWarn(e))}</div>`).join('')}</div>`:''}
    ${warns.length?`<div class="banner" style="margin:0;display:block">${warns.map(w=>`<div>${esc(cvWarn(w))}</div>`).join('')}</div>`:''}
    ${p.tb&&!errs.length?'<div class="muted" style="font-size:13px">Open invoices and bills come in as items you can receive and make payments against. They don’t change Accounts receivable or payable, which already come from the trial balance.</div>':''}
    <div class="actions"><button class="btn primary" data-cvact="import" ${errs.length||C.busy?'disabled':''}>${C.busy?'Importing…':`Import into <span translate="no">${esc(S.company.name)}</span>`}</button></div>
    <div class="muted" style="font-size:12.5px">Everything comes in together, or nothing does. A copy of these books as they are now is kept on the server first.</div>
  </div></div>`;
  return h;
}

async function cvImport(){
  const C=S.cv,p=cvPlan();if(!p||p.errors.length)return;
  if(!await confirmBox(`Import into ${S.company.name}?`,`Accounts, customers and vendors, opening balances, open invoices and bills${p.journal&&C.useJournal?', and the transaction history':''} will be added to these books.`,'Import'))return;
  const used=new Set();S.entries.forEach(e=>(e.lines||[]).forEach(l=>used.add(l.account)));S.bankTxns.forEach(b=>used.add(b.account));S.rules.forEach(r=>used.add(r.account));
  let writes;
  try{writes=Convert.build(p,{accounts:S.accounts,contacts:S.contacts},{uid,label:CV_SOURCES[C.source],replaceStarter:C.replaceStarter,used})}catch(e){toast(e.message,true);return}
  C.busy=true;renderMain();
  try{
    const r=await api('POST','/api/import',{writes,source:CV_SOURCES[C.source]});
    C.busy=false;C.done={counts:r.counts,date:p.tb&&p.tb.date};await load();toast('Import finished');
  }catch(e){C.busy=false;renderMain();toast(e.message,true)}
}
function cvClick(e,t,d){
  const C=S.cv;if(!C)return false;
  if(d.cvsrc){C.source=d.cvsrc;renderMain();return true}
  if(d.cvrm){C.tables=C.tables.filter(x=>x.id!==d.cvrm);if(!C.tables.length)C.date='';renderMain();return true}
  if(d.cvgo){S.cv=null;go(d.cvgo);return true}
  if(d.cvact==='import'){cvImport();return true}
  if(d.cvact==='again'){S.cv=cvNew();renderMain();return true}
  return false;
}
function bindConvert(m){
  const C=S.cv;if(!C)return;
  $$('[data-cvfile]',m).forEach(i=>i.onchange=()=>{const fs=[...i.files];i.value='';if(fs.length)cvAddFiles(fs)});
  m.onchange=e=>{
    const t=e.target,d=t.dataset;
    if(d.cvkind){const x=C.tables.find(y=>y.id===d.cvkind);if(x){x.kind=t.value;if(x.header<0)x.header=Convert.findHeader(x.rows)}renderMain()}
    else if(d.cvtype){C.edits[d.cvtype]={type:t.value,detail:''};renderMain()}
    else if(d.cvdet){const p=cvPlan(),a=p&&p.accounts.find(x=>x.key===d.cvdet);C.edits[d.cvdet]={type:a?a.type:'Expense',detail:t.value};renderMain()}
    else if(t.id==='cvDate'){C.date=t.value;renderMain()}
    else if(t.id==='cvFmt'){C.dateFormat=t.value;renderMain()}
    else if(t.id==='cvStarter'){C.replaceStarter=t.checked}
    else if(t.id==='cvJournal'){C.useJournal=t.checked}
  };
}
