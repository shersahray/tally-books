'use strict';
/* ---------- Bill approvals (Thrive): screens ----------
   The rules live in approvals.js (shared with the server). Here: the Expenses → Waiting for approval list and its
   nav count, the approval box on a bill (status, history, Approve / Reject), and the settings panel.
   A bill waiting for approval (or rejected) is in Accounts payable, but its Pay buttons are hidden and the
   server refuses a payment on it. */
const apOn=()=>TallyApprovals.active(S.company&&S.company.approvals,feat('billApprovals'));
const apHeld=d=>TallyApprovals.held(d,apOn());
const apMe=()=>ME?{...ME,approveBills:!!ME.approveBills}:null;
/** '' when the signed-in person can approve or reject this bill, otherwise why not. */
const apWhy=d=>TallyApprovals.whyNot(apMe(),S.company.approvals,d,S.approvalOwners||1);
/** Can the signed-in person approve bills at all (owner, named approver or a role with Approve bills)? */
const apApprover=()=>!!ME&&ME.role!=='client'&&(ME.role==='owner'||TallyApprovals.clean(S.company.approvals).approvers.includes(ME.id)||!!ME.approveBills);
const apWaiting=()=>apOn()?S.docs.filter(d=>d.kind==='bill'&&d.approval&&d.approval.status==='waiting'):[];
/** The nav count: bills this person can approve now. */
const apCount=()=>apApprover()?apWaiting().filter(d=>!apWhy(d)).length:0;
const AP_LABEL={waiting:'Waiting for approval',approved:'Approved',rejected:'Rejected'};
const AP_PILL={waiting:'partial',approved:'paid',rejected:'overdue'};
const AP_ACTION={submitted:'Sent for approval',resubmitted:'Sent for approval again',changed:'Changed after approval; sent for approval again',approved:'Approved',rejected:'Rejected'};
/** The pill for a bill's approval in lists, or '' when it has none (or approvals are off). */
const apPill=d=>apOn()&&d.kind==='bill'&&d.approval&&AP_LABEL[d.approval.status]?`<span class="pill ${AP_PILL[d.approval.status]}">${esc(T(AP_LABEL[d.approval.status]))}</span>`:'';
/** Why a bill can't be paid, for the screens. */
const apHeldMsg=d=>d.approval.status==='rejected'?'This bill was rejected, so it can’t be paid. Correct it and send it for approval again.':'This bill is waiting for approval, so it can’t be paid yet.';

/* ---------- Expenses → Waiting for approval ---------- */
function vApprovals(){
  const waiting=apWaiting().sort((a,b)=>a.date.localeCompare(b.date));
  const rejected=S.docs.filter(d=>d.kind==='bill'&&d.approval&&d.approval.status==='rejected').sort((a,b)=>b.date.localeCompare(a.date));
  const s=TallyApprovals.clean(S.company.approvals);
  const rule=s.over>0?`${T('Bills over')} ${money(s.over)}`:T('Every bill');
  const row=(d,act)=>{const why=apWhy(d),last=(d.approval.history||[]).slice(-1)[0]||{};
    return `<tr class="click" data-doc="${d.id}"><td style="white-space:nowrap">${fmtDate(d.date)}</td><td class="mono">${esc(d.number||'—')}</td><td class="trunc" translate="no">${esc(contactName(d.contactId))}</td><td class="n">${moneyC(d.total,d.currency)}</td><td><span translate="no">${esc(d.approval.enteredName||d.approval.enteredBy||'')}</span></td>
      <td class="n" style="white-space:nowrap">${act?(why?`<span class="muted" style="font-size:12.5px">${esc(T(why))}</span>`:`<button class="btn sm" data-apdo="reject" data-apid="${d.id}">Reject</button> <button class="btn sm primary" data-apdo="approve" data-apid="${d.id}">Approve</button>`):`<span class="muted trunc" style="font-size:12.5px">${last.comment?`“${esc(last.comment)}”`:''}</span>`}</td></tr>`};
  return `<div class="panel"><div class="toolbar"><span class="grow muted"><span>${esc(rule)}</span>${s.vendors.length?` <span>${esc(T('from chosen vendors'))}</span>`:''} <span>${esc(T('wait for approval before they can be paid. They’re already in Accounts payable.'))}</span></span>${ME&&ME.role==='owner'?'<button class="btn sm" data-go="settings">Approval settings</button>':''}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>No.</th><th>Vendor</th><th class="n">Total</th><th>Entered by</th><th></th></tr></thead><tbody>${waiting.length?waiting.map(d=>row(d,true)).join(''):emptyRow(6,'Nothing waiting','Bills that need approval show here.')}</tbody></table></div></div>
    ${rejected.length?`<div class="panel" style="margin-top:16px"><h3>Rejected</h3><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>No.</th><th>Vendor</th><th class="n">Total</th><th>Entered by</th><th>Why</th></tr></thead><tbody>${rejected.map(d=>row(d,false)).join('')}</tbody></table></div></div>`:''}`;
}

