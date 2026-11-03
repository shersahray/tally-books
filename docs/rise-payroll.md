# Rise payroll connection — read-only pilot

This version connects an individual Sumlora company to a Rise account through a **public OAuth application using Authorization Code + PKCE**. It requests only `reports:read`. It can check the connection by displaying the first 100 employee names/statuses and available report names. It does not import payroll amounts, submit/approve payroll, send hours or tips, move funds, or create accounting entries.

## Setup

1. Ask Rise for a test account, public OAuth app access, and confirmation that `reports:read` permits `/employees` and `/reports` for your account. Confirm commercial partner terms separately. The published quickstart uses these endpoints, but no live Rise account has been tested in this implementation.
2. Set Sumlora's server public URL (existing email/server URL setting or `publicUrl` option). Use HTTPS; only `http://localhost` is accepted for development.
3. In Rise: People → Settings → OAuth applications. Register a **Public** application with `reports:read` and the exact redirect URI shown in Sumlora Settings: `https://YOUR-SUMLORA-HOST/api/rise/callback`. This implementation does not accept a confidential client secret.
4. As Sumlora's platform administrator, open a company → Settings → Rise payroll connection. Save the public client ID, then enable only the desired pilot company. Access is disabled for every company by default. Ordinary firm owners cannot enable it or change the app.
5. As that company's firm owner, choose Connect to Rise. Confirm the employer and sign in to the corresponding Rise account. After consent, return to Settings and choose Check connection. Employee names and report titles should match the intended employer. No automatic employer matching is implemented; stop and disconnect if the account is wrong.
6. Disable access from the administrator's company list when the pilot ends. Disconnect deletes local tokens and attempts revocation at Rise. If revocation fails, revoke the OAuth application in Rise too.

## Security and operations

- Company access, account ownership, disabled users, archived companies and firm status are checked before accepting OAuth callbacks. Callback state is random, expires after 10 minutes and is single-use; PKCE verifiers remain on the server.
- Access/refresh tokens are AES-256-GCM encrypted, authenticated to the Sumlora company ID, in `rise.json`. `rise.key` holds the random 32-byte encryption key. Both files use mode 0600 and live in the server's integration directory (`licenceDir` or `dataDir`), outside company databases/exports. Keep both in protected server disaster-recovery backups; company-only backups do not restore connections. Do not commit either file. Loss of the encryption key requires recovery or clearing connections and reconnecting.
- OAuth state is held in memory: restarting Sumlora requires restarting any unfinished sign-in. Refreshes are serialized per company; disconnects and access revocations cannot be undone by requests already in flight.
- Only fixed Rise API URLs are used. Redirects are rejected, requests time out after 20 seconds, and provider error bodies are not exposed. No arbitrary report execution or payroll-write endpoints exist.
- Connection previews are returned on demand and not stored in company books. SINs, banking data, tokens and raw employee records are not sent to the browser. Only firm owners can use this pilot UI/API; staff/client access is denied.
- Changing the public client ID requires disconnecting all companies first. There is no sandbox host selector: Rise must confirm how its test accounts are provisioned before any live pilot.

## Validation and next stage

Tests use simulated Rise responses, not a live account. Run `node --test test/rise.test.js` for OAuth, isolation, encryption, refresh/disconnect races, safe errors and API controls.

Before expanding this to payroll processing, obtain Rise's full Payroll OpenAPI specification and sandbox access. Verify organization scoping, scopes and employee/payrun identifiers; map employees and earning codes (including overtime and tips); validate detailed payroll report/account mapping; implement duplicate-safe import of completed payroll into reviewed draft journals; then test hours submission, corrections/voids and reconciliation. Payment, remittance, tax slip and support responsibilities need written agreement with Rise. No payroll submission should be enabled until those stages pass sandbox and pilot validation.

References reviewed November 3, 2026:
- https://developer.risepeople.com/authentication/
- https://developer.risepeople.com/quickstart/
- https://developer.risepeople.com/reference/reporting/
- The portal homepage advertises payroll input/submission/approval/reporting, but the detailed payroll reference could not be retrieved during implementation. No payroll endpoint or field names were guessed.
