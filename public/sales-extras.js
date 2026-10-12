'use strict';
/* ---------- Estimates, recurring invoices and bills, and online payments ----------
 * Estimates (quotes) aren't posted to the ledger; "Make invoice" turns one into an invoice and links them.
 * Recurring templates make an invoice or bill on a schedule. There's no server job: when someone opens the
 * books, templates that are due are made (or listed for review). Each one gets an id from its template and
 * date, so two people opening the books at once can't make it twice.
 * Online payments: an Interac e-Transfer address printed on invoices, and card payments through the
 * company's own Stripe account (a "Pay now" link per invoice; payments are recorded when the books open).
 */

/* ---------- estimates ---------- */
const EST_STATUS={open:'Open',accepted:'Accepted',declined:'Declined'};
function estState(x){
  if(x.invoiceId&&S.docs.some(d=>d.id===x.invoiceId))return{k:'paid',label:'Invoiced'};
  if(x.status==='declined')return{k:'quiet',label:'Declined'};
  if(x.status==='accepted')return{k:'partial',label:'Accepted'};
  if(x.expires&&x.expires<today())return{k:'overdue',label:'Expired'};
  return{k:'open',label:'Open'};
}
function nextEstNum(){const n=Math.max(1000,...S.estimates.map(e=>parseInt(String(e.number).replace(/^E-/i,''))||0));return 'E-'+(n+1)}
function vEstimates(){
  const list=S.estimates.slice().sort((a,b)=>b.date.localeCompare(a.date)||String(b.number).localeCompare(String(a.number),undefined,{numeric:true}));
  const open=list.filter(x=>['Open','Accepted'].includes(estState(x).label));
  return `<div class="chips"><div class="chip"><div class="lbl">Open and accepted</div><div class="val">${money(open.reduce((s,x)=>s+(+x.total||0),0))}</div><div class="lbl">${open.length} estimate${open.length===1?'':'s'}</div></div></div>
  <div class="panel"><div class="toolbar"><span class="grow muted">Estimates (quotes) aren’t in your books until you turn them into an invoice.</span><button class="btn sm primary" data-estnew>+ New estimate</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>No.</th><th>Customer</th><th>Good until</th><th class="n">Total</th><th>Status</th><th></th></tr></thead><tbody>${list.length?list.map(x=>{const st=estState(x);return `<tr class="click" data-est="${x.id}"><td style="white-space:nowrap">${fmtDate(x.date)}</td><td class="mono">${esc(x.number||'—')}</td><td class="trunc" translate="no">${esc(contactName(x.contactId))}</td><td class="muted" style="white-space:nowrap">${fmtDate(x.expires)}</td><td class="n">${money(x.total)}</td><td><span class="pill ${st.k}">${st.label}</span></td><td class="n">${st.label==='Invoiced'?`<button class="btn sm" data-estinv="${x.invoiceId}">View invoice</button>`:st.label==='Declined'?'':`<button class="btn sm" data-estmake="${x.id}">Make invoice</button>`}</td></tr>`}).join(''):emptyRow(7,'No estimates yet','Send a customer a quote; when they say yes, turn it into an invoice in one click.')}</tbody></table></div></div>`;
}
function estimateForm(x){
  const t=today(),defA=(sortAccts(S.accounts.filter(a=>a.type==='Income'&&a.active!==false))[0]||{}).id||'';
  const d=x?{...x,lines:x.lines.map(l=>({...l,taxCode:taxCodeOf(l)}))}:{number:nextEstNum(),date:t,expires:addDays(t,30),contactId:'',lines:[{desc:'',account:defA,qty:1,rate:'',taxCode:'std'}],memo:'',status:'open'};
  const st=x?estState(x):null,done=st&&st.label==='Invoiced';
  const f=openModal(x?`Estimate ${x.number?'#'+x.number:''}`:'New estimate',
    `${done?`<div class="banner" style="margin:0"><span>This estimate was turned into an invoice.</span> <button type="button" class="btn sm" data-estinv="${x.invoiceId}">View invoice</button></div>`:''}
    <div class="fields">${fld('eC','Customer',contactSelect('eC',d.contactId,'customer'))}${fld('eN','Estimate no.',`<input type="text" id="eN" value="${esc(d.number)}">`)}${fld('eD','Date',`<input type="date" id="eD" value="${esc(d.date)}">`)}${fld('eX','Good until',`<input type="date" id="eX" value="${esc(d.expires||'')}">`)}
    ${typeof fieldInputs==='function'?fieldInputs(d,false):''}${x&&!done?fld('eS','Status',`<select id="eS">${Object.entries(EST_STATUS).map(([k,v])=>`<option value="${k}" ${d.status===k?'selected':''}>${v}</option>`).join('')}</select>`):''}</div>
    <div data-le></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1 1 240px"><label for="eM">Message on estimate</label><textarea id="eM">${esc(d.memo||'')}</textarea></div>${totalsHTML()}</div>`,
    `${delBtn(!!x)}${x?'<button type="button" class="btn ghost" data-estpdf>PDF</button><button type="button" class="btn ghost" data-estmail>Email</button>':''}<button type="button" class="btn" data-close>Cancel</button>${!done&&!(x&&x.status==='declined')?'<button type="button" class="btn" data-estmakehere>Save and make invoice</button>':''}<button type="submit" class="btn primary">Save</button>`,'wide');
  wireContactSelect(f,'eC');
  const filter=DOC_ACCT_FILTER(true);
  const cols=[...itemCol(true,()=>!!contact($('#eC',f).value)?.taxCode),{key:'desc',label:'Description',type:'text'},{key:'account',label:'Income account',type:'acct',filter},{key:'qty',label:'Qty',type:'num',step:'any'},{key:'rate',label:'Rate',type:'num'},{key:'taxCode',label:'Tax',type:'sel',options:taxCodeOptions},{key:'amt',label:'Amount',type:'calc',calc:r=>r2((+r.qty||0)*(+r.rate||0))}];
  cols.defaults=()=>({qty:1,taxCode:contact($('#eC',f).value)?.taxCode||'std',account:defA});
  const le=lineEditor($('[data-le]',f),cols,d.lines,r=>setTotals(f,calcLines(r,x=>(+x.qty||0)*(+x.rate||0),false)));
  const save=async()=>{f.err('');
    const c=calcLines(le.read(),x=>(+x.qty||0)*(+x.rate||0),false);
    if($('#eC',f).value===''||($('#eC',f).value==='__new'&&!$('#eCNew',f).value.trim())){f.err('Choose a customer.');return null}
    if(!$('#eD',f).value){f.err('Enter a date.');return null}
    if(!c.ls.length){f.err('Add at least one line with an account and an amount.');return null}
    const cid=await resolveContact(f,'eC','customer');if(!cid)return null;
    const id=x?x.id:uid();
    const r=docRecord(c);delete r.taxRate;
    const data={...(x?strip(x):{}),number:$('#eN',f).value.trim(),date:$('#eD',f).value,expires:$('#eX',f).value,contactId:cid,memo:$('#eM',f).value.trim(),status:$('#eS',f)?.value||d.status||'open',invoiceId:x?.invoiceId||'',...r,created:x?.created||Date.now()};
    const fv=typeof readFields==='function'?readFields(f,false,x):{};if(Object.keys(fv).length)data.fields=fv;else delete data.fields;
    if(!await put('estimates',id,data))return null;
    return {...data,id};
  };
  f.onsubmit=async e=>{e.preventDefault();if(await save()){closeModal();toast('Estimate saved')}};
  const mh=$('[data-estmakehere]',f);if(mh)mh.onclick=async()=>{const s=await save();if(s){closeModal();estToInvoice(s)}};
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this estimate?',done?'The invoice made from it stays.':'Estimates aren’t in your books, so nothing else changes.'))return;if(await del('estimates',x.id)){closeModal();toast('Estimate deleted')}};
  const pb=$('[data-estpdf]',f);if(pb)pb.onclick=async()=>{try{saveFile(pdfName('estimate',x.number),new Blob([await docPdf({...x,kind:'estimate'})],{type:'application/pdf'}))}catch(e){toast(e.message,true)}};
  const mb=$('[data-estmail]',f);if(mb)mb.onclick=()=>{closeModal();estMail(x)};
  $$('[data-estinv]',f).forEach(b=>b.onclick=()=>{closeModal();estOpenInvoice(b.dataset.estinv)});
}
function estMail(x){
  composeMail({kind:'estimate',contactId:x.contactId,docIds:[],fileName:pdfName('estimate',x.number),makePdf:()=>docPdf({...(S.estimates.find(y=>y.id===x.id)||x),kind:'estimate'}),
    vars:{name:contactName(x.contactId),num:x.number||'',amount:dmoney(x.total),due:ddate(x.expires)}});
}
function estOpenInvoice(id){const d=S.docs.find(y=>y.id===id);if(d){docForm('invoice',d);addExtras('docs',d.id)}}
/** Open a new invoice filled in from the estimate; saving it links the two. */
function estToInvoice(x){
  docForm('invoice',null,{contactId:x.contactId,memo:x.memo||'',fields:x.fields,lines:x.lines.map(l=>({item:l.item||'',desc:l.desc,account:l.account,qty:l.qty,rate:l.rate,taxCode:l.taxCode})),
    note:`<div class="banner" style="margin:0"><span>From estimate</span> <b class="mono">${esc(x.number||'')}</b><span>. Check the lines, then save the invoice.</span></div>`,
    onSaved:async id=>{const cur=S.estimates.find(y=>y.id===x.id)||x;await put('estimates',x.id,{...strip(cur),status:'accepted',invoiceId:id});toast('Invoice saved and linked to the estimate')}});
}

