// SPDX-License-Identifier: MIT
// Tests for lib/orchestrator-utils.js — focused on the v0.9 step 4 isolated
// cache helpers (parseIsolatedArgs / resolveIsolatedDir / injectProjectCacheDir
// / shouldKeepIsolated / cleanupIsolatedDir / buildIsolatedField).
//
// The pre-v0.9.4 helpers (stripKotlinComments, discoverIncludedModules,
// spawnGradle, readPackageName, defaultAdbProbe) are exercised indirectly via
// the orchestrator tests and don't need duplicate coverage here.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseIsolatedArgs,
  assessIsolatedRuntimeRace,
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
  coverageToolFromTask,
  effectiveCoveragePlugin,
  effectiveFlavors,
  effectiveHasFlavor,
  shouldAutofixCoverageXml,
  writeCoverageXmlInitScript,
  injectInitScript,
  cleanupInitScript,
  resolveMaxBuffer,
  tailTruncate,
  spawnGradle,
  splitJvmOpts,
  DEFAULT_SPAWN_MAX_BUFFER_MB,
  parseAdbDevicesOutput,
  resolveAdbDevice,
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

  // L1 (2026-06-09 audit) — dangling / empty `--isolated-cache-dir`. Pre-fix
  // the `i + 1 < args.length` guard left the flag unconsumed: isolation
  // silently OFF + the dangling token leaked into the orchestrator args.
  it('L1: errors is [] on every happy path', () => {
    expect(parseIsolatedArgs([]).errors).toEqual([]);
    expect(parseIsolatedArgs(['--isolated']).errors).toEqual([]);
    expect(parseIsolatedArgs(['--isolated-cache-dir', '/x']).errors).toEqual([]);
  });

  it('L1: dangling --isolated-cache-dir (last token) pushes invalid_flag_value, no isolation, no leak', () => {
    const r = parseIsolatedArgs(['--module-filter', 'X', '--isolated-cache-dir']);
    expect(r.enabled).toBe(false);
    expect(r.cacheDir).toBe(null);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      code: 'invalid_flag_value',
      flag: '--isolated-cache-dir',
      value: null,
    });
    // The flag must NOT leak into the residual args the orchestrator parses.
    expect(r.args).toEqual(['--module-filter', 'X']);
  });

  it('L1: explicit-empty value pushes invalid_flag_value with value:"" and consumes the token', () => {
    const r = parseIsolatedArgs(['--isolated-cache-dir', '', '--module-filter', 'X']);
    expect(r.enabled).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].value).toBe('');
    expect(r.args).toEqual(['--module-filter', 'X']);
  });

  it('L1: raw `--isolated-cache-dir=` equals-empty form is rejected (in-function expansion)', () => {
    const r = parseIsolatedArgs(['--isolated-cache-dir=', '--module-filter', 'X']);
    expect(r.enabled).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].code).toBe('invalid_flag_value');
    expect(r.args).toEqual(['--module-filter', 'X']);
  });

  // Runner.js-direct invocations reach parseIsolatedArgs with the raw equals
  // form (orchestrator parsers expand equals only AFTER this strip). Pre-fix
  // the token fell through unparsed and isolation silently no-opped.
  it('L1: raw `--isolated-cache-dir=/x` equals form engages isolation on runner.js-direct routes', () => {
    const r = parseIsolatedArgs(['--isolated-cache-dir=/x', '--module-filter', 'X']);
    expect(r.enabled).toBe(true);
    expect(r.cacheDir).toBe('/x');
    expect(r.errors).toEqual([]);
    expect(r.args).toEqual(['--module-filter', 'X']);
  });

  it('L1: dangling error does not mask flags seen earlier in the argv', () => {
    const r = parseIsolatedArgs(['--isolated-no-lock', '--isolated-cache-dir']);
    expect(r.noLock).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.errors).toHaveLength(1);
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

describe('coverageToolFromTask', () => {
  it('maps jacocoTestReport → jacoco', () => {
    expect(coverageToolFromTask('jacocoTestReport')).toBe('jacoco');
  });
  it('maps any koverXmlReport* variant → kover', () => {
    expect(coverageToolFromTask('koverXmlReport')).toBe('kover');
    expect(coverageToolFromTask('koverXmlReportDebug')).toBe('kover');
    expect(coverageToolFromTask('koverXmlReportDesktop')).toBe('kover');
  });
  it('maps an AGP per-variant unit-test coverage report → jacoco (Finding #2)', () => {
    expect(coverageToolFromTask('createDemoDebugUnitTestCoverageReport')).toBe('jacoco');
    expect(coverageToolFromTask('createProdDebugUnitTestCoverageReport')).toBe('jacoco');
    expect(coverageToolFromTask('createDebugUnitTestCoverageReport')).toBe('jacoco');
  });
  it('returns null for non-coverage task names', () => {
    expect(coverageToolFromTask('jvmTest')).toBeNull();
    expect(coverageToolFromTask('connectedDebugAndroidTest')).toBeNull();
  });
  it('returns null for null / undefined / non-string input', () => {
    expect(coverageToolFromTask(null)).toBeNull();
    expect(coverageToolFromTask(undefined)).toBeNull();
    expect(coverageToolFromTask(42)).toBeNull();
    expect(coverageToolFromTask('')).toBeNull();
  });
});

describe('effectiveCoveragePlugin', () => {
  it('returns the static coveragePlugin when present (static wins)', () => {
    // Even if the probe resolved a different task, static detection is the
    // higher-specificity signal and wins.
    const entry = { coveragePlugin: 'kover', resolved: { coverageTask: 'jacocoTestReport' } };
    expect(effectiveCoveragePlugin(entry)).toBe('kover');
  });
  it('falls back to resolved.coverageTask when static is null (root-convention case)', () => {
    // The Bug-1 scenario: jacoco applied via root subprojects {} → static null,
    // but the gradle probe found jacocoTestReport.
    const entry = { coveragePlugin: null, resolved: { coverageTask: 'jacocoTestReport' } };
    expect(effectiveCoveragePlugin(entry)).toBe('jacoco');
  });
  it('maps a probed kover task to kover', () => {
    const entry = { coveragePlugin: null, resolved: { coverageTask: 'koverXmlReportDebug' } };
    expect(effectiveCoveragePlugin(entry)).toBe('kover');
  });
  it('returns null when neither static nor probe has a signal', () => {
    expect(effectiveCoveragePlugin({ coveragePlugin: null, resolved: { coverageTask: null } })).toBeNull();
    expect(effectiveCoveragePlugin({ coveragePlugin: null, resolved: {} })).toBeNull();
  });
  it('tolerates a missing resolved key (bare unit-test stubs)', () => {
    // discoverCoverageModules tests pass {coveragePlugin, type} with no resolved.
    expect(effectiveCoveragePlugin({ coveragePlugin: 'jacoco' })).toBe('jacoco');
    expect(effectiveCoveragePlugin({ coveragePlugin: null })).toBeNull();
  });
  it('returns null for null / undefined entry', () => {
    expect(effectiveCoveragePlugin(null)).toBeNull();
    expect(effectiveCoveragePlugin(undefined)).toBeNull();
  });
  it('falls back to flavored coverageReportTasks when coverageTask misses them (Finding #2)', () => {
    // Convention-jacoco + flavors: static null, no jacocoTestReport task, only
    // per-variant AGP report tasks in the probe → still classified jacoco.
    const entry = { coveragePlugin: null, resolved: {
      coverageTask: null,
      coverageReportTasks: ['createDemoDebugUnitTestCoverageReport', 'createProdDebugUnitTestCoverageReport'],
    } };
    expect(effectiveCoveragePlugin(entry)).toBe('jacoco');
  });
});

describe('effectiveFlavors', () => {
  it('returns probe-recovered flavor names', () => {
    expect(effectiveFlavors({ resolved: { flavors: ['demo', 'prod'] } })).toEqual(['demo', 'prod']);
  });
  it('returns [] when no resolved.flavors (missing / empty / bare stub / null)', () => {
    expect(effectiveFlavors({ resolved: { flavors: [] } })).toEqual([]);
    expect(effectiveFlavors({ resolved: {} })).toEqual([]);
    expect(effectiveFlavors({})).toEqual([]);
    expect(effectiveFlavors(null)).toEqual([]);
    expect(effectiveFlavors(undefined)).toEqual([]);
  });
});

describe('effectiveHasFlavor', () => {
  it('true when static hasFlavor is set (per-module productFlavors)', () => {
    expect(effectiveHasFlavor({ hasFlavor: true })).toBe(true);
  });
  it('true when the probe recovered flavors but static is blind (convention case)', () => {
    expect(effectiveHasFlavor({ hasFlavor: false, resolved: { flavors: ['demo'] } })).toBe(true);
  });
  it('false when neither signal is present', () => {
    expect(effectiveHasFlavor({ hasFlavor: false, resolved: { flavors: [] } })).toBe(false);
    expect(effectiveHasFlavor({})).toBe(false);
    expect(effectiveHasFlavor(null)).toBe(false);
    expect(effectiveHasFlavor(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JaCoCo XML auto-fix init-script helpers (Finding A)
// ---------------------------------------------------------------------------
describe('coverage XML autofix init-script helpers', () => {
  describe('shouldAutofixCoverageXml', () => {
    it('true when a jacoco report task is present and not opted out', () => {
      expect(shouldAutofixCoverageXml([':app:jacocoTestReport'], {})).toBe(true);
      expect(shouldAutofixCoverageXml([':a:createDebugUnitTestCoverageReport'], {})).toBe(true);
    });
    it('false when opted out via --no-coverage-xml-autofix', () => {
      expect(shouldAutofixCoverageXml([':app:jacocoTestReport'], { noCoverageXmlAutofix: true })).toBe(false);
    });
    it('false for a pure-Kover task list (no-op)', () => {
      expect(shouldAutofixCoverageXml([':a:koverXmlReportDebug', ':b:koverXmlReport'], {})).toBe(false);
    });
    it('false when the user already passed their own --init-script via --gradle-args', () => {
      expect(shouldAutofixCoverageXml([':app:jacocoTestReport'], { gradleArgs: ['--init-script', 'my.gradle'] })).toBe(false);
      expect(shouldAutofixCoverageXml([':app:jacocoTestReport'], { gradleArgs: ['-I', 'my.gradle'] })).toBe(false);
      expect(shouldAutofixCoverageXml([':app:jacocoTestReport'], { gradleArgs: ['--init-script=my.gradle'] })).toBe(false);
    });
    it('false for an empty or non-array task list', () => {
      expect(shouldAutofixCoverageXml([], {})).toBe(false);
      expect(shouldAutofixCoverageXml(null, {})).toBe(false);
    });
  });

  describe('writeCoverageXmlInitScript', () => {
    it('writes a .init.gradle under .kmp-test-runner/init-scripts that forces jacoco XML on', () => {
      workDir = mkdtempSync(path.join(tmpdir(), 'kmp-initscript-'));
      const p = writeCoverageXmlInitScript(workDir);
      expect(p).toBeTruthy();
      expect(p.endsWith('.init.gradle')).toBe(true);
      expect(p.replace(/\\/g, '/')).toContain('.kmp-test-runner/init-scripts/');
      expect(existsSync(p)).toBe(true);
      const body = readFileSync(p, 'utf8');
      expect(body).toContain('org.gradle.testing.jacoco.tasks.JacocoReport');
      expect(body).toContain('xml.required = true');
      expect(body).toContain('configureEach');
    });
  });

  describe('injectInitScript', () => {
    it('appends --init-script <path> as a new array (no mutation)', () => {
      const base = ['build', '--parallel'];
      expect(injectInitScript(base, '/tmp/x.init.gradle'))
        .toEqual(['build', '--parallel', '--init-script', '/tmp/x.init.gradle']);
      expect(base).toEqual(['build', '--parallel']);
    });
    it('no-op on null/empty path', () => {
      const base = ['build'];
      expect(injectInitScript(base, null)).toBe(base);
      expect(injectInitScript(base, '')).toBe(base);
    });
  });

  describe('cleanupInitScript', () => {
    it('removes the file by default', () => {
      workDir = mkdtempSync(path.join(tmpdir(), 'kmp-initscript-'));
      const p = writeCoverageXmlInitScript(workDir);
      expect(existsSync(p)).toBe(true);
      expect(cleanupInitScript(p)).toBe(true);
      expect(existsSync(p)).toBe(false);
    });
    it('keeps the file when KMP_TEST_KEEP_INIT_SCRIPT=1', () => {
      workDir = mkdtempSync(path.join(tmpdir(), 'kmp-initscript-'));
      const p = writeCoverageXmlInitScript(workDir);
      expect(cleanupInitScript(p, { env: { KMP_TEST_KEEP_INIT_SCRIPT: '1' } })).toBe(false);
      expect(existsSync(p)).toBe(true);
    });
    it('no-op (false) on null path', () => {
      expect(cleanupInitScript(null)).toBe(false);
    });
  });
});

describe('discoverIncludedModules — Groovy DSL', () => {
  it('parses Groovy single + multi include into bare names', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-groovy-'));
    writeFileSync(path.join(workDir, 'settings.gradle'),
      "include ':app'\ninclude ':core-lib', ':data'\n");
    expect(discoverIncludedModules(workDir)).toEqual(['app', 'core-lib', 'data']);
  });

  it('still parses Kotlin include(":x") + multi-arg (no regression)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-kts-'));
    writeFileSync(path.join(workDir, 'settings.gradle.kts'),
      'include(":foo")\ninclude(":a", ":b")\n');
    expect(discoverIncludedModules(workDir)).toEqual(['foo', 'a', 'b']);
  });

  it('prefers settings.gradle.kts when both DSL files are present', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-both-'));
    writeFileSync(path.join(workDir, 'settings.gradle.kts'), 'include(":kts")');
    writeFileSync(path.join(workDir, 'settings.gradle'), "include ':groovy'");
    expect(discoverIncludedModules(workDir)).toEqual(['kts']);
  });

  it('ignores commented-out Groovy includes', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-cmt-'));
    writeFileSync(path.join(workDir, 'settings.gradle'),
      "include ':real'\n// include ':phantom'\n");
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });

  it('reads a Groovy module build.gradle via readBuildFile fallback', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-rbf-'));
    mkdirSync(path.join(workDir, 'app'), { recursive: true });
    writeFileSync(path.join(workDir, 'app', 'build.gradle'),
      "apply plugin: 'com.android.library'\n");
    expect(readBuildFile(workDir, 'app')).toContain('com.android.library');
  });
});

