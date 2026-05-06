// SPDX-License-Identifier: MIT
// tests/vitest/_parity-helpers.js — shared helpers for parity.test.js (v0.9 step 5).
//
// Used by the 4 sub-checks in parity.test.js to:
//   1. Extract `--flag-name` literals from orchestrator parseArgs sources.
//   2. Extract `--flag-name` declarations from SUBCOMMAND_HELP text blocks.
//   3. Parse the README "Flag reference" table.
//   4. Normalize JSON envelopes for snapshot stability (strip timestamps,
//      durations, run-ids, absolute paths).
//   5. Drive `node bin/kmp-test.js <sub> --json …` and parse the envelope.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const BIN_PATH = path.join(REPO_ROOT, 'bin', 'kmp-test.js');

// Subcommand → orchestrator file. doctor lives inline in lib/cli.js and has
// no orchestrator file, so its flag set is parsed from cli.js#runDoctor.
export const SUBCOMMAND_TO_ORCHESTRATOR = Object.freeze({
  parallel:  'lib/parallel-orchestrator.js',
  changed:   'lib/changed-orchestrator.js',
  android:   'lib/android-orchestrator.js',
  benchmark: 'lib/benchmark-orchestrator.js',
  coverage:  'lib/coverage-orchestrator.js',
  doctor:    null,
  info:      'lib/info-orchestrator.js',
  describe:  'lib/describe-orchestrator.js',
  update:    'lib/update-orchestrator.js',
});

// Flags handled at lib/cli.js global level (before reaching the orchestrator).
// Orchestrators may also declare defensive `case` arms for these, but the
// canonical parser is in cli.js. Used to reconcile sub-check 1: a flag in
// SUBCOMMAND_HELP that's only parsed at cli.js level still counts as "parsed".
export const CLI_GLOBAL_FLAGS = Object.freeze(new Set([
  '--project-root',
  '--json',
  '--format',         // `--format json` accepted as alias for `--json`
  '--dry-run',
  '--help',
  '--version',
  '--ignore-jdk-mismatch',
  '--java-home',
  '--no-jdk-autoselect',
  '--force',
]));

// Flags that appear as quoted string literals in orchestrator source but are
// NOT user-facing CLI surface — they're either gradle/git command-line tokens
// emitted by the orchestrator, internal pass-throughs from sibling orchestrators,
// or arg-stripper checks. Per-subcommand because the same literal can mean
// different things across orchestrators (e.g. `--config` is gradle's task
// switch in parallel but a user flag in benchmark).
export const ORCHESTRATOR_INTERNAL_LITERALS = Object.freeze({
  parallel: new Set([
    '--no-coverage',         // arg-stripper: rewrites to --coverage-tool none upstream
    '--stop',                // emitted: gradlew --stop (daemon shutdown)
    '--config',              // emitted: gradlew :module:benchmark --config <name>
    '--benchmark-config',    // internal pass-through from `benchmark` subcommand
  ]),
  changed: new Set([
    '--module-filter',       // emitted: changed forwards a resolved filter to parallel
    '--no-coverage',         // emitted: changed forwards to parallel
    '--is-inside-work-tree', // emitted: git rev-parse --is-inside-work-tree
    '--cached',              // emitted: git diff --cached
    '--name-only',           // emitted: git diff --name-only
    '--porcelain',           // emitted: git status --porcelain
  ]),
  coverage: new Set([
    '--no-coverage',         // arg-stripper
  ]),
  benchmark: new Set([]),
  android: new Set([]),
  info: new Set([]),
  describe: new Set([]),
  update: new Set([]),
});

// Gradle / external-tool command-line tokens that orchestrators emit as args.
// Always-on subtraction across every subcommand.
export const GRADLE_PASSTHROUGH_FLAGS = Object.freeze(new Set([
  '--tests', '--no-parallel', '--continue', '--info', '--debug',
  '--scan', '--profile', '--quiet', '--no-daemon', '--stacktrace',
  '--full-stacktrace', '--rerun-tasks', '--no-build-cache',
  '--no-configuration-cache', '--configuration-cache', '--build-cache',
  '--max-workers', '--parallel', '--offline', '--refresh-dependencies',
  '--project-cache-dir',
]));

