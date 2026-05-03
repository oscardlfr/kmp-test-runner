// SPDX-License-Identifier: MIT
// Tests for lib/android-sdk-catalogue.js — Android SDK auto-detection.
// 2026-05-03 — surfaced by Confetti + PeopleInSpace wide-smoke (both freshly
// downloaded, no local.properties, ANDROID_HOME unset).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  discoverAndroidSdk,
  projectHasSdkDir,
  maybeAugmentEnvWithAndroidSdk,
} from '../../lib/android-sdk-catalogue.js';

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
