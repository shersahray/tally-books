'use strict';
const el=id=>document.getElementById(id);
let sent=0,busy=false,loginTicket=null;
function showStatus(message,error=false){const x=el('status');x.hidden=false;x.textContent=message;x.className='notice'+(error?' error':'')}
async function request(url,options={}){const r=await fetch(url,{credentials:'same-origin',...options});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error||('Request failed ('+r.status+')'));return body}
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
const b64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read the file'));reader.readAsDataURL(file)});
async function upload(files){if(busy)return;const company=el('company').value;if(!company)return showStatus('Select a business first.',true);busy=true;
 try{let ok=0;for(let i=0;i<files.length;i++){const f=files[i];if(f.size>10*1024*1024){showStatus(f.name+' is larger than 10 MB.',true);continue}
 if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(f.type)){showStatus(f.name+' is not a supported image or PDF.',true);continue}
 showStatus('Uploading '+(i+1)+' of '+files.length+': '+f.name);
 try{await request('/api/c/'+encodeURIComponent(company)+'/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileName:f.name,mediaType:f.type,data:await b64(f)})});
 ok++;sent++;el('count').textContent=sent+' sent';if(sent===1)el('history').textContent='';const div=document.createElement('div');div.className='file';div.textContent='✓ '+f.name;el('history').prepend(div)}
 catch(e){showStatus('Could not upload '+f.name+': '+e.message,true)}}
 if(ok)showStatus(ok+' receipt'+(ok===1?'':'s')+' sent to Sumlora successfully.')}
 }finally{busy=false;el('camera').value='';el('files').value=''}}
el('camera').addEventListener('change',e=>upload([...e.target.files]));
el('files').addEventListener('change',e=>upload([...e.target.files]));
el('loginForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const status=el('loginStatus'),btn=el('loginButton');
 status.textContent='Signing in…';status.hidden=false;status.className='notice';btn.disabled=true;btn.textContent='Signing in…';
 try{
  const result=loginTicket
   ? await request('/api/auth/login/code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:loginTicket,code:el('loginCode').value.trim()})})
   : await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:el('username').value.trim(),password:el('password').value})});
  if(result.needCode){loginTicket=result.ticket;el('codeWrap').hidden=false;el('loginCode').required=true;el('loginCode').focus();status.textContent='Enter your verification code.';btn.textContent='Verify & sign in';return}
  loginTicket=null;el('password').value='';status.textContent='Signed in. Loading your companies…';await init();if(!el('scanner').hidden)status.hidden=true;
 }catch(err){status.textContent=err.message||'Sign-in failed. Try again.';status.className='notice error';status.hidden=false}
 finally{btn.disabled=false;btn.textContent=loginTicket?'Verify & sign in':'Sign in'}
});
el('logout').addEventListener('click',async()=>{try{await request('/api/auth/logout',{method:'POST'})}catch{}loginTicket=null;el('loginForm').reset();el('codeWrap').hidden=true;el('loginButton').textContent='Sign in';await init()});
init();
