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
import { createHash } from 'node:crypto';

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

/** Plugin availability from the init event's `plugins[]` array -- NOT `skills[]`, which lists
 * an unrelated, ambient set of bundled/managed skills present identically regardless of
 * --plugin-dir (confirmed empirically during Step 1). `pluginName` is the PLUGIN's own name (from
 * its plugin.json), matched against `plugins[].name` -- a genuinely different identity from the
 * SKILL's own name, even though this harness's plugin and skill happen to share one string value
 * (see isTargetSkillReference's doc comment for why the two are modeled separately). */
export function isSkillAvailable(initEvent, pluginName) {
  if (initEvent == null || !Array.isArray(initEvent.plugins)) return false;
  return initEvent.plugins.some((p) => p.name === pluginName);
}

/** The tool_result for a given tool_use id, found by scanning forward from fromIndex.
 * `is_error` is the real field name confirmed on a live "Unknown skill" transcript
 * (content: "<tool_use_error>Unknown skill: ...</tool_use_error>", is_error: true,
 * tool_use_id: "..."). `content` is exposed alongside index/isError (not extracted separately by
 * callers) so a single lookup gives both the correlation metadata AND the raw payload a grader
 * would parse -- findBashToolUsesWithResults is the current consumer of the content field. */
function findToolResultById(events, toolUseId, fromIndex) {
  for (let i = fromIndex; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'user') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_result' && c.tool_use_id === toolUseId) {
        return { index: i, isError: c.is_error === true, content: c.content ?? null };
      }
    }
  }
  return null;
}

/**
 * Whether `skillArg` (a Skill tool_use's own `input.skill` string) refers to the logical target
 * skill identified by (pluginName, skillName). A plugin-supplied skill is addressable on the wire
 * two ways: its bare skill name (the historical/legacy form this harness originally assumed was
 * the only one), or Claude Code's plugin-namespaced form `${pluginName}:${skillName}` -- the
 * canonical identity for any plugin-loaded skill per Claude Code's plugin/skill documentation
 * (plugin.json's own `name` field supplies the namespace prefix), not a version-specific quirk.
 * Confirmed live 2026-07-22: a real Claude Code 2.1.217 session invoked this harness's own target
 * skill via `kmp-test-runner:kmp-test-runner`, which the harness's exact-bare-match predicate
 * (the pre-fix version of this function's callers) wrongly classified as a foreign skill.
 *
 * `pluginName` and `skillName` are deliberately SEPARATE parameters, never derived from one
 * another (e.g. never `${skillName}:${skillName}`) -- this harness's own plugin and skill happen
 * to share the literal string "kmp-test-runner", but that is a fact about THIS harness's specific
 * plugin.json, not a property this function may assume. A caller whose plugin and skill names
 * genuinely differ gets the correct canonical form for free.
 *
 * A closed, exact-string allowlist of precisely these two forms -- deliberately never a
 * prefix/suffix/regex/case-insensitive match, so none of the following are ever silently accepted
 * as the target: a foreign namespace (`evil:kmp-test-runner`), a DIFFERENT skill from the SAME
 * plugin (`kmp-test-runner:some-other-skill-in-this-plugin`), a casing variant, leading/trailing
 * whitespace, or a double/nested namespace (`kmp-test-runner:kmp-test-runner:extra`).
 *
 * Fails closed on a misconfigured IDENTITY too, not just a malformed `skillArg` -- `pluginName`/
 * `skillName` must themselves be non-empty strings, or this always returns false regardless of
 * `skillArg`. Without this, a caller accidentally passing `pluginName:undefined` would silently
 * match a wire value literally containing the string "undefined" as its namespace prefix (JS's
 * own template-literal coercion), and a caller passing `skillName:''` would match an empty-string
 * `skillArg` -- this function's exported contract promises a closed allowlist, not just "correct
 * when called correctly."
 */
export function isTargetSkillReference(skillArg, pluginName, skillName) {
  if (typeof skillArg !== 'string') return false;
  if (typeof pluginName !== 'string' || pluginName.length === 0) return false;
  if (typeof skillName !== 'string' || skillName.length === 0) return false;
  return skillArg === skillName || skillArg === `${pluginName}:${skillName}`;
}

