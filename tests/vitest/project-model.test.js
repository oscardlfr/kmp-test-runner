// Tests for lib/project-model.js — v0.5.1 Phase 4 ProjectModel introspector.
//
// All filesystem state is in mkdtempSync temp dirs to keep tests deterministic
// and parallel-safe. Probe interactions are mocked by pre-writing the
// tasks-<sha>.txt cache file or by setting opts.skipProbe = true; we never
// invoke real gradle from these tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SCHEMA_VERSION,
  computeCacheKey,
  aggregateJdkSignals,
  parseSettingsIncludes,
  analyzeModule,
  resolveTasksFor,
  parseGradleTasksOutput,
  buildProjectModel,
  clearProjectModelCache,
} from '../../lib/project-model.js';

let workDir;

function makeProject() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-pm-test-'));
  // Stub gradle wrappers so the model treats this as a buildable project.
  writeFileSync(path.join(workDir, 'gradlew'), '#!/usr/bin/env bash\nexit 1\n');
  writeFileSync(path.join(workDir, 'gradlew.bat'), '@echo off\r\nexit /b 1\r\n');
  return workDir;
}

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// ------------------------------------------------------------------
// computeCacheKey
// ------------------------------------------------------------------
describe('computeCacheKey', () => {
  it('returns a 40-char lowercase hex SHA1', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const key = computeCacheKey(dir);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes when settings.gradle.kts content changes', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "a"');
    const k1 = computeCacheKey(dir);
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "b"');
    const k2 = computeCacheKey(dir);
    expect(k1).not.toBe(k2);
  });

  it('changes when a per-module build.gradle.kts content changes', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
    const k1 = computeCacheKey(dir);
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), 'plugins { kotlin("multiplatform") }');
    const k2 = computeCacheKey(dir);
    expect(k1).not.toBe(k2);
  });

  it('excludes build/ and .gradle/ from the file walk', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const k1 = computeCacheKey(dir);
    // Add build.gradle.kts inside build/ and .gradle/ — must NOT change the key.
    mkdirSync(path.join(dir, 'build'), { recursive: true });
    writeFileSync(path.join(dir, 'build', 'build.gradle.kts'), 'noise');
    mkdirSync(path.join(dir, '.gradle'), { recursive: true });
    writeFileSync(path.join(dir, '.gradle', 'build.gradle.kts'), 'noise');
    const k2 = computeCacheKey(dir);
    expect(k1).toBe(k2);
  });

  // v0.5.2 Gap C — cross-platform cache-key parity.
  //
  // Strategy: all three walkers (JS / bash / PS1) normalize content by
  // stripping ALL `\r` then trailing `\n+` before hashing, so files with
  // identical logical content but different line endings (CRLF vs LF)
  // hash to the SAME SHA on every platform. Fixtures and expected SHAs
  // below are mirrored in tests/bats/test-gradle-tasks-probe.bats and
  // tests/pester/Gradle-Tasks-Probe.Tests.ps1; any future divergence
  // breaks at least one of the three suites.
  describe('cross-platform parity (Gap C)', () => {
    const lfContent = 'rootProject.name = "x"\nplugins { kotlin("jvm") }\n';
    const crlfContent = 'rootProject.name = "x"\r\nplugins { kotlin("jvm") }\r\n';
    const buildLf = 'plugins { kotlin("jvm") }\n';
    const buildCrlf = 'plugins { kotlin("jvm") }\r\n';
    const canonicalSha = '0939412f62e3d3480919e52e477d01063d948cdd';

    it('LF fixture produces the canonical SHA', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'settings.gradle.kts'), lfContent);
      writeFileSync(path.join(dir, 'build.gradle.kts'), buildLf);
      expect(computeCacheKey(dir)).toBe(canonicalSha);
    });

    it('CRLF fixture produces the SAME canonical SHA (cross-platform parity)', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'settings.gradle.kts'), crlfContent);
      writeFileSync(path.join(dir, 'build.gradle.kts'), buildCrlf);
      // Same content as the LF case but with \r\n line endings — must hash
      // identically. Pre-fix Linux bash kept the trailing \r on each chunk
      // and diverged from Windows Git Bash; post-fix `tr -d '\r'` (bash) /
      // `s.replace(/\r/g, '')` (JS) / `-replace '\r', ''` (PS1) all converge.
      expect(computeCacheKey(dir)).toBe(canonicalSha);
    });

    it('mixed CRLF + LF fixture produces the SAME canonical SHA', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'settings.gradle.kts'), crlfContent); // CRLF
      writeFileSync(path.join(dir, 'build.gradle.kts'), buildLf);        // LF
      expect(computeCacheKey(dir)).toBe(canonicalSha);
    });

    it('different logical content produces a different SHA', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "y"\n');
      writeFileSync(path.join(dir, 'build.gradle.kts'), buildLf);
      expect(computeCacheKey(dir)).not.toBe(canonicalSha);
    });

    it('multiple trailing newlines fold to a single SHA (LF-only invariant)', () => {
      const dirA = makeProject();
      writeFileSync(path.join(dirA, 'settings.gradle.kts'), lfContent);
      writeFileSync(path.join(dirA, 'build.gradle.kts'), buildLf);
      const a = computeCacheKey(dirA);

      const dirB = mkdtempSync(path.join(tmpdir(), 'kmp-pm-test-multi-'));
      writeFileSync(path.join(dirB, 'gradlew'), '#!/usr/bin/env bash\nexit 1\n');
      writeFileSync(path.join(dirB, 'gradlew.bat'), '@echo off\r\nexit /b 1\r\n');
      try {
        writeFileSync(path.join(dirB, 'settings.gradle.kts'), lfContent + '\n\n');
        writeFileSync(path.join(dirB, 'build.gradle.kts'), buildLf + '\n');
        expect(computeCacheKey(dirB)).toBe(a);
      } finally {
        rmSync(dirB, { recursive: true, force: true });
      }
    });

    it('bare trailing CR is stripped (matches `tr -d \\r` semantics)', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"\r');
      const withCR = computeCacheKey(dir);
      writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
      const withoutCR = computeCacheKey(dir);
      expect(withCR).toBe(withoutCR);
    });
  });
});

