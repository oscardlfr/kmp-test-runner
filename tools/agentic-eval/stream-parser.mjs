#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/stream-parser.mjs -- parses `claude --output-format stream-json` JSONL,
// built directly against real captured event shapes from Step 1 (never guessed -- the task
// brief explicitly required this, and one real flag gap was found this way: --output-format
// stream-json requires --verbose when combined with --print, undocumented in --help).
//
// Real confirmed event shapes (see tests/vitest/fixtures/agentic-eval-stream-*.jsonl, derived
// from real Step-1 captures with all content replaced by synthetic placeholders):
//   {type:"system", subtype:"init", cwd, session_id, tools:[], mcp_servers:[], model,
//    permissionMode, plugins:[{name,path,source}], skills:[], apiKeySource, claude_code_version}
//   {type:"rate_limit_event", rate_limit_info:{...}}
//   {type:"assistant", message:{model, content:[{type:"tool_use"|"text"|"thinking", ...}], usage:{...}}}
//   {type:"user", message:{role:"user", content:[{type:"tool_result", ...}]}, tool_use_result:{...}}
//   {type:"system", subtype:"hook_started", hook_id, hook_name, hook_event}
//   {type:"system", subtype:"hook_response", hook_id, hook_name, hook_event, output, stdout, stderr, exit_code, outcome}
//   {type:"result", subtype, is_error, duration_ms, num_turns, result, permission_denials:[], usage:{...}}
//
// Skill invocation is detected from a real `tool_use` content block with name:"Skill" --
// never inferred from which CLI binary the agent happened to run (that conflation is exactly
// what this harness exists to fix -- see the PR context).

/**
 * @param {string} rawJsonl - the full stdout capture from a `claude -p ... --output-format
 *   stream-json` invocation.
 * @param {bigint} spawnHrtimeNs - `process.hrtime.bigint()` captured immediately before spawn;
 *   used as t0 for monotonic receipt_ns tagging. Callers must tag each line as it arrives off
 *   the child's stdout stream (not after the fact) for receipt_ns to be meaningful -- see
 *   condition-launcher.mjs's use of this parser.
 */
export function parseStreamJsonl(rawJsonl, { taggedLines } = {}) {
  const lines = taggedLines ?? rawJsonl.split('\n').filter(Boolean).map((line, i) => ({ line, receiptNs: BigInt(i) }));
  const events = [];
  const malformedLines = [];
  for (const { line, receiptNs } of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      malformedLines.push({ line, error: err.message });
      continue;
    }
    // A line can be syntactically valid JSON (null, a bare string, a number, an array) without
    // being an event object -- assigning _receiptNs to a non-object throws in strict mode
    // (every .mjs module is strict), which would abort the ENTIRE parse, not just this line.
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformedLines.push({ line, error: 'stream event must be a JSON object' });
      continue;
    }
    parsed._receiptNs = receiptNs;
    events.push(parsed);
  }
  return { events, malformedLines };
}

export function findInitEvent(events) {
  return events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null;
}

export function findResultEvent(events) {
  return events.find((e) => e.type === 'result') ?? null;
}

/** Skill availability from the init event's `plugins[]` array -- NOT `skills[]`, which lists
 * an unrelated, ambient set of bundled/managed skills present identically regardless of
 * --plugin-dir (confirmed empirically during Step 1). */
export function isSkillAvailable(initEvent, skillName) {
  if (initEvent == null || !Array.isArray(initEvent.plugins)) return false;
  return initEvent.plugins.some((p) => p.name === skillName);
}

/** Finds the real Skill tool_use event for a given skill name, with its event index --
 * this is the actual invocation proof, never inferred from which CLI binary ran. */
export function findSkillInvocation(events, skillName) {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_use' && c.name === 'Skill' && c.input?.skill === skillName) {
        return { type: 'assistant.tool_use.Skill', index: i, receiptNs: ev._receiptNs, input: c.input };
      }
    }
  }
  return null;
}

