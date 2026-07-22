// tests/vitest/agentic-eval-stream-parser.test.js
// Unit tests for tools/agentic-eval/stream-parser.mjs, using the sanitized synthetic fixtures
// derived from real Step-1 captures (never the raw capture itself -- see fixtures/README notes).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseStreamJsonl,
  findInitEvent,
  findResultEvent,
  isSkillAvailable,
  isTargetSkillReference,
  findSkillInvocation,
  findForeignSkillUses,
  classifyForeignSkillUses,
  hasExpectedPluginProfile,
  findBashToolUses,
  findBashToolUsesWithResults,
  findTranscriptStructuralIssues,
  findTranscriptStructuralIssuesToleratingTimeout,
  findIncompleteToolResults,
  findIncompleteToolResultsToleratingTimeout,
  countHookEvents,
  computeByteMetrics,
  extractTokenUsage,
  deriveFirstUsefulSignalMs,
} from '../../tools/agentic-eval/stream-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const currentSkillRaw = readFileSync(path.join(__dirname, 'fixtures', 'agentic-eval-stream-current-skill.jsonl'), 'utf8');
const noSkillRaw = readFileSync(path.join(__dirname, 'fixtures', 'agentic-eval-stream-no-skill.jsonl'), 'utf8');
const malformedRaw = '{"type":"system","subtype":"init","tools":["Bash"]}\nnot valid json at all\n{"type":"result","subtype":"success"}\n';

describe('parseStreamJsonl', () => {
  it('parses every well-formed line of a real (sanitized) current-skill capture', () => {
    const { events, malformedLines } = parseStreamJsonl(currentSkillRaw);
    expect(events.length).toBeGreaterThan(0);
    expect(malformedLines).toEqual([]);
  });

  it('tags every event with a receipt index/ns', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    for (const ev of events) expect(ev._receiptNs).toBeDefined();
  });

  it('isolates malformed lines instead of throwing, and still parses the well-formed ones around them', () => {
    const { events, malformedLines } = parseStreamJsonl(malformedRaw);
    expect(events.length).toBe(2);
    expect(malformedLines.length).toBe(1);
    expect(malformedLines[0].line).toContain('not valid json');
  });

  it('handles a fully empty capture without throwing', () => {
    const { events, malformedLines } = parseStreamJsonl('');
    expect(events).toEqual([]);
    expect(malformedLines).toEqual([]);
  });

  it('isolates syntactically-valid JSON that is not an event object (null/string/number/array), instead of crashing on the whole parse', () => {
    // Each of these parses successfully via JSON.parse -- assigning _receiptNs to a
    // non-object throws in strict mode (every .mjs is strict), which would previously abort
    // the entire parse rather than just skipping the one malformed line.
    const raw = [
      '{"type":"system","subtype":"init","tools":["Bash"]}',
      'null',
      '"just a string"',
      '42',
      '[1,2,3]',
      '{"type":"result","subtype":"success"}',
    ].join('\n');
    const { events, malformedLines } = parseStreamJsonl(raw);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('system');
    expect(events[1].type).toBe('result');
    expect(malformedLines.length).toBe(4);
    for (const m of malformedLines) expect(m.error).toContain('must be a JSON object');
  });
});

