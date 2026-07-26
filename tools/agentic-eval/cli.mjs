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
//   node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n>
//                                        [--repeats <n>] [--model <name>] [--dry-run]
//                                        [--private-patterns-file <path>]
//   node tools/agentic-eval/cli.mjs corpus validate
//   node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
//   node tools/agentic-eval/cli.mjs validate --run <path-to-run.json>
//   node tools/agentic-eval/cli.mjs --help
//
// calibrate/smoke always produce benchmark_eligible:false -- foundation-harness runs proving the
// Skill mechanism invokes at all, never a benchmark result. `run` is the one subcommand that CAN
// produce benchmark_eligible:true records (a fresh review flagged this file's own header as stale
// -- it used to claim EVERY measured run was benchmark_eligible:false and didn't enumerate `run`
// at all, which stopped being true the moment `run` shipped): it executes a full --repeats-sized
// scenario matrix against a scenario in corpus/scenarios/ and grades each condition's transcript
// against that scenario's structured ground truth (graders.mjs); benchmark_eligible depends only
// on protocol/integrity completeness, never on whether the agent's answer was correct.
//
// No committable evidence is ever written before ALL of: schema validation, a fresh
// policy_sha256 match against the CURRENT policy-hook.mjs, the privacy fail-closed check
// (assertCleanOrThrow), and the run-kind's hard acceptance gate all pass -- see
// finalizeAndWriteRecords(). Any failure writes no run evidence and reports why -- a hard-gate
// failure specifically ALSO writes a separate, privacy-safe rejection diagnostic (never a run
// record, never confusable with real evidence by aggregate/validate) -- see
// rejection-diagnostics.mjs.
import { readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { LATEST_RUN_SCHEMA, SUPPORTED_RUN_SCHEMAS, validateRun, validateScenario, validateTriggerQueries } from './schemas.mjs';
import { buildEvalEnv } from './env-builder.mjs';
import { materializeCalibrationProject, materializeScenarioProject, removeScenarioWorktree, realpath } from './materialize.mjs';
import { buildBaseArgv } from './condition-launcher.mjs';
import { isSkillAvailable, findForeignSkillUses, classifyForeignSkillUses, findBashToolUses, findUnexpectedToolUses, hasExpectedToolProfile, hasExpectedPluginProfile, findIncompleteToolResults, findTranscriptStructuralIssues, findTranscriptStructuralIssuesToleratingTimeout, findIncompleteToolResultsToleratingTimeout, extractTokenUsage, deriveFirstUsefulSignalMs, derivePostSignalMs, findAllToolUsesWithResults, computeAmbientSkillProfile, canonicalAmbientSkillNamesKey, fingerprintAmbientSkillNames } from './stream-parser.mjs';
import { acquireSharedEvalResources, runSingleCondition, runScenarioMatrix, reportCleanupFailures } from './matrix-runner.mjs';
import { gradeScenarioCondition } from './graders.mjs';
import { buildRunMatrix, buildConditionOrders } from './randomizer.mjs';
import { aggregateRuns } from './aggregate.mjs';
import { assertCleanOrThrow, assertCleanOrThrowObject, loadPrivateRules } from './privacy.mjs';
import { tokenize } from './policy-hook.mjs';
import { runValidator as runPluginValidator } from '../validate-plugin.mjs';
import { RUNS_ROOT, resolveEvidenceOutDir, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { buildRejectionDiagnostics, writeRejectedRunDiagnostics } from './rejection-diagnostics.mjs';
import { acceptedAuditRelativePathFor, buildAcceptedRunAuditSidecar, finalizeAcceptedRunAuditSidecar, validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from './accepted-run-audit.mjs';
import { loadMeasurementScopeFile, createMeasurementScopeFileExclusive } from './measurement-scope.mjs';

// dirname(fileURLToPath(...)), not import.meta.dirname -- the latter needs Node 20.11+/21.2+,
// but package.json declares "node": ">=18" (confirmed to actually matter on a real ubuntu-latest
// CI job -- see condition-launcher.mjs's identical fix for the full story).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const PINNED_SKILL_SHA = '21f189403e86b4720f0d2c6a547353fb108252b4';
// KMP_EVAL_RUNS_ROOT override exists specifically so tests never write to (or, worse, clean up
// inside) the real committable tools/runs/ directory -- an earlier version of the integration
// test suite listed and deleted files directly under the real RUNS_ROOT, including an
// unconditional recursive delete of the whole raw/ subdirectory in its own afterEach. Redirecting
// this makes that class of bug structurally impossible rather than relying on the test being
// careful. (RUNS_ROOT itself is now defined once in evidence-io.mjs and imported here, so this
// module and evidence-io.mjs can never compute two different values for it.)
// KMP_EVAL_SCENARIOS_DIR mirrors KMP_EVAL_RUNS_ROOT's exact rationale, one directory over: a
// test-only escape hatch so cmdRun's integration tests can point --scenario at a synthetic,
// throwaway scenario (a tiny local git repo standing in for a real project, exactly like smoke's
// own integration tests already do for --source-repo-dir) without writing into -- or being
// limited to -- the real, committed corpus/scenarios/ directory, which is scoped to exactly the
// two real, pinned-commit scenarios this PR ships. Never meant for production use.
const SCENARIOS_DIR = process.env.KMP_EVAL_SCENARIOS_DIR || join(__dirname, 'corpus', 'scenarios');
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

// Regression coverage for a real evidence-contamination bypass an independent review pass
// demonstrated directly against calibrationHardGate: hasExpectedPluginProfile only checks the
// LOADED plugin's name and count -- never its `path` -- so a same-named "kmp-test-runner" plugin
// loaded from a completely unrelated directory satisfied it outright. The run record still
// publishes skill_source_sha as the harness's PINNED_SKILL_SHA regardless (buildRunRecord has no
// way to know the loaded plugin came from somewhere else), so evidence could be attributed to a
// SHA whose actual, verified snapshot was never the thing exercised. This is the provenance
// guarantee skill_source_sha implicitly claims -- closing it requires binding the reported path
// to the SAME materialized snapshot directory this specific run actually built.
//
// Compared via FILESYSTEM IDENTITY (device + inode from statSync), never a string comparison of
// resolved paths -- a review-round-5 finding demonstrated a bare case-folded comparison
// (resolvedReported.toLowerCase() === resolvedExpected.toLowerCase(), the previous approach here)
// is unsound on Windows: NTFS volumes support PER-DIRECTORY case sensitivity (fsutil.exe file
// setCaseSensitiveInfo, shipped for WSL interop since Windows 10 1803), under which two
// DIFFERENTLY-cased paths can be two GENUINELY DISTINCT directories -- a case-folded string
// compare would wrongly treat them as the same snapshot. isRunsRootDefault's OWN case-fold is
// safe specifically because a false positive there only engages STRICTER scrutiny (erring toward
// "true" is the safe direction for that check) -- that justification does not transfer here: a
// false positive in THIS check would APPROVE the WRONG plugin outright, exactly the provenance
// guarantee this function exists to protect. dev+ino is the OS's own unambiguous identity for a
// filesystem entry, invariant to case, trailing separators, or symlink/junction indirection --
// statSync follows symlinks on both inputs the same way realpath would have, so no separate
// realpath step is needed first. {bigint:true} avoids precision loss on Windows, where NTFS file
// IDs can exceed Number.MAX_SAFE_INTEGER. An unresolvable path fails CLOSED: "can't positively
// confirm this is the expected snapshot" must mean "reject", never "assume it's fine". Deliberately
// returns ONLY a boolean -- the actual path (which could itself be privacy-sensitive, e.g.
// containing the real OS username) is never included in the return value or surfaced in any
// caller's error/log output.
function isPluginBoundToSnapshot(initEvent, expectedSnapshotDir) {
  if (initEvent == null || !Array.isArray(initEvent.plugins) || initEvent.plugins.length !== 1) return false;
  const reportedPath = initEvent.plugins[0]?.path;
  if (typeof reportedPath !== 'string' || reportedPath.length === 0) return false;
  if (typeof expectedSnapshotDir !== 'string' || expectedSnapshotDir.length === 0) return false;
  let reportedStat;
  let expectedStat;
  try {
    reportedStat = statSync(reportedPath, { bigint: true });
  } catch {
    return false; // reported path doesn't exist / unresolvable -- fail closed, never assume a match
  }
  try {
    expectedStat = statSync(expectedSnapshotDir, { bigint: true });
  } catch {
    return false; // the harness's OWN expected snapshot vanished -- also fail closed
  }
  return reportedStat.dev === expectedStat.dev && reportedStat.ino === expectedStat.ino;
}

const HELP = `tools/agentic-eval/cli.mjs -- reproducible skill evaluation harness

Usage:
  node tools/agentic-eval/cli.mjs calibrate [--model <name>] [--private-patterns-file <path>]
                                             [--measurement-scope-file <path>]
  node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
                                         [--project-alias <alias>] [--model <name>]
                                         [--private-patterns-file <path>]
                                         [--measurement-scope-file <path>]
  node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n>
                                       [--repeats <n>] [--model <name>] [--dry-run]
                                       [--private-patterns-file <path>]
                                       [--measurement-scope-file <path>]
  node tools/agentic-eval/cli.mjs scope init --out <path>
  node tools/agentic-eval/cli.mjs corpus validate
  node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
  node tools/agentic-eval/cli.mjs validate --run <path>
  node tools/agentic-eval/cli.mjs --help

calibrate/smoke always produce benchmark_eligible:false -- foundation-harness runs proving the
Skill mechanism invokes at all, not benchmark results. run executes a full --repeats-sized
scenario matrix against a scenario in corpus/scenarios/ and grades each condition's transcript
against that scenario's structured ground truth (tools/agentic-eval/graders.mjs); a resulting
record's benchmark_eligible depends only on protocol/integrity completeness, never on whether the
agent's answer was correct -- see tools/agentic-eval/README.md. --measurement-scope-file <path>
loads a local, secret scope file (created via scope init --out <path>) instead of generating a
fresh ephemeral one, so independent invocations sharing the same file remain comparable for
longitudinal aggregate -- omitting it preserves today's exact per-invocation behavior; see
README.md's "Measurement scope" section for creation/reuse/rotation/privacy semantics. No
evidence is committable until
schema, policy-hash freshness, privacy, and the run-kind's hard acceptance gate all pass.
`;

/** Flags that are pure presence/absence booleans -- never consume the next token as a value.
 * `--dry-run` is the only one today (the `run` subcommand's zero-spawn plan-inspection mode,
 * mirroring the main kmp-test CLI's own `--dry-run`). Kept as its own named set (not inferred from
 * SUBCOMMAND_SHAPES, which is subcommand-scoped) because parseArgs itself is deliberately
 * subcommand-unaware -- see its own doc comment. */
const BOOLEAN_FLAGS = new Set(['dry-run']);

/**
 * Every `--flag` here (other than --help/-h, or a member of BOOLEAN_FLAGS) requires a value. A
 * flag with no following argument, or immediately followed by another `--flag` (never consumed as
 * that flag's value), is recorded in `errors` rather than silently assigned `undefined` -- an
 * undefined value previously fell through `?? null` fallbacks unnoticed, so e.g. a trailing
 * `--private-patterns-file` with nothing after it silently disabled private-pattern redaction
 * and reported the run as 'public' instead of failing loudly. A flag provided more than once is
 * also an error (silent last-wins previously masked what's very likely a copy-paste mistake) --
 * this applies to BOOLEAN_FLAGS too (a duplicated bare `--dry-run --dry-run` is still an error).
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
      if (BOOLEAN_FLAGS.has(name)) {
        if (name in out) {
          out.errors.push(`--${name} was provided more than once`);
        }
        out[name] = true;
        continue;
      }
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
  calibrate: { flags: ['model', 'private-patterns-file', 'measurement-scope-file'], extraPositionals: 0 },
  smoke: { flags: ['model', 'source-repo-dir', 'pinned-commit', 'project-alias', 'private-patterns-file', 'measurement-scope-file'], extraPositionals: 0 },
  run: { flags: ['scenario', 'source-repo-dir', 'seed', 'repeats', 'model', 'dry-run', 'private-patterns-file', 'measurement-scope-file'], extraPositionals: 0 },
  corpus: { flags: [], extraPositionals: 1 }, // corpus <validate>
  aggregate: { flags: ['runs-dir'], extraPositionals: 0 },
  validate: { flags: ['run'], extraPositionals: 0 },
  scope: { flags: ['out'], extraPositionals: 1 }, // scope <init>
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

/** The ONE abstraction cmdCalibrate/cmdSmoke/cmdRun each call exactly once, replacing the 3
 * direct generateAmbientProfileScope() calls that used to sit later in each function (see that
 * function's own doc comment, unchanged below). No --measurement-scope-file supplied preserves
 * today's exact ephemeral behavior byte-for-byte; a supplied file is eagerly loaded/validated
 * here -- fail-closed on every malformed class -- BEFORE any Claude session spawns (measurement-
 * scope.mjs's own loadMeasurementScopeFile never throws a message containing the secret key).
 * Returns {ok:true, scopeId, key, source:'ephemeral'|'supplied'} or {ok:false, reason}, mirroring
 * validatePrivatePatternsFileOrFail's own shape -- never throws. */
function resolveMeasurementScopeOrFail(measurementScopeFile) {
  // Only null/undefined mean "flag omitted" -- an explicitly-supplied empty string (reachable via
  // `--measurement-scope-file ''`, since parseArgs happily accepts an empty-but-present value) is
  // NOT the same as omission and must fail closed as an invalid path, not silently fall back to
  // ephemeral. A falsy check (`!measurementScopeFile`) previously treated '' the same as omitted.
  if (measurementScopeFile == null) {
    return { ok: true, source: 'ephemeral', ...generateAmbientProfileScope() };
  }
  try {
    return { ok: true, source: 'supplied', ...loadMeasurementScopeFile(measurementScopeFile) };
  } catch (err) {
    return { ok: false, reason: `--measurement-scope-file is invalid: ${err.message}` };
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

// The ONLY plugin/skill identity findSkillInvocation/findForeignSkillUses/isSkillAvailable/
// hasExpectedPluginProfile ever target -- two single shared constants (never collapsed into one)
// so every call site (buildRunRecord's own attempted/invoked/tool_calls_total derivation, both
// hard gates' skillSelectionOk/pluginProfileOk checks) can never drift out of agreement with each
// other on what "the expected skill" actually is. Kept as two DISTINCT constants -- one for the
// plugin's own identity (plugin.json's `name`, what initEvent.plugins[].name reports), one for the
// skill's own identity within that plugin (what a bare Skill invocation's `input.skill` uses, and
// the suffix of Claude Code's plugin-namespaced `${pluginName}:${skillName}` addressing form) --
// even though this harness's own plugin and skill happen to share one literal string value. See
// stream-parser.mjs's isTargetSkillReference for the full rationale: deriving the namespaced form
// as `${TARGET_SKILL_NAME}:${TARGET_SKILL_NAME}` would have worked today by coincidence but
// conflated two genuinely different identities.
const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

/**
 * Generates the ONE random HMAC key + opaque scope id for a single harness invocation --
 * resolveMeasurementScopeOrFail's ephemeral branch calls this exactly once, when no
 * --measurement-scope-file is supplied (its supplied branch loads a stable {scopeId, key} pair
 * from a local secret file instead -- see measurement-scope.mjs). This function itself is
 * unchanged: still private, still called before building any records. Review-round-2 fix
 * (correction 2): the original ambient-skill-profile fingerprint was an
 * UNKEYED SHA-256 hash, directly demonstrated to be reversible by dictionary attack against the
 * small, guessable universe of real Claude Code skill names. `key` (32 random bytes) is shared by
 * EVERY cell within this SAME invocation (so a matrix's cells can still be meaningfully compared
 * against each other) and MUST NEVER be persisted anywhere -- only the HMAC digests it produces
 * are recorded (stream-parser.mjs's fingerprintAmbientSkillNames). `scopeId` is a separate, opaque
 * per-invocation UUID that IS recorded (ambient_skill_profile.scope_id on every record from this
 * invocation) specifically so two records can be told apart as "from the same invocation, hence
 * comparable" vs. "from different invocations, hence never meaningfully comparable" without ever
 * needing to reveal or reconstruct the key itself.
 * @returns {{scopeId: string, key: Buffer}}
 */
function generateAmbientProfileScope() {
  return { scopeId: randomUUID(), key: randomBytes(32) };
}

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
  // Thin wrapper over matrix-runner.mjs's acquireSharedEvalResources/runSingleCondition (extracted
  // so a scenario-matrix run, which repeats this same acquire-then-run shape N times instead of
  // once, can reuse the identical machinery without duplicating it). The external contract here is
  // unchanged: acquisition happens once, resources are cleaned up incrementally on any failure
  // (regression-tested by agentic-eval-run-condition-pair.test.js), and the two conditions run in
  // the exact fixed order (`current-skill` then `no-skill`) this function has always used --
  // calibrate/smoke never get counterbalancing (see decision 2/matrix-runner.mjs for where that
  // now lives, scoped to the new `run` subcommand only).
  const shared = await acquireSharedEvalResources({
    allowedGradleTasks, allowedKmpTestSubcommands, repoRoot: REPO_ROOT,
    pinnedSkillSha: PINNED_SKILL_SHA, runPluginValidator,
    // calibrate/smoke never enable JUnit-evidence attribution -- explicit here (not merely relying
    // on the default) so a future reader sees this is a deliberate exclusion, not an oversight.
    // buildPolicySettingsFile's own output is byte-for-byte identical to before this mechanism
    // existed whenever this is false.
    junitEvidenceEnabled: false,
  });
  const { registerCleanup, runCleanup } = shared;

  try {
    const baseArgv = buildBaseArgv({ prompt, model, settingsPath: shared.settingsPath });

    let fixtureDir;
    let fixtureCleanupQueued = false;
    const cleanupFixtureOnce = (dir) => {
      if (!fixtureCleanupQueued && cleanupFixture) {
        fixtureCleanupQueued = true;
        registerCleanup(() => cleanupFixture(dir));
      }
    };
    const runOneCondition = async (condition) => {
      const conditionResult = await runSingleCondition({
        condition, materializeFixture, previousFixtureDir: fixtureDir, cleanupFixtureOnce,
        resetGradleToSnapshot: shared.resetGradleToSnapshot, kmpEvalTempHome: shared.kmpEvalTempHome,
        sharedEnv: shared.sharedEnv, baseArgv, snapshotDir: shared.snapshotDir,
        targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, timeoutMs,
        junitEvidenceEnabled: false,
      });
      fixtureDir = conditionResult.fixtureDir;
      return conditionResult;
    };

    const runB = await runOneCondition('current-skill');
    const runA = await runOneCondition('no-skill');

    return { runA, runB, snapshotDir: shared.snapshotDir, daemonPolicy: shared.daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, cleanup: runCleanup };
  } catch (err) {
    reportCleanupFailures(await runCleanup(), 'during condition-execution rollback');
    throw err;
  }
}

function buildRunRecord({
  conditionResult, condition, runKind, scenarioId, skillSourceSha, daemonPolicy,
  allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias = 'calibration-project',
  projectCommit = null, projectUrl = null, family = 'trigger-only', modelRequested = 'claude-sonnet-5',
  privacyStatus = 'public',
  // Scenario-only (decisions 6/12/13) -- every one defaults so calibrate/smoke's existing call
  // sites are completely unaffected. `gradeResult` is graders.mjs's gradeScenarioCondition() own
  // return value, computed by the CALLER (cmdRun) -- buildRunRecord never grades anything itself,
  // it only reports an already-computed verdict, keeping grading and record-construction as two
  // separately-testable concerns.
  seed = null, orderIndex = null, repetitionIndex = null, gradeResult = null,
  // ambientProfileScopeId/ambientProfileKey (correction 2): the ONE opaque scope id + random HMAC
  // key generated once per harness invocation (generateAmbientProfileScope), shared by every
  // record this invocation produces -- REQUIRED (no default), so a caller can never silently fall
  // back to an unkeyed/absent key.
  ambientProfileScopeId, ambientProfileKey,
}) {
  const { init, result, invocation, hookStats, byteMetrics, startedAt, endedAt } = conditionResult;
  const isScenario = runKind === 'scenario';
  const notApplicableReason = `${runKind} run -- no scenario grader applies`;
  // Computed once, shared by tool_calls_total (below) and foreign_skill_summary (schema V3) --
  // never re-derived twice from the same transcript.
  const foreignSkillUses = classifyForeignSkillUses(conditionResult.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME);
  const foreignSkillSummary = {
    rejected: foreignSkillUses.filter((u) => u.resultIsError === true).length,
    confirmed: foreignSkillUses.filter((u) => u.confirmed === true).length,
    incomplete: foreignSkillUses.filter((u) => u.resultIsError === null).length,
  };
  // ambient_skill_profile (schema V4): a privacy-safe {count, scope_id, fingerprint_hmac} summary
  // of the init event's skills[] array with the TARGET skill's own bare/namespaced identity
  // stripped out (computeAmbientSkillProfile, stream-parser.mjs) -- never the raw names
  // themselves. Always computed regardless of run_kind or ambientProfile.ok: a malformed
  // transcript still gets a real, non-null value recorded here (schema requires it non-null on
  // every record); only scenarioCellIntegrityOk/calibrationHardGate/smokeHardGate (below) actually
  // enforce strictness on `.ok`. `expectTargetPresent` is condition-aware (correction 1) -- a
  // no-skill cell must show ZERO target references in skills[] (not merely zero CONFIRMED
  // invocations), a current-skill cell may show exactly one. `fingerprintAmbientSkillNames` is now
  // HMAC-keyed by this invocation's own random, never-persisted key (correction 2) -- see
  // generateAmbientProfileScope's own doc comment for the full privacy rationale.
  const ambientProfile = computeAmbientSkillProfile(init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: condition === 'current-skill' });
  const ambientSkillProfile = {
    count: ambientProfile.names.size,
    scope_id: ambientProfileScopeId,
    fingerprint_hmac: fingerprintAmbientSkillNames(ambientProfile.names, ambientProfileKey),
  };
  // post_signal_ms/post_signal_tool_calls/policy_denials_{before,after}_first_signal (schema V5):
  // the ONE unified boundary (gradeResult.firstUsefulSignalEventIndex) decides all 4 -- computed
  // once, here, so they can never independently drift on what "the boundary" means. Non-scenario
  // records (and a scenario record with no boundary at all) get null+reason for all 4, mirroring
  // first_useful_signal_ms's own established convention.
  const firstUsefulSignalEventIndex = isScenario ? gradeResult.firstUsefulSignalEventIndex : null;
  const hasSignalBoundary = firstUsefulSignalEventIndex != null;
  const noSignalBoundaryReason = 'no first useful signal boundary';
  let postSignalMs;
  let postSignalToolCalls;
  let policyDenialsBeforeFirstSignal;
  let policyDenialsAfterFirstSignal;
  if (!isScenario) {
    postSignalMs = nullableMetric(null, notApplicableReason);
    postSignalToolCalls = nullableMetric(null, notApplicableReason);
    policyDenialsBeforeFirstSignal = nullableMetric(null, notApplicableReason);
    policyDenialsAfterFirstSignal = nullableMetric(null, notApplicableReason);
  } else if (!hasSignalBoundary) {
    postSignalMs = nullableMetric(null, noSignalBoundaryReason);
    postSignalToolCalls = nullableMetric(null, noSignalBoundaryReason);
    policyDenialsBeforeFirstSignal = nullableMetric(null, noSignalBoundaryReason);
    policyDenialsAfterFirstSignal = nullableMetric(null, noSignalBoundaryReason);
  } else {
    postSignalMs = nullableMetric(derivePostSignalMs(conditionResult.events, firstUsefulSignalEventIndex, conditionResult.spawnResult.endedHrtimeNs));
    // post_signal_tool_calls: every tool_use block (any kind) whose OWN assistant event index is
    // strictly greater than the signal's result event index -- a call dispatched before the
    // signal but completed after it (its own tool_use index is still <= the boundary) is never
    // post-signal work, matching derivePostSignalMs's own dispatch-time (never completion-time)
    // framing.
    postSignalToolCalls = nullableMetric(findAllToolUsesWithResults(conditionResult.events).filter((u) => u.index > firstUsefulSignalEventIndex).length);
    // policy_denials_before/after_first_signal: classify each Bash attempt by its OWN tool-use
    // event index (never its later tool-result index) against the identical boundary.
    const decisionByAttempt = conditionResult.junitAttribution?.decisionByAttempt ?? new Map();
    let before = 0;
    let after = 0;
    for (const b of conditionResult.bashResults ?? []) {
      if (decisionByAttempt.get(b.id) !== 'deny') continue;
      if (b.index > firstUsefulSignalEventIndex) after++; else before++;
    }
    policyDenialsBeforeFirstSignal = nullableMetric(before);
    policyDenialsAfterFirstSignal = nullableMetric(after);
  }
  const provenance = resolveHarnessProvenance();
  // Shared by BOTH dirty_harness_tooling branches below so the two messages can't drift apart
  // again -- this exact drift (the messages claiming "never blocks evidence" after
  // findBlockingHarnessToolingDirty/finalizeAndWriteRecords were made conditionally fail-closed)
  // is the bug this constant exists to prevent from recurring.
  const harnessToolingDispositionNote = `always disclosed here; additionally fail-closed by finalizeAndWriteRecords() when writing to the default, committable RUNS_ROOT -- see resolveHarnessProvenance's own comment for the full conditional reasoning`;
  return {
    schema: LATEST_RUN_SCHEMA,
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
    // decision 12: always 'cold' for a scenario record -- a direct, deterministic consequence of
    // "every cell gets a pristine project + Gradle-state baseline" (materialize resets both the
    // worktree and GRADLE_USER_HOME before every cell), never left as 'unknown'. calibrate/smoke
    // keep their existing 'unknown' (this function never claimed to track their cache state).
    cache_state: isScenario ? 'cold' : 'unknown',
    daemon_policy: daemonPolicy ?? 'unknown',
    env_allowlist_profile: 'narrow',
    seed: isScenario ? seed : null,
    order_index: isScenario ? orderIndex : null,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    wall_clock_ms: endedAt.getTime() - startedAt.getTime(),
    skill_available: nullableMetric(isSkillAvailable(init, TARGET_PLUGIN_NAME)),
    skill_invocation_attempted: nullableMetric(invocation != null),
    skill_invoked: nullableMetric(invocation?.confirmed ?? false),
    skill_invocation_event: invocation ? { type: invocation.type, index: invocation.index } : null,
    // decision 13: for a scenario record, success/expected_outcome_matched are graders.mjs's own
    // already-computed verdict -- real, non-null booleans (which may legitimately be false; a
    // wrong answer is valid negative data, never filtered out). Never re-derived here, never
    // overloaded into notes/errors.
    success: isScenario ? nullableMetric(gradeResult.success) : nullableMetric(null, `${runKind} run -- success grading not applicable`),
    expected_outcome_matched: isScenario ? nullableMetric(gradeResult.expectedOutcomeMatched) : nullableMetric(null, notApplicableReason),
    first_useful_signal_ms: isScenario
      ? nullableMetric(
          gradeResult.firstUsefulSignalEventIndex != null
            ? deriveFirstUsefulSignalMs(conditionResult.events, gradeResult.firstUsefulSignalEventIndex, conditionResult.spawnResult.spawnHrtimeNs)
            : null,
          gradeResult.firstUsefulSignalEventIndex == null ? 'no correlated authoritative outcome event found' : undefined,
        )
      : nullableMetric(null, `${runKind} run -- no first-useful-signal predicate applies`),
    first_useful_signal_event: isScenario && gradeResult.firstUsefulSignalEventIndex != null
      ? { type: 'user.tool_result', index: gradeResult.firstUsefulSignalEventIndex }
      : null,
    // post_signal_ms/post_signal_tool_calls/policy_denials_before_first_signal/
    // policy_denials_after_first_signal (schema V5) -- computed once, above, shared by nothing
    // else. accepted_audit is deliberately NOT set here: buildRunRecord always stamps the null
    // placeholder. cmdRun supplies finalizeAndWriteMatrixRecords a buildSidecarsFn closure, which
    // that function invokes ONLY once the hard gate has confirmed acceptance (accepted-audit work
    // belongs strictly on the gate-passing path) -- THAT callback is what mutates the real
    // {schema, relative_path, sha256} value into each record in place, once the sidecar's own
    // redacted SHA-256 is known. Mirrors the "buildRunRecord stamps a placeholder, something else
    // mutates the real value in before redaction" pattern benchmark_eligible already uses, but via
    // a caller-supplied callback rather than a direct mutation inside this same function.
    post_signal_ms: postSignalMs,
    post_signal_tool_calls: postSignalToolCalls,
    policy_denials_before_first_signal: policyDenialsBeforeFirstSignal,
    policy_denials_after_first_signal: policyDenialsAfterFirstSignal,
    accepted_audit: null,
    tokens: {
      input: nullableMetric(extractTokenUsage(result)?.input ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
      output: nullableMetric(extractTokenUsage(result)?.output ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
      cache_read: nullableMetric(extractTokenUsage(result)?.cache_read ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
      cache_creation: nullableMetric(extractTokenUsage(result)?.cache_creation ?? null, extractTokenUsage(result) ? undefined : 'no result event'),
    },
    // Counts EVERY tool_use block in the transcript, regardless of name (findAllToolUsesWithResults
    // -- the identical helper the accepted-run-audit sidecar's own summary.tool_calls_total uses) --
    // a review finding demonstrated the previous formula (findBashToolUses().length +
    // invocation?.attemptCount + foreignSkillUses.length) silently dropped a genuinely unexpected
    // tool call (e.g. a bare Read) that is neither Bash nor Skill, undercounting the transcript and
    // making the record disagree with its own sidecar on an otherwise-unremarkable run.
    tool_calls_total: nullableMetric(findAllToolUsesWithResults(conditionResult.events).length),
    shell_commands_total: nullableMetric(findBashToolUses(conditionResult.events).length),
    // decision 12: real, non-null counts for a scenario record -- directly reusing the SAME
    // attempt list gradeScenarioCondition already built (never a second, independently-derived
    // count that could drift from what grading itself saw).
    test_invocations_total: isScenario ? nullableMetric(gradeResult.testInvocationsTotal) : nullableMetric(null, `not tracked for ${runKind} runs`),
    retries: isScenario ? nullableMetric(gradeResult.retries) : nullableMetric(null, `not tracked for ${runKind} runs`),
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
    // isScenario-conditioned like every other sibling field in this function -- a scenario
    // record's benchmark_eligible can legitimately be true, so its note must never claim "not a
    // benchmark result" (that claim only holds for calibrate/smoke's foundation-harness runs).
    notes: isScenario
      ? 'Scenario run -- benchmark_eligible reflects protocol/integrity completeness, not answer correctness; see grading_checks and success for the actual outcome.'
      : 'Foundation-harness run; not a benchmark result.',
    // grading_checks (decision 14, v2-only): the full structured per-check detail from
    // gradeScenarioCondition, never overloaded into notes/errors. calibrate/smoke report
    // null+reason -- grading doesn't apply to them at all, not merely "not tracked".
    grading_checks: isScenario
      ? nullableMetric(gradeResult.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail, evidence_event_indices: c.evidence_event_indices })))
      : nullableMetric(null, `not applicable for run_kind ${runKind}`),
    // repetition_index (decision 11, v2-only, plain nullable like scenario_id -- not a
    // {value,reason} metric): which trial within the matrix this record belongs to.
    repetition_index: isScenario ? repetitionIndex : null,
    // foreign_skill_summary (schema v3): categorized counts of any Skill tool_use targeting
    // something other than the expected skill, computed once above and shared with
    // tool_calls_total. Always present for every run_kind -- an empty classification correctly
    // yields all-zero counts, so this is a required field, never a nullable metric. Exists so a
    // rejected-but-harmless foreign-skill attempt on an otherwise-clean, ACCEPTED record still
    // leaves a real trace of having happened, instead of disappearing entirely the moment
    // scenarioCellIntegrityOk's result-aware skillSelectionOk stops treating it as contamination.
    foreign_skill_summary: foreignSkillSummary,
    // ambient_skill_profile (schema v4): count + opaque scope_id + keyed HMAC fingerprint only,
    // computed once above and shared with nothing else -- see its own computation comment above
    // for why raw names never reach this record, and why the fingerprint is HMAC-keyed rather
    // than a plain hash.
    ambient_skill_profile: ambientSkillProfile,
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
      // Per-attempt JUnit-evidence attribution (tools/agentic-eval "bind junit evidence to
      // authoritative attempts" fix): JUnit XML is now captured per-attempt, keyed by tool_use_id,
      // never a single pooled per-condition snapshot. ambiguous_junit_evidence now means a
      // TRANSCRIPT-PROVEN same-assistant-turn conflict -- two relevant, policy-allowed producers
      // (a Gradle invocation and/or a kmp-test parallel call) dispatched in the same batch
      // (bashResults[i].index shared), so neither one's evidence can be trusted (they may have
      // raced on the same on-disk files). A genuine HARNESS-INTEGRITY defect, not a legitimate
      // agent outcome -- surfaced here so scenarioCellIntegrityOk can block the WHOLE matrix's
      // promotion, matching decision 4's existing treatment of every other integrity defect.
      ...(isScenario && gradeResult?.harnessEvidenceAmbiguous
        ? [{ code: 'ambiguous_junit_evidence', message: 'two or more policy-allowed producers (a Gradle invocation and/or a kmp-test parallel call) were dispatched in the same assistant turn in this condition -- their JUnit evidence cannot be reliably attributed to either specific attempt' }]
        : []),
      // A systematic-closure review found the identical HARNESS-INTEGRITY treatment applies here:
      // a genuinely incoherent parallel.legs[] structure on the terminal attempt (malformed leg
      // shape, wrong test-type correlation, or a leg/top-level failure-count contradiction --
      // see graders.mjs's validateParallelEvidence/parallelEvidenceInvalid) means the tool's own
      // JSON output cannot be trusted as genuine evidence of what happened -- not a legitimate
      // agent outcome, so it must block promotion here rather than merely reading as
      // expected_outcome_matched:false, a valid negative result the ambiguity is NOT.
      ...(isScenario && gradeResult?.parallelEvidenceMalformed
        ? [{ code: 'malformed_parallel_evidence', message: 'the terminal kmp-test parallel attempt\'s own parallel.legs[] structure is internally incoherent (malformed leg shape, wrong test-type correlation, or a leg/top-level failure-count contradiction) -- the tool\'s own JSON output cannot be trusted as genuine evidence of what happened' }]
        : []),
      // The identical HARNESS-INTEGRITY treatment for a per-attempt JUnit-XML evidence-completeness
      // problem: junit-evidence.mjs's countEvidenceTaskJunit found a genuine skip this evidence
      // path cannot correctly count, an oversized/unreadable file, or the capture bounds were
      // exceeded, on some relevant Gradle attempt in this condition -- never a legitimate agent
      // outcome, so it must block promotion here too. Distinct from -- and never merged with --
      // junit_evidence_capture_incomplete below.
      ...(isScenario && gradeResult?.gradleJunitEvidenceUnreliable
        ? [{ code: 'unreliable_gradle_junit_evidence', message: 'the JUnit XML captured for a relevant Gradle attempt in this condition contains a genuine skipped testcase (this evidence path cannot correctly account for it), a file that could not be fully read or was oversized, or exceeded the capture bounds -- the counts derived from it cannot be trusted as genuine evidence of what happened' }]
        : []),
      // NEW (this fix): a capture-MECHANISM failure, distinct from ambiguity (a proven conflict) and
      // from unreliable evidence (real XML that isn't trustworthy) -- some relevant attempt (Gradle
      // OR kmp-test parallel, in either provider) has no decision record at all, a decision record
      // that exists but is incoherent, a command cross-check mismatch, a duplicate-write anomaly, or
      // (for an allowed Gradle attempt specifically) no evidence record at all. Computed by scanning
      // EVERY relevant attempt in the condition, not only whichever one later becomes terminal --
      // a missing/broken capture mechanism on an earlier attempt can silently corrupt
      // test_invocations_total/retries/first_useful_signal_ms even when the terminal attempt's own
      // data looks fine. The one tolerance: the single last relevant attempt, when this condition
      // was terminated by a genuine timeout, may have a record that is entirely absent (never a
      // tombstone, an incoherent value, a command mismatch, or an integrity_error status, all of
      // which block unconditionally regardless of timeout).
      ...(isScenario && gradeResult?.gradleJunitEvidenceCaptureIncomplete
        ? [{ code: 'junit_evidence_capture_incomplete', message: 'the JUnit-evidence-attribution mechanism itself failed for at least one relevant attempt in this condition (a missing or incoherent decision/evidence record, a command cross-check mismatch, or a duplicate-write anomaly) -- this is a harness capture-mechanism failure, never a legitimate agent outcome' }]
        : []),
    ],
  };
}

// resolveEvidenceOutDir/isRawDirSafeFromAccidentalCommit/promoteTargetsAtomically now live in
// evidence-io.mjs (imported above) -- extracted so rejection-diagnostics.mjs's new writer can
// reuse the identical atomic-promotion mechanism without a circular import. Zero behavior change.

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
 * never leave files 1-2 committed as final evidence while 3-4 are missing. See evidence-io.mjs's
 * promoteTargetsAtomically for the exact contract this guarantee actually provides.
 */
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
  promoteTargetsAtomically(targets, rawDir);
  return outDir;
}

/**
 * The N-record sibling of writeRunRecordEvidence (decision 3's atomic-promotion extraction): one
 * `.json` summary + one raw `.jsonl` transcript per record, still promoted as ONE all-or-nothing
 * atomic group via the exact same promoteTargetsAtomically body -- a partial failure rolls back
 * every target THIS invocation created, never leaving N-1 records committed and one missing.
 * @param {string} runKind
 * @param {object[]} records - already schema-validated, redacted-text-paired records
 * @param {object[]} conditionResults - parallel array, each record[i]'s own conditionResult
 *   (for conditionResults[i].spawnResult.rawStdout)
 * @param {string[]} redactedTexts - parallel array, each record[i]'s own redacted JSON text
 * @param {string} [runsRootOverride]
 * @param {string[]|null} [sidecarTexts] - accepted-run-observability PR: parallel array, each
 *   record[i]'s own already-redacted accepted-run-audit sidecar JSON text (written to
 *   `audit/<run_id>.json`, alongside the summary + raw tiers, as one all-or-nothing batch). `null`
 *   (the default) writes NO audit/ directory or sidecar files at all -- calibrate/smoke's own
 *   pair-based writeRunRecordEvidence sibling never gains this parameter at all, since sidecars are
 *   a scenario-only concept and that pair-based path is deliberately left unchanged.
 */
function writeRunMatrixRecordEvidence(runKind, records, conditionResults, redactedTexts, runsRootOverride = RUNS_ROOT, sidecarTexts = null) {
  const outDir = resolveEvidenceOutDir(runKind, runsRootOverride);
  const rawDir = join(outDir, 'raw');
  const auditDir = join(outDir, 'audit');
  if (!isRawDirSafeFromAccidentalCommit(rawDir, runsRootOverride)) {
    throw new Error(`refusing to write raw transcripts: ${rawDir} is inside this repo's worktree but not covered by .gitignore -- would risk an accidental commit of unredacted data`);
  }
  const targets = records.flatMap((record, i) => [
    [join(outDir, `${record.run_id}.json`), redactedTexts[i]],
    [join(rawDir, `${record.run_id}.jsonl`), conditionResults[i].spawnResult.rawStdout],
    ...(sidecarTexts ? [[join(auditDir, `${record.run_id}.json`), sidecarTexts[i]]] : []),
  ]);
  promoteTargetsAtomically(targets, sidecarTexts ? [rawDir, auditDir] : rawDir);
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
 * already on disk). Any failure returns {ok:false, reason} and writes no run evidence -- the one
 * exception is the hard-gate-failure branch specifically, which additionally writes a separate,
 * privacy-safe rejection diagnostic (see rejection-diagnostics.mjs); every OTHER failure reason
 * (schema-invalid, dirty tree, stale policy, privacy-check-throw) writes literally nothing.
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
    // Privacy-safe rejected-run diagnostics (closes BACKLOG.md's "leave no auditable trace" gap)
    // -- a diagnostics-write failure must never mask the ORIGINAL rejection reason or crash the
    // caller; caught and surfaced as a separate field instead. rejectionId/diagnosticsRelativePath
    // stay null unless the write actually succeeded -- round-6 audit finding ("localización del
    // diagnóstico"): a caller must be able to tell a human WHERE a successfully-written diagnostic
    // landed, not just that no error was thrown.
    let diagnosticsWriteError = null;
    let rejectionId = null;
    let diagnosticsRelativePath = null;
    try {
      const failedChecksByRunId = { [recordA.run_id]: gate.failedChecksA ?? [], [recordB.run_id]: gate.failedChecksB ?? [] };
      const foreignSkillNamesByRunId = {
        [recordA.run_id]: classifyForeignSkillUses(runA.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).map((u) => u.skillArg).filter((s) => s != null),
        [recordB.run_id]: classifyForeignSkillUses(runB.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).map((u) => u.skillArg).filter((s) => s != null),
      };
      const diagnostics = buildRejectionDiagnostics({ runKind, records: [recordA, recordB], failedChecksByRunId, foreignSkillNamesByRunId });
      ({ rejectionId, relativePath: diagnosticsRelativePath } = writeRejectedRunDiagnostics(diagnostics, { privatePatternsFile, runsRootOverride }));
    } catch (err) {
      diagnosticsWriteError = err.message;
    }
    return { ok: false, reason: gate.reason, diagnosticsWriteError, rejectionId, diagnosticsRelativePath };
  }
  // The evidence directory path itself can carry the real OS username (this repo may be checked
  // out under e.g. C:\Users\<name>\...). Verified BEFORE anything is written: an earlier version
  // wrote all four files first and only checked outDir's own redaction-safety afterward, so a
  // private-patterns rule matching only the (possibly KMP_EVAL_RUNS_ROOT-overridden) runs-root
  // path itself -- never the record content, which was already verified clean above -- could
  // report {ok:false} after real evidence and raw transcripts were already committed to disk,
  // contradicting this function's own "any failure returns {ok:false} and writes no run evidence"
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
 * decision 11: matrix completeness is a set-equality PROOF, not a count. `records.length ===
 * expectedCellCount` alone can't catch a duplicated repetition silently substituting for a
 * missing one (same total count, wrong composition). Verifies: the set of
 * `(repetition_index, condition)` pairs across all records exactly equals
 * `{0..repeats-1} x {'current-skill','no-skill'}` -- no duplicates, no gaps; and `order_index`
 * values are unique and form exactly the contiguous range `0..N-1`. Returns a reason string
 * (falsy if complete).
 */
