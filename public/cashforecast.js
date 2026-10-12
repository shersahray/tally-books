'use strict';
/* ---------- Cash flow forecast (Reports → Cash flow forecast, Thrive plan) ----------
   Like QuickBooks Online's Cash flow planner: today's bank balance, then the money expected in and out over the
   next 30, 60 or 90 days. This file gathers the lines from the books; the arithmetic is in forecast.js
   (TallyForecast), which the tests check. Settings (how it's worked out, planned items, lines left out) are kept
   in the company's settings as cashForecast, so everyone at the firm sees the same forecast. */

const FC_SOURCE={invoice:'Invoice',bill:'Bill',recurring:'Recurring',payroll:'Payroll (estimated)',remit:'Source deductions',tax:'Sales tax',planned:'Planned'};
const FC_EVERY=[['once','Once'],['week','Every week'],['month','Every month'],['quarter','Every quarter'],['year','Every year']];
let LAST_FC=null; // the forecast last drawn, for the chart's hover
const FC_ASKED=new Set(); // currencies whose Bank of Canada rate has been asked for (asked once per day)
S.fcOpen=new Set(); // weeks opened in the table
const fcCan=()=>!!(ME&&ME.role!=='client'&&!ME.readOnly&&perm('reports','edit'));
/** How the forecast is worked out: saved settings, with this screen's unsaved changes on top (people who can't save settings still get to try them). */
const fcCfg=()=>({days:30,overdue:'week',late:false,cards:false,planned:[],off:[],...(S.company.cashForecast||{}),...(S.rep.fcLocal||{})});
async function fcSave(patch,msg){
  S.rep.fcLocal={...(S.rep.fcLocal||{}),...patch};
  if(!fcCan()){renderMain();return true}
  const ok=await putCompany({...strip(S.company),cashForecast:{...fcCfg()}});
  if(ok){S.rep.fcLocal={};if(msg)toast(msg)}else renderMain();
  return ok;
}

/** A bank or card account's balance today in Canadian dollars. A foreign account is converted at the latest
    Bank of Canada rate Sumlora has (asked for once); until it arrives, at the rates it was recorded at. */
function fcAcctBal(a){
  const sign=a.detail==='card'?-1:1,cad=r2(sign*bal(a.id));
  if(!a.currency||a.currency==='CAD')return{cad};
  const t=today(),fb=r2(sign*(debitNormal(a.type)?1:-1)*acctFxBal(a.id)),rate=cachedRate(a.currency,t),hit=FXC.get(a.currency+'|'+t);
  if(!rate&&!FC_ASKED.has(a.currency+t)){FC_ASKED.add(a.currency+t);getRate(a.currency,t).then(r=>{if(r&&r.rate&&S.view==='reports'&&S.rep.tab==='fc')renderMain()})}
  return rate?{cad:r2(fb*rate),fx:{cur:a.currency,amt:fb,rate,date:hit&&hit.date||t}}:{cad,fx:{cur:a.currency,amt:fb,rate:0}};
}

