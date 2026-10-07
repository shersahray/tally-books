'use strict';
/* The administrator's Overview: who uses Sumlora. Firms on this server, desktop licences sold, renewals due,
   installer downloads (GitHub's public counts) and AI use. Desktop copies don't report back, so they're
   counted by the licences sold and the downloads, not by who's using them. */

let OVW=null,OVW_DL=null;

async function showOverview(){
  S.view='overview';OVW=null;OVW_DL=null;renderMain();
  try{OVW=await api('GET','/api/overview')}catch(e){toast(e.message,true)}
  if(S.view==='overview')renderMain();
  try{OVW_DL=await api('GET','/api/overview/downloads')}catch(e){OVW_DL={error:e.message}}
  if(S.view==='overview')renderMain();
}
const ovNum=n=>Number(n||0).toLocaleString(LOC());
const ovUsd=n=>Number(n||0).toLocaleString(LOC(),{style:'currency',currency:'USD'});
const ovTile=(lbl,val,note)=>`<div class="tile"><span class="lbl">${esc(lbl)}</span><span class="val">${val}</span>${note?`<span class="note">${note}</span>`:''}</div>`;
const ovPlans=bp=>Object.entries(TallyPlans.PLANS).map(([k,p])=>`<span>${esc(T(p.label))}:</span> <b>${ovNum(bp&&bp[k])}</b>`).join(' · ');

