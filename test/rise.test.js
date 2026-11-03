'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Rise } = require('../src/server/rise');
const { createApp } = require('../src/server/app');
const response = (body, status=200) => ({ ok:status<400,status,json:async()=>body });
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sumlora-rise-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls=[];
  const rise=new Rise(dir,{fetch:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/oauth/token')) return response({access_token:'secret-access',refresh_token:'secret-refresh',expires_in:3600,token_type:'Bearer'});
    if(url.endsWith('/oauth/revoke')) return response({});
    if(url.includes('/employees?'))return response({data:[{id:'e1',attributes:{first_name:'Avery',last_name:'Tran',status:'active',sin:'NEVER-RETURN'}}],links:{next:'https://evil.example/steal'}});
    return response({data:[{id:'r1',attributes:{title:'Payroll register'}}]});
  }});
  rise.update({clientId:'test-public-client'});
  return {rise,dir,calls};
}
async function connect(rise,cid='co1'){
  await rise.enable(cid,true);
  const u=new URL(rise.start(cid,'owner','https://sumlora.example/api/rise/callback'));
  await rise.finish({state:u.searchParams.get('state'),code:'one-time-code'},()=>true);
  return u;
}
test('Rise: PKCE, one-use state, encrypted tokens, company isolation and minimal preview',async t=>{
  const {rise,dir,calls}=fixture(t);const u=await connect(rise);
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  assert.equal(u.searchParams.get('scope'),'reports:read');
  const exchange=new URLSearchParams(calls[0].init.body);
  assert.equal(require('node:crypto').createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'),u.searchParams.get('code_challenge'));
  await assert.rejects(rise.finish({state:u.searchParams.get('state'),code:'replay'},()=>true));
  const raw=fs.readFileSync(path.join(dir,'rise.json'),'utf8');
  assert.ok(!raw.includes('secret-access')&&!raw.includes('secret-refresh'));
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(dir,'rise.key')).mode&0o077,0);
  assert.equal(new Rise(dir).status('co1').connected,true);
  await assert.rejects(rise.preview('co2'),{status:403});
  const preview=await rise.preview('co1');
  assert.equal(preview.employees[0].name,'Avery Tran'); assert.equal(preview.partial,true);
  assert.ok(!JSON.stringify(preview).includes('NEVER-RETURN'));
  assert.ok(calls.every(c=>c.url.startsWith('https://api.risepeople.com/v1/')));
  assert.throws(()=>rise.unseal('co2',rise.data.connections.co1.tokens));
});
test('Rise: disabled, expired, cancelled and revoked-access callbacks fail closed',async t=>{
  const {rise}=fixture(t);
  assert.throws(()=>rise.start('co1','owner','https://example.com/cb'),{status:403});
  await rise.enable('co1',true);
  assert.throws(()=>rise.start('co1','owner','http://example.com/cb'));
  for(const reason of ['expired','denied','disabled','access']){
    const state=new URL(rise.start('co1','owner','https://example.com/cb')).searchParams.get('state');
    if(reason==='expired')rise.states.get(state).expires=0;
    if(reason==='disabled')await rise.enable('co1',false);
    await assert.rejects(rise.finish({state,code:'code',...(reason==='denied'?{error:'denied'}:{})},()=>reason!=='access'));
    await rise.enable('co1',true);
  }
  assert.equal(rise.status('co1').connected,false);
});
test('Rise: refresh is serialized; disconnect during refresh cannot resurrect connection',async t=>{
  const {rise,calls}=fixture(t);await connect(rise);
  let c=rise.data.connections.co1; c.tokens=rise.seal('co1',{access_token:'old',refresh_token:'refresh',expires:0});
  await Promise.all([rise.preview('co1'),rise.preview('co1')]);
  assert.equal(calls.filter(c=>c.url.endsWith('/oauth/token')).length,2);
  c.tokens=rise.seal('co1',{access_token:'old',refresh_token:'refresh',expires:0});
  let release;
  rise.fetch=async(url)=>url.endsWith('/oauth/token')?new Promise(r=>release=r):response({});
  const pending=rise.access('co1');
  await rise.remove('co1');
  release(response({access_token:'fresh',refresh_token:'rotated',expires_in:3600}));
  await assert.rejects(pending,{status:409});
  assert.equal(rise.status('co1').connected,false);
});
test('Rise: provider errors do not expose tokens or internal response bodies',async t=>{
  const {rise}=fixture(t);await connect(rise);
  rise.fetch=async()=>response({error:'secret-access',detail:'sensitive-personal-data'},403);
  await assert.rejects(rise.preview('co1'),e=>!e.message.includes('secret-access')&&!e.message.includes('sensitive-personal-data'));
});
test('Rise API: administrator enablement, OAuth callback and owner-only company access',async t=>{
  const {rise:fake}=fixture(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sumlora-rise-api-'));
  const server=createApp({dataDir:dir,publicUrl:'https://sumlora.example',autoFeeds:false,autoBackup:false,autoWorkflows:false,riseFetch:fake.fetch});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await server.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  let cookie='';
  async function call(method,url,body,auth=true){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(auth?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.text(),headers:r.headers};}
  const setup=await call('POST','/api/auth/setup',{name:'Owner',username:'owner@example.com',password:'correct horse battery staple'});
  cookie=setup.headers.get('set-cookie').split(';')[0];
  const co=JSON.parse((await call('POST','/api/companies',{name:'Rise Pilot',province:'ON'})).body).company.id;
  assert.equal((await call('GET','/api/rise',undefined,false)).status,401);
  assert.equal((await call('POST',`/api/c/${co}/rise/connect`,{confirmCompany:true})).status,403);
  assert.equal((await call('PUT','/api/rise',{clientId:'test-public-client'})).status,200);
  assert.equal((await call('PUT',`/api/rise/companies/${co}`,{enabled:true})).status,200);
  assert.equal((await call('POST',`/api/c/${co}/rise/connect`,{})).status,400);
  const begin=await call('POST',`/api/c/${co}/rise/connect`,{confirmCompany:true}); assert.equal(begin.status,200);
  const state=new URL(JSON.parse(begin.body).url).searchParams.get('state');
  const callback=await call('GET','/api/rise/callback?state='+state+'&code=code',undefined,false);
  assert.equal(callback.status,200);assert.ok(callback.body.includes('Rise connected'));
  const preview=await call('GET',`/api/c/${co}/rise/preview`);assert.equal(preview.status,200);assert.ok(!preview.body.includes('secret-access'));
  const ownerCookie=cookie;
  const staff=await call('POST','/api/users',{name:'Staff',username:'staff@example.com',password:'temporary pass 123',role:'staff',companies:[co]});
  assert.equal(staff.status,200);
  const login=await call('POST','/api/auth/login',{username:'staff@example.com',password:'temporary pass 123'});
  cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST','/api/auth/password',{current:'temporary pass 123',password:'violet mountains under silver clouds'})).status,200);
  assert.equal((await call('GET','/api/rise')).status,403);
  assert.equal((await call('GET',`/api/c/${co}/rise/preview`)).status,403);
  assert.equal((await call('PUT',`/api/rise/companies/${co}`,{enabled:false})).status,403);
  cookie=ownerCookie;
  assert.equal((await call('PUT',`/api/rise/companies/${co}`,{enabled:false})).status,200);
  assert.equal((await call('GET',`/api/c/${co}/rise/preview`)).status,403);
});

test('Rise: disconnect invalidates OAuth exchange already in flight',async t=>{
  const {rise}=fixture(t);await rise.enable('co1',true);
  const state=new URL(rise.start('co1','owner','https://example.com/cb')).searchParams.get('state');
  let release;rise.fetch=()=>new Promise(r=>release=r);
  const pending=rise.finish({state,code:'code'},()=>true);
  await rise.remove('co1');
  release(response({access_token:'fresh',expires_in:3600}));
  await assert.rejects(pending,{status:403});
  assert.equal(rise.status('co1').connected,false);
});