/** Every line of the forecast, before anything is left out. */
function fcItems(cfg,t,end){
  const F=TallyForecast,items=[],cards=!!cfg.cards;
  const cashIds=new Set(S.accounts.filter(a=>a.detail==='bank'||(cards&&a.detail==='card')).map(a=>a.id));
  // Open invoices and bills, in Canadian dollars at the rate they were recorded at.
  const lateDays=cfg.late?fcLateDays():null;
  const docs=S.docs.filter(d=>d.kind==='invoice'||d.kind==='bill').map(d=>{const st=docStatus(d);return{key:(d.kind==='invoice'?'inv:':'bill:')+d.id,kind:d.kind,id:d.id,contactId:d.contactId,due:d.due||d.date,amount:r2(st.bal*(d.currency?(+d.fx||1):1)),label:{kind:d.kind,number:d.number||'',who:contactName(d.contactId)}}});
  items.push(...F.docItems(docs,{today:t,end,overdue:cfg.overdue,lateDays}));
  // Recurring templates: only what moves money in the accounts counted (a card expense waits for the card payment).
  const rec=[];
  for(const r of S.recurring){
    let amt=0,lag=0;
    if(r.kind==='invoice'||r.kind==='bill'){if(r.contactId&&contactCur(r.contactId))continue;amt=(r.kind==='invoice'?1:-1)*recTotal(r);lag=r.terms===''||r.terms==null?+S.company.terms||0:+r.terms}
    else if(r.kind==='deposit'||r.kind==='expense'){if(!cashIds.has(r.bank))continue;amt=(r.kind==='deposit'?1:-1)*recTotal(r)}
    else if(r.kind==='transfer')amt=(cashIds.has(r.to)?+r.amount:0)-(cashIds.has(r.from)?+r.amount:0);
    else if(r.kind==='journal')amt=(r.lines||[]).filter(l=>cashIds.has(l.account)).reduce((s,l)=>s+(+l.debit||0)-(+l.credit||0),0);
    if(Math.abs(r2(amt))>=0.01)rec.push({...r,label:{name:r.name,kind:r.kind},amount:r2(amt),lag});
  }
  items.push(...F.recurringItems(rec,{today:t,end}));
  // Payroll: the next pay runs on each schedule, like the last one, and the source deductions they'll owe.
  if(feat('payroll')&&S.payruns.length&&typeof runTotals==='function'){
    const last={};for(const r of S.payruns.slice().sort(runOrder))last[r.freq||'biweekly']=r;
    const schedules=Object.entries(last).map(([freq,r])=>{const x=runTotals(r);return{freq,last:{payDate:r.payDate,net:x.net,cra:x.cra,rq:x.rq}}});
    const unpaid=remittances().filter(x=>x.bal>0.004).map(x=>({agency:x.agency,key:x.key,due:x.due,amount:x.bal}));
    items.push(...F.payrollItems({schedules,unpaid,remitFreq:payCfg().remitFreq,today:t,end}));
  }
  // Sales tax: each return not filed yet, on its due date. Returns more than 90 days overdue are left out:
  // books that never use Sumlora's filing would otherwise show years of returns as due today.
  if(typeof taxesInUse==='function'&&taxAcctFor('gst')){
    const since=addDays(t,-90),list=[];
    for(const k of taxesInUse())for(const p of filingPeriods(k)){
      if(filingFor(k,p.from,p.to)||p.due<since||p.due>end)continue;
      const w=worksheet(k,p.from,p.to);if(!w)continue;
      list.push({key:`tax:${k}:${p.to}`,tax:k,from:p.from,to:p.to,due:p.due,amount:r2(w.vals[BAL_LINE[k]]??w.vals[NET_LINE[k]]??0)});
    }
    items.push(...F.taxItems(list,{today:t,end}));
  }
  items.push(...F.plannedItems(cfg.planned,{today:t,end}));
  return items;
}
/** Each customer's average days late on their recent paid invoices (the last payment's date against the due date). */
function fcLateDays(){
  const lastPay={};for(const e of S.entries)if(e.applyTo&&(!lastPay[e.applyTo]||e.date>lastPay[e.applyTo]))lastPay[e.applyTo]=e.date;
  return TallyForecast.averageLate(S.docs.filter(d=>d.kind==='invoice'&&d.due&&lastPay[d.id]&&docStatus(d).bal<=0.004).map(d=>({contactId:d.contactId,due:d.due,paid:lastPay[d.id]})));
}

/** The whole forecast for the screen, the CSV and the PDF. */
function fcBuild(){
  const cfg=fcCfg(),t=today(),days=TallyForecast.DAYS.includes(+cfg.days)?+cfg.days:30,end=addDays(t,days);
  const banks=sortAccts(S.accounts.filter(a=>a.detail==='bank'&&(a.active!==false||Math.abs(bal(a.id))>=0.005))).map(a=>({a,...fcAcctBal(a)}));
  const cards=sortAccts(S.accounts.filter(a=>a.detail==='card'&&(a.active!==false||Math.abs(bal(a.id))>=0.005))).map(a=>({a,...fcAcctBal(a)}));
  const bankTotal=r2(banks.reduce((s,x)=>s+x.cad,0)),cardTotal=r2(-cards.reduce((s,x)=>s+x.cad,0)); // cardTotal: owed on cards
  const start=r2(bankTotal-(cfg.cards?cardTotal:0));
  const p=TallyForecast.project({start,items:fcItems(cfg,t,end),today:t,days,off:cfg.off});
  return{...p,cfg,banks,cards,bankTotal,cardTotal};
}

