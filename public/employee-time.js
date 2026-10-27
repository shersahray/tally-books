'use strict';
(()=>{
const el=id=>document.getElementById(id);
const request=async(path,data)=>{const res=await fetch('/api/employee/'+path,{credentials:'same-origin',...(data!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});const out=await res.json().catch(()=>({}));if(!res.ok)throw Error(out.error||'Request failed');return out};
const status=(msg)=>{el('employeeStatus').hidden=false;el('employeeStatus').textContent=msg};
let waiting=false;
const param=new URLSearchParams(location.search).get('company');
if(param)el('employeeCompany').value=param;
async function refresh(){
try{const me=await request('me'),result=await request('shifts');
el('employeeLogin').hidden=true;el('employeeArea').hidden=false;el('login').hidden=true;el('area').hidden=true;
el('employeeName').textContent=me.employee.name;
el('myState').textContent=result.active?'Clocked in since '+new Date(result.active.startedAt).toLocaleString():'Not clocked in';
el('myClockIn').hidden=!!result.active;el('myFinish').hidden=!result.active;
el('myHistory').replaceChildren();for(const shift of (result.shifts||[]).slice(-10).reverse()){const p=document.createElement('p');p.textContent=shift.date+' — '+((shift.workedMinutes||0)/60).toFixed(2)+' hours; $'+(shift.tips||0).toFixed(2)+' tips';el('myHistory').append(p)}
}catch{el('employeeLogin').hidden=false;el('employeeArea').hidden=true}
}
el('employeeForm').addEventListener('submit',async e=>{
e.preventDefault();const button=el('employeeSubmit');button.disabled=true;
try{const payload={companyId:el('employeeCompany').value.trim(),phone:el('employeePhone').value.trim()};
if(!waiting){await request('request-code',payload);waiting=true;el('employeeCodeBox').hidden=false;status('If this employee phone is registered, an SMS code has been sent.');button.textContent='Verify code'}
else{await request('verify-code',{...payload,code:el('employeeCode').value.trim()});status('Verified');await refresh()}
}catch(err){status(err.message)}finally{button.disabled=false}
});
el('myClockIn').onclick=async()=>{el('myClockIn').disabled=true;try{await request('clock-in',{});await refresh()}catch(e){alert(e.message)}finally{el('myClockIn').disabled=false}};
el('myClockOut').onclick=async()=>{el('myClockOut').disabled=true;try{await request('clock-out',{breakMinutes:Number(el('myBreaks').value),directTips:Number(el('myDirect').value),controlledTips:Number(el('myControlled').value)});await refresh()}catch(e){alert(e.message)}finally{el('myClockOut').disabled=false}};
el('employeeLogout').onclick=async()=>{await request('logout',{});waiting=false;el('employeeCodeBox').hidden=true;await refresh()};
refresh();
})();
