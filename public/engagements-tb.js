'use strict';
/* ---------- Year-end files: the trial balance workspace ----------
 * The trial balance with debit and credit columns for the prior year and the current year, adjustments, the adjusted
 * balance, classification and leadsheet, and a clear difference when it doesn't balance.
 * A file can take its trial balance from Sumlora's books (it then follows the books by itself), from an Excel or CSV
 * import, or typed in by hand. Imported and typed-in accounts are the file's own ("x:" ids) and never touch the books.
 */
const YF_TYPES=['Asset','Liability','Equity','Income','Cost of Goods Sold','Expense'];
const yfOwnId=s=>'x:'+(String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50)||uid());
const yfSrcLabel={books:'Sumlora’s books',import:'Imported',manual:'Typed in'};
const yfDrCr=v=>v>0?[mcell(v),'']:v<0?['',mcell(-v)]:['',''];

function yfTb(f,tb,edit){
  const src=(f.snapshot&&f.snapshot.source)||'books',typing=edit&&src!=='books';
  const bar=typeof yfLedgerBar==='function'?yfLedgerBar(f,edit):'';
  if(typing)return bar+yfTbEdit(f,tb);
  const opts=sel=>TallyEngage.LEADSHEETS.map(l=>`<option value="${l.code}" ${l.code===sel?'selected':''}>${esc(l.code+' · '+T(l.label))}</option>`).join('');
  const tot={pd:0,pc:0,cd:0,cc:0,adj:0,fd:0,fc:0};
  const rows=tb.map(r=>{const p=yfDrCr(r.prior),c=yfDrCr(r.cur),fi=yfDrCr(r.final);
    tot.pd+=Math.max(r.prior,0);tot.pc+=Math.max(-r.prior,0);tot.cd+=Math.max(r.cur,0);tot.cc+=Math.max(-r.cur,0);tot.adj+=r.adj;tot.fd+=Math.max(r.final,0);tot.fc+=Math.max(-r.final,0);
    return `<tr><td>${yfName(r)}${r.gifi?` <span class="muted mono" style="font-size:12px">${esc(r.gifi)}</span>`:''}</td><td class="muted">${esc(T(r.type))}</td><td>${edit?`<select data-yfmap="${esc(r.account)}" aria-label="Leadsheet">${opts(r.lead)}</select>`:esc(r.lead+' · '+T(yfLead(r.lead)))}</td><td class="n">${p[0]}</td><td class="n">${p[1]}</td><td class="n">${c[0]}</td><td class="n">${c[1]}</td><td class="n">${r.adj?mcell(r.adj):''}</td><td class="n"><b>${fi[0]}</b></td><td class="n"><b>${fi[1]}</b></td></tr>`}).join('');
  for(const k in tot)tot[k]=r2(tot[k]);
  const diff=[['Prior year',r2(tot.pd-tot.pc)],['Unadjusted',r2(tot.cd-tot.cc)],['Adjusted',r2(tot.fd-tot.fc)]].filter(x=>Math.abs(x[1])>=0.005);
  return `${bar}${diff.length?`<div class="banner err"><span><b>${esc(T('The trial balance doesn’t balance.'))}</b> ${diff.map(([l,v])=>`${esc(T(l))}: ${esc(T('debits are'))} ${money(Math.abs(v))} ${esc(T(v>0?'more than credits':'less than credits'))}`).join(' · ')}</span></div>`:`<div class="muted" style="margin-bottom:8px"><span class="pos">✓</span> ${esc(T('Debits equal credits'))} · ${esc(T('Source'))}: ${esc(T(yfSrcLabel[src]))}${src==='books'?' · '+esc(T('follows the books until the file is final')):''}</div>`}
  <div class="panel"><div class="toolbar"><span class="grow muted">${esc(T('Debits and credits for each year. Each account’s leadsheet is suggested from its type, GIFI code and name; change it here.'))}</span>${edit&&src==='books'?`<button class="btn sm" data-yfcw title="${esc(T('Use last year’s final trial balance exported from CaseWare as the prior year'))}">${esc(T('Prior year from CaseWare…'))}</button>`:''}${f.snapshot.priorSource==='caseware'?`<span class="pill quiet">${esc(T('Prior year from CaseWare'))}${f.snapshot.priorFile?': '+esc(f.snapshot.priorFile):''}</span>`:''}<button class="btn sm" data-yfxlsx="tb">${esc(T('Excel'))}</button></div><div class="tbl-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Leadsheet</th><th class="n">Prior Dr</th><th class="n">Prior Cr</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Adjustments</th><th class="n">Adjusted Dr</th><th class="n">Adjusted Cr</th></tr></thead><tbody>${rows}<tr class="tot"><td colspan="3">${esc(T('Totals'))}</td><td class="n">${money(tot.pd)}</td><td class="n">${money(tot.pc)}</td><td class="n">${money(tot.cd)}</td><td class="n">${money(tot.cc)}</td><td class="n">${mcell(tot.adj)}</td><td class="n">${money(tot.fd)}</td><td class="n">${money(tot.fc)}</td></tr></tbody></table></div></div>`;
}

