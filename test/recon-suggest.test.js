'use strict';
// Reconciliation suggestions (public/recon-suggest.js): only ever a clear answer, never a guess.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RS = require('../public/recon-suggest.js');

const L = (id, effect) => ({ id, effect });

test('current ticks already agree', () => {
  const r = RS.suggest({ lines: [L('a', 100), L('b', -40)], ticked: ['a', 'b'], beginning: 1000, ending: 1060 });
  assert.equal(r.status, 'already');
});

test('everything together matches', () => {
  const r = RS.suggest({ lines: [L('a', 100), L('b', -40), L('c', 25.5)], ticked: [], beginning: 0, ending: 85.5 });
  assert.equal(r.status, 'all');
  assert.deepEqual(r.ids.sort(), ['a', 'b', 'c']);
});

test('keeps feed-matched ticks and adds the one set that closes the gap', () => {
  const r = RS.suggest({ lines: [L('a', 100), L('b', -40), L('c', 7), L('d', 13)], ticked: ['a'], beginning: 0, ending: 60 });
  assert.equal(r.status, 'keep');
  assert.deepEqual(r.ids.sort(), ['a', 'b']);
});

test('finds the single combination when nothing is ticked', () => {
  const r = RS.suggest({ lines: [L('a', 10.01), L('b', 20.02), L('c', 5.5), L('d', 99)], ticked: [], beginning: 0, ending: 25.52 });
  assert.equal(r.status, 'unique');
  assert.deepEqual(r.ids.sort(), ['b', 'c']);
});

test('adds to cents exactly, not floating point', () => {
  const r = RS.suggest({ lines: [L('a', 0.1), L('b', 0.2), L('c', 5)], ticked: [], beginning: 0, ending: 0.3 });
  assert.equal(r.status, 'unique');
  assert.deepEqual(r.ids.sort(), ['a', 'b']);
});

test('two combinations fit: nothing is suggested', () => {
  const r = RS.suggest({ lines: [L('a', 10), L('b', 10), L('c', 3)], ticked: [], beginning: 0, ending: 10 });
  assert.equal(r.status, 'multiple');
  assert.equal(r.ids, undefined);
});

test('no combination fits', () => {
  const r = RS.suggest({ lines: [L('a', 10), L('b', 20)], ticked: [], beginning: 0, ending: 17 });
  assert.equal(r.status, 'none');
});

test('too many lines to search', () => {
  const lines = Array.from({ length: 61 }, (_, i) => L('x' + i, i + 1));
  const r = RS.suggest({ lines, ticked: [], beginning: 0, ending: 17 });
  assert.equal(r.status, 'toolarge');
});

test('a card statement: charges add to the amount owed', () => {
  // effect is what the line does to the balance as the statement shows it
  const r = RS.suggest({ lines: [L('charge1', 80), L('charge2', 20), L('payment', -50)], ticked: [], beginning: 200, ending: 250 });
  assert.equal(r.status, 'all');
});

test('every status has a sentence', () => {
  for (const s of ['already', 'all', 'keep', 'unique', 'multiple', 'toolarge', 'none']) assert.ok(RS.message({ status: s }).length > 10);
});
