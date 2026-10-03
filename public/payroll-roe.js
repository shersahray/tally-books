'use strict';
/* ---------- Record of Employment (ROE) ----------
   When an employee leaves, or stops working for 7 days in a row, Service Canada needs a record of employment
   within 5 days of the end of that pay period. Sumlora works out the blocks from the pay runs; you enter
   them in ROE Web, then keep the serial number here. The maths is PR.roe in payroll-calc.js. */

/** This employee's pays, for the ROE: one per pay run. */
function roeLines(e){
  const out=[];
  for(const r of S.payruns.slice().sort(runOrder))for(const l of r.lines){
    if(l.employeeId!==e.id)continue;
    const[from,to]=runPeriod(r);
    const hours=l.payType==='hourly'?(+l.hours||0)+(+l.holHours||0):(+l.hours||+e.hours||0);
    const ex=!!l.eiExempt; // no insurable earnings or hours when exempt from EI
    out.push({from,to,payDate:r.payDate,insurable:ex?0:(l.insurable??l.gross),hours:ex?0:hours,separationVac:!ex&&l.final&&l.vacMode==='accrue'?(+l.vacPay||0):0,final:!!l.final,eiExempt:ex});
  }
  return out;
}
const ROE_REASON=Object.fromEntries(PR.ROE_REASONS);
const ROE_TYPE_LABEL={W:'Weekly',B:'Every 2 weeks',S:'Twice a month',M:'Monthly'};

