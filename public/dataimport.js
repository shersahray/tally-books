'use strict';
/* ---------- Import data from a spreadsheet (Settings → Import data, + New, or the lists) ----------
   Pick what to import, choose a CSV or Excel file, match its columns, check every row, then import the
   good rows in one go. The checking and the records are in importer.js; reading the file in convert-parse.js. */
const DI_TYPES={customers:'Customers',vendors:'Vendors',items:'Products and services',accounts:'Chart of accounts',invoices:'Invoices',bills:'Bills',journal:'Journal entries'};
const DI_NOUN={customers:['customer','customers'],vendors:['vendor','vendors'],items:['product or service','products and services'],accounts:['account','accounts'],invoices:['invoice','invoices'],bills:['bill','bills'],journal:['journal entry','journal entries']};
const DI_HELP={
  customers:'One row per customer. Only the name is needed. A default tax code (such as Zero-rated export for a US customer) fills in on their invoices.',
  vendors:'One row per vendor. Only the name is needed.',
  items:'One row per product or service, with the income account for selling it, the expense account for buying it, or both. Inventory items are added from Products and services.',
  accounts:'One row per account: its number, name and type (Bank, Accounts receivable, Expense…). The type is worked out from the name when it’s missing.',
  invoices:'One row per invoice line. Lines with the same invoice number are one invoice. Each line needs an income account (or a product or service that has one) and a tax code.',
  bills:'One row per bill line. Lines with the same bill number and vendor are one bill. Each line needs an expense account (or a product or service that has one) and a tax code.',
  journal:'One row per line, in Debit or Credit. Lines with the same journal number are one entry, and each entry has to balance.',
};
S.di=null;
const diNew=type=>({type:type||'',file:'',table:null,map:{},dateFormat:'',addContacts:false,show:'all',busy:false,reading:false,done:null});
const diStaff=()=>ME&&ME.role!=='client'&&!ME.readOnly;
function diOpen(type){$('#newMenu').hidden=true;S.di=diNew(DI_TYPES[type]?type:'');go('dataimport')}
const diLabel=(type,k)=>{const f=Importer.fieldsOf(type).find(x=>x.key===k);return f?f.en:k};
const diNoun=(type,n)=>DI_NOUN[type][n===1?0:1];
const diRows=n=>n===1?'1 row':`${n} rows`;
const DI_OPEN={customers:'Go to customers',vendors:'Go to vendors',items:'Go to products and services',accounts:'Go to chart of accounts',invoices:'Go to invoices',bills:'Go to bills',journal:'Go to transactions'};