describe('discoverIncludedModules — multiline', () => {
  it('parses KTS multiline include(...)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'include(\n  ":app",\n  ":core:domain",\n  ":feature:home"\n)\n',
    );
    expect(discoverIncludedModules(workDir).sort()).toEqual(['app', 'core:domain', 'feature:home']);
  });

  it('strips inline comment inside multiline include block', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-cmt-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'include(\n  ":real",\n  // ":phantom",\n  ":also-real"\n)\n',
    );
    expect(discoverIncludedModules(workDir).sort()).toEqual(['also-real', 'real']);
  });

  it('parses Groovy DSL multiline via trailing comma', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-groovy-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle'),
      "include ':app',\n  ':core',\n  ':feature:home'\n",
    );
    expect(discoverIncludedModules(workDir).sort()).toEqual(['app', 'core', 'feature:home']);
  });

  it('parses multiple multiline include blocks', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-multi-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'include(\n  ":app",\n  ":core"\n)\ninclude(\n  ":feature"\n)\n',
    );
    expect(discoverIncludedModules(workDir).sort()).toEqual(['app', 'core', 'feature']);
  });

  it('does not pick up block-commented multiline include', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-bcmt-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      '/*\ninclude(\n  ":phantom"\n)\n*/\ninclude(":real")\n',
    );
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });

  it('parentheses in adjacent comment do not corrupt paren scan', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-paren-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      '// some(note) about modules\ninclude(":real")\n',
    );
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });

  it('includeBuild(":foo") is not treated as a module include', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-ib-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'includeBuild(":foo")\n',
    );
    expect(discoverIncludedModules(workDir)).toEqual([]);
  });

  it('pluginManagement { includeBuild(...) } is not treated as a module include', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-pm-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'pluginManagement {\n  includeBuild(":plugin")\n}\ninclude(":real")\n',
    );
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });

  it('rootProject.name string containing include(:fake) does not yield a module', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-rp-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'rootProject.name = "include(:fake)"\ninclude(":real")\n',
    );
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });

  it('string literal containing include(":fake") is not treated as a module', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-strlit-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle'),
      "rootProject.name = 'include(\":fake\")'\ninclude(':real')\n",
    );
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });

  it('KTS double-quoted string containing include(\\\":fake\\\") is not treated as a module', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-ktslit-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle.kts'),
      'rootProject.name = "include(\\":fake\\")"\ninclude(":real")\n',
    );
    expect(discoverIncludedModules(workDir)).toEqual(['real']);
  });

  it('Groovy trailing-comma continuation does not swallow an unrelated later line', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-ou-ml-cont-'));
    writeFileSync(
      path.join(workDir, 'settings.gradle'),
      "include ':app',\n  ':core'\nrootProject.name = \":myProject\"\n",
    );
    expect(discoverIncludedModules(workDir).sort()).toEqual(['app', 'core']);
  });
});

