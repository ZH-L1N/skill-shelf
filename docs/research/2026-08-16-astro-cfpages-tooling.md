# Research: Astro + Cloudflare + Node tooling for skill-shelf

Date: 2026-08-16
Audience: author of the skill-shelf implementation plan
Method: primary sources only (npm registry, official docs, upgrade guides, Node
API docs, GitHub release metadata). Local env verified: Node v24.15.0, npm 11.12.1.

> **Headline delta vs the design spec:** the spec assumes Astro v5 and Cloudflare
> Pages. Astro is at **v7** (two majors of breaking changes), and Cloudflare's
> official recommendation for **new** projects is **Workers static assets**, not
> Pages. Neither is a blocker; both change concrete steps. Details below, marked
> **[spec impact]**.

---

## 1. Astro

### 1.1 Current version

| Fact | Value | Source |
|---|---|---|
| Latest stable `astro` | **7.2.2**, published 2026-08-13 | `npm view astro version` / <https://registry.npmjs.org/astro/latest> |
| `engines` | `node >=22.12.0`, `npm >=9.6.5` | <https://registry.npmjs.org/astro/7.2.2> |
| Major release dates | 5.0.0 → 2024-12-03, 6.0.0 → 2026-03-10, 7.0.0 → 2026-06-22 | `npm view astro time --json` |
| `create-astro` | 5.2.3 | `npm view create-astro version` |

Local Node v24.15.0 satisfies `>=22.12.0`. No version pin problems.

### 1.2 Breaking changes since v5 that matter for a minimal static content site

