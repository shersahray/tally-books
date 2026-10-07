'use strict';
/* ---------- Fixed assets: the register, book amortization and the CCA schedule ----------
   Book amortization (accounting): straight-line over a useful life, or declining balance at a rate, counted by the
   months the asset is held in each fiscal year. "Record amortization" posts one journal entry for the year
   (debit each expense account, credit each accumulated amortization account) and remembers it on each asset.
   CCA (tax): by class, a worksheet for T2 Schedule 8: opening UCC, additions, disposals (the lesser of proceeds and
   cost), the first-year rule for additions, the claim at the class rate, and closing UCC, with recapture or terminal
   loss. The rules for the first year change often (half-year rule, the accelerated investment incentive, immediate
   expensing), so each asset says which applies to it. */

const CCA_CLASSES={'1':[4,'Buildings acquired after 1987'],'3':[5,'Buildings acquired before 1988, some additions'],'6':[10,'Frame, log or stucco buildings; fences; greenhouses'],'7':[15,'Canoes, boats, ships'],'8':[20,'Furniture, fixtures, equipment, machinery not in another class'],'10':[30,'Vehicles, general-purpose electronic equipment'],'10.1':[30,'Passenger vehicles over the cost limit'],'12':[100,'Tools and utensils under $500, software (not systems), uniforms'],'14.1':[5,'Goodwill and other intangibles (after 2016)'],'16':[40,'Taxis, rental cars, heavy trucks'],'17':[8,'Roads, parking lots, sidewalks'],'38':[30,'Power-operated movable equipment'],'43':[30,'Manufacturing and processing machinery'],'43.1':[30,'Clean energy equipment'],'44':[25,'Patents and patent licences'],'46':[30,'Data network infrastructure'],'50':[55,'Computers and systems software'],'53':[50,'Manufacturing and processing machinery (2016–2025)'],'54':[30,'Zero-emission passenger vehicles'],'55':[40,'Zero-emission vehicles (would be class 16)'],'56':[30,'Zero-emission automotive equipment']};
const FIRST_YEAR={half:['Half-year rule (½ in the first year)',0.5],full:['Full first year (no half-year rule)',1],aiip:['Accelerated: 1½ × in the first year',1.5]};
const fyKey=fy=>fy.slice(0,4);
const fyStartsBetween=(a,b)=>{const out=[];let x=a;while(x<=b){out.push(x);x=iso(new Date(pd(x).getFullYear()+1,pd(x).getMonth(),1))}return out};
const monthsHeld=(a,fy)=>{
  const end=fyEndOf(fy),s=a.acquired>fy?a.acquired:fy,e=a.disposed&&a.disposed<end?a.disposed:end;
  if(s>e)return 0;return(+e.slice(0,4)*12+ +e.slice(5,7))-(+s.slice(0,4)*12+ +s.slice(5,7))+1;
};
/** Book amortization, year by year: { fyStart: { amount, accum (at year end), nbv } } */
function bookSchedule(a){
  const out={},first=a.openingFy&&a.openingFy>fyStartOf(a.acquired)?a.openingFy:fyStartOf(a.acquired);
  let accum=a.openingFy&&a.openingFy>fyStartOf(a.acquired)?+a.opening||0:0;
  const now=fyStartOf(today()),last=a.disposed?fyStartOf(a.disposed):now>first?now:first;
  for(const fy of fyStartsBetween(first,last)){
    const m=Math.min(12,monthsHeld(a,fy)),room=Math.max(0,r2((+a.cost||0)-(+a.salvage||0)-accum));
    let amt=a.method==='straight'&&+a.life>0?((+a.cost||0)-(+a.salvage||0))/(+a.life)*m/12:a.method==='declining'?((+a.cost||0)-accum)*(+a.rate||0)/100*m/12:0;
    // After a disposal entry, years not already recorded stop: the gain or loss took the rest.
    if(a.disposalEntry&&a.disposed&&fy>=fyStartOf(a.disposed)&&!(a.posted||{})[fyKey(fy)])amt=0;
    amt=r2(Math.max(0,Math.min(amt,room)));accum=r2(accum+amt);
    out[fy]={amount:amt,accum,nbv:r2((+a.cost||0)-accum)};
  }
  return out;
}
/** Accumulated amortization actually in the books: the opening amount plus the years recorded. */
function bookedAccum(a){const s=bookSchedule(a);let t=a.openingFy&&a.openingFy>fyStartOf(a.acquired)?+a.opening||0:0;for(const[fy,v]of Object.entries(s))if((a.posted||{})[fyKey(fy)])t+=v.amount;return r2(t)}

