'use strict';
/* ---------- Scrap yard (add-on) ----------
   For scrap yards and auto recyclers. It's an add-on (plans.js ADDONS.scrapyard): on when a company is set up as a
   scrap yard, or when an owner adds it in Settings.
   - Vehicles are bought by VIN, from a business (a vendor) or a member of the public. A purchase from the public keeps
     the seller's name, address and ID, and prints a purchase voucher (bill of sale) for them to sign.
   - The purchase is posted as an expense: the price into "Vehicles in yard" (inventory), any GST/HST the seller
     charged to the tax account, paid from the bank, cash or card. When the car is finished (crushed, or sold whole),
     its cost moves to cost of goods sold.
   - Invoices, sales receipts, bills, expenses and journal entries can point at a vehicle (veh), like a project, so each
     car shows what it earned (parts and scrap) and what it cost (price, towing, disposal): profit per vehicle.
   - Parts pulled from a car are listed on it with a bin and an asking price; selling one makes a sales receipt.
   - An environmental checklist per car (fluids, battery, refrigerant, mercury switches, tires, airbags), and a log of
     everything bought from the public, for the municipality, the police or an inspector. */

const yardOn=()=>!!(S.addons&&S.addons.scrapyard);
const vehById=id=>S.vehicles.find(v=>v.id===id);
const vehDesc=v=>[v.year,v.make,v.model].filter(Boolean).join(' ');
const vehLabel=v=>v?[`#${v.stock}`,vehDesc(v)].filter(Boolean).join(' · '):'';
const VEH_STATUS={yard:'In the yard',parting:'Being parted out',done:'Finished (crushed or scrapped)',sold:'Sold whole'};
const VEH_PILL={yard:'open',parting:'partial',done:'quiet',sold:'paid'};
const ID_TYPES=['Driver’s licence','Ontario Photo Card','Passport','Other government photo ID'];
const PAY_METHODS={cash:'Cash',cheque:'Cheque',etransfer:'e-Transfer',card:'Debit or credit card',other:'Other'};
const ENV_LIST=[['fluids','Fluids drained (fuel, oil, coolant, washer fluid)'],['battery','Battery removed'],['refrigerant','A/C refrigerant recovered'],['mercury','Mercury switches removed'],['tires','Tires removed'],['airbags','Airbags removed or deployed']];
const yardStaff=()=>ME&&ME.role!=='client'&&!ME.readOnly;
const yardOpen=v=>v.status==='yard'||v.status==='parting';
const byStock=(a,b)=>String(a.stock).localeCompare(String(b.stock),undefined,{numeric:true});

/** The Vehicle picker on invoices, bills, expenses and journal entries. */
function vehField(id,val){
  if(!yardOn())return '';
  const vs=S.vehicles.filter(v=>yardOpen(v)||v.id===val).sort(byStock);
  if(!vs.length)return '';
  return fld(id,'Vehicle',`<select id="${id}"><option value="">${T('No vehicle')}</option>${vs.map(v=>`<option value="${esc(v.id)}" ${v.id===val?'selected':''}>${esc(vehLabel(v))}${v.vin?` · ${esc(v.vin.slice(-6))}`:''}</option>`).join('')}</select>`);
}
const vehOf=(f,id)=>{const s=$('#'+id,f);return s&&s.value?{veh:s.value}:{}};

/* ---------- VIN check digit (North American VINs) ---------- */
function vinCheck(vin){
  if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))return null;
  const val=c=>/\d/.test(c)?+c:'ABCDEFGH'.includes(c)?'ABCDEFGH'.indexOf(c)+1:'JKLMN'.includes(c)?'JKLMN'.indexOf(c)+1:c==='P'?7:c==='R'?9:'STUVWXYZ'.indexOf(c)+2;
  const W=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  const r=[...vin].reduce((s,c,i)=>s+val(c)*W[i],0)%11;
  return (r===10?'X':String(r))===vin[8];
}
function vinNote(vin,selfId){
  vin=String(vin||'').toUpperCase().replace(/[\s-]/g,'');
  if(!vin)return '';
  const dup=S.vehicles.find(v=>v.id!==selfId&&v.vin===vin);
  if(dup)return `<span class="neg">${T('This VIN is already on vehicle')} ${esc(vehLabel(dup))}${dup.bought?`, ${T('bought')} ${fmtDate(dup.bought)}`:''}. ${T('Check it before you pay.')}</span>`;
  if(/[IOQ]/.test(vin)&&vin.length===17)return `<span class="neg">${T('VINs never use the letters I, O or Q. Check for a 1, 0 or 9.')}</span>`;
  if(vin.length!==17)return T('Vehicles made since 1981 have a 17-character VIN.');
  const ok=vinCheck(vin);
  return ok===false?`<span class="neg">${T('The check digit (9th character) doesn’t match. Read the VIN again; some imported vehicles don’t use one.')}</span>`:ok?`<span class="pos">✓ ${T('VIN looks right')}</span>`:'';
}

/* ---------- money for each vehicle ---------- */
/** What a vehicle earned and cost: its price, plus income and costs on transactions that point at it. */
function vehNumbers(v){
  let income=0,costs=0;const txns=[];
  for(const e of S.entries){
    if(e.veh!==v.id||e.id===v.buyEntry||e.id===v.doneEntry)continue;
    let i=0,c=0;
    for(const l of e.lines||[]){const a=acct(l.account);if(!a)continue;if(a.type==='Income')i+=(+l.credit||0)-(+l.debit||0);else if(a.type==='Expense'||a.type==='Cost of Goods Sold')c+=(+l.debit||0)-(+l.credit||0)}
    income+=i;costs+=c;txns.push({e,i:r2(i),c:r2(c)});
  }
  income=r2(income);costs=r2(costs);
  const price=r2(+v.price||0);
  return{price,income,costs,profit:r2(income-price-costs),txns};
}
/** Still in the yard's inventory account: bought into an asset account and not finished. */
const vehInInventory=v=>yardOpen(v)&&acct(v.invAccount)?.type==='Asset';

/* ---------- accounts and set-up ---------- */
const yardAcct=(code,re)=>(S.accounts.find(a=>a.code===code&&a.active!==false)||S.accounts.find(a=>re.test(a.name)&&a.active!==false)||{}).id||'';
const yardInvAcct=()=>yardAcct('1410',/vehicles in yard|véhicules dans la cour/i);
const yardCogsAcct=()=>yardAcct('5000',/cost of vehicles|coût des véhicules|cost of goods sold|coût des marchandises/i);
const yardPartsIncome=()=>yardAcct('4010',/used parts|pièces usagées/i)||(sortAccts(S.accounts.filter(a=>a.type==='Income'&&a.active!==false))[0]||{}).id||'';
const yardCashAccts=a=>(a.detail==='bank'||a.detail==='card'||(a.type==='Asset'&&!a.detail&&/cash|caisse|petty|petite/i.test(a.name)))&&a.active!==false;
/** What's missing for a scrap yard: its accounts, its materials sold by weight, and the weigh ticket field. */
function yardMissing(){
  const IND=TallyIndustries.INDUSTRIES.scrapyard,fr=S.company.lang==='fr';
  const nm=a=>(fr?a[4]||a[1]:a[1]).toLowerCase();
  const accounts=TallyIndustries.accountsFor('scrapyard').filter(a=>!S.accounts.some(x=>x.name.toLowerCase()===nm(a))&&!(a[0]==='1410'&&yardInvAcct()));
  const items=(IND.items||[]).filter(([n,,,f])=>!S.items.some(i=>i.name.toLowerCase()===(fr?f||n:n).toLowerCase()));
  const fields=(IND.fields||[]).filter(x=>!(S.company.customFields||[]).some(c=>[x.label,x.fr].map(s=>s.toLowerCase()).includes(c.label.toLowerCase())));
  return{accounts,items,fields};
}
async function yardSetup(){
  const m=yardMissing(),fr=S.company.lang==='fr';
  if(!m.accounts.length&&!m.items.length&&!m.fields.length){toast('Everything a scrap yard needs is already set up');return}
  const used=new Set(S.accounts.map(a=>a.code)),codeIds={};
  const writes=m.accounts.map(([code,name,type,detail,frName])=>{let c=+code;while(used.has(String(c))&&c<+code+99)c++;const k=used.has(String(c))?'':String(c);if(k)used.add(k);const id=!k||acct('a'+k)?uid():'a'+k;codeIds[code]=id;return{op:'set',collection:'accounts',id,data:{code:k,name:fr?frName||name:name,type,detail,desc:'',active:true}}});
  const byCode=code=>codeIds[code]||(S.accounts.find(a=>a.code===code)||{}).id||'';
  m.items.forEach(([name,inc,exp,frName])=>{const income=byCode(inc),expense=exp?byCode(exp):'';if(income)writes.push({op:'set',collection:'items',id:uid(),data:{name:fr?frName||name:name,type:'service',sold:true,incomeAccount:income,bought:!!expense,expenseAccount:expense,taxCode:'std',active:true}})});
  const lines=[m.accounts.length?`${m.accounts.length} ${T('accounts, such as')} ${m.accounts.slice(0,3).map(a=>fr?a[4]||a[1]:a[1]).join(', ')}`:'',m.items.length?`${m.items.length} ${T('products sold by weight or by the piece')}`:'',m.fields.length?T('a “Weigh ticket no.” field on invoices and sales receipts'):''].filter(Boolean);
  if(!await confirmBox('Set up the scrap yard?',`${T('This adds')} ${lines.join('; ')}. ${T('Nothing you already have is changed.')}`,'Set it up'))return;
  if(writes.length&&!await batch(writes))return;
  if(m.fields.length){const cf=[...(S.company.customFields||[])];for(const x of m.fields)if(cf.length<3)cf.push({label:fr?x.fr||x.label:x.label,sales:x.sales,purchase:x.purchase});
    const data={...strip(S.company),customFields:cf};if(!S.company.industry)data.industry='scrapyard';if(!await putCompany(data))return}
  else if(!S.company.industry)await putCompany({...strip(S.company),industry:'scrapyard'});
  toast('Scrap yard set up');
}

