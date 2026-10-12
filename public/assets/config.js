// Public configuration. These values are designed to be public:
// the publishable key cannot read any data on its own (all tables use RLS),
// and the Turnstile site key only identifies the anti-bot widget.
// NEVER put secret keys (service role, Claude API, Turnstile secret, SMTP) in this file.
export const SUPABASE_URL = "https://wihbibwtuyhgqfbktsok.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Py3nslGxjIU76t0uOO-D4g_dSFYyakK";
export const TURNSTILE_SITE_KEY = "0x4AAAAAAFUZ9lgPwemHlVTI";
