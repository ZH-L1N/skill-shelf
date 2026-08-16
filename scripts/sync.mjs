#!/usr/bin/env node
/**
 * skill-shelf inventory sync.
 *
 *   npm run sync                          dry run: print the diff, skip list and
 *                                         reconciliation; write nothing
 *   npm run sync -- --write               apply to data/generated.json
 *   npm run sync -- --write --out <path>  apply somewhere else (stability check)
 *
 * Runs on Zehui's machine only — it reads ~/.claude, ~/.codex and ~/.agents.
 * CI must never run it (and cannot: the denylist file does not exist there).
 *
 * This file is the only place that touches the real filesystem roots; all the
 * logic lives in ./lib/inventory.mjs and is unit-tested. `runSync` takes its
 * homedir, cwd, env and output streams as arguments so it stays testable.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  AGGREGATE_GROUPS,
  BLOCKLIST,
  applyAggregates,
  applyBlocklist,
  denylistGate,
  discoverSources,
  isBlockedOrigin,
  mergeEntries,
  parseDenylist,
  reconcile,
  resolveSyncPaths,
  scanRoot,
  toStableJson,
} from './lib/inventory.mjs';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/**
 * Provenance only — drift is a human-review signal in the diff, never a failure.
 *
 * Personal and PUBLIC-marketplace roots only. Blocked-origin roots are
 * deliberately absent: their names and counts must never enter a committed
 * file, and their counts can never affect the published output. Those roots
 * print their actual count with no expected reference.
 */
const EXPECTED_RAW_COUNTS = {
  'personal:claude': 18,
  'personal:codex': 21,
  'personal:agents': 3,
  'plugin:superpowers@claude-plugins-official': 14,
  'plugin:document-skills@anthropic-agent-skills': 17,
  'plugin:codex@openai-codex': 3,
};

const USAGE = `Usage: node scripts/sync.mjs [--write] [--out <path>]

  (no flags)     dry run — print the diff summary, skip list and reconciliation
  --write        apply the result (and update the local .last-sync digest)
  --out <path>   change ONLY the write target; previous state for generatedAt
                 preservation is always read from data/generated.json, and the
                 .last-sync digest is left untouched
  --help         show this message`;

export function parseArgs(argv) {
  const options = { write: false, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        return { error: '--out requires a path argument' };
      }
      options.out = value;
      i += 1;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) return { error: '--out requires a path argument' };
      options.out = value;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { options };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** sha256 over the sorted, lowercased term list — detects same-count edits too. */
export function digestTerms(terms) {
  return createHash('sha256').update([...terms].sort().join('\n')).digest('hex');
}

/** added / removed / changed slugs versus the previously committed inventory. */
export function diffEntries(previousEntries, nextEntries) {
  const before = new Map((previousEntries ?? []).map((e) => [e.slug, e]));
  const after = new Map(nextEntries.map((e) => [e.slug, e]));

  const added = [...after.keys()].filter((s) => !before.has(s)).sort();
  const removed = [...before.keys()].filter((s) => !after.has(s)).sort();
  const changed = [];
  for (const [slug, next] of after) {
    const prev = before.get(slug);
    if (!prev) continue;
    const fields = ['name', 'description', 'origin', 'runtimes'].filter(
      (key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]),
    );
    if (fields.length > 0) changed.push({ slug, fields });
  }
  changed.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return { added, removed, changed };
}

/**
 * @param {object} deps
 * @param {string[]} deps.argv    arguments after the script name
 * @param {string}   deps.homedir root of the skill scan (os.homedir() in production)
 * @param {string}   deps.cwd     repo root — decides data/generated.json
 * @param {object}   deps.env     process.env
 * @param {Function} deps.log
 * @param {Function} deps.error
 * @returns {number} process exit code
 */