// isTargetSkillReference is the ONE place that decides whether a Skill tool_use's `input.skill`
// refers to the logical target skill (pluginName, skillName) -- see stream-parser.mjs's own doc
// comment for the full rationale. pluginName/skillName are tested here with DIFFERENT literal
// values (not just this harness's own coincidental 'kmp-test-runner'/'kmp-test-runner' pair)
// specifically to prove the canonical form is genuinely `${pluginName}:${skillName}`, never
// derived by assuming the two always coincide.
describe('isTargetSkillReference -- closed allowlist for the two accepted skill-identity forms', () => {
  it('accepts the bare skill name', () => {
    expect(isTargetSkillReference('my-skill', 'my-plugin', 'my-skill')).toBe(true);
  });

  it('accepts the canonical plugin-namespaced form, built from the SEPARATE plugin/skill names', () => {
    expect(isTargetSkillReference('my-plugin:my-skill', 'my-plugin', 'my-skill')).toBe(true);
  });

  it('this harness\'s own coincidental case (plugin and skill share one literal value) still works', () => {
    expect(isTargetSkillReference('kmp-test-runner', 'kmp-test-runner', 'kmp-test-runner')).toBe(true);
    expect(isTargetSkillReference('kmp-test-runner:kmp-test-runner', 'kmp-test-runner', 'kmp-test-runner')).toBe(true);
  });

  it('rejects the skill name doubled on itself -- proves the canonical form is NOT derived as ${skillName}:${skillName}', () => {
    expect(isTargetSkillReference('my-skill:my-skill', 'my-plugin', 'my-skill')).toBe(false);
  });

  it('rejects the plugin name doubled on itself -- proves the canonical form is NOT derived as ${pluginName}:${pluginName}', () => {
    expect(isTargetSkillReference('my-plugin:my-plugin', 'my-plugin', 'my-skill')).toBe(false);
  });

  it('rejects a foreign namespace prefix', () => {
    expect(isTargetSkillReference('evil:kmp-test-runner', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects a DIFFERENT skill from the SAME plugin', () => {
    expect(isTargetSkillReference('kmp-test-runner:some-other-skill', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects a casing variant of the bare form', () => {
    expect(isTargetSkillReference('Kmp-Test-Runner', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects a casing variant of the namespaced form', () => {
    expect(isTargetSkillReference('KMP-TEST-RUNNER:KMP-TEST-RUNNER', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects leading/trailing whitespace', () => {
    expect(isTargetSkillReference(' kmp-test-runner', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
    expect(isTargetSkillReference('kmp-test-runner ', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
    expect(isTargetSkillReference('kmp-test-runner: kmp-test-runner', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects a double/nested namespace, prefixed', () => {
    expect(isTargetSkillReference('a:kmp-test-runner:kmp-test-runner', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects a double/nested namespace, suffixed', () => {
    expect(isTargetSkillReference('kmp-test-runner:kmp-test-runner:extra', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects non-string skillArg values (undefined, null, number, object)', () => {
    expect(isTargetSkillReference(undefined, 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
    expect(isTargetSkillReference(null, 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
    expect(isTargetSkillReference(42, 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
    expect(isTargetSkillReference({ toString: () => 'kmp-test-runner' }, 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isTargetSkillReference('', 'kmp-test-runner', 'kmp-test-runner')).toBe(false);
  });

  // P2 (post-#385 review): fails closed on a misconfigured IDENTITY too, not just a malformed
  // skillArg -- without this, a caller accidentally passing pluginName:undefined would silently
  // match a wire value literally containing the string "undefined" (JS's own template-literal
  // coercion turns `${undefined}:foo` into the real string 'undefined:foo'), and skillName:''
  // would match an empty-string skillArg. No real call site does this today, but the exported
  // function's own contract promises a closed allowlist regardless of caller correctness.
  describe('fails closed when pluginName/skillName themselves are misconfigured', () => {
    it('an undefined pluginName never matches, even a wire value literally containing "undefined"', () => {
      expect(isTargetSkillReference('undefined:kmp-test-runner', undefined, 'kmp-test-runner')).toBe(false);
      expect(isTargetSkillReference('kmp-test-runner', undefined, 'kmp-test-runner')).toBe(false);
    });

    it('a null pluginName never matches, even a wire value literally containing "null"', () => {
      expect(isTargetSkillReference('null:kmp-test-runner', null, 'kmp-test-runner')).toBe(false);
    });

    it('an undefined skillName never matches, even a wire value literally containing "undefined"', () => {
      expect(isTargetSkillReference('kmp-test-runner:undefined', 'kmp-test-runner', undefined)).toBe(false);
      expect(isTargetSkillReference('undefined', 'kmp-test-runner', undefined)).toBe(false);
    });

    it('a null skillName never matches, even a wire value literally containing "null"', () => {
      expect(isTargetSkillReference('null', 'kmp-test-runner', null)).toBe(false);
    });

    it('an empty-string skillName never matches an empty-string skillArg', () => {
      expect(isTargetSkillReference('', 'kmp-test-runner', '')).toBe(false);
    });

    it('an empty-string pluginName never matches the bare-colon namespaced form', () => {
      expect(isTargetSkillReference(':kmp-test-runner', '', 'kmp-test-runner')).toBe(false);
    });

    it('both identities misconfigured at once still returns false, never throws', () => {
      expect(isTargetSkillReference('anything', undefined, undefined)).toBe(false);
      expect(isTargetSkillReference('anything', null, null)).toBe(false);
      expect(isTargetSkillReference('anything', '', '')).toBe(false);
    });
  });
});

describe('skill availability and invocation detection (real captured event shapes)', () => {
  it('current-skill fixture: plugin is available in init.plugins', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const init = findInitEvent(events);
    expect(isSkillAvailable(init, 'kmp-test-runner')).toBe(true);
  });

  it('current-skill fixture: a real Skill tool_use event is found and CONFIRMED (matching, non-error tool_result)', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(invocation).not.toBeNull();
    expect(invocation.type).toBe('assistant.tool_use.Skill');
    expect(typeof invocation.index).toBe('number');
    expect(invocation.attempted).toBe(true);
    expect(invocation.confirmed).toBe(true);
    expect(invocation.resultIsError).toBe(false);
  });

  it('no-skill fixture: plugin is absent from init.plugins', () => {
    const { events } = parseStreamJsonl(noSkillRaw);
    const init = findInitEvent(events);
    expect(isSkillAvailable(init, 'kmp-test-runner')).toBe(false);
  });

  it('no-skill fixture: no Skill tool_use event is found', () => {
    const { events } = parseStreamJsonl(noSkillRaw);
    expect(findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner')).toBeNull();
  });

  it('does not match a differently-named skill', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    expect(findSkillInvocation(events, 'some-other-skill', 'some-other-skill')).toBeNull();
  });

  // The real, confirmed shape from a live 2026-07-22 rejection: Claude Code 2.1.217 invoked this
  // harness's own target skill via its plugin-namespaced identity, not the bare form every prior
  // fixture/live capture happened to use.
  describe('the plugin-namespaced form is a genuine target-skill invocation, not a different skill', () => {
    it('is found and CONFIRMED exactly like the bare form', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_ns1', name: 'Skill', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ns1', is_error: false, content: 'real skill output' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation).not.toBeNull();
      expect(invocation.attempted).toBe(true);
      expect(invocation.confirmed).toBe(true);
      expect(invocation.resultIsError).toBe(false);
    });

    it('a namespaced attempt that gets rejected ("Unknown skill") is attempted but NOT confirmed -- same as the bare form', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_ns2', name: 'Skill', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ns2', is_error: true, content: '<tool_use_error>Unknown skill: kmp-test-runner:kmp-test-runner</tool_use_error>' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attempted).toBe(true);
      expect(invocation.confirmed).toBe(false);
      expect(invocation.resultIsError).toBe(true);
    });

    it('the namespaced form is never classified as a foreign skill', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_ns3', name: 'Skill', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ns3', is_error: false, content: 'ok' }] } },
      ];
      expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
    });

    it('a mixed bare-then-namespaced retry sequence aggregates BOTH attempts toward the same logical skill', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_mix1', name: 'Skill', input: { skill: 'kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mix1', is_error: true, content: '<tool_use_error>Unknown skill: kmp-test-runner</tool_use_error>' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_mix2', name: 'Skill', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mix2', is_error: false, content: 'ok' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attemptCount).toBe(2);
      expect(invocation.confirmed).toBe(true);
    });

    it('a mixed namespaced-then-bare retry sequence also aggregates both, order-independent', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_mix3', name: 'Skill', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mix3', is_error: true, content: '<tool_use_error>Unknown skill</tool_use_error>' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_mix4', name: 'Skill', input: { skill: 'kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mix4', is_error: false, content: 'ok' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attemptCount).toBe(2);
      expect(invocation.confirmed).toBe(true);
    });

    // A no-skill condition (plugin never loaded) is still free to have the model TRY the
    // namespaced form -- Claude Code itself returns a real "Unknown skill" error either way, since
    // neither form resolves when the plugin isn't loaded. Must be proven directly, mirroring the
    // existing bare-form "Unknown skill" regression coverage above.
    it('no-skill condition: an attempted namespaced invocation still correctly receives a real "Unknown skill" error', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_noskill_ns', name: 'Skill', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_noskill_ns', is_error: true, content: '<tool_use_error>Unknown skill: kmp-test-runner:kmp-test-runner</tool_use_error>' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attempted).toBe(true);
      expect(invocation.confirmed).toBe(false);
      expect(invocation.resultIsError).toBe(true);
      // Still never classified as a foreign/contaminating call, even though it was rejected.
      expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
    });
  });

  // Regression coverage for a real bug found by an independent review pass: a version of this
  // function that only checked for the Skill tool_use block (never its own tool_result) reported
  // skill_invoked:true for a no-skill run where the model attempted the invocation and was told
  // "Unknown skill: kmp-test-runner" -- directly contradicting skill_available:false in the same
  // record. Event shapes below are copied verbatim (only session/tool ids changed) from a real
  // captured "no-skill" calibration transcript.
  describe('attempt vs. confirmed invocation (real "Unknown skill" transcript shape)', () => {
    function toolUseEvent(id) {
      return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'kmp-test-runner' }, caller: { type: 'direct' } }] } };
    }

    it('an attempted invocation whose own tool_result is an error is NOT confirmed', () => {
      const events = [
        toolUseEvent('toolu_regression0001'),
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '<tool_use_error>Unknown skill: kmp-test-runner</tool_use_error>', is_error: true, tool_use_id: 'toolu_regression0001' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attempted).toBe(true);
      expect(invocation.confirmed).toBe(false);
      expect(invocation.resultIsError).toBe(true);
    });

    it('an attempted invocation with no matching tool_result yet is NOT assumed confirmed', () => {
      const events = [toolUseEvent('toolu_regression0002')];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attempted).toBe(true);
      expect(invocation.confirmed).toBe(false);
      expect(invocation.resultIsError).toBeNull();
    });

    it('a tool_result for a DIFFERENT tool_use_id does not confirm this invocation', () => {
      const events = [
        toolUseEvent('toolu_regression0003'),
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'unrelated', tool_use_id: 'toolu_some_other_call' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.confirmed).toBe(false);
    });

    it('a tool_use with no id at all cannot be correlated, so it is never confirmed', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 'toolu_unrelated' }] } },
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attempted).toBe(true);
      expect(invocation.confirmed).toBe(false);
    });
  });

  // Regression coverage for a real bug an independent review pass demonstrated: an earlier
  // version of findSkillInvocation returned on the FIRST matching tool_use, ignoring any later
  // ones. A no-skill arm whose SECOND attempt actually succeeded (a real availability
  // contradiction worth catching) previously read confirmed:false, since only attempt 1 (which
  // failed) was ever considered; the inverse -- a current-skill arm whose first attempt happened
  // to fail transiently but whose second succeeded -- was previously reported as an unconfirmed,
  // wrongly-rejected run for the same reason.
  describe('multiple Skill attempts in one transcript are all aggregated, not just the first', () => {
    function toolUseEvent(id, skill = 'kmp-test-runner') {
      return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] } };
    }
    function toolResultEvent(id, isError) {
      return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: isError ? '<tool_use_error>Unknown skill: kmp-test-runner</tool_use_error>' : 'ok', is_error: isError, tool_use_id: id }] } };
    }

    it('an initial failed attempt followed by a later successful retry is CONFIRMED, not just attempt 1', () => {
      const events = [
        toolUseEvent('toolu_try1'), toolResultEvent('toolu_try1', true),
        toolUseEvent('toolu_try2'), toolResultEvent('toolu_try2', false),
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attempted).toBe(true);
      expect(invocation.confirmed).toBe(true);
      expect(invocation.attemptCount).toBe(2);
      // The representative event must be the one that actually PROVES confirmed:true -- not the
      // earlier, failed attempt.
      expect(invocation.resultIsError).toBe(false);
    });

    it('an initial successful attempt followed by a later unrelated failure is still CONFIRMED (order-independent)', () => {
      const events = [
        toolUseEvent('toolu_try1'), toolResultEvent('toolu_try1', false),
        toolUseEvent('toolu_try2'), toolResultEvent('toolu_try2', true),
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.confirmed).toBe(true);
      expect(invocation.attemptCount).toBe(2);
    });

    it('two failed attempts are still NOT confirmed, and attemptCount reflects both', () => {
      const events = [
        toolUseEvent('toolu_try1'), toolResultEvent('toolu_try1', true),
        toolUseEvent('toolu_try2'), toolResultEvent('toolu_try2', true),
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.confirmed).toBe(false);
      expect(invocation.attemptCount).toBe(2);
    });

    it('a single attempt still reports attemptCount:1 (no regression on the common case)', () => {
      const events = [toolUseEvent('toolu_only'), toolResultEvent('toolu_only', false)];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attemptCount).toBe(1);
    });

    it('a second call to a DIFFERENT skill name does not count toward kmp-test-runner\'s attemptCount', () => {
      const events = [
        toolUseEvent('toolu_try1'), toolResultEvent('toolu_try1', false),
        toolUseEvent('toolu_try2', 'some-other-skill'), toolResultEvent('toolu_try2', false),
      ];
      const invocation = findSkillInvocation(events, 'kmp-test-runner', 'kmp-test-runner');
      expect(invocation.attemptCount).toBe(1);
    });
  });
});

