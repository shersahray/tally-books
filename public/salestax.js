'use strict';
/* ---------- Sales tax: GST/HST and QST return worksheets, filing and payments ----------
 * The worksheet reads the tax account(s) for a period:
 *   sales (invoices, deposits)      -> tax collected       (GST/HST line 103, QST line 203)
 *   purchases (bills, expenses)     -> input tax credits   (line 106 / 206)
 *   journal entries                 -> adjustments         (104 and 107 / 204 and 207)
 *   sales tax payments (instalment) -> instalments paid    (110 / 210)
 * Filing a period saves a copy of its figures; paying or getting a refund posts a
 * "Sales tax payment" that clears the account.
 */
S.stax={tax:'gst',period:null,drill:'',manual:{}};

const TAX_LINES={
  gst:[
    ['90','Taxable sales made in Canada (including zero-rated supplies in Canada)','s90'],
    ['91','Exempt supplies, zero-rated exports and other sales and revenue','s91'],
    ['','Zero-rated exports (for example, US customers)','sExport','sub'],
    ['','Exempt supplies','sExempt','sub'],
    ['','Other revenue with no sales tax','sOther','sub'],
    ['101','Total sales and other revenue','=90+91'],
    ['103','GST/HST collected or collectible','collected'],
    ['104','Adjustments to be added to net tax','addAdj'],
    ['105','Total GST/HST and adjustments for period','=103+104'],
    ['106','GST/HST paid on qualifying expenses (input tax credits)','itc'],
    ['107','Adjustments to be deducted when determining net tax','dedAdj'],
    ['108','Total ITCs and adjustments','=106+107'],
    ['109','Net tax','=105-108'],
    ['110','Instalments and other annual filer payments made','instal'],
    ['111','Total GST/HST rebates','m:111'],
    ['112','Total other credits','=110+111'],
    ['113A','Balance','=109-112'],
    ['205','GST/HST due on real property or emission allowances','m:205'],
    ['405','Other GST/HST to be self-assessed','m:405'],
    ['113B','Total other debits','=205+405'],
    ['113C','Balance (positive: amount owing, negative: refund)','=113A+113B'],
  ],
  qst:[
    ['101','Total supplies (same as the GST/HST part)','sales'],
    ['203','QST collected or collectible','collected'],
    ['204','Adjustments to be added','addAdj'],
    ['205','Total QST and adjustments','=203+204'],
    ['206','Input tax refunds (ITRs)','itc'],
    ['207','Adjustments to be deducted','dedAdj'],
    ['208','Total ITRs and adjustments','=206+207'],
    ['209','Net tax','=205-208'],
    ['210','Instalments paid','instal'],
    ['211','Other credits and rebates','m:211'],
    ['213','Balance (positive: amount owing, negative: refund)','=209-210-211'],
  ],
  /* Provincial sales tax (BC, Saskatchewan) and retail sales tax (Manitoba). Lines are lettered here; the
     provinces' online returns ask for the same amounts. Nothing is claimed back on purchases. */
  pst:[
    ['A','Sales with PST charged (before tax)','sPst'],
    ['B','PST collected or collectible','collected'],
    ['C','Adjustments to be added','addAdj'],
    ['D','PST due on your own purchases and leases (self-assessed)','m:D'],
    ['E','Adjustments to be deducted','dedAdj'],
    ['F','Commission (as shown on the return)','m:F'],
    ['G','Balance (positive: amount owing, negative: refund)','=B+C+D-E-F'],
  ],
};
/* Quick Method: tax is remitted as a percentage of sales including the tax, instead of tax collected minus ITCs.
   Input tax credits are still claimed on capital purchases (accounts marked "Capital asset"). Lines starting with x are
   working lines, not on the return. */
const QM_LINES={
  gst:[
    ['90','Taxable sales made in Canada (including zero-rated supplies in Canada)','s90'],
    ['91','Exempt supplies, zero-rated exports and other sales and revenue','s91'],
    ['','Zero-rated exports (for example, US customers)','sExport','sub'],
    ['','Exempt supplies','sExempt','sub'],
    ['','Other revenue with no sales tax','sOther','sub'],
    ['101','Sales that qualify for the Quick Method, including GST/HST','qmBase'],
    ['103','GST/HST to remit (line 101 × the remittance rate)','qmTax'],
    ['104','Adjustments to be added to net tax (including tax on sales of capital assets)','addQ'],
    ['105','Total GST/HST and adjustments for period','=103+104'],
    ['106','Input tax credits on capital purchases','itcCap'],
    ['107','1% credit on the first $30,000, and other adjustments','ded107'],
    ['108','Total ITCs and adjustments','=106+107'],
    ['109','Net tax','=105-108'],
    ['110','Instalments and other annual filer payments made','instal'],
    ['111','Total GST/HST rebates','m:111'],
    ['112','Total other credits','=110+111'],
    ['113A','Balance','=109-112'],
    ['205','GST/HST due on real property or emission allowances','m:205'],
    ['405','Other GST/HST to be self-assessed','m:405'],
    ['113B','Total other debits','=205+405'],
    ['113C','Balance (positive: amount owing, negative: refund)','=113A+113B'],
  ],
  qst:[
    ['101','Total supplies (same as the GST/HST part)','sales'],
    ['x1','Sales that qualify for the Quick Method, including QST','qmBase'],
    ['203','QST to remit (sales that qualify × the remittance rate)','qmTax'],
    ['204','Adjustments to be added (including tax on sales of capital assets)','addQ'],
    ['205','Total QST and adjustments','=203+204'],
    ['206','Input tax refunds on capital purchases','itcCap'],
    ['207','1% reduction on the first $31,421, and other adjustments','ded107'],
    ['208','Total ITRs and adjustments','=206+207'],
    ['209','Net tax','=205-208'],
    ['210','Instalments paid','instal'],
    ['211','Other credits and rebates','m:211'],
    ['213','Balance (positive: amount owing, negative: refund)','=209-210-211'],
  ],
};
/* Remittance rates (CRA RC4058, Revenu Québec) for a business selling in its own province.
   GST/HST: by the tax rate charged (5% GST, 13% Ontario, 14% Nova Scotia from April 2025, 15% NB, NL, PEI). */
const QM_RATES={services:{5:3.6,13:8.8,14:9.4,15:10},goods:{5:1.8,13:4.4,14:4.7,15:5}};
const QM_QST={services:6.6,goods:3.4};
const QM_CREDIT_MAX={gst:30000,qst:31421}; // 1% credit on the first sales of the fiscal year, tax included
const QM_LIMIT=400000;
const qmCfg=()=>{const q=S.company.quickMethod;return q&&q.on?q:null};
const qmOn=(k,from)=>{const q=qmCfg();return !!q&&!!from&&from>=(q.from||'')};
const gstRateCharged=()=>S.company.province==='QC'||taxesInUse().length>1?5:+S.company.taxRate;
function qmSuggested(k,type){return k==='qst'?QM_QST[type]:(QM_RATES[type]||{})[gstRateCharged()]??null}
function qmRate(k){const q=qmCfg()||{};const own=k==='qst'?q.qstRate:q.gstRate;return own!==''&&own!=null&&!isNaN(+own)?+own:qmSuggested(k,q.type||'services')}
const isCapitalAcct=id=>{const a=acct(id);return !!a&&a.detail==='capital'};
/* Charities and non-profits.
   Registered charities use the net tax calculation (CRA RC4082, Revenu Québec): remit 60% of the tax charged (100% on
   sales of capital property), claim credits only on capital property, and claim the public service bodies' (PSB)
   rebate on the rest of the tax paid. Other non-profits use the regular method, with credits on the share of
   purchases used in taxable activities; qualifying non-profits (40% or more government funding) get the rebate too.
   PSB rebate for charities and qualifying non-profits (CRA RC4034, Revenu Québec): 50% of the GST or federal part of
   the HST; provincial part 82% Ontario, 50% New Brunswick, Newfoundland and Labrador, Nova Scotia and PEI; 50% of QST. */
