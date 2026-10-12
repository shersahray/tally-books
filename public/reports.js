'use strict';
/* ---------- Reports: comparisons, cash flow, saved reports, PDFs and report packages, reconciliation reports ----------
 * The profit and loss, balance sheet and cash flow statement can show one period or several side by side:
 * the previous period, the same period last year, or each month or quarter. Every report returns
 * { html, csv, name, title, sub, head, rows } so it can be shown, exported to CSV, or drawn into a PDF. */

/* Fast sums: each account's postings by date with running totals, so many columns stay quick. */
let RIX=null;
/** The class the P&L (or budget vs actual) is filtered to: '' all, '__none' transactions without a class. */
const repCls=()=>['pl','bva'].includes(S.rep.tab)&&(S.company.classes||[]).length&&!(S.rep.tab==='pl'&&S.rep.compare==='byclass')?S.rep.cls||'':'';
/* Accrual or cash basis (cashbasis.js). The Reports page's choice, else the company's default. Only the reports
   below change; everything else (trial balance, aging, sales tax, budgets…) stays on the books' accrual basis. */
const BASIS_TABS=['pl','bs','cf','gl','sc','ev','tl','tg'];
const basisChoice=()=>(S.rep.basis||S.company.reportBasis)==='cash'?'cash':'accrual';
const repBasis=()=>BASIS_TABS.includes(S.rep.tab)&&basisChoice()==='cash'?'cash':'accrual';
/** " · Cash basis" for a report's subtitle (the French has the whole subtitle as a key, e.g. "As of {0} · Cash basis"). */
const basisSub=()=>repBasis()==='cash'?' · Cash basis':'';
let CPS=null;
/** The postings a report adds up: the ledger as it is, or on the cash basis. Cached until the books change. */
function repPostings(){
  const ps=postings();if(repBasis()!=='cash'||typeof TallyCash==='undefined')return ps;
  if(CPS&&CPS.src===ps)return CPS.out;
  const ctl=new Set(S.accounts.filter(a=>a.detail==='ar'||a.detail==='ap').map(a=>a.id));
  CPS={src:ps,out:TallyCash.cashPostings(S.entries,S.docs,ctl)};return CPS.out;
}
/* ---------- filters (report-filters.js): by customer, vendor, account, class (and tag, once transactions have tags) ----------
   They stack with the period, comparison, class and accounting method. The balance sheet, cash flow and trial
   balance aren't filtered: part of the books doesn't balance. */
const FILTER_TABS=['pl','gl','sc','ev','tl'];
/** The filter on the report on screen, or null. A P&L by class has its own class columns, so it ignores a class filter. */
function repFilter(){
  // Only on the Reports page: a reconciliation report opened from Banking adds up the whole account.
  if(!FILTER_TABS.includes(S.rep.tab)||typeof TallyRepFilter==='undefined'||(S.view&&S.view!=='reports'))return null;
  return S.rep.tab==='pl'&&S.rep.compare==='byclass'?TallyRepFilter.without(S.rep.flt,'cls'):TallyRepFilter.clean(S.rep.flt);
}
/** What the filters need to know about names: customer or vendor, and each project's customer. */
function rfCtx(){
  const k=new Map(S.contacts.map(c=>[c.id,c.kind||''])),pc=new Map((S.projects||[]).map(p=>[p.id,p.contactId||'']));
  return{kind:id=>k.get(id)||'',projCust:id=>pc.get(id)||''};
}
let FPS=null;
/** The report's postings with its filter applied. One cached list per filter, until the books change. */
function repPostingsF(){
  const ps=repPostings(),f=repFilter();if(!f)return ps;
  const key=TallyRepFilter.key(f);if(!FPS||FPS.src!==ps)FPS={src:ps,by:new Map()};
  let out=FPS.by.get(key);if(!out){out=TallyRepFilter.apply(ps,f,rfCtx());FPS.by.set(key,out)}
  return out;
}
const filtSub=()=>repFilter()?' · Filtered':'';
/** Running sums for one class ('' = every transaction, '__none' = those without a class) and, for a P&L by customer,
    one customer column (an id, '__none', or a list of ids for "Other customers"), on the report's basis and filter.
    One cache per class, customer and filter, so a report with a column for each stays quick. `cls` left out = the report's class filter. */
function rix(cls,cust){
  if(cls===undefined)cls=repCls();
  const ps=repPostingsF(),hasC=cust!==undefined&&cust!=='',key=`${cls}|${hasC?TallyRepFilter.custKey(cust):''}`;
  if(!RIX||RIX.ps!==ps)RIX={ps,by:new Map()};
  const hit=RIX.by.get(key);if(hit)return hit;
  const m=new Map(),ct=hasC?TallyRepFilter.custTest(cust,rfCtx()):null;
  for(const p of ps){if(cls&&(cls==='__none'?!!p.e.cls:p.e.cls!==cls))continue;if(ct&&!ct(p.e))continue;let a=m.get(p.account);if(!a)m.set(p.account,a=[]);a.push([p.date,p.debit-p.credit])}
  for(const a of m.values()){a.sort((x,y)=>x[0]<y[0]?-1:x[0]>y[0]?1:0);let c=0;a.cum=a.map(x=>c+=x[1])}
  const out={m,cls};RIX.by.set(key,out);return out;
}
const firstOnOrAfter=(a,d)=>{let lo=0,hi=a.length;while(lo<hi){const mid=(lo+hi)>>1;if(a[mid][0]<d)lo=mid+1;else hi=mid}return lo};
function rawSum(id,from,to,cls,cust){
  const a=rix(cls,cust).m.get(id);if(!a||!a.length)return 0;
  const i=from?firstOnOrAfter(a,from):0,j=to?firstOnOrAfter(a,to+'~'):a.length;
  return r2((j>0?a.cum[j-1]:0)-(i>0?a.cum[i-1]:0));
}
function fbal(id,from,to,cls,cust){const a=acct(id),r=rawSum(id,from,to,cls,cust);return a&&!debitNormal(a.type)?r2(-r):r}
function fNet(from,to){let n=0;for(const a of S.accounts){if(a.type==='Income')n+=fbal(a.id,from,to);else if(a.type==='Expense'||a.type==='Cost of Goods Sold')n-=fbal(a.id,from,to)}return r2(n)}

