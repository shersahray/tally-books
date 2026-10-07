'use strict';
/* ---------- AI assistant (add-on) ----------
 * A chat box for questions about the open company's books. It only appears when an owner has added the
 * AI assistant to that company (Settings → AI assistant); otherwise there's no button and nothing is sent.
 * Answers come from the server (assistant.js), which works out every number from the books; each answer
 * links to the reports and screens it used. The conversation stays in this window and is cleared when
 * another company is opened. */
const ASST={open:false,busy:false,co:null,msgs:[]};
const ASST_EXAMPLES=['What was our net income this fiscal year?','How much cash do we have in the bank?','Who owes us money, and what’s overdue?','What were our biggest expenses last month?'];

/** S.assistant comes with the books: {on, ready, used, cap, left}. */
const asstOn=()=>!!(CO&&S.loaded&&S.assistant&&S.assistant.on);

function syncAssistant(){
  let fab=document.getElementById('asstFab');
  if(!fab){
    fab=document.createElement('button');fab.id='asstFab';fab.className='asst-fab';fab.type='button';
    fab.innerHTML=`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 3c-4.97 0-9 3.58-9 8 0 2.12.93 4.05 2.45 5.48L5 21l4.28-2.14c.86.22 1.77.34 2.72.34 4.97 0 9-3.58 9-8s-4.03-8-9-8Zm-3.5 9.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm3.5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm3.5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"/></svg><span>Ask AI</span>`;
    fab.onclick=()=>{ASST.open=!ASST.open;drawAssistant();if(ASST.open)setTimeout(()=>{const q=document.getElementById('asstQ');if(q)q.focus()},0)};
    document.body.appendChild(fab);
    const box=document.createElement('section');box.id='asstBox';box.className='asst-box';box.setAttribute('aria-label','AI assistant');box.hidden=true;
    document.body.appendChild(box);
  }
  if(ASST.co!==CO){ASST.co=CO;ASST.msgs=[];ASST.open=false}
  fab.hidden=!asstOn()||ASST.open;
  fab.setAttribute('aria-expanded',ASST.open?'true':'false');
  if(!asstOn())ASST.open=false;
  drawAssistant();
}

/** Plain text from the model: escape it, then allow **bold** and "- " lists. */
function asstFormat(text){
  const lines=esc(text).split('\n');let html='',list=false;
  for(const raw of lines){
    const l=raw.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');
    if(/^\s*[-•]\s+/.test(l)){if(!list){html+='<ul>';list=true}html+=`<li>${l.replace(/^\s*[-•]\s+/,'')}</li>`;continue}
    if(list){html+='</ul>';list=false}
    if(l.trim())html+=`<p>${l}</p>`;
  }
  return html+(list?'</ul>':'');
}
const ASST_REPORT={pl:'Profit and loss',bs:'Balance sheet',tb:'Trial balance',ev:'Expenses by vendor',sc:'Sales by customer'};
function asstLinkLabel(l){
  const span=l.from&&l.to?` · ${fmtDate(l.from)} – ${fmtDate(l.to)}`:l.to?` · ${fmtDate(l.to)}`:'';
  if(l.view==='reports')return T(W(ASST_REPORT[l.tab]||'Report'))+(l.tab==='bs'||l.tab==='tb'?(l.to?` · ${fmtDate(l.to)}`:''):span);
  if(l.view==='register'){const a=acct(l.acct);return (a?a.name:T('Account'))+span}
  if(l.view==='sales')return T(l.status==='overdue'?'Overdue invoices':'Unpaid invoices');
  if(l.view==='expenses')return T(l.status==='overdue'?'Overdue bills':'Unpaid bills');
  if(l.view==='transactions')return T('Transactions')+span;
  return T('Open');
}
function asstGo(l){
  if(l.view==='reports'){S.rep={...S.rep,tab:l.tab,period:'custom',from:l.from||S.rep.from,to:l.to||S.rep.to};return go('reports')}
  if(l.view==='register'){if(!acct(l.acct))return;S.reg={from:l.from||'',to:l.to||''};return go('register',l.acct)}
  if(l.view==='sales'){S.sales={...S.sales,tab:'docs',status:l.status||'unpaid'};return go('sales')}
  if(l.view==='expenses'){S.exp={...S.exp,tab:'docs',status:l.status||'unpaid'};return go('expenses')}
  if(l.view==='transactions'){S.tx={...S.tx,q:l.q||'',type:'',from:l.from||'',to:l.to||''};return go('transactions')}
}

