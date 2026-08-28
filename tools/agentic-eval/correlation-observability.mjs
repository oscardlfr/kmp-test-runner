#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { POLICY_MODE_VALUES } from './dispatch-accounting.mjs';
import { TOOL_ATTEMPT_KINDS } from './runtimes/contract.mjs';

const CONDITIONS = Object.freeze(['current-skill', 'no-skill']);
const TOP_LEVEL_KEYS = Object.freeze([
  'schema', 'condition', 'policy_mode', 'tool_use_counts_by_kind',
  'missing_id_counts_by_kind', 'missing_result_counts_by_kind',
  'dispatch_status_counts', 'correlation_issue_counts', 'timeout_tolerance_applied',
]);
const DISPATCH_COUNT_KEYS_V1 = Object.freeze([
  'hook_evaluated', 'pre_dispatch_blocked', 'result_correlated_no_policy',
  'unaccounted', 'unclassified',
]);
const DISPATCH_COUNT_KEYS_V2 = Object.freeze([
  'hook_evaluated', 'pre_dispatch_blocked', 'result_correlated_no_policy',
  'timeout_interrupted_no_policy', 'unaccounted', 'unclassified',
]);
const CORRELATION_ISSUE_KEYS = Object.freeze([
  'duplicate_tool_use_id', 'orphan_tool_result_missing_id',
  'orphan_tool_result_unknown_id', 'duplicate_tool_result', 'malformed_stream_line',
]);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function freezeSummary(summary) {
  for (const key of [
    'tool_use_counts_by_kind', 'missing_id_counts_by_kind', 'missing_result_counts_by_kind',
    'dispatch_status_counts', 'correlation_issue_counts',
  ]) Object.freeze(summary[key]);
  return Object.freeze(summary);
}

/**
 * Validates the closed, privacy-safe correlation-observability schema. The schema contains only
 * fixed enum values, non-negative counts, and one boolean; it cannot carry tool ids, commands,
 * paths, transcript text, prompts, responses, or timestamps.
 */