/* ---------- the Scrap yard page ---------- */
function vYard(){
  if(!yardOn())return head('Scrap yard','')+`<div class="panel"><div class="empty"><b>${T('The Scrap yard add-on isn’t on')}</b>${T('An owner can add it to this company in Settings. It’s for scrap yards and auto recyclers: vehicles bought by VIN, purchase vouchers, parts and profit per vehicle.')}</div></div>`;
  if(S.param&&vehById(S.param))return vVehicle(vehById(S.param));
  const Y=S.yard||(S.yard={tab:'vehicles',show:'open',q:'',from:fyStartOf(today()),to:fyEndOf(today())});
  const staff=yardStaff(),miss=yardMissing();
  const h=head('Scrap yard','Vehicles bought, parts pulled and profit per vehicle',staff?`<button class="btn" data-yard="cost">Record a cost</button><button class="btn" data-yard="sell">Sell scrap or parts</button><button class="btn primary" data-veh="">+ Buy a vehicle</button>`:'')+
    (staff&&!yardInvAcct()?`<div class="banner"><span>${T('These books don’t have the scrap yard accounts yet (Vehicles in yard, Used parts sales, Cost of vehicles processed…).')}</span><button class="btn sm primary" data-yard="setup">Set up the scrap yard</button></div>`:staff&&(miss.items.length||miss.fields.length)&&!S.yardHint?`<div class="banner"><span>${T('Add the materials a yard sells by weight (steel by the tonne, copper by the pound…) and a weigh ticket field on invoices?')}</span><button class="btn sm" data-yard="setup">Add them</button><button class="btn sm ghost" data-yard="hint">Not now</button></div>`:'')+
    `<div class="tabs" role="tablist">${[['vehicles','Vehicles'],['parts','Parts in stock'],['public','Bought from the public']].map(([k,v])=>`<button role="tab" data-ytab="${k}" aria-selected="${Y.tab===k}">${v}</button>`).join('')}</div>`;
  if(Y.tab==='parts')return h+vYardParts(staff);
  if(Y.tab==='public')return h+vYardPublic(Y);
  return h+vYardVehicles(Y);
}
function vYardVehicles(Y){
  const q=Y.q.trim().toLowerCase();
  const all=S.vehicles.map(v=>({v,n:vehNumbers(v)}));
  const list=all.filter(({v})=>(Y.show==='all'||(Y.show==='open'?yardOpen(v):!yardOpen(v)))&&(!q||[v.stock,v.vin,v.make,v.model,v.year,v.plate,v.seller&&v.seller.name,contactName(v.contactId)].some(x=>String(x||'').toLowerCase().includes(q))))
    .sort((a,b)=>b.v.bought.localeCompare(a.v.bought)||byStock(b.v,a.v));
  const inYard=all.filter(x=>yardOpen(x.v)),inv=r2(all.filter(x=>vehInInventory(x.v)).reduce((s,x)=>s+x.n.price,0));
  const fy=fyStartOf(today()),fin=all.filter(x=>!yardOpen(x.v)&&x.v.doneDate>=fy);
  const ia=yardInvAcct(),book=ia?bal(ia):null,diff=book===null?0:r2(book-inv);
  const shown=shownCount('veh',list.length);
  const tot=k=>r2(list.reduce((s,x)=>s+x.n[k],0));
  return `<div class="chips"><div class="chip"><div class="lbl">In the yard</div><div class="val">${inYard.length}</div><div class="lbl">${money(inv)} <span>${T('at cost')}</span></div></div>
    <div class="chip"><div class="lbl">Finished this fiscal year</div><div class="val">${fin.length}</div><div class="lbl">${money(r2(fin.reduce((s,x)=>s+x.n.profit,0)))} <span>${T('profit')}</span></div></div>
    <div class="chip"><div class="lbl">Parts in stock</div><div class="val">${S.vehicles.reduce((s,v)=>s+(v.parts||[]).filter(p=>p.status==='stock').length,0)}</div></div>
    ${book!==null?`<div class="chip"><div class="lbl">${esc(acctName(ia))}</div><div class="val">${money(book)}</div>${Math.abs(diff)>0.004?`<div class="lbl neg">${T('Differs from the vehicles in the yard by')} ${money(diff)}</div>`:`<div class="lbl">${T('Matches the vehicles in the yard')}</div>`}</div>`:''}</div>
  <div class="panel"><div class="toolbar"><input type="search" id="yardQ" placeholder="${esc(T('Stock no., VIN, make, model, seller…'))}" value="${esc(Y.q)}" aria-label="Search vehicles"><label class="flabel" for="yardShow">Show</label><select id="yardShow">${[['open','In the yard'],['done','Finished or sold'],['all','All']].map(([k,v])=>`<option value="${k}" ${Y.show===k?'selected':''}>${v}</option>`).join('')}</select><span class="grow"></span><button class="btn sm" data-yard="vcsv">Export CSV</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Stock no.</th><th>Vehicle</th><th>VIN</th><th>Bought</th><th>From</th><th class="n">Paid</th><th class="n">Income</th><th class="n">Other costs</th><th class="n">Profit</th><th>Status</th></tr></thead><tbody>
  ${list.length?list.slice(0,shown).map(({v,n})=>`<tr class="click" data-vehopen="${esc(v.id)}"><td class="mono"><b>${esc(v.stock)}</b></td><td translate="no">${esc(vehDesc(v)||'—')}${v.colour?` <span class="muted">${esc(v.colour)}</span>`:''}</td><td class="mono" style="font-size:12.5px">${esc(v.vin||'—')}</td><td style="white-space:nowrap">${fmtDate(v.bought)}</td><td class="trunc" translate="no">${esc(v.sellerKind==='business'?contactName(v.contactId):(v.seller||{}).name||'')}</td><td class="n">${money(n.price)}</td><td class="n">${n.income?money(n.income):'<span class="muted">—</span>'}</td><td class="n">${n.costs?money(n.costs):'<span class="muted">—</span>'}</td><td class="n ${n.profit<0?'neg':''}">${money(n.profit)}</td><td><span class="pill ${VEH_PILL[v.status]}">${esc(T(VEH_STATUS[v.status]))}</span></td></tr>`).join('')+moreRow('veh',shown,list.length,10)
    :emptyRow(10,S.vehicles.length?'Nothing matches':'No vehicles yet',S.vehicles.length?'Try another search or filter.':'Click “Buy a vehicle” when a car comes into the yard: its VIN, who sold it, what was paid. Then point invoices, bills and expenses at it to see its profit.')}</tbody>
  ${list.length?`<tfoot><tr class="grand"><td colspan="5">Total</td><td class="n">${money(tot('price'))}</td><td class="n">${money(tot('income'))}</td><td class="n">${money(tot('costs'))}</td><td class="n ${tot('profit')<0?'neg':''}">${money(tot('profit'))}</td><td></td></tr></tfoot>`:''}</table></div>
  <div class="muted" style="font-size:12.5px;padding:10px 12px">${T('Profit per vehicle: income on transactions that point at the vehicle (parts, scrap, a whole-car sale), less what was paid for it and the costs that point at it (towing, disposal…).')}</div></div>`;
}
function vYardParts(staff){
  const rows=[];for(const v of S.vehicles)for(const p of v.parts||[])if(p.status==='stock')rows.push({v,p});
  rows.sort((a,b)=>a.p.name.localeCompare(b.p.name));
  const total=r2(rows.reduce((s,x)=>s+(+x.p.price||0),0));
  return `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Part</th><th>Bin or location</th><th>From vehicle</th><th class="n">Asking price</th><th></th></tr></thead><tbody>
    ${rows.length?rows.map(({v,p})=>`<tr><td><b translate="no">${esc(p.name)}</b></td><td>${esc(p.location||'—')}</td><td><button type="button" class="btn ghost sm" data-vehopen="${esc(v.id)}" translate="no">${esc(vehLabel(v))}</button></td><td class="n">${p.price?money(p.price):'<span class="muted">—</span>'}</td><td style="text-align:right;white-space:nowrap">${staff?`<button class="btn sm" data-partsell="${esc(v.id)}|${esc(p.id)}">Sell</button>`:''}</td></tr>`).join('')
      :emptyRow(5,'No parts in stock','Open a vehicle and add the parts pulled from it, with the bin they’re in and an asking price.')}</tbody>
    ${rows.length?`<tfoot><tr class="grand"><td colspan="3">${rows.length} ${T(rows.length===1?'part':'parts')}</td><td class="n">${money(total)}</td><td></td></tr></tfoot>`:''}</table></div>
    <div class="muted" style="font-size:12.5px;padding:10px 12px">${T('Asking prices aren’t in the books: a part’s cost is part of what was paid for its vehicle.')}</div></div>`;
}
function vYardPublic(Y){
  const list=S.vehicles.filter(v=>v.sellerKind!=='business'&&v.bought>=Y.from&&v.bought<=Y.to).sort((a,b)=>a.bought.localeCompare(b.bought)||byStock(a,b));
  return `<div class="panel"><div class="toolbar"><label class="flabel" for="ypFrom">From</label><input type="date" id="ypFrom" value="${esc(Y.from)}"><label class="flabel" for="ypTo">To</label><input type="date" id="ypTo" value="${esc(Y.to)}"><span class="grow"></span><button class="btn sm" data-yard="pcsv">Export CSV</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Stock no.</th><th>Vehicle</th><th>VIN</th><th>Seller</th><th>Address</th><th>ID</th><th class="n">Paid</th><th>How</th></tr></thead><tbody>
  ${list.length?list.map(v=>{const s=v.seller||{};return `<tr class="click" data-vehopen="${esc(v.id)}"><td style="white-space:nowrap">${fmtDate(v.bought)}</td><td class="mono">${esc(v.stock)}</td><td translate="no">${esc(vehDesc(v)||'—')}</td><td class="mono" style="font-size:12.5px">${esc(v.vin||'—')}</td><td translate="no">${esc(s.name||'')}${s.phone?`<div class="muted" style="font-size:12px">${esc(s.phone)}</div>`:''}</td><td class="trunc" translate="no">${esc(s.address||'')}</td><td translate="no">${s.idNumber?`${esc(T(s.idType||'ID'))}<div class="mono muted" style="font-size:12px">${esc(s.idNumber)}</div>`:'<span class="neg">'+T('No ID recorded')+'</span>'}</td><td class="n">${money(r2((+v.price||0)+(+v.tax||0)))}</td><td>${esc(T(PAY_METHODS[v.payMethod]||''))}</td></tr>`}).join('')
    :emptyRow(9,'Nothing bought from the public in these dates','Vehicles bought from a member of the public show here, with the seller’s ID, for the yard’s records.')}</tbody></table></div>
  <div class="muted" style="font-size:12.5px;padding:10px 12px">${T('Many municipalities require scrap and salvage dealers to keep a record of each seller’s name, address and photo ID with what was bought, and to show it on request. Check your licence’s by-law for what it asks for and how long to keep it.')}</div></div>`;
}

