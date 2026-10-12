'use strict';
// Payroll is hidden for now: no plan, add-on or price includes it, and nothing can turn it on.
// Checked in a fresh Node without SUMLORA_PAYROLL (the rest of the tests run with it on).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const probe = `
  const P = require(${JSON.stringify(path.join(__dirname, '..', 'public', 'plans.js'))});
  console.log(JSON.stringify({
    soon: P.comingSoon('payroll'),
    inThrive: P.PLANS.thrive.features.includes('payroll'),
    viaAddon: P.hasFeature('seed', 'payroll', { payroll: true }),
    onThrive: P.featureOn('thrive', {}, 'payroll', { payroll: true }),
    addons: Object.keys(P.ADDONS), units: Object.keys(P.UNITS),
    blurb: P.PLANS.thrive.blurb, label: P.FEATURES.payroll.label, flagged: P.FEATURES.payroll.comingSoon,
    other: P.featureOn('thrive', {}, 'inventory', {}),
  }));`;

test('payroll is coming soon: out of every plan, add-on and price', () => {
  const env = { ...process.env }; delete env.SUMLORA_PAYROLL;
  const r = JSON.parse(execFileSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' }));
  assert.strictEqual(r.soon, true);
  assert.strictEqual(r.flagged, true);
  assert.strictEqual(r.inThrive, false);
  assert.strictEqual(r.viaAddon, false);
  assert.strictEqual(r.onThrive, false);
  assert.deepStrictEqual(r.addons.sort(), ['assistant', 'scrapyard']);
  assert.deepStrictEqual(r.units, []);
  assert.ok(!/payroll/i.test(r.blurb));
  assert.strictEqual(r.label, 'Payroll');
  assert.strictEqual(r.other, true);
});
