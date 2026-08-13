#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/auth-preflight.mjs -- confirms `claude` can actually authenticate BEFORE
// the first live session of an invocation spends anything. Closes the gap a macOS canary
// exposed: env-builder.mjs used to strip HOME unconditionally, `claude auth status` would have
// failed immediately, but nothing checked -- 4 sessions were spent on pre-inference failures that
// still got promoted as normal records.
//
// Reuses spawnCondition verbatim (never a parallel spawn mechanism): the preflight runs through
// the exact same resolveBash/PATH/env `spawnCondition` gives every measured session, so a fake
// `claude` fixture answering `auth status --json` is genuinely testing the real code path, not a
// stand-in for it.
import { spawnCondition } from './condition-launcher.mjs';

/**
 * @param {{sharedEnv: NodeJS.ProcessEnv, repoRoot: string, timeoutMs?: number, spawnFn?: Function}} opts
 *   `spawnFn` is a test-only seam (default: the real `spawnCondition`) for pure unit tests that
 *   fabricate a `{exitCode, terminated, rawStdout}` result without touching the filesystem or
 *   PATH -- no production caller ever passes it, so production behavior is always the real spawn.
 * @returns {Promise<{ok: boolean, terminated: boolean, exitCode: number|null, loggedIn: boolean|null, authMethod: string|null, apiProvider: string|null, subscriptionType: string|null}>}
 */
export async function runAuthPreflight({ sharedEnv, repoRoot, timeoutMs = 15000, spawnFn = spawnCondition } = {}) {
  const spawnResult = await spawnFn(['claude', 'auth', 'status', '--json'], { env: sharedEnv, cwd: repoRoot, timeoutMs });
  let parsed = null;
  try {
    // Root must be a plain object (never an array/primitive) before any field is trusted -- a
    // technically-valid JSON value with an unexpected shape (`[]`, `"ok"`, `42`) must never let a
    // falsy/undefined field read as a real signal.
    const candidate = JSON.parse(spawnResult.rawStdout);
    if (candidate != null && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate;
  } catch { /* fail closed below */ }
  // Each field is validated by its own expected type, never a bare `?? null` -- a `loggedIn`
  // present but non-boolean (e.g. the string "true") must never read as a real signal.
  const loggedIn = typeof parsed?.loggedIn === 'boolean' ? parsed.loggedIn : null;
  const authMethod = typeof parsed?.authMethod === 'string' ? parsed.authMethod : null;
  const apiProvider = typeof parsed?.apiProvider === 'string' ? parsed.apiProvider : null;
  const subscriptionType = typeof parsed?.subscriptionType === 'string' ? parsed.subscriptionType : null;
  // terminated (post-review fix): condition-launcher.mjs's own contract documents exitCode and
  // terminated as INDEPENDENT axes -- a process killed by our own timeout, or by an external
  // signal, can still report exitCode:0 (a race between the kill and the process's own buffered
  // exit, or a binary that traps the signal and exits cleanly regardless). stdout from a run that
  // never reached a normal conclusion must never be trusted, even if it happens to parse as a
  // complete, well-formed {loggedIn:true} response.
  const terminated = spawnResult.terminated !== false;
  const ok = !terminated && spawnResult.exitCode === 0 && loggedIn === true;
  return { ok, terminated, exitCode: spawnResult.exitCode, loggedIn, authMethod, apiProvider, subscriptionType };
}

/**
 * Maps a failed preflight to a closed reason code -- never authMethod/apiProvider/
 * subscriptionType, which come straight from an external binary's JSON and could in principle
 * contain a path/email/secret-shaped string. Exhaustive over the 4 reachable causes: `ok:false`
 * implies either the process never reached a normal conclusion (timeout or an external signal --
 * checked first, since a terminated run's exitCode/loggedIn can never be trusted regardless of
 * what they happen to say), or (a normal conclusion) a nonzero exit code, or (with exitCode 0)
 * `loggedIn` is either `false` (a real, well-formed "not authenticated" signal) or `null` (the
 * response never validly parsed as `{loggedIn: boolean, ...}` in the first place) -- these are
 * different failures with different fixes, so they get different codes.
 * @param {{terminated: boolean, exitCode: number|null, loggedIn: boolean|null}} preflight
 * @returns {'auth_preflight_terminated'|'auth_preflight_nonzero_exit'|'auth_preflight_not_logged_in'|'auth_preflight_invalid_response'}
 */
export function authPreflightReasonCode(preflight) {
  if (preflight.terminated !== false) return 'auth_preflight_terminated';
  if (preflight.exitCode !== 0) return 'auth_preflight_nonzero_exit';
  if (preflight.loggedIn === false) return 'auth_preflight_not_logged_in';
  return 'auth_preflight_invalid_response';
}
