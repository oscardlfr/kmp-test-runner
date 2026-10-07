import { classifyBashCommand } from './command-classify.mjs';
import { extractKmpEvalResultBlock, extractKmpTestEnvelope } from './graders.mjs';
import { LATEST_OUTCOME_ASSESSMENT_SCHEMA, taskOutcomeMismatchFieldValuesFor } from './outcome-assessment-contract.mjs';

const colon = (name) => typeof name === 'string' ? (name.startsWith(':') ? name : `:${name}`) : '';
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && new Set(a).size === a.length && a.every((value) => b.includes(value));
const sameMap = (a, b) => a && b && typeof a === 'object' && typeof b === 'object'
  && !Array.isArray(a) && !Array.isArray(b)
  && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every((key) => Object.hasOwn(b, key) && a[key] === b[key]);

function answerComparison(finalText, scenario) {
  const block = extractKmpEvalResultBlock(finalText ?? '');
  const expected = scenario.expected;
  const fields = taskOutcomeMismatchFieldValuesFor(scenario.family);
  const answer = !block.ambiguous && block.parsed && typeof block.parsed === 'object' && !Array.isArray(block.parsed)
    ? block.parsed : null;
  const missing = answer ? fields.filter((field) => !Object.hasOwn(answer, field)) : [];
  const mismatched = answer ? fields.filter((field) => Object.hasOwn(answer, field)
    && (Array.isArray(expected[field]) ? !sameSet(answer[field], expected[field])
      : field === 'module_line_coverage' ? !sameMap(answer[field], expected[field])
        : answer[field] !== expected[field])) : [];
  const unexpected = answer ? Object.keys(answer).filter((field) => !fields.includes(field)).length : 0;
  const protocolMatched = answer != null && missing.length === 0 && unexpected === 0;
  const malformed = answer == null || missing.length > 0;
  const matched = malformed ? null : mismatched.length === 0;
  const reason = !block.found ? 'claim-missing' : malformed ? 'claim-malformed'
    : matched ? 'matched' : 'mismatched';
  return { matched, protocolMatched, reason,
    mismatched: malformed ? null : mismatched, unexpected: malformed ? null : unexpected,
    diagnostic: {
      found: block.found, parsed: answer != null, ambiguous: block.ambiguous,
      matches_observed: null, comparison_status: answer ? 'no-observed-result' : !block.found ? 'missing-block' : 'invalid-json',
      declared_outcome_kind: typeof answer?.outcome_kind === 'string'
        ? (['tests_failed', 'coverage_threshold_exceeded', 'compilation_failed'].includes(answer.outcome_kind)
          ? answer.outcome_kind : 'unrecognized') : null,
      observed_outcome_kind: null, missing_fields: missing, mismatch_fields: mismatched,
      unexpected_key_count: unexpected,
    } };
}

function matchesEvidenceScope(scenario, envelope) {
  const scope = scenario.evidence_scope;
  if (!scope) return true; // Direct grader unit fixtures predate the corpus scope contract.
  const fresh = (envelope.parallel?.legs ?? []).reduce((sum, leg) => sum + (leg.execution?.fresh ?? 0), 0);
  return envelope.tests?.total === scope.test_tasks_total
    && envelope.tests?.individual_total === scope.individual_total
    && sameSet((envelope.modules ?? []).map(module => colon(module.name)), scope.module_names)
    && (scope.fresh_test_tasks === undefined || fresh === scope.fresh_test_tasks);
}

function testFailureFacts(envelope) {
  const failedModules = [...new Set((envelope.errors ?? []).filter((error) => error.code === 'module_failed'
    && error.setup_failed !== true).map((error) => colon(error.module)))];
  const details = (envelope.modules ?? []).filter((module) => failedModules.includes(colon(module.name)))
    .flatMap((module) => module.test_failures ?? []);
  return {
    failedModules,
    classes: [...new Set(details.map((failure) => failure.test?.slice(0, failure.test.lastIndexOf('.')).split('.').at(-1)).filter(Boolean))],
    count: new Set(details.map((failure) => failure.test).filter(Boolean)).size,
  };
}

