'use strict';
/* Licence codes (see src/server/licence.js).
   Clients: the banner and the "Licence" window, where they paste the code you send them.
   You (the seller): the Licence codes page, where you make codes and renewals. */

let LIC=null,LICS=null,LIC_MADE=null,LIC_FORM=null;

const licPlan=p=>T(TallyPlans.PLANS[TallyPlans.planOf(p)].label);
async function loadLicence(){
  try{LIC=await api('GET','/api/licence')}catch(e){LIC=null}
  document.body.classList.toggle('readonly',!!((typeof ME!=='undefined'&&ME&&ME.readOnly)||(LIC&&LIC.on&&!LIC.canChange)));
  if(typeof renderUserBox==='function')renderUserBox();
}
/** A change was refused because the licence ended: show it everywhere. */
async function licenceEnded(){await loadLicence();if(typeof renderMain==='function')renderMain()}

function licenceBanner(){
  if(!LIC||!LIC.on)return '';
  const btn=LIC.canEnter?`<button class="btn sm" data-act="licence">${['trial','trial-ended','none'].includes(LIC.state)?'Enter licence code':'Enter renewal code'}</button>`:'';
  const ask=LIC.canEnter?'':' <span>Ask the owner of this computer’s Sumlora to enter it.</span>';
  if(LIC.state==='none')return `<div class="banner err"><span><b>Enter your licence code to start using Sumlora.</b> <span>It’s in the email you received when you bought Sumlora.</span>${ask}</span>${btn}</div>`;
  if(LIC.state==='trial')return `<div class="banner"><span><b>Free trial: ${LIC.daysLeft===0?'last day':`${LIC.daysLeft} days left`}.</b> <span>Everything is included during the trial. Enter a licence code to keep making changes after ${esc(fmtDate(LIC.until))}.</span>${ask}</span>${btn}</div>`;
  if(LIC.state==='trial-ended')return `<div class="banner err"><span><b>The free trial has ended.</b> <span>Your books are view only: you can still open, print, export and back up everything. Enter a licence code to make changes.</span>${ask}</span>${btn}</div>`;
  if(LIC.state==='active'&&LIC.renewSoon)return `<div class="banner"><span><b>Your licence ends on ${esc(fmtDate(LIC.until))}.</b> <span>Renew it to keep making changes after that date.</span>${ask}</span>${btn}</div>`;
  if(LIC.state==='grace')return `<div class="banner err"><span><b>Your licence ended on ${esc(fmtDate(LIC.until))}.</b> <span>Enter a renewal code before ${esc(fmtDate(LIC.readOnlyFrom))}. After that, the books are view only until you do.</span>${ask}</span>${btn}</div>`;
  if(LIC.state==='ended')return `<div class="banner err"><span><b>Your licence ended on ${esc(fmtDate(LIC.until))}.</b> <span>Your books are view only: you can still open, print, export and back up everything. Enter a renewal code to make changes.</span>${ask}</span>${btn}</div>`;
  return '';
}

// The banner's button works on every screen.
document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('[data-act="licence"]'))licenceDialog()});

