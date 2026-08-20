#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/execution-profiles/isolation-attestation.mjs -- loads and validates a local,
// operator-authored isolation attestation for a policy_mode:"not_applicable" execution profile
// (today: sandboxed-unrestricted-v1). The attestation is a JSON local file the operator supplies
// via an explicit CLI flag -- never a record, never a sidecar, never itself committable, never
// itself proof of a real external boundary. This module validates that the DECLARATION is
// internally consistent (closed shape, exact enums/booleans, fresh, matching the actual
// selection/platform/harness) and returns only a bound hash -- it does not, and cannot, verify
// that any VM/sandbox/runner actually exists. See the runbook's own closing note on this module's
// scope: this is a declaration bound by hash, not enforcement or a technical proof.
import { lstatSync, readFileSync } from 'node:fs';
import { canonicalJsonSha256 } from '../canonical-json.mjs';

const ATTESTATION_KEYS = Object.freeze([
  'schema', 'profile_id', 'runtime_id', 'campaign_id', 'platform', 'boundary_kind', 'network_mode',
  'workspace_scope', 'runtime_credential_scope', 'normal_maintainer_home_mounted', 'ambient_secrets_present',
  'disposable_home', 'rollback_or_destroy_required', 'harness_sha', 'created_at', 'expires_at',
]);

// Only literally valid today (the ONE policy_mode:not_applicable profile this repo ships) --
// widening either requires a deliberate change here, never an incidental loosening.
const SUPPORTED_PROFILE_ID = 'sandboxed-unrestricted-v1';
const SUPPORTED_RUNTIME_ID = 'claude-code';

const PLATFORM_VALUES = Object.freeze(['windows', 'macos', 'linux']);
const BOUNDARY_KIND_VALUES = Object.freeze(['disposable-vm', 'dedicated-ephemeral-runner', 'reviewed-external-sandbox']);

const CAMPAIGN_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const HARNESS_SHA_RE = /^[0-9a-f]{40}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const MAX_FILE_BYTES = 16 * 1024;
const CLOCK_SKEW_FORWARD_MS = 5 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

// This module's own small, local copy of the plain-object check -- matches the established
// per-module convention (registries.mjs/contract.mjs each keep their own), never a shared
// cross-module helper. Rejects anything backed by a prototype chain beyond the plain-object
// baseline (Object.prototype or null) -- a real attack surface only in principle for JSON.parse
// output (which always produces Object.prototype-rooted objects for object literals), kept here as
// an explicit, defense-in-depth contract rather than an incidentally-true accident.
function isPlainObject(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** V8's `Date.parse` silently NORMALIZES an out-of-range calendar value (e.g. "2026-02-30" becomes
 * March 2nd) rather than rejecting it -- format-regex-valid but not a REAL calendar date/time must
 * still fail closed here, so every component is round-tripped against the parsed UTC value rather
 * than trusting `Number.isNaN(Date.parse(...))` alone to catch it. */
function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const [, y, mo, d, h, mi, s] = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/).map(Number);
  const date = new Date(ms);
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === mo && date.getUTCDate() === d
    && date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s;
}

/**
 * Loads and validates one isolation attestation file from `filePath`. Fails closed on any
 * violation, returning ONLY a closed reason code -- never the path, never file content, never any
 * individual field value (campaign_id, timestamps, etc. are operator/campaign-identifying and must
 * never reach a record, sidecar, stdout, stderr, journal, or diagnostics string).
 *
 * `expected` is REQUIRED (a caller-contract violation, not an attestation-content problem, throws
 * synchronously rather than returning `{ok:false}`) -- this loader's whole purpose is proving the
 * declaration matches THIS invocation's actual resolved selection/platform/harness, so a caller
 * that omits it is a programming error, never a legitimate "skip the cross-check" path.
 *
 * `now` is injectable (a real `Date` instance) so tests never monkeypatch the global `Date` --
 * production callers rely on the default, evaluated fresh on every call.
 *
 * On success, returns exactly `{ok:true, schema:1, sha256}` -- `sha256` is the canonical-JSON
 * SHA-256 of the parsed attestation object (whitespace/CRLF-independent), never a hash of the raw
 * file bytes. Nothing else from the parsed content is returned.
 * @param {string} filePath
 * @param {{profileId: string, runtimeId: string, platform: string, networkMode: string, harnessSha: string}} expected
 * @param {{now?: Date}} [opts]
 * @returns {{ok: true, schema: 1, sha256: string} | {ok: false, reason: string}}
 */
