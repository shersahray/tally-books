# SEO Studio — Phase 1

SEO Studio is an **administrator-only** section of Sumlora's existing Overview screen.

## Open it
1. Sign into Sumlora with a **platform administrator** account.
2. Open **Companies → Overview → SEO Studio**.
3. Select **Run website audit**, **Find keywords**, **Create outline**, or **Generate AI draft**.

## Features
- **Website audit** checks the actual marketing URLs from the sumlora.ca sitemap and tests `robots.txt` and `sitemap.xml`. It reports HTTP errors, missing/long page titles and descriptions, multiple/missing H1 elements, canonicals, and noindex directives. The audit is a snapshot, not a live rank tracker.
- **Keyword planner** presents curated Canadian accounting/bookkeeping search phrases. It does **not** claim keyword volumes, competition metrics or live Search Console measurements.
- **Draft generator** saves a structured editorial outline or (when configured) an AI-generated Markdown draft for private review.
- **Stored data** resides in `DATA_DIR/seo-studio.json` on the Sumlora server, separate from every firm's company ledger.

## AI setup
AI drafting uses the server-side `ANTHROPIC_API_KEY` already supported by Sumlora. The administrator explicitly clicks **Generate AI draft**. Provider calls consume tokens and may incur charges. Without a key, **Create outline** still works and the AI button returns a clear configuration error. Do not expose the key in Cloudflare Pages or browser JavaScript.

## Safety
- All SEO routes use the same authenticated platform-admin check as the existing Overview APIs.
- Only the hard-coded `sumlora.ca` URLs are fetched; user-entered URLs are never proxied.
- URL redirects are not followed.
- Drafts have status `needs-review`, `published: false`, and cannot publish automatically.
- Validate tax statements, software claims, citations and prices before publishing content.
- The draft store is included in the server's normal data directory; ensure the existing server backup policy includes it.

## Test
```bash
node --test test/seo-studio.test.js
```

## Later phases (not implemented)
Live Google Search Console reports, search-volume metrics, richer AI editorial workflow, SEO issue scheduling, review/edit approvals, and GitHub/Cloudflare publication.
