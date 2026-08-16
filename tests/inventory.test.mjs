import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  BLOCKLIST,
  DENYLIST_MIN_TERMS,
  SOURCE_PRECEDENCE,
  WORK_SKILL_SLUG,
  applyBlocklist,
  denylistGate,
  discoverSources,
  isBlockedOrigin,
  matchesDenylist,
  mergeEntries,
  parseDenylist,
  parseSkillMd,
  reconcile,
  resolveSyncPaths,
  scanRoot,
  toStableJson,
} from '../scripts/lib/inventory.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers. Every filesystem fixture lives in a fresh temp directory:
// the unit tests never read or write the real home directory.
// ---------------------------------------------------------------------------

const tempRoots = [];

function makeTempDir(prefix = 'skill-shelf-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeSkill(root, slug, body) {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`;
}

after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// Synthetic denylist terms only — never real organization vocabulary.
const SYNTHETIC_TERMS = ['acmecorp', 'zorblex', 'quokka-widget', 'plumbus', 'fizzbin'];

function personal(slug, runtime, extra = {}) {
  return {
    slug,
    name: slug,
    description: `${slug} description`,
    runtime,
    origin: 'personal',
    sourceId: `personal:${runtime}`,
    ...extra,
  };
}

function marketplace(slug, origin, extra = {}) {
  return {
    slug,
    name: slug,
    description: `${slug} marketplace description`,
    runtime: 'claude',
    origin,
    sourceId: `plugin:${slug}@${origin}`,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. cross-runtime merge unions runtimes
// ---------------------------------------------------------------------------

test('case 1: cross-runtime merge unions runtimes', () => {
  const entries = mergeEntries([personal('grilling', 'claude'), personal('grilling', 'codex')]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].runtimes, ['claude', 'codex']);
  assert.equal(entries[0].origin, 'personal');
});

// ---------------------------------------------------------------------------
// 2. divergent claude/codex descriptions -> claude wins by SOURCE_PRECEDENCE
// ---------------------------------------------------------------------------

test('case 2: divergent claude/codex frontmatter resolves via SOURCE_PRECEDENCE', () => {
  assert.deepEqual(SOURCE_PRECEDENCE, ['claude', 'codex', 'agents']);
  const raw = [
    personal('proj-init', 'codex', { description: 'codex text', name: 'proj-init-codex' }),
    personal('proj-init', 'claude', { description: 'claude text', name: 'proj-init-claude' }),
  ];
  const entries = mergeEntries(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].description, 'claude text');
  assert.equal(entries[0].name, 'proj-init-claude');
  assert.deepEqual(entries[0].runtimes, ['claude', 'codex']);
});

test('case 2b: agents loses to codex when claude is absent', () => {
  const raw = [
    personal('zine', 'agents', { description: 'agents text' }),
    personal('zine', 'codex', { description: 'codex text' }),
  ];
  const [entry] = mergeEntries(raw);
  assert.equal(entry.description, 'codex text');
  assert.deepEqual(entry.runtimes, ['codex', 'agents']);
});

// ---------------------------------------------------------------------------
// 3. blocklist drops a matching marketplace AND a matching slug
// ---------------------------------------------------------------------------

test('case 3: applyBlocklist drops a matching marketplace and a matching slug', () => {
  const blocklist = { marketplacePatterns: [/blockedmarket/i], slugs: ['blocked-slug'] };
  const raw = [
    personal('keeper', 'claude'),
    personal('blocked-slug', 'claude'),
    marketplace('plugin-skill', 'BlockedMarket-common'),
    marketplace('other-plugin-skill', 'public-market'),
  ];
  const kept = applyBlocklist(raw, blocklist);
  assert.deepEqual(
    kept.map((e) => e.slug),
    ['keeper', 'other-plugin-skill'],
  );
});

// ---------------------------------------------------------------------------
// 4. the REAL BLOCKLIST constant
// ---------------------------------------------------------------------------

