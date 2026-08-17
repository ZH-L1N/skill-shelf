# CLAUDE.md

Personal project of Zehui (ZH-L1N). No Exowatt / org content may ever enter this
repo — the sync script's blocklist enforces this at scan time; keep it that way.

## Workflow

### Before starting work
- Always enter plan mode to make a plan
- After getting the plan, write it to `plans/TASK_NAME.md`
- The plan should be a detailed implementation plan with reasoning and broken-down tasks
- If the task requires external knowledge or a certain package, research to get latest knowledge (use Task tool for research)
- Don't over-plan — always think MVP
- Once the plan is written, ask for review first. Do not continue until approved.

Design specs (the what/why) live in `docs/superpowers/specs/`; plans (the how)
live in `plans/`. Adversarial-review fix logs go in `plans/fixs/`.

## Commands

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Dev server | `npm run dev` |
| Build | `npm run build` |
| Sync inventory, dry-run diff | `npm run sync` (this machine only — reads `~/.claude`, `~/.codex`, `~/.agents`) |
| Apply sync | `npm run sync -- --write` (review the dry-run diff first, every time) |
| Sync to another path | `npm run sync -- --write --out <path>` (write target only; previous state + `.last-sync` stay on the canonical file) |
| Tests | `npm test` (node:test — inventory, sync CLI, merge layer) |

## Architecture

Astro 7 static site cataloging personally installed skills and side projects.
Two-layer data model merged at build time by `src/lib/entries.mjs`
(`loadCatalog` → `mergeCatalog`):

- `data/generated.json` — written by `scripts/sync.mjs`, never hand-edited.
  **Personal entries only** (marketplace skills are scanned and gated but not
  published); the 12 mattpocock/skills installs collapse into one
  `matt-pocock-skills` aggregate (`AGGREGATE_GROUPS` in
  `scripts/lib/inventory.mjs`).
- `data/overrides.yaml` — manual layer, two namespaces: `skills:` (category,
  ≤140-char card copy, repo, images, `manual: true` cards) and `projects:`.
- `src/showcase/` — committed card images, optimized via `astro:assets`.
- `src/pages/index.astro` owns the whole design system (variant-B tokens);
  components render purely from catalog data. Client JS is exactly ONE
  sanctioned inline script — the `<dialog>` lightbox (enlarge in place,
  click-anywhere/Esc dismiss, degrades to plain image links without JS);
  the three approved micro-interactions are CSS-only.

Deploys as pure static output via Cloudflare Pages connected to this repo
(push to `main` → auto build; see `docs/deploy.md`). No server, no backend.

See `docs/superpowers/specs/2026-08-16-skill-shelf-design.md` for the design
and `plans/v0.1.0-skill-shelf.md` for the implemented plan.

## Testing Patterns

- Unit tests cover the sync pipeline (pure functions + CLI via injected
  roots) and the merge layer, including real-data assertions over the
  committed `data/` files
- `astro build` succeeding in CI is the smoke test
- No test pyramid — this is a content site

## Gotchas

- `npm run sync` only works on Zehui's machine; CI must never run it (it reads `~/.claude` etc., and its denylist gate refuses elsewhere by design)
- The org blocklist lives in `scripts/lib/inventory.mjs` (`BLOCKLIST`, pattern-matched marketplaces + exact slugs) — extend it before scanning if a new work-related skill appears locally; a committed test pins its contents
- The content denylist lives at `~/.config/skill-shelf/denylist.txt` (outside the repo; path overridable via `SKILL_SHELF_DENYLIST`). Its terms must never be committed anywhere — never bring `~/.config/skill-shelf/` under version control. Loss-recovery was explicitly waived by the owner (2026-08-16): no reference copy exists by choice; if the machine is rebuilt the list is retyped from memory
- Editing the denylist: `.last-sync` (sha256, written only on canonical `--write`) makes sync print a changed-since-last-sync reminder until applied
- Any image added to `src/showcase/` gets a disclosure review (no terminal/editor content, window titles, notification banners, unrelated tabs; tight crops preferred; herdr-style screenshots are highest-risk) and a metadata strip BEFORE its `images:` key is added and before any commit — git history preserves originals. Strip tool on this machine: `sips` re-encode + format-level chunk/segment filtering (exiftool/ImageMagick not installed)
- The favicon's oklch literal in `src/pages/index.astro` must mirror `--color-accent` (data URIs can't reference CSS vars) — change both together
