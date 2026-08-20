#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/registries.mjs -- the ONE closed, validated layer over
// runtimes/registry.json, models/registry.json, and execution-profiles/registry.json. Loads the
// three JSON files from paths relative to `import.meta.url` (never `cwd`), validates exact key
// sets/types/enums/IDs/duplicates/cross-references, resolves either a documented default or an
// explicit selection with zero fallback, cross-checks a model's `required_capabilities`/
// `usage_dimensions` and an execution profile's `required_capabilities` against the actually
// registered runtime adapter, and returns an immutable (deep-frozen) selection.
//
// This module -- and no other core module or matrix-runner.mjs -- imports runtimes/claude-code.mjs
// (see agentic-eval-runtime-boundary.test.js's own boundary assertions). The JSON registries never
// name a module path: ADAPTERS_BY_RUNTIME_ID is a static, hand-written map, never dynamically
// imported from registry content.
//
// A registry entry never contains credentials, price, or any other mutable/priced data -- only
// stable execution metadata (ADR-6). `enabled:false` is how a model/profile is "removed"; it is
// never deleted, and it never invalidates a historical record that already references it (that
// guarantee lives in schemas.mjs's v6 validators, which never import this module at all -- a
// record's own embedded agent_runtime/execution_profile metadata is self-contained, never
// re-resolved through the live registry).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { USAGE_DIMENSIONS, REQUIRED_CAPABILITY_KEYS, validateRuntimeAdapter } from './runtimes/contract.mjs';
import { canonicalJsonSha256 } from './canonical-json.mjs';
import claudeCodeRuntimeAdapter from './runtimes/claude-code.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The static, hand-written runtime_id -> adapter map -- the ONE place besides
 * runtimes/claude-code.mjs itself where that module's default export is consumed. Never built by
 * interpreting a registry-supplied module path/string. Built on a NULL-PROTOTYPE base (never a
 * bare `{}`) so a bracket lookup can never resolve an inherited Object.prototype member (e.g.
 * `ADAPTERS_BY_RUNTIME_ID['constructor']`) instead of correctly reporting "absent" -- "constructor"
 * is the one Object.prototype member name that also happens to be a syntactically valid
 * lowercase-only runtime id (every other inherited name is camelCase and already fails checkId's
 * regex). getAdapterForRuntimeId below is the one safe accessor for THIS map and for any
 * caller-supplied test override, which may not itself be null-prototype. */
export const ADAPTERS_BY_RUNTIME_ID = Object.freeze(Object.assign(Object.create(null), {
  'claude-code': claudeCodeRuntimeAdapter,
}));

/** The one own-property-safe accessor for an `adaptersByRuntimeId` map -- used for BOTH the real,
 * null-prototype `ADAPTERS_BY_RUNTIME_ID` constant and any test-supplied override (which, unlike
 * the constant, may be an ordinary `{}` literal and so cannot be trusted to reject prototype-chain
 * lookups on its own). Returns `undefined` for any name that is not the map's own property, even
 * one inherited from `Object.prototype` -- never resolves `Object.prototype.constructor` (or any
 * other inherited member) as if it were a registered adapter.
 *
 * Codex round 3, Finding 2: an adapter registered under a runtime_id key was previously trusted
 * verbatim -- neither its own full contract (validateRuntimeAdapter) nor its own self-reported
 * `.id` matching the key it is registered under was ever checked at the point of lookup (only
 * `defineRuntimeAdapter`, at module-load time, validated the ONE real default export). A future
 * wiring bug -- the wrong adapter object registered under a runtime_id -- would otherwise silently
 * resolve and label a session under a DIFFERENT runtime than the one whose adapter is actually
 * driving it. Both checks happen HERE, the one shared accessor every lookup site (buildRegistries'
 * 3 loops, resolveSelection's own lookup) already goes through, so the guarantee applies
 * everywhere at once rather than needing to be repeated per call site. */
function getAdapterForRuntimeId(adaptersByRuntimeId, runtimeId) {
  if (!Object.prototype.hasOwnProperty.call(adaptersByRuntimeId, runtimeId)) return undefined;
  const adapter = adaptersByRuntimeId[runtimeId];
  const { ok } = validateRuntimeAdapter(adapter);
  if (!ok) return undefined;
  if (adapter.id !== runtimeId) return undefined;
  return adapter;
}

