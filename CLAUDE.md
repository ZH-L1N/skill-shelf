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
| Sync local skill inventory | `npm run sync` (local machine only — reads `~/.claude`, `~/.codex`, `~/.agents`) |
| Tests | `npm test` |

(Commands are targets from the design spec; update as they land.)

## Architecture

Astro static site cataloging personally installed Claude/Codex skills and side
projects. Two-layer data model merged at build time:

- `data/generated.json` — produced by `scripts/sync.mjs`, never hand-edited
- `data/overrides.yaml` — manual layer: categories, notes, status, repo links,
  showcase images, and fully manual entries (type: project)

Deploys as pure static output via Cloudflare Pages connected to this repo
(push to `main` → auto build). No server, no backend.

See `docs/superpowers/specs/2026-08-16-skill-shelf-design.md` for the full design.

## Testing Patterns

- Unit tests cover sync-script merge/filter logic only
- `astro build` succeeding in CI is the smoke test
- No test pyramid — this is a content site

## Gotchas

- `npm run sync` only works on Zehui's machine; CI must never run it (it reads `~/.claude` etc.)
- The org blocklist lives in the sync script — extend it before scanning if a new work-related skill appears locally