/* ---------- recurring transactions ----------
 * Invoices and bills (documents), and expenses, deposits, transfers and journal entries (straight into the
 * ledger). The schedule itself is in recurring-calc.js (TallyRecurring), shared with the server and the tests. */
const REC_EVERY={week:['week','weeks'],month:['month','months'],quarter:['quarter','quarters'],year:['year','years']};
const REC_KIND={invoice:'Invoice',bill:'Bill',expense:'Expense',deposit:'Deposit',transfer:'Transfer',journal:'Journal entry'};
// Sales → Recurring and Expenses → Recurring each list the kinds that belong there.
const REC_GROUP={invoice:['invoice','deposit'],bill:['bill','expense','transfer','journal']};
const recIsDoc=k=>k==='invoice'||k==='bill';
const recEveryLabel=r=>r.n>1?`Once every ${r.n} ${REC_EVERY[r.every][1]}`:`Every ${REC_EVERY[r.every][0]}`;
/** The date after `date` on the schedule. Months keep the template's day, or the month's last day when it's shorter. */
const recAfter=(r,date)=>TallyRecurring.after(r,date);
const recDue=(r,t=today())=>TallyRecurring.isDue(r,t);
/** "Make recurring" from a transaction dated `date`: monthly from a month later, keeping month-end (April 30 → May 31). */
const recFrom=date=>{const day=TallyRecurring.dayFor(date);return{next:recAfter({every:'month',n:1,day},date),day}};
const recTotal=r=>recIsDoc(r.kind)?calcLines(r.lines,x=>(+x.qty||0)*(+x.rate||0),r.kind==='bill').total:r.kind==='expense'||r.kind==='deposit'?calcLines(r.lines||[],x=>+x.amount||0,r.kind==='expense').total:TallyRecurring.total(r);
/** Who it's with: the customer or payee, or the two accounts of a transfer. */
const recWho=r=>r.kind==='transfer'?`${acctName(r.from)} → ${acctName(r.to)}`:contactName(r.contactId);
const recMakeBtn=()=>typeof ME!=='undefined'&&ME&&(ME.readOnly||ME.role==='client')?'':'<button type="button" class="btn ghost" data-mkrec>Make recurring</button>';
function recState(r){if(r.end&&r.next>r.end)return{k:'quiet',label:'Ended'};if(r.active===false)return{k:'quiet',label:'Paused'};if(recDue(r))return{k:'overdue',label:r.mode==='remind'?'Ready to review':'Due'};return{k:'paid',label:'Active'}}
function vRecurring(kind){
  const inv=kind==='invoice',kinds=REC_GROUP[kind],list=S.recurring.filter(r=>kinds.includes(r.kind)).sort((a,b)=>a.next.localeCompare(b.next));
  const others=kinds.slice(1).map(k=>`<button class="btn sm" data-recnew="${k}">+ Recurring ${REC_KIND[k].toLowerCase()}</button>`).join('');
  return `<div class="panel"><div class="toolbar"><span class="muted" style="flex:1 1 100%">${inv?'Invoices and deposits made on a schedule, such as retainers or rent from a tenant.':'Bills, expenses, transfers and journal entries made on a schedule, such as rent, loan payments or monthly accruals.'} <span>Each one is made when someone opens these books on or after its date, or waits for you to review it.</span></span><span class="grow"></span>${others}<button class="btn sm primary" data-recnew="${kind}">+ New recurring ${inv?'invoice':'bill'}</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>${inv?'Customer':'Vendor or payee'}</th><th>How often</th><th>Next</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>${list.length?list.map(r=>{const st=recState(r),due=st.label==='Ready to review'||st.label==='Due',ended=st.label==='Ended';return `<tr class="click" data-rec="${r.id}"><td>${esc(r.name)}</td><td style="white-space:nowrap">${REC_KIND[r.kind]}</td><td class="trunc" translate="no">${esc(recWho(r))}</td><td><div>${recEveryLabel(r)}</div><div class="muted" style="font-size:12.5px">${r.mode==='remind'?'Remind me':inv&&r.email?'Make and email':'Make automatically'}</div></td><td style="white-space:nowrap">${ended?'—':fmtDate(r.next)}</td><td class="n">${money(recTotal(r))}</td><td><span class="pill ${st.k}">${st.label}</span></td><td class="n"><div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end">${due?`<button class="btn sm" data-recrun="${r.id}">${r.mode==='remind'?'Review':'Make now'}</button>`:''}${ended?'':`<button class="btn sm ghost" data-recskip="${r.id}">Skip next</button><button class="btn sm ghost" data-recpause="${r.id}">${r.active===false?'Resume':'Pause'}</button>`}</div></td></tr>`}).join(''):emptyRow(8,`No recurring ${inv?'invoices':'bills'}`,inv?'Set up an invoice that repeats, like a monthly retainer.':'Set up a bill that repeats, like rent or a subscription.')}</tbody></table></div></div>`;
}
/** The schedule fields every recurring form shares (ids rcN, rcEvery, rcNext, rcEnd, rcMode). */
const recSchedHTML=(d,r)=>`${fld('rcN','Repeat every',`<div style="display:flex;gap:6px"><input type="number" id="rcN" min="1" max="12" step="1" value="${esc(d.n)}" style="width:70px" aria-label="How many"><select id="rcEvery" aria-label="Weeks, months, quarters or years">${Object.entries(REC_EVERY).map(([k,v])=>`<option value="${k}" ${d.every===k?'selected':''}>${v[1]}</option>`).join('')}</select></div>`)}
      ${fld('rcNext',r?'Next one on':'First one on',`<input type="date" id="rcNext" value="${esc(d.next)}">`)}${fld('rcEnd','Last one on (optional)',`<input type="date" id="rcEnd" value="${esc(d.end||'')}">`)}`;