/** The CCA schedule for one fiscal year: a row per class. */
function ccaSchedule(fy){
  const op=S.company.ccaOpening||{},classes=[...new Set(S.assets.map(a=>a.ccaClass).filter(Boolean).concat(Object.keys(op)))].sort((a,b)=>parseFloat(a)-parseFloat(b));
  return classes.map(k=>{
    const as=S.assets.filter(a=>a.ccaClass===k),o=op[k];
    const rate=(as.find(a=>+a.ccaRate>0)||{}).ccaRate||(CCA_CLASSES[k]||[0])[0];
    const starts=[o&&o.fy,...as.map(a=>fyStartOf(a.acquired))].filter(Boolean).sort();
    if(!starts.length||starts[0]>fy)return null;
    let ucc=0,row=null;
    for(const y of fyStartsBetween(starts[0],fy)){
      const open=o&&y===o.fy?+o.ucc||0:ucc;
      const counted=a=>!(o&&a.acquired<o.fy); // bought before the opening UCC: already in it
      const adds=as.filter(a=>counted(a)&&fyStartOf(a.acquired)===y);
      const disp=as.filter(a=>a.disposed&&fyStartOf(a.disposed)===y&&(counted(a)||true));
      const add=r2(adds.reduce((s,a)=>s+(+a.cost||0),0)),dis=r2(disp.reduce((s,a)=>s+Math.min(+a.proceeds||0,+a.cost||0),0));
      const before=r2(open+add-dis),net=r2(add-dis);
      // First-year rule on the net additions, each addition at its own factor.
      const wf=add>0?adds.reduce((s,a)=>s+(+a.cost||0)*FIRST_YEAR[a.firstYear||'half'][1],0)/add:1;
      const adj=net>0?r2(net*(wf-1)):0;
      const base=Math.max(0,r2(before+adj));
      let cca=before>0?r2(Math.min(base*rate/100,before)):0;
      let close=r2(before-cca),recapture=0,terminal=0;
      if(before<0){recapture=r2(-before);cca=0;close=0}
      const left=as.filter(a=>!a.disposed||a.disposed>fyEndOf(y));
      if(as.length&&!left.length&&close>0&&y===fy){terminal=close;cca=0;close=0}
      ucc=close;
      if(y===fy)row={k,rate,open,add,dis,adj,base,cca,close,recapture,terminal,desc:(CCA_CLASSES[k]||[0,''])[1]};
    }
    return row;
  }).filter(Boolean);
}

