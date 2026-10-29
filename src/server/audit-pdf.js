'use strict';
// Offline PDF intake. No files are persisted; caller must enforce authorization
// BEFORE accepting bytes and must independently choose encrypted evidence storage.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 25;
function validatePdf(buffer, declaredType = 'application/pdf') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > MAX_PDF_BYTES)
    throw new TypeError('PDF must be between 8 bytes and 10 MiB');
  if (declaredType !== 'application/pdf') throw new TypeError('Only application/pdf is accepted');
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new TypeError('Invalid PDF signature');
  if (!buffer.subarray(Math.max(0, buffer.length - 2048)).includes(Buffer.from('%%EOF')))
    throw new TypeError('PDF terminator missing');
  return true;
}
async function command(name, args, timeout = 15000) {
  try {
    const result = await run(name, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true });
    return result.stdout;
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('PDF extraction tools not installed: ' + name);
    throw new Error('PDF extraction failed: ' + name);
  }
}
async function extractPdf(buffer, { ocr = true, language = 'eng' } = {}) {
  validatePdf(buffer);
  if (!['eng','fra','eng+fra'].includes(language)) throw new TypeError('Unsupported OCR language');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sumlora-audit-'));
  const input = path.join(dir,'evidence.pdf');
  try {
    await fs.chmod(dir, 0o700);
    await fs.writeFile(input, buffer, {mode:0o600,flag:'wx'});
    const info = await command('pdfinfo', [input]);
    const pages = Number(info.match(/^Pages:\s*(\d+)/m)?.[1]);
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES)
      throw new TypeError('PDF must contain 1 to 25 pages');
    let text = await command('pdftotext',['-layout','-nopgbrk',input,'-']);
    if (text.trim().length >= 40 || !ocr) return {text:text.slice(0,200000),pages,method:'pdf-text',ocrUsed:false};
    // OCR only when direct extraction does not yield meaningful text.
    // 100 DPI bounds resource use; process one page at a time.
    let scanned = '';
    for (let n=1;n<=pages;n++) {
      const prefix=path.join(dir,'page');
      await command('pdftoppm',['-f',String(n),'-l',String(n),'-r','100','-singlefile','-gray','-png',input,prefix],20000);
      const png=prefix+'.png';
      scanned += '\n' + await command('tesseract',[png,'stdout','-l',language],20000);
      await fs.unlink(png);
      if (scanned.length > 200000) break;
    }
    return {text:scanned.slice(0,200000),pages,method:'ocr',ocrUsed:true};
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
}
module.exports={validatePdf,extractPdf,MAX_PDF_BYTES,MAX_PAGES};