test('case 4: the real BLOCKLIST constant blocks the work slug and the org marketplace', () => {
  assert.ok(
    BLOCKLIST.slugs.includes(WORK_SKILL_SLUG),
    'BLOCKLIST.slugs must contain the work-skill slug',
  );
  assert.equal(WORK_SKILL_SLUG, 'offline-read-telemetry-policy');
  assert.ok(BLOCKLIST.marketplacePatterns.length >= 1);
  // Pattern match, not exact string: any marketplace key containing the org name.
  assert.equal(isBlockedOrigin('exowatt-common', BLOCKLIST), true);
  assert.equal(isBlockedOrigin('EXOWATT-labs', BLOCKLIST), true);
  assert.equal(isBlockedOrigin('claude-plugins-official', BLOCKLIST), false);
  assert.equal(isBlockedOrigin('personal', BLOCKLIST), false);
  // And the real constant actually removes both shapes.
  const kept = applyBlocklist([
    personal(WORK_SKILL_SLUG, 'claude'),
    marketplace('branding', 'exowatt-common'),
    personal('grilling', 'claude'),
  ]);
  assert.deepEqual(
    kept.map((e) => e.slug),
    ['grilling'],
  );
});

// ---------------------------------------------------------------------------
// 5. personal beats marketplace on slug collision
// ---------------------------------------------------------------------------

test('case 5: personal origin beats marketplace on slug collision', () => {
  const raw = [
    marketplace('grilling', 'claude-plugins-official', { description: 'marketplace copy' }),
    personal('grilling', 'claude', { description: 'personal copy' }),
  ];
  const entries = mergeEntries(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].origin, 'personal');
  assert.equal(entries[0].description, 'personal copy');
  assert.deepEqual(entries[0].runtimes, ['claude']);
});

test('case 5b: marketplace-vs-marketplace collision resolves alphabetically, order-independently', () => {
  const forward = [
    marketplace('doc-helper', 'claude-plugins-official', { description: 'official copy' }),
    marketplace('doc-helper', 'anthropic-agent-skills', { description: 'anthropic copy' }),
  ];
  const first = mergeEntries(forward);
  assert.equal(first.length, 1, 'a same-slug marketplace collision collapses to one entry');
  assert.equal(first[0].origin, 'anthropic-agent-skills', 'origins tie-break alphabetically');
  assert.equal(first[0].description, 'anthropic copy');

  // Reversed input order must produce exactly the same entry: discovery order
  // must never decide the winner.
  const second = mergeEntries([...forward].reverse());
  assert.deepEqual(second, first);
});

// ---------------------------------------------------------------------------
// 6. hash-version manifest path resolves via installPath
// ---------------------------------------------------------------------------

test('case 6: hash-version manifest path resolves via installPath (user scope preferred)', () => {
  const home = makeTempDir();
  const userPath = path.join(
    home,
    '.claude/plugins/cache/anthropic-agent-skills/document-skills/f6656c1256d5',
  );
  const projectPath = path.join(
    home,
    '.claude/plugins/cache/anthropic-agent-skills/document-skills/f17010c9bb48',
  );
  fs.mkdirSync(path.join(userPath, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'skills'), { recursive: true });

  const manifest = {
    version: 1,
    plugins: {
      'document-skills@anthropic-agent-skills': [
        { scope: 'project', installPath: projectPath },
        { scope: 'user', installPath: userPath },
      ],
    },
  };

  const sources = discoverSources(home, manifest);
  const plugin = sources.find((s) => s.id.includes('document-skills'));
  assert.ok(plugin, 'plugin root must be registered');
  assert.equal(plugin.root, path.join(userPath, 'skills'));
  assert.equal(plugin.origin, 'anthropic-agent-skills');
  assert.equal(plugin.runtime, 'claude');
});

test('case 6c: a user-scope record without installPath falls back to a usable record', () => {
  const home = makeTempDir();
  const projectPath = path.join(home, '.claude/plugins/cache/claude-plugins-official/codex/1.0.0');
  fs.mkdirSync(path.join(projectPath, 'skills'), { recursive: true });

  const manifest = {
    version: 1,
    plugins: {
      // The preferred user-scope record is unusable: it carries no installPath.
      // It must not short-circuit the fallback and silently drop the plugin.
      'codex@claude-plugins-official': [
        { scope: 'user' },
        { scope: 'project', installPath: projectPath },
      ],
    },
  };

  const plugin = discoverSources(home, manifest).find((s) => s.id.startsWith('plugin:codex@'));
  assert.ok(plugin, 'the plugin must still be registered via the usable record');
  assert.equal(plugin.root, path.join(projectPath, 'skills'));
});

