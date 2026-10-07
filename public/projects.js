'use strict';
/* ---------- Projects and time ----------
   A project is work for one customer. Invoices, sales receipts, bills, expenses, deposits and journal entries can
   point at a project (proj), and so can time. A project's income and costs come from the ledger lines of those
   transactions; time adds labour cost at each person's cost rate. Billable time not invoiced yet is billed by
   making an invoice from it, which marks it billed. */

const projById=id=>S.projects.find(p=>p.id===id);
const projName=id=>(projById(id)||{}).name||'';
function projField(id,val){
  if(!feat('projects'))return '';
  const ps=S.projects.filter(p=>p.status!=='done'||p.id===val).sort((a,b)=>a.name.localeCompare(b.name));
  if(!ps.length)return '';
  return fld(id,'Project',`<select id="${id}"><option value="">${T('No project')}</option>${ps.map(p=>`<option value="${esc(p.id)}" ${p.id===val?'selected':''}>${esc(p.name)}${p.contactId?` · ${esc(contactName(p.contactId))}`:''}</option>`).join('')}</select>`);
}
const projOf=(f,id)=>{const s=$('#'+id,f);return s&&s.value?{proj:s.value}:{}};
/** Billed or not: billed only while its invoice still exists. */
const timeBilled=t=>!!(t.invoiceId&&S.docs.some(d=>d.id===t.invoiceId));
const timeValue=t=>r2((+t.hours||0)*(+t.rate||0));

/** Income, costs and profit of a project, from the ledger, plus labour cost and unbilled time. */
function projNumbers(p){
  let income=0,costs=0;const txns=[];
  for(const e of S.entries){if(e.proj!==p.id)continue;let i=0,c=0;
    for(const l of e.lines||[]){const a=acct(l.account);if(!a)continue;if(a.type==='Income')i+=(+l.credit||0)-(+l.debit||0);else if(a.type==='Expense'||a.type==='Cost of Goods Sold')c+=(+l.debit||0)-(+l.credit||0)}
    income+=i;costs+=c;txns.push({e,i:r2(i),c:r2(c)})}
  const times=S.times.filter(t=>t.projectId===p.id);
  const hours=times.reduce((s,t)=>s+(+t.hours||0),0),labour=r2(times.reduce((s,t)=>s+(+t.hours||0)*(+t.cost||0),0));
  const unbilled=times.filter(t=>t.billable&&!timeBilled(t)),ub=r2(unbilled.reduce((s,t)=>s+timeValue(t),0));
  income=r2(income);costs=r2(costs);
  return{income,costs,labour,profit:r2(income-costs-labour),hours:r2(hours),unbilledH:r2(unbilled.reduce((s,t)=>s+(+t.hours||0),0)),unbilled:ub,txns,times};
}

