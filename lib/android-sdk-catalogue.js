// SPDX-License-Identifier: MIT
// lib/android-sdk-catalogue.js — discover the Android SDK on the host so
// kmp-test can auto-set ANDROID_HOME for the spawned gradle process when
// (a) the project has Android modules, (b) `local.properties` is missing
// or doesn't set `sdk.dir`, and (c) the user's environment doesn't carry
// ANDROID_HOME. Mirrors the JDK auto-select pattern in lib/jdk-catalogue.js.
//
// 2026-05-03 — surfaced by Confetti + PeopleInSpace wide-smoke. Both repos
// were freshly downloaded (no `local.properties` — that file is typically
// gitignored) and the user's shell didn't export ANDROID_HOME. Pre-fix the
// CLI dispatched gradle which aborted with `SDK location not found`. The
// SDK exists on disk at the canonical location; auto-set is the right UX.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Canonical install paths per Android Studio per platform. The directory
// must contain a `platforms/` subdir (or at least `build-tools/` /
// `cmdline-tools/`) to count as a real SDK install.
function candidatePaths() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(local, 'Android', 'Sdk'),
      path.join(local, 'Android', 'sdk'),
      'C:\\Android\\Sdk',
      'C:\\Android\\sdk',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      path.join(os.homedir(), 'Library', 'Android', 'sdk'),
      path.join(os.homedir(), 'Android', 'Sdk'),
      '/usr/local/share/android-sdk',
      '/opt/homebrew/share/android-sdk',
    ];
  }
  // linux + other unix
  return [
    path.join(os.homedir(), 'Android', 'Sdk'),
    path.join(os.homedir(), 'Android', 'sdk'),
    '/usr/lib/android-sdk',
    '/opt/android-sdk',
    '/opt/android-sdk-linux',
  ];
}

// Validate that a path looks like a real SDK install. Build-tools, platforms,
// or cmdline-tools subdirs are the canonical markers — Android Studio
// installations always have at least one. Returns true on first match.
function isValidSdkPath(p) {
  if (!p || !existsSync(p)) return false;
  return existsSync(path.join(p, 'platforms')) ||
         existsSync(path.join(p, 'build-tools')) ||
         existsSync(path.join(p, 'cmdline-tools'));
}

// Returns the first valid SDK path found, or null. Pure function — no env
// reads beyond home-dir resolution. Tests can invoke directly.
export function discoverAndroidSdk() {
  for (const p of candidatePaths()) {
    if (isValidSdkPath(p)) return p;
  }
  return null;
}

// True when the project root has a `local.properties` that declares
// `sdk.dir=...`. The bash/ps1 escaping rules differ across platforms; we
// just look for the `sdk.dir` key presence, content uninspected.
export function projectHasSdkDir(projectRoot) {
  const file = path.join(projectRoot, 'local.properties');
  if (!existsSync(file)) return false;
  try {
    const content = readFileSync(file, 'utf8');
    return /^\s*sdk\.dir\s*=\s*\S/m.test(content);
  } catch {
    return false;
  }
}

// Read & validate the `sdk.dir` value declared in `local.properties`.
// Returns one of:
//   { ok: true,  path }                — sdk.dir present, resolves to existing dir
//   { ok: false, reason, path, raw }   — sdk.dir present but invalid (path missing OR escape malformed)
//   null                               — no local.properties OR no sdk.dir line
//
// Why this matters: malformed Java Properties escapes in sdk.dir cause AGP's
// SdkLocator.validateSdkPath() to throw `java.io.IOException` BEFORE falling
// back to ANDROID_HOME. Common mistake: `sdk.dir=C\:\Users\X\...` with single
// backslashes (single backslashes are escape characters in Properties syntax;
// `\U`, `\A`, `\L`, etc. are unknown escapes and the parser silently strips
// them). Properly escaped: `sdk.dir=C\:\\Users\\X\\...` OR forward slashes:
// `sdk.dir=C:/Users/X/...` (Java handles both on Windows).
//
// 2026-05-03 — surfaced when an earlier debug heredoc wrote a malformed
// local.properties that blocked Confetti's :androidApp dispatch even though
// ANDROID_HOME was set correctly.
export function inspectLocalProperties(projectRoot) {
  const file = path.join(projectRoot, 'local.properties');
  if (!existsSync(file)) return null;
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { return null; }
  const m = content.match(/^\s*sdk\.dir\s*=\s*(.+?)\s*$/m);
  if (!m) return null;
  const raw = m[1];
  // Java Properties unescape: `\\` → `\`, `\:` → `:`, `\n`/`\r`/`\t` → control,
  // `\u####` → unicode, anything else `\X` → `X` (the leading backslash is
  // dropped). This means `C\:\Users\34645\AppData\Local\Android\Sdk` becomes
  // `C:Users34645AppDataLocalAndroidSdk` — an invalid path. Detect by
  // checking the resolved path exists.
  let resolved = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '\\')      { resolved += '\\'; i++; }
      else if (next === ':')  { resolved += ':';  i++; }
      else if (next === 'n')  { resolved += '\n'; i++; }
      else if (next === 'r')  { resolved += '\r'; i++; }
      else if (next === 't')  { resolved += '\t'; i++; }
      else if (next === 'u' && i + 5 < raw.length) {
        resolved += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 5;
      }
      else { resolved += next; i++; }  // unknown escape — drop the backslash
    } else {
      resolved += raw[i];
    }
  }
  // Also normalize forward slashes to native separator for the existence check
  // (Java accepts both on Windows; existsSync also accepts both, but be safe).
  const normalizedResolved = process.platform === 'win32' ? resolved.replace(/\//g, '\\') : resolved;
  if (existsSync(normalizedResolved)) {
    return { ok: true, path: resolved };
  }
  // Diagnose the most common failure shape — single backslashes producing
  // unknown-escape stripping that yields a path missing path separators.
  const looksMalformedEscape = /\\[A-Za-z]/.test(raw) && !/\\\\|\//.test(raw);
  const reason = looksMalformedEscape
    ? 'malformed Properties escapes (single backslashes); use C:/path or C\\\\:\\\\path'
    : 'sdk.dir path does not exist on disk';
  return { ok: false, reason, path: resolved, raw };
}

