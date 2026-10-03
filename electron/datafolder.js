'use strict';
/* Choosing the folder that holds the books on this computer, and moving them there safely.
 * Kept apart from Electron so tests can run it.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Everything the server keeps in its data folder. Nothing else is touched (Electron keeps its own caches
// in the default folder, and a folder you pick may hold other files of yours).
const BOOK_FILES = ['companies.json', 'users.json', 'signins.log', 'signins.log.1', 'signins.log.2', 'signins.log.3', 'backup-settings.json', 'ai-settings.json', 'receipts-offsite.json',
  'tally-books.db', 'tally-books.db-wal', 'tally-books.db-shm'];
const BOOK_DIRS = ['companies', 'before-restore'];
const BOOK_ITEMS = [...BOOK_FILES, ...BOOK_DIRS];

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
/** Does this folder hold Sumlora books? */
const hasBooks = dir => ['companies.json', 'users.json', 'tally-books.db'].some(f => exists(path.join(dir, f)));
const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
// Windows and Mac folders ignore upper/lower case; Linux folders don't.
const same = (a, b) => { const x = real(a), y = real(b); return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y; };

const SYNC_RE = /(^|[\\/])(OneDrive[^\\/]*|Google ?Drive|GoogleDrive[^\\/]*|My Drive|Shared drives|Dropbox[^\\/]*|iCloud ?Drive[^\\/]*|iCloudDrive|Mobile Documents|CloudStorage|Box Sync|Box Drive|pCloud ?Drive|MEGAsync|MEGA Sync|Tresorit Drive)([\\/]|$)/i;
// Network file systems, by the type number Linux reports (NFS, SMB, CIFS, SMB2, AFS, Coda, 9P).
const NET_FS = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x5346414f, 0x73757245, 0x01021997]);

/** What could go wrong keeping live books in this folder. */
function folderWarnings(dir, platform = process.platform) {
  const w = [];
  if (SYNC_RE.test(dir)) w.push('sync');
  let network = /^\\\\|^\/\//.test(dir);
  if (!network && platform === 'linux') { try { network = NET_FS.has(Number(fs.statfsSync(dir).type) >>> 0); } catch { /* unknown */ } }
  if (network) w.push('network');
  return w;
}

/** Check a folder someone picked. Returns where the books would go and what to tell them first. */
function checkFolder(picked, current, { platform = process.platform, standard = '' } = {}) {
  if (!picked || !path.isAbsolute(picked)) return { error: 'Choose a folder.' };
  const dir = path.resolve(picked);
  if (!exists(dir) || !fs.statSync(dir).isDirectory()) return { error: 'That folder doesn’t exist any more. Choose another.' };
  if (same(dir, current)) return { same: true, target: dir };
  try { const t = path.join(dir, '.tally-books-write-test-' + process.pid); fs.writeFileSync(t, 'ok'); fs.unlinkSync(t); } catch { return { error: 'Sumlora can’t save in that folder. Choose one you can save files in.' }; }
  // A folder that already has books opens them. An empty folder takes the books as is; any other folder
  // gets a "Sumlora" folder inside it, so the books don't mix with other files.
  let target = dir;
  if (!hasBooks(dir) && !(standard && same(dir, standard))) {
    const others = fs.readdirSync(dir).filter(n => !n.startsWith('.') && n !== 'desktop.ini');
    // Books kept in a "Tally Books" folder (the app's name before Sumlora) open from there.
    if (others.length) target = hasBooks(path.join(dir, 'Tally Books')) ? path.join(dir, 'Tally Books') : path.join(dir, 'Sumlora');
  }
  if (same(target, current)) return { same: true, target };
  const booksThere = hasBooks(target);
  if (!booksThere && exists(target) && BOOK_ITEMS.some(n => exists(path.join(target, n)))) return { error: 'That folder has part of a Sumlora data folder in it. Choose an empty folder.' };
  return { target, booksThere, standard: !!standard && same(target, standard), warnings: folderWarnings(dir, platform) };
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Copy the books (only the books) from one folder to another and check every file arrived intact.
 *  Run it with the books closed. Returns the top-level items copied. Throws, leaving `to` as it was, on any problem. */
function copyBooks(from, to) {
  const items = BOOK_ITEMS.filter(n => exists(path.join(from, n)));
  if (!items.length) return [];
  const created = !exists(to);
  fs.mkdirSync(to, { recursive: true });
  const made = [];
  try {
    for (const n of items) {
      const dest = path.join(to, n);
      if (exists(dest)) throw new Error('The new folder already has ' + n + '.');
      made.push(n); // before copying, so a copy that stops halfway is cleaned up too
      fs.cpSync(path.join(from, n), dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    }
    for (const n of items) {
      const src = path.join(from, n);
      const files = fs.statSync(src).isDirectory() ? walk(src).map(f => path.join(n, f)) : [n];
      for (const f of files) {
        const a = path.join(from, f), b = path.join(to, f);
        if (!exists(b) || fs.statSync(a).size !== fs.statSync(b).size || sha(a) !== sha(b)) throw new Error('A file didn’t copy correctly (' + f + ').');
      }
    }
  } catch (e) {
    removeBooks(to, made);
    if (created) { try { fs.rmdirSync(to); } catch { /* not empty */ } }
    throw e;
  }
  return items;
}
/** Remove the listed book items from a folder (after a move, or to undo a copy). Returns the ones that couldn't be.
 *  Anything that can't be removed (a file held open by antivirus, say) is renamed so it can't be taken for live books. */
function removeBooks(dir, items) {
  const left = [];
  const stamp = new Date().toISOString().slice(0, 10);
  for (const n of items) {
    const p = path.join(dir, n);
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* next */ }
    if (exists(p)) { try { fs.renameSync(p, p + '.moved-' + stamp); } catch { /* still there */ } }
    if (exists(p) || exists(p + '.moved-' + stamp)) left.push(n);
  }
  return left;
}

module.exports = { BOOK_ITEMS, hasBooks, folderWarnings, checkFolder, copyBooks, removeBooks, same };