const PSB_PROV={ON:82,NB:50,NL:50,NS:50,PE:50};
const npoCfg=()=>typeof isNpo==='function'&&isNpo()?{type:S.company.orgType,...(S.company.nonprofit||{})}:null;
const rebateEligible=()=>{const n=npoCfg();return !!n&&n.rebate!==false&&(n.type==='charity'||!!n.qualifying)};
const quickBarred=()=>{const n=npoCfg();return !!n&&(n.type==='charity'||!!n.qualifying)};
/** The sales tax rate an entry was charged at: its tax on this account over its taxed amounts, snapped to a real rate. */
function entryTaxRate(e,accId){
  const taxIds=taxAcctIds();
  const tax=(e.lines||[]).filter(l=>l.account===accId).reduce((t,l)=>t+(+l.debit||0)-(+l.credit||0),0);
  const cost=(e.lines||[]).filter(l=>!taxIds.has(l.account)&&!COST_SKIP.includes(acct(l.account)?.detail));
  const taxed=cost.filter(l=>['std','gst'].includes(l.taxCode||'std'));
  const net=(taxed.length?taxed:cost).reduce((t,l)=>t+(+l.debit||0)-(+l.credit||0),0);
  const r=Math.abs(net)>0.005?Math.abs(tax/net)*100:null,known=[5,13,14,15];
  const near=r==null?null:known.reduce((b,x)=>Math.abs(x-r)<Math.abs(b-r)?x:b,known[0]);
  return near!=null&&Math.abs(near-r)<0.6?near:gstRateCharged();
}
/** PSB rebate on tax paid, entry by entry so GST-only purchases and other provinces' HST split correctly.
    items: [{e, amt}] tax paid that isn't claimed as credits. provPct: the province's share (kept on a filed return). */
function psbRebate(k,items,accId,provPct){
  let total=0;
  for(const{e,amt}of items){
    if(Math.abs(amt)<0.005)continue;
    if(k==='qst'||S.company.province==='QC'){total+=amt*0.5;continue}
    const rate=entryTaxRate(e,accId);
    if(rate>5&&provPct!=null){const fed=amt*5/rate;total+=fed*0.5+(amt-fed)*provPct/100}
    else total+=amt*0.5;
  }
  return Math.max(0,r2(total)); // a rebate can't be negative; tax refunded by vendors just lowers it
}
/** How a period's return is worked out: as filed, or from the settings now. */
function methodFor(k,from,filed){
  if(filed)return filed.method||'regular';
  if(k==='pst')return 'regular'; // no Quick Method or charity rules for PST
  // The Quick Method and the charity/non-profit calculations are a plan feature (plans.js).
  if(typeof feat==='function'&&!feat('specialTax'))return 'regular';
  if(qmOn(k,from))return 'quick';
  const n=npoCfg();if(!n)return 'regular';
  return n.type==='charity'&&n.netTax!=='regular'?'charity':'npo';
}
const swapLines=(base,changes)=>base.map(r=>changes[r[0]]||r);
// The rebate is worked out; other rebates and credits are still typed in. Lines starting with x are working lines.
const withRebate=(lines,no,label)=>lines.flatMap(r=>r[0]!==no?[r]:[['x2','Public service bodies’ rebate','rebate'],['x3','Other rebates and credits','m:x3'],[no,label,'=x2+x3']]);
const CHARITY_LINES={
  gst:withRebate(swapLines(TAX_LINES.gst,{103:['103','GST/HST to remit: 60% of the tax charged, 100% on sales of capital property','ch103'],106:['106','Input tax credits on capital property','itcCh']}),'111','Total GST/HST rebates'),
  qst:withRebate(swapLines(TAX_LINES.qst,{203:['203','QST to remit: 60% of the tax charged, 100% on sales of capital property','ch103'],206:['206','Input tax refunds on capital property and immovables','itcCh']}),'211','Other credits and rebates'),
};
function npoLines(k,rebate){
  const l=swapLines(TAX_LINES[k],k==='qst'?{206:['206','Input tax refunds: the share used in taxable activities','itcNpo']}:{106:['106','Input tax credits: the share used in taxable activities','itcNpo']});
  return rebate?withRebate(l,k==='qst'?'211':'111',k==='qst'?'Other credits and rebates':'Total GST/HST rebates'):l;
}
function linesOf(k,method,rebate){return method==='quick'?QM_LINES[k]:method==='charity'?CHARITY_LINES[k]:method==='npo'?npoLines(k,rebate):TAX_LINES[k]}
const BAL_LINE={gst:'113C',qst:'213',pst:'G'};
const NET_LINE={gst:'109',qst:'209',pst:'G'};
const LIST_LINES={gst:['103','106'],qst:['203','206'],pst:['B','F']};
// In Quebec, Revenu Québec administers the GST as well as the QST for most businesses.
const PST_AGENCY={BC:'BC Ministry of Finance',SK:'Saskatchewan Ministry of Finance',MB:'Manitoba Finance'};
const AGENCY={get gst(){return S.company.province==='QC'?'Revenu Québec':'CRA'},qst:'Revenu Québec',get pst(){return PST_AGENCY[S.company.province]||'the province'}};
const PST_ONLINE={BC:'eTaxBC',SK:'Saskatchewan Taxpayer Access Point',MB:'Manitoba TAXcess'};
const SALE_TYPES=new Set(['invoice','deposit','payment','credit']),BUY_TYPES=new Set(['bill','expense','billpayment','vcredit']);

const taxesInUse=()=>byDetail('qst')&&+S.company.qstRate>0?['gst','qst']:byDetail('pst')&&+S.company.pstRate>0?['gst','pst']:['gst'];
const pstName=()=>S.company.pstName||'PST';
const taxLabel=k=>k==='qst'?'QST':k==='pst'?pstName():(taxesInUse().length>1?'GST':(S.company.taxName||'GST/HST'));
const returnName=k=>k==='qst'?'QST return':k==='pst'?`${pstName()} return`:'GST/HST return';
const taxAcctFor=k=>k==='qst'?byDetail('qst'):k==='pst'?byDetail('pst'):byDetail('tax');
const taxAcctIds=()=>new Set(S.accounts.filter(a=>a.detail==='tax'||a.detail==='qst'||a.detail==='pst').map(a=>a.id));
// Line labels name the province's tax (RST in Manitoba).
const lineLabel=(k,label)=>k==='pst'?label.replace(/\bPST\b/g,pstName()):label;

/* ---------- periods ---------- */
function filingPeriods(k){
  const freq=k==='pst'?S.company.pstFreq:S.company.filingFreq;
  const step={monthly:1,quarterly:3,semiannual:6,annual:12}[freq||'quarterly']||3;
  const mb=k==='pst'&&['MB','SK'].includes(S.company.province); // Manitoba RST and Saskatchewan PST are due on the 20th of the next month
  const ids=taxAcctIds();
  let first=today();
  // Opening balances brought over from other software aren't sales tax activity in Sumlora.
  for(const e of S.entries)if(!e.opening&&e.date<first&&(e.lines||[]).some(l=>ids.has(l.account)))first=e.date;
  for(const f of S.filings)if(f.from<first)first=f.from;
  const out=[];let d=pd(fyStartOf(first));const end=pd(today());
  while(d<=end&&out.length<400){
    const to=new Date(d.getFullYear(),d.getMonth()+step,0);
    const due=mb?new Date(to.getFullYear(),to.getMonth()+1,20):k==='pst'?new Date(to.getFullYear(),to.getMonth()+2,0):new Date(to.getFullYear(),to.getMonth()+(step===12?4:2),0); // 1 month after (3 for annual GST/HST filers)
    if(iso(to)>=first)out.push({from:iso(d),to:iso(to),due:iso(due)}); // skip periods before the first activity
    d=new Date(d.getFullYear(),d.getMonth()+step,1);
  }
  return out.reverse();
}
const filingFor=(k,from,to)=>S.filings.find(f=>f.tax===k&&f.from===from&&f.to===to);
const filedPeriodOn=(date,k)=>S.filings.find(f=>(!k||f.tax===k)&&f.from<=date&&date<=f.to);

/* ---------- worksheet ---------- */
/* What the books say for one tax and period. Kept until the books change, since the Quick Method's 1% credit
   needs the earlier periods of the fiscal year and the Sales tax page shows many periods at once. */
