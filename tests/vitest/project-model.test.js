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
  MODEL_FINGERPRINT,
  computeCacheKey,
  aggregateJdkSignals,
  parseSettingsIncludes,
  analyzeModule,
  resolveTasksFor,
  flavorsFromTasks,
  parseGradleTasksOutput,
  buildProjectModel,
  clearProjectModelCache,
  detectBuildLogicCoverageHints,
  parseVersionCatalog,
  parseBuildLogicPluginDescriptors,
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

  // 2026-05-03 wide-smoke regression guard. AGP version → required runtime JDK
  // joins the signal pool. Without this, projects with `jvmTarget=11` AND
  // AGP 8.x picked JDK 11; gradle aborted with "Android Gradle plugin
  // requires Java 17". The strictest signal must win.
  describe('AGP-implied runtime JDK', () => {
    it('catalog: agp = "8.8.2" → JDK 17 floor', () => {
      const dir = makeProject();
      mkdirSync(path.join(dir, 'gradle'), { recursive: true });
      mkdirSync(path.join(dir, 'app'), { recursive: true });
      writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
        '[versions]\nagp = "8.8.2"\n');
      writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
        'compileOptions { sourceCompatibility = JavaVersion.VERSION_11 }');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(17);
      expect(r.agpVersion).toBe('8.8.2');
      expect(r.signals.find(s => /AGP 8\.8\.2 runtime/.test(s.type))).toBeTruthy();
    });

    it('catalog: agp = "7.4.2" → JDK 11 floor', () => {
      const dir = makeProject();
      mkdirSync(path.join(dir, 'gradle'), { recursive: true });
      writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
        '[versions]\nagp = "7.4.2"\n');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(11);
      expect(r.agpVersion).toBe('7.4.2');
    });

    it('plugins DSL: id("com.android.application") version "8.5.0" → JDK 17', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'build.gradle.kts'),
        'plugins {\n  id("com.android.application") version "8.5.0" apply false\n}');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(17);
      expect(r.agpVersion).toBe('8.5.0');
    });

    it('buildscript classpath: com.android.tools.build:gradle:8.2.1 → JDK 17', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'build.gradle.kts'),
        'buildscript {\n  dependencies {\n    classpath("com.android.tools.build:gradle:8.2.1")\n  }\n}');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(17);
      expect(r.agpVersion).toBe('8.2.1');
    });

    it('AGP-floor wins over lower jvmTarget — local-app-3 case', () => {
      const dir = makeProject();
      mkdirSync(path.join(dir, 'gradle'), { recursive: true });
      writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
        '[versions]\nagp = "8.8.2"\n');
      writeFileSync(path.join(dir, 'build.gradle.kts'),
        'kotlin { jvmToolchain(11) }');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(17);  // not 11
    });

    it('higher project jvmToolchain wins over AGP floor', () => {
      const dir = makeProject();
      mkdirSync(path.join(dir, 'gradle'), { recursive: true });
      writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
        '[versions]\nagp = "8.0.0"\n');
      writeFileSync(path.join(dir, 'build.gradle.kts'),
        'kotlin { jvmToolchain(21) }');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(21);
      expect(r.agpVersion).toBe('8.0.0');
    });

    it('non-Android KMP project → no AGP signal added', () => {
      const dir = makeProject();
      writeFileSync(path.join(dir, 'build.gradle.kts'),
        'kotlin { jvm() }\nkotlin { jvmToolchain(17) }');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(17);
      expect(r.agpVersion).toBeNull();
      expect(r.signals.find(s => /AGP/.test(s.type))).toBeUndefined();
    });

    // PR3 closeout 2026-05-03 — locks AGP 9.x → JDK 17 mapping. Live docs at
    // developer.android.com/build/releases/gradle-plugin (fetched 2026-05-03)
    // confirm AGP 9.2.0 requires JDK 17 minimum, not JDK 21 as an earlier
    // BACKLOG draft expected. Regression guard: if a future Android Studio
    // release bumps AGP 9.x to require JDK 21+, this test fails and forces
    // an explicit decision.
    it('catalog: agp = "9.0.0" → JDK 17 floor (per AGP 9.2.0 live docs 2026-05-03)', () => {
      const dir = makeProject();
      mkdirSync(path.join(dir, 'gradle'), { recursive: true });
      writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
        '[versions]\nagp = "9.0.0"\n');
      const r = aggregateJdkSignals(dir);
      expect(r.min).toBe(17);
      expect(r.agpVersion).toBe('9.0.0');
      expect(r.signals.find(s => /AGP 9\.0\.0 runtime/.test(s.type))).toBeTruthy();
    });

    // v0.8.0 fix-PR-B — `agpIsBinding` distinguishes "AGP raised the floor"
    // (binding) from "jvmToolchain raised it above AGP" (not binding).
    // preflightJdkCheck uses this to decide whether to emit the "preserving
    // host" notice — only when AGP is the surprising signal worth surfacing.
    describe('agpIsBinding', () => {
      it('AGP-only floor → agpIsBinding=true', () => {
        const dir = makeProject();
        mkdirSync(path.join(dir, 'gradle'), { recursive: true });
        writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
          '[versions]\nagp = "8.13.1"\n');
        const r = aggregateJdkSignals(dir);
        expect(r.min).toBe(17);
        expect(r.agpIsBinding).toBe(true);
      });

      it('AGP + lower jvmToolchain → AGP wins, agpIsBinding=true', () => {
        const dir = makeProject();
        mkdirSync(path.join(dir, 'gradle'), { recursive: true });
        writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
          '[versions]\nagp = "8.8.2"\n');
        writeFileSync(path.join(dir, 'build.gradle.kts'),
          'kotlin { jvmToolchain(11) }');
        const r = aggregateJdkSignals(dir);
        expect(r.min).toBe(17);
        expect(r.agpIsBinding).toBe(true);
      });

      it('AGP + equal jvmToolchain → still binding (AGP would have pinned floor anyway)', () => {
        const dir = makeProject();
        mkdirSync(path.join(dir, 'gradle'), { recursive: true });
        writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
          '[versions]\nagp = "8.8.2"\n');
        writeFileSync(path.join(dir, 'build.gradle.kts'),
          'kotlin { jvmToolchain(17) }');
        const r = aggregateJdkSignals(dir);
        expect(r.min).toBe(17);
        expect(r.agpIsBinding).toBe(true);
      });

      it('higher jvmToolchain over AGP floor → agpIsBinding=false', () => {
        const dir = makeProject();
        mkdirSync(path.join(dir, 'gradle'), { recursive: true });
        writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
          '[versions]\nagp = "8.0.0"\n');
        writeFileSync(path.join(dir, 'build.gradle.kts'),
          'kotlin { jvmToolchain(21) }');
        const r = aggregateJdkSignals(dir);
        expect(r.min).toBe(21);
        expect(r.agpIsBinding).toBe(false);
      });

      it('non-AGP project → agpIsBinding=false', () => {
        const dir = makeProject();
        writeFileSync(path.join(dir, 'build.gradle.kts'),
          'kotlin { jvmToolchain(17) }');
        const r = aggregateJdkSignals(dir);
        expect(r.min).toBe(17);
        expect(r.agpVersion).toBeNull();
        expect(r.agpIsBinding).toBe(false);
      });
    });
  });
});