/** The client's window: what this computer is licensed for, and where to paste a code. */
function licenceDialog(){
  if(!LIC)return;
  const st=LIC,now=st.state==='issuer'?`<b>This is your own copy.</b> <span>It holds your licence key, so it doesn’t need a code.</span>`
    :st.state==='trial'?`<b>Free trial</b> <span>until ${esc(fmtDate(st.until))}.</span>`
    :st.state==='trial-ended'?`<b>The free trial has ended.</b> <span>The books are view only.</span>`
    :st.state==='none'?`<b>Not activated yet.</b> <span>Enter the licence code you received.</span>`
    :`<span>Licensed to</span> <b translate="no">${esc(st.name)}</b> · <span>${esc(licPlan(st.plan))} plan</span> · <span>${st.state==='active'?'until':'ended'} ${esc(fmtDate(st.until))}</span>`;
  const f=openModal('Licence',`
    <div class="banner ${['trial-ended','ended','grace','none'].includes(st.state)?'err':''}" style="margin:0"><span>${now}</span></div>
    ${st.canEnter&&st.state!=='issuer'?`${fld('licCode','Licence code',`<textarea id="licCode" rows="4" class="mono" spellcheck="false" autocomplete="off" placeholder="TB1-…" style="font-size:12.5px;word-break:break-all"></textarea>`,true)}
    <div class="muted" style="font-size:12.5px">Paste the whole code from the email, starting with TB1-. Your books stay as they are; the code only changes how long you can keep making changes, and the plan.</div>`:st.state!=='issuer'?'<div class="muted">Ask the owner of this computer’s Sumlora to enter the licence code.</div>':''}
    ${st.canEnter&&st.state!=='issuer'?`<details style="margin-top:4px"><summary class="muted" style="font-size:12.5px;cursor:pointer">Selling Sumlora? Bring back your licence key</summary>
      <div class="muted" style="font-size:12.5px;margin:6px 0">Choose the copy of your licence key (sumlora-licence-key.json). This copy then makes codes, and doesn’t need one.</div>
      <input type="file" id="licKeyFile" accept=".json,application/json"></details>`:''}`,
    `<button type="button" class="btn" data-close>${st.canEnter&&st.state!=='issuer'?'Cancel':'Close'}</button>${st.canEnter&&st.state!=='issuer'?'<button type="submit" class="btn primary">Turn on</button>':''}`,'small keep');
  f.onsubmit=async e=>{e.preventDefault();
    const code=$('#licCode',f).value;if(!code.trim())return toast('Paste the licence code.',true);
    try{LIC=await api('PUT','/api/licence',{code});closeModal();await licenceEnded();toast(`Licensed to ${LIC.name} until ${fmtDate(LIC.until)}`);if(CO)load()}catch(ex){toast(ex.message,true)}};
  const kf=$('#licKeyFile',f);if(kf)kf.onchange=()=>restoreKeyFile(kf,async()=>{closeModal();await licenceEnded()});
}
async function restoreKeyFile(input,done){
  const file=input.files&&input.files[0];if(!file)return;
  let body;try{body=JSON.parse(await file.text())}catch(e){input.value='';return toast('That isn’t a copy of a Sumlora licence key.',true)}
  try{await api('POST','/api/licences/key/restore',body);toast('Licence key brought back');await done()}catch(ex){input.value='';toast(ex.message,true)}
}

/* ---------- the seller's page: make codes ---------- */
async function showLicences(){S.view='licences';LICS=null;renderMain();try{LICS=await api('GET','/api/licences')}catch(e){toast(e.message,true)}if(S.view==='licences')renderMain()}
const isoDay=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
/** One year on from a day: the day before the same date next year (Oct 2 → Oct 1). */
const yearFrom=day=>{const d=pd(day);d.setFullYear(d.getFullYear()+1);d.setDate(d.getDate()-1);return isoDay(d)};
/** The "Make a code" form filled in to renew a licence: same client and plan, the next year after it ends. */
function renewFormFor(l){const today=isoDay(new Date());
  return {name:l.name,email:l.email||'',plan:l.plan,until:yearFrom(l.until>=today?isoDay(new Date(pd(l.until).getTime()+864e5)):today),note:'',renews:l.id}}
