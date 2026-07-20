// tests/vitest/agentic-eval-graders.test.js
// Unit tests for tools/agentic-eval/graders.mjs -- structured, evidence-anchored scenario
// grading. Deliberately includes adversarial fixtures a keyword-based grader (the deleted,
// rejected PR #372 draft's design) would have wrongly passed -- each one is a direct regression
// test for the specific reason that design was rejected on review.
import { describe, it, expect } from 'vitest';
import { extractKmpTestEnvelope, gradeScenarioCondition, GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';

// The exact two scenario shapes this PR ships, matching corpus/scenarios/*.json byte-for-byte
// (kept here as plain objects so grader tests don't depend on file I/O -- schema-shape coverage
// for the actual committed files lives in agentic-eval-schemas.test.js).
const SCENARIO_1 = {
  schema: 1,
  id: 'kampkit-android-host-test-discovery',
  family: 'test-only',
  project_alias: 'kampkit',
  project_url: 'https://github.com/touchlab/KaMPKit',
  project_commit: 'b3a7784fb969a8558b88c80674c8b596944cdab7',
  prompt: "This Kotlin Multiplatform project's Android module has unit tests, but I'm not sure the obvious Gradle task actually runs them. Can you find out and run them, then tell me the result?",
  expected_outcome: 'The agent discovers and runs the non-obvious Android host-test task for the :shared module and reports the accurate pass/fail count.',
  policy: {
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    allowed_gradle_tasks: [':shared:tasks', ':shared:testAndroidHostTest'],
  },
  expected: {
    module: ':shared',
    outcome_kind: 'tests_executed',
    kmp_test: { tests: { total: 1, passed: 1, failed: 0, individual_total: 24 }, exit_code: 0 },
    gradle: { allowed_invocations: [':shared:testAndroidHostTest'], evidence_task: ':shared:testAndroidHostTest', tests: { total: 24, passed: 24, failed: 0 }, exit_code: 0 },
  },
  first_useful_signal_predicate: { description: 'first well-formed evidence confirming :shared 24/24' },
  tags: ['train'],
};

const SCENARIO_2 = {
  schema: 1,
  id: 'kampkit-no-applicable-tests',
  family: 'test-only',
  project_alias: 'kampkit',
  project_url: 'https://github.com/touchlab/KaMPKit',
  project_commit: 'b3a7784fb969a8558b88c80674c8b596944cdab7',
  prompt: 'Can you run the tests for the module that only contains resource/asset files in this project, and tell me what happened?',
  expected_outcome: 'The agent correctly reports that the :app module has no applicable unit tests.',
  policy: {
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    allowed_gradle_tasks: [':app:tasks', ':app:testDebugUnitTest', ':app:test'],
  },
  expected: {
    module: ':app',
    outcome_kind: 'no_applicable_tests',
    kmp_test: { error_code: 'no_test_modules', exit_code: 2, caused_by_filter: true },
    gradle: { allowed_invocations: [':app:testDebugUnitTest', ':app:test'], evidence_task: ':app:testDebugUnitTest', exit_code: 0, marker: 'NO-SOURCE' },
  },
  first_useful_signal_predicate: { description: 'first well-formed evidence confirming :app has no applicable tests' },
  tags: ['train'],
};

// --- synthetic event/conditionResult builders (matches the real stream-json shapes used
// throughout this suite, e.g. agentic-eval-hard-gates.test.js's own helpers) ---
function initEventStub() {
  return { type: 'system', subtype: 'init' };
}
function resultEventStub(text) {
  return { type: 'result', subtype: 'success', result: text };
}
function bashToolUseEvent(id, command) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } };
}
function toolResultEvent(id, content, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content, is_error: isError, tool_use_id: id }] } };
}

/** Builds a full conditionResult from a list of {command, resultContent, resultIsError} steps
 * plus a final answer string -- computes bashResults the same shape
 * findBashToolUsesWithResults() produces (index/resultIndex/resultContent), by hand, so these
 * tests don't need parseStreamJsonl in the loop. */
function buildConditionResult(steps, finalAnswerText, { terminated = false, terminationReason = null, gradleJunitEvidence = null, dropFinalResultEvent = false } = {}) {
  const events = [initEventStub()];
  const bashResults = [];
  for (const step of steps) {
    const id = `t${bashResults.length + 1}`;
    const bashIndex = events.length;
    events.push(bashToolUseEvent(id, step.command));
    let resultIndex = null;
    if (step.resultContent !== undefined) {
      resultIndex = events.length;
      events.push(toolResultEvent(id, step.resultContent, step.resultIsError ?? false));
    }
    bashResults.push({
      index: bashIndex, id, command: step.command,
      resultFound: resultIndex != null, resultIsError: resultIndex != null ? (step.resultIsError ?? false) : null,
      resultIndex, resultContent: resultIndex != null ? step.resultContent : null,
    });
  }
  if (!dropFinalResultEvent) events.push(resultEventStub(finalAnswerText));
  return {
    events, bashResults, result: dropFinalResultEvent ? null : { result: finalAnswerText },
    spawnResult: { terminated, terminationReason },
    gradleJunitEvidence,
  };
}

