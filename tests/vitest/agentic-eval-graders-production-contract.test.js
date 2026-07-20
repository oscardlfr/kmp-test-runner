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
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runParallel } from '../../lib/orchestrators/parallel-orchestrator.js';
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
// by this test. Called from WITHIN the spawn stub (below), not before runParallel() starts: the
// real staleness guard (result-rollup.js's recordLegResults) discards any TEST-*.xml whose mtime
// predates `state.runStartMs` for a 'fresh' execution mode (only up_to_date/from_cache bypass it)
// -- writing it synchronously inside the stubbed gradle invocation mimics gradle producing fresh
// output as it "runs", giving the file a real mtime after the run started.
function writeRealJunitXml(projectRoot, moduleName, taskShortName, testcaseCount) {
  const taskDir = path.join(projectRoot, moduleName, 'build', 'test-results', taskShortName);
  mkdirSync(taskDir, { recursive: true });
  const testcases = Array.from({ length: testcaseCount }, (_, i) => `<testcase classname="com.example.Fake" name="test${i}"/>`).join('');
  writeFileSync(path.join(taskDir, 'TEST-com.example.FakeTest.xml'), `<testsuite>${testcases}</testsuite>`);
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
});
