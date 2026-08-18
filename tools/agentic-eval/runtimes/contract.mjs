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
// The exact extra-key set PER TYPE, taken directly from stream-parser.mjs's own
// findTranscriptStructuralIssues() construction sites (never guessed) -- STRUCTURAL_ISSUE_EXTRA_KEYS
// above is the flat union across all 8 types, used only for the top-level "is this even a
// recognized extra-key NAME anywhere" pre-check; this map is what actually pins which keys (and
// therefore which VALUES) a given `type` may legitimately carry, closing the gap where e.g. an
// `init_count` issue (real shape: {type, count}) could otherwise carry an unrelated `id` value
// (a real key name for OTHER types) with nothing ever inspecting it.
const STRUCTURAL_ISSUE_SHAPE_BY_TYPE = {
  init_count: ['count'],
  result_count: ['count'],
  empty_tool_use_id: [],
  duplicate_tool_use_id: ['id', 'count'],
  orphan_tool_result: ['id'],
  duplicate_tool_result: ['id', 'count'],
  result_not_last: ['resultIndex', 'eventsLength'],
  init_not_first: ['initIndex'],
};
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

// Rejects anything backed by a prototype chain beyond the plain-object baseline (Object.prototype
// or null) -- not just Array.isArray. Post-review hardening: `key in obj` (below) traverses the
// prototype chain, so an object with ZERO own properties but a well-formed object as its
// prototype (Object.create(realShape)) previously validated as if every key were genuinely
// present. Rejecting any non-baseline prototype here closes that at the root, before checkKeys
// ever runs -- an adversarial shape can't reach the `in`-based check at all.
function isPlainObject(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function nonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/** Closed-keyset check at one nesting level: every allowed key must be present as the object's
 * OWN property, no other own property may appear. Returns false only when `obj` itself isn't a
 * plain object (nothing further to check at this level) -- a missing/unknown individual KEY still
 * returns true, so a caller can keep validating the rest of a partially-malformed object instead
 * of aborting the whole pass. Uses hasOwnProperty (not `key in obj`) as a second, independent
 * layer against the same prototype-inheritance class isPlainObject already guards -- own-property
 * enumeration is the correct semantics for a closed contract either way, regardless of how deep an
 * adversarial prototype chain runs. */
function checkKeys(obj, allowedKeys, field, errors) {
  if (!isPlainObject(obj)) {
    errors.push({ field, code: 'invalid_shape' });
    return false;
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) errors.push({ field: field ? `${field}.${key}` : key, code: 'missing_key' });
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

// The closed set of real values condition-launcher.mjs's spawnCondition ever produces (never an
// arbitrary string) -- both its 'close' path (timedOut ? 'timeout' : (signal != null ? 'error' :
// null)) and its 'error' path (always 'error') only ever emit these two.
const TERMINATION_REASONS = Object.freeze(['timeout', 'error']);

function validateProcess(proc, errors) {
  if (!checkKeys(proc, PROCESS_KEYS, 'process', errors)) return;
  if (proc.exitCode !== null && !Number.isInteger(proc.exitCode)) errors.push({ field: 'process.exitCode', code: 'invalid_type' });
  if (typeof proc.terminated !== 'boolean') errors.push({ field: 'process.terminated', code: 'invalid_type' });
  if (proc.terminationReason !== null && !TERMINATION_REASONS.includes(proc.terminationReason)) errors.push({ field: 'process.terminationReason', code: 'invalid_value' });
  // A full biconditional, not just one direction -- condition-launcher.mjs's spawnCondition proves
  // terminated is computed as `timedOut || signal != null` and terminationReason as `timedOut ?
  // 'timeout' : (signal != null ? 'error' : null)` on EVERY resolution path (close and the
  // spawn-level error path alike), so terminated is true iff terminationReason is non-null, always.
  if (proc.terminated === false && proc.terminationReason !== null) errors.push({ field: 'process.terminationReason', code: 'invalid_relation' });
  if (proc.terminated === true && proc.terminationReason === null) errors.push({ field: 'process.terminationReason', code: 'invalid_relation' });
  if (typeof proc.spawnHrtimeNs !== 'bigint') errors.push({ field: 'process.spawnHrtimeNs', code: 'invalid_type' });
  if (typeof proc.endedHrtimeNs !== 'bigint') errors.push({ field: 'process.endedHrtimeNs', code: 'invalid_type' });
  if (typeof proc.spawnHrtimeNs === 'bigint' && proc.spawnHrtimeNs < 0n) errors.push({ field: 'process.spawnHrtimeNs', code: 'invalid_value' });
  if (typeof proc.endedHrtimeNs === 'bigint' && proc.endedHrtimeNs < 0n) errors.push({ field: 'process.endedHrtimeNs', code: 'invalid_value' });
  if (typeof proc.spawnHrtimeNs === 'bigint' && typeof proc.endedHrtimeNs === 'bigint' && proc.endedHrtimeNs < proc.spawnHrtimeNs) {
    errors.push({ field: 'process.endedHrtimeNs', code: 'invalid_relation' });
  }
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
    const type = issue.type;
    if (!STRUCTURAL_ISSUE_TYPES.includes(type)) {
      errors.push({ field: `${itemField}.type`, code: 'invalid_value' });
      // Shape is only meaningful relative to a real, recognized type -- an unrecognized type
      // already fails closed on its own; validating "extra keys" against the flat union would
      // let a fabricated type smuggle any real key name through unchecked.
      for (const key of Object.keys(issue)) {
        if (key !== 'type') errors.push({ field: `${itemField}.${key}`, code: 'unknown_key' });
      }
      return;
    }
    const shape = STRUCTURAL_ISSUE_SHAPE_BY_TYPE[type];
    for (const key of Object.keys(issue)) {
      if (key !== 'type' && !shape.includes(key)) errors.push({ field: `${itemField}.${key}`, code: 'unknown_key' });
    }
    for (const key of shape) {
      if (!Object.prototype.hasOwnProperty.call(issue, key)) errors.push({ field: `${itemField}.${key}`, code: 'missing_key' });
    }
    if (shape.includes('count') && !nonNegInt(issue.count)) errors.push({ field: `${itemField}.count`, code: 'invalid_value' });
    if (shape.includes('resultIndex') && !nonNegInt(issue.resultIndex)) errors.push({ field: `${itemField}.resultIndex`, code: 'invalid_value' });
    if (shape.includes('eventsLength') && !nonNegInt(issue.eventsLength)) errors.push({ field: `${itemField}.eventsLength`, code: 'invalid_value' });
    if (shape.includes('initIndex') && !nonNegInt(issue.initIndex)) errors.push({ field: `${itemField}.initIndex`, code: 'invalid_value' });
    // Semantic predicates PER TYPE, derived from stream-parser.mjs's findTranscriptStructuralIssues
    // -- each issue type is only ever pushed under one specific numeric condition; a `count`/`index`
    // that is merely a well-typed non-negative integer can still contradict the very reason the
    // issue exists at all (e.g. a "duplicate" with count:0, or a "not last" result that IS last).
    if (nonNegInt(issue.count)) {
      if ((type === 'init_count' || type === 'result_count') && issue.count === 1) {
        errors.push({ field: `${itemField}.count`, code: 'invalid_value' });
      }
      if ((type === 'duplicate_tool_use_id' || type === 'duplicate_tool_result') && issue.count < 2) {
        errors.push({ field: `${itemField}.count`, code: 'invalid_value' });
      }
    }
    if (type === 'result_not_last' && nonNegInt(issue.resultIndex) && nonNegInt(issue.eventsLength) && issue.resultIndex >= issue.eventsLength - 1) {
      errors.push({ field: `${itemField}.resultIndex`, code: 'invalid_relation' });
    }
    if (type === 'init_not_first' && nonNegInt(issue.initIndex) && issue.initIndex === 0) {
      errors.push({ field: `${itemField}.initIndex`, code: 'invalid_value' });
    }
    if (shape.includes('id')) {
      // orphan_tool_result is the one type stream-parser.mjs can legitimately emit with a null id
      // (a tool_result with no tool_use_id at all) -- every other id-carrying type only ever fires
      // for an id already confirmed present in the transcript.
      const idOk = type === 'orphan_tool_result'
        ? (issue.id === null || (typeof issue.id === 'string' && issue.id.length > 0))
        : (typeof issue.id === 'string' && issue.id.length > 0);
      if (!idOk) errors.push({ field: `${itemField}.id`, code: 'invalid_value' });
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
    if (typeof item.receiptNs === 'bigint' && item.receiptNs < 0n) errors.push({ field: `${itemField}.receiptNs`, code: 'invalid_value' });
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

// present/sibling-field coherence, derived from the ONE real construction site (runtimes/
// claude-code.mjs's own terminal object): present:false means no result event ever arrived, so
// isError/turnCount/finalText/resultSubtype/every usage dimension are ALWAYS null there -- never
// independently non-null. present:true means a result event DID arrive, so `isError` (a plain
// `=== true` comparison in the adapter, never itself undefined/null once a result exists) is
// ALWAYS a real boolean -- but turnCount/finalText/resultSubtype stay independently nullable even
// when present (a real result missing num_turns/result/subtype is still a genuinely-present,
// just degraded, result -- not the same fact as "no result at all").
function validateTerminal(terminal, errors) {
  if (!checkKeys(terminal, TERMINAL_KEYS, 'terminal', errors)) return;
  if (typeof terminal.present !== 'boolean') errors.push({ field: 'terminal.present', code: 'invalid_type' });
  if (terminal.isError !== null && typeof terminal.isError !== 'boolean') errors.push({ field: 'terminal.isError', code: 'invalid_type' });
  if (terminal.turnCount !== null && !nonNegInt(terminal.turnCount)) errors.push({ field: 'terminal.turnCount', code: 'invalid_value' });
  if (terminal.finalText !== null && typeof terminal.finalText !== 'string') errors.push({ field: 'terminal.finalText', code: 'invalid_type' });
  if (terminal.resultSubtype !== null && typeof terminal.resultSubtype !== 'string') errors.push({ field: 'terminal.resultSubtype', code: 'invalid_type' });
  if ('usage' in terminal) validateUsage(terminal.usage, errors);
  if (terminal.present === false) {
    if (terminal.isError !== null) errors.push({ field: 'terminal.isError', code: 'invalid_relation' });
    if (terminal.turnCount !== null) errors.push({ field: 'terminal.turnCount', code: 'invalid_relation' });
    if (terminal.finalText !== null) errors.push({ field: 'terminal.finalText', code: 'invalid_relation' });
    if (terminal.resultSubtype !== null) errors.push({ field: 'terminal.resultSubtype', code: 'invalid_relation' });
    if (isPlainObject(terminal.usage)) {
      for (const key of USAGE_DIMENSIONS) {
        if (terminal.usage[key] !== null) errors.push({ field: `terminal.usage.${key}`, code: 'invalid_relation' });
      }
    }
  } else if (terminal.present === true && terminal.isError === null) {
    errors.push({ field: 'terminal.isError', code: 'invalid_relation' });
  }
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
    if (typeof attempt.receiptNs === 'bigint' && attempt.receiptNs < 0n) errors.push({ field: `${field}.receiptNs`, code: 'invalid_value' });
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
      if (typeof ti.receiptNs === 'bigint' && ti.receiptNs < 0n) errors.push({ field: 'skill.targetInvocation.receiptNs', code: 'invalid_value' });
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
      if (typeof fi.receiptNs === 'bigint' && fi.receiptNs < 0n) errors.push({ field: `${field}.receiptNs`, code: 'invalid_value' });
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
  // Real relations, derived from stream-parser.mjs's countHookEvents (the one producer of this
  // whole object). hookPairingOk's own formula requires the started/response id SETS to match in
  // size, which (combined with each side's ids being unique, also part of that same formula) forces
  // hookCallCount === hookResponseCount whenever hookPairingOk is true. everyCallHooked's own
  // formula ANDs hookPairingOk in directly, so everyCallHooked can never be true while
  // hookPairingOk is false. `decisions` has exactly hookResponseCount entries, each classified into
  // allow XOR deny XOR neither, so allow+deny can never exceed the response count.
  if (
    hookStats.hookPairingOk === true && nonNegInt(hookStats.hookCallCount) && nonNegInt(hookStats.hookResponseCount)
    && hookStats.hookCallCount !== hookStats.hookResponseCount
  ) {
    errors.push({ field: 'hookStats.hookPairingOk', code: 'invalid_relation' });
  }
  if (hookStats.everyCallHooked === true && hookStats.hookPairingOk === false) {
    errors.push({ field: 'hookStats.everyCallHooked', code: 'invalid_relation' });
  }
  if (
    nonNegInt(hookStats.hookAllowCount) && nonNegInt(hookStats.hookDenyCount) && nonNegInt(hookStats.hookResponseCount)
    && (hookStats.hookAllowCount + hookStats.hookDenyCount) > hookStats.hookResponseCount
  ) {
    errors.push({ field: 'hookStats.hookAllowCount', code: 'invalid_relation' });
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
  const map = timing.receiptNsByEventIndex;
  if (!(map instanceof Map)) {
    errors.push({ field: 'timing.receiptNsByEventIndex', code: 'invalid_type' });
    return;
  }
  // Contents, not just "is a Map" -- a Map's entries are opaque to the closed-keyset machinery
  // above, so provider-native content (a raw event object, a string) could otherwise ride along
  // as a value with no other check ever inspecting it.
  for (const [key, value] of map) {
    if (!nonNegInt(key)) errors.push({ field: 'timing.receiptNsByEventIndex', code: 'invalid_key' });
    if (typeof value !== 'bigint') errors.push({ field: 'timing.receiptNsByEventIndex', code: 'invalid_value' });
    if (typeof value === 'bigint' && value < 0n) errors.push({ field: 'timing.receiptNsByEventIndex', code: 'invalid_value' });
  }
}

/** Real, byte-derived timing lookup: returns the timing map's own recorded value for `eventIndex`
 * (or `null` if absent), used throughout validateCrossFieldInvariants to check a receiptNs-carrying
 * field against the single shared source of truth instead of trusting the field's own value. */
function timingValueAt(timingMap, eventIndex) {
  if (!nonNegInt(eventIndex)) return undefined; // sentinel: caller should skip, not compare
  return timingMap.has(eventIndex) ? timingMap.get(eventIndex) : null;
}

/**
 * Cross-field invariants that span more than one top-level observation section -- every one
 * derived from the real producers (runtimes/claude-code.mjs's normalizeObservations composing
 * stream-parser.mjs's countHookEvents/findSkillInvocation/classifyForeignSkillUses/
 * findTranscriptStructuralIssues(+TolerantOfTimeout)/findIncompleteToolResults(+TolerantOfTimeout)/
 * findInitEvent/findResultEvent) but unreachable from any single-section validator above, since
 * each of those only ever sees its own slice. Full IFF relations throughout, not one-directional
 * checks -- see the runbook's own review-round-4 requirement and PROGRESS.md's invariant table for
 * the derivation of each. Only runs when the relevant section is already shape-valid
 * (`isPlainObject`/`Array.isArray` checked inline) -- a malformed section already reports its own
 * specific error above; this function's job is catching an internally well-typed observation whose
 * PARTS disagree with each other.
 */
function validateCrossFieldInvariants(observation, errors) {
  const toolAttempts = Array.isArray(observation.toolAttempts) ? observation.toolAttempts : [];
  const timingMap = isPlainObject(observation.timing) && observation.timing.receiptNsByEventIndex instanceof Map
    ? observation.timing.receiptNsByEventIndex
    : null;
  const isLegitimateTimeout = isPlainObject(observation.process)
    && observation.process.terminated === true && observation.process.terminationReason === 'timeout';

  // #1 (round 3): every toolAttempts[] entry's own receiptNs must agree exactly with
  // timing.receiptNsByEventIndex.get(eventIndex) -- both read from the SAME source event.
  if (timingMap) {
    for (const attempt of toolAttempts) {
      if (!isPlainObject(attempt) || !nonNegInt(attempt.eventIndex)) continue;
      const mapValue = timingValueAt(timingMap, attempt.eventIndex);
      const attemptReceipt = typeof attempt.receiptNs === 'bigint' ? attempt.receiptNs : null;
      if (attemptReceipt !== mapValue) {
        errors.push({ field: 'timing.receiptNsByEventIndex', code: 'invalid_relation' });
        break;
      }
    }
  }

  // #round-4-1: hookStats.everyCallHooked===true IFF (hookCallCount === the real shell-attempt
  // count AND hookPairingOk===true) -- countHookEvents' own formula ANDs bashCallCount===
  // hookStarted.length into everyCallHooked directly; hookPairingOk already implies
  // hookCallCount===hookResponseCount (validateHookStats), so together these two conjuncts are the
  // full real formula.
  if (isPlainObject(observation.hookStats) && typeof observation.hookStats.everyCallHooked === 'boolean') {
    const shellCount = toolAttempts.filter((a) => isPlainObject(a) && a.kind === 'shell').length;
    const conditionsHold = observation.hookStats.hookCallCount === shellCount && observation.hookStats.hookPairingOk === true;
    if (observation.hookStats.everyCallHooked !== conditionsHold) {
      errors.push({ field: 'hookStats.everyCallHooked', code: 'invalid_relation' });
    }
  }

  if (isPlainObject(observation.skill)) {
    // #round-5: skill.targetInvocation must match the CANONICAL representative findSkillInvocation
    // itself selects -- the first attempt (in real event/array order) with result.found&&!result
    // .isError, else the LAST attempt -- not just any toolAttempts entry sharing ti's own claimed
    // eventIndex. A find(eventIndex)-based match (round 3/4) both under-rejects (accepts ti pointing
    // at the WRONG same-index or wrong-among-several-confirmed attempt) and over-rejects (grabs the
    // first same-eventIndex attempt regardless of which one is actually confirmed, wrongly failing
    // genuinely valid concurrent-call producer output). skillAttempts is assumed in real event order
    // (toolAttempts' own construction order mirrors stream-parser.mjs's own events iteration, same
    // as findSkillInvocation's own `matches` array) -- Array.prototype.find already respects that.
    const skillAttempts = toolAttempts.filter((a) => isPlainObject(a) && a.kind === 'skill' && a.targetsExpectedSkill === true);
    const ti = observation.skill.targetInvocation;
    if (ti === null) {
      if (skillAttempts.length > 0) errors.push({ field: 'skill.targetInvocation', code: 'invalid_relation' });
    } else if (isPlainObject(ti)) {
      if (skillAttempts.length === 0) {
        errors.push({ field: 'skill.targetInvocation', code: 'invalid_relation' });
      } else {
        if (ti.attemptCount !== skillAttempts.length) errors.push({ field: 'skill.targetInvocation.attemptCount', code: 'invalid_relation' });
        const confirmedMatch = skillAttempts.find((a) => isPlainObject(a.result) && a.result.found === true && a.result.isError === false);
        const representative = confirmedMatch ?? skillAttempts[skillAttempts.length - 1];
        const repConfirmed = confirmedMatch != null;
        const repResultIsError = isPlainObject(representative.result) ? representative.result.isError : null;
        if (ti.eventIndex !== representative.eventIndex) errors.push({ field: 'skill.targetInvocation.eventIndex', code: 'invalid_relation' });
        if (ti.confirmed !== repConfirmed) errors.push({ field: 'skill.targetInvocation.confirmed', code: 'invalid_relation' });
        // Round 6: unconditional equality, not gated on the representative's receiptNs being a
        // bigint -- the producer legitimately emits receiptNs:null (no _receiptNs captured on that
        // event), and the prior `typeof === 'bigint' &&` guard skipped the comparison entirely in
        // that case, letting ti.receiptNs claim any bigint unchecked. Strict `!==` is correct for
        // both bigint and null on either side.
        if (ti.receiptNs !== representative.receiptNs) {
          errors.push({ field: 'skill.targetInvocation.receiptNs', code: 'invalid_relation' });
        }
        if (ti.resultIsError !== repResultIsError) errors.push({ field: 'skill.targetInvocation.resultIsError', code: 'invalid_relation' });
      }
    }

    // #round-5: skill.foreignInvocations must be an EXACT ORDERED, ONE-TO-ONE projection of every
    // foreign toolAttempts entry (kind='skill' && targetsExpectedSkill===false), compared
    // POSITIONALLY (array index), not via find(eventIndex)/Set -- the prior approach both silently
    // collapsed multiple concurrent foreign calls sharing an eventIndex into one accepted entry, and
    // could match a foreignInvocations entry against the WRONG same-eventIndex attempt (the same
    // over-rejection class as targetInvocation above). classifyForeignSkillUses and toolAttempts'
    // own foreign-entry construction iterate the identical `events` array in the identical order, so
    // positional comparison is the correct identity, not eventIndex membership. Every field in the
    // producer's own summary shape is compared, including skillReference (never checked before).
    if (Array.isArray(observation.skill.foreignInvocations)) {
      const foreignAttempts = toolAttempts.filter((a) => isPlainObject(a) && a.kind === 'skill' && a.targetsExpectedSkill === false);
      const fis = observation.skill.foreignInvocations;
      if (fis.length !== foreignAttempts.length) {
        errors.push({ field: 'skill.foreignInvocations', code: 'invalid_relation' });
      } else {
        for (let i = 0; i < fis.length; i++) {
          const fi = fis[i];
          const attempt = foreignAttempts[i];
          if (!isPlainObject(fi)) continue;
          const expectedResultIsError = isPlainObject(attempt.result) ? attempt.result.isError : null;
          const expectedConfirmed = isPlainObject(attempt.result) && attempt.result.found === true && attempt.result.isError === false;
          // Round 6: unconditional equality (see the identical fix + rationale on targetInvocation's
          // own receiptNs check above) -- receiptNs:null is a real, legitimate producer value, not
          // just "absent", and must be compared exactly like any other value.
          const receiptOk = fi.receiptNs === attempt.receiptNs;
          if (
            fi.eventIndex !== attempt.eventIndex || fi.id !== attempt.id || fi.skillReference !== attempt.skillReference
            || fi.resultIsError !== expectedResultIsError || fi.confirmed !== expectedConfirmed || !receiptOk
          ) {
            errors.push({ field: `skill.foreignInvocations[${i}]`, code: 'invalid_relation' });
          }
        }
      }
    }
  }

  if (isPlainObject(observation.transcript)) {
    const strictIssues = Array.isArray(observation.transcript.strictStructuralIssues) ? observation.transcript.strictStructuralIssues : null;
    const effectiveIssues = Array.isArray(observation.transcript.effectiveStructuralIssues) ? observation.transcript.effectiveStructuralIssues : null;
    const strictIncomplete = Array.isArray(observation.transcript.strictIncompleteToolResults) ? observation.transcript.strictIncompleteToolResults : null;
    const effectiveIncomplete = Array.isArray(observation.transcript.effectiveIncompleteToolResults) ? observation.transcript.effectiveIncompleteToolResults : null;
    // JSON.stringify throws on a raw BigInt (strictIncompleteToolResults/effectiveIncompleteToolResults
    // entries carry a bigint receiptNs) -- stringify bigints to a tagged string form first.
    const issueKey = (i) => JSON.stringify(i, (_k, v) => (typeof v === 'bigint' ? `__bigint__${v}` : v));
    const sameOrderedArray = (a, b) => a.length === b.length && a.every((v, i) => issueKey(v) === issueKey(b[i]));

    // #round-5: effectiveStructuralIssues is the ORDERED filter of strict (round 4 compared sorted
    // keys, order-insensitive -- findTranscriptStructuralIssuesToleratingTimeout's real
    // implementation is `issues.filter(...)`, which preserves strict's own relative order exactly;
    // it never re-sorts). Splices out only the FIRST {type:'result_count',count:0} entry (there can
    // only ever be one, per the new per-type single-instance check below), preserving every other
    // entry's position.
    if (strictIssues && effectiveIssues) {
      const resultCount0Index = strictIssues.findIndex((v) => isPlainObject(v) && v.type === 'result_count' && v.count === 0);
      const expectedEffective = (isLegitimateTimeout && resultCount0Index !== -1)
        ? strictIssues.filter((_v, i) => i !== resultCount0Index)
        : strictIssues;
      if (!sameOrderedArray(effectiveIssues, expectedEffective)) {
        errors.push({ field: 'transcript.effectiveStructuralIssues', code: 'invalid_relation' });
      }
    }

    // #round-5: effectiveIncompleteToolResults is either IDENTICAL in order+content to strict, or
    // EMPTY (round 4 compared sorted keys, order-insensitive -- the real
    // findIncompleteToolResultsToleratingTimeout either returns `incomplete` completely unchanged or
    // `[]`, never a reordered variant).
    if (strictIncomplete && effectiveIncomplete) {
      const maxAttemptIndex = toolAttempts.reduce((max, a) => (isPlainObject(a) && nonNegInt(a.eventIndex) && a.eventIndex > max ? a.eventIndex : max), -1);
      const toleratesTheOne = isLegitimateTimeout && strictIncomplete.length === 1
        && isPlainObject(strictIncomplete[0]) && strictIncomplete[0].index === maxAttemptIndex;
      const expectedEffective = toleratesTheOne ? [] : strictIncomplete;
      if (!sameOrderedArray(effectiveIncomplete, expectedEffective)) {
        errors.push({ field: 'transcript.effectiveIncompleteToolResults', code: 'invalid_relation' });
      }
    }

    // #round-5: strictIncompleteToolResults must be an EXACT ORDERED projection WITH MULTIPLICITY of
    // every toolAttempts entry with result.found===false, mapped to {index:eventIndex, receiptNs,
    // name:runtimeName, id} -- round 4's Set-of-indices comparison silently collapsed two concurrent
    // incomplete calls sharing an eventIndex into a single accepted entry and was blind to ordering.
    // findIncompleteToolResults emits ONE entry PER tool_use block (never deduplicated by index), in
    // the same event-iteration order toolAttempts itself is built in.
    if (strictIncomplete) {
      const incompleteAttempts = toolAttempts.filter((a) => isPlainObject(a) && isPlainObject(a.result) && a.result.found === false);
      if (strictIncomplete.length !== incompleteAttempts.length) {
        errors.push({ field: 'transcript.strictIncompleteToolResults', code: 'invalid_relation' });
      } else {
        for (let i = 0; i < strictIncomplete.length; i++) {
          const item = strictIncomplete[i];
          const attempt = incompleteAttempts[i];
          if (!isPlainObject(item)) continue;
          if (item.index !== attempt.eventIndex || item.receiptNs !== attempt.receiptNs || item.name !== attempt.runtimeName || item.id !== attempt.id) {
            errors.push({ field: `transcript.strictIncompleteToolResults[${i}]`, code: 'invalid_relation' });
          }
        }
      }
    }

    // #round-5: structurally impossible combinations WITHIN strictStructuralIssues, derived directly
    // from findTranscriptStructuralIssues' own control flow -- init_not_first/result_not_last are
    // computed ONLY inside `if (initIndices.length===1 && resultIndices.length===1)`, so EITHER
    // count-mismatch issue (init_count or result_count, which only fire when that same length!==1)
    // makes BOTH ordering issues impossible in the same real array. Each of these 4 types is pushed
    // by a single non-looping `if`, so at most one instance of each ever appears. toolUseIdCounts/
    // toolResultIdCounts are Maps (unique keys) that duplicate_tool_use_id/orphan_tool_result/
    // duplicate_tool_result all iterate, so no two issues of the SAME type ever share an id
    // (including at most one orphan_tool_result with id:null).
    if (strictIssues) {
      const countOf = (type) => strictIssues.filter((v) => isPlainObject(v) && v.type === type).length;
      for (const type of ['init_count', 'result_count', 'init_not_first', 'result_not_last']) {
        if (countOf(type) > 1) errors.push({ field: 'transcript.strictStructuralIssues', code: 'duplicate_value' });
      }
      const hasCountIssue = countOf('init_count') > 0 || countOf('result_count') > 0;
      const hasOrderingIssue = countOf('init_not_first') > 0 || countOf('result_not_last') > 0;
      if (hasCountIssue && hasOrderingIssue) {
        errors.push({ field: 'transcript.strictStructuralIssues', code: 'invalid_relation' });
      }
      for (const type of ['duplicate_tool_use_id', 'orphan_tool_result', 'duplicate_tool_result']) {
        const ids = strictIssues.filter((v) => isPlainObject(v) && v.type === type).map((v) => v.id);
        if (new Set(ids).size !== ids.length) {
          errors.push({ field: 'transcript.strictStructuralIssues', code: 'duplicate_value' });
        }
      }
    }

    // #round-4-10/11: session.initPresent / terminal.present <-> strictStructuralIssues' init_count
    // / result_count issue (findInitEvent/findResultEvent take the FIRST matching event
    // regardless of count; the *_count issue fires exactly when count!==1). MUST read strict, not
    // effective -- effective may have result_count:0 filtered away under a legitimate timeout while
    // terminal.present is still genuinely false.
    if (strictIssues) {
      const initCountIssue = strictIssues.find((i) => isPlainObject(i) && i.type === 'init_count');
      const expectedInitPresent = initCountIssue ? (nonNegInt(initCountIssue.count) && initCountIssue.count >= 1) : true;
      if (isPlainObject(observation.session) && typeof observation.session.initPresent === 'boolean' && observation.session.initPresent !== expectedInitPresent) {
        errors.push({ field: 'session.initPresent', code: 'invalid_relation' });
      }

      const resultCountIssue = strictIssues.find((i) => isPlainObject(i) && i.type === 'result_count');
      const expectedTerminalPresent = resultCountIssue ? (nonNegInt(resultCountIssue.count) && resultCountIssue.count >= 1) : true;
      if (isPlainObject(observation.terminal) && typeof observation.terminal.present === 'boolean' && observation.terminal.present !== expectedTerminalPresent) {
        errors.push({ field: 'terminal.present', code: 'invalid_relation' });
      }
    }
  }
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

  validateCrossFieldInvariants(observation, errors);

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

/** Order-independent string identity for an ambient-name Set (JSON array of the sorted names).
 * The ONE implementation: stream-parser.mjs's canonicalAmbientSkillNamesKey re-exports this exact
 * function (review-round-3 fix -- previously stream-parser.mjs carried its own independent copy,
 * with only a test asserting the two happened to produce the same output; the runbook's file-scope
 * allowlist explicitly authorizes editing stream-parser.mjs to import/re-export this exact generic
 * helper instead). Defined here, not in stream-parser.mjs, so this runtime-agnostic module never
 * needs to import a Claude-specific one -- the dependency arrow points from stream-parser.mjs to
 * this contract, never the reverse. */
export function canonicalNamesKey(names) {
  return JSON.stringify([...names].sort());
}

/** HMAC-SHA256 fingerprint of an ambient-name Set, keyed by a caller-supplied ephemeral key. The
 * ONE implementation -- see canonicalNamesKey's doc comment above; stream-parser.mjs's
 * fingerprintAmbientSkillNames re-exports this exact function. */
export function fingerprintNames(names, key) {
  return createHmac('sha256', key).update(canonicalNamesKey(names)).digest('hex');
}
