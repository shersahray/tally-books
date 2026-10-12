'use strict';
/* ---------- Tags (tags.js has the rules shared with the server) ----------
 * Labels on invoices, bills, sales receipts, expenses, deposits, journal entries, bank lines and bank rules.
 * Several per transaction, unlike a class. The list lives in the company settings (S.company.tags, tagGroups);
 * transactions keep tag ids in `tags`. A picker on each form: type to find a tag, or press Enter to add a new one. */

const tagList=()=>S.company.tags||[];
const tagGroups=()=>S.company.tagGroups||[];
const tagById=id=>tagList().find(t=>t.id===id);
const tagGroupName=id=>(tagGroups().find(g=>g.id===id)||{}).name||'';
/** "Event: Trade show" for a tag in a group, else just its name. */
const tagLabel=t=>t?(t.group&&tagGroupName(t.group)?`${tagGroupName(t.group)}: ${t.name}`:t.name):'';
/** Tag ids that still exist (a remembered suggestion can point at a tag removed since). */
const liveTags=ids=>(Array.isArray(ids)?ids:[]).filter(id=>tagById(id));
/** Small pills for a list row ('' when there are none). */
function tagPills(ids){
  const ts=liveTags(ids).map(tagById);if(!ts.length)return '';
  return ' '+ts.map(t=>`<span class="pill tag" translate="no" title="${esc(tagLabel(t))}">${esc(t.name)}</span>`).join(' ');
}
/** Can this person add tags to the list from a form? (Clients and view-only accounts can't change settings.) */
const tagCanCreate=()=>!!(typeof ME!=='undefined'&&ME&&ME.role!=='client'&&!ME.readOnly&&(!ME.perms||['sales','expenses','banking','accounting'].some(a=>perm(a,'edit'))));

/* ---------- the picker ---------- */
/** A tag picker. `attrs` go on the box (e.g. data-btags for a bank line). Empty when the company has no tags and the person can't add any. */
function tagPicker(id,vals,attrs=''){
  if(!tagList().length&&!tagCanCreate())return '';
  const sel=liveTags(vals);
  return `<div class="tagpick" id="${id}" data-tagpick data-tags="${esc(sel.join(','))}" ${attrs}>${sel.map(tagChip).join('')}<span class="tagin"><input type="text" id="${id}_in" autocomplete="off" maxlength="${TallyTags.NAME_MAX*2+2}" aria-label="${esc(T('Add a tag'))}" placeholder="${esc(T(sel.length?'Add':'Add tags'))}"><div class="tagmenu" hidden role="listbox"></div></span></div>`;
}
const tagChip=id=>{const t=tagById(id);return t?`<span class="pill tag" data-tagid="${esc(id)}" translate="no" title="${esc(tagLabel(t))}">${esc(t.name)}<button type="button" class="tagx" data-tagx="${esc(id)}" aria-label="${esc(T('Remove tag'))}">×</button></span>`:''};
/** A form field with the picker ('' when there's nothing to pick). */
function tagField(id,vals){const p=tagPicker(id,vals);return p?fld(id+'_in','Tags',p,true):''}
/** The tags picked: {tags:[…]} to spread into a record, or {} when none (so the field is left off). */
const tagsOf=(f,id)=>{const box=$('#'+id,f);if(!box)return null;const t=tagIds(box);return t.length?{tags:t}:{}};
const tagIds=box=>(box.dataset.tags||'').split(',').filter(Boolean);
/** Put tagsOf()'s result on a record: tags set, or removed. A form without the picker leaves them as they were. */
function setTags(rec,picked){if(!picked)return rec;if(picked.tags)rec.tags=picked.tags;else delete rec.tags;return rec}

