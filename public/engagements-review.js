'use strict';
/* ---------- Year-end files: the review layer ----------
 * Overview (progress, engagement details, sign-offs, unlock history), working papers (one per leadsheet plus planning,
 * related parties and subsequent events) with notes, tickmarks, cross-references, documents and sign-offs, review notes,
 * and the completion checklist. The server stamps every sign-off with who and when (app.js stampEngagement), so the
 * screens only send "signed" or "not signed" ({at:1} or null). Rules are in engagements-calc.js.
 */
const YF_SIGN={at:1};
const yfWpLabel=c=>(TallyEngage.BY_CODE[c]||TallyEngage.EXTRA_WPS.find(x=>x.code===c)||{label:c}).label;
const yfDocs=(f,wp)=>S.attachments.filter(a=>a.target==='engagements'&&a.targetId===f.id&&(wp===undefined||a.wp===wp));
const yfPerson=p=>p&&p.name?esc(p.name):`<span class="muted">${esc(T('Not assigned'))}</span>`;

/** Client details for a new file: last year's file's, else the company's own settings. */
function yfClientDefaults(prev){
  if(prev&&prev.client&&prev.client.legalName)return{...prev.client};
  const c=S.company||{};
  return{legalName:c.name||'',operatingName:'',address:c.address||'',province:c.province||'',corpNumber:'',bn:c.bn||'',contact:[c.email,c.phone].filter(Boolean).join(' · '),industry:c.industry||'',owners:''};
}

