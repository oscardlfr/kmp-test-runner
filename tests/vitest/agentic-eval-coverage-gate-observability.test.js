// tests/vitest/agentic-eval-coverage-gate-observability.test.js
// Unit tests for tools/agentic-eval/coverage-gate-observability.mjs.
//
// Evidence1 success-recovery PR B, Stage B2 (docs/audits/agentic-eval-evidence1-success-recovery-
// v1-runbook.md, Section 9.11, review-round finding): the closed enums and validator for
// Section 9.9's privacy-safe observability summary must live in exactly ONE place, imported
// verbatim by both accepted-run-audit.mjs (schema 10) and rejection-diagnostics.mjs (schema 13) --
// never two independently-maintained copies that could silently diverge. This file is the single
// source of truth both consumers' own test files import their expectations from.
import { describe, it, expect } from 'vitest';
import {
  FLAVOR_RELATION_VALUES,
  TEST_TYPE_RELATION_VALUES,
  COVERAGE_TARGET_STATUS_VALUES,
  COVERAGE_REPORT_STATUS_VALUES,
  EXECUTION_MODE_VALUES,
  COVERAGE_GATE_WARNING_BUCKET_FIELDS,
  OUTCOME_OBSERVABILITY_SUMMARY_FIELDS,
  validateOutcomeObservabilitySummary,
} from '../../tools/agentic-eval/coverage-gate-observability.mjs';

function wellFormedSummary(overrides = {}) {
  return {
    schema: 1,
    flavor_relation: 'not-applicable',
    test_type_relation: 'not-applicable',
    coverage_target_status: 'not-applicable',
    coverage_report_status: 'not-recorded',
    warning_code_counts: Object.fromEntries(COVERAGE_GATE_WARNING_BUCKET_FIELDS.map((f) => [f, 0])),
    module_failed_setup_count: null,
    execution_mode_counts: Object.fromEntries(EXECUTION_MODE_VALUES.map((f) => [f, 0])),
    ...overrides,
  };
}

describe('closed enum exports -- exact membership (Section 9.9)', () => {
  it('FLAVOR_RELATION_VALUES', () => {
    expect(FLAVOR_RELATION_VALUES).toEqual(['absent', 'explicit-match', 'explicit-mismatch', 'unexpected', 'not-applicable', 'not-recorded']);
  });
  it('TEST_TYPE_RELATION_VALUES', () => {
    expect(TEST_TYPE_RELATION_VALUES).toEqual(['absent', 'match', 'mismatch', 'not-applicable', 'not-recorded']);
  });
  it('COVERAGE_TARGET_STATUS_VALUES', () => {
    expect(COVERAGE_TARGET_STATUS_VALUES).toEqual(['with-data', 'no-xml', 'parse-error', 'unavailable', 'not-applicable', 'not-recorded']);
  });
  it('COVERAGE_REPORT_STATUS_VALUES', () => {
    expect(COVERAGE_REPORT_STATUS_VALUES).toEqual(['not-attempted', 'success', 'failed', 'unavailable', 'not-recorded']);
  });
  it('EXECUTION_MODE_VALUES', () => {
    expect(EXECUTION_MODE_VALUES).toEqual(['fresh', 'from-cache', 'up-to-date', 'no-evidence', 'not-recorded']);
  });
  it('COVERAGE_GATE_WARNING_BUCKET_FIELDS -- the closed set of approved coverage warning codes, grounded against every warnings.push(...) call site in lib/orchestrators/{coverage,parallel}-orchestrator.js', () => {
    expect(COVERAGE_GATE_WARNING_BUCKET_FIELDS.slice().sort()).toEqual([
      'coverage_aggregation_drift', 'coverage_aggregation_failed', 'coverage_aggregation_skipped',
      'coverage_parse_failed', 'coverage_report_dispatch_failed', 'coverage_report_write_failed',
      'coverage_xml_disabled', 'coverage_xml_oversized', 'no_coverage_data',
    ].sort());
  });
  it('OUTCOME_OBSERVABILITY_SUMMARY_FIELDS -- the closed top-level key set', () => {
    expect(OUTCOME_OBSERVABILITY_SUMMARY_FIELDS.slice().sort()).toEqual([
      'schema', 'flavor_relation', 'test_type_relation', 'coverage_target_status',
      'coverage_report_status', 'warning_code_counts', 'module_failed_setup_count',
      'execution_mode_counts',
    ].sort());
  });
});

