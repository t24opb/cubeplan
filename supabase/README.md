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