// Extract all flag literals (`--[a-z][a-z0-9-]+`) referenced in a JS source
// file as quoted string literals. Catches both `case '--x':` and
// `if (a === '--x')` forms that the orchestrators use.
export function extractFlagsFromOrchestratorSource(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const flags = new Set();
  for (const m of src.matchAll(/['"](--[a-z][a-z0-9-]+)['"]/g)) {
    flags.add(m[1]);
  }
  return flags;
}

// Extract documented flag names from a SUBCOMMAND_HELP text block. Only matches
// flag declarations at the canonical 2-space indent under "Options:" — excludes
// example lines (deeper indent or zero indent) and description prose that
// happens to mention `--xxx` tokens (e.g. "uses gradle --tests").
//
// Algorithm: a line is a flag declaration if it begins with exactly two
// spaces followed by `--<name>`. The "flag column" is everything from the
// flag start until the first run of 2+ whitespace (which separates flags from
// the description column in the canonical layout). All `--xxx` tokens within
// the flag column are extracted, so multi-flag rows like `--list | --list-only`
// capture both aliases without polluting from description prose.
export function extractFlagsFromHelpText(helpText) {
  const flags = new Set();
  for (const line of helpText.split('\n')) {
    if (!line.startsWith('  --')) continue;
    const flagColumn = line.slice(2).split(/\s{2,}/)[0];
    for (const m of flagColumn.matchAll(/--[a-z][a-z0-9-]+/g)) flags.add(m[0]);
  }
  return flags;
}

// Parse all flag references in the README. Returns the set of flag names
// documented in:
//   1. Any markdown table row whose column 1 starts with a backtick-flag
//      (e.g. `| `--xxx` | default | description |`).
//   2. Any heading of the form `### `--xxx` — …` (the README documents some
//      flags as their own subsection, e.g. `### `--dry-run` — what would run`).
//
// Flags only mentioned in free-text prose are NOT counted. Add them to the
// `parity-allowlist.json` `readmeProsePresent` set if intentional.
export function parseReadmeFlagTable(readmePath) {
  const md = readFileSync(readmePath, 'utf8');
  const flags = new Set();

  // Source 1: flag-table rows. A row is a line that starts with `| ` followed
  // by a backtick-flag. Restrict extraction to COLUMN 1 (text between the
  // first and second `|`) so alias rows like `| \`--variant\` / \`--android-variant\` |
  // …` capture both flags but description-column flag mentions
  // (e.g. "Run gradle with \`--project-cache-dir\`") don't false-positive.
  for (const line of md.split('\n')) {
    if (!/^\|\s*`--/.test(line)) continue;
    const cols = line.split('|');
    if (cols.length < 2) continue;
    const flagColumn = cols[1] || '';
    for (const m of flagColumn.matchAll(/`(--[a-z][a-z0-9-]+)/g)) flags.add(m[1]);
  }

  // Source 2: per-flag section headings — `### `--xxx[ <arg>]`` etc.
  // The flag may be followed by a `<arg>` placeholder before the closing
  // backtick (e.g. `### `--test-filter <pattern>` — …`).
  for (const m of md.matchAll(/^#{2,4}\s+`(--[a-z][a-z0-9-]+)/gm)) {
    flags.add(m[1]);
  }

  return flags;
}

// Normalize a kmp-test JSON envelope so snapshots stay stable across runs.
// Volatile fields (durations, timestamps, the project_root path, version)
// become symbolic placeholders. Recursive — descends into arrays/objects.
export function normalizeEnvelopeForSnapshot(envelope, projectRoot) {
  const root = projectRoot ? path.resolve(projectRoot) : null;
  const rootForwardSlashes = root ? root.replace(/\\/g, '/') : null;
  const VOLATILE_KEY = /^(duration_ms|run_id|run-id|runId|started_at|started-at|startedAt|generated_at|generated-at|generatedAt|timestamp|finished_at|finished-at|finishedAt)$/i;

  function walk(v) {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      let s = v;
      if (root && s.includes(root)) s = s.split(root).join('<PROJECT_ROOT>');
      if (rootForwardSlashes && s.includes(rootForwardSlashes)) s = s.split(rootForwardSlashes).join('<PROJECT_ROOT>');
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === 'project_root') {
          out[k] = '<PROJECT_ROOT>';
        } else if (k === 'version' && typeof val === 'string' && /^\d+\.\d+\.\d+/.test(val)) {
          // Top-level kmp-test version — pin via placeholder so snapshot
          // doesn't churn on every package.json bump.
          out[k] = '<KMP_TEST_VERSION>';
        } else if (VOLATILE_KEY.test(k)) {
          out[k] = `<${k.toUpperCase()}>`;
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  }

  return walk(envelope);
}

// Build a synthetic project fixture sufficient to drive every subcommand's
// "lightest mode" without spawning gradle. Returns the absolute path of the
// fixture root. Caller is responsible for cleanup (rmSync recursive).
//
// The fixture has:
//   - gradlew + gradlew.bat (so doctor doesn't fail)
//   - settings.gradle.kts (so describe doesn't bail with no_project)
//   - one KMP module ":mod" with commonMain/jvmMain/jvmTest source sets
//     (so parallel/changed/benchmark have something to plan against)
//
// The gradlew scripts exit 1 — they're never invoked because every subcommand
// runs in a no-spawn mode (--dry-run / --list-only / --check / --skip-probe).
export function makeFixtureProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'kmp-parity-'));
  writeFileSync(path.join(root, 'gradlew'), '#!/usr/bin/env bash\nexit 1\n');
  writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\r\nexit /b 1\r\n');
  writeFileSync(path.join(root, 'settings.gradle.kts'),
    'rootProject.name = "parity-fixture"\ninclude(":mod")\n');
  mkdirSync(path.join(root, 'mod'), { recursive: true });
  writeFileSync(path.join(root, 'mod', 'build.gradle.kts'),
    `plugins {\n  kotlin("multiplatform")\n}\n\nkotlin {\n  jvm()\n  sourceSets {\n    val commonMain by getting\n    val jvmMain by getting\n    val jvmTest by getting\n  }\n}\n`);
  for (const ss of ['commonMain', 'jvmMain', 'jvmTest']) {
    mkdirSync(path.join(root, 'mod', 'src', ss, 'kotlin'), { recursive: true });
    writeFileSync(path.join(root, 'mod', 'src', ss, 'kotlin', '.gitkeep'), '');
  }
  return root;
}