/* Typing in (and correcting) a trial balance that didn't come from the books. */
function yfTbEdit(f,tb){
  const lines=f.snapshot.lines,adj=TallyEngage.ajeTotals(f);
  const num=v=>v?String(r2(v)):'';
  const row=(l,i)=>`<tr data-tbrow="${i}"><td><input type="text" data-tbf="code" value="${esc(l.code||'')}" maxlength="30" style="width:80px" aria-label="Number"></td><td><input type="text" data-tbf="name" value="${esc(l.name||'')}" maxlength="200" aria-label="Account name" ${l.account===TallyEngage.RE_OPEN?'readonly':''}></td><td><select data-tbf="type" aria-label="Type">${YF_TYPES.map(t=>`<option ${l.type===t?'selected':''}>${t}</option>`).join('')}</select></td><td><input type="number" step="0.01" min="0" data-tbf="pd" value="${num(Math.max(l.prior||0,0))}" aria-label="Prior debit" style="width:110px"></td><td><input type="number" step="0.01" min="0" data-tbf="pc" value="${num(Math.max(-(l.prior||0),0))}" aria-label="Prior credit" style="width:110px"></td><td><input type="number" step="0.01" min="0" data-tbf="cd" value="${num(Math.max(l.cur||0,0))}" aria-label="Debit" style="width:110px"></td><td><input type="number" step="0.01" min="0" data-tbf="cc" value="${num(Math.max(-(l.cur||0),0))}" aria-label="Credit" style="width:110px"></td><td class="n">${adj[l.account]?mcell(adj[l.account]):''}</td><td><button class="btn sm" data-tbdel="${i}" aria-label="Remove" ${(f.ajes||[]).some(j=>j.lines.some(x=>x.account===l.account))?'disabled title="Used on an adjusting entry"':''}>×</button></td></tr>`;
  return `<div data-tbdiff></div><div class="panel"><div class="toolbar"><span class="grow muted">${esc(T('Source'))}: ${esc(T(yfSrcLabel[f.snapshot.source]))}${f.snapshot.fileName?' · '+esc(f.snapshot.fileName):''}. ${esc(T('Type the balances, or import a file again. Saving keeps any difference, but the file can’t be final until debits equal credits.'))}</span><label class="btn sm">${esc(T('Import Excel or CSV…'))}<input type="file" data-yftbimport hidden accept=".xlsx,.csv,.txt"></label><button class="btn sm" data-yfxlsx="tb">${esc(T('Excel'))}</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Account</th><th>Type</th><th class="n">Prior Dr</th><th class="n">Prior Cr</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Adjustments</th><th></th></tr></thead><tbody data-tbbody>${lines.map(row).join('')}</tbody><tfoot><tr class="tot"><td colspan="3"><button class="btn sm" data-tbadd>+ ${esc(T('Account'))}</button> ${esc(T('Totals'))}</td><td class="n" data-tbt="pd"></td><td class="n" data-tbt="pc"></td><td class="n" data-tbt="cd"></td><td class="n" data-tbt="cc"></td><td></td><td></td></tr></tfoot></table></div>
    <div class="pad"><button class="btn primary" data-tbsave>${esc(T('Save trial balance'))}</button></div></div>`;
}
/** Read the typed-in table back into snapshot lines. */
function yfTbRead(f,m){
  const old=f.snapshot.lines;
  return $$('[data-tbrow]',m).map(tr=>{const g=k=>$(`[data-tbf=${k}]`,tr).value;const i=+tr.dataset.tbrow;const prev=old[i];
    const name=g('name').trim(),code=g('code').trim();if(!name&&!code)return null;
    return{account:prev?prev.account:yfOwnId(code||name),code,name:name||code,type:g('type'),detail:prev?prev.detail||'':'',gifi:prev?prev.gifi||'':'',cur:r2((+g('cd')||0)-(+g('cc')||0)),prior:r2((+g('pd')||0)-(+g('pc')||0))}}).filter(Boolean);
}
function yfTbTotals(m){
  const s=k=>r2($$(`[data-tbf=${k}]`,m).reduce((t,x)=>t+(+x.value||0),0));
  const t={pd:s('pd'),pc:s('pc'),cd:s('cd'),cc:s('cc')};
  for(const k in t){const c=$(`[data-tbt=${k}]`,m);if(c)c.textContent=money(t[k])}
  const box=$('[data-tbdiff]',m);if(!box)return;
  const d=[['Prior year',r2(t.pd-t.pc)],['Current year',r2(t.cd-t.cc)]].filter(x=>Math.abs(x[1])>=0.005);
  box.innerHTML=d.length?`<div class="banner err"><span><b>${esc(T('Out of balance.'))}</b> ${d.map(([l,v])=>`${esc(T(l))}: ${esc(T('debits are'))} ${money(Math.abs(v))} ${esc(T(v>0?'more than credits':'less than credits'))}`).join(' · ')}</span></div>`:`<div class="muted" style="margin-bottom:8px"><span class="pos">✓</span> ${esc(T('Debits equal credits'))}</div>`;
}
function yfTbBind(m,f){
  if(!$('[data-tbbody]',m))return;
  yfTbTotals(m);
  $('[data-tbbody]',m).oninput=()=>yfTbTotals(m);
  const add=$('[data-tbadd]',m);if(add)add.onclick=()=>{const body=$('[data-tbbody]',m),i=body.children.length+1000;body.insertAdjacentHTML('beforeend',`<tr data-tbrow="${i}"><td><input type="text" data-tbf="code" maxlength="30" style="width:80px" aria-label="Number"></td><td><input type="text" data-tbf="name" maxlength="200" aria-label="Account name"></td><td><select data-tbf="type" aria-label="Type">${YF_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></td>${['pd','pc','cd','cc'].map(k=>`<td><input type="number" step="0.01" min="0" data-tbf="${k}" style="width:110px" aria-label="${k}"></td>`).join('')}<td></td><td><button class="btn sm" data-tbdel="${i}" aria-label="Remove">×</button></td></tr>`);$('[data-tbbody] tr:last-child input',m).focus()};
  $('[data-tbbody]',m).onclick=e=>{const b=e.target.closest('[data-tbdel]');if(b&&!b.disabled){b.closest('tr').remove();yfTbTotals(m)}};
  const save=$('[data-tbsave]',m);if(save)save.onclick=async()=>{const lines=yfTbRead(f,m);
    const ids=new Set();for(const l of lines){while(ids.has(l.account))l.account=yfOwnId(l.code+l.name+uid());ids.add(l.account)}
    if(await yfSave(f,{snapshot:{...f.snapshot,lines,takenAt:Date.now(),by:ME?ME.name:''}}))toast('Trial balance saved')};
  const imp=$('[data-yftbimport]',m);if(imp)imp.onchange=async()=>{const file=imp.files[0];imp.value='';if(!file)return;
    try{const lines=await yfReadTbFile(file);if(await confirmBox('Replace the trial balance?',`${lines.length} accounts from ${file.name} replace the current year’s balances. Prior-year figures for accounts in both are kept.`,'Replace')){
      const prior=Object.fromEntries(f.snapshot.lines.map(l=>[l.code||l.name,l.prior]));
      await yfSave(f,{snapshot:{...f.snapshot,source:'import',fileName:file.name,takenAt:Date.now(),lines:lines.map(l=>({...l,prior:prior[l.code||l.name]||0}))}})}}
    catch(err){toast(err.message,true)}};
}

