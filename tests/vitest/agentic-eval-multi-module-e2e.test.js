// tests/vitest/agentic-eval-multi-module-e2e.test.js
// The test that decides whether a multi-module-tests cell survives: one synthetic cell per arm and per
// runtime goes through the REAL grader, run-record builder, accepted-run-audit builder, the record and
// audit validators, their cross-validation, the cell-integrity gate, and then a closure directory read
// by campaign-summary's loadCell and summarizeCampaign. Every rejection this test revealed was fixed for
// this family only; the assertions below pin that every cell is accepted with its key facts.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeScenarioCondition } from '../../tools/agentic-eval/graders.mjs';
import { buildRunRecord, scenarioCellIntegrityOk, scenarioHardGate } from '../../tools/agentic-eval/cli.mjs';
import { resolveSelection } from '../../tools/agentic-eval/registries.mjs';
import { validateRun, validateScenario } from '../../tools/agentic-eval/schemas.mjs';
import {
  buildAcceptedRunAuditSidecar, validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord,
} from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { computePolicySha256 } from '../../tools/agentic-eval/policy-config.mjs';
import { summarizeCampaign } from '../../tools/agentic-eval/campaign-summary.mjs';
import { TEST_RUN_RECORD_V6_INPUTS } from './_agentic-eval-run-record-fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, '..', 'fixtures', 'agentic-eval-multi-module');
const task = JSON.parse(readFileSync(path.join(fixtureDir, 'scenario-draft.json'), 'utf8'));
const truth = JSON.parse(readFileSync(path.join(fixtureDir, 'expected-draft.json'), 'utf8'));
const SCENARIO = {
  ...task,
  expected_outcome: truth.expected_outcome,
  expected: truth.expected,
  smoke: truth.smoke,
  first_useful_signal_predicate: truth.first_useful_signal_predicate,
};
const GOOD_ANSWER = SCENARIO.expected;

const SKILL_SOURCE_SHA = '27c943dc392675f78209a78ce09adb4f79283e3e';
const KMP_COMMAND = 'kmp-test parallel --flavor demo --exclude-modules app,core:designsystem,feature:foryou:impl,feature:interests:impl --json --project-root .';
const GRADLE_COMMAND = './gradlew :core:common:test :core:data:testDemoDebugUnitTest :core:domain:testDemoDebugUnitTest --continue --console=plain';

const cleanup = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

function answerText(block) {
  return `Three modules have failing tests.\n\nKMP_EVAL_RESULT\n${JSON.stringify(block)}\nKMP_EVAL_RESULT_END\n`;
}

