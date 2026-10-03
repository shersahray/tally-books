'use strict';
/* ---------- Sending documents: PDFs, email, statements, reminders ----------
   Invoices, credit notes and statements are drawn as PDFs here in the browser (pdf.js), in the
   language the company keeps its books in. They're downloaded, or emailed from the company's own
   mailbox through the server (POST /api/mail/send). */
const DL={
  en:{invoice:'INVOICE',credit:'CREDIT NOTE',statement:'STATEMENT',billTo:'Bill to',to:'To',invNo:'Invoice no.',crNo:'Credit note no.',date:'Date',due:'Due date',asOf:'As of',desc:'Description',qty:'Qty',rate:'Rate',amount:'Amount',sub:'Subtotal',total:'Total',paid:'Paid',credits:'Credits applied',bal:'Balance due',avail:'Credit available',page:'Page {0} of {1}',taxNo:'GST/HST no.',taxNoQc:'GST/QST no.',type:'Type',no:'No.',balance:'Balance',inv:'Invoice',cr:'Credit note',current:'Current',d30:'1–30 days',d60:'31–60 days',d90:'61–90 days',d90p:'Over 90 days',totalDue:'Total due',appliedTo:'Applied to invoice {0}: {1}'},
  fr:{invoice:'FACTURE',credit:'NOTE DE CRÉDIT',statement:'RELEVÉ DE COMPTE',billTo:'Facturer à',to:'À',invNo:'N° de facture',crNo:'N° de note de crédit',date:'Date',due:'Échéance',asOf:'Au',desc:'Description',qty:'Qté',rate:'Prix',amount:'Montant',sub:'Sous-total',total:'Total',paid:'Payé',credits:'Crédits appliqués',bal:'Solde dû',avail:'Crédit disponible',page:'Page {0} de {1}',taxNo:'N° de TPS/TVH',taxNoQc:'N° de TPS/TVQ',type:'Type',no:'N°',balance:'Solde',inv:'Facture',cr:'Note de crédit',current:'Courant',d30:'1 à 30 jours',d60:'31 à 60 jours',d90:'61 à 90 jours',d90p:'Plus de 90 jours',totalDue:'Total dû',appliedTo:'Appliqué à la facture {0} : {1}'},
};
const dlang=()=>S.company.lang==='fr'?'fr':'en';
const dl=(k,...a)=>DL[dlang()][k].replace(/\{(\d)\}/g,(m,i)=>a[i]);
const dmoney=n=>(+n||0).toLocaleString(dlang()==='fr'?'fr-CA':'en-CA',{style:'currency',currency:'CAD'});
const ddate=s=>s?pd(s).toLocaleDateString(dlang()==='fr'?'fr-CA':'en-CA',{year:'numeric',month:'short',day:'numeric'}):'';
let logoCache={id:'',bytes:null};
async function logoBytes(){
  const id=S.company.logoFile;if(!id)return null;
  if(logoCache.id===id)return logoCache.bytes;
  try{const r=await fetch(coUrl('/api/files/'+encodeURIComponent(id)));if(!r.ok)return null;logoCache={id,bytes:new Uint8Array(await r.arrayBuffer())};return logoCache.bytes}catch(e){return null}
}

/* ---------- drawing ---------- */
const M=50,RIGHT=562,GREY='#666666',ACC='#0a7369';
// Company block (logo, name, address, contact, tax number) and the title on the right. Returns the y below it.
function drawHeader(pdf,logo,title,meta){
  const c=S.company;let y=40;
  if(logo){const sz=pdf.image(logo,M,y,170,60);if(sz)y+=sz.h+10}
  pdf.text(M,y+12,c.name||'',{size:13,bold:true});y+=18;
  for(const line of String(c.address||'').split(/\r?\n/).filter(Boolean)){pdf.text(M,y+10,line,{size:9,color:GREY});y+=12}
  const contact=[c.phone,c.email,c.website].filter(Boolean).join('  ·  ');if(contact){pdf.text(M,y+10,contact,{size:9,color:GREY});y+=12}
  if(c.bn){pdf.text(M,y+10,`${+c.qstRate>0?dl('taxNoQc'):dl('taxNo')} ${c.bn}`,{size:9,color:GREY});y+=12}
  pdf.text(RIGHT,58,title,{size:20,bold:true,align:'right',color:ACC});
  let my=80;
  for(const[k,v,b]of meta){pdf.text(RIGHT-120,my,k,{size:9,color:GREY,align:'right'});pdf.text(RIGHT,my,v,{size:9.5,bold:!!b,align:'right'});my+=14}
  return Math.max(y,my)+18;
}
function drawParty(pdf,y,label,contactId){
  const ct=contact(contactId)||{};
  pdf.text(M,y,label.toUpperCase(),{size:8,bold:true,color:GREY});y+=14;
  pdf.text(M,y,ct.name||'',{size:11,bold:true});y+=13;
  for(const line of String(ct.address||'').split(/\r?\n|,\s*(?=[A-Z0-9])/).filter(Boolean).slice(0,5)){pdf.text(M,y,line.trim(),{size:9.5});y+=12}
  if(ct.email){pdf.text(M,y,ct.email,{size:9.5,color:GREY});y+=12}
  return y+16;
}
function pageNumbers(pdf){const n=pdf.pageCount();if(n<2)return;for(let i=0;i<n;i++){pdf.goto(i);pdf.text(RIGHT,770,dl('page',i+1,n),{size:8,color:GREY,align:'right'})}}
function drawFooter(pdf,text){
  if(!text)return;
  const lines=pdf.wrap(text,RIGHT-M,8.5).slice(0,6);
  let y=760-lines.length*11;
  pdf.line(M,y-8,RIGHT,y-8,{color:'#dddddd'});
  for(const l of lines){pdf.text(M,y,l,{size:8.5,color:GREY});y+=11}
}