/**
 * Read a trial balance from Excel or CSV (QuickBooks, Sage, CaseWare or a spreadsheet): number, name, type when there is
 * one, and debit/credit or a balance. Prior-year columns ("Prior", "Previous", or a column for an earlier year) are read
 * too when the file has them. Retained earnings becomes the opening retained earnings line.
 */
async function yfReadTbFile(file,yearEnd){
  // CaseWare and most other exports: number, description, GIFI, map number, and year or debit/credit columns.
  try{const r=await yfReadCwFile(file,yearEnd);let reUsed=false;const seen=new Set();
    return r.lines.map(l=>{let account=!reUsed&&l.type==='Equity'&&/retained earnings|bénéfices non répartis|deficit/i.test(l.name)?(reUsed=true,TallyEngage.RE_OPEN):yfOwnId(l.code||l.name);
      while(seen.has(account))account=yfOwnId(l.code+'-'+l.name+'-'+uid());seen.add(account);
      return{account,code:l.code,name:l.name,type:l.type,detail:l.detail||'',gifi:l.gifi||'',cur:l.cur,prior:l.prior}});
  }catch(e){/* not that layout: the simpler reader below */}
  return yfReadTbFileSimple(file);
}
async function yfReadTbFileSimple(file){
  const tables=await Convert.readFile(file.name,new Uint8Array(await file.arrayBuffer()),cvInflate);
  const table=tables.find(t=>t.rows&&t.rows.length)||{rows:[]};
  const h=Convert.findHeader(table.rows);
  if(h<0)throw new Error('Sumlora couldn’t find the column headings (account, debit, credit or balance) in that file.');
  const head=table.rows[h].map(c=>String(c||'').toLowerCase().trim());
  const rows=Convert.readTB(table,h);
  if(!rows.length)throw new Error('No account balances were found in that file.');
  const ti=head.findIndex(c=>/^(type|account type|class|category)$/.test(c));
  // Prior-year columns.
  const pIdx=re=>head.findIndex(c=>re.test(c));
  const pd=pIdx(/(prior|previous|last year|py).*(debit|dr)\b/),pc=pIdx(/(prior|previous|last year|py).*(credit|cr)\b/),pb=pIdx(/^(prior|previous|last year|py)( year)?( balance)?$/);
  const amt=v=>{const s=String(v??'').replace(/[$,\s]/g,'');const neg=/^\(.*\)$/.test(s)||/-$/.test(s);const n=parseFloat(s.replace(/[()\-]/g,''));return isNaN(n)?0:(neg?-n:n)};
  const body=table.rows.slice(h+1),byName=new Map(body.map(r=>[String(r.find(c=>c)||''),r]));
  let reUsed=false;const seen=new Set();
  return rows.map(r=>{
    const raw=body.find(x=>x.some(c=>String(c||'').includes(r.name)))||byName.get(r.number)||[];
    const g=Convert.guessType({number:r.number,fullName:r.fullName,name:r.name,srcType:ti>=0?raw[ti]:''});
    const prior=pd>=0||pc>=0?r2(amt(raw[pd])-amt(raw[pc])):pb>=0?amt(raw[pb]):0;
    let account=/retained earnings|bénéfices non répartis|deficit/i.test(r.name)&&!reUsed?(reUsed=true,TallyEngage.RE_OPEN):yfOwnId(r.number||r.name);
    while(seen.has(account))account=yfOwnId(r.number+'-'+r.name+'-'+uid());seen.add(account);
    return{account,code:r.number||'',name:r.name,type:g.type,detail:g.detail||'',gifi:'',cur:r2(r.amount),prior:r2(prior)};
  });
}

