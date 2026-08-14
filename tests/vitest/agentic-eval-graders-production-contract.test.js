// tests/vitest/agentic-eval-graders-production-contract.test.js
// Round 10 (systematic-closure pass): proves gradeScenarioCondition() accepts a GENUINELY
// production-real kmp-test envelope -- not a hand-authored JSON literal shaped to look real.
// agentic-eval-graders.test.js deliberately keeps its fixtures as in-memory plain objects/strings
// (its own header comment: "grader tests don't depend on file I/O") -- this file is the one
// dedicated exception, calling the REAL lib/orchestrators/parallel-orchestrator.js `runParallel()`
// in-process (only its external `spawn` and `runCoverageInjection` boundaries are stubbed, exactly
// the same technique tests/vitest/parallel-orchestrator.test.js already uses for its own coverage)
// to capture a byte-for-byte real envelope, then feeds it through the grader unmodified.
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runParallel } from '../../lib/orchestrators/parallel-orchestrator.js';
import { runChanged } from '../../lib/orchestrators/changed-orchestrator.js';
import { gradeScenarioCondition } from '../../tools/agentic-eval/graders.mjs';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Minimal synthetic project: one module ("shared") with commonMain/jvmMain/jvmTest source sets,
// so `--test-type common` resolves via the real `pickGradleTaskFor` to the `jvmTest` task --
// mirrors makeProject()/makeSpawnStub() in tests/vitest/parallel-orchestrator.test.js exactly,
// duplicated here (not imported) since that file's helpers are local, non-exported functions.
function makeSyntheticProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentic-eval-production-contract-'));
  workDir = dir;
  writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "fixture"\ninclude(":shared")\n');
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  const modDir = path.join(dir, 'shared');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(path.join(modDir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
  for (const ss of ['commonMain', 'jvmMain', 'jvmTest']) {
    mkdirSync(path.join(modDir, 'src', ss, 'kotlin'), { recursive: true });
  }
  return dir;
}

// Writes 24 real <testcase/> entries into the exact directory junitTestCountFor's own production
// walk reads (`<module>/build/test-results/<taskShortName>/TEST-*.xml`, confirmed directly against
// tests/vitest/parallel-orchestrator.test.js's own junitTestCountFor coverage) -- so
// `state.tests.individual_total` is computed by the REAL production JUnit-XML walk, not injected
// by this test. The real staleness guard (result-rollup.js's recordLegResults) discards any
// TEST-*.xml whose mtime predates `state.runStartMs` for a 'fresh' execution mode (only
// up_to_date/from_cache bypass it) -- an earlier version of this fixture relied on writing the
// file synchronously inside the stubbed gradle invocation (after runStartMs was captured) to give
// it a real mtime "after the run started," but a live Docker Node 18/24 run found this
// intermittently non-deterministic: filesystem mtime resolution/rounding can put the write's real
// mtime AT OR BEFORE runStartMs even though it happens strictly after in wall-clock terms,
// especially across container filesystem layers (individual_total came back 0 instead of 24 on
// repetition 2 under Node 18, repetition 1 under Node 24). Stamping an explicit, safely-future
// mtime (mirrors the repository's established writeStaleJunitXml pattern in
// parallel-orchestrator.test.js, inverted from past to future) removes the race entirely rather
// than relying on wall-clock ordering.
function writeRealJunitXml(projectRoot, moduleName, taskShortName, testcaseCount) {
  const taskDir = path.join(projectRoot, moduleName, 'build', 'test-results', taskShortName);
  mkdirSync(taskDir, { recursive: true });
  const testcases = Array.from({ length: testcaseCount }, (_, i) => `<testcase classname="com.example.Fake" name="test${i}"/>`).join('');
  const filePath = path.join(taskDir, 'TEST-com.example.FakeTest.xml');
  writeFileSync(filePath, `<testsuite>${testcases}</testsuite>`);
  const future = Math.floor(Date.now() / 1000) + 3600;
  utimesSync(filePath, future, future);
}

function makeSpawnStub(taskFullPath, { projectRoot, moduleName, taskShortName, testcaseCount }) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null });
    writeRealJunitXml(projectRoot, moduleName, taskShortName, testcaseCount);
    return { status: 0, stdout: `> Task ${taskFullPath}\nBUILD SUCCESSFUL in 1s\n`, stderr: '', signal: null, error: null };
  };
  fn.calls = calls;
  return fn;
}