/** An invoice or credit note as a PDF (Uint8Array). */
async function docPdf(doc){
  const pdf=TallyPDF.create(),logo=await logoBytes(),cred=doc.kind==='credit';
  const st=docStatus(doc),paid=paidOn(doc.id);
  const meta=[[cred?dl('crNo'):dl('invNo'),doc.number||''],[dl('date'),ddate(doc.date)]];
  if(!cred&&doc.due)meta.push([dl('due'),ddate(doc.due)]);
  meta.push([cred?dl('avail'):dl('bal'),dmoney(st.bal),true]);
  let y=drawHeader(pdf,logo,cred?dl('credit'):dl('invoice'),meta);
  y=drawParty(pdf,y,dl('billTo'),doc.contactId);
  const head=yy=>{pdf.rect(M,yy-12,RIGHT-M,18,{fill:'#eef4f1'});pdf.text(M+6,yy,dl('desc'),{size:9,bold:true});pdf.text(380,yy,dl('qty'),{size:9,bold:true,align:'right'});pdf.text(470,yy,dl('rate'),{size:9,bold:true,align:'right'});pdf.text(RIGHT-6,yy,dl('amount'),{size:9,bold:true,align:'right'});return yy+20};
  y=head(y);
  for(const l of doc.lines||[]){
    const desc=pdf.wrap(l.desc||acctName(l.account),300,9.5);
    if(y+desc.length*12>690){pdf.addPage();y=head(60)}
    desc.forEach((t,i)=>pdf.text(M+6,y+i*12,t,{size:9.5}));
    pdf.text(380,y,String(+l.qty||0).replace('.',dlang()==='fr'?',':'.'),{size:9.5,align:'right'});
    pdf.text(470,y,dmoney(l.rate),{size:9.5,align:'right'});
    pdf.text(RIGHT-6,y,dmoney(r2((+l.qty||0)*(+l.rate||0))),{size:9.5,align:'right'});
    y+=desc.length*12+4;pdf.line(M,y-2,RIGHT,y-2,{color:'#e6e6e6'});y+=8;
  }
  // Totals
  const rows=[[dl('sub'),dmoney(doc.sub)]];
  if(+doc.tax)for(const p of splitTaxTotal(+doc.tax))rows.push([`${p.name} ${p.rate}%`,dmoney(p.amount)]);
  rows.push([dl('total'),dmoney(doc.total),true]);
  if(!cred){
    const credits=r2(S.docs.filter(c=>c.applied).reduce((s,c)=>s+c.applied.filter(a=>a.docId===doc.id).reduce((t,a)=>t+(+a.amount||0),0),0));
    const pays=r2(paid-credits);
    if(pays)rows.push([dl('paid'),'-'+dmoney(pays)]);
    if(credits)rows.push([dl('credits'),'-'+dmoney(credits)]);
    rows.push([dl('bal'),dmoney(st.bal),true]);
  }else rows.push([dl('avail'),dmoney(st.bal),true]);
  if(y+rows.length*16>720){pdf.addPage();y=60}
  const top=y;
  for(const[k,v,b]of rows){if(b){pdf.line(360,y-11,RIGHT,y-11,{color:'#cccccc'})}pdf.text(470,y,k,{size:9.5,bold:!!b,align:'right'});pdf.text(RIGHT-6,y,v,{size:9.5,bold:!!b,align:'right'});y+=16}
  // Message and, for credit notes, what it was applied to
  let ly=top;
  const notes=[];
  if(doc.memo)notes.push(...pdf.wrap(doc.memo,280,9));
  if(cred)for(const a of doc.applied||[]){const inv=S.docs.find(x=>x.id===a.docId);if(inv)notes.push(dl('appliedTo',inv.number||'',dmoney(a.amount)))}
  for(const n of notes.slice(0,40)){if(ly>700){pdf.addPage();ly=60}pdf.text(M,ly,n,{size:9,color:'#333333'});ly+=12}
  drawFooter(pdf,S.company.invoiceNote);
  pageNumbers(pdf);
  return pdf.output();
}
/** A customer's statement as of a date: open invoices and unused credits, with aging. */
async function statementPdf(contactId,asOf,pdfIn){
  const pdf=pdfIn||TallyPDF.create();if(pdfIn)pdf.addPage();
  const logo=await logoBytes();
  const items=statementItems(contactId,asOf);
  const total=r2(items.reduce((s,i)=>s+i.bal,0));
  let y=drawHeader(pdf,logo,dl('statement'),[[dl('asOf'),ddate(asOf)],[dl('totalDue'),dmoney(total),true]]);
  y=drawParty(pdf,y,dl('to'),contactId);
  const head=yy=>{pdf.rect(M,yy-12,RIGHT-M,18,{fill:'#eef4f1'});[[M+6,dl('date')],[130,dl('type')],[230,dl('no')]].forEach(([x,t])=>pdf.text(x,yy,t,{size:9,bold:true}));pdf.text(380,yy,dl('due'),{size:9,bold:true,align:'right'});pdf.text(470,yy,dl('amount'),{size:9,bold:true,align:'right'});pdf.text(RIGHT-6,yy,dl('balance'),{size:9,bold:true,align:'right'});return yy+20};
  y=head(y);
  for(const i of items){
    if(y>690){pdf.addPage();y=head(60)}
    pdf.text(M+6,y,ddate(i.d.date),{size:9.5});pdf.text(130,y,i.cr?dl('cr'):dl('inv'),{size:9.5});pdf.text(230,y,i.d.number||'',{size:9.5});
    pdf.text(380,y,i.cr?'':ddate(i.d.due),{size:9.5,align:'right'});pdf.text(470,y,dmoney(i.cr?-i.d.total:i.d.total),{size:9.5,align:'right'});pdf.text(RIGHT-6,y,dmoney(i.bal),{size:9.5,align:'right'});
    y+=16;pdf.line(M,y-10,RIGHT,y-10,{color:'#eeeeee'});
  }
  y+=10;if(y>650){pdf.addPage();y=60}
  const age=agingOf(items,asOf),labels=[dl('current'),dl('d30'),dl('d60'),dl('d90'),dl('d90p'),dl('totalDue')],vals=[...age,total];
  const w=(RIGHT-M)/6;
  pdf.rect(M,y-12,RIGHT-M,34,{fill:'#f4f6f5'});
  labels.forEach((l,i)=>{pdf.text(M+w*i+w/2,y,l,{size:8,color:GREY,align:'center'});pdf.text(M+w*i+w/2,y+14,dmoney(vals[i]),{size:9.5,bold:i===5,align:'center'})});
  drawFooter(pdf,S.company.invoiceNote);
  if(!pdfIn)pageNumbers(pdf);
  return pdf;
}
// What was still open on asOf: payments, refunds and credits dated after it don't count yet.
function balAsOf(d,asOf){
  let s=S.entries.filter(e=>e.applyTo===d.id&&e.date<=asOf).reduce((t,e)=>t+(+e.amount||0),0);
  for(const c of S.docs){if(!c.applied||c.date>asOf)continue;for(const a of c.applied)if(a.docId===d.id||c.id===d.id)s+=+a.amount||0}
  return r2((+d.total||0)-s);
}
function statementItems(contactId,asOf){
  const out=[];
  for(const d of S.docs){
    if(d.contactId!==contactId||d.date>asOf||(d.kind!=='invoice'&&d.kind!=='credit'))continue;
    const bal=asOf>=today()?docStatus(d).bal:balAsOf(d,asOf);if(bal<=0.004)continue;
    out.push({d,cr:d.kind==='credit',bal:d.kind==='credit'?-bal:bal});
  }
  return out.sort((a,b)=>a.d.date.localeCompare(b.d.date));
}
function agingOf(items,asOf){const a=[0,0,0,0,0];for(const i of items){const late=i.cr||!i.d.due?0:daysBetween(i.d.due,asOf);a[late<=0?0:late<=30?1:late<=60?2:late<=90?3:4]+=i.bal}return a.map(r2)}
const pdfName=(kind,num)=>`${({invoice:dlang()==='fr'?'Facture':'Invoice',credit:dlang()==='fr'?'Note-de-credit':'Credit-note',statement:dlang()==='fr'?'Releve':'Statement'})[kind]}-${String(num||'').replace(/[^A-Za-z0-9-]+/g,'')||today()}.pdf`;
const toB64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(s)};