/* ---------- labels ---------- */
function fcDesc(x){
  const L=x.label||{},nm=s=>s?` <span translate="no">${esc(s)}</span>`:'';
  // The type is shown beside it (Invoice, Bill), so just the number and who.
  if(x.source==='invoice'||x.source==='bill')return [L.number?`<span class="mono">#${esc(L.number)}</span>`:'',L.who?nm(L.who).trim():''].filter(Boolean).join(' · ');
  if(x.source==='recurring')return `<span translate="no">${esc(L.name)}</span>`;
  if(x.source==='payroll')return `<span>${esc(PR.FREQ_LABEL[x.label]||x.label)}</span>`;
  if(x.source==='remit')return `<span>${x.label==='rq'?'Revenu Québec':'CRA'}</span> · <span>${esc(x.period)}</span>`;
  if(x.source==='tax')return `<span>${esc(returnName(x.label))}</span> · ${fmtDate(x.from)} – ${fmtDate(x.to)}`;
  return `<span translate="no">${esc(x.label)}</span>`;
}
const fcText=x=>{const d=document.createElement('div');d.innerHTML=fcDesc(x);return d.textContent};
function fcNote(x){
  if(x.note==='overdue')return x.source==='invoice'?`Overdue since ${fmtDate(x.due)}: expected within 7 days`:'Overdue: counted as paid today';
  if(x.note==='late')return `Due ${fmtDate(x.due)}, plus this customer’s average days late`;
  if(x.note==='sofar')return 'Period still open: tax so far';
  if(x.source==='recurring'&&x.made!==x.date)return `Made ${fmtDate(x.made)}, paid by its terms`;
  if(x.est)return 'Estimated from the last pay run';
  return '';
}