/** What's wrong with a row, in words. */
function diMsg(p,type){
  const v=p.value||'';
  switch(p.code){
    case 'required':return `Missing: ${diLabel(type,p.field)}.`;
    case 'date':return `“${v}” isn’t a date.`;
    case 'date-format':return 'Choose how dates are written (above).';
    case 'email':return `“${v}” isn’t an email address.`;
    case 'tax':return p.why==='gst'?`Tax code “${v}”: these books charge GST and QST together. Use ${S.company.taxName||'the company’s tax'}.`:p.why==='rate'?`Tax code “${v}” doesn’t match this company’s sales tax rate.`:`Unknown tax code “${v}”. Use HST, GST, QST, Zero-rated, Exempt or None.`;
    case 'dup':return p.why==='file'?`Listed twice in the file: ${v}. Only the first is imported.`:p.kind==='invoice'?`Invoice ${v} is already in the books. Skipped.`:p.kind==='bill'?`Bill ${v} from this vendor is already in the books. Skipped.`:p.kind==='journal'?`Journal entry ${v} is already in the books. Skipped.`:`Already in the books: ${v}. Skipped.`;
    case 'inventory':return 'Inventory items can’t be imported. Add them in Products and services.';
    case 'item-type':return `Type “${v}” isn’t Service or Product.`;
    case 'item-acct':return 'Give an income account (to sell it) or an expense account (to buy it).';
    case 'account':return `No account “${v}” in the chart of accounts.`;
    case 'account-kind':return p.need==='income'?`“${v}” isn’t an income account.`:`“${v}” isn’t an expense account.`;
    case 'amount':return `“${v}” isn’t a number.`;
    case 'code-used':return `Account number ${v} is already used.`;
    case 'code-long':return `Account number ${v} is too long (20 characters at most).`;
    case 'contact':return p.kind==='customer'?`No customer “${v}”. Tick “Add new customers” to add them.`:p.kind==='vendor'?`No vendor “${v}”. Tick “Add new vendors” to add them.`:`No customer or vendor “${v}”.`;
    case 'contact-cur':return `${v} is billed in another currency. Enter their documents in the form, with the exchange rate.`;
    case 'item':return `No product or service “${v}”.`;
    case 'no-account':return p.sale?'Give an income account for this line.':'Give an expense account for this line.';
    case 'qty-rate':return 'Qty × rate doesn’t equal the amount.';
    case 'no-amount':return 'There’s no amount.';
    case 'tax-acct':return `Add a “${p.name} payable” account in Chart of accounts first.`;
    case 'group-contact':return `Invoice ${v} has lines for different customers.`;
    case 'group-date':return v?`The lines of ${v} have different dates.`:'The lines of this entry have different dates.';
    case 'total':return 'The total has to be above zero.';
    case 'group':return p.kind==='invoice'?'Another line of this invoice has a problem, so it isn’t imported either.':p.kind==='bill'?'Another line of this bill has a problem, so it isn’t imported either.':'Another line of this journal entry has a problem, so it isn’t imported either.';
    case 'both':return 'A line can’t have both a debit and a credit.';
    case 'one-sided':return v?`Journal entry ${v} needs at least one debit and one credit.`:'This journal entry needs at least one debit and one credit.';
    case 'unbalanced':return v?`Journal entry ${v} doesn’t balance: debits and credits are out by ${money(p.diff)}.`:`This journal entry doesn’t balance: debits and credits are out by ${money(p.diff)}.`;
    default:return p.code;
  }
}

/** The check of every row, with what the books hold now. */
function diCheck(){
  const D=S.di;if(!D||!D.table||Importer.missingFields(D.type,D.map).length)return null;
  const tp=typeof taxParts==='function'?taxParts().find(p=>!p.account):null;
  return Importer.check(D.type,D.table,D.map,{dateFormat:D.dateFormat,addContacts:D.addContacts,
    existing:{accounts:S.accounts,contacts:S.contacts,items:S.items,docs:S.docs,entries:S.entries},
    company:{...S.company},taxMissing:tp?tp.name:'',filed:S.filings.map(f=>({from:f.from,to:f.to})),
    taxAccounts:typeof taxAcctIds==='function'?[...taxAcctIds()]:[]});
}
// Read the chosen file: the first sheet of an Excel workbook, or a CSV.
async function diFile(file){
  const D=S.di;D.reading=true;renderMain();
  try{
    if(file.size>30*1024*1024)throw new Error(`${file.name} is too large.`);
    const inflate=typeof cvInflate==='function'?cvInflate:null;
    const tables=(await Convert.readFile(file.name,new Uint8Array(await file.arrayBuffer()),inflate)).filter(t=>t.rows.some(r=>r.some(Boolean)));
    if(!tables.length)throw new Error(`Nothing Sumlora can read was found in ${file.name}.`);
    const t=tables[0],header=Importer.findHeader(t.rows,D.type);
    D.file=file.name;D.table={rows:t.rows,header};D.map=Importer.guessMapping(D.type,t.rows[header]);D.dateFormat='';
  }catch(e){toast(e.message,true)}
  D.reading=false;renderMain();
}
function diTemplate(type){
  const csv=Importer.template(type,isFr()?'fr':'en');
  // The byte order mark tells Excel the file is UTF-8, so accents come out right.
  saveFile(`sumlora-${type}-template.csv`,new Blob(['\ufeff'+csv],{type:'text/csv'}));
}

