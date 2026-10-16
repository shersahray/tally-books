'use strict';
/* ---------- Year-end files: the trial balance from QuickBooks Online or Xero ----------
 * For a client whose books are kept in QuickBooks Online or Xero: connect their file once (they or the firm sign in there
 * and allow read-only access), and a year-end file brings in the trial balance at the year-end and the prior year-end,
 * with each account's type. "Bring in again" refreshes it when the client's bookkeeper makes changes. Nothing is ever
 * changed in the client's books.
 */
let YF_LDG=null,YF_LDG_AT=0,YF_LDG_CO='';
const YF_LDG_NAMES={qbo:'QuickBooks Online',xero:'Xero'};
yfSrcLabel.qbo='QuickBooks Online';yfSrcLabel.xero='Xero';
const yfFromLedger=f=>!!(f&&f.snapshot&&YF_LDG_NAMES[f.snapshot.source]);
async function yfLedgerLoad(force){
  if(!force&&YF_LDG&&YF_LDG_CO===CO&&Date.now()-YF_LDG_AT<60000)return YF_LDG;
  const co=CO;
  try{YF_LDG=await api('GET','/api/ledger')}catch(e){YF_LDG={configured:{},connected:false,error:e.message}}
  YF_LDG_AT=Date.now();YF_LDG_CO=co;return YF_LDG;
}
/** The connection: who it's with, or buttons to connect. */
function yfLedgerBox(st){
  if(!st)return `<div class="muted">${esc(T('Checking…'))}</div>`;
  if(st.connected)return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="pill paid">${esc(T('Connected'))}</span> <span>${esc(st.providerName)}${st.name?' · <span translate="no">'+esc(st.name)+'</span>':''}</span> <button type="button" class="btn sm ghost" data-yfldgoff>${esc(T('Disconnect'))}</button></div>`;
  const any=st.configured&&(st.configured.qbo||st.configured.xero);
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${['qbo','xero'].map(p=>`<button type="button" class="btn sm" data-yfldgon="${p}" ${st.configured&&st.configured[p]?'':'disabled'}>${esc(T('Connect'))} ${esc(YF_LDG_NAMES[p])}</button>`).join('')}</div><div class="muted" style="font-size:12.5px;margin-top:4px">${esc(T(any?'Sign in to the client’s books there and allow Sumlora to read them. Sumlora only reads; it never changes anything there.':'The server’s administrator adds the QuickBooks Online and Xero app keys in Settings first.'))}</div>`;
}
/** Start connecting: the sign-in opens in a new tab, and this tab checks back until the connection is made. */
let YF_LDG_POLL=0;
async function yfLedgerConnect(p,onChange){
  const w=window.open('about:blank','_blank');
  let r;
  try{r=await api('POST','/api/ledger/connect',{provider:p})}catch(err){if(w)w.close();toast(err.message,true);return}
  if(w){try{w.opener=null}catch{}w.location.href=r.url}else{location.href=r.url;return}
  toast(`Sign in to ${YF_LDG_NAMES[p]} in the new tab, then come back here`);
  clearInterval(YF_LDG_POLL);const until=Date.now()+15*60*1000;
  YF_LDG_POLL=setInterval(async()=>{
    if(Date.now()>until){clearInterval(YF_LDG_POLL);return}
    const st=await yfLedgerLoad(true);
    if(st.connected){clearInterval(YF_LDG_POLL);toast(`Connected to ${st.providerName}`);onChange&&onChange(st)}
  },3000);
}
async function yfLedgerDisconnect(onChange){
  const st=YF_LDG||{};
  if(!await confirmBox(`Disconnect ${st.providerName||'the books'}?`,'Year-end files keep the trial balance they already brought in. Connect again to bring it in again.','Disconnect'))return;
  try{YF_LDG=await api('DELETE','/api/ledger');YF_LDG_AT=Date.now();toast('Disconnected');onChange&&onChange(YF_LDG)}catch(err){toast(err.message,true)}
}
/**
 * The trial balance there for the year ending ye, with the prior year: snapshot lines (debits positive), each account the
 * file's own ("x:qbo-…" or "x:xero-…"); retained earnings is the opening retained earnings line. old: the file's lines
 * now, whose GIFI codes and details are kept.
 */
