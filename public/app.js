'use strict';
/* ---------- helpers ---------- */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r2=n=>Math.round(((+n)||0)*100+Number.EPSILON*100)/100;
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const pad=n=>String(n).padStart(2,'0');
const iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const today=()=>iso(new Date());
const pd=s=>new Date(s+'T12:00:00');
const addDays=(s,n)=>{const d=pd(s);d.setDate(d.getDate()+n);return iso(d)};
const daysBetween=(a,b)=>Math.round((pd(b)-pd(a))/864e5);
const monthEnd=(y,m)=>iso(new Date(y,m,0)); // m is 1-12
const fmtDate=s=>s?pd(s).toLocaleDateString('en-CA',{year:'numeric',month:'short',day:'numeric'}):'';
function money(n,o={}){n=r2(n);const s=Math.abs(n).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2});const v=(o.sym===false?'':(S.company.currency||'$'))+s;return n<0?`(${v})`:v}
const mcell=n=>`<span class="${r2(n)<0?'neg':''}">${money(n)}</span>`;

const TYPES=['Asset','Liability','Equity','Income','Cost of Goods Sold','Expense'];
const DETAILS={Asset:[['','Other asset'],['bank','Bank or cash'],['ar','Accounts receivable']],Liability:[['','Other liability'],['card','Credit card'],['ap','Accounts payable'],['tax','Sales tax payable (GST/HST)'],['qst','QST payable']],Equity:[['','Other equity'],['ob','Opening balance equity']],Income:[['','Income']],'Cost of Goods Sold':[['','Cost of goods sold']],Expense:[['','Expense']]};
const detailLabel=a=>(DETAILS[a.type]||[]).find(d=>d[0]===(a.detail||''))?.[1]||'';
const debitNormal=t=>t==='Asset'||t==='Expense'||t==='Cost of Goods Sold';
const isPL=t=>t==='Income'||t==='Expense'||t==='Cost of Goods Sold';
const TLABEL={invoice:'Invoice',bill:'Bill',payment:'Payment received',billpayment:'Bill payment',expense:'Expense',deposit:'Deposit',transfer:'Transfer',journal:'Journal entry',taxpayment:'Sales tax payment'};

/* ---------- state + server API ---------- */
const S={accounts:[],entries:[],docs:[],contacts:[],company:{name:'My Business',fyStart:1,taxName:'HST',taxRate:13,terms:30,currency:'$'},
  loaded:false,connErr:false,rev:-1,view:'dashboard',param:null,
  sales:{tab:'docs',status:'all'},exp:{tab:'docs',status:'all'},tx:{q:'',type:'',from:'',to:''},
  rep:{tab:'pl',period:'fy',from:'',to:''},reg:{from:'',to:''}};
const COLS=['accounts','entries','docs','contacts','bankTxns','rules','recons','filings','employees','payruns'];
COLS.forEach(c=>{if(!S[c])S[c]=[]});

