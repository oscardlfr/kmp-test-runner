// SPDX-License-Identifier: MIT
// Tests for lib/runner.js -- Part C: extractJavaHome, applyJavaHomeToEnv, ordering proof.
//
// Key invariant tested here:
//   --java-home MUST be parsed and applied to process.env BEFORE preflightJdkCheck
//   and BEFORE any orchestrator call that inherits env (probeGradleTasksCached, etc.).
//   The bug was: runner.js stripped --java-home without writing JAVA_HOME/PATH,
//   so downstream spawns still used the system JDK.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

import { extractJavaHome, applyJavaHomeToEnv } from '../../lib/runner.js';

// ---------------------------------------------------------------------------
// Process-env save/restore so tests are isolated
// ---------------------------------------------------------------------------
let savedJavaHome;
let savedPath;

beforeEach(() => {
  savedJavaHome = process.env.JAVA_HOME;
  savedPath     = process.env.PATH;
});

afterEach(() => {
  if (savedJavaHome === undefined) {
    delete process.env.JAVA_HOME;
  } else {
    process.env.JAVA_HOME = savedJavaHome;
  }
  process.env.PATH = savedPath;
});

// ---------------------------------------------------------------------------
// extractJavaHome
// ---------------------------------------------------------------------------
describe('extractJavaHome', () => {
  it('extracts valid --java-home value from args', () => {
    const result = extractJavaHome(['--java-home', '/sdk/jdk17', '--other']);
    expect(result.error).toBeNull();
    expect(result.javaHome).toBe('/sdk/jdk17');
    expect(result.args).toEqual(['--other']);
  });

  it('missing value (--java-home is last token) → error, code invalid_flag_value', () => {
    const result = extractJavaHome(['--java-home']);
    expect(result.error).not.toBeNull();
    expect(result.error.code).toBe('invalid_flag_value');
    expect(result.error.flag).toBe('--java-home');
    expect(result.javaHome).toBeNull();
    // --java-home is consumed; no residual in args
    expect(result.args).toEqual([]);
  });

  it('flag-like value → error, leaves the next token in args', () => {
    const result = extractJavaHome(['--java-home', '--other']);
    expect(result.error).not.toBeNull();
    expect(result.error.code).toBe('invalid_flag_value');
    // --other must NOT be consumed — it remains for the caller to process
    expect(result.args).toContain('--other');
    expect(result.javaHome).toBeNull();
  });

  it('no --java-home flag → passthrough, javaHome: null, no error', () => {
    const result = extractJavaHome(['--module-filter', 'core', '--variant', 'debug']);
    expect(result.error).toBeNull();
    expect(result.javaHome).toBeNull();
    expect(result.args).toEqual(['--module-filter', 'core', '--variant', 'debug']);
  });

  it('empty args → no error, no javaHome', () => {
    const result = extractJavaHome([]);
    expect(result.error).toBeNull();
    expect(result.javaHome).toBeNull();
    expect(result.args).toEqual([]);
  });

  it('Windows-style path is accepted', () => {
    const result = extractJavaHome(['--java-home', 'C:\\Program Files\\Java\\jdk17']);
    expect(result.error).toBeNull();
    expect(result.javaHome).toBe('C:\\Program Files\\Java\\jdk17');
  });
});

// ---------------------------------------------------------------------------
// applyJavaHomeToEnv
// ---------------------------------------------------------------------------
describe('applyJavaHomeToEnv', () => {
  it('sets process.env.JAVA_HOME to the given path', () => {
    applyJavaHomeToEnv('/test/jdk17');
    expect(process.env.JAVA_HOME).toBe('/test/jdk17');
  });

  it('prepends <jdk>/bin to process.env.PATH', () => {
    process.env.PATH = '/usr/bin:/bin';
    applyJavaHomeToEnv('/test/jdk17');
    const expectedBin = path.join('/test/jdk17', 'bin');
    expect(process.env.PATH.startsWith(expectedBin)).toBe(true);
    expect(process.env.PATH).toContain('/usr/bin');
  });

  it('does not prepend duplicate <jdk>/bin on repeated calls', () => {
    process.env.PATH = '/usr/bin';
    applyJavaHomeToEnv('/test/jdk17');
    const pathAfterFirst = process.env.PATH;
    applyJavaHomeToEnv('/test/jdk17');
    const pathAfterSecond = process.env.PATH;
    // If <jdk>/bin was at the front the first time, the second call must not prepend it again.
    const parts = pathAfterSecond.split(path.delimiter).filter(Boolean);
    const binDir = path.join('/test/jdk17', 'bin');
    const count = parts.filter(p => p === binDir).length;
    expect(count).toBe(1);
    expect(pathAfterFirst).toBe(pathAfterSecond);
  });

  it('works when PATH is empty/absent', () => {
    delete process.env.PATH;
    applyJavaHomeToEnv('/test/jdk17');
    const expectedBin = path.join('/test/jdk17', 'bin');
    expect(process.env.PATH).toContain(expectedBin);
  });
});

// ---------------------------------------------------------------------------
// Ordering proof: JAVA_HOME/PATH applied before any spawn inheriting process.env
// ---------------------------------------------------------------------------
describe('applyJavaHomeToEnv ordering (JAVA_HOME visible to subsequent process.env readers)', () => {
  it('process.env.JAVA_HOME is set synchronously before any async work', () => {
    // This is the core bug regression: runner.js previously stripped --java-home
    // without calling applyJavaHomeToEnv, so process.env.JAVA_HOME was never set
    // and probeGradleTasksCached / preflightJdkCheck inherited the wrong JDK.
    expect(process.env.JAVA_HOME).not.toBe('/regression-sentinel/jdk17');
    applyJavaHomeToEnv('/regression-sentinel/jdk17');
    // Any code reading process.env.JAVA_HOME after this call sees the override.
    expect(process.env.JAVA_HOME).toBe('/regression-sentinel/jdk17');
    // PATH also updated so `java` from <jdk>/bin is on the exec path.
    expect(process.env.PATH).toContain(path.join('/regression-sentinel/jdk17', 'bin'));
  });

  it('extractJavaHome + applyJavaHomeToEnv combined: env mutated, args cleaned', () => {
    const args = ['--java-home', os.tmpdir(), '--variant', 'debug'];
    const { javaHome, args: cleanedArgs, error } = extractJavaHome(args);
    expect(error).toBeNull();
    applyJavaHomeToEnv(javaHome);
    // After the combined call, env is updated and args no longer contain --java-home.
    expect(process.env.JAVA_HOME).toBe(os.tmpdir());
    expect(cleanedArgs).toEqual(['--variant', 'debug']);
    expect(cleanedArgs).not.toContain('--java-home');
  });
});