export function evidenceMatches(scenario, envelope) {
  const expected = scenario.expected;
  if (!matchesEvidenceScope(scenario, envelope)) return false;
  if (scenario.family === 'multi-module-coverage') {
    const results = envelope.coverage?.module_results;
    const gate = (envelope.errors ?? []).find((error) => error.code === 'module_coverage_threshold_exceeded');
    if (envelope.subcommand !== 'parallel' || envelope.coverage?.data_provenance !== 'current_run'
      || envelope.tests?.failed !== 0 || envelope.tests?.individual_failed !== 0
      || envelope.tests?.individual_failed_distinct !== 0
      || !Array.isArray(results) || !gate || envelope.exit_code !== 1
      || gate.threshold !== expected.threshold_percent
      || (envelope.errors ?? []).some(error => error !== gate)) return false;
    const below = results.filter((result) => result.status === 'with_data'
      && result.line_coverage_percent < expected.threshold_percent).map((result) => colon(result.module));
    const noData = results.filter((result) => result.status === 'no_coverage_plugin').map((result) => colon(result.module));
    const percentages = Object.fromEntries(results.filter((result) => result.status === 'with_data')
      .map((result) => [colon(result.module), Math.round(result.line_coverage_percent * 10) / 10]));
    return sameSet(below, expected.below_threshold_modules)
      && sameSet(noData, expected.no_data_modules)
      && results.every(result => result.status === 'with_data' || result.status === 'no_coverage_plugin')
      && sameSet((gate.modules ?? []).map(colon), expected.below_threshold_modules)
      && sameMap(percentages, expected.module_line_coverage);
  }
  if (scenario.family === 'changed-dependents') {
    const changed = envelope.changed;
    const failures = testFailureFacts(envelope);
    return envelope.subcommand === 'changed' && envelope.exit_code === 1
      && sameSet((changed?.detected_modules ?? []).map(colon), expected.direct_modules)
      && sameSet((changed?.dependent_modules ?? []).map(colon), expected.dependent_modules)
      && sameSet((changed?.selected_modules ?? []).map(colon), expected.selected_modules)
      && sameSet(failures.failedModules, expected.failing_modules)
      && sameSet(failures.classes, expected.failed_test_classes)
      && failures.count === expected.failed_count
      && failures.failedModules.every((module) => expected.dependent_modules.includes(module));
  }
  const failure = (envelope.errors ?? []).find((error) => error.code === 'module_failed'
    && colon(error.module) === expected.compile_module && error.setup_failed === true
    && Array.isArray(error.compile_failures)
    && error.compile_failures.some((detail) => detail.task === expected.compile_task
      && detail.diagnostics?.some((diagnostic) => diagnostic.file === expected.diagnostic_file
        && diagnostic.line === expected.diagnostic_line
        && diagnostic.message.includes(expected.diagnostic_message))));
  // Each dependent must be explicitly recorded as an unrun setup failure. An absent error alone
  // cannot prove that its test task was withheld after the upstream compilation failure.
  const dependentsUnrun = expected.unrun_dependents.every((module) => {
    const error = (envelope.errors ?? []).find((item) => item.code === 'module_failed'
      && colon(item.module) === module && item.setup_failed === true);
    const result = (envelope.modules ?? []).find((item) => colon(item.name) === module);
    return error && result && (!Array.isArray(result.test_failures) || result.test_failures.length === 0);
  });
  // Independent modules may complete tests under Gradle --continue. The
  // contract concerns the compile root and its blocked dependents, not a
  // global zero-test count for the whole selected project scope.
  return envelope.exit_code === 1 && envelope.tests?.individual_failed === 0
    && envelope.tests?.individual_failed_distinct === 0 && failure && dependentsUnrun
    && !(envelope.modules ?? []).some((module) => expected.unrun_dependents.includes(colon(module.name))
      && (module.tests?.total > 0 || module.execution?.fresh > 0));
}

