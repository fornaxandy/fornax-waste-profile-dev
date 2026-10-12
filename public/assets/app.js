import { supabase, state, $, esc, toast, modal, localCopy, page, hasRole, friendlyError } from "./lib.js";
import { TURNSTILE_SITE_KEY } from "./config.js";
import * as customer from "./views/customer.js";
import * as maq from "./views/maq.js";
import * as quotes from "./views/quotes.js";
import * as messages from "./views/messages.js";
import * as staff from "./views/staff.js";
import * as exporter from "./views/export.js";

// ================================================================ sign-in (email code + Turnstile)
const els = {
  loginWrap: $("#login-wrap"), loading: $("#loading"), login: $("#login-view"), app: $("#app"),
  emailForm: $("#email-form"), email: $("#email"), sendBtn: $("#send-btn"),
  codeForm: $("#code-form"), code: $("#code"), verifyBtn: $("#verify-btn"), restartBtn: $("#restart-btn"),
  error: $("#error"),
};
let captchaToken = null, widgetId = null, currentEmail = "";

const showError = (m) => { els.error.textContent = m; els.error.hidden = !m; };
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
      sitekey: TURNSTILE_SITE_KEY, action: "login", "refresh-expired": "auto",
      callback: (t) => { captchaToken = t; updateButtons(); },
      "expired-callback": () => { captchaToken = null; updateButtons(); },
      "error-callback": () => { captchaToken = null; updateButtons(); showError("The security check could not load. Please refresh the page."); },
    });
  };
  if (window.turnstile) start();
  else { const t = setInterval(() => { if (window.turnstile) { clearInterval(t); start(); } }, 100); }
}
function showLogin() {
  els.loading.hidden = true; els.app.hidden = true; els.loginWrap.hidden = false; els.login.hidden = false;
  els.emailForm.hidden = false; els.codeForm.hidden = true; els.code.value = "";
  document.title = "Sign in";
  const logo = document.getElementById("brand-logo");
  if (logo) { logo.removeAttribute("src"); logo.hidden = true; }
  showError(""); renderCaptcha(); updateButtons();
}

// Logo is stored in the database and only readable after login, so the public site stays unbranded.
async function loadLogo() {
  try {
    const { data } = await supabase.from("app_branding").select("mime_type, data_base64").eq("key", "logo").maybeSingle();
    const img = document.getElementById("brand-logo");
    if (!data || !img) return;
    img.src = `data:${data.mime_type};base64,${data.data_base64}`;
    img.hidden = false;
    document.body.classList.add("has-logo");
  } catch { /* no logo: plain title is shown */ }
}

els.email.addEventListener("input", updateButtons);
els.code.addEventListener("input", () => { els.code.value = els.code.value.replace(/\D/g, "").slice(0, 6); updateButtons(); });

els.emailForm.addEventListener("submit", async (e) => {
  e.preventDefault(); showError("");
  const email = els.email.value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError("Please enter a valid email address."); return; }
  els.sendBtn.disabled = true;
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, captchaToken } });
  resetCaptcha();
  if (error) {
    const code = error.code || "";
    if (code === "captcha_failed") { showError("The security check failed. Please try again."); return; }
    if (code.startsWith("over_") || error.status === 429) { showError("Too many attempts. Please wait a few minutes and try again."); return; }
    if (error.name === "AuthRetryableFetchError" || error.status === 0) { showError("Could not connect. Please check your connection and try again."); return; }
    // Anything else (e.g. unregistered email) is treated like success so the page never reveals who is registered.
  }
  currentEmail = email;
  els.emailForm.hidden = true; els.codeForm.hidden = false; els.code.focus(); updateButtons();
});

els.codeForm.addEventListener("submit", async (e) => {
  e.preventDefault(); showError("");
  const token = els.code.value.trim();
  if (!/^\d{6}$/.test(token)) return;
  els.verifyBtn.disabled = true;
  const { data, error } = await supabase.auth.verifyOtp({
    email: currentEmail, token, type: "email", options: captchaToken ? { captchaToken } : undefined,
  });
  resetCaptcha();
  if (error || !data?.user) { showError("That code is not valid or has expired. Check the latest email, or start again."); updateButtons(); return; }
  await startApp(data.user);
});

els.restartBtn.addEventListener("click", () => { currentEmail = ""; els.email.value = ""; showLogin(); els.email.focus(); });

// ================================================================ app shell
const NAV = {
  customer: [["#/", "Home"], ["#/profiles", "Waste profiles"], ["#/quotes", "Quotes"], ["#/messages", "Messages"], ["#/company", "Company details"]],
  staff: [["#/s/dashboard", "Dashboard"], ["#/s/customers", "Customers"], ["#/s/profiles", "Waste profiles"], ["#/s/quotes", "Quotes"],
          ["#/s/messages", "Messages"], ["#/s/export", "Export to Tegos"]],
  ops: [["#/ops", "Orders"]],
};

function buildNav() {
  const role = state.profile.role;
  let items = role === "customer" ? NAV.customer : role === "ops" ? NAV.ops : NAV.staff.slice();
  if (role === "admin") items = [...items, ["#/s/deleted", "Deleted profiles"]];
  $("#nav").innerHTML = items.map(([h, l]) => `<a href="${h}" data-nav="${h}">${esc(l)}</a>`).join("");
  $("#user-name").textContent = `${state.profile.full_name || state.profile.email}${role !== "customer" ? ` · ${role[0].toUpperCase()}${role.slice(1)}` : ""}`;
}
function highlightNav() {
  const h = location.hash || "#/";
  for (const a of document.querySelectorAll("#nav a")) {
    const n = a.dataset.nav;
    a.classList.toggle("active", n === "#/" ? (h === "#/" || h === "#") : h.startsWith(n) || (n.endsWith("s") && h.startsWith(n.slice(0, -1) + "/")));
  }
}

