'use strict';
/* ---------- Sign-in: first-time setup, sign in, auto-lock, account and users ----------
 * The server refuses every data request without a signed-in session. This file shows the
 * screens that get one, locks the app after inactivity, and manages users for owners.
 */
let ME=null,IDLE_MIN=30,lastActivity=Date.now(),unlockWaiters=[];

function lockShown(){return !!$('#lockRoot').innerHTML}
/** Show a full-screen sign-in (or setup / new-password) card. Resolves once the user is in. */
function requireSignIn(mode,msg){
  return new Promise(res=>{unlockWaiters.push(res);renderLock(mode,msg)});
}
function unlocked(user,idle){
  ME=user;if(idle)IDLE_MIN=idle;lastActivity=Date.now();
  $('#lockRoot').innerHTML='';document.body.classList.remove('locked');
  renderUserBox();
  const w=unlockWaiters;unlockWaiters=[];w.forEach(f=>f(user));
}
function renderLock(mode,msg=''){
  document.body.classList.add('locked');
  closeModal();
  const title={setup:'Welcome to Tally Books',signin:'Sign in',password:'Choose a new password'}[mode];
  const sub={setup:'Create the owner account. You’ll use it to sign in, add staff, and manage security. Only people with an account can see your clients’ books.',
    signin:msg||'Sign in to see your clients’ books.',
    password:'Your password was set by someone else. Choose your own before continuing.'}[mode];
  const pwHint='At least 10 characters. A short phrase of a few unrelated words works well, for example “maple river copper lamp”.';
  const body=mode==='signin'?`
      ${fld('lgUser','Username or email',`<input type="text" id="lgUser" autocomplete="username" autocapitalize="none" spellcheck="false">`,true)}
      ${fld('lgPass','Password',`<input type="password" id="lgPass" autocomplete="current-password">`,true)}`
    :mode==='setup'?`
      ${fld('suName','Your name',`<input type="text" id="suName" autocomplete="name">`,true)}
      ${fld('suUser','Username or email',`<input type="text" id="suUser" autocomplete="username" autocapitalize="none" spellcheck="false">`,true)}
      ${fld('suPass','Password',`<input type="password" id="suPass" autocomplete="new-password">`,true)}
      ${fld('suPass2','Type the password again',`<input type="password" id="suPass2" autocomplete="new-password">`,true)}
      <div class="hint muted" style="font-size:12.5px">${pwHint} Write it down somewhere safe: there’s no “forgot password” email, and only an owner can reset a password.</div>`
    :`
      ${fld('npCur','Temporary password',`<input type="password" id="npCur" autocomplete="current-password">`,true)}
      ${fld('npPass','New password',`<input type="password" id="npPass" autocomplete="new-password">`,true)}
      ${fld('npPass2','Type it again',`<input type="password" id="npPass2" autocomplete="new-password">`,true)}
      <div class="hint muted" style="font-size:12.5px">${pwHint}</div>`;
  $('#lockRoot').innerHTML=`<div class="lock"><form class="lock-card" novalidate>
    <div class="lock-brand"><img src="icon.svg" alt="" width="40" height="40"><b>Tally Books</b></div>
    <h1>${title}</h1><p class="muted">${esc(sub)}</p>
    <div class="fields" style="grid-template-columns:1fr">${body}</div>
    <div class="err-msg" data-lockerr></div>
    <button type="submit" class="btn primary block">${mode==='setup'?'Create owner account':mode==='signin'?'Sign in':'Save new password'}</button>
    ${mode==='password'?'<button type="button" class="btn ghost block" data-lockout>Sign out</button>':''}
  </form></div>`;
  const f=$('#lockRoot form'),err=m=>{$('[data-lockerr]',f).textContent=m||''},btn=f.querySelector('button[type=submit]');
  setTimeout(()=>f.querySelector('input')?.focus(),30);
  const lo=$('[data-lockout]',f);if(lo)lo.onclick=()=>signOut();
  f.onsubmit=async e=>{e.preventDefault();err('');btn.disabled=true;
    try{
      if(mode==='signin'){
        const r=await api('POST','/api/auth/login',{username:$('#lgUser').value,password:$('#lgPass').value});
        const me=await api('GET','/api/auth/me');
        if(r.user.mustChange){ME=r.user;renderLock('password');return}
        unlocked(me.user,me.idleMinutes);
      }else if(mode==='setup'){
        if($('#suPass').value!==$('#suPass2').value)throw new Error('The two passwords don’t match.');
        await api('POST','/api/auth/setup',{name:$('#suName').value,username:$('#suUser').value,password:$('#suPass').value});
        const me=await api('GET','/api/auth/me');unlocked(me.user,me.idleMinutes);toast('Owner account created');
      }else{
        if($('#npPass').value!==$('#npPass2').value)throw new Error('The two passwords don’t match.');
        await api('POST','/api/auth/password',{current:$('#npCur').value,password:$('#npPass').value});
        const me=await api('GET','/api/auth/me');unlocked(me.user,me.idleMinutes);toast('Password changed');
      }
    }catch(ex){err(ex.message);btn.disabled=false;if(mode==='signin'){$('#lgPass').value='';$('#lgPass').focus()}}
  };
}

