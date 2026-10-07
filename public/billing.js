'use strict';
/* ---------- Paying for Sumlora (online server) ----------
   Shown only when the server's administrator has set up subscriptions. A firm's owner starts the firm's
   subscription (per company, per month, after a free trial); a client whose company is marked "the client
   pays" starts one for that company. Payment happens on Stripe's own page; Sumlora never sees the card. */
let BILL=null;
const centsMoney=c=>`$${(c/100).toFixed(c%100?2:0)}`;
const planPrice=(b,plan)=>centsMoney((b.offer.amounts||{})[plan]||0);

/** After signing in: record a payment coming back from Stripe, then block until whatever must be paid for is. Returns true when it showed a payment screen. */
async function billingCheck(user){
  const q=new URLSearchParams(location.search);
  if(q.get('billing')){
    const session=q.get('session');history.replaceState(null,'',location.pathname+location.hash);
    if(session){try{const r=await api('POST','/api/billing/finish',{session});toast(r.state==='trialing'?'Your free trial has started':'Your subscription is running')}catch(e){toast(e.message,true)}}
  }
  try{BILL=await api('GET','/api/billing/me')}catch(e){BILL={configured:false};return false}
  if(!BILL.configured)return false;
  if(BILL.firm.needs){ME=user;billingLock({kind:'firm'});return true}
  const cos=BILL.companies||[];
  if(user.role==='client'&&cos.length&&cos.every(c=>c.needs)){ME=user;billingLock({kind:'company',id:cos[0].id});return true}
  return false;
}
/** Read again what this person pays for (the Users page and the account dialog use it). */
async function loadBillMe(){try{BILL=await api('GET','/api/billing/me')}catch(e){}}
/** A company or firm route answered "start the subscription first". */
async function billingLockFromError(j){
  try{BILL=await api('GET','/api/billing/me')}catch(e){return}
  if(!BILL.configured)return;
  billingLock(j.billing==='company'?{kind:'company',id:j.companyId}:{kind:'firm'});
}
function billingLock(o){
  document.body.classList.add('locked');closeModal();
  const b=BILL,f=b.firm;let html;
  if(o.kind==='firm'&&!f.canPay){
    html=lockCard('Your firm’s subscription needs attention',ME&&ME.role==='client'?'Your bookkeeper’s Sumlora subscription isn’t running at the moment. Ask them to sign in to Sumlora.':'Your firm’s Sumlora subscription isn’t running at the moment. Ask your firm’s owner to sign in and start it.','','','<button type="button" class="btn ghost block" data-lockout>Sign out</button>');
  }else if(o.kind==='firm'){
    const again=f.hadTrial,trial=!again&&b.offer.trialDays;
    html=lockCard(trial?`Start your ${b.offer.trialDays}-day free trial`:again&&f.state==='stopped'?'Your subscription has stopped':'Start your subscription',
      `${trial?`Sumlora is free for ${b.offer.trialDays} days. Your card is charged only after the trial, and you can cancel any time before then. `:''}You pay for each company your firm keeps, each month (companies whose client pays for themselves aren’t counted).`,`
      <div class="flabel">Choose a plan</div>
      ${Object.entries(b.plans).map(([k,p])=>`<label class="check" style="align-items:flex-start;padding:8px 10px;border:1px solid var(--line);border-radius:8px"><input type="radio" name="bpPlan" value="${k}" ${f.plan===k?'checked':''} style="margin-top:4px"> <span><b>${esc(T(p.label))}</b> · <span translate="no">${planPrice(b,k)}</span> <span>per company, per month</span><div class="muted" style="font-size:12.5px">${k==='plus'?'Everything in Essentials, plus payroll, AI suggestions, advanced reports and special sales tax methods.':'Bookkeeping, banking, invoices and bills, GST/HST and QST returns, and reports.'}</div></span></label>`).join('')}
      <div class="muted" style="font-size:12.5px"><span>Companies now:</span> <b>${f.companies}</b>. <span>Prices in Canadian dollars, plus applicable taxes. You’ll enter your card on Stripe’s secure page.</span></div>`,
      'Continue to payment','<button type="button" class="btn ghost block" data-lockout>Sign out</button>');
  }else{
    const c=(b.companies||[]).find(x=>x.id===o.id)||{name:'',plan:f.plan},trial=!c.hadTrial&&b.offer.trialDays;
    html=lockCard(trial?`Start your ${b.offer.trialDays}-day free trial`:'Start your subscription',
      `<span translate="no">${esc(c.name)}</span>: <span>${trial?`Sumlora is free for ${b.offer.trialDays} days. Your card is charged only after the trial, and you can cancel any time before then. `:''}Your bookkeeper keeps your books in Sumlora; this subscription lets you sign in and see them.</span>`,`
      <div><b>${esc(T(b.plans[c.plan||'plus'].label))}</b> · <span translate="no">${planPrice(b,c.plan||'plus')}</span> <span>a month</span></div>
      <div class="muted" style="font-size:12.5px">Prices in Canadian dollars, plus applicable taxes. You’ll enter your card on Stripe’s secure page.</div>`,
      'Continue to payment',`${(b.companies||[]).some(x=>!x.needs)?'<button type="button" class="btn ghost block" data-billnotnow>Not now</button>':''}<button type="button" class="btn ghost block" data-lockout>Sign out</button>`);
  }
  $('#lockRoot').innerHTML=html;
  const g=$('#lockRoot form'),err=m=>{$('[data-lockerr]',g).textContent=m||''};
  const lo=$('[data-lockout]',g);if(lo)lo.onclick=()=>signOut();
  const nn=$('[data-billnotnow]',g);if(nn)nn.onclick=()=>afterSignIn();
  g.onsubmit=async e=>{e.preventDefault();err('');const btn=g.querySelector('button[type=submit]');if(!btn)return;btn.disabled=true;
    try{const plan=(g.querySelector('input[name=bpPlan]:checked')||{}).value;
      const r=await api('POST','/api/billing/checkout',o.kind==='firm'?{kind:'firm',plan}:{kind:'company',id:o.id});
      location.href=r.url;
    }catch(ex){err(ex.message);btn.disabled=false}};
}

