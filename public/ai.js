'use strict';
/* ---------- AI suggestions (bank lines) ----------
   The server asks Claude for a category, payee and sales-tax flag for bank lines waiting for review,
   and saves the answer on each line as b.ai. It's only a suggestion: nothing is added to the books
   until someone clicks Add. The API key stays on the server. */
let AIS=null,aiTried=0,aiBusy=false;
async function loadAI(){try{AIS=await api('GET','/api/ai')}catch(e){AIS={configured:false,unavailable:true}}}
const usd=v=>isFr()?(+v||0).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})+' $ US':'US$'+(+v||0).toFixed(2);
const aiOn=()=>!!(AIS&&AIS.configured&&S.company.ai&&ME&&!ME.readOnly&&ME.role!=='client');

// Used by suggest() in banking.js, after matches, rules and "same as last time".
function aiSuggestion(b){
  const s=b.ai;if(!s||!acct(s.account)||s.account===b.account)return null;
  return{choice:'a:'+s.account,contactId:s.contactId&&contact(s.contactId)?s.contactId:'',tax:!!s.tax&&!!(+S.company.taxRate),why:'ai',ai:s};
}
function aiHint(sel){
  const s=sel.ai,lvl={high:'High',medium:'Medium',low:'Low'}[s.confidence]||'Low';
  return `<span class="hint ai ${s.confidence==='low'?'low':''}" title="${esc(s.reason||'')}">AI suggestion · ${lvl} confidence</span>${s.reason?`<span class="hint muted ai-why" translate="no">${esc(s.reason)}</span>`:''}`;
}
// Lines on screen that nothing else has a suggestion for.
function aiCandidates(a){return S.bankTxns.filter(b=>b.account===a.id&&b.status==='new'&&!b.ai&&!(S.bank.sel[b.id]&&S.bank.sel[b.id].user)&&suggest(b).why==='')}
function aiButton(a){
  if(!aiOn()||S.bank.show!=='new')return '';
  const n=aiCandidates(a).length;if(!n&&!aiBusy)return '';
  return `<button class="btn sm" data-bact="ai-suggest" ${aiBusy?'disabled':''} title="Ask AI to suggest a category for lines without one. You still review and add each line.">${aiBusy?'Asking AI…':`Suggest with AI (${n})`}</button>`;
}
async function aiSuggest(a){
  const ids=aiCandidates(a).map(b=>b.id).slice(0,200);if(!ids.length)return;
  aiBusy=true;renderMain();
  try{
    const r=await api('POST','/api/ai/suggest',{ids});
    aiBusy=false;await load();loadAI();
    toast(r.count?`AI suggested ${r.count} categor${r.count===1?'y':'ies'}. Review each line, then add it.`:'AI had no suggestions for these lines.');
  }catch(e){aiBusy=false;renderMain();toast(e.message,true)}
}

