// /api/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

// Read raw request body (required for Stripe signature verification)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing SUPABASE_URL");
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, key, { auth: { persistSession: false } });
}

function isoFromUnixSeconds(sec) {
  if (!sec || typeof sec !== "number") return null;
  return new Date(sec * 1000).toISOString();
}

/**
 * Upsert entitlement row. If optional columns are missing (schema mismatch),
 * retry with minimal, safe columns that should exist.
 */
async function upsertEntitlement(sb, payload) {
  const first = await sb
    .from("entitlements")
    .upsert(payload, { onConflict: "user_id" });

  if (!first.error) return;

  console.error(
    "Entitlement upsert failed (full payload). Retrying minimal.",
    first.error?.message || first.error
  );

  const minimal = {
    user_id: payload.user_id,
    tier: payload.tier,
    is_paid: payload.is_paid === true,
    updated_at: new Date().toISOString(),
  };

  const second = await sb
    .from("entitlements")
    .upsert(minimal, { onConflict: "user_id" });

  if (second.error) {
    console.error(
      "Entitlement upsert failed (minimal payload).",
      second.error?.message || second.error
    );
    throw second.error;
  }
}

async function setPaidFromSubscription(sb, userId, customerId, subscriptionId) {
  // Fetch subscription to get authoritative status + period end
  const sub = subscriptionId
    ? await stripe.subscriptions.retrieve(subscriptionId)
    : null;

  const status = sub?.status || "active";
  const currentPeriodEnd = isoFromUnixSeconds(sub?.current_period_end);

  const isActive =
    status === "active" || status === "trialing"; // treat trialing as paid access

  const payload = {
    user_id: userId,
    tier: isActive ? "paid" : "free",
    is_paid: isActive,
    stripe_customer_id: customerId || null,
    stripe_subscription_id: subscriptionId || null,
    stripe_status: status || null,
    current_period_end: currentPeriodEnd,
    updated_at: new Date().toISOString(),
  };

  await upsertEntitlement(sb, payload);
}

async function setStatusFromSubscriptionObject(sb, userId, subscription) {
  const status = subscription?.status || null;
  const currentPeriodEnd = isoFromUnixSeconds(subscription?.current_period_end);

  const isActive =
    status === "active" || status === "trialing";

  const payload = {
    user_id: userId,
    tier: isActive ? "paid" : "free",
    is_paid: isActive,
    stripe_customer_id: subscription?.customer || null,
    stripe_subscription_id: subscription?.id || null,
    stripe_status: status,
    current_period_end: currentPeriodEnd,
    updated_at: new Date().toISOString(),
  };

  await upsertEntitlement(sb, payload);
}

export default async function handler(req, res) {
  try {
    // Keep GET for quick health checks
    if (req.method === "GET") return res.status(200).send("stripe-webhook alive");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secretKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!webhookSecret) return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET" });

    const signature = req.headers["stripe-signature"];
    if (!signature) return res.status(400).json({ error: "Missing stripe-signature header" });

    const rawBody = await readRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error("Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const sb = getSupabaseAdmin();

    // Minimal production logging (avoid dumping metadata/session objects)
    console.log(`[stripe-webhook] ${event.type} id=${event.id} livemode=${event.livemode}`);

    switch (event.type) {
      // ✅ Checkout completed: grant access based on subscription status/period end
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session?.metadata?.supabase_user_id;

        if (!userId) {
          console.error("Missing session.metadata.supabase_user_id; cannot grant access.");
          break;
        }

        await setPaidFromSubscription(
          sb,
          userId,
          session.customer,
          session.subscription
        );

        break;
      }

      // ✅ Keep entitlements synced over time (cancel, payment failure, etc.)
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        // We need to map subscription -> user_id.
        // Best practice: store user_id in subscription metadata when creating checkout session.
        const userId = subscription?.metadata?.supabase_user_id;

        if (!userId) {
          // If you don’t store userId in subscription metadata yet, you can fall back to
          // mapping via stripe_customer_id in your entitlements table, but that's slower.
          console.error("Missing subscription.metadata.supabase_user_id; cannot sync entitlement.");
          break;
        }

        await setStatusFromSubscriptionObject(sb, userId, subscription);
        break;
      }

      default:
        // Keep quiet in prod; Stripe sends many event types depending on enabled methods.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook crashed:", err);
    return res.status(500).json({ error: "Webhook crashed", detail: String(err?.message || err) });
  }
}