export function loadIsolationAttestation(filePath, expected, { now = new Date() } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('loadIsolationAttestation: filePath must be a non-empty string');
  }
  if (
    expected == null || typeof expected !== 'object'
    || typeof expected.profileId !== 'string' || typeof expected.runtimeId !== 'string'
    || typeof expected.platform !== 'string' || typeof expected.networkMode !== 'string'
    || typeof expected.harnessSha !== 'string'
  ) {
    throw new Error('loadIsolationAttestation: expected must be provided with string profileId/runtimeId/platform/networkMode/harnessSha');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('loadIsolationAttestation: now must be a valid Date');
  }

  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    return { ok: false, reason: 'not_a_regular_file' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'not_a_regular_file' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: 'file_too_large' };

  let buf;
  try {
    buf = readFileSync(filePath);
  } catch {
    return { ok: false, reason: 'not_a_regular_file' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { ok: false, reason: 'invalid_encoding' };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, reason: 'invalid_encoding' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'invalid_json' };

  const keys = Object.keys(parsed);
  for (const k of ATTESTATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, k)) return { ok: false, reason: 'invalid_keys' };
  }
  for (const k of keys) {
    if (!ATTESTATION_KEYS.includes(k)) return { ok: false, reason: 'invalid_keys' };
  }

  if (parsed.schema !== 1) return { ok: false, reason: 'invalid_schema' };
  if (parsed.profile_id !== SUPPORTED_PROFILE_ID) return { ok: false, reason: 'invalid_profile_id' };
  if (parsed.runtime_id !== SUPPORTED_RUNTIME_ID) return { ok: false, reason: 'invalid_runtime_id' };
  if (typeof parsed.campaign_id !== 'string' || !CAMPAIGN_ID_RE.test(parsed.campaign_id)) {
    return { ok: false, reason: 'invalid_campaign_id' };
  }
  if (!PLATFORM_VALUES.includes(parsed.platform)) return { ok: false, reason: 'invalid_platform' };
  if (!BOUNDARY_KIND_VALUES.includes(parsed.boundary_kind)) return { ok: false, reason: 'invalid_boundary_kind' };
  if (parsed.network_mode !== 'restricted') return { ok: false, reason: 'invalid_network_mode' };
  if (parsed.workspace_scope !== 'campaign-only') return { ok: false, reason: 'invalid_workspace_scope' };
  if (parsed.runtime_credential_scope !== 'runtime-only') return { ok: false, reason: 'invalid_runtime_credential_scope' };
  // Every one of these 4 is a required EXACT literal, not merely boolean-typed -- an attestation
  // claiming the unsafe value (e.g. normal_maintainer_home_mounted:true) is exactly the case this
  // loader exists to reject, never a structurally-valid-but-unsafe declaration.
  if (parsed.normal_maintainer_home_mounted !== false) return { ok: false, reason: 'invalid_safety_claim' };
  if (parsed.ambient_secrets_present !== false) return { ok: false, reason: 'invalid_safety_claim' };
  if (parsed.disposable_home !== true) return { ok: false, reason: 'invalid_safety_claim' };
  if (parsed.rollback_or_destroy_required !== true) return { ok: false, reason: 'invalid_safety_claim' };
  if (typeof parsed.harness_sha !== 'string' || !HARNESS_SHA_RE.test(parsed.harness_sha)) {
    return { ok: false, reason: 'invalid_harness_sha' };
  }
  if (!isValidTimestamp(parsed.created_at)) return { ok: false, reason: 'invalid_timestamp' };
  if (!isValidTimestamp(parsed.expires_at)) return { ok: false, reason: 'invalid_timestamp' };

  // Cross-checks against the ACTUAL resolved selection/platform/harness for this invocation -- a
  // single shared reason code for all 5 comparisons (never revealing WHICH field mismatched) stays
  // consistent with this module's own closed-error discipline.
  if (
    parsed.profile_id !== expected.profileId || parsed.runtime_id !== expected.runtimeId
    || parsed.platform !== expected.platform || parsed.network_mode !== expected.networkMode
    || parsed.harness_sha !== expected.harnessSha
  ) {
    return { ok: false, reason: 'context_mismatch' };
  }

  const nowMs = now.getTime();
  const createdMs = Date.parse(parsed.created_at);
  const expiresMs = Date.parse(parsed.expires_at);
  if (createdMs > nowMs + CLOCK_SKEW_FORWARD_MS) return { ok: false, reason: 'created_at_in_future' };
  if (expiresMs <= nowMs) return { ok: false, reason: 'expired' };
  if (expiresMs <= createdMs) return { ok: false, reason: 'non_positive_interval' };
  if (expiresMs - createdMs > MAX_INTERVAL_MS) return { ok: false, reason: 'interval_too_long' };

  return { ok: true, schema: 1, sha256: canonicalJsonSha256(parsed) };
}

export { ATTESTATION_KEYS, SUPPORTED_PROFILE_ID, SUPPORTED_RUNTIME_ID };
