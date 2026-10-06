'use strict';
/* ---------- Bank feeds (Plaid) ----------
   A bookkeeper connects a client's bank once, in Plaid's own sign-in window: Sumlora never sees the bank password.
   Each bank account is matched to a bank or credit card account in the chart of accounts, with the date to start
   from. New transactions then arrive in Banking → For review every few hours (and on "Sync now"), where they're
   reviewed like imported lines. The Plaid keys and the bank's access tokens stay on the server. */
let PLD=null,pldTried=0,feedsAutoAt=0;
async function loadPlaid(){try{PLD=await api('GET','/api/plaid')}catch(e){PLD={configured:false,unavailable:true}}}
const feedsOn=()=>!!(PLD&&PLD.configured&&ME&&ME.role!=='client');

/** Banking header button. */
function feedsButton(){return feedsOn()?'<button class="btn" data-feed="open">Bank feeds</button>':''}

/** Load Plaid's sign-in script only when someone connects a bank. */
let plaidScript=null;
function plaidLoaded(){
  if(window.Plaid)return Promise.resolve();
  if(plaidScript)return plaidScript;
  plaidScript=new Promise((ok,fail)=>{const s=document.createElement('script');s.src='https://cdn.plaid.com/link/v2/stable/link-initialize.js';s.onload=()=>ok();s.onerror=()=>{plaidScript=null;fail(new Error('Couldn’t open Plaid’s bank sign-in. Check the internet connection and try again.'))};document.head.appendChild(s)});
  return plaidScript;
}
/** Open Plaid's window. Resolves with { publicToken, institution } on success, or null when the person closes it. */
async function plaidOpen(itemId){
  const {linkToken}=await api('POST','/api/feeds/link',{itemId:itemId||'',lang:I18N.lang});
  await plaidLoaded();
  return new Promise(resolve=>{
    const h=window.Plaid.create({token:linkToken,
      onSuccess:(publicToken,meta)=>{resolve({publicToken,institution:{name:(meta&&meta.institution&&meta.institution.name)||''}});try{h.destroy()}catch(e){}},
      onExit:(err)=>{resolve(err?{error:err.display_message||err.error_message||'The bank sign-in didn’t finish.'}:null);try{h.destroy()}catch(e){}}});
    h.open();
  });
}

/** Where a bank account's lines should start: the day after the last line already in that Sumlora account, or 3 months ago. */
function feedStartFor(acctId){
  const last=S.bankTxns.filter(b=>b.account===acctId).reduce((m,b)=>b.date>m?b.date:m,'');
  if(last)return addDays(last,1);
  const d=pd(today());d.setMonth(d.getMonth()-3);d.setDate(1);return iso(d);
}

const feedStatus=it=>it.status==='login'?'<span class="pill overdue">Sign in again</span>':it.status==='error'?'<span class="pill partial">Problem</span>':'<span class="pill paid">Connected</span>';
const ago=ms=>{if(!ms)return 'Not synced yet';const m=Math.round((Date.now()-ms)/60000);return m<1?'Synced just now':m<60?`Synced ${m} min ago`:m<1440?`Synced ${Math.round(m/60)} h ago`:`Synced ${fmtDate(iso(new Date(ms)))}`};

