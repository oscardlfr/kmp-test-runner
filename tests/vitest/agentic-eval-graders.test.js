// tests/vitest/agentic-eval-graders.test.js
// Unit tests for tools/agentic-eval/graders.mjs -- structured, evidence-anchored scenario
// grading. The final-answer check (check 8) validates a strict, uniquely parseable
// `KMP_EVAL_RESULT` JSON block the scenario's own prompt requires the agent to emit -- free
// prose is never inspected for grading (see graders.mjs's own header comment for why: three
// review rounds of prose-parsing regex fixes kept finding new bypasses in sharper form, which
// was the signal that patching individual phrasings could never fully close an open-ended
// natural-language surface). Round-5 (this file's current state) replaced that whole apparatus;
// earlier rounds' tests that exercised prose-parsing specifics were removed as obsolete (they
// tested a mechanism that no longer exists), not "fixed" -- their intent is now covered by the
// smaller, structural KMP_EVAL_RESULT test group instead.
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
  prompt: "This Kotlin Multiplatform project's Android module has unit tests, but I'm not sure the obvious Gradle task actually runs them. Can you find out and run them, then tell me the result? Once you know the result, end your reply with a block in exactly this format...",
  expected_outcome: 'The agent discovers and runs the non-obvious Android host-test task for the :shared module and reports the accurate pass/fail count.',
  policy: {
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    allowed_gradle_tasks: [':shared:tasks', ':shared:testAndroidHostTest'],
  },
  expected: {
    module: ':shared',
    outcome_kind: 'tests_executed',
    kmp_test: { tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 }, exit_code: 0 },
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
  prompt: 'Can you run the tests for the module that only contains resource/asset files in this project, and tell me what happened? Once you know the result, end your reply with a block in exactly this format...',
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

/** Builds a realistic final-answer string: some natural prose (never inspected for grading) plus
 * a well-formed `KMP_EVAL_RESULT` block (the only thing check 8 actually reads). */
function kmpEvalResultText(prose, block) {
  return `${prose}\n\nKMP_EVAL_RESULT\n${JSON.stringify(block)}\nKMP_EVAL_RESULT_END\n`;
}

const SCENARIO_1_CORRECT_ANSWER = kmpEvalResultText(
  '24/24 tests passed in the :shared module via testAndroidHostTest.',
  { module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0 },
);
const SCENARIO_2_CORRECT_ANSWER = kmpEvalResultText(
  'The :app module has no applicable unit tests -- no test source set.',
  { module: ':app', outcome_kind: 'no_applicable_tests' },
);

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
  // made the real envelope invisible entirely, since only the first balanced object was ever
  // examined.
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
    const wrapped = JSON.stringify({ wrapper: 'meta', nested: JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS) });
    expect(extractKmpTestEnvelope(wrapped)).toBeNull();
  });
});

describe('gradeScenarioCondition -- scenario 1 (:shared, tests_executed) happy paths', () => {
  it('kmp-test path: exact match on module + task-level + individual counts -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.checks.every((c) => c.passed)).toBe(true);
  });

  it('gradle path (direct evidence_task invocation): exact match -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('gradle path via the DIRECT evidence_task invocation -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT }],
      SCENARIO_2_CORRECT_ANSWER,
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
      SCENARIO_2_CORRECT_ANSWER,
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
      kmpEvalResultText('24/24 tests passed.', { module: ':some-other-module', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0 }),
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
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // Event 2 is the FIRST tool_result (index 0=init, 1=tool_use, 2=tool_result).
    expect(grade.firstUsefulSignalEventIndex).toBe(2);
  });
});