function makeRunCoverageStub() {
  const fn = async () => ({
    envelope: {
      coverage: { tool: 'auto', missed_lines: 0, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] },
      errors: [], warnings: [],
    },
    exitCode: 0,
  });
  return fn;
}

describe('gradeScenarioCondition -- production-real envelope (genuine runParallel() call, only spawn/coverage stubbed)', () => {
  it('a REAL envelope captured from runParallel() -- not hand-authored -- passes validateParallelEvidence and grades success:true', async () => {
    const dir = makeSyntheticProject();
    const spawn = makeSpawnStub(':shared:jvmTest', { projectRoot: dir, moduleName: 'shared', taskShortName: 'jvmTest', testcaseCount: 24 });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', 'shared'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    // Sanity: this really is a genuine, unmodified production envelope, not a re-shaped stand-in.
    expect(exitCode).toBe(0);
    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.parallel.test_type).toBe('common');
    expect(envelope.parallel.legs).toHaveLength(1);
    expect(envelope.parallel.legs[0].test_type).toBe('common');
    expect(envelope.tests.individual_total).toBe(24);
    expect(envelope.tests.failed).toBe(0);

    // Build a scenario expecting exactly what this real project run produces (module :shared, one
    // clean task, 24 real testcases) -- structurally the same shape as this PR's own SCENARIO_1,
    // just pointed at this test's synthetic project instead of the real KaMPKit repo.
    const scenario = {
      schema: 1,
      id: 'production-contract-check',
      family: 'test-only',
      project_alias: 'synthetic',
      project_url: 'https://example.com/synthetic/fixture',
      project_commit: '0'.repeat(40),
      prompt: 'n/a',
      expected_outcome: 'n/a',
      policy: {
        allowed_kmptest_subcommands: ['parallel'],
        allowed_gradle_tasks: [':shared:jvmTest'],
      },
      expected: {
        module: ':shared',
        outcome_kind: 'tests_executed',
        kmp_test: { tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 }, exit_code: 0 },
        gradle: { allowed_invocations: [':shared:jvmTest'], evidence_task: ':shared:jvmTest', tests: { total: 24, passed: 24, failed: 0 }, exit_code: 0 },
      },
      first_useful_signal_predicate: { description: 'n/a' },
      tags: ['train'],
    };

    const finalAnswer = `24/24 tests passed.\n\nKMP_EVAL_RESULT\n${JSON.stringify({ module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0 })}\nKMP_EVAL_RESULT_END\n`;

    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'kmp-test parallel --test-type common --module-filter shared --json' } } ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: JSON.stringify(envelope), is_error: false, tool_use_id: 't1' }] } },
      { type: 'result', subtype: 'success', result: finalAnswer },
    ];
    const bashResults = [{
      index: 1, id: 't1', command: 'kmp-test parallel --test-type common --module-filter shared --json',
      resultFound: true, resultIsError: false, resultIndex: 2, resultContent: JSON.stringify(envelope),
    }];
    const conditionResult = {
      events, bashResults, result: { result: finalAnswer },
      spawnResult: { terminated: false, terminationReason: null },
      gradleJunitEvidence: null,
    };

    const grade = gradeScenarioCondition(conditionResult, scenario);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  // Round 10 (skipped[]/no_applicable_tests family closure): locks the REAL `state.coverage` shape
  // at the modules.length===0 (no_applicable_tests) early-exit against actual production code, not
  // a hand-authored literal -- isCoherentNoApplicableTestsCoverageBlock's own doc comment traces
  // this shape by reading parallel-orchestrator.js; this test proves that trace against a genuine
  // runParallel() call so a future edit to that early-exit's own coverage-block construction (e.g.
  // adding module_buckets to it, or changing missed_lines's initializer) fails HERE first, not
  // silently drifts away from what the grader's own closed-form check expects.
  it("a REAL envelope captured from runParallel()'s own modules.length===0 (no_applicable_tests) early-exit -- --module-filter matching ZERO real modules -- carries the EXACT coverage shape isCoherentNoApplicableTestsCoverageBlock expects, and grades success:true end to end", async () => {
    const dir = makeSyntheticProject();
    const spawn = makeSpawnStub(':shared:jvmTest', { projectRoot: dir, moduleName: 'shared', taskShortName: 'jvmTest', testcaseCount: 24 });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--module-filter', 'nonexistent-module'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    // Sanity: this really is the genuine no_applicable_tests early-exit, not a re-shaped stand-in --
    // zero real gradle dispatch happened at all (the spawn stub was never called).
    expect(spawn.calls).toHaveLength(0);
    expect(exitCode).toBe(2);
    expect(envelope.modules).toEqual([]);
    expect(envelope.errors).toEqual([{
      code: 'no_test_modules',
      message: 'No modules found matching filter: nonexistent-module',
      test_type: '',
      caused_by_filter: true,
    }]);
    // The exact real shape -- pinned field-by-field, not merely "passes the grader's own check",
    // so a drift shows up as a direct assertion failure here, independent of graders.mjs at all.
    expect(envelope.coverage).toEqual({
      tool: 'auto', missed_lines: null, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [],
    });

    const scenario = {
      schema: 1,
      id: 'production-contract-no-applicable-tests-check',
      family: 'test-only',
      project_alias: 'synthetic',
      project_url: 'https://example.com/synthetic/fixture',
      project_commit: '0'.repeat(40),
      prompt: 'n/a',
      expected_outcome: 'n/a',
      policy: {
        allowed_kmptest_subcommands: ['parallel'],
        allowed_gradle_tasks: [],
      },
      expected: {
        module: ':nonexistent-module',
        outcome_kind: 'no_applicable_tests',
        kmp_test: { error_code: 'no_test_modules', exit_code: 2, caused_by_filter: true },
        gradle: { allowed_invocations: [], evidence_task: ':nonexistent-module:test', exit_code: 0, marker: 'NO-SOURCE' },
      },
      first_useful_signal_predicate: { description: 'n/a' },
      tags: ['train'],
    };

    const finalAnswer = `No applicable tests.\n\nKMP_EVAL_RESULT\n${JSON.stringify({ module: ':nonexistent-module', outcome_kind: 'no_applicable_tests' })}\nKMP_EVAL_RESULT_END\n`;
    const command = 'kmp-test parallel --module-filter nonexistent-module --json';
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: JSON.stringify(envelope), is_error: false, tool_use_id: 't1' }] } },
      { type: 'result', subtype: 'success', result: finalAnswer },
    ];
    const bashResults = [{
      index: 1, id: 't1', command, resultFound: true, resultIsError: false, resultIndex: 2, resultContent: JSON.stringify(envelope),
    }];
    const conditionResult = {
      events, bashResults, result: { result: finalAnswer },
      spawnResult: { terminated: false, terminationReason: null },
      gradleJunitEvidence: null,
    };

    const grade = gradeScenarioCondition(conditionResult, scenario);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