const scanCache={stamp:'',map:new Map()};
const COST_SKIP=['bank','ar','ap','card'];
function scan(k,from,to){
  const key=`${k}|${from}|${to}`;
  const stamp=`${typeof CO!=='undefined'?CO:''}|${S.rev}|${S.entries.length}|${S.accounts.length}`;
  if(scanCache.stamp!==stamp){scanCache.stamp=stamp;scanCache.map.clear()}
  if(scanCache.map.has(key))return scanCache.map.get(key);
  const a=taxAcctFor(k);
  const keys=['collected','addAdj','itc','dedAdj','instal','sales','s90','s91','sExport','sExempt','sOther','sStd','sPst','itcCap','itcOps','capSaleTax','other'];
  const v={},src={};for(const x of keys){v[x]=0;src[x]=[]}
  const push=(key,e,amt)=>{if(!amt)return;v[key]+=amt;src[key].push({e,amt})};
  const income=new Set(S.accounts.filter(x=>x.type==='Income').map(x=>x.id)),taxIds=taxAcctIds();
  /* The share of an entry's taxed amount that's for capital assets: lines that aren't tax, money or receivables,
     weighted by their net amount on the side given (1 = debits, -1 = credits) and by the taxed lines only. */
  const capShare=(e,side,legacy)=>{
    const lines=(e.lines||[]).filter(x=>!taxIds.has(x.account)&&!COST_SKIP.includes(acct(x.account)?.detail));
    const amt=x=>side*((+x.debit||0)-(+x.credit||0));
    const taxed=lines.filter(x=>['std','gst'].includes(x.taxCode||legacy));
    const use=taxed.length?taxed:lines;
    const all=use.reduce((t,x)=>t+amt(x),0),cap=use.filter(x=>isCapitalAcct(x.account)).reduce((t,x)=>t+amt(x),0);
    if(Math.abs(all)<0.005)return lines.some(x=>isCapitalAcct(x.account))?1:0;
    return Math.max(0,Math.min(1,cap/all));
  };
  if(a)for(const e of S.entries){
    if(e.date<from||e.date>to||e.opening||e.type==='qmadjust')continue;
    let inc=0;const byCode={};
    // Older transactions have no tax code on their lines: taxed if the transaction charged sales tax.
    const legacy=(e.lines||[]).some(l=>taxIds.has(l.account)&&(+l.credit||0)>0)?'std':'none';
    const legacyBuy=(e.lines||[]).some(l=>taxIds.has(l.account)&&(+l.debit||0)>0)?'std':'none';
    for(const l of e.lines||[]){
      const dr=+l.debit||0,cr=+l.credit||0;
      if(income.has(l.account)){inc+=cr-dr;const code=l.taxCode||legacy;byCode[code]=(byCode[code]||0)+cr-dr}
      if(l.account!==a.id)continue;
      if(e.type==='taxpayment'){if(e.taxKind==='instalment'&&e.tax===k)push('instal',e,dr);continue}
      if(e.type==='journal'){push('addAdj',e,cr);push('dedAdj',e,dr)}
      else if(SALE_TYPES.has(e.type)){push('collected',e,cr-dr);
        // Selling a capital asset: under the Quick Method its tax is remitted in full, not at the remittance rate.
        push('capSaleTax',e,r2((cr-dr)*capShare(e,-1,legacy)))}
      else if(BUY_TYPES.has(e.type)){push('itc',e,dr-cr);
        // Quick Method: credits are kept only for the share of the purchase that's a capital asset (vendor credits too).
        const capPart=r2((dr-cr)*capShare(e,1,legacyBuy));push('itcCap',e,capPart);push('itcOps',e,r2(dr-cr-capPart))}
      else{push('collected',e,cr);push('itc',e,dr);push('other',e,dr)}
    }
    if(inc)push('sales',e,inc);
    for(const[code,amt]of Object.entries(byCode)){
      if(!amt)continue;
      // "gst": GST only (no PST), taxable for the GST return.
      if(code==='std'||code==='gst'||code==='zero'){push('s90',e,amt);if(code!=='zero')push('sStd',e,amt);if(code==='std')push('sPst',e,amt)}
      else{push('s91',e,amt);push(code==='export'?'sExport':code==='exempt'?'sExempt':'sOther',e,amt)}
    }
  }
  for(const x of keys)v[x]=r2(v[x]);
  const out={v,src,qmBase:r2(v.sStd+v.collected-v.capSaleTax)};
  scanCache.map.set(key,out);return out;
}
/** Quick Method sales (line 101 / the QST base) earlier in the fiscal year, for the 1% credit. */
function qmUsedBefore(k,from){
  const cfg=qmCfg();if(!cfg)return 0;
  const fy=fyStartOf(from),start=fy>cfg.from?fy:cfg.from;let used=0;
  for(const p of filingPeriods(k)){
    if(p.from<start||p.to>=from)continue;
    const f=filingFor(k,p.from,p.to);
    if(f)used+=f.method==='quick'?(+f.lines[k==='qst'?'x1':'101']||0):0; // a return filed the regular way used no credit
    else if(qmOn(k,p.from))used+=scan(k,p.from,p.to).qmBase;
  }
  return r2(used);
}
function worksheet(k,from,to){
  const a=taxAcctFor(k);if(!a)return null;
  const filed=filingFor(k,from,to);
  // A filed return keeps the method it was filed with, whatever the settings say now.
  const method=methodFor(k,from,filed),qm=method==='quick';
  const {v:base,src}=scan(k,from,to),v={...base};
  let quick=null,special=null,rebateOn=false;
  if(method==='charity'||method==='npo'){
    const n=npoCfg()||{};
    rebateOn=filed?!!filed.rebate:rebateEligible();
    // Credits on capital property only when it's used mainly (more than 50%) in taxable activities; otherwise the rebate applies.
    const capComm=filed&&filed.capComm!=null?filed.capComm:n.capitalItc!==false;
    const provPct=filed&&filed.psbProv!==undefined?filed.psbProv:PSB_PROV[S.company.province];
    const capItems=capComm?[]:src.itcCap,capAmt=capComm?0:v.itcCap;
    if(method==='charity'){
      v.ch103=r2(0.6*(v.collected-v.capSaleTax)+v.capSaleTax);src.ch103=src.collected;
      v.itcCh=capComm?v.itcCap:0;src.itcCh=capComm?src.itcCap:[];
      const items=[...src.itcOps,...src.other,...capItems],paid=r2(v.itcOps+v.other+capAmt);
      const rebate=rebateOn?psbRebate(k,items,a.id,provPct):0;v.rebate=rebate;
      special={kind:'charity',collected:v.collected,capSaleTax:v.capSaleTax,tax:v.ch103,gain:r2(v.collected-v.ch103),paid,rebate,itcCap:v.itcCh,ops:r2(paid-rebate),capComm,provPct};
    }else{
      const pct=filed&&filed.itcPct!=null?filed.itcPct:(n.itcPct===''||n.itcPct==null?100:+n.itcPct);
      const opsItc=r2(v.itc-v.itcCap);
      v.itcNpo=r2(opsItc*pct/100+(capComm?v.itcCap:0));src.itcNpo=src.itc;
      const items=[...[...src.itcOps,...src.other].map(x=>({e:x.e,amt:x.amt*(100-pct)/100})),...capItems];
      const paid=r2(v.itc-v.itcNpo),rebate=rebateOn?psbRebate(k,items,a.id,provPct):0;v.rebate=rebate;
      special={kind:'npo',pct,itc:v.itc,itcNpo:v.itcNpo,paid,rebate,gain:0,ops:r2(paid-rebate),capComm,provPct};
    }
    // Tax put on the account by journal entries goes on lines 104 and 107 in full: the special rules can't see what it was for.
    special.journals=r2(v.addAdj+v.dedAdj);
  }
  if(qm){
    const cfg=qmCfg()||{},rate=filed&&filed.qmRate!=null?filed.qmRate:qmRate(k);
    v.qmBase=r2(v.sStd+v.collected-v.capSaleTax);src.qmBase=[...src.sStd,...src.collected];
    const tax=rate==null?0:r2(v.qmBase*rate/100);
    const used=cfg.credit===false?0:qmUsedBefore(k,from);
    const credit=cfg.credit===false?0:r2(0.01*Math.max(0,Math.min(v.qmBase,QM_CREDIT_MAX[k]-used)));
    v.qmTax=tax;v.ded107=r2(credit+v.dedAdj);src.ded107=src.dedAdj;
    v.addQ=r2(v.addAdj+v.capSaleTax);src.addQ=[...src.addAdj,...src.capSaleTax];
    // Tax on everyday expenses isn't claimed: it, and any other debit to the account, becomes an expense.
    const ops=r2(v.itcOps+v.other);
    quick={rate,credit,used,collected:v.collected,capSaleTax:v.capSaleTax,tax,gain:r2(v.collected-v.capSaleTax-tax+credit),itcOps:ops,itcCap:v.itcCap};
  }
  const man=filed?filed.lines:(S.stax.manual[k+from]||{});
  const vals={};
  const lines=linesOf(k,method,rebateOn);
  for(const[no,,how,sub]of lines){
    if(sub){vals['·'+how]=r2(v[how]);continue}
    if(how.startsWith('m:'))vals[no]=r2(+man[no]||0);
    else if(how.startsWith('=')){const parts=how.slice(1).split(/(?=[+-])/);vals[no]=r2(parts.reduce((s,p)=>{const sign=p[0]==='-'?-1:1;return s+sign*vals[p.replace(/^[+-]/,'')]},0))}
    else vals[no]=r2(v[how]);
  }
  const fv=filed?filed.lines:vals;
  const pst=k==='pst'?{self:r2(+fv.D||0),commission:r2(+fv.F||0)}:null;
  return{account:a,vals:fv,live:vals,src,filed,quick,special,method,lines,rebate:rebateOn,pst};
}
function periodStatus(k,p){
  const f=filingFor(k,p.from,p.to);
  if(f)return{k:'paid',label:`Filed ${fmtDate(f.filedOn)}`};
  const t=today();
  if(p.to>=t)return{k:'quiet',label:'In progress'};
  if(p.due<t)return{k:'overdue',label:'Overdue'};
  if(daysBetween(t,p.due)<=14)return{k:'partial',label:`Due ${fmtDate(p.due)}`};
  return{k:'open',label:'Ready to file'};
}
function overdueReturns(){let n=0;for(const k of taxesInUse())for(const p of filingPeriods(k))if(periodStatus(k,p).k==='overdue'){const w=worksheet(k,p.from,p.to);if(w&&Object.values(w.live).some(x=>x))n++}return n}