test('case 6b: discoverSources registers the three personal roots with runtimes', () => {
  const home = makeTempDir();
  const sources = discoverSources(home, { version: 1, plugins: {} });
  assert.deepEqual(
    sources.map((s) => [s.runtime, s.origin, s.root]),
    [
      ['claude', 'personal', path.join(home, '.claude/skills')],
      ['codex', 'personal', path.join(home, '.codex/skills')],
      ['agents', 'personal', path.join(home, '.agents/skills')],
    ],
  );
});

// ---------------------------------------------------------------------------
// 7. frontmatter present but fieldless -> directory-name fallback
// ---------------------------------------------------------------------------

test('case 7: fieldless frontmatter falls back to the directory name', () => {
  const parsed = parseSkillMd('---\nversion: 1\n---\n\nBody\n', 'my-skill');
  assert.deepEqual(parsed, { name: 'my-skill', description: '' });

  assert.deepEqual(parseSkillMd('no frontmatter at all\n', 'other-skill'), {
    name: 'other-skill',
    description: '',
  });
  assert.deepEqual(parseSkillMd('---\n: : broken: [\n---\n', 'broken-skill'), {
    name: 'broken-skill',
    description: '',
  });
});

test('case 7b: parseSkillMd tolerates quoted, multiline and Chinese descriptions', () => {
  assert.equal(
    parseSkillMd('---\nname: a\ndescription: "Quoted: with colon"\n---\n', 'a').description,
    'Quoted: with colon',
  );
  assert.equal(
    parseSkillMd('---\nname: b\ndescription: >-\n  folded line one\n  line two\n---\n', 'b')
      .description,
    'folded line one line two',
  );
  assert.equal(
    parseSkillMd('---\nname: c\ndescription: 中文描述，逗号与全角字符\n---\n', 'c').description,
    '中文描述，逗号与全角字符',
  );
  assert.equal(
    parseSkillMd('---\r\nname: d\r\ndescription: crlf safe\r\n---\r\n', 'd').description,
    'crlf safe',
  );
});

// ---------------------------------------------------------------------------
// 8. symlinked skill DIRECTORY is discovered
// ---------------------------------------------------------------------------

test('case 8: a symlink pointing at a directory containing SKILL.md is discovered', () => {
  const store = makeTempDir();
  const realDir = path.join(store, 'real-zine-skill');
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(
    path.join(realDir, 'SKILL.md'),
    frontmatter('photo-anchored-zine', 'A zine skill'),
  );

  const root = path.join(makeTempDir(), 'skills');
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(realDir, path.join(root, 'photo-anchored-zine'), 'dir');

  // The real ~/.agents shape: the entry is a symlink and reports isDirectory() === false.
  const dirent = fs
    .readdirSync(root, { withFileTypes: true })
    .find((d) => d.name === 'photo-anchored-zine');
  assert.equal(dirent.isSymbolicLink(), true);
  assert.equal(dirent.isDirectory(), false, 'fixture must reproduce the symlink Dirent trap');

  const { entries, skipped } = scanRoot({
    id: 'personal:agents',
    root,
    origin: 'personal',
    runtime: 'agents',
  });
  assert.deepEqual(skipped, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, 'photo-anchored-zine');
  assert.equal(entries[0].description, 'A zine skill');
  assert.equal(entries[0].runtime, 'agents');
});

// ---------------------------------------------------------------------------
// 9. missing / unreadable SKILL.md is skipped, not fatal
// ---------------------------------------------------------------------------

