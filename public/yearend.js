'use strict';
/* ---------- Year-end package for the accountant ----------
 * A business that keeps its own books sends its accountant one .zip for the year:
 *   - the books (a Sumlora backup the accountant opens as a company of their own),
 *   - financial statements as a PDF (income statement, balance sheet, cash flow, trial balance),
 *   - the general ledger and a CaseWare-ready trial balance as CSV,
 *   - the year's sales tax return figures as CSV,
 *   - the receipts and attachments on the year's transactions,
 *   - a note explaining what's inside.
 * On the accountant's side, "Open a client's books" on the Companies page turns a backup (or this .zip)
 * into a new company.
 */

/* ---------- zip files (stored, no compression: the PDFs and photos are compressed already) ---------- */
const ZIP_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function zipCrc(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = ZIP_CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
/** files: [{name, data: Uint8Array|string}] → Blob of a .zip */
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = zipCrc(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, x) => s + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
/** The files in a .zip (stored or deflated): [{name, data: Uint8Array}]. */
async function readZip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
  let e = -1; for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('That isn’t a zip file.');
  const n = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true); const out = [];
  for (let k = 0; k < n; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('That zip file is damaged.');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true), raw = u8.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8 && typeof DecompressionStream === 'function') out.push({ name, data: new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

/* ---------- the package ---------- */
const ypSafe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
const ypCsv = rows => '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
const YP_EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** The fiscal year-ends to offer: last year first. */
function ypYearEnds() {
  const t = today(), thisEnd = fyEndOf(t), lastEnd = fyEndOf(addDays(fyStartOf(t), -1));
  return [lastEnd, thisEnd, fyEndOf(addDays(fyStartOf(lastEnd), -1))];
}
function yearEndPackageForm() {
  const ends = ypYearEnds();
  const f = openModal('Year-end package for your accountant', `<div class="muted" style="font-size:13px">One file with everything your accountant needs for the year-end and tax return. Send it by email or upload it to your accountant’s portal.</div>
    <div class="fields">${fld('ypEnd', 'Fiscal year ending', `<select id="ypEnd">${ends.map((d, i) => `<option value="${d}" ${i === 0 ? 'selected' : ''}>${fmtDate(d)}</option>`).join('')}</select>`)}</div>
    <div class="flabel" style="margin-bottom:4px">Included</div>
    <ul class="muted" style="font-size:13px;margin:0;padding-left:20px;line-height:1.7">
      <li>Your books (a Sumlora backup your accountant can open)</li>
      <li>Financial statements (PDF): income statement, balance sheet, cash flow and trial balance</li>
      <li>General ledger and a trial balance for CaseWare (spreadsheets)</li>
      <li>Sales tax return figures for the year</li>
    </ul>
    <label class="check"><input type="checkbox" id="ypFiles" checked> <span>Include receipts and attachments on the year’s transactions</span></label>
    <div data-ypwarn></div>`,
    `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Download package</button>`, 'wide');
  const warn = () => {
    const ye = $('#ypEnd', f).value, cl = S.company.closingDate;
    const msgs = [];
    if (ye >= today()) msgs.push('This fiscal year hasn’t ended yet. The package shows the books as they are today.');
    else if (!cl || cl < ye) msgs.push('Tip: close the books through the year-end first (Settings → Close the books), so nothing changes after you send it.');
    const review = S.bankTxns.filter(b => b.status === 'new' && b.date <= ye && b.date >= fyStartOf(ye)).length;
    if (review) msgs.push(`${review} bank line${review === 1 ? ' from this year is' : 's from this year are'} still waiting for review in Banking.`);
    $('[data-ypwarn]', f).innerHTML = msgs.map(m => `<div class="banner" style="margin:6px 0 0"><span>${esc(m)}</span></div>`).join('');
  };
  $('#ypEnd', f).onchange = warn; warn();
  f.onsubmit = async e => {
    e.preventDefault(); f.err('');
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const { blob, name, skipped } = await yearEndPackage($('#ypEnd', f).value, { files: $('#ypFiles', f).checked });
      saveFile(name, blob); closeModal();
      toast(skipped ? `Package downloaded. ${skipped} file${skipped === 1 ? ' couldn’t' : 's couldn’t'} be added.` : 'Year-end package downloaded');
    } catch (err) { f.err(err.message); btn.disabled = false; btn.textContent = 'Download package'; }
  };
}
/** Build the package for the fiscal year ending ye. */
async function yearEndPackage(ye, { files = true } = {}) {
  const fy = fyStartOf(ye), co = S.company.name || 'Books', period = `${fmtDate(fy)} – ${fmtDate(ye)}`;
  const out = [], tag = `${ye.slice(0, 4)}`;
  // The books
  const r = await fetch(coUrl('/api/backup'));
  if (!r.ok) throw new Error('The books couldn’t be read. Try again.');
  out.push({ name: `1 Books - open in Sumlora (${ypSafe(co)}).json`, data: new Uint8Array(await r.arrayBuffer()) });
  // Statements, ledger and trial balance, worked out like the Reports page
  const keep = { ...S.rep };
  let statements, gl;
  try {
    const reps = [];
    for (const k of ['pl', 'bs', 'cf', 'tb']) {
      Object.assign(S.rep, { tab: k, period: 'custom', from: fy, to: ye, compare: '' });
      const x = ({ pl: rPL, bs: rBS, cf: rCF, tb: rTB })[k]();
      x.title = x.title || REPORT_TITLES[k](); x.sub = x.sub ?? (k === 'tb' ? `As of ${fmtDate(ye)}` : ''); reps.push(x);
    }
    statements = reportsPdf(reps, { cover: { title: 'Financial statements', sub: period, note: `Prepared from the books of ${co} in Sumlora on ${fmtDate(today())}. Not audited or reviewed.` } });
    Object.assign(S.rep, { tab: 'gl', period: 'custom', from: fy, to: ye, acct: '' });
    gl = rGL().csv;
  } finally { Object.assign(S.rep, keep); }
  out.push({ name: `2 Financial statements ${tag}.pdf`, data: statements });
  out.push({ name: `3 General ledger ${tag}.csv`, data: ypCsv(gl) });
  let cw = ''; try { cw = '﻿' + casewareCsv(ye, true); } catch (e) { cw = ''; }
  if (cw) out.push({ name: `4 Trial balance for CaseWare ${tag}.csv`, data: cw });
  // Sales tax: each return period that falls in the year
  const tax = [['Tax', 'Period from', 'Period to', 'Status', 'Line', 'Description', 'Amount']];
  for (const k of (typeof taxesInUse === 'function' ? taxesInUse() : [])) {
    for (const p of filingPeriods(k).filter(p => p.from >= fy && p.to <= ye).reverse()) {
      const w = worksheet(k, p.from, p.to); if (!w) continue;
      for (const [no, label, how, sub] of w.lines) {
        if (sub) continue;
        tax.push([taxLabel(k), p.from, p.to, w.filed ? `Filed ${w.filed.filedOn}` : 'Not filed', no.startsWith('x') ? '' : no, typeof lineLabel === 'function' ? lineLabel(k, label) : label, w.vals[no] ?? 0]);
      }
    }
  }
  if (tax.length > 1) out.push({ name: `5 Sales tax returns ${tag}.csv`, data: ypCsv(tax) });
  // Receipts and attachments on the year's transactions
  let skipped = 0, nFiles = 0;
  if (files) {
    const dateOf = (col, id) => { const x = (col === 'docs' ? S.docs : S.entries).find(y => y.id === id); return x && x.date; };
    const list = [];
    for (const rc of S.receipts) {
      const col = rc.entryId ? 'entries' : rc.docId ? 'docs' : null; if (!col) continue;
      const dt = dateOf(col, rc.entryId || rc.docId); if (dt && dt >= fy && dt <= ye) list.push({ fileId: rc.fileId, date: dt, label: rcTitle(rc), type: rc.mediaType });
    }
    for (const a of S.attachments) {
      const dt = dateOf(a.target, a.targetId); if (!(dt && dt >= fy && dt <= ye)) continue;
      const on = (a.target === 'docs' ? S.docs : S.entries).find(y => y.id === a.targetId) || {};
      const who = contactName(on.contactId) || on.memo || '';
      list.push({ fileId: a.fileId, date: dt, label: [who, (a.name || 'Attachment').replace(/\.(pdf|jpe?g|png|webp)$/i, '')].filter(Boolean).join(' - '), type: a.mediaType });
    }
    const used = new Set();
    for (const x of list.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2000)) {
      try {
        const res = await fetch(coUrl('/api/files/' + encodeURIComponent(x.fileId)));
        if (!res.ok) { skipped++; continue; }
        const data = new Uint8Array(await res.arrayBuffer()), ext = YP_EXT[x.type || res.headers.get('Content-Type')] || 'bin';
        let base = `6 Receipts and attachments/${x.date} ${ypSafe(x.label.replace(/\.(pdf|jpe?g|png|webp)$/i, ''))}`, nm = `${base}.${ext}`, i = 2;
        while (used.has(nm)) nm = `${base} (${i++}).${ext}`;
        used.add(nm); out.push({ name: nm, data }); nFiles++;
      } catch (e) { skipped++; }
    }
  }
  out.push({ name: '0 Read me.txt', data: [
    `Year-end package: ${co}`, `Fiscal year: ${period}`, `Prepared in Sumlora on ${fmtDate(today())}`, '',
    'What’s inside',
    '1  The books: a Sumlora backup of every account, customer, vendor, invoice, bill and transaction. In Sumlora, use',
    '   Companies → Open a client’s books and choose this package (or the .json file) to open them as a company.',
    '2  Financial statements (PDF): income statement, balance sheet, cash flow statement and trial balance.',
    '3  General ledger (CSV): every posting in the year, by account.',
    cw ? '4  Trial balance for CaseWare (CSV): this year and last, with GIFI codes. Import with CaseWare’s Excel/ASCII import.' : '4  (No CaseWare trial balance: the trial balance didn’t add up to zero. Check the books.)',
    tax.length > 1 ? '5  Sales tax returns (CSV): the figures for each return period in the year, filed or not.' : '5  (No sales tax return periods in this year.)',
    files ? `6  Receipts and attachments: ${nFiles} file${nFiles === 1 ? '' : 's'} on the year’s transactions, named by date.` : '6  (Receipts and attachments weren’t included.)',
    '', 'The statements are prepared from the books as kept. They aren’t audited or reviewed.',
  ].join('\r\n') });
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { blob: makeZip(out), name: `${ypSafe(co).replace(/\s+/g, '-')}_year-end_${ye}.zip`, skipped };
}

