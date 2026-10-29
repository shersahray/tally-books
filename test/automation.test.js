'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../src/server/app');
const AUTO=require('../src/server/automation');
let server,base,dir,owner,staff;
const pw='correct horse battery staple';
async function req(method,url,body,cookie=owner){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json(),cookie:(r.headers.get('set-cookie')||'').split(';')[0]};}
const route=(id,s='')=>`/api/c/${id}/automation${s}`;
const settings={on:true,background:false,ai:false};
async function company(province='ON'){const r=await req('POST','/api/companies',{name:'Automation pilot',province});assert.equal(r.status,200);return r.json.company.id;}
const st=id=>server.registry.store(id);
function bankLine(id,key='b',amount=-113,desc='ROGERS'){st(id).put('bankTxns',key,{date:'2026-10-15',amount,desc,account:'a1000',status:'new'});}
function rule(id){st(id).put('rules','rule',{text:'ROGERS',direction:'out',account:'a6500',tax:true});}
async function enable(id,extra={}){const r=await req('PUT',route(id),{...settings,...extra});assert.equal(r.status,200,JSON.stringify(r.json));}
async function draft(id,key='bank:b'){const r=await req('GET',route(id));assert.equal(r.status,200);return r.json.items.find(d=>d.id===key);}
const decide=(id,d,action='approve',reason)=>req('POST',route(id,'/drafts/'+encodeURIComponent(d.id)),{version:d.version,action,reason});
before(async()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'sumlora-auto-'));server=createApp({dataDir:dir,autoBackup:false,autoFeeds:false,autoWorkflows:false,autoAutomation:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;const setup=await req('POST','/api/auth/setup',{name:'Owner',username:'owner@example.com',password:pw,firmName:'Test firm'},null);assert.equal(setup.status,200,JSON.stringify(setup.json));owner=setup.cookie;
  await req('POST','/api/users',{name:'Staff',username:'staff@example.com',password:pw,role:'staff'});staff=(await req('POST','/api/auth/login',{username:'staff@example.com',password:pw},null)).cookie;await req('POST','/api/auth/password',{current:pw,password:pw+' new'},staff);
});
after(async()=>{await server.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
test('disabled by default, private drafts cannot bypass the posting API, company settings are isolated',async()=>{
 const id=await company(),other=await company();bankLine(id);rule(id);
 assert.equal((await req('GET',route(id))).json.config.on,false);await server.prepareAutomation(id,true);assert.equal(st(id).list(AUTO.COL).length,0);
 await enable(id);assert.equal((await req('GET',route(other))).json.items.length,0);assert.equal(st(id).list('entries').length,0);
 assert.equal((await req('PUT',`/api/c/${id}/records/_automation/forged`,{status:'approved'})).status,404);
 assert.equal((await req('POST',`/api/c/${id}/batch`,{writes:[{op:'set',collection:AUTO.COL,id:'forged',data:{status:'approved'}}]})).status,404);
 const state=(await req('GET',`/api/c/${id}/state`)).json;assert.equal(state[AUTO.COL],undefined);
 assert.equal((await req('GET',route(id),undefined,staff)).status,403);assert.equal((await req('PUT',route(id),settings,staff)).status,403);
});
test('prepare/edit do not post; approval posts balanced HST entry once, with audit trail',async()=>{
 const id=await company();bankLine(id);rule(id);await enable(id);let d=await draft(id);
 assert.equal(d.proposal.account,'a6500');assert.equal(st(id).list('entries').length,0);assert.equal(d.preview.reduce((s,l)=>s+l.debit-l.credit,0),0);
 const edited=await req('PUT',route(id,'/drafts/'+encodeURIComponent(d.id)),{version:d.version,account:'a6500',contactId:'',tax:'std'});assert.equal(edited.status,200,JSON.stringify(edited.json));
 assert.equal(st(id).list('entries').length,0);d=await draft(id);assert.equal(d.history[0].action,'edited');
 const results=await Promise.all([decide(id,d),decide(id,d)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const e=st(id).list('entries')[0];assert.equal(e.lines.find(l=>l.account==='a6500').debit,100);assert.equal(e.lines.find(l=>l.account==='a2200').debit,13);assert.equal(st(id).list('entries').length,1);
 assert.ok(st(id).auditList().some(a=>a.action==='automation-approve'));
});
test('stale sources are blocked, refresh replaces proposal and repeated preparation is idempotent',async()=>{
 const id=await company();bankLine(id);rule(id);await enable(id);const d=await draft(id);
 st(id).put('bankTxns','b',{...st(id).get('bankTxns','b'),amount:-226});assert.equal((await decide(id,d)).status,409);
 await req('POST',route(id,'/prepare'),{});const next=await draft(id);assert.ok(next.version>d.version);assert.equal(next.amount,-226);
 await req('POST',route(id,'/prepare'),{});assert.equal((await draft(id)).version,next.version);assert.equal(st(id).list(AUTO.COL).length,1);
 assert.equal((await decide(id,next)).status,200);
});
test('reject requires reason and never posts or gets silently requeued',async()=>{
 const id=await company();bankLine(id);rule(id);await enable(id);const d=await draft(id);
 assert.equal((await decide(id,d,'reject')).status,400);assert.equal((await decide(id,d,'reject','Personal purchase')).status,200);
 await req('POST',route(id,'/prepare'),{});assert.equal((await draft(id)).status,'rejected');assert.equal(st(id).list('entries').length,0);
});
test('closed period and held bill approvals use ordinary server validation and roll back the whole approval',async()=>{
 const id=await company();bankLine(id);rule(id);st(id).putSetting('closing',{date:'2026-10-31'});await enable(id);const d=await draft(id);
 assert.equal((await decide(id,d)).status,423);assert.equal(st(id).list('entries').length,0);assert.equal((await draft(id)).status,'pending');assert.equal(st(id).get('bankTxns','b').status,'new');
 const other=await company();bankLine(other);st(other).put('contacts','vendor',{name:'Vendor',kind:'vendor'});st(other).putSetting('company',{...st(other).getSetting('company'),approvals:{on:true,over:0,vendors:[],approvers:[]}});
 st(other).put('docs','bill',{kind:'bill',contactId:'vendor',date:'2026-10-15',due:'2026-10-30',total:113,lines:[{account:'a6500',qty:1,rate:113,taxCode:'none'}],approval:{status:'waiting',enteredBy:'staff@example.com',history:[]}});await enable(other);
 const bd=await draft(other);assert.equal(bd.proposal.kind,'match');assert.equal((await decide(other,bd)).status,409);assert.equal(st(other).list('entries').length,0);assert.equal((await draft(other)).status,'pending');
});
test('existing transaction match clears once without creating a second expense',async()=>{
 const id=await company();bankLine(id);st(id).put('entries','existing',{type:'expense',date:'2026-10-15',memo:'Already recorded',lines:[{account:'a6500',debit:113,credit:0},{account:'a1000',debit:0,credit:113}]});await enable(id);const d=await draft(id);
 assert.equal(d.proposal.target.id,'existing');assert.equal((await decide(id,d)).status,200);assert.equal(st(id).list('entries').length,1);assert.equal(st(id).get('entries','existing').clear.a1000,'c');
});
test('ambiguity, foreign currency, missing categories and standalone receipts require review',async()=>{
 const id=await company();bankLine(id);for(const key of ['x','y'])st(id).put('entries',key,{type:'expense',date:'2026-10-15',lines:[{account:'a6500',debit:113,credit:0},{account:'a1000',debit:0,credit:113}]});await enable(id);let d=await draft(id);assert.ok(d.warnings.length);assert.equal((await decide(id,d)).status,409);
 const other=await company();bankLine(other);await enable(other);d=await draft(other);assert.ok(d.problem);assert.equal((await decide(other,d)).status,400);
 const fx=await company();bankLine(fx);rule(fx);st(fx).put('accounts','a1000',{...st(fx).get('accounts','a1000'),currency:'USD'});await enable(fx);assert.ok((await draft(fx)).warnings.length);
});
test('receipt grouped with a unique bank line is attached atomically; duplicate candidates block approval',async()=>{
 const id=await company();bankLine(id);rule(id);const s=st(id);s.putFile('file',{mediaType:'image/png',data:Buffer.from('photo')});s.put('receipts','r',{status:'inbox',fileId:'file',fileName:'receipt.png',mediaType:'image/png',draft:{date:'2026-10-15',total:113,currency:'',paid:true,lines:[],taxes:[]}});await enable(id);const d=await draft(id);assert.equal(d.receiptId,'r');assert.equal((await decide(id,d)).status,200);
 const e=s.list('entries')[0];assert.equal(e.receiptId,'r');assert.equal(s.get('receipts','r').entryId,e.id);
 const other=await company();bankLine(other);rule(other);for(const k of ['r1','r2'])st(other).put('receipts',k,{status:'inbox',draft:{date:'2026-10-15',total:113}});await enable(other);assert.ok((await draft(other)).warnings.length);assert.equal((await decide(other,await draft(other))).status,409);
});
test('background prepares without posting, survives restart; disabled companies are skipped',async()=>{
 const id=await company();bankLine(id);rule(id);await enable(id,{background:true});await server.prepareAutomation(id);assert.equal(st(id).list('entries').length,0);assert.equal(st(id).list(AUTO.COL).length,1);
 const other=await company();bankLine(other);rule(other);assert.equal((await server.prepareAutomation(other)).skipped,true);
 await server.shutdown();server=createApp({dataDir:dir,autoBackup:false,autoFeeds:false,autoWorkflows:false,autoAutomation:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 owner=(await req('POST','/api/auth/login',{username:'owner@example.com',password:pw},null)).cookie;
 assert.equal(st(id).list(AUTO.COL).length,1);assert.equal(AUTO.cfg(st(id)).background,true);await server.prepareAutomation(id);assert.equal(st(id).list('entries').length,0);
});
test('Quebec splits GST/QST and BC capitalizes nonrecoverable PST; deposits balance too',async()=>{
 for(const [province,amount,net,tax] of [['QC',-114.98,100,14.98],['BC',-112,107,5],['ON',113,100,13]]){
 const id=await company(province);if(province==='BC'){st(id).put('accounts','pst',{code:'2210',name:'PST payable',type:'Liability',detail:'pst'});st(id).putSetting('company',{...st(id).getSetting('company'),pstRate:7,taxRate:12});}
 bankLine(id,'b',amount);rule(id);if(amount>0)st(id).put('rules','rule',{text:'ROGERS',direction:'in',account:'a4000',tax:true});await enable(id);const d=await draft(id);assert.equal((await decide(id,d)).status,200,province);
 const e=st(id).list('entries')[0];assert.equal(e.lines.find(l=>l.account===(amount>0?'a4000':'a6500'))[amount>0?'credit':'debit'],net);assert.equal(rnd(e.lines.filter(l=>['a2200','a2210'].includes(l.account)).reduce((s,l)=>s+(amount>0?l.credit:l.debit),0)),tax);}
});
const rnd=n=>Math.round(n*100)/100;
test('background AI is explicit, bounded and discards results when sources change during the request',async()=>{
 const {AI}=require('../src/server/ai'),original=AI.prototype.suggest;let calls=0,release,entered;
 const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 try{
  const set=await req('PUT','/api/ai',{apiKey:'sk-ant-api03-'+'x'.repeat(40),capUsd:5});assert.equal(set.status,200);
  const id=await company();bankLine(id);st(id).putSetting('company',{...st(id).getSetting('company'),ai:true});
  AI.prototype.suggest=async()=>{calls++;entered();await hold;return {suggestions:{b:{account:'a6500',tax:true,confidence:'high',reason:'Mock AI'}},usd:0};};
  await enable(id,{background:true});await server.prepareAutomation(id);assert.equal(calls,0,'AI defaults off');
  await enable(id,{background:true,ai:true});const pending=server.prepareAutomation(id);await ready;
  st(id).put('bankTxns','b',{...st(id).get('bankTxns','b'),amount:-226});release();await pending;
  assert.equal(st(id).get('bankTxns','b').ai,undefined,'stale result discarded');assert.equal(st(id).list('entries').length,0);
  await server.prepareAutomation(id);assert.equal(calls,1,'30 minute cooldown');
  st(id).putSetting('automationUsage',{day:new Date().toISOString().slice(0,10),count:100,lastAttempt:0});await server.prepareAutomation(id);assert.equal(calls,1,'daily attempt limit');
  st(id).putSetting('automationUsage',{});AI.prototype.suggest=async()=>{calls++;return {suggestions:{b:{account:'a6500',tax:true,confidence:'high',reason:'Mock AI'}},usd:0};};
  await server.prepareAutomation(id);assert.equal(st(id).get('bankTxns','b').ai.account,'a6500');assert.equal((await draft(id)).proposal.confidence,'high');assert.equal(st(id).list('entries').length,0);
  await req('PUT',route(id),{on:false,background:false,ai:false});assert.equal((await decide(id,await draft(id))).status,409);assert.equal((await server.prepareAutomation(id)).skipped,true);
 }finally{release?.();AI.prototype.suggest=original;}
});
