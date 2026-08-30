// SPDX-License-Identifier: MIT
// Closed, privacy-safe error categories for coverage-gate attempt diagnostics.
// Never retain raw error codes, messages, commands, tasks, modules, or paths.
import { CONFIG_ERROR_CODES, ENV_ERROR_CODES } from '../../lib/envelope/exit-codes.js';

export const COVERAGE_GATE_ERROR_BUCKET_FIELDS = Object.freeze([
  'coverage_threshold_exceeded',
  'module_failed',
  'gradle_timeout',
  'no_test_modules',
  'environment_other',
  'configuration',
  'other',
]);

function emptyErrorCodeBuckets() {
  return Object.fromEntries(COVERAGE_GATE_ERROR_BUCKET_FIELDS.map((field) => [field, 0]));
}

function bucketForErrorCode(code) {
  if (code === 'coverage_threshold_exceeded') return 'coverage_threshold_exceeded';
  if (code === 'module_failed') return 'module_failed';
  if (code === 'gradle_timeout') return 'gradle_timeout';
  if (code === 'no_test_modules') return 'no_test_modules';
  if (ENV_ERROR_CODES.has(code)) return 'environment_other';
  if (CONFIG_ERROR_CODES.has(code)) return 'configuration';
  return 'other';
}

export function summarizeCoverageGateErrors(errors) {
  if (!Array.isArray(errors)) return null;
  const errorCodeBuckets = emptyErrorCodeBuckets();
  for (const error of errors) {
    errorCodeBuckets[bucketForErrorCode(error?.code)] += 1;
  }
  return {
    error_count: errors.length,
    error_code_buckets: errorCodeBuckets,
  };
}

// ---------------------------------------------------------------------------------------------
// Evidence1 success-recovery PR B (Section 9.9): the single authorized source of Section 9.9's
// closed enums and shared validator for the privacy-safe outcome_observability_summary object --
// imported verbatim by BOTH accepted-run-audit.mjs (schema 10) and rejection-diagnostics.mjs
// (schema 13), so the two consumers can never independently drift on vocabulary (review-round
// finding: two hand-copied array literals proved this exact drift risk during Stage B2).
// ---------------------------------------------------------------------------------------------

export const FLAVOR_RELATION_VALUES = Object.freeze(['absent', 'explicit-match', 'explicit-mismatch', 'unexpected', 'not-applicable', 'not-recorded']);
export const TEST_TYPE_RELATION_VALUES = Object.freeze(['absent', 'match', 'mismatch', 'not-applicable', 'not-recorded']);
export const COVERAGE_TARGET_STATUS_VALUES = Object.freeze(['with-data', 'no-xml', 'parse-error', 'unavailable', 'not-applicable', 'not-recorded']);
export const COVERAGE_REPORT_STATUS_VALUES = Object.freeze(['not-attempted', 'success', 'failed', 'unavailable', 'not-recorded']);
export const EXECUTION_MODE_VALUES = Object.freeze(['fresh', 'from-cache', 'up-to-date', 'no-evidence', 'not-recorded']);
// A DIFFERENT closed vocabulary from COVERAGE_GATE_ERROR_BUCKET_FIELDS above (that one buckets
// terminal kmp-test ERROR codes; this one buckets kmp-test WARNING codes) -- grounded directly
// against every `warnings.push({code: ...})` call site in lib/orchestrators/{coverage,parallel}-
// orchestrator.js (verified by grep, not assumed), never a re-derivation of the error-code set.
export const COVERAGE_GATE_WARNING_BUCKET_FIELDS = Object.freeze([
  'no_coverage_data',
  'coverage_xml_disabled',
  'coverage_xml_oversized',
  'coverage_parse_failed',
  'coverage_aggregation_drift',
  'coverage_report_write_failed',
  'coverage_report_dispatch_failed',
  'coverage_aggregation_failed',
  'coverage_aggregation_skipped',
]);
export const OUTCOME_OBSERVABILITY_SUMMARY_FIELDS = Object.freeze([
  'schema', 'flavor_relation', 'test_type_relation', 'coverage_target_status',
  'coverage_report_status', 'warning_code_counts', 'module_failed_setup_count',
  'execution_mode_counts',
]);

/** Builds an all-zero closed count map keyed by `fields` -- the canonical "no source data yet
 * counted" shape both warning_code_counts and execution_mode_counts share. */
function emptyCountMap(fields) {
  return Object.fromEntries(fields.map((f) => [f, 0]));
}

/** A closed count map's own shared shape/value validation -- exact key set (never an arbitrary
 * key, Section 9.9's own privacy boundary: an unrecognized key name is exactly the kind of
 * free-form content this object must never carry), every value a non-negative integer. */
