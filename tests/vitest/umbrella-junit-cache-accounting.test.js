// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeLeg } from '../../lib/orchestrators/parallel/cascade-retry.js';
import { parseArgs } from '../../lib/orchestrators/parallel/dispatch.js';
import { junitTestCountFor } from '../../lib/parsers/junit-xml.js';

let root;
const moduleName = 'nested:library';
const first = 'testAlphaDebugUnitTest';
const second = 'testBetaDebugUnitTest';
const startMs = Date.UTC(2026, 0, 1);
const xml = '<testsuite><testcase classname="SharedTest" name="one"/>'
  + '<testcase classname="SharedTest" name="two"/></testsuite>';
const failedXml = xml.replace('name="two"/>', 'name="two"><failure message="failure"/></testcase>');
const originalSizeLimit = process.env.KMP_JUNIT_XML_MAX_MB;

afterEach(() => {
  vi.restoreAllMocks();
  if (root) {
    const relative = path.relative(tmpdir(), path.resolve(root));
    if (!relative.startsWith('kmp-umbrella-junit-') || relative.includes(path.sep)) {
      throw new Error('fixture cleanup outside owned directory');
    }
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
  if (originalSizeLimit === undefined) delete process.env.KMP_JUNIT_XML_MAX_MB;
  else process.env.KMP_JUNIT_XML_MAX_MB = originalSizeLimit;
});

function fixture() {
  root = mkdtempSync(path.join(tmpdir(), 'kmp-umbrella-junit-'));
  vi.spyOn(Date, 'now').mockReturnValue(startMs);
  return root;
}

function writeXml(task, offset, content = xml, owner = moduleName) {
  const directory = path.join(root, ...owner.split(':'), 'build/test-results', task);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'TEST-SharedTest.xml');
  writeFileSync(file, content);
  const time = new Date(startMs + offset);
  utimesSync(file, time, time);
  return file;
}

function taskLine(task, suffix = '', owner = moduleName) {
  return `> Task :${owner}:${task}${suffix ? ' ' + suffix : ''}`;
}

async function run(outputs, owners = [moduleName]) {
  const state = {
    runStartMs: startMs,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 },
    modules: [], errors: [], warnings: [], skipped: [],
  };
  let call = 0;
  const spawn = vi.fn(() => {
    const output = outputs[call++];
    if (!output) throw new Error('unexpected dispatch');
    output.beforeReturn?.();
    return { status: output.exit ?? 0, stdout: output.lines.join('\n'), stderr: '' };
  });
  const result = await executeLeg({
    spawn,
    gradlewPath: path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
    projectRoot: root,
    modules: owners.map(name => ({ name, type: 'android', effectiveHasFlavor: true, sourceSets: { test: true } })),
    testType: '', opts: parseArgs([]), env: {}, config: null, log: () => {}, state,
  });
  expect(spawn).toHaveBeenCalledTimes(outputs.length);
  return { state, result };
}

