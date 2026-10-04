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
  ['vacation_payable','Liability','2330','Vacation pay payable','Indemnités de vacances à payer']];
DETAILS.Liability.push(['payroll_cra','Payroll liabilities – CRA'],['payroll_rq','Payroll liabilities – Revenu Québec'],['payroll_other','Other payroll deductions'],['vacation_payable','Vacation pay payable']);
DETAILS.Expense.push(['wages','Wages and salaries'],['payroll_tax','Employer payroll taxes']);
Object.assign(TLABEL,{payrun:'Payroll',payremit:'Payroll remittance'});
const AGENCY_NAME={cra:'CRA',rq:'Revenu Québec'};
const DED_KEYS=PR.EMPLOYEE_ITEMS.map(x=>x[0]),ER_KEYS=PR.EMPLOYER_ITEMS.map(x=>x[0]);

const payCfg=()=>({hsfRate:1.65,remitFreq:'monthly',...(S.company.payroll||{})});
const employee=id=>S.employees.find(e=>e.id===id);
const provName=k=>(typeof PROVS!=='undefined'&&PROVS[k]?PROVS[k].name:k);
const payOf=e=>e.payType==='hourly'?`${money(e.rate)}/hour`:`${money(e.rate)}/year`;
const sumObj=(a,b)=>{for(const[k,v]of Object.entries(b||{}))a[k]=r2((a[k]||0)+(+v||0));return a};
const runOrder=(a,b)=>a.payDate.localeCompare(b.payDate)||(a.created||0)-(b.created||0);

/* ---------- vacation pay and holiday pay ----------
   Vacation pay is worked out on regular pay, holiday pay and other pay (not on bonuses marked as such).
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
  for(const r of S.payruns)for(const l of r.lines){
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
  for(const r of S.payruns)for(const l of r.lines){
    if(l.employeeId!==empId)continue;
    const[from,to]=runPeriod(r);
    out.push({from,to,amount:r2((l.regular??l.gross)+(prov==='ON'?(+l.vacPay||0):0))});
  }
  return out;
}
const WORKDAYS={weekly:5,biweekly:10,semimonthly:10.83,monthly:21.67};

/* Year-to-date for one employee: opening amounts entered on the employee, plus every pay run in that calendar year
   that comes before `until` (a pay run, or {payDate} for a new one). */