function findMatrixCompletenessGap(records, repeats) {
  const expectedCellCount = repeats * 2;
  if (records.length !== expectedCellCount) {
    return `expected ${expectedCellCount} records (repeats=${repeats} x 2 conditions), got ${records.length}`;
  }
  const seenPairs = new Set();
  for (const r of records) {
    const key = `${r.repetition_index}:${r.condition}`;
    if (seenPairs.has(key)) return `duplicate (repetition_index, condition) pair: ${key}`;
    seenPairs.add(key);
  }
  for (let rep = 0; rep < repeats; rep++) {
    for (const condition of ['current-skill', 'no-skill']) {
      if (!seenPairs.has(`${rep}:${condition}`)) return `missing (repetition_index, condition) pair: ${rep}:${condition}`;
    }
  }
  const orderIndices = records.map((r) => r.order_index).sort((a, b) => a - b);
  for (let i = 0; i < orderIndices.length; i++) {
    if (orderIndices[i] !== i) return `order_index values are not a contiguous 0..${expectedCellCount - 1} range (got ${JSON.stringify(orderIndices)})`;
  }
  return null;
}

/**
 * decision 15's realized-order-balance check: counts, among the records actually written, how
 * many repetitions started `current-skill` first vs `no-skill` first -- purely mechanical, derived
 * from each record's own `order_index`/`condition`, never from repeats/seed directly (a bug in
 * buildConditionOrders would then be self-certifying; reading it back off the REAL records instead
 * verifies what was actually realized, not merely what was requested).
 */
