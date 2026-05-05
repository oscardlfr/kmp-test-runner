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
} from '../../lib/orchestrator-utils.js';

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
