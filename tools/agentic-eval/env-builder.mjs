#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/env-builder.mjs -- narrow, allowlist-only environment construction for
// measured claude sessions (Round 4 fix #7 / Round 6 evidence).
//
// Ported verbatim (logic unchanged) from the Step-1 gate scratch probe, where it was verified
// empirically on Windows: a real `claude -p` session authenticates fine with ZERO of HOME/
// USERPROFILE/APPDATA present there -- OAuth resolves via the OS credential store, not env-based
// config. On macOS this assumption was falsified by a live canary: with HOME stripped, `claude`
// failed to authenticate; restoring HOME resolved it. The exact internal mechanism (whether/how
// Claude Code reaches the OS keychain via HOME) is not established -- only that preserving HOME
// resolves the observed macOS failure. HOME is therefore preserved on macOS only (see
// buildEvalEnv's `platform` option below); Windows behavior is unchanged, and there is no
// evidence either way for other platforms. Only explicitly-named variables ever pass through;
// anything else (including every CLAUDE*-prefixed nested-session variable) is dropped by
// construction, never by a denylist alone.
//
// A later macOS full-corpus canary (Stage A zero-live auth preflight, run against this exact
// harness/base SHA) found HOME alone insufficient: with HOME present but USER absent, `claude
// auth status` still reported loggedIn:false. Bisected empirically on that host: HOME+PATH+
// SHELL+LANG+LC_CTYPE alone fails; adding USER succeeds; substituting LOGNAME for USER does not
// -- USER specifically is required, not merely "some username-shaped variable". As with HOME, the
// exact internal mechanism is not established -- only that preserving USER alongside HOME
// resolves the observed failure. USER is therefore preserved on macOS only, alongside HOME;
// LOGNAME/USERPROFILE/APPDATA/XDG_* remain excluded everywhere -- there is no evidence any of
// them are needed.
//
// Case-insensitive matching is required: git-bash/MSYS normalizes Windows env var names to
// UPPERCASE (SYSTEMROOT, COMSPEC, WINDIR) while native cmd/PowerShell keep mixed case
// (SystemRoot, ComSpec, windir) -- confirmed empirically on this machine.

const ALLOWED_NAMES = [
  // OS essentials (Windows)
  'SystemRoot', 'ComSpec', 'PATHEXT', 'windir', 'OS', 'PROCESSOR_ARCHITECTURE',
  // OS essentials (POSIX, harmless to include even when unset on Windows)
  'SHELL',
  // PATH -- base value only; callers prepend a shim dir on top, never here
  'PATH', 'Path',
  // locale
  'LANG', 'LC_ALL', 'LC_CTYPE',
  // temp
  'TEMP', 'TMP', 'TMPDIR',
  // Java (Gradle/kmp-test needs this)
  'JAVA_HOME',
  // Android (some scenarios may need it)
  'ANDROID_HOME', 'ANDROID_SDK_ROOT',
];

const SECRET_SHAPE_RE = /(_TOKEN|_KEY|_SECRET|_PASSWORD|_CREDENTIAL)$/i;
const CLOUD_CRED_NAMES = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN',
]);

/**
 * @param {NodeJS.ProcessEnv} sourceEnv
 * @param {{extraAllowed?: string[], platform?: string}} [opts] - `platform` defaults to
 *   `process.platform`; only ever used to decide whether HOME and USER join the allowlist (macOS
 *   only -- see this file's header comment). Injectable for deterministic cross-platform tests.
 * @returns {NodeJS.ProcessEnv}
 */
export function buildEvalEnv(sourceEnv, { extraAllowed = [], platform = process.platform } = {}) {
  const platformAllowed = platform === 'darwin' ? ['HOME', 'USER'] : [];
  const allowedLower = new Set([...ALLOWED_NAMES, ...platformAllowed, ...extraAllowed].map((k) => k.toLowerCase()));
  const out = {};
  for (const key of Object.keys(sourceEnv)) {
    if (!allowedLower.has(key.toLowerCase())) continue;
    if (SECRET_SHAPE_RE.test(key)) continue; // defense in depth even against the allowlist
    if (CLOUD_CRED_NAMES.has(key.toUpperCase())) continue;
    const value = sourceEnv[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export { ALLOWED_NAMES, SECRET_SHAPE_RE, CLOUD_CRED_NAMES };
