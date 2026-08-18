#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/runtimes/contract.mjs -- the runtime-agnostic adapter contract: the closed
// shape every coding-agent runtime adapter must satisfy, the closed shape every normalized
// observation must satisfy, and the small set of generic (non-provider-specific) helpers core
// consumers (cli.mjs, matrix-runner.mjs, cell-integrity.mjs, graders.mjs, accepted-run-audit.mjs,
// junit-evidence.mjs) use instead of reaching into a provider's own wire format.
//
// Deliberately imports nothing from a runtime-specific module (stream-parser.mjs,
// condition-launcher.mjs, auth-preflight.mjs, env-builder.mjs) and nothing from
// runtimes/claude-code.mjs -- the dependency arrow points the other way (adapters depend on this
// contract, never the reverse). Every error this module reports is a closed {field, code} pair;
// never raw adapter/observation content (paths, env values, prompts, session IDs, transcript text).
import { createHmac } from 'node:crypto';

export const ADAPTER_KEYS = Object.freeze([
  'id', 'protocolVersion', 'capabilities', 'probeInstallation', 'preflight',
  'prepareIsolatedHome', 'prepareSkillDelivery', 'buildInvocation',
  'collectObservationSources', 'normalizeObservations', 'redactRuntimeDiagnostics',
]);

export const CAPABILITY_KEYS = Object.freeze([
  'observationSources', 'structuredTranscript', 'correlatedToolResults',
  'skillDeliveryModes', 'skillStateEvidence', 'usageDimensions', 'softPermissionDenial',
]);

// The closed, ORDERED universe of usage dimensions -- a capability's own usageDimensions must be
// an ordered subset of exactly this sequence (never a runtime-specific superset).
export const USAGE_DIMENSIONS = Object.freeze(['input', 'cached_input', 'cache_write', 'output', 'reasoning_output']);

export const OBSERVATION_KEYS = Object.freeze([
  'schema', 'runtime', 'process', 'session', 'transcript', 'terminal',
  'toolAttempts', 'skill', 'hookStats', 'byteMetrics', 'timing',
]);

export const TOOL_ATTEMPT_KEYS = Object.freeze([
  'id', 'kind', 'runtimeName', 'eventIndex', 'receiptNs', 'profileAllowed', 'command',
  'skillReference', 'targetsExpectedSkill', 'result', 'preDispatchBlock',
]);

export const TOOL_ATTEMPT_KINDS = Object.freeze(['shell', 'skill', 'other']);
export const TEXT_STATUS_VALUES = Object.freeze(['text', 'missing', 'unsupported']);