/* ---------- periods and columns ---------- */
const isMonthEnd=d=>d===monthEnd(+d.slice(0,4),+d.slice(5,7));
const monthLabel=(d,o={month:'short',year:'numeric'})=>pd(d).toLocaleDateString(LOC(),o);
/** Move a period by whole months, keeping month-ends at month-ends. */
function shiftMonths(d,n){const x=pd(d);if(isMonthEnd(d))return iso(new Date(x.getFullYear(),x.getMonth()+1+n,0));const y=new Date(x.getFullYear(),x.getMonth()+n,1);return iso(new Date(y.getFullYear(),y.getMonth(),Math.min(x.getDate(),new Date(y.getFullYear(),y.getMonth()+1,0).getDate())))}
function monthsSpan(from,to){if(!from.endsWith('-01')||!isMonthEnd(to))return null;return(+to.slice(0,4)-+from.slice(0,4))*12+(+to.slice(5,7)-+from.slice(5,7))+1}
function prevPeriod(from,to){const n=monthsSpan(from,to);if(n)return[shiftMonths(from,-n),addDays(from,-1)];const len=daysBetween(from,to)+1;return[addDays(from,-len),addDays(from,-1)]}
function rangeLabel(from,to){
  const n=monthsSpan(from,to);
  if(n===1)return monthLabel(from);
  if(n&&from.slice(0,4)===to.slice(0,4))return `${monthLabel(from,{month:'short'})} – ${monthLabel(to)}`;
  if(n)return `${monthLabel(from)} – ${monthLabel(to)}`;
  return `${fmtDate(from)} – ${fmtDate(to)}`;
}
const PL_COMPARE=[['','No comparison'],['prev','Previous period'],['prevyear','Same period last year'],['months','By month'],['quarters','By quarter'],['byclass','By class'],['bycustomer','By customer']];
/** Columns in a P&L by customer: the customers with the most sales, then the rest together, so it stays readable. */
const PL_TOP_CUSTOMERS=8;
const BS_COMPARE=[['','No comparison'],['prevmonth','End of the previous month'],['prevyear','One year earlier'],['months','Each month-end this fiscal year']];
/** Columns for a period report: [{label, from, to}], plus whether to add Total or change columns. */
function periodCols(from,to,cmp){
  const base={label:rangeLabel(from,to),from,to};
  if(cmp==='prev'){const[a,b]=prevPeriod(from,to);return{cols:[base,{label:rangeLabel(a,b),from:a,to:b}],change:true}}
  if(cmp==='prevyear'){const a=shiftMonths(from,-12),b=shiftMonths(to,-12);return{cols:[base,{label:rangeLabel(a,b),from:a,to:b}],change:true}}
  if(cmp==='byclass'){
    // One column for each class (active ones, and inactive ones with activity in the period), then No class and Total.
    const cs=S.company.classes||[];
    if(!cs.length)return{cols:[base]};
    const has=c=>S.accounts.some(a=>['Income','Expense','Cost of Goods Sold'].includes(a.type)&&Math.abs(rawSum(a.id,from,to,c))>=0.005);
    const cols=cs.filter(c=>c.active!==false||has(c.id)).map(c=>({label:c.name,from,to,cls:c.id,data:true}));
    if(has('__none'))cols.push({label:clsWords().none,from,to,cls:'__none'});
    if(cols.length>36)return{error:'That’s too many columns. Turn off classes you no longer use.'};
    return{cols,total:true};
  }
  if(cmp==='bycustomer'){
    // A column for each of the top customers, then Other customers, Not specified (no customer or project) and Total.
    // Income goes to the invoice's or sales receipt's customer; a bill, expense or journal entry goes to a customer
    // through its project, else to Not specified. The Total column adds them up, so it's the whole profit and loss.
    const ty=new Map(S.accounts.map(a=>[a.id,a.type]));
    const rk=TallyRepFilter.rankCustomers(repPostingsF(),{from,to,types:id=>ty.get(id),ctx:rfCtx(),top:PL_TOP_CUSTOMERS});
    const cols=rk.top.map(id=>({label:contactName(id)||'?',from,to,cust:id,data:true}));
    if(rk.other.length)cols.push({label:`${T('Other customers')} (${rk.other.length})`,from,to,cust:rk.other});
    if(rk.none||!cols.length)cols.push({label:T('Not specified'),from,to,cust:'__none'});
    return{cols,total:true};
  }
  if(cmp==='months'||cmp==='quarters'){
    const step=cmp==='months'?1:3,cols=[];let s=from;
    while(s<=to){const x=pd(s),e0=iso(new Date(x.getFullYear(),x.getMonth()+step,0)),e=e0<to?e0:to;cols.push({label:rangeLabel(s,e),from:s,to:e});s=addDays(e,1);if(cols.length>36)return{error:'That’s too many columns. Choose a shorter period.'}}
    return{cols,total:cols.length>1};
  }
  return{cols:[base]};
}
/** Dates for a balance sheet: [{label, to}]. */
function dateCols(to,cmp){
  const base={label:fmtDate(to),to};
  if(cmp==='prevyear'){const d=shiftMonths(to,-12);return{cols:[base,{label:fmtDate(d),to:d}],change:true}}
  if(cmp==='prevperiod'){const d=addDays(S.rep.from,-1);return{cols:[base,{label:fmtDate(d),to:d}],change:true}}
  if(cmp==='prevmonth'){const x=pd(to),d=iso(new Date(x.getFullYear(),x.getMonth(),0));return{cols:[base,{label:fmtDate(d),to:d}],change:true}}
  if(cmp==='months'){
    const cols=[];let d=fyStartOf(to);
    while(true){const x=pd(d),e=iso(new Date(x.getFullYear(),x.getMonth()+1,0));if(e>=to){cols.push(base);break}cols.push({label:fmtDate(e),to:e});d=addDays(e,1)}
    return{cols};
  }
  return{cols:[base]};
}

/* ---------- drawing a report with columns ---------- */
const pct=(a,b)=>Math.abs(b)<0.005?null:r2((a-b)/Math.abs(b)*100);
function colReport({title,sub,C,rows,name}){
  const head=[...C.cols.map(c=>c.label),...(C.total?['Total']:[]),...(C.change?(C.changeLabels||['$ change','% change']):[])];
  const full=rows.map(r=>{
    if(!r.vals)return r;
    const extra=[];
    if(C.total)extra.push(r.total!==undefined?r.total:r2(r.vals.reduce((s,v)=>s+v,0)));
    if(C.change){extra.push(r2(r.vals[0]-r.vals[1]));extra.push(pct(r.vals[0],r.vals[1]))}
    return{...r,cells:[...r.vals,...extra]};
  });
  const pctCol=C.change?head.length-1:-1;
  const many=head.length>1;
  const cell=(v,i)=>v===null||v===undefined?'':i===pctCol?`${v>0?'+':''}${v.toLocaleString(LOC(),{maximumFractionDigits:1})}%`:many&&Math.abs(v)<0.005?'<span class="muted">—</span>':mcell(v);
  const body=full.map(r=>{
    if(r.cls==='spacer')return `<tr class="spacer"><td colspan="${head.length+1}"></td></tr>`;
    const label=r.acct?`<button class="link" data-acct="${r.acct}" translate="no">${esc(r.label)}</button>`:r.tag?`<button class="link" data-tagtx="${esc(r.tag)}"${r.data?' translate="no"':''}>${esc(r.label)}</button>`:r.data?`<span translate="no">${esc(r.label)}</span>`:esc(r.label);
    return `<tr class="${r.cls}"><td>${label}</td>${r.cells?r.cells.map((v,i)=>`<td class="n">${cell(v,i)}</td>`).join(''):`<td colspan="${head.length}"></td>`}</tr>`;
  }).join('');
  const csv=[['Account',...head]];
  for(const r of full)if(r.cls!=='spacer')csv.push([r.label,...(r.cells?r.cells.map(v=>v===null?'':v):[])]);
  return{html:`<div class="report${many?' wide':''}" ${many?'style="max-width:none"':''}>${rh(esc(title),esc(sub))}<div class="tbl-wrap"><table class="${many?'cmp':''}">${many?`<thead><tr><th></th>${head.map((h,i)=>`<th class="n"${C.cols[i]&&C.cols[i].data?' translate="no"':''}>${esc(h)}</th>`).join('')}</tr></thead>`:''}${body}</table></div></div>`,
    csv,name,title,sub,head,rows:full,pctCol};
}
const errReport=(title,msg)=>({html:`<div class="banner err">${esc(msg)}</div>`,csv:[[title],[msg]],name:'report',title,sub:'',head:[],rows:[]});

/* ---------- profit and loss ---------- */
function rPL(){
  const{from,to}=S.rep,C=periodCols(from,to,S.rep.tab==='pl'?S.rep.compare||'':'');
  if(C.error)return errReport(W('Profit and loss'),C.error);
  const rows=[],n=C.cols.length;
  const sec=(type,title)=>{
    const as=sortAccts(S.accounts.filter(a=>a.type===type)).map(a=>({a,vals:C.cols.map(c=>fbal(a.id,c.from,c.to,c.cls,c.cust))})).filter(x=>x.vals.some(v=>Math.abs(v)>=0.005));
    if(!as.length&&type==='Cost of Goods Sold')return null;
    const tot=C.cols.map((c,i)=>r2(as.reduce((s,x)=>s+x.vals[i],0)));
    rows.push({cls:'sec',label:title});
    as.forEach(x=>rows.push({cls:'item',label:(x.a.code?x.a.code+' ':'')+x.a.name,vals:x.vals,acct:x.a.id}));
    rows.push({cls:'tot',label:W('Total '+title.toLowerCase()),vals:tot});
    return tot;
  };
  const inc=sec('Income',W('Income')),cogs=sec('Cost of Goods Sold','Cost of goods sold'),z=Array(n).fill(0);
  if(cogs)rows.push({cls:'tot',label:W('Gross profit'),vals:inc.map((v,i)=>r2(v-cogs[i]))});
  const exp=sec('Expense','Expenses');
  rows.push({cls:'spacer'},{cls:'grand',label:W('Net income'),vals:inc.map((v,i)=>r2(v-(cogs||z)[i]-exp[i]))});
  const byCls=C.cols.some(c=>c.cls),byCust=C.cols.some(c=>c.cust),cl=byCls?'':repCls(),cn=cl==='__none'?clsWords().none:cl?(clsName(cl)||''):'';
  // Translated here: with a suffix the whole title wouldn't match the dictionary on screen.
  const tt=byCls?` · ${clsWords().by}`:byCust?` · ${T('By customer')}`:'',tc=cn?` · ${cn}`:'';
  const r=colReport({title:(tt||tc?T(W('Profit and loss')):W('Profit and loss'))+tt+tc,sub:`${fmtDate(from)} – ${fmtDate(to)}${basisSub()}${filtSub()}`,C,rows,name:`profit-and-loss${byCls?'-by-'+clsWords().slug:byCust?'-by-customer':''}_${from}_${to}${repBasis()==='cash'?'_cash':''}`});
  if(byCust)r.html=r.html.replace(/<\/div>$/,`<div class="muted" style="font-size:12.5px;padding:8px 16px 14px">The P&amp;L by customer puts income under the customer on the invoice or sales receipt, and costs under a customer when the bill, expense or entry is for one of their projects. The rest is Not specified.</div></div>`);
  return r;
}