/* ---------- overview ---------- */
function yfOverview(f,edit,pg){
  const tick=ok=>ok?'<span class="pos">✓</span>':'<span class="neg">•</span>';
  const met=(lbl,val,ok)=>`<div class="chip"><div class="lbl">${esc(T(lbl))}</div><div class="val">${tick(ok)} ${val}</div></div>`;
  let h=`<div class="chips">${met('Checklist complete',pg.pct+'%',pg.pct===100)}${met('Working papers reviewed',`${pg.wps-pg.unreviewed} / ${pg.wps}`,!pg.unreviewed)}${met('Open review notes',pg.openNotes,!pg.openNotes)}${met('Draft adjusting entries',pg.draftAjes,!pg.draftAjes)}${met('Working papers without documents',pg.noDocs,!pg.noDocs)}${met('Financial statements',pg.fsOk?T('Balance'):T('Don’t balance'),pg.fsOk)}</div>`;
  // Prior year against last year's final file.
  const prev=f.rolledFrom?yfFile(f.rolledFrom):S.engagements.filter(x=>x.yearEnd<f.yearEnd&&yfFinal(x)).sort((a,b)=>b.yearEnd.localeCompare(a.yearEnd))[0];
  if(prev){const diff=TallyEngage.priorCheck(f,prev,S.accounts);
    h+=diff.length?`<div class="banner"><span><b>${esc(T('The prior year doesn’t agree with last year’s final file'))}</b> (${diff.length}): ${diff.slice(0,4).map(x=>`${esc(x.name)} ${money(x.prior)} vs ${money(x.last)}`).join(' · ')}${diff.length>4?'…':''}. ${esc(T('Usually an adjusting entry last year that never reached the books.'))}</span>${edit?`<button class="btn sm" data-yfprioruse="${esc(prev.id)}">${esc(T('Use last year’s final figures'))}</button>`:''}</div>`
      :`<div class="banner" style="background:var(--info-soft)"><span><span class="pos">✓</span> ${esc(T('The prior year agrees with last year’s final file'))} (${esc(fmtDate(prev.yearEnd))}).</span></div>`}
  const c=f.client||{},tm=f.team||{},so=f.signoffs||{};
  const row=(l,v)=>`<tr><td class="muted" style="width:38%">${esc(T(l))}</td><td>${v||'<span class="muted">—</span>'}</td></tr>`;
  h+=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">`;
  h+=`<div class="panel"><div class="toolbar"><b class="grow">${esc(T('Engagement'))}</b>${edit?'<button class="btn sm" data-yfdetails>Edit</button>':''}</div><div class="tbl-wrap"><table><tbody>${row('Engagement',esc(T(yfKind(f.kind))))}${row('Entity',esc(T(yfWords(f).label)))}${row('Accounting framework',esc(T(TallyEngage.FRAMEWORKS[f.framework||'ASPE'])))}${row('Fiscal year-end',esc(fmtDate(f.yearEnd)))}${row('Preparer',yfPerson(tm.preparer))}${row('Reviewer',yfPerson(tm.reviewer))}${row('Status',yfStatusPill(f))}${row('Created',f.created?esc(fmtDate(iso(new Date(f.created)))):'')}</tbody></table></div></div>`;
  h+=`<div class="panel"><div class="toolbar"><b class="grow">${esc(T('Client'))}</b>${edit?'<button class="btn sm" data-yfdetails>Edit</button>':''}</div><div class="tbl-wrap"><table><tbody>${row('Legal name',esc(c.legalName))}${row('Operating name',esc(c.operatingName))}${row('Address',esc(c.address).replace(/\n/g,'<br>'))}${row('Province',esc(c.province))}${row('Corporation number',esc(c.corpNumber))}${row('Business number',esc(c.bn))}${row('Contact',esc(c.contact))}${row('Industry',esc(c.industry))}${row('Ownership',esc(c.owners).replace(/\n/g,'<br>'))}</tbody></table></div></div>`;
  h+=`</div>`;
  // File sign-offs
  const signBtn=(k,label)=>so[k]?`<span class="pill paid">${esc(T(label))}</span> <span class="muted">${yfStamp(so[k])}</span>${edit?` <button class="btn sm" data-yfsign="${k}" data-off="1">Remove</button>`:''}`:edit&&(k!=='reviewed'||yfLeadMe(f))?`<button class="btn sm" data-yfsign="${k}">${esc(T('Sign off as '+label.toLowerCase()))}</button>`:`<span class="muted">${esc(T('Not signed off'))}</span>`;
  h+=`<div class="panel" style="margin-top:16px"><div class="toolbar"><b class="grow">${esc(T('Sign-offs'))}</b></div><div class="tbl-wrap"><table><tbody><tr><td style="width:38%">${esc(T('Prepared by'))}</td><td>${signBtn('prepared','Prepared')}</td></tr><tr><td>${esc(T('Reviewed by'))}</td><td>${signBtn('reviewed','Reviewed')}</td></tr><tr><td>${esc(T('Final'))}</td><td>${yfFinal(f)?`<span class="pill paid">${esc(T('Final'))}</span> <span class="muted">${esc(f.finalBy)} · ${esc(fmtDate(iso(new Date(f.finalAt))))}</span>`:'<span class="muted">'+esc(T('Not final yet'))+'</span>'}</td></tr></tbody></table></div><div class="pad muted" style="font-size:12.5px">${esc(T('Sign-offs record who did what and when in Sumlora’s activity log. They aren’t electronic signatures.'))}</div></div>`;
  if((f.unlocks||[]).length)h+=`<div class="panel" style="margin-top:16px"><div class="toolbar"><b class="grow">${esc(T('Reopened after being final'))}</b></div><div class="tbl-wrap"><table><thead><tr><th>${esc(T('When'))}</th><th>${esc(T('Who'))}</th><th>${esc(T('Reason'))}</th></tr></thead><tbody>${f.unlocks.slice().reverse().map(u=>`<tr><td>${esc(fmtDate(iso(new Date(u.at))))}</td><td>${esc(u.by)}</td><td>${esc(u.reason)}</td></tr>`).join('')}</tbody></table></div></div>`;
  return h;
}
function yfDetailsForm(f){
  const c=f.client||{},tm=f.team||{},team=S.team||[];
  const who=(id,sel)=>`<select id="${id}"><option value="">${esc(T('Not assigned'))}</option>${team.map(u=>`<option value="${esc(u.id)}" ${sel&&sel.id===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}</select>`;
  const inp=(k,label,big)=>fld('yc_'+k,label,big?`<textarea id="yc_${k}" rows="2" maxlength="1000">${esc(c[k]||'')}</textarea>`:`<input type="text" id="yc_${k}" value="${esc(c[k]||'')}" maxlength="200">`,big);
  const m=openModal('Engagement details',`<div class="fields">${fld('ydKind','Engagement',`<select id="ydKind">${Object.entries(TallyEngage.KINDS).map(([k,v])=>`<option value="${k}" ${f.kind===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}${fld('ydEnt','Entity',`<select id="ydEnt">${Object.entries(TallyEngage.ENTITIES).map(([k,v])=>`<option value="${k}" ${yfEntity(f)===k?'selected':''}>${esc(T(v.label))}</option>`).join('')}</select>`)}${fld('ydFw','Accounting framework',`<select id="ydFw">${Object.entries(TallyEngage.FRAMEWORKS).map(([k,v])=>`<option value="${k}" ${(f.framework||'ASPE')===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}${fld('ydPrep','Preparer',who('ydPrep',tm.preparer))}${fld('ydRev','Reviewer',who('ydRev',tm.reviewer))}</div>
    <h3 style="margin:14px 0 6px">${esc(T('Client'))}</h3><div class="muted" style="font-size:13px;margin-bottom:8px">${esc(T('Kept with this year-end file only; the company’s own settings don’t change.'))}</div><div class="fields">${inp('legalName','Legal name')}${inp('operatingName','Operating name')}${inp('address','Address',true)}${inp('province','Province')}${inp('corpNumber','Corporation number')}${inp('bn','Business number')}${inp('contact','Contact')}${inp('industry','Industry')}${inp('owners','Ownership',true)}</div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>','wide');
  m.onsubmit=async e=>{e.preventDefault();
    const pick=id=>{const v=$('#'+id,m).value,u=team.find(x=>x.id===v);return u?{id:u.id,name:u.name}:null};
    const client=Object.fromEntries(['legalName','operatingName','address','province','corpNumber','bn','contact','industry','owners'].map(k=>[k,$('#yc_'+k,m).value.trim()]));
    if(await yfSave(f,{entity:$('#ydEnt',m).value,kind:$('#ydKind',m).value,framework:$('#ydFw',m).value,team:{preparer:pick('ydPrep'),reviewer:pick('ydRev')},client}))closeModal()};
}
function yfReopenForm(f){
  const m=openModal('Reopen this year-end file',`${fld('yrReason','Why is it being reopened?',`<textarea id="yrReason" rows="3" maxlength="1000" required placeholder="e.g. Client sent a late invoice for the year"></textarea>`,true)}<div class="muted" style="font-size:13px">${esc(T('The reason, who reopened it and when are kept with the file and in the activity log.'))}</div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Reopen</button>','small');
  m.onsubmit=async e=>{e.preventDefault();const r=$('#yrReason',m).value.trim();if(!r)return m.err('Say why the file is being reopened.');
    if(await yfSave(f,{status:'progress',unlockReason:r}))closeModal()};
}

/* ---------- working papers ---------- */
function yfWorkpapers(f,edit){
  const wps=TallyEngage.workingPapers(f,S.accounts);
  if(!wps.some(w=>w.code===YF.wp))YF.wp=wps[0]?wps[0].code:'';
  const notesOn=c=>(f.reviewNotes||[]).filter(n=>n.wp===c&&TallyEngage.openNote(n)).length;
  const icon=w=>w.wp.reviewed?'<span class="pos" title="Reviewed">✓✓</span>':w.wp.prepared?'<span class="pos" title="Prepared">✓</span>':'<span class="muted">○</span>';
  const tree=wps.map(w=>{const n=notesOn(w.code),dc=yfDocs(f,w.code).length;return `<button class="yf-wp${w.code===YF.wp?' on':''}" data-yfwp="${esc(w.code)}"><span>${icon(w)}</span><span class="grow"><b>${esc(w.code)}</b> ${esc(T(w.label))}</span>${dc?`<span class="muted" title="Documents">📎${dc}</span>`:''}${n?`<span class="count">${n}</span>`:''}</button>`}).join('');
  const w=wps.find(x=>x.code===YF.wp);
  return `<div class="yf-split"><nav class="panel yf-tree" aria-label="Working papers">${tree}</nav><div>${w?yfWpPanel(f,w,edit):''}</div></div>`;
}
function yfWpPanel(f,w,edit){
  const wp=w.wp,ticks=wp.ticks||{};
  const tickSel=a=>edit?`<select data-yftick="${esc(a)}" aria-label="Tickmark" class="yf-tick"><option value="">–</option>${Object.entries(TallyEngage.TICKS).map(([k,t])=>`<option value="${k}" ${ticks[a]===k?'selected':''} title="${esc(T(t.label))}">${esc(t.mark)}</option>`).join('')}</select>`:esc((TallyEngage.TICKS[ticks[a]]||{}).mark||'');
  let h=`<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(w.code)} · ${esc(T(w.label))}</b>${edit?`<select data-yfwpstatus aria-label="Status">${Object.entries(TallyEngage.WP_STATUS).map(([k,v])=>`<option value="${k}" ${(wp.status||'notstarted')===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`:esc(T(TallyEngage.WP_STATUS[wp.status||'notstarted']))}</div>`;
  if(w.lines.length){
    h+=`<div class="tbl-wrap"><table><thead><tr><th style="width:44px"></th><th>${esc(T('Account'))}</th><th class="n">${esc(T('Prior year'))}</th><th class="n">${esc(T('Unadjusted'))}</th><th class="n">${esc(T('Adjustments'))}</th><th class="n">${esc(T('Final'))}</th></tr></thead><tbody>${w.lines.map(r=>`<tr><td>${tickSel(r.account)}</td><td>${yfName(r)}</td><td class="n">${mcell(r.prior)}</td><td class="n">${mcell(r.cur)}</td><td class="n">${r.adj?mcell(r.adj):''}</td><td class="n">${mcell(r.final)}</td></tr>`).join('')}<tr class="tot"><td></td><td>${esc(T('Total'))}</td><td class="n">${mcell(w.prior)}</td><td class="n">${mcell(w.cur)}</td><td class="n">${w.adj?mcell(w.adj):''}</td><td class="n">${mcell(w.final)}</td></tr></tbody></table></div>`;
    h+=`<div class="pad muted" style="font-size:12px">${Object.values(TallyEngage.TICKS).map(t=>`<b>${esc(t.mark)}</b> ${esc(T(t.label))}`).join(' · ')}</div>`;
  }
  h+=`</div>`;
  if(w.code==='G')h+=yfContinuityPanel(f,edit)+yfRegisterPanel(f);
  if(w.code==='GEN')h+=yfLettersPanel(f,edit);
  // Notes, comments and cross-references
  h+=`<div class="panel" style="margin-bottom:16px"><div class="pad" style="display:grid;gap:10px">
    <label style="display:grid;gap:4px"><span class="flabel">${esc(T('Work done and conclusion'))}</span><textarea data-yfwpf="notes" rows="5" maxlength="20000" ${edit?'':'disabled'} placeholder="${esc(T('What was checked, what it was agreed to, and the conclusion'))}">${esc(wp.notes||'')}</textarea></label>
    <label style="display:grid;gap:4px"><span class="flabel">${esc(T('Comments'))}</span><textarea data-yfwpf="comment" rows="2" maxlength="4000" ${edit?'':'disabled'}>${esc(wp.comment||'')}</textarea></label>
    <label style="display:grid;gap:4px"><span class="flabel">${esc(T('References to other working papers'))}</span><input type="text" data-yfwpf="refs" value="${esc(wp.refs||'')}" maxlength="300" ${edit?'':'disabled'} placeholder="${esc(T('e.g. See AJE 2; agrees to C-1 aging'))}"></label>
    ${edit?'<div><button class="btn primary sm" data-yfwpsave>Save notes</button></div>':''}</div></div>`;
  // Documents
  const docs=yfDocs(f,w.code);
  h+=`<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Supporting documents'))}</b>${edit?`<label class="btn sm">${esc(T('Attach…'))}<input type="file" data-yfupload hidden multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.docx"></label>${S.receipts.length?` <button class="btn sm" data-yfrcpick>${esc(T('From Receipts…'))}</button>`:''}`:''}</div><div class="tbl-wrap"><table><tbody>${docs.map(a=>`<tr><td><a href="${esc(coUrl('/api/files/'+a.fileId))}" target="_blank" rel="noopener">${esc(a.name)}</a></td><td class="muted">${esc(a.uploadedByName||'')} · ${esc(fmtDate(iso(new Date(a.uploadedAt))))}</td><td class="n">${edit?`<button class="btn sm" data-yfdocdel="${esc(a.id)}">Remove</button>`:''}</td></tr>`).join('')||emptyRow(3,'No documents yet','Attach bank statements, listings, loan statements, invoices or minutes (PDF, photos, Excel or Word, up to 10 MB each).')}</tbody></table></div></div>`;
  // Sign-offs and review notes on this working paper
  const sb=(k,l)=>wp[k]?`<span class="pill paid">${esc(T(l))}</span> <span class="muted">${yfStamp(wp[k])}</span>${edit?` <button class="btn sm" data-yfwpsign="${k}" data-off="1">Remove</button>`:''}`:edit?`<button class="btn sm" data-yfwpsign="${k}">${esc(T('Sign off as '+l.toLowerCase()))}</button>`:`<span class="muted">${esc(T('Not signed off'))}</span>`;
  h+=`<div class="panel" style="margin-bottom:16px"><div class="tbl-wrap"><table><tbody><tr><td style="width:38%">${esc(T('Prepared by'))}</td><td>${sb('prepared','Prepared')}</td></tr><tr><td>${esc(T('Reviewed by'))}</td><td>${sb('reviewed','Reviewed')}</td></tr></tbody></table></div></div>`;
  const notes=(f.reviewNotes||[]).filter(n=>n.wp===w.code);
  h+=`<div class="panel"><div class="toolbar"><b class="grow">${esc(T('Review notes'))}</b>${edit?`<button class="btn sm" data-yfnote="new" data-wp="${esc(w.code)}">+ ${esc(T('Review note'))}</button>`:''}</div>${yfNotesTable(notes,edit)}</div>`;
  return h;
}
async function yfUpload(f,files){
  const wp=YF.wp;let n=0;
  for(const file of files){
    if(file.size>10*1024*1024){toast(`${file.name} is over 10 MB.`,true);continue}
    const data=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=rej;r.readAsDataURL(file)});
    try{await api('POST','/api/attachments',{target:'engagements',targetId:f.id,wp,fileName:file.name,data});n++}catch(err){toast(`${file.name}: ${err.message}`,true)}
  }
  if(n){await load();toast(n===1?'Document attached':`${n} documents attached`)}
}

/* ---------- review notes ---------- */
function yfNotesTable(notes,edit){
  const pri=p=>`<span class="pill ${p==='high'?'overdue':p==='low'?'quiet':'open'}">${esc(T(TallyEngage.PRIORITY[p]))}</span>`;
  const st=n=>`<span class="pill ${TallyEngage.openNote(n)?'partial':'paid'}">${esc(T(TallyEngage.NOTE_STATUS[n.status]))}</span>`;
  return `<div class="tbl-wrap"><table><thead><tr><th>No.</th><th>${esc(T('Working paper'))}</th><th>${esc(T('Note'))}</th><th>${esc(T('Assigned to'))}</th><th>${esc(T('Priority'))}</th><th>${esc(T('Status'))}</th><th></th></tr></thead><tbody>${notes.slice().sort((a,b)=>a.num-b.num).map(n=>`<tr><td class="mono" style="white-space:nowrap">RN ${n.num}</td><td>${n.wp?`<button class="link" data-yfgowp="${esc(n.wp)}">${esc(n.wp)}</button>`:''}</td><td>${esc(n.text)}${n.resolution?`<div class="muted" style="font-size:12.5px">${esc(T('Resolution'))}: ${esc(n.resolution)}</div>`:''}<div class="muted" style="font-size:12px">${n.created?esc(T('Raised'))+' '+yfStamp(n.created):''}${n.resolved?' · '+esc(T('Resolved'))+' '+yfStamp(n.resolved):''}</div></td><td>${esc(n.assigneeName||'')}</td><td>${pri(n.priority)}</td><td>${st(n)}</td><td class="n">${edit?`<button class="btn sm" data-yfnote="${esc(n.id)}">${esc(T('Open'))}</button>`:''}</td></tr>`).join('')||emptyRow(7,'No review notes','Raise a review note for anything the preparer should look at or the client should answer.')}</tbody></table></div>`;
}
function yfReviewNotes(f,edit){
  const R=YF.rn,team=S.team||[];
  let list=(f.reviewNotes||[]).filter(n=>(R.show==='all'||TallyEngage.openNote(n))&&(!R.who||n.assignee===R.who)&&(!R.pri||n.priority===R.pri)&&(!R.wp||n.wp===R.wp));
  const wps=TallyEngage.workingPapers(f,S.accounts);
  const bar=`<div class="toolbar"><select data-yfrn="show" aria-label="Show"><option value="open" ${R.show==='open'?'selected':''}>${esc(T('Open items'))}</option><option value="all" ${R.show==='all'?'selected':''}>${esc(T('All notes'))}</option></select><select data-yfrn="who" aria-label="Assigned to"><option value="">${esc(T('Anyone'))}</option>${team.map(u=>`<option value="${esc(u.id)}" ${R.who===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}</select><select data-yfrn="pri" aria-label="Priority"><option value="">${esc(T('Any priority'))}</option>${Object.entries(TallyEngage.PRIORITY).map(([k,v])=>`<option value="${k}" ${R.pri===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select><select data-yfrn="wp" aria-label="Working paper"><option value="">${esc(T('Any working paper'))}</option>${wps.map(w=>`<option value="${esc(w.code)}" ${R.wp===w.code?'selected':''}>${esc(w.code+' · '+T(w.label))}</option>`).join('')}</select><span class="grow"></span>${edit?'<button class="btn primary" data-yfnote="new">+ Review note</button>':''}</div>`;
  return `<div class="panel">${bar}${yfNotesTable(list,edit)}</div>`;
}
function yfNoteForm(f,n,wp){
  const team=S.team||[],wps=TallyEngage.workingPapers(f,S.accounts);
  const m=openModal(n?`Review note ${n.num}`:'New review note',`<div class="fields">${fld('ynWp','Working paper',`<select id="ynWp"><option value="">${esc(T('The whole file'))}</option>${wps.map(w=>`<option value="${esc(w.code)}" ${(n?n.wp:wp)===w.code?'selected':''}>${esc(w.code+' · '+T(w.label))}</option>`).join('')}</select>`)}${fld('ynWho','Assigned to',`<select id="ynWho"><option value="">${esc(T('Not assigned'))}</option>${team.map(u=>`<option value="${esc(u.id)}" ${n&&n.assignee===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}</select>`)}${fld('ynPri','Priority',`<select id="ynPri">${Object.entries(TallyEngage.PRIORITY).map(([k,v])=>`<option value="${k}" ${(n?n.priority:'normal')===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}${fld('ynSt','Status',`<select id="ynSt">${Object.entries(TallyEngage.NOTE_STATUS).map(([k,v])=>`<option value="${k}" ${(n?n.status:'open')===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}${fld('ynText','Note',`<textarea id="ynText" rows="3" maxlength="4000" required>${esc(n?n.text:'')}</textarea>`,true)}${fld('ynRes','Resolution',`<textarea id="ynRes" rows="2" maxlength="4000">${esc(n?n.resolution:'')}</textarea>`,true)}</div>`,
    `${n?'<button type="button" class="btn danger" data-yndel>Delete</button>':''}<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>`);
  const del=$('[data-yndel]',m);if(del)del.onclick=async()=>{if(await confirmBox(`Delete review note ${n.num}?`,'It’s removed from the file. The activity log keeps the record.')&&await yfSave(f,{reviewNotes:f.reviewNotes.filter(x=>x.id!==n.id)}))closeModal()};
  m.onsubmit=async e=>{e.preventDefault();const text=$('#ynText',m).value.trim();if(!text)return m.err('Write the note.');
    const who=team.find(u=>u.id===$('#ynWho',m).value);
    const st=$('#ynSt',m).value,res=$('#ynRes',m).value.trim();
    if((st==='resolved'||st==='closed')&&!res)return m.err('Say how it was resolved.');
    const out={...(n||{}),id:n?n.id:uid(),num:n?n.num:Math.max(0,...(f.reviewNotes||[]).map(x=>x.num))+1,wp:$('#ynWp',m).value,text,assignee:who?who.id:'',assigneeName:who?who.name:'',priority:$('#ynPri',m).value,status:st,resolution:res};
    if(await yfSave(f,{reviewNotes:(f.reviewNotes||[]).filter(x=>x.id!==out.id).concat(out)}))closeModal()};
}

/* ---------- checklist ---------- */
function yfChecklist(f,edit){
  const groups=TallyEngage.checklist(f,S.accounts,S.attachments);
  const all=groups.flatMap(g=>g.items),done=all.filter(i=>i.done).length;
  return `<div class="panel"><div class="toolbar"><b class="grow">${esc(T('Completion checklist'))}</b><span class="muted">${done} / ${all.length} · ${Math.round(done/all.length*100)}%</span></div><div class="pad">${groups.map(g=>`<h3 style="margin:10px 0 6px">${esc(T(g.group))}</h3>${g.items.map(i=>`<label class="check" style="align-items:flex-start;margin:4px 0"><input type="checkbox" data-yfcheck="${i.key}" ${i.done?'checked':''} ${i.auto||!edit?'disabled':''}> <span>${esc(T(i.label))}${i.auto?` <span class="pill quiet">${esc(T('Automatic'))}</span>`:''}${i.by?` <span class="muted" style="font-size:12px">${yfStamp(i.by)}</span>`:''}</span></label>`).join('')}`).join('')}</div></div>`;
}

/* ---------- recurring adjusting entries from last year ---------- */
function yfRecurringPanel(f,edit){
  const prev=f.rolledFrom?yfFile(f.rolledFrom):S.engagements.filter(x=>x.yearEnd<f.yearEnd).sort((a,b)=>b.yearEnd.localeCompare(a.yearEnd))[0];
  if(!edit||!prev)return'';
  const have=new Set((f.ajes||[]).map(j=>j.fromId).filter(Boolean));
  const sug=(prev.ajes||[]).filter(j=>j.recurring&&!have.has(j.id));
  if(!sug.length)return'';
  return `<div class="banner"><span><b>${esc(T('Recurring entries from last year'))}:</b> ${sug.map(j=>`${esc(j.memo||'AJE '+j.num)} (${money(j.lines.reduce((s,l)=>s+l.debit,0))}) <button class="btn sm" data-yfrecur="${esc(j.id)}">${esc(T('Add as a draft'))}</button>`).join(' ')}</span></div>`;
}

/* ---------- actions ---------- */
async function yfReviewClick(e,t,d,f){
  if(t.hasAttribute('data-yfdetails')){yfDetailsForm(f);return true}
  if(t.hasAttribute('data-yfcontnote')){const n=yfContinuityNote(f);const notes=(yfNotes(f)).filter(x=>x.title!==n.title).concat(n);if(await yfSave(f,{fsNotes:notes}))toast('Capital assets note added; edit it in Financial statements → Edit the report and notes');return true}
  if(d.yfsign){const so={...(f.signoffs||{}),[d.yfsign]:d.off?null:YF_SIGN};await yfSave(f,{signoffs:so});return true}
  if(d.yfwp){YF.wp=d.yfwp;renderMain();return true}
  if(d.yfgowp){YF.tab='wp';YF.wp=d.yfgowp;renderMain();return true}
  const wpOf=()=>({...((f.wps||{})[YF.wp]||{})});
  if(t.hasAttribute('data-yfwpsave')){const w=wpOf();for(const x of $$('[data-yfwpf]'))w[x.dataset.yfwpf]=x.value;if(await yfSave(f,{wps:{...(f.wps||{}),[YF.wp]:w}}))toast('Saved');return true}
  if(d.yfwpsign){const w=wpOf();w[d.yfwpsign]=d.off?null:YF_SIGN;if(!d.off&&(!w.status||w.status==='notstarted'))w.status=d.yfwpsign==='reviewed'?'done':'progress';await yfSave(f,{wps:{...(f.wps||{}),[YF.wp]:w}});return true}
  if(t.hasAttribute('data-yfrcpick')){yfReceiptPicker(f);return true}
  if(d.yfletter){yfLetterForm(f,d.yfletter);return true}
  if(d.yfletterpdf){await yfLetterPdf(f,d.yfletterpdf);return true}
  if(t.hasAttribute('data-yflogodel')){try{await api('PUT','/api/firm/logo',{data:''});ME.firmLogo=false;YF_LOGO=null;toast('Logo removed');renderMain()}catch(err){toast(err.message,true)}return true}
  if(d.yfdocdel){const a=S.attachments.find(x=>x.id===d.yfdocdel);if(a&&await confirmBox(`Remove ${a.name}?`,'The document is deleted from this year-end file.','Remove'))await del('attachments',a.id);return true}
  if(d.yfnote){yfNoteForm(f,d.yfnote==='new'?null:(f.reviewNotes||[]).find(x=>x.id===d.yfnote),d.wp||'');return true}
  if(d.yfrecur){const prev=S.engagements.find(x=>(x.ajes||[]).some(j=>j.id===d.yfrecur));const j=prev&&prev.ajes.find(x=>x.id===d.yfrecur);if(!j)return true;
    const out={id:uid(),fromId:j.id,num:Math.max(0,...(f.ajes||[]).map(x=>x.num))+1,date:f.yearEnd,memo:j.memo,explanation:j.explanation||'',wp:j.wp||'',recurring:true,lines:j.lines.map(l=>({...l})),entryId:''};
    if(await yfSave(f,{ajes:(f.ajes||[]).concat(out)}))toast('Added as a draft. Check the amounts for this year.');return true}
  return false;
}
/** Changes on the review screens: filters, working paper status and tickmarks, checklist ticks, document uploads. */
function yfReviewBind(m){
  const f=YF.open&&yfFile(YF.open);if(!f)return;
  $$('[data-yfrn]',m).forEach(s=>s.onchange=()=>{YF.rn[s.dataset.yfrn]=s.value;renderMain()});
  const wpSave=patch=>{const w={...((f.wps||{})[YF.wp]||{}),...patch};return yfSave(f,{wps:{...(f.wps||{}),[YF.wp]:w}})};
  const st=$('[data-yfwpstatus]',m);if(st)st.onchange=()=>wpSave({status:st.value});
  $$('[data-yftick]',m).forEach(s=>s.onchange=()=>{const ticks={...(((f.wps||{})[YF.wp]||{}).ticks||{})};if(s.value)ticks[s.dataset.yftick]=s.value;else delete ticks[s.dataset.yftick];wpSave({ticks})});
  $$('[data-yfcheck]',m).forEach(c=>c.onchange=()=>{const cl={...(f.checklist||{})};if(c.checked)cl[c.dataset.yfcheck]=YF_SIGN;else delete cl[c.dataset.yfcheck];yfSave(f,{checklist:cl})});
  const cfb=$('[data-yfcf]',m);if(cfb)cfb.onchange=()=>yfSave(f,{includeCashFlow:cfb.checked});
  const up=$('[data-yfupload]',m);if(up)up.onchange=()=>{const files=[...up.files];up.value='';if(files.length)yfUpload(f,files)};
}

/* ---------- capital assets continuity ---------- */
/** The year's debits and credits on each account from the books, without entries posted from this file (those are its AJEs). */
function yfActivity(f){
  if(f.snapshot.source&&f.snapshot.source!=='books')return null;
  const from=fyStartOf(f.yearEnd),to=f.yearEnd,skip=new Set((f.ajes||[]).map(j=>j.entryId).filter(Boolean)),out={};
  for(const p of postings()){if(p.date<from||p.date>to||skip.has(p.e.id))continue;const a=out[p.account]=out[p.account]||{debits:0,credits:0};a.debits=r2(a.debits+p.debit);a.credits=r2(a.credits+p.credit)}
  return out;
}
function yfContinuityPanel(f,edit){
  const c=TallyEngage.continuity(f,S.accounts,yfActivity(f));
  if(!c.cost.length&&!c.accum.length)return'';
  const cell=v=>Math.abs(v)>=0.005?money(v):'';
  const rows=(list,upL,downL,tot,head)=>`<tr class="sec"><td colspan="6">${esc(T(head))}</td></tr>${list.map(r=>`<tr><td>${yfName(r)}</td><td class="n">${money(r.open)}</td><td class="n">${cell(r.up)}</td><td class="n">${cell(r.down)}</td><td class="n">${cell(r.other)}</td><td class="n">${money(r.close)}</td></tr>`).join('')}<tr class="tot"><td>${esc(T('Total'))}</td><td class="n">${money(tot.open)}</td><td class="n">${cell(tot.up)}</td><td class="n">${cell(tot.down)}</td><td class="n">${cell(tot.other)}</td><td class="n">${money(tot.close)}</td></tr>`;
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Continuity schedule'))}</b>${edit?'<button class="btn sm" data-yfcontnote>'+esc(T('Add to the notes'))+'</button>':''}</div><div class="tbl-wrap"><table><thead><tr><th></th><th class="n">${esc(T('Opening'))}</th><th class="n">${esc(T('Additions / amortization'))}</th><th class="n">${esc(T('Disposals'))}</th><th class="n">${esc(T('Other'))}</th><th class="n">${esc(T('Closing'))}</th></tr></thead><tbody>
    ${rows(c.cost,'Additions','Disposals',c.totals.cost,'Cost')}${c.accum.length?rows(c.accum,'Amortization','Disposals',c.totals.accum,'Accumulated amortization'):''}
    <tr class="grand"><td>${esc(T('Net book value'))}</td><td class="n">${money(c.totals.nbv.open)}</td><td></td><td></td><td></td><td class="n">${money(c.totals.nbv.close)}</td></tr></tbody></table></div><div class="pad muted" style="font-size:12px">${esc(T(yfActivity(f)?'Additions and disposals are the year’s debits and credits in the books, plus this file’s adjusting entries.':'From an imported trial balance, each account’s change for the year is shown as an addition or disposal.'))}</div></div>`;
}
/** A capital assets note from the continuity schedule. */
function yfContinuityNote(f){
  const c=TallyEngage.continuity(f,S.accounts,yfActivity(f)),t=c.totals,ye=fmtDate(f.yearEnd),pe=fmtDate(yfPriorEnd(f));
  const lines=c.cost.map(r=>{const a=c.accum.find(x=>x.name.toLowerCase().includes(r.name.toLowerCase().split(' ')[0]));return `${r.name}: cost ${money(r.close)}${a?`, accumulated amortization ${money(a.close)}, net ${money(r2(r.close-a.close))}`:''}`});
  return{title:'Capital assets',text:`${lines.join('\n')}\n\nNet book value: ${money(t.nbv.close)} at ${ye} (${money(t.nbv.open)} at ${pe}). Additions in the year: ${money(t.cost.up)}. Amortization for the year: ${money(t.accum.up)}.`};
}

/* ---------- analysis and AI suggestions ---------- */
const YF_AI={points:null,busy:false,for:''};
/** Postings in the books for the unusual-transaction check. */
function yfPostingsForAnalysis(){
  const names=new Map(S.accounts.map(a=>[a.id,a.name]));
  return postings().map(p=>({entryId:p.e.id,date:p.date,account:p.account,name:names.get(p.account)||'',amount:r2(p.debit-p.credit),memo:p.memo||p.e.memo||''}));
}
function yfAnalysis(f,edit){
  const fromBooks=!f.snapshot.source||f.snapshot.source==='books';
  const mt=f.materiality||{},st=TallyEngage.statements(f,S.accounts);
  // A starting point for the threshold: 1% of revenue, or 0.5% of total assets when there's little revenue.
  const sugg=Math.max(500,Math.round((st.is.revenue.cur>st.bs.assets.cur/2?st.is.revenue.cur*0.01:st.bs.assets.cur*0.005)/100)*100);
  const minChange=mt.amount>0?mt.amount:1000,minPct=mt.pct>0?mt.pct:20;
  const finds=TallyEngage.analyze(f,S.accounts,S.attachments,{activity:yfActivity(f),minChange,minPct});
  const odd=fromBooks?TallyEngage.unusual(yfPostingsForAnalysis(),fyStartOf(f.yearEnd),f.yearEnd):[];
  const KIND={variance:'Changes from last year',sign:'Balances on the unusual side',mapping:'Possible classification problems',docs:'Missing supporting documents',aje:'Adjusting entries',checklist:'Not finished yet'};
  const raise=(text,wp,pri)=>edit?`<button class="btn sm" data-yfraise="${esc(text)}" data-wp="${esc(wp||'')}" data-pri="${esc(pri||'normal')}">${esc(T('Raise a review note'))}</button>`:'';
  let h=`<div class="banner" style="background:var(--info-soft)"><span>${esc(T('These are pointers for your review, worked out from the figures. They’re not conclusions; you decide what matters.'))}</span></div>`;
  h+=`<div class="panel" style="margin-bottom:16px"><div class="toolbar" style="flex-wrap:wrap"><b class="grow">${esc(T('Materiality for this file'))}</b><label>${esc(T('Flag changes over'))} $<input type="number" min="0" step="100" data-yfmat="amount" value="${minChange}" style="width:110px" ${edit?'':'disabled'}></label><label>${esc(T('and'))} <input type="number" min="0" max="100" step="1" data-yfmat="pct" value="${minPct}" style="width:70px" ${edit?'':'disabled'}> %</label>${edit?'<button class="btn sm" data-yfmatsave>'+esc(T('Save'))+'</button>':''}<span class="muted" style="font-size:12.5px;flex-basis:100%">${esc(T('Suggested starting point'))}: ${money(sugg)} (${esc(T(st.is.revenue.cur>st.bs.assets.cur/2?'1% of revenue':'0.5% of total assets'))}). ${esc(T('Use your firm’s own materiality method if it has one.'))}</span></div></div>`;
  for(const [k,label] of Object.entries(KIND)){const list=finds.filter(x=>x.kind===k);if(!list.length)continue;
    h+=`<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T(label))}</b><span class="muted">${list.length}</span></div><div class="tbl-wrap"><table><tbody>${list.map(x=>`<tr><td style="width:40px">${x.wp?`<button class="link" data-yfgowp="${esc(x.wp)}">${esc(x.wp)}</button>`:''}</td><td>${x.level==='high'?'<span class="pill overdue">'+esc(T('High'))+'</span> ':''}${esc(x.text)}</td><td class="n">${k==='checklist'?'':raise(x.text,x.wp,x.level)}</td></tr>`).join('')}</tbody></table></div></div>`}
  if(fromBooks)h+=`<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Unusual transactions in the year'))}</b><span class="muted">${odd.length}</span></div><div class="tbl-wrap"><table><tbody>${odd.map(x=>`<tr><td>${esc(x.text)}</td><td class="n" style="white-space:nowrap"><button class="btn sm" data-entry="${esc(x.entryId)}">${esc(T('Open'))}</button>${raise(x.text,'','normal')}</td></tr>`).join('')||emptyRow(2,'Nothing unusual found','No possible duplicates, and no postings far bigger than usual for their account.')}</tbody></table></div></div>`;
  // AI
  const aiOk=feat('ai');
  h+=`<div class="panel"><div class="toolbar"><b class="grow">${esc(T('AI review points'))}</b>${aiOk?`<button class="btn primary sm" data-yfai ${YF_AI.busy?'disabled':''}>${esc(T(YF_AI.busy?'Thinking…':'Ask AI'))}</button>`:inPlanPill('ai')}</div>`;
  if(YF_AI.points&&YF_AI.for===f.id)h+=`<div class="pad muted" style="font-size:12.5px">${esc(T('AI suggestions – check each one before using it. Nothing has been changed in the file.'))}</div><div class="tbl-wrap"><table><tbody>${YF_AI.points.map(p=>`<tr><td style="width:40px">${p.wp?`<button class="link" data-yfgowp="${esc(p.wp)}">${esc(p.wp)}</button>`:''}</td><td>${p.priority==='high'?'<span class="pill overdue">'+esc(T('High'))+'</span> ':''}${esc(p.text)}</td><td class="n">${raise(p.text,p.wp,p.priority)}</td></tr>`).join('')||emptyRow(3,'No suggestions','The AI had nothing to add.')}</tbody></table></div>`;
  else h+=`<div class="pad muted">${esc(T('AI reads the leadsheets, adjusting entries and the findings above, and suggests questions to ask and things to check. It only suggests; it never changes the file.'))}</div>`;
  return h+`</div>`;
}
async function yfAiReview(f){
  YF_AI.busy=true;renderMain();
  try{const r=await api('POST',`/api/engagements/${encodeURIComponent(f.id)}/ai`,{task:'review'});YF_AI.points=r.points||[];YF_AI.for=f.id}
  catch(err){toast(err.message,true)}
  YF_AI.busy=false;renderMain();
}
/** An AI draft for one note, put into the notes form for the accountant to edit; nothing is saved until they save. */
async function yfAiNote(f,title){
  try{const r=await api('POST',`/api/engagements/${encodeURIComponent(f.id)}/ai`,{task:'note',title});return r.text||''}
  catch(err){toast(err.message,true);return''}
}
async function yfAnalysisClick(e,t,d,f){
  if(t.hasAttribute('data-yfmatsave')){const v=k=>+($(`[data-yfmat=${k}]`).value)||0;if(await yfSave(f,{materiality:{amount:v('amount'),pct:v('pct')}}))toast('Materiality saved');return true}
  if(t.hasAttribute('data-yfai')){await yfAiReview(f);return true}
  if(d.yfraise!==undefined){const num=Math.max(0,...(f.reviewNotes||[]).map(x=>x.num))+1,prep=f.team&&f.team.preparer;
    const n={id:uid(),num,wp:d.wp||'',text:d.yfraise,assignee:prep?prep.id:'',assigneeName:prep?prep.name:'',priority:d.pri||'normal',status:'open',resolution:''};
    if(await yfSave(f,{reviewNotes:(f.reviewNotes||[]).concat(n)}))toast(`Review note ${num} raised${prep?' for '+prep.name:''}`);return true}
  return false;
}

/* ---------- receipts (phone photos, emailed receipts) on working papers ---------- */
function yfReceiptPicker(f){
  const list=S.receipts.slice().sort((a,b)=>(b.uploadedAt||0)-(a.uploadedAt||0)).slice(0,200);
  const m=openModal('Attach from Receipts',`<div class="muted" style="font-size:13px;margin-bottom:8px">${esc(T('Receipts photographed in the Sumlora app, emailed in, or uploaded. A copy goes on this working paper; the receipt stays where it is.'))}</div><div class="tbl-wrap" style="max-height:420px;overflow:auto"><table><tbody>${list.map(r=>{const d=r.draft||{};return `<tr><td><input type="checkbox" data-rcp="${esc(r.id)}" aria-label="Choose"></td><td>${esc(r.fileName||'Receipt')}<div class="muted" style="font-size:12px">${esc([d.vendor,d.date&&fmtDate(d.date),d.total!=null&&d.total!==''?money(+d.total):'',r.uploadedByName].filter(Boolean).join(' · '))}</div></td><td class="muted">${esc(fmtDate(iso(new Date(r.uploadedAt||Date.now()))))}</td></tr>`}).join('')}</tbody></table></div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Attach</button>','wide');
  m.onsubmit=async e=>{e.preventDefault();const ids=$$('[data-rcp]',m).filter(x=>x.checked).map(x=>x.dataset.rcp);if(!ids.length)return m.err('Choose at least one receipt.');
    let n=0;for(const id of ids){try{await api('POST','/api/attachments',{target:'engagements',targetId:f.id,wp:YF.wp,receiptId:id});n++}catch(err){m.err(err.message)}}
    if(n){closeModal();await load();toast(n===1?'Receipt attached':`${n} receipts attached`)}};
}

/* ---------- engagement and representation letters ---------- */
const YF_LETTERS={engagement:'engagement-letter',representation:'representation-letter'};
function yfLetter(f,which){
  const l=(f.letters||{})[which]||{},t=TallyReportTemplates.BY_ID[l.template]&&(l.custom||yfFinal(f))?TallyReportTemplates.BY_ID[l.template]:TallyReportTemplates.current(YF_LETTERS[which],f.yearEnd);
  const date=l.date||'',ctx={entity:(f.client&&f.client.legalName)||S.company.name||'',yearEnd:fmtDate(f.yearEnd),statements:yfStatementWords(f),firm:(f.report&&f.report.signer)||(ME&&ME.firmName)||'',city:(f.report&&f.report.city)||'',date:date?fmtDate(date):fmtDate(today())};
  return{title:t.title,label:t.label,template:t.id,custom:!!l.custom,date,text:l.custom&&l.text?l.text:TallyReportTemplates.render(t,ctx)};
}
function yfLettersPanel(f,edit){
  const row=w=>{const L=yfLetter(f,w);return `<tr><td><b>${esc(T(L.title))}</b><div class="muted" style="font-size:12px">${esc(L.custom?T('Your firm’s wording'):L.label)}${L.date?' · '+esc(fmtDate(L.date)):''}</div></td><td class="n" style="white-space:nowrap">${edit?`<button class="btn sm" data-yfletter="${w}">${esc(T('Edit'))}</button>`:''}<button class="btn sm" data-yfletterpdf="${w}">PDF</button></td></tr>`};
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Letters'))}</b></div><div class="tbl-wrap"><table><tbody>${row('engagement')}${row('representation')}</tbody></table></div><div class="pad muted" style="font-size:12px">${esc(T('Filled in from this file. Have the client sign them, then attach the signed copies below.'))}</div></div>`;
}
function yfLetterForm(f,which){
  const L=yfLetter(f,which);
  const m=openModal(T(L.title),`<div class="fields">${fld('ylDate','Date',`<input type="date" id="ylDate" value="${esc(L.date)}">`)}<label class="check" style="grid-column:1/-1"><input type="checkbox" id="ylCustom" ${L.custom?'checked':''}> ${esc(T('Use my own wording for this file'))}</label>${fld('ylText',L.title,`<textarea id="ylText" rows="18" maxlength="12000" ${L.custom?'':'readonly'}>${esc(L.text)}</textarea><span class="hint">${esc(T('Replace [fee] and [when] with your terms. Standard wording')+': '+L.label)}</span>`,true)}</div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>','wide');
  $('#ylCustom',m).onchange=()=>{$('#ylText',m).readOnly=!$('#ylCustom',m).checked};
  m.onsubmit=async e=>{e.preventDefault();const custom=$('#ylCustom',m).checked;
    const letters={...(f.letters||{}),[which]:{custom,template:L.template,date:$('#ylDate',m).value,text:custom?$('#ylText',m).value:''}};
    if(await yfSave(f,{letters}))closeModal()};
}
/** The firm's logo (JPEG bytes) for the PDFs, fetched once. */
let YF_LOGO=null;
async function yfLoadLogo(){
  if(!(ME&&ME.firmLogo))return YF_LOGO=null;
  if(YF_LOGO)return YF_LOGO;
  try{const r=await fetch('/api/firm/logo');if(r.ok)YF_LOGO=new Uint8Array(await r.arrayBuffer())}catch(e){YF_LOGO=null}
  return YF_LOGO;
}
async function yfLetterPdf(f,which){
  const L=yfLetter(f,which),logo=await yfLoadLogo();
  const doc=TallyPDF.create(),W0=doc.width,H0=doc.height,M=64;let y=M;
  if(logo){const sz=doc.image(logo,M,y-10,140,50);if(sz)y+=sz.h}
  doc.text(W0-M,M,(f.report&&f.report.signer)||(ME&&ME.firmName)||'',{size:11,bold:true,align:'right'});y+=24;
  for(const line of doc.wrap(L.text,W0-2*M,10.5)){if(y>H0-M){doc.addPage();y=M}doc.text(M,y,line,{size:10.5});y+=15}
  const safe=String(S.company.name||'company').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();
  saveFile(`${safe}-${which}-letter-${f.yearEnd}.pdf`,new Blob([doc.output()],{type:'application/pdf'}));
}
/* The firm's logo, chosen in the report and notes form (owners): made into a small JPEG in the browser. */
async function yfLogoUpload(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('That picture couldn’t be read.'));i.src=url});
    const k=Math.min(1,600/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);
    const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);
    const data=c.toDataURL('image/jpeg',0.88).split(',')[1];
    await api('PUT','/api/firm/logo',{data});ME.firmLogo=true;YF_LOGO=null;toast('Logo saved');
  }catch(err){toast(err.message,true)}finally{URL.revokeObjectURL(url)}
}

/* ---------- the fixed asset register and CCA, on the Capital assets working paper ---------- */
function yfRegisterPanel(f){
  if(!S.assets.length||(f.snapshot.source&&f.snapshot.source!=='books'))return'';
  const ye=f.yearEnd,fy=fyStartOf(ye);
  const held=S.assets.filter(a=>a.acquired<=ye&&!(a.disposed&&a.disposed<=ye));
  const accumAt=a=>{const s=bookSchedule(a);let t=a.openingFy&&a.openingFy>fyStartOf(a.acquired)?+a.opening||0:0;for(const[y,v]of Object.entries(s))if(y<=fy)t=v.accum;return r2(t)};
  const rows=S.assets.filter(a=>a.acquired<=ye).sort((a,b)=>a.acquired.localeCompare(b.acquired)).map(a=>{const disp=a.disposed&&a.disposed<=ye,acc=disp?0:accumAt(a);
    return `<tr><td>${esc(a.name)}${a.acquired>=fy?` <span class="pill open">${esc(T('Added this year'))}</span>`:''}${disp?` <span class="pill quiet">${esc(T('Disposed'))} ${esc(fmtDate(a.disposed))}</span>`:''}</td><td class="mono">${esc(a.ccaClass||'')}</td><td>${esc(fmtDate(a.acquired))}</td><td class="n">${money(+a.cost)}</td><td class="n">${disp?'':money(acc)}</td><td class="n">${disp?'':money(r2(+a.cost-acc))}</td></tr>`}).join('');
  // The register's cost against the cost accounts on this working paper.
  const regCost=r2(held.reduce((t,a)=>t+(+a.cost||0),0)),cont=TallyEngage.continuity(f,S.accounts,yfActivity(f)),bookCost=cont.totals.cost.close,diff=r2(bookCost-regCost);
  const cca=typeof ccaSchedule==='function'?ccaSchedule(fy):[];
  const ccaRows=cca.map(r=>`<tr><td class="mono">${esc(r.k)}</td><td class="n">${r.rate}%</td><td class="n">${money(r.open)}</td><td class="n">${money(r.add)}</td><td class="n">${money(r.dis)}</td><td class="n">${money(r.cca)}</td><td class="n">${money(r.close)}</td></tr>`).join('');
  return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Fixed asset register'))}</b><button class="btn sm" data-go="assets">${esc(T('Open Fixed assets'))}</button></div>
    ${Math.abs(diff)>=0.01?`<div class="banner" style="margin:12px"><span>${esc(T('The register’s cost'))} (${money(regCost)}) ${esc(T('doesn’t agree with the cost accounts'))} (${money(bookCost)}): ${esc(T('difference'))} ${money(diff)}.</span></div>`:`<div class="pad muted"><span class="pos">✓</span> ${esc(T('The register agrees with the cost accounts'))} (${money(regCost)}).</div>`}
    <div class="tbl-wrap"><table><thead><tr><th>${esc(T('Asset'))}</th><th>${esc(T('CCA class'))}</th><th>${esc(T('Bought'))}</th><th class="n">${esc(T('Cost'))}</th><th class="n">${esc(T('Accumulated amortization'))}</th><th class="n">${esc(T('Net book value'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${ccaRows?`<div class="toolbar"><b class="grow">${esc(T('Capital cost allowance (Schedule 8)'))}</b></div><div class="tbl-wrap"><table><thead><tr><th>${esc(T('Class'))}</th><th class="n">${esc(T('Rate'))}</th><th class="n">${esc(T('Opening UCC'))}</th><th class="n">${esc(T('Additions'))}</th><th class="n">${esc(T('Disposals'))}</th><th class="n">CCA</th><th class="n">${esc(T('Closing UCC'))}</th></tr></thead><tbody>${ccaRows}<tr class="tot"><td colspan="5">${esc(T('Total'))}</td><td class="n">${money(cca.reduce((t,r)=>t+r.cca,0))}</td><td class="n">${money(cca.reduce((t,r)=>t+r.close,0))}</td></tr></tbody></table></div>`:''}</div>`;
}