const KMP_TEST_ENVELOPE_SCENARIO1_PASS = JSON.stringify({
  tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
  project_root: 'C:\\fake', exit_code: 0, duration_ms: 13169,
  tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
  modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
});

const KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS = JSON.stringify({
  tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
  project_root: 'C:\\fake', exit_code: 2, duration_ms: 21,
  tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 },
  modules: [], skipped: [{ module: 'app', reason: 'no test source set' }], coverage: {},
  errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: app', test_type: '', caused_by_filter: true }],
  warnings: [],
});

const GRADLE_SCENARIO1_PASS_STDOUT = `> Task :shared:compileAndroidHostTest UP-TO-DATE\n> Task :shared:testAndroidHostTest\n\nBUILD SUCCESSFUL in 8s\n21 actionable tasks: 21 executed\n`;

const GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT = `> Task :app:compileDebugUnitTestJavaWithJavac NO-SOURCE\n> Task :app:processDebugUnitTestJavaRes NO-SOURCE\n> Task :app:testDebugUnitTest NO-SOURCE\n\nBUILD SUCCESSFUL in 7s\n32 actionable tasks: 32 executed\n`;

const GRADLE_SCENARIO2_NO_SOURCE_VIA_ALIAS = `> Task :app:testDebugUnitTest NO-SOURCE\n> Task :app:test UP-TO-DATE\n\nBUILD SUCCESSFUL in 1s\n2 actionable tasks: 2 executed\n`;

describe('GRADING_CHECK_NAMES', () => {
  it('is exactly 8 unique names', () => {
    expect(GRADING_CHECK_NAMES.length).toBe(8);
    expect(new Set(GRADING_CHECK_NAMES).size).toBe(8);
  });
});

describe('extractKmpTestEnvelope', () => {
  it('parses a clean, direct kmp-test --json stdout (the shape observed in every real capture during implementation)', () => {
    const envelope = extractKmpTestEnvelope(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    expect(envelope).not.toBeNull();
    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.tests.individual_total).toBe(24);
  });

  it('falls back to locating a balanced {...} substring when the content has banner text around it', () => {
    const noisy = `[NOTICE] host JDK 23 meets AGP 9.1.1 floor\n${KMP_TEST_ENVELOPE_SCENARIO1_PASS}\nSome trailing note.`;
    const envelope = extractKmpTestEnvelope(noisy);
    expect(envelope).not.toBeNull();
    expect(envelope.tool).toBe('kmp-test');
  });

  it('returns null for content that is not JSON at all', () => {
    expect(extractKmpTestEnvelope('BUILD SUCCESSFUL in 1s')).toBeNull();
  });

  it('returns null for well-formed JSON that is not a kmp-test envelope (e.g. some other tool\'s output)', () => {
    expect(extractKmpTestEnvelope(JSON.stringify({ ok: true, count: 3 }))).toBeNull();
  });

  it('returns null for null/empty/non-string content, never throws', () => {
    expect(extractKmpTestEnvelope(null)).toBeNull();
    expect(extractKmpTestEnvelope('')).toBeNull();
    expect(extractKmpTestEnvelope(undefined)).toBeNull();
  });

  // Review-fix regression: the original implementation only scanned the FIRST balanced {...}
  // substring -- a decoy/wrapper object appearing BEFORE the real envelope in the same content
  // made the real envelope invisible entirely, since the (non-conforming) first object was the
  // only one ever examined.
  it('finds a real envelope even when a non-conforming decoy JSON object appears BEFORE it in the same content', () => {
    const noisy = `{"wrapper":"meta"}\n${KMP_TEST_ENVELOPE_SCENARIO1_PASS}`;
    const envelope = extractKmpTestEnvelope(noisy);
    expect(envelope).not.toBeNull();
    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.tests.individual_total).toBe(24);
  });

  it('finds a real envelope when a non-conforming decoy JSON object appears AFTER it too', () => {
    const noisy = `${KMP_TEST_ENVELOPE_SCENARIO1_PASS}\n{"trailer":"meta"}`;
    const envelope = extractKmpTestEnvelope(noisy);
    expect(envelope).not.toBeNull();
    expect(envelope.tool).toBe('kmp-test');
  });

  it('returns null (ambiguous) when TWO conforming envelopes both appear in the same content, rather than silently picking one', () => {
    const twoEnvelopes = `${KMP_TEST_ENVELOPE_SCENARIO1_PASS}\n${KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS}`;
    expect(extractKmpTestEnvelope(twoEnvelopes)).toBeNull();
  });

  it('does NOT dig inside a single, whole-string-parseable-but-non-conforming JSON value looking for a nested envelope', () => {
    // The whole trimmed content parses as exactly ONE JSON value (a wrapper object with the real
    // envelope only as a NESTED field) -- this must not be treated the same as noisy/concatenated
    // content; the outer object is the only thing "printed", and it doesn't conform.
    const wrapped = JSON.stringify({ wrapper: 'meta', nested: JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS) });
    expect(extractKmpTestEnvelope(wrapped)).toBeNull();
  });
});

