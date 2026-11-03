'use strict';
let risePanelData = null, risePanelLoading = false;
function risePanel() {
  if (!ME || ME.role !== 'owner') return '';
  if (!risePanelData || risePanelData.cid !== CO) {
    if (!risePanelLoading) {
      risePanelLoading = true; const cid = CO;
      Promise.all([api('GET', '/api/rise'), api('GET', '/api/c/rise')]).then(([admin, company]) => {
        if (CO === cid) risePanelData = { cid, admin, company };
      }).catch(e => { if (CO === cid) risePanelData = { cid, error: e.message }; }).finally(() => { risePanelLoading = false; if (S.view === 'settings' && CO === cid) renderMain(); });
    }
    return '<div class="panel"><h3>Rise payroll connection</h3><p>Loading connection settings…</p></div>';
  }
  if(risePanelData.error)return `<div class="panel"><h3>Rise payroll connection</h3><p>${esc(risePanelData.error)}</p><button class="btn" data-riseact="retry">Try again</button></div>`;
  const {admin:a, company:c} = risePanelData;
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Rise payroll connection · Read-only pilot</h3><div class="pad">
    <p>Connect this company to Rise to check employee names and available reports. This pilot does not submit payroll or post journal entries.</p>
    ${a.admin ? `<p>Register a <b>Public</b> OAuth application in Rise with <b>reports:read</b>. Callback: <span class="mono">${esc(a.redirectUri || 'Set the server public URL first')}</span></p>
    <label>Rise client ID <input id="riseClientId" type="text" autocomplete="off" placeholder="${esc(a.clientIdHint || '')}"></label> <button class="btn" data-riseact="save">Save application</button>
    <p>Enable access only for selected companies:</p>${a.companies.filter(x=>!x.archived).map(x=>`<p>${esc(x.name)} <button class="btn sm" data-riseact="toggle" data-risecid="${esc(x.id)}" data-riseon="${x.enabled?'false':'true'}">${x.enabled?'Disable':'Enable'}</button></p>`).join('')}` : ''}
    <p>This company: <b>${c.enabled ? (c.connected ? 'Connected' : 'Not connected') : 'Disabled by administrator'}</b></p>
    ${c.enabled && a.configured ? `<button class="btn primary" data-riseact="connect">${c.connected?'Reconnect':'Connect to Rise'}</button>` : ''}
    ${c.connected?'<button class="btn" data-riseact="preview">Check connection</button> <button class="btn ghost" data-riseact="disconnect">Disconnect</button>':''}
    ${risePanelData.preview?`<h4>Employees (first 100)</h4><ul>${risePanelData.preview.employees.map(x=>`<li>${esc(x.name)} · ${esc(x.status)}</li>`).join('')}</ul><h4>Available reports (first 100)</h4><ul>${risePanelData.preview.reports.map(x=>`<li>${esc(x.title || x.id)}</li>`).join('')}</ul>${risePanelData.preview.partial?'<p>More records exist in Rise. This is a limited preview.</p>':''}`:''}
    </div></div>`;
}
async function riseAction(act, d) {
  const cid = CO;
  try {
    if(act==='retry'){risePanelData=null;renderMain();return;}
    if(act==='save') { const clientId=$('#riseClientId').value.trim(); if(!clientId)return toast('Enter the Rise client ID.',true); await api('PUT','/api/rise',{clientId}); }
    else if(act==='toggle') await api('PUT','/api/rise/companies/'+encodeURIComponent(d.risecid),{enabled:d.riseon==='true'});
    else if(act==='connect') {
      if(!await confirmBox('Connect this company to Rise?', 'Sign in to the Rise account belonging to '+S.company.name+'. Confirm the employer before allowing access.','Continue'))return;
      if(CO!==cid)return;
      const r=await api('POST','/api/c/rise/connect',{confirmCompany:true});
      location.assign(r.url); return;
    } else if(act==='disconnect') {
      const r=await api('DELETE','/api/c/rise');
      if(!r.revoked)toast('Disconnected locally. Revoke the application in Rise as well.',true);
    } else if(act==='preview') {
      const r=await api('GET','/api/c/rise/preview');
      if(CO===cid && risePanelData?.cid===cid){risePanelData.preview=r;renderMain();} return;
    }
    risePanelData=null;renderMain();
  } catch(e) { toast(e.message,true); }
}
