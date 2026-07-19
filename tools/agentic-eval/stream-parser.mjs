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
//   {type:"user", message:{role:"user", content:[{type:"tool_result", content, is_error, tool_use_id}]}, tool_use_result:{...}}
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

/** The tool_result for a given tool_use id, found by scanning forward from fromIndex.
 * `is_error` is the real field name confirmed on a live "Unknown skill" transcript
 * (content: "<tool_use_error>Unknown skill: ...</tool_use_error>", is_error: true,
 * tool_use_id: "..."). */
function findToolResultById(events, toolUseId, fromIndex) {
  for (let i = fromIndex; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'user') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_result' && c.tool_use_id === toolUseId) {
        return { index: i, isError: c.is_error === true };
      }
    }
  }
  return null;
}

/**
 * Finds EVERY Skill tool_use for a given skill name and aggregates their correlated outcomes --
 * distinguishes an ATTEMPT (the model called Skill with this name, one or more times) from a
 * CONFIRMED invocation (ANY of those attempts' own tool_result did not report is_error:true).
 * This is load-bearing: on a real "no-skill" condition transcript, the model calls Skill anyway
 * (the skill isn't in its listing, but nothing stops it from trying), gets back
 * `<tool_use_error>Unknown skill: ...</tool_use_error>` with is_error:true, and then tells the
 * user the skill doesn't exist. A version of this function that only checked for the tool_use
 * block (ignoring its result) would report skill_invoked:true for that same no-skill run --
 * directly contradicting skill_available:false in the same record. `confirmed` is only ever true
 * when a matching, non-error tool_result was actually found; an attempt with no result yet
 * (transcript cut short) is never assumed successful.
 *
 * Regression coverage for a real bug an independent review pass demonstrated: an earlier version
 * `return`ed on the FIRST matching tool_use, ignoring any later ones entirely. A transcript with
 * an initial failed attempt followed by a later successful retry reported confirmed:false (wrong
 * -- a genuinely confirmed invocation existed, just not on attempt 1); the inverse (an initial
 * success followed by a later, unrelated failure) would likewise have been reported by whichever
 * attempt happened to come first, not by whether the skill was EVER actually confirmed. This
 * version scans the WHOLE transcript and aggregates: `attempted` is true iff at least one
 * matching call exists at all; `confirmed` is true iff ANY matching call's own tool_result was
 * non-error, regardless of order; `attemptCount` is the total number of matching calls (used by
 * callers for `tool_calls_total`, which must count every attempt, not just presence/absence).
 * @returns {{attempted: true, confirmed: boolean, attemptCount: number, type: string, index: number, receiptNs: bigint, input: object, resultIsError: boolean|null} | null}
 */
export function findSkillInvocation(events, skillName) {
  const matches = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_use' || c.name !== 'Skill' || c.input?.skill !== skillName) continue;
      const result = c.id != null ? findToolResultById(events, c.id, i + 1) : null;
      matches.push({
        type: 'assistant.tool_use.Skill',
        index: i,
        receiptNs: ev._receiptNs,
        input: c.input,
        resultIsError: result ? result.isError : null,
        confirmed: result != null && result.isError === false,
      });
    }
  }
  if (matches.length === 0) return null;
  // The "representative" match for the single-event fields (type/index/receiptNs/input/
  // resultIsError) that this record's evidence still carries just one of: whichever attempt
  // actually PROVES the aggregated `confirmed` value -- the first confirmed one if any exist,
  // otherwise the last attempt (the model's final state before giving up).
  const confirmedMatch = matches.find((m) => m.confirmed === true);
  const representative = confirmedMatch ?? matches[matches.length - 1];
  return {
    attempted: true,
    confirmed: confirmedMatch != null,
    attemptCount: matches.length,
    type: representative.type,
    index: representative.index,
    receiptNs: representative.receiptNs,
    input: representative.input,
    resultIsError: representative.resultIsError,
  };
}

/**
 * Every Skill tool_use block across the WHOLE transcript whose `input.skill` does NOT exactly
 * match `expectedSkillName` -- including a missing or non-string `input.skill`. Distinct from
 * findUnexpectedToolUses, which only checks the tool NAME (Bash/Skill) and has no visibility into
 * a Skill call's own arguments: "Skill" is itself an allowed tool name regardless of which skill
 * it targets, so a transcript that invoked Skill with some OTHER skill name entirely passes
 * findUnexpectedToolUses outright. Meanwhile findSkillInvocation(events, expectedSkillName)
 * simply never matches that call -- it's scoped to expectedSkillName only -- so an unrelated/
 * foreign skill invocation is invisible to skill_invocation_attempted/skill_invoked and can
 * silently coexist with attempted:false/invoked:false for the expected skill. Regression coverage
 * for a real gap an independent review pass demonstrated against the relaxed calibration contract
 * (a no-skill arm that never attempts kmp-test-runner can now legitimately show
 * attempted:false/invoked:false -- without this check, a transcript that instead called some
 * OTHER skill would show the exact same attempted:false/invoked:false for kmp-test-runner, and
 * pass unnoticed, potentially writing contaminated evidence).
 */