/* ---------- email ---------- */
let MAILCFG=null;
async function loadMail(){try{MAILCFG=await api('GET','/api/mail')}catch(e){MAILCFG=null}return MAILCFG}
function templ(kind,v){
  const fr=dlang()==='fr',co=S.company.name;
  const T={
    invoice:fr?[`Facture ${v.num} de ${co}`,`Bonjour ${v.name},\n\nVous trouverez ci-joint la facture ${v.num} de ${v.amount}, payable au plus tard le ${v.due}.\n\nMerci,\n${co}`]:[`Invoice ${v.num} from ${co}`,`Hello ${v.name},\n\nPlease find attached invoice ${v.num} for ${v.amount}, due ${v.due}.\n\nThank you,\n${co}`],
    reminder:fr?[`Rappel : facture ${v.num} en souffrance`,`Bonjour ${v.name},\n\nNous vous rappelons que la facture ${v.num}, d’un solde de ${v.amount}, était payable le ${v.due}. Si vous l’avez déjà réglée, merci et veuillez ne pas tenir compte de ce message.\n\nLa facture est jointe.\n\nMerci,\n${co}`]:[`Reminder: invoice ${v.num} is past due`,`Hello ${v.name},\n\nThis is a friendly reminder that invoice ${v.num}, with ${v.amount} still owing, was due on ${v.due}. If you’ve already paid, thank you, and please disregard this message.\n\nThe invoice is attached.\n\nThank you,\n${co}`],
    package:fr?[`Rapports financiers de ${co} : ${v.period}`,`Bonjour,\n\nVous trouverez ci-joints les rapports financiers de ${co} pour la période du ${v.period}.\n\nN’hésitez pas à me faire part de vos questions.\n\nMerci,`]:[`Financial reports for ${co}: ${v.period}`,`Hello,\n\nPlease find attached the financial reports for ${co} for ${v.period}.\n\nLet me know if you have any questions.\n\nThank you,`],
    credit:fr?[`Note de crédit ${v.num} de ${co}`,`Bonjour ${v.name},\n\nVous trouverez ci-jointe la note de crédit ${v.num} de ${v.amount}.\n\nMerci,\n${co}`]:[`Credit note ${v.num} from ${co}`,`Hello ${v.name},\n\nPlease find attached credit note ${v.num} for ${v.amount}.\n\nThank you,\n${co}`],
    statement:fr?[`Relevé de compte de ${co}`,`Bonjour ${v.name},\n\nVous trouverez ci-joint votre relevé de compte au ${v.due}. Le solde dû est de ${v.amount}.\n\nMerci,\n${co}`]:[`Statement from ${co}`,`Hello ${v.name},\n\nPlease find attached your statement as of ${v.due}. The balance due is ${v.amount}.\n\nThank you,\n${co}`],
  };
  return T[kind];
}
async function sendMail(to,subject,text,pdfBytes,fileName,docIds,what){
  return api('POST','/api/mail/send',{to,subject,text,attachments:pdfBytes?[{name:fileName,data:toB64(pdfBytes)}]:[],docIds,what});
}
/** Compose and send one email with a document attached. */
async function composeMail({kind,contactId,docIds,makePdf,fileName,vars}){
  await loadMail();
  const ct=contact(contactId)||{};
  const[subj,text]=templ(kind,vars);
  const ok=MAILCFG&&MAILCFG.configured;
  const f=openModal('Email',`${ok?'':`<div class="banner" style="margin:0"><span>Email isn’t set up for this company yet. Set it up in Settings, or open this in your own email app and attach the downloaded PDF.</span></div>`}
    <div class="fields">${fld('mlTo','To',`<input type="text" id="mlTo" value="${esc(ct.email||'')}" placeholder="name@example.com">`,true)}${fld('mlCc','Cc',`<input type="text" id="mlCc">`,true)}${fld('mlSub','Subject',`<input type="text" id="mlSub" value="${esc(subj)}">`,true)}</div>
    <div class="field"><label for="mlText">Message</label><textarea id="mlText" rows="9">${esc(text)}</textarea></div>
    <div class="muted" style="font-size:13px"><span>Attached:</span> <span translate="no">${esc(fileName)}</span>${ok?` · <span>Sent from</span> <span translate="no">${esc(MAILCFG.fromEmail)}</span>`:''}</div>`,
    `${ok?'':'<button type="button" class="btn left" data-mlsetup>Set up email</button>'}<button type="button" class="btn" data-mlapp>Open in my email app</button><button type="button" class="btn" data-close>Cancel</button>${ok?'<button type="submit" class="btn primary">Send</button>':''}`,'wide');
  const su=$('[data-mlsetup]',f);if(su)su.onclick=()=>{closeModal();go('settings')};
  $('[data-mlapp]',f).onclick=async()=>{const pdf=await makePdf();saveFile(fileName,new Blob([pdf],{type:'application/pdf'}));location.href=`mailto:${encodeURIComponent($('#mlTo',f).value.trim())}?subject=${encodeURIComponent($('#mlSub',f).value)}&body=${encodeURIComponent($('#mlText',f).value)}`};
  f.onsubmit=async e=>{e.preventDefault();f.err('');
    const to=$('#mlTo',f).value.trim();if(!to)return f.err('Enter who the email goes to.');
    const btn=f.querySelector('[type=submit]');btn.disabled=true;btn.textContent='Sending…';
    try{const pdf=await makePdf();await api('POST','/api/mail/send',{to,cc:$('#mlCc',f).value.trim(),subject:$('#mlSub',f).value,text:$('#mlText',f).value,attachments:[{name:fileName,data:toB64(pdf)}],docIds,what:kind});await load();closeModal();toast(`Sent to ${to}`)}
    catch(err){btn.disabled=false;btn.textContent='Send';f.err(err.message)}
  };
}

