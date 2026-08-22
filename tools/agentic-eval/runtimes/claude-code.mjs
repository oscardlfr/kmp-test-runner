#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/runtimes/claude-code.mjs -- the Claude Code runtime adapter: the ONE module
// that knows argv/auth/stream-json/events/hooks/plugins/Skill/pre-dispatch-block shapes belong to
// Claude Code specifically. Composes the frozen condition-launcher/auth-preflight/env-builder/
// stream-parser/privacy modules verbatim (their own bodies are unchanged and untouched by this
// PR) behind the runtimes/contract.mjs boundary -- this file is the only new consumer of those
// five modules.
//
// isPluginBoundToSnapshot and EXPECTED_TOOL_NAMES moved here from cell-integrity.mjs (unchanged
// logic) -- both are genuinely Claude-specific facts (a real plugin.json path on disk; the exact
// --tools value this harness launches `claude` with), not core lifecycle concepts. cell-integrity.mjs
// no longer needs its own copy: the observation contract already carries the derived booleans
// (session.toolProfileMatchesExpected, toolAttempts[].profileAllowed, skill.snapshotBindingMatches).
import { statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { defineRuntimeAdapter } from './contract.mjs';
import {
  buildBaseInvocation, buildConditionArgv, buildSharedEnv, buildPolicySettingsFile, spawnCondition,
} from '../condition-launcher.mjs';
import { runAuthPreflight, authPreflightReasonCode } from '../auth-preflight.mjs';
import {
  parseStreamJsonl, findInitEvent, findResultEvent, findSkillInvocation, countHookEvents,
  computeByteMetrics, findAllToolUsesWithResults, isTargetSkillReference, classifyForeignSkillUses,
  hasExpectedToolProfile, hasExpectedPluginProfile, isSkillAvailable, computeAmbientSkillProfile,
  extractTokenUsage, findTranscriptStructuralIssues, findTranscriptStructuralIssuesToleratingTimeout,
  findIncompleteToolResults, findIncompleteToolResultsToleratingTimeout, isRecognizedPreDispatchBlock,
} from '../stream-parser.mjs';
import { redactAndVerify, redactObjectAndVerify } from '../privacy.mjs';

/** The ONLY tools either condition's own --tools argv value ever grants -- moved here verbatim
 * from cell-integrity.mjs (was a private module-level const there). */
export const EXPECTED_TOOL_NAMES = new Set(['Bash', 'Skill']);

/** Moved here verbatim from cell-integrity.mjs (logic unchanged) -- proves the loaded plugin's
 * own reported path is the SAME physical directory as this run's materialized skill snapshot, not
 * merely a same-named plugin loaded from somewhere else. Compared via filesystem identity
 * (device+inode from statSync), never a string path comparison. Fails closed on any unresolvable
 * path. Deliberately returns ONLY a boolean -- the actual paths are never included in the return
 * value. */
export function isPluginBoundToSnapshot(initEvent, expectedSnapshotDir) {
  if (initEvent == null || !Array.isArray(initEvent.plugins) || initEvent.plugins.length !== 1) return false;
  const reportedPath = initEvent.plugins[0]?.path;
  if (typeof reportedPath !== 'string' || reportedPath.length === 0) return false;
  if (typeof expectedSnapshotDir !== 'string' || expectedSnapshotDir.length === 0) return false;
  let reportedStat;
  let expectedStat;
  try {
    reportedStat = statSync(reportedPath, { bigint: true });
  } catch {
    return false;
  }
  try {
    expectedStat = statSync(expectedSnapshotDir, { bigint: true });
  } catch {
    return false;
  }
  return reportedStat.dev === expectedStat.dev && reportedStat.ino === expectedStat.ino;
}

/** The literal signature ID the pre-dispatch-block observation carries -- the one, closed string
 * this whole codebase uses to identify a recognized Claude-Code-internal pre-dispatch tool block
 * (see stream-parser.mjs's isRecognizedPreDispatchBlock doc comment for the product-behavior this
 * represents). */
const PRE_DISPATCH_BLOCK_SIGNATURE = 'claude-code/bash-pre-dispatch-block/v1';

/**
 * `probeInstallation(context)` encapsulates an injectable, unit-testable installation probe. Not
 * wired to the real CLI flow in this PR (adding a new subprocess call site would change
 * equivalence) -- `spawnFn` is REQUIRED, never defaulted to a real spawn, so a caller can never
 * accidentally shell out to a real `claude` binary from this method.
 * @returns {Promise<{installed: boolean, version: string|null}>}
 */
export async function probeInstallation({ spawnFn, timeoutMs = 10000 } = {}) {
  if (typeof spawnFn !== 'function') {
    throw new Error('probeInstallation requires an injected spawnFn in this PR -- it is not wired to a real subprocess by default');
  }
  const result = await spawnFn(['claude', '--version'], { timeoutMs });
  if (result.terminated === true || result.exitCode !== 0) {
    return { installed: false, version: null };
  }
  const match = typeof result.rawStdout === 'string' ? result.rawStdout.match(/(\d+\.\d+\.\d+)/) : null;
  return { installed: true, version: match ? match[1] : null };
}

/**
 * `preflight(context)` delegates exactly to runAuthPreflight, with the same argv/env/cwd/timeout
 * and the same four closed codes -- `reasonCode` comes from the existing authPreflightReasonCode
 * helper (computed only when `!ok`, mirroring every existing call site's own usage), so core never
 * imports or reimplements that derivation.
 * @returns {Promise<{ok: boolean, terminated: boolean, exitCode: number|null, loggedIn: boolean|null, reasonCode: string|null}>}
 */
export async function preflight({ sharedEnv, repoRoot, timeoutMs, spawnFn } = {}) {
  const args = { sharedEnv, repoRoot };
  if (timeoutMs !== undefined) args.timeoutMs = timeoutMs;
  if (spawnFn !== undefined) args.spawnFn = spawnFn;
  const result = await runAuthPreflight(args);
  return {
    ok: result.ok,
    terminated: result.terminated,
    exitCode: result.exitCode,
    loggedIn: result.loggedIn,
    reasonCode: result.ok ? null : authPreflightReasonCode(result),
  };
}

/** True iff `executionProfile` is genuinely a policy_mode:"not_applicable" profile -- the ONE
 * semantic switch prepareIsolatedHome/buildInvocation key their profile-aware compilation off of
 * (never off a profile id list, which would need updating every time a new policy_mode:required
 * profile is added). Omitted/null defaults to `false` (policy required) -- the safe, strict
 * default matches this adapter's pre-existing behavior for every caller that predates this
 * parameter, and fails CLOSED (toward the more restrictive strict shape) rather than open if a
 * caller ever forgets to pass one. */
function isPolicyNotApplicable(executionProfile) {
  return executionProfile != null && executionProfile.policy_mode === 'not_applicable';
}

/**
 * `prepareIsolatedHome(context)` builds the same runtime environment/config as today:
 * buildPolicySettingsFile + buildSharedEnv. Self-contained rollback (mirrors
 * acquireSharedEvalResources' own incremental-cleanup pattern at the scope this method actually
 * owns): if buildSharedEnv rejects an invalid policy, the settings directory this method already
 * created is removed before rethrowing, rather than leaking it for the caller to discover.
 *
 * `executionProfile` (PR 4): when it is a policy_mode:"not_applicable" profile
 * (sandboxed-unrestricted-v1), the produced settings carry no PreToolUse policy hook and the
 * produced env carries no KMP_EVAL_ALLOWED_* keys -- everything else (JUnit hooks when requested,
 * PATH/GRADLE_USER_HOME/KMP_EVAL_TEMP_HOME/KMP_EVAL_EXPECTED_FIXTURE_ROOT, and the allowlist
 * grammar validation itself) is unchanged. Omitting it entirely preserves strict's exact
 * pre-existing behavior byte-for-byte.
 * @returns {Promise<{sharedEnv: object, settingsPath: string, cleanupPaths: string[]}>}
 */
export async function prepareIsolatedHome({
  shimDir, gradleUserHome, kmpEvalTempHome, expectedFixtureRoot, allowedGradleTasks, allowedKmpTestSubcommands,
  junitEvidenceEnabled = false, executionProfile = null,
} = {}) {
  const policyApplies = !isPolicyNotApplicable(executionProfile);
  const settingsPath = buildPolicySettingsFile({ junitEvidenceEnabled, policyHookEnabled: policyApplies });
  const settingsDir = dirname(settingsPath);
  let sharedEnv;
  try {
    sharedEnv = buildSharedEnv({
      shimDir, gradleUserHome, kmpEvalTempHome, expectedFixtureRoot, allowedGradleTasks, allowedKmpTestSubcommands,
      includePolicyEnv: policyApplies,
    });
  } catch (err) {
    rmSync(settingsDir, { recursive: true, force: true });
    throw err;
  }
  return { sharedEnv, settingsPath, cleanupPaths: [settingsDir] };
}

function isPlainObjectLike(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The CLOSED set of execution-profile configurations this adapter actually implements -- exactly
 * strict-policy-v1's and sandboxed-unrestricted-v1's current real semantics (registries.mjs's real
 * registry entries). Any OTHER id, or a mutation of either entry's own
 * isolation/network/attestation/policy/capability fields, is rejected: buildInvocation only ever
 * receives what this adapter itself derives from the exact matched entry below, so a profile
 * requiring e.g. a different isolation boundary or network mode would otherwise be silently
 * unenforced while the resulting record still claimed it. A future profile becomes selectable only
 * once a later PR adds real runtime-specific implementation work for it and this list is
 * deliberately widened -- never by loosening either existing entry or this check itself. */
const SUPPORTED_EXECUTION_PROFILES = Object.freeze([
  Object.freeze({
    id: 'strict-policy-v1',
    isolation_kind: 'runtime-policy-hooks',
    network_mode: 'runtime-default',
    isolation_attestation_required: false,
    policy_mode: 'required',
    required_capabilities: Object.freeze(['softPermissionDenial']),
  }),
  Object.freeze({
    id: 'sandboxed-unrestricted-v1',
    isolation_kind: 'external-sandbox',
    network_mode: 'restricted',
    isolation_attestation_required: true,
    policy_mode: 'not_applicable',
    required_capabilities: Object.freeze(['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence']),
  }),
]);

function sameStringArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function matchesExecutionProfileShape(profileEntry, supported) {
  return profileEntry.id === supported.id
    && profileEntry.isolation_kind === supported.isolation_kind
    && profileEntry.network_mode === supported.network_mode
    && profileEntry.isolation_attestation_required === supported.isolation_attestation_required
    && profileEntry.policy_mode === supported.policy_mode
    && sameStringArray(profileEntry.required_capabilities, supported.required_capabilities);
}

/** `supportsModelConfiguration(modelEntry)`: pure, fail-closed. Claude Code accepts an additional
 * model only when it genuinely IS a Claude Code / Anthropic model with default_reasoning_mode
 * null -- model_id itself is registry-only (it is passed literally to the CLI via
 * buildInvocation's own `model` argument), but a non-null reasoning mode has no corresponding
 * argv/config wiring anywhere in this adapter, so selecting such a model would silently ignore
 * the very configuration the record claims was applied. Codex round 3, Finding 3: runtime_id and
 * model_vendor_expected are ALSO bound here, not left to the caller's own bookkeeping -- a model
 * entry claiming runtime_id:'claude-code' but model_vendor_expected:'openai' (or vice versa) is
 * nonsensical and must be rejected by the one adapter that would actually be asked to serve it. */
export function supportsModelConfiguration(modelEntry) {
  return isPlainObjectLike(modelEntry)
    && modelEntry.runtime_id === 'claude-code'
    && modelEntry.model_vendor_expected === 'anthropic'
    && modelEntry.default_reasoning_mode === null;
}

/** `supportsExecutionProfile(profileEntry)`: pure, fail-closed. See SUPPORTED_EXECUTION_PROFILES'
 * own doc comment -- exact structural equality against ONE of the closed set of profile shapes
 * this adapter's buildInvocation/prepareIsolatedHome pipeline actually enforces today. A profile
 * sharing an id with a supported entry but differing in any other field matches neither entry (an
 * id-only match never counts as support). */
export function supportsExecutionProfile(profileEntry) {
  return isPlainObjectLike(profileEntry)
    && SUPPORTED_EXECUTION_PROFILES.some((supported) => matchesExecutionProfileShape(profileEntry, supported));
}

/** `prepareSkillDelivery(invocation, condition, snapshotDir)` delegates exactly to
 * buildConditionArgv: no-skill adds nothing; current-skill appends only
 * `--plugin-dir <snapshotDir>` at the end of argv, preserving stdinText. */
export function prepareSkillDelivery(argv, condition, snapshotDir) {
  return buildConditionArgv(argv, condition, snapshotDir);
}

/** `buildInvocation(context)` conserves the Claude flag shape for strict (executionProfile
 * omitted, or a policy_mode:"required" profile), while carrying the prompt over stdin instead of
 * argv. A policy_mode:"not_applicable" profile (sandboxed-unrestricted-v1) compiles the identical
 * argv shape/order with ONLY
 * `--permission-mode` swapped to `bypassPermissions` -- the sole non-interactive permission mode
 * `claude-code 2.1.227 --help` documents for this purpose (see the runbook's own Decision C;
 * `--dangerously-skip-permissions` is never used). */
export function buildInvocation({ executionProfile, ...rest }) {
  const permissionMode = isPolicyNotApplicable(executionProfile) ? 'bypassPermissions' : 'dontAsk';
  return buildBaseInvocation({ ...rest, permissionMode });
}

/**
 * `collectObservationSources(invocation, spawnOpts)` conserves spawnCondition, including timeout,
 * tree kill, receipts, stdout and stderr -- returns the ephemeral envelope
 * `{process, capture, providerSources}` the generic executor coordinates collect -> persist
 * callback -> normalize -> validate around. `providerSources` is opaque to the core: only
 * normalizeObservations may inspect it.
 * @returns {Promise<{process: object, capture: {primaryText: string, stderrText: string}, providerSources: object}>}
 */
export async function collectObservationSources(argv, { env, cwd, timeoutMs, onSpawned } = {}) {
  const spawnResult = await spawnCondition(argv, { env, cwd, timeoutMs, onSpawned });
  return {
    process: {
      exitCode: spawnResult.exitCode,
      terminated: spawnResult.terminated,
      terminationReason: spawnResult.terminationReason,
      spawnHrtimeNs: spawnResult.spawnHrtimeNs,
      endedHrtimeNs: spawnResult.endedHrtimeNs,
    },
    capture: { primaryText: spawnResult.rawStdout, stderrText: spawnResult.stderr },
    providerSources: { rawJsonl: spawnResult.rawStdout, taggedLines: spawnResult.taggedLines },
  };
}

/**
 * `normalizeObservations(sources, context)` is the only new place that calls stream-parser.mjs
 * helpers and produces `condition-observation-v1`. Reads process-outcome facts exclusively from
 * `sources.process` (the real spawn envelope); reads classification parameters
 * (condition/targetPluginName/targetSkillName/expectedToolNames/expectedSnapshotDir/
 * executionProfile) from `context`. Never copies raw events into the returned object, never adds a
 * legacy alias.
 *
 * PR 4 follow-up (P1 finding): `context.executionProfile` -- defaulting to `null`, exactly like
 * every OTHER executionProfile-aware parameter in this file -- decides which ONE permissionMode
 * value `session.toolProfileMatchesExpected` requires (`isPolicyNotApplicable(executionProfile)`
 * -> `'bypassPermissions'`, otherwise `'dontAsk'`), via `hasExpectedToolProfile`'s own
 * `expectedPermissionMode` parameter. This is the ONE place that derivation happens -- never
 * guessed independently elsewhere, and never widened back to "accept either value for any
 * profile" (that was the P1 bug itself: a strict-policy-v1 transcript reporting
 * `bypassPermissions` -- exactly the shape a real `buildInvocation` regression would produce --
 * must fail this check, not pass it).
 * @param {{process: object, capture: object, providerSources: {rawJsonl: string, taggedLines?: Array}}} sources
 * @param {{condition: string, targetPluginName: string, targetSkillName: string, expectedToolNames?: Set<string>, expectedSnapshotDir?: string, executionProfile?: object|null}} context
 */
export function normalizeObservations(sources, context) {
  const { targetPluginName, targetSkillName, expectedSnapshotDir, executionProfile = null } = context;
  const expectedToolNames = context.expectedToolNames ?? EXPECTED_TOOL_NAMES;
  const expectSkillAvailable = context.condition === 'current-skill';
  const expectedPermissionMode = isPolicyNotApplicable(executionProfile) ? 'bypassPermissions' : 'dontAsk';
  const rawJsonl = sources.providerSources.rawJsonl;

  const { events, malformedLines } = parseStreamJsonl(
    rawJsonl,
    sources.providerSources.taggedLines ? { taggedLines: sources.providerSources.taggedLines } : undefined,
  );
  const init = findInitEvent(events);
  const result = findResultEvent(events);

  const session = {
    initPresent: init != null,
    modelResolved: init?.model ?? null,
    sessionIdObserved: typeof init?.session_id === 'string' ? init.session_id : null,
    runtimeVersion: init?.claude_code_version ?? null,
    toolProfileMatchesExpected: hasExpectedToolProfile(init, expectedToolNames, expectedPermissionMode),
  };

  const usageRaw = extractTokenUsage(result);
  const terminal = {
    present: result != null,
    isError: result != null ? result.is_error === true : null,
    turnCount: result != null && Number.isInteger(result.num_turns) ? result.num_turns : null,
    finalText: result != null && typeof result.result === 'string' ? result.result : null,
    resultSubtype: result != null && typeof result.subtype === 'string' ? result.subtype : null,
    usage: {
      input: usageRaw?.input ?? null,
      cached_input: usageRaw?.cache_read ?? null,
      cache_write: usageRaw?.cache_creation ?? null,
      output: usageRaw?.output ?? null,
      reasoning_output: null,
    },
  };

  const timeoutCtx = { terminated: sources.process?.terminated, terminationReason: sources.process?.terminationReason };
  // Native array shapes preserved (not reduced to .length) -- graders.mjs's gradeScenarioCondition
  // needs the actual issue types (grading_checks[].detail) and incomplete-result event indices
  // (grading_checks[].evidence_event_indices), both committed schema-v5 content. See this module's
  // own header note on why this differs from a literal count-only reading of the field names.
  const normalizeIncomplete = (list) => list.map((x) => ({
    index: x.index, receiptNs: typeof x.receiptNs === 'bigint' ? x.receiptNs : null,
    name: x.name ?? null, id: x.id ?? null,
  }));
  const transcript = {
    malformedLineCount: malformedLines.length,
    strictStructuralIssues: findTranscriptStructuralIssues(events),
    effectiveStructuralIssues: findTranscriptStructuralIssuesToleratingTimeout(events, timeoutCtx),
    strictIncompleteToolResults: normalizeIncomplete(findIncompleteToolResults(events)),
    effectiveIncompleteToolResults: normalizeIncomplete(findIncompleteToolResultsToleratingTimeout(events, timeoutCtx)),
  };

  const allToolUses = findAllToolUsesWithResults(events);
  const toolAttempts = allToolUses.map((u) => {
    const kind = u.name === 'Skill' ? 'skill' : u.name === 'Bash' ? 'shell' : 'other';
    const command = kind === 'shell' ? (typeof u.input?.command === 'string' ? u.input.command : null) : null;
    const skillReference = kind === 'skill' && typeof u.input?.skill === 'string' ? u.input.skill : null;
    const targetsExpectedSkill = kind === 'skill' ? isTargetSkillReference(u.input?.skill, targetPluginName, targetSkillName) : null;
    const textStatus = !u.resultFound ? 'missing' : (typeof u.resultContent === 'string' ? 'text' : 'unsupported');
    const recognized = isRecognizedPreDispatchBlock(u);
    return {
      id: u.id ?? null,
      kind,
      runtimeName: u.name ?? null,
      eventIndex: u.index,
      receiptNs: typeof u.receiptNs === 'bigint' ? u.receiptNs : null,
      profileAllowed: expectedToolNames.has(u.name),
      command,
      skillReference,
      targetsExpectedSkill,
      result: {
        found: u.resultFound,
        eventIndex: u.resultFound ? u.resultIndex : null,
        isError: u.resultFound ? u.resultIsError : null,
        text: textStatus === 'text' ? u.resultContent : null,
        textStatus,
      },
      preDispatchBlock: { recognized, signature: recognized ? PRE_DISPATCH_BLOCK_SIGNATURE : null },
    };
  });

  const invocation = findSkillInvocation(events, targetPluginName, targetSkillName);
  const targetInvocation = invocation == null ? null : {
    attempted: true,
    confirmed: invocation.confirmed,
    attemptCount: invocation.attemptCount,
    eventIndex: invocation.index,
    receiptNs: typeof invocation.receiptNs === 'bigint' ? invocation.receiptNs : null,
    resultIsError: invocation.resultIsError,
  };
  const foreignInvocations = classifyForeignSkillUses(events, targetPluginName, targetSkillName).map((f) => ({
    eventIndex: f.index,
    receiptNs: typeof f.receiptNs === 'bigint' ? f.receiptNs : null,
    id: f.id ?? null,
    skillReference: f.skillArg ?? null,
    resultIsError: f.resultIsError,
    confirmed: f.confirmed,
  }));
  const ambientProfile = computeAmbientSkillProfile(init, targetPluginName, targetSkillName, { expectTargetPresent: expectSkillAvailable });
  const skill = {
    available: isSkillAvailable(init, targetPluginName),
    profileMatchesCondition: hasExpectedPluginProfile(init, targetPluginName, expectSkillAvailable),
    snapshotBindingMatches: isPluginBoundToSnapshot(init, expectedSnapshotDir ?? null),
    targetInvocation,
    foreignInvocations,
    ambient: {
      names: ambientProfile.names,
      structurallyWellFormed: ambientProfile.structurallyWellFormed,
      targetIdentityOk: ambientProfile.targetIdentityOk,
    },
  };

  const receiptNsByEventIndex = new Map();
  events.forEach((ev, i) => {
    if (typeof ev._receiptNs === 'bigint') receiptNsByEventIndex.set(i, ev._receiptNs);
  });

  return {
    schema: 1,
    runtime: { id: 'claude-code', protocolVersion: 1 },
    process: sources.process,
    session,
    transcript,
    terminal,
    toolAttempts,
    skill,
    hookStats: countHookEvents(events),
    byteMetrics: computeByteMetrics(rawJsonl, events),
    timing: { receiptNsByEventIndex },
  };
}

/** `redactRuntimeDiagnostics(value)` delegates to the existing privacy primitive -- a best-effort,
 * diagnostics-tier redaction; it never substitutes the final journal/incident/rejection-tier
 * redaction (assertCleanOrThrow/assertCleanOrThrowObject), which stays exactly as strict
 * (throw-on-leak) as it is today. A diagnostic string/object this cannot fully clean is replaced
 * by a closed sentinel rather than thrown or left partially redacted. */
export function redactRuntimeDiagnostics(value) {
  if (typeof value === 'string') {
    const { ok, redacted } = redactAndVerify(value);
    return ok ? redacted : '[redaction-incomplete]';
  }
  if (value !== null && typeof value === 'object') {
    const { ok, redactedObj } = redactObjectAndVerify(value);
    return ok ? redactedObj : { redaction: 'incomplete' };
  }
  return value;
}

export const claudeCodeRuntimeAdapter = defineRuntimeAdapter({
  id: 'claude-code',
  protocolVersion: 1,
  capabilities: {
    observationSources: ['stream-jsonl', 'stderr'],
    structuredTranscript: true,
    correlatedToolResults: true,
    skillDeliveryModes: ['plugin-dir'],
    skillStateEvidence: true,
    usageDimensions: ['input', 'cached_input', 'cache_write', 'output'],
    softPermissionDenial: true,
  },
  supportsModelConfiguration,
  supportsExecutionProfile,
  probeInstallation,
  preflight,
  prepareIsolatedHome,
  prepareSkillDelivery,
  buildInvocation,
  collectObservationSources,
  normalizeObservations,
  redactRuntimeDiagnostics,
});

export default claudeCodeRuntimeAdapter;
