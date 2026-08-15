// tests/vitest/agentic-eval-pre-dispatch-block.test.js
// Covers the Claude Code pre-dispatch tool-block matcher (stream-parser.mjs) and the canonical
// per-attempt dispatch accounting (dispatch-accounting.mjs).
//
// Background: Claude Code 2.1.227 can reject a Bash tool_use at its OWN tool layer, before ever
// dispatching the PreToolUse:Bash hook. The transcript then shows a Bash tool_use with NO hook
// events and an immediate is_error tool_result. The aggregate hook accounting cannot tell that
// apart from a Bash call that genuinely bypassed the policy hook, so the distinction is made
// here -- deliberately keyed on the exact observed product strings, never on loose words like
// "Blocked"/"Error"/"permission", never on event distance or duration alone.
//
// The recognized set is exactly one command (`sleep 60`) because that is the only command the
// incident actually demonstrated. Widening it requires fresh real product evidence.
import { describe, it, expect } from 'vitest';
import {
  findBashToolUsesWithResults,
  countHookEvents,
  isRecognizedPreDispatchBlock,
} from '../../tools/agentic-eval/stream-parser.mjs';
import { buildBashDispatchAccounting, DISPATCH_STATUS_VALUES } from '../../tools/agentic-eval/dispatch-accounting.mjs';
import { validateAcceptedRunAuditSidecar } from '../../tools/agentic-eval/accepted-run-audit.mjs';

// The exact strings observed on the real incident transcript (events 34-35), written out here as
// literals INDEPENDENTLY of the implementation so this file genuinely pins the product shape
// rather than restating whatever the matcher happens to build.
const BODY = 'Blocked: standalone sleep 60. To wait for a condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.';
const BLOCKED_CONTENT = `<tool_use_error>${BODY}</tool_use_error>`;
const BLOCKED_TOOL_USE_RESULT = `Error: ${BODY}`;

function bashUseEvent(id, command) {
  return {
    type: 'assistant',
    message: { model: 'm', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Wait for background test run' } }] },
  };
}

function blockedResultEvent(id, { content = BLOCKED_CONTENT, toolUseResult = BLOCKED_TOOL_USE_RESULT, isError = true, extraBlocks = [], omitToolUseResult = false } = {}) {
  const ev = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }, ...extraBlocks] },
  };
  if (!omitToolUseResult) ev.tool_use_result = toolUseResult;
  return ev;
}

/** The single recognized shape, as one transcript. */
function incidentEvents(command = 'sleep 60', resultOpts = {}) {
  return [bashUseEvent('toolu_blocked', command), blockedResultEvent('toolu_blocked', resultOpts)];
}

function firstBash(events) {
  return findBashToolUsesWithResults(events)[0];
}

