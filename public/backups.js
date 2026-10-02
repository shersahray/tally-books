'use strict';
/* ---------- Automatic backups panel (shared by the company list and Settings) ---------- */
let BK=null,bkEditing=false,bkBusy=false,bkTried=0;
async function loadBackups(){try{BK=await api('GET','/api/backups');BK._t=Date.now()}catch(e){BK=null}}
const fmtWhen=ms=>new Date(ms).toLocaleString(LOC(),{dateStyle:'medium',timeStyle:'short'});

function backupStatusLine(){
  if(!BK)return '';
  if(!BK.enabled)return `<span class="pill overdue">Off</span> <span class="neg">Automatic backups are turned off. If this computer fails, your clients’ books could be lost.</span>`;
  if(BK.lastError)return `<span class="pill overdue">Problem</span> <span class="neg">${esc(BK.lastError)}</span>`;
  if(!BK.lastRun)return `<span class="pill partial">Waiting</span> The first backup runs within a minute of starting Tally Books, or click Back up now.`;
  const off=BK.offsite?(BK.offsite.lastRun?` · off-site copy in ${esc(BK.offsite.where)} ${fmtWhen(BK.offsite.lastRun)}`:` · off-site copy to ${esc(BK.offsite.where)} after the next backup`):'';
  return `<span class="pill paid">On</span> Last backup ${fmtWhen(BK.lastRun)} · ${BK.lastCount} compan${BK.lastCount===1?'y':'ies'}${off}`;
}
function backupPanel(){
  if(!BK||BK.hidden)return '';
  const keep=[7,14,30,90,365];
  if(typeof ME!=='undefined'&&ME&&!(ME.role==='owner'&&ME.platformAdmin))return `<div class="panel" style="max-width:760px;margin-top:16px"><h3>Automatic backups</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px"><div>${backupStatusLine()}</div><div class="muted" style="font-size:13px">${ME.role==='owner'?'The server’s administrator manages backups.':'An owner manages backups.'}</div></div></div>`;
  return `<div class="panel" style="max-width:760px;margin-top:16px"><h3>Automatic backups</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div>${backupStatusLine()}</div>
    <div class="fields">
      <div class="field" style="grid-column:1/-1"><span class="flabel">Saved to</span><div class="mono" style="word-break:break-all">${esc(BK.target)}</div></div>
      <div class="field"><label for="bkKeep">Keep backups for</label><select id="bkKeep">${keep.map(d=>`<option value="${d}" ${BK.keepDays===d?'selected':''}>${d} days</option>`).join('')}${keep.includes(BK.keepDays)?'':`<option selected value="${BK.keepDays}">${BK.keepDays} days</option>`}</select></div>
      <div class="field"><span class="flabel">Status</span><label class="check" style="padding-top:6px"><input type="checkbox" id="bkOn" ${BK.enabled?'checked':''}> Back up every day</label></div>
    </div>
    ${bkEditing?`<div style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:12px">
      <span class="flabel">Choose where backups go</span>
      <div class="actions">${BK.suggestions.map(s=>`<button class="btn sm" data-bkfolder="${esc(s.path)}">${esc(s.label)}</button>`).join('')}</div>
      <input type="text" id="bkFolder" value="${esc(BK.folder)}" aria-label="Backup folder">
      <span class="hint muted" style="font-size:12.5px">Pick a folder that syncs to the cloud, such as OneDrive or Google Drive, so a copy survives if this computer is lost. A “Tally Books Backups” folder is created inside it.</span>
      <div class="actions"><button class="btn sm primary" data-bkact="save-folder">Save folder</button><button class="btn sm" data-bkact="cancel-folder">Cancel</button></div>
    </div>`:''}
    <div class="actions">
      <button class="btn primary" data-bkact="run" ${bkBusy?'disabled':''}>${bkBusy?'Backing up…':'Back up now'}</button>
      ${bkEditing?'':'<button class="btn" data-bkact="edit-folder">Change folder</button>'}
      <button class="btn ghost" data-bkact="open">Open backup folder</button>
    </div>
    <div class="muted" style="font-size:13px">Tally Books backs up every company once a day while it’s open, into a dated folder, and removes backups older than the period above. To bring a client back, open that company, go to <b>Settings → Restore from backup</b>, and choose its file from the dated folder.</div>
  </div></div>`;
}
async function bkAction(act,d){
  try{
    if(d.bkfolder){$('#bkFolder').value=d.bkfolder;return}
    if(act==='edit-folder'){bkEditing=true;renderMain();$('#bkFolder')?.focus();return}
    if(act==='cancel-folder'){bkEditing=false;renderMain();return}
    if(act==='save-folder'){BK=await api('PUT','/api/backups',{folder:$('#bkFolder').value});BK._t=Date.now();bkEditing=false;renderMain();toast('Backup folder saved');return}
    if(act==='open'){const r=await api('POST','/api/backups/open');toast(`Opening ${r.path}`);return}
    if(act==='run'){bkBusy=true;renderMain();const r=await api('POST','/api/backups/run');BK=r.status;BK._t=Date.now();bkBusy=false;renderMain();toast(`Backed up ${r.count} compan${r.count===1?'y':'ies'}`);return}
  }catch(e){bkBusy=false;await loadBackups();renderMain();toast(e.message,true)}
}
function bindBackups(m){
  if((S.view==='settings'||S.view==='companies')&&Date.now()-bkTried>30000&&(bkTried=Date.now()))loadBackups().then(()=>{if(S.view==='settings'||S.view==='companies')renderMain()});
  const on=$('#bkOn',m);if(on)on.onchange=async()=>{try{BK=await api('PUT','/api/backups',{enabled:on.checked});BK._t=Date.now();renderMain();toast(on.checked?'Automatic backups on':'Automatic backups off')}catch(e){toast(e.message,true)}};
  const keep=$('#bkKeep',m);if(keep)keep.onchange=async()=>{try{BK=await api('PUT','/api/backups',{keepDays:+keep.value});BK._t=Date.now();toast(`Keeping ${keep.value} days of backups`)}catch(e){toast(e.message,true)}};
}
