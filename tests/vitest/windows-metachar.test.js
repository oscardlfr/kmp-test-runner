// SPDX-License-Identifier: MIT
// Windows cmd.exe metacharacter safety tests for lib/orchestrators/orchestrator-utils.js#spawnGradle.
//
// WHY THIS EXISTS — H9 audit finding: spawnGradle() routes Gradle invocations
// through `cmd.exe /d /s /c "..."` on Windows. cmd.exe performs a %VAR%
// expansion pre-parse BEFORE quote processing, so even a double-quoted arg
// "%KMP_SHOULD_NOT_EXPAND%" becomes "EXPANDED" if that env var is set.
// Delayed expansion (!VAR!) is also in scope when enabledelayedexpansion is active.
//
// Test structure:
//   Phase 1   — spawnGradle assertions on literal delivery (RED before fix, GREEN after)
//   Cand A/T1 — java.exe spawned directly delivers args byte-for-byte (ArgsEcho fixture)
//   Cand A/T2 — java.exe + real GradleWrapperMain delivers -P args literally (gated)
//   Cand B    — PowerShell + .bat boundary probe (empirical; FAILS for %VAR% and "^")
//
// Candidate B is retained for documentation: results show PowerShell still routes
// .bat files through cmd.exe internally, so %VAR% expansion occurs at that boundary.
// Candidate B is DISCARDED; Candidate A (direct JVM invocation) is the chosen fix.
//
// All tests are gated with `if (process.platform !== 'win32') return;`
// so non-Windows CI passes trivially without skipped-test noise.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnGradle } from '../../lib/orchestrators/orchestrator-utils.js';
import { setConsoleMode, getConsoleMode } from '../../lib/runners/console-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixture paths
const ECHO_ARGS_MJS = path.join(__dirname, '..', 'fixtures', 'echo-args', 'echo-args.mjs');
const ECHO_ARGS_BAT = path.join(__dirname, '..', 'fixtures', 'echo-args', 'echo-args.bat');
const ARGS_ECHO_JAVA_DIR = path.join(__dirname, '..', 'fixtures', 'java-args-passthrough');
const KMP_CROSS_DIR = path.join(__dirname, '..', 'fixtures', 'kmp-cross-platform-e2e');
const WRAPPER_JAR = path.join(KMP_CROSS_DIR, 'gradle', 'wrapper', 'gradle-wrapper.jar');

// Env that poisons %VAR% expansion: if cmd.exe expands %KMP_SHOULD_NOT_EXPAND%
// the value 'EXPANDED' appears in stdout instead of the literal percent expression.
const POISON_ENV = { ...process.env, KMP_SHOULD_NOT_EXPAND: 'EXPANDED' };

