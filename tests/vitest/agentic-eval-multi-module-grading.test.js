// tests/vitest/agentic-eval-multi-module-grading.test.js
// Grading of the `multi-module-tests` family (graders-multi-module.mjs, reached through
// gradeScenarioCondition): the four-field answer compared with the ground truth, `success` needing at
// least one test command, and the evidence-binding results reported as not applicable.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeScenarioCondition, GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { compareMultiModuleAnswer, isMultiModuleTestCommand, MULTI_MODULE_NOT_APPLICABLE_REASON } from '../../tools/agentic-eval/graders-multi-module.mjs';
import { classifyBashCommand } from '../../tools/agentic-eval/command-classify.mjs';
import { buildTaskFieldCorrectness } from '../../tools/agentic-eval/analysis.mjs';
import { MULTI_MODULE_TASK_FIELD_VALUES, TASK_OUTCOME_MISMATCH_FIELD_VALUES } from '../../tools/agentic-eval/outcome-assessment-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, '..', 'fixtures', 'agentic-eval-multi-module');
const task = JSON.parse(readFileSync(path.join(fixtureDir, 'scenario-draft.json'), 'utf8'));
const truth = JSON.parse(readFileSync(path.join(fixtureDir, 'expected-draft.json'), 'utf8'));
const SCENARIO = Object.freeze({
  ...task,
  expected_outcome: truth.expected_outcome,
  expected: truth.expected,
  smoke: truth.smoke,
  first_useful_signal_predicate: truth.first_useful_signal_predicate,
});
const EXPECTED = SCENARIO.expected;
const GOOD_ANSWER = Object.freeze({
  outcome_kind: EXPECTED.outcome_kind,
  failing_modules: EXPECTED.failing_modules,
  failed_test_classes: EXPECTED.failed_test_classes,
  failed_count: EXPECTED.failed_count,
});

const TEST_STEP = { command: './gradlew :core:data:testDemoDebugUnitTest --continue', resultContent: 'BUILD FAILED', resultIsError: true };

