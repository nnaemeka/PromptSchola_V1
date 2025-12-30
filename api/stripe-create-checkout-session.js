import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    // Verify logged-in user from JWT
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid session" });

    // Plan selection (default monthly)
    const { plan } = req.body || {};
    const normalizedPlan = plan === "yearly" ? "yearly" : "monthly";

    const priceId =
      normalizedPlan === "yearly"
        ? process.env.STRIPE_PRICE_ID_YEARLY
        : process.env.STRIPE_PRICE_ID_MONTHLY;

    if (!priceId) {
      return res.status(500).json({
        error: `Missing Stripe price id env var for ${normalizedPlan}`,
      });
    }

    // Create Stripe Checkout Session (subscription)
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],

      success_url: "https://www.promptschola.com/pricing.html?success=1",
      cancel_url: "https://www.promptschola.com/pricing.html?canceled=1",

      // Link back to Supabase user
      client_reference_id: user.id,
      customer_email: user.email,

      metadata: {
        supabase_user_id: user.id,
        plan: normalizedPlan,
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
}