async function feedsForm(){
  let r;
  try{r=await api('GET','/api/feeds')}catch(e){return toast(e.message,true)}
  const items=r.items||[];
  const banks=S.accounts.filter(a=>(a.detail==='bank'||a.detail==='card')&&a.active!==false&&!a.stripe);
  const usedBy={};items.forEach(it=>Object.entries(it.links).forEach(([k,v])=>{usedBy[v]=it.id+'|'+k}));
  const row=(it,a)=>{
    const cur=it.links[a.id]||'';
    const opts=`<option value="">Don’t bring in</option>${banks.map(b=>{const taken=usedBy[b.id]&&usedBy[b.id]!==it.id+'|'+a.id;return `<option value="${b.id}" ${cur===b.id?'selected':''} ${taken?'disabled':''}>${esc((b.code?b.code+' · ':'')+b.name)}${taken?' (already fed)':''}</option>`}).join('')}`;
    return `<tr><td><b translate="no">${esc(a.name)}</b>${a.mask?` <span class="muted mono">••${esc(a.mask)}</span>`:''}${a.currency&&a.currency!=='CAD'?` <span class="pill quiet">${esc(a.currency)}</span>`:''}</td>
      <td><select data-flink="${it.id}|${a.id}" aria-label="Sumlora account for ${esc(a.name)}">${opts}</select></td>
      <td><input type="date" data-fstart="${it.id}|${a.id}" value="${esc(it.starts[a.id]||(cur?feedStartFor(cur):''))}" aria-label="Bring in from" ${cur?'':'disabled'}></td></tr>`;
  };
  const card=it=>`<div class="panel" style="margin:0 0 12px" data-fitem="${it.id}"><div class="toolbar"><b translate="no">${esc(it.institution)}</b> ${feedStatus(it)}<span class="muted" style="font-size:13px">${ago(it.lastSync)}</span><span class="grow"></span>
      ${it.status==='login'?`<button type="button" class="btn sm primary" data-fdo="relink" data-fid="${it.id}">Sign in again</button>`:`<button type="button" class="btn sm" data-fdo="sync" data-fid="${it.id}">Sync now</button>`}
      <button type="button" class="btn sm ghost" data-fdo="remove" data-fid="${it.id}">Disconnect</button></div>
    ${it.error?`<div class="banner err" style="margin:0 12px 8px">${esc(it.error)}</div>`:''}
    <div class="tbl-wrap"><table><thead><tr><th>Bank account</th><th>Goes into</th><th>Bring in from</th></tr></thead><tbody>${it.accounts.map(a=>row(it,a)).join('')}</tbody></table></div>
    <div class="pad" style="padding-top:8px"><button type="button" class="btn sm" data-fdo="save" data-fid="${it.id}">Save</button></div></div>`;
  const f=openModal('Bank feeds',`<div class="muted" style="font-size:13px">Connect this company’s bank once, and new transactions arrive in <b>For review</b> every few hours. You sign in to the bank in Plaid’s secure window; Sumlora never sees the bank password. Nothing goes into the books until you review it. A bank line that matches one already imported from a statement (same account and amount, within 3 days) isn’t added twice.</div>
    ${banks.length?'':'<div class="banner err">Add a bank or credit card account in the chart of accounts first.</div>'}
    <div style="margin-top:12px">${items.length?items.map(card).join(''):'<div class="empty"><b>No banks connected yet</b>Connect a bank to start.</div>'}</div>`,
    `<button type="button" class="btn" data-close>Close</button><button type="button" class="btn primary" data-fdo="connect" ${banks.length?'':'disabled'}>Connect a bank</button>`,'wide');
  $$('[data-flink]',f).forEach(sel=>sel.onchange=()=>{const inp=$(`[data-fstart="${sel.dataset.flink}"]`,f);inp.disabled=!sel.value;if(sel.value&&!inp.value)inp.value=feedStartFor(sel.value)});
  f.onclick=async e=>{
    const b=e.target.closest('[data-fdo]');if(!b)return;
    const id=b.dataset.fid,act=b.dataset.fdo;
    f.err('');b.disabled=true;
    try{
      if(act==='connect'){
        const res=await plaidOpen();
        if(res&&res.error)throw new Error(res.error);
        if(res){await api('POST','/api/feeds',res);toast('Bank connected. Choose where each account goes, then Save.');return feedsForm()}
      }
      if(act==='relink'){
        const res=await plaidOpen(id);
        if(res&&res.error)throw new Error(res.error);
        if(res){await api('POST',`/api/feeds/${id}/reconnected`,{});await feedSync(id,true);return feedsForm()}
      }
      if(act==='save'){
        const links={},starts={};
        $$(`[data-flink^="${id}|"]`,f).forEach(sel=>{const a=sel.dataset.flink.split('|')[1];if(sel.value){links[a]=sel.value;const v=$(`[data-fstart="${sel.dataset.flink}"]`,f).value;if(v)starts[a]=v}});
        await api('PUT',`/api/feeds/${id}`,{links,starts});
        toast('Saved. Bringing in transactions…');await feedSync(id,true);return feedsForm();
      }
      if(act==='sync'){await feedSync(id,true);return feedsForm()}
      if(act==='remove'){
        if(!await confirmBox('Disconnect this bank?','New transactions stop coming in, and the connection’s monthly charge stops. Lines already brought in stay in Banking.','Disconnect'))return;
        const r=await api('DELETE',`/api/feeds/${id}`);
        if(r.warning)toast(r.warning,true);else toast('Bank disconnected');
        return feedsForm();
      }
    }catch(err){f.err(err.message)}finally{b.disabled=false}
  };
}
/** Sync one connection now. With `say`, tell the person what came in. */
async function feedSync(id,say){
  const r=await api('POST',`/api/feeds/${id}/sync`,{});
  await load();
  if(say)toast(r.busy?'Already syncing. Try again in a moment.':r.added?`${r.added} new bank line${r.added===1?'':'s'} in For review`:'No new transactions');
  return r;
}
/** Opening Banking: bring in anything new from connections that haven't synced for an hour (at most every 15 minutes). */
async function feedsAuto(){
  if(!feedsOn()||Date.now()-feedsAutoAt<15*60000)return;
  feedsAutoAt=Date.now();
  try{
    const r=await api('GET','/api/feeds');
    for(const it of r.items||[])if(it.status==='ok'&&Object.keys(it.links).length&&Date.now()-(it.lastSync||0)>3600000)await feedSync(it.id,false).catch(()=>{});
  }catch(e){/* shown on the Bank feeds window instead */}
}
function feedAction(act){if(act==='open')return feedsForm()}
function bindFeeds(){
  if((S.view==='banking'||S.view==='settings')&&Date.now()-pldTried>60000&&(pldTried=Date.now()))loadPlaid().then(()=>{if(S.view==='banking'||S.view==='settings')renderMain();if(S.view==='banking')feedsAuto()});
  else if(S.view==='banking')feedsAuto();
}

