#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/cli.mjs -- entrypoint for the reproducible skill evaluation harness.
//
// Usage:
//   node tools/agentic-eval/cli.mjs calibrate [--model <name>] [--private-patterns-file <path>]
//   node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
//                                          [--project-alias <alias>] [--model <name>]
//                                          [--private-patterns-file <path>]
//   node tools/agentic-eval/cli.mjs corpus validate
//   node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
//   node tools/agentic-eval/cli.mjs validate --run <path-to-run.json>
//   node tools/agentic-eval/cli.mjs --help
//
// Every measured run is benchmark_eligible:false (calibration/smoke) -- this PR does not execute
// the full benchmark; `smoke` runs exactly one scenario to prove the harness works end-to-end,
// never publishing a ratio or performance claim.
//
// No committable evidence is ever written before ALL of: schema validation, a fresh
// policy_sha256 match against the CURRENT policy-hook.mjs, the privacy fail-closed check
// (assertCleanOrThrow), and the run-kind's hard acceptance gate all pass -- see
// finalizeAndWriteRecords(). Any failure writes nothing and reports why.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { CURRENT_RUN_SCHEMA, validateRun, validateScenario, validateTriggerQueries } from './schemas.mjs';
import { buildEvalEnv } from './env-builder.mjs';
import { buildPathShim } from './path-shim.mjs';
import { materializeSkillSnapshot, materializeCalibrationProject, materializeScenarioProject, materializeGradleUserHome, removeScenarioWorktree, realpath } from './materialize.mjs';
import { buildBaseArgv, buildConditionArgv, buildSharedEnv, buildPolicySettingsFile, spawnCondition } from './condition-launcher.mjs';
import { parseStreamJsonl, findInitEvent, findResultEvent, isSkillAvailable, findSkillInvocation, findBashToolUses, findBashToolUsesWithResults, findUnexpectedToolUses, hasExpectedToolProfile, countHookEvents, computeByteMetrics, extractTokenUsage } from './stream-parser.mjs';
import { aggregateRuns } from './aggregate.mjs';
import { assertCleanOrThrow, assertCleanOrThrowObject, loadPrivateRules } from './privacy.mjs';
import { tokenize } from './policy-hook.mjs';
import { runValidator as runPluginValidator } from '../validate-plugin.mjs';

// dirname(fileURLToPath(...)), not import.meta.dirname -- the latter needs Node 20.11+/21.2+,
// but package.json declares "node": ">=18" (confirmed to actually matter on a real ubuntu-latest
// CI job -- see condition-launcher.mjs's identical fix for the full story).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const PINNED_SKILL_SHA = 'aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee';
// KMP_EVAL_RUNS_ROOT override exists specifically so tests never write to (or, worse, clean up
// inside) the real committable tools/runs/ directory -- an earlier version of the integration
// test suite listed and deleted files directly under the real RUNS_ROOT, including an
// unconditional recursive delete of the whole raw/ subdirectory in its own afterEach. Redirecting
// this makes that class of bug structurally impossible rather than relying on the test being
// careful.
const RUNS_ROOT = process.env.KMP_EVAL_RUNS_ROOT || join(REPO_ROOT, 'tools', 'runs');
// Only the DEFAULT root is covered by .gitignore's `tools/runs/agentic-eval-*/raw/**` pattern.
// KMP_EVAL_RUNS_ROOT is a test-only escape hatch (see above) -- nothing stops it from being set
// to a path outside that glob, which would leave raw (unredacted, absolute-path-bearing)
// transcripts unprotected by gitignore if anything were ever staged from there. Recorded (see
// buildRunRecord's raw_capture_location/errors below) rather than silently assumed safe -- never
// via the actual override path itself, which could itself be privacy-sensitive.
//
// Compared via realpath, never bare string equality -- an independent review pass reproduced
// concretely that a path pointing at the EXACT SAME physical directory (a relative
// `KMP_EVAL_RUNS_ROOT=tools\runs`, one with a trailing separator, a different Windows casing, or
// a junction) still classified as "not default" under a textual comparison, silently bypassing
// BOTH the dirty_harness_tooling fail-closed gate (findBlockingHarnessToolingDirty) added for
// exactly the official/committable location AND the raw_capture_location honesty check, while
// still physically writing evidence into the real, official tools/runs/ tree. realpathSync
// resolves relative segments, trailing separators, symlinks/junctions, AND (on Windows, whose
// filesystem is case-insensitive but case-preserving) always returns the canonical on-disk
// casing regardless of how the input path was spelled -- so a single realpath-based comparison
// closes all of those variants at once, without needing a separate manual .toLowerCase() step.
//
// Extracted as a named, parameterized, independently-testable function (mirroring
// findBlockingHarnessToolingDirty's own rationale) specifically so path-equivalence variants
// (relative paths, trailing separators, differently-cased inputs) can be unit-tested directly with
// arbitrary values, without needing a real subprocess with a manipulated KMP_EVAL_RUNS_ROOT env
// var and cwd just to exercise this one computation.
//
// realpathSync alone does NOT close the Windows-casing variant the way it was first assumed to --
// confirmed empirically on this exact Node/Windows combination: realpathSync('...\TOOLS\RUNS')
// (uppercase input) resolves successfully (NTFS lookup is case-insensitive) but returns the INPUT
// casing verbatim, not the canonical on-disk casing, so a plain `===` after realpath still missed
// this specific variant. Case-folded explicitly, but ONLY on win32: doing this unconditionally
// would risk a false POSITIVE on a genuinely case-sensitive filesystem (treating two distinct,
// differently-cased directories as the same) -- acceptable here specifically because the
// consequence of that false positive is erring toward the SAFER direction (treating something as
// "default" engages the stricter fail-closed checks, never the reverse), unlike a general
// containment check where a false positive could wrongly APPROVE something.
function isRunsRootDefault(runsRoot, repoRoot) {
  try {
    const a = realpath(runsRoot);
    const b = realpath(join(repoRoot, 'tools', 'runs'));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    // Either side couldn't be resolved (doesn't exist yet, permissions, ...) -- can't positively
    // confirm they're DIFFERENT locations, so err toward the safer assumption: treat as default,
    // engaging the stricter checks rather than letting an unresolvable path silently bypass them.
    return true;
  }
}
const RUNS_ROOT_IS_DEFAULT = isRunsRootDefault(RUNS_ROOT, REPO_ROOT);

const HELP = `tools/agentic-eval/cli.mjs -- reproducible skill evaluation harness

Usage:
  node tools/agentic-eval/cli.mjs calibrate [--model <name>] [--private-patterns-file <path>]
  node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
                                         [--project-alias <alias>] [--model <name>]
                                         [--private-patterns-file <path>]
  node tools/agentic-eval/cli.mjs corpus validate
  node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
  node tools/agentic-eval/cli.mjs validate --run <path>
  node tools/agentic-eval/cli.mjs --help

Every run this PR's subcommands can produce is benchmark_eligible:false. This is a foundation
harness, not a benchmark -- see tools/agentic-eval/README.md. No evidence is committable until
schema, policy-hash freshness, privacy, and the run-kind's hard acceptance gate all pass.
`;

/**
 * Every `--flag` here (other than --help/-h) requires a value. A flag with no following
 * argument, or immediately followed by another `--flag` (never consumed as that flag's value),
 * is recorded in `errors` rather than silently assigned `undefined` -- an undefined value
 * previously fell through `?? null` fallbacks unnoticed, so e.g. a trailing
 * `--private-patterns-file` with nothing after it silently disabled private-pattern redaction
 * and reported the run as 'public' instead of failing loudly. A flag provided more than once is
 * also an error (silent last-wins previously masked what's very likely a copy-paste mistake).
 * Callers must check `errors.length > 0` before doing anything else. This function is
 * deliberately unaware of which SUBCOMMAND is being parsed -- an unknown-but-well-formed flag
 * name (e.g. a typo like `--private-pattern-file`, missing the 's') is NOT rejected here; see
 * `validateSubcommandArgs()`, which requires the subcommand to already be known.
 */
function parseArgs(argv) {
  const out = { _: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.errors.push(`--${name} requires a value`);
        continue;
      }
      if (name in out) {
        out.errors.push(`--${name} was provided more than once`);
      }
      out[name] = next;
      i++;
      continue;
    }
    out._.push(a);
  }
  return out;
}

// Every recognized flag per subcommand, plus how many extra positional arguments (beyond the
// subcommand name itself) it consumes. A typo'd flag name (e.g. --private-pattern-file, missing
// the 's') previously parsed with ZERO errors and silently behaved as if the flag had never been
// supplied at all -- cmdCalibrate/cmdSmoke only ever read the CORRECTLY-spelled key, so a typo'd
// --private-patterns-file disabled redaction with no error and reported the run as 'public'. This
// allowlist closes that: any flag not in the current subcommand's list is a hard error.
const SUBCOMMAND_SHAPES = {
  calibrate: { flags: ['model', 'private-patterns-file'], extraPositionals: 0 },
  smoke: { flags: ['model', 'source-repo-dir', 'pinned-commit', 'project-alias', 'private-patterns-file'], extraPositionals: 0 },
  corpus: { flags: [], extraPositionals: 1 }, // corpus <validate>
  aggregate: { flags: ['runs-dir'], extraPositionals: 0 },
  validate: { flags: ['run'], extraPositionals: 0 },
};

