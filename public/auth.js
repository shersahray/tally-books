'use strict';
/* ---------- Sign-in: setup, sign in, two-step codes, invitations, auto-lock, account and users ----------
 * The server refuses every data request without a signed-in session. This file shows the
 * screens that get one, locks the app after inactivity, and manages users for owners.
 */
let ME=null,IDLE_MIN=30,REQ2FA='off',lastActivity=Date.now(),unlockWaiters=[];
const ROLE_LABEL={owner:'Owner',staff:'Staff',client:'Client'};
const roleLabel=u=>ROLE_LABEL[u.role]+(u.readOnly?' · view only':'');

function lockShown(){return !!$('#lockRoot').innerHTML}
/** Show a full-screen sign-in (or setup / new-password / code) card. Resolves once the user is in. */
function requireSignIn(mode,msg){
  return new Promise(res=>{unlockWaiters.push(res);renderLock(mode,msg)});
}
function unlocked(user,idle){
  ME=user;if(idle)IDLE_MIN=idle;lastActivity=Date.now();
  $('#lockRoot').innerHTML='';document.body.classList.remove('locked');
  document.body.classList.toggle('readonly',!!ME.readOnly);
  document.body.classList.toggle('role-client',ME.role==='client');
  document.body.classList.toggle('not-owner',ME.role!=='owner');
  renderUserBox();
  if(typeof loadLicence==='function')loadLicence().then(()=>{if(typeof renderMain==='function'&&LIC&&LIC.on)renderMain()});
  const w=unlockWaiters;unlockWaiters=[];w.forEach(f=>f(user));
}
/** After a password or code is accepted: finish anything the account still needs, then unlock. */
async function afterSignIn(){
  const me=await api('GET','/api/auth/me');REQ2FA=me.require2fa||'off';
  if(me.user.theme&&me.user.theme!==TallyTheme.get())TallyTheme.set(me.user.theme,false);
  if(syncAccountLang(me.user))return;
  if(me.user.mustChange){ME=me.user;return renderLock('password')}
  if(me.user.mustEnroll){ME=me.user;return renderLock('enroll')}
  if(me.terms&&!me.terms.accepted){ME=me.user;return renderLock('terms',me.terms)}
  if(typeof billingCheck==='function'&&await billingCheck(me.user))return;
  unlocked(me.user,me.idleMinutes);
}
/* Terms of service and Privacy policy: the pages, and the box people tick to agree. */
const legalUrl=k=>`/legal/${k}${I18N.lang==='fr'?'-fr':''}.html`;
const termsBox=id=>`<label class="check" style="align-items:flex-start;font-size:13.5px"><input type="checkbox" id="${id}" style="margin-top:3px"> <span><span>I agree to the</span> <a href="${legalUrl('terms')}" target="_blank" rel="noopener">Terms of service</a> <span>and the</span> <a href="${legalUrl('privacy')}" target="_blank" rel="noopener">Privacy policy</a><span>.</span></span></label>`;
const termsTicked=id=>{const b=$('#'+id);if(b&&!b.checked)throw new Error('Tick the box to agree to the Terms of service and Privacy policy.');return true};
const pwHint='At least 10 characters. A short phrase of a few unrelated words works well, for example “maple river copper lamp”.';
const lockCard=(title,sub,body,submit,extra='')=>`<div class="lock"><form class="lock-card" novalidate>
    <div class="lock-brand"><span class="logo" aria-label="Sumlora">${LOGO_SVG}</span></div>
    <h1>${title}</h1>${sub?`<p class="muted">${sub}</p>`:''}
    <div class="fields" style="grid-template-columns:1fr">${body}</div>
    <div class="err-msg" data-lockerr></div>
    ${submit?`<button type="submit" class="btn primary block">${submit}</button>`:''}${extra}
    <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:4px">${langSwitch()}${TallyTheme.html()}</div>
  </form></div>`;

