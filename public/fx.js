'use strict';
/* ---------- Multi-currency ----------
   The books are kept in Canadian dollars. A customer or vendor can be in another currency, and so can a bank or
   credit card account. Their invoices, bills and credits are in that currency with an exchange rate (Canadian
   dollars for one unit, from the Bank of Canada or typed in). Each ledger line is in Canadian dollars; lines on a
   foreign bank account also keep the foreign amount (l.fx = {cur, amt}) so the account shows and reconciles in its
   own currency. Paying a document at a different rate than it was recorded at gives a realized exchange gain or
   loss. "Revalue" restates open foreign balances at a date's rate (unrealized), and reverses the next day. */

const CURRENCIES={USD:'US dollar',EUR:'Euro',GBP:'British pound',AUD:'Australian dollar',JPY:'Japanese yen',CHF:'Swiss franc',CNY:'Chinese renminbi',HKD:'Hong Kong dollar',MXN:'Mexican peso',INR:'Indian rupee',NZD:'New Zealand dollar',SEK:'Swedish krona',NOK:'Norwegian krone',SGD:'Singapore dollar',KRW:'South Korean won',BRL:'Brazilian real',ZAR:'South African rand'};
const mcOn=()=>typeof feat==='function'&&feat('multiCurrency');
const contactCur=id=>(contact(id)||{}).currency||'';
const acctCur=id=>(acct(id)||{}).currency||'';
/** An amount in a currency ('' = Canadian dollars): "US$1,234.00" in English, "1 234,00 $ US" in French. */
function moneyC(n,cur){
  if(!cur||cur==='CAD')return money(n);
  n=r2(n);const s=Math.abs(n).toLocaleString(LOC(),{style:'currency',currency:cur});
  return n<0?`(${s})`:s;
}
const curOptions=(sel,none='Canadian dollar (CAD)')=>`<option value="">${esc(T(none))}</option>`+Object.entries(CURRENCIES).map(([k,v])=>`<option value="${k}" ${sel===k?'selected':''}>${esc(T(v))} (${k})</option>`).join('');
const FXC=new Map();
/** The Bank of Canada rate for a currency on (or just before) a date: { rate, date } or null. */
async function getRate(cur,date){
  if(!cur)return{rate:1,date};const k=cur+'|'+date;if(FXC.has(k))return FXC.get(k);
  try{const r=await api('GET',`/api/fx?cur=${encodeURIComponent(cur)}&date=${encodeURIComponent(date)}`);FXC.set(k,r);return r}catch(e){return{error:e.message}}
}
const cachedRate=(cur,date)=>{const r=FXC.get(cur+'|'+date);return r&&r.rate?r.rate:0};
/** Convert ledger lines in a document's currency to Canadian dollars. Rounding is put on the control line (A/R, A/P or the bank). */
function toHome(lines,fx,ctl){
  if(!fx||fx===1)return lines;
  const out=lines.map(l=>({...l,debit:r2((+l.debit||0)*fx),credit:r2((+l.credit||0)*fx)}));
  const off=r2(out.reduce((s,l)=>s+l.debit-l.credit,0));
  if(off){const c=out.find(l=>l.account===ctl)||out.slice().sort((a,b)=>(b.debit+b.credit)-(a.debit+a.credit))[0];if(c.debit)c.debit=r2(c.debit-off);else c.credit=r2(c.credit+off)}
  return out;
}
/** The account realized and unrealized exchange gains and losses go to, made the first time it's needed. */
function fxAccount(writes){
  let a=S.accounts.find(x=>x.fxGainLoss)||S.accounts.find(x=>/exchange|change/i.test(x.name)&&(x.type==='Expense'||x.type==='Income'));
  if(a)return a.id;
  const id=uid(),fr=S.company.lang==='fr';
  writes.push({op:'set',collection:'accounts',id,data:{code:S.accounts.some(x=>x.code==='6990')?'':'6990',name:fr?'Gain ou perte de change':'Foreign exchange gain or loss',type:'Expense',detail:'',desc:'',active:true,fxGainLoss:true}});
  return id;
}
/** A foreign bank or card account's balance in its own currency (from the foreign amounts kept on its lines). */
function acctFxBal(id,to){let s=0;for(const e of S.entries){if(to&&e.date>to)continue;for(const l of e.lines||[])if(l.account===id)s+=l.fx&&l.fx.amt!=null?((+l.debit||0)>0?+l.fx.amt:-l.fx.amt):(+l.debit||0)-(+l.credit||0)}return r2(s)}

