'use strict';
/* ---------- Purchase orders and mileage (Expenses) ----------
   Purchase orders aren't in the books: "Make bill" turns one into a bill and links them.
   Mileage: a log of business trips, valued at the CRA's tax-free per-kilometre rates. A claim records the
   value as one journal entry (an expense owed to whoever drove), and marks the trips so they're claimed once. */

/* ---------- purchase orders ---------- */
const PO_STATE=x=>x.billId&&S.docs.some(d=>d.id===x.billId)?{k:'paid',label:'Billed'}:x.status==='closed'?{k:'quiet',label:'Closed'}:x.expected&&x.expected<today()?{k:'overdue',label:'Late'}:{k:'open',label:'Open'};
const nextPoNum=()=>'PO-'+(Math.max(1000,...S.pos.map(p=>parseInt(String(p.number).replace(/^PO-/i,''))||0))+1);
function vPos(){
  const list=S.pos.slice().sort((a,b)=>b.date.localeCompare(a.date)||String(b.number).localeCompare(String(a.number),undefined,{numeric:true}));
  const open=list.filter(x=>['Open','Late'].includes(PO_STATE(x).label));
  const staff=ME&&ME.role!=='client'&&!ME.readOnly;
  return `<div class="chips"><div class="chip"><div class="lbl">Open purchase orders</div><div class="val">${money(open.reduce((s,x)=>s+(+x.total||0),0))}</div><div class="lbl">${open.length} order${open.length===1?'':'s'}</div></div></div>
  <div class="panel"><div class="toolbar"><span class="grow muted">Purchase orders aren’t in your books until you turn them into a bill.</span>${staff?'<button class="btn sm primary" data-ponew>+ New purchase order</button>':''}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>No.</th><th>Vendor</th><th>Expected</th><th class="n">Total</th><th>Status</th><th></th></tr></thead><tbody>${list.length?list.map(x=>{const st=PO_STATE(x);return `<tr class="click" data-po="${esc(x.id)}"><td style="white-space:nowrap">${fmtDate(x.date)}</td><td class="mono">${esc(x.number||'—')}</td><td class="trunc" translate="no">${esc(contactName(x.contactId))}</td><td class="muted" style="white-space:nowrap">${x.expected?fmtDate(x.expected):'—'}</td><td class="n">${money(x.total)}</td><td><span class="pill ${st.k}">${esc(T(st.label))}</span></td><td class="n">${st.label==='Billed'?`<button class="btn sm" data-pobill="${esc(x.billId)}">View bill</button>`:st.label==='Closed'||!staff?'':`<button class="btn sm" data-pomake="${esc(x.id)}">Make bill</button>`}</td></tr>`}).join(''):emptyRow(7,'No purchase orders yet','Send a vendor an order; when the bill comes in, turn the order into the bill in one click.')}</tbody></table></div></div>`;
}
function poForm(x){
  const t=today(),filter=DOC_ACCT_FILTER(false),defA=(sortAccts(S.accounts.filter(a=>filter(a)&&a.active!==false))[0]||{}).id||'';
  const d=x?{...x,lines:x.lines.map(l=>({...l,taxCode:taxCodeOf(l)}))}:{number:nextPoNum(),date:t,expected:addDays(t,14),contactId:'',lines:[{desc:'',account:defA,qty:1,rate:'',taxCode:'std'}],memo:'',shipTo:S.company.address||'',status:'open'};
  const st=x?PO_STATE(x):null,done=st&&st.label==='Billed';
  const f=openModal(x?`Purchase order ${x.number||''}`:'New purchase order',
    `${done?`<div class="banner" style="margin:0"><span>This purchase order was turned into a bill.</span> <button type="button" class="btn sm" data-pobill="${esc(x.billId)}">View bill</button></div>`:''}
    <div class="fields">${fld('poC','Vendor',contactSelect('poC',d.contactId,'vendor'))}${fld('poN','PO no.',`<input type="text" id="poN" value="${esc(d.number)}">`)}${fld('poD','Date',`<input type="date" id="poD" value="${esc(d.date)}">`)}${fld('poX','Expected by',`<input type="date" id="poX" value="${esc(d.expected||'')}">`)}
    ${fieldInputs(d,true)}${x&&!done?fld('poS','Status',`<select id="poS"><option value="open" ${d.status!=='closed'?'selected':''}>${esc(T('Open'))}</option><option value="closed" ${d.status==='closed'?'selected':''}>${esc(T('Closed'))}</option></select>`):''}</div>
    <div data-le></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1 1 240px"><label for="poShip">Ship to</label><textarea id="poShip" rows="2">${esc(d.shipTo||'')}</textarea><label for="poM" style="margin-top:8px">Message to vendor</label><textarea id="poM">${esc(d.memo||'')}</textarea></div>${totalsHTML()}</div>`,
    `${delBtn(!!x)}${x?'<button type="button" class="btn ghost" data-popdf>PDF</button><button type="button" class="btn ghost" data-pomail>Email</button>':''}<button type="button" class="btn" data-close>Cancel</button>${!done&&!(x&&x.status==='closed')?'<button type="button" class="btn" data-pomakehere>Save and make bill</button>':''}<button type="submit" class="btn primary">Save</button>`,'wide');
  wireContactSelect(f,'poC');
  const cols=[...itemCol(false,()=>!!contact($('#poC',f).value)?.taxCode),{key:'desc',label:'Description',type:'text'},{key:'account',label:'Expense account',type:'acct',filter},{key:'qty',label:'Qty',type:'num',step:'any'},{key:'rate',label:'Cost',type:'num'},{key:'taxCode',label:'Tax',type:'sel',options:taxCodeOptions},{key:'amt',label:'Amount',type:'calc',calc:r=>r2((+r.qty||0)*(+r.rate||0))}];
  cols.defaults=()=>({qty:1,taxCode:contact($('#poC',f).value)?.taxCode||'std',account:defA});
  const le=lineEditor($('[data-le]',f),cols,d.lines,r=>setTotals(f,calcLines(r,y=>(+y.qty||0)*(+y.rate||0),true)));
  const save=async()=>{f.err('');
    const c=calcLines(le.read(),y=>(+y.qty||0)*(+y.rate||0),true);
    if($('#poC',f).value===''||($('#poC',f).value==='__new'&&!$('#poCNew',f).value.trim())){f.err('Choose a vendor.');return null}
    if(!$('#poD',f).value){f.err('Enter a date.');return null}
    if(!c.ls.length){f.err('Add at least one line with an account and an amount.');return null}
    const cid=await resolveContact(f,'poC','vendor');if(!cid)return null;
    const id=x?x.id:uid(),r=docRecord(c);delete r.taxRate;
    const data={...(x?strip(x):{}),number:$('#poN',f).value.trim(),date:$('#poD',f).value,expected:$('#poX',f).value,contactId:cid,memo:$('#poM',f).value.trim(),shipTo:$('#poShip',f).value.trim(),status:$('#poS',f)?.value||d.status||'open',billId:x?.billId||'',...r,created:x?.created||Date.now()};
    const fv=readFields(f,true,x);if(Object.keys(fv).length)data.fields=fv;else delete data.fields;
    if(!await put('pos',id,data))return null;
    return{...data,id};
  };
  f.onsubmit=async e=>{e.preventDefault();if(await save()){closeModal();toast('Purchase order saved')}};
  const mh=$('[data-pomakehere]',f);if(mh)mh.onclick=async()=>{const s=await save();if(s){closeModal();poToBill(s)}};
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this purchase order?',done?'The bill made from it stays.':'Purchase orders aren’t in your books, so nothing else changes.'))return;if(await del('pos',x.id)){closeModal();toast('Purchase order deleted')}};
  const pb=$('[data-popdf]',f);if(pb)pb.onclick=async()=>{try{saveFile(pdfName('po',x.number),new Blob([await docPdf({...x,kind:'po'})],{type:'application/pdf'}))}catch(e){toast(e.message,true)}};
  const mb=$('[data-pomail]',f);if(mb)mb.onclick=()=>{closeModal();composeMail({kind:'po',contactId:x.contactId,docIds:[],fileName:pdfName('po',x.number),makePdf:()=>docPdf({...(S.pos.find(y=>y.id===x.id)||x),kind:'po'}),vars:{name:contactName(x.contactId),num:x.number||'',amount:dmoney(x.total),due:x.expected?ddate(x.expected):''}})};
  $$('[data-pobill]',f).forEach(b=>b.onclick=()=>{closeModal();poOpenBill(b.dataset.pobill)});
}
function poOpenBill(id){const d=S.docs.find(y=>y.id===id);if(d){docForm('bill',d);addExtras('docs',d.id)}}
/** A new bill filled in from the purchase order; saving it links the two and closes the order. */
function poToBill(x){
  docForm('bill',null,{contactId:x.contactId,memo:x.number?`${T('PO')} ${x.number}`:'',lines:x.lines.map(l=>({item:l.item||'',desc:l.desc,account:l.account,qty:l.qty,rate:l.rate,taxCode:l.taxCode})),
    note:`<div class="banner" style="margin:0"><span>From purchase order</span> <b class="mono">${esc(x.number||'')}</b><span>. Enter the vendor’s bill number and check the amounts, then save.</span></div>`,
    onSaved:async id=>{const cur=S.pos.find(y=>y.id===x.id)||x;await put('pos',x.id,{...strip(cur),status:'closed',billId:id});toast('Bill saved and linked to the purchase order')}});
}

