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
import { buildRunRecord } from '../../tools/agentic-eval/cli.mjs';
import { computePolicySha256 } from '../../tools/agentic-eval/policy-config.mjs';

// The three scenario shapes shipped in corpus/scenarios/*.json, kept here as plain objects so
// grader tests don't depend on file I/O -- manually mirrored against the committed files, not
// automatically drift-checked (agentic-eval-corpus.test.js independently asserts the real,
// committed files' id/module/outcome_kind/tags/counts directly, which is the actual drift
// protection this repo relies on for those fields).
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

// The 3rd scenario shape (nowinandroid-core-common) -- see the SCENARIO_1 comment above for the
// manual-mirror/drift-protection note. `prompt`/`expected_outcome` are abbreviated with "..."
// here the same way SCENARIO_1/SCENARIO_2 are above, since grading never reads those fields.
const SCENARIO_3 = {
  schema: 1,
  id: 'nowinandroid-core-common',
  family: 'test-only',
  project_alias: 'nowinandroid',
  project_url: 'https://github.com/android/nowinandroid',
  project_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
  prompt: "This is a large, multi-module Android project. Somewhere in it there's a small shared module that holds common Result-handling utility code used across the other modules. Can you find that module, run its tests, and tell me what happened? Once you know the result, end your reply with a block in exactly this format...",
  expected_outcome: "The agent discovers and runs the shared Result-handling module's unit tests and reports the accurate pass/fail count.",
  policy: {
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    allowed_gradle_tasks: [':core:common:tasks', ':core:common:test'],
  },
  expected: {
    module: ':core:common',
    outcome_kind: 'tests_executed',
    kmp_test: { tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 }, exit_code: 0 },
    gradle: { allowed_invocations: [':core:common:test'], evidence_task: ':core:common:test', tests: { total: 1, passed: 1, failed: 0 }, exit_code: 0 },
  },
  first_useful_signal_predicate: { description: 'first well-formed evidence confirming :core:common 1/1' },
  tags: ['held-out'],
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

/** Builds a full conditionResult from a list of steps plus a final answer string -- computes
 * bashResults the same shape findBashToolUsesWithResults() produces (index/resultIndex/
 * resultContent), by hand, so these tests don't need parseStreamJsonl in the loop.
 *
 * Each step is `{command, resultContent, resultIsError, decision, evidence}`: `decision` is this
 * attempt's own resolved policy decision (default `'allow'` -- most tests here exercise grading
 * logic, not the decision-recording mechanism itself, which has its own dedicated
 * agentic-eval-junit-evidence.test.js; pass `'deny'` or `null` explicitly to exercise those
 * specific paths). `evidence` is this attempt's own resolved JUnit-evidence status (only
 * meaningful for a Gradle-classified step) -- `{status:'ok', junit:{total,passed,failed}}` |
 * `{status:'no_xml'}` | `{status:'integrity_error', reason}` | `{status:'conflict'}` | omitted
 * entirely (no evidence record at all). This directly encodes junit-evidence.mjs's
 * attributeCondition() OUTPUT shape (perAttemptJunit/decisionByAttempt, keyed by each step's own
 * `id` -- a real, adversarial-review-confirmed fix: an earlier revision keyed these by `bashIndex`,
 * which collapsed two same-turn attempts sharing one index into a single map slot) rather than the
 * INPUT steps that would produce it -- attributeCondition's own correlation logic (concurrency
 * detection, timeout tolerance, sidecar-record reading) has its own dedicated test file and is
 * never re-derived here, avoiding any risk of the two diverging.
 *
 * The three whole-condition flags (`ambiguousJunitEvidence`/`captureIncomplete`/`unreliable`) are
 * accepted as explicit top-level options for the same reason -- a test that wants to verify
 * gradeScenarioCondition's OWN consumption of a proven conflict (say) sets it directly, rather
 * than trying to construct a same-assistant-turn transcript shape that would make
 * attributeCondition derive it independently. */
function buildConditionResult(steps, finalAnswerText, {
  terminated = false, terminationReason = null, dropFinalResultEvent = false,
  ambiguousJunitEvidence = false, captureIncomplete = false, unreliable = false,
} = {}) {
  const events = [initEventStub()];
  const bashResults = [];
  const decisionByAttempt = new Map();
  const perAttemptJunit = new Map();
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
    decisionByAttempt.set(id, step.decision === undefined ? 'allow' : step.decision);
    if (step.evidence !== undefined) perAttemptJunit.set(id, step.evidence);
  }
  if (!dropFinalResultEvent) events.push(resultEventStub(finalAnswerText));
  return {
    events, bashResults, result: dropFinalResultEvent ? null : { result: finalAnswerText },
    spawnResult: { terminated, terminationReason },
    junitAttribution: { perAttemptJunit, decisionByAttempt, ambiguousJunitEvidence, captureIncomplete, unreliable },
  };
}

/** Shorthand for the common case: a Gradle step whose evidence should read as a clean, matching
 * `tests_executed` pass -- `{status:'ok', junit:{total,passed,failed}}`. */
function okJunit(total, passed, failed) {
  return { status: 'ok', junit: { total, passed, failed } };
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
const SCENARIO_3_CORRECT_ANSWER = kmpEvalResultText(
  '1/1 tests passed in the :core:common module via test.',
  { module: ':core:common', outcome_kind: 'tests_executed', total: 1, passed: 1, failed: 0 },
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
// models. A Docker/local-ci audit closed the behavioral half of this gap too:
// validateParallelEvidence now validates BOTH `isolated` and `parallel.max_workers`/`timeout_s`
// against these exact policy-coherent values (see graders.mjs's EXPECTED_ISOLATED_FIELD/
// EXPECTED_MAX_WORKERS/EXPECTED_TIMEOUT_S) -- every fixture in this file that previously used
// max_workers:4/timeout_s:900 (plausible-looking placeholders, never checked against the real
// flag-less defaults) was updated to the real ones (0/600) for the same reason.
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
    max_workers: 0, timeout_s: 600,
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

// `:core:common` is a plain `jvm` module (no Android lifecycle-alias ambiguity, unlike scenario
// 2's `:app`) -- one leg, `fresh:1`, mirroring KMP_TEST_ENVELOPE_SCENARIO1_PASS's shape with
// counts/module substituted for the ground-truth-verified 1/1/0 result.
const KMP_TEST_ENVELOPE_SCENARIO3_PASS = JSON.stringify({
  tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
  project_root: 'C:\\fake', exit_code: 0, duration_ms: 5231,
  tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 },
  modules: [{ name: 'core:common', type: 'jvm' }], skipped: [], coverage: {}, errors: [], warnings: [],
  parallel: {
    test_type: 'auto',
    legs: [{
      test_type: 'auto', exit_code: 0,
      execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
      cascade_detected: false, retry_fired: false,
    }],
    max_workers: 0, timeout_s: 600,
  },
  isolated: DEFAULT_ISOLATED_FIELD,
});

const GRADLE_SCENARIO3_PASS_STDOUT = `> Task :core:common:compileTestKotlin\n> Task :core:common:test\n\nBUILD SUCCESSFUL in 3s\n5 actionable tasks: 5 executed\n`;

// The 4th scenario shape (deterministic-unit-test-failure) -- the first `tests_failed` scenario.
// Ground truth independently verified 6x (3x kmp-test, 3x direct Gradle, cold GRADLE_USER_HOME
// each) against android/nowinandroid @ 058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8's `:lint` module
// (a plain java-library+kotlin-jvm module, no Android flavors/Robolectric): 3 tests in
// TestMethodDetectorTest deterministically fail because the test's hardcoded expected lint-issue-ID
// literals (e.g. `TestMethodWithTestPrefix`) are stale against the real, already-renamed detector
// output (`TestMethodPrefix`) -- see that scenario file's own provenance comment.
const SCENARIO_4 = {
  schema: 1,
  id: 'deterministic-unit-test-failure',
  family: 'test-only',
  project_alias: 'nowinandroid',
  project_url: 'https://github.com/android/nowinandroid',
  project_commit: '058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8',
  prompt: "This is a large, multi-module Android project. Somewhere in it there's a small module containing custom Android Lint check implementations, with its own unit tests. Can you find that module, run its tests, and tell me what happened? Once you know the result, end your reply with a block in exactly this format...",
  expected_outcome: "The agent discovers and runs the custom lint-check module's unit tests and reports that all 3 tests fail.",
  policy: {
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    allowed_gradle_tasks: [':lint:tasks', ':lint:test'],
  },
  expected: {
    module: ':lint',
    outcome_kind: 'tests_failed',
    kmp_test: { tests: { total: 1, passed: 0, failed: 1, skipped: 0, individual_total: 3 }, exit_code: 1 },
    gradle: { allowed_invocations: [':lint:test'], evidence_task: ':lint:test', tests: { total: 3, passed: 0, failed: 3 }, exit_code: 1 },
  },
  first_useful_signal_predicate: { description: 'first well-formed evidence confirming :lint 3 tests failed' },
  tags: ['held-out'],
};

const SCENARIO_4_CORRECT_ANSWER = kmpEvalResultText(
  '3 tests ran in the :lint module; all 3 failed.',
  { module: ':lint', outcome_kind: 'tests_failed', total: 3, passed: 0, failed: 3 },
);

// A genuine module-task failure surfaces exactly one real `module_failed` error entry (ground-truth
// confirmed directly against a real kmp-test capture -- parallel-orchestrator.js's own
// error-reporting convention for a failed module task) -- REQUIRED for tests_failed, the mirror of
// tests_executed's own `errors.length === 0` requirement. The failed leg's own `execution.failed:1`
// (not `fresh`) and `exit_code:1` mirror validateParallelEvidence's per-leg exit/failed coherence
// invariant exactly as a real failed dispatch produces it.
// modules[0].test_failures mirrors the REAL captured envelope byte-for-byte (see this scenario's
// own ground-truth provenance) -- 3 real per-test entries, never omitted: a review pass found the
// original version of this fixture dropped this field entirely, which meant
// validateKmpEnvelopeForAttempt's tests_failed branch never had a genuine reason to check it either
// (an untested field silently rots). See KMP_TEST_ENVELOPE_SCENARIO4_TEST_FAILURES's own reuse
// below in the dedicated false-positive tests.
const KMP_TEST_ENVELOPE_SCENARIO4_TEST_FAILURES = [
  { test: 'com.google.samples.apps.nowinandroid.lint.TestMethodDetectorTest.detect format', cause: 'java.lang.StackOverflowError', type: 'java.lang.StackOverflowError' },
  { test: 'com.google.samples.apps.nowinandroid.lint.TestMethodDetectorTest.detect prefix', cause: 'java.lang.StackOverflowError', type: 'java.lang.StackOverflowError' },
  { test: 'com.google.samples.apps.nowinandroid.lint.TestMethodDetectorTest.detect underscores', cause: 'java.lang.StackOverflowError', type: 'java.lang.StackOverflowError' },
];

const KMP_TEST_ENVELOPE_SCENARIO4_FAIL = JSON.stringify({
  tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
  project_root: 'C:\\fake', exit_code: 1, duration_ms: 128033,
  tests: { total: 1, passed: 0, failed: 1, skipped: 0, individual_total: 3 },
  modules: [{ name: 'lint', type: 'jvm', test_failures: KMP_TEST_ENVELOPE_SCENARIO4_TEST_FAILURES }], skipped: [], coverage: {},
  errors: [{ code: 'module_failed', module: 'lint', task: ':lint:test', message: '[FAIL] lint' }],
  warnings: [],
  parallel: {
    test_type: 'auto',
    legs: [{
      test_type: 'auto', exit_code: 1,
      execution: { fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 1, no_evidence: 0 },
      cascade_detected: false, retry_fired: false,
    }],
    max_workers: 0, timeout_s: 600,
  },
  isolated: DEFAULT_ISOLATED_FIELD,
});

// Real stdout shape (condensed from an actual captured `:lint:test` ground-truth run -- see
// deterministic-unit-test-failure.json's provenance): 3 ComparisonFailure JUnit failures, a
// `> Task :lint:test FAILED` status line, and a genuine `BUILD FAILED` footer.
const GRADLE_SCENARIO4_FAIL_STDOUT = `> Task :lint:compileKotlin\n> Task :lint:compileTestKotlin\n> Task :lint:testClasses UP-TO-DATE\n\n> Task :lint:test\n\ncom.google.samples.apps.nowinandroid.lint.TestMethodDetectorTest > detect format FAILED\n    org.junit.ComparisonFailure at TestMethodDetectorTest.kt:93\n\ncom.google.samples.apps.nowinandroid.lint.TestMethodDetectorTest > detect prefix FAILED\n    org.junit.ComparisonFailure at TestMethodDetectorTest.kt:49\n\ncom.google.samples.apps.nowinandroid.lint.TestMethodDetectorTest > detect underscores FAILED\n    org.junit.ComparisonFailure at TestMethodDetectorTest.kt:123\n\n3 tests completed, 3 failed\n\n> Task :lint:test FAILED\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':lint:test'.\n> There were failing tests. See the report at: file:///fake/lint/build/reports/tests/test/index.html\n\n* Try:\n> Run with --scan to get full insights.\n\nBUILD FAILED in 2m 14s\n8 actionable tasks: 8 executed\n`;

// A genuine COMPILE failure (never reaches :lint:test at all -- no status line for it anywhere in
// the output) -- the step-17 "must never satisfy tests_failed merely because Gradle exited nonzero"
// case. BUILD FAILED + a real nonzero footer, but classifyTaskExecutionMode has no status line to
// classify :lint:test from at all, so its mode is 'no_evidence', never 'failed'.
const GRADLE_COMPILE_FAILURE_STDOUT = `> Task :lint:compileKotlin FAILED\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':lint:compileKotlin'.\n> Compilation error. See log for more details\n\n* Try:\n> Run with --stacktrace option to get the stack trace.\n\nBUILD FAILED in 12s\n1 actionable task: 1 executed\n`;

// The 5th scenario shape (coverage-threshold-failure) -- the first `coverage_threshold_exceeded`
// scenario. Ground truth independently verified 6x (3x kmp-test, 3x direct Gradle + independent
// XML parse, cold GRADLE_USER_HOME each, fixed JDK 17) against android/nowinandroid @
// 7d45eae4f8720a0c77f507712ba2437ff974b6ed's `:core:domain` module: 4 real unit tests (kmp_test's
// own individual_total) pass cleanly, and 23 lines are left uncovered, exceeding a 15-line budget
// on both providers' independently-derived JaCoCo XML. :core:domain has zero substring collision
// with any other real module in this project, so kmp_test's own envelope dispatches exactly this
// 1 module -- unlike an earlier candidate, :core:datastore, whose --module-filter
// substring-collided with a sibling test-fixtures module (:core:datastore-test). That collision
// made the scenario operationally unreachable via the pinned skill's own ask-guard and let a real
// target-attribution gap in computeKmpTestTargetMatch go unnoticed -- see that function's own
// single-module-exclusivity comment.
const SCENARIO_5 = {
  schema: 1,
  id: 'coverage-threshold-failure',
  family: 'coverage',
  project_alias: 'nowinandroid',
  project_url: 'https://github.com/android/nowinandroid',
  project_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
  prompt: "This is a large, multi-module Android project. Somewhere in it there's a module containing the app's business-logic use cases (small classes with a single `invoke` operation, sitting between the data layer and the UI), with a few unit tests of its own. Can you find that module, confirm its unit tests genuinely pass, and check whether its own source code leaves no more than 15 lines uncovered by those tests?",
  expected_outcome: "The agent discovers NowInAndroid's :core:domain module, confirms its 4 unit tests pass cleanly, discovers it leaves 23 lines uncovered (exceeding a 15-line budget), and reports coverage_threshold_exceeded accurately.",
  policy: {
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    allowed_gradle_tasks: [':core:domain:testDemoDebugUnitTest'],
  },
  expected: {
    module: ':core:domain',
    outcome_kind: 'coverage_threshold_exceeded',
    kmp_test: {
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 4 },
      exit_code: 1,
      coverage: { tool: 'auto', min_missed_lines: 15, missed_lines: 23, with_data: [':core:domain'] },
    },
    gradle: { allowed_invocations: [':core:domain:testDemoDebugUnitTest'], evidence_task: ':core:domain:testDemoDebugUnitTest', tests: { total: 2, passed: 2, failed: 0 }, exit_code: 0 },
  },
  first_useful_signal_predicate: { description: 'first well-formed kmp_test evidence confirming :core:domain coverage gate fired at 23 missed lines > 15' },
  tags: ['train'],
};

