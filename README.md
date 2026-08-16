# Skill Shelf

A personal showcase of the Claude/Codex skills I build, collect, and use — plus
selected side projects.

**Status:** design stage. See
[`docs/superpowers/specs/2026-08-16-skill-shelf-design.md`](docs/superpowers/specs/2026-08-16-skill-shelf-design.md)
for the full design.

## How it works

- `scripts/sync.mjs` scans my local skill installations (Claude Code, Codex)
  and writes `data/generated.json`
- `data/overrides.yaml` layers on personal notes, categories, showcase images,
  and manual project entries
- Astro renders the merged data into a static site
- Cloudflare Pages rebuilds on every push to `main`