function vDataImport(){
  if(!S.di)S.di=diNew('');
  const D=S.di;
  if(!diStaff())return head('Import data')+`<div class="panel"><div class="empty"><b>Your bookkeeper does this</b>Ask them to import your lists or transactions.</div></div>`;
  let h=head('Import data','Bring customers, vendors, products and services, accounts, invoices, bills or journal entries in from a spreadsheet (CSV or Excel).');
  if(D.done)return h+diDoneHTML();
  // 1. What
  h+=`<div class="panel" style="max-width:900px"><h3>1. What do you want to import?</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="actions" role="group" aria-label="What to import">${Object.entries(DI_TYPES).map(([k,v])=>`<button class="btn sm ${D.type===k?'primary':''}" data-ditype="${k}" aria-pressed="${D.type===k}">${esc(v)}</button>`).join('')}</div>
    ${D.type?`<div class="muted" style="font-size:13px">${esc(DI_HELP[D.type])}</div><div><button class="btn sm ghost" data-ditpl="${D.type}">Download a template (CSV)</button></div>`:''}
  </div></div>`;
  if(!D.type)return h;
  // 2. File
  h+=`<div class="panel" style="max-width:900px;margin-top:16px"><h3>2. Choose the file</h3><div class="pad" style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><label class="btn ${D.file?'':'primary'} ${D.reading?'disabled':''}"><input type="file" accept=".csv,.txt,.xlsx,.xls" data-difile hidden>${D.reading?'Reading…':D.file?'Choose another file':'Choose file'}</label>
    ${D.file?`<span><span translate="no">${esc(D.file)}</span> <span class="muted">${diRows(Math.max(0,D.table.rows.length-D.table.header-1))}</span></span>`:''}</div>
    <div class="muted" style="font-size:13px">CSV or Excel (.xlsx), with column headings in the first row, in English or French. Only the first sheet of a workbook is read.</div>
  </div></div>`;
  if(!D.table)return h;
  // 3. Columns
  const headRow=D.table.rows[D.table.header]||[],first=D.table.rows[D.table.header+1]||[];
  const miss=Importer.missingFields(D.type,D.map);
  const opts=k=>`<option value="">— Not in my file —</option>`+headRow.map((c,i)=>`<option value="${i}" ${D.map[k]===i?'selected':''} ${c?'translate="no"':''}>${esc(c||'Column '+(i+1))}</option>`).join('');
  h+=`<div class="panel" style="max-width:900px;margin-top:16px"><h3>3. Match the columns</h3><div class="pad muted" style="font-size:13px;padding-bottom:0">Each column was matched from its heading. Change any that are wrong. Fields marked * are needed.</div>
    <div class="tbl-wrap"><table><thead><tr><th>Sumlora field</th><th>Column in your file</th><th>First row</th></tr></thead><tbody>
    ${Importer.fieldsOf(D.type).map(f=>`<tr><td>${esc(f.en)}${f.req?' <span aria-hidden="true">*</span>':''}</td><td><select data-dimap="${f.key}" aria-label="${esc(f.en)}">${opts(f.key)}</select></td><td class="muted trunc" translate="no">${esc(D.map[f.key]!==undefined?first[D.map[f.key]]||'':'')}</td></tr>`).join('')}
    </tbody></table></div>
    ${miss.length?`<div class="pad"><div class="banner err" style="margin:0"><span>Choose the column for: ${miss.map(k=>esc(T(diLabel(D.type,k)))).join(', ')}.</span></div></div>`:''}
  </div>`;
  const res=diCheck();
  if(!res)return h;
  // 4. Check
  const doc=D.type==='invoices'||D.type==='bills',grp=doc||D.type==='journal';
  const recs=grp?res.groups.filter(g=>g.status==='ok').length:res.counts.ok;
  const dups=grp?res.groups.filter(g=>g.status==='dup').length:res.counts.dup;
  const bad=grp?res.groups.filter(g=>g.status==='error').length:res.counts.error;
  const ask=res.dateFormat==='ask'||D.dateFormat;
  const fmtSel=ask?fld('diFmt','Dates in this file are written',`<select id="diFmt"><option value="" ${!D.dateFormat?'selected':''}>Choose…</option><option value="dmy" ${D.dateFormat==='dmy'?'selected':''}>Day/month/year (31/12/2025)</option><option value="mdy" ${D.dateFormat==='mdy'?'selected':''}>Month/day/year (12/31/2025)</option></select>`):'';
  const ck=D.type==='invoices'?'customers':'vendors';
  const addBox=doc?`<label class="check"><input type="checkbox" id="diAdd" ${D.addContacts?'checked':''}> ${D.type==='invoices'?'Add new customers':'Add new vendors'}${res.newContacts.length?` (${res.newContacts.length} in this file)`:''}</label>`:'';
  const show=Importer.fieldsOf(D.type).filter(f=>D.map[f.key]!==undefined).slice(0,8);
  const rows=res.rows.filter(r=>D.show==='all'||r.status!=='ok');
  const PILL={ok:['paid','Ready'],error:['overdue','Problem'],dup:['quiet','Skipped'],skip:['partial','Not imported']};
  const warn=res.warnings.map(w=>w.code==='closed'?`Some are dated on or before the closing date, ${fmtDate(w.date)}. You’ll be asked to unlock the books to import them.`:'Some are in a period whose sales tax return was filed. You’ll be asked to confirm before they’re imported.');
  h+=`<div class="panel" style="margin-top:16px"><h3>4. Check the rows</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    ${fmtSel||addBox?`<div class="fields" style="align-items:end">${fmtSel}${addBox?`<div class="field">${addBox}</div>`:''}</div>`:''}
    <div class="chips" style="margin:0"><div class="chip"><div class="lbl">Ready to import</div><div class="val">${recs}</div></div><div class="chip"><div class="lbl">Already in the books</div><div class="val">${dups}</div></div><div class="chip"><div class="lbl">With problems</div><div class="val ${bad?'neg':''}">${bad}</div></div></div>
    ${warn.length?`<div class="banner" style="margin:0;display:block">${warn.map(w=>`<div>${esc(w)}</div>`).join('')}</div>`:''}
  </div>
  <div class="toolbar"><label class="flabel" for="diShow">Show</label><select id="diShow"><option value="all" ${D.show==='all'?'selected':''}>All rows</option><option value="problems" ${D.show==='problems'?'selected':''}>Rows with problems</option></select><span class="grow muted">${diRows(res.rows.length)}</span></div>
  <div class="tbl-wrap"><table><thead><tr><th class="n">Row</th><th>Status</th><th>Problems</th>${show.map(f=>`<th>${esc(f.en)}</th>`).join('')}</tr></thead><tbody>
  ${rows.length?rows.slice(0,shownCount('di',rows.length,300)).map(r=>`<tr><td class="n muted">${r.n}</td><td><span class="pill ${PILL[r.status][0]}">${PILL[r.status][1]}</span></td><td style="font-size:13px;min-width:220px">${r.problems.map(p=>`<div class="${r.status==='dup'?'muted':'neg'}">${esc(diMsg(p,D.type))}</div>`).join('')}</td>${show.map(f=>`<td class="trunc" translate="no">${esc(r.cells[f.key])}</td>`).join('')}</tr>`).join('')+moreRow('di',shownCount('di',rows.length,300),rows.length,show.length+3)
    :emptyRow(show.length+3,'No problems','Every row is ready.')}
  </tbody></table></div>
  <div class="pad" style="display:flex;flex-direction:column;gap:8px">
    <div class="actions"><button class="btn primary" data-diact="import" ${!recs||D.busy?'disabled':''}>${D.busy?'Importing…':`Import ${recs} ${diNoun(D.type,recs)}`}</button>${bad?'<span class="muted" style="font-size:13px;align-self:center">Rows with problems are left out. Fix them in the file and import it again; rows already imported are skipped.</span>':''}</div>
    <div class="muted" style="font-size:12.5px">Nothing already in the books is changed. Existing records with the same name or number are skipped.</div>
  </div></div>`;
  return h;
}
function diDoneHTML(){
  const D=S.di,x=D.done;
  return `<div class="panel" style="max-width:720px"><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <h3 style="margin:0">Import finished</h3>
    <table class="boxes"><tbody>
      <tr><td class="n"><b>${x.imported}</b></td><td>Imported</td></tr>
      ${x.newContacts?`<tr><td class="n">${x.newContacts}</td><td>${D.type==='invoices'?'New customers added':'New vendors added'}</td></tr>`:''}
      <tr><td class="n">${x.dups.length}</td><td>Already in the books, skipped</td></tr>
      <tr><td class="n">${x.bad}</td><td>With problems, not imported</td></tr>
    </tbody></table>
    ${x.dups.length?`<div class="muted" style="font-size:13px">Skipped: <span translate="no">${esc(x.dups.slice(0,30).join(', '))}${x.dups.length>30?'…':''}</span></div>`:''}
    <div class="actions">${x.bad?'<button class="btn" data-diact="leftover">Download the rows not imported</button>':''}<button class="btn" data-diact="again">Import another file</button><button class="btn primary" data-diact="open">${esc(DI_OPEN[D.type])}</button></div>
  </div></div>`;
}

