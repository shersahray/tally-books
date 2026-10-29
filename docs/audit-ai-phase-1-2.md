# Sumlora Audit AI — Phases 1 and 2 (foundation)

This branch introduces `src/server/audit-evidence.js`, an isolated, dependency-free evidence extraction and matching library. No production routes, UI, database migrations, feature flags, or ledger changes are enabled.

## Implemented
- Parse *text already extracted from a document* for invoice number, invoice date, vendor, total and GST/HST or QST (CAD cents).
- Rank invoice candidates by total, invoice number, vendor and date; explicitly mark ambiguous and unmatched evidence.
- SHA-256 fingerprint document text for traceability.
- Always return `reviewStatus: 'pending'`; **no financial posting, auto-signoff or approval**.
- Bounded inputs and basic validation; deterministic unit tests.

## Not yet implemented (release blockers)
1. Integrate a secure PDF text extractor and OCR for scanned PDFs/images, with upload validation, file size/page limits, malware controls and retention policy. Do not label parsed text as 'AI OCR'.
2. Integrate firm/company-specific permissions, server-side administrator paid-feature flag and tenant isolation *before exposing routes*.
3. Persist evidence files, metadata, versioned extraction results, confidence/exception status and immutable reviewer audit records with encryption and access checks.
4. Add secure upload, candidate matching, side-by-side evidence viewer, accountant approval/rejection UI, and exports.
5. Add flexible vendor formats, bilingual French/English invoices, GST/QST multiple lines, currencies, credits, totals/tax reconciliation and document provenance.
6. Test against synthetic invoices and tenant isolation/integration/security tests; evaluate hosted OCR/LLM costs and Canadian data-residency settings.

Run `node --test test/audit-evidence.test.js` with compatible Node.js. This is **not** production ready.

## Follow-up implementation in this PR
- `audit-pdf.js`: validates PDF header/EOF, type and 10 MiB size; uses `pdfinfo` for page count (25 maximum), `pdftotext` for embedded text, and optional local `pdftoppm` + `tesseract` OCR for low-text scans. Temporary files are deleted in `finally`. Requires these binaries installed; no cloud OCR, file upload HTTP endpoint, or malware scanning yet.
- `audit-access.js`: pure server-side default-deny entitlement policy. Only active platform owners can change the entitlement **through this module**. Consumers must supply verified company visibility, firm status, durable save, and immutable audit callback.
- `test/audit-intake-access.test.js`: validation, default-deny, tenant visibility and admin-only entitlement tests (committed; not executed in this session).

**Critical warning:** These are isolated building blocks, not deployed application capabilities. No HTTP upload route or admin UI is connected, and no entitlement changes can presently be made through the app. Integrate the guard in the authenticated router before exposing PDF data. Do not merge or deploy until malware handling, resource limits, sandboxing, persistence, and complete authorization are reviewed.

## Phase 3 code added (still a draft)
- `src/server/audit-service.js`: AES-256-GCM encryption of PDFs in each company's SQLite file, authentication-bound company access checks, evidence metadata list, matching suggestions and reviewer audit records.
- `src/server/app.js`: authenticated administrator-only overview and entitlement update routes; company-scoped evidence list/upload/download/match/review routes; uploads rejected before parsing when disabled.
- `public/audit-ai.html` and `public/audit-ai.js`: basic pilot screen at `/audit-ai.html` for company ID entry, PDF upload, document viewing, GL JSON matching and approvals; platform administrator entitlement controls on the same page. No navigation-menu link has been added.
- `test/audit-service.test.js`: ciphertext binding, denied cross-company access, and review audit tests.

## Installation prerequisites and current release blockers
1. Set a **random, secret** `AUDIT_AI_STORAGE_KEY` as 64 hexadecimal characters (32 bytes), only in the private server environment. Safeguard and back up this key: loss prevents decryption of evidence. This key is not set by the branch.
2. Install poppler-utils (`pdfinfo`, `pdftotext`, `pdftoppm`) and Tesseract (`tesseract` and English/French language data) on the application host. Current OCR implementation is synchronous per request and needs an isolated worker with CPU/memory/time quotas before production exposure.
3. Test the full branch locally: `npm test`; run manual authentic multi-firm tests for unauthorized user, disabled entitlement, uploading malformed/large PDFs, scanned invoices, and audit review persistence. The tests **have not been executed** in this session.
4. Add antivirus scanning and hard limits on PDF decompression/image processing; disable scripts/active PDF content, consider sandboxed worker/process and queue; establish per-firm quotas, retention, cleanup and key rotation. This implementation is a pilot scaffold and **not approved for production handling of real customer documents**.
5. Improve UX for embedded GL selection, side-by-side PDF preview, per-transaction decisions, permissioned reviewer roles, OCR review and invoice field corrections. Current viewer opens a PDF in a new tab, and the matching screen expects JSON transactions pasted manually.
6. Reconcile existing administrator entitlement flows and restore/import handling so feature flags cannot be forged through any other update path. This branch only adds a guarded admin endpoint and no billing integration.

Keep the paid feature disabled by default. Do not merge/deploy without independent security review.
