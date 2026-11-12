'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { createSeoStudio }=require('../src/server/seo-studio');
const { createSeoAdvanced,buildArticle,keywordOpportunities,optimizeDraft,renderMarkdown }=require('../src/server/seo-advanced');

function setup(t, options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'seo-full-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const studio=createSeoStudio(dir);
  return {studio,advanced:createSeoAdvanced(studio,options)};
}
test('XSS payload is escaped in generated article and draft approval is mandatory',async t=>{
  const {studio,advanced}=setup(t);
  const d=await studio.draft({topic:'Best bookkeeping software in Canada',keyword:'bookkeeping software canada'});
  await assert.rejects(async()=>advanced.preparePr(d.id),/disabled/i);
  const reviewed=studio.updateDraft(d.id,{status:'approved',content:'# Canadian bookkeeping\n\n<script>alert(1)</script>\n\n## Considerations'});
  const page=buildArticle(reviewed);
  assert.match(page.page,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page.page,/<script>alert/);
  assert.equal(page.canonical,'https://sumlora.ca/blog/best-bookkeeping-software-in-canada/');
  assert.equal(page.path,'blog/best-bookkeeping-software-in-canada/index.html');
  assert.equal(advanced.publishingEnabled(),false);
  assert.equal(studio.state().drafts[0].published,false);
});
test('Scheduled PR creation stays off unless explicitly configured',async t=>{
  const {studio,advanced}=setup(t);
  const d=await studio.draft({topic:'Audit automation for accounting firms',keyword:'audit automation'});
  await assert.rejects(async()=>advanced.schedule(d.id,new Date(Date.now()+86400000).toISOString()),/Approve/);
  studio.updateDraft(d.id,{status:'approved'});
  const day=new Date(Date.now()+86400000).toISOString();
  assert.equal(advanced.schedule(d.id,day).scheduledAt,day);
  assert.deepEqual(await advanced.createDuePrs(),{skipped:true,reason:'Scheduled PR creation disabled'});
  assert.equal(advanced.cancelSchedule(d.id).cancelled,true);
});
test('Publishing prepares a draft GitHub PR and updates sitemap, not main',async t=>{
  const calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,init});
    const json=x=>({ok:true,json:async()=>x});
    if(url.endsWith('/git/ref/heads/main'))return json({object:{sha:'mainsha'}});
    if(url.endsWith('/git/refs'))return json({ref:'refs/heads/seo/approved-test'});
    if(url.includes('/contents/sitemap.xml?'))return json({sha:'sitemapsha',content:Buffer.from('<?xml version="1.0"?><urlset></urlset>').toString('base64')});
    if(url.endsWith('/pulls'))return json({html_url:'https://github.com/shersahray/sumlora-website/pull/100'});
    return json({content:{sha:'x'}});
  };
  const {studio,advanced}=setup(t,{githubToken:'TEST-NOT-REAL',publishEnabled:true,fetchImpl});
  const d=await studio.draft({topic:'Bookkeeping guide for Canada',keyword:'bookkeeping canada'});
  studio.updateDraft(d.id,{status:'approved'});
  const result=await advanced.preparePr(d.id);
  assert.equal(result.url,'https://github.com/shersahray/sumlora-website/pull/100');
  assert.equal(studio.state().drafts[0].publishPrUrl,result.url);
  assert.equal(studio.state().drafts[0].published,false);
  assert.equal(calls.filter(c=>c.url.endsWith('/contents/sitemap.xml')&&c.init.method==='PUT').length,1);
  const pr=JSON.parse(calls.find(c=>c.url.endsWith('/pulls')).init.body);
  assert.equal(pr.draft,true);
  assert.equal(pr.base,'main');
  assert.ok(calls.every(c=>!c.init.body || !c.init.body.includes('auto_merge')));
});
test('Search opportunities use measured GSC impressions; missing data does not create fake values',()=>{
  assert.deepEqual(keywordOpportunities(null),[]);
  const hits=keywordOpportunities({queries:[{key:'bookkeeping canada',impressions:150,clicks:2,ctr:.013,position:12}]});
  assert.equal(hits[0].query,'bookkeeping canada');
  assert.ok(hits[0].reasons.length);
  assert.match(hits[0].source,/Search Console/);
});
test('Content optimizer reports verification items without rewriting article',()=>{
  const d={id:'a',topic:'Canadian sales tax',keyword:'gst qst',content:'# Canadian sales tax\n\n[VERIFY] all legal rates'};
  const result=optimizeDraft(d);
  assert.ok(result.checks.some(x=>x.level==='critical'));
  assert.equal(d.content,'# Canadian sales tax\n\n[VERIFY] all legal rates');
});
test('Lead attribution stores anonymous, manual events and validates URLs',t=>{
  const {advanced}=setup(t);
  const e=advanced.recordLead({source:'Google Search',channel:'organic',page:'/blog/guide/',campaign:'canada'});
  assert.equal(e.outcome,'demo-request');
  assert.equal(advanced.leads().total,1);
  assert.equal(advanced.leads().byChannel[0].channel,'organic');
  assert.throws(()=>advanced.recordLead({source:'Google',channel:'organic',page:'https://evil.example/'}),/Sumlora/);
});
test('Safe Markdown rendering never executes raw tags',()=>{
  assert.equal(renderMarkdown('## Heading\n<script>alert(1)</script>').includes('<script>'),false);
});