import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  CATEGORY_ORDER,
  DESCRIPTION_MAX,
  UNCATEGORIZED,
  loadCatalog,
  mergeCatalog,
  truncateAtWordBoundary,
} from '../src/lib/entries.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Fixture helpers — synthetic data only; the real files are exercised in the
// REAL DATA section at the bottom.
// ---------------------------------------------------------------------------

function generated(entries) {
  return { generatedAt: '2026-08-16T00:00:00Z', entries };
}

function entry(slug, extra = {}) {
  return {
    slug,
    name: slug,
    description: `frontmatter routing text for ${slug}`,
    runtimes: ['claude'],
    origin: 'personal',
    ...extra,
  };
}

/** Flattened {slug -> entry} across every rendered category. */
function bySlug(catalog) {
  const out = new Map();
  for (const group of catalog.skillsByCategory) {
    for (const item of group.entries) out.set(item.slug, { ...item, category: group.key });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visibility rule: !hidden && (origin === 'personal' || manual)
// ---------------------------------------------------------------------------

test('a personal entry renders', () => {
  const catalog = mergeCatalog(generated([entry('grilling')]), {
    skills: { grilling: { category: 'dev-workflow', description: 'Short card copy.' } },
  });
  assert.ok(bySlug(catalog).has('grilling'));
});

test('a manual entry renders without a scanned counterpart', () => {
  const catalog = mergeCatalog(generated([]), {
    skills: {
      superpowers: { manual: true, category: 'curated-picks', description: 'Manual card.' },
    },
  });
  const found = bySlug(catalog).get('superpowers');
  assert.ok(found);
  assert.equal(found.manual, true);
  assert.deepEqual(catalog.orphanedOverrides, []);
});

test('a hidden entry does not render', () => {
  const catalog = mergeCatalog(generated([entry('grilling')]), {
    skills: { grilling: { category: 'dev-workflow', description: 'Short.', hidden: true } },
  });
  assert.equal(bySlug(catalog).has('grilling'), false);
});

test('a non-personal, non-manual entry does not render', () => {
  const catalog = mergeCatalog(
    generated([entry('tdd', { origin: 'anthropic-agent-skills' })]),
    { skills: { tdd: { category: 'dev-workflow', description: 'Short.' } } },
  );
  assert.equal(bySlug(catalog).has('tdd'), false);
});

// ---------------------------------------------------------------------------
// Override precedence
// ---------------------------------------------------------------------------

test('override description and category win over generated data', () => {
  const catalog = mergeCatalog(generated([entry('hallmark')]), {
    skills: {
      hallmark: {
        category: 'design-visual',
        description: 'Hand-written card copy.',
        notes: 'Personal note.',
        repo: 'https://example.com/repo',
      },
    },
  });
  const found = bySlug(catalog).get('hallmark');
  assert.equal(found.description, 'Hand-written card copy.');
  assert.equal(found.category, 'design-visual');
  assert.equal(found.notes, 'Personal note.');
  assert.equal(found.repo, 'https://example.com/repo');
  // Generated fields survive where the override is silent.
  assert.deepEqual(found.runtimes, ['claude']);
  assert.equal(found.status, 'active');
});

// ---------------------------------------------------------------------------
// Projects never touch skills (the herdr dual-card case)
// ---------------------------------------------------------------------------

test('a project sharing a skill slug leaves the skill card intact', () => {
  const catalog = mergeCatalog(generated([entry('herdr')]), {
    skills: { herdr: { category: 'agent-orchestration', description: 'The skill card.' } },
    projects: { herdr: { name: 'herdr', description: 'The app card.' } },
  });

  const skill = bySlug(catalog).get('herdr');
  assert.ok(skill, 'herdr must still render as a skill card');
  assert.equal(skill.description, 'The skill card.');

  assert.equal(catalog.projects.length, 1);
  assert.equal(catalog.projects[0].name, 'herdr');
  assert.equal(catalog.projects[0].description, 'The app card.');
  assert.deepEqual(catalog.orphanedOverrides, []);
});

// ---------------------------------------------------------------------------
// Card copy cap
// ---------------------------------------------------------------------------

test('truncateAtWordBoundary cuts on a word boundary and stays under the cap', () => {
  const long = 'alpha bravo charlie delta '.repeat(20).trim();
  const cut = truncateAtWordBoundary(long, DESCRIPTION_MAX);
  assert.ok(cut.length <= DESCRIPTION_MAX, `got ${cut.length}`);
  assert.ok(cut.endsWith('…'));
  assert.ok(long.startsWith(cut.slice(0, -1)), 'must not cut mid-word');
});

test('an over-cap description is truncated and warned about by slug', () => {
  const long = `${'word '.repeat(60).trim()}.`;
  const catalog = mergeCatalog(generated([entry('grilling')]), {
    skills: { grilling: { category: 'dev-workflow', description: long } },
  });
  const found = bySlug(catalog).get('grilling');
  assert.ok(found.description.length <= DESCRIPTION_MAX);
  assert.equal(catalog.warnings.length, 1);
  assert.match(catalog.warnings[0], /grilling/);
});

test('an at-cap description is left alone and warns nothing', () => {
  const exact = 'x'.repeat(DESCRIPTION_MAX);
  const catalog = mergeCatalog(generated([entry('grilling')]), {
    skills: { grilling: { category: 'dev-workflow', description: exact } },
  });
  assert.equal(bySlug(catalog).get('grilling').description, exact);
  assert.deepEqual(catalog.warnings, []);
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test('an images entry naming a missing file is dropped with a warning', () => {
  const catalog = mergeCatalog(
    generated([entry('herdr')]),
    {
      skills: {
        herdr: { category: 'agent-orchestration', description: 'Short.', images: ['gone.png'] },
      },
    },
    { showcaseFiles: ['kept.png'] },
  );
  assert.deepEqual(bySlug(catalog).get('herdr').images, []);
  assert.equal(catalog.warnings.length, 1);
  assert.match(catalog.warnings[0], /herdr/);
  assert.match(catalog.warnings[0], /gone\.png/);
});

test('an images entry that resolves is kept, for skills and projects alike', () => {
  const catalog = mergeCatalog(
    generated([entry('herdr')]),
    {
      skills: {
        herdr: { category: 'agent-orchestration', description: 'Short.', images: ['kept.png'] },
      },
      projects: { herdr: { name: 'herdr', description: 'App.', images: ['kept.png', 'no.png'] } },
    },
    { showcaseFiles: ['kept.png'] },
  );
  assert.deepEqual(bySlug(catalog).get('herdr').images, ['kept.png']);
  assert.deepEqual(catalog.projects[0].images, ['kept.png']);
  assert.equal(catalog.warnings.length, 1);
  assert.match(catalog.warnings[0], /no\.png/);
});

// ---------------------------------------------------------------------------
// Category grouping
// ---------------------------------------------------------------------------

test('categories render in fixed order with uncategorized last', () => {
  const catalog = mergeCatalog(
    generated([
      entry('zeta'),
      entry('alpha'),
      entry('picks'),
      entry('visual'),
      entry('orchestrated'),
    ]),
    {
      skills: {
        zeta: { description: 'No category on purpose.' },
        alpha: { category: 'dev-workflow', description: 'Dev.' },
        picks: { category: 'curated-picks', description: 'Picks.' },
        visual: { category: 'design-visual', description: 'Visual.' },
        orchestrated: { category: 'agent-orchestration', description: 'Orchestration.' },
      },
    },
  );

  assert.deepEqual(
    catalog.skillsByCategory.map((group) => group.key),
    ['dev-workflow', 'agent-orchestration', 'design-visual', 'curated-picks', UNCATEGORIZED.key],
  );
  assert.deepEqual(
    catalog.skillsByCategory.map((group) => group.name),
    ['Dev Workflow', 'Agent Orchestration', 'Design & Visual', 'Curated Picks', UNCATEGORIZED.name],
  );
  assert.equal(catalog.skillsByCategory.at(-1).entries[0].slug, 'zeta');
});

test('empty categories are not rendered', () => {
  const catalog = mergeCatalog(generated([entry('alpha')]), {
    skills: { alpha: { category: 'dev-workflow', description: 'Dev.' } },
  });
  assert.deepEqual(catalog.skillsByCategory.map((group) => group.key), ['dev-workflow']);
});

test('entries inside a category are sorted by slug', () => {
  const catalog = mergeCatalog(generated([entry('beta'), entry('alpha')]), {
    skills: {
      beta: { category: 'dev-workflow', description: 'B.' },
      alpha: { category: 'dev-workflow', description: 'A.' },
    },
  });
  assert.deepEqual(
    catalog.skillsByCategory[0].entries.map((item) => item.slug),
    ['alpha', 'beta'],
  );
});

// ---------------------------------------------------------------------------
// Orphaned overrides
// ---------------------------------------------------------------------------

test('an override key with no scanned slug and no manual flag is reported', () => {
  const catalog = mergeCatalog(generated([entry('grilling')]), {
    skills: {
      grilling: { category: 'dev-workflow', description: 'Short.' },
      grilingg: { hidden: true },
    },
  });
  assert.deepEqual(catalog.orphanedOverrides, ['grilingg']);
});

// ---------------------------------------------------------------------------
// REAL DATA — data/generated.json + data/overrides.yaml as committed
// ---------------------------------------------------------------------------

test('REAL DATA: every skills override key matches a slug or is manual', () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.deepEqual(
    catalog.orphanedOverrides,
    [],
    `orphaned override keys: ${catalog.orphanedOverrides.join(', ')}`,
  );
});

test('REAL DATA: every visible entry has a <= 140-char description override', () => {
  const catalog = loadCatalog(REPO_ROOT);
  const rendered = [...bySlug(catalog).values(), ...catalog.projects];
  assert.ok(rendered.length > 0);
  for (const item of rendered) {
    const label = item.slug ?? item.name;
    assert.ok(item.description, `${label} has no description override`);
    assert.ok(
      item.description.length <= DESCRIPTION_MAX,
      `${label} description is ${item.description.length} chars`,
    );
    assert.equal(item.description.endsWith('…'), false, `${label} description was truncated`);
  }
});

test('REAL DATA: merging the committed files emits no build warnings', () => {
  // Covers the images assertion too: an images: key naming a file that is not
  // in src/showcase/ would show up here as a warning. Vacuous while the
  // overrides carry no images: keys — meaningful once Task 5 adds them.
  const catalog = loadCatalog(REPO_ROOT);
  assert.deepEqual(catalog.warnings, [], catalog.warnings.join('\n'));
});

test('REAL DATA: the shelf shape matches the plan (15 skills + 1 manual + 1 project)', () => {
  const catalog = loadCatalog(REPO_ROOT);
  const skills = bySlug(catalog);
  assert.equal(skills.size, 16, 'expected 15 scanned cards + the manual superpowers card');
  assert.equal([...skills.values()].filter((item) => item.manual).length, 1);
  assert.equal(catalog.projects.length, 1);
  // Every category used is a known one — no typo'd category silently landing
  // in Uncategorized.
  const known = new Set([...CATEGORY_ORDER.map((group) => group.key), UNCATEGORIZED.key]);
  for (const group of catalog.skillsByCategory) assert.ok(known.has(group.key));
  assert.equal(
    catalog.skillsByCategory.some((group) => group.key === UNCATEGORIZED.key),
    false,
    'every published entry must carry a category',
  );
});

test('REAL DATA: herdr renders as both a skill card and a project card', () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.ok(bySlug(catalog).has('herdr'));
  assert.ok(catalog.projects.some((project) => project.name === 'herdr'));
});
