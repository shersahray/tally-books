'use strict';
const el=id=>document.getElementById(id);
let sent=0,busy=false,loginTicket=null,signingIn=false;
const scriptStatus=el('scriptStatus');if(scriptStatus){scriptStatus.textContent='Scanner controls ready';scriptStatus.hidden=false;}
function showStatus(message,error=false){const x=el('status');x.hidden=false;x.textContent=message;x.className='notice'+(error?' error':'')}
async function request(url,options={}){const r=await fetch(url,{credentials:'same-origin',...options});const body=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(body.error||('Request failed ('+r.status+')')),{status:r.status,codeRequired:!!body.codeRequired});return body}
async function init(){
 try{
  await request('/api/auth/me');
  const d=await request('/api/companies');
  const companies=d.companies||[];
  const list=el('company');list.replaceChildren();
  for(const company of companies){const option=document.createElement('option');option.value=company.id;option.textContent=company.name;list.append(option)}
  el('signIn').hidden=true;el('logout').hidden=false;el('scanner').hidden=!companies.length;
  if(!companies.length){showStatus('No company is available for this account.',true);}
 }catch(err){el('signIn').hidden=false;el('scanner').hidden=true;el('logout').hidden=true;if(err.message!=='Request failed (401)'){const status=el('loginStatus');status.textContent='Could not open your companies: '+err.message;status.hidden=false}}
}
// Phone photos are made smaller (2,000 pixels on the long side) before they're sent, as on the Receipts screen:
// faster on mobile data, less storage, and cheaper for AI to read. PDFs, and anything that can't be redrawn, go as they are.
async function shrink(file){
 if(file.type==='application/pdf')return file;
 let url;
 try{
  url=URL.createObjectURL(file);
  const img=new Image();await new Promise((ok,no)=>{img.onload=ok;img.onerror=no;img.src=url});
  const k=Math.min(1,2000/Math.max(img.naturalWidth,img.naturalHeight));
  const c=document.createElement('canvas');c.width=Math.round(img.naturalWidth*k);c.height=Math.round(img.naturalHeight*k);
  c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  const blob=await new Promise(ok=>c.toBlob(ok,'image/jpeg',0.85));
  return blob&&blob.size<file.size?new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'}):file;
 }catch(e){return file}finally{if(url)URL.revokeObjectURL(url)}
}
let listed=false;function note(div){if(!listed){el('history').textContent='';listed=true}el('history').prepend(div)}
// A company with a 4-digit code: owners and staff type it once here, as they do when opening the company in Sumlora
// (clients are never asked). Resolves true once the server accepts it, false if they cancel.
let codeAsk=null;
function askCode(company){
 if(codeAsk)return codeAsk;
 const box=el('codePanel'),inp=el('companyCode'),err=el('codeStatus'),go=el('codeOpen'),no=el('codeCancel');
 const opt=el('company').selectedOptions[0];el('codeFor').textContent=opt?opt.textContent:'this business';
 inp.value='';err.hidden=true;box.hidden=false;inp.focus();box.scrollIntoView({block:'center'});
 return codeAsk=new Promise(res=>{
  let checking=false;
  const done=v=>{box.hidden=true;go.onclick=no.onclick=inp.oninput=inp.onkeydown=null;codeAsk=null;res(v)};
  const check=async()=>{if(checking)return;
   if(!/^\d{4}$/.test(inp.value)){err.textContent='The code is 4 digits.';err.hidden=false;return}
   checking=true;go.disabled=true;
   try{await request('/api/c/'+encodeURIComponent(company)+'/code/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:inp.value})});done(true)}
   catch(e){err.textContent=e.message;err.hidden=false;inp.value='';inp.focus()}
   finally{checking=false;go.disabled=false}};
  inp.oninput=()=>{inp.value=inp.value.replace(/\D/g,'').slice(0,4);err.hidden=true;if(inp.value.length===4)check()};
  inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();check()}};
  go.onclick=check;no.onclick=()=>done(false);
 });
}
const b64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read the file'));reader.readAsDataURL(file)});
async function upload(files){if(busy)return;const company=el('company').value;if(!company)return showStatus('Select a business first.',true);busy=true;
 try{let ok=0,dup=0;for(let i=0;i<files.length;i++){let f=files[i];
 if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(f.type)){showStatus(f.name+' is not a supported image or PDF.',true);continue}
 showStatus('Uploading '+(i+1)+' of '+files.length+': '+f.name);
 f=await shrink(f);
 if(f.size>10*1024*1024){showStatus(f.name+' is larger than 10 MB.',true);continue}
 try{const send=async()=>request('/api/c/'+encodeURIComponent(company)+'/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileName:f.name,mediaType:f.type,data:await b64(f)})});
 let out;try{out=await send()}catch(e){if(!e.codeRequired)throw e;showStatus('This business needs its 4-digit code.');if(!await askCode(company)){showStatus('Nothing was sent. Enter the business’s 4-digit code to send receipts to it.',true);break}showStatus('Uploading '+(i+1)+' of '+files.length+': '+f.name);out=await send()}
 if(out.duplicate){dup++;const div=document.createElement('div');div.className='file';div.textContent='• '+f.name+' (already sent, not added again)';note(div);continue}
 ok++;sent++;el('count').textContent=sent+' sent';const div=document.createElement('div');div.className='file';div.textContent='✓ '+f.name;note(div)}
 catch(e){showStatus('Could not upload '+f.name+': '+e.message,true)}}
 if(ok||dup)showStatus((ok?ok+' receipt'+(ok===1?'':'s')+' sent to Sumlora successfully.':'')+(ok&&dup?' ':'')+(dup?(dup===1?'1 receipt was':dup+' receipts were')+' already sent, so '+(dup===1?'it wasn’t':'they weren’t')+' added again.':''))}
 finally{busy=false;el('camera').value='';el('files').value=''}}
