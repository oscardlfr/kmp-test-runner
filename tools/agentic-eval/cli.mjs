#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/cli.mjs -- entrypoint for the reproducible skill evaluation harness.
//
// Usage:
//   node tools/agentic-eval/cli.mjs calibrate [--runtime <id>] [--model <name>]
//                                              [--execution-profile <id>]
//                                              [--private-patterns-file <path>]
//   node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
//                                          [--project-alias <alias>] [--runtime <id>]
//                                          [--model <name>] [--execution-profile <id>]
//                                          [--private-patterns-file <path>]
//   node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n>
//                                        [--repeats <n>] [--runtime <id>] [--model <name>]
//                                        [--execution-profile <id>] [--dry-run]
//                                        [--private-patterns-file <path>]
//   node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n>
//                                        --campaign-design <id>
//                                        --isolation-attestation-file <path> [--dry-run]
//   node tools/agentic-eval/cli.mjs corpus validate
//   node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
//   node tools/agentic-eval/cli.mjs analyze --runs-dir <dir>
//   node tools/agentic-eval/cli.mjs validate --run <path-to-run.json>
//   node tools/agentic-eval/cli.mjs product-access preflight
//                                        --mode free-baseline-no-product
//                                        --workspace <source-only-workspace>
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
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { LATEST_RUN_SCHEMA, SUPPORTED_RUN_SCHEMAS, validateRun, validateScenario, validateTriggerQueries } from './schemas.mjs';
import { materializeCalibrationProject, materializeScenarioProject, removeScenarioWorktree, realpath } from './materialize.mjs';
import { msSinceOrigin, fingerprintNames, canonicalNamesKey, selectShellAttempts } from './runtimes/contract.mjs';
import { acquireSharedEvalResources, runSingleCondition, runScenarioMatrix, runScenarioCampaign, reportCleanupFailures } from './matrix-runner.mjs';
import { buildBashDispatchAccounting } from './dispatch-accounting.mjs';
// resolveSelection is the ONLY way this file ever learns which runtime adapter to use --
// cli.mjs never imports runtimes/claude-code.mjs directly (registries.mjs is the sole allowed
// importer of that module; see agentic-eval-runtime-boundary.test.js).
import { resolveSelection, loadRegistries } from './registries.mjs';
import { loadIsolationAttestation } from './execution-profiles/isolation-attestation.mjs';
import { resolveScenarioCampaignDesign, buildScenarioCampaignPlan } from './scenario-campaign-plan.mjs';
// Static treatment-size artifacts (schema v6's skill_observation.treatment_size) -- computed
// entirely offline, once per command (prompt) / once per invocation before the first session
// (skill snapshot). See input-artifacts.mjs's own header for why this is measured from Git
// objects, never checkout bytes, and why it is never a second notion of "the skill" beyond what
// materializeSkillSnapshot already delivers.
import { computePromptArtifact } from './input-artifacts.mjs';
import { cellTranscriptIntegrityOk, summarizeUnexpectedToolUses, evaluateNamedChecks, summarizePreInferenceFailure } from './cell-integrity.mjs';
import { gradeScenarioCondition } from './graders.mjs';
import { buildRunMatrix, buildConditionOrders } from './randomizer.mjs';
import { aggregateRuns } from './aggregate.mjs';
import { assertCleanOrThrow, assertCleanOrThrowObject, loadPrivateRules } from './privacy.mjs';
import { tokenize } from './policy-hook.mjs';
import { runValidator as runPluginValidator } from '../validate-plugin.mjs';
import { RUNS_ROOT, resolveEvidenceOutDir, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { buildRejectionDiagnostics, writeRejectionRawTranscripts, writeRejectedRunDiagnostics, deriveTranscriptFilename, writeRejectionRawStderr, deriveStderrFilename, readRejectionStderrFile } from './rejection-diagnostics.mjs';
import { acceptedAuditRelativePathFor, buildAcceptedRunAuditSidecar, finalizeAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord, expectedAcceptedAuditSchemaFor } from './accepted-run-audit.mjs';
import { loadMeasurementScopeFile, createMeasurementScopeFileExclusive } from './measurement-scope.mjs';
import { createInvocationJournal, tagIncidentPhase } from './durable-journal.mjs';
import { productAccessModeForSkillCondition, isProductAccessModeCompatibleWithSkillCondition } from './product-access.mjs';
import { finalizeIncident, reportIncident } from './incident-diagnostics.mjs';
// validateRunRecordFile now lives in run-record-loader.mjs (extracted so analysis.mjs can import
// the identical trusted-input gate without a circular cli.mjs<->analysis.mjs dependency, and so it
// can return the already-parsed sidecar object instead of a second caller re-reading the same file
// -- see that module's own header). Re-exported below for every existing caller (cmdValidate,
// cmdAggregate, and this file's own tests) unchanged.
import { validateRunRecordFile } from './run-record-loader.mjs';
import { analyzeRunsDir } from './analysis.mjs';
import { evaluateProductAccessPreflight } from './product-access-preflight.mjs';

// dirname(fileURLToPath(...)), not import.meta.dirname -- the latter needs Node 20.11+/21.2+,
// but package.json declares "node": ">=18" (confirmed to actually matter on a real ubuntu-latest
// CI job -- see condition-launcher.mjs's identical fix for the full story).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const PINNED_SKILL_SHA = '2112aed96686ee159f851e00c2efa553e58473fc';
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

// isPluginBoundToSnapshot moved to runtimes/claude-code.mjs (a genuinely Claude-specific fact --
// see that module's own doc comment) -- this file no longer imports or re-exports it at all; the
// observation contract already carries its result as skill.snapshotBindingMatches.

const HELP = `tools/agentic-eval/cli.mjs -- reproducible skill evaluation harness

Usage:
  node tools/agentic-eval/cli.mjs calibrate [--runtime <id>] [--model <name>]
                                              [--execution-profile <id>]
                                              [--max-budget-usd <usd>]
                                              [--private-patterns-file <path>]
                                              [--measurement-scope-file <path>]
  node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
                                          [--project-alias <alias>] [--runtime <id>]
                                          [--model <name>] [--execution-profile <id>]
                                          [--max-budget-usd <usd>]
                                          [--private-patterns-file <path>]
                                          [--measurement-scope-file <path>]
  node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n>
                                        [--repeats <n>] [--runtime <id>] [--model <name>]
                                        [--execution-profile <id>] [--max-budget-usd <usd>] [--dry-run]
                                        [--private-patterns-file <path>]
                                        [--measurement-scope-file <path>]
  node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n>
                                        --campaign-design <id>
                                        --isolation-attestation-file <path> [--dry-run]
                                        [--runtime <id>] [--model <name>] [--max-budget-usd <usd>]
                                        [--private-patterns-file <path>]
                                        [--measurement-scope-file <path>]
  node tools/agentic-eval/cli.mjs scope init --out <path>
  node tools/agentic-eval/cli.mjs corpus validate
  node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
  node tools/agentic-eval/cli.mjs analyze --runs-dir <dir>
  node tools/agentic-eval/cli.mjs validate --run <path>
  node tools/agentic-eval/cli.mjs product-access preflight
                                        --mode free-baseline-no-product
                                        --workspace <source-only-workspace>
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

--max-budget-usd <usd> is passed directly to Claude Code's per-session --max-budget-usd flag
(default: 0.60, max: 5.00). It is validated before any live session is spawned; dry-run output
prints the resolved value so operator authorization can bind to the actual runtime budget.

run --campaign-design <id> expands one scenario into a closed, pre-registered multi-profile
campaign plan in one invocation. Supported ids: claude-2x2-williams-v1 (policy profile x skill
condition, 16 sessions) and claude-product-vs-free-baseline-v1 (product-assisted vs true
free-baseline/no-product, 8 sessions). Mutually exclusive with --execution-profile/--repeats (the
design resolves its own profiles and fixes its own repeat count). Requires
--isolation-attestation-file <path> whenever the design includes sandboxed-unrestricted-v1 cells;
see tools/agentic-eval/scenario-campaign-plan.mjs and README.md's "Multi-profile campaigns"
section.

analyze reads ONLY already-committed schema-v5 scenario run records + their validated accepted-
run-audit sidecars under --runs-dir (never a raw transcript, never a live Claude call) and emits a
deterministic per-run + summary breakdown across 5 separated axes (activation, post-invocation
execution, policy interaction, authoritative evidence, final outcome) plus one closed-vocabulary
failure_class per run -- see tools/agentic-eval/analysis.mjs and README.md's "Axis-separated
analysis" section.

product-access preflight is an offline, privacy-safe gate for future true free-baseline/no-product
controls. It checks local process/workspace exposure (product markers in the workspace, kmp-test
executables on PATH, product-specific env vars) and prints counts/statuses, never raw paths or
credential values. It does not launch Claude and does not prove an agent lacks latent knowledge;
it proves the local baseline surface is not product-visible.
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
  calibrate: { flags: ['runtime', 'model', 'execution-profile', 'max-budget-usd', 'isolation-attestation-file', 'private-patterns-file', 'measurement-scope-file'], extraPositionals: 0 },
  smoke: { flags: ['runtime', 'model', 'execution-profile', 'max-budget-usd', 'isolation-attestation-file', 'source-repo-dir', 'pinned-commit', 'project-alias', 'private-patterns-file', 'measurement-scope-file'], extraPositionals: 0 },
  run: { flags: ['scenario', 'source-repo-dir', 'seed', 'repeats', 'runtime', 'model', 'execution-profile', 'campaign-design', 'isolation-attestation-file', 'max-budget-usd', 'dry-run', 'private-patterns-file', 'measurement-scope-file'], extraPositionals: 0 },
  corpus: { flags: [], extraPositionals: 1 }, // corpus <validate>
  aggregate: { flags: ['runs-dir'], extraPositionals: 0 },
  analyze: { flags: ['runs-dir'], extraPositionals: 0 },
  validate: { flags: ['run'], extraPositionals: 0 },
  scope: { flags: ['out'], extraPositionals: 1 }, // scope <init>
  'product-access': { flags: ['mode', 'workspace'], extraPositionals: 1 }, // product-access <preflight>
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

const DEFAULT_MAX_BUDGET_USD = 0.60;
const MAX_MAX_BUDGET_USD = 5.00;

/** Resolves Claude Code's per-session --max-budget-usd before any spawn. The default preserves
 * the historical launcher argv exactly; a supplied value is intentionally bounded so a typo cannot
 * silently authorize an order-of-magnitude spend across a multi-cell campaign. */
function resolveMaxBudgetUsdOrFail(rawValue) {
  if (rawValue == null) {
    return { ok: true, maxBudgetUsd: DEFAULT_MAX_BUDGET_USD, source: 'default' };
  }
  const raw = String(rawValue).trim();
  if (!/^(?:[1-9]\d*|0?\.\d+|[1-9]\d*\.\d+)$/.test(raw)) {
    return { ok: false, reason: `--max-budget-usd must be a positive decimal dollar value, got: ${rawValue}` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, reason: `--max-budget-usd must be a positive decimal dollar value, got: ${rawValue}` };
  }
  if (value > MAX_MAX_BUDGET_USD) {
    return { ok: false, reason: `--max-budget-usd ${raw} exceeds the maximum of ${MAX_MAX_BUDGET_USD.toFixed(2)}; split the run or make a separately reviewed budget change if this is intentional` };
  }
  return { ok: true, maxBudgetUsd: value, source: 'supplied' };
}

/** Resolves the (runtime, model, execution-profile) selection for calibrate/smoke/run -- the ONE
 * call site every one of those three commands makes, exactly once, before any operation that
 * could spend a session (mirrors validatePrivatePatternsFileOrFail's own shape: never throws,
 * `{ok:false, reason}` on any unknown/disabled/incompatible id). Omitted flags (parseArgs never
 * sets a key it didn't see, so `args.runtime`/`args.model`/`args['execution-profile']` are
 * `undefined` when not supplied) resolve to registries.mjs's own documented defaults -- never a
 * second, CLI-local default. */
function resolveSelectionOrFail(args) {
  return resolveSelection({
    runtimeId: args.runtime ?? null,
    modelId: args.model ?? null,
    executionProfileId: args['execution-profile'] ?? null,
  });
}

/**
 * Resolves (or rejects) the isolation attestation for the already-resolved (runtime, executionProfile)
 * selection, per the `--isolation-attestation-file <path>` CLI flag -- the ONE call site
 * calibrate/smoke/run each make, exactly once, after resolveSelectionOrFail/
 * validatePrivatePatternsFileOrFail/resolveMeasurementScopeOrFail and before any journal/
 * materialization/auth/spawn (the runbook's own mandated ordering). Fail-closed BOTH directions:
 * - executionProfile.isolation_attestation_required:true with no flag, or an invalid/mismatched/
 *   expired attestation file, fails.
 * - executionProfile.isolation_attestation_required:false (strict-policy-v1 today) with the flag
 *   PRESENT also fails -- never silently ignored ("en strict, un flag presente es error").
 * Returns `{ok:true, sha256: string|null}` (null iff attestation does not apply to this profile) or
 * `{ok:false, reason}` -- never throws, mirrors resolveSelectionOrFail/
 * validatePrivatePatternsFileOrFail's own shape. The attestation file's own PATH is read from args
 * here and passed to loadIsolationAttestation, but never appears in the returned reason string on
 * failure (loadIsolationAttestation's own contract already guarantees this for ITS failures; this
 * function's own two ordering-check messages below name only the flag/profile id, never a path).
 */
function resolveIsolationAttestationOrFail(args, { runtime, executionProfile }) {
  const filePath = args['isolation-attestation-file'] ?? null;
  if (executionProfile.isolation_attestation_required !== true) {
    if (filePath != null) {
      return { ok: false, reason: `--isolation-attestation-file is not accepted for execution profile "${executionProfile.id}" (isolation_attestation_required:false)` };
    }
    return { ok: true, sha256: null };
  }
  if (filePath == null) {
    return { ok: false, reason: `--isolation-attestation-file <path> is required for execution profile "${executionProfile.id}" (isolation_attestation_required:true)` };
  }
  const provenance = resolveHarnessProvenance();
  if (provenance.repoCommit == null) {
    return { ok: false, reason: 'cannot resolve harness_sha for isolation attestation (git rev-parse HEAD failed) -- refusing to proceed without a real binding' };
  }
  const result = loadIsolationAttestation(filePath, {
    profileId: executionProfile.id,
    runtimeId: runtime.runtime_id,
    platform: resolvePlatform(),
    networkMode: executionProfile.network_mode,
    harnessSha: provenance.repoCommit,
  });
  if (!result.ok) {
    return { ok: false, reason: `isolation attestation invalid: ${result.reason}` };
  }
  return { ok: true, sha256: result.sha256 };
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
// Named (not inlined at the runConditionPair call site) so cmdCalibrate's/cmdSmoke's own
// promptArtifact computations (schema v6's skill_observation.treatment_size.prompt_*) read the
// byte-identical text the real session is launched with -- never a second, independently-typed-out
// copy.
const CALIBRATE_PROMPT = 'Use the kmp-test-runner skill to check this project.';
const SMOKE_PROMPT = "Run `kmp-test doctor --json` in this project directory, then run `kmp-test describe --json`. Based only on their output, tell me whether the test setup looks healthy. Do not run any other commands or tools.";
const SMOKE_EXPECTED_COMMANDS = [
  ['kmp-test', 'doctor', '--json'],
  ['kmp-test', 'describe', '--json'],
];

// EXPECTED_TOOL_NAMES moved to runtimes/claude-code.mjs -- a genuinely Claude-specific fact (the
// exact --tools value this harness launches `claude` with). This file no longer imports it at all;
// the observation contract already carries its result as session.toolProfileMatchesExpected and
// toolAttempts[].profileAllowed.

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

/**
 * Pure read-back of a spawned condition's journal-persisted raw transcript, keyed STRICTLY by
 * conditionResult.cellOrdinal -- never array position, never an assumed A/B convention (the
 * journal's own ordinal assignment, 0=B/current-skill then 1=A/no-skill for a pair, does not
 * match this codebase's historical recordA/recordB parameter ordering; conflating the two would
 * silently swap two live sessions' transcripts). Fail-closed: a cell that genuinely spawned but
 * has no journal-persisted raw is a wiring bug, not something to silently paper over. Never
 * mutates `conditionResult` -- the observation contract carries no raw/legacy fields (no
 * `spawnResult` to overwrite), so the ONLY source of raw transcript text, anywhere downstream, is
 * this read. Callers (cmdCalibrate/cmdSmoke/cmdRun) use this to build the `transcriptsByRunId` map
 * finalizeAndWriteRecords/finalizeAndWriteMatrixRecords require as an explicit parameter -- see
 * those functions' own doc comments.
 * @returns {string|null} the raw transcript text, or null if journal/conditionResult is absent or
 *   the cell never spawned (nothing to read).
 */
function readJournalRawFor(conditionResult, journal) {
  if (!journal || !conditionResult || !conditionResult.didSpawn) return null;
  const raw = journal.readRawFor(conditionResult.cellOrdinal);
  if (raw == null) {
    throw new Error(`journal read-back: no raw persisted for cellOrdinal ${conditionResult.cellOrdinal}, but this cell spawned -- refusing to promote unverified content`);
  }
  return raw;
}

/**
 * §6's exact-correspondence check: a hard-gate rejection's own two-transaction forensics
 * (writeRejectionForensics) must have PROVABLY persisted the exact same set of cells the journal
 * itself captured -- same cardinality, same IDENTITIES, each bound to its TRUE ordinal -- before
 * the journal (now redundant) is discarded. `rawTranscriptsPersisted:true` alone only proves the
 * write attempt didn't throw, not that every cell landed with the identity the diagnostic claims.
 *
 * Post-Codex-audit fix (PR #418, round 3): the round-2 version of this check compared the run_id
 * set and the capture_ordinal set INDEPENDENTLY -- confirmed by direct reproduction, swapping two
 * run_ids' ordinals (run-a claiming journal ordinal 1, run-b claiming ordinal 0, each with its own
 * internally-self-consistent filename) still passed, because every individual check (run_id is
 * real, ordinal is real, filename matches its OWN declared pair) held even though the PAIRING was
 * wrong. `runIdToCellOrdinal` (the caller's own authoritative binding -- e.g. `{[r.run_id]:
 * conditionResults[i].cellOrdinal}`, never array position, never a hardcoded 0/1 convention) is now
 * REQUIRED: every manifest entry's (run_id, capture_ordinal) PAIR must match this binding exactly,
 * not just each half independently. A reordered manifest array must still pass (the binding is a
 * map, not positional); a swapped pairing must fail.
 */
function journalRawExactlyMatchesRejectionManifest(journal, result, runIdToCellOrdinal) {
  if (!journal || result.rawTranscriptsPersisted !== true || result.diagnosticsWriteError) return false;
  const manifest = result.rawTranscriptsManifest;
  if (!Array.isArray(manifest) || manifest.length === 0) return false;
  const binding = runIdToCellOrdinal ?? {};
  const expectedRunIds = Object.keys(binding);
  const journalOrdinals = new Set(journal.summarize().cellOrdinals.raw_persisted);
  if (manifest.length !== journalOrdinals.size || manifest.length !== expectedRunIds.length) return false;

  const seenOrdinals = new Set();
  const seenRunIds = new Set();
  for (const entry of manifest) {
    if (entry == null || typeof entry.run_id !== 'string' || !Number.isInteger(entry.capture_ordinal)) return false;
    if (!Object.prototype.hasOwnProperty.call(binding, entry.run_id)) return false; // fabricated/unknown run_id
    if (binding[entry.run_id] !== entry.capture_ordinal) return false; // THE identity check: must match the TRUE pairing, not just independent membership
    if (!journalOrdinals.has(entry.capture_ordinal)) return false; // ordinal the journal never captured
    if (seenOrdinals.has(entry.capture_ordinal) || seenRunIds.has(entry.run_id)) return false; // duplicate
    let expectedFilename;
    try {
      expectedFilename = deriveTranscriptFilename(entry.capture_ordinal, entry.run_id);
    } catch {
      return false;
    }
    if (entry.filename !== expectedFilename) return false; // fabricated/inconsistent filename
    seenOrdinals.add(entry.capture_ordinal);
    seenRunIds.add(entry.run_id);
  }
  return seenOrdinals.size === journalOrdinals.size && seenRunIds.size === expectedRunIds.length;
}

/**
 * Defense against the CAUSE (a cell whose stderr never persisted) -- given persistSpawnOutcome's
 * own fail-fast (durable-journal.mjs), a cell like that should never be able to reach here at all,
 * since it aborts the whole invocation as an incident at the point of failure. Kept as a cheap
 * invariant check that would catch a future regression bypassing that fail-fast, not as the
 * primary mechanism. Defense against the EFFECT (a file that persisted successfully but was
 * deleted/truncated SINCE) is the real job here: unlike the rejection path below (which compares
 * journal vs. a second, independent copy), the acceptance path has no second copy to compare
 * against -- rereading each cell's stderr from disk now and comparing it against its own
 * previously-recorded metadata is the only way this branch can detect that before an irreversible
 * discard.
 */
function allExecutedCellsStderrHealthy(journal) {
  if (!journal) return true;
  const { cellOrdinals, stderrMeta } = journal.summarize();
  for (const ordinal of cellOrdinals.raw_persisted) {
    const meta = stderrMeta[ordinal];
    if (!meta || meta.present !== true || meta.writeError) return false;
    let onDisk;
    try {
      onDisk = journal.readStderrFor(ordinal);
    } catch {
      return false;
    }
    if (onDisk == null) return false;
    const onDiskByteLength = Buffer.byteLength(onDisk, 'utf8');
    const onDiskSha256 = createHash('sha256').update(onDisk, 'utf8').digest('hex');
    if (onDiskByteLength !== meta.byteLength || onDiskSha256 !== meta.sha256) return false;
  }
  return true;
}

/**
 * The stderr-tier sibling of journalRawExactlyMatchesRejectionManifest -- same binding/cardinality
 * discipline, PLUS content verification neither that function nor the original design of this one
 * had: comparing byteLength/sha256 already computed by each SIDE's own write (in-memory-adjacent
 * metadata) never proves what is REALLY on disk right now. This function rereads and rehashes BOTH
 * copies -- the journal's own file (`journal.readStderrFor`) and the rejection tier's own file
 * (`readRejectionStderrFile`, injected so a test can point it at an isolated runsRootOverride) --
 * at the moment of the discard decision, and requires all four sources (journal-on-disk,
 * rejection-tier-on-disk, the journal's own recorded metadata, and the manifest's own declared
 * values) to agree. `readRejectionStderrFile` ALWAYS derives its own filename internally from
 * (capture_ordinal, run_id) -- `entry.filename` is only ever used for the post-hoc equality check
 * below, never to construct a read path.
 */
function journalStderrExactlyMatchesRejectionManifest(journal, result, runIdToCellOrdinal, { readRejectionStderrFile: readStderr } = {}) {
  if (!journal || result.stderrWriteError || result.stderrManifest == null) return false;
  const manifest = result.stderrManifest;
  const binding = runIdToCellOrdinal ?? {};
  const expectedRunIds = Object.keys(binding);
  const { stderrMeta, cellOrdinals } = journal.summarize();
  const journalOrdinals = new Set(cellOrdinals.raw_persisted);
  if (manifest.length === 0 || manifest.length !== journalOrdinals.size || manifest.length !== expectedRunIds.length) return false;

  const seenOrdinals = new Set();
  const seenRunIds = new Set();
  for (const entry of manifest) {
    if (entry == null || typeof entry.run_id !== 'string' || !Number.isInteger(entry.capture_ordinal)) return false;
    if (!Object.prototype.hasOwnProperty.call(binding, entry.run_id)) return false;
    if (binding[entry.run_id] !== entry.capture_ordinal) return false;
    if (!journalOrdinals.has(entry.capture_ordinal)) return false;
    if (seenOrdinals.has(entry.capture_ordinal) || seenRunIds.has(entry.run_id)) return false;
    const meta = stderrMeta[entry.capture_ordinal];
    if (!meta || meta.present !== true || meta.writeError) return false;

    let journalOnDisk;
    try {
      journalOnDisk = journal.readStderrFor(entry.capture_ordinal);
    } catch {
      return false;
    }
    if (journalOnDisk == null) return false;
    const journalOnDiskSha256 = createHash('sha256').update(journalOnDisk, 'utf8').digest('hex');
    const journalOnDiskByteLength = Buffer.byteLength(journalOnDisk, 'utf8');

    let rejectionOnDisk;
    try {
      rejectionOnDisk = readStderr(entry.capture_ordinal, entry.run_id);
    } catch {
      return false;
    }
    if (rejectionOnDisk == null) return false;
    const rejectionOnDiskSha256 = createHash('sha256').update(rejectionOnDisk, 'utf8').digest('hex');
    const rejectionOnDiskByteLength = Buffer.byteLength(rejectionOnDisk, 'utf8');

    if (journalOnDiskSha256 !== rejectionOnDiskSha256 || journalOnDiskByteLength !== rejectionOnDiskByteLength) return false;
    if (meta.byteLength !== journalOnDiskByteLength || meta.sha256 !== journalOnDiskSha256) return false;
    if (entry.byte_length !== journalOnDiskByteLength || entry.sha256 !== journalOnDiskSha256) return false;

    let expectedFilename;
    try {
      expectedFilename = deriveStderrFilename(entry.capture_ordinal, entry.run_id);
    } catch {
      return false;
    }
    if (entry.filename !== expectedFilename) return false;
    seenOrdinals.add(entry.capture_ordinal);
    seenRunIds.add(entry.run_id);
  }
  return seenOrdinals.size === journalOrdinals.size && seenRunIds.size === expectedRunIds.length;
}

/**
 * The shared "what does the command do once finalizeAndWrite* has settled" tail: on full
 * acceptance, or a hard-gate rejection whose own forensics fully, verifiably persisted, the
 * journal is now redundant -- adopt/discard it. In every other outcome, do nothing: the journal's
 * continued presence on disk IS the preservation. `runIdToCellOrdinal` is the caller's own real,
 * authoritative run_id-to-cellOrdinal binding for this invocation, threaded through to the
 * exact-correspondence identity check above -- required whenever a rejection might legitimately
 * qualify for discard (harmless/unused on the acceptance path, where result.ok===true
 * short-circuits before it's ever read). A discard failure itself is a reportCleanupFailures-style
 * warning only, never surfaced as a command failure -- by the time this runs, the real evidence is
 * already safely elsewhere.
 *
 * `allExecutedCellsStderrHealthy` gates BOTH branches unconditionally, evaluated before either --
 * `result.ok === true` must never skip it: a stderr persistence/redaction/validation failure keeps
 * the journal even when the matrix/pair's functional outcome was a full acceptance.
 */
function discardJournalIfRedundant(journal, result, runIdToCellOrdinal, runsRootOverride) {
  if (!journal) return;
  if (!allExecutedCellsStderrHealthy(journal)) return;
  const shouldDiscard = result.ok === true
    || (journalRawExactlyMatchesRejectionManifest(journal, result, runIdToCellOrdinal)
        && journalStderrExactlyMatchesRejectionManifest(journal, result, runIdToCellOrdinal, {
          readRejectionStderrFile: (captureOrdinal, runId) => readRejectionStderrFile(result.rejectionId, captureOrdinal, runId, { runsRootOverride }),
        }));
  if (!shouldDiscard) return;
  const discardResult = journal.promoteAndDiscard();
  if (!discardResult.ok) {
    console.error(`WARNING: journal cleanup failed (${discardResult.warning}) -- the now-redundant journal directory may be left behind; this does not affect the already-promoted evidence.`);
  }
}

/** err.agenticEvalPhase, defaulting to 'finalizing_matrix' -- by construction, anything reaching
 * one of the top-level command catches without a more specific tag is past the per-cell-tagged
 * phases (materializing_cell/persisting_cell_journal/parsing_or_attributing_cell all tag
 * themselves at the point of the throw, deep inside matrix-runner.mjs/runConditionPair). */
function incidentPhaseOf(err) {
  return err?.agenticEvalPhase ?? 'finalizing_matrix';
}

/** Folds materializeScenarioProject's own err.rollbackError (a `git worktree add` failure whose
 * OWN rollback also failed) into the reported reason -- without this, that second, real cleanup
 * failure reached no diagnostic surface at all, contradicting this harness's own repeated "never
 * silently swallowed" contract. Both messages still pass through the same redaction pipeline as
 * every other reasonText (finalizeIncident's own job), so folding them here rather than in
 * materialize.mjs itself (which has no redaction concerns of its own) keeps that concern in one
 * place. */
function reasonTextFor(err) {
  return err?.rollbackError ? `${err.message} (rollback also failed: ${err.rollbackError.message})` : err?.message;
}

async function runConditionPair({
  prompt, model, allowedGradleTasks, allowedKmpTestSubcommands, materializeFixture, cleanupFixture,
  timeoutMs, journal = null, runtimeAdapter, executionProfile = null, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
}) {
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
    runtimeAdapter, executionProfile,
  });
  const { registerCleanup, runCleanup } = shared;
  // PR 4: matches matrix-runner.mjs's runScenarioMatrix identical policyMode derivation --
  // calibrate/smoke keep the pre-existing aggregate hookStats.everyCallHooked proof under
  // policyMode:"required" (Decision G: "el strict calibrate/smoke puede conservar su aggregate
  // hook proof para equivalencia"), and use the SAME canonical per-attempt dispatch accounting the
  // scenario path uses under "not_applicable" -- computed directly from each condition's own
  // toolAttempts (never via junit-evidence.mjs/attributeCondition, which calibrate/smoke never
  // enable at all: decisionByAttempt is not needed for this profile's classification, and
  // preDispatchBlockedAttemptIds is derivable directly from each attempt's own
  // preDispatchBlock.recognized, profile-independent).
  const policyMode = executionProfile != null && executionProfile.policy_mode === 'not_applicable' ? 'not_applicable' : 'required';

  try {
    // shared.runtimeAdapter is the RESOLVED instance (default or test-injected) --
    // acquireSharedEvalResources returns it specifically so this call site never needs to import
    // runtimes/claude-code.mjs itself (cli.mjs is a core consumer; only matrix-runner.mjs may).
    const baseArgv = shared.runtimeAdapter.buildInvocation({ prompt, model, settingsPath: shared.settingsPath, executionProfile, maxBudgetUsd });

    let fixtureDir;
    let fixtureCleanupQueued = false;
    const cleanupFixtureOnce = (dir) => {
      if (!fixtureCleanupQueued && cleanupFixture) {
        fixtureCleanupQueued = true;
        registerCleanup(() => cleanupFixture(dir));
      }
    };
    // cellOrdinal: 0=B (current-skill, spawned first), 1=A (no-skill, spawned second) --
    // matches the ACTUAL spawn order, not the historical A-before-B parameter/record ordering
    // this codebase's promotion functions use elsewhere. Never conflate the two -- see
    // buildRunRecord/finalizeAndWrite*'s own doc comments on why the journal read-back always
    // keys off conditionResult.cellOrdinal, never array position or an assumed A/B convention.
    const runOneCondition = async (condition, cellOrdinal) => {
      const conditionResult = await runSingleCondition({
        condition, materializeFixture, previousFixtureDir: fixtureDir, cleanupFixtureOnce,
        resetGradleToSnapshot: shared.resetGradleToSnapshot, kmpEvalTempHome: shared.kmpEvalTempHome,
        sharedEnv: shared.sharedEnv, baseArgv, snapshotDir: shared.snapshotDir,
        targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, timeoutMs,
        junitEvidenceEnabled: false, journal, cellOrdinal, runtimeAdapter: shared.runtimeAdapter,
        executionProfile,
      });
      fixtureDir = conditionResult.fixtureDir;
      if (policyMode === 'not_applicable') {
        const shellAttempts = selectShellAttempts(conditionResult.observation.toolAttempts).map((a) => ({
          id: a.id, command: a.command, index: a.eventIndex, resultFound: a.result.found, preDispatchBlock: a.preDispatchBlock,
        }));
        const preDispatchBlockedAttemptIds = new Set(
          shellAttempts.filter((b) => b.preDispatchBlock?.recognized === true).map((b) => b.id),
        );
        const dispatchAccounting = buildBashDispatchAccounting({
          bashResults: shellAttempts, hookStats: conditionResult.observation.hookStats,
          decisionByAttempt: new Map(), preDispatchBlockedAttemptIds, policyMode,
        });
        return { ...conditionResult, dispatchAccounting };
      }
      return conditionResult;
    };

    const runB = await runOneCondition('current-skill', 0);
    // Fail-fast (preserve rejected matrix forensics): the identical canonical check the final hard
    // gates use, evaluated on B alone BEFORE A is ever spawned. calibrationHardGate/smokeHardGate
    // always reject the WHOLE pair together -- a failing B can never be rescued by A -- so spawning
    // A anyway would spend a second live session on a pair that is already going to be rejected.
    let integrityB;
    try {
      integrityB = cellTranscriptIntegrityOk(runB, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: policyMode === 'not_applicable' });
    } catch (err) {
      // No raw-text 4th argument (unlike runSingleCondition's own persistSpawnOutcome-failure
      // catch): persistSpawnOutcome already succeeded for this cell by the time control returns
      // here, so raw custody has already moved to the journal.
      throw tagIncidentPhase(err, 'parsing_or_attributing_cell', 0);
    }
    if (journal && runB.didSpawn) {
      try {
        journal.recordEvaluated(0);
      } catch (err) {
        throw tagIncidentPhase(err, 'persisting_cell_journal', 0);
      }
    }
    if (!integrityB.ok) {
      return {
        runA: null, runB, snapshotDir: shared.snapshotDir, skillSnapshotArtifact: shared.skillSnapshotArtifact,
        daemonPolicy: shared.daemonPolicy,
        allowedGradleTasks, allowedKmpTestSubcommands, cleanup: runCleanup,
        plannedCellCount: 2, executedCellCount: 1, matrixComplete: false,
        failFastStop: {
          side: 'B', condition: 'current-skill', failedChecks: integrityB.failedChecks,
          reason: integrityB.reason, unexpectedToolUsesCount: integrityB.unexpectedToolUsesCount,
          unexpectedTools: integrityB.unexpectedTools,
        },
      };
    }
    const runA = await runOneCondition('no-skill', 1);
    // A has no equivalent early fail-fast check at this layer (nothing left to skip once A has
    // already run) -- its real integrity is evaluated downstream, as part of
    // calibrationHardGate/smokeHardGate inside finalizeAndWriteRecords. It's STILL evaluated here,
    // though (result unused for control flow -- never a second fail-fast), so `evaluated` means
    // the same thing -- "this cell's own local integrity has been evaluated" -- for every cell in
    // every command, not merely "control returned" for A specifically.
    try {
      cellTranscriptIntegrityOk(runA, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: policyMode === 'not_applicable' });
    } catch (err) {
      throw tagIncidentPhase(err, 'parsing_or_attributing_cell', 1);
    }
    if (journal && runA.didSpawn) {
      try {
        journal.recordEvaluated(1);
      } catch (err) {
        throw tagIncidentPhase(err, 'persisting_cell_journal', 1);
      }
    }

    return {
      runA, runB, snapshotDir: shared.snapshotDir, skillSnapshotArtifact: shared.skillSnapshotArtifact,
      daemonPolicy: shared.daemonPolicy,
      allowedGradleTasks, allowedKmpTestSubcommands, cleanup: runCleanup,
      plannedCellCount: 2, executedCellCount: 2, matrixComplete: true, failFastStop: null,
    };
  } catch (err) {
    reportCleanupFailures(await runCleanup(), 'during condition-execution rollback');
    throw err;
  }
}

function buildRunRecord({
  conditionResult, condition, runKind, scenarioId, skillSourceSha, daemonPolicy,
  allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias = 'calibration-project',
  projectCommit = null, projectUrl = null, family = 'trigger-only', modelRequested,
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
  // schema v6 (agentic-eval-runtime-neutral-records-v1): `selection` is registries.mjs's own
  // resolveSelection() result (REQUIRED -- no default, matching ambientProfileScopeId/Key's own
  // "never silently fall back" discipline); `promptArtifact`/`skillSnapshotArtifact` are
  // input-artifacts.mjs's offline treatment-size computations, each computed exactly ONCE by the
  // caller (per-command for the prompt, per-invocation for the snapshot) and passed in here --
  // this function never recomputes either.
  selection, promptArtifact, skillSnapshotArtifact,
  // PR 4 (agentic-eval-isolated-unrestricted-profile-v1): the isolation attestation's own bound
  // hash -- REQUIRED (and validated as a real 64-hex string) when selection.executionProfile.
  // policy_mode is "not_applicable", REQUIRED-null otherwise (a policy-required profile has no
  // attestation to report; a caller passing one anyway is a contract error, never silently
  // accepted). The caller (cmdCalibrate/cmdSmoke/cmdRun) resolves this exactly once via
  // resolveIsolationAttestationOrFail, before any journal/materialization/auth/spawn -- this
  // function only ever receives the already-validated `{schema, sha256}` result's own sha256,
  // never a path or the attestation's own content.
  isolationAttestationSha256 = null,
  productAccessMode = productAccessModeForSkillCondition(condition),
}) {
  // schema v6 required-input contract: a missing/malformed selection, promptArtifact, or
  // skillSnapshotArtifact -- or a modelRequested that disagrees with the registry-resolved
  // selection.model.model_id -- fails immediately with a clear, named error here, never as an
  // accidental TypeError from a deep field dereference further below (a caller with a genuinely
  // broken input previously got "Cannot read properties of undefined (reading 'runtime')" instead
  // of a legible contract violation naming exactly which parameter and field is wrong).
  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(selection) || !isObj(selection.runtime) || typeof selection.runtime.runtime_id !== 'string' || selection.runtime.runtime_id.length === 0
    || !isObj(selection.model) || typeof selection.model.model_id !== 'string' || selection.model.model_id.length === 0 || typeof selection.model.model_vendor_expected !== 'string'
    || !isObj(selection.executionProfile) || typeof selection.executionProfile.id !== 'string' || typeof selection.executionProfile.isolation_kind !== 'string' || typeof selection.executionProfile.network_mode !== 'string'
    || typeof selection.executionProfileSha256 !== 'string' || selection.executionProfileSha256.length === 0) {
    throw new TypeError('buildRunRecord: selection is required and must be a well-formed resolveSelection() result (selection.runtime.runtime_id / selection.model.{model_id,model_vendor_expected} / selection.executionProfile.{id,isolation_kind,network_mode} / selection.executionProfileSha256)');
  }
  if (!isObj(promptArtifact) || typeof promptArtifact.prompt_sha256 !== 'string' || !Number.isInteger(promptArtifact.prompt_bytes)) {
    throw new TypeError('buildRunRecord: promptArtifact is required and must be a well-formed computePromptArtifact() result (prompt_sha256/prompt_bytes)');
  }
  if (!isObj(skillSnapshotArtifact) || typeof skillSnapshotArtifact.snapshot_sha256 !== 'string' || !Number.isInteger(skillSnapshotArtifact.snapshot_bytes) || !Number.isInteger(skillSnapshotArtifact.snapshot_file_count)) {
    throw new TypeError('buildRunRecord: skillSnapshotArtifact is required and must be a well-formed computeSkillSnapshotArtifact() result (snapshot_sha256/snapshot_bytes/snapshot_file_count)');
  }
  if (modelRequested !== selection.model.model_id) {
    throw new TypeError(`buildRunRecord: modelRequested (${JSON.stringify(modelRequested)}) must exactly equal selection.model.model_id (${JSON.stringify(selection.model.model_id)}) -- the caller's own asserted model must agree with the registry-resolved selection, never an independent value`);
  }
  // PR 4: the ONE semantic switch every policy-conditioned field below keys off -- matches
  // runtimes/claude-code.mjs's own isPolicyNotApplicable exactly (registries.mjs is the only module
  // allowed to import that adapter directly, so this is a deliberate, independent duplication of
  // the identical one-line predicate, not a shared helper).
  const policyApplies = selection.executionProfile.policy_mode !== 'not_applicable';
  const ATTESTATION_SHA256_RE = /^[0-9a-f]{64}$/;
  if (!policyApplies && (typeof isolationAttestationSha256 !== 'string' || !ATTESTATION_SHA256_RE.test(isolationAttestationSha256))) {
    throw new TypeError('buildRunRecord: isolationAttestationSha256 must be a real 64-hex-char SHA-256 string when selection.executionProfile.policy_mode is "not_applicable"');
  }
  if (policyApplies && isolationAttestationSha256 !== null) {
    throw new TypeError('buildRunRecord: isolationAttestationSha256 must be null when selection.executionProfile.policy_mode is "required" -- a policy-governed profile has no attestation to report');
  }
  if (!isProductAccessModeCompatibleWithSkillCondition({ condition, productAccessMode })) {
    throw new TypeError(`buildRunRecord: productAccessMode (${JSON.stringify(productAccessMode)}) is not compatible with condition (${JSON.stringify(condition)}) -- product access is a separate treatment axis and must be supplied explicitly for free-baseline cells`);
  }

  const { observation, startedAt, endedAt } = conditionResult;
  const isScenario = runKind === 'scenario';
  const notApplicableReason = `${runKind} run -- no scenario grader applies`;
  // Computed once, shared by tool_calls_total (below) and foreign_skill_summary (schema V3) --
  // never re-derived twice from the same transcript. observation.skill.foreignInvocations is the
  // adapter's own already-classified list (skillReference replaces the legacy skillArg name).
  const foreignSkillUses = observation.skill.foreignInvocations;
  const foreignSkillSummary = {
    rejected: foreignSkillUses.filter((u) => u.resultIsError === true).length,
    confirmed: foreignSkillUses.filter((u) => u.confirmed === true).length,
    incomplete: foreignSkillUses.filter((u) => u.resultIsError === null).length,
  };
  // ambient_skill_profile (schema V4): a privacy-safe {count, scope_id, fingerprint_hmac} summary
  // of the init event's skills[] array with the TARGET skill's own bare/namespaced identity
  // stripped out -- already computed once, by the runtime adapter at normalization time
  // (observation.skill.ambient), never the raw names themselves. Always present regardless of
  // run_kind or ambient.ok: a malformed transcript still gets a real, non-null value recorded here
  // (schema requires it non-null on every record); only scenarioCellIntegrityOk/calibrationHardGate/
  // smokeHardGate (below) actually enforce strictness on well-formedness. `fingerprintNames` is
  // contract.mjs's generic HMAC helper (byte-identical algorithm to the adapter's own internal one),
  // keyed by this invocation's own random, never-persisted key (correction 2) -- see
  // generateAmbientProfileScope's own doc comment for the full privacy rationale.
  const ambientSkillProfile = {
    count: observation.skill.ambient.names.size,
    scope_id: ambientProfileScopeId,
    fingerprint_hmac: fingerprintNames(observation.skill.ambient.names, ambientProfileKey),
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
  // post_signal_ms/post_signal_tool_calls: driven purely by isScenario/hasSignalBoundary, exactly
  // as before this PR -- UNAFFECTED by execution_profile.policy_mode (a policy_mode:"not_applicable"
  // scenario run with a real signal boundary still gets real post-signal timing/tool-call counts).
  if (!isScenario) {
    postSignalMs = nullableMetric(null, notApplicableReason);
    postSignalToolCalls = nullableMetric(null, notApplicableReason);
  } else if (!hasSignalBoundary) {
    postSignalMs = nullableMetric(null, noSignalBoundaryReason);
    postSignalToolCalls = nullableMetric(null, noSignalBoundaryReason);
  } else {
    postSignalMs = nullableMetric(msSinceOrigin(observation.process.endedHrtimeNs, observation.timing.receiptNsByEventIndex.get(firstUsefulSignalEventIndex)));
    // post_signal_tool_calls: every tool attempt (any kind) whose OWN assistant event index is
    // strictly greater than the signal's result event index -- a call dispatched before the
    // signal but completed after it (its own eventIndex is still <= the boundary) is never
    // post-signal work, matching msSinceOrigin's own dispatch-time (never completion-time) framing.
    postSignalToolCalls = nullableMetric(observation.toolAttempts.filter((a) => a.eventIndex > firstUsefulSignalEventIndex).length);
  }
  // policy_denials_before/after_first_signal: policy_mode:"not_applicable" takes PRIORITY over
  // isScenario/hasSignalBoundary -- meaningless without a policy hook (no decisionByAttempt allow/
  // deny classification exists at all under that profile), so the not-applicable reason applies
  // unconditionally whenever policy doesn't apply, regardless of run_kind or signal-boundary status.
  const notApplicablePolicyReason = 'execution-profile-policy-not-applicable';
  let policyDenialsBeforeFirstSignal;
  let policyDenialsAfterFirstSignal;
  if (!policyApplies) {
    policyDenialsBeforeFirstSignal = nullableMetric(null, notApplicablePolicyReason);
    policyDenialsAfterFirstSignal = nullableMetric(null, notApplicablePolicyReason);
  } else if (!isScenario) {
    policyDenialsBeforeFirstSignal = nullableMetric(null, notApplicableReason);
    policyDenialsAfterFirstSignal = nullableMetric(null, notApplicableReason);
  } else if (!hasSignalBoundary) {
    policyDenialsBeforeFirstSignal = nullableMetric(null, noSignalBoundaryReason);
    policyDenialsAfterFirstSignal = nullableMetric(null, noSignalBoundaryReason);
  } else {
    // classify each Bash attempt by its OWN tool-use event index (never its later tool-result
    // index) against the identical boundary.
    const decisionByAttempt = conditionResult.junitAttribution?.decisionByAttempt ?? new Map();
    let before = 0;
    let after = 0;
    for (const b of selectShellAttempts(observation.toolAttempts)) {
      if (decisionByAttempt.get(b.id) !== 'deny') continue;
      if (b.eventIndex > firstUsefulSignalEventIndex) after++; else before++;
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

  // Schema v6 (agentic-eval-runtime-neutral-records-v1): agent_runtime/execution_profile are a
  // direct, faithful projection of the resolved registry selection plus the observation's own
  // reported identity -- never re-derived independently of the legacy fields they must exactly
  // mirror for claude-code (schema invariant 3, enforced by validateRun). model_vendor_observed
  // stays null: Claude's own result/init events never report a separate vendor string.
  const agentRuntime = {
    runtime_id: selection.runtime.runtime_id,
    cli_version: observation.session.runtimeVersion,
    model_requested: selection.model.model_id,
    model_resolved: observation.session.modelResolved,
    model_vendor_expected: selection.model.model_vendor_expected,
    model_vendor_observed: null,
  };
  const executionProfileGroup = {
    id: selection.executionProfile.id,
    sha256: selection.executionProfileSha256,
    isolation_kind: selection.executionProfile.isolation_kind,
    // strict-policy-v1 never requires attestation (registry: isolation_attestation_required:
    // false) -- null, always. sandboxed-unrestricted-v1 (policy_mode:"not_applicable") populates
    // this from the caller's own already-validated attestation hash (resolveIsolationAttestationOrFail),
    // never guessed or recomputed here.
    isolation_attestation_sha256: policyApplies ? null : isolationAttestationSha256,
    isolation_attestation_required: selection.executionProfile.isolation_attestation_required,
    network_mode: selection.executionProfile.network_mode,
    policy_mode: selection.executionProfile.policy_mode,
    required_capabilities: selection.executionProfile.required_capabilities,
  };
  // skill_observation: delivery/availability/activation come from the SAME observation.skill
  // facts the legacy skill_available/skill_invocation_attempted/skill_invoked fields already read
  // -- never a second, independent derivation. treatment_size reuses the ONE promptArtifact/
  // skillSnapshotArtifact the caller computed once (this function never recomputes either).
  const skillObservation = {
    delivery_mode: condition === 'current-skill' ? 'runtime-extension' : 'none',
    availability: {
      status: observation.skill.available ? 'observed-present' : 'observed-absent',
      evidence_kind: 'runtime-catalog',
    },
    activation: {
      status: observation.skill.targetInvocation?.confirmed === true ? 'confirmed' : 'not-observed',
      evidence_kind: 'runtime-explicit-event',
    },
    source_sha: condition === 'current-skill' ? skillSourceSha : null,
    treatment_size: condition === 'current-skill'
      ? {
          snapshot_sha256: skillSnapshotArtifact.snapshot_sha256,
          snapshot_bytes: skillSnapshotArtifact.snapshot_bytes,
          snapshot_file_count: skillSnapshotArtifact.snapshot_file_count,
          prompt_sha256: promptArtifact.prompt_sha256,
          prompt_bytes: promptArtifact.prompt_bytes,
          absent_reason: null,
        }
      : {
          snapshot_sha256: null,
          snapshot_bytes: null,
          snapshot_file_count: null,
          prompt_sha256: promptArtifact.prompt_sha256,
          prompt_bytes: promptArtifact.prompt_bytes,
          absent_reason: 'condition-no-skill',
        },
  };
  // usage: the four Claude-reported dimensions, copied ONCE from the same terminal.usage the
  // legacy tokens.* fields already read -- schema invariant 9 requires these stay exact
  // projections of each other, never independently derived. source is runtime-reported only when
  // at least one dimension is a real integer (never inferred true merely because the process
  // completed) -- claude never reports a reasoning_output dimension, so that one is always null,
  // and attributable_to_skill_load is always not-recorded (claude never attributes usage to skill
  // loading specifically in this PR), with the one reason value that differs by condition.
  const usageDims = observation.terminal.usage;
  const hasAnyUsageDimension = [usageDims.input, usageDims.cached_input, usageDims.cache_write, usageDims.output].some((v) => typeof v === 'number');
  const usageGroup = {
    source: hasAnyUsageDimension ? 'runtime-reported' : 'not-recorded',
    input: usageDims.input ?? null,
    cached_input: usageDims.cached_input ?? null,
    cache_write: usageDims.cache_write ?? null,
    output: usageDims.output ?? null,
    reasoning_output: null,
    attributable_to_skill_load: {
      status: 'not-recorded',
      dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
      unit: null,
      reason: condition === 'current-skill' ? 'runtime-does-not-report-skill-attribution' : 'condition-no-skill',
    },
  };

  return {
    schema: LATEST_RUN_SCHEMA,
    run_id: `${runKind}-${condition}-${randomUUID().slice(0, 8)}`,
    run_kind: runKind,
    benchmark_eligible: false,
    scenario_id: scenarioId,
    query_id: null,
    condition,
    product_access_mode: productAccessMode,
    skill_source_sha: condition === 'current-skill' ? skillSourceSha : null,
    kmp_test_cli_version: provenance.cliVersion,
    kmp_test_cli_source_sha: provenance.repoCommit,
    resolved_kmp_test_executable_path: provenance.resolvedExecutablePath,
    model_requested: selection.model.model_id,
    model_resolved: observation.session.modelResolved,
    session_id_observed: observation.session.sessionIdObserved,
    claude_code_version: observation.session.runtimeVersion,
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
    skill_available: nullableMetric(observation.skill.available),
    skill_invocation_attempted: nullableMetric(observation.skill.targetInvocation != null),
    skill_invoked: nullableMetric(observation.skill.targetInvocation?.confirmed ?? false),
    // 'assistant.tool_use.Skill' is a closed literal (stream-parser.mjs's own findSkillInvocation
    // always used exactly this constant, never a variable value) -- hardcoded here rather than
    // carried through the observation contract, which has no need for a type field that never varies.
    skill_invocation_event: observation.skill.targetInvocation ? { type: 'assistant.tool_use.Skill', index: observation.skill.targetInvocation.eventIndex } : null,
    // decision 13: for a scenario record, success/expected_outcome_matched are graders.mjs's own
    // already-computed verdict -- real, non-null booleans (which may legitimately be false; a
    // wrong answer is valid negative data, never filtered out). Never re-derived here, never
    // overloaded into notes/errors.
    success: isScenario ? nullableMetric(gradeResult.success) : nullableMetric(null, `${runKind} run -- success grading not applicable`),
    expected_outcome_matched: isScenario ? nullableMetric(gradeResult.expectedOutcomeMatched) : nullableMetric(null, notApplicableReason),
    first_useful_signal_ms: isScenario
      ? nullableMetric(
          gradeResult.firstUsefulSignalEventIndex != null
            ? msSinceOrigin(observation.timing.receiptNsByEventIndex.get(gradeResult.firstUsefulSignalEventIndex), observation.process.spawnHrtimeNs)
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
    // Schema v6 (agentic-eval-runtime-neutral-records-v1) -- the four canonical groups, computed
    // once above. Legacy tokens/claude_code_version/model_requested/model_resolved below remain
    // exactly as they always were; they are never derived FROM these new groups (or vice versa) --
    // both sides read the SAME underlying observation/selection facts independently, and
    // validateRun's own schema-v6 invariants prove they stay in lockstep.
    agent_runtime: agentRuntime,
    execution_profile: executionProfileGroup,
    skill_observation: skillObservation,
    usage: usageGroup,
    tokens: {
      input: nullableMetric(observation.terminal.usage.input, observation.terminal.present ? undefined : 'no result event'),
      output: nullableMetric(observation.terminal.usage.output, observation.terminal.present ? undefined : 'no result event'),
      cache_read: nullableMetric(observation.terminal.usage.cached_input, observation.terminal.present ? undefined : 'no result event'),
      cache_creation: nullableMetric(observation.terminal.usage.cache_write, observation.terminal.present ? undefined : 'no result event'),
    },
    // Counts EVERY tool attempt in the transcript, regardless of kind (observation.toolAttempts --
    // the identical field the accepted-run-audit sidecar's own summary.tool_calls_total uses) -- a
    // review finding demonstrated the previous formula (findBashToolUses().length +
    // invocation?.attemptCount + foreignSkillUses.length) silently dropped a genuinely unexpected
    // tool call (e.g. a bare Read) that is neither Bash nor Skill, undercounting the transcript and
    // making the record disagree with its own sidecar on an otherwise-unremarkable run.
    tool_calls_total: nullableMetric(observation.toolAttempts.length),
    shell_commands_total: nullableMetric(selectShellAttempts(observation.toolAttempts).length),
    // decision 12: real, non-null counts for a scenario record -- directly reusing the SAME
    // attempt list gradeScenarioCondition already built (never a second, independently-derived
    // count that could drift from what grading itself saw).
    test_invocations_total: isScenario ? nullableMetric(gradeResult.testInvocationsTotal) : nullableMetric(null, `not tracked for ${runKind} runs`),
    retries: isScenario ? nullableMetric(gradeResult.retries) : nullableMetric(null, `not tracked for ${runKind} runs`),
    output_bytes: nullableMetric(observation.byteMetrics.outputBytes),
    stream_json_bytes: nullableMetric(observation.byteMetrics.streamJsonBytes),
    human_interventions: nullableMetric(0),
    terminated: observation.process.terminated,
    termination_reason: observation.process.terminationReason,
    exit_code: observation.process.exitCode,
    // PR 4: permission_mode_used mirrors runtimes/claude-code.mjs's own buildInvocation choice
    // exactly (isPolicyNotApplicable) -- 'dontAsk' for strict, 'bypassPermissions' for
    // sandboxed-unrestricted-v1, never a third value and never guessed independently of the actual
    // compiled argv. The 4 policy-metric fields below are real values only when policy actually
    // governed this run (policyApplies) -- otherwise exactly null, never 0/[]/a stale value.
    permission_mode_used: policyApplies ? 'dontAsk' : 'bypassPermissions',
    policy_allowed_gradle_tasks: policyApplies ? allowedGradleTasks : null,
    policy_allowed_kmptest_subcommands: policyApplies ? allowedKmpTestSubcommands : null,
    policy_sha256: policyApplies ? policySha256 : null,
    hook_call_count: policyApplies ? observation.hookStats.hookCallCount : null,
    hook_deny_count: policyApplies ? observation.hookStats.hookDenyCount : null,
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
      // The identical HARNESS-INTEGRITY treatment as malformed_parallel_evidence above, for the
      // changed-subcommand sibling (graders.mjs's changedEvidenceMalformed): the terminal `changed`
      // attempt's own changed{} block is internally malformed, or the envelope also carries a
      // production-impossible `parallel` block -- either way the tool's own JSON output cannot be
      // trusted as genuine evidence of what happened, not a legitimate agent outcome.
      ...(isScenario && gradeResult?.changedEvidenceMalformed
        ? [{ code: 'malformed_changed_evidence', message: 'the terminal kmp-test changed attempt\'s own changed{} block is internally malformed, or the envelope also carries a parallel block real production never produces alongside it -- the tool\'s own JSON output cannot be trusted as genuine evidence of what happened' }]
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
function writeRunRecordEvidence(runKind, recordA, recordB, rawTextA, rawTextB, redactedTextA, redactedTextB, runsRootOverride = RUNS_ROOT) {
  const outDir = resolveEvidenceOutDir(runKind, runsRootOverride);
  const rawDir = join(outDir, 'raw');
  if (!isRawDirSafeFromAccidentalCommit(rawDir, runsRootOverride)) {
    throw new Error(`refusing to write raw transcripts: ${rawDir} is inside this repo's worktree but not covered by .gitignore -- would risk an accidental commit of unredacted data`);
  }
  const targets = [
    [join(outDir, `${recordA.run_id}.json`), redactedTextA],
    [join(outDir, `${recordB.run_id}.json`), redactedTextB],
    [join(rawDir, `${recordA.run_id}.jsonl`), rawTextA],
    [join(rawDir, `${recordB.run_id}.jsonl`), rawTextB],
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
 * @param {string[]} rawTexts - parallel array, each record[i]'s own raw transcript text (the
 *   caller's own transcriptsByRunId map, projected to records' order -- see
 *   finalizeAndWriteMatrixRecords' own doc comment on why this function no longer reads
 *   conditionResult directly for raw text)
 * @param {string[]} redactedTexts - parallel array, each record[i]'s own redacted JSON text
 * @param {string} [runsRootOverride]
 * @param {string[]|null} [sidecarTexts] - accepted-run-observability PR: parallel array, each
 *   record[i]'s own already-redacted accepted-run-audit sidecar JSON text (written to
 *   `audit/<run_id>.json`, alongside the summary + raw tiers, as one all-or-nothing batch). `null`
 *   (the default) writes NO audit/ directory or sidecar files at all -- calibrate/smoke's own
 *   pair-based writeRunRecordEvidence sibling never gains this parameter at all, since sidecars are
 *   a scenario-only concept and that pair-based path is deliberately left unchanged.
 */
function writeRunMatrixRecordEvidence(runKind, records, rawTexts, redactedTexts, runsRootOverride = RUNS_ROOT, sidecarTexts = null) {
  const outDir = resolveEvidenceOutDir(runKind, runsRootOverride);
  const rawDir = join(outDir, 'raw');
  const auditDir = join(outDir, 'audit');
  if (!isRawDirSafeFromAccidentalCommit(rawDir, runsRootOverride)) {
    throw new Error(`refusing to write raw transcripts: ${rawDir} is inside this repo's worktree but not covered by .gitignore -- would risk an accidental commit of unredacted data`);
  }
  const targets = records.flatMap((record, i) => [
    [join(outDir, `${record.run_id}.json`), redactedTexts[i]],
    [join(rawDir, `${record.run_id}.jsonl`), rawTexts[i]],
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

/**
 * PR 4 (agentic-eval-isolated-unrestricted-profile-v1): the policy-hook-freshness check, factored
 * out to ONE place so it is applied identically at all 4 call sites (finalizeAndWriteRecords'
 * fail-fast-B-only and main branches, finalizeAndWriteMatrixRecords' fail-fast-partial and main
 * branches) rather than re-inlined 4 times with a real risk of missing one. A
 * policy_mode:"not_applicable" record's own policy_sha256 is ALWAYS null by design (no policy
 * hook ever produced this evidence -- see buildRunRecord's own policyApplies-conditioned
 * assignment) -- comparing it against policy-hook.mjs's real hash is meaningless for such a
 * record and is unconditionally skipped, never treated as "stale" (there was never a real hash to
 * go stale relative to in the first place).
 * @param {Array<[string, object]>} labeledRecords - `[label, record]` pairs, using each call
 *   site's own existing label convention ('A'/'B' for the pair path, '[i]' for the matrix path).
 * @param {string} freshHash - policy-config.mjs's computePolicySha256({fresh:true}) result.
 * @returns {string|null} a reason string for the FIRST stale record found, or null if none are stale.
 */
function findStalePolicyHash(labeledRecords, freshHash) {
  for (const [label, record] of labeledRecords) {
    if (record.execution_profile?.policy_mode === 'not_applicable') continue;
    if (record.policy_sha256 !== freshHash) {
      return `Run record ${label} policy_sha256 (${record.policy_sha256}) does not match the current policy-hook.mjs (${freshHash}) -- evidence is stale relative to the code that produced it`;
    }
  }
  return null;
}

/**
 * Builds the stderrByRunId map writeRejectionForensics' 3rd transaction needs, reading each
 * cell's ALREADY-redacted stderr back from the journal (never conditionResult.spawnResult.stderr
 * raw). Returns `{stderrByRunId: null, stderrReadError: null}` -- skipping the transaction
 * cleanly, no failure to report -- when journal is absent entirely (the transaction genuinely
 * doesn't apply). Returns `{stderrByRunId: null, stderrReadError: 'stderr_read_failed'}` when
 * journal IS present but ANY read throws (post-adversarial-review fix, round 2): a real
 * filesystem race between this read and persistSpawnOutcome's own earlier write (EACCES/EBUSY on
 * Windows, plausible; or, defensively, a stale ordinal) must never let an uncaught exception
 * escape finalizeAndWriteRecords/finalizeAndWriteMatrixRecords -- but it ALSO must never be
 * silently folded into the SAME "no journal, nothing to report" state, which would hide a REAL
 * failure behind a code path that means something else entirely (the operator would see total
 * silence on the stderr tier instead of a closed failure code). The caller threads
 * `stderrReadError` into writeRejectionForensics, which surfaces it through the SAME
 * `stderrWriteError` field/reporting channel `stderr_write_failed` already uses -- one unified
 * "was the stderr tier preserved" signal, regardless of which specific step failed.
 * @param {object|null} journal
 * @param {Record<string,number>} cellOrdinalByRunId
 * @returns {{stderrByRunId: Record<string,string>|null, stderrReadError: string|null}}
 */
function buildStderrByRunId(journal, cellOrdinalByRunId) {
  if (!journal) return { stderrByRunId: null, stderrReadError: null };
  try {
    const stderrByRunId = Object.fromEntries(Object.entries(cellOrdinalByRunId).map(([runId, ordinal]) => [runId, journal.readStderrFor(ordinal)]));
    return { stderrByRunId, stderrReadError: null };
  } catch {
    return { stderrByRunId: null, stderrReadError: 'stderr_read_failed' };
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function absentRejectedMetric(reason = 'not recorded on rejected record') {
  return { value: null, reason };
}

function normalizeRejectedUsage(record) {
  const usage = cloneJson(record.usage);
  if (usage != null && typeof usage === 'object' && !Array.isArray(usage)) {
    return {
      source: usage.source,
      input: usage.input ?? null,
      cached_input: usage.cached_input ?? null,
      cache_write: usage.cache_write ?? null,
      output: usage.output ?? null,
      reasoning_output: usage.reasoning_output ?? null,
    };
  }
  return {
    source: 'not-recorded',
    input: null,
    cached_input: null,
    cache_write: null,
    output: null,
    reasoning_output: null,
  };
}

function normalizeRejectedTokens(record, usage) {
  const tokens = cloneJson(record.tokens);
  if (tokens != null && typeof tokens === 'object' && !Array.isArray(tokens)) return tokens;
  const metricFor = (value) => (Number.isInteger(value) && value >= 0 ? { value, reason: null } : absentRejectedMetric());
  return {
    input: metricFor(usage.input),
    output: metricFor(usage.output),
    cache_read: metricFor(usage.cached_input),
    cache_creation: metricFor(usage.cache_write),
  };
}

function buildRejectedCellMetrics(record) {
  const usage = normalizeRejectedUsage(record);
  return {
    schema: 1,
    started_at: record.started_at,
    ended_at: record.ended_at,
    wall_clock_ms: record.wall_clock_ms,
    first_useful_signal_ms: cloneJson(record.first_useful_signal_ms) ?? absentRejectedMetric(),
    post_signal_ms: cloneJson(record.post_signal_ms) ?? absentRejectedMetric(),
    usage,
    tokens: normalizeRejectedTokens(record, usage),
    tool_calls_total: cloneJson(record.tool_calls_total) ?? absentRejectedMetric(),
    shell_commands_total: cloneJson(record.shell_commands_total) ?? absentRejectedMetric(),
  };
}

/**
 * Shared rejection-forensics writer for BOTH finalizeAndWriteRecords (pair path) and
 * finalizeAndWriteMatrixRecords (matrix path) -- TWO INDEPENDENT transactions (see
 * rejection-diagnostics.mjs's own header comment for the full rationale): raw transcripts first
 * (Transaction 1, minimal failure surface), the structured diagnostic second (Transaction 2, the
 * full validate/redact/revalidate pipeline). Each outcome is captured into its OWN error field --
 * neither transaction's failure ever masks the caller's own hard-gate/fail-fast rejection reason,
 * and neither's failure ever prevents the OTHER transaction from being attempted. Both tiers of
 * the structured diagnostic stamp the SAME `rawTranscriptsPersisted` boolean, known before
 * Transaction 2 is even attempted.
 */
async function writeRejectionForensics({
  runKind, records, failedChecksByRunId, unexpectedToolUsesCountByRunId, unexpectedToolsByRunId,
  foreignSkillNamesByRunId, transcriptsByRunId, captureOrdinalByRunId, ambientProfileMatrixOk = null,
  plannedCellCount = null, executedCellCount = null, privatePatternsFile, runsRootOverride,
  correlationObservabilityByRunId = null,
  preInferenceFailureByRunId = null,
  cellMetricsByRunId = null,
  terminalEvidenceByRunId = null,
  // stderrByRunId: null when the caller has no journal (e.g. a direct test of this function) --
  // the 3rd transaction below is skipped cleanly in that case, never throws, never blocks the
  // other two. When present, every value MUST already be a string (the caller reads it back
  // already-redacted from the journal) -- see cli.mjs's own call sites for how stderrByRunId is
  // built. stderrReadError: set by the caller's own buildStderrByRunId when journal WAS present
  // but reading it back failed -- distinct from stderrByRunId:null-with-no-journal (nothing to
  // report) -- surfaces through the SAME stderrWriteError field below, never silently dropped.
  stderrByRunId = null, stderrReadError = null,
}) {
  const rejectionId = randomUUID();
  let rawTranscriptsWriteError = null;
  let rawTranscriptsPersisted;
  let diagnosticsTranscriptsDir = null;
  let diagnosticsTranscriptCount = 0;
  let rawTranscriptsManifest = null;
  try {
    const raw = writeRejectionRawTranscripts(rejectionId, transcriptsByRunId, captureOrdinalByRunId, { runsRootOverride });
    diagnosticsTranscriptsDir = raw.transcriptsRelativeDir;
    diagnosticsTranscriptCount = raw.transcriptCount;
    rawTranscriptsManifest = raw.rawTranscriptsManifest;
    rawTranscriptsPersisted = true;
  } catch (err) {
    rawTranscriptsWriteError = err.message;
    rawTranscriptsPersisted = false;
  }

  // Transaction 3 of 3 -- stderr, the exact sibling of Transaction 1 (raw transcripts) above:
  // independent of it and of Transaction 2 below, never blocking or blocked by either. A closed
  // code, never err.message (a real fs error can carry an absolute path with the OS username).
  // stderrReadError (set by the caller's buildStderrByRunId when the journal read itself failed)
  // short-circuits straight to the SAME error field a write failure uses -- there is nothing to
  // attempt writing in that case (stderrByRunId is null), but the failure must still be reported,
  // never conflated with the unrelated "no journal at all" silence.
  let stderrWriteError = stderrReadError;
  let stderrPersisted = false;
  let stderrRelativeDir = null;
  let stderrManifest = null;
  let stderrCount = 0;
  if (stderrReadError == null && stderrByRunId != null) {
    try {
      const raw = writeRejectionRawStderr(rejectionId, stderrByRunId, captureOrdinalByRunId, { runsRootOverride, privatePatternsFile });
      stderrRelativeDir = raw.stderrRelativeDir;
      stderrManifest = raw.stderrManifest;
      stderrCount = raw.stderrCount;
      stderrPersisted = true;
    } catch {
      stderrWriteError = 'stderr_write_failed';
    }
  }

  let diagnosticsWriteError = null;
  let writtenRejectionId = null;
  let diagnosticsRelativePath = null;
  try {
    const diagnostics = buildRejectionDiagnostics({
      runKind, rejectionId, records, failedChecksByRunId, unexpectedToolUsesCountByRunId,
      unexpectedToolsByRunId, captureOrdinalByRunId, rawTranscriptsPersisted, foreignSkillNamesByRunId,
      ambientProfileMatrixOk, plannedCellCount, executedCellCount, correlationObservabilityByRunId,
      preInferenceFailureByRunId, cellMetricsByRunId, terminalEvidenceByRunId,
    });
    ({ rejectionId: writtenRejectionId, relativePath: diagnosticsRelativePath } = writeRejectedRunDiagnostics(diagnostics, { privatePatternsFile, runsRootOverride }));
  } catch (err) {
    diagnosticsWriteError = err.message;
  }

  return {
    rawTranscriptsWriteError, rawTranscriptsPersisted, diagnosticsWriteError, rejectionId: writtenRejectionId,
    diagnosticsRelativePath, diagnosticsTranscriptsDir, diagnosticsTranscriptCount,
    rawTranscriptsManifest,
    stderrWriteError, stderrPersisted, stderrRelativeDir, stderrManifest, stderrCount,
  };
}

/**
 * Shared stderr reporting for a finalize function's rejection result -- reports BOTH transactions'
 * outcomes independently (see writeRejectionForensics/rejection-diagnostics.mjs's own header
 * comment for why raw-transcript persistence and structured-diagnostic persistence are two
 * separate transactions): a raw-transcript-write failure is reported separately from a
 * diagnostics-write failure, and either one failing never hides the other's success. A no-op for
 * an early-return failure that never reached writeRejectionForensics at all (schema validation,
 * dirty tree, stale policy hash) -- every field this reads is simply absent on that shape of
 * result, exactly like today's pre-existing diagnosticsWriteError/rejectionId fields already are.
 */
function printRejectionForensicsStderr(result) {
  if (result.rawTranscriptsWriteError) {
    console.error(`(raw transcripts were NOT preserved: ${result.rawTranscriptsWriteError})`);
  } else if (result.diagnosticsTranscriptCount > 0) {
    console.error(`(${result.diagnosticsTranscriptCount} raw transcript(s) preserved locally under ${result.diagnosticsTranscriptsDir})`);
  }
  // 3rd tier (stderr) -- same pattern as the other two: success reports a count + a RELATIVE path
  // (never absolute -- could carry the real OS username), failure reports only the closed code.
  if (result.stderrWriteError) {
    console.error(`(stderr was NOT preserved: ${result.stderrWriteError})`);
  } else if (result.stderrCount > 0) {
    console.error(`(${result.stderrCount} stderr file(s) preserved locally under ${result.stderrRelativeDir})`);
  }
  if (result.diagnosticsWriteError) {
    console.error(`(rejected-run diagnostics were NOT written: ${result.diagnosticsWriteError})`);
  } else if (result.rejectionId) {
    console.error(`(rejected-run diagnostics written: ${result.diagnosticsRelativePath}, rejection_id ${result.rejectionId})`);
  }
}

/**
 * Fail-closed shape check for the `transcriptsByRunId` map finalizeAndWriteRecords/
 * finalizeAndWriteMatrixRecords now require as an explicit caller-supplied parameter (raw-custody
 * rule: these functions never read raw transcript text off `conditionResult` themselves anymore --
 * the observation contract carries no raw/legacy fields to read). Same reason-string-or-null
 * convention as findMatrixCompletenessGap: neither missing NOR extra run_ids are tolerated (an
 * extra id could silently mask a caller wiring the wrong map in), and every value must actually be
 * a string (never undefined/null -- a caller that failed to read one back from the journal must
 * fail here, not write a non-string into a `.jsonl` file).
 * @returns {string|null} a reason string on mismatch, null when `transcriptsByRunId` is exactly right.
 */
function validateTranscriptsByRunId(transcriptsByRunId, expectedRunIds) {
  if (transcriptsByRunId == null || typeof transcriptsByRunId !== 'object' || Array.isArray(transcriptsByRunId)) {
    return `transcriptsByRunId must be an object, got ${Array.isArray(transcriptsByRunId) ? 'array' : typeof transcriptsByRunId}`;
  }
  const expectedSet = new Set(expectedRunIds);
  const actualRunIds = Object.keys(transcriptsByRunId);
  const missing = expectedRunIds.filter((id) => !actualRunIds.includes(id));
  const extra = actualRunIds.filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || extra.length > 0) {
    return `transcriptsByRunId run_id mismatch -- missing:${JSON.stringify(missing)} extra:${JSON.stringify(extra)}`;
  }
  for (const id of expectedRunIds) {
    if (typeof transcriptsByRunId[id] !== 'string') {
      return `transcriptsByRunId[${id}] must be a string, got ${typeof transcriptsByRunId[id]}`;
    }
  }
  return null;
}

async function finalizeAndWriteRecords({ runKind, recordA, recordB, runA, runB, hardGateFn, privatePatternsFile, runsRootOverride = RUNS_ROOT, matrixComplete = true, plannedCellCount = 2, executedCellCount = 2, failFastStop = null, journal = null, transcriptsByRunId }) {
  // Fail-fast (preserve rejected matrix forensics): only B ran -- runConditionPair's own fail-fast
  // check on B already found a local integrity failure and never spawned A at all. hardGateFn is
  // NEVER invoked here: there is no A side to give it, and calibrationHardGate/smokeHardGate both
  // require both sides. Go straight to rejection forensics using failFastStop's own already-
  // computed verdict for B -- never re-derived, never masked.
  if (!matrixComplete) {
    const transcriptsCheckFF = validateTranscriptsByRunId(transcriptsByRunId, [recordB.run_id]);
    if (transcriptsCheckFF) return { ok: false, reason: transcriptsCheckFF };
    const { errors } = validateRun(recordB);
    if (errors.length > 0) {
      return { ok: false, reason: `Run record B failed schema validation: ${JSON.stringify(errors)}` };
    }
    const dirtyMeasured = recordB.errors.find((e) => e.code === 'dirty_measured_code');
    if (dirtyMeasured) {
      return { ok: false, reason: `Run record B was captured with an unclean measured-code tree -- refusing to write evidence that would misrepresent repo_commit: ${dirtyMeasured.message}` };
    }
    const runsRootIsDefaultB = isRunsRootDefault(runsRootOverride, REPO_ROOT);
    const dirtyHarnessB = findBlockingHarnessToolingDirty(recordB, runsRootIsDefaultB);
    if (dirtyHarnessB) {
      return { ok: false, reason: `Run record B was captured with an unclean harness-tooling tree while writing to the default, committable evidence location -- refusing to write evidence that would misrepresent repo_commit: ${dirtyHarnessB.message}` };
    }
    const { computePolicySha256: computePolicySha256B } = await import('./policy-config.mjs');
    const freshHashB = computePolicySha256B({ fresh: true });
    const stalePolicyB = findStalePolicyHash([['B', recordB]], freshHashB);
    if (stalePolicyB) {
      return { ok: false, reason: stalePolicyB };
    }
    // stderrByRunId (Diseño 4d): null when there's no journal at all (e.g. a direct test of this
    // function) -- writeRejectionForensics skips its 3rd transaction cleanly in that case. When a
    // journal IS present, every value is read back ALREADY-redacted via journal.readStderrFor --
    // never re-derived from a fresh string, and never conditionResult.spawnResult.stderr raw.
    const { stderrByRunId, stderrReadError } = buildStderrByRunId(journal, { [recordB.run_id]: runB.cellOrdinal });
    const forensics = await writeRejectionForensics({
      runKind, records: [recordB],
      failedChecksByRunId: { [recordB.run_id]: failFastStop.failedChecks },
      unexpectedToolUsesCountByRunId: { [recordB.run_id]: failFastStop.unexpectedToolUsesCount },
      unexpectedToolsByRunId: { [recordB.run_id]: failFastStop.unexpectedTools },
      foreignSkillNamesByRunId: { [recordB.run_id]: runB.observation.skill.foreignInvocations.map((u) => u.skillReference).filter((s) => s != null) },
      correlationObservabilityByRunId: { [recordB.run_id]: runB.correlationObservability },
      preInferenceFailureByRunId: { [recordB.run_id]: summarizePreInferenceFailure(runB.observation) },
      cellMetricsByRunId: { [recordB.run_id]: buildRejectedCellMetrics(recordB) },
      transcriptsByRunId,
      // Derived from runB.cellOrdinal -- the journal's own authoritative per-cell ordinal (stamped
      // by runSingleCondition itself), never a hardcoded 0 (post-Codex-audit fix, PR #418, round
      // 4: this producer still fabricated the ordinal even after round 3 fixed the CONSUMER-side
      // exact-correspondence check to derive its own comparison binding the same way -- a wrong
      // ordinal written HERE would already be baked into the rejection manifest before that later
      // check ever runs).
      captureOrdinalByRunId: { [recordB.run_id]: runB.cellOrdinal },
      plannedCellCount, executedCellCount,
      privatePatternsFile, runsRootOverride, stderrByRunId, stderrReadError,
    });
    return { ok: false, reason: failFastStop.reason, ...forensics };
  }

  const transcriptsCheck = validateTranscriptsByRunId(transcriptsByRunId, [recordA.run_id, recordB.run_id]);
  if (transcriptsCheck) return { ok: false, reason: transcriptsCheck };

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
  const stalePolicy = findStalePolicyHash([['A', recordA], ['B', recordB]], freshHash);
  if (stalePolicy) {
    return { ok: false, reason: stalePolicy };
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
    const { stderrByRunId, stderrReadError } = buildStderrByRunId(journal, { [recordB.run_id]: runB.cellOrdinal, [recordA.run_id]: runA.cellOrdinal });
    const forensics = await writeRejectionForensics({
      runKind, records: [recordA, recordB],
      failedChecksByRunId: { [recordA.run_id]: gate.failedChecksA ?? [], [recordB.run_id]: gate.failedChecksB ?? [] },
      unexpectedToolUsesCountByRunId: { [recordA.run_id]: gate.unexpectedToolUsesCountA, [recordB.run_id]: gate.unexpectedToolUsesCountB },
      unexpectedToolsByRunId: { [recordA.run_id]: gate.unexpectedToolsA, [recordB.run_id]: gate.unexpectedToolsB },
      foreignSkillNamesByRunId: {
        [recordA.run_id]: runA.observation.skill.foreignInvocations.map((u) => u.skillReference).filter((s) => s != null),
        [recordB.run_id]: runB.observation.skill.foreignInvocations.map((u) => u.skillReference).filter((s) => s != null),
      },
      correlationObservabilityByRunId: {
        [recordA.run_id]: runA.correlationObservability,
        [recordB.run_id]: runB.correlationObservability,
      },
      preInferenceFailureByRunId: {
        [recordA.run_id]: summarizePreInferenceFailure(runA.observation),
        [recordB.run_id]: summarizePreInferenceFailure(runB.observation),
      },
      cellMetricsByRunId: {
        [recordA.run_id]: buildRejectedCellMetrics(recordA),
        [recordB.run_id]: buildRejectedCellMetrics(recordB),
      },
      transcriptsByRunId,
      // Derived from runB.cellOrdinal/runA.cellOrdinal -- the journal's own authoritative per-cell
      // ordinals (each stamped by runSingleCondition itself), never hardcoded 0/1 constants
      // (post-Codex-audit fix, PR #418, round 4: this producer still fabricated both ordinals even
      // after round 3 fixed the CONSUMER-side exact-correspondence check to derive its own
      // comparison binding the same way -- a wrong pairing written HERE would already be baked
      // into the rejection manifest before that later check ever runs). In today's fixed spawn
      // order (runConditionPair always spawns B/current-skill before A/no-skill) this still
      // resolves to {B:0, A:1} -- but reads it from the real per-cell source of truth now, not a
      // parameter-list-order-tempting literal.
      captureOrdinalByRunId: { [recordB.run_id]: runB.cellOrdinal, [recordA.run_id]: runA.cellOrdinal },
      privatePatternsFile, runsRootOverride, stderrByRunId, stderrReadError,
    });
    return { ok: false, reason: gate.reason, ...forensics };
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
    writeRunRecordEvidence(runKind, recordA, recordB, transcriptsByRunId[recordA.run_id], transcriptsByRunId[recordB.run_id], redactedTextA, redactedTextB, runsRootOverride);
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
 * Campaign analogue of findMatrixCompletenessGap (agentic-eval-multi-profile-campaigns-v1) --
 * checks the promoted `records` array against the LITERAL pre-registered `campaignPlan`
 * (scenario-campaign-plan.mjs's buildScenarioCampaignPlan output) instead of a synthesized
 * repeats*2 two-condition expectation. A campaign's completeness contract is "matches the
 * pre-registered plan exactly" (order_index, repetition_index, condition, execution_profile.id all
 * agree with the plan's own cell at that order_index) -- strictly more precise than the legacy
 * shape-only check, since a campaign additionally has an execution-profile axis the legacy
 * two-condition matrix never had. Reads only condition/execution_profile.id/order_index/
 * repetition_index -- all already-existing schema v6 fields (Data model discipline:
 * campaign_cell_label/campaign_design_id are the plan's own in-memory labels, never written into
 * the durable record itself).
 */
function findCampaignCompletenessGap(records, campaignPlan) {
  const expectedCellCount = campaignPlan.cells.length;
  if (records.length !== expectedCellCount) {
    return `expected ${expectedCellCount} records (campaign design ${JSON.stringify(campaignPlan.campaign_design_id)}), got ${records.length}`;
  }
  const recordByOrderIndex = new Map();
  for (const r of records) {
    if (recordByOrderIndex.has(r.order_index)) return `duplicate order_index: ${r.order_index}`;
    recordByOrderIndex.set(r.order_index, r);
  }
  for (const cell of campaignPlan.cells) {
    const record = recordByOrderIndex.get(cell.order_index);
    if (record == null) return `missing record for order_index ${cell.order_index} (campaign_cell_label ${cell.campaign_cell_label})`;
    if (record.repetition_index !== cell.repetition_index) {
      return `order_index ${cell.order_index}: repetition_index ${record.repetition_index} does not match the pre-registered plan's ${cell.repetition_index}`;
    }
    if (record.condition !== cell.condition) {
      return `order_index ${cell.order_index}: condition ${JSON.stringify(record.condition)} does not match the pre-registered plan's ${JSON.stringify(cell.condition)}`;
    }
    if (record.execution_profile == null || record.execution_profile.id !== cell.execution_profile_id) {
      return `order_index ${cell.order_index}: execution_profile.id does not match the pre-registered plan's ${JSON.stringify(cell.execution_profile_id)}`;
    }
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
async function finalizeAndWriteMatrixRecords({
  runKind, records, conditionResults, hardGateFn, privatePatternsFile, runsRootOverride = RUNS_ROOT,
  repeats, buildSidecarsFn = null, matrixComplete = true, plannedCellCount = repeats * 2,
  executedCellCount = records.length, localIntegrityByRunId = null, failFastStop = null, journal = null,
  transcriptsByRunId,
  // agentic-eval-multi-profile-campaigns-v1: optional injected completeness check, `(records) =>
  // string|null`, overriding the default `findMatrixCompletenessGap(records, repeats)` call below.
  // Omitted (the overwhelmingly common case -- every pre-existing caller) preserves today's exact
  // behavior byte-for-byte; cmdRun's campaign path is the one caller that supplies
  // `(records) => findCampaignCompletenessGap(records, campaignPlan)`, since a campaign's
  // completeness contract (matches the pre-registered plan, which also carries an execution-profile
  // axis) is not representable by the legacy repeats*2-two-conditions shape.
  completenessCheckFn = null,
  terminalEvidenceByRunId = null,
}) {
  // Raw-custody rule: this function never reads raw transcript text off `conditionResults` itself
  // (the observation contract carries no raw/legacy fields) -- the caller (cmdRun) builds this map
  // from the journal via readJournalRawFor and passes it in complete. Validated once, here, against
  // `records` -- identical expected id set in both the fail-fast and complete-matrix branches below
  // (records already covers exactly "the cells this call is about" in either case), so one check
  // upfront covers both.
  const transcriptsCheck = validateTranscriptsByRunId(transcriptsByRunId, records.map((r) => r.run_id));
  if (transcriptsCheck) return { ok: false, reason: transcriptsCheck };

  // Fail-fast (preserve rejected matrix forensics): the matrix stopped early -- `records` only
  // covers the cells that actually executed. NEVER call findMatrixCompletenessGap here (an
  // incomplete matrix is BY DESIGN in this branch, not a defect) and NEVER call `hardGateFn`
  // (scenarioHardGate computes ambient_profile_matrix_ok as if it represents consensus over the
  // WHOLE planned matrix -- evaluated over only a prefix, that would be a claim about a consensus
  // that was never actually checked). This function cannot read the `matrix` object
  // runScenarioMatrix returned (only cmdRun, which calls this function, has it), so the caller
  // passes `localIntegrityByRunId` explicitly: one cellTranscriptIntegrityOk-shaped result per
  // EXECUTED cell, from the exact same evaluation the fail-fast loop already ran -- validated here
  // by exact-set-equality against records[].run_id, never assumed complete.
  if (!matrixComplete) {
    const recordRunIds = new Set(records.map((r) => r.run_id));
    const localIntegrityKeys = new Set(Object.keys(localIntegrityByRunId ?? {}));
    const missingLocalIntegrity = [...recordRunIds].filter((id) => !localIntegrityKeys.has(id));
    const extraLocalIntegrity = [...localIntegrityKeys].filter((id) => !recordRunIds.has(id));
    // CodeRabbit review finding (PR #417): this used to throw -- cmdRun calls this function inside
    // a try/finally with no catch, so the throw escaped all the way to main()'s own top-level
    // handler, exiting 2 with a raw stack trace instead of this function's own established
    // "{ok:false, reason}" / RUN FAILED / exit 1 contract every other guard here already honors
    // (see the three sibling checks immediately below, and finalizeAndWriteRecords' identical
    // pattern). This is a programmer-error-class guard (a caller/wiring bug, not a hard-gate
    // rejection), but it must still fail through the SAME clean contract as everything else in
    // this function, not a different, uncaught one.
    if (localIntegrityByRunId == null || missingLocalIntegrity.length > 0 || extraLocalIntegrity.length > 0) {
      return { ok: false, reason: `finalizeAndWriteMatrixRecords: localIntegrityByRunId's keys must exactly match records[].run_id when matrixComplete is false (missing: ${JSON.stringify(missingLocalIntegrity)}, extra/stale: ${JSON.stringify(extraLocalIntegrity)})` };
    }
    for (const [i, record] of records.entries()) {
      const dirty = record.errors.find((e) => e.code === 'dirty_measured_code');
      if (dirty) {
        return { ok: false, reason: `Run record [${i}] was captured with an unclean measured-code tree -- refusing to write evidence that would misrepresent repo_commit: ${dirty.message}` };
      }
    }
    const runsRootIsDefaultFF = isRunsRootDefault(runsRootOverride, REPO_ROOT);
    for (const [i, record] of records.entries()) {
      const dirty = findBlockingHarnessToolingDirty(record, runsRootIsDefaultFF);
      if (dirty) {
        return { ok: false, reason: `Run record [${i}] was captured with an unclean harness-tooling tree while writing to the default, committable evidence location -- refusing to write evidence that would misrepresent repo_commit: ${dirty.message}` };
      }
    }
    const { computePolicySha256: computePolicySha256FF } = await import('./policy-config.mjs');
    const freshHashFF = computePolicySha256FF({ fresh: true });
    const stalePolicyFF = findStalePolicyHash(records.map((record, i) => [`[${i}]`, record]), freshHashFF);
    if (stalePolicyFF) {
      return { ok: false, reason: stalePolicyFF };
    }

    const failedChecksByRunId = Object.fromEntries(records.map((r) => [r.run_id, localIntegrityByRunId[r.run_id].failedChecks]));
    const unexpectedToolUsesCountByRunId = Object.fromEntries(records.map((r) => [r.run_id, localIntegrityByRunId[r.run_id].unexpectedToolUsesCount]));
    const unexpectedToolsByRunId = Object.fromEntries(records.map((r) => [r.run_id, localIntegrityByRunId[r.run_id].unexpectedTools]));
    const foreignSkillNamesByRunId = Object.fromEntries(
      records.map((r, i) => [r.run_id, conditionResults[i].observation.skill.foreignInvocations.map((u) => u.skillReference).filter((s) => s != null)]),
    );
    const correlationObservabilityByRunId = Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].correlationObservability]));
    const preInferenceFailureByRunId = Object.fromEntries(records.map((r, i) => [r.run_id, summarizePreInferenceFailure(conditionResults[i].observation)]));
    const cellMetricsByRunId = Object.fromEntries(records.map((r) => [r.run_id, buildRejectedCellMetrics(r)]));
    // Derived from conditionResults[i].cellOrdinal -- the journal's own authoritative per-cell
    // ordinal (always stamped by runSingleCondition, present regardless of whether a journal is
    // actually threaded through) -- never array index `i`. Post-Codex-audit fix (PR #418): under
    // today's construction records/conditionResults happen to be pushed in strict orderIndex
    // sequence, so `i` and cellOrdinal always coincide in practice -- but the discard decision at
    // journalRawExactlyMatchesRejectionManifest now depends directly on this manifest being
    // trustworthy, and deriving it from the authoritative source removes an unverified implicit
    // invariant rather than relying on array-construction order never changing.
    const captureOrdinalByRunId = Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].cellOrdinal]));
    const { stderrByRunId, stderrReadError } = buildStderrByRunId(journal, captureOrdinalByRunId);

    const forensics = await writeRejectionForensics({
      runKind, records, failedChecksByRunId, unexpectedToolUsesCountByRunId, unexpectedToolsByRunId,
      foreignSkillNamesByRunId, correlationObservabilityByRunId, preInferenceFailureByRunId, cellMetricsByRunId, terminalEvidenceByRunId, transcriptsByRunId, captureOrdinalByRunId,
      ambientProfileMatrixOk: null, plannedCellCount, executedCellCount,
      privatePatternsFile, runsRootOverride, stderrByRunId, stderrReadError,
    });
    return { ok: false, reason: failFastStop?.reason ?? `scenario matrix stopped early after a local per-cell integrity failure (${executedCellCount}/${plannedCellCount} cells executed)`, ...forensics };
  }

  const completenessGap = completenessCheckFn != null ? completenessCheckFn(records) : findMatrixCompletenessGap(records, repeats);
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
  const stalePolicy = findStalePolicyHash(records.map((record, i) => [`[${i}]`, record]), freshHash);
  if (stalePolicy) {
    return { ok: false, reason: stalePolicy };
  }

  // Gate decision -- BEFORE schema validation and BEFORE any accepted-audit-sidecar work (see this
  // function's own doc comment for why). A rejection returns here, unconditionally: nothing below
  // this point (schema validation, sidecar build/cross-validation) can ever suppress gate.reason
  // or prevent rejection forensics from running.
  const gate = hardGateFn(records, conditionResults);
  if (!gate.ok) {
    // Privacy-safe rejected-run diagnostics (closes BACKLOG.md's "leave no auditable trace" gap)
    // -- gate.cellResults (scenarioHardGate's own field) already correlates every cell to its own
    // failedChecks/unexpectedToolUsesCount/unexpectedTools, so this is pure reshaping, never a
    // second gate re-run or a transcript reparse. A forensics-write failure must never mask the
    // ORIGINAL rejection reason or crash the caller. rejectionId/diagnosticsRelativePath stay null
    // unless the write actually succeeded -- see the pair-based finalizeAndWriteRecords' identical
    // rationale.
    const failedChecksByRunId = Object.fromEntries((gate.cellResults ?? []).map((c) => [c.runId, c.failedChecks]));
    const unexpectedToolUsesCountByRunId = Object.fromEntries((gate.cellResults ?? []).map((c) => [c.runId, c.unexpectedToolUsesCount]));
    const unexpectedToolsByRunId = Object.fromEntries((gate.cellResults ?? []).map((c) => [c.runId, c.unexpectedTools]));
    const foreignSkillNamesByRunId = Object.fromEntries(
      records.map((r, i) => [r.run_id, conditionResults[i].observation.skill.foreignInvocations.map((u) => u.skillReference).filter((s) => s != null)]),
    );
    const correlationObservabilityByRunId = Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].correlationObservability]));
    const preInferenceFailureByRunId = Object.fromEntries(records.map((r, i) => [r.run_id, summarizePreInferenceFailure(conditionResults[i].observation)]));
    const cellMetricsByRunId = Object.fromEntries(records.map((r) => [r.run_id, buildRejectedCellMetrics(r)]));
    // Derived from conditionResults[i].cellOrdinal -- the journal's own authoritative per-cell
    // ordinal (always stamped by runSingleCondition, present regardless of whether a journal is
    // actually threaded through) -- never array index `i`. Post-Codex-audit fix (PR #418): under
    // today's construction records/conditionResults happen to be pushed in strict orderIndex
    // sequence, so `i` and cellOrdinal always coincide in practice -- but the discard decision at
    // journalRawExactlyMatchesRejectionManifest now depends directly on this manifest being
    // trustworthy, and deriving it from the authoritative source removes an unverified implicit
    // invariant rather than relying on array-construction order never changing.
    const captureOrdinalByRunId = Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].cellOrdinal]));
    const { stderrByRunId, stderrReadError } = buildStderrByRunId(journal, captureOrdinalByRunId);
    // ambientProfileMatrixOk (correction 6): scenarioHardGate's own matrix-wide consensus result
    // (gate.ambientProfileMatrixOk, exposed on its return value) -- threaded straight through, so
    // a rejection diagnostic for a COMPLETE scenario batch always records whether the ambient-
    // profile consensus itself held, distinct from any individual cell's own failed_checks.
    const forensics = await writeRejectionForensics({
      runKind, records, failedChecksByRunId, unexpectedToolUsesCountByRunId, unexpectedToolsByRunId,
      foreignSkillNamesByRunId, correlationObservabilityByRunId, preInferenceFailureByRunId, cellMetricsByRunId, terminalEvidenceByRunId, transcriptsByRunId, captureOrdinalByRunId,
      ambientProfileMatrixOk: gate.ambientProfileMatrixOk,
      privatePatternsFile, runsRootOverride, stderrByRunId, stderrReadError,
    });
    return { ok: false, reason: gate.reason, ...forensics };
  }

  const eligible = scenarioMatrixIsBenchmarkEligible(records, gate);
  for (const record of records) record.benchmark_eligible = eligible;

  // Validate the ORIGINAL, unredacted records FIRST (Codex round 2, Finding 3) -- catches a
  // producer-generated defect (e.g. an invalid enum value) BEFORE any redaction rule ever touches
  // it. Without this, a private rule that coincidentally launders an invalid value into a valid
  // one would silently promote a record attributing a state the producer never actually
  // generated -- schema validation would only ever see the POST-redaction (laundered) value.
  // accepted_audit genuinely does not exist yet at this point (buildSidecarsFn has not run) --
  // validated here against a placeholder that is structurally valid but never the real sidecar
  // hash (schema/relative_path/sha256 are the only 3 keys validateRun's own shape check inspects;
  // relative_path is computed for real since it is a pure function of run_id alone), so this pass
  // can check every OTHER field without a false "accepted_audit missing" rejection that would
  // otherwise fire on every scenario record, always, regardless of any real defect. The placeholder
  // is local to this validation call only -- never written anywhere, never mixed into `records`.
  for (const [i, record] of records.entries()) {
    const needsPlaceholderAudit = record.schema >= 5 && record.run_kind === 'scenario' && record.accepted_audit == null;
    const preValidationRecord = needsPlaceholderAudit
      ? { ...record, accepted_audit: { schema: expectedAcceptedAuditSchemaFor(record), relative_path: acceptedAuditRelativePathFor(record.run_id), sha256: '0'.repeat(64) } }
      : record;
    const { errors } = validateRun(preValidationRecord);
    if (errors.length > 0) {
      return { ok: false, reason: `Run record [${i}] (repetition ${record.repetition_index}, ${record.condition}) failed pre-redaction schema validation: ${JSON.stringify(errors)}` };
    }
  }

  // Redact FIRST -- before any accepted-audit/provenance work ever touches a record (P1
  // architectural review). A sidecar's run_provenance_sha256 (and every other accepted_audit
  // field) must be computed from the record that actually gets promoted: the redacted one.
  // Building the sidecar from the UNREDACTED record, then redacting afterward (the old order),
  // made final cross-validation structurally impossible to ever pass for a record where a
  // private-pattern rule happens to touch a provenance-bound field -- the stored hash would
  // forever disagree with what a re-read of the final, redacted record recomputes.
  let redactedRecords = [];
  let redactedTexts = [];
  try {
    for (const record of records) {
      const { redactedObj, redactedText } = assertCleanOrThrowObject(record, { privatePatternsFile });
      redactedRecords.push(redactedObj);
      redactedTexts.push(redactedText);
    }
  } catch (err) {
    return { ok: false, reason: `Privacy check refused to clear evidence for writing: ${err.message}` };
  }

  // Accepted-audit sidecar work -- ONLY reached once gate.ok is confirmed true, and now built FROM
  // the already-redacted records. buildSidecarsFn builds+finalizes+attaches record.accepted_audit
  // for every record (cmdRun supplies the closure, mutating each redactedRecords[i] in place); a
  // failure here means promotion cannot proceed (the sidecar contract can't be satisfied), but it
  // is never confused with a gate rejection -- writeRejectedRunDiagnostics is never called for
  // this failure class, matching how a privacy-check-refusal failure above is also never treated
  // as a rejection.
  let sidecarTexts = null;
  if (buildSidecarsFn != null) {
    const sidecarBuild = await buildSidecarsFn(redactedRecords, conditionResults);
    if (!sidecarBuild.ok) {
      return { ok: false, reason: `Cannot promote: ${sidecarBuild.reason}` };
    }
    sidecarTexts = sidecarBuild.sidecarTexts;
    // accepted_audit was just attached in place onto each redactedRecords[i] -- re-redact-and-
    // verify (never merely re-serialize) so redactedTexts keeps the SAME leak-verified guarantee
    // for the newly-added field, rather than assuming it's safe because it "looks like" only a
    // schema number/path/hash. accepted_audit's own 3 fields are never provenance-bound (see this
    // function's own header on why provenance excludes accepted_audit), so this second pass over
    // an already-redacted object cannot itself perturb anything the sidecar already hashed.
    //
    // Codex round 2, Finding 2: BOTH results of this second pass must replace redactedRecords AND
    // redactedTexts together -- keeping only the fresh redactedText while discarding the fresh
    // redactedObj (the old bug) left every check below (schema validation, cross-validation)
    // running against the STALE, pre-second-pass object, while the ACTUAL text about to be written
    // to disk came from a DIFFERENT, more-redacted object. A private rule that happens to match
    // something inside accepted_audit itself (e.g. its own relative_path) would then validate one
    // object while persisting another -- the exact class of bug this reassignment closes.
    try {
      const updatedRedactedRecords = [];
      const updatedRedactedTexts = [];
      for (const record of redactedRecords) {
        const { redactedObj, redactedText } = assertCleanOrThrowObject(record, { privatePatternsFile });
        updatedRedactedRecords.push(redactedObj);
        updatedRedactedTexts.push(redactedText);
      }
      redactedRecords = updatedRedactedRecords;
      redactedTexts = updatedRedactedTexts;
    } catch (err) {
      return { ok: false, reason: `Privacy check refused to clear evidence for writing: ${err.message}` };
    }
  }

  for (const [i, record] of redactedRecords.entries()) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      return { ok: false, reason: `Run record [${i}] (repetition ${record.repetition_index}, ${record.condition}) failed schema validation: ${JSON.stringify(errors)}` };
    }
  }
  // accepted_audit binding + cross-validation (accepted-run-observability PR, privacy/binding
  // steps 7-8): sidecarTexts[i] is the ALREADY build->redact->hash'd sidecar text buildSidecarsFn
  // produced above, built from the already-redacted record. Cross-validate the FINAL redacted
  // record against it -- catches a redaction pass that somehow touched accepted_audit's own
  // sha256/relative_path (never expected in practice, since neither is a private-pattern-shaped
  // value, but this is the one point in the pipeline that can still prove the binding survived
  // intact before anything is written). This can only ever run on the confirmed gate-passing path
  // now, so a mismatch here is unambiguously a "cannot promote" failure, never confusable with (or
  // reported instead of) a gate rejection.
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
    const rawTexts = records.map((r) => transcriptsByRunId[r.run_id]);
    writeRunMatrixRecordEvidence(runKind, records, rawTexts, redactedTexts, runsRootOverride, sidecarTexts);
  } catch (err) {
    return { ok: false, reason: `Evidence write refused: ${err.message}` };
  }
  return { ok: true, reason: null, outDir, redactedOutDir, redactedRecords };
}

