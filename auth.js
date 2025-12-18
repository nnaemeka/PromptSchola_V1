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
// ✅ Entitlements lookup from browser (RLS required)
// Caches the result to reduce queries.
// ---------------------------------------------------------------------
const PS_TIER_CACHE_KEY = "ps_cached_tier_v1";
const PS_TIER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function PS_normalizeTier(rawTier, isPaidFlag) {
  const raw = (rawTier ? String(rawTier).toLowerCase() : "") || (isPaidFlag ? "paid" : "free");
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

async function PS_getUserTier(opts = {}) {
  const { forceRefresh = false } = opts;

  // Not logged in → anonymous
  const user = await getCurrentUser();
  if (!user) return "anon";

  if (!forceRefresh) {
    const cached = PS_readTierCache();
    if (cached) return cached;
  }

  try {
    const { data, error } = await supabaseClient
      .from("entitlements")
      .select("tier,is_paid")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.warn("PS_getUserTier entitlements error:", error);
      // Fail-closed to "free" so UI still works
      PS_writeTierCache("free");
      return "free";
    }

    const tier = PS_normalizeTier(data?.tier, data?.is_paid);
    PS_writeTierCache(tier);
    return tier;
  } catch (e) {
    console.warn("PS_getUserTier exception:", e);
    PS_writeTierCache("free");
    return "free";
  }
}

function PS_clearTierCache() {
  try { localStorage.removeItem(PS_TIER_CACHE_KEY); } catch {}
}

// ---------------------------------------------------------------------
// 5) Sign-out: clear Supabase session and go back to homepage
async function signOutUser() {
  try {
    await supabaseClient.auth.signOut();

    if (typeof logEvent === "function") {
      try { await logEvent("sign_out", {}); } catch (e) {}
    }
  } catch (err) {
    console.error("Error signing out:", err);
  }

  // ✅ FIX: always go to root homepage (avoids /physics/index.html 404)
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

// ---------------------------------------------------------------------
// 7) Helper for redirecting to auth on protected actions only
//    (e.g. when clicking "Run with AI")
// ✅ FIX: use same-origin path (preserves #step-x) rather than full URL
// ---------------------------------------------------------------------
async function ensureLoggedInOrRedirect() {
  const user = await getCurrentUser();
  if (!user) {
    // Store safe path+query+hash (same-origin), so auth.html accepts it
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