// Compose-friendly: returns env augmented with ANDROID_HOME +
// ANDROID_SDK_ROOT + PATH (prepended with `${sdkPath}/platform-tools`)
// when the SDK can be discovered and the caller's env doesn't already
// have ANDROID_HOME set.
//
// SDK discovery order (first match wins):
//   1. local.properties sdk.dir — project-supplied
//   2. canonical install paths (Android Studio default)
//
// Why both: gradle handles (1) directly via SdkLocator, but the Node-side
// `defaultAdbProbe` (lib/orchestrator-utils.js) calls `spawnSync('adb',
// ['devices', '-l'])` from PATH. When ANDROID_HOME is unset AND PATH
// doesn't contain `${SDK}/platform-tools` (common on Windows shells
// without manual config), the auto-set of ANDROID_HOME wasn't enough —
// adb still ENOENT'd, every instrumented path returned
// `instrumented_setup_failed` despite a connected device. Surfaced
// 2026-05-09 on shared-kmp-libs wet-audit (local.properties had
// `sdk.dir`, but the `projectHasSdkDir` check early-returned env
// unchanged → adb couldn't be located by the orchestrator's Node code).
//
// Mirrors the JDK auto-select signal-emission pattern (NOTICE log lines).
export function maybeAugmentEnvWithAndroidSdk(projectRoot, env, log = () => {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const existingPath = env.PATH || env.Path || '';

  // Branch 1 — user has set ANDROID_HOME (or legacy ANDROID_SDK_ROOT)
  // explicitly. Respect the choice; do NOT override. But check defensively
  // if `${SDK}/platform-tools` is on PATH; if not, prepend it so the
  // orchestrator's Node-side adb probe still works (OBS-D from 2026-05-09
  // wet-audit). Only kicks in when the path actually exists — bail
  // silently for misconfigured ANDROID_HOME so the user gets the existing
  // failure path with their own diagnostic instead of a confusing fallback.
  const userSdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (userSdk) {
    if (!existsSync(userSdk)) return env;
    const userPlatformTools = path.join(userSdk, 'platform-tools');
    if (pathContainsDir(existingPath, userPlatformTools, sep)) return env;
    log(`[NOTICE] prepending ${userPlatformTools} to PATH (ANDROID_HOME set but platform-tools not on PATH; defensive augmentation for adb discovery)`);
    const augmentedPath = existingPath
      ? `${userPlatformTools}${sep}${existingPath}`
      : userPlatformTools;
    return { ...env, PATH: augmentedPath };
  }

  // Branch 2 — ANDROID_HOME unset. Discover the SDK from local.properties
  // or canonical install paths and auto-set BOTH the env vars and PATH.
  let sdkPath = null;
  let source = null;

  // (a) Project-supplied sdk.dir via local.properties.
  const lpRes = inspectLocalProperties(projectRoot);
  if (lpRes && lpRes.ok) {
    sdkPath = path.normalize(lpRes.path);
    source = 'local.properties';
  }

  // (b) Canonical-install-paths auto-discovery.
  if (!sdkPath) {
    const discovered = discoverAndroidSdk();
    if (discovered) { sdkPath = discovered; source = 'auto-discover'; }
  }

  if (!sdkPath) return env;

  if (source === 'auto-discover') {
    log(`[NOTICE] auto-setting ANDROID_HOME=${sdkPath} (Android SDK discovered; ANDROID_HOME unset and no sdk.dir in local.properties)`);
  } else {
    log(`[NOTICE] auto-setting ANDROID_HOME=${sdkPath} (read from local.properties sdk.dir; ANDROID_HOME unset)`);
  }

  // Prepend platform-tools to PATH so transitive child-process invocations
  // of `adb` succeed under the augmented env.
  const platformTools = path.join(sdkPath, 'platform-tools');
  const augmentedPath = existingPath
    ? `${platformTools}${sep}${existingPath}`
    : platformTools;

  return {
    ...env,
    ANDROID_HOME: sdkPath,
    ANDROID_SDK_ROOT: sdkPath,
    PATH: augmentedPath,
  };
}

// Case-aware path-segment check. Windows path comparisons are
// case-insensitive; Unix uses exact match. The check normalizes each
// segment via path.normalize before comparing.
function pathContainsDir(pathStr, target, sep) {
  if (!pathStr || !target) return false;
  const normalizedTarget = path.normalize(target);
  const matches = process.platform === 'win32'
    ? (s) => path.normalize(s).toLowerCase() === normalizedTarget.toLowerCase()
    : (s) => path.normalize(s) === normalizedTarget;
  return pathStr.split(sep).some(seg => seg && matches(seg));
}
