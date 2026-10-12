'use strict';
/*
 * Receipts by email. Each company gets its own address, r-<token>@<inbound domain>. A server can't receive
 * email by itself, so a mail provider (Postmark or SendGrid) receives it and calls our webhook,
 * POST /api/inbound/email/<secret>, with the message. This file holds the parts that don't need the server:
 *   - the server's settings (on/off, the inbound domain, the webhook secret) and each company's token, kept in
 *     inbound.json beside the server's other private settings (never in a company's books or backups);
 *   - reading what Postmark (JSON) and SendGrid Inbound Parse (multipart form) send into one plain shape;
 *   - which files are allowed (PDF and photos, recognized by their first bytes, never by name or claimed type);
 *   - turning an email with no attachment into a PDF of its text, so the body itself can be the receipt.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError } = require('./validate');
const TallyPDF = require('../../public/pdf.js');

const LIMITS = {
  attachment: 10 * 1024 * 1024,   // one file, as on the Receipts screen
  email: 25 * 1024 * 1024,        // every file in one email together
  request: 40 * 1024 * 1024,      // the webhook call itself (base64 makes files a third bigger)
  files: 10,                      // receipts made from one email
  perHour: 60,                    // emails taken in per company each hour
};
// Email signatures and logos come as small inline pictures; they aren't receipts.
const INLINE_MIN = 30 * 1024;

/** New random token: 128 bits, lowercase hex (email addresses aren't case-sensitive). */
const newToken = () => crypto.randomBytes(16).toString('hex');
const newSecret = () => crypto.randomBytes(32).toString('base64url');
const DOMAIN_RE = /^(?=.{4,190}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

class InboundSettings {
  /** @param {string} dir  The server's own folder (the licence folder on desktop), not a shared books folder. */
  constructor(dir) {
    this.file = path.join(dir, 'inbound.json');
    this.data = { on: false, domain: '', secret: '', tokens: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    if (!this.data.tokens || typeof this.data.tokens !== 'object') this.data.tokens = {};
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }
  /** Turned on, with a domain and a secret: the webhook takes email. */
  ready() { return !!(this.data.on && this.data.domain && this.data.secret); }
  /** For the administrator only: the secret is part of the webhook address they paste into the provider. */
  status() { return { on: !!this.data.on, domain: this.data.domain, secret: this.data.secret, ready: this.ready(), addresses: Object.keys(this.data.tokens).length }; }
  update(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Send the email settings as an object.');
    if (body.domain !== undefined) {
      const d = String(body.domain || '').trim().toLowerCase().replace(/^@/, '');
      if (d && !DOMAIN_RE.test(d)) throw new ValidationError('Enter a domain such as receipts.example.com, without @ or https://.');
      this.data.domain = d;
    }
    if (body.newSecret === true || !this.data.secret) this.data.secret = newSecret();
    if (body.on !== undefined) {
      if (body.on && !this.data.domain) throw new ValidationError('Enter the domain that receives the email first.');
      this.data.on = !!body.on;
    }
    this.save();
    return this.status();
  }
  /** Is this the webhook's secret? Compared in constant time (hashes are the same length whatever was sent). */
  secretOk(given) {
    if (!this.data.secret) return false;
    const a = crypto.createHash('sha256').update(String(given || '')).digest();
    const b = crypto.createHash('sha256').update(this.data.secret).digest();
    return crypto.timingSafeEqual(a, b);
  }
  tokenOf(cid) { return this.data.tokens[cid] || ''; }
  /** The company's token, made the first time it's asked for. */
  ensure(cid) { if (!this.data.tokens[cid]) { this.data.tokens[cid] = newToken(); this.save(); } return this.data.tokens[cid]; }
  /** A new address for the company; the old one stops working at once. */
  rotate(cid) { this.data.tokens[cid] = newToken(); this.save(); return this.data.tokens[cid]; }
  drop(cid) { if (this.data.tokens[cid]) { delete this.data.tokens[cid]; this.save(); } }
  address(cid) { const t = this.tokenOf(cid); return t && this.data.domain ? `r-${t}@${this.data.domain}` : ''; }
  /** Which company an address belongs to: r-<token>@<our domain>. Anything else is nobody's. */
  companyFor(addr) {
    const m = /^r-([0-9a-f]{32})@(.+)$/.exec(String(addr || '').trim().toLowerCase());
    if (!m || m[2] !== this.data.domain) return '';
    for (const [cid, t] of Object.entries(this.data.tokens)) if (t.length === m[1].length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(m[1]))) return cid;
    return '';
  }
}

/* ---------- reading what the providers send ---------- */
/** Email addresses in a header such as `"Pat Lee" <pat@x.com>, sam@y.ca`. */
function addrsIn(s) { return [...String(s || '').matchAll(/[A-Za-z0-9._%+'=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}/g)].map(m => m[0].toLowerCase()); }
const nameIn = s => { const m = /^\s*"?([^"<]*?)"?\s*</.exec(String(s || '')); return m ? m[1].trim() : ''; };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);

/** Postmark's inbound JSON → { fromEmail, fromName, subject, recipients, text, html, attachments } */
function fromPostmark(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new ValidationError('That isn’t an email.');
  const full = j.FromFull && typeof j.FromFull === 'object' ? j.FromFull : {};
  const list = v => (Array.isArray(v) ? v : []).map(x => (x && x.Email) || '').join(',');
  const recipients = [...new Set(addrsIn([j.OriginalRecipient, j.To, j.Cc, j.Bcc, list(j.ToFull), list(j.CcFull), list(j.BccFull)].join(',')))];
  const attachments = (Array.isArray(j.Attachments) ? j.Attachments : []).slice(0, 50).filter(a => a && typeof a === 'object').map(a => ({
    name: clean(a.Name, 200), type: clean(a.ContentType, 100), inline: !!a.ContentID, data: Buffer.from(String(a.Content || ''), 'base64'),
  }));
  return { fromEmail: addrsIn(full.Email || j.From)[0] || '', fromName: clean(full.Name || nameIn(j.From), 120), subject: clean(j.Subject, 300), recipients,
    text: String(j.TextBody || j.StrippedTextReply || ''), html: String(j.HtmlBody || ''), attachments };
}

/** A multipart/form-data body → [{ name, filename, type, data }]. Small and strict: it only needs to read SendGrid. */
function parseMultipart(buf, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!bm) throw new ValidationError('The form has no boundary.');
  const delim = Buffer.from('--' + (bm[1] || bm[2]));
  const parts = [];
  let pos = buf.indexOf(delim);
  while (pos >= 0 && parts.length < 200) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;            // "--": the end
    if (buf[pos] === 0x0d) pos++;
    if (buf[pos] === 0x0a) pos++;
    const next = buf.indexOf(delim, pos);
    if (next < 0) break;
    let part = buf.subarray(pos, next);
    if (part[part.length - 1] === 0x0a) part = part.subarray(0, part.length - (part[part.length - 2] === 0x0d ? 2 : 1));
    let he = part.indexOf('\r\n\r\n'), skip = 4;
    if (he < 0) { he = part.indexOf('\n\n'); skip = 2; }
    if (he >= 0) {
      const head = part.subarray(0, he).toString('utf8');
      const disp = /content-disposition:[^\n]*/i.exec(head);
      const name = disp && /\bname="([^"]*)"/i.exec(disp[0]);
      const file = disp && /\bfilename="([^"]*)"/i.exec(disp[0]);
      const type = /content-type:\s*([^\r\n;]+)/i.exec(head);
      if (name) parts.push({ name: name[1], filename: file ? file[1] : null, type: type ? type[1].trim().toLowerCase() : '', data: part.subarray(he + skip) });
    }
    pos = next;
  }
  return parts;
}