export function findForeignSkillUses(events, expectedSkillName) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_use' || c.name !== 'Skill') continue;
      const skillArg = c.input?.skill;
      if (typeof skillArg !== 'string' || skillArg.length === 0 || skillArg !== expectedSkillName) {
        out.push({ index: i, receiptNs: ev._receiptNs, id: c.id, skillArg: typeof skillArg === 'string' ? skillArg : null });
      }
    }
  }
  return out;
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

/**
 * Every tool_use block across the WHOLE transcript whose `name` is NOT in `allowedToolNames`.
 * Regression coverage for a real gap an independent review pass demonstrated: a hard gate that
 * only checks "the expected Bash calls succeeded" can't distinguish that from a transcript that
 * ALSO used some other tool (e.g. Read) alongside them -- a real adversarial transcript with
 * Read enabled and invoked, plus the two expected Bash calls, still passed the old gate outright.
 * This scans every tool_use in the transcript, not just Bash ones, so an unexpected tool's mere
 * PRESENCE is caught regardless of whether the expected Bash calls also happened to succeed.
 */
export function findUnexpectedToolUses(events, allowedToolNames) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_use' && !allowedToolNames.has(c.name)) {
        out.push({ index: i, receiptNs: ev._receiptNs, name: c.name, id: c.id });
      }
    }
  }
  return out;
}

/**
 * True only if the init event's OWN declared profile exactly matches what this harness actually
 * launches with -- `--tools "Bash,Skill"` (as a SET, not proving anything about order), zero MCP
 * servers, `--permission-mode dontAsk`. Closes a real gap: a hard gate that only checks
 * `init != null` can't distinguish a genuinely narrow session from one that regressed to a wider
 * tool/MCP/permission profile (e.g. Read accidentally re-added to buildBaseArgv's --tools, or a
 * stray MCP server configured in the environment) -- the gate would still pass as long as the
 * expected Bash calls also happened to succeed, since nothing inspects the init event's own
 * fields beyond its mere existence.
 */
export function hasExpectedToolProfile(initEvent, allowedToolNames) {
  if (initEvent == null || !Array.isArray(initEvent.tools)) return false;
  const toolSet = new Set(initEvent.tools);
  if (toolSet.size !== allowedToolNames.size) return false;
  for (const t of allowedToolNames) if (!toolSet.has(t)) return false;
  if (!Array.isArray(initEvent.mcp_servers) || initEvent.mcp_servers.length !== 0) return false;
  if (initEvent.permissionMode !== 'dontAsk') return false;
  return true;
}

/** Every Bash tool_use, each correlated with its OWN tool_result outcome (mirrors
 * findSkillInvocation's attempted-vs-confirmed correlation, generalized to every Bash call).
 * Needed to verify not just THAT commands ran, but that each one's own result was not an error,
 * and exactly WHICH commands ran -- "the agent invoked Bash twice" alone doesn't prove it ran
 * the two SPECIFIC expected commands, or that either one actually succeeded. */
export function findBashToolUsesWithResults(events) {
  return findBashToolUses(events).map((u) => {
    const result = u.id != null ? findToolResultById(events, u.id, u.index + 1) : null;
    return { ...u, command: u.input?.command ?? null, resultFound: result != null, resultIsError: result ? result.isError : null };
  });
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
    // Explicit "allow" count, not just "not deny" -- a hook_response whose `output` is
    // unparseable JSON (or lacks hookSpecificOutput.permissionDecision) produces a null
    // decision, counted in NEITHER hookDenyCount NOR this field. A caller checking only
    // hookDenyCount===0 would silently accept a malformed/unrecognized decision as if it were
    // an allow; requiring hookAllowCount===hookCallCount closes that gap.
    hookAllowCount: decisions.filter((d) => d === 'allow').length,
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
 * Derives first_useful_signal_ms from an already-chosen event index (a grader returns the
 * index; this function is the ONLY place that turns an index into a millisecond value, keeping
 * grading pure/content-only and timing purely a transport-layer concern -- Round 3 fix #4).
 * Requires events[eventIndex]._receiptNs to be an ABSOLUTE process.hrtime.bigint() value (as
 * condition-launcher.mjs's spawnCondition tags it) -- subtracting spawnHrtimeNs here is the
 * ONLY subtraction; a caller that pre-subtracts spawnHrtimeNs before tagging would double-
 * subtract it here, producing a large negative "ms" value.
 */
export function deriveFirstUsefulSignalMs(events, eventIndex, spawnHrtimeNs) {
  if (eventIndex == null || events[eventIndex] == null) return null;
  const receiptNs = events[eventIndex]._receiptNs;
  if (typeof receiptNs !== 'bigint') return null;
  return Number(receiptNs - spawnHrtimeNs) / 1e6;
}
