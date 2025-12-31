// /api/create-portal-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
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

function getOrigin(req) {
  // Vercel sets these
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing SUPABASE_URL");
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Use POST");
    }

    const token = getBearerToken(req);
    if (!token) return jsonError(res, 401, "AUTH_REQUIRED", "Sign in required");

    const supabase = getSupabaseAdmin();

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return jsonError(res, 401, "INVALID_SESSION", "Session expired.");
    }

    const userId = userData.user.id;

    const { data: entRow, error: entErr } = await supabase
      .from("entitlements")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (entErr) {
      console.error("entitlements lookup error:", entErr);
      return jsonError(res, 500, "ENTITLEMENT_LOOKUP_FAILED", "Failed to load entitlement.");
    }

    if (!entRow?.stripe_customer_id) {
      return jsonError(res, 400, "NO_CUSTOMER", "No Stripe customer found for this account.");
    }

    const origin = getOrigin(req);
    const returnUrl = `${origin}/pricing.html?portal=1`;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: entRow.stripe_customer_id,
      return_url: returnUrl,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (e) {
    console.error("create-portal-session error:", e);
    return jsonError(res, 500, "PORTAL_SESSION_FAILED", "Failed to create portal session.");
  }
}