function tagSetIds(box,ids){
  box.dataset.tags=ids.join(',');
  $$('.pill.tag',box).forEach(x=>x.remove());
  box.querySelector('.tagin').insertAdjacentHTML('beforebegin',ids.map(tagChip).join(''));
  const inp=$('input',box);inp.placeholder=T(ids.length?'Add':'Add tags');
  box.dispatchEvent(new Event('change',{bubbles:true}));
}
function tagMenu(box){
  const inp=$('input',box),menu=$('.tagmenu',box),q=inp.value.trim().toLowerCase(),have=new Set(tagIds(box));
  const hits=tagList().filter(t=>!have.has(t.id)&&(!q||tagLabel(t).toLowerCase().includes(q))).sort((a,b)=>tagLabel(a).localeCompare(tagLabel(b))).slice(0,30);
  const exact=q&&tagList().some(t=>t.name.toLowerCase()===q||tagLabel(t).toLowerCase()===q);
  const add=q&&!exact&&tagCanCreate();
  const items=hits.map(t=>`<button type="button" class="tagopt" role="option" data-tagpick-id="${esc(t.id)}" translate="no">${esc(tagLabel(t))}</button>`);
  if(add)items.push(`<button type="button" class="tagopt add" role="option" data-tagnew="${esc(inp.value.trim())}"><span>${esc(T('Add new tag:'))}</span> <b translate="no">${esc(inp.value.trim())}</b></button>`);
  if(!items.length){menu.hidden=true;menu.innerHTML='';return}
  menu.innerHTML=items.join('');menu.hidden=false;
  // Fixed to the window, so a table that scrolls sideways (bank lines) doesn't cut it off.
  const r=box.getBoundingClientRect(),h=menu.offsetHeight;
  menu.style.left=Math.max(8,Math.min(r.left,innerWidth-menu.offsetWidth-8))+'px';
  menu.style.top=(r.bottom+4+h>innerHeight&&r.top-4-h>0?r.top-4-h:r.bottom+4)+'px';
  const first=menu.querySelector('.tagopt');if(first)first.classList.add('hot');
}
// Scrolling moves the box away from its menu: close it.
document.addEventListener('scroll',e=>{if(e.target.closest&&e.target.closest('.tagmenu'))return;$$('.tagmenu').forEach(m=>{if(!m.hidden)m.hidden=true})},true);
/** Add a new tag to the company's list (from a picker). "Event: Trade show" goes in the Event group when there is one. */
async function tagCreate(text){
  let name=text.replace(/\s+/g,' ').trim(),group='';
  const m=name.match(/^([^:]{1,40}):\s*(.+)$/);if(m){const g=tagGroups().find(x=>x.name.toLowerCase()===m[1].trim().toLowerCase());if(g){group=g.id;name=m[2].trim()}}
  name=name.slice(0,TallyTags.NAME_MAX);if(!name)return null;
  const same=tagList().find(t=>t.group===group&&t.name.toLowerCase()===name.toLowerCase());if(same)return same.id;
  if(tagList().length>=TallyTags.MAX_TAGS){toast(T('That’s the most tags a company can have. Remove some you no longer use.'),true);return null}
  const t={id:uid(),name,group};
  if(!await putCompany({...strip(S.company),tags:[...tagList(),t]}))return null;
  toast(`${T('Tag added:')} ${name}`);return t.id;
}
async function tagPick(box,id){
  const ids=tagIds(box);if(!id||ids.includes(id))return;
  if(ids.length>=TallyTags.MAX_PER_TXN){toast(T('Use at most 20 tags on a transaction.'),true);return}
  const inp=$('input',box);inp.value='';$('.tagmenu',box).hidden=true;
  tagSetIds(box,[...ids,id]);inp.focus();
}
// One set of listeners for every picker on the page, in forms and in table rows.
document.addEventListener('input',e=>{const box=e.target.closest&&e.target.closest('[data-tagpick]');if(box&&e.target.tagName==='INPUT'){e.stopPropagation();tagMenu(box)}},true);
document.addEventListener('change',e=>{if(e.target.tagName==='INPUT'&&e.target.closest&&e.target.closest('[data-tagpick]'))e.stopPropagation()},true);
document.addEventListener('focusin',e=>{const box=e.target.closest&&e.target.closest('[data-tagpick]');if(box&&e.target.tagName==='INPUT')tagMenu(box)});
document.addEventListener('focusout',e=>{const box=e.target.closest&&e.target.closest('[data-tagpick]');if(box)setTimeout(()=>{if(!box.contains(document.activeElement)){const m=$('.tagmenu',box);if(m)m.hidden=true}},150)});
document.addEventListener('keydown',async e=>{
  const box=e.target.closest&&e.target.closest('[data-tagpick]');if(!box||e.target.tagName!=='INPUT')return;
  const inp=e.target,menu=$('.tagmenu',box),opts=[...menu.querySelectorAll('.tagopt')],hot=opts.findIndex(o=>o.classList.contains('hot'));
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(menu.hidden)return tagMenu(box);const n=opts.length?(hot+(e.key==='ArrowDown'?1:-1)+opts.length)%opts.length:-1;opts.forEach((o,i)=>o.classList.toggle('hot',i===n));return}
  if(e.key==='Enter'||e.key===','||e.key==='Tab'&&inp.value.trim()){
    if(!inp.value.trim()&&e.key!=='Enter')return;
    e.preventDefault();e.stopPropagation();
    const o=opts[hot>=0?hot:0];if(!o){if(e.key==='Enter'&&!inp.value.trim())return;return}
    if(o.dataset.tagpickId)return tagPick(box,o.dataset.tagpickId);
    const id=await tagCreate(o.dataset.tagnew);if(id)tagPick(box,id);return;
  }
  if(e.key==='Escape'&&!menu.hidden){e.stopPropagation();menu.hidden=true;return}
  if(e.key==='Backspace'&&!inp.value){const ids=tagIds(box);if(ids.length)tagSetIds(box,ids.slice(0,-1))}
},true);
document.addEventListener('mousedown',e=>{if(e.target.closest&&e.target.closest('.tagopt'))e.preventDefault()},true); // keep the focus in the box
document.addEventListener('click',async e=>{
  const x=e.target.closest&&e.target.closest('[data-tagx],.tagopt');if(!x)return;
  const box=x.closest('[data-tagpick]');if(!box)return;
  e.preventDefault();e.stopPropagation();
  if(x.dataset.tagx){tagSetIds(box,tagIds(box).filter(id=>id!==x.dataset.tagx));return}
  if(x.dataset.tagpickId)return tagPick(box,x.dataset.tagpickId);
  const id=await tagCreate(x.dataset.tagnew);if(id)tagPick(box,id);
},true);

