'use strict';
// The zip writer and reader behind the year-end package (public/yearend.js), run outside the browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const zlib = require('node:zlib');

const ctx = vm.createContext({ TextEncoder, TextDecoder, DataView, Uint8Array, Uint32Array, ArrayBuffer, Blob, Response, DecompressionStream, Promise, Math, String, Date, Error });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/yearend.js'), 'utf8'), ctx);

test('makeZip writes a zip that readZip (and the zip format) reads back', async () => {
  const files = [{ name: '0 Read me.txt', data: 'Bonjour, année 2026' }, { name: '6 Receipts and attachments/2026-07-27 Rogers.png', data: new Uint8Array([1, 2, 3, 250]) }];
  const blob = ctx.makeZip(files);
  const buf = await blob.arrayBuffer();
  const back = await ctx.readZip(buf);
  assert.deepEqual([...back].map(f => String(f.name)), files.map(f => f.name));
  assert.equal(new TextDecoder().decode(back[0].data), 'Bonjour, année 2026');
  assert.deepEqual([...back[1].data], [1, 2, 3, 250]);
  // CRC of "123456789" is the standard check value.
  assert.equal(ctx.zipCrc(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('readZip also reads deflated entries (zips made by other tools)', async () => {
  const text = 'x'.repeat(1000), raw = zlib.deflateRawSync(Buffer.from(text));
  // One deflated entry, built by hand.
  const name = Buffer.from('a.txt'), crc = ctx.zipCrc(new TextEncoder().encode(text));
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(raw.length, 20); cd.writeUInt32LE(text.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const local = Buffer.concat([lh, name, raw]), central = Buffer.concat([cd, name]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  const zip = Buffer.concat([local, central, end]);
  const back = await ctx.readZip(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length));
  assert.equal(new TextDecoder().decode(back[0].data), text);
  await assert.rejects(ctx.readZip(new ArrayBuffer(40)), /isn’t a zip/);
});
