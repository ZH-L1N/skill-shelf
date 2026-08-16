/**
 * Pure inventory logic for the skill-shelf sync script.
 *
 * Everything here is deterministic and unit-tested (`tests/inventory.test.mjs`).
 * `scripts/sync.mjs` is the only place that talks to the real home directory;
 * this module never reads configuration, never writes anything, and never
 * hard-codes a home path.
 *
 * The filesystem-touching helpers (`discoverSources`, `scanRoot`) take their
 * roots as arguments so tests can drive them from temp fixture directories.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fixed precedence for personal roots. When the same slug exists in more than
 * one personal root with divergent frontmatter, the earliest runtime in this
 * list supplies name/description. Never rely on discovery order.
 */
export const SOURCE_PRECEDENCE = ['claude', 'codex', 'agents'];

/** The one work skill installed personally; never publishable. */
export const WORK_SKILL_SLUG = 'offline-read-telemetry-policy';

/**
 * Layer 1 of the org-content defense. Marketplace keys are matched by PATTERN
 * (a new `exowatt-*` marketplace is blocked without an edit here); slugs are
 * matched exactly. `tests/inventory.test.mjs` asserts this real constant, so
 * deleting or typo'ing an entry fails `npm test`.
 */
export const BLOCKLIST = Object.freeze({
  marketplacePatterns: Object.freeze([/exowatt/i]),
  slugs: Object.freeze([WORK_SKILL_SLUG]),
});

/** Floor for the content denylist: fewer terms than this and sync refuses. */
export const DENYLIST_MIN_TERMS = 5;

const PERSONAL_ROOTS = [
  { runtime: 'claude', dir: '.claude/skills' },
  { runtime: 'codex', dir: '.codex/skills' },
  { runtime: 'agents', dir: '.agents/skills' },
];

const ENTRY_KEY_ORDER = ['slug', 'name', 'description', 'runtimes', 'origin'];

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a SKILL.md into `{ name, description }`.
 *
 * Missing frontmatter, unparseable frontmatter and frontmatter without the
 * expected fields all degrade to the directory name plus an empty description
 * — a malformed skill on disk must never break a sync run.
 *
 * @param {string} text raw SKILL.md contents
 * @param {string} fallbackName the skill directory name
 */
