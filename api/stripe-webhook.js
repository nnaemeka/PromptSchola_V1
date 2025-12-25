// /api/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: false, // IMPORTANT: we need the raw body for signature verification
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");

  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("Missing stripe-signature header");

  const rawBody = await readRawBody(req);

  let event;
  try {
    // Stripe webhook signature verification per docs. :contentReference[oaicite:7]{index=7}
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err?.message);
    return res.status(400).send("Webhook Error");
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        // For subscriptions, session.subscription is set
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const userId = session.metadata?.supabase_user_id || session.client_reference_id;

        if (customerId && subscriptionId && userId) {
          // Fetch subscription to get period end + status
          const sub = await stripe.subscriptions.retrieve(subscriptionId);

          const isActive =
            sub.status === "active" || sub.status === "trialing";

          await supabase.from("entitlements").upsert({
            user_id: userId,
            tier: isActive ? "paid" : "free",
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customerId = sub.customer;
        const subscriptionId = sub.id;

        const isActive =
          sub.status === "active" || sub.status === "trialing";

        // Find the entitlement row by stripe_customer_id
        const { data: row } = await supabase
          .from("entitlements")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();

        if (row?.user_id) {
          await supabase.from("entitlements").upsert({
            user_id: row.user_id,
            tier: isActive ? "paid" : "free",
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }

      default:
        // Keep quiet; you can log during dev
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler failed:", err);
    return res.status(500).send("Webhook handler failed");
  }
}