function renderLock(mode,opt=''){
  document.body.classList.add('locked');
  closeModal();
  const msg=typeof opt==='string'?opt:'';
  let html='';
  if(mode==='signin')html=lockCard('Sign in',esc(msg||'Sign in to see your books.'),`
      ${fld('lgUser','Username or email',`<input type="text" id="lgUser" autocomplete="username" autocapitalize="none" spellcheck="false">`,true)}
      ${fld('lgPass','Password',`<input type="password" id="lgPass" autocomplete="current-password">`,true)}`,'Sign in',
      `<div class="muted" style="font-size:12.5px">Forgot your password? Ask your bookkeeper or the account owner for a reset link.</div>${SIGNUPS?'<button type="button" class="btn ghost block" data-locksignup>New firm? Create an account</button>':''}`);
  else if(mode==='setup')html=lockCard('Welcome to Sumlora','Create the owner account. You’ll use it to sign in, add staff and clients, and manage security. Only people with an account can see the books.',`
      ${opt&&opt.setupCode?fld('suCode','Setup code',`<input type="text" id="suCode" autocomplete="off" autocapitalize="none" spellcheck="false"><span class="hint">The setup code chosen when this server was installed.</span>`,true):''}
      ${opt&&opt.licence?fld('suLic','Licence code',`<textarea id="suLic" rows="3" class="mono" spellcheck="false" autocomplete="off" placeholder="TB1-…" style="font-size:12.5px;word-break:break-all"></textarea><span class="hint">${opt.licence.required?'Paste the licence code you received with Sumlora. It starts with TB1-.':`Paste the licence code you received with Sumlora. No code yet? Leave it empty for a ${opt.licence.trialDays}-day free trial.`}</span>`,!!opt.licence.required):''}
      ${fld('suFirm','Your firm’s name',`<input type="text" id="suFirm" autocomplete="organization" placeholder="e.g. Sher Bookkeeping">`,true)}
      ${fld('suName','Your name',`<input type="text" id="suName" autocomplete="name">`,true)}
      ${fld('suUser','Username or email',`<input type="text" id="suUser" autocomplete="username" autocapitalize="none" spellcheck="false">`,true)}
      ${fld('suPass','Password',`<input type="password" id="suPass" autocomplete="new-password">`,true)}
      ${fld('suPass2','Type the password again',`<input type="password" id="suPass2" autocomplete="new-password">`,true)}
      <div class="hint muted" style="font-size:12.5px">${pwHint} Write it down somewhere safe: only an owner can reset a password.</div>
      ${termsBox('suTerms')}`,'Create owner account');
  else if(mode==='signup')html=lockCard('Create your firm’s account','For bookkeeping and accounting firms. You’ll be the owner: you add your staff and your clients’ companies. Other firms on this server never see your books.',`
      ${fld('sgFirm','Firm name',`<input type="text" id="sgFirm" autocomplete="organization">`,true)}
      ${fld('sgName','Your name',`<input type="text" id="sgName" autocomplete="name">`,true)}
      ${fld('sgUser','Your email (your username)',`<input type="email" id="sgUser" autocomplete="username" autocapitalize="none" spellcheck="false">`,true)}
      ${fld('sgPass','Password',`<input type="password" id="sgPass" autocomplete="new-password">`,true)}
      ${fld('sgPass2','Type the password again',`<input type="password" id="sgPass2" autocomplete="new-password">`,true)}
      <div class="hint muted" style="font-size:12.5px"><span>${pwHint}</span>${SIGNUPS==='approval'?' <span>New firms are approved by the server’s administrator before they can sign in.</span>':''}</div>
      ${termsBox('sgTerms')}`,'Create firm account',
      '<button type="button" class="btn ghost block" data-lockback>Back to sign in</button>');
  else if(mode==='pending')html=lockCard('Thanks! Your firm is waiting for approval','The server’s administrator approves new firms. Once your firm is approved, sign in with the email and password you just chose.','','','<button type="button" class="btn primary block" data-lockback>Back to sign in</button>');
  else if(mode==='code')html=lockCard('Enter your code','Open your authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…) and enter the 6-digit code for Sumlora.',`
      ${fld('lgCode','Code',`<input type="text" id="lgCode" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="123456" style="font-size:20px;letter-spacing:.2em;text-align:center">`,true)}
      <div class="muted" style="font-size:12.5px">Lost your phone? Enter one of your recovery codes instead (it looks like <span class="mono">a1b2c-3d4e5</span>).</div>`,'Continue',
      '<button type="button" class="btn ghost block" data-lockback>Back</button>');
  else if(mode==='password')html=lockCard('Choose a new password','Your password was set by someone else. Choose your own before continuing.',`
      ${fld('npCur','Temporary password',`<input type="password" id="npCur" autocomplete="current-password">`,true)}
      ${fld('npPass','New password',`<input type="password" id="npPass" autocomplete="new-password">`,true)}
      ${fld('npPass2','Type it again',`<input type="password" id="npPass2" autocomplete="new-password">`,true)}
      <div class="hint muted" style="font-size:12.5px">${pwHint}</div>`,'Save new password','<button type="button" class="btn ghost block" data-lockout>Sign out</button>');
  else if(mode==='terms')html=lockCard(opt&&opt.before?'We’ve updated our terms':'Before you continue',opt&&opt.before?'Sumlora’s Terms of service or Privacy policy changed since you last agreed. Please read them and agree to continue.':'Please read Sumlora’s Terms of service and Privacy policy, and agree to them to continue.',`
      ${opt&&opt.draft?'<div class="muted" style="font-size:12.5px">These are draft documents, still being reviewed.</div>':''}
      ${termsBox('tmAgree')}`,'Agree and continue','<button type="button" class="btn ghost block" data-lockout>Sign out</button>');
  else if(mode==='link')html=lockCard('Checking your link…','','','');
  else if(mode==='enroll')html=lockCard('Set up two-step sign-in','Loading…','','');
  $('#lockRoot').innerHTML=html;
  const f=$('#lockRoot form'),err=m=>{$('[data-lockerr]',f).textContent=m||''},btn=f.querySelector('button[type=submit]');
  setTimeout(()=>f.querySelector('input,textarea')?.focus(),30);
  const lo=$('[data-lockout]',f);if(lo)lo.onclick=()=>signOut();
  const bk=$('[data-lockback]',f);if(bk)bk.onclick=()=>renderLock('signin');
  const sg=$('[data-locksignup]',f);if(sg)sg.onclick=()=>renderLock('signup');
  if(mode==='pending')return;
  if(mode==='link')return linkScreen(f);
  if(mode==='enroll')return enrollScreen(f,opt);
  if(mode==='terms'&&!(opt&&opt.version)){api('GET','/api/auth/me').then(me=>{if(me.terms)renderLock('terms',me.terms)}).catch(()=>{});return}
  f.onsubmit=async e=>{e.preventDefault();err('');btn.disabled=true;
    try{
      if(mode==='signin'){
        const r=await api('POST','/api/auth/login',{username:$('#lgUser').value,password:$('#lgPass').value});
        if(r.needCode)return renderLock('code',{ticket:r.ticket});
        await afterSignIn();
      }else if(mode==='code'){
        await api('POST','/api/auth/login/code',{ticket:opt.ticket,code:$('#lgCode').value});
        await afterSignIn();
      }else if(mode==='setup'){
        if($('#suPass').value!==$('#suPass2').value)throw new Error('The two passwords don’t match.');
        const lic=($('#suLic')||{}).value||'';
        if(opt&&opt.licence&&opt.licence.required&&!lic.trim())throw new Error('Paste the licence code you received with Sumlora.');
        termsTicked('suTerms');
        await api('POST','/api/auth/setup',{acceptTerms:true,firmName:$('#suFirm').value,name:$('#suName').value,username:$('#suUser').value,password:$('#suPass').value,setupCode:($('#suCode')||{}).value,licenceCode:lic});
        await afterSignIn();toast(lic.trim()?'Owner account created and Sumlora is activated':'Owner account created');
      }else if(mode==='signup'){
        if($('#sgPass').value!==$('#sgPass2').value)throw new Error('The two passwords don’t match.');
        termsTicked('sgTerms');
        const r=await api('POST','/api/auth/signup',{acceptTerms:true,firmName:$('#sgFirm').value,name:$('#sgName').value,username:$('#sgUser').value,password:$('#sgPass').value});
        if(r.pending)return renderLock('pending');
        if(r.needCode)return renderLock('code',{ticket:r.ticket});
        await afterSignIn();toast('Your firm’s account is ready');
      }else if(mode==='terms'){
        termsTicked('tmAgree');
        await api('POST','/api/auth/terms',{version:opt.version,accept:true});
        await afterSignIn();toast('Thank you');
      }else{
        if($('#npPass').value!==$('#npPass2').value)throw new Error('The two passwords don’t match.');
        await api('POST','/api/auth/password',{current:$('#npCur').value,password:$('#npPass').value});
        await afterSignIn();toast('Password changed');
      }
    }catch(ex){
      if(mode==='code'&&ex.info&&ex.info.restart){renderLock('signin',ex.message);return}
      err(ex.message);btn.disabled=false;
      if(mode==='signin'){$('#lgPass').value='';$('#lgPass').focus()}
      if(mode==='code'){$('#lgCode').value='';$('#lgCode').focus()}
    }
  };
}