/* ---------- one vehicle ---------- */
function vVehicle(v){
  const n=vehNumbers(v),staff=yardStaff(),s=v.seller||{},env=v.env||{};
  const envDone=ENV_LIST.filter(([k])=>env[k]).length;
  const parts=(v.parts||[]).slice().sort((a,b)=>(a.status==='stock'?0:1)-(b.status==='stock'?0:1)||a.name.localeCompare(b.name));
  const buy=S.entries.find(e=>e.id===v.buyEntry),done=S.entries.find(e=>e.id===v.doneEntry);
  return `<button class="btn ghost sm" data-yardback style="margin-bottom:8px">← Scrap yard</button>`+
  head('⁠'+(vehDesc(v)||T('Vehicle'))+` · #${v.stock}`,`${v.vin?`<span class="mono">VIN ${esc(v.vin)}</span> · `:''}${T('Bought')} ${fmtDate(v.bought)} · <span class="pill ${VEH_PILL[v.status]}">${esc(T(VEH_STATUS[v.status]))}</span>${v.doneDate?` ${fmtDate(v.doneDate)}`:''}`,
    `${v.sellerKind!=='business'?'<button class="btn" data-yard="voucher">Print purchase voucher</button>':''}${staff?`<button class="btn" data-veh="${esc(v.id)}">Edit vehicle</button>${yardOpen(v)?`<button class="btn" data-vehfinish="${esc(v.id)}">Mark finished…</button>`:''}<button class="btn" data-yardcost="${esc(v.id)}">Record a cost</button><button class="btn primary" data-yardsell="${esc(v.id)}">Sell scrap or parts</button>`:''}`)+
  `<div class="chips"><div class="chip"><div class="lbl">Paid for it</div><div class="val">${money(n.price)}</div>${v.tax?`<div class="lbl">+ ${money(v.tax)} <span>GST/HST</span></div>`:''}</div><div class="chip"><div class="lbl">Other costs</div><div class="val">${money(n.costs)}</div></div><div class="chip"><div class="lbl">Income</div><div class="val">${money(n.income)}</div></div><div class="chip"><div class="lbl">Profit</div><div class="val ${n.profit<0?'neg':''}">${money(n.profit)}</div></div></div>
  <div class="ov-grid"><div class="panel"><h3>Parts pulled</h3><div class="tbl-wrap"><table><thead><tr><th>Part</th><th>Bin</th><th class="n">Asking</th><th>Status</th><th></th></tr></thead><tbody>
    ${parts.length?parts.map(p=>{const d=p.docId&&S.docs.find(x=>x.id===p.docId);return `<tr><td>${staff?`<button type="button" class="btn ghost sm" data-part="${esc(v.id)}|${esc(p.id)}" style="padding-left:0"><b translate="no">${esc(p.name)}</b></button>`:`<b translate="no">${esc(p.name)}</b>`}</td><td>${esc(p.location||'—')}</td><td class="n">${p.price?money(p.price):'<span class="muted">—</span>'}</td><td>${p.status==='sold'?`<span class="pill paid">${T('Sold')}</span>${d?` <button type="button" class="btn ghost sm" data-docopen="${esc(d.id)}">#${esc(d.number||'')}</button>`:''}`:p.status==='scrapped'?`<span class="pill quiet">${T('Scrapped')}</span>`:`<span class="pill open">${T('In stock')}</span>`}</td><td style="text-align:right">${staff&&p.status==='stock'?`<button class="btn sm" data-partsell="${esc(v.id)}|${esc(p.id)}">Sell</button>`:''}</td></tr>`}).join('')
      :emptyRow(5,'No parts yet','Add the parts pulled from this vehicle, with the bin they’re kept in and an asking price.')}</tbody></table></div>
    ${staff?`<div class="pad"><button class="btn sm" data-part="${esc(v.id)}|">+ Add part</button></div>`:''}</div>
  <div class="panel"><h3>Transactions</h3><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Name</th><th class="n">Income</th><th class="n">Cost</th></tr></thead><tbody>
    ${buy?`<tr class="click" data-entry="${esc(buy.id)}"><td style="white-space:nowrap">${fmtDate(buy.date)}</td><td>${T('Purchase')}${buy.ref?` <span class="mono muted">#${esc(buy.ref)}</span>`:''}</td><td class="trunc" translate="no">${esc(v.sellerKind==='business'?contactName(v.contactId):s.name||'')}</td><td class="n"></td><td class="n">${money(n.price)}</td></tr>`:''}
    ${n.txns.sort((a,b)=>b.e.date.localeCompare(a.e.date)).map(x=>`<tr class="click" data-entry="${esc(x.e.id)}"><td style="white-space:nowrap">${fmtDate(x.e.date)}</td><td>${esc(T(TLABEL[x.e.type]||x.e.type))}${x.e.ref?` <span class="mono muted">#${esc(x.e.ref)}</span>`:''}</td><td class="trunc" translate="no">${esc(contactName(x.e.contactId)||x.e.memo||'')}</td><td class="n">${x.i?money(x.i):''}</td><td class="n">${x.c?money(x.c):''}</td></tr>`).join('')}
    ${done?`<tr class="click" data-entry="${esc(done.id)}"><td style="white-space:nowrap">${fmtDate(done.date)}</td><td>${T('Cost moved to cost of goods sold')}</td><td></td><td class="n"></td><td class="n muted">${money(n.price)}</td></tr>`:''}
    ${!buy&&!n.txns.length?emptyRow(5,'Nothing yet','Pick this vehicle on invoices, sales receipts, bills and expenses.'):''}</tbody></table></div></div></div>
  <div class="ov-grid" style="margin-top:16px"><div class="panel"><h3>${v.sellerKind==='business'?T('Bought from'):T('Seller')}</h3><div class="pad" style="display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:14px">
    ${v.sellerKind==='business'?`<span class="muted">${T('Vendor')}</span><span translate="no">${esc(contactName(v.contactId))}</span>`:`<span class="muted">${T('Name')}</span><span translate="no">${esc(s.name||'')}</span><span class="muted">${T('Address')}</span><span translate="no">${esc(s.address||'—')}</span><span class="muted">${T('Phone')}</span><span>${esc(s.phone||'—')}</span><span class="muted">${T('ID')}</span><span>${s.idNumber?`${esc(T(s.idType||'ID'))} <span class="mono">${esc(s.idNumber)}</span>`:`<span class="neg">${T('No ID recorded')}</span>`}</span>`}
    ${s.gstNo?`<span class="muted">${T('GST/HST no.')}</span><span class="mono">${esc(s.gstNo)}</span>`:''}
    <span class="muted">${T('Paid')}</span><span>${money(r2((+v.price||0)+(+v.tax||0)))} · ${esc(T(PAY_METHODS[v.payMethod]||''))}${v.ref?` #${esc(v.ref)}`:''}</span>
    ${v.ownership?`<span class="muted">${T('Ownership or permit no.')}</span><span class="mono">${esc(v.ownership)}</span>`:''}${v.plate?`<span class="muted">${T('Plate')}</span><span class="mono">${esc(v.plate)}</span>`:''}${v.odometer?`<span class="muted">${T('Odometer')}</span><span>${esc(v.odometer)}</span>`:''}
  </div></div>
  <div class="panel"><h3>${T('Environmental checklist')} <span class="pill ${envDone===ENV_LIST.length?'paid':envDone?'partial':'open'}" style="margin-left:6px">${envDone} ${T('of')} ${ENV_LIST.length}</span></h3><div class="pad" style="display:flex;flex-direction:column;gap:6px">
    ${ENV_LIST.map(([k,l])=>`<label class="check"><input type="checkbox" data-env="${k}" ${env[k]?'checked':''} ${staff?'':'disabled'}> ${esc(T(l))}</label>`).join('')}
    ${env.date||env.by?`<div class="muted" style="font-size:12.5px">${env.date?fmtDate(env.date):''}${env.by?` · ${esc(env.by)}`:''}</div>`:''}
    <div class="muted" style="font-size:12.5px">${T('End-of-life vehicles have to be drained and stripped of hazardous parts before they’re crushed or shredded. Keep this record with the vehicle.')}</div></div></div></div>
  ${v.notes?`<div class="panel" style="margin-top:16px"><h3>Notes</h3><div class="pad" style="white-space:pre-wrap">${esc(v.notes)}</div></div>`:''}`;
}

/* ---------- buying a vehicle ---------- */
function nextStock(){
  const nums=S.vehicles.map(v=>parseInt(String(v.stock).replace(/\D/g,''),10)).filter(n=>n>0);
  const yr=today().slice(2,4);
  const mine=nums.filter(n=>String(n).startsWith(yr)&&String(n).length>=5);
  return mine.length?String(Math.max(...mine)+1):`${yr}001`;
}
/** The purchase as an expense: cost in, recoverable GST/HST to the tax accounts, paid from the bank, cash or card. */
function vehBuyLines(v){
  const lines=[];
  if(+v.price)lines.push({account:v.invAccount,debit:r2(+v.price),credit:0,taxCode:+v.tax?'std':'none',memo:vehLabel(v)});
  if(+v.tax){
    const ps=taxParts().filter(p=>p.recoverable!==false&&p.account),sum=ps.reduce((s,p)=>s+p.rate,0)||1;let left=r2(+v.tax);
    ps.forEach((p,i)=>{const a=i===ps.length-1?left:r2(+v.tax*p.rate/sum);left=r2(left-a);if(a)lines.push({account:p.account,debit:a,credit:0})});
  }
  lines.push({account:v.payAccount,debit:0,credit:r2((+v.price||0)+(+v.tax||0))});
  return lines;
}
function vehicleForm(v){
  const staff=yardStaff(),fr=S.company.lang==='fr';
  const cash=sortAccts(S.accounts.filter(yardCashAccts));
  const last=S.vehicles.slice().sort((a,b)=>(b.created||0)-(a.created||0))[0]||{};
  const d=v||{stock:nextStock(),vin:'',year:'',make:'',model:'',colour:'',odometer:'',plate:'',ownership:'',bought:today(),price:'',tax:0,sellerKind:'public',contactId:'',seller:{idType:ID_TYPES[0]},payMethod:last.payMethod||'cash',payAccount:last.payAccount&&acct(last.payAccount)?last.payAccount:(cash.find(a=>/cash|caisse/i.test(a.name))||cash[0]||{}).id||'',ref:'',invAccount:yardInvAcct()||'__new',status:'yard',env:{},parts:[],notes:''};
  const s=d.seller||{};
  const f=openModal(v?`${T('Vehicle')} #${v.stock}`:'Buy a vehicle',`
    <div class="subpanel"><div class="flabel">Vehicle</div><div class="fields">
      ${fld('vhStock','Stock no.',`<input type="text" id="vhStock" maxlength="30" value="${esc(d.stock)}">`)}
      ${fld('vhVin','VIN',`<input type="text" id="vhVin" maxlength="20" value="${esc(d.vin)}" autocomplete="off" style="text-transform:uppercase;font-family:var(--mono,monospace)"><span class="hint" data-vinnote>${vinNote(d.vin,v&&v.id)}</span>`)}
      ${fld('vhYear','Year',`<input type="number" id="vhYear" min="1900" max="2100" value="${esc(d.year)}">`)}${fld('vhMake','Make',`<input type="text" id="vhMake" maxlength="40" value="${esc(d.make)}" placeholder="${esc(T('e.g. Honda'))}">`)}
      ${fld('vhModel','Model',`<input type="text" id="vhModel" maxlength="60" value="${esc(d.model)}" placeholder="${esc(T('e.g. Civic'))}">`)}${fld('vhColour','Colour',`<input type="text" id="vhColour" maxlength="30" value="${esc(d.colour)}">`)}
      ${fld('vhOdo','Odometer',`<input type="text" id="vhOdo" maxlength="20" value="${esc(d.odometer)}" placeholder="km">`)}${fld('vhPlate','Plate',`<input type="text" id="vhPlate" maxlength="20" value="${esc(d.plate)}">`)}
      ${fld('vhOwn','Ownership or permit no.',`<input type="text" id="vhOwn" maxlength="40" value="${esc(d.ownership)}">`)}
    </div></div>
    <div class="subpanel"><div class="flabel">Bought from</div>
      <div class="seg" role="radiogroup" aria-label="${esc(T('Bought from'))}" style="display:flex;gap:16px;margin-bottom:8px"><label class="check"><input type="radio" name="vhKind" value="public" ${d.sellerKind!=='business'?'checked':''}> ${T('A member of the public')}</label><label class="check"><input type="radio" name="vhKind" value="business" ${d.sellerKind==='business'?'checked':''}> ${T('A business (tow company, dealer, insurer, another yard)')}</label></div>
      <div class="fields" data-vhpub>
        ${fld('vhSName','Seller’s name',`<input type="text" id="vhSName" maxlength="120" value="${esc(s.name||'')}">`)}${fld('vhSPhone','Phone',`<input type="tel" id="vhSPhone" maxlength="40" value="${esc(s.phone||'')}">`)}
        ${fld('vhSAddr','Address',`<input type="text" id="vhSAddr" maxlength="300" value="${esc(s.address||'')}">`,true)}
        ${fld('vhSIdT','Photo ID',`<select id="vhSIdT">${[...ID_TYPES,...(s.idType&&!ID_TYPES.includes(s.idType)?[s.idType]:[])].map(x=>`<option ${x===s.idType?'selected':''}>${esc(T(x))}</option>`).join('')}</select>`)}${fld('vhSIdN','ID number',`<input type="text" id="vhSIdN" maxlength="40" value="${esc(s.idNumber||'')}" autocomplete="off">`)}
        ${fld('vhSGst','GST/HST no. (only if the seller charged it)',`<input type="text" id="vhSGst" maxlength="30" value="${esc(s.gstNo||'')}">`)}
      </div>
      <div class="fields" data-vhbiz>${fld('vhC','Vendor',contactSelect('vhC',d.contactId,'vendor'),true)}</div>
    </div>
    <div class="subpanel"><div class="flabel">Payment</div><div class="fields">
      ${fld('vhDate','Date bought',`<input type="date" id="vhDate" value="${esc(d.bought)}">`)}
      ${fld('vhPrice','Price paid (before GST/HST)',`<input type="number" id="vhPrice" step="0.01" min="0" value="${esc(d.price)}">`)}
      ${fld('vhTax',`${esc(taxLbl())} ${T('charged by the seller')}`,`<input type="number" id="vhTax" step="0.01" min="0" value="${esc(d.tax||'')}" placeholder="0.00"><span class="hint">${T('Only when the seller is registered and charged it. People selling their own car don’t.')}</span>`)}
      ${fld('vhMethod','Paid by',`<select id="vhMethod">${Object.entries(PAY_METHODS).map(([k,l])=>`<option value="${k}" ${d.payMethod===k?'selected':''}>${esc(T(l))}</option>`).join('')}</select>`)}
      ${fld('vhPay','Paid from',`<select id="vhPay"><option value="">${T('Choose account…')}</option>${!cash.some(a=>/cash|caisse/i.test(a.name))?`<option value="__cash">${T('+ New account: Cash on hand')}</option>`:''}${acctOptions(d.payAccount,yardCashAccts)}</select>`)}
      ${fld('vhRef','Cheque or reference no.',`<input type="text" id="vhRef" maxlength="40" value="${esc(d.ref||'')}">`)}
      ${fld('vhInv','Cost goes to',`<select id="vhInv">${!yardInvAcct()?`<option value="__new" ${d.invAccount==='__new'?'selected':''}>${T('+ New account: Vehicles in yard (inventory)')}</option>`:''}${acctOptions(d.invAccount,a=>(a.type==='Asset'&&!['bank','ar','card'].includes(a.detail)||a.type==='Cost of Goods Sold')&&a.active!==false)}</select><span class="hint">${T('Vehicles in yard keeps the cost on the balance sheet until the car is finished, then moves it to cost of goods sold.')}</span>`)}
    </div></div>
    ${typeof classField==='function'?`<div class="fields">${classField('vhCls',v&&S.entries.find(e=>e.id===v.buyEntry)?.cls)}</div>`:''}
    ${fld('vhNotes','Notes (condition, where it came from, what’s on it)',`<textarea id="vhNotes" rows="2">${esc(d.notes||'')}</textarea>`,true)}`,
    staff?`${v?`<button type="button" class="btn danger left" data-vhdel>Delete…</button>`:'<span class="left"></span>'}<button type="button" class="btn" data-close>Cancel</button>${v?'':`<button type="button" class="btn" data-vhprint>${T('Save and print voucher')}</button>`}<button type="submit" class="btn primary">Save</button>`:'<button type="button" class="btn" data-close>Close</button>','wide');
  wireContactSelect(f,'vhC');
  const kind=()=>($('input[name=vhKind]:checked',f)||{}).value||'public';
  const sync=()=>{const b=kind()==='business';$('[data-vhpub]',f).hidden=b;$('[data-vhbiz]',f).hidden=!b};
  $$('input[name=vhKind]',f).forEach(r=>r.onchange=sync);sync();
  const vin=$('#vhVin',f);vin.oninput=()=>{$('[data-vinnote]',f).innerHTML=vinNote(vin.value,v&&v.id)};
  const db=$('[data-vhdel]',f);if(db)db.onclick=()=>deleteVehicle(v);
  let print=false;const pb=$('[data-vhprint]',f);if(pb)pb.onclick=()=>{print=true;f.requestSubmit()};
  f.onsubmit=async e=>{e.preventDefault();f.err('');if(!staff)return;
    const x={...(v?strip(v):{}),stock:$('#vhStock',f).value.trim(),vin:vin.value.toUpperCase().replace(/[\s-]/g,''),year:$('#vhYear',f).value,make:$('#vhMake',f).value.trim(),model:$('#vhModel',f).value.trim(),colour:$('#vhColour',f).value.trim(),odometer:$('#vhOdo',f).value.trim(),plate:$('#vhPlate',f).value.trim(),ownership:$('#vhOwn',f).value.trim(),
      bought:$('#vhDate',f).value,price:r2(+$('#vhPrice',f).value||0),tax:r2(+$('#vhTax',f).value||0),payMethod:$('#vhMethod',f).value,payAccount:$('#vhPay',f).value,ref:$('#vhRef',f).value.trim(),invAccount:$('#vhInv',f).value,sellerKind:kind(),notes:$('#vhNotes',f).value.trim(),
      seller:{name:$('#vhSName',f).value.trim(),phone:$('#vhSPhone',f).value.trim(),address:$('#vhSAddr',f).value.trim(),idType:$('#vhSIdT',f).value,idNumber:$('#vhSIdN',f).value.trim(),gstNo:$('#vhSGst',f).value.trim()},
      status:v?v.status:'yard',env:v?v.env:{},parts:v?v.parts:[],created:v?.created||Date.now()};
    if(!x.stock)return f.err('Give the vehicle a stock number.');
    if(!x.bought)return f.err('Enter the date it was bought.');
    if(x.sellerKind==='public'){
      if(!x.seller.name)return f.err('Enter the seller’s name.');
      if(x.tax&&!x.seller.gstNo)return f.err('GST/HST can only be claimed back when the seller charged it: enter their GST/HST number, or leave the tax at zero.');
      if(!x.seller.idNumber&&!await confirmBox('No photo ID recorded','Most yards have to record the seller’s photo ID when they buy from the public. Save without it?','Save anyway'))return;
      x.contactId='';
    }else{const cid=await resolveContact(f,'vhC','vendor');if(!cid)return f.err('Choose the business it was bought from.');x.contactId=cid;x.seller={gstNo:x.seller.gstNo}}
    if((x.price||x.tax)&&!x.payAccount)return f.err('Choose the account the seller was paid from.');
    if(x.vin&&S.vehicles.some(o=>o.id!==(v&&v.id)&&o.vin===x.vin)&&!await confirmBox('This VIN is already in the yard','Another vehicle has the same VIN. Save this one too?','Save anyway'))return;
    if(x.tax&&!taxParts().some(p=>p.recoverable!==false&&p.account))return f.err(`Add a “${taxLbl()} payable” account in Chart of accounts first.`);
    // Accounts made the first time they're needed.
    const w=[];
    const mk=(code,name,frName,type,detail)=>{const used=new Set(S.accounts.map(a=>a.code));const k=used.has(code)?'':code;const id=k&&!acct('a'+k)?'a'+k:uid();w.push({op:'set',collection:'accounts',id,data:{code:k,name:fr?frName:name,type,detail,desc:'',active:true}});return id};
    if(x.invAccount==='__new'||!x.invAccount)x.invAccount=mk('1410','Vehicles in yard (inventory)','Véhicules dans la cour (stocks)','Asset','');
    if(x.payAccount==='__cash')x.payAccount=mk('1060','Cash on hand','Encaisse','Asset','');
    const id=v?v.id:uid(),entryId=v&&v.buyEntry?v.buyEntry:'vb_'+id;
    const prevEntry=v&&S.entries.find(e=>e.id===v.buyEntry);
    if(x.price||x.tax){
      x.buyEntry=entryId;
      const entry={...(prevEntry?strip(prevEntry):{}),type:'expense',date:x.bought,ref:x.ref||x.stock,memo:`${fr?'Achat du véhicule':'Vehicle bought'} #${x.stock}${vehDesc(x)?' · '+vehDesc(x):''}${x.vin?' · VIN '+x.vin:''}`,contactId:x.contactId||'',vehBuy:id,veh:id,lines:vehBuyLines(x),created:prevEntry?.created||Date.now()};
      delete entry.form;const cls=$('#vhCls',f);if(cls){if(cls.value)entry.cls=cls.value;else delete entry.cls}
      w.push({op:'set',collection:'vehicles',id,data:{...x,buyEntry:entryId}},{op:'set',collection:'entries',id:entryId,data:entry});
    }else{
      x.buyEntry='';w.push({op:'set',collection:'vehicles',id,data:x});
      if(prevEntry)w.push({op:'delete',collection:'entries',id:prevEntry.id});
    }
    // A finished vehicle whose cost changed: its cost-of-goods-sold entry follows.
    const doneE=v&&S.entries.find(e=>e.id===v.doneEntry);
    if(doneE&&acct(x.invAccount)?.type==='Asset'&&x.price){w.push({op:'set',collection:'entries',id:doneE.id,data:{...strip(doneE),lines:[{account:doneE.lines[0].account,debit:x.price,credit:0},{account:x.invAccount,debit:0,credit:x.price}]}})}
    if(!await batch(w))return;
    closeModal();toast(v?'Vehicle saved':`${T('Vehicle')} #${x.stock} ${T('added to the yard')}`);
    if(!v){S.param=id;if(S.view!=='yard')go('yard',id);else renderMain()}
    if(print)printVoucher(vehById(id));
  };
}
async function deleteVehicle(v){
  const used=S.entries.some(e=>e.veh===v.id&&e.id!==v.buyEntry&&e.id!==v.doneEntry)||(v.parts||[]).some(p=>p.status==='sold');
  if(used)return toast('Transactions point at this vehicle, so it can’t be deleted. Mark it finished instead.',true);
  if(!await confirmBox('Delete this vehicle?','The vehicle and its purchase transaction are deleted. If the seller was paid, the payment comes out of the books too.','Delete'))return;
  const w=[];
  if(v.buyEntry||v.doneEntry)w.push({op:'set',collection:'vehicles',id:v.id,data:{...strip(v),buyEntry:'',doneEntry:''}});
  for(const e of[v.buyEntry,v.doneEntry])if(e&&S.entries.some(x=>x.id===e))w.push({op:'delete',collection:'entries',id:e});
  w.push({op:'delete',collection:'vehicles',id:v.id});
  if(await batch(w)){closeModal();S.param=null;toast('Vehicle deleted');renderMain()}
}

/* ---------- finishing a vehicle ---------- */
function finishForm(v){
  const asset=acct(v.invAccount)?.type==='Asset'&&+v.price>0;
  const f=openModal(`${T('Finish vehicle')} #${v.stock}`,`<div class="muted" style="font-size:13px">${T('When the car is crushed or sent to the shredder, or sold whole. Parts still in stock stay listed.')}</div>
    <div class="fields">${fld('vfStatus','What happened',`<select id="vfStatus"><option value="done">${T(VEH_STATUS.done)}</option><option value="sold">${T(VEH_STATUS.sold)}</option></select>`)}${fld('vfDate','Date',`<input type="date" id="vfDate" value="${today()}">`)}
    ${asset?fld('vfCogs','Move its cost to',`<select id="vfCogs">${acctOptions(v.cogsAccount||yardCogsAcct(),a=>(a.type==='Cost of Goods Sold'||a.type==='Expense')&&a.active!==false)}</select><span class="hint">${money(v.price)} ${T('comes out of')} ${esc(acctName(v.invAccount))}.</span>`):''}</div>
    ${ENV_LIST.some(([k])=>!(v.env||{})[k])?`<div class="banner" style="margin:0"><span>${T('The environmental checklist isn’t complete for this vehicle.')}</span></div>`:''}`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Mark finished</button>`);
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const status=$('#vfStatus',f).value,date=$('#vfDate',f).value;if(!date)return f.err('Enter the date.');if(date<v.bought)return f.err('That’s before the vehicle was bought.');
    const w=[],x={...strip(v),status,doneDate:date};
    if(asset){const cogs=$('#vfCogs',f).value;if(!cogs)return f.err('Choose the cost of goods sold account.');const id='vd_'+v.id;x.cogsAccount=cogs;x.doneEntry=id;
      w.push({op:'set',collection:'entries',id,data:{type:'journal',date,ref:v.stock,memo:`${S.company.lang==='fr'?'Véhicule terminé':'Vehicle finished'} #${v.stock}${vehDesc(v)?' · '+vehDesc(v):''}`,vehDone:v.id,veh:v.id,lines:[{account:cogs,debit:r2(+v.price),credit:0},{account:v.invAccount,debit:0,credit:r2(+v.price)}],created:Date.now()}})}
    w.unshift({op:'set',collection:'vehicles',id:v.id,data:x});
    if(await batch(w)){closeModal();toast(`${T('Vehicle')} #${v.stock} ${T('finished')}`)}};
}
async function reopenVehicle(v){
  if(!await confirmBox('Put this vehicle back in the yard?','Its cost goes back to the vehicles-in-yard account (the entry that moved it to cost of goods sold is deleted).','Put it back'))return false;
  const w=[{op:'set',collection:'vehicles',id:v.id,data:{...strip(v),status:'yard',doneDate:'',doneEntry:''}}];
  if(v.doneEntry&&S.entries.some(e=>e.id===v.doneEntry))w.push({op:'delete',collection:'entries',id:v.doneEntry});
  return batch(w);
}
/** Opening the purchase or finishing entry from a register opens the vehicle instead. */
function vehFromEntry(e){
  const v=vehById(e.vehBuy||e.vehDone);if(!v)return false;
  if(e.vehDone){
    if(S.view!=='yard'||S.param!==v.id)go('yard',v.id);
    confirmBox('Cost of goods sold for a finished vehicle',`${T('This entry moved the cost of vehicle')} #${v.stock} ${T('to cost of goods sold when it was finished. To change it, put the vehicle back in the yard.')}`,'Put it back in the yard').then(ok=>{if(ok)reopenVehicle(v).then(r=>{if(r)toast('Vehicle back in the yard')})});
    return true;
  }
  vehicleForm(v);return true;
}

/* ---------- parts ---------- */
function partForm(v,p){
  const d=p||{name:'',location:'',price:'',status:'stock'};
  const f=openModal(p?p.name:`${T('Add part from')} #${v.stock}`,`<div class="fields">
    ${fld('ptName','Part',`<input type="text" id="ptName" maxlength="120" value="${esc(d.name)}" placeholder="${esc(T('e.g. Alternator, driver door, catalytic converter'))}" list="ptList">`,true)}
    <datalist id="ptList">${['Engine','Transmission','Alternator','Starter','Radiator','A/C compressor','Catalytic converter','Driver door','Passenger door','Hood','Trunk lid','Front bumper','Rear bumper','Headlight','Tail light','Side mirror','Wheel and tire','Seat','Airbag module','ECU','Battery'].map(x=>`<option value="${esc(T(x))}">`).join('')}</datalist>
    ${fld('ptLoc','Bin or location',`<input type="text" id="ptLoc" maxlength="60" value="${esc(d.location)}" placeholder="${esc(T('e.g. Rack B3'))}">`)}${fld('ptPrice','Asking price',`<input type="number" id="ptPrice" step="0.01" min="0" value="${esc(d.price)}">`)}
    ${p&&p.status!=='sold'?fld('ptStatus','Status',`<select id="ptStatus"><option value="stock" ${d.status==='stock'?'selected':''}>${T('In stock')}</option><option value="scrapped" ${d.status==='scrapped'?'selected':''}>${T('Scrapped')}</option></select>`):''}
    </div>${p&&p.status==='sold'?`<div class="banner" style="margin:0"><span>${T('Sold. To put it back in stock, delete the sale or use the button below.')}</span><button type="button" class="btn sm" data-ptback>${T('Back in stock')}</button></div>`:''}`,
    saveFoot(!!p&&p.status!=='sold'));
  const save=async parts=>{if(await put('vehicles',v.id,{...strip(v),parts})){closeModal();return true}return false};
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Remove this part?','It comes off the vehicle’s list.','Remove'))return;if(await save(v.parts.filter(x=>x.id!==p.id)))toast('Part removed')};
  const bb=$('[data-ptback]',f);if(bb)bb.onclick=async()=>{if(await save(v.parts.map(x=>x.id===p.id?{...x,status:'stock',docId:''}:x)))toast('Part back in stock')};
  f.onsubmit=async e=>{e.preventDefault();f.err('');const name=$('#ptName',f).value.trim();if(!name)return f.err('Name the part.');
    const st=$('#ptStatus',f);const x={id:p?p.id:uid(),name,location:$('#ptLoc',f).value.trim(),price:r2(+$('#ptPrice',f).value||0),status:p?(st?st.value:p.status):'stock',docId:p?p.docId||'':'',added:p?.added||today()};
    if(await save(p?v.parts.map(y=>y.id===p.id?x:y):[...(v.parts||[]),x]))toast(p?'Part saved':`${name} ${T('added')}`)};
}
/** Sell a part (or scrap) from a vehicle: a sales receipt pointing at the vehicle. */
function sellFromVehicle(v,p){
  const item=S.items.find(i=>/used auto part|pièce d’auto usagée/i.test(i.name)&&i.active!==false);
  const line=p?{item:item?item.id:'',desc:`${p.name} · ${T('from')} ${vehLabel(v)}${v.vin?' · VIN '+v.vin:''}`,account:item&&item.incomeAccount||yardPartsIncome(),qty:1,rate:p.price||'',taxCode:'std'}:null;
  // A part sold over the counter: to the walk-in customer, made the first time.
  const walk=p&&S.contacts.find(c=>c.kind==='customer'&&/^(walk-in customer|client de passage)$/i.test(c.name));
  docForm('sreceipt',null,{veh:v?v.id:'',...(line?{lines:[line]}:{}),...(walk?{contactId:walk.id}:p?{newContact:S.company.lang==='fr'?'Client de passage':'Walk-in customer'}:{}),note:v?`<div class="banner" style="margin:0 0 8px"><span>${p?T('Selling a part from'):T('Sale for')} ${esc(vehLabel(v))}</span></div>`:'',
    onSaved:async docId=>{if(p){const cur=vehById(v.id);if(cur&&await put('vehicles',v.id,{...strip(cur),parts:cur.parts.map(x=>x.id===p.id?{...x,status:'sold',docId}:x)}))toast(`${p.name} ${T('sold')}`)}else toast('Sale saved')}});
}

/* ---------- purchase voucher (bill of sale) ---------- */
function voucherHTML(v){
  const c=S.company,s=v.seller||{},total=r2((+v.price||0)+(+v.tax||0));
  const row=(k,val)=>`<tr><th>${esc(T(k))}</th><td>${val||'&nbsp;'}</td></tr>`;
  return `<section class="yv"><style>.yv{font:13px/1.45 system-ui,sans-serif;color:#111;max-width:720px;margin:0 auto;padding:24px}.yv h1{font-size:20px;margin:0 0 2px}.yv h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin:18px 0 6px;border-bottom:1px solid #bbb;padding-bottom:3px}.yv table{width:100%;border-collapse:collapse}.yv th{text-align:left;font-weight:600;width:38%;padding:3px 8px 3px 0;vertical-align:top;color:#333}.yv td{padding:3px 0;border-bottom:1px dotted #ccc}.yv .top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.yv .no{text-align:right}.yv .decl{margin-top:14px;font-size:12.5px}.yv .sig{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:34px}.yv .sig div{border-top:1px solid #111;padding-top:4px;font-size:12px}.yv .mono{font-family:ui-monospace,monospace;letter-spacing:.04em}</style>
    <div class="top"><div><h1 translate="no">${esc(c.name||'')}</h1><div translate="no">${esc(c.address||'').replace(/\n/g,'<br>')}</div>${c.phone?`<div>${esc(c.phone)}</div>`:''}${c.bn?`<div>${T('Business no.')} ${esc(c.bn)}</div>`:''}</div>
    <div class="no"><b style="font-size:15px">${T('Vehicle purchase record')}</b><div>${T('Bill of sale')}</div><div>${T('Stock no.')} <b class="mono">${esc(v.stock)}</b></div><div>${fmtDate(v.bought)}</div></div></div>
    <h2>${T('Vehicle')}</h2><table>${row('VIN',`<span class="mono">${esc(v.vin)}</span>`)}${row('Year, make and model',esc(vehDesc(v)))}${row('Colour',esc(v.colour))}${row('Plate',esc(v.plate))}${row('Ownership or permit no.',esc(v.ownership))}${row('Odometer',esc(v.odometer))}</table>
    <h2>${T('Seller')}</h2><table>${row('Name',esc(s.name))}${row('Address',esc(s.address))}${row('Phone',esc(s.phone))}${row('Photo ID',s.idNumber?`${esc(T(s.idType||''))} · <span class="mono">${esc(s.idNumber)}</span>`:'')}${s.gstNo?row('GST/HST no.',esc(s.gstNo)):''}</table>
    <h2>${T('Payment')}</h2><table>${row('Price',money(v.price))}${+v.tax?row(taxLbl(),money(v.tax)):''}${row('Total paid',`<b>${money(total)}</b>`)}${row('Paid by',esc(T(PAY_METHODS[v.payMethod]||''))+(v.ref?` #${esc(v.ref)}`:''))}</table>
    <div class="decl">${T('The seller declares that they own this vehicle or are authorized to sell it, that it is free of liens and claims, and that the information above is true. The vehicle is sold as is, for parts or scrap.')}</div>
    <div class="sig"><div>${T('Seller’s signature')}</div><div>${T('Date')}</div><div>${T('Received for')} <span translate="no">${esc(c.name||'')}</span></div><div>${T('Date')}</div></div></section>`;
}
function printVoucher(v){
  if(!v)return;
  let root=$('#printRoot');if(!root){root=document.createElement('div');root.id='printRoot';document.body.appendChild(root)}
  root.innerHTML=voucherHTML(v);
  document.body.classList.add('printing');
  const done=()=>{document.body.classList.remove('printing');root.innerHTML='';window.removeEventListener('afterprint',done)};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{window.print();setTimeout(()=>{if(document.body.classList.contains('printing'))done()},1500)},50);
}

/* ---------- CSV ---------- */
function yardCsv(name,rows){
  const text=rows.map(r=>r.map(v=>/[",\n]/.test(String(v??''))?`"${String(v).replace(/"/g,'""')}"`:v??'').join(',')).join('\n');
  saveFile(name,new Blob([text],{type:'text/csv'}));
}
function vehiclesCsv(){
  const rows=[['Stock no.','VIN','Year','Make','Model','Colour','Bought','Bought from','Price','GST/HST','Paid by','Income','Other costs','Profit','Status','Finished','Parts in stock']];
  for(const v of S.vehicles.slice().sort(byStock)){const n=vehNumbers(v);rows.push([v.stock,v.vin,v.year,v.make,v.model,v.colour,v.bought,v.sellerKind==='business'?contactName(v.contactId):(v.seller||{}).name,n.price,+v.tax||0,PAY_METHODS[v.payMethod]||'',n.income,n.costs,n.profit,VEH_STATUS[v.status],v.doneDate||'',(v.parts||[]).filter(p=>p.status==='stock').length])}
  yardCsv(`vehicles_${today()}.csv`,rows);
}
function publicCsv(){
  const Y=S.yard,rows=[['Date','Stock no.','VIN','Year','Make','Model','Colour','Plate','Ownership or permit no.','Seller','Address','Phone','ID type','ID number','Price','GST/HST','Total paid','Paid by','Reference']];
  for(const v of S.vehicles.filter(v=>v.sellerKind!=='business'&&v.bought>=Y.from&&v.bought<=Y.to).sort((a,b)=>a.bought.localeCompare(b.bought))){const s=v.seller||{};rows.push([v.bought,v.stock,v.vin,v.year,v.make,v.model,v.colour,v.plate,v.ownership,s.name,s.address,s.phone,s.idType,s.idNumber,+v.price||0,+v.tax||0,r2((+v.price||0)+(+v.tax||0)),PAY_METHODS[v.payMethod]||'',v.ref])}
  yardCsv(`bought-from-public_${Y.from}_${Y.to}.csv`,rows);
}