function realizedStartCounts(records) {
  const byRepetition = new Map();
  for (const r of records) {
    if (!byRepetition.has(r.repetition_index)) byRepetition.set(r.repetition_index, []);
    byRepetition.get(r.repetition_index).push(r);
  }
  let currentSkillFirstCount = 0;
  let noSkillFirstCount = 0;
  for (const reps of byRepetition.values()) {
    const first = [...reps].sort((a, b) => a.order_index - b.order_index)[0];
    if (first.condition === 'current-skill') currentSkillFirstCount++;
    else noSkillFirstCount++;
  }
  return { currentSkillFirstCount, noSkillFirstCount };
}

/**
 * `benchmark_eligible` (decisions 4/15 of the design): depends ONLY on protocol/integrity
 * completeness, NEVER on the scenario OUTCOME -- a wrong answer, a policy denial, or a legitimate
 * timeout are valid negative results and must never be filtered out (that would be survivorship
 * bias baked directly into the evidence). Requires: the whole-matrix hard gate passed; every
 * record's grading actually EXECUTED (`grading_checks.value` non-null -- distinguishes "graded and
 * failed" from "grading never ran") with real, strictly boolean `success`/`expected_outcome_matched`
 * values (never null); and the realized starting-condition counts are exactly equal (decision 15 --
 * an odd `--repeats`, or any other imbalance, can never satisfy this by construction; an honest
 * mechanical consequence, not a special case to code around).
 */
function scenarioMatrixIsBenchmarkEligible(records, gate) {
  if (!gate.ok) return false;
  for (const r of records) {
    if (r.grading_checks.value == null) return false;
    if (typeof r.success.value !== 'boolean') return false;
    if (typeof r.expected_outcome_matched.value !== 'boolean') return false;
  }
  const { currentSkillFirstCount, noSkillFirstCount } = realizedStartCounts(records);
  return currentSkillFirstCount === noSkillFirstCount;
}

/**
 * The N-record sibling of finalizeAndWriteRecords, for a whole scenario matrix. Same philosophy,
 * generalized from a hardcoded pair to `records.entries()`, PLUS decision 11's completeness proof
 * ahead of everything else (an incomplete matrix must never even reach the gate, let alone get
 * promoted). `hardGateFn` here is `scenarioHardGate`, which takes the whole
 * `(records, conditionResults)` arrays, not a fixed A/B pair -- harness-integrity failure on ANY
 * one cell blocks the WHOLE batch (decision 4's "one bad cell blocks the whole matrix" design),
 * never a partial promotion.
 *
 * The gate is computed EARLY -- right after the completeness/dirty-tree/policy-hash checks, before
 * schema validation, before any accepted-audit-sidecar work -- and a rejection returns immediately
 * (diagnostics written, gate.reason preserved). This ordering exists specifically because
 * `accepted_audit` is a required non-null schema-v5 scenario field that can only be legitimately
 * populated for an ACCEPTED run (a sidecar audits acceptance -- see accepted-run-audit.mjs), so
 * schema validation of that field can't run before the gate decision either. A review finding
 * demonstrated the previous ordering (schema validate -> ... -> gate compute -> sidecar
 * cross-validate -> `if (!gate.ok)`) let a sidecar build/finalization/cross-validation problem
 * return its OWN reason and skip writeRejectedRunDiagnostics entirely, silently swallowing a
 * genuine hard-gate rejection. `buildSidecarsFn`, when supplied, is invoked ONLY once gate.ok is
 * confirmed true -- accepted-audit work belongs strictly on the gate-passing promotion path.
 */
