// SPDX-License-Identifier: MIT
// Real, non-mocked E2E producer test for the PR A coverage-budget fail-closed
// contract (Evidence1 success-recovery runbook Section 8.8). Builds a REAL,
// small JVM + JaCoCo Gradle project, compiles REAL Kotlin, executes a REAL
// JUnit 5 test, lets Gradle produce REAL JaCoCo XML, and invokes the REAL CLI
// entry point (bin/kmp-test.js) as a CHILD PROCESS — this file never injects
// parseCoverageXml, spawn, or the envelope. Complements the stubbed
// unit-level coverage in coverage-orchestrator.test.js /
// parallel-orchestrator.test.js: those prove the decision logic in isolation;
// this proves the real Gradle/JaCoCo/Kotlin pipeline actually produces the
// inputs that logic depends on.
//
// The fixture's wrapper (gradlew/gradlew.bat/gradle/wrapper/*) is reused from
// tests/fixtures/kmp-cross-platform-e2e/ at test-setup time — copied into a
// fresh tmpdir alongside this fixture's own build files — so no second copy
// of gradle-wrapper.jar is committed to the repo (Section 8.8, rule 2).
//
// tests/fixtures/coverage-budget-real-producer/app/src/main/kotlin/CoverageSubject.kt
// is a small, fixed, deterministic source: one branch of `coveredBranch` is
// exercised by the single JUnit test, the other branch plus the entire
// `neverCalled()` function are not. Real JaCoCo on this exact source reports
// LINE missed=4 (verified empirically against the committed source — see the
// XML asserted below); pure-JVM bytecode line coverage for this trivial,
// non-platform-specific Kotlin is expected to be stable across Ubuntu/Windows
// CI. If a real CI run ever reports a different number, re-verify against the
// fixture's actual JaCoCo XML before assuming a flake.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// execFile (not execFileSync) for the real CLI invocation below: a
// synchronous, multi-second child-process wait blocks this worker's entire
// event loop, starving vitest's own internal IPC heartbeat
// ("Timeout calling 'onTaskUpdate'") on a slower/colder CI runner even
// though the test's own assertions would have passed. execFile keeps the
// invocation a genuine, real child process (never a mock) while yielding
// the event loop for the ~5-90s a cold Gradle build can take.
const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, '..', 'fixtures', 'coverage-budget-real-producer');
const WRAPPER_SRC = path.join(__dirname, '..', 'fixtures', 'kmp-cross-platform-e2e');
const CLI_ENTRY = path.join(__dirname, '..', '..', 'bin', 'kmp-test.js');

// Real Gradle: a cold CI cache downloads the Gradle distribution + Kotlin
// compiler + JUnit 5 jars from Maven Central before the first build can run.
const TEST_TIMEOUT_MS = 300_000;

let projectDirs = [];
afterEach(() => {
  for (const dir of projectDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  projectDirs = [];
});

// Assembles a fresh, standalone real Gradle project per test: this fixture's
// own build files + the REUSED real wrapper (never duplicated in git).
function setupProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-coverage-budget-e2e-'));
  projectDirs.push(dir);
  cpSync(FIXTURE_SRC, dir, { recursive: true });
  cpSync(path.join(WRAPPER_SRC, 'gradlew'), path.join(dir, 'gradlew'));
  cpSync(path.join(WRAPPER_SRC, 'gradlew.bat'), path.join(dir, 'gradlew.bat'));
  cpSync(path.join(WRAPPER_SRC, 'gradle', 'wrapper'), path.join(dir, 'gradle', 'wrapper'), { recursive: true });
  if (process.platform !== 'win32') {
    execFileSync('chmod', ['+x', path.join(dir, 'gradlew')]);
  }
  return dir;
}

// Runs the REAL CLI entry point as a real child process — never in-process,
// never with an injected spawn/parser — asynchronously, so this test never
// blocks vitest's own event loop while a real (possibly cold, multi-second)
// Gradle build runs. Returns the parsed JSON envelope plus the real process
// exit code.
async function runRealCli(projectRoot, extraArgs = []) {
  let stdout;
  let exitCode = 0;
  try {
    const result = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, 'parallel', '--json', '--project-root', projectRoot, ...extraArgs],
      { encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (e) {
    // A discriminated non-zero exit (1/2/3) still writes the JSON envelope to
    // stdout; promisified execFile rejects for any non-zero exit (Node core's
    // own execFile[promisify.custom] still attaches stdout/stderr/code to the
    // rejected error), so recover it here.
    stdout = e.stdout;
    exitCode = typeof e.code === 'number' ? e.code : 1;
  }
  return { envelope: JSON.parse(stdout), exitCode };
}

describe('coverage-budget-real-producer — real Gradle/JaCoCo/Kotlin E2E (Section 8.8)', () => {
  it('threshold below the real missed-line count -> coverage_threshold_exceeded, exit 1, real with_data', async () => {
    const dir = setupProject();
    const { envelope, exitCode } = await runRealCli(dir, ['--min-missed-lines', '3']);
    expect(exitCode).toBe(1);
    expect(envelope.tests).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(envelope.coverage.missed_lines).toBe(4);
    expect(envelope.coverage.module_buckets).toEqual({
      with_data: ['app'], no_xml: [], parse_errored: [], skipped_by_user: [],
    });
    expect(envelope.errors).toEqual([{
      code: 'coverage_threshold_exceeded',
      message: 'Coverage threshold exceeded: 4 missed lines > 3 (--min-missed-lines)',
      threshold: 3,
      missed_lines: 4,
    }]);
  }, TEST_TIMEOUT_MS);

  it('threshold above the real missed-line count -> success, exit 0', async () => {
    const dir = setupProject();
    const { envelope, exitCode } = await runRealCli(dir, ['--min-missed-lines', '5']);
    expect(exitCode).toBe(0);
    expect(envelope.tests).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(envelope.coverage.missed_lines).toBe(4);
    expect(envelope.errors).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('report XML deliberately disabled + positive budget -> coverage_data_unavailable/target-no-xml, exit 3', async () => {
    const dir = setupProject();
    // -PcoverageBudgetE2eDisableXml=true (see the fixture's build.gradle.kts)
    // forces xml.required=false for real, registered AFTER (so it wins over)
    // kmp-test's own coverage-XML autofix init-script. Deliberately NOT using
    // --no-coverage-xml-autofix here: verified empirically that flag does not
    // currently suppress the autofix init-script's injection in this task
    // graph shape — a pre-existing bug outside PR A's allowlist
    // (lib/orchestrators/orchestrator-utils.js#shouldAutofixCoverageXml /
    // dispatchCoverageReports), reported separately, not fixed by this PR.
    const { envelope, exitCode } = await runRealCli(
      dir, ['--min-missed-lines', '3', '--gradle-args', '-PcoverageBudgetE2eDisableXml=true'],
    );
    expect(exitCode).toBe(3);
    expect(envelope.tests).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(envelope.coverage.module_buckets).toEqual({
      with_data: [], no_xml: ['app'], parse_errored: [], skipped_by_user: [],
    });
    expect(envelope.errors).toEqual([{
      code: 'coverage_data_unavailable',
      threshold: 3,
      reason: 'target-no-xml',
      message: expect.any(String),
    }]);
    // The real jacocoTestReport task still ran (HTML output) — this is a
    // deliberately-disabled XML report, not a task failure.
    expect(envelope.warnings.some((w) => w.code === 'coverage_xml_disabled')).toBe(true);
  }, TEST_TIMEOUT_MS);
});
