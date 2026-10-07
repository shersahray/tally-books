'use strict';
// Storage layer: a single SQLite file holding JSON records per collection.
// Uses Node's built-in `node:sqlite` module, so there are no native dependencies to compile.

const fs = require('node:fs');
const path = require('node:path');

// Silence the one-time "SQLite is an experimental feature" warning on older Node 22 releases.
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (msg && msg.includes('SQLite is an experimental feature')) return;
  return origEmit.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = origEmit;

// Order matters for restore: later collections are validated against earlier ones.
const COLLECTIONS = ['accounts', 'contacts', 'items', 'employees', 'rules', 'recurring', 'docs', 'estimates', 'entries', 'bankTxns', 'recons', 'filings', 'payruns', 'receipts', 'attachments', 'questions'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Flattened journal lines, handy for ad-hoc SQL reporting.
CREATE VIEW IF NOT EXISTS journal_lines AS
  SELECT r.id                               AS entry_id,
         json_extract(r.data, '$.date')     AS date,
         json_extract(r.data, '$.type')     AS type,
         json_extract(r.data, '$.ref')      AS ref,
         json_extract(l.value, '$.account') AS account_id,
         json_extract(l.value, '$.debit')   AS debit,
         json_extract(l.value, '$.credit')  AS credit,
         json_extract(l.value, '$.memo')    AS memo
  FROM records r, json_each(r.data, '$.lines') l
  WHERE r.collection = 'entries';
CREATE INDEX IF NOT EXISTS records_by_collection ON records (collection);
-- Audit log: one row per change, with who made it and the record before and after.
CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  username   TEXT NOT NULL,
  name       TEXT NOT NULL,
  action     TEXT NOT NULL,
  collection TEXT NOT NULL DEFAULT '',
  record_id  TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  before     TEXT,
  after      TEXT
);
CREATE INDEX IF NOT EXISTS audit_by_time ON audit (at);
-- Receipt photos and PDFs. The receipt's details live in the 'receipts' collection.
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created    INTEGER NOT NULL
);
`;

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.stmt = {
      all: this.db.prepare('SELECT id, data FROM records WHERE collection = ?'),
      get: this.db.prepare('SELECT data FROM records WHERE collection = ? AND id = ?'),
      put: this.db.prepare(`INSERT INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
                            ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
      del: this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
      delAll: this.db.prepare('DELETE FROM records'),
      getSetting: this.db.prepare('SELECT value FROM settings WHERE key = ?'),
      putSetting: this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                                   ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      putMeta: this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                                ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
      accountUsed: this.db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1'),
      contactUsed: this.db.prepare(`SELECT 1 FROM records WHERE collection IN ('docs','entries','estimates','recurring')
                                    AND json_extract(data, '$.contactId') = ? LIMIT 1`),
      bankTxnsForEntry: this.db.prepare(`SELECT id, data FROM records WHERE collection = 'bankTxns'
                                    AND json_extract(data, '$.entryId') = ?`),
      addAudit: this.db.prepare(`INSERT INTO audit (at, username, name, action, collection, record_id, summary, before, after)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      putFile: this.db.prepare('INSERT INTO files (id, media_type, name, size, data, created) VALUES (?, ?, ?, ?, ?, ?)'),
      getFile: this.db.prepare('SELECT id, media_type, name, size, data, created FROM files WHERE id = ?'),
      hasFile: this.db.prepare('SELECT 1 FROM files WHERE id = ?'),
      delFile: this.db.prepare('DELETE FROM files WHERE id = ?'),
      fileList: this.db.prepare('SELECT id, media_type, size, created FROM files ORDER BY created'),
      paymentsFor: this.db.prepare(`SELECT 1 FROM records WHERE collection = 'entries'
                                    AND json_extract(data, '$.applyTo') = ? LIMIT 1`),
    };
  }

  list(collection) {
    return this.stmt.all.all(collection).map(r => ({ ...JSON.parse(r.data), id: r.id }));
  }
  get(collection, id) {
    const r = this.stmt.get.get(collection, id);
    return r ? { ...JSON.parse(r.data), id } : null;
  }
  put(collection, id, data) {
    const clean = { ...data };
    delete clean.id;
    this.stmt.put.run(collection, id, JSON.stringify(clean), Date.now());
  }
  delete(collection, id) {
    return this.stmt.del.run(collection, id).changes > 0;
  }
  getSetting(key) {
    const r = this.stmt.getSetting.get(key);
    return r ? JSON.parse(r.value) : null;
  }
  putSetting(key, value) {
    this.stmt.putSetting.run(key, JSON.stringify(value));
  }
  getMeta(key) {
    const r = this.stmt.getMeta.get(key);
    return r ? r.value : null;
  }
  putMeta(key, value) {
    this.stmt.putMeta.run(key, String(value));
  }
  accountUsed(id) { return !!this.stmt.accountUsed.get(id); }
  contactUsed(id) { return !!this.stmt.contactUsed.get(id); }
  hasPayments(docId) { return !!this.stmt.paymentsFor.get(docId); }
  bankTxnsForEntry(entryId) { return this.stmt.bankTxnsForEntry.all(entryId).map(r => ({ ...JSON.parse(r.data), id: r.id })); }
  clearAll() { this.stmt.delAll.run(); }
  putFile(id, { mediaType, name = '', data }) { this.stmt.putFile.run(id, mediaType, String(name).slice(0, 200), data.length, data, Date.now()); }
  getFile(id) { const r = this.stmt.getFile.get(id); return r ? { id: r.id, mediaType: r.media_type, name: r.name, size: r.size, data: Buffer.from(r.data), created: r.created } : null; }
  hasFile(id) { return !!this.stmt.hasFile.get(id); }
  deleteFile(id) { this.stmt.delFile.run(id); }
  fileList() { return this.stmt.fileList.all().map(r => ({ id: r.id, mediaType: r.media_type, size: r.size, created: r.created })); }

  /** Record a change in the audit log. `before`/`after` are the record's data (or null). */
  audit(user, action, { collection = '', id = '', summary = '', before = null, after = null } = {}) {
    this.stmt.addAudit.run(Date.now(), user ? user.username : 'system', user ? user.name : 'System', action, collection, id, summary,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
  }
  /** Audit rows, newest first. Filters: before (seq), from/to (ms), username, collection, recordId, limit. */
  auditList({ before, from, to, username, collection, recordId, limit = 200, full = false } = {}) {
    const where = [], args = [];
    if (before) { where.push('seq < ?'); args.push(Number(before)); }
    if (from) { where.push('at >= ?'); args.push(Number(from)); }
    if (to) { where.push('at <= ?'); args.push(Number(to)); }
    if (username) { where.push('username = ?'); args.push(String(username)); }
    if (collection) { where.push('collection = ?'); args.push(String(collection)); }
    if (recordId) { where.push('record_id = ?'); args.push(String(recordId)); }
    const cols = full ? '*' : 'seq, at, username, name, action, collection, record_id, summary';
    const sql = `SELECT ${cols} FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
    args.push(Math.max(1, Math.min(5000, Number(limit) || 200)));
    return this.db.prepare(sql).all(...args).map(r => ({ ...r, before: r.before ? JSON.parse(r.before) : undefined, after: r.after ? JSON.parse(r.after) : undefined }));
  }
  auditUsers() { return this.db.prepare('SELECT DISTINCT username, name FROM audit ORDER BY name').all(); }

  /** Run fn inside a transaction; roll back if it throws. */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() { this.db.close(); }
}

module.exports = { Store, COLLECTIONS };