// ------------------------------------------------------------------
// parseSettingsIncludes
// ------------------------------------------------------------------
describe('parseSettingsIncludes', () => {
  it('parses include(":mod") with double quotes', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":sample-encryption")');
    expect(parseSettingsIncludes(dir)).toEqual([':sample-encryption']);
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

  // 2026-05-03 wide-smoke regression guard. private-lib has
  // `// include(":bench-android")  // TODO: AGP 9 compat` and the
  // pre-fix parser treated it as a live module. The orchestrator then sent
  // gradle a task for a non-existent project, build aborted at resolution,
  // and (combined with the EINVAL silent-pass class) every project failed.
  // Mirrors orchestrator-utils.js#stripKotlinComments coverage in this file
  // (line ~120 — discoverIncludedModules already had this fix).
  it('strips // line comments before matching include keyword', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'include(":real")\n// include(":phantom")\n  // include(":also-phantom")\n');
    expect(parseSettingsIncludes(dir)).toEqual([':real']);
  });

  it('strips block comments before matching include keyword', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'include(":real")\n/* include(":phantom") */\n/*\n  include(":multi-line-phantom")\n*/\n');
    expect(parseSettingsIncludes(dir)).toEqual([':real']);
  });

  it('preserves URLs in comments (https://...)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      '// see https://example.com/some/path\ninclude(":real")\n');
    expect(parseSettingsIncludes(dir)).toEqual([':real']);
  });

  it('strips trailing-comment on the same line as a live include', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'include(":real")  // TODO: rename someday\n');
    expect(parseSettingsIncludes(dir)).toEqual([':real']);
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

  it('detects all 19 source-set directories independently', () => {
    // 9 baseline + 3 added in v0.6 Bug 3 (jsTest / wasmJsTest / wasmWasiTest)
    // + 6 added in v0.7.0 (iosX64Test / iosArm64Test / iosSimulatorArm64Test
    //   / macosTest / macosX64Test / macosArm64Test)
    // + 1 added in v0.8.0 fix-PR-D (androidDeviceTest — new KMP-Android plugin).
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
    expect(a.sourceSets.iosX64Test).toBe(false);
    expect(a.sourceSets.iosArm64Test).toBe(false);
    expect(a.sourceSets.iosSimulatorArm64Test).toBe(false);
    expect(a.sourceSets.macosTest).toBe(false);
    expect(a.sourceSets.macosX64Test).toBe(false);
    expect(a.sourceSets.macosArm64Test).toBe(false);
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

  it('detects iOS-arch + macOS source-set dirs (v0.7.0)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'apple', 'src', 'iosX64Test'), { recursive: true });
    mkdirSync(path.join(dir, 'apple', 'src', 'iosArm64Test'), { recursive: true });
    mkdirSync(path.join(dir, 'apple', 'src', 'iosSimulatorArm64Test'), { recursive: true });
    mkdirSync(path.join(dir, 'apple', 'src', 'macosX64Test'), { recursive: true });
    mkdirSync(path.join(dir, 'apple', 'src', 'macosArm64Test'), { recursive: true });
    writeFileSync(path.join(dir, 'apple', 'build.gradle.kts'), '');
    const a = analyzeModule(dir, ':apple');
    expect(a.sourceSets.iosX64Test).toBe(true);
    expect(a.sourceSets.iosArm64Test).toBe(true);
    expect(a.sourceSets.iosSimulatorArm64Test).toBe(true);
    expect(a.sourceSets.macosX64Test).toBe(true);
    expect(a.sourceSets.macosArm64Test).toBe(true);
    // Umbrella iosTest stays independent of arch-specific sets.
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

  // v0.6.x Gap 3: alias(libs.plugins.<X>) resolution via version catalog.
  // nav3-recipes / Compose Multiplatform / Confetti modern modules use this
  // form exclusively; pre-fix they all classified as `unknown`.
  it('classifies alias(libs.plugins.android.application) as android via TOML catalog (v0.6.x Gap 3)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\nandroid-application = { id = "com.android.application", version = "8.5.0" }\n');
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { alias(libs.plugins.android.application) }');
    const a = analyzeModule(dir, ':app');
    expect(a.type).toBe('android');
  });

  it('classifies alias(libs.plugins.kotlin.multiplatform) as kmp via TOML catalog (v0.6.x Gap 3)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\nkotlin-multiplatform = { id = "org.jetbrains.kotlin.multiplatform", version = "2.0.0" }\n');
    mkdirSync(path.join(dir, 'shared'), { recursive: true });
    writeFileSync(path.join(dir, 'shared', 'build.gradle.kts'),
      'plugins { alias(libs.plugins.kotlin.multiplatform) }');
    const a = analyzeModule(dir, ':shared');
    expect(a.type).toBe('kmp');
  });

  it('classifies alias(libs.plugins.kotlin.jvm) as jvm via TOML catalog (v0.6.x Gap 3)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\nkotlin-jvm = "org.jetbrains.kotlin.jvm:2.0.0"\n');
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'lib', 'build.gradle.kts'),
      'plugins { alias(libs.plugins.kotlin.jvm) }');
    const a = analyzeModule(dir, ':lib');
    expect(a.type).toBe('jvm');
  });

  it('falls back to heuristic resolution when libs.versions.toml is missing (v0.6.x Gap 3)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { alias(libs.plugins.android.application) }');
    const a = analyzeModule(dir, ':app');
    expect(a.type).toBe('android');
  });

  it('handles namespaced alias keys via heuristic suffix matching (v0.6.x Gap 3)', () => {
    // nowinandroid-style: alias(libs.plugins.nowinandroid.android.application)
    // resolves heuristically because catalog likely maps to internal convention
    // plugin ids that aren't AGP/kotlin literals.
    const dir = makeProject();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { alias(libs.plugins.nowinandroid.android.application) }');
    const a = analyzeModule(dir, ':app');
    expect(a.type).toBe('android');
  });

  it('regression: literal id("com.android.application") still classifies as android (v0.6.x Gap 3)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\nandroid-application = { id = "com.android.application", version = "8.5.0" }\n');
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { id("com.android.application") }');
    const a = analyzeModule(dir, ':app');
    expect(a.type).toBe('android');
  });
});

// ------------------------------------------------------------------
// analyzeModule kmpAndroidLibrary plugin (v0.8.0 fix-PR-D — Bug D)
//
// Google's `com.android.kotlin.multiplatform.library` plugin (Kotlin 2.3+)
// replaces `com.android.library` for KMP modules. It uses different test
// task names (`testAndroidHostTest` vs `testDebugUnitTest`) and requires
// `withHostTestBuilder {} / withDeviceTestBuilder {}` opt-ins inside
// `androidLibrary {}` for AGP to generate the test tasks. The model surfaces
// these as `androidDslVariant`, `hasHostTestOptIn`, `hasDeviceTestOptIn`,
// and overrides `sourceSets.androidUnitTest`/`androidDeviceTest` to reflect
// AGP behavior (opt-in trumps disk evidence and vice versa).
// ------------------------------------------------------------------
describe('analyzeModule kmpAndroidLibrary plugin (v0.8.0 fix-PR-D)', () => {
  it('detects kmpAndroidLibrary via literal id("com.android.kotlin.multiplatform.library")', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins {\n  kotlin("multiplatform")\n  id("com.android.kotlin.multiplatform.library")\n}\nkotlin { androidLibrary { } }');
    const a = analyzeModule(dir, ':m');
    expect(a.type).toBe('kmp');
    expect(a.androidDslVariant).toBe('kmpAndroidLibrary');
  });

  it('detects kmpAndroidLibrary via alias(libs.plugins.android.kotlin.multiplatform.library)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\n' +
      'kotlin-multiplatform = { id = "org.jetbrains.kotlin.multiplatform", version = "2.3.0" }\n' +
      'android-kotlin-multiplatform-library = { id = "com.android.kotlin.multiplatform.library", version = "9.0.0" }\n');
    mkdirSync(path.join(dir, 'shared'), { recursive: true });
    writeFileSync(path.join(dir, 'shared', 'build.gradle.kts'),
      'plugins {\n  alias(libs.plugins.kotlin.multiplatform)\n  alias(libs.plugins.android.kotlin.multiplatform.library)\n}');
    const a = analyzeModule(dir, ':shared');
    expect(a.type).toBe('kmp');
    expect(a.androidDslVariant).toBe('kmpAndroidLibrary');
  });

  it('detects kmpAndroidLibrary via androidLibrary {} DSL alone (convention-plugin scenario)', () => {
    // Repro: private-lib `:bench-net` applies a convention plugin
    // (`com.example.private.shared.kmp.benchmark`) which internally applies the new
    // plugin. The module's own build.gradle.kts has neither the literal id
    // nor the alias — only the `androidLibrary { }` DSL block. The DSL block
    // is exclusive to the new plugin (legacy uses `android {}`), so its
    // presence alone IS a reliable signal.
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins {\n  id("com.example.private.shared.kmp.benchmark")\n}\nkotlin {\n  androidLibrary {\n    namespace = "com.x"\n  }\n}');
    const a = analyzeModule(dir, ':m');
    expect(a.androidDslVariant).toBe('kmpAndroidLibrary');
  });

  it('withHostTestBuilder {} opt-in surfaces sourceSets.androidUnitTest = true', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm', 'src', 'androidUnitTest'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins {\n  kotlin("multiplatform")\n  id("com.android.kotlin.multiplatform.library")\n}\n' +
      'kotlin {\n  androidLibrary {\n    withHostTestBuilder {\n      sourceSetTreeName = "test"\n    }\n  }\n}');
    const a = analyzeModule(dir, ':m');
    expect(a.androidDslVariant).toBe('kmpAndroidLibrary');
    expect(a.hasHostTestOptIn).toBe(true);
    expect(a.sourceSets.androidUnitTest).toBe(true);
  });

  it('withHostTestBuilder ABSENT zeros sourceSets.androidUnitTest even when src dir exists (sample-firebase-mod repro)', () => {
    // Live repro from private-lib `:sample-firebase-mod`. The dir has
    // `src/androidUnitTest/kotlin/` with real test files but no
    // `withHostTestBuilder {}` opt-in declared. AGP creates no
    // `testAndroidHostTest` task → orchestrator must skip, not dispatch.
    // Pre-fix: filesystem-only probe set `androidUnitTest = true`, leading
    // orchestrator to dispatch `:m:testDebugUnitTest` → task_not_found.
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm', 'src', 'androidUnitTest', 'kotlin'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins {\n  kotlin("multiplatform")\n  id("com.android.kotlin.multiplatform.library")\n}\n' +
      'kotlin {\n  androidLibrary {\n    namespace = "com.x"\n  }\n}');
    const a = analyzeModule(dir, ':m');
    expect(a.androidDslVariant).toBe('kmpAndroidLibrary');
    expect(a.hasHostTestOptIn).toBe(false);
    expect(a.sourceSets.androidUnitTest).toBe(false);
  });

  it('withDeviceTestBuilder {} opt-in surfaces sourceSets.androidDeviceTest = true (bench-net repro)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'),
      'plugins {\n  id("com.example.private.shared.kmp.benchmark")\n}\n' +
      'kotlin {\n  androidLibrary {\n    namespace = "com.x"\n    withDeviceTestBuilder {\n      sourceSetTreeName = "test"\n    }\n  }\n}');
    const a = analyzeModule(dir, ':m');
    expect(a.androidDslVariant).toBe('kmpAndroidLibrary');
    expect(a.hasDeviceTestOptIn).toBe(true);
    expect(a.sourceSets.androidDeviceTest).toBe(true);
  });
});