describe('resolveMaxBuffer (KMP_GRADLE_MAXBUFFER_MB)', () => {
  it('defaults to DEFAULT_SPAWN_MAX_BUFFER_MB megabytes when the env knob is absent', () => {
    expect(resolveMaxBuffer({})).toBe(DEFAULT_SPAWN_MAX_BUFFER_MB * 1024 * 1024);
  });

  it('honors a positive-integer override (megabytes)', () => {
    expect(resolveMaxBuffer({ KMP_GRADLE_MAXBUFFER_MB: '128' })).toBe(128 * 1024 * 1024);
  });

  it('falls back to the default on non-integer / non-positive values', () => {
    for (const bad of ['lots', '-5', '0', '1.5']) {
      expect(resolveMaxBuffer({ KMP_GRADLE_MAXBUFFER_MB: bad })).toBe(DEFAULT_SPAWN_MAX_BUFFER_MB * 1024 * 1024);
    }
  });
});

describe('tailTruncate', () => {
  it('returns the string unchanged when at or under the cap', () => {
    expect(tailTruncate('abc', 3)).toBe('abc');
    expect(tailTruncate('abc', 10)).toBe('abc');
  });

  it('keeps the LAST maxChars and prepends a truncation marker', () => {
    const s = 'x'.repeat(1000) + 'TAIL';
    const out = tailTruncate(s, 100);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out.startsWith('[kmp-test: aggregate output truncated')).toBe(true);
    // marker (~60 chars) + 100-char tail — far below the original 1004.
    expect(out.length).toBeLessThan(s.length);
  });

  it('passes non-strings through untouched', () => {
    expect(tailTruncate(null, 10)).toBe(null);
    expect(tailTruncate(undefined, 10)).toBe(undefined);
  });
});