/* ---------- the engagement package (PDF) ---------- */
/**
 * The pages after the statements and notes in the firm's own engagement package: the adjusted trial balance, the
 * leadsheets, each working paper (sign-offs, work done, documents), the adjusting entries, review notes, the
 * checklist and the file's sign-offs. P: the drawing helpers from yfPdf.
 */
function yfPackagePages(f,P){
  const{doc,W0,H0,M,title,para}=P;let y;const Y=()=>P.getY(),set=v=>P.setY(v);
  // A table: cols [{label,w,align}], rows [[cells]], bold rows marked with {bold:true} as the last item.
  const grid=(t,sub,cols,rows)=>{
    title(t,sub);y=Y();
    const xs=[];let x=M;for(const c of cols){xs.push(x);x+=c.w}
    const headRow=()=>{cols.forEach((c,i)=>doc.text(c.align==='right'?xs[i]+c.w-4:xs[i],y,tl(c.label),{size:8.5,bold:true,align:c.align==='right'?'right':undefined}));y+=6;doc.line(M,y,W0-M,y,{color:'#999999'});y+=12};
    headRow();
    for(const r of rows){
      const last=r[r.length-1],flag=last&&typeof last==='object',bold=flag&&!!last.bold,cells=flag?r.slice(0,-1):r;
      const wrapped=cells.map((v,i)=>cols[i].align==='right'?[String(v??'')]:doc.wrap(String(v??''),cols[i].w-6,8.5,bold).slice(0,6));
      const h=Math.max(...wrapped.map(w=>w.length))*11+3;
      if(y+h>H0-M-14){set(y);P.page();y=M;headRow()}
      if(bold)doc.line(M,y-9,W0-M,y-9,{color:'#bbbbbb'});
      wrapped.forEach((lines,i)=>lines.forEach((l,k)=>doc.text(cols[i].align==='right'?xs[i]+cols[i].w-4:xs[i],y+k*11,l,{size:8.5,bold,align:cols[i].align==='right'?'right':undefined})));
      y+=h;
    }
    set(y);
  };
  const ye=fmtDate(f.yearEnd),m=v=>Math.abs(v)>=0.005?money(v):'';
  const stamp=x=>x?`${x.by} ${fmtDate(iso(new Date(x.at)))}`:'—';
  // Adjusted trial balance
  const tb=TallyEngage.workingTb(f,S.accounts);
  const W=W0-2*M;
  grid('Adjusted trial balance',`${tl('As at')} ${ye}`,[{label:'Account',w:W-4*82-34},{label:'LS',w:34},{label:'Prior year',w:82,align:'right'},{label:'Unadjusted',w:82,align:'right'},{label:'Adjustments',w:82,align:'right'},{label:'Adjusted',w:82,align:'right'}],
    [...tb.map(r=>[`${r.code?r.code+' ':''}${r.name}`,r.lead,money(r.prior),money(r.cur),m(r.adj),money(r.final)]),['Total','',money(tb.reduce((t,r)=>t+r.prior,0)),money(tb.reduce((t,r)=>t+r.cur,0)),m(tb.reduce((t,r)=>t+r.adj,0)),money(tb.reduce((t,r)=>t+r.final,0)),{bold:true}]]);
  // Leadsheets
  const ls=TallyEngage.leadsheets(f,S.accounts),lr=[];
  for(const l of ls){lr.push([`${l.code} · ${T(l.label)}`,'','','','',{bold:true}]);l.lines.forEach(r=>lr.push([`   ${r.code?r.code+' ':''}${r.name}`,money(r.prior),money(r.cur),m(r.adj),money(r.final)]));lr.push([`${tl('Total')} ${l.code}`,money(l.prior),money(l.cur),m(l.adj),money(l.final),{bold:true}])}
  grid('Leadsheets',`${tl('As at')} ${ye}`,[{label:'Leadsheet',w:W-4*82},{label:'Prior year',w:82,align:'right'},{label:'Unadjusted',w:82,align:'right'},{label:'Adjustments',w:82,align:'right'},{label:'Final',w:82,align:'right'}],lr);
  // Working papers
  const wps=TallyEngage.workingPapers(f,S.accounts);
  title('Working papers',ye);y=Y();
  for(const w of wps){
    const wp=w.wp,docs=yfDocs(f,w.code),notes=(f.reviewNotes||[]).filter(n=>n.wp===w.code);
    if(y>H0-M-90){set(y);P.page();y=M}
    doc.text(M,y,`${w.code} · ${T(w.label)}`,{size:11,bold:true});if(w.lines.length)doc.text(W0-M,y,money(w.final),{size:10,bold:true,align:'right'});y+=14;
    doc.text(M,y,`${tl('Status')}: ${T(TallyEngage.WP_STATUS[wp.status||'notstarted'])} · ${tl('Prepared')}: ${stamp(wp.prepared)} · ${tl('Reviewed')}: ${stamp(wp.reviewed)}`,{size:8.5,color:'#555555'});y+=13;
    set(y);
    const ticks=Object.entries(wp.ticks||{}).map(([a,k])=>{const r=w.lines.find(x=>x.account===a);return r?`${((TallyEngage.TICKS[k]||{}).mark||'').replace('✓','OK')} ${r.name}`:''}).filter(Boolean);
    for(const [lbl,txt] of [['Work done and conclusion',wp.notes],['Comments',wp.comment],['References',wp.refs],['Tickmarks',ticks.join(' · ')],['Documents',docs.map(d=>d.name).join(' · ')],['Review notes',notes.map(n=>`RN ${n.num} (${T(TallyEngage.NOTE_STATUS[n.status])}): ${n.text}${n.resolution?' – '+n.resolution:''}`).join('\n')]]){
      if(!txt)continue;y=Y();if(y>H0-M-20){P.page();set(M)}
      doc.text(M,Y(),tl(lbl),{size:8.5,bold:true});set(Y()+11);para(txt,8.5);
    }
    set(Y()+10);y=Y();
  }
  // Adjusting entries
  const ar=[];for(const j of (f.ajes||[]).slice().sort((a,b)=>a.num-b.num)){ar.push([`AJE ${j.num}`,`${j.memo}${j.explanation?'\n'+j.explanation:''}`,'','',`${tl('Prepared')} ${stamp(j.preparedBy)}\n${tl('Reviewed')} ${stamp(j.reviewedBy)}${j.entryId?'\n'+tl('Posted to the books'):''}`,{bold:true}]);for(const l of j.lines)ar.push(['',`   ${(acct(l.account)||f.snapshot.lines.find(x=>x.account===l.account)||{name:''}).name}`,l.debit?money(l.debit):'',l.credit?money(l.credit):'',''])}
  grid('Adjusting entries',ye,[{label:'No.',w:48},{label:'Description',w:W-48-2*76-130},{label:'Debit',w:76,align:'right'},{label:'Credit',w:76,align:'right'},{label:'Sign-offs',w:130}],ar.length?ar:[['','None','','','']]);
  // Review notes
  const rn=(f.reviewNotes||[]).slice().sort((a,b)=>a.num-b.num).map(n=>[`RN ${n.num}`,n.wp||'',`${n.text}${n.resolution?'\n'+tl('Resolution')+': '+n.resolution:''}`,`${T(TallyEngage.NOTE_STATUS[n.status])}\n${T(TallyEngage.PRIORITY[n.priority])}`,`${n.assigneeName||''}\n${tl('Raised')} ${stamp(n.created)}${n.resolved?'\n'+tl('Resolved')+' '+stamp(n.resolved):''}`]);
  grid('Review notes',ye,[{label:'No.',w:44},{label:'WP',w:34},{label:'Note',w:W-44-34-80-130},{label:'Status',w:80},{label:'People',w:130}],rn.length?rn:[['','','None','','']]);
  // Checklist and sign-offs
  const cl=TallyEngage.checklist(f,S.accounts,S.attachments),cr=[];
  for(const g of cl){cr.push([T(g.group),'','',{bold:true}]);for(const i of g.items)cr.push([`   ${T(i.label)}`,i.done?tl('Done'):'—',i.auto?tl('Automatic'):i.by?stamp(i.by):''])}
  const so=f.signoffs||{};
  cr.push([tl('Sign-offs'),'','',{bold:true}],[`   ${tl('Prepared by')}`,so.prepared?tl('Done'):'—',stamp(so.prepared)],[`   ${tl('Reviewed by')}`,so.reviewed?tl('Done'):'—',stamp(so.reviewed)],[`   ${tl('Final')}`,yfFinal(f)?tl('Done'):'—',yfFinal(f)?`${f.finalBy} ${fmtDate(iso(new Date(f.finalAt)))}`:'']);
  for(const u of f.unlocks||[])cr.push([`   ${tl('Reopened')}: ${u.reason}`,'',stamp(u)]);
  grid('Completion checklist and sign-offs',ye,[{label:'Item',w:W-40-170},{label:'',w:40},{label:'Who and when',w:170}],cr);
}

