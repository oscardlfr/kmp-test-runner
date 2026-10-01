import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeCodexByteMetrics, findCodexCommandAttempts, findCodexFinalText,
  findCodexStructuralIssues, findCodexTerminalEvent, findCodexThreadEvent, parseCodexJsonl,
} from '../../tools/agentic-eval/codex-jsonl-parser.mjs';

const EVENTS = [
  { type: 'thread.started', thread_id: 'thread-1' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item-1', type: 'command_execution', command: './gradlew test' } },
  { type: 'item.completed', item: { id: 'item-1', type: 'command_execution', command: './gradlew test', aggregated_output: 'BUILD SUCCESSFUL', exit_code: 0 } },
  { type: 'item.completed', item: { id: 'item-2', type: 'agent_message', text: 'Done.' } },
  { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 3 } },
];

describe('Codex JSONL parser', () => {
  it('parses documented lifecycle events and correlates command results by item id', () => {
    const raw = EVENTS.map((event) => JSON.stringify(event)).join('\n');
    const { events, malformedLines } = parseCodexJsonl(raw);
    const attempts = findCodexCommandAttempts(events);
    expect(malformedLines).toEqual([]);
    expect(findCodexThreadEvent(events)?.thread_id).toBe('thread-1');
    expect(findCodexTerminalEvent(events)?.type).toBe('turn.completed');
    expect(findCodexFinalText(events)).toBe('Done.');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ id: 'item-1', command: './gradlew test', resultFound: true, resultIsError: false, resultText: 'BUILD SUCCESSFUL' });
    expect(findCodexStructuralIssues(events, attempts)).toEqual([]);
    // outputBytes is the command output the runtime logged (aggregated_output), no longer the agent message
    // ('Done.'): the fixture's one command printed 'BUILD SUCCESSFUL'.
    expect(computeCodexByteMetrics(raw, events).outputBytes).toBe(Buffer.byteLength('BUILD SUCCESSFUL'));
  });

  it('fails structurally on malformed JSON, missing terminal events, and incomplete commands', () => {
    const raw = `${JSON.stringify(EVENTS[0])}\nnot-json\n${JSON.stringify(EVENTS[2])}`;
    const { events, malformedLines } = parseCodexJsonl(raw);
    const attempts = findCodexCommandAttempts(events);
    expect(malformedLines).toEqual([{ lineIndex: 1 }]);
    expect(attempts[0].resultFound).toBe(false);
    expect(findCodexStructuralIssues(events, attempts)).toContainEqual({ type: 'result_count', count: 0 });
  });

  it('supports documented completion-only command items without fabricating a start event', () => {
    const completed = [{ type: 'thread.started', thread_id: 't' }, EVENTS[3], EVENTS[5]];
    const attempts = findCodexCommandAttempts(completed);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ id: 'item-1', resultFound: true, resultIsError: false });
  });
});

// outputBytes is the UTF-8 byte length of the command output Codex logged (item.aggregated_output of every
// completed command_execution item), not of the agent's own messages. Codex may shorten what the model
// reads (tool_output_token_limit), so this measures the output produced, as logged.
describe('computeCodexByteMetrics: outputBytes is the command output as logged', () => {
  const completedCommand = (id, output) => ({ type: 'item.completed', item: { id, type: 'command_execution', command: 'x', aggregated_output: output, exit_code: 0 } });
  const completedMessage = (id, text) => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
  const rawOf = (events) => events.map((event) => JSON.stringify(event)).join('\n');
  const bytesOf = (events) => computeCodexByteMetrics(rawOf(events), events);

  it('sums the bytes of every completed command output and ignores the agent message: "abc" + "é" + a 7-byte message is 5', () => {
    const events = [completedCommand('a', 'abc'), completedCommand('b', 'é'), completedMessage('m', 'hello!!')];
    expect(Buffer.byteLength('é', 'utf8')).toBe(2);
    expect(bytesOf(events).outputBytes).toBe(5);
  });

  it('counts a multi-byte output in bytes, not characters', () => {
    expect(bytesOf([completedCommand('a', '日本語')]).outputBytes).toBe(9);
  });

  it('is 0 when no command ran, whatever the agent said', () => {
    expect(bytesOf([completedMessage('m', 'a long answer with no command behind it')]).outputBytes).toBe(0);
  });

  it('does not count a command item that has only started', () => {
    const started = { type: 'item.started', item: { id: 'a', type: 'command_execution', command: 'x', aggregated_output: 'must not count' } };
    expect(bytesOf([started, completedCommand('a', 'ab')]).outputBytes).toBe(2);
  });

  it.each([
    ['is missing', undefined],
    ['is null', null],
    ['is a number', 42],
    ['is an object', { text: 'x' }],
  ])('counts nothing for a completed command whose aggregated_output %s', (_what, value) => {
    const event = { type: 'item.completed', item: { id: 'a', type: 'command_execution', command: 'x', aggregated_output: value } };
    expect(bytesOf([event, completedCommand('b', 'ab')]).outputBytes).toBe(2);
  });

  it('counts an empty output as 0 bytes', () => {
    expect(bytesOf([completedCommand('a', ''), completedCommand('b', 'xyz')]).outputBytes).toBe(3);
  });

  it('does not count the output of a completed item that is not a command_execution', () => {
    const other = { type: 'item.completed', item: { id: 'f', type: 'file_change', aggregated_output: 'not command output' } };
    expect(bytesOf([other, completedCommand('a', 'ab')]).outputBytes).toBe(2);
  });

  it('keeps streamJsonBytes as the byte length of the raw stream itself', () => {
    const events = [completedCommand('a', 'abc'), completedMessage('m', 'hello!!')];
    const raw = rawOf(events);
    expect(computeCodexByteMetrics(raw, events).streamJsonBytes).toBe(Buffer.byteLength(raw, 'utf8'));
  });

  it('returns exactly outputBytes and streamJsonBytes: the key set is closed by the observation contract', () => {
    expect(Object.keys(bytesOf([completedCommand('a', 'abc')])).sort()).toEqual(['outputBytes', 'streamJsonBytes']);
  });

  // Local check against the real Evidence2 transcript of codex-cli-0 (never committed: the path comes from
  // the environment). The raw stream holds 36832 bytes of command output, which the old measure missed.
  it.skipIf(!process.env.KMP_EVAL_E2_CODEX0)('recomputes Evidence2 codex-cli-0 from its transcript: 36832 bytes of command output', () => {
    const raw = readFileSync(process.env.KMP_EVAL_E2_CODEX0, 'utf8');
    const { events } = parseCodexJsonl(raw);
    expect(computeCodexByteMetrics(raw, events).outputBytes).toBe(36832);
  });
});
