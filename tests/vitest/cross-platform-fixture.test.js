// SPDX-License-Identifier: MIT
// tests/vitest/cross-platform-fixture.test.js — v0.9 step 6.
//
// Asserts the buildable cross-platform KMP fixture under
// tests/fixtures/kmp-cross-platform-e2e/ is correctly parsed by the
// project-model and exposed by `kmp-test describe`. The fixture exercises
// every supported target in a single :sample module:
//
//   jvm, js(IR), wasmJs, iosX64, iosSimulatorArm64, iosArm64, macosArm64,
//   androidLibrary {} (AGP 9 com.android.kotlin.multiplatform.library)
//
// Per-PR CI does NOT execute iOS/macOS test tasks against this fixture —
// real platform validation happens on the manual macOS gate (v0.9 step 7).
// These specs only exercise the static parser path (`--skip-probe`).

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { runSubcommand, REPO_ROOT } from './_parity-helpers.js';
import { buildProjectModel } from '../../lib/project-model.js';

const FIXTURE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'kmp-cross-platform-e2e');

// ---------------------------------------------------------------------------
// Group 1 — Structural integrity
// ---------------------------------------------------------------------------

describe('cross-platform fixture / structural integrity', () => {
  it('fixture root has the gradle wrapper + config files', () => {
    for (const rel of [
      'settings.gradle.kts',
      'gradle.properties',
      'gradle/libs.versions.toml',
      'gradle/wrapper/gradle-wrapper.jar',
      'gradle/wrapper/gradle-wrapper.properties',
      'gradlew',
      'gradlew.bat',
      'sample/build.gradle.kts',
      '.kmp-test-runner.json',
      'README.md',
    ]) {
      expect(existsSync(path.join(FIXTURE_PATH, rel)), `missing fixture file: ${rel}`).toBe(true);
    }
  });

  it('fixture has every per-platform test source set placeholder', () => {
    const sources = path.join(FIXTURE_PATH, 'sample', 'src');
    for (const ss of [
      'commonMain',
      'commonTest',
      'jvmTest',
      'jsTest',
      'wasmJsTest',
      'iosX64Test',
      'iosSimulatorArm64Test',
      'iosArm64Test',
      'macosArm64Test',
      'androidUnitTest',
    ]) {
      const ssPath = path.join(sources, ss);
      expect(existsSync(ssPath), `missing source set dir: ${ss}`).toBe(true);
      expect(statSync(ssPath).isDirectory()).toBe(true);
    }
  });

  it('libs.versions.toml pins Kotlin 2.3.x + AGP 9.x + the new KMP-android plugin alias', () => {
    const toml = path.join(FIXTURE_PATH, 'gradle', 'libs.versions.toml');
    const text = require('node:fs').readFileSync(toml, 'utf8');
    expect(text).toMatch(/kotlin\s*=\s*"2\.3\./);
    expect(text).toMatch(/agp\s*=\s*"9\./);
    expect(text).toContain('com.android.kotlin.multiplatform.library');
  });

  it('gradle wrapper pins gradle 9.1.x', () => {
    const props = path.join(FIXTURE_PATH, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    const text = require('node:fs').readFileSync(props, 'utf8');
    expect(text).toMatch(/gradle-9\.1\./);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — buildProjectModel direct call (skipProbe)
// ---------------------------------------------------------------------------

describe('cross-platform fixture / buildProjectModel (--skip-probe)', () => {
  let model;
  beforeAll(() => {
    model = buildProjectModel(FIXTURE_PATH, { skipProbe: true, useCache: false });
  });

  it('settings.gradle.kts include() resolves to a single :sample module', () => {
    expect(model.settingsIncludes).toEqual([':sample']);
    expect(Object.keys(model.modules)).toEqual([':sample']);
  });

  it(':sample is detected as type=kmp with androidLibrary DSL', () => {
    const m = model.modules[':sample'];
    expect(m.type).toBe('kmp');
    expect(m.androidDsl).toBe('androidLibrary');
    expect(m.androidDslVariant).toBe('kmpAndroidLibrary');
  });

  it('withHostTestBuilder {} opt-in is detected — sourceSets.androidUnitTest=true', () => {
    const m = model.modules[':sample'];
    expect(m.hasHostTestOptIn).toBe(true);
    expect(m.sourceSets.androidUnitTest).toBe(true);
  });

  it('source-set walker detects every per-platform Test directory', () => {
    const ss = model.modules[':sample'].sourceSets;
    for (const platformTest of [
      'commonTest',
      'jvmTest',
      'jsTest',
      'wasmJsTest',
      'iosX64Test',
      'iosSimulatorArm64Test',
      'iosArm64Test',
      'macosArm64Test',
    ]) {
      expect(ss[platformTest], `sourceSets.${platformTest} should be true`).toBe(true);
    }
  });

  it('resolveTasksFor predicts the canonical chain via source-set hints', () => {
    const r = model.modules[':sample'].resolved;
    expect(r.unitTestTask).toBe('jvmTest');             // jvm wins over jsTest/wasmJsTest
    expect(r.webTestTask).toBe('jsTest');               // jsTest wins over wasmJsTest
    expect(r.iosTestTask).toBe('iosSimulatorArm64Test'); // arm64 sim wins over iosX64/iosArm64
    expect(r.macosTestTask).toBe('macosArm64Test');     // arm64 wins (only target declared)
  });

  it('jdkRequirement floor is JDK 21 (jvmToolchain(21))', () => {
    expect(model.jdkRequirement.min).toBeGreaterThanOrEqual(21);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — `kmp-test describe` (spawn-based integration)
// ---------------------------------------------------------------------------

describe('cross-platform fixture / kmp-test describe (--skip-probe)', () => {
  let envelope;
  beforeAll(() => {
    const result = runSubcommand('describe', [
      '--json',
      '--skip-probe',
      '--project-root', FIXTURE_PATH,
    ]);
    expect(result.exitCode, `describe stderr: ${result.stderr}`).toBe(0);
    envelope = result.envelope;
  });

  it('emits a structured describe envelope', () => {
    expect(envelope).not.toBeNull();
    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.subcommand).toBe('describe');
    expect(envelope.exit_code).toBe(0);
    expect(envelope.describe).toBeDefined();
  });

  it('reports :sample with all 6 platforms', () => {
    const sample = envelope.describe.modules.find(m => m.name === ':sample');
    expect(sample).toBeDefined();
    expect(sample.type).toBe('kmp');
    expect(sample.platforms.slice().sort())
      .toEqual(['android', 'ios', 'js', 'jvm', 'macos', 'wasmJs'].sort());
  });

  it('reports the canonical test_tasks chain per platform', () => {
    const sample = envelope.describe.modules.find(m => m.name === ':sample');
    expect(sample.test_tasks.unit).toBe('jvmTest');
    expect(sample.test_tasks.web).toBe('jsTest');
    expect(sample.test_tasks.ios).toBe('iosSimulatorArm64Test');
    expect(sample.test_tasks.macos).toBe('macosArm64Test');
  });

  it('reports android_dsl + android_dsl_variant for the new KMP-android plugin', () => {
    const sample = envelope.describe.modules.find(m => m.name === ':sample');
    expect(sample.android_dsl).toBe('androidLibrary');
    expect(sample.android_dsl_variant).toBe('kmpAndroidLibrary');
  });
});