/**
 * Parses and strictly validates the init event's `skills[]` array (see `isSkillAvailable`'s own
 * doc comment: an unrelated, ambient set of bundled/managed skills present identically regardless
 * of `--plugin-dir` -- e.g. Claude Code's own bundled `run` skill, confirmed on a real live
 * scenario run whose no-skill cells were wrongly rejected for confirming it as if it were foreign
 * contamination). `ok:false` covers every way this array can fail to be trustworthy evidence: a
 * missing init event, a missing `skills` key entirely (a real init event always carries it -- see
 * this file's own header comment -- so a genuinely absent key is a structural anomaly, not a
 * legitimate "no ambient skills" signal), a non-array value, any non-string/empty-string entry, or
 * a duplicate entry. `names` is always a real Set (never null/undefined, even when `ok:false`) --
 * the TARGET skill's own bare/namespaced identity is stripped out via `isTargetSkillReference`
 * (the same closed allowlist every other identity check in this file uses, never a separately
 * invented match), since a current-skill cell's own loaded skill naturally appears in `skills[]`
 * and is not "ambient" -- it's the thing being measured.
 * @returns {{ok: boolean, names: Set<string>}}
 */
export function computeAmbientSkillProfile(initEvent, pluginName, skillName) {
  const raw = initEvent?.skills;
  const wellFormed = initEvent != null
    && Array.isArray(raw)
    && raw.every((s) => typeof s === 'string' && s.length > 0)
    && new Set(raw).size === raw.length;
  const cleanEntries = Array.isArray(raw) ? raw.filter((s) => typeof s === 'string' && s.length > 0) : [];
  const names = new Set(cleanEntries.filter((s) => !isTargetSkillReference(s, pluginName, skillName)));
  return { ok: wellFormed, names };
}

/** Canonical, order-independent string identity for an ambient-skill name Set -- the single
 * source of truth both the cross-cell equality check (a matrix's cells must agree exactly) and
 * `fingerprintAmbientSkillNames` (below) are built on, so "are these the same profile" and "what
 * hashes to what" can never drift apart into two independently-maintained notions of equality. */
export function canonicalAmbientSkillNamesKey(names) {
  return JSON.stringify([...names].sort());
}

/** Privacy-safe SHA-256 fingerprint of an ambient-skill name Set, for committed evidence (never
 * the raw names themselves -- see buildRunRecord's own `ambient_skill_profile` field). Built
 * directly on `canonicalAmbientSkillNamesKey` so two runs with the identical ambient profile
 * always fingerprint identically regardless of Set insertion order. */
export function fingerprintAmbientSkillNames(names) {
  return createHash('sha256').update(canonicalAmbientSkillNamesKey(names)).digest('hex');
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
export function findSkillInvocation(events, pluginName, skillName) {
  const matches = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_use' || c.name !== 'Skill' || !isTargetSkillReference(c.input?.skill, pluginName, skillName)) continue;
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
 * Every Skill tool_use block across the WHOLE transcript whose `input.skill` does NOT refer to the
 * logical target skill (pluginName, skillName), per isTargetSkillReference's closed allowlist --
 * including a missing or non-string `input.skill`. Distinct from findUnexpectedToolUses, which
 * only checks the tool NAME (Bash/Skill) and has no visibility into a Skill call's own arguments:
 * "Skill" is itself an allowed tool name regardless of which skill it targets, so a transcript
 * that invoked Skill with some OTHER skill name entirely passes findUnexpectedToolUses outright.
 * Meanwhile findSkillInvocation(events, pluginName, skillName) simply never matches that call --
 * it's scoped to the target skill only -- so an unrelated/foreign skill invocation is invisible to
 * skill_invocation_attempted/skill_invoked and can silently coexist with
 * attempted:false/invoked:false for the expected skill. Regression coverage for a real gap an
 * independent review pass demonstrated against the relaxed calibration contract (a no-skill arm
 * that never attempts kmp-test-runner can now legitimately show attempted:false/invoked:false --
 * without this check, a transcript that instead called some OTHER skill would show the exact same
 * attempted:false/invoked:false for kmp-test-runner, and pass unnoticed, potentially writing
 * contaminated evidence).
 */
export function findForeignSkillUses(events, pluginName, skillName) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_use' || c.name !== 'Skill') continue;
      const skillArg = c.input?.skill;
      if (!isTargetSkillReference(skillArg, pluginName, skillName)) {
        out.push({ index: i, receiptNs: ev._receiptNs, id: c.id, skillArg: typeof skillArg === 'string' ? skillArg : null });
      }
    }
  }
  return out;
}