function ytdFor(empId,until,inclusive){
  const year=until.payDate.slice(0,4),e=employee(empId)||{};
  const y={gross:0,pensionable:0,insurable:0,rrsp:0,union:0,net:0,ded:{},er:{}};
  const o=e.openingYtd;
  if(o&&String(o.year)===year){
    const has=v=>v!==undefined&&v!==null&&v!=='';y.gross=+o.gross||0;y.pensionable=+(has(o.pensionable)?o.pensionable:o.gross)||0;y.insurable=+(has(o.insurable)?o.insurable:o.gross)||0;
    DED_KEYS.forEach(k=>y.ded[k]=+o[k]||0);y.er.qpip=+o.erQpip||0;
  }
  for(const r of S.payruns.slice().sort(runOrder)){
    if(r.payDate.slice(0,4)!==year)continue;
    const before=runOrder(r,until)<0||(inclusive&&r.id===until.id);
    if(!before||(until.id&&r.id===until.id&&!inclusive))continue;
    for(const l of r.lines)if(l.employeeId===empId){
      y.bonus=r2((y.bonus||0)+(+l.bonus||0));y.benefits=r2((y.benefits||0)+benTotal(l));
      y.gross=r2(y.gross+l.gross);y.pensionable=r2(y.pensionable+(l.cppExempt?0:(l.pensionable??l.gross)));y.insurable=r2(y.insurable+(l.insurable??l.gross));
      y.rrsp=r2(y.rrsp+(+l.rrsp||0));y.union=r2(y.union+(+l.union||0));y.net=r2(y.net+l.net);sumObj(y.ded,l.ded);sumObj(y.er,l.er);
      y.vac=r2((y.vac||0)+(+l.vacPay||0));y.hol=r2((y.hol||0)+(+l.holiday||0));
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
  const t={gross:0,ded:0,net:0,er:0,cra:0,rq:0,other:0,vacAcc:0,vacOut:0};
  for(const l of r.lines){const sp=PR.remitSplit(l.ded,l.er);t.gross+=l.gross;t.ded+=lineDed(l);t.net+=l.net;t.er+=lineEr(l);t.cra+=sp.cra;t.rq+=sp.rq;t.other+=(+l.rrsp||0)+(+l.union||0);
    t.vacAcc+=+l.vacAccrued||0;if(l.vacMode==='accrue')t.vacOut+=+l.vacPay||0}
  for(const k in t)t[k]=r2(t[k]);
  t.cost=r2(t.gross-t.vacOut+t.vacAcc+t.er); // what the pay run costs the business: vacation pay counts when it's earned
  return t;
}

/* Payroll accounts are added the first time they're needed. An existing "7100 Wages" account is reused. */
function payAccounts(needRq,needVac){
  const writes=[],ids={};
  for(const[detail,type,code,nameEn,nameFr]of PAY_ACCTS){
    const name=S.company.lang==='fr'?nameFr:nameEn;
    if((detail==='payroll_rq'&&!needRq)||(detail==='vacation_payable'&&!needVac)){ids[detail]=byDetail(detail)?.id;continue}
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
  for(const r of S.payruns.slice().sort(runOrder)){
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
const overdueRemits=()=>S.payruns.length?remittances().filter(x=>x.st.k==='overdue').length:0;

/* ---------- views ---------- */
function vPayroll(){
  if(typeof feat==='function'&&!feat('payroll'))return head('Payroll','')+'<div class="panel"><div class="empty"><b>Payroll is off for this company</b>Turn it on in Settings → Features (it’s part of the Plus plan).</div></div>';
  const P=S.pay,t=today(),yr=t.slice(0,4);
  const act=S.employees.filter(e=>e.active!==false);
  const h=head('Payroll','Pay employees, print pay stubs and track what you owe CRA and Revenu Québec',
    `<button class="btn" data-pay-emp="new">+ Add employee</button><button class="btn primary" data-pay-run="new" ${act.length?'':'disabled'}>Run payroll</button>`)+
    `<div class="tabs" role="tablist">${[['runs','Pay runs'],['employees','Employees'],['remit','Remittances'],['yearend','Year-end (T4, RL-1)']].map(([k,v])=>`<button role="tab" data-ptab="${k}" aria-selected="${P.tab===k}">${v}</button>`).join('')}</div>`;
  if(P.tab==='yearend')return h+vYearEnd();
  if(P.tab==='employees'){
    const list=S.employees.slice().sort((a,b)=>(a.active===false)-(b.active===false)||a.name.localeCompare(b.name));
    const vac=list.some(e=>vacMode(e)==='accrue'||vacBalance(e.id));
    return h+`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Province</th><th>Pay schedule</th><th class="n">Pay</th><th class="n">Gross, ${yr}</th>${vac?'<th class="n" title="Vacation pay set aside and not yet paid">Vacation pay owed</th>':''}<th>Status</th></tr></thead><tbody>${list.length?list.map(e=>`<tr class="click" data-pay-emp="${e.id}"><td>${esc(e.name)} ${e.example?'<span class="pill ex">Example</span>':''}</td><td>${esc(provName(e.prov))}</td><td>${PR.FREQ_LABEL[e.freq]||''}</td><td class="n">${payOf(e)}</td><td class="n">${money(ytdFor(e.id,{payDate:t+'~'},false).gross)}</td>${vac?`<td class="n">${vacMode(e)==='accrue'||vacBalance(e.id)?money(vacBalance(e.id)):'<span class="muted">—</span>'}</td>`:''}<td>${e.active===false?`<span class="pill quiet">Inactive</span>${(e.roes||[]).length?' <span class="pill quiet">ROE</span>':''}`:'<span class="pill paid">Active</span>'}</td></tr>`).join(''):emptyRow(vac?7:6,'No employees yet','Add an employee with their TD1 amounts, then run payroll.')}</tbody></table></div></div>`;
  }
  if(P.tab==='remit'){
    const rs=remittances();
    return h+`<div class="panel"><div class="toolbar"><span class="grow muted">${payCfg().remitFreq==='quarterly'?'Quarterly remitter':'Regular (monthly) remitter'}: payment due the 15th of the month after ${payCfg().remitFreq==='quarterly'?'each quarter':'you pay employees'}. Change this in Settings.</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Agency</th><th>Period</th><th>Due</th><th class="n">Owed</th><th class="n">Paid</th><th class="n">Balance</th><th>Status</th><th></th></tr></thead><tbody>${rs.length?rs.map(x=>`<tr class="click" data-remit="${x.agency}|${x.key}"><td>${AGENCY_NAME[x.agency]}</td><td>${esc(x.label)}</td><td class="${x.st.k==='overdue'?'neg':'muted'}" style="white-space:nowrap">${fmtDate(x.due)}</td><td class="n">${money(x.owed)}</td><td class="n">${money(x.paid)}</td><td class="n">${money(x.bal)}</td><td><span class="pill ${x.st.k}">${x.st.label}</span></td><td class="n">${x.bal>0.004?`<button class="btn sm" data-remit-pay="${x.agency}|${x.key}">Record payment</button>`:''}</td></tr>`).join(''):emptyRow(8,'Nothing to remit yet','Source deductions show up here after your first pay run.')}</tbody></table></div></div>`;
  }
  const runs=S.payruns.slice().sort((a,b)=>runOrder(b,a));
  const yrRuns=runs.filter(r=>r.payDate.startsWith(yr)),tot=yrRuns.map(runTotals);
  const due=remittances().filter(x=>x.bal>0.004).sort((a,b)=>(a.due||'').localeCompare(b.due||''))[0];
  const chips=`<div class="chips"><div class="chip"><div class="lbl">Gross pay, ${yr}</div><div class="val">${money(tot.reduce((s,x)=>s+x.gross,0))}</div></div><div class="chip"><div class="lbl">Employer contributions, ${yr}</div><div class="val">${money(tot.reduce((s,x)=>s+x.er,0))}</div></div><div class="chip"><div class="lbl">Next remittance</div><div class="val ${due&&due.st.k==='overdue'?'neg':''}">${due?`${money(due.bal)} · ${AGENCY_NAME[due.agency]} by ${fmtDate(due.due)}`:'Nothing owing'}</div></div></div>`;
  return h+chips+`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Pay date</th><th>Period</th><th class="n">Employees</th><th class="n">Gross</th><th class="n">Deductions</th><th class="n">Net pay</th><th class="n">To remit</th></tr></thead><tbody>${runs.length?runs.map(r=>{const t=runTotals(r);return `<tr class="click" data-pay-run="${r.id}"><td style="white-space:nowrap">${fmtDate(r.payDate)}</td><td class="muted" style="white-space:nowrap">${r.from?`${fmtDate(r.from)} – ${fmtDate(r.to)}`:''}</td><td class="n">${r.lines.length}</td><td class="n">${money(t.gross)}</td><td class="n">${money(t.ded)}</td><td class="n">${money(t.net)}</td><td class="n">${money(r2(t.cra+t.rq))}</td></tr>`}).join(''):emptyRow(7,'No pay runs yet',S.employees.length?'Choose Run payroll to calculate deductions and pay your employees.':'Start by adding an employee.')}</tbody></table></div></div>`;
}
async function payClick(e,t,d){
  if(await yeClick(e,t,d))return true;
  if(d.ptab){S.pay.tab=d.ptab;renderMain();return true}
  if(d.payEmp){employeeForm(d.payEmp==='new'?null:employee(d.payEmp));return true}
  if(d.payRun){if(d.payRun==='new')payRunForm();else payRunView(S.payruns.find(r=>r.id===d.payRun));return true}
  if(d.remitPay){e.stopPropagation();remitForm(d.remitPay);return true}
  if(d.remit){remitDetail(d.remit);return true}
  return false;
}
function bindPayroll(m){bindYearEnd(m)}

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
      ${fld('eAddr','Address',`<textarea id="eAddr">${esc(e.address||'')}</textarea>`,true)}</div>
    <h3 class="fsec">Pay</h3>
    <div class="fields">${fld('eFreq','Pay schedule',`<select id="eFreq">${Object.keys(PR.FREQUENCIES).map(k=>`<option value="${k}" ${e.freq===k?'selected':''}>${PR.FREQ_LABEL[k]}</option>`).join('')}</select>`)}
      ${fld('eType','Paid by',`<select id="eType"><option value="salary" ${e.payType==='salary'?'selected':''}>Salary</option><option value="hourly" ${e.payType==='hourly'?'selected':''}>The hour</option></select>`)}
      ${num('eRate',e.payType==='hourly'?'Hourly rate':'Annual salary',e.rate)}
      ${num('eHours','Usual hours per pay',e.hours,'Filled in on each pay run')}</div>
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
    const vm=$('#eVacMode',f).value;$$('[data-vac]',f).forEach(x=>x.style.display=vm==='salary'?'none':'contents');$$('[data-vacacc]',f).forEach(x=>x.style.display=vm==='accrue'?'contents':'none');
    const r=PR.vacationRate(p,$('#eHire',f).value,today());$('#eVacRate',f).placeholder=r.rate;
    const hire=$('#eHire',f).value;
    $('[data-vachint]',f).innerHTML=!r.known?'<span>Blank = 4%. Check when your province’s minimum goes up with years of service.</span>':r.next&&hire?`<span>Blank = the minimum: ${r.rate}% now, ${r.next[1]}% after ${r.next[0]} years of service.</span>`:`<span>Blank = the minimum, ${r.rate}% now.</span>${hire||!r.next?'':' <span>Enter the hire date so it goes up with years of service.</span>'}`;
    const h=$('#eType',f).value==='hourly';$('label[for=eRate]',f).textContent=h?'Hourly rate':'Annual salary'};
  $('#eProv',f).onchange=$('#eType',f).onchange=$('#ePen',f).onchange=$('#eVacMode',f).onchange=$('#eHire',f).onchange=sync;sync();
  if(!emp)$('#eType',f).addEventListener('change',()=>{$('#eVacMode',f).value=$('#eType',f).value==='hourly'?'accrue':'salary';sync()});
  const rb=$('[data-roe]',f);if(rb)rb.onclick=()=>roeForm(emp);
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this employee?',`${emp.name} will be removed.`))return;if(await del('employees',emp.id)){closeModal();toast('Employee deleted')}};
  f.onsubmit=async ev=>{ev.preventDefault();f.err('');
    const name=$('#eName',f).value.trim();if(!name)return f.err('Enter the employee’s name.');
    const val=id=>{const x=$('#'+id,f).value;return x===''?'':Math.max(0,+x)};
    if(!(+$('#eRate',f).value>0))return f.err($('#eType',f).value==='hourly'?'Enter the hourly rate.':'Enter the annual salary.');
    const prov=$('#eProv',f).value,qc=prov==='QC';
    const oy={year:+yr};['gross','pensionable','insurable','cpp','cpp2','qpp','qpp2','qpip','erQpip','ei','erEi','rrsp','union','fedTax','provTax','qcTax'].forEach(k=>{const raw=$('#eo_'+k,f).value,x=+raw||0;if(x||(raw!==''&&['pensionable','insurable','erEi'].includes(k)))oy[k]=r2(x)});
    if($('#eo_prov',f).value)oy.prov=$('#eo_prov',f).value;
    const data={...(emp?strip(emp):{created:Date.now()}),name,email:$('#eEmail',f).value.trim(),address:$('#eAddr',f).value.trim(),prov,hireDate:$('#eHire',f).value,
      freq:$('#eFreq',f).value,payType:$('#eType',f).value,rate:val('eRate'),hours:val('eHours'),
      td1Fed:val('eTd1'),td1Prov:qc?'':val('eTd1p'),td1Qc:qc?val('eTd1q'):'',extraTax:val('eExtra'),extraQcTax:qc?val('eExtraQ'):'',dependants:prov==='ON'?val('eDep'):'',
      rrsp:val('eRrsp'),union:val('eUnion'),sin:$('#eSin',f).value.replace(/\D/g,''),dental:+$('#eDental',f).value||0,rppNo:$('#ePen',f).value==='rpp'?$('#eRppNo',f).value.replace(/\D/g,''):'',pensionType:$('#ePen',f).value,cppExempt:$('#eCppX',f).checked,eiExempt:$('#eEiX',f).checked,qpipExempt:qc&&$('#eQpipX',f).checked,
      active:emp?!$('#eInactive',f).checked:true,openingYtd:oy,
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
        <div class="field"><label>Other pay</label><input type="number" step="0.01" min="0" data-other placeholder="Overtime" title="Overtime, commissions or other pay that earns vacation pay"></div>
        ${vacMode(e)!=='salary'?`<div class="field"><label>Vacation pay</label><input type="number" step="0.01" min="0" data-vac title="${vacMode(e)==='accrue'?'Paid now out of the vacation pay set aside':'Added to this pay'}"></div>`:''}
        <div class="prl-sum"><span class="muted">Deductions</span><b data-s="ded">0.00</b></div><div class="prl-sum"><span class="muted">Net pay</span><b data-s="net">0.00</b></div>
        <button type="button" class="btn ghost sm" data-more aria-expanded="false">Details</button></div>
      <div class="prl-more" hidden>
        <div class="fields" style="margin-bottom:10px"><div class="field"><label for="p_${e.id}_bonus">Bonus</label><input type="number" step="0.01" min="0" id="p_${e.id}_bonus" data-bonus><span class="hint">Taxed with CRA’s method for bonuses. Doesn’t earn vacation pay.</span></div>
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
    if(e.payType==='hourly'&&!q('[data-reg]').dataset.ov)q('[data-reg]').value=r2(val('[data-hours]')*(+e.rate||0))||'';
    // Statutory holidays in this pay period (hourly employees; a salary already covers them).
    const from=$('#rFrom',f).value,to=$('#rTo',f).value;
    const hols=e.payType==='hourly'&&from&&to&&from<=to?PR.holidaysBetween(e.prov,from,to):[];
    if(q('[data-holf]')){q('[data-holf]').hidden=!hols.length;q('[data-holhf]').hidden=!hols.length}
    const hn=q('[data-holnote]');hn.hidden=!hols.length;
    if(hols.length){
      const earn=[...holidayEarnings(e.id,e.prov),{from,to,amount:val('[data-reg]')}];
      const parts=hols.map(h=>({h,...PR.holidayPay(h.date,earn)}));
      const firstPay=earn.reduce((m,x)=>x.from<m?x.from:m,from);
      const short=parts.some(x=>x.window.from<firstPay);
      auto('[data-hol]',parts.reduce((t,x)=>t+x.pay,0));
      auto('[data-holhrs]',hols.length*(+e.hours||0)/(WORKDAYS[freq]||10));
      hn.innerHTML=parts.map(x=>`<div><b>${esc(x.h.name)}</b> · <span>${fmtDate(x.h.date)}: ${money(x.pay)}, which is 1/20 of ${money(x.base)} earned from ${fmtDate(x.window.from)} to ${fmtDate(x.window.to)}</span></div>`).join('')+
        (short?`<div class="neg">Sumlora has ${esc(e.name)}’s pay only from ${fmtDate(firstPay)}, so pay before that isn’t counted. Check the holiday pay against your earlier payroll.</div>`:'')+
        `<div>${['ON','QC'].includes(e.prov)?'':'<span>This is the Ontario and Quebec formula. Check your province’s rule.</span> '}<span>If ${esc(e.name)} worked on the holiday, add the premium pay under Other pay.</span>${e.prov==='ON'?' <span>Ontario counts vacation pay paid in those weeks too.</span>':''}</div>`;
    }else for(const k of ['[data-hol]','[data-holhrs]']){const el=q(k);if(el){delete el.dataset.ov;delete el.dataset.ovk;el.value=''}}
    // Vacation pay on regular, holiday and other pay.
    const vm=vacMode(e),vr=vacRateFor(e,date).rate,base=val('[data-reg]')+val('[data-hol]')+val('[data-other]');
    const fin=q('[data-final]').checked;
    if(vm==='each')auto('[data-vac]',base*vr/100);
    if(vm==='accrue'){
      auto('[data-vacacc]',base*vr/100);
      const owed=vacBalance(e.id,{payDate:date+'~'},false);
      auto('[data-vac]',fin?Math.max(0,owed+val('[data-vacacc]')):0);
      q('[data-vachint]').textContent=`${vr}% · owed before this pay: ${money(owed)}`;
    }
    const gross=r2(val('[data-reg]')+val('[data-hol]')+val('[data-other]')+val('[data-bonus]')+val('[data-allow]')+val('[data-vac]'));
    const ben={};box.querySelectorAll('[data-ben]').forEach(x=>{if(+x.value)ben[x.dataset.ben]=r2(+x.value)});
    const bl={benefits:ben},bt=benTotal(bl);
    const note=q('[data-note]');let res=null;
    try{res=calcFor(e,date,P(),gross,ytdFor(e.id,{payDate:date+'~'},false),{bonus:val('[data-bonus]'),benefits:bt,pensionable:r2(gross+bt),insurable:r2(gross+benInsurable(bl)),qpipInsurable:r2(gross+bt)});note.innerHTML=res.notes.map(n=>`<span>${esc(n)}</span>`).join(' ')}
    catch(err){note.innerHTML=`<span class="neg">${esc(err.message)}</span> Enter the deductions yourself.`}
    const set=(el,v)=>{if(!el.dataset.ov)el.value=v?v.toFixed(2):''};
    box.querySelectorAll('[data-ded]').forEach(el=>res&&set(el,res.employee[el.dataset.ded]));
    box.querySelectorAll('[data-er]').forEach(el=>res&&set(el,res.employer[el.dataset.er]));
    box.querySelectorAll('[data-x]').forEach(el=>set(el,+e[el.dataset.x]||0));
    const l=readLine(box);box.querySelector('[data-s=ded]').textContent=money(lineDed(l));const n=box.querySelector('[data-s=net]');n.textContent=money(l.net);n.className=l.net<0?'neg':'';
    box.classList.toggle('off',!box.querySelector('[data-inc]').checked);
  };
  const readLine=box=>{const e=employee(box.dataset.emp);const g=k=>r2(+box.querySelector(k)?.value||0);
    const ded={},er={};box.querySelectorAll('[data-ded]').forEach(x=>ded[x.dataset.ded]=r2(+x.value||0));box.querySelectorAll('[data-er]').forEach(x=>er[x.dataset.er]=r2(+x.value||0));
    DED_KEYS.forEach(k=>ded[k]=ded[k]||0);ER_KEYS.forEach(k=>er[k]=er[k]||0);
    const regular=g('[data-reg]'),holiday=g('[data-hol]'),other=g('[data-other]'),bonus=g('[data-bonus]'),allowance=g('[data-allow]'),vacPay=g('[data-vac]'),gross=r2(regular+holiday+other+bonus+allowance+vacPay);
    const benefits={};box.querySelectorAll('[data-ben]').forEach(x=>{const v=r2(+x.value||0);if(v)benefits[x.dataset.ben]=v});
    const vm=vacMode(e),from=$('#rFrom',f).value,to=$('#rTo',f).value;
    const l={employeeId:e.id,name:e.name,prov:e.prov,payType:e.payType,rate:+e.rate||0,hours:e.payType==='hourly'?g('[data-hours]'):(+e.hours||''),regular,other,gross,pensionable:r2(gross+benTotal({benefits})),insurable:r2(gross+benInsurable({benefits})),cppExempt:!!e.cppExempt,eiExempt:!!e.eiExempt,qpipExempt:e.prov==='QC'&&!!e.qpipExempt,
      rrsp:g('[data-x=rrsp]'),union:g('[data-x=union]'),ded,er,overridden:[...box.querySelectorAll('[data-ov]')].map(x=>x.dataset.ded||x.dataset.er||x.dataset.x||x.dataset.ovk||'').filter(Boolean)};
    if(holiday){l.holiday=holiday;l.holHours=g('[data-holhrs]');l.holidays=(e.payType==='hourly'&&from&&to?PR.holidaysBetween(e.prov,from,to):[]).map(h=>({date:h.date,name:h.name}))}
    if(bonus)l.bonus=bonus;
    if(allowance)l.allowance=allowance;
    if(Object.keys(benefits).length)l.benefits=benefits;
    if(vm!=='salary'){l.vacMode=vm;l.vacRate=vacRateFor(e,$('#rDate',f).value).rate;l.vacPay=vacPay;if(vm==='accrue')l.vacAccrued=g('[data-vacacc]')}
    if(box.querySelector('[data-final]').checked)l.final=true;
    l.net=r2(gross-lineDed(l));return l};
  const recalcAll=()=>{$$('.prl',f).forEach(recalc);totals()};
  const included=()=>$$('.prl',f).filter(b=>b.querySelector('[data-inc]').checked);
  const totals=()=>{const r={lines:included().map(readLine)};const t=runTotals(r);
    $('[data-rtot]',f).innerHTML=`<div>Gross pay</div><div>${money(t.gross)}</div><div>Employee deductions</div><div>${money(t.ded)}</div><div>Employer contributions</div><div>${money(t.er)}</div><div>To CRA</div><div>${money(t.cra)}</div>${t.rq?`<div>To Revenu Québec</div><div>${money(t.rq)}</div>`:''}${t.vacAcc||t.vacOut?`<div>Vacation pay set aside</div><div>${money(r2(t.vacAcc-t.vacOut))}</div>`:''}<div class="big">Net pay from bank</div><div class="big">${money(t.net)}</div>`;
    const tb=PR.tableFor($('#rDate',f).value);$('[data-rates]',f).textContent=tb?`Rates: ${tb.label} (CRA T4127, 123rd edition).`:'';};
  const emps=$('[data-emps]',f);
  emps.addEventListener('input',ev=>{const box=ev.target.closest('.prl');if(!box)return;const el=ev.target;
    if(el.matches('[data-ded],[data-er],[data-x]')||(el.matches('[data-reg]')&&employee(box.dataset.emp).payType==='hourly'))el.dataset.ov='1';
    if(el.matches('[data-hol],[data-vac],[data-vacacc],[data-holhrs]')){el.dataset.ov='1';el.dataset.ovk=[...Object.keys(el.dataset)].find(k=>['hol','vac','vacacc','holhrs'].includes(k))}
    if(el.matches('[data-ded],[data-er],[data-x]')){const l=readLine(box);box.querySelector('[data-s=ded]').textContent=money(lineDed(l));box.querySelector('[data-s=net]').textContent=money(l.net)}
    else recalc(box);totals()});
  emps.addEventListener('change',ev=>{if(ev.target.matches('[data-inc],[data-final]')){const b=ev.target.closest('.prl');if(ev.target.matches('[data-final]')){const v=b.querySelector('[data-vac]');if(v)delete v.dataset.ov}recalc(b);totals()}});
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
    const bad=lines.find(l=>l.net<0);if(bad)return f.err(`${bad.name}: deductions are more than gross pay.`);
    const over=lines.find(l=>l.vacMode==='accrue'&&l.vacPay>r2(vacBalance(l.employeeId,{payDate:payDate+'~'},false)+(l.vacAccrued||0))+0.004);
    if(over&&!await confirmBox('Pay more vacation pay than is owed?',`${over.name} is owed ${money(r2(vacBalance(over.employeeId,{payDate:payDate+'~'},false)+(over.vacAccrued||0)))} of vacation pay, and this pays ${money(over.vacPay)}. Pay it anyway?`,'Pay anyway'))return;
    const dup=lines.find(l=>S.payruns.some(r=>r.payDate===payDate&&r.lines.some(x=>x.employeeId===l.employeeId)));
    if(dup&&!await confirmBox('Pay this employee twice?',`${dup.name} already has a pay run dated ${fmtDate(payDate)}. Post another one anyway?`,'Post anyway'))return;
    const id=uid(),run={payDate,from:$('#rFrom',f).value,to:$('#rTo',f).value,freq,bank,lines,created:Date.now(),entryId:'pr_'+id};
    const t=runTotals(run);
    const{writes,ids}=payAccounts(t.rq>0,!!(t.vacAcc||t.vacOut));
    const L=[{account:ids.wages,debit:r2(t.gross-t.vacOut+t.vacAcc),credit:0,memo:t.vacAcc||t.vacOut?'Gross pay, with vacation pay as it’s earned':'Gross pay'}];
    if(t.vacAcc)L.push({account:ids.vacation_payable,debit:0,credit:t.vacAcc,memo:'Vacation pay set aside'});
    if(t.vacOut)L.push({account:ids.vacation_payable,debit:t.vacOut,credit:0,memo:'Vacation pay paid out'});
    if(t.er)L.push({account:ids.payroll_tax,debit:t.er,credit:0,memo:'Employer contributions'});
    if(t.cra)L.push({account:ids.payroll_cra,debit:0,credit:t.cra,memo:'Source deductions – CRA'});
    if(t.rq)L.push({account:ids.payroll_rq,debit:0,credit:t.rq,memo:'Source deductions – Revenu Québec'});
    if(t.other)L.push({account:ids.payroll_other,debit:0,credit:t.other,memo:'RRSP and union dues withheld'});
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
    <div class="muted">${run.from?`Pay period ${fmtDate(run.from)} – ${fmtDate(run.to)} · `:''}${PR.FREQ_LABEL[run.freq]||''} · paid from ${esc(acctName(run.bank))}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Employee</th><th class="n">Gross</th><th class="n">${qc?'CPP/QPP':'CPP'}</th><th class="n">EI${qc?'/QPIP':''}</th><th class="n">Income tax</th><th class="n">Other</th><th class="n">Net pay</th><th></th></tr></thead><tbody>
    ${run.lines.map((l,i)=>`<tr><td>${esc(l.name)}${l.overridden&&l.overridden.length?' <span class="pill quiet" title="Amounts changed by hand">Edited</span>':''}</td><td class="n">${money(l.gross)}</td><td class="n">${money(l.ded.cpp+l.ded.cpp2+l.ded.qpp+l.ded.qpp2)}</td><td class="n">${money(l.ded.ei+l.ded.qpip)}</td><td class="n">${money(l.ded.fedTax+l.ded.provTax+l.ded.qcTax)}</td><td class="n">${money((+l.rrsp||0)+(+l.union||0))}</td><td class="n"><b>${money(l.net)}</b></td><td class="n"><button type="button" class="btn sm" data-stub="${i}">Pay stub</button></td></tr>`).join('')}
    </tbody><tfoot><tr><td><b>Total</b></td><td class="n">${money(t.gross)}</td><td colspan="4"></td><td class="n"><b>${money(t.net)}</b></td><td></td></tr></tfoot></table></div>
    <div class="totals" style="min-width:280px"><div>Employer contributions</div><div>${money(t.er)}</div><div>Owed to CRA</div><div>${money(t.cra)}</div>${t.rq?`<div>Owed to Revenu Québec</div><div>${money(t.rq)}</div>`:''}${t.vacAcc||t.vacOut?`<div>Vacation pay set aside</div><div>${money(r2(t.vacAcc-t.vacOut))}</div>`:''}<div class="big">Total cost</div><div class="big">${money(t.cost)}</div></div>`,
    `<button type="button" class="btn danger left" data-del>Delete pay run</button><button type="button" class="btn" data-stub="all">Print all pay stubs</button><button type="button" class="btn primary" data-close>Done</button>`,'wide');
  f.addEventListener('click',ev=>{const b=ev.target.closest('[data-stub]');if(b)printStubs(run,b.dataset.stub==='all'?run.lines:[run.lines[+b.dataset.stub]])});
  $('[data-del]',f).onclick=async()=>{
    const e=S.entries.find(x=>x.id===run.entryId);const rec=e&&Object.values(e.clear||{}).includes('r');
    const paidRemit=remittances().some(x=>x.key===remitPeriod(run.payDate).key&&x.paid>0);
    if(!await confirmBox('Delete this pay run?',`The pay run and its journal entry will be removed. Year-to-date amounts on later pay stubs will change.${rec?' Its bank payment is already reconciled.':''}${paidRemit?' You have already recorded a remittance for this period.':''}`))return;
    const w=[{op:'delete',collection:'payruns',id:run.id}];if(e)w.push({op:'delete',collection:'entries',id:e.id});
    if(await batch(w)){closeModal();toast('Pay run deleted')}};
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
      ${l.payType==='hourly'&&l.hours?row(`Regular, ${l.hours} h × ${money(l.rate)}`,l.regular,null):row('Regular pay',l.regular??l.gross,null)}
      ${l.holiday?row(`Holiday pay${(l.holidays||[]).length?` (${l.holidays.map(h=>(typeof tr==='function'&&tr(h.name))||h.name).join(', ')})`:''}`,l.holiday,y.hol||0):''}
      ${l.other?row('Other pay',l.other,null):''}${l.bonus?row('Bonus',l.bonus,null):''}${l.allowance?row('Taxable allowance',l.allowance,null):''}
      ${l.vacPay||y.vac?row(l.vacMode==='accrue'?'Vacation pay paid out':`Vacation pay (${l.vacRate}%)`,l.vacPay||0,y.vac||0):''}</tbody>
      <tfoot><tr><td><b>Gross pay</b></td><td class="n"><b>${money(l.gross)}</b></td><td class="n"><b>${money(y.gross)}</b></td></tr></tfoot></table>
    ${l.benefits||y.benefits?`<table><thead><tr><th>Taxable benefits (not paid to you)</th><th class="n">This pay</th><th class="n">Year to date</th></tr></thead><tbody>${PR.BENEFIT_KINDS.filter(b=>(l.benefits||{})[b.k]).map(b=>row(b.label,l.benefits[b.k],null)).join('')}</tbody>
      <tfoot><tr><td><b>Total taxable benefits</b></td><td class="n"><b>${money(benTotal(l))}</b></td><td class="n"><b>${money(y.benefits||0)}</b></td></tr></tfoot></table><div class="muted" style="font-size:12px;margin:-4px 0 8px">${(l.prov||e.prov)==='QC'?'Included in your taxable income and on your T4 and RL-1. Tax on them is taken from your pay.':'Included in your taxable income and on your T4. Tax on them is taken from your pay.'}</div>`:''}
    <table><thead><tr><th>Deductions</th><th class="n">This pay</th><th class="n">Year to date</th></tr></thead><tbody>${ded||'<tr><td colspan="3" class="muted">None</td></tr>'}</tbody>
      <tfoot><tr><td><b>Total deductions</b></td><td class="n"><b>${money(lineDed(l))}</b></td><td class="n"><b>${money(r2(y.gross-y.net))}</b></td></tr></tfoot></table>
    <div class="stub-net"><span>Net pay</span><b>${money(l.net)}</b></div>
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
    `<button type="button" class="btn" data-close>Close</button>${x.bal>0.004?`<button type="button" class="btn primary" data-go-pay>Record payment</button>`:''}`);
  f.addEventListener('click',ev=>{const r=ev.target.closest('[data-rp]');if(r)remitForm(key,S.entries.find(e=>e.id===r.dataset.rp));if(ev.target.closest('[data-go-pay]'))remitForm(key)});
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

/* ---------- settings panel ---------- */
function payrollSettingsPanel(){
  const c=payCfg();
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Payroll</h3><form class="pad" id="paySetForm" style="display:flex;flex-direction:column;gap:14px">
    <div class="fields">${fld('psFreq','Remitting source deductions',`<select id="psFreq"><option value="monthly" ${c.remitFreq==='monthly'?'selected':''}>Monthly (regular remitter)</option><option value="quarterly" ${c.remitFreq==='quarterly'?'selected':''}>Quarterly</option></select><span class="hint">CRA tells you which in your remitter letter</span>`)}
    ${fld('psHsf','Quebec Health Services Fund rate (%)',`<input type="number" id="psHsf" min="0" max="10" step="0.01" value="${esc(c.hsfRate)}"><span class="hint">Only for employees in Quebec. 1.65% for most small employers.</span>`)}
    ${fld('psCra','CRA payroll account number',`<input type="text" id="psCra" maxlength="15" placeholder="123456789RP0001" value="${esc(c.craAccount||'')}" translate="no"><span class="hint">Your business number + RP + 4 digits. T4 box 54.</span>`)}
    ${fld('psRq','Revenu Québec identification number',`<input type="text" id="psRq" maxlength="16" placeholder="1234567890RS0001" value="${esc(c.rqId||'')}" translate="no"><span class="hint">For RL-1 slips and the RL-1 Summary, if you have employees in Quebec.</span>`)}</div>
    <div class="fields">${fld('psAssoc','Payroll of associated employers',`<input type="number" id="psAssoc" step="0.01" min="0" value="${c.assocPayroll||''}"><span class="hint">Only if this business is associated with others. Revenu Québec sets the Health Services Fund rate from everyone’s total payroll.</span>`)}</div>
    <label class="check"><input type="checkbox" id="psPrim" ${c.hsfPrimary?'checked':''}> Primary or manufacturing business (lower Health Services Fund rate)</label>
    <div><button class="btn" type="submit">Save payroll settings</button></div></form></div>`;
}
function bindPayrollSettings(m){const f=$('#paySetForm',m);if(!f)return;f.onsubmit=async e=>{e.preventDefault();if(await putCompany({...strip(S.company),payroll:{...payCfg(),remitFreq:$('#psFreq',f).value,hsfRate:+$('#psHsf',f).value||0,craAccount:$('#psCra',f).value.trim(),rqId:$('#psRq',f).value.trim(),hsfPrimary:$('#psPrim',f).checked,assocPayroll:+$('#psAssoc',f).value||0}}))toast('Payroll settings saved')}}
