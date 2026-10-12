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
- **ROE** includes pay from before an earlier ROE for the same employee.
- No **T4 XML** or **ROE Web XML** files — slips must be typed into CRA's web forms.
- Ontario **overtime** (1.5× after 44 hours a week) isn't calculated.
- **Vacation pay** isn't earned on non-discretionary bonuses; Ontario **holiday pay** leaves out vacation pay
  on the current run.
- No Ontario **EHT**, **WSIB**, **direct deposit (CPA-005 file)** or emailed pay stubs.

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
