'use strict';
/* ---------- payroll: employees, pay runs, pay stubs, remittances ----------
   The deduction maths is in payroll-calc.js (TallyPayroll). This file is the screens and the postings.
   Every pay run posts one journal entry:
     Dr Wages (gross)  Dr Employer payroll taxes
     Cr Payroll liabilities – CRA  Cr Payroll liabilities – Revenu Québec  Cr Other payroll deductions  Cr Bank (net pay) */
const PR=TallyPayroll;
S.pay={tab:'runs'};
const PAY_ACCTS=[['wages','Expense','7100','Wages and salaries','Salaires'],['payroll_tax','Expense','7110','Employer payroll taxes','Cotisations de l’employeur'],
  ['payroll_cra','Liability','2300','Payroll liabilities – CRA','Retenues à la source à payer – ARC'],['payroll_rq','Liability','2310','Payroll liabilities – Revenu Québec','Retenues à la source à payer – Revenu Québec'],
  ['payroll_other','Liability','2320','Other payroll deductions payable','Autres retenues salariales à payer'],
  ['vacation_payable','Liability','2330','Vacation pay payable','Indemnités de vacances à payer'],
  ['wsib_payable','Liability','2335','Workers’ compensation payable','Cotisations à la CSPAAT à payer'],['eht_payable','Liability','2336','Employer health tax payable','Impôt-santé des employeurs à payer'],
  ['wsib','Expense','7155','Workers’ compensation premiums','Cotisations à la CSPAAT'],['eht','Expense','7150','Employer health tax','Impôt-santé des employeurs']];
DETAILS.Liability.push(['payroll_cra','Payroll liabilities – CRA'],['payroll_rq','Payroll liabilities – Revenu Québec'],['payroll_other','Other payroll deductions'],['vacation_payable','Vacation pay payable'],['wsib_payable','Workers’ compensation payable'],['eht_payable','Employer health tax payable']);
DETAILS.Expense.push(['wages','Wages and salaries'],['payroll_tax','Employer payroll taxes'],['wsib','Workers’ compensation premiums'],['eht','Employer health tax']);
Object.assign(TLABEL,{payrun:'Payroll',payremit:'Payroll remittance'});
const AGENCY_NAME={cra:'CRA',rq:'Revenu Québec'};
const DED_KEYS=PR.EMPLOYEE_ITEMS.map(x=>x[0]),ER_KEYS=PR.EMPLOYER_ITEMS.map(x=>x[0]);

const payCfg=()=>({hsfRate:1.65,remitFreq:'monthly',...(S.company.payroll||{})});
const employee=id=>S.employees.find(e=>e.id===id);
const provName=k=>(typeof PROVS!=='undefined'&&PROVS[k]?PROVS[k].name:k);
const payOf=e=>e.payType==='hourly'?`${money(e.rate)}/hour`:`${money(e.rate)}/year`;
const sumObj=(a,b)=>{for(const[k,v]of Object.entries(b||{}))a[k]=r2((a[k]||0)+(+v||0));return a};
const runOrder=(a,b)=>a.payDate.localeCompare(b.payDate)||(a.created||0)-(b.created||0);
/* A void pay run stays in the list (with its reversing entry) but counts for nothing: not in year-to-date amounts,
   remittances, vacation pay, holiday pay, WSIB, EHT, T4s or ROEs. */
const liveRuns=()=>S.payruns.filter(r=>!r.void);

/* ---------- vacation pay and holiday pay ----------
   Vacation pay is worked out on regular, holiday, overtime and other pay, and on non-discretionary bonuses.
   "accrue": set aside each pay (a liability) and paid out when the employee takes vacation or leaves.
   "each": added to every pay. "salary": the salary simply continues while they're on vacation. */
const VAC_MODES=[['accrue','Set it aside, and pay it when they take vacation or leave'],['each','Add it to every pay'],['salary','None: their salary continues while they’re on vacation']];
// Employees saved before vacation pay existed have no method yet: nothing is set aside until one is chosen.
const vacMode=e=>['accrue','each','salary'].includes(e.vacMode)?e.vacMode:'salary';
const vacModeDefault=e=>['accrue','each','salary'].includes(e.vacMode)?e.vacMode:(e.payType==='hourly'?'accrue':'salary');
function vacRateFor(e,date){
  if(e.vacRate!==''&&e.vacRate!=null&&!isNaN(+e.vacRate))return{rate:+e.vacRate,custom:true};
  return PR.vacationRate(e.prov,e.hireDate,date);
}
/** Vacation pay owed to an employee: the opening amount plus what was set aside, minus what was paid out of it. */
function vacBalance(empId,until,inclusive){
  const e=employee(empId)||{};let bal=+e.vacOpening||0;
  for(const r of liveRuns())for(const l of r.lines){
    if(l.employeeId!==empId)continue;
    if(until){const c=runOrder(r,until);if(c>0||(c===0&&!inclusive)||(until.id&&r.id===until.id&&!inclusive))continue}
    bal+=(+l.vacAccrued||0)-(l.vacMode==='accrue'?+l.vacPay||0:0);
  }
  return r2(bal);
}
const runPeriod=r=>r.from&&r.to?[r.from,r.to]:defaultPeriod(r.freq||'biweekly',r.payDate);
/** Earnings that count toward holiday pay, pay period by pay period. Ontario adds vacation pay paid. */
function holidayEarnings(empId,prov){
  const out=[];
  for(const r of liveRuns())for(const l of r.lines){
    if(l.employeeId!==empId)continue;
    const[from,to]=runPeriod(r);
    out.push({from,to,amount:r2((l.regular??l.gross)+(prov==='ON'?(+l.vacPay||0):0))});
  }
  return out;
}
const WORKDAYS={weekly:5,biweekly:10,semimonthly:10.83,monthly:21.67};

/* ---------- overtime ----------
   Hourly employees, and salaried ones marked eligible, get overtime at 1.5 times their regular rate for hours over
   the weekly threshold (Ontario: 44). The threshold comes from the province (PR.OVERTIME) unless the company set its own. */
const otApplies=e=>e.payType==='hourly'||!!e.otEligible;
const otRule=e=>PR.overtimeRule(e.prov,payCfg().otThreshold);
/** The regular hourly rate: the hourly rate, or for salary the pay per period over the usual hours per pay. */
const hourlyRate=(e,P)=>e.payType==='hourly'?+e.rate||0:(+e.hours>0?r2((+e.rate||0)/P/(+e.hours)*10000)/10000:0);

/* ---------- workers' compensation (WSIB) ----------
   Set up in Settings → Payroll: the account number, a rate per $100 of insurable earnings for each rate group, the
   year's maximum insurable earnings and how often to report. Each pay run works out the employer's premium. */
const wsibCfg=()=>{const w=payCfg().wsib||{};return{on:!!w.on,account:w.account||'',freq:w.freq||'quarterly',max:w.max===''||w.max==null?(PR.WSIB_MAX[+today().slice(0,4)]||''):+w.max,groups:w.groups||[]}};
/** The rate group for an employee: theirs, or the company's first. null when they aren't covered. */
function wsibGroup(e){const w=wsibCfg();if(!w.on||!w.groups.length||e.wsibGroup==='none')return null;return w.groups.find(g=>g.id===e.wsibGroup)||w.groups[0]}

/* Year-to-date for one employee: opening amounts entered on the employee, plus every pay run in that calendar year
   that comes before `until` (a pay run, or {payDate} for a new one). */
function ytdFor(empId,until,inclusive){
  const year=until.payDate.slice(0,4),e=employee(empId)||{};
  const y={gross:0,pensionable:0,insurable:0,rrsp:0,union:0,net:0,ded:{},er:{}};
  const o=e.openingYtd;
  if(o&&String(o.year)===year){
    const has=v=>v!==undefined&&v!==null&&v!=='';y.gross=+o.gross||0;y.pensionable=+(has(o.pensionable)?o.pensionable:o.gross)||0;y.insurable=+(has(o.insurable)?o.insurable:o.gross)||0;
    DED_KEYS.forEach(k=>y.ded[k]=+o[k]||0);y.er.qpip=+o.erQpip||0;y.rrsp=+o.rrsp||0;y.union=+o.union||0;
  }
  for(const r of liveRuns().sort(runOrder)){
    if(r.payDate.slice(0,4)!==year)continue;
    const before=runOrder(r,until)<0||(inclusive&&r.id===until.id);
    if(!before||(until.id&&r.id===until.id&&!inclusive))continue;
    for(const l of r.lines)if(l.employeeId===empId){
      y.bonus=r2((y.bonus||0)+(+l.bonus||0));y.benefits=r2((y.benefits||0)+benTotal(l));
      y.gross=r2(y.gross+l.gross);y.pensionable=r2(y.pensionable+(l.cppExempt?0:(l.pensionable??l.gross)));y.insurable=r2(y.insurable+(l.insurable??l.gross));
      y.rrsp=r2(y.rrsp+(+l.rrsp||0));y.union=r2(y.union+(+l.union||0));y.net=r2(y.net+l.net);sumObj(y.ded,l.ded);sumObj(y.er,l.er);
      y.vac=r2((y.vac||0)+(+l.vacPay||0));y.hol=r2((y.hol||0)+(+l.holiday||0));y.ot=r2((y.ot||0)+(+l.overtime||0));
      y.wsib=r2((y.wsib||0)+(+l.wsib?.insurable||0));
    }
  }
  return y;
}
/** Taxable benefits on a pay line (not paid in cash), in total and the insurable part. */
const benTotal=l=>r2(Object.values(l.benefits||{}).reduce((t,v)=>t+(+v||0),0));
const benInsurable=l=>r2(PR.BENEFIT_KINDS.filter(b=>b.ei).reduce((t,b)=>t+(+(l.benefits||{})[b.k]||0),0));
function calcFor(e,payDate,P,gross,ytd,x={}){
  return PR.calc({date:payDate,prov:e.prov,P,gross,bonus:x.bonus,benefits:x.benefits,pensionable:x.pensionable,insurable:x.insurable,qpipInsurable:x.qpipInsurable,rrsp:e.rrsp,union:e.union,td1Fed:e.td1Fed,td1Prov:e.td1Prov,td1Qc:e.td1Qc,
    extraTax:e.extraTax,extraQcTax:e.extraQcTax,dependants:e.dependants,cppExempt:e.cppExempt,eiExempt:e.eiExempt,qpipExempt:e.qpipExempt,
    hsfRate:payCfg().hsfRate,ytd:{bonus:ytd.bonus||0,pensionable:ytd.pensionable,cpp:ytd.ded.cpp,cpp2:ytd.ded.cpp2,qpp:ytd.ded.qpp,qpp2:ytd.ded.qpp2,ei:ytd.ded.ei,qpip:ytd.ded.qpip,erQpip:ytd.er.qpip}});
}
const lineDed=l=>r2(DED_KEYS.reduce((s,k)=>s+(+l.ded?.[k]||0),0)+(+l.rrsp||0)+(+l.union||0));
const lineEr=l=>r2(ER_KEYS.reduce((s,k)=>s+(+l.er?.[k]||0),0));
function runTotals(r){
  const t={gross:0,ded:0,net:0,er:0,cra:0,rq:0,other:0,vacAcc:0,vacOut:0,wsib:0};
  for(const l of r.lines){const sp=PR.remitSplit(l.ded,l.er);t.gross+=l.gross;t.ded+=lineDed(l);t.net+=l.net;t.er+=lineEr(l);t.cra+=sp.cra;t.rq+=sp.rq;t.other+=(+l.rrsp||0)+(+l.union||0);
    t.vacAcc+=+l.vacAccrued||0;if(l.vacMode==='accrue')t.vacOut+=+l.vacPay||0;t.wsib+=+l.wsib?.premium||0}
  for(const k in t)t[k]=r2(t[k]);
  t.cost=r2(t.gross-t.vacOut+t.vacAcc+t.er+t.wsib); // what the pay run costs the business: vacation pay counts when it's earned
  return t;
}

/* Payroll accounts are added the first time they're needed. An existing "7100 Wages" account is reused. */
function payAccounts(needRq,needVac,needWsib,needEht){
  const writes=[],ids={};
  for(const[detail,type,code,nameEn,nameFr]of PAY_ACCTS){
    const name=S.company.lang==='fr'?nameFr:nameEn;
    if((detail==='payroll_rq'&&!needRq)||(detail==='vacation_payable'&&!needVac)||(detail.startsWith('wsib')&&!needWsib)||(detail.startsWith('eht')&&!needEht)){ids[detail]=byDetail(detail)?.id;continue}
    let a=byDetail(detail);
    if(!a){
      const ex=S.accounts.find(x=>x.code===code&&x.type===type&&!x.detail);
      if(ex){writes.push({op:'set',collection:'accounts',id:ex.id,data:{...strip(ex),detail}});a=ex}
      else{const id=S.accounts.some(x=>x.id==='a'+code)?uid():'a'+code;const free=!S.accounts.some(x=>x.code===code);
        writes.push({op:'set',collection:'accounts',id,data:{code:free?code:'',name,type,detail,desc:'Added by Payroll',active:true}});a={id}}
    }
    ids[detail]=a.id;
  }
  return{writes,ids};
}

/* ---------- remittances ---------- */
function remitPeriod(date){
  const y=date.slice(0,4),m=+date.slice(5,7);
  if(payCfg().remitFreq==='quarterly'){const q=Math.ceil(m/3);return{key:`${y}-Q${q}`,label:`Q${q} ${y}`,due:PR.remittanceDue(`${y}-${pad(q*3)}-01`)}}
  return{key:date.slice(0,7),label:pd(date.slice(0,7)+'-01').toLocaleDateString(LOC(),{month:'long',year:'numeric'}),due:PR.remittanceDue(date)};
}
function remittances(){
  const m={};
  for(const r of liveRuns().sort(runOrder)){
    const p=remitPeriod(r.payDate);
    for(const ag of['cra','rq']){
      const k=ag+'|'+p.key;
      for(const l of r.lines){
        const items=[...PR.EMPLOYEE_ITEMS.filter(x=>x[2]===ag).map(x=>[x[1],+l.ded?.[x[0]]||0]),...PR.EMPLOYER_ITEMS.filter(x=>x[2]===ag).map(x=>[x[1],+l.er?.[x[0]]||0])];
        const amt=r2(items.reduce((s,x)=>s+x[1],0));if(!amt)continue;
        const x=m[k]=m[k]||{agency:ag,...p,owed:0,paid:0,gross:0,parts:{},emps:new Set(),lastRun:null};
        x.owed=r2(x.owed+amt);x.gross=r2(x.gross+l.gross);x.emps.add(l.employeeId);x.lastRun=r;
        items.forEach(([n,v])=>{if(v)x.parts[n]=r2((x.parts[n]||0)+v)});
      }
    }
  }
  for(const e of S.entries.filter(e=>e.type==='payremit')){
    const k=e.agency+'|'+e.period;
    const x=m[k]=m[k]||{agency:e.agency,key:e.period,label:e.periodLabel||e.period,due:'',owed:0,paid:0,gross:0,parts:{},emps:new Set(),lastRun:null};
    x.paid=r2(x.paid+(+e.amount||0));
  }
  return Object.values(m).map(x=>{const bal=r2(x.owed-x.paid);x.bal=bal;x.st=bal<=0.004?{k:'paid',label:'Paid'}:x.due&&x.due<today()?{k:'overdue',label:'Overdue'}:{k:"open",label:"Due"};
    x.lastEmps=x.lastRun?x.lastRun.lines.filter(l=>PR.remitSplit(l.ded,l.er)[x.agency]).length:0;return x})
    .sort((a,b)=>b.key.localeCompare(a.key)||a.agency.localeCompare(b.agency));
}
const overdueRemits=()=>liveRuns().length?remittances().filter(x=>x.st.k==='overdue').length:0;

