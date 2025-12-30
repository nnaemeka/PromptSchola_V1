// /api/stripe-webhook.js
import Stripe from "stripe";

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

    // 🔔 Handle Stripe events
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        console.log("✅ checkout.session.completed", {
          id: session.id,
          customer: session.customer,
          subscription: session.subscription,
        });

        // TODO:
        // - Look up Supabase user by session.metadata.user_id
        // - Mark entitlement as paid
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook crashed:", err);
    return res.status(500).json({ error: "Webhook crashed" });
  }
}
