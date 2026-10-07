'use strict';
/* ---------- Products and services ----------
   Saved once (name, description, price, account, tax code) and picked on invoices, sales receipts,
   estimates, recurring transactions and bills. Picking one fills in the line; everything stays editable. */

const ITEM_TYPE={service:'Service',product:'Product'};
const itemsFor=sale=>S.items.filter(i=>sale?i.sold!==false:i.bought);
/** The "Product or service" column for a line editor, shown once the company has any. keepTax: true when the customer's or vendor's own tax code should win. */
function itemCol(sale,keepTax){
  if(!itemsFor(sale).length)return [];
  return [{key:'item',label:'Product or service',type:'item',sale,keepTax}];
}
function itemOptions(sel,sale){
  const list=itemsFor(sale).filter(i=>i.active!==false||i.id===sel).sort((a,b)=>a.name.localeCompare(b.name));
  return `<option value="">—</option>`+list.map(i=>`<option value="${esc(i.id)}" ${i.id===sel?'selected':''}>${esc(i.name)}${i.active===false?' (inactive)':''}</option>`).join('');
}
const itemPrice=(i,sale)=>{const v=sale?i.price:i.cost;return v===''||v===undefined||v===null?'':money(v)};

function vItems(){
  const q=(S.itemQ||'').trim().toLowerCase();
  const all=S.items.slice().sort((a,b)=>(a.active===false)-(b.active===false)||a.name.localeCompare(b.name));
  const list=all.filter(i=>!q||[i.name,i.sku,i.desc].join(' ').toLowerCase().includes(q));
  // Sold this fiscal year, from invoice and sales receipt lines (credit notes take away).
  const fy=fyStartOf(today()),sold={};
  for(const d of S.docs){if(d.date<fy||!['invoice','sreceipt','credit'].includes(d.kind))continue;const sg=d.kind==='credit'?-1:1;for(const l of d.lines||[])if(l.item)sold[l.item]=r2((sold[l.item]||0)+sg*(+l.qty||0)*(+l.rate||0))}
  const staff=ME&&ME.role!=='client'&&!ME.readOnly;
  return `<div class="panel"><div class="toolbar"><input class="grow" type="search" id="itemQ" placeholder="Search products and services" value="${esc(S.itemQ||'')}" aria-label="Search products and services"><span class="muted">${all.length} item${all.length===1?'':'s'}</span>${staff?'<button class="btn sm primary" data-item="">+ Add product or service</button>':''}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Description</th><th class="n">Sales price</th><th class="n">Cost</th><th>Tax</th><th>Income account</th><th class="n">Sold this fiscal year</th></tr></thead><tbody>${list.length?list.map(i=>`<tr class="click ${i.active===false?'archived':''}" data-item="${esc(i.id)}"><td><b translate="no">${esc(i.name)}</b>${i.sku?` <span class="muted mono" style="font-size:12px">${esc(i.sku)}</span>`:''}${i.active===false?' <span class="pill quiet">Inactive</span>':''}${i.example?' <span class="pill ex">Example</span>':''}</td><td>${esc(T(ITEM_TYPE[i.type]||'Service'))}</td><td class="trunc muted" translate="no">${esc(i.desc||'')}</td><td class="n">${i.sold!==false?itemPrice(i,true)||'—':'<span class="muted">Not sold</span>'}</td><td class="n">${i.bought?itemPrice(i,false)||'—':'<span class="muted">—</span>'}</td><td class="muted">${esc(taxCodeLabel(i.taxCode||'std'))}</td><td class="trunc" translate="no">${i.incomeAccount?esc(acctName(i.incomeAccount)):'<span class="muted">—</span>'}</td><td class="n">${sold[i.id]?money(sold[i.id]):'<span class="muted">—</span>'}</td></tr>`).join('')
    :emptyRow(8,all.length?'Nothing matches':'No products or services yet',all.length?'Clear the search to see them all.':'Add what you sell, like “Monthly bookkeeping” or “Hourly consulting”. Then pick it on invoices and the price, account and tax fill in.')}</tbody></table></div></div>`;
}
function bindItemsSearch(m){const q=$('#itemQ',m);if(q)q.oninput=()=>{S.itemQ=q.value;renderMain()}}