/** One cell's conditionResult, in the shape matrix-runner's runSingleCondition produces it. */
function buildConditionResult({ runtimeId, selection, condition, finalText }) {
  const product = condition === 'current-skill';
  const steps = [];
  if (product && runtimeId === 'claude-code') steps.push({ kind: 'skill', name: 'Skill', skill: 'kmp-test-runner', result: 'Launching skill: kmp-test-runner' });
  steps.push(product
    ? { kind: 'shell', name: 'Bash', command: KMP_COMMAND, result: '{"tool":"kmp-test","exit_code":1}', isError: true }
    : { kind: 'shell', name: 'Bash', command: GRADLE_COMMAND, result: 'BUILD FAILED in 1m 2s', isError: true });
  const toolAttempts = [];
  const decisionByAttempt = new Map();
  const dispatchStatusByAttempt = new Map();
  let eventIndex = 1;
  for (const step of steps) {
    const id = `toolu_${toolAttempts.length + 1}`;
    const attemptIndex = eventIndex++;
    const resultIndex = eventIndex++;
    const isSkill = step.kind === 'skill';
    toolAttempts.push({
      id, kind: step.kind, runtimeName: step.name, eventIndex: attemptIndex, receiptNs: BigInt(attemptIndex * 1000),
      profileAllowed: true, command: isSkill ? null : step.command,
      skillReference: isSkill ? step.skill : null, targetsExpectedSkill: isSkill ? true : null,
      result: { found: true, eventIndex: resultIndex, isError: isSkill ? false : step.isError, text: step.result, textStatus: 'text' },
      preDispatchBlock: { recognized: false, signature: null },
    });
    if (!isSkill) {
      decisionByAttempt.set(id, 'allow');
      dispatchStatusByAttempt.set(id, 'result_correlated_no_policy');
    }
  }
  const skillAttempt = toolAttempts.find((a) => a.kind === 'skill');
  const observation = {
    schema: 1,
    runtime: { id: runtimeId, protocolVersion: 1 },
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 10_000_000n },
    session: { initPresent: true, modelResolved: selection.model.model_id, sessionIdObserved: `sess-${runtimeId}-${condition}`, runtimeVersion: 'fake', toolProfileMatchesExpected: true, modelSnapshot: null },
    transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    terminal: { present: true, isError: false, turnCount: 3, finalText, resultSubtype: 'success', usage: { input: 100, cached_input: 0, cache_write: 0, output: 50, reasoning_output: runtimeId === 'claude-code' ? null : 0 } },
    toolAttempts,
    skill: {
      available: product,
      profileMatchesCondition: true,
      snapshotBindingMatches: product,
      targetInvocation: skillAttempt
        ? { attempted: true, confirmed: true, attemptCount: 1, eventIndex: skillAttempt.eventIndex, receiptNs: skillAttempt.receiptNs, resultIsError: false }
        : null,
      foreignInvocations: [],
      ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
    },
    hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
    byteMetrics: { outputBytes: 400, streamJsonBytes: 800 },
    timing: { receiptNsByEventIndex: new Map(toolAttempts.flatMap((a) => [[a.eventIndex, a.receiptNs], [a.result.eventIndex, a.receiptNs + 500n]])) },
  };
  return {
    condition,
    observation,
    junitAttribution: { perAttemptJunit: new Map(), decisionByAttempt, ambiguousJunitEvidence: false, captureIncomplete: false, unreliable: false },
    dispatchAccounting: { dispatchStatusByAttempt, everyCallAccountedFor: true },
    startedAt: new Date('2026-10-02T09:00:00.000Z'),
    endedAt: new Date('2026-10-02T09:01:00.000Z'),
    argvSha256: 'a'.repeat(64),
    deliveredPromptSha256: 'b'.repeat(64),
    envKeys: ['PATH'],
    reasoningEffortRequested: 'high',
    reasoningEffortSource: 'harness-pinned-cli-flag',
    treatmentDeliverySha256: product ? 'd'.repeat(64) : null,
    maxBudgetUsd: runtimeId === 'claude-code' ? 6 : null,
    timeoutMs: 3_600_000,
  };
}

/** Runs one synthetic cell through everything up to the on-disk pair; returns what each stage produced. */
function produceCell({ runtimeId, condition, finalText = answerText(GOOD_ANSWER), orderIndex }) {
  const resolved = resolveSelection({ runtimeId, executionProfileId: 'sandboxed-unrestricted-v1' });
  if (!resolved.ok) throw new Error(`resolveSelection(${runtimeId}) failed: ${resolved.reason}`);
  const { selection } = resolved;
  const conditionResult = buildConditionResult({ runtimeId, selection, condition, finalText });
  const gradeResult = gradeScenarioCondition(conditionResult, SCENARIO);
  const product = condition === 'current-skill';
  const record = buildRunRecord({
    conditionResult, condition, runKind: 'scenario', scenarioId: SCENARIO.id,
    skillSourceSha: product ? SKILL_SOURCE_SHA : null,
    daemonPolicy: 'disabled-via-gradle-user-home-properties',
    allowedGradleTasks: SCENARIO.policy.allowed_gradle_tasks, allowedKmpTestSubcommands: SCENARIO.policy.allowed_kmptest_subcommands,
    policySha256: computePolicySha256(), projectAlias: SCENARIO.project_alias, projectCommit: SCENARIO.project_commit,
    projectUrl: SCENARIO.project_url, family: SCENARIO.family, modelRequested: selection.model.model_id,
    seed: 42, orderIndex, repetitionIndex: 0, gradeResult,
    ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    selection, promptArtifact: TEST_RUN_RECORD_V6_INPUTS.promptArtifact, skillSnapshotArtifact: TEST_RUN_RECORD_V6_INPUTS.skillSnapshotArtifact,
    isolationAttestationSha256: 'e'.repeat(64),
  });
  const audit = buildAcceptedRunAuditSidecar({
    record, conditionResult,
    terminalAuthoritativeEventIndex: gradeResult.terminalAuthoritativeEventIndex,
    terminalEvidence: gradeResult.terminalEvidence,
  });
  const auditText = JSON.stringify(audit, null, 2);
  record.accepted_audit = { schema: audit.schema, relative_path: `audit/${record.run_id}.json`, sha256: createHash('sha256').update(auditText, 'utf8').digest('hex') };
  return { selection, conditionResult, gradeResult, record, audit, auditText };
}

