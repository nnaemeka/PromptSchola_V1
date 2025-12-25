
// /api/stripe-create-portal-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const m = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return m ? m[1].trim() : null;
}

function jsonError(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Use POST");

  const token = getBearerToken(req);
  if (!token) return jsonError(res, 401, "AUTH_REQUIRED", "Sign in required");

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return jsonError(res, 401, "INVALID_SESSION", "Session expired.");

  const userId = userData.user.id;

  const { data: entRow } = await supabase
    .from("entitlements")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!entRow?.stripe_customer_id) {
    return jsonError(res, 400, "NO_CUSTOMER", "No Stripe customer found for this account.");
  }

  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

  // Portal session creation per Stripe docs. :contentReference[oaicite:9]{index=9}
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: entRow.stripe_customer_id,
    return_url: `${baseUrl}/pricing.html`,
  });

  return res.status(200).json({ url: portalSession.url });
}