export function validateCorrelationObservability(value) {
  const errors = [];
  if (!exactKeys(value, TOP_LEVEL_KEYS)) {
    return { ok: false, errors: [{ field: '$', code: 'invalid_shape' }] };
  }
  if (value.schema !== 1 && value.schema !== 2) errors.push({ field: 'schema', code: 'invalid_value' });
  if (!CONDITIONS.includes(value.condition)) errors.push({ field: 'condition', code: 'invalid_value' });
  if (!POLICY_MODE_VALUES.includes(value.policy_mode)) errors.push({ field: 'policy_mode', code: 'invalid_value' });

  for (const field of ['tool_use_counts_by_kind', 'missing_id_counts_by_kind', 'missing_result_counts_by_kind']) {
    if (!exactKeys(value[field], TOOL_ATTEMPT_KINDS)) {
      errors.push({ field, code: 'invalid_shape' });
      continue;
    }
    for (const key of TOOL_ATTEMPT_KINDS) {
      if (!nonNegativeInteger(value[field][key])) errors.push({ field: `${field}.${key}`, code: 'invalid_value' });
    }
  }
  const dispatchCountKeys = value.schema === 1 ? DISPATCH_COUNT_KEYS_V1 : DISPATCH_COUNT_KEYS_V2;
  if (!exactKeys(value.dispatch_status_counts, dispatchCountKeys)) {
    errors.push({ field: 'dispatch_status_counts', code: 'invalid_shape' });
  } else {
    for (const key of dispatchCountKeys) {
      if (!nonNegativeInteger(value.dispatch_status_counts[key])) errors.push({ field: `dispatch_status_counts.${key}`, code: 'invalid_value' });
    }
  }
  if (!exactKeys(value.correlation_issue_counts, CORRELATION_ISSUE_KEYS)) {
    errors.push({ field: 'correlation_issue_counts', code: 'invalid_shape' });
  } else {
    for (const key of CORRELATION_ISSUE_KEYS) {
      if (!nonNegativeInteger(value.correlation_issue_counts[key])) errors.push({ field: `correlation_issue_counts.${key}`, code: 'invalid_value' });
    }
  }
  if (typeof value.timeout_tolerance_applied !== 'boolean') errors.push({ field: 'timeout_tolerance_applied', code: 'invalid_type' });

  if (exactKeys(value.tool_use_counts_by_kind, TOOL_ATTEMPT_KINDS)) {
    for (const field of ['missing_id_counts_by_kind', 'missing_result_counts_by_kind']) {
      if (!exactKeys(value[field], TOOL_ATTEMPT_KINDS)) continue;
      for (const kind of TOOL_ATTEMPT_KINDS) {
        if (nonNegativeInteger(value[field][kind]) && nonNegativeInteger(value.tool_use_counts_by_kind[kind])
          && value[field][kind] > value.tool_use_counts_by_kind[kind]) {
          errors.push({ field: `${field}.${kind}`, code: 'invalid_relation' });
        }
      }
    }
  }
  if (exactKeys(value.dispatch_status_counts, dispatchCountKeys)
    && exactKeys(value.tool_use_counts_by_kind, TOOL_ATTEMPT_KINDS)
    && dispatchCountKeys.every((key) => nonNegativeInteger(value.dispatch_status_counts[key]))
    && nonNegativeInteger(value.tool_use_counts_by_kind.shell)) {
    const classifiedShellCount = dispatchCountKeys.reduce((sum, key) => sum + value.dispatch_status_counts[key], 0);
    if (classifiedShellCount !== value.tool_use_counts_by_kind.shell) {
      errors.push({ field: 'dispatch_status_counts', code: 'invalid_relation' });
    }
    if (value.policy_mode === 'required' && value.dispatch_status_counts.result_correlated_no_policy !== 0) {
      errors.push({ field: 'dispatch_status_counts.result_correlated_no_policy', code: 'invalid_relation' });
    }
    if (value.schema === 2 && value.policy_mode === 'required' && value.dispatch_status_counts.timeout_interrupted_no_policy !== 0) {
      errors.push({ field: 'dispatch_status_counts.timeout_interrupted_no_policy', code: 'invalid_relation' });
    }
    if (value.schema === 2 && value.dispatch_status_counts.timeout_interrupted_no_policy > 0) {
      if (value.timeout_tolerance_applied !== true) errors.push({ field: 'timeout_tolerance_applied', code: 'invalid_relation' });
      if (value.dispatch_status_counts.timeout_interrupted_no_policy > 1) errors.push({ field: 'dispatch_status_counts.timeout_interrupted_no_policy', code: 'invalid_relation' });
      if (exactKeys(value.missing_result_counts_by_kind, TOOL_ATTEMPT_KINDS)
        && value.dispatch_status_counts.timeout_interrupted_no_policy > value.missing_result_counts_by_kind.shell) {
        errors.push({ field: 'dispatch_status_counts.timeout_interrupted_no_policy', code: 'invalid_relation' });
      }
    }
    if (value.policy_mode === 'not_applicable' && value.dispatch_status_counts.hook_evaluated !== 0) {
      errors.push({ field: 'dispatch_status_counts.hook_evaluated', code: 'invalid_relation' });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Builds a count-only projection from the canonical observation and dispatch-accounting objects.
 * The strict missing-result view is retained even when timeout tolerance makes the effective gate
 * complete; timeout_tolerance_applied records that exact distinction without weakening the gate.
 */
export function buildCorrelationObservability({ condition, policyMode, observation, dispatchAccounting }) {
  if (!CONDITIONS.includes(condition)) throw new Error('correlation observability: invalid condition');
  if (!POLICY_MODE_VALUES.includes(policyMode)) throw new Error('correlation observability: invalid policy mode');
  if (!isPlainObject(observation) || !Array.isArray(observation.toolAttempts) || !isPlainObject(observation.transcript)) {
    throw new Error('correlation observability: invalid observation');
  }
  const transcript = observation.transcript;
  if (!Array.isArray(transcript.strictStructuralIssues)
    || !Array.isArray(transcript.strictIncompleteToolResults)
    || !Array.isArray(transcript.effectiveIncompleteToolResults)
    || !nonNegativeInteger(transcript.malformedLineCount)) {
    throw new Error('correlation observability: invalid transcript projection');
  }

  const toolUseCounts = zeroCounts(TOOL_ATTEMPT_KINDS);
  const missingIdCounts = zeroCounts(TOOL_ATTEMPT_KINDS);
  const missingResultCounts = zeroCounts(TOOL_ATTEMPT_KINDS);
  for (const attempt of observation.toolAttempts) {
    if (!isPlainObject(attempt) || !TOOL_ATTEMPT_KINDS.includes(attempt.kind)
      || !isPlainObject(attempt.result) || typeof attempt.result.found !== 'boolean') {
      throw new Error('correlation observability: invalid tool attempt');
    }
    toolUseCounts[attempt.kind] += 1;
    if (typeof attempt.id !== 'string' || attempt.id.length === 0) missingIdCounts[attempt.kind] += 1;
    if (attempt.result.found === false) missingResultCounts[attempt.kind] += 1;
  }

  const dispatchStatusCounts = zeroCounts(DISPATCH_COUNT_KEYS_V2);
  if (dispatchAccounting != null) {
    const sourceFields = {
      hook_evaluated: 'hookEvaluatedCount',
      pre_dispatch_blocked: 'preDispatchBlockedCount',
      result_correlated_no_policy: 'resultCorrelatedNoPolicyCount',
      timeout_interrupted_no_policy: 'timeoutInterruptedNoPolicyCount',
      unaccounted: 'unaccountedCount',
    };
    for (const [target, source] of Object.entries(sourceFields)) {
      if (!nonNegativeInteger(dispatchAccounting[source])) throw new Error('correlation observability: invalid dispatch accounting');
      dispatchStatusCounts[target] = dispatchAccounting[source];
    }
  }
  const classifiedShellCount = DISPATCH_COUNT_KEYS_V2
    .filter((key) => key !== 'unclassified')
    .reduce((sum, key) => sum + dispatchStatusCounts[key], 0);
  if (classifiedShellCount > toolUseCounts.shell) throw new Error('correlation observability: dispatch count exceeds shell attempts');
  dispatchStatusCounts.unclassified = toolUseCounts.shell - classifiedShellCount;

  const correlationIssueCounts = zeroCounts(CORRELATION_ISSUE_KEYS);
  correlationIssueCounts.malformed_stream_line = transcript.malformedLineCount;
  for (const issue of transcript.strictStructuralIssues) {
    if (!isPlainObject(issue)) throw new Error('correlation observability: invalid structural issue');
    if (issue.type === 'duplicate_tool_use_id') correlationIssueCounts.duplicate_tool_use_id += 1;
    if (issue.type === 'duplicate_tool_result') correlationIssueCounts.duplicate_tool_result += 1;
    if (issue.type === 'orphan_tool_result') {
      if (typeof issue.id === 'string' && issue.id.length > 0) correlationIssueCounts.orphan_tool_result_unknown_id += 1;
      else correlationIssueCounts.orphan_tool_result_missing_id += 1;
    }
  }

  const summary = {
    schema: 2,
    condition,
    policy_mode: policyMode,
    tool_use_counts_by_kind: toolUseCounts,
    missing_id_counts_by_kind: missingIdCounts,
    missing_result_counts_by_kind: missingResultCounts,
    dispatch_status_counts: dispatchStatusCounts,
    correlation_issue_counts: correlationIssueCounts,
    timeout_tolerance_applied: transcript.strictIncompleteToolResults.length > 0
      && transcript.effectiveIncompleteToolResults.length === 0,
  };
  const validation = validateCorrelationObservability(summary);
  if (!validation.ok) throw new Error('correlation observability: constructed invalid summary');
  return freezeSummary(summary);
}
