'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recognize } = require('../src/server/local-ocr');

test('local OCR may be disabled without requiring system packages', async () => {
  const previous = process.env.SUMLORA_LOCAL_OCR;
  process.env.SUMLORA_LOCAL_OCR = '0';
  try {
    assert.deepEqual(await recognize({ mediaType: 'image/png', data: 'aGVsbG8=' }), { text: '', engine: 'disabled' });
  } finally {
    if (previous === undefined) delete process.env.SUMLORA_LOCAL_OCR;
    else process.env.SUMLORA_LOCAL_OCR = previous;
  }
});

test('local OCR rejects unsupported and empty uploads safely', async () => {
  const previous = process.env.SUMLORA_LOCAL_OCR;
  delete process.env.SUMLORA_LOCAL_OCR;
  try {
    assert.deepEqual(await recognize({ mediaType: 'text/plain', data: 'aGVsbG8=' }), { text: '', engine: 'unsupported' });
    assert.deepEqual(await recognize({ mediaType: 'image/png', data: '' }), { text: '', engine: 'invalid' });
  } finally {
    if (previous !== undefined) process.env.SUMLORA_LOCAL_OCR = previous;
  }
});
