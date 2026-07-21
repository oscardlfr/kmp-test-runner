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
import { extractKmpTestEnvelope, gradeScenarioCondition, GRADING_CHECK_NAMES, validateParallelEvidence } from '../../tools/agentic-eval/graders.mjs';

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

// `parallel` mirrors the EXACT real shape `lib/orchestrators/parallel-orchestrator.js`'s per-leg
// dispatch loop constructs for a genuine `--module-filter shared` dispatch with NO explicit
// --test-type (every command this constant is paired with, throughout this file, omits
// --test-type entirely) -- a systematic-closure pass reproduced the PRIOR version of this fixture
// as still not production-real: it invented a `task` field (real legs never have one) and used
// `test_type:'androidUnit'` at both levels despite every invoking command being test-type-implicit
// (`opts.testType=''` internally, always rendered as the string `'auto'` at the envelope boundary
// -- confirmed directly in parallel-orchestrator.js's leg-dispatch loop and
// result-rollup.js's buildParallelParsed), and omitted `execution`/`cascade_detected`/
// `retry_fired` (all unconditional real fields) entirely.
// `isolated` mirrors buildIsolatedField's real default shape (lib/orchestrators/
// orchestrator-utils.js) -- a fresh test-fidelity review found this field absent from every
// "production-real" fixture in this file, even though buildParallelParsed sets
// `envelope.isolated` UNCONDITIONALLY (never omitted) on both the success path and every
// early-exit branch, including the no_test_modules exit KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS
// models. Currently inert (the grader never reads `isolated`), so this closes a realism gap in
// these fixtures' own documented claim, not a behavioral one.
const DEFAULT_ISOLATED_FIELD = { enabled: false, cache_dir: null, kept: false, locked: true };

const KMP_TEST_ENVELOPE_SCENARIO1_PASS = JSON.stringify({
  tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
  project_root: 'C:\\fake', exit_code: 0, duration_ms: 13169,
  tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
  modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
  parallel: {
    test_type: 'auto',
    legs: [{
      test_type: 'auto', exit_code: 0,
      execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
      cascade_detected: false, retry_fired: false,
    }],
    max_workers: 4, timeout_s: 900,
  },
  isolated: DEFAULT_ISOLATED_FIELD,
});

const KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS = JSON.stringify({
  tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
  project_root: 'C:\\fake', exit_code: 2, duration_ms: 21,
  tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 },
  modules: [], skipped: [{ module: 'app', reason: 'no test source set' }], coverage: {},
  errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: app', test_type: '', caused_by_filter: true }],
  warnings: [],
  isolated: DEFAULT_ISOLATED_FIELD,
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

// Round 7: a fresh adversarial review found 3 more P1s, all affecting core, publishable metrics
// rather than phrasing -- an unenforced oracle (schema/grader out of sync on which counters are
// actually verifiable), evidence absence masquerading as a valid zero-test result, and missing
// execution/plan coherence between a command and its OWN envelope's self-reported mode. Covered
// here: the graders.mjs-side execution-mode coherence + schema_version checks (the schema-level
// provider-contract and total>=1 fixes live in agentic-eval-schemas.test.js; the JUnit-XML
// absence fix lives in agentic-eval-matrix-runner.test.js).
describe('gradeScenarioCondition -- round-7: envelope execution/plan-mode must agree with a real execution, not just the command text', () => {
  it('command has NO --dry-run in its own text, but the RETURNED envelope claims dry_run:true -- must fail, never trust matching counts over the envelope\'s own self-reported mode', () => {
    const staleDryRunEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, dry_run: true,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: staleDryRunEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('command has NO --list-only in its own text, but the RETURNED envelope claims parallel.list_only:true -- must fail the same way', () => {
    const staleListOnlyEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, parallel: { test_type: 'auto', list_only: true, legs: [] },
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: staleListOnlyEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('regression guard: a real envelope with neither dry_run nor parallel.list_only set (the ordinary case, matching every existing fixture in this file) still passes normally', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

// Round 8: a fresh review reproduced the round-7 execution-mode coherence check failing OPEN on a
// wrong-typed value -- `envelope.dry_run === true` only rejects the LITERAL boolean `true`;
// `dry_run:"true"` (string) or `dry_run:1` (number) still semantically claim plan-only mode but
// were not `=== true`, so the old check silently accepted them. Fixed as a fail-closed allowlist:
// the ONLY acceptable states are "field absent" or "field explicitly false".
describe('gradeScenarioCondition -- round-8: execution-mode coherence must fail closed on a wrong-typed value, not just literal true', () => {
  it('EXACT REPRODUCTION: envelope.dry_run is the STRING "true" (not the boolean) -- previously accepted, must now be rejected', () => {
    const wrongTypeDryRunEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, dry_run: 'true',
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: wrongTypeDryRunEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: envelope.dry_run is the NUMBER 1 (not the boolean) -- previously accepted, must now be rejected', () => {
    const numericDryRunEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, dry_run: 1,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: numericDryRunEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: envelope.parallel.list_only is the STRING "true" (not the boolean) -- previously accepted, must now be rejected', () => {
    const wrongTypeListOnlyEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, parallel: { test_type: 'auto', list_only: 'true', legs: [] },
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: wrongTypeListOnlyEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('regression guard: envelope.dry_run explicitly false (a real, well-typed value) still passes normally', () => {
    const explicitFalseDryRunEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, dry_run: false,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 4, timeout_s: 900,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: explicitFalseDryRunEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

// Round 9: a fresh review reproduced a malformed/absent `parallel` structure getting FULL CREDIT
// for a tests_executed scenario. KMP_TEST_ENVELOPE_REQUIRED_SHAPE never required `parallel` at
// all, and the round-7/8 dry_run/list_only coherence check uses optional chaining
// (`envelope.parallel?.list_only`), which silently evaluates to `undefined` -- treated as "absent,
// OK" -- for ANY non-nullish `parallel` value that isn't a plain object with a `list_only`
// property, not just a genuinely-absent one.
describe('gradeScenarioCondition -- round-9: tests_executed requires a real, well-formed parallel.legs[] block, not just absence of a bad list_only', () => {
  function envelopeWithParallel(parallelValue) {
    return JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, parallel: parallelValue,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
  }

  function envelopeWithParallelOmitted() {
    const full = JSON.parse(envelopeWithParallel({}));
    delete full.parallel;
    return JSON.stringify(full);
  }

  const malformedCases = [
    ['absent entirely', envelopeWithParallelOmitted()],
    ['the NUMBER 1', envelopeWithParallel(1)],
    ['the STRING "list_only"', envelopeWithParallel('list_only')],
    ['an EMPTY ARRAY', envelopeWithParallel([])],
    ['an EMPTY OBJECT (no legs at all)', envelopeWithParallel({})],
    ['the BOOLEAN false', envelopeWithParallel(false)],
  ];

  it('EXACT REPRODUCTION: parallel absent entirely -- previously accepted, must now be rejected', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: malformedCases[0][1] }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: parallel is the NUMBER 1 -- previously accepted, must now be rejected', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: malformedCases[1][1] }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: parallel is the STRING "list_only" -- previously accepted, must now be rejected', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: malformedCases[2][1] }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: parallel is an EMPTY ARRAY -- previously accepted, must now be rejected', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: malformedCases[3][1] }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: parallel is an EMPTY OBJECT (structurally present, but no legs at all) -- previously accepted, must now be rejected', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: malformedCases[4][1] }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: parallel is the BOOLEAN false -- previously accepted, must now be rejected', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: malformedCases[5][1] }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('parallel legitimately absent under no_applicable_tests -- the no_test_modules early-exit never constructs a parallel block, must still pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('regression guard: a real, well-formed parallel.legs[] block (the ordinary case) still passes normally', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

// Round 10: after 9 patch-by-patch review rounds against `parallel`-evidence validation, a
// systematic-closure pass replaced the narrow "non-empty legs array" check with
// `validateParallelEvidence()` -- a single named validator implementing the COMPLETE production
// contract extracted directly from lib/orchestrators/parallel-orchestrator.js (leg dispatch loop,
// legsForAll) and lib/orchestrators/parallel/result-rollup.js (buildParallelParsed,
// recordLegResults's execSummary.failed/errors invariant). This table-driven matrix mutates
// EXACTLY ONE invariant at a time away from a known-good baseline envelope, proving each is
// independently enforced -- not just the specific reproductions a prior review round happened to
// try. Every case here was proven RED (wrongly accepted) against the pre-fix commit before this
// fix was implemented.
describe('gradeScenarioCondition -- round-10: validateParallelEvidence closes the complete malformed/contradictory leg class', () => {
  const GOOD_LEG = {
    test_type: 'auto', exit_code: 0,
    execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
    cascade_detected: false, retry_fired: false,
  };
  const GOOD_PARALLEL = { test_type: 'auto', legs: [GOOD_LEG], max_workers: 4, timeout_s: 900 };
  const DEFAULT_COMMAND = 'kmp-test parallel --module-filter shared --json';

  function buildEnvelope({ parallel = GOOD_PARALLEL, tests = { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 }, errors = [] } = {}) {
    return JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests,
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors, warnings: [],
      parallel,
    });
  }

  function gradeCommand(command, envelopeJson, scenario = SCENARIO_1) {
    const cr = buildConditionResult([{ command, resultContent: envelopeJson }], SCENARIO_1_CORRECT_ANSWER);
    return gradeScenarioCondition(cr, scenario);
  }

  // [name, command, envelopeJson] -- every entry must be rejected (expectedOutcomeMatched:false).
  const ADVERSARIAL_MATRIX = [
    ['null leg', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [null] } })],
    ['primitive-number leg', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [1] } })],
    ['empty-object leg (structurally present, no fields at all)', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{}] } })],
    ['legs is an empty ARRAY (distinct from parallel itself being {})', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [] } })],
    ['leg missing the required execution object entirely', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ test_type: 'auto', exit_code: 0, cascade_detected: false, retry_fired: false }] } })],
    ['leg.exit_code is the STRING "0", not an integer', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, exit_code: '0' }] } })],
    ['leg.cascade_detected is the STRING "false", not a boolean', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, cascade_detected: 'false' }] } })],
    ['leg.retry_fired is the NUMBER 0, not a boolean', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, retry_fired: 0 }] } })],
    ['leg.execution is missing a required key (no_evidence)', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0 } }] } })],
    // EXACT REPRODUCTION (round-2 test-fidelity review): the converse of the missing-key row
    // above -- isWellFormedParallelLeg's own doc comment claims "EXACTLY the 7 EXECUTION_MODE_KEYS"
    // but the code previously only validated the 7 known keys, never rejecting an EXTRA,
    // unrecognized one (impossible from real production, which always constructs exactly these 7
    // via summarizeExecutionModes).
    ['leg.execution has an EXTRA, unrecognized key beyond the 7 real ones', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, execution: { ...GOOD_LEG.execution, injected_bogus_field: 'x' } }] } })],
    // NOTE: an out-of-range/non-integer execution.failed also always trips the SEPARATE aggregate
    // check (legsFailedSum vs. envelope.tests.failed) and/or the scenario-comparison layer's own
    // envelope.tests.failed===kt.tests.failed check OUTSIDE validateParallelEvidence entirely --
    // through this end-to-end pipeline there is no envelope.tests.failed value that satisfies both
    // "matches kt.tests.failed" AND "matches a mutated leg execution.failed" simultaneously, so a
    // row here could never isolate the per-key type/range guard from those other checks. A fresh
    // test-fidelity review confirmed (via mutation testing) that attempting to align tests.failed
    // to bypass the aggregate check still fails via the outer kt.tests.failed comparison, making
    // any such row here non-discriminating regardless of framing. That specific invariant is
    // instead covered by direct, isolated unit tests against validateParallelEvidence itself, see
    // the 'validateParallelEvidence -- direct unit tests' describe block below.
    ['EXACT REPRODUCTION: a failed leg contradicts a clean top-level tests.failed:0', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, exit_code: 1, execution: { ...GOOD_LEG.execution, fresh: 0, failed: 1 } }] } })],
    // EXACT REPRODUCTION (Docker/local-ci audit, round 11): leg.exit_code is an arbitrary non-zero
    // value (99) while execution.failed stays 0 -- nothing previously checked whether a leg's own
    // exit status agrees with its own failed-task count. Deliberately NOT testing "is 99 outside
    // some enumerated domain" (a raw gradle process exit code can legitimately be any integer) --
    // only that it's incoherent with a leg claiming zero failures.
    ['EXACT REPRODUCTION: leg.exit_code is non-zero (99) while execution.failed stays 0 (exit-code/failed-count incoherence)', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, exit_code: 99 }] } })],
    // EXACT REPRODUCTION (Docker/local-ci audit, round 11): a single execution bucket (fresh:999)
    // vastly exceeds the envelope's own top-level tests.total:1 -- nothing previously checked that
    // the SUM of every leg's own execution buckets accounts for the envelope's own task count.
    ['EXACT REPRODUCTION: execution.fresh:999 while envelope.tests.total stays 1 (impossible bucket cardinality)', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, execution: { ...GOOD_LEG.execution, fresh: 999 } }] } })],
    ['EXACT REPRODUCTION: wrong leg test_type (leg says androidUnit, top-level and command both say implicit auto)', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [{ ...GOOD_LEG, test_type: 'androidUnit' }] } })],
    ['impossible: top-level test_type "all" with only 1 leg (legsForAll always produces >= 3)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }], max_workers: 4, timeout_s: 900 } })],
    ['impossible: top-level test_type "auto" with 2 legs (a non-all dispatch always has exactly 1 leg)', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [GOOD_LEG, { ...GOOD_LEG }] } })],
    ['impossible: a leg itself claims test_type "all" (legsForAll never dispatches a literal "all" leg)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'all' }, { ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }] } })],
    ['malformed multi-leg: two good concrete legs plus one null leg under test_type "all"', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }, null] } })],
    ['EXACT REPRODUCTION: explicit command/envelope --test-type mismatch (command says androidUnit, envelope says jvm)', DEFAULT_COMMAND.replace('--json', '--test-type androidUnit --json'), buildEnvelope({ parallel: { test_type: 'jvm', legs: [{ ...GOOD_LEG, test_type: 'jvm' }], max_workers: 4, timeout_s: 900 } })],
    ['command omits --test-type (implicit auto) but envelope claims a specific type', DEFAULT_COMMAND, buildEnvelope({ parallel: { test_type: 'androidUnit', legs: [{ ...GOOD_LEG, test_type: 'androidUnit' }], max_workers: 4, timeout_s: 900 } })],
    // EXACT REPRODUCTION (independent contract review): a duplicated leg type standing in for a
    // MISSING one -- legsForAll (lib/orchestrators/parallel/dispatch.js) can never produce a
    // repeated leg type in any environment, so membership-per-leg alone (without a distinctness
    // check) previously accepted this as valid "all" evidence.
    ['EXACT REPRODUCTION: "all" dispatch with a DUPLICATE leg type standing in for a missing one (common repeated, androidUnit never dispatched)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }], max_workers: 4, timeout_s: 900 } })],
    // EXACT REPRODUCTION (round-2 contract review): distinctness alone doesn't validate the
    // surviving SET is one legsForAll can actually produce -- legsForAll always includes
    // common/desktop/androidUnit unconditionally; a distinct, all-valid-membership set missing
    // all three (standing in with OTHER valid-but-conditional types instead) is still impossible.
    ['EXACT REPRODUCTION: "all" dispatch missing all 3 unconditional leg types (androidInstrumented/ios/macos only -- common/desktop/androidUnit never dispatched)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'androidInstrumented' }, { ...GOOD_LEG, test_type: 'ios' }, { ...GOOD_LEG, test_type: 'macos' }], max_workers: 4, timeout_s: 900 } })],
    // EXACT REPRODUCTION (round-2 contract review): ios/macos are only ever added TOGETHER as a
    // pair (macOS host only) -- never one without the other. A set with exactly one of the two is
    // impossible regardless of platform/env-var state.
    ['EXACT REPRODUCTION: "all" dispatch with ios present but macos absent (legsForAll only ever adds them as a pair)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }, { ...GOOD_LEG, test_type: 'androidUnit' }, { ...GOOD_LEG, test_type: 'ios' }], max_workers: 4, timeout_s: 900 } })],
  ];

  it.each(ADVERSARIAL_MATRIX)('rejects: %s', (_name, command, envelopeJson) => {
    const grade = gradeCommand(command, envelopeJson);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('regression guard: production-real implicit auto (no --test-type in the command) still passes', () => {
    const grade = gradeCommand(DEFAULT_COMMAND, buildEnvelope());
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('regression guard: production-real explicit single test-type (command and envelope both say androidUnit) still passes', () => {
    const envelope = buildEnvelope({ parallel: { test_type: 'androidUnit', legs: [{ ...GOOD_LEG, test_type: 'androidUnit' }], max_workers: 4, timeout_s: 900 } });
    const grade = gradeCommand(DEFAULT_COMMAND.replace('--json', '--test-type androidUnit --json'), envelope);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  // The global bucket-cardinality invariant (validateParallelEvidence: sum of every leg's own
  // execution buckets across the WHOLE parallel.legs[] array must equal envelope.tests.total)
  // means a multi-leg envelope's tests.total must scale with the leg count -- each GOOD_LEG
  // contributes exactly 1 dispatched task to its own bucket sum. SCENARIO_1's real kmp_test
  // contract expects exactly 1 (the real KaMPKit scenario is a single-task dispatch), so these
  // multi-leg structural tests need their OWN scenario-level expectation, not SCENARIO_1 verbatim.
  function scenario1WithTaskCount(taskCount) {
    return {
      ...SCENARIO_1,
      expected: {
        ...SCENARIO_1.expected,
        kmp_test: { ...SCENARIO_1.expected.kmp_test, tests: { ...SCENARIO_1.expected.kmp_test.tests, total: taskCount, passed: taskCount } },
      },
    };
  }

  it('regression guard: production-real multi-leg "all" dispatch (3 concrete legs, none literally "all") still passes', () => {
    // Hand-authored to the exact contract extracted from legsForAll (lib/orchestrators/parallel/
    // dispatch.js): 'common'/'desktop'/'androidUnit' are the 3 unconditional legs it always
    // produces; each leg's own test_type is a concrete value, never 'all', while the top-level
    // parallel.test_type is 'all'. (The dedicated production-real integration test in
    // agentic-eval-graders-production-contract.test.js covers the single-leg case via a genuine
    // runParallel() call; replicating a real multi-leg all dispatch would require a synthetic
    // project with android+ios+macos+jvm source sets and platform stubbing, out of scope for this
    // structural unit test.)
    const legs = ['common', 'desktop', 'androidUnit'].map((t) => ({ ...GOOD_LEG, test_type: t }));
    const envelope = buildEnvelope({ tests: { total: 3, passed: 3, failed: 0, skipped: 0, individual_total: 24 }, parallel: { test_type: 'all', legs, max_workers: 4, timeout_s: 900 } });
    const grade = gradeCommand(DEFAULT_COMMAND.replace('--json', '--test-type all --json'), envelope, scenario1WithTaskCount(3));
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('regression guard: production-real 6-leg "all" dispatch on a macOS host with ADB (all 3 conditional legs present: androidInstrumented + ios + macos) still passes', () => {
    // The full legsForAll output when nothing is skipped: the 3 unconditional legs plus
    // androidInstrumented (skipAdb=false) plus BOTH ios and macos together (macOS host).
    const legs = ['common', 'desktop', 'androidUnit', 'androidInstrumented', 'ios', 'macos'].map((t) => ({ ...GOOD_LEG, test_type: t }));
    const envelope = buildEnvelope({ tests: { total: 6, passed: 6, failed: 0, skipped: 0, individual_total: 24 }, parallel: { test_type: 'all', legs, max_workers: 4, timeout_s: 900 } });
    const grade = gradeCommand(DEFAULT_COMMAND.replace('--json', '--test-type all --json'), envelope, scenario1WithTaskCount(6));
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('regression guard: legitimate no_applicable_tests (parallel absent entirely) is unaffected by any of the above', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  // EXACT REPRODUCTION (round-2 measurement-integrity review): the identical class of gap this
  // round closed for tests_executed existed in the SIBLING no_applicable_tests branch too --
  // nothing checked envelope.parallel at all there, so a fabricated envelope carrying a genuinely
  // matching no_test_modules error PLUS an arbitrarily malformed parallel block still graded
  // success:true. Directly affects kampkit-no-applicable-tests.json, one of this PR's two real
  // shipped scenarios.
  it('EXACT REPRODUCTION: a genuinely matching no_test_modules envelope with a malformed parallel block ({legs:[null]}) tacked on is rejected, not silently accepted', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS);
    envelope.parallel = { test_type: 'auto', legs: [null], max_workers: 4, timeout_s: 900 };
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('EXACT REPRODUCTION: a genuinely matching no_test_modules envelope with an otherwise WELL-FORMED parallel block tacked on is still rejected -- real production never sets parallel on this early-exit at all, so ANY presence is impossible evidence', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS);
    envelope.parallel = {
      test_type: 'auto',
      legs: [{
        test_type: 'auto', exit_code: 0,
        execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
        cascade_detected: false, retry_fired: false,
      }],
      max_workers: 4, timeout_s: 900,
    };
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

// Round 10 (continued): a fresh test-fidelity review found that two of the round-10 matrix's
// rows (out-of-range/non-integer leg.execution.failed) could never isolate
// isWellFormedParallelLeg's own per-key type/range guard from the SEPARATE aggregate check
// (legsFailedSum vs. envelope.tests.failed) AND the scenario-comparison layer's own
// envelope.tests.failed===kt.tests.failed check -- through the full end-to-end pipeline, no
// envelope.tests.failed value can simultaneously match kt.tests.failed AND a mutated leg
// execution.failed, so those checks always fire first regardless of what the per-key guard does.
// Calling validateParallelEvidence directly removes every check that lives OUTSIDE it, genuinely
// isolating its own internal invariants -- confirmed by the SAME mutation-testing technique used
// throughout this session (temporarily weaken the specific guard, confirm ONLY the intended
// case(s) flip, restore).
describe('validateParallelEvidence -- direct unit tests (isolates leg/aggregate invariants from the scenario-comparison layer)', () => {
  const GOOD_LEG = {
    test_type: 'auto', exit_code: 0,
    execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
    cascade_detected: false, retry_fired: false,
  };

  // `total: 1` matches every GOOD_LEG-based fixture's own bucket-cardinality convention (a single
  // clean task) -- required so the new global cardinality invariant (sum of every leg's execution
  // buckets must equal envelope.tests.total) doesn't spuriously reject these cases for a reason
  // unrelated to what each one is actually isolating.
  function envelopeWithTestsFailed(testsFailed, legOverride) {
    return {
      tests: { failed: testsFailed, total: 1 },
      parallel: { test_type: 'auto', legs: [{ ...GOOD_LEG, ...legOverride }], max_workers: 4, timeout_s: 900 },
    };
  }

  it('EXACT REPRODUCTION: leg.execution.failed is negative (-1), with envelope.tests.failed ALIGNED to -1 so only the per-key guard can be responsible', () => {
    const envelope = envelopeWithTestsFailed(-1, { execution: { ...GOOD_LEG.execution, failed: -1 } });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('EXACT REPRODUCTION: leg.execution.failed is a non-integer (1.5), with envelope.tests.failed ALIGNED to 1.5 so only the per-key guard can be responsible', () => {
    const envelope = envelopeWithTestsFailed(1.5, { execution: { ...GOOD_LEG.execution, failed: 1.5 } });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('EXACT REPRODUCTION (missing coverage, reverse direction): envelope.tests.failed is INFLATED above what the legs actually report (legs clean, top-level fabricated)', () => {
    // The round-10 matrix only ever covered leg-says-failed/envelope-says-clean. A fresh
    // test-fidelity review confirmed the converse -- a clean, well-formed leg (execution.failed:0)
    // paired with a fabricated non-zero envelope.tests.failed -- had zero coverage anywhere.
    const envelope = envelopeWithTestsFailed(1, { execution: { ...GOOD_LEG.execution, failed: 0 } });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('regression guard: a well-formed leg whose execution.failed genuinely matches envelope.tests.failed still validates', () => {
    const envelope = envelopeWithTestsFailed(0, {});
    expect(validateParallelEvidence(envelope, null)).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-10: malformed parallel evidence is a HARNESS-INTEGRITY signal, not a plain negative result', () => {
  const GOOD_LEG = {
    test_type: 'auto', exit_code: 0,
    execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
    cascade_detected: false, retry_fired: false,
  };

  it('EXACT REPRODUCTION: a well-shaped outer envelope with an incoherent parallel.legs[] (missing no_evidence key) sets parallelEvidenceMalformed:true, not just expectedOutcomeMatched:false', () => {
    const envelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{ test_type: 'auto', exit_code: 0, cascade_detected: false, retry_fired: false, execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0 } }],
        max_workers: 4, timeout_s: 900,
      },
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: envelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // Check 4 (authoritative_evidence_well_formed) must ALSO reflect this -- previously it only
    // inspected the top-level parse (`malformed`), reading a self-contradictory parallel block as
    // "well-formed evidence that simply didn't match."
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.parallelEvidenceMalformed).toBe(true);
  });

  it('regression guard: a genuine count-mismatch (well-formed parallel evidence, but wrong test counts) is NOT flagged as parallelEvidenceMalformed -- still a plain, legitimate negative result', () => {
    const envelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 20 }, // wrong count (expected 24), otherwise clean
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: { test_type: 'auto', legs: [GOOD_LEG], max_workers: 4, timeout_s: 900 },
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: envelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.parallelEvidenceMalformed).toBe(false);
  });

  it('regression guard: a genuinely well-formed, matching envelope has parallelEvidenceMalformed:false', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.parallelEvidenceMalformed).toBe(false);
  });
});

// Round 11 (Docker/local-ci audit): matrix-runner.mjs's captureGradleJunitEvidence now returns
// {harnessIntegrityIssue:true, reason} instead of a miscounted {total,passed,failed} when the real
// JUnit XML contains a genuine <skipped> testcase or could not be fully read. gradeScenarioCondition
// must surface this as its own top-level harness-integrity signal (gradleJunitEvidenceUnreliable),
// mirroring parallelEvidenceMalformed above -- never silently folded into a plain
// expectedOutcomeMatched:false, which cli.mjs's scenarioCellIntegrityOk could not distinguish from
// an ordinary wrong-answer negative result.
describe('gradeScenarioCondition -- round-11: unreliable Gradle JUnit evidence (skip/anomaly) is a HARNESS-INTEGRITY signal, not a plain negative result', () => {
  it('EXACT REPRODUCTION: gradleJunitEvidence carries a skipped-testcase harness-integrity issue -- sets gradleJunitEvidenceUnreliable:true, and the outcome check still fails closed (never a false pass from the stale total/passed shape)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { harnessIntegrityIssue: true, reason: 'skipped_testcase_unsupported' } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(true);
  });

  it('EXACT REPRODUCTION (read-anomaly variant): gradleJunitEvidence carries an oversized/unreadable-XML issue -- also sets gradleJunitEvidenceUnreliable:true', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { harnessIntegrityIssue: true, reason: 'junit_xml_read_anomaly' } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(true);
  });

  it('regression guard: gradleJunitEvidence:null (never captured at all, the pre-existing "no evidence" case) does NOT trip gradleJunitEvidenceUnreliable -- that is a distinct, already-covered failure mode', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: null },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(false);
  });

  it('regression guard: a genuinely clean gradleJunitEvidence snapshot has gradleJunitEvidenceUnreliable:false', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { total: 24, passed: 24, failed: 0 } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(false);
  });

  it('a kmp-test-only condition (no Gradle attempt at all) never trips gradleJunitEvidenceUnreliable, regardless of what conditionResult.gradleJunitEvidence happens to hold', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
      { gradleJunitEvidence: { harnessIntegrityIssue: true, reason: 'skipped_testcase_unsupported' } },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // The kmp-test path derives its own outcome from individual_total, never from
    // conditionResult.gradleJunitEvidence -- but the flag itself is computed unconditionally from
    // the raw signal, so a stray/unrelated harness-integrity issue on the Gradle side still surfaces
    // here even though this condition never actually depended on it for its own outcome. This is
    // intentional: matrix-runner.mjs only computes gradleJunitEvidence at all for tests_executed
    // scenarios with a declared evidence_task, so a non-null value here is never spurious noise from
    // an unrelated scenario shape.
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(true);
  });
});

describe('gradeScenarioCondition -- round-7: envelope schema_version must match the CURRENT envelope schema exactly', () => {
  it('an envelope claiming a DIFFERENT schema_version (e.g. a stale/older value) is not trusted as a kmp-test envelope at all -- extraction fails, the attempt is malformed', () => {
    const wrongSchemaVersionEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 1, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 },
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors: [], warnings: [],
    });
    expect(extractKmpTestEnvelope(wrongSchemaVersionEnvelope)).toBeNull();
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: wrongSchemaVersionEnvelope }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});
