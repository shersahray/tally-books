'use strict';
/* ---------- Payroll year-end: T4 and RL-1 slips and summaries ----------
   The figures come from TallyPayroll.yearEnd() (payroll-calc.js), built from the year's pay runs,
   amounts entered for earlier payroll, and remittance payments.
   Tally Books prepares the figures; slips are filed with CRA's T4 Web Forms (which also prints
   the employees' copies) and Revenu Québec's online service. Revenu Québec accepts printed RL-1
   slips only from software it has certified, so these printouts are worksheets, not slips. */
S.ye={year:null};
const T4_BOXES=[[10,'Province of employment'],[12,'Social insurance number'],[14,'Employment income'],[16,'Employee’s CPP contributions'],['16A','Employee’s second CPP contributions'],
  [17,'Employee’s QPP contributions'],['17A','Employee’s second QPP contributions'],[18,'Employee’s EI premiums'],[20,'RPP contributions'],[22,'Income tax deducted'],
  [24,'EI insurable earnings'],[26,'CPP/QPP pensionable earnings'],[28,'Exempt'],[44,'Union dues'],[45,'Employer-offered dental benefits'],[55,'Employee’s PPIP premiums'],[56,'PPIP insurable earnings']];
const RL1_BOXES=[['A','Employment income'],['B.A','QPP contributions (base and first additional)'],['B.B','QPP contributions (second additional)'],['C','EI premiums'],['D','RPP contributions'],
  ['E','Quebec income tax withheld'],['F','Union dues'],['G','Pensionable salary under the QPP'],['H','QPIP premiums'],['I','Salary insurable under the QPIP']];
const DENTAL={1:'Not eligible',2:'Employee only',3:'Employee, spouse and dependent children',4:'Employee and spouse',5:'Employee and dependent children'};

function yeYears(){
  const ys=new Set(S.payruns.map(r=>+r.payDate.slice(0,4)));
  S.employees.forEach(e=>{if(e.openingYtd&&+e.openingYtd.year&&+e.openingYtd.gross)ys.add(+e.openingYtd.year)});
  return [...ys].filter(y=>PR.YEAR_LIMITS[y]).sort((a,b)=>b-a);
}
function yeData(){
  const years=yeYears();if(!years.length)return null;
  if(!years.includes(S.ye.year))S.ye.year=years.includes(+today().slice(0,4))?+today().slice(0,4):years[0];
  const remittances=S.entries.filter(e=>e.type==='payremit').map(e=>({agency:e.agency,period:e.period,amount:+e.amount||0}));
  return PR.yearEnd({year:S.ye.year,employees:S.employees,payruns:S.payruns,remittances,hsfPrimary:!!payCfg().hsfPrimary});
}
const sinMasked=s=>s?'•••-•••-'+String(s).slice(-3):'';
const sinFull=s=>s?String(s).replace(/(\d{3})(\d{3})(\d{3})/,'$1 $2 $3'):'';
function boxVal(k,v,slip){
  if(k===10)return esc(v);
  if(k===12)return v?`<span translate="no">${sinFull(v)}</span>`:'<span class="neg">Missing</span>';
  if(k===28){const x=[v.cppQpp?(slip.prov==='QC'?'QPP':'CPP'):'',v.ei?'EI':'',v.ppip?'PPIP':''].filter(Boolean);return x.length?esc(x.join(', ')):''}
  if(k===45)return `${v} · ${esc(DENTAL[v]||'')}`;
  if(k===24||k===26||(k===56&&slip.prov==='QC'))return money(v,{sym:false}); // these show 0 rather than blank
  return v?money(v,{sym:false}):'';
}
function checkText(c){
  const m=v=>money(v);
  switch(c.code){
    case 'sin-missing':return 'SIN missing. Add it on the employee (box 12).';
    case 'sin-invalid':return 'This SIN isn’t valid. Check it on the employee.';
    case 'ei':return `EI deducted is ${m(c.got)}, but ${m(c.want)} was expected on these insurable earnings. CRA may assess the difference.`;
    case 'cpp':return `CPP/QPP deducted is ${m(c.got)}; a full-year employee would have ${m(c.want)}. That’s normal if they started, left or turned 18 or 70 during the year.`;
    case 'cpp2':return `CPP2/QPP2 deducted is ${m(c.got)}, but ${m(c.want)} was expected.`;
    case 'qpip':return `QPIP deducted is ${m(c.got)}, but ${m(c.want)} was expected.`;
    default:return c.code;
  }
}