describe('isRecognizedPreDispatchBlock -- the exact demonstrated shape', () => {
  it('recognizes the real incident shape', () => {
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents()))).toBe(true);
  });

  // Only `sleep 60` was ever demonstrated. Neighbouring durations are NOT assumed to belong to
  // the same class -- a fail-closed matcher must not widen the observed contract.
  it.each(['sleep 59', 'sleep 600', 'sleep 6', 'sleep 60.0', 'sleep 061'])(
    'rejects the undemonstrated command %j',
    (command) => {
      expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents(command)))).toBe(false);
    },
  );

  it.each([' sleep 60', 'sleep 60 ', 'sleep  60', '\tsleep 60', 'sleep 60\n'])(
    'rejects whitespace-divergent command %j',
    (command) => {
      expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents(command)))).toBe(false);
    },
  );

  it.each(['sleep 60 --foo', 'sleep 60 && ls', 'sleep 60; ls', 'sleep 60 | cat', 'echo x && sleep 60'])(
    'rejects option/chained command %j',
    (command) => {
      expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents(command)))).toBe(false);
    },
  );

  it('rejects an unwrapped body (no <tool_use_error> wrapper)', () => {
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { content: BODY })))).toBe(false);
  });

  it.each([
    ['missing closing tag', `<tool_use_error>${BODY}`],
    ['missing opening tag', `${BODY}</tool_use_error>`],
    ['prefixed text', `note: ${BLOCKED_CONTENT}`],
    ['suffixed text', `${BLOCKED_CONTENT} trailing`],
    ['truncated body', BLOCKED_CONTENT.slice(0, -30)],
    ['different inner message', '<tool_use_error>Blocked: something else entirely.</tool_use_error>'],
  ])('rejects malformed content -- %s', (_label, content) => {
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { content })))).toBe(false);
  });

  it.each([
    ['divergent text', 'Error: Blocked: standalone sleep 60.'],
    ['wrapper retained', BLOCKED_CONTENT],
    ['missing Error: prefix', BODY],
  ])('rejects divergent tool_use_result -- %s', (_label, toolUseResult) => {
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { toolUseResult })))).toBe(false);
  });

  it('rejects an object tool_use_result (the union is real; only the string form was observed)', () => {
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { toolUseResult: { success: false } })))).toBe(false);
  });

  it('rejects a missing tool_use_result', () => {
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { omitToolUseResult: true })))).toBe(false);
  });

  it('rejects a non-error result even when every string matches', () => {
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { isError: false })))).toBe(false);
  });

  // tool_use_result is EVENT-level, so it is only unambiguously attributable when the event
  // carries exactly one content block. Two blocks => which result does the string describe?
  it('rejects a user event carrying a sibling content block', () => {
    const extra = [{ type: 'text', text: 'chatter' }];
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { extraBlocks: extra })))).toBe(false);
  });

  it('rejects a user event carrying two tool_results', () => {
    const extra = [{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'ok' }];
    expect(isRecognizedPreDispatchBlock(firstBash(incidentEvents('sleep 60', { extraBlocks: extra })))).toBe(false);
  });

  it('rejects a non-immediate result (an event intervenes between tool_use and tool_result)', () => {
    const events = [
      bashUseEvent('toolu_blocked', 'sleep 60'),
      { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' },
      blockedResultEvent('toolu_blocked'),
    ];
    expect(isRecognizedPreDispatchBlock(firstBash(events))).toBe(false);
  });

  it('rejects a Bash call with no correlated result at all', () => {
    expect(isRecognizedPreDispatchBlock(firstBash([bashUseEvent('toolu_blocked', 'sleep 60')]))).toBe(false);
  });

  it.each([null, undefined, 'string', 42, []])('rejects non-object input %j', (bad) => {
    expect(isRecognizedPreDispatchBlock(bad)).toBe(false);
  });

  it('rejects an entry whose tool name is not Bash', () => {
    const entry = { ...firstBash(incidentEvents()), name: 'Read' };
    expect(isRecognizedPreDispatchBlock(entry)).toBe(false);
  });
});