test('case 9: directories without a readable SKILL.md are skipped and counted', (t) => {
  const root = path.join(makeTempDir(), 'skills');
  fs.mkdirSync(root, { recursive: true });
  writeSkill(root, 'good-skill', frontmatter('good-skill', 'Fine'));
  fs.mkdirSync(path.join(root, 'codex-primary-runtime'), { recursive: true }); // empty dir
  fs.writeFileSync(path.join(root, 'README.md'), 'not a skill'); // stray file
  // A DIRECTORY named SKILL.md: statSync succeeds but it is not a file.
  fs.mkdirSync(path.join(root, 'dir-shaped-skill', 'SKILL.md'), { recursive: true });

  const unreadable = writeSkill(root, 'unreadable-skill', frontmatter('x', 'y'));
  let unreadableCovered = false;
  if (process.getuid?.() !== 0) {
    fs.chmodSync(path.join(unreadable, 'SKILL.md'), 0o000);
    unreadableCovered = true;
    t.after(() => fs.chmodSync(path.join(unreadable, 'SKILL.md'), 0o600));
  }

  const { entries, skipped } = scanRoot({
    id: 'personal:claude',
    root,
    origin: 'personal',
    runtime: 'claude',
  });
  assert.deepEqual(
    entries.map((e) => e.slug),
    ['good-skill'],
  );
  const skippedNames = skipped.map((s) => path.basename(s.path)).sort();
  const expected = ['README.md', 'codex-primary-runtime', 'dir-shaped-skill'];
  if (unreadableCovered) expected.push('unreadable-skill');
  assert.deepEqual(skippedNames, expected.sort());
  assert.ok(
    skipped.some((s) => path.basename(s.path) === 'dir-shaped-skill'),
    'a directory named SKILL.md is skipped, not fatal',
  );
});

test('case 9b: a missing root yields nothing instead of throwing', () => {
  const { entries, skipped } = scanRoot({
    id: 'personal:agents',
    root: path.join(makeTempDir(), 'does-not-exist'),
    origin: 'personal',
    runtime: 'agents',
  });
  assert.deepEqual(entries, []);
  assert.deepEqual(skipped, []);
});

// ---------------------------------------------------------------------------
// 10. stable ordering; unchanged entries preserve generatedAt
// ---------------------------------------------------------------------------

test('case 10: toStableJson sorts by slug, fixes key order and preserves generatedAt', () => {
  const entries = [
    { slug: 'zebra', name: 'zebra', description: 'z', runtimes: ['codex'], origin: 'personal' },
    { slug: 'alpha', name: 'alpha', description: 'a', runtimes: ['claude'], origin: 'personal' },
  ];
  const first = toStableJson(entries, null, '2026-01-01T00:00:00Z');
  const parsed = JSON.parse(first);
  assert.deepEqual(
    parsed.entries.map((e) => e.slug),
    ['alpha', 'zebra'],
  );
  assert.deepEqual(Object.keys(parsed.entries[0]), [
    'slug',
    'name',
    'description',
    'runtimes',
    'origin',
  ]);
  assert.equal(parsed.generatedAt, '2026-01-01T00:00:00Z');
  assert.ok(first.endsWith('\n'));
  assert.ok(first.includes('\n  "entries"'), 'expected 2-space indentation');

  // Same entries in a different input order -> byte-identical output, old timestamp kept.
  const second = toStableJson([...entries].reverse(), first, '2026-09-09T09:09:09Z');
  assert.equal(second, first);

  // Changed entries -> new timestamp.
  const third = toStableJson(
    [...entries, { slug: 'new', name: 'new', description: 'n', runtimes: ['claude'], origin: 'personal' }],
    first,
    '2026-09-09T09:09:09Z',
  );
  assert.equal(JSON.parse(third).generatedAt, '2026-09-09T09:09:09Z');

  // Corrupt previous file must not throw.
  assert.equal(JSON.parse(toStableJson(entries, '{not json', '2026-09-09T09:09:09Z')).generatedAt,
    '2026-09-09T09:09:09Z');
});

// ---------------------------------------------------------------------------
// 11. matchesDenylist
// ---------------------------------------------------------------------------

test('case 11: matchesDenylist flags a synthetic term in any field, case-insensitively', () => {
  const terms = SYNTHETIC_TERMS;
  assert.equal(matchesDenylist({ slug: 'a', description: 'about AcmeCorp things' }, terms), true);
  assert.equal(matchesDenylist({ slug: 'zorblex-helper', description: 'x' }, terms), true);
  assert.equal(matchesDenylist({ name: 'PLUMBUS' }, terms), true);
  assert.equal(matchesDenylist({ nested: { deep: ['fizzbin'] } }, terms), true);
  assert.equal(matchesDenylist({ slug: 'grilling', description: 'harmless' }, terms), false);
  assert.equal(matchesDenylist({ slug: 'grilling' }, []), false);
  // Empty / whitespace-only terms never match anything.
  assert.equal(matchesDenylist({ slug: 'anything' }, ['', '   ']), false);
});