export function runSync({
  argv = [],
  homedir = os.homedir(),
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
  error = console.error,
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(parsed.error);
    error(USAGE);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.help) {
    log(USAGE);
    return EXIT_OK;
  }

  // -- 1. discover roots ----------------------------------------------------
  const manifestPath = path.join(homedir, '.claude', 'plugins', 'installed_plugins.json');
  const manifest = readJsonFile(manifestPath);
  if (!manifest) {
    error(`could not read the plugin manifest: ${manifestPath}`);
    return EXIT_FAILED;
  }

  const sources = discoverSources(homedir, manifest);
  if (sources.length === 0) {
    error('no scan roots were registered');
    return EXIT_FAILED;
  }

  // -- 2. scan --------------------------------------------------------------
  const rawEntries = [];
  const skipped = [];
  const perRootCounts = {};
  for (const source of sources) {
    const result = scanRoot(source);
    perRootCounts[source.id] = result.entries.length;
    rawEntries.push(...result.entries);
    skipped.push(...result.skipped);
  }
  const filesScanned = rawEntries.length;

  // -- 3. fail-loud source assertion, on RAW pre-blocklist counts ------------
  const emptyRoots = sources.filter((s) => perRootCounts[s.id] === 0);
  if (emptyRoots.length > 0) {
    error('registered scan roots produced zero raw entries:');
    for (const s of emptyRoots) error(`  ${s.id} -> ${s.root}`);
    error('fix the root (or remove it from discovery) before syncing.');
    return EXIT_FAILED;
  }

  // -- 4. denylist gate over pre- and post-blocklist data --------------------
  const denylistPath =
    env.SKILL_SHELF_DENYLIST || path.join(homedir, '.config', 'skill-shelf', 'denylist.txt');

  // The term list must never live inside the repo: a denylist under the working
  // tree is one `git add` away from publishing the exact vocabulary it exists
  // to keep out.
  const relativeToCwd = path.relative(path.resolve(cwd), path.resolve(denylistPath));
  if (relativeToCwd && !relativeToCwd.startsWith('..') && !path.isAbsolute(relativeToCwd)) {
    error(`denylist path is inside the repo: ${denylistPath}`);
    error('the term list must live outside any working tree; see CLAUDE.md gotchas.');
    return EXIT_FAILED;
  }

  const denylistText = readTextFile(denylistPath);
  if (denylistText === null) {
    error(`denylist not found: ${denylistPath}`);
    error('create it (or set SKILL_SHELF_DENYLIST); see CLAUDE.md gotchas.');
    return EXIT_FAILED;
  }
  const { terms, rawLines } = parseDenylist(denylistText);

  const postBlocklistRaw = applyBlocklist(rawEntries, BLOCKLIST);
  const entries = mergeEntries(postBlocklistRaw);

  const verdict = denylistGate({ terms, rawLines, preBlocklist: rawEntries, postBlocklist: entries });
  for (const warning of verdict.warnings) error(`WARNING: ${warning}`);
  if (!verdict.ok) {
    error(`denylist gate refused: ${verdict.reason}`);
    return EXIT_FAILED;
  }

  // -- 5. reconciliation ----------------------------------------------------
  // Deliberately raw-vs-merged: it audits the scan and the merge, and must not
  // see the publish transform below.
  const reconciliation = reconcile({ rawPostBlocklist: postBlocklistRaw, entries });

  // -- 5b. publish transform ------------------------------------------------
  // Everything above still scans and gates marketplace roots; only what gets
  // WRITTEN is narrowed here: personal entries, with aggregate groups collapsed.
  const personalMerged = entries.filter((e) => e.origin === 'personal');
  const { entries: published, absorbed } = applyAggregates(personalMerged);

  // Independent recomputation of the emitted-group count, so the assertion below
  // cannot be satisfied by applyAggregates agreeing with itself.
  const personalSlugs = new Set(personalMerged.map((e) => e.slug));
  const emittedGroupCount = AGGREGATE_GROUPS.filter((g) =>
    g.memberSlugs.some((slug) => personalSlugs.has(slug)),
  ).length;
  const expectedPublished = personalMerged.length - absorbed.length + emittedGroupCount;
  if (published.length !== expectedPublished) {
    error(
      `publish transform FAILED: ${published.length} published entries != ` +
        `${personalMerged.length} personal - ${absorbed.length} absorbed + ${emittedGroupCount} aggregate(s)`,
    );
    return EXIT_FAILED;
  }

  // -- 6. serialize ---------------------------------------------------------
  const { writePath, previousPath } = resolveSyncPaths({ cwd, out: options.out });
  const previousJson = readTextFile(previousPath);
  let previous = null;
  if (previousJson) {
    try {
      previous = JSON.parse(previousJson);
    } catch {
      previous = null; // a corrupt previous file simply loses the diff baseline
    }
  }
  const json = toStableJson(published, previousJson);
  const diff = diffEntries(previous?.entries, published);

  // -- 7. report ------------------------------------------------------------
  log('Scan roots (raw pre-blocklist counts; expected figures are provenance only):');
  for (const source of sources) {
    const actual = perRootCounts[source.id];
    const expected = EXPECTED_RAW_COUNTS[source.id];
    // Blocked-origin roots carry no expected reference by design — print the
    // actual count and nothing else.
    const note = isBlockedOrigin(source.origin, BLOCKLIST)
      ? ''
      : expected === undefined
        ? '(new root)'
        : expected === actual
          ? ''
          : `(expected ${expected})`;
    log(`  ${String(actual).padStart(3)}  ${source.id} ${note}`.trimEnd());
  }

  log('');
  log(`Skipped ${skipped.length} director${skipped.length === 1 ? 'y' : 'ies'} without a readable SKILL.md:`);
  for (const item of skipped) log(`  ${item.path} — ${item.reason}`);

  log('');
  log('Diff vs data/generated.json:');
  log(`  added   ${diff.added.length}${diff.added.length ? `: ${diff.added.join(', ')}` : ''}`);
  log(`  removed ${diff.removed.length}${diff.removed.length ? `: ${diff.removed.join(', ')}` : ''}`);
  log(`  changed ${diff.changed.length}`);
  for (const item of diff.changed) log(`    ${item.slug} (${item.fields.join(', ')})`);

  const personalRaw = postBlocklistRaw.filter((e) => e.origin === 'personal').length;
  const personalEntries = entries.filter((e) => e.origin === 'personal').length;
  log('');
  log('Reconciliation:');
  log(`  files scanned          ${filesScanned}`);
  log(`  blocklisted            ${filesScanned - postBlocklistRaw.length}`);
  log(`  duplicates collapsed   ${postBlocklistRaw.length - entries.length}`);
  log(`  entries                ${entries.length} (${personalEntries} personal)`);
  log(`  personal raw instances ${personalRaw}`);
  log(
    `  published: ${published.length} personal entries ` +
      `(${entries.length - personalEntries} marketplace entries scanned but not published)`,
  );
  if (absorbed.length > 0) {
    log(`  aggregated: ${absorbed.length} entries into ${emittedGroupCount} group(s)`);
  }
  log('  point-in-time reference (2026-08-16): 84 scanned, 60 entries, 26 personal, 41 personal instances');
  if (!reconciliation.ok) {
    error('reconciliation FAILED:');
    for (const err of reconciliation.errors) error(`  ${err}`);
    return EXIT_FAILED;
  }
  log('  slug set equality / runtime conservation: OK');

  // -- 8. denylist change reminder (printed always, persisted only on --write)
  const lastSyncPath = path.join(path.dirname(denylistPath), '.last-sync');
  const digest = digestTerms(terms);
  const previousDigest = (readTextFile(lastSyncPath) ?? '').trim();
  const termsChanged = previousDigest !== digest;
  if (termsChanged) {
    log('');
    log(
      'NOTE: the denylist term list changed since the last applied sync — update the ' +
        'reference copy in the mechanism named in CLAUDE.md gotchas.',
    );
  }

  // -- 9. write -------------------------------------------------------------
  if (!options.write) {
    log('');
    if (options.out) log('--out ignored (dry run).');
    log('Dry run — nothing written. Review the diff above, then re-run with --write.');
    return EXIT_OK;
  }

  try {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, json);
  } catch (err) {
    error(`failed to write ${writePath}: ${err.message}`);
    return EXIT_FAILED;
  }
  log('');
  log(`Wrote ${writePath}`);

  // .last-sync is local and uncommitted, and is updated ONLY when the canonical
  // data/generated.json is the thing being written — so the reminder above
  // persists until the change is really applied. A `--write --out` run is a
  // throwaway (the stability check), and must not clear it.
  if (writePath !== previousPath) {
    log('--out run: the denylist digest in .last-sync was NOT persisted.');
    return EXIT_OK;
  }

  try {
    fs.mkdirSync(path.dirname(lastSyncPath), { recursive: true });
    fs.writeFileSync(lastSyncPath, `${digest}\n`);
  } catch (err) {
    error(`WARNING: could not update ${lastSyncPath}: ${err.message}`);
  }

  return EXIT_OK;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(runSync({ argv: process.argv.slice(2) }));
}
