#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/cli.mjs -- entrypoint for the reproducible skill evaluation harness.
//
// Usage:
//   node tools/agentic-eval/cli.mjs calibrate [--model <name>]
//   node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
//                                          [--project-alias <alias>] [--model <name>]
//   node tools/agentic-eval/cli.mjs corpus validate
//   node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
//   node tools/agentic-eval/cli.mjs validate --run <path-to-run.json>
//   node tools/agentic-eval/cli.mjs --help
//
// Every measured run is benchmark_eligible:false (calibration/corpus-probe/smoke) except a
// future, genuinely controlled `scenario` run_kind -- not implemented by any subcommand here.
// This PR does not execute the full benchmark; `smoke` runs exactly one scenario to prove the
// harness works end-to-end, never publishing a ratio or performance claim.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CURRENT_RUN_SCHEMA, validateRun, validateScenario } from './schemas.mjs';
import { buildEvalEnv } from './env-builder.mjs';
import { buildPathShim } from './path-shim.mjs';
import { materializeSkillSnapshot, materializeCalibrationProject, materializeScenarioProject, materializeGradleUserHome, realpath } from './materialize.mjs';
import { buildBaseArgv, buildConditionArgv, buildSharedEnv, buildPolicySettingsFile, spawnCondition } from './condition-launcher.mjs';
import { parseStreamJsonl, findInitEvent, findResultEvent, isSkillAvailable, findSkillInvocation, findBashToolUses, countHookEvents, computeByteMetrics, extractTokenUsage, deriveFirstUsefulSignalMs } from './stream-parser.mjs';
import { getGrader } from './graders.mjs';
import { aggregateRuns } from './aggregate.mjs';
import { assertCleanOrThrow } from './privacy.mjs';
import { runValidator as runPluginValidator } from '../validate-plugin.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PINNED_SKILL_SHA = 'c5c0661852f7c9da145ef56892048e706216a6ce';
const RUNS_ROOT = join(REPO_ROOT, 'tools', 'runs');