const CELLS = [
  { runtimeId: 'claude-code', condition: 'current-skill', orderIndex: 0 },
  { runtimeId: 'claude-code', condition: 'no-skill', orderIndex: 1 },
  { runtimeId: 'codex-cli', condition: 'current-skill', orderIndex: 0 },
  { runtimeId: 'codex-cli', condition: 'no-skill', orderIndex: 1 },
];

describe('multi-module-tests -- the scenario drafts', () => {
  it('validate as a scenario before any cell is built', () => {
    expect(validateScenario(SCENARIO)).toEqual({ errors: [], warnings: [] });
  });
});

describe.each(CELLS)('multi-module-tests cell: $runtimeId / $condition', (cell) => {
  const built = produceCell(cell);

  it('is graded as a correct answer that ran a test command', () => {
    expect(built.gradeResult.success).toBe(true);
    expect(built.gradeResult.outcomeAssessment.task_outcome_matched).toBe(true);
    expect(built.record.family).toBe('multi-module-tests');
    expect(built.record.success.value).toBe(true);
    expect(built.record.expected_outcome_matched.value).toBe(true);
  });

  it('writes a record that the record validator accepts', () => {
    expect(validateRun(built.record).errors).toEqual([]);
  });

  it('writes an audit sidecar that the audit validator accepts', () => {
    expect(validateAcceptedRunAuditSidecar(JSON.parse(built.auditText), { family: built.record.family }).errors).toEqual([]);
  });

  it('cross-validates the audit against the record', () => {
    expect(crossValidateAcceptedRunAuditAgainstRecord(JSON.parse(built.auditText), built.record)).toEqual([]);
  });

  it('passes the cell-integrity gate', () => {
    const cellIntegrity = scenarioCellIntegrityOk(built.record, built.conditionResult);
    expect(cellIntegrity.ok, JSON.stringify(cellIntegrity.checks?.filter((c) => c.passed === false))).toBe(true);
  });
});

// A wrong answer is valid negative data (benchmark eligibility never depends on correctness), so a cell whose
// answer is wrong, malformed or absent must still be accepted, with its key facts false and the reason recorded.
const { failed_count: _count, ...ANSWER_WITHOUT_COUNT } = GOOD_ANSWER;
const WRONG_ANSWERS = [
  { label: 'a wrong failed_count', text: answerText({ ...GOOD_ANSWER, failed_count: GOOD_ANSWER.failed_count + 1 }), mismatch: ['failed_count'], missing: [], declared: 'tests_failed', reason: 'mismatched' },
  { label: 'a wrong failing_modules', text: answerText({ ...GOOD_ANSWER, failing_modules: GOOD_ANSWER.failing_modules.slice(1) }), mismatch: ['failing_modules'], missing: [], declared: 'tests_failed', reason: 'mismatched' },
  { label: 'a wrong failed_test_classes', text: answerText({ ...GOOD_ANSWER, failed_test_classes: ['OtherTest'] }), mismatch: ['failed_test_classes'], missing: [], declared: 'tests_failed', reason: 'mismatched' },
  { label: 'a tests_passed claim', text: answerText({ outcome_kind: 'tests_passed', failing_modules: [], failed_test_classes: [], failed_count: 0 }), mismatch: ['outcome_kind', 'failing_modules', 'failed_test_classes', 'failed_count'], missing: [], declared: 'tests_passed', reason: 'mismatched' },
  { label: 'an answer with a missing field', text: answerText(ANSWER_WITHOUT_COUNT), mismatch: [], missing: ['failed_count'], declared: 'tests_failed', reason: 'claim-malformed' },
  { label: 'no answer block', text: 'The tests fail in three modules.', mismatch: [], missing: [], declared: null, reason: 'claim-missing' },
];