const RUNTIME_REF_KEYS = ['id', 'protocolVersion'];
const PROCESS_KEYS = ['exitCode', 'terminated', 'terminationReason', 'spawnHrtimeNs', 'endedHrtimeNs'];
const SESSION_KEYS = ['initPresent', 'modelResolved', 'sessionIdObserved', 'runtimeVersion', 'toolProfileMatchesExpected'];
const TRANSCRIPT_KEYS = ['malformedLineCount', 'strictStructuralIssues', 'effectiveStructuralIssues', 'strictIncompleteToolResults', 'effectiveIncompleteToolResults'];
// {strict,effective}StructuralIssues/{strict,effective}IncompleteToolResults are ARRAYS (the
// native findTranscriptStructuralIssues()/findIncompleteToolResults() shapes), not counts --
// additive precision beyond a literal count-only reading of the runbook's field names. graders.mjs's
// gradeScenarioCondition needs the actual issue TYPES (grading_checks[].detail text) and the
// actual incomplete-result event INDICES (grading_checks[].evidence_event_indices), both committed
// schema-v5 record content the runbook's own Stage 4.2 instruction requires to stay identical --
// unreconstructable from a bare count once the legacy `.events` array is retired. malformedLineCount
// alone stays a plain count: it is the one field of the five actually named "...Count", and its own
// source (`malformedLines`) carries the RAW malformed JSONL line text, which must never enter the
// observation.
const STRUCTURAL_ISSUE_TYPES = ['init_count', 'result_count', 'empty_tool_use_id', 'duplicate_tool_use_id', 'orphan_tool_result', 'duplicate_tool_result', 'result_not_last', 'init_not_first'];
const STRUCTURAL_ISSUE_EXTRA_KEYS = ['count', 'id', 'resultIndex', 'eventsLength', 'initIndex'];
const INCOMPLETE_RESULT_KEYS = ['index', 'receiptNs', 'name', 'id'];
// resultSubtype is additive beyond the runbook's literal terminal spec ({present, isError,
// turnCount, finalText, usage}) -- calibrationHardGate/smokeHardGate (cli.mjs) need it alongside
// isError to detect e.g. a budget-cut session (subtype:'error_max_budget_usd', which is NOT
// necessarily paired with is_error:true); without it their resultOk check is unreconstructable
// once the legacy `.result` container is retired from conditionResult. Same raw-value-passthrough
// precedent as modelResolved/sessionIdObserved/runtimeVersion/finalText.
const TERMINAL_KEYS = ['present', 'isError', 'turnCount', 'finalText', 'resultSubtype', 'usage'];
const TOOL_RESULT_KEYS = ['found', 'eventIndex', 'isError', 'text', 'textStatus'];
const PRE_DISPATCH_KEYS = ['recognized', 'signature'];
const SKILL_KEYS = ['available', 'profileMatchesCondition', 'snapshotBindingMatches', 'targetInvocation', 'foreignInvocations', 'ambient'];
const TARGET_INVOCATION_KEYS = ['attempted', 'confirmed', 'attemptCount', 'eventIndex', 'receiptNs', 'resultIsError'];
const FOREIGN_INVOCATION_KEYS = ['eventIndex', 'receiptNs', 'id', 'skillReference', 'resultIsError', 'confirmed'];
const AMBIENT_KEYS = ['names', 'structurallyWellFormed', 'targetIdentityOk'];
const HOOK_STATS_KEYS = ['hookCallCount', 'hookResponseCount', 'hookDenyCount', 'hookAllowCount', 'hookPairingOk', 'everyCallHooked'];
const BYTE_METRICS_KEYS = ['outputBytes', 'streamJsonBytes'];
const TIMING_KEYS = ['receiptNsByEventIndex'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function nonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/** Closed-keyset check at one nesting level: every allowed key must be present, no other key may
 * appear. Returns false only when `obj` itself isn't a plain object (nothing further to check at
 * this level) -- a missing/unknown individual KEY still returns true, so a caller can keep
 * validating the rest of a partially-malformed object instead of aborting the whole pass. */
function checkKeys(obj, allowedKeys, field, errors) {
  if (!isPlainObject(obj)) {
    errors.push({ field, code: 'invalid_shape' });
    return false;
  }
  for (const key of allowedKeys) {
    if (!(key in obj)) errors.push({ field: field ? `${field}.${key}` : key, code: 'missing_key' });
  }
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) errors.push({ field: field ? `${field}.${key}` : key, code: 'unknown_key' });
  }
  return true;
}

function validateStringArray(arr, field, errors, { requireNonEmpty }) {
  if (!Array.isArray(arr)) {
    errors.push({ field, code: 'invalid_type' });
    return;
  }
  if (requireNonEmpty && arr.length === 0) {
    errors.push({ field, code: 'empty_array' });
    return;
  }
  const seen = new Set();
  for (const v of arr) {
    if (typeof v !== 'string' || v.length === 0) {
      errors.push({ field, code: 'invalid_value' });
      continue;
    }
    if (seen.has(v)) {
      errors.push({ field, code: 'duplicate_value' });
      continue;
    }
    seen.add(v);
  }
}

function validateUsageDimensions(arr, errors) {
  const field = 'capabilities.usageDimensions';
  if (!Array.isArray(arr)) {
    errors.push({ field, code: 'invalid_type' });
    return;
  }
  const seen = new Set();
  let lastCanonicalIndex = -1;
  for (const v of arr) {
    if (typeof v !== 'string' || !USAGE_DIMENSIONS.includes(v)) {
      errors.push({ field, code: 'unknown_dimension' });
      continue;
    }
    if (seen.has(v)) {
      errors.push({ field, code: 'duplicate_value' });
      continue;
    }
    seen.add(v);
    const canonicalIndex = USAGE_DIMENSIONS.indexOf(v);
    if (canonicalIndex < lastCanonicalIndex) errors.push({ field, code: 'out_of_order' });
    lastCanonicalIndex = canonicalIndex;
  }
}