test('case 11b: parseDenylist strips comments and blank lines and lowercases', () => {
  const { terms, rawLines } = parseDenylist(
    '# a comment\nAcmeCorp\n\n  Zorblex  \n#another\nplumbus\nacmecorp\n',
  );
  assert.deepEqual(terms, ['acmecorp', 'zorblex', 'plumbus']);
  // rawLines keeps the pre-normalization text of every non-comment, non-blank
  // line, each with its 1-based FILE line number (comments/blanks are dropped
  // from the array, so an array index would point a human at the wrong line).
  assert.deepEqual(rawLines, [
    { text: 'AcmeCorp', lineNo: 2 },
    { text: '  Zorblex  ', lineNo: 4 },
    { text: 'plumbus', lineNo: 6 },
    { text: 'acmecorp', lineNo: 7 },
  ]);
});

// ---------------------------------------------------------------------------
// 12. manifest plugin without a skills/ directory is skipped at discovery
// ---------------------------------------------------------------------------

test('case 12: a manifest plugin whose installPath has no skills/ dir is never registered', () => {
  const home = makeTempDir();
  const withSkills = path.join(home, '.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0');
  const withoutSkills = path.join(home, '.claude/plugins/cache/claude-plugins-official/swift-lsp/1.0.0');
  fs.mkdirSync(path.join(withSkills, 'skills'), { recursive: true });
  fs.mkdirSync(withoutSkills, { recursive: true });

  const manifest = {
    version: 1,
    plugins: {
      'superpowers@claude-plugins-official': [{ scope: 'user', installPath: withSkills }],
      'swift-lsp@claude-plugins-official': [{ scope: 'user', installPath: withoutSkills }],
      'ghost@claude-plugins-official': [{ scope: 'user', installPath: path.join(home, 'nope') }],
    },
  };

  const ids = discoverSources(home, manifest).map((s) => s.id);
  assert.ok(ids.includes('plugin:superpowers@claude-plugins-official'));
  assert.ok(!ids.some((id) => id.includes('swift-lsp')), 'plugin without skills/ must be skipped');
  assert.ok(!ids.some((id) => id.includes('ghost')), 'plugin with a missing installPath must be skipped');
});

// ---------------------------------------------------------------------------
// 13-16, 19. denylistGate
// ---------------------------------------------------------------------------

const cleanPre = [personal('grilling', 'claude'), personal('herdr', 'claude')];
const cleanPost = [
  { slug: 'grilling', name: 'grilling', description: 'harmless', runtimes: ['claude'], origin: 'personal' },
];
// Healthy synthetic list, built the way production builds it (terms + rawLines).
const SYNTH = parseDenylist(SYNTHETIC_TERMS.join('\n'));

test('case 13: denylistGate refuses an under-floor term count', () => {
  assert.equal(DENYLIST_MIN_TERMS, 5);
  const underFloor = parseDenylist(SYNTHETIC_TERMS.slice(0, DENYLIST_MIN_TERMS - 1).join('\n'));
  const verdict = denylistGate({
    ...underFloor,
    preBlocklist: cleanPre,
    postBlocklist: cleanPost,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /minimum/i);
  assert.ok(!SYNTHETIC_TERMS.some((t) => verdict.reason.includes(t)), 'reason must not echo terms');

  // Omitting rawLines entirely is a wiring error, never a silently weaker gate.
  const unwired = denylistGate({ terms: SYNTH.terms, preBlocklist: cleanPre, postBlocklist: cleanPost });
  assert.equal(unwired.ok, false);
  assert.match(unwired.reason, /rawLines/);
});

test('case 14: denylistGate refuses a dead raw line and points at the FILE line', () => {
  // The self-test probes the RAW file lines, pre-normalization. A whitespace-only
  // line survives in the file but yields no term, so probing the already-parsed
  // terms would never see it — this is what makes the check non-tautological.
  // The fixture has a comment header, so rawLines indices and file line numbers
  // diverge: the culprit is rawLines[5] but FILE line 7. The reason must name 7.
  const { terms, rawLines } = parseDenylist(`# org terms\n${SYNTHETIC_TERMS.join('\n')}\n   \n`);
  assert.deepEqual(terms, SYNTHETIC_TERMS, 'the malformed line contributes no term');
  assert.equal(rawLines.length, SYNTHETIC_TERMS.length + 1, 'the malformed line survives raw');
  assert.equal(rawLines.at(-1).lineNo, 7);

  const verdict = denylistGate({ terms, rawLines, preBlocklist: cleanPre, postBlocklist: cleanPost });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /line 7/, 'reason names the file line, not the array index');
  assert.match(verdict.reason, /whitespace-only|malformed/i);
  assert.ok(!SYNTHETIC_TERMS.some((t) => verdict.reason.includes(t)), 'reason must not echo terms');

  // A healthy file's raw lines all pass the same probe.
  const healthy = parseDenylist(`# header\n${SYNTHETIC_TERMS.join('\n')}\n\n`);
  const ok = denylistGate({ ...healthy, preBlocklist: cleanPre, postBlocklist: cleanPost });
  assert.equal(ok.ok, true, ok.reason ?? '');
});

