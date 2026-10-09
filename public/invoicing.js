'use strict';
/* ---------- Monthly invoices to the firms and clients using this server ----------
   For a server administrator who is paid by e-Transfer (or cheque, or anything but Stripe).
   The administrator picks one of their own companies to bill from. From the 1st of each month, the first time
   that company is opened, Sumlora makes one invoice per firm for its companies on its plan, plus the AI assistant
   add-on, and one per company whose client pays for themselves. Each customer gets one invoice a month, never two.
   The invoices are ordinary invoices: review them, email them, and record the e-Transfer as a payment. */
let INVSET=null,slAsked=false,slBusy=false;
const slMonth=()=>today().slice(0,7);
function slMonthName(m){const d=new Date(+m.slice(0,4),+m.slice(5,7)-1,1);const s=d.toLocaleDateString(document.documentElement.lang||'en-CA',{month:'long',year:'numeric'});return s.charAt(0).toUpperCase()+s.slice(1)}
const slCents=c=>(+c||0)/100;
const slPlanLabel=(set,plan)=>T(((set.plans||{})[plan]||{label:plan}).label);
/** How many of a customer's companies have each add-on (the AI assistant, the scrap yard tools…). */
const slAddons=cu=>({...(cu.assistant?{assistant:cu.assistant}:{}),...(cu.addons||{})});
const slAddonLabel=(set,k)=>T(((set.addons||TallyPlans.ADDONS)[k]||{label:k}).label);
/** Before tax: the plan for each company, and each add-on for the companies that have it. */
function slAmount(set,cu){return r2(cu.companies*slCents(set.amounts[cu.plan])+Object.entries(slAddons(cu)).reduce((t,[k,n])=>t+(+n||0)*slCents(set.amounts[k]),0))}
const slDocId=(cu,m)=>('sl_'+cu.key+'_'+m).replace(/[^A-Za-z0-9_.@+~-]/g,'_').slice(0,120);

async function loadInvoicing(){try{INVSET=await api('GET','/api/invoicing')}catch(e){INVSET=null}return INVSET}

/** The income account the invoices go to, added the first time. */
async function slIncomeAccount(){
  const name='Sumlora subscriptions';
  let a=S.accounts.find(x=>x.type==='Income'&&x.name===name);if(a)return a.id;
  const used=new Set(S.accounts.map(x=>x.code));let code='4050';for(let n=4050;n<4100;n++)if(!used.has(String(n))){code=String(n);break}
  const id=uid();if(!await put('accounts',id,{name,type:'Income',detail:'',code,desc:'Monthly Sumlora subscriptions billed to firms and clients',created:Date.now()}))throw new Error('Couldn’t add the Sumlora subscriptions account.');
  await load();return id;
}

/** Make this month's invoices that aren't made yet. auto: on opening the company (quiet when there's nothing to do). */
async function slRunDue(auto){
  if(slBusy||!CO||!ME||ME.role!=='owner'||!ME.platformAdmin)return;
  const set=await loadInvoicing();if(!set||!set.companyId||CO!==set.companyId)return;
  const asked=slAsked;slAsked=false;
  slBusy=true;
  try{
    await load();
    const m=slMonth(),date=m+'-01',label=slMonthName(m);
    if(S.company.closingDate&&date<=S.company.closingDate){if(asked)toast(`The books are closed for ${label}, so its invoices can’t be made.`,true);return}
    const todo=set.customers.filter(cu=>cu.companies>0&&!S.docs.some(d=>d.id===slDocId(cu,m)));
    if(!todo.length){if(asked){toast(`${label} invoices are already made.`);go('sales')}return}
    const ar=byDetail('ar');if(!ar){toast('Add an Accounts receivable account first, then open this company again.',true);return}
    const parts=taxParts();if(set.tax&&parts.some(p=>!p.account)){toast(`Add a “${parts.find(p=>!p.account).name} payable” account first, then open this company again.`,true);return}
    const income=await slIncomeAccount();
    const terms=+S.company.terms||0,tc=set.tax?'std':'none';
    let num=parseInt(nextNum('invoice'))||1001,made=0;const errs=[];
    for(const cu of todo){
      const id=slDocId(cu,m),lines=[{desc:`Sumlora ${slPlanLabel(set,cu.plan)}, ${label}: ${cu.companies} ${cu.companies===1?'company':'companies'}`,account:income,qty:cu.companies,rate:slCents(set.amounts[cu.plan]),taxCode:tc}];
      for(const[k,n]of Object.entries(slAddons(cu)))if(n>0)lines.push({desc:`${slAddonLabel(set,k)} add-on, ${label}: ${n} ${n===1?'company':'companies'}`,account:income,qty:n,rate:slCents(set.amounts[k]),taxCode:tc});
      const c=calcLines(lines,x=>(+x.qty||0)*(+x.rate||0),false);
      // The customer: the one made for this firm before, or a new one.
      const writes=[];let ct=S.contacts.find(x=>x.kind==='customer'&&x.sumlora===cu.key);
      if(!ct){ct={id:uid(),name:cu.name,kind:'customer',email:cu.email||'',notes:cu.person?`Contact: ${cu.person}`:'',sumlora:cu.key,created:Date.now()};writes.push({op:'set',collection:'contacts',id:ct.id,data:strip(ct)})}
      const number=String(num),created=Date.now(),memo=`Sumlora subscription for ${label}. Thank you!`;
      const base={date,contactId:ct.id,memo};
      const doc={...base,kind:'invoice',number,due:addDays(date,terms),...docRecord(c),sumlora:{key:cu.key,month:m},recurringNew:true,created};
      writes.push({op:'set',collection:'docs',id,data:doc},{op:'set',collection:'entries',id:'d_'+id,data:{...base,type:'invoice',ref:number,docId:id,lines:docPostLines('invoice',c,ar.id),created}});
      // Saved one customer at a time; a second copy (another window made it just now) is refused, and skipped.
      try{await api('POST','/api/batch',{writes:writes.map(x=>({...x,data:strip(x.data)}))});made++;num++}
      catch(e){if(e.status!==409)errs.push(`${cu.name}: ${e.message}`)}
    }
    await load();
    if(made){S.sales.tab='docs';go('sales');toast(`Made ${made} invoice${made===1?'':'s'} for ${label}. Review them, then email them from each invoice.`)}
    if(errs.length)toast(errs[0],true);
  }catch(e){toast(e.message,true)}
  finally{slBusy=false}
}

