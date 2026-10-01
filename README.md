# Tally Books

Double-entry bookkeeping for small businesses. Send invoices, enter bills and expenses, keep a chart of accounts, and run the reports an accountant needs at year-end.

It runs two ways from the same code:

- **Web app:** a small server you run on your computer or a server, then open in any browser. Several people can use it at once, and changes show up live for everyone.
- **Desktop app:** an installable app for Windows, macOS and Linux. It keeps your books in a file on your own computer.

![Tally Books dashboard](docs/screenshot.png)

## Features

- **Multiple companies:** keep books for any number of clients. A client list shows each company's bank lines waiting for review, overdue invoices, receivables and when it was last reconciled. Switch between companies from the sidebar.
  - Each company is a separate database file, so books never mix, and a backup covers one client.
  - New companies get the right sales tax for their province or territory: 13% HST in Ontario, 14% in Nova Scotia, 15% in New Brunswick, Newfoundland and Labrador, and PEI, combined GST/QST in Quebec, and 5% GST elsewhere. You can also set the rate yourself.
  - You pick the fiscal year-end, and can copy the chart of accounts from another client.
  - Archive former clients to hide them without deleting anything.
- **Sales:** invoices with line items and sales tax, partial and full payments, and a status on every invoice (open, partial, overdue, paid).
- **Expenses:** vendor bills, bill payments, expenses paid by bank or credit card, and deposits.
- **Banking:** transfers between accounts, credit card payments, and a register for each account with a running balance.
- **Bank statement import:** import CSV, OFX, QFX or QBO files downloaded from online banking, including headerless CSVs like TD's and CIBC's. Lines already imported are skipped, so date ranges can overlap.
- **For review:** each imported line gets a suggestion before it's added:
  - a match with an existing transaction;
  - a payment for an open invoice or bill;
  - a category from a bank rule, or the category used last time for that payee.

  You can add lines one at a time or in bulk, exclude duplicates, and undo anything.
- **Bank rules:** "when the description contains ROGERS, suggest Telephone and internet, HST included."
- **Reconciliation:** enter the statement's ending balance and date, then tick transactions until the difference is zero. You can save and come back later, and undo the most recent reconciliation. Registers mark each line C (cleared) or R (reconciled).
- **Sales tax returns:** a worksheet for each filing period (monthly, quarterly or annual, following the fiscal year) with the figures to enter in the return.
  - **Tax codes:** every invoice, bill, expense and deposit line is **HST/GST**, **Zero-rated in Canada**, **Zero-rated export**, **Exempt** or **No tax**. A customer or vendor can have a default code; for example, a US customer set to Zero-rated export fills that code in automatically on their invoices.
  - **GST/HST (CRA):** lines 90 and 91 split sales into taxable sales in Canada and exempt supplies, zero-rated exports and other revenue, with a breakdown under line 91. Lines 101 to 113C and 114/115 follow. Tax collected, input tax credits, adjustments from journal entries, and instalments are calculated from the books, and you can open the transactions behind each figure. Rebates and self-assessed amounts (lines 111, 205 and 405) are typed in.
  - **QST (Revenu Québec):** Quebec companies track GST (5%) and QST (9.975%) in separate accounts and get their own QST worksheet, lines 203 to 213.
  - **Filing:** marking a return as filed saves its figures and can record the payment to the government, or the refund, which clears the tax account. Instalments can be recorded too.
  - **Filed periods:** changing a transaction in a filed period asks for confirmation first, and the worksheet shows when the books no longer match what was filed.
  - The app produces the figures; returns are still submitted on CRA My Business Account or with Revenu Québec.