/* ---------- Settings panel ---------- */
function aiPanel(){
  if(!ME||ME.role==='client')return '';
  if(!AIS)return '';
  if(AIS.unavailable)return '';
  const owner=ME.role==='owner',c=S.company;
  const sw=`<label class="check"><input type="checkbox" id="aiCo" ${c.ai?'checked':''} ${AIS.configured?'':'disabled'}> Use AI suggestions for this company</label>`;
  const intro=`<div class="muted" style="font-size:13px">AI suggests a category, payee and sales tax for bank lines that rules and past choices don’t cover. It only suggests: you review every line and click Add. When you turn it on, each line’s date, description and amount, this company’s chart of accounts and payee names are sent to Anthropic (the maker of Claude) to be read. Anthropic doesn’t use data sent through its API to train its models. Tell your client if their engagement letter needs to say so.</div>`;
  if(!owner)return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>AI suggestions</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">${intro}${AIS.configured?sw:'<div class="muted">An owner sets up AI suggestions.</div>'}</div></div>`;
  if(AIS.demo)return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>AI suggestions</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">${intro}${sw}<div class="muted" style="font-size:13px"><b>In this demo,</b> suggestions are simple keyword guesses so you can see how the screen works. In Tally Books, an owner adds a Claude API key here and the suggestions come from Claude.</div></div></div>`;
  const pct=AIS.capUsd?Math.min(100,Math.round(AIS.spentUsd/AIS.capUsd*100)):0;
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>AI suggestions</h3><div class="pad" style="display:flex;flex-direction:column;gap:14px">
    ${intro}
    <div>${AIS.configured?`<span class="pill paid">Ready</span> API key ${AIS.source==='env'?'set on the server':'saved'} <span class="mono" translate="no">${esc(AIS.keyHint)}</span>`:'<span class="pill partial">Not set up</span> Add a Claude API key to start.'}</div>
    ${sw}
    <div class="fields">
      ${AIS.source==='env'?'':fld('aiKey',AIS.configured?'Replace API key':'Claude API key',`<input type="password" id="aiKey" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" translate="no"><span class="hint">From console.anthropic.com → API keys. It stays on this server and is never shown again.</span>`,true)}
      ${fld('aiModel','Model',`<select id="aiModel">${AIS.models.map(m=>`<option value="${m.id}" ${AIS.model===m.id?'selected':''}>${esc(m.label)}</option>`).join('')}</select>`)}
      ${fld('aiCap','Monthly limit (US$)',`<input type="number" id="aiCap" min="0" step="1" value="${AIS.capUsd}"><span class="hint">AI stops for the month at this amount, for all companies together.</span>`)}
    </div>
    <div><span class="flabel">This month</span><div class="meter" aria-hidden="true"><span style="width:${pct}%"></span></div><div class="muted" style="font-size:13px"><span translate="no">${usd(AIS.spentUsd)}</span> of <span translate="no">${usd(AIS.capUsd)}</span> · ${AIS.linesThisMonth} bank line${AIS.linesThisMonth===1?'':'s'}</div></div>
    <div class="actions"><button class="btn primary" data-aiact="save">Save AI settings</button>${AIS.configured&&AIS.source!=='env'?'<button class="btn ghost" data-aiact="remove">Remove API key</button>':''}</div>
  </div></div>`;
}
async function aiAction(act){
  try{
    if(act==='save'){
      const body={model:$('#aiModel').value,capUsd:+$('#aiCap').value||0};
      const k=$('#aiKey')?.value.trim();if(k)body.apiKey=k;
      AIS=await api('PUT','/api/ai',body);renderMain();toast(k?'API key saved':'AI settings saved');return;
    }
    if(act==='remove'){
      if(!await confirmBox('Remove the API key?','AI suggestions stop for every company until a key is added again. Suggestions already made stay on their bank lines.','Remove key'))return;
      AIS=await api('PUT','/api/ai',{apiKey:''});renderMain();toast('API key removed');return;
    }
  }catch(e){toast(e.message,true)}
}
function bindAI(m){
  const v=S.view==='settings'||S.view==='banking'||S.view==='expenses';
  if(v&&Date.now()-aiTried>30000&&(aiTried=Date.now()))loadAI().then(()=>{if(S.view==='settings'||S.view==='banking'||S.view==='expenses')renderMain()});
  const t=$('#aiCo',m);if(t)t.onchange=async()=>{if(await putCompany({...strip(S.company),ai:t.checked}))toast(t.checked?'AI suggestions on for this company':'AI suggestions off for this company')};
}

/* ---------- Receipts and bills ----------
   Pick a photo or PDF; AI reads it into a draft expense (if paid) or bill (if still owed), which opens
   in the usual form for you to check and save. The file itself isn't kept. */
function aiReceiptButton(){
  if(!aiOn())return '';
  return `<button class="btn" data-airead ${aiBusy?'disabled':''} title="Read a receipt or supplier invoice with AI. It opens as a draft for you to check.">${aiBusy?'Reading…':'Read a receipt with AI'}</button><input type="file" id="aiFile" accept="application/pdf,image/jpeg,image/png,image/webp" hidden>`;
}
const fileB64=file=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=()=>rej(new Error('That file couldn’t be read.'));r.readAsDataURL(file)});
async function aiReadFile(file){
  if(file.size>10*1024*1024){toast('That file is over 10 MB. Try a smaller photo or a shorter PDF.',true);return}
  aiBusy=true;renderMain();
  try{
    const r=await api('POST','/api/ai/read',{fileName:file.name,mediaType:file.type||(/\.pdf$/i.test(file.name)?'application/pdf':''),data:await fileB64(file)});
    aiBusy=false;renderMain();loadAI();aiOpenDraft(r.draft,file.name);
  }catch(e){aiBusy=false;renderMain();toast(e.message,true)}
}
function aiOpenDraft(x,name){
  const recoverable=/^(gst|hst|qst|tps|tvh|tvq)\b/i;
  // Taxes the business can't claim back (PST, RST) become part of the cost of the taxable lines.
  const other=r2(x.taxes.filter(t=>!recoverable.test(t.name)).reduce((s,t)=>s+t.amount,0));
  let lines=x.lines.map(l=>({...l}));
  if(!lines.length&&x.total){const tax=x.taxes.reduce((s,t)=>s+t.amount,0);lines=[{description:x.vendorName||'',amount:r2(x.total-tax),account:'',taxable:tax>0}]}
  if(other){const base=lines.filter(l=>l.taxable).reduce((s,l)=>s+l.amount,0)||lines.reduce((s,l)=>s+l.amount,0);let left=other;
    lines.forEach((l,i)=>{if(base&&(l.taxable||!lines.some(z=>z.taxable))){const share=i===lines.length-1?left:r2(other*l.amount/base);l.amount=r2(l.amount+share);left=r2(left-share)}})}
  const recov=r2(x.taxes.filter(t=>recoverable.test(t.name)).reduce((s,t)=>s+t.amount,0));
  const calc=r2(lines.filter(l=>l.taxable).reduce((s,l)=>s+l.amount,0)*(+S.company.taxRate||0)/100);
  const conf={high:'High',medium:'Medium',low:'Low'}[x.confidence]||'Low';
  const rows=[`<b>Draft read by AI · ${conf} confidence</b>`,'Check every field before you save.'];
  if(x.total)rows.push(`The document’s total is ${money(x.total)}: make sure the total below matches.`);
  if(x.taxes.length)rows.push(`<span>Taxes on the document:</span> <span translate="no">${x.taxes.map(t=>`${esc(t.name)} ${money(t.amount)}`).join(', ')}</span>`);
  if(Math.abs(recov-calc)>0.05)rows.push(`The sales tax on the document (${money(recov)}) doesn’t match what this form calculates (${money(calc)}). Check the tax on each line.`);
  if(other)rows.push('Tax that can’t be claimed back (such as PST) was added to the cost of the lines.');
  if(x.currency&&x.currency!=='CAD')rows.push(`<b>This document isn’t in Canadian dollars.</b> <span>Enter the amounts as charged by the bank or card.</span>`);
  if(x.reason)rows.push(`<span translate="no">${esc(x.reason)}</span>`);
  const note=`<div class="banner" style="margin:0;display:block">${rows.map(r=>`<div>${r}</div>`).join('')}</div>`;
  const base={contactId:x.vendorId||'',newContact:x.vendorId?'':x.vendorName,date:x.date||today(),note};
  const code=l=>l.taxable&&+S.company.taxRate?'std':'none';
  if(x.paid)moneyForm('expense',null,{...base,ref:x.number,memo:x.vendorName&&!x.vendorId?x.vendorName:'',form:{lines:lines.map(l=>({account:l.account,desc:l.description,amount:l.amount,taxCode:code(l)}))}});
  else docForm('bill',null,{...base,number:x.number,due:x.dueDate||addDays(x.date||today(),+S.company.terms||0),lines:lines.map(l=>({desc:l.description,account:l.account,qty:1,rate:l.amount,taxCode:code(l)}))});
}
function bindAIRead(m){
  const b=$('[data-airead]',m),inp=$('#aiFile',m);if(!b||!inp)return;
  b.onclick=e=>{e.stopPropagation();inp.click()};
  inp.onchange=()=>{const f=inp.files[0];inp.value='';if(f)aiReadFile(f)};
}
