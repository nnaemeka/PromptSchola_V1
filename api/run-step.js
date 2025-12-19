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
  return (
    (msg.includes('relation') && msg.includes('entitlements') && msg.includes('does not exist')) ||
    msg.includes('could not find the table') ||
    msg.includes('not found')
  );
}

// ---------------------------------------------------------------------
// ✅ PromptSchola Prompt Validator (v1)
// - Validates prompt CONTENT against your canonical authoring rules (nano)
// - Help mode bypasses step-template validation
// ---------------------------------------------------------------------

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function includesAny(haystack, needles) {
  const h = haystack.toLowerCase();
  return needles.some(n => h.includes(String(n).toLowerCase()));
}

function findDisallowedLatex(prompt) {
  const disallowed = [
    '\\begin{align}', '\\end{align}',
    '\\begin{aligned}', '\\end{aligned}',
    '\\begin{cases}', '\\end{cases}',
    '\\begin{eqnarray}', '\\end{eqnarray}',
    '\\tag{'
  ];
  return disallowed.filter(tok => prompt.includes(tok));
}

function findToneFlags(prompt) {
  const flags = [
    'obviously',
    'clearly',
    'trivial',
    'as you already know',
    'everyone knows',
    "it's obvious",
    'just trust',
    'ai magic',
    'magic',
    'black box',
    'no need to understand'
  ];
  const p = prompt.toLowerCase();
  return flags.filter(f => p.includes(f));
}

function validatePromptContent({ prompt, stepNum }) {
  const errors = [];
  const warnings = [];

  const p = normalizeText(prompt);

  // 1) Audience phrase (required)
  const audiencePhrase = 'final-year high school and first-year university students';
  if (!p.toLowerCase().includes(audiencePhrase)) {
    errors.push(`Missing required audience phrase. Include exactly: "${audiencePhrase}".`);
  }

  // 2) Length sanity
  if (p.length < 80) errors.push('Prompt is too short to be useful (min ~80 characters).');

  // 3) LaTeX constraints
  const latexHits = findDisallowedLatex(prompt);
  if (latexHits.length) {
    errors.push(
      `Disallowed LaTeX environment(s) found: ${latexHits.join(', ')}. Use simple \\[ ... \\] equations only.`
    );
  }

  // 4) Tone warnings
  const toneHits = findToneFlags(prompt);
  if (toneHits.length) {
    warnings.push(
      `Tone warning: found phrase(s) that may reduce learner confidence: ${toneHits.join(', ')}. Consider removing.`
    );
  }

  // 5) Step-specific canonical requirements
  // Step 2: "worked anchor" is helpful, but should not hard-fail (too brittle).
  if (stepNum === 2) {
    const hasWorkedAnchor = includesAny(p, [
      'worked anchor',
      'include one worked anchor',
      'one worked example',
      'one solved example',
      'worked example',
      'worked-out example'
    ]);
    if (!hasWorkedAnchor) {
      warnings.push(
        'Step 2 suggestion: include ONE worked anchor example (optional but recommended).'
      );
    }
  }

  // Step 4 must include "Check Your Understanding" (nano-only)
  if (stepNum === 4) {
    const hasCYU = includesAny(p, [
      'check your understanding',
      'part a — check your understanding',
      'part a - check your understanding',
      'part a: check your understanding'
    ]);
    if (!hasCYU) {
      errors.push('Step 4 must include a "Check Your Understanding" diagnostic section (Part A).');
    }
  }

  // Step 6 should stay exploratory (warning only)
  if (stepNum === 6) {
    const assessmentWords = ['quiz', 'test', 'graded', 'exam', 'score', 'marking scheme'];
    if (includesAny(p, assessmentWords)) {
      warnings.push('Step 6 should remain exploratory. Consider removing quiz/test/exam language.');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Normalize/validate mode without breaking existing callers
function normalizeMode(mode) {
  const m = String(mode || '').toLowerCase().trim();
  if (!m) return 'nano';
  if (m === 'help') return 'help';
  if (m === 'nano') return 'nano';
  return 'nano';
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  try {
    const { prompt, step, mode } = req.body || {};
    const reqMode = normalizeMode(mode);

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

    // ✅ Validate prompt content ONLY for nano mode.
    // Help prompts should not be forced into step-template structure.
    let v = { ok: true, errors: [], warnings: [] };
    if (reqMode !== 'help') {
      v = validatePromptContent({ prompt, stepNum });
      if (!v.ok) {
        return jsonError(res, 400, 'PROMPT_INVALID', 'Prompt failed validation', {
          details: v.errors,
          warnings: v.warnings
        });
      }
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
      return jsonError(
        res,
        401,
        'INVALID_SESSION',
        'Your session is invalid or expired. Please sign in again.'
      );
    }

    // ---- Entitlements: determine tier (FAIL-OPEN) ----
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
    // signed-in free users: Run with AI only for steps 1–2
    // paid users: Run with AI for steps 1–6
    // Help pages will call with step=4 so this stays paid-gated.
    if (!isPaid && stepNum > 2) {
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
              'You are a friendly, rigorous physics tutor for final-year high school and first-year university students. ' +
              'Assume no prior university physics, but do not oversimplify. ' +
              'Always give a complete, correct explanation, but keep answers reasonably concise (about 400–700 words). ' +
              'Use short paragraphs, bullet points where helpful, and clear spacing. ' +
              'When you write equations, use simple LaTeX display math \\[ ... \\], one equation per line. ' +
              'Avoid complex LaTeX environments like align/cases. ' +
              'Never end your response in the middle of a sentence or in the middle of a bold marker.'
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
        mode: reqMode,
        tier,
        isPaid,
        // For help mode we still return warnings array (empty) so callers can rely on it
        promptWarnings: v.warnings || []
      }
    });
  } catch (err) {
    console.error(err);
    return jsonError(res, 500, 'UNEXPECTED', 'Unexpected server error');
  }
}