- **Payroll (Canada, including Quebec):** pay employees and track what's owed to CRA and Revenu Québec.
  - **Employees:** province of employment, pay schedule (weekly, every 2 weeks, twice a month, monthly), salary or hourly rate, TD1 and TP-1015.3 claim amounts, extra tax, RRSP and union dues at source, CPP/QPP, EI and QPIP exemptions, and amounts paid earlier in the year outside Tally Books.
  - **Pay runs** calculate CPP, CPP2, EI and federal and provincial income tax for every province and territory, and QPP, QPP2, QPIP, Quebec EI and Quebec income tax for Quebec, using CRA's *Payroll Deductions Formulas* (T4127, 123rd edition, July 2026). Employer CPP/QPP, EI (1.4×), QPIP and the Quebec Health Services Fund are included. Yearly maximums are tracked from year-to-date amounts.
  - Every amount can be changed before posting. Changed amounts are marked "Edited" on the pay run.
  - Posting a pay run records one journal entry: wages and employer contributions as expenses, source deductions as liabilities to CRA and Revenu Québec, and net pay out of the bank. Payroll accounts (2300, 2310, 2320, 7110) are added the first time they're needed.
  - **Pay stubs** with this-pay and year-to-date amounts, printed one at a time or all together.
  - **Remittances:** what's owed to each agency per month (or quarter), the due date (the 15th of the following month), the figures for the PD7A voucher and for Revenu Québec, and payments that clear the liability.
  - **Year-end (T4 and RL-1):** a T4 for every employee (one per province they worked in), an RL-1 for Quebec employees, the T4 Summary and the RL-1 Summary, built from the year's pay runs, amounts paid earlier outside Tally Books, and recorded remittances. It covers boxes 14 to 56 (including CPP2/QPP2 in 16A/17A, RPP box 20 with registration number 50 and pension adjustment 52, exemptions in 28, and dental benefits in 45) and RL-1 boxes A to I. Yearly maximums for insurable and pensionable earnings are shared across an employee's slips in date order. The Health Services Fund rate is set from total payroll (all provinces, plus associated employers) and applied to Quebec payroll, and the labour standards contribution is worked out too. Checks flag a missing or invalid SIN, a missing dental code or pension adjustment, and deductions that don't match what CRA's year-end review expects. Export the figures to CSV or print worksheets.
  - Tally Books prepares the figures; you file them with CRA's T4 Web Forms and Revenu Québec's My Account for businesses. Revenu Québec accepts printed RL-1 slips only from certified software, so the printouts are worksheets, not slips.
  - Rates are loaded for pay dates from July 1 to December 31, 2026. Quebec income tax follows Revenu Québec's TP-1015.F method but hasn't been checked line by line against WebRAS yet, so compare a first pay run with WebRAS. Always check unusual cases against CRA's PDOC.
- **English and French:** every screen, form, message, report and pay stub is available in Canadian French, with Quebec terms (TPS/TVQ, RRQ, RQAP, AE, état des résultats, grand livre…) and French number and date formats (1 234,56 $ · 18 sept. 2026). Each person picks their language from the sidebar, the sign-in screen or Account, and it's saved with their account. New companies can keep their books in French, with a French chart of accounts. Names and other data you type stay exactly as entered.
- **Sign-in security:** nobody sees any data without signing in.
  - The first start asks you to create an **owner** account. On an online server this also needs the setup code chosen when the server was installed.
  - **Roles:** owners manage everything; **staff** work in the companies they're given; **clients** see only their own company. Staff and clients can be **view only**.
  - **Invitations:** new people get a one-time link (valid 7 days) to choose their own password. Owners can send a **password reset link** (valid 24 hours). Links are stored only as hashes.
  - **Two-step sign-in:** a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password), set up by scanning a QR code, with ten one-time recovery codes. Owners can require it for owners or everyone; online servers require it for everyone.
  - Passwords are stored only as scrypt hashes, never as the password itself.
  - Five wrong passwords or codes from one network address lock that account there for 15 minutes (50 from all addresses lock it everywhere). 20 failures from one address, or more than 3 sign-ins at once, block that address for 15 minutes.
  - The app **locks itself after inactivity** (30 minutes unless you change it), and every sign-in ends after 12 hours.
  - Sessions use HttpOnly, SameSite=Strict cookies (Secure over HTTPS). Pages are served with a strict Content Security Policy and, over HTTPS, HSTS.
  - **Sign-in activity:** every sign-in, failed attempt and account change is logged for owners.
