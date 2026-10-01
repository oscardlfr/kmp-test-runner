// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/graders-multi-module.mjs -- grading for the `multi-module-tests` scenario family
// (PLAN.md D4, D5). gradeScenarioCondition (graders.mjs) branches here after its three
// transcript-integrity checks; every other family never reaches this file.
//
// What differs from the other families, and why:
// - The answer is a set of Gradle modules, a set of test class simple names and a count of distinct
//   failing methods, so the agent's KMP_EVAL_RESULT block carries exactly four fields
//   (outcome_kind, failing_modules, failed_test_classes, failed_count) and is compared with the
//   scenario's ground truth directly, field by field.
// - There is no evidence binding (D5). A multi-module run spans dozens of Gradle tasks, so neither a
//   kmp-test envelope nor one JUnit result can stand for "the" authoritative evidence. The terminal
//   evidence checks, the first-useful-signal event and product_e2e_success are therefore reported as
//   not applicable, with the reason `multi_module_tests_family`, using the conventions the records
//   already have: a not-present terminal_evidence, a null-with-reason metric, a null verdict.
// - `success` is the answer matching the ground truth AND at least one test command having run, so a
//   correct guess without running anything never counts.
import { classifyBashCommand } from './command-classify.mjs';
import { extractKmpEvalResultBlock } from './graders.mjs';
import { LATEST_OUTCOME_ASSESSMENT_SCHEMA, MULTI_MODULE_TASK_FIELD_VALUES } from './outcome-assessment-contract.mjs';

export const MULTI_MODULE_NOT_APPLICABLE_REASON = 'multi_module_tests_family';

const ANSWER_OUTCOME_KINDS = ['tests_failed', 'tests_passed'];
const TEST_TASK_LAST_SEGMENT_RE = /^test[A-Za-z]*$/;

const gradlePath = (module) => (module.startsWith(':') ? module : `:${module}`);

function sameSet(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  return a.size === e.size && [...a].every((x) => e.has(x));
}

// An array of non-empty strings; the empty array is a legitimate answer for tests_passed.
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);

/** The status of each of the four answer fields against the scenario's ground truth:
 * `matched`, `mismatched` or `missing` (the key is absent). `failing_modules` is compared as a set
 * after prefixing a missing leading colon, `failed_test_classes` as a set with exact case,
 * `failed_count` and `outcome_kind` exactly. Pure; `answer` is the parsed block object. */
export function compareMultiModuleAnswer(answer, expected) {
  const has = (key) => Object.prototype.hasOwnProperty.call(answer, key);
  const status = {};
  status.outcome_kind = !has('outcome_kind') ? 'missing' : answer.outcome_kind === expected.outcome_kind ? 'matched' : 'mismatched';
  status.failing_modules = !has('failing_modules') ? 'missing'
    : isStringArray(answer.failing_modules) && sameSet(answer.failing_modules.map(gradlePath), expected.failing_modules) ? 'matched' : 'mismatched';
  status.failed_test_classes = !has('failed_test_classes') ? 'missing'
    : isStringArray(answer.failed_test_classes) && sameSet(answer.failed_test_classes, expected.failed_test_classes) ? 'matched' : 'mismatched';
  status.failed_count = !has('failed_count') ? 'missing' : Number.isInteger(answer.failed_count) && answer.failed_count === expected.failed_count ? 'matched' : 'mismatched';
  const ordered = (wanted) => MULTI_MODULE_TASK_FIELD_VALUES.filter((f) => status[f] === wanted);
  return {
    status,
    missingFields: ordered('missing'),
    mismatchFields: ordered('mismatched'),
    unexpectedKeyCount: Object.keys(answer).filter((k) => !MULTI_MODULE_TASK_FIELD_VALUES.includes(k)).length,
    matched: MULTI_MODULE_TASK_FIELD_VALUES.every((f) => status[f] === 'matched'),
  };
}

/** Whether a parsed block is well-formed as an ANSWER, independent of whether it is right: exactly the
 * four keys, a recognized outcome_kind, two arrays of non-empty strings and a non-negative integer. */
