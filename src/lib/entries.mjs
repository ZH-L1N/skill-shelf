/**
 * Build-time render shaping for the shelf.
 *
 * `mergeCatalog` is pure: it takes the two committed data layers plus the list
 * of files that exist under `src/showcase/`, and returns everything the index
 * page renders. It never touches the filesystem — `loadCatalog` is the thin
 * wrapper that reads the real files and calls it.
 *
 * Companion module: `scripts/lib/inventory.mjs` (sync time, writes
 * `data/generated.json`). This one only ever reads.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed display order. The page renders these groups top to bottom. */
export const CATEGORY_ORDER = Object.freeze([
  Object.freeze({ key: 'dev-workflow', name: 'Dev Workflow' }),
  Object.freeze({ key: 'agent-orchestration', name: 'Agent Orchestration' }),
  Object.freeze({ key: 'design-visual', name: 'Design & Visual' }),
  Object.freeze({ key: 'curated-picks', name: 'Curated Picks' }),
]);

/** Catch-all group, always rendered last so a missing category is obvious. */
export const UNCATEGORIZED = Object.freeze({ key: 'uncategorized', name: 'Uncategorized' });

/** Card copy cap. Frontmatter descriptions are routing text, not card copy. */
export const DESCRIPTION_MAX = 140;

/** Default status when an override does not say otherwise. */
export const DEFAULT_STATUS = 'active';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cut `text` to at most `max` characters (ellipsis included) without splitting
 * a word. Used only as graceful degradation: the committed data is asserted to
 * be within the cap by `tests/entries.test.mjs`.
 */
export function truncateAtWordBoundary(text, max = DESCRIPTION_MAX) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(' ');
  const kept = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${kept.replace(/[\s,;:.!?—–-]+$/u, '')}…`;
}

function capDescription(label, description, warnings) {
  const text = typeof description === 'string' ? description.trim() : '';
  if (text.length <= DESCRIPTION_MAX) return text;
  warnings.push(
    `${label}: description is ${text.length} chars (cap ${DESCRIPTION_MAX}) — truncated at a word boundary`,
  );
  return truncateAtWordBoundary(text, DESCRIPTION_MAX);
}

function resolveImages(label, images, showcase, warnings) {
  if (!Array.isArray(images)) return [];
  const kept = [];
  for (const file of images) {
    if (showcase.has(file)) kept.push(file);
    else warnings.push(`${label}: showcase image "${file}" not found in src/showcase/ — dropped`);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// mergeCatalog
// ---------------------------------------------------------------------------

/**
 * @param {{entries?: Array<object>}} generated  parsed `data/generated.json`
 * @param {{skills?: object, projects?: object}} overrides  parsed `data/overrides.yaml`
 * @param {{showcaseFiles?: Iterable<string>}} [options]  filenames present in `src/showcase/`
 * @returns {{skillsByCategory: Array<object>, projects: Array<object>,
 *            orphanedOverrides: string[], warnings: string[]}}
 */
export function mergeCatalog(generated, overrides, options = {}) {
  const warnings = [];
  const showcase = new Set(options.showcaseFiles ?? []);
  const scanned = generated?.entries ?? [];
  const skillOverrides = overrides?.skills ?? {};
  const projectOverrides = overrides?.projects ?? {};

  const bySlug = new Map(scanned.map((item) => [item.slug, item]));
  const orphanedOverrides = [];
  const visible = [];

  // Scanned entries first, then manual override-only cards.
  const slugs = [...bySlug.keys()];
  for (const key of Object.keys(skillOverrides)) {
    if (bySlug.has(key)) continue;
    if (skillOverrides[key]?.manual === true) slugs.push(key);
    else orphanedOverrides.push(key);
  }

  for (const slug of slugs) {
    const base = bySlug.get(slug) ?? {};
    const override = skillOverrides[slug] ?? {};
    const manual = override.manual === true;

    // The one visibility rule, in the one place it lives.
    if (override.hidden === true) continue;
    if (base.origin !== 'personal' && !manual) continue;

    visible.push({
      slug,
      name: override.name ?? base.name ?? slug,
      description: capDescription(slug, override.description ?? base.description, warnings),
      runtimes: base.runtimes ?? [],
      origin: base.origin ?? null,
      manual,
      category: override.category ?? null,
      notes: override.notes ?? null,
      status: override.status ?? DEFAULT_STATUS,
      repo: override.repo ?? null,
      images: resolveImages(slug, override.images, showcase, warnings),
    });
  }

  visible.sort((a, b) => a.slug.localeCompare(b.slug));

  const groups = [...CATEGORY_ORDER, UNCATEGORIZED].map(({ key, name }) => ({
    key,
    name,
    entries: visible.filter((item) =>
      key === UNCATEGORIZED.key
        ? !CATEGORY_ORDER.some((group) => group.key === item.category)
        : item.category === key,
    ),
  }));

  // Projects live in their own namespace: they never mutate or remove a skill
  // entry, which is what lets `herdr` be both a skill card and a project card.
  const projects = Object.entries(projectOverrides).map(([key, project]) => ({
    key,
    name: project?.name ?? key,
    description: capDescription(`project ${key}`, project?.description, warnings),
    notes: project?.notes ?? null,
    status: project?.status ?? DEFAULT_STATUS,
    repo: project?.repo ?? null,
    images: resolveImages(`project ${key}`, project?.images, showcase, warnings),
  }));

  return {
    skillsByCategory: groups.filter((group) => group.entries.length > 0),
    projects,
    orphanedOverrides,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// loadCatalog — thin filesystem wrapper for the Astro page
// ---------------------------------------------------------------------------

/** Read the two data layers plus the showcase listing from `cwd`, then merge. */
export function loadCatalog(cwd) {
  const generated = JSON.parse(fs.readFileSync(path.join(cwd, 'data', 'generated.json'), 'utf8'));
  const overrides = parseYaml(fs.readFileSync(path.join(cwd, 'data', 'overrides.yaml'), 'utf8'));

  let showcaseFiles = [];
  try {
    showcaseFiles = fs
      .readdirSync(path.join(cwd, 'src', 'showcase'))
      .filter((name) => !name.startsWith('.'));
  } catch {
    // No showcase directory yet: every images: entry degrades to a warning.
  }

  return mergeCatalog(generated, overrides, { showcaseFiles });
}