/** The exchange rate row on a document or payment form: rate input, Bank of Canada button, and the amount in dollars. */
function fxRowHTML(id,cur,rate,label){
  return `<div class="fx-row" data-fxrow="${id}" ${cur?'':'hidden'}><span class="pill quiet" data-fxcur>${esc(cur||'')}</span><label for="${id}">${esc(T(label||'Exchange rate'))}</label> <span class="muted">1 <span data-fxcur2>${esc(cur||'')}</span> =</span> <input type="number" id="${id}" step="0.000001" min="0" inputmode="decimal" value="${esc(rate||'')}" style="width:120px"> <span class="muted">CAD</span> <button type="button" class="btn sm ghost" data-fxget="${id}">${esc(T('Bank of Canada rate'))}</button> <span class="muted" data-fxnote></span></div>`;
}
/** Wire a rate row: fill it from the Bank of Canada when empty or asked, for the date in dateInput. */
function wireFx(f,id,getCur,dateInput,onChange){
  const row=$(`[data-fxrow="${id}"]`,f),inp=$('#'+id,f);if(!row)return{rate:()=>1,cur:()=>''};
  const fill=async force=>{const cur=getCur(),d=$(dateInput,f).value||today();row.hidden=!cur;$('[data-fxcur]',row).textContent=cur;$('[data-fxcur2]',row).textContent=cur;if(!cur){onChange&&onChange();return}
    if(!force&&+inp.value>0){onChange&&onChange();return}
    $('[data-fxnote]',row).textContent=T('Getting the rate…');const r=await getRate(cur,d);
    if(r&&r.rate){inp.value=r.rate;$('[data-fxnote]',row).textContent=r.date!==d?`${T('Bank of Canada,')} ${fmtDate(r.date)}`:T('Bank of Canada');}else $('[data-fxnote]',row).textContent=(r&&r.error)||'';
    onChange&&onChange()};
  $(`[data-fxget="${id}"]`,f).onclick=()=>fill(true);
  inp.addEventListener('input',()=>{$('[data-fxnote]',row).textContent='';onChange&&onChange()});
  $(dateInput,f).addEventListener('change',()=>{if(getCur())fill(true)});
  fill(false);
  return{rate:()=>getCur()?+inp.value||0:1,cur:getCur,refresh:fill};
}