/* ---------- balance sheet ---------- */
function rBS(){
  const to=S.rep.to,C=dateCols(to,S.rep.tab==='bs'?S.rep.compare||'':'');
  const rows=[],per=C.cols.map(c=>{const fy=fyStartOf(c.to);return{re:fNet(null,addDays(fy,-1)),cy:fNet(fy,c.to)}});
  const sec=(type,title,extra=[])=>{
    const as=sortAccts(S.accounts.filter(a=>a.type===type)).map(a=>({label:(a.code?a.code+' ':'')+a.name,acct:a.id,vals:C.cols.map(c=>fbal(a.id,null,c.to))}))
      .concat(extra).filter(x=>x.vals.some(v=>Math.abs(v)>=0.005));
    const tot=C.cols.map((c,i)=>r2(as.reduce((s,x)=>s+x.vals[i],0)));
    rows.push({cls:'sec',label:title});as.forEach(x=>rows.push({cls:'item',...x}));rows.push({cls:'tot',label:'Total '+title.toLowerCase(),vals:tot});
    return tot;
  };
  const A=sec('Asset','Assets');rows.push({cls:'spacer'});
  const L=sec('Liability','Liabilities');
  const E=sec('Equity',W('Equity'),[{label:W('Retained earnings'),vals:per.map(p=>p.re)},{label:W('Net income, current fiscal year'),vals:per.map(p=>p.cy)}]);
  rows.push({cls:'grand',label:W('Total liabilities and equity'),vals:L.map((v,i)=>r2(v+E[i]))});
  const r=colReport({title:W('Balance sheet'),sub:`As of ${fmtDate(to)}${basisSub()}`,C,rows,name:`balance-sheet_${to}${repBasis()==='cash'?'_cash':''}`});
  const off=A.map((v,i)=>r2(v-L[i]-E[i])).find(x=>Math.abs(x)>0.004);
  if(off)r.html=r.html.replace(/<\/div>$/,`<div class="banner err" style="margin:12px 16px">Out of balance by ${money(off)}. Check for entries posted to deleted accounts.</div></div>`);
  return r;
}

/* ---------- cash flow statement (indirect method) ----------
   Starts from net income, adds back amortization, then the change in every balance sheet account that isn't cash.
   Each account goes to operating, investing or financing activities: set it on the account, or Sumlora
   decides from its type (capital assets are investing; loans, shareholder accounts and equity are financing). */
const CF_NONCASH=/accumulated (amortization|amortisation|depreciation)|amortissement cumul|depreciation, accumulated/i;
const CF_FINANCING=/loan|mortgage|note payable|notes payable|line of credit|due to (shareholder|owner|related)|shareholder|lease obligation|long[- ]term debt|emprunt|hypoth|prêt|marge de crédit|actionnaire/i;
function cfSection(a){
  if(a.detail==='bank')return 'cash';
  if(['operating','investing','financing'].includes(a.cf))return a.cf;
  if(a.type==='Asset'){if(CF_NONCASH.test(a.name))return 'noncash';return a.detail==='capital'?'investing':'operating'}
  if(a.type==='Liability')return !a.detail&&CF_FINANCING.test(a.name)?'financing':'operating';
  if(a.type==='Equity')return 'financing';
  return null;
}
function rCF(){
  const{from,to}=S.rep,C=periodCols(from,to,S.rep.tab==='cf'?S.rep.compare||'':'');
  if(C.error)return errReport('Cash flow statement',C.error);
  const label=a=>(a.code?a.code+' ':'')+a.name;
  // Cash effect of the change in an account over [f, t]: more assets use cash; more liabilities or equity bring it in.
  const effect=(a,f,t)=>{const ch=r2(fbal(a.id,null,t)-fbal(a.id,null,addDays(f,-1)));return a.type==='Asset'?r2(-ch):ch};
  const bs=sortAccts(S.accounts.filter(a=>['Asset','Liability','Equity'].includes(a.type)));
  const group=k=>bs.filter(a=>cfSection(a)===k).map(a=>({label:label(a),acct:a.id,vals:C.cols.map(c=>effect(a,c.from,c.to))})).filter(x=>x.vals.some(v=>Math.abs(v)>=0.005));
  const sum=list=>C.cols.map((c,i)=>r2(list.reduce((s,x)=>s+x.vals[i],0)));
  const rows=[];
  const ni={label:W('Net income'),vals:C.cols.map(c=>fNet(c.from,c.to))};
  const nonc=group('noncash'),ops=group('operating'),inv=group('investing'),fin=group('financing');
  rows.push({cls:'sec',label:'Operating activities'},{cls:'item',...ni});
  if(nonc.length){rows.push({cls:'note',label:'Items not affecting cash'});nonc.forEach(x=>rows.push({cls:'item',...x}))}
  if(ops.length){rows.push({cls:'note',label:'Changes in working capital'});ops.forEach(x=>rows.push({cls:'item',...x}))}
  const opT=sum([ni,...nonc,...ops]);rows.push({cls:'tot',label:'Cash from operating activities',vals:opT});
  rows.push({cls:'sec',label:'Investing activities'});inv.forEach(x=>rows.push({cls:'item',...x}));
  const invT=sum(inv);rows.push({cls:'tot',label:'Cash from investing activities',vals:invT});
  rows.push({cls:'sec',label:'Financing activities'});fin.forEach(x=>rows.push({cls:'item',...x}));
  const finT=sum(fin);rows.push({cls:'tot',label:'Cash from financing activities',vals:finT});
  const net=C.cols.map((c,i)=>r2(opT[i]+invT[i]+finT[i]));
  const cash=bs.filter(a=>a.detail==='bank');
  const begin=C.cols.map(c=>r2(cash.reduce((s,a)=>s+fbal(a.id,null,addDays(c.from,-1)),0))),end=C.cols.map(c=>r2(cash.reduce((s,a)=>s+fbal(a.id,null,c.to),0)));
  // In a Total column, opening cash is the first period's and closing cash the last period's, not a sum.
  rows.push({cls:'spacer'},{cls:'tot',label:'Net change in cash',vals:net},{cls:'item',label:'Cash at the beginning of the period',vals:begin,total:begin[0]},{cls:'grand',label:'Cash at the end of the period',vals:end,total:end[end.length-1]});
  const r=colReport({title:'Cash flow statement',sub:`${fmtDate(from)} – ${fmtDate(to)}${basisSub()}`,C,rows,name:`cash-flow_${from}_${to}${repBasis()==='cash'?'_cash':''}`});
  const off=C.cols.map((c,i)=>r2(begin[i]+net[i]-end[i])).find(x=>Math.abs(x)>0.004);
  if(off)r.html=r.html.replace(/<\/div>$/,`<div class="banner err" style="margin:12px 16px">The cash flow doesn’t add up by ${money(off)}. Check for entries posted to deleted accounts.</div></div>`);
  r.html=r.html.replace(/<\/div>$/,`<div class="muted" style="font-size:12.5px;padding:8px 16px 14px">Bank and cash accounts are cash. Capital assets are investing activities; loans, shareholder accounts and equity are financing; everything else is operating. Change an account’s section in the chart of accounts.</div></div>`);
  return r;
}

