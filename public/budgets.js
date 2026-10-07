'use strict';
/* ---------- Budgets ----------
   A budget is an amount for each income and expense account in each month of one fiscal year.
   Reports → Budget vs actual compares it with the books for any period inside that year. */

const BUDGET_TYPES=['Income','Cost of Goods Sold','Expense'];
const budgetAccts=()=>sortAccts(S.accounts.filter(a=>BUDGET_TYPES.includes(a.type)&&(a.active!==false)));
const budgetMonths=start=>Array.from({length:12},(_,i)=>{const d=pd(start);return iso(new Date(d.getFullYear(),d.getMonth()+i,1))});
const budgetFor=id=>S.budgets.find(b=>b.id===id);
/** The budget the report uses: the one picked, or the newest for the fiscal year of the report's end date. */
function currentBudget(){
  const b=budgetFor(S.rep.budget);if(b)return b;
  const fy=fyStartOf(S.rep.to||today());
  return S.budgets.filter(x=>x.start===fy).sort((a,b)=>(b.created||0)-(a.created||0))[0]||S.budgets.slice().sort((a,b)=>b.start.localeCompare(a.start))[0]||null;
}
/** Budgeted amount for an account over [from, to], counting each budget month that falls in the period. */
function budgetAmount(b,acctId,from,to){
  const m=b.amounts[acctId];if(!m)return 0;const ms=budgetMonths(b.start),f=from.slice(0,7),t=to.slice(0,7);
  return r2(ms.reduce((s,x,i)=>x.slice(0,7)>=f&&x.slice(0,7)<=t?s+(+m[i]||0):s,0));
}