/** Your account → Subscription: what you pay for, and Stripe's page to change the card or cancel. */
function billingAccountHtml(){
  if(!BILL||!BILL.configured||!ME)return '';
  const rows=[];
  if(ME.role==='owner'&&!BILL.firm.exempt)rows.push({kind:'firm',id:'',name:ME.firmName||'Your firm',s:BILL.firm,qty:BILL.firm.companies});
  if(ME.role==='client')for(const c of BILL.companies||[])rows.push({kind:'company',id:c.id,name:c.name,s:c});
  if(!rows.length)return '';
  const st=s=>s.state==='trialing'?`<span class="pill paid">Free trial</span> <span class="muted">until ${fmtWhen(s.trialEnd)}</span>`:s.state==='active'?`<span class="pill paid">Active</span>${s.cancelAtEnd?` <span class="muted">ends ${fmtWhen(s.periodEnd)}</span>`:''}`:s.state==='pastdue'?`<span class="pill overdue">Payment failed</span> <span class="muted">update your card before ${fmtWhen(s.graceUntil)}</span>`:s.state==='stopped'?'<span class="pill overdue">Stopped</span>':'<span class="pill quiet">Not started</span>';
  return `<h3 class="fsec">Subscription</h3>${rows.map(r=>`<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><b translate="no">${esc(r.name)}</b> ${st(r.s)}${r.qty?` <span class="muted">· ${r.qty} ${r.qty===1?'company':'companies'}</span>`:''}${r.s.state&&r.s.state!=='none'?`<button type="button" class="btn sm" data-billportal="${r.kind}|${r.id}">Manage subscription</button>`:''}</div>`).join('')}
  <div class="muted" style="font-size:12.5px">Change your card, see your invoices or cancel on Stripe’s secure page.</div>`;
}
function bindBillingAccount(f){
  $$('[data-billportal]',f).forEach(b=>b.onclick=async()=>{const [kind,id]=b.dataset.billportal.split('|');b.disabled=true;
    try{const r=await api('POST','/api/billing/portal',{kind,id});location.href=r.url}catch(ex){f.err?f.err(ex.message):toast(ex.message,true);b.disabled=false}});
}