const HELP = `tools/agentic-eval/cli.mjs -- reproducible skill evaluation harness

Usage:
  node tools/agentic-eval/cli.mjs calibrate [--model <name>]
  node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
                                         [--project-alias <alias>] [--model <name>]
  node tools/agentic-eval/cli.mjs corpus validate
  node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
  node tools/agentic-eval/cli.mjs validate --run <path>
  node tools/agentic-eval/cli.mjs --help

Every run this PR's subcommands can produce is benchmark_eligible:false. This is a foundation
harness, not a benchmark -- see tools/agentic-eval/README.md.
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; continue; }
    out._.push(a);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
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

/**
 * @param {Function} materializeFixture - (existingDir) => {fixtureDir}. Called once per
 *   condition with the PRIOR fixtureDir (or undefined for the first call) so the caller can
 *   implement "reuse the same path, wiped and re-populated" (Materialization Principle).
 */
async function runConditionPair({ prompt, model, allowedGradleTasks, allowedKmpTestSubcommands, materializeFixture, timeoutMs }) {
  const settingsPath = buildPolicySettingsFile();
  const { shimDir } = buildPathShim({ worktreeRoot: REPO_ROOT });
  const { snapshotDir } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runPluginValidator });
  const { gradleUserHome, resetToSnapshot, daemonPolicy } = materializeGradleUserHome({});
  const kmpEvalTempHome = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-home-'));

  const env = buildSharedEnv({
    shimDir, gradleUserHome, kmpEvalTempHome,
    expectedFixtureRoot: null, // set per-condition below once the fixture dir is materialized
    allowedGradleTasks, allowedKmpTestSubcommands,
  });
  const base = buildBaseArgv({ prompt, model, settingsPath });

  let fixtureDir;
  const runOneCondition = async (condition) => {
    const materialized = materializeFixture(fixtureDir);
    fixtureDir = materialized.fixtureDir;
    resetToSnapshot();
    // KMP_EVAL_TEMP_HOME is reused (same path) across both conditions of a pair like
    // fixtureDir/GRADLE_USER_HOME -- wiped back to empty before EACH condition's run, so
    // whatever the first-run condition wrote under ~/.kmp-test/ can never leak into the second.
    rmSync(kmpEvalTempHome, { recursive: true, force: true });
    mkdirSync(kmpEvalTempHome, { recursive: true });
    const conditionEnv = { ...env, KMP_EVAL_EXPECTED_FIXTURE_ROOT: realpath(fixtureDir) };
    const argv = buildConditionArgv(base, condition, condition === 'current-skill' ? snapshotDir : null);
    const spawnResult = await spawnCondition(argv, { env: conditionEnv, cwd: fixtureDir, timeoutMs });
    const { events, malformedLines } = parseStreamJsonl(spawnResult.rawStdout, { taggedLines: spawnResult.taggedLines });
    const init = findInitEvent(events);
    const result = findResultEvent(events);
    const invocation = findSkillInvocation(events, 'kmp-test-runner');
    const hookStats = countHookEvents(events);
    const byteMetrics = computeByteMetrics(spawnResult.rawStdout, events);

    return {
      condition, argv, env: conditionEnv, fixtureDir, events, malformedLines, init, result,
      invocation, hookStats, byteMetrics, spawnResult,
    };
  };

  const runB = await runOneCondition('current-skill');
  const runA = await runOneCondition('no-skill');

  return { runA, runB, snapshotDir, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands };
}

function buildRunRecord({ conditionResult, condition, runKind, scenarioId, skillSourceSha, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias = 'calibration-project', projectCommit = null, family = 'trigger-only', modelRequested = 'claude-sonnet-5' }) {
  const { init, result, invocation, hookStats, byteMetrics } = conditionResult;
  const notApplicableReason = `${runKind} run -- no scenario grader applies`;
  return {
    schema: CURRENT_RUN_SCHEMA,
    run_id: `${runKind}-${condition}-${randomUUID().slice(0, 8)}`,
    run_kind: runKind,
    benchmark_eligible: false,
    scenario_id: scenarioId,
    query_id: null,
    condition,
    skill_source_sha: condition === 'current-skill' ? skillSourceSha : null,
    kmp_test_cli_version: null,
    kmp_test_cli_source_sha: null,
    resolved_kmp_test_executable_path: null,
    model_requested: modelRequested,
    model_resolved: init?.model ?? null,
    session_id_observed: init?.session_id ?? null,
    repo_commit: skillSourceSha,
    project_alias: projectAlias,
    project_commit: projectCommit,
    platform: resolvePlatform(),
    family,
    cache_state: 'unknown',
    daemon_policy: daemonPolicy ?? 'unknown',
    env_allowlist_profile: 'narrow',
    seed: null,
    order_index: null,
    started_at: nowIso(),
    ended_at: nowIso(),
    wall_clock_ms: null,
    skill_available: nullableMetric(isSkillAvailable(init, 'kmp-test-runner')),
    skill_invoked: nullableMetric(invocation != null),
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
    retries: nullableMetric(0),
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
    privacy_status: 'redacted-private',
    raw_capture_committed: false,
    raw_capture_location: `tools/runs/agentic-eval-${runKind}/raw/`,
    notes: 'Foundation-harness run; not a benchmark result.',
    errors: [],
  };
}

/**
 * Writes the schema-valid, redacted run records to the (committable) top-level run-kind
 * directory, and the RAW stream-json transcripts to its raw subdirectory -- gitignored per
 * .gitignore's agentic-eval raw-transcript glob, matching what each record's
 * raw_capture_location field claims. Never redacts/sanitizes the raw file itself; it simply
 * never leaves this local, gitignored destination.
 */
function writeRunRecordEvidence(runKind, recordA, recordB, runA, runB) {
  const outDir = join(RUNS_ROOT, `agentic-eval-${runKind}`);
  const rawDir = join(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(outDir, `${recordA.run_id}.json`), JSON.stringify(recordA, null, 2));
  writeFileSync(join(outDir, `${recordB.run_id}.json`), JSON.stringify(recordB, null, 2));
  writeFileSync(join(rawDir, `${recordA.run_id}.jsonl`), runA.spawnResult.rawStdout);
  writeFileSync(join(rawDir, `${recordB.run_id}.jsonl`), runB.spawnResult.rawStdout);
  return outDir;
}

async function cmdCalibrate(args) {
  const model = args.model ?? 'claude-sonnet-5';
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const templateDir = join(import.meta.dirname, 'fixtures', 'calibration-project');
  const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands } = await runConditionPair({
    prompt: 'Use the kmp-test-runner skill to check this project.',
    model,
    allowedGradleTasks: ['build'],
    allowedKmpTestSubcommands: ['doctor', 'parallel'],
    materializeFixture: (existingDir) => materializeCalibrationProject({ templateDir, existingDir }),
  });
  const policySha256 = computePolicySha256();
  const recordA = buildRunRecord({ conditionResult: runA, condition: 'no-skill', runKind: 'calibration', scenarioId: 'calibration-explicit-invocation', skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, modelRequested: model });
  const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', runKind: 'calibration', scenarioId: 'calibration-explicit-invocation', skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, modelRequested: model });

  for (const [label, record] of [['A (no-skill)', recordA], ['B (current-skill)', recordB]]) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      console.error(`Run record ${label} failed schema validation:`, JSON.stringify(errors, null, 2));
      return 1;
    }
  }
  const outDir = writeRunRecordEvidence('calibration', recordA, recordB, runA, runB);
  console.log(JSON.stringify({ recordA, recordB, evidenceDir: outDir }, null, 2));
  return recordA.skill_available.value === false && recordB.skill_available.value === true && recordB.skill_invoked.value === true ? 0 : 1;
}

async function cmdSmoke(args) {
  const model = args.model ?? 'claude-sonnet-5';
  const sourceRepoDir = args['source-repo-dir'];
  const pinnedCommit = args['pinned-commit'];
  const projectAlias = args['project-alias'] ?? 'kampkit';
  if (!sourceRepoDir || !pinnedCommit) {
    console.error('smoke requires --source-repo-dir <local clone> --pinned-commit <sha> [--project-alias <alias>]');
    return 1;
  }
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const { runA, runB, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands } = await runConditionPair({
    prompt: "Check whether this project's test setup is healthy and tell me what you find.",
    model,
    allowedGradleTasks: ['build'],
    allowedKmpTestSubcommands: ['doctor'],
    materializeFixture: (existingWorktreeDir) => materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir }),
    timeoutMs: 180000,
  });
  const policySha256 = computePolicySha256();
  const common = { runKind: 'smoke', scenarioId: 'kampkit-android-host-test-discovery', skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias, projectCommit: pinnedCommit, family: 'test-only', modelRequested: model };
  const recordA = buildRunRecord({ conditionResult: runA, condition: 'no-skill', ...common });
  const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });

  for (const [label, record] of [['A (no-skill)', recordA], ['B (current-skill)', recordB]]) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      console.error(`Run record ${label} failed schema validation:`, JSON.stringify(errors, null, 2));
      return 1;
    }
  }
  const outDir = writeRunRecordEvidence('smoke', recordA, recordB, runA, runB);
  console.log(JSON.stringify({ recordA, recordB, evidenceDir: outDir }, null, 2));
  const hardGate = recordA.skill_available.value === false && recordB.skill_available.value === true && recordB.skill_invoked.value === true;
  if (!hardGate) {
    console.error('SMOKE FAILED the hard acceptance gate (skill availability/invocation did not match expectations).');
  }
  return hardGate ? 0 : 1;
}

function cmdCorpusValidate() {
  const corpusDir = join(import.meta.dirname, 'corpus');
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
    if (shouldTrigger.length < 10 || nearMiss.length < 10) {
      console.error('trigger-queries.json: needs at least 10 of each category');
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
  const sub = args._[0];

  if (args.help || sub == null) {
    process.stdout.write(HELP);
    return 0;
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
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`agentic-eval: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}

export { parseArgs, cmdCorpusValidate, cmdAggregate, cmdValidate, cmdCalibrate, cmdSmoke, buildRunRecord, nullableMetric };