**Astro v6** (<https://docs.astro.build/en/guides/upgrade-to/v6/>):

- **Node 18 and 20 dropped**; minimum is Node 22.12.0.
- **Legacy content collections removed entirely.** The `legacy.collections` flag
  is gone. Every collection now *requires* a `loader`; `type: 'content' | 'data'`
  is removed; `entry.slug` → `entry.id`; `entry.render()` → `render(entry)`;
  `getEntryBySlug()` / `getDataEntryById()` → `getEntry()`. Any v5-era tutorial
  code for content collections is wrong now.
- **Zod 3 → Zod 4** for collection schemas.
- **`astro:assets`**: cropping applies automatically with `width` + `height`
  (no more `fit: "contain"` dance); the default image service **never upscales**;
  `getImage()` called from the client now throws.
- `import.meta.env` values are always inlined and never type-coerced.
- `<script>` / `<style>` render in declaration order (the `preserveScriptOrder`
  experimental flag is gone).
- Markdown heading IDs no longer strip trailing hyphens.
- Endpoints with a file extension (e.g. `/sitemap.xml`) are only reachable
  *without* a trailing slash, regardless of `build.trailingSlash`.

**Astro v7** (<https://docs.astro.build/en/guides/upgrade-to/v7/>,
<https://astro.build/blog/astro-7/>):

- **Vite 8.**
- **Rust compiler is now the default.** It is stricter: *"Unclosed tags now
  produce errors"*, invalid HTML nesting is no longer auto-corrected (passed
  through as-is), and CSS serialization differs (color names → hex, `url()`
  quoting). Hand-written `.astro` markup must be well-formed.
- **`compressHTML` default changed from `true` to `'jsx'`.** Whitespace between
  inline elements now follows JSX rules: `<span>hello</span><em>world</em>`
  renders as `helloworld`, not `hello world`. **[spec impact]** relevant to the
  card's runtime-badge row — put explicit spaces/gaps in, or set
  `compressHTML: true` in config.
- **Sätteri replaces remark/rehype** as the default Markdown processor
  (confirmed by the `@astrojs/markdown-satteri` dependency in astro 7.2.2).
  Install `@astrojs/markdown-remark` only if remark/rehype plugins are needed.
  Not needed here — the site renders no Markdown.
- `src/fetch.ts` is a reserved filename (advanced routing).
- Experimental flags stabilized/removed: `rustCompiler`, `advancedRouting`,
  `queuedRendering`, `logger`; `cache` and `routeRules` moved to top-level config.
- `@astrojs/db` removed from the project entirely.

**Unchanged and still true** (<https://docs.astro.build/en/reference/configuration-reference/>):

- `output` type `'static' | 'server'`, **default `'static'`**.
- **No adapter is required for a fully static site.**
- `build.format` default `'directory'`.

### 1.3 Scaffold

`create-astro` flags, verbatim from
<https://github.com/withastro/astro/blob/main/packages/create-astro/README.md>:
`--help/-h`, `--template <name>`, `--install` / `--no-install`, `--add <integrations>`,
`--git` / `--no-git`, `--no-ai` ("Skip creating AI agent files"), `--yes/-y`,
`--no/-n`, `--dry-run`, `--skip-houston`, `--ref`, `--fancy`.

Official example templates (live listing of
<https://github.com/withastro/astro/tree/main/examples>): `minimal`, `basics`,
`blog`, `portfolio`, `starlog`, `with-tailwindcss`, `with-vitest`,
`container-with-vitest`, `with-mdx`, `framework-*`, `ssr`, `advanced-routing`, …

Recommended invocation for this repo (which already has git history, CLAUDE.md
and a docs tree — hence `--no-git --no-ai`):

```sh
npm create astro@latest . -- --template minimal --install --no-git --no-ai --skip-houston
```

`minimal` is the empty-page starter; `basics` adds a demo layout/component you'd
delete anyway.

### 1.4 Loading + merging `generated.json` and `overrides.yaml`

Two documented approaches.

**A. Plain build-time read in the component script.**
- JSON: `import` is built in — *"Astro supports importing JSON files directly
  into your application. Imported files return the full JSON object in the
  default import."* (<https://docs.astro.build/en/guides/imports/>)
- YAML: **not supported natively.** The supported-imports list has no `.yaml`/
  `.yml`; extending it requires a Vite/Rollup plugin. Simpler: read the file with
  `node:fs` and parse it (see §3.2).
- Safe to do so: the component script *"won't escape into your frontend
  application, or fall into your user's hands"* and may do work that is
  "expensive or sensitive" — it runs on the server / at build time, never in the
  browser (<https://docs.astro.build/en/basics/astro-components/>).

**B. Content Layer `file()` loader.**
- `file(fileName: string, options?: FileOptions) => Loader`; parses **JSON, YAML
  and TOML natively**; a `parser` callback covers other formats and may return
  `Record<string, Record<string, unknown>> | Array<Record<string, unknown>>` —
  i.e. an object keyed by id works, which matches `overrides.yaml`'s
  slug-keyed shape (<https://docs.astro.build/en/reference/content-loader-reference/>).
- Config lives at `src/content.config.ts` (`.js`/`.mjs` also accepted); array-shaped
  files need a unique `id` per entry
  (<https://docs.astro.build/en/guides/content-collections/>).

**Recommendation: A.** Two files merging into one card list is a *merge*, not two
content sets: option B would mean a content config, two `defineCollection`s, two
Zod schemas, two `await getCollection()` calls, and *then* the same merge code —
for a single page. Option A puts the whole thing in one pure function that the
sync-script unit tests already cover (§4). Keep B in the back pocket: its one
real advantage is Zod-validating the hand-edited `overrides.yaml`, worth
revisiting if typo'd override keys start silently disappearing.

Minimal recommended code:

```js
// src/lib/catalog.mjs  — pure, unit-testable, no Astro imports
export function mergeCatalog(generated, overrides) {
  const bySlug = new Map(generated.map((e) => [e.slug, { type: 'skill', status: 'active', ...e }]));
  for (const [slug, ov] of Object.entries(overrides ?? {})) {
    bySlug.set(slug, { type: 'skill', status: 'active', slug, ...bySlug.get(slug), ...ov });
  }
  return [...bySlug.values()].filter((e) => !e.hidden).sort((a, b) => a.slug.localeCompare(b.slug));
}
```

```astro
---
// src/pages/index.astro
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import generated from '../../data/generated.json';
import { mergeCatalog } from '../lib/catalog.mjs';

const overrides = parse(readFileSync(new URL('../../data/overrides.yaml', import.meta.url), 'utf8'));
const entries = mergeCatalog(generated, overrides);
---
```

Note `data/` sits outside `src/`, so the YAML file is not a Vite module and will
not trigger HMR on edit — a `npm run dev` restart is needed after editing
overrides. Acceptable for a manual data layer; if it grates, move
`overrides.yaml` into `src/data/` and switch to the `file()` loader.

### 1.5 `astro:assets` for showcase thumbnails

- *"We recommend that local images are kept in `src/` when possible so that Astro
  can transform, optimize, and bundle them."* Files in `public/` are *"served or
  copied into the build folder as-is, with no processing"*
  (<https://docs.astro.build/en/guides/images/>).
- `<Image />` infers dimensions from the source (no CLS), emits `loading="lazy"`
  and `decoding="async"`, requires `alt`, and picks an optimized format. Images
  from `public/` **require explicit `width` and `height`** and are never
  optimized (<https://docs.astro.build/en/reference/modules/astro-assets/>).
- An image imported from `src/` is an `ImageMetadata` object:
  `{ src: string; width: number; height: number; format: ImageInputFormat; orientation?: number }`.
- `getImage()` returns `{ src, attributes, srcSet }` where `src` is *"the path to
  the generated image"*.

**[spec impact]** The spec says showcase images live in `public/showcase/`. That
opts out of optimization for exactly the assets that dominate page weight. Move
them to `src/showcase/` (or `src/assets/showcase/`) and resolve override-declared
paths with `import.meta.glob('../showcase/**/*.{png,jpg,jpeg,webp,avif}')`.

Lightbox pattern (still zero client JS):

```astro
<a href={img.src}>              <!-- full-size original, hashed asset URL -->
  <Image src={img} widths={[320, 640]} sizes="(min-width: 40rem) 20rem, 90vw" alt={name} />
</a>
```

If the originals are large, cap the "full" version with
`const full = await getImage({ src: img, width: 1600 });` and link `full.src`.

### 1.6 Zero client JS

Still the default. Current docs: *"Zero JS, by default: Less client-side
JavaScript to slow your site down"* and *"Astro leverages server rendering over
client-side rendering in the browser as much as possible"*
(<https://docs.astro.build/en/concepts/why-astro/>). Client JS ships only via an
explicit `client:*` directive on a framework component. The `<a href>` lightbox
above keeps that promise.

---

## 2. Cloudflare deployment

### 2.1 Pages vs Workers — current status

- **No deprecation of Pages.** Pages is still receiving changes in 2026 (per-site
  file limit raised to 100,000 on paid plans in Jan 2026; pnpm 10 support added
  to the build system) — <https://developers.cloudflare.com/changelog/product/pages/>.
  New Pages projects can still be created; the git-integration docs are current.
- **But Cloudflare's stated recommendation for new projects is Workers**, and has
  been since 2025-04-08: *"Now that Workers supports both serving static assets
  and server-side rendering, you should start with Workers."* and *"Cloudflare
  Pages will continue to be supported, but, going forward, all of our investment,
  optimizations, and feature work will be dedicated to improving Workers."*
  (<https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/>).
- **Astro's own docs echo this**: *"Cloudflare recommends using Cloudflare Workers
  for new projects. For existing Pages projects, refer to Cloudflare's migration
  guide and compatibility matrix."*
  (<https://docs.astro.build/en/guides/deploy/cloudflare/>).
- Feature-gap check: in Cloudflare's Pages→Workers compatibility matrix the only
  row still marked "coming soon" for Workers is **custom branch aliases**
  (<https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/>).
  Irrelevant to a solo single-branch project.

### 2.2 Path A — Workers static assets (recommended)

Requires one committed config file. **No `@astrojs/cloudflare` adapter**: *"If
you want to use Astro as a static site generator, you do not need the Astro
Cloudflare adapter."*
(<https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/>)

```jsonc
// wrangler.jsonc
{
  "name": "skill-shelf",
  "compatibility_date": "2026-08-14",
  "assets": {
    "directory": "./dist"
  }
}
```

Workers Builds (git integration) settings —
<https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>:

| Field | Value |
|---|---|
| Build command | `npm run build` (docs use `npx astro build`) |
| Deploy command | `npx wrangler deploy` |
| Root directory | repo root (blank) |

Node version in the Workers Builds image: **default 24.18.0**, overridable via
`NODE_VERSION` build variable or a `.nvmrc` / `.node-version` file
(<https://developers.cloudflare.com/workers/ci-cd/builds/build-image/>).

**[spec impact]** The default hostname becomes `skill-shelf.<subdomain>.workers.dev`,
not `skill-shelf.pages.dev`. Update the spec's deployment section. Custom domain
attachment works the same on either.

### 2.3 Path B — classic Pages git integration (still valid)

Dashboard flow (<https://developers.cloudflare.com/pages/get-started/git-integration/>):
**Workers & Pages → Create application → Pages → Connect to Git** → authorize
GitHub → pick `ZH-L1N/skill-shelf` → set project name + production branch → build
settings → **Save and Deploy**.

| Setting | Value | Source |
|---|---|---|
| Framework preset | `Astro` | <https://developers.cloudflare.com/pages/configuration/build-configuration/> |
| Build command | `npm run build` | same |
| Build output directory | `dist` | same + <https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/> |
| Production branch | `main` | git-integration guide |
| Root directory | blank | git-integration guide |

Node version: Pages build image v3 defaults to **Node 22.16.0**; override with a
`NODE_VERSION` environment variable or a `.nvmrc` / `.node-version` file
(<https://developers.cloudflare.com/pages/configuration/build-image/>). 22.16.0
does satisfy astro's `>=22.12.0`, but pin explicitly anyway.

Zero config files in the repo — that is Pages' one advantage here.

**Pin the Node version with a committed `.node-version` file** rather than a
dashboard env var: it is honored identically by Pages *and* Workers Builds, so
the choice of path B vs A doesn't change it, and it self-documents in git.

---

## 3. Node sync-script tooling

### 3.1 `fs.globSync`

**Stable, and sufficient.** From the Node v24 API source
(<https://github.com/nodejs/node/blob/v24.x/doc/api/fs.md>,
rendered at <https://nodejs.org/docs/latest-v24.x/api/fs.html>):

```
Stability: 2 - Stable
added: v22.0.0
changes:
  - version: v24.16.0  description: Add support for the `followSymlinks` option.
  - version: v24.1.0   description: Add support for `URL` instances for `cwd` option.
  - version: v24.0.0   description: Marking the API stable.
  - version: [v23.7.0, v22.14.0]  description: Add support for `exclude` option to accept glob patterns.
  - version: v22.2.0   description: Add support for `withFileTypes` as an option.
```

Options: `cwd` (string|URL, default `process.cwd()`), `exclude` (Function |
string[] of glob patterns), `withFileTypes` (boolean → `Dirent[]`).

Verified empirically on the local machine (Node v24.15.0, no `ExperimentalWarning`
emitted):

```
fs.globSync('~/.claude/plugins/cache/*/*/*/skills/*/SKILL.md')  →  104 matches in 16 ms
fs.globSync('*/SKILL.md', { cwd: '~/.claude/skills' })          →  18 matches (relative paths)
withFileTypes: true → Dirent instances;  exclude: fn → accepted
```

Absolute patterns and `**` both work. Two caveats for the plan:

- `followSymlinks` needs Node **>=24.16.0**; local is 24.15.0. Don't use that option.
- `fsPromises.glob` has an open symlink bug that `globSync` does not
  (<https://github.com/nodejs/node/issues/58276>) — another reason the sync
  script should stay synchronous.

No `tinyglobby` / `fast-glob` dependency needed.

### 3.2 YAML / frontmatter parsing

| Candidate | Latest | Last publish | Verdict |
|---|---|---|---|
| `yaml` | 2.9.0 | 2026-05-11 | **Recommended.** Zero runtime deps, `parse`/`stringify`, actively maintained. |
| `js-yaml` | 5.3.0 | — | Fine, but see the transitive-dep trap below. |
| `gray-matter` | 4.0.3 | **2023-07-12** | **Avoid.** Unmaintained for 3 years and still pinned to `js-yaml ^3.13.1`, two majors behind. |

**Transitive-dep trap:** `astro@7.2.2` does depend on `js-yaml: ^4.3.0`
(<https://registry.npmjs.org/astro/7.2.2>) so a YAML parser is already physically
in `node_modules`. That is *not* a licence to import it — it's a private
implementation detail of Astro, hoisting is not guaranteed, and the major can
change under you at any Astro release. Declare a direct dependency. Practical
effect on install size is ~nil either way.

**Frontmatter:** don't add a second package. Splitting on the `---` fence is ~8
lines and lets one dependency (`yaml`) cover both `SKILL.md` frontmatter and
`overrides.yaml`:

```js
import { parse } from 'yaml';

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(text) {
  const m = FM.exec(text);
  return m ? (parse(m[1]) ?? {}) : {};
}
```

Total new runtime deps for the sync script: **one** (`yaml`).

---

## 4. Testing + CI

### 4.1 Unit tests

- **`node:test` is Stability 2 - Stable**, added in v18.0.0
  (<https://nodejs.org/docs/latest-v24.x/api/test.html>). `node --test`
  auto-discovers `**/*.test.{cjs,mjs,js}`, `**/test/**/*.{cjs,mjs,js}` and
  friends; custom globs accepted; exit code 1 on failure; pairs with `node:assert`.
- **Astro's docs document Vitest, Playwright, Cypress and NightwatchJS; `node:test`
  is not mentioned** (<https://docs.astro.build/en/guides/testing/>). Vitest gets
  the most detail (including the `getViteConfig()` helper) and there are two
  official examples, `with-vitest` and `container-with-vitest`. So Vitest *is* the
  ecosystem default — but the reason it is the default is that it can resolve
  `astro:*` virtual modules and drive the Container API for component tests.
- We test pure functions in `scripts/sync.mjs` and `src/lib/catalog.mjs`. None of
  them import `astro:*`. **Vitest buys nothing here** (latest is 4.1.10, and it
  brings a Vite instance plus config into a project whose test surface is two
  pure functions). Use `node:test`.

```json
{ "scripts": { "test": "node --test" } }
```

Add Vitest later only if `.astro` component tests appear — that migration is
mechanical (`test`/`describe`/`assert` map over cleanly).

### 4.2 GitHub Actions

Current action versions (GitHub releases API):
`actions/checkout` **v7.0.1** (2026-07-20), `actions/setup-node` **v7.0.0**
(2026-07-14). setup-node v7 migrated internals to ESM and removed the dummy
`NODE_AUTH_TOKEN` fallback; v5 bumped the action runtime to Node 24 and requires
runner **>= 2.327.1** (GitHub-hosted runners are fine)
(<https://github.com/actions/setup-node/blob/main/README.md>).

Node version for CI: **24** — Node 24 is the Active LTS line ("Krypton", currently
v24.19.0), matches the local machine (v24.15.0) and the Workers Builds default
(24.18.0) (<https://nodejs.org/dist/index.json>).

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .node-version   # same file Cloudflare reads
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
```

`cache: npm` keys off `package-lock.json` automatically. Using
`node-version-file: .node-version` makes the single committed file the one source
of truth for local, CI and Cloudflare. **CI must never run `npm run sync`** — it
reads `~/.claude`, `~/.codex`, `~/.agents`.

---

## Recommendations for the plan

1. **Astro** — Scaffold `astro@7.2.2` with `npm create astro@latest . -- --template minimal --install --no-git --no-ai --skip-houston`; keep `output: 'static'` with no adapter; merge the two data files with a plain `import` of the JSON plus `node:fs` + `yaml` parse inside `index.astro`'s frontmatter calling one pure `mergeCatalog()` (skip the Content Layer `file()` loader for MVP); move showcase originals from `public/showcase/` to `src/showcase/` so `<Image>` optimizes the thumbnails and `<a href={img.src}>` links the original; watch the v7 `compressHTML: 'jsx'` whitespace change and the now-strict Rust compiler.
2. **Cloudflare** — Deploy via **Workers static assets with Workers Builds git integration** (Cloudflare's and Astro's stated recommendation for new projects): commit a 6-line `wrangler.jsonc` with `assets.directory: "./dist"`, build command `npm run build`, deploy command `npx wrangler deploy`; classic Pages (preset `Astro`, build `npm run build`, output `dist`) remains a fully supported zero-config fallback — Pages is not deprecated, but note the hostname becomes `*.workers.dev` instead of `skill-shelf.pages.dev`.
3. **Node sync script** — `fs.globSync` is Stability 2 - Stable since Node 24.0.0 and already resolves the real skill paths (104 matches in 16 ms locally), so use it with no glob dependency; add exactly one runtime dep, `yaml@2`, and hand-roll the ~8-line `---` frontmatter split (avoid `gray-matter`, unmaintained since 2023 on `js-yaml@3`; never import Astro's transitive `js-yaml`).
4. **Testing + CI** — Use the built-in `node:test` runner (`"test": "node --test"`) since only pure functions are under test — Vitest is the Astro ecosystem default but earns its keep only for `astro:*`/component tests; CI is one `ubuntu-latest` job with `actions/checkout@v7` + `actions/setup-node@v7` (`node-version-file: .node-version`, `cache: npm`) running `npm ci && npm test && npm run build`, and never `npm run sync`.