/** Calls `adapter[methodName](entry)`, catching ANY exception and treating it as a fail-closed
 * `false` (Section: "una excepción del adapter falla cerrado con error saneado") -- an adapter's
 * supportsModelConfiguration/supportsExecutionProfile must never be able to crash registry
 * validation or selection resolution, and a thrown error's own message/stack (which could carry
 * adapter-internal content) must never leak into a validation/selection error string. Only a
 * literal `=== true` return counts as support; any other return value (including a truthy
 * non-boolean) is treated as unsupported. */
function callAdapterSupportCheck(adapter, methodName, entry) {
  try {
    return adapter[methodName](entry) === true;
  } catch {
    return false;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// P1 architectural review (Codex round 2): was a local copy here, independently duplicated from
// schemas.mjs's own (differently-scoped, wrongly-permissive) required-capabilities check --
// REQUIRED_CAPABILITY_KEYS is now the ONE shared vocabulary both modules consume from
// contract.mjs, so a registry-accepted required_capabilities value and a schema-accepted one can
// never silently diverge.
const REQUIRABLE_CAPABILITY_KEYS = REQUIRED_CAPABILITY_KEYS;

const MODEL_VENDOR_VALUES = Object.freeze(['anthropic', 'openai', 'google', 'microsoft', 'other']);
const ISOLATION_KIND_VALUES = Object.freeze(['runtime-policy-hooks', 'external-sandbox', 'runtime-native-sandbox']);
const NETWORK_MODE_VALUES = Object.freeze(['runtime-default', 'restricted', 'disabled']);
const POLICY_MODE_VALUES = Object.freeze(['required', 'not_applicable']);

const RUNTIME_ENTRY_KEYS = Object.freeze(['runtime_id', 'enabled', 'default']);
const MODEL_ENTRY_KEYS = Object.freeze([
  'runtime_id', 'model_id', 'enabled', 'default', 'model_vendor_expected', 'default_reasoning_mode',
  'required_capabilities', 'usage_dimensions',
]);
const PROFILE_ENTRY_KEYS = Object.freeze([
  'id', 'enabled', 'default', 'supported_runtime_ids', 'isolation_kind', 'network_mode',
  'isolation_attestation_required', 'policy_mode', 'required_capabilities',
]);

// The canonical hash projection (Section A of the runbook): only fields that change EXECUTION
// SEMANTICS. `enabled`/`default`/`supported_runtime_ids` control selection/compatibility, never
// what a session under this profile actually does, so they are deliberately excluded.
const EXECUTION_PROFILE_HASH_KEYS = Object.freeze(['id', 'isolation_kind', 'network_mode', 'isolation_attestation_required', 'policy_mode', 'required_capabilities']);

function isPlainObject(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function fail(errors, message) {
  errors.push(message);
}

/** Closed-keyset check: every key in `allowedKeys` must be present as an own property, and no
 * other own property may exist. Mirrors schemas.mjs's/accepted-run-audit.mjs's own
 * `rejectUnrecognizedKeys`/`checkKeys` pattern -- this module's own small, local copy rather than
 * a shared cross-module helper, matching this codebase's established per-module convention. */
function checkExactKeys(obj, allowedKeys, label, errors) {
  if (!isPlainObject(obj)) {
    fail(errors, `${label}: must be a plain object`);
    return;
  }
  for (const k of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) fail(errors, `${label}: missing required key "${k}"`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.includes(k)) fail(errors, `${label}: unrecognized key "${k}"`);
  }
}

function checkId(value, label, errors) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail(errors, `${label}: must be a lowercase id matching ${ID_RE} -- got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

function checkBoolean(value, label, errors) {
  if (typeof value !== 'boolean') fail(errors, `${label}: must be a boolean -- got ${JSON.stringify(value)}`);
}

function checkEnum(value, allowed, label, errors) {
  if (!allowed.includes(value)) fail(errors, `${label}: must be one of ${allowed.join('|')} -- got ${JSON.stringify(value)}`);
}

/** Validates a `required_capabilities` array: unique strings, each a member of
 * REQUIRABLE_CAPABILITY_KEYS, listed in that same canonical relative order (mirrors
 * contract.mjs's own usage-dimension ordering discipline, so two semantically-equal arrays never
 * produce a different canonical hash). Returns the validated array (or `null` if malformed --
 * caller skips the downstream adapter cross-check in that case). */
function checkRequiredCapabilities(value, label, errors) {
  if (!Array.isArray(value)) {
    fail(errors, `${label}: must be an array`);
    return null;
  }
  const seen = new Set();
  let lastIdx = -1;
  let ok = true;
  for (const v of value) {
    if (typeof v !== 'string' || !REQUIRABLE_CAPABILITY_KEYS.includes(v)) {
      fail(errors, `${label}: unknown or non-boolean capability "${JSON.stringify(v)}" -- must be one of ${REQUIRABLE_CAPABILITY_KEYS.join('|')}`);
      ok = false;
      continue;
    }
    if (seen.has(v)) {
      fail(errors, `${label}: duplicate capability "${v}"`);
      ok = false;
      continue;
    }
    seen.add(v);
    const idx = REQUIRABLE_CAPABILITY_KEYS.indexOf(v);
    if (idx < lastIdx) {
      fail(errors, `${label}: capability "${v}" is out of canonical order`);
      ok = false;
    }
    lastIdx = idx;
  }
  return ok ? value : null;
}

/** Validates a model entry's `usage_dimensions`: unique strings, each a member of
 * contract.mjs's USAGE_DIMENSIONS, listed in that canonical order. Returns the validated array or
 * `null`. */
function checkUsageDimensions(value, label, errors) {
  if (!Array.isArray(value)) {
    fail(errors, `${label}: must be an array`);
    return null;
  }
  const seen = new Set();
  let lastIdx = -1;
  let ok = true;
  for (const v of value) {
    if (typeof v !== 'string' || !USAGE_DIMENSIONS.includes(v)) {
      fail(errors, `${label}: unknown usage dimension "${JSON.stringify(v)}"`);
      ok = false;
      continue;
    }
    if (seen.has(v)) {
      fail(errors, `${label}: duplicate usage dimension "${v}"`);
      ok = false;
      continue;
    }
    seen.add(v);
    const idx = USAGE_DIMENSIONS.indexOf(v);
    if (idx < lastIdx) {
      fail(errors, `${label}: usage dimension "${v}" is out of canonical order`);
      ok = false;
    }
    lastIdx = idx;
  }
  return ok ? value : null;
}

function checkStringIdArray(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(errors, `${label}: must be a non-empty array`);
    return null;
  }
  const seen = new Set();
  let ok = true;
  for (const v of value) {
    if (typeof v !== 'string' || !ID_RE.test(v)) {
      fail(errors, `${label}: invalid id entry ${JSON.stringify(v)}`);
      ok = false;
      continue;
    }
    if (seen.has(v)) {
      fail(errors, `${label}: duplicate entry "${v}"`);
      ok = false;
      continue;
    }
    seen.add(v);
  }
  return ok ? value : null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze(value[k]);
  }
  return value;
}

/**
 * Validates and builds the three registries from already-parsed JS values (never touches the
 * filesystem) -- the pure core `loadRegistries()` wraps with real file reads. Throws a single
 * aggregated `Error` (message joins every violation found, never just the first) on ANY
 * structural violation: unknown/missing/extra key, invalid id, duplicate id, wrong type, bad
 * enum, broken cross-reference, a default that is not unique-and-compatible, or a
 * required_capabilities/usage_dimensions entry the registered adapter does not actually satisfy.
 * Returns a deep-frozen `{runtimes, models, executionProfiles}`.
 * @param {{runtimes: any, models: any, executionProfiles: any}} raw
 * @param {{adaptersByRuntimeId?: object}} [opts] - test-only override of the runtime_id->adapter
 *   map; production callers never pass this (defaults to the real ADAPTERS_BY_RUNTIME_ID).
 */
export function buildRegistries({ runtimes, models, executionProfiles }, { adaptersByRuntimeId = ADAPTERS_BY_RUNTIME_ID } = {}) {
  const errors = [];

  if (!Array.isArray(runtimes)) fail(errors, 'runtimes: must be an array');
  if (!Array.isArray(models)) fail(errors, 'models: must be an array');
  if (!Array.isArray(executionProfiles)) fail(errors, 'executionProfiles: must be an array');
  if (errors.length > 0) throw new Error(`registries.mjs: invalid registries -- ${errors.join('; ')}`);

  // --- runtimes ---
  const seenRuntimeIds = new Set();
  runtimes.forEach((entry, i) => {
    const label = `runtimes[${i}]`;
    checkExactKeys(entry, RUNTIME_ENTRY_KEYS, label, errors);
    if (!isPlainObject(entry)) return;
    if (checkId(entry.runtime_id, `${label}.runtime_id`, errors)) {
      if (seenRuntimeIds.has(entry.runtime_id)) fail(errors, `${label}.runtime_id: duplicate runtime_id "${entry.runtime_id}"`);
      seenRuntimeIds.add(entry.runtime_id);
    }
    checkBoolean(entry.enabled, `${label}.enabled`, errors);
    checkBoolean(entry.default, `${label}.default`, errors);
    if (entry.default === true && entry.enabled !== true) fail(errors, `${label}: default:true requires enabled:true`);
  });
  const registeredRuntimeIds = new Set(runtimes.filter((e) => isPlainObject(e) && typeof e.runtime_id === 'string').map((e) => e.runtime_id));
  const defaultRuntimeCount = runtimes.filter((e) => isPlainObject(e) && e.default === true && e.enabled === true).length;
  if (defaultRuntimeCount !== 1) fail(errors, `runtimes: exactly one enabled default runtime is required, found ${defaultRuntimeCount}`);

  // --- models ---
  const seenModelPairs = new Set();
  const modelDefaultCountByRuntime = new Map();
  models.forEach((entry, i) => {
    const label = `models[${i}]`;
    checkExactKeys(entry, MODEL_ENTRY_KEYS, label, errors);
    if (!isPlainObject(entry)) return;
    const runtimeIdOk = checkId(entry.runtime_id, `${label}.runtime_id`, errors);
    if (runtimeIdOk && !registeredRuntimeIds.has(entry.runtime_id)) {
      fail(errors, `${label}.runtime_id: references unregistered runtime "${entry.runtime_id}"`);
    }
    const modelIdOk = checkId(entry.model_id, `${label}.model_id`, errors);
    if (runtimeIdOk && modelIdOk) {
      const pairKey = `${entry.runtime_id}:${entry.model_id}`;
      if (seenModelPairs.has(pairKey)) fail(errors, `${label}: duplicate (runtime_id, model_id) pair (${entry.runtime_id}, ${entry.model_id})`);
      seenModelPairs.add(pairKey);
    }
    checkBoolean(entry.enabled, `${label}.enabled`, errors);
    checkBoolean(entry.default, `${label}.default`, errors);
    if (entry.default === true && entry.enabled !== true) fail(errors, `${label}: default:true requires enabled:true`);
    checkEnum(entry.model_vendor_expected, MODEL_VENDOR_VALUES, `${label}.model_vendor_expected`, errors);
    if (entry.default_reasoning_mode !== null && typeof entry.default_reasoning_mode !== 'string') {
      fail(errors, `${label}.default_reasoning_mode: must be null or a string`);
    }
    checkRequiredCapabilities(entry.required_capabilities, `${label}.required_capabilities`, errors);
    checkUsageDimensions(entry.usage_dimensions, `${label}.usage_dimensions`, errors);
    if (runtimeIdOk && entry.default === true && entry.enabled === true) {
      modelDefaultCountByRuntime.set(entry.runtime_id, (modelDefaultCountByRuntime.get(entry.runtime_id) ?? 0) + 1);
    }
  });
  // --- execution profiles ---
  const seenProfileIds = new Set();
  const profileDefaultCountByRuntime = new Map();
  executionProfiles.forEach((entry, i) => {
    const label = `executionProfiles[${i}]`;
    checkExactKeys(entry, PROFILE_ENTRY_KEYS, label, errors);
    if (!isPlainObject(entry)) return;
    if (checkId(entry.id, `${label}.id`, errors)) {
      if (seenProfileIds.has(entry.id)) fail(errors, `${label}.id: duplicate execution profile id "${entry.id}"`);
      seenProfileIds.add(entry.id);
    }
    checkBoolean(entry.enabled, `${label}.enabled`, errors);
    checkBoolean(entry.default, `${label}.default`, errors);
    if (entry.default === true && entry.enabled !== true) fail(errors, `${label}: default:true requires enabled:true`);
    const supportedOk = checkStringIdArray(entry.supported_runtime_ids, `${label}.supported_runtime_ids`, errors) != null;
    if (supportedOk) {
      for (const rid of entry.supported_runtime_ids) {
        if (!registeredRuntimeIds.has(rid)) fail(errors, `${label}.supported_runtime_ids: references unregistered runtime "${rid}"`);
      }
    }
    checkEnum(entry.isolation_kind, ISOLATION_KIND_VALUES, `${label}.isolation_kind`, errors);
    checkEnum(entry.network_mode, NETWORK_MODE_VALUES, `${label}.network_mode`, errors);
    checkBoolean(entry.isolation_attestation_required, `${label}.isolation_attestation_required`, errors);
    checkEnum(entry.policy_mode, POLICY_MODE_VALUES, `${label}.policy_mode`, errors);
    const requiredCapsOk = checkRequiredCapabilities(entry.required_capabilities, `${label}.required_capabilities`, errors) != null;
    // Decision A: policy_mode:"not_applicable" is a claim that no runtime-policy-hook mechanism
    // governs this profile's Bash dispatch -- that claim is only coherent when paired with a REAL,
    // externally-verified isolation boundary. Structural (registry-shape) invariant, independent of
    // which adapter (if any) ever accepts a given profile id, and independent of `enabled` (a
    // disabled entry with an incoherent not_applicable shape is still a shape defect worth catching
    // now, not only if it is ever re-enabled) -- mirrors every other check in this loop, all of
    // which run unconditionally.
    if (entry.policy_mode === 'not_applicable') {
      // Mirrors the adapter-rejection message below (`executionProfiles[${entry.id}]: ...`), not
      // the numeric-index `label` this loop otherwise uses -- so a caller matching on the profile's
      // own id (as every other rejection reason in this codebase's own test suite already does)
      // gets a consistent message regardless of which specific check actually fired first.
      const idLabel = `executionProfiles[${entry.id}]`;
      if (entry.isolation_attestation_required !== true) {
        fail(errors, `${idLabel}: policy_mode "not_applicable" requires isolation_attestation_required:true`);
      }
      if (entry.isolation_kind === 'runtime-policy-hooks') {
        fail(errors, `${idLabel}: policy_mode "not_applicable" requires a real isolation boundary -- isolation_kind must not be "runtime-policy-hooks"`);
      }
      if (requiredCapsOk && entry.required_capabilities.includes('softPermissionDenial')) {
        fail(errors, `${idLabel}: policy_mode "not_applicable" must not require "softPermissionDenial" -- no policy hook governs this profile`);
      }
    }
    if (supportedOk && entry.default === true && entry.enabled === true) {
      for (const rid of entry.supported_runtime_ids) {
        profileDefaultCountByRuntime.set(rid, (profileDefaultCountByRuntime.get(rid) ?? 0) + 1);
      }
    }
  });
  // Driven by the CANONICAL enabled-runtimes list (the `runtimes` array itself), never by which
  // runtime_ids merely happen to appear in models/executionProfiles -- an enabled runtime with
  // zero models or zero execution profiles referencing it at all must still fail here, not pass
  // for lack of anything to iterate.
  const enabledRuntimeIds = runtimes
    .filter((e) => isPlainObject(e) && e.enabled === true && typeof e.runtime_id === 'string')
    .map((e) => e.runtime_id);
  for (const runtimeId of enabledRuntimeIds) {
    const modelCount = modelDefaultCountByRuntime.get(runtimeId) ?? 0;
    if (modelCount !== 1) fail(errors, `models: runtime "${runtimeId}" must have exactly one enabled default model, found ${modelCount}`);
    const profileCount = profileDefaultCountByRuntime.get(runtimeId) ?? 0;
    if (profileCount !== 1) fail(errors, `executionProfiles: runtime "${runtimeId}" must have exactly one enabled default execution profile, found ${profileCount}`);
  }

  if (errors.length > 0) throw new Error(`registries.mjs: invalid registries -- ${errors.join('; ')}`);

  // Codex round 3, Finding 4: build + freeze the FINAL candidate structure NOW, before any
  // adapter predicate ever runs -- an adapter's supportsModelConfiguration/supportsExecutionProfile
  // implementation must never be able to mutate the entry it was just asked about and have that
  // mutation silently become what gets published. Every loop below reads (and passes to adapter
  // predicates) these ALREADY-FROZEN entries; the function's own return value is exactly this same
  // object, never a second, later-built clone that could reflect a mutation the predicate call
  // caused on some other, still-mutable copy. A mutation attempt against a frozen object throws
  // (ES modules are always strict mode) -- callAdapterSupportCheck's existing fail-closed
  // try/catch already treats that as "does not support", so a misbehaving adapter causes the
  // offending entry to be rejected, never silently accepted with the mutated value.
  const candidate = deepFreeze({
    runtimes: runtimes.map((e) => ({ ...e })),
    models: models.map((e) => ({ ...e, required_capabilities: [...e.required_capabilities], usage_dimensions: [...e.usage_dimensions] })),
    executionProfiles: executionProfiles.map((e) => ({ ...e, supported_runtime_ids: [...e.supported_runtime_ids], required_capabilities: [...e.required_capabilities] })),
  });

  // --- cross-validate against the registered adapter (only reachable once every shape check above is clean) ---
  for (const entry of candidate.models) {
    const adapter = getAdapterForRuntimeId(adaptersByRuntimeId, entry.runtime_id);
    if (adapter == null) {
      fail(errors, `models: runtime "${entry.runtime_id}" has no registered adapter in ADAPTERS_BY_RUNTIME_ID`);
      continue;
    }
    for (const cap of entry.required_capabilities) {
      if (adapter.capabilities[cap] !== true) {
        fail(errors, `models[${entry.runtime_id}/${entry.model_id}]: required capability "${cap}" is not true on the "${entry.runtime_id}" adapter`);
      }
    }
    for (const dim of entry.usage_dimensions) {
      if (!adapter.capabilities.usageDimensions.includes(dim)) {
        fail(errors, `models[${entry.runtime_id}/${entry.model_id}]: usage dimension "${dim}" is not declared by the "${entry.runtime_id}" adapter`);
      }
    }
    // P1 architectural review (Codex round 2): required_capabilities/usage_dimensions being
    // individually satisfied does NOT mean the adapter actually APPLIES this model's own full
    // configuration (e.g. default_reasoning_mode) -- only ENABLED entries are checked; a disabled
    // entry is kept for history without needing to be currently implementable.
    if (entry.enabled === true && !callAdapterSupportCheck(adapter, 'supportsModelConfiguration', entry)) {
      fail(errors, `models[${entry.runtime_id}/${entry.model_id}]: the "${entry.runtime_id}" adapter does not support this model's configuration (supportsModelConfiguration returned false)`);
    }
  }
  for (const entry of candidate.executionProfiles) {
    for (const runtimeId of entry.supported_runtime_ids) {
      const adapter = getAdapterForRuntimeId(adaptersByRuntimeId, runtimeId);
      if (adapter == null) {
        fail(errors, `executionProfiles[${entry.id}]: runtime "${runtimeId}" has no registered adapter in ADAPTERS_BY_RUNTIME_ID`);
        continue;
      }
      for (const cap of entry.required_capabilities) {
        if (adapter.capabilities[cap] !== true) {
          fail(errors, `executionProfiles[${entry.id}]: required capability "${cap}" is not true on the "${runtimeId}" adapter`);
        }
      }
      // Same discipline as the model check above: capability satisfaction is necessary but not
      // sufficient -- e.g. sandboxed-unrestricted-v1 can trivially satisfy required_capabilities:[]
      // while the adapter still never actually establishes the sandbox/network isolation the
      // profile's own isolation_kind/network_mode claim. Only ENABLED entries are checked.
      if (entry.enabled === true && !callAdapterSupportCheck(adapter, 'supportsExecutionProfile', entry)) {
        fail(errors, `executionProfiles[${entry.id}]: the "${runtimeId}" adapter does not support this execution profile's configuration (supportsExecutionProfile returned false)`);
      }
    }
  }
  // Every ENABLED runtime needs its own adapter, independent of whether it happens to be
  // referenced by any model or execution profile -- an orphaned enabled runtime with neither must
  // still be flagged here, not silently accepted for lack of anything else to iterate.
  for (const runtimeId of enabledRuntimeIds) {
    if (getAdapterForRuntimeId(adaptersByRuntimeId, runtimeId) == null) {
      fail(errors, `runtimes: enabled runtime "${runtimeId}" has no registered adapter in ADAPTERS_BY_RUNTIME_ID`);
    }
  }

  if (errors.length > 0) throw new Error(`registries.mjs: invalid registries -- ${errors.join('; ')}`);

  // Codex round 3, Finding 3: marks this EXACT object as having already passed the full
  // validation this function performs, so resolveSelection can trust it without redundantly
  // rebuilding/revalidating it on every call -- see resolveSelection's own doc comment. A WeakSet
  // (not a property on the object itself) so the marker can never itself be observed, copied, or
  // spoofed by constructing a look-alike object.
  VALIDATED_REGISTRIES.add(candidate);
  return candidate;
}

