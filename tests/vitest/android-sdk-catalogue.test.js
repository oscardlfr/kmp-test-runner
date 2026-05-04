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

  it('returns env unchanged when project has sdk.dir in local.properties', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'local.properties'), 'sdk.dir=C:/foo\n');
    const env = {};
    const out = maybeAugmentEnvWithAndroidSdk(dir, env);
    expect(out.ANDROID_HOME).toBeUndefined();
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

  beforeEach(() => {
    savedAndroidHome = process.env.ANDROID_HOME;
    savedAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
  });

  afterEach(() => {
    if (savedAndroidHome !== undefined) process.env.ANDROID_HOME = savedAndroidHome;
    else delete process.env.ANDROID_HOME;
    if (savedAndroidSdkRoot !== undefined) process.env.ANDROID_SDK_ROOT = savedAndroidSdkRoot;
    else delete process.env.ANDROID_SDK_ROOT;
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

  it('does NOT inject when AGP project has sdk.dir in local.properties', () => {
    const dir = makeAgpCatalogProject();
    writeFileSync(path.join(dir, 'local.properties'), 'sdk.dir=C:/some/sdk\n');
    const result = applyRunnerAugmentation(dir);
    // Gate hits (agpVersion !== null) but helper short-circuits at line 155
    // (projectHasSdkDir) — local.properties precedence preserved.
    expect(result.fired).toBe(false);
    expect(result.agpVersion).toBe('8.7.3');
    expect(process.env.ANDROID_HOME).toBeUndefined();
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
