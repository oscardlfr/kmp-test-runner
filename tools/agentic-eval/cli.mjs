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
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CURRENT_RUN_SCHEMA, validateRun, validateScenario } from './schemas.mjs';
import { buildEvalEnv } from './env-builder.mjs';
import { buildPathShim } from './path-shim.mjs';
import { materializeSkillSnapshot, materializeCalibrationProject, materializeScenarioProject, materializeGradleUserHome, removeScenarioWorktree, realpath } from './materialize.mjs';
import { buildBaseArgv, buildConditionArgv, buildSharedEnv, buildPolicySettingsFile, spawnCondition } from './condition-launcher.mjs';
import { parseStreamJsonl, findInitEvent, findResultEvent, isSkillAvailable, findSkillInvocation, findBashToolUses, countHookEvents, computeByteMetrics, extractTokenUsage } from './stream-parser.mjs';
import { aggregateRuns } from './aggregate.mjs';
import { assertCleanOrThrow } from './privacy.mjs';
import { runValidator as runPluginValidator } from '../validate-plugin.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PINNED_SKILL_SHA = 'c5c0661852f7c9da145ef56892048e706216a6ce';
const RUNS_ROOT = join(REPO_ROOT, 'tools', 'runs');

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
  const settingsPath = buildPolicySettingsFile();
  const { shimDir } = buildPathShim({ worktreeRoot: REPO_ROOT });
  const { snapshotDir } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runPluginValidator });
  // materializeGradleUserHome creates TWO temp directories (gradleUserHome itself, plus its own
  // internal snapshotDir it resets from) -- gradleSnapshotDir here is deliberately distinctly
  // named from the skill snapshot's `snapshotDir` above; conflating the two previously meant the
  // Gradle module's own snapshot directory was never captured at all and leaked on every run
  // (caught by a real cleanup-verification test, not asserted).
  const { gradleUserHome, snapshotDir: gradleSnapshotDir, resetToSnapshot, daemonPolicy } = materializeGradleUserHome({});
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
    const startedAt = new Date();
    const spawnResult = await spawnCondition(argv, { env: conditionEnv, cwd: fixtureDir, timeoutMs });
    const endedAt = new Date();
    const { events, malformedLines } = parseStreamJsonl(spawnResult.rawStdout, { taggedLines: spawnResult.taggedLines });
    const init = findInitEvent(events);
    const result = findResultEvent(events);
    const invocation = findSkillInvocation(events, 'kmp-test-runner');
    const hookStats = countHookEvents(events);
    const byteMetrics = computeByteMetrics(spawnResult.rawStdout, events);

    return {
      condition, argv, env: conditionEnv, fixtureDir, events, malformedLines, init, result,
      invocation, hookStats, byteMetrics, spawnResult, startedAt, endedAt,
    };
  };

  const runB = await runOneCondition('current-skill');
  const runA = await runOneCondition('no-skill');

  async function cleanup() {
    const steps = [
      () => rmSync(shimDir, { recursive: true, force: true }),
      () => rmSync(snapshotDir, { recursive: true, force: true }),
      () => rmSync(gradleUserHome, { recursive: true, force: true }),
      () => rmSync(gradleSnapshotDir, { recursive: true, force: true }),
      () => rmSync(kmpEvalTempHome, { recursive: true, force: true }),
      () => rmSync(dirname(settingsPath), { recursive: true, force: true }),
      () => (cleanupFixture ? cleanupFixture(fixtureDir) : undefined),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        console.error(`cleanup step failed (continuing): ${err.message}`);
      }
    }
  }

  return { runA, runB, snapshotDir, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, cleanup };
}

function buildRunRecord({ conditionResult, condition, runKind, scenarioId, skillSourceSha, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias = 'calibration-project', projectCommit = null, family = 'trigger-only', modelRequested = 'claude-sonnet-5', privacyStatus = 'public' }) {
  const { init, result, invocation, hookStats, byteMetrics, startedAt, endedAt } = conditionResult;
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
    privacy_status: privacyStatus,
    raw_capture_committed: false,
    raw_capture_location: `tools/runs/agentic-eval-${runKind}/raw/`,
    notes: 'Foundation-harness run; not a benchmark result.',
    errors: [],
  };
}