/* ---------- Settings → Tags ---------- */
function tagsPanel(){
  if(!ME||ME.role==='client')return '';
  const ro=ME.readOnly||(ME.perms&&!perm('accounting','edit')),ts=tagList(),gs=tagGroups();
  const used=id=>TallyTags.usage(S,id);
  const row=t=>{const n=used(t.id);return `<tr><td><span class="pill tag" translate="no">${esc(t.name)}</span> <span class="muted" style="font-size:12.5px;white-space:nowrap">${n?(n===1?'1 transaction':`${n} transactions`):'Not used'}</span></td><td class="n"><div class="tagacts">${ro?'':`<button class="btn sm ghost" data-tagren="${esc(t.id)}">Rename</button>${gs.length?`<button class="btn sm ghost" data-tagmove="${esc(t.id)}">Group</button>`:''}<button class="btn sm ghost" data-tagdel="${esc(t.id)}">Remove</button>`}</div></td></tr>`};
  const sec=(title,list,g)=>`<tr class="tag-grp"><td><b translate="${g?'no':'yes'}">${esc(title)}</b></td><td class="n"><div class="tagacts">${g&&!ro?`<button class="btn sm ghost" data-tgren="${esc(g.id)}">Rename group</button><button class="btn sm ghost" data-tgdel="${esc(g.id)}">Remove group</button>`:''}</div></td></tr>${list.map(row).join('')||`<tr><td colspan="2" class="muted">${esc(T('No tags in this group yet.'))}</td></tr>`}`;
  const sorted=l=>l.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const body=gs.map(g=>sec(g.name,sorted(ts.filter(t=>t.group===g.id)),g)).join('')+(ts.some(t=>!t.group)||!gs.length?(gs.length?sec(T('Not in a group'),sorted(ts.filter(t=>!t.group))):sorted(ts.filter(t=>!t.group)).map(row).join('')):'');
  return `<div class="panel" style="max-width:640px;margin-top:16px" id="tagsPanel"><h3 style="flex-wrap:wrap">Tags<button class="btn sm ghost" data-go-tags style="white-space:normal;text-align:right">Money in and out by tag</button></h3><div class="pad" style="display:flex;flex-direction:column;gap:10px">
    <div class="muted" style="font-size:13px">${esc(T('Label transactions to follow things like an event, a campaign or a job. Put several tags on an invoice, bill, sales receipt, expense, deposit, journal entry or bank line. Unlike classes, tags don’t split the profit and loss; see money in and out for each one in Reports.'))}</div>
    ${ts.length||gs.length?`<div class="tbl-wrap"><table><tbody>${body}</tbody></table></div>`:`<div class="muted">${esc(T('None yet.'))}</div>`}
    ${ro?'':`<form id="tagAdd" style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="tagName" maxlength="${TallyTags.NAME_MAX}" placeholder="${esc(T('e.g. Trade show'))}" aria-label="${esc(T('Tag name'))}" style="flex:1 1 160px">${gs.length?`<select id="tagGrp" aria-label="${esc(T('Group'))}"><option value="">${esc(T('No group'))}</option>${gs.map(g=>`<option value="${esc(g.id)}" translate="no">${esc(g.name)}</option>`).join('')}</select>`:''}<button class="btn" type="submit">Add tag</button></form>
    <form id="tagGrpAdd" style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="tagGrpName" maxlength="${TallyTags.NAME_MAX}" placeholder="${esc(T('e.g. Event'))}" aria-label="${esc(T('Group name'))}" style="flex:1 1 160px"><button class="btn" type="submit">Add group</button></form>`}
  </div></div>`;
}
const saveTags=async(tags,groups,msg)=>{if(await putCompany({...strip(S.company),tags,tagGroups:groups}))toast(msg);};
/** Take a tag off every transaction, invoice, bill, bank rule and added bank line, then out of the list. */
async function tagRemoveEverywhere(id){
  const off=r=>{const c={...r};const t=(c.tags||[]).filter(x=>x!==id);if(t.length)c.tags=t;else delete c.tags;return c};
  const has=r=>Array.isArray(r&&r.tags)&&r.tags.includes(id),w=[];
  for(const col of ['entries','docs','rules','delayed','estimates','recurring'])for(const r of (S[col]||[]).filter(has))w.push({op:'set',collection:col,id:r.id,data:off(r)});
  for(const b of S.bankTxns.filter(b=>has(b.cat)))w.push({op:'set',collection:'bankTxns',id:b.id,data:{...b,cat:off(b.cat)}});
  return !w.length||batch(w);
}
function bindTags(m){
  const add=$('#tagAdd',m);if(add)add.onsubmit=async e=>{e.preventDefault();const n=$('#tagName',add).value.replace(/\s+/g,' ').trim(),g=($('#tagGrp',add)||{}).value||'';if(!n)return;
    if(tagList().some(t=>t.group===g&&t.name.toLowerCase()===n.toLowerCase()))return toast(T('There’s already one with that name.'),true);
    await saveTags([...tagList(),{id:uid(),name:n,group:g}],tagGroups(),`${T('Tag added:')} ${n}`)};
  const ga=$('#tagGrpAdd',m);if(ga)ga.onsubmit=async e=>{e.preventDefault();const n=$('#tagGrpName',ga).value.replace(/\s+/g,' ').trim();if(!n)return;
    if(tagGroups().some(g=>g.name.toLowerCase()===n.toLowerCase()))return toast(T('There’s already one with that name.'),true);
    await saveTags(tagList(),[...tagGroups(),{id:uid(),name:n}],T('Group added'))};
  if(m._tagsBound)return;m._tagsBound=true;
  m.addEventListener('click',async e=>{if(S.view!=='settings')return;const b=e.target.closest('[data-tagren],[data-tagmove],[data-tagdel],[data-tgren],[data-tgdel],[data-go-tags]');if(!b)return;e.stopPropagation();
    const ts=tagList(),gs=tagGroups(),d=b.dataset;
    if(d.goTags!==undefined){S.rep={...S.rep,tab:'tg'};return go('reports')}
    if(d.tagren){const t=ts.find(x=>x.id===d.tagren);const n=(prompt(T('New name for the tag'),t.name)||'').replace(/\s+/g,' ').trim();if(!n||n===t.name)return;
      if(ts.some(x=>x.id!==t.id&&x.group===t.group&&x.name.toLowerCase()===n.toLowerCase()))return toast(T('There’s already one with that name.'),true);
      return saveTags(ts.map(x=>x.id===t.id?{...x,name:n}:x),gs,T('Tag renamed'))}
    if(d.tagmove){const t=ts.find(x=>x.id===d.tagmove);return tagMoveForm(t)}
    if(d.tagdel){const t=ts.find(x=>x.id===d.tagdel),n=TallyTags.usage(S,t.id);
      if(n){if(!await confirmBox('Remove this tag from everything?',n===1?'It’s on 1 transaction or bank rule. It comes off it, then out of the list. The transaction itself doesn’t change.':`It’s on ${n} transactions and bank rules. It comes off all of them, then out of the list. The transactions themselves don’t change.`,'Remove from all'))return;
        if(!await tagRemoveEverywhere(t.id))return}
      return saveTags(tagList().filter(x=>x.id!==t.id),tagGroups(),T('Tag removed'))}
    if(d.tgren){const g=gs.find(x=>x.id===d.tgren);const n=(prompt(T('New name for the group'),g.name)||'').replace(/\s+/g,' ').trim();if(!n||n===g.name)return;
      if(gs.some(x=>x.id!==g.id&&x.name.toLowerCase()===n.toLowerCase()))return toast(T('There’s already one with that name.'),true);
      return saveTags(ts,gs.map(x=>x.id===g.id?{...x,name:n}:x),T('Group renamed'))}
    if(d.tgdel){const g=gs.find(x=>x.id===d.tgdel),inside=ts.filter(t=>t.group===g.id);
      if(inside.length&&!await confirmBox(T('Remove this group?'),T('Its tags stay, without a group.'),T('Remove group')))return;
      // Tags left without a group can clash by name with ungrouped ones: keep the ungrouped one's name unique by adding the group's name.
      const free=new Set(ts.filter(t=>!t.group).map(t=>t.name.toLowerCase()));
      return saveTags(ts.map(t=>t.group!==g.id?t:{...t,group:'',name:free.has(t.name.toLowerCase())?`${g.name} ${t.name}`.slice(0,TallyTags.NAME_MAX):t.name}),gs.filter(x=>x.id!==g.id),T('Group removed'))}
  },{capture:true});
}
function tagMoveForm(t){
  const f=openModal('Move tag to a group',`<div class="muted"><span translate="no">${esc(t.name)}</span></div><div class="fields">${fld('tmGrp','Group',`<select id="tmGrp"><option value="">${esc(T('No group'))}</option>${tagGroups().map(g=>`<option value="${esc(g.id)}" ${t.group===g.id?'selected':''} translate="no">${esc(g.name)}</option>`).join('')}</select>`)}</div>`,`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`);
  f.onsubmit=async e=>{e.preventDefault();const g=$('#tmGrp',f).value;
    if(tagList().some(x=>x.id!==t.id&&x.group===g&&x.name.toLowerCase()===t.name.toLowerCase()))return f.err(T('There’s already one with that name.'));
    if(await putCompany({...strip(S.company),tags:tagList().map(x=>x.id===t.id?{...x,group:g}:x)})){closeModal();toast('Saved')}};
}