/* An invitation or password reset link: #link=<token>. */
async function linkScreen(f){
  const token=decodeURIComponent((location.hash.match(/link=([^&]+)/)||[])[1]||'');
  history.replaceState(null,'',location.pathname+location.search); // don't leave the token in the address bar
  let info;
  try{info=await api('POST','/api/auth/link',{token})}
  catch(ex){$('#lockRoot').innerHTML=lockCard('This link doesn’t work',esc(ex.message),'','','<button type="button" class="btn primary block" data-tosignin>Go to sign in</button>');$('#lockRoot [data-tosignin]').onclick=()=>renderLock('signin');return}
  const invite=info.kind==='invite';
  $('#lockRoot').innerHTML=lockCard(invite?`Welcome, ${esc(info.name)}`:'Choose a new password',invite?'You’ve been invited to Sumlora. Choose a password to finish setting up your account.':`Choose a new password for ${esc(info.username)}.`,`
    <div class="muted">Username: <b class="mono">${esc(info.username)}</b></div>
    ${fld('lkPass','Password',`<input type="password" id="lkPass" autocomplete="new-password">`,true)}
    ${fld('lkPass2','Type it again',`<input type="password" id="lkPass2" autocomplete="new-password">`,true)}
    <input type="text" autocomplete="username" value="${esc(info.username)}" hidden>
    <div class="hint muted" style="font-size:12.5px">${pwHint}</div>
    ${invite?termsBox('lkTerms'):''}`,invite?'Create my account':'Save new password');
  const g=$('#lockRoot form'),btn=g.querySelector('button[type=submit]'),err=m=>{$('[data-lockerr]',g).textContent=m||''};
  setTimeout(()=>$('#lkPass').focus(),30);
  g.onsubmit=async e=>{e.preventDefault();err('');
    if($('#lkPass').value!==$('#lkPass2').value)return err('The two passwords don’t match.');
    if(invite&&!$('#lkTerms').checked)return err('Tick the box to agree to the Terms of service and Privacy policy.');
    btn.disabled=true;
    try{const r=await api('POST','/api/auth/link/accept',{token,password:$('#lkPass').value,acceptTerms:invite?true:undefined});
      if(r.needCode)return renderLock('code',{ticket:r.ticket});
      await afterSignIn();toast(invite?'Your account is ready':'Password changed');
    }catch(ex){err(ex.message);btn.disabled=false}};
}

/* Setting up an authenticator app: QR code, code to confirm, then recovery codes. */
async function enrollScreen(f,opt){
  const optional=opt&&opt.optional;
  let s;try{s=await api('POST','/api/auth/2fa/start',{})}catch(ex){$('[data-lockerr]',f).textContent=ex.message;return}
  const key=s.secret.replace(/(.{4})/g,'$1 ').trim();
  $('#lockRoot').innerHTML=lockCard('Set up two-step sign-in',`${optional?'':'Your account needs a second step to sign in. '}Each time you sign in, you’ll also enter a 6-digit code from an app on your phone. Someone who learns your password still can’t get in.`,`
    <ol class="steps">
      <li>Install an authenticator app if you don’t have one: <b>Microsoft Authenticator</b> or <b>Google Authenticator</b> (free), or use 1Password.</li>
      <li>In the app, add an account and scan this code:</li>
    </ol>
    <div class="qr">${TallyQR.qrSvg(s.uri,{px:4,label:'QR code for your authenticator app'})}</div>
    <details><summary class="fsum">Can’t scan it?</summary><div class="muted" style="font-size:13px;margin-top:6px">Choose “Enter a setup key” in the app and type this key (time-based):<div class="mono" style="font-size:15px;margin-top:6px;word-break:break-all;user-select:all">${key}</div></div></details>
    <ol class="steps" start="3"><li>Enter the 6-digit code the app shows for Sumlora:</li></ol>
    ${fld('enCode','Code',`<input type="text" id="enCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="font-size:20px;letter-spacing:.2em;text-align:center">`,true)}`,
    'Turn on two-step sign-in',optional?'<button type="button" class="btn ghost block" data-lockcancel>Not now</button>':'<button type="button" class="btn ghost block" data-lockout>Sign out</button>');
  const g=$('#lockRoot form'),btn=g.querySelector('button[type=submit]'),err=m=>{$('[data-lockerr]',g).textContent=m||''};
  const lo=$('[data-lockout]',g);if(lo)lo.onclick=()=>signOut();
  const lc=$('[data-lockcancel]',g);if(lc)lc.onclick=()=>{$('#lockRoot').innerHTML='';document.body.classList.remove('locked')};
  g.onsubmit=async e=>{e.preventDefault();err('');btn.disabled=true;
    try{const r=await api('POST','/api/auth/2fa/confirm',{code:$('#enCode').value});showRecovery(r.recovery,optional)}
    catch(ex){err(ex.message);btn.disabled=false;$('#enCode').value='';$('#enCode').focus()}};
}
function showRecovery(codes,fromAccount){
  const text=`Sumlora recovery codes for ${ME?ME.username:''}\nEach code works once, if you can't use your authenticator app.\n\n${codes.join('\n')}\n`;
  document.body.classList.add('locked');
  $('#lockRoot').innerHTML=lockCard('Save your recovery codes','If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe, such as a password manager or a printed copy in a drawer. They won’t be shown again.',`
    <div class="recovery mono">${codes.map(c=>`<span>${c}</span>`).join('')}</div>
    <div class="actions"><button type="button" class="btn sm" data-rcopy>Copy</button><button type="button" class="btn sm" data-rsave>Download</button></div>
    <label class="check"><input type="checkbox" id="rcSaved"> I’ve saved these codes</label>`,'Continue');
  const g=$('#lockRoot form'),btn=g.querySelector('button[type=submit]');btn.disabled=true;
  $('#rcSaved').onchange=()=>{btn.disabled=!$('#rcSaved').checked};
  $('[data-rcopy]',g).onclick=async()=>{try{await navigator.clipboard.writeText(text);toast('Copied')}catch(e){toast('Select the codes and copy them instead.',true)}};
  $('[data-rsave]',g).onclick=()=>saveFile('sumlora-recovery-codes.txt',new Blob([text],{type:'text/plain'}));
  g.onsubmit=async e=>{e.preventDefault();
    if(fromAccount){$('#lockRoot').innerHTML='';document.body.classList.remove('locked');const me=await api('GET','/api/auth/me');ME=me.user;toast('Two-step sign-in is on');return}
    await afterSignIn();toast('Two-step sign-in is on')};
}

