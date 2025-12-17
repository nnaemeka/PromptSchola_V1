// auth.js
// Shared Supabase client + helpers for PromptSchola

// IMPORTANT:
// In every HTML page that uses this, you must have:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/auth.js"></script>
// BEFORE any other script that uses `supabaseClient`, getCurrentUser(), etc.

// 1) Configure Supabase – replace with your real values
const SUPABASE_URL = "https://ohaoloyxnduoebyiecah.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYW9sb3l4bmR1b2VieWllY2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5NjAzMTAsImV4cCI6MjA4MDUzNjMxMH0.LZs4YCbxdTN1tpe6nNOvPZ-JrzE2z402hlz1K1OpPmM";

// 2) Create a single shared client
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------
// Redirect helpers (send people back to the page they came from)
// ---------------------------------------------------------------------
const PS_POST_AUTH_REDIRECT_KEY = "ps_post_auth_redirect";

// Store a safe internal path (not full URL)
function PS_currentInternalPath() {
  try {
    const path = window.location.pathname || "/";
    const search = window.location.search || "";
    const hash = window.location.hash || "";
    return path + search + hash;
  } catch (e) {
    return "/index.html";
  }
}

function PS_setPostAuthRedirect(pathOverride) {
  try {
    const target = (typeof pathOverride === "string" && pathOverride.trim())
      ? pathOverride.trim()
      : PS_currentInternalPath();

    // Basic safety: only store internal routes
    if (!target.startsWith("/")) return;

    localStorage.setItem(PS_POST_AUTH_REDIRECT_KEY, target);
  } catch (e) {}
}

function PS_getPostAuthRedirect(fallback = "/index.html") {
  try {
    const t = localStorage.getItem(PS_POST_AUTH_REDIRECT_KEY);
    if (t && typeof t === "string" && t.startsWith("/") && t.length < 300) return t;
    return fallback;
  } catch (e) {
    return fallback;
  }
}

// ---------------------------------------------------------------------
// Session / user helpers
// ---------------------------------------------------------------------

// isLoggedIn() → boolean
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

// getCurrentUser() → user object or null
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

// PS_getAccessToken() → access token string or null
async function PS_getAccessToken() {
  try {
    const { data } = await supabaseClient.auth.getSession();
    const token = data?.session?.access_token || null;
    return token;
  } catch (e) {
    console.error("PS_getAccessToken error:", e);
    return null;
  }
}

// ---------------------------------------------------------------------
// Tier / entitlements helpers
// Requires a table like:
// entitlements: user_id (uuid, pk), tier ('free'|'paid'), updated_at
// with RLS allowing users to read their own row.
// ---------------------------------------------------------------------

const PS_TIER_CACHE_KEY = "ps_cached_tier_v1";
const PS_TIER_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function PS_readTierCache() {
  try {
    const raw = localStorage.getItem(PS_TIER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.tier || !parsed.ts) return null;
    if (Date.now() - parsed.ts > PS_TIER_CACHE_TTL_MS) return null;
    return String(parsed.tier);
  } catch (e) {
    return null;
  }
}

function PS_writeTierCache(tier) {
  try {
    localStorage.setItem(PS_TIER_CACHE_KEY, JSON.stringify({ tier, ts: Date.now() }));
  } catch (e) {}
}

// PS_getUserTier() → 'paid' | 'free'
async function PS_getUserTier() {
  const cached = PS_readTierCache();
  if (cached === "paid" || cached === "free") return cached;

  const user = await getCurrentUser();
  if (!user) return "free";

  try {
    const { data, error } = await supabaseClient
      .from("entitlements")
      .select("tier,is_paid")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      // If table/RLS isn't ready yet, default to free (safe)
      console.warn("PS_getUserTier entitlements error:", error);
      return "free";
    }

    const tier =
      (data?.tier && String(data.tier).toLowerCase()) ||
      (data?.is_paid ? "paid" : "free") ||
      "free";

    const normalized = tier === "paid" ? "paid" : "free";
    PS_writeTierCache(normalized);
    return normalized;
  } catch (e) {
    console.warn("PS_getUserTier error:", e);
    return "free";
  }
}

async function PS_isPaidUser() {
  const tier = await PS_getUserTier();
  return tier === "paid";
}

// ---------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------
async function signOutUser() {
  try {
    await supabaseClient.auth.signOut();

    if (typeof logEvent === "function") {
      try {
        await logEvent("sign_out", {});
      } catch (e) {
        console.warn("Failed to log sign_out event", e);
      }
    }
  } catch (err) {
    console.error("Error signing out:", err);
  }

  // After logout, send them to homepage
  window.location.href = "/index.html";
}

// ---------------------------------------------------------------------
// Nav updates (sign in / register / sign out)
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Protected action helper: redirect to auth when not logged in
// (also stores localStorage redirect + passes ?redirect= for auth.html)
// ---------------------------------------------------------------------
async function ensureLoggedInOrRedirect(reason = "run-ai") {
  const user = await getCurrentUser();
  if (!user) {
    const internalPath = PS_currentInternalPath();
    PS_setPostAuthRedirect(internalPath);

    const redirectTarget = encodeURIComponent(internalPath);

    // Always send them to SIGN IN first for protected actions
    window.location.href = `/auth.html?mode=signin&reason=${encodeURIComponent(
      reason
    )}&redirect=${redirectTarget}`;

    return null;
  }
  return user;
}

// ---------------------------------------------------------------------
// Auto-wire Sign In/Register links to remember where they came from.
// If the page has #nav-login-btn/#nav-register-btn, we store redirect on click.
// ---------------------------------------------------------------------
function PS_wireAuthLinks() {
  try {
    const loginBtn = document.getElementById("nav-login-btn");
    const registerBtn = document.getElementById("nav-register-btn");

    const wire = (el) => {
      if (!el) return;
      el.addEventListener("click", () => {
        PS_setPostAuthRedirect();
      });
    };

    wire(loginBtn);
    wire(registerBtn);
  } catch (e) {}
}

// Run automatically on each page that includes auth.js
document.addEventListener("DOMContentLoaded", () => {
  updateNavUserDisplay();
  PS_wireAuthLinks();
});

// Expose helpers globally
window.supabaseClient = supabaseClient;

window.isLoggedIn = isLoggedIn;
window.getCurrentUser = getCurrentUser;
window.updateNavUserDisplay = updateNavUserDisplay;
window.signOutUser = signOutUser;

window.ensureLoggedInOrRedirect = ensureLoggedInOrRedirect;

window.PS_getAccessToken = PS_getAccessToken;
window.PS_getUserTier = PS_getUserTier;
window.PS_isPaidUser = PS_isPaidUser;

window.PS_setPostAuthRedirect = PS_setPostAuthRedirect;
window.PS_getPostAuthRedirect = PS_getPostAuthRedirect;
