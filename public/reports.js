'use strict';
/* ---------- Reports: comparisons, cash flow, saved reports, PDFs and report packages, reconciliation reports ----------
 * The profit and loss, balance sheet and cash flow statement can show one period or several side by side:
 * the previous period, the same period last year, or each month or quarter. Every report returns
 * { html, csv, name, title, sub, head, rows } so it can be shown, exported to CSV, or drawn into a PDF. */

/* Fast sums: each account's postings by date with running totals, so many columns stay quick. */
let RIX=null;
function rix(){
  const ps=postings();if(RIX&&RIX.ps===ps)return RIX;
  const m=new Map();
  for(const p of ps){let a=m.get(p.account);if(!a)m.set(p.account,a=[]);a.push([p.date,p.debit-p.credit])}
  for(const a of m.values()){a.sort((x,y)=>x[0]<y[0]?-1:x[0]>y[0]?1:0);let c=0;a.cum=a.map(x=>c+=x[1])}
  return RIX={ps,m};
}
const firstOnOrAfter=(a,d)=>{let lo=0,hi=a.length;while(lo<hi){const mid=(lo+hi)>>1;if(a[mid][0]<d)lo=mid+1;else hi=mid}return lo};
function rawSum(id,from,to){
  const a=rix().m.get(id);if(!a||!a.length)return 0;
  const i=from?firstOnOrAfter(a,from):0,j=to?firstOnOrAfter(a,to+'~'):a.length;
  return r2((j>0?a.cum[j-1]:0)-(i>0?a.cum[i-1]:0));
}
function fbal(id,from,to){const a=acct(id),r=rawSum(id,from,to);return a&&!debitNormal(a.type)?r2(-r):r}
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
const PL_COMPARE=[['','No comparison'],['prev','Previous period'],['prevyear','Same period last year'],['months','By month'],['quarters','By quarter']];
const BS_COMPARE=[['','No comparison'],['prevmonth','End of the previous month'],['prevyear','One year earlier'],['months','Each month-end this fiscal year']];
/** Columns for a period report: [{label, from, to}], plus whether to add Total or change columns. */
function periodCols(from,to,cmp){
  const base={label:rangeLabel(from,to),from,to};
  if(cmp==='prev'){const[a,b]=prevPeriod(from,to);return{cols:[base,{label:rangeLabel(a,b),from:a,to:b}],change:true}}
  if(cmp==='prevyear'){const a=shiftMonths(from,-12),b=shiftMonths(to,-12);return{cols:[base,{label:rangeLabel(a,b),from:a,to:b}],change:true}}
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
  const head=[...C.cols.map(c=>c.label),...(C.total?['Total']:[]),...(C.change?['$ change','% change']:[])];
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
    const label=r.acct?`<button class="link" data-acct="${r.acct}" translate="no">${esc(r.label)}</button>`:r.data?`<span translate="no">${esc(r.label)}</span>`:esc(r.label);
    return `<tr class="${r.cls}"><td>${label}</td>${r.cells?r.cells.map((v,i)=>`<td class="n">${cell(v,i)}</td>`).join(''):`<td colspan="${head.length}"></td>`}</tr>`;
  }).join('');
  const csv=[['Account',...head]];
  for(const r of full)if(r.cls!=='spacer')csv.push([r.label,...(r.cells?r.cells.map(v=>v===null?'':v):[])]);
  return{html:`<div class="report${many?' wide':''}" ${many?'style="max-width:none"':''}>${rh(esc(title),esc(sub))}<div class="tbl-wrap"><table class="${many?'cmp':''}">${many?`<thead><tr><th></th>${head.map(h=>`<th class="n">${esc(h)}</th>`).join('')}</tr></thead>`:''}${body}</table></div></div>`,
    csv,name,title,sub,head,rows:full,pctCol};
}
const errReport=(title,msg)=>({html:`<div class="banner err">${esc(msg)}</div>`,csv:[[title],[msg]],name:'report',title,sub:'',head:[],rows:[]});