/**
 * Every entry from findForeignSkillUses, additionally correlated with its OWN tool_result outcome
 * -- mirrors findBashToolUsesWithResults' and findSkillInvocation's identical correlation pattern
 * (both below), generalized to a foreign Skill call. Unlike findSkillInvocation (which aggregates
 * every matching attempt into one {attempted, confirmed, attemptCount, ...} summary for ONE target
 * skill), this returns one independent entry PER foreign call -- a transcript could probe several
 * different unrelated skill names, each with its own distinct result, and collapsing them into a
 * single aggregate would lose exactly which one(s) were confirmed vs. rejected vs. incomplete.
 * findForeignSkillUses itself is intentionally never modified -- every existing caller that only
 * checks its `.length === 0` (calibrationHardGate, smokeHardGate) keeps its exact current
 * contamination-detection contract unchanged; this function exists so a caller that DOES want the
 * result-aware distinction (the scenario matrix's hard gate) can make it, without duplicating the
 * underlying scan.
 *
 * `resultIsError`/`confirmed` follow the exact same null-when-absent convention as
 * findSkillInvocation/findBashToolUsesWithResults: `resultIsError: null` means no correlated
 * tool_result was found at all (a missing/structurally incomplete capture, not a demonstrated
 * outcome); `resultIsError: true` means a real "Unknown skill"-shaped rejection; `resultIsError:
 * false` -- including when `is_error` is absent from the tool_result entirely, per the documented
 * tool_result contract where an absent `is_error` also means success -- means a CONFIRMED foreign
 * invocation. `confirmed` is true only in that last case.
 */