- **Activity log:** every change to a company's books is recorded with who made it, when, and the record before and after. Filter by person or kind of record, open any change to see what was different, and export to CSV (Settings → Activity log).
- **Online server:** [deploy/azure](deploy/azure/README.md) puts Tally Books on a small Azure server in Toronto with HTTPS, nightly tested updates, automatic security patches, and off-site backups to Azure Storage in Canada.
- **Automatic backups:** every company is backed up once a day while the app is open. On a server, each day's backup is also copied to Azure Blob Storage. Backups go to OneDrive by default, or any folder you pick, such as Google Drive. Each day gets its own dated folder, and backups older than the keep period (30 days unless you change it) are removed. Each file restores through **Settings → Restore from backup**. Settings and the company list show backup status, with **Back up now**, **Change folder** and **Open backup folder**.
- **Journal entries:** manual entries with debit and credit lines. The server rejects any entry that doesn't balance.
- **Chart of accounts:** set up for a Canadian small business charging HST (13%). The tax name, rate and fiscal year start are all in Settings.
- **Reports:** profit and loss, balance sheet, trial balance, general ledger, A/R aging and A/P aging, for any date range. All of them export to CSV.
- **General ledger:** every posting in the period grouped by account, with opening balance, debits, credits, running balance and account totals. Show all accounts or pick one; click any line to open the transaction. Income and expense accounts open with their fiscal-year-to-date balance.
- **Year-end:** the trial balance closes prior years into retained earnings, so the CSV is ready to import into working-paper software such as CaseWare.
- **Backup and restore:** one JSON file holds everything. Use it to move books between computers.
- **Example data:** sample customers, transactions and bank lines for trying things out. They're marked "Example" and can be removed in one click.

## Run it as a web app