function isAnswerWellFormed(answer) {
  if (answer == null || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const keys = Object.keys(answer);
  if (keys.length !== MULTI_MODULE_TASK_FIELD_VALUES.length || !MULTI_MODULE_TASK_FIELD_VALUES.every((k) => keys.includes(k))) return false;
  return ANSWER_OUTCOME_KINDS.includes(answer.outcome_kind)
    && isStringArray(answer.failing_modules)
    && isStringArray(answer.failed_test_classes)
    && Number.isInteger(answer.failed_count) && answer.failed_count >= 0;
}

/** The answer-side result of grading one final text against the scenario: the outcome-assessment
 * facts (task_outcome_*, answer_protocol_matched) and the final_answer_block diagnostic the audit
 * sidecar records. Never reads anything but the final text and scenario.expected. */
export function evaluateMultiModuleAnswer(finalText, scenario) {
  const text = typeof finalText === 'string' ? finalText : '';
  const block = extractKmpEvalResultBlock(text);
  const diagnostic = {
    found: block.found,
    parsed: block.found && !block.ambiguous ? block.parsed != null : false,
    ambiguous: block.ambiguous,
    matches_observed: null,
    comparison_status: text.length === 0 ? 'no-final-text'
      : !block.found ? 'missing-block'
        : block.ambiguous ? 'ambiguous-block'
          : block.parsed == null ? 'invalid-json' : 'no-observed-result',
    declared_outcome_kind: null,
    observed_outcome_kind: null,
    missing_fields: [],
    mismatch_fields: [],
    unexpected_key_count: 0,
  };
  const unavailable = (reason, protocolMatched) => ({
    matched: null, reason, protocolMatched, mismatchFields: null, unexpectedKeyCount: null, diagnostic,
  });
  if (!block.found) return unavailable('claim-missing', false);
  if (block.ambiguous || block.parsed == null) return unavailable('claim-malformed', false);

  const answer = block.parsed;
  if (typeof answer.outcome_kind === 'string') {
    diagnostic.declared_outcome_kind = ANSWER_OUTCOME_KINDS.includes(answer.outcome_kind) ? answer.outcome_kind : 'unrecognized';
  }
  const expected = scenario?.expected;
  const groundTruthAvailable = expected != null && ANSWER_OUTCOME_KINDS.includes(expected.outcome_kind)
    && Array.isArray(expected.failing_modules) && Array.isArray(expected.failed_test_classes) && Number.isInteger(expected.failed_count);
  const comparison = groundTruthAvailable ? compareMultiModuleAnswer(answer, expected) : null;
  if (comparison != null) {
    diagnostic.missing_fields = comparison.missingFields;
    diagnostic.mismatch_fields = comparison.mismatchFields;
    diagnostic.unexpected_key_count = comparison.unexpectedKeyCount;
  }
  if (!isAnswerWellFormed(answer)) return unavailable('claim-malformed', false);
  if (comparison == null) return unavailable('ground-truth-unavailable', true);
  return {
    matched: comparison.matched,
    reason: comparison.matched ? 'matched' : 'mismatched',
    protocolMatched: true,
    mismatchFields: comparison.mismatchFields,
    unexpectedKeyCount: comparison.unexpectedKeyCount,
    diagnostic,
  };
}

/** True for a shell command that runs tests (PLAN.md D5): kmp-test `parallel` or `changed`, or a
 * Gradle task whose last path segment is `test` or starts with `test` (letters only), in either case
 * unless it is plan-only (--dry-run and the like). */
export function isMultiModuleTestCommand(classification) {
  if (classification == null || classification.isPlanOnly === true) return false;
  if (classification.kind === 'kmp-test') return classification.subcommand === 'parallel' || classification.subcommand === 'changed';
  if (classification.kind === 'gradle') {
    return classification.taskTokens.some((task) => TEST_TASK_LAST_SEGMENT_RE.test(task.split(':').pop()));
  }
  return false;
}

const notApplicableDetail = (what) => `not applicable (${MULTI_MODULE_NOT_APPLICABLE_REASON}): ${what}`;

/**
 * Grades one multi-module-tests condition. Called by gradeScenarioCondition once its first three
 * checks (transcript integrity, a policy-allowed command attempted, every tool result correlated) are
 * in `checks`; appends the other five and returns the same result shape as every other family.
 */
export function gradeMultiModuleScenario({ scenario, observation, bashResults, checks, junitAttribution }) {
  const addCheck = (name, passed, detail) => checks.push({ name, passed, detail, evidence_event_indices: [] });

  // A test command "ran" when the hook did not deny it (a null decision means the mechanism was on but
  // the decision record is missing: not provable, so excluded; undefined means no mechanism at all).
  const testCommandAttempts = bashResults.filter((b) => {
    const decision = junitAttribution.decisionByAttempt.get(b.id);
    if (decision === 'deny' || decision === null) return false;
    return isMultiModuleTestCommand(classifyBashCommand(b.command));
  });
  const testCommandRan = testCommandAttempts.length > 0;

  const answer = evaluateMultiModuleAnswer(observation.terminal.finalText, scenario);
  const keyFactsMatched = answer.matched === true;

  addCheck('authoritative_evidence_well_formed', false, notApplicableDetail('this family grades the final answer; there is no authoritative terminal tool evidence'));
  addCheck('authoritative_target_matches_expected', false, notApplicableDetail('no single target module or terminal attempt exists to match'));
  addCheck('authoritative_outcome_matches_expected', false, notApplicableDetail('the answer is compared with the ground truth directly (see outcome_assessment)'));
  addCheck('no_provider_contradiction', true, notApplicableDetail('no provider evidence is bound to the answer, so nothing can contradict'));
  addCheck('final_answer_consistent_with_evidence', false, notApplicableDetail('the answer is not compared with tool evidence'));

  const taskOutcomeProvider = answer.reason === 'claim-missing'
    ? { kind: 'none', status: 'unavailable' }
    : { kind: 'claim-only', status: 'unavailable' };

  return {
    expectedOutcomeMatched: keyFactsMatched,
    success: keyFactsMatched && testCommandRan,
    checks,
    firstUsefulSignalEventIndex: null,
    terminalAuthoritativeEventIndex: null,
    testInvocationsTotal: testCommandAttempts.length,
    retries: Math.max(0, testCommandAttempts.length - 1),
    harnessEvidenceAmbiguous: junitAttribution.ambiguousJunitEvidence,
    parallelEvidenceMalformed: false,
    changedEvidenceMalformed: false,
    gradleJunitEvidenceCaptureIncomplete: junitAttribution.captureIncomplete,
    gradleJunitEvidenceUnreliable: junitAttribution.unreliable,
    // The not-applicable reason that buildRunRecord writes next to the null first_useful_signal_ms.
    notApplicableReason: MULTI_MODULE_NOT_APPLICABLE_REASON,
    terminalEvidence: {
      present: false,
      provider: null,
      tool_result_event_index: null,
      evidence_well_formed: false,
      target_matches_expected: null,
      outcome_matches_expected: null,
      malformed: null,
      parallel_evidence_invalid: null,
      changed_evidence_invalid: null,
      observed_result: null,
      final_answer_block: answer.diagnostic,
      coverage_gate_diagnostic: 'not-applicable',
      coverage_gate_attempts: [],
    },
    outcomeAssessment: {
      schema: LATEST_OUTCOME_ASSESSMENT_SCHEMA,
      task_outcome_matched: answer.matched,
      task_outcome_reason: answer.reason,
      answer_protocol_matched: answer.protocolMatched,
      provider_evidence_kind: taskOutcomeProvider.kind,
      provider_evidence_status: taskOutcomeProvider.status,
      product_e2e_success: null,
      task_outcome_mismatch_fields: answer.mismatchFields,
      task_outcome_unexpected_key_count: answer.unexpectedKeyCount,
    },
  };
}
