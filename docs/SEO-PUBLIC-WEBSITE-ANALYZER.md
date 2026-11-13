# SEO Studio — Analyze other public websites

This change adds **Analyze another website** above the original Sumlora-only SEO audit in the platform-admin Overview → SEO Studio screen.

Enter one public HTTPS URL (for example, https://example.com/). Click **Analyze website** to check its title, description, H1 count, canonical, robots directives and potential metadata problems.

This is a single-page report, not a full-site crawl or a source of Google rankings, competitor traffic or backlinks. The Search Console connection remains restricted to sumlora.ca.

## Security boundaries
- Only authenticated Sumlora platform administrators can access the endpoint.
- HTTPS on port 443 only; literal IPs, local hostnames, credentials and URL fragments are blocked.
- DNS answers are inspected; private/reserved or mixed public/private answers are blocked.
- The approved resolved IP is pinned for the TLS connection, preserving hostname-based certificate verification.
- Redirects are refused. The administrator must enter the final HTTPS page URL.
- The request has an eight-second timeout and 512 KiB HTML response limit.
- At most 12 attempts per running application process per hour; no crawling, credentials or script execution.

Security review remains necessary before enabling this feature for regular users or public access. The per-process limit is not shared across Azure instances.

## Test and deploy
Run: node --test test/seo-public-analyzer.test.js test/seo-studio.test.js
Also run: npm test

After review and successful testing, merge the PR into main and use the existing Azure updater. Then visit Companies → Overview → SEO Studio → Analyze another website.