function vYearEnd(){
  let Y;
  try{Y=yeData()}catch(e){return `<div class="panel"><div class="empty"><b>${esc(e.message)}</b></div></div>`}
  if(!Y)return `<div class="panel"><div class="empty"><b>No payroll yet</b>T4 and RL-1 figures appear here once you’ve run payroll.</div></div>`;
  const c=payCfg(),years=yeYears(),qc=!!Y.rl1sum;
  const errs=Y.slips.filter(s=>s.checks.some(x=>x.level==='error')).length,warns=Y.slips.filter(s=>s.checks.some(x=>x.level==='warn')).length;
  const setup=[];
  if(!/^\d{9}RP\d{4}$/.test(c.craAccount||''))setup.push('Add your CRA payroll account number (123456789RP0001) in Settings → Payroll.');
  if(qc&&!(c.rqId||'').trim())setup.push('Add your Revenu Québec identification number in Settings → Payroll.');
  if(errs)setup.push(`${errs} slip${errs===1?' needs':'s need'} attention (see the list below).`);
  const sum=Y.t4sum,R=Y.rl1sum;
  const row=(l,v,b)=>`<tr><td>${b?`<span class="mono muted" translate="no">${b}</span> `:''}${esc(l)}</td><td class="n">${v}</td></tr>`;
  return `<div class="toolbar" style="margin-bottom:12px"><label class="flabel" for="yeYear">Tax year</label><select id="yeYear">${years.map(y=>`<option value="${y}" ${y===Y.year?'selected':''}>${y}</option>`).join('')}</select>
    <span class="grow muted">Slips and summaries are due ${fmtDate(Y.due)}. Employees must have their copies by then too.</span>
    <button class="btn" data-yecsv>Export CSV</button><button class="btn" data-yeprint="all">Print worksheets</button></div>
  ${setup.length?`<div class="banner err"><span><b>Before you file:</b> ${setup.map(esc).join(' ')}</span><button class="btn sm" data-go="settings">Settings</button></div>`:`<div class="banner"><span><b>Ready to file.</b> ${warns?`${warns} slip${warns===1?' has':'s have'} a check worth a look before you file.`:'Every slip passed the checks.'}</span></div>`}
  <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Employee</th><th>Province</th><th class="n">Employment income (14)</th><th class="n">CPP/QPP (16/17)</th><th class="n">CPP2/QPP2</th><th class="n">EI (18)</th><th class="n">Income tax (22)</th><th>RL-1</th><th>Checks</th></tr></thead><tbody>
  ${Y.slips.map((s,i)=>{const lv=s.checks.some(x=>x.level==='error')?'overdue':s.checks.some(x=>x.level==='warn')?'partial':s.checks.length?'quiet':'paid';
    return `<tr class="click" data-yeslip="${i}"><td><span translate="no">${esc(s.name)}</span></td><td>${esc(s.prov)}</td><td class="n">${money(s.t4[14])}</td><td class="n">${money(s.t4[16]||s.t4[17])}</td><td class="n">${money(s.t4['16A']||s.t4['17A'])}</td><td class="n">${money(s.t4[18])}</td><td class="n">${money(s.t4[22])}</td><td>${s.rl1?'Yes':''}</td><td><span class="pill ${lv}">${lv==='paid'?'OK':lv==='overdue'?'Fix':'Check'}</span></td></tr>`}).join('')}
  </tbody></table></div></div>
  <div class="grid2" style="margin-top:16px">
    <div class="panel"><h3>T4 Summary</h3><div class="tbl-wrap"><table><tbody>
      ${row('Number of T4 slips',sum[88],88)}${row('Employment income',money(sum[14]),14)}${row('Employees’ CPP contributions',money(sum[16]),16)}${row('Employees’ second CPP contributions',money(sum['16A']),'16A')}
      ${sum[17]?row('Employees’ QPP contributions (for your records, not on the summary)',money(sum[17]),'17'):''}
      ${row('Employees’ EI premiums',money(sum[18]),18)}${row('RPP contributions',money(sum[20]),20)}${row('Income tax deducted',money(sum[22]),22)}${row('Employer’s CPP contributions',money(sum[27]),27)}
      ${row('Employer’s second CPP contributions',money(sum['27A']),'27A')}${row('Employer’s EI premiums',money(sum[19]),19)}
      <tr class="tot"><td><span class="mono muted" translate="no">80</span> Total deductions reported</td><td class="n">${money(sum[80])}</td></tr>
      ${row('Minus: remittances',money(sum[82]),82)}
      ${sum[86]?`<tr class="tot"><td><span class="mono muted" translate="no">86</span> Balance due</td><td class="n neg">${money(sum[86])}</td></tr>`:sum[84]?`<tr class="tot"><td><span class="mono muted" translate="no">84</span> Overpayment</td><td class="n">${money(sum[84])}</td></tr>`:'<tr class="tot"><td>Difference</td><td class="n">0.00</td></tr>'}
    </tbody></table></div>
    <div class="pad muted" style="font-size:13px">Remittances count payments recorded under Remittances for ${Y.year}. A balance due usually means a remittance wasn’t recorded or December’s isn’t paid yet.</div></div>
    ${R?`<div class="panel"><h3>RL-1 Summary (Revenu Québec)</h3><div class="tbl-wrap"><table><tbody>
      ${row('Number of RL-1 slips',R.slips)}${row('QPP: employees',money(R.qppEmployee))}${row('QPP: employer',money(R.qppEmployer))}${row('QPP2: employees',money(R.qpp2Employee))}${row('QPP2: employer',money(R.qpp2Employer))}
      ${row('QPIP: employees',money(R.qpipEmployee))}${row('QPIP: employer',money(R.qpipEmployer))}${row('Quebec income tax withheld',money(R.qcTax))}
      ${row('Total Quebec payroll',money(R.payroll))}${row(`Health Services Fund at ${R.hsfRate}%`,money(R.hsf))}
      <tr class="tot"><td>Total</td><td class="n">${money(R.total)}</td></tr>${row('Minus: remittances',money(R.remitted))}
      <tr class="tot"><td>${R.balance>=0?'Balance due':'Overpayment'}</td><td class="n ${R.balance>0.004?'neg':''}">${money(Math.abs(R.balance))}</td></tr>
      ${row('Labour standards contribution (0.06%, paid with the summary)',money(R.cnt))}
    </tbody></table></div>
    <div class="pad muted" style="font-size:13px">The Health Services Fund rate is recalculated from the year’s total Quebec payroll. ${R.wsdrf?'<b>Payroll is over $2 million:</b> the 1% workforce training contribution (WSDRF) may apply. ':''}CNESST workplace health and safety premiums are separate.</div></div>`:''}
  </div>
  <div class="panel" style="margin-top:16px"><h3>How to file</h3><div class="pad"><ol class="steps">
    <li><b>T4 slips:</b> sign in to CRA My Business Account (or use a web access code) and open <b>T4 Web Forms</b>. Enter each slip from these figures, then the T4 Summary. Web Forms also prints the copies for your employees. More than 5 slips must be filed electronically.</li>
    ${R?`<li><b>RL-1 slips:</b> in Revenu Québec’s <b>My Account for businesses</b> (Mon dossier pour les entreprises), use the online service for RL-1 slips and the RL-1 Summary. Revenu Québec accepts printed RL-1s only from certified software, so don’t hand out these worksheets as slips.</li>`:''}
    <li>Give each employee their copies by ${fmtDate(Y.due)}: on paper, or electronically if they agreed in writing.</li>
    <li>Pay any balance due by the same date.</li></ol></div></div>`;
}

