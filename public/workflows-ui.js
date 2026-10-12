'use strict';
/* ---------- Workflow reminders (Plus): screens ----------
   The rules live in workflows.js (shared with the server, which checks them every hour and when a company is opened).
   Here: the Reminders bell beside the company name (a count, and a list where each reminder opens its record and can
   be dismissed or snoozed), and Settings → Workflows, where ready-made rules are turned on and adjusted. */
const WF=TallyWorkflows;
const wfOn=()=>feat('workflows')&&!!ME&&ME.role!=='client';
const wfFmt={money:(n,c)=>typeof moneyC==='function'?moneyC(n,c):money(n),date:fmtDate};
const wfText=r=>WF.describe(r,isFr()?'fr':'en',today(),wfFmt);
let WF_OPEN=false;

/* ---------- the bell ---------- */
function drawReminders(){
  const b=$('#remBtn');if(!b)return;
  // Shown once a rule is on (or reminders are waiting), so companies that don't use workflows don't get an empty bell.
  const list=S.reminders||[],on=!!CO&&S.loaded&&wfOn()&&(list.length>0||WF.anyOn(S.company.workflows));
  b.hidden=!on;const c=$('#remCount');c.hidden=!list.length;c.textContent=list.length;
  b.setAttribute('aria-label',T(list.length?`Reminders: ${list.length}`:'Reminders'));
  b.setAttribute('aria-expanded',String(on&&WF_OPEN));
  const p=$('#remPanel');if(!p)return;
  if(!on||!WF_OPEN){p.hidden=true;p.innerHTML='';return}
  p.hidden=false;
  p.innerHTML=`<div class="rem-head"><b>Reminders</b>${perm('settings','edit')&&!ME.readOnly?'<button type="button" class="link" data-remset>Workflow settings</button>':''}</div>
    ${list.length?`<ul class="rem-list">${list.map(r=>`<li><button type="button" class="rem-go" data-remgo="${esc(r.key)}"><span class="pill quiet">${esc(T(WF.TEMPLATES[r.rule].label))}</span><span class="rem-txt" translate="no">${esc(wfText(r))}</span></button>
      <span class="rem-acts"><select data-remsnooze="${esc(r.key)}" aria-label="${esc(T('Snooze'))}"><option value="">Snooze</option><option value="1">1 day</option><option value="3">3 days</option><option value="7">1 week</option></select><button type="button" class="btn sm ghost" data-remdis="${esc(r.key)}">Dismiss</button></span></li>`).join('')}</ul>`
      :`<div class="empty" style="padding:18px 10px"><b>Nothing to do</b>${WF.anyOn(S.company.workflows)?'Reminders from your workflow rules show here.':'Turn on workflow rules in Settings to be reminded about overdue invoices, bills coming due and more.'}</div>`}`;
}
/** Open the record a reminder is about. */
function remOpen(r){
  WF_OPEN=false;drawReminders();
  if(r.col==='docs'){const d=S.docs.find(x=>x.id===r.id);if(!d)return toast('That invoice or bill isn’t in the books any more.',true);docForm(d.kind,d);if(typeof addExtras==='function')addExtras('docs',d.id);return}
  if(r.col==='estimates'){const x=S.estimates.find(y=>y.id===r.id);if(!x)return toast('That estimate isn’t in the books any more.',true);S.sales.tab='estimates';go('sales');estimateForm(x);return}
  if(r.col==='bankTxns'){S.bank={...S.bank,tab:'review',show:'new',acct:r.id};return go('banking')}
  if(r.col==='payroll'){S.pay.tab='remit';return go('payroll')}
  if(r.col==='salestax'){S.stax.tax=r.id;S.stax.period=null;return go('salestax')}
  if(r.col==='receipts'){S.rc.show='inbox';return go('receipts')}
}
async function remAct(key,action,days){
  try{await api('POST','/api/reminders/'+encodeURIComponent(key),{action,days});await load();toast(action==='dismiss'?'Reminder dismissed':days==1?'Snoozed for 1 day':`Snoozed for ${days} days`)}
  catch(e){toast(e.message,true);load()}
}
(function bindBell(){
  const b=$('#remBtn'),p=$('#remPanel');if(!b||!p)return;
  b.onclick=e=>{e.stopPropagation();WF_OPEN=!WF_OPEN;drawReminders();if(WF_OPEN){const f=p.querySelector('button,select');if(f)f.focus()}};
  p.onclick=e=>{e.stopPropagation();const t=e.target.closest('button');if(!t)return;
    if(t.dataset.remgo){const r=(S.reminders||[]).find(x=>x.key===t.dataset.remgo);if(r)remOpen(r)}
    else if(t.dataset.remdis)remAct(t.dataset.remdis,'dismiss');
    else if(t.hasAttribute('data-remset')){WF_OPEN=false;drawReminders();go('settings');setTimeout(()=>{const x=$('#wfPanel');if(x)x.scrollIntoView({block:'start'})},50)}};
  p.onchange=e=>{const s=e.target.closest('[data-remsnooze]');if(s&&s.value)remAct(s.dataset.remsnooze,'snooze',+s.value)};
  document.addEventListener('click',e=>{if(WF_OPEN&&!p.contains(e.target)&&e.target!==b){WF_OPEN=false;drawReminders()}});
  document.addEventListener('keydown',e=>{if(WF_OPEN&&e.key==='Escape'){WF_OPEN=false;drawReminders();b.focus()}});
})();

