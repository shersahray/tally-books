'use strict';
// SEO Studio advanced workflows: explicit publishing PRs, discovery, comparisons,
// recommendations and manually recorded lead attribution. No client ledger access.
const crypto = require('node:crypto');
const SITE = 'https://sumlora.ca';
const OWNER = 'shersahray';
const REPO = 'sumlora-website';
const ghApi = 'https://api.github.com';
const COMPETITORS = Object.freeze([
  { name: 'QuickBooks Canada', url: 'https://quickbooks.intuit.com/ca/' },
  { name: 'Sage Canada', url: 'https://www.sage.com/en-ca/' },
]);
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const clean = (v,n=160) => String(v ?? '').trim().slice(0,n);
const slugify = s => clean(s,130).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,75);
const html = x => String(x).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titleCase = x => x.replace(/(^|\s)\w/g, c => c.toUpperCase());
function renderMarkdown(markdown) {
  // Render minimal Markdown safely; never allow untrusted raw HTML or inline JS.
  const lines = String(markdown).split(/\r?\n/);
  return lines.map(line => {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) { const level = m[1].length; return '<h'+level+'>'+html(m[2])+'</h'+level+'>'; }
    if (/^\s*[-*]\s+/.test(line)) return '<p class="bullet">• '+html(line.replace(/^\s*[-*]\s+/,''))+'</p>';
    return line.trim() ? '<p>'+html(line)+'</p>' : '';
  }).join('\n');
}
function buildArticle(draft) {
  if (draft.status!=='approved') throw fail('Approve the draft before preparing a publishing PR.',409);
  const slug=slugify(draft.topic);
  if (!slug || slug.length < 5) throw fail('Invalid article slug.');
  const canonical=SITE+'/blog/'+slug+'/';
  const heading=clean(draft.topic,130), desc=clean(draft.description || 'A practical guide for Canadian businesses and accounting professionals: '+draft.topic,158);
  const body=renderMarkdown(draft.content);
  const page='<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>'+html(heading+' | Sumlora')+'</title><meta name="description" content="'+html(desc)+'">'+
    '<link rel="canonical" href="'+html(canonical)+'"><meta name="robots" content="index,follow">'+
    '<meta property="og:type" content="article"><meta property="og:title" content="'+html(heading)+'">'+
    '<meta property="og:description" content="'+html(desc)+'"><meta property="og:url" content="'+html(canonical)+'">'+
    '<meta name="theme-color" content="#050b10">'+
    '<style>body{background:#050b10;color:#e6f7f3;font:17px/1.8 system-ui,sans-serif;margin:auto;padding:28px;max-width:800px}a{color:#69efc7}h1,h2,h3{line-height:1.25}p{margin:1em 0}.bullet{padding-left:1em}nav{margin-bottom:60px}footer{margin-top:65px;border-top:1px solid #30534b;padding-top:24px}</style>'+
    '</head><body><nav><a href="/">Sumlora</a> / <a href="/blog/">Articles</a></nav><main><article>'+body+
    '</article></main><footer><a href="mailto:info@sumlora.ca?subject=Sumlora%20demo%20request">Request a Sumlora demo</a> · <a href="/">Home</a></footer></body></html>\n';
  return {slug,canonical,path:'blog/'+slug+'/index.html',page,description:desc};
}
function keywordOpportunities(report, drafts=[]) {
  if (!report || !Array.isArray(report.queries)) return [];
  const known=new Set(drafts.map(d=>clean(d.keyword).toLowerCase()));
  return report.queries.filter(x=>x.impressions>=10).map(x=>{
    const q=clean(x.key,150),ctr=Number(x.ctr)||0,pos=Number(x.position)||0;
    const reasons=[];
    if (pos>=6 && pos<=30) reasons.push('Ranking on page one–three: consider a useful topic-specific page.');
    if (ctr<0.03 && x.impressions>=50) reasons.push('Low CTR relative to impressions: inspect title and description.');
    if (known.has(q.toLowerCase())) reasons.push('An existing draft targets this query.');
    return { query:q, impressions:Number(x.impressions)||0, clicks:Number(x.clicks)||0,
      ctr, position:pos, reasons, suggestion:known.has(q.toLowerCase())?'Review existing draft':'Consider a focused article',
      source:'Google Search Console — observed query, not keyword search volume' };
  }).filter(x=>x.reasons.length).sort((a,b)=>b.impressions-a.impressions).slice(0,30);
}
function optimizeDraft(d, existingTitles=[]) {
  const content=String(d.content||'');
  const words=content.trim().split(/\s+/).filter(Boolean).length;
  const keyword=String(d.keyword||'').toLowerCase();
  const title=String(d.topic||'');
  const checks=[];
  if (title.length>58) checks.push({level:'review',issue:'The title is lengthy; consider a shorter search-result title.'});
  if (!content.toLowerCase().includes(keyword)) checks.push({level:'review',issue:'The primary keyword does not appear verbatim in the content.'});
  if (!(content.match(/^## /gm)||[]).length) checks.push({level:'review',issue:'Add descriptive H2 subheadings.'});
  if (words<350) checks.push({level:'review',issue:'Short draft: check whether it fully answers the reader’s question; length alone is not a ranking factor.'});
  if (/\[VERIFY\]/.test(content)) checks.push({level:'critical',issue:'Fact-check all [VERIFY] statements before publication.'});
  if (!/sumlora/i.test(content)) checks.push({level:'review',issue:'Consider a relevant, non-intrusive Sumlora call to action.'});
  const related=existingTitles.filter(x=>x.id!==d.id && x.status==='published').slice(0,4).map(x=>({title:x.topic,url:x.url}));
  return {draftId:d.id,wordCount:words,checks,related,metaTitle:clean(title+' | Sumlora',65),
    suggestedDescription:clean('Explore '+title+'. Practical considerations for Canadian businesses and accounting firms.',155),
    note:'Heuristic recommendations only, not Google ranking guarantees. Review before applying.'};
}
function createSeoAdvanced(studio, options={}) {
  const fetcher=options.fetchImpl || fetch;
  const token=options.githubToken || '';
  const write=studio.mutate; // atomic persistence handled in SEO Studio
  const read=studio.state;
  const publishingEnabled=()=>options.publishEnabled===true && !!token;
  const limit=async (url, init={})=>{
    const res=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw fail('GitHub publishing API returned HTTP '+res.status+'. Check repository token permissions, branch protection, and existing paths.',502);
    return res.json();
  };
  const headers=()=>({'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'});
  function schedule(id, at) {
    const when=Date.parse(at);
    if (!Number.isFinite(when) || when<Date.now()-60000 || when>Date.now()+365*86400000) throw fail('Use an ISO date within the next 365 days.');
    return write(state=>{
      const draft=state.drafts.find(d=>d.id===id);
      if (!draft) throw fail('Draft not found.',404);
      if(draft.status!=='approved') throw fail('Approve the article before scheduling.',409);
      if (draft.publishPrUrl) throw fail('A publishing pull request already exists.',409);
      draft.scheduledAt=new Date(when).toISOString();
      return { draftId:id,scheduledAt:draft.scheduledAt, note:'Scheduling queues a publishing PR, not direct publication.' };
    });
  }
  function cancelSchedule(id){
    return write(state=>{const d=state.drafts.find(x=>x.id===id);if(!d)throw fail('Draft not found.',404);
      if(d.publishPrUrl)throw fail('Publishing PR already created.',409);
      delete d.scheduledAt;return {draftId:id,cancelled:true};});
  }
  async function preparePr(id) {
    if (!publishingEnabled()) throw fail('Publishing PR integration is disabled. Set SEO_GITHUB_PUBLISH_ENABLED=1 and a scoped SEO_GITHUB_TOKEN on the Sumlora server.',503);
    const state=read(),d=state.drafts.find(x=>x.id===id);
    if(!d)throw fail('Draft not found.',404);
    if(d.status!=='approved')throw fail('Draft requires approval.',409);
    if(d.publishPrUrl)return {url:d.publishPrUrl,existing:true};
    const article=buildArticle(d);
    const branch='seo/approved-'+article.slug.slice(0,42)+'-'+id.slice(0,8);
    const base=ghApi+'/repos/'+OWNER+'/'+REPO;
    // Check existing articles and ensure no duplicate page or branch is silently overwritten.
    const main=await limit(base+'/git/ref/heads/main',{headers:headers()});
    const branchResult=await limit(base+'/git/refs',{method:'POST',headers:headers(),body:JSON.stringify({ref:'refs/heads/'+branch,sha:main.object.sha})});
    if(!branchResult.ref)throw fail('Could not prepare the GitHub publishing branch.',502);
    const payload=(content,sha)=>JSON.stringify({message:'SEO: prepare '+article.slug,content:Buffer.from(content).toString('base64'),branch,...(sha?{sha}:{})});
    await limit(base+'/contents/'+article.path,{method:'PUT',headers:headers(),body:payload(article.page)});
    const sm=await limit(base+'/contents/sitemap.xml?ref='+encodeURIComponent(branch),{headers:headers()});
    const sitemap=Buffer.from(sm.content.replace(/\s/g,''),'base64').toString('utf8');
    if(sitemap.includes('<loc>'+article.canonical+'</loc>'))throw fail('This canonical URL is already in the sitemap; review the draft slug.',409);
    if(!sitemap.includes('</urlset>'))throw fail('Sitemap has an unexpected format.',502);
    const updated=sitemap.replace('</urlset>','  <url><loc>'+article.canonical+'</loc></url>\n</urlset>');
    await limit(base+'/contents/sitemap.xml',{method:'PUT',headers:headers(),body:payload(updated,sm.sha)});
    const pr=await limit(base+'/pulls',{method:'POST',headers:headers(),body:JSON.stringify({title:'SEO article: '+d.topic,head:branch,base:'main',draft:true,
      body:'Prepared from an approved Sumlora SEO Studio draft. Review factual claims, rendering, mobile UX, canonical URL and sitemap before merging. No auto-merge.'})});
    const url=String(pr.html_url||'');
    if(!/^https:\/\/github\.com\/shersahray\/sumlora-website\/pull\/\d+$/.test(url))throw fail('GitHub returned an unexpected PR response.',502);
    write(st=>{const item=st.drafts.find(x=>x.id===id);if(item){item.publishPrUrl=url;item.status='approved';delete item.scheduledAt;}});
    return {url,branch,articleUrl:article.canonical,preview:'GitHub draft PR; not deployed or indexed'};
  }
  async function createDuePrs(){
    if(!publishingEnabled() || options.scheduleEnabled!==true)return {skipped:true,reason:'Scheduled PR creation disabled'};
    const due=read().drafts.filter(d=>d.status==='approved'&&d.scheduledAt&&Date.parse(d.scheduledAt)<=Date.now()&&!d.publishPrUrl).slice(0,1);
    if(!due.length)return {processed:0};
    return {processed:1,result:await preparePr(due[0].id)};
  }
  function recordLead(input){
    const source=clean(input.source,120),campaign=clean(input.campaign,100),page=clean(input.page,220);
    const channel=clean(input.channel||'unknown',40);
    if(!['organic','direct','referral','social','email','paid','unknown'].includes(channel))throw fail('Invalid lead channel.');
    if (source.length<2)throw fail('Enter a lead source (e.g. Google Search or blog article).');
    if (page && !(/^https:\/\/sumlora\.ca(?:\/|$)/.test(page) || /^\/(?!\/)/.test(page)))throw fail('Only Sumlora page URLs may be recorded.');
    return write(s=>{s.leads=Array.isArray(s.leads)?s.leads:[];
      const event={id:crypto.randomUUID(),recordedAt:new Date().toISOString(),source,channel,campaign,page,
        outcome:'demo-request',note:'Manually recorded aggregate attribution; no customer name, email, IP or browser ID.'};
      s.leads.unshift(event);s.leads=s.leads.slice(0,500);return event;});
  }
  function leads(){
    const events=Array.isArray(read().leads)?read().leads:[];
    const byChannel=Object.entries(events.reduce((acc,e)=>{acc[e.channel]=(acc[e.channel]||0)+1;return acc;},{}))
      .map(([channel,count])=>({channel,count})).sort((a,b)=>b.count-a.count);
    return {total:events.length,byChannel,recent:events.slice(0,40),
      note:'Manual lead attribution. Not verified conversions from Google or automatic visitor tracking.'};
  }
  async function competitors(){
    const reports=[];
    for(const target of COMPETITORS){
      try{
        const res=await fetcher(target.url,{redirect:'manual',signal:AbortSignal.timeout(7000),headers:{'User-Agent':'SumloraSEOStudio/1.0'}});
        if(res.status!==200){reports.push({...target,status:res.status,note:'Unverified due to HTTP response. No ranking data.'});continue}
        const body=(await res.text()).slice(0,150000);
        const t=(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'';
        const description=(body.match(/<meta\s+[^>]*name=["']description["'][^>]*>/i)||[])[0]||'';
        reports.push({...target,status:200,title:clean(t.replace(/<[^>]*>/g,''),160),
          hasDescription:!!description,sectionCount:(body.match(/<h2\b/gi)||[]).length,
          note:'Public homepage metadata snapshot; not search rank, traffic or keyword gap.'});
      }catch(e){reports.push({...target,status:0,note:'Could not retrieve competitor homepage. No inferred data.'});}
    }
    return {checkedAt:new Date().toISOString(),reports,
      note:'Only named public competitor homepages; respect robots and manual review. No scraping of search results.'};
  }
  return { publishingEnabled,schedule,cancelSchedule,preparePr,createDuePrs,keywordOpportunities,optimizeDraft,recordLead,leads,competitors };
}
module.exports={createSeoAdvanced,buildArticle,keywordOpportunities,optimizeDraft,renderMarkdown,slugify};