// Regression coverage for a real gap an independent review pass demonstrated against the relaxed
// calibration contract: findUnexpectedToolUses only checks the tool NAME (Bash/Skill), never a
// Skill call's own `input.skill` argument -- a transcript that called Skill with some OTHER skill
// name entirely passes it outright, while findSkillInvocation(events, pluginName, skillName)
// simply never matches that call (scoped to the target skill only), so a foreign skill invocation
// is invisible to skill_invocation_attempted/skill_invoked and could silently coexist with
// attempted:false/invoked:false for the expected skill.
describe('findForeignSkillUses -- detects Skill calls NOT targeting the expected skill', () => {
  function skillToolUse(skillArg) {
    const input = skillArg === undefined ? {} : { skill: skillArg };
    return { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Skill', input }] } };
  }

  it('returns empty for a transcript with only matching-skill calls (bare form)', () => {
    const events = [skillToolUse('kmp-test-runner')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
  });

  it('returns empty for a transcript with only matching-skill calls (canonical namespaced form)', () => {
    const events = [skillToolUse('kmp-test-runner:kmp-test-runner')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
  });

  it('returns empty for a transcript with no Skill calls at all', () => {
    const events = [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }] } }];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
  });

  it('flags a Skill call targeting a completely different skill name', () => {
    const events = [skillToolUse('some-other-skill')];
    const foreign = findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(foreign.length).toBe(1);
    expect(foreign[0].skillArg).toBe('some-other-skill');
  });

  it('flags a foreign namespace prefix', () => {
    const events = [skillToolUse('evil:kmp-test-runner')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(1);
  });

  it('flags a DIFFERENT skill from the SAME plugin -- namespace prefix alone is not sufficient', () => {
    const events = [skillToolUse('kmp-test-runner:some-other-skill-in-this-plugin')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(1);
  });

  it('flags a casing variant', () => {
    const events = [skillToolUse('KMP-TEST-RUNNER:KMP-TEST-RUNNER')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(1);
  });

  it('flags a double/nested namespace', () => {
    const events = [skillToolUse('kmp-test-runner:kmp-test-runner:extra')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(1);
  });

  it('flags a Skill call with a missing input.skill', () => {
    const events = [skillToolUse(undefined)];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(1);
  });

  it('flags a Skill call with a non-string (malformed) input.skill', () => {
    const events = [skillToolUse(42)];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(1);
  });

  it('flags a Skill call with an empty-string input.skill', () => {
    const events = [skillToolUse('')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(1);
  });

  it('flags EVERY foreign call, not just the first, when several are present', () => {
    const events = [skillToolUse('other-1'), skillToolUse('kmp-test-runner'), skillToolUse('other-2')];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner').length).toBe(2);
  });

  it('never flags a Bash call -- scoped to Skill tool_use blocks only', () => {
    const events = [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kmp-test doctor --json' } }] } }];
    expect(findForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
  });
});

// Result-aware foreign-Skill classification: a real live scenario run failed its hard gate purely
// because findForeignSkillUses is input-argument-only (see above) -- it cannot distinguish a
// REJECTED foreign attempt (harmless, measurable agent behavior) from a CONFIRMED one (genuine
// contamination) or a missing/incomplete result (a broken capture). classifyForeignSkillUses adds
// that distinction on top, mirroring findSkillInvocation's/findBashToolUsesWithResults' identical
// tri-state correlation pattern.
describe('classifyForeignSkillUses -- result-aware foreign-Skill classification', () => {
  function foreignToolUse(id, skillArg) {
    const input = skillArg === undefined ? {} : { skill: skillArg };
    return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Skill', input }] } };
  }
  function toolResultEvent(id, isError) {
    return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? '<tool_use_error>Unknown skill: some-other-skill</tool_use_error>' : 'ok' }] } };
  }

  it('returns [] when there are no foreign Skill calls (mirrors findForeignSkillUses exactly)', () => {
    const events = [foreignToolUse('toolu_1', 'kmp-test-runner')];
    expect(classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
  });

  it('returns [] for the canonical namespaced form too', () => {
    const events = [foreignToolUse('toolu_1', 'kmp-test-runner:kmp-test-runner')];
    expect(classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner')).toEqual([]);
  });

  it('classifies a rejected foreign attempt (is_error:true) -- confirmed:false, resultIsError:true', () => {
    const events = [foreignToolUse('toolu_1', 'some-other-skill'), toolResultEvent('toolu_1', true)];
    const [entry] = classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(entry.skillArg).toBe('some-other-skill');
    expect(entry.resultIsError).toBe(true);
    expect(entry.confirmed).toBe(false);
  });

  it('classifies a confirmed foreign invocation via explicit is_error:false -- confirmed:true', () => {
    const events = [foreignToolUse('toolu_1', 'some-other-skill'), toolResultEvent('toolu_1', false)];
    const [entry] = classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(entry.resultIsError).toBe(false);
    expect(entry.confirmed).toBe(true);
  });

  // Round-1 audit finding: findToolResultById's isError check is `c.is_error === true` -- an
  // ABSENT is_error key (not just an explicit false) also reads as isError:false, matching the
  // documented tool_result contract where a missing is_error means success. Must be proven
  // directly with its own fixture shape, not merely assumed from the explicit-false case above.
  it('classifies a confirmed foreign invocation when is_error is absent entirely -- also confirmed:true', () => {
    const events = [
      foreignToolUse('toolu_1', 'some-other-skill'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'some real skill output' }] } },
    ];
    const [entry] = classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(entry.resultIsError).toBe(false);
    expect(entry.confirmed).toBe(true);
  });

  it('classifies a missing/incomplete result (no correlated tool_result at all) -- resultIsError:null, confirmed:false', () => {
    const events = [foreignToolUse('toolu_1', 'some-other-skill')];
    const [entry] = classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(entry.resultIsError).toBeNull();
    expect(entry.confirmed).toBe(false);
  });

  it('a tool_use with no id cannot be correlated, so it is always classified as incomplete', () => {
    const events = [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'some-other-skill' } }] } }];
    const [entry] = classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(entry.resultIsError).toBeNull();
    expect(entry.confirmed).toBe(false);
  });

  it('classifies multiple foreign calls independently -- no aggregation across attempts (unlike findSkillInvocation)', () => {
    const events = [
      foreignToolUse('toolu_1', 'skill-a'), toolResultEvent('toolu_1', true), // rejected
      foreignToolUse('toolu_2', 'skill-b'), toolResultEvent('toolu_2', false), // confirmed
      foreignToolUse('toolu_3', 'skill-c'), // incomplete -- no result attached
    ];
    const results = classifyForeignSkillUses(events, 'kmp-test-runner', 'kmp-test-runner');
    expect(results.length).toBe(3);
    expect(results.map((r) => r.skillArg)).toEqual(['skill-a', 'skill-b', 'skill-c']);
    expect(results[0]).toMatchObject({ resultIsError: true, confirmed: false });
    expect(results[1]).toMatchObject({ resultIsError: false, confirmed: true });
    expect(results[2]).toMatchObject({ resultIsError: null, confirmed: false });
  });
});