describe('countHookEvents -- additive hookPairingOk', () => {
  function hookPair(id) {
    return [
      { type: 'system', subtype: 'hook_started', hook_id: id, hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' },
      { type: 'system', subtype: 'hook_response', hook_id: id, hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', output: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) },
    ];
  }

  it('exposes hookPairingOk:true for cleanly paired hook ids', () => {
    const events = [bashUseEvent('t1', 'kmp-test doctor --json'), ...hookPair('h1')];
    expect(countHookEvents(events).hookPairingOk).toBe(true);
  });

  it('exposes hookPairingOk:false on a duplicated hook id', () => {
    const events = [bashUseEvent('t1', 'x'), ...hookPair('h1'), ...hookPair('h1')];
    expect(countHookEvents(events).hookPairingOk).toBe(false);
  });

  it('exposes hookPairingOk:true even when a Bash call was never hooked (pairing is about ids only)', () => {
    // Two Bash calls, one hook pair: the ids that DO exist are cleanly paired, so hookPairingOk
    // is true while everyCallHooked is false. Keeping these orthogonal is what lets the dispatch
    // accounting reuse pairing without re-parsing hook events.
    const events = [bashUseEvent('t1', 'x'), ...hookPair('h1'), bashUseEvent('t2', 'sleep 60')];
    const stats = countHookEvents(events);
    expect(stats.hookPairingOk).toBe(true);
    expect(stats.everyCallHooked).toBe(false);
  });
});

describe('buildBashDispatchAccounting -- canonical per-attempt classification', () => {
  const HOOK_STATS_CLEAN = { hookCallCount: 1, hookResponseCount: 1, hookAllowCount: 1, hookDenyCount: 0, hookPairingOk: true, everyCallHooked: true };

  function bash(id, command = 'kmp-test doctor --json') {
    return { id, command, index: 0, resultFound: true, resultIsError: false };
  }

  it('returns exactly the closed field set', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1')],
      hookStats: HOOK_STATS_CLEAN,
      decisionByAttempt: new Map([['t1', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(Object.keys(out).sort()).toEqual([
      'dispatchStatusByAttempt',
      'everyCallAccountedFor',
      'hookEvaluatedCount',
      'preDispatchBlockedCount',
      'unaccountedCount',
    ]);
  });

  it('classifies a fully hook-evaluated transcript', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1')],
      hookStats: HOOK_STATS_CLEAN,
      decisionByAttempt: new Map([['t1', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.dispatchStatusByAttempt.get('t1')).toBe('hook_evaluated');
    expect(out.hookEvaluatedCount).toBe(1);
    expect(out.preDispatchBlockedCount).toBe(0);
    expect(out.unaccountedCount).toBe(0);
    expect(out.everyCallAccountedFor).toBe(true);
  });

  it('classifies the incident: one pre-dispatch block alongside one hook-evaluated call', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1'), bash('t2', 'sleep 60')],
      hookStats: HOOK_STATS_CLEAN,
      decisionByAttempt: new Map([['t1', 'allow'], ['t2', null]]),
      preDispatchBlockedAttemptIds: new Set(['t2']),
    });
    expect(out.dispatchStatusByAttempt.get('t1')).toBe('hook_evaluated');
    expect(out.dispatchStatusByAttempt.get('t2')).toBe('pre_dispatch_blocked');
    expect(out.hookEvaluatedCount).toBe(1);
    expect(out.preDispatchBlockedCount).toBe(1);
    expect(out.unaccountedCount).toBe(0);
    expect(out.everyCallAccountedFor).toBe(true);
  });

  it('fails closed on an unrecognized unhooked call', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1'), bash('t2', 'sleep 60')],
      hookStats: HOOK_STATS_CLEAN,
      decisionByAttempt: new Map([['t1', 'allow'], ['t2', null]]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.dispatchStatusByAttempt.get('t2')).toBe('unaccounted');
    expect(out.unaccountedCount).toBe(1);
    expect(out.everyCallAccountedFor).toBe(false);
  });

  // A residual/fabricated decision sidecar must never stand in for the hook event pair itself.
  it('fails closed when a decision exists but the stream has no matching hook pair', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1'), bash('t2')],
      hookStats: { ...HOOK_STATS_CLEAN, hookCallCount: 1, hookResponseCount: 1, hookAllowCount: 1 },
      decisionByAttempt: new Map([['t1', 'allow'], ['t2', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.hookEvaluatedCount).toBe(2);
    expect(out.everyCallAccountedFor).toBe(false);
  });

  it('fails closed when hookAllowCount disagrees with decisionByAttempt totals', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1')],
      hookStats: { ...HOOK_STATS_CLEAN, hookAllowCount: 0, hookDenyCount: 1 },
      decisionByAttempt: new Map([['t1', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.everyCallAccountedFor).toBe(false);
  });

  it('fails closed when hook ids are not cleanly paired', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1')],
      hookStats: { ...HOOK_STATS_CLEAN, hookPairingOk: false },
      decisionByAttempt: new Map([['t1', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.everyCallAccountedFor).toBe(false);
  });

  it('fails closed on a duplicated Bash tool_use id (a Map would silently collapse it)', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('dup'), bash('dup')],
      hookStats: { ...HOOK_STATS_CLEAN, hookCallCount: 2, hookResponseCount: 2, hookAllowCount: 2 },
      decisionByAttempt: new Map([['dup', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.everyCallAccountedFor).toBe(false);
  });

  it.each([null, undefined, '', 42])('fails closed on a non-string/empty Bash id %j', (id) => {
    const out = buildBashDispatchAccounting({
      bashResults: [{ id, command: 'x', index: 0 }],
      hookStats: { ...HOOK_STATS_CLEAN, hookCallCount: 0, hookResponseCount: 0, hookAllowCount: 0 },
      decisionByAttempt: new Map(),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.everyCallAccountedFor).toBe(false);
  });

  it('fails closed when preDispatchBlockedAttemptIds is not a subset of the Bash ids', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1')],
      hookStats: HOOK_STATS_CLEAN,
      decisionByAttempt: new Map([['t1', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(['ghost']),
    });
    expect(out.everyCallAccountedFor).toBe(false);
  });

  it('fails closed on an allow/deny decision that is also flagged as a recognized block', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1')],
      hookStats: HOOK_STATS_CLEAN,
      decisionByAttempt: new Map([['t1', 'allow']]),
      preDispatchBlockedAttemptIds: new Set(['t1']),
    });
    expect(out.everyCallAccountedFor).toBe(false);
  });

  it('keys dispatchStatusByAttempt exactly to the Bash id set', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1'), bash('t2', 'sleep 60')],
      hookStats: HOOK_STATS_CLEAN,
      decisionByAttempt: new Map([['t1', 'allow'], ['t2', null]]),
      preDispatchBlockedAttemptIds: new Set(['t2']),
    });
    expect([...out.dispatchStatusByAttempt.keys()].sort()).toEqual(['t1', 't2']);
  });

  it('treats a deny exactly like an allow for accounting purposes', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [bash('t1')],
      hookStats: { ...HOOK_STATS_CLEAN, hookAllowCount: 0, hookDenyCount: 1 },
      decisionByAttempt: new Map([['t1', 'deny']]),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.dispatchStatusByAttempt.get('t1')).toBe('hook_evaluated');
    expect(out.everyCallAccountedFor).toBe(true);
  });

  it('accepts a transcript with no Bash calls at all', () => {
    const out = buildBashDispatchAccounting({
      bashResults: [],
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookAllowCount: 0, hookDenyCount: 0, hookPairingOk: true, everyCallHooked: true },
      decisionByAttempt: new Map(),
      preDispatchBlockedAttemptIds: new Set(),
    });
    expect(out.everyCallAccountedFor).toBe(true);
    expect(out.dispatchStatusByAttempt.size).toBe(0);
  });
});