export function classifyForeignSkillUses(events, pluginName, skillName) {
  return findForeignSkillUses(events, pluginName, skillName).map((u) => {
    const result = u.id != null ? findToolResultById(events, u.id, u.index + 1) : null;
    return {
      ...u,
      resultIsError: result ? result.isError : null,
      confirmed: result != null && result.isError === false,
    };
  });
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

/**
 * True only if the init event's OWN declared `plugins[]` array exactly matches what THIS
 * condition should have loaded -- zero plugins when the skill should be unavailable, or exactly
 * one plugin named `expectedPluginName` (no duplicates, no extras) when it should be available.
 * `expectedPluginName` is the PLUGIN's own identity (matched against `plugins[].name`, the init
 * event's plugin manifest) -- never the skill's own identity, even though this harness's plugin
 * and skill share one literal string value (see isTargetSkillReference's doc comment). Regression
 * coverage for a real gap an independent review pass demonstrated: neither `isSkillAvailable`
 * (only checks the target plugin is present SOMEWHERE in the array) nor `hasExpectedToolProfile`
 * (validates tools/mcp_servers/permissionMode but never inspects `plugins` at all) catches an
 * unexpected THIRD-PARTY plugin coexisting alongside -- or instead of -- the intended one. A
 * no-skill condition secretly carrying some other loaded plugin, or a current-skill condition
 * carrying extra unexpected plugins, isn't genuinely isolated, even though `skill_available` for
 * the TARGET skill still happens to read correctly.
 */
export function hasExpectedPluginProfile(initEvent, expectedPluginName, skillShouldBeLoaded) {
  if (initEvent == null || !Array.isArray(initEvent.plugins)) return false;
  if (!skillShouldBeLoaded) return initEvent.plugins.length === 0;
  return initEvent.plugins.length === 1 && initEvent.plugins[0]?.name === expectedPluginName;
}

/**
 * Every STRUCTURAL ambiguity in the transcript that would let a hard gate's simple "find the
 * first X" / "does at least one Y exist" checks be fooled by a malformed or adversarially-shaped
 * transcript. Returns a list of distinct issues found (empty = structurally sound):
 *  - exactly one `init` event required (not zero, not several) -- findInitEvent/findResultEvent
 *    silently take the FIRST and ignore the rest, so a transcript with a legitimate init/result
 *    pair FOLLOWED by a second, different init+result pair (e.g. a foreign plugin and a
 *    budget-truncated result) is completely invisible to every check built on top of those two
 *    functions.
 *  - exactly one terminal `result` event required, for the same reason.
 *  - every `tool_use` block must have a non-empty id, and no two `tool_use` blocks anywhere in
 *    the transcript may share the same id -- a duplicated id makes tool_use<->tool_result
 *    correlation itself ambiguous (a single tool_result could then appear to confirm TWO
 *    distinct calls, only one of which it legitimately belongs to).
 *  - every `tool_result`'s own `tool_use_id` must correspond to EXACTLY one `tool_use` in the
 *    transcript -- never zero (an ORPHAN result, referencing a call that was never made) and
 *    never more than one (a DUPLICATE result for the same call).
 *  - `init` must be the literal FIRST event in the whole transcript, and `result` must be
 *    positionally the LAST -- proving exactly one of each exists SOMEWHERE is not the same as
 *    proving WHERE. A transcript with `result` at index 0, `init` at index 1, and a Skill
 *    `tool_use` after the "terminal" result satisfied every check above while being structurally
 *    nonsensical; only meaningful once the single-init/single-result checks above already hold
 *    (an ambiguous count has no unique event to anchor an ordering check against). Matches the
 *    real stream-json protocol shape directly (a conversation begins with init and ends with
 *    result), not just "no tool_use/tool_result precedes init" -- a plain assistant TEXT message
 *    (no tool call at all) sitting before init is just as structurally invalid, and would
 *    otherwise be invisible to a check scoped only to tool_use/tool_result indices.
 * Regression coverage for a real gap an independent review pass demonstrated: both reproductions
 * (a second init+result pair appended after a legitimate first one; two Skill tool_use blocks
 * sharing one id satisfied by a single tool_result) returned {ok:true} against the hard gates as
 * they stood -- every existing check either reads "the first" event of its kind, or only
 * verifies "at least one" correlation exists, neither of which detects these shapes. A further
 * round found the ordering gap above: `result` before `init`, with real activity trailing the
 * fake "terminal" result, also returned {ok:true} with zero structural issues reported. A round
 * after that found the ordering check itself was still too narrow: a plain assistant TEXT message
 * (no tool_use) preceding init was invisible to a check that only looked at tool_use/tool_result
 * indices, also returning {ok:true}.
 * @returns {Array<{type: string, [key: string]: any}>}
 */
export function findTranscriptStructuralIssues(events) {
  const issues = [];
  const initIndices = [];
  const resultIndices = [];
  events.forEach((e, i) => {
    if (e.type === 'system' && e.subtype === 'init') initIndices.push(i);
    if (e.type === 'result') resultIndices.push(i);
  });
  if (initIndices.length !== 1) issues.push({ type: 'init_count', count: initIndices.length });
  if (resultIndices.length !== 1) issues.push({ type: 'result_count', count: resultIndices.length });

  const toolUseIds = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      if (typeof c.id !== 'string' || c.id.length === 0) {
        issues.push({ type: 'empty_tool_use_id' });
        continue;
      }
      toolUseIds.push(c.id);
    }
  }
  const toolUseIdCounts = new Map();
  for (const id of toolUseIds) toolUseIdCounts.set(id, (toolUseIdCounts.get(id) ?? 0) + 1);
  for (const [id, count] of toolUseIdCounts) {
    if (count > 1) issues.push({ type: 'duplicate_tool_use_id', id, count });
  }

  const uniqueToolUseIds = new Set(toolUseIds);
  const toolResultIdCounts = new Map();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'user') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_result') continue;
      const id = c.tool_use_id ?? null;
      toolResultIdCounts.set(id, (toolResultIdCounts.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of toolResultIdCounts) {
    if (id == null || !uniqueToolUseIds.has(id)) {
      issues.push({ type: 'orphan_tool_result', id });
      continue;
    }
    if (count > 1) issues.push({ type: 'duplicate_tool_result', id, count });
  }

  // Regression coverage for a review-round-5 finding: everything above proves exactly one init
  // and one result exist SOMEWHERE in the transcript, but never checked WHERE -- a transcript
  // with `result` at index 0, `init` at index 1, and a Skill tool_use AFTER the "terminal" result
  // returned zero issues here, and calibrationHardGate() returned {ok:true} for it. Only
  // meaningful when there's exactly one init and one result to anchor against -- a count mismatch
  // is already reported above, and anchoring an ordering check to an arbitrary "first" or "last"
  // one on a fundamentally ambiguous transcript would add noise, not signal.
  if (initIndices.length === 1 && resultIndices.length === 1) {
    const initIndex = initIndices[0];
    const resultIndex = resultIndices[0];
    // `result` must be positionally the LAST event in the whole transcript -- not merely present
    // and unique. Once this holds, every other real event (init included) necessarily precedes it
    // by construction, so this alone also proves "result comes after init".
    if (resultIndex !== events.length - 1) {
      issues.push({ type: 'result_not_last', resultIndex, eventsLength: events.length });
    }
    // `init` must be the literal FIRST event in the transcript, not merely "before every tool_use/
    // tool_result" -- a review-round-6 finding demonstrated a plain assistant TEXT message (no
    // tool_use at all) sitting before init was invisible to a check scoped to only tool_use/
    // tool_result indices: findTranscriptStructuralIssues() returned [] and calibrationHardGate()
    // returned {ok:true} for it. The real stream-json protocol begins with init and ends with
    // result, with nothing of any kind preceding the former -- this also subsumes the narrower
    // "no tool_use/tool_result before init" property a prior round checked directly (any such call
    // now trivially implies initIndex > 0 too).
    if (initIndex !== 0) {
      issues.push({ type: 'init_not_first', initIndex });
    }
  }

  return issues;
}

