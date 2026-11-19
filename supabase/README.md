# Business accounts (Supabase)

`schema.sql` sets up business accounts: businesses, their members, email
invitations, and the products each business shares. Not wired into the
website yet; that starts once the project below exists.

## Setting up the project (once)

1. Create a project at supabase.com. Name it CubePlanner and choose the
   specific **Sydney** region (not the general "Asia-Pacific" one). Under
   Data access: keep **Enable Data API** on, switch **Grant API access to
   new tables automatically** off (`schema.sql` grants exactly what is
   needed), and switch **Enable RLS on new tables automatically** on.
2. In **SQL Editor**, paste the whole of `schema.sql` and run it.
3. In **Authentication → URL Configuration**, set the Site URL to
   `https://cubeplanner.app` and add `http://localhost:8173` to the
   redirect URLs (for testing on this Mac).
4. From **Project Settings → API**, note the **Project URL** and the
   **anon / publishable key**. These two go in the website and the app;
   they are meant to be public. Never put the **service_role** key
   anywhere outside the Supabase dashboard.

## What is enforced

Every rule is in the database itself (row-level security), so it holds
for the website, the iPhone app and anything else:

- a signed-in user sees only the businesses they belong to, and only
  those businesses' products;
- any member can add and change products; only an admin can delete
  products, invite people or remove them;
- a business always keeps at least one admin.

## The paywall (Stripe) — written, NOT switched on yet

One flat monthly subscription per business. The example on the website is
free; a business's own products need the subscription. The iPhone app's
Apple subscription is separate.

Files: `billing.sql` (the plan on each business, and the rule that products
can only be read with a paid plan), `functions/billing` (opens Stripe's
checkout or billing page for an admin) and `functions/stripe-webhook`
(records what Stripe says about each subscription).

To switch it on, in this order:

1. **Stripe, in test mode first.** Create a product "CubePlanner" with one
   recurring monthly price. Note the price's id (`price_…`).
2. **Supabase → Edge Functions → Secrets.** Add `STRIPE_SECRET_KEY`
   (`sk_test_…`) and `STRIPE_PRICE_ID`. These never go in this repository,
   in chat, or in the website.
3. **Deploy the two functions** (dashboard editor or `supabase functions
   deploy`). `stripe-webhook` must have "Verify JWT" switched off.
4. **Stripe → Developers → Webhooks.** Add an endpoint at
   `https://wjgtxvthkxqhoomxdrkc.supabase.co/functions/v1/stripe-webhook`
   for `checkout.session.completed` and the three
   `customer.subscription.*` events. Put its signing secret (`whsec_…`) in
   the Supabase secret `STRIPE_WEBHOOK_SECRET`.
5. **Test** with Stripe's test card on http://localhost:8173.
6. **Run `billing.sql`.** Businesses that already exist are switched on
   free ("comped"); every new one starts unpaid.
7. To go live, repeat 1, 2 and 4 with Stripe's live mode keys.

To give a business free access by hand, in the SQL editor:
`update public.businesses set plan_status = 'comped' where name = '…';`

Optional: set `planText` in `js/config.js` (for example `'$99 a month'`) to
show the price on the subscribe screen.