function yeSlipModal(i){
  const Y=yeData(),s=Y.slips[i];if(!s)return;
  const f=openModal(`T4${s.rl1?' and RL-1':''} · ${s.name} · ${Y.year}`,`
    ${s.checks.length?`<div class="banner ${s.checks.some(c=>c.level==='error')?'err':''}" style="margin:0"><span>${s.checks.map(c=>esc(checkText(c))).join('<br>')}</span></div>`:''}
    <div class="grid2" style="gap:16px">
      <div><div class="flabel" style="margin-bottom:6px">T4 · ${esc(s.prov)}</div><div class="tbl-wrap"><table class="boxes"><tbody>${T4_BOXES.filter(([k])=>s.prov==='QC'||!['17','17A','55','56'].includes(String(k))).filter(([k])=>s.prov!=='QC'||!['16','16A'].includes(String(k))).map(([k,l])=>`<tr><td class="mono" translate="no">${k}</td><td>${esc(l)}</td><td class="n">${boxVal(k,s.t4[k],s)}</td></tr>`).join('')}</tbody></table></div></div>
      ${s.rl1?`<div><div class="flabel" style="margin-bottom:6px">RL-1</div><div class="tbl-wrap"><table class="boxes"><tbody>${RL1_BOXES.map(([k,l])=>`<tr><td class="mono" translate="no">${k}</td><td>${esc(l)}</td><td class="n">${k==='G'||k==='I'?money(s.rl1[k],{sym:false}):s.rl1[k]?money(s.rl1[k],{sym:false}):''}</td></tr>`).join('')}</tbody></table></div></div>`:''}
    </div>
    <div class="muted" style="font-size:12.5px">Boxes with nothing in them stay blank on the slip, except 24, 26${s.prov==='QC'?' and 56':''}, which show 0.00 when there are no earnings. Box 54 (your payroll account number) goes on your copy and CRA’s, not the employee’s.</div>`,
    `<button type="button" class="btn left" data-yeemp>Edit employee</button><button type="button" class="btn" data-yeprint1>Print worksheet</button><button type="button" class="btn primary" data-close>Done</button>`,'wide');
  $('[data-yeemp]',f).onclick=()=>{closeModal();employeeForm(employee(s.employeeId))};
  $('[data-yeprint1]',f).onclick=()=>yePrint([s],Y);
}
function yeWorksheet(s,Y){
  const c=payCfg();
  const t4=T4_BOXES.filter(([k])=>s.prov==='QC'||!['17','17A','55','56'].includes(String(k))).filter(([k])=>s.prov!=='QC'||!['16','16A'].includes(String(k)));
  return `<section class="stub"><header><div><b>${esc(S.company.name)}</b><div class="muted">${c.craAccount?`T4 box 54: <span translate="no">${esc(c.craAccount)}</span>`:''}${s.rl1&&c.rqId?` · RQ: <span translate="no">${esc(c.rqId)}</span>`:''}</div></div>
    <div style="text-align:right"><b>Year-end worksheet ${Y.year}</b><div class="muted">For filing: not an official slip</div></div></header>
    <div class="stub-emp"><b translate="no">${esc(s.name)}</b>${s.address?`<div class="muted" style="white-space:pre-line" translate="no">${esc(s.address)}</div>`:''}</div>
    <table><thead><tr><th style="width:12%">T4</th><th>Box</th><th class="n">Amount</th></tr></thead><tbody>${t4.map(([k,l])=>`<tr><td translate="no">${k}</td><td>${esc(l)}</td><td class="n">${boxVal(k,s.t4[k],s)}</td></tr>`).join('')}</tbody></table>
    ${s.rl1?`<table><thead><tr><th style="width:12%">RL-1</th><th>Box</th><th class="n">Amount</th></tr></thead><tbody>${RL1_BOXES.map(([k,l])=>`<tr><td translate="no">${k}</td><td>${esc(l)}</td><td class="n">${k==='G'||k==='I'?money(s.rl1[k],{sym:false}):s.rl1[k]?money(s.rl1[k],{sym:false}):''}</td></tr>`).join('')}</tbody></table>`:''}
  </section>`;
}
function yePrint(slips,Y){
  let root=$('#printRoot');if(!root){root=document.createElement('div');root.id='printRoot';document.body.appendChild(root)}
  root.innerHTML=slips.map(s=>yeWorksheet(s,Y)).join('');
  document.body.classList.add('printing');
  const done=()=>{document.body.classList.remove('printing');root.innerHTML='';window.removeEventListener('afterprint',done)};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{window.print();setTimeout(()=>{if(document.body.classList.contains('printing'))done()},1500)},50);
}
function yeCSV(){
  const Y=yeData();if(!Y)return;
  const head=['Employee','SIN','Province (10)','Box 14','Box 16','Box 16A','Box 17','Box 17A','Box 18','Box 20','Box 22','Box 24','Box 26','Box 28 exempt','Box 44','Box 45','Box 55','Box 56','RL-1 A','RL-1 B.A','RL-1 B.B','RL-1 C','RL-1 D','RL-1 E','RL-1 F','RL-1 G','RL-1 H','RL-1 I'];
  const rows=Y.slips.map(s=>{const t=s.t4,r=s.rl1||{};const ex=[t[28].cppQpp?'CPP/QPP':'',t[28].ei?'EI':'',t[28].ppip?'PPIP':''].filter(Boolean).join(' ');
    return [s.name,t[12],t[10],t[14],t[16],t['16A'],t[17],t['17A'],t[18],t[20],t[22],t[24],t[26],ex,t[44],t[45],t[55],t[56],r.A??'',r['B.A']??'',r['B.B']??'',r.C??'',r.D??'',r.E??'',r.F??'',r.G??'',r.H??'',r.I??'']});
  const headFr=['Employé','NAS','Province (10)','Case 14','Case 16','Case 16A','Case 17','Case 17A','Case 18','Case 20','Case 22','Case 24','Case 26','Case 28 exemption','Case 44','Case 45','Case 55','Case 56','RL-1 A','RL-1 B.A','RL-1 B.B','RL-1 C','RL-1 D','RL-1 E','RL-1 F','RL-1 G','RL-1 H','RL-1 I'];
  const text=[isFr()?headFr:head,...rows].map(row=>row.map(v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');
  saveFile(`t4-rl1_${Y.year}.csv`,new Blob(['﻿'+text],{type:'text/csv;charset=utf-8'}));
}
async function yeClick(e,t,d){
  if(d.yeslip!==undefined){yeSlipModal(+d.yeslip);return true}
  if(d.yeprint!==undefined){const Y=yeData();if(Y)yePrint(Y.slips,Y);return true}
  if(t.hasAttribute&&t.hasAttribute('data-yecsv')){yeCSV();return true}
  return false;
}
function bindYearEnd(m){const y=$('#yeYear',m);if(y)y.onchange=()=>{S.ye.year=+y.value;renderMain()}}
