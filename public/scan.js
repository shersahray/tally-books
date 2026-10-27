'use strict';
const el=id=>document.getElementById(id);
let sent=0,busy=false;
function showStatus(message,error=false){const x=el('status');x.hidden=false;x.textContent=message;x.className='notice'+(error?' error':'')}
async function request(url,options={}){const r=await fetch(url,{credentials:'same-origin',...options});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error||('Request failed ('+r.status+')'));return body}
async function init(){
 try{
  await request('/api/auth/me');
  const d=await request('/api/companies');
  const companies=d.companies||[];
  const list=el('company');list.replaceChildren();
  for(const company of companies){const option=document.createElement('option');option.value=company.id;option.textContent=company.name;list.append(option)}
  el('signIn').hidden=true;el('scanner').hidden=!companies.length;
  if(!companies.length){el('signIn').hidden=false;el('signIn').querySelector('h2').textContent='No business available';}
 }catch{el('signIn').hidden=false;el('scanner').hidden=true}
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
el('retry').addEventListener('click',init);
init();
