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
const COLLECTIONS = ['accounts', 'contacts', 'employees', 'rules', 'docs', 'entries', 'bankTxns', 'recons', 'filings', 'payruns'];

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
      contactUsed: this.db.prepare(`SELECT 1 FROM records WHERE collection IN ('docs','entries')
                                    AND json_extract(data, '$.contactId') = ? LIMIT 1`),
      bankTxnsForEntry: this.db.prepare(`SELECT id, data FROM records WHERE collection = 'bankTxns'
                                    AND json_extract(data, '$.entryId') = ?`),
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
