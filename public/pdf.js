/*
 * A small PDF writer for invoices, credit notes and statements: Letter pages, Helvetica and
 * Helvetica-Bold (the standard PDF fonts, with French accents), lines, filled boxes, and a JPEG logo.
 * Works in the browser (window.TallyPDF) and in Node (require) so it can be tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyPDF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Character widths (1/1000 of the font size), from the Adobe font metrics, for ASCII 32–126.
  const W = {
    r: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
    b: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
  };
  // Characters outside ASCII that WinAnsi can show, with the plain letter whose width they share.
  const WIN = { 'à': [0xe0, 'a'], 'â': [0xe2, 'a'], 'ä': [0xe4, 'a'], 'ç': [0xe7, 'c'], 'è': [0xe8, 'e'], 'é': [0xe9, 'e'], 'ê': [0xea, 'e'], 'ë': [0xeb, 'e'], 'î': [0xee, 'i'], 'ï': [0xef, 'i'], 'ô': [0xf4, 'o'], 'ö': [0xf6, 'o'], 'ù': [0xf9, 'u'], 'û': [0xfb, 'u'], 'ü': [0xfc, 'u'], 'ÿ': [0xff, 'y'], 'ñ': [0xf1, 'n'],
    'À': [0xc0, 'A'], 'Â': [0xc2, 'A'], 'Ç': [0xc7, 'C'], 'È': [0xc8, 'E'], 'É': [0xc9, 'E'], 'Ê': [0xca, 'E'], 'Ë': [0xcb, 'E'], 'Î': [0xce, 'I'], 'Ï': [0xcf, 'I'], 'Ô': [0xd4, 'O'], 'Ù': [0xd9, 'U'], 'Û': [0xdb, 'U'], 'Ü': [0xdc, 'U'],
    '’': [0x92, "'"], '‘': [0x91, "'"], '“': [0x93, '"'], '”': [0x94, '"'], '–': [0x96, '-'], '—': [0x97, 'M'], '•': [0x95, '-'], '…': [0x85, 'M'], '€': [0x80, 'C'], '\u202f': [0x20, ' '], '\u2009': [0x20, ' '], '\u00a0': [0x20, ' '], '«': [0xab, '<'], '»': [0xbb, '>'], '°': [0xb0, 'o'], '·': [0xb7, '.'], ' ': [0xa0, ' '], ' ': [0x20, ' '], ' ': [0x20, ' '] };
  const EXTRA = { 'œ': 0x9c, 'Œ': 0x8c, 'Š': 0x8a, 'š': 0x9a, 'Ž': 0x8e, 'ž': 0x9e, 'Ÿ': 0x9f, '™': 0x99, '†': 0x86, '‰': 0x89 };
  const charWidth = (ch, bold) => {
    const t = bold ? W.b : W.r;
    let c = ch.charCodeAt(0);
    if (WIN[ch]) { if (ch === '—' || ch === '…') return 1000; c = WIN[ch][1].charCodeAt(0); }
    return c >= 32 && c <= 126 ? t[c - 32] : 556;
  };
  const widthOf = (s, size, bold) => { let w = 0; for (const ch of String(s)) w += charWidth(ch, bold); return w * size / 1000; };
  // Text into a PDF string in WinAnsi, escaping ( ) \ ; anything WinAnsi can't show becomes '?'.
  const encode = s => {
    let out = '';
    for (const ch of String(s)) {
      let c = ch.charCodeAt(0);
      if (WIN[ch]) c = WIN[ch][0];
      else if (c >= 0xa0 && c <= 0xff) { /* Latin-1 letters are the same in WinAnsi */ }
      else if (EXTRA[ch]) c = EXTRA[ch];
      else if (c < 32 || c > 126) c = 63;
      const x = String.fromCharCode(c);
      out += x === '(' || x === ')' || x === '\\' ? '\\' + x : c > 126 ? '\\' + c.toString(8).padStart(3, '0') : x;
    }
    return out;
  };
  const num = n => (Math.round(n * 100) / 100).toString();
  const rgb = hex => { const h = String(hex || '#000000').replace('#', ''); return [0, 2, 4].map(i => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(' '); };

  /** Size of a JPEG, from its first frame header. */
  function jpegSize(b) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
      i += 2 + len;
    }
    return null;
  }

  function create(opts = {}) {
    const PW = opts.landscape ? 792 : 612, PH = opts.landscape ? 612 : 792; // Letter, in points
    const pages = [];
    let cur = null;
    const images = [];
    const doc = {
      width: PW, height: PH,
      addPage() { cur = { ops: [] }; pages.push(cur); return doc; },
      pageCount() { return pages.length; },
      goto(i) { cur = pages[i]; return doc; },
      // y is measured from the top of the page.
      text(x, y, s, o = {}) {
        const size = o.size || 10, bold = !!o.bold;
        let tx = x;
        if (o.align === 'right') tx = x - widthOf(s, size, bold);
        else if (o.align === 'center') tx = x - widthOf(s, size, bold) / 2;
        cur.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(o.color || '#1a1a1a')} rg ${num(tx)} ${num(PH - y)} Td (${encode(s)}) Tj ET`);
        return doc;
      },
      line(x1, y1, x2, y2, o = {}) { cur.ops.push(`${rgb(o.color || '#cccccc')} RG ${num(o.width || 0.75)} w ${num(x1)} ${num(PH - y1)} m ${num(x2)} ${num(PH - y2)} l S`); return doc; },
      rect(x, y, w, h, o = {}) { cur.ops.push(`${rgb(o.fill || '#eeeeee')} rg ${num(x)} ${num(PH - y - h)} ${num(w)} ${num(h)} re f`); return doc; },
      /** Draw a JPEG at (x, y) fitted inside maxW × maxH. Returns the size used. */
      image(bytes, x, y, maxW, maxH) {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const sz = jpegSize(b);
        if (!sz || !sz.w || !sz.h) return null;
        const k = Math.min(maxW / sz.w, maxH / sz.h);
        const w = sz.w * k, h = sz.h * k;
        const name = 'Im' + (images.length + 1);
        images.push({ name, bytes: b, ...sz });
        cur.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(PH - y - h)} cm /${name} Do Q`);
        return { w, h };
      },
      widthOf,
      /** Split text into lines no wider than maxW. */
      wrap(s, maxW, size = 10, bold = false) {
        const out = [];
        for (const para of String(s || '').split(/\r?\n/)) {
          let line = '';
          for (let word of para.split(/\s+/)) {
            // A word wider than the line (a long web address) is broken up.
            while (widthOf(word, size, bold) > maxW && word.length > 1) {
              let n = word.length;
              while (n > 1 && widthOf(word.slice(0, n), size, bold) > maxW) n--;
              if (line) { out.push(line); line = ''; }
              out.push(word.slice(0, n)); word = word.slice(n);
            }
            const tryLine = line ? line + ' ' + word : word;
            if (widthOf(tryLine, size, bold) <= maxW || !line) line = tryLine;
            else { out.push(line); line = word; }
          }
          out.push(line);
        }
        return out;
      },
      /** The finished PDF file. */
      output() {
        const enc = new TextEncoder();
        const chunks = [], offsets = [];
        let len = 0;
        const push = x => { const b = typeof x === 'string' ? latin1(x) : x; chunks.push(b); len += b.length; };
        const latin1 = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
        const objs = [];
        const add = body => { objs.push(body); return objs.length; };
        const catalog = add(null), pagesObj = add(null);
        const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        const imgRefs = images.map(im => add({ head: `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${im.comps === 1 ? '/DeviceGray' : im.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>`, data: im.bytes }));
        const xobj = images.length ? `/XObject << ${images.map((im, i) => `/${im.name} ${imgRefs[i]} 0 R`).join(' ')} >>` : '';
        const pageRefs = [];
        for (const p of pages) {
          const content = latin1(p.ops.join('\n'));
          const c = add({ head: `<< /Length ${content.length} >>`, data: content });
          pageRefs.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> ${xobj} >> /Contents ${c} 0 R >>`));
        }
        objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
        objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageRefs.map(r => r + ' 0 R').join(' ')}] /Count ${pageRefs.length} >>`;
        push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
        objs.forEach((o, i) => {
          offsets.push(len);
          if (typeof o === 'string') push(`${i + 1} 0 obj\n${o}\nendobj\n`);
          else { push(`${i + 1} 0 obj\n${o.head}\nstream\n`); push(o.data); push('\nendstream\nendobj\n'); }
        });
        const xref = len;
        push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`);
        push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
        const out = new Uint8Array(len);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        void enc;
        return out;
      },
    };
    doc.addPage();
    return doc;
  }
  return { create, widthOf, jpegSize, encode };
});