/* ---------- views ---------- */
function vPayroll(){
  if(typeof feat==='function'&&!feat('payroll'))return head('Payroll','')+'<div class="panel"><div class="empty"><b>Payroll is off for this company</b>Payroll is part of the Thrive plan. On Seed and Grow, an owner can add the Payroll add-on in Settings → Features.</div></div>';
  const P=S.pay,t=today(),yr=t.slice(0,4);
  const act=S.employees.filter(e=>e.active!==false);
  const h=head('Payroll','Pay employees, print pay stubs and track what you owe CRA and Revenu Québec',
    `<button class="btn" data-pay-emp="new">+ Add employee</button><button class="btn primary" data-pay-run="new" ${act.length?'':'disabled'}>Run payroll</button>`)+
    `<div class="tabs" role="tablist">${[['runs','Pay runs'],['employees','Employees'],['remit','Remittances'],['yearend','Year-end (T4, RL-1)']].map(([k,v])=>`<button role="tab" data-ptab="${k}" aria-selected="${P.tab===k}">${v}</button>`).join('')}</div>`;
  if(P.tab==='yearend')return h+vYearEnd()+vEht();
  if(P.tab==='employees'){
    const list=S.employees.slice().sort((a,b)=>(a.active===false)-(b.active===false)||a.name.localeCompare(b.name));
    const vac=list.some(e=>vacMode(e)==='accrue'||vacBalance(e.id));
    const roes=list.reduce((n,e)=>n+(e.roes||[]).length,0);
    return h+`<div class="panel">${roes?`<div class="toolbar"><span class="grow muted">${roes===1?'1 record of employment saved.':`${roes} records of employment saved.`}</span><button class="btn sm" data-roelist>Records of employment (ROE XML)</button></div>`:''}<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Province</th><th>Pay schedule</th><th class="n">Pay</th><th class="n">Gross, ${yr}</th>${vac?'<th class="n" title="Vacation pay set aside and not yet paid">Vacation pay owed</th>':''}<th>Status</th></tr></thead><tbody>${list.length?list.map(e=>`<tr class="click" data-pay-emp="${e.id}"><td>${esc(e.name)} ${e.example?'<span class="pill ex">Example</span>':''}</td><td>${esc(provName(e.prov))}</td><td>${PR.FREQ_LABEL[e.freq]||''}</td><td class="n">${payOf(e)}</td><td class="n">${money(ytdFor(e.id,{payDate:t+'~'},false).gross)}</td>${vac?`<td class="n">${vacMode(e)==='accrue'||vacBalance(e.id)?money(vacBalance(e.id)):'<span class="muted">—</span>'}</td>`:''}<td>${e.active===false?`<span class="pill quiet">Inactive</span>${(e.roes||[]).length?' <span class="pill quiet">ROE</span>':''}`:'<span class="pill paid">Active</span>'}</td></tr>`).join(''):emptyRow(vac?7:6,'No employees yet','Add an employee with their TD1 amounts, then run payroll.')}</tbody></table></div></div>`;
  }
  if(P.tab==='remit'){
    const rs=remittances();
    return h+`<div class="panel"><div class="toolbar"><span class="grow muted">${payCfg().remitFreq==='quarterly'?'Quarterly remitter':'Regular (monthly) remitter'}: payment due the 15th of the month after ${payCfg().remitFreq==='quarterly'?'each quarter':'you pay employees'}. Change this in Settings.</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Agency</th><th>Period</th><th>Due</th><th class="n">Owed</th><th class="n">Paid</th><th class="n">Balance</th><th>Status</th><th></th></tr></thead><tbody>${rs.length?rs.map(x=>`<tr class="click" data-remit="${x.agency}|${x.key}"><td>${AGENCY_NAME[x.agency]}</td><td>${esc(x.label)}</td><td class="${x.st.k==='overdue'?'neg':'muted'}" style="white-space:nowrap">${fmtDate(x.due)}</td><td class="n">${money(x.owed)}</td><td class="n">${money(x.paid)}</td><td class="n">${money(x.bal)}</td><td><span class="pill ${x.st.k}">${x.st.label}</span></td><td class="n" style="white-space:nowrap">${x.bal>0.004?`<button class="btn sm primary" data-remit-guide="${x.agency}|${x.key}">${x.agency==='cra'?'Pay CRA':'Pay Revenu Québec'}</button> <button class="btn sm" data-remit-pay="${x.agency}|${x.key}">Record payment</button>`:''}</td></tr>`).join(''):emptyRow(8,'Nothing to remit yet','Source deductions show up here after your first pay run.')}</tbody></table></div></div>${vWsib()}`;
  }
  const runs=S.payruns.slice().sort((a,b)=>runOrder(b,a));
  const yrRuns=runs.filter(r=>r.payDate.startsWith(yr)&&!r.void),tot=yrRuns.map(runTotals);
  const due=remittances().filter(x=>x.bal>0.004).sort((a,b)=>(a.due||'').localeCompare(b.due||''))[0];
  const chips=`<div class="chips"><div class="chip"><div class="lbl">Gross pay, ${yr}</div><div class="val">${money(tot.reduce((s,x)=>s+x.gross,0))}</div></div><div class="chip"><div class="lbl">Employer contributions, ${yr}</div><div class="val">${money(tot.reduce((s,x)=>s+x.er,0))}</div></div><div class="chip"><div class="lbl">Next remittance</div><div class="val ${due&&due.st.k==='overdue'?'neg':''}">${due?`${money(due.bal)} · ${AGENCY_NAME[due.agency]} by ${fmtDate(due.due)}`:'Nothing owing'}</div></div></div>`;
  return h+chips+`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Pay date</th><th>Period</th><th class="n">Employees</th><th class="n">Gross</th><th class="n">Deductions</th><th class="n">Net pay</th><th class="n">To remit</th></tr></thead><tbody>${runs.length?runs.map(r=>{const t=runTotals(r);return `<tr class="click${r.void?' muted':''}" data-pay-run="${r.id}"><td style="white-space:nowrap">${fmtDate(r.payDate)}${r.void?' <span class="pill quiet">Void</span>':''}</td><td class="muted" style="white-space:nowrap">${r.from?`${fmtDate(r.from)} – ${fmtDate(r.to)}`:''}</td><td class="n">${r.lines.length}</td><td class="n">${money(t.gross)}</td><td class="n">${money(t.ded)}</td><td class="n">${money(t.net)}</td><td class="n">${money(r2(t.cra+t.rq))}</td></tr>`}).join(''):emptyRow(7,'No pay runs yet',S.employees.length?'Choose Run payroll to calculate deductions and pay your employees.':'Start by adding an employee.')}</tbody></table></div></div>`;
}
async function payClick(e,t,d){
  if(await yeClick(e,t,d))return true;
  if(d.ptab){S.pay.tab=d.ptab;renderMain();return true}
  if(t.hasAttribute&&t.hasAttribute('data-roelist')){roeListModal();return true}
  if(d.payEmp){employeeForm(d.payEmp==='new'?null:employee(d.payEmp));return true}
  if(d.payRun){if(d.payRun==='new')payRunForm();else payRunView(S.payruns.find(r=>r.id===d.payRun));return true}
  if(d.remitGuide){e.stopPropagation();remitGuide(d.remitGuide);return true}
  if(d.remitPay){e.stopPropagation();remitForm(d.remitPay);return true}
  if(d.remit){remitDetail(d.remit);return true}
  if(d.ehtAccrue){ehtAccrue(+d.ehtAccrue);return true}
  return false;
}
function bindPayroll(m){bindYearEnd(m)}

/* ---------- employee address ----------
   The T4 and ROE files need the address in parts (street, city, province, postal code). Employees saved before
   then have one block of text: the parts are filled in from it as a guess, to check, and the text is kept as it was
   until the parts are saved. `address` stays as the text version for pay stubs and worksheets. */
const addrText=a=>[a.line1,a.line2,[a.city,a.prov].filter(Boolean).join(' ')+(a.postal?'  '+String(a.postal).replace(/^(\w{3})(\w{3})$/,'$1 $2'):''),a.country&&a.country!=='CAN'?a.country:''].map(s=>String(s||'').trim()).filter(Boolean).join('\n');
function empAddrFields(e){
  const a=TallyXML.addressOf(e),v=x=>esc(x||''),us=a.country==='USA';
  const guess=a.guessed&&(e.address||'').trim();
  return `<div style="grid-column:1/-1" class="flabel">Address</div>
    ${guess?`<div class="muted" style="grid-column:1/-1;font-size:12.5px"><span>Filled in from the address entered before. Check each part:</span> <span translate="no" style="white-space:pre-line">${esc(e.address)}</span></div>`:''}
    ${fld('eA1','Street address',`<input type="text" id="eA1" maxlength="60" autocomplete="off" value="${v(a.line1)}" translate="no">`)}
    ${fld('eA2','Apartment, suite, etc.',`<input type="text" id="eA2" maxlength="60" autocomplete="off" value="${v(a.line2)}" translate="no">`)}
    ${fld('eACity','City',`<input type="text" id="eACity" maxlength="40" autocomplete="off" value="${v(a.city)}" translate="no">`)}
    ${fld('eAProv','Province or state',`<select id="eAProv"><option value=""></option>${PR.PROVINCES.map(k=>`<option value="${k}" ${a.prov===k?'selected':''}>${esc(provName(k))}</option>`).join('')}${us&&a.prov&&!PR.PROVINCES.includes(a.prov)?`<option value="${v(a.prov)}" selected>${v(a.prov)}</option>`:''}</select><input type="text" id="eAState" maxlength="2" placeholder="NY" value="${us?v(a.prov):''}" ${us?'':'hidden'} translate="no">`)}
    ${fld('eAPostal','Postal code',`<input type="text" id="eAPostal" maxlength="10" autocomplete="off" placeholder="K1A 0B1" value="${v(String(a.postal||'').replace(/^(\w{3})(\w{3})$/,'$1 $2'))}" translate="no"><span class="hint">For the T4 and the record of employment</span>`)}
    ${fld('eACountry','Country',`<select id="eACountry"><option value="CAN" ${us?'':'selected'}>Canada</option><option value="USA" ${us?'selected':''}>United States</option></select>`)}`;
}
function readAddr(f,e){
  const g=id=>$('#'+id,f).value.trim(),country=g('eACountry')||'CAN';
  const addr={line1:g('eA1'),line2:g('eA2'),city:g('eACity'),prov:country==='CAN'?g('eAProv'):g('eAState').toUpperCase(),postal:TallyXML.postalCA(g('eAPostal')),country};
  if(!addr.line1&&!addr.line2&&!addr.city&&!addr.postal)return{address:'',addr:null};
  // Parts only guessed from the old text and left as they were: keep the text exactly as it was entered.
  const old=e&&TallyXML.addressOf(e);
  if(old&&old.guessed&&['line1','line2','city','prov','postal','country'].every(k=>String(old[k]||'')===String(addr[k]||'')))return{address:e.address||'',addr:e.addr||null};
  return{address:addrText(addr),addr};
}
function bindAddr(f){const c=$('#eACountry',f);if(!c)return;const sync=()=>{const us=c.value==='USA';$('#eAProv',f).hidden=us;$('#eAState',f).hidden=!us};c.onchange=sync;sync()}