/**
 * Writes ALREADY-REDACTED, already-gated record text (never re-serializes recordA/recordB --
 * the caller's redacted text is authoritative) to the committable top-level run-kind directory,
 * and the RAW stream-json transcripts to its raw subdirectory -- gitignored per .gitignore's
 * agentic-eval raw-transcript glob, matching what each record's raw_capture_location field
 * claims. Never redacts/sanitizes the raw file itself; it simply never leaves this local,
 * gitignored destination.
 */
function writeRunRecordEvidence(runKind, recordA, recordB, runA, runB, redactedTextA, redactedTextB) {
  const outDir = join(RUNS_ROOT, `agentic-eval-${runKind}`);
  const rawDir = join(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(outDir, `${recordA.run_id}.json`), redactedTextA);
  writeFileSync(join(outDir, `${recordB.run_id}.json`), redactedTextB);
  writeFileSync(join(rawDir, `${recordA.run_id}.jsonl`), runA.spawnResult.rawStdout);
  writeFileSync(join(rawDir, `${recordB.run_id}.jsonl`), runB.spawnResult.rawStdout);
  return outDir;
}

/**
 * The sole gate before ANY committable evidence is written. In order: schema validation (both
 * records) -> a FRESH policy_sha256 recomputation matched against both records (catches
 * evidence silently going stale relative to policy-hook.mjs's current content -- a hand-carried
 * or previously-generated record with a stale hash is refused, not just format-checked) ->
 * assertCleanOrThrow privacy check on each record's serialized text (never previously wired in
 * -- this is what actually enforces "no leak ever reaches a committable file") -> the run-kind's
 * own hard acceptance predicate. Any failure returns {ok:false, reason} and writes nothing.
 */
async function finalizeAndWriteRecords({ runKind, recordA, recordB, runA, runB, hardGateFn, privatePatternsFile }) {
  for (const [label, record] of [['A', recordA], ['B', recordB]]) {
    const { errors } = validateRun(record);
    if (errors.length > 0) {
      return { ok: false, reason: `Run record ${label} failed schema validation: ${JSON.stringify(errors)}` };
    }
  }
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const freshHash = computePolicySha256({ fresh: true });
  for (const [label, record] of [['A', recordA], ['B', recordB]]) {
    if (record.policy_sha256 !== freshHash) {
      return { ok: false, reason: `Run record ${label} policy_sha256 (${record.policy_sha256}) does not match the current policy-hook.mjs (${freshHash}) -- evidence is stale relative to the code that produced it` };
    }
  }
  let redactedA;
  let redactedB;
  try {
    redactedA = assertCleanOrThrow(JSON.stringify(recordA, null, 2), { privatePatternsFile });
    redactedB = assertCleanOrThrow(JSON.stringify(recordB, null, 2), { privatePatternsFile });
  } catch (err) {
    return { ok: false, reason: `Privacy check refused to clear evidence for writing: ${err.message}` };
  }
  const gate = hardGateFn(recordA, recordB, runA, runB);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  const outDir = writeRunRecordEvidence(runKind, recordA, recordB, runA, runB, redactedA, redactedB);
  return { ok: true, reason: null, outDir };
}