/* ---------- mileage ---------- */
// CRA tax-free automobile allowance rates ($/km): the first 5,000 km in a calendar year, then each km after. Territories add 4¢.
const CRA_KM={2024:[0.70,0.64],2025:[0.72,0.66],2026:[0.73,0.67]};
function kmRates(year){
  const own=(S.company.mileage&&S.company.mileage.rates||{})[year];
  if(own&&(+own.first||+own.after))return[+own.first||0,+own.after||0,true];
  const ys=Object.keys(CRA_KM).map(Number),y=CRA_KM[year]?year:year<Math.min(...ys)?Math.min(...ys):Math.max(...ys);
  const add=S.company.mileage&&S.company.mileage.territories?0.04:0;
  return[r2(CRA_KM[y][0]+add),r2(CRA_KM[y][1]+add),false];
}
/** Each trip's value: trips in date order, the first 5,000 km of each calendar year at the first rate. */
function tripValues(){
  const out={},byYear={};
  for(const t of S.trips.slice().sort((a,b)=>a.date.localeCompare(b.date)||(a.created||0)-(b.created||0))){
    const y=+t.date.slice(0,4),[r1,r2_]=kmRates(y),used=byYear[y]||0,first=Math.max(0,Math.min(+t.km,5000-used)),rest=+t.km-first;
    byYear[y]=used+(+t.km);out[t.id]={value:r2(first*r1+rest*r2_),rate:rest&&first?null:first?r1:r2_};
  }
  return out;
}
function vMileage(){
  const ms=S.company.mileage||{},vals=tripValues(),y=new Date().getFullYear(),staff=ME&&ME.role!=='client'&&!ME.readOnly;
  const yr=S.trips.filter(t=>+t.date.slice(0,4)===y),km=yr.reduce((s,t)=>s+(+t.km||0),0),val=r2(yr.reduce((s,t)=>s+vals[t.id].value,0));
  const unc=S.trips.filter(t=>!t.entryId),uv=r2(unc.reduce((s,t)=>s+vals[t.id].value,0));
  const[r1,r2_,own]=kmRates(y);
  const list=S.trips.slice().sort((a,b)=>b.date.localeCompare(a.date)||(b.created||0)-(a.created||0));
  return `<div class="chips"><div class="chip"><div class="lbl">Kilometres in ${y}</div><div class="val">${km.toLocaleString(LOC(),{maximumFractionDigits:1})} km</div></div><div class="chip"><div class="lbl">Value at ${own?'your rates':'CRA rates'}</div><div class="val">${money(val)}</div></div><div class="chip"><div class="lbl">Not claimed yet</div><div class="val">${money(uv)}</div><div class="lbl">${unc.length} trip${unc.length===1?'':'s'}</div></div></div>
  <div class="panel"><div class="toolbar"><span class="grow muted">${y}: ${money(r1)}/km for the first 5,000 km, ${money(r2_)}/km after${own?'':` (${T('CRA tax-free rates')}${ms.territories?', '+T('territories'):''})`}.</span>${staff?`<button class="btn sm" data-mlset>Settings</button>${unc.length?'<button class="btn sm" data-mlclaim>Record claim</button>':''}<button class="btn sm primary" data-trip="">+ Add trip</button>`:''}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Trip</th><th>Business purpose</th><th>Customer or vendor</th><th class="n">km</th><th class="n">Value</th><th>Claimed</th></tr></thead><tbody>${list.length?list.map(t=>`<tr class="click" data-trip="${esc(t.id)}"><td style="white-space:nowrap">${fmtDate(t.date)}</td><td class="trunc" translate="no">${esc([t.from,t.to].filter(Boolean).join(' → ')||'—')}</td><td class="trunc" translate="no">${esc(t.purpose)}</td><td class="trunc" translate="no">${esc(contactName(t.contactId)||'')}</td><td class="n">${(+t.km).toLocaleString(LOC(),{maximumFractionDigits:1})}</td><td class="n">${money(vals[t.id].value)}</td><td>${t.entryId?`<button class="link" data-entry="${esc(t.entryId)}" title="${esc(T('Undo claim'))}">${esc(T('Claimed'))}</button>`:'<span class="muted">—</span>'}</td></tr>`).join(''):emptyRow(7,'No trips yet','Log each business trip: the date, where, why and the kilometres. The CRA asks for this log if you claim a vehicle allowance.')}</tbody></table></div></div>`;
}
function tripForm(t){
  const staff=ME&&ME.role!=='client'&&!ME.readOnly,d=t||{date:today(),from:'',to:'',purpose:'',km:'',contactId:'',vehicle:(S.trips.slice(-1)[0]||{}).vehicle||''};
  const f=openModal(t?'Trip':'Add trip',`${t&&t.entryId?'<div class="banner" style="margin:0"><span>This trip is part of a claim. Undo the claim to change it.</span></div>':''}<div class="fields">
    ${fld('trDate','Date',`<input type="date" id="trDate" value="${esc(d.date)}">`)}${fld('trKm','Kilometres',`<input type="number" id="trKm" step="0.1" min="0" inputmode="decimal" value="${esc(d.km)}">`)}
    ${fld('trFrom','From',`<input type="text" id="trFrom" maxlength="120" value="${esc(d.from||'')}">`)}${fld('trTo','To',`<input type="text" id="trTo" maxlength="120" value="${esc(d.to||'')}">`)}
    ${fld('trPurpose','Business purpose',`<input type="text" id="trPurpose" maxlength="200" value="${esc(d.purpose||'')}" placeholder="${esc(T('e.g. Meeting with client, bank deposit'))}">`,true)}
    ${fld('trC','Customer or vendor (optional)',`<select id="trC"><option value="">${T('None')}</option>${S.contacts.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${esc(c.id)}" ${c.id===d.contactId?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`)}
    ${fld('trVeh','Vehicle (optional)',`<input type="text" id="trVeh" maxlength="60" value="${esc(d.vehicle||'')}">`)}
    </div>`,staff&&!(t&&t.entryId)?saveFoot(!!t):'<button type="button" class="btn" data-close>Close</button>');
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this trip?','It’s taken out of the mileage log.','Delete'))return;if(await del('trips',t.id)){closeModal();toast('Trip deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');if(!staff||(t&&t.entryId))return;
    const km=+$('#trKm',f).value;if(!(km>0))return f.err('Enter the kilometres driven.');
    if(!$('#trPurpose',f).value.trim())return f.err('Enter the business purpose.');
    if(await put('trips',t?t.id:uid(),{date:$('#trDate',f).value||today(),km,from:$('#trFrom',f).value.trim(),to:$('#trTo',f).value.trim(),purpose:$('#trPurpose',f).value.trim(),contactId:$('#trC',f).value,vehicle:$('#trVeh',f).value.trim(),entryId:t?.entryId||'',created:t?.created||Date.now()})){closeModal();toast(t?'Trip saved':'Trip added')}};
}
function mileageSettings(){
  const ms=S.company.mileage||{},y=new Date().getFullYear(),own=(ms.rates||{})[y]||{};
  const exp=sortAccts(S.accounts.filter(a=>(a.type==='Expense')&&a.active!==false)),defE=ms.expenseAccount||(exp.find(a=>/vehicle|auto|car|mileage|véhicule|automobile|kilom/i.test(a.name))||{}).id||'';
  const liab=sortAccts(S.accounts.filter(a=>(a.type==='Liability'||a.detail==='bank')&&a.active!==false)),defP=ms.payAccount||(liab.find(a=>/shareholder|owner|due to|actionnaire|employee|propriétaire/i.test(a.name))||{}).id||'';
  const f=openModal('Mileage settings',`<div class="fields">
    ${fld('msExp','Expense account for claims',`<select id="msExp"><option value="">${T('Choose account…')}</option>${acctOptions(defE,a=>a.type==='Expense')}</select>`)}
    ${fld('msPay','Owed to (or paid from)',`<select id="msPay"><option value="">${T('Choose account…')}</option>${acctOptions(defP,a=>a.type==='Liability'||a.detail==='bank'||a.type==='Equity')}</select><span class="hint">Usually “Due to shareholder” when the owner drove their own car, or the bank account the reimbursement came from.</span>`)}
    </div><label class="check"><input type="checkbox" id="msTerr" ${ms.territories?'checked':''}> <span>Trips are in the Yukon, Northwest Territories or Nunavut (CRA rates are 4¢ higher)</span></label>
    <div class="subpanel"><div class="flabel">${y}: your own rates (optional)</div><div class="muted" style="font-size:13px">Leave blank to use the CRA’s tax-free rates. Paying more than the CRA rates can make the allowance taxable to the person who drove.</div>
    <div class="fields">${fld('msR1','First 5,000 km ($/km)',`<input type="number" id="msR1" step="0.01" min="0" value="${esc(own.first||'')}">`)}${fld('msR2','After 5,000 km ($/km)',`<input type="number" id="msR2" step="0.01" min="0" value="${esc(own.after||'')}">`)}</div></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`);
  f.onsubmit=async e=>{e.preventDefault();const rates={...(ms.rates||{})};const a=+$('#msR1',f).value||0,b=+$('#msR2',f).value||0;if(a||b)rates[y]={first:a,after:b};else delete rates[y];
    if(await putCompany({...strip(S.company),mileage:{expenseAccount:$('#msExp',f).value,payAccount:$('#msPay',f).value,territories:$('#msTerr',f).checked,rates}})){closeModal();toast('Mileage settings saved')}};
}
function claimForm(){
  const ms=S.company.mileage||{},vals=tripValues();
  if(!acct(ms.expenseAccount)||!acct(ms.payAccount)){toast('Choose the accounts in mileage Settings first.',true);return mileageSettings()}
  const unc=S.trips.filter(t=>!t.entryId).sort((a,b)=>a.date.localeCompare(b.date)),last=unc.slice(-1)[0].date;
  const f=openModal('Record mileage claim',`<div class="fields">${fld('clTo','Trips up to',`<input type="date" id="clTo" value="${esc(last)}">`)}${fld('clDate','Date of the claim',`<input type="date" id="clDate" value="${esc(today())}">`)}</div><div data-clsum></div>
    <div class="muted" style="font-size:13px"><span>Records one journal entry: the value goes to</span> <b translate="no">${esc(acctName(ms.expenseAccount))}</b>, <span>owed to</span> <b translate="no">${esc(acctName(ms.payAccount))}</b>. <span>No sales tax is claimed on allowances.</span></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Record claim</button>`);
  const pick=()=>unc.filter(t=>t.date<=($('#clTo',f).value||last));
  const show=()=>{const p=pick(),km=p.reduce((s,t)=>s+(+t.km||0),0),v=r2(p.reduce((s,t)=>s+vals[t.id].value,0));$('[data-clsum]',f).innerHTML=`<div class="chips"><div class="chip"><div class="lbl">${esc(T('Trips'))}</div><div class="val">${p.length}</div></div><div class="chip"><div class="lbl">km</div><div class="val">${km.toLocaleString(LOC(),{maximumFractionDigits:1})}</div></div><div class="chip"><div class="lbl">${esc(T('Claim'))}</div><div class="val">${money(v)}</div></div></div>`};
  $('#clTo',f).onchange=show;show();
  f.onsubmit=async e=>{e.preventDefault();f.err('');const p=pick();if(!p.length)return f.err('No trips up to that date.');
    const v=r2(p.reduce((s,t)=>s+vals[t.id].value,0)),km=p.reduce((s,t)=>s+(+t.km||0),0),id=uid(),fr=S.company.lang==='fr';
    const memo=fr?`Allocation pour frais de déplacement : ${p.length} trajet${p.length>1?'s':''}, ${km.toLocaleString('fr-CA')} km (${fmtDate(p[0].date)} – ${fmtDate(p.slice(-1)[0].date)})`:`Mileage claim: ${p.length} trip${p.length>1?'s':''}, ${km.toLocaleString('en-CA')} km (${fmtDate(p[0].date)} – ${fmtDate(p.slice(-1)[0].date)})`;
    const w=[{op:'set',collection:'entries',id,data:{type:'journal',date:$('#clDate',f).value||today(),ref:'',memo,mileage:true,lines:[{account:ms.expenseAccount,debit:v,credit:0,memo:fr?'Kilométrage':'Mileage'},{account:ms.payAccount,debit:0,credit:v}],created:Date.now()}},
      ...p.map(t=>({op:'set',collection:'trips',id:t.id,data:{...strip(t),entryId:id}}))];
    if(await batch(w)){closeModal();toast(`Claim of ${money(v)} recorded`)}};
}
async function undoClaim(entryId){
  const ts=S.trips.filter(t=>t.entryId===entryId);
  if(!await confirmBox('Undo this mileage claim?',`The journal entry is deleted and its ${ts.length} trip${ts.length===1?'':'s'} can be claimed again.`,'Undo claim'))return;
  if(await batch([...ts.map(t=>({op:'set',collection:'trips',id:t.id,data:{...strip(t),entryId:''}})),{op:'delete',collection:'entries',id:entryId}]))toast('Claim undone');
}

/* ---------- clicks on the Expenses tabs ---------- */
function purchasingClick(e,t,d){
  if(S.view!=='expenses')return false;
  if(t.hasAttribute('data-ponew')){poForm(null);return true}
  if(d.pomake){e.stopPropagation();const x=S.pos.find(y=>y.id===d.pomake);if(x)poToBill(x);return true}
  if(d.pobill){e.stopPropagation();poOpenBill(d.pobill);return true}
  if(d.po){const x=S.pos.find(y=>y.id===d.po);if(x)poForm(x);return true}
  if(d.trip!==undefined){tripForm(d.trip?S.trips.find(y=>y.id===d.trip):null);return true}
  if(t.hasAttribute('data-mlset')){mileageSettings();return true}
  if(t.hasAttribute('data-mlclaim')){claimForm();return true}
  if(d.entry&&S.trips.some(x=>x.entryId===d.entry)){e.stopPropagation();undoClaim(d.entry);return true}
  return false;
}