/**
 * Every `tool_use` block (any name) that either has no `id` at all, or an id with no correlated
 * `tool_result` found anywhere later in the transcript. Distinct from a call whose own
 * `tool_result` WAS found but reported `is_error:true` (a demonstrated, conclusive failure) --
 * this catches a genuinely INCOMPLETE capture, where what actually happened is simply unknown.
 * Regression coverage for a real gap an independent review pass demonstrated: `findSkillInvocation`
 * correctly reports `confirmed:false` for a dangling attempt with no result, but that's the exact
 * same `confirmed:false` a demonstrated `<tool_use_error>Unknown skill</tool_use_error>` result
 * produces -- the hard gates collapsed both into "safe" via `skill_invoked:false` alone,
 * accepting a dangling attempt as if it were a proven clean rejection. Scans every tool_use
 * regardless of name (Bash, Skill, or anything else) so it protects both calibration (which has
 * no per-command result verification of its own) and smoke.
 */
export function findIncompleteToolResults(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      if (c.id == null) {
        out.push({ index: i, receiptNs: ev._receiptNs, name: c.name, id: null });
        continue;
      }
      if (findToolResultById(events, c.id, i + 1) == null) {
        out.push({ index: i, receiptNs: ev._receiptNs, name: c.name, id: c.id });
      }
    }
  }
  return out;
}

/** Every `tool_use` block's own event index, any name -- the shared scan
 * findIncompleteToolResultsToleratingTimeout needs to determine whether a single incomplete result
 * is genuinely the LAST activity in the transcript (causally compatible with an abrupt kill) or
 * merely the last INCOMPLETE one (which could still be followed by a later, completed call --
 * itself a sign of corruption, not a timeout, since a real single-threaded transcript can't have a
 * later call finish while an earlier one is still unresolved). */
function allToolUseIndices(events) {
  const indices = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_use') indices.push(i);
    }
  }
  return indices;
}