function roeForm(emp){
  if(!emp)return;
  const lines=roeLines(emp);
  if(!lines.length){toast(`${emp.name} hasn’t been paid in Sumlora yet.`,true);return}
  const last=lines[lines.length-1];
  const c=S.company,cfg=payCfg();
  const v=x=>x==null?'':esc(x);
  const f=openModal(`Record of employment · ${emp.name}`,`
    <div class="muted" style="font-size:13px">When ${esc(emp.name)} leaves, or stops working for 7 days in a row, Service Canada needs a record of employment (ROE) within 5 days of the end of that pay period. Sumlora works out the figures from the pay runs. Enter them in ROE Web on Service Canada’s site, then save the ROE’s serial number here.</div>
    <div class="fields">
      ${fld('roReason','Reason (block 16)',`<select id="roReason"><option value="">Choose…</option>${PR.ROE_REASONS.map(([k,l])=>`<option value="${k}">${k} · ${esc(l)}</option>`).join('')}</select>`,true)}
      ${fld('roFirst','First day worked (block 10)',`<input type="date" id="roFirst" value="${v(emp.hireDate||lines[0].from)}">`)}
      ${fld('roLast','Last day for which paid (block 11)',`<input type="date" id="roLast" value="${v(last.to)}">`)}
      ${fld('roEnd','Final pay period ending date (block 12)',`<input type="date" id="roEnd" value="${v(last.to)}">`)}
      ${fld('roOcc','Occupation (block 13)',`<input type="text" id="roOcc" maxlength="100" value="${v(emp.occupation)}">`)}
      ${fld('roRecall','Expected date of recall (block 14)',`<select id="roRecall"><option value="U">Unknown</option><option value="N">Not returning</option><option value="Y">Returning on a date</option></select><input type="date" id="roRecallDate" hidden style="margin-top:6px">`)}
      ${fld('roContact','Contact person (block 16)',`<input type="text" id="roContact" maxlength="100" value="${v(typeof ME!=='undefined'&&ME?ME.name:'')}">`)}
      ${fld('roPhone','Contact phone',`<input type="tel" id="roPhone" maxlength="30" value="${v(c.phone)}">`)}
    </div>
    <details><summary class="fsum">Statutory holiday pay after the last day, other money, comments</summary>
      <div class="fields" style="margin-top:8px">
        ${fld('roHolDate','Statutory holiday after the last day (block 17B)',`<input type="date" id="roHolDate">`)}
        ${fld('roHolAmt','Holiday pay for it',`<input type="number" id="roHolAmt" step="0.01" min="0" inputmode="decimal">`)}
        ${fld('roOther','Other money (block 17C)',`<input type="text" id="roOther" maxlength="100" placeholder="e.g. Pay in lieu of notice">`)}
        ${fld('roOtherAmt','Amount',`<input type="number" id="roOtherAmt" step="0.01" min="0" inputmode="decimal">`)}
        ${fld('roComments','Comments (block 18)',`<textarea id="roComments" maxlength="160"></textarea>`,true)}
      </div></details>
    <div data-roeout></div>
    ${fld('roSerial','ROE serial number, once submitted (optional)',`<input type="text" id="roSerial" maxlength="20" translate="no">`)}
    ${(emp.roes||[]).length?`<div><div class="flabel" style="margin-bottom:6px">Saved records of employment</div><div class="tbl-wrap"><table><tbody>${emp.roes.map((r,i)=>`<tr><td>${fmtDate(r.saved)}</td><td>${esc(r.reason)} · ${esc(ROE_REASON[r.reason]||'')}</td><td class="muted" translate="no">${esc(r.serial||'')}</td><td class="n"><button type="button" class="btn sm" data-roeprint="${i}">Print</button></td></tr>`).join('')}</tbody></table></div></div>`:''}`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" data-roeprint="now">Print</button><button type="submit" class="btn primary">Save ROE</button>`,'wide');
  const g=id=>$('#'+id,f).value.trim();
  const read=()=>{
    const end=g('roEnd'),calc=end?PR.roe({freq:emp.freq,finalPeriodEnd:end,lines}):null;
    return{reason:g('roReason'),firstDay:g('roFirst'),lastDay:g('roLast'),finalEnd:end,occupation:g('roOcc'),recall:g('roRecall'),recallDate:g('roRecall')==='Y'?g('roRecallDate'):'',
      contact:g('roContact'),phone:g('roPhone'),holDate:g('roHolDate'),holAmt:r2(+g('roHolAmt')||0),other:g('roOther'),otherAmt:r2(+g('roOtherAmt')||0),comments:g('roComments'),serial:g('roSerial'),
      calc:calc&&{type:calc.type,count:calc.count,hours:calc.hours,total:calc.totalEarnings,vacation:calc.vacation,due:calc.due,outside:calc.outside,periods:calc.periods.map(p=>({n:p.n,from:p.from,to:p.to,amount:p.amount}))}};
  };
  const render=()=>{$('#roRecallDate',f).hidden=g('roRecall')!=='Y';const r=read();$('[data-roeout]',f).innerHTML=r.calc?roeChecks(emp,r,lines)+roeBlocks(emp,r):''};
  f.addEventListener('input',render);f.addEventListener('change',render);render();
  f.addEventListener('click',ev=>{const b=ev.target.closest('[data-roeprint]');if(!b)return;const r=b.dataset.roeprint==='now'?read():emp.roes[+b.dataset.roeprint];if(!r.calc){toast('Enter the final pay period ending date.',true);return}
    printHTML(`<section class="stub roe-print"><header><div><b>${esc(c.name)}</b><div class="muted">Record of employment worksheet: enter these in ROE Web</div></div><div style="text-align:right"><b>${esc(emp.name)}</b><div class="muted">${fmtDate(r.saved||today())}</div></div></header>${roeBlocks(emp,r,true)}</section>`)});
  f.onsubmit=async ev=>{ev.preventDefault();f.err('');
    const r=read();
    if(!r.reason)return f.err('Choose the reason for issuing the ROE (block 16).');
    if(!r.firstDay||!r.lastDay||!r.finalEnd)return f.err('Enter the first day worked, the last day paid and the final pay period ending date.');
    if(r.lastDay<r.firstDay)return f.err('The last day paid is before the first day worked.');
    if(r.recall==='Y'&&!r.recallDate)return f.err('Enter the date they’re expected back.');
    const leaving=!['N','F','P','D','Z','J','H','B'].includes(r.reason)&&r.recall!=='Y';
    const data={...strip(emp),roes:[...(emp.roes||[]),{...r,saved:today()}]};
    if(leaving&&emp.active!==false&&await confirmBox(`Mark ${emp.name} as no longer working here?`,'They won’t appear in new pay runs. You can make them active again on their employee page.','Mark inactive')){data.active=false;data.termDate=r.lastDay}
    if(await put('employees',emp.id,data)){closeModal();toast('Record of employment saved')}
  };
}

function roeChecks(emp,r,lines){
  const w=[],cfg=payCfg();
  if(PR.sinProblem(emp.sin))w.push(`${esc(emp.name)}’s social insurance number is missing or not valid (block 8). Add it on their employee page.`);
  if(!/^\d{9}RP\d{4}$/.test(String(cfg.craAccount||'').replace(/\s/g,'')))w.push('Add your CRA payroll account number (block 5) in Settings → Payroll.');
  if(lines.length&&lines.every(l=>l.eiExempt))w.push(`${esc(emp.name)} is exempt from EI, so a record of employment usually isn’t needed.`);
  if(r.calc.outside)w.push(`${r.calc.outside} pay${r.calc.outside===1?' is':'s are'} after the final pay period ending date, so ${r.calc.outside===1?'it isn’t':'they aren’t'} counted. Check the date.`);
  const days=Math.round((pd(r.calc.due)-pd(today()))/864e5);
  w.push(days<0?`<b class="neg">It was due ${fmtDate(r.calc.due)}.</b> Submit it as soon as you can.`:`Due by ${fmtDate(r.calc.due)}: 5 days after the final pay period ends.`);
  return w.map(x=>`<div class="banner" style="margin:0 0 8px"><span>${x}</span></div>`).join('');
}

/** The ROE, block by block. */
function roeBlocks(emp,r,print){
  const cfg=payCfg(),c=r.calc;
  const row=(b,label,val)=>`<tr><td class="muted" style="white-space:nowrap">${b}</td><td>${label}</td><td>${val}</td></tr>`;
  const recall=r.recall==='Y'?fmtDate(r.recallDate):r.recall==='N'?'Not returning':'Unknown';
  const name=String(emp.name||'').trim().split(/\s+/),first=name.length>1?name.slice(0,-1).join(' '):name[0],lastName=name.length>1?name[name.length-1]:'';
  const pp=(c.periods||[]).map(p=>`<div class="roe-pp"><span class="muted">${+p.n||0}</span><span>${money(+p.amount||0)}</span></div>`).join('');
  return `<div class="tbl-wrap"><table class="roe-tbl"><tbody>
    ${row('5','CRA payroll account number',`<span translate="no">${esc(cfg.craAccount||'—')}</span>`)}
    ${row('6','Pay period type',`${esc(c.type)} · ${ROE_TYPE_LABEL[c.type]||''}`)}
    ${row('8','Social insurance number',`<span translate="no">${esc(String(emp.sin||'').replace(/(\d{3})(\d{3})(\d{3})/,'$1 $2 $3')||'—')}</span>`)}
    ${row('9','Employee',`<span translate="no">${esc(first)} <b>${esc(lastName)}</b></span>${emp.address?`<div class="muted" style="white-space:pre-line" translate="no">${esc(emp.address)}</div>`:''}`)}
    ${row('10','First day worked',fmtDate(r.firstDay))}
    ${row('11','Last day for which paid',fmtDate(r.lastDay))}
    ${row('12','Final pay period ending date',fmtDate(r.finalEnd))}
    ${row('13','Occupation',`<span translate="no">${esc(r.occupation||'—')}</span>`)}
    ${row('14','Expected date of recall',recall)}
    ${row('15A','Total insurable hours',`<b>${+c.hours||0}</b> <span class="muted">In the last ${+c.count||0} pay periods</span>`)}
    ${row('15C','Insurable earnings by pay period',`<b>${money(+c.total||0)}</b> <span class="muted">Pay period 1 is the final one.</span><div class="roe-pps">${pp}</div>`)}
    ${row('16','Reason for issuing',r.reason?`${esc(r.reason)} · ${esc(ROE_REASON[r.reason]||'')}${r.contact?`<div class="muted"><span>Contact:</span> <span translate="no">${esc(r.contact)}${r.phone?`, ${esc(r.phone)}`:''}</span></div>`:''}`:'—')}
    ${row('17A','Vacation pay paid because they’re leaving',+c.vacation?money(+c.vacation):'—')}
    ${row('17B','Statutory holiday pay after the last day',r.holAmt?`${fmtDate(r.holDate)} · ${money(r.holAmt)}`:'—')}
    ${row('17C','Other money',r.otherAmt?`<span translate="no">${esc(r.other)}</span> · ${money(r.otherAmt)}`:'—')}
    ${row('18','Comments',`<span translate="no">${esc(r.comments||'—')}</span>`)}
    ${r.serial?row('','ROE serial number',`<span translate="no">${esc(r.serial)}</span>`):''}
  </tbody></table></div>${print?'':'<div class="muted" style="font-size:12.5px">Vacation pay paid because they’re leaving goes in block 17A, so it isn’t in block 15C.</div>'}`;
}

function printHTML(html){
  let root=$('#printRoot');if(!root){root=document.createElement('div');root.id='printRoot';document.body.appendChild(root)}
  root.innerHTML=html;document.body.classList.add('printing');
  const done=()=>{document.body.classList.remove('printing');root.innerHTML='';window.removeEventListener('afterprint',done)};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{window.print();setTimeout(()=>{if(document.body.classList.contains('printing'))done()},1500)},50);
}