/* ---------- accountant's side: open a client's books as a new company ---------- */
function openClientBooks() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,.json,application/zip,application/json';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    let body;
    try {
      if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
        const entries = await readZip(await file.arrayBuffer());
        const j = entries.filter(x => /\.json$/i.test(x.name)).map(x => { try { return JSON.parse(new TextDecoder().decode(x.data)); } catch (e) { return null; } }).find(x => x && x.format === 'tally-books-backup');
        if (!j) throw new Error('There are no Sumlora books in that zip file.');
        body = j;
      } else body = JSON.parse(await file.text());
    } catch (e) { toast(e.message || 'That file can’t be read.', true); return; }
    if (!body || body.format !== 'tally-books-backup') { toast('That file isn’t a Sumlora backup or year-end package.', true); return; }
    const c = body.company || {}, n = (body.entries || []).length;
    const f = openModal('Open a client’s books', `<div class="muted" style="font-size:13px"><span>The books of</span> <b translate="no">${esc(c.name || 'a company')}</b>: <span>${n} transaction${n === 1 ? '' : 's'}, saved ${body.exportedAt ? fmtDate(body.exportedAt.slice(0, 10)) : 'on an unknown date'}.</span> <span>They’re added as a new company. Nothing else changes.</span></div>
      <div class="fields">${fld('obName', 'Company name', `<input type="text" id="obName" value="${esc(c.name || '')}">`, true)}
      ${fld('obCode', 'Company code', `<input type="text" id="obCode" class="code-in" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="4 digits">`)}</div>
      <div class="muted" style="font-size:13px">Receipt photos aren’t inside the books file. If they came in a year-end package, they’re in its “Receipts and attachments” folder.</div>`,
      `<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Open the books</button>`);
    f.onsubmit = async e => {
      e.preventDefault(); f.err('');
      const name = $('#obName', f).value.trim(), code = $('#obCode', f).value.trim();
      if (!name) return f.err('Give the company a name.');
      if (!/^\d{4}$/.test(code)) return f.err('Choose a 4-digit company code.');
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Opening…';
      let id = '';
      try {
        id = (await api('POST', '/api/companies', { name, province: c.province || '', fyStart: c.fyStart || 1, lang: c.lang, orgType: c.orgType, code })).company.id;
        const r = await fetch(`/api/c/${encodeURIComponent(id)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, company: { ...c, name } }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'The books couldn’t be opened.'); }
        await loadCompanies(); const nc = CO_LIST.find(x => x.id === id); if (nc) nc.justMade = true;
        closeModal(); await openCompany(id); toast(`${name} is open`);
      } catch (err) {
        // A half-made company is archived, so it doesn't clutter the list (it can be deleted or restored later).
        if (id) { await api('PUT', '/api/companies/' + encodeURIComponent(id), { archived: true }).catch(() => {}); await loadCompanies().catch(() => {}); }
        f.err(err.message); btn.disabled = false; btn.textContent = 'Open the books';
      }
    };
  };
  inp.click();
}
