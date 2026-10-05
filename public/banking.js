'use strict';
/* ---------- Banking: statement import, review, rules and reconciliation ----------
 * Bank line amounts: positive = money into the account, negative = money out.
 * For a transaction, its effect on a bank/card account is (debit - credit) on that
 * account's lines, which uses the same sign, so the two compare directly.
 * Cleared status lives on each transaction as clear: {accountId: 'c' | 'r'}.
 */
S.bank={tab:'review',acct:'',show:'new',sel:{},checked:new Set(),rec:null,draft:{}};

const isBankAcct=a=>!!a&&(a.detail==='bank'||a.detail==='card');
const bankAccts=()=>sortAccts(S.accounts.filter(a=>isBankAcct(a)&&a.active!==false));
function curBankAcct(){const a=acct(S.bank.acct);if(!isBankAcct(a))S.bank.acct=(bankAccts()[0]||{}).id||'';return S.bank.acct}
const signedOn=(e,id)=>r2((e.lines||[]).filter(l=>l.account===id).reduce((s,l)=>s+(+l.debit||0)-(+l.credit||0),0));
const natural=(a,v)=>r2(a.detail==='card'?-v:v); // card balances are shown as the amount owed
const linkedEntryIds=()=>new Set(S.bankTxns.filter(b=>b.status==='added'||b.status==='matched').map(b=>b.entryId));
const keyWords=d=>String(d||'').toUpperCase().replace(/[^A-Z ]+/g,' ').split(/\s+/).filter(w=>w.length>1).slice(0,2).join(' ');
const catFilter=a=>a.detail!=='ar'&&a.detail!=='ap';
const outLabel=a=>a.detail==='card'?'Charge':'Spent',inLabel=a=>a.detail==='card'?'Payment':'Received';

/* ---------- suggestions ---------- */
function matchesFor(b){
  const out=[],linked=linkedEntryIds(),a=acct(b.account);
  for(const e of S.entries){
    if(linked.has(e.id)||(e.clear&&e.clear[b.account]))continue;
    if(Math.abs(signedOn(e,b.account)-b.amount)>0.004)continue;
    const gap=Math.abs(daysBetween(e.date,b.date));if(gap>10)continue;
    out.push({value:'m:entry:'+e.id,gap,label:`${TLABEL[e.type]||e.type}${e.ref?' #'+e.ref:''} · ${contactName(e.contactId)||e.memo||''} · ${fmtDate(e.date)}`});
  }
  const kind=b.amount>0?'invoice':'bill';
  if(kind==='bill'||a.detail==='bank'){
    for(const d of S.docs.filter(d=>d.kind===kind)){
      const st=docStatus(d);
      if(st.bal>0&&Math.abs(st.bal-Math.abs(b.amount))<0.005)out.push({value:'m:doc:'+d.id,gap:Math.abs(daysBetween(d.due||d.date,b.date)),label:`${kind==='invoice'?'Payment for invoice':'Pay bill'}${d.number?' #'+d.number:''} · ${contactName(d.contactId)}`});
    }
  }
  return out.sort((x,y)=>x.gap-y.gap);
}
function ruleFor(b){const d=(b.desc||'').toLowerCase();return S.rules.find(r=>r.text&&d.includes(r.text.toLowerCase())&&(r.direction==='any'||(r.direction==='in')===(b.amount>0))&&acct(r.account))}
function historyFor(b){
  const k=keyWords(b.desc);if(!k)return null;
  const prev=S.bankTxns.filter(x=>x.status==='added'&&x.cat&&x.id!==b.id&&keyWords(x.desc)===k&&(x.amount>0)===(b.amount>0)).sort((x,y)=>(y.imported||0)-(x.imported||0))[0];
  return prev&&acct(prev.cat.account)?prev.cat:null;
}
function suggest(b){
  const m=matchesFor(b);if(m.length)return{choice:m[0].value,contactId:'',tax:false,why:'match'};
  const r=ruleFor(b);if(r)return{choice:'a:'+r.account,contactId:r.contactId||'',tax:r.tax==='gst'?'gst':!!r.tax,why:'rule',rule:r};
  const h=historyFor(b);if(h)return{choice:'a:'+h.account,contactId:h.contactId||'',tax:h.tax==='gst'?'gst':!!h.tax,why:'history'};
  const x=typeof aiSuggestion==='function'&&aiSuggestion(b);if(x)return x;
  return{choice:'',contactId:'',tax:false,why:''};
}
function selFor(b){const s=S.bank.sel[b.id];return s&&s.user?s:suggest(b)}

/* ---------- views ---------- */
function vBanking(){
  const B=S.bank,accts=bankAccts();
  let h=head('Banking','Import statements from your bank, review each line, then reconcile to the statement',`<button class="btn" data-bact="new-rule">Add rule</button><button class="btn primary" data-bact="import">Import statement</button>`);
  if(!accts.length)return h+`<div class="panel"><div class="empty"><b>No bank or credit card accounts</b>Add one under Chart of accounts with the detail “Bank or cash” or “Credit card”.</div></div>`;
  const a=acct(curBankAcct());
  h+=`<div class="acct-cards">${accts.map(x=>{const n=S.bankTxns.filter(b=>b.account===x.id&&b.status==='new').length,last=lastRecon(x.id);
    return `<button class="acct-card" data-bacct="${x.id}" aria-pressed="${x.id===a.id}"><b>${esc(x.name)}</b><span class="val">${mcell(bal(x.id))}</span><span class="sub">${n?`<b style="color:var(--info)">${n} to review</b>`:'Nothing to review'} · ${last?`reconciled to ${fmtDate(last.statementDate)}`:'not reconciled yet'}</span></button>`}).join('')}</div>`;
  h+=`<div class="tabs" role="tablist">${[['review','For review'],['reconcile','Reconcile'],['rules','Rules']].map(([k,v])=>`<button role="tab" data-btab="${k}" aria-selected="${B.tab===k}">${v}</button>`).join('')}</div>`;
  return h+({review:vReview,reconcile:vReconcile,rules:vRules})[B.tab](a);
}

