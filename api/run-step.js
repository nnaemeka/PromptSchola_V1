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
      warnings.push('Step 2 suggestion: include ONE worked anchor example (optional but recommended).');
    }
  }

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

  if (stepNum === 6) {
    const assessmentWords = ['quiz', 'test', 'graded', 'exam', 'score', 'marking scheme'];
    if (includesAny(p, assessmentWords)) {
      warnings.push('Step 6 should remain exploratory. Consider removing quiz/test/exam language.');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function normalizeMode(mode) {
  const m = String(mode || '').toLowerCase().trim();
  if (!m) return 'nano';
  if (m === 'help') return 'help';
  if (m === 'nano') return 'nano';
  return 'nano';
}

// ---------------------------------------------------------------------
// ✅ Usage metering helpers (Free users)
// ---------------------------------------------------------------------

const USAGE_TIMEZONE = 'America/New_York';

// YYYY-MM-DD in America/New_York
function getNYDateString(d = new Date()) {
  // en-CA gives YYYY-MM-DD formatting
  return new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIMEZONE }).format(d);
}

// next midnight in America/New_York as ISO (best-effort)
function getNextNYMidnightISO() {
  try {
    const now = new Date();
    const todayNY = getNYDateString(now); // YYYY-MM-DD
    const [yy, mm, dd] = todayNY.split('-').map(Number);
    const approxNYMidnightUTC = new Date(Date.UTC(yy, mm - 1, dd, 5, 0, 0)); // ~ midnight NY (UTC-5)
    const next = new Date(approxNYMidnightUTC.getTime() + 24 * 60 * 60 * 1000);
    return next.toISOString();
  } catch {
    return null;
  }
}

function getFreeDailyLimit() {
  const raw = process.env.FREE_AI_DAILY_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function looksLikeMissingUsageTable(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    (msg.includes('relation') && msg.includes('ai_usage') && msg.includes('does not exist')) ||
    (msg.includes('relation') && msg.includes('aiusage') && msg.includes('does not exist')) ||
    msg.includes('could not find the table') ||
    msg.includes('not found')
  );
}

/**
 * Enforce and increment daily AI usage for FREE users.
 * Table expected:
 *   ai_usage(user_id uuid, date date, run_count int, primary key (user_id,date))
 */
async function enforceAndIncrementFreeUsage(sb, userId) {
  const limit = getFreeDailyLimit();
  const dateNY = getNYDateString(new Date());

  const { data: row, error: selErr } = await sb
    .from('ai_usage')
    .select('run_count')
    .eq('user_id', userId)
    .eq('date', dateNY)
    .maybeSingle();

  if (selErr) {
    console.warn('[usage] ai_usage select warning (fail-open):', selErr?.message || selErr);
    if (looksLikeMissingUsageTable(selErr)) console.warn('[usage] Hint: ai_usage table may be missing.');
    return { ok: true, used: null, limit, dateNY, metered: false };
  }

  const used = row?.run_count || 0;

  if (used >= limit) {
    return {
      ok: false,
      used,
      limit,
      dateNY,
      resetsAt: getNextNYMidnightISO(),
      metered: true
    };
  }

  const nextCount = used + 1;

  const { error: upErr } = await sb
    .from('ai_usage')
    .upsert({ user_id: userId, date: dateNY, run_count: nextCount }, { onConflict: 'user_id,date' });

  if (upErr) {
    console.warn('[usage] ai_usage upsert warning (fail-open):', upErr?.message || upErr);
    if (looksLikeMissingUsageTable(upErr)) console.warn('[usage] Hint: ai_usage table may be missing.');
    return { ok: true, used, limit, dateNY, metered: false };
  }

  return { ok: true, used: nextCount, limit, dateNY, metered: true };
}

// ---------------------------------------------------------------------
// ✅ Rollup analytics helpers (Option 2: no raw events)
// Fail-open: never block the request if analytics write fails.
// ---------------------------------------------------------------------

function normalizeNanoSlug(s) {
  const v = String(s || '').trim();
  return v ? v : null;
}

async function ensureRowExists(sb, table, row, onConflict) {
  const { error } = await sb.from(table).upsert(row, { onConflict });
  if (error) throw error;
}

async function incrementRow(sb, table, whereEq, increments, selectCols) {
  const { data, error: selErr } = await sb
    .from(table)
    .select(selectCols)
    .match(whereEq)
    .maybeSingle();

  if (selErr) throw selErr;

  const next = {};
  for (const [k, delta] of Object.entries(increments)) {
    const cur = Number(data?.[k] ?? 0);
    next[k] = cur + Number(delta);
  }

  const { error: upErr } = await sb.from(table).update(next).match(whereEq);
  if (upErr) throw upErr;
}