function vProjects(){
  if(!feat('projects'))return head('Projects','')+'<div class="panel"><div class="empty"><b>Projects aren’t on</b>Projects and time are in the Plus plan. They can also be switched off for this company in Settings.</div></div>';
  if(S.param&&projById(S.param))return vProject(projById(S.param));
  const P=S.proj||(S.proj={tab:'projects',show:'active',who:'',cust:'',unbilled:false});
  const staff=ME&&ME.role!=='client'&&!ME.readOnly;
  const h=head('Projects','Income, costs and profit for each job, and the time spent on it',staff?`${P.tab==='time'?'<button class="btn" data-billtime="">Bill time</button><button class="btn primary" data-time="">+ Add time</button>':'<button class="btn primary" data-proj="new">+ New project</button>'}`:'')+
    `<div class="tabs" role="tablist"><button role="tab" data-ptab="projects" aria-selected="${P.tab==='projects'}">Projects</button><button role="tab" data-ptab="time" aria-selected="${P.tab==='time'}">Time</button></div>`;
  if(P.tab==='time')return h+vTime();
  const list=S.projects.filter(p=>P.show==='all'||(P.show==='done'?p.status==='done':p.status!=='done')).sort((a,b)=>a.name.localeCompare(b.name)).map(p=>({p,n:projNumbers(p)}));
  const tot=k=>r2(list.reduce((s,x)=>s+x.n[k],0));
  return h+`<div class="chips"><div class="chip"><div class="lbl">Income</div><div class="val">${money(tot('income'))}</div></div><div class="chip"><div class="lbl">Costs</div><div class="val">${money(r2(tot('costs')+tot('labour')))}</div></div><div class="chip"><div class="lbl">Profit</div><div class="val ${tot('profit')<0?'neg':''}">${money(tot('profit'))}</div></div><div class="chip"><div class="lbl">Time not billed</div><div class="val">${money(tot('unbilled'))}</div></div></div>
  <div class="panel"><div class="toolbar"><label class="flabel" for="projShow">Show</label><select id="projShow">${[['active','Active'],['done','Done'],['all','All']].map(([k,v])=>`<option value="${k}" ${P.show===k?'selected':''}>${v}</option>`).join('')}</select><span class="grow"></span></div>
  <div class="tbl-wrap"><table><thead><tr><th>Project</th><th>Customer</th><th class="n">Income</th><th class="n">Costs</th><th class="n">Profit</th><th class="n">Margin</th><th class="n">Hours</th><th class="n">Not billed</th></tr></thead><tbody>${list.length?list.map(({p,n})=>{const cost=r2(n.costs+n.labour);return `<tr class="click" data-proj="${esc(p.id)}"><td><b translate="no">${esc(p.name)}</b>${p.status==='done'?' <span class="pill quiet">Done</span>':''}</td><td class="trunc" translate="no">${esc(contactName(p.contactId)||'—')}</td><td class="n">${money(n.income)}</td><td class="n">${money(cost)}</td><td class="n ${n.profit<0?'neg':''}">${money(n.profit)}</td><td class="n">${n.income?`${Math.round(n.profit/n.income*100)}%`:'<span class="muted">—</span>'}</td><td class="n">${n.hours||'<span class="muted">—</span>'}</td><td class="n">${n.unbilled?money(n.unbilled):'<span class="muted">—</span>'}</td></tr>`}).join(''):emptyRow(8,S.projects.length?'No projects here':'No projects yet',S.projects.length?'Try another filter.':'Make a project for a job, then pick it on invoices, bills, expenses and time to see what the job earned.')}</tbody></table></div></div>`;
}
function vProject(p){
  const n=projNumbers(p),staff=ME&&ME.role!=='client'&&!ME.readOnly,cost=r2(n.costs+n.labour);
  const bud=p.budget!==''&&p.budget!=null?+p.budget:null,used=bud?Math.min(100,Math.round(cost/bud*100)):0;
  const txns=n.txns.sort((a,b)=>b.e.date.localeCompare(a.e.date));
  return `<button class="btn ghost sm" data-projback style="margin-bottom:8px">← Projects</button>`+head('⁠'+p.name,`${p.contactId?`<span translate="no">${esc(contactName(p.contactId))}</span>`:''}${p.start?` · ${fmtDate(p.start)}${p.end?' – '+fmtDate(p.end):''}`:''}${p.status==='done'?' · <span class="pill quiet">Done</span>':''}`,staff?`<button class="btn" data-proj="edit:${esc(p.id)}">Edit project</button>${n.unbilled?`<button class="btn" data-billtime="${esc(p.contactId||'')}" data-billproj="${esc(p.id)}">Bill time</button>`:''}<button class="btn primary" data-time="" data-timeproj="${esc(p.id)}">+ Add time</button>`:'')+
  `<div class="chips"><div class="chip"><div class="lbl">Income</div><div class="val">${money(n.income)}</div></div><div class="chip"><div class="lbl">Costs</div><div class="val">${money(n.costs)}</div>${n.labour?`<div class="lbl">+ ${money(n.labour)} <span>labour</span></div>`:''}</div><div class="chip"><div class="lbl">Profit</div><div class="val ${n.profit<0?'neg':''}">${money(n.profit)}</div>${n.income?`<div class="lbl">${Math.round(n.profit/n.income*100)}% <span>margin</span></div>`:''}</div><div class="chip"><div class="lbl">Time</div><div class="val">${n.hours} h</div>${n.unbilled?`<div class="lbl">${n.unbilledH} h <span>not billed</span> · ${money(n.unbilled)}</div>`:''}</div></div>
  ${bud?`<div class="panel" style="margin-bottom:16px"><div class="pad"><div style="display:flex;justify-content:space-between;font-size:13.5px"><span>Costs against the budget of ${money(bud)}</span><b class="${cost>bud?'neg':''}">${Math.round(cost/bud*100)}%</b></div><div class="meter"><span style="width:${used}%;background:${cost>bud?'var(--neg)':'var(--accent)'}"></span></div></div></div>`:''}
  <div class="ov-grid"><div class="panel"><h3>Transactions</h3><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Name</th><th class="n">Income</th><th class="n">Cost</th></tr></thead><tbody>${txns.length?txns.map(x=>`<tr class="click" data-entry="${esc(x.e.id)}"><td style="white-space:nowrap">${fmtDate(x.e.date)}</td><td>${esc(T(TLABEL[x.e.type]||x.e.type))}${x.e.ref?` <span class="mono muted">#${esc(x.e.ref)}</span>`:''}</td><td class="trunc" translate="no">${esc(contactName(x.e.contactId)||x.e.memo||'')}</td><td class="n">${x.i?money(x.i):''}</td><td class="n">${x.c?money(x.c):''}</td></tr>`).join(''):emptyRow(5,'Nothing yet','Pick this project on an invoice, bill or expense.')}</tbody></table></div></div>
  <div class="panel"><h3>Time</h3><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Who</th><th class="n">Hours</th><th class="n">Value</th><th></th></tr></thead><tbody>${n.times.length?n.times.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(t=>`<tr class="click" data-time="${esc(t.id)}"><td style="white-space:nowrap">${fmtDate(t.date)}</td><td class="trunc" translate="no">${esc(t.who)}${t.desc?`<div class="muted" style="font-size:12px">${esc(t.desc)}</div>`:''}</td><td class="n">${t.hours}</td><td class="n">${t.billable?money(timeValue(t)):'<span class="muted">—</span>'}</td><td>${timeBilled(t)?'<span class="pill paid">Billed</span>':t.billable?'<span class="pill open">Not billed</span>':'<span class="pill quiet">Not billable</span>'}</td></tr>`).join(''):emptyRow(5,'No time yet','Add the hours worked on this project.')}</tbody></table></div></div></div>
  ${p.notes?`<div class="panel" style="margin-top:16px"><h3>Notes</h3><div class="pad" style="white-space:pre-wrap">${esc(p.notes)}</div></div>`:''}`;
}
function projectForm(p,preset){
  const d=p||{name:'',contactId:'',status:'active',start:today(),end:'',budget:'',notes:'',...(preset||{})};
  const f=openModal(p?p.name:'New project',`<div class="fields">
    ${fld('pjName','Project name',`<input type="text" id="pjName" maxlength="120" value="${esc(d.name)}" placeholder="${esc(T('e.g. Kitchen renovation, 2026 year-end'))}">`,true)}
    ${fld('pjC','Customer',contactSelect('pjC',d.contactId,'customer'))}
    ${fld('pjBudget','Budget for costs (optional)',`<input type="number" id="pjBudget" step="0.01" min="0" value="${esc(d.budget??'')}">`)}
    ${fld('pjStart','Start',`<input type="date" id="pjStart" value="${esc(d.start||'')}">`)}${fld('pjEnd','End (optional)',`<input type="date" id="pjEnd" value="${esc(d.end||'')}">`)}
    ${p?fld('pjStatus','Status',`<select id="pjStatus"><option value="active" ${d.status!=='done'?'selected':''}>${T('Active')}</option><option value="done" ${d.status==='done'?'selected':''}>${T('Done')}</option></select>`):''}
    ${fld('pjNotes','Notes',`<textarea id="pjNotes" rows="3">${esc(d.notes||'')}</textarea>`,true)}</div>`,saveFoot(!!p));
  wireContactSelect(f,'pjC');
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this project?','Only an empty project can be deleted. Mark it done to keep its history.','Delete'))return;if(await del('projects',p.id)){closeModal();S.param=null;renderMain();toast('Project deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');const name=$('#pjName',f).value.trim();if(!name)return f.err('Give the project a name.');
    let cid=$('#pjC',f).value;if(cid==='__new'){cid=await resolveContact(f,'pjC','customer');if(!cid)return}
    const id=p?p.id:uid();
    if(await put('projects',id,{name,contactId:cid||'',budget:$('#pjBudget',f).value,start:$('#pjStart',f).value,end:$('#pjEnd',f).value,status:$('#pjStatus',f)?.value||d.status||'active',notes:$('#pjNotes',f).value.trim(),created:p?.created||Date.now()})){closeModal();if(!p){S.view='projects';S.param=id}renderMain();toast(p?'Project saved':`${name} created`)}};
}

