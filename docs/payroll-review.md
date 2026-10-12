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
- **Daily overtime** (BC, AB, MB, SK and the territories: after 8 hours a day) isn't calculated, only the weekly
  rule; the pay run says to check it. Overtime averaging agreements and banked time aren't supported.
- **Voiding** a pay run after later ones doesn't change those later runs: the next pay run catches up CPP and EI
  through year-to-date amounts, and their stubs keep the old figures.
- **T4 XML and ROE XML** haven't been through CRA's or Service Canada's own validation yet (see "Before relying on
  them" below).
- **WSIB due dates on a weekend** aren't moved (WSIB doesn't publish a rule); the **EHT annual return** keeps March 15
  even on a weekend (Ontario only states the next-business-day rule for instalments). Confirm both with the client's
  accountant or the agency if it matters (March 15, 2026 was a Sunday).
- **Paying WSIB and EHT** is recorded as an ordinary expense against the payable account: there's no "Record payment"
  that marks a WSIB period or EHT instalment as paid, so they stay listed with their due dates.

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

## Electronic filing files (added October 2026)

- **T4 XML** (Payroll → Year-end → *Download T4 XML*): the T619 electronic transmittal, a `<T4Slip>` for every slip on the
  screen and the `<T4Summary>`, for CRA's **Internet file transfer (XML)** in My Business Account, Represent a Client or with a
  web access code. Built from CRA's 2026 XML specifications ("T619, Electronic Transmittal" and "T4, Statement of Remuneration
  Paid"): UTF-8, elements in the published order, empty optional tags left out, amounts with two decimals, the payroll account
  number (BN + RP + 4 digits) on every slip and the summary, box 28 exemption codes, box 45, box 50/52 for an RPP, codes 30, 34
  and 40 under `OTH_INFO`, and summary totals added up from the slips in the file. Since the 2025 T619 there's no MM555555
  transmitter number: the file names the bn15 you sign in with, or a RepID when filing through Represent a Client. The
  transmitter (name, contact, phone, email) and the business address are asked for in the download window and kept in the
  payroll settings. The file is checked first (BN, SIN, dental code, RPP number, contact details, addresses) and problems are
  listed. The XML doesn't make the employees' copies.
