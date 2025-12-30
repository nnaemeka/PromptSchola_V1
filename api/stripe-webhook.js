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

// Treat these as “paid access”
function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}

/**
 * Upsert entitlement row with a safe fallback.
 */
async function upsertEntitlement(sb, payload) {
  const first = await sb.from("entitlements").upsert(payload, { onConflict: "user_id" });
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

  const second = await sb.from("entitlements").upsert(minimal, { onConflict: "user_id" });
  if (second.error) {
    console.error(
      "Entitlement upsert failed (minimal payload).",
      second.error?.message || second.error
    );
    throw second.error;
  }
}

/**
 * Map a Stripe subscription/customer back to a Supabase user_id.
 * Works even if subscription metadata is missing (older subs).
 */
async function resolveUserIdFromSubscriptionOrEntitlements(sb, subscriptionObj) {
  // 1) Best: subscription metadata (new subs created after you added subscription_data.metadata)
  const metaUserId = subscriptionObj?.metadata?.supabase_user_id;
  if (metaUserId) return metaUserId;

  // 2) Match by stripe_subscription_id
  if (subscriptionObj?.id) {
    const { data, error } = await sb
      .from("entitlements")
      .select("user_id")
      .eq("stripe_subscription_id", subscriptionObj.id)
      .maybeSingle();
    if (!error && data?.user_id) return data.user_id;
  }

  // 3) Match by stripe_customer_id
  if (subscriptionObj?.customer) {
    const { data, error } = await sb
      .from("entitlements")
      .select("user_id")
      .eq("stripe_customer_id", subscriptionObj.customer)
      .maybeSingle();
    if (!error && data?.user_id) return data.user_id;
  }

  return null;
}

/**
 * Authoritative update from a subscription id (fetch Stripe subscription).
 * Used for checkout.session.completed and invoice events.
 */
async function setFromSubscriptionId(sb, userId, customerId, subscriptionId) {
  const sub = subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null;

  const status = sub?.status || "active";
  const periodEnd = isoFromUnixSeconds(sub?.current_period_end);
  const paid = isPaidStatus(status);

  const payload = {
    user_id: userId,
    tier: paid ? "paid" : "free",
    is_paid: paid,
    stripe_customer_id: customerId || sub?.customer || null,
    stripe_subscription_id: subscriptionId || sub?.id || null,
    stripe_status: status,
    current_period_end: periodEnd,
    updated_at: new Date().toISOString(),
  };

  await upsertEntitlement(sb, payload);
}

/**
 * Update entitlements directly from a subscription object (from Stripe event).
 * If mapping fails, we log and no-op (won’t crash the webhook).
 */
async function setFromSubscriptionObject(sb, subscriptionObj) {
  const userId = await resolveUserIdFromSubscriptionOrEntitlements(sb, subscriptionObj);
  if (!userId) {
    console.error("Cannot map subscription to user_id", {
      sub_id: subscriptionObj?.id,
      customer: subscriptionObj?.customer,
      status: subscriptionObj?.status,
    });
    return;
  }

  const status = subscriptionObj?.status || "unknown";
  const periodEnd = isoFromUnixSeconds(subscriptionObj?.current_period_end);
  const paid = isPaidStatus(status);

  const payload = {
    user_id: userId,
    tier: paid ? "paid" : "free",
    is_paid: paid,
    stripe_customer_id: subscriptionObj?.customer || null,
    stripe_subscription_id: subscriptionObj?.id || null,
    stripe_status: status,
    current_period_end: periodEnd,
    updated_at: new Date().toISOString(),
  };

  await upsertEntitlement(sb, payload);
}

/**
 * Resolve userId from an invoice (renewals + failures).
 * - Best: retrieve subscription and read metadata
 * - Fallback: entitlements lookup by subscription_id or customer_id
 */
async function resolveUserIdFromInvoice(sb, invoice) {
  const subscriptionId = invoice?.subscription || null;
  const customerId = invoice?.customer || null;

  if (subscriptionId) {
    // Try the subscription’s metadata first (best)
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const userId = await resolveUserIdFromSubscriptionOrEntitlements(sb, sub);
      if (userId) return { userId, subscriptionId, customerId };
    } catch (e) {
      console.warn("Failed to retrieve subscription for invoice mapping:", e?.message || e);
    }
  }

  // Fallback: direct entitlements lookup
  if (subscriptionId) {
    const { data, error } = await sb
      .from("entitlements")
      .select("user_id")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (!error && data?.user_id) return { userId: data.user_id, subscriptionId, customerId };
  }

  if (customerId) {
    const { data, error } = await sb
      .from("entitlements")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (!error && data?.user_id) return { userId: data.user_id, subscriptionId, customerId };
  }

  return { userId: null, subscriptionId, customerId };
}

export default async function handler(req, res) {
  try {
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
    console.log(`[stripe-webhook] ${event.type} id=${event.id} livemode=${event.livemode}`);

    switch (event.type) {
      // ✅ Primary “checkout finished” hook
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session?.metadata?.supabase_user_id;

        if (!userId) {
          console.error("Missing session.metadata.supabase_user_id; cannot grant access.");
          break;
        }

        await setFromSubscriptionId(sb, userId, session.customer, session.subscription);
        break;
      }

      // ✅ Subscription lifecycle changes
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscriptionObj = event.data.object;
        await setFromSubscriptionObject(sb, subscriptionObj);
        break;
      }

      // ✅ Renewals and failures (keeps entitlements correct long-term)
      case "invoice.paid": {
        const invoice = event.data.object;

        const { userId, subscriptionId, customerId } = await resolveUserIdFromInvoice(sb, invoice);
        if (!userId) {
          console.error("Cannot map invoice.paid to user_id", { subscriptionId, customerId });
          break;
        }

        // Paid invoice generally implies subscription should be active; fetch subscription to be sure.
        await setFromSubscriptionId(sb, userId, customerId, subscriptionId);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;

        const { userId, subscriptionId, customerId } = await resolveUserIdFromInvoice(sb, invoice);
        if (!userId) {
          console.error("Cannot map invoice.payment_failed to user_id", { subscriptionId, customerId });
          break;
        }

        // Fetch subscription to see if it's now past_due/unpaid and update entitlements accordingly
        await setFromSubscriptionId(sb, userId, customerId, subscriptionId);
        break;
      }

      // Optional: helpful for analytics, no entitlement changes
      case "checkout.session.expired":
      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook crashed:", err);
    return res.status(500).json({ error: "Webhook crashed", detail: String(err?.message || err) });
  }
}