/** Open Licence codes with the renewal form ready (from the Overview page). */
async function renewLicence(l){LIC_FORM=renewFormFor(l);LIC_MADE=null;await showLicences();const f=$('#licForm');if(f){f.scrollIntoView({block:'center'});$('#lfUntil').focus()}}
function licStatus(l){
  const today=isoDay(new Date()),days=Math.round((pd(l.until)-pd(today))/864e5);
  if(LICS.issued.some(x=>x.renews===l.id))return ['quiet','Renewed'];
  if(days<0)return ['overdue','Ended'];
  if(days<30)return ['partial','Ends soon'];
  return ['paid','Active'];
}
function licMail(l){
  return `${T('Hello,')}\n\n${T('Here is your Sumlora licence code.')} ${T(`It’s for ${l.name}, with the ${licPlan(l.plan)} plan, until ${fmtDate(l.until)}.`)}\n\n${T('To enter it, open Sumlora, click Licence at the bottom left, paste the code and click Turn on.')}\n\n${l.code}\n\n${T('Thank you!')}\n`;
}
function vLicences(){
  const back=`<button class="btn ghost sm" data-back-co style="margin-bottom:8px">← Companies</button>`;
  if(!ME||!ME.platformAdmin||!LIC||!LIC.canIssue)return back+head('Licence codes','')+'<div class="panel"><div class="empty"><b>Administrators only</b>Licence codes are made in your own copy of Sumlora.</div></div>';
  if(!LICS)return back+head('Licence codes','Loading…');
  const h=back+head('Licence codes','For clients who use the desktop app with their books on their own computer. A code turns Sumlora on until a date, with a plan.');
  if(!LICS.key)return h+`<div class="panel" style="max-width:720px"><h3>Your licence key</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div>Codes are signed with a key that only you have, so nobody else can make them. Create it once, here in your own Sumlora.</div>
    <div class="actions" style="justify-content:flex-start"><button class="btn primary" data-lic="newkey">Create licence key</button><label class="btn">Bring back a key from a copy<input type="file" id="licRestore" accept=".json,application/json" hidden></label></div>
  </div></div>`;
  const today=isoDay(new Date()),F=LIC_FORM||{name:'',email:'',plan:'plus',until:yearFrom(today),note:''};
  const list=LICS.issued;
  return h+`<div class="panel" style="max-width:820px;margin-bottom:16px"><h3>Your licence key</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    ${LICS.licensing?`<div><span class="pill paid">Working</span> <span>This copy holds your key, so it makes codes and doesn’t need one.</span></div>`:`<div><b>1. Put your public key in GitHub, once.</b> <span>In your repository: Settings → Secrets and variables → Actions → Variables → New repository variable. Name:</span> <code translate="no">SUMLORA_LICENCE_KEY</code><span>, value:</span></div>
    <div class="linkbox mono" translate="no">${esc(LICS.key.publicKey)}</div>
    <div class="actions" style="justify-content:flex-start"><button class="btn sm" data-lic="copypub">Copy public key</button></div>
    <div class="muted" style="font-size:13px">The public key only checks codes; it can’t make them, so it’s safe in GitHub. Desktop versions built after you add it ask for a licence code (with a 30-day free trial). Copies installed before that keep working without one until they update.</div>`}
    <div><b>${LICS.licensing?'':'2. '}Keep a copy of your key somewhere safe.</b> <span>If this computer is lost, the copy lets you keep making codes (bring it back from the Licence window on another computer). Keep it private: anyone with it can make codes. It isn’t in the daily backups.</span></div>
    <div class="actions" style="justify-content:flex-start"><a class="btn sm" href="/api/licences/key/download" download>Download a copy of the key</a></div>
  </div></div>
  <div class="panel" style="max-width:820px;margin-bottom:16px"><h3>${F.renews?'Renew a licence':'Make a code'}</h3><form class="pad" id="licForm" style="display:flex;flex-direction:column;gap:10px">
    <div class="grid2">${fld('lfName','Client (business name)',`<input type="text" id="lfName" maxlength="80" value="${esc(F.name)}" required>`,true)}${fld('lfEmail','Email (optional)',`<input id="lfEmail" type="email" maxlength="120" value="${esc(F.email)}">`)}</div>
    <div class="grid2">${fld('lfPlan','Plan',`<select id="lfPlan">${Object.entries(TallyPlans.PLANS).map(([k,p])=>`<option value="${k}" ${F.plan===k?'selected':''}>${esc(T(p.label))}</option>`).join('')}</select>`)}${fld('lfUntil','Last day it works',`<input id="lfUntil" type="date" min="${today}" value="${esc(F.until)}" required>`)}</div>
    ${fld('lfNote','Note for you (optional)',`<input type="text" id="lfNote" maxlength="200" value="${esc(F.note)}" placeholder="Invoice number, payment…">`)}
    <div class="muted" style="font-size:12.5px">The client name shows in their app (Licensed to …). After the last day there are 14 more days to renew; then their books are view only until they enter a new code. Nothing is ever deleted.</div>
    <div class="actions" style="justify-content:flex-start">${F.renews?'<button type="button" class="btn" data-lic="cancelrenew">Cancel</button>':''}<button type="submit" class="btn primary">${F.renews?'Make renewal code':'Make code'}</button></div>
  </form></div>
  ${LIC_MADE?`<div class="panel" style="max-width:820px;margin-bottom:16px" id="licMade"><h3><span><span>Code for</span> <span translate="no">${esc(LIC_MADE.name)}</span></span></h3><div class="pad" style="display:flex;flex-direction:column;gap:10px">
    <div class="linkbox mono" translate="no" style="word-break:break-all">${esc(LIC_MADE.code)}</div>
    <div class="muted" style="font-size:13px"><span>${esc(licPlan(LIC_MADE.plan))} plan</span> · <span>until ${esc(fmtDate(LIC_MADE.until))}</span>. <span>Send it to your client by email. They paste it in Sumlora under Licence.</span></div>
    <div class="actions" style="justify-content:flex-start"><button class="btn sm" data-lic="copy" data-id="${esc(LIC_MADE.id)}">Copy code</button><button class="btn sm" data-lic="copymail" data-id="${esc(LIC_MADE.id)}">Copy email text</button><a class="btn sm" href="mailto:${encodeURIComponent(LIC_MADE.email||'')}?subject=${encodeURIComponent(T('Your Sumlora licence code'))}&body=${encodeURIComponent(licMail(LIC_MADE))}">Open in email</a></div>
  </div></div>`:''}
  <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Client</th><th>Plan</th><th>Last day</th><th>Made</th><th>Status</th><th></th></tr></thead><tbody>${list.length?list.map(l=>{const st=licStatus(l);
    return `<tr><td><b translate="no">${esc(l.name)}</b>${l.email?`<div class="muted" style="font-size:12px" translate="no">${esc(l.email)}</div>`:''}${l.note?`<div class="muted" style="font-size:12px">${esc(l.note)}</div>`:''}</td><td>${esc(licPlan(l.plan))}</td><td>${esc(fmtDate(l.until))}</td><td class="muted">${esc(fmtDate(l.issued))}</td><td><span class="pill ${st[0]}">${esc(T(st[1]))}</span></td>
      <td style="white-space:nowrap"><button class="btn sm" data-lic="copy" data-id="${esc(l.id)}">Copy code</button> ${st[1]==='Renewed'?'':`<button class="btn sm" data-lic="renew" data-id="${esc(l.id)}">Renew</button>`}</td></tr>`}).join(''):emptyRow(6,'No codes yet','Make the first one above when a client buys the desktop app.')}</tbody></table></div></div>`;
}
function bindLicences(m){
  const find=id=>LICS.issued.find(x=>x.id===id)||(LIC_MADE&&LIC_MADE.id===id?LIC_MADE:null);
  const copy=async(text,ok)=>{try{await navigator.clipboard.writeText(text);toast(ok)}catch(e){toast('Select the text and copy it instead.',true)}};
  m.onclick=async e=>{const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-back-co'))return showCompanies();
    const a=b.dataset.lic;if(!a)return;
    if(a==='newkey'){try{await api('POST','/api/licences/key',{});LIC_MADE=null;await showLicences();toast('Licence key created')}catch(ex){toast(ex.message,true)}return}
    if(a==='copypub')return copy(LICS.key.publicKey,'Public key copied');
    if(a==='copy')return copy(find(b.dataset.id).code,'Code copied');
    if(a==='copymail')return copy(licMail(find(b.dataset.id)),'Email text copied');
    if(a==='cancelrenew'){LIC_FORM=null;return renderMain()}
    if(a==='renew'){LIC_FORM=renewFormFor(find(b.dataset.id));
      renderMain();const f=$('#licForm');if(f){f.scrollIntoView({block:'center'});$('#lfUntil').focus()}return}
  };
  const r=$('#licRestore',m);if(r)r.onchange=()=>restoreKeyFile(r,showLicences);
  const f=$('#licForm',m);if(f)f.onsubmit=async e=>{e.preventDefault();
    const body={name:$('#lfName',f).value,email:$('#lfEmail',f).value,plan:$('#lfPlan',f).value,until:$('#lfUntil',f).value,note:$('#lfNote',f).value,...(LIC_FORM&&LIC_FORM.renews?{renews:LIC_FORM.renews}:{})};
    try{const out=await api('POST','/api/licences',body);LIC_MADE=out.licence;LIC_FORM=null;LICS=await api('GET','/api/licences');renderMain();const d=$('#licMade');if(d)d.scrollIntoView({block:'center'});toast(`Code made for ${out.licence.name}`)}catch(ex){toast(ex.message,true)}};
}