/* ---------- profit and loss ---------- */
function rPL(){
  const{from,to}=S.rep,C=periodCols(from,to,S.rep.tab==='pl'?S.rep.compare||'':'');
  if(C.error)return errReport(W('Profit and loss'),C.error);
  const rows=[],n=C.cols.length;
  const sec=(type,title)=>{
    const as=sortAccts(S.accounts.filter(a=>a.type===type)).map(a=>({a,vals:C.cols.map(c=>fbal(a.id,c.from,c.to))})).filter(x=>x.vals.some(v=>Math.abs(v)>=0.005));
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
  return colReport({title:W('Profit and loss'),sub:`${fmtDate(from)} – ${fmtDate(to)}`,C,rows,name:`profit-and-loss_${from}_${to}`});
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
  const r=colReport({title:W('Balance sheet'),sub:C.cols.length>1?`As of ${fmtDate(to)}`:`As of ${fmtDate(to)}`,C,rows,name:`balance-sheet_${to}`});
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
  const r=colReport({title:'Cash flow statement',sub:`${fmtDate(from)} – ${fmtDate(to)}`,C,rows,name:`cash-flow_${from}_${to}`});
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
    const item={id:uid(),name,tab:R.tab,period:R.period,from:R.period==='custom'?R.from:'',to:R.period==='custom'?R.to:'',compare:R.compare||'',acct:R.acct||'',tbAdj:!!R.tbAdj};
    if(await putCompany({...strip(S.company),savedReports:[...savedReports().filter(x=>x.name!==name),item].slice(-30)})){S.rep.savedId=item.id;closeModal();toast('Report saved')}};
}
function openSaved(id){const x=savedReports().find(r=>r.id===id);if(!x)return;Object.assign(S.rep,{savedId:x.id,tab:x.tab,period:x.period,compare:x.compare||'',acct:x.acct||'',tbAdj:!!x.tbAdj});if(x.period==='custom'){S.rep.from=x.from;S.rep.to=x.to}renderMain()}
/** Is the report on screen still the saved one (same report, period and options)? */
const savedMatches=x=>{const R=S.rep;return x.tab===R.tab&&x.period===R.period&&(x.compare||'')===(R.compare||'')&&(x.acct||'')===(R.acct||'')&&!!x.tbAdj===!!R.tbAdj&&(x.period!=='custom'||(x.from===R.from&&x.to===R.to))};
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
  const wide=reports.some(r=>(r.head||[]).length>4||(r.csv&&r.csv[0]&&r.csv[0][0]==='Account'&&r.csv[0].length===9));
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
        if(gsub){doc.text(M,y,gsub,{size:9,color:'#555555'});y+=12}
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
const REPORT_TITLES={pl:()=>W('Profit and loss'),bs:()=>W('Balance sheet'),cf:()=>'Cash flow statement',tb:()=>'Trial balance',gl:()=>'General ledger',ar:()=>'Accounts receivable aging',ap:()=>'Accounts payable aging'};
function reportPdfNow(){const k=S.rep.tab,r=({pl:rPL,bs:rBS,cf:rCF,tb:()=>S.rep.tbAdj?rTBAdj():rTB(),gl:rGL,ar:()=>rAging('invoice'),ap:()=>rAging('bill')})[k]();r.title=r.title||REPORT_TITLES[k]();r.sub=r.sub??(k==='ar'||k==='ap'?`As of ${fmtDate(today())}`:k==='tb'?`As of ${fmtDate(S.rep.to)}`:`${fmtDate(S.rep.from)} – ${fmtDate(S.rep.to)}`);saveFile(r.name+'.pdf',new Blob([reportsPdf([r])],{type:'application/pdf'}))}

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
    try{for(const k of keys){Object.assign(S.rep,{tab:k,period:'custom',from,to,compare:k==='bs'?(cmp==='prev'?'prevperiod':cmp):cmp});const r=({pl:rPL,bs:rBS,cf:rCF,tb:rTB,ar:()=>rAging('invoice'),ap:()=>rAging('bill')})[k]();r.title=r.title||REPORT_TITLES[k]();r.sub=r.sub??(k==='ar'||k==='ap'?`As of ${fmtDate(today())}`:k==='tb'?`As of ${fmtDate(to)}`:'');out.push(r)}}
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
function rTBAdj(){
  const to=S.rep.to,fy=fyStartOf(to),isAdj=e=>e.adjusting&&!e.reversalOf&&e.date>=fy&&e.date<=to,adjIds=new Set(S.entries.filter(isAdj).map(e=>e.id));
  const sums=new Map();
  for(const p of postings()){
    const a=acct(p.account);if(!a)continue;
    const from=isPL(a.type)?fy:null;if((from&&p.date<from)||p.date>to)continue;
    const x=sums.get(p.account)||{u:0,j:0};if(adjIds.has(p.e.id))x.j+=p.debit-p.credit;else x.u+=p.debit-p.credit;sums.set(p.account,x);
  }
  const rows=[],tot=[0,0,0];
  for(const a of sortAccts(S.accounts)){
    const x=sums.get(a.id);if(!x)continue;const u=r2(x.u),j=r2(x.j),t=r2(u+j);if(Math.abs(u)<0.005&&Math.abs(j)<0.005)continue;
    rows.push({cls:'item',label:(a.code?a.code+' ':'')+a.name,vals:[u,j,t],acct:a.id});tot[0]+=u;tot[1]+=j;tot[2]+=t;
  }
  const re=-fNet(null,addDays(fy,-1));
  if(Math.abs(re)>=0.005){rows.push({cls:'item',label:W('Retained earnings'),vals:[r2(re),0,r2(re)]});tot[0]+=re;tot[2]+=re}
  rows.push({cls:'grand',label:'Total (debits less credits)',vals:tot.map(r2)});
  const n=adjIds.size;
  const r=colReport({title:'Working trial balance',sub:`As of ${fmtDate(to)} · income and expenses from ${fmtDate(fy)} · debits positive, credits negative`,C:{cols:[{label:'Before adjustments'},{label:'Adjustments'},{label:'Adjusted balance'}]},rows,name:`working-trial-balance_${to}`});
  r.html=r.html.replace(/<\/div>$/,`<div class="muted" style="font-size:12.5px;padding:8px 16px 14px">${n} adjusting entr${n===1?'y':'ies'}. Mark a journal entry as adjusting when you enter it.</div></div>`);
  return r;
}