async function diImport(){
  const D=S.di,res=diCheck();if(!res||D.busy)return;
  const sale=D.type==='invoices',doc=sale||D.type==='bills';
  let out;
  try{out=Importer.build(res,{uid,now:Date.now(),calcLines,docPostLines,docRecord,invCosts:typeof invCosts==='function'?invCosts:null,arId:(byDetail('ar')||{}).id,apId:(byDetail('ap')||{}).id})}
  catch(e){toast(e.message,true);return}
  if(!out.writes.length)return;
  const grp=doc||D.type==='journal';
  const n=grp?res.groups.filter(g=>g.status==='ok').length:res.counts.ok;
  const nc=doc?out.counts.contacts||0:0;
  if(!await confirmBox(`Import into ${S.company.name}?`,T(`${n} ${diNoun(D.type,n)} will be added to these books.`)+(nc?' '+T(`New ${sale?(nc===1?'customer':'customers'):(nc===1?'vendor':'vendors')} added too: ${nc}.`):''),'Import'))return;
  // Dated in a period whose sales tax return was filed: ask, as the forms do. (The closing date is checked by the server,
  // which offers to unlock the books.) Everything goes in one request, all or nothing, and only adds records.
  if(!await filedOk(out.writes))return;
  D.busy=true;renderMain();
  const ok=await write(()=>api('POST','/api/import',{writes:out.writes,source:'a spreadsheet (Import data)',addOnly:true}));
  D.busy=false;
  if(!ok){renderMain();return}
  const dupRows=grp?res.groups.filter(g=>g.status==='dup').map(g=>g.number):res.rows.filter(r=>r.status==='dup').map(r=>r.cells.name||r.cells.number);
  D.done={imported:n,newContacts:doc?out.counts.contacts||0:0,dups:dupRows,bad:grp?res.groups.filter(g=>g.status==='error').length:res.counts.error,leftover:Importer.leftoverCsv(D.table,res,p=>T(diMsg(p,D.type)))};
  renderMain();toast('Import finished');
}
const DI_GO={customers:['sales','contacts'],vendors:['expenses','contacts'],items:['sales','items'],accounts:['accounts'],invoices:['sales','docs'],bills:['expenses','docs'],journal:['transactions']};
function diClick(e,t,d){
  if(d.diopen!==undefined){diOpen(d.diopen);return true}
  if(S.view!=='dataimport'||!S.di)return false;
  const D=S.di;
  if(d.ditype){if(d.ditype!==D.type){S.di=diNew(d.ditype)}renderMain();return true}
  if(d.ditpl){diTemplate(d.ditpl);return true}
  if(d.diact==='import'){diImport();return true}
  if(d.diact==='again'){S.di=diNew(D.type);renderMain();return true}
  if(d.diact==='leftover'){saveFile(`${T('Rows not imported')}.csv`,new Blob(['\ufeff'+D.done.leftover],{type:'text/csv'}));return true}
  if(d.diact==='open'){const[v,tab]=DI_GO[D.type];S.di=null;if(tab)(v==='sales'?S.sales:S.exp).tab=tab;go(v);return true}
  return false;
}
function bindDataImport(m){
  const D=S.di;if(!D)return;
  $$('[data-difile]',m).forEach(i=>i.onchange=()=>{const f=i.files[0];i.value='';if(f)diFile(f)});
  $$('[data-dimap]',m).forEach(s=>s.onchange=()=>{const k=s.dataset.dimap;if(s.value==='')delete D.map[k];else{const v=+s.value;for(const[x,c]of Object.entries(D.map))if(c===v)delete D.map[x];D.map[k]=v}renderMain()});
  const fm=$('#diFmt',m);if(fm)fm.onchange=()=>{D.dateFormat=fm.value;renderMain()};
  const ad=$('#diAdd',m);if(ad)ad.onchange=()=>{D.addContacts=ad.checked;renderMain()};
  const sh=$('#diShow',m);if(sh)sh.onchange=()=>{D.show=sh.value;S.more.di=0;renderMain()};
}
