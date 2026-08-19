# Deploying Skill Shelf

The site is pure static output (`astro build` → `dist/`). Hosting is
Cloudflare Pages connected to this repo; every push to `main` auto-builds
and deploys. The one-time connection is a manual dashboard step performed
by the repo owner.

## One-time: connect Cloudflare Pages (click-path)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Authorize GitHub if prompted, pick **ZH-L1N/skill-shelf**, branch
   **main**.
3. Build settings:
   - Framework preset: **Astro**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Node version: read automatically from the committed `.node-version`
     (24) — no env var needed.
4. **Save and Deploy.** First build takes a couple of minutes; the site
   lands at `skill-shelf.pages.dev`.

Verify: the page renders all cards with images, and a follow-up push to
`main` triggers an automatic redeploy.

## Custom domain (later, optional)

Pages project → **Custom domains** → add the domain (buy via Cloudflare
Registrar if needed) → follow the DNS prompt. No code changes required.

## Troubleshooting

- **Pushes stop deploying** — check the project's Deployments page for a
  yellow "This project is disconnected from your Git account" banner
  (happened 2026-08-18: only the first deploy existed; every later push was
  silently ignored). Fix: Settings → Build → Git repository row → **Manage**
  → re-authorize the Cloudflare Pages GitHub App for ZH-L1N (keep
  skill-shelf selected). Prefer Manage over Disconnect; disconnect/reconnect
  is the fallback and preserves project settings either way. Confirm with a
  fresh push, then curl the live site for a fingerprint of the new commit.
- **Build fails on Cloudflare but CI is green** — open the failing
  deployment's log; the usual suspects are Node-version drift (pinned by
  `.node-version`) or lockfile mismatch.

## Notes

- CI (GitHub Actions) runs `npm test` + `npm run build` on every push;
  Cloudflare builds independently with the same commands.
- `npm run sync` never runs in CI or on Cloudflare — it reads the owner's
  home directory and its denylist gate refuses anywhere else by design.