describe.each(WRONG_ANSWERS)('multi-module-tests cell with $label', (wrong) => {
  const built = produceCell({ runtimeId: 'claude-code', condition: 'no-skill', orderIndex: 1, finalText: wrong.text });

  it('is graded as not matching, with the reason and fields recorded', () => {
    expect(built.record.success.value).toBe(false);
    expect(built.record.expected_outcome_matched.value).toBe(false);
    expect(built.record.outcome_assessment.task_outcome_reason).toBe(wrong.reason);
    const block = built.audit.terminal_evidence.final_answer_block;
    expect(block.mismatch_fields).toEqual(wrong.mismatch);
    expect(block.missing_fields).toEqual(wrong.missing);
    expect(block.declared_outcome_kind).toBe(wrong.declared);
  });

  it('is still a valid, cross-validated, integrity-clean cell', () => {
    expect(validateRun(built.record).errors).toEqual([]);
    expect(validateAcceptedRunAuditSidecar(JSON.parse(built.auditText), { family: built.record.family }).errors).toEqual([]);
    expect(crossValidateAcceptedRunAuditAgainstRecord(JSON.parse(built.auditText), built.record)).toEqual([]);
    expect(scenarioCellIntegrityOk(built.record, built.conditionResult).ok).toBe(true);
  });

  it('is accepted by the campaign summary with its key facts false', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aemm-wrong-'));
    cleanup.push(dir);
    const cellDir = path.join(dir, 'private', 'claude-code-0');
    mkdirSync(cellDir, { recursive: true });
    writeFileSync(path.join(cellDir, 'audit.json'), built.auditText);
    writeFileSync(path.join(cellDir, 'record.json'), JSON.stringify(built.record, null, 2));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      schema: 1, campaign_id: 'multi-module-wrong', scenario_id: SCENARIO.id, seed: 42, provider_mode: 'live',
      runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0], max_budget_usd: 6 }],
    }, null, 2));
    const summary = summarizeCampaign(dir);
    expect(summary.cells[0].status, JSON.stringify(summary.cells[0])).toBe('accepted');
    expect(summary.cells[0].key_facts_match).toBe(false);
    expect(summary.cells[0].full_answer_match).toBe(false);
  });
});

describe('multi-module-tests -- a synthetic closure', () => {
  function writeClosure() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aemm-e2e-'));
    cleanup.push(dir);
    for (const cell of CELLS) {
      const { record, auditText } = produceCell(cell);
      const cellKey = `${cell.runtimeId}-${cell.orderIndex}`;
      const cellDir = path.join(dir, 'private', cellKey);
      mkdirSync(cellDir, { recursive: true });
      writeFileSync(path.join(cellDir, 'audit.json'), auditText);
      writeFileSync(path.join(cellDir, 'record.json'), JSON.stringify(record, null, 2));
    }
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      schema: 1, campaign_id: 'multi-module-e2e', scenario_id: SCENARIO.id, seed: 42, provider_mode: 'live',
      runtimes: [
        { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1], max_budget_usd: 6 },
        { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0, 1], max_budget_usd: null },
      ],
    }, null, 2));
    return dir;
  }

  it('is summarized with every cell accepted and its key facts matched', () => {
    const summary = summarizeCampaign(writeClosure());
    expect(summary.summary_status).toBe('ok');
    expect(summary.cells.map((c) => c.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    for (const cellRow of summary.cells) {
      expect(cellRow.key_facts_match, cellRow.cell_key).toBe(true);
      expect(cellRow.full_answer_match, cellRow.cell_key).toBe(true);
    }
    for (const group of summary.by_runtime_arm) {
      expect(group.accepted, `${group.runtime_id}/${group.arm}`).toBe(1);
      expect(group.key_facts_match, `${group.runtime_id}/${group.arm}`).toEqual({ matched: 1, of: 1 });
    }
  });
});
