# Skill Shelf — Design Spec

Date: 2026-08-16
Status: approved in brainstorming; awaiting implementation plan

## Purpose

A public showcase (that doubles as a personal index) of the Claude/Codex skills
Zehui has built, downloaded, and uses — plus selected side projects (e.g. herdr).
References: colaskill.com (marketplace-style grid) and oiloil.org (personal
skills directory). Skill Shelf follows the oiloil positioning: a personal,
curated directory, not a public marketplace.

Site copy is English-primary. Everything in this repo (code, docs, data) is
English.

## Constraints

- Personal project under the ZH-L1N GitHub account. No Exowatt/org content may
  appear in the repo or on the site — filtering happens at scan time so org
  data never lands in git history.
- No server. Pure static output; free-tier hosting.
- Inventory is small (tens of entries) — no database, no search infrastructure.

## Data model

Two layers, merged at build time by slug:

### `data/generated.json` (machine-written, never hand-edited)

Produced by the sync script. Per entry:

- `slug` — kebab-case id, merge key
- `name`, `description` — from SKILL.md frontmatter
- `runtimes` — subset of `["claude", "codex", "agents"]`; the same skill
  installed in multiple runtimes is ONE entry with multiple badges
- `origin` — `personal` (in `~/.claude/skills` or `~/.codex/skills`) or the
  marketplace name (e.g. `claude-plugins-official`, `anthropic-agent-skills`,
  `openai-codex`)

### `data/overrides.yaml` (manual layer)

Keyed by slug; any field here wins over the generated value. Adds:

- `category` — display grouping on the site
- `notes` — personal commentary shown on the card/detail
- `status` — `active` | `trying` | `archived` (entries without an override
  default to `active`)
- `repo` — GitHub URL if the skill/project has one
- `images` — showcase image paths (for image-generating skills such as
  xiaowang-illustration, text-to-lottie, zine/poster skills).
  *Superseded by plans/v0.1.0-skill-shelf.md, Deviation #2: images live under
  `src/showcase/` so `astro:assets` optimizes them; `public/` ships verbatim.*
- `hidden: true` — exclude an entry from the site without deleting data
- Fully manual entries (skills that were never installed locally, and projects
  like herdr) live here too, with `type: project` distinguishing repos/apps
  from skills (default `type: skill`)

## Sync script

`scripts/sync.mjs` (Node — same toolchain as Astro). Local-machine only; CI
never runs it because it reads the user's home directory.

1. Scan `~/.claude/skills/*`, `~/.codex/skills/*`, `~/.agents/skills/*`,
   plus plugin skills. *Superseded by plans/v0.1.0-skill-shelf.md,
   Deviation #1: plugin roots come from
   `~/.claude/plugins/installed_plugins.json` (the authoritative manifest),
   not the raw cache glob — the cache holds multiple unsortable versions.*
2. Parse each SKILL.md frontmatter for name/description
3. Merge cross-runtime duplicates by slug into one entry with combined
   `runtimes`
4. Drop anything matching the org blocklist (the `exowatt-common` marketplace
   and work-related personal skills, e.g. `offline-read-telemetry-policy`);
   the blocklist is a constant in the script
5. Write `data/generated.json` (stable ordering, so diffs stay reviewable)

Workflow: run `npm run sync` after installing/removing skills, review the diff,
fill in overrides for new entries, commit.

## Site structure

Astro static site, zero client JS by default:

- **Index page** — hero (one-line personal intro) + card grid grouped by
  category. Card: name, description, runtime badges, status, repo link,
  showcase thumbnail when images exist.
- **Lightbox / detail** for showcase images (small client-side enhancement,
  added only if a plain `<a>` to the full-size image feels insufficient).
- No search/filter in MVP (tens of entries don't need it); the data model does
  not preclude adding it later.
- Visual design executed with the hallmark skill; target quality bar is
  oiloil.org.

## Repo & deployment

- Public repo `ZH-L1N/skill-shelf`, default branch `main`, direct pushes (solo
  project — no PR ceremony).
- Cloudflare Pages connected to the repo by Zehui in the Cloudflare dashboard
  (one-time manual step, done by the user); every push to `main` auto-builds
  `astro build` and serves `dist/`. Site lives at `skill-shelf.pages.dev`.
- Custom domain: deferred. When wanted, buy via Cloudflare Registrar and attach
  to the Pages project — no code changes required.
- Showcase images are committed to `public/showcase/`, hand-picked from local
  outputs (e.g. `~/.codex/generated_images`). Keep them web-sized (<500 KB
  each) to respect repo hygiene.

## Testing

- Unit tests for sync-script merge/filter/blocklist logic (the only real logic
  in the project)
- CI runs `npm test` + `astro build` as smoke on push
- Nothing else — YAGNI

## Out of scope (explicitly)

- Download counts, popularity metrics, or any marketplace features
- User accounts, comments, analytics beyond whatever Cloudflare provides free
- Auto-publishing skills themselves (the site catalogs; the skills live in
  their own repos)
- i18n framework — English copy is hard-coded
