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
