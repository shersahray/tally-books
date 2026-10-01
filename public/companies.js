'use strict';
/* ---------- Companies: client list, switching, new company ----------
 * Each company's books are a separate database on the server. CO (in app.js) holds the
 * open company's id; every company-scoped API call is routed to it.
 */
let CO_LIST=[],PROVS={};
S.co={showArchived:false,q:''};
const LAST_KEY='tally.lastCompany';
const lsGet=()=>{try{return localStorage.getItem(LAST_KEY)}catch(e){return null}};
const lsSet=v=>{try{localStorage.setItem(LAST_KEY,v)}catch(e){}};
const UI_DEFAULTS=JSON.stringify({sales:S.sales,exp:S.exp,tx:S.tx,rep:S.rep,reg:S.reg,company:S.company});
const monthName=m=>new Date(2026,m-1,1).toLocaleDateString(LOC(),{month:'long'});

function fyOptions(start){
  // A fiscal year starting in month m ends on the last day of month m-1.
  return Array.from({length:12},(_,i)=>{const m=i+1,end=m===1?12:m-1,day=new Date(2026,end,0).getDate();
    return `<option value="${m}" ${+start===m?'selected':''}>${monthName(end)} ${day}${m===1?' (calendar year)':''}</option>`}).join('');
}
function provinceOptions(sel){
  return Object.entries(PROVS).map(([k,p])=>`<option value="${k}" ${sel===k?'selected':''}>${esc(p.name)} · ${esc(p.taxName)} ${p.taxRate}%</option>`).join('')+`<option value="" ${!sel?'selected':''}>Outside Canada or other</option>`;
}

async function loadCompanies(){const r=await api('GET','/api/companies');CO_LIST=r.companies||[];PROVS=r.provinces||{};return CO_LIST}

function resetBooks(){
  COLS.forEach(c=>S[c]=[]);
  Object.assign(S,JSON.parse(UI_DEFAULTS));
  S.loaded=false;S.rev=-1;S.connErr=false;S.param=null;
  S.bank={tab:'review',acct:'',show:'new',sel:{},checked:new Set(),rec:null,draft:{}};
  S.stax={tax:'gst',period:null,drill:'',manual:{}};
  S.cv=null;
  PC=null;
}
// A client on a phone mostly sends receipts, so that's where they start.
const startView=()=>typeof ME!=='undefined'&&ME&&ME.role==='client'&&window.matchMedia&&matchMedia('(max-width: 760px)').matches?'receipts':'dashboard';
async function openCompany(id,view){
  view=view||startView();
  const co=CO_LIST.find(c=>c.id===id);if(!co)return;
  // A company with a code: owners and staff type it every time they open it.
  if(co.hasCode&&!co.justMade&&ME&&ME.role!=='client'&&!await askCode(id)){if(!CO)showCompanies();else if(location.hash.slice(1)!==CO)try{history.replaceState(null,'','#'+CO)}catch(e){}return}
  delete co.justMade;
  closeModal();
  CO=id;resetBooks();lsSet(id);
  try{if(location.hash.slice(1)!==id)history.replaceState(null,'','#'+id)}catch(e){}
  S.view=view;renderMain();window.scrollTo(0,0);
  await load();
  api('PUT','/api/companies/'+encodeURIComponent(id),{opened:true}).catch(()=>{});
}
async function showCompanies(){
  S.view='companies';renderMain();
  try{await loadCompanies()}catch(e){toast(e.message,true)}
  if(S.view==='companies')renderMain();
}

