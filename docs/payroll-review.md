# Payroll review — October 2026

## What is verified against CRA

`test/payroll-cra.test.js` checks the calculator against CRA's own published numbers:

- **Rates** — every federal and provincial bracket, rate, constant and basic personal amount matches
  T4127 (123rd edition, July 1, 2026), Tables 8.1 and 8.2.
- **T4032-ON worked example 1** (weekly $1,300 with $80 RRSP) — CPP, EI, annual taxable income,
  federal tax and Ontario tax (including the health premium) match to the cent.
- **T4032-ON worked example 2** (weekly $1,600 after the CPP and EI maximums, with CPP2) — matches to the
  cent after the fix below.
- **CPP/CPP2 schedule example** (biweekly $3,500 for a year) — CPP stops in pay 22, CPP2 starts on
  $2,400 that pay, and the year ends exactly at $4,230.45 CPP, $416 CPP2 and $1,123.07 EI.
- **Tax table rows** below the YMPE, claim codes 0 and 1, federal and Ontario.

Above the YMPE (about $2,869 biweekly) CRA's printed tables assume a full year of CPP2, so they differ from
the per-pay formula by up to about $1 a pay. Sumlora follows the T4127 formula, as PDOC and CRA's worked
example 2 do.

## Fixed in this review

1. **Over-withholding after the CPP or EI maximum.** Once an employee reached the yearly maximum, the CPP
   and EI tax credits dropped to zero for the rest of the year, so federal and Ontario tax was too high
   (about $17 a week for the worked example 2 employee). The credits now use the annual maximum, as CRA does.
2. **Saving an employee wiped last year's opening YTD.** Editing an employee after January 1 (for
   example to fix a SIN for the T4) erased the earlier year's opening amounts, so that year's T4 lost them.
3. **Pay stub YTD "Total deductions"** was gross minus net, which was wrong whenever opening YTD amounts
   existed. Opening RRSP and union dues are now included too.
4. **Pay dates without rates.** For a pay date with no rates loaded (any 2027 date, today), the screen kept
   amounts worked out for another date, or left them blank, and the run could be posted with no CPP, EI or
   tax. The amounts are now cleared and posting asks for confirmation.

## Before January 1, 2027 (must do)

- Add the **2027 rate table** (T4127 124th edition, usually out in November/December) and
  `YEAR_LIMITS[2027]`. Known already: the CPP base rate drops to 4.75% (total CPP 5.75%), and BC brackets
  are frozen at 2026 levels.
- Add the January–June 2026 table if pay runs before July 2026 ever need recalculating.

## Still open (from the code review)

Medium:
- No **void / reversing entry** for a posted pay run; deleting one doesn't recompute later runs' CPP/EI.
- **ROE** includes pay from before an earlier ROE for the same employee.
- No **T4 XML** or **ROE Web XML** files — slips must be typed into CRA's web forms.
- Ontario **overtime** (1.5× after 44 hours a week) isn't calculated.
- **Vacation pay** isn't earned on non-discretionary bonuses; Ontario **holiday pay** leaves out vacation pay
  on the current run.
- No Ontario **EHT** or **WSIB**.

Low:
- Client-role users can post and delete pay runs and see full SINs — confirm that's intended.
- The flat bonus rate for very low incomes is 15% (10% in Quebec) — confirm with PDOC that it's still 15%
  now that the lowest federal rate is 14%.

## Checking with PDOC before going live

Run 20–30 real employee scenarios through CRA's Payroll Deductions Online Calculator and compare: different
pay frequencies, TD1 amounts, a bonus, someone reaching the CPP and EI maximums mid-year, and someone above
the YAMPE. Add each one to `test/payroll-cra.test.js` as you go.

## Direct deposit (added October 2026)

Employees can be set to **direct deposit** with their institution, transit and account numbers. A posted pay run
then has a **Direct deposit file** button that makes a Payments Canada Standard 005 (CPA-005, 1464-byte) file of
payroll deposits (transaction code 200). The employer uploads it to their own business banking; Sumlora never
moves money. Setup (originator ID, destination data centre, names, the employer's account and the next file
number) is in Settings → Payroll, from the employer's bank.

- Each file gets a new file creation number, saved before the file is downloaded, so a number is never reused.
  Making a second file for the same pay run asks first, because uploading both would pay employees twice.