/* ---------- employee form ---------- */
function employeeForm(emp){
  const e=emp||{prov:PR.PROVINCES.includes(S.company.province)?S.company.province:'ON',freq:'biweekly',payType:'salary',rate:'',hours:'',active:true};
  const paid=emp?S.payruns.some(r=>r.lines.some(l=>l.employeeId===emp.id)):false;
  const yr=today().slice(0,4),o=e.openingYtd&&String(e.openingYtd.year)===yr?e.openingYtd:{};
  const v=x=>x===undefined||x===null?'':esc(x);
  const num=(id,label,val,hint,span)=>fld(id,label,`<input type="number" id="${id}" step="0.01" min="0" inputmode="decimal" value="${v(val)}">${hint?`<span class="hint">${hint}</span>`:''}`,span);
  const ytdF=(k,label,hint)=>num('eo_'+k,label,o[k]===undefined||o[k]===null||(o[k]===0&&!['pensionable','insurable','erEi'].includes(k))?'':o[k],hint);
  const vr=PR.vacationRate(e.prov||'ON',e.hireDate,today());
  const f=openModal(emp?emp.name:'New employee',`
    ${paid?`<div class="actions" style="justify-content:flex-end;margin-top:-4px"><button type="button" class="btn sm" data-roe="${emp.id}">Record of employment (ROE)</button></div>`:''}
    <div class="fields">${fld('eName','Name',`<input type="text" id="eName" value="${v(e.name)}" required>`)}${fld('eEmail','Email',`<input type="email" id="eEmail" value="${v(e.email)}">`)}
      ${fld('eProv','Province of employment',`<select id="eProv">${PR.PROVINCES.map(k=>`<option value="${k}" ${e.prov===k?'selected':''}>${esc(provName(k))}</option>`).join('')}</select>`)}
      ${fld('eHire','Hire date',`<input type="date" id="eHire" value="${v(e.hireDate)}">`)}
      ${fld('eSin','Social insurance number',`<input type="text" id="eSin" inputmode="numeric" autocomplete="off" maxlength="11" placeholder="123 456 789" value="${v(e.sin?String(e.sin).replace(/(\d{3})(\d{3})(\d{3})/,'$1 $2 $3'):'')}" translate="no"><span class="hint">For the T4 and RL-1 (box 12). Kept only in this company’s books.</span>`)}
      ${fld('eDental','Dental benefits offered (T4 box 45)',`<select id="eDental">${e.dental?'':'<option value="" selected>Choose…</option>'}${[[1,'1 · Not eligible for any dental care insurance'],[2,'2 · Employee only'],[3,'3 · Employee, spouse and dependent children'],[4,'4 · Employee and spouse'],[5,'5 · Employee and dependent children']].map(([k,l])=>`<option value="${k}" ${e.dental===k?'selected':''}>${l}</option>`).join('')}</select>`)}
      ${fld('eOcc','Occupation',`<input type="text" id="eOcc" maxlength="100" value="${v(e.occupation)}"><span class="hint">For the record of employment</span>`)}
      ${empAddrFields(e)}</div>
    <h3 class="fsec">Pay</h3>
    <div class="fields">${fld('eFreq','Pay schedule',`<select id="eFreq">${Object.keys(PR.FREQUENCIES).map(k=>`<option value="${k}" ${e.freq===k?'selected':''}>${PR.FREQ_LABEL[k]}</option>`).join('')}</select>`)}
      ${fld('eType','Paid by',`<select id="eType"><option value="salary" ${e.payType==='salary'?'selected':''}>Salary</option><option value="hourly" ${e.payType==='hourly'?'selected':''}>The hour</option></select>`)}
      ${num('eRate',e.payType==='hourly'?'Hourly rate':'Annual salary',e.rate)}
      ${num('eHours','Usual hours per pay',e.hours,'Filled in on each pay run')}
      <div data-otelig style="display:contents"><label class="check" style="align-self:end;margin-bottom:10px"><input type="checkbox" id="eOtElig" ${e.otEligible?'checked':''}> <span>Eligible for overtime</span></label></div>
      ${wsibCfg().on?fld('eWsib','Workers’ compensation rate group',`<select id="eWsib">${wsibCfg().groups.map((g,i)=>`<option value="${esc(g.id)}" ${(e.wsibGroup||wsibCfg().groups[0].id)===g.id?'selected':''}>${esc(g.name||g.code||T(`Rate group ${i+1}`))} · ${g.rate}</option>`).join('')}<option value="none" ${e.wsibGroup==='none'?'selected':''}>Not covered (exempt)</option></select>`):''}
      ${fld('ePayM','Net pay by',`<select id="ePayM"><option value="cheque" ${e.payMethod!=='deposit'?'selected':''}>Cheque or other</option><option value="deposit" ${e.payMethod==='deposit'?'selected':''}>Direct deposit</option></select>`)}
      <div data-dd style="display:contents">${fld('eBkInst','Institution number',`<input type="text" id="eBkInst" inputmode="numeric" maxlength="3" placeholder="003" autocomplete="off" value="${v(e.bank?.inst)}" translate="no"><span class="hint">3 digits, from a void cheque or direct deposit form</span>`)}
        ${fld('eBkTransit','Transit (branch) number',`<input type="text" id="eBkTransit" inputmode="numeric" maxlength="5" placeholder="12345" autocomplete="off" value="${v(e.bank?.transit)}" translate="no">`)}
        ${fld('eBkAcct','Account number',`<input type="text" id="eBkAcct" inputmode="numeric" maxlength="14" autocomplete="off" value="${v(e.bank?.account)}" translate="no"><span class="hint">Kept only in this company’s books, and shown to clients and view-only users as the last 3 digits.</span>`)}</div></div>
    <h3 class="fsec">Vacation pay</h3>
    <div class="fields">${fld('eVacMode','Vacation pay',`<select id="eVacMode">${VAC_MODES.map(([k,l])=>`<option value="${k}" ${vacModeDefault(e)===k?'selected':''}>${l}</option>`).join('')}</select>`,true)}
      <div data-vac style="display:contents">${fld('eVacRate','Vacation pay rate (%)',`<input type="number" id="eVacRate" step="0.01" min="0" max="100" inputmode="decimal" value="${v(e.vacRate)}" placeholder="${vr.rate}"><span class="hint" data-vachint></span>`)}</div>
      <div data-vacacc style="display:contents">${num('eVacOpen','Vacation pay owed before Sumlora',e.vacOpening,'Set aside and not yet paid, from your previous payroll')}</div></div>
    <h3 class="fsec">Tax claims (TD1)</h3>
    <div class="fields">${num('eTd1','Federal TD1 total claim',e.td1Fed,'Blank = basic personal amount (claim code 1). 0 = claim code 0.')}
      <div data-notqc style="display:contents">${num('eTd1p','Provincial TD1 total claim',e.td1Prov,'Blank = basic personal amount')}</div>
      <div data-qc style="display:contents">${num('eTd1q','Quebec TP-1015.3 total claim',e.td1Qc,'Blank = basic personal amount')}</div>
      ${num('eExtra','Additional federal tax per pay',e.extraTax)}
      <div data-qc style="display:contents">${num('eExtraQ','Additional Quebec tax per pay',e.extraQcTax)}</div>
      <div data-on style="display:contents">${num('eDep','Dependants (Ontario tax reduction)',e.dependants,'Children under 19 and dependants with a disability')}</div></div>
    <h3 class="fsec">Deductions and exemptions</h3>
    <div class="fields">${num('eRrsp','RRSP / pension deducted each pay',e.rrsp,'Reduces taxable income')}${fld('ePen','That deduction goes to',`<select id="ePen"><option value="rrsp" ${e.pensionType!=='rpp'?'selected':''}>A group RRSP (not on the T4)</option><option value="rpp" ${e.pensionType==='rpp'?'selected':''}>A registered pension plan (T4 box 20, RL-1 box D)</option></select>`)}${num('eUnion','Union dues each pay',e.union)}
      <div data-rpp style="display:contents">${fld('eRppNo','Pension plan registration number (T4 box 50)',`<input type="text" id="eRppNo" inputmode="numeric" maxlength="7" value="${v(e.rppNo)}" translate="no">`)}</div></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap"><label class="check"><input type="checkbox" id="eCppX" ${e.cppExempt?'checked':''}> Exempt from <span data-cpplbl>CPP</span></label><label class="check"><input type="checkbox" id="eEiX" ${e.eiExempt?'checked':''}> Exempt from EI</label><label class="check" data-qc><input type="checkbox" id="eQpipX" ${e.qpipExempt?'checked':''}> Exempt from QPIP</label>${emp?`<label class="check"><input type="checkbox" id="eInactive" ${e.active===false?'checked':''}> Inactive (no longer paid)</label>`:''}</div>
    <details ${Object.keys(o).length>1?'open':''}><summary class="fsum">Paid earlier in ${yr} outside Sumlora?</summary>
      <div class="muted" style="font-size:13px;margin:8px 0">Enter this year’s totals from your previous payroll so CPP, EI and QPIP stop at the yearly maximums and pay stubs show the right year-to-date.</div>
      <div class="fields">${ytdF('gross','Gross pay')}${ytdF('pensionable','Pensionable earnings (if different)')}${ytdF('insurable','Insurable earnings (if different)')}
        <div data-notqc style="display:contents">${ytdF('cpp','CPP')}${ytdF('cpp2','CPP2')}</div><div data-qc style="display:contents">${ytdF('qpp','QPP')}${ytdF('qpp2','QPP2')}${ytdF('qpip','QPIP (employee)')}${ytdF('erQpip','QPIP (employer)')}</div>
        ${ytdF('ei','EI')}${ytdF('erEi','Employer EI','Blank = 1.4 × the employee’s EI')}${ytdF('rrsp','RRSP / pension deducted')}${ytdF('union','Union dues')}
        ${fld('eo_prov','Province where it was earned',`<select id="eo_prov"><option value="">Same as above</option>${PR.PROVINCES.map(p=>`<option value="${p}" ${o.prov===p?'selected':''}>${esc(provName(p))}</option>`).join('')}</select>`)}${ytdF('fedTax','Federal income tax')}<div data-notqc style="display:contents">${ytdF('provTax','Provincial income tax')}</div><div data-qc style="display:contents">${ytdF('qcTax','Quebec income tax')}</div></div>
    </details>`,saveFoot(!!emp&&!paid),'wide');
  const sync=()=>{const p=$('#eProv',f).value,qc=p==='QC';$$('[data-qc]',f).forEach(x=>x.style.display=qc?(x.classList.contains('check')?'':'contents'):'none');$$('[data-notqc]',f).forEach(x=>x.style.display=qc?'none':'contents');$$('[data-on]',f).forEach(x=>x.style.display=p==='ON'?'contents':'none');$('[data-cpplbl]',f).textContent=qc?'QPP':'CPP';
    $$('[data-rpp]',f).forEach(x=>x.style.display=$('#ePen',f).value==='rpp'?'contents':'none');
    $$('[data-dd]',f).forEach(x=>x.style.display=$('#ePayM',f).value==='deposit'?'contents':'none');
    const vm=$('#eVacMode',f).value;$$('[data-vac]',f).forEach(x=>x.style.display=vm==='salary'?'none':'contents');$$('[data-vacacc]',f).forEach(x=>x.style.display=vm==='accrue'?'contents':'none');
    const r=PR.vacationRate(p,$('#eHire',f).value,today());$('#eVacRate',f).placeholder=r.rate;
    const hire=$('#eHire',f).value;
    $('[data-vachint]',f).innerHTML=!r.known?'<span>Blank = 4%. Check when your province’s minimum goes up with years of service.</span>':r.next&&hire?`<span>Blank = the minimum: ${r.rate}% now, ${r.next[1]}% after ${r.next[0]} years of service.</span>`:`<span>Blank = the minimum, ${r.rate}% now.</span>${hire||!r.next?'':' <span>Enter the hire date so it goes up with years of service.</span>'}`;
    const h=$('#eType',f).value==='hourly';$('label[for=eRate]',f).textContent=h?'Hourly rate':'Annual salary';
    // Hourly employees always get overtime; a salaried employee only when the job isn't exempt (managers usually are).
    $$('[data-otelig]',f).forEach(x=>x.style.display=h?'none':'contents')};
  $('#eProv',f).onchange=$('#eType',f).onchange=$('#ePen',f).onchange=$('#ePayM',f).onchange=$('#eVacMode',f).onchange=$('#eHire',f).onchange=sync;sync();
  if(!emp)$('#eType',f).addEventListener('change',()=>{$('#eVacMode',f).value=$('#eType',f).value==='hourly'?'accrue':'salary';sync()});
  bindAddr(f);
  const rb=$('[data-roe]',f);if(rb)rb.onclick=()=>roeForm(emp);
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this employee?',`${emp.name} will be removed.`))return;if(await del('employees',emp.id)){closeModal();toast('Employee deleted')}};
  f.onsubmit=async ev=>{ev.preventDefault();f.err('');
    const name=$('#eName',f).value.trim();if(!name)return f.err('Enter the employee’s name.');
    const val=id=>{const x=$('#'+id,f).value;return x===''?'':Math.max(0,+x)};
    if(!(+$('#eRate',f).value>0))return f.err($('#eType',f).value==='hourly'?'Enter the hourly rate.':'Enter the annual salary.');
    const prov=$('#eProv',f).value,qc=prov==='QC';
    const payMethod=$('#ePayM',f).value,acctIn=$('#eBkAcct',f).value.trim();
    const bank={inst:$('#eBkInst',f).value.replace(/\D/g,''),transit:$('#eBkTransit',f).value.replace(/\D/g,''),account:/•/.test(acctIn)?acctIn:acctIn.replace(/\D/g,'')};
    if(payMethod==='deposit'){const why=/•/.test(bank.account)?TallyDD.bankProblem({...bank,account:'00000'}):TallyDD.bankProblem(bank);
      if(why)return f.err({missing:'Enter the employee’s bank institution, transit and account numbers for direct deposit.',inst:'The institution number has 3 digits.',transit:'The transit (branch) number has 5 digits.',account:'The account number has 5 to 12 digits.'}[why])}
    const keepBank=payMethod==='deposit'||bank.inst||bank.transit||bank.account;
    const oy={year:+yr};['gross','pensionable','insurable','cpp','cpp2','qpp','qpp2','qpip','erQpip','ei','erEi','rrsp','union','fedTax','provTax','qcTax'].forEach(k=>{const raw=$('#eo_'+k,f).value,x=+raw||0;if(x||(raw!==''&&['pensionable','insurable','erEi'].includes(k)))oy[k]=r2(x)});
    if($('#eo_prov',f).value)oy.prov=$('#eo_prov',f).value;
    // The form only shows this year's opening amounts. Saving the employee with none entered must not wipe out an
    // earlier year's (they're still needed for that year's T4), so keep those as they are.
    const prevO=emp&&emp.openingYtd;
    const keepPrev=prevO&&String(prevO.year)!==yr&&+prevO.gross&&Object.keys(oy).length===1;
    if(prevO&&String(prevO.year)!==yr&&+prevO.gross&&!keepPrev&&!await confirmBox('Replace earlier opening amounts?',`${name} has opening year-to-date amounts for ${prevO.year}. Saving opening amounts for ${yr} replaces them, and the ${prevO.year} T4 will no longer include them. File the ${prevO.year} T4 first.`,'Replace'))return;
    const ad=readAddr(f,emp),adErr=ad.addr&&ad.addr.postal&&ad.addr.country==='CAN'&&!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(ad.addr.postal)?'The postal code looks like A1A 1A1.':'';
    if(adErr)return f.err(adErr);
    const data={...(emp?strip(emp):{created:Date.now()}),name,email:$('#eEmail',f).value.trim(),address:ad.address,addr:ad.addr,prov,hireDate:$('#eHire',f).value,
      freq:$('#eFreq',f).value,payType:$('#eType',f).value,rate:val('eRate'),hours:val('eHours'),
      td1Fed:val('eTd1'),td1Prov:qc?'':val('eTd1p'),td1Qc:qc?val('eTd1q'):'',extraTax:val('eExtra'),extraQcTax:qc?val('eExtraQ'):'',dependants:prov==='ON'?val('eDep'):'',
      rrsp:val('eRrsp'),union:val('eUnion'),sin:$('#eSin',f).value.replace(/\D/g,''),dental:+$('#eDental',f).value||0,rppNo:$('#ePen',f).value==='rpp'?$('#eRppNo',f).value.replace(/\D/g,''):'',pensionType:$('#ePen',f).value,cppExempt:$('#eCppX',f).checked,eiExempt:$('#eEiX',f).checked,qpipExempt:qc&&$('#eQpipX',f).checked,
      active:emp?!$('#eInactive',f).checked:true,openingYtd:keepPrev?prevO:oy,payMethod,bank:keepBank?bank:null,
      otEligible:$('#eType',f).value==='salary'&&$('#eOtElig',f).checked,...($('#eWsib',f)?{wsibGroup:$('#eWsib',f).value}:{}),
      occupation:$('#eOcc',f).value.trim(),vacMode:$('#eVacMode',f).value,vacRate:$('#eVacMode',f).value==='salary'?'':val('eVacRate'),vacOpening:$('#eVacMode',f).value==='accrue'?val('eVacOpen'):(emp?.vacOpening||'')};
    if(data.vacRate!==''&&data.vacRate>100)return f.err('The vacation pay rate is a percentage, 100 or less.');
    if(await put('employees',emp?.id||uid(),data)){closeModal();toast('Employee saved')}
  };
}