// ------------------------------------------------------------------
// parseVersionCatalog (v0.6.x Gap 3)
// ------------------------------------------------------------------
describe('parseVersionCatalog (v0.6.x Gap 3)', () => {
  it('returns null when libs.versions.toml is absent', () => {
    const dir = makeProject();
    expect(parseVersionCatalog(dir)).toBeNull();
  });

  it('returns empty Map when [plugins] section is absent', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[versions]\nkotlin = "2.0.0"\n[libraries]\ncore = { module = "io.x:y", version.ref = "kotlin" }\n');
    const cat = parseVersionCatalog(dir);
    expect(cat).toBeInstanceOf(Map);
    expect(cat.size).toBe(0);
  });

  it('parses [plugins] table form with id field', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\nkotlin-multiplatform = { id = "org.jetbrains.kotlin.multiplatform", version.ref = "kotlin" }\nandroid-application = { id = "com.android.application", version = "8.5.0" }\n');
    const cat = parseVersionCatalog(dir);
    expect(cat.get('kotlin.multiplatform')).toBe('org.jetbrains.kotlin.multiplatform');
    expect(cat.get('android.application')).toBe('com.android.application');
  });

  it('parses [plugins] string form (id:version)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\nkotlin-jvm = "org.jetbrains.kotlin.jvm:2.0.0"\n');
    const cat = parseVersionCatalog(dir);
    expect(cat.get('kotlin.jvm')).toBe('org.jetbrains.kotlin.jvm');
  });

  it('skips malformed entries silently and keeps valid ones', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\n# this is a comment\nbroken =\nvalid = { id = "com.example.valid", version = "1.0" }\n');
    const cat = parseVersionCatalog(dir);
    expect(cat.get('valid')).toBe('com.example.valid');
    expect(cat.has('broken')).toBe(false);
  });

  it('stops at next section header — does not bleed [libraries] entries', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[plugins]\nkotlin-jvm = "org.jetbrains.kotlin.jvm:2.0.0"\n[libraries]\ncore = { module = "io.x:y", version = "1.0" }\n');
    const cat = parseVersionCatalog(dir);
    expect(cat.get('kotlin.jvm')).toBe('org.jetbrains.kotlin.jvm');
    expect(cat.has('core')).toBe(false);
  });
});

// ------------------------------------------------------------------
// parseBuildLogicPluginDescriptors (v0.6.x Gap 4)
// ------------------------------------------------------------------
describe('parseBuildLogicPluginDescriptors (v0.6.x Gap 4)', () => {
  it('returns empty array when build-logic/ is absent', () => {
    const dir = makeProject();
    expect(parseBuildLogicPluginDescriptors(dir)).toEqual([]);
  });

  it('parses gradlePlugin{} register{} blocks with literal id strings', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("foo") {
            id = "com.example.foo"
            implementationClass = "FooConventionPlugin"
          }
          register("bar") {
            id = "com.example.bar.jacoco"
            implementationClass = "BarJacocoConventionPlugin"
          }
        }
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(2);
    expect(ds.find(d => d.pluginId === 'com.example.foo')).toEqual({
      pluginId: 'com.example.foo',
      className: 'FooConventionPlugin',
      addsCoverage: null,
      appliedPlugins: [],
    });
    expect(ds.find(d => d.pluginId === 'com.example.bar.jacoco')).toEqual({
      pluginId: 'com.example.bar.jacoco',
      className: 'BarJacocoConventionPlugin',
      addsCoverage: 'jacoco',
      appliedPlugins: [],
    });
  });

  it('resolves libs.plugins.<X>.get().pluginId via the version catalog (nowinandroid pattern)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      `[plugins]
nowinandroid-android-application-jacoco = { id = "myproj.android.application.jacoco", version = "1.0" }
`);
    mkdirSync(path.join(dir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("androidApplicationJacoco") {
            id = libs.plugins.nowinandroid.android.application.jacoco.get().pluginId
            implementationClass = "AndroidApplicationJacocoConventionPlugin"
          }
        }
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].pluginId).toBe('myproj.android.application.jacoco');
    expect(ds[0].className).toBe('AndroidApplicationJacocoConventionPlugin');
    expect(ds[0].addsCoverage).toBe('jacoco');
  });

  it('detects addsCoverage="kover" from class-name pattern', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("kover") {
            id = "com.example.kover"
            implementationClass = "KoverConventionPlugin"
          }
        }
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].addsCoverage).toBe('kover');
  });

  it('handles precompiled-script-plugin pattern (filename = plugin id)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(
      path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'myproj.android-jacoco.gradle.kts'),
      'apply { plugin("jacoco") }');
    writeFileSync(
      path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'myproj.no-coverage.gradle.kts'),
      'plugins { kotlin("jvm") }');
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(2);
    expect(ds.find(d => d.pluginId === 'myproj.android-jacoco').addsCoverage).toBe('jacoco');
    expect(ds.find(d => d.pluginId === 'myproj.no-coverage').addsCoverage).toBeNull();
  });

  it('skips register{} blocks without resolvable id', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("unresolved") {
            id = libs.plugins.does.not.exist.get().pluginId
            implementationClass = "FooConventionPlugin"
          }
        }
      }`);
    // No catalog → libs.plugins.<X> can't resolve → skip silently.
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(0);
  });

  it('dedups by pluginId', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'a'), { recursive: true });
    mkdirSync(path.join(dir, 'build-logic', 'b'), { recursive: true });
    const block = `gradlePlugin {
      plugins {
        register("foo") {
          id = "com.example.foo"
          implementationClass = "FooConventionPlugin"
        }
      }
    }`;
    writeFileSync(path.join(dir, 'build-logic', 'a', 'build.gradle.kts'), block);
    writeFileSync(path.join(dir, 'build-logic', 'b', 'build.gradle.kts'), block);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].pluginId).toBe('com.example.foo');
  });

  // ------------------------------------------------------------------
  // v0.9 step 9.2 (Bug #2) — appliedPlugins extraction from .kt source.
  // NIA pattern: alias resolves to non-canonical literal id; the convention
  // plugin's `apply(plugin = "com.android.library")` body is invisible
  // without source-scan. parseBuildLogicPluginDescriptors now walks .kt
  // files and records appliedPlugins per descriptor by class name.
  // ------------------------------------------------------------------
  it('NIA pattern: extracts appliedPlugins from `apply(plugin = "...")` in .kt source', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      `[plugins]
nowinandroid-android-library = { id = "nowinandroid.android.library" }
`);
    mkdirSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("androidLibrary") {
            id = libs.plugins.nowinandroid.android.library.get().pluginId
            implementationClass = "AndroidLibraryConventionPlugin"
          }
        }
      }`);
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'AndroidLibraryConventionPlugin.kt'),
      `class AndroidLibraryConventionPlugin : Plugin<Project> {
        override fun apply(target: Project) {
          with(target) {
            apply(plugin = "com.android.library")
            apply(plugin = "nowinandroid.android.lint")
          }
        }
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].pluginId).toBe('nowinandroid.android.library');
    expect(ds[0].className).toBe('AndroidLibraryConventionPlugin');
    expect(ds[0].appliedPlugins).toEqual(expect.arrayContaining(['com.android.library', 'nowinandroid.android.lint']));
  });

  it('NIA pattern: detects coveragePlugin via `apply<JacocoPlugin>()` Kotlin generic form', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      `[plugins]
nowinandroid-jacoco = { id = "nowinandroid.android.library.jacoco" }
`);
    mkdirSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("jacoco") {
            id = libs.plugins.nowinandroid.jacoco.get().pluginId
            implementationClass = "AndroidLibraryJacocoConventionPlugin"
          }
        }
      }`);
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'AndroidLibraryJacocoConventionPlugin.kt'),
      `import org.gradle.testing.jacoco.plugins.JacocoPlugin
       class AndroidLibraryJacocoConventionPlugin : Plugin<Project> {
        override fun apply(target: Project) {
          with(target) { apply<JacocoPlugin>() }
        }
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].addsCoverage).toBe('jacoco');
    expect(ds[0].appliedPlugins).toEqual(['jacoco']);
  });

  it('private-lib pattern: extracts appliedPlugins from `pluginManager.apply("...")` form', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("kmpLibrary") {
            id = "com.example.kmp.library"
            implementationClass = "KmpLibraryConventionPlugin"
          }
        }
      }`);
    writeFileSync(path.join(dir, 'build-logic', 'src', 'main', 'kotlin', 'KmpLibraryConventionPlugin.kt'),
      `class KmpLibraryConventionPlugin : Plugin<Project> {
        override fun apply(target: Project) {
          with(target) {
            with(pluginManager) {
              apply("org.jetbrains.kotlin.multiplatform")
              apply("com.android.kotlin.multiplatform.library")
              apply("org.jetbrains.kotlinx.kover")
            }
          }
        }
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].appliedPlugins).toEqual(expect.arrayContaining([
      'org.jetbrains.kotlin.multiplatform',
      'com.android.kotlin.multiplatform.library',
      'org.jetbrains.kotlinx.kover',
    ]));
    // addsCoverage refined from appliedPlugins (class name doesn't match Kover regex).
    expect(ds[0].addsCoverage).toBe('kover');
  });

  it('precompiled-script .gradle.kts: extracts appliedPlugins from `plugins { id("...") }` block', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(
      path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'myproj.kmp-base.gradle.kts'),
      `plugins {
        id("org.jetbrains.kotlin.multiplatform")
        id("org.jetbrains.kotlinx.kover")
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].pluginId).toBe('myproj.kmp-base');
    expect(ds[0].appliedPlugins).toEqual(expect.arrayContaining([
      'org.jetbrains.kotlin.multiplatform',
      'org.jetbrains.kotlinx.kover',
    ]));
    expect(ds[0].addsCoverage).toBe('kover');
  });

  it('resolves libs.plugins.<X>.asProvider().get().pluginId (NIA parent-alias form)', () => {
    // NIA's `nowinandroid-android-library` parent alias coexists with
    // children `nowinandroid-android-library-{compose,jacoco,...}`. Kotlin
    // DSL forces `.asProvider()` to disambiguate parent from nested.
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      `[plugins]
nowinandroid-android-library = { id = "nowinandroid.android.library" }
nowinandroid-android-library-jacoco = { id = "nowinandroid.android.library.jacoco" }
`);
    mkdirSync(path.join(dir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("androidLibrary") {
            id = libs.plugins.nowinandroid.android.library.asProvider().get().pluginId
            implementationClass = "AndroidLibraryConventionPlugin"
          }
          register("androidLibraryJacoco") {
            id = libs.plugins.nowinandroid.android.library.jacoco.get().pluginId
            implementationClass = "AndroidLibraryJacocoConventionPlugin"
          }
        }
      }`);
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(2);
    expect(ds.find(d => d.pluginId === 'nowinandroid.android.library')).toBeDefined();
    expect(ds.find(d => d.pluginId === 'nowinandroid.android.library.jacoco')).toBeDefined();
  });

  it('descriptor without .kt source returns appliedPlugins:[] (backwards-compat)', () => {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("noSource") {
            id = "com.example.no.source"
            implementationClass = "NoSourceConventionPlugin"
          }
        }
      }`);
    // No corresponding .kt file in src/main/kotlin/.
    const ds = parseBuildLogicPluginDescriptors(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0].appliedPlugins).toEqual([]);
  });
});

// ------------------------------------------------------------------
// v0.9 step 9.2 (Bug #2) — analyzeModule expands aliases through
// descriptor.appliedPlugins. NIA `:core:data` repro: pre-fix returns
// type='unknown' because the alias resolves to a non-canonical literal.
// Post-fix: expandedPluginIds inherits "com.android.library" from the
// convention plugin's apply() body → type='android' fires.
// ------------------------------------------------------------------
describe('analyzeModule alias expansion via convention-plugin appliedPlugins (Bug #2)', () => {
  function makeNiaLikeProject() {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      `[plugins]
