'use strict';
// The French translation layer: lookups with numbers, dates and names, and every pattern compiles.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load(lang) {
  const ctx = { navigator: { language: lang }, localStorage: { getItem: () => null, setItem() {} }, document: { addEventListener() {}, documentElement: {} },
    location: {}, MutationObserver: class { observe() {} }, Document: class {}, NodeFilter: {}, console };
  vm.createContext(ctx);
  const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext(pub('i18n.js') + ';' + pub('fr.js') + ';this.tr=tr;this.I18N=I18N;', ctx);
  return ctx;
}

test('French lookups keep numbers, dates and names', () => {
  const { tr, I18N } = load('fr-CA');
  assert.equal(I18N.lang, 'fr');
  assert.ok(Object.keys(I18N.dict).length > 1000);
  assert.equal(tr('Profit and loss'), 'État des résultats');
  assert.equal(tr('12 transactions'), '12 opérations');
  assert.equal(tr('Due 18 sept. 2026'), 'Échéance le 18 sept. 2026');
  assert.equal(tr('Reconcile Chequing'), 'Rapprocher Chequing');
  assert.equal(tr('HST 13%'), 'TVH 13 %');
  assert.equal(tr('Quebec · GST/QST 14.975%'), 'Québec · TPS/TVQ 14,975 %');
  assert.equal(tr('Cityview · #R-0926 · $2,034.00 due'), 'Cityview · no R-0926 · $2,034.00 à payer');
  assert.equal(tr('Pay period Sep 5, 2026 – Sep 18, 2026 · Every 2 weeks · paid from Chequing'),
    'Période de paie du Sep 5, 2026 au Sep 18, 2026 · Aux deux semaines · payée à partir de Chequing');
  assert.equal(tr('Maple Street Dental'), null, 'names are left alone');
});

test('English stays English', () => {
  const { tr, I18N } = load('en-CA');
  assert.equal(I18N.lang, 'en');
  assert.equal(tr('Profit and loss'), null);
});

test('every French entry keeps the placeholders its English has', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'fr.js'), 'utf8');
  const pairs = [...src.matchAll(/'((?:[^'\\]|\\.)*)':'((?:[^'\\]|\\.)*)'/g)];
  assert.ok(pairs.length > 1000);
  for (const [, en, fr] of pairs) {
    for (const ph of en.match(/\{s\d?\}/g) || []) assert.ok(fr.includes(ph), `${ph} missing in French for: ${en}`);
  }
});