// hasExpectedPluginProfile's expectedPluginName is the PLUGIN's own identity (plugins[].name),
// never the skill's -- confirmed with a plugin/skill pair whose names genuinely differ, mirroring
// isTargetSkillReference's own separate-identity proof above.
describe('hasExpectedPluginProfile -- matches on plugin identity, not skill identity', () => {
  it('matches when exactly one plugin is loaded under its own (possibly skill-differing) name', () => {
    const init = { plugins: [{ name: 'my-plugin', path: '/fake', source: 'fake' }] };
    expect(hasExpectedPluginProfile(init, 'my-plugin', true)).toBe(true);
  });

  it('does not match against the skill name when it differs from the plugin name', () => {
    const init = { plugins: [{ name: 'my-plugin', path: '/fake', source: 'fake' }] };
    expect(hasExpectedPluginProfile(init, 'my-skill', true)).toBe(false);
  });
});

describe('hook accounting -- proves every Bash call reached the policy hook', () => {
  it('counts hook_started/hook_response 1:1 with Bash tool_use calls in a real capture', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const bashCalls = findBashToolUses(events);
    const hookStats = countHookEvents(events);
    expect(hookStats.hookCallCount).toBe(bashCalls.length);
    expect(hookStats.hookResponseCount).toBe(bashCalls.length);
    expect(hookStats.everyCallHooked).toBe(true);
  });

  it('reports everyCallHooked:false when counts diverge', () => {
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }] } },
    ];
    expect(countHookEvents(events).everyCallHooked).toBe(false);
  });

  function hookEvent(subtype, hookId, extra = {}) {
    return { type: 'system', subtype, hook_id: hookId, hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', ...extra };
  }
  function bashUse() {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }] } };
  }
  const allowResponse = { output: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) };

  it('reports everyCallHooked:false when a duplicate hook_id makes aggregate counts balance despite one Bash call never being hooked', () => {
    // 2 real Bash calls, but the SAME hook_id fires twice for the first one while the second
    // call is never hooked at all -- a pure count comparison (2 Bash === 2 started === 2
    // response) would wrongly report true; id-set/uniqueness checking must catch this.
    const events = [
      bashUse(),
      hookEvent('hook_started', 'dup-id'), hookEvent('hook_started', 'dup-id'),
      hookEvent('hook_response', 'dup-id', allowResponse), hookEvent('hook_response', 'dup-id', allowResponse),
      bashUse(),
    ];
    const stats = countHookEvents(events);
    expect(stats.hookCallCount).toBe(2);
    expect(stats.hookResponseCount).toBe(2);
    expect(stats.everyCallHooked).toBe(false);
  });

  it('ignores hook events for a different hook_name (non-Bash tool) when counting', () => {
    const events = [
      bashUse(),
      hookEvent('hook_started', 'id-1'), hookEvent('hook_response', 'id-1', allowResponse),
      { type: 'system', subtype: 'hook_started', hook_id: 'id-unrelated', hook_name: 'PreToolUse:SomeOtherTool', hook_event: 'PreToolUse' },
      { type: 'system', subtype: 'hook_response', hook_id: 'id-unrelated', hook_name: 'PreToolUse:SomeOtherTool', hook_event: 'PreToolUse', ...allowResponse },
    ];
    const stats = countHookEvents(events);
    expect(stats.hookCallCount).toBe(1);
    expect(stats.hookResponseCount).toBe(1);
    expect(stats.everyCallHooked).toBe(true);
  });

  it('reports everyCallHooked:true for genuinely distinct, correctly-paired hook ids (real fixture, post-fix)', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const stats = countHookEvents(events);
    expect(stats.hookCallCount).toBe(2);
    expect(new Set(events.filter((e) => e.subtype === 'hook_started').map((e) => e.hook_id)).size).toBe(2);
    expect(stats.everyCallHooked).toBe(true);
  });
});