nowinandroid-android-library = { id = "nowinandroid.android.library" }
nowinandroid-android-library-jacoco = { id = "nowinandroid.android.library.jacoco" }
`);
    mkdirSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("androidLibrary") {
            id = libs.plugins.nowinandroid.android.library.get().pluginId
            implementationClass = "AndroidLibraryConventionPlugin"
          }
          register("androidLibraryJacoco") {
            id = libs.plugins.nowinandroid.android.library.jacoco.get().pluginId
            implementationClass = "AndroidLibraryJacocoConventionPlugin"
          }
        }
      }`);
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'AndroidLibraryConventionPlugin.kt'),
      `class AndroidLibraryConventionPlugin : Plugin<Project> {
        override fun apply(target: Project) {
          target.pluginManager.apply("com.android.library")
        }
      }`);
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'AndroidLibraryJacocoConventionPlugin.kt'),
      `class AndroidLibraryJacocoConventionPlugin : Plugin<Project> {
        override fun apply(target: Project) { apply<JacocoPlugin>() }
      }`);
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":core:data")');
    mkdirSync(path.join(dir, 'core', 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'core', 'data', 'build.gradle.kts'),
      `plugins {
        alias(libs.plugins.nowinandroid.android.library)
        alias(libs.plugins.nowinandroid.android.library.jacoco)
      }
      android { namespace = "com.example.data" }`);
    return dir;
  }

  it('expands non-canonical alias literal to com.android.library via appliedPlugins', () => {
    const dir = makeNiaLikeProject();
    const analysis = analyzeModule(dir, ':core:data');
    expect(analysis.type).toBe('android');
  });

  it('inherits jacoco coverage from convention plugin apply<JacocoPlugin>() body', () => {
    const dir = makeNiaLikeProject();
    const analysis = analyzeModule(dir, ':core:data');
    expect(analysis.coveragePlugin).toBe('jacoco');
  });
});

// ------------------------------------------------------------------
// analyzeModule named JVM targets + intermediate hierarchy groups
// (2026-05-03 — private-lib sample-net-retrofit / sample-storage-cache repro)
// ------------------------------------------------------------------
describe('analyzeModule named JVM targets + hierarchy groups', () => {
  function makeKmpModule(buildScript) {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), buildScript);
    return dir;
  }

  it('detects jvm("desktop") as a named JVM target', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm("desktop") { compilerOptions { } }
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.namedJvmTargets).toEqual(['desktop']);
  });

  it('detects jvm("server") with single quotes', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm('server')
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.namedJvmTargets).toEqual(['server']);
  });

  it('detects multiple named JVM targets', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm("desktop")
  jvm("server")
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.namedJvmTargets.sort()).toEqual(['desktop', 'server']);
  });

  it('does NOT detect default jvm() as a named target', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm()
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.namedJvmTargets).toEqual([]);
  });

  it('detects default jvm() declaration via hasDefaultJvm', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm()
  androidTarget()
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.hasDefaultJvm).toBe(true);
    expect(a.namedJvmTargets).toEqual([]);
  });

  it('hasDefaultJvm = false when no jvm() declared', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  iosX64()
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.hasDefaultJvm).toBe(false);
  });

  it('hasDefaultJvm = true when jvm() AND jvm("name") both declared', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm()
  jvm("server")
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.hasDefaultJvm).toBe(true);
    expect(a.namedJvmTargets).toEqual(['server']);
  });

  it('ignores commented-out jvm("...") declarations', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm("desktop")
  // jvm("phantom")
  /* jvm("alsoPhantom") */
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.namedJvmTargets).toEqual(['desktop']);
  });

  it('detects intermediate hierarchy group("jvm")', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm("desktop")
  androidLibrary { namespace = "x" }
  applyDefaultHierarchyTemplate {
    common {
      group("jvm") {
        withAndroidTarget()
        withJvm()
      }
    }
  }
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.namedJvmTargets).toEqual(['desktop']);
    expect(a.intermediateGroups).toContain('jvm');
  });

  it('augments source-set walker with named-target dirs (e.g. serverMain/serverTest)', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm("server")
}
`);
    mkdirSync(path.join(dir, 'm', 'src', 'serverMain', 'kotlin'), { recursive: true });
    mkdirSync(path.join(dir, 'm', 'src', 'serverTest', 'kotlin'), { recursive: true });
    const a = analyzeModule(dir, ':m');
    expect(a.sourceSets.serverMain).toBe(true);
    expect(a.sourceSets.serverTest).toBe(true);
  });
});

// resolveTasksFor with named JVM targets — cold cache (predict from sourceSets)
// ------------------------------------------------------------------
describe('resolveTasksFor with named JVM targets (cold cache)', () => {
  function makeKmpModule(buildScript, sourceSetDirs = []) {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), buildScript);
    for (const ss of sourceSetDirs) {
      mkdirSync(path.join(dir, 'm', 'src', ss, 'kotlin'), { recursive: true });
    }
    return dir;
  }

  // The private-lib `sample-storage-cache` repro: jvm("desktop") declared,
  // BUT only `commonTest/`+`jvmTest/` exist on disk (no `desktopTest/`).
  // Pre-fix: walker saw jvmTest/, picked `jvmTest`, gradle aborted with
  // "Cannot locate tasks". Post-fix: trust the named target, return
  // `desktopTest` regardless of disk state — gradle creates the task from
  // the `jvm("desktop")` declaration.
  it('jvm("desktop") + only jvmTest/ on disk → resolves to desktopTest', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin { jvm("desktop") }
`, ['commonTest', 'jvmTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBe('desktopTest');
  });

  it('jvm("server") + serverTest/ on disk → resolves to serverTest', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin { jvm("server") }
`, ['serverTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBe('serverTest');
  });

  it('no named target + jvmTest/ on disk → falls back to jvmTest (regression guard)', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin { jvm() }
`, ['jvmTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBe('jvmTest');
  });

  it('default jvm() + jvmTest/ on disk → resolves to jvmTest', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin { jvm() }
`, ['jvmTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBe('jvmTest');
  });

  it('no jvm at all + desktopTest/ on disk (custom source set) → desktopTest', () => {
    // Edge case: someone declared a custom source set named desktopTest
    // without a corresponding `jvm("desktop")` declaration. Disk walk wins.
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin { iosX64() }
`, ['desktopTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBe('desktopTest');
  });

  // PeopleInSpace `:common` reproducer: declares `kotlin { jvm() }` but only
  // has `commonTest/` on disk (no `jvmTest/` folder). Pre-fix the CLI returned
  // null because predict-from-sourceSets didn't see jvmTest on disk. Now
  // hasDefaultJvm trusts the declaration, returning `jvmTest`. KMP creates
  // the task from the target declaration regardless of source-set folder.
  it('default jvm() + only commonTest/ on disk → resolves to jvmTest', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm()
  androidTarget()
}
`, ['commonTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBe('jvmTest');
  });

  it('no jvm declaration + only commonTest/ on disk → null (no task)', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  iosX64()
}
`, ['commonTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBeNull();
  });

  it('default jvm() + group("jvm") intermediate (rare conflict) → falls through', () => {
    // Group named "jvm" hijacks the bare `jvmTest` source set as intermediate;
    // the orchestrator should NOT trust the default declaration in this case.
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm()
  androidTarget()
  applyDefaultHierarchyTemplate {
    common {
      group("jvm") { withJvm(); withAndroidTarget() }
    }
  }
}
`, ['jvmTest']);
    const a = analyzeModule(dir, ':m');
    expect(a.intermediateGroups).toContain('jvm');
    const r = resolveTasksFor(':m', null, a);
    // jvmTest filtered out (intermediate); no other candidate present → null.
    // Caller can probe gradle to disambiguate.
    expect(r.unitTestTask).toBeNull();
  });

  // Defense in depth: if someone declares both jvm("X") AND group("X")
  // (would be ambiguous), we should not pick a target task that conflicts
  // with an intermediate group name.
  it('jvm("desktop") + group("desktop") (conflict) → falls back to standard chain', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm("desktop")
  applyDefaultHierarchyTemplate {
    common {
      group("desktop") { withJvm() }
    }
  }
}
`, ['desktopTest']);
    const a = analyzeModule(dir, ':m');
    expect(a.intermediateGroups).toContain('desktop');
    const r = resolveTasksFor(':m', null, a);
    // Conflict: skip the named target, fall through to standard chain.
    // desktopTest is then dropped (intermediate), and jvmTest is also dropped
    // because it's not on disk. Result: null.
    // This is intentional — caller can probe gradle to disambiguate.
    expect(r.unitTestTask).toBeNull();
  });

  it('JVM-target override does NOT pollute iosTestTask / macosTestTask / webTestTask', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm("desktop")
  iosX64()
  macosArm64()
  js(IR) { browser() }
}
`, ['iosX64Test', 'macosArm64Test', 'jsTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', null, a);
    expect(r.unitTestTask).toBe('desktopTest');     // JVM family — overridden
    expect(r.iosTestTask).toBe('iosX64Test');       // iOS family — disk walk
    expect(r.macosTestTask).toBe('macosArm64Test'); // macOS family — disk walk
    expect(r.webTestTask).toBe('jsTest');           // web family — disk walk
  });
});

// resolveTasksFor probe path — gate the bare AGP `test` task on a unit-test
// source set, so `describe` stops reporting `unit=test` for app modules that
// dispatch would skip at runtime.
// ------------------------------------------------------------------
describe('resolveTasksFor gates bare `test` on source-set presence (probe path)', () => {
  function makeModule(buildScript, sourceSetDirs = []) {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), buildScript);
    for (const ss of sourceSetDirs) {
      mkdirSync(path.join(dir, 'm', 'src', ss, 'kotlin'), { recursive: true });
    }
    return dir;
  }

  it('com.android.application with no unit-test source set → unit task null (was over-reported as `test`)', () => {
    const dir = makeModule(`
