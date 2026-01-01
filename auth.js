// auth.js
// Shared Supabase client + small helpers for PromptSchola

// IMPORTANT:
// In every HTML page that uses this, you must have:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/auth.js"></script>
// BEFORE any other script that uses `supabaseClient`, isLoggedIn(), etc.

// 1) Configure Supabase – replace with your real values
const SUPABASE_URL = "https://ohaoloyxnduoebyiecah.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYW9sb3l4bmR1b2VieWllY2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5NjAzMTAsImV4cCI6MjA4MDUzNjMxMH0.LZs4YCbxdTN1tpe6nNOvPZ-JrzE2z402hlz1K1OpPmM";

// 2) Create a single shared client
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------
// 3) Helper: isLoggedIn() → boolean
async function isLoggedIn() {
  try {
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || !data || !data.user) return false;
    return true;
  } catch (e) {
    console.error("isLoggedIn error:", e);
    return false;
  }
}

// 4) Helper: getCurrentUser() → user object or null
async function getCurrentUser() {
  try {
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || !data) return null;
    return data.user || null;
  } catch (e) {
    console.error("getCurrentUser error:", e);
    return null;
  }
}

// ✅ get current access token (for Authorization: Bearer <token>)
async function PS_getAccessToken() {
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) return null;
    return data?.session?.access_token || null;
  } catch (e) {
    console.error("PS_getAccessToken error:", e);
    return null;
  }
}

// ---------------------------------------------------------------------
// ✅ Tier/Entitlements
// Best practice: use server endpoint (/api/get-tier) so RLS doesn't block.
// Cache reduces requests.
// ---------------------------------------------------------------------
const PS_TIER_CACHE_KEY = "ps_cached_tier_v1";
const PS_TIER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function PS_normalizeTier(rawTier, isPaidFlag) {
  const raw =
    (rawTier ? String(rawTier).toLowerCase() : "") ||
    (isPaidFlag ? "paid" : "free");

  const paidTiers = new Set(["paid", "pro", "premium", "mastery"]);
  return paidTiers.has(raw) ? "paid" : "free";
}

function PS_readTierCache() {
  try {
    const txt = localStorage.getItem(PS_TIER_CACHE_KEY);
    if (!txt) return null;
    const obj = JSON.parse(txt);
    if (!obj || !obj.tier || !obj.ts) return null;
    if (Date.now() - obj.ts > PS_TIER_CACHE_TTL_MS) return null;
    return obj.tier;
  } catch {
    return null;
  }
}

function PS_writeTierCache(tier) {
  try {
    localStorage.setItem(PS_TIER_CACHE_KEY, JSON.stringify({ tier, ts: Date.now() }));
  } catch {}
}

function PS_clearTierCache() {
  try { localStorage.removeItem(PS_TIER_CACHE_KEY); } catch {}
}

// ✅ Primary tier fetch: server endpoint
async function PS_fetchTierFromApi() {
  const token = await PS_getAccessToken();
  if (!token) return "anon";

  try {
    const res = await fetch("/api/get-tier", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) return "free";
    const data = await res.json();
    const tier = data?.tier;
    if (tier === "paid" || tier === "free" || tier === "anon") return tier;
    return "free";
  } catch (e) {
    console.warn("PS_fetchTierFromApi error:", e);
    return "free";
  }
}

// (Optional fallback) Browser-table lookup: requires RLS policy to allow reading own row
async function PS_fetchTierFromTable(userId) {
  try {
    const { data, error } = await supabaseClient
      .from("entitlements")
      .select("tier,is_paid")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.warn("PS_fetchTierFromTable entitlements error:", error);
      return "free";
    }

    return PS_normalizeTier(data?.tier, data?.is_paid);
  } catch (e) {
    console.warn("PS_fetchTierFromTable exception:", e);
    return "free";
  }
}

