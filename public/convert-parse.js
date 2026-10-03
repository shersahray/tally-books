/*
 * Moving a client to Sumlora from QuickBooks Online, Sage 50 or Sage Accounting (or anything that
 * exports similar reports): reads the exported files (CSV, Excel .xlsx, or a .zip of them), works out
 * which report each one is, and turns them into a plan of records to import.
 *
 * Works in the browser (window.Convert) and in Node (require) so it can be tested.
 * Nothing here touches the books; the wizard (convert.js) shows the plan and sends it to the server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bankparse.js'));
  else root.Convert = factory(root.BankParse);
})(typeof self !== 'undefined' ? self : this, function (BP) {
  'use strict';
  const r2 = n => Math.round((+n || 0) * 100) / 100 || 0;
  const norm = s => String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();
  const low = s => norm(s).toLowerCase();

  /* ---------- zip ---------- */
  // inflateRaw(Uint8Array) -> Promise<Uint8Array>, supplied by the caller (browser: DecompressionStream; Node: zlib).
  function unzip(buf, inflateRaw) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('That zip file is damaged or isn’t a zip file.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const td = new TextDecoder();
    const files = [];
    for (let k = 0; k < count; k++) {
      if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('That zip file is damaged.');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
      const name = td.decode(b.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
      if (usize > 200 * 1024 * 1024) throw new Error('A file inside the zip is too large.');
      if (local + 30 > b.length) throw new Error('That zip file is damaged.');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      if (start + csize > b.length) throw new Error('That zip file is damaged.');
      files.push({ name, method, data: b.subarray(start, start + csize) });
    }
    return {
      names: files.map(f => f.name),
      async read(name) {
        const f = files.find(x => x.name === name);
        if (!f) return null;
        if (f.method === 0) return f.data;
        if (f.method === 8) return inflateRaw(f.data);
        throw new Error('That zip file uses a kind of compression Sumlora can’t read. Unzip it and choose the files instead.');
      },
    };
  }

  /* ---------- Excel (.xlsx) ---------- */
  const ent = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });
  const texts = xml => { let out = ''; for (const m of String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += ent(m[1]); return out; };
  const colIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '').slice(0, 3)) n = n * 26 + (ch.charCodeAt(0) - 64); return Math.max(0, Math.min(n - 1, 16383)); };
  const attr = (s, a) => { const m = String(s).match(new RegExp('\\b' + a + '="([^"]*)"')); return m ? ent(m[1]) : null; };
  const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
  function serialToDate(n) {
    const ms = Math.round((n - 25569) * 86400000);
    const d = new Date(ms);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }
  /** Read the first sheet with data. Returns an array of rows (arrays of strings). */
  async function readXlsx(buf, inflateRaw) {
    const z = unzip(buf, inflateRaw);
    const txt = async name => { const d = await z.read(name); return d ? new TextDecoder().decode(d) : ''; };
    if (!z.names.includes('xl/workbook.xml')) throw new Error('That isn’t an Excel workbook (.xlsx). Older .xls files: open them in Excel and save as .xlsx or CSV.');
    const shared = [];
    for (const m of (await txt('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1]));
    // Which cell styles are dates.
    const styles = await txt('xl/styles.xml');
    const custom = {};
    for (const m of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) custom[attr(m[1], 'numFmtId')] = attr(m[1], 'formatCode') || '';
    const xfs = (styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
    const isDateStyle = [...xfs.matchAll(/<xf\b([^>]*)/g)].map(m => {
      const id = Number(attr(m[1], 'numFmtId') || 0);
      if (DATE_FMT_IDS.has(id)) return true;
      const code = (custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
      return /[dy]/i.test(code) && !/0\.0|#/.test(code);
    });
    const wb = await txt('xl/workbook.xml'), rels = await txt('xl/_rels/workbook.xml.rels');
    const targets = {};
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) targets[attr(m[1], 'Id')] = attr(m[1], 'Target');
    const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m => {
      const t = targets[attr(m[1], 'r:id')] || '';
      return t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    });
    for (const sheet of sheets) {
      const xml = await txt(sheet);
      const rows = [];
      for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (rows.length >= 300000) throw new Error('That spreadsheet has more than 300,000 rows. Export a shorter date range.');
        const row = [];
        let next = 0;
        for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const a = cm[1], inner = cm[2] || '';
          const ref = attr(a, 'r'), t = attr(a, 't'), s = Number(attr(a, 's') || 0);
          const ci = ref ? colIndex(ref) : next;
          next = ci + 1;
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          let val = '';
          if (t === 's') val = shared[Number(v)] || '';
          else if (t === 'inlineStr') val = texts((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
          else if (t === 'str' || t === 'e') val = v != null ? ent(v) : '';
          else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
          else if (v != null) { const n = Number(v); val = isDateStyle[s] && n > 1000 && n < 100000 ? serialToDate(n) : String(n); }
          row[ci] = norm(val);
        }
        if (row.length > 200) row.length = 200; // reports never have this many columns
        for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
        rows.push(row);
      }
      if (rows.some(r => r.some(Boolean))) return rows;
    }
    return [];
  }

  /** Turn one chosen file into tables: [{ name, rows }]. A zip gives one table per CSV or Excel file inside. */
  async function readFile(name, bytes, inflateRaw) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const isZip = b[0] === 0x50 && b[1] === 0x4b;
    if (/\.xls$/i.test(name) && !isZip) throw new Error(`${name} is an older Excel file. Open it in Excel and save it as .xlsx or CSV, then choose it again.`);
    if (isZip && /\.xlsx$/i.test(name)) return [{ name, rows: await readXlsx(b, inflateRaw) }];
    if (isZip) {
      const z = unzip(b, inflateRaw), out = [];
      for (const n of z.names) {
        const short = n.split('/').pop();
        if (/\.xlsx$/i.test(n)) out.push({ name: short, rows: await readXlsx(await z.read(n), inflateRaw) });
        else if (/\.(csv|txt)$/i.test(n)) out.push({ name: short, rows: BP.parseCSV(decodeText(await z.read(n))) });
      }
      return out;
    }
    if (/\.pdf$/i.test(name)) throw new Error(`${name} is a PDF. Export the report as Excel or CSV instead.`);
    return [{ name, rows: BP.parseCSV(decodeText(b)) }];
  }
  function decodeText(b) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
  }

  /* ---------- which report is this? ---------- */
  const H = {
    acctName: ['account', 'account name', 'full name', 'name', 'account description', 'ledger account name', 'ledger account', 'account title', 'description', 'nom du compte', 'compte'],
    number: ['account #', 'account number', 'account no', 'account no.', 'acct #', 'acct no', 'acct. no.', 'number', 'no.', 'nominal code', 'code', 'account code', '#', 'numéro', 'numéro de compte', 'n° de compte'],
    acctType: ['type', 'account type', 'ledger account type', 'category', 'account category', 'class', 'account class', 'type de compte', 'catégorie'],
    detail: ['detail type', 'detail', 'sub type', 'subtype', 'account subtype', 'account sub type', 'type de détail'],
    balance: ['balance', 'current balance', 'closing balance', 'solde'],
    debit: ['debit', 'debits', 'dr', 'debit amount', 'débit', 'débits'],
    credit: ['credit', 'credits', 'cr', 'credit amount', 'crédit', 'crédits'],
    date: ['date', 'transaction date', 'invoice date', 'bill date', 'txn date', 'doc date', 'posting date', 'date de transaction'],
    due: ['due date', 'due', 'date due', "date d'échéance", 'échéance'],
    num: ['num', 'no.', 'number', 'ref', 'ref no', 'ref no.', 'reference', 'invoice #', 'invoice no', 'invoice no.', 'invoice number', 'bill no', 'bill no.', 'bill number', 'doc #', 'document number', 'je #', 'je no.', 'journal no', 'journal no.', 'transaction id', 'transaction no', 'source', 'n°'],
    txnType: ['transaction type', 'txn type', 'type', 'trans type', 'type de transaction'],
    party: ['customer', 'vendor', 'supplier', 'name', 'customer name', 'vendor name', 'supplier name', 'payee', 'contact', 'contact name', 'display name', 'customer/vendor', 'client', 'fournisseur', 'nom'],
    amount: ['amount', 'original amount', 'total', 'invoice amount', 'total amount', 'montant'],
    open: ['open balance', 'balance', 'amount due', 'open amount', 'balance due', 'outstanding', 'outstanding amount', 'remaining balance', 'amount owing', 'solde ouvert', 'solde dû'],
    memo: ['memo/description', 'memo', 'description', 'line description', 'comment', 'comments', 'details', 'note de service/description'],
    email: ['email', 'e-mail', 'email address', 'main email', 'courriel'],
    phone: ['phone', 'phone numbers', 'phone 1', 'telephone', 'phone number', 'mobile', 'work phone', 'téléphone'],
    address: ['billing address', 'bill to address', 'address', 'street', 'street 1', 'address line 1', 'address 1', 'mailing address', 'billing street', 'adresse'],
    city: ['city', 'billing city', 'ville'], prov: ['province', 'state', 'province/state', 'billing province', 'billing state'], postal: ['postal code', 'zip', 'postcode', 'billing postal code', 'code postal'],
  };
  const ALL = new Set(Object.values(H).flat());
  const isHead = c => ALL.has(low(c).replace(/\s*\(.*\)$/, ''));

  function findHeader(rows) {
    let best = -1, score = 1;
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      const s = rows[i].filter(c => c && isHead(c)).length;
      if (s > score) { best = i; score = s; }
    }
    return best;
  }
  function colsFor(head, roles) {
    const used = new Set(), out = {};
    const h = head.map(c => low(c).replace(/\s*\(.*\)$/, ''));
    for (const role of roles) {
      for (const syn of H[role]) {
        const i = h.findIndex((c, j) => c === syn && !used.has(j));
        if (i >= 0) { out[role] = i; used.add(i); break; }
      }
    }
    return out;
  }
  const KINDS = ['accounts', 'customers', 'vendors', 'tb', 'ar', 'ap', 'journal', 'ignore'];
  const KIND_LABEL = { accounts: 'Chart of accounts', customers: 'Customers', vendors: 'Vendors', tb: 'Trial balance', ar: 'Open invoices (A/R)', ap: 'Unpaid bills (A/P)', journal: 'Transaction history (Journal)', ignore: 'Don’t use this file' };

  /** Work out what a table is. Returns { kind, header, title, asOf, why }. */
  function classify(table) {
    const rows = table.rows || [];
    const header = findHeader(rows);
    const head = header >= 0 ? rows[header].map(low) : [];
    const titleRows = rows.slice(0, header >= 0 ? header : 6).map(r => r.filter(Boolean).join(' ')).filter(Boolean);
    const title = titleRows.join(' · ');
    const t = low(title + ' ' + table.name.replace(/[_-]+/g, ' '));
    const has = (...xs) => xs.some(x => head.includes(x));
    let kind = 'ignore', why = '';
    if (/general ledger|grand livre/.test(t)) { kind = 'ignore'; why = 'gl'; }
    else if (/trial balance|balance de vérification/.test(t)) kind = 'tb';
    else if (/a\/r aging|ar aging|aged receivable|accounts receivable aging|open invoices|customer aged|receivable/.test(t)) kind = 'ar';
    else if (/a\/p aging|ap aging|aged payable|accounts payable aging|unpaid bills|vendor aged|supplier aged|payable/.test(t)) kind = 'ap';
    else if (/journal|transaction list|transaction detail|audit trail/.test(t)) kind = 'journal';
    else if (/account list|chart of accounts|accounts list|ledger accounts|nominal|plan comptable|liste des comptes/.test(t)) kind = 'accounts';
    else if (/vendor|supplier|fournisseur/.test(t)) kind = 'vendors';
    else if (/customer|client/.test(t)) kind = 'customers';
    else if (has('debit', 'debits') && has('credit', 'credits') && has('date')) kind = 'journal';
    else if (has('debit', 'debits') && has('credit', 'credits')) kind = 'tb';
    else if (has('open balance', 'balance due', 'amount due') && has('date')) kind = has('vendor', 'supplier') ? 'ap' : 'ar';
    else if (has('detail type', 'account type', 'type', 'ledger account type', 'class') && has('account', 'account name', 'full name', 'name', 'ledger account name')) kind = 'accounts';
    else if (has('vendor', 'supplier', 'vendor name', 'supplier name')) kind = 'vendors';
    else if (has('customer', 'customer name', 'email', 'phone')) kind = 'customers';
    return { kind, header, title, asOf: asOfDate(title), why };
  }
  function asOfDate(title) {
    const t = String(title);
    const re = /(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}\/\d{4})|([A-Za-zéû]{3,9}\.? \d{1,2},? \d{4})|(\d{1,2}[ -][A-Za-zéû]{3,9}\.?[ -,]+\d{4})/g;
    let last = null;
    for (const m of t.matchAll(re)) last = m[0];
    return last ? BP.parseDate(last.replace(/\.$/, '')) || '' : '';
  }

  /* ---------- reading each kind ---------- */
  const amount = v => { const n = BP.parseAmount(v); return n == null ? null : n; };
  // A ledger balance: "500.00 Cr" is a credit (negative), "500.00 Dr" a debit. (Bank files use these the other way round.)
  const ledgerAmount = v => {
    const t = norm(v), m = t.match(/^(.*?)\s*(dr|cr)\.?$/i);
    if (!m) return amount(t);
    const n = amount(m[1]);
    return n == null ? null : (m[2].toLowerCase() === 'cr' ? -Math.abs(n) : Math.abs(n));
  };
  const isTotal = s => /^(total|totals|grand total|net income|tot\.)\b/i.test(norm(s));
  const body = (table, header) => table.rows.slice(header + 1);
  // "1000 Chequing" -> { number: '1000', name: 'Chequing' }
  function splitNumber(name) {
    const m = norm(name).match(/^(\d{3,}(?:[.-]\d+)*)\s*[-–·]?\s+(.+)$/);
    return m ? { number: m[1], name: m[2] } : { number: '', name: norm(name) };
  }
  const leaf = full => { const parts = norm(full).split(/\s*:\s*/); return parts[parts.length - 1]; };

  function readAccounts(table, header) {
    const c = colsFor(table.rows[header], ['number', 'acctName', 'detail', 'acctType', 'balance']);
    if (c.acctName === undefined) c.acctName = c.number === 0 ? 1 : 0;
    const klass = table.rows[header].findIndex((h, i) => /^(account )?class$/i.test(norm(h)) && i !== c.acctType);
    const out = [];
    for (const r of body(table, header)) {
      let name = norm(r[c.acctName]);
      if (!name || isTotal(name)) continue;
      let number = c.number !== undefined ? norm(r[c.number]) : '';
      if (!number) { const s = splitNumber(name); number = s.number; name = s.name; }
      const type = c.acctType !== undefined ? norm(r[c.acctType]) : '';
      // Sage 50: headings, subtotals and totals aren't real accounts.
      if (/^(h|s|t|x)$/i.test(type) || /^(heading|subtotal|total|current earnings|en-tête|sous-total)$/i.test(type)) continue;
      // Sage 50's type is a letter (G, A, R); its account class says what the account is.
      const cls = klass >= 0 ? norm(r[klass]) : '';
      const srcType = /^[a-z]$/i.test(type) || !type ? cls : type;
      out.push({ number, fullName: name, name: leaf(name), srcType, srcDetail: c.detail !== undefined ? norm(r[c.detail]) : '', balance: c.balance !== undefined ? amount(r[c.balance]) : null });
    }
    return out;
  }
  function readContacts(table, header, kind) {
    const c = colsFor(table.rows[header], ['party', 'email', 'phone', 'address', 'city', 'prov', 'postal']);
    if (c.party === undefined) c.party = 0;
    const out = [], seen = new Set();
    for (const r of body(table, header)) {
      const name = norm(r[c.party]);
      if (!name || /^(total|totals)$/i.test(name) || seen.has(low(name))) continue;
      seen.add(low(name));
      const addr = ['address', 'city', 'prov', 'postal'].map(k => c[k] !== undefined ? norm(r[c[k]]) : '').filter(Boolean).join(', ');
      out.push({ kind, name, email: c.email !== undefined ? norm(r[c.email]) : '', phone: c.phone !== undefined ? norm(r[c.phone]) : '', address: addr });
    }
    return out;
  }
  function readTB(table, header) {
    const c = colsFor(table.rows[header], ['number', 'acctName', 'debit', 'credit', 'balance']);
    if (c.acctName === undefined) c.acctName = 0;
    const out = [];
    for (const r of body(table, header)) {
      let name = norm(r[c.acctName]);
      if (!name || isTotal(name)) continue;
      let number = c.number !== undefined ? norm(r[c.number]) : '';
      if (!number) { const s = splitNumber(name); number = s.number; name = s.name; }
      let amt = null;
      if (c.debit !== undefined || c.credit !== undefined) {
        const d = c.debit !== undefined ? amount(r[c.debit]) : null, k = c.credit !== undefined ? amount(r[c.credit]) : null;
        if (d == null && k == null) continue;
        amt = r2((d || 0) - (k || 0));
      } else if (c.balance !== undefined) { amt = ledgerAmount(r[c.balance]); if (amt == null) continue; }
      else continue;
      out.push({ number, fullName: name, name: leaf(name), amount: amt });
    }
    return out;
  }
  function readOpen(table, header, kind, dateFmt) {
    const c = colsFor(table.rows[header], ['date', 'due', 'txnType', 'num', 'party', 'open', 'amount']);
    const out = [], skipped = [];
    let group = '';
    for (const r of body(table, header)) {
      const filled = r.map(norm).filter(Boolean);
      const first = norm(r.find(x => norm(x)) || '');
      const date = c.date !== undefined ? BP.parseDate(r[c.date], dateFmt) : null;
      if (!date) {
        // A group heading (QuickBooks groups by customer or by age), or a total line.
        if (filled.length === 1 && !isTotal(first) && amount(first) == null) group = first;
        continue;
      }
      const type = c.txnType !== undefined ? low(r[c.txnType]) : '';
      const open = c.open !== undefined ? amount(r[c.open]) : (c.amount !== undefined ? amount(r[c.amount]) : null);
      const orig = c.amount !== undefined ? amount(r[c.amount]) : open;
      const party = c.party !== undefined ? norm(r[c.party]) : '';
      const name = party || (/days|current|past due|older|courant/i.test(group) ? '' : group);
      const item = { date, due: c.due !== undefined ? BP.parseDate(r[c.due], dateFmt) || '' : '', number: c.num !== undefined ? norm(r[c.num]) : '', name, amount: orig == null ? open : orig, open, type };
      if (open == null || !open) continue;
      if (open < 0 || /payment|credit|paiement|crédit/.test(type)) { skipped.push(item); continue; }
      out.push(item);
    }
    return { items: out, credits: skipped };
  }
  function readJournal(table, header, dateFmt) {
    const c = colsFor(table.rows[header], ['date', 'txnType', 'num', 'party', 'memo', 'number', 'acctName', 'debit', 'credit']);
    // In a journal, "Account" is the account; a separate "Name" column is the customer or vendor.
    const groups = [], problems = [];
    let cur = null;
    const close = () => { if (cur && cur.lines.length) groups.push(cur); cur = null; };
    for (const r of body(table, header)) {
      const date = c.date !== undefined ? BP.parseDate(r[c.date], dateFmt) : null;
      let acct = c.acctName !== undefined ? norm(r[c.acctName]) : '';
      let number = c.number !== undefined ? norm(r[c.number]) : '';
      const d = c.debit !== undefined ? amount(r[c.debit]) : null, k = c.credit !== undefined ? amount(r[c.credit]) : null;
      const num = c.num !== undefined ? norm(r[c.num]) : '', type = c.txnType !== undefined ? norm(r[c.txnType]) : '';
      if (!acct && !number) { if (cur && cur.balanced()) close(); continue; } // a total or blank line
      if (!number) { const s = splitNumber(acct); number = s.number; acct = s.name; }
      const key = `${date || ''}|${num}|${type}`;
      // New transaction: a dated line once the current one balances, or a different date/number/type.
      if (date && (!cur || cur.balanced() || (cur.key !== key && cur.repeat))) { close(); }
      if (!cur) {
        if (!date) { problems.push({ reason: 'line without a date', account: acct }); continue; }
        cur = { date, key, num, type, name: c.party !== undefined ? norm(r[c.party]) : '', memo: '', lines: [], repeat: false,
          balanced() { const t = this.lines.reduce((s, l) => s + l.debit - l.credit, 0); return this.lines.length > 1 && Math.abs(t) < 0.005; } };
      } else if (date && cur.key === key) cur.repeat = true; // Sage repeats the date on every line
      const memo = c.memo !== undefined ? norm(r[c.memo]) : '';
      if (!cur.memo && memo) cur.memo = memo;
      if (!cur.name && c.party !== undefined) cur.name = norm(r[c.party]);
      if ((d || 0) === 0 && (k || 0) === 0) continue;
      const net = r2((d || 0) - (k || 0));
      cur.lines.push({ fullName: acct, name: leaf(acct), number, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0, memo });
    }
    close();
    const ok = [];
    for (const g of groups) {
      const diff = r2(g.lines.reduce((s, l) => s + l.debit - l.credit, 0));
      if (Math.abs(diff) >= 0.005 || g.lines.length < 2) problems.push({ reason: 'doesn’t balance', date: g.date, num: g.num, diff });
      else ok.push({ date: g.date, num: g.num, type: g.type, name: g.name, memo: g.memo, lines: g.lines });
    }
    return { txns: ok, problems };
  }
  /** Dates in one column: the format that reads them all ('mdy', 'dmy'…), or 'auto'. */
  function dateFormatOf(table, header) {
    const c = colsFor(table.rows[header], ['date', 'due']);
    const vals = [];
    for (const r of body(table, header)) for (const k of ['date', 'due']) if (c[k] !== undefined && norm(r[c[k]])) vals.push(norm(r[c[k]]));
    return BP.detectDateFormat(vals.filter(v => /^\d/.test(v)).slice(0, 500));
  }
  function ambiguousDates(table, header) {
    const c = colsFor(table.rows[header], ['date', 'due']);
    const vals = [];
    for (const r of body(table, header)) for (const k of ['date', 'due']) if (c[k] !== undefined && /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(norm(r[c[k]]))) vals.push(norm(r[c[k]]));
    if (!vals.length) return false;
    const mdy = vals.every(v => BP.parseDate(v, 'mdy')), dmy = vals.every(v => BP.parseDate(v, 'dmy'));
    return mdy && dmy;
  }

  /* ---------- account types ---------- */
  /** Sumlora type and detail for an account from another program. */
  function guessType(a) {
    const t = low(a.srcType), d = low(a.srcDetail), n = low(a.fullName || a.name), all = `${t} ${d}`;
    const num = parseInt(String(a.number || '').replace(/\D.*$/, ''), 10);
    const taxName = s => /\b(gst|hst|tps|tvh|sales tax)\b/.test(s) && !/expense|paid|itc|input|receivable|recoverable/.test(s);
    const qstName = s => /\b(qst|tvq)\b/.test(s) && !/expense|paid|itc|input|receivable|recoverable/.test(s);
    if (/credit card|carte de crédit/.test(all)) return { type: 'Liability', detail: 'card' };
    if (/\bbank\b|banque|\bcash\b|encaisse/.test(t) || /^(bank|cash|chequing|checking|savings|cash on hand)$/.test(d)) return { type: 'Asset', detail: 'bank' };
    if (/accounts receivable|\ba\/r\b|comptes clients/.test(all) && !/other|allowance|provision/.test(all)) return { type: 'Asset', detail: 'ar' };
    if (/accounts payable|\ba\/p\b|comptes fournisseurs/.test(all) && !/other|accrued/.test(all)) return { type: 'Liability', detail: 'ap' };
    // Fixed assets keep their sales tax credits under the Quick Method; accumulated depreciation is a separate account.
    if (/fixed asset|property, plant|immobilisation/.test(all) && !/accumulated|depreciation|amorti/.test(`${all} ${n}`)) return { type: 'Asset', detail: 'capital' };
    if (/liabilit|payable|passif|current liabilities/.test(all) || (!t && num >= 2000 && num < 3000)) {
      if (qstName(n) || qstName(d)) return { type: 'Liability', detail: 'qst' };
      if (taxName(n) || taxName(d)) return { type: 'Liability', detail: 'tax' };
    }
    // The other program's own type decides first, then its detail type, then the account name.
    const general = x => {
      if (!x) return null;
      if (/cost of (goods )?(sold|sales)|cost of sales|cogs|direct cost|direct expense|coût des/.test(x)) return 'Cost of Goods Sold';
      if (/liabilit|payable|passif|loan|long term|accrued|deferred|unearned|emprunt/.test(x)) return 'Liability';
      if (/equity|capital|retained|drawing|owner|capitaux|bénéfices non répartis/.test(x)) return 'Equity';
      if (/asset|fixed|prepaid|inventory|receivable|investment|actif|immobilis/.test(x)) return 'Asset';
      if (/expense|overhead|charge|dépense|payroll/.test(x)) return 'Expense';
      if (/income|revenue|sales|turnover|produit|revenu|ventes/.test(x)) return 'Income';
      return null;
    };
    const g = general(t) || general(d);
    if (g) return { type: g, detail: '' };
    // No type given (Sage 50 exports often don't): go by the account number, then the name.
    if (num >= 1000 && num < 2000) return { type: 'Asset', detail: /bank|chequing|checking|savings|cash/.test(n) && num < 1100 ? 'bank' : /receivable/.test(n) ? 'ar' : '' };
    if (num >= 2000 && num < 3000) return { type: 'Liability', detail: /credit card|visa|mastercard|amex/.test(n) ? 'card' : /accounts payable/.test(n) ? 'ap' : '' };
    if (num >= 3000 && num < 4000) return { type: 'Equity', detail: '' };
    if (num >= 4000 && num < 5000) return { type: 'Income', detail: '' };
    if (num >= 5000 && num < 5100 && /cost|purchases|cogs/.test(n)) return { type: 'Cost of Goods Sold', detail: '' };
    if (num >= 5000 && num < 10000) return { type: 'Expense', detail: '' };
    if (/bank|chequing|checking|savings|cash/.test(n)) return { type: 'Asset', detail: 'bank' };
    if (/receivable/.test(n)) return { type: 'Asset', detail: /accounts receivable/.test(n) ? 'ar' : '' };
    if (/payable|loan|credit card/.test(n)) return { type: 'Liability', detail: /credit card|visa|mastercard/.test(n) ? 'card' : /accounts payable/.test(n) ? 'ap' : taxName(n) ? 'tax' : qstName(n) ? 'qst' : '' };
    if (/retained|equity|capital|drawings|owner/.test(n)) return { type: 'Equity', detail: '' };
    if (/sales|revenue|income/.test(n)) return { type: 'Income', detail: '' };
    return { type: 'Expense', detail: '' };
  }
  // Lines in a trial balance that are worked out, not posted (posting them would count profit twice).
  const COMPUTED = /^(net income|net profit|current earnings|current year earnings|profit for the year|bénéfice de l.exercice)$/i;

  /* ---------- the plan ---------- */
  /**
   * tables: [{ name, rows, kind, header }]
   * existing: { accounts, contacts, entries } in the company now
   * opts: { source ('qbo'|'sage50'|'sageacc'|'other'), dateFormat ('auto'|'mdy'|'dmy'|'ymd'), date (conversion date), replaceStarter }
   * Returns { accounts, contacts, tb, open: { ar, ap }, journal, warnings, errors, date }.
   */
  function plan(tables, existing, opts = {}) {
    const warnings = [], errors = [];
    const fmt = opts.dateFormat || 'auto';
    const by = k => tables.filter(t => t.kind === k && t.header >= 0);
    const accts = new Map(); // key -> account plan
    const keyOf = (number, fullName) => number ? 'n:' + low(number) : 'f:' + low(fullName);
    // strict (the chart itself): same number or same full name. Otherwise a report may show only the
    // last part of a sub-account's name, which counts when exactly one account has it.
    const findAcct = (number, fullName, name, strict) => {
      if (number && accts.has('n:' + low(number))) return accts.get('n:' + low(number));
      const f = low(fullName), l = low(name || leaf(fullName));
      for (const a of accts.values()) if (low(a.fullName) === f) return a;
      if (strict || /:/.test(fullName || '')) return null;
      const hits = [...accts.values()].filter(a => low(a.name) === l || low(a.fullName) === l);
      return hits.length === 1 ? hits[0] : null;
    };
    const addAcct = (src, strict) => {
      const hit = findAcct(src.number, src.fullName, src.name, strict);
      if (hit) { if (!hit.number && src.number) hit.number = src.number; if (!hit.srcType && src.srcType) Object.assign(hit, { srcType: src.srcType, srcDetail: src.srcDetail }); return hit; }
      const a = { key: keyOf(src.number, src.fullName), number: src.number || '', fullName: src.fullName, name: src.name || leaf(src.fullName), srcType: src.srcType || '', srcDetail: src.srcDetail || '', balance: 0, uses: 0 };
      Object.assign(a, guessType(a));
      accts.set(a.key, a);
      return a;
    };
    for (const t of by('accounts')) readAccounts(t, t.header).forEach(a => addAcct(a, true));

    // Trial balance
    let tb = null;
    const tbs = by('tb');
    if (tbs.length > 1) warnings.push({ code: 'tb-many' });
    if (tbs.length) {
      const t = tbs[0], rows = readTB(t, t.header), lines = [];
      for (const r of rows) {
        if (COMPUTED.test(r.name)) { if (r.amount) warnings.push({ code: 'tb-computed', name: r.fullName, amount: r.amount }); continue; }
        const a = addAcct({ number: r.number, fullName: r.fullName, name: r.name });
        a.balance = r2(a.balance + r.amount);
        if (r.amount) lines.push({ key: a.key, amount: r.amount });
      }
      const diff = r2(lines.reduce((s, l) => s + l.amount, 0));
      tb = { date: opts.date || t.asOf || '', lines, diff, file: t.name };
      if (!tb.date) errors.push({ code: 'tb-date' });
      if (Math.abs(diff) >= 0.005) (Math.abs(diff) <= 1 ? warnings : errors).push({ code: 'tb-unbalanced', diff });
    }

    // Contacts (lists, then names found on open items)
    const contacts = [], cseen = new Set((existing.contacts || []).map(c => c.kind + '|' + low(c.name)));
    const addContact = (kind, name, extra = {}) => {
      if (!name) return;
      const k = kind + '|' + low(name);
      if (cseen.has(k)) return;
      cseen.add(k);
      contacts.push({ kind, name, email: '', phone: '', address: '', ...extra });
    };
    for (const t of by('customers')) readContacts(t, t.header, 'customer').forEach(c => addContact('customer', c.name, c));
    for (const t of by('vendors')) readContacts(t, t.header, 'vendor').forEach(c => addContact('vendor', c.name, c));

    // Open invoices and bills
    const open = { ar: [], ap: [] };
    for (const kind of ['ar', 'ap']) {
      for (const t of by(kind)) {
        const r = readOpen(t, t.header, kind, fmt === 'auto' ? dateFormatOf(t, t.header) : fmt);
        r.items.forEach(i => { addContact(kind === 'ar' ? 'customer' : 'vendor', i.name); open[kind].push(i); });
        if (r.credits.length) warnings.push({ code: kind + '-credits', count: r.credits.length, total: r2(r.credits.reduce((s, x) => s + Math.abs(x.open), 0)) });
        if (r.items.some(i => !i.name)) warnings.push({ code: kind + '-noname', count: r.items.filter(i => !i.name).length });
      }
    }

    // Transaction history
    let journal = null;
    const js = by('journal');
    if (js.length) {
      const txns = [], problems = [];
      for (const t of js) {
        const r = readJournal(t, t.header, fmt === 'auto' ? dateFormatOf(t, t.header) : fmt);
        txns.push(...r.txns); problems.push(...r.problems);
      }
      for (const x of txns) for (const l of x.lines) { const a = addAcct(l); a.uses++; l.key = a.key; }
      txns.sort((a, b) => a.date.localeCompare(b.date));
      journal = { txns, problems, from: txns.length ? txns[0].date : '', to: txns.length ? txns[txns.length - 1].date : '' };
      // Leaving out a transaction would make every balance after it wrong, so it has to be fixed first.
      if (problems.length) errors.push({ code: 'journal-unbalanced', count: problems.length, first: problems.slice(0, 3) });
      if (tb && tb.date && journal.from && tb.date >= journal.from) errors.push({ code: 'tb-after-history', tb: tb.date, from: journal.from });
    }
    if (tables.some(t => t.kind === 'ignore' && t.why === 'gl')) warnings.push({ code: 'gl' });
    // Open invoices and bills have to be as of the right date: the trial balance date, or the end of the
    // history when there is one (otherwise invoices paid during the history would stay open).
    const wantOpen = journal && journal.to ? journal.to : tb && tb.date;
    for (const kind of ['ar', 'ap']) {
      for (const t of by(kind)) {
        if (!t.asOf || !wantOpen) continue;
        if (journal && journal.to ? t.asOf < journal.to : t.asOf !== wantOpen) errors.push({ code: kind + '-date', asOf: t.asOf, want: wantOpen, history: !!(journal && journal.to) });
      }
    }
    // Bringing the same trial balance in twice would double every balance.
    if (tb && (existing.entries || []).some(e => e.opening && e.imported)) errors.push({ code: 'already-imported' });

    // Match to the company's own accounts: same number or name, or the special accounts (A/R, A/P, sales tax).
    const ex = (existing.accounts || []).slice();
    const taken = new Set();
    for (const a of accts.values()) {
      const m = ex.find(e => !taken.has(e.id) && ((a.number && e.code === a.number && low(e.name) === low(a.name)) || (!a.number && low(e.name) === low(a.name))));
      if (m) { a.matchId = m.id; taken.add(m.id); a.type = m.type; a.detail = m.detail || ''; }
    }
    for (const d of ['ar', 'ap', 'tax', 'qst']) {
      const a = [...accts.values()].find(x => !x.matchId && x.detail === d);
      const m = a && ex.find(e => !taken.has(e.id) && e.detail === d);
      if (m) { a.matchId = m.id; a.rename = true; taken.add(m.id); }
    }
    const list = [...accts.values()];
    // Two sub-accounts with the same last name part keep their full names, so they can be told apart.
    const dup = new Map(); list.forEach(a => dup.set(low(a.name), (dup.get(low(a.name)) || 0) + 1));
    list.forEach(a => { if (dup.get(low(a.name)) > 1 && a.fullName !== a.name && !a.matchId) a.name = a.fullName.replace(/\s*:\s*/g, ': '); });
    if (!list.some(a => a.detail === 'ar') && open.ar.length && !ex.some(e => e.detail === 'ar')) errors.push({ code: 'no-ar' });
    if (!list.some(a => a.detail === 'ap') && open.ap.length && !ex.some(e => e.detail === 'ap')) errors.push({ code: 'no-ap' });

    // A/R and A/P on the trial balance against the open items.
    // A/R and A/P when the open items are taken: the trial balance, plus the history when there is one.
    const moved = d => { if (!journal) return 0; const keys = new Set(list.filter(a => a.detail === d).map(a => a.key)); let t = 0; for (const x of journal.txns) for (const l of x.lines) if (keys.has(l.key)) t += l.debit - l.credit; return t; };
    const arTB = r2(list.filter(a => a.detail === 'ar').reduce((s, a) => s + a.balance, 0) + moved('ar'));
    const apTB = r2(-list.filter(a => a.detail === 'ap').reduce((s, a) => s + a.balance, 0) - moved('ap'));
    const arOpen = r2(open.ar.reduce((s, i) => s + i.open, 0)), apOpen = r2(open.ap.reduce((s, i) => s + i.open, 0));
    if (tb && open.ar.length && Math.abs(arTB - arOpen) >= 0.01) warnings.push({ code: 'ar-diff', tb: arTB, open: arOpen });
    if (tb && open.ap.length && Math.abs(apTB - apOpen) >= 0.01) warnings.push({ code: 'ap-diff', tb: apTB, open: apOpen });
    if (tb && !by('ar').length && Math.abs(arTB) >= 0.01) warnings.push({ code: 'ar-missing', tb: arTB });
    if (tb && !by('ap').length && Math.abs(apTB) >= 0.01) warnings.push({ code: 'ap-missing', tb: apTB });

    return { accounts: list, contacts, tb, open, journal, warnings, errors, totals: { arTB, apTB, arOpen, apOpen } };
  }

  /**
   * Turn a reviewed plan into writes for the server (one import, all or nothing).
   * opts: { uid(), source label, replaceStarter, used (Set of account ids with transactions), now }
   */
  function build(p, existing, opts) {
    const uid = opts.uid, src = opts.label || 'the previous software', now = opts.now || Date.now();
    const writes = [], deletes = [], ids = {};
    const ex = existing.accounts || [];
    const codes = new Set();
    const matched = new Set(p.accounts.filter(a => a.matchId).map(a => a.matchId));
    // Starter accounts nothing uses go, so the chart looks like the client's. Accounts that hold
    // transactions, and the A/R, A/P, sales tax and opening balance accounts, always stay.
    const keep = e => matched.has(e.id) || (opts.used && opts.used.has(e.id)) || ['ar', 'ap', 'tax', 'qst', 'ob'].includes(e.detail);
    if (opts.replaceStarter) for (const e of ex) if (!keep(e)) deletes.push({ op: 'delete', collection: 'accounts', id: e.id });
    const gone = new Set(deletes.map(d => d.id));
    // Account numbers must stay unique. Accounts that stay as they are keep theirs; then renamed and
    // new accounts get the client's numbers where free. Renamed accounts first give up their old
    // number (so a new account can take it), and get their new one at the end.
    const renamed = new Set(p.accounts.filter(a => a.matchId && a.rename && !a.skip).map(a => a.matchId));
    for (const e of ex) if (!gone.has(e.id) && e.code && !renamed.has(e.id)) codes.add(e.code);
    const takeCode = c => (c && !codes.has(c) ? (codes.add(c), c) : '');
    const renames = [], finals = [], creates = [];
    for (const a of p.accounts) {
      if (a.skip) continue;
      if (a.matchId) {
        ids[a.key] = a.matchId;
        const e = ex.find(x => x.id === a.matchId);
        if (a.rename && e) {
          const code = takeCode(a.number) || takeCode(e.code);
          renames.push({ op: 'set', collection: 'accounts', id: e.id, data: { ...strip(e), name: a.name.slice(0, 120), code: '', active: true } });
          if (code) finals.push({ op: 'set', collection: 'accounts', id: e.id, data: { ...strip(e), name: a.name.slice(0, 120), code, active: true } });
        }
        continue;
      }
      const id = uid();
      ids[a.key] = id;
      creates.push({ id, a });
    }
    for (const { id, a } of creates) {
      writes.push({ op: 'set', collection: 'accounts', id, data: { code: takeCode(a.number), name: a.name.slice(0, 120), type: a.type, detail: a.detail || '', desc: a.fullName !== a.name ? a.fullName : '', active: true, imported: src } });
    }
    writes.unshift(...renames);
    writes.push(...finals);
    const cid = {};
    for (const c of existing.contacts || []) cid[c.kind + '|' + low(c.name)] = c.id;
    for (const c of p.contacts) {
      const id = uid(); cid[c.kind + '|' + low(c.name)] = id;
      writes.push({ op: 'set', collection: 'contacts', id, data: { name: c.name.slice(0, 160), kind: c.kind, email: c.email || '', phone: c.phone || '', address: c.address || '', notes: '', created: now } });
    }
    const acctId = key => ids[key];
    // Opening balances
    if (p.tb && p.tb.lines.length) {
      const lines = p.tb.lines.filter(l => acctId(l.key)).map(l => ({ account: acctId(l.key), debit: l.amount > 0 ? r2(l.amount) : 0, credit: l.amount < 0 ? r2(-l.amount) : 0, memo: 'Opening balance' }));
      const diff = r2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
      if (Math.abs(diff) >= 0.005) {
        const ob = ex.find(e => e.detail === 'ob');
        if (ob) lines.push({ account: ob.id, debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, memo: 'Rounding difference on the trial balance' });
      }
      writes.push({ op: 'set', collection: 'entries', id: uid(), data: { type: 'journal', date: p.tb.date, ref: '', memo: `Opening balances from ${src} (trial balance as of ${p.tb.date})`, lines, created: now, imported: src, opening: true } });
    }
    // Open invoices and bills, carried over so they can be paid. With a trial balance, A/R and A/P already
    // hold these amounts, so each one posts to the control account on both sides (no change to the balance).
    // Without one, the other side is Opening balance equity.
    const control = d => { const a = p.accounts.find(x => x.detail === d && acctId(x.key)); return a ? acctId(a.key) : (ex.find(e => e.detail === d) || {}).id; };
    const obId = (ex.find(e => e.detail === 'ob') || {}).id;
    for (const kind of ['ar', 'ap']) {
      const ctl = control(kind);
      if (!ctl) continue;
      // With a trial balance or history, A/R and A/P already hold these amounts.
      const other = p.tb || (p.journal && p.useJournal !== false && p.journal.txns.length) ? ctl : obId;
      if (!other) continue;
      for (const i of p.open[kind]) {
        const id = uid(), inv = kind === 'ar', amt = r2(i.open);
        const contactId = cid[(inv ? 'customer' : 'vendor') + '|' + low(i.name)] || '';
        const desc = `Balance carried over from ${src}${i.amount && Math.abs(i.amount - amt) >= 0.01 ? ` (original amount ${i.amount.toFixed(2)})` : ''}`;
        writes.push({ op: 'set', collection: 'docs', id, data: { kind: inv ? 'invoice' : 'bill', number: i.number, date: i.date, due: i.due || i.date, contactId, lines: [{ desc, account: other, qty: 1, rate: amt, taxCode: 'none', tax: false }], sub: amt, tax: 0, total: amt, taxRate: 0, memo: '', carried: true, created: now } });
        const lines = inv ? [{ account: ctl, debit: amt, credit: 0 }, { account: other, debit: 0, credit: amt, taxCode: 'none' }] : [{ account: other, debit: amt, credit: 0, taxCode: 'none' }, { account: ctl, debit: 0, credit: amt }];
        writes.push({ op: 'set', collection: 'entries', id: 'd_' + id, data: { type: inv ? 'invoice' : 'bill', date: i.date, ref: i.number, docId: id, contactId, lines, created: now } });
      }
    }
    // Transaction history, as journal entries.
    if (p.journal && p.useJournal !== false) {
      for (const x of p.journal.txns) {
        const lines = x.lines.filter(l => acctId(l.key)).map(l => ({ account: acctId(l.key), debit: l.debit, credit: l.credit, ...(l.memo ? { memo: l.memo.slice(0, 200) } : {}) }));
        if (lines.length < 2) continue;
        const name = x.name ? low(x.name) : '';
        const contactId = name ? cid['customer|' + name] || cid['vendor|' + name] || '' : '';
        writes.push({ op: 'set', collection: 'entries', id: uid(), data: { type: 'journal', date: x.date, ref: x.num.slice(0, 40), memo: [x.type, x.name, x.memo].filter(Boolean).join(' · ').slice(0, 300), contactId, lines, created: now, imported: src } });
      }
    }
    return [...deletes, ...writes];
  }
  const strip = o => { const c = { ...o }; delete c.id; return c; };

  return { unzip, readXlsx, readFile, classify, findHeader, readAccounts, readContacts, readTB, readOpen, readJournal, guessType, plan, build, dateFormatOf, ambiguousDates, KINDS, KIND_LABEL, asOfDate, splitNumber };
});