// Spawn `node bin/kmp-test.js <subcommand> <...args>` and parse the JSON
// envelope from stdout. Returns { stdout, stderr, exitCode, envelope }.
// On parse failure envelope is null and stdout is preserved verbatim.
export function runSubcommand(subcommand, args = [], opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const result = spawnSync(process.execPath, [BIN_PATH, subcommand, ...args], {
    encoding: 'utf8',
    env,
    cwd: opts.cwd || REPO_ROOT,
    timeout: opts.timeout || 30_000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = typeof result.status === 'number' ? result.status : 1;

  let envelope = null;
  // Strategy 1: orchestrator-emitted envelope wrapped in sentinel markers
  // (lib/runner.js emits these around the JSON payload when --json is set).
  const SENTINEL_BEGIN = '__KMP_TEST_ENVELOPE_V1_BEGIN__';
  const SENTINEL_END = '__KMP_TEST_ENVELOPE_V1_END__';
  const sIdx = stdout.lastIndexOf(SENTINEL_BEGIN);
  if (sIdx >= 0) {
    const after = stdout.slice(sIdx + SENTINEL_BEGIN.length);
    const eIdx = after.indexOf(SENTINEL_END);
    if (eIdx >= 0) {
      try { envelope = JSON.parse(after.slice(0, eIdx).trim()); } catch { /* ignore */ }
    }
  }
  // Strategy 2: cli.js emitJson() — single JSON object on stdout, no sentinel.
  // Used by doctor / info / describe / update / coverage / dry-run paths.
  if (!envelope) {
    const trimmed = stdout.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { envelope = JSON.parse(trimmed); } catch { /* ignore */ }
    }
  }
  // Strategy 3: find the last balanced { ... } block.
  if (!envelope) {
    const openIdx = stdout.lastIndexOf('\n{');
    if (openIdx >= 0) {
      try { envelope = JSON.parse(stdout.slice(openIdx).trim()); } catch { /* ignore */ }
    }
  }

  return { stdout, stderr, exitCode, envelope };
}

// Helper for sub-check 1: collect the flag set documented in SUBCOMMAND_HELP[sub].
// SUBCOMMAND_HELP isn't exported from cli.js, so we regex over the source file
// to pull out the per-subcommand template string. Cheaper than dynamic-importing
// cli.js (which has side-effecty top-level code) and avoids the Windows-ESM
// absolute-path quirk for `await import()`.
export function getDocumentedFlagsForSubcommand(sub) {
  const cliSrc = readFileSync(path.join(REPO_ROOT, 'lib', 'cli.js'), 'utf8');
  const subRe = new RegExp(`^  ${sub}: \\\`([\\s\\S]*?)\\\`,$`, 'm');
  const m = cliSrc.match(subRe);
  if (!m) return new Set();
  return extractFlagsFromHelpText(m[1]);
}

// Shared parsers in lib/orchestrator-utils.js that several orchestrators
// delegate to via import + call. The shared parser eats its flags BEFORE the
// orchestrator's own parseArgs runs, so the literals never appear in the
// orchestrator file's source — but they ARE user-facing flags for that
// subcommand. Registering them here lets sub-check 1 surface drift.
//
// New shared parsers added to orchestrator-utils must register here, listing
// the flag set + the subcommands that import the parser.
export const SHARED_PARSER_FLAGS = Object.freeze({
  parseIsolatedArgs: {
    flags: new Set(['--isolated', '--isolated-cache-dir', '--isolated-no-lock']),
    usedBy: new Set(['parallel', 'changed', 'android', 'benchmark']),
  },
});

// Helper for sub-check 1: collect the flag set parsed for a subcommand. Union
// of (orchestrator's literals) + (cli.js literals when sub == 'doctor') +
// (cli.js global subset) + (shared parser literals when imported).
export function getParsedFlagsForSubcommand(sub) {
  const flags = new Set();
  // Add cli.js global flags — these are documented per-subcommand but parsed
  // at cli.js level. Without this, sub-check 1 would falsely flag every
  // `--project-root`/`--json`/`--help`/etc. mention as "documented but not
  // parsed by orchestrator".
  for (const f of CLI_GLOBAL_FLAGS) flags.add(f);
  // Orchestrator-side literals.
  const rel = SUBCOMMAND_TO_ORCHESTRATOR[sub];
  if (rel) {
    for (const f of extractFlagsFromOrchestratorSource(path.join(REPO_ROOT, rel))) {
      flags.add(f);
    }
  } else if (sub === 'doctor') {
    // doctor parses its args inline in lib/cli.js. Scan only the runDoctor
    // function body to avoid false positives from SUBCOMMAND_HELP literals.
    const cliSrc = readFileSync(path.join(REPO_ROOT, 'lib', 'cli.js'), 'utf8');
    const fnMatch = cliSrc.match(/function runDoctor\([\s\S]*?\n\}\n/);
    if (fnMatch) {
      for (const m of fnMatch[0].matchAll(/['"](--[a-z][a-z0-9-]+)['"]/g)) {
        flags.add(m[1]);
      }
    }
  }
  // Shared parsers — flags eaten by orchestrator-utils helpers BEFORE the
  // orchestrator's parseArgs runs.
  for (const [, def] of Object.entries(SHARED_PARSER_FLAGS)) {
    if (def.usedBy.has(sub)) {
      for (const f of def.flags) flags.add(f);
    }
  }
  return flags;
}
