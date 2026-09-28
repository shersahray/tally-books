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
  - **GST/HST (CRA):** lines 101 to 113C and 114/115. Tax collected, input tax credits, adjustments from journal entries, and instalments are calculated from the books, and you can open the transactions behind each figure. Rebates and self-assessed amounts (lines 111, 205 and 405) are typed in.
  - **QST (Revenu Québec):** Quebec companies track GST (5%) and QST (9.975%) in separate accounts and get their own QST worksheet, lines 203 to 213.
  - **Filing:** marking a return as filed saves its figures and can record the payment to the government, or the refund, which clears the tax account. Instalments can be recorded too.
  - **Filed periods:** changing a transaction in a filed period asks for confirmation first, and the worksheet shows when the books no longer match what was filed.
  - The app produces the figures; returns are still submitted on CRA My Business Account or with Revenu Québec.
- **Journal entries:** manual entries with debit and credit lines. The server rejects any entry that doesn't balance.
- **Chart of accounts:** set up for a Canadian small business charging HST (13%). The tax name, rate and fiscal year start are all in Settings.
- **Reports:** profit and loss, balance sheet, trial balance, A/R aging and A/P aging, for any date range. All of them export to CSV.
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
| `APP_PASSWORD` | *(none)* | When set, the browser asks for this password (any username). **Set it whenever `HOST` isn't `127.0.0.1`.** |

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

`.github/workflows/release.yml` builds the Windows `.exe`, the macOS `.dmg` and the Linux `.AppImage` on GitHub's computers. To run it, go to **Actions → Build desktop apps → Run workflow**. It also runs when you push a version tag such as `v1.0.0`.

When the run finishes, download the installers from the **Artifacts** section at the bottom of the run's page.

The builds aren't code-signed, so Windows SmartScreen and macOS Gatekeeper will warn the first time someone opens the app.

## How it works

```
public/            Browser app (plain HTML, CSS and JavaScript, no build step)
  bankparse.js     Bank file parsers (CSV column detection, OFX/QFX/QBO)
  banking.js       Banking screens: import, review, rules, reconcile
  companies.js     Client list, company switcher, new company
  salestax.js      GST/HST and QST return worksheets, filing, payments
src/server/
  app.js           HTTP server: JSON API, static files, live updates
  db.js            SQLite storage (Node's built-in node:sqlite)
  companies.js     Company list; one database file per company
  validate.js      Bookkeeping rules enforced on every write
  seed.js          Default chart of accounts and example data
  index.js         Command-line entry point
electron/main.js   Desktop wrapper: starts the server privately and opens a window
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

**Across companies:**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/companies` | Every company with a summary, plus the province tax presets |
| `POST` | `/api/companies` | `{ "name", "province", "fyStart", "copyFrom", "examples" }` creates a company |
| `PUT` | `/api/companies/:id` | `{ "archived": true \| false }` |
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

## Development

```bash
npm test
```

The tests start a real server against a temporary database. They cover the bookkeeping rules, bank file parsing for several Canadian bank formats, statement import and duplicate detection, all-or-nothing batch writes, backup and restore, cross-site request blocking, password protection, keeping companies separate, and moving books over from the single-company version.

## Not built yet

Live bank feeds (statement import is covered above), the Quick Method of accounting for GST/HST, sending returns straight to CRA or Revenu Québec, emailing invoices or saving them as PDFs, payroll, multiple currencies, user accounts with roles, and an audit log of who changed what.

## License

MIT