- **ROE Web XML** (an employee's Record of employment → *Download ROE XML*, or Payroll → Employees → *Records of employment*
  to put several in one file): Service Canada's payroll extract, FileVersion W-2.0 (ROE Web user requirements, Appendix D). Blocks
  B3 (payroll reference: the employee's id), B5, B6, B8, B9 (name and address in parts), B10–B14, B15A (hours, rounded up),
  B15C (pay period 1 is the final one, back to the period with the first day worked, 0.00 for periods with no pay), B16 (reason
  code and contact), B17A (vacation pay on leaving, code 2), B17B, B17C (with Service Canada's code for the other money) and B18.
  B2 is left blank for a new ROE. Every ROE goes in as a draft (`Issue="D"`): check and submit it in ROE Web, then save the
  serial number on the employee. B15B is worked out by ROE Web.
- **Employee addresses in parts** (street, apartment, city, province, postal code, country) on the employee form, which both
  files need. For employees saved before, the parts are filled in from the old address text as a guess to check; the text is
  kept until the parts are changed and saved. The server checks the province and the postal code format.
- **Fixed: an ROE now counts only pay since the employee's previous ROE** (after its final pay period ending date, block 12).
  Before, `roeLines` used every pay run ever, so a second ROE (for example after a leave of absence) counted the earlier pay
  again. The first day worked defaults to the first pay after the last ROE.
- Tests: `test/payroll-xml.test.js` parses both files with a small pure-JS XML reader (well-formed), checks the T4 file against
  CRA's element order, required elements and value formats, checks the summary totals equal the sum of the slips, and checks the
  ROE blocks and the pay-since-the-last-ROE fix. CRA's XSD package and Service Canada's `PayrollExtractXmlV2.xsd` weren't
  downloadable from here, so the structure checks follow the published specification pages, not the XSD files.
- **Before relying on them:** submit the first T4 XML file through Internet file transfer and read CRA's validation result
  (CRA validates the schema and the data online and lists errors in the Return Error Report), and upload the first ROE file to
  ROE Web and check the drafts before submitting them. If CRA publishes a new schema for the 2026 tax year in January 2027,
  compare it with `public/payroll-xml.js`.

## Ontario rules and correcting pay runs (added October 2026)

- **Overtime (ESA):** hourly employees, and salaried employees marked "eligible for overtime", enter hours for
  each work week in the pay period (split evenly by default). Hours over the weekly threshold are paid at 1.5 times
  the regular rate (for salary: the pay per period over the usual hours). Thresholds by province are in
  `PR.OVERTIME` (ON 44, QC 40, NB 44, NS 48, PE 48, NL 40, BC/AB/MB/SK/territories weekly 40 or 44 plus a daily
  rule that's flagged, not calculated). A company can set its own threshold in Settings → Payroll. Overtime is
  pensionable, insurable and taxable like regular pay, earns vacation pay, and shows on the stub with its hours.
- **Vacation pay on bonuses:** a bonus has a "non-discretionary (earns vacation pay)" tick, unticked by default:
  only the employer knows whether a bonus was promised or tied to results, and over-paying vacation pay on a gift
  is harder to undo than adding it. Ticked, the bonus is in the vacation pay base (`PR.vacationBase`).
- **Fixed: Ontario holiday pay now counts the current pay's vacation pay** (`PR.holidayCurrentEarnings`): the
  vacation pay added to this pay (on regular, overtime, other pay and a non-discretionary bonus), or the vacation
  pay paid out of what was set aside.
- **EHT:** Payroll → Year-end shows total Ontario remuneration (T4 box 14 for Ontario employees, with taxable
  benefits and earlier payroll), the exemption ($1,000,000 for eligible employers, or the share in an associated
  group's agreement, none when the group's Ontario payroll is over $5,000,000), the rate from the tiered table
  (0.98% up to $200,000, then 1.101% … 1.829%, 1.95% over $400,000), monthly instalments (required when remuneration
  is over **$1,200,000** since 2021, not $600,000, which was the threshold before 2021; due the 15th of the next
  month, or the next business day when the 15th is a weekend or Ontario holiday, as Ontario's EHT page says) and the
  March 15 return. It can record monthly accrual entries (Dr Employer health tax, Cr Employer health
  tax payable). Checked against the Ontario Ministry of Finance EHT page, October 2026. The exemption is indexed
  again on January 1, 2029.
- **WSIB:** Settings → Payroll: account number, reporting frequency (monthly / quarterly / once a year, with WSIB's
  due dates: the last day of the next month, the month after the quarter, or April 30, shown as they are: WSIB's
  premium policy only says "due dates set by the WSIB" and nothing about weekends), maximum insurable earnings
  (blank = WSIB's 2026 maximum, $121,700) and rate groups with a rate per $100. Each employee gets a group (or
  "not covered"). Each pay run works out the premium (capped at the maximum for the year) and posts Dr Workers'
  compensation premiums (7155), Cr Workers' compensation payable (2335). Remittances shows the report by period and
  rate group. Other provinces enter their own board's rate and maximum. Paying the premium is recorded as an
  ordinary expense against the payable.
- **Void a pay run:** posts a reversing entry on the date chosen (today by default, never before the pay date or in
  a closed period) and marks the run void. A void run is left out of year-to-date amounts, remittances, vacation and
  holiday pay, WSIB, EHT, T4/RL-1 slips and the T4 XML, the ROE and ROE XML, the cash flow forecast's next pay
  (each schedule repeats its last live run), the next pay date suggested in Run payroll, the Payroll add-on's
  employees billed, workflow reminders about remittances, and its stubs can't be emailed (the server refuses too).
  `test/void-everywhere.test.js` checks each of these together. Later pay runs in the year that used it are listed; the next
  pay run's CPP and EI are worked out without it, so they resume if they stopped too early. The server checks the
  reversing entry undoes the original line for line, refuses changes to a void run, and refuses deleting a pay run
  unless it's the latest for its employees and its bank payment isn't reconciled (void it otherwise).

**Before relying on it:** check each client's WSIB rate per $100 against their premium rate notice, and update
`WSIB_MAX` and the EHT exemption each year.

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
  and the "Payroll remittance coming due" workflow reminder use the same periods and due dates (the reminder used to
  assume monthly or quarterly CRA remitting, and counted void pay runs).
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
- The emailed (PDF) and printed stubs carry the same rows: overtime with its hours and rate (regular hours are the
  hours less overtime), "Bonus (earns vacation pay)", and a Void note on a voided run. A void run's stubs can be
  printed but not emailed, and void runs are left out of remittances.