describe('byte metrics -- output_bytes vs stream_json_bytes are distinct numbers', () => {
  it('computes two different, correctly-scoped values from the same capture', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const { outputBytes, streamJsonBytes } = computeByteMetrics(currentSkillRaw, events);
    expect(typeof outputBytes).toBe('number');
    expect(typeof streamJsonBytes).toBe('number');
    expect(streamJsonBytes).toBeGreaterThan(outputBytes);
    expect(streamJsonBytes).toBe(Buffer.byteLength(currentSkillRaw, 'utf8'));
  });
});

describe('extractTokenUsage', () => {
  it('extracts the four token fields from a real result event', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const result = findResultEvent(events);
    const usage = extractTokenUsage(result);
    expect(usage).toHaveProperty('input');
    expect(usage).toHaveProperty('output');
    expect(usage).toHaveProperty('cache_read');
    expect(usage).toHaveProperty('cache_creation');
  });

  it('returns null when there is no result event', () => {
    expect(extractTokenUsage(null)).toBeNull();
  });
});

describe('deriveFirstUsefulSignalMs -- index-to-ms derivation is the only place timing happens', () => {
  it('derives a non-negative ms value from a valid event index', () => {
    const { events } = parseStreamJsonl(currentSkillRaw, {
      taggedLines: currentSkillRaw.split('\n').filter(Boolean).map((line, i) => ({ line, receiptNs: BigInt(i) * 1000000n })),
    });
    const ms = deriveFirstUsefulSignalMs(events, 2, 0n);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('returns null for a null index', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    expect(deriveFirstUsefulSignalMs(events, null, 0n)).toBeNull();
  });

  it('returns null for an out-of-range index', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    expect(deriveFirstUsefulSignalMs(events, 99999, 0n)).toBeNull();
  });

  // Regression coverage for a real double-subtraction bug found by an independent review pass:
  // condition-launcher.mjs's spawnCondition tags each line with an ABSOLUTE
  // process.hrtime.bigint() receiptNs; deriveFirstUsefulSignalMs subtracts spawnHrtimeNs ONCE.
  // A prior version of spawnCondition pre-subtracted t0 before tagging (receiptNs was already a
  // duration, not absolute) -- with spawnHrtimeNs:0n (as every test above uses), that bug is
  // invisible, since subtracting 0 is a no-op regardless of which convention is used. Using a
  // large, realistic non-zero spawnHrtimeNs (matching a real process.hrtime.bigint() value,
  // which is nanoseconds since an arbitrary large reference point) is required to actually catch
  // it: a pre-subtracted (relative) receiptNs minus a large absolute spawnHrtimeNs would produce
  // a large NEGATIVE "ms" value instead of the small positive elapsed time.
  it('with a realistic large absolute spawnHrtimeNs, still derives a small non-negative ms value (catches double-subtraction)', () => {
    const REALISTIC_T0 = 123_456_789_000_000n; // ns -- shaped like a real hrtime.bigint() value
    const { events } = parseStreamJsonl(currentSkillRaw, {
      taggedLines: currentSkillRaw.split('\n').filter(Boolean).map((line, i) => ({ line, receiptNs: REALISTIC_T0 + BigInt(i) * 1_000_000n })),
    });
    const ms = deriveFirstUsefulSignalMs(events, 2, REALISTIC_T0);
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(1000); // event index 2, ~1ms apart -- must be small, not a huge negative number
  });
});