/** Validates a parsed `args` against SUBCOMMAND_SHAPES[sub] -- unknown flags and unexpected
 * extra positional arguments are both hard errors. Returns an array of error strings (empty if
 * valid). Called from main() BEFORE any subcommand handler runs, so a malformed invocation is
 * rejected before runConditionPair() ever spends a session on it. */
function validateSubcommandArgs(sub, args) {
  const shape = SUBCOMMAND_SHAPES[sub];
  if (!shape) return [`Unknown subcommand: ${sub}`];
  const errors = [];
  const providedFlags = Object.keys(args).filter((k) => k !== '_' && k !== 'errors' && k !== 'help');
  for (const f of providedFlags) {
    if (!shape.flags.includes(f)) errors.push(`Unknown flag for '${sub}': --${f}`);
  }
  const extraPositionals = args._.length - 1 - shape.extraPositionals;
  if (extraPositionals > 0) {
    errors.push(`Unexpected extra argument(s) for '${sub}': ${args._.slice(1 + shape.extraPositionals).join(' ')}`);
  }
  return errors;
}

/** Eagerly loads/validates --private-patterns-file BEFORE any Claude session runs -- previously
 * the file was only read inside finalizeAndWriteRecords(), AFTER both conditions had already
 * completed, so a missing/malformed patterns file was only discovered after spending a full
 * run-pair (real API cost and time for a live re-run) for nothing. Returns {ok:true} or
 * {ok:false, reason}; does not throw. */
function validatePrivatePatternsFileOrFail(privatePatternsFile) {
  if (!privatePatternsFile) return { ok: true };
  try {
    loadPrivateRules(privatePatternsFile);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `--private-patterns-file is invalid: ${err.message}` };
  }
}

function nullableMetric(value, reason = null) {
  return { value, reason: value === null ? (reason ?? 'not recorded') : null };
}

/** Maps Node's process.platform to the schema's PLATFORM_VALUES enum -- never hardcoded. */
function resolvePlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'not-recorded';
}

let cachedHarnessProvenance = null;
/**
 * Resolves this HARNESS's own identity -- the kmp-test-runner repo commit it's actually running
 * from, and the kmp-test CLI version/path it pins via the shim. Previously all three fields
 * (kmp_test_cli_version, kmp_test_cli_source_sha, resolved_kmp_test_executable_path) were always
 * null, and `repo_commit` was populated with the PINNED SKILL snapshot's SHA instead of the
 * harness's own actual commit -- silently correct only when the checkout happens to be sitting
 * exactly at PINNED_SKILL_SHA, wrong the moment develop moves forward and the harness is re-run
 * from a newer checkout. No `bash -c` needed here: `git rev-parse HEAD` takes no path-shaped
 * argument in its command string, so it doesn't hit the Windows path-mangling issue that
 * motivates routing other git calls through resolveBash() elsewhere in this harness. Cached per
 * process (the repo doesn't change mid-run); pass {fresh:true} to force re-resolution (test-only).
 */
// Returns {ok, paths} rather than a bare array -- an independent review pass found that
// collapsing "the git status command itself failed" (git missing from PATH, spawn error, not a
// git repo) into the SAME empty array as "genuinely clean" silently defeated the fail-closed
// dirty_measured_code gate: reproduced by removing git from PATH entirely, which returned
// repo_commit:null AND both dirty-path lists empty, i.e. evidence indistinguishable from (and
// falsely reported as) a clean tree. Callers must check `ok` and treat `ok:false` as "cannot
// prove cleanliness" -- never silently treated as "definitely clean."
function gitDirtyPaths(pathspecs) {
  const r = spawnSync('git', ['status', '--porcelain', '--', ...pathspecs], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, paths: [] };
  return { ok: true, paths: r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
}

function resolveHarnessProvenance({ fresh = false } = {}) {
  if (cachedHarnessProvenance != null && !fresh) return cachedHarnessProvenance;
  let repoCommit = null;
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status === 0) repoCommit = r.stdout.trim();
  let cliVersion = null;
  try {
    cliVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    cliVersion = null;
  }
  // Two SEPARATE dirty-tree checks, deliberately scoped and treated differently:
  //  - measuredCodeDirtyPaths (bin/lib/scripts, tools/lib, tools/validate-plugin.mjs): code this
  //    harness EXECUTES whose correctness the recorded evidence directly depends on -- not only
  //    "runs inside the measured Claude session via the shim" (bin/lib/scripts), but also code the
  //    HARNESS's own process executes around that session: tools/lib/redact.mjs (imported by
  //    privacy.mjs -- IS the redaction/leak-detection logic every privacy guarantee in this PR
  //    depends on) and tools/validate-plugin.mjs (imported by cli.mjs -- validates the
  //    materialized skill snapshot before a session ever runs against it). An earlier version
  //    left both completely uncovered by ANY dirty-tree check (not even disclosed) -- a local,
  //    uncommitted change to redact.mjs specifically could silently affect what "clean" evidence
  //    actually means, with repo_commit still claiming to describe it. Dirtiness here is
  //    FAIL-CLOSED (see finalizeAndWriteRecords) -- it directly means committable evidence would
  //    misrepresent what repo_commit claims to describe.
  //  - harnessToolingDirtyPaths (tools/agentic-eval/**, package.json): THIS PR's own feature code
  //    and the repo manifest. Always disclosed via errors[]; FAIL-CLOSED conditionally, only when
  //    finalizeAndWriteRecords() is writing to the default, committable RUNS_ROOT (see
  //    RUNS_ROOT_IS_DEFAULT and finalizeAndWriteRecords's own comment for the full reasoning) --
  //    never blanket, because tools/agentic-eval/** is necessarily in-flux during the harness's
  //    own active development (including this very test suite, which lives inside that same
  //    tree -- tests that exercise evidence-writing paths use isolated, non-default roots where
  //    required, while some unit tests intentionally exercise the canonical default-root branch
  //    directly, short of an actual write) -- blocking there too would make the harness
  //    structurally unable to ever produce evidence while being developed or exercised by its
  //    own local test run. package.json is grouped here (not the measured-code
  //    list) since its version field is metadata about the harness/CLI release, not code whose
  //    correctness affects what evidence actually captured. Unlike tools/agentic-eval/**,
  //    tools/lib/ and tools/validate-plugin.mjs are shared, stable, pre-existing repo
  //    infrastructure -- not novel code under active iteration as part of this PR's own work --
  //    so UNCONDITIONAL fail-closed enforcement there doesn't reproduce the
  //    can-never-produce-evidence-during-development problem this conditional split exists to
  //    avoid.
  const measuredCode = gitDirtyPaths(['bin', 'lib', 'scripts', 'tools/lib', 'tools/validate-plugin.mjs']);
  const harnessTooling = gitDirtyPaths(['tools/agentic-eval', 'package.json']);
  cachedHarnessProvenance = {
    repoCommit,
    cliVersion,
    resolvedExecutablePath: join(REPO_ROOT, 'bin', 'kmp-test.js'),
    measuredCodeDirtyPaths: measuredCode.paths,
    // repoCommit:null (git rev-parse HEAD itself failed -- an independent git call from the two
    // status checks above) is folded into the SAME fail-closed signal as a dirty measured-code
    // tree: without knowing which commit this ran at, "is bin/lib/scripts dirty relative to it"
    // is an unanswerable question, and repo_commit itself becomes unrecorded -- fundamentally
    // non-reproducible evidence either way.
    measuredCodeCheckFailed: !measuredCode.ok || repoCommit == null,
    harnessToolingDirtyPaths: harnessTooling.paths,
    harnessToolingCheckFailed: !harnessTooling.ok,
  };
  return cachedHarnessProvenance;
}

/** Best-effort real git remote origin URL for `repoDir` -- null if it has no configured remote
 * (e.g. a purely-local test fixture repo). No path-shaped ARGUMENT is passed to git here (repoDir
 * is a spawn-option cwd, not command-line text), so this doesn't need resolveBash() routing --
 * matches resolveHarnessProvenance's own plain spawnSync git calls for the same reason. */
