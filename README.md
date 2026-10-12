# fornax-waste-profile-dev

Private repository for the customer waste-profile portal prototype (MVP).

## Structure

| Path | Purpose |
|---|---|
| `public/` | Everything served on the website. Plain HTML, CSS and JavaScript, no build step. |
| `public/_headers` | Cloudflare Pages headers: `noindex`, security headers, content security policy. |
| `public/robots.txt` | Blocks all crawlers. |
| `public/assets/config.js` | Public configuration only (Supabase URL, publishable key, Turnstile site key). |
| `CLAUDE.md` | Rules for Claude when working on this repo. |

## Hosting

Cloudflare Pages, connected to this repository.

- **Build command:** none
- **Build output directory:** `public`
- **Production branch:** `main`

## Services

- **Supabase:** database, authentication (6-digit email code, sign-ups disabled), storage, edge functions.
- **Login emails:** Gmail SMTP configured in Supabase.
- **Anti-bot:** Cloudflare Turnstile, verified by Supabase Auth.

## Login

Users enter their email, pass the anti-bot check and receive a 6-digit code if their email is registered. The page shows the same message whether or not the email exists. Only users added by Fornax can log in.