/* ---------- Settings → Workflows ---------- */
let WF_PEOPLE=null;
async function wfLoadPeople(){try{WF_PEOPLE=(await api('GET','/api/approvers')).people}catch(e){WF_PEOPLE=[]}if(S.view==='settings')renderMain()}
/** Why a rule can't remind anyone right now, if there's a reason. */
function wfNote(k){
  if(k==='billApproval'&&!(typeof apOn==='function'&&apOn()))return 'Bill approvals are off for this company, so this rule has nothing to check.';
  if(k==='payrollRemit'&&!feat('payroll'))return 'Payroll is off for this company, so this rule has nothing to check.';
  return '';
}
function workflowsPanel(){
  if(!ME||ME.role==='client')return '';
  if(!feat('workflows'))return TallyPlans.inPlan(ME.firmPlan,'workflows')?'':`<div class="panel" style="max-width:640px;margin-top:16px"><h3>Workflows</h3><div class="pad muted" style="font-size:13px"><span>Rules that remind the right people about overdue invoices, bills coming due and more.</span> <span class="pill quiet">${esc(T('In the Plus plan'))}</span></div></div>`;
  const can=perm('settings','edit')&&!ME.readOnly,dis=can?'':'disabled',s=S.company.workflows||{rules:{}};
  if(WF_PEOPLE===null){WF_PEOPLE=[];wfLoadPeople()}
  const rows=WF.KEYS.map(k=>{const t=WF.TEMPLATES[k],r=WF.rule(s,k),note=wfNote(k);
    const who=Object.entries(WF.WHO).filter(([w])=>w!=='approvers'||k==='billApproval').map(([w,l])=>`<option value="${w}" ${r.who===w?'selected':''}>${esc(T(l))}</option>`).join('');
    return `<div class="wf-rule" data-wfrule="${k}">
      <label class="check" style="align-items:flex-start"><input type="checkbox" data-wfon ${r.on?'checked':''} ${dis}> <span><b>${esc(T(t.label))}</b><br><span class="muted" style="font-size:12.5px">${esc(T(t.desc))}</span>${note?`<br><span class="muted" style="font-size:12.5px"><i>${esc(T(note))}</i></span>`:''}</span></label>
      <div class="wf-set" data-wfset ${r.on?'':'hidden'}>
        <div class="fields">
          <div class="field"><label for="wfD_${k}">${esc(T(t.daysLabel))}</label><input type="number" id="wfD_${k}" data-wfdays min="0" max="365" step="1" value="${r.days}" ${dis}></div>
          ${t.repeat!==undefined?`<div class="field"><label for="wfR_${k}">Remind again every (days)</label><input type="number" id="wfR_${k}" data-wfrepeat min="0" max="365" step="1" value="${r.repeat}" ${dis}><span class="hint">0 = only once</span></div>`:''}
          <div class="field"><label for="wfW_${k}">Who gets reminded</label><select id="wfW_${k}" data-wfwho ${dis}>${who}</select></div>
        </div>
        <div class="field" data-wfpeople ${r.who==='people'?'':'hidden'}><span class="flabel">People to remind</span><div class="ap-pick">${WF_PEOPLE.length?WF_PEOPLE.map(p=>`<label class="check"><input type="checkbox" data-wfperson="${p.id}" ${r.people.includes(p.id)?'checked':''} ${dis}> <span><span translate="no">${esc(p.name)}</span> <span class="muted">· ${p.roleName?`<span translate="no">${esc(p.roleName)}</span>`:esc(T(p.role==='owner'?'Owner':'Staff'))}</span></span></label>`).join(''):'<span class="muted">No one yet</span>'}</div></div>
        ${t.customer?`<label class="check"><input type="checkbox" data-wfcust ${r.customer?'checked':''} ${dis}> <span>${esc(T(k==='invoiceOverdue'?'Also email the customer a payment reminder (from this company’s email, at most once each time it’s due again)':'Also email the customer a follow-up (from this company’s email, once)'))}</span></label>`:''}
        <label class="check"><input type="checkbox" data-wfdigest ${r.digest?'checked':''} ${dis}> <span>Also send each person a daily email of new reminders</span></label>
      </div></div>`}).join('');
  return `<div class="panel" style="max-width:640px;margin-top:16px" id="wfPanel"><h3>Workflows</h3><form class="pad" id="wfForm" style="display:flex;flex-direction:column;gap:12px">
    <div class="muted" style="font-size:13px">Turn on a rule to be reminded when something needs doing. Reminders show under the bell beside the company name, for people whose role can see that part of the books. The rules are checked every hour and when the company is opened. Emails to customers are logged in the activity log.</div>
    ${rows}
    ${can?`<div class="actions" style="justify-content:flex-start"><button class="btn primary" type="submit">Save workflows</button><button class="btn" type="button" data-wfcheck>Check now</button></div>`:'<div class="muted" style="font-size:13px">Your role can’t change these settings.</div>'}
  </form></div>`;
}
function bindWorkflows(m){
  const f=$('#wfForm',m);if(!f)return;
  $$('[data-wfrule]',f).forEach(row=>{
    const on=$('[data-wfon]',row),set=$('[data-wfset]',row),who=$('[data-wfwho]',row),ppl=$('[data-wfpeople]',row);
    on.onchange=()=>{set.hidden=!on.checked};who.onchange=()=>{ppl.hidden=who.value!=='people'};
  });
  const read=()=>({rules:Object.fromEntries($$('[data-wfrule]',f).map(row=>{const k=row.dataset.wfrule,t=WF.TEMPLATES[k],num=s=>{const e=$(s,row);return e&&e.value!==''?+e.value:undefined};
    return [k,{on:$('[data-wfon]',row).checked,days:num('[data-wfdays]'),...(t.repeat!==undefined?{repeat:num('[data-wfrepeat]')}:{}),who:$('[data-wfwho]',row).value,
      people:$$('[data-wfperson]:checked',row).map(x=>x.dataset.wfperson),digest:$('[data-wfdigest]',row).checked,...(t.customer?{customer:$('[data-wfcust]',row).checked}:{})}]}))});
  f.onsubmit=async e=>{e.preventDefault();
    let w;try{w=WF.clean(read())}catch(ex){return toast(T(ex.message),true)}
    if(await putCompany({...strip(S.company),workflows:w}))toast('Workflows saved')};
  const ck=$('[data-wfcheck]',f);if(ck)ck.onclick=async()=>{ck.disabled=true;
    try{const r=await api('POST','/api/workflows/check',{});await load();toast(r.created?(r.created===1?'1 new reminder':`${r.created} new reminders`):'No new reminders')}
    catch(ex){toast(ex.message,true)}finally{ck.disabled=false}};
}