function resolveGitRemoteUrl(repoDir) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function tokensEqual(a, b) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * True only if `bashResults` is EXACTLY the expected multiset of commands: every expected
 * tokenized command appears exactly once, each with its own correlated non-error result, and
 * there are NO other Bash calls at all (no extras, no retries, no partial-flag variants).
 * Tokenizes via policy-hook.mjs's own quote-aware tokenize() and compares the resulting token
 * ARRAYS, not a regex match against the raw string -- an earlier version used unanchored regexes
 * with no --json requirement, which a real adversarial probe showed could be satisfied by e.g.
 * `kmp-test doctor` (no --json at all, contradicting smoke's own prompt) or even
 * `kmp-test doctor-evil-subcommand` (the old `\bdoctor\b` pattern's word-boundary matched a
 * hyphen-adjacent suffix too). An unparseable command (tokenize() returns null, e.g. an
 * unterminated quote) can never satisfy any expected command.
 */
function verifyExactCommandsSucceeded(bashResults, expectedCommands) {
  if (bashResults.length !== expectedCommands.length) return false;
  const remaining = expectedCommands.map((tokens) => ({ tokens, matched: false }));
  for (const b of bashResults) {
    const tokens = tokenize(b.command ?? '');
    if (tokens == null) return false;
    const slot = remaining.find((r) => !r.matched && tokensEqual(r.tokens, tokens));
    if (slot == null) return false;
    if (!b.resultFound || b.resultIsError !== false) return false;
    slot.matched = true;
  }
  return remaining.every((r) => r.matched);
}
const SMOKE_EXPECTED_COMMANDS = [
  ['kmp-test', 'doctor', '--json'],
  ['kmp-test', 'describe', '--json'],
];

// The ONLY tools either condition's own --tools argv value ever grants (buildBaseArgv --
// condition-launcher.mjs); used by both hard gates to prove the init event's OWN declared
// profile actually matches this, and that no tool_use anywhere in the transcript names
// anything outside this set. A gate that never checks this can't distinguish a genuinely narrow
// session from one that regressed to a wider tool/MCP/permission profile.
const EXPECTED_TOOL_NAMES = new Set(['Bash', 'Skill']);

/**
 * Runs both conditions of a pair and returns everything buildRunRecord needs, plus a cleanup()
 * function the caller MUST invoke from a finally block -- removes every temp directory this
 * function created (shim, skill snapshot, GRADLE_USER_HOME, KMP_EVAL_TEMP_HOME, the generated
 * --settings file's directory) and, via the caller-supplied cleanupFixture callback, the
 * materialized fixture itself (a plain rmSync for a copied template, or `git worktree remove`
 * for a scenario project -- see materialize.mjs's removeScenarioWorktree). Without this, a git
 * worktree survives as registered metadata in the source repo forever even after its directory
 * is gone (confirmed via `git worktree list` after a run that skipped this).
 * @param {Function} materializeFixture - (existingDir) => {fixtureDir}. Called once per
 *   condition with the PRIOR fixtureDir (or undefined for the first call) so the caller can
 *   implement "reuse the same path, wiped and re-populated" (Materialization Principle).
 * @param {Function} [cleanupFixture] - (fixtureDir) => void|Promise<void>, called once at the end.
 */
async function runConditionPair({ prompt, model, allowedGradleTasks, allowedKmpTestSubcommands, materializeFixture, cleanupFixture, timeoutMs }) {
  // Cleanup steps accumulate AS EACH RESOURCE IS CREATED, not all at once at the end -- a
  // failure partway through acquisition (materialization throwing, or either condition's own
  // run throwing) is caught here and runs whatever steps have been queued SO FAR before
  // rethrowing. Previously, the returned cleanup() was the ONLY cleanup mechanism, but a caller
  // only receives it once this whole function returns successfully -- if runConditionPair
  // itself threw, `await runConditionPair(...)` never resolved to anything the caller's own
  // try/finally could invoke cleanup() on, leaking every resource created up to that point.
  const cleanupSteps = [];
  // Returns the list of step failures (never throws itself) -- deliberately best-effort, so ONE
  // failed step (e.g. a transient file lock on a temp dir delete) doesn't prevent every OTHER
  // queued step from still running. Callers MUST inspect the returned array: silently discarding
  // it (the previous behavior -- only a console.error per step, with nothing surfaced to the
  // caller) meant a run could report overall success while leaving resources registered, with no
  // way for a script or CI log reviewer to detect that short of grepping for the per-step
  // message.
  async function runCleanup() {
    const failures = [];
    for (const step of cleanupSteps.splice(0)) {
      try {
        await step();
      } catch (err) {
        failures.push(err.message);
      }
    }
    return failures;
  }

  try {
    const settingsPath = buildPolicySettingsFile();
    cleanupSteps.push(() => rmSync(dirname(settingsPath), { recursive: true, force: true }));
    const { shimDir } = buildPathShim({ worktreeRoot: REPO_ROOT });
    cleanupSteps.push(() => rmSync(shimDir, { recursive: true, force: true }));
    const { snapshotDir } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runPluginValidator });
    cleanupSteps.push(() => rmSync(snapshotDir, { recursive: true, force: true }));
    // materializeGradleUserHome creates TWO temp directories (gradleUserHome itself, plus its
    // own internal snapshotDir it resets from) -- gradleSnapshotDir here is deliberately
    // distinctly named from the skill snapshot's `snapshotDir` above; conflating the two
    // previously meant the Gradle module's own snapshot directory was never captured at all and
    // leaked on every run (caught by a real cleanup-verification test, not asserted).
    const { gradleUserHome, snapshotDir: gradleSnapshotDir, resetToSnapshot, daemonPolicy } = materializeGradleUserHome({});
    cleanupSteps.push(() => rmSync(gradleUserHome, { recursive: true, force: true }));
    cleanupSteps.push(() => rmSync(gradleSnapshotDir, { recursive: true, force: true }));
    const kmpEvalTempHome = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-home-'));
    cleanupSteps.push(() => rmSync(kmpEvalTempHome, { recursive: true, force: true }));

    const env = buildSharedEnv({
      shimDir, gradleUserHome, kmpEvalTempHome,
      expectedFixtureRoot: null, // set per-condition below once the fixture dir is materialized
      allowedGradleTasks, allowedKmpTestSubcommands,
    });
    const base = buildBaseArgv({ prompt, model, settingsPath });

    let fixtureDir;
    let fixtureCleanupQueued = false;
    const runOneCondition = async (condition) => {
      const materialized = materializeFixture(fixtureDir);
      fixtureDir = materialized.fixtureDir;
      if (!fixtureCleanupQueued && cleanupFixture) {
        fixtureCleanupQueued = true;
        cleanupSteps.push(() => cleanupFixture(fixtureDir));
      }
      resetToSnapshot();
      // KMP_EVAL_TEMP_HOME is reused (same path) across both conditions of a pair like
      // fixtureDir/GRADLE_USER_HOME -- wiped back to empty before EACH condition's run, so
      // whatever the first-run condition wrote under ~/.kmp-test/ can never leak into the
      // second.
      rmSync(kmpEvalTempHome, { recursive: true, force: true });
      mkdirSync(kmpEvalTempHome, { recursive: true });
      const conditionEnv = { ...env, KMP_EVAL_EXPECTED_FIXTURE_ROOT: realpath(fixtureDir) };
      const argv = buildConditionArgv(base, condition, condition === 'current-skill' ? snapshotDir : null);
      const startedAt = new Date();
      const spawnResult = await spawnCondition(argv, { env: conditionEnv, cwd: fixtureDir, timeoutMs });
      const endedAt = new Date();
      const { events, malformedLines } = parseStreamJsonl(spawnResult.rawStdout, { taggedLines: spawnResult.taggedLines });
      const init = findInitEvent(events);
      const result = findResultEvent(events);
      const invocation = findSkillInvocation(events, 'kmp-test-runner');
      const hookStats = countHookEvents(events);
      const byteMetrics = computeByteMetrics(spawnResult.rawStdout, events);
      const bashResults = findBashToolUsesWithResults(events);

      return {
        condition, argv, env: conditionEnv, fixtureDir, events, malformedLines, init, result,
        invocation, hookStats, byteMetrics, bashResults, spawnResult, startedAt, endedAt,
      };
    };

    const runB = await runOneCondition('current-skill');
    const runA = await runOneCondition('no-skill');

    return { runA, runB, snapshotDir, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, cleanup: runCleanup };
  } catch (err) {
    reportCleanupFailures(await runCleanup(), 'during acquisition-failure rollback');
    throw err;
  }
}

/** Prints a single, clearly-labeled WARNING line if `failures` (from runCleanup()) is
 * non-empty -- never silent, but never escalated into a hard failure either: a temp-dir cleanup
 * race is a disk-hygiene concern, not evidence the run's own gate result is wrong. */
function reportCleanupFailures(failures, contextSuffix = '') {
  if (failures.length === 0) return;
  const suffix = contextSuffix ? ` ${contextSuffix}` : '';
  console.error(`WARNING: ${failures.length} cleanup step(s) failed${suffix} (resources may be left behind): ${failures.join('; ')}`);
}