describe('gradeScenarioCondition -- decision 13: provider contradiction is diagnostic-only, never gates the verdict', () => {
  // Uses SCENARIO_2 (no_applicable_tests), not SCENARIO_1 -- classifyJunitProvenance's fix (see
  // its own doc comment) means a K+G pair under `tests_executed` is now CORRECTLY flagged
  // ambiguous, so that shape is no longer a valid "both providers cleanly agree" fixture for
  // tests_executed. no_applicable_tests never consumes JUnit evidence at all, so K+G there is
  // never ambiguous -- exactly what this test needs to isolate check 7's own diagnostic-only
  // behavior.
  it('agent uses both providers and they AGREE (both correct) -> no_provider_contradiction passes, doesn\'t affect success', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT },
      ],
      SCENARIO_2_CORRECT_ANSWER,
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

describe('gradeScenarioCondition -- structural/evidence adversarial cases (evidence quality, not prose)', () => {
  it('final answer contains a well-formed, matching KMP_EVAL_RESULT block but NO Bash tool_use ever ran -- must fail (no evidence, not text-graded)', () => {
    const cr = buildConditionResult([], SCENARIO_1_CORRECT_ANSWER);
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'bash_tool_use_present').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('agent runs the WRONG module\'s tests and accurately (and correctly-formatted) reports THAT module -- must fail scenario 1 (target mismatch), not pass on "the block parses fine"', () => {
    const otherModulePass = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 3 },
      modules: [{ name: 'app', type: 'android' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: otherModulePass }],
      kmpEvalResultText('3/3 tests passed in the :app module.', { module: ':app', outcome_kind: 'tests_executed', total: 3, passed: 3, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a Bash tool_use with NO tool_result at all (orphan, non-timeout) -- final text still confidently asserts an outcome -- must fail on tool_result_correlated, not pass on confident narration', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json' /* no resultContent -- orphaned */ }],
      SCENARIO_1_CORRECT_ANSWER,
      { terminated: false }, // NOT a timeout -- this orphan is unexplained
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'tool_result_correlated').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('multiple ambiguous-looking envelopes from legitimate retries never produce a false pass on a VAGUE final answer with no block -- the terminal attempt still governs expectedOutcomeMatched, but success still needs the block', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --gradle-args --rerun-tasks --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      'I think something failed, not sure.', // no KMP_EVAL_RESULT block at all -- vague, uncommitted
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // Real evidence is clean and matches -- expectedOutcomeMatched is true regardless of the vague
    // final answer, but success requires the structured block too, which correctly fails here.
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('scenario 2: a bare "Done" final answer (no block at all) is not a positive, specific fact -- must fail (decision 8)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'Done.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true); // real evidence is still correct
    expect(grade.success).toBe(false); // but success requires the structured block too
  });

  it('a Gradle attempt with resultIsError:true, despite BUILD SUCCESSFUL text present, must fail (never silently trusts the text over resultIsError)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, resultIsError: true }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
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
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
    // This must be surfaced as a HARNESS-INTEGRITY defect (so cmdRun can block the whole matrix's
    // promotion via scenarioCellIntegrityOk), not merely degrade outcomeMatches to false and read
    // as "the agent got it wrong" -- a valid negative result the ambiguity is NOT.
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
  });

  it('a SINGLE Gradle attempt (no ambiguity) still passes normally -- the ambiguity fix does not regress the ordinary one-attempt case', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });
});

