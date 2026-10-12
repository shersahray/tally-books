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

High:
- **Accelerated remitters** (threshold 1 and 2) aren't supported — only monthly and quarterly.

Medium:
- No **void / reversing entry** for a posted pay run; deleting one doesn't recompute later runs' CPP/EI.
- Ontario **overtime** (1.5× after 44 hours a week) isn't calculated.
- **Vacation pay** isn't earned on non-discretionary bonuses; Ontario **holiday pay** leaves out vacation pay
  on the current run.
- No Ontario **EHT**, **WSIB** or emailed pay stubs.

Low:
- Remittance due dates on a weekend or holiday aren't moved to the next business day.
- One remittance frequency covers both CRA and Revenu Québec.
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