/** Called by api() when the server says the session is gone. */
let reauthing=null;
function sessionEnded(info){
  if(reauthing)return reauthing;
  $('#main').innerHTML='';ME=null;
  reauthing=requireSignIn(info&&info.setup?'setup':'signin',info&&info.idle?`Locked after ${IDLE_MIN} minutes without activity. Sign in to continue.`:'Your session ended. Sign in to continue.')
    .then(()=>{reauthing=null;if(CO)load();renderMain()});
  return reauthing;
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
  box.innerHTML=`<div class="who"><b>${esc(ME.name)}</b><span>${ME.role==='owner'?'Owner':'Staff'}</span></div>
    <div class="who-actions"><button class="link" data-account>Account</button>${ME.role==='owner'?'<button class="link" data-users>Users &amp; security</button>':''}<button class="link" data-signout>Sign out</button></div>`;
  box.onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-signout'))signOut();if(b.hasAttribute('data-account'))accountForm();if(b.hasAttribute('data-users'))showUsers()};
}
function accountForm(){
  const f=openModal('Your account',`<div class="muted">${esc(ME.name)} · ${esc(ME.username)} · ${ME.role==='owner'?'Owner':'Staff'}</div>
    <div class="fields">${fld('acCur','Current password',`<input type="password" id="acCur" autocomplete="current-password">`,true)}${fld('acNew','New password',`<input type="password" id="acNew" autocomplete="new-password">`)}${fld('acNew2','Type it again',`<input type="password" id="acNew2" autocomplete="new-password">`)}</div>
    <div class="hint muted" style="font-size:12.5px">At least 10 characters. A short phrase of unrelated words is strong and easy to remember.</div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Change password</button>`,'small');
  f.onsubmit=async e=>{e.preventDefault();f.err('');if($('#acNew',f).value!==$('#acNew2',f).value)return f.err('The two new passwords don’t match.');
    try{await api('POST','/api/auth/password',{current:$('#acCur',f).value,password:$('#acNew',f).value});closeModal();toast('Password changed')}catch(ex){f.err(ex.message)}};
}