test('case 15: denylistGate refuses a post-blocklist output match', () => {
  const verdict = denylistGate({
    ...SYNTH,
    preBlocklist: cleanPre,
    postBlocklist: [
      ...cleanPost,
      { slug: 'leaky', name: 'leaky', description: 'mentions Plumbus', runtimes: ['claude'], origin: 'personal' },
    ],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /leaky/);
  assert.ok(!verdict.reason.toLowerCase().includes('plumbus'), 'reason must not echo the term');
});

test('case 16: denylistGate passes a healthy list with clean output', () => {
  const verdict = denylistGate({
    ...SYNTH,
    preBlocklist: cleanPre,
    postBlocklist: cleanPost,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warnings, []);
});

test('case 19: unflagged work skill warns without blocking; absent work skill is silent', () => {
  const withWorkSkill = denylistGate({
    ...SYNTH,
    preBlocklist: [...cleanPre, personal(WORK_SKILL_SLUG, 'claude')],
    postBlocklist: cleanPost,
  });
  assert.equal(withWorkSkill.ok, true, 'an incomplete list must never brick sync');
  assert.equal(withWorkSkill.warnings.length, 1);
  assert.match(withWorkSkill.warnings[0], /denylist/i);

  const withoutWorkSkill = denylistGate({
    ...SYNTH,
    preBlocklist: cleanPre,
    postBlocklist: cleanPost,
  });
  assert.deepEqual(withoutWorkSkill.warnings, []);

  // Present AND flagged by a term -> no warning either.
  const flagging = parseDenylist([...SYNTHETIC_TERMS, 'telemetry-policy'].join('\n'));
  const flagged = denylistGate({
    ...flagging,
    preBlocklist: [...cleanPre, personal(WORK_SKILL_SLUG, 'claude')],
    postBlocklist: cleanPost,
  });
  assert.equal(flagged.ok, true);
  assert.deepEqual(flagged.warnings, []);
});

// ---------------------------------------------------------------------------
// 17. --out semantics
// ---------------------------------------------------------------------------

test('case 17: previous state always comes from data/generated.json even with --out', () => {
  const cwd = makeTempDir();
  const dataFile = path.join(cwd, 'data', 'generated.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });

  const defaults = resolveSyncPaths({ cwd });
  assert.equal(defaults.writePath, dataFile);
  assert.equal(defaults.previousPath, dataFile);

  const redirected = resolveSyncPaths({ cwd, out: '/tmp/ss-a.json' });
  assert.equal(redirected.writePath, '/tmp/ss-a.json');
  assert.equal(redirected.previousPath, dataFile, '--out must not move the previous-state source');

  const relative = resolveSyncPaths({ cwd, out: 'build/out.json' });
  assert.equal(relative.writePath, path.join(cwd, 'build/out.json'));
  assert.equal(relative.previousPath, dataFile);

  // End-to-end: writing elsewhere still preserves generatedAt from data/generated.json.
  const entries = [
    { slug: 'alpha', name: 'alpha', description: 'a', runtimes: ['claude'], origin: 'personal' },
  ];
  const committed = toStableJson(entries, null, '2026-01-01T00:00:00Z');
  fs.writeFileSync(dataFile, committed);
  const previousJson = fs.readFileSync(redirected.previousPath, 'utf8');
  const written = toStableJson(entries, previousJson, '2026-12-31T23:59:59Z');
  assert.equal(written, committed);
});

// ---------------------------------------------------------------------------
// 18. reconciliation
// ---------------------------------------------------------------------------

test('case 18: reconcile enforces slug set equality and runtime conservation', () => {
  const rawPostBlocklist = [
    personal('alpha', 'claude'),
    personal('alpha', 'codex'),
    personal('beta', 'claude'),
    marketplace('gamma', 'claude-plugins-official'),
  ];
  const entries = mergeEntries(rawPostBlocklist);

  const good = reconcile({ rawPostBlocklist, entries });
  assert.equal(good.ok, true, good.errors.join('; '));

  // (a) a dropped slug is named
  const dropped = reconcile({
    rawPostBlocklist,
    entries: entries.filter((e) => e.slug !== 'beta'),
  });
  assert.equal(dropped.ok, false);
  assert.ok(dropped.errors.some((e) => e.includes('beta')), dropped.errors.join('; '));

  // (a) an invented slug is named
  const invented = reconcile({
    rawPostBlocklist,
    entries: [...entries, { slug: 'ghost', name: 'ghost', description: '', runtimes: ['claude'], origin: 'personal' }],
  });
  assert.equal(invented.ok, false);
  assert.ok(invented.errors.some((e) => e.includes('ghost')), invented.errors.join('; '));

  // (b) a broken runtime union that slug set equality would miss
  const brokenUnion = reconcile({
    rawPostBlocklist,
    entries: entries.map((e) => (e.slug === 'alpha' ? { ...e, runtimes: ['claude'] } : e)),
  });
  assert.equal(brokenUnion.ok, false);
  assert.ok(
    brokenUnion.errors.some((e) => /runtime conservation/i.test(e)),
    brokenUnion.errors.join('; '),
  );

  // There is deliberately no per-root "conservation" check: every wiring of it
  // compared a sum to itself (ship review rounds 1-2), and an unfalsifiable
  // check that reads as coverage is worse than none.
});

// ---------------------------------------------------------------------------
// End-to-end over temp fixtures: scan -> blocklist -> merge -> serialize
// ---------------------------------------------------------------------------

test('scan -> blocklist -> merge -> serialize round trip over temp fixtures', () => {
  const home = makeTempDir();
  const claudeRoot = path.join(home, '.claude/skills');
  const codexRoot = path.join(home, '.codex/skills');
  const agentsRoot = path.join(home, '.agents/skills');
  fs.mkdirSync(agentsRoot, { recursive: true });
  writeSkill(claudeRoot, 'grilling', frontmatter('grilling', 'Grill a plan'));
  writeSkill(claudeRoot, WORK_SKILL_SLUG, frontmatter(WORK_SKILL_SLUG, 'Work only'));
  writeSkill(codexRoot, 'grilling', frontmatter('grilling', 'Codex variant'));

  const linked = path.join(makeTempDir(), 'zine');
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, 'SKILL.md'), frontmatter('zine', 'Zine skill'));
  fs.symlinkSync(linked, path.join(agentsRoot, 'zine'), 'dir');

  const pluginPath = path.join(home, '.claude/plugins/cache/exowatt-common/branding/1.0.0');
  fs.mkdirSync(path.join(pluginPath, 'skills'), { recursive: true });
  writeSkill(path.join(pluginPath, 'skills'), 'branding', frontmatter('branding', 'Org branding'));

  const manifest = {
    version: 1,
    plugins: { 'branding@exowatt-common': [{ scope: 'user', installPath: pluginPath }] },
  };

  const sources = discoverSources(home, manifest);
  const raw = [];
  for (const source of sources) {
    const { entries } = scanRoot(source);
    raw.push(...entries);
  }
  // claude: grilling + work skill, codex: grilling, agents: zine, plugin: branding
  assert.equal(raw.length, 5);

  const kept = applyBlocklist(raw);
  assert.deepEqual(kept.map((e) => e.slug).sort(), ['grilling', 'grilling', 'zine']);

  const entries = mergeEntries(kept);
  assert.deepEqual(
    entries.map((e) => e.slug),
    ['grilling', 'zine'],
  );
  assert.deepEqual(entries[0].runtimes, ['claude', 'codex']);
  assert.equal(entries[0].description, 'Grill a plan');

  const rec = reconcile({ rawPostBlocklist: kept, entries });
  assert.equal(rec.ok, true, rec.errors.join('; '));

  const json = toStableJson(entries, null, '2026-08-16T00:00:00Z');
  assert.equal(JSON.parse(json).entries.length, 2);
});
