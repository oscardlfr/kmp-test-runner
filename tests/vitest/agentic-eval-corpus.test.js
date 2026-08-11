// tests/vitest/agentic-eval-corpus.test.js
// Validates tools/agentic-eval/corpus/trigger-queries.json content shape: counts/partitions,
// banned-term rules. Also validates corpus/scenarios/*.json presence and schema validity (via
// the real validateScenario()) -- grader-level coverage of each scenario's expected/policy
// contract lives in tests/vitest/agentic-eval-graders.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTriggerQueries, validateScenario } from '../../tools/agentic-eval/schemas.mjs';
import { loadScenarioFile } from '../../tools/agentic-eval/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, '..', '..', 'tools', 'agentic-eval', 'corpus');
const SCENARIOS_DIR = path.join(CORPUS_DIR, 'scenarios');
const BANNED_TERMS_RE = /\bkmp-test\b|kmp-test-runner|bin[\\/]kmp-test\.js/i;

const trigger = JSON.parse(readFileSync(path.join(CORPUS_DIR, 'trigger-queries.json'), 'utf8'));

// Regression coverage for a real contradiction an independent review pass found: `corpus
// validate` (cli.mjs's cmdCorpusValidate) previously only counted should-trigger/near-miss
// categories, even though the README claims it validates shape and banned terms too. Fixed by
// porting this file's own assertions into a shared, exported validateTriggerQueries() that both
// the CLI command and this test call -- proving here that it agrees with every individual
// assertion below, on the SAME real corpus file, so the two can never silently drift apart.
it('validateTriggerQueries reports zero errors for the real, committed trigger-queries.json', () => {
  const { errors } = validateTriggerQueries(trigger);
  expect(errors).toEqual([]);
});

describe('trigger-queries.json', () => {
  it('has at least 10 should-trigger queries', () => {
    const shouldTrigger = trigger.queries.filter((q) => q.expected === 'should-trigger');
    expect(shouldTrigger.length).toBeGreaterThanOrEqual(10);
  });

  it('has at least 10 near-miss queries', () => {
    const nearMiss = trigger.queries.filter((q) => q.expected === 'near-miss');
    expect(nearMiss.length).toBeGreaterThanOrEqual(10);
  });

  it('has both train and held-out partitions represented in each category', () => {
    for (const expected of ['should-trigger', 'near-miss']) {
      const partitions = new Set(trigger.queries.filter((q) => q.expected === expected).map((q) => q.partition));
      expect(partitions.has('train')).toBe(true);
      expect(partitions.has('held-out')).toBe(true);
    }
  });

  it('declares repeats support (default_repeats >= 1)', () => {
    expect(trigger.default_repeats).toBeGreaterThanOrEqual(1);
  });

  it('every query has a unique id', () => {
    const ids = trigger.queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no query text mentions kmp-test, the skill name, or the bin path', () => {
    for (const q of trigger.queries) {
      expect(BANNED_TERMS_RE.test(q.text)).toBe(false);
    }
  });

  it('no query text mentions an expected command or activation result', () => {
    const suspiciousRe = /--json|--dry-run|gradlew|Skill tool|invoke the skill/i;
    for (const q of trigger.queries) {
      expect(suspiciousRe.test(q.text)).toBe(false);
    }
  });
});