/* ---------- Excel export (trial balance, leadsheets) ---------- */
/** A small .xlsx workbook: sheets [{name, rows: [[cell]]}], numbers as numbers. */
function yfMakeXlsx(sheets){
  const x=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const col=i=>{let s='';i++;while(i){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26)}return s};
  const sheetXml=rows=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r,ri)=>`<row r="${ri+1}">${r.map((v,ci)=>{const ref=col(ci)+(ri+1);if(v===''||v==null)return'';if(typeof v==='number')return`<c r="${ref}" s="${ri===0?1:2}"><v>${v}</v></c>`;return`<c r="${ref}" t="inlineStr"${ri===0?' s="1"':''}><is><t xml:space="preserve">${x(v)}</t></is></c>`}).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files=[
    {name:'[Content_Types].xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`},
    {name:'_rels/.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:'xl/workbook.xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${x(s.name.slice(0,31))}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`},
    {name:'xl/_rels/workbook.xml.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:'xl/styles.xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00)"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`},
    ...sheets.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:sheetXml(s.rows)})),
  ];
  return makeZip(files);
}
/** Excel download: 'tb' the working trial balance; 'ls' the leadsheets (one sheet each) with the trial balance. */
function yfXlsx(f,what){
  const tb=TallyEngage.workingTb(f,S.accounts);
  const tbRows=[['Account number','Account','Type','Leadsheet','GIFI','Prior year debit','Prior year credit','Debit','Credit','Adjustments','Adjusted balance'],
    ...tb.map(r=>[r.code||'',r.name,r.type,r.lead,r.gifi||'',r.prior>0?r.prior:'',r.prior<0?-r.prior:'',r.cur>0?r.cur:'',r.cur<0?-r.cur:'',r.adj||'',r.final])];
  const sheets=[{name:'Trial balance',rows:tbRows}];
  if(what==='ls')for(const l of TallyEngage.leadsheets(f,S.accounts))sheets.push({name:`${l.code} ${l.label}`.replace(/[\\/?*[\]:]/g,' '),rows:[['Account number','Account','Prior year','Unadjusted','Adjustments','Final'],...l.lines.map(r=>[r.code||'',r.name,r.prior,r.cur,r.adj||'',r.final]),['','Total',l.prior,l.cur,l.adj||'',l.final]]});
  const safe=String(S.company.name||'company').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();
  saveFile(`${safe}-${what==='ls'?'leadsheets':'trial-balance'}-${f.yearEnd}.xlsx`,yfMakeXlsx(sheets));
}