async function incrementDailyMetrics(sb, dateNY, increments) {
  if (!dateNY) return;
  await ensureRowExists(sb, 'daily_metrics', { date: dateNY }, 'date');

  const cols = Object.keys(increments).join(',');
  if (!cols) return;

  await incrementRow(sb, 'daily_metrics', { date: dateNY }, increments, cols);
}

async function incrementDailyNanoMetrics(sb, dateNY, nanoSlug, increments, stepNumForStepRuns) {
  if (!dateNY || !nanoSlug) return;

  await ensureRowExists(
    sb,
    'daily_nano_metrics',
    { date: dateNY, nano_slug: nanoSlug },
    'date,nano_slug'
  );

  const needStepRuns = Number.isFinite(stepNumForStepRuns);
  const baseCols = Object.keys(increments);
  const cols = needStepRuns ? [...new Set([...baseCols, 'step_runs'])] : baseCols;
  const selectCols = cols.join(',');
  if (!selectCols && !needStepRuns) return;

  const { data, error: selErr } = await sb
    .from('daily_nano_metrics')
    .select(selectCols || 'step_runs')
    .eq('date', dateNY)
    .eq('nano_slug', nanoSlug)
    .maybeSingle();

  if (selErr) throw selErr;

  const next = {};

  for (const [k, delta] of Object.entries(increments)) {
    const cur = Number(data?.[k] ?? 0);
    next[k] = cur + Number(delta);
  }

  if (needStepRuns) {
    const sr = (data?.step_runs && typeof data.step_runs === 'object') ? { ...data.step_runs } : {};
    const key = String(stepNumForStepRuns);
    const cur = Number(sr[key] ?? 0);
    sr[key] = cur + 1;
    next.step_runs = sr;
  }

  const { error: upErr } = await sb
    .from('daily_nano_metrics')
    .update(next)
    .eq('date', dateNY)
    .eq('nano_slug', nanoSlug);

  if (upErr) throw upErr;
}

async function safeTrackRollup(sb, { event, dateNY, nanoSlug, stepNum, isPaid }) {
  try {
    if (event === 'BLOCK_STEP_GATE_FREE') {
      await incrementDailyMetrics(sb, dateNY, { step_blocked_free: 1 });
      await incrementDailyNanoMetrics(
        sb,
        dateNY,
        nanoSlug,
        { blocked_total: 1, blocked_step_gate: 1 },
        null
      );
      return;
    }

    if (event === 'BLOCK_DAILY_LIMIT') {
      await incrementDailyMetrics(sb, dateNY, { daily_limit_blocked: 1 });
      await incrementDailyNanoMetrics(
        sb,
        dateNY,
        nanoSlug,
        { blocked_total: 1, blocked_daily_limit: 1 },
        null
      );
      return;
    }

    if (event === 'AI_RUN_ATTEMPT') {
      await incrementDailyMetrics(sb, dateNY, isPaid ? { ai_runs_paid: 1 } : { ai_runs_free: 1 });
      await incrementDailyNanoMetrics(
        sb,
        dateNY,
        nanoSlug,
        {
          ai_runs_total: 1,
          ...(isPaid ? { ai_runs_paid: 1 } : { ai_runs_free: 1 })
        },
        stepNum
      );
      return;
    }
  } catch (e) {
    console.warn('[analytics] rollup write warning (fail-open):', e?.message || e);
  }
}

// ---------------------------------------------------------------------
// ✅ Lesson progress (writes to public.lesson_progress)
// Fail-open: never block AI response if progress write fails.
// Table:
//   lesson_progress(user_id uuid, nano_slug text, max_step_completed smallint,
//                  ai_runs_count int, last_ai_run_step smallint, updated_at timestamptz)
//   primary key (user_id, nano_slug)
// ---------------------------------------------------------------------

function looksLikeMissingLessonProgressTable(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    (msg.includes('relation') && msg.includes('lesson_progress') && msg.includes('does not exist')) ||
    msg.includes('could not find the table') ||
    msg.includes('not found')
  );
}