/* ---------- views ---------- */
function vSalesTax(){
  const T=S.stax,taxes=taxesInUse();if(!taxes.includes(T.tax))T.tax='gst';
  const freq={monthly:'monthly',quarterly:'quarterly',semiannual:'every six months',annual:'annual'}[(T.tax==='pst'?S.company.pstFreq:S.company.filingFreq)||'quarterly'];
  const q=qmCfg();
  let h=head('Sales tax',`Files ${freq}${q?` · <span>Quick Method from ${fmtDate(q.from)}</span>`:''}${S.company.bn?` · BN ${esc(S.company.bn)}`:''} · <button class="link" data-go="settings">Change in Settings</button>`,
    `${feat('specialTax')?'<button class="btn" data-stact="quick">Quick Method</button>':''}<button class="btn" data-stact="instalment">Record instalment</button>`);
  if(q){const big=qmOverLimit();if(big)h+=`<div class="banner err"><span>Sales including tax were ${money(big.total)} in the 12 months to ${fmtDate(big.to)}, over the $400,000 limit for the Quick Method. Check whether you can still use it.</span></div>`}
  if(S.company.province==='QC'&&!byDetail('qst'))h+=`<div class="banner"><span><b>Track GST and QST separately?</b> This Quebec company records both taxes in one account. Split them to get a separate QST return worksheet.</span><button class="btn sm" data-stact="split-qst">Set up QST account</button></div>`;
  if(PST_AGENCY[S.company.province]&&!(+S.company.pstRate>0))h+=`<div class="banner"><span><b>Registered for ${S.company.province==='MB'?'RST':'PST'}?</b> Turn it on in Settings to charge it on invoices separately from GST and get its own return worksheet.</span><button class="btn sm" data-go="settings">Settings</button></div>`;
  if(!taxAcctFor('gst'))return h+`<div class="panel"><div class="empty"><b>No sales tax account</b>Add a Liability account with the detail “Sales tax payable” in Chart of accounts.</div></div>`;
  if(taxes.length>1)h+=`<div class="tabs" role="tablist">${taxes.map(k=>`<button role="tab" data-sttax="${k}" aria-selected="${T.tax===k}">${k==='qst'?'QST (Revenu Québec)':k==='pst'?`${esc(pstName())} (${AGENCY.pst})`:`GST (${AGENCY.gst})`}</button>`).join('')}</div>`;
  if(T.period){const[from,to]=T.period.split('|');return h+vWorksheet(T.tax,from,to)}
  const k=T.tax,periods=filingPeriods(k);
  const bal=r2(-rawBal(taxAcctFor(k).id));
  h+=`<div class="chips"><div class="chip"><div class="lbl">${esc(taxLabel(k))} account balance today</div><div class="val">${mcell(bal)}</div><div class="lbl">${bal>=0?`Owing to ${AGENCY[k]} if positive`:`Refund due from ${AGENCY[k]}`}</div></div>
    <div class="chip"><div class="lbl">Returns overdue</div><div class="val ${overdueReturns()?'neg':''}">${overdueReturns()}</div></div></div>`;
  return h+`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Period</th><th>Due</th><th class="n">${k!=='pst'&&(qmCfg()||npoCfg())?'Collected or to remit':'Collected'}</th><th class="n">${k==='pst'?'Commission':qmCfg()||npoCfg()?'Credits (ITCs) claimed':'Credits (ITCs)'}</th><th class="n">${k==='pst'?'Balance':'Net tax'}</th><th>Status</th><th></th></tr></thead><tbody>${periods.length?periods.map(p=>{
    const w=worksheet(k,p.from,p.to),st=periodStatus(k,p),net=w.vals[NET_LINE[k]];
    const ln=LIST_LINES[k];
    return `<tr class="click" data-stperiod="${p.from}|${p.to}"><td style="white-space:nowrap"><b>${fmtDate(p.from)} – ${fmtDate(p.to)}</b></td><td style="white-space:nowrap" class="${st.k==='overdue'?'neg':'muted'}">${fmtDate(p.due)}</td><td class="n">${money(w.vals[ln[0]])}</td><td class="n">${money(w.vals[ln[1]])}</td><td class="n"><b>${mcell(net)}</b></td><td><span class="pill ${st.k}">${st.label}</span></td><td class="n"><button class="btn sm" data-stperiod="${p.from}|${p.to}">${w.filed?'View':'Open worksheet'}</button></td></tr>`}).join(''):emptyRow(7,'No periods yet','Periods appear once there are transactions with sales tax.')}</tbody></table></div></div>
    <div class="muted" style="font-size:13px;margin-top:12px">${k==='pst'?`<span>Periods follow your fiscal year-end and ${esc(pstName())} filing frequency. A return is due ${['MB','SK'].includes(S.company.province)?'on the 20th of the month':'by the end of the month'} after the period ends.</span> <span>These figures help you file; submit the return on ${PST_ONLINE[S.company.province]||'the province’s website'}.</span>`:`Periods follow your fiscal year-end and filing frequency. A return is due one month after the period ends (three months for annual filers). These figures help you file; submit the return on ${k==='qst'||AGENCY.gst!=='CRA'?'Revenu Québec’s My Account for businesses':'CRA My Business Account or GST/HST NETFILE'}.`}</div>`;
}