plugins { id("com.android.application") }
android { namespace = "x" }
`);
    const a = analyzeModule(dir, ':m');
    // Probe exposes the bare AGP `test` lifecycle task even though no
    // src/test or src/androidUnitTest exists → must NOT resolve to `test`.
    const r = resolveTasksFor(':m', ['test', 'testDebugUnitTest', 'assembleDebug'], a);
    expect(r.unitTestTask).toBeNull();
  });

  it('pure JVM module with src/test → keeps `test` (regression guard)', () => {
    const dir = makeModule('plugins { kotlin("jvm") }\n', ['test']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', ['test', 'compileTestKotlin'], a);
    expect(r.unitTestTask).toBe('test');
  });

  it('KMP module with jvmTest → resolves jvmTest before reaching `test` (regression guard)', () => {
    const dir = makeModule(`
plugins { kotlin("multiplatform") }
kotlin { jvm() }
`, ['jvmTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', ['jvmTest', 'test'], a);
    expect(r.unitTestTask).toBe('jvmTest');
  });

  it('module with an androidUnitTest source set → keeps `test` (gate mirrors dispatch)', () => {
    const dir = makeModule(`
plugins { id("com.android.application") }
android { namespace = "x" }
`, ['androidUnitTest']);
    const a = analyzeModule(dir, ':m');
    const r = resolveTasksFor(':m', ['test', 'testDebugUnitTest'], a);
    expect(r.unitTestTask).toBe('test');
  });

  it('flavored module (probe lists test<Flavor>UnitTest, no bare unit-test source set) → keeps umbrella `test`', () => {
    const dir = makeModule(`
plugins { id("com.android.application") }
android { namespace = "x" }
`);
    const a = analyzeModule(dir, ':m');
    // Convention-applied flavors: the static scan sees no productFlavors and no
    // src/test, but the probe lists the flavored unit-test tasks. The umbrella
    // `test` runs them all, so it must resolve (dispatch picks the same umbrella).
    const r = resolveTasksFor(':m', ['testDemoDebugUnitTest', 'testProdDebugUnitTest', 'test', 'assembleDebug'], a);
    expect(r.unitTestTask).toBe('test');
    expect(r.flavors).toEqual(['demo', 'prod']);
  });
});

// analyzeModule testBuildType detection (2026-05-03 di-sample repro)
// ------------------------------------------------------------------
describe('analyzeModule testBuildType', () => {
  function makeAndroidModule(buildScript) {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), buildScript);
    return dir;
  }

  it('detects testBuildType = "release"', () => {
    const dir = makeAndroidModule(`
plugins { id("com.android.library") }
android {
  namespace = "x"
  testBuildType = "release"
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.testBuildType).toBe('release');
  });

  it('detects testBuildType = "debug" (explicit default)', () => {
    const dir = makeAndroidModule(`
plugins { id("com.android.library") }
android {
  testBuildType = "debug"
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.testBuildType).toBe('debug');
  });

  it('returns null when no testBuildType declaration present', () => {
    const dir = makeAndroidModule(`
plugins { id("com.android.library") }
android { namespace = "x" }
`);
    const a = analyzeModule(dir, ':m');
    expect(a.testBuildType).toBeNull();
  });

  it('resolves variable testBuildType when val is a direct string literal', () => {
    // 2026-05-05 fix-PR-F follow-up — single-file `val x = "release"` shape.
    const dir = makeAndroidModule(`
plugins { id("com.android.library") }
val benchmarkBuildType = "release"
android {
  testBuildType = benchmarkBuildType
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.testBuildType).toBe('release');
  });

  it('resolves variable testBuildType when val uses ?: default (di-sample shape)', () => {
    // 2026-05-05 fix-PR-F follow-up — di-sample :benchmark uses
    // `val x = (project.findProperty(...) as? String) ?: "release"`.
    const dir = makeAndroidModule(`
plugins { id("com.android.library") }
val benchmarkBuildType = (project.findProperty("benchmarkBuildType") as? String) ?: "release"
android {
  testBuildType = benchmarkBuildType
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.testBuildType).toBe('release');
  });

  it('returns null when variable testBuildType has no resolvable val literal', () => {
    // Regression guard — opaque expressions (function calls, multi-file
    // refs) fall through to null, preserving AGP-default "debug" behavior.
    const dir = makeAndroidModule(`
plugins { id("com.android.library") }
android {
  testBuildType = computeBuildType()
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.testBuildType).toBeNull();
  });

  it('ignores commented-out testBuildType', () => {
    const dir = makeAndroidModule(`
plugins { id("com.android.library") }
android {
  // testBuildType = "release"
  /* testBuildType = "release" */
}
`);
    const a = analyzeModule(dir, ':m');
    expect(a.testBuildType).toBeNull();
  });
});

// resolveTasksFor with intermediate hierarchy groups — drop XTest from chain
// ------------------------------------------------------------------
describe('resolveTasksFor with intermediate hierarchy groups', () => {
  function makeKmpModule(buildScript, sourceSetDirs = []) {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), buildScript);
    for (const ss of sourceSetDirs) {
      mkdirSync(path.join(dir, 'm', 'src', ss, 'kotlin'), { recursive: true });
    }
    return dir;
  }

  // applyDefaultHierarchyTemplate { common { group("X") { ... } } } creates
  // intermediate XTest source set with no runnable XTest task. Even when no
  // named JVM target is declared (so the JVM-family override doesn't fire),
  // the intermediateGroups filter must drop the matching candidate so the
  // walker doesn't return a phantom task name.
  it('drops jvmTest candidate when group("jvm") is declared', () => {
    const dir = makeKmpModule(`
plugins { kotlin("multiplatform") }
kotlin {
  jvm()
  applyDefaultHierarchyTemplate {
    common {
      group("jvm") { withJvm() }
    }
  }
}
`, ['jvmTest', 'desktopTest']);
    const a = analyzeModule(dir, ':m');
    expect(a.intermediateGroups).toContain('jvm');
    const r = resolveTasksFor(':m', null, a);
    // jvmTest filtered out (intermediate group); desktopTest is next in chain.
    expect(r.unitTestTask).toBe('desktopTest');
  });
});

