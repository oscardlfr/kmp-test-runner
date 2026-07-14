// SPDX-License-Identifier: MIT
// Isolated test for the coverage_report_write_failed guard (PR-17). Needs its
// own node:fs mock, scoped via a sentinel path substring so it doesn't affect
// the ~70 other coverage-orchestrator tests (which write real fixture files)
// — kept in a separate file rather than the main coverage-orchestrator.test.js.
//
// Proves: a writeMarkdownReport failure (disk full, permissions) no longer
// crashes runCoverage uncaught — pre-fix this meant runner.js's top-level
// handler printed a stack trace and exited without ever writing a JSON
// envelope, losing the entire coverage result, not just a missing warning.
// The envelope must still be returned, stay JSON-serializable, keep its real
// coverage data, and carry a discriminated coverage_report_write_failed
// warning whose message never leaks an absolute path or the run id — only
// the short fs error code (e.g. ENOSPC) is safe to surface.

import {
  describe, it, expect, vi, afterEach,
} from 'vitest';
import {
  writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCoverage } from '../../lib/orchestrators/coverage-orchestrator.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync: (file, ...rest) => {
      if (String(file).includes('WRITE-FAIL-SENTINEL')) {
        const err = new Error(`ENOSPC: no space left on device, open '${file}'`);
        err.code = 'ENOSPC';
        throw err;
      }
      return actual.writeFileSync(file, ...rest);
    },
  };
});

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-coverage-writefail-'));
  workDir = dir;
  writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "fixture"\ninclude(":a")\n');
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  const modDir = path.join(dir, 'a');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(path.join(modDir, 'build.gradle.kts'), 'plugins {\n  id("org.jetbrains.kotlinx.kover")\n  kotlin("jvm")\n}\n');
  return dir;
}

function dropFakeXml(projectRoot) {
  const xmlDir = path.join(projectRoot, 'a', 'build', 'reports', 'kover');
  mkdirSync(xmlDir, { recursive: true });
  writeFileSync(path.join(xmlDir, 'report.xml'), '<report></report>');
}

describe('coverage_report_write_failed guard', () => {
  it('runCoverage does not throw when the markdown report write fails, and the envelope survives intact', async () => {
    const projectRoot = makeProject();
    dropFakeXml(projectRoot);
    const parseCoverageXml = () => ({
      rows: ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'],
      errored: false,
      reason: 'ok',
      message: null,
    });

    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: [],
      parseCoverageXml,
      runId: 'WRITE-FAIL-SENTINEL',
    });

    expect(exitCode).toBe(0);
    // JSON output remains parseable end-to-end.
    expect(() => JSON.parse(JSON.stringify(envelope))).not.toThrow();
    // Coverage data above the failed write is still valid.
    expect(envelope.coverage.missed_lines).toBe(1);
    expect(envelope.coverage.modules_contributing).toBe(1);
    // Discriminated warning present, path-safe (only the short fs error code
    // — never an absolute path or the run id that names the failed file).
    const w = envelope.warnings.find((x) => x.code === 'coverage_report_write_failed');
    expect(w).toBeTruthy();
    expect(w.message).toContain('ENOSPC');
    expect(w.message).not.toContain(projectRoot);
    expect(w.message).not.toContain('WRITE-FAIL-SENTINEL');
  });
});