// total/passed/failed here match expected.kmp_test.tests.individual_total (4/4/0) -- the ONLY
// count an honest agent running just kmp_test can actually observe end-to-end. kmp_test's own
// envelope never attaches external JUnit evidence to its own attempts (junit-evidence.mjs only
// ever attaches evidence to Gradle attempts), so an agent has no legitimate way to discover
// Gradle's separate 2/2/0 corroborating count -- see kmpEvalResultBlockMatchesObserved's own doc
// comment, and the review finding (P1-2) that caught the earlier, wrong Gradle-sourced answer.
const SCENARIO_5_CORRECT_ANSWER = kmpEvalResultText(
  "The :core:domain module's 4 tests pass, but it leaves 23 lines uncovered, exceeding the 15-line budget.",
  { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1 },
);

// Real envelope shape (condensed from an actual captured `kmp-test parallel --module-filter
// :core:domain --min-missed-lines 15 --json` ground-truth run, 3x reproduced identically): exactly
// 1 dispatched module (no sibling substring-collides with :core:domain), 4 individual testcases,
// and a single coherent `coverage_threshold_exceeded` error whose own threshold/missed_lines echo
// the real invoked flag and the real aggregated total exactly.
function coverageEnvelope(overrides = {}) {
  return JSON.stringify({
    tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
    project_root: 'C:\\fake', exit_code: 1, duration_ms: 143214,
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 4 },
    modules: [
      { name: 'core:domain', type: 'android', coverage_plugin: 'jacoco' },
    ],
    skipped: [],
    coverage: {
      tool: 'auto', missed_lines: 23, modules_contributing: 1,
      modules_with_kover_plugin: [],
      modules_with_jacoco_plugin: ['core:domain'],
      module_buckets: { with_data: ['core:domain'], no_xml: [], parse_errored: [], skipped_by_user: [] },
    },
    errors: [{ code: 'coverage_threshold_exceeded', message: 'Coverage threshold exceeded: 23 missed lines > 15 (--min-missed-lines)', threshold: 15, missed_lines: 23 }],
    warnings: [],
    parallel: {
      test_type: 'auto',
      legs: [{
        test_type: 'auto', exit_code: 0,
        execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
        cascade_detected: false, retry_fired: false,
      }],
      max_workers: 0, timeout_s: 600,
    },
    isolated: DEFAULT_ISOLATED_FIELD,
    ...overrides,
  });
}
const KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED = coverageEnvelope();

const GRADLE_SCENARIO5_PASS_STDOUT = `> Task :core:domain:compileDemoDebugUnitTestKotlin\n> Task :core:domain:testDemoDebugUnitTest\n\nBUILD SUCCESSFUL in 2m 19s\n124 actionable tasks: 124 executed\n`;

// The 6th and final scenario shape (changed-module-verification) -- the first (and, per this
// contract's own single-module scope, only) scenario requiring `kmp-test changed`, never
// `kmp-test parallel`, as terminal proof. Same pinned commit/module as SCENARIO_3
// (nowinandroid-core-common) -- reuses the identical, already-double-verified 1/1/0 ground truth --
// but the agent must discover an already-pending, uncommitted single-file edit and correctly scope
// testing to it, rather than being told which module to run outright.
const SCENARIO_6 = {
  schema: 1,
  id: 'changed-module-verification',
  family: 'test-only',
  project_alias: 'nowinandroid',
  project_url: 'https://github.com/android/nowinandroid',
  project_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
  prompt: "This is a large, multi-module Android project. There's already a small, uncommitted edit sitting in the working tree somewhere. Can you figure out which module that edit affects, run exactly that module's tests, and tell me what happened? Once you know the result, end your reply with a block in exactly this format...",
  expected_outcome: "The agent discovers the single pending edit affects NowInAndroid's :core:common module, scopes testing to exactly that module, and reports the accurate pass/fail count.",
  policy: {
    // 'parallel' stays allowed so a "ran parallel instead of changed" attempt is rejected by the
    // GRADER (terminal-eligibility), never by a policy-layer denial -- see the negative tests below.
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel', 'changed'],
    allowed_gradle_tasks: [':core:common:tasks', ':core:common:test'],
  },
  expected: {
    module: ':core:common',
    outcome_kind: 'tests_executed',
    kmp_test: { tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 }, exit_code: 0 },
    gradle: { allowed_invocations: [':core:common:test'], evidence_task: ':core:common:test', tests: { total: 1, passed: 1, failed: 0 }, exit_code: 0 },
    changed: { detected_modules: ['core:common'], staged_only: false, base_ref: 'HEAD' },
  },
  first_useful_signal_predicate: { description: 'first well-formed changed evidence confirming :core:common single-module detection and 1/1' },
  tags: ['held-out'],
};

const SCENARIO_6_CORRECT_ANSWER = kmpEvalResultText(
  'The pending edit is in the :core:common module; its 1 test passes.',
  { module: ':core:common', outcome_kind: 'tests_executed', total: 1, passed: 1, failed: 0 },
);

// Real envelope shape -- verbatim from ground truth (independently re-verified live, 3x, cold
// GRADLE_USER_HOME + JDK 17, against the pinned commit above): a real `changed` envelope has NO
// top-level `parallel` key at all (confirmed via a direct hasOwnProperty check on the raw JSON in
// all 3 runs) -- despite changed.md's own doc example showing one (a confirmed, pre-existing
// doc/code drift, out of scope to fix). `changed.detected_modules` is bare/colon-less
// ("core:common"), a deliberately different convention from `modules[].name` and `expected.module`.
function changedEnvelope(overrides = {}) {
  return JSON.stringify({
    tool: 'kmp-test', schema_version: 2, subcommand: 'changed', version: '0.14.0',
    project_root: 'C:\\fake', exit_code: 0, duration_ms: 131843,
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 },
    modules: [
      { name: 'core:common', type: 'jvm', coverage_plugin: null, test_build_type: null, has_flavor: false, flavors: [], android_dsl: false, android_dsl_variant: null },
    ],
    skipped: [],
    coverage: { tool: 'none', missed_lines: null, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] },
    errors: [],
    warnings: [{ code: 'coverage_aggregation_skipped', message: '--coverage-tool none: coverage aggregation skipped' }],
    changed: { detected_modules: ['core:common'], staged_only: false, base_ref: 'HEAD' },
    isolated: DEFAULT_ISOLATED_FIELD,
    ...overrides,
  });
}
const KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS = changedEnvelope();

// `parallel` with the SAME target/counts as SCENARIO_3/SCENARIO_6 -- used to prove a `parallel`
// attempt (even a fully correct, matching one) never satisfies this scenario, since only `changed`
// is terminal-eligible here.
const KMP_TEST_ENVELOPE_SCENARIO6_PARALLEL_SAME_COUNTS = KMP_TEST_ENVELOPE_SCENARIO3_PASS;

const GRADLE_SCENARIO6_PASS_STDOUT = `> Task :core:common:test\n\nBUILD SUCCESSFUL in 2m 2s\n11 actionable tasks: 11 executed\n`;

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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
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