// Codex round 3, Finding 3: the ONE marker of "this exact registries object already passed
// buildRegistries' full validation" -- keyed by object identity (WeakSet), never by a property on
// the object itself (which a caller could otherwise forge by copying it onto an unvalidated
// look-alike). Fully module-private -- no export, test-only or otherwise (Codex round 3 audit):
// the WeakSet is an implementation detail of the fast-path/slow-path equivalence resolveSelection
// provides, never itself a public contract. Tests verify the OBSERVABLE behavior this exists to
// support (resolveSelection's own selection output, identical whether the registries object was
// already validated or gets revalidated inline), not this internal marker's own membership.
const VALIDATED_REGISTRIES = new WeakSet();

/** Validates one registry JSON file's own top-level container shape -- exactly `{schema: 1,
 * [arrayKey]: [...]}`, no more, no fewer keys. Exported so this exact-top-level-shape contract
 * (Section A: "Los tres JSON tienen top-level exacto") is directly unit-testable against a
 * synthetic parsed value, independent of `loadRegistries`' own real file reads. Throws with a
 * label-prefixed message on any violation; returns the validated array on success. */
export function checkRegistryContainerShape(json, arrayKey, label) {
  if (!isPlainObject(json)) throw new Error(`registries.mjs: ${label} must be a JSON object`);
  const keys = Object.keys(json);
  if (keys.length !== 2 || !keys.includes('schema') || !keys.includes(arrayKey)) {
    throw new Error(`registries.mjs: ${label} must have exactly the top-level keys "schema" and "${arrayKey}", got ${JSON.stringify(keys)}`);
  }
  if (json.schema !== 1) throw new Error(`registries.mjs: ${label}.schema must be exactly 1, got ${JSON.stringify(json.schema)}`);
  if (!Array.isArray(json[arrayKey])) throw new Error(`registries.mjs: ${label}.${arrayKey} must be an array`);
  return json[arrayKey];
}

