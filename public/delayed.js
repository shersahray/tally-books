'use strict';
/* ---------- Delayed charges and delayed credits ----------
 * Like QuickBooks Online's: work done (or a credit owed) for a customer, noted now and billed later. They aren't in
 * the books. A new invoice for the customer shows them as cards to add; added lines remember where they came from
 * (line.dl), and saving the invoice closes them (the server links them from the invoice's lines). Deleting the
 * invoice, or taking the lines off it, opens them again. The rules are in delayed-calc.js (TallyDelayed). */

const DL_KIND={charge:'Delayed charge',credit:'Delayed credit'};
const dlInvoice=r=>r.invoiceId?S.docs.find(d=>d.id===r.invoiceId):null;
const dlOpen=r=>TallyDelayed.isOpen(r,S.docs);
/** Signed amount for lists: a credit is negative. */
const dlAmt=r=>r.kind==='credit'?-TallyDelayed.total(r):TallyDelayed.total(r);
const dlCanEdit=()=>typeof ME!=='undefined'&&ME&&!ME.readOnly&&ME.role!=='client'&&(typeof perm!=='function'||perm('sales','edit'));

/** Sales → Show: Delayed charges. The list, newest first, with the same Show menu as invoices. */
function vDelayed(){
  const list=S.delayed.slice().sort((a,b)=>b.date.localeCompare(a.date)||(b.created||0)-(a.created||0));
  const open=list.filter(dlOpen),ed=dlCanEdit();
  const sum=r2(open.reduce((s,r)=>s+dlAmt(r),0));
  return `<div class="chips"><div class="chip"><div class="lbl">Open, not invoiced yet</div><div class="val">${money(sum)}</div><div class="lbl">${open.length} ${open.length===1?'charge or credit':'charges and credits'}</div></div></div>
  <div class="panel"><div class="toolbar"><label class="flabel" for="docStatus">Show</label><select id="docStatus" data-docstatus>${docStatusOptions(true)}</select><span class="grow muted">Not in your books until they’re added to an invoice.</span>${ed?'<button class="btn sm" data-dlnew="credit">+ Delayed credit</button><button class="btn sm primary" data-dlnew="charge">+ Delayed charge</button>':''}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Customer</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>${list.length?list.slice(0,shownCount('dl',list.length)).map(r=>{const inv=dlInvoice(r),op=!inv;return `<tr class="click" data-dl="${esc(r.id)}"><td style="white-space:nowrap">${fmtDate(r.date)}</td><td style="white-space:nowrap">${esc(DL_KIND[r.kind])}</td><td class="mono">${esc(r.number||'—')}</td><td class="trunc" translate="no">${esc(contactName(r.contactId))}${typeof tagPills==='function'?tagPills(r.tags):''}</td><td class="n">${money(dlAmt(r))}</td><td>${op?'<span class="pill open">Open</span>':`<span class="pill paid">Invoiced</span> <span class="mono muted" style="font-size:12px">${esc(inv.number||'')}</span>`}</td><td class="n">${op?(ed?`<button class="btn sm" data-dlinv="${esc(r.id)}">Make invoice</button>`:''):`<button class="btn sm ghost" data-doc="${esc(inv.id)}">View invoice</button>`}</td></tr>`}).join('')+moreRow('dl',shownCount('dl',list.length),list.length,7)
    :emptyRow(7,'No delayed charges yet','Note work done for a customer now, and add it to their next invoice. A delayed credit takes an amount off it.')}</tbody></table></div></div>`;
}