// ------------------------------------------------------------------
// aggregateJdkSignals
// ------------------------------------------------------------------
describe('aggregateJdkSignals', () => {
  it('detects jvmToolchain(N) at the project root', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'build.gradle.kts'), 'kotlin {\n  jvmToolchain(17)\n}');
    const r = aggregateJdkSignals(dir);
    expect(r.min).toBe(17);
    expect(r.signals.find(s => s.type === 'jvmToolchain' && s.version === 17)).toBeTruthy();
  });

  it('returns null when no JDK signal is present anywhere', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
    const r = aggregateJdkSignals(dir);
    expect(r.min).toBeNull();
    expect(r.signals).toEqual([]);
  });

  it('walks nested subdirectories', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(path.join(dir, 'a', 'b', 'c', 'Conv.kt'), 'val v = JvmTarget.JVM_21');
    const r = aggregateJdkSignals(dir);
    expect(r.min).toBe(21);
  });

  it('respects the exclusion list (build/, .gradle/, node_modules/)', () => {
    const dir = makeProject();
    for (const skip of ['build', '.gradle', 'node_modules']) {
      mkdirSync(path.join(dir, skip), { recursive: true });
      writeFileSync(path.join(dir, skip, 'x.gradle.kts'), 'jvmToolchain(99)');
    }
    const r = aggregateJdkSignals(dir);
    expect(r.min).toBeNull();
  });

  it('detects JvmTarget.JVM_N declarations in build-logic plugins', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(
      path.join(dir, 'build-logic', 'src', 'main', 'kotlin', 'Conv.kt'),
      'compilerOptions { jvmTarget.set(JvmTarget.JVM_21) }'
    );
    const r = aggregateJdkSignals(dir);
    expect(r.min).toBe(21);
    expect(r.signals.find(s => s.type === 'JvmTarget')).toBeTruthy();
  });

  it('detects JavaVersion.VERSION_N (Android compileOptions)', () => {
    const dir = makeProject();
    writeFileSync(
      path.join(dir, 'build.gradle.kts'),
      'compileOptions { sourceCompatibility = JavaVersion.VERSION_17 }'
    );
    const r = aggregateJdkSignals(dir);
    expect(r.min).toBe(17);
    expect(r.signals.find(s => s.type === 'JavaVersion')).toBeTruthy();
  });

  it('returns the MAX across mixed signal types', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'build.gradle.kts'), 'kotlin { jvmToolchain(11) }');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(
      path.join(dir, 'm', 'build.gradle.kts'),
      'compilerOptions { jvmTarget.set(JvmTarget.JVM_21) }\n' +
      'compileOptions { sourceCompatibility = JavaVersion.VERSION_17 }'
    );
    const r = aggregateJdkSignals(dir);
    expect(r.min).toBe(21);
    expect(r.signals.length).toBeGreaterThanOrEqual(3);
  });

  it('emits relative POSIX paths in signals[]', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(dir, 'a', 'b', 'build.gradle.kts'), 'kotlin { jvmToolchain(17) }');
    const r = aggregateJdkSignals(dir);
    expect(r.signals[0].file).toBe('a/b/build.gradle.kts');
  });
});