/* ---------- buttons on invoices and credit notes ---------- */
function docActions(doc){
  if(doc.kind!=='invoice'&&doc.kind!=='credit')return '';
  const st=docStatus(doc),late=doc.kind==='invoice'&&st.k==='overdue';
  const sent=(doc.sent||[]).slice(-1)[0];
  return `<span class="doc-acts"><button type="button" class="btn ghost" data-dopdf>PDF</button><button type="button" class="btn ghost" data-domail>${late?'Send reminder':'Email'}</button>${sent?`<span class="muted" style="font-size:12px">Emailed ${fmtDate(new Date(sent.at).toISOString().slice(0,10))}</span>`:''}</span>`;
}
function bindDocActions(f,doc){
  const p=$('[data-dopdf]',f),m=$('[data-domail]',f);
  const name=pdfName(doc.kind,doc.number);
  if(p)p.onclick=async()=>{try{saveFile(name,new Blob([await docPdf(doc)],{type:'application/pdf'}))}catch(e){toast(e.message,true)}};
  if(m)m.onclick=()=>{
    const st=docStatus(doc),late=doc.kind==='invoice'&&st.k==='overdue';
    closeModal();
    composeMail({kind:doc.kind==='credit'?'credit':late?'reminder':'invoice',contactId:doc.contactId,docIds:[doc.id],fileName:name,makePdf:()=>docPdf(S.docs.find(x=>x.id===doc.id)||doc),
      vars:{name:contactName(doc.contactId),num:doc.number||'',amount:dmoney(late?st.bal:doc.total),due:ddate(doc.due)}});
  };
}