// Adversarial-review finding (changed-module-verification scenario): graders.mjs's
// changedEvidenceInvalid hard-depends on a real `kmp-test changed` envelope never carrying a
// top-level `parallel` key -- true today only because changed-orchestrator.js's own `parsed`
// object (fed to buildJsonReport) explicitly lists tests/modules/skipped/coverage/errors/
// warnings/changed/isolated and never copies `parallelEnvelope.parallel` across, even though the
// real runParallel() call it delegates to DOES return one. Nothing previously pinned this against
// REAL production code (only a hand-authored fixture in agentic-eval-graders.test.js, and a live
// ground-truth capture recorded in this PR's own commit message) -- a future edit to
// changed-orchestrator.js that started forwarding `.parallel` (arguably "more complete", and
// exactly what changed.md's own stale doc claims already happens) would silently make every
// correct `changed` attempt grade as evidence-integrity-malformed, with no test catching it.
describe('runChanged() -- production-real envelope never carries a parallel key, even when the delegate call it makes DOES produce one', () => {
  function makeSyntheticGitProject() {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentic-eval-changed-production-contract-'));
    workDir = dir;
    const git = (gitArgs) => {
      const r = spawnSync('git', gitArgs, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "fixture"\ninclude(":shared")\n');
    writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
    const modDir = path.join(dir, 'shared');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(path.join(modDir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    const markerPath = path.join(modDir, 'src', 'commonMain', 'kotlin', 'Marker.kt');
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, 'class Marker\n');
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'initial']);
    // The uncommitted, unstaged edit `changed` must detect via a real `git status --porcelain`.
    writeFileSync(markerPath, 'class Marker\n// mutated\n');
    return dir;
  }

  // Simulates a genuine runParallel() return value -- including a real-shaped `parallel` block,
  // the exact thing being proven to get dropped -- so this test cannot pass merely because the
  // injected stub happened to omit `.parallel` itself.
  function fakeRunParallelWithParallelBlock() {
    return async () => ({
      exitCode: 0,
      envelope: {
        tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
        exit_code: 0, duration_ms: 42,
        tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 },
        modules: [{ name: 'shared', type: 'jvm' }], skipped: [], coverage: {}, errors: [], warnings: [],
        parallel: {
          test_type: 'auto',
          legs: [{ test_type: 'auto', exit_code: 0, execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 }, cascade_detected: false, retry_fired: false }],
          max_workers: 0, timeout_s: 600,
        },
        isolated: { enabled: false, cache_dir: null, kept: false, locked: true },
      },
    });
  }

  it('the real envelope runChanged() returns has NO parallel key, proven against actual production code, not a hand-authored fixture', async () => {
    const dir = makeSyntheticGitProject();
    // `--json` is a GLOBAL flag stripped by lib/runner.js before an orchestrator ever sees argv
    // (confirmed directly in changed-orchestrator.js's own parseArgs doc comment: "Global flags
    // (--json, --force, etc.) were stripped by lib/runner.js") -- calling runChanged() directly,
    // bypassing that layer, must omit it too, exactly like the existing runParallel() production-
    // contract test above never passes it either. `runChanged()` always builds the full envelope
    // object regardless of --json; that flag only controls the real CLI's own stdout rendering.
    const { envelope, exitCode } = await runChanged({
      projectRoot: dir,
      args: ['--no-coverage'],
      spawn: spawnSync,
      log: () => {},
      runParallelInjection: fakeRunParallelWithParallelBlock(),
    });

    expect(exitCode).toBe(0);
    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.subcommand).toBe('changed');
    // The actual pinned fact: even though the injected delegate call returned a real `.parallel`
    // block, runChanged()'s own envelope construction never copies it across.
    expect(Object.prototype.hasOwnProperty.call(envelope, 'parallel')).toBe(false);
    expect(envelope.parallel).toBeUndefined();
    expect(envelope.changed.detected_modules).toEqual(['shared']);
    expect(envelope.changed.base_ref).toBe('HEAD');
    expect(envelope.changed.staged_only).toBe(false);

    // Feed this REAL (not hand-authored) envelope through the grader end to end.
    const scenario = {
      schema: 1,
      id: 'changed-production-contract-check',
      family: 'test-only',
      project_alias: 'synthetic',
      project_url: 'https://example.com/synthetic/fixture',
      project_commit: '0'.repeat(40),
      prompt: 'n/a',
      expected_outcome: 'n/a',
      policy: {
        allowed_kmptest_subcommands: ['changed'],
        allowed_gradle_tasks: [':shared:test'],
      },
      expected: {
        module: ':shared',
        outcome_kind: 'tests_executed',
        kmp_test: { tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 }, exit_code: 0 },
        gradle: { allowed_invocations: [':shared:test'], evidence_task: ':shared:test', tests: { total: 1, passed: 1, failed: 0 }, exit_code: 0 },
        changed: { detected_modules: ['shared'], staged_only: false, base_ref: 'HEAD' },
      },
      first_useful_signal_predicate: { description: 'n/a' },
      tags: ['held-out'],
    };
    const finalAnswer = `1/1 tests passed.\n\nKMP_EVAL_RESULT\n${JSON.stringify({ module: ':shared', outcome_kind: 'tests_executed', total: 1, passed: 1, failed: 0 })}\nKMP_EVAL_RESULT_END\n`;
    const command = 'kmp-test changed --json --project-root . --no-coverage';
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: JSON.stringify(envelope), is_error: false, tool_use_id: 't1' }] } },
      { type: 'result', subtype: 'success', result: finalAnswer },
    ];
    const bashResults = [{
      index: 1, id: 't1', command, resultFound: true, resultIsError: false, resultIndex: 2, resultContent: JSON.stringify(envelope),
    }];
    const conditionResult = {
      events, bashResults, result: { result: finalAnswer },
      spawnResult: { terminated: false, terminationReason: null },
      junitAttribution: { perAttemptJunit: new Map(), decisionByAttempt: new Map([['t1', 'allow']]), ambiguousJunitEvidence: false, captureIncomplete: false, unreliable: false },
    };

    const grade = gradeScenarioCondition(conditionResult, scenario);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.changedEvidenceMalformed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});