async function finalizeAndWriteMatrixRecords({ runKind, records, conditionResults, hardGateFn, privatePatternsFile, runsRootOverride = RUNS_ROOT, repeats, buildSidecarsFn = null }) {
  const completenessGap = findMatrixCompletenessGap(records, repeats);
  if (completenessGap) {
    return { ok: false, reason: `Matrix is incomplete, refusing to consider it for promotion: ${completenessGap}` };
  }
  for (const [i, record] of records.entries()) {
    const dirty = record.errors.find((e) => e.code === 'dirty_measured_code');
    if (dirty) {
      return { ok: false, reason: `Run record [${i}] was captured with an unclean measured-code tree -- refusing to write evidence that would misrepresent repo_commit: ${dirty.message}` };
    }
  }
  const runsRootIsDefault = isRunsRootDefault(runsRootOverride, REPO_ROOT);
  for (const [i, record] of records.entries()) {
    const dirty = findBlockingHarnessToolingDirty(record, runsRootIsDefault);
    if (dirty) {
      return { ok: false, reason: `Run record [${i}] was captured with an unclean harness-tooling tree while writing to the default, committable evidence location -- refusing to write evidence that would misrepresent repo_commit: ${dirty.message}` };
    }
  }
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const freshHash = computePolicySha256({ fresh: true });
  for (const [i, record] of records.entries()) {
    if (record.policy_sha256 !== freshHash) {
      return { ok: false, reason: `Run record [${i}] policy_sha256 (${record.policy_sha256}) does not match the current policy-hook.mjs (${freshHash}) -- evidence is stale relative to the code that produced it` };
    }
  }

  // Gate decision -- BEFORE schema validation and BEFORE any accepted-audit-sidecar work (see this
  // function's own doc comment for why). A rejection returns here, unconditionally: nothing below
  // this point (schema validation, sidecar build/cross-validation) can ever suppress gate.reason
  // or prevent writeRejectedRunDiagnostics from running.
  const gate = hardGateFn(records, conditionResults);
  if (!gate.ok) {
    // Privacy-safe rejected-run diagnostics (closes BACKLOG.md's "leave no auditable trace" gap)
    // -- gate.cellResults (scenarioHardGate's own new field) already correlates every cell to its
    // own failedChecks, so this is pure reshaping, never a second gate re-run. A diagnostics-write
    // failure must never mask the ORIGINAL rejection reason or crash the caller.
    // rejectionId/diagnosticsRelativePath stay null unless the write actually succeeded -- see the
    // pair-based finalizeAndWriteRecords' identical rationale.
    let diagnosticsWriteError = null;
    let rejectionId = null;
    let diagnosticsRelativePath = null;
    try {
      const failedChecksByRunId = Object.fromEntries((gate.cellResults ?? []).map((c) => [c.runId, c.failedChecks]));
      const foreignSkillNamesByRunId = Object.fromEntries(
        records.map((r, i) => [r.run_id, classifyForeignSkillUses(conditionResults[i].events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).map((u) => u.skillArg).filter((s) => s != null)]),
      );
      // ambientProfileMatrixOk (correction 6): scenarioHardGate's own matrix-wide consensus result
      // (gate.ambientProfileMatrixOk, exposed on its return value) -- threaded straight through, so
      // a rejection diagnostic for a scenario batch always records whether the ambient-profile
      // consensus itself held, distinct from any individual cell's own failed_checks.
      const diagnostics = buildRejectionDiagnostics({ runKind, records, failedChecksByRunId, foreignSkillNamesByRunId, ambientProfileMatrixOk: gate.ambientProfileMatrixOk });
      ({ rejectionId, relativePath: diagnosticsRelativePath } = writeRejectedRunDiagnostics(diagnostics, { privatePatternsFile, runsRootOverride }));
    } catch (err) {
      diagnosticsWriteError = err.message;
    }
    return { ok: false, reason: gate.reason, diagnosticsWriteError, rejectionId, diagnosticsRelativePath };
  }

  const eligible = scenarioMatrixIsBenchmarkEligible(records, gate);
  for (const record of records) record.benchmark_eligible = eligible;

  // Accepted-audit sidecar work -- ONLY reached once gate.ok is confirmed true. buildSidecarsFn
  // builds+finalizes+attaches record.accepted_audit for every record (cmdRun supplies the
  // closure); a failure here means promotion cannot proceed (the sidecar contract can't be
  // satisfied), but it is never confused with a gate rejection -- writeRejectedRunDiagnostics is
  // never called for this failure class, matching how a privacy-check-refusal failure below is
  // also never treated as a rejection.
  let sidecarTexts = null;
  if (buildSidecarsFn != null) {
    const sidecarBuild = await buildSidecarsFn(records, conditionResults);
    if (!sidecarBuild.ok) {
      return { ok: false, reason: `Cannot promote: ${sidecarBuild.reason}` };
    }
    sidecarTexts = sidecarBuild.sidecarTexts;
  }

  for (const [i, record] of records.entries()) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      return { ok: false, reason: `Run record [${i}] (repetition ${record.repetition_index}, ${record.condition}) failed schema validation: ${JSON.stringify(errors)}` };
    }
  }

  const redactedRecords = [];
  const redactedTexts = [];
  try {
    for (const record of records) {
      const { redactedObj, redactedText } = assertCleanOrThrowObject(record, { privatePatternsFile });
      redactedRecords.push(redactedObj);
      redactedTexts.push(redactedText);
    }
  } catch (err) {
    return { ok: false, reason: `Privacy check refused to clear evidence for writing: ${err.message}` };
  }
  for (const [i, record] of redactedRecords.entries()) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      return { ok: false, reason: `Redacted run record [${i}] failed schema validation (redaction corrupted a field) -- refusing to write: ${JSON.stringify(errors)}` };
    }
  }
  // accepted_audit binding + cross-validation (accepted-run-observability PR, privacy/binding
  // steps 7-8): sidecarTexts[i] is the ALREADY build->redact->hash'd sidecar text buildSidecarsFn
  // produced above. Here, AFTER the record's own redact+revalidate cycle, re-hash the exact
  // sidecar text one more time and cross-validate the FINAL redacted record against it -- catches
  // a redaction pass that somehow touched accepted_audit's own sha256/relative_path (never
  // expected in practice, since neither is a private-pattern-shaped value, but this is the one
  // point in the pipeline that can still prove the binding survived intact before anything is
  // written). This can only ever run on the confirmed gate-passing path now, so a mismatch here
  // is unambiguously a "cannot promote" failure, never confusable with (or reported instead of) a
  // gate rejection.
  if (sidecarTexts != null) {
    for (const [i, record] of redactedRecords.entries()) {
      const actualSha256 = createHash('sha256').update(sidecarTexts[i], 'utf8').digest('hex');
      if (record.accepted_audit?.sha256 !== actualSha256) {
        return { ok: false, reason: `Record [${i}] (${record.run_id}) accepted_audit.sha256 no longer matches its own sidecar's redacted content -- refusing to write a broken digest binding` };
      }
      if (record.accepted_audit?.relative_path !== acceptedAuditRelativePathFor(record.run_id)) {
        return { ok: false, reason: `Record [${i}] (${record.run_id}) accepted_audit.relative_path no longer matches the deterministic audit/<run_id>.json convention` };
      }
      let sidecarObj;
      try {
        sidecarObj = JSON.parse(sidecarTexts[i]);
      } catch (err) {
        return { ok: false, reason: `Record [${i}] (${record.run_id})'s own sidecar text is not valid JSON: ${err.message}` };
      }
      const crossErrors = crossValidateAcceptedRunAuditAgainstRecord(sidecarObj, record);
      if (crossErrors.length > 0) {
        return { ok: false, reason: `Record [${i}] (${record.run_id}) sidecar/record cross-validation failed: ${JSON.stringify(crossErrors)}` };
      }
    }
  }
  const outDir = resolveEvidenceOutDir(runKind, runsRootOverride);
  let redactedOutDir;
  try {
    redactedOutDir = assertCleanOrThrow(outDir, { privatePatternsFile });
  } catch (err) {
    return { ok: false, reason: `Privacy check refused to report the evidence directory path: ${err.message}` };
  }
  try {
    writeRunMatrixRecordEvidence(runKind, records, conditionResults, redactedTexts, runsRootOverride, sidecarTexts);
  } catch (err) {
    return { ok: false, reason: `Evidence write refused: ${err.message}` };
  }
  return { ok: true, reason: null, outDir, redactedOutDir, redactedRecords };
}

/**
 * Derives {ok, reason, failedChecks} from ONE shared ordered list of named [name, boolean] checks
 * -- the single source of truth for all four hard-gate functions below. Exists specifically to
 * close a two-sources-of-truth risk: manually building a `failedChecks` array alongside a
 * hand-written `reason` template string (as an earlier draft of this change did) can drift out of
 * sync exactly the way this file's own history already shows named checks and their free-text
 * reason strings drifting apart across several independent review rounds. `reason` preserves the
 * exact `name:value` substring shape every existing test already matches against.
 */
function evaluateNamedChecks(checks) {
  const failedChecks = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return {
    ok: failedChecks.length === 0,
    reason: failedChecks.length === 0 ? null : checks.map(([name, passed]) => `${name}:${passed}`).join(' '),
    failedChecks,
  };
}

// Always the full `name:value` list for every check, regardless of pass/fail -- used by
// calibrationHardGate/smokeHardGate's two-sided (A/B) reason string, which must show BOTH sides'
// complete check breakdown whenever the gate fails overall, not just the side(s) that actually
// failed (matching this gate's pre-existing, already-tested verbose format -- evaluateNamedChecks'
// own `reason` is null on a passing side, which is the right behavior for its `ok`/`failedChecks`
// consumers but the wrong one for this always-verbose rendering).
function joinChecks(checks) {
  return checks.map(([name, passed]) => `${name}:${passed}`).join(' ');
}

/**
 * Calibration's hard gate, extracted as a named, independently-testable function (not an inline
 * closure) specifically so each sub-check can be unit-tested in isolation with precise synthetic
 * inputs -- constructing a real subprocess fixture that fails EXACTLY one of these and none of
 * the others is fragile (e.g. it's not actually verified anywhere what a denied command's own
 * tool_result looks like on a real transcript, so fabricating one for a fixture risks encoding a
 * guess as if it were confirmed fact). Every sub-check is reported by name in the failure reason
 * (not just an aggregate boolean).
 *
 * Computed per-side (A/B) via evaluateNamedChecks and combined as `evalA.ok && evalB.ok` --
 * mathematically identical to a single flat AND of all 15 checks (boolean AND is associative;
 * every original sub-expression appears in exactly one side's list, never duplicated or dropped),
 * so this restructure changes zero pass/fail behavior. It exists to expose which SIDE (not just
 * which check) failed, for rejected-run diagnostics (rejection-diagnostics.mjs) to attribute
 * correctly without re-deriving anything. A few checks (noSkillSafetyOk, currentInvocationOk,
 * pluginSnapshotBindingOk) are inherently single-sided already and appear in only one list.
 */
function calibrationHardGate(a, b, runAResult, runBResult) {
  const availabilityOkA = a.skill_available.value === false;
  const availabilityOkB = b.skill_available.value === true;
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
  // Regression coverage for a real bypass an independent review pass demonstrated: relaxing the
  // no-skill arm to tolerate attempted:false made a NEW gap reachable -- noUnexpectedToolsOk only
  // checks the tool NAME (Bash/Skill), never a Skill call's own `input.skill` argument, so a
  // transcript that called Skill with some OTHER skill name entirely would show
  // attempted:false/invoked:false for kmp-test-runner (that call is invisible to
  // findSkillInvocation, which is scoped to kmp-test-runner only) and pass unnoticed. Requires
  // BOTH conditions to contain zero Skill calls targeting anything other than kmp-test-runner.
  // Deliberately still the plain, argument-only findForeignSkillUses (not the result-aware
  // classifyForeignSkillUses used by scenarioCellIntegrityOk below) -- calibration's contract is
  // untouched by this change; ANY foreign Skill call, rejected or not, still fails this check.
  const skillSelectionOkA = findForeignSkillUses(runAResult.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).length === 0;
  const skillSelectionOkB = findForeignSkillUses(runBResult.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).length === 0;
  // Regression coverage for a real gap an independent review pass demonstrated: neither
  // isSkillAvailable nor hasExpectedToolProfile ever inspects the init event's OWN plugins[]
  // array -- an unexpected third-party plugin loaded alongside (or instead of) the intended one
  // went completely undetected. A must load exactly zero plugins; B must load exactly one,
  // named kmp-test-runner -- no duplicates, no extras.
  const pluginProfileOkA = hasExpectedPluginProfile(runAResult.init, TARGET_PLUGIN_NAME, false);
  const pluginProfileOkB = hasExpectedPluginProfile(runBResult.init, TARGET_PLUGIN_NAME, true);
  // Regression coverage for a real evidence-contamination bypass an independent review pass
  // demonstrated: pluginProfileOk only checks the loaded plugin's NAME, never its path -- a
  // same-named "kmp-test-runner" plugin loaded from a completely unrelated directory satisfied
  // it outright, while the record still published skill_source_sha as the pinned SHA regardless.
  // See isPluginBoundToSnapshot's own doc comment for the full rationale. Only meaningful for B
  // (the no-skill arm never loads a plugin at all, per pluginProfileOk above).
  const pluginSnapshotBindingOk = isPluginBoundToSnapshot(runBResult.init, runBResult.snapshotDir);
  // Regression coverage for a real gap an independent review pass demonstrated: findInitEvent/
  // findResultEvent/findIncompleteToolResults all either take "the first" event of a kind or only
  // check "at least one" correlation exists -- neither catches a transcript with a SECOND,
  // contradictory init+result pair appended after a legitimate first one, or two tool_use blocks
  // sharing one id satisfied by a single tool_result. See findTranscriptStructuralIssues's own
  // doc comment for the full rationale.
  const transcriptStructureOkA = findTranscriptStructuralIssues(runAResult.events).length === 0;
  const transcriptStructureOkB = findTranscriptStructuralIssues(runBResult.events).length === 0;
  // A session that never emitted an init event at all is a fundamentally broken/incomplete
  // capture, not a legitimately-observed "skill unavailable" -- without this check, a run with
  // NO init event could still show skill_available:false for the no-skill arm (nothing to derive
  // it from) and happen to match the EXPECTED value there by coincidence, passing availabilityOk
  // for the wrong reason entirely.
  const initOkA = runAResult.init != null;
  const initOkB = runBResult.init != null;
  // The init event's OWN declared profile must match exactly what this harness actually
  // launches with -- proves a genuinely narrow session, not just that ONE happened to arrive.
  const toolProfileOkA = hasExpectedToolProfile(runAResult.init, EXPECTED_TOOL_NAMES);
  const toolProfileOkB = hasExpectedToolProfile(runBResult.init, EXPECTED_TOOL_NAMES);
  // No tool_use ANYWHERE in the transcript may name anything outside Bash/Skill -- a
  // transcript could otherwise use some other tool (e.g. Read) alongside the expected calls and
  // still pass every other check.
  const noUnexpectedToolsOkA = findUnexpectedToolUses(runAResult.events, EXPECTED_TOOL_NAMES).length === 0;
  const noUnexpectedToolsOkB = findUnexpectedToolUses(runBResult.events, EXPECTED_TOOL_NAMES).length === 0;
  const processOkA = a.terminated === false && a.exit_code === 0;
  const processOkB = b.terminated === false && b.exit_code === 0;
  // subtype==='success' (not just is_error===false) -- a session cut off by e.g. the budget cap
  // reports a distinct result.subtype (confirmed: 'error_max_budget_usd') that is NOT
  // necessarily paired with is_error:true, so is_error alone doesn't prove the session ran to a
  // genuine, uninterrupted completion.
  const resultOkA = runAResult.result?.subtype === 'success' && runAResult.result?.is_error === false;
  const resultOkB = runBResult.result?.subtype === 'success' && runBResult.result?.is_error === false;
  const hookAccountingOkA = runAResult.hookStats.everyCallHooked === true;
  const hookAccountingOkB = runBResult.hookStats.everyCallHooked === true;
  // Regression coverage for a real gap an independent review pass demonstrated: findSkillInvocation
  // correctly reports confirmed:false for a Skill attempt with NO correlated tool_result at all
  // (transcript cut short before a result arrived), but the gate previously treated
  // attempted:true/invoked:false uniformly as a "clean" no-skill shape -- a dangling attempt is an
  // INCOMPLETE capture, not a demonstrated Unknown-skill rejection, and must not be silently
  // accepted as equivalent. Scans every tool_use (Bash included -- calibration has no per-command
  // result check of its own, unlike smoke's exactCommandsOk).
  const toolResultsCompleteOkA = findIncompleteToolResults(runAResult.events).length === 0;
  const toolResultsCompleteOkB = findIncompleteToolResults(runBResult.events).length === 0;
  // Only smokeHardGate had this check until now -- a malformed/truncated JSONL line could hide
  // exactly a Skill tool_use or its result, artificially producing attempted:false for A, which
  // the relaxed no-skill contract now legitimately tolerates. Calibration needs the same
  // protection smoke already has.
  const cleanTranscriptOkA = runAResult.malformedLines.length === 0;
  const cleanTranscriptOkB = runBResult.malformedLines.length === 0;
  // Review-round-2 fix (correction 4): a missing/malformed init.skills[] previously let
  // buildRunRecord silently report a "valid" {count:0, ...} ambient_skill_profile even though the
  // underlying data was genuinely unknown, not a real, verified empty ambient set -- calibration/
  // smoke never checked this at all (only scenarioCellIntegrityOk did). Same condition-aware
  // target-identity handling as scenario's own gate (correction 1): A must show ZERO target
  // references in skills[] (never merely zero confirmed invocations), B may show exactly one.
  // Calibration/smoke's OWN skillSelectionOk (zero-tolerance for any foreign call, confirmed or
  // not) is deliberately left completely untouched -- this only ADDS the two new checks below, it
  // never relaxes the existing ones.
  const ambientProfileA = computeAmbientSkillProfile(runAResult.init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: false });
  const ambientProfileB = computeAmbientSkillProfile(runBResult.init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: true });
  const ambientSkillProfileOkA = ambientProfileA.structurallyWellFormed;
  const ambientSkillProfileOkB = ambientProfileB.structurallyWellFormed;
  const targetSkillAmbientIdentityOkA = ambientProfileA.targetIdentityOk;
  const targetSkillAmbientIdentityOkB = ambientProfileB.targetIdentityOk;

  const checksA = [
    ['availabilityOk', availabilityOkA], ['noSkillSafetyOk', noSkillSafetyOk],
    ['skillSelectionOk', skillSelectionOkA], ['pluginProfileOk', pluginProfileOkA],
    ['initOk', initOkA], ['toolProfileOk', toolProfileOkA],
    ['noUnexpectedToolsOk', noUnexpectedToolsOkA], ['processOk', processOkA],
    ['resultOk', resultOkA], ['hookAccountingOk', hookAccountingOkA],
    ['toolResultsCompleteOk', toolResultsCompleteOkA], ['cleanTranscriptOk', cleanTranscriptOkA],
    ['transcriptStructureOk', transcriptStructureOkA],
    ['ambientSkillProfileOk', ambientSkillProfileOkA], ['targetSkillAmbientIdentityOk', targetSkillAmbientIdentityOkA],
  ];
  const checksB = [
    ['availabilityOk', availabilityOkB], ['currentInvocationOk', currentInvocationOk],
    ['skillSelectionOk', skillSelectionOkB], ['pluginProfileOk', pluginProfileOkB],
    ['pluginSnapshotBindingOk', pluginSnapshotBindingOk], ['initOk', initOkB],
    ['toolProfileOk', toolProfileOkB], ['noUnexpectedToolsOk', noUnexpectedToolsOkB],
    ['processOk', processOkB], ['resultOk', resultOkB], ['hookAccountingOk', hookAccountingOkB],
    ['toolResultsCompleteOk', toolResultsCompleteOkB], ['cleanTranscriptOk', cleanTranscriptOkB],
    ['transcriptStructureOk', transcriptStructureOkB],
    ['ambientSkillProfileOk', ambientSkillProfileOkB], ['targetSkillAmbientIdentityOk', targetSkillAmbientIdentityOkB],
  ];
  const evalA = evaluateNamedChecks(checksA);
  const evalB = evaluateNamedChecks(checksB);
  const ok = evalA.ok && evalB.ok;
  return {
    ok,
    reason: ok ? null : `calibration hard gate failed -- A:{${joinChecks(checksA)}} B:{${joinChecks(checksB)}} (A:{available:${a.skill_available.value},attempted:${a.skill_invocation_attempted.value},invoked:${a.skill_invoked.value},terminated:${a.terminated},exit_code:${a.exit_code},result_subtype:${runAResult.result?.subtype},result_is_error:${runAResult.result?.is_error},everyCallHooked:${runAResult.hookStats.everyCallHooked},tools:${JSON.stringify(runAResult.init?.tools)}} B:{available:${b.skill_available.value},attempted:${b.skill_invocation_attempted.value},invoked:${b.skill_invoked.value},terminated:${b.terminated},exit_code:${b.exit_code},result_subtype:${runBResult.result?.subtype},result_is_error:${runBResult.result?.is_error},everyCallHooked:${runBResult.hookStats.everyCallHooked},tools:${JSON.stringify(runBResult.init?.tools)}})`,
    failedChecksA: evalA.failedChecks,
    failedChecksB: evalB.failedChecks,
  };
}

