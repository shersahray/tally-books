# Optional local OCR for Sumlora Scan

Sumlora already reads uploaded receipts with Claude vision. This addition performs **local OCR** before sending the document through the same existing draft/approval process. It does not automatically post transactions.

## Installation (Azure Linux VM)

Install these system packages on the **server**, not the Cloudflare website:

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra poppler-utils
```

Restart the Sumlora server after updating its application code. No new npm packages or paid OCR account are required.

- JPEG/PNG images: Tesseract extracts text.
- PDFs with embedded text: `pdftotext` extracts up to three pages.
- Scanned PDFs: `pdftoppm` renders the first page for Tesseract.
- Missing system binaries, timeouts and OCR errors: extraction falls back to the existing Claude vision reader.
- `SUMLORA_LOCAL_OCR=0` disables the OCR first pass.
- Uploaded source bytes are streamed to local subprocesses rather than stored as temporary OCR files.
- The recognized text is passed to Claude alongside the original image/PDF, and the result remains a **draft requiring approval**.

## Verification

Run `npm test` and test a few synthetic French and English receipts. Validate supplier, invoice number, GST/HST/QST, totals and expense accounts by comparing the proposed draft to the original image.

**Limitations:** This is an optional local OCR first pass, not a replacement for Claude extraction or tax validation. OCR quality depends on the source and installed language data; GIF/WebP may fail on some Tesseract installations and fall back. For PDFs with no embedded text, only page one is OCR-scanned. It does not prove the live `scan.sumlora.ca` deployment uses this repository: verify the scanner's backend integration separately before promoting to production.