// Local synthetic-event helpers, matching agentic-eval-hard-gates.test.js's own established shape
// exactly (both files construct the same real stream-json event shapes; duplicating the tiny
// helpers here keeps this file independently readable without a cross-file import).
function bashToolUseEvent(id, command) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } };
}
function toolResultEvent(id, { isError = false, content = 'ok' } = {}) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content, is_error: isError, tool_use_id: id }] } };
}
function initEventStub() {
  return { type: 'system', subtype: 'init' };
}
function resultEventStub() {
  return { type: 'result', subtype: 'success' };
}

describe('findBashToolUsesWithResults -- resultIndex/resultContent (additive fields)', () => {
  it('exposes the correlated tool_result event index and raw content when a result was found', () => {
    const events = [
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --json'),
      toolResultEvent('t1', { content: '{"tool":"kmp-test"}' }),
      resultEventStub(),
    ];
    const [entry] = findBashToolUsesWithResults(events);
    expect(entry.resultFound).toBe(true);
    expect(entry.resultIndex).toBe(2);
    expect(entry.resultContent).toBe('{"tool":"kmp-test"}');
  });

  it('resultIndex/resultContent are both null when no result was found -- never undefined, never a guess', () => {
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), resultEventStub()];
    const [entry] = findBashToolUsesWithResults(events);
    expect(entry.resultFound).toBe(false);
    expect(entry.resultIndex).toBeNull();
    expect(entry.resultContent).toBeNull();
  });

  it('existing fields (command/resultFound/resultIsError) are unchanged by the addition', () => {
    const events = [initEventStub(), bashToolUseEvent('t1', './gradlew :app:test'), toolResultEvent('t1', { isError: true, content: 'BUILD FAILED' }), resultEventStub()];
    const [entry] = findBashToolUsesWithResults(events);
    expect(entry.command).toBe('./gradlew :app:test');
    expect(entry.resultFound).toBe(true);
    expect(entry.resultIsError).toBe(true);
  });
});

