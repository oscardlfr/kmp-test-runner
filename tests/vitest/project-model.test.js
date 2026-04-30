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
  detectBuildLogicCoverageHints,
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

  // v0.6 Bug 2: pre-fix `(library|application)` missed `com.android.test`,
  // and the kotlin-android plugin (`kotlin("android")` / `org.jetbrains.kotlin.android`)
  // had no detection at all. Modules using these patterns showed `type=unknown`
  // (caught in real-world smoke against Confetti/nav3-recipes/DroidconKotlin).
  it('classifies com.android.test modules as android (v0.6 Bug 2)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'androidBenchmark'), { recursive: true });
    writeFileSync(path.join(dir, 'androidBenchmark', 'build.gradle.kts'),
      'plugins {\n  kotlin("android")\n  id("com.android.test")\n}');
    const a = analyzeModule(dir, ':androidBenchmark');
    expect(a.type).toBe('android');
    expect(a.androidDsl).toBeNull();
  });

  it('classifies kotlin("android") modules as android (v0.6 Bug 2)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins { kotlin("android") }');
    const a = analyzeModule(dir, ':m');
    expect(a.type).toBe('android');
  });

  it('classifies long-form org.jetbrains.kotlin.android plugin id as android (v0.6 Bug 2)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins { id("org.jetbrains.kotlin.android") }');
    const a = analyzeModule(dir, ':m');
    expect(a.type).toBe('android');
  });

  it('still classifies AGP+kotlin-android pair as android (regression — pre-fix path also worked here)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins {\n  id("com.android.application")\n  kotlin("android")\n}');
    const a = analyzeModule(dir, ':app');
    expect(a.type).toBe('android');
  });

  it('detects all 12 source-set directories independently', () => {
    // 9 baseline + 3 added in v0.6 Bug 3 (jsTest / wasmJsTest / wasmWasiTest).
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm', 'src', 'commonTest'), { recursive: true });
    mkdirSync(path.join(dir, 'm', 'src', 'androidInstrumentedTest'), { recursive: true });
    mkdirSync(path.join(dir, 'm', 'src', 'jsTest'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), '');
    const a = analyzeModule(dir, ':m');
    expect(a.sourceSets.commonTest).toBe(true);
    expect(a.sourceSets.androidInstrumentedTest).toBe(true);
    expect(a.sourceSets.jsTest).toBe(true);
    expect(a.sourceSets.wasmJsTest).toBe(false);
    expect(a.sourceSets.wasmWasiTest).toBe(false);
    expect(a.sourceSets.test).toBe(false);
    expect(a.sourceSets.iosTest).toBe(false);
  });

  it('detects wasmJsTest and wasmWasiTest source-set dirs (v0.6 Bug 3)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'wasm', 'src', 'wasmJsTest'), { recursive: true });
    mkdirSync(path.join(dir, 'wasm', 'src', 'wasmWasiTest'), { recursive: true });
    writeFileSync(path.join(dir, 'wasm', 'build.gradle.kts'), '');
    const a = analyzeModule(dir, ':wasm');
    expect(a.sourceSets.wasmJsTest).toBe(true);
    expect(a.sourceSets.wasmWasiTest).toBe(true);
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
    expect(r.webTestTask).toBeNull();
  });

  // v0.6 Bug 3 — JS / Wasm support.
  describe('JS / Wasm task resolution (v0.6 Bug 3)', () => {
    it('picks jsTest as webTestTask when present', () => {
      const r = resolveTasksFor(':m', ['jsTest', 'wasmJsTest']);
      expect(r.webTestTask).toBe('jsTest');
    });

    it('picks wasmJsTest as webTestTask when only Wasm is present', () => {
      const r = resolveTasksFor(':m', ['wasmJsTest']);
      expect(r.webTestTask).toBe('wasmJsTest');
    });

    it('returns webTestTask null when no JS/Wasm tasks exist', () => {
      const r = resolveTasksFor(':m', ['desktopTest', 'jvmTest']);
      expect(r.webTestTask).toBeNull();
    });

    it('JS-only module: unitTestTask falls back to jsTest when no JVM tasks present', () => {
      // KMP module that only declares js() target — no jvmTest, no desktopTest,
      // no test. Pre-fix unitTestTask was null and the script had nothing to run.
      const r = resolveTasksFor(':m', ['jsTest', 'wasmJsTest']);
      expect(r.unitTestTask).toBe('jsTest');
    });

    it('KMP+JS module: unitTestTask still picks jvmTest first (JS does NOT win the candidate race)', () => {
      // Regression: a KMP module with BOTH jvmTest and jsTest must keep
      // selecting jvmTest as the unit test task — the JS candidates are only
      // a fallback for JS-only modules.
      const r = resolveTasksFor(':m', ['jvmTest', 'jsTest']);
      expect(r.unitTestTask).toBe('jvmTest');
      expect(r.webTestTask).toBe('jsTest');
    });

    it('desktopTest still wins over jvmTest and jsTest (regression)', () => {
      const r = resolveTasksFor(':m', ['desktopTest', 'jvmTest', 'jsTest']);
      expect(r.unitTestTask).toBe('desktopTest');
      expect(r.webTestTask).toBe('jsTest');
    });
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

// ------------------------------------------------------------------
// v0.5.2 Gap A — build-logic coverage hints + coverageTask prediction
// ------------------------------------------------------------------
describe('detectBuildLogicCoverageHints (Gap A + v0.6 Bug 6)', () => {
  it('returns {hasKover:null, hasJacoco:null} when build-logic/ is absent', () => {
    const dir = makeProject();
    expect(detectBuildLogicCoverageHints(dir)).toEqual({ hasKover: null, hasJacoco: null });
  });

  it('detects kover as CONVENTION via build-logic Plugin<Project> source under src/main/kotlin', () => {
    const dir = makeProject();
    const conv = path.join(dir, 'build-logic', 'src', 'main', 'kotlin');
    mkdirSync(conv, { recursive: true });
    writeFileSync(
      path.join(conv, 'KoverConventionPlugin.kt'),
      'class KoverConventionPlugin : Plugin<Project> { override fun apply(target: Project) { target.pluginManager.apply("org.jetbrains.kotlinx.kover") } }\n'
    );
    expect(detectBuildLogicCoverageHints(dir)).toEqual({ hasKover: 'convention', hasJacoco: null });
  });

  it('detects jacoco as CONVENTION via precompiled script under src/main/kotlin', () => {
    const dir = makeProject();
    const conv = path.join(dir, 'build-logic', 'src', 'main', 'kotlin');
    mkdirSync(conv, { recursive: true });
    writeFileSync(path.join(conv, 'jacoco-convention.gradle.kts'), 'plugins { id("jacoco") }\n');
    expect(detectBuildLogicCoverageHints(dir)).toEqual({ hasKover: null, hasJacoco: 'convention' });
  });

  it('detects both signals as CONVENTION when build-logic configures both plugins', () => {
    const dir = makeProject();
    const conv = path.join(dir, 'build-logic', 'src', 'main', 'kotlin');
    mkdirSync(conv, { recursive: true });
    writeFileSync(path.join(conv, 'Kover.kt'), 'apply("org.jetbrains.kotlinx.kover")\n');
    writeFileSync(path.join(conv, 'Jacoco.kt'), 'apply("jacoco")\n');
    expect(detectBuildLogicCoverageHints(dir)).toEqual({ hasKover: 'convention', hasJacoco: 'convention' });
  });

  // v0.6 Bug 6 — distinguish convention vs self.
  it('detects jacoco as SELF when only build-logic/build.gradle.kts uses it (no consumer-facing convention)', () => {
    const dir = makeProject();
    const conv = path.join(dir, 'build-logic');
    mkdirSync(conv, { recursive: true });
    writeFileSync(path.join(conv, 'build.gradle.kts'),
      'plugins {\n  `kotlin-dsl`\n  jacoco\n}\n');
    expect(detectBuildLogicCoverageHints(dir)).toEqual({ hasKover: null, hasJacoco: 'self' });
  });

  it('treats nowinandroid-style register("...Jacoco...") as NO signal (registration noise stripped)', () => {
    // build-logic/<module>/build.gradle.kts that only NAMES jacoco-related
    // convention plugins via gradlePlugin {} register() blocks. Pre-fix
    // raised a false-positive jacoco signal; post-fix strips the noise.
    const dir = makeProject();
    const conv = path.join(dir, 'build-logic', 'convention');
    mkdirSync(conv, { recursive: true });
    writeFileSync(path.join(conv, 'build.gradle.kts'),
      'plugins {\n  `kotlin-dsl`\n}\n' +
      'gradlePlugin {\n' +
      '  plugins {\n' +
      '    register("androidApplicationJacoco") {\n' +
      '      id = libs.plugins.x.android.application.jacoco.get().pluginId\n' +
      '      implementationClass = "AndroidApplicationJacocoConventionPlugin"\n' +
      '    }\n' +
      '  }\n' +
      '}\n');
    expect(detectBuildLogicCoverageHints(dir)).toEqual({ hasKover: null, hasJacoco: null });
  });

  it('CONVENTION wins over SELF when both fire on the same plugin', () => {
    // build-logic/build.gradle.kts uses `plugins { jacoco }` for self-compile
    // AND build-logic/src/main/kotlin/Foo.kt is a real convention plugin
    // applying jacoco. Result: jacoco='convention' (consumer-facing wins).
    const dir = makeProject();
    const root = path.join(dir, 'build-logic');
    const conv = path.join(root, 'src', 'main', 'kotlin');
    mkdirSync(conv, { recursive: true });
    writeFileSync(path.join(root, 'build.gradle.kts'),
      'plugins { `kotlin-dsl`\n  jacoco\n}\n');
    writeFileSync(path.join(conv, 'JacocoConventionPlugin.kt'),
      'class JacocoConventionPlugin : Plugin<Project> { override fun apply(t: Project) { t.pluginManager.apply("jacoco") } }\n');
    expect(detectBuildLogicCoverageHints(dir)).toEqual({ hasKover: null, hasJacoco: 'convention' });
  });
});

describe('analyzeModule build-logic inheritance (Gap A + v0.6 Bug 6)', () => {
  it('module with no per-module signal inherits kover from build-logic CONVENTION hint', () => {
    const dir = makeProject();
    const moduleDir = path.join(dir, 'core-foo');
    mkdirSync(moduleDir, { recursive: true });
    // Per-module build file has NO kover/jacoco mention.
    writeFileSync(path.join(moduleDir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    const hint = { hasKover: 'convention', hasJacoco: null };
    const a = analyzeModule(dir, ':core-foo', hint);
    expect(a.coveragePlugin).toBe('kover');
  });

  it('module with no per-module signal inherits jacoco from build-logic CONVENTION hint', () => {
    const dir = makeProject();
    const moduleDir = path.join(dir, 'core-bar');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    const hint = { hasKover: null, hasJacoco: 'convention' };
    const a = analyzeModule(dir, ':core-bar', hint);
    expect(a.coveragePlugin).toBe('jacoco');
  });

  it('per-module signal wins over build-logic hint (kover beats jacoco hint)', () => {
    const dir = makeProject();
    const moduleDir = path.join(dir, 'core-baz');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, 'build.gradle.kts'), 'plugins { id("org.jetbrains.kotlinx.kover") }\n');
    const hint = { hasKover: null, hasJacoco: 'convention' };
    const a = analyzeModule(dir, ':core-baz', hint);
    expect(a.coveragePlugin).toBe('kover');
  });

  it('module with no per-module signal AND no hint returns null', () => {
    const dir = makeProject();
    const moduleDir = path.join(dir, 'core-qux');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    const a = analyzeModule(dir, ':core-qux');
    expect(a.coveragePlugin).toBeNull();
  });

  // v0.6 Bug 6: SELF signals must NOT propagate. nowinandroid surfaced the
  // false positive — build-logic compiled itself with jacoco, model declared
  // every consumer module had jacoco, real coverage run found 0 contributors.
  it('module does NOT inherit jacoco when build-logic hint is SELF only', () => {
    const dir = makeProject();
    const moduleDir = path.join(dir, 'core-self');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    const hint = { hasKover: null, hasJacoco: 'self' };
    const a = analyzeModule(dir, ':core-self', hint);
    expect(a.coveragePlugin).toBeNull();
  });

  it('module does NOT inherit kover when build-logic hint is SELF only', () => {
    const dir = makeProject();
    const moduleDir = path.join(dir, 'core-self-k');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    const hint = { hasKover: 'self', hasJacoco: null };
    const a = analyzeModule(dir, ':core-self-k', hint);
    expect(a.coveragePlugin).toBeNull();
  });
});

describe('resolveTasksFor coverage prediction (Gap A)', () => {
  it('predicts koverXmlReportDesktop when gradleTasks null + coveragePlugin kover + type kmp', () => {
    const r = resolveTasksFor(':m', null, { coveragePlugin: 'kover', type: 'kmp' });
    expect(r.coverageTask).toBe('koverXmlReportDesktop');
  });

  it('predicts koverXmlReportDebug when gradleTasks null + coveragePlugin kover + type android', () => {
    const r = resolveTasksFor(':m', null, { coveragePlugin: 'kover', type: 'android' });
    expect(r.coverageTask).toBe('koverXmlReportDebug');
  });

  it('predicts koverXmlReport when gradleTasks null + coveragePlugin kover + type jvm', () => {
    const r = resolveTasksFor(':m', null, { coveragePlugin: 'kover', type: 'jvm' });
    expect(r.coverageTask).toBe('koverXmlReport');
  });

  it('predicts jacocoTestReport when gradleTasks null + coveragePlugin jacoco', () => {
    const r = resolveTasksFor(':m', null, { coveragePlugin: 'jacoco', type: 'android' });
    expect(r.coverageTask).toBe('jacocoTestReport');
  });

  it('returns null when gradleTasks null + no coveragePlugin', () => {
    const r = resolveTasksFor(':m', null, { coveragePlugin: null, type: 'jvm' });
    expect(r.coverageTask).toBeNull();
  });

  it('probed task wins over predicted when both available', () => {
    // Probed list contains the actual task; analysis says kover+kmp would predict
    // koverXmlReportDesktop but probed list also has it → probed wins (same value).
    const r = resolveTasksFor(':m', ['koverXmlReportDebug'], { coveragePlugin: 'kover', type: 'kmp' });
    // Probed picks koverXmlReportDebug (in candidates, present in list).
    expect(r.coverageTask).toBe('koverXmlReportDebug');
  });

  it('still returns null unitTestTask/deviceTestTask when gradleTasks is null (only coverage predicted)', () => {
    const r = resolveTasksFor(':m', null, { coveragePlugin: 'kover', type: 'kmp' });
    expect(r.unitTestTask).toBeNull();
    expect(r.deviceTestTask).toBeNull();
    expect(r.coverageTask).toBe('koverXmlReportDesktop');
  });
});

describe('buildProjectModel applies build-logic hints (Gap A integration)', () => {
  it('module without per-module kover signal inherits via build-logic hint and predicts coverageTask', () => {
    const dir = makeProject();
    // build-logic with kover convention plugin
    const conv = path.join(dir, 'build-logic', 'src', 'main', 'kotlin');
    mkdirSync(conv, { recursive: true });
    writeFileSync(
      path.join(conv, 'KoverConventionPlugin.kt'),
      'apply("org.jetbrains.kotlinx.kover")\n'
    );
    // Module with NO per-module kover reference, but it's a KMP module
    const modDir = path.join(dir, 'core-foo');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
      path.join(modDir, 'build.gradle.kts'),
      'plugins { kotlin("multiplatform") }\n'
    );
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":core-foo")\n');

    const m = buildProjectModel(dir, { skipProbe: true });
    expect(m.modules[':core-foo'].coveragePlugin).toBe('kover');
    expect(m.modules[':core-foo'].resolved.coverageTask).toBe('koverXmlReportDesktop');
  });
});