/* ---------- chart: the projected balance each day, with $0 and the lowest point ---------- */
function fcChart(p){
  const W=960,H=300,L=62,R=14,TOP=16,B=30,cw=W-L-R,ch=H-TOP-B,n=p.daily.length-1;
  const vals=p.daily.map(d=>d.balance),lo=Math.min(0,...vals),hi=Math.max(0,...vals),span=Math.max(1,hi-lo);
  const mag=Math.pow(10,Math.floor(Math.log10(span))),step=[1,2,2.5,5,10].map(s=>s*mag).find(s=>span/s<=5)||mag*10;
  const y0=Math.floor(lo/step)*step,y1=Math.max(y0+step,Math.ceil(hi/step)*step);
  const x=i=>L+(n?cw*i/n:0),y=v=>TOP+ch-(v-y0)/(y1-y0)*ch;
  const kfmt=v=>Math.abs(v)>=1000?(v/1000).toLocaleString(LOC(),{maximumFractionDigits:1})+'k':v.toLocaleString(LOC());
  let g='';for(let v=y0;v<=y1+1e-9;v+=step)if(Math.abs(v)>1e-9)g+=`<line class="grid" x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end">${kfmt(v)}</text>`;
  const xl=p.weeks.map(w=>{const i=TallyForecast.daysBetween(p.today,w.from);return `<line class="tick" x1="${x(i)}" x2="${x(i)}" y1="${TOP+ch}" y2="${TOP+ch+4}"/><text x="${x(i)}" y="${H-10}" text-anchor="${i===0?'start':'middle'}">${pd(w.from).toLocaleDateString(LOC(),{month:'short',day:'numeric'})}</text>`}).join('');
  // A step line: the balance holds all day and changes when money moves.
  let d=`M${x(0)},${y(vals[0])}`;for(let i=1;i<=n;i++)d+=`H${x(i)}V${y(vals[i])}`;
  const li=p.daily.findIndex(z=>z.date===p.low.date),lx=x(li),ly=y(p.low.balance),right=lx>W-170;
  const colon=isFr()?'\u00a0:':':',lowLbl=`${T('Lowest')}${colon} ${money(p.low.balance)} · ${pd(p.low.date).toLocaleDateString(LOC(),{month:'short',day:'numeric'})}`;
  return `<div class="fc-chart"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T(`Projected bank balance, lowest ${money(p.low.balance)} on ${fmtDate(p.low.date)}`))}">${g}
    <line class="fc-zero" x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}"/><text x="${L-8}" y="${y(0)+4}" text-anchor="end" class="fc-zl">0</text>${xl}
    <path class="fc-line" d="${d}"/>
    <circle class="fc-low${p.low.balance<0?' neg':''}" cx="${lx}" cy="${ly}" r="5"/><text class="fc-lowl" x="${right?lx-9:lx+9}" y="${ly<TOP+24?ly+18:ly-9}" text-anchor="${right?'end':'start'}">${esc(lowLbl)}</text>
    <line class="fc-cross" x1="0" x2="0" y1="${TOP}" y2="${TOP+ch}" hidden/><circle class="fc-dot" r="4" hidden/>
    <rect class="fc-hit" x="${L}" y="${TOP}" width="${cw}" height="${ch}" fill="transparent" data-l="${L}" data-cw="${cw}" data-n="${n}" data-t="${TOP}" data-ch="${ch}" data-y0="${y0}" data-y1="${y1}"/></svg>
    <div class="fc-tip" hidden></div></div>`;
}
/** Hover: a line across the chart and the day's balance and money moving. */
function fcHover(m,p){
  const svg=$('.fc-chart svg',m);if(!svg)return;
  const hit=$('.fc-hit',svg),cross=$('.fc-cross',svg),dot=$('.fc-dot',svg),tip=$('.fc-tip',m),box=svg.parentElement;
  const L=+hit.dataset.l,cw=+hit.dataset.cw,n=+hit.dataset.n,vb=svg.viewBox.baseVal;
  const by={};for(const x of p.items)if(!x.off)(by[x.date]=by[x.date]||[]).push(x);
  const H=+hit.dataset.ch,T0=+hit.dataset.t,y0=+hit.dataset.y0,y1=+hit.dataset.y1,yv=v=>T0+H-(v-y0)/(y1-y0)*H;
  const show=ev=>{
    const r=svg.getBoundingClientRect(),sx=(ev.clientX-r.left)*vb.width/r.width,i=Math.max(0,Math.min(n,Math.round((sx-L)/cw*n))),day=p.daily[i];
    const px=L+(n?cw*i/n:0);
    cross.setAttribute('x1',px);cross.setAttribute('x2',px);cross.hidden=false;
    dot.setAttribute('cx',px);dot.setAttribute('cy',yv(day.balance));dot.hidden=false;
    const its=by[day.date]||[];
    tip.innerHTML=`<b>${fmtDate(day.date)}</b><div>${esc(T('Balance'))}${isFr()?'&nbsp;:':':'} ${mcell(day.balance)}</div>${its.slice(0,5).map(x=>`<div class="muted"><span>${FC_SOURCE[x.source]}</span> ${fcDesc(x)}: ${mcell(x.amount)}</div>`).join('')}${its.length>5?`<div class="muted">+${its.length-5}</div>`:''}`;
    tip.hidden=false;const left=px*r.width/vb.width;tip.style.left=Math.min(Math.max(0,left+12),box.clientWidth-tip.offsetWidth)+'px';
  };
  hit.addEventListener('mousemove',show);hit.addEventListener('mouseleave',()=>{cross.hidden=true;dot.hidden=true;tip.hidden=true});
}