function validateClosedCountMap(map, fieldPrefix, allowedKeys, errors) {
  if (map == null || typeof map !== 'object' || Array.isArray(map)) {
    errors.push({ field: fieldPrefix, message: 'must be an object' });
    return;
  }
  const keys = new Set(Object.keys(map));
  for (const k of allowedKeys) {
    if (!keys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'missing required field' });
  }
  for (const k of keys) {
    if (!allowedKeys.includes(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: `unrecognized field -- only ${allowedKeys.join(', ')} allowed` });
  }
  for (const k of allowedKeys) {
    if (!keys.has(k)) continue;
    const v = map[k];
    if (!(Number.isInteger(v) && v >= 0)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'must be a non-negative integer' });
  }
}

/** Builds the closed, privacy-safe fallback summary (Section 9.9) for when no source data exists
 * to compute any of its fields yet -- every enum resolves to its own "not-recorded" (or
 * "not-applicable" where that is the more precise closed value), every count map all-zero,
 * module_failed_setup_count null. Callers with REAL structured data override individual fields
 * on top of this base -- never re-declare the whole shape independently. */
export function emptyOutcomeObservabilitySummary() {
  return {
    schema: 1,
    flavor_relation: 'not-recorded',
    test_type_relation: 'not-recorded',
    coverage_target_status: 'not-recorded',
    coverage_report_status: 'not-recorded',
    warning_code_counts: emptyCountMap(COVERAGE_GATE_WARNING_BUCKET_FIELDS),
    module_failed_setup_count: null,
    execution_mode_counts: emptyCountMap(EXECUTION_MODE_VALUES),
  };
}

/** The single shared validator both accepted-run-audit.mjs (schema 10) and
 * rejection-diagnostics.mjs (schema 13) call for their own, otherwise-identical
 * outcome_observability_summary object -- never a validator each file re-implements against its
 * own locally-duplicated enum copy (Section 9.9, review-round finding). Returns a FRESH
 * `{field, message}` array (never mutates a caller-supplied one) so a caller folds it into a
 * larger validation pass at whatever field-name prefix its own context requires (e.g.
 * `outcome_observability_summary` at accepted-sidecar root, `cells[3].outcome_observability_summary`
 * inside a rejection-diagnostics row) via `errors.push(...validateOutcomeObservabilitySummary(...))`.
 * @param {unknown} summary
 * @param {string} fieldPrefix
 * @returns {Array<{field:string, message:string}>}
 */
export function validateOutcomeObservabilitySummary(summary, fieldPrefix) {
  const errors = [];
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
    errors.push({ field: fieldPrefix, message: 'must be an object' });
    return errors;
  }
  const allowedKeys = OUTCOME_OBSERVABILITY_SUMMARY_FIELDS;
  const keys = new Set(Object.keys(summary));
  for (const k of allowedKeys) {
    if (!keys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'missing required field' });
  }
  for (const k of keys) {
    if (!allowedKeys.includes(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: `unrecognized field -- only ${allowedKeys.join(', ')} allowed` });
  }
  if (summary.schema !== 1) {
    errors.push({ field: `${fieldPrefix}.schema`, message: 'must be exactly 1' });
  }
  if (!FLAVOR_RELATION_VALUES.includes(summary.flavor_relation)) {
    errors.push({ field: `${fieldPrefix}.flavor_relation`, message: `must be one of ${FLAVOR_RELATION_VALUES.join('|')}` });
  }
  if (!TEST_TYPE_RELATION_VALUES.includes(summary.test_type_relation)) {
    errors.push({ field: `${fieldPrefix}.test_type_relation`, message: `must be one of ${TEST_TYPE_RELATION_VALUES.join('|')}` });
  }
  if (!COVERAGE_TARGET_STATUS_VALUES.includes(summary.coverage_target_status)) {
    errors.push({ field: `${fieldPrefix}.coverage_target_status`, message: `must be one of ${COVERAGE_TARGET_STATUS_VALUES.join('|')}` });
  }
  if (!COVERAGE_REPORT_STATUS_VALUES.includes(summary.coverage_report_status)) {
    errors.push({ field: `${fieldPrefix}.coverage_report_status`, message: `must be one of ${COVERAGE_REPORT_STATUS_VALUES.join('|')}` });
  }
  validateClosedCountMap(summary.warning_code_counts, `${fieldPrefix}.warning_code_counts`, COVERAGE_GATE_WARNING_BUCKET_FIELDS, errors);
  validateClosedCountMap(summary.execution_mode_counts, `${fieldPrefix}.execution_mode_counts`, EXECUTION_MODE_VALUES, errors);
  const moduleFailedSetupCount = summary.module_failed_setup_count;
  if (!(moduleFailedSetupCount === null || (Number.isInteger(moduleFailedSetupCount) && moduleFailedSetupCount >= 0))) {
    errors.push({ field: `${fieldPrefix}.module_failed_setup_count`, message: 'must be a non-negative integer or null' });
  }
  return errors;
}