/* ---------- running payroll ---------- */
function defaultPeriod(freq,payDate){
  const d=pd(payDate),y=d.getFullYear(),m=d.getMonth()+1;
  if(freq==='monthly')return[`${y}-${pad(m)}-01`,monthEnd(y,m)];
  if(freq==='semimonthly')return d.getDate()<=15?[`${y}-${pad(m)}-01`,`${y}-${pad(m)}-15`]:[`${y}-${pad(m)}-16`,monthEnd(y,m)];
  const n=freq==='weekly'?7:14;return[addDays(payDate,-n+1),payDate];
}
function payRunForm(){
  const act=S.employees.filter(e=>e.active!==false);
  const freqs=[...new Set(act.map(e=>e.freq))];
  const last=S.payruns.slice().sort(runOrder).pop();
  let freq=last&&freqs.includes(last.freq)?last.freq:freqs[0];
  const nextDate=()=>{const l=S.payruns.filter(r=>r.freq===freq).sort(runOrder).pop();if(!l)return today();if(freq==='weekly')return addDays(l.payDate,7);if(freq==='biweekly')return addDays(l.payDate,14);const d=pd(l.payDate);if(freq==='monthly')return monthEnd(d.getFullYear(),d.getMonth()+2);return d.getDate()<=15?monthEnd(d.getFullYear(),d.getMonth()+1):`${d.getFullYear()+(d.getMonth()===11?1:0)}-${pad(d.getMonth()===11?1:d.getMonth()+2)}-15`};
  const defBank=(sortAccts(S.accounts.filter(a=>a.detail==='bank'))[0]||{}).id;
  const f=openModal('Run payroll',`
    <div class="fields">${fld('rFreq','Pay schedule',`<select id="rFreq">${freqs.map(k=>`<option value="${k}" ${k===freq?'selected':''}>${PR.FREQ_LABEL[k]}</option>`).join('')}</select>`)}
      ${fld('rDate','Pay date',`<input type="date" id="rDate">`)}${fld('rFrom','Period start',`<input type="date" id="rFrom">`)}${fld('rTo','Period end',`<input type="date" id="rTo">`)}
      ${fld('rBank','Pay from',`<select id="rBank">${acctOptions(defBank,a=>a.detail==='bank')}</select>`)}</div>
    <div data-rates class="muted" style="font-size:13px"></div>
    <div data-emps class="prl-list"></div>
    <div class="totals" data-rtot style="min-width:280px"></div>`,
    `<span class="left muted" style="font-size:13px">Change any amount before posting; changed amounts are kept.</span><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Post pay run</button>`,'wide');
  const P=()=>PR.FREQUENCIES[freq];
  const setDates=()=>{const d=nextDate();$('#rDate',f).value=d;const[a,b]=defaultPeriod(freq,d);$('#rFrom',f).value=a;$('#rTo',f).value=b};
  const rowHTML=e=>{const qc=e.prov==='QC';const reg=e.payType==='hourly'?r2((+e.hours||0)*(+e.rate||0)):r2((+e.rate||0)/P());
    const inp=(k,label,grp)=>`<div class="field"><label for="p_${e.id}_${grp}_${k}">${label}</label><input type="number" step="0.01" min="0" inputmode="decimal" id="p_${e.id}_${grp}_${k}" data-${grp}="${k}"></div>`;
    return `<div class="prl" data-emp="${e.id}">
      <div class="prl-top"><label class="check prl-name"><input type="checkbox" data-inc checked> <span><b>${esc(e.name)}</b><span class="muted"> · ${esc(e.prov)} · ${payOf(e)}</span></span></label>
        ${e.payType==='hourly'?`<div class="field"><label>Hours</label><input type="number" step="0.01" min="0" data-hours value="${v0(e.hours)}"></div>`:''}
        <div class="field"><label>Regular pay</label><input type="number" step="0.01" min="0" data-reg value="${reg||''}"></div>
        ${e.payType==='hourly'?`<div class="field" data-holf hidden><label title="Statutory holiday pay">Holiday pay</label><input type="number" step="0.01" min="0" data-hol></div>`:''}
        ${otApplies(e)?`<div class="field"><label title="1.5 times the regular rate for hours over the weekly threshold">Overtime</label><input type="number" step="0.01" min="0" data-ot></div>`:''}
        <div class="field"><label>Other pay</label><input type="number" step="0.01" min="0" data-other placeholder="Commission" title="Commissions, premium pay or other pay that earns vacation pay"></div>
        ${vacMode(e)!=='salary'?`<div class="field"><label>Vacation pay</label><input type="number" step="0.01" min="0" data-vac title="${vacMode(e)==='accrue'?'Paid now out of the vacation pay set aside':'Added to this pay'}"></div>`:''}
        <div class="prl-sum"><span class="muted">Deductions</span><b data-s="ded">0.00</b></div><div class="prl-sum"><span class="muted">Net pay</span><b data-s="net">0.00</b></div>
        <button type="button" class="btn ghost sm" data-more aria-expanded="false">Details</button></div>
      <div class="prl-more" hidden>
        ${otApplies(e)?`<div class="flabel" style="margin-bottom:6px">Hours by work week</div><div class="fields" data-wks style="margin-bottom:4px"></div>
          <div class="fields" style="margin-bottom:4px"><div class="field"><label for="p_${e.id}_othrs">Overtime hours</label><input type="number" step="0.01" min="0" id="p_${e.id}_othrs" data-othrs></div></div>
          <div data-otnote class="muted" style="font-size:12.5px;margin-bottom:10px"></div>`:''}
        <div class="fields" style="margin-bottom:10px"><div class="field"><label for="p_${e.id}_bonus">Bonus</label><input type="number" step="0.01" min="0" id="p_${e.id}_bonus" data-bonus><span class="hint">Taxed with CRA’s method for bonuses.</span>
            <label class="check" style="margin-top:4px"><input type="checkbox" data-bonusvac> <span>Non-discretionary (earns vacation pay)</span></label><span class="hint">Tick it for a bonus that was promised, or tied to sales, hours or results. A true gift at the employer’s discretion doesn’t earn vacation pay.</span></div>
          <div class="field"><label for="p_${e.id}_allow">Taxable allowance</label><input type="number" step="0.01" min="0" id="p_${e.id}_allow" data-allow><span class="hint">Paid with this pay, for example a car or phone allowance</span></div>
          ${vacMode(e)==='accrue'?`<div class="field"><label for="p_${e.id}_vacacc">Vacation pay set aside</label><input type="number" step="0.01" min="0" id="p_${e.id}_vacacc" data-vacacc><span class="hint" data-vachint></span></div>`:''}
          ${e.payType==='hourly'?`<div class="field" data-holhf hidden><label for="p_${e.id}_holhrs">Holiday hours</label><input type="number" step="0.01" min="0" id="p_${e.id}_holhrs" data-holhrs><span class="hint">Insurable hours for the record of employment</span></div>`:''}</div>
        <div data-holnote class="muted" style="font-size:12.5px;margin-bottom:10px" hidden></div>
        <details style="margin-bottom:10px"><summary class="flabel" style="cursor:pointer">Taxable benefits not paid in cash</summary>
          <div class="muted" style="font-size:12.5px;margin:6px 0">Added to taxable income and CPP${qc?'/QPP':''} earnings (and EI for gift cards and board and lodging), but not to the pay. They go on the T4${qc?' and RL-1':''}.</div>
          <div class="fields">${PR.BENEFIT_KINDS.map(b=>`<div class="field"><label for="p_${e.id}_ben_${b.k}">${esc(b.label)}</label><input type="number" step="0.01" min="0" id="p_${e.id}_ben_${b.k}" data-ben="${b.k}"></div>`).join('')}</div></details>
        <label class="check" style="margin-bottom:10px"><input type="checkbox" data-final> <span>${vacMode(e)==='accrue'?'Final pay: this employee is leaving. All the vacation pay owed is paid out.':'Final pay: this employee is leaving.'}</span></label>
        <div class="flabel" style="margin-bottom:6px">Employee deductions</div>
        <div class="fields">${PR.EMPLOYEE_ITEMS.filter(([k])=>qc?!['cpp','cpp2','provTax'].includes(k):!['qpp','qpp2','qpip','qcTax'].includes(k)).map(([k,l])=>inp(k,l,'ded')).join('')}${inp('rrsp','RRSP / pension','x')}${inp('union','Union dues','x')}</div>
        <div class="flabel" style="margin:10px 0 6px">Employer contributions</div>
        <div class="fields">${PR.EMPLOYER_ITEMS.filter(([k])=>qc?!['cpp','cpp2'].includes(k):!['qpp','qpp2','qpip','hsf'].includes(k)).map(([k,l])=>inp(k,l,'er')).join('')}</div>
        ${e.payType==='hourly'&&!e.vacMode?`<div class="neg" style="font-size:12.5px;margin-top:8px">Vacation pay isn’t set up for this employee yet. Choose how it’s paid on their employee page.</div>`:''}
        <div data-note class="muted" style="font-size:12.5px;margin-top:8px"></div>
        <button type="button" class="btn ghost sm" data-reset style="margin-top:6px">Recalculate all amounts</button>
      </div></div>`};
  const v0=x=>x===''||x==null?'':esc(x);
  const render=()=>{$('[data-emps]',f).innerHTML=act.filter(e=>e.freq===freq).sort((a,b)=>a.name.localeCompare(b.name)).map(rowHTML).join('')||'<div class="muted">No active employees on this schedule.</div>';recalcAll()};
  // Recalculate one employee. Fields the user typed into (data-ov) keep their value.
  const recalc=box=>{
    const e=employee(box.dataset.emp),date=$('#rDate',f).value,q=k=>box.querySelector(k),val=k=>+(q(k)?.value)||0;
    const auto=(k,v)=>{const el=q(k);if(el&&!el.dataset.ov)el.value=v?r2(v).toFixed(2):''};
    const from=$('#rFrom',f).value,to=$('#rTo',f).value;
    // Overtime: hours by work week, and the hours over the threshold in each at 1.5 times the regular rate.
    let ot=null;
    if(otApplies(e)){
      const wks=PR.workWeeks(from,to),wrap=q('[data-wks]'),key=wks.map(w=>w.from).join(',');
      if(wrap.dataset.key!==key){wrap.dataset.key=key;wrap.innerHTML=wks.map((w,i)=>`<div class="field"><label for="p_${e.id}_wk${i}">${fmtDate(w.from)} – ${fmtDate(w.to)}</label><input type="number" step="0.01" min="0" inputmode="decimal" id="p_${e.id}_wk${i}" data-wk="${i}"></div>`).join('')}
      const ins=[...wrap.querySelectorAll('[data-wk]')],total=e.payType==='hourly'?val('[data-hours]'):(+e.hours||0);
      // Weeks typed in keep their hours; the rest share what's left, by their number of days.
      const fixed=ins.filter(x=>x.dataset.ov),left=Math.max(0,total-fixed.reduce((t,x)=>t+(+x.value||0),0));
      const free=wks.filter((w,i)=>!ins[i].dataset.ov),split=PR.splitHours(left,free);
      let j=0;ins.forEach(x=>{if(!x.dataset.ov)x.value=split[j++]||''});
      const rule=otRule(e),rate=hourlyRate(e,P());
      ot=PR.overtime({weekHours:ins.map(x=>+x.value||0),threshold:rule.weekly,rate});
      const on=q('[data-otnote]');
      on.innerHTML=(ot.overtimeHours?`<span>${ot.overtimeHours} h over ${rule.weekly} h in a week, at ${money(ot.otRate)}/h (1.5 × ${money(rate)}).</span> `:`<span>No hours over ${rule.weekly} h in a week.</span> `)+
        (rule.daily?`<span>${esc(provName(e.prov))} also has overtime after ${rule.daily} hours in a day. Check the daily hours and add any under Overtime.</span> `:'')+
        (e.payType!=='hourly'&&!rate?'<span class="neg">Enter the usual hours per pay on the employee to work out the hourly rate.</span> ':'')+
        (wks.length>1&&wks[wks.length-1].days<7?'<span>The last week is short: hours in the rest of that week are in the next pay period.</span>':'');
      auto('[data-ot]',ot.overtimePay);
      auto('[data-othrs]',ot.overtimeHours);
    }
    if(e.payType==='hourly'&&!q('[data-reg]').dataset.ov)q('[data-reg]').value=r2((ot?ot.regularHours:val('[data-hours]'))*(+e.rate||0))||'';
    // Statutory holidays in this pay period (hourly employees; a salary already covers them).
    const hols=e.payType==='hourly'&&from&&to&&from<=to?PR.holidaysBetween(e.prov,from,to):[];
    if(q('[data-holf]')){q('[data-holf]').hidden=!hols.length;q('[data-holhf]').hidden=!hols.length}
    const hn=q('[data-holnote]');hn.hidden=!hols.length;
    if(hols.length){
      // Ontario counts vacation pay paid in those weeks, this pay's included (PR.holidayCurrentEarnings).
      const earn=[...holidayEarnings(e.id,e.prov),{from,to,amount:PR.holidayCurrentEarnings({prov:e.prov,vacMode:vacMode(e),vacRate:vacRateFor(e,date).rate,vacPay:val('[data-vac]'),
        regular:val('[data-reg]'),overtime:val('[data-ot]'),other:val('[data-other]'),bonus:val('[data-bonus]'),bonusVac:!!q('[data-bonusvac]')?.checked})}];
      const parts=hols.map(h=>({h,...PR.holidayPay(h.date,earn)}));
      const firstPay=earn.reduce((m,x)=>x.from<m?x.from:m,from);
      const short=parts.some(x=>x.window.from<firstPay);
      auto('[data-hol]',parts.reduce((t,x)=>t+x.pay,0));
      auto('[data-holhrs]',hols.length*(+e.hours||0)/(WORKDAYS[freq]||10));
      hn.innerHTML=parts.map(x=>`<div><b>${esc(x.h.name)}</b> · <span>${fmtDate(x.h.date)}: ${money(x.pay)}, which is 1/20 of ${money(x.base)} earned from ${fmtDate(x.window.from)} to ${fmtDate(x.window.to)}</span></div>`).join('')+
        (short?`<div class="neg">Sumlora has ${esc(e.name)}’s pay only from ${fmtDate(firstPay)}, so pay before that isn’t counted. Check the holiday pay against your earlier payroll.</div>`:'')+
        `<div>${['ON','QC'].includes(e.prov)?'':'<span>This is the Ontario and Quebec formula. Check your province’s rule.</span> '}<span>If ${esc(e.name)} worked on the holiday, add the premium pay under Other pay.</span>${e.prov==='ON'?' <span>Ontario counts vacation pay paid in those weeks too.</span>':''}</div>`;
    }else for(const k of ['[data-hol]','[data-holhrs]']){const el=q(k);if(el){delete el.dataset.ov;delete el.dataset.ovk;el.value=''}}
    // Vacation pay on regular, holiday, overtime and other pay, and on a bonus only when it's non-discretionary.
    const vm=vacMode(e),vr=vacRateFor(e,date).rate,base=PR.vacationBase({regular:val('[data-reg]'),holiday:val('[data-hol]'),overtime:val('[data-ot]'),other:val('[data-other]'),bonus:val('[data-bonus]'),bonusVac:!!q('[data-bonusvac]')?.checked});
    const fin=q('[data-final]').checked;
    if(vm==='each')auto('[data-vac]',base*vr/100);
    if(vm==='accrue'){
      auto('[data-vacacc]',base*vr/100);
      const owed=vacBalance(e.id,{payDate:date+'~'},false);
      auto('[data-vac]',fin?Math.max(0,owed+val('[data-vacacc]')):0);
      q('[data-vachint]').textContent=`${vr}% · owed before this pay: ${money(owed)}`;
    }
    const gross=r2(val('[data-reg]')+val('[data-hol]')+val('[data-ot]')+val('[data-other]')+val('[data-bonus]')+val('[data-allow]')+val('[data-vac]'));
    const ben={};box.querySelectorAll('[data-ben]').forEach(x=>{if(+x.value)ben[x.dataset.ben]=r2(+x.value)});
    const bl={benefits:ben},bt=benTotal(bl);
    const note=q('[data-note]');let res=null;
    // A pay run voided after later ones used its year-to-date amounts: this one is worked out without it, so CPP and EI
    // that stopped too early start again here. Say so, since the earlier stubs showed the old amounts.
    const voided=S.payruns.filter(r=>r.void&&r.payDate.slice(0,4)===(date||'').slice(0,4)&&r.lines.some(l=>l.employeeId===e.id)&&PR.laterRuns(r,S.payruns).length);
    const vnote=voided.length?`<span class="neg">${voided.map(r=>fmtDate(r.payDate)).join(', ')}: <span>voided after later pay runs used it. Year-to-date amounts here leave it out, so CPP and EI resume if they stopped too early.</span></span> `:'';
    try{res=calcFor(e,date,P(),gross,ytdFor(e.id,{payDate:date+'~'},false),{bonus:val('[data-bonus]'),benefits:bt,pensionable:r2(gross+bt),insurable:r2(gross+benInsurable(bl)),qpipInsurable:r2(gross+bt)});note.innerHTML=vnote+res.notes.map(n=>`<span>${esc(n)}</span>`).join(' ')}
    catch(err){note.innerHTML=`<span class="neg">${esc(err.message)}</span> Enter the deductions yourself.`}
    const set=(el,v)=>{if(!el.dataset.ov)el.value=v?v.toFixed(2):''};
    // No rates for this date: clear the suggestions (so amounts worked out for another date don't stay behind)
    // and remember it, so posting asks before using amounts that weren't calculated.
    box.dataset.norates=res?'':'1';
    box.querySelectorAll('[data-ded]').forEach(el=>set(el,res?res.employee[el.dataset.ded]:0));
    box.querySelectorAll('[data-er]').forEach(el=>set(el,res?res.employer[el.dataset.er]:0));
    box.querySelectorAll('[data-x]').forEach(el=>set(el,+e[el.dataset.x]||0));
    const l=readLine(box);box.querySelector('[data-s=ded]').textContent=money(lineDed(l));const n=box.querySelector('[data-s=net]');n.textContent=money(l.net);n.className=l.net<0?'neg':'';
    box.classList.toggle('off',!box.querySelector('[data-inc]').checked);
  };
  const readLine=box=>{const e=employee(box.dataset.emp);const g=k=>r2(+box.querySelector(k)?.value||0);
    const ded={},er={};box.querySelectorAll('[data-ded]').forEach(x=>ded[x.dataset.ded]=r2(+x.value||0));box.querySelectorAll('[data-er]').forEach(x=>er[x.dataset.er]=r2(+x.value||0));
    DED_KEYS.forEach(k=>ded[k]=ded[k]||0);ER_KEYS.forEach(k=>er[k]=er[k]||0);
    const regular=g('[data-reg]'),holiday=g('[data-hol]'),overtime=g('[data-ot]'),other=g('[data-other]'),bonus=g('[data-bonus]'),allowance=g('[data-allow]'),vacPay=g('[data-vac]'),gross=r2(regular+holiday+overtime+other+bonus+allowance+vacPay);
    const benefits={};box.querySelectorAll('[data-ben]').forEach(x=>{const v=r2(+x.value||0);if(v)benefits[x.dataset.ben]=v});
    const vm=vacMode(e),from=$('#rFrom',f).value,to=$('#rTo',f).value;
    const l={employeeId:e.id,name:e.name,prov:e.prov,payType:e.payType,rate:+e.rate||0,hours:e.payType==='hourly'?g('[data-hours]'):(+e.hours||''),regular,other,gross,pensionable:r2(gross+benTotal({benefits})),insurable:r2(gross+benInsurable({benefits})),cppExempt:!!e.cppExempt,eiExempt:!!e.eiExempt,qpipExempt:e.prov==='QC'&&!!e.qpipExempt,
      rrsp:g('[data-x=rrsp]'),union:g('[data-x=union]'),ded,er,overridden:[...box.querySelectorAll('[data-ov]')].map(x=>x.dataset.ded||x.dataset.er||x.dataset.x||x.dataset.ovk||'').filter(Boolean)};
    if(holiday){l.holiday=holiday;l.holHours=g('[data-holhrs]');l.holidays=(e.payType==='hourly'&&from&&to?PR.holidaysBetween(e.prov,from,to):[]).map(h=>({date:h.date,name:h.name}))}
    if(overtime){l.overtime=overtime;l.otHours=g('[data-othrs]')}
    const wk=[...box.querySelectorAll('[data-wk]')].map(x=>r2(+x.value||0));if(wk.length&&wk.some(Boolean))l.weekHours=wk;
    if(bonus){l.bonus=bonus;if(box.querySelector('[data-bonusvac]')?.checked)l.bonusVac=true}
    if(allowance)l.allowance=allowance;
    // Workers' compensation: the employer's premium on this pay, insurable earnings capped at the year's maximum.
    const wg=wsibGroup(e);
    if(wg){const ytd=ytdFor(e.id,{payDate:($('#rDate',f).value||today())+'~'},false).wsib||0;const p=PR.wsibPremium({earnings:gross,ytd,max:wsibCfg().max,rate:wg.rate});l.wsib={group:wg.id,rate:+wg.rate||0,...p}}
    if(Object.keys(benefits).length)l.benefits=benefits;
    if(vm!=='salary'){l.vacMode=vm;l.vacRate=vacRateFor(e,$('#rDate',f).value).rate;l.vacPay=vacPay;if(vm==='accrue')l.vacAccrued=g('[data-vacacc]')}
    if(box.querySelector('[data-final]').checked)l.final=true;
    l.net=r2(gross-lineDed(l));return l};
  const recalcAll=()=>{$$('.prl',f).forEach(recalc);totals()};
  const included=()=>$$('.prl',f).filter(b=>b.querySelector('[data-inc]').checked);
  const totals=()=>{const r={lines:included().map(readLine)};const t=runTotals(r);
    $('[data-rtot]',f).innerHTML=`<div>Gross pay</div><div>${money(t.gross)}</div><div>Employee deductions</div><div>${money(t.ded)}</div><div>Employer contributions</div><div>${money(t.er)}</div><div>To CRA</div><div>${money(t.cra)}</div>${t.rq?`<div>To Revenu Québec</div><div>${money(t.rq)}</div>`:''}${t.vacAcc||t.vacOut?`<div>Vacation pay set aside</div><div>${money(r2(t.vacAcc-t.vacOut))}</div>`:''}${t.wsib?`<div>Workers’ compensation premium</div><div>${money(t.wsib)}</div>`:''}<div class="big">Net pay from bank</div><div class="big">${money(t.net)}</div>`;
    const tb=PR.tableFor($('#rDate',f).value);$('[data-rates]',f).textContent=tb?`Rates: ${tb.label} (CRA T4127, 123rd edition).`:'';};
  const emps=$('[data-emps]',f);
  emps.addEventListener('input',ev=>{const box=ev.target.closest('.prl');if(!box)return;const el=ev.target;
    if(el.matches('[data-ded],[data-er],[data-x]')||(el.matches('[data-reg]')&&employee(box.dataset.emp).payType==='hourly'))el.dataset.ov='1';
    if(el.matches('[data-hol],[data-vac],[data-vacacc],[data-holhrs],[data-ot],[data-othrs]')){el.dataset.ov='1';el.dataset.ovk=[...Object.keys(el.dataset)].find(k=>['hol','vac','vacacc','holhrs','ot','othrs'].includes(k))}
    // Hours by week typed in: total hours follow. Total hours typed in: the weeks share them again.
    if(el.matches('[data-wk]')){el.dataset.ov='1';const h=box.querySelector('[data-hours]');if(h)h.value=r2([...box.querySelectorAll('[data-wk]')].reduce((t,x)=>t+(+x.value||0),0))}
    if(el.matches('[data-hours]'))box.querySelectorAll('[data-wk]').forEach(x=>delete x.dataset.ov);
    if(el.matches('[data-ded],[data-er],[data-x]')){const l=readLine(box);box.querySelector('[data-s=ded]').textContent=money(lineDed(l));box.querySelector('[data-s=net]').textContent=money(l.net)}
    else recalc(box);totals()});
  emps.addEventListener('change',ev=>{if(ev.target.matches('[data-inc],[data-final],[data-bonusvac]')){const b=ev.target.closest('.prl');if(ev.target.matches('[data-final]')){const v=b.querySelector('[data-vac]');if(v)delete v.dataset.ov}recalc(b);totals()}});
  emps.addEventListener('click',ev=>{const box=ev.target.closest('.prl');if(!box)return;
    if(ev.target.closest('[data-more]')){const m=box.querySelector('.prl-more'),b=ev.target.closest('[data-more]');m.hidden=!m.hidden;b.setAttribute('aria-expanded',String(!m.hidden))}
    if(ev.target.closest('[data-reset]')){box.querySelectorAll('[data-ov]').forEach(x=>delete x.dataset.ov);recalc(box);totals()}});
  $('#rFreq',f).onchange=()=>{freq=$('#rFreq',f).value;setDates();render()};
  $('#rDate',f).onchange=()=>{const[a,b]=defaultPeriod(freq,$('#rDate',f).value);$('#rFrom',f).value=a;$('#rTo',f).value=b;recalcAll()};
  $('#rFrom',f).onchange=$('#rTo',f).onchange=recalcAll;
  setDates();render();
  f.onsubmit=async ev=>{ev.preventDefault();f.err('');
    const payDate=$('#rDate',f).value,bank=$('#rBank',f).value;
    if(!payDate)return f.err('Enter the pay date.');if(!bank)return f.err('Choose the bank account you pay from.');
    const lines=included().map(readLine).filter(l=>l.gross>0);
    if(!lines.length)return f.err('Include at least one employee with pay.');
    const noRates=included().filter(b=>b.dataset.norates==='1'&&readLine(b).gross>0).map(b=>employee(b.dataset.emp)?.name||'');
    if(noRates.length&&!await confirmBox('Payroll rates aren’t loaded for this date',`Sumlora can’t work out CPP, EI and income tax for ${fmtDate(payDate)}, so the deductions for ${noRates.join(', ')} are only what you typed in. Check them with CRA’s Payroll Deductions Online Calculator (PDOC) before posting.`,'Post anyway'))return;
    const bad=lines.find(l=>l.net<0);if(bad)return f.err(`${bad.name}: deductions are more than gross pay.`);
    const over=lines.find(l=>l.vacMode==='accrue'&&l.vacPay>r2(vacBalance(l.employeeId,{payDate:payDate+'~'},false)+(l.vacAccrued||0))+0.004);
    if(over&&!await confirmBox('Pay more vacation pay than is owed?',`${over.name} is owed ${money(r2(vacBalance(over.employeeId,{payDate:payDate+'~'},false)+(over.vacAccrued||0)))} of vacation pay, and this pays ${money(over.vacPay)}. Pay it anyway?`,'Pay anyway'))return;
    const dup=lines.find(l=>liveRuns().some(r=>r.payDate===payDate&&r.lines.some(x=>x.employeeId===l.employeeId)));
    if(dup&&!await confirmBox('Pay this employee twice?',`${dup.name} already has a pay run dated ${fmtDate(payDate)}. Post another one anyway?`,'Post anyway'))return;
    const id=uid(),run={payDate,from:$('#rFrom',f).value,to:$('#rTo',f).value,freq,bank,lines,created:Date.now(),entryId:'pr_'+id};
    const t=runTotals(run);
    const{writes,ids}=payAccounts(t.rq>0,!!(t.vacAcc||t.vacOut),t.wsib>0,false);
    const L=[{account:ids.wages,debit:r2(t.gross-t.vacOut+t.vacAcc),credit:0,memo:t.vacAcc||t.vacOut?'Gross pay, with vacation pay as it’s earned':'Gross pay'}];
    if(t.vacAcc)L.push({account:ids.vacation_payable,debit:0,credit:t.vacAcc,memo:'Vacation pay set aside'});
    if(t.vacOut)L.push({account:ids.vacation_payable,debit:t.vacOut,credit:0,memo:'Vacation pay paid out'});
    if(t.er)L.push({account:ids.payroll_tax,debit:t.er,credit:0,memo:'Employer contributions'});
    if(t.cra)L.push({account:ids.payroll_cra,debit:0,credit:t.cra,memo:'Source deductions – CRA'});
    if(t.rq)L.push({account:ids.payroll_rq,debit:0,credit:t.rq,memo:'Source deductions – Revenu Québec'});
    if(t.other)L.push({account:ids.payroll_other,debit:0,credit:t.other,memo:'RRSP and union dues withheld'});
    if(t.wsib)L.push({account:ids.wsib,debit:t.wsib,credit:0,memo:'Workers’ compensation premium'},{account:ids.wsib_payable,debit:0,credit:t.wsib,memo:'Workers’ compensation premium'});
    if(t.net)L.push({account:bank,debit:0,credit:t.net,memo:'Net pay'});
    writes.push({op:'set',collection:'entries',id:run.entryId,data:{type:'payrun',date:payDate,ref:'Payroll',memo:`Payroll, ${lines.length} employee${lines.length===1?'':'s'}${run.from?`, ${fmtDate(run.from)} – ${fmtDate(run.to)}`:''}`,payrunId:id,lines:L,created:run.created}});
    writes.push({op:'set',collection:'payruns',id,data:run});
    if(!await batch(writes))return;
    closeModal();toast('Pay run posted');S.pay.tab='runs';if(S.view!=='payroll')go('payroll');
    payRunView(S.payruns.find(r=>r.id===id));
  };
}

