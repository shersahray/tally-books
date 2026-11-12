# Sumlora SEO Studio — Phases 3–7

This is a **stacked draft implementation** on top of Phase 2. It does **not** deploy to Azure or modify the production sumlora.ca site.

## Phase 3 — Approved publishing PRs
A platform administrator can approve an article, then click **Create publishing PR**. The service generates a safe, standalone HTML article under \`blog/<slug>/index.html\`, proposes a canonical URL, updates the website sitemap, and creates a **draft GitHub PR** in \`shersahray/sumlora-website\`. **Nothing merges, publishes or deploys automatically.** Review of the PR and normal Cloudflare deployment are still required.

To enable the PR writer **after security review** on the Sumlora *server*, not in the browser:
- \`SEO_GITHUB_PUBLISH_ENABLED=1\`
- \`SEO_GITHUB_TOKEN\` set to a fine-grained, short-lived token with **Contents: Read and write** and **Pull requests: Read and write** for **only** \`shersahray/sumlora-website\`.

Publishing is disabled unless both are present. Avoid repository-wide tokens. Never share tokens or copy them into logs. Restrict who can open the Sumlora platform-admin dashboard.

**Scheduled PR preparation:** An approved article can be scheduled. Automatic due-PR preparation is *independently disabled* until \`SEO_PUBLISH_SCHEDULED=1\` is configured. The scheduler checks hourly and creates a **draft PR**, not a live page. Review and merge remain manual. A failure in multi-step GitHub updates can leave a partial branch; inspect/reconcile before retrying. It cannot guarantee exactly-once publishing under multiple app instances. Keep this flag **off** until idempotency and multi-instance locking are production-tested.

## Phase 4 — Google Search Console opportunities
**Analyze Google search opportunities** fetches measured Search Console query impressions, clicks, CTR and positions, then flags queries worth investigating (example: prominent impressions and low CTR). Search Console must already be configured as described in \`docs/SEO-STUDIO-PHASE2.md\`. This is not a general keyword-volume tool; it relies on the site's actual queries.

## Phase 5 — Competitor snapshot
**Compare public homepages** inspects a fixed allowlist of Canadian product homepages for a title, description tag and H2 count. These snapshots are limited and do **not** provide competitors' traffic, keyword rankings, referring domains, or exact content gaps. There is no broad crawler or user-submitted URL proxy.

## Phase 6 — Draft optimization
**Analyze draft** provides non-destructive review suggestions: title length, keyword mentions, headings, short content, unverified facts and a call to action. It suggests a metadata title and description, but does not automatically rewrite a reviewed article or claim Google-ranking guarantees.

## Phase 7 — Lead attribution (manual MVP)
Administrators can record a demo request's source, channel, campaign and Sumlora landing page, without customer name, email, browser ID or IP. The dashboard displays channel counts and recent events. This is **manual attribution**, not a visitor analytics installation; no automatic conversion tracking or cookies have been introduced. Actual end-to-end attribution requires a privacy-reviewed contact/booking form integration, consent/legal review where applicable, and an anti-abuse pipeline.

## Administrator access
All new REST endpoints live under \`/api/overview/seo/*\` and require the same authenticated platform-admin access as the original SEO Studio; there is no client-ledger access.

## Deployment sequence
1. Validate and merge Phase 1 PR #48.
2. Rebase/validate and merge Phase 2 PR #49.
3. Rebase and run tests for this Phases 3–7 PR; review GitHub secret controls and platform-admin authorization, then merge.
4. Update the **Azure Sumlora app** through your existing deployment process.
5. Configure Search Console and (only if ready) a narrow GitHub publisher token.
6. Run a full preview test: approved draft → draft website PR → code review → Cloudflare preview → manual merge/deploy → verify canonical and sitemap.
7. Keep scheduled PR preparation disabled until a crash/retry/locking review is complete.

## Test commands
\`\`\`sh
node --test test/seo-studio.test.js test/seo-phase2.test.js test/seo-advanced.test.js
npm test
\`\`\`

## Remaining production work
- Robust GitHub PR idempotency/recovery after partial failures and multi-instance locking.
- Accessible blog archive and consistent global-site navigation; consider sharing existing header/footer rather than independent article markup.
- Proper Markdown (links/lists/images), production previews, internationalization, author attribution and schema.
- Search provider rate limits and reliable scheduled job coordination.
- Production analytics/conversion capture with privacy review and spam prevention.
- Full end-to-end tests (authentication/permissions, server restarts, GitHub error recovery, mobile/desktop UX).
- Site performance benchmarking and Google Search Console verification.

No promise of SEO rankings or sales is made by this implementation.