/* ---------- Firms page: the administrator's subscription settings ---------- */
let BILLADM=null;
async function loadBillingAdmin(){try{BILLADM=await api('GET','/api/billing')}catch(e){BILLADM=null}}
function billingAdminPanel(){
  const a=BILLADM;if(!a)return '';
  const amt=k=>((a.amounts||{})[k]||0)/100;
  return `<div class="panel" style="max-width:760px;margin-bottom:16px"><h3>Subscriptions (Stripe)</h3><div class="pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="muted" style="font-size:13px">Firms that use this server pay for each company they keep, each month, after a free trial. A client you mark as paying for their own company pays for that company. Your own firm doesn’t pay. Payments go to your Stripe account; Sumlora never sees card numbers. Turn on Stripe’s customer portal (Stripe → Settings → Billing → Customer portal) so people can change their card or cancel.</div>
    <div>${a.configured?`<span class="pill paid">On</span> Stripe key ${a.mode==='test'?'(test)':'(live)'} <span class="mono" translate="no">…${esc(a.ending)}</span>`:'<span class="pill quiet">Off</span> Nobody pays until you add a Stripe key.'}</div>
    <div class="fields">
      ${fld('bsKey',a.configured?'Replace Stripe key':'Stripe secret or restricted key',`<input type="password" id="bsKey" autocomplete="off" spellcheck="false" placeholder="${a.configured?'Leave blank to keep it':'sk_live_… or rk_live_…'}" translate="no"><span class="hint">Restricted key permissions: Products, Prices, Customers, Checkout Sessions, Subscriptions (write) and Customer portal (write). Kept on this server, never shown again.</span>`,true)}
      ${Object.entries(TallyPlans.PLANS).map(([k,p])=>fld('bsAmt'+k,`${T(p.label)}: price per company, per month (CAD)`,`<input type="number" id="bsAmt${k}" min="1" step="0.01" value="${amt(k)}">`)).join('')}
      ${Object.entries(TallyPlans.ADDONS).map(([k,p])=>fld('bsAmt'+k,`${p.label} add-on: price per company, per month (CAD)`,`<input type="number" id="bsAmt${k}" min="1" step="0.01" value="${amt(k)}"><span class="hint">Only for companies an owner adds it to, on either plan.</span>`)).join('')}
      ${fld('bsTrial','Free trial (days)',`<input type="number" id="bsTrial" min="0" max="60" step="1" value="${a.trialDays}"><span class="hint">Only the first time. 0 = no trial.</span>`)}
    </div>
    <div class="actions"><button class="btn primary" data-billsave>Save subscription settings</button>${a.configured?'<button class="btn ghost" data-billoff>Turn subscriptions off</button>':''}</div>
  </div></div>`;
}
async function billingAdminAction(b){
  try{
    if(b.hasAttribute('data-billsave')){
      const body={amounts:{},trialDays:+$('#bsTrial').value};for(const k of [...Object.keys(TallyPlans.PLANS),...Object.keys(TallyPlans.ADDONS)])body.amounts[k]=+$('#bsAmt'+k).value;
      const k=$('#bsKey').value.trim();if(k)body.key=k;
      BILLADM=await api('PUT','/api/billing',body);loadBillMe();renderMain();toast('Subscription settings saved');return true;
    }
    if(b.hasAttribute('data-billoff')){
      if(!await confirmBox('Turn subscriptions off?','Nobody is asked to pay, and every firm and client can use Sumlora. Subscriptions already running at Stripe keep charging until you cancel them in Stripe.','Turn off'))return true;
      BILLADM=await api('PUT','/api/billing',{key:''});loadBillMe();renderMain();toast('Subscriptions turned off');return true;
    }
  }catch(ex){toast(ex.message,true);return true}
  return false;
}
