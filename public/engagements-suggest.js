'use strict';
/* ---------- Year-end files: suggested adjusting entries ----------
 * Drafts Sumlora can make from the books: the year's amortization for assets in the register not yet booked, possible
 * accruals for bills dated just after the year-end, and shareholder accounts on the wrong side. The accountant adds each
 * one as a draft (it then goes through review like any other) or ignores it. Rules in engagements-calc.js suggestAjes.
 */
function yfSuggestCtx(f){
  if(f.snapshot.source&&f.snapshot.source!=='books')return{};
  const fy=fyStartOf(f.yearEnd),key=fy.slice(0,4),amort=[];
  if(typeof bookSchedule==='function')for(const a of S.assets){
    if(a.method==='none'||a.acquired>f.yearEnd||(a.posted||{})[key])continue;
    const s=bookSchedule(a)[fy];if(!s||!(s.amount>0))continue;
    amort.push({id:a.id,name:a.name,amount:s.amount,expense:a.expenseAccount,accum:a.accumAccount});
  }
  const min=yfMin(f),end=addDays(f.yearEnd,45),vend=id=>(S.contacts.find(c=>c.id===id)||{}).name||'';
  const bills=S.docs.filter(d=>d.kind==='bill'&&d.date>f.yearEnd&&d.date<=end&&Math.abs(+d.total||0)>=min).map(d=>({id:d.id,number:d.number||'',vendor:vend(d.contactId),date:d.date,lines:(d.lines||[]).map(l=>({account:l.account,amount:r2((+l.qty||1)*(+l.rate||0))}))}));
  const acc=S.accounts.find(a=>a.type==='Liability'&&/accrued/i.test(a.name)&&a.active!==false)||S.accounts.find(a=>a.detail==='ap');
  return{amort,bills,accrualAccount:acc?acc.id:'',types:Object.fromEntries(S.accounts.map(a=>[a.id,a.type]))};
}
function yfSuggestPanel(f,edit){
  if(!edit)return'';
  const list=TallyEngage.suggestAjes(f,S.accounts,yfSuggestCtx(f));
  if(!list.length)return'';
  const name=id=>(acct(id)||{}).name||'';
  const KIND={amortization:'Amortization',accrual:'Possible accrual',reclass:'Reclassification'};
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Suggested adjusting entries'))}</b><span class="muted" style="font-size:12.5px">${esc(T('Drafted from the books. Add the ones that apply; they go through review like any other.'))}</span></div><div class="tbl-wrap"><table><tbody>${list.map(x=>`<tr><td style="width:130px"><span class="pill quiet">${esc(T(KIND[x.kind]))}</span></td><td><b>${esc(x.memo)}</b><div class="muted" style="font-size:12.5px">${esc(x.explanation)}</div><div style="font-size:12.5px">${x.lines.map(l=>`${esc(name(l.account))} ${l.debit?money(l.debit):'('+money(l.credit)+')'}`).join(' · ')}</div></td><td class="n"><button class="btn sm" data-yfsugg="${esc(x.key)}">${esc(T('Add as a draft'))}</button></td></tr>`).join('')}</tbody></table></div></div>`;
}
async function yfSuggestClick(e,t,d,f){
  if(!d.yfsugg)return false;
  const x=TallyEngage.suggestAjes(f,S.accounts,yfSuggestCtx(f)).find(y=>y.key===d.yfsugg);if(!x)return true;
  const j={id:uid(),fromId:x.key,num:Math.max(0,...(f.ajes||[]).map(y=>y.num))+1,date:f.yearEnd,memo:x.memo,explanation:x.explanation,wp:x.wp,recurring:x.kind==='amortization',lines:x.lines,entryId:''};
  if(await yfSave(f,{ajes:(f.ajes||[]).concat(j)}))toast(`Added as AJE ${j.num} (draft)`);
  return true;
}