function drawAssistant(){
  const box=document.getElementById('asstBox');if(!box)return;
  box.hidden=!ASST.open||!asstOn();
  if(box.hidden)return;
  const a=S.assistant||{},keep=(document.getElementById('asstQ')||{}).value||'';
  const msgs=ASST.msgs.map((m,i)=>m.role==='user'
    ?`<div class="asst-msg me" translate="no">${esc(m.text)}</div>`
    :`<div class="asst-msg ai${m.error?' err':''}"><div translate="no">${asstFormat(m.text)}</div>${(m.links||[]).length?`<div class="asst-links">${m.links.map((l,j)=>`<button type="button" class="btn small" data-asstlink="${i}:${j}">${esc(asstLinkLabel(l))}</button>`).join('')}</div>`:''}</div>`).join('');
  const empty=`<div class="asst-empty"><p><b>Ask about ${esc(S.company.name)}’s books.</b></p><p class="muted">Answers come from the transactions in Sumlora, with links to the reports used. The assistant can only read the books; it doesn’t change anything.</p><div class="asst-ex">${ASST_EXAMPLES.map(x=>`<button type="button" class="btn small" data-asstex="${esc(x)}">${esc(T(x))}</button>`).join('')}</div></div>`;
  const left=a.cap?`<span>${a.left} of ${a.cap} questions left this month</span>`:'';
  box.innerHTML=`<header><b>AI assistant</b><span class="pill quiet">Beta</span><button type="button" class="btn ghost small" data-asstclear title="New conversation" ${ASST.msgs.length?'':'hidden'}>New</button><button type="button" class="btn ghost small" data-asstclose aria-label="Close">✕</button></header>
    <div class="asst-log" id="asstLog" aria-live="polite">${msgs||empty}${ASST.busy?'<div class="asst-msg ai busy"><span class="dots" aria-label="Thinking"><i></i><i></i><i></i></span></div>':''}</div>
    ${a.ready===false?'<div class="asst-note">The AI assistant isn’t set up on this server yet. The server’s administrator adds the AI key in Settings.</div>':''}
    <form class="asst-form" id="asstForm"><textarea id="asstQ" rows="2" maxlength="1000" placeholder="${esc(T('Ask a question about the books…'))}" ${ASST.busy||a.ready===false||a.left===0?'disabled':''}></textarea><button class="btn primary" ${ASST.busy||a.ready===false||a.left===0?'disabled':''}>Ask</button></form>
    <footer class="muted">${left}<span>AI can make mistakes. Check important numbers in the linked report.</span></footer>`;
  const q=box.querySelector('#asstQ');q.value=keep;
  q.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();box.querySelector('#asstForm').requestSubmit()}};
  box.querySelector('#asstForm').onsubmit=e=>{e.preventDefault();asstAsk(q.value)};
  box.onclick=e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-asstclose')){ASST.open=false;syncAssistant();const f=document.getElementById('asstFab');if(f)f.focus();return}
    if(b.hasAttribute('data-asstclear')){ASST.msgs=[];drawAssistant();return}
    if(b.dataset.asstex){asstAsk(T(b.dataset.asstex));return}
    if(b.dataset.asstlink){const[i,j]=b.dataset.asstlink.split(':').map(Number);const l=(ASST.msgs[i]&&ASST.msgs[i].links||[])[j];if(l){asstGo(l);if(window.matchMedia('(max-width:700px)').matches){ASST.open=false;syncAssistant()}}}
  };
  const log=box.querySelector('#asstLog');log.scrollTop=log.scrollHeight;
}

