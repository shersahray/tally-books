'use strict';
/* ---------- Language: English or French (Canada) ----------
 * The app is written in English. When French is chosen, every piece of text that appears on the
 * screen is looked up in the French dictionary (fr.js) and replaced, including text added later
 * (modals, toasts, messages from the server). Numbers, amounts and dates inside a sentence are
 * kept as they are: "Paid 3 bills" is looked up as "Paid {0} bills".
 * Anything inside an element with translate="no" (account and company names, people's data) is left alone.
 * Amounts and dates use Canadian French formats (1 234,56 $ · 18 sept. 2026).
 */
const I18N={lang:'en',dict:{},wild:[]};
const LS_LANG='tb_lang';
function lsLang(){try{return localStorage.getItem(LS_LANG)||''}catch(e){return ''}}
I18N.lang=(lsLang()||((navigator.language||'').toLowerCase().startsWith('fr')?'fr':'en'))==='fr'?'fr':'en';
const LOC=()=>I18N.lang==='fr'?'fr-CA':'en-CA';
// The app has its own English/Français switch. Browser auto-translation garbles accounting terms
// (for example it reads “Rate” as the French “raté”, missed), so turn it off.
document.documentElement.setAttribute('translate','no');
document.documentElement.lang=I18N.lang==='fr'?'fr-CA':'en-CA';
const isFr=()=>I18N.lang==='fr';

/** Choose a language. Saved in this browser and, when signed in, on the account. Reloads to redraw everything. */
async function setLang(lang,{save=true}={}){
  lang=lang==='fr'?'fr':'en';
  try{localStorage.setItem(LS_LANG,lang)}catch(e){}
  if(save&&typeof ME!=='undefined'&&ME){try{await api('PUT','/api/auth/prefs',{lang})}catch(e){}}
  // Chosen before signing in: remember to save it to the account once signed in.
  else if(save){try{localStorage.setItem(LS_LANG+'_pick','1')}catch(e){}}
  if(lang!==I18N.lang)location.reload();
}
/** After sign-in: a language picked on the sign-in screen wins and is saved to the account;
    otherwise the account's saved language is used. Returns true when the page is about to reload. */
function syncAccountLang(user){
  let picked=false;try{picked=localStorage.getItem(LS_LANG+'_pick')==='1';localStorage.removeItem(LS_LANG+'_pick')}catch(e){}
  if(picked||!user.lang){if(user.lang!==I18N.lang)api('PUT','/api/auth/prefs',{lang:I18N.lang}).catch(()=>{});return false}
  if(user.lang!==I18N.lang){setLang(user.lang,{save:false});return true}
  return false;
}