// Opening a company also makes this month's invoices when it's the billing company.
if(typeof salesOnOpen==='function'){const prev=salesOnOpen;salesOnOpen=async function(id){await prev(id);if(CO===id)await slRunDue(true)}}

/* ---------- Firms page: the administrator's settings and this month's figures ---------- */
function invoicingPanel(){
  const s=INVSET;if(!s)return '';
  const m=slMonth(),label=slMonthName(m),list=s.customers.filter(cu=>cu.companies>0),idle=s.customers.filter(cu=>!cu.companies);
  const tot=list.reduce((t,cu)=>t+slAmount(s,cu),0);
  const co=s.companies.find(c=>c.id===s.companyId);
  return `<div class="panel" style="margin-bottom:16px"><h3>Monthly invoices to firms and clients</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="muted" style="font-size:13px">For customers who pay you by e-Transfer. From the 1st of each month, the first time you open the company below, Sumlora makes one invoice for each firm (its companies on its plan, plus any add-ons, like the AI assistant or the scrap yard tools) and for each company whose client pays for themselves. Each gets one invoice a month. Review the invoices, email them, and record each e-Transfer as a payment. Prices come from the Subscriptions settings.</div>
    <div class="fields">
      ${fld('slCo','Bill from this company',`<select id="slCo"><option value="">Choose…</option>${s.companies.map(c=>`<option value="${esc(c.id)}" ${c.id===s.companyId?'selected':''} translate="no">${esc(c.name)}</option>`).join('')}</select><span class="hint">${s.companies.length?'Your own business’s books in Sumlora. The invoices, customers and income go here.':'Add your own business as a company first.'}</span>`)}
      <div class="field"><label class="check" style="margin-top:24px"><input type="checkbox" id="slTax" ${s.tax?'checked':''}> <span>Charge sales tax on the invoices</span></label><span class="hint">The company’s own rate (${co?'set in its Settings':'GST/HST, or GST and QST'}). Leave off if you aren’t registered.</span></div>
    </div>
    <div class="actions"><button class="btn" data-slsave>Save</button>${s.companyId?`<button class="btn primary" data-slopen>Make ${esc(label)} invoices</button>`:''}</div>
    <h3 class="fsec" style="margin:4px 0 0">${esc(label)}: what each customer owes</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Customer</th><th>Email</th><th>Plan</th><th class="n">Companies</th><th class="n">Add-ons</th><th class="n">Before tax</th></tr></thead><tbody>
      ${list.length?list.map(cu=>`<tr><td><b translate="no">${esc(cu.name)}</b>${cu.key.startsWith('co:')?' <span class="pill quiet">Client pays</span>':''}</td><td class="mono" style="font-size:12.5px" translate="no">${esc(cu.email||'—')}</td><td>${esc(slPlanLabel(s,cu.plan))}</td><td class="n">${cu.companies}</td><td class="n">${Object.entries(slAddons(cu)).filter(([,n])=>n>0).map(([k,n])=>`${esc(slAddonLabel(s,k))}: ${n}`).join('<br>')||'—'}</td><td class="n">${money(slAmount(s,cu))}</td></tr>`).join('')+`<tr><td colspan="5"><b>Total</b></td><td class="n"><b>${money(tot)}</b></td></tr>`:emptyRow(6,'No one to bill yet','Firms you invite show here once they add companies.')}
    </tbody></table></div>
    ${idle.length?`<div class="muted" style="font-size:12.5px"><span>No companies yet, so not billed:</span> <span translate="no">${idle.map(cu=>esc(cu.name)).join(', ')}</span></div>`:''}
  </div></div>`;
}
async function invoicingAction(b){
  if(b.hasAttribute('data-slsave')){
    try{await api('PUT','/api/invoicing',{companyId:$('#slCo').value,tax:$('#slTax').checked});await loadInvoicing();renderMain();toast('Saved')}catch(ex){toast(ex.message,true)}
    return true;
  }
  if(b.hasAttribute('data-slopen')){
    if(!INVSET||!INVSET.companyId)return true;
    if(typeof loadCompanies==='function'&&!CO_LIST.some(c=>c.id===INVSET.companyId))await loadCompanies();
    slAsked=true;
    if(CO===INVSET.companyId){S.view='sales';await slRunDue(false)}else await openCompany(INVSET.companyId,'sales');
    return true;
  }
  return false;
}