describe('findTranscriptStructuralIssuesToleratingTimeout', () => {
  // A transcript that ends right after a completed Bash call, with no terminal `result` event at
  // all -- exactly what a process killed by spawnCondition's own timeout looks like.
  function timedOutTranscript() {
    return [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), toolResultEvent('t1', { content: '{"exit_code":0}' })];
  }

  it('a legitimate timeout (terminated:true, reason:timeout) tolerates the missing result_count issue', () => {
    const issues = findTranscriptStructuralIssuesToleratingTimeout(timedOutTranscript(), { terminated: true, terminationReason: 'timeout' });
    expect(issues).toEqual([]);
  });

  it('the SAME missing-result transcript is still reported when terminated is false (not a timeout at all)', () => {
    const issues = findTranscriptStructuralIssuesToleratingTimeout(timedOutTranscript(), { terminated: false, terminationReason: null });
    expect(issues.some((i) => i.type === 'result_count')).toBe(true);
  });

  it('the SAME missing-result transcript is still reported when terminated is true but the reason is "error", not "timeout"', () => {
    const issues = findTranscriptStructuralIssuesToleratingTimeout(timedOutTranscript(), { terminated: true, terminationReason: 'error' });
    expect(issues.some((i) => i.type === 'result_count')).toBe(true);
  });

  it('result_count > 1 (a genuinely different problem) is never tolerated, even under a real timeout', () => {
    const events = [initEventStub(), resultEventStub(), resultEventStub()]; // two result events -- never explainable by a timeout
    const issues = findTranscriptStructuralIssuesToleratingTimeout(events, { terminated: true, terminationReason: 'timeout' });
    expect(issues.some((i) => i.type === 'result_count' && i.count === 2)).toBe(true);
  });

  // A genuinely corrupted transcript that ALSO happens to lack a result event must still fail --
  // for its OTHER reasons -- even under a claimed timeout. A timeout excuses only the ONE specific
  // symptom it actually causes, never a blanket pass on every structural check at once.
  it('a genuinely corrupted transcript (duplicate init) that also lacks a result event still fails, even under a real timeout', () => {
    const events = [initEventStub(), initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json')];
    const issues = findTranscriptStructuralIssuesToleratingTimeout(events, { terminated: true, terminationReason: 'timeout' });
    expect(issues.some((i) => i.type === 'init_count' && i.count === 2)).toBe(true);
    // The missing-result issue itself IS still tolerated -- only the duplicate-init issue survives.
    expect(issues.some((i) => i.type === 'result_count')).toBe(false);
  });

  it('a clean, complete transcript (no timeout needed) reports zero issues regardless of the flags passed', () => {
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), toolResultEvent('t1'), resultEventStub()];
    expect(findTranscriptStructuralIssuesToleratingTimeout(events, { terminated: false, terminationReason: null })).toEqual([]);
  });
});