/* ---------- Users & security (owners) ---------- */
let USERS=null;
async function showUsers(){S.view='users';renderMain();try{USERS=await api('GET','/api/users');IDLE_MIN=USERS.idleMinutes}catch(e){toast(e.message,true)}if(S.view==='users')renderMain()}
function vUsers(){
  if(!ME||ME.role!=='owner')return head('Users & security','')+'<div class="panel"><div class="empty"><b>Owners only</b>Ask an owner to change users or security settings.</div></div>';
  if(!USERS)return head('Users & security','Loading…');
  const coName=id=>(CO_LIST.find(c=>c.id===id)||{}).name||'(removed company)';
  const access=u=>u.role==='owner'||!u.companies.length?'All companies':u.companies.map(coName).join(', ');
  return `<button class="btn ghost sm" data-back-co style="margin-bottom:8px">← Companies</button>`+head('Users & security','Who can sign in, what they can see, and when the app locks itself',`<button class="btn primary" data-useradd>+ Add user</button>`)+
  `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Can see</th><th>Last sign-in</th><th>Status</th></tr></thead><tbody>${USERS.users.map(u=>`<tr class="click" data-useredit="${u.id}"><td><b>${esc(u.name)}</b>${u.id===ME.id?' <span class="pill paid">You</span>':''}</td><td class="mono">${esc(u.username)}</td><td>${u.role==='owner'?'Owner':'Staff'}</td><td class="trunc">${esc(access(u))}</td><td class="muted">${u.lastLogin?fmtWhen(u.lastLogin):'Never'}</td><td>${u.disabled?'<span class="pill overdue">Turned off</span>':u.mustChange?'<span class="pill partial">Must set password</span>':'<span class="pill paid">Active</span>'}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="panel" style="max-width:760px;margin-top:16px"><h3>Security</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="field" style="max-width:320px"><label for="secIdle">Lock the app after no activity for</label><select id="secIdle">${[5,10,15,30,60,120,240,480].map(m=>`<option value="${m}" ${IDLE_MIN===m?'selected':''}>${m<60?m+' minutes':m/60+' hour'+(m===60?'':'s')}</option>`).join('')}</select></div>
    <div class="muted" style="font-size:13px">Also always on: passwords are stored only as secure hashes, five wrong passwords lock an account for 15 minutes, and every sign-in lasts at most 12 hours.</div>
  </div></div>`;
}
function bindUsers(m){
  m.onclick=async e=>{
    const t=e.target.closest('button,tr.click');if(!t)return;const d=t.dataset;
    if(t.hasAttribute('data-back-co'))return showCompanies();
    if(t.hasAttribute('data-useradd'))return userForm(null);
    if(d.useredit)return userForm(USERS.users.find(u=>u.id===d.useredit));
    if(d.go)return go(d.go);
  };
  const si=$('#secIdle',m);if(si)si.onchange=async()=>{try{const r=await api('PUT','/api/security',{idleMinutes:+si.value});IDLE_MIN=r.idleMinutes;toast(`The app now locks after ${si.options[si.selectedIndex].text}`)}catch(ex){toast(ex.message,true)}};
}
function userForm(u){
  const cos=CO_LIST.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const sel=new Set(u?u.companies:[]);
  const f=openModal(u?`Edit ${u.name}`:'Add user',`<div class="fields">
    ${fld('usName','Name',`<input type="text" id="usName" value="${esc(u?.name||'')}">`)}
    ${fld('usUser','Username or email',u?`<div class="mono" style="padding:6px 0">${esc(u.username)}</div>`:`<input type="text" id="usUser" autocapitalize="none" spellcheck="false">`)}
    ${fld('usRole','Role',`<select id="usRole"><option value="staff" ${u?.role!=='owner'?'selected':''}>Staff: works in the companies below</option><option value="owner" ${u?.role==='owner'?'selected':''}>Owner: everything, including users and security</option></select>`,true)}
    ${fld('usPass',u?'Set a new temporary password (optional)':'Temporary password',`<input type="text" id="usPass" autocomplete="off" placeholder="${u?'Leave blank to keep their password':'At least 10 characters'}">`,true)}
  </div>
  <div data-cos><div class="flabel" style="margin-bottom:6px">Companies this person can see</div>
    <label class="check"><input type="checkbox" id="usAll" ${!u||!u.companies.length?'checked':''}> All companies, including new ones</label>
    <div data-colist style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 16px;margin-top:6px">${cos.map(c=>`<label class="check"><input type="checkbox" data-usco="${c.id}" ${sel.has(c.id)?'checked':''}> ${esc(c.name)}${c.archived?' <span class="muted">(archived)</span>':''}</label>`).join('')}</div></div>
  <div class="muted" style="font-size:13px">${u?'A new temporary password signs them out, and they choose their own at the next sign-in.':'Give them the temporary password in person or by phone. They’ll choose their own the first time they sign in.'}</div>`,
  `${u&&u.id!==ME.id?`<button type="button" class="btn ${u.disabled?'':'danger'} left" data-usdis>${u.disabled?'Turn account back on':'Turn account off'}</button>`:'<span class="left"></span>'}<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${u?'Save':'Add user'}</button>`);
  const role=$('#usRole',f),all=$('#usAll',f);
  const sync=()=>{$('[data-cos]',f).hidden=role.value==='owner';$('[data-colist]',f).hidden=all.checked};
  role.onchange=all.onchange=sync;sync();
  const dis=$('[data-usdis]',f);if(dis)dis.onclick=async()=>{try{await api('PUT','/api/users/'+u.id,{disabled:!u.disabled});closeModal();await showUsers();toast(u.disabled?`${u.name} can sign in again`:`${u.name} is signed out and can’t sign in`)}catch(ex){f.err(ex.message)}};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const companies=role.value==='owner'||all.checked?[]:$$('[data-usco]',f).filter(c=>c.checked).map(c=>c.dataset.usco);
    if(role.value==='staff'&&!all.checked&&!companies.length)return f.err('Pick at least one company, or tick “All companies”.');
    const body={name:$('#usName',f).value,role:role.value,companies};const pw=$('#usPass',f).value;
    try{
      if(u){if(pw)body.password=pw;await api('PUT','/api/users/'+u.id,body)}
      else await api('POST','/api/users',{...body,username:$('#usUser',f).value,password:pw});
      closeModal();await showUsers();toast(u?'Saved':'User added. Give them their temporary password.');
    }catch(ex){f.err(ex.message)}};
}