describe('gradeScenarioCondition -- envelope self-contradiction (review-round-2/3 fixes, still relevant under the structured-block design)', () => {
  it('kmp-test path: resultIsError:true alongside an envelope claiming exit_code:0 must fail, never trust the envelope over resultIsError', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS, resultIsError: true }],
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('Gradle path: a diagnostic/warning line merely MENTIONING "BUILD FAILED" mid-sentence (not at line-start) must not be mistaken for the real footer', () => {
    const withMisleadingDiagnostic = `${GRADLE_SCENARIO1_PASS_STDOUT}\nNote: if you see BUILD FAILED in CI, check your JDK version.\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: withMisleadingDiagnostic }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // The real footer (BUILD SUCCESSFUL, at line-start, the ONLY genuine footer line) still
    // governs -- the diagnostic mention mid-sentence must not be counted as a second footer.
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
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

// Round-3 review: 3 fresh review agents (architecture/adversarial/test-invariant), converged on
// a root cause -- kmp-test envelope and Gradle footer evidence are per-attempt-attributable, but
// JUnit XML is a pooled per-condition snapshot. The tests below cover the structural (non-prose)
// findings from that round; the round's prose-parsing-specific findings (predicate-position
// negation, an unenumerable outcome-adjective denylist, cross-clause binding) were removed in
// round 5 as obsolete -- they tested a mechanism (free-prose parsing) that no longer exists.
describe('gradeScenarioCondition -- round-3 mandatory reproduction 1: K+G JUnit-ambiguity false NEGATIVE', () => {
  it('one kmp-test parallel attempt + one Gradle attempt, both individually clean and agreeing, under tests_executed -> harnessEvidenceAmbiguous must be TRUE (both are real producers of the one pooled JUnit snapshot)', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
      ],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
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
      SCENARIO_2_CORRECT_ANSWER,
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
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 mandatory reproduction 8 + round-4: Gradle footer regex must be a complete, single, real footer line', () => {
  it('"BUILD SUCCESSFUL but this is not a Gradle footer" (starts like a real footer, but is not a complete footer line) must not be accepted as evidence', () => {
    const fakeFooterOnly = `> Task :shared:testAndroidHostTest\n\nBUILD SUCCESSFUL but this is not a Gradle footer\n21 actionable tasks: 21 executed\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeFooterOnly }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('a fake line-start "BUILD SUCCESSFUL ..." sentence followed by a REAL, complete "BUILD FAILED in 2s" footer -- exactly one REAL footer line exists, so it correctly governs', () => {
    const fakeSuccessThenRealFailure = `BUILD SUCCESSFUL but this is not a Gradle footer\n> Task :shared:testAndroidHostTest FAILED\n\nBUILD FAILED in 2s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeSuccessThenRealFailure }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 additional finding: no_applicable_tests errors[] must contain EXACTLY the one matching entry', () => {
  it('a matching no_test_modules error PLUS a second, unrelated error entry must fail', () => {
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
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-3 dimension-matrix coverage (Gradle footer absent, resultIsError:null, absent JUnit evidence)', () => {
  it('Gradle content with NO footer line at all (truncated/incomplete output) is malformed, not silently coerced to a pass or fail', () => {
    const noFooterAtAll = `> Task :shared:compileAndroidHostTest UP-TO-DATE\n> Task :shared:testAndroidHostTest\n21 actionable tasks: 21 executed\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: noFooterAtAll }],
      SCENARIO_1_CORRECT_ANSWER,
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
      resultEventStub(SCENARIO_1_CORRECT_ANSWER),
    ];
    const bashResults = [{
      index: 1, id: 't1', command: './gradlew.bat :shared:testAndroidHostTest --console=plain',
      resultFound: true, resultIsError: null, resultIndex: 2, resultContent: GRADLE_SCENARIO1_PASS_STDOUT,
    }];
    const cr = {
      events, bashResults, result: { result: SCENARIO_1_CORRECT_ANSWER },
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
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: null },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false); // exactly one producer -- not an ambiguity case
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