/* ---------- Settings: the server's Plaid keys (administrator only) ---------- */
function plaidPanel(){
  if(!PLD||PLD.unavailable||!PLD.admin)return '';
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Bank feeds (Plaid)</h3><div class="pad" style="display:flex;flex-direction:column;gap:14px">
    <div class="muted" style="font-size:13px">Bank feeds bring transactions in from clients’ banks automatically, through Plaid. Create an account at dashboard.plaid.com, then copy the keys from Developers → Keys. Plaid charges for each connected bank account each month. The keys stay on this server and are never shown again.</div>
    <div>${PLD.configured?`<span class="pill paid">Ready</span> ${PLD.env==='production'?'Production (real banks)':'Sandbox (test banks)'} · client ID <span class="mono" translate="no">${esc(PLD.clientIdHint||'')}</span> </div><div class="muted" style="font-size:13px">Bank connections: ${PLD.connections} · Bank accounts fed: ${PLD.accounts}`:'<span class="pill partial">Not set up</span> Add your Plaid keys to turn on bank feeds.'}</div>
    ${PLD.source==='env'?'<div class="muted">The keys are set on the server.</div>':`<div class="fields">
      ${fld('plId','Client ID',`<input type="text" id="plId" autocomplete="off" spellcheck="false" translate="no" placeholder="${PLD.configured?'Leave blank to keep it':''}">`)}
      ${fld('plSecret','Secret',`<input type="password" id="plSecret" autocomplete="off" spellcheck="false" translate="no" placeholder="${PLD.configured?'Leave blank to keep it':''}">`)}
      ${fld('plEnv','Environment',`<select id="plEnv"><option value="sandbox" ${PLD.env!=='production'?'selected':''}>Sandbox (test banks)</option><option value="production" ${PLD.env==='production'?'selected':''}>Production (real banks)</option></select><span class="hint">The secret is different for each. Switch only when no bank is connected.</span>`)}
    </div>
    <div class="actions"><button class="btn primary" data-plact="save">Save bank feed settings</button>${PLD.configured?'<button class="btn ghost" data-plact="remove">Remove keys</button>':''}</div>`}
  </div></div>`;
}
async function plaidAction(act){
  try{
    if(act==='save'){
      const body={env:$('#plEnv').value};const id=$('#plId').value.trim(),sec=$('#plSecret').value.trim();
      if(id)body.clientId=id;if(sec)body.secret=sec;
      if(!PLD.configured&&(!id||!sec))return toast('Enter both the client ID and the secret.',true);
      PLD={...await api('PUT','/api/plaid',body),admin:true};renderMain();toast('Bank feed settings saved');return;
    }
    if(act==='remove'){
      if(!await confirmBox('Remove the Plaid keys?','Bank feeds stop for every company until keys are added again. Connected banks stay connected at Plaid (and keep their monthly charge) until they’re disconnected.','Remove keys'))return;
      PLD={...await api('PUT','/api/plaid',{clientId:'',secret:''}),admin:true};renderMain();toast('Plaid keys removed');return;
    }
  }catch(e){toast(e.message,true)}
}