async function yfLedgerLines(ye,old=[]){
  const st=await yfLedgerLoad(true);
  if(!st.connected)throw new Error('Connect QuickBooks Online or Xero first.');
  const pe=addDays(fyStartOf(ye),-1);
  const get=(s,e)=>api('GET',`/api/ledger/tb?start=${s}&end=${e}`);
  const [cur,pri]=await Promise.all([get(fyStartOf(ye),ye),get(fyStartOf(pe),pe)]);
  const keep=new Map(old.map(l=>[l.account,l])),by=new Map();
  for(const [col,res] of [['cur',cur],['prior',pri]]){let reUsed=false;
    for(const l of res.lines){
      const account=l.retained&&!reUsed?(reUsed=true,TallyEngage.RE_OPEN):yfOwnId(cur.provider+'-'+l.id);
      const k=keep.get(account)||{};
      const x=by.get(account)||{account,code:l.code||'',name:l.name,type:l.type,detail:l.detail||k.detail||'',gifi:k.gifi||'',cur:0,prior:0};
      x[col]=r2(x[col]+l.amount);by.set(account,x);
    }}
  return{lines:[...by.values()],provider:cur.provider,name:cur.name||'',providerName:cur.providerName};
}
/** On the trial balance tab of a file from QuickBooks Online or Xero: when it was brought in, and bring it in again. */
function yfLedgerBar(f,edit){
  if(!yfFromLedger(f))return'';
  const s=f.snapshot,st=YF_LDG&&YF_LDG_CO===CO?YF_LDG:null;
  if(!st)yfLedgerLoad().then(()=>{if(YF.open===f.id&&YF.tab==='tb')renderMain()});
  const same=st&&st.connected&&st.provider===s.source;
  return `<div class="panel" style="margin-bottom:12px"><div class="toolbar"><span class="grow">${esc(T('From'))} <b>${esc(YF_LDG_NAMES[s.source])}</b>${s.ledgerName?' · <span translate="no">'+esc(s.ledgerName)+'</span>':''}${s.pulledAt?` · ${esc(T('brought in'))} ${esc(fmtDate(new Date(s.pulledAt).toISOString().slice(0,10)))}`:''}</span>${edit&&!yfFinal(f)?(same?`<button class="btn sm primary" data-yfldgpull>${esc(T('Bring in again'))}</button>`:''):''}</div>${edit&&!yfFinal(f)&&st&&!same?`<div class="pad">${st.connected?`<div class="muted" style="margin-bottom:6px">${esc(T('This company is now connected to'))} ${esc(st.providerName)}.</div>`:''}${yfLedgerBox(st)}</div>`:''}</div>`;
}
async function yfLedgerClick(e,t,d,f){
  const redraw=()=>renderMain();
  if(d.yfldgon!==undefined){yfLedgerConnect(d.yfldgon,redraw);return true}
  if(t.hasAttribute('data-yfldgoff')){yfLedgerDisconnect(redraw);return true}
  if(t.hasAttribute('data-yfldgpull')){
    if(!await confirmBox(`Bring the trial balance in again from ${YF_LDG_NAMES[f.snapshot.source]}?`,'This year’s and last year’s balances are replaced with what’s there now. Mapping, GIFI codes, adjusting entries and working papers stay. A working paper whose figures change goes back for review.','Bring in again'))return true;
    t.disabled=true;
    try{const r=await yfLedgerLines(f.yearEnd,f.snapshot.lines);
      const was=new Map(f.snapshot.lines.map(l=>[l.account,l]));
      // Accounts used on an adjusting entry stay, even at nil, so the entry still has its account.
      for(const j of f.ajes||[])for(const l of j.lines)if(!r.lines.some(x=>x.account===l.account)&&was.get(l.account))r.lines.push({...was.get(l.account),cur:0,prior:0});
      const changed=new Set(r.lines.filter(l=>{const o=was.get(l.account);return!o||r2(o.cur-l.cur)||r2(o.prior-l.prior)}).map(l=>TallyEngage.leadOf(f,l)));
      for(const l of f.snapshot.lines)if(!r.lines.some(x=>x.account===l.account))changed.add(TallyEngage.leadOf(f,l));
      const wps={...(f.wps||{})};let undone=0;
      for(const k of changed)if(wps[k]&&wps[k].reviewed){wps[k]={...wps[k],reviewed:null,status:'progress'};undone++}
      if(await yfSave(f,{wps,snapshot:{...f.snapshot,lines:r.lines,takenAt:Date.now(),by:ME?ME.name:'',pulledAt:Date.now(),ledgerName:r.name,priorSource:'books'}}))toast(`Trial balance brought in again (${r.lines.length} accounts)`+(undone?`. ${undone} working paper${undone===1?'':'s'} back for review.`:''));
    }catch(err){toast(err.message,true);t.disabled=false}
    return true}
  return false;
}
/** In the new-file form: the connection box when "QuickBooks Online or Xero" is chosen. */
function yfLedgerFormBind(m){
  const box=$('[data-yfldgbox]',m);if(!box)return;
  const draw=st=>{box.innerHTML=yfLedgerBox(st)};
  $('#yfSrc',m).addEventListener('change',async()=>{box.hidden=$('#yfSrc',m).value!=='ledger';if(!box.hidden){draw(null);draw(await yfLedgerLoad(true))}});
  box.addEventListener('click',e=>{const b=e.target.closest('[data-yfldgon],[data-yfldgoff]');if(!b||b.disabled)return;
    if(b.dataset.yfldgon)yfLedgerConnect(b.dataset.yfldgon,draw);else yfLedgerDisconnect(draw)});
}

