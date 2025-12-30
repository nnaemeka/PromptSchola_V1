import Stripe from "stripe";
import { buffer } from "micro";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        const userId =
          session.client_reference_id ||
          session.metadata?.supabase_user_id;

        if (!userId) break;

        const subscriptionId = session.subscription;
        const customerId = session.customer;

        // Optional: record chosen plan (monthly/yearly)
        const chosenPlan = session.metadata?.plan || null;

        await supabase
          .from("entitlements")
          .upsert(
            {
              user_id: userId,
              tier: "paid",
              is_paid: true,
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              stripe_status: "active",
              // optional column if you add it later:
              // billing_plan: chosenPlan,
            },
            { onConflict: "user_id" }
          );

        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;

        const { data: rows, error: lookupErr } = await supabase
          .from("entitlements")
          .select("user_id")
          .eq("stripe_subscription_id", sub.id)
          .limit(1);

        if (lookupErr) throw lookupErr;

        const userId = rows?.[0]?.user_id;
        if (!userId) break;

        const isActive = sub.status === "active" || sub.status === "trialing";
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        await supabase
          .from("entitlements")
          .update({
            tier: isActive ? "paid" : "free",
            is_paid: isActive,
            stripe_status: sub.status,
            current_period_end: periodEnd,
          })
          .eq("user_id", userId);

        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("stripe-webhook handler error:", e);
    return res.status(500).send("Webhook handler failed");
  }
}