async function cmdCalibrate(args) {
  const model = args.model ?? 'claude-sonnet-5';
  const privatePatternsFile = args['private-patterns-file'] ?? null;
  const privacyStatus = privatePatternsFile ? 'redacted-private' : 'public';
  const { computePolicySha256 } = await import('./policy-config.mjs');
  const templateDir = join(import.meta.dirname, 'fixtures', 'calibration-project');
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
    // prompt: both conditions must show a genuine attempt (proving the prompt actually drives
    // the model to try), and CONFIRMED invocation must track availability exactly -- A attempts
    // but fails (no skill registered), B attempts and succeeds.
    const result = await finalizeAndWriteRecords({
      runKind: 'calibration', recordA, recordB, runA, runB, privatePatternsFile,
      hardGateFn: (a, b) => {
        const ok = a.skill_available.value === false && b.skill_available.value === true
          && a.skill_invocation_attempted.value === true && b.skill_invocation_attempted.value === true
          && a.skill_invoked.value === false && b.skill_invoked.value === true;
        return {
          ok,
          reason: ok ? null : `calibration hard gate failed -- expected A:{available:false,attempted:true,invoked:false} B:{available:true,attempted:true,invoked:true}, got A:{available:${a.skill_available.value},attempted:${a.skill_invocation_attempted.value},invoked:${a.skill_invoked.value}} B:{available:${b.skill_available.value},attempted:${b.skill_invocation_attempted.value},invoked:${b.skill_invoked.value}}`,
        };
      },
    });
    if (!result.ok) {
      console.error(`CALIBRATION FAILED: ${result.reason}`);
      return 1;
    }
    console.log(JSON.stringify({ recordA, recordB, evidenceDir: result.outDir }, null, 2));
    return 0;
  } finally {
    await conditionPair.cleanup();
  }
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
    const common = { runKind: 'smoke', scenarioId: 'kampkit-android-host-test-discovery', skillSourceSha: PINNED_SKILL_SHA, daemonPolicy, allowedGradleTasks, allowedKmpTestSubcommands, policySha256, projectAlias, projectCommit: pinnedCommit, family: 'test-only', modelRequested: model, privacyStatus };
    const recordA = buildRunRecord({ conditionResult: runA, condition: 'no-skill', ...common });
    const recordB = buildRunRecord({ conditionResult: runB, condition: 'current-skill', ...common });

    // Smoke's gate requires EQUIVALENT REAL WORK in both arms -- not just skill availability.
    // hook_call_count>=1 proves the agent actually tried real commands; hook_deny_count===0
    // proves every command it tried was inside the approved grammar (i.e. genuine, useful
    // diagnostic work happened, not "everything got blocked"); malformedLines===0 proves a
    // clean, parseable transcript. skill_invoked is deliberately NOT required here (whether the
    // skill triggers naturally on this prompt is exactly the open question a future
    // corpus-probe run would investigate, not something smoke should presuppose).
    const result = await finalizeAndWriteRecords({
      runKind: 'smoke', recordA, recordB, runA, runB, privatePatternsFile,
      hardGateFn: (a, b, runAResult, runBResult) => {
        const availabilityOk = a.skill_available.value === false && b.skill_available.value === true;
        const realWorkOk = a.hook_call_count >= 1 && a.hook_deny_count === 0
          && b.hook_call_count >= 1 && b.hook_deny_count === 0;
        const cleanTranscriptOk = runAResult.malformedLines.length === 0 && runBResult.malformedLines.length === 0;
        const ok = availabilityOk && realWorkOk && cleanTranscriptOk;
        return {
          ok,
          reason: ok ? null : `smoke hard gate failed -- availabilityOk:${availabilityOk} realWorkOk:${realWorkOk} (A hook_call_count:${a.hook_call_count} hook_deny_count:${a.hook_deny_count}, B hook_call_count:${b.hook_call_count} hook_deny_count:${b.hook_deny_count}) cleanTranscriptOk:${cleanTranscriptOk}`,
        };
      },
    });
    if (!result.ok) {
      console.error(`SMOKE FAILED: ${result.reason}`);
      return 1;
    }
    console.log(JSON.stringify({ recordA, recordB, evidenceDir: result.outDir }, null, 2));
    return 0;
  } finally {
    await conditionPair.cleanup();
  }
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

export { parseArgs, cmdCorpusValidate, cmdAggregate, cmdValidate, cmdCalibrate, cmdSmoke, buildRunRecord, nullableMetric, runConditionPair, finalizeAndWriteRecords };
