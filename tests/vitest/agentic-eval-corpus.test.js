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

  it('contains exactly the 4 expected scenario files', () => {
    expect(scenarioFiles.sort()).toEqual([
      'deterministic-unit-test-failure.json',
      'kampkit-android-host-test-discovery.json',
      'kampkit-no-applicable-tests.json',
      'nowinandroid-core-common.json',
    ]);
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
});
