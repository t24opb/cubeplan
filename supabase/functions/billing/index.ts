// CubePlanner — starts a Stripe checkout for a business, or opens its
// billing page. Called by the website with the signed-in user's token.
//
// Secrets (Supabase → Edge Functions → Secrets), set by the owner:
//   STRIPE_SECRET_KEY   the Stripe secret key (sk_test_… while testing)
//   STRIPE_PRICE_ID     the monthly price a business subscribes to
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINS = ["https://cubeplanner.app", "https://www.cubeplanner.app", "http://localhost:8173"];

function headers(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

async function stripe(path: string, fields: Record<string, string>) {
  const answer = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + Deno.env.get("STRIPE_SECRET_KEY"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  const json = await answer.json();
  if (!answer.ok) throw new Error(json?.error?.message ?? "Stripe refused the request.");
  return json;
}

Deno.serve(async (request) => {
  const cors = headers(request.headers.get("Origin"));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: cors });
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return reply(405, { error: "Use POST." });
  if (!Deno.env.get("STRIPE_SECRET_KEY") || !Deno.env.get("STRIPE_PRICE_ID")) {
    return reply(503, { error: "Payments are not switched on yet." });
  }

  try {
    const { action, business, returnTo } = await request.json();
    const back = String(returnTo ?? "");
    if (!ORIGINS.some((origin) => back === origin || back.startsWith(origin + "/"))) {
      return reply(400, { error: "That return address is not allowed." });
    }

    // Who is asking, and are they an admin of this business?
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: request.headers.get("Authorization") ?? "" } },
    });
    const { data: who } = await asUser.auth.getUser();
    if (!who?.user) return reply(401, { error: "Sign in first." });
    const { data: isAdmin } = await asUser.rpc("is_admin", { business });
    if (!isAdmin) return reply(403, { error: "Only an admin of the business can manage its subscription." });

    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: row, error } = await service.from("businesses")
      .select("id, name, stripe_customer_id").eq("id", business).single();
    if (error || !row) return reply(404, { error: "That business was not found." });

    if (action === "portal") {
      if (!row.stripe_customer_id) return reply(400, { error: "This business has no subscription to manage yet." });
      const portal = await stripe("billing_portal/sessions", { customer: row.stripe_customer_id, return_url: back });
      return reply(200, { url: portal.url });
    }

    if (action === "checkout") {
      const fields: Record<string, string> = {
        "mode": "subscription",
        "line_items[0][price]": Deno.env.get("STRIPE_PRICE_ID")!,
        "line_items[0][quantity]": "1",
        "client_reference_id": row.id,
        "subscription_data[metadata][business_id]": row.id,
        "subscription_data[description]": "CubePlanner — " + row.name,
        "allow_promotion_codes": "true",
        "success_url": back + (back.includes("?") ? "&" : "?") + "billing=done",
        "cancel_url": back,
      };
      if (row.stripe_customer_id) fields["customer"] = row.stripe_customer_id;
      else if (who.user.email) fields["customer_email"] = who.user.email;
      const session = await stripe("checkout/sessions", fields);
      return reply(200, { url: session.url });
    }

    return reply(400, { error: "Unknown action." });
  } catch (problem) {
    return reply(500, { error: problem instanceof Error ? problem.message : "Something went wrong." });
  }
});
