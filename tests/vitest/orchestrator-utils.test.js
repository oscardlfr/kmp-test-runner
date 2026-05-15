// SPDX-License-Identifier: MIT
// Tests for lib/orchestrator-utils.js — focused on the v0.9 step 4 isolated
// cache helpers (parseIsolatedArgs / resolveIsolatedDir / injectProjectCacheDir
// / shouldKeepIsolated / cleanupIsolatedDir / buildIsolatedField).
//
// The pre-v0.9.4 helpers (stripKotlinComments, discoverIncludedModules,
// spawnGradle, readPackageName, defaultAdbProbe) are exercised indirectly via
// the orchestrator tests and don't need duplicate coverage here.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseIsolatedArgs,
  resolveIsolatedDir,
  injectProjectCacheDir,
  shouldKeepIsolated,
  cleanupIsolatedDir,
  buildIsolatedField,
  splitCsv,
  globToRegex,
  matchModuleFilter,
  stripKotlinComments,
  discoverIncludedModules,
  readBuildFile,
  readPackageName,
  splitGradleArgs,
  expandNoCoverageAlias,
} from '../../lib/orchestrators/orchestrator-utils.js';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

describe('parseIsolatedArgs', () => {
  it('returns enabled:false when no --isolated flag present', () => {
    const r = parseIsolatedArgs(['--module-filter', '*core*', '--variant', 'debug']);
    expect(r.enabled).toBe(false);
    expect(r.cacheDir).toBe(null);
    expect(r.noLock).toBe(false);
    expect(r.args).toEqual(['--module-filter', '*core*', '--variant', 'debug']);
  });

  it('strips bare --isolated and flips enabled', () => {
    const r = parseIsolatedArgs(['--isolated', '--module-filter', 'X']);
    expect(r.enabled).toBe(true);
    expect(r.cacheDir).toBe(null);
    expect(r.noLock).toBe(false);
    expect(r.args).toEqual(['--module-filter', 'X']);
  });

  it('strips --isolated-cache-dir <path> and implies enabled', () => {
    const r = parseIsolatedArgs(['--isolated-cache-dir', '/tmp/cache', '--module-filter', 'X']);
    expect(r.enabled).toBe(true);
    expect(r.cacheDir).toBe('/tmp/cache');
    expect(r.args).toEqual(['--module-filter', 'X']);
  });

  it('strips --isolated-no-lock independently', () => {
    const r = parseIsolatedArgs(['--isolated', '--isolated-no-lock', '--variant', 'debug']);
    expect(r.enabled).toBe(true);
    expect(r.noLock).toBe(true);
    expect(r.args).toEqual(['--variant', 'debug']);
  });

  // v0.9 session 2 Bug-F — `--isolated-no-lock` alone must imply enabled.
  // Pre-fix this returned `{enabled:false, noLock:true}` because the branch
  // didn't mirror `--isolated-cache-dir`'s implication. The cli.js peek and
  // this orchestrator-side parser must agree on the shape.
  it('Bug-F: --isolated-no-lock alone implies enabled', () => {
    const r = parseIsolatedArgs(['--isolated-no-lock', '--variant', 'debug']);
    expect(r.enabled).toBe(true);
    expect(r.noLock).toBe(true);
    expect(r.cacheDir).toBe(null);
    expect(r.args).toEqual(['--variant', 'debug']);
  });

  it('handles all three flags together in any order', () => {
    const r = parseIsolatedArgs(['--variant', 'debug', '--isolated-no-lock', '--isolated', '--isolated-cache-dir', '/x']);
    expect(r.enabled).toBe(true);
    expect(r.cacheDir).toBe('/x');
    expect(r.noLock).toBe(true);
    expect(r.args).toEqual(['--variant', 'debug']);
  });
});

