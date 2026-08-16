/**
 * End-to-end tests for the sync CLI.
 *
 * `runSync` takes its homedir, cwd, env and streams as arguments precisely so
 * these tests never go near the real home directory: every run below is driven
 * against `mkdtemp` fixtures, and every denylist term is synthetic.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, digestTerms, runSync } from '../scripts/sync.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tempRoots = [];

function makeTempDir(prefix = 'skill-shelf-sync-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// Synthetic vocabulary only — never real organization terms.
const SYNTHETIC_TERMS = ['acmecorp', 'zorblex', 'quokka-widget', 'plumbus', 'fizzbin'];

function writeSkill(root, slug, description) {
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  fs.writeFileSync(
    path.join(root, slug, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

/**
 * A fake home with all three personal roots populated (an empty registered root
 * is a hard failure by design) plus one PUBLIC-marketplace plugin root.
 *
 * The marketplace root is what exercises the publish filter: `delta` is scanned
 * and passes the blocklist, but must never reach the written file. None of these
 * slugs belong to a real AGGREGATE_GROUPS group, so aggregation is a no-op here.
 */
function makeHome({
  claude,
  codex = { beta: 'Beta skill' },
  agents = { gamma: 'Gamma skill' },
  plugin = { delta: 'Delta marketplace skill' },
} = {}) {
  const home = makeTempDir('skill-shelf-home-');
  const roots = {
    '.claude/skills': claude ?? { alpha: 'Alpha skill' },
    '.codex/skills': codex,
    '.agents/skills': agents,
  };
  for (const [dir, skills] of Object.entries(roots)) {
    const root = path.join(home, dir);
    fs.mkdirSync(root, { recursive: true });
    for (const [slug, description] of Object.entries(skills)) writeSkill(root, slug, description);
  }

  const installPath = path.join(home, '.claude/plugins/cache/public-market/toolbox/1.0.0');
  const pluginRoot = path.join(installPath, 'skills');
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const [slug, description] of Object.entries(plugin)) writeSkill(pluginRoot, slug, description);

  const pluginsDir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify(
      { version: 1, plugins: { 'toolbox@public-market': [{ scope: 'user', installPath }] } },
      null,
      2,
    ),
  );
  return home;
}

function makeDenylist(terms = SYNTHETIC_TERMS) {
  const dir = makeTempDir('skill-shelf-denylist-');
  const file = path.join(dir, 'denylist.txt');
  fs.writeFileSync(file, `# synthetic test terms\n${terms.join('\n')}\n`);
  return { dir, file };
}

