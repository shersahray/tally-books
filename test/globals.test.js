'use strict';
// The browser scripts share one global scope, so two files declaring the same top-level name means the
// later one silently replaces the earlier (that once made "Add account" open "Your account").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('no two browser scripts declare the same top-level name', () => {
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const seen = new Map(), clashes = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(pub, f), 'utf8');
    for (const m of src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)|^(?:const|let|var|class) ([A-Za-z0-9_$]+)/gm)) {
      const name = m[1] || m[2];
      if (seen.has(name) && seen.get(name) !== f) clashes.push(`${name}: ${seen.get(name)} and ${f}`);
      else seen.set(name, f);
    }
  }
  assert.deepEqual(clashes, []);
});