async function startApp(user) {
  state.user = user;
  const { data: prof, error } = await supabase.from("user_profiles").select("*").eq("user_id", user.id).maybeSingle();
  if (error || !prof || !prof.is_active) {
    await supabase.auth.signOut();
    showLogin();
    showError(error ? friendlyError(error) : "This login is not active. Please contact the person who invited you.");
    return;
  }
  state.profile = prof;
  if (prof.customer_id) {
    const { data: c } = await supabase.from("customers").select("*").eq("id", prof.customer_id).maybeSingle();
    state.customer = c;
  }
  els.loginWrap.hidden = true; els.app.hidden = false;
  loadLogo();
  buildNav();
  if (!location.hash || location.hash === "#") location.hash = prof.role === "customer" ? "#/" : prof.role === "ops" ? "#/ops" : "#/s/dashboard";
  route();
}

// ================================================================ router with "unsaved changes" guard
let currentView = null;   // { beforeLeave?: async () => boolean }
let lastHash = null;
let suppress = false;

const ROUTES = [
  [/^#\/?$/, () => customer.home()],
  [/^#\/profiles(?:\?tab=(\w+))?$/, (m) => customer.profiles(m[1] || "all")],
  [/^#\/profile\/([\w-]+)$/, (m) => maq.open(m[1])],
  [/^#\/quotes$/, () => quotes.customerList()],
  [/^#\/quote\/([\w-]+)$/, (m) => quotes.customerView(m[1])],
  [/^#\/messages$/, () => messages.list()],
  [/^#\/thread\/([\w-]+)$/, (m) => messages.thread(m[1])],
  [/^#\/company$/, () => customer.company()],
  [/^#\/s\/dashboard$/, () => staff.dashboard()],
  [/^#\/s\/customers$/, () => staff.customers()],
  [/^#\/s\/customer\/([\w-]+)$/, (m) => staff.customerDetail(m[1])],
  [/^#\/s\/profiles(?:\?status=(\w+))?$/, (m) => staff.profiles(m[1] || "pending_approval")],
  [/^#\/s\/profile\/([\w-]+)$/, (m) => maq.open(m[1])],
  [/^#\/s\/quotes(?:\?status=(\w+))?$/, (m) => quotes.staffList(m[1] || "all")],
  [/^#\/s\/quote\/([\w-]+)$/, (m) => quotes.staffEdit(m[1])],
  [/^#\/s\/messages$/, () => messages.list()],
  [/^#\/s\/thread\/([\w-]+)$/, (m) => messages.thread(m[1])],
  [/^#\/s\/export$/, () => exporter.view()],
  [/^#\/s\/deleted$/, () => staff.deleted()],
  [/^#\/ops$/, () => staff.ops()],
];

const ALLOWED = {
  customer: (h) => !h.startsWith("#/s/") && h !== "#/ops",
  ops: (h) => h === "#/ops",
  staff: (h) => h.startsWith("#/s/"),
};

async function route() {
  if (suppress) { suppress = false; return; }
  const hash = location.hash || "#/";
  if (currentView?.beforeLeave && lastHash !== null && hash !== lastHash) {
    const ok = await currentView.beforeLeave();
    if (!ok) { suppress = true; location.hash = lastHash; return; }
  }
  const role = state.profile.role;
  const kind = role === "customer" ? "customer" : role === "ops" ? "ops" : "staff";
  if (!ALLOWED[kind](hash)) {
    location.hash = kind === "customer" ? "#/" : kind === "ops" ? "#/ops" : "#/s/dashboard";
    return;
  }
  lastHash = hash;
  highlightNav();
  document.getElementById("nav").classList.remove("open");
  currentView = null;
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      try { currentView = (await fn(m)) || null; }
      catch (err) { console.error(err); page(`<p class="error">${esc(friendlyError(err))}</p>`); }
      return;
    }
  }
  page(`<h1>Page not found</h1><p><a href="#/">Go to the start page</a></p>`);
}
window.addEventListener("hashchange", route);

$("#menu-btn").addEventListener("click", () => {
  const nav = $("#nav"); const open = !nav.classList.contains("open");
  nav.classList.toggle("open", open); $("#menu-btn").setAttribute("aria-expanded", String(open));
});

// ================================================================ sign out: offer to save, then wipe this computer's copies
$("#signout-btn").addEventListener("click", async () => {
  if (currentView?.beforeLogout) {
    const ok = await currentView.beforeLogout();
    if (!ok) return;
  }
  localCopy.clearAllForUser();
  await supabase.auth.signOut();
  state.user = state.profile = state.customer = null;
  currentView = null; lastHash = null;
  history.replaceState(null, "", location.pathname);
  els.email.value = "";
  showLogin();
});

// ================================================================ boot
const { data: { session } } = await supabase.auth.getSession();
if (session?.user) await startApp(session.user); else showLogin();
supabase.auth.onAuthStateChange((event, s) => {
  if (event === "SIGNED_OUT" && !els.app.hidden) { toast("You have been signed out."); showLogin(); }
});
export { hasRole, modal };