/* ---------- a posted pay run, and its pay stubs ---------- */
function payRunView(run){
  if(!run)return;
  const t=runTotals(run),qc=run.lines.some(l=>l.prov==='QC');
  const f=openModal(`Pay run · ${fmtDate(run.payDate)}`,`
    ${run.void?`<div class="banner err" style="margin:0"><span><b>Void.</b> <span>Voided on ${fmtDate(run.void.date)}: a reversing entry undoes its journal entry, and it isn’t counted in year-to-date amounts, remittances, T4s or records of employment.</span>${run.void.reason?` <span translate="no">${esc(run.void.reason)}</span>`:''}</span></div>`:''}
    <div class="muted">${run.from?`Pay period ${fmtDate(run.from)} – ${fmtDate(run.to)} · `:''}${PR.FREQ_LABEL[run.freq]||''} · paid from ${esc(acctName(run.bank))}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Employee</th><th class="n">Gross</th><th class="n">${qc?'CPP/QPP':'CPP'}</th><th class="n">EI${qc?'/QPIP':''}</th><th class="n">Income tax</th><th class="n">Other</th><th class="n">Net pay</th><th></th></tr></thead><tbody>
    ${run.lines.map((l,i)=>`<tr><td>${esc(l.name)}${l.overridden&&l.overridden.length?' <span class="pill quiet" title="Amounts changed by hand">Edited</span>':''}</td><td class="n">${money(l.gross)}</td><td class="n">${money(l.ded.cpp+l.ded.cpp2+l.ded.qpp+l.ded.qpp2)}</td><td class="n">${money(l.ded.ei+l.ded.qpip)}</td><td class="n">${money(l.ded.fedTax+l.ded.provTax+l.ded.qcTax)}</td><td class="n">${money((+l.rrsp||0)+(+l.union||0))}</td><td class="n"><b>${money(l.net)}</b></td><td class="n"><button type="button" class="btn sm" data-stub="${i}">Pay stub</button></td></tr>`).join('')}
    </tbody><tfoot><tr><td><b>Total</b></td><td class="n">${money(t.gross)}</td><td colspan="4"></td><td class="n"><b>${money(t.net)}</b></td><td></td></tr></tfoot></table></div>
    <div class="totals" style="min-width:280px"><div>Employer contributions</div><div>${money(t.er)}</div><div>Owed to CRA</div><div>${money(t.cra)}</div>${t.rq?`<div>Owed to Revenu Québec</div><div>${money(t.rq)}</div>`:''}${t.vacAcc||t.vacOut?`<div>Vacation pay set aside</div><div>${money(r2(t.vacAcc-t.vacOut))}</div>`:''}${t.wsib?`<div>Workers’ compensation premium</div><div>${money(t.wsib)}</div>`:''}<div class="big">Total cost</div><div class="big">${money(t.cost)}</div></div>`,
    `${run.void?'':`<button type="button" class="btn danger left" data-void>Void pay run</button>${isLatestRun(run)?'<button type="button" class="btn ghost" data-del>Delete</button>':''}`}${!run.void&&ddLines(run).length?`<button type="button" class="btn" data-dd>Direct deposit file</button>`:''}<button type="button" class="btn" data-stub="all">Print all pay stubs</button><button type="button" class="btn primary" data-close>Done</button>`,'wide');
  f.addEventListener('click',ev=>{const b=ev.target.closest('[data-stub]');if(b)printStubs(run,b.dataset.stub==='all'?run.lines:[run.lines[+b.dataset.stub]]);if(ev.target.closest('[data-dd]'))ddFile(run)});
  const vb=$('[data-void]',f);if(vb)vb.onclick=()=>voidRunForm(run);
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{
    const e=S.entries.find(x=>x.id===run.entryId);const rec=e&&Object.values(e.clear||{}).includes('r');
    // Deleting is only for a mistake caught right away: the latest pay run, with nothing reconciled. Otherwise void it.
    if(rec)return confirmBox('Void it instead','Its bank payment is already reconciled, so the pay run can’t be deleted. Void it instead: that keeps the record and reverses it on the date you choose.','OK');
    const paidRemit=remittances().some(x=>x.key===remitPeriod(run.payDate).key&&x.paid>0);
    if(!await confirmBox('Delete this pay run?',`The pay run and its journal entry will be removed.${paidRemit?' You have already recorded a remittance for this period.':''}`))return;
    const w=[{op:'delete',collection:'payruns',id:run.id}];if(e)w.push({op:'delete',collection:'entries',id:e.id});
    if(await batch(w)){closeModal();toast('Pay run deleted')}};
}
/** The latest pay run that counts (not void): the only one that can still be deleted. */
const isLatestRun=run=>{const l=liveRuns().sort(runOrder).pop();return !!l&&l.id===run.id};
/* ---------- voiding a pay run ----------
   Voiding keeps the pay run but posts a reversing entry on the date chosen (every debit becomes a credit) and marks it
   void, so it's left out of year-to-date amounts, remittances, T4s and ROEs. Pay runs after it in the year were worked
   out with its amounts in their year-to-date, so CPP, EI and QPIP on them may be off: the next pay run catches up. */
