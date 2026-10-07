'use strict';
/* ---------- Inventory ----------
   Inventory items are counted. Stock comes in on bills (at the bill's cost) and goes out on invoices and sales
   receipts; credit notes bring it back and vendor credits send it back. Cost is the moving average: each sale's
   cost is the average cost on its date, saved on the line and posted as cost of goods sold (debit) out of the
   inventory asset account (credit). Adjustments (counts, damage) change the quantity, and the value at average cost. */

const invItem=id=>{const i=S.items.find(x=>x.id===id);return i&&i.type==='inventory'?i:null};
/** Every movement of an item, in date order: { date, qty (signed), cost (total, for purchases), sale (true when it goes out at average cost) } */
function stockMoves(itemId,except){
  const it=invItem(itemId);if(!it)return [];
  const out=[];
  if(+it.qtyStart||+it.valueStart)out.push({date:it.startDate||'0000-00-00',qty:+it.qtyStart||0,cost:+it.valueStart||0,ord:0,what:'start'});
  for(const d of S.docs){if(d.id===except)continue;
    for(const l of d.lines||[]){if(l.item!==itemId)continue;const q=+l.qty||0;
      if(d.kind==='bill')out.push({date:d.date,qty:q,cost:r2(q*(+l.rate||0)*(+d.fx||1)),ord:1,doc:d}); // in Canadian dollars
      else if(d.kind==='vcredit')out.push({date:d.date,qty:-q,cost:-r2(q*(+l.rate||0)*(+d.fx||1)),ord:1,doc:d});
      else if(d.kind==='invoice'||d.kind==='sreceipt')out.push({date:d.date,qty:-q,sale:true,ord:3,doc:d,posted:l.cost});
      else if(d.kind==='credit')out.push({date:d.date,qty:q,sale:true,ord:2,doc:d,posted:l.cost})}}
  for(const e of S.entries)if(e.type==='invadjust'&&e.inv&&e.inv.item===itemId)out.push({date:e.date,qty:+e.inv.qty||0,cost:+e.inv.value||0,ord:1,entry:e});
  return out.sort((a,b)=>a.date.localeCompare(b.date)||a.ord-b.ord);
}
/** Quantity, value and average cost after replaying the movements up to (and including) a date. */
function stockAt(itemId,date,except){
  let qty=0,value=0;const it=invItem(itemId);let last=it&&+it.cost||0;
  for(const m of stockMoves(itemId,except)){if(date&&m.date>date)break;
    if(m.sale){const avg=qty>0?value/qty:last;const c=m.posted!=null?(m.qty<0?-m.posted:+m.posted):r2(avg*m.qty);qty+=m.qty;value+=c}
    else{qty+=m.qty;value+=m.cost;if(m.qty>0&&m.cost>0)last=m.cost/m.qty}
    if(Math.abs(qty)<1e-9)value=0;}
  return{qty:Math.round(qty*10000)/10000,value:r2(value),avg:qty>0?value/qty:last};
}
/** Set the cost on each inventory line of a sale or credit note (c from calcLines), before it's posted. */
function invCosts(kind,c,date,docId){
  if(!['invoice','sreceipt','credit'].includes(kind))return;
  const lowOn=[];
  for(const l of c.ls){const it=invItem(l.item);if(!it){delete l.cost;continue}
    const st=stockAt(it.id,date,docId);l.cost=r2(st.avg*(+l.qty||0));
    if(kind!=='credit'&&st.qty<(+l.qty||0))lowOn.push(it.name)}
  if(lowOn.length&&typeof toast==='function')toast(`More than what’s on hand: ${lowOn.join(', ')}. The sale is saved; record the purchase or a count to correct the quantity.`,true);
}
/** The ledger lines that move the cost of inventory sold (or returned) between the asset and cost of goods sold. */
function invCostLines(kind,ls){
  const g={};
  for(const l of ls){const it=invItem(l.item);if(!it||!+l.cost)continue;const k=it.cogsAccount+'|'+it.assetAccount;g[k]=r2((g[k]||0)+(+l.cost))}
  const out=[];
  for(const[k,v]of Object.entries(g)){const[cogs,asset]=k.split('|');
    if(kind==='credit')out.push({account:asset,debit:v,credit:0,memo:'Inventory returned'},{account:cogs,debit:0,credit:v,memo:'Inventory returned'});
    else out.push({account:cogs,debit:v,credit:0,memo:'Cost of goods sold'},{account:asset,debit:0,credit:v,memo:'Cost of goods sold'})}
  return out;
}