/* ---------- saved reports ---------- */
const savedReports=()=>(S.company.savedReports||[]);
async function saveReport(){
  const R=S.rep,f=openModal('Save this report',`<div class="fields">${fld('srName','Name',`<input type="text" id="srName" maxlength="60" placeholder="e.g. Monthly P&L by month">`,true)}</div>
    <div class="muted" style="font-size:13px">Saves the report, its period and comparison so you can open it again in one click. The dates move with the period: “This fiscal year” is always the current one.</div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`);
  f.onsubmit=async e=>{e.preventDefault();const name=$('#srName',f).value.trim();if(!name)return f.err('Give it a name.');
    const item={id:uid(),name,tab:R.tab,period:R.period,from:R.period==='custom'?R.from:'',to:R.period==='custom'?R.to:'',compare:R.compare||'',acct:R.acct||'',tbAdj:R.tbAdj==='aje'?'aje':!!R.tbAdj,...(repCls()?{cls:R.cls}:{}),...(R.tab==='bva'&&R.budget?{budget:R.budget}:{}),...(BASIS_TABS.includes(R.tab)?{basis:basisChoice()}:{}),...(repFilter()?{flt:repFilter()}:{}),...(R.tab==='tl'&&R.tlSort?{sort:R.tlSort}:{})};
    if(await putCompany({...strip(S.company),savedReports:[...savedReports().filter(x=>x.name!==name),item].slice(-30)})){S.rep.savedId=item.id;closeModal();toast('Report saved')}};
}
function openSaved(id){const x=savedReports().find(r=>r.id===id);if(!x)return;Object.assign(S.rep,{savedId:x.id,tab:x.tab,period:x.period,compare:x.compare||'',acct:x.acct||'',tbAdj:x.tbAdj==='aje'?'aje':!!x.tbAdj,cls:x.cls||'',budget:x.budget||'',basis:x.basis||'',flt:x.flt||null,...(x.sort?{tlSort:x.sort}:{})});if(x.period==='custom'){S.rep.from=x.from;S.rep.to=x.to}renderMain()}
/** Is the report on screen still the saved one (same report, period and options)? */
const savedMatches=x=>{const R=S.rep;return x.tab===R.tab&&x.period===R.period&&(x.compare||'')===(R.compare||'')&&(x.acct||'')===(R.acct||'')&&(x.tbAdj==='aje'?'aje':!!x.tbAdj)===(R.tbAdj==='aje'?'aje':!!R.tbAdj)&&(x.period!=='custom'||(x.from===R.from&&x.to===R.to))&&(!x.basis||x.basis===basisChoice())&&TallyRepFilter.key(x.flt)===TallyRepFilter.key(repFilter())};
async function deleteSaved(id){const x=savedReports().find(r=>r.id===id);if(!x||!await confirmBox('Delete this saved report?',x.name,'Delete'))return;if(await putCompany({...strip(S.company),savedReports:savedReports().filter(r=>r.id!==id)})){S.rep.savedId='';toast('Saved report deleted');renderMain()}}

/* ---------- PDFs ---------- */
const tl=s=>(typeof T==='function'?T(s):s);
/** PDF rows for the reports that only come as a table (trial balance, general ledger, aging). */
function pdfRows(r){
  const csv=r.csv||[],h=csv[0]||[],body=csv.slice(1),num=v=>v===''||v===null||v===undefined?'':+v;
  if(h[0]==='Code'&&h[1]==='Account'){ // trial balance
    return{head:['Debit','Credit'],rows:body.map(c=>c[1]==='Total'&&!c[0]?{cls:'grand',label:'Total',cells:[num(c[3]),num(c[4])]}:{cls:'item',data:true,label:`${c[0]?c[0]+'  ':''}${c[1]}`,cells:[num(c[3])||'',num(c[4])||'']})};
  }
  if(h[0]==='Account'&&h.length===9){ // general ledger, grouped by account
    const rows=[];let cur=null;
    for(const c of body){
      if(c[0]==='Total'&&!c[1]){rows.push({cls:'spacer'},{cls:'grand',label:'Total',cells:[num(c[6]),num(c[7]),'']});continue}
      if(/^Total /.test(c[0])&&!c[1]){rows.push({cls:'tot',label:`${tl('Total')} ${c[0].slice(6)}`,data:true,cells:[num(c[6]),num(c[7]),num(c[8])]},{cls:'spacer'});cur=null;continue}
      if(c[0]!==cur){cur=c[0];rows.push({cls:'sec',label:c[0],data:true})}
      if(c[2]==='Opening balance'){rows.push({cls:'item',label:`${fmtDate(c[1])}  ${tl('Opening balance')}`,data:true,cells:['','',num(c[8])]});continue}
      rows.push({cls:'item',data:true,label:`${fmtDate(c[1])}  ${tl(c[2])}${c[3]?' #'+c[3]:''}  ${c[4]||c[5]||''}`,cells:[num(c[6]),num(c[7]),num(c[8])]});
    }
    return{head:['Debit','Credit','Balance'],rows};
  }
  // aging and anything else: a name, then numbers
  return{head:h.slice(1),rows:body.map((c,i)=>{const last=i===body.length-1&&/^total$/i.test(String(c[0]));return{cls:last?'grand':'item',label:String(c[0]||(last?'Total':tl('No contact'))),data:!last,cells:c.slice(1).map(v=>typeof v==='number'?v:v===''?'':isNaN(+v)?v:+v)}})};
}
/** Draw reports into a PDF. Each report starts on a new page; long ones continue with the column heads repeated. */
function reportsPdf(reports,{cover}={}){
  const wide=reports.some(r=>r.wide||(r.head||[]).length>4||(r.csv&&r.csv[0]&&r.csv[0][0]==='Account'&&r.csv[0].length===9));
  const doc=TallyPDF.create({landscape:wide}),W0=doc.width,H0=doc.height,M=40;
  // The PDF starts with one blank page: use it for the first page drawn.
  let fresh=doc.pageCount()===1;const page=()=>{if(fresh)fresh=false;else doc.addPage()};
  const fmt=(v,i,r)=>v===null||v===undefined||v===''?'':v===0&&(r.head||[]).length>6&&i!==r.pctCol?'—':typeof v==='number'?(i===r.pctCol?`${v>0?'+':''}${v.toLocaleString(LOC(),{maximumFractionDigits:1})}%`:money(v)):String(v);
  if(cover){
    page();let y=150;
    doc.text(W0/2,y,S.company.name,{size:22,bold:true,align:'center'});y+=34;
    doc.text(W0/2,y,tl(cover.title),{size:15,align:'center'});y+=22;
    doc.text(W0/2,y,cover.sub,{size:11,align:'center',color:'#555555'});y+=50;
    for(const r of reports){doc.text(W0/2,y,tl(r.title),{size:11,align:'center'});y+=18}
    if(cover.note){y+=24;for(const line of doc.wrap(cover.note,W0-2*M-80,10)){doc.text(M+40,y,line,{size:10});y+=14}}
    doc.text(W0/2,H0-60,`${tl('Prepared')} ${fmtDate(today())}`,{size:9,align:'center',color:'#777777'});
  }
  const avail=W0-2*M,LABEL_MIN=130,COL_MIN=48;
  for(const r of reports){
    const shaped=r.rows&&r.rows.length?{head:r.head||[],rows:r.rows}:pdfRows(r);
    const head=shaped.head,rows=shaped.rows,n=head.length;
    // Too many columns for one page width: print them in groups, each group starting a new page.
    const per=Math.max(1,Math.min(n,Math.floor((avail-LABEL_MIN)/COL_MIN))),groups=[];
    for(let i=0;i<Math.max(1,n);i+=per)groups.push([i,Math.min(n,i+per)]);
    for(const [g0,g1] of groups){
      const k=Math.max(1,g1-g0),colW=Math.max(COL_MIN,Math.min(90,(avail-200)/k)),labelW=Math.max(LABEL_MIN,avail-colW*k);
      const size=k>8?7.5:9,gsub=groups.length>1?`${r.sub?r.sub+' · ':''}${tl('Columns')} ${g0+1}–${g1} / ${n}`:r.sub;
      let y=0;
      const top=()=>{page();y=M+6;
        doc.text(M,y,S.company.name,{size:13,bold:true});y+=17;doc.text(M,y,tl(r.title),{size:11,bold:true});y+=14;
        if(gsub){doc.text(M,y,tl(gsub),{size:9,color:'#555555'});y+=12}
        y+=8;if(n>1||!r.head){head.slice(g0,g1).forEach((h,i)=>doc.text(M+labelW+colW*(i+1)-4,y,tl(String(h)),{size:size-0.5,bold:true,align:'right'}));y+=6;doc.line(M,y,W0-M,y,{color:'#999999'});y+=12}};
      top();
      for(const row of rows){
        if(y>H0-M-20)top();
        if(row.cls==='spacer'){y+=6;continue}
        const bold=['sec','tot','grand'].includes(row.cls),indent=row.cls==='item'?12:row.cls==='note'?6:0;
        if(row.cls==='tot'||row.cls==='grand')doc.line(M+labelW,y-9,W0-M,y-9,{color:'#bbbbbb'});
        const lbl=row.acct||row.data?row.label:tl(row.label),lines=doc.wrap(lbl,labelW-indent-6,size,bold);
        doc.text(M+indent,y,lines[0]+(lines.length>1?'…':''),{size,bold,color:row.cls==='note'?'#555555':'#1a1a1a'});
        (row.cells||[]).slice(g0,g1).forEach((v,i)=>doc.text(M+labelW+colW*(i+1)-4,y,fmt(v,i+g0,r),{size,bold,align:'right'}));
        if(row.cls==='grand'){doc.line(M+labelW,y+4,W0-M,y+4,{color:'#555555'});doc.line(M+labelW,y+6,W0-M,y+6,{color:'#555555'})}
        y+=row.cls==='sec'?15:13;
      }
    }
  }
  const pages=doc.pageCount();
  for(let i=0;i<pages;i++){doc.goto(i);doc.text(W0-M,H0-24,`${i+1} / ${pages}`,{size:8,align:'right',color:'#888888'})}
  return doc.output();
}
const REPORT_TITLES={pl:()=>W('Profit and loss'),bs:()=>W('Balance sheet'),cf:()=>'Cash flow statement',tb:()=>'Trial balance',gl:()=>'General ledger',ar:()=>'Accounts receivable aging',ap:()=>'Accounts payable aging',sc:()=>'Sales by customer',si:()=>'Sales by product or service',ev:()=>'Expenses by vendor',bva:()=>'Budget vs actual',iv:()=>'Inventory valuation',tl:()=>'Transaction list',tg:()=>'Money in and out by tag',fc:()=>'Cash flow forecast'};
function reportPdfNow(){const k=S.rep.tab,r=REPORT_FNS[k]();r.title=r.title||REPORT_TITLES[k]();r.sub=r.sub??(k==='ar'||k==='ap'?`As of ${fmtDate(today())}`:k==='tb'?`As of ${fmtDate(S.rep.to)}`:`${fmtDate(S.rep.from)} – ${fmtDate(S.rep.to)}${basisSub()}${filtSub()}`);saveFile(r.name+'.pdf',new Blob([reportsPdf([r])],{type:'application/pdf'}))}

