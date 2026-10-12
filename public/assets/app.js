import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, TURNSTILE_SITE_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const $ = (id) => document.getElementById(id);
const els = {
  loading: $("loading"),
  login: $("login-view"),
  app: $("app-view"),
  emailForm: $("email-form"),
  email: $("email"),
  sendBtn: $("send-btn"),
  codeForm: $("code-form"),
  code: $("code"),
  verifyBtn: $("verify-btn"),
  restartBtn: $("restart-btn"),
  error: $("error"),
  userEmail: $("user-email"),
  signoutBtn: $("signout-btn"),
};

let captchaToken = null;
let widgetId = null;
let currentEmail = "";

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = !msg;
}

function updateButtons() {
  els.sendBtn.disabled = !(captchaToken && els.email.value.trim());
  els.verifyBtn.disabled = !/^\d{6}$/.test(els.code.value.trim());
}

function resetCaptcha() {
  captchaToken = null;
  if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
  updateButtons();
}

function renderCaptcha() {
  if (widgetId !== null) return;
  const start = () => {
    widgetId = window.turnstile.render("#captcha", {
      sitekey: TURNSTILE_SITE_KEY,
      action: "login",
      "refresh-expired": "auto",
      callback: (t) => { captchaToken = t; updateButtons(); },
      "expired-callback": () => { captchaToken = null; updateButtons(); },
      "error-callback": () => {
        captchaToken = null;
        updateButtons();
        showError("The security check could not load. Please refresh the page.");
      },
    });
  };
  if (window.turnstile) start();
  else {
    const t = setInterval(() => { if (window.turnstile) { clearInterval(t); start(); } }, 100);
  }
}

function showLogin() {
  els.loading.hidden = true;
  els.app.hidden = true;
  els.login.hidden = false;
  els.emailForm.hidden = false;
  els.codeForm.hidden = true;
  els.code.value = "";
  showError("");
  renderCaptcha();
  updateButtons();
}

function showApp(user) {
  els.loading.hidden = true;
  els.login.hidden = true;
  els.app.hidden = false;
  els.userEmail.textContent = user.email || "";
}

els.email.addEventListener("input", updateButtons);
els.code.addEventListener("input", () => {
  els.code.value = els.code.value.replace(/\D/g, "").slice(0, 6);
  updateButtons();
});

els.emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const email = els.email.value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError("Please enter a valid email address.");
    return;
  }
  els.sendBtn.disabled = true;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, captchaToken },
  });
  resetCaptcha();

  if (error) {
    const code = error.code || "";
    // Problems that are not about whether the email exists are shown.
    if (code === "captcha_failed") {
      showError("The security check failed. Please try again.");
      return;
    }
    if (code.startsWith("over_") || error.status === 429) {
      showError("Too many attempts. Please wait a few minutes and try again.");
      return;
    }
    if (error.name === "AuthRetryableFetchError" || error.status === 0) {
      showError("Could not connect. Please check your connection and try again.");
      return;
    }
    // Anything else (e.g. email not registered) is deliberately treated like
    // success, so the page never reveals which emails are registered.
  }

  currentEmail = email;
  els.emailForm.hidden = true;
  els.codeForm.hidden = false;
  els.code.focus();
  updateButtons();
});

els.codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const token = els.code.value.trim();
  if (!/^\d{6}$/.test(token)) return;
  els.verifyBtn.disabled = true;
  const { data, error } = await supabase.auth.verifyOtp({
    email: currentEmail,
    token,
    type: "email",
    options: captchaToken ? { captchaToken } : undefined,
  });
  resetCaptcha();
  if (error || !data?.user) {
    showError("That code is not valid or has expired. Check the latest email, or start again.");
    updateButtons();
    return;
  }
  showApp(data.user);
});

els.restartBtn.addEventListener("click", () => {
  currentEmail = "";
  els.email.value = "";
  showLogin();
  els.email.focus();
});

els.signoutBtn.addEventListener("click", async () => {
  // Later: also clear any locally stored (unsaved) waste profile drafts here.
  await supabase.auth.signOut();
  els.email.value = "";
  showLogin();
});

const { data: { session } } = await supabase.auth.getSession();
if (session?.user) showApp(session.user);
else showLogin();

supabase.auth.onAuthStateChange((_event, s) => {
  if (!s?.user && !els.app.hidden) showLogin();
});
