// tests/vitest/agentic-eval-graders.test.js
// Unit tests for tools/agentic-eval/graders.mjs -- structured, evidence-anchored scenario
// grading. The "adversarial cases a keyword grader would have wrongly passed" block below
// deliberately includes fixtures a keyword-based grader (the deleted, rejected PR #372 draft's
// design) would have wrongly passed -- each one is a direct regression test for the specific
// reason that design was rejected on review. Later blocks (round-2/round-3/round-4) cover a
// broader set of failure classes surfaced by later review rounds -- envelope self-contradiction,
// JUnit-evidence attribution/provenance, terminal-attempt selection, and regex boundary
// precision -- that have nothing to do with keyword-based text scanning specifically.
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
  // Uses SCENARIO_2 (no_applicable_tests), not SCENARIO_1 -- classifyJunitProvenance's fix (see
  // its own doc comment) means a K+G pair under `tests_executed` is now CORRECTLY flagged
  // ambiguous (a review pass reproduced this as a real false negative when it wasn't flagged), so
  // that shape is no longer a valid "both providers cleanly agree" fixture for tests_executed.
  // no_applicable_tests never consumes JUnit evidence at all, so K+G there is never ambiguous --
  // exactly what this test needs to isolate check 7's own diagnostic-only behavior.
  it('agent uses both providers and they AGREE (both correct) -> no_provider_contradiction passes, doesn\'t affect success', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT },
      ],
      'The :app module has no applicable tests, confirmed via both kmp-test and gradlew directly.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
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