/** SendGrid Inbound Parse (the default, "parsed" form) → the same shape as fromPostmark. */
function fromSendgrid(buf, contentType) {
  const parts = parseMultipart(buf, contentType);
  const field = n => { const p = parts.find(x => x.name === n && x.filename === null); return p ? p.data.toString('utf8') : ''; };
  let info = {}, env = {};
  try { info = JSON.parse(field('attachment-info') || '{}') || {}; } catch { /* none */ }
  try { env = JSON.parse(field('envelope') || '{}') || {}; } catch { /* none */ }
  const recipients = [...new Set(addrsIn([field('to'), field('cc'), ...(Array.isArray(env.to) ? env.to : [])].join(',')))];
  const attachments = parts.filter(p => p.filename !== null).slice(0, 50).map(p => {
    const i = (info && typeof info[p.name] === 'object' && info[p.name]) || {};
    return { name: clean(p.filename || i.filename, 200), type: clean(p.type || i.type, 100), inline: !!(i['content-id'] || i.content_id), data: p.data };
  });
  const from = field('from');
  return { fromEmail: addrsIn(from)[0] || addrsIn(env.from)[0] || '', fromName: clean(nameIn(from), 120), subject: clean(field('subject'), 300), recipients,
    text: field('text'), html: field('html'), attachments };
}

