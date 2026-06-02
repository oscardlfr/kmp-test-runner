// SPDX-License-Identifier: MIT
// Integration tests for the JaCoCo XML auto-fix wiring in
// dispatchCoverageReports (lib/orchestrators/parallel/dispatch.js). The pure
// helpers (shouldAutofixCoverageXml / writeCoverageXmlInitScript /
// injectInitScript / cleanupInitScript) are unit-tested in
// orchestrator-utils.test.js; here we verify they're correctly composed inside
// the coverage-report dispatch leg: injected for jacoco, skipped otherwise, and
// the temp init-script is always cleaned up (the finally block).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dispatchCoverageReports } from '../../lib/orchestrators/parallel/dispatch.js';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function makeSpawnStub() {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

function dispatch(taskList, opts = {}) {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-autofix-dispatch-'));
  const spawn = makeSpawnStub();
  const result = dispatchCoverageReports({
    spawn,
    gradlewPath: 'gradlew',
    projectRoot: workDir,
    taskList,
    opts: { maxWorkers: 0, timeout: 600, gradleArgs: [], ...opts },
    env: {},
    log: () => {},
    isolatedDir: null,
  });
  return { result, spawn };
}

describe('dispatchCoverageReports — jacoco XML auto-fix injection', () => {
  it('injects --init-script for a jacoco report task (default) and cleans it up after', () => {
    const { result } = dispatch([':app:jacocoTestReport']);
    const idx = result.gradleArgs.indexOf('--init-script');
    expect(idx).toBeGreaterThan(-1);
    const scriptPath = result.gradleArgs[idx + 1];
    expect(scriptPath.endsWith('.init.gradle')).toBe(true);
    // The finally block removes the temp script once the leg returns.
    expect(existsSync(scriptPath)).toBe(false);
  });

  it('does NOT inject when --no-coverage-xml-autofix is set', () => {
    const { result } = dispatch([':app:jacocoTestReport'], { noCoverageXmlAutofix: true });
    expect(result.gradleArgs).not.toContain('--init-script');
  });

  it('does NOT inject for a pure-Kover task list (no-op)', () => {
    const { result } = dispatch([':a:koverXmlReportDebug', ':b:koverXmlReport']);
    expect(result.gradleArgs).not.toContain('--init-script');
  });

  it('does NOT inject a second --init-script when the user already passed one', () => {
    const { result } = dispatch([':app:jacocoTestReport'], {
      gradleArgs: ['--init-script', 'user.gradle'],
    });
    const occurrences = result.gradleArgs.filter((a) => a === '--init-script');
    expect(occurrences).toHaveLength(1); // only the user's
    expect(result.gradleArgs[result.gradleArgs.indexOf('--init-script') + 1]).toBe('user.gradle');
  });
});
