'use strict';
/* Light or dark screens: Automatic (follows the computer's setting), Light or Dark.
 * Loaded in <head> so the page never flashes the wrong colours. Saved in this browser and on the person's account. */
(function(){
  const KEY='tb_theme',MODES=['auto','light','dark'];
  const get=()=>{try{const m=localStorage.getItem(KEY);return MODES.includes(m)?m:'auto'}catch(e){return 'auto'}};
  const dark=m=>m==='dark'||(m!=='light'&&!!window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);
  function apply(m){
    const r=document.documentElement;
    if(m==='light'||m==='dark')r.setAttribute('data-theme',m);else r.removeAttribute('data-theme');
    const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute('content',dark(m)?'#151d1a':'#0d6a55');
    document.querySelectorAll('.themesw [data-theme-set]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.themeSet===m)));
  }
  function set(m,save){
    m=MODES.includes(m)?m:'auto';
    try{localStorage.setItem(KEY,m)}catch(e){}
    apply(m);
    // Follow the person to their other computers.
    if(save!==false&&typeof ME!=='undefined'&&ME&&typeof api==='function')api('PUT','/api/auth/prefs',{theme:m}).then(r=>{if(r&&r.user)ME.theme=r.user.theme}).catch(()=>{});
  }
  const html=()=>`<div class="langsw themesw" role="group" aria-label="Appearance">${[['auto','Automatic'],['light','Light'],['dark','Dark']].map(([k,l])=>`<button type="button" data-theme-set="${k}" aria-pressed="${get()===k}" title="${k==='auto'?'Follow this computer’s setting':''}">${l}</button>`).join('')}</div>`;
  apply(get());
  if(window.matchMedia){const q=matchMedia('(prefers-color-scheme: dark)');const f=()=>apply(get());q.addEventListener?q.addEventListener('change',f):q.addListener&&q.addListener(f)}
  document.addEventListener('click',e=>{const b=e.target.closest('[data-theme-set]');if(b&&b.closest('.themesw')){e.preventDefault();set(b.dataset.themeSet)}});
  window.TallyTheme={get,set,apply,html};
})();
