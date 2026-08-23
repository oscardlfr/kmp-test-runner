import { describe, expect, it } from 'vitest';
import {
  buildCorrelationObservability,
  validateCorrelationObservability,
} from '../../tools/agentic-eval/correlation-observability.mjs';

function attempt({ id = 'toolu-1', kind = 'shell', found = true, command = null } = {}) {
  return { id, kind, command, result: { found } };
}

function observation({ attempts = [], issues = [], malformedLineCount = 0, effectiveIncomplete = null } = {}) {
  const strictIncompleteToolResults = attempts
    .filter((item) => item.result.found === false)
    .map((item, index) => ({ index, receiptNs: 1n, name: item.kind, id: item.id }));
  return {
    toolAttempts: attempts,
    transcript: {
      malformedLineCount,
      strictStructuralIssues: issues,
      strictIncompleteToolResults,
      effectiveIncompleteToolResults: effectiveIncomplete ?? strictIncompleteToolResults,
    },
  };
}

function dispatch(overrides = {}) {
  return {
    hookEvaluatedCount: 0,
    preDispatchBlockedCount: 0,
    resultCorrelatedNoPolicyCount: 0,
    unaccountedCount: 0,
    ...overrides,
  };
}

describe('buildCorrelationObservability', () => {
  it('emits only the closed count-only contract for a correlated no-policy condition', () => {
    const summary = buildCorrelationObservability({
      condition: 'no-skill',
      policyMode: 'not_applicable',
      observation: observation({
        attempts: [
          attempt({ id: 'sensitive-shell-id', command: 'secret command --path C:\\private' }),
          attempt({ id: 'sensitive-skill-id', kind: 'skill' }),
        ],
      }),
      dispatchAccounting: dispatch({ resultCorrelatedNoPolicyCount: 1 }),
    });

    expect(summary).toEqual({
      schema: 1,
      condition: 'no-skill',
      policy_mode: 'not_applicable',
      tool_use_counts_by_kind: { shell: 1, skill: 1, other: 0 },
      missing_id_counts_by_kind: { shell: 0, skill: 0, other: 0 },
      missing_result_counts_by_kind: { shell: 0, skill: 0, other: 0 },
      dispatch_status_counts: {
        hook_evaluated: 0,
        pre_dispatch_blocked: 0,
        result_correlated_no_policy: 1,
        unaccounted: 0,
        unclassified: 0,
      },
      correlation_issue_counts: {
        duplicate_tool_use_id: 0,
        orphan_tool_result_missing_id: 0,
        orphan_tool_result_unknown_id: 0,
        duplicate_tool_result: 0,
        malformed_stream_line: 0,
      },
      timeout_tolerance_applied: false,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('sensitive-shell-id');
    expect(serialized).not.toContain('secret command');
    expect(serialized).not.toContain('C:\\private');
  });

  it('distinguishes a missing tool-use id from an ordinary absent result', () => {
    const summary = buildCorrelationObservability({
      condition: 'no-skill',
      policyMode: 'not_applicable',
      observation: observation({ attempts: [attempt({ id: null, found: false })] }),
      dispatchAccounting: dispatch(),
    });

    expect(summary.missing_id_counts_by_kind).toEqual({ shell: 1, skill: 0, other: 0 });
    expect(summary.missing_result_counts_by_kind).toEqual({ shell: 1, skill: 0, other: 0 });
    expect(summary.dispatch_status_counts.unclassified).toBe(1);
  });

  it('distinguishes an absent matching result from a mismatched result id', () => {
    const absent = buildCorrelationObservability({
      condition: 'no-skill', policyMode: 'not_applicable',
      observation: observation({ attempts: [attempt({ found: false })] }),
      dispatchAccounting: dispatch({ unaccountedCount: 1 }),
    });
    const mismatched = buildCorrelationObservability({
      condition: 'no-skill', policyMode: 'not_applicable',
      observation: observation({
        attempts: [attempt({ found: false })],
        issues: [{ type: 'orphan_tool_result', id: 'different-sensitive-id' }],
      }),
      dispatchAccounting: dispatch({ unaccountedCount: 1 }),
    });

    expect(absent.missing_result_counts_by_kind.shell).toBe(1);
    expect(absent.correlation_issue_counts.orphan_tool_result_unknown_id).toBe(0);
    expect(mismatched.missing_result_counts_by_kind.shell).toBe(1);
    expect(mismatched.correlation_issue_counts.orphan_tool_result_unknown_id).toBe(1);
    expect(JSON.stringify(mismatched)).not.toContain('different-sensitive-id');
  });

  it('records parser-shape gaps as a count, never malformed content', () => {
    const summary = buildCorrelationObservability({
      condition: 'current-skill', policyMode: 'required',
      observation: observation({ malformedLineCount: 2 }),
      dispatchAccounting: dispatch(),
    });
    expect(summary.correlation_issue_counts.malformed_stream_line).toBe(2);
  });

  it('keeps the strict missing-result count when a legitimate timeout makes the effective gate complete', () => {
    const summary = buildCorrelationObservability({
      condition: 'no-skill', policyMode: 'not_applicable',
      observation: observation({ attempts: [attempt({ found: false })], effectiveIncomplete: [] }),
      dispatchAccounting: dispatch({ unaccountedCount: 1 }),
    });
    expect(summary.missing_result_counts_by_kind.shell).toBe(1);
    expect(summary.timeout_tolerance_applied).toBe(true);
  });
});

describe('validateCorrelationObservability', () => {
  it('fails closed on unknown keys, negative counts, or dispatch cardinality contradictions', () => {
    const valid = buildCorrelationObservability({
      condition: 'no-skill', policyMode: 'not_applicable',
      observation: observation({ attempts: [attempt()] }),
      dispatchAccounting: dispatch({ resultCorrelatedNoPolicyCount: 1 }),
    });
    expect(validateCorrelationObservability(valid)).toEqual({ ok: true, errors: [] });
    expect(validateCorrelationObservability({ ...valid, raw: 'forbidden' }).ok).toBe(false);
    expect(validateCorrelationObservability({
      ...valid,
      missing_result_counts_by_kind: { ...valid.missing_result_counts_by_kind, shell: -1 },
    }).ok).toBe(false);
    expect(validateCorrelationObservability({
      ...valid,
      dispatch_status_counts: { ...valid.dispatch_status_counts, unclassified: 1 },
    }).ok).toBe(false);
  });
});