describe('umbrella JUnit child cache accounting', () => {
  it.each(['UP-TO-DATE', 'FROM-CACHE'])('counts mixed fresh and %s children without inflating task telemetry', async suffix => {
    fixture();
    writeXml(first, 1000);
    writeXml(second, -60_000);
    const { state, result } = await run([{ lines: [taskLine(first), taskLine(second, suffix), taskLine('test'), 'BUILD SUCCESSFUL'] }]);
    expect(junitTestCountFor(root, `:${moduleName}:test`)).toBe(4);
    expect(state.tests).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 4 });
    expect(result.execution).toEqual({ fresh: 1, up_to_date: 0, from_cache: 0, no_source: 0, skipped_by_gradle: 0, failed: 0, no_evidence: 0 });
    expect(state.warnings).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  it.each(['unknown', 'fresh', 'FAILED', 'SKIPPED', 'NO-SOURCE'])('retains the stale guard for a %s child even when the umbrella is reused', async mode => {
    fixture();
    writeXml(first, 1000);
    writeXml(second, -60_000);
    const lines = [taskLine(first), taskLine('test', 'UP-TO-DATE'), 'BUILD SUCCESSFUL'];
    if (mode !== 'unknown') lines.unshift(taskLine(second, mode === 'fresh' ? '' : mode));
    const { state, result } = await run([{ lines }]);
    expect(state.tests.individual_total).toBe(2);
    expect(result.execution.up_to_date).toBe(1);
    expect(state.tests.total).toBe(1);
  });

  it('requires the exact module and child task path', async () => {
    fixture();
    writeXml(first, 1000);
    writeXml(second, -60_000);
    const { state } = await run([{ lines: [taskLine(first), taskLine(second, 'UP-TO-DATE', 'other:library'), taskLine(second + 'Extra', 'FROM-CACHE'), taskLine('test')] }]);
    expect(state.tests.individual_total).toBe(2);
  });

  it('does not trust conflicting cached and failed child lines', async () => {
    fixture();
    writeXml(first, 1000);
    writeXml(second, -60_000);
    const { state } = await run([{ lines: [taskLine(first), taskLine(second, 'UP-TO-DATE'), taskLine(second, 'FAILED'), taskLine('test')] }]);
    expect(state.tests.individual_total).toBe(2);
  });

  it('counts fresh failed XML and reused XML consistently with extracted failures', async () => {
    fixture();
    writeXml(first, 1000, failedXml);
    writeXml(second, -60_000, failedXml);
    const { state } = await run([{ exit: 1, lines: [taskLine(first, 'FAILED'), taskLine(second, 'FROM-CACHE'), taskLine('test', 'FAILED')] }]);
    expect(state.tests).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0, individual_total: 4 });
    expect(state.modules[0].test_failures).toHaveLength(2);
  });

  it('preserves oversized XML guards and warning deduplication for reused children', async () => {
    fixture();
    process.env.KMP_JUNIT_XML_MAX_MB = '1';
    writeXml(first, 1000, failedXml);
    writeXml(second, -60_000, failedXml.replace('</testsuite>', `<system-out>${'x'.repeat(1_100_000)}</system-out></testsuite>`));
    const { state } = await run([{ exit: 1, lines: [taskLine(first, 'FAILED'), taskLine(second, 'UP-TO-DATE'), taskLine('test', 'FAILED')] }]);
    expect(state.tests.individual_total).toBe(2);
    expect(state.modules[0].test_failures).toHaveLength(1);
    expect(state.warnings.map(w => w.code)).toEqual(['junit_xml_oversized']);
  });

  it('keeps direct JVM test reuse unchanged', async () => {
    fixture();
    writeXml('test', -60_000);
    const { state } = await run([{ lines: [taskLine('test', 'UP-TO-DATE'), 'BUILD SUCCESSFUL'] }]);
    expect(state.tests.individual_total).toBe(2);
  });
});

describe('umbrella JUnit evidence belongs to the final task attempt', () => {
  it('uses cached child evidence from the successful cascade retry', async () => {
    fixture();
    writeXml(first, 3000);
    writeXml(second, -60_000);
    const { state, result } = await run([
      { exit: 1, lines: ['BUILD FAILED'], beforeReturn: () => Date.now.mockReturnValue(startMs + 2000) },
      { lines: [taskLine(first), taskLine(second, 'FROM-CACHE'), taskLine('test'), 'BUILD SUCCESSFUL'] },
    ]);
    expect(result.cascadeDetected).toBe(true);
    expect(state.tests.individual_total).toBe(4);
    expect(result.execution.fresh).toBe(1);
  });

  it('does not carry cached child evidence from the abandoned first attempt', async () => {
    fixture();
    writeXml(first, 3000);
    writeXml(second, -60_000);
    const { state } = await run([
      { exit: 1, lines: [taskLine(second, 'FROM-CACHE'), 'BUILD FAILED'], beforeReturn: () => Date.now.mockReturnValue(startMs + 2000) },
      { lines: [taskLine(first), taskLine('test'), 'BUILD SUCCESSFUL'] },
    ]);
    expect(state.tests.individual_total).toBe(2);
  });

  it('does not count a first-attempt XML as fresh in the retry', async () => {
    fixture();
    writeXml(first, 3000);
    writeXml(second, 1000);
    const { state } = await run([
      { exit: 1, lines: ['BUILD FAILED'], beforeReturn: () => Date.now.mockReturnValue(startMs + 2000) },
      { lines: [taskLine(first), taskLine(second, 'FAILED'), taskLine('test', 'FAILED')], exit: 1 },
    ]);
    expect(state.tests.individual_total).toBe(2);
  });

  it('does not borrow another module retry child evidence from merged output', async () => {
    fixture();
    writeXml(first, 3000);
    writeXml(second, -60_000);
    writeXml(first, 3000, xml, 'other');
    const { state } = await run([
      { exit: 1, lines: ['BUILD FAILED'], beforeReturn: () => Date.now.mockReturnValue(startMs + 2000) },
      { lines: [taskLine(first), taskLine('test'), 'BUILD SUCCESSFUL'] },
      { lines: [taskLine(second, 'UP-TO-DATE'), taskLine(first, '', 'other'), taskLine('test', '', 'other'), 'BUILD SUCCESSFUL'] },
    ], [moduleName, 'other']);
    expect(state.tests.individual_total).toBe(4);
    expect(state.tests.total).toBe(2);
  });
});