let CO=null; // id of the company whose books are open
// Company-scoped API paths: '/api/state' is sent as '/api/c/<company>/state'.
function coUrl(url){
  if(!/^\/api\/(?!companies|events|health|backups|auth|users|security)/.test(url))return url;
  if(!CO)throw new Error('Open a company first.');
  return url.replace(/^\/api\//,`/api/c/${encodeURIComponent(CO)}/`);
}
async function api(method,url,body){
  let r;url=coUrl(url);
  try{r=await fetch(url,{method,headers:body!==undefined?{'Content-Type':'application/json'}:{},body:body!==undefined?JSON.stringify(body):undefined})}
  catch(e){throw new Error("Can't reach the Tally Books server. Check that it's still running.")}
  let j=null;try{j=await r.json()}catch(e){}
  if(!r.ok){
    const err=new Error((j&&j.error)||`The server answered ${r.status}.`);err.status=r.status;err.info=j||{};
    // Signed out (expired, locked, or another tab signed out): ask to sign in again, then carry on.
    if(r.status===401&&!url.startsWith('/api/auth/')&&typeof sessionEnded==='function')sessionEnded(j);
    if(r.status===403&&j&&j.mustChange&&typeof renderLock==='function')renderLock('password');
    throw err;
  }
  return j;
}
let loading=null,reloadQueued=false;
async function load(){
  if(loading){reloadQueued=true;return loading}
  if(!CO)return;
  const co=CO;
  loading=(async()=>{
    try{const s=await api('GET','/api/state');if(co!==CO)return;COLS.forEach(c=>S[c]=s[c]||[]);S.company={...S.company,...s.company};S.rev=s.rev;S.connErr=false}
    catch(e){S.connErr=true}
    S.loaded=true;scheduleRender();
  })();
  await loading;loading=null;
  if(reloadQueued){reloadQueued=false;return load()}
}
async function write(fn){try{await fn();await load();return true}catch(e){toast(e.message,true);return false}}
// Editing a transaction keeps its cleared/reconciled marks for bank accounts it still uses.
function keepClear(col,id,data){
  if(col!=='entries'||!data||data.clear!==undefined)return data;
  const prev=S.entries.find(e=>e.id===id);if(!prev||!prev.clear)return data;
  const used=new Set((data.lines||[]).map(l=>l.account));const clear={};
  for(const[k,v]of Object.entries(prev.clear))if(used.has(k))clear[k]=v;
  return Object.keys(clear).length?{...data,clear}:data;
}
// Before saving a transaction dated in a period whose sales tax return was filed, ask first.
async function filedOk(writes){
  if(typeof filedWarning!=='function')return true;
  // Only changes to amounts, accounts or dates matter; ticking a transaction as cleared doesn't.
  const same=(a,b)=>a&&b&&a.date===b.date&&JSON.stringify(a.lines)===JSON.stringify(b.lines);
  const touched=writes.filter(w=>w.collection==='entries').filter(w=>w.op==='delete'||!same(S.entries.find(e=>e.id===w.id),w.data)).flatMap(w=>[w.op==='set'?w.data:null,S.entries.find(e=>e.id===w.id)]);
  const f=filedWarning(touched);
  return !f||confirmBox('This period’s return was filed',`This change affects sales tax between ${fmtDate(f.from)} and ${fmtDate(f.to)}, which you already filed. Your books will no longer match the return, and you may need to file an amendment. Save anyway?`,'Save anyway');
}
async function put(col,id,data){if(!await filedOk([{op:'set',collection:col,id,data}]))return false;return write(()=>api('PUT',`/api/records/${col}/${encodeURIComponent(id)}`,strip(keepClear(col,id,data))))}
async function del(col,id){if(!await filedOk([{op:'delete',collection:col,id}]))return false;return write(()=>api('DELETE',`/api/records/${col}/${encodeURIComponent(id)}`))}
async function batch(writes){
  if(!await filedOk(writes))return false;
  const all=writes.map(w=>({...w,data:w.data&&strip(keepClear(w.collection,w.id,w.data))}));
  return write(async()=>{for(let i=0;i<all.length;i+=400)await api('POST','/api/batch',{writes:all.slice(i,i+400)})});
}
const putCompany=data=>write(()=>api('PUT','/api/settings',data));
const strip=o=>{const c={...o};delete c.id;return c};

/* ---------- ledger math ---------- */
let PC=null;
function postings(){if(PC)return PC;PC=[];for(const e of S.entries)for(const l of(e.lines||[]))PC.push({e,account:l.account,debit:+l.debit||0,credit:+l.credit||0,memo:l.memo||'',date:e.date});return PC}
const acct=id=>S.accounts.find(a=>a.id===id);
const acctName=id=>{const a=acct(id);return a?a.name:'(deleted account)'};
const byDetail=d=>S.accounts.find(a=>a.detail===d&&a.active!==false)||S.accounts.find(a=>a.detail===d);
const contact=id=>S.contacts.find(c=>c.id===id);
const contactName=id=>contact(id)?.name||'';
const sortAccts=arr=>arr.slice().sort((a,b)=>TYPES.indexOf(a.type)-TYPES.indexOf(b.type)||String(a.code||'').localeCompare(String(b.code||''),undefined,{numeric:true})||a.name.localeCompare(b.name));
function rawBal(id,from,to){let d=0,c=0;for(const p of postings())if(p.account===id&&(!from||p.date>=from)&&(!to||p.date<=to)){d+=p.debit;c+=p.credit}return r2(d-c)}
function bal(id,from,to){const a=acct(id);const r=rawBal(id,from,to);return a&&!debitNormal(a.type)?r2(-r):r}
function fyStartOf(s){const m=+S.company.fyStart||1;const d=pd(s);let y=d.getFullYear();if(d.getMonth()+1<m)y--;return `${y}-${pad(m)}-01`}
function fyEndOf(s){const st=pd(fyStartOf(s));return iso(new Date(st.getFullYear()+1,st.getMonth(),0))}
function netIncome(from,to){let n=0;for(const a of S.accounts){if(a.type==='Income')n+=bal(a.id,from,to);else if(a.type==='Expense'||a.type==='Cost of Goods Sold')n-=bal(a.id,from,to)}return r2(n)}
function paidOn(docId,exceptEntry){return r2(S.entries.filter(e=>e.applyTo===docId&&e.id!==exceptEntry).reduce((s,e)=>s+(+e.amount||0),0))}
function docStatus(d){const b=r2((+d.total||0)-paidOn(d.id));if(b<=0.004)return{k:'paid',label:'Paid',bal:0};if(d.due&&d.due<today())return{k:'overdue',label:'Overdue',bal:b};if(b<r2(d.total))return{k:'partial',label:'Partial',bal:b};return{k:'open',label:'Open',bal:b}}
const entryTotal=e=>r2((e.lines||[]).reduce((s,l)=>s+(+l.debit||0),0));
const hasExamples=()=>COLS.some(c=>S[c].some(x=>x.example));

/* ---------- render loop ---------- */
let rq=0;
function scheduleRender(){PC=null;if(rq)return;rq=requestAnimationFrame(()=>{rq=0;renderMain()})}
function ready(){return S.loaded}
function go(view,param=null){S.view=view;S.param=param;renderMain();window.scrollTo(0,0)}
function renderMain(){
  $('#coName').textContent=CO?(S.loaded?S.company.name:'Opening…'):'No company open';
  document.title=CO&&S.loaded?`${S.company.name} · Tally Books`:'Tally Books';
  document.body.classList.toggle('no-co',!CO);
  $$('#nav button').forEach(b=>{if(b.dataset.view===S.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  if(S.view!=='companies'&&S.view!=='users'&&!ready())return;
  const od=S.docs.filter(d=>d.kind==='invoice'&&docStatus(d).k==='overdue').length;
  const oc=$('#odCount');oc.hidden=!od;oc.textContent=od;
  const nb=S.bankTxns.filter(b=>b.status==='new').length;const bc=$('#bankCount');bc.hidden=!nb;bc.textContent=nb;
  const nt=overdueReturns();const tc=$('#taxCount');tc.hidden=!nt;tc.textContent=nt;
  const np=overdueRemits();const pc=$('#payCount');pc.hidden=!np;pc.textContent=np;
  const V={companies:vCompanies,users:vUsers,dashboard:vDashboard,sales:()=>vDocs('invoice'),expenses:()=>vDocs('bill'),transactions:vTx,accounts:vAccounts,register:vRegister,banking:vBanking,salestax:vSalesTax,payroll:vPayroll,reports:vReports,settings:vSettings}[S.view]||vDashboard;
  const main=$('#main');
  const keepFocus=document.activeElement&&main.contains(document.activeElement)&&document.activeElement.id?document.activeElement.id:null;
  main.innerHTML=(S.view==='companies'||S.view==='users'?'':banners())+V();
  bindMain(main);
  if(keepFocus){const el=document.getElementById(keepFocus);if(el){el.focus();if(el.setSelectionRange&&el.type==='search'){const n=el.value.length;el.setSelectionRange(n,n)}}}
}
function banners(){
  let h='';
  if(S.connErr)h+=`<div class="banner err"><span><b>Can't reach the server.</b> Showing the last data loaded. Changes won't save until the connection is back.</span><button class="btn sm" data-act="retry">Try again</button></div>`;
  else if(!S.entries.length&&!S.docs.length&&!S.contacts.length)h+=`<div class="banner"><span><b>Your books are empty.</b> Start with + New, or load example data to see how everything fits together.</span><button class="btn sm" data-act="load-examples">Load example data</button></div>`;
  if(typeof BK!=='undefined'&&BK&&(!BK.enabled||BK.lastError))h+=`<div class="banner err"><span><b>${BK.enabled?'Backups aren’t working.':'Automatic backups are off.'}</b> ${BK.enabled?esc(BK.lastError):'Turn them on so your clients’ books are safe if this computer fails.'}</span><button class="btn sm" data-go="settings">Fix in Settings</button></div>`;
  if(hasExamples())h+=`<div class="banner"><span><b>Example data is loaded</b> so you can see how things work. Clear it when you're ready to enter your real books.</span><button class="btn sm" data-act="clear-examples">Clear example data</button></div>`;
  return h;
}
const head=(title,sub,actions='')=>`<div class="head"><div><h1>${esc(title)}</h1>${sub?`<div class="sub">${sub}</div>`:''}</div><div class="actions">${actions}</div></div>`;
const emptyRow=(cols,title,msg)=>`<tr><td colspan="${cols}"><div class="empty"><b>${title}</b>${msg}</div></td></tr>`;

/* ---------- views ---------- */
function vDashboard(){
  const t=today(),fy=fyStartOf(t);
  const banks=sortAccts(S.accounts.filter(a=>a.detail==='bank'||a.detail==='card'));
  const cash=r2(S.accounts.filter(a=>a.detail==='bank').reduce((s,a)=>s+bal(a.id),0));
  const inv=S.docs.filter(d=>d.kind==='invoice').map(d=>({d,st:docStatus(d)}));
  const bills=S.docs.filter(d=>d.kind==='bill').map(d=>({d,st:docStatus(d)}));
  const ar=r2(inv.reduce((s,x)=>s+x.st.bal,0)),ap=r2(bills.reduce((s,x)=>s+x.st.bal,0));
  const od=inv.filter(x=>x.st.k==='overdue');
  const ni=netIncome(fy,t);
  const attention=[...od.map(x=>({...x,why:`${daysBetween(x.d.due,t)} days overdue`})),
    ...bills.filter(x=>x.st.bal>0&&x.d.due&&x.d.due<=addDays(t,7)).map(x=>({...x,why:x.d.due<t?`${daysBetween(x.d.due,t)} days overdue`:`Due ${fmtDate(x.d.due)}`}))];
  const recent=S.entries.slice().sort((a,b)=>b.date.localeCompare(a.date)||(b.created||0)-(a.created||0)).slice(0,8);
  return head('Dashboard',`${esc(S.company.name)} · Fiscal year from ${fmtDate(fy)}`,`<button class="btn" data-new="expense">Record expense</button><button class="btn primary" data-new="invoice">New invoice</button>`)+
  `<div class="tiles">
    <div class="tile"><span class="lbl">Cash on hand</span><span class="val">${mcell(cash)}</span><span class="note">${S.accounts.filter(a=>a.detail==='bank').length} bank accounts</span></div>
    <div class="tile"><span class="lbl">Customers owe you</span><span class="val">${money(ar)}</span><span class="note">${od.length?`<span class="neg">${od.length} overdue · ${money(od.reduce((s,x)=>s+x.st.bal,0))}</span>`:'Nothing overdue'}</span></div>
    <div class="tile"><span class="lbl">You owe vendors</span><span class="val">${money(ap)}</span><span class="note">${bills.filter(x=>x.st.bal>0).length} unpaid bills</span></div>
    <div class="tile"><span class="lbl">Net income, this fiscal year</span><span class="val">${mcell(ni)}</span><span class="note">${fmtDate(fy)} – today</span></div>
  </div>
  <div class="grid2">
    <div class="stack">
      <div class="panel"><h3>Income and expenses, last 6 months<span class="legend"><span><i style="background:var(--bar-in)"></i>Income</span><span><i style="background:var(--bar-out)"></i>Expenses</span></span></h3><div class="pad">${chart6()}</div></div>
      <div class="panel"><h3>Recent transactions<button class="btn ghost sm" data-go="transactions">View all</button></h3>
        <div class="tbl-wrap"><table><tbody>${recent.length?recent.map(e=>`<tr class="click" data-entry="${e.id}"><td class="muted" style="white-space:nowrap">${fmtDate(e.date)}</td><td>${TLABEL[e.type]||e.type}${e.ref?` <span class="mono muted">#${esc(e.ref)}</span>`:''}</td><td class="trunc">${esc(contactName(e.contactId)||e.memo||'')}</td><td class="n">${money(entryTotal(e))}</td></tr>`).join(''):emptyRow(4,'No transactions yet','Use + New to record an invoice, expense or deposit.')}</tbody></table></div></div>
    </div>
    <div class="stack">
      <div class="panel"><h3>Needs attention</h3>${attention.length?`<div class="tbl-wrap"><table><tbody>${attention.map(x=>`<tr class="click" data-doc="${x.d.id}"><td><div>${x.d.kind==='invoice'?'Invoice':'Bill'} ${x.d.number?`<span class="mono">#${esc(x.d.number)}</span>`:''}</div><div class="muted" style="font-size:12.5px">${esc(contactName(x.d.contactId))} · <span class="${x.st.k==='overdue'?'neg':''}">${x.why}</span></div></td><td class="n">${money(x.st.bal)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><b>All caught up</b>No overdue invoices or bills due this week.</div>`}</div>
      <div class="panel"><h3>Bank and card accounts</h3><div class="tbl-wrap"><table><tbody>${banks.length?banks.map(a=>`<tr class="click" data-acct="${a.id}"><td>${esc(a.name)}<div class="muted" style="font-size:12px">${detailLabel(a)}</div></td><td class="n">${mcell(bal(a.id))}</td></tr>`).join(''):emptyRow(2,'No bank accounts','Add one under Chart of accounts.')}</tbody></table></div></div>
    </div>
  </div>`;
}
function chart6(){
  const now=pd(today());const months=[];
  for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);const y=d.getFullYear(),m=d.getMonth()+1;months.push({lbl:d.toLocaleDateString('en-CA',{month:'short'}),from:`${y}-${pad(m)}-01`,to:monthEnd(y,m)})}
  months.forEach(m=>{m.inc=0;m.exp=0;for(const a of S.accounts){if(a.type==='Income')m.inc+=bal(a.id,m.from,m.to);else if(isPL(a.type))m.exp+=bal(a.id,m.from,m.to)}m.inc=Math.max(0,r2(m.inc));m.exp=Math.max(0,r2(m.exp))});
  const max=Math.max(1,...months.map(m=>Math.max(m.inc,m.exp)));
  const mag=Math.pow(10,Math.floor(Math.log10(max)));const stepC=[1,2,2.5,5,10].map(s=>s*mag).find(s=>max/s<=4)||mag*10;const top=Math.ceil(max/stepC)*stepC;
  const W=600,H=220,L=56,R=8,T=10,B=26,ch=H-T-B,cw=(W-L-R)/6,bw=Math.min(28,cw*.3);
  const y=v=>T+ch-(v/top)*ch;
  let g='';for(let v=0;v<=top+1e-9;v+=stepC){g+=`<line class="grid" x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end">${v>=1000?(v/1000).toLocaleString('en-CA')+'k':v}</text>`}
  const bars=months.map((m,i)=>{const cx=L+cw*i+cw/2;return `<g><title>${m.lbl}: income ${money(m.inc)}, expenses ${money(m.exp)}</title><rect x="${cx-bw-2}" y="${y(m.inc)}" width="${bw}" height="${Math.max(0,T+ch-y(m.inc))}" rx="2" fill="var(--bar-in)"/><rect x="${cx+2}" y="${y(m.exp)}" width="${bw}" height="${Math.max(0,T+ch-y(m.exp))}" rx="2" fill="var(--bar-out)"/><text x="${cx}" y="${H-8}" text-anchor="middle">${m.lbl}</text></g>`}).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly income and expenses">${g}<line class="base" x1="${L}" x2="${W-R}" y1="${T+ch}" y2="${T+ch}"/>${bars}</svg>`;
}

function vDocs(kind){
  const inv=kind==='invoice',st=inv?S.sales:S.exp,ck=inv?'customer':'vendor';
  const tabs=`<div class="tabs" role="tablist"><button role="tab" data-dtab="docs" aria-selected="${st.tab==='docs'}">${inv?'Invoices':'Bills'}</button><button role="tab" data-dtab="contacts" aria-selected="${st.tab==='contacts'}">${inv?'Customers':'Vendors'}</button></div>`;
  const actions=inv?`<button class="btn" data-new="payment">Receive payment</button><button class="btn primary" data-new="invoice">New invoice</button>`:`<button class="btn" data-new="billpayment">Pay bill</button><button class="btn" data-new="expense">Expense</button><button class="btn primary" data-new="bill">New bill</button>`;
  const h=head(inv?'Sales':'Expenses',inv?'Invoices you send and the customers who owe you':'Bills you receive and the vendors you pay',actions)+tabs;
  const docs=S.docs.filter(d=>d.kind===kind).map(d=>({d,s:docStatus(d)}));
  if(st.tab==='contacts'){
    const cs=S.contacts.filter(c=>c.kind===ck).sort((a,b)=>a.name.localeCompare(b.name));
    return h+`<div class="panel"><div class="toolbar"><span class="grow muted">${cs.length} ${ck}s</span><button class="btn sm" data-newcontact="${ck}">+ Add ${ck}</button></div><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th class="n">Open balance</th><th class="n">Overdue</th></tr></thead><tbody>${cs.length?cs.map(c=>{const mine=docs.filter(x=>x.d.contactId===c.id);const ob=mine.reduce((s,x)=>s+x.s.bal,0),ov=mine.filter(x=>x.s.k==='overdue').reduce((s,x)=>s+x.s.bal,0);return `<tr class="click" data-contact="${c.id}"><td>${esc(c.name)} ${c.example?'<span class="pill ex">Example</span>':''}</td><td>${esc(c.email||'')}</td><td>${esc(c.phone||'')}</td><td class="n">${money(ob)}</td><td class="n ${ov?'neg':''}">${ov?money(ov):'—'}</td></tr>`}).join(''):emptyRow(5,`No ${ck}s yet`,`Add your first ${ck} to start ${inv?'invoicing':'tracking bills'}.`)}</tbody></table></div></div>`;
  }
  const sum=k=>r2(docs.filter(x=>k(x)).reduce((s,x)=>s+x.s.bal,0));
  const t30=addDays(today(),-30);
  const paid30=r2(S.entries.filter(e=>e.type===(inv?'payment':'billpayment')&&e.date>=t30).reduce((s,e)=>s+(+e.amount||0),0));
  const chips=`<div class="chips"><div class="chip"><div class="lbl">Open</div><div class="val">${money(sum(x=>x.s.bal>0))}</div></div><div class="chip"><div class="lbl">Overdue</div><div class="val ${sum(x=>x.s.k==='overdue')?'neg':''}">${money(sum(x=>x.s.k==='overdue'))}</div></div><div class="chip"><div class="lbl">${inv?'Received':'Paid'}, last 30 days</div><div class="val">${money(paid30)}</div></div></div>`;
  const list=docs.filter(x=>st.status==='all'||(st.status==='unpaid'?x.s.bal>0:x.s.k===st.status)).sort((a,b)=>b.d.date.localeCompare(a.d.date)||String(b.d.number).localeCompare(String(a.d.number),undefined,{numeric:true}));
  return h+chips+`<div class="panel"><div class="toolbar"><label class="flabel" for="docStatus">Show</label><select id="docStatus" data-docstatus><option value="all">All</option><option value="unpaid">Unpaid</option><option value="overdue">Overdue</option><option value="paid">Paid</option></select><span class="grow"></span></div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>No.</th><th>${inv?'Customer':'Vendor'}</th><th>Due</th><th class="n">Total</th><th class="n">Balance</th><th>Status</th><th></th></tr></thead><tbody>${list.length?list.map(x=>`<tr class="click" data-doc="${x.d.id}"><td style="white-space:nowrap">${fmtDate(x.d.date)}</td><td class="mono">${esc(x.d.number||'—')}</td><td class="trunc">${esc(contactName(x.d.contactId))}</td><td style="white-space:nowrap" class="${x.s.k==='overdue'?'neg':'muted'}">${fmtDate(x.d.due)}</td><td class="n">${money(x.d.total)}</td><td class="n">${money(x.s.bal)}</td><td><span class="pill ${x.s.k}">${x.s.label}</span></td><td class="n">${x.s.bal>0?`<button class="btn sm" data-pay="${x.d.id}">${inv?'Receive payment':'Pay'}</button>`:''}</td></tr>`).join(''):emptyRow(8,inv?'No invoices here':'No bills here',docs.length?'Try a different filter.':(inv?'Create an invoice to bill a customer.':'Enter a bill when a vendor invoices you.'))}</tbody></table></div></div>`;
}

function vTx(){
  const f=S.tx;
  return head('Transactions','Every entry in your books, newest first',`<button class="btn" data-new="journal">Journal entry</button><button class="btn primary" data-new="expense">Expense</button>`)+
  `<div class="panel"><div class="toolbar">
    <input class="grow" type="search" id="txQ" placeholder="Search payee, memo, number, amount" value="${esc(f.q)}" aria-label="Search transactions">
    <select id="txType" aria-label="Transaction type"><option value="">All types</option>${Object.entries(TLABEL).map(([k,v])=>`<option value="${k}" ${f.type===k?'selected':''}>${v}</option>`).join('')}</select>
    <input type="date" id="txFrom" value="${f.from}" aria-label="From date"><span class="muted">to</span><input type="date" id="txTo" value="${f.to}" aria-label="To date">
  </div><div id="txBody">${txTable()}</div></div>`;
}
function txTable(){
  const f=S.tx,q=f.q.trim().toLowerCase();
  const rows=S.entries.filter(e=>(!f.type||e.type===f.type)&&(!f.from||e.date>=f.from)&&(!f.to||e.date<=f.to)&&(!q||[e.ref,e.memo,contactName(e.contactId),money(entryTotal(e)),String(entryTotal(e)),...(e.lines||[]).map(l=>acctName(l.account)+' '+(l.memo||''))].join(' ').toLowerCase().includes(q)))
    .sort((a,b)=>b.date.localeCompare(a.date)||(b.created||0)-(a.created||0));
  const tot=r2(rows.reduce((s,e)=>s+entryTotal(e),0));
  return `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Payee / customer</th><th>Accounts</th><th>Memo</th><th class="n">Amount</th></tr></thead><tbody>${rows.length?rows.map(e=>{const ac=[...new Set((e.lines||[]).map(l=>acctName(l.account)))];return `<tr class="click" data-entry="${e.id}"><td style="white-space:nowrap">${fmtDate(e.date)}</td><td style="white-space:nowrap">${TLABEL[e.type]||e.type}${e.example?' <span class="pill ex">Example</span>':''}</td><td class="mono">${esc(e.ref||'')}</td><td class="trunc">${esc(contactName(e.contactId))}</td><td class="trunc muted" title="${esc(ac.join(', '))}">${esc(ac.length>2?ac.slice(0,2).join(', ')+` +${ac.length-2}`:ac.join(', '))}</td><td class="trunc muted">${esc(e.memo||'')}</td><td class="n">${money(entryTotal(e))}</td></tr>`}).join(''):emptyRow(7,S.entries.length?'No matching transactions':'No transactions yet',S.entries.length?'Clear the search or widen the dates.':'Use + New to record your first one.')}</tbody>${rows.length?`<tfoot><tr><td colspan="6" class="muted">${rows.length} transaction${rows.length===1?'':'s'}</td><td class="n"><b>${money(tot)}</b></td></tr></tfoot>`:''}</table></div>`;
}

function vAccounts(){
  const list=sortAccts(S.accounts);
  let rows='',cur='';
  for(const a of list){
    if(a.type!==cur){cur=a.type;rows+=`<tr><td colspan="4" style="background:var(--surface-2);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">${cur}</td></tr>`}
    const b=isPL(a.type)?bal(a.id,fyStartOf(today()),today()):bal(a.id);
    rows+=`<tr class="click" data-acct="${a.id}"><td class="mono">${esc(a.code||'')}</td><td>${esc(a.name)} ${a.active===false?'<span class="pill quiet">Inactive</span>':''}</td><td class="muted">${detailLabel(a)}</td><td class="n">${mcell(b)}</td></tr>`;
  }
  return head('Chart of accounts','Balance sheet accounts show all-time balances; income and expense accounts show this fiscal year',`<button class="btn primary" data-new="account">+ Add account</button>`)+
  `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Account</th><th>Detail</th><th class="n">Balance</th></tr></thead><tbody>${rows||emptyRow(4,'No accounts yet','Add accounts to start recording transactions.')}</tbody></table></div></div>`;
}

function vRegister(){
  const a=acct(S.param);if(!a)return head('Account not found','')+`<button class="btn" data-go="accounts">Back to chart of accounts</button>`;
  const f=S.reg,dn=debitNormal(a.type);
  const ps=postings().filter(p=>p.account===a.id).sort((x,y)=>x.date.localeCompare(y.date)||(x.e.created||0)-(y.e.created||0));
  let run=f.from?bal(a.id,null,addDays(f.from,-1)):0;
  const shown=[];for(const p of ps){const amt=dn?p.debit-p.credit:p.credit-p.debit;if(f.from&&p.date<f.from)continue;if(f.to&&p.date>f.to)continue;run=r2(run+amt);shown.push({p,run})}
  const bank=a.detail==='bank'||a.detail==='card';
  const cIn=bank?(a.detail==='card'?'Charge':'Deposit'):'Debit',cOut=bank?(a.detail==='card'?'Payment':'Withdrawal'):'Credit';
  return `<button class="btn ghost sm" data-go="accounts" style="margin-bottom:8px">← Chart of accounts</button>`+head(a.name,`${a.code?`<span class="mono">${esc(a.code)}</span> · `:''}${a.type}${detailLabel(a)&&a.detail?' · '+detailLabel(a):''} · Balance ${mcell(bal(a.id))}`,`<button class="btn" data-editacct="${a.id}">Edit account</button>`)+
  `<div class="panel"><div class="toolbar"><span class="flabel">Dates</span><input type="date" id="regFrom" value="${f.from}" aria-label="From date"><span class="muted">to</span><input type="date" id="regTo" value="${f.to}" aria-label="To date"><span class="grow"></span></div>
  <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Payee</th><th>Memo</th><th class="n">${dn?cIn:cOut}</th><th class="n">${dn?cOut:cIn}</th><th class="n">Balance</th>${bank?'<th title="C = cleared, R = reconciled">✓</th>':''}</tr></thead><tbody>
  ${f.from?`<tr><td colspan="7" class="muted">Opening balance</td><td class="n">${mcell(bal(a.id,null,addDays(f.from,-1)))}</td></tr>`:''}
  ${shown.length?shown.slice().reverse().map(({p,run})=>`<tr class="click" data-entry="${p.e.id}"><td style="white-space:nowrap">${fmtDate(p.date)}</td><td style="white-space:nowrap">${TLABEL[p.e.type]||p.e.type}</td><td class="mono">${esc(p.e.ref||'')}</td><td class="trunc">${esc(contactName(p.e.contactId))}</td><td class="trunc muted">${esc(p.memo||p.e.memo||'')}</td><td class="n">${(dn?p.debit:p.credit)?money(dn?p.debit:p.credit):''}</td><td class="n">${(dn?p.credit:p.debit)?money(dn?p.credit:p.debit):''}</td><td class="n">${mcell(run)}</td>${bank?`<td class="mono muted">${({c:'C',r:'R'})[p.e.clear?.[a.id]]||''}</td>`:''}</tr>`).join(''):emptyRow(8,'No activity','Nothing has been posted to this account in this date range.')}
  </tbody></table></div></div>`;
}

function periodRange(p){
  const t=today(),d=pd(t),y=d.getFullYear(),m=d.getMonth()+1;
  switch(p){
    case 'month':return[`${y}-${pad(m)}-01`,monthEnd(y,m)];
    case 'lastmonth':{const x=new Date(y,m-2,1);return[iso(x),monthEnd(x.getFullYear(),x.getMonth()+1)]}
    case 'quarter':{const q=Math.floor((m-1)/3)*3+1;return[`${y}-${pad(q)}-01`,monthEnd(y,q+2)]}
    case 'fy':return[fyStartOf(t),fyEndOf(t)];
    case 'lastfy':{const s=fyStartOf(t),ls=addDays(s,-1);return[fyStartOf(ls),ls]}
    case 'ytd':return[fyStartOf(t),t];
    case 'all':return['1900-01-01',t];
    default:return[S.rep.from||fyStartOf(t),S.rep.to||t];
  }
}
function vReports(){
  const R=S.rep;const T=[['pl','Profit and loss'],['bs','Balance sheet'],['tb','Trial balance'],['gl','General ledger'],['ar','A/R aging'],['ap','A/P aging']];
  if(R.period!=='custom'){const[a,b]=periodRange(R.period);R.from=a;R.to=b}
  const pointInTime=R.tab!=='pl'&&R.tab!=='gl';
  return head('Reports','')+`<div class="tabs" role="tablist">${T.map(([k,v])=>`<button role="tab" data-rtab="${k}" aria-selected="${R.tab===k}">${v}</button>`).join('')}</div>
  <div class="panel"><div class="toolbar">
    ${R.tab==='ar'||R.tab==='ap'?`<span class="muted">Aged as of ${fmtDate(today())}</span>`:`<label class="flabel" for="repPeriod">${pointInTime?'As of':'Period'}</label><select id="repPeriod">${[['month','This month'],['lastmonth','Last month'],['quarter','This quarter'],['ytd','Fiscal year to date'],['fy','This fiscal year'],['lastfy','Last fiscal year'],['all','All dates'],['custom','Custom']].map(([k,v])=>`<option value="${k}" ${R.period===k?'selected':''}>${v}</option>`).join('')}</select>
    ${pointInTime?'':`<input type="date" id="repFrom" value="${R.from}" aria-label="From date"><span class="muted">to</span>`}<input type="date" id="repTo" value="${R.to}" aria-label="${pointInTime?'As of date':'To date'}">`}
    ${R.tab==='gl'?`<select id="repAcct" aria-label="Account"><option value="">All accounts</option>${acctOptions(R.acct||'')}</select>`:''}
    <span class="grow"></span><button class="btn sm" data-act="export">Export CSV</button>
  </div><div id="repBody">${reportBody()}</div></div>`;
}
function reportBody(){return({pl:rPL,bs:rBS,tb:rTB,gl:rGL,ar:()=>rAging('invoice'),ap:()=>rAging('bill')})[S.rep.tab]().html}
const rh=(t,sub)=>`<div class="rh"><b>${esc(S.company.name)}</b><div style="font-weight:600;margin-top:2px">${t}</div><span>${sub}</span></div>`;
const rrow=(cls,label,amt,acctId)=>`<tr class="${cls}"><td>${acctId?`<button class="link" data-acct="${acctId}">${esc(label)}</button>`:esc(label)}</td><td class="n">${amt===null?'':mcell(amt)}</td></tr>`;
function rPL(){
  const{from,to}=S.rep;const csv=[['Account','Amount']];let h='';
  const sec=(type,title)=>{const as=sortAccts(S.accounts.filter(a=>a.type===type)).map(a=>({a,v:bal(a.id,from,to)})).filter(x=>x.v);const tot=r2(as.reduce((s,x)=>s+x.v,0));if(!as.length&&type==='Cost of Goods Sold')return 0;h+=rrow('sec',title,null);as.forEach(x=>{h+=rrow('item',(x.a.code?x.a.code+' ':'')+x.a.name,x.v,x.a.id);csv.push([(x.a.code?x.a.code+' ':'')+x.a.name,x.v])});h+=rrow('tot','Total '+title.toLowerCase(),tot);csv.push(['Total '+title.toLowerCase(),tot]);return tot};
  const inc=sec('Income','Income');const cogs=sec('Cost of Goods Sold','Cost of goods sold');
  if(cogs){h+=rrow('tot','Gross profit',r2(inc-cogs));csv.push(['Gross profit',r2(inc-cogs)])}
  const exp=sec('Expense','Expenses');const ni=r2(inc-cogs-exp);
  h+=`<tr class="spacer"><td colspan="2"></td></tr>`+rrow('grand','Net income',ni);csv.push(['Net income',ni]);
  return{html:`<div class="report">${rh('Profit and loss',`${fmtDate(from)} – ${fmtDate(to)}`)}<div class="tbl-wrap"><table>${h}</table></div></div>`,csv,name:`profit-and-loss_${from}_${to}`};
}
function rBS(){
  const to=S.rep.to,fy=fyStartOf(to);const csv=[['Account','Amount']];let h='';
  const re=netIncome(null,addDays(fy,-1)),cy=netIncome(fy,to);
  const sec=(type,title,extra=[])=>{const as=sortAccts(S.accounts.filter(a=>a.type===type)).map(a=>({l:(a.code?a.code+' ':'')+a.name,v:bal(a.id,null,to),id:a.id})).filter(x=>x.v).concat(extra.filter(x=>x.v));const tot=r2(as.reduce((s,x)=>s+x.v,0));h+=rrow('sec',title,null);as.forEach(x=>{h+=rrow('item',x.l,x.v,x.id);csv.push([x.l,x.v])});h+=rrow('tot','Total '+title.toLowerCase(),tot);csv.push(['Total '+title.toLowerCase(),tot]);return tot};
  const A=sec('Asset','Assets');h+=`<tr class="spacer"><td colspan="2"></td></tr>`;
  const L=sec('Liability','Liabilities');
  const E=sec('Equity','Equity',[{l:'Retained earnings',v:re},{l:'Net income, current fiscal year',v:cy}]);
  h+=rrow('grand','Total liabilities and equity',r2(L+E));csv.push(['Total liabilities and equity',r2(L+E)]);
  const off=r2(A-L-E);
  return{html:`<div class="report">${rh('Balance sheet',`As of ${fmtDate(to)}`)}<div class="tbl-wrap"><table>${h}</table></div>${Math.abs(off)>0.004?`<div class="banner err" style="margin:12px 16px">Out of balance by ${money(off)}. Check for entries posted to deleted accounts.</div>`:''}</div>`,csv,name:`balance-sheet_${to}`};
}
function rTB(){
  const to=S.rep.to,fy=fyStartOf(to);const csv=[['Code','Account','Type','Debit','Credit']];let h='',td=0,tc=0;
  const add=(code,name,type,raw,id)=>{if(Math.abs(raw)<0.005)return;const d=raw>0?raw:0,c=raw<0?-raw:0;td+=d;tc+=c;h+=`<tr><td class="mono">${esc(code)}</td><td>${id?`<button class="link" data-acct="${id}">${esc(name)}</button>`:esc(name)}</td><td class="n">${d?money(d):''}</td><td class="n">${c?money(c):''}</td></tr>`;csv.push([code,name,type,r2(d),r2(c)])};
  for(const a of sortAccts(S.accounts))add(a.code||'',a.name,a.type,isPL(a.type)?rawBal(a.id,fy,to):rawBal(a.id,null,to),a.id);
  add('','Retained earnings','Equity',-netIncome(null,addDays(fy,-1)));
  csv.push(['','Total','',r2(td),r2(tc)]);
  return{html:`<div class="report">${rh('Trial balance',`As of ${fmtDate(to)} · income and expenses from ${fmtDate(fy)}`)}<div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>${h||`<tr><td colspan="4" class="muted">No balances.</td></tr>`}</tbody><tfoot><tr class="grand"><td></td><td>Total</td><td class="n">${money(td)}</td><td class="n">${money(tc)}</td></tr></tfoot></table></div></div>`,csv,name:`trial-balance_${to}`};
}
/* General ledger: every posting in the period, grouped by account, with an opening balance, a running balance
   and a closing balance. Income and expense accounts open with their balance since the start of the fiscal year;
   balance sheet accounts open with their all-time balance. Balances are shown the way the account normally runs
   (debits up for assets and expenses, credits up for liabilities, equity and income). */
function rGL(){
  const{from,to}=S.rep,only=S.rep.acct||'';
  const csv=[['Account','Date','Type','No.','Name','Memo','Debit','Credit','Balance']];let h='',td=0,tc=0,n=0;
  const byAcct={};for(const p of postings())if(p.date>=from&&p.date<=to)(byAcct[p.account]=byAcct[p.account]||[]).push(p);
  for(const a of sortAccts(S.accounts)){
    if(only&&a.id!==only)continue;
    const ps=(byAcct[a.id]||[]).sort((x,y)=>x.date.localeCompare(y.date)||(x.e.created||0)-(y.e.created||0));
    const dn=debitNormal(a.type),sign=dn?1:-1;
    const open=isPL(a.type)?(fyStartOf(from)<from?bal(a.id,fyStartOf(from),addDays(from,-1)):0):bal(a.id,null,addDays(from,-1));
    if(!ps.length&&!open&&!only)continue;
    const label=(a.code?a.code+' ':'')+a.name;let run=open,ad=0,ac=0;
    h+=`<tbody class="gl-acct"><tr class="sec"><td colspan="8"><button class="link" data-acct="${a.id}">${esc(label)}</button> <span class="muted">· ${a.type}</span></td></tr>
      <tr class="gl-open"><td></td><td colspan="5" class="muted">Opening balance${isPL(a.type)?' (fiscal year to date)':''}</td><td></td><td class="n">${mcell(open)}</td></tr>`;
    csv.push([label,from,'Opening balance','','','','','',r2(open)]);
    for(const p of ps){
      run=r2(run+sign*(p.debit-p.credit));ad+=p.debit;ac+=p.credit;n++;
      const name=contactName(p.e.contactId)||(p.e.type==='payrun'?'Payroll':'');
      h+=`<tr class="click" data-entry="${p.e.id}"><td style="white-space:nowrap">${fmtDate(p.date)}</td><td style="white-space:nowrap">${TLABEL[p.e.type]||p.e.type}</td><td class="mono">${esc(p.e.ref||'')}</td><td class="trunc">${esc(name)}</td><td class="trunc muted">${esc(p.memo||p.e.memo||'')}</td><td class="n">${p.debit?money(p.debit):''}</td><td class="n">${p.credit?money(p.credit):''}</td><td class="n">${mcell(run)}</td></tr>`;
      csv.push([label,p.date,TLABEL[p.e.type]||p.e.type,p.e.ref||'',name,p.memo||p.e.memo||'',r2(p.debit)||'',r2(p.credit)||'',run]);
    }
    td+=ad;tc+=ac;
    h+=`<tr class="tot"><td colspan="5">Total ${esc(label)}</td><td class="n">${money(ad)}</td><td class="n">${money(ac)}</td><td class="n">${mcell(run)}</td></tr></tbody>`;
    csv.push(['Total '+label,'','','','','',r2(ad),r2(ac),run]);
  }
  csv.push(['Total','','','','','',r2(td),r2(tc),'']);
  const out=Math.abs(r2(td-tc))>0.004&&!only;
  return{html:`<div class="report" style="max-width:none">${rh('General ledger',`${fmtDate(from)} – ${fmtDate(to)}${only?' · '+esc(acctName(only)):''}`)}<div class="tbl-wrap"><table class="gl"><thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Name</th><th>Memo</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead>
    ${h||`<tbody><tr><td colspan="8" class="muted" style="padding:16px">No transactions in this period.</td></tr></tbody>`}
    ${h&&!only?`<tfoot><tr class="grand"><td colspan="5">Total, ${n} line${n===1?'':'s'}</td><td class="n">${money(td)}</td><td class="n">${money(tc)}</td><td></td></tr></tfoot>`:''}</table></div>
    ${out?`<div class="banner err" style="margin:12px 16px">Debits and credits differ by ${money(r2(td-tc))}. Check for entries posted to deleted accounts.</div>`:''}</div>`,csv,name:`general-ledger_${from}_${to}`};
}
function rAging(kind){
  const t=today(),B=['Current','1–30','31–60','61–90','Over 90'];const by={};
  for(const d of S.docs.filter(x=>x.kind===kind)){const s=docStatus(d);if(s.bal<=0)continue;const late=d.due?daysBetween(d.due,t):0;const i=late<=0?0:late<=30?1:late<=60?2:late<=90?3:4;const k=d.contactId||'?';(by[k]=by[k]||[0,0,0,0,0])[i]+=s.bal}
  const csv=[[kind==='invoice'?'Customer':'Vendor',...B,'Total']];const tot=[0,0,0,0,0];
  const rows=Object.entries(by).sort((a,b)=>contactName(a[0]).localeCompare(contactName(b[0]))).map(([k,v])=>{v.forEach((x,i)=>tot[i]+=x);const s=v.reduce((a,b)=>a+b,0);csv.push([contactName(k),...v.map(r2),r2(s)]);return `<tr><td>${esc(contactName(k)||'No contact')}</td>${v.map((x,i)=>`<td class="n ${i>=2&&x?'neg':''}">${x?money(x):'—'}</td>`).join('')}<td class="n"><b>${money(s)}</b></td></tr>`}).join('');
  const all=tot.reduce((a,b)=>a+b,0);csv.push(['Total',...tot.map(r2),r2(all)]);
  return{html:`<div class="report" style="max-width:none">${rh(kind==='invoice'?'Accounts receivable aging':'Accounts payable aging',`As of ${fmtDate(t)} · days past due`)}<div class="tbl-wrap"><table><thead><tr><th>${kind==='invoice'?'Customer':'Vendor'}</th>${B.map(b=>`<th class="n">${b}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>${rows||`<tr><td colspan="7" class="muted" style="padding:16px">Nothing outstanding.</td></tr>`}</tbody>${rows?`<tfoot><tr class="grand"><td>Total</td>${tot.map(x=>`<td class="n">${money(x)}</td>`).join('')}<td class="n">${money(all)}</td></tr></tfoot>`:''}</table></div></div>`,csv,name:`${kind==='invoice'?'ar':'ap'}-aging_${t}`};
}

function vSettings(){
  const c=S.company;
  return head('Settings','Company details and defaults used on new transactions')+`<div class="panel" style="max-width:640px"><form class="pad" id="setForm" style="display:flex;flex-direction:column;gap:14px">
  <div class="fields">
    <div class="field" style="grid-column:1/-1"><label for="sName">Business name</label><input type="text" id="sName" value="${esc(c.name)}" required></div>
    <div class="field"><label for="sFy">Fiscal year-end</label><select id="sFy">${fyOptions(c.fyStart)}</select></div>
    <div class="field"><label for="sFreq">Sales tax filing</label><select id="sFreq">${[['monthly','Monthly'],['quarterly','Quarterly'],['annual','Annual']].map(([k,v])=>`<option value="${k}" ${(c.filingFreq||'quarterly')===k?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label for="sProv">Province or territory</label><select id="sProv">${provinceOptions(c.province)}</select><span class="hint">Changing it fills in the sales tax below</span></div>
    <div class="field"><label for="sTerms">Payment terms (days)</label><input type="number" id="sTerms" min="0" step="1" value="${esc(c.terms)}"></div>
    <div class="field"><label for="sTaxName">Sales tax name</label><input type="text" id="sTaxName" value="${esc(c.taxName)}"><span class="hint">For example HST, GST or VAT</span></div>
    <div class="field"><label for="sTaxRate">Sales tax rate (%)</label><input type="number" id="sTaxRate" min="0" step="0.001" value="${esc(c.taxRate)}"></div>
    <div class="field"><label for="sCur">Currency symbol</label><input type="text" id="sCur" maxlength="4" value="${esc(c.currency)}"></div>
    <div class="field"><label for="sBn">Business / tax number</label><input type="text" id="sBn" value="${esc(c.bn||'')}"><span class="hint">Shown for your reference</span></div>
  </div>
  <div><button class="btn primary" type="submit">Save settings</button></div></form></div>
  ${payrollSettingsPanel()}
  ${backupPanel()}
  <div class="panel" style="max-width:640px;margin-top:16px"><h3>Backup and restore</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <span class="muted">A backup is a single file with every account, contact, invoice, bill and transaction. Keep one somewhere safe, and restore it here or on another computer.</span>
    <div class="actions"><button class="btn" data-act="backup">Download backup</button><button class="btn" data-act="restore">Restore from backup…</button><input type="file" id="restoreFile" accept=".json,application/json" hidden></div>
  </div></div>
  <div class="panel" style="max-width:640px;margin-top:16px"><h3>Example data</h3><div class="pad" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span class="muted">${hasExamples()?'Sample customers, vendors and transactions are marked “Example”. Clearing removes only those; your chart of accounts stays.':'Load a few sample customers, vendors and transactions to explore. They’re marked “Example” and can be cleared in one click.'}</span>${hasExamples()?'<button class="btn danger" data-act="clear-examples">Clear example data</button>':'<button class="btn" data-act="load-examples">Load example data</button>'}</div></div>`;
}

/* ---------- main bindings ---------- */
function bindMain(m){
  m.onclick=async e=>{
    const t=e.target.closest('button,tr.click');if(!t||!m.contains(t))return;
    const d=t.dataset;
    if(S.view==='banking'&&await bankClick(e,t,d))return;
    if(S.view==='companies'&&await coClick(e,t,d))return;
    if(S.view==='salestax'&&await stClick(e,t,d))return;
    if(S.view==='payroll'&&await payClick(e,t,d))return;
    if(d.bkact||d.bkfolder)return bkAction(d.bkact,d);
    if(d.new)return openNew(d.new);
    if(d.go)return go(d.go);
    if(d.pay){e.stopPropagation();const doc=S.docs.find(x=>x.id===d.pay);return payForm(doc.kind==='invoice'?'payment':'billpayment',null,doc.id)}
    if(d.editacct)return accountForm(acct(d.editacct));
    if(d.acct){S.reg={from:'',to:''};return go('register',d.acct)}
    if(d.entry)return openEntry(S.entries.find(x=>x.id===d.entry));
    if(d.doc){const doc=S.docs.find(x=>x.id===d.doc);return doc&&docForm(doc.kind,doc)}
    if(d.contact)return contactForm(contact(d.contact));
    if(d.newcontact)return contactForm(null,d.newcontact);
    if(d.dtab){(S.view==='sales'?S.sales:S.exp).tab=d.dtab;return renderMain()}
    if(d.rtab){S.rep.tab=d.rtab;return renderMain()}
    if(d.act==='clear-examples')return clearExamples();
    if(d.act==='export')return exportCSV();
    if(d.act==='retry')return load();
    if(d.act==='load-examples')return loadExamples();
    if(d.act==='backup')return saveFile(`${(S.company.name||'books').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase()}-backup-${today()}.json`,await fetch(coUrl('/api/backup')).then(r=>r.blob()));
    if(d.act==='restore')return $('#restoreFile').click();
  };
  const ds=$('#docStatus',m);if(ds){const st=S.view==='sales'?S.sales:S.exp;ds.value=st.status;ds.onchange=()=>{st.status=ds.value;renderMain()}}
  const txU=()=>{S.tx={q:$('#txQ').value,type:$('#txType').value,from:$('#txFrom').value,to:$('#txTo').value};$('#txBody').innerHTML=txTable()};
  ['txQ','txType','txFrom','txTo'].forEach(id=>{const el=$('#'+id,m);if(el)el.oninput=el.onchange=txU});
  const rf=$('#regFrom',m),rt=$('#regTo',m);if(rf){rf.onchange=rt.onchange=()=>{S.reg={from:rf.value,to:rt.value};renderMain()}}
  const rp=$('#repPeriod',m);if(rp)rp.onchange=()=>{S.rep.period=rp.value;renderMain()};
  const ra=$('#repAcct',m);if(ra)ra.onchange=()=>{S.rep.acct=ra.value;renderMain()};
  ['repFrom','repTo'].forEach(id=>{const el=$('#'+id,m);if(el)el.onchange=()=>{S.rep.period='custom';S.rep.from=($('#repFrom')||{}).value||S.rep.from;S.rep.to=$('#repTo').value;renderMain()}});
  const rf2=$('#restoreFile',m);if(rf2)rf2.onchange=()=>{const f=rf2.files[0];rf2.value='';if(f)restoreBackup(f)};
  if(S.view==='banking')bindBanking(m);
  if(S.view==='companies')bindCompanies(m);
  bindBackups(m);
  if(S.view==='users')bindUsers(m);
  if(S.view==='salestax')bindSalesTax(m);
  bindPayrollSettings(m);
  const sp=$('#sProv',m);if(sp)sp.onchange=()=>{const p=PROVS[sp.value];if(p){$('#sTaxName').value=p.taxName;$('#sTaxRate').value=p.taxRate}};
  const sf=$('#setForm',m);if(sf)sf.onsubmit=async e=>{e.preventDefault();const data={...strip(S.company),name:$('#sName').value.trim()||'My Business',fyStart:+$('#sFy').value,terms:Math.max(0,parseInt($('#sTerms').value)||0),taxName:$('#sTaxName').value.trim()||'Sales tax',taxRate:Math.max(0,+$('#sTaxRate').value||0),currency:$('#sCur').value||'$',bn:$('#sBn').value.trim(),province:$('#sProv').value,filingFreq:$('#sFreq').value};if(await putCompany(data))toast('Settings saved')};
}
function exportCSV(){
  const R=S.rep;const r=({pl:rPL,bs:rBS,tb:rTB,gl:rGL,ar:()=>rAging('invoice'),ap:()=>rAging('bill')})[R.tab]();
  const text=r.csv.map(row=>row.map(v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');
  saveFile(r.name+'.csv',new Blob(['﻿'+text],{type:'text/csv;charset=utf-8'}));
}
function saveFile(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}
async function loadExamples(){if(await write(()=>api('POST','/api/examples')))toast('Example data loaded')}
async function restoreBackup(file){
  let body;try{body=JSON.parse(await file.text())}catch(e){toast('That file isn’t valid JSON.',true);return}
  if(body.format!=='tally-books-backup'){toast('That file isn’t a Tally Books backup.',true);return}
  const n=COLS.reduce((s,c)=>s+(body[c]||[]).length,0);
  if(!await confirmBox('Restore this backup?',`Everything currently in your books will be replaced with the ${n} records in ${file.name} (saved ${body.exportedAt?fmtDate(body.exportedAt.slice(0,10)):'on an unknown date'}). Download a backup first if you might need the current data.`,'Replace and restore'))return;
  if(await write(()=>api('POST','/api/restore',body)))toast('Backup restored');
}
async function clearExamples(){
  if(!await confirmBox('Clear example data?','This removes every customer, vendor, employee, invoice, bill and transaction marked “Example”, and any pay runs for example employees. Your chart of accounts and anything you entered yourself stay.','Clear examples'))return;
  const ex=S.entries.filter(x=>x.example);
  const exEmp=new Set(S.employees.filter(x=>x.example).map(x=>x.id));
  const runs=S.payruns.filter(r=>r.lines.some(l=>exEmp.has(l.employeeId)));
  const writes=[...runs.map(r=>({op:'delete',collection:'payruns',id:r.id})),...runs.filter(r=>S.entries.some(e=>e.id===r.entryId)).map(r=>({op:'delete',collection:'entries',id:r.entryId})),...S.bankTxns.filter(x=>x.example).map(x=>({op:'delete',collection:'bankTxns',id:x.id})),...S.rules.filter(x=>x.example).map(x=>({op:'delete',collection:'rules',id:x.id})),
    ...[...ex.filter(e=>e.applyTo),...ex.filter(e=>!e.applyTo)].map(x=>({op:'delete',collection:'entries',id:x.id}))]
    .concat(S.docs.filter(x=>x.example).map(x=>({op:'delete',collection:'docs',id:x.id})),S.contacts.filter(x=>x.example).map(x=>({op:'delete',collection:'contacts',id:x.id})),[...exEmp].map(id=>({op:'delete',collection:'employees',id})));
  if(!writes.length)return;
  if(await batch(writes))toast(`Removed ${writes.length} example records`);
}

/* ---------- modal plumbing ---------- */
let modalKey=null;
function openModal(title,body,foot,size=''){
  const root=$('#modalRoot');
  root.innerHTML=`<div class="scrim"><form class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}" novalidate><header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header><div class="mbody">${body}<div class="err-msg" data-err></div></div><div class="mfoot">${foot}</div></form></div>`;
  const f=root.querySelector('form');
  root.querySelector('.scrim').addEventListener('mousedown',e=>{if(e.target.classList.contains('scrim'))closeModal()});
  $$('[data-close]',f).forEach(b=>b.onclick=closeModal);
  modalKey=e=>{if(e.key==='Escape'&&!$('#confirmRoot').innerHTML)closeModal()};document.addEventListener('keydown',modalKey);
  setTimeout(()=>{const fi=f.querySelector('.mbody input:not([type=checkbox]),.mbody select');fi&&fi.focus()},30);
  f.err=m=>{f.querySelector('[data-err]').textContent=m||''};
  return f;
}
function closeModal(){$('#modalRoot').innerHTML='';if(modalKey)document.removeEventListener('keydown',modalKey);modalKey=null}
function confirmBox(title,msg,ok='Delete'){
  return new Promise(res=>{const r=$('#confirmRoot');
    r.innerHTML=`<div class="scrim" style="z-index:60"><div class="modal small" role="alertdialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2></header><div class="mbody">${esc(msg)}</div><div class="mfoot"><button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>${esc(ok)}</button></div></div></div>`;
    const done=v=>{r.innerHTML='';document.removeEventListener('keydown',k);res(v)};const k=e=>{if(e.key==='Escape'){e.stopPropagation();done(false)}};
    document.addEventListener('keydown',k);$('[data-no]',r).onclick=()=>done(false);$('[data-yes]',r).onclick=()=>done(true);$('[data-yes]',r).focus();});
}
let tt;function toast(m,err){const r=$('#toastRoot');r.innerHTML=`<div class="toast ${err?'err':''}" role="status">${esc(m)}</div>`;clearTimeout(tt);tt=setTimeout(()=>r.innerHTML='',err?5000:2600)}

const fld=(id,label,input,span)=>`<div class="field"${span?' style="grid-column:1/-1"':''}><label for="${id}">${label}</label>${input}</div>`;
function acctOptions(sel,filter=()=>true){
  const list=sortAccts(S.accounts.filter(a=>(a.active!==false||a.id===sel)&&filter(a)));let h='',cur='';
  for(const a of list){if(a.type!==cur){if(cur)h+='</optgroup>';cur=a.type;h+=`<optgroup label="${cur}">`}h+=`<option value="${a.id}" ${a.id===sel?'selected':''}>${esc((a.code?a.code+' · ':'')+a.name)}</option>`}
  return h+(cur?'</optgroup>':'');
}
function contactSelect(id,sel,kind,allowNone){
  const cs=S.contacts.filter(c=>!kind||c.kind===kind||c.id===sel).sort((a,b)=>a.name.localeCompare(b.name));
  return `<select id="${id}">${allowNone?'<option value="">None</option>':`<option value="">Choose ${kind||'contact'}…</option>`}${cs.map(c=>`<option value="${c.id}" ${c.id===sel?'selected':''}>${esc(c.name)}${!kind?` (${c.kind})`:''}</option>`).join('')}<option value="__new">+ Add new ${kind||'contact'}…</option></select><input type="text" id="${id}New" placeholder="New ${kind||'contact'} name" hidden style="margin-top:6px">`;
}
function wireContactSelect(f,id){const s=$('#'+id,f),n=$('#'+id+'New',f);s.addEventListener('change',()=>{n.hidden=s.value!=='__new';if(!n.hidden)n.focus()})}
async function resolveContact(f,id,kind){const s=$('#'+id,f);if(s.value!=='__new')return s.value;const name=$('#'+id+'New',f).value.trim();if(!name)return null;const cid=uid();if(!await put('contacts',cid,{name,kind:kind||'vendor',created:Date.now()}))return null;return cid}

/* line editor */
function lineEditor(el,cols,rows,onChange){
  const cell=(c,r)=>{const v=r[c.key];switch(c.type){
    case 'acct':return `<select data-k="${c.key}" aria-label="${c.label}"><option value="">Choose account…</option>${acctOptions(v,c.filter)}</select>`;
    case 'text':return `<input type="text" data-k="${c.key}" value="${esc(v??'')}" aria-label="${c.label}">`;
    case 'num':return `<input type="number" step="${c.step||'0.01'}" inputmode="decimal" data-k="${c.key}" value="${v===undefined||v===''||v===null?'':esc(v)}" aria-label="${c.label}">`;
    case 'check':return `<input type="checkbox" data-k="${c.key}" ${v?'checked':''} aria-label="${c.label}">`;
    case 'sel':return `<select data-k="${c.key}" aria-label="${c.label}">${c.options(v)}</select>`;
    case 'calc':return `<span data-calc="${c.key}"></span>`;}};
  const rowHTML=r=>`<tr>${cols.map(c=>`<td class="c-${c.type}">${cell(c,r)}</td>`).join('')}<td class="c-x"><button type="button" class="icon-btn" data-rm aria-label="Remove line">×</button></td></tr>`;
  el.innerHTML=`<div class="tbl-wrap"><table class="lines"><thead><tr>${cols.map(c=>`<th class="c-${c.type}">${c.label}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map(rowHTML).join('')}</tbody></table></div><button type="button" class="btn ghost sm" data-add style="margin-top:6px">+ Add line</button>`;
  const tb=el.querySelector('tbody');
  const readRow=tr=>{const o={};tr.querySelectorAll('[data-k]').forEach(i=>o[i.dataset.k]=i.type==='checkbox'?i.checked:i.type==='number'?(i.value===''?'':+i.value):i.value);return o};
  const read=()=>[...tb.rows].map(readRow);
  const upd=()=>{[...tb.rows].forEach(tr=>{const o=readRow(tr);cols.filter(c=>c.type==='calc').forEach(c=>tr.querySelector(`[data-calc="${c.key}"]`).textContent=money(c.calc(o)))});onChange&&onChange(read())};
  el.addEventListener('input',upd);el.addEventListener('change',upd);
  el.addEventListener('click',e=>{if(e.target.closest('[data-add]')){tb.insertAdjacentHTML('beforeend',rowHTML(cols.defaults?cols.defaults():{}));upd();tb.lastElementChild.querySelector('select,input').focus()}const rm=e.target.closest('[data-rm]');if(rm){if(tb.rows.length>1)rm.closest('tr').remove();else rm.closest('tr').querySelectorAll('input').forEach(i=>i.type==='checkbox'?i.checked=false:i.value='');upd()}});
  upd();return{read};
}
const taxLbl=()=>`${esc(S.company.taxName||'Tax')} ${+S.company.taxRate||0}%`;
function totalsHTML(){return `<div class="totals" data-totals><div>Subtotal</div><div data-t="sub">0.00</div><div>${taxLbl()}</div><div data-t="tax">0.00</div><div class="big">Total</div><div class="big" data-t="tot">0.00</div></div>`}
function setTotals(f,c){$('[data-t=sub]',f).textContent=money(c.sub);$('[data-t=tax]',f).textContent=money(c.tax);$('[data-t=tot]',f).textContent=money(c.total)}
/* Sales tax parts. Most provinces have one (GST or HST). Quebec companies that track QST separately
   have two: GST at (taxRate - qstRate) and QST at qstRate, each posted to its own account. */
function taxParts(){
  const rate=+S.company.taxRate||0,q=+S.company.qstRate||0,main=byDetail('tax'),qst=byDetail('qst');
  if(q>0&&qst)return[{key:'gst',account:main&&main.id,rate:r2(rate-q),name:'GST'},{key:'qst',account:qst.id,rate:q,name:'QST'}];
  return[{key:'gst',account:main&&main.id,rate,name:S.company.taxName||'Sales tax'}];
}
// Tax on a taxable amount, one figure per part.
const splitTax=base=>taxParts().map(p=>({...p,amount:r2(base*p.rate/100)})).filter(p=>p.amount);
// Share out a known tax total (from a tax-included amount) across the parts.
function splitTaxTotal(total){const ps=taxParts(),sum=ps.reduce((s,p)=>s+p.rate,0)||1;let left=r2(total);return ps.map((p,i)=>{const a=i===ps.length-1?left:r2(total*p.rate/sum);left=r2(left-a);return{...p,amount:a}}).filter(p=>p.amount)}
function taxReady(parts){if(parts.every(p=>p.account))return true;toast(`Add a “${parts.find(p=>!p.account).name} payable” account in Chart of accounts first.`,true);return false}
/* Tax codes on each line. Only "std" charges tax; the others are 0% but are kept apart so the
   GST/HST return can report taxable sales (line 90) separately from exports, exempt and other revenue (line 91). */
const TAX_CODES=[['std',null],['zero','Zero-rated in Canada (0%)'],['export','Zero-rated export (0%)'],['exempt','Exempt'],['none','No tax']];
const taxCodeLabel=c=>c==='std'?`${S.company.taxName||'Tax'} ${+S.company.taxRate||0}%`:(TAX_CODES.find(t=>t[0]===c)||[,'No tax'])[1];
const taxCodeOf=l=>l.taxCode||(l.tax?'std':'none'); // older lines only had a tick box
const taxCodeOptions=sel=>TAX_CODES.map(([k])=>`<option value="${k}" ${sel===k?'selected':''}>${esc(taxCodeLabel(k))}</option>`).join('');
function calcLines(rows,amt){const ls=rows.map(r=>({...r,taxCode:taxCodeOf(r),net:r2(amt(r))})).filter(r=>r.account&&r.net);const sub=r2(ls.reduce((s,r)=>s+r.net,0));const parts=splitTax(ls.filter(r=>r.taxCode==='std').reduce((s,r)=>s+r.net,0));const tax=r2(parts.reduce((s,p)=>s+p.amount,0));return{ls,sub,tax,parts,total:r2(sub+tax)}}
// Total per account and tax code, so each posting line remembers its tax code for the sales tax return.
function groupBy(ls){const m={};ls.forEach(l=>{const k=l.account+'|'+taxCodeOf(l);m[k]=r2((m[k]||0)+l.net)});return m}
const gLine=(k,v,side)=>{const[account,taxCode]=k.split('|');return side==='credit'?(v>=0?{account,debit:0,credit:v,taxCode}:{account,debit:-v,credit:0,taxCode}):(v>=0?{account,debit:v,credit:0,taxCode}:{account,debit:0,credit:-v,taxCode})};
const delBtn=show=>show?`<button type="button" class="btn danger left" data-del>Delete</button>`:'<span class="left"></span>';
const saveFoot=(del,label='Save')=>`${delBtn(del)}<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${label}</button>`;
function needAcct(detail,label){const a=byDetail(detail);if(!a)toast(`Add a "${label}" account in Chart of accounts first.`,true);return a}

/* ---------- forms ---------- */
function openNew(k){$('#newMenu').hidden=true;$('#newBtn').setAttribute('aria-expanded','false');
  ({invoice:()=>docForm('invoice'),bill:()=>docForm('bill'),payment:()=>payForm('payment'),billpayment:()=>payForm('billpayment'),expense:()=>moneyForm('expense'),deposit:()=>moneyForm('deposit'),transfer:()=>transferForm(),journal:()=>journalForm(),import:()=>importForm(),payrun:()=>{if(!S.employees.some(e=>e.active!==false)){go('payroll');S.pay.tab='employees';renderMain();toast('Add an employee first.',true)}else payRunForm()},employee:()=>employeeForm(null),contact:()=>contactForm(null,S.view==='expenses'?'vendor':'customer'),account:()=>accountForm(null)})[k]?.()}
async function openEntry(e){if(!e)return;
  if(e.type==='payrun'){const r=S.payruns.find(x=>x.entryId===e.id);if(r)return payRunView(r)}
  if(e.type==='payremit')return remitForm(e.agency+'|'+e.period,e);
  if(e.type==='taxpayment'){S.stax.period=e.period?`${e.period.from}|${e.period.to}`:null;S.stax.tax=e.tax||'gst';go('salestax');toast(e.taxKind==='instalment'?'Instalments are listed in the Sales tax worksheets. To remove one, delete it from the account register.':'Sales tax payments are managed from the return they belong to.');return}
  if(Object.values(e.clear||{}).includes('r')&&!await confirmBox('This transaction is reconciled','Changing its amount or bank account will change a balance you already reconciled. Open it anyway?','Open'))return;
  if(e.type==='invoice'||e.type==='bill'){const d=S.docs.find(x=>x.id===e.docId);if(d)return docForm(d.kind,d)}
  const fn={payment:()=>payForm('payment',e),billpayment:()=>payForm('billpayment',e),expense:()=>moneyForm('expense',e),deposit:()=>moneyForm('deposit',e),transfer:()=>transferForm(e)}[e.type];fn?fn():journalForm(e)}

function nextNum(kind){if(kind!=='invoice')return'';const n=Math.max(1000,...S.docs.filter(d=>d.kind==='invoice').map(d=>parseInt(d.number)||0));return String(n+1)}
function docForm(kind,doc){
  const inv=kind==='invoice',ck=inv?'customer':'vendor',t=today();
  const filter=inv?a=>a.type==='Income':a=>a.type==='Expense'||a.type==='Cost of Goods Sold'||(a.type==='Asset'&&!a.detail);
  const defA=(sortAccts(S.accounts.filter(a=>filter(a)&&a.active!==false))[0]||{}).id||'';
  const d=doc?{...doc,lines:doc.lines.map(l=>({...l,taxCode:taxCodeOf(l)}))}:{number:nextNum(kind),date:t,due:addDays(t,+S.company.terms||0),contactId:'',lines:[{desc:'',account:defA,qty:1,rate:'',taxCode:'std'}],memo:''};
  const paid=doc?paidOn(doc.id):0;
  const f=openModal(doc?`${inv?'Invoice':'Bill'} ${d.number?'#'+d.number:''}`:(inv?'New invoice':'New bill'),
    `<div class="fields">${fld('dC',inv?'Customer':'Vendor',contactSelect('dC',d.contactId,ck))}${fld('dN',inv?'Invoice no.':'Bill no.',`<input type="text" id="dN" value="${esc(d.number)}">`)}${fld('dD',inv?'Invoice date':'Bill date',`<input type="date" id="dD" value="${d.date}">`)}${fld('dDue','Due date',`<input type="date" id="dDue" value="${d.due||''}">`)}</div>
    <div data-le></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1 1 240px"><label for="dM">${inv?'Message on invoice':'Memo'}</label><textarea id="dM">${esc(d.memo||'')}</textarea></div>${totalsHTML()}</div>
    ${doc&&paid?`<div class="banner" style="margin:0"><span>${money(paid)} has been ${inv?'received':'paid'} on this ${kind}. Balance due ${money(r2(d.total-paid))}.</span></div>`:''}`,
    `${delBtn(!!doc)}<button type="button" class="btn" data-close>Cancel</button>${doc&&docStatus(doc).bal>0?`<button type="button" class="btn" data-paynow>${inv?'Receive payment':'Pay bill'}</button>`:''}<button type="submit" class="btn primary">Save</button>`,'wide');
  wireContactSelect(f,'dC');
  let rows=[];const cols=[{key:'desc',label:'Description',type:'text'},{key:'account',label:inv?'Income account':'Expense account',type:'acct',filter},{key:'qty',label:'Qty',type:'num',step:'any'},{key:'rate',label:inv?'Rate':'Cost',type:'num'},{key:'taxCode',label:'Tax',type:'sel',options:taxCodeOptions},{key:'amt',label:'Amount',type:'calc',calc:r=>r2((+r.qty||0)*(+r.rate||0))}];
  const contactCode=()=>contact($('#dC',f).value)?.taxCode||'';
  cols.defaults=()=>({qty:1,taxCode:contactCode()||'std',account:defA});
  const le=lineEditor($('[data-le]',f),cols,d.lines,r=>{rows=r;setTotals(f,calcLines(r,x=>(+x.qty||0)*(+x.rate||0)))});
  // A customer or vendor with a default tax code (e.g. a US customer: zero-rated export) sets it on every line.
  $('#dC',f).addEventListener('change',()=>{const code=contactCode();if(!code)return;$$('[data-le] [data-k=taxCode]',f).forEach(s=>s.value=code);$('[data-le]',f).dispatchEvent(new Event('change'));toast(`Tax set to ${taxCodeLabel(code)} for ${contactName($('#dC',f).value)}`)});
  let lastDate=d.date;$('#dD',f).onchange=()=>{const due=$('#dDue',f);if(due.value===addDays(lastDate,+S.company.terms||0))due.value=addDays($('#dD',f).value,+S.company.terms||0);lastDate=$('#dD',f).value};
  const pn=$('[data-paynow]',f);if(pn)pn.onclick=()=>payForm(inv?'payment':'billpayment',null,doc.id);
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(paid){f.err(`Delete the ${paid?'payments':''} on this ${kind} first.`);return}if(!await confirmBox(`Delete this ${kind}?`,`${inv?'Invoice':'Bill'} ${d.number?'#'+d.number+' ':''}and its posting to the ledger will be removed.`))return;if(!await batch([{op:'delete',collection:'entries',id:'d_'+doc.id},{op:'delete',collection:'docs',id:doc.id}]))return;closeModal();toast(`${inv?'Invoice':'Bill'} deleted`)};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const c=calcLines(le.read(),x=>(+x.qty||0)*(+x.rate||0));
    if($('#dC',f).value===''||($('#dC',f).value==='__new'&&!$('#dCNew',f).value.trim()))return f.err(`Choose a ${ck}.`);
    if(!$('#dD',f).value)return f.err('Enter a date.');
    if(!c.ls.length)return f.err('Add at least one line with an account and an amount.');
    if(doc&&c.total<paid-0.004)return f.err(`The total can't be less than the ${money(paid)} already ${inv?'received':'paid'}.`);
    const ar=needAcct(inv?'ar':'ap',inv?'Accounts receivable':'Accounts payable');if(!ar)return;
    if(c.tax&&!taxReady(c.parts))return;
    const cid=await resolveContact(f,'dC',ck);if(!cid)return;
    const id=doc?doc.id:uid();const num=$('#dN',f).value.trim();
    const lines=[];const g=groupBy(c.ls);
    if(inv){lines.push({account:ar.id,debit:c.total,credit:0});Object.entries(g).forEach(([k,v])=>lines.push(gLine(k,v,'credit')));c.parts.forEach(p=>lines.push({account:p.account,debit:0,credit:p.amount,memo:p.name}))}
    else{Object.entries(g).forEach(([k,v])=>lines.push(gLine(k,v,'debit')));c.parts.forEach(p=>lines.push({account:p.account,debit:p.amount,credit:0,memo:p.name+' paid'}));lines.push({account:ar.id,debit:0,credit:c.total})}
    const base={date:$('#dD',f).value,contactId:cid,memo:$('#dM',f).value.trim(),...(doc&&doc.example?{example:true}:{})};
    const dd={...base,kind,number:num,due:$('#dDue',f).value,lines:c.ls.map(l=>({desc:l.desc||'',account:l.account,qty:+l.qty||0,rate:+l.rate||0,taxCode:l.taxCode,tax:l.taxCode==='std'})),sub:c.sub,tax:c.tax,total:c.total,taxRate:+S.company.taxRate||0,created:doc?.created||Date.now()};
    if(!await batch([{op:'set',collection:'docs',id,data:dd},{op:'set',collection:'entries',id:'d_'+id,data:{...base,type:kind,ref:num,docId:id,lines,created:dd.created}}]))return;
    closeModal();toast(`${inv?'Invoice':'Bill'} saved`);
  };
}

function payForm(kind,entry,presetDoc){
  const recv=kind==='payment',dk=recv?'invoice':'bill';
  const open=S.docs.filter(d=>d.kind===dk&&(docStatus(d).bal>0||d.id===entry?.applyTo||d.id===presetDoc)).sort((a,b)=>(a.due||'').localeCompare(b.due||''));
  const balOf=id=>{const d=S.docs.find(x=>x.id===id);return d?r2(d.total-paidOn(id,entry?.id)):0};
  const banks=a=>a.detail==='bank'||(!recv&&a.detail==='card');
  const sel=entry?.applyTo||presetDoc||'';
  const defBank=entry?.bank||(sortAccts(S.accounts.filter(a=>a.detail==='bank'))[0]||{}).id;
  const f=openModal(recv?(entry?'Payment received':'Receive payment'):(entry?'Bill payment':'Pay bill'),
    `<div class="fields">${fld('pDoc',recv?'Invoice':'Bill',`<select id="pDoc"><option value="">Choose ${dk}…</option>${open.map(d=>`<option value="${d.id}" ${d.id===sel?'selected':''}>${esc(contactName(d.contactId))} · ${d.number?'#'+esc(d.number)+' · ':''}${money(balOf(d.id))} due</option>`).join('')}</select>`,true)}
    ${fld('pDate','Date',`<input type="date" id="pDate" value="${entry?.date||today()}">`)}
    ${fld('pAmt','Amount',`<input type="number" id="pAmt" step="0.01" inputmode="decimal" value="${entry?entry.amount:(sel?balOf(sel):'')}">`)}
    ${fld('pBank',recv?'Deposit to':'Paid from',`<select id="pBank">${acctOptions(defBank,banks)}</select>`)}
    ${fld('pRef',recv?'Reference (cheque or e-transfer no.)':'Reference',`<input type="text" id="pRef" value="${esc(entry?.ref||'')}">`)}
    ${fld('pMemo','Memo',`<input type="text" id="pMemo" value="${esc(entry?.memo||'')}">`,true)}</div>
    ${open.length?'':`<div class="muted">No unpaid ${dk}s. Create ${dk==='invoice'?'an invoice':'a bill'} first, or use ${recv?'Deposit':'Expense'} for money that isn't tied to one.</div>`}`,
    saveFoot(!!entry,recv?'Save payment':'Save payment'));
  $('#pDoc',f).onchange=()=>{const v=$('#pDoc',f).value;if(v)$('#pAmt',f).value=balOf(v)};
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this payment?',`The ${dk} will show as unpaid again for this amount.`))return;await del('entries',entry.id);closeModal();toast('Payment deleted')};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const docId=$('#pDoc',f).value,amt=r2($('#pAmt',f).value),bank=$('#pBank',f).value;
    if(!docId)return f.err(`Choose ${dk==='invoice'?'an invoice':'a bill'}.`);if(!(amt>0))return f.err('Enter an amount above zero.');
    if(amt>balOf(docId)+0.004)return f.err(`That's more than the ${money(balOf(docId))} still owing.`);if(!bank)return f.err('Choose a bank account.');
    const ctl=needAcct(recv?'ar':'ap',recv?'Accounts receivable':'Accounts payable');if(!ctl)return;
    const d=S.docs.find(x=>x.id===docId);const id=entry?.id||uid();
    const lines=recv?[{account:bank,debit:amt,credit:0},{account:ctl.id,debit:0,credit:amt}]:[{account:ctl.id,debit:amt,credit:0},{account:bank,debit:0,credit:amt}];
    if(await put('entries',id,{type:kind,date:$('#pDate',f).value||today(),ref:$('#pRef',f).value.trim(),memo:$('#pMemo',f).value.trim()||`${recv?'Payment for invoice':'Payment of bill'} ${d.number?'#'+d.number:''}`.trim(),contactId:d.contactId,applyTo:docId,amount:amt,bank,lines,created:entry?.created||Date.now(),...(entry?.example?{example:true}:{})})){closeModal();toast('Payment saved')}
  };
}

function moneyForm(kind,entry){
  const out=kind==='expense';
  const fm=entry?.form||{};
  const filter=out?a=>!(a.detail==='bank'||a.detail==='card'||a.detail==='ar'||a.detail==='ap'||a.type==='Income'):a=>!(a.detail==='bank'||a.detail==='card'||a.detail==='ar'||a.detail==='ap'||a.type==='Expense'||a.type==='Cost of Goods Sold');
  const defA=out?'':(sortAccts(S.accounts.filter(a=>a.type==='Income'&&a.active!==false))[0]||{}).id;
  const defBank=fm.bank||(sortAccts(S.accounts.filter(a=>a.detail==='bank'))[0]||{}).id;
  const f=openModal(out?(entry?'Expense':'Record expense'):(entry?'Deposit':'Record deposit'),
    `<div class="fields">${fld('mBank',out?'Paid from':'Deposit to',`<select id="mBank">${acctOptions(defBank,a=>a.detail==='bank'||a.detail==='card')}</select>`)}
    ${fld('mC',out?'Payee':'Received from',contactSelect('mC',entry?.contactId||'',out?'vendor':'customer',true))}
    ${fld('mDate','Date',`<input type="date" id="mDate" value="${entry?.date||today()}">`)}
    ${fld('mRef',out?'Ref / receipt no.':'Reference',`<input type="text" id="mRef" value="${esc(entry?.ref||'')}">`)}</div>
    <div data-le></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1 1 240px"><label for="mMemo">Memo</label><textarea id="mMemo">${esc(entry?.memo||'')}</textarea></div>${totalsHTML()}</div>`,
    saveFoot(!!entry),'wide');
  wireContactSelect(f,'mC');
  const cols=[{key:'account',label:'Category',type:'acct',filter},{key:'desc',label:'Description',type:'text'},{key:'amount',label:'Amount',type:'num'},{key:'taxCode',label:'Tax',type:'sel',options:taxCodeOptions}];
  const mCode=()=>contact($('#mC',f).value)?.taxCode||(out?'std':'none');
  cols.defaults=()=>({taxCode:mCode(),account:defA});
  const le=lineEditor($('[data-le]',f),cols,(fm.lines||[{account:defA,desc:'',amount:'',taxCode:out?'std':'none'}]).map(l=>({...l,taxCode:taxCodeOf(l)})),r=>setTotals(f,calcLines(r,x=>+x.amount||0)));
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox(`Delete this ${kind}?`,'It will be removed from your books.'))return;await del('entries',entry.id);closeModal();toast(`${out?'Expense':'Deposit'} deleted`)};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const c=calcLines(le.read(),x=>+x.amount||0);const bank=$('#mBank',f).value;
    if(!bank)return f.err('Choose a bank or card account.');if(!c.ls.length)return f.err('Add at least one line with a category and amount.');
    if(c.tax&&!taxReady(c.parts))return;
    let cid=$('#mC',f).value;if(cid==='__new'){cid=await resolveContact(f,'mC',out?'vendor':'customer');if(!cid)return f.err('Enter a name for the new contact.')}
    const g=groupBy(c.ls);const lines=[];
    if(out){Object.entries(g).forEach(([k,v])=>lines.push(gLine(k,v,'debit')));c.parts.forEach(p=>lines.push({account:p.account,debit:p.amount,credit:0,memo:p.name+' paid'}));lines.push(c.total>=0?{account:bank,debit:0,credit:c.total}:{account:bank,debit:-c.total,credit:0})}
    else{lines.push(c.total>=0?{account:bank,debit:c.total,credit:0}:{account:bank,debit:0,credit:-c.total});Object.entries(g).forEach(([k,v])=>lines.push(gLine(k,v,'credit')));c.parts.forEach(p=>lines.push({account:p.account,debit:0,credit:p.amount,memo:p.name+' collected'}))}
    const id=entry?.id||uid();
    if(await put('entries',id,{type:kind,date:$('#mDate',f).value||today(),ref:$('#mRef',f).value.trim(),memo:$('#mMemo',f).value.trim(),contactId:cid||'',form:{bank,lines:c.ls.map(l=>({account:l.account,desc:l.desc||'',amount:l.net,taxCode:l.taxCode,tax:l.taxCode==='std'}))},lines,created:entry?.created||Date.now(),...(entry?.example?{example:true}:{})})){closeModal();toast(`${out?'Expense':'Deposit'} saved`)}
  };
}

function transferForm(entry){
  const fm=entry?.form||{};const bk=a=>a.detail==='bank'||a.detail==='card';
  const f=openModal('Transfer',`<div class="fields">${fld('tFrom','From',`<select id="tFrom"><option value="">Choose account…</option>${acctOptions(fm.from,bk)}</select>`)}${fld('tTo','To',`<select id="tTo"><option value="">Choose account…</option>${acctOptions(fm.to,bk)}</select>`)}${fld('tDate','Date',`<input type="date" id="tDate" value="${entry?.date||today()}">`)}${fld('tAmt','Amount',`<input type="number" id="tAmt" step="0.01" inputmode="decimal" value="${fm.amount??''}">`)}${fld('tMemo','Memo',`<input type="text" id="tMemo" value="${esc(entry?.memo||'')}">`,true)}</div><div class="muted" style="font-size:13px">Use a transfer to move money between bank accounts or to pay down a credit card.</div>`,saveFoot(!!entry));
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this transfer?','It will be removed from both accounts.'))return;await del('entries',entry.id);closeModal();toast('Transfer deleted')};
  f.onsubmit=async e=>{e.preventDefault();const a=$('#tFrom',f).value,b=$('#tTo',f).value,amt=r2($('#tAmt',f).value);
    if(!a||!b)return f.err('Choose both accounts.');if(a===b)return f.err('Pick two different accounts.');if(!(amt>0))return f.err('Enter an amount above zero.');
    const id=entry?.id||uid();if(await put('entries',id,{type:'transfer',date:$('#tDate',f).value||today(),memo:$('#tMemo',f).value.trim(),ref:'',form:{from:a,to:b,amount:amt},lines:[{account:b,debit:amt,credit:0},{account:a,debit:0,credit:amt}],created:entry?.created||Date.now(),...(entry?.example?{example:true}:{})})){closeModal();toast('Transfer saved')}};
}

function journalForm(entry){
  const f=openModal(entry?'Journal entry':'New journal entry',`<div class="fields">${fld('jDate','Date',`<input type="date" id="jDate" value="${entry?.date||today()}">`)}${fld('jRef','Journal no.',`<input type="text" id="jRef" value="${esc(entry?.ref||'')}">`)}${fld('jMemo','Memo',`<input type="text" id="jMemo" value="${esc(entry?.memo||'')}">`,true)}</div><div data-le></div><div class="totals"><div>Total debits</div><div data-j="d">0.00</div><div>Total credits</div><div data-j="c">0.00</div><div class="big">Difference</div><div class="big" data-j="x">0.00</div></div>`,saveFoot(!!entry),'wide');
  const rows=(entry?.lines||[{},{}]).map(l=>({account:l.account,memo:l.memo||'',debit:l.debit||'',credit:l.credit||''}));
  const le=lineEditor($('[data-le]',f),[{key:'account',label:'Account',type:'acct'},{key:'memo',label:'Description',type:'text'},{key:'debit',label:'Debit',type:'num'},{key:'credit',label:'Credit',type:'num'}],rows,r=>{const d=r2(r.reduce((s,x)=>s+(+x.debit||0),0)),c=r2(r.reduce((s,x)=>s+(+x.credit||0),0));$('[data-j=d]',f).textContent=money(d);$('[data-j=c]',f).textContent=money(c);const x=$('[data-j=x]',f);x.textContent=money(r2(d-c));x.className='big '+(Math.abs(d-c)>0.004?'neg':'')});
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this journal entry?','It will be removed from your books.'))return;await del('entries',entry.id);closeModal();toast('Journal entry deleted')};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const ls=le.read().filter(l=>l.account||+l.debit||+l.credit);
    for(const l of ls){if(!l.account)return f.err('Every line with an amount needs an account.');if(+l.debit&&+l.credit)return f.err('Put each line in either Debit or Credit, not both.');if(+l.debit<0||+l.credit<0)return f.err('Use positive amounts; switch columns instead of using negatives.')}
    const lines=ls.filter(l=>+l.debit||+l.credit).map(l=>({account:l.account,debit:r2(l.debit),credit:r2(l.credit),memo:l.memo||''}));
    const d=r2(lines.reduce((s,l)=>s+l.debit,0)),c=r2(lines.reduce((s,l)=>s+l.credit,0));
    if(lines.length<2||!d)return f.err('A journal entry needs at least one debit and one credit.');if(Math.abs(d-c)>0.004)return f.err(`Debits and credits are out by ${money(r2(d-c))}.`);
    const id=entry?.id||uid();if(await put('entries',id,{type:'journal',date:$('#jDate',f).value||today(),ref:$('#jRef',f).value.trim(),memo:$('#jMemo',f).value.trim(),contactId:entry?.contactId||'',lines,created:entry?.created||Date.now(),...(entry?.example?{example:true}:{})})){closeModal();toast('Journal entry saved')}};
}

function accountForm(a){
  const used=a?postings().some(p=>p.account===a.id):false;
  const f=openModal(a?'Edit account':'New account',`<div class="fields">${fld('aType','Account type',`<select id="aType" ${used?'disabled':''}>${TYPES.map(t=>`<option ${a?.type===t?'selected':''}>${t}</option>`).join('')}</select>`)}${fld('aDet','Detail',`<select id="aDet"></select>`)}${fld('aCode','Code',`<input type="text" id="aCode" value="${esc(a?.code||'')}" placeholder="e.g. 6450">`)}${fld('aName','Name',`<input type="text" id="aName" value="${esc(a?.name||'')}" required>`)}${fld('aDesc','Description',`<input type="text" id="aDesc" value="${esc(a?.desc||'')}">`,true)}</div>
  <div data-ob ${a?'hidden':''} class="fields">${fld('aOb','Opening balance',`<input type="number" id="aOb" step="0.01" inputmode="decimal" placeholder="0.00">`)}${fld('aObD','As of',`<input type="date" id="aObD" value="${today()}">`)}</div>
  ${a?`<label class="check"><input type="checkbox" id="aInactive" ${a.active===false?'checked':''}> Inactive (hide from new transactions)</label>`:''}
  ${used?`<div class="muted" style="font-size:13px">This account has transactions, so its type can't change. You can rename it or mark it inactive.</div>`:''}`,saveFoot(!!a&&!used));
  const ty=$('#aType',f),de=$('#aDet',f),ob=$('[data-ob]',f);
  const fillDet=()=>{de.innerHTML=(DETAILS[ty.value]||[]).map(([k,v])=>`<option value="${k}" ${(a?.detail||'')===k?'selected':''}>${v}</option>`).join('');ob.hidden=!!a||!(ty.value==='Asset'||ty.value==='Liability')};
  ty.onchange=fillDet;fillDet();
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this account?',`${a.name} has no transactions and will be removed.`))return;await del('accounts',a.id);closeModal();toast('Account deleted');if(S.view==='register')go('accounts')};
  f.onsubmit=async e=>{e.preventDefault();f.err('');const name=$('#aName',f).value.trim();if(!name)return f.err('Give the account a name.');
    const code=$('#aCode',f).value.trim();if(code&&S.accounts.some(x=>x.code===code&&x.id!==a?.id))return f.err(`Code ${code} is already used.`);
    const id=a?.id||uid();const data={...(a?strip(a):{}),type:ty.value,detail:de.value,code,name,desc:$('#aDesc',f).value.trim(),active:a?!$('#aInactive',f).checked:true};
    const writes=[{op:'set',collection:'accounts',id,data}];
    const amt=r2($('#aOb',f)?.value);if(!a&&amt){const obA=needAcct('ob','Opening balance equity');if(!obA)return;const pos=amt>0;writes.push({op:'set',collection:'entries',id:uid(),data:{type:'journal',date:$('#aObD',f).value||today(),ref:'',memo:'Opening balance',lines:[{account:id,debit:pos===debitNormal(data.type)?Math.abs(amt):0,credit:pos===debitNormal(data.type)?0:Math.abs(amt)},{account:obA.id,debit:pos===debitNormal(data.type)?0:Math.abs(amt),credit:pos===debitNormal(data.type)?Math.abs(amt):0}],created:Date.now()}})}
    if(!await batch(writes))return;
    closeModal();toast('Account saved')};
}

function contactForm(c,kind){
  const k=c?.kind||kind||'customer';
  const refs=c?S.docs.some(d=>d.contactId===c.id)||S.entries.some(e=>e.contactId===c.id):false;
  const f=openModal(c?c.name:`New ${k}`,`<div class="fields">${fld('cName','Name',`<input type="text" id="cName" value="${esc(c?.name||'')}" required>`,true)}${fld('cKind','Type',`<select id="cKind"><option value="customer" ${k==='customer'?'selected':''}>Customer</option><option value="vendor" ${k==='vendor'?'selected':''}>Vendor</option></select>`)}${fld('cTax','Default sales tax',`<select id="cTax"><option value="">Same as the company (${esc(S.company.taxName||'Tax')})</option>${TAX_CODES.filter(t=>t[0]!=='std').map(([k])=>`<option value="${k}" ${c?.taxCode===k?'selected':''}>${esc(taxCodeLabel(k))}</option>`).join('')}</select><span class="hint">For a customer outside Canada, such as in the US, choose Zero-rated export.</span>`)}${fld('cEmail','Email',`<input type="email" id="cEmail" value="${esc(c?.email||'')}">`)}${fld('cPhone','Phone',`<input type="tel" id="cPhone" value="${esc(c?.phone||'')}">`)}${fld('cAddr','Address',`<textarea id="cAddr">${esc(c?.address||'')}</textarea>`,true)}${fld('cNotes','Notes',`<textarea id="cNotes">${esc(c?.notes||'')}</textarea>`,true)}</div>${refs?'<div class="muted" style="font-size:13px">This contact appears on transactions, so it can\'t be deleted.</div>':''}`,saveFoot(!!c&&!refs));
  const db=$('[data-del]',f);if(db)db.onclick=async()=>{if(!await confirmBox('Delete this contact?',`${c.name} will be removed.`))return;await del('contacts',c.id);closeModal();toast('Contact deleted')};
  f.onsubmit=async e=>{e.preventDefault();const name=$('#cName',f).value.trim();if(!name)return f.err('Enter a name.');
    const id=c?.id||uid();if(await put('contacts',id,{...(c?strip(c):{created:Date.now()}),name,kind:$('#cKind',f).value,email:$('#cEmail',f).value.trim(),phone:$('#cPhone',f).value.trim(),address:$('#cAddr',f).value.trim(),notes:$('#cNotes',f).value.trim(),taxCode:$('#cTax',f).value})){closeModal();toast('Saved')}};
}

/* ---------- chrome ---------- */
$('#nav').onclick=e=>{const b=e.target.closest('button');if(b)go(b.dataset.view)};
$('#newBtn').onclick=e=>{e.stopPropagation();const m=$('#newMenu');m.hidden=!m.hidden;$('#newBtn').setAttribute('aria-expanded',String(!m.hidden));if(!m.hidden)m.querySelector('button').focus()};
$('#newMenu').onclick=e=>{const b=e.target.closest('[data-new]');if(b)openNew(b.dataset.new)};
document.addEventListener('click',e=>{if(!e.target.closest('.newwrap')){$('#newMenu').hidden=true;$('#newBtn').setAttribute('aria-expanded','false')}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#newMenu').hidden){$('#newMenu').hidden=true;$('#newBtn').focus()}});