async function safeUpdateLessonProgress(sb, { userId, nanoSlug, stepNum }) {
  try {
    if (!userId || !nanoSlug) return null;
    if (!Number.isFinite(stepNum) || stepNum < 1 || stepNum > 6) return null;

    const { data: row, error: selErr } = await sb
      .from('lesson_progress')
      .select('max_step_completed, ai_runs_count')
      .eq('user_id', userId)
      .eq('nano_slug', nanoSlug)
      .maybeSingle();

    if (selErr) {
      console.warn('[progress] lesson_progress select warning (fail-open):', selErr?.message || selErr);
      if (looksLikeMissingLessonProgressTable(selErr)) {
        console.warn('[progress] Hint: lesson_progress table may be missing.');
      }
      return null;
    }

    const curMax = Number(row?.max_step_completed ?? 0);
    const curRuns = Number(row?.ai_runs_count ?? 0);

    const next = {
      user_id: userId,
      nano_slug: nanoSlug,
      max_step_completed: Math.max(curMax, stepNum),
      ai_runs_count: curRuns + 1,
      last_ai_run_step: stepNum,
      updated_at: new Date().toISOString()
    };

    const { error: upErr } = await sb
      .from('lesson_progress')
      .upsert(next, { onConflict: 'user_id,nano_slug' });

    if (upErr) {
      console.warn('[progress] lesson_progress upsert warning (fail-open):', upErr?.message || upErr);
      if (looksLikeMissingLessonProgressTable(upErr)) {
        console.warn('[progress] Hint: lesson_progress table may be missing.');
      }
      return null;
    }

    return {
      nano_slug: nanoSlug,
      max_step_completed: next.max_step_completed,
      ai_runs_count: next.ai_runs_count,
      last_ai_run_step: next.last_ai_run_step
    };
  } catch (e) {
    console.warn('[progress] lesson_progress exception (fail-open):', e?.message || e);
    return null;
  }
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

    // OPTIONAL (for rollups): pass nano_slug from client to attribute per-nano metrics.
    const nanoSlug = normalizeNanoSlug(req.body?.nano_slug || req.body?.nanoSlug || null);

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

    // ---- Entitlements: determine tier (FAIL-OPEN to FREE) ----
    let tier = 'free';

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

    const isPaid = tier === 'paid';
    const dateNY = getNYDateString(new Date());

    // ---- Access rule enforcement ----
    if (!isPaid && stepNum > 2) {
      await safeTrackRollup(supabaseAdmin, {
        event: 'BLOCK_STEP_GATE_FREE',
        dateNY,
        nanoSlug,
        stepNum,
        isPaid
      });

      return jsonError(res, 402, 'PAYWALL', 'This step requires Mastery (paid) access.', {
        required: 'paid',
        current: tier,
        step: stepNum
      });
    }

    // ---- ✅ Usage metering (FREE users only) ----
    let usageMeta = null;

    if (!isPaid) {
      const usage = await enforceAndIncrementFreeUsage(supabaseAdmin, user.id);
      usageMeta = usage;

      if (!usage.ok) {
        await safeTrackRollup(supabaseAdmin, {
          event: 'BLOCK_DAILY_LIMIT',
          dateNY,
          nanoSlug,
          stepNum,
          isPaid
        });

        return jsonError(
          res,
          402,
          'DAILY_LIMIT_REACHED',
          `Daily free AI limit reached (${usage.limit}/day). Upgrade for unlimited access.`,
          {
            tier,
            limit: usage.limit,
            used: usage.used,
            date: usage.dateNY,
            timezone: USAGE_TIMEZONE,
            resetsAt: usage.resetsAt || null
          }
        );
      }
    }

    // ✅ Rollup analytics: record an AI run attempt (after all gating passed)
    await safeTrackRollup(supabaseAdmin, {
      event: 'AI_RUN_ATTEMPT',
      dateNY,
      nanoSlug,
      stepNum,
      isPaid
    });

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
              'Never use Markdown heading syntax. Do not begin any line with #, ##, ###, or any number of # symbols. ' +
              'Use plain-text section labels instead, optionally followed by a colon. ' +
              'For example, write "Every force has a receiver and an agent:" rather than "### Every force has a receiver and an agent". ' +
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

    // ✅ NEW: write lesson progress ONLY for nano mode and when nano_slug is present
    let progress = null;
    if (reqMode !== 'help' && nanoSlug) {
      progress = await safeUpdateLessonProgress(supabaseAdmin, {
        userId: user.id,
        nanoSlug,
        stepNum
      });
    }

    return res.status(200).json({
      content,
      meta: {
        step: stepNum,
        mode: reqMode,
        tier,
        isPaid,
        promptWarnings: v.warnings || [],
        usage: usageMeta, // includes used/limit/dateNY for free users (or null for paid)
        progress // ✅ NEW (may be null if write failed or nanoSlug missing)
      }
    });
  } catch (err) {
    console.error(err);
    return jsonError(res, 500, 'UNEXPECTED', 'Unexpected server error');
  }
}
