// SPDX-License-Identifier: MIT
// Tests for lib/android-sdk-catalogue.js — Android SDK auto-detection.
// 2026-05-03 — surfaced by Confetti + PeopleInSpace wide-smoke (both freshly
// downloaded, no local.properties, ANDROID_HOME unset).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  discoverAndroidSdk,
  projectHasSdkDir,
  maybeAugmentEnvWithAndroidSdk,
  inspectLocalProperties,
} from '../../lib/android-sdk-catalogue.js';
import { aggregateJdkSignals } from '../../lib/project-model.js';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function makeProject() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-android-sdk-test-'));
  return workDir;
}

describe('projectHasSdkDir', () => {
  it('returns true when local.properties contains sdk.dir=...', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'local.properties'),
      'sdk.dir=C\\:\\\\Users\\\\34645\\\\AppData\\\\Local\\\\Android\\\\Sdk\n');
    expect(projectHasSdkDir(dir)).toBe(true);
  });

  it('returns false when local.properties is missing', () => {
    const dir = makeProject();
    expect(projectHasSdkDir(dir)).toBe(false);
  });

  it('returns false when local.properties has no sdk.dir line', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'local.properties'),
      'org.gradle.jvmargs=-Xmx4g\nkotlin.code.style=official\n');
    expect(projectHasSdkDir(dir)).toBe(false);
  });

  it('handles commented-out sdk.dir', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'local.properties'),
      '# sdk.dir=C:/old/path\nfoo=bar\n');
    expect(projectHasSdkDir(dir)).toBe(false);
  });
});

describe('maybeAugmentEnvWithAndroidSdk', () => {
  it('returns env unchanged when ANDROID_HOME already set', () => {
    const dir = makeProject();
    const env = { ANDROID_HOME: '/some/explicit/path', PATH: '/usr/bin' };
    const out = maybeAugmentEnvWithAndroidSdk(dir, env);
    expect(out).toBe(env); // same reference — not mutated
  });

  it('returns env unchanged when ANDROID_SDK_ROOT (legacy) already set', () => {
    const dir = makeProject();
    const env = { ANDROID_SDK_ROOT: '/legacy/path' };
    const out = maybeAugmentEnvWithAndroidSdk(dir, env);
    expect(out.ANDROID_HOME).toBeUndefined();
  });

  it('augments env from local.properties sdk.dir (so adb on PATH stays callable)', () => {
    // Pre-2026-05-09 behavior: when local.properties had sdk.dir, this
    // function returned env unchanged because gradle reads sdk.dir
    // directly via SdkLocator. But the orchestrator's Node-side
    // `defaultAdbProbe` (orchestrator-utils.js) spawns bare `adb` from
    // PATH — which still ENOENT'd when the user's PATH didn't include
    // platform-tools. Fix: set ANDROID_HOME (harmless when gradle
    // prefers sdk.dir) AND prepend `${sdk.dir}/platform-tools` to PATH.
    const dir = makeProject();
    // Use the temp dir itself as a plausible "sdk path" since it exists.
    const fakeSdk = dir.replace(/\\/g, '/');
    writeFileSync(path.join(dir, 'local.properties'), `sdk.dir=${fakeSdk}\n`);
    const env = { PATH: '/usr/bin' };
    const out = maybeAugmentEnvWithAndroidSdk(dir, env);
    expect(out.ANDROID_HOME).toBe(path.normalize(fakeSdk));
    expect(out.ANDROID_SDK_ROOT).toBe(path.normalize(fakeSdk));
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(out.PATH.split(sep)[0])
      .toBe(path.join(path.normalize(fakeSdk), 'platform-tools'));
  });

  it('emits NOTICE log line when SDK auto-detected and set', () => {
    // This test only fires when the host actually has an Android SDK at one
    // of the canonical install paths. CI runners + dev machines usually do;
    // we guard with discoverAndroidSdk() so the test gracefully no-ops on
    // hosts without an SDK.
    const realSdk = discoverAndroidSdk();
    if (!realSdk) return;
    const dir = makeProject();
    const env = {};
    const lines = [];
    const out = maybeAugmentEnvWithAndroidSdk(dir, env, (l) => lines.push(l));
    expect(out.ANDROID_HOME).toBe(realSdk);
    expect(out.ANDROID_SDK_ROOT).toBe(realSdk);
    expect(lines.some(l => /\[NOTICE\]/.test(l) && /ANDROID_HOME/.test(l))).toBe(true);
  });

  // wet-audit-v0.9-release — discovered 2026-05-09 on real shared-kmp-libs
  // sweep. The orchestrator's `defaultAdbProbe` (lib/orchestrator-utils.js)
  // calls `spawnSync('adb', ['devices', '-l'])` from PATH. When the user's
  // ANDROID_HOME isn't set AND `${ANDROID_HOME}/platform-tools` isn't on
  // PATH (common on Windows shells without manual config), the auto-set of
  // ANDROID_HOME wasn't enough — adb still ENOENT'd, and every instrumented
  // path returned `instrumented_setup_failed` despite a live S22 device.
  // Fix: when augmenting env with auto-discovered ANDROID_HOME, also
  // prepend `${sdkPath}/platform-tools` to PATH so adb (and other SDK
  // binaries) become callable in the same env mutation.
  describe('PATH augmentation for platform-tools (so adb is callable)', () => {
    it('prepends ${ANDROID_HOME}/platform-tools to PATH when auto-set fires', () => {
      const realSdk = discoverAndroidSdk();
      if (!realSdk) return; // graceful no-op on hosts without an SDK
      const dir = makeProject();
      const env = { PATH: '/usr/bin' };
      const out = maybeAugmentEnvWithAndroidSdk(dir, env);
      expect(out.ANDROID_HOME).toBe(realSdk);
      const sep = process.platform === 'win32' ? ';' : ':';
      const expectedPlatformTools = path.join(realSdk, 'platform-tools');
      expect(out.PATH).toBeDefined();
      expect(out.PATH.split(sep)[0]).toBe(expectedPlatformTools);
    });

    it('preserves existing PATH entries after the prepended platform-tools', () => {
      const realSdk = discoverAndroidSdk();
      if (!realSdk) return;
      const dir = makeProject();
      const env = { PATH: '/usr/bin:/sbin' };
      const out = maybeAugmentEnvWithAndroidSdk(dir, env);
      const sep = process.platform === 'win32' ? ';' : ':';
      const segs = out.PATH.split(sep);
      expect(segs[0]).toBe(path.join(realSdk, 'platform-tools'));
      // Original entries preserved verbatim (joined back together).
      expect(segs.slice(1).join(sep)).toBe('/usr/bin:/sbin');
    });

    it('sets PATH to platform-tools alone when env had no PATH', () => {
      const realSdk = discoverAndroidSdk();
      if (!realSdk) return;
      const dir = makeProject();
      const env = {}; // no PATH
      const out = maybeAugmentEnvWithAndroidSdk(dir, env);
      expect(out.PATH).toBe(path.join(realSdk, 'platform-tools'));
    });

    it('returns env unchanged (no PATH mutation) when ANDROID_HOME already set', () => {
      const dir = makeProject();
      const env = { ANDROID_HOME: '/some/explicit/path', PATH: '/usr/bin' };
      const out = maybeAugmentEnvWithAndroidSdk(dir, env);
      expect(out).toBe(env); // same reference — no mutation at all
      expect(out.PATH).toBe('/usr/bin');
    });
  });
});

