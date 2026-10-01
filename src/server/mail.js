'use strict';
/*
 * Sending email (invoices, credit notes, statements, reminders) from a company's own mailbox, over SMTP.
 * No outside packages: a small SMTP client on Node's net/tls, with STARTTLS or SSL, and AUTH PLAIN/LOGIN.
 * The mailbox password (usually an "app password") is kept on the server and never sent to the browser.
 */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');
const dns = require('node:dns').promises;
const { ValidationError } = require('./validate');

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[A-Za-z]{2,}$/;
const clean = s => String(s == null ? '' : s).replace(/[\r\n\u0000]+/g, ' ').trim();
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const word = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`); // RFC 2047 for headers
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n');

/** Check and tidy mailbox settings. Keeps the saved password when none is given. */
function validateMail(body, prev = {}, o = {}) {
  const host = clean(body.host).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) throw new ValidationError('Enter the email server (for example smtp.gmail.com).');
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError('Enter the email server’s port (usually 465 or 587).');
  const security = ['ssl', 'starttls', 'none'].includes(body.security) ? body.security : 'starttls';
  if (security === 'none' && !o.allowLocal) throw new ValidationError('Email has to be sent over a secure connection (SSL or STARTTLS).');
  const user = clean(body.user).slice(0, 200);
  if (!user) throw new ValidationError('Enter the user name for the mailbox (usually the email address).');
  const fromEmail = clean(body.fromEmail || user).slice(0, 200);
  if (!EMAIL_RE.test(fromEmail)) throw new ValidationError('Enter the email address messages are sent from.');
  // The saved password only stays when nothing about where it's sent changes; otherwise it has to be typed again.
  const same = prev.host === host && prev.port === port && prev.security === security && prev.user === user;
  const pass = body.pass !== undefined && body.pass !== '' ? String(body.pass).slice(0, 500) : same ? prev.pass : '';
  if (!pass && prev.pass && !same) throw new ValidationError('Enter the mailbox password again: the server or user name changed.');
  if (!pass) throw new ValidationError('Enter the password for the mailbox (an app password for Gmail, Yahoo or iCloud).');
  return { host, port, security, user, pass, fromEmail, fromName: clean(body.fromName).slice(0, 120), replyTo: EMAIL_RE.test(clean(body.replyTo)) ? clean(body.replyTo) : '' };
}
const publicMail = m => (m && m.host ? { configured: true, host: m.host, port: m.port, security: m.security, user: m.user, fromEmail: m.fromEmail, fromName: m.fromName, replyTo: m.replyTo || '' } : { configured: false });

/** Build the message. attachments: [{ name, type, data: Buffer }] */
function buildMessage(cfg, msg) {
  const boundary = 'tb-' + crypto.randomBytes(12).toString('hex');
  const name = clean(cfg.fromName);
  const from = name ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : word(name)} <${cfg.fromEmail}>` : cfg.fromEmail;
  const domain = cfg.fromEmail.split('@')[1] || 'localhost';
  const head = [
    `From: ${from}`,
    `To: ${msg.to.join(', ')}`,
    msg.cc && msg.cc.length ? `Cc: ${msg.cc.join(', ')}` : '',
    cfg.replyTo || msg.replyTo ? `Reply-To: ${msg.replyTo || cfg.replyTo}` : '',
    `Subject: ${word(clean(msg.subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');
  let body = `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(msg.text))}`;
  for (const a of msg.attachments || []) {
    const name = String(a.name).replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 100) || 'document.pdf';
    body += `--${boundary}\r\nContent-Type: ${a.type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(a.data.toString('base64'))}`;
  }
  body += `--${boundary}--\r\n`;
  return head + '\r\n\r\n' + body;
}

/** Talk to the SMTP server and hand over one message. */
async function send(cfg, msg, opts = {}) {
  for (const a of [...msg.to, ...(msg.cc || [])]) if (a.length > 254) throw new ValidationError('An email address is too long.');
  // Only real mail servers on the internet, not this computer or the local network.
  if (!opts.allowLocal) {
    let addrs;
    try { addrs = await dns.lookup(cfg.host, { all: true }); } catch (e) { throw netError(e); }
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new ValidationError('That email server is on a private network. Use your provider’s internet mail server.', 400);
  }
  return sendNow(cfg, msg, opts);
}
function isPrivate(ip) {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || /^::ffff:(127|10|192\.168)\./.test(v6);
}
function sendNow(cfg, msg, opts = {}) {
  const timeout = opts.timeout || 30000;
  const data = buildMessage(cfg, msg).replace(/(^|\r\n)\./g, '$1..'); // dot-stuffing
  return new Promise((resolve0, reject0) => {
    let resolve = resolve0, reject = reject0;
    let sock, buf = '', waiting = null, done = false;
    const fail = e => { if (done) return; done = true; try { sock.destroy(); } catch { /* closed */ } reject(e); };
    const onData = chunk => {
      buf += chunk.toString('latin1');
      let m;
      // A reply ends with a line "250 ..." (code then space); "250-..." lines continue it.
      while ((m = buf.match(/^(?:\d{3}-[^\r\n]*\r?\n)*(\d{3})(?: [^\r\n]*)?\r?\n/))) {
        const text = m[0];
        buf = buf.slice(text.length);
        if (waiting) { const w = waiting; waiting = null; w({ code: Number(m[1]), text }); }
      }
    };
    const reply = () => new Promise(res => { waiting = res; });
    const write = s => sock.write(s);
    const expect = async (cmd, ok, what) => {
      if (cmd != null) write(cmd + '\r\n');
      const r = await reply();
      if (!ok.includes(r.code)) throw smtpError(r, what);
      return r;
    };
    const attach = s => { sock = s; sock.setTimeout(timeout, () => fail(new ValidationError('The email server didn’t answer in time.', 504))); sock.on('data', onData); sock.on('error', e => fail(netError(e))); };
    const run = async () => {
      await expect(null, [220], 'greeting');
      const helo = 'EHLO ' + (os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'tallybooks');
      let ehlo = await expect(helo, [250], 'hello');
      if (cfg.security === 'starttls') {
        if (!/STARTTLS/i.test(ehlo.text)) throw new ValidationError('That email server doesn’t offer a secure connection on this port. Try port 465 with SSL.', 502);
        await expect('STARTTLS', [220], 'starttls');
        sock.removeListener('data', onData);
        // Anything sent before the secure connection starts can't be trusted.
        if (buf) throw new ValidationError('The email server’s secure connection didn’t start cleanly.', 502);
        await new Promise((res, rej) => {
          const t = tls.connect({ socket: sock, servername: cfg.host, rejectUnauthorized: !opts.insecureTls }, res);
          t.once('error', rej);
          attach(t);
        });
        ehlo = await expect(helo, [250], 'hello');
      }
      if (/AUTH[ =][^\r\n]*PLAIN/i.test(ehlo.text)) await expect('AUTH PLAIN ' + Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`).toString('base64'), [235], 'auth');
      else {
        await expect('AUTH LOGIN', [334], 'auth');
        await expect(Buffer.from(cfg.user).toString('base64'), [334], 'auth');
        await expect(Buffer.from(cfg.pass).toString('base64'), [235], 'auth');
      }
      await expect(`MAIL FROM:<${cfg.fromEmail}>`, [250], 'from');
      for (const r of [...msg.to, ...(msg.cc || [])]) await expect(`RCPT TO:<${r}>`, [250, 251], 'to');
      await expect('DATA', [354], 'data');
      write(data + '\r\n.\r\n');
      await expect(null, [250], 'data');
      write('QUIT\r\n');
      done = true; sock.end(); resolve({ ok: true });
    };
    // However slowly the server answers, give up after a minute overall.
    const deadline = setTimeout(() => fail(new ValidationError('The email server didn’t answer in time.', 504)), opts.deadline || 60000);
    deadline.unref && deadline.unref();
    const finish = resolve; resolve = v => { clearTimeout(deadline); finish(v); };
    const rej = reject; reject = e => { clearTimeout(deadline); rej(e); };
    try {
      if (cfg.security === 'ssl') attach(tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: !opts.insecureTls }));
      else attach(net.connect({ host: cfg.host, port: cfg.port }));
    } catch (e) { return reject(netError(e)); }
    run().catch(fail);
  });
}
function smtpError(r, what) {
  const t = r.text.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (what === 'auth') return new ValidationError(`The email server didn’t accept the user name or password. Gmail, Yahoo and iCloud need an app password, not the usual one. (${t})`, 502);
  if (what === 'to') return new ValidationError(`The email server refused a recipient address. (${t})`, 502);
  if (what === 'from') return new ValidationError(`The email server won’t send from that address. Use the mailbox’s own address. (${t})`, 502);
  return new ValidationError(`The email server returned an error. (${t})`, 502);
}
function netError(e) {
  if (e instanceof ValidationError) return e;
  if (e && (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN')) return new ValidationError('Couldn’t find that email server. Check its name.', 502);
  if (e && (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT')) return new ValidationError('Couldn’t connect to the email server. Check the server name and port.', 502);
  if (e && /certificate|self.signed/i.test(e.message || '')) return new ValidationError('The email server’s security certificate isn’t valid.', 502);
  return new ValidationError('Couldn’t send through the email server: ' + String((e && e.message) || e).slice(0, 150), 502);
}

module.exports = { send, validateMail, publicMail, buildMessage, EMAIL_RE };