async function PS_getUserTier(opts = {}) {
  const { forceRefresh = false } = opts;

  const user = await getCurrentUser();
  if (!user) return "anon";

  if (!forceRefresh) {
    const cached = PS_readTierCache();
    if (cached) return cached;
  }

  // 1) Prefer server endpoint (no RLS issues)
  const apiTier = await PS_fetchTierFromApi();
  if (apiTier && apiTier !== "anon") {
    PS_writeTierCache(apiTier);
    return apiTier;
  }

  // 2) Fallback to table lookup if API not available
  const tableTier = await PS_fetchTierFromTable(user.id);
  PS_writeTierCache(tableTier);
  return tableTier;
}

// ---------------------------------------------------------------------
// ✅ Lesson progress (client-side read helpers)
// NOTE: For browser reads to work, you need an RLS SELECT policy like:
//   USING (auth.uid() = user_id)
// on public.lesson_progress.
// ---------------------------------------------------------------------
const PS_PROGRESS_CACHE_PREFIX = "ps_lesson_progress_v1:";
const PS_PROGRESS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function PS_progressCacheKey(userId, nanoSlug) {
  return `${PS_PROGRESS_CACHE_PREFIX}${userId}:${String(nanoSlug || "").trim()}`;
}

function PS_readProgressCache(userId, nanoSlug) {
  try {
    const key = PS_progressCacheKey(userId, nanoSlug);
    const txt = localStorage.getItem(key);
    if (!txt) return null;
    const obj = JSON.parse(txt);
    if (!obj || !obj.ts) return null;
    if (Date.now() - obj.ts > PS_PROGRESS_CACHE_TTL_MS) return null;
    return obj.data || null;
  } catch {
    return null;
  }
}