function vAssets(){
  if(!feat('fixedAssets'))return head('Fixed assets','')+'<div class="panel"><div class="empty"><b>Fixed assets aren’t on</b>Fixed assets and CCA are in the Plus plan. They can also be switched off for this company in Settings.</div></div>';
  const F=S.fa||(S.fa={tab:'register',fy:fyStartOf(today())});
  const staff=ME&&ME.role!=='client'&&!ME.readOnly;
  const first=[...S.assets.map(a=>fyStartOf(a.acquired)),...Object.values(S.company.ccaOpening||{}).map(o=>o.fy)].sort()[0]||fyStartOf(today());
  const years=fyStartsBetween(first<fyStartOf(today())?first:fyStartOf(today()),fyStartOf(today())).reverse();
  if(!years.includes(F.fy))F.fy=years[0];
  const h=head('Fixed assets','Equipment, vehicles and buildings: amortization for the books and the CCA schedule for the T2',staff?'<button class="btn primary" data-asset="">+ Add asset</button>':'')+
    `<div class="tabs" role="tablist">${[['register','Register'],['amort','Amortization'],['cca','CCA schedule']].map(([k,v])=>`<button role="tab" data-fatab="${k}" aria-selected="${F.tab===k}">${v}</button>`).join('')}</div>`;
  const yearSel=`<label class="flabel" for="faYear">Fiscal year</label><select id="faYear">${years.map(y=>`<option value="${y}" ${y===F.fy?'selected':''}>${esc(fmtDate(y))} – ${esc(fmtDate(fyEndOf(y)))}</option>`).join('')}</select>`;
  if(F.tab==='amort')return h+vAmort(F.fy,yearSel,staff);
  if(F.tab==='cca')return h+vCca(F.fy,yearSel,staff);
  const list=S.assets.slice().sort((a,b)=>(a.disposed?1:0)-(b.disposed?1:0)||a.acquired.localeCompare(b.acquired));
  const tot={cost:0,acc:0};
  const rows=list.map(a=>{const s=bookSchedule(a)[F.fy],acc=s?s.accum:(F.fy<fyStartOf(a.acquired)?0:bookedAccum(a));const out=a.disposed&&a.disposed<F.fy;if(!out&&a.acquired<=fyEndOf(F.fy)){tot.cost+=+a.cost;tot.acc+=acc}
    return `<tr class="click ${out?'archived':''}" data-asset="${esc(a.id)}"><td><b translate="no">${esc(a.name)}</b>${a.disposed?` <span class="pill quiet">${T('Disposed')} ${fmtDate(a.disposed)}</span>`:''}</td><td>${a.ccaClass?esc(a.ccaClass):'<span class="muted">—</span>'}</td><td style="white-space:nowrap">${fmtDate(a.acquired)}</td><td class="n">${money(a.cost)}</td><td class="n">${money(acc)}</td><td class="n">${money(r2(a.cost-acc))}</td><td class="muted">${a.method==='straight'?`${T('Straight-line')}, ${a.life} ${T('years')}`:a.method==='declining'?`${T('Declining')} ${a.rate}%`:T('Not amortized')}</td></tr>`}).join('');
  return h+`<div class="panel"><div class="toolbar">${yearSel}<span class="grow muted">${T('Amounts at the end of the fiscal year.')}</span></div><div class="tbl-wrap"><table><thead><tr><th>Asset</th><th>CCA class</th><th>Bought</th><th class="n">Cost</th><th class="n">Accumulated amortization</th><th class="n">Book value</th><th>Method</th></tr></thead><tbody>${rows||emptyRow(7,'No assets yet','Add equipment, vehicles, computers or buildings the business owns, with what they cost and when they were bought.')}</tbody>${rows?`<tfoot><tr class="grand"><td colspan="3">Total</td><td class="n">${money(r2(tot.cost))}</td><td class="n">${money(r2(tot.acc))}</td><td class="n">${money(r2(tot.cost-tot.acc))}</td><td></td></tr></tfoot>`:''}</table></div></div>`;
}
function amortRows(fy){return S.assets.map(a=>({a,s:bookSchedule(a)[fy]})).filter(x=>x.s&&(x.s.amount>0||(x.a.posted||{})[fyKey(fy)]))}
function vAmort(fy,yearSel,staff){
  const rows=amortRows(fy),key=fyKey(fy);
  const posted=[...new Set(rows.map(x=>(x.a.posted||{})[key]).filter(id=>id&&S.entries.some(e=>e.id===id)))];
  const todo=rows.filter(x=>!(x.a.posted||{})[key]&&x.s.amount>0),tot=r2(rows.reduce((s,x)=>s+x.s.amount,0));
  return `<div class="panel"><div class="toolbar">${yearSel}<span class="grow"></span>${staff&&todo.length?`<button class="btn sm primary" data-faact="post">Record amortization (${money(r2(todo.reduce((s,x)=>s+x.s.amount,0)))})</button>`:''}${staff&&posted.length?posted.map(id=>`<button class="btn sm" data-entry="${esc(id)}">View entry</button><button class="btn sm ghost" data-faundo="${esc(id)}">Undo</button>`).join(''):''}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Asset</th><th>Expense account</th><th class="n">Months</th><th class="n">Amortization</th><th class="n">Accumulated at year end</th><th class="n">Book value</th><th>In the books</th></tr></thead><tbody>${rows.length?rows.map(({a,s})=>`<tr class="click" data-asset="${esc(a.id)}"><td translate="no">${esc(a.name)}</td><td class="trunc" translate="no">${esc(acctName(a.expenseAccount))}</td><td class="n">${Math.min(12,monthsHeld(a,fy))}</td><td class="n">${money(s.amount)}</td><td class="n">${money(s.accum)}</td><td class="n">${money(s.nbv)}</td><td>${(a.posted||{})[key]?'<span class="pill paid">Recorded</span>':'<span class="pill partial">Not recorded</span>'}</td></tr>`).join(''):emptyRow(7,'Nothing to amortize this year','Assets with straight-line or declining balance amortization show here.')}</tbody>${rows.length?`<tfoot><tr class="grand"><td colspan="3">Total</td><td class="n">${money(tot)}</td><td colspan="3"></td></tr></tfoot>`:''}</table></div>
  <div class="muted" style="font-size:12.5px;padding:10px 12px">${T('Recorded as one journal entry on the last day of the fiscal year: each expense account is debited and each accumulated amortization account credited.')}</div></div>`;
}
function vCca(fy,yearSel,staff){
  const rows=ccaSchedule(fy),t=k=>r2(rows.reduce((s,r)=>s+r[k],0));
  return `<div class="panel"><div class="toolbar">${yearSel}<span class="grow"></span>${staff?'<button class="btn sm" data-faact="opening">Opening UCC…</button>':''}<button class="btn sm" data-faact="ccacsv">Export CSV</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Class</th><th class="n">Rate</th><th class="n">UCC at start</th><th class="n">Additions</th><th class="n">Disposals</th><th class="n">First-year adjustment</th><th class="n">CCA</th><th class="n">UCC at end</th><th></th></tr></thead><tbody>${rows.length?rows.map(r=>`<tr><td><b>${esc(r.k)}</b><div class="muted" style="font-size:12px">${esc(T(r.desc||''))}</div></td><td class="n">${r.rate}%</td><td class="n">${money(r.open)}</td><td class="n">${r.add?money(r.add):'<span class="muted">—</span>'}</td><td class="n">${r.dis?money(r.dis):'<span class="muted">—</span>'}</td><td class="n">${r.adj?mcell(r.adj):'<span class="muted">—</span>'}</td><td class="n"><b>${money(r.cca)}</b></td><td class="n">${money(r.close)}</td><td>${r.recapture?`<span class="pill overdue">${T('Recapture')} ${money(r.recapture)}</span>`:''}${r.terminal?`<span class="pill partial">${T('Terminal loss')} ${money(r.terminal)}</span>`:''}</td></tr>`).join(''):emptyRow(9,'No CCA classes yet','Give assets a CCA class, or enter the opening UCC from last year’s Schedule 8.')}</tbody>${rows.length?`<tfoot><tr class="grand"><td colspan="2">Total</td><td class="n">${money(t('open'))}</td><td class="n">${money(t('add'))}</td><td class="n">${money(t('dis'))}</td><td class="n">${mcell(t('adj'))}</td><td class="n">${money(t('cca'))}</td><td class="n">${money(t('close'))}</td><td></td></tr></tfoot>`:''}</table></div>
  <div class="muted" style="font-size:12.5px;padding:10px 12px">${T('A worksheet for T2 Schedule 8. The claim shown is the maximum; you can claim less. First-year rules change often (half-year rule, accelerated investment incentive, immediate expensing), so check each addition’s rule on the asset. Disposals use the lesser of proceeds and cost.')}</div></div>`;
}