describe('findIncompleteToolResultsToleratingTimeout', () => {
  it('a legitimate timeout mid-Bash-call (one incomplete result, which IS the last tool_use) is tolerated', () => {
    const events = [
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test doctor --json'),
      toolResultEvent('t1'),
      bashToolUseEvent('t2', 'kmp-test parallel --json'), // killed mid-flight -- no tool_result ever arrives
    ];
    const incomplete = findIncompleteToolResultsToleratingTimeout(events, { terminated: true, terminationReason: 'timeout' });
    expect(incomplete).toEqual([]);
  });

  it('the SAME mid-call transcript is still reported when terminated is false (not a timeout at all)', () => {
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json')];
    const incomplete = findIncompleteToolResultsToleratingTimeout(events, { terminated: false, terminationReason: null });
    expect(incomplete.length).toBe(1);
  });

  it('two incomplete tool_use calls are never tolerated, even under a real timeout -- one abrupt kill cannot explain two', () => {
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), bashToolUseEvent('t2', 'kmp-test parallel --json')];
    const incomplete = findIncompleteToolResultsToleratingTimeout(events, { terminated: true, terminationReason: 'timeout' });
    expect(incomplete.length).toBe(2);
  });

  // An incomplete result that ISN'T the last tool_use in the transcript means a LATER call
  // somehow completed while an EARLIER one never did -- impossible for a real single-threaded
  // transcript to produce via a simple abrupt kill, so this is genuine corruption, not a timeout.
  it('an incomplete result that is NOT the last tool_use is never tolerated, even under a real timeout', () => {
    const events = [
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test doctor --json'), // never gets a result -- but is NOT the last tool_use below
      bashToolUseEvent('t2', 'kmp-test parallel --json'),
      toolResultEvent('t2'),
    ];
    const incomplete = findIncompleteToolResultsToleratingTimeout(events, { terminated: true, terminationReason: 'timeout' });
    expect(incomplete.length).toBe(1);
    expect(incomplete[0].id).toBe('t1');
  });

  it('a timeout AFTER every command already completed (zero incomplete results) is the trivial happy path', () => {
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), toolResultEvent('t1')];
    expect(findIncompleteToolResultsToleratingTimeout(events, { terminated: true, terminationReason: 'timeout' })).toEqual([]);
  });
});