// Single-source-of-truth guard: the sidecar's dispatch_status vocabulary is derived from the
// accounting module's, so a new Bash dispatch status cannot be added in one place and silently
// rejected by the validator in the other.
describe('dispatch_status vocabulary has one source of truth', () => {
  it('every Bash dispatch status the accounting can emit is accepted by the sidecar validator', () => {
    for (const status of DISPATCH_STATUS_VALUES) {
      const sidecar = {
        schema: 2, run_id: 'scenario-current-skill-abcd1234', run_schema: 5, run_kind: 'scenario',
        condition: 'current-skill', scenario_id: 's', first_useful_signal_event: null,
        terminal_authoritative_event: null,
        tool_calls: [{
          ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash',
          operation: null, plan_only: false,
          policy_decision: status === 'hook_evaluated' ? 'allow' : status === 'pre_dispatch_blocked' ? 'not-applicable' : 'missing',
          result_status: status === 'pre_dispatch_blocked' ? 'error' : 'success',
          phase: 'no-signal', dispatch_status: status,
        }],
        summary: {
          tool_calls_total: 1, shell_commands_total: 1, post_signal_ms: null, post_signal_tool_calls: null,
          policy_denials_total: 0, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null,
          policy_decisions_missing: status === 'unaccounted' ? 1 : 0,
          pre_dispatch_blocked_total: status === 'pre_dispatch_blocked' ? 1 : 0,
        },
      };
      // Only the VOCABULARY/biconditional half is asserted here. `unaccounted` is separately (and
      // correctly) rejected by the accepted-sidecar invariant that policy_decisions_missing must be
      // exactly 0 -- an accepted run cannot contain an unaccounted Bash call. That invariant is not
      // a vocabulary error, so it is excluded rather than asserted away.
      const fields = validateAcceptedRunAuditSidecar(sidecar).errors
        .map((e) => e.field)
        .filter((f) => f !== 'summary.policy_decisions_missing');
      expect({ status, fields }).toEqual({ status, fields: [] });
    }
  });

  it('an unaccounted Bash call can never appear in a VALID accepted sidecar', () => {
    const sidecar = {
      schema: 2, run_id: 'scenario-current-skill-abcd1234', run_schema: 5, run_kind: 'scenario',
      condition: 'current-skill', scenario_id: 's', first_useful_signal_event: null,
      terminal_authoritative_event: null,
      tool_calls: [{
        ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash',
        operation: null, plan_only: false, policy_decision: 'missing', result_status: 'success',
        phase: 'no-signal', dispatch_status: 'unaccounted',
      }],
      summary: {
        tool_calls_total: 1, shell_commands_total: 1, post_signal_ms: null, post_signal_tool_calls: null,
        policy_denials_total: 0, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null,
        policy_decisions_missing: 1, pre_dispatch_blocked_total: 0,
      },
    };
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.map((e) => e.field)).toContain('summary.policy_decisions_missing');
  });

  it('the accounting vocabulary is exactly the Bash statuses -- not_applicable is sidecar-only', () => {
    expect([...DISPATCH_STATUS_VALUES].sort()).toEqual(['hook_evaluated', 'pre_dispatch_blocked', 'unaccounted']);
  });
});