function voidRunForm(run){
  const e=S.entries.find(x=>x.id===run.entryId);
  const later=PR.laterRuns(run,S.payruns);
  // Today by default; never before the pay date (a run paid in advance) or in the closed period.
  const cl=S.company.closingDate,def=[today(),run.payDate,cl?addDays(cl,1):''].sort().pop();
  const f=openModal(`Void pay run · ${fmtDate(run.payDate)}`,`
    <div class="muted" style="font-size:13px">Voiding keeps this pay run in the list, marked void, and posts a reversing entry on the date you choose. It’s left out of year-to-date amounts, remittances, T4s and records of employment. Use it for a pay run that shouldn’t have been paid, then post a correct one.</div>
    <div class="fields">${fld('vDate','Date of the reversing entry',`<input type="date" id="vDate" value="${def}"><span class="hint">${cl?`The books are closed through ${fmtDate(cl)}. `:''}Usually today, or the pay date if nothing was paid.</span>`)}
      ${fld('vWhy','Reason',`<input type="text" id="vWhy" maxlength="200" placeholder="Paid the wrong hours">`)}</div>
    ${later.length?`<div class="banner err" style="margin:0"><span><b>Later pay runs used this one’s year-to-date amounts.</b> <span>CPP, EI${run.lines.some(l=>l.prov==='QC')?', QPP and QPIP':''} on these were worked out as if this pay run counted, so they may have stopped at the yearly maximum too early:</span> ${later.map(r=>`<span style="white-space:nowrap">${fmtDate(r.payDate)}</span>`).join(', ')}. <span>The next pay run you post works out year-to-date amounts without this one, so CPP and EI are deducted again until the yearly maximums are really reached. Check those pay stubs, and the T4 figures at year-end.</span></span></div>`:''}
    ${e&&Object.values(e.clear||{}).includes('r')?'<div class="muted" style="font-size:13px">Its bank payment is reconciled. The reversing entry puts the net pay back in the bank: reconcile it against the stopped cheque or returned deposit.</div>':''}`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn danger">Void pay run</button>`);
  f.onsubmit=async ev=>{ev.preventDefault();f.err('');
    const date=$('#vDate',f).value;if(!date)return f.err('Enter the date of the reversing entry.');
    if(date<run.payDate)return f.err('The reversing entry can’t be dated before the pay date.');
    if(cl&&date<=cl)return f.err(`The books are closed through ${fmtDate(cl)}. Choose a later date.`);
    const id='prv_'+run.id,reason=$('#vWhy',f).value.trim();
    const w=[];
    if(e)w.push({op:'set',collection:'entries',id,data:{type:'payrun',date,ref:'Payroll',memo:`Void: payroll of ${fmtDate(run.payDate)}${reason?' – '+reason:''}`,payrunId:run.id,reversalOf:e.id,lines:PR.reverseLines(e.lines).map(({clear,...l})=>l),created:Date.now()}});
    w.push({op:'set',collection:'payruns',id:run.id,data:{...strip(run),void:{date,reason,entryId:e?id:'',at:Date.now()}}});
    if(await batch(w)){closeModal();toast('Pay run voided');renderMain()}};
}
/* ---------- direct deposit (CPA-005 file for the employer's bank) ---------- */
/** The pay run's lines paid by direct deposit: employees set to direct deposit, with net pay. */
function ddLines(run){return run.lines.filter(l=>l.net>0&&(employee(l.employeeId)||{}).payMethod==='deposit')}
async function ddFile(run){
  const cfg=payCfg(),dd=cfg.dd||{},lines=ddLines(run);
  const bad=TallyDD.setupProblems(dd);
  if(bad.length){
    const names={originatorId:'originator ID',dataCentre:'destination data centre',shortName:'short name',longName:'long name',returnAccount:'your bank account'};
    return confirmBox('Set up direct deposit first',`In Settings, under Payroll, enter what your bank gave you: ${bad.map(k=>T(names[k])).join(', ')}.`,'OK');
  }
  const payments=[];
  for(const l of lines){
    const e=employee(l.employeeId)||{},b=e.bank||{};
    if(/•/.test(String(b.account||'')))return confirmBox('Only your bookkeeper can make this file','Bank account numbers are hidden from your account, so the direct deposit file has to be made by someone who can see them.','OK');
    const why=TallyDD.bankProblem(b);
    if(why)return confirmBox('A bank account is missing',`${l.name}: enter their bank institution, transit and account numbers on the employee, or change them to be paid by cheque.`,'OK');
    payments.push({name:l.name,inst:b.inst,transit:b.transit,account:b.account,amount:l.net,ref:'PAY '+run.payDate});
  }
  const before=(dd.files||[]).filter(x=>x.run===run.id);
  if(before.length){const x=before[before.length-1];
    if(!await confirmBox('Make another file for this pay run?',`File number ${x.no} was already made for this pay run on ${fmtDate(x.date)}. If both files are uploaded to your bank, employees are paid twice. Only make a new one if your bank refused or never received the first.`,'Make a new file'))return}
  if(run.payDate<=today()&&!await confirmBox('The pay date is today or already past',`Most banks need the file 1 or 2 business days before the pay date, ${fmtDate(run.payDate)}. Deposits may arrive late. Make the file anyway?`,'Make the file'))return;
  const no=(+dd.lastFileNo||0)%9999+1;
  let out;
  try{out=TallyDD.cpa005({setup:dd,fileNo:no,created:today(),payDate:run.payDate,payments})}
  catch(err){return confirmBox('The file couldn’t be made',err.message,'OK')}
  // Save the file number first, so the same number is never handed out twice.
  const files=[...(dd.files||[]),{run:run.id,no,date:today(),count:out.count,total:out.total}];
  if(!await putCompany({...strip(S.company),payroll:{...cfg,dd:{...dd,lastFileNo:no,files}}}))return;
  saveFile(`direct-deposit_${run.payDate}_file-${String(no).padStart(4,'0')}.txt`,new Blob([out.text],{type:'text/plain'}));
  const cheque=run.lines.filter(l=>l.net>0&&!lines.includes(l)).map(l=>l.name);
  toast(T(`Direct deposit file ${no}: ${out.count} deposit${out.count===1?'':'s'}, ${money(out.total)}. Upload it to your business banking.`)+(cheque.length?' '+T('Not in the file (paid by cheque or other):')+' '+cheque.join(', '):''));
}
function stubHTML(run,l){
  const y=ytdFor(l.employeeId,run,true),e=employee(l.employeeId)||{};
  const row=(label,cur,ytd)=>`<tr><td>${esc(label)}</td><td class="n">${money(cur)}</td><td class="n">${ytd===null?'':money(ytd)}</td></tr>`;
  const ded=PR.EMPLOYEE_ITEMS.filter(([k])=>l.ded[k]||y.ded[k]).map(([k,n])=>row(n,l.ded[k]||0,y.ded[k]||0)).join('')+(l.rrsp||y.rrsp?row('RRSP / pension',l.rrsp||0,y.rrsp):'')+(l.union||y.union?row('Union dues',l.union||0,y.union):'');
  const er=PR.EMPLOYER_ITEMS.filter(([k])=>l.er[k]||y.er[k]).map(([k,n])=>row(n,l.er[k]||0,y.er[k]||0)).join('');
  return `<section class="stub">
    <header><div><b>${esc(S.company.name)}</b>${S.company.bn?`<div class="muted">BN ${esc(S.company.bn)}</div>`:''}</div><div style="text-align:right"><b>Pay stub</b><div class="muted">Pay date ${fmtDate(run.payDate)}</div>${run.from?`<div class="muted">Period ${fmtDate(run.from)} – ${fmtDate(run.to)}</div>`:''}</div></header>
    <div class="stub-emp"><b>${esc(l.name)}</b>${e.address?`<div class="muted" style="white-space:pre-line">${esc(e.address)}</div>`:''}</div>
    <table><thead><tr><th>Earnings</th><th class="n">This pay</th><th class="n">Year to date</th></tr></thead><tbody>
      ${l.payType==='hourly'&&l.hours?row(`Regular, ${r2(l.hours-(+l.otHours||0))} h × ${money(l.rate)}`,l.regular,null):row('Regular pay',l.regular??l.gross,null)}
      ${l.overtime?row(l.otHours?`Overtime, ${l.otHours} h × ${money(r2(l.overtime/l.otHours))}`:'Overtime',l.overtime,y.ot||0):''}
      ${l.holiday?row(`Holiday pay${(l.holidays||[]).length?` (${l.holidays.map(h=>(typeof tr==='function'&&tr(h.name))||h.name).join(', ')})`:''}`,l.holiday,y.hol||0):''}
      ${l.other?row('Other pay',l.other,null):''}${l.bonus?row(l.bonusVac?'Bonus (earns vacation pay)':'Bonus',l.bonus,null):''}${l.allowance?row('Taxable allowance',l.allowance,null):''}
      ${l.vacPay||y.vac?row(l.vacMode==='accrue'?'Vacation pay paid out':`Vacation pay (${l.vacRate}%)`,l.vacPay||0,y.vac||0):''}</tbody>
      <tfoot><tr><td><b>Gross pay</b></td><td class="n"><b>${money(l.gross)}</b></td><td class="n"><b>${money(y.gross)}</b></td></tr></tfoot></table>
    ${l.benefits||y.benefits?`<table><thead><tr><th>Taxable benefits (not paid to you)</th><th class="n">This pay</th><th class="n">Year to date</th></tr></thead><tbody>${PR.BENEFIT_KINDS.filter(b=>(l.benefits||{})[b.k]).map(b=>row(b.label,l.benefits[b.k],null)).join('')}</tbody>
      <tfoot><tr><td><b>Total taxable benefits</b></td><td class="n"><b>${money(benTotal(l))}</b></td><td class="n"><b>${money(y.benefits||0)}</b></td></tr></tfoot></table><div class="muted" style="font-size:12px;margin:-4px 0 8px">${(l.prov||e.prov)==='QC'?'Included in your taxable income and on your T4 and RL-1. Tax on them is taken from your pay.':'Included in your taxable income and on your T4. Tax on them is taken from your pay.'}</div>`:''}
    <table><thead><tr><th>Deductions</th><th class="n">This pay</th><th class="n">Year to date</th></tr></thead><tbody>${ded||'<tr><td colspan="3" class="muted">None</td></tr>'}</tbody>
      <tfoot><tr><td><b>Total deductions</b></td><td class="n"><b>${money(lineDed(l))}</b></td><td class="n"><b>${money(lineDed(y))}</b></td></tr></tfoot></table>
    <div class="stub-net"><span>Net pay</span><b>${money(l.net)}</b></div>
    ${run.void?'<div class="stub-vac"><b>Void</b>: <span>this pay run was cancelled.</span></div>':''}
    ${l.vacMode==='accrue'?`<div class="stub-vac"><span>Vacation pay owed to you after this pay:</span> <b>${money(vacBalance(l.employeeId,run,true))}</b> · <span>Set aside this pay: ${money(l.vacAccrued||0)}, at ${l.vacRate}%</span></div>`:''}
    ${er?`<table class="stub-er"><thead><tr><th>Paid by your employer</th><th class="n">This pay</th><th class="n">Year to date</th></tr></thead><tbody>${er}</tbody></table>`:''}
  </section>`;
}
function printStubs(run,lines){
  let root=$('#printRoot');if(!root){root=document.createElement('div');root.id='printRoot';document.body.appendChild(root)}
  root.innerHTML=lines.map(l=>stubHTML(run,l)).join('');
  document.body.classList.add('printing');
  const done=()=>{document.body.classList.remove('printing');root.innerHTML='';window.removeEventListener('afterprint',done)};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{window.print();setTimeout(()=>{if(document.body.classList.contains('printing'))done()},1500)},50);
}