function vReview(a){
  const B=S.bank,mine=S.bankTxns.filter(b=>b.account===a.id);
  const counts={new:0,added:0,excluded:0};mine.forEach(b=>counts[b.status==='matched'?'added':b.status]++);
  if(!mine.length)return `<div class="panel"><div class="empty"><b>No bank lines for ${esc(a.name)} yet</b>In your online banking, download transactions as CSV, OFX, QFX or QBO, then import the file here.<div style="margin-top:14px"><button class="btn primary" data-bact="import">Import statement</button></div></div></div>`;
  const show=B.show;
  let rows=mine.filter(b=>show==='added'?(b.status==='added'||b.status==='matched'):b.status===show).sort((x,y)=>y.date.localeCompare(x.date)||String(x.desc).localeCompare(String(y.desc)));
  {const keep=new Set(rows.map(b=>b.id));[...B.checked].forEach(id=>{if(!keep.has(id))B.checked.delete(id)})}
  // Long lists: the newest lines first, more on request.
  const allN=rows.length;rows=rows.slice(0,shownCount('bank'+show,allN));const more=cols=>moreRow('bank'+show,rows.length,allN,cols);
  const seg=`<div class="toolbar"><div class="actions">${[['new','For review'],['added','Added'],['excluded','Excluded']].map(([k,v])=>`<button class="btn sm ${show===k?'primary':''}" data-bshow="${k}">${v} (${counts[k]})</button>`).join('')}</div><span class="grow"></span>${typeof aiButton==='function'?aiButton(a):''}${show==='new'&&rows.length?`<button class="btn sm" data-bact="add-checked" ${B.checked.size?'':'disabled'}>Add selected${B.checked.size?` (${B.checked.size})`:''}</button>`:''}</div>`;
  if(show==='new')return `<div class="panel">${seg}<div class="tbl-wrap"><table class="review"><thead><tr><th><input type="checkbox" data-checkall aria-label="Select all" ${rows.length&&B.checked.size===rows.length?'checked':''}></th><th>Date</th><th>Description</th><th class="n">${outLabel(a)}</th><th class="n">${inLabel(a)}</th><th>Category or match</th><th>Payee</th><th>${esc(S.company.taxName||'Tax')}</th><th></th></tr></thead><tbody>${rows.length?rows.map(b=>reviewRow(b,a)).join('')+more(9):emptyRow(9,'All caught up','Every imported line has been added, matched or excluded.')}</tbody></table></div></div>`;
  if(show==='added')return `<div class="panel">${seg}<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Description</th><th class="n">${outLabel(a)}</th><th class="n">${inLabel(a)}</th><th>Added as</th><th></th></tr></thead><tbody>${rows.length?rows.map(b=>{const e=entryById(b.entryId);const other=e?[...new Set(e.lines.filter(l=>l.account!==a.id).map(l=>acctName(l.account)))].join(', '):'';
    return `<tr class="click" data-entry="${b.entryId}"><td style="white-space:nowrap">${fmtDate(b.date)}</td><td class="trunc" translate="no">${esc(b.desc)}</td><td class="n">${b.amount<0?money(-b.amount):''}</td><td class="n">${b.amount>0?money(b.amount):''}</td><td class="trunc">${e?`${b.status==='matched'&&!b.made?'<span class="pill paid">Matched</span> ':''}${TLABEL[e.type]||e.type}${other?` · <span class="muted">${esc(other)}</span>`:''}`:'<span class="muted">—</span>'}</td><td class="n"><button class="btn sm" data-bundo="${b.id}">Undo</button></td></tr>`}).join('')+more(6):emptyRow(6,'Nothing added yet','Lines you add or match appear here.')}</tbody></table></div></div>`;
  return `<div class="panel">${seg}<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Description</th><th class="n">${outLabel(a)}</th><th class="n">${inLabel(a)}</th><th></th></tr></thead><tbody>${rows.length?rows.map(b=>`<tr><td style="white-space:nowrap">${fmtDate(b.date)}</td><td class="trunc" translate="no">${esc(b.desc)}</td><td class="n">${b.amount<0?money(-b.amount):''}</td><td class="n">${b.amount>0?money(b.amount):''}</td><td class="n"><button class="btn sm" data-brestore="${b.id}">Move to review</button></td></tr>`).join('')+more(5):emptyRow(5,'Nothing excluded','Exclude duplicates or lines that don’t belong in your books.')}</tbody></table></div></div>`;
}

