'use strict';
// Automatic daily backups: every company's books are written as restorable backup files to a
// folder of the user's choice (OneDrive by default), one dated folder per day, oldest removed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COLLECTIONS } = require('./db');
const { DEFAULT_COMPANY } = require('./seed');

const BACKUP_DIR_NAME = 'Tally Books Backups';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = n => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Folders worth suggesting: OneDrive and Google Drive when present, then Documents. */
function suggestedFolders() {
  const home = os.homedir();
  const out = [];
  const add = (label, dir) => { if (dir && fs.existsSync(dir) && !out.some(o => o.path === dir)) out.push({ label, path: dir }); };
  add('OneDrive', process.env.OneDriveCommercial);
  add('OneDrive', process.env.OneDrive || process.env.OneDriveConsumer);
  add('OneDrive', path.join(home, 'OneDrive'));
  add('Google Drive', 'G:\\My Drive');
  add('Google Drive', path.join(home, 'Google Drive'));
  add('Google Drive', path.join(home, 'My Drive'));
  add('Dropbox', path.join(home, 'Dropbox'));
  add('Documents', path.join(home, 'Documents'));
  add('Home folder', home);
  return out;
}

class Backups {
  /**
   * @param {string} dataDir  where the app keeps its settings
   * @param {Registry} registry  the company list (gives access to each company's store)
   */
  constructor(dataDir, registry) {
    this.file = path.join(dataDir, 'backup-settings.json');
    this.reg = registry;
    this.settings = { enabled: true, folder: '', keepDays: 30, lastRun: 0, lastDay: '', lastError: '', lastCount: 0, lastPath: '' };
    try { Object.assign(this.settings, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    if (!this.settings.folder) {
      const s = suggestedFolders()[0];
      this.settings.folder = s ? s.path : dataDir;
      this.save();
    }
    this.timer = null;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Where backups actually go: a "Tally Books Backups" folder inside the chosen folder. */
  target() { return path.join(this.settings.folder, BACKUP_DIR_NAME); }

  status() {
    return { ...this.settings, target: this.target(), suggestions: suggestedFolders(), dueToday: this.settings.enabled && this.settings.lastDay !== localDay() };
  }

  update(patch) {
    if (patch.folder !== undefined) {
      const folder = path.resolve(String(patch.folder).trim().replace(/^"|"$/g, ''));
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        const err = new Error(`The folder ${folder} doesn’t exist. Choose a folder that’s already on this computer.`);
        err.status = 400; throw err;
      }
      if (folder !== this.settings.folder) { this.settings.folder = folder; this.settings.lastDay = ''; }
      this.settings.lastError = '';
    }
    if (patch.enabled !== undefined) this.settings.enabled = !!patch.enabled;
    if (patch.keepDays !== undefined) this.settings.keepDays = Math.max(1, Math.min(3650, parseInt(patch.keepDays, 10) || 30));
    this.save();
    // A new folder gets a backup straight away, so it's never empty.
    if (patch.folder !== undefined && this.settings.enabled && !this.settings.lastDay && this.reg.list().length) this.run();
    return this.status();
  }

  /** Write today's backup of every company, then remove dated folders past the keep period. */
  run() {
    const day = localDay();
    const dir = path.join(this.target(), day);
    try {
      fs.mkdirSync(dir, { recursive: true });
      let count = 0;
      const index = [];
      for (const c of this.reg.list()) {
        const store = this.reg.store(c.id);
        const company = { ...DEFAULT_COMPANY, ...(store.getSetting('company') || {}) };
        const body = { format: 'tally-books-backup', version: 1, exportedAt: new Date().toISOString(), companyId: c.id, company };
        for (const col of COLLECTIONS) body[col] = store.list(col);
        const safe = String(company.name || c.name || 'company').replace(/[^A-Za-z0-9 ._-]+/g, '').trim().slice(0, 60) || 'company';
        const name = `${safe} (${c.id}).json`;
        const tmp = path.join(dir, name + '.tmp');
        fs.writeFileSync(tmp, JSON.stringify(body));
        fs.renameSync(tmp, path.join(dir, name));
        index.push({ id: c.id, name: company.name, archived: !!c.archived, file: name });
        count++;
      }
      fs.writeFileSync(path.join(dir, 'companies.json'), JSON.stringify({ backedUpAt: new Date().toISOString(), companies: index }, null, 2));
      const removed = this.prune();
      Object.assign(this.settings, { lastRun: Date.now(), lastDay: day, lastError: '', lastCount: count, lastPath: dir });
      this.save();
      return { ok: true, count, path: dir, removed };
    } catch (e) {
      this.settings.lastError = `${e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EPERM' ? 'Couldn’t write to the backup folder' : 'Backup failed'}: ${e.message}`;
      this.save();
      return { ok: false, error: this.settings.lastError };
    }
  }

  /** Delete dated backup folders older than keepDays. Only touches YYYY-MM-DD folders we created. */
  prune() {
    const root = this.target();
    const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - (this.settings.keepDays - 1));
    const keepFrom = localDay(cutoff);
    let removed = 0;
    for (const name of fs.readdirSync(root)) {
      if (!DAY_RE.test(name) || name >= keepFrom) continue;
      const p = path.join(root, name);
      if (!fs.statSync(p).isDirectory()) continue;
      const files = fs.readdirSync(p);
      if (!files.every(f => f.endsWith('.json'))) continue; // someone put other files here: leave it alone
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  /** Check every hour; back up once per calendar day while the app is open. */
  start() {
    const tick = () => { if (this.settings.enabled && this.settings.lastDay !== localDay() && this.reg.list().length) this.run(); };
    setTimeout(tick, 60 * 1000).unref();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { Backups, suggestedFolders, localDay, BACKUP_DIR_NAME };