/* ---------- revaluation (Settings → Currencies) ---------- */
/** What each open foreign balance would change by at the given rates: [{account, amount (CAD, + = up), what}] */
function revalLines(date,rates){
  const out=[];
  for(const d of S.docs){if(!d.currency||d.date>date||d.kind==='sreceipt')continue;const r=rates[d.currency];if(!(r>0))continue;
    const bal=r2((+d.total||0)-paidOnAt(d.id,date));if(Math.abs(bal)<0.005)continue;
    const sale=d.kind==='invoice'||d.kind==='credit',sign=isCreditKind(d.kind)?-1:1,ctl=byDetail(sale?'ar':'ap');if(!ctl)continue;
    const ch=r2(sign*bal*(r-(+d.fx||1)));if(Math.abs(ch)<0.005)continue;
    out.push({account:ctl.id,amount:sale?ch:-ch,what:`${d.number||''} ${contactName(d.contactId)}`.trim(),gain:ch*(sale?1:-1)})}
  for(const a of S.accounts){if(!a.currency||!(a.detail==='bank'||a.detail==='card'))continue;const r=rates[a.currency];if(!(r>0))continue;
    const fb=acctFxBal(a.id,date),cad=bal(a.id,null,date)*(debitNormal(a.type)?1:-1),want=r2(fb*r),ch=r2(want-cad);
    if(Math.abs(ch)>=0.005)out.push({account:a.id,amount:ch,what:a.name,gain:ch})}
  return out;
}
const paidOnAt=(docId,date)=>{let s=S.entries.filter(e=>e.applyTo===docId&&e.date<=date).reduce((t,e)=>t+(+e.amount||0),0);for(const c of S.docs){if(!c.applied||c.date>date)continue;for(const a of c.applied)if(c.id===docId||a.docId===docId)s+=+a.amount||0}return r2(s)};
function currenciesPanel(){
  if(!mcOn()||!ME||ME.role==='client')return '';
  const used=[...new Set([...S.contacts.map(c=>c.currency),...S.accounts.map(a=>a.currency)].filter(Boolean))];
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Currencies</h3><div class="pad" style="display:flex;flex-direction:column;gap:10px">
    <div class="muted" style="font-size:13px">The books are in Canadian dollars. Set a currency on a customer, vendor, or bank or credit card account, and their invoices, bills and payments are in that currency, with the Bank of Canada’s rate filled in.</div>
    <div>${used.length?used.map(c=>`<span class="pill quiet">${esc(c)}</span>`).join(' '):`<span class="muted">${T('No other currencies in use yet.')}</span>`}</div>
    ${used.length&&!ME.readOnly?'<div><button class="btn sm" data-reval>Revalue at a date…</button> <span class="muted" style="font-size:12.5px">For month-end or year-end: restates what customers and vendors owe, and foreign bank balances, at that day’s rate. Reverses the next day.</span></div>':''}</div></div>`;
}
async function revalueForm(){
  const used=[...new Set([...S.docs.map(d=>d.currency),...S.accounts.map(a=>a.currency)].filter(Boolean))];
  const d0=monthEnd(new Date().getFullYear(),new Date().getMonth()||12);
  const f=openModal('Revalue foreign currency',`<div class="fields">${fld('rvDate','As of',`<input type="date" id="rvDate" value="${esc(d0)}">`)}${used.map(c=>fld('rv_'+c,`1 ${c} =`,`<input type="number" id="rv_${c}" step="0.000001" min="0" data-rvcur="${c}"><span class="hint">CAD</span>`)).join('')}</div><div data-rvlist></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Record revaluation</button>`,'wide');
  const rates=()=>Object.fromEntries(used.map(c=>[c,+$('#rv_'+c,f).value||0]));
  const draw=()=>{const ls=revalLines($('#rvDate',f).value,rates()),g=r2(ls.reduce((s,l)=>s+l.gain,0));
    $('[data-rvlist]',f).innerHTML=`<div class="tbl-wrap"><table><thead><tr><th>${T('Balance')}</th><th>${T('Account')}</th><th class="n">${T('Change')}</th></tr></thead><tbody>${ls.map(l=>`<tr><td translate="no">${esc(l.what)}</td><td translate="no">${esc(acctName(l.account))}</td><td class="n">${mcell(l.gain)}</td></tr>`).join('')||`<tr><td colspan="3" class="muted">${T('Nothing to revalue.')}</td></tr>`}</tbody>${ls.length?`<tfoot><tr class="grand"><td colspan="2">${g>=0?T('Unrealized gain'):T('Unrealized loss')}</td><td class="n">${money(Math.abs(g))}</td></tr></tfoot>`:''}</table></div>`};
  const fill=async()=>{const d=$('#rvDate',f).value||today();for(const c of used){const r=await getRate(c,d);if(r&&r.rate)$('#rv_'+c,f).value=r.rate}draw()};
  f.addEventListener('input',draw);$('#rvDate',f).onchange=fill;fill();
  f.onsubmit=async e=>{e.preventDefault();f.err('');const date=$('#rvDate',f).value,ls=revalLines(date,rates());if(!ls.length)return f.err('Nothing to revalue at those rates.');
    const w=[],fxa=fxAccount(w),g={};for(const l of ls)g[l.account]=r2((g[l.account]||0)+l.amount);
    const lines=Object.entries(g).filter(([,v])=>Math.abs(v)>=0.005).map(([a,v])=>{const ac=acct(a),up=debitNormal(ac.type)?v>0:v<0,fx=ac.currency?{fx:{cur:ac.currency,amt:0}}:{};return up?{account:a,debit:Math.abs(v),credit:0,...fx}:{account:a,debit:0,credit:Math.abs(v),...fx}});
    const off=r2(lines.reduce((s,l)=>s+l.debit-l.credit,0));if(off)lines.push(off>0?{account:fxa,debit:0,credit:off,memo:'Unrealized exchange gain'}:{account:fxa,debit:-off,credit:0,memo:'Unrealized exchange loss'});
    const id=uid(),rev=addDays(date,1);
    w.push({op:'set',collection:'entries',id,data:{type:'journal',date,ref:'',memo:`${S.company.lang==='fr'?'Réévaluation des devises':'Foreign currency revaluation'} (${used.map(c=>`${c} ${rates()[c]}`).join(', ')})`,adjusting:true,reverseOn:rev,fxReval:true,lines,created:Date.now()}},
      {op:'set',collection:'entries',id:'rv_'+id,data:{type:'journal',date:rev,ref:'',memo:`${S.company.lang==='fr'?'Contrepassation : réévaluation des devises':'Reversal: foreign currency revaluation'}`,reversalOf:id,fxReval:true,lines:lines.map(l=>({...l,debit:l.credit,credit:l.debit})),created:Date.now()}});
    if(await batch(w)){closeModal();toast('Revaluation recorded, reversing on '+fmtDate(rev))}};
}
