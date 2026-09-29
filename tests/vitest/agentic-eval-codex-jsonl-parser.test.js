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
    expect(computeCodexByteMetrics(raw, events).outputBytes).toBe(Buffer.byteLength('Done.'));
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
