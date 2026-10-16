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
  const c=f.client||{},tm=f.team||{},so=f.signoffs||{};
  const row=(l,v)=>`<tr><td class="muted" style="width:38%">${esc(T(l))}</td><td>${v||'<span class="muted">—</span>'}</td></tr>`;
  h+=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">`;
  h+=`<div class="panel"><div class="toolbar"><b class="grow">${esc(T('Engagement'))}</b>${edit?'<button class="btn sm" data-yfdetails>Edit</button>':''}</div><div class="tbl-wrap"><table><tbody>${row('Engagement',esc(T(yfKind(f.kind))))}${row('Accounting framework',esc(T(TallyEngage.FRAMEWORKS[f.framework||'ASPE'])))}${row('Fiscal year-end',esc(fmtDate(f.yearEnd)))}${row('Preparer',yfPerson(tm.preparer))}${row('Reviewer',yfPerson(tm.reviewer))}${row('Status',yfStatusPill(f))}${row('Created',f.created?esc(fmtDate(iso(new Date(f.created)))):'')}</tbody></table></div></div>`;
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
  const m=openModal('Engagement details',`<div class="fields">${fld('ydKind','Engagement',`<select id="ydKind">${Object.entries(TallyEngage.KINDS).map(([k,v])=>`<option value="${k}" ${f.kind===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}${fld('ydFw','Accounting framework',`<select id="ydFw">${Object.entries(TallyEngage.FRAMEWORKS).map(([k,v])=>`<option value="${k}" ${(f.framework||'ASPE')===k?'selected':''}>${esc(T(v))}</option>`).join('')}</select>`)}${fld('ydPrep','Preparer',who('ydPrep',tm.preparer))}${fld('ydRev','Reviewer',who('ydRev',tm.reviewer))}</div>
    <h3 style="margin:14px 0 6px">${esc(T('Client'))}</h3><div class="muted" style="font-size:13px;margin-bottom:8px">${esc(T('Kept with this year-end file only; the company’s own settings don’t change.'))}</div><div class="fields">${inp('legalName','Legal name')}${inp('operatingName','Operating name')}${inp('address','Address',true)}${inp('province','Province')}${inp('corpNumber','Corporation number')}${inp('bn','Business number')}${inp('contact','Contact')}${inp('industry','Industry')}${inp('owners','Ownership',true)}</div>`,
    '<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button>','wide');
  m.onsubmit=async e=>{e.preventDefault();
    const pick=id=>{const v=$('#'+id,m).value,u=team.find(x=>x.id===v);return u?{id:u.id,name:u.name}:null};
    const client=Object.fromEntries(['legalName','operatingName','address','province','corpNumber','bn','contact','industry','owners'].map(k=>[k,$('#yc_'+k,m).value.trim()]));
    if(await yfSave(f,{kind:$('#ydKind',m).value,framework:$('#ydFw',m).value,team:{preparer:pick('ydPrep'),reviewer:pick('ydRev')},client}))closeModal()};
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
  // Notes, comments and cross-references
  h+=`<div class="panel" style="margin-bottom:16px"><div class="pad" style="display:grid;gap:10px">
    <label style="display:grid;gap:4px"><span class="flabel">${esc(T('Work done and conclusion'))}</span><textarea data-yfwpf="notes" rows="5" maxlength="20000" ${edit?'':'disabled'} placeholder="${esc(T('What was checked, what it was agreed to, and the conclusion'))}">${esc(wp.notes||'')}</textarea></label>
    <label style="display:grid;gap:4px"><span class="flabel">${esc(T('Comments'))}</span><textarea data-yfwpf="comment" rows="2" maxlength="4000" ${edit?'':'disabled'}>${esc(wp.comment||'')}</textarea></label>
    <label style="display:grid;gap:4px"><span class="flabel">${esc(T('References to other working papers'))}</span><input type="text" data-yfwpf="refs" value="${esc(wp.refs||'')}" maxlength="300" ${edit?'':'disabled'} placeholder="${esc(T('e.g. See AJE 2; agrees to C-1 aging'))}"></label>
    ${edit?'<div><button class="btn primary sm" data-yfwpsave>Save notes</button></div>':''}</div></div>`;
  // Documents
  const docs=yfDocs(f,w.code);
  h+=`<div class="panel" style="margin-bottom:16px"><div class="toolbar"><b class="grow">${esc(T('Supporting documents'))}</b>${edit?`<label class="btn sm">${esc(T('Attach…'))}<input type="file" data-yfupload hidden multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.docx"></label>`:''}</div><div class="tbl-wrap"><table><tbody>${docs.map(a=>`<tr><td><a href="${esc(coUrl('/api/files/'+a.fileId))}" target="_blank" rel="noopener">${esc(a.name)}</a></td><td class="muted">${esc(a.uploadedByName||'')} · ${esc(fmtDate(iso(new Date(a.uploadedAt))))}</td><td class="n">${edit?`<button class="btn sm" data-yfdocdel="${esc(a.id)}">Remove</button>`:''}</td></tr>`).join('')||emptyRow(3,'No documents yet','Attach bank statements, listings, loan statements, invoices or minutes (PDF, photos, Excel or Word, up to 10 MB each).')}</tbody></table></div></div>`;
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
  if(d.yfsign){const so={...(f.signoffs||{}),[d.yfsign]:d.off?null:YF_SIGN};await yfSave(f,{signoffs:so});return true}
  if(d.yfwp){YF.wp=d.yfwp;renderMain();return true}
  if(d.yfgowp){YF.tab='wp';YF.wp=d.yfgowp;renderMain();return true}
  const wpOf=()=>({...((f.wps||{})[YF.wp]||{})});
  if(t.hasAttribute('data-yfwpsave')){const w=wpOf();for(const x of $$('[data-yfwpf]'))w[x.dataset.yfwpf]=x.value;if(await yfSave(f,{wps:{...(f.wps||{}),[YF.wp]:w}}))toast('Saved');return true}
  if(d.yfwpsign){const w=wpOf();w[d.yfwpsign]=d.off?null:YF_SIGN;if(!d.off&&(!w.status||w.status==='notstarted'))w.status=d.yfwpsign==='reviewed'?'done':'progress';await yfSave(f,{wps:{...(f.wps||{}),[YF.wp]:w}});return true}
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
  const up=$('[data-yfupload]',m);if(up)up.onchange=()=>{const files=[...up.files];up.value='';if(files.length)yfUpload(f,files)};
}