// Metacharacter values that cmd.exe would mangle without safe transport.
// Each must arrive at the subprocess byte-for-byte.
const METACHAR_MATRIX = [
  '%KMP_SHOULD_NOT_EXPAND%',              // env var expansion
  '!KMP_SHOULD_NOT_EXPAND!',             // delayed expansion
  '^',                                    // cmd.exe escape character
  '"doublequote"',                        // double-quote in value
  'space in value',                       // whitespace
  'key=val',                              // equals sign
  '-Psome.value=%KMP_SHOULD_NOT_EXPAND%', // Gradle property with percent
  'class=com.example.Percent%NameTest',   // class name with percent
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveJavaExe() {
  const jh = process.env.JAVA_HOME;
  if (jh) return path.join(jh, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function resolveJavac() {
  const jh = process.env.JAVA_HOME;
  if (jh) return path.join(jh, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  return process.platform === 'win32' ? 'javac.exe' : 'javac';
}

// Minimal PowerShell shell probe — mirrors pickWindowsShell in shell-runner.js
// without importing that module (it imports cli.js which is large).
function resolveShell() {
  const probe = spawnSync('pwsh', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
  return probe.status === 0 ? 'pwsh' : 'powershell.exe';
}

// ---------------------------------------------------------------------------
// PHASE 1 — spawnGradle metachar regression guard.
//
// Uses process.execPath (node.exe) as the "gradlew" executable and
// echo-args.mjs as a script arg. This is not a Gradle project shape; it is
// valid ONLY as a probe of how spawnGradle transports args on Windows.
//
// These tests assert the DESIRED behaviour (args delivered literally).
// They are RED before any fix because the current code routes through
// cmd.exe which expands %VAR%.
// After the fix (whichever candidate is chosen), they go GREEN.
// ---------------------------------------------------------------------------
describe('Phase 1 — spawnGradle must deliver args literally (RED before fix)', () => {
  // This describe block is the only one that calls the real spawnGradle() (every
  // other block spawns java.exe/PowerShell directly), so it is the only one
  // exposed to spawnGradle's own defensive `--console=plain` auto-injection
  // (lib/runners/console-mode.js#shouldInjectConsolePlain, called with no
  // arguments — it reads live process.env/module state at call time). That
  // injection is legitimate production behavior (docs/testing note it exists
  // specifically for piped/captured output and NO_COLOR-respecting terminals),
  // but this suite's assertions assume spawnGradle's effective argv is EXACTLY
  // [ECHO_ARGS_MJS, testArg] — a real, unrelated cross-file test-hygiene gap
  // (console-mode.test.js's own last test previously left process.env.
  // KMP_COLOR_MODE='never' behind with nothing to reset it — now fixed there
  // too) let that assumption silently break whenever this file happened to run
  // after console-mode.test.js in the same vitest worker, or whenever NO_COLOR
  // was already set in the ambient shell (both independently confirmed to
  // reproduce the exact same 8 failures, with zero relation to Node version).
  //
  // Fixed here at the point of use: force mode:'always' for the whole block,
  // which is the one shouldInjectConsolePlain() branch that short-circuits
  // BEFORE its NO_COLOR/isTTY checks — deterministically immune to every known
  // trigger, not just the one leak vector above. beforeAll additionally
  // simulates the worst known real leak (KMP_COLOR_MODE=never) plus NO_COLOR
  // BEFORE applying the fix, so every run of this suite is itself the
  // regression proof that the fix holds even under a hostile incoming
  // environment, not just a coincidentally-clean one.
  let originalMode;
  let originalKmpColorMode;
  let originalNoColor;

  beforeAll(() => {
    // Captured BEFORE any mutation below — the true pre-existing state.
    originalMode = getConsoleMode();
    originalKmpColorMode = process.env.KMP_COLOR_MODE;
    originalNoColor = process.env.NO_COLOR;
    // Simulate the worst-case leaked/ambient state first...
    process.env.KMP_COLOR_MODE = 'never';
    process.env.NO_COLOR = '1';
    // ...then apply the real fix, proving it overrides even that.
    setConsoleMode('always');
  });

  afterAll(() => {
    // Ordering matters: setConsoleMode() itself writes process.env.
    // KMP_COLOR_MODE as a side effect, so restoring the module-level mode
    // FIRST and fixing up the env vars to their true captured values LAST
    // means nothing after this can clobber the restoration again (the same
    // ordering bug this fix's own first version had — caught before merge).
    setConsoleMode(originalMode);
    if (originalKmpColorMode === undefined) delete process.env.KMP_COLOR_MODE;
    else process.env.KMP_COLOR_MODE = originalKmpColorMode;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    // Locks the restoration contract in place — if this ordering regresses
    // again, this suite fails closed instead of silently leaking 'always'.
    expect(getConsoleMode()).toBe(originalMode);
    expect(process.env.KMP_COLOR_MODE).toBe(originalKmpColorMode);
    expect(process.env.NO_COLOR).toBe(originalNoColor);
  });

  for (const testArg of METACHAR_MATRIX) {
    it(`literal: ${JSON.stringify(testArg)}`, () => {
      if (process.platform !== 'win32') return;

      const result = spawnGradle(
        spawnSync,
        process.execPath,
        [ECHO_ARGS_MJS, testArg],
        { encoding: 'utf8', env: POISON_ENV }
      );

      expect(result.error, `spawn error: ${result.error?.code}`).toBeFalsy();
      expect(result.status, `exit ${result.status}: ${result.stderr}`).toBe(0);
      // Core assertion: the arg must arrive byte-for-byte, not expanded.
      expect(result.stdout.trim()).toBe(testArg);
      expect(result.stdout).not.toContain('EXPANDED');
    });
  }
});

// ---------------------------------------------------------------------------
// CANDIDATE A TIER 1 — java.exe spawned directly by Node delivers args
// byte-for-byte without any cmd.exe involvement.
//
// Proves the JVM is a safe transport layer. Compiles ArgsEcho.java at test
// time; skips gracefully if javac is absent.
// ---------------------------------------------------------------------------
describe('Candidate A Tier 1 — java.exe direct spawn (ArgsEcho)', () => {
  let classDir;
  let compiled = false;

  beforeAll(() => {
    if (process.platform !== 'win32') return;
    const javac = resolveJavac();
    classDir = mkdtempSync(path.join(tmpdir(), 'kmp-argsecho-'));
    const r = spawnSync(
      javac,
      [path.join(ARGS_ECHO_JAVA_DIR, 'ArgsEcho.java'), '-d', classDir],
      { encoding: 'utf8' }
    );
    compiled = r.status === 0;
    if (!compiled) {
      // javac unavailable on this runner — tests are skipped, not failed.
      console.warn('[windows-metachar] ArgsEcho compile failed — skipping Tier 1 (javac absent?)');
      console.warn(r.stderr?.slice(0, 300));
    }
  });

  afterAll(() => {
    if (classDir) rmSync(classDir, { recursive: true, force: true });
  });

  for (const testArg of METACHAR_MATRIX) {
    it(`java.exe delivers literal: ${JSON.stringify(testArg)}`, () => {
      if (process.platform !== 'win32') return;
      if (!compiled) return; // graceful skip when javac absent

      const javaExe = resolveJavaExe();
      const result = spawnSync(
        javaExe,
        ['-cp', classDir, 'ArgsEcho', testArg],
        { encoding: 'utf8', env: POISON_ENV }
      );

      expect(result.error, `spawn error: ${result.error?.code}`).toBeFalsy();
      expect(result.status).toBe(0);
      // java.exe receives args as OS argv array — no shell, no expansion.
      expect(result.stdout.trim()).toBe(testArg);
      expect(result.stdout).not.toContain('EXPANDED');
    });
  }
});

// ---------------------------------------------------------------------------
// CANDIDATE A TIER 2 — java.exe + GradleWrapperMain delivers -P property
// values literally through the real Gradle wrapper chain.
//
// Gated behind METACHAR_A2=1 because this test downloads the Gradle
// distribution on first run (~100 MB, several minutes). On subsequent runs
// the distribution is cached in ~/.gradle/wrapper/dists.
//
// Run locally: METACHAR_A2=1 npx vitest run tests/vitest/windows-metachar.test.js
// ---------------------------------------------------------------------------
const runTier2 = process.platform === 'win32' && !!process.env.METACHAR_A2;

describe('Candidate A Tier 2 — java.exe + GradleWrapperMain (requires METACHAR_A2=1)', () => {
  it.skipIf(!runTier2)(
    '-Ptest.metachar.value arrives in Gradle project properties as literal',
    () => {
      if (!existsSync(WRAPPER_JAR)) {
        throw new Error(`wrapper JAR not found: ${WRAPPER_JAR}`);
      }
      const javaExe = resolveJavaExe();
      // Canonical Gradle wrapper invocation — same shape as the real gradlew.bat script.
      const result = spawnSync(
        javaExe,
        [
          '-classpath', WRAPPER_JAR,
          '-Dorg.gradle.appname=gradlew',
          'org.gradle.wrapper.GradleWrapperMain',
          'properties', '--quiet',
          '-Ptest.metachar.value=%KMP_SHOULD_NOT_EXPAND%',
        ],
        {
          cwd: KMP_CROSS_DIR,
          encoding: 'utf8',
          env: { ...POISON_ENV },
          timeout: 120_000,
        }
      );
      expect(result.error, `spawn error: ${result.error?.code}`).toBeFalsy();
      expect(result.status).toBe(0);
      // Gradle `properties` prints "<key>: <value>" for each project property.
      // Literal arrival proves no cmd.exe expansion occurred at any point.
      expect(result.stdout).toMatch(/test\.metachar\.value:\s*%KMP_SHOULD_NOT_EXPAND%/);
      expect(result.stdout).not.toContain('EXPANDED');
    },
    120_000
  );
});

// ---------------------------------------------------------------------------
// CANDIDATE B — PowerShell single-quoted args through a .bat boundary.
//
// EMPIRICAL FINDING (2026-07-12 local Windows probe): PowerShell routes .bat
// files through cmd.exe internally, so %VAR% expansion occurs at the
// cmd.exe→batch boundary regardless of PS single-quoting. Candidate B is
// DISCARDED. Tests marked `it.fails` below document the KNOWN failures that
// caused B's rejection; they are expected to FAIL and counted as passing.
// ---------------------------------------------------------------------------

// These values survive the PS + .bat route intact (false negatives for
// Candidate B do NOT save it — %VAR% expansion is the blocking failure).
const CAND_B_PASSES = new Set([
  '!KMP_SHOULD_NOT_EXPAND!',
  'space in value',
  'key=val',
  'class=com.example.Percent%NameTest',
]);

// describe.skipIf gates the whole block on Windows-only so that:
// • it.fails tests (documenting B rejections) don't "unexpectedly pass"
//   on Linux/macOS (where the early-return would count as no-failure).
// • it() tests (documenting B successes) don't trivially pass off-platform.
describe.skipIf(process.platform !== 'win32')('Candidate B — PowerShell single-quoted args via .bat boundary (B discarded)', () => {
  for (const testArg of METACHAR_MATRIX) {
    // Tests that PASS: B happens to handle these values correctly.
    // Tests that FAIL (it.fails): B is BROKEN for these — the expected
    // assertion fails, which is the documented rejection evidence.
    const itFn = CAND_B_PASSES.has(testArg) ? it : it.fails;
    itFn(`PS + .bat: ${JSON.stringify(testArg)}`, () => {
      const shell = resolveShell();
      // PowerShell single-quote escaping: '' is a literal ' inside '...'
      const psEsc = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const psCmd = `& ${psEsc(ECHO_ARGS_BAT)} ${psEsc(testArg)}`;

      const result = spawnSync(
        shell,
        ['-NoLogo', '-NoProfile', '-Command', psCmd],
        { encoding: 'utf8', env: POISON_ENV }
      );

      expect(result.error, `spawn error: ${result.error?.code}`).toBeFalsy();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(testArg);
      expect(result.stdout).not.toContain('EXPANDED');
    });
  }
});