function PS_writeProgressCache(userId, nanoSlug, data) {
  try {
    const key = PS_progressCacheKey(userId, nanoSlug);
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

function PS_clearProgressCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PS_PROGRESS_CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch {}
}

function PS_normalizeProgressRow(row) {
  if (!row) return null;
  return {
    nano_slug: row.nano_slug,
    max_step_completed: Number(row.max_step_completed ?? 0),
    ai_runs_count: Number(row.ai_runs_count ?? 0),
    last_ai_run_step: row.last_ai_run_step == null ? null : Number(row.last_ai_run_step),
    updated_at: row.updated_at || null
  };
}

// ✅ Read ONE nano progress
async function PS_getLessonProgress(nanoSlug, opts = {}) {
  const { forceRefresh = false } = opts;

  const slug = String(nanoSlug || "").trim();
  if (!slug) return null;

  const user = await getCurrentUser();
  if (!user) return null;

  if (!forceRefresh) {
    const cached = PS_readProgressCache(user.id, slug);
    if (cached) return cached;
  }

  try {
    const { data, error } = await supabaseClient
      .from("lesson_progress")
      .select("nano_slug,max_step_completed,ai_runs_count,last_ai_run_step,updated_at")
      .eq("user_id", user.id)
      .eq("nano_slug", slug)
      .maybeSingle();

    if (error) {
      console.warn("PS_getLessonProgress error:", error);
      return null;
    }

    const norm = PS_normalizeProgressRow(data);
    PS_writeProgressCache(user.id, slug, norm);
    return norm;
  } catch (e) {
    console.warn("PS_getLessonProgress exception:", e);
    return null;
  }
}

// ✅ Read MANY nano progress rows in one call (recommended for hubs/track pages)
async function PS_getLessonProgressBatch(nanoSlugs = [], opts = {}) {
  const { forceRefresh = false } = opts;

  const user = await getCurrentUser();
  if (!user) return {};

  const slugs = Array.from(
    new Set(
      (nanoSlugs || [])
        .map(s => String(s || "").trim())
        .filter(Boolean)
    )
  );

  if (!slugs.length) return {};

  // If not forcing refresh, return cached rows where possible (but still fetch missing)
  const out = {};
  const missing = [];

  if (!forceRefresh) {
    for (const s of slugs) {
      const cached = PS_readProgressCache(user.id, s);
      if (cached) out[s] = cached;
      else missing.push(s);
    }
  } else {
    missing.push(...slugs);
  }

  if (!missing.length) return out;

  try {
    const { data, error } = await supabaseClient
      .from("lesson_progress")
      .select("nano_slug,max_step_completed,ai_runs_count,last_ai_run_step,updated_at")
      .eq("user_id", user.id)
      .in("nano_slug", missing);

    if (error) {
      console.warn("PS_getLessonProgressBatch error:", error);
      return out;
    }

    (data || []).forEach(row => {
      const norm = PS_normalizeProgressRow(row);
      if (norm?.nano_slug) {
        out[norm.nano_slug] = norm;
        PS_writeProgressCache(user.id, norm.nano_slug, norm);
      }
    });

    // Ensure every requested slug has an entry in the output (null if absent)
    for (const s of missing) {
      if (!(s in out)) out[s] = null;
    }

    return out;
  } catch (e) {
    console.warn("PS_getLessonProgressBatch exception:", e);
    return out;
  }
}

// ---------------------------------------------------------------------
// 5) Sign-out: clear Supabase session and go back to homepage
async function signOutUser() {
  try {
    await supabaseClient.auth.signOut();
    PS_clearTierCache();
    PS_clearProgressCache();

    if (typeof logEvent === "function") {
      try { await logEvent("sign_out", {}); } catch (e) {}
    }
  } catch (err) {
    console.error("Error signing out:", err);
  }

  // ✅ always go to root homepage
  window.location.href = "/index.html";
}

// 6) Update nav (sign in / register / sign out)
async function updateNavUserDisplay() {
  const userLabel = document.getElementById("nav-user");
  const loginBtn = document.getElementById("nav-login-btn");
  const registerBtn = document.getElementById("nav-register-btn");
  const signoutBtn = document.getElementById("nav-signout-btn");

  const user = await getCurrentUser();

  if (!user) {
    if (userLabel) userLabel.textContent = "";
    if (loginBtn) loginBtn.style.display = "inline-flex";
    if (registerBtn) registerBtn.style.display = "inline-flex";
    if (signoutBtn) signoutBtn.style.display = "none";
    return;
  }

  if (userLabel) userLabel.textContent = `Signed in as ${user.email}`;
  if (loginBtn) loginBtn.style.display = "none";
  if (registerBtn) registerBtn.style.display = "none";
  if (signoutBtn) signoutBtn.style.display = "inline-flex";
}

document.addEventListener("DOMContentLoaded", updateNavUserDisplay);

// Clear caches when auth state changes (prevents "stuck free" + stale progress)
supabaseClient.auth.onAuthStateChange((_event, _session) => {
  PS_clearTierCache();
  PS_clearProgressCache();
});

// ---------------------------------------------------------------------
// 7) Helper for redirecting to auth on protected actions only
// ---------------------------------------------------------------------
async function ensureLoggedInOrRedirect() {
  const user = await getCurrentUser();
  if (!user) {
    const safePath = window.location.pathname + window.location.search + window.location.hash;
    const redirectTarget = encodeURIComponent(safePath);

    window.location.href = `/auth.html?mode=signup&reason=run-ai&redirect=${redirectTarget}`;
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------
// Expose helpers globally
// ---------------------------------------------------------------------
window.supabaseClient = supabaseClient;

window.isLoggedIn = isLoggedIn;
window.getCurrentUser = getCurrentUser;
window.updateNavUserDisplay = updateNavUserDisplay;
window.ensureLoggedInOrRedirect = ensureLoggedInOrRedirect;
window.signOutUser = signOutUser;

window.PS_getAccessToken = PS_getAccessToken;
window.PS_getUserTier = PS_getUserTier;
window.PS_clearTierCache = PS_clearTierCache;

// ✅ NEW exports
window.PS_getLessonProgress = PS_getLessonProgress;
window.PS_getLessonProgressBatch = PS_getLessonProgressBatch;
window.PS_clearProgressCache = PS_clearProgressCache;