// evaluateNamedChecks moved to cell-integrity.mjs (imported above) -- cellTranscriptIntegrityOk
// (the fail-fast hook's own canonical check function) needs it too, and cell-integrity.mjs cannot
// import FROM cli.mjs.

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
  const obsA = runAResult.observation;
  const obsB = runBResult.observation;
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
  const skillSelectionOkA = obsA.skill.foreignInvocations.length === 0;
  const skillSelectionOkB = obsB.skill.foreignInvocations.length === 0;
  // Regression coverage for a real gap an independent review pass demonstrated: neither
  // isSkillAvailable nor hasExpectedToolProfile ever inspects the init event's OWN plugins[]
  // array -- an unexpected third-party plugin loaded alongside (or instead of) the intended one
  // went completely undetected. A must load exactly zero plugins; B must load exactly one,
  // named kmp-test-runner -- no duplicates, no extras.
  const pluginProfileOkA = obsA.skill.profileMatchesCondition;
  const pluginProfileOkB = obsB.skill.profileMatchesCondition;
  // Regression coverage for a real evidence-contamination bypass an independent review pass
  // demonstrated: pluginProfileOk only checks the loaded plugin's NAME, never its path -- a
  // same-named "kmp-test-runner" plugin loaded from a completely unrelated directory satisfied
  // it outright, while the record still published skill_source_sha as the pinned SHA regardless.
  // See runtimes/claude-code.mjs's isPluginBoundToSnapshot doc comment for the full rationale.
  // Only meaningful for B (the no-skill arm never loads a plugin at all, per pluginProfileOk
  // above) -- obsB.skill.snapshotBindingMatches was computed by the adapter at normalization time
  // against context.expectedSnapshotDir, which the caller only ever supplies for current-skill.
  const pluginSnapshotBindingOk = obsB.skill.snapshotBindingMatches;
  // Regression coverage for a real gap an independent review pass demonstrated: findInitEvent/
  // findResultEvent/findIncompleteToolResults all either take "the first" event of a kind or only
  // check "at least one" correlation exists -- neither catches a transcript with a SECOND,
  // contradictory init+result pair appended after a legitimate first one, or two tool_use blocks
  // sharing one id satisfied by a single tool_result. See findTranscriptStructuralIssues's own
  // doc comment for the full rationale. Strict (never effective/timeout-tolerant) -- calibrate has
  // no legitimate reason to ever time out mid-diagnostic-command.
  const transcriptStructureOkA = obsA.transcript.strictStructuralIssues.length === 0;
  const transcriptStructureOkB = obsB.transcript.strictStructuralIssues.length === 0;
  // A session that never emitted an init event at all is a fundamentally broken/incomplete
  // capture, not a legitimately-observed "skill unavailable" -- without this check, a run with
  // NO init event could still show skill_available:false for the no-skill arm (nothing to derive
  // it from) and happen to match the EXPECTED value there by coincidence, passing availabilityOk
  // for the wrong reason entirely.
  const initOkA = obsA.session.initPresent;
  const initOkB = obsB.session.initPresent;
  // The init event's OWN declared profile must match exactly what this harness actually
  // launches with -- proves a genuinely narrow session, not just that ONE happened to arrive.
  const toolProfileOkA = obsA.session.toolProfileMatchesExpected;
  const toolProfileOkB = obsB.session.toolProfileMatchesExpected;
  // No tool_use ANYWHERE in the transcript may name anything outside Bash/Skill -- a
  // transcript could otherwise use some other tool (e.g. Read) alongside the expected calls and
  // still pass every other check. summarizeUnexpectedToolUses (cell-integrity.mjs) is the single
  // implementation of this projection in the whole repo -- calibrationHardGate/smokeHardGate/
  // scenarioCellIntegrityOk all call it rather than each hand-rolling their own {name, event_index}
  // mapping over the observation's own toolAttempts[].profileAllowed field.
  const unexpectedToolsA = summarizeUnexpectedToolUses(obsA.toolAttempts);
  const unexpectedToolsB = summarizeUnexpectedToolUses(obsB.toolAttempts);
  const noUnexpectedToolsOkA = unexpectedToolsA.ok;
  const noUnexpectedToolsOkB = unexpectedToolsB.ok;
  const processOkA = a.terminated === false && a.exit_code === 0;
  const processOkB = b.terminated === false && b.exit_code === 0;
  // resultSubtype==='success' (not just isError===false) -- a session cut off by e.g. the budget
  // cap reports a distinct resultSubtype (confirmed: 'error_max_budget_usd') that is NOT
  // necessarily paired with isError:true, so isError alone doesn't prove the session ran to a
  // genuine, uninterrupted completion.
  const resultOkA = obsA.terminal.resultSubtype === 'success' && obsA.terminal.isError === false;
  const resultOkB = obsB.terminal.resultSubtype === 'success' && obsB.terminal.isError === false;
  // PR 4: policyMode:"not_applicable" never wires a PreToolUse hook at all, so
  // hookStats.everyCallHooked is always false there (0 !== real Bash count) -- the equivalent
  // proof under that profile is the canonical per-attempt dispatch accounting (identical to the
  // scenario path), computed once by runConditionPair and attached to runAResult/runBResult
  // whenever policy does not apply. Strict (policyApplies) keeps the pre-existing aggregate proof,
  // byte-for-byte.
  const policyApplies = a.execution_profile?.policy_mode !== 'not_applicable';
  const hookAccountingOkA = policyApplies
    ? obsA.hookStats.everyCallHooked === true
    : runAResult.dispatchAccounting?.everyCallAccountedFor === true;
  const hookAccountingOkB = policyApplies
    ? obsB.hookStats.everyCallHooked === true
    : runBResult.dispatchAccounting?.everyCallAccountedFor === true;
  // Regression coverage for a real gap an independent review pass demonstrated: findSkillInvocation
  // correctly reports confirmed:false for a Skill attempt with NO correlated tool_result at all
  // (transcript cut short before a result arrived), but the gate previously treated
  // attempted:true/invoked:false uniformly as a "clean" no-skill shape -- a dangling attempt is an
  // INCOMPLETE capture, not a demonstrated Unknown-skill rejection, and must not be silently
  // accepted as equivalent. Scans every tool attempt (Bash included -- calibration has no
  // per-command result check of its own, unlike smoke's exactCommandsOk). Strict, same rationale
  // as transcriptStructureOk above.
  const toolResultsCompleteOkA = obsA.transcript.strictIncompleteToolResults.length === 0;
  const toolResultsCompleteOkB = obsB.transcript.strictIncompleteToolResults.length === 0;
  // Only smokeHardGate had this check until now -- a malformed/truncated JSONL line could hide
  // exactly a Skill tool_use or its result, artificially producing attempted:false for A, which
  // the relaxed no-skill contract now legitimately tolerates. Calibration needs the same
  // protection smoke already has.
  const cleanTranscriptOkA = obsA.transcript.malformedLineCount === 0;
  const cleanTranscriptOkB = obsB.transcript.malformedLineCount === 0;
  // Review-round-2 fix (correction 4): a missing/malformed init.skills[] previously let
  // buildRunRecord silently report a "valid" {count:0, ...} ambient_skill_profile even though the
  // underlying data was genuinely unknown, not a real, verified empty ambient set -- calibration/
  // smoke never checked this at all (only scenarioCellIntegrityOk did). Same condition-aware
  // target-identity handling as scenario's own gate (correction 1): A must show ZERO target
  // references in skills[] (never merely zero confirmed invocations), B may show exactly one.
  // Calibration/smoke's OWN skillSelectionOk (zero-tolerance for any foreign call, confirmed or
  // not) is deliberately left completely untouched -- this only ADDS the two new checks below, it
  // never relaxes the existing ones. Already computed once, by the adapter, at normalization time.
  const ambientSkillProfileOkA = obsA.skill.ambient.structurallyWellFormed;
  const ambientSkillProfileOkB = obsB.skill.ambient.structurallyWellFormed;
  const targetSkillAmbientIdentityOkA = obsA.skill.ambient.targetIdentityOk;
  const targetSkillAmbientIdentityOkB = obsB.skill.ambient.targetIdentityOk;

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
    reason: ok ? null : `calibration hard gate failed -- A:{${joinChecks(checksA)}} B:{${joinChecks(checksB)}} (A:{available:${a.skill_available.value},attempted:${a.skill_invocation_attempted.value},invoked:${a.skill_invoked.value},terminated:${a.terminated},exit_code:${a.exit_code},result_subtype:${obsA.terminal.resultSubtype},result_is_error:${obsA.terminal.isError},everyCallHooked:${obsA.hookStats.everyCallHooked},toolProfileMatchesExpected:${obsA.session.toolProfileMatchesExpected}} B:{available:${b.skill_available.value},attempted:${b.skill_invocation_attempted.value},invoked:${b.skill_invoked.value},terminated:${b.terminated},exit_code:${b.exit_code},result_subtype:${obsB.terminal.resultSubtype},result_is_error:${obsB.terminal.isError},everyCallHooked:${obsB.hookStats.everyCallHooked},toolProfileMatchesExpected:${obsB.session.toolProfileMatchesExpected}})`,
    failedChecksA: evalA.failedChecks,
    failedChecksB: evalB.failedChecks,
    unexpectedToolUsesCountA: unexpectedToolsA.count,
    unexpectedToolUsesCountB: unexpectedToolsB.count,
    unexpectedToolsA: unexpectedToolsA.tools,
    unexpectedToolsB: unexpectedToolsB.tools,
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
  // Deliberately NOT delegated to the shared evaluation below (shared.checksByName.availabilityOk/
  // noSkillSafetyOk) -- kept reading directly off the already-built `record` because several
  // existing tests mutate record.skill_available.value/record.skill_invoked.value to prove these
  // two checks fail; delegating would silently stop honoring that mutation (CLAUDE.md: never
  // weaken an existing test). Provably equivalent to the shared evaluation's own computation in
  // production: buildRunRecord copies both fields verbatim (nullableMetric(isSkillAvailable(...)),
  // nullableMetric(invocation?.confirmed ?? false)) from the exact same primitives
  // cell-integrity.mjs's cellTranscriptIntegrityOk uses -- see that function's own doc comment.
  //
  // Post-#385 review finding: a no-skill condition's plugin is never loaded (availabilityOk/
  // pluginProfileOk already prove this), but a CONFIRMED invocation could still slip through some
  // OTHER route (an environmental same-named skill, a Claude Code inconsistency) -- now that
  // isTargetSkillReference correctly recognizes both the bare and plugin-namespaced forms as the
  // TARGET skill, skillSelectionOk (which only catches a FOREIGN invocation) no longer catches
  // this. A confirmed no-skill invocation is real evidence-contamination, mirroring
  // calibrationHardGate's own noSkillSafetyOk exactly. current-skill is deliberately exempt --
  // whether the skill triggers naturally on a scenario prompt is part of what's being MEASURED,
  // not a harness precondition (unchanged from this function's original design).
  const availabilityOk = record.skill_available.value === expectSkillAvailable;
  const noSkillSafetyOk = expectSkillAvailable || record.skill_invoked.value === false;

  // The canonical per-cell evaluation (cell-integrity.mjs) -- the SAME function the fail-fast hook
  // (matrix-runner.mjs's runScenarioMatrix loop) already ran on this exact conditionResult earlier
  // in this cell's lifecycle. Supplies 13 of the remaining 20 checks below via `checksByName`,
  // plus `foreignSkillUses` (reused for skillSelectionOk, never re-scanned) and the
  // unexpectedToolUsesCount/unexpectedTools structural detail this rejection-diagnostics fix needs
  // propagated, without reparsing anything.
  // requireDispatchAccounting:true -- this is the scenario path, so hookAccountingOk must be proven
  // by the canonical per-tool_use_id dispatch accounting, exactly as the fail-fast hook proved it.
  // Passing false here would let the final gate accept a cell on weaker evidence than the fail-fast
  // check already applied to that same cell.
  const shared = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: true });

  // Ambient-skill-profile fix: a real live run's no-skill cells were wrongly rejected for
  // confirming Claude Code's own bundled "run" skill -- present in init.skills[] regardless of
  // --plugin-dir (see isSkillAvailable's doc comment, stream-parser.mjs), not genuine third-party
  // contamination. A CONFIRMED foreign call is now tolerated ONLY when its exact skillReference was
  // advertised in `sharedAmbientNames` -- the matrix-wide consensus ambient profile scenarioHardGate
  // computes across every cell (never a hardcoded "run" special-case; a malformed/missing
  // skillReference, or one absent from that set, still fails closed exactly as before). This is
  // exactly why skillSelectionOk is EXCLUDED from cell-integrity.mjs's own canonical evaluation (it
  // needs `sharedAmbientNames`, a matrix-wide value that doesn't exist mid-matrix during fail-fast)
  // and must still be computed here, where the real value is available.
  const confirmedForeignSkillUses = shared.foreignSkillUses.filter((u) => u.confirmed === true);
  const skillSelectionOk = confirmedForeignSkillUses.every((u) => u.skillReference != null && sharedAmbientNames.has(u.skillReference));
  const junitEvidenceOk = !(record.errors ?? []).some((e) => e.code === 'ambiguous_junit_evidence');
  const parallelEvidenceOk = !(record.errors ?? []).some((e) => e.code === 'malformed_parallel_evidence');
  // The identical treatment as parallelEvidenceOk above, for the changed-subcommand sibling.
  const changedEvidenceOk = !(record.errors ?? []).some((e) => e.code === 'malformed_changed_evidence');
  const junitSkipEvidenceOk = !(record.errors ?? []).some((e) => e.code === 'unreliable_gradle_junit_evidence');
  // Per-attempt JUnit-evidence-attribution mechanism ("bind junit evidence to authoritative
  // attempts" fix): junit_evidence_capture_incomplete is a DISTINCT, never-merged code from
  // ambiguous_junit_evidence -- a capture-mechanism failure (a missing/incoherent decision record
  // for any relevant attempt, or a missing Gradle evidence record) is a different problem from a
  // proven same-turn concurrency conflict, and each gets its own independently-toggleable check.
  // These 5 checks (junitEvidenceOk/parallelEvidenceOk/changedEvidenceOk/junitSkipEvidenceOk/
  // junitCaptureCompleteOk), like availabilityOk/noSkillSafetyOk above, are also EXCLUDED from
  // cell-integrity.mjs's canonical evaluation -- they read `record.errors`, populated only once
  // grading/buildRunRecord runs (after the fail-fast loop, not during it).
  const junitCaptureCompleteOk = !(record.errors ?? []).some((e) => e.code === 'junit_evidence_capture_incomplete');

  const evaluation = evaluateNamedChecks([
    ['availabilityOk', availabilityOk], ['noSkillSafetyOk', noSkillSafetyOk],
    ['pluginProfileOk', shared.checksByName.pluginProfileOk],
    ['pluginSnapshotBindingOk', shared.checksByName.pluginSnapshotBindingOk], ['skillSelectionOk', skillSelectionOk],
    ['foreignSkillToolResultsCompleteOk', shared.checksByName.foreignSkillToolResultsCompleteOk], ['initOk', shared.checksByName.initOk],
    ['toolProfileOk', shared.checksByName.toolProfileOk], ['noUnexpectedToolsOk', shared.checksByName.noUnexpectedToolsOk],
    ['hookAccountingOk', shared.checksByName.hookAccountingOk], ['cleanTranscriptOk', shared.checksByName.cleanTranscriptOk],
    ['transcriptStructureOk', shared.checksByName.transcriptStructureOk], ['toolResultsCompleteOk', shared.checksByName.toolResultsCompleteOk],
    ['terminationOk', shared.checksByName.terminationOk], ['junitEvidenceOk', junitEvidenceOk],
    ['parallelEvidenceOk', parallelEvidenceOk], ['changedEvidenceOk', changedEvidenceOk],
    ['junitSkipEvidenceOk', junitSkipEvidenceOk],
    ['junitCaptureCompleteOk', junitCaptureCompleteOk],
    ['ambientSkillProfileOk', shared.checksByName.ambientSkillProfileOk], ['targetSkillAmbientIdentityOk', shared.checksByName.targetSkillAmbientIdentityOk],
    ['ambientProfileMatrixOk', ambientProfileMatrixOk],
    // Deliberately NOT `shared.checksByName.noPreInferenceFailureOk`-only-by-spread: this array is
    // hand-built (never Object.entries(shared.checksByName)), so a check added only inside
    // cellTranscriptIntegrityOk is computed but silently never enforced here unless it also gets
    // its own tuple -- exactly the gap that would let a pre-inference failure on the LAST planned
    // cell of a matrix (matrixComplete:true, the fail-fast break never fires) slip through this,
    // the only gate that still runs for that case.
    ['noPreInferenceFailureOk', shared.checksByName.noPreInferenceFailureOk],
  ]);
  return {
    ok: evaluation.ok, reason: evaluation.reason, failedChecks: evaluation.failedChecks,
    unexpectedToolUsesCount: shared.unexpectedToolUsesCount, unexpectedTools: shared.unexpectedTools,
  };
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
  // Already computed once, by the adapter, at normalization time (expectTargetPresent baked in
  // per-cell from that cell's own condition) -- no recomputation needed, same rationale as
  // calibrationHardGate/smokeHardGate's identical ambientSkillProfileOk/targetSkillAmbientIdentityOk
  // reuse.
  const ambientProfiles = conditionResults.map((cr) => cr.observation.skill.ambient);
  const allAmbientProfilesOk = ambientProfiles.every((p) => p.structurallyWellFormed && p.targetIdentityOk);
  const canonicalKeys = ambientProfiles.map((p) => canonicalNamesKey(p.names));
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
      unexpectedToolUsesCount: cell.unexpectedToolUsesCount,
      unexpectedTools: cell.unexpectedTools,
    });
    if (!cell.ok) {
      failures.push(`cell[${i}] (repetition ${records[i].repetition_index}, condition ${records[i].condition}): ${cell.reason}`);
    }
  }
  const ok = failures.length === 0;
  return { ok, reason: ok ? null : `scenario hard gate failed for ${failures.length}/${records.length} cell(s) -- ${failures.join(' || ')}`, cellResults, ambientProfileMatrixOk };
}

