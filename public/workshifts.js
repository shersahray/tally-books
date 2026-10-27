'use strict';
/* Weekly employee shifts and tips: recording/reporting only; never posts payroll. */
S.shifts = {week:shiftMonday(today())};
const shiftworker=id=>S.shiftworkers.find(e=>e.id===id);
function shiftMonday(day){const d=pd(day);const offset=(d.getDay()+6)%7;d.setDate(d.getDate()-offset);return iso(d)}
const shiftHours=s=>(+s.workedMinutes||0)/60;
const shiftMoney=n=>money(Math.round(n*100)/100);
function shiftRows(){const from=S.shifts.week,to=addDays(from,6);return S.workshifts.filter(s=>s.date>=from&&s.date<=to).sort((a,b)=>a.date.localeCompare(b.date)||String(a.employeeId).localeCompare(String(b.employeeId)))}
function shiftPage(){return head('Timesheets & Tips','Track daily hours and tips independently of payroll',perm('timesheets','edit')?'<button class="btn" data-worker-new>Add team member</button>':'')+shiftView()}
function shiftView(){
  const rows=shiftRows(),to=addDays(S.shifts.week,6),emps=S.shiftworkers.filter(e=>e.active!==false||rows.some(s=>s.employeeId===e.id));
  const totals=emps.map(emp=>{const rr=rows.filter(s=>s.employeeId===emp.id),hours=rr.reduce((n,s)=>n+shiftHours(s),0),tips=rr.reduce((n,s)=>n+(+s.tips||0),0),controlled=rr.reduce((n,s)=>n+(s.tipType==='controlled'?(+s.tips||0):0),0);return{emp,hours,tips,controlled,direct:tips-controlled,regularEstimate:emp.payType==='hourly'?hours*(+emp.rate||0):null}});
  const grand=(key)=>totals.reduce((sum,r)=>sum+(r[key]||0),0);
  return '<div class="panel"><div class="toolbar"><strong>Weekly hours & tips</strong><span class="grow muted">Monday to Sunday · Payroll preparation, not a posted pay run</span><button class="btn" data-shift-csv>Export CSV</button><button class="btn primary" data-shift-edit="new">+ Daily entry</button></div>'+ 
    '<div class="toolbar"><button class="btn sm" data-shift-week="prev">← Previous</button><label>Week starting <input type="date" id="shiftWeek" value="'+esc(S.shifts.week)+'"></label><button class="btn sm" data-shift-week="next">Next →</button><span class="muted">Through '+esc(fmtDate(to))+'</span></div>'+
    '<div class="tbl-wrap"><table><thead><tr><th>Employee</th><th class="n">Hours</th><th class="n">Direct tips</th><th class="n">Employer-controlled tips</th><th class="n">All tips</th><th class="n">Est. regular wages</th></tr></thead><tbody>'+totals.map(x=>'<tr><td>'+esc(x.emp.name)+'</td><td class="n">'+x.hours.toFixed(2)+'</td><td class="n">'+shiftMoney(x.direct)+'</td><td class="n">'+shiftMoney(x.controlled)+'</td><td class="n">'+shiftMoney(x.tips)+'</td><td class="n">'+(x.regularEstimate===null?'—':shiftMoney(x.regularEstimate))+'</td></tr>').join('')+
    '<tr><th>Total</th><th class="n">'+grand('hours').toFixed(2)+'</th><th class="n">'+shiftMoney(grand('direct'))+'</th><th class="n">'+shiftMoney(grand('controlled'))+'</th><th class="n">'+shiftMoney(grand('tips'))+'</th><th class="n">—</th></tr></tbody></table></div></div>'+
    '<div class="panel"><h3>Daily entries</h3><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>Shift</th><th class="n">Break (min)</th><th class="n">Worked</th><th class="n">Tips</th><th>Tip type</th><th></th></tr></thead><tbody>'+ (rows.length?rows.map(s=>'<tr><td>'+esc(fmtDate(s.date))+'</td><td>'+esc(shiftworker(s.employeeId)?.name||'Former employee')+'</td><td>'+esc(s.start)+' – '+esc(s.end)+'</td><td class="n">'+s.breakMinutes+'</td><td class="n">'+shiftHours(s).toFixed(2)+'</td><td class="n">'+shiftMoney(s.tips)+'</td><td>'+ (s.tipType==='direct'?'Direct':'Employer-controlled')+'</td><td><button class="btn sm" data-shift-edit="'+esc(s.id)+'">Edit</button></td></tr>').join(''):'<tr><td colspan="8">No shifts recorded for this week.</td></tr>')+'</tbody></table></div><p class="muted">Tips are reported separately from wages. Overtime, vacation pay, CPP/QPP, EI, income tax and the treatment of tips must be reviewed when preparing the actual payroll.</p></div>';
}
function shiftForm(id){
  if(!perm('timesheets','edit'))return;
  const old=S.workshifts.find(s=>s.id===id)||{},d=old.date||today();
  if(!S.shiftworkers.length)return toast('Add an employee first.',true);
  const field=(label,html)=>'<label class="field"><span>'+label+'</span>'+html+'</label>';
  const body='<div class="form-grid">'+field('Employee','<select id="shEmp">'+S.shiftworkers.map(e=>'<option value="'+esc(e.id)+'" '+(e.id===old.employeeId?'selected':'')+'>'+esc(e.name)+'</option>').join('')+'</select>')+
    field('Date','<input id="shDate" type="date" value="'+esc(d)+'" required>')+field('Clock in','<input id="shStart" type="time" value="'+esc(old.start||'09:00')+'" required>')+field('Clock out','<input id="shEnd" type="time" value="'+esc(old.end||'17:00')+'" required>')+
    field('Unpaid break (minutes)','<input id="shBreak" type="number" min="0" step="1" value="'+(old.breakMinutes||0)+'">')+field('Tips earned ($)','<input id="shTips" type="number" min="0" step="0.01" value="'+(old.tips||0)+'">')+
    field('Tips classification','<select id="shType"><option value="controlled" '+(old.tipType!=='direct'?'selected':'')+'>Employer-controlled tips</option><option value="direct" '+(old.tipType==='direct'?'selected':'')+'>Direct tips</option></select>')+
    field('Notes','<input id="shNotes" maxlength="300" value="'+esc(old.notes||'')+'">')+'</div>';
  const f=openModal(id&&id!=='new'?'Edit daily shift':'Add daily shift',body,'<button class="btn primary" type="submit">Save shift</button>'+(old.id?'<button class="btn" type="button" id="shDelete">Delete</button>':''));
  f.onsubmit=async ev=>{ev.preventDefault();const value=x=>$('#'+x,f).value;
    const data={employeeId:value('shEmp'),date:value('shDate'),start:value('shStart'),end:value('shEnd'),breakMinutes:Number(value('shBreak')),tips:Number(value('shTips')),tipType:value('shType'),notes:value('shNotes')};
    if(!data.date||!data.start||!data.end||data.breakMinutes<0||!Number.isInteger(data.breakMinutes)||!Number.isFinite(data.tips)||data.tips<0)return f.err('Check the date, times, break and tips.');
    if(await put('workshifts',old.id||uid(),data)){S.shifts.week=shiftMonday(data.date);closeModal();renderMain()}
  };
  if(old.id)$('#shDelete',f).onclick=async()=>{if(await confirmBox('Delete this daily shift?','The hours and tips will be removed from weekly reports.')&&await del('workshifts',old.id)){closeModal();renderMain()}};
}
function shiftCSV(){
  const q=x=>'"'+String(x??'').replace(/"/g,'""')+'"';
  const rows=shiftRows().map(s=>[s.date,shiftworker(s.employeeId)?.name||'',s.start,s.end,s.breakMinutes,shiftHours(s).toFixed(2),s.tipType==='direct'?s.tips:0,s.tipType==='controlled'?s.tips:0,s.tips,s.notes||'']);
  const csv=[['Date','Employee','Clock in','Clock out','Unpaid break (min)','Hours worked','Direct tips CAD','Employer-controlled tips CAD','Total tips CAD','Notes'],...rows].map(r=>r.map(q).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='sumlora-weekly-hours-tips-'+S.shifts.week+'.csv';a.click();URL.revokeObjectURL(url);
}
async function shiftClick(e,t,d){
  if(d.workerNew!==undefined){workerForm();return true}
  if(d.shiftEdit){shiftForm(d.shiftEdit);return true}
  if(d.shiftCsv!==undefined){shiftCSV();return true}
  if(d.shiftWeek){S.shifts.week=addDays(S.shifts.week,d.shiftWeek==='prev'?-7:7);renderMain();return true}
  return false;
}
function bindShiftWeek(m){const el=$('#shiftWeek',m);if(el)el.onchange=()=>{if(el.value){S.shifts.week=shiftMonday(el.value);renderMain()}}}

function workerForm(){
 if(!perm('timesheets','edit'))return;
 const f=openModal('Add team member','<label class="field">Name<input id="twName" maxlength="160" required></label><label class="field">Employee phone (Canada/US)<input id="twPhone" type="tel" autocomplete="tel" placeholder="613-555-0100"></label><label class="field">Hourly rate ($, optional)<input id="twRate" type="number" min="0" step="0.01" value="0"></label>','<button class="btn primary" type="submit">Save</button>');
 f.onsubmit=async e=>{e.preventDefault();const name=$('#twName',f).value.trim(),rate=Number($('#twRate',f).value);if(!name||!Number.isFinite(rate)||rate<0)return f.err('Enter a valid name and hourly rate.');if(await put('shiftworkers',uid(),{name,phone:$('#twPhone',f).value.trim(),rate,active:true})){closeModal();renderMain()}};
}