// analyzeModule per-module convention-plugin detection (v0.6.x Gap 4)
// ------------------------------------------------------------------
describe('analyzeModule per-module convention application (v0.6.x Gap 4)', () => {
  function setupNowinandroidStyleFixture() {
    const dir = makeProject();
    mkdirSync(path.join(dir, 'gradle'), { recursive: true });
    writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      `[plugins]
myproj-android-jacoco = { id = "myproj.android.jacoco", version = "1.0" }
myproj-android-noop = { id = "myproj.android.noop", version = "1.0" }
`);
    mkdirSync(path.join(dir, 'build-logic', 'convention'), { recursive: true });
    writeFileSync(path.join(dir, 'build-logic', 'convention', 'build.gradle.kts'),
      `gradlePlugin {
        plugins {
          register("androidJacoco") {
            id = libs.plugins.myproj.android.jacoco.get().pluginId
            implementationClass = "AndroidApplicationJacocoConventionPlugin"
          }
          register("androidNoop") {
            id = libs.plugins.myproj.android.noop.get().pluginId
            implementationClass = "AndroidApplicationNoopConventionPlugin"
          }
        }
      }`);
    return dir;
  }

  it('module that applies a Jacoco convention plugin via id() inherits coveragePlugin="jacoco"', () => {
    const dir = setupNowinandroidStyleFixture();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { id("myproj.android.jacoco") }');
    expect(analyzeModule(dir, ':app').coveragePlugin).toBe('jacoco');
  });

  it('module that applies a Jacoco convention plugin via alias() inherits coveragePlugin="jacoco"', () => {
    const dir = setupNowinandroidStyleFixture();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { alias(libs.plugins.myproj.android.jacoco) }');
    expect(analyzeModule(dir, ':app').coveragePlugin).toBe('jacoco');
  });

  it('module that applies a NON-coverage convention plugin gets coveragePlugin=null', () => {
    const dir = setupNowinandroidStyleFixture();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { id("myproj.android.noop") }');
    expect(analyzeModule(dir, ':app').coveragePlugin).toBeNull();
  });

  it('module that does NOT apply any convention plugin gets coveragePlugin=null', () => {
    const dir = setupNowinandroidStyleFixture();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { kotlin("jvm") }');
    expect(analyzeModule(dir, ':app').coveragePlugin).toBeNull();
  });

  it('regression: nowinandroid-style noise (gradlePlugin register only, no consumer apply) → null', () => {
    // Same as build-logic-noise-jacoco fixture from Bug 6: gradlePlugin{}
    // names jacoco-related plugins via class names, but no consumer applies
    // them. Pre-fix Bug 6 over-predicted because of the substring scan;
    // post-fix Gap 4 correctly returns null because the descriptor lookup
    // requires the consumer to APPLY the plugin id.
    const dir = setupNowinandroidStyleFixture();
    mkdirSync(path.join(dir, 'core-baz'), { recursive: true });
    writeFileSync(path.join(dir, 'core-baz', 'build.gradle.kts'),
      'plugins { kotlin("jvm") }');
    expect(analyzeModule(dir, ':core-baz').coveragePlugin).toBeNull();
  });

  it('backwards-compat: project with NO descriptors but hint=convention still inherits (build-logic-convention-jacoco fixture)', () => {
    // Pure Plugin<Project> setup: no gradlePlugin{} block, just a .kt file
    // under build-logic/convention/src/main/kotlin/. parseBuildLogicPluginDescriptors
    // returns [] → fall through to the hint fallback. v0.6.0 broad inheritance.
    const dir = makeProject();
    mkdirSync(path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(
      path.join(dir, 'build-logic', 'convention', 'src', 'main', 'kotlin', 'JacocoConventionPlugin.kt'),
      `class JacocoConventionPlugin : org.gradle.api.Plugin<org.gradle.api.Project> {
        override fun apply(target: org.gradle.api.Project) {
          target.pluginManager.apply("jacoco")
        }
      }`);
    mkdirSync(path.join(dir, 'core-foo'), { recursive: true });
    writeFileSync(path.join(dir, 'core-foo', 'build.gradle.kts'),
      'plugins { kotlin("jvm") }');
    expect(analyzeModule(dir, ':core-foo').coveragePlugin).toBe('jacoco');
  });

  it('per-module signal still wins over descriptor-based inheritance', () => {
    const dir = setupNowinandroidStyleFixture();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'build.gradle.kts'),
      'plugins { id("kover") }');
    expect(analyzeModule(dir, ':app').coveragePlugin).toBe('kover');
  });
});

// ------------------------------------------------------------------
// flavorsFromTasks + flavored resolveTasksFor / fixture (Finding #2)
// ------------------------------------------------------------------
describe('flavorsFromTasks (Finding #2)', () => {
  it('recovers flavor names from test${Flavor}${BuildType}UnitTest tasks', () => {
    expect(flavorsFromTasks([
      'testDemoDebugUnitTest', 'testProdDebugUnitTest',
      'testDemoReleaseUnitTest', 'testProdReleaseUnitTest',
    ])).toEqual(['demo', 'prod']);
  });
  it('returns [] for non-flavored unit tasks (no phantom flavor)', () => {
    expect(flavorsFromTasks(['testDebugUnitTest', 'testReleaseUnitTest', 'test'])).toEqual([]);
  });
  it('handles multi-dimension flavor segments (demoFree)', () => {
    expect(flavorsFromTasks(['testDemoFreeDebugUnitTest'])).toEqual(['demoFree']);
  });
  it('dedupes + sorts, ignores unrelated tasks', () => {
    expect(flavorsFromTasks([
      'testProdDebugUnitTest', 'assemble', 'testDemoDebugUnitTest',
      'testDemoReleaseUnitTest', 'connectedProdDebugAndroidTest',
    ])).toEqual(['demo', 'prod']);
  });
  it('returns [] for null / non-array / empty', () => {
    expect(flavorsFromTasks(null)).toEqual([]);
    expect(flavorsFromTasks(undefined)).toEqual([]);
    expect(flavorsFromTasks([])).toEqual([]);
  });
});

describe('resolveTasksFor — flavors + flavored coverage (Finding #2)', () => {
  it('surfaces resolved.flavors + coverageReportTasks from the probe', () => {
    const r = resolveTasksFor(':app', [
      'testDemoDebugUnitTest', 'testProdDebugUnitTest', 'test',
      'createDemoDebugUnitTestCoverageReport', 'createProdDebugUnitTestCoverageReport',
      'connectedAndroidTest',
    ]);
    expect(r.flavors).toEqual(['demo', 'prod']);
    expect(r.coverageReportTasks).toEqual([
      'createDemoDebugUnitTestCoverageReport', 'createProdDebugUnitTestCoverageReport',
    ]);
    expect(r.unitTestTask).toBe('test'); // umbrella (no jvm/desktop target present)
  });
  it('non-probe branch returns flavors:[] + coverageReportTasks:[] for shape parity', () => {
    const r = resolveTasksFor(':app', null);
    expect(r.flavors).toEqual([]);
    expect(r.coverageReportTasks).toEqual([]);
  });
});

describe('buildProjectModel — convention-flavors fixture (Finding #2)', () => {
  const fixture = path.resolve('tests/fixtures/convention-flavors');
  it('static scan is blind to convention-applied flavors (skipProbe → hasFlavor false)', () => {
    const m = buildProjectModel(fixture, { skipProbe: true });
    expect(m.modules[':app'].hasFlavor).toBe(false);
    expect(m.modules[':core-foo'].hasFlavor).toBe(false);
  });
  it('probe recovers flavors + flavored coverage tasks from the task graph', () => {
    const m = buildProjectModel(fixture, { skipProbe: false, useCache: false });
    expect(m.modules[':app'].resolved.flavors).toEqual(['demo', 'prod']);
    expect(m.modules[':app'].resolved.coverageReportTasks)
      .toContain('createDemoDebugUnitTestCoverageReport');
  });
});