function vWorksheet(k,from,to){
  const w=worksheet(k,from,to),T=S.stax,bl=BAL_LINE[k],bal=w.vals[bl];
  const filed=w.filed,st=periodStatus(k,filingPeriods(k).find(p=>p.from===from)||{from,to,due:to});
  const LINES=w.lines;
  const changed=filed&&LINES.some(([no,,how,sub])=>!sub&&!how.startsWith('m:')&&no in filed.lines&&Math.abs((w.live[no]||0)-(filed.lines[no]||0))>0.004);
  const drillable={sPst:1,sales:1,collected:1,addAdj:1,itc:1,dedAdj:1,instal:1,s90:1,s91:1,sExport:1,sExempt:1,sOther:1,qmBase:1,itcCap:1,addQ:1,ch103:1,itcNpo:1,itcCh:1};
  let rows='';
  for(const[no,label0,how,sub]of LINES){
    const label=lineLabel(k,label0);
    if(sub){const val=w.vals['·'+how]||0;if(!val&&how!=='sExport')continue;
      rows+=`<tr class="subline"><td></td><td>${label}</td><td class="n">${val?`<button class="link" data-stdrill="${how}">${money(val)}</button>`:`<span class="muted">${money(0)}</span>`}</td></tr>`;
      if(T.drill===how)rows+=`<tr><td></td><td colspan="2">${drillTable(w.src[how])}</td></tr>`;continue}
    const total=how.startsWith('=')||no===bl,val=w.vals[no];
    let cell;
    if(how.startsWith('m:')&&!filed)cell=`<input type="number" step="0.01" data-stman="${no}" value="${val||''}" placeholder="0.00" style="width:130px" aria-label="${no.startsWith('x')?esc(label):'Line '+no}">`;
    else if(drillable[how]&&val)cell=`<button class="link" data-stdrill="${how}">${money(val)}</button>`;
    else cell=mcell(val);
    rows+=`<tr class="${no===bl?'grand':total?'tot':'item'}"><td class="mono" style="width:60px">${no.startsWith('x')?'':no}</td><td>${label}</td><td class="n">${cell}</td></tr>`;
    if(T.drill===how&&drillable[how])rows+=`<tr><td></td><td colspan="2">${drillTable(w.src[how])}</td></tr>`;
  }
  const outcome=bal>0.004?`Amount owing to ${AGENCY[k]}: <b>${money(bal)}</b> (line ${k==='gst'?'115':bl})`:bal<-0.004?`Refund claimed from ${AGENCY[k]}: <b>${money(-bal)}</b> (line ${k==='gst'?'114':bl})`:'Nothing owing and no refund';
  const pay=filed&&filed.entryId?S.entries.find(e=>e.id===filed.entryId):null;
  return `<button class="btn ghost sm" data-stback style="margin-bottom:8px">← All periods</button>
  <div class="panel report" style="max-width:820px">
    ${rh(`${returnName(k)} worksheet`,`${fmtDate(from)} – ${fmtDate(to)}${S.company.bn?` · BN ${esc(S.company.bn)}`:''}`)}
    <div class="pad" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center"><span class="pill ${st.k}">${st.label}</span>${pay?`<span class="muted">${pay.taxKind==='refund'?'Refund received':'Paid'} ${fmtDate(pay.date)} · ${money(entryTotal(pay))}</span>`:''}</div>
    ${changed?`<div class="banner err" style="margin:0 16px 12px"><span>Transactions in this period changed after it was filed. The figures below are what you filed; the books now show ${k==='pst'?'a balance':'net tax'} of ${money(w.live[NET_LINE[k]])}. You may need to file an amended return.</span></div>`:''}
    <div class="tbl-wrap"><table class="ws">${rows}</table></div>
    <div class="pad" style="text-align:center">${outcome}</div>
    ${k==='pst'?pstBox(w,filed):w.quick?qmBox(k,w,filed):w.special&&(w.special.kind==='charity'||w.special.paid||w.special.rebate)?npoBox(k,w,filed):''}
    <div class="toolbar" style="border-top:1px solid var(--line);border-bottom:0;justify-content:flex-end">
      <button class="btn sm" data-stact="export">Export CSV</button>
      ${filed?`${!filed.entryId&&Math.abs(filed.lines[bl])>0.004?`<button class="btn sm" data-stact="pay-later">Record ${filed.lines[bl]>0?'payment':'refund'}</button>`:''}<button class="btn sm danger" data-stact="unfile">Undo filing</button>`
        :to>=today()?`<span class="muted" style="font-size:13px">You can file once the period ends on ${fmtDate(to)}.</span>`
        :`<button class="btn sm primary" data-stact="file">Mark as filed${Math.abs(bal)>0.004?` and record ${bal>0?'payment':'refund'}`:''}</button>`}
    </div>
  </div>
  ${k==='qst'?'<div class="muted" style="font-size:13px;margin-top:10px">QST line numbers follow Revenu Québec’s FPZ-500 return. Check them against the current form before filing.</div>':''}
  ${k==='pst'?`<div class="muted" style="font-size:13px;margin-top:10px">The letters are Sumlora’s; ${PST_ONLINE[S.company.province]||'the province’s online return'} asks for the same amounts under its own names.</div>`:''}`;
}
function drillTable(items){
  if(!items.length)return '';
  const tot=r2(items.reduce((s,x)=>s+x.amt,0));
  return `<div class="tbl-wrap" style="border:1px solid var(--line);border-radius:6px;margin:4px 0 10px"><table><tbody>${items.sort((a,b)=>a.e.date.localeCompare(b.e.date)).map(({e,amt})=>`<tr class="click" data-entry="${e.id}"><td style="white-space:nowrap">${fmtDate(e.date)}</td><td>${TLABEL[e.type]||e.type}${e.ref?` <span class="mono muted">#${esc(e.ref)}</span>`:''}</td><td class="trunc">${esc(contactName(e.contactId)||e.memo||'')}</td><td class="n">${mcell(amt)}</td></tr>`).join('')}<tr><td colspan="3" class="muted">${items.length} transaction${items.length===1?'':'s'}</td><td class="n"><b>${money(tot)}</b></td></tr></tbody></table></div>`;
}

/* ---------- actions ---------- */
async function stClick(ev,t,d){
  const T=S.stax;
  if(d.sttax){T.tax=d.sttax;T.drill='';renderMain();return true}
  if(d.stperiod){ev.stopPropagation();T.period=d.stperiod;T.drill='';renderMain();window.scrollTo(0,0);return true}
  if(t.hasAttribute('data-stback')){T.period=null;T.drill='';renderMain();return true}
  if(d.stdrill){T.drill=T.drill===d.stdrill?'':d.stdrill;renderMain();return true}
  const[from,to]=(T.period||'|').split('|');
  switch(d.stact){
    case 'instalment':instalmentForm();return true;
    case 'split-qst':await splitQst();return true;
    case 'file':fileForm(T.tax,from,to,true);return true;
    case 'pay-later':fileForm(T.tax,from,to,false);return true;
    case 'unfile':await unfile(T.tax,from,to);return true;
    case 'quick':if(feat('specialTax'))quickForm();return true;
    case 'export':{const w=worksheet(T.tax,from,to);const rows=[['Line','Description','Amount'],...w.lines.map(([no,label,how,sub])=>sub?['',`  of line 91: ${label}`,w.vals['·'+how]||0]:[no.startsWith('x')?'':no,lineLabel(T.tax,label),w.vals[no]])];
      saveFile(`${T.tax==='qst'?'qst':T.tax==='pst'?pstName().toLowerCase():'gst-hst'}-return_${from}_${to}.csv`,new Blob(['﻿'+rows.map(r=>r.map(v=>/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:v).join(',')).join('\r\n')],{type:'text/csv'}));return true}
  }
  return false;
}
function bindSalesTax(m){
  $$('[data-stman]',m).forEach(inp=>inp.onchange=()=>{const T=S.stax,[from]=T.period.split('|'),key=T.tax+from;T.manual[key]={...(T.manual[key]||{}),[inp.dataset.stman]:+inp.value||0};renderMain()});
}