function rBudgetVsActual(){
  const b=currentBudget(),{from,to}=S.rep;
  if(!b)return{html:`<div class="empty"><b>No budget yet</b>Make a budget for the fiscal year, then compare it with your actual income and expenses here.${ME&&ME.role!=='client'&&!ME.readOnly?'<div style="margin-top:14px"><button class="btn primary" data-budget="new">+ New budget</button></div>':''}</div>`,csv:[['Budget vs actual'],['No budget yet']],name:'budget-vs-actual',title:'Budget vs actual',sub:'',head:[],rows:[]};
  const bEnd=budgetEnd(b.start);
  const f=from<b.start?b.start:from,t=to>bEnd?bEnd:to;
  if(f>t)return{html:`<div class="empty"><b>${esc(b.name)} is for ${esc(fmtDate(b.start))} – ${esc(fmtDate(bEnd))}</b>Pick dates in that fiscal year, or another budget.</div>`,csv:[['Budget vs actual'],['No overlap with the budget’s year']],name:'budget-vs-actual',title:'Budget vs actual',sub:'',head:[],rows:[]};
  const rows=[],z=[0,0];
  const sec=(type,title)=>{
    const as=sortAccts(S.accounts.filter(a=>a.type===type)).map(a=>({a,vals:[fbal(a.id,f,t),budgetAmount(b,a.id,f,t)]})).filter(x=>x.vals.some(v=>Math.abs(v)>=0.005));
    if(!as.length)return null;
    const tot=[0,1].map(i=>r2(as.reduce((s,x)=>s+x.vals[i],0)));
    rows.push({cls:'sec',label:title});
    as.forEach(x=>rows.push({cls:'item',label:(x.a.code?x.a.code+' ':'')+x.a.name,vals:x.vals,acct:x.a.id}));
    rows.push({cls:'tot',label:W('Total '+title.toLowerCase()),vals:tot});
    return tot;
  };
  const inc=sec('Income',W('Income'))||z,cogs=sec('Cost of Goods Sold','Cost of goods sold')||z,exp=sec('Expense','Expenses')||z;
  rows.push({cls:'spacer'},{cls:'grand',label:W('Net income'),vals:[0,1].map(i=>r2(inc[i]-cogs[i]-exp[i]))});
  const clipped=f!==from||t!==to;
  const cl=repCls(),cn=cl==='__none'?T('No class'):cl?clsName(cl):'';
  const r=colReport({title:`Budget vs actual · ${b.name}${cn?` · ${cn}`:''}`,sub:`${fmtDate(f)} – ${fmtDate(t)}${clipped?' · '+T('limited to the budget’s fiscal year'):''}`,C:{cols:[{label:'Actual'},{label:'Budget'}],change:true,changeLabels:['Over or under budget','% over or under']},rows,name:`budget-vs-actual_${f}_${t}`});
  return r;
}
function budgetToolbar(){
  if(S.rep.tab!=='bva')return '';
  const cur=currentBudget(),staff=ME&&ME.role!=='client'&&!ME.readOnly;
  return `${S.budgets.length?`<label class="flabel" for="repBudget">Budget</label><select id="repBudget">${S.budgets.slice().sort((a,b)=>b.start.localeCompare(a.start)||a.name.localeCompare(b.name)).map(x=>`<option value="${esc(x.id)}" ${cur&&cur.id===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select>`:''}${staff?`${cur?'<button class="btn sm" data-budget="edit">Edit budget</button>':''}<button class="btn sm" data-budget="new">+ New budget</button>`:''}`;
}
const budgetEnd=start=>addDays(iso(new Date(pd(start).getFullYear()+1,pd(start).getMonth(),1)),-1);
/** Show the report for the budget's fiscal year, unless the period already falls inside it. */
function showBudgetYear(start){const R=S.rep,end=budgetEnd(start);if(R.from>=start&&R.to<=end&&R.from<=R.to)return;R.period=start===fyStartOf(today())?'fy':'custom';R.from=start;R.to=end}
function bindBudgetToolbar(m){const s=$('#repBudget',m);if(s)s.onchange=()=>{S.rep.budget=s.value;const b=budgetFor(s.value);if(b)showBudgetYear(b.start);renderMain()}}

function budgetForm(b){
  const fy=fyStartOf(today()),years=[addDays(iso(new Date(pd(fy).getFullYear()-1,pd(fy).getMonth(),1)),0),fy,iso(new Date(pd(fy).getFullYear()+1,pd(fy).getMonth(),1))];
  const d=b||{name:'',start:fy,amounts:{}};
  const accts=budgetAccts().concat(sortAccts(S.accounts.filter(a=>BUDGET_TYPES.includes(a.type)&&a.active===false&&d.amounts[a.id])));
  const yearLabel=s=>`${fmtDate(s)} – ${fmtDate(addDays(iso(new Date(pd(s).getFullYear()+1,pd(s).getMonth(),1)),-1))}`;
  const mLabel=s=>pd(s).toLocaleDateString(LOC(),{month:'short'});
  const grid=start=>{const ms=budgetMonths(start);let cur='';
    return `<div class="tbl-wrap budget-grid"><table><thead><tr><th>Account</th>${ms.map(m=>`<th class="n">${esc(mLabel(m))}</th>`).join('')}<th class="n">Year</th><th></th></tr></thead><tbody>${accts.map(a=>{const v=d.amounts[a.id]||[];const hd=a.type!==cur?(cur=a.type,`<tr class="sec"><td>${esc(T(a.type==='Cost of Goods Sold'?'Cost of goods sold':a.type==='Income'?W('Income'):'Expenses'))}</td><td colspan="14"></td></tr>`):'';
      return hd+`<tr data-bacct="${a.id}"><td class="trunc" translate="no" title="${esc(a.name)}">${esc((a.code?a.code+' ':'')+a.name)}</td>${ms.map((m,i)=>`<td><input type="number" step="0.01" inputmode="decimal" data-bm="${i}" value="${v[i]?esc(v[i]):''}" aria-label="${esc(a.name)} ${esc(mLabel(m))}"></td>`).join('')}<td class="n" data-btot></td><td><button type="button" class="btn sm ghost" data-bfill title="Copy the first month to every month">→</button></td></tr>`}).join('')}</tbody></table></div>`};
  const f=openModal(b?`Budget: ${b.name}`:'New budget',`<div class="fields">${fld('bgName','Name',`<input type="text" id="bgName" maxlength="80" value="${esc(d.name)}" placeholder="${esc(T('e.g. 2026 operating budget'))}">`)}${fld('bgYear','Fiscal year',`<select id="bgYear" ${b?'disabled':''}>${[...new Set([...years,d.start])].sort().map(y=>`<option value="${y}" ${y===d.start?'selected':''}>${esc(yearLabel(y))}</option>`).join('')}</select>`)}</div>
    <div class="actions" style="justify-content:flex-start;margin:4px 0 8px"><button type="button" class="btn sm" data-bfrom="actual">Fill from last year’s actuals</button><span class="muted" style="font-size:12.5px">Type a monthly amount in the first month, then → to copy it across.</span></div>
    <div data-bgrid>${grid(d.start)}</div><div class="budget-sum" data-bsum></div>`,`${b?'<button type="button" class="btn danger left" data-del>Delete</button>':'<span class="left"></span>'}<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save budget</button>`,'wide xwide');
  const read=()=>{const o={};$$('[data-bacct]',f).forEach(tr=>{const v=$$('[data-bm]',tr).map(i=>i.value===''?0:r2(+i.value||0));if(v.some(x=>x))o[tr.dataset.bacct]=v});return o};
  const sums=()=>{let inc=0,out=0;$$('[data-bacct]',f).forEach(tr=>{const t=r2($$('[data-bm]',tr).reduce((s,i)=>s+(+i.value||0),0));$('[data-btot]',tr).textContent=t?money(t):'';const a=acct(tr.dataset.bacct);if(a.type==='Income')inc+=t;else out+=t});
    $('[data-bsum]',f).innerHTML=`<span>Income</span> <b>${money(inc)}</b> · <span>Expenses</span> <b>${money(out)}</b> · <span>Net income</span> <b class="${inc-out<0?'neg':''}">${money(r2(inc-out))}</b>`};
  f.addEventListener('input',sums);sums();
  f.addEventListener('click',e=>{const b2=e.target.closest('[data-bfill]');if(!b2)return;const ins=$$('[data-bm]',b2.closest('tr'));ins.forEach(i=>i.value=ins[0].value);sums()});
  $('[data-bfrom]',f).onclick=()=>{const start=$('#bgYear',f).value,ms=budgetMonths(start).map(m=>iso(new Date(pd(m).getFullYear()-1,pd(m).getMonth(),1)));
    $$('[data-bacct]',f).forEach(tr=>{const id=tr.dataset.bacct;$$('[data-bm]',tr).forEach((i,k)=>{const v=fbal(id,ms[k],monthEnd(pd(ms[k]).getFullYear(),pd(ms[k]).getMonth()+1));i.value=Math.abs(v)>=0.005?v.toFixed(2):''})});sums();toast('Filled from last year. Adjust any month.')};
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this budget?','Only the budget is deleted. Your books don’t change.','Delete'))return;if(await del('budgets',b.id)){if(S.rep.budget===b.id)S.rep.budget='';closeModal();toast('Budget deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');const name=$('#bgName',f).value.trim();if(!name)return f.err('Give the budget a name.');
    const id=b?b.id:uid(),start=b?b.start:$('#bgYear',f).value;
    if(await put('budgets',id,{name,start,amounts:read(),created:b?.created||Date.now()})){S.rep.budget=id;showBudgetYear(start);closeModal();toast('Budget saved')}};
}
