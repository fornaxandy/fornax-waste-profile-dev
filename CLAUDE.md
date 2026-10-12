# Project rules for Claude

- **Fornax only.** This repository, its Supabase project and every connected account are for Fornax Ltd (waste incineration) work only. Never connect, use or reference any non-Fornax or private account or project.
- The ERP system is spelled **Tegos** (voice input may produce "Tigo", "Tagos", "TGOS").
- **The live site must not be recognisable as Fornax** at this prototype stage: no Fornax name, logo, colours or contact details anywhere under `public/` (pages, assets, titles, metadata). Repository-only files (this file, README, docs) may mention Fornax.
- **Not discoverable:** keep `robots.txt` (Disallow all), the `noindex` meta tags and the `X-Robots-Tag` header in `public/_headers`. Before login, visitors see only the plain login page.
- **No secrets and no data in this repo.** Only the Supabase URL, the publishable key and the Turnstile site key may appear (all public by design). Service-role keys, the Claude API key, the Turnstile secret and the SMTP password live only in Supabase. Never commit customer data or Fornax reference spreadsheets.
- Every database table has RLS enabled. Test that a logged-out visitor gets nothing back before showing work.
- The full project plan lives outside the repo (Fornax_Portal_Project_Plan.md, kept by Andy). Ask for it if context is missing.