export function gradeNextMilestoneScenario({ scenario, observation, bashResults, checks, junitAttribution }) {
  const allowed = bashResults.filter((attempt) => {
    const decision = junitAttribution.decisionByAttempt.get(attempt.id);
    if (decision === 'deny' || decision === null) return false;
    const command = classifyBashCommand(attempt.command);
    if (Array.isArray(scenario.policy?.allowed_kmptest_subcommands)
      && !scenario.policy.allowed_kmptest_subcommands.includes(command.subcommand)) return false;
    return command.kind === 'kmp-test' && !command.isPlanOnly
      && ['parallel', 'changed'].includes(command.subcommand);
  });
  const attempts = allowed.map((attempt) => ({ attempt, envelope: extractKmpTestEnvelope(attempt.resultContent) }));
  const last = attempts.at(-1);
  const evidence = last?.envelope != null && evidenceMatches(scenario, last.envelope) === true;
  const answer = answerComparison(observation.terminal.finalText, scenario);
  if (attempts.length === 0) {
    // A control agent can solve these tasks with standard Gradle/Git tooling.
    // As with the existing multi-module family, its answer is compared with
    // ground truth and a real, policy-allowed Gradle task must have run.
    const gradleAttempts = bashResults.filter((attempt) => {
      const decision = junitAttribution.decisionByAttempt.get(attempt.id);
      if (decision === 'deny' || decision === null) return false;
      const command = classifyBashCommand(attempt.command);
      if (command.kind !== 'gradle' || command.isPlanOnly) return false;
      return command.taskTokens.some((task) => (scenario.policy?.allowed_gradle_tasks ?? []).includes(task)
        && /(?:^|:)(?:test[A-Za-z]*|compile[A-Za-z]*|koverXmlReport|jacocoTestReport|create[A-Za-z]*CoverageReport)$/.test(task));
    });
    const attemptedTasks = new Set(gradleAttempts.flatMap(attempt => classifyBashCommand(attempt.command).taskTokens));
    const ran = gradleAttempts.length > 0
      && (scenario.evidence_scope?.required_gradle_tasks ?? []).every(task => attemptedTasks.has(task));
    for (const [name, passed] of [
      ['authoritative_evidence_well_formed', false], ['authoritative_target_matches_expected', false],
      ['authoritative_outcome_matches_expected', false], ['no_provider_contradiction', true],
      ['final_answer_consistent_with_evidence', false],
    ]) checks.push({ name, passed, detail: 'standard-tools control: final answer is graded against ground truth', evidence_event_indices: [] });
    return {
      // The legacy publication field records an attempted answer verdict. An absent or
      // malformed claim is a graded negative, while the neutral assessment retains null
      // to describe why no task-outcome comparison could be made.
      expectedOutcomeMatched: answer.matched === true, success: answer.matched === true && answer.protocolMatched && ran && checks.slice(0, 3).every((check) => check.passed),
      checks, firstUsefulSignalEventIndex: null, terminalAuthoritativeEventIndex: null,
      testInvocationsTotal: gradleAttempts.length, retries: Math.max(0, gradleAttempts.length - 1),
      harnessEvidenceAmbiguous: junitAttribution.ambiguousJunitEvidence,
      parallelEvidenceMalformed: false, changedEvidenceMalformed: false,
      gradleJunitEvidenceCaptureIncomplete: junitAttribution.captureIncomplete,
      gradleJunitEvidenceUnreliable: junitAttribution.unreliable,
      notApplicableReason: 'next_milestone_standard_tools',
      terminalEvidence: {
        present: false, provider: null, tool_result_event_index: null,
        evidence_well_formed: false, target_matches_expected: null, outcome_matches_expected: null,
        malformed: null, parallel_evidence_invalid: null, changed_evidence_invalid: null,
        observed_result: null, final_answer_block: answer.diagnostic,
        coverage_gate_diagnostic: 'not-applicable', coverage_gate_attempts: [],
      },
      outcomeAssessment: {
        schema: LATEST_OUTCOME_ASSESSMENT_SCHEMA,
        task_outcome_matched: answer.matched, task_outcome_reason: answer.reason,
        answer_protocol_matched: answer.protocolMatched,
        provider_evidence_kind: ran ? 'claim-only' : 'none', provider_evidence_status: 'unavailable',
        product_e2e_success: null, task_outcome_mismatch_fields: answer.mismatched,
        task_outcome_unexpected_key_count: answer.unexpected,
      },
    };
  }
  const addCheck = (name, passed, detail) => checks.push({ name, passed, detail, evidence_event_indices: last ? [last.attempt.resultIndex] : [] });
  addCheck('authoritative_evidence_well_formed', last?.envelope != null, last?.envelope ? 'valid kmp-test envelope' : 'no valid executed kmp-test envelope');
  addCheck('authoritative_target_matches_expected', evidence, evidence ? 'scenario modules matched' : 'scenario modules did not match');
  addCheck('authoritative_outcome_matches_expected', evidence, evidence ? 'observed outcome matched' : 'observed outcome did not match');
  addCheck('no_provider_contradiction', evidence, evidence ? 'no contradiction' : 'missing or contradictory evidence');
  addCheck('final_answer_consistent_with_evidence', answer.matched === true && answer.protocolMatched && evidence, answer.matched && evidence ? 'answer and evidence matched' : 'answer or evidence mismatched');
  return {
    expectedOutcomeMatched: evidence && answer.matched === true,
    success: checks.every((check) => check.passed) && evidence && answer.matched === true && answer.protocolMatched,
    checks, firstUsefulSignalEventIndex: last?.attempt.resultIndex ?? null,
    terminalAuthoritativeEventIndex: last?.attempt.resultIndex ?? null,
    testInvocationsTotal: attempts.length, retries: Math.max(0, attempts.length - 1),
    harnessEvidenceAmbiguous: junitAttribution.ambiguousJunitEvidence,
    parallelEvidenceMalformed: false, changedEvidenceMalformed: false,
    gradleJunitEvidenceCaptureIncomplete: junitAttribution.captureIncomplete,
    gradleJunitEvidenceUnreliable: junitAttribution.unreliable,
    notApplicableReason: 'next_milestone_family',
    terminalEvidence: {
      present: false, provider: null, tool_result_event_index: null,
      evidence_well_formed: false, target_matches_expected: null, outcome_matches_expected: null,
      malformed: null, parallel_evidence_invalid: null, changed_evidence_invalid: null,
      observed_result: null, final_answer_block: answer.diagnostic,
      coverage_gate_diagnostic: 'not-applicable', coverage_gate_attempts: [],
    },
    outcomeAssessment: {
      schema: LATEST_OUTCOME_ASSESSMENT_SCHEMA,
      task_outcome_matched: answer.matched, task_outcome_reason: answer.reason,
      answer_protocol_matched: answer.protocolMatched,
      provider_evidence_kind: last?.envelope ? 'kmp-test-envelope' : 'none',
      provider_evidence_status: evidence ? 'matched' : last?.envelope ? 'mismatched' : 'unavailable',
      product_e2e_success: evidence,
      task_outcome_mismatch_fields: answer.mismatched,
      task_outcome_unexpected_key_count: answer.unexpected,
    },
  };
}
