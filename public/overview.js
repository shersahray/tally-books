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

function vOverview(){
  const back=`<button class="btn ghost sm" data-back-co style="margin-bottom:8px">← Companies</button>`;
  if(!ME||!ME.platformAdmin)return back+head('Overview','')+'<div class="panel"><div class="empty"><b>Administrators only</b>Only the server’s administrator sees the overview.</div></div>';
  if(!OVW)return back+head('Overview','Loading…');
  const F=OVW.firms,Li=OVW.licences,D=OVW_DL,today=isoDay(new Date());
  const dlVal=!D?'…':D.error?'—':ovNum(D.totals.installs);
  let h=back+head('Overview','Everyone using Sumlora: firms on this server, desktop licences you’ve sold, and installer downloads.',`<button class="btn" data-ov="refresh">Refresh</button>`);
  h+=`<div class="tiles">
    ${ovTile('Firms using your server',ovNum(F.active),F.pending?`<span class="pill partial">${ovNum(F.pending)} waiting for approval</span>`:`${ovNum(F.newThisMonth)} new this month`)}
    ${ovTile('People with accounts',ovNum(F.people),`${ovNum(F.companies)} companies`)}
    ${ovTile('Desktop licences',Li&&!Li.noKey?ovNum(Li.active):'—',Li&&!Li.noKey?(Li.endingSoon?`${ovNum(Li.endingSoon)} ending in 30 days`:'None ending soon'):'Make codes under Licence codes')}
    ${ovTile('Installer downloads',dlVal,D&&!D.error?'All versions, from GitHub':D&&D.error?'GitHub didn’t answer':'Checking GitHub…')}
  </div>`;
  // Renewals due: the list to act on.
  if(Li&&!Li.noKey&&Li.due.length)h+=`<div class="panel" style="margin-bottom:16px"><h3>Renewals due</h3><div class="tbl-wrap"><table><thead><tr><th>Client</th><th>Plan</th><th>Last day</th><th></th><th></th></tr></thead><tbody>${Li.due.map(l=>{const days=Math.round((pd(l.until)-pd(today))/864e5);
    return `<tr><td><b translate="no">${esc(l.name)}</b>${l.email?`<div class="muted" style="font-size:12px" translate="no">${esc(l.email)}</div>`:''}</td><td>${esc(T(TallyPlans.PLANS[TallyPlans.planOf(l.plan)].label))}</td><td>${esc(fmtDate(l.until))}</td>
      <td>${days<0?`<span class="pill overdue">Ended ${-days} days ago</span>`:days===0?'<span class="pill partial">Ends today</span>':`<span class="pill partial">${days} days left</span>`}</td>
      <td style="text-align:right"><button class="btn sm" data-ov="renew" data-id="${esc(l.id)}">Renew</button></td></tr>`}).join('')}</tbody></table></div></div>`;
  h+=`<div class="ov-grid">`;
  // Firms
  h+=`<div class="panel"><h3>Firms on your server</h3><div class="pad" style="display:flex;flex-direction:column;gap:8px;font-size:14px">
    <div><span>Active:</span> <b>${ovNum(F.active)}</b> · <span>Waiting for approval:</span> <b>${ovNum(F.pending)}</b> · <span>Suspended:</span> <b>${ovNum(F.suspended)}</b></div>
    <div><span>Active firms by plan:</span> ${ovPlans(F.byPlan)}</div>
    <div><span>Signed in during the last 30 days:</span> <b>${ovNum(F.activeLast30)}</b> · <span>New this month:</span> <b>${ovNum(F.newThisMonth)}</b></div>
    ${F.recent.length?`<div class="muted" style="font-size:12.5px;margin-top:4px">Newest firms</div><div>${F.recent.map(f=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid var(--line)"><span translate="no">${esc(f.name)}</span><span class="muted" style="font-size:12.5px;white-space:nowrap">${esc(fmtDate(isoDay(new Date(f.created))))}</span></div>`).join('')}</div>`:'<div class="muted">No other firms yet. When firms sign up on your online server, they show here.</div>'}
    <div><button class="btn sm" data-ov="firms">Manage firms</button></div></div></div>`;
  // Licences
  h+=`<div class="panel"><h3>Desktop licences</h3><div class="pad" style="display:flex;flex-direction:column;gap:8px;font-size:14px">${
    !Li?'<div class="muted">Licence codes are made in your own copy of Sumlora.</div>'
    :Li.noKey?'<div class="muted">You haven’t created your licence key yet. Go to Licence codes to set it up.</div><div><button class="btn sm" data-ov="licences">Licence codes</button></div>'
    :`<div><span>Active:</span> <b>${ovNum(Li.active)}</b> · <span>Ending in 30 days:</span> <b>${ovNum(Li.endingSoon)}</b> · <span>Ended:</span> <b>${ovNum(Li.ended)}</b></div>
      <div><span>Active licences by plan:</span> ${ovPlans(Li.byPlan)}</div>
      ${Li.byKind?`<div><span>Firms:</span> <b>${ovNum(Li.byKind.firm)}</b> · <span>Single businesses:</span> <b>${ovNum(Li.byKind.business)}</b></div>`:''}
      <div><span>Codes made in total:</span> <b>${ovNum(Li.made)}</b></div>
      <div class="muted" style="font-size:12.5px">Desktop copies don’t report back, so this counts the licences you’ve sold, not who’s using them right now.</div>
      <div><button class="btn sm" data-ov="licences">Licence codes</button></div>`}</div></div>`;
  // Downloads
  h+=`<div class="panel"><h3>Installer downloads</h3><div class="pad" style="display:flex;flex-direction:column;gap:8px;font-size:14px">${
    !D?'<div class="muted">Checking GitHub…</div>':D.error?`<div class="muted">${esc(D.error)}</div>`
    :!D.releases.length?'<div class="muted">No releases published yet.</div>'
    :`<div><span>Windows:</span> <b>${ovNum(D.totals.windows)}</b> · <span>Mac:</span> <b>${ovNum(D.totals.mac)}</b> · <span>Linux:</span> <b>${ovNum(D.totals.linux)}</b></div>
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
function bindOverview(m){
  m.onclick=async e=>{const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-back-co'))return showCompanies();
    const a=b.dataset.ov;
    if(a==='refresh')return showOverview();
    if(a==='firms')return showFirms();
    if(a==='licences'){LIC_FORM=null;return showLicences()}
    if(a==='renew'){const l=OVW.licences.due.find(x=>x.id===b.dataset.id);if(l)return renewLicence(l)}
  };
}