/* ---------- report package: several reports for a period, as one PDF ---------- */
function packageForm(){
  const last=periodRange('lastmonth');
  const opts=[['pl',W('Profit and loss'),true],['bs',W('Balance sheet'),true],['cf','Cash flow statement',true],['ar','A/R aging',false],['ap','A/P aging',false],['tb','Trial balance',false]];
  const f=openModal('Report package',`<div class="muted" style="font-size:13px">One PDF with the reports you choose for a period, ready to send to the client or file at month-end.</div>
    <div class="fields">${fld('pkFrom','From',`<input type="date" id="pkFrom" value="${last[0]}">`)}${fld('pkTo','To',`<input type="date" id="pkTo" value="${last[1]}">`)}
      ${fld('pkCmp','Compare with',`<select id="pkCmp"><option value="">Nothing</option><option value="prev">The previous period</option><option value="prevyear">The same period last year</option></select>`)}</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px 18px">${opts.map(([k,l,on])=>`<label class="check"><input type="checkbox" data-pk="${k}" ${on?'checked':''}> ${esc(l)}</label>`).join('')}</div>
    ${fld('pkNote','Note on the cover page (optional)',`<textarea id="pkNote" rows="3" maxlength="800"></textarea>`,true)}`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" data-pkmail>Email</button><button type="submit" class="btn primary">Download PDF</button>`,'wide');
  const build=()=>{
    const from=$('#pkFrom',f).value,to=$('#pkTo',f).value;if(!from||!to||from>to)throw new Error('Choose the period.');
    const keys=$$('[data-pk]',f).filter(x=>x.checked).map(x=>x.dataset.pk);if(!keys.length)throw new Error('Choose at least one report.');
    const keep={...S.rep},cmp=$('#pkCmp',f).value,out=[];
    try{for(const k of keys){Object.assign(S.rep,{tab:k,period:'custom',from,to,compare:k==='bs'?(cmp==='prev'?'prevperiod':cmp):cmp,flt:null});const r=({pl:rPL,bs:rBS,cf:rCF,tb:rTB,ar:()=>rAging('invoice'),ap:()=>rAging('bill')})[k]();r.title=r.title||REPORT_TITLES[k]();r.sub=r.sub??(k==='ar'||k==='ap'?`As of ${fmtDate(today())}`:k==='tb'?`As of ${fmtDate(to)}`:'');out.push(r)}}
    finally{Object.assign(S.rep,keep)}
    const sub=`${fmtDate(from)} – ${fmtDate(to)}`;
    return{pdf:reportsPdf(out,{cover:{title:'Financial reports',sub,note:$('#pkNote',f).value.trim()}}),name:`${S.company.name.replace(/[^\w\s-]+/g,'').trim().replace(/\s+/g,'-')||'reports'}_reports_${from}_${to}.pdf`,sub};
  };
  f.onsubmit=e=>{e.preventDefault();f.err('');try{const b=build();saveFile(b.name,new Blob([b.pdf],{type:'application/pdf'}));closeModal()}catch(err){f.err(err.message)}};
  $('[data-pkmail]',f).onclick=()=>{f.err('');let b;try{b=build()}catch(err){return f.err(err.message)}closeModal();
    composeMail({kind:'package',contactId:'',docIds:[],fileName:b.name,makePdf:async()=>b.pdf,vars:{period:b.sub}})};
}

/* ---------- bank reconciliation report ---------- */
function reconReport(r){
  const a=acct(r.account);if(!a)return;
  const card=a.detail==='card',ids=new Set(r.entryIds),N=v=>natural(a,v); // card amounts as the amount owed, so the rows add up
  // Reconciled before this one: on statements dated earlier.
  const earlier=new Set(S.recons.filter(x=>x.account===r.account&&x.id!==r.id&&(x.statementDate<r.statementDate||(x.statementDate===r.statementDate&&(x.completedAt||0)<(r.completedAt||0)))).flatMap(x=>x.entryIds));
  let ins=0,outs=0,missing=0;
  for(const id of ids){const e=S.entries.find(x=>x.id===id);if(!e){missing++;continue}const v=signedOn(e,a.id);if(v>0)ins+=v;else outs+=-v}
  const open=S.entries.filter(e=>e.date<=r.statementDate&&!ids.has(e.id)&&!earlier.has(e.id)&&(e.lines||[]).some(l=>l.account===a.id)).map(e=>({e,amt:signedOn(e,a.id)})).filter(x=>Math.abs(x.amt)>=0.005).sort((x,y)=>x.e.date.localeCompare(y.e.date));
  const dit=open.filter(x=>x.amt>0),oc=open.filter(x=>x.amt<0);
  const ditT=r2(dit.reduce((s,x)=>s+x.amt,0)),ocT=r2(oc.reduce((s,x)=>s-x.amt,0));
  const book=fbal(a.id,null,r.statementDate),adjusted=r2(+r.endingBalance+natural(a,ditT-ocT)),diff=r2(book-adjusted);
  const L=card?{in:'Payments and credits',out:'Charges',dit:'Payments not yet on the statement',oc:'Charges not yet on the statement'}:{in:'Deposits and other credits',out:'Cheques and payments',dit:'Deposits in transit',oc:'Outstanding cheques and payments'};
  const rows=[
    {cls:'sec',label:'Statement'},
    {cls:'item',label:'Beginning balance',vals:[+r.beginningBalance]},
    {cls:'item',label:`${L.in} cleared`,vals:[N(ins)]},{cls:'item',label:`${L.out} cleared`,vals:[N(-outs)]},
    {cls:'tot',label:'Statement ending balance',vals:[+r.endingBalance]},
    {cls:'spacer'},{cls:'sec',label:'Not yet on the statement'},
    {cls:'note',label:L.dit},...dit.map(x=>({cls:'item',label:`${fmtDate(x.e.date)}  ${tl(TLABEL[x.e.type]||x.e.type)}${x.e.ref?' #'+x.e.ref:''}  ${contactName(x.e.contactId)||x.e.memo||''}`,data:true,vals:[N(x.amt)],entry:x.e.id})),
    {cls:'tot',label:`Total ${L.dit.toLowerCase()}`,vals:[N(ditT)]},
    {cls:'note',label:L.oc},...oc.map(x=>({cls:'item',label:`${fmtDate(x.e.date)}  ${tl(TLABEL[x.e.type]||x.e.type)}${x.e.ref?' #'+x.e.ref:''}  ${contactName(x.e.contactId)||x.e.memo||''}`,data:true,vals:[N(x.amt)],entry:x.e.id})),
    {cls:'tot',label:`Total ${L.oc.toLowerCase()}`,vals:[N(-ocT)]},
    {cls:'spacer'},{cls:'tot',label:'Adjusted statement balance',vals:[adjusted]},{cls:'grand',label:`Balance in the books on ${fmtDate(r.statementDate)}`,vals:[book]},
  ];
  if(Math.abs(diff)>=0.005)rows.push({cls:'item',label:'Difference (transactions changed after this reconciliation)',vals:[diff]});
  const rep=colReport({title:'Bank reconciliation report',sub:`${a.name} · statement ending ${fmtDate(r.statementDate)}${r.completedAt?` · reconciled ${fmtDate(new Date(r.completedAt).toISOString().slice(0,10))}`:''}`,C:{cols:[{label:'Amount'}]},rows,name:`reconciliation_${a.code||a.name}_${r.statementDate}`});
  const f=openModal('Bank reconciliation report',`${missing?`<div class="banner err" style="margin:0"><span>${missing} reconciled transaction${missing===1?' was':'s were'} deleted afterwards.</span></div>`:''}${Math.abs(diff)>=0.005?`<div class="banner err" style="margin:0"><span>The books no longer agree with this reconciliation by ${money(diff)}. A reconciled transaction was changed or deleted, or one was added on or before ${fmtDate(r.statementDate)}.</span></div>`:''}${rep.html}`,
    `<button type="button" class="btn" data-close>Close</button><button type="button" class="btn" data-rrcsv>Export CSV</button><button type="button" class="btn primary" data-rrpdf>Download PDF</button>`,'wide');
  $('[data-rrpdf]',f).onclick=()=>saveFile(rep.name.replace(/[^\w.-]+/g,'-')+'.pdf',new Blob([reportsPdf([rep])],{type:'application/pdf'}));
  $('[data-rrcsv]',f).onclick=()=>{const text=rep.csv.map(row=>row.map(v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');saveFile(rep.name.replace(/[^\w.-]+/g,'-')+'.csv',new Blob(['﻿'+text],{type:'text/csv;charset=utf-8'}))};
}

/* ---------- working trial balance: before adjustments, adjusting entries, after ---------- */
/* Working (adjusted) trial balance: for each account, the balance before adjustments, the adjusting entries and the
   adjusted balance, each as a debit or a credit. Adjusting entries are journal entries marked "Adjusting" in the year. */
function rTBAdj(){
  const to=S.rep.to,fy=fyStartOf(to),isAdj=e=>e.adjusting&&!e.reversalOf&&e.date>=fy&&e.date<=to,adjIds=new Set(S.entries.filter(isAdj).map(e=>e.id));
  const sums=new Map();
  for(const p of postings()){
    const a=acct(p.account);if(!a)continue;
    const from=isPL(a.type)?fy:null;if((from&&p.date<from)||p.date>to)continue;
    // Adjustments keep their debits and credits apart, so an account adjusted both ways shows both.
    const x=sums.get(p.account)||{u:0,jd:0,jc:0};if(adjIds.has(p.e.id)){x.jd+=p.debit;x.jc+=p.credit}else x.u+=p.debit-p.credit;sums.set(p.account,x);
  }
  const dc=v=>v>=0?[r2(v),0]:[0,r2(-v)];
  const rows=[],tot=[0,0,0,0,0,0];
  const add=(label,u,jd,jc,acctId)=>{const t=r2(u+jd-jc),vals=[...dc(u),r2(jd),r2(jc),...dc(t)];vals.forEach((v,i)=>tot[i]+=v);rows.push({cls:'item',label,vals:vals.map(v=>Math.abs(v)<0.005?null:v),acct:acctId})};
  for(const a of sortAccts(S.accounts)){
    const x=sums.get(a.id);if(!x)continue;const u=r2(x.u);if(Math.abs(u)<0.005&&Math.abs(x.jd)<0.005&&Math.abs(x.jc)<0.005)continue;
    add((a.code?a.code+' ':'')+a.name,u,x.jd,x.jc,a.id);
  }
  const re=r2(-fNet(null,addDays(fy,-1)));
  if(Math.abs(re)>=0.005)add(W('Retained earnings'),re,0,0);
  rows.push({cls:'grand',label:'Total',vals:tot.map(r2)});
  const n=adjIds.size;
  const r=colReport({title:'Working trial balance',sub:`As of ${fmtDate(to)} · income and expenses from ${fmtDate(fy)}`,C:{cols:[{label:'Unadjusted debit'},{label:'Unadjusted credit'},{label:'Adjustments debit'},{label:'Adjustments credit'},{label:'Adjusted debit'},{label:'Adjusted credit'}]},rows,name:`working-trial-balance_${to}`});
  r.html=r.html.replace(/<\/div>$/,`<div class="muted" style="font-size:12.5px;padding:8px 16px 14px">${n} adjusting entr${n===1?'y':'ies'}. Mark a journal entry as adjusting when you enter it.</div></div>`);
  return r;
}
/* Adjusting entries: each adjusting journal entry in the fiscal year, numbered (AJE 1, 2…), with its lines. */
function rAJE(){
  const to=S.rep.to,fy=fyStartOf(to);
  const list=S.entries.filter(e=>e.adjusting&&!e.reversalOf&&e.date>=fy&&e.date<=to).sort((a,b)=>a.date.localeCompare(b.date)||(a.created||0)-(b.created||0));
  const csv=[['No.','Date','Account','Memo','Debit','Credit']];let h='',td=0,tc=0;
  list.forEach((e,i)=>{
    const no=`AJE ${i+1}`,ls=(e.lines||[]).filter(l=>+l.debit||+l.credit).sort((x,y)=>(+y.debit||0)-(+x.debit||0));
    h+=`<tr class="sec"><td colspan="4"><button class="link" data-entry="${e.id}"><b>${no}</b></button> <span class="muted">· ${fmtDate(e.date)}${e.ref?` · #${esc(e.ref)}`:''}</span>${e.memo?` · <span translate="no">${esc(e.memo)}</span>`:''}${e.reverseOn?` <span class="pill quiet">Reverses ${fmtDate(e.reverseOn)}</span>`:''}</td></tr>`;
    for(const l of ls){const a=acct(l.account),d=r2(+l.debit||0),c=r2(+l.credit||0);td+=d;tc+=c;
      h+=`<tr class="item"><td style="padding-left:${c&&!d?'40px':'20px'}" translate="no">${esc(a?(a.code?a.code+' ':'')+a.name:'(deleted account)')}</td><td class="muted" translate="no">${esc(l.memo||'')}</td><td class="n">${d?money(d):''}</td><td class="n">${c?money(c):''}</td></tr>`;
      csv.push([no,e.date,a?(a.code?a.code+' ':'')+a.name:'',l.memo||'',d||'',c||''])}
  });
  csv.push(['','','Total','',r2(td),r2(tc)]);
  const html=`<div class="report wide" style="max-width:none">${rh('Adjusting entries',`${fmtDate(fy)} – ${fmtDate(to)}`)}<div class="tbl-wrap"><table class="cmp"><thead><tr><th>Account</th><th>Memo</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>${list.length?h+`<tr class="grand"><td>Total</td><td></td><td class="n">${money(td)}</td><td class="n">${money(tc)}</td></tr>`:emptyRow(4,'No adjusting entries','Mark a journal entry as adjusting when you enter it (+ New → Journal entry).')}</tbody></table></div></div>`;
  const rows=[];list.forEach((e,i)=>{rows.push({cls:'sec',label:`AJE ${i+1} · ${fmtDate(e.date)}${e.memo?' · '+e.memo:''}`});for(const l of (e.lines||[]).filter(l=>+l.debit||+l.credit)){const a=acct(l.account);rows.push({cls:'item',label:'   '+(a?(a.code?a.code+' ':'')+a.name:''),cells:[r2(+l.debit||0)||null,r2(+l.credit||0)||null]})}});
  rows.push({cls:'grand',label:'Total',cells:[r2(td),r2(tc)]});
  return{html,csv,name:`adjusting-entries_${to}`,title:'Adjusting entries',sub:`${fmtDate(fy)} – ${fmtDate(to)}`,head:['Debit','Credit'],rows};
}

/* ---------- Sales by customer, sales by product or service, expenses by vendor ----------
   Amounts are before sales tax. Sales by customer and expenses by vendor come from the ledger (income, or
   expense and cost of goods sold accounts, by the name on each transaction), so they agree with the profit
   and loss. Sales by product or service comes from the lines of invoices, sales receipts and credit notes. */
function nameReport({title,col,rows,cols,name,empty,note}){
  const{from,to}=S.rep;
  const tot=cols.map((c,i)=>c.sum===false?null:r2(rows.reduce((t,r)=>t+(+r.vals[i]||0),0)));
  const csv=[[col,...cols.map(c=>c.label)],...rows.map(r=>[r.label,...r.vals.map(v=>typeof v==='number'?r2(v):v===null?'':v)]),['Total',...tot.map(v=>v===null?'':v)]];
  const cell=(v,c)=>v===null||v===undefined?'<span class="muted">—</span>':c.kind==='qty'?(+v||0).toLocaleString(LOC(),{maximumFractionDigits:2}):c.kind==='pct'?`${(+v||0).toLocaleString(LOC(),{maximumFractionDigits:1})}%`:mcell(v);
  const body=rows.map(r=>`<tr>${r.contact?`<td><button class="link" data-contact="${esc(r.contact)}" translate="no">${esc(r.label)}</button></td>`:r.item?`<td><button class="link" data-item="${esc(r.item)}" translate="no">${esc(r.label)}</button></td>`:`<td>${esc(r.label)}</td>`}${r.vals.map((v,i)=>`<td class="n">${cell(v,cols[i])}</td>`).join('')}</tr>`).join('');
  return{html:`<div class="report" style="max-width:none">${rh(esc(title),`${fmtDate(from)} – ${fmtDate(to)} · before sales tax${basisSub()}${filtSub()}`)}<div class="tbl-wrap"><table><thead><tr><th>${esc(col)}</th>${cols.map(c=>`<th class="n">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${body||`<tr><td colspan="${cols.length+1}" class="muted" style="padding:16px">${esc(empty)}</td></tr>`}</tbody>${rows.length?`<tfoot><tr class="grand"><td>Total</td>${tot.map((v,i)=>`<td class="n">${v===null?'':cell(v,cols[i])}</td>`).join('')}</tr></tfoot>`:''}</table></div>${note?`<div class="muted" style="font-size:12.5px;padding:10px 12px 12px">${esc(note)}</div>`:''}</div>`,csv,name:`${name}_${from}_${to}`};
}
function byContactOn(types){
  // From the report's postings, so on the cash basis an invoice or bill counts each time it's paid.
  const{from,to}=S.rep,by={},per=new Map(),inc=types.includes('Income'),ty=new Map(S.accounts.map(a=>[a.id,a.type]));
  for(const p of repPostingsF()){if(p.date<from||p.date>to||p.e.opening||!types.includes(ty.get(p.account)))continue;per.set(p.e,(per.get(p.e)||0)+(inc?p.credit-p.debit:p.debit-p.credit))}
  for(const[e,amt]of per){if(Math.abs(amt)<0.005)continue;const k=e.contactId||'';const o=by[k]=by[k]||{amt:0,n:0};o.amt+=amt;o.n++}
  return by;
}
function rSalesByCustomer(){
  const by=byContactOn(['Income']),all=Object.values(by).reduce((t,o)=>t+o.amt,0)||1;
  const rows=Object.entries(by).map(([k,o])=>({label:k?contactName(k):T('No customer'),contact:k||'',vals:[o.n,r2(o.amt),r2(o.amt/all*100)]})).sort((a,b)=>b.vals[1]-a.vals[1]);
  return nameReport({title:'Sales by customer',col:'Customer',name:'sales-by-customer',rows,cols:[{label:'Transactions',kind:'qty'},{label:'Sales'},{label:'% of sales',kind:'pct',sum:false}],empty:'No sales in this period.'});
}
function rExpensesByVendor(){
  const by=byContactOn(['Expense','Cost of Goods Sold']),all=Object.values(by).reduce((t,o)=>t+o.amt,0)||1;
  const rows=Object.entries(by).map(([k,o])=>({label:k?contactName(k):T('No vendor'),contact:k||'',vals:[o.n,r2(o.amt),r2(o.amt/all*100)]})).sort((a,b)=>b.vals[1]-a.vals[1]);
  return nameReport({title:'Expenses by vendor',col:'Vendor',name:'expenses-by-vendor',rows,cols:[{label:'Transactions',kind:'qty'},{label:'Expenses'},{label:'% of expenses',kind:'pct',sum:false}],empty:'No expenses in this period.'});
}
function rSalesByItem(){
  const{from,to}=S.rep,by={};
  for(const d of S.docs){if(!['invoice','sreceipt','credit'].includes(d.kind)||d.date<from||d.date>to)continue;const sg=d.kind==='credit'?-1:1;
    for(const l of d.lines||[]){const k=l.item&&S.items.some(i=>i.id===l.item)?l.item:'';const o=by[k]=by[k]||{qty:0,amt:0};o.qty+=sg*(+l.qty||0);o.amt+=sg*r2((+l.qty||0)*(+l.rate||0))}}
  const rows=Object.entries(by).map(([k,o])=>({label:k?S.items.find(i=>i.id===k).name:T('Not linked to a product or service'),item:k||'',vals:[r2(o.qty),r2(o.amt),k&&o.qty?r2(o.amt/o.qty):null]})).filter(r=>Math.abs(r.vals[1])>=0.005).sort((a,b)=>(a.item?0:1)-(b.item?0:1)||b.vals[1]-a.vals[1]);
  return nameReport({title:'Sales by product or service',col:'Product or service',name:'sales-by-product',rows,cols:[{label:'Quantity',kind:'qty',sum:false},{label:'Sales'},{label:'Average price',sum:false}],empty:'No invoices or sales receipts in this period.',note:'From invoices, sales receipts and credit notes. Deposits recorded without one aren’t included.'});
}

/* ---------- filters: the Filter button and the list of what's filtered ---------- */
/** The kinds of filter a report offers, with the choices for each. Tags join this list once transactions have them. */
function filterKinds(){
  const tab=S.rep.tab,byName=(a,b)=>a.name.localeCompare(b.name),cs=S.company.classes||[];
  const ks=[
    {k:'cust',label:'Customers',none:'No customer',opts:S.contacts.filter(c=>c.kind==='customer').sort(byName).map(c=>[c.id,c.name])},
    {k:'vend',label:'Vendors',none:'No vendor',opts:S.contacts.filter(c=>c.kind==='vendor').sort(byName).map(c=>[c.id,c.name])},
    {k:'acct',label:'Accounts',opts:sortAccts(S.accounts).filter(a=>tab==='gl'||tab==='tl'||isPL(a.type)).map(a=>[a.id,(a.code?a.code+' ':'')+a.name])},
  ];
  if(cs.length&&!(tab==='pl'&&S.rep.compare==='byclass'))ks.push({k:'cls',label:clsWords().many,none:clsWords().none,opts:cs.map(c=>[c.id,c.name])});
  return ks.filter(x=>x.opts.length);
}
/** "Customers: A, B · Accounts: Rent" under the toolbar, with a way to clear it. */
function filterBar(){
  const f=repFilter();if(!f)return '';
  const names={cust:id=>id==='__none'?T('No customer'):contactName(id),vend:id=>id==='__none'?T('No vendor'):contactName(id),acct:id=>acctName(id),cls:id=>id==='__none'?clsWords().none:clsName(id),tag:id=>id};
  const lbl={cust:T('Customers'),vend:T('Vendors'),acct:T('Accounts'),cls:clsWords().many,tag:T('Tags')};
  const parts=TallyRepFilter.KEYS.filter(k=>f[k]).map(k=>`<span><b>${esc(lbl[k])}:</b> <span translate="no">${esc(f[k].slice(0,4).map(names[k]).join(', '))}</span>${f[k].length>4?` +${f[k].length-4}`:''}</span>`);
  return `<div class="toolbar rep-filters"><span class="muted">Filtered by</span>${parts.join('<span class="muted">·</span>')}<span class="grow"></span><button class="btn sm ghost" data-act="repfltclear">Clear filters</button></div>`;
}
/** The Filter form: a searchable list of checkboxes for each kind. Nothing ticked in a kind = no filter on it. */
function filterForm(){
  const cur=TallyRepFilter.clean(S.rep.flt)||{},ks=filterKinds();
  const sec=x=>`<div class="rf-sec" data-rfk="${x.k}"><div class="acclib-head"><b>${esc(T(x.label))}</b><span class="muted" data-rfn></span><button type="button" class="btn sm ghost" data-rfnone>Clear</button></div>
    ${x.none?`<label class="acclib-row rf-row"><input type="checkbox" value="__none" ${(cur[x.k]||[]).includes('__none')?'checked':''}><span>${esc(T(x.none))}</span></label>`:''}
    ${x.opts.map(([id,n])=>`<label class="acclib-row rf-row" data-rfname="${esc(n.toLowerCase())}"><input type="checkbox" value="${esc(id)}" ${(cur[x.k]||[]).includes(id)?'checked':''}><span translate="no">${esc(n)}</span></label>`).join('')}</div>`;
  const f=openModal('Filter this report',`<div class="muted" style="font-size:13px">Tick what to include. Different kinds of filter add up: a customer and an account shows that customer’s amounts in that account. Customers and vendors together show both.</div>
    <input type="search" id="rfQ" placeholder="${esc(T('Find a name or account'))}" aria-label="${esc(T('Find a name or account'))}">
    <div class="acclib">${ks.map(sec).join('')}</div>`,
    `<button type="button" class="btn" data-rfall>Clear all</button><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Apply</button>`,'wide');
  f.classList.add('keep'); // filtering only changes what's on screen, so a view-only role can use it
  const count=()=>$$('[data-rfk]',f).forEach(s=>{const n=$$('input:checked',s).length;$('[data-rfn]',s).textContent=n?`· ${n}`:''});count();
  f.addEventListener('change',count);
  $('#rfQ',f).oninput=()=>{const q=$('#rfQ',f).value.trim().toLowerCase();$$('[data-rfname]',f).forEach(r=>{r.hidden=!!q&&!r.dataset.rfname.includes(q)})};
  $$('[data-rfnone]',f).forEach(b=>b.onclick=()=>{$$('input',b.closest('[data-rfk]')).forEach(i=>i.checked=false);count()});
  $('[data-rfall]',f).onclick=()=>{$$('[data-rfk] input',f).forEach(i=>i.checked=false);count()};
  f.onsubmit=e=>{e.preventDefault();const out={};
    for(const s of $$('[data-rfk]',f)){const ids=$$('input:checked',s).map(i=>i.value);if(ids.length)out[s.dataset.rfk]=ids}
    // A kind this report doesn't offer (a class on a P&L by class) is kept for the reports that do.
    for(const k of TallyRepFilter.KEYS)if(!ks.some(x=>x.k===k)&&cur[k])out[k]=cur[k];
    S.rep.flt=TallyRepFilter.clean(out);closeModal();renderMain()};
}

/* ---------- transaction list ----------
   Every transaction in the period: date, type, number, name, memo, account, the other accounts (split), class and
   amount. The account is the bank, card, A/R or A/P side; the amount is the transaction's total. With an account filter
   the account column shows the filtered accounts and the amount is their net change (debits positive, credits negative). */
const TL_COLS=[['date','Date'],['type','Type'],['num','No.'],['name','Name'],['memo','Memo'],['acct','Account'],['split','Other accounts'],['cls','Class'],['amt','Amount']];
function rTxList(){
  const{from,to}=S.rep,f=repFilter(),hasCls=(S.company.classes||[]).length>0;
  const main=new Set(S.accounts.filter(a=>['bank','card','ar','ap'].includes(a.detail)).map(a=>a.id));
  const an=id=>{const a=acct(id);return a?(a.code?a.code+' ':'')+a.name:'(deleted account)'};
  const rows=TallyRepFilter.txRows(repPostingsF(),{from,to,filter:f,isMain:id=>main.has(id)}).map(r=>{const e=r.e;return{...r,
    type:tl(TLABEL[e.type]||e.type),num:e.ref||'',name:contactName(e.contactId)||(e.type==='payrun'?tl('Payroll'):''),memo:e.memo||'',
    acct:r.accounts.map(an).join(', '),split:r.split.length>1?tl(`${r.split.length} accounts`):r.split.map(an).join(''),splitAll:r.split.map(an).join(', '),cls:e.cls?clsName(e.cls):''}});
  const so=S.rep.tlSort&&TL_COLS.some(c=>c[0]===S.rep.tlSort.col)?S.rep.tlSort:{col:'date',dir:'asc'};
  const sorted=TallyRepFilter.sortRows(rows,r=>so.col==='amt'?r.amount:so.col==='split'?r.splitAll:r[so.col],so.dir);
  const cols=TL_COLS.filter(c=>c[0]!=='cls'||hasCls).map(c=>c[0]==='cls'?[c[0],clsWords().one]:c);
  const total=r2(sorted.reduce((s,r)=>s+r.amount,0)),max=shownCount('tl',sorted.length,500);
  const th=([k,l])=>`<th class="${k==='amt'?'n':''}"><button type="button" class="link rep-sort" data-tlsort="${k}" aria-sort="${so.col===k?(so.dir==='asc'?'ascending':'descending'):'none'}"><span>${esc(l)}</span>${so.col===k?`<span aria-hidden="true">${so.dir==='asc'?' ▲':' ▼'}</span>`:''}</button></th>`;
  const td=(r,k)=>k==='date'?`<td style="white-space:nowrap">${fmtDate(r.date)}</td>`:k==='type'?`<td style="white-space:nowrap">${esc(r.type)}</td>`:k==='num'?`<td class="mono">${esc(r.num)}</td>`
    :k==='amt'?`<td class="n">${mcell(r.amount)}</td>`:k==='split'?`<td class="trunc muted" translate="no" title="${esc(r.splitAll)}">${esc(r.split)}</td>`:`<td class="trunc${k==='memo'?' muted':''}" translate="no">${esc(r[k])}</td>`;
  const body=sorted.slice(0,max).map(r=>`<tr class="click" data-entry="${r.e.id}">${cols.map(([k])=>td(r,k)).join('')}</tr>`).join('');
  const csv=[cols.map(c=>c[1]),...sorted.map(r=>cols.map(([k])=>k==='date'?r.date:k==='amt'?r.amount:k==='split'?r.splitAll:r[k]))];
  csv.push(cols.map(([k],i)=>i===0?'Total':k==='amt'?total:''));
  const sub=`${fmtDate(from)} – ${fmtDate(to)}${basisSub()}${filtSub()}`,n=sorted.length;
  const html=`<div class="report wide" style="max-width:none">${rh('Transaction list',sub)}<div class="tbl-wrap"><table class="gl tl"><thead><tr>${cols.map(th).join('')}</tr></thead><tbody>
    ${body||`<tr><td colspan="${cols.length}" class="muted" style="padding:16px">No transactions in this period.</td></tr>`}${moreRow('tl',max,n,cols.length,'Export CSV and PDF include every line.')}</tbody>
    ${n?`<tfoot><tr class="grand"><td colspan="${cols.length-1}">${n} transaction${n===1?'':'s'}</td><td class="n">${money(total)}</td></tr></tfoot>`:''}</table></div>
    ${f&&f.acct?`<div class="muted" style="font-size:12.5px;padding:8px 16px 14px">With an account filter, the amount is the change in those accounts: debits are positive, credits negative.</div>`:''}</div>`;
  // PDF: one line for each transaction (date, type, number, name and account), then the amount.
  const pdf=sorted.map(r=>({cls:'item',data:true,label:`${fmtDate(r.date)}  ${r.type}${r.num?' #'+r.num:''}  ${r.name||r.memo}  · ${r.acct}`,cells:[r.amount]}));
  pdf.push({cls:'grand',label:'Total',cells:[total]});
  return{html,csv,name:`transaction-list_${from}_${to}${repBasis()==='cash'?'_cash':''}`,title:'Transaction list',sub,head:['Amount'],rows:pdf,wide:true};
}
function tlSort(col){const s=S.rep.tlSort||{col:'date',dir:'asc'};S.rep.tlSort={col,dir:s.col===col&&s.dir==='asc'?'desc':'asc'};renderMain()}

/** Every report on the Reports page, by tab. */
const REPORT_FNS={pl:()=>rPL(),bs:()=>rBS(),cf:()=>rCF(),tb:()=>tbReport(),gl:()=>rGL(),ar:()=>rAging('invoice'),ap:()=>rAging('bill'),sc:()=>rSalesByCustomer(),si:()=>rSalesByItem(),ev:()=>rExpensesByVendor(),bva:()=>rBudgetVsActual(),iv:()=>rInventoryValuation(),tl:()=>rTxList(),tg:()=>rTags(),fc:()=>rForecast()};