// ------------------------------------------------------------------
// parseSettingsIncludes
// ------------------------------------------------------------------
describe('parseSettingsIncludes', () => {
  it('parses include(":mod") with double quotes', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":core-encryption")');
    expect(parseSettingsIncludes(dir)).toEqual([':core-encryption']);
  });

  it("parses include(':mod') with single quotes", () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), "include(':core-net')");
    expect(parseSettingsIncludes(dir)).toEqual([':core-net']);
  });

  it('parses include without parentheses (Groovy-style)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include ":core-foo"');
    expect(parseSettingsIncludes(dir)).toEqual([':core-foo']);
  });

  it('parses multi-arg include and dedupes', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'include(":a", ":b")\ninclude(":a")\n');
    expect(parseSettingsIncludes(dir)).toEqual([':a', ':b']);
  });

  it('returns [] when settings.gradle.kts is missing', () => {
    const dir = makeProject();
    expect(parseSettingsIncludes(dir)).toEqual([]);
  });
});

// ------------------------------------------------------------------
// analyzeModule
// ------------------------------------------------------------------
describe('analyzeModule', () => {
  it('classifies KMP modules with androidLibrary{} DSL', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins { kotlin("multiplatform") }\nkotlin { androidLibrary { } }');
    const a = analyzeModule(dir, ':m');
    expect(a.type).toBe('kmp');
    expect(a.androidDsl).toBe('androidLibrary');
  });

  it('classifies KMP modules with androidTarget() DSL', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins { kotlin("multiplatform") }\nkotlin { androidTarget() }');
    const a = analyzeModule(dir, ':m');
    expect(a.type).toBe('kmp');
    expect(a.androidDsl).toBe('androidTarget');
  });

  it('classifies pure Android modules', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { id("com.android.application") }');
    const a = analyzeModule(dir, ':app');
    expect(a.type).toBe('android');
    expect(a.androidDsl).toBeNull();
  });

  it('detects all 9 source-set directories independently', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm', 'src', 'commonTest'), { recursive: true });
    mkdirSync(path.join(dir, 'm', 'src', 'androidInstrumentedTest'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), '');
    const a = analyzeModule(dir, ':m');
    expect(a.sourceSets.commonTest).toBe(true);
    expect(a.sourceSets.androidInstrumentedTest).toBe(true);
    expect(a.sourceSets.test).toBe(false);
    expect(a.sourceSets.iosTest).toBe(false);
  });

  it('detects hasFlavor when productFlavors is present', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'android { productFlavors { create("free") } }');
    expect(analyzeModule(dir, ':app').hasFlavor).toBe(true);
  });

  it('detects coveragePlugin = "kover" / "jacoco" / null', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'k'), { recursive: true });
    mkdirSync(path.join(dir, 'j'), { recursive: true });
    mkdirSync(path.join(dir, 'n'), { recursive: true });
    writeFileSync(path.join(dir, 'k', 'build.gradle.kts'), 'plugins { id("kover") }');
    writeFileSync(path.join(dir, 'j', 'build.gradle.kts'), 'apply { plugin("jacoco") }');
    writeFileSync(path.join(dir, 'n', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
    expect(analyzeModule(dir, ':k').coveragePlugin).toBe('kover');
    expect(analyzeModule(dir, ':j').coveragePlugin).toBe('jacoco');
    expect(analyzeModule(dir, ':n').coveragePlugin).toBeNull();
  });
});

// ------------------------------------------------------------------
// resolveTasksFor
// ------------------------------------------------------------------
describe('resolveTasksFor', () => {
  it('picks the first matching candidate per category', () => {
    const r = resolveTasksFor(':m', ['desktopTest', 'androidConnectedCheck', 'koverXmlReportDebug']);
    expect(r.unitTestTask).toBe('desktopTest');
    expect(r.deviceTestTask).toBe('androidConnectedCheck');
    expect(r.coverageTask).toBe('koverXmlReportDebug');
  });

  it('returns null per-field when no candidate matches', () => {
    const r = resolveTasksFor(':m', ['something', 'unrelated']);
    expect(r.unitTestTask).toBeNull();
    expect(r.deviceTestTask).toBeNull();
    expect(r.coverageTask).toBeNull();
  });

  it('returns all-null when gradleTasks is null (probe unavailable)', () => {
    const r = resolveTasksFor(':m', null);
    expect(r.unitTestTask).toBeNull();
    expect(r.deviceTestTask).toBeNull();
    expect(r.coverageTask).toBeNull();
  });
});