describe('corpus/scenarios/', () => {
  const scenarioFiles = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json'));

  it('contains exactly the 6 expected scenario files (corpus complete)', () => {
    expect(scenarioFiles.sort()).toEqual([
      'changed-module-verification.json',
      'coverage-threshold-failure.json',
      'deterministic-unit-test-failure.json',
      'kampkit-android-host-test-discovery.json',
      'kampkit-no-applicable-tests.json',
      'nowinandroid-core-common.json',
    ]);
  });

  // changed-module-verification moved train<-held-out: the fix that closed its 0/2 canary-v3 gap
  // (tools/agentic-eval/corpus/scenarios/changed-module-verification.json, SKILL.md Decision
  // protocol Step 1) was directly informed by this scenario's own failure, so it can no longer be
  // honestly held-out. 3/3 was the corpus's original, now-historical balance -- see BACKLOG.md.
  it('tags partition exactly 4 train / 2 held-out across the completed corpus', () => {
    const tagCounts = { train: 0, 'held-out': 0 };
    for (const file of scenarioFiles) {
      const { scenario, parseError } = loadScenarioFile(SCENARIOS_DIR, file);
      if (parseError) throw new Error(`${file}: ${parseError}`);
      for (const tag of scenario.tags ?? []) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
    expect(tagCounts).toEqual({ train: 4, 'held-out': 2 });
  });

  // Reuses cli.mjs's own loadScenarioFile (never throws on malformed JSON) rather than a
  // hand-rolled readFileSync+JSON.parse, and is called INSIDE each it() below (never at
  // describe-body top level) so a malformed/missing scenario file fails only that one test, not
  // the whole file. (The directory listing above is safe to keep at describe-body scope --
  // SCENARIOS_DIR is a long-lived, always-present directory, same as CORPUS_DIR's own top-level
  // use for trigger-queries.json.)
  function loadNowinandroidScenario() {
    const { scenario, parseError } = loadScenarioFile(SCENARIOS_DIR, 'nowinandroid-core-common.json');
    if (parseError) throw new Error(`nowinandroid-core-common.json: ${parseError}`);
    return scenario;
  }

  it('validateScenario reports zero errors for nowinandroid-core-common.json', () => {
    const { errors } = validateScenario(loadNowinandroidScenario());
    expect(errors).toEqual([]);
  });

  it('targets :core:common, expects tests_executed, and is tagged held-out', () => {
    const scenario = loadNowinandroidScenario();
    expect(scenario.expected.module).toBe(':core:common');
    expect(scenario.expected.outcome_kind).toBe('tests_executed');
    expect(scenario.tags).toEqual(['held-out']);
  });

  it('expects the ground-truth-verified 1/1/0 counts on both providers', () => {
    const scenario = loadNowinandroidScenario();
    expect(scenario.expected.kmp_test.tests).toEqual({
      total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1,
    });
    expect(scenario.expected.gradle.tests).toEqual({ total: 1, passed: 1, failed: 0 });
  });

  // deterministic-unit-test-failure -- the first tests_failed scenario. Ground truth
  // independently verified 6x (3x kmp-test, 3x direct Gradle, cold GRADLE_USER_HOME each)
  // against android/nowinandroid @ 058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8's :lint module.
  function loadDeterministicTestFailureScenario() {
    const { scenario, parseError } = loadScenarioFile(SCENARIOS_DIR, 'deterministic-unit-test-failure.json');
    if (parseError) throw new Error(`deterministic-unit-test-failure.json: ${parseError}`);
    return scenario;
  }

  it('validateScenario reports zero errors for deterministic-unit-test-failure.json', () => {
    const { errors } = validateScenario(loadDeterministicTestFailureScenario());
    expect(errors).toEqual([]);
  });

  it('targets :lint, expects tests_failed, and is tagged held-out', () => {
    const scenario = loadDeterministicTestFailureScenario();
    expect(scenario.expected.module).toBe(':lint');
    expect(scenario.expected.outcome_kind).toBe('tests_failed');
    expect(scenario.tags).toEqual(['held-out']);
  });

  it('expects the ground-truth-verified counts on both providers -- kmp_test is TASK-level (1 task, failed), gradle is per-testcase JUnit (3 tests, all failed)', () => {
    const scenario = loadDeterministicTestFailureScenario();
    expect(scenario.expected.kmp_test.tests).toEqual({
      total: 1, passed: 0, failed: 1, skipped: 0, individual_total: 3,
    });
    expect(scenario.expected.gradle.tests).toEqual({ total: 3, passed: 0, failed: 3 });
    expect(scenario.expected.kmp_test.exit_code).toBe(1);
    expect(scenario.expected.gradle.exit_code).toBe(1);
  });

  it('does not reveal the module, task, or failing test in its prompt', () => {
    const scenario = loadDeterministicTestFailureScenario();
    expect(scenario.prompt).not.toMatch(/:lint|TestMethodDetectorTest|detect prefix|detect format|detect underscores/);
  });

  // coverage-threshold-failure -- the first coverage_threshold_exceeded scenario. Ground truth
  // independently verified 6x (3x kmp-test, 3x direct Gradle + independent XML parse, cold
  // GRADLE_USER_HOME each, fixed JDK 17) against android/nowinandroid @
  // 7d45eae4f8720a0c77f507712ba2437ff974b6ed's :core:domain module. A review round rejected an
  // earlier candidate, :core:datastore: its --module-filter substring-collided with a sibling
  // test-fixtures module (:core:datastore-test), which is both operationally unreachable via the
  // pinned skill's own ask-guard AND let a real target-attribution gap in the grader go unnoticed.
  // :core:domain has zero substring collision with any other real module in this project.
  function loadCoverageThresholdFailureScenario() {
    const { scenario, parseError } = loadScenarioFile(SCENARIOS_DIR, 'coverage-threshold-failure.json');
    if (parseError) throw new Error(`coverage-threshold-failure.json: ${parseError}`);
    return scenario;
  }

  it('validateScenario reports zero errors for coverage-threshold-failure.json', () => {
    const { errors } = validateScenario(loadCoverageThresholdFailureScenario());
    expect(errors).toEqual([]);
  });

  it('targets :core:domain, expects coverage_threshold_exceeded, family coverage, and is tagged train', () => {
    const scenario = loadCoverageThresholdFailureScenario();
    expect(scenario.expected.module).toBe(':core:domain');
    expect(scenario.expected.outcome_kind).toBe('coverage_threshold_exceeded');
    expect(scenario.family).toBe('coverage');
    expect(scenario.tags).toEqual(['train']);
  });

  it('expects the ground-truth-verified counts and coverage claim on both providers', () => {
    const scenario = loadCoverageThresholdFailureScenario();
    expect(scenario.expected.kmp_test.tests).toEqual({
      total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 4,
    });
    expect(scenario.expected.kmp_test.exit_code).toBe(1);
    expect(scenario.expected.kmp_test.coverage).toEqual({
      tool: 'auto', min_missed_lines: 15, missed_lines: 23, with_data: [':core:domain'],
    });
    expect(scenario.expected.gradle.tests).toEqual({ total: 2, passed: 2, failed: 0 });
    expect(scenario.expected.gradle.exit_code).toBe(0);
    expect(scenario.expected.gradle.evidence_task).toBe(':core:domain:testDemoDebugUnitTest');
  });

  it('does not reveal the module or the numeric flag in its prompt', () => {
    const scenario = loadCoverageThresholdFailureScenario();
    expect(scenario.prompt).not.toMatch(/:core:domain|--min-missed-lines|min-missed-lines/);
  });

  // changed-module-verification -- the 6th and final scenario, the first (and, by this contract's
  // own single-module scope, only) requiring `kmp-test changed` as terminal proof. Ground truth
  // independently re-verified live 6x (3x kmp-test changed, 3x direct Gradle, cold
  // GRADLE_USER_HOME + JDK 17 each) against the SAME pinned commit coverage-threshold-failure and
  // nowinandroid-core-common already use, 7d45eae4f8720a0c77f507712ba2437ff974b6ed, targeting the
  // SAME :core:common module/counts as nowinandroid-core-common -- but via a pre-run fixture_setup
  // mutation (an unstaged, harness-constant comment appended to a pinned-blob-verified tracked
  // file) instead of being told the module outright.
  function loadChangedModuleVerificationScenario() {
    const { scenario, parseError } = loadScenarioFile(SCENARIOS_DIR, 'changed-module-verification.json');
    if (parseError) throw new Error(`changed-module-verification.json: ${parseError}`);
    return scenario;
  }

  it('validateScenario reports zero errors for changed-module-verification.json', () => {
    const { errors } = validateScenario(loadChangedModuleVerificationScenario());
    expect(errors).toEqual([]);
  });

  it('targets :core:common, expects tests_executed, family test-only, and is tagged train', () => {
    const scenario = loadChangedModuleVerificationScenario();
    expect(scenario.expected.module).toBe(':core:common');
    expect(scenario.expected.outcome_kind).toBe('tests_executed');
    expect(scenario.family).toBe('test-only');
    expect(scenario.tags).toEqual(['train']);
  });

  it('expects the ground-truth-verified 1/1/0 counts on both providers, matching nowinandroid-core-common exactly', () => {
    const scenario = loadChangedModuleVerificationScenario();
    expect(scenario.expected.kmp_test.tests).toEqual({
      total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1,
    });
    expect(scenario.expected.gradle.tests).toEqual({ total: 1, passed: 1, failed: 0 });
  });

  it('expects the ground-truth-verified expected.changed block -- bare (colon-less) module name, unstaged, base_ref HEAD', () => {
    const scenario = loadChangedModuleVerificationScenario();
    expect(scenario.expected.changed).toEqual({
      detected_modules: ['core:common'], staged_only: false, base_ref: 'HEAD',
    });
  });

  it('declares a closed fixture_setup pinned to the ground-truth-verified blob', () => {
    const scenario = loadChangedModuleVerificationScenario();
    expect(scenario.fixture_setup).toEqual({
      operation: 'append_comment',
      relative_path: 'core/common/src/main/kotlin/com/google/samples/apps/nowinandroid/core/common/result/Result.kt',
      expected_blob_oid: '934b6dfb2bb6ad97453094b72a67daa1aab590df',
    });
  });

  it("policy allows 'changed' alongside 'parallel' -- parallel stays policy-legal so the grader's own rejection (not a policy denial) is what proves it never satisfies this scenario", () => {
    const scenario = loadChangedModuleVerificationScenario();
    expect(scenario.policy.allowed_kmptest_subcommands).toEqual(['doctor', 'describe', 'parallel', 'changed']);
  });

  it('does not reveal the module, the file, or the "changed" subcommand in its prompt', () => {
    const scenario = loadChangedModuleVerificationScenario();
    expect(scenario.prompt).not.toMatch(/:core:common|Result\.kt|kmp-test changed|\bchanged\b/i);
  });
});
