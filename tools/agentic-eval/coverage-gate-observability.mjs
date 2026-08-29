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
