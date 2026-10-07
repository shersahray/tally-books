'use strict';
// The list of companies (clients). Each company's books live in their own SQLite file;
// this registry records which files exist and their display names.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./db');

const LEGACY_FILE = 'tally-books.db'; // single-company file from version 1

class Registry {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'companies.json');
    fs.mkdirSync(path.join(dataDir, 'companies'), { recursive: true });
    this.data = { version: 1, companies: [] };
    if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.stores = new Map();
    this.adoptLegacy();
  }

  /** Books created before multi-company support become the first company. */
  adoptLegacy() {
    const legacy = path.join(this.dir, LEGACY_FILE);
    if (!fs.existsSync(legacy) || this.data.companies.some(c => c.file === LEGACY_FILE)) return;
    const store = new Store(legacy);
    const name = (store.getSetting('company') || {}).name || 'My Business';
    store.close();
    this.data.companies.push({ id: newId(), name, file: LEGACY_FILE, archived: false, created: Date.now() });
    this.save();
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(firmId) { return this.data.companies.filter(c => firmId === undefined || c.firmId === firmId); }
  /** Companies from before firms existed belong to the first firm. */
  adoptFirm(firmId) {
    if (!firmId || this.data.companies.every(c => c.firmId)) return;
    for (const c of this.data.companies) if (!c.firmId) c.firmId = firmId;
    this.save();
  }
  get(id) { return this.data.companies.find(c => c.id === id) || null; }

  /** Open (and cache) a company's database. */
  store(id) {
    const c = this.get(id);
    if (!c) return null;
    if (!this.stores.has(id)) this.stores.set(id, new Store(path.join(this.dir, c.file)));
    return this.stores.get(id);
  }

  create(name, firmId) {
    const id = newId();
    const entry = { id, firmId: firmId || '', name, file: path.join('companies', id + '.db'), archived: false, created: Date.now() };
    this.data.companies.push(entry);
    this.save();
    return entry;
  }

  update(id, patch) {
    const c = this.get(id);
    if (!c) return null;
    if (patch.name !== undefined) c.name = String(patch.name).slice(0, 120);
    if (patch.archived !== undefined) c.archived = !!patch.archived;
    if (patch.lastOpened !== undefined) c.lastOpened = patch.lastOpened;
    if (patch.payer !== undefined) c.payer = patch.payer === 'client' ? 'client' : 'firm';   // who pays for Sumlora for this company
    if (patch.billing !== undefined) c.billing = patch.billing;
    if (patch.assistant !== undefined) c.assistant = !!patch.assistant;                      // the AI assistant add-on (paid for separately)
    if (patch.clientPlan !== undefined) c.clientPlan = patch.clientPlan;                  // the plan the client pays for                               // the client's subscription, when the client pays
    this.save();
    return c;
  }

  /** Take a company off the list. Its database file is moved to removed-companies/, not deleted, so it can be recovered. */
  remove(id) {
    const c = this.get(id);
    if (!c) return;
    const s = this.stores.get(id);
    if (s) { s.close(); this.stores.delete(id); }
    const src = path.join(this.dir, c.file);
    if (fs.existsSync(src)) {
      const dest = path.join(this.dir, 'removed-companies');
      fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
      fs.renameSync(src, path.join(dest, `${id}-${Date.now()}.db`));
      for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.rmSync(src + ext, { force: true });
    }
    this.data.companies = this.data.companies.filter(x => x.id !== id);
    this.save();
  }

  closeAll() {
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
  }
}

const newId = () => 'co_' + crypto.randomBytes(6).toString('hex');

module.exports = { Registry };