describe('resolveIsolatedDir', () => {
  it('returns null when isolation disabled', () => {
    const dir = resolveIsolatedDir('/tmp/proj', { enabled: false });
    expect(dir).toBe(null);
  });

  it('creates default <projectRoot>/.kmp-test-runner/cache-isolated/<runId> dir', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-iso-'));
    const dir = resolveIsolatedDir(workDir, { enabled: true });
    expect(dir).toBeTruthy();
    expect(dir.startsWith(path.join(workDir, '.kmp-test-runner', 'cache-isolated'))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('honors absolute --isolated-cache-dir path', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-iso-'));
    const userDir = path.join(workDir, 'my-cache');
    const dir = resolveIsolatedDir(workDir, { enabled: true, cacheDir: userDir });
    expect(dir).toBe(userDir);
    expect(existsSync(userDir)).toBe(true);
  });

  it('resolves relative --isolated-cache-dir against projectRoot', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-iso-'));
    const dir = resolveIsolatedDir(workDir, { enabled: true, cacheDir: 'relative-cache' });
    expect(dir).toBe(path.resolve(workDir, 'relative-cache'));
    expect(existsSync(dir)).toBe(true);
  });

  it('skips mkdir when dryRun:true', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-iso-'));
    const dir = resolveIsolatedDir(workDir, { enabled: true, dryRun: true });
    expect(dir).toBeTruthy();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('injectProjectCacheDir', () => {
  it('returns args unchanged when dir is null', () => {
    const args = ['compileKotlin', '--parallel'];
    expect(injectProjectCacheDir(args, null)).toEqual(args);
  });

  it('appends --project-cache-dir <dir> when dir is set', () => {
    const args = ['compileKotlin', '--parallel'];
    const out = injectProjectCacheDir(args, '/tmp/cache');
    expect(out).toEqual(['compileKotlin', '--parallel', '--project-cache-dir', '/tmp/cache']);
    // Original array untouched (immutability).
    expect(args).toEqual(['compileKotlin', '--parallel']);
  });
});

describe('shouldKeepIsolated', () => {
  it('returns true when userSupplied', () => {
    expect(shouldKeepIsolated({ userSupplied: true, env: {} })).toBe(true);
  });

  it('returns true when KMP_TEST_KEEP_ISOLATED=1', () => {
    expect(shouldKeepIsolated({ userSupplied: false, env: { KMP_TEST_KEEP_ISOLATED: '1' } })).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(shouldKeepIsolated({ userSupplied: false, env: { KMP_TEST_KEEP_ISOLATED: '0' } })).toBe(false);
    expect(shouldKeepIsolated({ userSupplied: false, env: {} })).toBe(false);
  });
});

describe('cleanupIsolatedDir', () => {
  it('returns false when dir is null', () => {
    expect(cleanupIsolatedDir(null)).toBe(false);
  });

  it('removes a real auto-generated dir', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-iso-'));
    const target = path.join(workDir, 'cache-isolated', 'r1');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'sentinel'), 'x');
    expect(existsSync(target)).toBe(true);
    expect(cleanupIsolatedDir(target, { env: {} })).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('preserves user-supplied dirs', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-iso-'));
    const target = path.join(workDir, 'user-cache');
    mkdirSync(target, { recursive: true });
    expect(cleanupIsolatedDir(target, { userSupplied: true, env: {} })).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it('preserves dirs when KMP_TEST_KEEP_ISOLATED=1', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-iso-'));
    const target = path.join(workDir, 'kept');
    mkdirSync(target, { recursive: true });
    expect(cleanupIsolatedDir(target, { userSupplied: false, env: { KMP_TEST_KEEP_ISOLATED: '1' } })).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});

describe('buildIsolatedField', () => {
  it('returns disabled-shape no-op when enabled:false', () => {
    expect(buildIsolatedField({ enabled: false })).toEqual({
      enabled: false, cache_dir: null, kept: false, locked: true,
    });
  });

  it('emits enabled shape with cache_dir + kept + locked', () => {
    expect(buildIsolatedField({
      enabled: true,
      cacheDir: '/tmp/x',
      kept: true,
      locked: false,
    })).toEqual({
      enabled: true, cache_dir: '/tmp/x', kept: true, locked: false,
    });
  });

  it('coerces null cache_dir consistently', () => {
    expect(buildIsolatedField({ enabled: true }).cache_dir).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// v0.9 step 9.3 (Bug #3) — module-filter helpers (splitCsv, globToRegex,
// matchModuleFilter). Lifted from parallel-orchestrator into shared utils so
// android + benchmark + describe all use the same normalization.
// ---------------------------------------------------------------------------
describe('splitCsv', () => {
  it('splits comma list and trims whitespace', () => {
    expect(splitCsv('a, b ,c')).toEqual(['a', 'b', 'c']);
  });
  it('drops empties + handles falsy input', () => {
    expect(splitCsv('')).toEqual([]);
    expect(splitCsv(null)).toEqual([]);
    expect(splitCsv(undefined)).toEqual([]);
    expect(splitCsv('a,,b,')).toEqual(['a', 'b']);
  });
});

describe('globToRegex', () => {
  it('translates * to .* and anchors both ends', () => {
    expect(globToRegex('*').test('anything')).toBe(true);
    expect(globToRegex('foo-*').test('foo-bar')).toBe(true);
    expect(globToRegex('foo-*').test('xfoo-bar')).toBe(false);
    expect(globToRegex('*-bar').test('foo-bar')).toBe(true);
  });
  it('translates ? to . (single-char wildcard)', () => {
    expect(globToRegex('foo-?').test('foo-x')).toBe(true);
    expect(globToRegex('foo-?').test('foo-xx')).toBe(false);
  });
  it('escapes regex metacharacters in literal segments', () => {
    expect(globToRegex('foo.bar').test('foo.bar')).toBe(true);
    expect(globToRegex('foo.bar').test('fooXbar')).toBe(false);
  });
});

describe('matchModuleFilter — substring vs glob semantics', () => {
  // Pre-v0.9-step-9.3 behavior contract preserved:
  // - bare strings = substring (android + benchmark legacy)
  // - patterns with * or ? = glob (parallel legacy)
  it('empty / "*" filter matches everything', () => {
    expect(matchModuleFilter('foo', '')).toBe(true);
    expect(matchModuleFilter('foo', '*')).toBe(true);
    expect(matchModuleFilter('foo', null)).toBe(true);
    expect(matchModuleFilter('foo', undefined)).toBe(true);
  });

  it('bare string = substring (android/benchmark contract)', () => {
    expect(matchModuleFilter('feature-auth', 'feature')).toBe(true);
    expect(matchModuleFilter('feature-auth', 'auth')).toBe(true);
    expect(matchModuleFilter('feature-auth', 'core')).toBe(false);
  });

  it('glob pattern = anchored match', () => {
    expect(matchModuleFilter('feature-auth', 'feature-*')).toBe(true);
    expect(matchModuleFilter('feature-auth', 'feature')).toBe(true);  // substring
    // Glob "feature" (no wildcard) is treated as substring; "feature-*" is glob.
    expect(matchModuleFilter('core-feature-auth', 'feature-*')).toBe(false);  // anchored
    expect(matchModuleFilter('core-feature-auth', 'feature')).toBe(true);     // substring
  });

  it('comma-separated CSV: any pattern matches', () => {
    expect(matchModuleFilter('core', 'core,domain')).toBe(true);
    expect(matchModuleFilter('domain', 'core,domain')).toBe(true);
    expect(matchModuleFilter('shared', 'core,domain')).toBe(false);
  });

  // Bug #3 repro: `:`-prefix dual-test.
  it(':-prefix filter matches colon-stripped name (Bug #3 repro)', () => {
    expect(matchModuleFilter('benchmark', ':benchmark')).toBe(true);
    expect(matchModuleFilter(':benchmark', ':benchmark')).toBe(true);
    expect(matchModuleFilter('benchmark', 'benchmark')).toBe(true);
    expect(matchModuleFilter(':benchmark', 'benchmark')).toBe(true);
  });

  it(':-prefix glob matches both colon-stripped and colon-prefixed', () => {
    expect(matchModuleFilter('benchmark', ':bench*')).toBe(true);
    expect(matchModuleFilter(':bench-store', ':bench*')).toBe(true);
    expect(matchModuleFilter('bench-store', ':bench*')).toBe(true);
  });

  it('nested module path matches by short suffix', () => {
    // gradle-internal: ':feature:auth:impl' → bare 'feature:auth:impl'
    // Glob 'impl' is substring (no wildcard) → matches anywhere in name.
    expect(matchModuleFilter('feature:auth:impl', 'impl')).toBe(true);
    // Anchored glob 'impl' (we don't support implicit anchoring on bare strings).
    // Use 'impl*' for prefix or '*impl' for suffix.
    expect(matchModuleFilter('feature:auth:impl', '*:impl')).toBe(true);
  });

  it('comma-separated mix of substring + glob', () => {
    expect(matchModuleFilter('sample-result', 'sample-result,bench-*')).toBe(true);
    expect(matchModuleFilter('bench-store', 'sample-result,bench-*')).toBe(true);
    expect(matchModuleFilter('feature-auth', 'sample-result,bench-*')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 #11 (2026-05-11) — direct tests for the remaining exported helpers
// previously covered only via per-orchestrator integration tests. Pins edge
// cases + raises branch coverage on lib/orchestrators/orchestrator-utils.js.
// ---------------------------------------------------------------------------

describe('stripKotlinComments', () => {
  it('strips bare line comment', () => {
    expect(stripKotlinComments('// foo\n')).toBe('\n');
  });
  it('strips inline line comment, keeps code before', () => {
    expect(stripKotlinComments('plugins {} // trailing comment')).toBe('plugins {} ');
  });
  it('strips block comment in one line', () => {
    expect(stripKotlinComments('a /* mid */ b')).toBe('a  b');
  });
  it('strips multi-line block comment', () => {
    expect(stripKotlinComments('a /* line1\nline2\n */ b')).toBe('a  b');
  });
  it('preserves URL-style `://` (the load-bearing reason the regex has [^:])', () => {
    // Pre-fix the comment-stripper happily ate maven URL declarations.
    expect(stripKotlinComments('url("https://repo.example.com")')).toBe('url("https://repo.example.com")');
  });
  it('returns empty input unchanged', () => {
    expect(stripKotlinComments('')).toBe('');
  });
  it('returns input with no comments unchanged', () => {
    expect(stripKotlinComments('plugins { id("foo") }')).toBe('plugins { id("foo") }');
  });
});

describe('splitGradleArgs', () => {
  it('returns [] for empty / null / undefined', () => {
    expect(splitGradleArgs('')).toEqual([]);
    expect(splitGradleArgs(null)).toEqual([]);
    expect(splitGradleArgs(undefined)).toEqual([]);
  });
  it('whitespace-only input → []', () => {
    expect(splitGradleArgs('   \t  ')).toEqual([]);
  });
  it('splits multi-token string on any whitespace', () => {
    expect(splitGradleArgs('--no-parallel -Pfoo=bar')).toEqual(['--no-parallel', '-Pfoo=bar']);
  });
  it('collapses tabs + newlines into single whitespace boundaries', () => {
    expect(splitGradleArgs('a\tb\nc')).toEqual(['a', 'b', 'c']);
  });
  it('drops empty segments (leading + trailing whitespace)', () => {
    expect(splitGradleArgs('  --flag  value  ')).toEqual(['--flag', 'value']);
  });
});

describe('expandNoCoverageAlias', () => {
  it('aliases bare --no-coverage to [--coverage-tool, none]', () => {
    expect(expandNoCoverageAlias(['--no-coverage'])).toEqual(['--coverage-tool', 'none']);
  });
  it('preserves other args around --no-coverage', () => {
    expect(expandNoCoverageAlias(['--variant', 'debug', '--no-coverage', '--module-filter', 'X']))
      .toEqual(['--variant', 'debug', '--coverage-tool', 'none', '--module-filter', 'X']);
  });
  it('passes argv unchanged when no --no-coverage present', () => {
    expect(expandNoCoverageAlias(['--variant', 'debug'])).toEqual(['--variant', 'debug']);
  });
  it('does NOT alias --no-coverage=foo (typo — alias runs before POSIX split)', () => {
    // Docstring contract: alias expansion runs BEFORE expandPosixEqualsForm so
    // `--no-coverage=foo` (which doesn't exact-match `--no-coverage`) falls
    // through the alias check, then POSIX-splits into [--no-coverage, foo].
    expect(expandNoCoverageAlias(['--no-coverage=foo'])).toEqual(['--no-coverage', 'foo']);
  });
  it('also runs POSIX equals-form expansion on the result', () => {
    expect(expandNoCoverageAlias(['--variant=debug', '--no-coverage']))
      .toEqual(['--variant', 'debug', '--coverage-tool', 'none']);
  });
  it('handles multiple --no-coverage tokens (each expands)', () => {
    expect(expandNoCoverageAlias(['--no-coverage', '--no-coverage']))
      .toEqual(['--coverage-tool', 'none', '--coverage-tool', 'none']);
  });
});

describe('discoverIncludedModules', () => {
  it('returns [] when settings.gradle.kts is missing', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-disc-'));
    expect(discoverIncludedModules(workDir)).toEqual([]);
  });
  it('picks up single-arg include(":foo")', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-disc-'));
    writeFileSync(path.join(workDir, 'settings.gradle.kts'), 'include(":foo")\ninclude(":bar")\n');
    expect(discoverIncludedModules(workDir).sort()).toEqual(['bar', 'foo']);
  });
  it('picks up multi-arg include(":a", ":b")', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-disc-'));
    writeFileSync(path.join(workDir, 'settings.gradle.kts'), 'include(":alpha", ":beta", ":gamma")\n');
    expect(discoverIncludedModules(workDir).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
  it('strips comments so //include(":phantom") does not surface', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-disc-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      '// include(":phantom")\n/* include(":ghost") */\ninclude(":real")\n',
    );
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });
  it('preserves nested colon paths', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-disc-'));
    writeFileSync(path.join(workDir, 'settings.gradle.kts'), 'include(":core:network")\n');
    expect(discoverIncludedModules(workDir)).toEqual(['core:network']);
  });
  it('dedupes across single + multi forms', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-disc-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'include(":foo")\ninclude(":foo", ":bar")\n',
    );
    expect(discoverIncludedModules(workDir).sort()).toEqual(['bar', 'foo']);
  });
});

describe('readBuildFile', () => {
  it('returns null when build.gradle.kts is missing', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-rbf-'));
    expect(readBuildFile(workDir, 'feature:auth')).toBeNull();
  });
  it('reads and comment-strips build.gradle.kts for a flat module', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-rbf-'));
    const moduleDir = path.join(workDir, 'core');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      path.join(moduleDir, 'build.gradle.kts'),
      '// header comment\nplugins { id("kotlin") }\n',
    );
    const content = readBuildFile(workDir, 'core');
    expect(content).toBeTruthy();
    expect(content).toContain('plugins { id("kotlin") }');
    expect(content).not.toContain('header comment');
  });
  it('resolves nested module path via `:` separator', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-rbf-'));
    const moduleDir = path.join(workDir, 'core', 'network');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, 'build.gradle.kts'), 'plugins { id("kotlin") }');
    expect(readBuildFile(workDir, 'core:network')).toBe('plugins { id("kotlin") }');
  });
});

describe('readPackageName', () => {
  it('reads package= from src/main/AndroidManifest.xml', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-mfst-'));
    const manifestDir = path.join(workDir, 'app', 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      path.join(manifestDir, 'AndroidManifest.xml'),
      '<manifest package="com.example.app" xmlns:android="http://schemas.android.com/apk/res/android"/>',
    );
    expect(readPackageName(workDir, 'app')).toBe('com.example.app');
  });
  it('falls back to src/androidMain/AndroidManifest.xml when src/main is absent', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-mfst-'));
    const manifestDir = path.join(workDir, 'shared', 'src', 'androidMain');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      path.join(manifestDir, 'AndroidManifest.xml'),
      '<manifest package="com.example.shared"/>',
    );
    expect(readPackageName(workDir, 'shared')).toBe('com.example.shared');
  });
  it('returns null when neither manifest exists', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-mfst-'));
    expect(readPackageName(workDir, 'phantom')).toBeNull();
  });
  it('returns null when manifest exists but lacks package= attribute', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-mfst-'));
    const manifestDir = path.join(workDir, 'lib', 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'AndroidManifest.xml'), '<manifest/>');
    expect(readPackageName(workDir, 'lib')).toBeNull();
  });
  it('resolves nested module path via `:` separator', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-mfst-'));
    const manifestDir = path.join(workDir, 'feature', 'auth', 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      path.join(manifestDir, 'AndroidManifest.xml'),
      '<manifest package="com.example.feature.auth"/>',
    );
    expect(readPackageName(workDir, 'feature:auth')).toBe('com.example.feature.auth');
  });
});