// A convention-flavored app whose unit tests live only in src/test<Flavor>/
// (no bare src/test/, no androidTest/) — the static walker tracks only fixed
// source-set names, so it sees no unit-test source at all; the probe is the
// sole evidence that the module is testable.
describe('buildProjectModel — flavored-unit-only fixture (src/test<Flavor>, no bare src/test)', () => {
  const fixture = path.resolve('tests/fixtures/flavored-unit-only');
  it('static scan is blind: :app reports no flavors and no tracked unit-test source set', () => {
    const m = buildProjectModel(fixture, { skipProbe: true });
    expect(m.modules[':app'].hasFlavor).toBe(false);
    expect(m.modules[':app'].sourceSets.test).toBe(false);
    expect(m.modules[':app'].sourceSets.androidUnitTest).toBe(false);
  });
  it('probe recovers flavors + resolves the umbrella unit task on :app', () => {
    const m = buildProjectModel(fixture, { skipProbe: false, useCache: false });
    expect(m.modules[':app'].resolved.flavors).toEqual(['demo', 'prod']);
    expect(m.modules[':app'].resolved.unitTestTask).toBe('test');
  });
  it('true-negative :instrumented-only has no flavored unit tasks → unit task null', () => {
    const m = buildProjectModel(fixture, { skipProbe: false, useCache: false });
    expect(m.modules[':instrumented-only'].resolved.flavors).toEqual([]);
    expect(m.modules[':instrumented-only'].resolved.unitTestTask).toBeNull();
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
    expect(r.iosTestTask).toBeNull();
    expect(r.macosTestTask).toBeNull();
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

  // 2026-05-05 fix-PR-F-bis — testBuildType-aware deviceTestTask candidate
  // chain. Pre-fix the chain was hardcoded
  // `['connectedAndroidDeviceTest', 'connectedDebugAndroidTest', ...]`, so a
  // module declaring `testBuildType = "release"` whose gradleTasks contained
  // BOTH `connectedDebugAndroidTest` AND `connectedReleaseAndroidTest` (a
  // legitimate AGP setup post-`androidComponents.beforeVariants` re-enabling
  // debug variants) silently picked Debug — the wrong canonical variant.
  describe('testBuildType-aware deviceTestTask (fix-PR-F-bis)', () => {
    it('testBuildType="release" with both Debug+Release tasks → connectedReleaseAndroidTest', () => {
      const analysis = { testBuildType: 'release', coveragePlugin: null, type: 'android' };
      const r = resolveTasksFor(':benchmark', ['connectedDebugAndroidTest', 'connectedReleaseAndroidTest'], analysis);
      expect(r.deviceTestTask).toBe('connectedReleaseAndroidTest');
    });

    it('testBuildType="release" with only Release task → connectedReleaseAndroidTest', () => {
      const analysis = { testBuildType: 'release', coveragePlugin: null, type: 'android' };
      const r = resolveTasksFor(':benchmark', ['connectedReleaseAndroidTest'], analysis);
      expect(r.deviceTestTask).toBe('connectedReleaseAndroidTest');
    });

    it('testBuildType="release" with only Debug task → connectedDebugAndroidTest (graceful fallback)', () => {
      // Edge case: testBuildType pinned to release but AGP only emitted the
      // Debug task (mis-configured project, or before user enables release
      // variants explicitly). Chain falls through to legacy Debug candidate.
      const analysis = { testBuildType: 'release', coveragePlugin: null, type: 'android' };
      const r = resolveTasksFor(':m', ['connectedDebugAndroidTest'], analysis);
      expect(r.deviceTestTask).toBe('connectedDebugAndroidTest');
    });

    it('testBuildType=null preserves legacy debug-first chain (regression guard)', () => {
      const analysis = { testBuildType: null, coveragePlugin: null, type: 'android' };
      const r = resolveTasksFor(':m', ['connectedDebugAndroidTest', 'connectedReleaseAndroidTest'], analysis);
      expect(r.deviceTestTask).toBe('connectedDebugAndroidTest');
    });

    it('connectedAndroidDeviceTest wins regardless of testBuildType (kmpAndroidLibrary precedence)', () => {
      // The KMP `androidLibrary {}` plugin uses `connectedAndroidDeviceTest`,
      // which sits at the head of the candidate chain ahead of any variant.
      const analysis = { testBuildType: 'release', coveragePlugin: null, type: 'kmp' };
      const r = resolveTasksFor(':m', ['connectedAndroidDeviceTest', 'connectedReleaseAndroidTest'], analysis);
      expect(r.deviceTestTask).toBe('connectedAndroidDeviceTest');
    });

    it('analysis=null preserves legacy chain (no testBuildType signal)', () => {
      const r = resolveTasksFor(':m', ['connectedDebugAndroidTest', 'connectedReleaseAndroidTest']);
      expect(r.deviceTestTask).toBe('connectedDebugAndroidTest');
    });
  });

  // v0.7.0 — iOS / macOS support.
  describe('iOS / macOS task resolution (v0.7.0)', () => {
    it('picks iosSimulatorArm64Test as iosTestTask when present', () => {
      const r = resolveTasksFor(':m', ['iosSimulatorArm64Test', 'iosX64Test', 'iosArm64Test']);
      expect(r.iosTestTask).toBe('iosSimulatorArm64Test');
    });

    it('falls back to iosX64Test when iosSimulatorArm64Test is absent', () => {
      const r = resolveTasksFor(':m', ['iosX64Test', 'iosArm64Test']);
      expect(r.iosTestTask).toBe('iosX64Test');
    });

    it('falls back to iosArm64Test when only device target is declared', () => {
      const r = resolveTasksFor(':m', ['iosArm64Test']);
      expect(r.iosTestTask).toBe('iosArm64Test');
    });

    it('falls back to umbrella iosTest when no arch-specific iOS task exists', () => {
      const r = resolveTasksFor(':m', ['iosTest']);
      expect(r.iosTestTask).toBe('iosTest');
    });

    it('returns iosTestTask null when no iOS tasks exist', () => {
      const r = resolveTasksFor(':m', ['desktopTest', 'jvmTest']);
      expect(r.iosTestTask).toBeNull();
    });

    it('picks macosArm64Test as macosTestTask when present', () => {
      const r = resolveTasksFor(':m', ['macosArm64Test', 'macosX64Test']);
      expect(r.macosTestTask).toBe('macosArm64Test');
    });

    it('falls back to macosX64Test when only Intel macOS target is declared', () => {
      const r = resolveTasksFor(':m', ['macosX64Test']);
      expect(r.macosTestTask).toBe('macosX64Test');
    });

    it('returns macosTestTask null when no macOS tasks exist', () => {
      const r = resolveTasksFor(':m', ['desktopTest', 'iosX64Test']);
      expect(r.macosTestTask).toBeNull();
    });

    it('iOS-only module: iosTestTask resolves but unitTestTask stays null (iOS does NOT win the candidate race)', () => {
      // KMP module that only declares iosX64() — no jvmTest, no desktopTest.
      // unitTestTask must NOT silently pick an iOS task; consumers must opt in
      // via iosTestTask explicitly.
      const r = resolveTasksFor(':m', ['iosX64Test']);
      expect(r.unitTestTask).toBeNull();
      expect(r.iosTestTask).toBe('iosX64Test');
    });

    it('KMP+iOS module: unitTestTask still picks jvmTest first (iOS does NOT win)', () => {
      // Regression: a KMP module with BOTH jvmTest and iosSimulatorArm64Test
      // must keep selecting jvmTest as the unit test task — iOS surfaces only
      // via iosTestTask.
      const r = resolveTasksFor(':m', ['jvmTest', 'iosSimulatorArm64Test']);
      expect(r.unitTestTask).toBe('jvmTest');
      expect(r.iosTestTask).toBe('iosSimulatorArm64Test');
    });

    it('macOS-only module: macosTestTask resolves but unitTestTask stays null', () => {
      const r = resolveTasksFor(':m', ['macosArm64Test']);
      expect(r.unitTestTask).toBeNull();
      expect(r.macosTestTask).toBe('macosArm64Test');
    });

    it('desktopTest still wins over jvmTest and macOS tasks (macOS does NOT collapse into desktop)', () => {
      const r = resolveTasksFor(':m', ['desktopTest', 'jvmTest', 'macosArm64Test']);
      expect(r.unitTestTask).toBe('desktopTest');
      expect(r.macosTestTask).toBe('macosArm64Test');
    });

    it('iosTestTask and macosTestTask are independent fields (multi-Apple module)', () => {
      const r = resolveTasksFor(':m', ['iosSimulatorArm64Test', 'macosArm64Test']);
      expect(r.iosTestTask).toBe('iosSimulatorArm64Test');
      expect(r.macosTestTask).toBe('macosArm64Test');
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
    expect(model.jdkRequirement).toEqual({ min: null, signals: [], agpVersion: null, agpIsBinding: false });
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

  it('does not serve a probe-blind cached model to a probe-wanting caller (skip-probe poison guard)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
    clearProjectModelCache(dir);

    // 1. A skip-probe build with no tasks-<sha> cache yields a probe-blind model
    //    (probed:false, every resolved.* null), persisted to model-<sha>.json.
    const blind = buildProjectModel(dir, { skipProbe: true });
    expect(blind.probed).toBe(false);
    expect(blind.modules[':m'].resolved.coverageTask).toBeNull();

    // 2. A tasks-<sha> probe cache now appears (a real probe could resolve tasks).
    const cacheKey = computeCacheKey(dir);
    const cacheDir = path.join(dir, '.kmp-test-runner-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, `tasks-${cacheKey}.txt`),
      'm:test - Runs tests.\nm:jacocoTestReport - Generates report.\n'
    );

    // 3. A probe-wanting caller must NOT receive the stale blind cache — it
    //    rebuilds and picks up the now-available probe data.
    const fresh = buildProjectModel(dir, { skipProbe: false, useCache: true });
    expect(fresh.probed).toBe(true);
    expect(fresh.modules[':m'].resolved.coverageTask).toBe('jacocoTestReport');
  });

  it('throws when projectRoot does not exist', () => {
    expect(() => buildProjectModel('/no/such/dir', { skipProbe: true })).toThrow();
  });

  it('persists model JSON atomically at .kmp-test-runner/cache/model-<sha>.json (v0.8.0 path)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const m = buildProjectModel(dir, { skipProbe: true });
    const modelFile = path.join(dir, '.kmp-test-runner', 'cache', `model-${m.cacheKey}.json`);
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
    const modelFile = path.join(dir, '.kmp-test-runner', 'cache', `model-${m1.cacheKey}.json`);
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

  // Wet audit 2026-05-08 (B4 cell): Bug #4 fix (commit ae02317) changed
  // platformsFromAnalysis output WITHOUT bumping SCHEMA_VERSION, so caches
  // generated days earlier silently kept returning `platforms:["android"]` for
  // private-lib:sample-result instead of the expected
  // `["jvm","android","ios","macos"]`. Embedding the introspector source-file
  // fingerprint in the cache file forces auto-invalidation on any logic change.
  it('persists modelFingerprint in the cached model JSON', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const m = buildProjectModel(dir, { skipProbe: true });
    expect(m.modelFingerprint).toBe(MODEL_FINGERPRINT);
    expect(m.modelFingerprint).toMatch(/^[0-9a-f]{12}$/);
    const onDisk = JSON.parse(readFileSync(
      path.join(dir, '.kmp-test-runner', 'cache', `model-${m.cacheKey}.json`),
      'utf8'
    ));
    expect(onDisk.modelFingerprint).toBe(MODEL_FINGERPRINT);
  });

  it('discards cached model when modelFingerprint is missing (pre-fix cache)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const m1 = buildProjectModel(dir, { skipProbe: true });
    const cacheFile = path.join(dir, '.kmp-test-runner', 'cache', `model-${m1.cacheKey}.json`);
    // Simulate a pre-fix cache: no modelFingerprint, with a stale generatedAt.
    const stale = JSON.parse(readFileSync(cacheFile, 'utf8'));
    delete stale.modelFingerprint;
    stale.generatedAt = '2026-05-04T19:29:34.353Z';
    writeFileSync(cacheFile, JSON.stringify(stale));
    const m2 = buildProjectModel(dir, { skipProbe: true });
    // Rebuilt: generatedAt advanced AND fingerprint repopulated.
    expect(m2.generatedAt).not.toBe('2026-05-04T19:29:34.353Z');
    expect(m2.modelFingerprint).toBe(MODEL_FINGERPRINT);
  });

  it('discards cached model when modelFingerprint differs (introspector changed)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const m1 = buildProjectModel(dir, { skipProbe: true });
    const cacheFile = path.join(dir, '.kmp-test-runner', 'cache', `model-${m1.cacheKey}.json`);
    const stale = JSON.parse(readFileSync(cacheFile, 'utf8'));
    stale.modelFingerprint = 'deadbeefcafe';
    stale.generatedAt = '2026-05-04T19:29:34.353Z';
    writeFileSync(cacheFile, JSON.stringify(stale));
    const m2 = buildProjectModel(dir, { skipProbe: true });
    expect(m2.generatedAt).not.toBe('2026-05-04T19:29:34.353Z');
    expect(m2.modelFingerprint).toBe(MODEL_FINGERPRINT);
  });

  // v0.8.0 cache subdir migration — dual-read fallback for legacy `.kmp-test-runner-cache/`
  it('writes new cache to .kmp-test-runner/cache/ (NOT to legacy .kmp-test-runner-cache/)', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    const m = buildProjectModel(dir, { skipProbe: true });
    expect(existsSync(path.join(dir, '.kmp-test-runner', 'cache', `model-${m.cacheKey}.json`))).toBe(true);
    expect(existsSync(path.join(dir, '.kmp-test-runner-cache', `model-${m.cacheKey}.json`))).toBe(false);
  });

  it('reads a same-schema cache stored at the legacy `.kmp-test-runner-cache/` path on first upgrade', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    // Build once so we know the cacheKey + a valid model shape, then erase the
    // new-path cache and pre-populate the legacy path with the same model.
    const m1 = buildProjectModel(dir, { skipProbe: true });
    const newCacheFile = path.join(dir, '.kmp-test-runner', 'cache', `model-${m1.cacheKey}.json`);
    const legacyDir = path.join(dir, '.kmp-test-runner-cache');
    const legacyFile = path.join(legacyDir, `model-${m1.cacheKey}.json`);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, readFileSync(newCacheFile, 'utf8'));
    rmSync(newCacheFile);
    // Now buildProjectModel should pick up the legacy cache via dual-read.
    const m2 = buildProjectModel(dir, { skipProbe: true });
    expect(m2.cacheKey).toBe(m1.cacheKey);
    expect(m2.generatedAt).toBe(m1.generatedAt);  // Same cached object, not a rebuild.
  });

  it('legacy cache file is left alone after upgrade — new writes go to .kmp-test-runner/cache/ only', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"');
    // Pre-populate the legacy path with a valid cache, then drop the new path.
    const m1 = buildProjectModel(dir, { skipProbe: true });
    const newCacheFile = path.join(dir, '.kmp-test-runner', 'cache', `model-${m1.cacheKey}.json`);
    const legacyDir = path.join(dir, '.kmp-test-runner-cache');
    const legacyFile = path.join(legacyDir, `model-${m1.cacheKey}.json`);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, readFileSync(newCacheFile, 'utf8'));
    rmSync(newCacheFile);
    // Mutate settings.gradle.kts so the next call gets a different cacheKey
    // (legacy cache miss → rebuild → write to new path).
    writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "y"');
    const m2 = buildProjectModel(dir, { skipProbe: true });
    expect(m2.cacheKey).not.toBe(m1.cacheKey);
    // New path got the rebuilt cache.
    expect(existsSync(path.join(dir, '.kmp-test-runner', 'cache', `model-${m2.cacheKey}.json`))).toBe(true);
    // Legacy file (old cacheKey) preserved — no migration delete.
    expect(existsSync(legacyFile)).toBe(true);
    // No legacy write for the new cacheKey.
    expect(existsSync(path.join(legacyDir, `model-${m2.cacheKey}.json`))).toBe(false);
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

  it('probed jacocoTestReport with null coveragePlugin (root-convention) → coverageTask jacocoTestReport (Bug 1)', () => {
    // The Bug-1 root cause at the model layer: jacoco applied via a root
    // subprojects {} block → static coveragePlugin is null, but the
    // `gradlew tasks --all` probe lists jacocoTestReport. The probed task must
    // win even with no static signal, so resolved.coverageTask is populated and
    // effectiveCoveragePlugin can later upgrade the classification.
    const r = resolveTasksFor(':core-foo', ['compileKotlin', 'test', 'jacocoTestReport'],
      { coveragePlugin: null, type: 'jvm' });
    expect(r.coverageTask).toBe('jacocoTestReport');
  });
});