/** Reads and parses the three registry JSON files from paths relative to THIS module's own
 * location (never `process.cwd()`), then builds+validates them via buildRegistries. Throws on any
 * read/parse/structural failure -- a malformed shipped registry is a codebase defect, never a
 * recoverable per-invocation condition. */
export function loadRegistries() {
  const runtimesPath = join(__dirname, 'runtimes', 'registry.json');
  const modelsPath = join(__dirname, 'models', 'registry.json');
  const profilesPath = join(__dirname, 'execution-profiles', 'registry.json');
  const runtimesJson = JSON.parse(readFileSync(runtimesPath, 'utf8'));
  const modelsJson = JSON.parse(readFileSync(modelsPath, 'utf8'));
  const profilesJson = JSON.parse(readFileSync(profilesPath, 'utf8'));
  const runtimes = checkRegistryContainerShape(runtimesJson, 'runtimes', 'runtimes/registry.json');
  const models = checkRegistryContainerShape(modelsJson, 'models', 'models/registry.json');
  const executionProfiles = checkRegistryContainerShape(profilesJson, 'execution_profiles', 'execution-profiles/registry.json');
  return buildRegistries({ runtimes, models, executionProfiles });
}

/** The canonical execution-profile identity hash: SHA-256 of the canonical JSON of exactly
 * EXECUTION_PROFILE_HASH_KEYS, excluding enabled/default/supported_runtime_ids (Section A). */