async function cmdCalibrate(args) {
  // Resolved first, before any other check -- the closed registry selection that determines
  // which runtime adapter this whole invocation uses (see resolveSelectionOrFail's own doc
  // comment). An unknown/disabled/incompatible id fails closed here, before auth, materialize, or
  // journal creation ever runs.
  const selectionResult = resolveSelectionOrFail(args);
  if (!selectionResult.ok) {
    console.error(selectionResult.reason);
    return 1;
  }
  const { runtime, model: modelEntry, executionProfile, adapter, executionProfileSha256 } = selectionResult.selection;
  const model = modelEntry.model_id;
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  const budgetCheck = resolveMaxBudgetUsdOrFail(args['max-budget-usd'] ?? null);
  if (!budgetCheck.ok) {
    console.error(budgetCheck.reason);
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
  // PR 4: resolved before any journal/materialization/auth/spawn -- see
  // resolveIsolationAttestationOrFail's own doc comment for the full fail-closed-both-directions
  // contract.
  const attestationCheck = resolveIsolationAttestationOrFail(args, { runtime, executionProfile });
  if (!attestationCheck.ok) {
    console.error(attestationCheck.reason);
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
  // Created before the first spawn, per invocation -- a write-ahead safety net independent of
  // whatever happens next. Preserved by default (never deleted) unless the command later proves
  // its own promotion (or a fully-persisted rejection) made it redundant.
  //
  // This call itself is guarded: isRawDirSafeFromAccidentalCommit fails closed against the REAL
  // default RUNS_ROOT (unlike every test here, which uses an isolated tmpdir outside any git repo
  // and never exercises this path) -- an unguarded throw here would escape uncaught past this
  // command's own contract, reproducing exactly the bug class this PR exists to close, one level
  // up. journal:null is valid input to finalizeIncident (treated as all-zero counts).
  let journal = null;
  try {
    journal = createInvocationJournal({ runKind: 'calibration', plannedCellCount: 2, privatePatternsFile });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'calibration', journal: null, phase: 'acquiring_shared_resources',
      reasonText: reasonTextFor(err),
      provenance: { model_requested: model, scenario_id: 'calibration-explicit-invocation' },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  }
  let conditionPair;
  try {
    conditionPair = await runConditionPair({
      prompt: CALIBRATE_PROMPT,
      model,
      allowedGradleTasks: ['build'],
      allowedKmpTestSubcommands: ['doctor', 'parallel'],
      materializeFixture: (existingDir) => materializeCalibrationProject({ templateDir, existingDir }),
      cleanupFixture: (fixtureDir) => rmSync(fixtureDir, { recursive: true, force: true }),
      journal,
      runtimeAdapter: adapter,
      executionProfile,
      maxBudgetUsd: budgetCheck.maxBudgetUsd,
    });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'calibration', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { model_requested: model, scenario_id: 'calibration-explicit-invocation' },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  }
  try {
    const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, matrixComplete: pairComplete, plannedCellCount, executedCellCount, failFastStop, skillSnapshotArtifact } = conditionPair;
    const policySha256 = computePolicySha256();
    // One HMAC key + opaque scope id for this ENTIRE calibrate invocation (correction 2) --
    // shared by both A and B so they remain comparable to each other, never persisted. Ephemeral
    // (freshly random) unless --measurement-scope-file supplied a stable one (resolved eagerly,
    // above, before any spawn -- see resolveMeasurementScopeOrFail's own doc comment).
    const { scopeId: ambientProfileScopeId, key: ambientProfileKey } = scopeCheck;
    // Schema v6: promptArtifact is computed ONCE from the exact literal prompt text runConditionPair
    // was called with above; skillSnapshotArtifact is resolved exactly once during resource
    // acquisition (acquireSharedEvalResources, AFTER materializeSkillSnapshot has backfilled the
    // pinned commit into a shallow CI checkout -- see matrix-runner.mjs's own doc comment) and
    // propagated back here on conditionPair, never recomputed by this command.
    const common = {
      runKind: 'calibration', scenarioId: 'calibration-explicit-invocation', skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, modelRequested: model, privacyStatus, ambientProfileScopeId, ambientProfileKey,
      selection: selectionResult.selection, promptArtifact: computePromptArtifact(CALIBRATE_PROMPT), skillSnapshotArtifact,
      isolationAttestationSha256: attestationCheck.sha256,
    };

    // Calibration's job is narrowly to prove invocation MECHANICS under an explicit-invocation
    // prompt -- see calibrationHardGate's own doc comment for why this is a named function.
    let result;
    // The authoritative run_id -> cellOrdinal binding -- derived from runB.cellOrdinal/
    // runA.cellOrdinal (each stamped by runSingleCondition itself), never hardcoded 0/1 constants
    // (post-Codex-audit fix, PR #418, round 3: journalRawExactlyMatchesRejectionManifest now
    // verifies each manifest entry's (run_id, ordinal) PAIR against this exact binding, not just
    // independent set membership).
    let runIdToCellOrdinal;
    if (!pairComplete) {
      // Fail-fast (preserve rejected matrix forensics): B already failed its own local integrity
      // check -- A was never spawned, so buildRunRecord({conditionResult: runA, ...}) would throw
      // on runA===null. Build only B's record and go straight to finalizeAndWriteRecords' own
      // fail-fast branch.
      const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });
      runIdToCellOrdinal = { [recordB.run_id]: runB.cellOrdinal };
      // Read-back (judgment call, §4/§5): each cell's promoted raw bytes are sourced from the
      // journal's own already-durable copy, keyed by cellOrdinal -- never the in-memory value,
      // never array position. finalizeAndWriteRecords requires this map complete and exact.
      const transcriptsByRunId = { [recordB.run_id]: readJournalRawFor(runB, journal) };
      result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA: null, recordB, runA: null, runB, privatePatternsFile,
        hardGateFn: calibrationHardGate, matrixComplete: false, plannedCellCount, executedCellCount, failFastStop, journal,
        transcriptsByRunId,
      });
    } else {
      const recordA = buildRunRecord({ conditionResult: runA, condition: 'no-skill', ...common });
      const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });
      runIdToCellOrdinal = { [recordB.run_id]: runB.cellOrdinal, [recordA.run_id]: runA.cellOrdinal };
      const transcriptsByRunId = { [recordB.run_id]: readJournalRawFor(runB, journal), [recordA.run_id]: readJournalRawFor(runA, journal) };
      result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA, recordB, runA, runB, privatePatternsFile,
        hardGateFn: calibrationHardGate, journal,
        transcriptsByRunId,
      });
    }
    if (!result.ok) {
      if (result.rejectionId == null) {
        // Not the well-handled gate-rejection path (schema/privacy/evidence-write refusal
        // instead) -- route through the same shared finalizer as an exception would get.
        const incidentResult = finalizeIncident({
          runKind: 'calibration', journal, phase: 'finalizing_matrix', reasonText: result.reason,
          provenance: { model_requested: model, scenario_id: 'calibration-explicit-invocation' },
          privatePatternsFile,
        });
        reportIncident(incidentResult);
      } else {
        console.error(`CALIBRATION FAILED: ${result.reason}`);
        printRejectionForensicsStderr(result);
      }
      discardJournalIfRedundant(journal, result, runIdToCellOrdinal);
      return 1;
    }
    discardJournalIfRedundant(journal, result, runIdToCellOrdinal);
    console.log(JSON.stringify({ recordA: result.redactedRecordA, recordB: result.redactedRecordB, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'calibration', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { model_requested: model, scenario_id: 'calibration-explicit-invocation' },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
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
  const obsA = runAResult.observation;
  const obsB = runBResult.observation;
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
  // kmp-test-runner. Deliberately still the plain, argument-only foreignInvocations projection --
  // smoke's contract is untouched by this change.
  const skillSelectionOkA = obsA.skill.foreignInvocations.length === 0;
  const skillSelectionOkB = obsB.skill.foreignInvocations.length === 0;
  // See calibrationHardGate's identical check and doc comment -- neither isSkillAvailable nor
  // hasExpectedToolProfile ever inspects the init event's own plugins[] array.
  const pluginProfileOkA = obsA.skill.profileMatchesCondition;
  const pluginProfileOkB = obsB.skill.profileMatchesCondition;
  // See calibrationHardGate's identical check and doc comment -- pluginProfileOk never checks
  // the loaded plugin's own path, only its name/count.
  const pluginSnapshotBindingOk = obsB.skill.snapshotBindingMatches;
  // See calibrationHardGate's identical check and doc comment -- neither findInitEvent/
  // findResultEvent (take "the first" of a kind) nor findIncompleteToolResults (only checks "at
  // least one" correlation) catch a second contradictory init+result pair, or duplicated
  // tool_use ids satisfied by a single tool_result. Strict, same rationale as calibrate.
  const transcriptStructureOkA = obsA.transcript.strictStructuralIssues.length === 0;
  const transcriptStructureOkB = obsB.transcript.strictStructuralIssues.length === 0;
  // See calibrationHardGate's identical check -- a session with no init event at all is a
  // broken/incomplete capture, not legitimately-observed data.
  const initOkA = obsA.session.initPresent;
  const initOkB = obsB.session.initPresent;
  // See calibrationHardGate's identical checks -- the init event's OWN declared profile must
  // match what this harness actually launches with, and no tool_use anywhere in the transcript
  // may name anything outside Bash/Skill.
  const toolProfileOkA = obsA.session.toolProfileMatchesExpected;
  const toolProfileOkB = obsB.session.toolProfileMatchesExpected;
  // summarizeUnexpectedToolUses (cell-integrity.mjs) -- see calibrationHardGate's identical check
  // and doc comment; the single implementation of this projection in the whole repo.
  const unexpectedToolsA = summarizeUnexpectedToolUses(obsA.toolAttempts);
  const unexpectedToolsB = summarizeUnexpectedToolUses(obsB.toolAttempts);
  const noUnexpectedToolsOkA = unexpectedToolsA.ok;
  const noUnexpectedToolsOkB = unexpectedToolsB.ok;
  const processOkA = a.terminated === false && a.exit_code === 0;
  const processOkB = b.terminated === false && b.exit_code === 0;
  // resultSubtype==='success' (not just isError===false) -- see calibrationHardGate's identical
  // check; a budget-cap-truncated session is not a genuine completion even when isError is
  // false for that particular subtype.
  const resultOkA = obsA.terminal.resultSubtype === 'success' && obsA.terminal.isError === false;
  const resultOkB = obsB.terminal.resultSubtype === 'success' && obsB.terminal.isError === false;
  // PR 4: see calibrationHardGate's identical policyApplies/hookAccountingOk rationale.
  const policyApplies = a.execution_profile?.policy_mode !== 'not_applicable';
  const hookAccountingOkA = policyApplies
    ? obsA.hookStats.everyCallHooked === true
    : runAResult.dispatchAccounting?.everyCallAccountedFor === true;
  const hookAccountingOkB = policyApplies
    ? obsB.hookStats.everyCallHooked === true
    : runBResult.dispatchAccounting?.everyCallAccountedFor === true;
  // hook_call_count>=1 proves the agent actually tried real commands; hook_deny_count===0 proves
  // every command it tried was inside the approved grammar; hookAllowCount matching
  // hook_call_count proves every decision was explicitly "allow", not merely "not deny" (a
  // hook_response with unparseable `output` JSON produces neither an allow nor a deny decision --
  // hook_deny_count===0 alone would silently accept that). Under policyMode:"not_applicable" there
  // is no policy decision at all -- the equivalent proof of real (non-fabricated) work is at least
  // one Bash attempt with a genuinely correlated tool_result (dispatch_status:
  // result_correlated_no_policy), from the identical per-attempt accounting hookAccountingOk above
  // already trusts.
  const realWorkOkA = policyApplies
    ? a.hook_call_count >= 1 && a.hook_deny_count === 0 && obsA.hookStats.hookAllowCount === a.hook_call_count
    : (runAResult.dispatchAccounting?.resultCorrelatedNoPolicyCount ?? 0) >= 1;
  const realWorkOkB = policyApplies
    ? b.hook_call_count >= 1 && b.hook_deny_count === 0 && obsB.hookStats.hookAllowCount === b.hook_call_count
    : (runBResult.dispatchAccounting?.resultCorrelatedNoPolicyCount ?? 0) >= 1;
  // Requires the EXACT expected multiset (both commands, --json included, exactly once each, no
  // extras) -- see verifyExactCommandsSucceeded's own doc comment. Reconstructs the legacy
  // {command, resultFound, resultIsError} shape it expects from the canonical toolAttempts[].
  const bashResultsA = selectShellAttempts(obsA.toolAttempts).map((att) => ({ command: att.command, resultFound: att.result.found, resultIsError: att.result.isError }));
  const bashResultsB = selectShellAttempts(obsB.toolAttempts).map((att) => ({ command: att.command, resultFound: att.result.found, resultIsError: att.result.isError }));
  const exactCommandsOkA = verifyExactCommandsSucceeded(bashResultsA, SMOKE_EXPECTED_COMMANDS);
  const exactCommandsOkB = verifyExactCommandsSucceeded(bashResultsB, SMOKE_EXPECTED_COMMANDS);
  const cleanTranscriptOkA = obsA.transcript.malformedLineCount === 0;
  const cleanTranscriptOkB = obsB.transcript.malformedLineCount === 0;
  // See calibrationHardGate's identical check and doc comment -- a dangling tool_use with no
  // correlated tool_result is an incomplete capture, not a demonstrated outcome. Strict.
  const toolResultsCompleteOkA = obsA.transcript.strictIncompleteToolResults.length === 0;
  const toolResultsCompleteOkB = obsB.transcript.strictIncompleteToolResults.length === 0;
  // See calibrationHardGate's identical check and doc comment (review-round-2 fix, correction 4) --
  // a missing/malformed init.skills[] must not silently pass as a "verified empty" ambient
  // profile, and A's skills[] must show zero target references (condition-aware, correction 1).
  // smoke's own skillSelectionOk (zero-tolerance) is untouched. Already computed once, by the
  // adapter, at normalization time.
  const ambientSkillProfileOkA = obsA.skill.ambient.structurallyWellFormed;
  const ambientSkillProfileOkB = obsB.skill.ambient.structurallyWellFormed;
  const targetSkillAmbientIdentityOkA = obsA.skill.ambient.targetIdentityOk;
  const targetSkillAmbientIdentityOkB = obsB.skill.ambient.targetIdentityOk;

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
    reason: ok ? null : `smoke hard gate failed -- A:{${joinChecks(checksA)}} B:{${joinChecks(checksB)}} (A hook_call_count:${a.hook_call_count} hook_deny_count:${a.hook_deny_count} hookAllowCount:${obsA.hookStats.hookAllowCount} result_subtype:${obsA.terminal.resultSubtype} toolProfileMatchesExpected:${obsA.session.toolProfileMatchesExpected}, B hook_call_count:${b.hook_call_count} hook_deny_count:${b.hook_deny_count} hookAllowCount:${obsB.hookStats.hookAllowCount} result_subtype:${obsB.terminal.resultSubtype} toolProfileMatchesExpected:${obsB.session.toolProfileMatchesExpected})`,
    failedChecksA: evalA.failedChecks,
    failedChecksB: evalB.failedChecks,
    unexpectedToolUsesCountA: unexpectedToolsA.count,
    unexpectedToolUsesCountB: unexpectedToolsB.count,
    unexpectedToolsA: unexpectedToolsA.tools,
    unexpectedToolsB: unexpectedToolsB.tools,
  };
}

async function cmdSmoke(args) {
  const selectionResult = resolveSelectionOrFail(args);
  if (!selectionResult.ok) {
    console.error(selectionResult.reason);
    return 1;
  }
  const { runtime, model: modelEntry, executionProfile, adapter, executionProfileSha256 } = selectionResult.selection;
  const model = modelEntry.model_id;
  const sourceRepoDir = args['source-repo-dir'];
  const pinnedCommit = args['pinned-commit'];
  const projectAlias = args['project-alias'] ?? 'kampkit';
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  const budgetCheck = resolveMaxBudgetUsdOrFail(args['max-budget-usd'] ?? null);
  if (!budgetCheck.ok) {
    console.error(budgetCheck.reason);
    return 1;
  }
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
  // PR 4: resolved before any journal/materialization/auth/spawn -- see
  // resolveIsolationAttestationOrFail's own doc comment for the full fail-closed-both-directions
  // contract.
  const attestationCheck = resolveIsolationAttestationOrFail(args, { runtime, executionProfile });
  if (!attestationCheck.ok) {
    console.error(attestationCheck.reason);
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
  // contract. Same guard as cmdCalibrate on the journal creation call itself -- see its identical
  // rationale comment.
  let journal = null;
  try {
    journal = createInvocationJournal({ runKind: 'smoke', plannedCellCount: 2, privatePatternsFile });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'smoke', journal: null, phase: 'acquiring_shared_resources',
      reasonText: reasonTextFor(err),
      provenance: { model_requested: model, scenario_id: scenarioId, project_alias: projectAlias, project_commit: pinnedCommit },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  }
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
      prompt: SMOKE_PROMPT,
      model,
      allowedGradleTasks: [],
      allowedKmpTestSubcommands: ['doctor', 'describe'],
      materializeFixture: (existingWorktreeDir) => materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir }),
      cleanupFixture: (fixtureDir) => removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir }),
      timeoutMs: 180000,
      journal,
      runtimeAdapter: adapter,
      executionProfile,
      maxBudgetUsd: budgetCheck.maxBudgetUsd,
    });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'smoke', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { model_requested: model, scenario_id: scenarioId, project_alias: projectAlias, project_commit: pinnedCommit },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  }
  try {
    const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, matrixComplete: pairComplete, plannedCellCount, executedCellCount, failFastStop, skillSnapshotArtifact } = conditionPair;
    const policySha256 = computePolicySha256();
    // One HMAC key + opaque scope id for this ENTIRE smoke invocation (correction 2) -- shared by
    // both A and B so they remain comparable to each other, never persisted. Ephemeral (freshly
    // random) unless --measurement-scope-file supplied a stable one (resolved eagerly, above,
    // before any spawn -- see resolveMeasurementScopeOrFail's own doc comment).
    const { scopeId: ambientProfileScopeId, key: ambientProfileKey } = scopeCheck;
    // Schema v6: promptArtifact is computed ONCE from the exact literal prompt text runConditionPair
    // is called with below -- kept as its own named constant so the two never drift apart.
    const common = {
      runKind: 'smoke', scenarioId, skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias, projectCommit: pinnedCommit, projectUrl, family: 'test-only', modelRequested: model, privacyStatus, ambientProfileScopeId, ambientProfileKey,
      selection: selectionResult.selection, promptArtifact: computePromptArtifact(SMOKE_PROMPT), skillSnapshotArtifact,
      isolationAttestationSha256: attestationCheck.sha256,
    };

    // Smoke's gate requires EQUIVALENT REAL WORK in both arms -- not just skill availability.
    // Every sub-check is reported by name in the failure reason (not just an aggregate boolean)
    // specifically so a negative-fixture test can assert WHICH check failed, proving the fixture
    // isolates the ONE failure mode it claims to. skill_invoked is deliberately NOT required
    // here (whether the skill triggers naturally on this prompt is exactly the open question a
    // future corpus-probe run would investigate, not something smoke should presuppose).
    let result;
    // See cmdCalibrate's identical rationale: derived from runB.cellOrdinal/runA.cellOrdinal,
    // never hardcoded 0/1.
    let runIdToCellOrdinal;
    if (!pairComplete) {
      // Fail-fast (preserve rejected matrix forensics): see cmdCalibrate's identical rationale --
      // B already failed locally, A was never spawned.
      const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });
      runIdToCellOrdinal = { [recordB.run_id]: runB.cellOrdinal };
      // See cmdCalibrate's identical rationale: read-back sourced from the journal's own
      // already-durable copy, keyed by cellOrdinal -- never the in-memory value.
      const transcriptsByRunId = { [recordB.run_id]: readJournalRawFor(runB, journal) };
      result = await finalizeAndWriteRecords({
        runKind: 'smoke', recordA: null, recordB, runA: null, runB, privatePatternsFile,
        hardGateFn: smokeHardGate, matrixComplete: false, plannedCellCount, executedCellCount, failFastStop, journal,
        transcriptsByRunId,
      });
    } else {
      const recordA = buildRunRecord({ conditionResult: runA, condition: 'no-skill', ...common });
      const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });
      runIdToCellOrdinal = { [recordB.run_id]: runB.cellOrdinal, [recordA.run_id]: runA.cellOrdinal };
      const transcriptsByRunId = { [recordB.run_id]: readJournalRawFor(runB, journal), [recordA.run_id]: readJournalRawFor(runA, journal) };
      result = await finalizeAndWriteRecords({
        runKind: 'smoke', recordA, recordB, runA, runB, privatePatternsFile,
        hardGateFn: smokeHardGate, journal,
        transcriptsByRunId,
      });
    }
    if (!result.ok) {
      if (result.rejectionId == null) {
        const incidentResult = finalizeIncident({
          runKind: 'smoke', journal, phase: 'finalizing_matrix', reasonText: result.reason,
          provenance: { model_requested: model, scenario_id: scenarioId, project_alias: projectAlias, project_commit: pinnedCommit },
          privatePatternsFile,
        });
        reportIncident(incidentResult);
      } else {
        console.error(`SMOKE FAILED: ${result.reason}`);
        printRejectionForensicsStderr(result);
      }
      discardJournalIfRedundant(journal, result, runIdToCellOrdinal);
      return 1;
    }
    discardJournalIfRedundant(journal, result, runIdToCellOrdinal);
    console.log(JSON.stringify({ recordA: result.redactedRecordA, recordB: result.redactedRecordB, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'smoke', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { model_requested: model, scenario_id: scenarioId, project_alias: projectAlias, project_commit: pinnedCommit },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
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

function runGradleWrapper({ fixtureDir, task, gradleUserHome }) {
  const env = { ...process.env, GRADLE_USER_HOME: gradleUserHome };
  if (process.platform === 'win32') {
    const wrapper = join(fixtureDir, 'gradlew.bat');
    if (!existsSync(wrapper)) return { skipped: true };
    const r = spawnSync(wrapper, [task, '--no-daemon'], { cwd: fixtureDir, env, encoding: 'utf8', shell: true });
    return { skipped: false, status: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr };
  }
  const wrapper = join(fixtureDir, 'gradlew');
  if (!existsSync(wrapper)) return { skipped: true };
  const r = spawnSync(wrapper, [task, '--no-daemon'], { cwd: fixtureDir, env, encoding: 'utf8' });
  return { skipped: false, status: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr };
}

function buildScenarioGradlePrewarm({ sourceRepoDir, pinnedCommit, scenario }) {
  const evidenceTask = scenario.expected?.gradle?.evidence_task;
  if (typeof evidenceTask !== 'string' || evidenceTask.length === 0) return null;
  return (gradleUserHome) => {
    let prewarmFixtureDir = null;
    try {
      const materialized = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      prewarmFixtureDir = materialized.fixtureDir;
      const result = runGradleWrapper({ fixtureDir: prewarmFixtureDir, task: evidenceTask, gradleUserHome });
      if (result.skipped) return;
      if (result.error) {
        throw new Error(`Gradle prewarm failed for ${evidenceTask}: ${result.error.message}`);
      }
      if (result.status !== 0) {
        const diagnosticTail = `${result.stderr ?? ''}${result.stdout ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new Error(`Gradle prewarm failed for ${evidenceTask} (exit ${result.status})${diagnosticTail ? `: ${diagnosticTail}` : ''}`);
      }
    } finally {
      if (prewarmFixtureDir) {
        removeScenarioWorktree({ sourceRepoDir, worktreeDir: prewarmFixtureDir });
      }
    }
  };
}

function resolveGradleUserHomeSeedDirFromEnv() {
  const value = process.env.KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR;
  if (value == null || value === '') return null;
  const seedDir = resolve(value);
  let stats;
  try {
    stats = statSync(seedDir);
  } catch (err) {
    throw new Error(`KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR is not readable: ${seedDir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR is not a directory: ${seedDir}`);
  }
  return seedDir;
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
/**
 * `run --campaign-design <id>` (agentic-eval-multi-profile-campaigns-v1) -- expands one scenario
 * into a closed, pre-registered multi-profile campaign plan (scenario-campaign-plan.mjs) spanning
 * BOTH execution profile and skill condition in one invocation, and dispatches it via
 * runScenarioCampaign (matrix-runner.mjs). Mutually exclusive with --execution-profile/--repeats:
 * the design resolves its own profile(s) per cell and fixes its own repeat count -- see this
 * module's own README/HELP text. Mirrors cmdRun's own ordering discipline (private-patterns-file ->
 * measurement-scope-file -> selection -> isolation-attestation -> scenario load -> --dry-run early
 * return -> real run) exactly, generalized to N resolved selections instead of one.
 */
async function cmdRunCampaign(args, campaignDesignId) {
  if (args['execution-profile'] != null) {
    console.error('--campaign-design cannot be combined with --execution-profile -- the campaign design itself resolves an explicit execution profile per cell');
    return 1;
  }
  if (args.repeats != null) {
    console.error('--campaign-design cannot be combined with --repeats -- the campaign design itself fixes its own repeat count');
    return 1;
  }

  const scenarioId = args.scenario;
  const sourceRepoDir = args['source-repo-dir'];
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  const isDryRun = args['dry-run'] === true;
  const budgetCheck = resolveMaxBudgetUsdOrFail(args['max-budget-usd'] ?? null);
  if (!budgetCheck.ok) {
    console.error(budgetCheck.reason);
    return 1;
  }

  if (!scenarioId || !sourceRepoDir) {
    console.error('run --campaign-design requires --scenario <id> --source-repo-dir <local clone> --seed <n> [--runtime <id>] [--model <name>] --isolation-attestation-file <path> [--dry-run] [--private-patterns-file <path>]');
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

  // Resolved BEFORE any per-profile selection work -- an unknown design id or a registry that
  // cannot satisfy the design's own required profiles/conditions fails with the clearest possible
  // message first, exactly like cmdRun's own selection-before-everything-else discipline.
  const designResolved = resolveScenarioCampaignDesign(campaignDesignId);
  if (!designResolved.ok) {
    console.error(designResolved.reason);
    return 1;
  }
  const executionProfileIds = loadRegistries().executionProfiles.filter((p) => p.enabled === true).map((p) => p.id);
  const planResult = buildScenarioCampaignPlan({ designId: campaignDesignId, repeats: designResolved.design.repeats, executionProfiles: executionProfileIds });
  if (!planResult.ok) {
    console.error(planResult.reason);
    return 1;
  }
  const { plan: campaignPlan } = planResult;

  // One (runtime, model, executionProfile, adapter, executionProfileSha256) selection PER DISTINCT
  // execution profile the plan actually uses -- never a single shared selection (Important note in
  // the runbook: a multi-profile campaign must not accidentally resolve/attest/execute every cell
  // against the same profile). --runtime/--model are shared CLI flags (not per-profile), so the
  // SAME runtimeId/modelId is used for every resolveSelection call here -- only executionProfileId
  // varies, mirroring resolveSelection's own "runtime/model resolution is independent of execution
  // profile" contract.
  const distinctProfileIds = [...new Set(campaignPlan.cells.map((c) => c.execution_profile_id))];
  const selectionsByProfileId = {};
  for (const profileId of distinctProfileIds) {
    const sel = resolveSelection({ executionProfileId: profileId, runtimeId: args.runtime ?? null, modelId: args.model ?? null });
    if (!sel.ok) {
      console.error(sel.reason);
      return 1;
    }
    selectionsByProfileId[profileId] = sel.selection;
  }
  const { runtime, model: modelEntry } = selectionsByProfileId[distinctProfileIds[0]];
  const model = modelEntry.model_id;

  // Exactly one shared --isolation-attestation-file flag/value for the WHOLE invocation, validated
  // against whichever ONE distinct profile in this plan actually requires it (today: always
  // sandboxed-unrestricted-v1 -- claude-2x2-williams-v1 always includes it) -- resolveIsolationAttestationOrFail's
  // own "flag present but not required -> reject" direction is deliberately checked against that
  // SAME profile, never against a strict-policy-v1 cell's profile, which would always spuriously
  // reject a campaign's legitimately-required attestation file.
  const profileRequiringAttestation = distinctProfileIds
    .map((id) => selectionsByProfileId[id].executionProfile)
    .find((p) => p.isolation_attestation_required === true) ?? null;
  const attestationProfileForCheck = profileRequiringAttestation ?? selectionsByProfileId[distinctProfileIds[0]].executionProfile;
  const attestationCheck = resolveIsolationAttestationOrFail(args, { runtime, executionProfile: attestationProfileForCheck });
  if (!attestationCheck.ok) {
    console.error(attestationCheck.reason);
    return 1;
  }
  const attestationSha256ByProfileId = {};
  for (const profileId of distinctProfileIds) {
    attestationSha256ByProfileId[profileId] = selectionsByProfileId[profileId].executionProfile.isolation_attestation_required === true
      ? attestationCheck.sha256
      : null;
  }

  const loaded = loadScenarioById(scenarioId);
  if (!loaded.ok) {
    console.error(loaded.reason);
    return 1;
  }
  const { scenario } = loaded;

  if (isDryRun) {
    const measurementScope = scopeCheck.source === 'supplied' ? { measurement_scope: { scope_id: scopeCheck.scopeId, source: scopeCheck.source } } : {};
    const cellsForDryRun = campaignPlan.cells.map((cell) => {
      const executionProfile = selectionsByProfileId[cell.execution_profile_id].executionProfile;
      const attestationFields = executionProfile.isolation_attestation_required === true
        ? {
            execution_profile_isolation_kind: executionProfile.isolation_kind,
            execution_profile_network_mode: executionProfile.network_mode,
            execution_profile_policy_mode: executionProfile.policy_mode,
            execution_profile_isolation_attestation_sha256: attestationSha256ByProfileId[cell.execution_profile_id],
          }
        : {};
      return {
        order_index: cell.order_index, repetition_index: cell.repetition_index,
        campaign_cell_label: cell.campaign_cell_label, condition: cell.condition,
        product_access_mode: cell.product_access_mode,
        execution_profile_id: cell.execution_profile_id,
        execution_profile_sha256: selectionsByProfileId[cell.execution_profile_id].executionProfileSha256,
        ...attestationFields,
      };
    });
    console.log(JSON.stringify({
      dry_run: true, scenario_id: scenario.id, campaign_design_id: campaignDesignId, repeats: campaignPlan.repeats, seed,
      runtime_id: runtime.runtime_id, model_id: model, model_vendor_expected: modelEntry.model_vendor_expected,
      max_budget_usd: budgetCheck.maxBudgetUsd,
      planned_sessions: campaignPlan.planned_sessions, policy: scenario.policy, plan: cellsForDryRun, ...measurementScope,
    }, null, 2));
    return 0;
  }

  // Real run from here on -- verify the source repo BEFORE materializing anything from it.
  const sourceCheck = verifySourceRepoForScenario(sourceRepoDir, scenario);
  if (!sourceCheck.ok) {
    console.error(sourceCheck.reason);
    return 1;
  }

  const { computePolicySha256 } = await import('./policy-config.mjs');
  let journal = null;
  try {
    journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: campaignPlan.cells.length, privatePatternsFile });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'scenario', journal: null, phase: 'acquiring_shared_resources',
      reasonText: reasonTextFor(err),
      provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  }
  let matrix;
  try {
    const gradlePrewarm = buildScenarioGradlePrewarm({ sourceRepoDir, pinnedCommit: scenario.project_commit, scenario });
    const gradleUserHomeSeedDir = resolveGradleUserHomeSeedDirFromEnv();
    matrix = await runScenarioCampaign({
      scenario, campaignPlan, seed, model,
      allowedGradleTasks: scenario.policy.allowed_gradle_tasks,
      allowedKmpTestSubcommands: scenario.policy.allowed_kmptest_subcommands,
      repoRoot: REPO_ROOT, pinnedSkillSha: PINNED_SKILL_SHA, runPluginValidator,
      materializeFixture: (existingWorktreeDir) => materializeScenarioProject({ sourceRepoDir, pinnedCommit: scenario.project_commit, existingWorktreeDir }),
      cleanupFixture: (fixtureDir) => removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir }),
      targetPluginName: TARGET_PLUGIN_NAME,
      targetSkillName: TARGET_SKILL_NAME,
      timeoutMs: 600000,
      journal,
      selectionsByProfileId,
      maxBudgetUsd: budgetCheck.maxBudgetUsd,
      gradlePrewarm,
      gradleUserHomeSeedDir,
    });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'scenario', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  }
  try {
    const policySha256 = computePolicySha256();
    const { scopeId: ambientProfileScopeId, key: ambientProfileKey } = scopeCheck;
    const records = [];
    const conditionResults = [];
    const terminalAuthoritativeEventIndices = [];
    const terminalEvidenceDiagnostics = [];
    const localIntegrityByRunId = {};
    const transcriptsByRunId = {};
    const runPromptArtifact = computePromptArtifact(scenario.prompt);
    for (const cell of matrix.cellResults) {
      // Looked up by cell.orderIndex (the journal's own authoritative per-cell ordinal), never by
      // array position -- matches this file's own established "derive from an authoritative field,
      // never assume array-position-matches-index" discipline (see e.g. captureOrdinalByRunId
      // elsewhere in this file). campaignPlan.cells[k].order_index === k by construction
      // (buildScenarioCampaignPlan assigns order_index sequentially), so this is an exact lookup,
      // never an approximation.
      const planCell = campaignPlan.cells[cell.orderIndex];
      const cellSelection = selectionsByProfileId[planCell.execution_profile_id];
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
        selection: cellSelection, promptArtifact: runPromptArtifact, skillSnapshotArtifact: matrix.skillSnapshotArtifact,
        isolationAttestationSha256: attestationSha256ByProfileId[planCell.execution_profile_id],
        productAccessMode: planCell.product_access_mode,
      });
      records.push(record);
      conditionResults.push(cell.conditionResult);
      terminalAuthoritativeEventIndices.push(gradeResult.terminalAuthoritativeEventIndex);
      terminalEvidenceDiagnostics.push(gradeResult.terminalEvidence);
      localIntegrityByRunId[record.run_id] = cell.localIntegrity;
      transcriptsByRunId[record.run_id] = readJournalRawFor(cell.conditionResult, journal);
    }
    if (!matrix.matrixComplete) {
      console.error(`RUN: fail-fast stopped the campaign early at order_index ${matrix.failFastStop.orderIndex} (repetition ${matrix.failFastStop.repetitionIndex}, condition ${matrix.failFastStop.condition}) -- ${matrix.executedCellCount}/${matrix.plannedCellCount} cells executed, remaining cells never spawned`);
    }

    const buildSidecars = (recs, condResults) => {
      const texts = [];
      for (const [i, record] of recs.entries()) {
        const builtSidecar = buildAcceptedRunAuditSidecar({
          record, conditionResult: condResults[i],
          terminalAuthoritativeEventIndex: terminalAuthoritativeEventIndices[i],
          terminalEvidence: terminalEvidenceDiagnostics[i] ?? null,
        });
        const sidecarResult = finalizeAcceptedRunAuditSidecar(builtSidecar, { privatePatternsFile });
        if (!sidecarResult.ok) {
          return { ok: false, reason: `accepted-run-audit sidecar for record [${i}] (repetition ${record.repetition_index}, ${record.condition}): ${sidecarResult.reason}` };
        }
        const expectedSidecarSchema = expectedAcceptedAuditSchemaFor(record);
        if (builtSidecar.schema !== expectedSidecarSchema) {
          return { ok: false, reason: `accepted-run-audit sidecar for record [${i}] (repetition ${record.repetition_index}, ${record.condition}): built sidecar schema ${builtSidecar.schema} is not the expected ${expectedSidecarSchema} for this record/profile` };
        }
        record.accepted_audit = { schema: builtSidecar.schema, relative_path: acceptedAuditRelativePathFor(record.run_id), sha256: sidecarResult.sha256 };
        texts.push(sidecarResult.redactedText);
      }
      return { ok: true, sidecarTexts: texts };
    };

    const result = await finalizeAndWriteMatrixRecords({
      runKind: 'scenario', records, conditionResults, hardGateFn: scenarioHardGate,
      privatePatternsFile, repeats: campaignPlan.repeats, buildSidecarsFn: buildSidecars,
      matrixComplete: matrix.matrixComplete, plannedCellCount: matrix.plannedCellCount,
      executedCellCount: matrix.executedCellCount, localIntegrityByRunId, failFastStop: matrix.failFastStop,
      journal, transcriptsByRunId,
      terminalEvidenceByRunId: Object.fromEntries(records.map((r, i) => [r.run_id, terminalEvidenceDiagnostics[i] ?? null])),
      completenessCheckFn: (recs) => findCampaignCompletenessGap(recs, campaignPlan),
    });
    if (!result.ok) {
      if (result.rejectionId == null) {
        const incidentResult = finalizeIncident({
          runKind: 'scenario', journal, phase: 'finalizing_matrix', reasonText: result.reason,
          cellOrdinal: matrix.failFastStop?.orderIndex ?? null,
          provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
          privatePatternsFile,
        });
        reportIncident(incidentResult);
      } else {
        console.error(`RUN FAILED: ${result.reason}`);
        printRejectionForensicsStderr(result);
      }
      discardJournalIfRedundant(journal, result, Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].cellOrdinal])));
      return 1;
    }
    discardJournalIfRedundant(journal, result, Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].cellOrdinal])));
    console.log(JSON.stringify({ records: result.redactedRecords, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'scenario', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  } finally {
    // Mirrors cmdRun's own identical finally (legacy single-profile path) -- matrix is always
    // defined by this point (the earlier try/catch around runScenarioCampaign returns before ever
    // reaching here if that call throws, and that call's own internal catch already ran its full
    // rollback in that case, so there is nothing to double-clean). Runs on every exit from this
    // block: happy-path promotion, a clean result.ok:false rejection/incident, AND an exception
    // caught by the catch immediately above -- never skipped.
    reportCleanupFailures(await matrix.cleanup());
  }
}

async function cmdRun(args) {
  // agentic-eval-multi-profile-campaigns-v1: an explicit, opt-in dispatch -- everything below this
  // branch (the legacy single-execution-profile/two-skill-condition path) is completely unreached
  // and unchanged when --campaign-design is absent, by construction.
  if (args['campaign-design'] != null) {
    return cmdRunCampaign(args, args['campaign-design']);
  }
  const selectionResult = resolveSelectionOrFail(args);
  if (!selectionResult.ok) {
    console.error(selectionResult.reason);
    return 1;
  }
  const { runtime, model: modelEntry, executionProfile, adapter, executionProfileSha256 } = selectionResult.selection;
  const scenarioId = args.scenario;
  const sourceRepoDir = args['source-repo-dir'];
  const model = modelEntry.model_id;
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  const isDryRun = args['dry-run'] === true;
  const budgetCheck = resolveMaxBudgetUsdOrFail(args['max-budget-usd'] ?? null);
  if (!budgetCheck.ok) {
    console.error(budgetCheck.reason);
    return 1;
  }

  if (!scenarioId || !sourceRepoDir) {
    console.error('run requires --scenario <id> --source-repo-dir <local clone> --seed <n> [--repeats <n>] [--runtime <id>] [--model <name>] [--execution-profile <id>] [--max-budget-usd <usd>] [--dry-run] [--private-patterns-file <path>]');
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
    console.error(`--repeats ${repeats} exceeds the maximum of ${MAX_REPEATS} (each repetition spawns 2 live runtime sessions once pointed at a real runtime binary -- ${repeats} repeats would authorize ${repeats * 2} sessions; if this is genuinely intentional, split it into multiple smaller --repeats invocations)`);
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
  // PR 4: resolved before the --dry-run early-return -- Decision I requires --dry-run to also
  // require+validate the attestation for a profile that needs one (never runtime/auth/
  // materialization; a real subprocess only for resolveHarnessProvenance's own `git rev-parse
  // HEAD`, and only when isolation_attestation_required:true -- strict's bare dry-run stays cero
  // subprocess, see resolveIsolationAttestationOrFail's own doc comment).
  const attestationCheck = resolveIsolationAttestationOrFail(args, { runtime, executionProfile });
  if (!attestationCheck.ok) {
    console.error(attestationCheck.reason);
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
    // PR 4: strict's bare dry-run JSON shape stays byte-for-byte (these 4 keys are added only when
    // the resolved profile actually requires attestation -- see Decision I) -- never duplicated
    // under a second, nested execution_profile object alongside the existing flat
    // execution_profile_id/execution_profile_sha256 keys above.
    const attestationFields = executionProfile.isolation_attestation_required === true
      ? {
          execution_profile_isolation_kind: executionProfile.isolation_kind,
          execution_profile_network_mode: executionProfile.network_mode,
          execution_profile_policy_mode: executionProfile.policy_mode,
          execution_profile_isolation_attestation_sha256: attestationCheck.sha256,
        }
      : {};
    console.log(JSON.stringify({
      dry_run: true, scenario_id: scenario.id, repeats, seed,
      runtime_id: runtime.runtime_id, model_id: modelEntry.model_id, model_vendor_expected: modelEntry.model_vendor_expected,
      execution_profile_id: executionProfile.id, execution_profile_sha256: executionProfileSha256,
      max_budget_usd: budgetCheck.maxBudgetUsd,
      ...attestationFields,
      total_live_sessions: repeats * 2, policy: scenario.policy, plan, ...measurementScope,
    }, null, 2));
    return 0;
  }

  // Real run from here on -- verify the source repo BEFORE materializing anything from it.
  const sourceCheck = verifySourceRepoForScenario(sourceRepoDir, scenario);
  if (!sourceCheck.ok) {
    console.error(sourceCheck.reason);
    return 1;
  }

  const { computePolicySha256 } = await import('./policy-config.mjs');
  // Created before the first spawn, per invocation -- plan.length (repeats*2, already computed
  // above for the --dry-run preview) is the exact plannedCellCount, known before any spawn. Same
  // guard as cmdCalibrate on the journal creation call itself -- see its identical rationale.
  let journal = null;
  try {
    journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: plan.length, privatePatternsFile });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'scenario', journal: null, phase: 'acquiring_shared_resources',
      reasonText: reasonTextFor(err),
      provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
  }
  // Round-7 audit finding: see cmdCalibrate's identical rationale -- resource acquisition must
  // never be allowed to throw uncaught past this command's own "RUN FAILED: <reason>" / exit 1
  // contract.
  let matrix;
  try {
    const gradlePrewarm = buildScenarioGradlePrewarm({ sourceRepoDir, pinnedCommit: scenario.project_commit, scenario });
    const gradleUserHomeSeedDir = resolveGradleUserHomeSeedDirFromEnv();
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
      journal,
      runtimeAdapter: adapter,
      executionProfile,
      maxBudgetUsd: budgetCheck.maxBudgetUsd,
      gradlePrewarm,
      gradleUserHomeSeedDir,
    });
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'scenario', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
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
    const terminalEvidenceDiagnostics = [];
    // localIntegrityByRunId: parallel to records -- finalizeAndWriteMatrixRecords cannot read
    // `matrix` directly (only this function has it), so on a fail-fast (matrix.matrixComplete ===
    // false) rejection it needs this map instead, keyed by the same run_id every other by-run-id
    // map in this pipeline uses. Built for every cell regardless of matrixComplete (cheap, and
    // simpler than conditionally skipping it) -- only actually consumed when the matrix is
    // incomplete.
    const localIntegrityByRunId = {};
    // transcriptsByRunId: parallel to records, built incrementally as each record's run_id becomes
    // known -- finalizeAndWriteMatrixRecords requires this map complete and exact, read-back
    // sourced from the journal's own already-durable copy (keyed by cellOrdinal, never array
    // position), never from conditionResult itself (the observation contract carries no raw field).
    const transcriptsByRunId = {};
    // Schema v6: computed ONCE for the whole matrix (every cell shares the same scenario prompt
    // and the same pinned skill snapshot) -- never recomputed per cell. matrix.skillSnapshotArtifact
    // was resolved exactly once during resource acquisition (acquireSharedEvalResources, AFTER
    // materializeSkillSnapshot backfilled the pinned commit into a shallow CI checkout -- see
    // matrix-runner.mjs's own doc comment) and propagated back on `matrix` -- reused here directly,
    // never re-resolved.
    const runPromptArtifact = computePromptArtifact(scenario.prompt);
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
        selection: selectionResult.selection, promptArtifact: runPromptArtifact, skillSnapshotArtifact: matrix.skillSnapshotArtifact,
        isolationAttestationSha256: attestationCheck.sha256,
      });
      records.push(record);
      conditionResults.push(cell.conditionResult);
      terminalAuthoritativeEventIndices.push(gradeResult.terminalAuthoritativeEventIndex);
      terminalEvidenceDiagnostics.push(gradeResult.terminalEvidence);
      localIntegrityByRunId[record.run_id] = cell.localIntegrity;
      transcriptsByRunId[record.run_id] = readJournalRawFor(cell.conditionResult, journal);
    }
    if (!matrix.matrixComplete) {
      console.error(`RUN: fail-fast stopped the matrix early at order_index ${matrix.failFastStop.orderIndex} (repetition ${matrix.failFastStop.repetitionIndex}, condition ${matrix.failFastStop.condition}) -- ${matrix.executedCellCount}/${matrix.plannedCellCount} cells executed, remaining cells never spawned`);
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
          terminalEvidence: terminalEvidenceDiagnostics[i] ?? null,
        });
        const sidecarResult = finalizeAcceptedRunAuditSidecar(builtSidecar, { privatePatternsFile });
        if (!sidecarResult.ok) {
          return { ok: false, reason: `accepted-run-audit sidecar for record [${i}] (repetition ${record.repetition_index}, ${record.condition}): ${sidecarResult.reason}` };
        }
        // The pointer takes the BUILT sidecar's own version, never a hardcoded literal: with v1 and
        // v2 coexisting, a literal here would keep claiming v1 while the file on disk moved on, and
        // crossValidateAcceptedRunAuditAgainstRecord's schema equality would fail at promotion time.
        // The expected-schema assertion is the belt-and-braces half -- a builder that somehow
        // emitted the WRONG version for this record/profile must not be silently blessed by
        // faithfully copying it. PR 4: never a flat `!== LATEST` comparison (LATEST is now 4) --
        // that would reject every byte-identical v3 sidecar a policy-required schema:6 record
        // still correctly produces. expectedAcceptedAuditSchemaFor is the one explicit dispatch
        // both the builder and this promotion check agree on.
        const expectedSidecarSchema = expectedAcceptedAuditSchemaFor(record);
        if (builtSidecar.schema !== expectedSidecarSchema) {
          return { ok: false, reason: `accepted-run-audit sidecar for record [${i}] (repetition ${record.repetition_index}, ${record.condition}): built sidecar schema ${builtSidecar.schema} is not the expected ${expectedSidecarSchema} for this record/profile` };
        }
        record.accepted_audit = { schema: builtSidecar.schema, relative_path: acceptedAuditRelativePathFor(record.run_id), sha256: sidecarResult.sha256 };
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
      matrixComplete: matrix.matrixComplete, plannedCellCount: matrix.plannedCellCount,
      executedCellCount: matrix.executedCellCount, localIntegrityByRunId, failFastStop: matrix.failFastStop,
      journal, transcriptsByRunId,
      terminalEvidenceByRunId: Object.fromEntries(records.map((r, i) => [r.run_id, terminalEvidenceDiagnostics[i] ?? null])),
    });
    if (!result.ok) {
      if (result.rejectionId == null) {
        // Not the well-handled gate-rejection path -- route through the same shared finalizer an
        // exception would get (sidecar/schema/privacy/promotion-collision failures, all of which
        // return {ok:false} rather than throw -- verified directly against
        // finalizeAndWriteMatrixRecords' own body).
        const incidentResult = finalizeIncident({
          runKind: 'scenario', journal, phase: 'finalizing_matrix', reasonText: result.reason,
          cellOrdinal: matrix.failFastStop?.orderIndex ?? null,
          provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
          privatePatternsFile,
        });
        reportIncident(incidentResult);
      } else {
        console.error(`RUN FAILED: ${result.reason}`);
        printRejectionForensicsStderr(result);
      }
      discardJournalIfRedundant(journal, result, Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].cellOrdinal])));
      return 1;
    }
    discardJournalIfRedundant(journal, result, Object.fromEntries(records.map((r, i) => [r.run_id, conditionResults[i].cellOrdinal])));
    console.log(JSON.stringify({ records: result.redactedRecords, evidenceDir: result.redactedOutDir }, null, 2));
    return 0;
  } catch (err) {
    const incidentResult = finalizeIncident({
      runKind: 'scenario', journal, phase: incidentPhaseOf(err),
      reasonText: reasonTextFor(err), cellOrdinal: err.agenticEvalCellOrdinal ?? null,
      rawStdout: err.agenticEvalRawStdout ?? null,
      provenance: { scenario_id: scenario.id, project_alias: scenario.project_alias, project_commit: scenario.project_commit, seed, model_requested: model },
      privatePatternsFile,
    });
    reportIncident(incidentResult);
    return 1;
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
 * Thin CLI wrapper over analysis.mjs's analyzeRunsDir -- mirrors cmdAggregate/cmdValidate's own
 * "wrapper stays a print + exit-code shell, all real logic lives in a directly-testable function"
 * precedent. Exit 1 whenever ANY file failed validation (mirrors cmdAggregate's identical
 * fail-closed contract) -- a clean run with zero errors, even one that analyzed zero applicable
 * files, exits 0.
 */
function cmdAnalyze(args) {
  const runsDir = args['runs-dir'];
  // existsSync alone also succeeds for an existing regular FILE -- statSync().isDirectory() closes
  // that gap here with a clean, plain-text pre-flight message; analyzeRunsDir's own defensive
  // directory check (for any caller that reaches it directly, bypassing this CLI wrapper) still
  // returns a full, never-throwing JSON envelope either way, so this is a UX improvement layered on
  // top of an already-fail-closed function, not the only thing preventing a crash.
  let runsDirOk = false;
  try {
    runsDirOk = !!runsDir && statSync(runsDir).isDirectory();
  } catch {
    runsDirOk = false;
  }
  if (!runsDirOk) {
    console.error('--runs-dir <dir> is required and must be an existing, readable directory');
    return 1;
  }
  const result = analyzeRunsDir(runsDir);
  console.log(JSON.stringify(result, null, 2));
  return result.errors.length > 0 ? 1 : 0;
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

function cmdProductAccessPreflight(args) {
  if (args._[1] !== 'preflight') {
    process.stderr.write('usage: product-access preflight --mode free-baseline-no-product --workspace <source-only-workspace>\n');
    return 1;
  }
  if (!args.mode || !args.workspace) {
    process.stderr.write('usage: product-access preflight --mode free-baseline-no-product --workspace <source-only-workspace>\n');
    return 1;
  }
  const result = evaluateProductAccessPreflight({ mode: args.mode, workspaceDir: args.workspace, env: process.env });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
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
    case 'analyze': return cmdAnalyze(args);
    case 'validate': return cmdValidate(args);
    case 'product-access': return cmdProductAccessPreflight(args);
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

export { parseArgs, BOOLEAN_FLAGS, validateSubcommandArgs, validatePrivatePatternsFileOrFail, resolveMeasurementScopeOrFail, resolveMaxBudgetUsdOrFail, cmdCorpusValidate, cmdScopeInit, cmdAggregate, cmdAnalyze, cmdValidate, validateRunRecordFile, cmdCalibrate, cmdSmoke, cmdRun, buildRunRecord, nullableMetric, runConditionPair, finalizeAndWriteRecords, finalizeAndWriteMatrixRecords, writeRunRecordEvidence, writeRunMatrixRecordEvidence, findMatrixCompletenessGap, validateTranscriptsByRunId, calibrationHardGate, smokeHardGate, scenarioCellIntegrityOk, scenarioHardGate, realizedStartCounts, scenarioMatrixIsBenchmarkEligible, verifyExactCommandsSucceeded, resolveHarnessProvenance, findBlockingHarnessToolingDirty, isRunsRootDefault, checkScenarioFilenameMatchesId, findDuplicateScenarioIds, loadScenarioFile, validateLoadedScenarios, loadScenarioById, verifySourceRepoForScenario, buildScenarioRunPlan, normalizeGitRemoteForComparison, SMOKE_EXPECTED_COMMANDS, SUBCOMMAND_SHAPES, PINNED_SKILL_SHA, readJournalRawFor, journalRawExactlyMatchesRejectionManifest, discardJournalIfRedundant, incidentPhaseOf, reasonTextFor, buildStderrByRunId };