function reviewRow(b){
  const sel=selFor(b),isMatch=sel.choice.startsWith('m:'),catId=sel.choice.startsWith('a:')?sel.choice.slice(2):'',transfer=!!catId&&isBankAcct(acct(catId));
  const hint=sel.why==='match'?'<span class="hint match">Match found</span>':sel.why==='rule'?`<span class="hint rule">Rule: “${esc(sel.rule.text)}”</span>`:sel.why==='history'?'<span class="hint">Same as last time</span>':sel.why==='ai'?aiHint(sel):'';
  const m=matchesFor(b);
  const cat=`<select data-bcat="${b.id}" aria-label="Category or match"><option value="">Choose category…</option>${m.length?`<optgroup label="Matches">${m.map(x=>`<option value="${x.value}" ${sel.choice===x.value?'selected':''}>${esc(x.label)}</option>`).join('')}</optgroup>`:''}${acctOptions(catId,x=>x.id!==b.account&&catFilter(x)).replace(/value="/g,'value="a:')}</select>`;
  const payee=isMatch||transfer?'<span class="muted">—</span>':`<select data-bpayee="${b.id}" aria-label="Payee"><option value="">None</option>${S.contacts.slice().sort((x,y)=>x.name.localeCompare(y.name)).map(c=>`<option value="${c.id}" ${c.id===sel.contactId?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`;
  // Companies with PST pick between GST and PST, GST only, or no tax.
  const tax=isMatch||transfer||!(+S.company.taxRate)?'':pstOn()?`<select data-btax="${b.id}" aria-label="Sales tax included" style="max-width:130px">${[['','No tax'],['std',S.company.taxName],['gst','GST only']].map(([k,v])=>`<option value="${k}" ${(sel.tax==='gst'?'gst':sel.tax?'std':'')===k?'selected':''}>${esc(v)}</option>`).join('')}</select>`:`<input type="checkbox" data-btax="${b.id}" ${sel.tax?'checked':''} aria-label="Amount includes ${esc(S.company.taxName)}" title="Amount includes ${esc(S.company.taxName)}">`;
  const chk=S.bank.checked.has(b.id);
  return `<tr data-brow="${b.id}" class="${chk?'picked':''}"><td><input type="checkbox" data-bcheck="${b.id}" ${chk?'checked':''} aria-label="Select line"></td><td style="white-space:nowrap">${fmtDate(b.date)}</td><td class="desc"><div title="${esc(b.desc)}">${esc(b.desc||'(no description)')}</div>${hint}</td><td class="n">${b.amount<0?money(-b.amount):''}</td><td class="n">${b.amount>0?money(b.amount):''}</td><td>${cat}</td><td>${payee}</td><td style="text-align:center">${tax}</td><td><div class="acts"><button class="btn sm primary" data-badd="${b.id}" ${sel.choice?'':'disabled'}>${isMatch?'Match':'Add'}</button><button class="btn sm ghost" data-bexclude="${b.id}">Exclude</button><button class="btn sm ghost" data-brule="${b.id}" title="Make a rule from this line">Rule</button></div></td></tr>`;
}

function vRules(){
  const rules=S.rules.slice().sort((a,b)=>(a.created||0)-(b.created||0));
  const dir={any:'Money in or out',in:'Money in',out:'Money out'};
  return `<div class="panel"><div class="toolbar"><span class="grow muted">Rules suggest a category when a bank line’s description contains the text. You still review each line before it’s added. The first matching rule wins.</span><button class="btn sm" data-bact="new-rule">+ Add rule</button></div><div class="tbl-wrap"><table><thead><tr><th>Description contains</th><th>Applies to</th><th>Category</th><th>Payee</th><th>${esc(S.company.taxName||'Tax')}</th></tr></thead><tbody>${rules.length?rules.map(r=>`<tr class="click" data-editrule="${r.id}"><td><b class="mono">${esc(r.text)}</b> ${r.example?'<span class="pill ex">Example</span>':''}</td><td>${dir[r.direction]||''}</td><td>${esc(acctName(r.account))}</td><td>${esc(contactName(r.contactId))}</td><td>${r.tax?'Included':''}</td></tr>`).join(''):emptyRow(5,'No rules yet','Add one here, or click Rule next to a bank line to start from it.')}</tbody></table></div></div>`;
}

/* ---------- reconciliation ---------- */
function lastRecon(id){return S.recons.filter(r=>r.account===id).sort((x,y)=>y.statementDate.localeCompare(x.statementDate)||(y.completedAt||0)-(x.completedAt||0))[0]}
function reconciledBalance(a){return natural(a,S.entries.reduce((s,e)=>e.clear?.[a.id]==='r'?s+signedOn(e,a.id):s,0))}
function reconLines(a,upTo){
  return S.entries.filter(e=>e.date<=upTo&&e.clear?.[a.id]!=='r'&&(e.lines||[]).some(l=>l.account===a.id)).map(e=>({e,amt:signedOn(e,a.id)})).filter(x=>x.amt!==0)
    .sort((x,y)=>x.e.date.localeCompare(y.e.date)||(x.e.created||0)-(y.e.created||0));
}
function reconNumbers(a){
  const R=S.bank.rec,begin=reconciledBalance(a);
  let ins=0,outs=0;for(const x of reconLines(a,R.date))if(R.ticked.has(x.e.id)){if(x.amt>0)ins+=x.amt;else outs+=-x.amt}
  const cleared=r2(begin+natural(a,ins-outs));
  return{begin,ins:r2(ins),outs:r2(outs),cleared,diff:r2(R.ending-cleared)};
}
function reconBar(a){
  const n=reconNumbers(a),card=a.detail==='card';
  return `<div class="recon-bar" id="reconBar"><div><span>Statement ending balance</span><b>${money(S.bank.rec.ending)}</b></div><div><span>Beginning balance</span><b>${money(n.begin)}</b></div><div><span>${card?'Payments':'Deposits'} ticked</span><b>${money(n.ins)}</b></div><div><span>${card?'Charges':'Withdrawals'} ticked</span><b>${money(n.outs)}</b></div><div class="${Math.abs(n.diff)<0.005?'ok':'off'}"><span>Difference</span><b>${money(n.diff)}</b></div></div>`;
}
function vReconcile(a){
  const R=S.bank.rec;
  if(!R||R.account!==a.id){
    const last=lastRecon(a.id),draft=S.bank.draft[a.id]||{},stmt=a.lastStatement||{};
    const date=draft.date||stmt.date||today(),ending=draft.ending??stmt.balance??'';
    const hist=S.recons.filter(r=>r.account===a.id).sort((x,y)=>y.statementDate.localeCompare(x.statementDate)||(y.completedAt||0)-(x.completedAt||0));
    return `<div class="panel" style="max-width:720px"><h3>Reconcile ${esc(a.name)}</h3><div class="pad" style="display:flex;flex-direction:column;gap:14px">
      <div class="muted">Enter the ending date and balance from your ${a.detail==='card'?'credit card':'bank'} statement, then tick each transaction that appears on it. When the difference is zero, your books agree with the ${a.detail==='card'?'card company':'bank'}.</div>
      <div class="fields"><div class="field"><label>Beginning balance</label><div style="padding:6px 0;font-weight:600">${money(reconciledBalance(a))}</div><span class="hint">${last?`From the statement ending ${fmtDate(last.statementDate)}`:'Nothing reconciled yet'}</span></div>
      ${fld('rDate','Statement ending date',`<input type="date" id="rDate" value="${date}">`)}${fld('rEnd',a.detail==='card'?'Ending balance owed':'Ending balance',`<input type="number" id="rEnd" step="0.01" inputmode="decimal" value="${ending}">`)}</div>
      <div><button class="btn primary" data-bact="rec-start">Start reconciling</button></div></div></div>
      ${hist.length?`<div class="panel" style="max-width:720px;margin-top:16px"><h3>Past reconciliations</h3><div class="tbl-wrap"><table><thead><tr><th>Statement date</th><th class="n">Ending balance</th><th class="n">Transactions</th><th>Reconciled on</th><th></th></tr></thead><tbody>${hist.map((r,i)=>`<tr><td>${fmtDate(r.statementDate)}</td><td class="n">${money(r.endingBalance)}</td><td class="n">${r.entryIds.length}</td><td class="muted">${r.completedAt?fmtDate(new Date(r.completedAt).toISOString().slice(0,10)):''}</td><td class="n" style="white-space:nowrap"><button class="btn sm" data-recreport="${r.id}">Report</button>${i===0?` <button class="btn sm" data-recundo="${r.id}">Undo</button>`:''}</td></tr>`).join('')}</tbody></table></div></div>`:''}`;
  }
  const lines=reconLines(a,R.date),n=reconNumbers(a),card=a.detail==='card';
  return reconBar(a)+`<div class="panel"><div class="toolbar"><span class="grow"><b>${esc(a.name)}</b> <span class="muted">· statement ending ${fmtDate(R.date)} · ${lines.length} uncleared transaction${lines.length===1?'':'s'} up to that date</span></span>
    <button class="btn sm" data-bact="rec-tickall">${lines.length&&lines.every(x=>R.ticked.has(x.e.id))?'Untick all':'Tick all'}</button><button class="btn sm" data-bact="rec-edit">Edit statement info</button><button class="btn sm" data-bact="rec-save">Save for later</button><button class="btn sm primary" data-bact="rec-finish" ${Math.abs(n.diff)<0.005?'':'disabled'}>Finish</button></div>
    <div class="tbl-wrap"><table><thead><tr><th style="width:36px"></th><th>Date</th><th>Type</th><th>No.</th><th>Payee / memo</th><th class="n">${card?'Charge':'Withdrawal'}</th><th class="n">${card?'Payment':'Deposit'}</th></tr></thead><tbody>${lines.length?lines.map(({e,amt})=>`<tr><td><input type="checkbox" data-rtick="${e.id}" ${R.ticked.has(e.id)?'checked':''} aria-label="Cleared"></td><td style="white-space:nowrap">${fmtDate(e.date)}</td><td style="white-space:nowrap"><button class="link" data-entry="${e.id}">${TLABEL[e.type]||e.type}</button></td><td class="mono">${esc(e.ref||'')}</td><td class="trunc" translate="no">${esc(contactName(e.contactId)||e.memo||'')}</td><td class="n">${amt<0?money(-amt):''}</td><td class="n">${amt>0?money(amt):''}</td></tr>`).join(''):emptyRow(7,'Nothing to tick','There are no uncleared transactions up to this date. Import or enter the missing ones first.')}</tbody></table></div>
    ${Math.abs(n.diff)>=0.005?`<div class="pad muted" style="font-size:13px;border-top:1px solid var(--line)">Finish unlocks when the difference is zero. If a transaction on the statement is missing here, add it (or import it under For review), then come back. Your ticks are kept while you do.</div>`:''}</div>`;
}

/* ---------- actions ---------- */
function buildWrites(b,sel){
  const a=acct(b.account),amt=Math.abs(b.amount),into=b.amount>0;
  if(sel.choice.startsWith('m:entry:')){
    const e=S.entries.find(x=>x.id===sel.choice.slice(8));if(!e)throw new Error('That transaction no longer exists.');
    return[{op:'set',collection:'entries',id:e.id,data:{...e,clear:{...(e.clear||{}),[a.id]:'c'}}},{op:'set',collection:'bankTxns',id:b.id,data:{...b,status:'matched',entryId:e.id,made:false}}];
  }
  if(sel.choice.startsWith('m:doc:')){
    const d=S.docs.find(x=>x.id===sel.choice.slice(6));if(!d)throw new Error('That invoice or bill no longer exists.');
    const recv=d.kind==='invoice',ctl=byDetail(recv?'ar':'ap');if(!ctl)throw new Error(`Add an ${recv?'Accounts receivable':'Accounts payable'} account first.`);
    const id=uid();
    const lines=recv?[{account:a.id,debit:amt,credit:0},{account:ctl.id,debit:0,credit:amt}]:[{account:ctl.id,debit:amt,credit:0},{account:a.id,debit:0,credit:amt}];
    return[{op:'set',collection:'entries',id,data:{type:recv?'payment':'billpayment',date:b.date,ref:'',memo:`${recv?'Payment for invoice':'Payment of bill'}${d.number?' #'+d.number:''}`,contactId:d.contactId,applyTo:d.id,amount:amt,bank:a.id,lines,clear:{[a.id]:'c'},created:Date.now()}},
      {op:'set',collection:'bankTxns',id:b.id,data:{...b,status:'matched',entryId:id,made:true}}];
  }
  const cat=acct(sel.choice.slice(2));if(!cat)throw new Error('Choose a category first.');
  const id=uid();let entry;
  if(isBankAcct(cat)){
    entry={type:'transfer',date:b.date,ref:'',memo:b.desc,form:into?{from:cat.id,to:a.id,amount:amt}:{from:a.id,to:cat.id,amount:amt},
      lines:into?[{account:a.id,debit:amt,credit:0},{account:cat.id,debit:0,credit:amt}]:[{account:cat.id,debit:amt,credit:0},{account:a.id,debit:0,credit:amt}]};
  }else{
    // "gst": GST only, on a company that also charges PST.
    const gstOnly=sel.tax==='gst'&&pstOn(),rate=gstOnly?r2((+S.company.taxRate||0)-(+S.company.pstRate||0)):+S.company.taxRate||0,useTax=!!sel.tax&&rate>0;
    const pre=useTax?r2(amt/(1+rate/100)):amt;let net=pre,parts=useTax?splitTaxTotal(r2(amt-pre)):[];
    if(gstOnly&&parts.length){const t=r2(amt-pre);parts=taxParts().filter(p=>p.key==='gst').map(p=>({...p,amount:t}))}
    // PST paid can't be recovered: it stays part of the expense.
    if(!into){net=r2(net+parts.filter(p=>p.recoverable===false).reduce((s,p)=>s+p.amount,0));parts=parts.filter(p=>p.recoverable!==false)}
    if(parts.some(p=>!p.account))throw new Error(`Add a “${parts.find(p=>!p.account).name} payable” account first.`);
    const tax=r2(parts.reduce((s,p)=>s+p.amount,0));
    const code=useTax?(gstOnly?'gst':'std'):'none';
    const lines=into?[{account:a.id,debit:amt,credit:0},{account:cat.id,debit:0,credit:net,taxCode:code}]:[{account:cat.id,debit:net,credit:0,taxCode:code}];
    parts.forEach(p=>lines.push(into?{account:p.account,debit:0,credit:p.amount,memo:p.name+' collected'}:{account:p.account,debit:p.amount,credit:0,memo:p.name+' paid'}));
    if(!into)lines.push({account:a.id,debit:0,credit:amt});
    entry={type:into?'deposit':'expense',date:b.date,ref:'',memo:b.desc,contactId:sel.contactId||'',form:{bank:a.id,lines:[{account:cat.id,desc:b.desc,amount:pre,taxCode:code,tax:!!tax}]},lines};
  }
  entry.clear={[a.id]:'c'};entry.created=Date.now();
  return[{op:'set',collection:'entries',id,data:entry},{op:'set',collection:'bankTxns',id:b.id,data:{...b,status:'added',entryId:id,made:true,cat:{account:cat.id,contactId:sel.contactId||'',tax:sel.tax==='gst'?'gst':!!sel.tax}}}];
}
async function addLines(ids){
  const writes=[],used=new Set();let n=0,skipped=0;
  for(const id of ids){
    const b=S.bankTxns.find(x=>x.id===id);if(!b||b.status!=='new')continue;
    const sel=selFor(b);
    if(!sel.choice||(sel.choice.startsWith('m:')&&used.has(sel.choice))){skipped++;continue}
    if(sel.choice.startsWith('m:'))used.add(sel.choice);
    try{writes.push(...buildWrites(b,sel));n++}catch(e){toast(e.message,true);return}
  }
  if(!n){toast('Choose a category or match for the selected lines first.',true);return}
  if(await batch(writes)){ids.forEach(id=>{delete S.bank.sel[id];S.bank.checked.delete(id)});toast(`Added ${n} line${n===1?'':'s'}${skipped?` · ${skipped} still need a category`:''}`)}
}
async function undoLine(b){
  const e=S.entries.find(x=>x.id===b.entryId);
  if(e&&e.clear?.[b.account]==='r'){toast('This line is part of a finished reconciliation. Undo that reconciliation first.',true);return}
  if(b.made&&e){
    if(!await confirmBox('Undo this line?','The transaction created from it will be deleted, and the line goes back to For review.','Undo'))return;
    if(await batch([{op:'delete',collection:'entries',id:e.id}]))toast('Moved back to For review');
  }else{
    const w=[{op:'set',collection:'bankTxns',id:b.id,data:{...b,status:'new',entryId:''}}];
    if(e){const clear={...(e.clear||{})};delete clear[b.account];w.unshift({op:'set',collection:'entries',id:e.id,data:{...e,clear}})}
    if(await batch(w))toast('Unmatched and moved back to For review');
  }
}
async function finishRecon(a){
  const R=S.bank.rec,n=reconNumbers(a);if(Math.abs(n.diff)>=0.005)return;
  const lines=reconLines(a,R.date),ticked=lines.filter(x=>R.ticked.has(x.e.id)).map(x=>x.e);
  const writes=ticked.map(e=>({op:'set',collection:'entries',id:e.id,data:{...e,clear:{...(e.clear||{}),[a.id]:'r'}}}));
  lines.filter(x=>!R.ticked.has(x.e.id)&&x.e.clear?.[a.id]==='c').forEach(({e})=>{const clear={...e.clear};delete clear[a.id];writes.push({op:'set',collection:'entries',id:e.id,data:{...e,clear}})});
  writes.push({op:'set',collection:'recons',id:uid(),data:{account:a.id,statementDate:R.date,endingBalance:R.ending,beginningBalance:n.begin,entryIds:ticked.map(e=>e.id),completedAt:Date.now()}});
  if(await batch(writes)){S.bank.rec=null;delete S.bank.draft[a.id];toast(`${a.name} reconciled to ${fmtDate(R.date)}`);renderMain()}
}
async function saveRecon(a){
  const R=S.bank.rec,writes=[];
  for(const{e}of reconLines(a,R.date)){
    const want=R.ticked.has(e.id),has=e.clear?.[a.id]==='c';if(want===has)continue;
    const clear={...(e.clear||{})};if(want)clear[a.id]='c';else delete clear[a.id];
    writes.push({op:'set',collection:'entries',id:e.id,data:{...e,clear}});
  }
  S.bank.draft[a.id]={date:R.date,ending:R.ending};
  if(!writes.length||await batch(writes)){S.bank.rec=null;toast('Progress saved. Your ticks will be here when you come back.');renderMain()}
}
async function undoRecon(r){
  const a=acct(r.account);
  if(!await confirmBox('Undo this reconciliation?',`The ${r.entryIds.length} transactions reconciled on the statement ending ${fmtDate(r.statementDate)} go back to cleared, so you can reconcile that statement again.`,'Undo reconciliation'))return;
  const writes=r.entryIds.map(id=>S.entries.find(e=>e.id===id)).filter(e=>e&&e.clear?.[a.id]==='r').map(e=>({op:'set',collection:'entries',id:e.id,data:{...e,clear:{...e.clear,[a.id]:'c'}}}));
  writes.push({op:'delete',collection:'recons',id:r.id});
  if(await batch(writes))toast('Reconciliation undone');
}

/* ---------- events ---------- */
async function bankClick(ev,t,d){
  const B=S.bank,a=acct(curBankAcct());
  if(d.bacct){B.acct=d.bacct;B.checked.clear();if(B.rec&&B.rec.account!==d.bacct)B.rec=null;renderMain();return true}
  if(d.btab){B.tab=d.btab;renderMain();return true}
  if(d.bshow){B.show=d.bshow;renderMain();return true}
  if(d.badd){await addLines([d.badd]);return true}
  if(d.bexclude){const b=S.bankTxns.find(x=>x.id===d.bexclude);if(b&&await put('bankTxns',b.id,{...b,status:'excluded'}))toast('Excluded');return true}
  if(d.brestore){const b=S.bankTxns.find(x=>x.id===d.brestore);if(b&&await put('bankTxns',b.id,{...b,status:'new',entryId:''}))toast('Moved back to For review');return true}
  if(d.bundo){ev.stopPropagation();const b=S.bankTxns.find(x=>x.id===d.bundo);if(b)await undoLine(b);return true}
  if(d.brule){const b=S.bankTxns.find(x=>x.id===d.brule);const sel=selFor(b);ruleForm(null,{text:keyWords(b.desc)||b.desc.slice(0,20),direction:b.amount>0?'in':'out',account:sel.choice.startsWith('a:')?sel.choice.slice(2):'',contactId:sel.contactId,tax:sel.tax});return true}
  if(d.editrule){ruleForm(S.rules.find(r=>r.id===d.editrule));return true}
  if(d.recundo){const r=S.recons.find(x=>x.id===d.recundo);if(r)await undoRecon(r);return true}
  if(d.recreport){const r=S.recons.find(x=>x.id===d.recreport);if(r)reconReport(r);return true}
  switch(d.bact){
    case 'import':importForm();return true;
    case 'new-rule':ruleForm(null);return true;
    case 'add-checked':await addLines([...B.checked]);return true;
    case 'ai-suggest':await aiSuggest(a);return true;
    case 'rec-start':{
      const date=$('#rDate').value,ending=$('#rEnd').value;
      if(!date||ending===''||!Number.isFinite(+ending)){toast('Enter the statement ending date and balance.',true);return true}
      B.rec={account:a.id,date,ending:r2(ending),ticked:new Set(reconLines(a,date).filter(x=>x.e.clear?.[a.id]==='c').map(x=>x.e.id))};
      renderMain();return true;
    }
    case 'rec-edit':B.draft[a.id]={date:B.rec.date,ending:B.rec.ending};B.rec=null;renderMain();return true;
    case 'rec-tickall':{const ls=reconLines(a,B.rec.date);const all=ls.every(x=>B.rec.ticked.has(x.e.id));ls.forEach(x=>all?B.rec.ticked.delete(x.e.id):B.rec.ticked.add(x.e.id));renderMain();return true}
    case 'rec-save':await saveRecon(a);return true;
    case 'rec-finish':await finishRecon(a);return true;
  }
  return false;
}
function bindBanking(m){
  m.onchange=e=>{
    const t=e.target,d=t.dataset,B=S.bank;
    const id=d.bcat||d.bpayee||d.btax;
    if(id){
      const b=S.bankTxns.find(x=>x.id===id);if(!b)return;
      const cur={...selFor(b),user:true,why:''};
      if(d.bcat)cur.choice=t.value;
      if(d.bpayee)cur.contactId=t.value;
      if(d.btax)cur.tax=t.type==='checkbox'?t.checked:t.value==='gst'?'gst':t.value==='std';
      if(d.bcat&&cur.choice)B.checked.add(id);
      B.sel[id]=cur;
      const tr=t.closest('tr');tr.outerHTML=reviewRow(b);
      refreshAddChecked();
      return;
    }
    if(d.bcheck){t.checked?B.checked.add(d.bcheck):B.checked.delete(d.bcheck);t.closest('tr').classList.toggle('picked',t.checked);refreshAddChecked();return}
    if(t.hasAttribute('data-checkall')){$$('[data-bcheck]',m).forEach(c=>{c.checked=t.checked;t.checked?B.checked.add(c.dataset.bcheck):B.checked.delete(c.dataset.bcheck);c.closest('tr').classList.toggle('picked',t.checked)});refreshAddChecked();return}
    if(d.rtick){t.checked?B.rec.ticked.add(d.rtick):B.rec.ticked.delete(d.rtick);const a=acct(B.rec.account);$('#reconBar').outerHTML=reconBar(a);const n=reconNumbers(a);$('[data-bact="rec-finish"]').disabled=Math.abs(n.diff)>=0.005;return}
  };
}
function refreshAddChecked(){const btn=$('[data-bact="add-checked"]');if(btn){const n=S.bank.checked.size;btn.disabled=!n;btn.textContent=`Add selected${n?` (${n})`:''}`}}

/* ---------- rule form ---------- */
function ruleForm(rule,preset){
  const r=rule||{text:'',direction:'out',account:'',contactId:'',tax:false,...(preset||{})};
  const f=openModal(rule?'Edit rule':'New bank rule',`<div class="fields">
    ${fld('ruText','When the description contains',`<input type="text" id="ruText" value="${esc(r.text)}" placeholder="e.g. ROGERS">`,true)}
    ${fld('ruDir','For',`<select id="ruDir"><option value="out" ${r.direction==='out'?'selected':''}>Money out</option><option value="in" ${r.direction==='in'?'selected':''}>Money in</option><option value="any" ${r.direction==='any'?'selected':''}>Money in or out</option></select>`)}
    ${fld('ruAcct','Suggest this category',`<select id="ruAcct"><option value="">Choose account…</option>${acctOptions(r.account,a=>catFilter(a)&&!isBankAcct(a))}</select>`)}
    ${fld('ruPayee','Payee (optional)',`<select id="ruPayee"><option value="">None</option>${S.contacts.slice().sort((x,y)=>x.name.localeCompare(y.name)).map(c=>`<option value="${c.id}" ${c.id===r.contactId?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`)}
    </div>${!+S.company.taxRate?'':pstOn()?fld('ruTax','Sales tax in the amount',`<select id="ruTax">${[['','No tax'],['std',`${S.company.taxName} (${+S.company.taxRate}%)`],['gst',`GST only (${r2(S.company.taxRate-S.company.pstRate)}%)`]].map(([k,v])=>`<option value="${k}" ${(r.tax==='gst'?'gst':r.tax?'std':'')===k?'selected':''}>${esc(v)}</option>`).join('')}</select>`):`<label class="check"><input type="checkbox" id="ruTax" ${r.tax?'checked':''}> Amount includes ${esc(S.company.taxName)} (${+S.company.taxRate}%)</label>`}
    <div class="muted" style="font-size:13px">Matching ignores upper and lower case. Pick text that appears in every statement line from this payee, like a company name, and leave out store numbers or dates.</div>`,saveFoot(!!rule));
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this rule?',`Lines containing “${rule.text}” won’t get a suggested category any more.`))return;await del('rules',rule.id);closeModal();toast('Rule deleted')};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const text=$('#ruText',f).value.trim(),account=$('#ruAcct',f).value;
    if(!text)return f.err('Enter the text to look for.');if(!account)return f.err('Choose the category to suggest.');
    const id=rule?.id||uid();
    const n=S.bankTxns.filter(b=>b.status==='new'&&b.desc.toLowerCase().includes(text.toLowerCase())).length;
    if(await put('rules',id,{...(rule||{created:Date.now()}),text,direction:$('#ruDir',f).value,account,contactId:$('#ruPayee',f).value,tax:(()=>{const x=$('#ruTax',f);return !x?false:x.tagName==='SELECT'?(x.value==='gst'?'gst':x.value==='std'):x.checked})()})){
      // let the new rule re-suggest lines the user hasn't touched
      S.bankTxns.forEach(b=>{if(S.bank.sel[b.id]&&!S.bank.sel[b.id].user)delete S.bank.sel[b.id]});
      closeModal();toast(`Rule saved${n?` · applies to ${n} line${n===1?'':'s'} waiting for review`:''}`);
    }};
}

/* ---------- import ---------- */
async function readText(file){
  const buf=await file.arrayBuffer();
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buf)}catch(e){return new TextDecoder('windows-1252').decode(buf)}
}
function importForm(){
  const accts=bankAccts();if(!accts.length){toast('Add a bank or credit card account first.',true);return}
  const f=openModal('Import bank statement',`<div class="fields">
    ${fld('iAcct','Import into',`<select id="iAcct">${accts.map(a=>`<option value="${a.id}" ${a.id===curBankAcct()?'selected':''}>${esc(a.name)} (${detailLabel(a)})</option>`).join('')}</select>`)}
    ${fld('iFile','Statement file',`<input type="file" id="iFile" accept=".csv,.txt,.ofx,.qfx,.qbo,text/csv">`)}</div>
    <div class="muted" style="font-size:13px">In online banking, look for <b>Download transactions</b> or <b>Export</b> and choose CSV, OFX, QFX or QuickBooks (QBO). Lines you’ve already imported are skipped, so overlapping date ranges are fine.</div>
    <div data-imp></div>`,`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" data-doimport disabled>Import</button>`,'wide');
  const box=$('[data-imp]',f),goBtn=$('[data-doimport]',f);
  let P=null; // {kind, name, raw, map, ofx}
  const account=()=>acct($('#iAcct',f).value);
  function result(){
    if(!P)return{rows:[],errors:[]};
    if(P.kind==='ofx')return{rows:P.ofx.rows,errors:[]};
    return BankParse.applyMapping(P.raw,P.map);
  }
  function render(){
    if(!P){box.innerHTML='';goBtn.disabled=true;return}
    const res=result(),a=account(),rows=res.rows;
    const ins=r2(rows.filter(r=>r.amount>0).reduce((s,r)=>s+r.amount,0)),outs=r2(rows.filter(r=>r.amount<0).reduce((s,r)=>s-r.amount,0));
    const dates=rows.map(r=>r.date).sort();
    let h='';
    if(P.kind==='csv'){
      const roles=[['','Ignore'],['date','Date'],['desc','Description'],['amount','Amount (+ / −)'],['out','Money out'],['in','Money in']];
      const width=Math.max(...P.raw.slice(0,40).map(r=>r.length));
      const start=P.map.skip||0,sample=P.raw.slice(start,start+6);
      const hasAmt=P.map.cols.includes('amount');
      h+=`<div class="flabel">Match the columns</div><div class="tbl-wrap" style="border:1px solid var(--line);border-radius:6px"><table class="map-grid"><thead><tr>${Array.from({length:width},(_,i)=>`<th><select data-mapcol="${i}" aria-label="Column ${i+1}">${roles.map(([k,v])=>`<option value="${k}" ${(P.map.cols[i]||'')===k?'selected':''}>${v}</option>`).join('')}</select></th>`).join('')}</tr></thead><tbody>${sample.map((r,k)=>`<tr${k===0&&P.map.header?' style="font-weight:600;color:var(--muted)"':''}>${Array.from({length:width},(_,i)=>`<td>${esc(r[i]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">
        <label class="check"><input type="checkbox" id="iHeader" ${P.map.header?'checked':''}> First line is column names</label>
        <label class="check">Dates are <select id="iDateFmt">${[['auto','detect automatically'],['ymd','YYYY-MM-DD'],['mdy','MM/DD/YYYY'],['dmy','DD/MM/YYYY'],['compact','YYYYMMDD']].map(([k,v])=>`<option value="${k}" ${P.map.dateFormat===k?'selected':''}>${v}</option>`).join('')}</select></label>
        ${hasAmt?`<label class="check"><input type="checkbox" id="iFlip" ${P.map.flip?'checked':''}> Positive amounts are money out${a.detail==='card'?' (common on credit card files)':''}</label>`:''}
      </div>`;
    }else{
      h+=`<div class="banner" style="margin:0;background:var(--info-soft)"><span><b>${esc(P.name)}</b> · ${P.ofx.accountType==='card'?'credit card':'bank'} statement${P.ofx.balance?` · ending balance ${money(natural(a,P.ofx.balance.amount))}${P.ofx.balance.date?' on '+fmtDate(P.ofx.balance.date):''}`:''}</span></div>`;
      if(P.ofx.accountType==='card'&&a.detail!=='card')h+=`<div class="banner err" style="margin:0"><span>This file is from a credit card, but you’re importing into a bank account. Check “Import into” above.</span></div>`;
    }
    h+=`<div class="flabel">Preview · ${rows.length} transaction${rows.length===1?'':'s'}${dates.length?` from ${fmtDate(dates[0])} to ${fmtDate(dates[dates.length-1])}`:''} · ${outLabel(a).toLowerCase()} ${money(outs)} · ${inLabel(a).toLowerCase()} ${money(ins)}</div>
      <div class="tbl-wrap" style="border:1px solid var(--line);border-radius:6px;max-height:260px;overflow-y:auto"><table><thead><tr><th>Date</th><th>Description</th><th class="n">${outLabel(a)}</th><th class="n">${inLabel(a)}</th></tr></thead><tbody>${rows.slice(0,50).map(r=>`<tr><td style="white-space:nowrap">${fmtDate(r.date)}</td><td class="trunc" translate="no">${esc(r.desc)}</td><td class="n">${r.amount<0?money(-r.amount):''}</td><td class="n">${r.amount>0?money(r.amount):''}</td></tr>`).join('')||`<tr><td colspan="4" class="muted" style="padding:14px">No transactions found yet. Check the column choices above.</td></tr>`}</tbody></table></div>
      ${res.errors.length?`<div class="neg" style="font-size:13px">${res.errors.length} line${res.errors.length===1?'':'s'} can’t be read and will be skipped: ${res.errors.slice(0,3).map(e=>`line ${e.line}: ${esc(e.reason)}`).join('; ')}${res.errors.length>3?'…':''}</div>`:''}`;
    box.innerHTML=h;goBtn.disabled=!rows.length;goBtn.textContent=rows.length?`Import ${rows.length} transaction${rows.length===1?'':'s'}`:'Import';
  }
  box.addEventListener('change',e=>{
    const t=e.target;if(!P||P.kind!=='csv')return;
    if(t.dataset.mapcol!==undefined){const i=+t.dataset.mapcol;if(['date','amount','out','in'].includes(t.value))P.map.cols=P.map.cols.map(c=>c===t.value?'':c);while(P.map.cols.length<=i)P.map.cols.push('');P.map.cols[i]=t.value;if(t.value==='amount'){P.map.cols=P.map.cols.map(c=>c==='out'||c==='in'?'':c)}if(t.value==='out'||t.value==='in'){P.map.cols=P.map.cols.map(c=>c==='amount'?'':c)}if(t.value==='date')P.map.dateFormat=BankParse.detectDateFormat(P.raw.slice((P.map.skip||0)+(P.map.header?1:0),200).map(r=>r[i]))}
    if(t.id==='iHeader')P.map.header=t.checked;
    if(t.id==='iDateFmt')P.map.dateFormat=t.value;
    if(t.id==='iFlip')P.map.flip=t.checked;
    render();
  });
  $('#iAcct',f).onchange=()=>{if(P&&P.kind==='csv'){const saved=account().importMap;if(saved&&saved.width===P.width)P.map={...P.map,...saved,skip:P.map.skip}}render()};
  $('#iFile',f).onchange=async e=>{
    f.err('');const file=e.target.files[0];if(!file){P=null;render();return}
    if(file.size>20*1024*1024){f.err('That file is over 20 MB. Download a shorter date range.');return}
    const text=await readText(file);
    if(BankParse.detectFormat(text,file.name)==='ofx'){
      const ofx=BankParse.parseOFX(text);
      if(!ofx.rows.length){P=null;render();f.err('No transactions were found in that file.');return}
      P={kind:'ofx',name:file.name,ofx};
      const want=ofx.accountType==='card'?'card':'bank';
      if(account().detail!==want){const other=bankAccts().find(a=>a.detail===want);if(other)$('#iAcct',f).value=other.id}
    }else{
      const raw=BankParse.parseCSV(text);
      if(!raw.length){P=null;render();f.err('That file is empty.');return}
      const map=BankParse.guessMapping(raw),width=Math.max(...raw.slice(0,40).map(r=>r.length));
      const saved=account().importMap;
      P={kind:'csv',name:file.name,raw,width,map:saved&&saved.width===width?{...map,...saved,skip:map.skip}:map};
    }
    render();
  };
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const a=account(),res=result();if(!res.rows.length)return;
    goBtn.disabled=true;goBtn.textContent='Importing…';
    try{
      const out=await api('POST','/api/bank/import',{account:a.id,fileName:P.name,rows:res.rows});
      const upd={...a};
      if(P.kind==='csv')upd.importMap={cols:P.map.cols,header:P.map.header,dateFormat:P.map.dateFormat,flip:!!P.map.flip,width:P.width};
      if(P.kind==='ofx'&&P.ofx.balance&&P.ofx.balance.date)upd.lastStatement={date:P.ofx.balance.date,balance:natural(a,P.ofx.balance.amount)};
      if(upd.importMap||upd.lastStatement)await api('PUT',`/api/records/accounts/${encodeURIComponent(a.id)}`,strip(upd));
      await load();
      closeModal();
      S.bank.acct=a.id;S.bank.tab='review';S.bank.show='new';go('banking');
      toast(out.added?`Imported ${out.added} new line${out.added===1?'':'s'}${out.skipped?` · ${out.skipped} already imported`:''}`:`Nothing new: all ${out.skipped} lines were imported before`);
    }catch(err){f.err(err.message);goBtn.disabled=false;goBtn.textContent='Import'}
  };
}
