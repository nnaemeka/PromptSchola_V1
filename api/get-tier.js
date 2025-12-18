// api/get-tier.js
import { createClient } from '@supabase/supabase-js';

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

function normalizeTier(ent) {
  const raw =
    (ent?.tier && String(ent.tier).toLowerCase()) ||
    (ent?.is_paid ? 'paid' : '') ||
    'free';

  const paidTiers = new Set(['paid', 'pro', 'premium', 'mastery']);
  return paidTiers.has(raw) ? 'paid' : 'free';
}

function looksLikeMissingEntitlementsTable(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    (msg.includes('relation') && msg.includes('entitlements') && msg.includes('does not exist')) ||
    msg.includes('could not find the table') ||
    msg.includes('not found')
  );
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  try {
    // ---- Env ----
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonError(
        res,
        500,
        'SERVER_MISCONFIG',
        'Server misconfigured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)'
      );
    }

    // ---- Auth: require a valid Supabase access token ----
    const token = getBearerToken(req);
    if (!token) {
      return jsonError(res, 401, 'AUTH_REQUIRED', 'Sign in required');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    const user = userData?.user;

    if (userErr || !user) {
      return jsonError(
        res,
        401,
        'INVALID_SESSION',
        'Your session is invalid or expired. Please sign in again.'
      );
    }

    // ---- Entitlements (FAIL-OPEN to free) ----
    let tier = 'free';

    try {
      const { data: ent, error: entErr } = await supabaseAdmin
        .from('entitlements')
        .select('tier,is_paid')
        .eq('user_id', user.id)
        .maybeSingle();

      if (entErr) {
        console.warn('get-tier entitlements lookup warning (defaulting to free):', entErr);
        if (looksLikeMissingEntitlementsTable(entErr)) {
          console.warn('Hint: entitlements table may be missing.');
        }
        tier = 'free';
      } else {
        tier = normalizeTier(ent);
      }
    } catch (e) {
      console.warn('get-tier entitlements exception (defaulting to free):', e);
      tier = 'free';
    }

    return res.status(200).json({
      tier,
      isPaid: tier === 'paid'
    });
  } catch (err) {
    console.error(err);
    return jsonError(res, 500, 'UNEXPECTED', 'Unexpected server error');
  }
}