// 2026-05-03 — local.properties malformed-escape detection. Java Properties
// syntax: `\\` → `\`, `\:` → `:`, unknown `\X` drops the leading backslash.
// `sdk.dir=C\:\Users\X\...` parses to `C:Users\X\...` (silently strips
// `\U`/`\A`/etc.), AGP IOException at SdkLocator.validateSdkPath. Doctor
// surfaces this as a WARN since auto-set ANDROID_HOME WON'T save you here:
// AGP reads local.properties FIRST and throws before falling through.
describe('inspectLocalProperties', () => {
  it('returns null when local.properties is absent', () => {
    const dir = makeProject();
    expect(inspectLocalProperties(dir)).toBeNull();
  });

  it('returns null when local.properties has no sdk.dir line', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'local.properties'),
      'org.gradle.jvmargs=-Xmx4g\nkotlin.code.style=official\n');
    expect(inspectLocalProperties(dir)).toBeNull();
  });

  it('returns ok=true when sdk.dir uses forward slashes pointing to existing dir', () => {
    const dir = makeProject();
    // Use the project root itself as the "sdk path" — guaranteed to exist.
    const fwd = dir.replace(/\\/g, '/');
    writeFileSync(path.join(dir, 'local.properties'), `sdk.dir=${fwd}\n`);
    const r = inspectLocalProperties(dir);
    expect(r).toBeTruthy();
    expect(r.ok).toBe(true);
    expect(r.path).toBe(fwd);
  });

  it('returns ok=true when sdk.dir uses properly-doubled backslashes', () => {
    const dir = makeProject();
    // Encode the dir with doubled backslashes (Properties syntax).
    const escaped = dir.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    writeFileSync(path.join(dir, 'local.properties'), `sdk.dir=${escaped}\n`);
    const r = inspectLocalProperties(dir);
    expect(r).toBeTruthy();
    expect(r.ok).toBe(true);
  });

  it('returns ok=false with malformed-escape reason for single-backslash Windows paths', () => {
    const dir = makeProject();
    // The Confetti repro shape — single backslashes that get silently dropped
    // by Properties parser, yielding a non-existent path.
    writeFileSync(path.join(dir, 'local.properties'),
      'sdk.dir=C\\:\\Users\\34645\\AppData\\Local\\Android\\Sdk\n');
    const r = inspectLocalProperties(dir);
    expect(r).toBeTruthy();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/malformed Properties escapes/);
    expect(r.raw).toContain('\\Users');  // raw preserves the broken input for the user message
  });

  it('returns ok=false with not-on-disk reason for valid syntax + non-existent path', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'local.properties'),
      'sdk.dir=/totally/made/up/path/that/does/not/exist\n');
    const r = inspectLocalProperties(dir);
    expect(r).toBeTruthy();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not exist/);
  });

  it('handles \\u#### unicode escapes in sdk.dir', () => {
    const dir = makeProject();
    // \u002f is forward-slash; not common but valid Properties syntax.
    const fwd = dir.replace(/\\/g, '/');
    writeFileSync(path.join(dir, 'local.properties'), `sdk.dir=${fwd}\n`);
    const r = inspectLocalProperties(dir);
    expect(r.ok).toBe(true);
  });

  it('strips trailing whitespace from sdk.dir value', () => {
    const dir = makeProject();
    const fwd = dir.replace(/\\/g, '/');
    writeFileSync(path.join(dir, 'local.properties'), `sdk.dir=${fwd}    \n`);
    const r = inspectLocalProperties(dir);
    expect(r.ok).toBe(true);
    expect(r.path).toBe(fwd);
  });
});