/* ---------- clicks and inputs ---------- */
async function yardClick(e,t,d){
  // The vehicle picker's links can come from other pages (a part sold on a sales receipt).
  if(S.view!=='yard')return false;
  const v=S.param&&vehById(S.param);
  if(d.ytab){S.yard.tab=d.ytab;S.param=null;renderMain();return true}
  if(t.hasAttribute('data-yardback')){S.param=null;renderMain();return true}
  if(d.vehopen){S.param=d.vehopen;renderMain();window.scrollTo(0,0);return true}
  if(d.veh!==undefined){vehicleForm(d.veh?vehById(d.veh):null);return true}
  if(d.vehfinish){finishForm(vehById(d.vehfinish));return true}
  if(d.part){const[vid,pid]=d.part.split('|'),x=vehById(vid);if(x)partForm(x,pid?(x.parts||[]).find(p=>p.id===pid):null);return true}
  if(d.partsell){const[vid,pid]=d.partsell.split('|'),x=vehById(vid);if(x)sellFromVehicle(x,(x.parts||[]).find(p=>p.id===pid));return true}
  if(d.yardsell){sellFromVehicle(vehById(d.yardsell),null);return true}
  if(d.yardcost){moneyForm('expense',null,{veh:d.yardcost});return true}
  if(d.docopen){const doc=S.docs.find(x=>x.id===d.docopen);if(doc){docForm(doc.kind,doc)}return true}
  if(d.yard==='voucher'&&v){printVoucher(v);return true}
  if(d.yard==='setup'){await yardSetup();return true}
  if(d.yard==='hint'){S.yardHint=true;renderMain();return true}
  if(d.yard==='sell'){docForm('sreceipt',null);return true}
  if(d.yard==='cost'){moneyForm('expense');return true}
  if(d.yard==='vcsv'){vehiclesCsv();return true}
  if(d.yard==='pcsv'){publicCsv();return true}
  return false;
}
function bindYard(m){
  if(S.view!=='yard'||!S.yard)return;
  const q=$('#yardQ',m);if(q)q.oninput=()=>{S.yard.q=q.value;S.more={};renderMain()};
  const sh=$('#yardShow',m);if(sh)sh.onchange=()=>{S.yard.show=sh.value;renderMain()};
  const v=S.param&&vehById(S.param);
  if(v&&yardStaff())$$('[data-env]',m).forEach(cb=>cb.onchange=async()=>{const cur=vehById(v.id);if(!cur)return;const env={...(cur.env||{}),[cb.dataset.env]:cb.checked,date:today(),by:ME.name||ME.username||''};if(!await put('vehicles',v.id,{...strip(cur),env}))cb.checked=!cb.checked});
  const fr=$('#ypFrom',m),to=$('#ypTo',m);if(fr)fr.onchange=()=>{S.yard.from=fr.value||S.yard.from;renderMain()};if(to)to.onchange=()=>{S.yard.to=to.value||S.yard.to;renderMain()};
}

