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

// Compose-friendly: returns ANDROID_HOME augmented onto `env` when (a) the
// caller's env doesn't already have it set, AND (b) the project doesn't
// supply sdk.dir via local.properties, AND (c) we found a valid SDK on
// disk. Otherwise returns env unchanged. Mirrors the JDK auto-select
// signal-emission pattern (NOTICE log lines).
export function maybeAugmentEnvWithAndroidSdk(projectRoot, env, log = () => {}) {
  // Already-set ANDROID_HOME wins (user explicitly chose).
  if (env.ANDROID_HOME) return env;
  if (env.ANDROID_SDK_ROOT) return env;  // legacy AGP fallback
  // Project supplies sdk.dir → gradle reads local.properties directly.
  if (projectHasSdkDir(projectRoot)) return env;
  const sdkPath = discoverAndroidSdk();
  if (!sdkPath) return env;
  log(`[NOTICE] auto-setting ANDROID_HOME=${sdkPath} (Android SDK discovered; ANDROID_HOME unset and no sdk.dir in local.properties)`);
  return { ...env, ANDROID_HOME: sdkPath, ANDROID_SDK_ROOT: sdkPath };
}
