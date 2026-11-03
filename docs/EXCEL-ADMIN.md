# Sumlora for Excel administration (Overview → Excel)

The administrator's Overview has an **Excel** tab for the separate Sumlora for Excel product.
From it the server's administrator (only) can:

- see how many Excel firms, employees and how much AI budget is used this month;
- **invite an accounting firm**: create the firm (name, its Microsoft 365 tenant ID, monthly AI
  budget in CAD) and get a one-time invitation link for its first administrator;
- **manage Excel firms**: change the AI budget or switch AI off, suspend or reactivate a firm,
  invite or cancel administrator invitations, and read the firm's activity log.

Employees are unlimited. Each firm's administrator invites their own employees from inside Excel.

## What it does not touch

Nothing here changes Bookkeeping companies, users, data, subscriptions or desktop licences.
Excel firms, members and budgets live in the Sumlora for Excel database, not in this server.
The desktop app never shows the Excel tab as connected (it has no Excel settings).

## How the connection works

This server calls the Excel service's administrator API **server to server**. The browser never
calls it and never sees the key. Every request is signed with HMAC-SHA256 over the method, path,
time, a random one-time value, the administrator's username and a hash of the body. The Excel
service rejects requests that are unsigned, altered, more than 5 minutes old or replayed, and
records your username as the actor in its own audit log. This server also writes
`excel-firm-created`, `excel-firm-suspended`, `excel-firm-reactivated` and `excel-ai-budget`
to its sign-in log. Firm owners don't see these entries.

Code: `src/server/excel-admin.js` (client and signing), the `/api/overview/excel/...` routes in
`src/server/app.js` (administrator only), and `public/overview.js` (screens).

## Turning it on

Leave these unset until the Excel service is deployed (see the `sumlora-excel-addin` repository,
`docs/PHASE2-BACKEND.md`). Until then the Excel tab says "not connected" and its buttons are off.

Add three lines to `/etc/tally-books.env` on the online server, then restart the service
(`sudo systemctl restart tally-books`):

```
EXCEL_ADMIN_API_URL=https://<excel-api-host>
EXCEL_ADMIN_KEY_ID=k1
EXCEL_ADMIN_HMAC_SECRET=<the same base64 secret as EXCEL_ADMIN_HMAC_KEYS on the Excel API>
```

- The URL must be `https://` and just the server address (no path).
- Generate the secret once: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  On the Excel API set `EXCEL_ADMIN_HMAC_KEYS=k1:<that secret>`.
- To rotate: add `k2:<new secret>` to the Excel API (comma separated), switch this server to `k2`,
  then remove `k1` from the Excel API.
- If the setting is present but invalid, the server refuses to start and prints why.
- Both servers' clocks must be within 5 minutes (Azure VMs sync time automatically).

## Tests

- `test/excel-admin.test.js`: 12 tests against a fake Excel service that checks every signature
  independently. They cover administrator-only access, not-configured state, field allow-listing,
  error messages, an unreachable service, invalid IDs and the overview panel.
- The signing format is pinned by a shared test vector, which also appears in the Excel
  repository's tests. If either side changes the format, both test suites fail.