function buildRunRecord({ conditionResult, condition, runKind, scenarioId, skillSourceSha, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias = 'calibration-project', projectCommit = null, projectUrl = null, family = 'trigger-only', modelRequested = 'claude-sonnet-5', privacyStatus = 'public' }) {
  const { init, result, invocation, hookStats, byteMetrics, startedAt, endedAt } = conditionResult;
  const notApplicableReason = `${runKind} run -- no scenario grader applies`;
  const provenance = resolveHarnessProvenance();
  // Shared by BOTH dirty_harness_tooling branches below so the two messages can't drift apart
  // again -- this exact drift (the messages claiming "never blocks evidence" after
  // findBlockingHarnessToolingDirty/finalizeAndWriteRecords were made conditionally fail-closed)
  // is the bug this constant exists to prevent from recurring.
  const harnessToolingDispositionNote = `always disclosed here; additionally fail-closed by finalizeAndWriteRecords() when writing to the default, committable RUNS_ROOT -- see resolveHarnessProvenance's own comment for the full conditional reasoning`;
  return {
    schema: CURRENT_RUN_SCHEMA,
    run_id: `${runKind}-${condition}-${randomUUID().slice(0, 8)}`,
    run_kind: runKind,
    benchmark_eligible: false,
    scenario_id: scenarioId,
    query_id: null,
    condition,
    skill_source_sha: condition === 'current-skill' ? skillSourceSha : null,
    kmp_test_cli_version: provenance.cliVersion,
    kmp_test_cli_source_sha: provenance.repoCommit,
    resolved_kmp_test_executable_path: provenance.resolvedExecutablePath,
    model_requested: modelRequested,
    model_resolved: init?.model ?? null,
    session_id_observed: init?.session_id ?? null,
    claude_code_version: init?.claude_code_version ?? null,
    repo_commit: provenance.repoCommit,
    project_alias: projectAlias,
    project_commit: projectCommit,
    project_url: projectUrl,
    platform: resolvePlatform(),
    family,
    cache_state: 'unknown',
    daemon_policy: daemonPolicy ?? 'unknown',
    env_allowlist_profile: 'narrow',
    seed: null,
    order_index: null,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    wall_clock_ms: endedAt.getTime() - startedAt.getTime(),
    skill_available: nullableMetric(isSkillAvailable(init, 'kmp-test-runner')),
    skill_invocation_attempted: nullableMetric(invocation != null),
    skill_invoked: nullableMetric(invocation?.confirmed ?? false),
    skill_invocation_event: invocation ? { type: invocation.type, index: invocation.index } : null,
    success: nullableMetric(null, `${runKind} run -- success grading not applicable`),
    expected_outcome_matched: nullableMetric(null, notApplicableReason),
    first_useful_signal_ms: nullableMetric(null, `${runKind} run -- no first-useful-signal predicate applies`),
    first_useful_signal_event: null,
    tokens: {
      input: nullableMetric(extractTokenUsage(result)?.input ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
      output: nullableMetric(extractTokenUsage(result)?.output ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
      cache_read: nullableMetric(extractTokenUsage(result)?.cache_read ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
      cache_creation: nullableMetric(extractTokenUsage(result)?.cache_creation ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
    },
    tool_calls_total: nullableMetric(findBashToolUses(conditionResult.events).length + (invocation ? 1 : 0)),
    shell_commands_total: nullableMetric(findBashToolUses(conditionResult.events).length),
    test_invocations_total: nullableMetric(null, `not tracked for ${runKind} runs`),
    retries: nullableMetric(null, `not tracked for ${runKind} runs`),
    output_bytes: nullableMetric(byteMetrics.outputBytes),
    stream_json_bytes: nullableMetric(byteMetrics.streamJsonBytes),
    human_interventions: nullableMetric(0),
    terminated: conditionResult.spawnResult.terminated,
    termination_reason: conditionResult.spawnResult.terminationReason,
    exit_code: conditionResult.spawnResult.exitCode,
    permission_mode_used: 'dontAsk',
    policy_allowed_gradle_tasks: allowedGradleTasks,
    policy_allowed_kmptest_subcommands: allowedKmpTestSubcommands,
    policy_sha256: policySha256,
    hook_call_count: hookStats.hookCallCount,
    hook_deny_count: hookStats.hookDenyCount,
    privacy_status: privacyStatus,
    raw_capture_committed: false,
    // Only accurate when RUNS_ROOT is the default -- see RUNS_ROOT_IS_DEFAULT's own comment.
    // Never falls back to the actual KMP_EVAL_RUNS_ROOT override value itself: that path is an
    // arbitrary local filesystem location (test temp dirs are the only current caller) and could
    // itself be privacy-sensitive, exactly the class of leak this harness's redaction exists to
    // prevent -- so an override is disclosed generically (see dirty_harness_tooling's identical
    // content-free-disclosure precedent), never printed verbatim.
    raw_capture_location: RUNS_ROOT_IS_DEFAULT ? `tools/runs/agentic-eval-${runKind}/raw/` : '(KMP_EVAL_RUNS_ROOT override -- see errors[])',
    notes: 'Foundation-harness run; not a benchmark result.',
    // repo_commit/kmp_test_cli_source_sha describe HEAD, not necessarily the exact bytes that
    // executed -- disclosed here rather than silently letting the recorded SHA imply a codebase
    // that isn't quite what actually ran. Two distinct codes: dirty_measured_code (bin/lib/
    // scripts/tools/lib/tools/validate-plugin.mjs, code whose correctness this evidence directly
    // depends on -- this ALSO always fails finalizeAndWriteRecords's hard, fail-closed check, see
    // there for why) and dirty_harness_tooling (tools/agentic-eval/**, package.json -- always
    // disclosed, but only fail-closed when writing to the default RUNS_ROOT; see
    // resolveHarnessProvenance's own comment for the full reasoning).
    errors: [
      // measuredCodeCheckFailed (the `git status` command itself failed -- git missing, spawn
      // error, not a git repo) reuses the SAME dirty_measured_code code as an actual dirty tree:
      // "cannot prove the tree is clean" carries the identical consequence as "the tree is
      // provably dirty" -- both mean repo_commit can't be trusted, and both must fail closed via
      // finalizeAndWriteRecords's existing check, not silently pass as if nothing were wrong.
      ...(provenance.measuredCodeCheckFailed
        ? [{ code: 'dirty_measured_code', message: 'git provenance could not be established (rev-parse HEAD and/or the bin/lib/scripts/tools/lib/tools/validate-plugin.mjs status check failed -- git missing from PATH, spawn error, or not a git repository) -- cannot verify the tree is clean or record which commit this ran at, treated as dirty' }]
        : provenance.measuredCodeDirtyPaths.length > 0
          ? [{ code: 'dirty_measured_code', message: `bin/lib/scripts/tools/lib/tools/validate-plugin.mjs have uncommitted local modifications not reflected in repo_commit: ${provenance.measuredCodeDirtyPaths.join(', ')}` }]
          : []),
      ...(provenance.harnessToolingCheckFailed
        ? [{ code: 'dirty_harness_tooling', message: `the git status check for tools/agentic-eval/package.json itself failed (git missing from PATH, spawn error, or not a git repository) -- cannot verify the tree is clean (${harnessToolingDispositionNote})` }]
        : provenance.harnessToolingDirtyPaths.length > 0
          ? [{ code: 'dirty_harness_tooling', message: `tools/agentic-eval/package.json have uncommitted local modifications not reflected in repo_commit (${harnessToolingDispositionNote}): ${provenance.harnessToolingDirtyPaths.join(', ')}` }]
          : []),
      // KMP_EVAL_RUNS_ROOT is a test-only escape hatch (see its own module-level comment) -- real
      // calibrate/smoke invocations are not expected to set it. Disclosed rather than silently
      // written under an unprotected path: only the DEFAULT tools/runs/ root is covered by
      // .gitignore's agentic-eval raw-transcript glob.
      ...(!RUNS_ROOT_IS_DEFAULT
        ? [{ code: 'raw_capture_location_overridden', message: 'KMP_EVAL_RUNS_ROOT was set to a non-default root for this run -- the raw transcript may not be covered by the default .gitignore pattern; verify manually before staging anything from that location' }]
        : []),
    ],
  };
}

/**
 * Writes ALREADY-REDACTED, already-gated record text (never re-serializes recordA/recordB --
 * the caller's redacted text is authoritative) to the committable top-level run-kind directory,
 * and the RAW stream-json transcripts to its raw subdirectory. Under the default RUNS_ROOT this
 * is gitignored per .gitignore's agentic-eval raw-transcript glob, matching what each record's
 * raw_capture_location field claims for that case -- see RUNS_ROOT_IS_DEFAULT's own comment for
 * why a KMP_EVAL_RUNS_ROOT override is disclosed instead of silently assumed equally safe. Never
 * redacts/sanitizes the raw file itself; it simply never leaves this local destination.
 *
 * Writes to `<target>.tmp-<random>` first and promotes each file with linkSync() only after every
 * write has succeeded. Beyond that, the whole write-then-link sequence is wrapped so a failure
 * ANYWHERE in it -- including partway through the four linkSync calls themselves, not just the
 * four writeFileSync calls -- rolls back every FINAL-path file this call already linked into
 * place (plus any leftover temp files) before rethrowing: a promotion failure on file 3 of 4 must
 * never leave files 1-2 committed as final evidence while 3-4 are missing.
 */
function resolveEvidenceOutDir(runKind, runsRootOverride = RUNS_ROOT) {
  return join(runsRootOverride, `agentic-eval-${runKind}`);
}

// Runtime enforcement, not just the run record's own errors[] disclosure (see
// RUNS_ROOT_IS_DEFAULT's comment) -- an independent review pass argued that documenting a
// non-default root in the record doesn't itself prevent an accidental `git add -A` from staging
// raw, unredacted transcripts. Verifies the raw-transcript destination can never end up in a real
// commit: EITHER it's CONFIRMED entirely outside any git repository (not just this one -- git can
// never see it, regardless of any gitignore rule), OR it's inside one and actually covered by
// that repository's own .gitignore -- checked via `git check-ignore`, not assumed from the path's
// string shape. Every git call's failure mode is itself fail-closed: a result this function can't
// positively confirm is never treated as safe by default.
function isRawDirSafeFromAccidentalCommit(rawDir, runsRootOverride) {
  let runsRootReal;
  try {
    runsRootReal = realpath(runsRootOverride);
  } catch {
    return false; // can't even resolve the root -- fail closed
  }
  // Determine the ACTUAL containing git repository, if any -- never assumed to be REPO_ROOT
  // specifically. An earlier version only checked containment against REPO_ROOT and treated
  // anything outside THIS repo's worktree as automatically safe, but a KMP_EVAL_RUNS_ROOT pointed
  // at a location inside a COMPLETELY DIFFERENT git repository (a sibling checkout, any other
  // git-managed directory on the machine) is not "outside a repo" at all -- it's inside a repo
  // this harness never checks .gitignore against. Reproduced directly: pointed at a temp
  // repository elsewhere, `git status` there showed the raw directory as a real, trackable
  // untracked path (`?? agentic-eval-calibration/`) -- an accidental `git add -A` in THAT repo
  // would have staged it. `git -C <path> rev-parse --show-toplevel` finds whatever repository (if
  // any) actually contains the resolved root.
  //
  // A non-zero exit is NOT by itself "confirmed not inside any git repository" -- a further
  // independent review pass caught exactly this: git being unavailable (missing from PATH), a
  // spawn-level error, a permissions problem, an unconfigured safe.directory, or any other
  // unexpected failure ALSO produces a non-zero exit, and treating all of these the same as
  // "definitely outside a repo, therefore safe" is the identical fail-open pattern already fixed
  // once for gitDirtyPaths() -- reproduced concretely by disabling git for this exact call: the
  // function returned "safe" for a destination that, with git working normally, would have shown
  // up as trackable, untracked content in a real containing repository. Only ONE specific,
  // positively-matched outcome counts as confirmed-safe: the spawn itself succeeded (no
  // `.error`), AND git's own exit code (128) and stderr match its well-known, stable
  // "not a git repository" message exactly. Every other outcome -- including a DIFFERENT
  // non-zero status, unrecognized stderr, or a spawn error -- fails closed.
  // LC_ALL/LANG=C forces git's stderr into its default (English) locale regardless of the host's
  // configured language -- a minor observation from an independent review pass: git can localize
  // "fatal: not a git repository" into another language, and without this override, the stable
  // pattern match below would fail to recognize a genuinely-confirmed-safe destination on a
  // non-English host, over-rejecting (never under-rejecting -- fail-closed either way) a valid
  // path. Merged onto process.env, not replacing it -- spawnSync's env option replaces the WHOLE
  // environment if set, and git itself still needs PATH to be found at all.
  const toplevel = spawnSync('git', ['-C', runsRootReal, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  const confirmedNotInAnyRepo = !toplevel.error && toplevel.status === 128 && /fatal: not a git repository/i.test(toplevel.stderr ?? '');
  if (confirmedNotInAnyRepo) return true;
  if (toplevel.status !== 0) return false; // couldn't confirm either way -- fail closed, never assume safe
  const containingRepoRoot = toplevel.stdout.trim();
  // .gitignore's own pattern is `tools/runs/agentic-eval-*/raw/**` -- the `**` only matches
  // CONTENTS of raw/, never the bare directory path itself (confirmed empirically: `git
  // check-ignore` on the directory alone exits 1/not-ignored, on a file inside it exits 0). Check
  // a representative file path inside it, matching what actually gets written there, scoped to
  // whichever repository actually contains it (not always REPO_ROOT).
  const r = spawnSync('git', ['check-ignore', '--quiet', join(rawDir, 'probe.jsonl')], { cwd: containingRepoRoot, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function writeRunRecordEvidence(runKind, recordA, recordB, runA, runB, redactedTextA, redactedTextB, runsRootOverride = RUNS_ROOT) {
  const outDir = resolveEvidenceOutDir(runKind, runsRootOverride);
  const rawDir = join(outDir, 'raw');
  if (!isRawDirSafeFromAccidentalCommit(rawDir, runsRootOverride)) {
    throw new Error(`refusing to write raw transcripts: ${rawDir} is inside this repo's worktree but not covered by .gitignore -- would risk an accidental commit of unredacted data`);
  }
  const targets = [
    [join(outDir, `${recordA.run_id}.json`), redactedTextA],
    [join(outDir, `${recordB.run_id}.json`), redactedTextB],
    [join(rawDir, `${recordA.run_id}.jsonl`), runA.spawnResult.rawStdout],
    [join(rawDir, `${recordB.run_id}.jsonl`), runB.spawnResult.rawStdout],
  ];
  // run_id embeds only an 8-hex-char slice of randomUUID() (~2^32 space, not the full 128 bits)
  // -- not astronomically improbable to collide across this harness's full lifetime of runs (or,
  // concurrently, two overlapping invocations racing each other). This upfront existsSync check is
  // a fast, non-atomic PRE-check only -- it narrows the common case early, but does NOT by itself
  // prevent a collision: an independent review pass reproduced a genuine TOCTOU race with two
  // synchronized workers -- both passed this existsSync check (target didn't exist YET for
  // either), then both proceeded to promote, and one silently overwrote the other via renameSync
  // (which replaces an existing destination on POSIX). The REAL, atomic guarantee is the
  // linkSync-based promotion below, which can never lose this race the way check-then-renameSync
  // could.
  for (const [target] of targets) {
    if (existsSync(target)) {
      throw new Error(`refusing to write evidence: ${target} already exists (run_id collision?) -- nothing was written or touched`);
    }
  }
  mkdirSync(rawDir, { recursive: true });
  const tmpSuffix = `.tmp-${randomUUID().slice(0, 8)}`;
  const tmpPaths = targets.map(([target]) => target + tmpSuffix);
  // linkSync (not renameSync) for promotion: creates a hard link to the fully-written tmp file at
  // the FINAL target path, and -- critically -- fails atomically with EEXIST if that target
  // already exists, rather than silently replacing it the way renameSync does on POSIX. This is
  // what actually closes the TOCTOU window the existsSync pre-check above cannot: a concurrent
  // invocation racing to create the SAME target can now only ever have ONE winner: whichever
  // linkSync call the filesystem serializes first.
  const linkedTargets = [];
  try {
    targets.forEach(([, content], i) => writeFileSync(tmpPaths[i], content));
    targets.forEach(([target], i) => {
      try {
        linkSync(tmpPaths[i], target);
      } catch (err) {
        if (err.code === 'EEXIST') {
          throw new Error(`refusing to write evidence: ${target} already exists (run_id collision -- lost a concurrent race) -- targets created by this invocation are being rolled back`);
        }
        throw err;
      }
      linkedTargets.push(target);
    });
  } catch (err) {
    // Roll back ONLY the targets THIS invocation actually created via a successful linkSync --
    // never a target that failed with EEXIST, since that means a DIFFERENT invocation already
    // owns it and this one must not touch it.
    for (const target of linkedTargets) rmSync(target, { force: true });
    for (const tmpPath of tmpPaths) rmSync(tmpPath, { force: true });
    throw err;
  }
  // linkSync creates an ADDITIONAL directory entry pointing at the same data -- unlike renameSync,
  // it doesn't consume the source -- so the tmp files must be cleaned up explicitly once every
  // target has been linked successfully.
  for (const tmpPath of tmpPaths) rmSync(tmpPath, { force: true });
  return outDir;
}

/**
 * The sole gate before ANY committable evidence is written. In order: schema validation (both
 * ORIGINAL records) -> a FRESH policy_sha256 recomputation matched against both records (catches
 * evidence silently going stale relative to policy-hook.mjs's current content -- a hand-carried
 * or previously-generated record with a stale hash is refused, not just format-checked) ->
 * assertCleanOrThrowObject privacy check, FIELD BY FIELD, on the RAW record objects (never
 * previously wired in -- this is what actually enforces "no leak ever reaches a committable
 * file"; and never on an already-JSON.stringify()'d blob -- JSON-escaping doubles every
 * backslash, which the user_path_win rule's single-backslash regex then silently fails to match,
 * confirmed empirically: a real Windows path survived intact when redaction ran on
 * pre-serialized text) -> the run-kind's own hard acceptance predicate (evaluated against the
 * ORIGINAL records -- the gate's own checks never reference redaction-prone fields, and gating
 * on the pre-redaction truth of what happened is the conceptually correct choice; redaction is a
 * display/storage concern, not a data-correctness one) -> the evidence directory PATH's own
 * privacy check, verified before writeRunRecordEvidence is ever called (not after -- an earlier
 * version wrote all four files first and only checked the path afterward, so a private-patterns
 * rule matching only the runs-root path itself could report {ok:false} after real evidence was
 * already on disk). Any failure returns {ok:false, reason} and writes nothing.
 */
/**
 * Extracted as a named, independently-testable function specifically so BOTH branches of this
 * conditional (writing to the default RUNS_ROOT vs. an isolated override) can be unit-tested
 * directly -- RUNS_ROOT_IS_DEFAULT is a module-level const fixed at first import, so a real
 * in-process test can only ever observe ONE of its two values within a single process. Returns
 * the blocking dirty_harness_tooling error entry (or undefined) rather than a boolean, so a caller
 * can build a reason string from its message.
 */
function findBlockingHarnessToolingDirty(record, runsRootIsDefault) {
  if (!runsRootIsDefault) return undefined;
  return record.errors.find((e) => e.code === 'dirty_harness_tooling');
}

async function finalizeAndWriteRecords({ runKind, recordA, recordB, runA, runB, hardGateFn, privatePatternsFile, runsRootOverride = RUNS_ROOT }) {
  for (const [label, record] of [['A', recordA], ['B', recordB]]) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      return { ok: false, reason: `Run record ${label} failed schema validation: ${JSON.stringify(errors)}` };
    }
  }
  // Fail-closed on dirty MEASURED code (bin/lib/scripts/tools/lib/tools/validate-plugin.mjs) --
  // disclosing this in errors[] alone (the previous behavior) still let evidence write, meaning
  // committable evidence could claim repo_commit described the code that ran when it actually
  // didn't.
  for (const [label, record] of [['A', recordA], ['B', recordB]]) {
    const dirty = record.errors.find((e) => e.code === 'dirty_measured_code');
    if (dirty) {
      return { ok: false, reason: `Run record ${label} was captured with an unclean measured-code tree -- refusing to write evidence that would misrepresent repo_commit: ${dirty.message}` };
    }
  }
  // dirty_harness_tooling (tools/agentic-eval/**, package.json) is fail-closed ONLY when this
  // invocation is writing to the OFFICIAL, committable location (as resolved canonically by
  // isRunsRootDefault) -- an
  // independent review pass pointed out that leaving this purely disclosure-only meant code that
  // directly decides parsing/gates/metrics (this PR's own feature work) could change what
  // evidence actually captures while repo_commit still pointed at a clean HEAD. Scoped to the
  // default root specifically, not blanket: tools/agentic-eval/** is necessarily in-flux during
  // the harness's own active development, including this very test suite (which always targets an
  // isolated KMP_EVAL_RUNS_ROOT, never the default) -- blocking there too would make local
  // development/testing structurally unable to ever exercise this function. A REAL calibrate/
  // smoke run producing official evidence, though, should require the same clean-tree discipline
  // dirty_measured_code already enforces: develop, commit, then run.
  // runsRootOverride is an internal test seam: production callers omit it, while destructive
  // collision tests can exercise the complete finalization path in an isolated temp directory.
  const runsRootIsDefault = isRunsRootDefault(runsRootOverride, REPO_ROOT);
  for (const [label, record] of [['A', recordA], ['B', recordB]]) {
    const dirty = findBlockingHarnessToolingDirty(record, runsRootIsDefault);
    if (dirty) {
      return { ok: false, reason: `Run record ${label} was captured with an unclean harness-tooling tree while writing to the default, committable evidence location -- refusing to write evidence that would misrepresent repo_commit: ${dirty.message}` };
    }
  }
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const freshHash = computePolicySha256({ fresh: true });
  for (const [label, record] of [['A', recordA], ['B', recordB]]) {
    if (record.policy_sha256 !== freshHash) {
      return { ok: false, reason: `Run record ${label} policy_sha256 (${record.policy_sha256}) does not match the current policy-hook.mjs (${freshHash}) -- evidence is stale relative to the code that produced it` };
    }
  }
  let redactedRecordA;
  let redactedTextA;
  let redactedRecordB;
  let redactedTextB;
  try {
    ({ redactedObj: redactedRecordA, redactedText: redactedTextA } = assertCleanOrThrowObject(recordA, { privatePatternsFile }));
    ({ redactedObj: redactedRecordB, redactedText: redactedTextB } = assertCleanOrThrowObject(recordB, { privatePatternsFile }));
  } catch (err) {
    return { ok: false, reason: `Privacy check refused to clear evidence for writing: ${err.message}` };
  }
  // redactedRecordA/B are parsed OBJECTS already (never re-serialized-then-reparsed) -- with
  // redaction happening on each raw string VALUE before the one-and-only JSON.stringify() call,
  // that call always produces syntactically valid JSON no matter what a replacement string
  // contains (JSON.stringify correctly escapes a raw newline, quote, etc. in its output), so the
  // "redaction breaks JSON syntax" failure mode from an earlier version is now structurally
  // impossible here, not just detected after the fact. Still re-validate against the schema: a
  // redaction placeholder could still make a field the wrong TYPE for its own domain (e.g. a
  // boolean-context field replaced with a non-boolean placeholder string).
  for (const [label, record] of [['A', redactedRecordA], ['B', redactedRecordB]]) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      return { ok: false, reason: `Redacted run record ${label} failed schema validation (redaction corrupted a field) -- refusing to write: ${JSON.stringify(errors)}` };
    }
  }
  const gate = hardGateFn(recordA, recordB, runA, runB);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  // The evidence directory path itself can carry the real OS username (this repo may be checked
  // out under e.g. C:\Users\<name>\...). Verified BEFORE anything is written: an earlier version
  // wrote all four files first and only checked outDir's own redaction-safety afterward, so a
  // private-patterns rule matching only the (possibly KMP_EVAL_RUNS_ROOT-overridden) runs-root
  // path itself -- never the record content, which was already verified clean above -- could
  // report {ok:false} after real evidence and raw transcripts were already committed to disk,
  // contradicting this function's own "any failure returns {ok:false} and writes nothing"
  // contract. `outDir` stays the REAL, navigable path (a caller may legitimately need it, e.g. a
  // test asserting a file exists there) -- `redactedOutDir` is the separate, display-safe value
  // for anything printed to a terminal. A single raw path string (never JSON-serialized), so the
  // plain text-level assertCleanOrThrow is the correct tool here, not the object-aware variant.
  const outDir = resolveEvidenceOutDir(runKind, runsRootOverride);
  let redactedOutDir;
  try {
    redactedOutDir = assertCleanOrThrow(outDir, { privatePatternsFile });
  } catch (err) {
    return { ok: false, reason: `Privacy check refused to report the evidence directory path: ${err.message}` };
  }
  // writeRunRecordEvidence can itself refuse (a run_id collision, or the raw destination not
  // being a safe gitignored/outside-worktree location) -- wrapped so that, like every other check
  // in this function, a refusal returns {ok:false, reason} rather than an uncaught exception
  // propagating out of cmdCalibrate/cmdSmoke, which never wrap this call in their own try/catch.
  try {
    writeRunRecordEvidence(runKind, recordA, recordB, runA, runB, redactedTextA, redactedTextB, runsRootOverride);
  } catch (err) {
    return { ok: false, reason: `Evidence write refused: ${err.message}` };
  }
  // redactedRecordA/B (not the originals) are for anything printed to stdout -- a caller
  // printing the originals would bypass the whole privacy check: redaction only ever protected
  // the FILE, never the terminal.
  return { ok: true, reason: null, outDir, redactedOutDir, redactedRecordA, redactedRecordB };
}

/**
 * Calibration's hard gate, extracted as a named, independently-testable function (not an inline
 * closure) specifically so each sub-check can be unit-tested in isolation with precise synthetic
 * inputs -- constructing a real subprocess fixture that fails EXACTLY one of these and none of
 * the others is fragile (e.g. it's not actually verified anywhere what a denied command's own
 * tool_result looks like on a real transcript, so fabricating one for a fixture risks encoding a
 * guess as if it were confirmed fact). Every sub-check is reported by name in the failure reason
 * (not just an aggregate boolean).
 */
function calibrationHardGate(a, b, runAResult, runBResult) {
  const availabilityOk = a.skill_available.value === false && b.skill_available.value === true;
  // The no-skill arm's actual safety property is "never a CONFIRMED invocation" -- whether it
  // ATTEMPTED the call first is not required. A model correctly recognizing the skill isn't in
  // its available tool list and not trying it at all is just as legitimate isolation proof as
  // trying it and getting `Unknown skill` back (both real, observed shapes -- see README
  // "Attempted vs. confirmed invocation"). attempted must still be a genuine OBSERVATION (true or
  // false), though -- a null/unknown value means the capture itself is incomplete and must not
  // silently pass just because invoked happens to read false.
  const noSkillAttemptObserved =
    a.skill_invocation_attempted.value === true || a.skill_invocation_attempted.value === false;
  const noSkillSafetyOk = noSkillAttemptObserved && a.skill_invoked.value === false;
  const currentInvocationOk = b.skill_invocation_attempted.value === true && b.skill_invoked.value === true;
  // A session that never emitted an init event at all is a fundamentally broken/incomplete
  // capture, not a legitimately-observed "skill unavailable" -- without this check, a run with
  // NO init event could still show skill_available:false for the no-skill arm (nothing to derive
  // it from) and happen to match the EXPECTED value there by coincidence, passing availabilityOk
  // for the wrong reason entirely.
  const initOk = runAResult.init != null && runBResult.init != null;
  // The init event's OWN declared profile must match exactly what this harness actually
  // launches with -- proves a genuinely narrow session, not just that ONE happened to arrive.
  const toolProfileOk = hasExpectedToolProfile(runAResult.init, EXPECTED_TOOL_NAMES) && hasExpectedToolProfile(runBResult.init, EXPECTED_TOOL_NAMES);
  // No tool_use ANYWHERE in the transcript may name anything outside Bash/Skill -- a
  // transcript could otherwise use some other tool (e.g. Read) alongside the expected calls and
  // still pass every other check.
  const noUnexpectedToolsOk = findUnexpectedToolUses(runAResult.events, EXPECTED_TOOL_NAMES).length === 0
    && findUnexpectedToolUses(runBResult.events, EXPECTED_TOOL_NAMES).length === 0;
  const processOk = a.terminated === false && b.terminated === false && a.exit_code === 0 && b.exit_code === 0;
  // subtype==='success' (not just is_error===false) -- a session cut off by e.g. the budget cap
  // reports a distinct result.subtype (confirmed: 'error_max_budget_usd') that is NOT
  // necessarily paired with is_error:true, so is_error alone doesn't prove the session ran to a
  // genuine, uninterrupted completion.
  const resultOk = runAResult.result?.subtype === 'success' && runAResult.result?.is_error === false
    && runBResult.result?.subtype === 'success' && runBResult.result?.is_error === false;
  const hookAccountingOk = runAResult.hookStats.everyCallHooked === true && runBResult.hookStats.everyCallHooked === true;
  const ok = availabilityOk && noSkillSafetyOk && currentInvocationOk && initOk && toolProfileOk && noUnexpectedToolsOk && processOk && resultOk && hookAccountingOk;
  return {
    ok,
    reason: ok ? null : `calibration hard gate failed -- availabilityOk:${availabilityOk} noSkillSafetyOk:${noSkillSafetyOk} currentInvocationOk:${currentInvocationOk} initOk:${initOk} toolProfileOk:${toolProfileOk} noUnexpectedToolsOk:${noUnexpectedToolsOk} processOk:${processOk} resultOk:${resultOk} hookAccountingOk:${hookAccountingOk} (A:{available:${a.skill_available.value},attempted:${a.skill_invocation_attempted.value},invoked:${a.skill_invoked.value},terminated:${a.terminated},exit_code:${a.exit_code},result_subtype:${runAResult.result?.subtype},result_is_error:${runAResult.result?.is_error},everyCallHooked:${runAResult.hookStats.everyCallHooked},tools:${JSON.stringify(runAResult.init?.tools)}} B:{available:${b.skill_available.value},attempted:${b.skill_invocation_attempted.value},invoked:${b.skill_invoked.value},terminated:${b.terminated},exit_code:${b.exit_code},result_subtype:${runBResult.result?.subtype},result_is_error:${runBResult.result?.is_error},everyCallHooked:${runBResult.hookStats.everyCallHooked},tools:${JSON.stringify(runBResult.init?.tools)}})`,
  };
}

async function cmdCalibrate(args) {
  const model = args.model ?? 'claude-sonnet-5';
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  const patternsCheck = validatePrivatePatternsFileOrFail(privatePatternsFile);
  if (!patternsCheck.ok) {
    console.error(patternsCheck.reason);
    return 1;
  }
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const templateDir = join(__dirname, 'fixtures', 'calibration-project');
  const conditionPair = await runConditionPair({
    prompt: 'Use the kmp-test-runner skill to check this project.',
    model,
    allowedGradleTasks: ['build'],
    allowedKmpTestSubcommands: ['doctor', 'parallel'],
    materializeFixture: (existingDir) => materializeCalibrationProject({ templateDir, existingDir }),
    cleanupFixture: (fixtureDir) => rmSync(fixtureDir, { recursive: true, force: true }),
  });
  try {
    const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands } = conditionPair;
    const policySha256 = computePolicySha256();
    const common = { runKind: 'calibration', scenarioId: 'calibration-explicit-invocation', skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, modelRequested: model, privacyStatus };
    const recordA = buildRunRecord({ conditionResult: runA, condition: 'no-skill', ...common });
    const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });

    // Calibration's job is narrowly to prove invocation MECHANICS under an explicit-invocation
    // prompt -- see calibrationHardGate's own doc comment for why this is a named function.
    const result = await finalizeAndWriteRecords({
      runKind: 'calibration', recordA, recordB, runA, runB, privatePatternsFile,
      hardGateFn: calibrationHardGate,
    });
    if (!result.ok) {
      console.error(`CALIBRATION FAILED: ${result.reason}`);
      return 1;
    }
    console.log(JSON.stringify({ recordA: result.redactedRecordA, recordB: result.redactedRecordB, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } finally {
    reportCleanupFailures(await conditionPair.cleanup());
  }
}

/**
 * Smoke's hard gate, extracted as a named, independently-testable function for the same reason
 * as calibrationHardGate. Requires EQUIVALENT REAL WORK in both arms -- not just skill
 * availability. skill_invoked is deliberately NOT required (whether the skill triggers
 * naturally on this prompt is an open question for a future corpus-probe run, not something
 * smoke should presuppose).
 */
function smokeHardGate(a, b, runAResult, runBResult) {
  const availabilityOk = a.skill_available.value === false && b.skill_available.value === true;
  // See calibrationHardGate's identical check -- a session with no init event at all is a
  // broken/incomplete capture, not legitimately-observed data.
  const initOk = runAResult.init != null && runBResult.init != null;
  // See calibrationHardGate's identical checks -- the init event's OWN declared profile must
  // match what this harness actually launches with, and no tool_use anywhere in the transcript
  // may name anything outside Bash/Skill.
  const toolProfileOk = hasExpectedToolProfile(runAResult.init, EXPECTED_TOOL_NAMES) && hasExpectedToolProfile(runBResult.init, EXPECTED_TOOL_NAMES);
  const noUnexpectedToolsOk = findUnexpectedToolUses(runAResult.events, EXPECTED_TOOL_NAMES).length === 0
    && findUnexpectedToolUses(runBResult.events, EXPECTED_TOOL_NAMES).length === 0;
  const processOk = a.terminated === false && b.terminated === false && a.exit_code === 0 && b.exit_code === 0;
  // subtype==='success' (not just is_error===false) -- see calibrationHardGate's identical
  // check; a budget-cap-truncated session is not a genuine completion even when is_error is
  // false for that particular subtype.
  const resultOk = runAResult.result?.subtype === 'success' && runAResult.result?.is_error === false
    && runBResult.result?.subtype === 'success' && runBResult.result?.is_error === false;
  const hookAccountingOk = runAResult.hookStats.everyCallHooked === true && runBResult.hookStats.everyCallHooked === true;
  // hook_call_count>=1 proves the agent actually tried real commands; hook_deny_count===0 proves
  // every command it tried was inside the approved grammar; hookAllowCount matching
  // hook_call_count proves every decision was explicitly "allow", not merely "not deny" (a
  // hook_response with unparseable `output` JSON produces neither an allow nor a deny decision --
  // hook_deny_count===0 alone would silently accept that).
  const realWorkOk = a.hook_call_count >= 1 && a.hook_deny_count === 0 && runAResult.hookStats.hookAllowCount === a.hook_call_count
    && b.hook_call_count >= 1 && b.hook_deny_count === 0 && runBResult.hookStats.hookAllowCount === b.hook_call_count;
  // Requires the EXACT expected multiset (both commands, --json included, exactly once each, no
  // extras) -- see verifyExactCommandsSucceeded's own doc comment.
  const exactCommandsOk = verifyExactCommandsSucceeded(runAResult.bashResults, SMOKE_EXPECTED_COMMANDS)
    && verifyExactCommandsSucceeded(runBResult.bashResults, SMOKE_EXPECTED_COMMANDS);
  const cleanTranscriptOk = runAResult.malformedLines.length === 0 && runBResult.malformedLines.length === 0;
  const ok = availabilityOk && initOk && toolProfileOk && noUnexpectedToolsOk && processOk && resultOk && hookAccountingOk && realWorkOk && exactCommandsOk && cleanTranscriptOk;
  return {
    ok,
    reason: ok ? null : `smoke hard gate failed -- availabilityOk:${availabilityOk} initOk:${initOk} toolProfileOk:${toolProfileOk} noUnexpectedToolsOk:${noUnexpectedToolsOk} processOk:${processOk} resultOk:${resultOk} hookAccountingOk:${hookAccountingOk} realWorkOk:${realWorkOk} exactCommandsOk:${exactCommandsOk} cleanTranscriptOk:${cleanTranscriptOk} (A hook_call_count:${a.hook_call_count} hook_deny_count:${a.hook_deny_count} hookAllowCount:${runAResult.hookStats.hookAllowCount} result_subtype:${runAResult.result?.subtype} tools:${JSON.stringify(runAResult.init?.tools)}, B hook_call_count:${b.hook_call_count} hook_deny_count:${b.hook_deny_count} hookAllowCount:${runBResult.hookStats.hookAllowCount} result_subtype:${runBResult.result?.subtype} tools:${JSON.stringify(runBResult.init?.tools)})`,
  };
}

async function cmdSmoke(args) {
  const model = args.model ?? 'claude-sonnet-5';
  const sourceRepoDir = args['source-repo-dir'];
  const pinnedCommit = args['pinned-commit'];
  const projectAlias = args['project-alias'] ?? 'kampkit';
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  if (!sourceRepoDir || !pinnedCommit) {
    console.error('smoke requires --source-repo-dir <local clone> --pinned-commit <sha> [--project-alias <alias>]');
    return 1;
  }
  const patternsCheck = validatePrivatePatternsFileOrFail(privatePatternsFile);
  if (!patternsCheck.ok) {
    console.error(patternsCheck.reason);
    return 1;
  }
  // scenario_id and project_url both derive from the ACTUAL project smoke is pointed at, never
  // hardcoded -- an earlier version hard-coded scenario_id to 'kampkit-android-host-test-
  // discovery' regardless of --source-repo-dir/--project-alias, so a run against a DIFFERENT
  // project would still be labeled as if it were KaMPKit. project_url is the real git remote
  // origin URL of sourceRepoDir (null if it has none, e.g. a purely-local fixture repo).
  const scenarioId = `${projectAlias}-android-host-test-discovery`;
  const projectUrl = resolveGitRemoteUrl(sourceRepoDir);
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const conditionPair = await runConditionPair({
    // Explicit and directive on purpose: smoke exists to prove the pipeline works end-to-end
    // with REAL diagnostic work in both arms, not to test whether the skill triggers naturally
    // (that is a corpus-probe concern, deliberately out of scope here). An earlier, open-ended
    // prompt ("check whether this project's test setup is healthy") drove the agent toward
    // general exploration (ls/pwd/git status/find/cat) that the policy hook's narrow grammar
    // correctly denies by design -- 11/13 and 6/6 calls were denied in that run, meaning the
    // agent never actually got to do the diagnostic work smoke exists to prove. Naming the exact
    // two read-only commands removes the need to explore.
    prompt: "Run `kmp-test doctor --json` in this project directory, then run `kmp-test describe --json`. Based only on their output, tell me whether the test setup looks healthy. Do not run any other commands or tools.",
    model,
    allowedGradleTasks: [],
    allowedKmpTestSubcommands: ['doctor', 'describe'],
    materializeFixture: (existingWorktreeDir) => materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir }),
    cleanupFixture: (fixtureDir) => removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir }),
    timeoutMs: 180000,
  });
  try {
    const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands } = conditionPair;
    const policySha256 = computePolicySha256();
    const common = { runKind: 'smoke', scenarioId, skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias, projectCommit: pinnedCommit, projectUrl, family: 'test-only', modelRequested: model, privacyStatus };
    const recordA = buildRunRecord({ conditionResult: runA, condition: 'no-skill', ...common });
    const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });

    // Smoke's gate requires EQUIVALENT REAL WORK in both arms -- not just skill availability.
    // Every sub-check is reported by name in the failure reason (not just an aggregate boolean)
    // specifically so a negative-fixture test can assert WHICH check failed, proving the fixture
    // isolates the ONE failure mode it claims to. skill_invoked is deliberately NOT required
    // here (whether the skill triggers naturally on this prompt is exactly the open question a
    // future corpus-probe run would investigate, not something smoke should presuppose).
    const result = await finalizeAndWriteRecords({
      runKind: 'smoke', recordA, recordB, runA, runB, privatePatternsFile,
      hardGateFn: smokeHardGate,
    });
    if (!result.ok) {
      console.error(`SMOKE FAILED: ${result.reason}`);
      return 1;
    }
    console.log(JSON.stringify({ recordA: result.redactedRecordA, recordB: result.redactedRecordB, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } finally {
    reportCleanupFailures(await conditionPair.cleanup());
  }
}

function cmdCorpusValidate() {
  const corpusDir = join(__dirname, 'corpus');
  const scenariosDir = join(corpusDir, 'scenarios');
  let ok = true;
  if (existsSync(scenariosDir)) {
    for (const file of readdirSync(scenariosDir)) {
      if (!file.endsWith('.json')) continue;
      const scenario = JSON.parse(readFileSync(join(scenariosDir, file), 'utf8'));
      const { errors } = validateScenario(scenario);
      if (errors.length > 0) {
        console.error(`${file}: ${JSON.stringify(errors)}`);
        ok = false;
      } else {
        console.log(`${file}: OK`);
      }
    }
  }
  const triggerPath = join(corpusDir, 'trigger-queries.json');
  if (existsSync(triggerPath)) {
    const triggers = JSON.parse(readFileSync(triggerPath, 'utf8'));
    const shouldTrigger = triggers.queries.filter((q) => q.expected === 'should-trigger');
    const nearMiss = triggers.queries.filter((q) => q.expected === 'near-miss');
    console.log(`trigger-queries.json: ${shouldTrigger.length} should-trigger, ${nearMiss.length} near-miss`);
    // Validates actual CONTENT (shape, unique ids, banned-terms rule, suspicious-activation-hint
    // rule, partition coverage) -- not just the category counts above. An earlier version of
    // this command only did the category count, contradicting the README's claim that `corpus
    // validate` checks shape and banned terms.
    const { errors } = validateTriggerQueries(triggers);
    if (errors.length > 0) {
      console.error(`trigger-queries.json: ${JSON.stringify(errors)}`);
      ok = false;
    }
  }
  return ok ? 0 : 1;
}

function cmdAggregate(args) {
  const runsDir = args['runs-dir'];
  if (!runsDir || !existsSync(runsDir)) {
    console.error('--runs-dir <dir> is required and must exist');
    return 1;
  }
  // aggregateRuns() validates every record against the full run schema itself (schema-invalid
  // records are excluded and reported in `errors`, keyed by run_id) -- no separate pre-filter
  // needed here.
  const runs = readdirSync(runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')));
  const { groups, errors } = aggregateRuns(runs);
  console.log(JSON.stringify({ groups, errors }, null, 2));
  return errors.length > 0 ? 1 : 0;
}

function cmdValidate(args) {
  const runPath = args.run;
  if (!runPath || !existsSync(runPath)) {
    console.error('--run <path> is required and must exist');
    return 1;
  }
  const record = JSON.parse(readFileSync(runPath, 'utf8'));
  const { errors, warnings } = validateRun(record);
  console.log(JSON.stringify({ errors, warnings }, null, 2));
  return errors.length > 0 ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    process.stderr.write(`Argument error: ${args.errors.join('; ')}\n\n${HELP}`);
    return 1;
  }
  const sub = args._[0];

  if (args.help || sub == null) {
    process.stdout.write(HELP);
    return 0;
  }
  const shapeErrors = validateSubcommandArgs(sub, args);
  if (shapeErrors.length > 0) {
    process.stderr.write(`Argument error: ${shapeErrors.join('; ')}\n\n${HELP}`);
    return 1;
  }
  switch (sub) {
    case 'calibrate': return cmdCalibrate(args);
    case 'corpus': return args._[1] === 'validate' ? cmdCorpusValidate() : (process.stderr.write('usage: corpus validate\n'), 1);
    case 'aggregate': return cmdAggregate(args);
    case 'validate': return cmdValidate(args);
    case 'smoke': return cmdSmoke(args);
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n\n${HELP}`);
      return 1;
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('cli.mjs');
if (isMain) {
  // process.exitCode (never process.exit()) -- an explicit exit() can terminate the process
  // before a piped stdout's buffered console.log() output has actually flushed, silently
  // truncating the JSON this CLI's own subcommands print. Setting exitCode and returning lets
  // Node drain the event loop (including pending stdout writes) naturally before exiting; the
  // exact same class of bug this harness already fixed once in policy-hook.mjs's write-then-exit
  // ordering.
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`agentic-eval: ${err.stack || err.message}\n`);
    process.exitCode = 2;
  });
}

export { parseArgs, validateSubcommandArgs, validatePrivatePatternsFileOrFail, cmdCorpusValidate, cmdAggregate, cmdValidate, cmdCalibrate, cmdSmoke, buildRunRecord, nullableMetric, runConditionPair, finalizeAndWriteRecords, writeRunRecordEvidence, calibrationHardGate, smokeHardGate, verifyExactCommandsSucceeded, resolveHarnessProvenance, findBlockingHarnessToolingDirty, isRunsRootDefault, SMOKE_EXPECTED_COMMANDS, SUBCOMMAND_SHAPES, PINNED_SKILL_SHA };