export function findBashToolUses(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_use' && c.name === 'Bash') out.push({ index: i, receiptNs: ev._receiptNs, id: c.id, input: c.input });
    }
  }
  return out;
}

/** Proves every Bash call reached the policy hook (Round 6 evidence requirement) -- counts
 * hook_started/hook_response events and checks 1:1 correspondence against the actual Bash
 * tool_use count. This is more than an aggregate-count comparison (bashCallCount ===
 * hookStarted.length === hookResponses.length): that weaker check can't distinguish "N real,
 * distinct hooked calls" from "a duplicated hook_id plus one Bash call that was never hooked at
 * all" (the counts still balance). everyCallHooked additionally requires hook_started/
 * hook_response events to be scoped to PreToolUse:Bash (excluding any hook for another tool),
 * every hook_id to be unique within each side, and the started/response id SETS to match
 * exactly -- not just their counts. */
export function countHookEvents(events) {
  const bashCallCount = findBashToolUses(events).length;
  const isBashHook = (e) => e.type === 'system' && (e.subtype === 'hook_started' || e.subtype === 'hook_response') && e.hook_name === 'PreToolUse:Bash';
  const hookStarted = events.filter((e) => isBashHook(e) && e.subtype === 'hook_started');
  const hookResponses = events.filter((e) => isBashHook(e) && e.subtype === 'hook_response');
  const decisions = hookResponses.map((e) => {
    try {
      return JSON.parse(e.output).hookSpecificOutput.permissionDecision;
    } catch {
      return null;
    }
  });
  const startedIds = hookStarted.map((e) => e.hook_id);
  const responseIds = hookResponses.map((e) => e.hook_id);
  const uniqueStartedIds = new Set(startedIds);
  const uniqueResponseIds = new Set(responseIds);
  const idsMatch = uniqueStartedIds.size === startedIds.length
    && uniqueResponseIds.size === responseIds.length
    && startedIds.length === responseIds.length
    && [...uniqueStartedIds].every((id) => uniqueResponseIds.has(id));
  return {
    hookCallCount: hookStarted.length,
    hookResponseCount: hookResponses.length,
    hookDenyCount: decisions.filter((d) => d === 'deny').length,
    everyCallHooked: bashCallCount === hookStarted.length && bashCallCount === hookResponses.length && idsMatch,
  };
}

/**
 * output_bytes: tool-*result* payload bytes actually delivered back to the model (generalizes
 * the existing "stdout/stderr bytes returned to the agent" definition to non-shell tools too).
 * stream_json_bytes: total raw transport size of the stream-json output -- a DIFFERENT number,
 * never conflated with output_bytes (Round 4 fix #10).
 */
export function computeByteMetrics(rawJsonl, events) {
  const streamJsonBytes = Buffer.byteLength(rawJsonl, 'utf8');
  let outputBytes = 0;
  for (const ev of events) {
    if (ev.type !== 'user') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_result') continue;
      const content = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
      outputBytes += Buffer.byteLength(content, 'utf8');
    }
  }
  return { outputBytes, streamJsonBytes };
}

export function extractTokenUsage(resultEvent) {
  const u = resultEvent?.usage;
  if (u == null) return null;
  return {
    input: u.input_tokens ?? null,
    output: u.output_tokens ?? null,
    cache_read: u.cache_read_input_tokens ?? null,
    cache_creation: u.cache_creation_input_tokens ?? null,
  };
}

/**
 * Derives first_useful_signal_ms from an already-chosen event index (graders.mjs returns the
 * index; this function is the ONLY place that turns an index into a millisecond value, keeping
 * graders pure/content-only and timing purely a transport-layer concern -- Round 3 fix #4).
 */
export function deriveFirstUsefulSignalMs(events, eventIndex, spawnHrtimeNs) {
  if (eventIndex == null || events[eventIndex] == null) return null;
  const receiptNs = events[eventIndex]._receiptNs;
  if (typeof receiptNs !== 'bigint') return null;
  return Number(receiptNs - spawnHrtimeNs) / 1e6;
}
