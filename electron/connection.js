'use strict';
// Checks for the office-server address, kept apart from Electron so tests can run them.

/** Tidy a typed server address into its origin. HTTPS only, except this computer (for testing). */
function serverOrigin(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your server’s address.');
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('That isn’t a web address. It looks like https://books.yourfirm.ca'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The address has to start with https:// so passwords and the books travel encrypted.');
  if (u.username || u.password) throw new Error('Leave the user name and password out of the address. You sign in after connecting.');
  return u.origin;
}

function netMessage(e) {
  const m = String((e && e.message) || e);
  if (/CERT|SSL/i.test(m)) return 'The server’s security certificate isn’t valid, so the app won’t connect. Ask whoever set up the server to check its HTTPS certificate.';
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION/i.test(m)) return 'Couldn’t find a server with that address. Check the spelling, and that you’re connected to the internet or the office VPN.';
  if (/REFUSED|TIMED_OUT|TimeoutError|aborted|UNREACHABLE|ADDRESS_INVALID|CONNECTION/i.test(m)) return 'The server didn’t answer. It may be off, or this computer can’t reach it (check the internet or the office VPN).';
  if (/INTERNET_DISCONNECTED/i.test(m)) return 'This computer isn’t connected to the internet.';
  return 'Couldn’t connect to the server (' + m.slice(0, 120) + ').';
}

module.exports = { serverOrigin, netMessage };