describe('gradeScenarioCondition -- scenario 3 (:core:common, tests_executed) happy paths', () => {
  // Titled without "task-level + individual counts" (unlike SCENARIO_1's equivalent test): this
  // module's real total and individual_total are both 1, so unlike SCENARIO_1 (1 vs 24) this
  // fixture cannot itself discriminate that specific two-counter distinction -- it only proves an
  // exact-match envelope for this scenario's real shape passes.
  it('kmp-test path: exact match on module, outcome, and counts -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter core:common --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.checks.every((c) => c.passed)).toBe(true);
  });

  it('gradle path (direct evidence_task invocation): exact match -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :core:common:test --console=plain', resultContent: GRADLE_SCENARIO3_PASS_STDOUT, evidence: okJunit(1, 1, 0) }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- scenario 3 (:core:common) negative cases: wrong module, wrong task, wrong counts', () => {
  it('scenario 3: a well-formed envelope for the WRONG module, with coincidentally-matching counts, fails target AND outcome -- never a match', () => {
    // Carries the same parallel/isolated shape as KMP_TEST_ENVELOPE_SCENARIO3_PASS (unlike this
    // being a bare-bones fixture) so this test genuinely exercises the module-identity guard at
    // computeKmpTestTargetMatch, not an incidentally-missing-parallel-block failure instead.
    const wrongModuleEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 }, // identical shape to SCENARIO_3's expectation
      modules: [{ name: 'some-other-module', type: 'jvm' }], // but the WRONG module
      skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter some-other-module --json', resultContent: wrongModuleEnvelope }],
      kmpEvalResultText('1/1 tests passed.', { module: ':some-other-module', outcome_kind: 'tests_executed', total: 1, passed: 1, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a well-formed envelope for the RIGHT module but WRONG individual_total fails outcome (not just a final-answer-block mismatch)', () => {
    const wrongCountEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 2 }, // WRONG: ground truth is 1
      modules: [{ name: 'core:common', type: 'jvm' }],
      skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter core:common --json', resultContent: wrongCountEnvelope }],
      kmpEvalResultText('2 tests passed.', { module: ':core:common', outcome_kind: 'tests_executed', total: 2, passed: 2, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Uses :core:common:tasks specifically (not an arbitrary out-of-policy task like
  // :core:common:build) so this test isolates the allowed_invocations relevance gate on its own:
  // :core:common:tasks IS in policy.allowed_gradle_tasks (the hook would really allow the agent
  // to run it), but is NOT in expected.gradle.allowed_invocations -- proving it can't become
  // authoritative evidence even though it's a legitimate, policy-permitted command, never
  // conflating this with "the policy hook would have denied it anyway."
  it('a Gradle command for a task outside allowed_invocations (policy-allowed, but not this scenario\'s evidence task) is never even a candidate attempt', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :core:common:tasks --console=plain', resultContent: `> Task :core:common:tasks\n\ntest - Runs the test suite.\n\nBUILD SUCCESSFUL in 1s\n1 actionable task: 1 executed\n`, evidence: okJunit(1, 1, 0) }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a KMP_EVAL_RESULT block naming the WRONG module must fail even though outcome_kind and counts are otherwise correct', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter core:common --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS }],
      kmpEvalResultText('1/1 tests passed.', { module: ':some-other-module', outcome_kind: 'tests_executed', total: 1, passed: 1, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a KMP_EVAL_RESULT block with WRONG counts (claims 1 failed when the real evidence is 0 failed) must fail', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter core:common --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS }],
      kmpEvalResultText('The :core:common module ran 1 test, but it failed.', { module: ':core:common', outcome_kind: 'tests_executed', total: 1, passed: 0, failed: 1 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- scenario 4 (:lint, tests_failed) happy paths', () => {
  it('kmp-test path: exact match on module, outcome, and counts -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO4_FAIL }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.checks.every((c) => c.passed)).toBe(true);
  });

  it('gradle path (direct evidence_task invocation): exact match -> full pass', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO4_FAIL_STDOUT, resultIsError: true, evidence: okJunit(3, 0, 3) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- scenario 4 (:lint) negative cases: wrong module/count/exit, compile/setup failures never satisfy tests_failed', () => {
  it('a well-formed envelope for the WRONG module, with coincidentally-matching counts, fails target AND outcome', () => {
    const wrongModuleEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 1, duration_ms: 100,
      tests: { total: 1, passed: 0, failed: 1, skipped: 0, individual_total: 3 },
      modules: [{ name: 'some-other-module', type: 'jvm' }],
      skipped: [], coverage: {},
      errors: [{ code: 'module_failed', module: 'some-other-module', task: ':some-other-module:test', message: '[FAIL] some-other-module' }],
      warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 1,
          execution: { fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 1, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter some-other-module --json', resultContent: wrongModuleEnvelope }],
      kmpEvalResultText('3 tests failed.', { module: ':some-other-module', outcome_kind: 'tests_failed', total: 3, passed: 0, failed: 3 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a well-formed envelope for the RIGHT module but WRONG failed count fails outcome', () => {
    const wrongCountEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 1, duration_ms: 100,
      tests: { total: 1, passed: 0, failed: 1, skipped: 0, individual_total: 2 }, // WRONG: ground truth individual_total is 3
      // Deliberately kept internally coherent with its own (wrong) individual_total:2 -- exactly 2
      // test_failures entries -- so this test isolates the COUNT-mismatch-against-ground-truth
      // intent precisely, never incidentally also failing the separate test_failures-length check.
      modules: [{ name: 'lint', type: 'jvm', test_failures: KMP_TEST_ENVELOPE_SCENARIO4_TEST_FAILURES.slice(0, 2) }],
      skipped: [], coverage: {},
      errors: [{ code: 'module_failed', module: 'lint', task: ':lint:test', message: '[FAIL] lint' }],
      warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 1,
          execution: { fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 1, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: wrongCountEnvelope }],
      kmpEvalResultText('2 tests failed.', { module: ':lint', outcome_kind: 'tests_failed', total: 2, passed: 0, failed: 2 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a well-formed envelope claiming exit_code:0 (a clean pass) never satisfies tests_failed even with matching counts', () => {
    const cleanExitEnvelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    cleanExitEnvelope.exit_code = 0;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(cleanExitEnvelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Step 17: a compile/setup failure must never satisfy tests_failed merely because kmp-test's own
  // exit_code happens to be nonzero -- the envelope must carry the SAME real `module_failed` shape
  // a genuine test failure produces, never a different/absent error code.
  it('a kmp-test envelope with exit_code:1 but NO module_failed error entry (a harness/setup-level failure, not a real test failure) never satisfies tests_failed', () => {
    const setupFailureEnvelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    setupFailureEnvelope.errors = []; // no module_failed entry at all -- exit_code:1 alone proves nothing
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(setupFailureEnvelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a kmp-test envelope whose module_failed error names a DIFFERENT module never satisfies tests_failed for this scenario\'s target', () => {
    const wrongErrorModuleEnvelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    wrongErrorModuleEnvelope.errors = [{ code: 'module_failed', module: 'other', task: ':other:test', message: '[FAIL] other' }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(wrongErrorModuleEnvelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Review-round finding: the aggregate tests.{total,passed,failed,individual_total} counters were
  // the ONLY thing checked -- modules[0].test_failures (the real per-test detail array a genuine
  // envelope always carries, see KMP_TEST_ENVELOPE_SCENARIO4_TEST_FAILURES's own provenance) was
  // never inspected at all, so an envelope could claim a matching AGGREGATE count while its own
  // detailed list told a different story (missing, too short, or -- in a future outcome_kind with
  // real mixed results -- naming the wrong tests) and still grade success:true.
  it('a kmp-test envelope missing modules[0].test_failures never satisfies tests_failed, even with matching aggregate counts', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    delete envelope.modules[0].test_failures;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a kmp-test envelope whose modules[0].test_failures has only 1 entry never satisfies tests_failed when individual_total claims 3', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.modules[0].test_failures = envelope.modules[0].test_failures.slice(0, 1); // 1 real entry, but individual_total still says 3
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Round-2 review finding: test_failures was previously checked ONLY by .length -- its own
  // elements were never inspected at all, so an envelope could carry a correctly-SIZED array of
  // garbage (null entries, scalars, malformed objects) and still satisfy tests_failed as long as
  // the aggregate counters and the array's .length happened to match. Each entry must now be a
  // real {test, cause, type} object: `test`/`cause` non-empty strings (junit-xml.js's own
  // junitTestFailuresFor always produces both -- `test` falls back to '<unknown>', `cause` falls
  // back to the literal 'error'/'failure', but NEITHER is ever empty or absent), `type` null OR a
  // non-empty string (junit-xml.js's own `type: type ?? null` -- legitimately null when the
  // captured <failure>/<error> tag has no type="..." attribute). Deliberately NOT comparing
  // specific test identities/names against the schema -- see this file's own "exactly one target
  // task" scoping note, above.
  it('a kmp-test envelope whose test_failures array contains null entries never satisfies tests_failed, even when the length matches', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.modules[0].test_failures = [null, null, null];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a kmp-test envelope whose test_failures array contains a scalar (non-object) entry never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.modules[0].test_failures[0] = 'not-an-object';
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a kmp-test envelope whose test_failures entry is missing a required field (cause) never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    delete envelope.modules[0].test_failures[0].cause;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a kmp-test envelope whose test_failures entry has a wrong-typed field (type: a number, neither null nor a string) never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.modules[0].test_failures[0].type = 42;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('regression guard: a test_failures entry with type:null (the real shape junit-xml.js produces when no type="..." attribute is present) still satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.modules[0].test_failures[0].type = null;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  // Review-round finding: `setup_failed:true` (result-rollup.js's own real discriminator: "the
  // failure happened pre-test -- compile, plugin error, classpath, runner setup, etc." -- tests
  // never actually ran) was never checked, so a genuine SETUP failure carrying this exact real flag
  // could still satisfy tests_failed as long as the (stale/coincidental) aggregate counts matched.
  it('a kmp-test module_failed entry with setup_failed:true (tests never actually ran) never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.errors[0].setup_failed = true;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Round-2 review finding: `setup_failed !== true` only rejects the LITERAL boolean `true` --
  // the exact same class of gap this file's own `dry_run`/`list_only` checks were already fixed
  // for (see validateParallelEvidence's own fail-closed-allowlist comment). result-rollup.js's
  // real errEntry object literal (`{code, module, task, message}`) never carries a `setup_failed`
  // key at all for a genuine test failure -- the key is only ever ADDED, and only ever set to the
  // literal boolean `true`, when `taskTestcaseCount === 0` (a real pre-test failure; see
  // recordLegResults's own `if (failures.length > 0) {...} else if (taskTestcaseCount === 0) {
  // errEntry.setup_failed = true }` branch). So the only real production states are "key absent"
  // (genuine test failure) or "key present, value true" (genuine setup failure) -- ANY other
  // shape (a string, a number, an explicit null) is impossible real evidence and must be rejected
  // exactly like a wrong-typed `true` would be, not silently tolerated because it merely isn't
  // `=== true`.
  it('a kmp-test module_failed entry with setup_failed:"true" (string, not the real boolean production ever emits) never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.errors[0].setup_failed = 'true';
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a kmp-test module_failed entry with setup_failed:1 (number) never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.errors[0].setup_failed = 1;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a kmp-test module_failed entry with setup_failed:null (explicitly present, not genuinely absent) never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.errors[0].setup_failed = null;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Review-round finding: only `errors.length === matchingModuleFailures.length` was checked
  // (every entry must be a matching module_failed, none unrelated) -- but `matchingModuleFailures.length
  // >= 1` tolerated MORE than one, so two duplicate module_failed entries for the same module (never
  // a real production shape -- a module fails or doesn't, once) still satisfied tests_failed as long
  // as the unrelated tests.failed aggregate happened to equal 1.
  it('two duplicate module_failed entries for the same module never satisfy tests_failed, even though tests.failed still says 1', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.errors = [envelope.errors[0], { ...envelope.errors[0] }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Review-round finding (the sharpest one): `module_failed.task` was never cross-checked against
  // `expected.gradle.evidence_task` at all -- only `code`/`module`. A module_failed entry naming a
  // DIFFERENT task (e.g. a real compile failure on `:lint:compileKotlin`, which never runs
  // `:lint:test` at all) still satisfied tests_failed as long as the module name matched, directly
  // contradicting this scenario's own declared guarantee that a compile/setup failure elsewhere in
  // the SAME module must never be laundered as "the target task's tests failed".
  it('a module_failed entry naming a DIFFERENT task than expected.gradle.evidence_task never satisfies tests_failed', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.errors[0].task = ':lint:compileKotlin';
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Step 17 -- the Gradle-provider mirror: a genuine COMPILE failure never even reaches :lint:test
  // (no status line for it exists anywhere in the output), so mode is 'no_evidence', never 'failed'
  // -- BUILD FAILED + a real nonzero exit_code alone must never be enough.
  it('gradle: a genuine compile failure (BUILD FAILED, but :lint:test never ran) never satisfies tests_failed', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_COMPILE_FAILURE_STDOUT, resultIsError: true, evidence: { status: 'no_xml' } }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('gradle: a BUILD SUCCESSFUL result (tests actually passed) never satisfies tests_failed even if the agent claims otherwise', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO3_PASS_STDOUT.replace(/core:common/g, 'lint'), evidence: okJunit(3, 3, 0) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a KMP_EVAL_RESULT block naming the WRONG outcome_kind (tests_executed instead of tests_failed) fails the final-answer check even with correct evidence', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO4_FAIL }],
      kmpEvalResultText('3/3 tests passed.', { module: ':lint', outcome_kind: 'tests_executed', total: 3, passed: 3, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('a KMP_EVAL_RESULT block with WRONG counts (claims 1 failed when the real evidence is 3 failed) fails the final-answer check', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO4_FAIL }],
      kmpEvalResultText('1 test failed.', { module: ':lint', outcome_kind: 'tests_failed', total: 1, passed: 0, failed: 1 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- scenario 4 (:lint) JUnit-evidence attribution applies to tests_failed exactly as tests_executed', () => {
  it('unreliable Gradle JUnit evidence (a genuine skipped testcase this path cannot count) never satisfies tests_failed', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO4_FAIL_STDOUT, resultIsError: true, evidence: { status: 'integrity_error', reason: 'skipped_testcase_unsupported' } }],
      SCENARIO_4_CORRECT_ANSWER,
      { unreliable: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(true);
    expect(grade.success).toBe(false);
  });

  it('missing JUnit evidence (no_xml -- the mechanism found nothing) never satisfies tests_failed', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO4_FAIL_STDOUT, resultIsError: true, evidence: { status: 'no_xml' } }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('two same-turn policy-allowed producers (ambiguous JUnit evidence) is a harness-integrity defect for tests_failed too, never a plain negative result', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO4_FAIL_STDOUT, resultIsError: true, evidence: { status: 'conflict' } }],
      SCENARIO_4_CORRECT_ANSWER,
      { ambiguousJunitEvidence: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
    expect(grade.success).toBe(false);
  });

  // CodeRabbit review-round finding: this test's ORIGINAL title/comment claimed to guard
  // matrix-runner.mjs's own `junitEvidenceEnabled` gate ("if a future change accidentally scoped
  // it back to 'tests_executed' only..."), but `buildConditionResult` (this file's own helper,
  // see its header comment) builds `junitAttribution` LOCALLY and always populates
  // `perAttemptJunit` regardless of what `junitEvidenceEnabled` resolves to in real production --
  // this test never calls `runScenarioMatrix`/`isJunitEvidenceOutcome` at all, so it would stay
  // GREEN even if that gate regressed. What this test DOES genuinely prove: `evaluateGradleAttempt`
  // (graders.mjs) actually CONSUMES `resolvedEvidence` rather than ignoring it -- WRONG JUnit
  // counts (okJunit(1,0,1) against this scenario's real 3/0/3) correctly fail outcomeMatches, not
  // silently pass. The real matrix-runner-gate regression guard is
  // `agentic-eval-matrix-runner.test.js`'s direct unit test of `isJunitEvidenceOutcome`.
  it('evaluateGradleAttempt genuinely consumes resolvedEvidence for tests_failed (wrong JUnit counts fail outcomeMatches, not silently pass through)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO4_FAIL_STDOUT, resultIsError: true, evidence: okJunit(1, 0, 1) }], // WRONG counts
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});

describe('gradeScenarioCondition -- scenario 4 (:lint) terminal-attempt selection: a corrected retry still wins', () => {
  it('an earlier malformed attempt followed by a correct retry on the SAME module grades success:true off the LATER attempt', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter lint --json', resultContent: 'not valid json at all' },
        { command: 'kmp-test parallel --module-filter lint --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO4_FAIL },
      ],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.success).toBe(true);
    expect(grade.testInvocationsTotal).toBe(2);
    expect(grade.retries).toBe(1);
  });

  it('a correct attempt followed by a LATER unrelated-module exploration does not flip success to false', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter lint --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO4_FAIL },
        { command: 'kmp-test parallel --module-filter core:common --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS },
      ],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Module-filter target-attribution parity: computeKmpTestTargetMatch's tests_executed branch (and
// evaluateKmpTestAttempt's intendedTargetMatches) now validate the command's own --module-filter
// against the resolved module via the REAL production matcher (lib/orchestrators/module-filter.js's
// matchModuleFilter, imported directly), not exact-string equality. Pre-fix, an agent correctly
// targeting a NESTED module (this corpus's first -- :core:common, not :shared/:app) via a short
// substring or glob filter that the real CLI resolves correctly could be graded a FAILURE, purely
// because `normalizeModuleName(moduleFilter) !== normalizeModuleName(envelopeModule)` rejects
// anything short of exact string equality. The envelope.modules.length===1 + module-identity gates
// are unchanged; only the FILTER comparison changed. no_applicable_tests's own branch is
// deliberately untouched -- envelope.modules[] is always empty there, so there is no envelope-side
// module data to corroborate a loose filter against, and it must stay exact-match fail-closed.
// ---------------------------------------------------------------------------------------------
describe('gradeScenarioCondition -- module-filter target attribution uses real matchModuleFilter semantics (tests_executed only; no_applicable_tests stays exact)', () => {
  it('a SHORT (substring) --module-filter that matchModuleFilter would accept for the target module passes -- fails under the old exact-string-equality logic', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter common --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('an anchored GLOB --module-filter that matchModuleFilter would accept for the target module passes -- fails under the old exact-string-equality logic', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter core:* --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('a --module-filter that does NOT match the target module under real matchModuleFilter semantics still fails, even though the envelope itself reports the right module -- the loosened check is not a rubber stamp', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter other --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('an envelope reporting MULTIPLE modules still fails closed even with a filter matchModuleFilter would otherwise accept -- the modules.length===1 gate runs BEFORE the filter comparison and is unchanged', () => {
    const multiModuleEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 },
      modules: [{ name: 'core:common', type: 'jvm' }, { name: 'core:other', type: 'jvm' }],
      skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter common --json', resultContent: multiModuleEnvelope }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('no_applicable_tests: a --module-filter that WOULD match the target under matchModuleFilter (glob) is still REJECTED -- this branch deliberately stays exact-match fail-closed, since modules[] is empty and there is no envelope-side module data to corroborate a loose filter against', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter a* --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- terminal-attempt selection: intendedTargetMatches also uses real matchModuleFilter semantics', () => {
  it('a CORRECT first attempt using a short (substring) filter, followed by a later attempt at an unrelated wrong module, keeps the FIRST attempt as terminal evidence -- fails under the old exact-match intendedTargetMatches logic (both attempts would read as "never tried the target", so terminal falls back to the LAST attempt overall -- the wrong one)', () => {
    const wrongModuleEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 50, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 },
      modules: [{ name: 'some-other-module', type: 'jvm' }], skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter common --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS },
        { command: 'kmp-test parallel --module-filter some-other-module --json', resultContent: wrongModuleEnvelope },
      ],
      SCENARIO_3_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_3);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.terminalAuthoritativeEventIndex).toBe(cr.bashResults[0].resultIndex);
  });

  // Reproduced regression (post-merge review finding): intendedTargetMatches must NOT use
  // matchModuleFilter for no_applicable_tests, mirroring computeKmpTestTargetMatch's own
  // outcome_kind split exactly. A valid FIRST attempt (exact --module-filter app) followed by a
  // LATER attempt using a looser glob (--module-filter a*, same no_applicable_tests evidence
  // shape) must NOT let the later attempt's filter count as "also intended" -- the glob is
  // rejected as EVIDENCE by the sibling test above ("no_applicable_tests: a --module-filter that
  // WOULD match... is still REJECTED"), but before this fix, intendedTargetMatches loosely
  // accepted it anyway, which pulled the later, wrong-per-this-outcome-kind attempt into
  // onTargetAttempts and made IT terminal -- silently overriding the genuinely correct first
  // attempt and flipping a real success to a false failure.
  it('no_applicable_tests: a later attempt using a looser filter must not steal terminal selection away from a genuinely correct earlier exact-filter attempt', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: 'kmp-test parallel --module-filter a* --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
      ],
      SCENARIO_2_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.terminalAuthoritativeEventIndex).toBe(cr.bashResults[0].resultIndex);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- adversarial-review finding: matchModuleFilter callers must not crash on a malformed target', () => {
  // matchModuleFilter (unlike normalizeModuleName) calls `.replace` on its `name` argument
  // unconditionally, so a scenario fixture missing `expected.module` would throw inside
  // computeKmpTestTargetMatch/intendedTargetMatches instead of failing closed like every other
  // malformed shape this file rejects. Confirmed unreachable via the real corpus/scenarios/*.json
  // pipeline (schemas.mjs's validateScenario requires `expected.module` to be a string matching
  // `^:[A-Za-z0-9_:-]+$` before a scenario ever reaches grading) -- this guards the function's own
  // contract directly, the same way it already guards against every other adversarial envelope
  // shape, rather than relying solely on an upstream caller.
  it('a scenario whose expected.module is missing does not crash grading -- fails closed instead', () => {
    const malformedScenario = { ...SCENARIO_3, expected: { ...SCENARIO_3.expected, module: undefined } };
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter common --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO3_PASS }],
      SCENARIO_3_CORRECT_ANSWER,
    );
    let grade;
    expect(() => { grade = gradeScenarioCondition(cr, malformedScenario); }).not.toThrow();
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
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
    // terminalAuthoritativeEventIndex (accepted-run-observability PR, additive): the grader's own
    // selected TERMINAL attempt is the LATER, second call (index 0=init, 1=tool_use1, 2=result1,
    // 3=tool_use2, 4=result2) -- genuinely DIFFERENT from firstUsefulSignalEventIndex, proving this
    // is never merely a copy of the first-signal index.
    expect(grade.terminalAuthoritativeEventIndex).toBe(4);
    expect(grade.terminalAuthoritativeEventIndex).not.toBe(grade.firstUsefulSignalEventIndex);
  });
});

describe('gradeScenarioCondition -- terminalAuthoritativeEventIndex (additive, accepted-run-observability PR)', () => {
  it('is the SAME event as firstUsefulSignalEventIndex when there is only one on-target attempt', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.terminalAuthoritativeEventIndex).toBe(2);
    expect(grade.terminalAuthoritativeEventIndex).toBe(grade.firstUsefulSignalEventIndex);
  });

  it('is null when no attempt capable of producing target evidence was ever made', () => {
    const cr = buildConditionResult([], SCENARIO_1_CORRECT_ANSWER);
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.terminalAuthoritativeEventIndex).toBeNull();
    expect(grade.firstUsefulSignalEventIndex).toBeNull();
  });

  it('tracks the terminal attempt even when it is WRONG (a later, incorrect retry) -- never falls back to the first correct one', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }, // correct, first
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS }, // wrong module's shape, later
      ],
      'Not sure what happened.',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // Event 4 is the second (terminal, wrong) tool_result (0=init,1=tool_use1,2=result1,3=tool_use2,4=result2).
    expect(grade.terminalAuthoritativeEventIndex).toBe(4);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });
});

describe('gradeScenarioCondition -- decision 13: provider contradiction is diagnostic-only, never gates the verdict', () => {
  // Uses SCENARIO_2 (no_applicable_tests), not SCENARIO_1 -- no_applicable_tests never consumes
  // JUnit evidence at all (junit-evidence.mjs's attributeCondition is never even enabled for it),
  // so this shape stays a clean, unambiguous "both providers cleanly agree" fixture regardless of
  // how many producers are involved -- exactly what this test needs to isolate check 7's own
  // diagnostic-only behavior.
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
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: wrongGradleStdout, resultIsError: true, evidence: okJunit(24, 20, 4) }, // says fail -- terminal attempt
      ],
      'Not sure what happened -- results were inconsistent.',
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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, resultIsError: true, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Round-4 fix: two attempts sharing the SAME transcript index (a genuine same-assistant-turn
  // concurrent dispatch -- the only shape junit-evidence.mjs's attributeCondition treats as a real
  // conflict) each have their own evidence resolved to {status:'conflict'} and the whole condition
  // is flagged harnessEvidenceAmbiguous:true. buildConditionResult's own step loop always assigns a
  // fresh transcript index per step (see its doc comment), so a genuine same-turn dispatch cannot
  // be constructed here -- attributeCondition's own concurrency-detection logic has its dedicated
  // coverage in agentic-eval-junit-evidence.test.js. This test instead faithfully reproduces
  // attributeCondition's OUTPUT for that case (both the whole-condition flag AND each conflicting
  // attempt's own {status:'conflict'} evidence) to verify gradeScenarioCondition's OWN consumption
  // of it: the terminal attempt's own evidence correctly reads as not-ok (so expectedOutcomeMatched
  // is false), AND the harness-integrity flag is surfaced independently for cmdRun/
  // scenarioCellIntegrityOk to block the whole matrix's promotion on.
  it('a proven same-turn JUnit-evidence conflict fails closed on both the per-attempt outcome AND the whole-condition harness-integrity flag', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: { status: 'conflict' } },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain --rerun-tasks', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: { status: 'conflict' } },
      ],
      SCENARIO_1_CORRECT_ANSWER,
      { ambiguousJunitEvidence: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
    // This must be surfaced as a HARNESS-INTEGRITY defect (so cmdRun can block the whole matrix's
    // promotion via scenarioCellIntegrityOk), not merely degrade outcomeMatches to false and read
    // as "the agent got it wrong" -- a valid negative result the conflict is NOT.
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
  });

  // Direct regression proof for round-4's fix: two GENUINELY SEQUENTIAL (different transcript
  // index) Gradle attempts targeting the same evidence task are no longer conflated into a pooled,
  // condition-wide ambiguity just because there are two of them -- each attempt's own evidence is
  // now attributed independently (keyed by tool_use_id), so two clean, non-conflicting retries
  // correctly attribute and pass, exactly like a single attempt does. This corrects the OLD test
  // pinned to the bug's own over-broad compensating mitigation (any 2+ producers => ambiguous), not
  // a weakening of coverage for the new code.
  it('two SEQUENTIAL (different-index, non-conflicting) Gradle attempts both attribute correctly and pass -- no longer conflated into a false ambiguity', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain --rerun-tasks', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });

  it('a SINGLE Gradle attempt (no ambiguity) still passes normally -- the attribution fix does not regress the ordinary one-attempt case', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
  });
});

describe('gradeScenarioCondition -- round-8: bash_tool_use_present is decision-aware for EVERY command kind, not just kmp-test-parallel/Gradle', () => {
  // round-7 only excluded a denied decision for 'parallel'-subcommand kmp-test attempts and
  // Gradle attempts, since that was all attributeCondition's own (relevance-scoped)
  // decisionByAttempt covered at the time. A denied `doctor`/`describe` attempt, or a denied
  // `parallel --dry-run` (plan-only, never "relevant" either), still slipped through --
  // round-8's resolveDecisions() now resolves a decision for EVERY bashResult uniformly, closing
  // the gap generally instead of adding another per-subcommand conditional.
  it.each([
    ['kmp-test doctor --json', 'doctor (real run)'],
    ['kmp-test describe --json', 'describe (real run)'],
    ['kmp-test parallel --dry-run --json', 'parallel --dry-run (plan-only)'],
  ])('a DENIED %s does not satisfy bash_tool_use_present (%s)', (command) => {
    const cr = buildConditionResult(
      [{ command, decision: 'deny', resultContent: 'denied', resultIsError: true }],
      'I could not run any diagnostic commands -- everything was blocked by policy.\n\nKMP_EVAL_RESULT\n{"module": ":shared", "outcome_kind": "no_applicable_tests"}\nKMP_EVAL_RESULT_END',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    const check = grade.checks.find((c) => c.name === 'bash_tool_use_present');
    expect(check.passed).toBe(false);
  });

  it.each([
    ['kmp-test doctor --json', 'doctor (real run)'],
    ['kmp-test describe --json', 'describe (real run)'],
    ['kmp-test parallel --dry-run --json', 'parallel --dry-run (plan-only)'],
  ])('an ALLOWED %s DOES satisfy bash_tool_use_present (%s)', (command) => {
    const cr = buildConditionResult(
      [{ command, decision: 'allow', resultContent: '{"tool":"kmp-test","schema_version":2}' }],
      'Ran a diagnostic command.\n\nKMP_EVAL_RESULT\n{"module": ":shared", "outcome_kind": "no_applicable_tests"}\nKMP_EVAL_RESULT_END',
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    const check = grade.checks.find((c) => c.name === 'bash_tool_use_present');
    expect(check.passed).toBe(true);
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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: withMisleadingDiagnostic, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
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
describe('gradeScenarioCondition -- round-3 mandatory reproduction 1: K+G provider mix, sequential (not same-turn)', () => {
  it('one kmp-test parallel attempt + one Gradle attempt, both individually clean and agreeing, sequential (different transcript index) under tests_executed -> attributes correctly, no longer a false ambiguity', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
  });

  // Mirrors the sibling test above but for a genuine same-assistant-turn concurrent dispatch across
  // TWO DIFFERENT providers (kmp-test parallel + Gradle) -- see the G+G conflict test's own doc
  // comment (above, in the previous describe block) for why buildConditionResult's sequential step
  // construction cannot reproduce the input shape directly, and why faithfully reproducing
  // attributeCondition's OUTPUT (the whole-condition flag plus the conflicting Gradle attempt's own
  // {status:'conflict'} evidence) is the correct way to test gradeScenarioCondition's consumption of
  // it in isolation.
  it('a kmp-test attempt and a Gradle attempt sharing the SAME transcript index (genuine same-turn dispatch) IS a real conflict -- harnessEvidenceAmbiguous must be true', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: { status: 'conflict' } },
      ],
      SCENARIO_1_CORRECT_ANSWER,
      { ambiguousJunitEvidence: true },
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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeFooterOnly, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('a fake line-start "BUILD SUCCESSFUL ..." sentence followed by a REAL, complete "BUILD FAILED in 2s" footer -- exactly one REAL footer line exists, so it correctly governs', () => {
    const fakeSuccessThenRealFailure = `BUILD SUCCESSFUL but this is not a Gradle footer\n> Task :shared:testAndroidHostTest FAILED\n\nBUILD FAILED in 2s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeSuccessThenRealFailure, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: noFooterAtAll, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
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
      junitAttribution: {
        perAttemptJunit: new Map([['t1', okJunit(24, 24, 0)]]),
        decisionByAttempt: new Map([['t1', 'allow']]),
        ambiguousJunitEvidence: false, captureIncomplete: false, unreliable: false,
      },
    };
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('tests_executed: a single (non-ambiguous) Gradle attempt with an otherwise-clean footer but no resolved evidence at all (never captured) must fail closed, not pass on the footer alone', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
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
describe('gradeScenarioCondition -- round-4 (superseded by round-5 per-attempt attribution): module-scoping + dry-run-free producer counting', () => {
  it('kmp-test-only condition (wrong module, then the right one) with ZERO Gradle attempts anywhere -- must NOT be ambiguous, since nothing in this condition is even classified as a Gradle-relevant attempt', () => {
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

  it('kmp-test (wrong module) + kmp-test (right module) + a real Gradle attempt on the right module, all SEQUENTIAL (different transcript index) -- no longer ambiguous; each attempt attributes independently and the terminal (Gradle) attempt governs', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(true);
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
  it('Gradle-FIRST, kmp-test-SECOND ordering (the mirror of the only-ever-tested kmp-test-first ordering) is handled the same way -- sequential, different-index attempts are not ambiguous', () => {
    const cr = buildConditionResult(
      [
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.harnessEvidenceAmbiguous).toBe(false);
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
      spawnResult: { terminated: false, terminationReason: null },
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
        { command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) },
      ],
      SCENARIO_1_CORRECT_ANSWER,
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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: fakeDuration, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('regression guard: a genuine COMPOUND duration ("1m 30s") is still accepted, not just bare seconds', () => {
    const compoundDuration = `> Task :shared:compileAndroidHostTest UP-TO-DATE\n> Task :shared:testAndroidHostTest\n\nBUILD SUCCESSFUL in 1m 30s\n21 actionable tasks: 21 executed\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: compoundDuration, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: genuineRetryThenFailed, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
  });

  it('two footer lines that happen to AGREE (both BUILD SUCCESSFUL) are STILL ambiguous -- the rule is "exactly one", not "the values must differ"', () => {
    const twoAgreeingFooters = `${GRADLE_SCENARIO1_PASS_STDOUT}\n> Task :shared:testAndroidHostTest UP-TO-DATE\n\nBUILD SUCCESSFUL in 1s\n`;
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: twoAgreeingFooters, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
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
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: elidedSecondsDuration, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
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
        max_workers: 0, timeout_s: 600,
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
  const GOOD_PARALLEL = { test_type: 'auto', legs: [GOOD_LEG], max_workers: 0, timeout_s: 600 };
  const DEFAULT_COMMAND = 'kmp-test parallel --module-filter shared --json';

  function buildEnvelope({ parallel = GOOD_PARALLEL, tests = { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 }, errors = [], isolated = DEFAULT_ISOLATED_FIELD } = {}) {
    return JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests,
      modules: [{ name: 'shared', type: 'kmp' }], skipped: [], coverage: {}, errors, warnings: [],
      parallel, isolated,
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
    ['impossible: top-level test_type "all" with only 1 leg (legsForAll always produces >= 3)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }], max_workers: 0, timeout_s: 600 } })],
    ['impossible: top-level test_type "auto" with 2 legs (a non-all dispatch always has exactly 1 leg)', DEFAULT_COMMAND, buildEnvelope({ parallel: { ...GOOD_PARALLEL, legs: [GOOD_LEG, { ...GOOD_LEG }] } })],
    ['impossible: a leg itself claims test_type "all" (legsForAll never dispatches a literal "all" leg)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'all' }, { ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }], max_workers: 0, timeout_s: 600 } })],
    ['malformed multi-leg: two good concrete legs plus one null leg under test_type "all"', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }, null], max_workers: 0, timeout_s: 600 } })],
    ['EXACT REPRODUCTION: explicit command/envelope --test-type mismatch (command says androidUnit, envelope says jvm)', DEFAULT_COMMAND.replace('--json', '--test-type androidUnit --json'), buildEnvelope({ parallel: { test_type: 'jvm', legs: [{ ...GOOD_LEG, test_type: 'jvm' }], max_workers: 0, timeout_s: 600 } })],
    ['command omits --test-type (implicit auto) but envelope claims a specific type', DEFAULT_COMMAND, buildEnvelope({ parallel: { test_type: 'androidUnit', legs: [{ ...GOOD_LEG, test_type: 'androidUnit' }], max_workers: 0, timeout_s: 600 } })],
    // EXACT REPRODUCTION (independent contract review): a duplicated leg type standing in for a
    // MISSING one -- legsForAll (lib/orchestrators/parallel/dispatch.js) can never produce a
    // repeated leg type in any environment, so membership-per-leg alone (without a distinctness
    // check) previously accepted this as valid "all" evidence.
    ['EXACT REPRODUCTION: "all" dispatch with a DUPLICATE leg type standing in for a missing one (common repeated, androidUnit never dispatched)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }], max_workers: 0, timeout_s: 600 } })],
    // EXACT REPRODUCTION (round-2 contract review): distinctness alone doesn't validate the
    // surviving SET is one legsForAll can actually produce -- legsForAll always includes
    // common/desktop/androidUnit unconditionally; a distinct, all-valid-membership set missing
    // all three (standing in with OTHER valid-but-conditional types instead) is still impossible.
    ['EXACT REPRODUCTION: "all" dispatch missing all 3 unconditional leg types (androidInstrumented/ios/macos only -- common/desktop/androidUnit never dispatched)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'androidInstrumented' }, { ...GOOD_LEG, test_type: 'ios' }, { ...GOOD_LEG, test_type: 'macos' }], max_workers: 0, timeout_s: 600 } })],
    // EXACT REPRODUCTION (round-2 contract review): ios/macos are only ever added TOGETHER as a
    // pair (macOS host only) -- never one without the other. A set with exactly one of the two is
    // impossible regardless of platform/env-var state.
    ['EXACT REPRODUCTION: "all" dispatch with ios present but macos absent (legsForAll only ever adds them as a pair)', DEFAULT_COMMAND.replace('--json', '--test-type all --json'), buildEnvelope({ parallel: { test_type: 'all', legs: [{ ...GOOD_LEG, test_type: 'common' }, { ...GOOD_LEG, test_type: 'desktop' }, { ...GOOD_LEG, test_type: 'androidUnit' }, { ...GOOD_LEG, test_type: 'ios' }], max_workers: 0, timeout_s: 600 } })],
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
    const envelope = buildEnvelope({ parallel: { test_type: 'androidUnit', legs: [{ ...GOOD_LEG, test_type: 'androidUnit' }], max_workers: 0, timeout_s: 600 } });
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
    const envelope = buildEnvelope({ tests: { total: 3, passed: 3, failed: 0, skipped: 0, individual_total: 24 }, parallel: { test_type: 'all', legs, max_workers: 0, timeout_s: 600 } });
    const grade = gradeCommand(DEFAULT_COMMAND.replace('--json', '--test-type all --json'), envelope, scenario1WithTaskCount(3));
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
  });

  it('regression guard: production-real 6-leg "all" dispatch on a macOS host with ADB (all 3 conditional legs present: androidInstrumented + ios + macos) still passes', () => {
    // The full legsForAll output when nothing is skipped: the 3 unconditional legs plus
    // androidInstrumented (skipAdb=false) plus BOTH ios and macos together (macOS host).
    const legs = ['common', 'desktop', 'androidUnit', 'androidInstrumented', 'ios', 'macos'].map((t) => ({ ...GOOD_LEG, test_type: t }));
    const envelope = buildEnvelope({ tests: { total: 6, passed: 6, failed: 0, skipped: 0, individual_total: 24 }, parallel: { test_type: 'all', legs, max_workers: 0, timeout_s: 600 } });
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
    envelope.parallel = { test_type: 'auto', legs: [null], max_workers: 0, timeout_s: 600 };
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
      max_workers: 0, timeout_s: 600,
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
      parallel: { test_type: 'auto', legs: [{ ...GOOD_LEG, ...legOverride }], max_workers: 0, timeout_s: 600 },
      isolated: DEFAULT_ISOLATED_FIELD,
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

  // Round 11 (Docker/local-ci audit, P1 blocker): buildParallelParsed (result-rollup.js:373)
  // unconditionally emits parallel.max_workers/timeout_s and the sibling top-level envelope.isolated
  // -- reproduced directly against 8442ed0 that NONE of the three were ever validated: a missing
  // max_workers, a wrong-typed timeout_s, and a missing isolated all passed as authoritative
  // evidence, meaning an incomplete or fabricated envelope could still become benchmark_eligible:true.
  const GOOD_ISOLATED = { enabled: false, cache_dir: null, kept: false, locked: true };
  function envelopeWithParallelOverride(parallelOverride, { isolated = GOOD_ISOLATED } = {}) {
    return {
      tests: { failed: 0, total: 1 },
      parallel: { test_type: 'auto', legs: [GOOD_LEG], max_workers: 0, timeout_s: 600, ...parallelOverride },
      isolated,
    };
  }

  it('EXACT REPRODUCTION: missing max_workers is rejected, not silently accepted', () => {
    const envelope = envelopeWithParallelOverride({ max_workers: undefined });
    delete envelope.parallel.max_workers;
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('EXACT REPRODUCTION: a wrong-typed timeout_s (string) is rejected', () => {
    const envelope = envelopeWithParallelOverride({ timeout_s: '600' });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('EXACT REPRODUCTION: missing isolated entirely is rejected', () => {
    const envelope = envelopeWithParallelOverride({});
    delete envelope.isolated;
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('a well-typed but policy-incoherent max_workers (4, not the real flag-less default 0) is rejected -- neither scenario\'s policy permits --max-workers', () => {
    const envelope = envelopeWithParallelOverride({ max_workers: 4 });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('a well-typed but policy-incoherent timeout_s (900, not the real flag-less default 600) is rejected -- neither scenario\'s policy permits --timeout', () => {
    const envelope = envelopeWithParallelOverride({ timeout_s: 900 });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('a negative max_workers is rejected', () => {
    const envelope = envelopeWithParallelOverride({ max_workers: -1 });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('an extra, unrecognized key on parallel is rejected -- buildParallelParsed constructs exactly 4 keys, never more', () => {
    const envelope = envelopeWithParallelOverride({ injected_bogus_field: 'x' });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('isolated.enabled:true is rejected -- neither scenario\'s policy ever permits --isolated', () => {
    const envelope = envelopeWithParallelOverride({}, { isolated: { ...GOOD_ISOLATED, enabled: true } });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('a wrong-typed isolated.cache_dir (number, not string|null) is rejected', () => {
    const envelope = envelopeWithParallelOverride({}, { isolated: { ...GOOD_ISOLATED, cache_dir: 123 } });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('an extra, unrecognized key on isolated is rejected -- buildIsolatedField constructs exactly 4 keys, never more', () => {
    const envelope = envelopeWithParallelOverride({}, { isolated: { ...GOOD_ISOLATED, extra: true } });
    expect(validateParallelEvidence(envelope, null)).toBe(false);
  });

  it('regression guard: production-real max_workers:0/timeout_s:600/isolated all present and policy-coherent still validates', () => {
    const envelope = envelopeWithParallelOverride({});
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
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
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
      parallel: { test_type: 'auto', legs: [GOOD_LEG], max_workers: 0, timeout_s: 600 },
      isolated: DEFAULT_ISOLATED_FIELD,
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

  // P1 blocker (Docker/local-ci audit): proves the NEW max_workers/timeout_s/isolated invariants
  // are wired through the SAME harness-integrity mechanism as every other parallel-evidence
  // coherence check above -- an incomplete envelope (missing max_workers here) must set
  // parallelEvidenceMalformed:true end-to-end through the real grading pipeline, not merely fail a
  // direct, isolated validateParallelEvidence() unit call.
  it('EXACT REPRODUCTION: a well-shaped outer envelope missing parallel.max_workers sets parallelEvidenceMalformed:true end-to-end, not just expectedOutcomeMatched:false', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    delete envelope.parallel.max_workers;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.parallelEvidenceMalformed).toBe(true);
  });
});

// Round 11 (Docker/local-ci audit): matrix-runner.mjs's captureGradleJunitEvidence used to return
// {harnessIntegrityIssue:true, reason} instead of a miscounted {total,passed,failed} when the real
// JUnit XML contained a genuine <skipped> testcase or could not be fully read -- computed ONCE per
// condition and applied unconditionally, regardless of whether a Gradle attempt was even present.
// junit-evidence.mjs's attributeCondition replaces this entirely: an unreliable read is now this
// SPECIFIC attempt's own `{status:'integrity_error', reason}` evidence (never a pooled snapshot),
// and the whole-condition gradleJunitEvidenceUnreliable flag is scanned only across attempts
// actually classified as relevant Gradle invocations in THIS condition -- a kmp-test-only condition
// can no longer spuriously trip it (see the last test below, a direct regression proof that this old
// bug is fixed, not merely re-described).
describe('gradeScenarioCondition -- round-11: unreliable Gradle JUnit evidence (skip/anomaly) is a HARNESS-INTEGRITY signal, not a plain negative result', () => {
  it('EXACT REPRODUCTION: a Gradle attempt whose own evidence carries a skipped-testcase harness-integrity issue -- sets gradleJunitEvidenceUnreliable:true, and the outcome check still fails closed (never a false pass from a stale total/passed shape)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: { status: 'integrity_error', reason: 'skipped_testcase_unsupported' } }],
      SCENARIO_1_CORRECT_ANSWER,
      { unreliable: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(true);
  });

  it('EXACT REPRODUCTION (read-anomaly variant): a Gradle attempt whose own evidence carries an oversized/unreadable-XML issue -- also sets gradleJunitEvidenceUnreliable:true', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: { status: 'integrity_error', reason: 'junit_xml_read_anomaly' } }],
      SCENARIO_1_CORRECT_ANSWER,
      { unreliable: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(true);
  });

  it('regression guard: evidence entirely absent (never captured at all, the pre-existing "no evidence" case) does NOT trip gradleJunitEvidenceUnreliable -- that is a distinct, already-covered failure mode (captureIncomplete)', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(false);
  });

  it('regression guard: a genuinely clean evidence snapshot has gradleJunitEvidenceUnreliable:false', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 24, 0) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(false);
  });

  it('a kmp-test-only condition (no Gradle attempt at all) never trips gradleJunitEvidenceUnreliable -- fixed, not merely re-described, from the old pooled-snapshot behavior (see this describe block\'s own header comment)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // junit-evidence.mjs's attributeCondition only scans attempts it actually classified as
    // relevant Gradle invocations in THIS condition -- there are none here, so unreliable stays
    // false regardless of what an unrelated scenario/condition might have recorded.
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.gradleJunitEvidenceUnreliable).toBe(false);
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

describe('gradeScenarioCondition -- a wrong-module attempt whose decision sidecar was genuinely LOST (unverifiable, not denied) flags captureIncomplete, never silently undercounts', () => {
  // EXACT REPRODUCTION (a fresh review found the earlier wrong-module fix -- resolving an
  // unverifiable decision to explicit `null` instead of bare `undefined` -- was ITSELF still
  // fail-open): excluding the attempt from testInvocationsTotal/retries without ALSO raising
  // captureIncomplete silently UNDERcounts a real, executed attempt with zero trace anything went
  // wrong. This describe block proves gradeScenarioCondition's own consumption of the corrected
  // attributeCondition() output for the exact reproduction shape (a wrong-module attempt that
  // genuinely ran but whose decision the harness could not verify, immediately followed by a clean,
  // correctly-targeted attempt). attributeCondition's OWN production of captureIncomplete:true for
  // this shape has its own dedicated RED/GREEN-verified coverage in
  // agentic-eval-junit-evidence.test.js (the "(i)-(iv)" wrong-module tests) -- this block never
  // re-derives that, per this file's own established convention (see buildConditionResult's doc
  // comment) of accepting the three whole-condition flags as explicit options.
  it('a wrong-module attempt with an unverifiable (lost) decision sidecar, followed by a clean correctly-targeted pass, flags gradleJunitEvidenceCaptureIncomplete -- while success/expectedOutcomeMatched stay TRUE (a pure harness-capture problem, not an agent failure)', () => {
    const cr = buildConditionResult(
      [
        // decision:null models a genuinely UNVERIFIABLE sidecar (absent/incoherent/tombstoned/
        // command-mismatched -- attributeCondition resolves all four the same way). resultContent
        // is present (the attempt genuinely ran; this is not a --dry-run or an orphaned call).
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS, decision: null },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
      { captureIncomplete: true }, // what the FIXED attributeCondition now derives for this exact shape
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.gradleJunitEvidenceCaptureIncomplete).toBe(true);
    // The agent's own final answer and the correctly-targeted attempt's evidence are both genuinely
    // fine -- this is a harness capture-mechanism problem, decoupled from whether the agent did the
    // task correctly. gradleJunitEvidenceCaptureIncomplete is surfaced ALONGSIDE success, never
    // folded into it (matching gradleJunitEvidenceUnreliable/harnessEvidenceAmbiguous's own
    // established treatment).
    expect(grade.success).toBe(true);
    expect(grade.expectedOutcomeMatched).toBe(true);
    // The wrong-module attempt is correctly EXCLUDED (its decision is unverifiable, never phantom-
    // counted as executed) -- but that exclusion is no longer silent: captureIncomplete above is
    // the harness-integrity trace that a real attempt's outcome could not be verified.
    expect(grade.testInvocationsTotal).toBe(1);
  });

  // Closes the loop from graders.mjs's raw boolean to the actual, already-independently-proven
  // blocking mechanism: buildRunRecord (cli.mjs) turns gradleJunitEvidenceCaptureIncomplete:true
  // into a `junit_evidence_capture_incomplete` errors[] entry (generic propagation already covered
  // by agentic-eval-cli.test.js); scenarioCellIntegrityOk's junitCaptureCompleteOk check then fails
  // closed on that exact code (agentic-eval-hard-gates.test.js), which is what makes
  // scenarioHardGate/benchmark_eligible reject the cell (the real-subprocess suite in
  // agentic-eval-run-command.test.js exercises benchmark_eligible end-to-end). This test's own job
  // is only the first, fix-specific hop: proving THIS reproduction's real gradeScenarioCondition
  // output actually carries the code into a real record, not a synthetic fakeGradeResult.
  it('the SAME reproduction, carried through buildRunRecord, produces a real errors[] entry with code "junit_evidence_capture_incomplete" -- the exact signal scenarioCellIntegrityOk/benchmark_eligible already fail closed on', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test parallel --module-filter app --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS, decision: null },
        { command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS },
      ],
      SCENARIO_1_CORRECT_ANSWER,
      { captureIncomplete: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    const record = buildRunRecord({
      conditionResult: {
        ...cr,
        init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash'], mcp_servers: [], permissionMode: 'dontAsk' },
        invocation: null,
        hookStats: { hookCallCount: 2, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 2 },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: new Date('2026-01-01T00:00:01.000Z'),
      },
      condition: 'no-skill', runKind: 'scenario', scenarioId: SCENARIO_1.id,
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: SCENARIO_1.policy.allowed_gradle_tasks, allowedKmpTestSubcommands: SCENARIO_1.policy.allowed_kmptest_subcommands,
      policySha256: computePolicySha256(), modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: grade,
    });
    expect(record.errors.some((e) => e.code === 'junit_evidence_capture_incomplete')).toBe(true);
    // Sanity: the record's own success/expected_outcome_matched still reflect the genuinely correct
    // agent answer -- the blocking is carried entirely by errors[], never by these fields.
    expect(record.success.value).toBe(true);
    expect(record.expected_outcome_matched.value).toBe(true);
  });
});

describe('gradeScenarioCondition -- coverage_threshold_exceeded (SCENARIO_5, the 5th outcome_kind)', () => {
  it('accepts a well-formed condition -- single kmp_test attempt, terminal, success:true, all 8 checks pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.checks).toHaveLength(8);
    expect(grade.checks.every((c) => c.passed)).toBe(true);
  });

  it('rejects when the envelope threshold differs from the scenario expected constant (both command and envelope agree with each other, but not with the scenario)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 40 --json', resultContent: coverageEnvelope({ errors: [{ code: 'coverage_threshold_exceeded', message: 'x', threshold: 40, missed_lines: 45 }] }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('rejects when the invoked --min-missed-lines disagrees with the envelope\'s own echoed threshold (incoherent/stale tool_result)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: coverageEnvelope({ errors: [{ code: 'coverage_threshold_exceeded', message: 'x', threshold: 40, missed_lines: 45 }] }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('rejects when missed_lines differs from the expected constant', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: coverageEnvelope({
        coverage: { tool: 'auto', missed_lines: 30, modules_contributing: 1, modules_with_kover_plugin: [], modules_with_jacoco_plugin: ['core:domain'], module_buckets: { with_data: ['core:domain'], no_xml: [], parse_errored: [], skipped_by_user: [] } },
        errors: [{ code: 'coverage_threshold_exceeded', message: 'x', threshold: 15, missed_lines: 30 }],
      }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.success).toBe(false);
  });

  it('rejects the wrong module (a different --module-filter entirely)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:common --min-missed-lines 15 --json', resultContent: coverageEnvelope({ modules: [{ name: 'core:common', type: 'jvm', coverage_plugin: null }] }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // Finding P1-3 regression: an earlier revision of computeKmpTestTargetMatch special-cased
  // coverage_threshold_exceeded to tolerate envelope.modules.length > 1 (originally added to
  // accommodate :core:datastore's own substring-colliding sibling). That leniency was itself a
  // bug -- it never checked that every OTHER dispatched module was also filter-coherent, so an
  // adversarial extra module could ride along unnoticed. The fix removed the exception entirely;
  // this outcome now shares the exact same single-module exclusivity as every other outcome_kind.
  it('rejects a target match when the envelope contains more than one dispatched module, even when the extra module does not name-collide with the target (Finding P1-3)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: coverageEnvelope({
        tests: { total: 2, passed: 2, failed: 0, skipped: 0, individual_total: 8 },
        modules: [
          { name: 'core:domain', type: 'android', coverage_plugin: 'jacoco' },
          { name: 'core:model', type: 'jvm', coverage_plugin: null },
        ],
        parallel: {
          test_type: 'auto',
          legs: [{
            test_type: 'auto', exit_code: 0,
            execution: { fresh: 2, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
            cascade_detected: false, retry_fired: false,
          }],
          max_workers: 0, timeout_s: 600,
        },
      }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('rejects a self-contradictory envelope: with_data empty (no real coverage data) yet errors[] still claims coverage_threshold_exceeded', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: coverageEnvelope({
        coverage: { tool: 'auto', missed_lines: 23, modules_contributing: 0, modules_with_kover_plugin: [], modules_with_jacoco_plugin: ['core:domain'], module_buckets: { with_data: [], no_xml: ['core:domain'], parse_errored: [], skipped_by_user: [] } },
      }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.success).toBe(false);
  });

  it('rejects modules_contributing incoherent with with_data (with_data has the target, but modules_contributing:0)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: coverageEnvelope({
        coverage: { tool: 'auto', missed_lines: 23, modules_contributing: 0, modules_with_kover_plugin: [], modules_with_jacoco_plugin: ['core:domain'], module_buckets: { with_data: ['core:domain'], no_xml: [], parse_errored: [], skipped_by_user: [] } },
      }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.success).toBe(false);
  });

  it('rejects bucket-exclusivity violation: target module present in BOTH with_data and no_xml simultaneously', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: coverageEnvelope({
        coverage: { tool: 'auto', missed_lines: 23, modules_contributing: 1, modules_with_kover_plugin: [], modules_with_jacoco_plugin: ['core:domain'], module_buckets: { with_data: ['core:domain'], no_xml: ['core:domain'], parse_errored: [], skipped_by_user: [] } },
      }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.success).toBe(false);
  });

  it('rejects an incompatible extra error alongside coverage_threshold_exceeded (errors.length !== 1)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: coverageEnvelope({
        errors: [
          { code: 'coverage_threshold_exceeded', message: 'x', threshold: 15, missed_lines: 23 },
          { code: 'module_failed', module: 'core:domain', task: ':core:domain:testDemoDebugUnitTest', message: '[FAIL]' },
        ],
      }) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.success).toBe(false);
  });

  it('excludes a --dry-run attempt entirely -- never becomes a candidate, never terminal', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --dry-run --json', resultContent: coverageEnvelope() }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.testInvocationsTotal).toBe(0);
    expect(grade.terminalAuthoritativeEventIndex).toBe(null);
    expect(grade.success).toBe(false);
  });

  it('excludes a policy-denied attempt', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED, decision: 'deny' }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.testInvocationsTotal).toBe(0);
    expect(grade.success).toBe(false);
  });

  it('excludes an attempt whose decision record is missing/incoherent (null)', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED, decision: null }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.testInvocationsTotal).toBe(0);
    expect(grade.success).toBe(false);
  });

  describe('provider model -- Gradle corroborates, but is never terminal-eligible for this outcome_kind', () => {
    it('a Gradle-only condition (no kmp_test attempt at all) fails -- there is no terminal-eligible evidence, even though the Gradle attempt itself is clean and well-targeted', () => {
      const cr = buildConditionResult(
        [{ command: './gradlew.bat :core:domain:testDemoDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO5_PASS_STDOUT, evidence: okJunit(2, 2, 0) }],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.terminalAuthoritativeEventIndex).toBe(null);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('a genuinely correct kmp_test attempt followed by a clean, corroborating Gradle attempt AFTERWARD still succeeds -- the later Gradle attempt does not steal terminal selection', () => {
      const cr = buildConditionResult(
        [
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED },
          { command: './gradlew.bat :core:domain:testDemoDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO5_PASS_STDOUT, evidence: okJunit(2, 2, 0) },
        ],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.expectedOutcomeMatched).toBe(true);
      expect(grade.success).toBe(true);
      // terminal is the kmp_test attempt's own resultIndex (event index 2: init, tool_use, tool_result)
      expect(grade.terminalAuthoritativeEventIndex).toBe(2);
    });

    it('terminal selection within kmp_test: an early WRONG attempt followed by a later CORRECT one -- the later, correct attempt wins', () => {
      const wrongEnvelope = coverageEnvelope({ coverage: { tool: 'auto', missed_lines: 5, modules_contributing: 1, modules_with_kover_plugin: [], modules_with_jacoco_plugin: ['core:domain'], module_buckets: { with_data: ['core:domain'], no_xml: [], parse_errored: [], skipped_by_user: [] } }, errors: [{ code: 'coverage_threshold_exceeded', message: 'x', threshold: 15, missed_lines: 5 }] });
      // missed_lines:5 does not exceed threshold:15 in reality, but this fixture only needs to be a
      // real, well-formed, WRONG envelope for terminal-selection purposes (mismatched missed_lines).
      const cr = buildConditionResult(
        [
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: wrongEnvelope },
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED },
        ],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.success).toBe(true);
    });

    it('terminal selection within kmp_test: an early CORRECT attempt followed by a later WRONG one -- the later (wrong) attempt wins, flipping success to false; first_useful_signal and terminal are genuinely distinct', () => {
      const wrongEnvelope = coverageEnvelope({ coverage: { tool: 'auto', missed_lines: 5, modules_contributing: 1, modules_with_kover_plugin: [], modules_with_jacoco_plugin: ['core:domain'], module_buckets: { with_data: ['core:domain'], no_xml: [], parse_errored: [], skipped_by_user: [] } }, errors: [{ code: 'coverage_threshold_exceeded', message: 'x', threshold: 15, missed_lines: 5 }] });
      const cr = buildConditionResult(
        [
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED },
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: wrongEnvelope },
        ],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.success).toBe(false);
      expect(grade.firstUsefulSignalEventIndex).not.toBe(grade.terminalAuthoritativeEventIndex);
      expect(grade.firstUsefulSignalEventIndex).toBe(2); // the early, correct attempt's result event
      expect(grade.terminalAuthoritativeEventIndex).toBe(4); // the later, wrong attempt's result event
    });

    it('first_useful_signal respects the same terminal-eligibility restriction: a clean, correct Gradle attempt BEFORE any kmp_test attempt does not produce a first_useful_signal by itself', () => {
      const cr = buildConditionResult(
        [
          { command: './gradlew.bat :core:domain:testDemoDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO5_PASS_STDOUT, evidence: okJunit(2, 2, 0) },
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED },
        ],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      // event indices: init(0), gradle tool_use(1)/result(2), kmp_test tool_use(3)/result(4)
      expect(grade.firstUsefulSignalEventIndex).toBe(4);
      expect(grade.success).toBe(true);
    });

    it('a Gradle-only condition has first_useful_signal:null end to end (no kmp_test attempt ever exists)', () => {
      const cr = buildConditionResult(
        [{ command: './gradlew.bat :core:domain:testDemoDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO5_PASS_STDOUT, evidence: okJunit(2, 2, 0) }],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.firstUsefulSignalEventIndex).toBe(null);
    });

    it('check 7 (no_provider_contradiction) is a genuine, non-trivial comparison: kmp_test correct + a Gradle attempt whose OWN corroborating contract also genuinely matches -- no contradiction', () => {
      const cr = buildConditionResult(
        [
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED },
          { command: './gradlew.bat :core:domain:testDemoDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO5_PASS_STDOUT, evidence: okJunit(2, 2, 0) },
        ],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'no_provider_contradiction').passed).toBe(true);
    });

    it('check 7 detects a genuine disagreement: kmp_test correct + a Gradle attempt whose OWN JUnit evidence does not match expected.gradle.tests -- flagged, but stays diagnostic-only (does not block success)', () => {
      const cr = buildConditionResult(
        [
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED },
          { command: './gradlew.bat :core:domain:testDemoDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO5_PASS_STDOUT, evidence: okJunit(2, 1, 1) },
        ],
        SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'no_provider_contradiction').passed).toBe(false);
      expect(grade.success).toBe(true);
    });

    // A genuine same-turn JUnit-producer conflict on the GRADLE side must still be surfaced as
    // harnessEvidenceAmbiguous:true (so cmdRun/scenarioCellIntegrityOk can block the whole
    // matrix's promotion downstream) -- but for THIS outcome_kind specifically, it cannot by
    // itself flip `success`: Gradle is never terminal-eligible here (see the provider-model
    // decision above), so a conflicted Gradle attempt's own tainted evidence has no path to reach
    // the pass/fail verdict at all. A prior revision of this test used a Gradle-only condition
    // (no kmp_test attempt), which made `success:false` inevitable regardless of the ambiguity
    // flag (no terminal-eligible attempt exists either way) -- confounding the assertion with an
    // unrelated cause. This version isolates the real one: a genuinely correct, terminal kmp_test
    // attempt coexists with the conflicted Gradle attempt, proving harnessEvidenceAmbiguous is
    // surfaced independently of (never substituting for, never confused with) the verdict.
    it('a genuine same-turn JUnit-producer conflict on the Gradle side is surfaced as harnessEvidenceAmbiguous:true, but does not itself flip success when a correct kmp_test terminal attempt coexists (Gradle is never terminal-eligible for this outcome)', () => {
      const cr = buildConditionResult(
        [
          { command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED },
          { command: './gradlew.bat :core:domain:testDemoDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO5_PASS_STDOUT, resultIsError: false, evidence: { status: 'conflict' } },
        ],
        SCENARIO_5_CORRECT_ANSWER,
        { ambiguousJunitEvidence: true },
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.harnessEvidenceAmbiguous).toBe(true);
      expect(grade.success).toBe(true);
    });
  });

  describe('final-answer (check 8) -- closed KMP_EVAL_RESULT key set for this outcome_kind', () => {
    it('rejects a block missing missed_lines/threshold/modules_contributing (the tests_executed-shaped subset alone is insufficient for this outcome)', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
        kmpEvalResultText('Tests pass, coverage exceeded.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0 }),
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('rejects a block with an unrecognized extra key', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
        kmpEvalResultText('Tests pass, coverage exceeded.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1, extra_field: 'x' }),
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('rejects a final answer with no KMP_EVAL_RESULT block at all', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
        'The tests pass but coverage is too low.',
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('rejects two ambiguous KMP_EVAL_RESULT blocks in the same final answer', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
        SCENARIO_5_CORRECT_ANSWER + '\n' + SCENARIO_5_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    // Finding P1-2 regression: an earlier revision compared the final answer's total/passed/failed
    // against expected.gradle.tests (Gradle's separate corroborating JUnit count) instead of
    // kmp_test's own individual_total. An agent running only kmp_test can never legitimately
    // observe Gradle's count (junit-evidence.mjs only ever attaches JUnit evidence to Gradle
    // attempts, never to kmp_test attempts), so an honest agent reporting the ONLY total it could
    // actually have seen (4/4/0) would have been marked WRONG under the old comparison, while a
    // disconnected, unobservable 2/2/0 would have been marked CORRECT. This is now rejected.
    it("rejects a final answer using Gradle's corroborating count (2/2/0) instead of kmp_test's own individual_total (4/4/0) -- Finding P1-2", () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
        kmpEvalResultText('2 tests pass; 23 lines uncovered, exceeding the 15-line budget.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 2, passed: 2, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1 }),
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it("accepts missed_lines/threshold/modules_contributing matching the scenario exactly, with total/passed/failed matching kmp_test's own individual_total (the only count an honest kmp_test-only agent can actually observe)", () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
        kmpEvalResultText('4 tests pass; 23 lines uncovered, exceeding the 15-line budget.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1 }),
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_5);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
      expect(grade.success).toBe(true);
    });
  });

  it('module attribution reuses real matchModuleFilter semantics: a correct anchored-glob filter still resolves target match', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter "*:domain" --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_COVERAGE_EXCEEDED }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- changed-module-verification (SCENARIO_6, the 6th and final scenario)', () => {
  it('accepts a well-formed condition -- a single changed attempt, terminal, success:true, all 8 checks pass', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS }],
      SCENARIO_6_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_6);
    expect(grade.expectedOutcomeMatched).toBe(true);
    expect(grade.success).toBe(true);
    expect(grade.checks).toHaveLength(8);
    expect(grade.checks.every((c) => c.passed)).toBe(true);
    expect(grade.changedEvidenceMalformed).toBe(false);
  });

  describe('changed is the ONLY acceptable terminal proof -- parallel/Gradle never satisfy this scenario', () => {
    it('a `parallel` attempt with the EXACT SAME matching counts as the correct changed answer still fails -- never terminal-eligible', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test parallel --json --project-root .', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_PARALLEL_SAME_COUNTS }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.terminalAuthoritativeEventIndex).toBe(null);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('a Gradle-only condition (no changed attempt at all) fails -- Gradle can never be terminal for this scenario, even with a clean, well-targeted run', () => {
      const cr = buildConditionResult(
        [{ command: './gradlew.bat :core:common:test --console=plain', resultContent: GRADLE_SCENARIO6_PASS_STDOUT, evidence: okJunit(1, 1, 0) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.terminalAuthoritativeEventIndex).toBe(null);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('a genuinely correct changed attempt followed by a clean, corroborating Gradle attempt AFTERWARD still succeeds -- the later Gradle attempt does not steal terminal selection', () => {
      const cr = buildConditionResult(
        [
          { command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS },
          { command: './gradlew.bat :core:common:test --console=plain', resultContent: GRADLE_SCENARIO6_PASS_STDOUT, evidence: okJunit(1, 1, 0) },
        ],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.expectedOutcomeMatched).toBe(true);
      expect(grade.success).toBe(true);
      expect(grade.terminalAuthoritativeEventIndex).toBe(2); // the changed attempt's own resultIndex
    });

    it('a changed attempt coexisting with a `parallel` attempt (both policy-allowed) still succeeds via the changed attempt, ignoring parallel entirely for terminal selection', () => {
      const cr = buildConditionResult(
        [
          { command: 'kmp-test parallel --json --project-root .', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_PARALLEL_SAME_COUNTS },
          { command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS },
        ],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.success).toBe(true);
      expect(grade.terminalAuthoritativeEventIndex).toBe(4); // the changed attempt's own resultIndex
    });

    it('first_useful_signal respects the same terminal-eligibility restriction: a clean, correct Gradle attempt BEFORE any changed attempt does not produce a first_useful_signal by itself', () => {
      const cr = buildConditionResult(
        [
          { command: './gradlew.bat :core:common:test --console=plain', resultContent: GRADLE_SCENARIO6_PASS_STDOUT, evidence: okJunit(1, 1, 0) },
          { command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS },
        ],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      // event indices: init(0), gradle tool_use(1)/result(2), changed tool_use(3)/result(4)
      expect(grade.firstUsefulSignalEventIndex).toBe(4);
      expect(grade.success).toBe(true);
    });
  });

  describe('expected.changed block correctness (check 6 -- well-formed but WRONG values)', () => {
    it('rejects a changed envelope reporting an EXTRA detected module beyond the expected one', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: { detected_modules: ['core:common', 'core:domain'], staged_only: false, base_ref: 'HEAD' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
      expect(grade.changedEvidenceMalformed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('rejects a changed envelope reporting a DIFFERENT (wrong) single module', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: { detected_modules: ['core:domain'], staged_only: false, base_ref: 'HEAD' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      // computeKmpTestTargetMatch itself already fails target-matching here (envelope.modules[0]
      // would need to also disagree for the outcome_kind branch, but the changed{} block mismatch
      // alone must be caught by check 6, not silently pass because modules[] happens to agree).
      expect(grade.success).toBe(false);
    });

    it('rejects a changed envelope with staged_only:true when the scenario expects false', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: { detected_modules: ['core:common'], staged_only: true, base_ref: 'HEAD' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('rejects a changed envelope with a base_ref other than the expected "HEAD"', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: { detected_modules: ['core:common'], staged_only: false, base_ref: 'main' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('rejects a changed envelope missing detected_modules entirely (empty array)', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: { detected_modules: [], staged_only: false, base_ref: 'HEAD' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.success).toBe(false);
    });
  });

  describe('structurally malformed changed evidence fails as EVIDENCE INTEGRITY, never as a plain wrong answer (check 4, changedEvidenceMalformed)', () => {
    it('a changed block with detected_modules as a non-array (string) fails check 4, not check 6, and sets changedEvidenceMalformed:true', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: { detected_modules: 'core:common', staged_only: false, base_ref: 'HEAD' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.changedEvidenceMalformed).toBe(true);
      expect(grade.success).toBe(false);
    });

    it('a changed block with staged_only as a non-boolean (string "false") fails as evidence integrity', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: { detected_modules: ['core:common'], staged_only: 'false', base_ref: 'HEAD' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.changedEvidenceMalformed).toBe(true);
      expect(grade.success).toBe(false);
    });

    it('a changed block entirely absent from an otherwise-well-formed changed-subcommand envelope fails as evidence integrity', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({ changed: undefined }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.changedEvidenceMalformed).toBe(true);
      expect(grade.success).toBe(false);
    });

    // Critical finding this scenario's own design was built around: production never emits a
    // `changed` envelope carrying a `parallel` block too (ground truth confirmed this directly via
    // hasOwnProperty on 3 real runs). An envelope claiming both is proof of mismatched/incoherent
    // evidence -- e.g. a stale or wrongly-correlated tool_result -- and must fail as evidence
    // integrity, never as if it were simply a correct-looking answer.
    it('a well-formed, otherwise-CORRECT changed envelope that ALSO carries a `parallel` block fails as evidence integrity, not a plain pass', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({
          parallel: {
            test_type: 'auto',
            legs: [{ test_type: 'auto', exit_code: 0, execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 }, cascade_detected: false, retry_fired: false }],
            max_workers: 0, timeout_s: 600,
          },
        }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.changedEvidenceMalformed).toBe(true);
      expect(grade.success).toBe(false);
    });

    // Post-open-PR review finding: structural validity of changed{} must be judged independent of
    // whether the target module happens to match. An earlier draft gated changedEvidenceInvalid on
    // targetMatches, so a WRONG-module attempt short-circuited before the malformed-check ever ran
    // -- changedEvidenceMalformed came back false and authoritative_evidence_well_formed came back
    // true, silently promoting garbage evidence as an ordinary, trustworthy negative (wrong-target)
    // result. Both cases below combine a wrong target with each of the two distinct malformation
    // sources this check recognizes (see changedEvidenceInvalid's own doc comment).
    it('a WRONG-target attempt whose changed{} block is ALSO malformed (detected_modules as a non-array) still fails as EVIDENCE INTEGRITY, not a plain wrong-target negative', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({
          modules: [{ name: 'some-other-module', type: 'jvm' }], // WRONG target...
          changed: { detected_modules: 'core:common', staged_only: false, base_ref: 'HEAD' }, // ...AND malformed
        }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.changedEvidenceMalformed).toBe(true);
      expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('a WRONG-target attempt whose envelope ALSO carries a production-impossible parallel{} block still fails as EVIDENCE INTEGRITY, not a plain wrong-target negative', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: changedEnvelope({
          modules: [{ name: 'some-other-module', type: 'jvm' }], // WRONG target...
          parallel: { // ...AND an impossible parallel block alongside an otherwise well-formed changed{}
            test_type: 'auto',
            legs: [{ test_type: 'auto', exit_code: 0, execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 }, cascade_detected: false, retry_fired: false }],
            max_workers: 0, timeout_s: 600,
          },
        }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
      expect(grade.changedEvidenceMalformed).toBe(true);
      expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
      expect(grade.success).toBe(false);
    });
  });

  describe('--show-modules-only is fully inert -- never terminal, never retried, never a JUnit producer', () => {
    it('a --show-modules-only attempt alone never becomes terminal and never counts toward test_invocations_total', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --show-modules-only --json', resultContent: changedEnvelope({ tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 }, changed: { detected_modules: ['core:common'], staged_only: false, base_ref: 'HEAD' } }) }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.testInvocationsTotal).toBe(0);
      expect(grade.terminalAuthoritativeEventIndex).toBe(null);
      expect(grade.success).toBe(false);
    });

    it('a --show-modules-only attempt followed by a real, correct changed attempt still succeeds -- the preview call is invisible to retries/terminal selection', () => {
      const cr = buildConditionResult(
        [
          { command: 'kmp-test changed --show-modules-only --json', resultContent: changedEnvelope({ tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 } }) },
          { command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS },
        ],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.testInvocationsTotal).toBe(1);
      expect(grade.retries).toBe(0);
      expect(grade.success).toBe(true);
    });
  });

  describe('excluded attempts (policy/plan-only), mirroring the existing generic contract', () => {
    it('excludes a --dry-run changed attempt entirely -- never becomes a candidate, never terminal', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --dry-run --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.testInvocationsTotal).toBe(0);
      expect(grade.terminalAuthoritativeEventIndex).toBe(null);
      expect(grade.success).toBe(false);
    });

    it('excludes a policy-denied changed attempt', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS, decision: 'deny' }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.testInvocationsTotal).toBe(0);
      expect(grade.success).toBe(false);
    });
  });

  describe('final-answer (check 8) -- unchanged KMP_EVAL_RESULT shape for tests_executed', () => {
    it('rejects a final answer using Gradle\'s corroborating count when it happens to differ from what the agent could honestly report', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS }],
        kmpEvalResultText('Tests pass.', { module: ':core:common', outcome_kind: 'tests_executed', total: 2, passed: 2, failed: 0 }),
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
      expect(grade.success).toBe(false);
    });

    it('accepts the exact matching final answer', () => {
      const cr = buildConditionResult(
        [{ command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS }],
        SCENARIO_6_CORRECT_ANSWER,
      );
      const grade = gradeScenarioCondition(cr, SCENARIO_6);
      expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
      expect(grade.success).toBe(true);
    });
  });

  // Mirrors SCENARIO_5's own identical harnessEvidenceAmbiguous-is-diagnostic-only test -- the
  // conflict-DETECTION mechanism itself (which commands can even participate) has its own
  // dedicated coverage in agentic-eval-junit-evidence.test.js; this proves gradeScenarioCondition's
  // OWN consumption of an already-proven conflict is unaffected by which provider produced it.
  it('a genuine same-turn producer conflict is surfaced as harnessEvidenceAmbiguous:true without blocking a correct changed terminal attempt from succeeding', () => {
    const cr = buildConditionResult(
      [
        { command: 'kmp-test changed --json --project-root . --no-coverage', resultContent: KMP_TEST_ENVELOPE_SCENARIO6_CHANGED_PASS },
        { command: './gradlew.bat :core:common:test --console=plain', resultContent: GRADLE_SCENARIO6_PASS_STDOUT, resultIsError: false, evidence: { status: 'conflict' } },
      ],
      SCENARIO_6_CORRECT_ANSWER,
      { ambiguousJunitEvidence: true },
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_6);
    expect(grade.harnessEvidenceAmbiguous).toBe(true);
    expect(grade.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// final_answer_consistent_with_evidence bound to the terminal attempt's OWN observed facts, never
// scenario.expected -- prospective fix for the class of defect reproduced live in the accepted
// record `scenario-current-skill-88f37070` (coverage-threshold-failure / current-skill): a clean,
// gate-free terminal kmp-test attempt (authoritative_evidence_well_formed:true,
// authoritative_target_matches_expected:true, authoritative_outcome_matches_expected:false)
// combined with a final KMP_EVAL_RESULT block that simply repeated the SCENARIO's expected
// coverage-gate numbers -- graded final_answer_consistent_with_evidence:true, because the old
// comparator (kmpEvalResultBlockMatchesScenario) validated the block against scenario.expected
// directly, never against what the terminal attempt's own evidence actually showed. Historical
// records are not rewritten; this coverage is prospective for future runs under the fixed grader.
//
// The four checks stay independent: consistency with the evidence (this check) is orthogonal to
// whether that evidence was correct for the scenario (checks 5/6, expectedOutcomeMatched). An
// agent can honestly report a wrong-for-the-scenario result -- final-consistency:true,
// target/outcome-matches-expected:false, success:false.
// ---------------------------------------------------------------------------------------------
describe("gradeScenarioCondition -- final_answer_consistent_with_evidence is bound to the terminal attempt's own observed evidence, never scenario.expected", () => {
  // A genuinely clean :core:domain pass -- same module/individual_total as SCENARIO_5's own
  // ground truth, but no coverage_threshold_exceeded error at all (the gate never fired). Mirrors
  // KMP_TEST_ENVELOPE_SCENARIO1_PASS's real, well-formed shape with the module/counts substituted.
  const KMP_TEST_ENVELOPE_SCENARIO5_CLEAN_NO_COVERAGE_GATE = JSON.stringify({
    tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0',
    project_root: 'C:\\fake', exit_code: 0, duration_ms: 98214,
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 4 },
    modules: [{ name: 'core:domain', type: 'android', coverage_plugin: 'jacoco' }], skipped: [], coverage: {}, errors: [], warnings: [],
    parallel: {
      test_type: 'auto',
      legs: [{
        test_type: 'auto', exit_code: 0,
        execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
        cascade_detected: false, retry_fired: false,
      }],
      max_workers: 0, timeout_s: 600,
    },
    isolated: DEFAULT_ISOLATED_FIELD,
  });

  it("[case 1 / incident reproduction] coverage scenario, clean terminal with no coverage gate fired, final block repeats the SCENARIO's expected coverage-exceeded result -- must fail (this is the exact shape of the compromised record)", () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_CLEAN_NO_COVERAGE_GATE }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[case 2] same clean, gate-free terminal as case 1, but the final block honestly reports what actually happened (a clean tests_executed pass) -- must PASS final-consistency even though the scenario expected coverage_threshold_exceeded', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO5_CLEAN_NO_COVERAGE_GATE }],
      kmpEvalResultText('4 tests passed cleanly; no coverage gate fired.', { module: ':core:domain', outcome_kind: 'tests_executed', total: 4, passed: 4, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[case 3] terminal targets the WRONG module (scenario 1 expects :shared, agent ran :app) and the final block honestly reports :app's own real result -- must PASS final-consistency; target check and success still fail", () => {
    const otherModulePass = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 3 },
      modules: [{ name: 'app', type: 'android' }], skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: otherModulePass }],
      kmpEvalResultText('3/3 tests passed in the :app module.', { module: ':app', outcome_kind: 'tests_executed', total: 3, passed: 3, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[case 4] same wrong-module (:app) terminal as case 3, but the final block instead names the SCENARIO's expected module/counts (:shared, 24/24/0) -- must fail final-consistency (the block does not describe what this terminal attempt actually showed)", () => {
    const otherModulePass = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 3 },
      modules: [{ name: 'app', type: 'android' }], skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: otherModulePass }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[case 5] real observed individual_total (20) genuinely differs from the scenario's expected 24, final block honestly reports the observed 20/20/0 -- must PASS final-consistency; outcome check and success still fail", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.tests.individual_total = 20;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('20/20 tests passed.', { module: ':shared', outcome_kind: 'tests_executed', total: 20, passed: 20, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[case 6a] no terminal attempt at all (zero Bash tool_use) -- final-consistency must fail closed even though the block is well-formed and would exactly match the scenario', () => {
    const cr = buildConditionResult([], SCENARIO_1_CORRECT_ANSWER);
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[case 6b] terminal attempt produced content that does not parse as a valid kmp-test envelope -- final-consistency must fail closed even though the block is well-formed and would exactly match the scenario', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: 'not json at all, garbage stdout' }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(false);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[case 6c] terminal evidence passes every EXISTING well-formedness check, but its own test_failures detail is missing -- the real facts cannot be canonicalized without guessing, so final-consistency must fail closed even though the block exactly matches the scenario's expected counts", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    delete envelope.modules[0].test_failures;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[case 6d] a self-contradictory parallel.legs[] block (a leg claiming a clean exit_code:0 alongside execution.failed:999) on a WRONG-module attempt must not produce a canonicalizable observedResult, even though the pre-existing well-formedness gate does not independently catch this for an off-target attempt', () => {
    const incoherentEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 2, subcommand: 'parallel', version: '0.14.0', project_root: 'C:\\fake',
      exit_code: 0, duration_ms: 100, tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 3 },
      modules: [{ name: 'app', type: 'android' }], skipped: [], coverage: {}, errors: [], warnings: [],
      parallel: {
        test_type: 'auto',
        legs: [{
          test_type: 'auto', exit_code: 0,
          execution: { fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 999, no_evidence: 0 },
          cascade_detected: false, retry_fired: false,
        }],
        max_workers: 0, timeout_s: 600,
      },
      isolated: DEFAULT_ISOLATED_FIELD,
    });
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: incoherentEnvelope }],
      kmpEvalResultText('3/3 tests passed in the :app module.', { module: ':app', outcome_kind: 'tests_executed', total: 3, passed: 3, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    // The pre-existing well-formedness gate (check 4, parallelEvidenceInvalid) is intentionally
    // narrow -- it only ever re-validates parallel.legs[] coherence for an attempt whose module
    // already matches the scenario's own target (see that flag's own doc comment) -- so check 4
    // still reads true for this off-target attempt. deriveObservedKmpTestResult's own independent
    // re-validation (via validateParallelEvidence) is what must catch the incoherent leg here, not
    // check 4 -- the two are deliberately different questions.
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // --- positive coverage: the fix's own observed-derivation logic, exercised honestly, for every
  // outcome_kind x provider combination where the provider is terminal-eligible at all
  // (coverage_threshold_exceeded is kmp_test-only -- Gradle can never prove it, see
  // isTerminalEligibleAttempt; already covered by case 1/2 above) ---

  it('[kmp_test / tests_failed, positive] a genuinely smaller real failure count (2) than the scenario expects (3), honestly reported -- must PASS final-consistency; outcome check and success still fail', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.tests.individual_total = 2;
    envelope.modules[0].test_failures = envelope.modules[0].test_failures.slice(0, 2);
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('2 tests ran in the :lint module; both failed.', { module: ':lint', outcome_kind: 'tests_failed', total: 2, passed: 0, failed: 2 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[kmp_test / no_applicable_tests, positive] a genuinely different real --module-filter (:widgets, not the scenario's :app) with an honest matching block -- must PASS final-consistency; target check and success still fail", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS);
    envelope.errors[0].message = 'No modules found matching filter: widgets';
    envelope.skipped = [{ module: 'widgets', reason: 'no test source set' }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter widgets --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('The :widgets module has no applicable tests.', { module: ':widgets', outcome_kind: 'no_applicable_tests' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_target_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[gradle / tests_executed, positive] a genuinely different real JUnit count (20/20/0) than the scenario expects (24/24/0), honestly reported -- must PASS final-consistency; outcome check and success still fail', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(20, 20, 0) }],
      kmpEvalResultText('20/20 tests passed via Gradle.', { module: ':shared', outcome_kind: 'tests_executed', total: 20, passed: 20, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[gradle / tests_failed, positive] a genuinely different real JUnit result (3 ran, 1 passed, 2 failed) than the scenario expects (0 passed, 3 failed), honestly reported -- must PASS final-consistency; outcome check and success still fail', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO4_FAIL_STDOUT, resultIsError: true, evidence: okJunit(3, 1, 2) }],
      kmpEvalResultText('3 tests ran in :lint; 1 passed, 2 failed.', { module: ':lint', outcome_kind: 'tests_failed', total: 3, passed: 1, failed: 2 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'authoritative_outcome_matches_expected').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // --- post-review hardening round: canonicalization must fail closed on internally
  // contradictory evidence, not just on evidence the pre-existing checks 4/5/6 already flag.
  // Each case below constructs evidence that is well-formed enough to satisfy every EXISTING
  // check (case 4 in particular), yet is self-contradictory in a way only deriveObservedKmpTestResult/
  // deriveObservedGradleResult's own independent coherence checks catch. ---

  it("[hardening A] a module_failed error entry alongside envelope.tests.failed:0 is self-contradictory (the error claims the task failed, the aggregate counter claims it did not) -- must not produce a canonicalizable observedResult, even though the final block honestly echoes the real test_failures detail", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.tests.failed = 0;
    envelope.tests.passed = 1;
    envelope.parallel.legs[0].exit_code = 0;
    envelope.parallel.legs[0].execution.failed = 0;
    envelope.parallel.legs[0].execution.fresh = 1;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('3 tests ran in :lint; all 3 failed.', { module: ':lint', outcome_kind: 'tests_failed', total: 3, passed: 0, failed: 3 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening B] the envelope's own subcommand field disagreeing with the invoked command (a stale/mismatched tool_result -- e.g. the command said `parallel`, the envelope says `doctor`) must not produce a canonicalizable observedResult, even though the pre-existing well-formedness gate does not independently catch it", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.subcommand = 'doctor';
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening C] a genuinely clean run (no errors, tests.failed:0) reporting a nonzero exit_code contradicts itself (classifyExitCode says a clean, error-free run is always exit 0) -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.exit_code = 1;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening D] a no_test_modules claim (modules:[] + a filtered no_test_modules error) alongside nonzero tests counters and exit_code:0 is self-contradictory (a genuine "nothing resolved" claim can never carry nonzero counts, and classifyExitCode maps a filtered no_test_modules error to CONFIG_ERROR:2, never 0) -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS);
    envelope.tests = { total: 5, passed: 3, failed: 2, skipped: 0, individual_total: 5 };
    envelope.exit_code = 0;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('The :app module has no applicable tests.', { module: ':app', outcome_kind: 'no_applicable_tests' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening E] the invoked --min-missed-lines value (15) disagreeing with the envelope error's own echoed threshold (99) is self-contradictory -- must not produce a canonicalizable observedResult, even when the final block honestly echoes that same (wrong) threshold and the coverage block's own missed_lines/threshold otherwise agree with each other", () => {
    const envelope = JSON.parse(coverageEnvelope());
    envelope.errors[0].threshold = 99;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('4 tests pass; 23 lines uncovered, exceeding the 99-line budget.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 99, modules_contributing: 1 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening F] BUILD SUCCESSFUL contradicted by a real JUnit failure (failed>0) -- Gradle does not report a task successful while a test case genuinely failed -- must not produce a canonicalizable observedResult', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(3, 2, 1) }],
      kmpEvalResultText('3 tests ran; 2 passed, 1 failed.', { module: ':shared', outcome_kind: 'tests_executed', total: 3, passed: 2, failed: 1 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening G] a genuinely failed task (BUILD FAILED, the target task itself genuinely mentioned as FAILED) contradicted by zero real JUnit failures -- must not produce a canonicalizable observedResult', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: GRADLE_SCENARIO4_FAIL_STDOUT, resultIsError: true, evidence: okJunit(3, 3, 0) }],
      kmpEvalResultText('3 tests ran in :lint, all 3 passed.', { module: ':lint', outcome_kind: 'tests_failed', total: 3, passed: 3, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening H] a JUnit summary where passed+failed does not sum to total is internally incoherent -- must not produce a canonicalizable observedResult', () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :shared:testAndroidHostTest --console=plain', resultContent: GRADLE_SCENARIO1_PASS_STDOUT, evidence: okJunit(24, 20, 0) }],
      kmpEvalResultText('24 tests passed.', { module: ':shared', outcome_kind: 'tests_executed', total: 24, passed: 20, failed: 0 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening I] a NO-SOURCE task cannot coexist with genuinely resolved JUnit evidence (status:'ok') -- a real NO-SOURCE task never produces JUnit-XML output at all -- must not produce a canonicalizable observedResult", () => {
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: GRADLE_SCENARIO2_NO_SOURCE_VIA_DIRECT, evidence: okJunit(5, 5, 0) }],
      kmpEvalResultText('The :app module has no applicable tests.', { module: ':app', outcome_kind: 'no_applicable_tests' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // --- round-3 hardening: canonicalization must fail closed on evidence that is internally
  // contradictory in ways the round-2 hardening still missed -- retained per-test detail on an
  // otherwise-clean claim, a warning that documents the counts themselves may be incomplete,
  // task-level counters that don't even add up to themselves, a coverage claim whose own bucket
  // attribution points at a different module, an impossible modules_contributing value, a
  // tool_result flagged as an error alongside a claimed-clean envelope, a dry_run envelope paired
  // with a command that never asked for one, and a Gradle target simultaneously classified
  // NO-SOURCE and genuinely FAILED. ---

  it('[hardening J] a clean run (no errors) whose module entry STILL retains a non-empty test_failures array is self-contradictory -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.modules[0].test_failures = [{ test: 'some.Test.case', cause: 'AssertionError', type: null }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening K] a clean run carrying a junit_xml_oversized warning for the SAME module is self-contradictory -- the warning itself documents that individual_total may undercount and test_failures may be incomplete -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.warnings = [{ code: 'junit_xml_oversized', module: 'shared', task: ':shared:testAndroidHostTest', file: 'TEST-x.xml', size_bytes: 99999999, max_bytes: 10000000 }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening L] a target task classified BOTH no_source (the first status line encountered) AND genuinely FAILED (a later status line for the SAME task) is self-contradictory -- must not produce a canonicalizable observedResult, even though the pre-existing authoritative_outcome_matches_expected check (unchanged) doesn't independently catch it either", () => {
    const contradictoryStdout = '> Task :app:testDebugUnitTest NO-SOURCE\n> Task :app:testDebugUnitTest FAILED\n\nBUILD SUCCESSFUL in 3s\n1 actionable task: 1 executed\n';
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: contradictoryStdout }],
      kmpEvalResultText('The :app module has no applicable tests.', { module: ':app', outcome_kind: 'no_applicable_tests' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening M] task-level counters that do not even add up to themselves (total:1, passed:999, failed:0) are never trustworthy evidence for anything -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.tests.passed = 999;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening N] a coverage claim whose with_data bucket names a DIFFERENT module than the one actually observed is self-contradictory -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(coverageEnvelope());
    envelope.coverage.module_buckets.with_data = ['wrong:module'];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
  });

  it('[hardening O] a coverage claim reporting modules_contributing:2 when only ONE module was ever dispatched is self-contradictory -- must not produce a canonicalizable observedResult, even when the final block honestly echoes that same (wrong) count', () => {
    const envelope = JSON.parse(coverageEnvelope());
    envelope.coverage.modules_contributing = 2;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('4 tests pass; 23 lines uncovered across 2 contributing modules, exceeding the 15-line budget.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 2 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
  });

  it('[hardening P] a Bash tool_result flagged is_error:true alongside a clean envelope claiming exit_code:0 is self-contradictory -- must not produce a canonicalizable observedResult', () => {
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: KMP_TEST_ENVELOPE_SCENARIO1_PASS, resultIsError: true }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening Q] an envelope claiming dry_run:true, paired with a command that has no --dry-run/--list-only in its own text, cannot be trusted as real execution evidence -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.dry_run = true;
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // --- round-4 hardening: three closed full false positives (success:true, all 8 checks green)
  // plus a regression proving the oversized-XML guard now applies uniformly across ALL THREE
  // count-bearing kmp_test outcome shapes, not just tests_executed/coverage_threshold_exceeded. ---

  it('[hardening R] a clean run whose module entry carries a wrong-typed (non-array) test_failures value is neither a well-formed absence nor a well-formed empty list -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.modules[0].test_failures = 'malformed';
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening S] a coverage claim whose no_xml bucket names a module that was NEVER dispatched at all (only ONE module was ever in scope) is self-contradictory, even though with_data itself correctly names the observed module -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(coverageEnvelope());
    envelope.coverage.module_buckets.no_xml = ['other:module'];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_5_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
  });

  it('[hardening T] a target task classified BOTH no_source (the first status line encountered) AND genuinely FAILED (a later status line for the SAME task), with a real BUILD FAILED footer and JUnit evidence coherent with the failures, is self-contradictory -- must not produce a canonicalizable observedResult', () => {
    const contradictoryStdout = '> Task :lint:test NO-SOURCE\n> Task :lint:test FAILED\n\nFAILURE: Build failed with an exception.\n\nBUILD FAILED in 2s\n1 actionable task: 1 executed\n';
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: contradictoryStdout, resultIsError: true, evidence: okJunit(3, 0, 3) }],
      kmpEvalResultText('3 tests ran in :lint; all 3 failed.', { module: ':lint', outcome_kind: 'tests_failed', total: 3, passed: 0, failed: 3 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening U] a genuine module_failed claim carrying a junit_xml_oversized warning for the SAME module is self-contradictory -- the warning documents that individual_total/test_failures may be incomplete, which tests_failed must reject too, not just tests_executed/coverage_threshold_exceeded', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO4_FAIL);
    envelope.warnings = [{ code: 'junit_xml_oversized', module: 'lint', task: ':lint:test', file: 'TEST-x.xml', size_bytes: 99999999, max_bytes: 10000000 }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter lint --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_4_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // --- round-5 hardening: junit_xml_oversized now rejected universally (before any
  // modules.length branching, and never scoped to a single module name), and Gradle task-state
  // derivation now collects the target task's COMPLETE set of distinct status lines instead of
  // trusting classifyTaskExecutionMode's single first-match value. ---

  it('[hardening V] a no_applicable_tests claim (modules:[]) carrying ANY junit_xml_oversized warning is untrustworthy, even though there is no "observed module" to scope a match against -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO2_NO_TESTS);
    envelope.warnings = [{ code: 'junit_xml_oversized', module: 'somewhere', task: ':somewhere:test', file: 'TEST-x.xml', size_bytes: 99999999, max_bytes: 10000000 }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter app --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('The :app module has no applicable tests.', { module: ':app', outcome_kind: 'no_applicable_tests' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening W] a clean single-module run carrying a junit_xml_oversized warning attributed to a DIFFERENT module is untrustworthy -- with only one module ever dispatched, no other real module could legitimately appear in a warning at all -- must not produce a canonicalizable observedResult', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.warnings = [{ code: 'junit_xml_oversized', module: 'other', task: ':other:test', file: 'TEST-x.xml', size_bytes: 99999999, max_bytes: 10000000 }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening X] a target task classified FAILED (the first status line encountered) and later NO-SOURCE (a second, contradictory status line for the SAME task), with a real BUILD FAILED footer and JUnit evidence otherwise coherent with the failure, is self-contradictory -- must not produce a canonicalizable observedResult', () => {
    const contradictoryStdout = '> Task :lint:test FAILED\n> Task :lint:test NO-SOURCE\n\nFAILURE: Build failed with an exception.\n\nBUILD FAILED in 2s\n1 actionable task: 1 executed\n';
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :lint:test --console=plain', resultContent: contradictoryStdout, resultIsError: true, evidence: okJunit(3, 0, 3) }],
      kmpEvalResultText('3 tests ran in :lint; all 3 failed.', { module: ':lint', outcome_kind: 'tests_failed', total: 3, passed: 0, failed: 3 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_4);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening Y] a target task classified NO-SOURCE (the first status line encountered) and later UP-TO-DATE (a second, contradictory status line for the SAME task), with a real BUILD SUCCESSFUL footer, is self-contradictory -- must not produce a canonicalizable observedResult', () => {
    const contradictoryStdout = '> Task :app:testDebugUnitTest NO-SOURCE\n> Task :app:testDebugUnitTest UP-TO-DATE\n\nBUILD SUCCESSFUL in 1s\n1 actionable task: 1 executed\n';
    const cr = buildConditionResult(
      [{ command: './gradlew.bat :app:testDebugUnitTest --console=plain', resultContent: contradictoryStdout }],
      kmpEvalResultText('The :app module has no applicable tests.', { module: ':app', outcome_kind: 'no_applicable_tests' }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_2);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // --- round-6 post-CodeRabbit-audit hardening: a coverage claim's own bucket/count fields can
  // look perfectly self-consistent while the aggregation pipeline that PRODUCED them independently
  // reported it never completed; a module can be simultaneously (mis)reported executed AND skipped;
  // and a zero task-level total can still carry a nonzero individual_total. NOT every case below is
  // a full false positive: [hardening Z] and [hardening BB] were (pre-fix: success:true, all 8
  // checks green); [hardening DD] was narrower (check 6 already failed for the unrelated reason
  // that tests.total didn't match scenario.expected, so success was already false pre-fix -- but
  // check 8 kept asserting a consistency that didn't exist, the same defect class under a
  // different check); [hardening AA] and [hardening CC] are POSITIVE regression guards, proving
  // the new checks don't over-reject a legitimate shape -- they were never broken and pass both
  // pre- and post-fix by design, not something "closed here". ---

  const COVERAGE_INCOMPLETE_WARNING_REPRODUCTIONS = [
    'coverage_report_dispatch_failed',
    'coverage_aggregation_failed',
    'coverage_aggregation_skipped',
    'no_coverage_data',
    'coverage_xml_disabled',
    'coverage_xml_oversized',
    'coverage_parse_failed',
    'coverage_aggregation_drift',
  ];

  it.each(COVERAGE_INCOMPLETE_WARNING_REPRODUCTIONS)('[hardening Z] a coverage_threshold_exceeded claim alongside a %s warning is untrustworthy -- that warning documents coverage data as incomplete/skipped/unparsed/uncounted for this run, so missed_lines/modules_contributing cannot be trusted -- must not produce a canonicalizable observedResult', (code) => {
    const envelope = JSON.parse(coverageEnvelope());
    envelope.warnings = [{ code, message: `synthetic ${code}` }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('4 tests pass; 23 lines uncovered, exceeding the 15-line budget.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening AA] regression guard: a coverage_threshold_exceeded claim alongside a coverage_report_write_failed warning stays canonicalizable -- that warning's own producer documents only that the Markdown report FILE failed to write, never that the envelope's own coverage data is incomplete", () => {
    const envelope = JSON.parse(coverageEnvelope());
    envelope.warnings = [{ code: 'coverage_report_write_failed', message: 'failed to write coverage-report.md' }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json', resultContent: JSON.stringify(envelope) }],
      kmpEvalResultText('4 tests pass; 23 lines uncovered, exceeding the 15-line budget.', { module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded', total: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1 }),
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_5);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  it("[hardening BB] a module the envelope itself also lists as skipped cannot simultaneously be reported with real tests_executed evidence for a `changed` or single-leg `parallel` dispatch -- 'executed with real results' and 'skipped entirely' are mutually exclusive claims about the SAME module in the SAME attempt -- must not produce a canonicalizable observedResult", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.skipped = [{ module: 'shared', reason: 'no test source set' }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening CC] regression guard: a module genuinely executed by exactly ONE leg of a real multi-leg test_type:'all' dispatch, while the envelope's own top-level skipped[] names that same module for the OTHER (non-executing) legs -- each of which honestly shows all-zero execution buckets, since a single-module-filter dispatch can never have anything else in a non-executing leg's own taskList -- stays canonicalizable, including full end-to-end success against SCENARIO_1's own single-task expectation", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    const runningLeg = envelope.parallel.legs[0];
    const ZERO_EXECUTION = { fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 };
    envelope.parallel.test_type = 'all';
    envelope.parallel.legs = [
      { ...runningLeg, test_type: 'common' }, // the one leg that actually dispatches :shared -- fresh:1, unchanged from the base fixture
      { ...runningLeg, test_type: 'desktop', execution: { ...ZERO_EXECUTION } },
      { ...runningLeg, test_type: 'androidUnit', execution: { ...ZERO_EXECUTION } },
    ];
    // Only one leg ever dispatched a real task -- task-level total stays 1, exactly like the
    // real single-leg SCENARIO1_PASS fixture this is derived from (individual_total, the real
    // per-testcase count from that one task, is untouched).
    envelope.tests = { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 };
    // Real production would emit one skipped[] entry per non-executing leg (executeLeg's own
    // per-leg pickGradleTaskFor loop) -- both represented here, naming the same single module, with
    // the exact reason text pickGradleTaskFor's own desktop/androidUnit cases return
    // (`no ${testType} target` / `'no androidUnit target'`), wrapped by cascade-retry.js's
    // `${reason} (--test-type=${testType})` template.
    envelope.skipped = [
      { module: 'shared', reason: 'no desktop target (--test-type=desktop)' },
      { module: 'shared', reason: 'no androidUnit target (--test-type=androidUnit)' },
    ];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --test-type all --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(true);
    expect(grade.success).toBe(true);
  });

  it("[hardening EE] a genuine multi-leg test_type:'all' dispatch where EVERY leg shows POSITIVE real execution for the SAME single observed module, while that module ALSO appears in the envelope's own top-level skipped[], is impossible evidence -- no leg could plausibly be the source of the skip if all three genuinely dispatched a real task for the only module ever in scope -- must not produce a canonicalizable observedResult, even though the top-level cardinality (bucket-sum, per-leg exit/failed coherence) is otherwise internally consistent and checks 1-7 do not independently catch it", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    const leg = envelope.parallel.legs[0];
    envelope.parallel.test_type = 'all';
    envelope.parallel.legs = ['common', 'desktop', 'androidUnit'].map((t) => ({ ...leg, test_type: t }));
    envelope.tests = { total: 3, passed: 3, failed: 0, skipped: 0, individual_total: 24 };
    envelope.skipped = [{ module: 'shared', reason: 'not applicable to the androidUnit leg' }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --test-type all --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  // --- round-8 external audit: skipped[] entries were never structurally validated (a malformed
  // entry that names no module at all still silently poisoned nothing), and the multi-leg
  // correspondence only ever checked EXISTENCE of a plausible zero-execution leg -- never that the
  // COUNT of matching skipped[] entries equals the count of zero-execution legs. Both real
  // producers (partitionBySkipEnv, executeLeg's pickGradleTaskFor handling) unconditionally emit
  // exactly one well-formed {module, reason} entry per non-dispatching leg -- never zero, never
  // more than one -- so the two counts describe the same set of legs and must match exactly. ---

  const MALFORMED_SKIPPED_ENTRIES = [
    ['null', null],
    ['a bare string', 'other-module'],
    ['a bare number', 42],
    ['a nested array', ['other-module', 'no test source set']],
    ['module missing', { reason: 'no test source set' }],
    ['module an empty string', { module: '', reason: 'no test source set' }],
    ['reason missing (module names a DIFFERENT module)', { module: 'other-module' }],
    ['reason an empty string (module names a DIFFERENT module)', { module: 'other-module', reason: '' }],
  ];

  it.each(MALFORMED_SKIPPED_ENTRIES)('[hardening FF] a skipped[] array containing a malformed entry (%s) is untrustworthy evidence for the WHOLE array, even though that entry names no module the observed module could ever be confused with -- must not produce a canonicalizable observedResult', (_label, entry) => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.skipped = [entry];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening GG] two genuinely zero-execution legs (desktop, androidUnit) but only ONE matching skipped[] entry for the observed module is impossible -- both real producers unconditionally push a skipped[] entry for every leg that doesn't dispatch a task, so a real zero-execution leg missing its own entry is not real evidence -- must not produce a canonicalizable observedResult", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    const runningLeg = envelope.parallel.legs[0];
    const ZERO_EXECUTION = { fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 };
    envelope.parallel.test_type = 'all';
    envelope.parallel.legs = [
      { ...runningLeg, test_type: 'common' },
      { ...runningLeg, test_type: 'desktop', execution: { ...ZERO_EXECUTION } },
      { ...runningLeg, test_type: 'androidUnit', execution: { ...ZERO_EXECUTION } },
    ];
    envelope.tests = { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 };
    // Only ONE entry, even though TWO legs (desktop, androidUnit) genuinely show all-zero execution.
    envelope.skipped = [{ module: 'shared', reason: 'no desktop target (--test-type=desktop)' }];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --test-type all --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it("[hardening HH] two genuinely zero-execution legs (desktop, androidUnit) but THREE matching skipped[] entries for the observed module is impossible -- only two legs could ever have produced a skip for this module, so a third entry has no possible source leg -- must not produce a canonicalizable observedResult, even though the top-level cardinality (bucket-sum, per-leg exit/failed coherence) is otherwise internally consistent", () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    const runningLeg = envelope.parallel.legs[0];
    const ZERO_EXECUTION = { fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 };
    envelope.parallel.test_type = 'all';
    envelope.parallel.legs = [
      { ...runningLeg, test_type: 'common' },
      { ...runningLeg, test_type: 'desktop', execution: { ...ZERO_EXECUTION } },
      { ...runningLeg, test_type: 'androidUnit', execution: { ...ZERO_EXECUTION } },
    ];
    envelope.tests = { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 24 };
    // THREE entries, even though only TWO legs (desktop, androidUnit) genuinely show all-zero
    // execution -- the exact shape a bare existence (.some()) check could not distinguish from CC.
    envelope.skipped = [
      { module: 'shared', reason: 'no desktop target (--test-type=desktop)' },
      { module: 'shared', reason: 'no androidUnit target (--test-type=androidUnit)' },
      { module: 'shared', reason: 'no desktop target (--test-type=desktop)' },
    ];
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --test-type all --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'authoritative_evidence_well_formed').passed).toBe(true);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });

  it('[hardening DD] envelope.tests.total:0 (no task-level dispatch at all) alongside a nonzero individual_total:24 is self-contradictory -- zero dispatched tasks can never carry real individual test cases -- must not produce a canonicalizable observedResult, even when every execution bucket honestly stays zero too. Check 6 already catches this SPECIFIC fixture (tests.total:0 disagrees with scenario.expected) and already fails success for that unrelated reason -- the defect this proves is that check 8 kept asserting a consistency that did not exist regardless', () => {
    const envelope = JSON.parse(KMP_TEST_ENVELOPE_SCENARIO1_PASS);
    envelope.tests = { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 24 };
    envelope.parallel.legs[0].execution = { fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 };
    const cr = buildConditionResult(
      [{ command: 'kmp-test parallel --module-filter shared --json', resultContent: JSON.stringify(envelope) }],
      SCENARIO_1_CORRECT_ANSWER,
    );
    const grade = gradeScenarioCondition(cr, SCENARIO_1);
    expect(grade.checks.find((c) => c.name === 'final_answer_consistent_with_evidence').passed).toBe(false);
    expect(grade.success).toBe(false);
  });
});