/* ---------- adjustments and the valuation report ---------- */
function invAdjustForm(itemId){
  const items=S.items.filter(i=>i.type==='inventory'&&i.active!==false).sort((a,b)=>a.name.localeCompare(b.name));
  if(!items.length){toast('Add an inventory item first.',true);return}
  const adjDef=(sortAccts(S.accounts.filter(a=>(a.type==='Cost of Goods Sold'||a.type==='Expense')&&/shrink|adjust|écart|perte|inventory|stock/i.test(a.name)))[0]||sortAccts(S.accounts.filter(a=>a.type==='Cost of Goods Sold'))[0]||{}).id||'';
  const f=openModal('Adjust inventory',`<div class="fields">
    ${fld('iaItem','Item',`<select id="iaItem">${items.map(i=>`<option value="${esc(i.id)}" ${i.id===itemId?'selected':''}>${esc(i.name)}</option>`).join('')}</select>`)}
    ${fld('iaDate','Date',`<input type="date" id="iaDate" value="${esc(today())}">`)}
    ${fld('iaNew','New quantity on hand (from your count)',`<input type="number" id="iaNew" step="any">`)}
    ${fld('iaCost','Cost of units added (only if the count is higher)',`<input type="number" id="iaCost" step="0.01" min="0">`)}
    ${fld('iaAcct','Adjustment account',`<select id="iaAcct">${acctOptions(adjDef,a=>a.type==='Cost of Goods Sold'||a.type==='Expense')}</select>`)}
    ${fld('iaMemo','Reason',`<input type="text" id="iaMemo" maxlength="200" placeholder="${esc(T('e.g. Year-end count, damaged stock'))}">`,true)}</div><div data-iainfo class="muted" style="font-size:13px"></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save adjustment</button>`);
  const info=()=>{const it=invItem($('#iaItem',f).value),st=stockAt(it.id,$('#iaDate',f).value||today());const nq=$('#iaNew',f).value;const ch=nq===''?0:+nq-st.qty;
    if(!$('#iaCost',f).value&&ch>0)$('#iaCost',f).placeholder=(st.avg*ch).toFixed(2);
    $('[data-iainfo]',f).innerHTML=`<span>On hand on that date:</span> <b>${st.qty}</b> · <span>average cost</span> <b>${money(st.avg)}</b>${nq!==''?` · <span>change</span> <b class="${ch<0?'neg':''}">${ch>0?'+':''}${Math.round(ch*10000)/10000}</b> · <span>value</span> <b>${money(ch<0?r2(st.avg*ch):+$('#iaCost',f).value||r2(st.avg*ch))}</b>`:''}`};
  f.addEventListener('input',info);f.addEventListener('change',info);info();
  f.onsubmit=async e=>{e.preventDefault();f.err('');const it=invItem($('#iaItem',f).value),date=$('#iaDate',f).value||today(),st=stockAt(it.id,date);
    if($('#iaNew',f).value==='')return f.err('Enter the quantity you counted.');
    const ch=Math.round((+$('#iaNew',f).value-st.qty)*10000)/10000;if(!ch)return f.err('That’s already the quantity on hand.');
    const value=ch<0?r2(st.avg*ch):r2(+$('#iaCost',f).value||st.avg*ch);const adj=$('#iaAcct',f).value;if(!adj)return f.err('Choose the adjustment account.');
    const v=Math.abs(value),lines=value>=0?[{account:it.assetAccount,debit:v,credit:0},{account:adj,debit:0,credit:v}]:[{account:adj,debit:v,credit:0},{account:it.assetAccount,debit:0,credit:v}];
    if(!v)return f.err('The adjustment has no value. Enter the cost of the units added.');
    if(await put('entries',uid(),{type:'invadjust',date,ref:'',memo:`${it.name}: ${ch>0?'+':''}${ch}${$('#iaMemo',f).value.trim()?' · '+$('#iaMemo',f).value.trim():''}`,inv:{item:it.id,qty:ch,value},lines,created:Date.now()})){closeModal();toast('Inventory adjusted')}};
}
function rInventoryValuation(){
  const to=S.rep.to||today(),items=S.items.filter(i=>i.type==='inventory').sort((a,b)=>a.name.localeCompare(b.name));
  const rows=items.map(i=>({i,st:stockAt(i.id,to)})).filter(x=>x.st.qty||x.st.value);
  const tot=r2(rows.reduce((s,x)=>s+x.st.value,0));
  const accts=[...new Set(items.map(i=>i.assetAccount))],ledger=r2(accts.reduce((s,a)=>s+bal(a,null,to),0));
  const csv=[['Item','SKU','Quantity','Average cost','Value'],...rows.map(x=>[x.i.name,x.i.sku||'',x.st.qty,r2(x.st.avg),x.st.value]),['Total','','','',tot]];
  return{html:`<div class="report" style="max-width:none">${rh(esc(T('Inventory valuation')),`${T('As of')} ${fmtDate(to)} · ${T('average cost')}`)}<div class="tbl-wrap"><table><thead><tr><th>Item</th><th>SKU</th><th class="n">On hand</th><th class="n">Average cost</th><th class="n">Value</th></tr></thead><tbody>${rows.map(x=>`<tr><td><button class="link" data-item="${esc(x.i.id)}" translate="no">${esc(x.i.name)}</button></td><td class="mono muted">${esc(x.i.sku||'')}</td><td class="n ${x.st.qty<0?'neg':''}">${x.st.qty}</td><td class="n">${money(x.st.avg)}</td><td class="n">${money(x.st.value)}</td></tr>`).join('')||`<tr><td colspan="5" class="muted" style="padding:16px">${T('No inventory on hand.')}</td></tr>`}</tbody>${rows.length?`<tfoot><tr class="grand"><td colspan="4">Total</td><td class="n">${money(tot)}</td></tr></tfoot>`:''}</table></div>
    <div class="muted" style="font-size:12.5px;padding:10px 12px"><span>${T('Inventory asset account balance on that date:')}</span> <b>${money(ledger)}</b>${Math.abs(ledger-tot)>=0.01?` · <span class="neg">${T('differs by')} ${money(r2(ledger-tot))}</span> <span>${T('(an opening value not in the books, or an entry to the account outside bills, sales and adjustments).')}</span>`:''}</div></div>`,
    csv,name:`inventory-valuation_${to}`};
}