/** Called by api() when the server says the session is gone. */
let reauthing=null;
function sessionEnded(info){
  if(reauthing)return reauthing;
  $('#main').innerHTML='';ME=null;
  reauthing=requireSignIn(info&&info.setup?'setup':'signin',info&&info.setup?{setupCode:!!info.setupCode,licence:info.licenceSetup||null}:info&&info.idle?`Locked after ${IDLE_MIN} minutes without activity. Sign in to continue.`:'Your session ended. Sign in to continue.')
    .then(()=>{reauthing=null;if(CO)load();renderMain()});
  return reauthing;
}
/** Start-up: who's signed in, or show the right screen first. */
async function authStart(){
  if(/[#&]link=/.test(location.hash))return requireSignIn('link');
  let me;
  try{me=await api('GET','/api/auth/me')}
  catch(e){if(e.status===401){SIGNUPS=(e.info&&e.info.signups)||'';return e.info&&e.info.setup?requireSignIn('setup',{setupCode:!!e.info.setupCode,licence:e.info.licenceSetup||null}):requireSignIn('signin')}throw e}
  REQ2FA=me.require2fa||'off';ME=me.user;IDLE_MIN=me.idleMinutes;
  if(me.user.theme&&me.user.theme!==TallyTheme.get())TallyTheme.set(me.user.theme,false);
  if(syncAccountLang(me.user))return new Promise(()=>{});
  if(me.user.mustChange)return requireSignIn('password');
  if(me.user.mustEnroll)return requireSignIn('enroll');
  if(me.terms&&!me.terms.accepted)return requireSignIn('terms',me.terms);
  if(typeof billingCheck==='function'&&await billingCheck(me.user))return new Promise(res=>unlockWaiters.push(res));
  unlocked(me.user,me.idleMinutes);
}
async function signOut(){
  try{await api('POST','/api/auth/logout',{})}catch(e){}
  location.hash='';location.reload();
}

/* Auto-lock after inactivity. */
['mousemove','mousedown','keydown','touchstart','scroll','wheel'].forEach(ev=>window.addEventListener(ev,()=>{lastActivity=Date.now()},{passive:true,capture:true}));
setInterval(async()=>{
  if(!ME||lockShown())return;
  if(Date.now()-lastActivity>IDLE_MIN*60000){try{await api('POST','/api/auth/logout',{})}catch(e){}sessionEnded({idle:true})}
},20000);

/* Sidebar: who's signed in. */
function renderUserBox(){
  const box=$('#userBox');if(!box)return;
  if(!ME){box.innerHTML='';return}
  box.innerHTML=`<div class="who"><b>${esc(ME.name)}</b><span><span>${roleLabel(ME)}</span>${ME.firmName&&ME.role!=='client'?` · <span translate="no">${esc(ME.firmName)}</span>`:''}</span></div>
    <div class="who-actions"><button class="link" data-account>Account</button>${ME.role==='owner'?'<button class="link" data-users>Users &amp; security</button>':''}${ME.platformAdmin?'<button class="link" data-overview>Overview</button><button class="link" data-firms>Firms</button>':''}${typeof LIC!=='undefined'&&LIC&&LIC.canEnter?'<button class="link" data-licence>Licence</button>':''}${typeof LIC!=='undefined'&&LIC&&LIC.canIssue?'<button class="link" data-licences>Licence codes</button>':''}<button class="link" data-signout>Sign out</button><a class="link" href="${legalUrl('terms')}" target="_blank" rel="noopener">Terms</a><a class="link" href="${legalUrl('privacy')}" target="_blank" rel="noopener">Privacy</a></div>
    <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;align-items:flex-start">${langSwitch()}${TallyTheme.html()}</div>`;
  box.onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-signout'))signOut();if(b.hasAttribute('data-account'))myAccountForm();if(b.hasAttribute('data-users'))showUsers();if(b.hasAttribute('data-firms'))showFirms();if(b.hasAttribute('data-overview'))showOverview();if(b.hasAttribute('data-licence'))licenceDialog();if(b.hasAttribute('data-licences'))showLicences()};
}
function passwordPrompt(title,msg,ok){
  return new Promise(res=>{
    const f=openModal(title,`<div class="muted">${esc(msg)}</div>${fld('ppPass','Your password',`<input type="password" id="ppPass" autocomplete="current-password">`,true)}`,`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${esc(ok)}</button>`,'small keep');
    f.onsubmit=e=>{e.preventDefault();const v=$('#ppPass',f).value;res({f,password:v})};
    $$('[data-close]',f).forEach(b=>b.addEventListener('click',()=>res(null)));
  });
}
function myAccountForm(){
  const two=ME.twoStep,required=ME.mustEnroll||(REQ2FA==='everyone'||(REQ2FA==='owners'&&ME.role==='owner'));
  const f=openModal('Your account',`<div class="muted"><span translate="no">${esc(ME.name)} · ${esc(ME.username)}</span> <span>· ${roleLabel(ME)}</span></div>
    <h3 class="fsec">Language</h3>
    <div>${langSwitch()}</div>
    <h3 class="fsec">Appearance</h3>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${TallyTheme.html()}<span class="muted" style="font-size:13px">Automatic follows this computer’s light or dark setting.</span></div>
    ${typeof billingAccountHtml==='function'?billingAccountHtml():''}
    <h3 class="fsec">Two-step sign-in</h3>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${two?`<span class="pill paid">On</span><span class="muted" style="font-size:13px">${ME.recoveryLeft} recovery code${ME.recoveryLeft===1?'':'s'} left</span>`:'<span class="pill quiet">Off</span><span class="muted" style="font-size:13px">Recommended: a code from your phone as well as your password.</span>'}</div>
    <div class="actions" style="justify-content:flex-start">${two?`<button type="button" class="btn sm" data-2fanew>New recovery codes</button>${required?'':'<button type="button" class="btn sm danger" data-2faoff>Turn off</button>'}`:'<button type="button" class="btn sm primary" data-2faon>Set up two-step sign-in</button>'}</div>
    <h3 class="fsec">Change password</h3>
    <div class="fields">${fld('acCur','Current password',`<input type="password" id="acCur" autocomplete="current-password">`,true)}${fld('acNew','New password',`<input type="password" id="acNew" autocomplete="new-password">`)}${fld('acNew2','Type it again',`<input type="password" id="acNew2" autocomplete="new-password">`)}</div>
    <div class="hint muted" style="font-size:12.5px">At least 10 characters. A short phrase of unrelated words is strong and easy to remember.</div>`,
    `<button type="button" class="btn" data-close>Close</button><button type="submit" class="btn primary">Change password</button>`,'keep');
  const on=$('[data-2faon]',f);if(on)on.onclick=()=>{closeModal();document.body.classList.add('locked');renderLock('enroll',{optional:true})};
  if(typeof bindBillingAccount==='function')bindBillingAccount(f);
  const nw=$('[data-2fanew]',f);if(nw)nw.onclick=async()=>{const r=await passwordPrompt('New recovery codes','Your old recovery codes will stop working.','Make new codes');if(!r)return;
    try{const x=await api('POST','/api/auth/2fa/recovery',{password:r.password});closeModal();showRecovery(x.recovery,true)}catch(ex){closeModal();toast(ex.message,true)}};
  const off=$('[data-2faoff]',f);if(off)off.onclick=async()=>{const r=await passwordPrompt('Turn off two-step sign-in?','Signing in will need only your password.','Turn off');if(!r)return;
    try{await api('POST','/api/auth/2fa/disable',{password:r.password});const me=await api('GET','/api/auth/me');ME=me.user;closeModal();toast('Two-step sign-in is off')}catch(ex){closeModal();toast(ex.message,true)}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');if($('#acNew',f).value!==$('#acNew2',f).value)return f.err('The two new passwords don’t match.');
    try{await api('POST','/api/auth/password',{current:$('#acCur',f).value,password:$('#acNew',f).value});closeModal();toast('Password changed')}catch(ex){f.err(ex.message)}};
}

/* ---------- Users & security (owners) ---------- */
let USERS=null,SIGNINS=null,SIGNUPS='';
async function showUsers(){if(typeof loadBillMe==='function')loadBillMe();S.view='users';renderMain();try{USERS=await api('GET','/api/users');IDLE_MIN=USERS.idleMinutes}catch(e){toast(e.message,true)}if(S.view==='users')renderMain()}
function vUsers(){
  if(!ME||ME.role!=='owner')return head('Users & security','')+'<div class="panel"><div class="empty"><b>Owners only</b>Ask an owner to change users or security settings.</div></div>';
  if(!USERS)return head('Users & security','Loading…');
  const coName=id=>(CO_LIST.find(c=>c.id===id)||{}).name||'(removed company)';
  const access=u=>u.role==='owner'||(u.role==='staff'&&!u.companies.length)?'All companies':u.companies.map(coName).join(', ');
  const status=u=>u.disabled?'<span class="pill overdue">Turned off</span>':u.invited?`<span class="pill partial">${u.linkPending==='invite'?'Invited':'Invite expired'}</span>`:u.mustChange?'<span class="pill partial">Must set password</span>':u.mustEnroll?'<span class="pill partial">Must set up two-step</span>':'<span class="pill paid">Active</span>';
  const rank={off:0,owners:1,everyone:2},forced=USERS.forced2fa||'off',eff=rank[USERS.require2fa]>=rank[forced]?USERS.require2fa:forced;
  const firm=USERS.firm||{};
  return `<button class="btn ghost sm" data-back-co style="margin-bottom:8px">← Companies</button>`+head('Users & security','Who can sign in, what they can see, and how sign-in is protected',`<button class="btn" data-signins>Sign-in activity</button><button class="btn primary" data-useradd>+ Add user</button>`)+
  `<div class="panel" style="margin-bottom:16px"><div class="pad" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="flabel" style="margin:0">Firm</span><b translate="no">${esc(firm.name||ME.firmName||'')}</b><span class="pill quiet">${esc(T(TallyPlans.PLANS[TallyPlans.planOf(firm.plan||ME.firmPlan)].label))}</span><button class="btn sm" data-firmname>Rename</button><span class="muted" style="font-size:13px">Everyone below belongs to this firm. Other firms on this server never see your people or companies.</span></div></div>`+
  `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Can see</th><th>Two-step</th><th>Last sign-in</th><th>Status</th></tr></thead><tbody>${USERS.users.map(u=>`<tr class="click" data-useredit="${u.id}"><td><b>${esc(u.name)}</b>${u.id===ME.id?' <span class="pill paid">You</span>':''}${u.platformAdmin?' <span class="pill quiet">Server administrator</span>':''}</td><td class="mono">${esc(u.username)}</td><td>${roleLabel(u)}</td><td class="trunc">${esc(access(u))}</td><td>${u.twoStep?'On':'<span class="muted">Off</span>'}</td><td class="muted">${u.lastLogin?fmtWhen(u.lastLogin):'Never'}</td><td>${status(u)}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="panel" style="max-width:760px;margin-top:16px"><h3>Security</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    ${ME.platformAdmin?'':'<div class="muted" style="font-size:13px">These are set for the whole server by its administrator.</div>'}
    <div class="fields">
    <div class="field"><label for="sec2fa">Require two-step sign-in for</label><select id="sec2fa" ${ME.platformAdmin?'':'disabled'}>${[['off','No one (each person chooses)'],['owners','Owners'],['everyone','Everyone']].map(([k,v])=>`<option value="${k}" ${eff===k?'selected':''} ${rank[k]<rank[forced]?'disabled':''}>${v}</option>`).join('')}</select>${forced!=='off'?`<span class="hint">This server always requires it for ${forced==='everyone'?'everyone':'owners'}.</span>`:''}</div>
    <div class="field"><label for="secIdle">Lock the app after no activity for</label><select id="secIdle" ${ME.platformAdmin?'':'disabled'}>${[5,10,15,30,60,120,240,480].map(m=>`<option value="${m}" ${IDLE_MIN===m?'selected':''}>${m<60?m+' minutes':m/60+' hour'+(m===60?'':'s')}</option>`).join('')}</select></div>
    </div>
    <div class="muted" style="font-size:13px">Also always on: passwords are stored only as secure hashes, five wrong tries lock an account for 15 minutes, too many failures from one network are blocked for 15 minutes, and every sign-in lasts at most 12 hours.</div>
  </div></div>`;
}
function bindUsers(m){
  m.onclick=async e=>{
    const t=e.target.closest('button,tr.click');if(!t)return;const d=t.dataset;
    if(t.hasAttribute('data-back-co'))return showCompanies();
    if(t.hasAttribute('data-useradd'))return userForm(null);
    if(t.hasAttribute('data-firmname'))return firmNameForm();
    if(t.hasAttribute('data-signins'))return showSignins();
    if(t.hasAttribute('data-back-users'))return showUsers();
    if(d.useredit)return userForm(USERS.users.find(u=>u.id===d.useredit));
    if(d.go)return go(d.go);
  };
  const si=$('#secIdle',m);if(si)si.onchange=async()=>{try{const r=await api('PUT','/api/security',{idleMinutes:+si.value});IDLE_MIN=r.idleMinutes;toast(`The app now locks after ${si.options[si.selectedIndex].text}`)}catch(ex){toast(ex.message,true)}};
  const s2=$('#sec2fa',m);if(s2)s2.onchange=async()=>{try{await api('PUT','/api/security',{require2fa:s2.value});await showUsers();toast(s2.value==='off'?'Two-step sign-in is optional':'Saved. People without two-step sign-in will set it up the next time they sign in.')}catch(ex){toast(ex.message,true)}};
}
/* A link to send: invitation (new person chooses a password) or password reset. */
function showLink(u,token,kind,o={}){
  const url=`${location.origin}${location.pathname}#link=${encodeURIComponent(token)}`;
  const invite=kind==='invite';
  // What the invitation says depends on who's invited: a firm's owner, a business that keeps its own books, or a client of the firm.
  const trialFr=typeof BILL!=='undefined'&&BILL&&BILL.configured&&BILL.offer.trialDays?` (avec ${BILL.offer.trialDays} jours d’essai gratuit)`:'';
  const trialEn=typeof BILL!=='undefined'&&BILL&&BILL.configured&&BILL.offer.trialDays?` (with a ${BILL.offer.trialDays}-day free trial)`:'';
  const introFr=o.firm?`J’ai créé le compte Sumlora de votre cabinet, ${o.firm}. Vous y tiendrez les livres de vos clients en ligne${typeof BILL!=='undefined'&&BILL&&BILL.configured?`, et vous démarrerez votre abonnement${trialFr} à votre première connexion`:''}. Ouvrez ce lien pour choisir votre mot de passe (il fonctionne une fois, pendant 7 jours)`
    :o.business?`J’ai créé ${o.business} dans Sumlora pour que vous teniez vos livres en ligne${o.pays?`. Vous démarrerez votre abonnement${trialFr} à votre première connexion`:''}. Ouvrez ce lien pour choisir votre mot de passe (il fonctionne une fois, pendant 7 jours)`:'';
  const introEn=o.firm?`I've set up a Sumlora account for your firm, ${o.firm}, so you can keep your clients' books online${typeof BILL!=='undefined'&&BILL&&BILL.configured?`. You'll start your subscription${trialEn} the first time you sign in`:''}. Open this link to choose your password (it works once, for 7 days)`
    :o.business?`I've set up ${o.business} in Sumlora so you can keep your books online${o.pays?`. You'll start your subscription${trialEn} the first time you sign in`:''}. Open this link to choose your password (it works once, for 7 days)`:'';
  const mail=isFr()?`Bonjour ${u.name.split(' ')[0]},\n\n${invite&&introFr?introFr:invite?`J’ai créé votre compte Sumlora pour que vous puissiez consulter les livres de votre entreprise en ligne. Ouvrez ce lien pour choisir votre mot de passe (il fonctionne une fois, pendant 7 jours)`:`Voici un lien pour choisir un nouveau mot de passe Sumlora (il fonctionne une fois, pendant 24 heures)`} :\n\n${url}\n\nVotre nom d’utilisateur est ${u.username}.${REQ2FA!=='off'||invite?' Vous configurerez aussi une application de codes sur votre téléphone pour la connexion en deux étapes.':''}\n`:`Hi ${u.name.split(' ')[0]},\n\n${invite&&introEn?introEn:invite?`I've set up your Sumlora account so you can see your company's books online. Open this link to choose your password (it works once, for 7 days)`:`Here's a link to choose a new Sumlora password (it works once, for 24 hours)`}:\n\n${url}\n\nYour username is ${u.username}.${REQ2FA!=='off'||invite?' You’ll also set up a code app on your phone for two-step sign-in.':''}\n`;
  const f=openModal(invite?'Invitation link':'Password reset link',`
    <div class="muted">Send this link to <b>${esc(u.name)}</b> yourself, for example by email. Anyone with the link can set the password, so send it only to them. It works once and expires in ${invite?'7 days':'24 hours'}.</div>
    <div class="linkbox mono">${esc(url)}</div>
    <div class="actions" style="justify-content:flex-start"><button type="button" class="btn sm" data-lcopy>Copy link</button><button type="button" class="btn sm" data-mcopy>Copy email text</button><a class="btn sm" href="mailto:${encodeURIComponent(u.username.includes('@')?u.username:'')}?subject=${encodeURIComponent(T(invite?'Your Sumlora account':'Reset your Sumlora password'))}&body=${encodeURIComponent(mail)}">Open in email</a></div>`,
    `<button type="button" class="btn primary" data-close>Done</button>`);
  $('[data-lcopy]',f).onclick=async()=>{try{await navigator.clipboard.writeText(url);toast('Link copied')}catch(e){toast('Select the link and copy it instead.',true)}};
  $('[data-mcopy]',f).onclick=async()=>{try{await navigator.clipboard.writeText(mail);toast('Email text copied')}catch(e){toast('Select the text and copy it instead.',true)}};
}
function userForm(u){
  const cos=CO_LIST.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const sel=new Set(u?u.companies:[]);
  const role0=u?u.role:'client';
  const f=openModal(u?`Edit ${u.name}`:'Add user',`<div class="fields">
    ${fld('usName','Name',`<input type="text" id="usName" value="${esc(u?.name||'')}">`)}
    ${fld('usUser','Email (used as their username)',u?`<div class="mono" style="padding:6px 0">${esc(u.username)}</div>`:`<input type="email" id="usUser" autocapitalize="none" spellcheck="false">`)}
    ${fld('usRole','Role',`<select id="usRole"><option value="client" ${role0==='client'?'selected':''}>Client: sees only their own company</option><option value="staff" ${role0==='staff'?'selected':''}>Staff: works in the companies below</option><option value="owner" ${role0==='owner'?'selected':''}>Owner: everything, including users and security</option></select>`,true)}
  </div>
  <label class="check" data-ro><input type="checkbox" id="usRO" ${u?(u.readOnly?'checked':''):'checked'}> View only: can see reports and transactions but can’t change anything</label>
  ${!u&&typeof BILL!=='undefined'&&BILL&&BILL.configured?`<label class="check" data-pays style="align-items:flex-start"><input type="checkbox" id="usPays" checked style="margin-top:3px"> <span><span>They pay for Sumlora for this company, monthly</span>${BILL.offer.trialDays?` <span>after a ${BILL.offer.trialDays}-day free trial</span>`:''}<span>. They enter a card the first time they sign in.</span>
    <select id="usPlan" aria-label="Plan they pay for" style="display:block;margin-top:6px">${Object.entries(BILL.plans).map(([k,p])=>`<option value="${k}" ${k==='essentials'?'selected':''}>${esc(T(p.label))}: ${planPrice(BILL,k)}</option>`).join('')}</select></span></label>`:''}
  ${ME.platformAdmin&&u?`<label class="check" data-adm><input type="checkbox" id="usAdm" ${u.platformAdmin?'checked':''}> Server administrator: manages firms, backups, the AI key and security for the whole server</label>`:''}
  <div data-cos><div class="flabel" style="margin-bottom:6px" data-coslabel>Companies this person can see</div>
    <label class="check" data-allrow><input type="checkbox" id="usAll" ${u&&u.role==='staff'&&!u.companies.length?'checked':''}> All companies, including new ones</label>
    <div data-colist style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 16px;margin-top:6px">${cos.map(c=>`<label class="check"><input type="checkbox" data-usco="${c.id}" ${sel.has(c.id)?'checked':''}> ${esc(c.name)}${c.archived?' <span class="muted">(archived)</span>':''}</label>`).join('')}</div></div>
  ${u?`<div class="subpanel"><div class="flabel">Sign-in</div>
    <div class="muted" style="font-size:13px">${u.invited?'They haven’t accepted their invitation yet.':`Two-step sign-in is ${u.twoStep?'on':'off'}.`}</div>
    <div class="actions" style="justify-content:flex-start">${u.id!==ME.id?`<button type="button" class="btn sm" data-uslink>${u.invited?'New invitation link':'Password reset link'}</button>`:''}${u.twoStep&&u.id!==ME.id?'<button type="button" class="btn sm" data-us2fa>Reset two-step sign-in</button>':''}</div></div>`
   :`<div class="muted" style="font-size:13px">You’ll get an invitation link to send them. They choose their own password${REQ2FA!=='off'?' and set up two-step sign-in':''}.</div>`}`,
  `${u&&u.id!==ME.id?`<button type="button" class="btn ${u.disabled?'':'danger'} left" data-usdis>${u.disabled?'Turn account back on':'Turn account off'}</button>${!u.lastLogin?'<button type="button" class="btn ghost" data-usdel>Remove</button>':''}`:'<span class="left"></span>'}<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${u?'Save':'Add and get invitation link'}</button>`);
  const role=$('#usRole',f),all=$('#usAll',f);
  const sync=()=>{const r=role.value;const adm=$('[data-adm]',f);if(adm)adm.hidden=r!=='owner';const pays=$('[data-pays]',f);if(pays)pays.hidden=r!=='client';$('[data-cos]',f).hidden=r==='owner';$('[data-ro]',f).hidden=r==='owner';$('[data-allrow]',f).hidden=r!=='staff';$('[data-colist]',f).hidden=r==='staff'&&all.checked;$('[data-coslabel]',f).textContent=r==='client'?'Their company (or companies)':'Companies this person can see'};
  role.onchange=all.onchange=sync;sync();
  const dis=$('[data-usdis]',f);if(dis)dis.onclick=async()=>{try{await api('PUT','/api/users/'+u.id,{disabled:!u.disabled});closeModal();await showUsers();toast(u.disabled?`${u.name} can sign in again`:`${u.name} is signed out and can’t sign in`)}catch(ex){f.err(ex.message)}};
  const del=$('[data-usdel]',f);if(del)del.onclick=async()=>{if(!await confirmBox('Remove this person?',`${u.name} (${u.username}) has never signed in. Their invitation stops working and they’re taken off the list.`,'Remove'))return;
    try{await api('DELETE','/api/users/'+u.id);closeModal();await showUsers();toast(`${u.name} removed`)}catch(ex){f.err(ex.message)}};
  const ln=$('[data-uslink]',f);if(ln)ln.onclick=async()=>{try{const r=await api('POST',`/api/users/${u.id}/link`,{});closeModal();await showUsers();showLink(u,r.token,r.kind)}catch(ex){f.err(ex.message)}};
  const r2f=$('[data-us2fa]',f);if(r2f)r2f.onclick=async()=>{if(!await confirmBox('Reset two-step sign-in?',`${u.name} will be signed out. They’ll sign in with their password${REQ2FA!=='off'?' and set up their authenticator app again':''}. Do this only if you’re sure it’s really them asking, for example after a lost phone.`,'Reset'))return;
    try{await api('PUT','/api/users/'+u.id,{reset2fa:true});closeModal();await showUsers();toast('Two-step sign-in reset')}catch(ex){f.err(ex.message)}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const r=role.value;
    const companies=r==='owner'||(r==='staff'&&all.checked)?[]:$$('[data-usco]',f).filter(c=>c.checked).map(c=>c.dataset.usco);
    if(r!=='owner'&&!(r==='staff'&&all.checked)&&!companies.length)return f.err(r==='client'?'Pick the client’s company.':'Pick at least one company, or tick “All companies”.');
    const body={name:$('#usName',f).value,role:r,companies,readOnly:r!=='owner'&&$('#usRO',f).checked};
    const adm=$('#usAdm',f);if(adm&&r==='owner'&&adm.checked!==!!u.platformAdmin)body.platformAdmin=adm.checked;
    try{
      if(u){await api('PUT','/api/users/'+u.id,body);closeModal();await showUsers();toast('Saved')}
      else{const pays=$('#usPays',f);const x=await api('POST','/api/users',{...body,username:$('#usUser',f).value,invite:true,clientPays:r==='client'&&!!(pays&&pays.checked),clientPlan:($('#usPlan',f)||{}).value});closeModal();await showUsers();showLink(x.user,x.user.link,'invite')}
    }catch(ex){f.err(ex.message)}};
}

/* ---------- sign-in activity (owners) ---------- */
const SIGNIN_EVENT={login:'Signed in','login-failed':'Wrong password','code-failed':'Wrong code',locked:'Account locked',logout:'Signed out','2fa-on':'Two-step turned on','2fa-off':'Two-step turned off','recovery-code-used':'Used a recovery code','invite-accepted':'Accepted invitation','password-reset':'Reset password with link','password-changed':'Changed password','user-added':'User added','user-changed':'User changed','invite-link':'Invitation link made','reset-link':'Reset link made','security-changed':'Security settings changed'};
async function showSignins(){S.view='signins';SIGNINS=null;renderMain();try{SIGNINS=(await api('GET','/api/security/log')).log}catch(e){toast(e.message,true)}if(S.view==='signins')renderMain()}
function vSignins(){
  const bad=new Set(['login-failed','code-failed','locked']);
  return `<button class="btn ghost sm" data-back-users style="margin-bottom:8px">← Users &amp; security</button>`+head('Sign-in activity','Sign-ins, failed attempts and account changes, newest first')+
  `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>When</th><th>What</th><th>Who</th><th>Details</th></tr></thead><tbody>${!SIGNINS?emptyRow(4,'Loading…',''):SIGNINS.length?SIGNINS.map(e=>`<tr><td class="muted" style="white-space:nowrap">${fmtWhen(Date.parse(e.at))}</td><td class="${bad.has(e.event)?'neg':''}">${esc(SIGNIN_EVENT[e.event]||e.event)}</td><td class="mono">${esc(e.username||e.by||'')}</td><td class="muted trunc">${esc([e.by&&e.username?'by '+e.by:'',e.ip?'from '+e.ip:'',e.reason||'',e.role||'',e.changes?e.changes.join(', '):'',e.require2fa?'two-step: '+e.require2fa:'',e.idleMinutes?'lock after '+e.idleMinutes+' min':''].filter(Boolean).join(' · '))}</td></tr>`).join(''):emptyRow(4,'Nothing yet','')}</tbody></table></div></div>`;
}

/* ---------- the firm ---------- */
function firmNameForm(){
  const f=openModal('Firm name',`${fld('fmName','Firm name',`<input type="text" id="fmName" maxlength="120" value="${esc((USERS&&USERS.firm&&USERS.firm.name)||ME.firmName||'')}">`,true)}`,`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`,'small');
  f.onsubmit=async e=>{e.preventDefault();f.err('');try{const r=await api('PUT','/api/firm',{name:$('#fmName',f).value});ME.firmName=r.firm.name;renderUserBox();closeModal();await showUsers();toast('Firm name saved')}catch(ex){f.err(ex.message)}};
}

/* ---------- Firms on this server (the server's administrators) ---------- */
let FIRMS=null;
async function showFirms(){S.view='firms';FIRMS=null;renderMain();try{FIRMS=await api('GET','/api/firms');if(typeof loadBillingAdmin==='function')await loadBillingAdmin()}catch(e){toast(e.message,true)}if(S.view==='firms')renderMain()}
const FIRM_STATUS={active:['paid','Active'],pending:['partial','Waiting for approval'],suspended:['overdue','Suspended']};
function vFirms(){
  if(!ME||!ME.platformAdmin)return head('Firms','')+'<div class="panel"><div class="empty"><b>Administrators only</b>Only the server’s administrator manages firms.</div></div>';
  if(!FIRMS)return head('Firms','Loading…');
  const list=FIRMS.firms.slice().sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)||b.created-a.created);
  const pending=list.filter(f=>f.status==='pending').length;
  return `<button class="btn ghost sm" data-back-co style="margin-bottom:8px">← Companies</button>`+head('Firms','Bookkeeping firms using this server. Each firm sees only its own people and companies.',`<button class="btn primary" data-firminvite>+ Invite a firm</button>`)+
  (typeof billingAdminPanel==='function'?billingAdminPanel():'')+
  `<div class="panel" style="max-width:760px;margin-bottom:16px"><h3>New firms</h3><div class="pad" style="display:flex;flex-direction:column;gap:10px">
    <div class="field"><label for="fmSignups">Can new firms sign up from the sign-in screen?</label><select id="fmSignups">${[['off','No: only people you invite can sign in'],['approval','Yes, after I approve each one'],['open','Yes, straight away']].map(([k,v])=>`<option value="${k}" ${FIRMS.signups===k?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label for="fmDefPlan">Plan for firms that sign up</label><select id="fmDefPlan">${Object.entries(TallyPlans.PLANS).map(([k,p])=>`<option value="${k}" ${FIRMS.defaultPlan===k?'selected':''}>${esc(T(p.label))}</option>`).join('')}</select><span class="hint">You can change each firm’s plan in the table below.</span></div>
    <div class="muted" style="font-size:13px">A firm that signs up gets its own owner account and starts with no companies. Firms don’t use AI suggestions until you turn them on, because AI is billed to your API key.</div>
  </div></div>
  ${pending?`<div class="banner"><span><b>${pending} firm${pending===1?' is':'s are'} waiting for approval.</b> Check who they are before approving.</span></div>`:''}
  <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Firm</th><th>Owner</th><th class="n">People</th><th class="n">Companies</th><th>Signed up</th><th>Last sign-in</th><th>Plan</th>${BILLADM&&BILLADM.configured?'<th>Subscription</th>':''}<th>AI</th><th>Status</th><th></th></tr></thead><tbody>${list.map(f=>{const st=FIRM_STATUS[f.status]||['quiet',f.status],mine=f.id===FIRMS.myFirm;
    return `<tr><td><b translate="no">${esc(f.name)}</b>${mine?' <span class="pill paid">Your firm</span>':''}</td><td><span translate="no">${f.owner?esc(f.owner.name):'—'}</span><div class="muted mono" style="font-size:12px" translate="no">${f.owner?esc(f.owner.username):''}</div></td><td class="n">${f.users}</td><td class="n">${f.companies}</td><td class="muted">${fmtWhen(f.created)}</td><td class="muted">${f.lastLogin?fmtWhen(f.lastLogin):'Never'}</td>
      <td><select data-firmplan="${f.id}" aria-label="Plan">${Object.entries(TallyPlans.PLANS).map(([k,p])=>`<option value="${k}" ${(f.plan||'plus')===k?'selected':''}>${esc(T(p.label))}</option>`).join('')}</select></td>
      ${BILLADM&&BILLADM.configured?`<td style="white-space:nowrap">${f.main?'<span class="muted">Your firm (free)</span>':({trialing:'<span class="pill paid">Free trial</span>',active:'<span class="pill paid">Paying</span>',pastdue:'<span class="pill overdue">Payment failed</span>',stopped:'<span class="pill overdue">Stopped</span>'})[f.subscription&&f.subscription.state]||'<span class="pill quiet">Not started</span>'}</td>`:''}
      <td style="white-space:nowrap"><label class="check"><input type="checkbox" data-firmai="${f.id}" ${f.ai?'checked':''} aria-label="AI suggestions"> On</label>${f.main?'<div class="muted" style="font-size:12px">Server limit</div>':`<div class="muted" style="font-size:12px;display:flex;gap:4px;align-items:center"><span translate="no">${money(f.aiSpentUsd||0)}</span> / $<input type="number" min="0" step="1" value="${f.aiCapUsd??10}" data-firmcap="${f.id}" aria-label="Monthly AI limit (US$)" style="width:64px;padding:2px 4px"></div>`}</td><td><span class="pill ${st[0]}">${st[1]}</span></td>
      <td style="white-space:nowrap">${f.status==='pending'?`<button class="btn sm primary" data-firmset="${f.id}" data-to="active">Approve</button>`:''}${f.status==='suspended'?`<button class="btn sm" data-firmset="${f.id}" data-to="active">Reactivate</button>`:''}${f.status!=='suspended'&&!mine?` <button class="btn sm ${f.status==='pending'?'ghost':'danger'}" data-firmset="${f.id}" data-to="suspended">${f.status==='pending'?'Decline':'Suspend'}</button>`:''}${f.status==='suspended'&&!f.companies&&!mine?` <button class="btn sm ghost" data-firmdel="${f.id}">Remove</button>`:''}</td></tr>`}).join('')}</tbody></table></div></div>`;
}
function bindFirms(m){
  m.onclick=async e=>{const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-back-co'))return showCompanies();
    if(b.hasAttribute('data-firminvite'))return inviteFirmForm(showFirms);
    if(typeof billingAdminAction==='function'&&await billingAdminAction(b))return;
    if(b.dataset.firmdel){const f=FIRMS.firms.find(x=>x.id===b.dataset.firmdel);if(!await confirmBox('Remove this firm?',`${f.name}: the firm and its ${f.users} account${f.users===1?'':'s'} are removed, and their emails can be used again. It has no companies, so no books are lost.`,'Remove'))return;
      try{await api('DELETE','/api/firms/'+encodeURIComponent(f.id));await showFirms();toast(`${f.name} removed`)}catch(ex){toast(ex.message,true)}return}
    const id=b.dataset.firmset;if(!id)return;const f=FIRMS.firms.find(x=>x.id===id),to=b.dataset.to;
    if(to==='suspended'&&!await confirmBox(f.status==='pending'?'Decline this firm?':'Suspend this firm?',`${f.name}: ${f.status==='pending'?'they won’t be able to sign in.':'everyone in this firm is signed out and can’t sign in until you reactivate it. Their books are kept.'}`,f.status==='pending'?'Decline':'Suspend'))return;
    try{await api('PUT','/api/firms/'+encodeURIComponent(id),{status:to});await showFirms();toast(to==='active'?(f.status==='pending'?`${f.name} is approved`:`${f.name} is active again`):`${f.name} can’t sign in`)}catch(ex){toast(ex.message,true)}};
  m.onchange=async e=>{const t=e.target;
    if(t.id==='fmDefPlan'){try{await api('PUT','/api/firms/settings',{defaultPlan:t.value});toast('Saved')}catch(ex){toast(ex.message,true)}return}
    if(t.dataset.firmplan){const f=FIRMS.firms.find(x=>x.id===t.dataset.firmplan);try{await api('PUT','/api/firms/'+encodeURIComponent(f.id),{plan:t.value});f.plan=t.value;if(f.id===ME.firmId){ME.firmPlan=t.value}toast(`${f.name}: ${T(TallyPlans.PLANS[t.value].label)}`)}catch(ex){t.value=f.plan||'plus';toast(ex.message,true)}return}
    if(t.id==='fmSignups'){try{await api('PUT','/api/firms/settings',{signups:t.value});await showFirms();toast('Saved')}catch(ex){toast(ex.message,true)}return}
    if(t.dataset.firmcap){try{await api('PUT','/api/firms/'+encodeURIComponent(t.dataset.firmcap),{aiCapUsd:+t.value});toast('Monthly AI limit saved')}catch(ex){toast(ex.message,true)}return}
    if(t.dataset.firmai){try{await api('PUT','/api/firms/'+encodeURIComponent(t.dataset.firmai),{ai:t.checked});toast(t.checked?'AI suggestions turned on for this firm':'AI suggestions turned off for this firm')}catch(ex){t.checked=!t.checked;toast(ex.message,true)}}};
}