/** A delayed charge or credit: customer, date, lines (with products, tax codes and classes), tags. No posting. */
function delayedForm(r,kind){
  kind=r?r.kind:kind||'charge';
  const t=today(),ed=dlCanEdit(),inv=r?dlInvoice(r):null,filter=DOC_ACCT_FILTER(true);
  const defA=(sortAccts(S.accounts.filter(a=>filter(a)&&a.active!==false))[0]||{}).id||'';
  const d=r?{...r,lines:r.lines.map(l=>({...l,taxCode:taxCodeOf(l)}))}:{date:t,contactId:'',number:'',memo:'',lines:[{desc:'',account:defA,qty:1,rate:'',taxCode:'std'}]};
  const f=openModal(r?`${T(DL_KIND[kind])}${r.number?' #'+r.number:''}`:`New ${DL_KIND[kind].toLowerCase()}`,
    `${inv?`<div class="banner" style="margin:0"><span><span>On invoice</span> <b class="mono">${esc(inv.number||'')}</b>. <span>To change it, take its lines off the invoice first.</span></span> <button type="button" class="btn sm" data-doc="${esc(inv.id)}">View invoice</button></div>`
      :`<div class="muted" style="font-size:13px">${kind==='credit'?'Not in your books yet. It goes on the customer’s next invoice as a negative line.':'Not in your books yet. Add it to the customer’s next invoice when you bill them.'}</div>`}
    <div class="fields">${fld('dlC','Customer',contactSelect('dlC',d.contactId,'customer'))}${fld('dlD','Date',`<input type="date" id="dlD" value="${esc(d.date)}">`)}${fld('dlN','Reference (optional)',`<input type="text" id="dlN" maxlength="40" value="${esc(d.number||'')}">`)}${typeof classField==='function'?classField('dlCls',d.cls):''}${typeof tagField==='function'?tagField('dlTags',d.tags):''}</div>
    <div data-le></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1 1 240px"><label for="dlM">Memo</label><textarea id="dlM">${esc(d.memo||'')}</textarea></div><div class="totals"><div class="big">Total before tax</div><div class="big" data-dltot>0.00</div></div></div>
    <div class="muted" style="font-size:12.5px">Sales tax is worked out on the invoice.</div>`,
    ed&&!inv?saveFoot(!!r):`<button type="button" class="btn" data-close>Close</button>`,'wide');
  wireContactSelect(f,'dlC');
  const perLine=clsPerLine(d)&&!!$('#dlCls',f);
  const cols=[...itemCol(true,()=>!!contact($('#dlC',f).value)?.taxCode),{key:'desc',label:'Description',type:'text'},{key:'account',label:'Income account',type:'acct',filter},{key:'qty',label:'Qty',type:'num',step:'any'},{key:'rate',label:'Rate',type:'num'},{key:'taxCode',label:'Tax',type:'sel',options:taxCodeOptions},...(perLine?[clsCol()]:[]),{key:'amt',label:'Amount',type:'calc',calc:x=>r2((+x.qty||0)*(+x.rate||0))}];
  cols.defaults=()=>({qty:1,taxCode:contact($('#dlC',f).value)?.taxCode||'std',account:defA,...(perLine?{cls:topCls(f,'dlCls')}:{})});
  const le=lineEditor($('[data-le]',f),cols,perLine?withLineCls(d.lines,d.cls):d.lines,rows=>{const el=$('[data-dltot]',f);if(el)el.textContent=money((kind==='credit'?-1:1)*TallyDelayed.total({lines:rows}))});
  if(perLine)wireLineCls(f,'dlCls');
  $$('[data-doc]',f).forEach(b=>b.onclick=()=>{const x=S.docs.find(y=>y.id===b.dataset.doc);if(x){docForm(x.kind,x);addExtras('docs',x.id)}});
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox(`Delete this ${DL_KIND[kind].toLowerCase()}?`,'It isn’t in your books, so nothing else changes.'))return;if(await del('delayed',r.id)){closeModal();toast('Deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');if(!ed||inv)return;
    const ls=le.read().filter(l=>l.account&&r2((+l.qty||0)*(+l.rate||0)));
    if($('#dlC',f).value===''||($('#dlC',f).value==='__new'&&!$('#dlCNew',f).value.trim()))return f.err('Choose a customer.');
    if(!$('#dlD',f).value)return f.err('Enter a date.');
    if(!ls.length)return f.err('Add at least one line with an account and an amount.');
    if(TallyDelayed.total({lines:ls})<=0)return f.err('The amount has to be above zero.');
    const cid=await resolveContact(f,'dlC','customer');if(!cid)return;
    const data={...(r?strip(r):{created:Date.now()}),kind,contactId:cid,date:$('#dlD',f).value,number:$('#dlN',f).value.trim(),memo:$('#dlM',f).value.trim(),
      lines:ls.map(l=>({...(l.item?{item:l.item}:{}),desc:l.desc||'',account:l.account,qty:+l.qty||0,rate:+l.rate||0,taxCode:taxCodeOf(l),...(perLine?{cls:l.cls||''}:{})}))};
    const cls=$('#dlCls',f);if(cls){if(cls.value)data.cls=cls.value;else delete data.cls}
    if(typeof tagsOf==='function')setTags(data,tagsOf(f,'dlTags'));
    if(await put('delayed',r?r.id:uid(),data)){closeModal();toast(kind==='credit'?'Delayed credit saved':'Delayed charge saved')}
  };
}

