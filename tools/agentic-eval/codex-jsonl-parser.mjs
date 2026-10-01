#!/usr/bin/env node
import { Buffer } from 'node:buffer';

const COMMAND_TYPE = 'command_execution';
const TERMINAL_TYPES = new Set(['turn.completed', 'turn.failed']);

function receiptForLine(taggedLines, line, fallback) {
  const tagged = taggedLines?.[fallback];
  return tagged?.line === line && typeof tagged.receiptNs === 'bigint' ? tagged.receiptNs : null;
}

export function parseCodexJsonl(rawJsonl, { taggedLines = null } = {}) {
  const events = [];
  const malformedLines = [];
  const lines = String(rawJsonl ?? '').split(/\r?\n/).filter((line) => line.length > 0);
  for (const [lineIndex, line] of lines.entries()) {
    try {
      const event = JSON.parse(line);
      if (event == null || typeof event !== 'object' || Array.isArray(event)) throw new Error('not-object');
      Object.defineProperty(event, '_receiptNs', { value: receiptForLine(taggedLines, line, lineIndex), enumerable: false });
      events.push(event);
    } catch {
      malformedLines.push({ lineIndex });
    }
  }
  return { events, malformedLines };
}

export function findCodexThreadEvent(events) {
  return events.find((event) => event.type === 'thread.started') ?? null;
}

export function findCodexTerminalEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (TERMINAL_TYPES.has(events[i]?.type)) return events[i];
  }
  return null;
}

export function findCodexFinalText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      return event.item.text;
    }
  }
  return null;
}

function completedById(events) {
  const out = new Map();
  events.forEach((event, index) => {
    if (event?.type !== 'item.completed' || typeof event.item?.id !== 'string') return;
    const list = out.get(event.item.id) ?? [];
    list.push({ event, index });
    out.set(event.item.id, list);
  });
  return out;
}

function resultText(item) {
  if (typeof item?.aggregated_output === 'string') return item.aggregated_output;
  if (typeof item?.output === 'string') return item.output;
  return null;
}

export function findCodexCommandAttempts(events) {
  const completed = completedById(events);
  const attempts = [];
  const seen = new Set();
  events.forEach((event, index) => {
    if (event?.type !== 'item.started' || event.item?.type !== COMMAND_TYPE) return;
    const id = typeof event.item.id === 'string' && event.item.id.length > 0 ? event.item.id : null;
    const matches = id == null ? [] : (completed.get(id) ?? []);
    const completion = matches.length === 1 ? matches[0] : null;
    const completedItem = completion?.event?.item;
    const text = resultText(completedItem);
    attempts.push({
      id,
      command: typeof event.item.command === 'string' ? event.item.command : null,
      index,
      receiptNs: typeof event._receiptNs === 'bigint' ? event._receiptNs : null,
      resultFound: completion != null,
      resultIndex: completion?.index ?? null,
      resultIsError: completion == null
        ? null
        : (Number.isInteger(completedItem.exit_code) ? completedItem.exit_code !== 0 : completedItem.status === 'failed'),
      resultText: text,
      resultTextStatus: completion == null ? 'missing' : text == null ? 'unsupported' : 'text',
      duplicateCompletionCount: Math.max(0, matches.length - 1),
    });
    if (id != null) seen.add(id);
  });

  // A defensive compatibility path for JSONL producers that emit only item.completed for very
  // short commands. The official stream documents item.started; preserving the completion still
  // makes the anomaly visible rather than silently dropping an executed command.
  events.forEach((event, index) => {
    if (event?.type !== 'item.completed' || event.item?.type !== COMMAND_TYPE) return;
    const id = typeof event.item.id === 'string' && event.item.id.length > 0 ? event.item.id : null;
    if (id != null && seen.has(id)) return;
    const text = resultText(event.item);
    attempts.push({
      id,
      command: typeof event.item.command === 'string' ? event.item.command : null,
      index,
      receiptNs: typeof event._receiptNs === 'bigint' ? event._receiptNs : null,
      resultFound: true,
      resultIndex: index,
      resultIsError: Number.isInteger(event.item.exit_code) ? event.item.exit_code !== 0 : event.item.status === 'failed',
      resultText: text,
      resultTextStatus: text == null ? 'unsupported' : 'text',
      duplicateCompletionCount: 0,
    });
  });
  return attempts.sort((a, b) => a.index - b.index);
}

export function findCodexStructuralIssues(events, attempts) {
  const issues = [];
  const threadIndices = events.flatMap((event, index) => event.type === 'thread.started' ? [index] : []);
  const terminalIndices = events.flatMap((event, index) => TERMINAL_TYPES.has(event.type) ? [index] : []);
  if (threadIndices.length !== 1) issues.push({ type: 'init_count', count: threadIndices.length });
  if (terminalIndices.length !== 1) issues.push({ type: 'result_count', count: terminalIndices.length });
  if (threadIndices.length === 1 && threadIndices[0] !== 0) issues.push({ type: 'init_not_first', initIndex: threadIndices[0] });
  if (terminalIndices.length === 1 && terminalIndices[0] !== events.length - 1) {
    issues.push({ type: 'result_not_last', resultIndex: terminalIndices[0], eventsLength: events.length });
  }
  const byId = new Map();
  for (const attempt of attempts) {
    if (attempt.id == null) {
      issues.push({ type: 'empty_tool_use_id' });
      continue;
    }
    byId.set(attempt.id, (byId.get(attempt.id) ?? 0) + 1);
    if (attempt.duplicateCompletionCount > 0) {
      issues.push({ type: 'duplicate_tool_result', id: attempt.id, count: attempt.duplicateCompletionCount + 1 });
    }
  }
  for (const [id, count] of byId) if (count > 1) issues.push({ type: 'duplicate_tool_use_id', id, count });
  return issues;
}

// outputBytes is the UTF-8 byte length of the output of the commands Codex ran, as it logged them: the
// aggregated_output of every completed command_execution item. It is NOT the agent's own messages (which
// is what this used to sum: Evidence2 erratum E6) and NOT necessarily what the model read -- Codex may
// shorten a command's output before the model sees it (`tool_output_token_limit`, the token budget for
// storing individual tool outputs in history). Claude's measure is a different one (the tool results
// returned to the model), which the record labels with output_bytes_kind.
export function computeCodexByteMetrics(rawJsonl, events) {
  let outputBytes = 0;
  for (const event of events) {
    if (event?.type === 'item.completed' && event.item?.type === 'command_execution' && typeof event.item.aggregated_output === 'string') {
      outputBytes += Buffer.byteLength(event.item.aggregated_output, 'utf8');
    }
  }
  return {
    outputBytes,
    streamJsonBytes: Buffer.byteLength(String(rawJsonl ?? ''), 'utf8'),
  };
}