export function parseSkillMd(text, fallbackName) {
  const match = FRONTMATTER.exec(String(text ?? ''));
  let data = {};
  if (match) {
    try {
      data = parseYaml(match[1]) ?? {};
    } catch {
      data = {};
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) data = {};

  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName;
  const description =
    typeof data.description === 'string' ? data.description.trim().replace(/\s+/g, ' ') : '';
  return { name, description };
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

function isDirectory(candidate) {
  try {
    // statSync (not lstatSync) follows symlinks — plugin caches and ~/.agents
    // both use them.
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pick the install record a plugin manifest entry is currently serving from:
 * the `user`-scope record when present, otherwise the first record.
 *
 * Records without an `installPath` are unusable and filtered out FIRST — a
 * user-scope record missing one must not short-circuit the fallback and drop
 * the plugin silently.
 */
function pickInstallRecord(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const usable = records.filter((r) => r && typeof r.installPath === 'string');
  return usable.find((r) => r.scope === 'user') ?? usable[0] ?? null;
}

/**
 * Build the list of scan roots.
 *
 * Roots are: the three personal skill directories (always registered — a
 * missing one is caught by the caller's raw-count assertion) plus one
 * `<installPath>/skills` root per manifest plugin that actually has a `skills/`
 * directory. Plugins without one (`code-review`, `swift-lsp` in the live
 * manifest) are skipped here, so they never appear as zero-yield roots.
 *
 * @param {string} homedir
 * @param {{plugins?: Record<string, Array<{scope?: string, installPath?: string}>>}} manifest
 * @returns {Array<{id: string, root: string, origin: string, runtime: string}>}
 */
export function discoverSources(homedir, manifest) {
  const sources = PERSONAL_ROOTS.map(({ runtime, dir }) => ({
    id: `personal:${runtime}`,
    root: path.join(homedir, dir),
    origin: 'personal',
    runtime,
  }));

  const plugins = manifest && typeof manifest === 'object' ? (manifest.plugins ?? {}) : {};
  for (const key of Object.keys(plugins).sort()) {
    const record = pickInstallRecord(plugins[key]);
    if (!record || typeof record.installPath !== 'string') continue;

    // Manifest keys are `<plugin>@<marketplace>`; the marketplace is the origin.
    const at = key.lastIndexOf('@');
    const marketplace = at > 0 ? key.slice(at + 1) : key;

    const root = path.join(record.installPath, 'skills');
    if (!isDirectory(root)) continue;

    sources.push({ id: `plugin:${key}`, root, origin: marketplace, runtime: 'claude' });
  }

  return sources;
}

/**
 * Scan one root for skill directories.
 *
 * Discovery is `readdirSync` with PLAIN NAMES (no `withFileTypes`) plus a
 * `statSync` on the candidate `SKILL.md` as the sole inclusion test. Dirent
 * type must never be used to filter: `~/.agents/skills/*` entries are symlinks
 * and report `isDirectory() === false`.
 *
 * @param {{id: string, root: string, origin: string, runtime: string}} source
 * @returns {{entries: Array<object>, skipped: Array<{path: string, reason: string}>}}
 */
export function scanRoot(source) {
  const entries = [];
  const skipped = [];

  let names;
  try {
    names = fs.readdirSync(source.root);
  } catch {
    // A registered root that does not exist yields nothing; the caller's
    // fail-loud raw-count assertion turns that into a non-zero exit.
    return { entries, skipped };
  }

  for (const slug of names.sort()) {
    const skillMd = path.join(source.root, slug, 'SKILL.md');
    try {
      // statSync follows symlinks, so a symlinked skill directory resolves.
      if (!fs.statSync(skillMd).isFile()) {
        skipped.push({ path: path.join(source.root, slug), reason: 'SKILL.md is not a file' });
        continue;
      }
    } catch {
      skipped.push({ path: path.join(source.root, slug), reason: 'no SKILL.md' });
      continue;
    }

    let text;
    try {
      text = fs.readFileSync(skillMd, 'utf8');
    } catch {
      skipped.push({ path: path.join(source.root, slug), reason: 'SKILL.md unreadable' });
      continue;
    }

    const { name, description } = parseSkillMd(text, slug);
    entries.push({
      slug,
      name,
      description,
      runtime: source.runtime,
      origin: source.origin,
      sourceId: source.id,
      file: skillMd,
    });
  }

  return { entries, skipped };
}

// ---------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------

/** True when a marketplace origin matches any blocklist pattern. */
export function isBlockedOrigin(origin, blocklist = BLOCKLIST) {
  if (typeof origin !== 'string' || origin === 'personal') return false;
  return blocklist.marketplacePatterns.some((pattern) => pattern.test(origin));
}

/** Drop entries from blocked marketplaces and entries with blocked slugs. */
export function applyBlocklist(entries, blocklist = BLOCKLIST) {
  const blockedSlugs = new Set(blocklist.slugs);
  return entries.filter((e) => !blockedSlugs.has(e.slug) && !isBlockedOrigin(e.origin, blocklist));
}

// ---------------------------------------------------------------------------
// Content denylist (layer 2)
// ---------------------------------------------------------------------------

/**
 * Parse the plaintext denylist: one term per line, `#` comments and blank
 * lines dropped, terms lowercased and de-duplicated.
 *
 * Returns both the normalized `terms` and the `rawLines` they came from —
 * every non-comment, non-empty line, pre-normalization, each carrying its
 * 1-based file line number so a gate refusal can point at the actual line in
 * the file (comments and blanks are dropped from the array, so an array index
 * would misdirect). A line that normalizes to nothing (whitespace only)
 * contributes no term but stays in `rawLines`, so `denylistGate`'s liveness
 * self-test can actually see it.
 *
 * @returns {{terms: string[], rawLines: Array<{text: string, lineNo: number}>}}
 */
export function parseDenylist(text) {
  const seen = new Set();
  const rawLines = [];
  const fileLines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < fileLines.length; i += 1) {
    const line = fileLines[i];
    if (line.trimStart().startsWith('#')) continue;
    if (line.length === 0) continue; // a deliberate blank separator
    rawLines.push({ text: line, lineNo: i + 1 });
    const term = line.trim().toLowerCase();
    if (!term) continue;
    seen.add(term);
  }
  return { terms: [...seen], rawLines };
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/**
 * Case-insensitive substring match of any term against any string field of
 * `fields` (walked recursively). Empty / whitespace-only terms never match —
 * that is what makes them detectable by the liveness self-test.
 */
export function matchesDenylist(fields, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return false;
  const haystack = collectStrings(fields).join('\n').toLowerCase();
  if (!haystack) return false;
  for (const term of terms) {
    const t = String(term ?? '').trim().toLowerCase();
    if (!t) continue;
    if (haystack.includes(t)) return true;
  }
  return false;
}

/**
 * The whole denylist gate, pure. `scripts/sync.mjs` only honors the verdict.
 *
 * Checks, in order:
 *  1. floor          — fewer than DENYLIST_MIN_TERMS terms refuses;
 *  2. term liveness  — EVERY RAW line of the file must flag a synthetic record
 *                      containing it, which catches whitespace-only and
 *                      otherwise malformed lines that normalize away to nothing;
 *  3. output gate    — any term matching the post-blocklist output refuses.
 *
 * Probing the raw lines rather than the parsed terms is the whole point: a term
 * that survived normalization matches itself by construction, so probing terms
 * would be a tautology.
 *
 * Reasons never echo a term (this verdict is printed, and terms must not leak
 * into logs or, worse, a committed transcript). Offending slugs are named.
 *
 * A soft signal, never a refusal: if the work skill is present in the
 * pre-blocklist scan and no term flags it, the list is probably incomplete —
 * warn. Uninstalling that skill must never brick sync.
 *
 * @returns {{ok: boolean, reason: string|null, warnings: string[]}}
 */
export function denylistGate({ terms, rawLines = null, preBlocklist = [], postBlocklist = [] }) {
  const list = Array.isArray(terms) ? terms : [];

  // Probing already-normalized terms would be a tautology (a term matches its
  // own probe by construction), so a caller that omits rawLines gets a hard
  // refusal instead of a silently weakened gate.
  if (!Array.isArray(rawLines)) {
    return {
      ok: false,
      reason: 'denylistGate wired without rawLines (internal error) — pass parseDenylist().rawLines',
      warnings: [],
    };
  }

  if (list.length < DENYLIST_MIN_TERMS) {
    return {
      ok: false,
      reason: `denylist has ${list.length} term(s); the minimum is ${DENYLIST_MIN_TERMS}`,
      warnings: [],
    };
  }

  for (const { text, lineNo } of rawLines) {
    // Probe the bare line text: filler words around it could themselves match a
    // term (e.g. a very short term inside "alpha"/"omega"), silently neutering
    // the whitespace-only detection. A whitespace-only line yields a haystack
    // no trimmed term can match, which is exactly the failure we want to see.
    const probe = { probe: String(text ?? '') };
    if (!matchesDenylist(probe, list)) {
      return {
        ok: false,
        reason: `denylist line ${lineNo} is whitespace-only or malformed; delete it or make it a # comment`,
        warnings: [],
      };
    }
  }

  const leaks = postBlocklist
    .filter((entry) => matchesDenylist(entry, list))
    .map((entry) => entry.slug ?? '<unknown>');
  if (leaks.length > 0) {
    return {
      ok: false,
      reason: `denylist term matched published output for: ${[...new Set(leaks)].sort().join(', ')}`,
      warnings: [],
    };
  }

  const warnings = [];
  const workRecords = preBlocklist.filter((entry) => entry.slug === WORK_SKILL_SLUG);
  if (workRecords.length > 0 && !workRecords.some((entry) => matchesDenylist(entry, list))) {
    warnings.push(
      `'${WORK_SKILL_SLUG}' is installed but no denylist term flags it — the term list is ` +
        'likely incomplete. Not blocking; review the list.',
    );
  }

  return { ok: true, reason: null, warnings };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function precedenceIndex(runtime) {
  const i = SOURCE_PRECEDENCE.indexOf(runtime);
  return i === -1 ? SOURCE_PRECEDENCE.length : i;
}

function sortRuntimes(runtimes) {
  return [...new Set(runtimes)].sort((a, b) => precedenceIndex(a) - precedenceIndex(b));
}

/**
 * Dedup raw file instances into one entry per slug.
 *
 * - `personal` origin beats any marketplace origin.
 * - Within personal, SOURCE_PRECEDENCE decides whose name/description wins.
 * - A personal entry's `runtimes` is the union of its PERSONAL instances: the
 *   entry describes the personal copy, and this keeps the runtime-conservation
 *   reconciliation check exact by construction.
 * - A marketplace entry's `runtimes` is the union of all its instances.
 */
export function mergeEntries(rawEntries) {
  /** @type {Map<string, object[]>} */
  const bySlug = new Map();
  for (const entry of rawEntries) {
    if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, []);
    bySlug.get(entry.slug).push(entry);
  }

  const merged = [];
  for (const [slug, instances] of bySlug) {
    const personalInstances = instances.filter((e) => e.origin === 'personal');
    const isPersonal = personalInstances.length > 0;
    const pool = isPersonal ? personalInstances : instances;

    const winner = [...pool].sort((a, b) => {
      const byRuntime = precedenceIndex(a.runtime) - precedenceIndex(b.runtime);
      if (byRuntime !== 0) return byRuntime;
      return String(a.origin).localeCompare(String(b.origin), 'en');
    })[0];

    merged.push({
      slug,
      name: winner.name,
      description: winner.description,
      runtimes: sortRuntimes(pool.map((e) => e.runtime)),
      origin: isPersonal ? 'personal' : winner.origin,
    });
  }

  return merged.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Two checks, both computed from the RAW scan side so a broken merge cannot
 * absorb its own error:
 *   (a) slug set equality between post-blocklist raw instances and entries;
 *   (b) runtime conservation for personal entries.
 *
 * There is deliberately NO per-root "conservation" check: every wiring of it
 * ended up comparing a sum to itself (the per-root counts and filesScanned
 * come from the same loop), and an unfalsifiable check that reads as coverage
 * is worse than no check (ship review rounds 1-2).
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function reconcile({ rawPostBlocklist, entries }) {
  const errors = [];

  const rawSlugs = new Set(rawPostBlocklist.map((e) => e.slug));
  const entrySlugs = new Set(entries.map((e) => e.slug));
  const dropped = [...rawSlugs].filter((s) => !entrySlugs.has(s)).sort();
  const invented = [...entrySlugs].filter((s) => !rawSlugs.has(s)).sort();
  if (dropped.length > 0) errors.push(`slug set equality: merge dropped ${dropped.join(', ')}`);
  if (invented.length > 0) errors.push(`slug set equality: merge invented ${invented.join(', ')}`);

  const personalSlugs = new Set(
    rawPostBlocklist.filter((e) => e.origin === 'personal').map((e) => e.slug),
  );
  const personalInstances = rawPostBlocklist.filter((e) => e.origin === 'personal').length;
  const personalRuntimeSlots = entries
    .filter((e) => e.origin === 'personal' && personalSlugs.has(e.slug))
    .reduce((sum, e) => sum + e.runtimes.length, 0);
  if (personalRuntimeSlots !== personalInstances) {
    errors.push(
      `runtime conservation: personal runtime slots ${personalRuntimeSlots} != personal file instances ${personalInstances}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return sorted.map((entry) => {
    const out = {};
    for (const key of ENTRY_KEY_ORDER) {
      out[key] = key === 'runtimes' ? sortRuntimes(entry.runtimes ?? []) : (entry[key] ?? '');
    }
    return out;
  });
}

/**
 * Serialize entries to the exact bytes of `data/generated.json`.
 *
 * `generatedAt` is carried over from `previousJson` whenever the serialized
 * entries are unchanged, so an unchanged inventory produces a byte-identical
 * file (and the sync-stability check compares identical timestamps).
 *
 * @param {Array<object>} entries
 * @param {string|null} previousJson raw contents of data/generated.json, if any
 * @param {string} now ISO timestamp used when the entries changed
 */
export function toStableJson(entries, previousJson, now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  const serialized = serializeEntries(entries);
  const entriesJson = JSON.stringify(serialized);

  let generatedAt = now;
  if (typeof previousJson === 'string' && previousJson.trim()) {
    try {
      const previous = JSON.parse(previousJson);
      if (
        previous &&
        typeof previous.generatedAt === 'string' &&
        JSON.stringify(serializeEntries(previous.entries ?? [])) === entriesJson
      ) {
        generatedAt = previous.generatedAt;
      }
    } catch {
      // A corrupt previous file simply loses timestamp preservation.
    }
  }

  return `${JSON.stringify({ generatedAt, entries: serialized }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * `--out` changes ONLY the write target. Previous state for `generatedAt`
 * preservation is always read from `data/generated.json`, so writing a
 * throwaway copy elsewhere still compares against the committed file.
 *
 * @param {{cwd: string, out?: string|null}} options
 * @returns {{writePath: string, previousPath: string}}
 */
export function resolveSyncPaths({ cwd, out = null }) {
  const previousPath = path.join(cwd, 'data', 'generated.json');
  const writePath = out ? path.resolve(cwd, out) : previousPath;
  return { writePath, previousPath };
}