/**
 * Per-cell harness-integrity check for a single scenario matrix cell -- deliberately built ONLY
 * from harness-integrity sub-checks already proven reusable, never from the scenario OUTCOME
 * (that's graders.mjs's job, reported separately on success/expected_outcome_matched, and must
 * never gate promotion -- decision 4). Adopts calibration's noSkillSafetyOk (a confirmed no-skill
 * invocation is real evidence-contamination regardless of prompt shape -- see the check's own
 * comment) but explicitly omits calibration's currentInvocationOk (proves skill-invocation
 * MECHANICS under calibration's own explicit "use the skill" prompt -- for a natural scenario
 * prompt, whether the agent invokes the skill at all is part of what's being MEASURED, not a
 * harness precondition) and smoke's processOk/
 * resultOk/exactCommandsOk/realWorkOk (those encode "proved equivalent diagnostic work," which
 * doesn't transfer to a scenario where a wrong answer, or a correct answer via a different valid
 * tool sequence, is legitimate data, not a harness defect). hookAccountingOk checks MECHANISM
 * integrity only (`everyCallHooked` -- every Bash call actually reached the policy hook), never
 * `hook_deny_count === 0` -- a denial is the policy hook working as intended and is itself valid
 * data, never a disqualifier. Uses the timeout-tolerant structural checks (decision 7) so a
 * legitimate timeout is never conflated with genuine corruption. `terminationOk` blocks only an
 * `'error'` termination (an external kill/spawn failure -- a harness-trustworthiness signal); a
 * clean run or a declared `'timeout'` both pass. `junitEvidenceOk` is a review-fix addition: an
 * `ambiguous_junit_evidence` error on the record (buildRunRecord, from graders.mjs's own
 * `harnessEvidenceAmbiguous`) means a TRANSCRIPT-PROVEN same-assistant-turn conflict -- two or more
 * policy-allowed producers (a Gradle invocation and/or a kmp-test `parallel` call) were dispatched
 * in the same turn, so their JUnit evidence cannot be reliably attributed to either specific
 * attempt -- a genuine HARNESS defect (the harness cannot produce trustworthy evidence for this
 * cell at all), not a legitimate agent outcome, so it blocks here rather than merely degrading
 * that one cell's outcomeMatches to false. `parallelEvidenceOk` is the identical treatment for a
 * `malformed_parallel_evidence` error (buildRunRecord, from graders.mjs's own
 * `parallelEvidenceMalformed`) -- the terminal kmp-test attempt's own `parallel.legs[]` structure
 * was internally incoherent, a systematic-closure review found this was previously laundered only
 * through expected_outcome_matched:false (a valid negative result the incoherence is NOT).
 * `junitSkipEvidenceOk` is the identical treatment for an `unreliable_gradle_junit_evidence` error
 * (buildRunRecord, from graders.mjs's own `gradleJunitEvidenceUnreliable`) -- an allowed Gradle
 * attempt's own JUnit XML contains a genuine skipped testcase this evidence path cannot correctly
 * count, or is unreadable/oversized/over the capture bounds. `junitCaptureCompleteOk` is the
 * identical HARNESS-integrity treatment for a `junit_evidence_capture_incomplete` error
 * (buildRunRecord, from graders.mjs's own `gradleJunitEvidenceCaptureIncomplete`) -- distinct from
 * both of the above: the attribution MECHANISM itself failed for some relevant attempt in the
 * condition (any provider) -- a missing/incoherent decision or evidence record, a command
 * cross-check mismatch, or a duplicate-write anomaly -- scanned across every relevant attempt, not
 * only whichever one later becomes terminal (see junit-evidence.mjs's attributeCondition for the
 * full rationale).
 *
 * `skillSelectionOk`/`foreignSkillToolResultsCompleteOk` are result-aware (classifyForeignSkillUses,
 * not the plain findForeignSkillUses calibration/smoke still use): for a scenario's naturally-
 * prompted transcript, a REJECTED foreign attempt ("Unknown skill") is measured agent behavior,
 * not contamination -- only a CONFIRMED foreign invocation still fails skillSelectionOk. A
 * missing/incomplete result on a foreign call is its own distinct failure
 * (foreignSkillToolResultsCompleteOk), deliberately NOT delegated to the generic timeout-tolerant
 * toolResultsCompleteOk check below (which can excuse exactly one incomplete tool_use if it's the
 * last one before a genuine timeout) -- a foreign Skill call's own incompleteness must fail closed
 * unconditionally, with no timeout exception.
 */
function scenarioCellIntegrityOk(record, conditionResult, { sharedAmbientNames = new Set(), ambientProfileMatrixOk = true } = {}) {
  const expectSkillAvailable = record.condition === 'current-skill';
  const availabilityOk = record.skill_available.value === expectSkillAvailable;
  // Post-#385 review finding: a no-skill condition's plugin is never loaded (availabilityOk/
  // pluginProfileOk already prove this), but a CONFIRMED invocation could still slip through some
  // OTHER route (an environmental same-named skill, a Claude Code inconsistency) -- now that
  // isTargetSkillReference correctly recognizes both the bare and plugin-namespaced forms as the
  // TARGET skill, skillSelectionOk (which only catches a FOREIGN invocation) no longer catches
  // this. A confirmed no-skill invocation is real evidence-contamination, mirroring
  // calibrationHardGate's own noSkillSafetyOk exactly. current-skill is deliberately exempt --
  // whether the skill triggers naturally on a scenario prompt is part of what's being MEASURED,
  // not a harness precondition (unchanged from this function's original design).
  const noSkillSafetyOk = expectSkillAvailable || record.skill_invoked.value === false;
  const pluginProfileOk = hasExpectedPluginProfile(conditionResult.init, TARGET_PLUGIN_NAME, expectSkillAvailable);
  const pluginSnapshotBindingOk = !expectSkillAvailable || isPluginBoundToSnapshot(conditionResult.init, conditionResult.snapshotDir);
  const foreignSkillUses = classifyForeignSkillUses(conditionResult.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME);
  // Ambient-skill-profile fix: a real live run's no-skill cells were wrongly rejected for
  // confirming Claude Code's own bundled "run" skill -- present in init.skills[] regardless of
  // --plugin-dir (see isSkillAvailable's doc comment, stream-parser.mjs), not genuine third-party
  // contamination. A CONFIRMED foreign call is now tolerated ONLY when its exact skillArg was
  // advertised in `sharedAmbientNames` -- the matrix-wide consensus ambient profile scenarioHardGate
  // computes across every cell (never a hardcoded "run" special-case; a malformed/missing skillArg,
  // or one absent from that set, still fails closed exactly as before). `ambientSkillProfileOk` is
  // THIS cell's own init.skills[] parse validity (computeAmbientSkillProfile, self-derived -- a
  // single cell can always judge its own transcript alone); `ambientProfileMatrixOk` is the SAME
  // shared boolean threaded into every cell in the matrix by scenarioHardGate, so a cross-cell
  // mismatch (or any cell's own malformed profile) blocks the WHOLE batch via the existing
  // per-cell aggregation, with zero changes needed to that aggregation logic itself. Both default
  // to the "everything's fine" value when this function is called in isolation (every existing
  // 2-arg test call site) -- a single cell outside a real matrix context cannot meaningfully judge
  // cross-cell agreement either way.
  // Review-round-2 fix (correction 1): condition-aware -- a no-skill cell whose skills[]
  // anomalously advertises the target's own bare/namespaced identity (even if never actually
  // invoked) is real evidence contamination that neither pluginProfileOk (checks plugins[], not
  // skills[]) nor noSkillSafetyOk (checks actual invocation, not mere advertisement) can catch.
  // ambientSkillProfileOk covers pure structural validity; targetSkillAmbientIdentityOk covers the
  // target-presence-appropriateness/no-duplicate-representation concern -- kept as two distinct
  // named checks for independent diagnosability, mirroring this function's existing granularity.
  const ambientProfile = computeAmbientSkillProfile(conditionResult.init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: expectSkillAvailable });
  const ambientSkillProfileOk = ambientProfile.structurallyWellFormed;
  const targetSkillAmbientIdentityOk = ambientProfile.targetIdentityOk;
  const confirmedForeignSkillUses = foreignSkillUses.filter((u) => u.confirmed === true);
  const skillSelectionOk = confirmedForeignSkillUses.every((u) => u.skillArg != null && sharedAmbientNames.has(u.skillArg));
  const foreignSkillToolResultsCompleteOk = !foreignSkillUses.some((u) => u.resultIsError === null);
  const initOk = conditionResult.init != null;
  const toolProfileOk = hasExpectedToolProfile(conditionResult.init, EXPECTED_TOOL_NAMES);
  const noUnexpectedToolsOk = findUnexpectedToolUses(conditionResult.events, EXPECTED_TOOL_NAMES).length === 0;
  const hookAccountingOk = conditionResult.hookStats.everyCallHooked === true;
  const cleanTranscriptOk = conditionResult.malformedLines.length === 0;
  const timeoutCtx = { terminated: conditionResult.spawnResult.terminated, terminationReason: conditionResult.spawnResult.terminationReason };
  const transcriptStructureOk = findTranscriptStructuralIssuesToleratingTimeout(conditionResult.events, timeoutCtx).length === 0;
  const toolResultsCompleteOk = findIncompleteToolResultsToleratingTimeout(conditionResult.events, timeoutCtx).length === 0;
  const terminationOk = conditionResult.spawnResult.terminated === false || conditionResult.spawnResult.terminationReason === 'timeout';
  const junitEvidenceOk = !(record.errors ?? []).some((e) => e.code === 'ambiguous_junit_evidence');
  const parallelEvidenceOk = !(record.errors ?? []).some((e) => e.code === 'malformed_parallel_evidence');
  const junitSkipEvidenceOk = !(record.errors ?? []).some((e) => e.code === 'unreliable_gradle_junit_evidence');
  // Per-attempt JUnit-evidence-attribution mechanism ("bind junit evidence to authoritative
  // attempts" fix): junit_evidence_capture_incomplete is a DISTINCT, never-merged code from
  // ambiguous_junit_evidence -- a capture-mechanism failure (a missing/incoherent decision record
  // for any relevant attempt, or a missing Gradle evidence record) is a different problem from a
  // proven same-turn concurrency conflict, and each gets its own independently-toggleable check.
  const junitCaptureCompleteOk = !(record.errors ?? []).some((e) => e.code === 'junit_evidence_capture_incomplete');

  const evaluation = evaluateNamedChecks([
    ['availabilityOk', availabilityOk], ['noSkillSafetyOk', noSkillSafetyOk],
    ['pluginProfileOk', pluginProfileOk],
    ['pluginSnapshotBindingOk', pluginSnapshotBindingOk], ['skillSelectionOk', skillSelectionOk],
    ['foreignSkillToolResultsCompleteOk', foreignSkillToolResultsCompleteOk], ['initOk', initOk],
    ['toolProfileOk', toolProfileOk], ['noUnexpectedToolsOk', noUnexpectedToolsOk],
    ['hookAccountingOk', hookAccountingOk], ['cleanTranscriptOk', cleanTranscriptOk],
    ['transcriptStructureOk', transcriptStructureOk], ['toolResultsCompleteOk', toolResultsCompleteOk],
    ['terminationOk', terminationOk], ['junitEvidenceOk', junitEvidenceOk],
    ['parallelEvidenceOk', parallelEvidenceOk], ['junitSkipEvidenceOk', junitSkipEvidenceOk],
    ['junitCaptureCompleteOk', junitCaptureCompleteOk],
    ['ambientSkillProfileOk', ambientSkillProfileOk], ['targetSkillAmbientIdentityOk', targetSkillAmbientIdentityOk],
    ['ambientProfileMatrixOk', ambientProfileMatrixOk],
  ]);
  return { ok: evaluation.ok, reason: evaluation.reason, failedChecks: evaluation.failedChecks };
}

/**
 * The whole-matrix hard gate for `run` (decision 4): one bad cell's integrity failure blocks the
 * WHOLE batch's promotion, never a partial one -- this is what makes "atomic whole-matrix
 * promotion" a real requirement, not a nice-to-have. Never inspects any cell's scenario OUTCOME
 * (success/expected_outcome_matched) -- a cell where the agent got the task wrong, or legitimately
 * timed out, still passes this gate and gets promoted with its true (failing) outcome, as long as
 * harness integrity held for every cell.
 *
 * `cellResults` covers EVERY cell in the batch, not only the failing ones -- rejected-run
 * diagnostics (rejection-diagnostics.mjs) need the whole matrix as context, since "one bad cell
 * blocks the whole matrix" means every cell is relevant to explaining a rejection, not just the
 * cell(s) that individually failed. Computed in this function's own single existing loop -- never
 * re-run scenarioCellIntegrityOk a second time to recover this.
 *
 * Ambient-skill-profile fix: before that per-cell loop, computes the matrix-WIDE consensus ambient
 * profile once -- every cell's own init.skills[] (target identity stripped, condition-aware per
 * correction 1) must parse cleanly AND agree exactly with every other cell's, or
 * `sharedAmbientNames` collapses to the empty Set (fail-closed: no confirmed foreign Skill call is
 * tolerated anywhere in the batch). The SAME `ambientProfileMatrixOk` boolean is threaded into
 * every cell's own `scenarioCellIntegrityOk` call as a named check (not ONLY a separate top-level
 * field) -- deliberately reuses the existing per-cell loop/reason-aggregation below completely
 * unchanged: a genuine cross-cell mismatch (or one cell's own malformed profile) then fails EVERY
 * cell via the existing machinery, which both correctly blocks the whole matrix (atomic promotion,
 * unchanged) and automatically satisfies rejection-diagnostics.mjs's own "at least one cell must
 * have a non-empty failed_checks" invariant with zero changes needed there. Also returned as its
 * own top-level field (correction 6) so a caller building rejection diagnostics can record the
 * matrix-wide consensus result directly, without re-deriving it from cellResults.
 *
 * Review-round-2 fix (correction 5): fails closed WITHOUT THROWING unless both arguments are
 * non-empty arrays of exactly equal length -- the pre-fix version silently returned a vacuous
 * `{ok:true, cellResults:[]}` for `records:[]` paired with a non-empty `conditionResults` (a
 * meaningless "pass" for a mismatched, degenerate input the caller almost certainly never
 * intended), and threw an uncaught TypeError for the reverse mismatch (`conditionResults:[]` with
 * a non-empty `records`, since `ambientProfiles[0]` is then `undefined`). Both directly
 * demonstrated against the pre-fix code. A real hard gate must never let a malformed invocation
 * either silently vanish or crash its caller uncaught.
 */