function baseObservation(overrides = {}) {
  return {
    schema: 1,
    runtime: { id: 'claude-code', protocolVersion: 1 },
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
    session: { initPresent: true, modelResolved: 'claude-sonnet-5', sessionIdObserved: 'sess-1', runtimeVersion: '2.1.238', toolProfileMatchesExpected: true, modelSnapshot: null },
    transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    terminal: { present: true, isError: false, turnCount: 1, finalText: '', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
    toolAttempts: [],
    skill: {
      available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
      targetInvocation: null, foreignInvocations: [],
      ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
    },
    hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
    byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
    timing: { receiptNsByEventIndex: new Map() },
    ...overrides,
  };
}

/** A condition result: each step is {command, resultContent, resultIsError, decision}; `decision` defaults to 'allow'. */
function conditionResult(steps, finalText, { condition = 'current-skill' } = {}) {
  const toolAttempts = [];
  const decisionByAttempt = new Map();
  let eventIndex = 1;
  for (const step of steps) {
    const id = `t${toolAttempts.length + 1}`;
    const attemptIndex = eventIndex++;
    const resultIndex = eventIndex++;
    toolAttempts.push({
      id, kind: 'shell', runtimeName: 'Bash', eventIndex: attemptIndex, receiptNs: BigInt(attemptIndex),
      profileAllowed: true, command: step.command, skillReference: null, targetsExpectedSkill: null,
      result: { found: true, eventIndex: resultIndex, isError: step.resultIsError ?? false, text: step.resultContent ?? '', textStatus: 'text' },
      preDispatchBlock: { recognized: false, signature: null },
    });
    decisionByAttempt.set(id, step.decision === undefined ? 'allow' : step.decision);
  }
  return {
    condition,
    observation: baseObservation({
      terminal: { present: true, isError: false, turnCount: 1, finalText, resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      toolAttempts,
    }),
    junitAttribution: { perAttemptJunit: new Map(), decisionByAttempt, ambiguousJunitEvidence: false, captureIncomplete: false, unreliable: false },
  };
}

const answerText = (block, prose = 'Three modules fail.') => `${prose}\n\nKMP_EVAL_RESULT\n${JSON.stringify(block)}\nKMP_EVAL_RESULT_END\n`;
const grade = (steps, text, opts, scenario = SCENARIO) => gradeScenarioCondition(conditionResult(steps, text, opts), scenario);

describe('compareMultiModuleAnswer', () => {
  it('reports every field matched for the ground truth itself', () => {
    const result = compareMultiModuleAnswer({ ...GOOD_ANSWER }, EXPECTED);
    expect(result.matched).toBe(true);
    expect(result.status).toEqual({ outcome_kind: 'matched', failing_modules: 'matched', failed_test_classes: 'matched', failed_count: 'matched' });
  });

  it('flags each field alone when it is the only one that differs', () => {
    const variants = {
      outcome_kind: { ...GOOD_ANSWER, outcome_kind: 'tests_passed' },
      failing_modules: { ...GOOD_ANSWER, failing_modules: EXPECTED.failing_modules.slice(1) },
      failed_test_classes: { ...GOOD_ANSWER, failed_test_classes: [...EXPECTED.failed_test_classes.slice(1), 'OtherTest'] },
      failed_count: { ...GOOD_ANSWER, failed_count: EXPECTED.failed_count + 1 },
    };
    for (const [field, answer] of Object.entries(variants)) {
      const result = compareMultiModuleAnswer(answer, EXPECTED);
      expect(result.matched, field).toBe(false);
      expect(result.mismatchFields, field).toEqual([field]);
    }
  });

  it('ignores the order of the two sets', () => {
    const result = compareMultiModuleAnswer({
      ...GOOD_ANSWER,
      failing_modules: [...EXPECTED.failing_modules].reverse(),
      failed_test_classes: [...EXPECTED.failed_test_classes].reverse(),
    }, EXPECTED);
    expect(result.matched).toBe(true);
  });

  it('treats core:data and :core:data as the same module', () => {
    const result = compareMultiModuleAnswer({ ...GOOD_ANSWER, failing_modules: EXPECTED.failing_modules.map((m) => m.replace(/^:/, '')) }, EXPECTED);
    expect(result.matched).toBe(true);
  });

  it('compares test class names with exact case', () => {
    const lowered = EXPECTED.failed_test_classes.map((c) => c.toLowerCase());
    expect(compareMultiModuleAnswer({ ...GOOD_ANSWER, failed_test_classes: lowered }, EXPECTED).mismatchFields).toEqual(['failed_test_classes']);
  });

  it('compares the failed count as an integer, not a string', () => {
    expect(compareMultiModuleAnswer({ ...GOOD_ANSWER, failed_count: String(EXPECTED.failed_count) }, EXPECTED).mismatchFields).toEqual(['failed_count']);
  });

  it('reports a key that is absent as missing, not mismatched', () => {
    const { failed_count: _omitted, ...withoutCount } = GOOD_ANSWER;
    const result = compareMultiModuleAnswer(withoutCount, EXPECTED);
    expect(result.missingFields).toEqual(['failed_count']);
    expect(result.mismatchFields).toEqual([]);
    expect(result.matched).toBe(false);
  });

  it('counts the keys of the answer that are not part of the contract', () => {
    expect(compareMultiModuleAnswer({ ...GOOD_ANSWER, note: 'x', other: 1 }, EXPECTED).unexpectedKeyCount).toBe(2);
  });
});

describe('gradeScenarioCondition -- multi-module-tests answers', () => {
  it('matches the ground truth: key facts true, outcome assessment matched', () => {
    const result = grade([TEST_STEP], answerText(GOOD_ANSWER));
    expect(result.expectedOutcomeMatched).toBe(true);
    expect(result.outcomeAssessment).toMatchObject({
      task_outcome_matched: true, task_outcome_reason: 'matched', answer_protocol_matched: true,
      task_outcome_mismatch_fields: [], task_outcome_unexpected_key_count: 0,
    });
  });

  it('is false for each field that differs alone, and names that field', () => {
    const variants = {
      outcome_kind: { ...GOOD_ANSWER, outcome_kind: 'tests_passed' },
      failing_modules: { ...GOOD_ANSWER, failing_modules: [':core:data'] },
      failed_test_classes: { ...GOOD_ANSWER, failed_test_classes: ['AFooTest', 'BFooTest', 'CFooTest'] },
      failed_count: { ...GOOD_ANSWER, failed_count: 5 },
    };
    for (const [field, answer] of Object.entries(variants)) {
      const result = grade([TEST_STEP], answerText(answer));
      expect(result.expectedOutcomeMatched, field).toBe(false);
      expect(result.success, field).toBe(false);
      expect(result.outcomeAssessment.task_outcome_reason, field).toBe('mismatched');
      expect(result.outcomeAssessment.task_outcome_mismatch_fields, field).toEqual([field]);
    }
  });

  it('keeps the meaning of a missing block', () => {
    const result = grade([TEST_STEP], 'The tests fail in three modules.');
    expect(result.outcomeAssessment).toMatchObject({
      task_outcome_matched: null, task_outcome_reason: 'claim-missing', answer_protocol_matched: false,
      provider_evidence_kind: 'none', provider_evidence_status: 'unavailable',
      task_outcome_mismatch_fields: null, task_outcome_unexpected_key_count: null,
    });
    expect(result.terminalEvidence.final_answer_block).toMatchObject({ found: false, comparison_status: 'missing-block' });
  });

  it('keeps the meaning of two blocks (ambiguous) and of a block that is not JSON (unparsed)', () => {
    const two = `${answerText(GOOD_ANSWER)}\n${answerText(GOOD_ANSWER)}`;
    expect(grade([TEST_STEP], two).outcomeAssessment).toMatchObject({ task_outcome_reason: 'claim-malformed', task_outcome_matched: null });
    expect(grade([TEST_STEP], two).terminalEvidence.final_answer_block.comparison_status).toBe('ambiguous-block');
    const broken = 'text\n\nKMP_EVAL_RESULT\n{not json\nKMP_EVAL_RESULT_END\n';
    expect(grade([TEST_STEP], broken).outcomeAssessment.task_outcome_reason).toBe('claim-malformed');
    expect(grade([TEST_STEP], broken).terminalEvidence.final_answer_block.comparison_status).toBe('invalid-json');
  });

  it('treats an answer with a missing, extra, unrecognized or mistyped field as malformed', () => {
    const { failed_count: _omitted, ...withoutCount } = GOOD_ANSWER;
    for (const [label, answer] of Object.entries({
      missing: withoutCount,
      extra: { ...GOOD_ANSWER, note: 'x' },
      unrecognized_kind: { ...GOOD_ANSWER, outcome_kind: 'tests_executed' },
      mistyped_count: { ...GOOD_ANSWER, failed_count: '6' },
      mistyped_modules: { ...GOOD_ANSWER, failing_modules: ':core:data' },
    })) {
      const result = grade([TEST_STEP], answerText(answer));
      expect(result.outcomeAssessment.task_outcome_reason, label).toBe('claim-malformed');
      expect(result.outcomeAssessment.answer_protocol_matched, label).toBe(false);
      expect(result.expectedOutcomeMatched, label).toBe(false);
    }
  });

  it('records what the answer declared and which fields it lacks, for the audit', () => {
    const { failed_count: _omitted, ...withoutCount } = GOOD_ANSWER;
    const block = grade([TEST_STEP], answerText(withoutCount)).terminalEvidence.final_answer_block;
    expect(block).toMatchObject({ found: true, parsed: true, declared_outcome_kind: 'tests_failed', missing_fields: ['failed_count'], mismatch_fields: [] });
    const unrecognized = grade([TEST_STEP], answerText({ ...GOOD_ANSWER, outcome_kind: 'tests_executed' })).terminalEvidence.final_answer_block;
    expect(unrecognized.declared_outcome_kind).toBe('unrecognized');
  });

  it('grades a tests_passed scenario: empty sets and a zero count match', () => {
    const passed = { ...SCENARIO, expected: { outcome_kind: 'tests_passed', failing_modules: [], failed_test_classes: [], failed_count: 0 } };
    const answer = { outcome_kind: 'tests_passed', failing_modules: [], failed_test_classes: [], failed_count: 0 };
    const result = grade([TEST_STEP], answerText(answer), undefined, passed);
    expect(result.outcomeAssessment).toMatchObject({ task_outcome_matched: true, task_outcome_reason: 'matched', answer_protocol_matched: true });
    expect(result.success).toBe(true);
  });
});

describe('gradeScenarioCondition -- multi-module-tests success', () => {
  it('is false when the key facts match but no test command ran', () => {
    const result = grade([], answerText(GOOD_ANSWER));
    expect(result.expectedOutcomeMatched).toBe(true);
    expect(result.success).toBe(false);
    expect(result.testInvocationsTotal).toBe(0);
  });

  it('is true when a Gradle test task ran', () => {
    expect(grade([TEST_STEP], answerText(GOOD_ANSWER)).success).toBe(true);
  });

  it('is true when kmp-test parallel ran', () => {
    const result = grade([{ command: 'kmp-test parallel --flavor demo --json', resultContent: '{}', resultIsError: true }], answerText(GOOD_ANSWER));
    expect(result.success).toBe(true);
  });

  it('is true when kmp-test changed ran', () => {
    expect(grade([{ command: 'kmp-test changed --json', resultContent: '{}' }], answerText(GOOD_ANSWER)).success).toBe(true);
  });

  it('is false when the only command was not a test command', () => {
    for (const command of [
      'kmp-test parallel --dry-run --json', 'kmp-test doctor', 'kmp-test describe --json',
      './gradlew :core:data:tasks', './gradlew build', './gradlew :core:data:test --dry-run', 'ls -la',
    ]) {
      expect(grade([{ command, resultContent: 'ok' }], answerText(GOOD_ANSWER)).success, command).toBe(false);
    }
  });

  it('is false when the only test command was denied by the policy hook, or its decision is missing', () => {
    expect(grade([{ ...TEST_STEP, decision: 'deny' }], answerText(GOOD_ANSWER)).success).toBe(false);
    expect(grade([{ ...TEST_STEP, decision: null }], answerText(GOOD_ANSWER)).success).toBe(false);
  });

  it('counts a command when the hook mechanism is off (no decision recorded at all)', () => {
    const result = conditionResult([TEST_STEP], answerText(GOOD_ANSWER));
    result.junitAttribution.decisionByAttempt.clear();
    expect(gradeScenarioCondition(result, SCENARIO).success).toBe(true);
  });

  it('counts the test commands of both providers and derives retries from them', () => {
    const result = grade([
      { command: 'kmp-test parallel --json', resultContent: '{}' },
      { command: './gradlew :lint:test', resultContent: 'BUILD SUCCESSFUL' },
      { command: './gradlew :core:common:test', resultContent: 'BUILD SUCCESSFUL' },
      { command: 'ls', resultContent: '' },
    ], answerText(GOOD_ANSWER));
    expect(result.testInvocationsTotal).toBe(3);
    expect(result.retries).toBe(2);
  });
});

describe('isMultiModuleTestCommand', () => {
  const ran = (command) => isMultiModuleTestCommand(classifyBashCommand(command));

  it('accepts the Gradle tasks whose last path segment starts with test', () => {
    for (const command of ['./gradlew test', './gradlew :lint:test', './gradlew :core:data:testDemoDebugUnitTest', './gradlew testDemoDebugUnitTest --continue']) {
      expect(ran(command), command).toBe(true);
    }
  });

  it('rejects the tasks that merely contain the word test elsewhere', () => {
    for (const command of ['./gradlew :core:testing:assemble', './gradlew :core:data-test:jar', './gradlew assembleDebug', './gradlew :lint:lintDebug']) {
      expect(ran(command), command).toBe(false);
    }
  });

  it('rejects a command that is not a shell test command at all', () => {
    expect(isMultiModuleTestCommand(null)).toBe(false);
    expect(ran('echo test')).toBe(false);
  });
});

describe('gradeScenarioCondition -- multi-module-tests results that are not applicable', () => {
  const result = grade([TEST_STEP], answerText(GOOD_ANSWER));

  it('returns all eight checks, in the canonical order, as booleans with a detail', () => {
    expect(result.checks.map((c) => c.name)).toEqual(GRADING_CHECK_NAMES);
    for (const check of result.checks) {
      expect(typeof check.passed).toBe('boolean');
      expect(typeof check.detail).toBe('string');
      expect(Array.isArray(check.evidence_event_indices)).toBe(true);
    }
  });

  it('keeps the three integrity checks real', () => {
    expect(result.checks.slice(0, 3).map((c) => c.passed)).toEqual([true, true, true]);
    const noCommand = grade([], answerText(GOOD_ANSWER));
    expect(noCommand.checks[1]).toMatchObject({ name: 'bash_tool_use_present', passed: false });
  });

  it('reports the five evidence-binding checks as not applicable, with the family reason', () => {
    for (const check of result.checks.slice(3)) {
      expect(check.detail, check.name).toContain(MULTI_MODULE_NOT_APPLICABLE_REASON);
      expect(check.detail, check.name).toMatch(/^not applicable/);
    }
    expect(result.checks.slice(3).map((c) => c.passed)).toEqual([false, false, false, true, false]);
  });

  it('has no first useful signal and no terminal authoritative event', () => {
    expect(result.firstUsefulSignalEventIndex).toBeNull();
    expect(result.terminalAuthoritativeEventIndex).toBeNull();
    expect(result.notApplicableReason).toBe(MULTI_MODULE_NOT_APPLICABLE_REASON);
  });

  it('describes the terminal evidence as not present, with the answer block diagnostic', () => {
    expect(result.terminalEvidence).toMatchObject({
      present: false, provider: null, evidence_well_formed: false, observed_result: null,
      coverage_gate_diagnostic: 'not-applicable', coverage_gate_attempts: [],
    });
    expect(result.terminalEvidence.final_answer_block).toEqual({
      found: true, parsed: true, ambiguous: false, matches_observed: null, comparison_status: 'no-observed-result',
      declared_outcome_kind: 'tests_failed', observed_outcome_kind: null, missing_fields: [], mismatch_fields: [], unexpected_key_count: 0,
    });
  });

  it('gives no product_e2e_success to either arm, and a claim-only evidence kind', () => {
    for (const condition of ['current-skill', 'no-skill']) {
      const graded = grade([TEST_STEP], answerText(GOOD_ANSWER), { condition });
      expect(graded.outcomeAssessment.product_e2e_success, condition).toBeNull();
      expect(graded.outcomeAssessment.provider_evidence_kind, condition).toBe('claim-only');
      expect(graded.outcomeAssessment.provider_evidence_status, condition).toBe('unavailable');
    }
  });

  it('carries the current outcome-assessment schema with exactly its keys', () => {
    expect(Object.keys(result.outcomeAssessment)).toEqual([
      'schema', 'task_outcome_matched', 'task_outcome_reason', 'answer_protocol_matched', 'provider_evidence_kind',
      'provider_evidence_status', 'product_e2e_success', 'task_outcome_mismatch_fields', 'task_outcome_unexpected_key_count',
    ]);
    expect(result.outcomeAssessment.schema).toBe(2);
  });
});

describe('buildTaskFieldCorrectness -- the family decides the field list', () => {
  const assessment = (matched, mismatchFields) => ({
    schema: 2, task_outcome_matched: matched, task_outcome_reason: matched ? 'matched' : 'mismatched', answer_protocol_matched: true,
    provider_evidence_kind: 'claim-only', provider_evidence_status: 'unavailable', product_e2e_success: null,
    task_outcome_mismatch_fields: mismatchFields, task_outcome_unexpected_key_count: 0,
  });
  const block = { declared_outcome_kind: 'tests_failed' };

  it('gives a multi-module record exactly the four multi-module keys', () => {
    const result = buildTaskFieldCorrectness(assessment(false, ['failed_count']), block, 'multi-module-tests');
    expect(Object.keys(result)).toEqual([...MULTI_MODULE_TASK_FIELD_VALUES]);
    expect(result).toEqual({ outcome_kind: 'matched', failing_modules: 'matched', failed_test_classes: 'matched', failed_count: 'mismatched' });
  });

  it('marks every multi-module field not-observed when there is no usable assessment', () => {
    const result = buildTaskFieldCorrectness({ schema: 2, task_outcome_matched: null }, block, 'multi-module-tests');
    expect(Object.values(result)).toEqual(['not-observed', 'not-observed', 'not-observed', 'not-observed']);
  });

  it('keeps exactly today\'s eight keys for every other family, with or without the argument', () => {
    const base = assessment(true, []);
    for (const family of [undefined, 'test-only', 'coverage']) {
      expect(Object.keys(buildTaskFieldCorrectness(base, { declared_outcome_kind: 'tests_executed' }, family)), String(family)).toEqual([...TASK_OUTCOME_MISMATCH_FIELD_VALUES]);
    }
  });
});