function payEntry(k,kind,amount,bank,date,from,to){
  const a=taxAcctFor(k);
  const lines=kind==='refund'?[{account:bank,debit:amount,credit:0},{account:a.id,debit:0,credit:amount}]:[{account:a.id,debit:amount,credit:0},{account:bank,debit:0,credit:amount}];
  const what=kind==='instalment'?'instalment':kind==='refund'?'refund':'payment';
  return{type:'taxpayment',tax:k,taxKind:kind,period:from?{from,to}:null,date,ref:'',memo:`${taxLabel(k)} ${what}${from?` for ${fmtDate(from)} – ${fmtDate(to)}`:''}`,contactId:'',lines,created:Date.now()};
}
function fileForm(k,from,to,filing){
  const w=worksheet(k,from,to),bl=BAL_LINE[k],bal=filing?w.vals[bl]:w.filed.lines[bl],kind=bal<0?'refund':'payment';
  const banks=sortAccts(S.accounts.filter(a=>a.detail==='bank'&&a.active!==false));
  const needMoney=Math.abs(bal)>0.004;
  const f=openModal(filing?`File ${returnName(k)}`:`Record ${kind}`,`
    <div class="muted">${fmtDate(from)} – ${fmtDate(to)} · ${needMoney?(kind==='refund'?`refund of <b>${money(-bal)}</b> from ${AGENCY[k]}`:`<b>${money(bal)}</b> owing to ${AGENCY[k]}`):'nothing owing'}</div>
    <div class="fields">
      ${filing?fld('fOn','Date filed',`<input type="date" id="fOn" value="${today()}">`):''}
      ${needMoney?fld('fBank',kind==='refund'?'Deposited to':'Paid from',`<select id="fBank">${banks.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>`):''}
      ${needMoney?fld('fDate',kind==='refund'?'Date received':'Payment date',`<input type="date" id="fDate" value="${today()}">`):''}
      ${needMoney?fld('fAmt','Amount',`<input type="number" id="fAmt" step="0.01" value="${Math.abs(bal).toFixed(2)}">`):''}
    </div>
    ${needMoney&&filing?`<label class="check"><input type="checkbox" id="fNow" ${kind==='payment'?'checked':''}> Record the ${kind} now ${kind==='refund'?'(leave unticked until the refund arrives)':''}</label>`:''}
    ${filing&&w.special&&(w.special.gain||w.special.ops)?`<div class="muted" style="font-size:13px">${w.special.gain?`Filing also posts an adjustment on ${fmtDate(to)}: ${money(w.special.gain)} of the tax charged becomes income, and ${money(w.special.ops)} of tax paid that isn’t recovered becomes an expense.`:`Filing also posts an adjustment on ${fmtDate(to)}: ${money(w.special.ops)} of tax paid that isn’t recovered becomes an expense.`}</div>`:''}
    ${filing&&w.pst&&(w.pst.self||w.pst.commission)?`<div class="muted" style="font-size:13px">Filing also posts an adjustment on ${fmtDate(to)}:${w.pst.self?` ${money(w.pst.self)} of ${esc(pstName())} self-assessed on purchases becomes an expense.`:''}${w.pst.commission?` ${money(w.pst.commission)} of commission becomes income.`:''}</div>`:''}
    ${filing&&w.quick&&(w.quick.gain||w.quick.itcOps)?`<div class="muted" style="font-size:13px">Under the Quick Method, filing also posts an adjustment on ${fmtDate(to)}: ${money(w.quick.gain)} of the tax charged to customers becomes income, and ${money(w.quick.itcOps)} of tax paid on expenses becomes part of the expenses.</div>`:''}
    <div class="muted" style="font-size:13px">${filing?'Filing saves a copy of these figures. If transactions in this period change later, the worksheet warns you.':''} The ${kind} is recorded as a sales tax payment that clears the ${esc(taxAcctFor(k).name)} account.</div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${filing?'Mark as filed':'Record '+kind}</button>`);
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const writes=[];let entryId=w.filed?.entryId||'';
    const now=needMoney&&(!filing||$('#fNow',f).checked);
    if(now){
      if(!banks.length)return f.err('Add a bank account first.');
      const amt=r2($('#fAmt',f).value);if(!(amt>0))return f.err('Enter the amount.');
      entryId=uid();writes.push({op:'set',collection:'entries',id:entryId,data:payEntry(k,kind,amt,$('#fBank',f).value,$('#fDate',f).value||today(),from,to)});
    }
    let qmEntryId='';
    if(filing&&w.quick&&w.quick.rate==null)return f.err('Enter the Quick Method remittance rate first (Sales tax → Quick Method).');
    if(filing&&(w.quick||w.special)){const adj=qmAdjustment(k,from,to,w);if(adj){writes.push(...adj.writes);qmEntryId=adj.id}}
    if(filing&&w.pst){const adj=pstAdjustment(from,to,w);if(adj){writes.push(...adj.writes);qmEntryId=adj.id}}
    if(filing)writes.push({op:'set',collection:'filings',id:uid(),data:{tax:k,from,to,lines:w.vals,filedOn:$('#fOn',f).value||today(),entryId,qmEntryId,method:w.method,...(w.quick?{qmRate:w.quick.rate}:{}),...(w.special?{rebate:w.rebate,capComm:w.special.capComm,psbProv:w.special.provPct??null,...(w.special.kind==='npo'?{itcPct:w.special.pct}:{})}:{}),created:Date.now()}});
    else writes.push({op:'set',collection:'filings',id:w.filed.id,data:{...w.filed,entryId}});
    if(await batch(writes)){closeModal();toast(filing?'Return marked as filed':`${kind==='refund'?'Refund':'Payment'} recorded`)}
  };
}
async function unfile(k,from,to){
  const f=filingFor(k,from,to);if(!f)return;
  const pay=f.entryId?S.entries.find(e=>e.id===f.entryId):null;
  const adj=f.qmEntryId?S.entries.find(e=>e.id===f.qmEntryId):null;
  if(!await confirmBox('Undo this filing?',`The period goes back to not filed${pay?`, and the ${pay.taxKind==='refund'?'refund':'payment'} of ${money(entryTotal(pay))} on ${fmtDate(pay.date)} is deleted`:''}.${adj?' The adjustment posted with it is deleted too.':''} Use this if you marked it filed by mistake.`,'Undo filing'))return;
  const w=[{op:'delete',collection:'filings',id:f.id}];if(pay)w.push({op:'delete',collection:'entries',id:pay.id});if(adj)w.push({op:'delete',collection:'entries',id:adj.id});
  if(await batch(w))toast('Filing undone');
}
function instalmentForm(){
  const banks=sortAccts(S.accounts.filter(a=>a.detail==='bank'&&a.active!==false)),taxes=taxesInUse().filter(k=>k!=='pst');
  const f=openModal('Record instalment',`<div class="fields">
    ${taxes.length>1?fld('iTax','Tax',`<select id="iTax">${taxes.map(k=>`<option value="${k}">${k==='qst'?'QST':'GST'}</option>`).join('')}</select>`):''}
    ${fld('iDate','Date paid',`<input type="date" id="iDate" value="${today()}">`)}${fld('iAmt','Amount',`<input type="number" id="iAmt" step="0.01">`)}
    ${fld('iBank','Paid from',`<select id="iBank">${banks.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>`)}</div>
    <div class="muted" style="font-size:13px">Instalments reduce the balance on the return for the period they’re paid in (line ${taxes.length>1?'110 or 210':'110'}).</div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Record instalment</button>`);
  f.onsubmit=async e=>{e.preventDefault();const amt=r2($('#iAmt',f).value);if(!(amt>0))return f.err('Enter the amount paid.');if(!banks.length)return f.err('Add a bank account first.');
    const k=$('#iTax',f)?.value||'gst';
    if(await batch([{op:'set',collection:'entries',id:uid(),data:payEntry(k,'instalment',amt,$('#iBank',f).value,$('#iDate',f).value||today())}])){closeModal();toast('Instalment recorded')}};
}
async function splitQst(){
  if(!await confirmBox('Set up a separate QST account?','New transactions will post GST (5%) and QST (9.975%) to separate accounts, and you’ll get a QST return worksheet. Tax already recorded stays in the current account; move the QST part with a journal entry if you need past periods split.','Set up QST'))return;
  const main=byDetail('tax'),id=acct('a2210')?uid():'a2210';
  const writes=[{op:'set',collection:'accounts',id,data:{code:S.accounts.some(a=>a.code==='2210')?'':'2210',name:'QST payable',type:'Liability',detail:'qst',desc:'',active:true}}];
  if(main)writes.push({op:'set',collection:'accounts',id:main.id,data:{...main,name:'GST payable'}});
  if(await batch(writes)&&await putCompany({...strip(S.company),taxName:'GST/QST',taxRate:14.975,qstRate:9.975}))toast('QST is now tracked separately');
}

/* Warn before changing a transaction in a period whose return was filed. */
function filedWarning(entries){
  const ids=taxAcctIds();
  for(const e of entries){
    if(!e||e.type==='taxpayment'||e.type==='qmadjust'||!(e.lines||[]).some(l=>ids.has(l.account)))continue;
    const f=filedPeriodOn(e.date);if(f)return f;
  }
  return null;
}

/* ---------- Quick Method ---------- */
const QM_ACCTS={gain:['4950','Sales tax Quick Method gain','Gain – méthode rapide de taxes','Income'],itc:['6950','Sales tax paid on expenses (Quick Method)','Taxes payées sur les dépenses (méthode rapide)','Expense']};
/** Sales including tax over the last 12 months, when it's more than the Quick Method limit. */
function qmOverLimit(){
  for(const k of ['gst']){
    const ps=filingPeriods().filter(p=>p.to<today()&&qmOn(k,p.from));if(!ps.length)return null;
    const to=ps[0].to,from=addDays(to,-365);
    // CRA's test counts all taxable supplies, zero-rated ones too, with the tax.
    const total=r2(ps.filter(p=>p.from>from).reduce((t,p)=>{const x=scan(k,p.from,p.to).v;return t+x.s90+x.sExport+x.collected},0));
    if(total>QM_LIMIT)return{total,to};
  }
  return null;
}
/** What the Quick Method changes, under the worksheet. */
function qmBox(k,w,filed){
  const Q=w.quick,q=qmCfg(),name=esc(k==='qst'?'QST':taxLabel(k));
  const adj=filed&&filed.qmEntryId?S.entries.find(e=>e.id===filed.qmEntryId):null;
  const row=(l,v,b)=>`<tr${b?' class="tot"':''}><td>${l}</td><td class="n">${b?`<b>${money(v)}</b>`:money(v)}</td></tr>`;
  return `<div class="pad" style="border-top:1px solid var(--line)">
    <div class="flabel" style="margin-bottom:6px">Quick Method</div>
    ${Q.rate==null?`<div class="banner err" style="margin:0 0 10px"><span>There’s no remittance rate for this sales tax rate. Enter one in Quick Method settings.</span></div>`:`<div class="muted" style="font-size:13px;margin-bottom:8px"><span>${q.type==='goods'?'Buying goods to resell':'Services and other businesses'}:</span> <span>${Q.rate}% of sales including ${esc(name)}.</span>${q.credit!==false?` <span>Credit used earlier this fiscal year on ${money(Q.used)} of sales.</span>`:''}</div>`}
    <table class="ws" style="max-width:520px"><tbody>
      ${row(`${name} charged to customers`,Q.collected)}${Q.capSaleTax?row('On sales of capital assets, remitted in full',-Q.capSaleTax):''}${row('Remitted under the Quick Method',-Q.tax)}${row('1% credit',Q.credit)}
      ${row('Kept as income',Q.gain,true)}
      ${row(`${name} paid on expenses, not claimed (becomes part of expenses)`,Q.itcOps)}
      ${row(`${name} paid on capital purchases, still claimed (line ${k==='qst'?'206':'106'})`,Q.itcCap)}
    </tbody></table>
    <div class="muted" style="font-size:13px;margin-top:8px">${adj?`Posted on ${fmtDate(adj.date)} when this return was filed.`:`When you mark the return as filed, Sumlora posts these to income and expenses on ${fmtDate(w.filed?w.filed.to:(S.stax.period||'|').split('|')[1])}, so the sales tax account matches the return.`} <span>Mark purchases of equipment, vehicles and buildings as capital assets in the chart of accounts to keep their credits.</span></div>
  </div>`;
}
/** The journal entry that brings the tax account to the Quick Method amount: the gain to income, unclaimed tax to expenses. */
const NPO_ACCTS={gain:['4960','Sales tax retained (charity net tax calculation)','Taxes conservées (calcul de la taxe nette des organismes de bienfaisance)','Income'],itc:['6960','Sales tax not recovered','Taxes non récupérées','Expense']};
function qmAdjustment(k,from,to,w){
  const Q=w.quick,X=w.special,gain=Q?Q.gain:X.gain,ops=Q?Q.itcOps:X.ops;if(Math.abs(gain)<0.005&&Math.abs(ops)<0.005)return null;
  const writes=[],ids={},ACC=Q?QM_ACCTS:NPO_ACCTS,by=Q?'Added by the Quick Method':'Added by sales tax for non-profits';
  for(const[key,[code,en,fr,type]]of Object.entries(ACC)){
    if(key==='gain'&&Math.abs(gain)<0.005)continue;
    if(key==='itc'&&Math.abs(ops)<0.005)continue;
    let a=S.accounts.find(x=>x.type===type&&(x.name===en||x.name===fr))||S.accounts.find(x=>x.type===type&&x.code===code&&x.desc===by);
    if(!a){const id=uid();writes.push({op:'set',collection:'accounts',id,data:{code:S.accounts.some(x=>x.code===code)?'':code,name:S.company.lang==='fr'?fr:en,type,detail:'',desc:by,active:true}});a={id}}
    ids[key]=a.id;
  }
  const tax=w.account.id,lines=[];
  const gm=Q?'Tax kept under the Quick Method':'Tax kept under the net tax calculation for charities',om=Q?'Tax paid on expenses, not claimed':'Tax paid that isn’t recovered';
  if(Math.abs(gain)>=0.005)lines.push({account:tax,debit:gain>0?gain:0,credit:gain<0?-gain:0,memo:gm},{account:ids.gain,debit:gain<0?-gain:0,credit:gain>0?gain:0,memo:gm});
  if(Math.abs(ops)>=0.005)lines.push({account:ids.itc,debit:ops>0?ops:0,credit:ops<0?-ops:0,memo:om},{account:tax,debit:ops<0?-ops:0,credit:ops>0?ops:0,memo:om});
  const id=uid();
  writes.push({op:'set',collection:'entries',id,data:{type:'qmadjust',tax:k,period:{from,to},date:to,ref:'',memo:`${k==='qst'?'QST':taxLabel(k)} ${Q?'Quick Method adjustment':'adjustment for non-profits'}, ${fmtDate(from)} – ${fmtDate(to)}`,contactId:'',lines,created:Date.now()}});
  return{writes,id};
}
function quickForm(){
  const q=S.company.quickMethod||{},taxes=taxesInUse(),qc=S.company.province==='QC';
  const type=q.type||'services';
  const fy=fyStartOf(today());
  const capCands=sortAccts(S.accounts.filter(a=>a.type==='Asset'&&!['bank','ar'].includes(a.detail)&&a.active!==false));
  const looksCap=a=>a.detail==='capital'||(!S.accounts.some(x=>x.detail==='capital')&&/equipment|vehicle|furniture|computer|building|machinery|leasehold|immobilis|matériel|véhicule|mobilier|bâtiment/i.test(a.name));
  const f=openModal('Quick Method',`
    <div class="muted" style="font-size:13px">With the Quick Method you still charge customers the full ${qc?'GST and QST':esc(S.company.taxName||'GST/HST')}, but you remit a set percentage of your sales including tax instead of tax collected minus credits. You keep the difference as income, and you don’t claim tax paid on everyday expenses, only on capital purchases.</div>
    <div class="banner" style="margin:0"><span>It’s for businesses with sales of $400,000 or less a year, tax included. Bookkeepers, accountants, lawyers, tax preparers and financial consultants can’t use it. Elect with ${qc?'Revenu Québec':'form GST74 (CRA)'} by the due date of the first return you file with it.</span></div>
    ${quickBarred()?'<div class="banner err" style="margin:0"><span>Registered charities and qualifying non-profits can’t use the Quick Method. Their returns use the rules for non-profits instead (Settings → Organization type).</span></div>':''}
    <label class="check"><input type="checkbox" id="qmOn" ${q.on?'checked':''} ${quickBarred()&&!q.on?'disabled':''}> Use the Quick Method</label>
    <div class="fields" data-qm>
      ${fld('qmFrom','Starting',`<input type="date" id="qmFrom" value="${esc(q.from||fy)}"><span class="hint">The first day of a reporting period, usually the start of the fiscal year: ${fmtDate(fy)}.</span>`)}
      ${fld('qmType','The business mostly',`<select id="qmType"><option value="services" ${type==='services'?'selected':''}>Provides services, or other</option><option value="goods" ${type==='goods'?'selected':''}>Buys goods to resell (at least 40% of sales)</option></select>`)}
      ${fld('qmGst',`${qc||taxes.length>1?'GST':esc(S.company.taxName||'GST/HST')} remittance rate (%)`,`<input type="number" id="qmGst" step="0.1" min="0" max="20" value="${esc(q.gstRate??'')}"><span class="hint" data-qmhint="gst"></span>`)}
      ${taxes.includes('qst')?fld('qmQst','QST remittance rate (%)',`<input type="number" id="qmQst" step="0.1" min="0" max="20" value="${esc(q.qstRate??'')}"><span class="hint" data-qmhint="qst"></span>`):''}
    </div>
    <label class="check" data-qm><input type="checkbox" id="qmCredit" ${q.credit!==false?'checked':''}> Claim the 1% credit on the first $30,000 of sales each fiscal year${taxes.includes('qst')?' ($31,421 for QST)':''}</label>
    ${capCands.length?`<div data-qm><div class="flabel" style="margin-bottom:6px">Capital assets: credits on these purchases are still claimed</div><div class="muted" style="font-size:13px;margin-bottom:6px">Ticked accounts are marked “Capital asset” in the chart of accounts.</div><div style="display:flex;flex-wrap:wrap;gap:6px 18px">${capCands.map(a=>`<label class="check"><input type="checkbox" data-cap="${a.id}" ${looksCap(a)?'checked':''}> <span translate="no">${esc((a.code?a.code+' · ':'')+a.name)}</span></label>`).join('')}</div></div>`:''}
    ${qc&&taxes.length<2?'<div class="banner err" style="margin:0"><span>Set up a separate QST account first (on the Sales tax page): the Quick Method works out GST and QST separately.</span></div>':''}`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`,'wide');
  const sync=()=>{const on=$('#qmOn',f).checked;$$('[data-qm]',f).forEach(x=>x.style.display=on?'':'none');const t=$('#qmType',f).value;
    for(const k of ['gst','qst']){const el=$(`[data-qmhint=${k}]`,f);if(!el)continue;const sug=qmSuggested(k,t);
      el.textContent=sug==null?'Enter the rate from CRA’s Quick Method guide (RC4058).':t==='goods'?`Blank = ${sug}%, the rate for goods bought to resell.`:`Blank = ${sug}%, the rate for services.`;
      $(k==='gst'?'#qmGst':'#qmQst',f).placeholder=sug??''}};
  $('#qmOn',f).onchange=$('#qmType',f).onchange=sync;sync();
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const on=$('#qmOn',f).checked,from=$('#qmFrom',f).value;
    if(on&&qc&&taxes.length<2)return f.err('Set up a separate QST account first.');
    if(on&&quickBarred())return f.err('Registered charities and qualifying non-profits can’t use the Quick Method.');
    if(on&&!from)return f.err('Choose the date you start using the Quick Method.');
    const num=id=>{const el=$(id,f);if(!el||el.value==='')return '';return Math.max(0,Math.min(20,+el.value||0))};
    const next={...q,on,from,type:$('#qmType',f).value,gstRate:num('#qmGst'),qstRate:num('#qmQst'),credit:$('#qmCredit',f).checked};
    if(on&&qmRateFor(next,'gst')==null)return f.err('Enter the remittance rate.');
    const done=S.filings.some(x=>x.to>=(from||'')&&(x.method==='quick')!==(on&&x.from>=from));
    if(done&&!await confirmBox('Returns already filed','Some returns from that date were filed the other way. Their filed figures stay as they are. Undo and refile them if they should change.','Save anyway'))return;
    const writes=[];
    for(const box of $$('[data-cap]',f)){const a=acct(box.dataset.cap);if(!a)continue;const want=box.checked?'capital':(a.detail==='capital'?'':a.detail);
      if(on&&want!==a.detail)writes.push({op:'set',collection:'accounts',id:a.id,data:{...strip(a),detail:want}})}
    if(writes.length&&!await batch(writes))return;
    if(await putCompany({...strip(S.company),quickMethod:next})){closeModal();toast(on?'Quick Method turned on':'Quick Method turned off')}
  };
}
const qmRateFor=(q,k)=>{const own=k==='qst'?q.qstRate:q.gstRate;return own!==''&&own!=null?+own:qmSuggested(k,q.type||'services')};

/** What the rules for charities and non-profits change, under the worksheet. */
function npoBox(k,w,filed){
  const X=w.special,name=esc(k==='qst'?'QST':taxLabel(k)),qc=S.company.province==='QC';
  const adj=filed&&filed.qmEntryId?S.entries.find(e=>e.id===filed.qmEntryId):null;
  const row=(l,v,b)=>`<tr${b?' class="tot"':''}><td>${l}</td><td class="n">${b?`<b>${money(v)}</b>`:money(v)}</td></tr>`;
  const prov=X.provPct,hst=k==='gst'&&!qc&&gstRateCharged()>5&&prov!=null;
  const rates=k==='qst'?'50% of the QST':qc&&taxesInUse().length<2?'50% of the GST and QST':hst?`50% of the federal part and ${prov}% of the provincial part of the HST`:'50% of the GST';
  const form=qc||k==='qst'?'FP-2066':'GST66';
  return `<div class="pad" style="border-top:1px solid var(--line)">
    <div class="flabel" style="margin-bottom:6px">${X.kind==='charity'?'Net tax calculation for charities':'Sales tax for non-profits'}</div>
    <table class="ws" style="max-width:560px"><tbody>
      ${X.kind==='charity'?`${row(`${name} charged`,X.collected)}${X.capSaleTax?row('On sales of capital property, remitted in full',-X.capSaleTax):''}${row('Remitted: 60% of the rest',-r2(X.tax-X.capSaleTax))}${row('Kept as income',X.gain,true)}`
        :`${row(`${name} paid on purchases`,X.itc)}${row(`Claimed as credits: ${X.pct}% used in taxable activities`,X.itcNpo)}`}
      ${row(`${name} paid that isn’t claimed as credits`,X.paid)}
      ${w.rebate?row(`Public service bodies’ rebate: ${rates}`,X.rebate):''}
      ${row('Not recovered (becomes an expense)',X.ops,true)}
    </tbody></table>
    ${X.journals?`<div class="banner" style="margin:8px 0 0"><span>${money(X.journals)} of tax was posted by journal entries. It’s on lines ${k==='qst'?'204 and 207':'104 and 107'} in full, without the rules for non-profits. Record purchases and sales as bills, expenses, invoices or deposits so the rules apply.</span></div>`:''}
    <div class="muted" style="font-size:13px;margin-top:8px">${w.rebate?`<span>Claim the rebate with form ${form} and include it on line ${k==='qst'?'211':'111'}.</span> `:''}${X.capComm?'<span>Credits on capital property assume it’s used mainly (more than 50%) in taxable activities. Change this in Settings if it isn’t.</span> ':''}${adj?`<span>Posted on ${fmtDate(adj.date)} when this return was filed.</span>`:'<span>When you mark the return as filed, Sumlora posts the tax kept to income and the tax not recovered to expenses, so the sales tax account matches the return.</span>'}</div>
  </div>`;
}

/* ---------- PST / RST ---------- */
const PST_ACCTS={commission:['4970','commission','Commission de taxe de vente provinciale','Income'],self:['6970','paid on own purchases (self-assessed)','Taxe de vente provinciale autocotisée','Expense']};
/** Under the PST worksheet: what lines D and F are, and what filing posts. */
function pstBox(w,filed){
  const n=esc(pstName()),adj=filed&&filed.qmEntryId?S.entries.find(e=>e.id===filed.qmEntryId):null,bc=S.company.province==='BC';
  return `<div class="pad" style="border-top:1px solid var(--line);font-size:13px">
    <div class="muted" style="margin-bottom:6px"><b>Line D:</b> <span>${n} you owe on things you bought or leased for your own use without being charged ${n} (from a seller outside the province, for example), or took from stock you bought to resell.</span></div>
    <div class="muted" style="margin-bottom:6px"><b>Line F:</b> <span>The commission the province lets you keep when the return is filed and paid on time. Enter the amount the online return works out${bc?' (in British Columbia, up to $198 a period)':''}.</span></div>
    <div class="muted">${adj?`<span>Posted on ${fmtDate(adj.date)} when this return was filed.</span>`:`<span>${n} paid on purchases isn’t claimed back, so it’s already part of the expenses and isn’t on this return.</span> <span>When you mark the return as filed, Sumlora posts line D to expenses and line F to income, so the ${n} account matches the return.</span>`}</div>
  </div>`;
}
/** The journal entry for lines D and F: self-assessed tax to expenses, commission to income. */
function pstAdjustment(from,to,w){
  const P=w.pst,n=pstName();if(Math.abs(P.self)<0.005&&Math.abs(P.commission)<0.005)return null;
  const writes=[],ids={},by=`Added by ${n} returns`;
  for(const[key,[code,en,fr,type]]of Object.entries(PST_ACCTS)){
    if(Math.abs(P[key])<0.005)continue;
    const name=S.company.lang==='fr'?fr:`${n} ${en}`;
    let a=S.accounts.find(x=>x.type===type&&x.name===name)||S.accounts.find(x=>x.type===type&&x.desc===by&&x.code===code);
    if(!a){const id=uid();writes.push({op:'set',collection:'accounts',id,data:{code:S.accounts.some(x=>x.code===code)?'':code,name,type,detail:'',desc:by,active:true}});a={id}}
    ids[key]=a.id;
  }
  const tax=w.account.id,lines=[],dc=(acc,v,memo,debit)=>({account:acc,debit:debit?(v>0?v:0):(v<0?-v:0),credit:debit?(v<0?-v:0):(v>0?v:0),memo});
  if(ids.self){const m=`${n} self-assessed on purchases`;lines.push(dc(ids.self,P.self,m,true),dc(tax,P.self,m,false))}
  if(ids.commission){const m=`${n} commission`;lines.push(dc(tax,P.commission,m,true),dc(ids.commission,P.commission,m,false))}
  const id=uid();
  writes.push({op:'set',collection:'entries',id,data:{type:'qmadjust',tax:'pst',period:{from,to},date:to,ref:'',memo:`${n} return adjustment, ${fmtDate(from)} – ${fmtDate(to)}`,contactId:'',lines,created:Date.now()}});
  return{writes,id};
}