- Bank account numbers are masked (last 3 digits) in the activity log, and for clients and view-only users.
- **Before the first real payroll with a bank:** send the bank a test file. Banks add their own rules on top of the
  standard (data centre code, segments per record, line endings), so confirm with each bank a client uses.

## Remittance schedules and emailed pay stubs (added October 2026)

**Remitting frequencies.** Settings → Payroll has one setting for CRA and one for Revenu Québec (blank = the same as
CRA). Periods and due dates are in `payroll-calc.js` (`remitPeriodFor`, `remitDueFor`), checked in `test/remit-stubs.test.js`:

| Frequency | Period key | Periods | Due |
|---|---|---|---|
| Monthly (regular) | `2026-10` | calendar month | 15th of the next month |
| Quarterly | `2026-Q4` | calendar quarter | 15th after the quarter |
| CRA threshold 1 / RQ twice a month | `2026-10-H1`, `-H2` | 1st–15th, 16th–end | 25th; 10th of the next month |
| CRA threshold 2 / RQ weekly | `2026-10-W1`…`-W4` | 1st–7th, 8th–14th, 15th–21st, 22nd–end | 3rd working day after the period ends |
| Yearly (Revenu Québec only) | `2026` | calendar year | January 15 |

Sources: CRA "When to remit" (canada.ca/cra-remit-due-date) and Revenu Québec "Frequency of remittances" and
"Remittance schedules", checked October 12, 2026.

- **Weekends and holidays.** A due date on a Saturday, Sunday or holiday moves to the next business day, and threshold 2's
  "working days" skip them. CRA: its list of public holidays for due dates (canada.ca/cra-public-holidays): New Year's,
  Good Friday, Easter Monday, Victoria Day, Saint-Jean-Baptiste (Quebec only), Canada Day, Civic Holiday (not Quebec),
  Labour Day, Truth and Reconciliation, Thanksgiving, Remembrance Day, Christmas and Boxing Day. The CRA province is the
  company's province. Revenu Québec: its office closing days (January 2, December 24 and 31 too; a holiday on a weekend is
  taken the next weekday) plus Remembrance Day. With these, Sumlora's dates match Revenu Québec's published 2026 schedule
  for every monthly, twice-monthly and weekly period (tested).
- **To confirm:** CRA's page lists Boxing Day 2026 on Saturday the 26th with no substitute day, so Sumlora does not move
  CRA due dates past Monday December 28. If CRA ever publishes substitute days, add them to `DUE_HOLIDAYS`. Revenu
  Québec's last-December period can be paid by January 15 without penalty (interest still runs from the due date); Sumlora
  shows the normal due date.
- **T4/RL-1 due date** now also skips a holiday, not just a weekend.
- **Changing frequency mid-year.** A payment keeps the period key it was recorded for. A pay date inside a period that
  already has a payment under another frequency stays in that period, so the payment still matches; later pay dates use
  the new frequency. Payments for periods with no pay runs still show, with their own due date. The cash flow forecast
  uses the same periods.
- The remittance guide gives the remitting period as the period's end date (YYYY-MM-DD) for accelerated remitters, and
  names the threshold 1 or 2 payee.

**Emailed pay stubs.** **Email pay stubs** on a posted pay run, or **Email stub** on one line. Each employee with an email
address gets a PDF of their stub (`paystub.js`, drawn with `pdf.js` from the same figures as the printed stub) in their
language: a new **Language for pay stubs** on the employee, defaulting to the company's. The subject and message can be set
per language in Settings → Payroll ({name}, {date}, {company}); blank uses Sumlora's wording.

- Sent one at a time through the company's mailbox (`POST /mail/send` with `what: 'paystub'`), so each counts toward the
  200-a-day limit; a failure doesn't stop the rest, reaching the limit does. A summary lists sent, skipped (no email)
  and failed.
- The server only sends a stub to the employee's own email address on file (no Cc), for a line in that pay run, and
  needs payroll view access and the payroll feature. It records `sent` (when, to whom, by whom) on the pay run line; the
  pay run shows "Emailed" with the date.
- Stubs never show the SIN. For direct deposit, only the last 3 digits of the account are shown. No password protection.
