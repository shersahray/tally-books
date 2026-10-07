'use strict';
/* ---------- Chart of accounts: adding standard accounts from the library (accountlib.js) ----------
   Browse or search ~300 standard Canadian accounts by section, tick the ones a client needs and add them in one
   step. An account already in the chart (same name in English or French) is shown as added. When the library's
   code is taken, the next free code after it is used. */

const libName=a=>S.company.lang==='fr'?a.fr:a.name;
const libHave=a=>S.accounts.some(x=>{const n=String(x.name||'').trim().toLowerCase();return n===a.name.toLowerCase()||n===a.fr.toLowerCase()});
const TYPE_FR={Asset:'Actif',Liability:'Passif',Equity:'Capitaux propres',Income:'Revenus','Cost of Goods Sold':'Coût des marchandises vendues',Expense:'Charges'};
/** Codes for the accounts being added: the library's code, or the next free one after it. */
function libCodes(list){
  const used=new Set(S.accounts.map(a=>a.code).filter(Boolean)),out=new Map();
  for(const a of list){let c=+a.code;while(used.has(String(c))&&c<+a.code+99)c++;const code=used.has(String(c))?'':String(c);if(code)used.add(code);out.set(a,code)}
  return out;
}
function accountLibForm(preQuery){
  const fr=S.company.lang==='fr',groups=TallyAccountLib.groups();
  const st={q:preQuery||'',g:'',picked:new Set()};
  const f=openModal('Add accounts from the list',`<div class="muted" style="font-size:13px">${esc(T('Standard Canadian accounts, by section. Tick the ones this client needs. Accounts already in the chart are marked; nothing in the chart changes.'))}</div>
    <div class="toolbar" style="padding:8px 0;gap:8px;flex-wrap:wrap"><input type="search" id="alQ" class="grow" placeholder="${esc(T('Search, e.g. vehicle, interest, shareholder'))}" value="${esc(st.q)}" aria-label="Search accounts">
      <select id="alG" aria-label="Section"><option value="">${esc(T('All sections'))}</option>${groups.map(g=>`<option value="${g.key}">${esc(fr?g.fr:g.en)}</option>`).join('')}</select></div>
    <div class="acclib" data-allist></div><div class="muted" data-alcount style="font-size:13px;margin-top:8px"></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" data-aladd disabled>Add accounts</button>`,'wide');
  const match=a=>{const q=st.q.trim().toLowerCase();if(!q)return true;return[a.name,a.fr,a.hint,a.code,a.type,(TallyAccountLib.GROUPS[a.group]||[]).join(' ')].join(' ').toLowerCase().includes(q)};
  const draw=()=>{
    const gs=groups.filter(g=>!st.g||g.key===st.g).map(g=>({g,list:g.accounts.filter(match)})).filter(x=>x.list.length);
    $('[data-allist]',f).innerHTML=gs.length?gs.map(({g,list})=>{const open=list.filter(a=>!libHave(a));
      return `<div class="acclib-sec"><div class="acclib-head"><b>${esc(fr?g.fr:g.en)}</b> <span class="muted">${esc(fr?TYPE_FR[g.type]:T(g.type))}</span>${open.length>1?`<button type="button" class="btn sm ghost" data-algrp="${g.key}">${open.every(a=>st.picked.has(a))?esc(T('Untick all')):esc(T('Tick all'))}</button>`:''}</div>
        ${list.map(a=>{const have=libHave(a),i=TallyAccountLib.ACCOUNTS.indexOf(a);return `<label class="acclib-row ${have?'have':''}"><input type="checkbox" data-alpick="${i}" ${have?'disabled checked':st.picked.has(a)?'checked':''}><span class="mono muted">${esc(a.code)}</span><span><span translate="no">${esc(libName(a))}</span>${a.detail==='bank'?` <span class="pill quiet">${esc(T('Bank or cash'))}</span>`:a.detail==='card'?` <span class="pill quiet">${esc(T('Credit card'))}</span>`:''}${have?` <span class="pill paid">${esc(T('In the chart'))}</span>`:''}${a.hint?`<span class="muted acclib-hint">${esc(T(a.hint))}</span>`:''}</span></label>`}).join('')}</div>`}).join(''):`<div class="empty"><b>${esc(T('No accounts match'))}</b>${esc(T('Try another word, or add your own with + Add account.'))}</div>`;
    const n=st.picked.size,btn=$('[data-aladd]',f);btn.disabled=!n;btn.textContent=n?`${T('Add')} ${n} ${n===1?T('account'):T('accounts')}`:T('Add accounts');
    $('[data-alcount]',f).textContent=`${TallyAccountLib.ACCOUNTS.filter(a=>!libHave(a)).length} ${T('accounts you can add')} · ${S.accounts.length} ${T('in the chart now')}`;
  };
  $('#alQ',f).oninput=e=>{st.q=e.target.value;draw()};
  $('#alG',f).onchange=e=>{st.g=e.target.value;draw()};
  f.addEventListener('change',e=>{const i=e.target.dataset.alpick;if(i===undefined)return;const a=TallyAccountLib.ACCOUNTS[+i];e.target.checked?st.picked.add(a):st.picked.delete(a);draw()});
  f.addEventListener('click',e=>{const b=e.target.closest('[data-algrp]');if(!b)return;const g=groups.find(x=>x.key===b.dataset.algrp),open=g.accounts.filter(a=>match(a)&&!libHave(a)),all=open.every(a=>st.picked.has(a));open.forEach(a=>all?st.picked.delete(a):st.picked.add(a));draw()});
  draw();
  f.onsubmit=async e=>{e.preventDefault();const list=[...st.picked].filter(a=>!libHave(a));if(!list.length)return;
    const codes=libCodes(list);
    const writes=list.map(a=>{const code=codes.get(a);return{op:'set',collection:'accounts',id:code&&!acct('a'+code)?'a'+code:uid(),data:{code,name:libName(a),type:a.type,detail:a.detail,desc:a.hint&&!fr?a.hint:'',...(a.gifi?{gifi:a.gifi}:{}),active:true}}});
    if(!await batch(writes))return;closeModal();toast(`${T('Added')} ${list.length} ${list.length===1?T('account'):T('accounts')}`)};
}
/** In the new account form: search the library and fill in the type, detail, name and code from a pick. */
function libSuggestHTML(){return `<div class="field" style="grid-column:1/-1"><label for="aLib">${esc(T('Start from a standard account (optional)'))}</label><input type="search" id="aLib" list="aLibList" placeholder="${esc(T('Type to search, e.g. shareholder, fuel, deferred revenue'))}" autocomplete="off"><datalist id="aLibList">${TallyAccountLib.ACCOUNTS.filter(a=>!libHave(a)).map(a=>`<option value="${esc(libName(a))}">${esc(a.code)} · ${esc(S.company.lang==='fr'?TYPE_FR[a.type]:a.type)}</option>`).join('')}</datalist><span class="hint">${esc(T('Or browse them all:'))} <button type="button" class="link" data-libbrowse>${esc(T('Add accounts from the list'))}</button></span></div>`}
function wireLibSuggest(f,fillDet){
  const i=$('#aLib',f);if(!i)return;
  const b=$('[data-libbrowse]',f);if(b)b.onclick=()=>{closeModal();accountLibForm(i.value)};
  i.addEventListener('change',()=>{const a=TallyAccountLib.ACCOUNTS.find(x=>libName(x).toLowerCase()===i.value.trim().toLowerCase());if(!a)return;
    $('#aType',f).value=a.type;fillDet();$('#aDet',f).value=a.detail;$('#aDet',f).dispatchEvent(new Event('change'));$('#aType',f).dispatchEvent(new Event('change'));
    $('#aName',f).value=libName(a);$('#aName',f).dispatchEvent(new Event('input'));if(!$('#aCode',f).value)$('#aCode',f).value=libCodes([a]).get(a)||'';if(a.hint&&!$('#aDesc',f).value&&S.company.lang!=='fr')$('#aDesc',f).value=a.hint;
    const g=$('#aGifi',f);if(g&&a.gifi){g.value=a.gifi;g.dispatchEvent(new Event('input'))}});
}
