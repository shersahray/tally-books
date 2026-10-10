# sumlora.ca public website

A single static page (`index.html`) plus the logo files. No build step: upload every file in this folder (the page, logos and favicon files) to the root of whatever hosts sumlora.ca, so `sumlora.ca/favicon.ico` loads.

## Where the buttons go

"Start free trial" opens `https://app.sumlora.ca/?signup` and "Sign in" opens `https://app.sumlora.ca/`. That assumes the Sumlora server (see `deploy/azure/README.md`) is reachable at **app.sumlora.ca**:

1. At your domain registrar, add a DNS **A record**: name `app`, value = the Azure server's static public IP address.
2. On the server, set `DOMAIN` to `app.sumlora.ca` so the HTTPS certificate is issued for that name.

If the server lives at a different address, replace `https://app.sumlora.ca` everywhere in `index.html`.

## For the buttons to work

On the Sumlora server, signed in as the administrator:

- **Firms → Can new firms sign up:** "Yes, straight away" (or "after I approve each one").
- **Firms → Subscriptions (Stripe):** add the Stripe key. Optionally turn on **Charge sales tax** once Stripe Tax is set up in Stripe.
- In Stripe, turn on the **Customer portal** (Settings → Billing → Customer portal) so subscribers can change their card or cancel.

`?signup` opens the sign-up form with "My own business" chosen; `?signup=firm` chooses "A bookkeeping or accounting firm".
