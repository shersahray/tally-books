'use strict';
// Pilot controls are visible only to company owners; the server enforces the same rule.
function automationPanel(){
  if(!ME||ME.role!=='owner')return '';
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Bookkeeping automation</h3><div class="pad"><p>Prepare bank transactions and receipt matches for your approval. Drafts stay outside the books until approved. Disabled by default for each company.</p><button type="button" class="btn" data-automation-open>Open approval inbox</button></div></div>`;
}
async function automationInbox(company=CO){
  if(company!==CO)return;
  const url=`/api/c/${encodeURIComponent(company)}/automation`;
  try{
    const data=await api('GET',url);if(company!==CO)return;
    const c=data.config, pending=data.items.filter(d=>d.status==='pending'),history=data.items.filter(d=>d.status!=='pending');
    const f=openModal('Automation approval inbox',`<p><b translate="no">${esc(S.company.name)}</b> · Nothing posts without owner approval.</p>
      <div class="fields"><label class="check"><input id="autoOn" type="checkbox" ${c.on?'checked':''}> Enable approval inbox for this company</label>
      <label class="check"><input id="autoBackground" type="checkbox" ${c.background?'checked':''}> Prepare in the background every minute</label>
      <label class="check"><input id="autoAI" type="checkbox" ${c.ai?'checked':''}> Use existing AI for unmatched bank lines (up to 100 attempts/day; existing spending limit applies)</label></div>
      <p class="muted">Receipt reading uses the existing company AI setting. Standalone receipts, ambiguous matches and foreign currency remain flagged for review.</p>
      <div class="actions"><button type="button" class="btn" data-auto-settings ${ME.readOnly?'disabled':''}>Save automation settings</button><button type="button" class="btn" data-auto-refresh ${!c.on||ME.readOnly?'disabled':''}>Prepare / refresh</button></div>
      ${data.run?`<p class="muted">Last preparation: ${esc(new Date(data.run.at).toLocaleString())}${data.run.error?' · '+esc(data.run.error):''}</p>`:''}
      <h3>Waiting for approval (${pending.length})</h3>${pending.length?pending.slice(0,200).map(d=>`<div class="toolbar"><span class="grow"><b translate="no">${esc(d.title)}</b><br>${esc(d.date)} · ${money(d.amount)} · ${esc(d.proposal.confidence)} confidence${d.stale?' · Refresh needed':''}</span><button type="button" class="btn" data-auto-detail="${esc(d.id)}">Review</button></div>`).join(''):'<p>No prepared items. Enable this company and select Prepare / refresh.</p>'}
      ${pending.length>200?'<p>Showing the first 200 items. Process these and refresh.</p>':''}
      <details><summary>Decision history (${history.length})</summary>${history.slice(-100).reverse().map(d=>`<p translate="no">${esc(d.title)} · ${esc(d.status)}${(d.history||[]).map(h=>`<br>${esc(h.action)} · ${esc(h.by)} · ${esc(new Date(h.at).toLocaleString())}${h.reason?' · '+esc(h.reason):''}`).join('')}</p>`).join('')}</details>`, '<button type="button" class="btn" data-close>Close</button>', 'wide');
    const task=async fn=>{if(company!==CO){closeModal();return;}$$('button',f).forEach(b=>b.disabled=true);try{await fn();closeModal();await load();await automationInbox(company);}catch(e){f.err(e.message);$$('button',f).forEach(b=>b.disabled=false);}};
    $('[data-auto-settings]',f).onclick=()=>task(()=>api('PUT',url,{on:$('#autoOn',f).checked,background:$('#autoBackground',f).checked,ai:$('#autoAI',f).checked}));
    $('[data-auto-refresh]',f).onclick=()=>task(()=>api('POST',url+'/prepare',{}));
    $$('[data-auto-detail]',f).forEach(btn=>btn.onclick=()=>automationDetail(data.items.find(d=>d.id===btn.dataset.autoDetail),company));
  }catch(e){toast(e.message,true);}
}
function automationDetail(d,company){
  if(company!==CO)return;
  const r=d.receiptId&&S.receipts.find(r=>r.id===d.receiptId),p=d.proposal,canEdit=p.kind==='category',url=`/api/c/${encodeURIComponent(company)}/automation/drafts/${encodeURIComponent(d.id)}`;
  const matched=p.target&&(p.target.kind==='entry'?S.entries:S.docs).find(x=>x.id===p.target.id);
  const preview=d.preview||[];
  const f=openModal('Review prepared transaction',`<p><b translate="no">${esc(d.title)}</b> · ${esc(d.date)} · ${money(d.amount)}</p>
    <p>${esc(p.confidence)} confidence · <span translate="no">${esc(p.reason)}</span></p>
    ${d.stale?'<p class="neg">The books changed. Return to the inbox and refresh before approving.</p>':''}
    ${d.problem?`<p class="neg" translate="no">${esc(d.problem)}</p>`:''}
    ${(d.warnings||[]).map(w=>`<p class="neg" translate="no">${esc(w)}</p>`).join('')}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px"><section>
      ${r?`<a href="${esc(rcUrl(r))}" target="_blank" rel="noopener">Open original receipt</a>${/^image\/(jpeg|png|webp)$/.test(r.mediaType)?`<img src="${esc(rcUrl(r))}" alt="Original receipt" style="max-width:100%;max-height:480px;object-fit:contain">`:''}`:'<p>No receipt attached. Verify the bank description and tax treatment.</p>'}
      ${matched?`<p>Proposed match: <span translate="no">${esc(matched.number||matched.ref||matched.memo||matched.id)}</span> · ${esc(matched.date)} · <span translate="no">${esc(contactName(matched.contactId))}</span></p>`:''}
    </section><section>
      ${canEdit?`<div class="field"><label for="autoAccount">Category</label><select id="autoAccount"><option value="">Choose category…</option>${S.accounts.filter(a=>a.active!==false&&!isBankAcct(a)&&!['ar','ap','tax','qst','pst'].includes(a.detail)).map(a=>`<option value="${esc(a.id)}" ${a.id===p.account?'selected':''}>${esc(a.code+' '+a.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="autoContact">Vendor / customer</label><select id="autoContact"><option value="">None</option>${S.contacts.map(c=>`<option value="${esc(c.id)}" ${c.id===p.contactId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="autoTax">Sales tax included</label><select id="autoTax">${[['none','No tax'],['std',S.company.taxName||'GST/HST/QST'],...(S.company.pstRate?[['gst','GST only']]:[])].map(([k,v])=>`<option value="${k}" ${k===p.tax?'selected':''}>${esc(v)}</option>`).join('')}</select></div><button type="button" class="btn" data-auto-edit>Save edits and preview</button>`:''}
      <h3>${p.kind==='match'?'Entry after matching':'Proposed journal entry'}</h3><div class="tbl-wrap"><table><thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>${preview.map(l=>`<tr><td translate="no">${esc(acctName(l.account))}</td><td>${money(l.debit)}</td><td>${money(l.credit)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted">Review the category, tax, receipt and match. Save edits to update the preview before approval.</p>
    </section></div>
    <div class="field"><label for="autoReason">Rejection reason</label><input id="autoReason" maxlength="500"></div>`,
    `<button type="button" class="btn" data-auto-back>Back</button><button type="button" class="btn" data-auto-reject ${ME.readOnly?'disabled':''}>Reject</button><button type="button" class="btn primary" data-auto-approve ${d.problem||d.stale||d.warnings.length||ME.readOnly?'disabled':''}>Approve and post</button>`, 'wide');
  let dirty=false;
  $$('select',f).forEach(x=>x.onchange=()=>{dirty=true;$('[data-auto-approve]',f).disabled=true;});
  const task=async fn=>{if(company!==CO){closeModal();return;}$$('button',f).forEach(b=>b.disabled=true);try{await fn();closeModal();await load();await automationInbox(company);}catch(e){f.err(e.message);$('[data-auto-back]',f).disabled=false;$('[data-auto-reject]',f).disabled=false;if(canEdit)$('[data-auto-edit]',f).disabled=false;$('[data-auto-approve]',f).disabled=!!(dirty||d.problem||d.stale||d.warnings.length);}};
  $('[data-auto-back]',f).onclick=()=>automationInbox(company);
  if(canEdit)$('[data-auto-edit]',f).onclick=()=>task(()=>api('PUT',url,{version:d.version,account:$('#autoAccount',f).value,contactId:$('#autoContact',f).value,tax:$('#autoTax',f).value}));
  $('[data-auto-reject]',f).onclick=()=>task(()=>api('POST',url,{version:d.version,action:'reject',reason:$('#autoReason',f).value}));
  $('[data-auto-approve]',f).onclick=()=>task(()=>api('POST',url,{version:d.version,action:'approve'}));
}
document.addEventListener('click',e=>{if(e.target.closest('[data-automation-open]'))automationInbox();});
