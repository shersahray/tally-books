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
- **ROE** includes pay from before an earlier ROE for the same employee.
- No **T4 XML** or **ROE Web XML** files — slips must be typed into CRA's web forms.
- No emailed pay stubs.
- **Daily overtime** (BC, AB, MB, SK and the territories: after 8 hours a day) isn't calculated, only the weekly
  rule; the pay run says to check it. Overtime averaging agreements and banked time aren't supported.
- **Voiding** a pay run after later ones doesn't change those later runs: the next pay run catches up CPP and EI
  through year-to-date amounts, and their stubs keep the old figures.

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
  month) and the March 15 return. It can record monthly accrual entries (Dr Employer health tax, Cr Employer health
  tax payable). Checked against the Ontario Ministry of Finance EHT page, October 2026. The exemption is indexed
  again on January 1, 2029.
- **WSIB:** Settings → Payroll: account number, reporting frequency (monthly / quarterly / once a year, with WSIB's
  due dates: the last day of the next month, the month after the quarter, or April 30), maximum insurable earnings
  (blank = WSIB's 2026 maximum, $121,700) and rate groups with a rate per $100. Each employee gets a group (or
  "not covered"). Each pay run works out the premium (capped at the maximum for the year) and posts Dr Workers'
  compensation premiums (7155), Cr Workers' compensation payable (2335). Remittances shows the report by period and
  rate group. Other provinces enter their own board's rate and maximum. Paying the premium is recorded as an
  ordinary expense against the payable.
- **Void a pay run:** posts a reversing entry on the date chosen (today by default, never before the pay date or in
  a closed period) and marks the run void. A void run is left out of year-to-date amounts, remittances, vacation and
  holiday pay, WSIB, EHT, T4/RL-1 slips and the ROE. Later pay runs in the year that used it are listed; the next
  pay run's CPP and EI are worked out without it, so they resume if they stopped too early. The server checks the
  reversing entry undoes the original line for line, refuses changes to a void run, and refuses deleting a pay run
  unless it's the latest for its employees and its bank payment isn't reconciled (void it otherwise).

**Before relying on it:** check each client's WSIB rate per $100 against their premium rate notice, and update
`WSIB_MAX` and the EHT exemption each year.