// ------------------------------------------------------------------
// parseGradleTasksOutput
// ------------------------------------------------------------------
describe('parseGradleTasksOutput', () => {
  it('parses module:task lines and groups by module', () => {
    const m = parseGradleTasksOutput(
      'core-foo:test - Runs the unit tests.\n' +
      'core-foo:jacocoTestReport - Generates code coverage report.\n' +
      'core-bar:androidConnectedCheck - Runs all device checks.\n'
    );
    expect(m.get('core-foo')).toEqual(['test', 'jacocoTestReport']);
    expect(m.get('core-bar')).toEqual(['androidConnectedCheck']);
  });

  it('skips lines that are not module:task format (group headers, etc.)', () => {
    const m = parseGradleTasksOutput(
      '------------------\n' +
      'Verification tasks\n' +
      '------------------\n' +
      'core-foo:test - desc\n'
    );
    expect(m.size).toBe(1);
    expect(m.get('core-foo')).toEqual(['test']);
  });

  it('returns empty Map for empty/null content', () => {
    expect(parseGradleTasksOutput('').size).toBe(0);
    expect(parseGradleTasksOutput(null).size).toBe(0);
  });
});

// ------------------------------------------------------------------
// buildProjectModel — end-to-end
// ------------------------------------------------------------------
describe('buildProjectModel', () => {
  it('produces a v1 schema with all required top-level fields', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');

    const model = buildProjectModel(dir, { skipProbe: true });
    expect(model.schemaVersion).toBe(SCHEMA_VERSION);
    expect(model.projectRoot).toBe(dir);
    expect(typeof model.generatedAt).toBe('string');
    expect(model.cacheKey).toMatch(/^[0-9a-f]{40}$/);
    expect(model.jdkRequirement).toEqual({ min: null, signals: [] });
    expect(model.settingsIncludes).toEqual([':m']);
    expect(model.modules[':m']).toBeTruthy();
    expect(model.modules[':m'].type).toBe('jvm');
    expect(model.modules[':m'].gradleTasks).toBeNull();
  });

  it('warm cache hit returns the same JSON (skips rebuild)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const a = buildProjectModel(dir, { skipProbe: true });
    const b = buildProjectModel(dir, { skipProbe: true });
    expect(b.generatedAt).toBe(a.generatedAt);
    expect(b.cacheKey).toBe(a.cacheKey);
  });

  it('cache miss after content change forces a rebuild with a new generatedAt', async () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const a = buildProjectModel(dir, { skipProbe: true });
    // Force timestamp rollover then mutate content.
    await new Promise(r => setTimeout(r, 5));
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "y"');
    const b = buildProjectModel(dir, { skipProbe: true });
    expect(b.cacheKey).not.toBe(a.cacheKey);
    expect(b.generatedAt).not.toBe(a.generatedAt);
  });

  it('reads the existing tasks-<sha>.txt cache when present (probe shared with sh/ps1)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
    // Pre-write the probe cache file using the canonical SHA — model picks it up.
    const cacheKey = computeCacheKey(dir);
    const cacheDir = path.join(dir, '.kmp-test-runner-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, `tasks-${cacheKey}.txt`),
      'm:desktopTest - Runs desktop tests.\nm:jacocoTestReport - desc\n'
    );
    clearProjectModelCache(dir);
    const model = buildProjectModel(dir, { skipProbe: true });
    expect(model.modules[':m'].gradleTasks).toEqual(['desktopTest', 'jacocoTestReport']);
    expect(model.modules[':m'].resolved.unitTestTask).toBe('desktopTest');
    expect(model.modules[':m'].resolved.coverageTask).toBe('jacocoTestReport');
  });

  it('throws when projectRoot does not exist', () => {
    expect(() => buildProjectModel('/no/such/dir', { skipProbe: true })).toThrow();
  });

  it('persists model JSON atomically (model-<sha>.json file present)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const m = buildProjectModel(dir, { skipProbe: true });
    const modelFile = path.join(dir, '.kmp-test-runner-cache', `model-${m.cacheKey}.json`);
    expect(existsSync(modelFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(modelFile, 'utf8'));
    expect(onDisk.cacheKey).toBe(m.cacheKey);
    expect(onDisk.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('ignores corrupt cached model and rebuilds clean', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const m1 = buildProjectModel(dir, { skipProbe: true });
    // Corrupt the cache file in-place.
    const modelFile = path.join(dir, '.kmp-test-runner-cache', `model-${m1.cacheKey}.json`);
    writeFileSync(modelFile, '{ not valid json');
    const m2 = buildProjectModel(dir, { skipProbe: true });
    expect(m2.cacheKey).toBe(m1.cacheKey);
    expect(m2.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('opts.useCache = false forces rebuild even on cache hit', async () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const a = buildProjectModel(dir, { skipProbe: true });
    await new Promise(r => setTimeout(r, 5));
    const b = buildProjectModel(dir, { skipProbe: true, useCache: false });
    expect(b.generatedAt).not.toBe(a.generatedAt);
  });
});
