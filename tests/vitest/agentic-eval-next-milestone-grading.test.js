import { describe, it, expect } from 'vitest';
import { gradeNextMilestoneScenario } from '../../tools/agentic-eval/graders-next-milestone.mjs';

const answerText = (expected) => `KMP_EVAL_RESULT\n${JSON.stringify(expected)}\nKMP_EVAL_RESULT_END`;
const envelope = (extra) => ({ tool: 'kmp-test', schema_version: 3, subcommand: 'parallel', exit_code: 1,
  tests: { individual_total: 0 }, modules: [], errors: [], ...extra });
function grade(family, expected, result, command = 'kmp-test parallel --json', answer = expected) {
  const attempt = { id: 't1', command, resultContent: JSON.stringify(result), resultIndex: 2 };
  return gradeNextMilestoneScenario({ scenario: { family, expected, policy: {
    allowed_kmptest_subcommands: ['parallel', 'changed'], allowed_gradle_tasks: [':feature:test'],
  } },
    observation: { terminal: { finalText: answerText(answer) } }, bashResults: [attempt],
    checks: [{ name: 'no_transcript_structural_issues', passed: true },
      { name: 'bash_tool_use_present', passed: true }, { name: 'tool_result_correlated', passed: true }],
    junitAttribution: { decisionByAttempt: new Map([['t1', 'allow']]), ambiguousJunitEvidence: false,
      captureIncomplete: false, unreliable: false }, });
}

describe('next milestone graders bind final answers to real envelopes', () => {
  it('requires the exact per-module LINE coverage and threshold error', () => {
    const expected = { outcome_kind: 'coverage_threshold_exceeded', threshold_percent: 80,
      below_threshold_modules: [':core'], no_data_modules: [':empty'],
      module_line_coverage: { ':core': 75, ':app': 90 } };
    const result = envelope({ coverage: { module_results: [
      { module: 'core', status: 'with_data', line_coverage_percent: 75 },
      { module: 'app', status: 'with_data', line_coverage_percent: 90 },
      { module: 'empty', status: 'no_xml', line_coverage_percent: null },
    ] }, errors: [{ code: 'module_coverage_threshold_exceeded', threshold: 80, modules: ['core'] }] });
    expect(grade('multi-module-coverage', expected, result).success).toBe(true);
    expect(grade('multi-module-coverage', expected, { ...result, coverage: { module_results: [
      { module: 'core', status: 'with_data', line_coverage_percent: 75 },
      { module: 'app', status: 'with_data', line_coverage_percent: 90 },
    ] } }).success).toBe(false);
    expect(grade('multi-module-coverage', expected, { ...result, errors: [] }).success).toBe(false);
    const missing = grade('multi-module-coverage', expected, result, 'kmp-test parallel --json',
      { outcome_kind: expected.outcome_kind });
    expect(missing.success).toBe(false);
    expect(missing.outcomeAssessment).toMatchObject({ task_outcome_matched: null,
      task_outcome_reason: 'claim-malformed', task_outcome_mismatch_fields: null });
    const extra = grade('multi-module-coverage', expected, result, 'kmp-test parallel --json', { ...expected, hedge: true });
    expect(extra.success).toBe(false);
    expect(extra.outcomeAssessment).toMatchObject({ task_outcome_matched: true,
      answer_protocol_matched: false, task_outcome_mismatch_fields: [], task_outcome_unexpected_key_count: 1 });
    const unknown = grade('multi-module-coverage', expected, result, 'kmp-test parallel --json',
      { ...expected, outcome_kind: 'something_else' });
    expect(unknown.success).toBe(false);
    expect(unknown.terminalEvidence.final_answer_block.declared_outcome_kind).toBe('unrecognized');
  });

  it('requires direct/dependent selection and a failure in the dependent, not the direct module', () => {
    const expected = { outcome_kind: 'tests_failed', direct_modules: [':core'],
      dependent_modules: [':feature'], selected_modules: [':core', ':feature'],
      failing_modules: [':feature'], failed_test_classes: ['FeatureTest'], failed_count: 1 };
    const result = envelope({ subcommand: 'changed', changed: { detected_modules: ['core'],
      dependent_modules: ['feature'], selected_modules: ['core', 'feature'] },
    modules: [{ name: 'feature', test_failures: [{ test: 'pkg.FeatureTest.fails' }] }],
    errors: [{ code: 'module_failed', module: 'feature', task: ':feature:test' }] });
    expect(grade('changed-dependents', expected, result, 'kmp-test changed --include-dependents --json').success).toBe(true);
    const directFailure = { ...result, modules: [{ name: 'core', test_failures: [{ test: 'pkg.FeatureTest.fails' }] }],
      errors: [{ code: 'module_failed', module: 'core', task: ':core:test' }] };
    expect(grade('changed-dependents', expected, directFailure, 'kmp-test changed --include-dependents --json').success).toBe(false);
    expect(grade('changed-dependents', expected, { ...result, changed: { ...result.changed, dependent_modules: [] } },
      'kmp-test changed --include-dependents --json').success).toBe(false);
    const control = grade('changed-dependents', expected, { any: 'Gradle output' }, './gradlew :feature:test');
    expect(control.success).toBe(true);
    expect(control.outcomeAssessment.product_e2e_success).toBeNull();
  });

  it('requires compile diagnostics and positive evidence that the dependent tests never ran', () => {
    const expected = { outcome_kind: 'compilation_failed', compile_module: ':core', compile_task: ':core:compileKotlin',
      diagnostic_file: 'core/src/main/kotlin/Feature.kt', diagnostic_line: 12,
      diagnostic_message: 'Unresolved reference: broken', unrun_dependents: [':feature'] };
    const result = envelope({ modules: [{ name: 'core', test_failures: [] },
      { name: 'feature', test_failures: [], tests: { total: 0 }, execution: { fresh: 0 } }],
    errors: [{ code: 'module_failed', module: 'core', setup_failed: true,
      compile_failures: [{ task: ':core:compileKotlin', diagnostics: [{ file: expected.diagnostic_file,
        line: 12, message: 'Unresolved reference: broken' }] }] },
    { code: 'module_failed', module: 'feature', setup_failed: true }] });
    expect(grade('compile-failure', expected, result).success).toBe(true);
    expect(grade('compile-failure', expected, { ...result, errors: result.errors.slice(0, 1) }).success).toBe(false);
    expect(grade('compile-failure', expected, { ...result, tests: { individual_total: 1 } }).success).toBe(false);
    expect(grade('compile-failure', expected, { ...result, modules: [result.modules[0],
      { ...result.modules[1], tests: { total: 1 } }] }).success).toBe(false);
    expect(grade('compile-failure', expected, { ...result, errors: [{ ...result.errors[0], compile_failures: [] }, result.errors[1]] }).success).toBe(false);
  });
});
