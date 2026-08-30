// tests/vitest/agentic-eval-corpus.test.js
// Validates tools/agentic-eval/corpus/trigger-queries.json content shape: counts/partitions,
// banned-term rules. Also validates corpus/scenarios/*.json presence and schema validity (via
// the real validateScenario()) -- grader-level coverage of each scenario's expected/policy
// contract lives in tests/vitest/agentic-eval-graders.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTriggerQueries, validateScenario } from '../../tools/agentic-eval/schemas.mjs';
import { loadScenarioFile } from '../../tools/agentic-eval/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
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

  // Evidence1 success-recovery PR B, Stage B3 (Section 9.12): coverage-threshold-failure-v2.json
  // is created only in Stage B4, after this RED confirms today's absence. Updated in place
  // (rather than left at 6) because 7 IS the correct post-B4 count -- this line itself flips from
  // failing (6 exist today) to passing once Stage B4 lands, exactly like every other RED case here.
  it('contains exactly the 7 expected scenario files (corpus complete, Stage B4 adds v2)', () => {
    expect(scenarioFiles.sort()).toEqual([
      'changed-module-verification.json',
      'coverage-threshold-failure-v2.json',
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
  // v2 (Stage B4) adds a 5th train-tagged scenario.
  it('tags partition exactly 5 train / 2 held-out across the completed corpus (Stage B4 adds v2, tagged train)', () => {
    const tagCounts = { train: 0, 'held-out': 0 };
    for (const file of scenarioFiles) {
      const { scenario, parseError } = loadScenarioFile(SCENARIOS_DIR, file);
      if (parseError) throw new Error(`${file}: ${parseError}`);
      for (const tag of scenario.tags ?? []) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
    expect(tagCounts).toEqual({ train: 5, 'held-out': 2 });
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

  // Evidence1 success-recovery PR B, Stage B3 (docs/audits/agentic-eval-evidence1-success-recovery-
  // v1-runbook.md, Section 9.12): coverage-threshold-failure-v2.json, the neutral scenario Stage B4
  // creates only after this whole describe block confirms genuine RED (the file does not exist
  // yet). Requirement 8: coverage-threshold-failure.json (the historical scenario) itself is NEVER
  // edited by this PR -- its git blob identity is pinned here to the exact value confirmed unchanged
  // since PR_A_SHA (548a0c14dcb0f29618b1827cb2c6a3c881f55d92), computed via `git hash-object --path`
  // against the real committed file, not assumed.
  describe('coverage-threshold-failure-v2.json (Evidence1 success-recovery PR B, Section 9.8/9.12)', () => {
    const SOURCE_SHA = '7d45eae4f8720a0c77f507712ba2437ff974b6ed';
    const OUTCOME_KIND_VALUES_CANONICAL = ['tests_executed', 'no_applicable_tests', 'tests_failed', 'coverage_threshold_exceeded'];

    function loadV2Scenario() {
      const { scenario, parseError } = loadScenarioFile(SCENARIOS_DIR, 'coverage-threshold-failure-v2.json');
      if (parseError) throw new Error(`coverage-threshold-failure-v2.json: ${parseError}`);
      return scenario;
    }

    // Requirement 8: scenario historico conserva blob identity -- proves THIS file (v2's own test
    // suite) never mutated the historical scenario while designing v2 alongside it. Shells out to
    // the REAL `git hash-object --path` (never a hand-reimplemented sha1-of-"blob N\0"+content in
    // JS) -- this repo's own CRLF-normalization history means a naive raw-byte hash can silently
    // mismatch git's own gitattributes-aware normalization on Windows.
    it('the historical coverage-threshold-failure.json keeps its exact, unchanged git blob identity', () => {
      const relativePath = 'tools/agentic-eval/corpus/scenarios/coverage-threshold-failure.json';
      const blobSha = execFileSync('git', ['hash-object', '--path', relativePath, relativePath], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      expect(blobSha).toBe('e06cf1b4a8c4486e9adaf6ede3f7aee0093f1937');
    });

    // Requirement 9: expected shape valida (also proves the file exists and parses at all).
    it('validateScenario reports zero errors for coverage-threshold-failure-v2.json', () => {
      const { errors } = validateScenario(loadV2Scenario());
      expect(errors).toEqual([]);
    });

    // Requirement 1: id y filename coinciden.
    it('id matches its own filename exactly', () => {
      expect(loadV2Scenario().id).toBe('coverage-threshold-failure-v2');
    });

    // Requirement 2: source SHA exacto (same pin as the historical scenario -- Stage B0 ran
    // against this exact commit).
    it('pins the exact same source commit Stage B0 verified ground truth against', () => {
      expect(loadV2Scenario().project_commit).toBe(SOURCE_SHA);
    });

    // Requirement 3: tag train presente.
    it('is tagged train', () => {
      expect(loadV2Scenario().tags).toContain('train');
    });

    // Requirement 4: prompt no contiene producto, modulo, missed lines ni outcome rellenado.
    it('prompt never mentions the product name, the real module, or the real missed-line count', () => {
      const { prompt } = loadV2Scenario();
      expect(prompt).not.toMatch(/kmp-test/i);
      expect(prompt).not.toMatch(/:core:domain/);
      expect(prompt).not.toMatch(/\b23\b/);
    });

    // Review-round finding (P1): the coverage BUDGET (15 lines) is a TASK requirement the agent
    // must evaluate against -- unlike the real missed-line COUNT (23, the ground-truth answer),
    // which must never leak. Omitting the budget entirely (vaguifying it to "a reasonable coverage
    // budget") leaves FreeBaseline with no way to determine coverage_threshold_exceeded vs
    // tests_executed at all, since it has no other source for the number -- a partially-guessable
    // task, not a fair one. Mirrors the historical scenario's own identical "no more than 15 lines
    // uncovered" framing: naming the budget was never the leak; naming the FLAG
    // (--min-missed-lines) or the ANSWER (23) is.
    it('prompt states the real coverage budget (15) as a natural-language task requirement, never via the --min-missed-lines flag name', () => {
      const { prompt, expected } = loadV2Scenario();
      expect(expected.kmp_test.coverage.min_missed_lines).toBe(15);
      expect(prompt).toMatch(/\b15\b/);
      expect(prompt).not.toMatch(/--min-missed-lines|min-missed-lines/);
    });

    it("prompt does not place the scenario's own correct outcome_kind as the first filled-in example", () => {
      const { prompt, expected } = loadV2Scenario();
      const firstOutcomeMentioned = OUTCOME_KIND_VALUES_CANONICAL
        .map((kind) => ({ kind, index: prompt.indexOf(kind) }))
        .filter((entry) => entry.index !== -1)
        .sort((a, b) => a.index - b.index)[0];
      expect(firstOutcomeMentioned).toBeTruthy();
      expect(firstOutcomeMentioned.kind).not.toBe(expected.outcome_kind);
    });

    // Requirement 5: enum de outcomes completo y neutral.
    it('lists all 4 outcome_kind values in the prompt, in the canonical schemas.mjs order', () => {
      const { prompt } = loadV2Scenario();
      const indices = OUTCOME_KIND_VALUES_CANONICAL.map((kind) => prompt.indexOf(kind));
      expect(indices.every((i) => i !== -1)).toBe(true);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    });

    // Requirement 6: scope de Product y Baseline representa cuatro tests (Stage B0 ground truth:
    // 4 individual tests, module-wide across both build flavors).
    it('both providers\' expected scope represents the same Stage-B0-verified 4 tests', () => {
      const { expected } = loadV2Scenario();
      expect(expected.kmp_test.tests.individual_total).toBe(4);
      expect(expected.gradle.tests.total).toBe(4);
    });

    // Requirement 7: tasks baseline coinciden con B0 y no incluyen tasks ajenas -- exactly the 4
    // tasks Stage B0 itself identified (2 unit-test tasks + 2 coverage-report tasks), nothing else.
    // Review-round finding (P1): a 2-separate-flavor-task design cannot actually reach 4 verified
    // tests -- graders.mjs evaluates ONE Bash attempt against ONE evidence_task; nothing aggregates
    // across attempts. The real, stable, single-invocation path is the umbrella `test` task:
    // lib/parsers/junit-xml.js's forEachJunitXml has a DOCUMENTED, existing branch (taskShort ===
    // 'test') that walks every sibling `*UnitTest` result directory and sums them. Empirically
    // verified (not just read) via a disposable script against synthetic 2-flavor XML fixtures
    // mirroring Stage B0's exact shape: `:core:domain:test` -> 4, `:core:domain:testDemoDebugUnitTest`
    // alone -> 2. junit-xml.js/junit-evidence.mjs are outside PR B's allowlist (lib/** and an
    // unlisted tools/agentic-eval/ file respectively) so this mechanism cannot be re-proven as a
    // new committed unit test here without exceeding scope -- this comment plus the report to the
    // user is the traceable record of that verification. Coverage-report tasks stay listed
    // separately: there is no analogous harness-level independent verification for Gradle-produced
    // coverage XML (confirmed absent by grep across graders.mjs/junit-evidence.mjs), so FreeBaseline
    // may inspect them itself, but its own coverage claim is graded as self-reported evidence, not
    // independently confirmed -- see the paired graders.mjs test coverage for this asymmetry.
    it('allowed Gradle tasks are exactly Stage B0\'s own verified task set -- the umbrella test task (real, single-invocation, 4-test aggregation) plus both flavors\' coverage-report tasks, nothing foreign', () => {
      const { policy } = loadV2Scenario();
      expect(policy.allowed_gradle_tasks.slice().sort()).toEqual([
        ':core:domain:createDemoDebugUnitTestCoverageReport',
        ':core:domain:createProdDebugUnitTestCoverageReport',
        ':core:domain:test',
      ].sort());
    });

    it('the Gradle evidence_task is the umbrella test task -- the one real, single-invocation path Stage B0 + the umbrella-aggregation mechanism jointly verified reaches all 4 tests', () => {
      const { expected } = loadV2Scenario();
      expect(expected.gradle.evidence_task).toBe(':core:domain:test');
      expect(expected.gradle.allowed_invocations).toContain(':core:domain:test');
    });

    it('Product policy keeps its strict, unchanged kmp-test subcommand contract (doctor/describe/parallel)', () => {
      const { policy } = loadV2Scenario();
      expect(policy.allowed_kmptest_subcommands).toEqual(['doctor', 'describe', 'parallel']);
    });

    // Requirement 10: Product y FreeBaseline usan el mismo prompt comun -- structurally guaranteed
    // by a single `prompt` field with no provider-conditional branching text.
    it('has exactly one shared prompt, with no provider-specific branching instructions', () => {
      const { prompt } = loadV2Scenario();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).not.toMatch(/\(Product only\)|\(FreeBaseline only\)|if you have access to kmp-test|if you don't have access to kmp-test/i);
    });

    it('requires the same KMP_EVAL_RESULT final-block protocol the historical scenario already uses', () => {
      const { prompt } = loadV2Scenario();
      expect(prompt).toMatch(/KMP_EVAL_RESULT\b/);
      expect(prompt).toMatch(/KMP_EVAL_RESULT_END\b/);
    });

    it("does not reveal the module or the numeric budget flag in its prompt (mirrors the historical scenario's own prompt-privacy test)", () => {
      const { prompt } = loadV2Scenario();
      expect(prompt).not.toMatch(/--min-missed-lines|min-missed-lines/);
    });
  });
});