/* ---------- remittance payments ---------- */
function remitDetail(key){
  const x=remittances().find(r=>r.agency+'|'+r.key===key);if(!x)return;
  const pays=S.entries.filter(e=>e.type==='payremit'&&e.agency+'|'+e.period===key).sort((a,b)=>a.date.localeCompare(b.date));
  const f=openModal(`${AGENCY_NAME[x.agency]} · ${x.label}`,`
    <div class="tbl-wrap"><table><tbody>${Object.entries(x.parts).map(([n,v])=>`<tr><td>${esc(n)}</td><td class="n">${money(v)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td><b>Total to remit</b></td><td class="n"><b>${money(x.owed)}</b></td></tr></tfoot></table></div>
    ${x.agency==='cra'?`<div class="banner" style="margin:0"><span>For the remittance voucher (PD7A): gross payroll ${money(x.gross)}; employees paid in the last pay period ${x.lastEmps}.</span></div>`:`<div class="banner" style="margin:0"><span>Report these amounts on your Revenu Québec source deductions remittance (TPZ-1015.R.14.1).</span></div>`}
    <div><div class="flabel" style="margin-bottom:6px">Payments</div>${pays.length?`<div class="tbl-wrap"><table><tbody>${pays.map(e=>`<tr class="click" data-rp="${e.id}"><td>${fmtDate(e.date)}</td><td class="muted">${esc(e.ref||'')}</td><td class="n">${money(e.amount)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="muted">No payment recorded yet.</div>'}</div>`,
    `<button type="button" class="btn" data-close>Close</button>${x.bal>0.004?`<button type="button" class="btn" data-go-guide>How to pay</button><button type="button" class="btn primary" data-go-pay>Record payment</button>`:''}`);
  f.addEventListener('click',ev=>{const r=ev.target.closest('[data-rp]');if(r)remitForm(key,S.entries.find(e=>e.id===r.dataset.rp));if(ev.target.closest('[data-go-pay]'))remitForm(key);if(ev.target.closest('[data-go-guide]'))remitGuide(key)});
}
/* Everything the client needs to pay a remittance in their own online banking, each part one tap to copy.
   No money moves through Sumlora: they pay at their bank, then record the payment here. */
function remitGuide(key){
  const x=remittances().find(r=>r.agency+'|'+r.key===key);if(!x)return;
  const cra=x.agency==='cra',c=payCfg(),acct=String((cra?c.craAccount:c.rqId)||'').replace(/\s+/g,'').toUpperCase();
  const prob=PR.remitAccountProblem(x.agency,acct),period=PR.remitPeriodEnd(x.key),amt=r2(x.bal).toFixed(2);
  const quarterly=/-Q[1-4]$/.test(x.key);
  const row=(label,shown,copy,hint)=>`<tr><td><div class="flabel">${label}</div><div style="font-size:16px;font-weight:600"${copy!=null?' translate="no"':''}>${shown}</div>${hint?`<div class="muted" style="font-size:12px">${hint}</div>`:''}</td><td class="n" style="vertical-align:middle">${copy!=null?`<button type="button" class="btn sm" data-copy="${esc(copy)}">Copy</button>`:''}</td></tr>`;
  const acctRow=prob?`<tr><td colspan="2"><div class="banner" style="margin:0"><span>${prob==='missing'?(cra?'Add your CRA payroll account number (123456789RP0001) in Settings → Payroll.':'Add your Revenu Québec identification number (1234567890RS0001) in Settings → Payroll.'):(cra?'The CRA payroll account number in Settings → Payroll doesn’t look right. It should be 9 digits, RP and 4 digits (123456789RP0001).':'The Revenu Québec identification number in Settings → Payroll doesn’t look right. It should be 10 digits, RS and 4 digits (1234567890RS0001).')}</span> <button type="button" class="link" data-go-settings>Open Settings</button></div></td></tr>`
    :row(cra?'Account number (payroll account)':'Identification number',esc(acct),acct,cra?'Your business number + RP + 4 digits':'');
  const late=x.due&&x.due<today();
  const f=openModal(`${cra?'Pay CRA':'Pay Revenu Québec'} · ${x.label}`,`
    <div class="tbl-wrap"><table><tbody>
      ${row('Payee',cra?'CRA – payroll deductions':'Revenu Québec – source deductions',null,cra?`Most banks list it as “Federal – payroll deductions – ${quarterly?'quarterly':'regular'}” or similar. Search “payroll” when adding the payee.`:'Search “Revenu Québec” or “retenues à la source” when adding the payee.')}
      ${acctRow}
      ${row('Amount',money(x.bal),amt)}
      ${row('Remitting period',esc(period),period,quarterly?'The last month of the quarter':'The month you paid employees, not the month you’re paying in')}
      ${row('Due',`<span class="${late?'neg':''}">${fmtDate(x.due)}</span>`,null,late?'This is past due. Pay as soon as you can; CRA can charge a penalty and interest on late remittances.':'Bank payments can take 1 to 3 business days to reach the government. Pay a few days early so it arrives by the due date.')}
    </tbody></table></div>
    <div class="muted" style="font-size:13px">${cra?'You can also pay with CRA My Payment or a pre-authorized debit in CRA My Business Account.':'You can also pay through Mon dossier for businesses at Revenu Québec.'} Once it’s paid, record it here so your books show the remittance as paid.</div>`,
    `<button type="button" class="btn" data-close>Close</button><button type="button" class="btn primary" data-paid>I’ve paid. Record it</button>`);
  f.addEventListener('click',async ev=>{
    const b=ev.target.closest('[data-copy]');
    if(b){const v=b.dataset.copy;try{await navigator.clipboard.writeText(v);toast('Copied')}catch(e){prompt('Copy this:',v)}return}
    if(ev.target.closest('[data-paid]')){remitForm(key);return}
    if(ev.target.closest('[data-go-settings]')){closeModal();go('settings')}
  });
}
function remitForm(key,entry){
  const[agency,period]=key.split('|');const x=remittances().find(r=>r.agency===agency&&r.key===period);
  const acc=byDetail(agency==='cra'?'payroll_cra':'payroll_rq');if(!acc){toast('Post a pay run first.',true);return}
  const owing=r2((x?x.bal:0)+(entry?+entry.amount:0));
  const defBank=entry?.bank||(sortAccts(S.accounts.filter(a=>a.detail==='bank'))[0]||{}).id;
  const f=openModal(`Pay ${AGENCY_NAME[agency]} · ${x?x.label:period}`,`<div class="fields">
    ${fld('qDate','Payment date',`<input type="date" id="qDate" value="${entry?.date||today()}">`)}
    ${fld('qAmt','Amount',`<input type="number" id="qAmt" step="0.01" inputmode="decimal" value="${entry?entry.amount:owing}">`)}
    ${fld('qBank','Paid from',`<select id="qBank">${acctOptions(defBank,a=>a.detail==='bank')}</select>`)}
    ${fld('qRef','Reference',`<input type="text" id="qRef" value="${esc(entry?.ref||'')}" placeholder="Confirmation number">`)}</div>
    ${x&&x.due?`<div class="muted" style="font-size:13px">Due ${fmtDate(x.due)}. ${agency==='cra'?'Pay through your bank (“CRA – payroll deductions”) or CRA My Business Account.':'Pay through your bank or Mon dossier for businesses.'}</div>`:''}`,saveFoot(!!entry,'Save payment'));
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this payment?','The remittance will show as unpaid again.'))return;if(await del('entries',entry.id)){closeModal();toast('Payment deleted')}};
  f.onsubmit=async ev=>{ev.preventDefault();const amt=r2($('#qAmt',f).value),bank=$('#qBank',f).value;
    if(!(amt>0))return f.err('Enter an amount above zero.');if(!bank)return f.err('Choose a bank account.');
    const id=entry?.id||uid();
    if(await put('entries',id,{type:'payremit',agency,period,periodLabel:x?x.label:period,amount:amt,bank,date:$('#qDate',f).value||today(),ref:$('#qRef',f).value.trim(),memo:`Payroll remittance – ${AGENCY_NAME[agency]}, ${x?x.label:period}`,
      lines:[{account:acc.id,debit:amt,credit:0},{account:bank,debit:0,credit:amt}],created:entry?.created||Date.now()})){closeModal();toast('Remittance payment saved')}};
}

/* ---------- Ontario Employer Health Tax (EHT) ----------
   A worksheet on the Year-end tab: Ontario remuneration month by month (T4 box 14 for Ontario employees), the
   exemption, the rate from the tiered table, monthly instalments when remuneration is over $1,200,000, and an optional
   monthly accrual entry (Dr EHT expense, Cr EHT payable). The maths is PR.eht in payroll-calc.js. */
function ehtData(year){
  const c=payCfg().eht||{};
  const months=PR.ontarioRemuneration({year,employees:S.employees,payruns:S.payruns});
  return PR.eht({year,months,eligible:c.eligible!==false,exemption:c.exemption,groupPayroll:c.groupPayroll});
}
const ehtEntryId=m=>'eht_'+m;
function vEht(){
  const year=S.ye.year||+today().slice(0,4),X=ehtData(year);
  if(!X.total)return '';
  const cl=S.company.closingDate,mEnd=m=>monthEnd(+m.slice(0,4),+m.slice(5,7));
  const todo=X.months.filter(m=>m.accrual>0&&mEnd(m.month)<=today()&&!S.entries.some(e=>e.id===ehtEntryId(m.month))&&!(cl&&mEnd(m.month)<=cl));
  const row=(l,v)=>`<tr><td>${l}</td><td class="n">${v}</td></tr>`;
  return `<div class="panel" style="margin-top:16px"><h3>Ontario Employer Health Tax (EHT) · ${year}</h3>
    <div class="grid2" style="gap:16px;padding:0 16px 16px"><div class="tbl-wrap"><table><tbody>
      ${row('Total Ontario remuneration',money(X.total))}${row('Minus: exemption',money(X.exemption))}${row('Taxable remuneration',money(X.taxable))}
      ${row(`Rate (for total remuneration of ${money(X.total)})`,isFr()?`${String(X.ratePct).replace('.',',')}\u00a0%`:`${X.ratePct}%`)}
      <tr class="tot"><td><b>EHT for the year</b></td><td class="n"><b>${money(X.tax)}</b></td></tr>
      ${X.instalmentsRequired?row('Minus: monthly instalments',money(X.instalments))+`<tr class="tot"><td>Balance with the annual return</td><td class="n">${money(X.balance)}</td></tr>`:''}
    </tbody></table></div>
    <div class="muted" style="font-size:13px"><p style="margin-top:0">${X.instalmentsRequired?`<span>Ontario remuneration is over ${money(PR.EHT.instalments)}, so EHT is paid in monthly instalments, due the 15th of the next month (below).</span>`:`<span>Remuneration is ${money(PR.EHT.instalments)} or less, so there are no instalments: pay it all with the annual return.</span>`} <span>The annual return is due ${fmtDate(X.due)}, even when no tax is owed.</span></p>
      <p>${X.notes.includes('group')?`<span class="neg">Your associated group’s Ontario payroll is over ${money(PR.EHT.groupLimit)}, so no exemption can be claimed.</span> `:''}${payCfg().eht?.eligible===false?'<span>Not eligible for the exemption (Settings → Payroll).</span> ':''}<span>Remuneration includes taxable benefits and amounts paid before Sumlora. The rate is set by the year’s total, so it can still change until December.</span> <span>File and pay in ONT-TAXS online.</span></p></div></div>
    <div class="tbl-wrap"><table><thead><tr><th>Month</th><th class="n">Remuneration</th><th class="n">Year to date</th><th class="n">Above the exemption</th><th class="n">Accrual</th>${X.instalmentsRequired?'<th class="n">Instalment</th><th>Due</th>':''}<th></th></tr></thead><tbody>
      ${X.months.filter(m=>m.remuneration||m.instalment).map(m=>{const rec=S.entries.find(e=>e.id===ehtEntryId(m.month));return `<tr><td>${pd(m.month+'-01').toLocaleDateString(LOC(),{month:'long',year:'numeric'})}</td><td class="n">${money(m.remuneration)}</td><td class="n">${money(m.cumulative)}</td><td class="n">${money(m.taxable)}</td><td class="n">${money(m.accrual)}</td>${X.instalmentsRequired?`<td class="n">${m.instalment?money(m.instalment):''}</td><td class="muted" style="white-space:nowrap">${m.instalment?fmtDate(m.due):''}</td>`:''}<td>${rec?'<span class="pill paid">Recorded</span>':''}</td></tr>`}).join('')}
    </tbody></table></div>
    <div class="toolbar" style="padding:12px 16px"><span class="grow muted" style="font-size:13px">Optional: record EHT as it builds up each month (Dr Employer health tax, Cr Employer health tax payable), so the books show it before the return.</span>${todo.length?`<button class="btn" data-eht-accrue="${year}">Record ${todo.length} monthly accrual${todo.length===1?'':'s'}</button>`:''}</div></div>`;
}
async function ehtAccrue(year){
  const X=ehtData(year),cl=S.company.closingDate,mEnd=m=>monthEnd(+m.slice(0,4),+m.slice(5,7));
  const todo=X.months.filter(m=>m.accrual>0&&mEnd(m.month)<=today()&&!S.entries.some(e=>e.id===ehtEntryId(m.month))&&!(cl&&mEnd(m.month)<=cl));
  if(!todo.length)return;
  if(!await confirmBox('Record EHT accruals?',`${todo.length} journal entr${todo.length===1?'y':'ies'}, one at the end of each month, for ${money(r2(todo.reduce((t,m)=>t+m.accrual,0)))} in all.`,'Record'))return;
  const{writes,ids}=payAccounts(false,false,false,true);
  for(const m of todo)writes.push({op:'set',collection:'entries',id:ehtEntryId(m.month),data:{type:'journal',date:mEnd(m.month),ref:'EHT',memo:`Ontario Employer Health Tax accrual, ${m.month}`,
    lines:[{account:ids.eht,debit:m.accrual,credit:0},{account:ids.eht_payable,debit:0,credit:m.accrual}],created:Date.now()}});
  if(await batch(writes)){toast('EHT accruals recorded');renderMain()}
}

/* ---------- workers' compensation report ----------
   On the Remittances tab: insurable earnings and premium by rate group for each reporting period, with the due date.
   Pay the board from its own site; record the payment against "Workers’ compensation payable". */
function vWsib(){
  const w=wsibCfg();
  const lines=[];for(const r of liveRuns())for(const l of r.lines)if(l.wsib)lines.push({payDate:r.payDate,group:l.wsib.group,insurable:l.wsib.insurable,premium:l.wsib.premium});
  if(!w.on&&!lines.length)return '';
  const rep=PR.wsibReport(lines,w.freq),gname=id=>{const g=w.groups.find(x=>x.id===id);return g?(g.name||g.code||id)+(g.code&&g.name?` (${g.code})`:''):id};
  const label=p=>p.key.length===4?p.key:/Q/.test(p.key)?p.key.replace(/^(\d{4})-Q(\d)$/,'Q$2 $1'):pd(p.from).toLocaleDateString(LOC(),{month:'long',year:'numeric'});
  return `<div class="panel" style="margin-top:16px"><h3><span>Workers’ compensation (WSIB)${w.account?` <span class="muted" translate="no">· ${esc(w.account)}</span>`:''}</span></h3>
    <div class="tbl-wrap"><table><thead><tr><th>Period</th><th>Rate group</th><th class="n">Insurable earnings</th><th class="n">Premium</th><th>Due</th></tr></thead><tbody>
    ${rep.length?rep.map(p=>Object.entries(p.groups).map(([g,x],i,a)=>`<tr><td>${i?'':esc(label(p))}</td><td>${esc(gname(g))}</td><td class="n">${money(x.insurable)}</td><td class="n">${money(x.premium)}</td><td class="${i?'':p.due<today()?'neg':'muted'}" style="white-space:nowrap">${i?'':fmtDate(p.due)}</td></tr>`).join('')+(Object.keys(p.groups).length>1?`<tr class="tot"><td></td><td>Total</td><td class="n">${money(p.insurable)}</td><td class="n">${money(p.premium)}</td><td></td></tr>`:'')).join(''):emptyRow(5,'No premiums yet','Premiums are worked out on pay runs posted from now on.')}
    </tbody></table></div>
    <div class="pad muted" style="font-size:13px">Report the insurable earnings and pay the premium by the due date in WSIB online services (other provinces: your workers’ compensation board). Record the payment as an expense from the bank to Workers’ compensation payable. Insurable earnings stop at ${money(w.max||0)} per worker for the year.</div></div>`;
}

/* ---------- settings panel ---------- */
function payrollSettingsPanel(){
  const c=payCfg(),dd=c.dd||{};
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Payroll</h3><form class="pad" id="paySetForm" style="display:flex;flex-direction:column;gap:14px">
    <div class="fields">${fld('psFreq','Remitting source deductions',`<select id="psFreq"><option value="monthly" ${c.remitFreq==='monthly'?'selected':''}>Monthly (regular remitter)</option><option value="quarterly" ${c.remitFreq==='quarterly'?'selected':''}>Quarterly</option></select><span class="hint">CRA tells you which in your remitter letter</span>`)}
    ${fld('psHsf','Quebec Health Services Fund rate (%)',`<input type="number" id="psHsf" min="0" max="10" step="0.01" value="${esc(c.hsfRate)}"><span class="hint">Only for employees in Quebec. 1.65% for most small employers.</span>`)}
    ${fld('psCra','CRA payroll account number',`<input type="text" id="psCra" maxlength="15" placeholder="123456789RP0001" value="${esc(c.craAccount||'')}" translate="no"><span class="hint">Your business number + RP + 4 digits. T4 box 54.</span>`)}
    ${fld('psRq','Revenu Québec identification number',`<input type="text" id="psRq" maxlength="16" placeholder="1234567890RS0001" value="${esc(c.rqId||'')}" translate="no"><span class="hint">For RL-1 slips and the RL-1 Summary, if you have employees in Quebec.</span>`)}</div>
    <div class="fields">${fld('psAssoc','Payroll of associated employers',`<input type="number" id="psAssoc" step="0.01" min="0" value="${c.assocPayroll||''}"><span class="hint">Only if this business is associated with others. Revenu Québec sets the Health Services Fund rate from everyone’s total payroll.</span>`)}</div>
    <label class="check"><input type="checkbox" id="psPrim" ${c.hsfPrimary?'checked':''}> Primary or manufacturing business (lower Health Services Fund rate)</label>
    <h3 class="fsec">Overtime</h3>
    <div class="fields">${fld('psOt','Overtime after (hours a week)',`<input type="number" id="psOt" min="1" max="168" step="0.5" value="${esc(c.otThreshold??'')}" placeholder="${PR.overtimeRule(S.company.province||'ON').weekly}"><span class="hint"><span>Blank = your province’s rule:</span> <span translate="no">${Object.entries(PR.OVERTIME).map(([k,v])=>`${k} ${v.weekly}`).join(', ')}</span>. <span>Overtime is paid at 1.5 times the regular rate.</span></span>`)}</div>
    <h3 class="fsec">Ontario Employer Health Tax (EHT)</h3>
    <div class="fields"><label class="check" style="align-self:end;margin-bottom:10px"><input type="checkbox" id="psEhtEl" ${c.eht?.eligible!==false?'checked':''}> <span>Eligible for the ${money(PR.EHT.exemption)} exemption</span></label>
      ${fld('psEhtEx','Your share of the exemption',`<input type="number" id="psEhtEx" min="0" max="1000000" step="0.01" value="${esc(c.eht?.exemption??'')}" placeholder="1000000"><span class="hint">Only if you’re associated with other employers: the share given to you in your group’s allocation agreement.</span>`)}
      ${fld('psEhtGrp','Associated employers’ Ontario payroll',`<input type="number" id="psEhtGrp" min="0" step="0.01" value="${c.eht?.groupPayroll||''}"><span class="hint">No exemption when the group’s Ontario payroll is over ${money(PR.EHT.groupLimit)}.</span>`)}</div>
    <h3 class="fsec">Workers’ compensation (WSIB)</h3>
    <label class="check"><input type="checkbox" id="psWsibOn" ${wsibCfg().on?'checked':''}> <span>Work out workers’ compensation premiums on each pay run</span></label>
    <div data-wsib class="fields">${fld('psWsibAcct','Account number',`<input type="text" id="psWsibAcct" maxlength="30" value="${esc(wsibCfg().account)}" translate="no">`)}
      ${fld('psWsibFreq','Reporting and paying',`<select id="psWsibFreq">${[['monthly','Monthly'],['quarterly','Quarterly'],['annual','Once a year']].map(([k,l])=>`<option value="${k}" ${wsibCfg().freq===k?'selected':''}>${l}</option>`).join('')}</select><span class="hint">WSIB: monthly for payroll of ${money(1000000)} or more, quarterly from ${money(20000)}, once a year under ${money(20000)}.</span>`)}
      ${fld('psWsibMax','Maximum insurable earnings (per worker, per year)',`<input type="number" id="psWsibMax" min="0" step="0.01" value="${esc(c.wsib?.max??'')}" placeholder="${PR.WSIB_MAX[+today().slice(0,4)]||''}"><span class="hint">Blank = WSIB’s maximum for the year (${money(PR.WSIB_MAX[2026])} in 2026). Other provinces: enter your board’s.</span>`)}</div>
    <div data-wsib><div class="flabel" style="margin-bottom:6px">Rate groups</div><div class="muted" style="font-size:12.5px;margin-bottom:6px">Most employers have one. The rate is per $100 of insurable earnings, from your premium rate notice. Choose each employee’s group on their page.</div>
      <div data-wsibgroups>${(wsibCfg().groups.length?wsibCfg().groups:[{id:'g1',name:'',code:'',rate:''}]).map(wsibGroupRow).join('')}</div>
      <button type="button" class="btn sm ghost" data-wsibadd>+ Add a rate group</button></div>
    <h3 class="fsec">Direct deposit</h3>
    <div class="muted" style="font-size:13px">Sumlora makes a direct deposit file (CPA-005) for each pay run. You upload it to your business online banking, and your bank pays your employees from your account. Your bank sets up the service and gives you the numbers below.</div>
    <div class="fields">${fld('psDdOrig','Originator ID',`<input type="text" id="psDdOrig" maxlength="10" autocomplete="off" value="${esc(dd.originatorId||'')}" translate="no"><span class="hint">10 letters or digits, from your bank</span>`)}
      ${fld('psDdDc','Destination data centre',`<input type="text" id="psDdDc" inputmode="numeric" maxlength="5" value="${esc(dd.dataCentre||'')}" translate="no"><span class="hint">5 digits, from your bank</span>`)}
      ${fld('psDdShort','Short name',`<input type="text" id="psDdShort" maxlength="15" value="${esc(dd.shortName||'')}"><span class="hint">Up to 15 characters. Shows on employees’ bank statements.</span>`)}
      ${fld('psDdLong','Long name',`<input type="text" id="psDdLong" maxlength="30" value="${esc(dd.longName||S.company.name||'')}"><span class="hint">Up to 30 characters</span>`)}
      ${fld('psDdInst','Your institution number',`<input type="text" id="psDdInst" inputmode="numeric" maxlength="3" value="${esc(dd.returnInst||'')}" translate="no"><span class="hint">The account deposits are paid from, and returned to if one can’t be made</span>`)}
      ${fld('psDdTr','Your transit number',`<input type="text" id="psDdTr" inputmode="numeric" maxlength="5" value="${esc(dd.returnTransit||'')}" translate="no">`)}
      ${fld('psDdAcct','Your account number',`<input type="text" id="psDdAcct" inputmode="numeric" maxlength="12" autocomplete="off" value="${esc(dd.returnAccount||'')}" translate="no">`)}
      ${fld('psDdNext','Next file number',`<input type="number" id="psDdNext" min="1" max="9999" step="1" value="${(dd.lastFileNo||0)%9999+1}"><span class="hint">Goes up by one with each file. Your bank refuses a number it has already received.</span>`)}</div>
    <div><button class="btn" type="submit">Save payroll settings</button></div></form></div>`;
}
const wsibGroupRow=g=>`<div class="fields" data-wg="${esc(g.id)}" style="align-items:end"><div class="field"><label>Name</label><input type="text" data-wgname maxlength="80" value="${esc(g.name)}" placeholder="Retail stores"></div><div class="field"><label>Class or rate group</label><input type="text" data-wgcode maxlength="20" value="${esc(g.code)}" translate="no"></div><div class="field"><label>Rate per $100</label><input type="number" data-wgrate min="0" max="100" step="0.0001" value="${esc(g.rate)}"></div><div><button type="button" class="btn sm ghost" data-wgdel title="Remove">×</button></div></div>`;
function bindPayrollSettings(m){const f=$('#paySetForm',m);if(!f)return;
  const sync=()=>$$('[data-wsib]',f).forEach(x=>x.style.display=$('#psWsibOn',f).checked?'':'none');$('#psWsibOn',f).onchange=sync;sync();
  $('[data-wsibadd]',f).onclick=()=>$('[data-wsibgroups]',f).insertAdjacentHTML('beforeend',wsibGroupRow({id:uid(),name:'',code:'',rate:''}));
  f.addEventListener('click',ev=>{const d=ev.target.closest('[data-wgdel]');if(d)d.closest('[data-wg]').remove()});
  f.onsubmit=async e=>{e.preventDefault();
    const groups=$$('[data-wg]',f).map(x=>({id:x.dataset.wg,name:$('[data-wgname]',x).value.trim(),code:$('[data-wgcode]',x).value.trim(),rate:$('[data-wgrate]',x).value})).filter(g=>g.name||g.code||g.rate!=='').map(g=>({...g,rate:+g.rate||0}));
    if($('#psWsibOn',f).checked&&!groups.some(g=>g.rate>0)){toast('Add a rate group with its rate per $100 of insurable earnings.',true);return}
    const n=id=>{const v=$('#'+id,f).value;return v===''?'':+v};
    if(await putCompany({...strip(S.company),payroll:{...payCfg(),otThreshold:n('psOt'),eht:{eligible:$('#psEhtEl',f).checked,exemption:n('psEhtEx'),groupPayroll:+$('#psEhtGrp',f).value||0},
    wsib:{on:$('#psWsibOn',f).checked,account:$('#psWsibAcct',f).value.trim(),freq:$('#psWsibFreq',f).value,max:n('psWsibMax'),groups},
    remitFreq:$('#psFreq',f).value,hsfRate:+$('#psHsf',f).value||0,craAccount:$('#psCra',f).value.trim(),rqId:$('#psRq',f).value.trim(),hsfPrimary:$('#psPrim',f).checked,assocPayroll:+$('#psAssoc',f).value||0,
    dd:{...(payCfg().dd||{}),originatorId:$('#psDdOrig',f).value.trim(),dataCentre:$('#psDdDc',f).value.trim(),shortName:$('#psDdShort',f).value.trim(),longName:$('#psDdLong',f).value.trim(),
      returnInst:$('#psDdInst',f).value.trim(),returnTransit:$('#psDdTr',f).value.trim(),returnAccount:$('#psDdAcct',f).value.trim(),lastFileNo:Math.max(0,Math.min(9998,(parseInt($('#psDdNext',f).value,10)||1)-1))}}}))toast('Payroll settings saved')}}