function scenarioHardGate(records, conditionResults) {
  if (!Array.isArray(records) || !Array.isArray(conditionResults) || records.length === 0 || conditionResults.length === 0 || records.length !== conditionResults.length) {
    const recordsLen = Array.isArray(records) ? records.length : typeof records;
    const conditionResultsLen = Array.isArray(conditionResults) ? conditionResults.length : typeof conditionResults;
    return {
      ok: false,
      reason: `scenario hard gate received an invalid matrix shape -- records.length=${recordsLen} conditionResults.length=${conditionResultsLen} (both must be non-empty arrays of exactly equal length)`,
      cellResults: [],
      ambientProfileMatrixOk: false,
    };
  }
  const ambientProfiles = records.map((r, i) => computeAmbientSkillProfile(conditionResults[i].init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: r.condition === 'current-skill' }));
  const allAmbientProfilesOk = ambientProfiles.every((p) => p.ok);
  const canonicalKeys = ambientProfiles.map((p) => canonicalAmbientSkillNamesKey(p.names));
  const ambientProfileMatrixOk = allAmbientProfilesOk && new Set(canonicalKeys).size <= 1;
  const sharedAmbientNames = ambientProfileMatrixOk ? ambientProfiles[0].names : new Set();

  const failures = [];
  const cellResults = [];
  for (let i = 0; i < records.length; i++) {
    const cell = scenarioCellIntegrityOk(records[i], conditionResults[i], { sharedAmbientNames, ambientProfileMatrixOk });
    cellResults.push({
      runId: records[i].run_id,
      condition: records[i].condition,
      repetitionIndex: records[i].repetition_index,
      ok: cell.ok,
      failedChecks: cell.failedChecks,
    });
    if (!cell.ok) {
      failures.push(`cell[${i}] (repetition ${records[i].repetition_index}, condition ${records[i].condition}): ${cell.reason}`);
    }
  }
  const ok = failures.length === 0;
  return { ok, reason: ok ? null : `scenario hard gate failed for ${failures.length}/${records.length} cell(s) -- ${failures.join(' || ')}`, cellResults, ambientProfileMatrixOk };
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
  const scopeCheck = resolveMeasurementScopeOrFail(args['measurement-scope-file'] ?? null);
  if (!scopeCheck.ok) {
    console.error(scopeCheck.reason);
    return 1;
  }
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const templateDir = join(__dirname, 'fixtures', 'calibration-project');
  // Round-7 audit finding: this call sat OUTSIDE the try block below, unguarded -- any exception
  // during resource acquisition or session spawning (acquireSharedEvalResources' own real
  // mkdtempSync/git-materialize calls, both genuinely capable of throwing under resource pressure
  // or a transient git/filesystem hiccup) would escape uncaught all the way to main()'s own
  // top-level catch, exiting 2 with a raw stack trace instead of this command's own clean "FAILED:
  // <reason>" / exit 1 contract every OTHER failure path here already uses. Not proven to be THE
  // root cause of any specific CI failure (never reproduced locally despite real attempts across
  // both platforms, isolated and full-suite, plain and CPU-constrained), but it is a genuine,
  // structurally-real gap independent of that -- closing it is correct regardless.
  let conditionPair;
  try {
    conditionPair = await runConditionPair({
      prompt: 'Use the kmp-test-runner skill to check this project.',
      model,
      allowedGradleTasks: ['build'],
      allowedKmpTestSubcommands: ['doctor', 'parallel'],
      materializeFixture: (existingDir) => materializeCalibrationProject({ templateDir, existingDir }),
      cleanupFixture: (fixtureDir) => rmSync(fixtureDir, { recursive: true, force: true }),
    });
  } catch (err) {
    console.error(`CALIBRATION FAILED: session acquisition/spawn threw before any condition completed: ${err.stack || err.message}`);
    return 1;
  }
  try {
    const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands } = conditionPair;
    const policySha256 = computePolicySha256();
    // One HMAC key + opaque scope id for this ENTIRE calibrate invocation (correction 2) --
    // shared by both A and B so they remain comparable to each other, never persisted. Ephemeral
    // (freshly random) unless --measurement-scope-file supplied a stable one (resolved eagerly,
    // above, before any spawn -- see resolveMeasurementScopeOrFail's own doc comment).
    const { scopeId: ambientProfileScopeId, key: ambientProfileKey } = scopeCheck;
    const common = { runKind: 'calibration', scenarioId: 'calibration-explicit-invocation', skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, modelRequested: model, privacyStatus, ambientProfileScopeId, ambientProfileKey };
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
      if (result.diagnosticsWriteError) console.error(`(rejected-run diagnostics were NOT written: ${result.diagnosticsWriteError})`);
      else if (result.rejectionId) console.error(`(rejected-run diagnostics written: ${result.diagnosticsRelativePath}, rejection_id ${result.rejectionId})`);
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
 * availability. For B (current-skill), skill_invoked is deliberately NOT required (whether the
 * skill triggers naturally on this prompt is an open question for a future corpus-probe run, not
 * something smoke should presuppose). For A (no-skill), skill_invoked IS required to be false
 * (noSkillSafetyOk, post-#385 review addition, mirrors calibrationHardGate's identical check) --
 * a genuinely CONFIRMED invocation in the arm whose plugin was never loaded is real evidence
 * contamination, not an open measurement question.
 *
 * Computed per-side (A/B) via evaluateNamedChecks and combined as `evalA.ok && evalB.ok` --
 * mathematically identical to a single flat AND of all 15 checks, so this restructure changes
 * zero pass/fail behavior; see calibrationHardGate's identical rationale.
 */
function smokeHardGate(a, b, runAResult, runBResult) {
  const availabilityOkA = a.skill_available.value === false;
  const availabilityOkB = b.skill_available.value === true;
  // Post-#385 review finding, mirrors scenarioCellIntegrityOk's identical new check and
  // calibrationHardGate's own noSkillSafetyOk -- A's plugin is never loaded, but a CONFIRMED
  // invocation (now correctly recognized as the target skill under either wire form, never
  // foreign) is real evidence contamination that skillSelectionOk alone no longer catches. B is
  // deliberately exempt -- see this function's own doc comment on skill_invoked never being
  // required for B.
  const noSkillSafetyOkA = a.skill_invoked.value === false;
  // See calibrationHardGate's identical check and doc comment -- noUnexpectedToolsOk only checks
  // the tool NAME (Bash/Skill), never a Skill call's own `input.skill` argument, so this closes
  // the same gap here: neither condition may contain a Skill call targeting anything other than
  // kmp-test-runner. Deliberately still the plain, argument-only findForeignSkillUses -- smoke's
  // contract is untouched by this change.
  const skillSelectionOkA = findForeignSkillUses(runAResult.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).length === 0;
  const skillSelectionOkB = findForeignSkillUses(runBResult.events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).length === 0;
  // See calibrationHardGate's identical check and doc comment -- neither isSkillAvailable nor
  // hasExpectedToolProfile ever inspects the init event's own plugins[] array.
  const pluginProfileOkA = hasExpectedPluginProfile(runAResult.init, TARGET_PLUGIN_NAME, false);
  const pluginProfileOkB = hasExpectedPluginProfile(runBResult.init, TARGET_PLUGIN_NAME, true);
  // See calibrationHardGate's identical check and doc comment -- pluginProfileOk never checks
  // the loaded plugin's own path, only its name/count.
  const pluginSnapshotBindingOk = isPluginBoundToSnapshot(runBResult.init, runBResult.snapshotDir);
  // See calibrationHardGate's identical check and doc comment -- neither findInitEvent/
  // findResultEvent (take "the first" of a kind) nor findIncompleteToolResults (only checks "at
  // least one" correlation) catch a second contradictory init+result pair, or duplicated
  // tool_use ids satisfied by a single tool_result.
  const transcriptStructureOkA = findTranscriptStructuralIssues(runAResult.events).length === 0;
  const transcriptStructureOkB = findTranscriptStructuralIssues(runBResult.events).length === 0;
  // See calibrationHardGate's identical check -- a session with no init event at all is a
  // broken/incomplete capture, not legitimately-observed data.
  const initOkA = runAResult.init != null;
  const initOkB = runBResult.init != null;
  // See calibrationHardGate's identical checks -- the init event's OWN declared profile must
  // match what this harness actually launches with, and no tool_use anywhere in the transcript
  // may name anything outside Bash/Skill.
  const toolProfileOkA = hasExpectedToolProfile(runAResult.init, EXPECTED_TOOL_NAMES);
  const toolProfileOkB = hasExpectedToolProfile(runBResult.init, EXPECTED_TOOL_NAMES);
  const noUnexpectedToolsOkA = findUnexpectedToolUses(runAResult.events, EXPECTED_TOOL_NAMES).length === 0;
  const noUnexpectedToolsOkB = findUnexpectedToolUses(runBResult.events, EXPECTED_TOOL_NAMES).length === 0;
  const processOkA = a.terminated === false && a.exit_code === 0;
  const processOkB = b.terminated === false && b.exit_code === 0;
  // subtype==='success' (not just is_error===false) -- see calibrationHardGate's identical
  // check; a budget-cap-truncated session is not a genuine completion even when is_error is
  // false for that particular subtype.
  const resultOkA = runAResult.result?.subtype === 'success' && runAResult.result?.is_error === false;
  const resultOkB = runBResult.result?.subtype === 'success' && runBResult.result?.is_error === false;
  const hookAccountingOkA = runAResult.hookStats.everyCallHooked === true;
  const hookAccountingOkB = runBResult.hookStats.everyCallHooked === true;
  // hook_call_count>=1 proves the agent actually tried real commands; hook_deny_count===0 proves
  // every command it tried was inside the approved grammar; hookAllowCount matching
  // hook_call_count proves every decision was explicitly "allow", not merely "not deny" (a
  // hook_response with unparseable `output` JSON produces neither an allow nor a deny decision --
  // hook_deny_count===0 alone would silently accept that).
  const realWorkOkA = a.hook_call_count >= 1 && a.hook_deny_count === 0 && runAResult.hookStats.hookAllowCount === a.hook_call_count;
  const realWorkOkB = b.hook_call_count >= 1 && b.hook_deny_count === 0 && runBResult.hookStats.hookAllowCount === b.hook_call_count;
  // Requires the EXACT expected multiset (both commands, --json included, exactly once each, no
  // extras) -- see verifyExactCommandsSucceeded's own doc comment.
  const exactCommandsOkA = verifyExactCommandsSucceeded(runAResult.bashResults, SMOKE_EXPECTED_COMMANDS);
  const exactCommandsOkB = verifyExactCommandsSucceeded(runBResult.bashResults, SMOKE_EXPECTED_COMMANDS);
  const cleanTranscriptOkA = runAResult.malformedLines.length === 0;
  const cleanTranscriptOkB = runBResult.malformedLines.length === 0;
  // See calibrationHardGate's identical check and doc comment -- a dangling tool_use with no
  // correlated tool_result is an incomplete capture, not a demonstrated outcome.
  const toolResultsCompleteOkA = findIncompleteToolResults(runAResult.events).length === 0;
  const toolResultsCompleteOkB = findIncompleteToolResults(runBResult.events).length === 0;
  // See calibrationHardGate's identical check and doc comment (review-round-2 fix, correction 4) --
  // a missing/malformed init.skills[] must not silently pass as a "verified empty" ambient
  // profile, and A's skills[] must show zero target references (condition-aware, correction 1).
  // smoke's own skillSelectionOk (zero-tolerance) is untouched.
  const ambientProfileA = computeAmbientSkillProfile(runAResult.init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: false });
  const ambientProfileB = computeAmbientSkillProfile(runBResult.init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: true });
  const ambientSkillProfileOkA = ambientProfileA.structurallyWellFormed;
  const ambientSkillProfileOkB = ambientProfileB.structurallyWellFormed;
  const targetSkillAmbientIdentityOkA = ambientProfileA.targetIdentityOk;
  const targetSkillAmbientIdentityOkB = ambientProfileB.targetIdentityOk;

  const checksA = [
    ['availabilityOk', availabilityOkA], ['noSkillSafetyOk', noSkillSafetyOkA],
    ['skillSelectionOk', skillSelectionOkA],
    ['pluginProfileOk', pluginProfileOkA], ['initOk', initOkA], ['toolProfileOk', toolProfileOkA],
    ['noUnexpectedToolsOk', noUnexpectedToolsOkA], ['processOk', processOkA],
    ['resultOk', resultOkA], ['hookAccountingOk', hookAccountingOkA],
    ['realWorkOk', realWorkOkA], ['exactCommandsOk', exactCommandsOkA],
    ['cleanTranscriptOk', cleanTranscriptOkA], ['toolResultsCompleteOk', toolResultsCompleteOkA],
    ['transcriptStructureOk', transcriptStructureOkA],
    ['ambientSkillProfileOk', ambientSkillProfileOkA], ['targetSkillAmbientIdentityOk', targetSkillAmbientIdentityOkA],
  ];
  const checksB = [
    ['availabilityOk', availabilityOkB], ['skillSelectionOk', skillSelectionOkB],
    ['pluginProfileOk', pluginProfileOkB], ['pluginSnapshotBindingOk', pluginSnapshotBindingOk],
    ['initOk', initOkB], ['toolProfileOk', toolProfileOkB],
    ['noUnexpectedToolsOk', noUnexpectedToolsOkB], ['processOk', processOkB],
    ['resultOk', resultOkB], ['hookAccountingOk', hookAccountingOkB],
    ['realWorkOk', realWorkOkB], ['exactCommandsOk', exactCommandsOkB],
    ['cleanTranscriptOk', cleanTranscriptOkB], ['toolResultsCompleteOk', toolResultsCompleteOkB],
    ['transcriptStructureOk', transcriptStructureOkB],
    ['ambientSkillProfileOk', ambientSkillProfileOkB], ['targetSkillAmbientIdentityOk', targetSkillAmbientIdentityOkB],
  ];
  const evalA = evaluateNamedChecks(checksA);
  const evalB = evaluateNamedChecks(checksB);
  const ok = evalA.ok && evalB.ok;
  return {
    ok,
    reason: ok ? null : `smoke hard gate failed -- A:{${joinChecks(checksA)}} B:{${joinChecks(checksB)}} (A hook_call_count:${a.hook_call_count} hook_deny_count:${a.hook_deny_count} hookAllowCount:${runAResult.hookStats.hookAllowCount} result_subtype:${runAResult.result?.subtype} tools:${JSON.stringify(runAResult.init?.tools)}, B hook_call_count:${b.hook_call_count} hook_deny_count:${b.hook_deny_count} hookAllowCount:${runBResult.hookStats.hookAllowCount} result_subtype:${runBResult.result?.subtype} tools:${JSON.stringify(runBResult.init?.tools)})`,
    failedChecksA: evalA.failedChecks,
    failedChecksB: evalB.failedChecks,
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
  const scopeCheck = resolveMeasurementScopeOrFail(args['measurement-scope-file'] ?? null);
  if (!scopeCheck.ok) {
    console.error(scopeCheck.reason);
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
  // Round-7 audit finding: see cmdCalibrate's identical rationale -- resource acquisition must
  // never be allowed to throw uncaught past this command's own "FAILED: <reason>" / exit 1
  // contract.
  let conditionPair;
  try {
    conditionPair = await runConditionPair({
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
  } catch (err) {
    console.error(`SMOKE FAILED: session acquisition/spawn threw before any condition completed: ${err.stack || err.message}`);
    return 1;
  }
  try {
    const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands } = conditionPair;
    const policySha256 = computePolicySha256();
    // One HMAC key + opaque scope id for this ENTIRE smoke invocation (correction 2) -- shared by
    // both A and B so they remain comparable to each other, never persisted. Ephemeral (freshly
    // random) unless --measurement-scope-file supplied a stable one (resolved eagerly, above,
    // before any spawn -- see resolveMeasurementScopeOrFail's own doc comment).
    const { scopeId: ambientProfileScopeId, key: ambientProfileKey } = scopeCheck;
    const common = { runKind: 'smoke', scenarioId, skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias, projectCommit: pinnedCommit, projectUrl, family: 'test-only', modelRequested: model, privacyStatus, ambientProfileScopeId, ambientProfileKey };
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
      if (result.diagnosticsWriteError) console.error(`(rejected-run diagnostics were NOT written: ${result.diagnosticsWriteError})`);
      else if (result.rejectionId) console.error(`(rejected-run diagnostics written: ${result.diagnosticsRelativePath}, rejection_id ${result.rejectionId})`);
      return 1;
    }
    console.log(JSON.stringify({ recordA: result.redactedRecordA, recordB: result.redactedRecordB, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } finally {
    reportCleanupFailures(await conditionPair.cleanup());
  }
}

/**
 * Loads and validates one scenario by id from the committed corpus/scenarios/<id>.json --
 * `--scenario` is required and singular (decision 1: one invocation = one scenario = one policy =
 * one oracle = one atomic-promotion unit, never an optional filter over multiple files with
 * potentially different policies). Returns {ok:true, scenario} or {ok:false, reason}; never
 * throws, so cmdRun can report a clean, actionable error instead of a raw ENOENT/JSON.parse
 * stack. Re-validates against the live validateScenario() (not just "the file parses") and
 * cross-checks the file's OWN declared id against the requested id, mirroring the
 * filename-must-match-id invariant cmdCorpusValidate already enforces for the committed corpus.
 */
function loadScenarioById(scenarioId) {
  if (typeof scenarioId !== 'string' || !/^[a-z0-9-]+$/.test(scenarioId)) {
    return { ok: false, reason: `--scenario must be a kebab-case scenario id, got: ${JSON.stringify(scenarioId)}` };
  }
  const scenarioPath = join(SCENARIOS_DIR, `${scenarioId}.json`);
  if (!existsSync(scenarioPath)) {
    return { ok: false, reason: `no scenario file found for --scenario ${scenarioId} (expected ${scenarioPath})` };
  }
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `scenario file for ${scenarioId} is not valid JSON: ${err.message}` };
  }
  const { errors } = validateScenario(scenario);
  if (errors.length > 0) {
    return { ok: false, reason: `scenario file for ${scenarioId} failed schema validation: ${JSON.stringify(errors)}` };
  }
  if (scenario.id !== scenarioId) {
    return { ok: false, reason: `scenario file's declared id "${scenario.id}" does not match --scenario ${scenarioId}` };
  }
  return { ok: true, scenario };
}

/** Canonicalizes a git remote URL to a bare `host/org/repo` identity for comparison -- a fresh
 * review reproduced a real false rejection: a legitimate SSH-remote clone
 * (`git@github.com:org/repo.git`) was rejected as "wrong local clone" purely because it was
 * compared literally against the scenario's declared HTTPS `project_url`
 * (`https://github.com/org/repo`), even though both name the exact same remote repository.
 * Recognizes three real-world forms -- the SSH shorthand `git@host:path`, the `ssh://[user@]host/
 * path` URI form (a DIFFERENT form from the shorthand: a slash after the host, not a colon), and
 * `http(s)://host/path` -- comparing case-insensitively (host/scheme case never changes identity).
 * A further review reproduced two more real false rejections against this same function: (1) it
 * never recognized `ssh://` URLs at all, only the bare shorthand; (2) trailing-slash stripping ran
 * BEFORE `.git`-suffix stripping, so `https://host/org/repo.git/` (a trailing slash AFTER `.git`)
 * never matched `/\.git$/` (the string's true end was `/`, not `t`) and kept its `.git` suffix,
 * producing a canonical form that didn't match the same remote's slash-free spelling. Reordered:
 * strip trailing slashes FIRST, then `.git`, then trailing slashes again (harmless if none remain).
 * Anything else (an unrecognized scheme) falls through to the same trim-only normalization as
 * before, so this is strictly additive -- it never makes an already-passing comparison stricter. */
function normalizeGitRemoteForComparison(url) {
  // Lowercase ONLY the host (scheme/host case never changes identity) -- a fresh review reproduced
  // this blanket-lowercasing the ENTIRE result including the org/repo PATH, so
  // `example.com/Team/Repo` and `example.com/team/repo` compared equal even though most git hosts
  // treat repository paths as case-SENSITIVE (this tool is not GitHub-specific -- project_url is
  // any https:// URL -- and even where a host happens to be case-insensitive in practice, silently
  // conflating two case-distinct paths risks masking a genuinely different repository). Path case
  // is now preserved exactly.
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const sshShortMatch = /^[\w.-]+@([^:/]+):\/?(.+)$/i.exec(trimmed);
  if (sshShortMatch) return `${sshShortMatch[1].toLowerCase()}/${sshShortMatch[2]}`;
  const sshUriMatch = /^ssh:\/\/(?:[\w.-]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
  if (sshUriMatch) return `${sshUriMatch[1].toLowerCase()}/${sshUriMatch[2]}`;
  const httpMatch = /^https?:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
  if (httpMatch) return `${httpMatch[1].toLowerCase()}/${httpMatch[2]}`;
  return trimmed;
}

/**
 * Verifies `sourceRepoDir` is a trustworthy materialization source for `scenario` BEFORE any git
 * worktree is ever created from it -- never called for --dry-run, which returns before touching
 * the source repo at all. Three independent checks, each its own actionable error: (1) the
 * repo's own `origin` remote identifies the SAME repository as the scenario's declared
 * project_url, tolerating the SSH-vs-HTTPS scheme difference (see `normalizeGitRemoteForComparison`)
 * -- catches "pointed at the wrong local clone entirely" without also rejecting a legitimate clone
 * merely for using a different, equally valid remote URL form; (2) the working tree is clean --
 * this is deliberately a courtesy check protecting the operator's own uncommitted local work in
 * `sourceRepoDir` from being silently ignored, NOT a scenario-ground-truth-correctness check: a
 * fresh review correctly pointed out that materialization reads the pinned commit object from the
 * repository's OWN database, never the working tree, so dirty state in `sourceRepoDir`
 * structurally CANNOT leak into what actually gets materialized -- the original doc comment's
 * framing ("could silently diverge the materialized fixture") overstated what this check
 * protects against, corrected here; (3) the pinned commit actually resolves inside the repo --
 * gives a clear, specific error instead of a raw failure deep inside a try/catch elsewhere.
 */
function verifySourceRepoForScenario(sourceRepoDir, scenario) {
  if (!existsSync(sourceRepoDir)) {
    return { ok: false, reason: `--source-repo-dir does not exist: ${sourceRepoDir}` };
  }
  const remoteUrl = resolveGitRemoteUrl(sourceRepoDir);
  if (remoteUrl == null) {
    return { ok: false, reason: `--source-repo-dir does not look like a git repository with an 'origin' remote: ${sourceRepoDir}` };
  }
  if (normalizeGitRemoteForComparison(remoteUrl) !== normalizeGitRemoteForComparison(scenario.project_url)) {
    return { ok: false, reason: `--source-repo-dir's origin remote (${remoteUrl}) does not match the scenario's declared project_url (${scenario.project_url}) -- wrong local clone?` };
  }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: sourceRepoDir, encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    return { ok: false, reason: `could not verify --source-repo-dir's working tree is clean (git status failed in ${sourceRepoDir})` };
  }
  const dirtyPaths = status.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (dirtyPaths.length > 0) {
    return { ok: false, reason: `--source-repo-dir has uncommitted local modifications -- refusing as a courtesy to your own in-progress work there (materialization always reads the pinned commit object regardless, so this is optional hygiene, not a scenario-correctness protection): ${dirtyPaths.join(', ')}` };
  }
  const commitCheck = spawnSync('git', ['cat-file', '-e', `${scenario.project_commit}^{commit}`], { cwd: sourceRepoDir, encoding: 'utf8' });
  if (commitCheck.status !== 0) {
    return { ok: false, reason: `the scenario's pinned commit ${scenario.project_commit} does not resolve inside --source-repo-dir -- fetch it first` };
  }
  return { ok: true, reason: null };
}

/**
 * Builds the full resolved execution plan (which repetition/condition runs at each order_index)
 * exactly the way runScenarioMatrix itself will -- shared by --dry-run's preview and (implicitly,
 * via the SAME buildRunMatrix/buildConditionOrders calls inside matrix-runner.mjs) the real run,
 * so a preview can never drift from what actually executes. Pure/side-effect-free.
 */
function buildScenarioRunPlan(scenarioId, repeats, seed) {
  const repetitionSlots = buildRunMatrix([scenarioId], ['trial'], repeats, seed);
  const conditionOrders = buildConditionOrders(repeats, seed);
  const plan = [];
  let orderIndex = 0;
  for (const slot of repetitionSlots) {
    const repetitionIndex = slot.repetition;
    for (const condition of conditionOrders[repetitionIndex]) {
      plan.push({ order_index: orderIndex, repetition_index: repetitionIndex, condition });
      orderIndex++;
    }
  }
  return plan;
}

// A review pass flagged --repeats as unbounded: each repetition spawns 2 real live Claude
// sessions once `run` is ever pointed at a genuine Claude Code binary (never true in THIS PR,
// which spawns only the fake-claude test fixture -- but this safeguard belongs in the code being
// shipped now, since a future live-validation PR will use this exact command). A single typo
// (e.g. --repeats 100 instead of --repeats 10) would silently authorize 200 live sessions with no
// warning. 20 (5x the default of 4) comfortably covers legitimate manual research runs while
// still catching an obvious order-of-magnitude typo; anything larger is refused outright rather
// than silently accepted.
const MAX_REPEATS = 20;

/**
 * `run` -- executes a full scenario matrix (decisions 1/2/3 of the design) and, on success,
 * atomically promotes all `2*repeats` records together (decision 11). `--scenario`/
 * `--source-repo-dir`/`--seed` are all required and explicit (no auto-generated seed: an omitted
 * --seed would make a run's own --dry-run preview silently diverge from a later real run unless
 * the caller remembered to pass the identical value both times -- every OTHER value this harness
 * ever varies is either fixed or explicitly flagged, and seed is no different). `--repeats`
 * defaults to 4 (decision 15: even, benchmark_eligible-capable by construction), accepts any
 * positive integer up to MAX_REPEATS explicitly. `--dry-run` returns the resolved plan
 * immediately after matrix-build/policy-print, strictly before source-repo verification or any
 * spawn -- it NEVER spawns Claude and NEVER touches --source-repo-dir, by construction (the early
 * return is textually before either is ever reached); its own output states the real live session
 * count this run would spawn once pointed at a genuine `claude` binary.
 * Precisely scoped subprocess claim: without `--measurement-scope-file`, `--dry-run` is a genuine
 * zero-subprocess preview. WITH that flag, `--dry-run` DOES invoke real `git` subprocesses --
 * `resolveMeasurementScopeOrFail`'s own path-safety check, scoped exclusively to the supplied
 * scope file's own location, never to --source-repo-dir -- resolved even earlier than the checks
 * above (before this function's own `isDryRun` branch), so a malformed scope file fails closed
 * before the plan is ever printed, and a supplied file's non-secret scope_id (never the key) is
 * included in the preview.
 */
async function cmdRun(args) {
  const scenarioId = args.scenario;
  const sourceRepoDir = args['source-repo-dir'];
  const model = args.model ?? 'claude-sonnet-5';
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  const isDryRun = args['dry-run'] === true;

  if (!scenarioId || !sourceRepoDir) {
    console.error('run requires --scenario <id> --source-repo-dir <local clone> --seed <n> [--repeats <n>] [--model <name>] [--dry-run] [--private-patterns-file <path>]');
    return 1;
  }
  if (args.seed == null) {
    console.error('run requires --seed <integer> -- always explicit, never silently auto-generated, so a run is exactly reproducible from its own recorded evidence and a --dry-run preview can never silently diverge from the real run it previews');
    return 1;
  }
  const seed = Number(args.seed);
  if (!Number.isInteger(seed)) {
    console.error(`--seed must be an integer, got: ${args.seed}`);
    return 1;
  }
  const repeats = args.repeats != null ? Number(args.repeats) : 4;
  if (!Number.isInteger(repeats) || repeats < 1) {
    console.error(`--repeats must be a positive integer, got: ${args.repeats}`);
    return 1;
  }
  if (repeats > MAX_REPEATS) {
    console.error(`--repeats ${repeats} exceeds the maximum of ${MAX_REPEATS} (each repetition spawns 2 live Claude sessions once pointed at a real claude binary -- ${repeats} repeats would authorize ${repeats * 2} sessions; if this is genuinely intentional, split it into multiple smaller --repeats invocations)`);
    return 1;
  }
  const patternsCheck = validatePrivatePatternsFileOrFail(privatePatternsFile);
  if (!patternsCheck.ok) {
    console.error(patternsCheck.reason);
    return 1;
  }
  // Resolved here, BEFORE the --dry-run early-return -- see this function's own doc comment above
  // for the precise "--dry-run's subprocess guarantee, with vs. without a supplied scope file"
  // contract this deliberately runs ahead of.
  const scopeCheck = resolveMeasurementScopeOrFail(args['measurement-scope-file'] ?? null);
  if (!scopeCheck.ok) {
    console.error(scopeCheck.reason);
    return 1;
  }
  const loaded = loadScenarioById(scenarioId);
  if (!loaded.ok) {
    console.error(loaded.reason);
    return 1;
  }
  const { scenario } = loaded;

  // Matrix-build + policy-print -- identical logic to what runScenarioMatrix will itself use
  // (buildScenarioRunPlan calls the exact same buildRunMatrix/buildConditionOrders functions), so
  // this is a genuine preview, never a separately-maintained summary that could drift.
  const plan = buildScenarioRunPlan(scenario.id, repeats, seed);
  if (isDryRun) {
    // measurement_scope is a NEW, OPTIONAL field -- present only when a scope file was supplied,
    // so bare --dry-run (no scope flag) keeps its existing JSON shape byte-for-byte. Never the
    // key, only the already-non-secret scope_id.
    const measurementScope = scopeCheck.source === 'supplied' ? { measurement_scope: { scope_id: scopeCheck.scopeId, source: scopeCheck.source } } : {};
    console.log(JSON.stringify({ dry_run: true, scenario_id: scenario.id, repeats, seed, model, total_live_claude_sessions: repeats * 2, policy: scenario.policy, plan, ...measurementScope }, null, 2));
    return 0;
  }

  // Real run from here on -- verify the source repo BEFORE materializing anything from it.
  const sourceCheck = verifySourceRepoForScenario(sourceRepoDir, scenario);
  if (!sourceCheck.ok) {
    console.error(sourceCheck.reason);
    return 1;
  }

  const { computePolicySha256 } = await import('./policy-config.mjs');
  // Round-7 audit finding: see cmdCalibrate's identical rationale -- resource acquisition must
  // never be allowed to throw uncaught past this command's own "RUN FAILED: <reason>" / exit 1
  // contract.
  let matrix;
  try {
    matrix = await runScenarioMatrix({
      scenario, repeats, seed, model,
      allowedGradleTasks: scenario.policy.allowed_gradle_tasks,
      allowedKmpTestSubcommands: scenario.policy.allowed_kmptest_subcommands,
      repoRoot: REPO_ROOT, pinnedSkillSha: PINNED_SKILL_SHA, runPluginValidator,
      materializeFixture: (existingWorktreeDir) => materializeScenarioProject({ sourceRepoDir, pinnedCommit: scenario.project_commit, existingWorktreeDir }),
      cleanupFixture: (fixtureDir) => removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir }),
      targetPluginName: TARGET_PLUGIN_NAME,
      targetSkillName: TARGET_SKILL_NAME,
      timeoutMs: 600000,
    });
  } catch (err) {
    console.error(`RUN FAILED: matrix resource acquisition/spawn threw before any cell completed: ${err.stack || err.message}`);
    return 1;
  }
  try {
    const policySha256 = computePolicySha256();
    // One HMAC key + opaque scope id for this ENTIRE scenario matrix invocation (correction 2) --
    // shared by every cell (all repetitions, both conditions) so they remain comparable to each
    // other via scenarioHardGate's own cross-cell consensus check; never persisted. Ephemeral
    // (freshly random) unless --measurement-scope-file supplied a stable one (resolved eagerly,
    // before the --dry-run early-return -- see resolveMeasurementScopeOrFail's own doc comment).
    const { scopeId: ambientProfileScopeId, key: ambientProfileKey } = scopeCheck;
    const records = [];
    const conditionResults = [];
    // terminalAuthoritativeEventIndices: parallel to records/conditionResults -- the ONE additional
    // per-cell ingredient (beyond record + conditionResult) buildSidecarsFn below needs from
    // gradeScenarioCondition() to build a sidecar. Sidecar construction itself is deliberately NOT
    // done in this loop (see buildSidecarsFn below): accepted_audit can only be legitimately
    // populated once the matrix is known to pass the hard gate, so building it here -- before the
    // gate has even run -- both wastes work on a matrix that may be rejected anyway, and (per a
    // review finding) risks a sidecar problem masking the real rejection reason.
    const terminalAuthoritativeEventIndices = [];
    for (const cell of matrix.cellResults) {
      const gradeResult = gradeScenarioCondition(cell.conditionResult, scenario);
      const record = buildRunRecord({
        conditionResult: cell.conditionResult, condition: cell.conditionResult.condition,
        runKind: 'scenario', scenarioId: scenario.id, skillSourceSha: PINNED_SKILL_SHA,
        daemonPolicy: matrix.daemonPolicy, allowedGradleTasks: matrix.allowedGradleTasks,
        allowedKmpTestSubcommands: matrix.allowedKmpTestSubcommands, policySha256,
        projectAlias: scenario.project_alias, projectCommit: scenario.project_commit,
        projectUrl: scenario.project_url, family: scenario.family, modelRequested: model,
        privacyStatus, seed: cell.seed, orderIndex: cell.orderIndex, repetitionIndex: cell.repetitionIndex,
        gradeResult, ambientProfileScopeId, ambientProfileKey,
      });
      records.push(record);
      conditionResults.push(cell.conditionResult);
      terminalAuthoritativeEventIndices.push(gradeResult.terminalAuthoritativeEventIndex);
    }

    // Invoked by finalizeAndWriteMatrixRecords ONLY once the hard gate has confirmed acceptance --
    // accepted-audit work belongs strictly on the gate-passing promotion path (see that function's
    // own doc comment). Builds + finalizes + attaches record.accepted_audit for every record, and
    // returns the parallel array of already-redacted sidecar texts for atomic promotion.
    const buildSidecars = (recs, condResults) => {
      const texts = [];
      for (const [i, record] of recs.entries()) {
        const builtSidecar = buildAcceptedRunAuditSidecar({
          record, conditionResult: condResults[i],
          terminalAuthoritativeEventIndex: terminalAuthoritativeEventIndices[i],
          targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
        });
        const sidecarResult = finalizeAcceptedRunAuditSidecar(builtSidecar, { privatePatternsFile });
        if (!sidecarResult.ok) {
          return { ok: false, reason: `accepted-run-audit sidecar for record [${i}] (repetition ${record.repetition_index}, ${record.condition}): ${sidecarResult.reason}` };
        }
        record.accepted_audit = { schema: 1, relative_path: acceptedAuditRelativePathFor(record.run_id), sha256: sidecarResult.sha256 };
        texts.push(sidecarResult.redactedText);
      }
      return { ok: true, sidecarTexts: texts };
    };

    // scenarioHardGate (decision 4): one bad cell's harness-integrity failure blocks the WHOLE
    // matrix's promotion -- never a partial one. A cell where the AGENT got the task wrong, or
    // legitimately timed out, still passes this gate and is promoted with its true outcome.
    const result = await finalizeAndWriteMatrixRecords({
      runKind: 'scenario', records, conditionResults, hardGateFn: scenarioHardGate,
      privatePatternsFile, repeats, buildSidecarsFn: buildSidecars,
    });
    if (!result.ok) {
      console.error(`RUN FAILED: ${result.reason}`);
      if (result.diagnosticsWriteError) console.error(`(rejected-run diagnostics were NOT written: ${result.diagnosticsWriteError})`);
      else if (result.rejectionId) console.error(`(rejected-run diagnostics written: ${result.diagnosticsRelativePath}, rejection_id ${result.rejectionId})`);
      return 1;
    }
    console.log(JSON.stringify({ records: result.redactedRecords, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } finally {
    reportCleanupFailures(await matrix.cleanup());
  }
}

/** Filename must equal `${scenario.id}.json` exactly -- prevents a scenario file whose declared
 * `id` silently diverges from the name a human (or corpus-probe tooling) would look it up by.
 * Returns an error-shaped {field,message} object, or null if the filename matches (or `id` itself
 * isn't even a string, in which case validateScenario's own check already covers it). Extracted
 * as a standalone pure function specifically so the negative case is directly unit-testable --
 * cmdCorpusValidate itself always reads a fixed, non-parameterizable directory. */
function checkScenarioFilenameMatchesId(scenario, filename) {
  if (typeof scenario?.id !== 'string') return null;
  const expectedFilename = `${scenario.id}.json`;
  if (filename !== expectedFilename) {
    return { field: 'id', message: `filename "${filename}" does not match its own declared id -- expected "${expectedFilename}"` };
  }
  return null;
}

/** Every `id` that appears on more than one scenario in the list -- two scenario files claiming
 * the same id would make "run --scenario <id>" ambiguous about which one it resolved. Takes
 * `{id, file}` pairs (not full scenario objects) so it's trivially testable with minimal synthetic
 * input. Returns an array of {field,message} error objects (one per file after the first that
 * re-declares an already-seen id), empty if every id is unique. */
function findDuplicateScenarioIds(idFilePairs) {
  const errors = [];
  const seenIds = new Map(); // id -> first file that declared it
  for (const { id, file } of idFilePairs) {
    if (typeof id !== 'string') continue;
    if (seenIds.has(id)) {
      // `file` is returned structurally (not just embedded in `message`) so callers can attribute
      // this error back to its owning file by direct equality -- a fresh review found the previous
      // shape forced the caller to parse ownership back out of the human-readable message via a
      // brittle `.includes(\`in ${file} \`)` substring match.
      errors.push({ field: 'id', file, message: `duplicate id "${id}" in ${file} -- already declared by ${seenIds.get(id)}` });
    } else {
      seenIds.set(id, file);
    }
  }
  return errors;
}

/** Reads and parses one scenario file, returning `{file, scenario}` on success or `{file,
 * parseError}` on invalid JSON -- never throws. Extracted as its own function (rather than inline
 * in a `.map()`, which let one file's throw abort the whole command) so cmdCorpusValidate's
 * "malformed JSON degrades to its own deterministic per-file error, never aborts validation of the
 * others" contract is unit-testable with a real synthetic temp file, since cmdCorpusValidate()
 * itself always reads the fixed, real corpus/scenarios/ directory. */
function loadScenarioFile(scenariosDir, file) {
  try {
    return { file, scenario: JSON.parse(readFileSync(join(scenariosDir, file), 'utf8')) };
  } catch (err) {
    return { file, parseError: err.message };
  }
}

/** Validates every already-loaded scenario entry (`{file, scenario}` on successful parse, or
 * `{file, parseError}` -- see `loadScenarioFile`) against the corpus's shape/duplicate-id/
 * filename rules. Pure and synthetic-input-testable (unlike cmdCorpusValidate itself, which always
 * reads the fixed real corpus/scenarios/ directory) -- specifically proves one entry's own
 * `parseError` never prevents any OTHER entry, valid or invalid, from being fully validated and
 * reported, closing a gap a fresh review found: the previous single `.map()` let one malformed
 * scenario file's `JSON.parse` throw propagate all the way to `main()`'s global catch (a stack
 * trace + exit 2), aborting validation of every other file, including ones that would have parsed
 * and validated cleanly. `parseError` entries are excluded from `findDuplicateScenarioIds`'s input
 * (no `scenario.id` exists to compare) and from the later per-entry validation (nothing to
 * validate).
 * @returns {{ok: boolean, results: Array<{file: string, ok: boolean, message: string}>}}
 */
function validateLoadedScenarios(loaded) {
  const duplicateIdErrors = findDuplicateScenarioIds(
    loaded.filter((l) => !l.parseError).map(({ file, scenario }) => ({ id: scenario?.id, file })),
  );
  let ok = true;
  const results = [];
  for (const entry of loaded) {
    const { file } = entry;
    if (entry.parseError) {
      results.push({ file, ok: false, message: `${file}: invalid JSON -- ${entry.parseError}` });
      ok = false;
      continue;
    }
    const { scenario } = entry;
    const { errors } = validateScenario(scenario);
    const filenameError = checkScenarioFilenameMatchesId(scenario, file);
    if (filenameError) errors.push(filenameError);
    for (const dupError of duplicateIdErrors) {
      if (dupError.file === file) errors.push(dupError);
    }
    if (errors.length > 0) {
      results.push({ file, ok: false, message: `${file}: ${JSON.stringify(errors)}` });
      ok = false;
    } else {
      results.push({ file, ok: true, message: `${file}: OK` });
    }
  }
  return { ok, results };
}

/** `scope init --out <path>` -- creates a new, local, secret measurement-scope file (see
 * measurement-scope.mjs's own header for the full file contract and privacy rationale). Prints
 * only {scope_id, path} on success -- never hmac_key_base64. Mirrors cmdCorpusValidate's
 * simplicity as the other nested-subcommand handler in this file. */
function cmdScopeInit(args) {
  const outPath = args.out;
  if (!outPath) {
    console.error('scope init requires --out <path>');
    return 1;
  }
  try {
    const { scopeId } = createMeasurementScopeFileExclusive(outPath);
    console.log(JSON.stringify({ scope_id: scopeId, path: outPath }, null, 2));
    return 0;
  } catch (err) {
    console.error(`scope init failed: ${err.message}`);
    return 1;
  }
}

function cmdCorpusValidate() {
  const corpusDir = join(__dirname, 'corpus');
  const scenariosDir = join(corpusDir, 'scenarios');
  let ok = true;
  if (existsSync(scenariosDir)) {
    const scenarioFiles = readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
    const loaded = scenarioFiles.map((file) => loadScenarioFile(scenariosDir, file));
    const scenarioResult = validateLoadedScenarios(loaded);
    for (const { ok: entryOk, message } of scenarioResult.results) {
      if (entryOk) console.log(message); else console.error(message);
    }
    ok = scenarioResult.ok;
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

/**
 * cmdAggregate reads only TOP-LEVEL *.json files (readdirSync is non-recursive by default, so a
 * nested audit/ sidecar directory is never descended into or mistaken for a run record).
 *
 * A review finding demonstrated that aggregateRuns() alone is not enough: it only ever runs
 * validateRun() (schemas.mjs), a purely OBJECT-SHAPE check of accepted_audit (schema/relative_path
 * regex/sha256 hex format) -- never a verification that the sidecar FILE a schema-v5 scenario
 * record claims actually exists, hashes correctly, or agrees with the record's own content. A
 * record with a fabricated (well-formed but fictitious) accepted_audit previously aggregated
 * cleanly with zero errors. Every file is now offline-validated via validateRunRecordFile (record
 * schema + on-disk sidecar, for schema-v5 scenario records) BEFORE anything reaches aggregateRuns
 * -- a file that fails is excluded and reported by run_id, exactly like aggregateRuns' own
 * schema-invalid exclusions, so the two error shapes merge into one consistent list. aggregateRuns
 * itself is untouched: schemas 1-4 (and schema-5 non-scenario records) behave exactly as before.
 */
function cmdAggregate(args) {
  const runsDir = args['runs-dir'];
  if (!runsDir || !existsSync(runsDir)) {
    console.error('--runs-dir <dir> is required and must exist');
    return 1;
  }
  const preFilterErrors = [];
  const runs = [];
  for (const file of readdirSync(runsDir).filter((f) => f.endsWith('.json'))) {
    const runPath = join(runsDir, file);
    // validateRunRecordFile now fails closed and returns its own parsed `record` (null only on a
    // read/parse failure) -- reused directly below, never re-read/re-parsed a second time. A
    // malformed file's run_id is genuinely unresolvable (record is null), so it falls back to
    // '(unknown)', matching aggregateRuns' own fallback for the identical situation.
    const { record, errors: fileErrors } = validateRunRecordFile(runPath);
    if (fileErrors.length > 0) {
      preFilterErrors.push({ run_id: record?.run_id ?? '(unknown)', errors: fileErrors });
      continue;
    }
    runs.push(record);
  }
  const { groups, errors } = aggregateRuns(runs);
  console.log(JSON.stringify({ groups, errors: [...preFilterErrors, ...errors] }, null, 2));
  return (preFilterErrors.length > 0 || errors.length > 0) ? 1 : 0;
}

/**
 * Offline verification of one schema-v5 scenario record's own accepted-run-audit sidecar
 * (accepted-run-observability PR): resolves `accepted_audit.relative_path` relative to the run
 * record's OWN directory (never string-concatenated -- `relative_path` is already schema-guaranteed
 * safe by validateRun's own regex, below, but the resolved path is still containment-checked
 * before ever being read), requires the file to exist and parse, verifies its strict schema and
 * record coherence (validateAcceptedRunAuditSidecar + crossValidateAcceptedRunAuditAgainstRecord),
 * and SHA-256s the exact file text against the record's own declared digest. Never follows a
 * symlink whose resolved target escapes the run directory -- both the run directory and the
 * sidecar path are realpath-resolved and containment-checked first. Returns an array of
 * {field,message} errors (empty if everything checks out); never throws.
 */
function validateAcceptedAuditOnDisk(runPath, record) {
  const errors = [];
  const runDir = dirname(runPath);
  let runDirReal;
  try {
    runDirReal = realpath(runDir);
  } catch (err) {
    errors.push({ field: 'accepted_audit', message: `could not resolve the run record's own directory: ${err.message}` });
    return errors;
  }
  // relative_path is already schema-guaranteed (validateRun, schemas.mjs) to be exactly
  // "audit/<run_id>.json" in a closed, traversal/backslash/absolute-path-free charset -- joined via
  // path.join (platform-correct separators), never raw string concatenation.
  const sidecarPath = join(runDir, ...record.accepted_audit.relative_path.split('/'));
  if (!existsSync(sidecarPath)) {
    errors.push({ field: 'accepted_audit', message: `sidecar file does not exist: ${record.accepted_audit.relative_path}` });
    return errors;
  }
  let sidecarPathReal;
  try {
    sidecarPathReal = realpath(sidecarPath);
  } catch (err) {
    errors.push({ field: 'accepted_audit', message: `could not resolve the sidecar path: ${err.message}` });
    return errors;
  }
  const relFromRunDir = relative(runDirReal, sidecarPathReal);
  if (relFromRunDir.startsWith('..') || isAbsolute(relFromRunDir)) {
    errors.push({ field: 'accepted_audit', message: 'sidecar path resolves outside the run record\'s own directory -- refusing to follow (symlink escape?)' });
    return errors;
  }
  let sidecarText;
  try {
    sidecarText = readFileSync(sidecarPathReal, 'utf8');
  } catch (err) {
    errors.push({ field: 'accepted_audit', message: `could not read the sidecar file: ${err.message}` });
    return errors;
  }
  let sidecarObj;
  try {
    sidecarObj = JSON.parse(sidecarText);
  } catch (err) {
    errors.push({ field: 'accepted_audit', message: `sidecar file is not valid JSON: ${err.message}` });
    return errors;
  }
  const { errors: shapeErrors } = validateAcceptedRunAuditSidecar(sidecarObj);
  errors.push(...shapeErrors.map((e) => ({ field: `accepted_audit.sidecar.${e.field}`, message: e.message })));
  // Cross-validation is skipped once the sidecar's own shape is already invalid (review finding
  // 5) -- a null/scalar/array sidecar root (valid JSON, but not a real sidecar object) is caught
  // above by shapeErrors alone; comparing it field-by-field against the record adds nothing but
  // noisy "undefined does not match ..." entries, and crossValidateAcceptedRunAuditAgainstRecord's
  // own defensive guard (never throws even if called directly) is a second, independent layer,
  // not a substitute for this one.
  if (shapeErrors.length === 0) {
    const crossErrors = crossValidateAcceptedRunAuditAgainstRecord(sidecarObj, record);
    errors.push(...crossErrors.map((e) => ({ field: `accepted_audit.cross.${e.field}`, message: e.message })));
  }
  const actualSha256 = createHash('sha256').update(sidecarText, 'utf8').digest('hex');
  if (actualSha256 !== record.accepted_audit.sha256) {
    errors.push({ field: 'accepted_audit.sha256', message: `sidecar file's actual SHA-256 (${actualSha256}) does not match the record's declared accepted_audit.sha256 (${record.accepted_audit.sha256})` });
  }
  return errors;
}

/**
 * Validates one run record file at `runPath` -- schemas 1-4 (and a schema-5 non-scenario record)
 * get exactly the pre-existing record-only behavior; a schema-5 scenario record ADDITIONALLY gets
 * its own accepted-run-audit sidecar verified offline (see validateAcceptedAuditOnDisk), only once
 * the record itself already validates cleanly (a structurally invalid record has no reliable
 * accepted_audit.relative_path/sha256 to resolve in the first place). Extracted as its own,
 * directly-testable function so cmdValidate itself stays a thin CLI wrapper (print + exit code),
 * matching this file's own cmdCorpusValidate/validateLoadedScenarios precedent.
 *
 * Fails CLOSED, never throws (a review finding demonstrated the previous unguarded
 * readFileSync+JSON.parse propagated a raw SyntaxError uncaught through cmdValidate and, more
 * seriously, through cmdAggregate -- aborting an entire multi-file batch over one malformed file
 * instead of excluding just that file). `record` is `null` only on a read/parse failure; a
 * record that parses but fails schema validation still returns the real parsed object, unchanged
 * from before. The read/parse failure message never includes the file's own path or content --
 * `err.code` (e.g. 'ENOENT') for a read failure, a fixed generic string for a parse failure
 * (JSON.parse's own error message embeds a snippet of the malformed text itself, so it is never
 * interpolated here).
 * @returns {{record: object|null, errors: Array<{field:string,message:string}>, warnings: Array}}
 */
function validateRunRecordFile(runPath) {
  let text;
  try {
    text = readFileSync(runPath, 'utf8');
  } catch (err) {
    return { record: null, errors: [{ field: '(root)', message: `the run file could not be read (${err.code ?? 'unknown error'})` }], warnings: [] };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { record: null, errors: [{ field: '(root)', message: 'the run file is not valid JSON' }], warnings: [] };
  }
  const { errors, warnings } = validateRun(record);
  if (errors.length === 0 && record.schema >= 5 && record.run_kind === 'scenario') {
    errors.push(...validateAcceptedAuditOnDisk(runPath, record));
  }
  return { record, errors, warnings };
}

function cmdValidate(args) {
  const runPath = args.run;
  if (!runPath || !existsSync(runPath)) {
    console.error('--run <path> is required and must exist');
    return 1;
  }
  const { errors, warnings } = validateRunRecordFile(runPath);
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
    case 'scope': return args._[1] === 'init' ? cmdScopeInit(args) : (process.stderr.write('usage: scope init --out <path>\n'), 1);
    case 'aggregate': return cmdAggregate(args);
    case 'validate': return cmdValidate(args);
    case 'smoke': return cmdSmoke(args);
    case 'run': return cmdRun(args);
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

export { parseArgs, BOOLEAN_FLAGS, validateSubcommandArgs, validatePrivatePatternsFileOrFail, resolveMeasurementScopeOrFail, cmdCorpusValidate, cmdScopeInit, cmdAggregate, cmdValidate, validateRunRecordFile, cmdCalibrate, cmdSmoke, cmdRun, buildRunRecord, nullableMetric, runConditionPair, finalizeAndWriteRecords, finalizeAndWriteMatrixRecords, writeRunRecordEvidence, writeRunMatrixRecordEvidence, findMatrixCompletenessGap, calibrationHardGate, smokeHardGate, scenarioCellIntegrityOk, scenarioHardGate, realizedStartCounts, scenarioMatrixIsBenchmarkEligible, verifyExactCommandsSucceeded, resolveHarnessProvenance, findBlockingHarnessToolingDirty, isRunsRootDefault, isPluginBoundToSnapshot, checkScenarioFilenameMatchesId, findDuplicateScenarioIds, loadScenarioFile, validateLoadedScenarios, loadScenarioById, verifySourceRepoForScenario, buildScenarioRunPlan, normalizeGitRemoteForComparison, SMOKE_EXPECTED_COMMANDS, SUBCOMMAND_SHAPES, PINNED_SKILL_SHA };