/* ---------- statements and reminders, from Sales ---------- */
function salesMailButtons(){return '<button class="btn" data-mlstatements>Statements</button>'+(S.docs.some(d=>d.kind==='invoice'&&docStatus(d).k==='overdue')?'<button class="btn" data-mlreminders>Overdue reminders</button>':'')}
async function bulkSend(items,label){
  await loadMail();
  if(!MAILCFG||!MAILCFG.configured){toast('Set up email for this company first (Settings → Email).',true);return 0}
  let sent=0,skipped=0;
  for(let i=0;i<items.length;i++){
    const it=items[i],email=(contact(it.contactId)||{}).email;
    if(!email){skipped++;continue}
    toast(`${label} ${i+1} / ${items.length}…`);
    try{const pdf=await it.makePdf();const[subj,text]=templ(it.kind,it.vars);await sendMail(email,subj,text,pdf,it.fileName,it.docIds||[],it.kind);sent++}
    catch(e){toast(e.message,true);break}
  }
  await load();
  toast(`${sent} sent${skipped?` · ${skipped} skipped (no email address)`:''}`);
  return sent;
}
function statementsForm(){
  const asOf=today();
  const rows=S.contacts.filter(c=>c.kind==='customer').map(c=>{const it=statementItems(c.id,asOf);return{c,bal:r2(it.reduce((s,i)=>s+i.bal,0)),n:it.length}}).filter(x=>x.n).sort((a,b)=>a.c.name.localeCompare(b.c.name));
  const f=openModal('Customer statements',`<div class="fields">${fld('stDate','As of',`<input type="date" id="stDate" value="${asOf}">`)}</div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th><input type="checkbox" data-stall checked aria-label="Select all"></th><th>Customer</th><th>Email</th><th class="n">Balance</th></tr></thead><tbody>${rows.map(x=>`<tr><td><input type="checkbox" data-stc="${x.c.id}" checked></td><td translate="no">${esc(x.c.name)}</td><td translate="no">${x.c.email?esc(x.c.email):'<span class="muted">—</span>'}</td><td class="n">${money(x.bal)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><b>No customers owe anything</b></div>'}`,
    `<button type="button" class="btn" data-close>Cancel</button>${rows.length?'<button type="button" class="btn" data-stdl>Download PDF</button><button type="submit" class="btn primary">Email statements</button>':''}`,'wide');
  const all=$('[data-stall]',f);if(all)all.onchange=()=>$$('[data-stc]',f).forEach(c=>c.checked=all.checked);
  const picked=()=>$$('[data-stc]',f).filter(c=>c.checked).map(c=>c.dataset.stc);
  const dl2=$('[data-stdl]',f);if(dl2)dl2.onclick=async()=>{const ids=picked();if(!ids.length)return;const d=$('#stDate',f).value||today();let pdf=null;for(const id of ids)pdf=await statementPdf(id,d,pdf);saveFile(pdfName('statement',d),new Blob([pdf.output()],{type:'application/pdf'}))};
  f.onsubmit=async e=>{e.preventDefault();const ids=picked();if(!ids.length)return;const d=$('#stDate',f).value||today();closeModal();
    await bulkSend(ids.map(id=>{const it=statementItems(id,d);return{contactId:id,kind:'statement',fileName:pdfName('statement',d),makePdf:async()=>(await statementPdf(id,d)).output(),vars:{name:contactName(id),amount:dmoney(it.reduce((s,i)=>s+i.bal,0)),due:ddate(d),num:''}}}),'Sending')};
}
function remindersForm(){
  const late=S.docs.filter(d=>d.kind==='invoice'&&docStatus(d).k==='overdue').sort((a,b)=>a.due.localeCompare(b.due));
  const f=openModal('Overdue reminders',`<div class="muted" style="font-size:13px">Each customer gets a friendly reminder with the invoice attached, from this company’s email.</div>
    <div class="tbl-wrap"><table><thead><tr><th><input type="checkbox" data-rmall checked aria-label="Select all"></th><th>Invoice</th><th>Customer</th><th>Due</th><th class="n">Balance</th><th>Last emailed</th></tr></thead><tbody>${late.map(d=>{const s=(d.sent||[]).slice(-1)[0];return `<tr><td><input type="checkbox" data-rmd="${d.id}" checked></td><td class="mono">${esc(d.number||'')}</td><td translate="no">${esc(contactName(d.contactId))}${(contact(d.contactId)||{}).email?'':' <span class="neg" style="font-size:12px">· no email</span>'}</td><td class="neg">${fmtDate(d.due)}</td><td class="n">${money(docStatus(d).bal)}</td><td class="muted">${s?fmtDate(new Date(s.at).toISOString().slice(0,10)):'—'}</td></tr>`}).join('')}</tbody></table></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Send reminders</button>`,'wide');
  const all=$('[data-rmall]',f);all.onchange=()=>$$('[data-rmd]',f).forEach(c=>c.checked=all.checked);
  f.onsubmit=async e=>{e.preventDefault();const ids=$$('[data-rmd]',f).filter(c=>c.checked).map(c=>c.dataset.rmd);if(!ids.length)return;closeModal();
    await bulkSend(ids.map(id=>{const d=S.docs.find(x=>x.id===id);return{contactId:d.contactId,kind:'reminder',docIds:[d.id],fileName:pdfName('invoice',d.number),makePdf:()=>docPdf(d),vars:{name:contactName(d.contactId),num:d.number||'',amount:dmoney(docStatus(d).bal),due:ddate(d.due)}}}),'Sending')};
}

/* ---------- Settings: invoice details and email ---------- */
const MAIL_PRESETS={
  gmail:{label:'Gmail or Google Workspace',host:'smtp.gmail.com',port:465,security:'ssl',help:'Turn on 2-Step Verification for the Google account, then create an app password (Google Account → Security → App passwords) and use it here, not the normal password.'},
  m365:{label:'Microsoft 365 (business)',host:'smtp.office365.com',port:587,security:'starttls',help:'Works only if the organization allows “Authenticated SMTP” for this mailbox (Microsoft 365 admin center → the user → Mail → Manage email apps). Microsoft plans to turn this off by default at the end of December 2026.'},
  outlook:{label:'Outlook.com or Hotmail (personal)',host:'smtp-mail.outlook.com',port:587,security:'starttls',help:'Microsoft now requires its own sign-in for personal Outlook.com mailboxes, so a password may be refused. If it is, use another mailbox, or download the PDF and send it from Outlook.'},
  yahoo:{label:'Yahoo',host:'smtp.mail.yahoo.com',port:465,security:'ssl',help:'Create an app password (Yahoo Account Security → Generate app password) and use it here.'},
  icloud:{label:'iCloud Mail',host:'smtp.mail.me.com',port:587,security:'starttls',help:'Create an app-specific password at appleid.apple.com and use it here. The user name is the full iCloud email address.'},
  zoho:{label:'Zoho Mail',host:'smtp.zoho.com',port:465,security:'ssl',help:'Use an application-specific password if two-factor sign-in is on.'},
  other:{label:'Another provider or my website’s email',host:'',port:465,security:'ssl',help:'Your email or web hosting provider lists its “outgoing mail (SMTP)” server, port and security.'},
};
function invoiceDetailsPanel(){
  if(!ME||ME.role==='client')return '';
  const c=S.company;
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Invoices and statements</h3><form class="pad" id="invSetForm" style="display:flex;flex-direction:column;gap:14px">
    <div class="muted" style="font-size:13px">Shown on invoices, credit notes and statements, with the business name and the business / tax number above.</div>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${c.logoFile?`<img src="${coUrl('/api/files/'+encodeURIComponent(c.logoFile))}" alt="Logo" style="max-height:60px;max-width:200px;border:1px solid var(--line);border-radius:6px;padding:4px;background:#fff">`:'<span class="muted">No logo</span>'}
      <label class="btn sm"><input type="file" accept="image/png,image/jpeg" id="logoFile" hidden>${c.logoFile?'Change logo':'Add logo'}</label>${c.logoFile?'<button type="button" class="btn sm ghost" data-logodel>Remove</button>':''}</div>
    <div class="fields">
      ${fld('ivAddr','Address',`<textarea id="ivAddr" rows="3">${esc(c.address||'')}</textarea>`,true)}
      ${fld('ivPhone','Phone',`<input type="text" id="ivPhone" value="${esc(c.phone||'')}">`)}${fld('ivEmail','Email',`<input type="email" id="ivEmail" value="${esc(c.email||'')}">`)}
      ${fld('ivWeb','Website',`<input type="text" id="ivWeb" value="${esc(c.website||'')}">`)}
      ${fld('ivNote','Note at the bottom',`<textarea id="ivNote" rows="3" placeholder="For example: Pay by e-Transfer to billing@example.com. Thank you for your business.">${esc(c.invoiceNote||'')}</textarea>`,true)}
    </div><div><button class="btn primary" type="submit">Save</button></div></form></div>`;
}
function mailPanel(){
  if(!ME||ME.readOnly)return '';
  const m=MAILCFG;
  if(!m)return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Email</h3><div class="pad muted">Loading…</div></div>`;
  const preset=Object.entries(MAIL_PRESETS).find(([k,p])=>p.host&&p.host===m.host)?.[0]||(m.configured?'other':'gmail');
  const P=MAIL_PRESETS[preset];
  return `<div class="panel" style="max-width:640px;margin-top:16px"><h3>Email</h3><form class="pad" id="mailForm" style="display:flex;flex-direction:column;gap:14px">
    <div class="muted" style="font-size:13px">Invoices, statements and reminders are sent from this company’s own mailbox, so customers see its address and replies go there. The password stays on the server and is never shown again.</div>
    <div>${m.configured?`<span class="pill paid">On</span> Sending from <span translate="no">${esc(m.fromEmail)}</span>${m.sentToday?` · ${m.sentToday} sent today`:''}`:'<span class="pill partial">Not set up</span>'}</div>
    <div class="fields">
      ${fld('mlPre','Email provider',`<select id="mlPre">${Object.entries(MAIL_PRESETS).map(([k,p])=>`<option value="${k}" ${k===preset?'selected':''}>${esc(p.label)}</option>`).join('')}</select><span class="hint" data-mlhelp>${esc(P.help)}</span>`,true)}
      ${fld('mlUser','Email address',`<input type="email" id="mlUser" value="${esc(m.user||'')}" autocomplete="off" translate="no">`)}
      ${fld('mlPass',m.configured?'New password (leave blank to keep)':'Password or app password',`<input type="password" id="mlPass" autocomplete="new-password">`)}
      ${fld('mlName','Name customers see',`<input type="text" id="mlName" value="${esc(m.fromName||S.company.name||'')}">`)}
      ${fld('mlReply','Replies go to (optional)',`<input type="email" id="mlReply" value="${esc(m.replyTo||'')}" translate="no">`)}
    </div>
    <details ${preset==='other'?'open':''}><summary class="fsum">Server settings</summary><div class="fields" style="margin-top:8px">
      ${fld('mlHost','Outgoing mail (SMTP) server',`<input type="text" id="mlHost" value="${esc(m.host||P.host)}" translate="no">`)}${fld('mlPort','Port',`<input type="number" id="mlPort" value="${m.port||P.port}">`)}
      ${fld('mlSec','Security',`<select id="mlSec"><option value="ssl" ${(m.security||P.security)==='ssl'?'selected':''}>SSL/TLS (usually port 465)</option><option value="starttls" ${(m.security||P.security)==='starttls'?'selected':''}>STARTTLS (usually port 587)</option></select>`)}</div></details>
    <div class="actions"><button class="btn primary" type="submit">Save</button>${m.configured?'<button type="button" class="btn" data-mltest>Send a test email</button><button type="button" class="btn ghost" data-mloff>Turn off</button>':''}</div>
  </form></div>`;
}
let mailTried=0;
function bindDocout(m){
  if(S.view==='settings'&&Date.now()-mailTried>30000&&(mailTried=Date.now()))loadMail().then(()=>{if(S.view==='settings')renderMain()});
  const inv=$('#invSetForm',m);
  if(inv){
    inv.onsubmit=async e=>{e.preventDefault();if(await putCompany({...strip(S.company),address:$('#ivAddr',inv).value,phone:$('#ivPhone',inv).value,email:$('#ivEmail',inv).value,website:$('#ivWeb',inv).value,invoiceNote:$('#ivNote',inv).value}))toast('Invoice details saved')};
    const lf=$('#logoFile',inv);if(lf)lf.onchange=async()=>{const file=lf.files[0];lf.value='';if(!file)return;try{const jpg=await toJpeg(file,600);await api('PUT','/api/logo',{data:toB64(jpg)});await load();toast('Logo saved')}catch(err){toast(err.message,true)}};
    const ld=$('[data-logodel]',inv);if(ld)ld.onclick=async()=>{try{await api('DELETE','/api/logo');await load();toast('Logo removed')}catch(err){toast(err.message,true)}};
  }
  const mf=$('#mailForm',m);
  if(mf){
    const pre=$('#mlPre',mf);pre.onchange=()=>{const P=MAIL_PRESETS[pre.value];$('[data-mlhelp]',mf).textContent=P.help;if(P.host){$('#mlHost',mf).value=P.host;$('#mlPort',mf).value=P.port;$('#mlSec',mf).value=P.security}else mf.querySelector('details').open=true};
    mf.onsubmit=async e=>{e.preventDefault();try{MAILCFG={...await api('PUT','/api/mail',{host:$('#mlHost',mf).value,port:+$('#mlPort',mf).value,security:$('#mlSec',mf).value,user:$('#mlUser',mf).value,fromEmail:$('#mlUser',mf).value,pass:$('#mlPass',mf).value,fromName:$('#mlName',mf).value,replyTo:$('#mlReply',mf).value}),sentToday:MAILCFG&&MAILCFG.sentToday||0};renderMain();toast('Email settings saved. Send a test to check them.')}catch(err){toast(err.message,true)}};
    const t=$('[data-mltest]',mf);if(t)t.onclick=async()=>{t.disabled=true;t.textContent='Sending…';try{await api('POST','/api/mail/test',{to:MAILCFG.fromEmail});toast(`Test email sent to ${MAILCFG.fromEmail}`)}catch(err){toast(err.message,true)}t.disabled=false;t.textContent='Send a test email'};
    const o=$('[data-mloff]',mf);if(o)o.onclick=async()=>{if(!await confirmBox('Turn off email?','The mailbox settings and password are removed from this company.','Turn off'))return;try{MAILCFG=await api('PUT','/api/mail',{remove:true});renderMain();toast('Email turned off')}catch(err){toast(err.message,true)}};
  }
}
// A logo image as a JPEG no wider than maxW, on a white background (PDFs can't show PNG transparency here).
async function toJpeg(file,maxW){
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();await new Promise((ok,no)=>{img.onload=ok;img.onerror=()=>no(new Error('That image couldn’t be read.'));img.src=url});
    const k=Math.min(1,maxW/img.naturalWidth),c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*k));c.height=Math.max(1,Math.round(img.naturalHeight*k));
    const x=c.getContext('2d');x.fillStyle='#ffffff';x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);
    const blob=await new Promise(ok=>c.toBlob(ok,'image/jpeg',0.9));return new Uint8Array(await blob.arrayBuffer());
  }finally{URL.revokeObjectURL(url)}
}