function validateCapabilities(caps, errors) {
  if (!checkKeys(caps, CAPABILITY_KEYS, 'capabilities', errors)) return;
  for (const boolField of ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence', 'softPermissionDenial']) {
    if (boolField in caps && typeof caps[boolField] !== 'boolean') errors.push({ field: `capabilities.${boolField}`, code: 'invalid_type' });
  }
  if ('observationSources' in caps) validateStringArray(caps.observationSources, 'capabilities.observationSources', errors, { requireNonEmpty: true });
  if ('skillDeliveryModes' in caps) validateStringArray(caps.skillDeliveryModes, 'capabilities.skillDeliveryModes', errors, { requireNonEmpty: false });
  if ('usageDimensions' in caps) validateUsageDimensions(caps.usageDimensions, errors);
}

/**
 * Validates a runtime adapter object against the closed 11-key contract. Never throws; returns
 * `{ok, errors}` where every error is a closed `{field, code}` pair -- no adapter content
 * (paths/env/prompts/etc.) ever appears in `errors`, since only field NAMES and short codes are
 * recorded, never values.
 * @returns {{ok: boolean, errors: Array<{field: string, code: string}>}}
 */
export function validateRuntimeAdapter(adapter) {
  const errors = [];
  if (!isPlainObject(adapter)) {
    errors.push({ field: '(root)', code: 'invalid_shape' });
    return { ok: false, errors };
  }
  checkKeys(adapter, ADAPTER_KEYS, '', errors);

  if ('id' in adapter && (typeof adapter.id !== 'string' || adapter.id.length === 0)) {
    errors.push({ field: 'id', code: 'invalid_value' });
  }
  if ('protocolVersion' in adapter && !(Number.isInteger(adapter.protocolVersion) && adapter.protocolVersion > 0)) {
    errors.push({ field: 'protocolVersion', code: 'invalid_value' });
  }
  const methodKeys = ADAPTER_KEYS.filter((k) => k !== 'id' && k !== 'protocolVersion' && k !== 'capabilities');
  for (const key of methodKeys) {
    if (key in adapter && typeof adapter[key] !== 'function') errors.push({ field: key, code: 'not_a_function' });
  }
  if ('capabilities' in adapter) validateCapabilities(adapter.capabilities, errors);

  return { ok: errors.length === 0, errors };
}

/** Freezes `value` and every plain-object/array reachable from it. `Map`/`Set` instances are
 * frozen as wrapper objects only (`Object.freeze` cannot make a Map/Set's own entries immutable)
 * -- they stay read-only-by-CONTRACT, enforced by the validators above and by review, never by a
 * runtime guarantee this function could actually provide. Functions are left untouched. */
