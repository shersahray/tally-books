# Accounting audit fixes — October 23, 2026

This change corrects the reproduced high-priority calculation errors and adds regression coverage. It does not rewrite existing ledger entries or deploy the application.

## Behavior

- Foreign-currency revaluations use a signed debit convention for assets and liabilities. A US$100 payable recorded at CAD 1.30 and revalued at 1.40 now produces Dr FX loss $10 / Cr A/P $10. Repeating a date uses only the remaining adjustment, including existing reversals and settled or deleted documents. Revaluation batches carry an expected company revision; a stale/concurrent calculation is rejected atomically. Every requested currency needs a valid rate before posting.
- Line-based invoices, bills and credits must reconcile their subtotal, tax parts and total. Payments and refunds must match their A/R or A/P control amount, actual cash amount and any foreign bank units. A document with a linked posting must have one matching dated control posting, and amount changes must save both atomically. Opening-balance imports retain their deliberate zero-net control postings; normal record writes cannot create new carried-opening flags. Foreign refund forms now collect the actual CAD cash amount or foreign bank rate and post the realized FX difference.
- CCA terminal losses use UCC remaining before ordinary CCA, and pool closure carries into later-year views. Future additions do not suppress a prior-year terminal loss. Class 10.1 is prominently marked **manual review required** in the worksheet and CSV; the current aggregate opening-UCC model cannot safely represent its separate-vehicle pools and special rules. It is excluded from automatic totals, rather than shown with an incorrect terminal loss or a zero claim.
- Inventory purchase cost includes nonrecoverable PST/RST from the document's saved tax snapshot, with the same allocation used by the purchase posting. Average cost and new COGS calculations inherit that cost; vendor returns reverse it.
- Calendar dates must round-trip exactly; February 31 and non-leap-year February 29 are rejected. Overview uses the injected test clock consistently.

## Validation

`test/accounting-audit.test.js` exercises the actual browser calculation functions plus the actual server in a disposable local company. It covers FX gains/losses for receivables, payables, credits, foreign credit cards and refunds; same-date corrections and reversals; concurrent posting; terminal losses and later-year carryforward; non-January fiscal years; the Class 10.1 worksheet/CSV warning; PST allocation, discounts, tax-exempt lines and FX; invalid dates; rejected document/payment mismatches and valid partial/foreign settlements.

The delayed-charge test now updates an invoice and its posting together, as the normal form does. It also verifies that a rejected inconsistent edit rolls back its delayed-credit links. Existing conversion tests verify that QuickBooks opening trial balances are not double counted.

Run `npm test` (Node.js 22.13 or newer). The change uses no new dependencies.

## Existing books and remaining audit work

- No historical sale costs, journal entries or tax filings are automatically changed. Previously posted FX revaluations, inventory sales and CCA worksheets may require a separate impact review and explicit correcting entries.
- Automatic recosting after backdated purchases or negative stock is still outstanding. Persisted sale costs are not recomputed by this change. Reconcile inventory valuation to the GL before relying on historical results affected by those cases.
- Manual journals to foreign bank accounts still require a separately defined foreign-unit policy; the audit's CAD-only manual-journal edge case is not changed here.
- These checks are arithmetic and posting-consistency safeguards, not an independent certification of all tax rates or transaction classifications. Standalone subledger records used by existing import/legacy interfaces remain supported; this change does not introduce an all-record migration.
- Payroll date coverage, PDOC/WebRAS comparisons, agency XML validation and the intentional coming-soon feature flags are unchanged.

CRA reference for the CCA treatment and Class 10.1 qualification: [UCC after additions and dispositions](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/completing-form-t2125/column-5-undepreciated-capital-cost-after-additions-dispositions.html), reviewed October 23, 2026.