/* ---------- files ---------- */
/** What a file really is, from its first bytes. PDFs and photos only; HEIC is what iPhones take. */
function sniffInbound(b) {
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(b.toString('latin1', 8, 12))) return 'image/heic';
  return '';
}

/** HTML email → plain text: tags, styles and scripts dropped (nothing from the HTML is kept). */
function htmlToText(h) {
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };
  return String(h || '').slice(0, 2e6)
    .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n').replace(/<\/t[dh]\s*>/gi, '  ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(Math.min(0x10ffff, parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) || 32) : ent[e.toLowerCase()] ?? m))
    .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The email's own text as a PDF: who sent it, the subject and the body. Used when nothing is attached. */
function bodyPdf(mail, when = new Date()) {
  const text = (String(mail.text || '').trim() || htmlToText(mail.html)).slice(0, 30000);
  const doc = TallyPDF.create();
  const L = 54, R = 558, BOTTOM = 740;
  let y = 60;
  doc.text(L, y, 'Receipt sent by email', { size: 14, bold: true }); y += 24;
  for (const [k, v] of [['From', mail.fromName ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail], ['Subject', mail.subject], ['Received', when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC']]) {
    if (!v) continue;
    doc.text(L, y, k, { size: 9, color: '#666666' });
    doc.wrap(v, R - L - 70, 10).slice(0, 3).forEach(line => { doc.text(L + 70, y, line, { size: 10 }); y += 14; });
  }
  y += 6; doc.line(L, y, R, y); y += 18;
  let pages = 1;
  for (const line of doc.wrap(text || '(The email had no text.)', R - L, 10)) {
    if (y > BOTTOM) { if (++pages > 10) { doc.text(L, y, '…', { size: 10 }); break; } doc.addPage(); y = 60; }
    doc.text(L, y, line, { size: 10 }); y += 13;
  }
  return Buffer.from(doc.output());
}

/** Does the sender match the company's list? Entries are addresses, or @domain.com for everyone at a domain. */
function senderAllowed(list, email) {
  if (!Array.isArray(list) || !list.length) return true;
  const e = String(email || '').toLowerCase();
  return !!e && list.some(a => (a.startsWith('@') ? e.endsWith(a) : e === a));
}
/** The company's list of allowed senders, cleaned. */
function cleanAllowed(list) {
  if (!Array.isArray(list)) throw new ValidationError('Send the allowed senders as a list.');
  const out = [];
  for (const raw of list.slice(0, 101)) {
    const a = String(raw || '').trim().toLowerCase();
    if (!a) continue;
    if (!/^([a-z0-9._%+'=-]{1,64})?@[a-z0-9.-]+\.[a-z]{2,63}$/.test(a) || a.length > 200) throw new ValidationError(`“${a.slice(0, 60)}” isn’t an email address. Use name@example.com, or @example.com for everyone there.`);
    if (!out.includes(a)) out.push(a);
  }
  if (out.length > 100) throw new ValidationError('Allow at most 100 senders.');
  return out;
}

module.exports = { InboundSettings, LIMITS, INLINE_MIN, fromPostmark, fromSendgrid, parseMultipart, sniffInbound, htmlToText, bodyPdf, senderAllowed, cleanAllowed, addrsIn };