const ovMoney=n=>Number(n||0).toLocaleString(LOC(),{style:'currency',currency:'CAD'});
const ovInitials=s=>String(s||'?').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';
const ovDays=ms=>Math.ceil((ms-Date.now())/864e5);
const ovGreet=()=>{const h=new Date().getHours();return h<12?'Good morning':h<18?'Good afternoon':'Good evening'};
const OV_ICON={
  subs:'<path d="M4 7h16M4 12h16M4 17h10"/>',
  pay:'<circle cx="12" cy="12" r="8"/><path d="M9 12.5l2 2 4-4.5"/>',
  due:'<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>',
  lic:'<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h5M8 14h8"/>',
  firm:'<path d="M4 20V8l8-4 8 4v12M9 20v-6h6v6"/>',
  biz:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>'};
const ovIco=k=>`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${OV_ICON[k]}</svg>`;
const ovKpi=(icon,tone,lbl,val,note)=>`<div class="ov-kpi ${tone}"><span class="ov-kpi-ico">${ovIco(icon)}</span><div class="ov-kpi-body"><span class="lbl">${esc(lbl)}</span><span class="val">${val}</span>${note?`<span class="note">${note}</span>`:''}</div></div>`;
const OV_STATE={active:['paid','Paying'],trialing:['open','Free trial'],pastdue:['overdue','Payment failed'],stopped:['quiet','Stopped'],none:['quiet','Not started']};
const ovKind=r=>r.kind==='firm'?'<span class="ov-tag">Firm</span>':'<span class="ov-tag biz">Business</span>';
function ovWhat(r){
  const d=ovDays(r.next),when=r.next?fmtDate(isoDay(new Date(r.next))):'';
  if(r.state==='pastdue'){const g=ovDays(r.graceUntil);return [`Card was declined${r.graceUntil?` · access stops ${esc(fmtDate(isoDay(new Date(r.graceUntil))))}`:''}`,`<span class="pill overdue">${g>0?`${g} day${g===1?'':'s'} to fix`:'Fix now'}</span>`]}
  const chip=d<=0?'<span class="pill partial">Today</span>':`<span class="pill ${d<=2?'partial':'open'}">In ${d} day${d===1?'':'s'}</span>`;
  if(r.state==='trialing')return [`Trial ends ${esc(when)} · first charge <b translate="no">${ovMoney(r.monthly)}</b>`,chip];
  if(r.cancelAtEnd)return [`Cancelled · ends ${esc(when)}`,chip];
  return [`Renews ${esc(when)} · <b translate="no">${ovMoney(r.monthly)}</b>`,chip];
}
function ovMix(s){
  const parts=[['active','Paying',s.paying,'var(--pos)'],['trialing','Free trial',s.trial,'var(--info)'],['pastdue','Payment failed',s.failed,'var(--neg)'],['none','Not started',s.notStarted,'var(--line-strong)'],['stopped','Stopped',s.stopped,'var(--muted)']].filter(p=>p[2]);
  const tot=parts.reduce((t,p)=>t+p[2],0);
  if(!tot)return '<div class="muted">No subscriptions yet. Invite a firm or a business to get started.</div>';
  return `<div class="ov-bar" role="img" aria-label="${esc(parts.map(p=>`${p[1]}: ${p[2]}`).join(', '))}">${parts.map(p=>`<span style="flex:${p[2]};background:${p[3]}" title="${esc(T(p[1]))}: ${p[2]}"></span>`).join('')}</div>
    <div class="ov-legend">${parts.map(p=>`<span><i style="background:${p[3]}"></i>${esc(T(p[1]))} <b>${ovNum(p[2])}</b></span>`).join('')}</div>`;
}
function vOverview(){
  const back=`<button class="btn ghost sm" data-back-co style="margin-bottom:8px">← Companies</button>`;
  if(!ME||!ME.platformAdmin)return back+head('Overview','')+'<div class="panel"><div class="empty"><b>Administrators only</b>Only the server’s administrator sees the overview.</div></div>';
  if(!OVW)return back+head('Overview','Loading…');
  const F=OVW.firms,Li=OVW.licences,D=OVW_DL,Su=OVW.subs,today=isoDay(new Date());
  const first=String(ME.name||'').split(' ')[0];
  let h=back;
  // Hero: the month's subscription income and the two invite buttons.
  h+=`<section class="ov-hero">
    <div class="ov-hero-main">
      <div class="ov-hello">${esc(T(ovGreet()))}${first?`, <span translate="no">${esc(first)}</span>`:''}</div>
      <h1>Sumlora overview</h1>
      ${Su?`<div class="ov-hero-num"><span class="ov-big" translate="no">${ovMoney(Su.monthly)}</span><span class="ov-per">a month from paying subscriptions</span></div>
        <div class="ov-hero-sub">${Su.trialMonthly?`<span>+ <b translate="no">${ovMoney(Su.trialMonthly)}</b> a month when today’s free trials start paying</span>`:'<span>No free trials running right now</span>'}</div>`
      :`<div class="ov-hero-sub">Online subscriptions are off. Add your Stripe key under Firms to charge firms and businesses monthly.</div>`}
    </div>
    <div class="ov-hero-actions">
      <button class="btn ov-cta" data-ov="invite-firm">${ovIco('firm')}<span>Invite a firm</span></button>
      <button class="btn ov-cta" data-ov="invite-biz">${ovIco('biz')}<span>Invite a business</span></button>
      <button class="btn ov-ghost" data-ov="refresh">Refresh</button>
    </div>
  </section>`;
  // KPI row
  const dueN=Su?Su.due.length:0;
  h+=`<div class="ov-kpis">
    ${ovKpi('subs','teal','Online subscriptions',Su?ovNum(Su.firms+Su.companies):'—',Su?`${ovNum(Su.firms)} firm${Su.firms===1?'':'s'} · ${ovNum(Su.companies)} business${Su.companies===1?'':'es'}`:'Subscriptions are off')}
    ${ovKpi('pay','green','Paying now',Su?ovNum(Su.paying):'—',Su?`${ovNum(Su.trial)} on a free trial`:'')}
    ${ovKpi('due',Su&&Su.failed?'red':'amber','Due in the next 7 days',Su?ovNum(dueN):'—',Su?(Su.failed?`<span class="neg">${ovNum(Su.failed)} payment${Su.failed===1?'':'s'} failed</span>`:'No failed payments'):'')}
    ${ovKpi('lic','navy','Desktop licences',Li&&!Li.noKey?ovNum(Li.active):'—',Li&&!Li.noKey?(Li.endingSoon?`${ovNum(Li.endingSoon)} ending in 30 days`:'None ending soon'):'Make codes under Licence codes')}
  </div>`;
  if(Su){
    // Due soon + mix
    h+=`<div class="ov-grid ov-grid-due">
      <div class="panel"><h3><span>Due to pay soon</span><span class="muted" style="font-weight:400;font-size:12.5px">Next 7 days and failed payments</span></h3>
        ${Su.due.length?`<ul class="ov-list">${Su.due.map(r=>{const [what,chip]=ovWhat(r);return `<li><span class="ov-av ${r.kind}">${esc(ovInitials(r.name))}</span><div class="ov-li-main"><div><b translate="no">${esc(r.name)}</b> ${ovKind(r)} <span class="muted" style="font-size:12.5px">${esc(T(TallyPlans.PLANS[r.plan].label))}${r.kind==='firm'?` · ${r.quantity} compan${r.quantity===1?'y':'ies'}`:''}</span></div><div class="muted" style="font-size:12.5px">${what}${r.firm?` · <span translate="no">${esc(r.firm)}</span>`:''}</div></div>${chip}</li>`}).join('')}</ul>`
        :'<div class="pad"><div class="ov-calm">Nothing due in the next 7 days, and no failed payments.</div></div>'}
      </div>
      <div class="panel"><h3>Subscriptions at a glance</h3><div class="pad">${ovMix(Su)}
        ${Su.waiting.length?`<div class="ov-sub-h">Invited, not started yet</div><ul class="ov-mini">${Su.waiting.map(r=>`<li><span translate="no">${esc(r.name)}</span>${ovKind(r)}</li>`).join('')}</ul><div class="muted" style="font-size:12.5px">They start their subscription (and free trial) the first time they sign in.</div>`:''}
      </div></div>
    </div>`;
    // Everyone subscribed
    if(Su.rows.length)h+=`<div class="panel" style="margin-bottom:16px"><h3><span>All online subscriptions</span><span class="muted" style="font-weight:400;font-size:12.5px">${ovNum(Su.rows.length)}</span></h3><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Plan</th><th class="n">A month</th><th>Status</th><th>Next payment</th></tr></thead><tbody>${Su.rows.map(r=>{const st=OV_STATE[r.state]||OV_STATE.none;
      return `<tr><td><b translate="no">${esc(r.name)}</b>${r.firm?`<div class="muted" style="font-size:12px" translate="no">${esc(r.firm)}</div>`:''}</td><td>${ovKind(r)}</td><td>${esc(T(TallyPlans.PLANS[r.plan].label))}${r.kind==='firm'?` <span class="muted">× ${r.quantity}</span>`:''}</td><td class="n" translate="no">${ovMoney(r.monthly)}</td><td><span class="pill ${st[0]}">${esc(T(st[1]))}</span>${r.cancelAtEnd?' <span class="pill quiet">Cancelling</span>':''}</td><td class="muted">${r.next?esc(fmtDate(isoDay(new Date(r.next)))):'—'}</td></tr>`}).join('')}</tbody></table></div></div>`;
  }
  // Renewals due: desktop licences.
  if(Li&&!Li.noKey&&Li.due.length)h+=`<div class="panel" style="margin-bottom:16px"><h3>Desktop licence renewals due</h3><div class="tbl-wrap"><table><thead><tr><th>Client</th><th>Plan</th><th>Last day</th><th></th><th></th></tr></thead><tbody>${Li.due.map(l=>{const days=Math.round((pd(l.until)-pd(today))/864e5);
    return `<tr><td><b translate="no">${esc(l.name)}</b>${l.email?`<div class="muted" style="font-size:12px" translate="no">${esc(l.email)}</div>`:''}</td><td>${esc(T(TallyPlans.PLANS[TallyPlans.planOf(l.plan)].label))}</td><td>${esc(fmtDate(l.until))}</td>
      <td>${days<0?`<span class="pill overdue">Ended ${-days} days ago</span>`:days===0?'<span class="pill partial">Ends today</span>':`<span class="pill partial">${days} days left</span>`}</td>
      <td style="text-align:right"><button class="btn sm" data-ov="renew" data-id="${esc(l.id)}">Renew</button></td></tr>`}).join('')}</tbody></table></div></div>`;
  h+=`<div class="ov-grid">`;
  // Firms
  h+=`<div class="panel"><h3>Firms on your server</h3><div class="pad" style="display:flex;flex-direction:column;gap:8px;font-size:14px">
    <div class="ov-stats"><div><b>${ovNum(F.active)}</b><span>Active</span></div><div><b>${ovNum(F.pending)}</b><span>Waiting for approval</span></div><div><b>${ovNum(F.people)}</b><span>People</span></div><div><b>${ovNum(F.companies)}</b><span>Companies</span></div></div>
    <div><span>Active firms by plan:</span> ${ovPlans(F.byPlan)}</div>
    <div><span>Signed in during the last 30 days:</span> <b>${ovNum(F.activeLast30)}</b> · <span>New this month:</span> <b>${ovNum(F.newThisMonth)}</b></div>
    ${F.recent.length?`<div class="muted" style="font-size:12.5px;margin-top:4px">Newest firms</div><div>${F.recent.map(f=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid var(--line)"><span translate="no">${esc(f.name)}</span><span class="muted" style="font-size:12.5px;white-space:nowrap">${esc(fmtDate(isoDay(new Date(f.created))))}</span></div>`).join('')}</div>`:'<div class="muted">No other firms yet. Use “Invite a firm” above to add one.</div>'}
    <div class="actions" style="justify-content:flex-start"><button class="btn sm" data-ov="firms">Manage firms</button><button class="btn sm" data-ov="invite-firm">Invite a firm</button></div></div></div>`;
  // Licences
  h+=`<div class="panel"><h3>Desktop licences</h3><div class="pad" style="display:flex;flex-direction:column;gap:8px;font-size:14px">${
    !Li?'<div class="muted">Licence codes are made in your own copy of Sumlora.</div>'
    :Li.noKey?'<div class="muted">You haven’t created your licence key yet. Go to Licence codes to set it up.</div><div><button class="btn sm" data-ov="licences">Licence codes</button></div>'
    :`<div class="ov-stats"><div><b>${ovNum(Li.active)}</b><span>Active</span></div><div><b>${ovNum(Li.endingSoon)}</b><span>Ending in 30 days</span></div><div><b>${ovNum(Li.ended)}</b><span>Ended</span></div><div><b>${ovNum(Li.made)}</b><span>Codes made</span></div></div>
      <div><span>Active licences by plan:</span> ${ovPlans(Li.byPlan)}</div>
      ${Li.byKind?`<div><span>Firms:</span> <b>${ovNum(Li.byKind.firm)}</b> · <span>Single businesses:</span> <b>${ovNum(Li.byKind.business)}</b></div>`:''}
      <div class="muted" style="font-size:12.5px">Desktop copies don’t report back, so this counts the licences you’ve sold, not who’s using them right now.</div>
      <div><button class="btn sm" data-ov="licences">Licence codes</button></div>`}</div></div>`;
  // Downloads
  h+=`<div class="panel"><h3>Installer downloads</h3><div class="pad" style="display:flex;flex-direction:column;gap:8px;font-size:14px">${
    !D?'<div class="muted">Checking GitHub…</div>':D.error?`<div class="muted">${esc(D.error)}</div>`
    :!D.releases.length?'<div class="muted">No releases published yet.</div>'
    :`<div class="ov-stats"><div><b>${ovNum(D.totals.installs)}</b><span>All downloads</span></div><div><b>${ovNum(D.totals.windows)}</b><span>Windows</span></div><div><b>${ovNum(D.totals.mac)}</b><span>Mac</span></div><div><b>${ovNum(D.totals.linux)}</b><span>Linux</span></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>Version</th><th>Published</th><th class="n">Installer downloads</th></tr></thead><tbody>${D.releases.slice(0,8).map(r=>`<tr><td><b translate="no">${esc(r.tag)}</b>${r.prerelease?' <span class="pill quiet">Pre-release</span>':''}</td><td class="muted">${r.published?esc(fmtDate(r.published.slice(0,10))):''}</td><td class="n">${ovNum(r.installs)}</td></tr>`).join('')}</tbody></table></div>
      <div class="muted" style="font-size:12.5px">GitHub counts every download of an installer, including your own. Automatic updates are counted too, so one computer can count more than once.</div>`}</div></div>`;
  // AI
  h+=`<div class="panel"><h3>AI suggestions this month</h3><div class="pad" style="display:flex;flex-direction:column;gap:8px;font-size:14px">
    <div><span>Spent across all firms:</span> <b translate="no">${ovUsd(OVW.ai.totalUsd)}</b></div>
    ${OVW.ai.top.length?`<div>${OVW.ai.top.map(f=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid var(--line)"><span translate="no">${esc(f.name)}</span><span translate="no">${ovUsd(f.usd)}</span></div>`).join('')}</div>`:'<div class="muted">No AI use this month.</div>'}
  </div></div>`;
  h+=`</div>`;
  return h;
}

/* ---------- Invite a firm, or a single business, in one step ---------- */
const ovPlanOpts=(sel)=>Object.entries(TallyPlans.PLANS).map(([k,p])=>`<option value="${k}" ${k===sel?'selected':''}>${esc(T(p.label))}${typeof BILL!=='undefined'&&BILL&&BILL.configured?`: ${planPrice(BILL,k)} a company, monthly`:''}</option>`).join('');
async function ovReady(){if(typeof loadBillMe==='function'&&(typeof BILL==='undefined'||!BILL))await loadBillMe();if(!Object.keys(PROVS||{}).length){try{await loadCompanies()}catch(e){}}}
async function inviteFirmForm(after){
  await ovReady();
  const f=openModal('Invite a firm',`<div class="muted" style="margin-bottom:10px">The firm is set up straight away. You get a link to send its owner, who chooses a password${typeof BILL!=='undefined'&&BILL&&BILL.configured?' and starts the firm’s subscription (with the free trial)':''} the first time they sign in.</div>
    <div class="fields">
    ${fld('ivFirm','Firm name','<input type="text" id="ivFirm" maxlength="120" autocomplete="off">',true)}
    ${fld('ivName','Owner’s name','<input type="text" id="ivName" maxlength="80" autocomplete="off">')}
    ${fld('ivEmail','Owner’s email','<input type="email" id="ivEmail" autocapitalize="none" spellcheck="false" autocomplete="off">')}
    ${fld('ivPlan','Plan',`<select id="ivPlan">${ovPlanOpts(FIRMS&&FIRMS.defaultPlan||'essentials')}</select>`,true)}
    </div>`,`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Invite and get link</button>`);
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    try{const r=await api('POST','/api/firms/invite',{firmName:$('#ivFirm',f).value,name:$('#ivName',f).value,email:$('#ivEmail',f).value,plan:$('#ivPlan',f).value});
      closeModal();if(after)await after();showLink(r.user,r.user.link,'invite',{firm:r.firm.name});toast(`${r.firm.name} is set up`)}
    catch(ex){f.err(ex.message)}};
}
async function inviteBusinessForm(after){
  await ovReady();
  const paid=typeof BILL!=='undefined'&&BILL&&BILL.configured;
  const f=openModal('Invite a business',`<div class="muted" style="margin-bottom:10px">For a business that keeps its own books in Sumlora. This makes its company and sends its owner a link to sign in${paid?'. They pay for their own subscription, after the free trial':''}.</div>
    <div class="fields">
    ${fld('ibName','Business name','<input type="text" id="ibName" maxlength="120" autocomplete="off">',true)}
    ${fld('ibProv','Province',`<select id="ibProv">${provinceOptions('ON')}</select>`,true)}
    ${fld('ibPerson','Owner’s name','<input type="text" id="ibPerson" maxlength="80" autocomplete="off">')}
    ${fld('ibEmail','Owner’s email','<input type="email" id="ibEmail" autocapitalize="none" spellcheck="false" autocomplete="off">')}
    ${paid?fld('ibPlan','Plan they pay for',`<select id="ibPlan">${ovPlanOpts('essentials')}</select>`,true):''}
    </div>
    ${paid?'<label class="check"><input type="checkbox" id="ibFree"> My firm pays for this one instead (they don’t pay Sumlora)</label>':''}`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Invite and get link</button>`);
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const free=$('#ibFree',f);
    try{const r=await api('POST','/api/companies/invite',{name:$('#ibName',f).value,province:$('#ibProv',f).value,person:$('#ibPerson',f).value,email:$('#ibEmail',f).value,plan:($('#ibPlan',f)||{}).value,clientPays:!(free&&free.checked)});
      closeModal();try{await loadCompanies()}catch(_){}if(after)await after();showLink(r.user,r.user.link,'invite',{business:r.company.name,pays:r.clientPays});toast(`${r.company.name} is set up`)}
    catch(ex){f.err(ex.message)}};
}
function bindOverview(m){
  m.onclick=async e=>{const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-back-co'))return showCompanies();
    const a=b.dataset.ov;
    if(a==='refresh')return showOverview();
    if(a==='firms')return showFirms();
    if(a==='licences'){LIC_FORM=null;return showLicences()}
    if(a==='invite-firm')return inviteFirmForm(showOverview);
    if(a==='invite-biz')return inviteBusinessForm(showOverview);
    if(a==='renew'){const l=OVW.licences.due.find(x=>x.id===b.dataset.id);if(l)return renewLicence(l)}
  };
}