describe('gradeScenarioCondition -- scenario 1 (:shared, tests_executed) happy paths', () => {
  it('kmp-test path: exact match on module + task-level + individual counts -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      '24/24 tests passed in the :shared module via testAndroidHostTest.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.checks.every((c) => c.passed)).toBe(true);
  });

  it('gradle path (direct evidence_task invocation): exact match -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a doctor call before the real parallel call is auxiliary -- never counted as a competing/ambiguous envelope', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test doctor --json', resultContent: JSON.stringify({ tool: 'kmp-test', schema_version: 2, subcommand: 'doctor', tests: { total: 0, passed: 0, failed: 0 }, modules: [], errors: [] }) },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      '24/24 tests passed in :shared.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    const evidenceCheck = grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed');
    expect(evidenceCheck.passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
  });
});

describe('gradeScenarioCondition -- scenario 2 (:app, no_applicable_tests) happy paths', () => {
  it('kmp-test path: clean no_test_modules/caused_by_filter match -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The :app module has no applicable unit tests -- no test source set.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('gradle path via the DIRECT evidence_task invocation -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT }],
      'The :app module has no applicable tests (NO-SOURCE).',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  // The load-bearing fairness fix (decision 3): the lifecycle alias is policy-allowed, and the
  // marker is still correctly read from evidence_task's own status line regardless of which
  // invocation the agent actually typed.
  it('gradle path via the :app:test LIFECYCLE ALIAS still passes -- marker read from evidence_task regardless of invocation', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:test --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_ALIAS }],
      'The :app module has no applicable tests (NO-SOURCE).',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    const targetCheck = grade.checks.find((c) => c.name === 'authoritative_target_matches_expected');
    expect(targetCheck.passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- decision 13 fix: check 5 (target) is a REQUIRED conjunct of expectedOutcomeMatched', () => {
  // The exact bug found on review: a wrong-module attempt whose counts happen to coincidentally
  // match must NOT read as expectedOutcomeMatched:true. Construct a kmp-test envelope for a
  // DIFFERENT module that happens to have the identical 1/1/0/24 shape scenario 1 expects.
  it('a well-formed envelope for the WRONG module, with coincidentally-matching counts, fails target AND outcome -- never a match', () => {
    const wrongModuleEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 }, // identical shape to SCENARIO_1's expectation
      modules: [{ name: 'some-other-module', type: 'kmp' }], // but the WRONG module
      skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter some-other-module --json', resultContent: wrongModuleEnvelope }],
      '24/24 tests passed.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- decision 5: retry tolerance, last-relevant-attempt rule', () => {
  it('a first FAILED/wrong attempt followed by a corrected, matching retry -> the retry (terminal) wins', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }, // wrong module for scenario 1
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }, // corrected retry
      ],
      '24/24 tests passed in :shared.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a first CORRECT attempt followed by a LATER wrong/malformed one -> the terminal (bad) attempt determines the verdict', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: 'not json at all' },
      ],
      'Confusing final answer.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('first_useful_signal is the EARLIEST correct attempt, not the terminal one', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }, // correct, first
        { command: 'kmp-test parallel --module-filter shared --gradle-args --rerun-tasks --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }, // also correct, later (a legitimate double-check)
      ],
      '24/24 tests passed.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // Event 2 is the FIRST tool_result (index 0=init, 1=tool_use, 2=tool_result).
    expect(grade.firstUsefulSignalEventIndex).toBe(2);
  });
});