/* ---------- Settings: the add-on ---------- */
function yardPanel(){
  if(!CO||!S.loaded||!ME||ME.role==='client')return '';
  const on=yardOn(),owner=ME.role==='owner'&&!ME.readOnly,A=TallyPlans.ADDONS.scrapyard;
  const price=typeof BILL!=='undefined'&&BILL&&BILL.configured&&BILL.offer&&BILL.offer.amounts&&BILL.offer.amounts.scrapyard;
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>${T('Scrap yard')} <span class="pill quiet">${T('Add-on')}</span></h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="muted" style="font-size:13.5px">${esc(T(A.desc))}.</div>
    <label class="check"><input type="checkbox" id="yardCo" ${on?'checked':''} ${owner?'':'disabled'}> ${T('Add the Scrap yard tools to this company')}</label>
    ${price&&!(BILL.firm&&BILL.firm.exempt)?`<div class="muted" style="font-size:12.5px">${money(price/100)} ${T('a month for this company, on top of its plan.')}</div>`:''}
    ${!owner?`<div class="muted" style="font-size:12.5px">${T('Only an owner can add or remove it.')}</div>`:''}
    ${on&&yardStaff()?`<div><button type="button" class="btn sm" data-yard="setup">${T('Set up the scrap yard accounts and materials')}</button></div>`:''}</div></div>`;
}
function bindYardPanel(m){
  const cb=$('#yardCo',m);if(!cb)return;
  cb.onchange=async()=>{const want=cb.checked;cb.disabled=true;
    if(want&&!await confirmBox('Add the Scrap yard tools?',`${T('A Scrap yard page appears in the menu for')} ${S.company.name}.${typeof BILL!=='undefined'&&BILL&&BILL.configured&&!(BILL.firm&&BILL.firm.exempt)?' '+T('The add-on is billed each month until you remove it.'):''}`,'Add it')){cb.checked=false;cb.disabled=false;return}
    if(!want&&S.vehicles.length&&!await confirmBox('Remove the Scrap yard tools?','The vehicles stay in the books and come back if you add it again. Their transactions aren’t touched.','Remove')){cb.checked=true;cb.disabled=false;return}
    try{await api('PUT',`/api/companies/${encodeURIComponent(CO)}`,{scrapyard:want});await load();toast(want?'Scrap yard tools added to this company':'Scrap yard tools removed from this company');if(want&&!yardInvAcct())await yardSetup()}
    catch(e){cb.checked=!want;toast(e.message,true)}finally{cb.disabled=false}};
  const sb=$('[data-yard=setup]',m);if(sb&&S.view==='settings')sb.onclick=()=>yardSetup();
}

/* ---------- French ---------- */
if(typeof addFr==='function')addFr({
  'Scrap yard':'Cour à ferraille','Vehicles':'Véhicules','Parts in stock':'Pièces en stock','Bought from the public':'Achetés au public','Buy a vehicle':'Acheter un véhicule','+ Buy a vehicle':'+ Acheter un véhicule',
  'Record a cost':'Inscrire un coût','Sell scrap or parts':'Vendre de la ferraille ou des pièces','Vehicles bought, parts pulled and profit per vehicle':'Véhicules achetés, pièces récupérées et profit par véhicule',
  'In the yard':'Dans la cour','Being parted out':'En démontage','Finished (crushed or scrapped)':'Terminé (écrasé ou mis à la ferraille)','Sold whole':'Vendu entier','Finished or sold':'Terminés ou vendus',
  'Stock no.':'No de stock','Vehicle':'Véhicule','VIN':'NIV','Bought':'Acheté','From':'De','Paid':'Payé','Other costs':'Autres coûts','Profit':'Profit','Status':'Statut','Income':'Revenus',
  'No vehicle':'Aucun véhicule','Finished this fiscal year':'Terminés cet exercice','at cost':'au coût','profit':'profit','Matches the vehicles in the yard':'Correspond aux véhicules dans la cour',
  'Part':'Pièce','Bin or location':'Bac ou emplacement','From vehicle':'Du véhicule','Asking price':'Prix demandé','Sell':'Vendre','Sold':'Vendu','Scrapped':'Mis à la ferraille','In stock':'En stock',
  'Parts pulled':'Pièces récupérées','+ Add part':'+ Ajouter une pièce','Transactions':'Opérations','Seller':'Vendeur','Bought from':'Acheté de','Environmental checklist':'Liste de contrôle environnementale',
  'Fluids drained (fuel, oil, coolant, washer fluid)':'Fluides vidangés (carburant, huile, liquide de refroidissement, lave-glace)','Battery removed':'Batterie retirée','A/C refrigerant recovered':'Frigorigène de climatisation récupéré',
  'Mercury switches removed':'Interrupteurs au mercure retirés','Tires removed':'Pneus retirés','Airbags removed or deployed':'Coussins gonflables retirés ou déployés',
  'Print purchase voucher':'Imprimer le bon d’achat','Edit vehicle':'Modifier le véhicule','Mark finished…':'Marquer comme terminé…','Mark finished':'Marquer comme terminé','Paid for it':'Prix payé',
  'A member of the public':'Un particulier','A business (tow company, dealer, insurer, another yard)':'Une entreprise (remorqueur, concessionnaire, assureur, autre cour)',
  'Seller’s name':'Nom du vendeur','Photo ID':'Pièce d’identité avec photo','ID number':'Numéro de la pièce','Date bought':'Date d’achat','Price paid (before GST/HST)':'Prix payé (avant TPS/TVH)',
  'Paid by':'Payé par','Paid from':'Payé à partir de','Cheque or reference no.':'No de chèque ou de référence','Cost goes to':'Le coût va à','Year':'Année','Make':'Marque','Model':'Modèle','Colour':'Couleur','Odometer':'Odomètre','Plate':'Plaque',
  'Ownership or permit no.':'No de certificat d’immatriculation','Cash':'Comptant','Cheque':'Chèque','Debit or credit card':'Carte de débit ou de crédit','Other':'Autre',
  'Driver’s licence':'Permis de conduire','Ontario Photo Card':'Carte-photo de l’Ontario','Passport':'Passeport','Other government photo ID':'Autre pièce d’identité gouvernementale avec photo',
  'Vehicle purchase record':'Registre d’achat de véhicule','Bill of sale':'Acte de vente','Seller’s signature':'Signature du vendeur','Total paid':'Total payé','Payment':'Paiement',
  'Set up the scrap yard':'Configurer la cour à ferraille','Set up the scrap yard accounts and materials':'Ajouter les comptes et les matières de la cour à ferraille','Add the Scrap yard tools to this company':'Ajouter les outils de cour à ferraille à cette entreprise',
  'Weigh ticket no.':'No de billet de pesée','Export CSV':'Exporter en CSV','No ID recorded':'Aucune pièce d’identité inscrite','Save and print voucher':'Enregistrer et imprimer le bon',
});