el('camera').addEventListener('change',e=>upload([...e.target.files]));
el('files').addEventListener('change',e=>upload([...e.target.files]));
async function submitScannerLogin(){
 if(signingIn)return;
 const status=el('loginStatus'),btn=el('loginButton');
 if(!loginTicket&&(!el('username').value.trim()||!el('password').value)){status.textContent='Enter your email and password.';status.className='notice error';status.hidden=false;return;}
 if(loginTicket&&!el('loginCode').value.trim()){status.textContent='Enter your verification code.';status.className='notice error';status.hidden=false;return;}
 signingIn=true;
 status.textContent='Signing in…';status.hidden=false;status.className='notice';btn.disabled=true;btn.textContent='Signing in…';
 try{
  const result=loginTicket
   ? await request('/api/auth/login/code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:loginTicket,code:el('loginCode').value.trim()})})
   : await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:el('username').value.trim(),password:el('password').value})});
  if(result.needCode){loginTicket=result.ticket;el('codeWrap').hidden=false;el('loginCode').required=true;el('loginCode').focus();status.textContent='Enter your verification code.';btn.textContent='Verify & sign in';return}
  loginTicket=null;el('password').value='';status.textContent='Signed in. Loading your companies…';await init();if(!el('scanner').hidden)status.hidden=true;
 }catch(err){status.textContent=err.message||'Sign-in failed. Try again.';status.className='notice error';status.hidden=false}
 finally{signingIn=false;btn.disabled=false;btn.textContent=loginTicket?'Verify & sign in':'Sign in'}
}
el('loginButton').addEventListener('click',submitScannerLogin);
el('loginForm').addEventListener('submit',e=>{e.preventDefault();submitScannerLogin()});
el('logout').addEventListener('click',async()=>{try{await request('/api/auth/logout',{method:'POST'})}catch{}loginTicket=null;el('loginForm').reset();el('codeWrap').hidden=true;el('loginButton').textContent='Sign in';await init()});
init();
