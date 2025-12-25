// /api/stripe-create-checkout-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20", // ok to keep stable; Stripe will accept the version you set in your account too
});

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const m = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return m ? m[1].trim() : null;
}

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Use POST");

  const token = getBearerToken(req);
  if (!token) return jsonError(res, 401, "AUTH_REQUIRED", "Sign in required");

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // IMPORTANT: service role only on server
  );

  // Validate Supabase session
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return jsonError(res, 401, "INVALID_SESSION", "Session expired. Sign in again.");

  const user = userData.user;
  const email = user.email || undefined;

  // Find or create Stripe customer (store mapping in entitlements)
  const { data: entRow } = await supabase
    .from("entitlements")
    .select("stripe_customer_id,tier")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = entRow?.stripe_customer_id || null;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;

    await supabase.from("entitlements").upsert({
      user_id: user.id,
      tier: "free",
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    });
  }

  const priceId = process.env.STRIPE_PRICE_MASTERY_MONTHLY;
  if (!priceId) return jsonError(res, 500, "CONFIG_MISSING", "Missing STRIPE_PRICE_MASTERY_MONTHLY");

  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

  // Create Checkout Session (subscription)
  // Checkout session creation parameters are per Stripe API reference. :contentReference[oaicite:5]{index=5}
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/pricing.html?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing.html?status=cancel`,
    allow_promotion_codes: true,
    client_reference_id: user.id,
    metadata: { supabase_user_id: user.id },
  });

  return res.status(200).json({ url: session.url });
}