const recModeHTML=d=>fld('rcMode','When it’s due',`<select id="rcMode"><option value="auto" ${d.mode!=='remind'?'selected':''}>Make it automatically</option><option value="remind" ${d.mode==='remind'?'selected':''}>Remind me to review it first</option></select>`);
/** Read the schedule back, or {err}. A month-end start (say the 30th of April) keeps to month-end. */
function recSchedRead(f,d,r){
  const next=$('#rcNext',f).value,end=$('#rcEnd',f).value;
  if(!next)return{err:'Choose the date of the next one.'};if(end&&end<next)return{err:'The last date is before the next one.'};
  return{every:$('#rcEvery',f).value,n:Math.max(1,Math.min(12,parseInt($('#rcN',f).value)||1)),next,end,day:(r?r.next===next&&r.day:d.next===next&&d.day)||TallyRecurring.dayFor(next),mode:$('#rcMode',f).value,active:r?$('#rcActive',f).checked:true};
}
function recurringForm(r,kind,preset){
  kind=r?r.kind:kind;if(!recIsDoc(kind))return recEntryForm(r,kind,preset);
  const inv=kind==='invoice',ck=inv?'customer':'vendor',filter=DOC_ACCT_FILTER(inv);
  const defA=(sortAccts(S.accounts.filter(a=>filter(a)&&a.active!==false))[0]||{}).id||'';
  const d=r?{...r}:{name:'',contactId:'',every:'month',n:1,next:addDays(today(),1),end:'',terms:'',mode:'auto',email:false,active:true,lines:[{desc:'',account:defA,qty:1,rate:'',taxCode:inv?'std':'std'}],memo:'',...(preset||{})};
  const f=openModal(r?`Recurring ${inv?'invoice':'bill'}: ${r.name}`:`New recurring ${inv?'invoice':'bill'}`,
    `<div class="fields">${fld('rcName','Name',`<input type="text" id="rcName" value="${esc(d.name)}" placeholder="${inv?'e.g. Monthly bookkeeping retainer':'e.g. Office rent'}">`)}${fld('rcC',inv?'Customer':'Vendor',contactSelect('rcC',d.contactId,ck))}
      ${recSchedHTML(d,r)}
      ${fld('rcTerms','Due in (days)',`<input type="number" id="rcTerms" min="0" max="365" step="1" value="${esc(d.terms)}" placeholder="${esc(S.company.terms)}">`)}
      ${recModeHTML(d)}</div>
    ${inv?`<label class="check" data-rcemail><input type="checkbox" id="rcEmail" ${d.email?'checked':''}> <span>Email it to the customer when it’s made (uses the company’s email in Settings)</span></label>`:''}
    ${r?`<label class="check"><input type="checkbox" id="rcActive" ${d.active!==false?'checked':''}> <span>Active (untick to pause it)</span></label>`:''}
    <div data-le></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1 1 240px"><label for="rcMemo">${inv?'Message on invoice':'Memo'}</label><textarea id="rcMemo">${esc(d.memo||'')}</textarea></div>${totalsHTML()}</div>
    ${r&&r.made?`<div class="muted" style="font-size:13px"><span>Made so far:</span> ${r.made}${r.last?` · <span>last on</span> ${fmtDate(r.last)}`:''}</div>`:''}`,
    saveFoot(!!r),'wide');
  wireContactSelect(f,'rcC');
  const cols=[...itemCol(inv,()=>!!contact($('#rcC',f).value)?.taxCode),{key:'desc',label:'Description',type:'text'},{key:'account',label:inv?'Income account':'Expense account',type:'acct',filter},{key:'qty',label:'Qty',type:'num',step:'any'},{key:'rate',label:inv?'Rate':'Cost',type:'num'},{key:'taxCode',label:'Tax',type:'sel',options:taxCodeOptions},{key:'amt',label:'Amount',type:'calc',calc:x=>r2((+x.qty||0)*(+x.rate||0))}];
  cols.defaults=()=>({qty:1,taxCode:contact($('#rcC',f).value)?.taxCode||'std',account:defA});
  const le=lineEditor($('[data-le]',f),cols,d.lines.map(l=>({...l,taxCode:taxCodeOf(l)})),rows=>setTotals(f,calcLines(rows,x=>(+x.qty||0)*(+x.rate||0),!inv)));
  const em=$('[data-rcemail]',f),syncMode=()=>{if(em)em.hidden=$('#rcMode',f).value==='remind'};$('#rcMode',f).onchange=syncMode;syncMode();
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this recurring transaction?',`No more ${inv?'invoices':'bills'} will be made from it. The ones already made stay.`))return;if(await del('recurring',r.id)){closeModal();toast('Recurring transaction deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const c=calcLines(le.read(),x=>(+x.qty||0)*(+x.rate||0),!inv);
    const name=$('#rcName',f).value.trim();if(!name)return f.err('Give it a name, like “Office rent”.');
    if($('#rcC',f).value===''||($('#rcC',f).value==='__new'&&!$('#rcCNew',f).value.trim()))return f.err(`Choose a ${ck}.`);
    const sc=recSchedRead(f,d,r);if(sc.err)return f.err(sc.err);const next=sc.next;
    if(!c.ls.length)return f.err('Add at least one line with an account and an amount.');
    const cid=await resolveContact(f,'rcC',ck);if(!cid)return;
    const id=r?r.id:uid(),terms=$('#rcTerms',f).value;
    const data={...(r?strip(r):{made:0,created:Date.now()}),kind,name,contactId:cid,...sc,terms:terms===''?'':Math.max(0,parseInt(terms)||0),email:inv&&!!$('#rcEmail',f)?.checked,
      memo:$('#rcMemo',f).value.trim(),lines:c.ls.map(l=>({...(l.item?{item:l.item}:{}),desc:l.desc||'',account:l.account,qty:+l.qty||0,rate:+l.rate||0,taxCode:l.taxCode}))};
    if(!await put('recurring',id,data))return;
    closeModal();toast(r?'Recurring transaction saved':`Saved. The first one is made on ${fmtDate(next)}.`);
    if(next<=today()&&data.mode==='auto')recRunDue();
  };
}
/** A recurring expense, deposit, transfer or journal entry. These go straight into the ledger when made. */
function recEntryForm(r,kind,preset){
  const out=kind==='expense',mon=kind==='expense'||kind==='deposit',jn=kind==='journal',tf=kind==='transfer';
  // Each one is made later without anyone there to type an exchange rate, so only Canadian-dollar accounts.
  const bk=a=>(a.detail==='bank'||a.detail==='card')&&!a.currency;
  const defBank=(sortAccts(S.accounts.filter(a=>a.detail==='bank'&&!a.currency&&a.active!==false))[0]||{}).id||'';
  const defA=out?'':kind==='deposit'?(sortAccts(S.accounts.filter(a=>a.type==='Income'&&a.active!==false))[0]||{}).id||'':'';
  const d=r?{...r}:{name:'',contactId:'',every:'month',n:1,next:addDays(today(),1),end:'',mode:'auto',active:true,ref:'',memo:'',bank:defBank,from:'',to:'',amount:'',
    lines:jn?[{},{}]:[{account:defA,desc:'',amount:'',taxCode:out?'std':'none'}],...(preset||{})};
  const title=`Recurring ${REC_KIND[kind].toLowerCase()}`,ph={expense:'e.g. Internet',deposit:'e.g. Rent from tenant',transfer:'e.g. Move to savings',journal:'e.g. Monthly amortization'}[kind];
  const f=openModal(r?`${title}: ${r.name}`:`New ${title.toLowerCase()}`,
    `<div class="fields">${fld('rcName','Name',`<input type="text" id="rcName" value="${esc(d.name)}" placeholder="${ph}">`)}
      ${mon?fld('rcBank',out?'Paid from':'Deposit to',`<select id="rcBank"><option value="">Choose account…</option>${acctOptions(d.bank,bk)}</select>`)+fld('rcC',out?'Payee':'Received from',contactSelect('rcC',d.contactId,out?'vendor':'customer',true)):''}
      ${tf?fld('rcFrom','From',`<select id="rcFrom"><option value="">Choose account…</option>${acctOptions(d.from,bk)}</select>`)+fld('rcTo','To',`<select id="rcTo"><option value="">Choose account…</option>${acctOptions(d.to,bk)}</select>`)+fld('rcAmt','Amount',`<input type="number" id="rcAmt" step="0.01" min="0" inputmode="decimal" value="${esc(d.amount??'')}">`):''}
      ${mon||jn?fld('rcRef',jn?'Journal no.':'Reference',`<input type="text" id="rcRef" value="${esc(d.ref||'')}">`):''}
      ${recSchedHTML(d,r)}${recModeHTML(d)}</div>
    ${r?`<label class="check"><input type="checkbox" id="rcActive" ${d.active!==false?'checked':''}> <span>Active (untick to pause it)</span></label>`:''}
    ${jn?'<div class="muted" style="font-size:13px">With “Remind me”, you can change the amounts each time before it’s posted.</div>':''}
    <div data-le></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1 1 240px"><label for="rcMemo">Memo</label>${tf?`<input type="text" id="rcMemo" value="${esc(d.memo||'')}">`:`<textarea id="rcMemo">${esc(d.memo||'')}</textarea>`}</div>
      ${mon?totalsHTML():jn?'<div class="totals"><div>Total debits</div><div data-j="d">0.00</div><div>Total credits</div><div data-j="c">0.00</div><div class="big">Difference</div><div class="big" data-j="x">0.00</div></div>':''}</div>
    ${r&&r.made?`<div class="muted" style="font-size:13px"><span>Made so far:</span> ${r.made}${r.last?` · <span>last on</span> ${fmtDate(r.last)}`:''}</div>`:''}`,
    saveFoot(!!r),'wide');
  if(mon)wireContactSelect(f,'rcC');
  let le=null;
  if(mon){
    const filter=out?a=>!(a.detail==='bank'||a.detail==='card'||a.detail==='ar'||a.detail==='ap'||a.type==='Income'):a=>!(a.detail==='bank'||a.detail==='card'||a.detail==='ar'||a.detail==='ap'||a.type==='Expense'||a.type==='Cost of Goods Sold');
    const cols=[{key:'account',label:'Category',type:'acct',filter},{key:'desc',label:'Description',type:'text'},{key:'amount',label:'Amount',type:'num'},{key:'taxCode',label:'Tax',type:'sel',options:taxCodeOptions}];
    cols.defaults=()=>({taxCode:contact($('#rcC',f).value)?.taxCode||(out?'std':'none'),account:defA});
    le=lineEditor($('[data-le]',f),cols,(d.lines||[]).map(l=>({...l,taxCode:taxCodeOf(l)})),rows=>setTotals(f,calcLines(rows,x=>+x.amount||0,out)));
  }
  if(jn)le=lineEditor($('[data-le]',f),[{key:'account',label:'Account',type:'acct'},{key:'memo',label:'Description',type:'text'},{key:'debit',label:'Debit',type:'num'},{key:'credit',label:'Credit',type:'num'}],
    (d.lines||[]).map(l=>({account:l.account,memo:l.memo||'',debit:l.debit||'',credit:l.credit||''})),
    rows=>{const dr=r2(rows.reduce((s,x)=>s+(+x.debit||0),0)),cr=r2(rows.reduce((s,x)=>s+(+x.credit||0),0));$('[data-j=d]',f).textContent=money(dr);$('[data-j=c]',f).textContent=money(cr);const x=$('[data-j=x]',f);x.textContent=money(r2(dr-cr));x.className='big '+(Math.abs(dr-cr)>0.004?'neg':'')});
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this recurring transaction?','No more will be made from it. The ones already made stay.'))return;if(await del('recurring',r.id)){closeModal();toast('Recurring transaction deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const name=$('#rcName',f).value.trim();if(!name)return f.err('Give it a name, like “Office rent”.');
    const sc=recSchedRead(f,d,r);if(sc.err)return f.err(sc.err);
    const x={};
    if(mon){
      x.bank=$('#rcBank',f).value;if(!x.bank)return f.err('Choose a bank or card account.');
      const c=calcLines(le.read(),l=>+l.amount||0,out);if(!c.ls.length)return f.err('Add at least one line with a category and amount.');
      if(c.tax&&!taxReady(c.parts))return;
      let cid=$('#rcC',f).value;if(cid==='__new'){cid=await resolveContact(f,'rcC',out?'vendor':'customer');if(!cid)return f.err('Enter a name for the new contact.')}
      x.contactId=cid||'';x.lines=c.ls.map(l=>({account:l.account,desc:l.desc||'',amount:l.net,taxCode:l.taxCode}));
    }
    if(tf){
      x.from=$('#rcFrom',f).value;x.to=$('#rcTo',f).value;x.amount=r2($('#rcAmt',f).value);
      if(!x.from||!x.to)return f.err('Choose both accounts.');if(x.from===x.to)return f.err('Pick two different accounts.');if(!(x.amount>0))return f.err('Enter an amount above zero.');
    }
    if(jn){
      const ls=le.read().filter(l=>l.account||+l.debit||+l.credit),bad=TallyRecurring.journalProblem(ls);if(bad)return f.err(bad);
      x.lines=TallyRecurring.journalLines(ls);
    }
    if(mon||jn)x.ref=$('#rcRef',f).value.trim();
    const id=r?r.id:uid();
    const data={...(r?strip(r):{made:0,created:Date.now()}),kind,name,...sc,...x,memo:$('#rcMemo',f).value.trim()};
    if(!await put('recurring',id,data))return;
    closeModal();toast(r?'Recurring transaction saved':`Saved. The first one is made on ${fmtDate(sc.next)}.`);
    if(sc.next<=today()&&data.mode==='auto')recRunDue();
  };
}
/** An expense, deposit, transfer or journal entry made from a template on a date, or {err} when it can't be made. */
function recBuildEntry(r,date){
  let lines,form;
  if(r.kind==='journal'){const bad=TallyRecurring.journalProblem(r.lines);if(bad)return{err:`“${r.name}”: ${T(bad)}`};lines=TallyRecurring.journalLines(r.lines)}
  else if(r.kind==='transfer'){lines=TallyRecurring.transferLines(r);form={from:r.from,to:r.to,amount:+r.amount}}
  else{
    const out=r.kind==='expense',c=calcLines(r.lines||[],x=>+x.amount||0,out);
    if(!c.ls.length)return{err:`“${r.name}” has no lines with an amount.`};
    if(c.tax&&c.parts.some(p=>!p.account))return{err:`Add a “${c.parts.find(p=>!p.account).name} payable” account first.`};
    lines=moneyLines(out,c,r.bank);form={bank:r.bank,lines:c.ls.map(l=>({account:l.account,desc:l.desc||'',amount:l.net,taxCode:l.taxCode,tax:l.taxCode==='std'||l.taxCode==='gst'}))};
  }
  if(lines.some(l=>!acct(l.account)))return{err:`An account on “${r.name}” was deleted. Edit it first.`};
  const id=recId(r,date);
  const entry={type:r.kind,date,ref:r.ref||'',memo:r.memo||'',contactId:r.contactId||'',...(form?{form}:{}),lines,recurringId:r.id,recurringNew:true,created:Date.now()};
  return{id,entry,writes:[{op:'set',collection:'entries',id,data:entry}]};
}
/** Everything needed to make one from a template on a date: the doc, its posting, and the error if it can't be made. */
function recBuild(r,date,number){
  const inv=r.kind==='invoice',c=calcLines(r.lines,x=>(+x.qty||0)*(+x.rate||0),!inv);
  if(!c.ls.length)return{err:`“${r.name}” has no lines with an amount.`};
  const ctl=byDetail(inv?'ar':'ap');if(!ctl)return{err:`Add an ${inv?'Accounts receivable':'Accounts payable'} account first.`};
  if(c.tax&&c.parts.some(p=>!p.account))return{err:`Add a “${c.parts.find(p=>!p.account).name} payable” account first.`};
  if(c.ls.some(l=>!acct(l.account)))return{err:`An account on “${r.name}” was deleted. Edit it first.`};
  const id=recId(r,date);
  const terms=r.terms===''||r.terms==null?+S.company.terms||0:+r.terms;
  const base={date,contactId:r.contactId,memo:r.memo||''};
  if(typeof invCosts==='function')invCosts(r.kind,c,date,id);
  const doc={...base,kind:r.kind,number,due:addDays(date,terms),...docRecord(c),recurringId:r.id,recurringNew:true,created:Date.now()};
  return{id,doc,writes:[{op:'set',collection:'docs',id,data:doc},{op:'set',collection:'entries',id:'d_'+id,data:{...base,type:r.kind,ref:number,docId:id,lines:docPostLines(r.kind,c,ctl.id),created:doc.created}}]};
}
const recId=(r,date)=>('rc_'+r.id+'_'+date).replace(/[^A-Za-z0-9_.:@+~-]/g,'').slice(0,120);
let recBusy=false;
/** Make every automatic template that's due, catching up on missed dates (at most a year of them). */
async function recRunDue(only){
  if(recBusy||!CO||!S.loaded||(typeof ME!=='undefined'&&ME&&(ME.readOnly||ME.role==='client')))return;
  recBusy=true;
  try{
    await load();
    const t=today(),made=[],errs=[];let skippedClosed=0;
    // Each template is saved on its own, so one that can't be made doesn't hold up the others.
    for(const r of S.recurring.filter(x=>(only?x.id===only:x.mode!=='remind')&&recDue(x,t))){
      let next=r.next,num=parseInt(nextNum('invoice'))||1001;const mine=[],docs=[],doc=recIsDoc(r.kind);
      // Dates in a closed period are skipped (the books can't change there).
      for(const p of TallyRecurring.plan(r,t,S.company.closingDate).dates){
        if(p.closed)skippedClosed++;
        else if(!(doc?S.docs:S.entries).some(d=>d.id===recId(r,p.date))){
          const b=doc?recBuild(r,p.date,r.kind==='invoice'?String(num):''):recBuildEntry(r,p.date);
          if(b.err){errs.push(b.err);break}
          if(r.kind==='invoice')num++;
          mine.push(...b.writes);docs.push({r,id:b.id,doc:b.doc||b.entry});
        }
        next=p.after;
      }
      if(next===r.next)continue;
      const w=[...mine,{op:'set',collection:'recurring',id:r.id,data:{...strip(r),next,made:(+r.made||0)+docs.length,last:docs.length?docs[docs.length-1].doc.date:r.last||''}}];
      // The server refuses a second copy of the same date (made at the same moment in another window): then just reload.
      try{await api('POST','/api/batch',{writes:w.map(x=>({...x,data:strip(x.data)}))});made.push(...docs)}
      catch(e){if(e.status!==409)errs.push(`“${r.name}”: ${e.message}`)}
    }
    await load();
    if(skippedClosed)toast(`${skippedClosed} recurring date${skippedClosed===1?' was':'s were'} skipped because the books are closed then.`);
    if(made.length)toast(made.length===1?`Made ${REC_KIND[made[0].r.kind].toLowerCase()} from “${made[0].r.name}”`:`Made ${made.length} recurring transactions`);
    if(errs.length)toast(errs[0],true);
    const mail=made.filter(m=>m.r.kind==='invoice'&&m.r.email);
    if(mail.length)await recEmail(mail);
  }finally{recBusy=false}
}
async function recEmail(list){
  await loadMail();if(!MAILCFG||!MAILCFG.configured){toast('Recurring invoices weren’t emailed: set up email in Settings first.',true);return}
  let sent=0;
  for(const m of list){
    const d=S.docs.find(x=>x.id===m.id),ct=d&&contact(d.contactId);if(!d||!ct||!ct.email)continue;
    try{const pay=await opLinkFor(d);const[subj,text]=templ('invoice',{name:ct.name,num:d.number||'',amount:dmoneyC(d.total,d.currency),due:ddate(d.due),pay});
      await sendMail(ct.email,subj,text,await docPdf(S.docs.find(x=>x.id===d.id)||d),pdfName('invoice',d.number),[d.id],'invoice');sent++}
    catch(e){toast(`Invoice ${d.number} wasn’t emailed: ${e.message}`,true)}
  }
  if(sent){await load();toast(`Emailed ${sent} recurring invoice${sent===1?'':'s'}`)}
}
/** Move a template past its next date without making anything (Skip next, or a date in a closed period). */
async function recSkip(r){
  const cur=S.recurring.find(x=>x.id===r.id)||r,next=recAfter(cur,cur.next);
  if(cur.end&&next>cur.end){if(!await confirmBox('Skip the last one?','This was the last date on the schedule, so nothing more will be made from it.','Skip it'))return}
  if(await put('recurring',cur.id,{...strip(cur),next}))toast(cur.end&&next>cur.end?'Skipped. That was the last one.':`Skipped ${fmtDate(cur.next)}. The next one is on ${fmtDate(next)}.`);
}
async function recPause(r){
  const cur=S.recurring.find(x=>x.id===r.id)||r,on=cur.active===false;
  if(await put('recurring',cur.id,{...strip(cur),active:on}))toast(on?'Resumed':'Paused. Nothing is made from it until you resume it.');
}
/** Review one that's waiting: open it as a new transaction, amounts and all editable; saving it moves the schedule on. */
function recReview(r){
  const date=r.next,inv=r.kind==='invoice',id=recId(r,date),doc=recIsDoc(r.kind),have=(doc?S.docs:S.entries).find(d=>d.id===id);
  // Already made for this date (by someone else just now): move the schedule on and show it.
  if(have){put('recurring',r.id,{...strip(r),next:recAfter(r,date),made:(+r.made||0)+1,last:date}).then(()=>{doc?docForm(have.kind,have):openEntry(have)});return}
  // The books are closed on that date: it can't be posted there, so offer to skip it.
  if(S.company.closingDate&&date<=S.company.closingDate){
    confirmBox('The books are closed on this date',`“${r.name}” was due on ${fmtDate(date)}, but the books are closed through ${fmtDate(S.company.closingDate)}. Skip this date and move on to the next one?`,'Skip it').then(ok=>{if(ok)recSkip(r)});return}
  const note=`<div class="banner" style="margin:0"><span><span>From recurring</span> <b>${esc(r.name)}</b>, <span>dated</span> ${fmtDate(date)}<span>. Check it, then save.</span></span></div>`;
  const onSaved=async id=>{const cur=S.recurring.find(x=>x.id===r.id)||r;await put('recurring',r.id,{...strip(cur),next:recAfter(cur,date),made:(+cur.made||0)+1,last:date});toast(`${REC_KIND[r.kind]} saved`)};
  if(!doc){
    const base={id,date,ref:r.ref||'',memo:r.memo||'',contactId:r.contactId||'',recurringId:r.id,note,onSaved};
    if(r.kind==='journal')return journalForm(null,{...base,lines:r.lines});
    if(r.kind==='transfer')return transferForm(null,{...base,form:{from:r.from,to:r.to,amount:r.amount}});
    return moneyForm(r.kind,null,{...base,form:{bank:r.bank,lines:(r.lines||[]).map(l=>({...l}))}});
  }
  docForm(r.kind,null,{id,contactId:r.contactId,date,due:addDays(date,r.terms===''||r.terms==null?+S.company.terms||0:+r.terms),memo:r.memo||'',lines:r.lines.map(l=>({...l})),note,
    onSaved:async id=>{const cur=S.recurring.find(x=>x.id===r.id)||r;await put('recurring',r.id,{...strip(cur),next:recAfter(cur,date),made:(+cur.made||0)+1,last:date});
      const d=S.docs.find(x=>x.id===id);if(d&&!d.recurringId){await put('docs',id,{...strip(d),recurringId:r.id})}toast(`${inv?'Invoice':'Bill'} saved`)}});
}
/** Stripe payments that couldn't be recorded by themselves (paid twice, or more than what's owing). */
function opIssueBanner(){
  if(typeof ME!=='undefined'&&ME&&ME.role==='client')return '';
  const list=S.docs.flatMap(d=>(d.payIssues||[]).filter(x=>!x.resolved).map(x=>({d,x})));if(!list.length)return '';
  return list.slice(0,3).map(({d,x})=>`<div class="banner err"><span><b>A Stripe payment needs you.</b> <span>${money(x.amount)} was paid online on ${fmtDate(x.date)} for invoice</span> <span class="mono">${esc(d.number||'')}</span><span>, but it’s more than what was owing, so it wasn’t recorded. Refund it in Stripe, or record it yourself (for example as a deposit to the Stripe account and a credit for the customer), then mark it dealt with.</span></span><span class="actions"><button class="btn sm" data-doc="${d.id}">Open invoice</button><button class="btn sm" data-opissue="${d.id}|${esc(x.session)}">Dealt with</button></span></div>`).join('');
}
const recWaiting=()=>S.recurring.filter(r=>r.mode==='remind'&&recDue(r));
function recBanner(){
  const w=recWaiting();if(!w.length)return '';
  return `<div class="banner"><span><b>${w.length===1?'A recurring transaction is ready to review':`${w.length} recurring transactions are ready to review`}.</b> ${w.slice(0,3).map(r=>esc(r.name)).join(', ')}${w.length>3?'…':''}</span><button class="btn sm" data-recrun="${w[0].id}">Review</button></div>`;
}

