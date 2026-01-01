// /api/track.js
import { createClient } from '@supabase/supabase-js';

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

const USAGE_TIMEZONE = 'America/New_York';
function getNYDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIMEZONE }).format(d);
}

function normalizeNanoSlug(s) {
  const v = String(s || '').trim();
  return v ? v : null;
}

// Allowlist to prevent arbitrary spammy writes
const ALLOWED_EVENTS = new Set([
  'PAGE_VIEW',
  'PROMPT_SHOWN',
  'PROMPT_COPIED',
  'HELP_LOCKED_ATTEMPT',
  'RUN_AI_CLICK_ANON',
  'SIGNUP_CLICK',
  'PRICING_CLICK'
]);

async function ensureRowExists(sb, table, row, onConflict) {
  const { error } = await sb.from(table).upsert(row, { onConflict });
  if (error) throw error;
}

async function incrementDailyMetrics(sb, dateNY, inc) {
  if (!dateNY) return;
  await ensureRowExists(sb, 'daily_metrics', { date: dateNY }, 'date');

  const cols = Object.keys(inc);
  if (!cols.length) return;

  const { data, error: selErr } = await sb
    .from('daily_metrics')
    .select(cols.join(','))
    .eq('date', dateNY)
    .maybeSingle();

  if (selErr) throw selErr;

  const next = {};
  for (const k of cols) next[k] = Number(data?.[k] ?? 0) + Number(inc[k] ?? 0);

  const { error: upErr } = await sb.from('daily_metrics').update(next).eq('date', dateNY);
  if (upErr) throw upErr;
}

async function incrementDailyNanoMetrics(sb, dateNY, nanoSlug, inc) {
  if (!dateNY || !nanoSlug) return;
  await ensureRowExists(sb, 'daily_nano_metrics', { date: dateNY, nano_slug: nanoSlug }, 'date,nano_slug');

  const cols = Object.keys(inc);
  if (!cols.length) return;

  const { data, error: selErr } = await sb
    .from('daily_nano_metrics')
    .select(cols.join(','))
    .eq('date', dateNY)
    .eq('nano_slug', nanoSlug)
    .maybeSingle();

  if (selErr) throw selErr;

  const next = {};
  for (const k of cols) next[k] = Number(data?.[k] ?? 0) + Number(inc[k] ?? 0);

  const { error: upErr } = await sb
    .from('daily_nano_metrics')
    .update(next)
    .eq('date', dateNY)
    .eq('nano_slug', nanoSlug);

  if (upErr) throw upErr;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonError(res, 500, 'SERVER_MISCONFIG', 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    const { event, nano_slug, is_anon } = req.body || {};
    const ev = String(event || '').trim();
    if (!ALLOWED_EVENTS.has(ev)) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Invalid event');
    }

    const nanoSlug = normalizeNanoSlug(nano_slug);
    const isAnon = !!is_anon;
    const dateNY = getNYDateString(new Date());

    const sb = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const dailyInc = {};
    const nanoInc = {};

    if (ev === 'PAGE_VIEW') {
      dailyInc.page_views = 1;
      nanoInc.page_views = 1;
      if (isAnon) {
        dailyInc.page_views_anon = 1;
        nanoInc.page_views_anon = 1;
      }
    }

    if (ev === 'PROMPT_SHOWN') {
      dailyInc.prompt_shown = 1;
      nanoInc.prompt_shown = 1;
    }

    if (ev === 'PROMPT_COPIED') {
      dailyInc.prompt_copied = 1;
      nanoInc.prompt_copied = 1;
    }

    if (ev === 'HELP_LOCKED_ATTEMPT') {
      dailyInc.help_locked_attempts = 1;
      nanoInc.help_locked_attempts = 1;
    }

    if (ev === 'RUN_AI_CLICK_ANON') {
      dailyInc.run_ai_click_anon = 1;
      nanoInc.run_ai_click_anon = 1;
    }

    if (ev === 'SIGNUP_CLICK') dailyInc.signup_clicks = 1;
    if (ev === 'PRICING_CLICK') dailyInc.pricing_clicks = 1;

    // Fail-open: analytics must never break the site
    try {
      await incrementDailyMetrics(sb, dateNY, dailyInc);
      await incrementDailyNanoMetrics(sb, dateNY, nanoSlug, nanoInc);
    } catch (e) {
      console.warn('[track] rollup write warning:', e?.message || e);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonError(res, 500, 'UNEXPECTED', 'Unexpected server error');
  }
}