You need **[Node.js](https://nodejs.org) 22.13 or newer**. The web server has no other dependencies.

```bash
git clone https://github.com/<you>/tally-books.git
cd tally-books
npm start            # or: npm run start:demo  (loads example data on first run)
```

Then open <http://localhost:3000>.

**Shortcut:** instead of typing the command, double-click **Start Tally Books.bat** on Windows or **Start Tally Books.command** on a Mac. It starts the server and opens the app in your browser. Keep the window it opens running while you work, and close it to stop.

Your books are saved in the `data` folder:
- `companies.json` lists your companies;
- `companies/<id>.db` holds each company's books.

These are normal SQLite files, so you can back up the whole folder while the server is stopped, or use **Settings → Download backup** for one company at any time.

If you're upgrading from the single-company version, your existing `data/tally-books.db` becomes your first company automatically.

### Settings

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to allow other computers on your network |
| `DATA_DIR` | `./data` | Folder that holds the company list and each company's database |
| `APP_PASSWORD` | *(none)* | An extra shared password the browser asks for before the Tally Books sign-in screen. User accounts protect the data either way; this adds a second layer when the app is on a network. |
| `REQUIRE_2FA` | *(none)* | `owners` or `everyone`: the least two-step sign-in allowed. Online servers use `everyone`. |
| `SETUP_CODE` | *(none)* | If set, creating the first owner account needs this code, so a stranger can't claim a new server. |
| `TRUST_PROXY` | *(off)* | `1` when running behind an HTTPS proxy such as Caddy, so sign-in limits use the visitor's real address. |
| `BACKUP_FOLDER` | OneDrive, if found | Folder for the daily backups. |
| `BACKUP_BLOB_URL` | *(none)* | An Azure Blob Storage container URL with a SAS token. Each day's backup is also copied there. A write-only token (Create, Write) is safest, with an Azure lifecycle rule removing old days. If the token can also list and delete, Tally Books removes old days itself. |

To put it on the internet for clients, follow [deploy/azure/README.md](deploy/azure/README.md) rather than opening a port: it adds HTTPS, two-step sign-in and off-site backups.

For example, to share it on your office network:

```bash
HOST=0.0.0.0 APP_PASSWORD='choose-a-long-password' npm start
```

To put it on the internet, run it behind a reverse proxy that handles HTTPS, such as Caddy or nginx. Basic auth sends the password with every request, so don't expose it over plain HTTP.

## Run it as a desktop app

```bash
npm install          # downloads Electron and the installer builder
npm run desktop      # opens the app in a window
```

To build an installer for the computer you're on:

```bash
npm run dist         # output goes to dist/
```

The desktop app keeps its books in your user data folder. **File → Show data folder** in the app opens it.

### Automatic installers from GitHub

`.github/workflows/release.yml` builds the Windows `.exe`, the macOS `.dmg` and the Linux `.AppImage` on GitHub's computers. To run it, go to **Actions → Build desktop apps → Run workflow**. It also runs when you push a version tag such as `v1.0.0`. When the run finishes, download the installers from the **Artifacts** section at the bottom of the run's page.

### Signing the Windows installer (Azure Artifact Signing)

Without a signature, Windows warns "Windows protected your PC", and Smart App Control blocks the installer completely. Signing fixes both.

1. Set up [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart):
   - a signing account;
   - an approved identity validation;
   - a Public Trust certificate profile;
   - an app registration with the **Artifact Signing Certificate Profile Signer** role on the signing account.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions**.
   - **Secrets** tab, which stores values privately:
     - `AZURE_TENANT_ID`: the Directory (tenant) ID, from Microsoft Entra ID.
     - `AZURE_CLIENT_ID`: the Application (client) ID, from the app registration.
     - `AZURE_CLIENT_SECRET`: the client secret **Value**.
   - **Variables** tab:
     - `AZURE_SIGNING_ACCOUNT`: the Artifact Signing account name. This isn't the app registration's name.
     - `AZURE_CERT_PROFILE`: the certificate profile name.
     - `AZURE_SIGNING_ENDPOINT`: the endpoint for your account's region, for example `https://eus.codesigning.azure.net`.
     - `AZURE_PUBLISHER_NAME`: the name exactly as it appears on the certificate.
3. Run the workflow again. The log says "Signing the Windows installer as …", and a check step confirms the signature is valid.

The Mac and Linux builds stay unsigned. Signing the Mac version needs Apple's separate Developer Program.

## How it works

```
public/            Browser app (plain HTML, CSS and JavaScript, no build step)
  bankparse.js     Bank file parsers (CSV column detection, OFX/QFX/QBO)
  banking.js       Banking screens: import, review, rules, reconcile
  companies.js     Client list, company switcher, new company
  salestax.js      GST/HST and QST return worksheets, filing, payments
  payroll-calc.js  Payroll deductions (CPP/QPP, EI/QPIP, income tax) from CRA's T4127 formulas, and year-end slip figures
  payroll.js       Employees, pay runs, pay stubs, remittances
  payroll-yearend.js  T4 and RL-1 slips and summaries
  activity.js      Activity log screen
  auth.js          Sign-in, two-step codes, invitations, users and security
  qr.js            QR code generator for the two-step setup screen
  i18n.js          Language switch and on-screen translation; fr-CA number and date formats
  fr.js            French (Canada) translations
src/server/
  app.js           HTTP server: JSON API, static files, live updates
  db.js            SQLite storage (Node's built-in node:sqlite)
  companies.js     Company list; one database file per company
  backups.js       Daily automatic backups to a folder of your choice
  auth.js          User accounts, password hashing, sessions, lockout, roles
  validate.js      Bookkeeping rules enforced on every write
  seed.js          Default chart of accounts and example data
  index.js         Command-line entry point
electron/main.js   Desktop wrapper: starts the server privately and opens a window
deploy/azure/      Setup script and guide for an online server on Azure
test/              API tests (node --test)
```

Every transaction is saved as a journal entry, with debit and credit lines that must balance to the cent. Invoices and bills are documents, and each one also posts its own journal entry. The server checks:

- that debits equal credits and each line is one-sided;
- that every line uses an account that exists;
- that payments apply to an existing invoice or bill;
- that you can't delete an account, contact or invoice that other records still use.

Changes that touch several records at once, like saving an invoice together with its journal entry, run in one database transaction.

For your own SQL queries, the database also has a `journal_lines` view with one row per debit or credit line:

```sql
SELECT account_id, SUM(debit) - SUM(credit) AS balance
FROM journal_lines
WHERE date <= '2026-12-31'
GROUP BY account_id;
```

### API

Every route except `/api/health` and `/api/auth/*` requires a signed-in session. Without one it answers `401`, and a user with a temporary password gets `403` until they choose their own.

**Sign-in:** `GET /api/auth/me`, `POST /api/auth/setup` (first owner, only once), `POST /api/auth/login`, `POST /api/auth/logout` and `POST /api/auth/password`. Owners only: `GET`/`POST /api/users`, `PUT /api/users/:id` and `PUT /api/security` (`{ "idleMinutes" }`).

**Across companies:**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/companies` | Every company with a summary, plus the province tax presets |
| `POST` | `/api/companies` | `{ "name", "province", "fyStart", "copyFrom", "examples" }` creates a company |
| `PUT` | `/api/companies/:id` | `{ "archived": true \| false }` |
| `GET` | `/api/backups` | Backup settings and status |
| `PUT` | `/api/backups` | `{ "enabled", "folder", "keepDays" }` |
| `POST` | `/api/backups/run` | Back up every company now |
| `GET` | `/api/events` | Server-sent events: `{ company, rev }` when a company's books change, `{ companies: true }` when the list changes |

**Inside one company:** every path below is under `/api/c/:companyId`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/state` | Every account, contact, document, entry, bank line, rule, reconciliation and setting |
| `PUT` | `/records/:collection/:id` | Create or replace a record (`accounts`, `contacts`, `docs`, `entries`, `bankTxns`, `rules`, `recons`, `filings`) |
| `DELETE` | `/records/:collection/:id` | Delete a record |
| `POST` | `/batch` | `{ "writes": [{ "op": "set" \| "delete", "collection", "id", "data" }] }`, applied all or nothing |
| `PUT` | `/settings` | Company settings |
| `POST` | `/bank/import` | `{ "account", "rows": [{ "date", "amount", "desc", "fitid" }] }` adds statement lines to For review, skipping ones already imported |
| `GET` | `/backup` | Download a full backup of this company |
| `POST` | `/restore` | Replace this company's books with a backup |
| `POST` | `/examples` | Load example data |

## Online demo

**Live demo:** https://shersahray.github.io/tally-books/ (GitHub Pages, served from the `gh-pages` branch, which `.github/workflows/pages.yml` updates automatically)


`node scripts/build-demo.js` builds `dist/demo.html`, the whole app in one file. It runs in the browser with two example companies and needs no server. Changes aren't saved and downloads are turned off, so it's only for showing people how the app works.

## Development

```bash
npm test
```

The tests start a real server against a temporary database. They cover the bookkeeping rules, bank file parsing for several Canadian bank formats, statement import and duplicate detection, all-or-nothing batch writes, backup and restore, payroll deductions checked against CRA's published tables and worked examples, cross-site request blocking, password protection, keeping companies separate, and moving books over from the single-company version.

## Not built yet

Live bank feeds (statement import is covered above), the Quick Method of accounting for GST/HST, sending returns straight to CRA or Revenu Québec, emailing invoices or saving them as PDFs, filing T4 and RL-1 slips electronically (XML), records of employment (ROE), vacation and statutory holiday pay, multiple currencies, and emailing invitations directly (for now you send the link yourself).

## License

MIT