function assetForm(a){
  const staff=ME&&ME.role!=='client'&&!ME.readOnly;
  const A=t=>sortAccts(S.accounts.filter(x=>x.type===t&&x.active!==false));
  const guess=(t,re)=>(A(t).find(x=>re.test(x.name))||{}).id||'';
  const d=a||{name:'',acquired:today(),cost:'',ccaClass:'8',ccaRate:20,firstYear:'half',method:'straight',life:5,rate:20,salvage:0,assetAccount:guess('Asset',/equipment|furniture|vehicle|computer|matériel|équipement|mobilier/i),accumAccount:guess('Asset',/accumulated|amortissement cumul/i),expenseAccount:guess('Expense',/amorti|depreci/i),opening:0,openingFy:'',notes:''};
  const f=openModal(a?a.name:'Add asset',`<div class="fields">
    ${fld('faName','Asset',`<input type="text" id="faName" maxlength="120" value="${esc(d.name)}" placeholder="${esc(T('e.g. Dell laptop, Ford Transit van'))}">`,true)}
    ${fld('faDate','Bought (available for use)',`<input type="date" id="faDate" value="${esc(d.acquired)}">`)}${fld('faCost','Cost (before GST/HST you can claim back)',`<input type="number" id="faCost" step="0.01" min="0" value="${esc(d.cost)}">`)}
    ${fld('faAsset','Asset account',`<select id="faAsset"><option value="">${T('Choose account…')}</option>${acctOptions(d.assetAccount,x=>x.type==='Asset'&&!['bank','card','ar'].includes(x.detail))}</select>`)}
    </div>
    <div class="subpanel"><div class="flabel">Tax: capital cost allowance</div><div class="fields">
    ${fld('faClass','CCA class',`<select id="faClass"><option value="">${T('No CCA (not depreciable for tax)')}</option>${Object.entries(CCA_CLASSES).map(([k,[r,t]])=>`<option value="${k}" ${d.ccaClass===k?'selected':''}>${k} · ${r}% · ${esc(T(t))}</option>`).join('')}${d.ccaClass&&!CCA_CLASSES[d.ccaClass]?`<option value="${esc(d.ccaClass)}" selected>${esc(d.ccaClass)}</option>`:''}</select>`)}
    ${fld('faCcaRate','Rate (%)',`<input type="number" id="faCcaRate" step="0.1" min="0" max="100" value="${esc(d.ccaRate)}">`)}
    ${fld('faFirst','First year',`<select id="faFirst">${Object.entries(FIRST_YEAR).map(([k,[l]])=>`<option value="${k}" ${d.firstYear===k?'selected':''}>${esc(T(l))}</option>`).join('')}</select>`,true)}
    </div></div>
    <div class="subpanel"><div class="flabel">Books: amortization</div><div class="fields">
    ${fld('faMethod','Method',`<select id="faMethod"><option value="straight" ${d.method==='straight'?'selected':''}>${T('Straight-line')}</option><option value="declining" ${d.method==='declining'?'selected':''}>${T('Declining balance')}</option><option value="none" ${d.method==='none'?'selected':''}>${T('Not amortized (land)')}</option></select>`)}
    ${fld('faLife','Useful life (years)',`<input type="number" id="faLife" step="0.5" min="0" value="${esc(d.life)}">`)}${fld('faRate','Rate (%)',`<input type="number" id="faRate" step="0.1" min="0" value="${esc(d.rate)}">`)}
    ${fld('faSalv','Value left at the end (optional)',`<input type="number" id="faSalv" step="0.01" min="0" value="${esc(d.salvage||'')}">`)}
    ${fld('faAccum','Accumulated amortization account',`<select id="faAccum"><option value="">${T('Choose account…')}</option><option value="__new" ${!d.accumAccount?'selected':''}>${T('+ New account: Accumulated amortization')}</option>${acctOptions(d.accumAccount,x=>x.type==='Asset'&&!['bank','card','ar'].includes(x.detail))}</select>`)}
    ${fld('faExp','Amortization expense account',`<select id="faExp"><option value="">${T('Choose account…')}</option><option value="__new" ${!d.expenseAccount?'selected':''}>${T('+ New account: Amortization expense')}</option>${acctOptions(d.expenseAccount,x=>x.type==='Expense')}</select>`)}
    ${fld('faOpen','Already amortized before Sumlora (optional)',`<input type="number" id="faOpen" step="0.01" min="0" value="${esc(d.opening||'')}">`)}
    ${fld('faOpenFy','…at the start of the fiscal year',`<input type="date" id="faOpenFy" value="${esc(d.openingFy||'')}"><span class="hint">${T('For assets bought before you started using Sumlora: what was amortized up to the start of your first year here.')}</span>`)}
    </div></div>
    ${a?`<div class="subpanel"><div class="flabel">Sold or disposed of</div><div class="fields">${fld('faDisp','Date',`<input type="date" id="faDisp" value="${esc(d.disposed||'')}">`)}${fld('faProc','Proceeds',`<input type="number" id="faProc" step="0.01" min="0" value="${esc(d.proceeds||'')}">`)}</div>
      ${a.disposalEntry&&S.entries.some(e=>e.id===a.disposalEntry)?`<div class="actions" style="justify-content:flex-start"><span class="pill paid">${T('Disposal recorded')}</span><button type="button" class="btn sm ghost" data-faundisp>Undo the disposal entry</button></div>`:a.disposed?'<div class="actions" style="justify-content:flex-start"><button type="button" class="btn sm" data-fadisp>Record the disposal in the books…</button></div>':''}</div>`:''}
    ${fld('faNotes','Notes (serial number, location…)',`<textarea id="faNotes" rows="2">${esc(d.notes||'')}</textarea>`,true)}`,
    staff?saveFoot(!!a):'<button type="button" class="btn" data-close>Close</button>','wide');
  const sync=()=>{const m=$('#faMethod',f).value;$('#faLife',f).closest('.field').hidden=m!=='straight';$('#faRate',f).closest('.field').hidden=m!=='declining';$$('#faAccum,#faExp,#faSalv,#faOpen,#faOpenFy',f).forEach(i=>i.closest('.field').hidden=m==='none')};
  $('#faMethod',f).onchange=sync;sync();
  $('#faClass',f).onchange=()=>{const c=CCA_CLASSES[$('#faClass',f).value];if(c)$('#faCcaRate',f).value=c[0]};
  const read=()=>({name:$('#faName',f).value.trim(),acquired:$('#faDate',f).value,cost:$('#faCost',f).value,assetAccount:$('#faAsset',f).value,ccaClass:$('#faClass',f).value,ccaRate:$('#faCcaRate',f).value,firstYear:$('#faFirst',f).value,
    method:$('#faMethod',f).value,life:$('#faLife',f).value,rate:$('#faRate',f).value,salvage:$('#faSalv',f).value,accumAccount:$('#faAccum',f).value,expenseAccount:$('#faExp',f).value,opening:$('#faOpen',f).value,openingFy:$('#faOpenFy',f).value,
    disposed:a?$('#faDisp',f).value:'',proceeds:a?$('#faProc',f).value:0,notes:$('#faNotes',f).value.trim()});
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this asset?','It’s taken off the register and out of the CCA schedule. Amortization already recorded has to be undone first.','Delete'))return;if(await del('assets',a.id)){closeModal();toast('Asset deleted')}};
  const dp=$('[data-fadisp]',f);if(dp)dp.onclick=async()=>{const x={...strip(a),...read()};closeModal();disposalForm({...x,id:a.id})};
  const ud=$('[data-faundisp]',f);if(ud)ud.onclick=async()=>{if(!await confirmBox('Undo the disposal entry?','The journal entry is deleted. The asset keeps its disposal date and proceeds.','Undo'))return;if(await batch([{op:'set',collection:'assets',id:a.id,data:{...strip(a),disposalEntry:''}},{op:'delete',collection:'entries',id:a.disposalEntry}])){closeModal();toast('Disposal entry undone')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');if(!staff)return;
    const x=read();if(!x.name)return f.err('Give the asset a name.');if(!(+x.cost>0))return f.err('Enter what it cost.');if(!x.assetAccount)return f.err('Choose the asset account.');
    if(x.method!=='none'&&(!x.accumAccount||!x.expenseAccount))return f.err('Choose the accumulated amortization and expense accounts.');
    if(x.openingFy&&x.openingFy!==fyStartOf(x.openingFy))x.openingFy=fyStartOf(x.openingFy);
    // The accounts this needs, made the first time.
    const w=[],fr=S.company.lang==='fr';
    if(x.method!=='none'&&x.accumAccount==='__new'){const id=uid();w.push({op:'set',collection:'accounts',id,data:{code:'',name:fr?'Amortissement cumulé':'Accumulated amortization',type:'Asset',detail:'',desc:'',active:true}});x.accumAccount=id}
    if(x.method!=='none'&&x.expenseAccount==='__new'){const id=uid();w.push({op:'set',collection:'accounts',id,data:{code:'',name:fr?'Amortissement':'Amortization expense',type:'Expense',detail:'',desc:'',active:true}});x.expenseAccount=id}
    if(x.method==='none'){if(x.accumAccount==='__new')x.accumAccount='';if(x.expenseAccount==='__new')x.expenseAccount=''}
    if(await batch([...w,{op:'set',collection:'assets',id:a?a.id:uid(),data:{...(a?strip(a):{}),...x,posted:a?.posted||{},created:a?.created||Date.now()}}])){closeModal();toast(a?'Asset saved':`${x.name} added`)}};
}
/** The disposal in the books: the proceeds in, the cost and accumulated amortization out, the difference a gain or loss. */
function disposalForm(a){
  const acc=bookedAccum(a),nbv=r2(a.cost-acc),gain=r2((+a.proceeds||0)-nbv);
  const gl=(sortAccts(S.accounts.filter(x=>(x.type==='Income'||x.type==='Expense')&&/gain|loss|disposal|cession|perte/i.test(x.name)))[0]||{}).id||'';
  const f=openModal('Record the disposal',`<div class="muted"><b translate="no">${esc(a.name)}</b> · ${fmtDate(a.disposed)}</div>
    <div class="totals" style="margin:8px 0"><div>${T('Cost')}</div><div>${money(a.cost)}</div><div>${T('Accumulated amortization in the books')}</div><div>${money(acc)}</div><div>${T('Book value')}</div><div>${money(nbv)}</div><div>${T('Proceeds')}</div><div>${money(+a.proceeds||0)}</div><div class="big">${gain>=0?T('Gain'):T('Loss')}</div><div class="big ${gain<0?'neg':''}">${money(Math.abs(gain))}</div></div>
    <div class="fields">${+a.proceeds?fld('dsBank','Proceeds went into',`<select id="dsBank">${acctOptions((sortAccts(S.accounts.filter(x=>x.detail==='bank'))[0]||{}).id,x=>x.detail==='bank'||x.detail==='card'||x.type==='Asset')}</select>`):''}
    ${gain?fld('dsGl',gain>0?'Gain goes to':'Loss goes to',`<select id="dsGl"><option value="">${T('Choose account…')}</option>${acctOptions(gl,x=>x.type==='Income'||x.type==='Expense')}</select>`):''}</div>
    <div class="muted" style="font-size:13px">${T('Uses the amortization recorded so far. Record this year’s amortization first if you want it in the books before the sale.')}</div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Record disposal</button>`);
  f.onsubmit=async e=>{e.preventDefault();f.err('');const bank=$('#dsBank',f),g=$('#dsGl',f);
    if(g&&!g.value)return f.err('Choose the gain or loss account.');
    const lines=[];if(+a.proceeds)lines.push({account:bank.value,debit:r2(+a.proceeds),credit:0});
    if(acc)lines.push({account:a.accumAccount,debit:acc,credit:0});
    lines.push({account:a.assetAccount,debit:0,credit:r2(+a.cost)});
    if(gain>0)lines.push({account:g.value,debit:0,credit:gain});else if(gain<0)lines.push({account:g.value,debit:-gain,credit:0});
    const id=uid();
    if(await batch([{op:'set',collection:'entries',id,data:{type:'journal',date:a.disposed,ref:'',memo:`${S.company.lang==='fr'?'Disposition':'Disposal'}: ${a.name}`,lines,created:Date.now()}},{op:'set',collection:'assets',id:a.id,data:{...strip(a),disposalEntry:id}}])){closeModal();toast('Disposal recorded')}};
}
async function postAmortization(fy){
  const key=fyKey(fy),todo=amortRows(fy).filter(x=>!(x.a.posted||{})[key]&&x.s.amount>0);if(!todo.length)return;
  const g={};for(const{a,s}of todo){g['d|'+a.expenseAccount]=r2((g['d|'+a.expenseAccount]||0)+s.amount);g['c|'+a.accumAccount]=r2((g['c|'+a.accumAccount]||0)+s.amount)}
  const lines=Object.entries(g).map(([k,v])=>{const[side,acc]=k.split('|');return side==='d'?{account:acc,debit:v,credit:0}:{account:acc,debit:0,credit:v}});
  const total=r2(todo.reduce((s,x)=>s+x.s.amount,0));
  if(!await confirmBox('Record amortization?',`${money(total)} for ${todo.length} asset${todo.length===1?'':'s'}, as one journal entry on ${fmtDate(fyEndOf(fy))}.`,'Record'))return;
  const id=uid(),fr=S.company.lang==='fr';
  if(await batch([{op:'set',collection:'entries',id,data:{type:'journal',date:fyEndOf(fy),ref:'',memo:fr?`Amortissement de l’exercice ${fmtDate(fy)} – ${fmtDate(fyEndOf(fy))}`:`Amortization for the fiscal year ${fmtDate(fy)} – ${fmtDate(fyEndOf(fy))}`,adjusting:true,lines,created:Date.now()}},
    ...todo.map(({a})=>({op:'set',collection:'assets',id:a.id,data:{...strip(a),posted:{...(a.posted||{}),[key]:id}}}))]))toast('Amortization recorded');
}
async function undoAmortization(entryId){
  const as=S.assets.filter(a=>Object.values(a.posted||{}).includes(entryId));
  if(!await confirmBox('Undo this amortization?','The journal entry is deleted and the year shows as not recorded.','Undo'))return;
  if(await batch([...as.map(a=>({op:'set',collection:'assets',id:a.id,data:{...strip(a),posted:Object.fromEntries(Object.entries(a.posted||{}).filter(([,v])=>v!==entryId))}})),{op:'delete',collection:'entries',id:entryId}]))toast('Amortization undone');
}
function openingUccForm(){
  const op=S.company.ccaOpening||{},classes=[...new Set(Object.keys(op).concat(S.assets.map(a=>a.ccaClass).filter(Boolean)))].sort((a,b)=>parseFloat(a)-parseFloat(b));
  const fy0=Object.values(op)[0]?.fy||fyStartOf(today());
  const row=(k,v)=>`<tr><td><input type="text" data-ouk value="${esc(k)}" placeholder="8" style="width:70px" aria-label="Class"></td><td><input type="number" data-ouv step="0.01" min="0" value="${esc(v??'')}" aria-label="UCC"></td></tr>`;
  const f=openModal('Opening UCC',`<div class="muted" style="font-size:13px">${T('From the last Schedule 8 filed: the UCC at the end of that year, for each class. Assets bought before this date are already in it.')}</div>
    <div class="fields">${fld('ouFy','UCC at the start of the fiscal year',`<input type="date" id="ouFy" value="${esc(fy0)}">`)}</div>
    <div class="tbl-wrap"><table><thead><tr><th>${T('Class')}</th><th>UCC</th></tr></thead><tbody data-ourows>${(classes.length?classes:['8']).map(k=>row(k,op[k]?.ucc)).join('')}</tbody></table></div><button type="button" class="btn ghost sm" data-ouadd>+ ${T('Add class')}</button>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`);
  $('[data-ouadd]',f).onclick=()=>$('[data-ourows]',f).insertAdjacentHTML('beforeend',row('',''));
  f.onsubmit=async e=>{e.preventDefault();const fy=fyStartOf($('#ouFy',f).value||today()),o={};
    $$('[data-ourows] tr',f).forEach(tr=>{const k=$('[data-ouk]',tr).value.trim(),v=$('[data-ouv]',tr).value;if(k&&v!=='')o[k]={fy,ucc:+v||0}});
    if(await putCompany({...strip(S.company),ccaOpening:o})){closeModal();toast('Opening UCC saved')}};
}
function ccaCsv(fy){
  const rows=ccaSchedule(fy),csv=[['Class','Rate %','UCC at start','Additions','Disposals','First-year adjustment','CCA','UCC at end','Recapture','Terminal loss']];
  rows.forEach(r=>csv.push([r.k,r.rate,r.open,r.add,r.dis,r.adj,r.cca,r.close,r.recapture,r.terminal]));
  const text=csv.map(r=>r.map(v=>/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:v).join(',')).join('\n');
  saveFile(`cca-schedule_${fy}.csv`,new Blob([text],{type:'text/csv'}));
}
async function assetsClick(e,t,d){
  if(S.view!=='assets')return false;
  if(d.fatab){S.fa.tab=d.fatab;renderMain();return true}
  if(d.asset!==undefined){assetForm(d.asset?S.assets.find(a=>a.id===d.asset):null);return true}
  if(d.faact==='post'){await postAmortization(S.fa.fy);return true}
  if(d.faact==='opening'){openingUccForm();return true}
  if(d.faact==='ccacsv'){ccaCsv(S.fa.fy);return true}
  if(d.faundo){await undoAmortization(d.faundo);return true}
  return false;
}
function bindAssets(m){if(S.view!=='assets')return;const y=$('#faYear',m);if(y)y.onchange=()=>{S.fa.fy=y.value;renderMain()}}