/* ---------- matching ---------- */
const MONTHS_EN='Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const MONTHS_FR='janv\\.|févr\\.|mars|avr\\.|mai|juin|juil\\.|août|sept\\.|oct\\.|nov\\.|déc\\.|janvier|février|avril|juillet|septembre|octobre|novembre|décembre';
const TOKEN=new RegExp([
  // dates (with optional time): Sep 18, 2026 · Sep 18, 2026, 6:13 p.m. · 18 sept. 2026 · 18 sept. 2026, 18 h 13 · 2026-09-18
  `\\b(?:${MONTHS_EN})[a-z]*\\.? \\d{1,2}, \\d{4}(?:,? \\d{1,2}:\\d{2}(?:\\s?[ap]\\.?m\\.?)?)?`,
  `\\b\\d{1,2}(?:er)? (?:${MONTHS_FR}) \\d{4}(?:,? (?:à )?\\d{1,2} h \\d{2})?`,
  `\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  // amounts and numbers: $1,234.56 · (1,234.56) · 1 234,56 $ · -5 · 13% · 2.5
  `\\(?-?\\$?\\d+(?:[,.\\u00a0\\u202f]\\d+)*(?:[\\u00a0\\u202f ]?\\$)?\\)?%?`,
].join('|'),'g');
const norm=s=>s.replace(/[\s ]+/g,' ').trim();
/** English text → its lookup key and the tokens taken out of it. */
function keyOf(text){const toks=[];const key=norm(String(text).replace(TOKEN,m=>{toks.push(m);return `{${toks.length-1}}`}));return{key,toks}}
// In French, a percentage gets a comma and a space: 9.975% → 9,975 %.
const frTok=t=>/^\d+(?:\.\d+)?%$/.test(t)?t.slice(0,-1).replace('.',',')+'\u00a0%':t;
const fill=(s,toks)=>s.replace(/\{(\d+)\}/g,(m,i)=>toks[+i]===undefined?m:frTok(toks[+i]));
/** Translate one piece of text. Returns null when there's nothing to change. */
function tr(text){
  if(I18N.lang!=='fr'||!text||!/[A-Za-z]/.test(text))return null;
  const {key,toks}=keyOf(text);
  let out=I18N.dict[key];
  if(out!==undefined)return fill(out,toks);
  for(const [re,fr] of I18N.wild){
    const m=key.match(re);
    if(m){
      // Fill in numbers, then translate each captured part too (e.g. "Every 2 weeks" inside a longer line).
      // Numbers in a pattern are matched by position: {0} in the French means the pattern's first number.
      const parts={},nums=[];for(const [k,v] of Object.entries(m.groups||{})){if(v===undefined)continue;if(k[0]==='n'){nums[+k.slice(1)]=toks[+v];continue}const g=v.replace(/\{(\d+)\}/g,(x,i)=>toks[+i]??x);parts[k]=tr(g)??g}
      return fr.replace(/\{(\d+)\}/g,(x,i)=>nums[+i]===undefined?x:frTok(nums[+i])).replace(/\{s(\d?)\}/g,(x,i)=>parts['s'+(i||'0')]??'');
    }
  }
  return null;
}
/** For code that builds text itself (e.g. file names, window titles). */
const T=s=>tr(s)??s;

/** Add translations: { 'English': 'Français' }.
 *  Numbers and dates in the English are found automatically ("Paid 3 bills" = "Paid {0} bills").
 *  Write {0}, {1}… for numbers you want to place in the French; {s} (or {s1}, {s2}) matches any text. */
function addFr(entries){
  const PH=new RegExp('\\{(\\d+)\\}|\\{s(\\d?)\\}|'+TOKEN.source,'g');
  for(const [en,frRaw] of Object.entries(entries)){
    let i=0;const map={};
    const key=norm(en).replace(PH,(m,ph,sw)=>{if(ph!==undefined){map[ph]=i;return `{${i++}}`}if(sw!==undefined)return m;return `{${i++}}`});
    const fr=frRaw.replace(/\{(\d+)\}/g,(m,d)=>map[d]!==undefined?`{${map[d]}}`:m);
    if(/\{s\d?\}/.test(key)){
      const src=key.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&').replace(/\\\{s(\d?)\\\}/g,'{s$1}').replace(/\\\{(\d+)\\\}/g,(m,d)=>`\\{(?<n${d}>\\d+)\\}`).replace(/\{s(\d?)\}/g,(m,d)=>`(?<s${d||'0'}>.+?)`);
      I18N.wild.push([new RegExp('^'+src+'$'),fr]);
    }else I18N.dict[key]=fr;
  }
}

/* ---------- applying it to the page ---------- */
const SKIP_TAGS=new Set(['SCRIPT','STYLE','TEXTAREA','CODE','svg','SVG']);
const done=new WeakMap();
// translate="no" on the page itself only stops the browser's own translator; inside the page it marks data to leave alone.
function skip(el){for(let e=el;e&&e!==document.documentElement;e=e.parentElement){if(SKIP_TAGS.has(e.tagName)||e.getAttribute&&e.getAttribute('translate')==='no')return true}return false}
function translateText(node){
  if(done.get(node)===node.data)return;
  if(skip(node.parentElement))return;
  const raw=node.data;const lead=raw.match(/^\s*/)[0],trail=raw.match(/\s*$/)[0];
  const out=tr(raw);
  if(out!=null&&out!==norm(raw))node.data=lead+out+trail;
  done.set(node,node.data);
}
const ATTRS=['placeholder','title','aria-label','alt','data-label'];
function translateAttrs(el){
  if(skip(el))return;
  for(const a of ATTRS){const v=el.getAttribute(a);if(v){const out=tr(v);if(out!=null&&out!==v)el.setAttribute(a,out)}}
  if(el.tagName==='INPUT'&&(el.type==='button'||el.type==='submit')&&el.value){const out=tr(el.value);if(out!=null&&out!==el.value)el.value=out}
}
function translateTree(root){
  if(I18N.lang!=='fr'||!root)return;
  if(root.nodeType===3)return translateText(root);
  if(root.nodeType!==1&&root.nodeType!==11)return;
  if(root.nodeType===1){if(skip(root))return;translateAttrs(root)}
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);
  for(let n=w.nextNode();n;n=w.nextNode()){if(n.nodeType===3)translateText(n);else translateAttrs(n)}
}
if(I18N.lang==='fr'){
  document.documentElement.lang='fr-CA';
  new MutationObserver(ms=>{for(const m of ms){
    if(m.type==='characterData')translateText(m.target);
    else if(m.type==='attributes')translateAttrs(m.target);
    else m.addedNodes.forEach(translateTree);
  }}).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTRS});
  // Native confirm/alert/prompt boxes and the window title.
  const _t=Object.getOwnPropertyDescriptor(Document.prototype,'title');
  if(_t&&_t.set)Object.defineProperty(document,'title',{get(){return _t.get.call(document)},set(v){_t.set.call(document,T(v))}});
}
document.addEventListener('DOMContentLoaded',()=>{translateTree(document.body);document.title=document.title});

/* ---------- the switch ---------- */
const langSwitch=()=>`<div class="langsw" role="group" aria-label="Language / Langue" translate="no"><button type="button" data-lang="en" aria-pressed="${!isFr()}">English</button><button type="button" data-lang="fr" aria-pressed="${isFr()}">Français</button></div>`;
document.addEventListener('click',e=>{const b=e.target.closest('[data-lang]');if(b&&b.closest('.langsw')){e.preventDefault();setLang(b.dataset.lang)}});
