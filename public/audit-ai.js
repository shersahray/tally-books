'use strict';
const el=id=>document.getElementById(id);
const id=()=>encodeURIComponent(el('company').value.trim());
const status=(message)=>{el('status').textContent=message;};
async function api(url,method='GET',data) {
 const response=await fetch(url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,credentials:'same-origin'});
 const body=await response.json();
 if(!response.ok)throw new Error(body.error||body.message||'Request failed ('+response.status+')');
 return body;
}
async function execute(job) {try{await job();}catch(error){status(error.message);}}
async function load() {
 const {evidence}=await api('/api/audit-ai/'+id()+'/evidence');
 const root=el('evidence');root.replaceChildren();
 for(const entry of evidence) {
  const card=document.createElement('section');card.style='border:1px solid #aaa;padding:1rem;margin:.5rem 0';
  const heading=document.createElement('h3');heading.textContent=entry.name+' — '+entry.reviewStatus;
  const info=document.createElement('pre');info.textContent=JSON.stringify(entry.fields,null,2);
  const note=document.createElement('input');note.placeholder='Review note';note.maxLength=2000;
  const view=document.createElement('button');view.textContent='View PDF';
  view.onclick=()=>execute(async()=>{
   const {data}=await api('/api/audit-ai/'+id()+'/evidence/'+encodeURIComponent(entry.id));
   const binary=atob(data),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
   const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
   window.open(url,'_blank','noopener,noreferrer');setTimeout(()=>URL.revokeObjectURL(url),60000);
  });
  card.append(heading,info,view,note);
  for(const decision of ['approved','rejected']) {
   const b=document.createElement('button');b.textContent=decision;
   b.onclick=()=>execute(async()=>{await api('/api/audit-ai/'+id()+'/evidence/'+encodeURIComponent(entry.id)+'/review','POST',{decision,note:note.value});await load();});
   card.append(b);
  }
  root.append(card);
 }
 status(evidence.length+' documents found');
}
el('load').onclick=()=>execute(load);
el('upload').onclick=()=>execute(async()=>{
 const file=el('file').files[0];
 if(!file||file.size>10*1024*1024)throw new Error('Select a PDF no larger than 10 MiB');
 const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
 await api('/api/audit-ai/'+id()+'/evidence','POST',{name:file.name,data});
 await load();
});
el('ledger').onclick=()=>execute(async()=>{
 const {transactions}=await api('/api/audit-ai/'+id()+'/ledger');
 el('transactions').value=JSON.stringify(transactions,null,2);
 status(transactions.length+' balanced GL entries loaded. Verify debit totals before matching.');
});
el('match').onclick=()=>execute(async()=>{
 const transactions=JSON.parse(el('transactions').value);
 const result=await api('/api/audit-ai/'+id()+'/match','POST',{transactions});

 const area=el('results');
 area.replaceChildren();
 const summary=document.createElement('pre');summary.textContent=JSON.stringify(result.matches,null,2);area.append(summary);
 for(const match of result.matches||[]){
  for(const candidate of (match.candidates||[]).slice(0,3)){
   const row=document.createElement('div');row.style='padding:.5rem;border:1px solid #999;margin:.4rem 0';
   const label=document.createElement('span');label.textContent='GL '+match.transactionId+' / PDF '+candidate.documentId+' (score '+candidate.score+') ';
   const note=document.createElement('input');note.placeholder='Review note';note.maxLength=2000;
   row.append(label,note);
   for(const decision of ['approved','rejected']){
    const button=document.createElement('button');button.textContent=decision;
    button.onclick=()=>execute(async()=>{
     await api('/api/audit-ai/'+id()+'/pair-reviews','POST',{entryId:match.transactionId,evidenceId:candidate.documentId,decision,note:note.value});
     status('Accountant '+decision+' this GL-to-evidence pair. No accounting entry was changed.');
    });
    row.append(button);
   }
   area.append(row);
  }
 }

});
async function adminList() {
 const {companies}=await api('/api/overview/audit-ai');const root=el('companies');root.replaceChildren();
 for(const company of companies){
  const item=document.createElement('p');item.textContent=company.firmName+' / '+company.name+' ';
  const toggle=document.createElement('button');toggle.textContent=company.entitled?'Disable Audit AI':'Enable Audit AI';
  toggle.onclick=()=>execute(async()=>{
   if(!confirm('Change Audit AI paid access for '+company.name+'?'))return;
   await api('/api/overview/audit-ai/'+encodeURIComponent(company.id),'PUT',{entitled:!company.entitled});
   await adminList();
  });
  item.append(toggle);root.append(item);
 }
}
el('refresh').onclick=()=>execute(adminList);
api('/api/overview/audit-ai').then(()=>{el('admin').hidden=false;return adminList();}).catch(()=>{});