/* ---------- time ---------- */
function vTime(){
  const P=S.proj,staff=ME&&ME.role!=='client'&&!ME.readOnly;
  const people=[...new Set(S.times.map(t=>t.who))].sort();
  const list=S.times.filter(t=>(!P.who||t.who===P.who)&&(!P.cust||t.contactId===P.cust)&&(!P.unbilled||(t.billable&&!timeBilled(t)))).sort((a,b)=>b.date.localeCompare(a.date)||(b.created||0)-(a.created||0));
  // This week, Monday to Sunday, by person.
  const t0=pd(today()),mon=iso(new Date(t0.getFullYear(),t0.getMonth(),t0.getDate()-((t0.getDay()+6)%7))),days=Array.from({length:7},(_,i)=>addDays(mon,i));
  const week={};for(const t of S.times)if(t.date>=days[0]&&t.date<=days[6]){(week[t.who]=week[t.who]||Array(7).fill(0))[days.indexOf(t.date)]+=+t.hours||0}
  const wd=d=>pd(d).toLocaleDateString(LOC(),{weekday:'short',day:'numeric'});
  const ub=S.times.filter(t=>t.billable&&!timeBilled(t));
  return `<div class="chips"><div class="chip"><div class="lbl">Hours this week</div><div class="val">${r2(Object.values(week).flat().reduce((s,x)=>s+x,0))}</div></div><div class="chip"><div class="lbl">Billable, not billed</div><div class="val">${money(r2(ub.reduce((s,t)=>s+timeValue(t),0)))}</div><div class="lbl">${r2(ub.reduce((s,t)=>s+(+t.hours||0),0))} h</div></div></div>
  ${Object.keys(week).length?`<div class="panel" style="margin-bottom:16px"><h3>This week</h3><div class="tbl-wrap"><table><thead><tr><th>Who</th>${days.map(d=>`<th class="n">${esc(wd(d))}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>${Object.entries(week).map(([w,h])=>`<tr><td translate="no">${esc(w)}</td>${h.map(x=>`<td class="n">${x?r2(x):'<span class="muted">—</span>'}</td>`).join('')}<td class="n"><b>${r2(h.reduce((s,x)=>s+x,0))}</b></td></tr>`).join('')}</tbody></table></div></div>`:''}
  <div class="panel"><div class="toolbar"><select id="tmWho" aria-label="Who"><option value="">${T('Everyone')}</option>${people.map(w=>`<option ${P.who===w?'selected':''}>${esc(w)}</option>`).join('')}</select><select id="tmCust" aria-label="Customer"><option value="">${T('All customers')}</option>${S.contacts.filter(c=>c.kind==='customer').sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${esc(c.id)}" ${P.cust===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select><label class="check"><input type="checkbox" id="tmUnb" ${P.unbilled?'checked':''}> <span>Not billed only</span></label><span class="grow"></span></div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Who</th><th>Customer · project</th><th>Description</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Value</th><th></th></tr></thead><tbody>${list.length?list.slice(0,shownCount('time',list.length)).map(t=>`<tr class="click" data-time="${esc(t.id)}"><td style="white-space:nowrap">${fmtDate(t.date)}</td><td translate="no">${esc(t.who)}</td><td class="trunc" translate="no">${esc([contactName(t.contactId),projName(t.projectId)].filter(Boolean).join(' · ')||'—')}</td><td class="trunc" translate="no">${esc(t.desc||(S.items.find(i=>i.id===t.itemId)||{}).name||'')}</td><td class="n">${t.hours}</td><td class="n">${t.billable?money(t.rate):'<span class="muted">—</span>'}</td><td class="n">${t.billable?money(timeValue(t)):'<span class="muted">—</span>'}</td><td>${timeBilled(t)?'<span class="pill paid">Billed</span>':t.billable?'<span class="pill open">Not billed</span>':'<span class="pill quiet">Not billable</span>'}</td></tr>`).join('')+moreRow('time',shownCount('time',list.length),list.length,8):emptyRow(8,S.times.length?'Nothing matches':'No time yet','Add the hours someone worked, for a customer or a project. Billable time can go straight onto an invoice.')}</tbody></table></div></div>`;
}
function timeForm(t,preset){
  const staff=ME&&ME.role!=='client'&&!ME.readOnly,billed=t&&timeBilled(t);
  const last=S.times.slice().sort((a,b)=>(b.created||0)-(a.created||0))[0]||{};
  const d=t||{date:today(),who:last.who||ME.name||'',contactId:'',projectId:'',itemId:'',hours:'',rate:'',cost:last.who===(last.who||ME.name)?last.cost||'':'',billable:true,desc:'',...(preset||{})};
  if(!t&&d.projectId&&!d.contactId)d.contactId=(projById(d.projectId)||{}).contactId||'';
  const people=[...new Set(S.times.map(x=>x.who).concat(S.employees.map(e=>e.name)).filter(Boolean))].sort();
  const services=S.items.filter(i=>i.sold!==false&&i.active!==false&&i.type!=='inventory').sort((a,b)=>a.name.localeCompare(b.name));
  const f=openModal(t?'Time':'Add time',`${billed?'<div class="banner" style="margin:0"><span>This time is on an invoice. Delete the invoice to change it.</span></div>':''}<div class="fields">
    ${fld('tmDate','Date',`<input type="date" id="tmDate" value="${esc(d.date)}">`)}
    ${fld('tmWho2','Who',`<input type="text" id="tmWho2" list="tmPeople" maxlength="80" value="${esc(d.who)}"><datalist id="tmPeople">${people.map(p=>`<option value="${esc(p)}">`).join('')}</datalist>`)}
    ${fld('tmC','Customer',`<select id="tmC"><option value="">${T('None')}</option>${S.contacts.filter(c=>c.kind==='customer').sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${esc(c.id)}" ${c.id===d.contactId?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`)}
    ${fld('tmP','Project',`<select id="tmP"></select>`)}
    ${services.length?fld('tmItem','Service',`<select id="tmItem"><option value="">—</option>${services.map(i=>`<option value="${esc(i.id)}" ${i.id===d.itemId?'selected':''}>${esc(i.name)}</option>`).join('')}</select>`):''}
    ${fld('tmHours','Hours',`<input type="number" id="tmHours" step="0.25" min="0" max="24" inputmode="decimal" value="${esc(d.hours)}">`)}
    ${fld('tmDesc','Description',`<input type="text" id="tmDesc" maxlength="500" value="${esc(d.desc||'')}">`,true)}
    </div><label class="check"><input type="checkbox" id="tmBill" ${d.billable?'checked':''}> <span>Billable to the customer</span></label>
    <div class="fields">${fld('tmRate','Rate per hour (billed)',`<input type="number" id="tmRate" step="0.01" min="0" value="${esc(d.rate??'')}">`)}${fld('tmCost','Cost per hour (optional)',`<input type="number" id="tmCost" step="0.01" min="0" value="${esc(d.cost??'')}"><span class="hint">What the hour costs you, so project profit includes labour.</span>`)}</div>`,
    staff&&!billed?saveFoot(!!t):'<button type="button" class="btn" data-close>Close</button>');
  const fillProj=()=>{const c=$('#tmC',f).value,cur=$('#tmP',f).value||d.projectId;const ps=S.projects.filter(p=>(p.status!=='done'||p.id===cur)&&(!c||!p.contactId||p.contactId===c)).sort((a,b)=>a.name.localeCompare(b.name));$('#tmP',f).innerHTML=`<option value="">${T('No project')}</option>`+ps.map(p=>`<option value="${esc(p.id)}" ${p.id===cur?'selected':''}>${esc(p.name)}</option>`).join('')};
  fillProj();$('#tmC',f).onchange=fillProj;
  $('#tmP',f).onchange=()=>{const p=projById($('#tmP',f).value);if(p&&p.contactId&&!$('#tmC',f).value){$('#tmC',f).value=p.contactId;fillProj()}};
  const it=$('#tmItem',f);if(it)it.onchange=()=>{const i=S.items.find(x=>x.id===it.value);if(i&&i.price!==''&&i.price!=null)$('#tmRate',f).value=i.price;if(i&&!$('#tmDesc',f).value)$('#tmDesc',f).value=i.desc||''};
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this time?','It’s taken out of the timesheet.','Delete'))return;if(await del('times',t.id)){closeModal();toast('Time deleted')}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');if(!staff||billed)return;
    const hours=+$('#tmHours',f).value;if(!(hours>0))return f.err('Enter the hours worked.');
    const who=$('#tmWho2',f).value.trim();if(!who)return f.err('Enter who did the work.');
    const bill=$('#tmBill',f).checked;if(bill&&!$('#tmC',f).value)return f.err('Choose the customer to bill, or untick billable.');
    if(await put('times',t?t.id:uid(),{date:$('#tmDate',f).value||today(),who,contactId:$('#tmC',f).value,projectId:$('#tmP',f).value,itemId:it?it.value:'',hours,rate:$('#tmRate',f).value,cost:$('#tmCost',f).value,billable:bill,desc:$('#tmDesc',f).value.trim(),invoiceId:t?.invoiceId&&timeBilled(t)?t.invoiceId:'',created:t?.created||Date.now()})){closeModal();toast(t?'Time saved':`${hours} h added`)}};
}
/** Pick a customer, then make an invoice from their billable time that isn't billed yet. */
function billTimeForm(contactId,projectId){
  const ub=S.times.filter(t=>t.billable&&!timeBilled(t)&&t.contactId);
  const custs=[...new Set(ub.map(t=>t.contactId))];
  if(!custs.length){toast('There’s no billable time waiting to be billed.',true);return}
  const f=openModal('Bill time',`<div class="fields">${fld('btC','Customer',`<select id="btC">${custs.map(c=>`<option value="${esc(c)}" ${c===contactId?'selected':''}>${esc(contactName(c))}</option>`).join('')}</select>`)}${fld('btTo','Time up to',`<input type="date" id="btTo" value="${esc(today())}">`)}</div><div data-btlist></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Make invoice</button>`,'wide');
  const draw=()=>{const c=$('#btC',f).value,to=$('#btTo',f).value||today();const ts=ub.filter(t=>t.contactId===c&&t.date<=to&&(!projectId||t.projectId===projectId)).sort((a,b)=>a.date.localeCompare(b.date));
    $('[data-btlist]',f).innerHTML=`<div class="tbl-wrap"><table><thead><tr><th><input type="checkbox" data-btall checked aria-label="All"></th><th>Date</th><th>Who</th><th>Project · description</th><th class="n">Hours</th><th class="n">Value</th></tr></thead><tbody>${ts.map(t=>`<tr><td><input type="checkbox" data-btpick="${esc(t.id)}" checked aria-label="Bill"></td><td style="white-space:nowrap">${fmtDate(t.date)}</td><td translate="no">${esc(t.who)}</td><td class="trunc" translate="no">${esc([projName(t.projectId),t.desc].filter(Boolean).join(' · '))}</td><td class="n">${t.hours}</td><td class="n">${money(timeValue(t))}</td></tr>`).join('')||`<tr><td colspan="6" class="muted">${T('Nothing to bill up to that date.')}</td></tr>`}</tbody></table></div>`;
    const a=$('[data-btall]',f);if(a)a.onchange=()=>$$('[data-btpick]',f).forEach(x=>x.checked=a.checked)};
  $('#btC',f).onchange=$('#btTo',f).onchange=draw;draw();
  f.onsubmit=e=>{e.preventDefault();const ids=$$('[data-btpick]',f).filter(x=>x.checked).map(x=>x.dataset.btpick);if(!ids.length)return f.err('Pick the time to bill.');
    const ts=ids.map(id=>S.times.find(t=>t.id===id)),c=$('#btC',f).value;
    const defInc=(sortAccts(S.accounts.filter(a=>a.type==='Income'&&a.active!==false))[0]||{}).id||'';
    const lines=ts.map(t=>{const it=S.items.find(i=>i.id===t.itemId);return{item:it?it.id:'',desc:`${fmtDate(t.date)} · ${t.who}${t.desc?' · '+t.desc:it?' · '+it.name:''}`,account:(it&&it.incomeAccount)||defInc,qty:t.hours,rate:t.rate,taxCode:contact(c)?.taxCode||(it&&it.taxCode)||'std'}});
    const projs=[...new Set(ts.map(t=>t.projectId).filter(Boolean))];
    closeModal();
    docForm('invoice',null,{contactId:c,lines,...(projs.length===1?{proj:projs[0]}:{}),note:`<div class="banner" style="margin:0"><span>${ts.length} time entr${ts.length===1?'y':'ies'}</span> · <span>${r2(ts.reduce((s,t)=>s+(+t.hours||0),0))} h</span>. <span>Check the lines, then save. The time is marked billed.</span></div>`,
      onSaved:async id=>{await batch(ts.map(t=>({op:'set',collection:'times',id:t.id,data:{...strip(t),invoiceId:id}})));toast('Invoice saved and the time marked billed')}});
  };
}

function projectsClick(e,t,d){
  if(S.view!=='projects')return false;
  if(d.ptab){S.proj.tab=d.ptab;S.param=null;renderMain();return true}
  if(t.hasAttribute('data-projback')){S.param=null;renderMain();return true}
  if(d.proj==='new'){projectForm(null);return true}
  if(d.proj&&d.proj.startsWith('edit:')){projectForm(projById(d.proj.slice(5)));return true}
  if(d.proj){S.param=d.proj;renderMain();window.scrollTo(0,0);return true}
  if(d.time!==undefined){timeForm(d.time?S.times.find(x=>x.id===d.time):null,d.timeproj?{projectId:d.timeproj}:null);return true}
  if(d.billtime!==undefined){billTimeForm(d.billtime,d.billproj||'');return true}
  return false;
}
function bindProjects(m){
  if(S.view!=='projects')return;
  const sh=$('#projShow',m);if(sh)sh.onchange=()=>{S.proj.show=sh.value;renderMain()};
  const w=$('#tmWho',m);if(w)w.onchange=()=>{S.proj.who=w.value;renderMain()};
  const c=$('#tmCust',m);if(c)c.onchange=()=>{S.proj.cust=c.value;renderMain()};
  const u=$('#tmUnb',m);if(u)u.onchange=()=>{S.proj.unbilled=u.checked;renderMain()};
}
