# Skill Shelf

A personal shelf of agent skills — the ones I build, collect, and use daily
across Claude Code, Codex, and the agents runtime — plus selected projects.

**Live:** `skill-shelf.pages.dev` (Cloudflare Pages, auto-deploys from
`main`). Design spec:
[`docs/superpowers/specs/2026-08-16-skill-shelf-design.md`](docs/superpowers/specs/2026-08-16-skill-shelf-design.md);
implementation plan: [`plans/v0.1.0-skill-shelf.md`](plans/v0.1.0-skill-shelf.md).

## How it works

- `scripts/sync.mjs` scans my local skill installations (Claude Code, Codex,
  agents) via the plugin manifest and writes `data/generated.json` —
  **personal entries only**; a multi-layer org-content gate (blocklist +
  out-of-repo content denylist + per-run diff review) keeps anything
  work-related out at scan time. The 12 skills installed from
  [mattpocock/skills](https://github.com/mattpocock/skills) collapse into
  one aggregate card.
- `data/overrides.yaml` layers on categories, ≤140-char card copy, repo
  links, showcase images, and manual entries (the superpowers card, the
  herdr project).
- `src/lib/entries.mjs` merges the two at build time; Astro renders a
  single static page — zero client JS, three CSS-only micro-interactions.
- Showcase images live in `src/showcase/` (disclosure-reviewed and
  metadata-stripped before commit) and are optimized by `astro:assets`.
- CI runs `npm test` + `astro build`; Cloudflare Pages rebuilds on every
  push to `main`.

## Commands

| Task | Command |
|------|---------|
| Install | `npm install` |
| Dev server | `npm run dev` |
| Build | `npm run build` |
| Sync inventory (dry-run diff) | `npm run sync` *(this machine only)* |
| Apply sync | `npm run sync -- --write` |
| Tests | `npm test` |
