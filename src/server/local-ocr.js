'use strict';
// Optional local OCR for Sumlora Scan. Never sends files to another service.
// Install Tesseract and Poppler on the server to enable this. Missing binaries fail open
// to the existing Claude vision reader, and no original document is written to disk.
const { spawn } = require('node:child_process');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_OUTPUT = 128 * 1024;
const TIMEOUT_MS = 12000;

function run(binary, args, input, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const done = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(new Error('Local OCR timed out'));
    }, timeout);
    child.on('error', error => done(error));
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > MAX_OUTPUT) {
        child.kill('SIGKILL');
        done(new Error('OCR output exceeds limit'));
      } else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1024); });
    child.on('close', code => code === 0 ? done(null, stdout) : done(new Error(stderr || 'OCR process failed')));
    child.stdin.on('error', () => {}); // A missing binary closes stdin before writing.
    child.stdin.end(input);
  });
}

function clean(text) {
  return String(text || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim().slice(0, 16000);
}

/** Return optional recognized text. Neither raw images nor text are persisted. */
async function recognize(file, options = {}) {
  if (process.env.SUMLORA_LOCAL_OCR === '0') return { text: '', engine: 'disabled' };
  const type = String(file.mediaType || '');
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].includes(type)) return { text: '', engine: 'unsupported' };
  const data = Buffer.from(String(file.data || ''), 'base64');
  if (!data.length || data.length > MAX_FILE) return { text: '', engine: 'invalid' };
  const language = options.language === 'fra' ? 'fra+eng' : 'eng+fra';
  try {
    if (type === 'application/pdf') {
      // Fast path for digital PDFs; fallback to OCR on the first scanned page.
      let pdfText = '';
      try { pdfText = clean((await run('pdftotext', ['-f', '1', '-l', '3', '-layout', '-', '-'], data)).toString('utf8')); } catch { /* scanned PDF or no text tool */ }
      if (pdfText.length >= 30) return { text: pdfText, engine: 'pdftotext' };
      const png = await run('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '1800', '-png', '-', '-'], data);
      const recognized = clean((await run('tesseract', ['stdin', 'stdout', '-l', language], png)).toString('utf8'));
      return { text: recognized, engine: 'tesseract' };
    }
    const recognized = clean((await run('tesseract', ['stdin', 'stdout', '-l', language], data)).toString('utf8'));
    return { text: recognized, engine: 'tesseract' };
  } catch {
    // The AI vision reader is the safe fallback on unsupported formats,
    // missing executables, missing language data or OCR failure.
    return { text: '', engine: 'unavailable' };
  }
}

module.exports = { recognize };