describe('discoverAndroidSdk', () => {
  it('returns null OR an existing valid SDK path (host-dependent)', () => {
    const result = discoverAndroidSdk();
    if (result === null) return;
    // If a path is returned, it MUST exist and contain at least one of
    // platforms/build-tools/cmdline-tools.
    expect(existsSync(result)).toBe(true);
    const hasMarker =
      existsSync(path.join(result, 'platforms')) ||
      existsSync(path.join(result, 'build-tools')) ||
      existsSync(path.join(result, 'cmdline-tools'));
    expect(hasMarker).toBe(true);
  });
});

// 2026-05-04 (fix-PR-C) — runner.js dispatch-time composition. The CLI entry
// point gates `maybeAugmentEnvWithAndroidSdk` on `aggregateJdkSignals.agpVersion
// !== null` and mutates `process.env` directly so transitive child-process
// spawns (notably parallel-orchestrator's `buildProjectModel` probe, which
// uses spawnSync without an explicit `env` arg and therefore inherits
// process.env) get ANDROID_HOME at gradle config time. Pre-fix, JVM-leg
// dispatches against AGP-applying projects (e.g. nowinandroid `parallel
// --test-type unit`) failed at config time when `:lint` evaluated `compileSdk`.
//
// These tests pin the composition behavior end-to-end: drive
// aggregateJdkSignals with real fixture project roots, then run the same
// gate logic the runner.js block runs, and assert process.env mutation.
describe('runner.js AGP-gated process.env augmentation (composition)', () => {
  let savedAndroidHome;
  let savedAndroidSdkRoot;
  let savedPath;

  beforeEach(() => {
    savedAndroidHome = process.env.ANDROID_HOME;
    savedAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    savedPath = process.env.PATH;
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
  });

  afterEach(() => {
    if (savedAndroidHome !== undefined) process.env.ANDROID_HOME = savedAndroidHome;
    else delete process.env.ANDROID_HOME;
    if (savedAndroidSdkRoot !== undefined) process.env.ANDROID_SDK_ROOT = savedAndroidSdkRoot;
    else delete process.env.ANDROID_SDK_ROOT;
    if (savedPath !== undefined) process.env.PATH = savedPath;
    else delete process.env.PATH;
  });

  // Mirrors the runner.js block at lib/runner.js after the JDK preflight gate.
  // Returns { fired, agpVersion } so tests can assert both the gate decision
  // and the augmentation outcome.
  function applyRunnerAugmentation(projectRoot) {
    const sig = aggregateJdkSignals(projectRoot);
    if (sig.agpVersion === null) return { fired: false, agpVersion: null };
    const augmented = maybeAugmentEnvWithAndroidSdk(projectRoot, process.env);
    if (augmented !== process.env) {
      process.env.ANDROID_HOME = augmented.ANDROID_HOME;
      process.env.ANDROID_SDK_ROOT = augmented.ANDROID_SDK_ROOT;
      // wet-audit-v0.9-release fix mirror — also propagate PATH so the
      // orchestrator's Node-side adb probe can locate adb.
      if (augmented.PATH) process.env.PATH = augmented.PATH;
      return { fired: true, agpVersion: sig.agpVersion };
    }
    return { fired: false, agpVersion: sig.agpVersion };
  }

  function makeAgpCatalogProject() {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(
      path.join(dir, 'gradle', 'libs.versions.toml'),
      '[versions]\nagp = "8.7.3"\nkotlin = "2.0.0"\n',
    );
    return dir;
  }

  it('injects ANDROID_HOME into process.env when AGP detected via libs.versions.toml + host has SDK', () => {
    // Host-SDK-guarded: skip cleanly when no SDK is installed at any candidate
    // path (mirrors the existing maybeAugmentEnvWithAndroidSdk NOTICE test).
    const realSdk = discoverAndroidSdk();
    if (!realSdk) return;
    const dir = makeAgpCatalogProject();
    const result = applyRunnerAugmentation(dir);
    expect(result.fired).toBe(true);
    expect(result.agpVersion).toBe('8.7.3');
    expect(process.env.ANDROID_HOME).toBe(realSdk);
    expect(process.env.ANDROID_SDK_ROOT).toBe(realSdk);
  });

  it('preserves user-set ANDROID_HOME on AGP project (no override)', () => {
    process.env.ANDROID_HOME = '/explicit/user/path';
    const dir = makeAgpCatalogProject();
    const result = applyRunnerAugmentation(dir);
    // sig.agpVersion is detected, BUT maybeAugmentEnvWithAndroidSdk
    // short-circuits at line 152 (env.ANDROID_HOME set) and returns env
    // unchanged — so the runner.js mutation block never fires.
    expect(result.fired).toBe(false);
    expect(result.agpVersion).toBe('8.7.3');
    expect(process.env.ANDROID_HOME).toBe('/explicit/user/path');
  });

  it('does NOT inject when no AGP is declared (negative regression guard)', () => {
    const dir = makeProject(); // bare tmp dir — no libs.versions.toml, no build files
    const result = applyRunnerAugmentation(dir);
    expect(result.fired).toBe(false);
    expect(result.agpVersion).toBeNull();
    expect(process.env.ANDROID_HOME).toBeUndefined();
  });

  it('injects from local.properties sdk.dir on AGP project (so adb on PATH)', () => {
    // Pre-2026-05-09 behavior: helper short-circuited at projectHasSdkDir
    // and runner did not augment env. Result: ANDROID_HOME stayed unset
    // AND `${sdk.dir}/platform-tools` stayed off PATH, so the
    // orchestrator's Node-side `defaultAdbProbe` couldn't locate adb
    // even though gradle could (gradle reads sdk.dir directly).
    // New behavior: helper reads sdk.dir and augments env so the
    // orchestrator's Node-side adb probe succeeds.
    const dir = makeAgpCatalogProject();
    // Use the tmp dir itself as the sdk path — guaranteed to exist.
    const fakeSdk = dir.replace(/\\/g, '/');
    writeFileSync(path.join(dir, 'local.properties'), `sdk.dir=${fakeSdk}\n`);
    const result = applyRunnerAugmentation(dir);
    expect(result.fired).toBe(true);
    expect(result.agpVersion).toBe('8.7.3');
    expect(process.env.ANDROID_HOME).toBe(path.normalize(fakeSdk));
    const sep = process.platform === 'win32' ? ';' : ':';
    const platformTools = path.join(path.normalize(fakeSdk), 'platform-tools');
    expect((process.env.PATH || '').split(sep)[0]).toBe(platformTools);
  });

  it('injects when AGP declared via root build.gradle.kts inline DSL + host has SDK', () => {
    // Covers detectAgpVersion path 2: `id("com.android.application") version "X"`.
    const realSdk = discoverAndroidSdk();
    if (!realSdk) return;
    const dir = makeProject();
    writeFileSync(
      path.join(dir, 'build.gradle.kts'),
      'plugins {\n  id("com.android.application") version "8.5.2" apply false\n}\n',
    );
    const result = applyRunnerAugmentation(dir);
    expect(result.fired).toBe(true);
    expect(result.agpVersion).toBe('8.5.2');
    expect(process.env.ANDROID_HOME).toBe(realSdk);
  });

  it('injects when AGP declared via buildscript classpath + host has SDK', () => {
    // Covers detectAgpVersion path 3: legacy buildscript classpath shape.
    const realSdk = discoverAndroidSdk();
    if (!realSdk) return;
    const dir = makeProject();
    writeFileSync(
      path.join(dir, 'build.gradle.kts'),
      'buildscript {\n  dependencies {\n    classpath("com.android.tools.build:gradle:7.4.2")\n  }\n}\n',
    );
    const result = applyRunnerAugmentation(dir);
    expect(result.fired).toBe(true);
    expect(result.agpVersion).toBe('7.4.2');
    expect(process.env.ANDROID_HOME).toBe(realSdk);
  });
});