async function asstAsk(text){
  const question=String(text||'').trim();if(!question||ASST.busy)return;
  const co=CO,history=ASST.msgs.filter(m=>!m.error).slice(-8).map(m=>({role:m.role,text:m.text}));
  ASST.msgs.push({role:'user',text:question});ASST.busy=true;
  const q=document.getElementById('asstQ');if(q)q.value='';
  drawAssistant();
  try{
    const r=await api('POST','/api/assistant',{question,history,lang:I18N.lang});
    if(co!==CO)return;
    ASST.msgs.push({role:'assistant',text:r.answer,links:r.links||[]});
    if(r.assistant)S.assistant=r.assistant;
  }catch(e){
    if(co!==CO)return;
    ASST.msgs.push({role:'assistant',text:e.message,error:true});
  }finally{
    if(co===CO){ASST.busy=false;drawAssistant();const q2=document.getElementById('asstQ');if(q2&&!q2.disabled)q2.focus()}
  }
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&ASST.open&&document.getElementById('asstBox')?.contains(document.activeElement)){ASST.open=false;syncAssistant();document.getElementById('asstFab')?.focus()}});

/* ---------- Settings: the add-on switch (owners only) ---------- */
function assistantPanel(){
  if(!ME||ME.role==='client'||!CO)return '';
  const a=S.assistant||{},on=!!a.on,owner=ME.role==='owner'&&!ME.readOnly;
  const price=typeof BILL!=='undefined'&&BILL&&BILL.configured&&BILL.offer&&BILL.offer.amounts&&BILL.offer.amounts.assistant;
  const priceLine=price&&!(BILL.firm&&BILL.firm.exempt)?`<div><span class="pill quiet">Add-on</span> <span translate="no">${centsMoney(price)}</span> <span>per company, per month, added to the subscription that pays for this company.</span></div>`:'';
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>AI assistant</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="muted" style="font-size:13px">An “Ask AI” button for this company: anyone who works in these books can ask questions in plain words (“What did we spend on fuel this year?”, “Who owes us money?”) and get the answer with links to the report it came from. It only reads the books. When it’s on, the numbers needed for each question (account totals and the matching transactions), this company’s chart of accounts and the question itself are sent to Anthropic (the maker of Claude) to write the answer. Anthropic doesn’t use data sent through its API to train its models. Tell your client if their engagement letter needs to say so.</div>
    ${priceLine}
    <label class="check"><input type="checkbox" id="asstCo" ${on?'checked':''} ${owner?'':'disabled'}> Add the AI assistant to this company</label>
    ${owner?'':'<div class="muted" style="font-size:13px">Only an owner can add or remove it.</div>'}
    ${on&&a.cap?`<div class="muted" style="font-size:13px"><span>This month:</span> ${a.used} of ${a.cap} questions</div>`:''}
  </div></div>`;
}
let asstBillTried=false;
function bindAssistantSettings(m){
  const t=$('#asstCo',m);if(!t)return;
  // The add-on's price is shown when this server takes subscriptions.
  if(!asstBillTried&&typeof loadBillMe==='function'&&typeof BILL!=='undefined'&&!BILL){asstBillTried=true;loadBillMe().then(()=>{if(S.view==='settings'&&BILL&&BILL.configured)renderMain()})}
  t.onchange=async()=>{
    const want=t.checked;t.disabled=true;
    if(want&&!await confirmBox('Add the AI assistant?',`The “Ask AI” button appears for everyone who works in ${S.company.name}’s books.${typeof BILL!=='undefined'&&BILL&&BILL.configured&&!(BILL.firm&&BILL.firm.exempt)?' The add-on is billed each month until you remove it.':''}`,'Add it')){t.checked=false;t.disabled=false;return}
    try{await api('PUT',`/api/companies/${encodeURIComponent(CO)}`,{assistant:want});await load();toast(want?'AI assistant added to this company':'AI assistant removed from this company')}
    catch(e){t.checked=!want;t.disabled=false;toast(e.message,true)}
  };
}