/** Approve or reject a bill, with a comment (needed to reject). Resolves true once done. */
function apDecide(id,action){
  const d=S.docs.find(x=>x.id===id);if(!d)return Promise.resolve(false);
  const rej=action==='reject',again=action==='resubmit';
  const ask=typeof subModal==='function'&&$('#modalRoot').innerHTML?subModal:openModal;
  return new Promise(res=>{
    const f=ask(rej?'Reject bill':again?'Send for approval again':'Approve bill',`<div class="muted" style="font-size:13px"><span>Bill</span> ${d.number?`<b class="mono">#${esc(d.number)}</b> `:''}· <span translate="no">${esc(contactName(d.contactId))}</span> · ${moneyC(d.total,d.currency)}</div>
      ${!rej&&!again&&d.approval&&d.approval.enteredBy===ME.username?`<div class="banner" style="margin:0"><span>You entered this bill. You can approve it because you’re the only owner.</span></div>`:''}
      <div class="field"><label for="apCmt">${rej?'Why is it rejected?':'Comment (optional)'}</label><textarea id="apCmt" maxlength="500" placeholder="${esc(T(rej?'For example: wrong amount, the quote was $1,200':'Shown to the person who entered the bill'))}"></textarea></div>`,
      `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${rej?'Reject':again?'Send':'Approve'}</button>`);
    f.classList.add('keep');
    const close=()=>{if(f.close)f.close();else closeModal()};
    $$('[data-close]',f).forEach(b=>b.addEventListener('click',()=>res(false)));
    f.onsubmit=async e=>{e.preventDefault();f.err('');
      const comment=$('#apCmt',f).value.trim();if(rej&&!comment)return f.err('Say why the bill is rejected, so the person who entered it knows what to fix.');
      try{await api('POST','/api/approvals/'+encodeURIComponent(id),{action,comment});await load();close();toast(rej?'Bill rejected':again?'Bill sent for approval again':'Bill approved');res(true)}
      catch(ex){f.err(ex.message)}};
  });
}

/** The approval box at the top of a bill: its status, what happened and the buttons for it. */
function apBox(doc){
  if(!doc||doc.kind!=='bill'||!doc.approval||!AP_LABEL[doc.approval.status]||!feat('billApprovals'))return '';
  const a=doc.approval,on=apOn(),why=on&&a.status==='waiting'?apWhy(doc):'x';
  const hist=(a.history||[]).slice().reverse().map(h=>`<li><b>${esc(T(AP_ACTION[h.action]||h.action))}</b> · <span translate="no">${esc(h.name||h.by)}</span> · <span class="muted">${fmtWhen(h.at)}</span>${h.comment?`<div translate="no">“${esc(h.comment)}”</div>`:''}</li>`).join('');
  const btns=on&&!why?`<button type="button" class="btn sm" data-apdo="reject">Reject</button> <button type="button" class="btn sm primary" data-apdo="approve">Approve</button>`
    :on&&a.status==='rejected'&&ME&&ME.role!=='client'&&perm('expenses','edit')?'<button type="button" class="btn sm" data-apdo="resubmit">Send for approval again</button>':'';
  const note=!on?'Bill approvals are off now, so this bill can be paid.':a.status==='waiting'?(why&&why!=='x'&&apApprover()?why:'It’s in Accounts payable, but it can’t be paid until it’s approved.'):a.status==='rejected'?'It can’t be paid. Correct it and save, or send it for approval again.':'Changing the vendor, amounts or lines sends it back for approval.';
  return `<div class="banner ap-box" data-apbox style="margin:0;display:block"><div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span>${apPill(doc)||`<span class="pill quiet">${esc(T(AP_LABEL[a.status]))}</span>`} <span>${esc(T(note))}</span></span><span>${btns}</span></div>
    ${hist?`<details style="margin-top:6px"${a.status==='rejected'?' open':''}><summary class="muted" style="cursor:pointer;font-size:13px">Approval history</summary><ul class="ap-hist">${hist}</ul></details>`:''}</div>`;
}
function bindApBox(f,doc){
  $$('[data-apbox] [data-apdo]',f).forEach(b=>b.onclick=async()=>{if(await apDecide(doc.id,b.dataset.apdo)){closeModal();const d=S.docs.find(x=>x.id===doc.id);if(d){docForm('bill',d);if(typeof addExtras==='function')addExtras('docs',d.id)}}});
}
/** After saving a bill: say so when it's now waiting for approval. */
function apSavedToast(id,fallback){const d=S.docs.find(x=>x.id===id);if(d&&apHeld(d)&&d.approval.status==='waiting')toast('Bill saved. It’s waiting for approval before it can be paid.');else toast(fallback)}

/* ---------- Settings → Bill approvals ---------- */
let AP_PEOPLE=null;
async function apLoadPeople(){try{AP_PEOPLE=(await api('GET','/api/approvers')).people}catch(e){AP_PEOPLE=[]}if(S.view==='settings')renderMain()}
function approvalsPanel(){
  if(!ME||ME.role==='client')return '';
  const inPlan=TallyPlans.inPlan(ME.firmPlan,'billApprovals');
  if(!feat('billApprovals'))return inPlan?'':`<div class="panel" style="max-width:640px;margin-top:16px"><h3>Bill approvals</h3><div class="pad muted" style="font-size:13px"><span>Bills over an amount wait for an owner or approver before they can be paid.</span> ${inPlanPill('billApprovals')}</div></div>`;
  const s=TallyApprovals.clean(S.company.approvals),own=ME.role==='owner'&&!ME.readOnly,dis=own?'':'disabled';
  if(AP_PEOPLE===null){AP_PEOPLE=[];apLoadPeople()}
  const vendors=S.contacts.filter(c=>c.kind==='vendor').sort((a,b)=>a.name.localeCompare(b.name));
  const people=AP_PEOPLE.filter(p=>p.role!=='owner');
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Bill approvals</h3><form class="pad" id="apForm" style="display:flex;flex-direction:column;gap:12px">
    <div class="muted" style="font-size:13px">Bills that need approval are recorded in Accounts payable as usual, but can’t be paid until an owner or approver approves them. Approvers see them under Expenses → Waiting for approval.</div>
    <label class="check"><input type="checkbox" id="apOn" ${s.on?'checked':''} ${dis}> <span>Bills need approval before they can be paid</span></label>
    <div data-apset style="display:flex;flex-direction:column;gap:12px">
      <div class="fields"><div class="field"><label for="apOver">Bills over</label><input type="number" id="apOver" min="0" step="0.01" value="${s.over||''}" placeholder="0" ${dis}><span class="hint">Leave at 0 for every bill</span></div></div>
      <div class="field"><span class="flabel">Only bills from these vendors</span><div class="ap-pick">${vendors.length?vendors.map(c=>`<label class="check"><input type="checkbox" data-apvendor="${c.id}" ${s.vendors.includes(c.id)?'checked':''} ${dis}> <span translate="no">${esc(c.name)}</span></label>`).join(''):'<span class="muted">No vendors yet</span>'}</div><span class="hint">Tick none for bills from any vendor</span></div>
      <div class="field"><span class="flabel">Who approves</span><div class="ap-pick"><label class="check"><input type="checkbox" checked disabled> <span>Owners</span></label>${people.map(p=>`<label class="check"><input type="checkbox" data-approver="${p.id}" ${s.approvers.includes(p.id)||p.approveBills?'checked':''} ${dis||(p.approveBills?'disabled':'')}> <span><span translate="no">${esc(p.name)}</span>${p.roleName?` <span class="muted">· <span translate="no">${esc(p.roleName)}</span>${p.approveBills?` · <span>${esc(T('approves bills with their role'))}</span>`:''}</span>`:''}</span></label>`).join('')}</div>
        <span class="hint">Staff whose custom role has “Approve bills” can approve too. Nobody approves a bill they entered, unless they’re the only owner.</span></div>
    </div>
    ${own?'<div><button class="btn primary" type="submit">Save approval settings</button></div>':'<div class="muted" style="font-size:13px">Only an owner can change these settings.</div>'}
  </form></div>`;
}
function bindApprovals(m){
  const f=$('#apForm',m);if(!f)return;
  const sync=()=>{$('[data-apset]',f).style.display=$('#apOn',f).checked?'flex':'none'};$('#apOn',f).onchange=sync;sync();
  f.onsubmit=async e=>{e.preventDefault();
    const approvals={on:$('#apOn',f).checked,over:Math.max(0,+$('#apOver',f).value||0),vendors:$$('[data-apvendor]:checked',f).map(x=>x.dataset.apvendor),approvers:$$('[data-approver]:checked:not(:disabled)',f).map(x=>x.dataset.approver)};
    if(await putCompany({...strip(S.company),approvals}))toast('Approval settings saved')};
}
/* Clicks on the Waiting for approval list. */
function approvalsClick(e,t,d){
  if(d.apdo&&d.apid){e.stopPropagation();apDecide(d.apid,d.apdo);return true}
  return false;
}
