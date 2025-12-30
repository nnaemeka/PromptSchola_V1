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

// Try a full upsert (with optional columns). If it fails due to schema mismatch,
// retry with minimal columns that should exist.
async function upsertEntitlementPaid(sb, payload) {
  const first = await sb
    .from("entitlements")
    .upsert(payload, { onConflict: "user_id" });

  if (!first.error) return;

  console.error(
    "❌ Entitlement upsert failed (full payload). Retrying minimal.",
    first.error?.message || first.error
  );

  const minimal = {
    user_id: payload.user_id,
    tier: payload.tier,
  };

  const second = await sb
    .from("entitlements")
    .upsert(minimal, { onConflict: "user_id" });

  if (second.error) {
    console.error(
      "❌ Entitlement upsert failed (minimal payload).",
      second.error?.message || second.error
    );
    throw second.error;
  }
}

export default async function handler(req, res) {
  try {
    // ✅ Allow GET so browser checks don’t crash
    if (req.method === "GET") {
      return res.status(200).send("stripe-webhook alive");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Env checks
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secretKey) {
      return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    }
    if (!webhookSecret) {
      return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET" });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    const rawBody = await readRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error("❌ Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ✅ Always-on debug logs (so you can see the handler is running)
    console.log("✅ Webhook received:", event.type);
    console.log("✅ Event id:", event.id);
    console.log("✅ Livemode:", event.livemode);

    // 🔔 Handle Stripe events
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        console.log("✅ Session:", session.id);
        console.log("✅ Metadata:", session.metadata);

        const userId = session?.metadata?.supabase_user_id; // MUST match Stripe metadata key
        const plan = session?.metadata?.plan || null;

        if (!userId) {
          console.error("❌ Missing metadata.supabase_user_id; cannot grant access.");
          break;
        }

        const sb = getSupabaseAdmin();

        // Full payload (will retry minimal if your entitlements table lacks these columns)
        const payload = {
          user_id: userId,
          tier: "paid",
          is_paid: TRUE,
          plan: plan, // optional if you created it
          stripe_customer_id: session.customer || null, // optional
          stripe_subscription_id: session.subscription || null, // optional
          updated_at: new Date().toISOString(), // optional
        };

        await upsertEntitlementPaid(sb, payload);

        console.log("✅ Entitlement set to paid for user:", userId, "plan:", plan);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook crashed:", err);
    return res.status(500).json({ error: "Webhook crashed", detail: String(err?.message || err) });
  }
}