/* ---------- on the invoice form ---------- */
/** The "Add to invoice" cards for a customer's open delayed charges and credits ('' when there are none). */
function dlCardsHTML(cid,docId,rows){
  if(!S.delayed.length||!cid)return '';
  const have=new Set((rows||[]).map(x=>x.dl).filter(Boolean));
  const list=TallyDelayed.forInvoice(S.delayed,S.docs,cid,docId).filter(r=>!have.has(r.id));
  if(!list.length)return '';
  return `<h3 class="fsec">Add to invoice</h3><div class="dlcards">${list.map(r=>`<div class="dlcard"><div><b>${esc(T(DL_KIND[r.kind]))}</b>${r.number?` <span class="mono muted">${esc(r.number)}</span>`:''}</div><div class="muted" style="font-size:12.5px">${fmtDate(r.date)}${r.lines[0]&&r.lines[0].desc?` · <span translate="no">${esc(r.lines[0].desc)}</span>`:''}</div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${money(dlAmt(r))}</b><button type="button" class="btn sm" data-dladd="${esc(r.id)}">Add</button></div></div>`).join('')}${list.length>1?'<div class="dlcard dlall"><button type="button" class="btn sm ghost" data-dladd="*">Add all</button></div>':''}</div>`;
}
/** Wire the cards on an invoice form: le is the line editor, rows() the lines on it now. */
function bindDlCards(f,le,docId){
  const box=$('[data-dlcards]',f);if(!box)return ()=>{};
  const draw=rows=>{box.innerHTML=dlCardsHTML($('#dC',f).value,docId,rows||le.read())};
  box.addEventListener('click',e=>{const b=e.target.closest('[data-dladd]');if(!b)return;
    const have=new Set(le.read().map(x=>x.dl).filter(Boolean));
    const pick=b.dataset.dladd==='*'?TallyDelayed.forInvoice(S.delayed,S.docs,$('#dC',f).value,docId).filter(r=>!have.has(r.id)):[S.delayed.find(x=>x.id===b.dataset.dladd)].filter(Boolean);
    if(!pick.length)return;
    le.add(pick.flatMap(r=>TallyDelayed.invoiceLines(r)));
    // Its tags come along to the invoice.
    const tb=$('#dTags',f);if(tb&&typeof tagSetIds==='function'){const ids=[...new Set([...tagIds(tb),...pick.flatMap(r=>liveTags(r.tags))])].slice(0,TallyTags.MAX_PER_TXN);if(ids.length!==tagIds(tb).length)tagSetIds(tb,ids)}
    draw();
  });
  $('#dC',f).addEventListener('change',()=>draw());
  return draw;
}

/* ---------- hooks ---------- */
function delayedClick(e,t,d){
  if(d.dlnew){delayedForm(null,d.dlnew);return true}
  if(d.dlinv){e.stopPropagation();const r=S.delayed.find(x=>x.id===d.dlinv);if(r)docForm('invoice',null,{contactId:r.contactId,lines:TallyDelayed.invoiceLines(r),...(r.cls?{cls:r.cls}:{}),...(r.tags?{tags:liveTags(r.tags)}:{})});return true}
  if(d.dl&&S.view==='sales'){const r=S.delayed.find(x=>x.id===d.dl);if(r)delayedForm(r);return true}
  return false;
}
