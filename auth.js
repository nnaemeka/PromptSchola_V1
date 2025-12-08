// auth.js
// Shared Supabase client + small helpers for PromptSchola

// IMPORTANT:
// In every HTML page that uses this, you must have:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="auth.js"></script>
// BEFORE any other script that uses `supabaseClient`, isLoggedIn(), etc.

// 1) Configure Supabase – replace with your real values
const SUPABASE_URL = "https://ohaoloyxnduoebyiecah.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYW9sb3l4bmR1b2VieWllY2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5NjAzMTAsImV4cCI6MjA4MDUzNjMxMH0.LZs4YCbxdTN1tpe6nNOvPZ-JrzE2z402hlz1K1OpPmM";

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

// 5) Sign-out: clear Supabase session and go back to homepage
async function signOutUser() {
  try {
    await supabaseClient.auth.signOut();

    // Optional: if you log events
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
  window.location.href = "index.html";
}

// 6) Nav bar helper: show "Hi, Name" / "Signed in as <email>" and toggle buttons
async function updateNavUserDisplay() {
  const navUser     = document.getElementById("nav-user");
  const loginBtn    = document.getElementById("nav-login-btn");
  const registerBtn = document.getElementById("nav-register-btn");
  const signoutBtn  = document.getElementById("nav-signout-btn");

  if (!navUser) {
    // Page has no nav area; nothing to do
    return;
  }

  const user = await getCurrentUser();

  if (!user) {
    // Not logged in
    navUser.textContent = "";

    if (loginBtn)    loginBtn.style.display = "inline-block";
    if (registerBtn) registerBtn.style.display = "inline-block";
    if (signoutBtn)  signoutBtn.style.display = "none";

    return;
  }

  // Logged in: show identity text
  const email    = user.email || "";
  const fullName = user.user_metadata?.full_name || "";
  const displayText = fullName
    ? `Hi, ${fullName}`
    : `Signed in as ${email}`;

  navUser.textContent = displayText;

  // When logged in, hide login/register, show sign out
  if (loginBtn)    loginBtn.style.display = "none";
  if (registerBtn) registerBtn.style.display = "none"; // you can keep this visible if you prefer
  if (signoutBtn)  signoutBtn.style.display = "inline-block";
}

// Run automatically on each page that includes auth.js
document.addEventListener("DOMContentLoaded", updateNavUserDisplay);

// 7) Helper for redirecting to auth on protected actions only
//    (e.g. when clicking "Run with AI")
async function ensureLoggedInOrRedirect() {
  const user = await getCurrentUser();
  if (!user) {
    const redirectTarget = encodeURIComponent(
      window.location.href
    );
    // 🔹 Send them to "Create account" by default, and come back here after auth
    window.location.href = `auth.html?mode=signup&redirect=${redirectTarget}`;
    return null;
  }
  return user;
}

// Expose helpers globally (for use in inline onclick etc.)
window.supabaseClient = supabaseClient;
window.isLoggedIn = isLoggedIn;
window.getCurrentUser = getCurrentUser;
window.updateNavUserDisplay = updateNavUserDisplay;
window.ensureLoggedInOrRedirect = ensureLoggedInOrRedirect;
window.signOutUser = signOutUser;