/* ---------- online payments ---------- */
let PAYCFG=null,opSynced=0;
async function opLoad(){try{PAYCFG=await api('GET','/api/pay')}catch(e){PAYCFG=null}return PAYCFG}
/** The "Pay now" link for an invoice's balance (made or refreshed through Stripe), or '' when it can't have one. */
async function opLinkFor(d){
  if(!d||d.kind!=='invoice'||d.currency||!PAYCFG||!PAYCFG.configured||docStatus(d).bal<0.5||(typeof ME!=='undefined'&&ME&&ME.role==='client'))return '';
  try{const r=await api('POST','/api/pay/link',{docId:d.id});await load();return r.url||''}catch(e){toast(`No pay link: ${e.message}`,true);return ''}
}
/** How to pay, for the bottom of an invoice and its email: e-Transfer, and the card link. */
function opHowToPay(d,link){
  const out=[];const fr=dlang()==='fr';
  if(S.company.etransfer)out.push(fr?`Paiement par virement Interac à ${S.company.etransfer}${d&&d.number?` (indiquez la facture ${d.number})`:''}.`:`Pay by Interac e-Transfer to ${S.company.etransfer}${d&&d.number?` (include invoice ${d.number} in the message)`:''}.`);
  if(link)out.push(fr?`Payer en ligne par carte : ${link}`:`Pay online by card: ${link}`);
  return out.join('\n');
}
/** Check Stripe for payments on open links. At most every 5 minutes, and only when there's a link to check. */
async function opSync(force){
  if(!PAYCFG||!PAYCFG.configured||(typeof ME!=='undefined'&&ME&&(ME.readOnly||ME.role==='client')))return;
  if(!force&&(Date.now()-opSynced<5*60e3||!S.docs.some(d=>d.payLink&&d.payLink.active!==false)))return;
  opSynced=Date.now();
  try{const r=await api('POST','/api/pay/sync');
    if(r.added&&r.added.length){await load();toast(r.added.length===1?`Paid online: ${money(r.added[0].amount)} for invoice ${r.added[0].number?'#'+r.added[0].number:''}`:`${r.added.length} online payments recorded`)}
    else if(force)toast('No new online payments.');
    if(r.errors&&r.errors.length)toast(r.errors[0],true);
  }catch(e){if(force)toast(e.message,true)}
}
function payPanel(){
  if(!ME||ME.readOnly||ME.role==='client')return '';
  const p=PAYCFG,c=S.company;
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Online payments</h3><div class="pad" style="display:flex;flex-direction:column;gap:14px">
    <form id="etForm" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap"><div class="field" style="flex:1 1 260px"><label for="etMail">Interac e-Transfer email</label><input type="email" id="etMail" value="${esc(c.etransfer||'')}" placeholder="payments@example.com" translate="no"><span class="hint">Printed on invoices and in invoice emails as how to pay. Blank = not shown.</span></div><button class="btn" type="submit">Save</button></form>
    <div style="border-top:1px solid var(--line);padding-top:12px;display:flex;flex-direction:column;gap:10px">
      <div><b>Card payments through Stripe</b> ${p&&p.configured?`<span class="pill paid">On</span>${p.mode==='test'?' <span class="pill partial">Test mode</span>':''}`:'<span class="pill quiet">Off</span>'}</div>
      <div class="muted" style="font-size:13px">Invoices get a “Pay now” link for the balance. Customers pay by card on Stripe’s page; Sumlora never sees card numbers. Payments are recorded against the invoice, into a “Stripe” bank account, when someone opens these books. When Stripe pays out to your bank, record it as a transfer from Stripe, and Stripe’s fees as an expense.</div>
      ${p&&p.configured?`<div class="muted" style="font-size:13px"><span>Key ending</span> <span class="mono">${esc(p.ending)}</span>${p.connected?` · <span>connected</span> ${fmtDate(p.connected)}`:''}</div><div class="actions" style="justify-content:flex-start"><button type="button" class="btn sm" data-opsync>Check for payments now</button><button type="button" class="btn sm ghost" data-opoff>Turn off</button></div>`
      :`<details><summary class="fsum">How to connect Stripe</summary><ol class="muted" style="font-size:13px;margin:8px 0;padding-left:20px;line-height:1.6">
        <li>Sign in to Stripe (or create the client’s account) at dashboard.stripe.com.</li>
        <li>Go to Developers → API keys → Create restricted key.</li>
        <li>Give it Write access to Prices, Products and Payment Links, and Read access to Checkout Sessions. Leave the rest as None.</li>
        <li>Copy the key (it starts with rk_live_) and paste it below. Use a test key (rk_test_) to try it first.</li></ol></details>
      <form id="opForm" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap"><div class="field" style="flex:1 1 260px"><label for="opKey">Stripe restricted key</label><input type="password" id="opKey" autocomplete="off" placeholder="rk_live_…" translate="no"><span class="hint">Kept on the server and never shown again.</span></div><button class="btn primary" type="submit">Connect</button></form>`}
    </div></div></div>`;
}
let opTried=0;
function bindPayPanel(m){
  if(S.view!=='settings')return;
  if(!PAYCFG&&Date.now()-opTried>30000&&(opTried=Date.now()))opLoad().then(()=>{if(S.view==='settings')renderMain()});
  const et=$('#etForm',m);if(et)et.onsubmit=async e=>{e.preventDefault();const v=$('#etMail',et).value.trim();if(v&&!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v))return toast('Enter an email address, or leave it blank.',true);if(await putCompany({...strip(S.company),etransfer:v}))toast(v?'e-Transfer email saved':'e-Transfer email removed')};
  const of=$('#opForm',m);if(of)of.onsubmit=async e=>{e.preventDefault();const b=of.querySelector('button');b.disabled=true;b.textContent='Checking…';
    try{PAYCFG=await api('PUT','/api/pay',{key:$('#opKey',of).value.trim()});renderMain();toast(PAYCFG.mode==='test'?'Stripe connected in test mode':'Stripe connected')}catch(err){b.disabled=false;b.textContent='Connect';toast(err.message,true)}};
  const off=$('[data-opoff]',m);if(off)off.onclick=async()=>{if(!await confirmBox('Turn off card payments?','The Stripe key is removed. Links already sent stop being checked, so record any payments made through them yourself.','Turn off'))return;try{PAYCFG=await api('PUT','/api/pay',{remove:true});renderMain();toast('Card payments turned off')}catch(e){toast(e.message,true)}};
  const sy=$('[data-opsync]',m);if(sy)sy.onclick=()=>opSync(true);
}

/* ---------- hooks ---------- */
/** Clicks in Sales and Expenses for the new tabs. Returns true when handled. */
function salesExtraClick(e,t,d){
  if(t.hasAttribute('data-estnew')){estimateForm(null);return true}
  if(d.estmake){e.stopPropagation();const x=S.estimates.find(y=>y.id===d.estmake);if(x)estToInvoice(x);return true}
  if(d.estinv){e.stopPropagation();estOpenInvoice(d.estinv);return true}
  if(d.est){const x=S.estimates.find(y=>y.id===d.est);if(x)estimateForm(x);return true}
  if(d.recnew){recurringForm(null,d.recnew);return true}
  if(d.opissue){const[docId,session]=d.opissue.split('|');api('POST','/api/pay/issue',{docId,session}).then(()=>load()).catch(err=>toast(err.message,true));return true}
  if(d.recskip){e.stopPropagation();const r=S.recurring.find(x=>x.id===d.recskip);if(r)recSkip(r);return true}
  if(d.recpause){e.stopPropagation();const r=S.recurring.find(x=>x.id===d.recpause);if(r)recPause(r);return true}
  if(d.recrun){e.stopPropagation();const r=S.recurring.find(x=>x.id===d.recrun);if(r){if(r.mode==='remind')recReview(r);else recRunDue(r.id)}return true}
  if(d.rec){const r=S.recurring.find(x=>x.id===d.rec);if(r)recurringForm(r);return true}
  return false;
}
/** When a company opens: make what's due, check for online payments. */
async function salesOnOpen(id){
  PAYCFG=null;opSynced=0;
  if(CO!==id)return;
  await opLoad();
  if(CO!==id)return;
  recRunDue();
  opSync();
}
