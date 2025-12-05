// auth.js
// Shared Supabase client + small helpers for PromptSchola

// IMPORTANT:
// In every HTML page that uses this, you must have:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="auth.js"></script>
// BEFORE any other script that uses `supabaseClient`, isLoggedIn(), etc.

// 1) Configure Supabase – replace with your real values
const SUPABASE_URL = "https://ohaoloyxnduoebyiecah.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYW9sb3l4bmR1b2VieWllY2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5NjAzMTAsImV4cCI6MjA4MDUzNjMxMH0.LZs4YCbxdTN1tpe6nNOvPZ-JrzE2z402hlz1K1OpPmM";

// 2) Create a single shared client
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

// 5) Nav bar helper: show "Signed in as <email>" if logged in
async function updateNavUserDisplay() {
  const el = document.getElementById("nav-user");
  if (!el) return; // page simply doesn't have this placeholder

  const user = await getCurrentUser();
  if (!user) {
    el.textContent = ""; // or "Not signed in"
    return;
  }
  el.textContent = `Signed in as ${user.email}`;
}

// Run automatically on each page that includes auth.js
document.addEventListener("DOMContentLoaded", updateNavUserDisplay);

// 6) Helper for redirecting to auth on protected actions
async function ensureLoggedInOrRedirect() {
  const user = await getCurrentUser();
  if (!user) {
    const redirectTarget = encodeURIComponent(
      window.location.pathname + window.location.search + window.location.hash
    );
    window.location.href = `auth.html?redirect=${redirectTarget}`;
    return null;
  }
  return user;
}

// Expose helpers globally (optional, but convenient)
window.supabaseClient = supabaseClient;
window.isLoggedIn = isLoggedIn;
window.getCurrentUser = getCurrentUser;
window.updateNavUserDisplay = updateNavUserDisplay;
window.ensureLoggedInOrRedirect = ensureLoggedInOrRedirect;
