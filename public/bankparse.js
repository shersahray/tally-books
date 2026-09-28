/*
 * Bank statement parsing for Tally Books.
 * Reads CSV exports (with or without a header row) and OFX / QFX / QBO files.
 * Works in the browser (window.BankParse) and in Node (require) so it can be tested.
 *
 * Amount convention for every parsed row: positive = money into the account
 * (a deposit, or a payment/credit on a credit card), negative = money out
 * (a withdrawal, or a charge on a credit card).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BankParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');

  function validYMD(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  /** Parse a date string. fmt: 'auto' | 'ymd' | 'mdy' | 'dmy' | 'compact'. Returns YYYY-MM-DD or null. */
  function parseDate(s, fmt = 'auto') {
    if (s === undefined || s === null) return null;
    s = String(s).trim().replace(/^"|"$/g, '');
    if (!s) return null;
    let m;
    if ((fmt === 'auto' || fmt === 'compact') && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{0,6})(\.\d+)?(\[.*\])?$/))) return validYMD(+m[1], +m[2], +m[3]);
    if (fmt === 'compact') return null;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/))) return fmt === 'auto' || fmt === 'ymd' ? validYMD(+m[1], +m[2], +m[3]) : null;
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/))) {
      const a = +m[1], b = +m[2], y = +m[3];
      if (fmt === 'dmy') return validYMD(y, b, a);
      if (fmt === 'mdy') return validYMD(y, a, b);
      if (fmt === 'auto') return a > 12 ? validYMD(y, b, a) : validYMD(y, a, b);
      return null;
    }
    // Text months: 28-Sep-2026, 28 Sep 2026, Sep 28, 2026, September 28 2026
    if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-,]+(\d{2,4})$/)) && MONTHS[m[2].slice(0, 3).toLowerCase()]) return validYMD(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
    if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/)) && MONTHS[m[1].slice(0, 3).toLowerCase()]) return validYMD(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    return null;
  }

  /** Pick the date format that reads every value; prefers the one that disambiguates day/month. */
  function detectDateFormat(values) {
    const vals = values.map(v => String(v || '').trim()).filter(Boolean);
    if (!vals.length) return 'auto';
    const ok = f => vals.every(v => parseDate(v, f));
    if (vals.every(v => /^\d{8}/.test(v)) && ok('compact')) return 'compact';
    if (ok('ymd')) return 'ymd';
    const mdy = ok('mdy'), dmy = ok('dmy');
    if (mdy && !dmy) return 'mdy';
    if (dmy && !mdy) return 'dmy';
    if (mdy && dmy) return 'mdy'; // ambiguous: most Canadian bank exports use MM/DD/YYYY
    return 'auto';
  }

  /** Parse a money string: "$1,234.56", "(12.00)", "-12", "12.00-", "12.00 CR". Returns a number or null. */
  function parseAmount(s) {
    if (s === undefined || s === null) return null;
    let t = String(s).trim().replace(/^"|"$/g, '');
    if (!t) return null;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (/-$/.test(t)) { neg = !neg; t = t.slice(0, -1); }
    if (/\s*DR$/i.test(t)) { neg = !neg; t = t.replace(/\s*DR$/i, ''); }
    t = t.replace(/\s*CR$/i, '');
    t = t.replace(/[$€£\s ]|CAD|USD/gi, '');
    if (/^-/.test(t)) { neg = !neg; t = t.slice(1); }
    if (/^\+/.test(t)) t = t.slice(1);
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // 1.234,56
    else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.'); // 12,50
    else t = t.replace(/,/g, '');
    if (!/^\d*\.?\d+$/.test(t)) return null;
    const n = Math.round(parseFloat(t) * 100) / 100;
    return neg ? -n : n;
  }

  /** RFC 4180-ish CSV reader (quotes, doubled quotes, commas/semicolons/tabs, CRLF). */
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let q = false;
    for (const ch of firstLine) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
    const sep = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === sep) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v.trim() !== '')) rows.push(row.map(v => v.trim()));
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(v => v.trim() !== '')) rows.push(row.map(v => v.trim()));
    return rows;
  }

  const HEADER_RULES = [
    ['date', /^(transaction |trans\.? |posting |posted |value )?date( posted| of transaction)?$|^date$|^posted$/i],
    ['balance', /balance/i],
    ['out', /debit|withdraw|money out|paid out|^charges?$|^spent$/i],
    ['in', /credit|deposit|money in|paid in|^payments?$|^received$/i],
    ['amount', /amount|^cad\$?$|^value$/i],
    ['desc', /desc|details|payee|merchant|^name$|memo|narrative|particulars|^transaction$/i],
  ];

  function classifyHeader(h) {
    const t = String(h || '').trim();
    if (!t) return '';
    if (/usd/i.test(t)) return '';
    for (const [role, re] of HEADER_RULES) if (re.test(t)) return role;
    return '';
  }

  /**
   * Guess how a CSV's columns map to date / description / amount.
   * Returns {header, skip, dateFormat, flip, cols: [role per column]} where role is
 * (skip = lines before the header or first transaction)
   * '' (ignore), 'date', 'desc', 'amount', 'out', 'in'.
   */
  function guessMapping(rows) {
    const width = Math.max(0, ...rows.slice(0, 50).map(r => r.length));
    // Find where the transactions start: the first line with a readable date.
    // The line just before it is the header if it has column names.
    let dataStart = rows.findIndex((r, i) => i < 25 && r.some(v => parseDate(v)));
    if (dataStart < 0) dataStart = 0;
    const prev = rows[dataStart - 1];
    const header = !!prev && prev.filter(v => /[A-Za-z]/.test(v)).length >= 2 && !prev.some(v => parseDate(v));
    const skip = header ? dataStart - 1 : dataStart;
    const first = header ? prev : [];
    const body = rows.slice(dataStart, dataStart + 200);
    const cols = new Array(width).fill('');

    if (header) {
      first.forEach((h, i) => { const r = classifyHeader(h); cols[i] = r === 'balance' ? '' : r; });
      // keep only the first date/amount column; allow several description columns
      ['date', 'amount', 'out', 'in'].forEach(role => {
        let seen = false;
        cols.forEach((r, i) => { if (r === role) { if (seen) cols[i] = ''; seen = true; } });
      });
    }
    const stats = Array.from({ length: width }, (_, i) => {
      const vals = body.map(r => r[i] || '');
      const filled = vals.filter(v => v !== '');
      return {
        dateShare: filled.length ? filled.filter(v => parseDate(v)).length / filled.length : 0,
        numShare: filled.length ? filled.filter(v => parseAmount(v) !== null).length / filled.length : 0,
        fillShare: body.length ? filled.length / body.length : 0,
        avgLen: filled.length ? filled.reduce((s, v) => s + v.length, 0) / filled.length : 0,
        // descriptions vary row to row and are mostly letters; account or card numbers don't
        textScore: filled.length ? (new Set(filled).size / filled.length) * (filled.filter(v => /[A-Za-z]{2}/.test(v)).length / filled.length) * Math.min(1, filled.reduce((s, v) => s + v.length, 0) / filled.length / 4) : 0,
        filledRows: vals.map(v => v !== ''),
      };
    });
    if (!cols.includes('date')) {
      let best = -1, bestShare = 0.8;
      stats.forEach((s, i) => { if (cols[i] === '' && s.dateShare > bestShare) { best = i; bestShare = s.dateShare; } });
      if (best >= 0) cols[best] = 'date';
    }
    if (!cols.includes('amount') && !cols.includes('out') && !cols.includes('in')) {
      const nums = stats.map((s, i) => i).filter(i => cols[i] === '' && stats[i].numShare > 0.95 && stats[i].dateShare < 0.5 && stats[i].fillShare > 0);
      // two columns that are never filled on the same row are money out / money in
      let pair = null;
      for (let a = 0; a < nums.length && !pair; a++) {
        for (let b = a + 1; b < nums.length && !pair; b++) {
          const A = stats[nums[a]].filledRows, B = stats[nums[b]].filledRows;
          const overlap = A.some((f, k) => f && B[k]);
          if (!overlap && A.some(Boolean) && B.some(Boolean)) pair = [nums[a], nums[b]];
        }
      }
      if (pair) { cols[pair[0]] = 'out'; cols[pair[1]] = 'in'; }
      else if (nums.length) cols[nums[0]] = 'amount';
    }
    if (!cols.includes('desc')) {
      let best = -1, score = 0;
      stats.forEach((s, i) => { if (cols[i] === '' && s.numShare < 0.5 && s.dateShare < 0.5 && s.textScore > score) { best = i; score = s.textScore; } });
      if (best >= 0) cols[best] = 'desc';
    }
    const di = cols.indexOf('date');
    const dateFormat = di >= 0 ? detectDateFormat(body.map(r => r[di])) : 'auto';
    return { header, skip, dateFormat, flip: false, cols };
  }

  /** Turn CSV rows into transactions using a mapping. Returns {rows, errors}. */
  function applyMapping(rows, map) {
    const out = [], errors = [];
    const cols = map.cols || [];
    const idx = role => cols.map((r, i) => (r === role ? i : -1)).filter(i => i >= 0);
    const [di] = idx('date'), [ai] = idx('amount'), [oi] = idx('out'), [ii] = idx('in');
    const descCols = idx('desc');
    if (di === undefined) return { rows: [], errors: [{ line: 0, reason: 'Choose which column holds the date.' }] };
    if (ai === undefined && oi === undefined && ii === undefined) return { rows: [], errors: [{ line: 0, reason: 'Choose the amount column, or the money out and money in columns.' }] };
    const start = (map.skip || 0) + (map.header ? 1 : 0);
    rows.slice(start).forEach((r, k) => {
      const line = k + start + 1;
      const date = parseDate(r[di], map.dateFormat || 'auto');
      let amount = null;
      if (ai !== undefined) {
        amount = parseAmount(r[ai]);
        if (amount !== null && map.flip) amount = -amount;
      } else {
        const o = oi !== undefined ? parseAmount(r[oi]) : null;
        const n = ii !== undefined ? parseAmount(r[ii]) : null;
        if (o !== null || n !== null) amount = Math.round(((n || 0) - Math.abs(o || 0)) * 100) / 100;
      }
      const desc = descCols.map(i => r[i] || '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!date && !r.some(v => parseAmount(v) !== null)) return; // a title or totals line, not a transaction
      if (!date) { errors.push({ line, reason: `Couldn’t read the date "${r[di] || ''}".` }); return; }
      if (amount === null) { errors.push({ line, reason: 'No amount on this line.' }); return; }
      if (amount === 0) return;
      out.push({ date, amount, desc, fitid: '' });
    });
    return { rows: out, errors };
  }

  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }

  /** OFX / QFX / QBO (SGML v1 or XML v2). Returns {rows, balance, accountType}. */
  function parseOFX(text) {
    const tag = (block, name) => {
      const m = block.match(new RegExp('<' + name + '>\\s*([^<\\r\\n]*)', 'i'));
      return m ? decodeEntities(m[1].trim()) : '';
    };
    const rows = [];
    const blocks = String(text).split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
    for (const b of blocks) {
      const date = parseDate(tag(b, 'DTPOSTED').slice(0, 8), 'compact') || parseDate(tag(b, 'DTUSER').slice(0, 8), 'compact');
      const amount = parseAmount(tag(b, 'TRNAMT'));
      if (!date || amount === null || amount === 0) continue;
      const name = tag(b, 'NAME'), memo = tag(b, 'MEMO'), payee = tag(b, 'PAYEEID');
      let desc = name || payee;
      if (memo && memo.toLowerCase() !== desc.toLowerCase()) desc = desc ? `${desc} ${memo}` : memo;
      rows.push({ date, amount, desc: desc.replace(/\s+/g, ' ').trim(), fitid: tag(b, 'FITID') });
    }
    let balance = null;
    const lb = String(text).match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>)/i);
    if (lb) {
      const amt = parseAmount(tag(lb[1], 'BALAMT'));
      const d = parseDate(tag(lb[1], 'DTASOF').slice(0, 8), 'compact');
      if (amt !== null) balance = { amount: amt, date: d };
    }
    const accountType = /<CCACCTFROM>/i.test(text) ? 'card' : 'bank';
    return { rows, balance, accountType };
  }

  function detectFormat(text, fileName = '') {
    if (/\.(ofx|qfx|qbo)$/i.test(fileName) || /<OFX>|OFXHEADER/i.test(String(text).slice(0, 2000))) return 'ofx';
    return 'csv';
  }

  return { parseDate, detectDateFormat, parseAmount, parseCSV, guessMapping, applyMapping, parseOFX, detectFormat, classifyHeader };
});