/**
 * findTranscriptStructuralIssues, but tolerant of the ONE specific symptom a legitimate timeout
 * causes: a missing terminal `result` event (the process was killed mid-stream, before Claude Code
 * had a chance to emit it). `terminated`/`terminationReason` come from the harness's OWN kill logic
 * (condition-launcher.mjs's spawnCondition), never inferred from the transcript itself -- that's
 * the authoritative signal a timeout genuinely happened, independent of what the JSONL looks like.
 * Only filters a `result_count` issue whose count is exactly 0, and only when
 * `terminated===true && terminationReason==='timeout'`; `result_count > 1` (a genuinely different,
 * still-blocking problem) is never filtered regardless of timeout status. Every OTHER issue type
 * (missing/duplicate init, duplicate/orphan tool_use<->tool_result ids, init not first) remains
 * fully blocking under a timeout exactly as without one -- a timeout excuses only the one specific,
 * structurally-expected absence it actually causes, nothing else, so a GENUINELY corrupted
 * transcript that happens to also lack a result event is not let through by coincidence.
 */
export function findTranscriptStructuralIssuesToleratingTimeout(events, { terminated, terminationReason }) {
  const issues = findTranscriptStructuralIssues(events);
  const isLegitimateTimeout = terminated === true && terminationReason === 'timeout';
  if (!isLegitimateTimeout) return issues;
  return issues.filter((issue) => !(issue.type === 'result_count' && issue.count === 0));
}

/**
 * findIncompleteToolResults, but tolerant of the ONE specific symptom a legitimate timeout causes:
 * a tool_use whose result never arrived because the process was killed mid-call. Tolerates AT MOST
 * ONE incomplete result, and only when it is the chronologically LAST tool_use in the entire
 * transcript (any name) -- an incomplete result that ISN'T the last tool_use, or more than one
 * incomplete result, indicates genuine corruption (not explainable by a single abrupt kill) and
 * remains fully blocking regardless of timeout status. Same `terminated`/`terminationReason`
 * authority as findTranscriptStructuralIssuesToleratingTimeout -- never inferred from the
 * transcript.
 */
export function findIncompleteToolResultsToleratingTimeout(events, { terminated, terminationReason }) {
  const incomplete = findIncompleteToolResults(events);
  const isLegitimateTimeout = terminated === true && terminationReason === 'timeout';
  if (!isLegitimateTimeout) return incomplete;
  if (incomplete.length !== 1) return incomplete;
  const allIndices = allToolUseIndices(events);
  const lastToolUseIndex = allIndices.length > 0 ? Math.max(...allIndices) : null;
  if (incomplete[0].index !== lastToolUseIndex) return incomplete;
  return [];
}

/** Every Bash tool_use, each correlated with its OWN tool_result outcome (mirrors
 * findSkillInvocation's attempted-vs-confirmed correlation, generalized to every Bash call).
 * Needed to verify not just THAT commands ran, but that each one's own result was not an error,
 * and exactly WHICH commands ran -- "the agent invoked Bash twice" alone doesn't prove it ran
 * the two SPECIFIC expected commands, or that either one actually succeeded.
 *
 * `resultIndex`/`resultContent` (additive -- every existing field is unchanged) are what a grader
 * needs beyond the boolean resultFound/resultIsError summary: `resultIndex` is the event index a
 * "first correlated authoritative outcome event" (first_useful_signal) is ultimately derived from
 * (via deriveFirstUsefulSignalMs, never computed as a timestamp here); `resultContent` is the raw
 * tool_result payload a grader parses as a kmp-test JSON envelope or Gradle/JUnit evidence -- both
 * `null` when no result was found, exactly mirroring resultIsError's existing null-when-absent
 * convention. */
export function findBashToolUsesWithResults(events) {
  return findBashToolUses(events).map((u) => {
    const result = u.id != null ? findToolResultById(events, u.id, u.index + 1) : null;
    return {
      ...u,
      command: u.input?.command ?? null,
      resultFound: result != null,
      resultIsError: result ? result.isError : null,
      resultIndex: result ? result.index : null,
      resultContent: result ? result.content : null,
    };
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