function vCompanies(){
  const q=S.co.q.trim().toLowerCase();
  const all=CO_LIST.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const nArch=all.filter(c=>c.archived).length;
  const list=all.filter(c=>(S.co.showArchived||!c.archived)&&(!q||c.name.toLowerCase().includes(q)));
  const active=all.filter(c=>!c.archived);
  const review=active.reduce((s,c)=>s+c.toReview,0),overdue=active.reduce((s,c)=>s+c.overdueCount,0);
  const h=head('Companies',all.length?`${active.length} active compan${active.length===1?'y':'ies'}${review?` · ${review} bank line${review===1?'':'s'} to review`:''}${overdue?` · ${overdue} overdue invoice${overdue===1?'':'s'}`:''}`:'',
    `${ME&&ME.role==='owner'?'<button class="btn" data-coact="users">Users &amp; security</button><button class="btn" data-coact="convert">Bring over from QuickBooks or Sage</button><button class="btn primary" data-coact="new">+ New company</button>':''}`);
  if(!all.length)return h+`<div class="panel" style="max-width:640px"><div class="empty"><b>Set up your first company</b>Each company keeps its own chart of accounts, customers, bank accounts and reports, in its own file.${ME&&ME.role==='owner'?'<div style="margin-top:14px" class="actions"><button class="btn primary" data-coact="new">+ New company</button><button class="btn" data-coact="convert">Bring over from QuickBooks or Sage</button></div>':''}</div></div>`;
  const fyEnd=c=>{const end=+c.fyStart===1?12:(+c.fyStart||1)-1;return `${monthName(end).slice(0,3)} ${new Date(2026,end,0).getDate()} year-end`};
  return h+`<div class="panel"><div class="toolbar">
    <input class="grow" type="search" id="coQ" placeholder="Search companies" value="${esc(S.co.q)}" aria-label="Search companies">
    ${nArch?`<label class="check"><input type="checkbox" id="coArch" ${S.co.showArchived?'checked':''}> Show archived (${nArch})</label>`:''}
  </div><div class="tbl-wrap"><table><thead><tr><th class="co-col">Company</th><th class="n" title="Bank lines waiting in For review">To review</th><th class="n" title="Overdue customer invoices">Overdue</th><th class="n" title="Customers owe the company">Receivable</th><th>Reconciled to</th><th>Last entry</th><th></th></tr></thead><tbody>
  ${list.length?list.map(c=>`<tr class="click ${c.archived?'archived':''}" data-coopen="${c.id}">
    <td class="co-col"><div class="co-name">${esc(c.name)} ${c.hasCode?'<span class="pill quiet" title="A 4-digit code is needed to open it">Code</span>':''} ${c.id===CO?'<span class="pill paid">Open</span>':''} ${c.archived?'<span class="pill quiet">Archived</span>':''}</div><div class="co-meta">${esc(PROVS[c.province]?.name||'')}${PROVS[c.province]?' · ':''}${esc(c.taxName||'')} ${c.taxRate??''}% · ${fyEnd(c)}</div></td>
    <td class="n">${c.toReview?`<b style="color:var(--info)">${c.toReview}</b>`:'<span class="muted">—</span>'}</td>
    <td class="n">${c.overdueCount?`<span class="neg">${c.overdueCount} · ${money(c.overdue)}</span>`:'<span class="muted">—</span>'}</td>
    <td class="n">${c.receivable?money(c.receivable):'<span class="muted">—</span>'}</td>
    <td>${c.lastReconciled?fmtDate(c.lastReconciled):'<span class="muted">Never</span>'}</td>
    <td>${c.lastEntry?fmtDate(c.lastEntry):'<span class="muted">None yet</span>'}</td>
    <td class="n" style="white-space:nowrap"><button class="btn sm primary" data-coopen="${c.id}">Open</button>${ME&&ME.role==='owner'?` <button class="btn sm ghost" data-coarch="${c.id}">${c.archived?'Restore':'Archive'}</button>`:''}</td></tr>`).join(''):emptyRow(7,'No companies match','Clear the search to see them all.')}
  </tbody></table></div></div>
  ${backupPanel()}
  <div class="muted" style="font-size:13px;margin-top:12px">Archiving hides a company from this list without deleting anything. Its books stay in their own file and you can restore them any time.</div>`;
}

async function coClick(ev,t,d){
  if(d.coarch){
    ev.stopPropagation();
    const c=CO_LIST.find(x=>x.id===d.coarch);if(!c)return true;
    try{await api('PUT','/api/companies/'+encodeURIComponent(c.id),{archived:!c.archived});await loadCompanies();renderMain();toast(c.archived?`${c.name} restored`:`${c.name} archived`)}catch(e){toast(e.message,true)}
    return true;
  }
  if(d.coopen){await openCompany(d.coopen);return true}
  if(d.coact==='new'){companyForm();return true}
  if(d.coact==='convert'){companyForm(true);return true}
  if(d.coact==='users'){showUsers();return true}
  return false;
}
function bindCompanies(m){
  const q=$('#coQ',m);if(q)q.oninput=()=>{S.co.q=q.value;renderMain()};
  const a=$('#coArch',m);if(a)a.onchange=()=>{S.co.showArchived=a.checked;renderMain()};
}

