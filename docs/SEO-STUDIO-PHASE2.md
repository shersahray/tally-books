# SEO Studio Phase 2 — Search Console, reviews, scheduled audits

This phase builds on PR #48, without merging either branch or deploying to Azure.

## Administrator access
In Sumlora, open **Companies → Overview → SEO Studio** as the platform administrator.

## Google Search Console (read only)

The dashboard retrieves a finalized 28-day Google organic Search performance summary (clicks, impressions, CTR, average position) plus top 20 queries and pages. These are **real Search Console measurements**, only after the service account is configured; never simulated results. Metrics and dimensional breakdowns can differ because of Search Console filtering and aggregation.

1. Verify `sumlora.ca` as a Domain property (`sc-domain:sumlora.ca`) or an HTTPS URL-prefix property (`https://sumlora.ca/`) in Google Search Console.
2. In a Google Cloud project, enable the Search Console API and create a service account with a JSON key. Keep that key outside GitHub.
3. Grant the service account email read-level property access in **Search Console → Settings → Users and permissions**. Check the service account has access to the exact configured property.
4. On the **Azure application server**, set:
   - `SEO_GSC_CLIENT_EMAIL` = service account email.
   - `SEO_GSC_PRIVATE_KEY` = PEM key from the service account JSON (literal newlines or escaped `\\n` accepted).
   - `SEO_GSC_PROPERTY` = `sc-domain:sumlora.ca` (default), or `https://sumlora.ca/`.
5. Restart the Sumlora application securely after updating its server-side environment, then click **Load 28-day search performance** in the SEO Studio dashboard.

Keep the private key in Azure-protected app settings or a secure secret store, never in a frontend/static site, git repository, or shared support screenshot. This is a **read-only** OAuth scope. The implementation uses service-account JWT assertions and Google's official token endpoint.

For full provider setup, see [Google Search Console API authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing) and [Search Analytics query API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

## Scheduled audits

Scheduled audits are **off by default**. To opt in, set `SEO_AUTO_AUDIT=1` in the **server environment**, then restart the Sumlora process. A six-hour check runs an audit only when the most recent snapshot is at least seven days old. Up to 12 latest audit summaries are stored privately; the latest full audit remains available. No emails are sent.

## Editorial workflow
- Drafts may be edited; administrators can set **Needs review**, **Approved**, or **Rejected**, with review notes.
- Approved drafts gain an **Export approved Markdown** button for manual content publishing.
- No approval or export action writes to sumlora.ca or GitHub; automated publishing is deliberately deferred.
- Avoid publishing AI output before checking tax/legal claims, prices, software capabilities and factual statements.

## Safety and boundaries
- Every Phase 2 API requires authenticated **platform administrator** access.
- No client-company data is read or written by SEO Studio.
- GSC property is restricted to exact Sumlora property identifiers.
- Google API access uses a server-side credential and readonly permission.
- No unattended Google requests until the administrator clicks Refresh.
- No unattended site scans until `SEO_AUTO_AUDIT=1` is configured.
- Article publication remains disabled.

## Checks before merging or deployment

```sh
node --test test/seo-studio.test.js test/seo-phase2.test.js
npm test
```

Check app sign-in and user authorization for all new routes, load the SEO Studio tab, verify Google access works with a real Search Console property, inspect Azure environment secrets and confirm draft review/export. This PR is stacked on Phase 1 and should be merged **after** PR #48, or rebased if Phase 1 is merged first.