// Round-3 review: a systematic, table-driven adversarial pass (three independent review agents --
// architecture/evidence-lifecycle, adversarial/false-positive-false-negative, test-invariant-audit)
// covering the 8 mandatory reproductions the review specified verbatim, plus the additional findings
// its adversarial pass surfaced beyond those 8, plus targeted dimension-matrix coverage (provider
// producer-counting in both outcome_kind directions, resultIsError:null, a Gradle attempt producing
// no footer line at all, absent JUnit evidence under a non-ambiguous single producer). Each test
// below was verified RED against the pre-round-3 code (9ff2c20, restored via `git stash push --
// tools/agentic-eval/graders.mjs`) before this round's fixes, then GREEN after restoring them --
// except where noted inline that the case was already correctly handled pre-round-3 too (dimension
// coverage, not a regression proof).
describe('gradeScenarioCondition -- round-3 mandatory reproduction 1: K+G JUnit-ambiguity false NEGATIVE', () => {
  it('one kmp-test parallel attempt + one Gradle attempt, both individually clean and agreeing, under tests_executed -> harnessEvidenceAmbiguous must be TRUE (both are real producers of the one pooled JUnit snapshot)', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
      ],
      '24/24 tests passed for :shared, confirmed via both kmp-test and gradlew directly.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
    // The ambiguity is a HARNESS-integrity defect, not a legitimate negative outcome -- it must
    // still degrade the terminal (Gradle) attempt's own outcomeMatches, same as the pre-existing
    // G+G ambiguity test asserts.
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 2: G+G JUnit-ambiguity false POSITIVE under no_applicable_tests', () => {
  it('two Gradle retries (direct invocation, then the lifecycle-alias invocation) under no_applicable_tests -> harnessEvidenceAmbiguous must be FALSE (this outcome_kind never reads JUnit XML at all)', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT },
        { command: './gradlew.bat :app:test --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_ALIAS },
      ],
      'The :app module has no applicable tests (NO-SOURCE), confirmed via two Gradle invocations.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 3: envelope subcommand never cross-checked against the invoked command', () => {
  it('a Bash command classified as "kmp-test parallel", whose OWN JSON content claims subcommand:"doctor" (stale/wrong content), must not pass as parallel evidence', () => {
    const staleSubcommandEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'doctor', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: staleSubcommandEnvelope }],
      '24/24 tests passed in the :shared module via testAndroidHostTest.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 4: no_applicable_tests never bounded individual_total', () => {
  it('a no_test_modules envelope with total/passed/failed correctly all-zero but a STALE non-zero individual_total must fail', () => {
    const staleIndividualTotal = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 2, duration_ms: 21, tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 24 },
      modules: [], skipped: [{ module: 'app', reason: 'no test source set' }], coverage: {},
      errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: app', test_type: '', caused_by_filter: true }],
      warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: staleIndividualTotal }],
      'The :app module has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 5: predicate-position outcome word after "tests"', () => {
  it('"The :app module has no tests failing." must NOT satisfy no-applicable-tests -- predicate position means the OPPOSITE (tests exist, none are failing)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The :app module has no tests failing.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true); // real evidence is still correct
    expect(grade.success).toBe(false); // but the final answer's claim is wrong
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 6: "successful" was never on the old outcome-adjective denylist', () => {
  it('"The :app module has no successful tests." must NOT satisfy no-applicable-tests -- a denylist can never enumerate every outcome adjective', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The :app module has no successful tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 7: cross-clause module/outcome binding, both outcome_kind directions', () => {
  it('tests_executed: module mentioned in one clause, a matching count asserted in a DIFFERENT clause about a DIFFERENT module -- must fail, not pass on independent whole-text presence', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :shared module was also checked for completeness. The :app module has 24 tests passing.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true); // real evidence is still correct for :shared
    expect(grade.success).toBe(false);
  });

  it('no_applicable_tests: expected module mentioned in one clause, "no applicable tests" asserted in a DIFFERENT clause about a DIFFERENT module -- must fail', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'The :app module was checked directly. The :shared module has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 8: Gradle footer regex was start-anchored only, never end-anchored', () => {
  it('"BUILD SUCCESSFUL but this is not a Gradle footer" (starts like a real footer, but is not a complete footer line) must not be accepted as evidence', () => {
    const fakeFooterOnly = `> Task :shared:testAndroidHostTest\n\nBUILD SUCCESSFUL but this is not a Gradle footer\n21 actionable tasks: 21 executed\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeFooterOnly }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('a fake line-start "BUILD SUCCESSFUL ..." sentence followed by a REAL, complete "BUILD FAILED in 2s" footer must not outrank the real (failing) footer', () => {
    const fakeSuccessThenRealFailure = `BUILD SUCCESSFUL but this is not a Gradle footer\n> Task :shared:testAndroidHostTest FAILED\n\nBUILD FAILED in 2s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeSuccessThenRealFailure }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 additional findings beyond the 8 mandatory reproductions', () => {
  it('no_applicable_tests: a matching no_test_modules error PLUS a second, unrelated error entry must fail -- errors[] must contain EXACTLY the one matching entry, nothing else', () => {
    const extraUnrelatedError = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 2, duration_ms: 21, tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 },
      modules: [], skipped: [{ module: 'app', reason: 'no test source set' }], coverage: {},
      errors: [
        { code: 'no_test_modules', message: 'No modules found matching filter: app', test_type: '', caused_by_filter: true },
        { code: 'unrelated_config_warning', message: 'some other, unrelated problem', test_type: '', caused_by_filter: false },
      ],
      warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: extraUnrelatedError }],
      'The :app module has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('tests_executed: an incidental standalone occurrence of the count token with no test-word nearby ("line 24") must not satisfy the test-count assertion', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :shared module test suite is documented on line 24 of the report.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(false);
  });

  it('tests_executed: "...ran 24 tests and none failed" (negation via "none", not "no") is a genuinely correct clean-pass claim and MUST pass -- proves the failure-negation fix does not overcorrect', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :shared module ran 24 tests and none failed.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-3 dimension-matrix coverage (provider ordering, resultIsError:null, absent evidence)', () => {
  it('Gradle content with NO footer line at all (truncated/incomplete output) is malformed, not silently coerced to a pass or fail', () => {
    const noFooterAtAll = `> Task :shared:compileAndroidHostTest UP-TO-DATE\n> Task :shared:testAndroidHostTest\n21 actionable tasks: 21 executed\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: noFooterAtAll }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('gradle path: resultIsError:null (never determined, distinct from an explicit false) with a clean real footer still evaluates correctly from the footer alone -- neither contradiction direction requires a strict-boolean value it doesn\'t have', () => {
    const events = [
      initEventStub(),
      bashToolUseEvent('t1', './gradlew.bat :shared:testAndroidHostTest --console=plain'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: GRADLE_SCENARIO1_PASS_STDOUT, is_error: null, tool_use_id: 't1' }] } },
      resultEventStub('24/24 tests passed for :shared via testAndroidHostTest.'),
    ];
    const bashResults = [{
      index: 1, id: 't1', command: './gradlew.bat :shared:testAndroidHostTest --console=plain',
      resultFound: true, resultIsError: null, resultIndex: 2, resultContent: GRADLE_SCENARIO1_PASS_STDOUT,
    }];
    const cr = {
      events, bashResults, result: { result: '24/24 tests passed for :shared via testAndroidHostTest.' },
      spawnResult: { terminated: false, terminationReason: null },
      gradleJunitEvidence: { total: 24, passed: 24, failed: 0 },
    };
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('tests_executed: a single (non-ambiguous) Gradle attempt with an otherwise-clean footer but gradleJunitEvidence:null (never captured) must fail closed, not pass on the footer alone', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      '24/24 tests passed for :shared via testAndroidHostTest.',
      { gradleJunitEvidence: null },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false); // exactly one producer -- not an ambiguity case
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

// Round-4 review: 3 FRESH reviewers (none of whom had seen the round-3 fix) independently attacked
// the updated diff, tasked with inventing NEW counterexamples rather than confirming the round-3
// list. Two reviewers independently converged on the same root gap in classifyJunitProvenance from
// different angles (adversarial example-hunting vs. from-scratch invariant re-derivation); a third
// audited the round-3 tests themselves and found 3 of them (linking-verb, module-anchored count gap,
// plural "failures") had shipped with zero corresponding regression tests. Every test below was
// verified RED against the pre-round-4 code (round-3, commit not yet made at review time -- restored
// via `git stash push -- tools/agentic-eval/graders.mjs`) before the round-4 fix, then GREEN after.
describe('gradeScenarioCondition -- round-4: clauseAssertsFailure never recognized the plural noun "failures"', () => {
  it('"...with 3 failures" (plural noun, no verb form) must be recognized as asserting a failure, not silently pass a clean-pass scenario', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      '24 tests ran in the :shared module, with 3 failures.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true); // real evidence is still a clean pass
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-4: OUTCOME_PREDICATE_AFTER_TESTS_RE was defeated by any linking verb/adverb between "tests" and the outcome word', () => {
  it.each([
    'The :app module has no tests currently failing.',
    'The :app module has no tests still failing.',
    'The :app module has no tests right now failing.',
  ])('%s -- must NOT satisfy no-applicable-tests (still asserts the opposite: tests exist, none are failing right now)', (text) => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      text,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-4: clauseAssertsTestCount\'s proximity gap was either too narrow (module name inflates char-distance) or too wide (blanket word-count reopens the "line 24" false positive)', () => {
  it('"24 of the :shared module\'s tests passed, with 0 failures." -- a genuinely correct answer with the module name between the count and "tests" -- must PASS', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      "24 of the :shared module's tests passed, with 0 failures.",
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('control: "...documented on line 24 of the report." must still fail -- proves the module-anchored gap did not just widen back into the original incidental-token false positive', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :shared module test suite is documented on line 24 of the report.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-4: classifyJunitProvenance counted a kmp-test parallel call as a JUnit producer regardless of which module it targeted, or whether any Gradle attempt even existed to consume the pooled snapshot', () => {
  it('kmp-test-only condition (wrong module, then the right one) with ZERO Gradle attempts anywhere -- must NOT be ambiguous, since nothing in this condition ever reads the pooled Gradle-JUnit snapshot', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      '24/24 tests passed in :shared.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('two kmp-test parallel retries on the SAME module, still ZERO Gradle attempts -- must NOT be ambiguous either', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --gradle-args --rerun-tasks --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      '24/24 tests passed.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });

  it('kmp-test (wrong module) + kmp-test (right module) + a real Gradle attempt on the right module -- IS still correctly ambiguous (a real Gradle-path consumer exists, and the on-target kmp-test call is a real potential producer alongside it)', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
      ],
      '24/24 tests passed for :shared.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-4: terminal-attempt selection did not distinguish "a later attempt that never even tried the target module" from "a later attempt that did try, but failed"', () => {
  it('a correct, complete answer for the expected module followed by unrelated exploration of a DIFFERENT module afterward must still succeed -- the later, off-target call must not silently become "terminal"', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      'The :app module has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('regression guard: a LATER wrong/malformed retry on the SAME (on-target) module still correctly overrides an earlier good one -- the round-3 retry-tolerance test\'s exact shape must not have regressed', () => {
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

  it('when NO attempt ever targets the expected module at all, terminal still falls back to the last attempt overall -- the single-wrong-module-only failure case must not have regressed', () => {
    const otherModulePass = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 3 },
      modules: [{ name: 'app', type: 'android' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: otherModulePass }],
      '3/3 tests passed in the :app module.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-4: evaluateKmpTestAttempt only ever inspected envelope.modules[0], never the rest of the array', () => {
  it('a multi-module envelope (no --module-filter -- ran the whole project) with the target module\'s real data at modules[1], not modules[0], must still be recognized as targeting the right module', () => {
    const multiModuleEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'some-other-module', type: 'kmp' }, { name: 'shared', type: 'kmp' }],
      skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --json', resultContent: multiModuleEnvelope }],
      '24/24 tests passed in :shared.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-4: a clause joined by "but" (or a semicolon) let a count attach to the WRONG module\'s mention within the same period-terminated sentence', () => {
  it('"The :app module ran 24 tests, but :shared has no applicable tests." -- factually backwards about :shared -- must fail, not pass because ":shared" and "24 tests" both appear somewhere in the one comma/but-joined sentence', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :app module ran 24 tests, but :shared has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true); // real evidence is still correct for :shared
    expect(grade.success).toBe(false);
  });

  it('the semicolon-joined equivalent must also fail for the same reason', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :app module ran 24 tests; :shared has no applicable tests.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('regression guard: a legitimate "but" clause that stays entirely about the SAME (correct) module must still pass -- the split must not fragment a genuinely single-topic compound sentence into an unfairly-rejected pair', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :shared module ran 24 tests, but coverage could be improved.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-4: dimension-matrix gaps a fresh test-completeness audit found (provider ordering, explicit harnessEvidenceAmbiguous coverage, check-1 never independently failed)', () => {
  it('Gradle-FIRST, kmp-test-SECOND ordering (the mirror of the only-ever-tested kmp-test-first ordering) -- terminal is the later kmp-test attempt, still grades correctly', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      '24/24 tests passed for :shared, confirmed via gradlew directly and then kmp-test.',
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // K+G under tests_executed is a real ambiguity (both are potential JUnit producers) -- same as
    // the K-then-G ordering already covered; this test's own purpose is only to prove the REVERSE
    // ordering (G-then-K) is handled at all, not to re-assert the ambiguity finding itself.
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
  });

  it('kmp-test-only condition (single attempt) under tests_executed -- harnessEvidenceAmbiguous is explicitly false (no second producer of any kind)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      '24/24 tests passed in :shared.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });

  it('Gradle-only condition under no_applicable_tests -- harnessEvidenceAmbiguous is explicitly false (this outcome_kind never reads JUnit XML)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT }],
      'The :app module has no applicable tests (NO-SOURCE).',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });

  it('K+G BOTH used under no_applicable_tests -- harnessEvidenceAmbiguous is explicitly false (still never reads JUnit XML, regardless of which/how-many providers were used)', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT },
      ],
      'The :app module has no applicable tests, confirmed via both kmp-test and gradlew directly.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });

  it('no_transcript_structural_issues (check 1) is independently driven to FAILING by a genuinely malformed transcript (a duplicate init event) -- this grader\'s own wiring of check 1 has a real failing-case proof, not just a passing one', () => {
    const duplicateInitEvents = [initEventStub(), initEventStub(), resultEventStub('irrelevant')];
    const cr = {
      events: duplicateInitEvents, bashResults: [], result: { result: 'irrelevant' },
      spawnResult: { terminated: false, terminationReason: null }, gradleJunitEvidence: null,
    };
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'no_transcript_structural_issues').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});