export function computeExecutionProfileSha256(profile) {
  const projection = {};
  for (const k of EXECUTION_PROFILE_HASH_KEYS) projection[k] = profile[k];
  return canonicalJsonSha256(projection);
}

let cachedRealRegistries = null;
function realRegistries() {
  if (cachedRealRegistries == null) cachedRealRegistries = loadRegistries();
  return cachedRealRegistries;
}

/**
 * Resolves exactly one (runtime, model, execution-profile) selection. Never falls back after
 * receiving an invalid explicit value -- an unknown/disabled id, a model belonging to a different
 * runtime, or a profile that does not support the resolved runtime all fail closed with
 * `{ok:false, reason}`, before any auth/materialize/spawn ever happens. Omitting a flag (passing
 * `undefined`/`null`) resolves to the registry's own documented default for that axis, scoped to
 * the ALREADY-resolved runtime for model/profile -- resolution order is always runtime, then
 * model and execution-profile (both independently scoped to that one runtime).
 * @param {{runtimeId?: string|null, modelId?: string|null, executionProfileId?: string|null, registries?: object}} opts
 * @returns {{ok:true, selection:{runtime:object, model:object, executionProfile:object, adapter:object, executionProfileSha256:string}} | {ok:false, reason:string}}
 */
export function resolveSelection({ runtimeId = null, modelId = null, executionProfileId = null, registries = realRegistries() } = {}) {
  // Codex round 3, Finding 3: a `registries` object this function has not itself already fully
  // validated (tracked by VALIDATED_REGISTRIES, set only by buildRegistries' own return) is routed
  // through buildRegistries NOW -- its full shape/enum/cross-reference/capability/adapter-support
  // validation, never a second, narrower, independently-drifting partial re-check (the previous
  // approach here only re-ran the 2 adapter-support predicates, which let a raw registries object
  // naming an unknown required_capabilities/usage_dimensions value still resolve successfully).
  // An already-validated object -- the overwhelmingly common real case: every production caller
  // resolves through loadRegistries -> buildRegistries first -- is used as-is, never redundantly
  // rebuilt. Always the real ADAPTERS_BY_RUNTIME_ID (this function has never accepted a caller
  // override for it, matching its own adapter lookup below).
  if (!VALIDATED_REGISTRIES.has(registries)) {
    try {
      registries = buildRegistries({ runtimes: registries.runtimes, models: registries.models, executionProfiles: registries.executionProfiles });
    } catch (err) {
      return { ok: false, reason: `registries failed full validation: ${err.message}` };
    }
  }

  let runtime;
  if (runtimeId != null) {
    runtime = registries.runtimes.find((r) => r.runtime_id === runtimeId);
    if (runtime == null) return { ok: false, reason: `unknown --runtime "${runtimeId}"` };
    if (runtime.enabled !== true) return { ok: false, reason: `--runtime "${runtimeId}" is disabled` };
  } else {
    const defaults = registries.runtimes.filter((r) => r.enabled === true && r.default === true);
    if (defaults.length !== 1) return { ok: false, reason: `no unique default runtime is available (found ${defaults.length})` };
    [runtime] = defaults;
  }

  const compatibleModels = registries.models.filter((m) => m.runtime_id === runtime.runtime_id);
  let model;
  if (modelId != null) {
    model = compatibleModels.find((m) => m.model_id === modelId);
    if (model == null) return { ok: false, reason: `unknown or incompatible --model "${modelId}" for runtime "${runtime.runtime_id}"` };
    if (model.enabled !== true) return { ok: false, reason: `--model "${modelId}" is disabled` };
  } else {
    const defaults = compatibleModels.filter((m) => m.enabled === true && m.default === true);
    if (defaults.length !== 1) return { ok: false, reason: `no unique default model is available for runtime "${runtime.runtime_id}" (found ${defaults.length})` };
    [model] = defaults;
  }

  const compatibleProfiles = registries.executionProfiles.filter((p) => p.supported_runtime_ids.includes(runtime.runtime_id));
  let executionProfile;
  if (executionProfileId != null) {
    executionProfile = compatibleProfiles.find((p) => p.id === executionProfileId);
    if (executionProfile == null) return { ok: false, reason: `unknown or unsupported --execution-profile "${executionProfileId}" for runtime "${runtime.runtime_id}"` };
    if (executionProfile.enabled !== true) return { ok: false, reason: `--execution-profile "${executionProfileId}" is disabled` };
  } else {
    const defaults = compatibleProfiles.filter((p) => p.enabled === true && p.default === true);
    if (defaults.length !== 1) return { ok: false, reason: `no unique default execution profile is available for runtime "${runtime.runtime_id}" (found ${defaults.length})` };
    [executionProfile] = defaults;
  }

  const adapter = getAdapterForRuntimeId(ADAPTERS_BY_RUNTIME_ID, runtime.runtime_id);
  if (adapter == null) return { ok: false, reason: `no adapter registered for runtime "${runtime.runtime_id}"` };

  // No separate supportsModelConfiguration/supportsExecutionProfile re-check needed here (Codex
  // round 3, Finding 3 -- superseding the P1 architectural review round-2 partial re-check this
  // replaced): `registries` is now GUARANTEED to have passed buildRegistries' own full validation
  // (the routing above either just ran it or trusted a prior VALIDATED_REGISTRIES-tracked result),
  // which already required EVERY enabled model/execution-profile entry to satisfy these exact
  // predicates against the adapter registered for its own runtime_id/supported_runtime_ids --
  // `model`/`executionProfile` here are both confirmed enabled (the resolution branches above
  // never select a disabled entry) and scoped to this SAME `runtime.runtime_id`, so they were
  // already checked against this SAME adapter. A second, narrower re-check here would only ever
  // be a second, independently-drifting notion of the same guarantee.

  return {
    ok: true,
    selection: deepFreeze({
      runtime, model, executionProfile, adapter, executionProfileSha256: computeExecutionProfileSha256(executionProfile),
    }),
  };
}