// Round-4 review: 3 fresh reviewers found 4 more real bugs on top of round 3's fix, 2 of which
// (module-unscoped kmp-test JUnit-producer counting; a terminal-attempt-selection bug) are still
// structurally valid under round 5's redesign. The other two round-4 findings did NOT survive
// round 5 unchanged: the "search envelope.modules[] for the target" fix (round 4's own attempt to
// close a false-negative) was itself later found to accept an UNPROVEN multi-module attribution --
// round 5 replaced it with a stricter requirement (see the "command/envelope module coherence"
// group below). The "but"/semicolon clause-splitting fix was superseded entirely by removing
// prose parsing from the grading path.
describe('gradeScenarioCondition -- round-4: classifyJunitProvenance module-scoping + dry-run-free producer counting', () => {
  it('kmp-test-only condition (wrong module, then the right one) with ZERO Gradle attempts anywhere -- must NOT be ambiguous, since nothing in this condition ever reads the pooled Gradle-JUnit snapshot', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_1_CORRECT_ANSWER,
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
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-4: terminal-attempt selection distinguishes "never tried the target" from "tried, but failed"', () => {
  it('a correct, complete answer for the expected module followed by unrelated exploration of a DIFFERENT module afterward must still succeed -- the later, off-target call must not silently become "terminal"', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('regression guard: a LATER wrong/malformed retry on the SAME (on-target) module still correctly overrides an earlier good one', () => {
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
      kmpEvalResultText('3/3 tests passed in the :app module.', { module: ':app', outcome_kind: 'tests_executed', total: 3, passed: 3, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-4 dimension-matrix coverage (provider ordering, explicit harnessEvidenceAmbiguous coverage, check-1 independently failed)', () => {
  it('Gradle-FIRST, kmp-test-SECOND ordering (the mirror of the only-ever-tested kmp-test-first ordering) is handled the same way', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
  });

  it('kmp-test-only condition (single attempt) under tests_executed -- harnessEvidenceAmbiguous is explicitly false (no second producer of any kind)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });

  it('Gradle-only condition under no_applicable_tests -- harnessEvidenceAmbiguous is explicitly false (this outcome_kind never reads JUnit XML)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT }],
      SCENARIO_2_CORRECT_ANSWER,
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
      SCENARIO_2_CORRECT_ANSWER,
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

// ---------------------------------------------------------------------------------------------
// Round 5: systematic redesign (not another regex patch) covering 4 real bugs a fresh review
// found in the round-4 diff -- each affecting core metrics (testInvocationsTotal, terminal
// selection, target attribution, evidence coherence), not phrasing. See graders.mjs's own header
// and each function's doc comment for the full rationale.
// ---------------------------------------------------------------------------------------------

describe('gradeScenarioCondition -- round-5: planning (--dry-run) vs execution', () => {
  it('a --dry-run kmp-test call followed by a real, correct execution -- testInvocationsTotal/retries count only the REAL execution, not the plan', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --dry-run --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.testInvocationsTotal).toBe(1);
    expect(grade.retries).toBe(0);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a real, CORRECT execution followed by a LATER --dry-run call -- the dry-run must not silently become "terminal" and flip a correct result to a failure', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --dry-run --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.testInvocationsTotal).toBe(1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a --dry-run kmp-test call plus a real Gradle execution -- must NOT generate a false JUnit-provenance ambiguity (the dry-run never touched the real Gradle task or its JUnit XML)', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --dry-run --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT },
      ],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a Gradle --dry-run invocation is excluded the same way (consistency across both providers, not just kmp-test)', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :shared:testAndroidHostTest --dry-run --console=plain', resultContent: 'BUILD SUCCESSFUL in 1s\n' },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // Only the real kmp-test attempt counts -- the dry-run Gradle call is invisible to
    // testInvocationsTotal, terminal selection, and JUnit provenance alike.
    expect(grade.testInvocationsTotal).toBe(1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-5: command/envelope module coherence, no unproven multi-module attribution', () => {
  it('command explicitly filtered to --module-filter app, but the envelope itself claims modules:[{name:"shared"}] -- internally contradictory, must fail even though "shared" happens to be the real target', () => {
    const contradictoryEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: contradictoryEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('a whole-project run (no --module-filter) whose envelope lists TWO modules, target at index 1 -- must fail: the AGGREGATE tests.total/passed/failed cannot be safely attributed to any ONE of several listed modules', () => {
    const multiModuleEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'some-other-module', type: 'kmp' }, { name: 'shared', type: 'kmp' }],
      skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --json', resultContent: multiModuleEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('regression guard: the ordinary case -- a single-module envelope whose module matches BOTH the invoked filter AND the scenario target -- still passes cleanly', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
  });

  it('no_applicable_tests: a whole-project run with no --module-filter can never prove a no_test_modules result was specifically about the target module -- must fail even with a correct error_code', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-5: structured KMP_EVAL_RESULT block replaces free-prose final-answer grading', () => {
  it('no KMP_EVAL_RESULT block anywhere in the final answer -- must fail, regardless of how confident or correct-sounding the prose is', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      '24/24 tests passed in the :shared module via testAndroidHostTest, no failures at all.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(false);
  });

  it('a KMP_EVAL_RESULT block whose content is not valid JSON must fail', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'Done.\n\nKMP_EVAL_RESULT\n{not valid json at all\nKMP_EVAL_RESULT_END\n',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a block naming the WRONG module must fail even though outcome_kind and counts are otherwise correct', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      kmpEvalResultText('24/24 tests passed.', { module: ':app', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a block claiming the WRONG outcome_kind (no_applicable_tests) for a tests_executed scenario must fail', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      kmpEvalResultText('The :shared module has no applicable tests.', { module: ':shared', outcome_kind: 'no_applicable_tests' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a block with the right module/outcome_kind but WRONG counts (claims 3 failed when the real evidence is 0 failed) must fail -- this is what closes the "ran 24 tests, but 3 failed" class structurally: the block itself must be internally correct, not just co-present with correct-sounding prose', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      kmpEvalResultText('The :shared module ran 24 tests, but 3 failed.', { module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 21, failed: 3 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a block carrying an EXTRA, unexpected key must fail -- the schema is exact, not merely a minimum', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      kmpEvalResultText('24/24 tests passed.', { module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0, confidence: 'high' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a block MISSING a required key (failed) must fail', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'Done.\n\nKMP_EVAL_RESULT\n{"module": ":shared", "outcome_kind": "tests_executed", "total": 24, "passed": 24}\nKMP_EVAL_RESULT_END\n',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('TWO KMP_EVAL_RESULT blocks present (the agent second-guessed itself) -- ambiguous, must fail, never resolved by picking one', () => {
    const text = `First attempt.\n\nKMP_EVAL_RESULT\n${JSON.stringify({ module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0 })}\nKMP_EVAL_RESULT_END\n\nActually, let me restate:\n\nKMP_EVAL_RESULT\n${JSON.stringify({ module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0 })}\nKMP_EVAL_RESULT_END\n`;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      text,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('prose says something WRONG/backwards, but the block is CORRECT -- must still PASS for this input, consistent with prose being diagnostic-only (a broader, dedicated prose-sensitivity sweep lives in the review notes, not as a single test\'s claim)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      kmpEvalResultText('The :app module ran 24 tests and :shared was inspected.', { module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 24, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('prose is entirely CORRECT and confident, but the block is absent -- must still FAIL for this input; prose alone, however clean, does not substitute for the required block', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      'The :shared module ran 24 tests via testAndroidHostTest, all 24 passed, zero failures.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a well-formed, exactly-matching no_applicable_tests block passes for scenario 2', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-5: envelope skipped counter validated (not just total/passed/failed/individual_total)', () => {
  it('an otherwise-clean tests_executed envelope with a stray non-zero skipped count must fail', () => {
    const skippedEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 42, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: skippedEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('a no_applicable_tests envelope with a non-zero skipped count must also fail (the converse case)', () => {
    const skippedEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 2, duration_ms: 21, tests: { total: 0, passed: 0, failed: 0, skipped: 5, individual_total: 0 },
      modules: [], skipped: [{ module: 'app', reason: 'no test source set' }], coverage: {},
      errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: app', test_type: '', caused_by_filter: true }],
      warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: skippedEnvelope }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-5: Gradle footer requires a REAL duration grammar', () => {
  it('"BUILD SUCCESSFUL in this diagnostic only" (footer-shaped, but not a real duration) must not be accepted as evidence', () => {
    const fakeDuration = `> Task :shared:testAndroidHostTest\n\nBUILD SUCCESSFUL in this diagnostic only\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeDuration }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('regression guard: a genuine COMPOUND duration ("1m 30s") is still accepted, not just bare seconds', () => {
    const compoundDuration = `> Task :shared:compileAndroidHostTest UP-TO-DATE\n> Task :shared:testAndroidHostTest\n\nBUILD SUCCESSFUL in 1m 30s\n21 actionable tasks: 21 executed\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: compoundDuration }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-5: more than one Gradle footer line within a SINGLE tool_result fails closed (never "last wins")', () => {
  it('a genuine SECOND footer line (BUILD FAILED, at its own line-start, after an earlier BUILD SUCCESSFUL) within the SAME tool_result content is now ambiguous evidence, not a "the later one wins" resolution -- one tool_result represents one attempt, and two footer lines within it cannot both be that attempt\'s real outcome', () => {
    const genuineRetryThenFailed = `${GRADLE_SCENARIO1_PASS_STDOUT}\n> Task :shared:testAndroidHostTest FAILED\n\nBUILD FAILED in 2s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: genuineRetryThenFailed }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('two footer lines that happen to AGREE (both BUILD SUCCESSFUL) are STILL ambiguous -- the rule is "exactly one", not "the values must differ"', () => {
    const twoAgreeingFooters = `${GRADLE_SCENARIO1_PASS_STDOUT}\n> Task :shared:testAndroidHostTest UP-TO-DATE\n\nBUILD SUCCESSFUL in 1s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: twoAgreeingFooters }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

// Round 6: a fresh architecture review of round 5's own redesign (explicitly NOT another
// keyword/regex hunt -- see the review's own framing) found 4 more real gaps: --list/--list-only
// is a second, documented kmp-test flag with the exact same "never dispatches" semantics as
// --dry-run, left unrecognized; the no_applicable_tests branch of computeKmpTestTargetMatch never
// checked envelope.modules.length, an asymmetry with the tests_executed branch's own strict
// check; the KMP_EVAL_RESULT schema's exact-key-set rule for no_applicable_tests was needlessly
// brittle against a plausible, substantively-correct LLM hedge; and the Gradle footer's duration
// grammar rejected a real, already-fixture-evidenced elided-unit duration ("1m", no trailing
// seconds). A second, independent test-quality audit of round 5's suite found 3 real coverage
// gaps in the (module x outcome_kind x moduleFilter x modules.length) matrix. All fixed and
// covered below, each verified RED against the pre-round-6 code before being fixed.
describe('gradeScenarioCondition -- round-6: kmp-test --list/--list-only is a second plan-only flag with the same semantics as --dry-run', () => {
  it('a --list-only kmp-test call followed by a real, correct execution -- testInvocationsTotal counts only the REAL execution', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --list-only --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.testInvocationsTotal).toBe(1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a real, CORRECT execution followed by a LATER --list-only call whose result is NOT a real test-execution envelope (e.g. denied/rejected by the policy hook, since --list-only isn\'t in its known-boolean-flags set) -- must not silently become "terminal" and flip a correct result to a failure', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --list-only --json', resultContent: '<tool_use_error>permission denied: --list-only is not an allowed flag</tool_use_error>', resultIsError: true },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('the bare "--list" spelling is recognized too, not just "--list-only"', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --list --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.testInvocationsTotal).toBe(1);
  });
});

describe('gradeScenarioCondition -- round-6: no_applicable_tests target-match now also requires envelope.modules to be genuinely empty', () => {
  it('an envelope with a NON-empty modules[] array -- even one that names the CORRECT target module -- self-contradicts a no_test_modules error and must fail; "the right module happens to be listed" must not stand in for "modules[] is genuinely empty"', () => {
    const selfContradictoryEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 2, duration_ms: 21, tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 },
      modules: [{ name: 'app', type: 'android' }], // non-empty, AND names the target -- still contradicts "no test modules resolved"
      skipped: [], coverage: {},
      errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: app', test_type: '', caused_by_filter: true }],
      warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: selfContradictoryEnvelope }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-6: KMP_EVAL_RESULT no_applicable_tests tolerates an explicit, complete, all-zero hedge (but nothing less precise)', () => {
  it('a block that redundantly includes total:0/passed:0/failed:0 alongside a correct no_applicable_tests claim still passes -- substantively correct, just more verbose than the prompt asked for', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      kmpEvalResultText('The :app module has no applicable tests.', { module: ':app', outcome_kind: 'no_applicable_tests', total: 0, passed: 0, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a PARTIAL hedge (only total:0, missing passed/failed) is rejected -- all-or-nothing, not a half-complete count', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      'Done.\n\nKMP_EVAL_RESULT\n{"module": ":app", "outcome_kind": "no_applicable_tests", "total": 0}\nKMP_EVAL_RESULT_END\n',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a hedge with a NON-zero count (total:5) is rejected -- a genuine internal contradiction, not tolerated', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      kmpEvalResultText('The :app module has no applicable tests.', { module: ':app', outcome_kind: 'no_applicable_tests', total: 5, passed: 5, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-6: Gradle footer duration grammar handles an elided trailing unit', () => {
  it('"BUILD SUCCESSFUL in 1m" (bare minutes, no trailing seconds shown -- a real duration shape Gradle actually prints, already evidenced elsewhere in this repo\'s own test fixtures) must be accepted', () => {
    const elidedSecondsDuration = `> Task :shared:compileAndroidHostTest UP-TO-DATE\n> Task :shared:testAndroidHostTest\n\nBUILD SUCCESSFUL in 1m\n21 actionable tasks: 21 executed\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: elidedSecondsDuration }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-6: dimension-matrix gaps a fresh test-quality audit found in (module x outcome_kind x moduleFilter x modules.length)', () => {
  it('tests_executed, NO --module-filter (whole-project run), envelope.modules has exactly the one target module -- the ordinary, legitimate untargeted-but-correct case still passes', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('tests_executed, envelope.modules is EMPTY (0 entries) -- must fail the same way a 2+-entry array does, not just the multi-module case', () => {
    const emptyModulesEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: emptyModulesEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('no_applicable_tests, terminal attempt\'s --module-filter is present but names a DIFFERENT (non-target, non-null) module -- authoritative_target_matches_expected must fail explicitly, not just the outer verdict', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});