/* ---------- the report ---------- */
function rForecast(){
  const p=fcBuild(),c=p.cfg,can=fcCan();
  const title='Cash flow forecast',sub=`Next ${p.days} days from ${fmtDate(p.today)}`;
  const fxNotes=[...p.banks,...(c.cards?p.cards:[])].filter(x=>x.fx).map(x=>`<div><span translate="no">${esc(x.a.name)}</span>: ${moneyC(x.fx.amt,x.fx.cur)} ${x.fx.rate?`<span>at ${x.fx.rate} (Bank of Canada, ${fmtDate(x.fx.date)})</span>`:'<span>at the rates it was recorded at</span>'} = ${money(x.cad*(x.a.detail==='card'?-1:1))}</div>`).join('');
  const warn=p.below?`<div class="banner err" role="alert"><span><b>Expected to drop below $0 on ${fmtDate(p.below)}.</b> <span>The lowest point is ${money(p.low.balance)} on ${fmtDate(p.low.date)}.</span></span></div>`:'';
  const chips=`<div class="chips">
    <div class="chip"><div class="lbl">${c.cards?'Bank balance less credit cards today':'Bank balance today'}</div><div class="val">${mcell(p.start)}</div><div class="lbl">${p.banks.length} bank account${p.banks.length===1?'':'s'}</div></div>
    <div class="chip"><div class="lbl">Money in</div><div class="val">${money(p.totalIn)}</div></div>
    <div class="chip"><div class="lbl">Money out</div><div class="val">${money(p.totalOut)}</div></div>
    <div class="chip"><div class="lbl">Lowest point</div><div class="val">${mcell(p.low.balance)}</div><div class="lbl">${fmtDate(p.low.date)}</div></div>
    <div class="chip"><div class="lbl">Balance in ${p.days} days</div><div class="val">${mcell(p.daily[p.daily.length-1].balance)}</div></div>
    ${p.cards.length?`<div class="chip"><div class="lbl">Owing on credit cards</div><div class="val">${money(p.cardTotal)}</div><div class="lbl">${c.cards?'Taken off the starting balance':'Not in the forecast'}</div></div>`:''}</div>`;
  const rows=p.weeks.map((w,i)=>{
    const open=S.fcOpen.has(w.from),k=w.items.length;
    return `<tbody><tr class="click fc-wk" data-fcwk="${w.from}" aria-expanded="${open}"><td><span class="fc-caret" aria-hidden="true">${open?'▾':'▸'}</span> ${fmtDate(w.from)} – ${fmtDate(w.to)} <span class="muted">· <span>${k} item${k===1?'':'s'}</span></span></td><td class="n">${w.in?money(w.in):'<span class="muted">—</span>'}</td><td class="n">${w.out?money(w.out):'<span class="muted">—</span>'}</td><td class="n"><b>${mcell(w.end)}</b></td></tr>
    ${open?(k?w.items.map(x=>{const note=fcNote(x);return `<tr class="fc-item${x.off?' off':''}"><td><label class="check"><input type="checkbox" data-fcoff="${esc(x.key)}" ${x.off?'':'checked'} aria-label="Include in the forecast"> <span class="muted fc-date">${fmtDate(x.date)}</span> <span class="pill quiet">${FC_SOURCE[x.source]}</span> <span>${fcDesc(x)}</span></label>${note?`<div class="muted fc-note">${note}</div>`:''}</td><td class="n">${x.amount>0?money(x.amount):''}</td><td class="n">${x.amount<0?money(-x.amount):''}</td><td></td></tr>`}).join(''):'<tr class="fc-item"><td colspan="4" class="muted">Nothing expected this week.</td></tr>'):''}</tbody>`}).join('');
  const off=p.items.filter(x=>x.off).length;
  const planned=(c.planned||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const html=`<div class="report fc" style="max-width:none">${rh(title,esc(sub))}${warn}${chips}${fxNotes?`<div class="muted fc-fx">${fxNotes}</div>`:''}
    <div class="fc-panel">${fcChart(p)}</div>
    <div class="tbl-wrap"><table class="fc-tbl"><thead><tr><th>Week</th><th class="n">Money in</th><th class="n">Money out</th><th class="n">Ending balance</th></tr></thead>
      <tbody><tr><td class="muted">Starting balance, ${fmtDate(p.today)}</td><td></td><td></td><td class="n"><b>${mcell(p.start)}</b></td></tr></tbody>${rows}</table></div>
    ${off?`<div class="muted fc-offnote"><span>${off} item${off===1?' is':'s are'} left out.</span> <button class="link" data-fcact="allon">Include everything again</button></div>`:''}
    <div class="fc-plan"><h3>Planned money in and out <span class="muted" style="font-weight:400;font-size:13px">Money you expect that isn’t in the books yet, like a loan, a tax refund or a large purchase.</span></h3>
      ${planned.length?`<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Date</th><th>How often</th><th class="n">Money in</th><th class="n">Money out</th></tr></thead><tbody>${planned.map(x=>`<tr class="${can?'click':''}" ${can?`data-fcplan="${esc(x.id)}"`:''}><td translate="no">${esc(x.name)}</td><td>${fmtDate(x.date)}${x.end?` <span class="muted">– ${fmtDate(x.end)}</span>`:''}</td><td>${fcEveryLabel(x)}</td><td class="n">${x.dir==='in'?money(x.amount):''}</td><td class="n">${x.dir==='out'?money(x.amount):''}</td></tr>`).join('')}</tbody></table></div>`:'<div class="muted" style="padding:4px 0 8px">No planned items yet.</div>'}
      ${can?'<button class="btn sm" data-fcplan="">+ Planned item</button>':''}</div>
    <div class="muted fc-how">Invoices count on their due date, and bills too; overdue bills count as paid today. Recurring transactions count on each date they’re made (invoices and bills by their terms). Payroll repeats the last pay run on each pay schedule, with source deductions due the 15th of the next month. Sales tax returns not yet filed count on their due date. Foreign-currency amounts are in Canadian dollars.</div></div>`;
  // CSV and PDF: the weeks, each with its items.
  const csv=[['Date','Type','Description','Money in','Money out','Balance','Included']];
  csv.push([p.today,'','Starting balance','','',p.start,'']);
  const prow=[{cls:'item',label:`${tl('Starting balance')}, ${fmtDate(p.today)}`,cells:['','',p.start]}];
  for(const w of p.weeks){
    prow.push({cls:'tot',label:`${fmtDate(w.from)} – ${fmtDate(w.to)}`,cells:[w.in,w.out,w.end]});
    for(const x of w.items){csv.push([x.date,FC_SOURCE[x.source],fcText(x),x.amount>0?x.amount:'',x.amount<0?-x.amount:'','',x.off?'No':'Yes']);if(!x.off)prow.push({cls:'item',data:true,label:`${fmtDate(x.date)}  ${tl(FC_SOURCE[x.source])} · ${fcText(x)}`,cells:[x.amount>0?x.amount:'',x.amount<0?-x.amount:'','']})}
    csv.push([w.to,'','Week total',w.in,w.out,w.end,'']);
  }
  LAST_FC=p;
  return{html,csv,name:`cash-flow-forecast_${p.today}`,title,sub,head:['Money in','Money out','Balance'],rows:prow,p};
}
const fcEveryLabel=x=>x.every==='once'||!x.every?'Once':x.n>1?`Once every ${x.n} ${REC_EVERY[x.every][1]}`:`Every ${REC_EVERY[x.every][0]}`;

/** The forecast's toolbar on the Reports page, in place of the period. */
function fcToolbar(){
  const c=fcCfg();
  return `<select id="fcDays" aria-label="How far ahead">${TallyForecast.DAYS.map(d=>`<option value="${d}" ${+c.days===d?'selected':''}>Next ${d} days</option>`).join('')}</select>
    <label class="flabel" for="fcOverdue">Overdue invoices</label><select id="fcOverdue"><option value="week" ${c.overdue!=='skip'?'selected':''}>Expect them within 7 days</option><option value="skip" ${c.overdue==='skip'?'selected':''}>Leave them out</option></select>
    <label class="check"><input type="checkbox" id="fcLate" ${c.late?'checked':''}> Use each customer’s average days late</label>
    <label class="check"><input type="checkbox" id="fcCards" ${c.cards?'checked':''}> Take credit card balances off</label>`;
}
function bindForecast(m){
  if(!(S.view==='reports'&&S.rep.tab==='fc'))return;
  const on=(id,fn)=>{const el=$('#'+id,m);if(el)el.onchange=()=>fn(el)};
  on('fcDays',el=>fcSave({days:+el.value}));
  on('fcOverdue',el=>fcSave({overdue:el.value}));
  on('fcLate',el=>fcSave({late:el.checked}));
  on('fcCards',el=>fcSave({cards:el.checked}));
  $$('[data-fcoff]',m).forEach(cb=>cb.onchange=()=>{const k=cb.dataset.fcoff,off=new Set(fcCfg().off);if(cb.checked)off.delete(k);else off.add(k);fcSave({off:[...off].slice(-500)})});
  if(LAST_FC)fcHover(m,LAST_FC);
}
function fcClick(e,t,d){
  if(!(S.view==='reports'&&S.rep.tab==='fc'))return false;
  if(d.fcwk){if(S.fcOpen.has(d.fcwk))S.fcOpen.delete(d.fcwk);else S.fcOpen.add(d.fcwk);renderMain();return true}
  if(d.fcplan!==undefined){fcPlanForm((fcCfg().planned||[]).find(x=>x.id===d.fcplan)||null);return true}
  if(d.fcact==='allon'){fcSave({off:[]});return true}
  return false;
}
function fcPlanForm(x){
  const v=x||{dir:'out',every:'once',n:1,date:addDays(today(),7)};
  const f=openModal(x?'Planned item':'New planned item',`<div class="fields">
    ${fld('fpName','Name',`<input id="fpName" maxlength="80" value="${esc(v.name||'')}" placeholder="e.g. Equipment loan">`,true)}
    ${fld('fpDir','Money',`<select id="fpDir"><option value="in" ${v.dir==='in'?'selected':''}>Money in</option><option value="out" ${v.dir==='out'?'selected':''}>Money out</option></select>`)}
    ${fld('fpAmt','Amount',`<input type="number" id="fpAmt" step="0.01" min="0" inputmode="decimal" value="${v.amount||''}">`)}
    ${fld('fpDate',x&&x.every!=='once'?'First date':'Date',`<input type="date" id="fpDate" value="${esc(v.date)}">`)}
    ${fld('fpEvery','How often',`<select id="fpEvery">${FC_EVERY.map(([k,l])=>`<option value="${k}" ${v.every===k?'selected':''}>${l}</option>`).join('')}</select>`)}
    ${fld('fpN','Every how many',`<input type="number" id="fpN" min="1" max="12" step="1" value="${v.n||1}">`)}
    ${fld('fpEnd','End date (optional)',`<input type="date" id="fpEnd" value="${esc(v.end||'')}">`)}</div>`,saveFoot(!!x));
  const sync=()=>{const once=$('#fpEvery',f).value==='once';$('#fpN',f).closest('.field').hidden=once;$('#fpEnd',f).closest('.field').hidden=once};
  $('#fpEvery',f).onchange=sync;sync();
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this planned item?',x.name))return;if(await fcSave({planned:fcCfg().planned.filter(p=>p.id!==x.id)},'Planned item deleted'))closeModal()};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const name=$('#fpName',f).value.trim(),amount=r2($('#fpAmt',f).value),date=$('#fpDate',f).value,every=$('#fpEvery',f).value,n=parseInt($('#fpN',f).value)||1,end=every==='once'?'':$('#fpEnd',f).value;
    if(!name)return f.err('Give the planned item a name.');
    if(!(amount>0))return f.err('Enter the planned amount (more than $0).');
    if(!date)return f.err('Enter the date of the planned item.');
    if(every!=='once'&&(n<1||n>12))return f.err('Repeat every 1 to 12 weeks, months, quarters or years.');
    if(end&&end<date)return f.err('The planned item’s end date must be on or after its first date.');
    const item={id:x?x.id:uid(),name,dir:$('#fpDir',f).value,amount,date,every,...(every!=='once'?{n}:{}),...(end?{end}:{})};
    const list=(fcCfg().planned||[]).filter(p=>p.id!==item.id);
    if(!x&&list.length>=100)return f.err('At most 100 planned items.');
    if(await fcSave({planned:[...list,item]},x?'Planned item saved':'Planned item added'))closeModal();
  };
}
