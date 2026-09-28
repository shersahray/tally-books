# Tally Books

Double-entry bookkeeping for small businesses. Send invoices, enter bills and expenses, keep a chart of accounts, and run the reports an accountant needs at year-end.

It runs two ways from the same code:

- **Web app:** a small server you run on your computer or a server, then open in any browser. Several people can use it at once, and changes show up live for everyone.
- **Desktop app:** an installable app for Windows, macOS and Linux. It keeps your books in a file on your own computer.

![Tally Books dashboard](docs/screenshot.png)

## Features

- **Sales:** invoices with line items and sales tax, partial and full payments, and a status on every invoice (open, partial, overdue, paid).
- **Expenses:** vendor bills, bill payments, expenses paid by bank or credit card, and deposits.
- **Banking:** transfers between accounts, credit card payments, and a register for each account with a running balance.
- **Journal entries:** manual entries with debit and credit lines. The server rejects any entry that doesn't balance.
- **Chart of accounts:** set up for a Canadian small business charging HST (13%). The tax name, rate and fiscal year start are all in Settings.
- **Reports:** profit and loss, balance sheet, trial balance, A/R aging and A/P aging, for any date range. All of them export to CSV.
- **Year-end:** the trial balance closes prior years into retained earnings, so the CSV is ready to import into working-paper software such as CaseWare.
- **Backup and restore:** one JSON file holds everything. Use it to move books between computers.
- **Example data:** sample customers and transactions for trying things out. They're marked "Example" and can be removed in one click.

## Run it as a web app

You need **[Node.js](https://nodejs.org) 22.13 or newer**. The web server has no other dependencies.

```bash
git clone https://github.com/<you>/tally-books.git
cd tally-books
npm start            # or: npm run start:demo  (loads example data on first run)
```

Then open <http://localhost:3000>.

Your books are saved in `data/tally-books.db`. That's a normal SQLite file, so you can back it up by copying it while the server is stopped, or use **Settings → Download backup** at any time.

### Settings

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to allow other computers on your network |
| `DATA_DIR` | `./data` | Folder that holds the database file |
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

The desktop app keeps its database in your user data folder. **File → Show data file** in the app shows you where it is.

### Automatic installers from GitHub

`.github/workflows/release.yml` builds the Windows `.exe`, the macOS `.dmg` and the Linux `.AppImage`, then attaches them to a draft GitHub release. It runs whenever you push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The builds aren't code-signed, so Windows SmartScreen and macOS Gatekeeper will warn the first time someone opens the app. Add signing certificates to the workflow when you have them.

## How it works

```
public/            Browser app (plain HTML, CSS and JavaScript, no build step)
src/server/
  app.js           HTTP server: JSON API, static files, live updates
  db.js            SQLite storage (Node's built-in node:sqlite)
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

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Every account, contact, document, entry and setting |
| `PUT` | `/api/records/:collection/:id` | Create or replace a record (`accounts`, `contacts`, `docs`, `entries`) |
| `DELETE` | `/api/records/:collection/:id` | Delete a record |
| `POST` | `/api/batch` | `{ "writes": [{ "op": "set" \| "delete", "collection", "id", "data" }] }`, applied all or nothing |
| `PUT` | `/api/settings` | Company settings |
| `GET` | `/api/backup` | Download a full backup |
| `POST` | `/api/restore` | Replace everything with a backup |
| `POST` | `/api/examples` | Load example data |
| `GET` | `/api/events` | Server-sent events, sent whenever anything changes |

## Development

```bash
npm test
```

The tests start a real server against a temporary database. They cover the bookkeeping rules, all-or-nothing batch writes, backup and restore, cross-site request blocking and password protection.

## Not built yet

Bank feeds, bank reconciliation, emailing invoices or saving them as PDFs, payroll, multiple currencies, user accounts with roles, and an audit log of who changed what.

## License

MIT
