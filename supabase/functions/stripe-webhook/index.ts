// CubePlanner — hears from Stripe when a subscription starts, changes or
// ends, and records the business's plan. Stripe calls this directly, so
// it must be deployed with "Verify JWT" switched OFF; every call is
// checked against Stripe's signature instead.
//
// Secret (Supabase → Edge Functions → Secrets), set by the owner:
//   STRIPE_WEBHOOK_SECRET   the signing secret of the webhook endpoint (whsec_…)
import { createClient } from "jsr:@supabase/supabase-js@2";

/** Checks Stripe's signature on the exact bytes received. */
async function signedByStripe(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((piece) => piece.split("=") as [string, string]));
  const stamp = parts["t"];
  const given = header.split(",").filter((piece) => piece.startsWith("v1=")).map((piece) => piece.slice(3));
  if (!stamp || !given.length) return false;
  // Not older than five minutes: a captured call cannot be replayed later.
  if (Math.abs(Date.now() / 1000 - Number(stamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stamp + "." + payload));
  const expected = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return given.some((signature) => {
    if (signature.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    return difference === 0;
  });
}

/** Stripe's word for a subscription's state → ours. */
function plan(status: string): string {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due") return "past_due";
  return "canceled";
}

Deno.serve(async (request) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("Payments are not switched on yet.", { status: 503 });
  const payload = await request.text();
  if (!(await signedByStripe(payload, request.headers.get("Stripe-Signature"), secret))) {
    return new Response("Bad signature.", { status: 400 });
  }

  const event = JSON.parse(payload);
  const object = event?.data?.object ?? {};
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // A business switched on by hand ("comped") is never changed from here.
  async function record(business: string | undefined, changes: Record<string, unknown>) {
    if (!business) return;
    const { error } = await service.from("businesses").update(changes).eq("id", business).neq("plan_status", "comped");
    if (error) throw new Error(error.message);
  }

  try {
    if (event.type === "checkout.session.completed" && object.mode === "subscription") {
      await record(object.client_reference_id, {
        plan_status: "active",
        stripe_customer_id: object.customer,
        stripe_subscription_id: object.subscription,
      });
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const ended = event.type === "customer.subscription.deleted";
      const until = object.current_period_end ?? object.items?.data?.[0]?.current_period_end;
      await record(object.metadata?.business_id, {
        plan_status: ended ? "canceled" : plan(object.status),
        stripe_customer_id: object.customer,
        stripe_subscription_id: object.id,
        paid_until: until ? new Date(until * 1000).toISOString() : null,
      });
    }
  } catch (problem) {
    // A 500 makes Stripe try again later.
    return new Response(problem instanceof Error ? problem.message : "Could not record the change.", { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