function run({ argv = [], home, cwd, denylist }) {
  const out = [];
  const err = [];
  const code = runSync({
    argv,
    homedir: home,
    cwd,
    env: { SKILL_SHELF_DENYLIST: denylist },
    log: (line = '') => out.push(String(line)),
    error: (line = '') => err.push(String(line)),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function setup(options = {}) {
  const home = makeHome(options.home);
  const cwd = makeTempDir('skill-shelf-cwd-');
  const denylist = makeDenylist(options.terms);
  return {
    home,
    cwd,
    denylist: denylist.file,
    lastSync: path.join(denylist.dir, '.last-sync'),
    generated: path.join(cwd, 'data', 'generated.json'),
  };
}

// ---------------------------------------------------------------------------
// (a) dry run
// ---------------------------------------------------------------------------

test('sync (a): a dry run exits 0 and writes nothing at all', () => {
  const fx = setup();
  const { code, out } = run({ home: fx.home, cwd: fx.cwd, denylist: fx.denylist });

  assert.equal(code, EXIT_OK);
  assert.match(out, /Dry run/);
  assert.equal(fs.existsSync(fx.generated), false, 'data/generated.json must not be created');
  assert.equal(fs.existsSync(fx.lastSync), false, '.last-sync must not be created on a dry run');
});

// ---------------------------------------------------------------------------
// (b) --write
// ---------------------------------------------------------------------------

test('sync (b): --write writes data/generated.json and the .last-sync digest', () => {
  const fx = setup();
  const { code, out } = run({ argv: ['--write'], home: fx.home, cwd: fx.cwd, denylist: fx.denylist });

  assert.equal(code, EXIT_OK);
  const written = JSON.parse(fs.readFileSync(fx.generated, 'utf8'));
  assert.deepEqual(
    written.entries.map((e) => e.slug),
    ['alpha', 'beta', 'gamma'],
    'personal only: the marketplace skill is scanned but never published',
  );
  assert.ok(
    written.entries.every((e) => e.origin === 'personal'),
    'every published entry has origin personal',
  );
  // The marketplace skill really was scanned and really did survive the blocklist.
  assert.match(out, /plugin:toolbox@public-market/);
  assert.match(out, /entries {16}4 \(3 personal\)/);
  assert.match(out, /published: 3 personal entries \(1 marketplace entries scanned but not published\)/);
  assert.match(written.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    fs.readFileSync(fx.lastSync, 'utf8').trim(),
    digestTerms(SYNTHETIC_TERMS),
    '.last-sync holds the digest of the sorted, lowercased term list',
  );
});

// ---------------------------------------------------------------------------
// (c) --write --out
// ---------------------------------------------------------------------------

test('sync (c): --write --out writes only the out path and leaves .last-sync alone', () => {
  const fx = setup();
  assert.equal(run({ argv: ['--write'], home: fx.home, cwd: fx.cwd, denylist: fx.denylist }).code, EXIT_OK);
  const canonical = fs.readFileSync(fx.generated, 'utf8');

  // Remove the digest so its absence afterwards proves the --out run never
  // persisted one.
  fs.rmSync(fx.lastSync);

  const outPath = path.join(makeTempDir(), 'ss-a.json');
  const result = run({
    argv: ['--write', '--out', outPath],
    home: fx.home,
    cwd: fx.cwd,
    denylist: fx.denylist,
  });

  assert.equal(result.code, EXIT_OK);
  assert.equal(fs.existsSync(fx.lastSync), false, '--out must not persist the denylist digest');
  assert.match(result.out, /NOT persisted/);
  assert.equal(
    fs.readFileSync(outPath, 'utf8'),
    canonical,
    'previous state comes from data/generated.json, so the bytes match exactly',
  );
  assert.equal(
    fs.readFileSync(fx.generated, 'utf8'),
    canonical,
    '--out must not touch the canonical file',
  );
});

// ---------------------------------------------------------------------------
// (d) denylist term in published output
// ---------------------------------------------------------------------------

test('sync (d): a denylist term in a published entry refuses and writes nothing', () => {
  const fx = setup({ home: { claude: { alpha: 'A skill that mentions Plumbus internals' } } });
  const { code, err } = run({ argv: ['--write'], home: fx.home, cwd: fx.cwd, denylist: fx.denylist });

  assert.equal(code, EXIT_FAILED);
  assert.match(err, /denylist gate refused/);
  assert.match(err, /alpha/, 'the offending slug is named');
  assert.ok(!err.toLowerCase().includes('plumbus'), 'the verdict must not echo a term');
  assert.equal(fs.existsSync(fx.generated), false);
  assert.equal(fs.existsSync(fx.lastSync), false);
});

// ---------------------------------------------------------------------------
// (e) missing denylist
// ---------------------------------------------------------------------------

test('sync (e): a missing denylist file refuses', () => {
  const fx = setup();
  const missing = path.join(makeTempDir(), 'nope', 'denylist.txt');
  const { code, err } = run({ argv: ['--write'], home: fx.home, cwd: fx.cwd, denylist: missing });

  assert.equal(code, EXIT_FAILED);
  assert.match(err, /denylist not found/);
  assert.equal(fs.existsSync(fx.generated), false);
});

// ---------------------------------------------------------------------------
// (f) under-floor denylist
// ---------------------------------------------------------------------------

test('sync (f): a denylist below the term floor refuses', () => {
  const fx = setup({ terms: SYNTHETIC_TERMS.slice(0, 3) });
  const { code, err } = run({ argv: ['--write'], home: fx.home, cwd: fx.cwd, denylist: fx.denylist });

  assert.equal(code, EXIT_FAILED);
  assert.match(err, /minimum/i);
  assert.equal(fs.existsSync(fx.generated), false);
});

// ---------------------------------------------------------------------------
// (g) empty registered root
// ---------------------------------------------------------------------------

test('sync (g): a registered root with zero raw entries refuses and names the root', () => {
  const fx = setup({ home: { agents: {} } });
  const { code, err } = run({ argv: ['--write'], home: fx.home, cwd: fx.cwd, denylist: fx.denylist });

  assert.equal(code, EXIT_FAILED);
  assert.match(err, /zero raw entries/);
  assert.match(err, /personal:agents/);
  assert.equal(fs.existsSync(fx.generated), false);
});

// ---------------------------------------------------------------------------
// (h) usage
// ---------------------------------------------------------------------------

test('sync (h): an unknown flag exits with the usage code', () => {
  const fx = setup();
  const { code, err } = run({ argv: ['--bogus'], home: fx.home, cwd: fx.cwd, denylist: fx.denylist });

  assert.equal(code, EXIT_USAGE);
  assert.match(err, /unknown argument: --bogus/);
  assert.equal(fs.existsSync(fx.generated), false);
});

// ---------------------------------------------------------------------------
// (i) --out on a dry run
// ---------------------------------------------------------------------------

test('sync (i): a dry run with --out says so instead of silently ignoring it', () => {
  const fx = setup();
  const outPath = path.join(makeTempDir(), 'ss-dry.json');
  const { code, out } = run({
    argv: ['--out', outPath],
    home: fx.home,
    cwd: fx.cwd,
    denylist: fx.denylist,
  });

  assert.equal(code, EXIT_OK);
  assert.match(out, /--out ignored \(dry run\)/);
  assert.equal(fs.existsSync(outPath), false);
});

// ---------------------------------------------------------------------------
// (j) denylist inside the repo
// ---------------------------------------------------------------------------

test('sync (j): a denylist path inside the repo refuses', () => {
  const fx = setup();
  const inside = path.join(fx.cwd, 'denylist.txt');
  fs.writeFileSync(inside, `${SYNTHETIC_TERMS.join('\n')}\n`);

  const { code, err } = run({ argv: ['--write'], home: fx.home, cwd: fx.cwd, denylist: inside });

  assert.equal(code, EXIT_FAILED);
  assert.match(err, /inside the repo/);
  assert.equal(fs.existsSync(fx.generated), false);
});