function deepFreeze(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (typeof value === 'function') return value;
  if (value instanceof Map || value instanceof Set) {
    Object.freeze(value);
    return value;
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Validates and deep-freezes a runtime adapter in one step -- the constructor every
 * `runtimes/<id>.mjs` module uses to produce its exported singleton. Throws a closed-code-only
 * Error (never adapter content) on an invalid adapter.
 */
export function defineRuntimeAdapter(adapter) {
  const { ok, errors } = validateRuntimeAdapter(adapter);
  if (!ok) {
    throw new Error(`invalid runtime adapter: ${errors.map((e) => e.code).join(',')}`);
  }
  return deepFreeze(adapter);
}

function validateRuntimeRef(runtime, errors) {
  if (!checkKeys(runtime, RUNTIME_REF_KEYS, 'runtime', errors)) return;
  if (typeof runtime.id !== 'string' || runtime.id.length === 0) errors.push({ field: 'runtime.id', code: 'invalid_value' });
  if (!(Number.isInteger(runtime.protocolVersion) && runtime.protocolVersion > 0)) errors.push({ field: 'runtime.protocolVersion', code: 'invalid_value' });
}

function validateProcess(proc, errors) {
  if (!checkKeys(proc, PROCESS_KEYS, 'process', errors)) return;
  if (proc.exitCode !== null && !Number.isInteger(proc.exitCode)) errors.push({ field: 'process.exitCode', code: 'invalid_type' });
  if (typeof proc.terminated !== 'boolean') errors.push({ field: 'process.terminated', code: 'invalid_type' });
  if (proc.terminationReason !== null && typeof proc.terminationReason !== 'string') errors.push({ field: 'process.terminationReason', code: 'invalid_type' });
  if (proc.terminated === false && proc.terminationReason !== null) errors.push({ field: 'process.terminationReason', code: 'invalid_relation' });
  if (typeof proc.spawnHrtimeNs !== 'bigint') errors.push({ field: 'process.spawnHrtimeNs', code: 'invalid_type' });
  if (typeof proc.endedHrtimeNs !== 'bigint') errors.push({ field: 'process.endedHrtimeNs', code: 'invalid_type' });
}

function validateSession(session, errors) {
  if (!checkKeys(session, SESSION_KEYS, 'session', errors)) return;
  if (typeof session.initPresent !== 'boolean') errors.push({ field: 'session.initPresent', code: 'invalid_type' });
  if (session.modelResolved !== null && typeof session.modelResolved !== 'string') errors.push({ field: 'session.modelResolved', code: 'invalid_type' });
  if (session.sessionIdObserved !== null && typeof session.sessionIdObserved !== 'string') errors.push({ field: 'session.sessionIdObserved', code: 'invalid_type' });
  if (session.runtimeVersion !== null && typeof session.runtimeVersion !== 'string') errors.push({ field: 'session.runtimeVersion', code: 'invalid_type' });
  if (typeof session.toolProfileMatchesExpected !== 'boolean') errors.push({ field: 'session.toolProfileMatchesExpected', code: 'invalid_type' });
}

function validateStructuralIssues(issues, field, errors) {
  if (!Array.isArray(issues)) {
    errors.push({ field, code: 'invalid_type' });
    return;
  }
  issues.forEach((issue, i) => {
    const itemField = `${field}[${i}]`;
    if (!isPlainObject(issue)) {
      errors.push({ field: itemField, code: 'invalid_shape' });
      return;
    }
    if (!STRUCTURAL_ISSUE_TYPES.includes(issue.type)) errors.push({ field: `${itemField}.type`, code: 'invalid_value' });
    for (const key of Object.keys(issue)) {
      if (key !== 'type' && !STRUCTURAL_ISSUE_EXTRA_KEYS.includes(key)) errors.push({ field: `${itemField}.${key}`, code: 'unknown_key' });
    }
  });
}

function validateIncompleteResults(items, field, errors) {
  if (!Array.isArray(items)) {
    errors.push({ field, code: 'invalid_type' });
    return;
  }
  items.forEach((item, i) => {
    const itemField = `${field}[${i}]`;
    if (!checkKeys(item, INCOMPLETE_RESULT_KEYS, itemField, errors)) return;
    if (!nonNegInt(item.index)) errors.push({ field: `${itemField}.index`, code: 'invalid_value' });
    if (item.receiptNs !== null && typeof item.receiptNs !== 'bigint') errors.push({ field: `${itemField}.receiptNs`, code: 'invalid_type' });
    if (item.name !== null && typeof item.name !== 'string') errors.push({ field: `${itemField}.name`, code: 'invalid_type' });
    if (item.id !== null && typeof item.id !== 'string') errors.push({ field: `${itemField}.id`, code: 'invalid_type' });
  });
}

function validateTranscript(transcript, errors) {
  if (!checkKeys(transcript, TRANSCRIPT_KEYS, 'transcript', errors)) return;
  if (!nonNegInt(transcript.malformedLineCount)) errors.push({ field: 'transcript.malformedLineCount', code: 'invalid_value' });
  if ('strictStructuralIssues' in transcript) validateStructuralIssues(transcript.strictStructuralIssues, 'transcript.strictStructuralIssues', errors);
  if ('effectiveStructuralIssues' in transcript) validateStructuralIssues(transcript.effectiveStructuralIssues, 'transcript.effectiveStructuralIssues', errors);
  if ('strictIncompleteToolResults' in transcript) validateIncompleteResults(transcript.strictIncompleteToolResults, 'transcript.strictIncompleteToolResults', errors);
  if ('effectiveIncompleteToolResults' in transcript) validateIncompleteResults(transcript.effectiveIncompleteToolResults, 'transcript.effectiveIncompleteToolResults', errors);
}

function validateUsage(usage, errors) {
  if (!checkKeys(usage, [...USAGE_DIMENSIONS], 'terminal.usage', errors)) return;
  for (const key of USAGE_DIMENSIONS) {
    const v = usage[key];
    if (v !== null && !nonNegInt(v)) errors.push({ field: `terminal.usage.${key}`, code: 'invalid_value' });
  }
}

function validateTerminal(terminal, errors) {
  if (!checkKeys(terminal, TERMINAL_KEYS, 'terminal', errors)) return;
  if (typeof terminal.present !== 'boolean') errors.push({ field: 'terminal.present', code: 'invalid_type' });
  if (terminal.isError !== null && typeof terminal.isError !== 'boolean') errors.push({ field: 'terminal.isError', code: 'invalid_type' });
  if (terminal.turnCount !== null && !nonNegInt(terminal.turnCount)) errors.push({ field: 'terminal.turnCount', code: 'invalid_value' });
  if (terminal.finalText !== null && typeof terminal.finalText !== 'string') errors.push({ field: 'terminal.finalText', code: 'invalid_type' });
  if (terminal.resultSubtype !== null && typeof terminal.resultSubtype !== 'string') errors.push({ field: 'terminal.resultSubtype', code: 'invalid_type' });
  if ('usage' in terminal) validateUsage(terminal.usage, errors);
}

function validateToolResult(result, field, errors) {
  if (!checkKeys(result, TOOL_RESULT_KEYS, field, errors)) return;
  if (typeof result.found !== 'boolean') errors.push({ field: `${field}.found`, code: 'invalid_type' });
  if (!TEXT_STATUS_VALUES.includes(result.textStatus)) errors.push({ field: `${field}.textStatus`, code: 'invalid_value' });

  if (result.found === false) {
    if (result.eventIndex !== null) errors.push({ field: `${field}.eventIndex`, code: 'invalid_relation' });
    if (result.isError !== null) errors.push({ field: `${field}.isError`, code: 'invalid_relation' });
    if (result.text !== null) errors.push({ field: `${field}.text`, code: 'invalid_relation' });
    if (result.textStatus !== 'missing') errors.push({ field: `${field}.textStatus`, code: 'invalid_relation' });
    return;
  }
  if (!nonNegInt(result.eventIndex)) errors.push({ field: `${field}.eventIndex`, code: 'invalid_value' });
  if (typeof result.isError !== 'boolean') errors.push({ field: `${field}.isError`, code: 'invalid_type' });
  if (result.textStatus === 'missing') errors.push({ field: `${field}.textStatus`, code: 'invalid_relation' });
  if (result.textStatus === 'text' && typeof result.text !== 'string') errors.push({ field: `${field}.text`, code: 'invalid_type' });
  if (result.textStatus === 'unsupported' && result.text !== null) errors.push({ field: `${field}.text`, code: 'invalid_relation' });
}

function validatePreDispatchBlock(pdb, isShell, result, field, errors) {
  if (!checkKeys(pdb, PRE_DISPATCH_KEYS, field, errors)) return;
  if (typeof pdb.recognized !== 'boolean') {
    errors.push({ field: `${field}.recognized`, code: 'invalid_type' });
    return;
  }
  if (pdb.recognized === true) {
    if (!isShell) errors.push({ field, code: 'invalid_relation' });
    if (typeof pdb.signature !== 'string' || pdb.signature.length === 0) errors.push({ field: `${field}.signature`, code: 'invalid_value' });
    if (!isPlainObject(result) || result.found !== true) errors.push({ field, code: 'invalid_relation' });
  } else if (pdb.signature !== null) {
    errors.push({ field: `${field}.signature`, code: 'invalid_relation' });
  }
}

function validateToolAttempts(attempts, errors) {
  if (!Array.isArray(attempts)) {
    errors.push({ field: 'toolAttempts', code: 'invalid_type' });
    return;
  }
  let lastEventIndex = -Infinity;
  attempts.forEach((attempt, i) => {
    const field = `toolAttempts[${i}]`;
    if (!checkKeys(attempt, TOOL_ATTEMPT_KEYS, field, errors)) return;

    if (attempt.id !== null && (typeof attempt.id !== 'string' || attempt.id.length === 0)) errors.push({ field: `${field}.id`, code: 'invalid_value' });
    if (!TOOL_ATTEMPT_KINDS.includes(attempt.kind)) errors.push({ field: `${field}.kind`, code: 'invalid_value' });
    if (attempt.runtimeName !== null && (typeof attempt.runtimeName !== 'string' || attempt.runtimeName.length === 0)) errors.push({ field: `${field}.runtimeName`, code: 'invalid_value' });
    if (!nonNegInt(attempt.eventIndex)) errors.push({ field: `${field}.eventIndex`, code: 'invalid_value' });
    if (attempt.receiptNs !== null && typeof attempt.receiptNs !== 'bigint') errors.push({ field: `${field}.receiptNs`, code: 'invalid_type' });
    if (typeof attempt.profileAllowed !== 'boolean') errors.push({ field: `${field}.profileAllowed`, code: 'invalid_type' });

    const isShell = attempt.kind === 'shell';
    const isSkill = attempt.kind === 'skill';

    if (attempt.command !== null && typeof attempt.command !== 'string') errors.push({ field: `${field}.command`, code: 'invalid_type' });
    if (!isShell && attempt.command !== null) errors.push({ field: `${field}.command`, code: 'invalid_relation' });

    if (!isSkill) {
      if (attempt.skillReference !== null) errors.push({ field: `${field}.skillReference`, code: 'invalid_relation' });
      if (attempt.targetsExpectedSkill !== null) errors.push({ field: `${field}.targetsExpectedSkill`, code: 'invalid_relation' });
    } else {
      if (attempt.skillReference !== null && typeof attempt.skillReference !== 'string') errors.push({ field: `${field}.skillReference`, code: 'invalid_type' });
      if (typeof attempt.targetsExpectedSkill !== 'boolean') errors.push({ field: `${field}.targetsExpectedSkill`, code: 'invalid_type' });
    }

    if ('result' in attempt) validateToolResult(attempt.result, `${field}.result`, errors);
    if ('preDispatchBlock' in attempt) validatePreDispatchBlock(attempt.preDispatchBlock, isShell, attempt.result, `${field}.preDispatchBlock`, errors);

    // Duplicates are preserved (concurrent same-turn tool calls legitimately share an
    // eventIndex) -- only a DECREASE relative to the running maximum is out of order.
    if (Number.isInteger(attempt.eventIndex)) {
      if (attempt.eventIndex < lastEventIndex) errors.push({ field: `${field}.eventIndex`, code: 'out_of_order' });
      lastEventIndex = Math.max(lastEventIndex, attempt.eventIndex);
    }
  });
}

function validateAmbient(ambient, errors) {
  if (!checkKeys(ambient, AMBIENT_KEYS, 'skill.ambient', errors)) return;
  if (!(ambient.names instanceof Set)) {
    errors.push({ field: 'skill.ambient.names', code: 'invalid_type' });
  } else {
    for (const n of ambient.names) {
      if (typeof n !== 'string' || n.length === 0) {
        errors.push({ field: 'skill.ambient.names', code: 'invalid_value' });
        break;
      }
    }
  }
  if (typeof ambient.structurallyWellFormed !== 'boolean') errors.push({ field: 'skill.ambient.structurallyWellFormed', code: 'invalid_type' });
  if (typeof ambient.targetIdentityOk !== 'boolean') errors.push({ field: 'skill.ambient.targetIdentityOk', code: 'invalid_type' });
}

function validateSkill(skill, errors) {
  if (!checkKeys(skill, SKILL_KEYS, 'skill', errors)) return;
  for (const key of ['available', 'profileMatchesCondition', 'snapshotBindingMatches']) {
    if (typeof skill[key] !== 'boolean') errors.push({ field: `skill.${key}`, code: 'invalid_type' });
  }

  if (skill.targetInvocation !== null) {
    if (checkKeys(skill.targetInvocation, TARGET_INVOCATION_KEYS, 'skill.targetInvocation', errors)) {
      const ti = skill.targetInvocation;
      if (ti.attempted !== true) errors.push({ field: 'skill.targetInvocation.attempted', code: 'invalid_value' });
      if (typeof ti.confirmed !== 'boolean') errors.push({ field: 'skill.targetInvocation.confirmed', code: 'invalid_type' });
      if (!(Number.isInteger(ti.attemptCount) && ti.attemptCount >= 1)) errors.push({ field: 'skill.targetInvocation.attemptCount', code: 'invalid_value' });
      if (!nonNegInt(ti.eventIndex)) errors.push({ field: 'skill.targetInvocation.eventIndex', code: 'invalid_value' });
      if (ti.receiptNs !== null && typeof ti.receiptNs !== 'bigint') errors.push({ field: 'skill.targetInvocation.receiptNs', code: 'invalid_type' });
      if (ti.resultIsError !== null && typeof ti.resultIsError !== 'boolean') errors.push({ field: 'skill.targetInvocation.resultIsError', code: 'invalid_type' });
    }
  }

  if (!Array.isArray(skill.foreignInvocations)) {
    errors.push({ field: 'skill.foreignInvocations', code: 'invalid_type' });
  } else {
    skill.foreignInvocations.forEach((fi, i) => {
      const field = `skill.foreignInvocations[${i}]`;
      if (!checkKeys(fi, FOREIGN_INVOCATION_KEYS, field, errors)) return;
      if (!nonNegInt(fi.eventIndex)) errors.push({ field: `${field}.eventIndex`, code: 'invalid_value' });
      if (fi.receiptNs !== null && typeof fi.receiptNs !== 'bigint') errors.push({ field: `${field}.receiptNs`, code: 'invalid_type' });
      if (fi.id !== null && typeof fi.id !== 'string') errors.push({ field: `${field}.id`, code: 'invalid_type' });
      if (fi.skillReference !== null && typeof fi.skillReference !== 'string') errors.push({ field: `${field}.skillReference`, code: 'invalid_type' });
      if (fi.resultIsError !== null && typeof fi.resultIsError !== 'boolean') errors.push({ field: `${field}.resultIsError`, code: 'invalid_type' });
      if (typeof fi.confirmed !== 'boolean') errors.push({ field: `${field}.confirmed`, code: 'invalid_type' });
    });
  }

  if ('ambient' in skill) validateAmbient(skill.ambient, errors);
}

function validateHookStats(hookStats, errors) {
  if (!checkKeys(hookStats, HOOK_STATS_KEYS, 'hookStats', errors)) return;
  for (const key of ['hookCallCount', 'hookResponseCount', 'hookDenyCount', 'hookAllowCount']) {
    if (!nonNegInt(hookStats[key])) errors.push({ field: `hookStats.${key}`, code: 'invalid_value' });
  }
  for (const key of ['hookPairingOk', 'everyCallHooked']) {
    if (typeof hookStats[key] !== 'boolean') errors.push({ field: `hookStats.${key}`, code: 'invalid_type' });
  }
}

function validateByteMetrics(byteMetrics, errors) {
  if (!checkKeys(byteMetrics, BYTE_METRICS_KEYS, 'byteMetrics', errors)) return;
  for (const key of BYTE_METRICS_KEYS) {
    if (!nonNegInt(byteMetrics[key])) errors.push({ field: `byteMetrics.${key}`, code: 'invalid_value' });
  }
}

function validateTiming(timing, errors) {
  if (!checkKeys(timing, TIMING_KEYS, 'timing', errors)) return;
  if (!(timing.receiptNsByEventIndex instanceof Map)) errors.push({ field: 'timing.receiptNsByEventIndex', code: 'invalid_type' });
}

/**
 * Validates a normalized `condition-observation-v1` object against the closed 11-key contract.
 * Never throws; never mutates; never absorbs an anomaly silently -- a malformed shape always
 * reports at least one error rather than validating clean by omission. Because every nesting
 * level uses a CLOSED keyset (`checkKeys`), a provider-native key (`message`, `tool_use_result`,
 * `is_error`, `num_turns`, `permissionMode`, `mcp_servers`, `hook_id`, `rawStdout`, `stderr`,
 * `taggedLines`, or a legacy top-level container like `events`/`init`/`result`) is rejected
 * wherever it appears, without a separate denylist pass.
 * @returns {{ok: boolean, errors: Array<{field: string, code: string}>}}
 */
export function validateObservation(observation) {
  const errors = [];
  if (!isPlainObject(observation)) {
    errors.push({ field: '(root)', code: 'invalid_shape' });
    return { ok: false, errors };
  }
  checkKeys(observation, OBSERVATION_KEYS, '', errors);

  if ('schema' in observation && observation.schema !== 1) errors.push({ field: 'schema', code: 'invalid_value' });
  if ('runtime' in observation) validateRuntimeRef(observation.runtime, errors);
  if ('process' in observation) validateProcess(observation.process, errors);
  if ('session' in observation) validateSession(observation.session, errors);
  if ('transcript' in observation) validateTranscript(observation.transcript, errors);
  if ('terminal' in observation) validateTerminal(observation.terminal, errors);
  if ('toolAttempts' in observation) validateToolAttempts(observation.toolAttempts, errors);
  if ('skill' in observation) validateSkill(observation.skill, errors);
  if ('hookStats' in observation) validateHookStats(observation.hookStats, errors);
  if ('byteMetrics' in observation) validateByteMetrics(observation.byteMetrics, errors);
  if ('timing' in observation) validateTiming(observation.timing, errors);

  return { ok: errors.length === 0, errors };
}

/** Deep-freezes an already-normalized observation before it reaches the core lifecycle -- see
 * `deepFreeze`'s own doc comment for the Map/Set caveat (they stay read-only by contract, not by
 * runtime guarantee). */
export function freezeObservation(observation) {
  return deepFreeze(observation);
}

/** The canonical shell-attempt selector every core consumer must use instead of hand-rolling
 * `toolAttempts.filter(a => a.kind === 'shell')` independently at each call site. */
export function selectShellAttempts(toolAttempts) {
  return toolAttempts.filter((a) => a.kind === 'shell');
}

/** Generic elapsed-milliseconds helper: both absolute values must be real bigints (as every
 * receiptNs/spawnHrtimeNs/endedHrtimeNs field in the observation contract is), and the origin
 * must not be later than the receipt -- fails closed to `null` rather than a negative number,
 * mirroring stream-parser.mjs's own deriveFirstUsefulSignalMs/derivePostSignalMs null-safety. */
export function msSinceOrigin(receiptNs, originNs) {
  if (typeof receiptNs !== 'bigint' || typeof originNs !== 'bigint') return null;
  if (receiptNs < originNs) return null;
  return Number(receiptNs - originNs) / 1e6;
}

/** Order-independent string identity for an ambient-name Set -- the same formula
 * stream-parser.mjs's own canonicalAmbientSkillNamesKey uses (JSON array of the sorted names),
 * reimplemented here so this runtime-agnostic module never imports a Claude-specific one. Must
 * stay byte-for-byte identical to stream-parser.mjs's version: both are expected to produce the
 * same fingerprint for the same names + key. */
export function canonicalNamesKey(names) {
  return JSON.stringify([...names].sort());
}

/** HMAC-SHA256 fingerprint of an ambient-name Set, keyed by a caller-supplied ephemeral key --
 * same algorithm as stream-parser.mjs's fingerprintAmbientSkillNames, reimplemented generically
 * here (see canonicalNamesKey's doc comment for why). */
export function fingerprintNames(names, key) {
  return createHmac('sha256', key).update(canonicalNamesKey(names)).digest('hex');
}
