'use strict';
/* ---------- Year-end files: bringing last year over from CaseWare ----------
 * A firm switching from CaseWare exports last year's trial balance (Excel or CSV, with map numbers, GIFI codes and the
 * final and prior-year columns) and Sumlora reads it:
 *   - for a client whose books are in Sumlora, as the prior year of this year's file (matched to the chart of accounts
 *     by account number, then by name; anything left over is kept as the file's own lines), with the option to fill in
 *     missing GIFI codes in the chart;
 *   - for any other client, as the whole trial balance of a new file (see yfReadTbFile, which uses this reader).
 */
const YF_NUM=v=>{if(typeof v==='number')return v;let s=String(v??'').trim();if(!s)return 0;const cr=/\bcr\.?$/i.test(s),neg=/^\(.*\)$/.test(s)||/-$/.test(s)||/^-/.test(s)||cr;s=s.replace(/[^0-9.,]/g,'');
  // 1 234,56 (French) or 1,234.56
  if(/,\d{1,2}$/.test(s)&&!/\.\d{1,2}$/.test(s))s=s.replace(/\./g,'').replace(',','.');else s=s.replace(/,/g,'');
  const n=parseFloat(s);return isNaN(n)?0:(neg?-n:n)};
/**
 * Read a CaseWare (or similar) trial balance export: account number, description, map number, GIFI, type, and the
 * year columns. yearEnd picks the current and prior columns when they're labelled with years. Returns
 * { lines:[{code,name,type,detail,gifi,map,cur,prior}], cols, hasPrior }.
 */