/* ---------- Settings (the server's administrator): the QuickBooks Online and Xero app keys ---------- */
let LDG_ADMIN=null,ldgTried=0;
function ledgerPanel(){
  if(!ME||ME.role!=='owner'||!ME.platformAdmin||(typeof feat==='function'&&!feat('yearEndFiles')))return'';
  if(!LDG_ADMIN){if(Date.now()-ldgTried>60000){ldgTried=Date.now();api('GET','/api/ledgers').then(r=>{LDG_ADMIN=r;if(S.view==='settings')renderMain()}).catch(()=>{})}return''}
  if(!LDG_ADMIN.admin)return'';
  const L=LDG_ADMIN,st=p=>L[p].configured?`<span class="pill paid">${esc(T('Ready'))}</span> ${esc(T('client ID'))} <span class="mono" translate="no">${esc(L[p].clientIdHint||'')}</span>`:`<span class="pill partial">${esc(T('Not set up'))}</span>`;
  const keep=p=>L[p].configured?esc(T('Leave blank to keep it')):'';
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>${esc(T('QuickBooks Online and Xero'))}</h3><div class="pad" style="display:flex;flex-direction:column;gap:14px">
    <div class="muted" style="font-size:13px">${esc(T('For year-end files of clients whose books are in QuickBooks Online or Xero: Sumlora brings their trial balance in directly, read-only. Create an app at developer.intuit.com and at developer.xero.com, add this redirect address to each, and enter the app’s keys here. The keys stay on this server.'))}</div>
    <div>${esc(T('Redirect address'))}: ${L.redirectUri?`<span class="mono" translate="no">${esc(L.redirectUri)}</span>`:`<span class="muted">${esc(T('Set this server’s web address with the email settings first.'))}</span>`}</div>
    <div><b>QuickBooks Online</b> · ${st('qbo')}</div>
    <div class="fields">${fld('ldQId','Client ID',`<input type="text" id="ldQId" autocomplete="off" spellcheck="false" translate="no" placeholder="${keep('qbo')}">`)}${fld('ldQSec','Client secret',`<input type="password" id="ldQSec" autocomplete="off" spellcheck="false" translate="no" placeholder="${keep('qbo')}">`)}${fld('ldQEnv','Environment',`<select id="ldQEnv"><option value="production" ${L.qbo.env!=='sandbox'?'selected':''}>${esc(T('Production (real companies)'))}</option><option value="sandbox" ${L.qbo.env==='sandbox'?'selected':''}>${esc(T('Sandbox (test companies)'))}</option></select>`)}</div>
    <div><b>Xero</b> · ${st('xero')}</div>
    <div class="fields">${fld('ldXId','Client ID',`<input type="text" id="ldXId" autocomplete="off" spellcheck="false" translate="no" placeholder="${keep('xero')}">`)}${fld('ldXSec','Client secret',`<input type="password" id="ldXSec" autocomplete="off" spellcheck="false" translate="no" placeholder="${keep('xero')}">`)}</div>
    <div class="actions"><button class="btn primary" data-ldact="save">${esc(T('Save QuickBooks Online and Xero settings'))}</button>${L.qbo.configured?`<button class="btn ghost" data-ldact="rmqbo">${esc(T('Remove QuickBooks keys'))}</button>`:''}${L.xero.configured?`<button class="btn ghost" data-ldact="rmxero">${esc(T('Remove Xero keys'))}</button>`:''}</div>
    <div class="muted" style="font-size:12.5px">${esc(T('Companies connected'))}: ${L.connections}</div>
  </div></div>`;
}
async function ledgerAction(act){
  try{
    let body;
    if(act==='save'){
      const v=id=>$('#'+id).value.trim(),q={env:$('#ldQEnv').value},x={};
      if(v('ldQId'))q.clientId=v('ldQId');if(v('ldQSec'))q.secret=v('ldQSec');
      if(v('ldXId'))x.clientId=v('ldXId');if(v('ldXSec'))x.secret=v('ldXSec');
      for(const [p,o] of [['qbo',q],['xero',x]])if(!LDG_ADMIN[p].configured&&(!!o.clientId!==!!o.secret))return toast(`Enter both the client ID and the secret for ${YF_LDG_NAMES[p]}.`,true);
      body={qbo:q,...(Object.keys(x).length?{xero:x}:{})};
    }
    if(act==='rmqbo'||act==='rmxero'){const p=act==='rmqbo'?'qbo':'xero';
      if(!await confirmBox(`Remove the ${YF_LDG_NAMES[p]} keys?`,'Year-end files keep the trial balances already brought in, but can’t bring them in again until keys are added.','Remove keys'))return;
      body={[p]:{clientId:'',secret:''}}}
    if(!body)return;
    LDG_ADMIN=await api('PUT','/api/ledgers',body);YF_LDG=null;renderMain();toast('Saved');
  }catch(e){toast(e.message,true)}
}