function itemForm(it){
  const staff=ME&&ME.role!=='client'&&!ME.readOnly;
  const d=it||{type:'service',sold:true,bought:false,taxCode:'std',price:'',cost:'',active:true};
  const incDef=d.incomeAccount||(sortAccts(S.accounts.filter(a=>a.type==='Income'&&a.active!==false))[0]||{}).id||'';
  const expDef=d.expenseAccount||(sortAccts(S.accounts.filter(a=>(a.type==='Expense'||a.type==='Cost of Goods Sold')&&a.active!==false))[0]||{}).id||'';
  const f=openModal(it?it.name:'New product or service',`<div class="fields">
    ${fld('itName','Name',`<input type="text" id="itName" maxlength="120" value="${esc(d.name||'')}">`)}
    ${fld('itType','Type',`<select id="itType">${Object.entries(ITEM_TYPE).map(([k,v])=>`<option value="${k}" ${d.type===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}
    ${fld('itSku','SKU or code (optional)',`<input type="text" id="itSku" maxlength="60" value="${esc(d.sku||'')}">`)}
    ${fld('itTax','Tax',`<select id="itTax">${taxCodeOptions(d.taxCode||'std')}</select>`)}
    ${fld('itDesc','Description on invoices',`<textarea id="itDesc" rows="2" maxlength="500">${esc(d.desc||'')}</textarea>`,true)}
    </div>
    <div class="subpanel"><label class="check"><input type="checkbox" id="itSold" ${d.sold!==false?'checked':''}> I sell this</label>
      <div class="fields" data-sold>${fld('itPrice','Sales price',`<input type="number" id="itPrice" step="0.01" inputmode="decimal" value="${esc(d.price??'')}">`)}${fld('itInc','Income account',`<select id="itInc"><option value="">Choose account…</option>${acctOptions(incDef,a=>a.type==='Income')}</select>`)}</div></div>
    <div class="subpanel"><label class="check"><input type="checkbox" id="itBought" ${d.bought?'checked':''}> I buy this from vendors</label>
      <div class="fields" data-bought>${fld('itCost','Purchase cost',`<input type="number" id="itCost" step="0.01" inputmode="decimal" value="${esc(d.cost??'')}">`)}${fld('itExp','Expense account',`<select id="itExp"><option value="">Choose account…</option>${acctOptions(expDef,a=>a.type==='Expense'||a.type==='Cost of Goods Sold'||(a.type==='Asset'&&(!a.detail||a.detail==='capital')))}</select>`)}</div></div>
    ${it?`<label class="check"><input type="checkbox" id="itActive" ${d.active!==false?'checked':''}> Active (untick to hide it from new invoices and bills)</label>`:''}`,
    staff?saveFoot(!!it):'<button type="button" class="btn" data-close>Close</button>');
  const sync=()=>{$('[data-sold]',f).hidden=!$('#itSold',f).checked;$('[data-bought]',f).hidden=!$('#itBought',f).checked};
  $('#itSold',f).onchange=$('#itBought',f).onchange=sync;sync();
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this product or service?',`${it.name} is taken off the list. Invoices and bills that already use it keep their lines.`,'Delete'))return;if(await del('items',it.id)){closeModal();toast('Deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');if(!staff)return;
    const data={...(it?strip(it):{}),name:$('#itName',f).value.trim(),type:$('#itType',f).value,sku:$('#itSku',f).value.trim(),taxCode:$('#itTax',f).value,desc:$('#itDesc',f).value.trim(),
      sold:$('#itSold',f).checked,price:$('#itPrice',f).value,incomeAccount:$('#itSold',f).checked?$('#itInc',f).value:'',
      bought:$('#itBought',f).checked,cost:$('#itCost',f).value,expenseAccount:$('#itBought',f).checked?$('#itExp',f).value:'',
      active:it?$('#itActive',f).checked:true};
    if(!data.name)return f.err('Give it a name.');
    if(!data.sold&&!data.bought)return f.err('Tick whether you sell it, buy it, or both.');
    if(data.sold&&!data.incomeAccount)return f.err('Choose the income account.');
    if(data.bought&&!data.expenseAccount)return f.err('Choose the expense account.');
    if(await put('items',it?it.id:uid(),data)){closeModal();toast(it?'Saved':`${data.name} added`)}};
}
