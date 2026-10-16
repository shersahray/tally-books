'use strict';
/*
 * Year-end files started, for charging firms per file. One line per client company and year-end, written the first
 * time a file for that year-end is started and never removed: deleting the file and starting it again, reopening it or
 * bringing the trial balance in again doesn't add a second line or take the first one away. A file rolled forward to
 * the next year-end is a new line. Kept on the server (yearend-usage.json), outside the companies' own books, so it
 * survives a company being archived or removed.
 */
const fs = require('node:fs');
const path = require('node:path');

class YearEndUsage {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'yearend-usage.json');
    this.data = { files: {}, backfilled: false };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  static key(companyId, yearEnd) { return `${companyId}|${yearEnd}`; }
  /** Count a started file. Returns true when it's new (not counted before). */
  record(x, { save = true } = {}) {
    if (!x || !x.companyId || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.yearEnd || ''))) return false;
    const k = YearEndUsage.key(x.companyId, x.yearEnd);
    if (this.data.files[k]) return false;
    this.data.files[k] = { firmId: x.firmId || '', firmName: x.firmName || '', companyId: x.companyId, companyName: x.companyName || '', yearEnd: x.yearEnd,
      startedAt: +x.startedAt || Date.now(), by: x.by || '', fileId: x.fileId || '' };
    if (save) this.save();
    return true;
  }
  list() { return Object.values(this.data.files); }
}

module.exports = { YearEndUsage };