describe('gradeScenarioCondition -- decision 13: provider contradiction is diagnostic-only, never gates the verdict', () => {
  it('agent uses both providers and they AGREE (both correct) -> no_provider_contradiction passes, doesn\'t affect success', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
      ],
      '24/24 tests passed in :shared, confirmed via both kmp-test and gradlew directly.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'no_provider_contradiction').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('agent uses both providers and they DISAGREE -> no_provider_contradiction fails as its own independent check, but does not by itself flip expectedOutcomeMatched (which is governed by the terminal attempt)', () => {
    const wrongGradleStdout = `> Task :shared:testAndroidHostTest FAILED\n\nBUILD FAILED in 3s\n`;
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }, // says pass
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: wrongGradleStdout, resultIsError: true }, // says fail -- terminal attempt
      ],
      'Not sure what happened -- results were inconsistent.',
      { gradleJunitEvidence: { total: 24, passed: 20, failed: 4 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'no_provider_contradiction').passed).toBe(false);
    // The terminal (gradle, FAILED) attempt determines expectedOutcomeMatched -- it does not match
    // scenario 1's expected clean pass, independent of the contradiction check's own verdict.
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- adversarial cases a keyword grader would have wrongly passed', () => {
  // The EXACT anti-pattern the deleted PR #372 draft's graders.mjs embodied: `/no.*test|zero.*test/i`
  // or `/pass|fail/i` against the raw final-answer text alone, with no check that ANY real command
  // ever ran. A final answer containing expected words without authoritative execution evidence
  // must fail.
  it('final answer says all the right words but NO Bash tool_use ever ran -- must fail (no evidence, not text-graded)', () => {
    const cr = buildConditionResult([], '24/24 tests passed in the :shared module via testAndroidHostTest, no failures.');
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'bash_tool_use_present').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a vague keyword-shaped final answer ("no tests failed!") with ZERO real evidence must still fail', () => {
    const cr = buildConditionResult([], 'Good news -- no tests failed! Everything is fine.');
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.success).toBe(false);
  });

  it('agent runs the WRONG module\'s tests and accurately reports THAT module -- must fail scenario 1 (target mismatch), not pass on "sounds right"', () => {
    const otherModulePass = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 3 },
      modules: [{ name: 'app', type: 'android' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: otherModulePass }],
      '3/3 tests passed in the :app module.', // accurate for :app, but scenario 1 targets :shared
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a Bash tool_use with NO tool_result at all (orphan, non-timeout) -- final text still confidently asserts an outcome -- must fail on tool_result_correlated, not pass on confident narration', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json' /* no resultContent -- orphaned */ }],
      '24/24 tests passed in :shared.',
      { terminated: false }, // NOT a timeout -- this orphan is unexplained
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'tool_result_correlated').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('multiple ambiguous-looking envelopes from legitimate retries never produce a false "ambiguous" pass on a wrong final answer -- the terminal attempt still governs', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --gradle-args --rerun-tasks --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      'I think something failed, not sure.', // final answer contradicts the real (passing) evidence
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // Real evidence is clean and matches -- expectedOutcomeMatched is true regardless of the vague
    // final answer, but success requires the final-answer check too, which correctly fails here.
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('scenario 2: final answer fabricates a specific pass count for a module with no applicable tests -- must fail', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'Great news -- 5 of 5 tests passed in the :app module!', // fabricated -- real evidence shows zero applicable tests
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('scenario 2: a bare "Done" final answer is not a positive, specific fact -- must fail (decision 8)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'Done.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true); // real evidence is still correct
    expect(grade.success).toBe(false); // but success requires the positive final-answer fact too
  });

  // Review-fix regression: the original implementation never checked resultIsError at all and
  // simply asked "does BUILD SUCCESSFUL appear ANYWHERE in the content" -- a real repro with
  // resultIsError:true (the Bash call itself failed) alongside SUCCESSFUL-looking text graded as
  // a genuine pass.
  it('a Gradle attempt with resultIsError:true, despite BUILD SUCCESSFUL text present, must fail (never silently trusts the text over resultIsError)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, resultIsError: true }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a Gradle attempt whose LAST footer is BUILD FAILED (an earlier retry\'s BUILD SUCCESSFUL text still sitting earlier in the content) must fail, not pass on "SUCCESSFUL appears somewhere"', () => {
    const retriedThenFailed = `${GRADLE_SCENARIO1_PASS_STDOUT}\n> Task :shared:testAndroidHostTest FAILED\n\nBUILD FAILED in 2s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: retriedThenFailed }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  // Review-fix regression: JUnit XML is captured ONCE per condition (after the whole cell
  // finishes), never per-attempt -- if MORE than one Gradle attempt targets the scenario's allowed
  // invocations within a single condition, that one snapshot cannot be reliably attributed to any
  // SPECIFIC attempt. Must fail closed rather than silently attributing it to both/either.
  it('two Gradle attempts in the same condition targeting the evidence task -- JUnit evidence is ambiguous, must fail closed even though both attempts look clean', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain --rerun-tasks', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
      ],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
    // Round-2 review fix: this must be surfaced as a HARNESS-INTEGRITY defect (so cmdRun can block
    // the whole matrix's promotion via scenarioCellIntegrityOk), not merely degrade outcomeMatches
    // to false and read as "the agent got it wrong" -- a valid negative result the ambiguity is
    // NOT.
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
  });

  it('a SINGLE Gradle attempt (no ambiguity) still passes normally -- the ambiguity fix does not regress the ordinary one-attempt case', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });

  // Review-fix regression: plain `.includes()` for the bare module name treated "app" as
  // "mentioned" inside completely unrelated words like "application".
  it('scenario 2: final answer says "application" (never the actual module) -- must NOT count as mentioning :app', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'This application has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('scenario 2: final answer correctly says "the app module" (standalone word) -- DOES count as mentioning :app', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The app module has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });
});

// Round-2 review fixes: 3 more P1s + 1 P2, each confirmed by direct reproduction before fixing.
describe('gradeScenarioCondition -- round-2 review fixes', () => {
  it('kmp-test path: resultIsError:true alongside an envelope claiming exit_code:0 must fail, never trust the envelope over resultIsError', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS, resultIsError: true }],
      '24/24 tests passed in the :shared module via testAndroidHostTest.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('kmp-test path: an envelope self-contradictorily carrying BOTH a no_test_modules error AND matching passing test counts must fail (tests_executed scenario)', () => {
    const contradictoryEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {},
      errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: shared', test_type: '', caused_by_filter: true }],
      warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: contradictoryEnvelope }],
      '24/24 tests passed in the :shared module via testAndroidHostTest.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('kmp-test path: a no_test_modules envelope with NON-zero test counts must fail (no_applicable_tests scenario) -- the converse self-contradiction', () => {
    const contradictoryEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 2, duration_ms: 21, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 3 },
      modules: [], skipped: [{ module: 'app', reason: 'no test source set' }], coverage: {},
      errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: app', test_type: '', caused_by_filter: true }],
      warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: contradictoryEnvelope }],
      'The :app module has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('scenario 2: "The :foo:app module has no applicable tests" must NOT satisfy the :app mention requirement -- :foo:app is a different, unrelated nested module', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The :foo:app module has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('scenario 2: "The :app module has no failing tests" must NOT satisfy the no-applicable-tests claim -- it means the OPPOSITE (tests exist, none failed)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The :app module has no failing tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('scenario 2: "does not have any tests" (an alternate genuine no-applicable-tests phrasing) still passes -- the adjective guard does not overcorrect', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The :app module does not have any tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('Gradle path: a diagnostic/warning line merely MENTIONING "BUILD FAILED" mid-sentence (not at line-start) must not be mistaken for the real footer', () => {
    const withMisleadingDiagnostic = `${GRADLE_SCENARIO1_PASS_STDOUT}\nNote: if you see BUILD FAILED in CI, check your JDK version.\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: withMisleadingDiagnostic }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // The real footer (BUILD SUCCESSFUL, at line-start) still governs -- the diagnostic mention
    // mid-sentence must not flip the outcome.
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('Gradle path: a genuine SECOND footer line (BUILD FAILED, at its own line-start, after an earlier BUILD SUCCESSFUL) still correctly flips the outcome to failed', () => {
    const genuineRetryThenFailed = `${GRADLE_SCENARIO1_PASS_STDOUT}\n> Task :shared:testAndroidHostTest FAILED\n\nBUILD FAILED in 2s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: genuineRetryThenFailed }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- timeout tolerance integration', () => {
  it('a legitimate timeout mid-Bash-call, with otherwise-clean structure, does not fail checks 1/3 on its own', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test doctor --json', resultContent: JSON.stringify({ tool: 'kmp-test', schema_version: 2, subcommand: 'doctor', tests: { total: 0, passed: 0, failed: 0 }, modules: [], errors: [] }) },
        { command: 'kmp-test parallel --module-filter shared --json' /* killed mid-flight */ },
      ],
      'irrelevant',
      { terminated: true, terminationReason: 'timeout', dropFinalResultEvent: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'no_transcript_structural_issues').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'tool_result_correlated').passed).toBe(true);
    // Still correctly fails on evidence (nothing usable was ever produced) -- a timeout is
    // tolerated structurally, it doesn't fabricate evidence that was never captured.
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});
