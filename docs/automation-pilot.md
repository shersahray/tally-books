# Bookkeeping automation pilot

This implementation adds an owner approval inbox and unattended preparation for bank lines and receipt matches. It does not enable automation in any company when deployed.

## Use after deployment

1. Open the pilot company as its firm owner.
2. Settings → Bookkeeping automation → Open approval inbox.
3. Enable the inbox and save. Optionally enable background preparation (once a minute).
4. Optionally enable automatic bank AI suggestions. This requires existing firm permission, a configured AI key, an eligible plan and company AI suggestions already enabled. Receipt reading continues to use the existing receipt pipeline.
5. Select Prepare / refresh. Review each item, original receipt, match and proposed debits/credits.
6. Save category, contact or tax edits to update the preview. Approve and post, or reject with a reason.

## Posting boundary

Private `_automation` records in each company's existing SQLite records table are not in `COLLECTIONS`, `/state`, reports, trial balance or the generic record/batch write API. No schema migration or additional service is required. Only the explicit decision endpoint can turn a pending proposal into a posting. It uses the normal `applyWrite` and document-posting checks inside the same SQLite transaction as the decision and audit event. A validation failure rolls everything back.

The pilot is owner-only. Staff, clients and view-only accounts cannot make decisions. Normal company, firm, session, subscription, cross-origin and closing-date checks still apply. A version check plus a conservative snapshot of sources, accounts, settings and books blocks stale approval. Simultaneous approval attempts cannot post twice. Refresh after other changes; refresh can replace prior draft edits, so review the preview again. This pilot intentionally does not bulk approve.

## Preparation

- Bank suggestions use bank rules, then previous payee words/direction, then existing AI results.
- Existing entry or full-balance open invoice/bill matches take precedence over a new expense/deposit. Multiple candidates require resolution in Banking.
- A receipt is grouped only if its total/date identifies exactly one candidate bank line and that bank line has exactly one candidate receipt. Grouping is a suggestion, not proof of identity: the owner must verify payee and source.
- Category postings support CAD expense/deposit entries, GST/HST, separate GST/QST, and PST/RST paid as part of cost. Explicit GST-only codes for PST provinces are supported. Existing matching entries are cleared instead of duplicated. Invoice/bill payments retain the existing bill-payment approval controls.
- Receipt attachment and bank linking occur atomically with the posting.
- Background preparation runs on the existing server every minute and resumes after restart. It never posts and skips archived companies, suspended/unpaid firms and expired desktop licences.
- Automatic bank AI is a separate opt-in, uses the existing AI service and monthly spending limit, attempts at most 20 lines per run and 100 per company/day, and waits at least 30 minutes between attempts. Changed sources or revoked settings during a request cause its result to be discarded. Failures are visible in the last-run message; deterministic preparation continues. Existing receipt AI has its own limits.

## Explicit limits

Standalone receipts appear as flagged review items. Use the existing Receipts screen to choose whether an item is an unpaid bill, select its payment account, split its lines, or attach it to an existing entry. Ambiguous matches, transfers and foreign-currency entries need the existing Banking/Receipts workflow. This pilot does not add automatic reconciliation, month-end journals, unattended recurring transactions or tax submission.

Rejecting a draft does not delete/exclude its bank line or receipt. It remains available for manual resolution and is not silently requeued. A rejected standalone receipt is not later grouped automatically. Decision history remains in the private queue and ordinary company audit log. Drafts survive server restart, but the existing portable JSON/year-end/daily export format does not include this private queue or these private settings. After restoring/exporting to another company, regenerate drafts and review them again; do not rely on the queue as a portable approval archive.

## Validation

`npm test`: 478 passing tests, including 11 new automation integration cases covering off-by-default controls, owner-only access, private drafts, edits, tax postings, simultaneous approvals, stale inputs, rejected drafts, closed periods, held bills, existing-entry matching, receipt linking, ambiguous/foreign items, restart, background opt-in and AI race/attempt limits.

Syntax checks pass for changed JavaScript. A real browser smoke test could not run in the build environment: Chromium was unavailable and the browser download returned an invalid archive. Browser layout, mobile review, real Plaid/Anthropic credentials and Azure deployment still require pilot verification. Keep the pull request in draft until those checks are completed.