async function yfReadCwFile(file,yearEnd){
  const tables=await Convert.readFile(file.name,new Uint8Array(await file.arrayBuffer()),cvInflate);
  const table=tables.find(t=>t.rows&&t.rows.length)||{rows:[]};
  const h=Convert.findHeader(table.rows);
  if(h<0)throw new Error('Sumlora couldn’t find the column headings (account, description, balances) in that file.');
  const head=table.rows[h].map(c=>String(c||'').toLowerCase().replace(/\s+/g,' ').trim());
  const find=(re,not)=>head.findIndex((c,i)=>re.test(c)&&!(not&&not.test(c)));
  const y=+String(yearEnd||'').slice(0,4)||0;
  const cols={
    num:find(/^(account|acct|account ?(number|no\.?|#)|no\.?|number|code|account code|n° de compte|numéro)$/),
    name:find(/description|account name|^name$|title|libellé|nom/),
    map:find(/map/),gifi:find(/gifi|igrf/),type:find(/^(type|account type|class|category)$/),
    pd:find(/(prior|previous|py|last year|préc).*(debit|dr)\b/),pc:find(/(prior|previous|py|last year|préc).*(credit|cr)\b/),
    d:find(/^(debit|dr|débit)s?$/),c:find(/^(credit|cr|crédit)s?$/),
  };
  // Balance columns: a year in the heading, or final/current and prior/PY words.
  const yearCol=yy=>head.findIndex(c=>new RegExp(`\\b${yy}\\b`).test(c)&&!/prior|py|previous/.test(c));
  let cur=y?yearCol(y):-1,prior=y?yearCol(y-1):-1;
  if(cur<0)cur=find(/^(final|adjusted|current|current year|cy|balance|closing balance|solde|year end|this year)( balance)?$/);
  if(cur<0)cur=find(/final|adjusted|current|cy\b|balance|solde/,/prior|py|previous|prelim|unadjusted|adj(ustment)?s?$|map|gifi/);
  if(prior<0)prior=find(/^(prior|prior year|py|py final|previous|previous year|last year|comparative|exercice précédent)( balance| final)?$/);
  if(prior<0)prior=find(/prior|py\b|previous|last year|comparative|précédent/,/debit|credit|dr\b|cr\b/);
  if(cols.name<0)cols.name=cols.num>=0&&cols.num!==0?0:1;
  const lines=[];
  for(const r of table.rows.slice(h+1)){
    const name=String(r[cols.name]??'').trim(),num=cols.num>=0?String(r[cols.num]??'').trim():'';
    if(!name&&!num)continue;if(/^(total|totals|net income|net loss)\b/i.test(name)&&!num)continue;
    let c=0,p=0;
    if(cols.d>=0||cols.c>=0)c=YF_NUM(r[cols.d])-YF_NUM(r[cols.c]);else if(cur>=0)c=YF_NUM(r[cur]);
    if(cols.pd>=0||cols.pc>=0)p=YF_NUM(r[cols.pd])-YF_NUM(r[cols.pc]);else if(prior>=0)p=YF_NUM(r[prior]);
    if(Math.abs(c)<0.005&&Math.abs(p)<0.005)continue;
    const s=num?{number:num,name}:Convert.splitNumber(name);
    const gifi=cols.gifi>=0?String(r[cols.gifi]??'').replace(/\D/g,'').slice(0,4):'';
    const g=Convert.guessType({number:s.number||num,fullName:name,name:s.name||name,srcType:cols.type>=0?r[cols.type]:''});
    // A GIFI code says the type better than a guess.
    const gt=/^\d{4}$/.test(gifi)?(+gifi<2600?'Asset':+gifi<3500?'Liability':+gifi<8000?'Equity':+gifi<8300?'Income':+gifi<8520?'Cost of Goods Sold':'Expense'):'';
    lines.push({code:s.number||num,name:s.name||name,type:gt||g.type,detail:g.detail||'',gifi:/^\d{4}$/.test(gifi)?gifi:'',map:cols.map>=0?String(r[cols.map]??'').trim():'',cur:r2(c),prior:r2(p)});
  }
  if(!lines.length)throw new Error('No account balances were found in that file.');
  return{lines,cols:{...cols,cur,prior},hasPrior:prior>=0||cols.pd>=0||cols.pc>=0};
}
/**
 * Match imported lines to the chart of accounts: by account number, then by name. Retained earnings goes to the opening
 * retained earnings line. Returns { map: {account: amount}, extra: [own lines], matched, unmatched: [names], gifiFill }.
 * col: which column of the import to use ('cur' when the export is last year's final, as the prior year here).
 */
function yfMatchToChart(lines,col){
  const byCode=new Map(S.accounts.filter(a=>a.code).map(a=>[String(a.code).trim().toLowerCase(),a]));
  const byName=new Map(S.accounts.map(a=>[a.name.trim().toLowerCase(),a]));
  const map={},extra=[],unmatched=[],gifiFill=[];let matched=0,reUsed=false;
  for(const l of lines){
    const v=r2(l[col]);if(Math.abs(v)<0.005)continue;
    if(!reUsed&&l.type==='Equity'&&/retained earnings|bénéfices non répartis|deficit|surplus/i.test(l.name)){map[TallyEngage.RE_OPEN]=r2((map[TallyEngage.RE_OPEN]||0)+v);reUsed=true;matched++;continue}
    const a=(l.code&&byCode.get(String(l.code).toLowerCase()))||byName.get(l.name.toLowerCase());
    if(a){map[a.id]=r2((map[a.id]||0)+v);matched++;if(l.gifi&&!a.gifi&&!gifiFill.some(x=>x.id===a.id))gifiFill.push({id:a.id,gifi:l.gifi,name:a.name});continue}
    const id=yfOwnId('cw-'+(l.code||l.name));
    extra.push({account:id,code:l.code,name:l.name,type:l.type,detail:l.detail||'',gifi:l.gifi||'',cur:0,prior:v});map[id]=v;unmatched.push(l.name);
  }
  return{map,extra,matched,unmatched,gifiFill};
}
/** Snapshot lines from the books with the prior year from a CaseWare import (and its own leftover lines). */
function yfWithPriorImport(lines,snap){
  const pm=snap.priorImport||{},out=lines.map(l=>({...l,prior:r2(pm[l.account]||0)}));
  for(const [id,v] of Object.entries(pm)){if(out.some(l=>l.account===id)||Math.abs(v)<0.005)continue;
    const a=acct(id),old=(snap.lines||[]).find(l=>l.account===id);
    if(a)out.push({account:id,code:a.code||'',name:a.name,type:a.type,detail:a.detail||'',gifi:a.gifi||'',cur:0,prior:v});
    else if(id===TallyEngage.RE_OPEN)out.push({account:id,code:'',name:'Retained earnings, beginning of year',type:'Equity',detail:'',gifi:'3600',cur:0,prior:v});
    else if(old)out.push({...old,cur:0,prior:v});}
  return out;
}
function yfCwForm(f){
  const m=openModal('Prior year from CaseWare',`<div class="muted" style="font-size:13px;margin-bottom:8px">${esc(T('In CaseWare, export last year’s trial balance to Excel, with the account number, description, GIFI and final balance. Sumlora matches each account to this company’s chart by number, then by name.'))}</div>${fld('ycFile','Last year’s trial balance (Excel or CSV)',`<input type="file" id="ycFile" accept=".xlsx,.csv,.txt">`,true)}<div data-ycres></div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" disabled>Use as the prior year</button>','wide');
  let res=null;
  $('#ycFile',m).onchange=async()=>{const file=$('#ycFile',m).files[0];if(!file)return;m.err('');
    try{const r=await yfReadCwFile(file,yfPriorEnd(f));const mm=yfMatchToChart(r.lines,'cur');res={...mm,file:file.name};
      const tot=r2(Object.values(mm.map).reduce((t,v)=>t+v,0));
      $('[data-ycres]',m).innerHTML=`<div class="banner" style="margin:8px 0;${Math.abs(tot)<0.01?'background:var(--info-soft)':''}"><span>${mm.matched} ${esc(T('accounts matched to the chart'))}${mm.unmatched.length?`; ${mm.unmatched.length} ${esc(T('kept as this file’s own lines'))}: ${mm.unmatched.slice(0,6).map(esc).join(', ')}${mm.unmatched.length>6?'…':''}`:''}. ${Math.abs(tot)<0.01?'<span class="pos">✓</span> '+esc(T('Debits equal credits')):esc(T('Out of balance by'))+' '+money(tot)}</span></div>${mm.gifiFill.length?`<label class="check"><input type="checkbox" id="ycGifi" checked> ${esc(T('Also fill in the GIFI codes CaseWare had for'))} ${mm.gifiFill.length} ${esc(T('accounts that have none in Sumlora'))}</label>`:''}`;
      $('[type=submit]',m).disabled=false}
    catch(err){m.err(err.message);res=null;$('[type=submit]',m).disabled=true}};
  m.onsubmit=async e=>{e.preventDefault();if(!res)return;
    const snap={...f.snapshot,priorSource:'caseware',priorImport:res.map,priorFile:res.file};
    snap.lines=yfWithPriorImport(f.snapshot.lines.filter(l=>!/^x:/.test(l.account)),snap);
    for(const x of res.extra)if(!snap.lines.some(l=>l.account===x.account))snap.lines.push(x);
    const w=[{op:'set',collection:'engagements',id:f.id,data:strip({...f,snapshot:snap})}];
    if($('#ycGifi',m)&&$('#ycGifi',m).checked)for(const g of res.gifiFill){const a=acct(g.id);if(a)w.push({op:'set',collection:'accounts',id:a.id,data:strip({...a,gifi:g.gifi})})}
    if(await batch(w)){closeModal();toast('Prior year brought over from CaseWare')}};
}