describe('spawnGradle maxBuffer choke point', () => {
  const okResult = { status: 0, stdout: '', stderr: '', signal: null, error: null };

  it('injects the resolved default when the caller omits maxBuffer', () => {
    let seen = null;
    const spawn = (cmd, args, opts) => { seen = opts; return okResult; };
    spawnGradle(spawn, '/x/gradlew', ['test'], { cwd: '/x', encoding: 'utf8' });
    expect(seen.maxBuffer).toBe(DEFAULT_SPAWN_MAX_BUFFER_MB * 1024 * 1024);
  });

  it('an explicit caller maxBuffer wins over the default', () => {
    let seen = null;
    const spawn = (cmd, args, opts) => { seen = opts; return okResult; };
    spawnGradle(spawn, '/x/gradlew', ['test'], { cwd: '/x', maxBuffer: 1234 });
    expect(seen.maxBuffer).toBe(1234);
  });

  it('resolves the env knob from the spawn env the caller threads through', () => {
    let seen = null;
    const spawn = (cmd, args, opts) => { seen = opts; return okResult; };
    spawnGradle(spawn, '/x/gradlew', ['test'], { cwd: '/x', env: { KMP_GRADLE_MAXBUFFER_MB: '2' } });
    expect(seen.maxBuffer).toBe(2 * 1024 * 1024);
  });
});