/* ---------- Reports → Money in and out by tag (like QuickBooks Online's Tags page) ----------
   For each tag: income and expenses of the transactions that carry it, and the net. A transaction with
   two tags counts under both, so the tags don't add up to the profit and loss. Click a tag for its transactions. */
function rTags(){
  const{from,to}=S.rep,typeOf=new Map(S.accounts.map(a=>[a.id,a.type]));
  const s=TallyTags.summary(repPostings(),typeOf,from,to);
  const C={cols:[{label:'Money in'},{label:'Money out'},{label:'Net'}]},rows=[];
  const z={in:0,out:0,net:0,n:0},vals=b=>[b.in,b.out,b.net];
  const line=t=>({cls:'item',label:t.name,data:true,vals:vals(s.by[t.id]||z),tag:t.id});
  const sorted=l=>l.slice().sort((a,b)=>a.name.localeCompare(b.name));
  for(const g of tagGroups()){const ts=sorted(tagList().filter(t=>t.group===g.id));if(!ts.length)continue;rows.push({cls:'sec',label:g.name,data:true},...ts.map(line))}
  const loose=sorted(tagList().filter(t=>!t.group));
  if(loose.length){if(tagGroups().length)rows.push({cls:'sec',label:'Not in a group'});rows.push(...loose.map(line))}
  rows.push({cls:'spacer'},{cls:'tot',label:'No tag',vals:vals(s.none),tag:'__none'});
  const r=colReport({title:'Money in and out by tag',sub:`${fmtDate(from)} – ${fmtDate(to)}${basisSub()}`,C,rows,name:`money-by-tag_${from}_${to}${repBasis()==='cash'?'_cash':''}`});
  r.csv[0][0]='Tag';
  r.html=r.html.replace(/<\/div>$/,`<div class="muted" style="font-size:12.5px;padding:8px 16px 14px">${esc(T('Money in is income; money out is expenses and cost of goods sold. A transaction with several tags counts under each one, so the tags don’t add up to the profit and loss. Click a tag to see its transactions.'))}</div></div>`);
  return r;
}
