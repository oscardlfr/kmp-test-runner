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
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { extractJavaHome, applyJavaHomeToEnv, isRunnerEntrypoint } from '../../lib/runner.js';

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

// ---------------------------------------------------------------------------
// isRunnerEntrypoint — regression coverage for the Gradle-plugin false-green
// bug (2026-07-15 macOS validation): the Gradle plugin's RuntimeExtractor
// extracts runner.js to a JVM temp dir, which on macOS resolves under
// /var/folders/... — a symlink to /private/var/folders/.... process.argv[1]
// keeps the literal (unresolved) form the caller passed, while Node's ESM
// loader canonicalizes import.meta.url through that symlink. The raw-string
// guard this replaced mismatched on the identical file, so `main()` silently
// never ran: exit 0, zero output, no error — Gradle saw a false
// BUILD SUCCESSFUL for every one of the 5 gradle-plugin tasks regardless of
// what the runner itself would have reported.
// ---------------------------------------------------------------------------
describe('isRunnerEntrypoint', () => {
  const itUnlessWindows = process.platform === 'win32' ? it.skip : it;

  it('matches when argv[1] and the module URL are the identical literal path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmp-entrypoint-'));
    const file = path.join(dir, 'runner.js');
    fs.writeFileSync(file, '// fixture');
    try {
      expect(isRunnerEntrypoint(file, pathToFileURL(file).href)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itUnlessWindows('matches when argv[1] traverses a symlink but the module URL resolves the real path (the macOS /var vs /private/var shape)', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmp-entrypoint-real-'));
    const linkDir = path.join(os.tmpdir(), `kmp-entrypoint-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realDir, linkDir, 'dir');
    const realFile = path.join(realDir, 'runner.js');
    const viaSymlinkFile = path.join(linkDir, 'runner.js');
    fs.writeFileSync(realFile, '// fixture');
    try {
      // argv[1] as the caller would pass it: through the symlinked path.
      // import.meta.url as Node's ESM loader would report it: canonicalized.
      expect(isRunnerEntrypoint(viaSymlinkFile, pathToFileURL(realFile).href)).toBe(true);
      // Also holds symmetrically (argv canonical, module via symlink).
      expect(isRunnerEntrypoint(realFile, pathToFileURL(viaSymlinkFile).href)).toBe(true);
    } finally {
      fs.unlinkSync(linkDir);
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('does not match genuinely different files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmp-entrypoint-'));
    const fileA = path.join(dir, 'a.js');
    const fileB = path.join(dir, 'b.js');
    fs.writeFileSync(fileA, '// a');
    fs.writeFileSync(fileB, '// b');
    try {
      expect(isRunnerEntrypoint(fileA, pathToFileURL(fileB).href)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when argv[1] is absent (imported as a module, not run directly)', () => {
    // '' (not undefined): isRunnerEntrypoint's argv1 parameter has a default
    // of process.argv[1], which only activates on undefined — passing
    // undefined here would silently substitute the real (truthy) test-runner
    // argv[1] and never exercise the `if (!argv1) return false` guard at all.
    expect(isRunnerEntrypoint('', pathToFileURL(path.join(os.tmpdir(), 'runner.js')).href)).toBe(false);
  });
});