describe('validateOutcomeObservabilitySummary -- the single shared validator both consumers call', () => {
  it('accepts a well-formed summary', () => {
    expect(validateOutcomeObservabilitySummary(wellFormedSummary(), 'outcome_observability_summary')).toEqual([]);
  });

  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 'x', 1, []]) {
      expect(validateOutcomeObservabilitySummary(bad, 'outcome_observability_summary').length).toBeGreaterThan(0);
    }
  });

  it('rejects schema !== 1', () => {
    expect(validateOutcomeObservabilitySummary(wellFormedSummary({ schema: 2 }), 'x').some((e) => e.field === 'x.schema')).toBe(true);
  });

  it('rejects a missing key', () => {
    for (const key of OUTCOME_OBSERVABILITY_SUMMARY_FIELDS) {
      const { [key]: _omit, ...summary } = wellFormedSummary();
      expect(validateOutcomeObservabilitySummary(summary, 'x').some((e) => e.field.startsWith(`x.${key}`) || e.field === `x.${key}`)).toBe(true);
    }
  });

  it('rejects an unrecognized extra key', () => {
    const summary = wellFormedSummary({ raw_command: 'kmp-test parallel --module-filter secret' });
    expect(validateOutcomeObservabilitySummary(summary, 'x').some((e) => e.field === 'x.raw_command')).toBe(true);
  });

  // Requirement 2/7 (review-round finding): EVERY allowed enum value is genuinely accepted, not
  // just one arbitrary fallback -- and one clearly unknown value is genuinely rejected, per field.
  const ENUM_FIELDS = [
    ['flavor_relation', FLAVOR_RELATION_VALUES],
    ['test_type_relation', TEST_TYPE_RELATION_VALUES],
    ['coverage_target_status', COVERAGE_TARGET_STATUS_VALUES],
    ['coverage_report_status', COVERAGE_REPORT_STATUS_VALUES],
  ];
  for (const [field, values] of ENUM_FIELDS) {
    // A single test with an internal loop, not it.each(values) -- values is undefined until this
    // module actually exports it, and it.each(undefined) aborts the whole FILE's collection
    // ("Tests: no tests"), which is not an isolated, traceable RED assertion (review-round
    // finding) -- a for-of over undefined throws INSIDE this one test body instead.
    it(`${field} accepts every allowed value`, () => {
      for (const value of values) {
        const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ [field]: value }), 'x');
        expect(errors.some((e) => e.field === `x.${field}`)).toBe(false);
      }
    });
    it(`${field} rejects an unrecognized value`, () => {
      const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ [field]: 'totally-not-a-real-value' }), 'x');
      expect(errors.some((e) => e.field === `x.${field}`)).toBe(true);
    });
    it.each([1, true, null, undefined])(`${field} rejects a wrong-typed value %j`, (value) => {
      const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ [field]: value }), 'x');
      expect(errors.some((e) => e.field === `x.${field}`)).toBe(true);
    });
  }

  describe('warning_code_counts -- closed count map', () => {
    it('accepts every approved code independently set to a real positive count', () => {
      for (const code of COVERAGE_GATE_WARNING_BUCKET_FIELDS) {
        const counts = Object.fromEntries(COVERAGE_GATE_WARNING_BUCKET_FIELDS.map((f) => [f, f === code ? 3 : 0]));
        const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ warning_code_counts: counts }), 'x');
        expect(errors.filter((e) => e.field.startsWith('x.warning_code_counts'))).toEqual([]);
      }
    });
    it('rejects a missing approved code', () => {
      const { coverage_xml_disabled: _omit, ...counts } = wellFormedSummary().warning_code_counts;
      const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ warning_code_counts: counts }), 'x');
      expect(errors.some((e) => e.field === 'x.warning_code_counts.coverage_xml_disabled')).toBe(true);
    });
    it('rejects an unrecognized code', () => {
      const counts = { ...wellFormedSummary().warning_code_counts, made_up_code: 0 };
      const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ warning_code_counts: counts }), 'x');
      expect(errors.some((e) => e.field === 'x.warning_code_counts.made_up_code')).toBe(true);
    });
    it.each([-1, 1.5, '2', true, null])('rejects a %j count for one code', (bad) => {
      const counts = { ...wellFormedSummary().warning_code_counts, coverage_xml_disabled: bad };
      const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ warning_code_counts: counts }), 'x');
      expect(errors.some((e) => e.field === 'x.warning_code_counts.coverage_xml_disabled')).toBe(true);
    });
  });

  describe('execution_mode_counts -- closed count map, same shape/rules as warning_code_counts', () => {
    it('accepts every mode independently set to a real positive count', () => {
      for (const mode of EXECUTION_MODE_VALUES) {
        const counts = Object.fromEntries(EXECUTION_MODE_VALUES.map((f) => [f, f === mode ? 2 : 0]));
        const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ execution_mode_counts: counts }), 'x');
        expect(errors.filter((e) => e.field.startsWith('x.execution_mode_counts'))).toEqual([]);
      }
    });
    it.each([-1, 1.5, '2', true])('rejects a %j count for one mode', (bad) => {
      const counts = { ...wellFormedSummary().execution_mode_counts, fresh: bad };
      const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ execution_mode_counts: counts }), 'x');
      expect(errors.some((e) => e.field === 'x.execution_mode_counts.fresh')).toBe(true);
    });
  });

  it.each([-1, 1.5, '2', true])('rejects a module_failed_setup_count of %j', (bad) => {
    const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ module_failed_setup_count: bad }), 'x');
    expect(errors.some((e) => e.field === 'x.module_failed_setup_count')).toBe(true);
  });
  it('accepts a real non-negative integer module_failed_setup_count', () => {
    const errors = validateOutcomeObservabilitySummary(wellFormedSummary({ module_failed_setup_count: 0 }), 'x');
    expect(errors.some((e) => e.field === 'x.module_failed_setup_count')).toBe(false);
  });
});