// v0.8 sub-entry 2 — predictTaskFromSourceSets fallback (BACKLOG line 215-244).
// When `gradleTasks` is null (probe didn't run / cache miss) AND the analysis
// carries `sourceSets` flags, predict the task name by walking the same
// candidate order the populated branch uses. Fixes: Confetti `:shared` with
// `jvm()` target gets `unitTestTask: 'jvmTest'` instead of falling through to
// the hardcoded `desktopTest` and triggering a "Cannot locate tasks" failure.
describe('resolveTasksFor source-set prediction (v0.8 sub-entry 2)', () => {
  it('predicts unitTestTask=jvmTest when gradleTasks null + only jvmTest source set', () => {
    const r = resolveTasksFor(':m', null, {
      type: 'kmp',
      sourceSets: { jvmTest: true },
    });
    expect(r.unitTestTask).toBe('jvmTest');
  });

  it('predicts unitTestTask=desktopTest with precedence over jvmTest when both source sets present', () => {
    const r = resolveTasksFor(':m', null, {
      type: 'kmp',
      sourceSets: { desktopTest: true, jvmTest: true },
    });
    expect(r.unitTestTask).toBe('desktopTest');
  });

  it('JS-only KMP module: predicts unitTestTask=jsTest when no JVM source sets present', () => {
    const r = resolveTasksFor(':m', null, {
      type: 'kmp',
      sourceSets: { jsTest: true },
    });
    expect(r.unitTestTask).toBe('jsTest');
    expect(r.webTestTask).toBe('jsTest');
  });

  it('predicts iosTestTask=iosSimulatorArm64Test with precedence over iosX64Test when both present', () => {
    const r = resolveTasksFor(':m', null, {
      type: 'kmp',
      sourceSets: { iosSimulatorArm64Test: true, iosX64Test: true, iosArm64Test: true },
    });
    expect(r.iosTestTask).toBe('iosSimulatorArm64Test');
  });

  it('predicts macosTestTask=macosArm64Test with precedence over macosX64Test when both present', () => {
    const r = resolveTasksFor(':m', null, {
      type: 'kmp',
      sourceSets: { macosArm64Test: true, macosX64Test: true },
    });
    expect(r.macosTestTask).toBe('macosArm64Test');
  });

  it('returns null fields when gradleTasks null + analysis has empty sourceSets', () => {
    const r = resolveTasksFor(':m', null, {
      type: 'kmp',
      sourceSets: {},
    });
    expect(r.unitTestTask).toBeNull();
    expect(r.deviceTestTask).toBeNull();
    expect(r.webTestTask).toBeNull();
    expect(r.iosTestTask).toBeNull();
    expect(r.macosTestTask).toBeNull();
  });

  it('deviceTestTask remains null even with android source sets (task name != source-set name)', () => {
    // The populated branch picks `connectedDebugAndroidTest` etc. — those task
    // names do NOT match any source set. Prediction can't infer them from
    // source-set walking; consumers fall back to gradle probe or static defaults.
    const r = resolveTasksFor(':m', null, {
      type: 'kmp',
      sourceSets: { androidInstrumentedTest: true, androidTest: true },
    });
    expect(r.deviceTestTask).toBeNull();
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

describe('probeGradleTasksCached spawn wrapper (regression for v0.9 EINVAL bug)', () => {
  // Surfaced 2026-05-07 against private-lib core-* during v0.9.0
  // pre-release validation. probeGradleTasksCached invoked
  // `spawnSync(gradlewPath, [...])` directly. Windows hosts (Node 18.20.2+)
  // returned `EINVAL` because gradlew.bat can't be spawned directly
  // post-CVE-2024-27980. The probe failed silently, gradleTasks stayed
  // unpopulated, and 5 KMP modules whose targets came from a convention plugin
  // (`com.example.private.shared.kmp.library` declares `jvm("desktop")` / `iosX64()` /
  // etc. inside the plugin, not in the consumer build.gradle.kts) reported
  // test_tasks as all-null → kmp-test parallel/coverage refused to dispatch
  // them with `errors[].code: "no_test_modules"`.
  //
  // Fix: route through `spawnGradle` from `lib/orchestrator-utils.js` which
  // wraps via `cmd.exe /d /s /c` on Windows. This was the same bug class fixed
  // in v0.8 sub-entry-1 for the orchestrators; the gradle-tasks probe was the
  // last spawn site missed.
  //
  // This test is structural — if a future refactor reverts to raw spawnSync,
  // it'll fail at module-import time.

  // PR-08 (refactor pre-v0.10): probeGradleTasksCached + the spawnGradle
  // wrapper import moved to lib/project/cache.js. The structural assertion
  // is the same — only the file path changed.
  it('lib/project/cache.js imports spawnGradle from orchestrator-utils', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib/project/cache.js'), 'utf8');
    expect(src).toMatch(/import\s*\{\s*spawnGradle\s*\}\s*from\s*['"]\.\.\/orchestrators\/orchestrator-utils\.js['"]/);
  });

  it('probeGradleTasksCached invokes spawnGradle(spawnSync, …), never raw spawnSync(wrapperPath, …)', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib/project/cache.js'), 'utf8');
    const probeBlock = src.match(/function\s+probeGradleTasksCached[\s\S]+?\n\}/);
    expect(probeBlock).toBeTruthy();
    expect(probeBlock[0]).toMatch(/spawnGradle\s*\(\s*spawnSync\s*,\s*wrapperPath\s*,/);
    expect(probeBlock[0]).not.toMatch(/spawnSync\s*\(\s*wrapperPath\s*,/);
  });
});