// Single source of truth for the `--isolated` runtime-race rule, shared by the
// parallel orchestrator (real runs) and the dispatcher's --dry-run short-circuit.
describe('assessIsolatedRuntimeRace', () => {
  it('returns null when isolation is disabled (regardless of test-type)', () => {
    expect(assessIsolatedRuntimeRace({ enabled: false, testType: 'ios' })).toBeNull();
    expect(assessIsolatedRuntimeRace({ enabled: false, testType: 'all' })).toBeNull();
  });

  it('rejects --isolated + ios (shared simulator)', () => {
    const r = assessIsolatedRuntimeRace({ enabled: true, testType: 'ios' });
    expect(r).toMatchObject({ code: 'isolated_runtime_race', test_type: 'ios' });
    expect(r.message).toMatch(/simulator/i);
  });

  it('rejects --isolated + all (expands to include ios)', () => {
    expect(assessIsolatedRuntimeRace({ enabled: true, testType: 'all' }))
      .toMatchObject({ code: 'isolated_runtime_race', test_type: 'all' });
  });

  it('rejects --isolated + androidInstrumented WITHOUT a device', () => {
    expect(assessIsolatedRuntimeRace({ enabled: true, testType: 'androidInstrumented', hasDevice: false }))
      .toMatchObject({ code: 'isolated_runtime_race', test_type: 'androidInstrumented' });
  });

  it('ALLOWS --isolated + androidInstrumented WITH a device', () => {
    expect(assessIsolatedRuntimeRace({ enabled: true, testType: 'androidInstrumented', hasDevice: true }))
      .toBeNull();
  });

  it('ALLOWS isolation-safe test-types (macos/desktop/common/androidUnit/empty)', () => {
    for (const tt of ['macos', 'desktop', 'common', 'androidUnit', '']) {
      expect(assessIsolatedRuntimeRace({ enabled: true, testType: tt })).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// splitJvmOpts
// ---------------------------------------------------------------------------
describe('splitJvmOpts', () => {
  it('returns [] for empty string', () => expect(splitJvmOpts('')).toEqual([]));
  it('returns [] for whitespace-only string', () => expect(splitJvmOpts('   ')).toEqual([]));
  it('returns [] for null / undefined', () => {
    expect(splitJvmOpts(null)).toEqual([]);
    expect(splitJvmOpts(undefined)).toEqual([]);
  });

  it('splits simple space-separated opts', () => {
    expect(splitJvmOpts('-Xmx2g -Xms512m')).toEqual(['-Xmx2g', '-Xms512m']);
  });

  it('splits a single opt', () => {
    expect(splitJvmOpts('-Dfile.encoding=UTF-8')).toEqual(['-Dfile.encoding=UTF-8']);
  });

  it('strips surrounding double quotes from each token', () => {
    expect(splitJvmOpts('"-Xmx2g" "-Dsome.prop=value with space"')).toEqual([
      '-Xmx2g',
      '-Dsome.prop=value with space',
    ]);
  });

  it('handles mix of quoted and unquoted tokens', () => {
    expect(splitJvmOpts('-Xmx2g "-Dsome.prop=hello world" -Xms512m')).toEqual([
      '-Xmx2g',
      '-Dsome.prop=hello world',
      '-Xms512m',
    ]);
  });

  it('preserves = and : inside tokens', () => {
    expect(splitJvmOpts('-Dhttp.proxyHost=proxy.example.com')).toEqual([
      '-Dhttp.proxyHost=proxy.example.com',
    ]);
  });

  it('trims leading/trailing whitespace around tokens', () => {
    expect(splitJvmOpts('  -Xmx1g   -Xms256m  ')).toEqual(['-Xmx1g', '-Xms256m']);
  });
});

// ---------------------------------------------------------------------------
// spawnGradle — Candidate A: JAVA_OPTS / GRADLE_OPTS propagation
// ---------------------------------------------------------------------------
describe('spawnGradle — Candidate A JAVA_OPTS/GRADLE_OPTS propagation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'kmp-jvmopts-'));
    mkdirSync(path.join(tmpDir, 'gradle', 'wrapper'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'gradle', 'wrapper', 'gradle-wrapper.jar'), '');
    writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\r\n');
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prepends JAVA_OPTS tokens before -classpath in the JVM argv', () => {
    const calls = [];
    const fakeSpawn = (cmd, args, _opts) => { calls.push({ cmd, args }); return { status: 0, stdout: '', stderr: '' }; };
    const gradlewBat = path.join(tmpDir, 'gradlew.bat');
    spawnGradle(fakeSpawn, gradlewBat, [':app:test'], {
      env: { ...process.env, JAVA_OPTS: '-Xmx2g -Dhttp.proxyHost=proxy.local', GRADLE_OPTS: '' },
    });
    // On Windows the Candidate A branch fires; on POSIX the non-.bat direct branch fires.
    if (process.platform !== 'win32') return;
    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0];
    expect(/(java(\.exe)?)$/i.test(cmd)).toBe(true);
    const cpIdx = args.indexOf('-classpath');
    expect(cpIdx).toBeGreaterThan(-1);
    // JAVA_OPTS tokens must appear before -classpath
    expect(args.indexOf('-Xmx2g')).toBeLessThan(cpIdx);
    expect(args.indexOf('-Dhttp.proxyHost=proxy.local')).toBeLessThan(cpIdx);
    // Gradle arg must appear after GradleWrapperMain
    const mainIdx = args.indexOf('org.gradle.wrapper.GradleWrapperMain');
    expect(args.indexOf(':app:test')).toBeGreaterThan(mainIdx);
  });

  it('prepends GRADLE_OPTS tokens before -classpath in the JVM argv', () => {
    const calls = [];
    const fakeSpawn = (cmd, args, _opts) => { calls.push({ cmd, args }); return { status: 0, stdout: '', stderr: '' }; };
    const gradlewBat = path.join(tmpDir, 'gradlew.bat');
    spawnGradle(fakeSpawn, gradlewBat, [':lib:check'], {
      env: { ...process.env, JAVA_OPTS: '', GRADLE_OPTS: '-Dgradle.user.home=/ci/.gradle' },
    });
    if (process.platform !== 'win32') return;
    expect(calls).toHaveLength(1);
    const { args } = calls[0];
    const cpIdx = args.indexOf('-classpath');
    expect(args.indexOf('-Dgradle.user.home=/ci/.gradle')).toBeLessThan(cpIdx);
  });

  it('includes no extra JVM opts when both JAVA_OPTS and GRADLE_OPTS are absent', () => {
    const calls = [];
    const fakeSpawn = (cmd, args, _opts) => { calls.push({ cmd, args }); return { status: 0, stdout: '', stderr: '' }; };
    const gradlewBat = path.join(tmpDir, 'gradlew.bat');
    const env = { ...process.env };
    delete env.JAVA_OPTS;
    delete env.GRADLE_OPTS;
    spawnGradle(fakeSpawn, gradlewBat, ['tasks'], { env });
    if (process.platform !== 'win32') return;
    const { args } = calls[0];
    const cpIdx = args.indexOf('-classpath');
    // Nothing before -classpath except the implicit -Dorg.gradle.appname is AFTER -classpath
    // so cpIdx should be 0 (no jvmOpts prepended)
    expect(cpIdx).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part B — parseAdbDevicesOutput state parsing
// ---------------------------------------------------------------------------
describe('parseAdbDevicesOutput — state field', () => {
  it('parses a ready device as state:"device"', () => {
    const out = parseAdbDevicesOutput(
      'List of devices attached\nABC123\tdevice\tproduct:redfin model:Pixel_5 device:redfin transport_id:1\n',
    );
    expect(out).toHaveLength(1);
    expect(out[0].serial).toBe('ABC123');
    expect(out[0].state).toBe('device');
    expect(out[0].model).toBe('Pixel_5');
    expect(out[0].type).toBe('physical');
  });

  it('parses an offline device as state:"offline"', () => {
    const out = parseAdbDevicesOutput(
      'List of devices attached\nDEF456\toffline\n',
    );
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('offline');
    expect(out[0].serial).toBe('DEF456');
  });

  it('parses an unauthorized device as state:"unauthorized"', () => {
    const out = parseAdbDevicesOutput(
      'List of devices attached\nGHI789\tunauthorized\n',
    );
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('unauthorized');
  });

  it('parses an emulator device as type:"emulator"', () => {
    const out = parseAdbDevicesOutput(
      'List of devices attached\nemulator-5554\tdevice\tproduct:sdk model:sdk_gphone_arm64 device:emulator_arm64 transport_id:2\n',
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('emulator');
    expect(out[0].state).toBe('device');
  });

  it('parses mixed output — one ready and one offline', () => {
    const stdout = [
      'List of devices attached',
      'ABC123\tdevice\tproduct:redfin model:Pixel_5 device:redfin transport_id:1',
      'DEF456\toffline',
      '',
    ].join('\n');
    const out = parseAdbDevicesOutput(stdout);
    expect(out).toHaveLength(2);
    expect(out.find(d => d.serial === 'ABC123').state).toBe('device');
    expect(out.find(d => d.serial === 'DEF456').state).toBe('offline');
  });

  it('returns [] for empty/null stdout', () => {
    expect(parseAdbDevicesOutput('')).toEqual([]);
    expect(parseAdbDevicesOutput(null)).toEqual([]);
    expect(parseAdbDevicesOutput(undefined)).toEqual([]);
  });

  it('returns [] when only header line present', () => {
    expect(parseAdbDevicesOutput('List of devices attached\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part B — resolveAdbDevice shared helper
// ---------------------------------------------------------------------------
describe('resolveAdbDevice', () => {
  it('empty devices → instrumented_setup_failed', () => {
    const r = resolveAdbDevice([]);
    expect(r.deviceSerial).toBeNull();
    expect(r.error.code).toBe('instrumented_setup_failed');
  });

  it('one usable device, no --device → resolves to its serial', () => {
    const r = resolveAdbDevice([{ serial: 'A', type: 'physical', model: 'X', state: 'device' }]);
    expect(r.error).toBeNull();
    expect(r.deviceSerial).toBe('A');
  });

  it('one usable + one unusable, no --device → resolves to usable serial', () => {
    const devices = [
      { serial: 'A', state: 'device' },
      { serial: 'B', state: 'offline' },
    ];
    const r = resolveAdbDevice(devices);
    expect(r.error).toBeNull();
    expect(r.deviceSerial).toBe('A');
  });

  it('all offline → device_offline', () => {
    const r = resolveAdbDevice([
      { serial: 'A', state: 'offline' },
      { serial: 'B', state: 'offline' },
    ]);
    expect(r.deviceSerial).toBeNull();
    expect(r.error.code).toBe('device_offline');
  });

  it('all unauthorized → device_unauthorized', () => {
    const r = resolveAdbDevice([{ serial: 'A', state: 'unauthorized' }]);
    expect(r.error.code).toBe('device_unauthorized');
  });

  it('mixed offline + unauthorized → device_unauthorized (unauthorized takes priority)', () => {
    const r = resolveAdbDevice([
      { serial: 'A', state: 'offline' },
      { serial: 'B', state: 'unauthorized' },
    ]);
    expect(r.error.code).toBe('device_unauthorized');
  });

  it('multiple usable, no --device → multiple_adb_devices', () => {
    const r = resolveAdbDevice([
      { serial: 'A', state: 'device' },
      { serial: 'B', state: 'device' },
    ]);
    expect(r.error.code).toBe('multiple_adb_devices');
  });

  it('multiple usable, --device pins to named serial', () => {
    const r = resolveAdbDevice(
      [{ serial: 'A', state: 'device' }, { serial: 'B', state: 'device' }],
      { device: 'B' },
    );
    expect(r.error).toBeNull();
    expect(r.deviceSerial).toBe('B');
  });

  it('--device targeting offline serial → device_offline', () => {
    const r = resolveAdbDevice(
      [{ serial: 'A', state: 'offline' }],
      { device: 'A' },
    );
    expect(r.error.code).toBe('device_offline');
  });

  it('--device targeting unauthorized serial → device_unauthorized', () => {
    const r = resolveAdbDevice(
      [{ serial: 'A', state: 'unauthorized' }],
      { device: 'A' },
    );
    expect(r.error.code).toBe('device_unauthorized');
  });

  it('--device not in list → instrumented_setup_failed', () => {
    const r = resolveAdbDevice(
      [{ serial: 'A', state: 'device' }],
      { device: 'Z' },
    );
    expect(r.error.code).toBe('instrumented_setup_failed');
  });

  it('missing state field (legacy stubs) treated as usable', () => {
    const r = resolveAdbDevice([{ serial: 'X', type: 'physical', model: 'Y' }]);
    expect(r.error).toBeNull();
    expect(r.deviceSerial).toBe('X');
  });
});
