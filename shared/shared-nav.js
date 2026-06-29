(() => {
  const fallbackConfig = {
    brand: {
      name: "PromptSchola",
      tagline: "Prompt-based Physics mastery",
      homeHref: "/index.html"
    },
    links: [
      { label: "Home", href: "/index.html" },
      { label: "Physics Curriculum", href: "/physics/physics.html" },
      { label: "How It Works", href: "/index.html#how-it-works" },
      { label: "Pricing", href: "/pricing.html" }
    ],
    auth: {
      signInHref: "/auth.html",
      registerHref: "/auth.html?mode=signup",
      registerLabel: "Register for Free"
    }
  };

  function isCurrentPage(href) {
    if (href.includes("#")) return false;

    const currentPath = window.location.pathname
      .replace(/\/index\.html$/, "/")
      .replace(/\/$/, "");

    const targetPath = href
      .replace(/\/index\.html$/, "/")
      .replace(/\/$/, "");

    return currentPath === targetPath;
  }

  async function getNavConfig() {
    try {
      const response = await fetch("/shared/nav.json", {
        cache: "no-cache"
      });

      if (!response.ok) {
        throw new Error("Could not load nav.json");
      }

      return await response.json();
    } catch (error) {
      console.warn("Using fallback navigation configuration.", error);
      return fallbackConfig;
    }
  }

  async function updateAuthState() {
    const userLabel = document.getElementById("nav-user");
    const loginButton = document.getElementById("nav-login-btn");
    const registerButton = document.getElementById("nav-register-btn");
    const signoutButton = document.getElementById("nav-signout-btn");

    if (typeof window.getCurrentUser !== "function") {
      return;
    }

    try {
      const user = await window.getCurrentUser();

      if (user) {
        if (userLabel) {
          userLabel.textContent = user.email || "";
        }

        if (loginButton) loginButton.style.display = "none";
        if (registerButton) registerButton.style.display = "none";
        if (signoutButton) signoutButton.style.display = "inline-flex";
      } else {
        if (userLabel) userLabel.textContent = "";
        if (loginButton) loginButton.style.display = "inline-flex";
        if (registerButton) registerButton.style.display = "inline-flex";
        if (signoutButton) signoutButton.style.display = "none";
      }
    } catch (error) {
      console.warn("Could not update navigation auth state.", error);
    }
  }

  async function renderNav() {
    const siteHeader = document.getElementById("site-header");

    if (!siteHeader) {
      return;
    }

    const config = await getNavConfig();

    const linksHtml = config.links
      .map((link) => {
        const activeClass = isCurrentPage(link.href) ? "ps-nav-active" : "";

        return `
          <a class="${activeClass}" href="${link.href}">
            ${link.label}
          </a>
        `;
      })
      .join("");

    siteHeader.className = "ps-site-header";

    siteHeader.innerHTML = `
      <div class="ps-nav-inner">
        <a class="ps-nav-brand" href="${config.brand.homeHref}" aria-label="PromptSchola home">
          <span class="ps-nav-logo-mark">P</span>
          <span>
            <span class="ps-nav-brand-name">${config.brand.name}</span>
            <span class="ps-nav-brand-tagline">${config.brand.tagline}</span>
          </span>
        </a>

        <nav class="ps-nav-links" aria-label="Primary navigation">
          ${linksHtml}
        </nav>

        <div class="ps-nav-auth">
          <span id="nav-user"></span>
          <a id="nav-login-btn" href="${config.auth.signInHref}" class="ps-nav-signin">Sign In</a>
          <a id="nav-register-btn" href="${config.auth.registerHref}" class="ps-nav-register">${config.auth.registerLabel}</a>
          <button id="nav-signout-btn" type="button" class="ps-nav-signout" style="display:none;">Sign out</button>
        </div>
      </div>
    `;

    const signoutButton = document.getElementById("nav-signout-btn");

    if (signoutButton) {
      signoutButton.addEventListener("click", () => {
        if (typeof window.signOutUser === "function") {
          window.signOutUser();
        }
      });
    }

    await updateAuthState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderNav, { once: true });
  } else {
    renderNav();
  }
})();