function companyForm(convert){
  const active=CO_LIST.filter(c=>!c.archived).sort((a,b)=>a.name.localeCompare(b.name));
  const f=openModal(convert?'Bring over a client':'New company',`${convert?'<div class="muted" style="font-size:13px">First, a new company for the client. Then choose the files exported from QuickBooks or Sage.</div>':''}<div class="fields">
    ${fld('nName','Company name',`<input type="text" id="nName" placeholder="e.g. Harbour Yoga Studio Inc.">`,true)}
    ${fld('nProv','Province or territory',`<select id="nProv">${provinceOptions('ON')}</select>`)}
    ${fld('nFy','Fiscal year-end',`<select id="nFy">${fyOptions(1)}</select>`)}
    ${fld('nLang','Language of the books',`<select id="nLang"><option value="en" ${isFr()?'':'selected'}>English</option><option value="fr" ${isFr()?'selected':''}>Français</option></select><span class="hint">Account names and example data. Each person still chooses the language of the screens.</span>`)}
    ${fld('nCode','Company code',`<input type="text" id="nCode" class="code-in" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="4 digits"><span class="hint">Typed each time someone on your team opens this company, so nobody works in the wrong client’s books. Clients don’t need it.</span>`,true)}
    ${fld('nCopy','Chart of accounts',`<select id="nCopy"><option value="">Standard small-business chart</option>${active.map(c=>`<option value="${c.id}">Copy from ${esc(c.name)}</option>`).join('')}</select>`,true)}
    </div>
    <div class="fields" data-custom hidden>${fld('nTaxName','Sales tax name',`<input type="text" id="nTaxName" value="VAT">`)}${fld('nTaxRate','Sales tax rate (%)',`<input type="number" id="nTaxRate" min="0" step="0.001" value="0">`)}</div>
    <div class="muted" data-qc hidden style="font-size:13px">GST and QST are tracked together in one “GST/QST payable” account at the combined 14.975%. If you file them separately, split the balance when you prepare the returns.</div>
    <label class="check" ${convert?'hidden':''}><input type="checkbox" id="nEx"> Add example customers and transactions to explore (you can clear them later)</label>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${convert?'Create and continue':'Create company'}</button>`);
  const prov=$('#nProv',f);
  const sync=()=>{$('[data-custom]',f).hidden=prov.value!=='';$('[data-qc]',f).hidden=prov.value!=='QC'};
  prov.onchange=sync;sync();
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const name=$('#nName',f).value.trim();if(!name)return f.err('Give the company a name.');
    if(CO_LIST.some(c=>c.name.toLowerCase()===name.toLowerCase())&&!await confirmBox('A company with this name exists','Create another company with the same name anyway?','Create'))return;
    const code=$('#nCode',f).value.trim();if(!/^\d{4}$/.test(code))return f.err('Choose a 4-digit company code.');
    const body={name,province:prov.value,fyStart:+$('#nFy',f).value,copyFrom:$('#nCopy',f).value,examples:$('#nEx',f).checked,lang:$('#nLang',f).value,code};
    if(!prov.value){body.taxName=$('#nTaxName',f).value.trim()||'Sales tax';body.taxRate=Math.max(0,+$('#nTaxRate',f).value||0)}
    const btn=f.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='Creating…';
    try{const r=await api('POST','/api/companies',body);await loadCompanies();S.cv=null;const nc=CO_LIST.find(c=>c.id===r.company.id);if(nc)nc.justMade=true;await openCompany(r.company.id,convert?'convert':undefined);toast(`${name} is ready`)}
    catch(err){f.err(err.message);btn.disabled=false;btn.textContent='Create company'}
  };
}

/* ---------- start-up ---------- */
let coRefresh=0;
function refreshCompaniesSoon(){clearTimeout(coRefresh);coRefresh=setTimeout(async()=>{try{await loadCompanies();if(S.view==='companies')renderMain()}catch(e){}},300)}
$('#coSwitch').onclick=()=>showCompanies();
window.addEventListener('hashchange',()=>{const id=location.hash.slice(1);if(id&&id!==CO&&CO_LIST.some(c=>c.id===id))openCompany(id)});

async function boot(){
  // Sign in first: nothing else loads without a session.
  try{await authStart()}
  catch(e){
    {$('#main').innerHTML=`<div class="banner err"><span><b>Can't reach the Tally Books server.</b> ${esc(e.message)}</span><button class="btn sm" data-reload>Try again</button></div>`;$('#main [data-reload]').onclick=()=>location.reload();$('#coName').textContent='Not connected';return}
  }
  try{await Promise.all([loadCompanies(),loadBackups()])}
  catch(e){$('#main').innerHTML=`<div class="banner err"><span><b>Can't reach the Tally Books server.</b> ${esc(e.message)}</span><button class="btn sm" data-reload>Try again</button></div>`;$('#main [data-reload]').onclick=()=>location.reload();$('#coName').textContent='Not connected';return}
  const active=CO_LIST.filter(c=>!c.archived);
  const pick=[location.hash.slice(1),lsGet()].find(id=>id&&CO_LIST.some(c=>c.id===id))||(active.length===1?active[0].id:null);
  if(pick)await openCompany(pick);else{S.view='companies';renderMain()}
  if(window.EventSource){
    const es=new EventSource('/api/events');
    es.onmessage=ev=>{try{const m=JSON.parse(ev.data);
      if(m.company&&m.company===CO&&m.rev!==S.rev)load();
      if(m.companies||(m.company&&S.view==='companies'))refreshCompaniesSoon();
    }catch(e){}};
    es.onopen=()=>{if(S.connErr)load()};
  }
}
boot();
