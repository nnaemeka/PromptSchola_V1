// api/run-step.js
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
  // Common PostgREST/Supabase patterns
  return (
    msg.includes('relation') && msg.includes('entitlements') && msg.includes('does not exist')
  ) || msg.includes('could not find the table') || msg.includes('not found');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  try {
    const { prompt, step } = req.body || {};

    // ---- Validate inputs ----
    if (!prompt || typeof prompt !== 'string') {
      return jsonError(res, 400, 'BAD_REQUEST', 'Missing or invalid prompt');
    }

    const stepNum = Number(step);
    if (!Number.isFinite(stepNum) || stepNum < 1 || stepNum > 6) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Missing or invalid step (must be 1–6)');
    }

    if (prompt.length > 12000) {
      return jsonError(res, 413, 'PROMPT_TOO_LARGE', 'Prompt is too long');
    }

    // ---- Env ----
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return jsonError(res, 500, 'SERVER_MISCONFIG', 'Server misconfigured (no DEEPSEEK_API_KEY)');
    }

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
      return jsonError(res, 401, 'AUTH_REQUIRED', 'Sign in required to use Run with AI');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    const user = userData?.user;

    if (userErr || !user) {
      return jsonError(res, 401, 'INVALID_SESSION', 'Your session is invalid or expired. Please sign in again.');
    }

    // ---- Entitlements: determine tier (FAIL-OPEN) ----
    // If anything goes wrong here, default to "free" instead of erroring.
    let tier = 'free';
    let isPaid = false;

    try {
      const { data: ent, error: entErr } = await supabaseAdmin
        .from('entitlements')
        .select('tier,is_paid')
        .eq('user_id', user.id)
        .maybeSingle();

      if (entErr) {
        console.warn('Entitlements lookup warning (defaulting to free):', entErr);

        // If you want, you can surface an internal hint for debugging:
        // - Missing table: create it
        // - RLS/policy issues: but service_role should bypass RLS; so this usually means table missing.
        if (looksLikeMissingEntitlementsTable(entErr)) {
          console.warn('Hint: entitlements table may be missing.');
        }

        tier = 'free';
      } else {
        tier = normalizeTier(ent);
      }
    } catch (e) {
      console.warn('Entitlements exception (defaulting to free):', e);
      tier = 'free';
    }

    isPaid = tier === 'paid';

    // ---- Access rule enforcement ----
    // Rule:
    // - signed-in free users: Run with AI only for steps 1–2
    // - paid users: Run with AI for steps 1–6
    if (!isPaid && stepNum > 2) {
      // Return 402 so front-end can show paywall copy cleanly
      return jsonError(res, 402, 'PAYWALL', 'This step requires Mastery (paid) access.', {
        required: 'paid',
        current: tier,
        step: stepNum
      });
    }

    // ---- Call DeepSeek chat completions ----
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content:
              'You are a friendly, rigorous physics tutor for final high school and first-year university students. ' +
              'Always give a complete, correct explanation, but keep answers reasonably concise (about 400–700 words). ' +
              'Never end your response in the middle of a sentence or in the middle of a bold marker (like starting with ** without closing it). ' +
              'If you are running out of space, finish the current sentence and stop cleanly.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 1600
      })
    });

    if (!dsRes.ok) {
      const errText = await dsRes.text();
      console.error('DeepSeek error:', errText);
      return jsonError(res, 502, 'DEEPSEEK_ERROR', 'Error from DeepSeek API');
    }

    const data = await dsRes.json();
    const content = data.choices?.[0]?.message?.content || '';

    return res.status(200).json({
      content,
      meta: {
        step: stepNum,
        tier,
        isPaid
      }
    });
  } catch (err) {
    console.error(err);
    return jsonError(res, 500, 'UNEXPECTED', 'Unexpected server error');
  }
}
