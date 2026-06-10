// SPDX-License-Identifier: MIT
// Tests for lib/parsers/junit-xml.js — first direct unit coverage for the
// parser (pre-L2 it was exercised only indirectly through
// parallel-orchestrator integration tests). Locks: testcase counting, the
// self-closing lookbehind, entity decode, failure-cause fallback ordering,
// the sinceMs stale-XML guard, umbrella-`test` sibling-dir collection, the
// AGP connected-dir walk, and the L2 oversized-XML guard (size cap +
// anomaly collector + KMP_JUNIT_XML_MAX_MB knob).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  junitTestCountFor,
  junitTestFailuresFor,
  forEachJunitXml,
  extractTestcaseFailures,
  decodeXmlEntities,
  resolveJunitXmlMaxBytes,
  DEFAULT_JUNIT_XML_MAX_MB,
  _resetJunitXmlWarnLatch,
} from '../../lib/parsers/junit-xml.js';

let workDir;
const savedMaxMb = process.env.KMP_JUNIT_XML_MAX_MB;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  if (savedMaxMb === undefined) delete process.env.KMP_JUNIT_XML_MAX_MB;
  else process.env.KMP_JUNIT_XML_MAX_MB = savedMaxMb;
  _resetJunitXmlWarnLatch();
  vi.restoreAllMocks();
});

// Lay down <root>/<mod>/build/test-results/<task>/TEST-<name>.xml and return
// the file path. `xml` defaults to a 2-testcase passing report.
function writeXml(root, mod, task, name, xml) {
  const dir = path.join(root, mod, 'build', 'test-results', task);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `TEST-${name}.xml`);
  writeFileSync(file, xml ?? [
    '<testsuite name="S" tests="2">',
    '  <testcase name="a" classname="com.x.S" time="0.1"/>',
    '  <testcase name="b" classname="com.x.S" time="0.1"/>',
    '</testsuite>',
  ].join('\n'), 'utf8');
  return file;
}

const FAILING_XML = [
  '<testsuite name="S" tests="2">',
  '  <testcase name="ok" classname="com.x.S" time="0.1"/>',
  '  <testcase name="boom" classname="com.x.S" time="0.1">',
  '    <failure type="org.opentest4j.AssertionFailedError" message="expected &lt;1&gt; but was &lt;2&gt;">stack</failure>',
  '  </testcase>',
  '</testsuite>',
].join('\n');

describe('junitTestCountFor', () => {
  it('counts <testcase> occurrences across TEST-*.xml files', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'core', 'jvmTest', 'A');
    writeXml(workDir, 'core', 'jvmTest', 'B');
    expect(junitTestCountFor(workDir, ':core:jvmTest')).toBe(4);
  });

  it('returns 0 for a single-segment task path (no module dir)', () => {
    expect(junitTestCountFor('/nonexistent', ':jvmTest')).toBe(0);
  });

  it('ignores non-TEST-prefixed and non-.xml files', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'core', 'jvmTest', 'A');
    const dir = path.join(workDir, 'core', 'build', 'test-results', 'jvmTest');
    writeFileSync(path.join(dir, 'binary-results.bin'), '<testcase/>', 'utf8');
    writeFileSync(path.join(dir, 'other.xml'), '<testcase/>', 'utf8');
    expect(junitTestCountFor(workDir, ':core:jvmTest')).toBe(2);
  });

  it('sinceMs guard excludes stale XML; sinceMs=0 includes it', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    const file = writeXml(workDir, 'core', 'jvmTest', 'Old');
    // Backdate the file 1h.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
    expect(junitTestCountFor(workDir, ':core:jvmTest', Date.now() - 60_000)).toBe(0);
    expect(junitTestCountFor(workDir, ':core:jvmTest', 0)).toBe(2);
  });

  it('umbrella `test` task collects sibling *UnitTest result dirs', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'app', 'testFreeDebugUnitTest', 'F');
    writeXml(workDir, 'app', 'testPaidDebugUnitTest', 'P');
    // Umbrella `test` has no own dir — counts must come from the siblings.
    expect(junitTestCountFor(workDir, ':app:test')).toBe(4);
  });

  it('walks the AGP connected instrumented output dir', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    const agpDir = path.join(workDir, 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'debug');
    mkdirSync(agpDir, { recursive: true });
    writeFileSync(path.join(agpDir, 'TEST-emu.xml'),
      '<testsuite><testcase name="i" classname="com.x.I"/></testsuite>', 'utf8');
    expect(junitTestCountFor(workDir, ':app:connectedDebugAndroidTest')).toBe(1);
  });

  it('nested module paths resolve (:a:b:task → a/b)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, path.join('core', 'data'), 'jvmTest', 'N');
    expect(junitTestCountFor(workDir, ':core:data:jvmTest')).toBe(2);
  });
});

describe('junitTestFailuresFor + extractTestcaseFailures', () => {
  it('extracts failing testcases with class.name, decoded cause and type', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'core', 'jvmTest', 'F', FAILING_XML);
    const out = junitTestFailuresFor(workDir, ':core:jvmTest');
    expect(out).toHaveLength(1);
    expect(out[0].test).toBe('com.x.S.boom');
    expect(out[0].cause).toBe('expected <1> but was <2>');
    expect(out[0].type).toBe('org.opentest4j.AssertionFailedError');
  });

  it('self-closing <testcase/> (passing) blocks are skipped by the lookbehind', () => {
    const out = [];
    extractTestcaseFailures([
      '<testcase name="pass" classname="C"/>',
      '<testcase name="fail" classname="C"><failure message="m">b</failure></testcase>',
    ].join('\n'), out);
    expect(out).toHaveLength(1);
    expect(out[0].test).toBe('C.fail');
  });

  it('falls back to failure body first line, then type, when message is absent', () => {
    const out = [];
    extractTestcaseFailures(
      '<testcase name="t" classname="C"><failure type="T">first line\nsecond</failure></testcase>', out);
    expect(out[0].cause).toBe('first line');

    const out2 = [];
    extractTestcaseFailures(
      '<testcase name="t" classname="C"><failure type="T"></failure></testcase>', out2);
    expect(out2[0].cause).toBe('T');
  });

  it('counts <error> children as failures too', () => {
    const out = [];
    extractTestcaseFailures(
      '<testcase name="t" classname="C"><error type="E" message="boom"/></testcase>', out);
    expect(out).toHaveLength(1);
    expect(out[0].cause).toBe('boom');
  });

  it('decodeXmlEntities decodes the five XML entities', () => {
    expect(decodeXmlEntities('&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp;d')).toBe(`<a> "b" 'c' &d`);
  });
});

describe('L2 — oversized-XML guard', () => {
  it('skips files above the cap and reports through the anomaly collector', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    process.env.KMP_JUNIT_XML_MAX_MB = '1';
    writeXml(workDir, 'core', 'jvmTest', 'Small');
    // 1.5 MB of CDATA noise → above the 1 MB cap.
    const bigBody = `<testsuite><testcase name="x" classname="C"/><system-out>${'y'.repeat(1_500_000)}</system-out></testsuite>`;
    const bigFile = writeXml(workDir, 'core', 'jvmTest', 'Big', bigBody);

    const anomalies = [];
    const count = junitTestCountFor(workDir, ':core:jvmTest', 0, anomalies);
    expect(count).toBe(2); // Small's 2 testcases only — Big skipped.
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].file).toBe(bigFile);
    expect(anomalies[0].size).toBeGreaterThan(1024 * 1024);
    expect(anomalies[0].maxBytes).toBe(1024 * 1024);
  });

  it('junitTestFailuresFor shares the same guard + collector', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    process.env.KMP_JUNIT_XML_MAX_MB = '1';
    const bigFailing = FAILING_XML.replace('</testsuite>',
      `<system-out>${'y'.repeat(1_500_000)}</system-out></testsuite>`);
    writeXml(workDir, 'core', 'jvmTest', 'BigFail', bigFailing);
    const anomalies = [];
    const out = junitTestFailuresFor(workDir, ':core:jvmTest', 0, anomalies);
    expect(out).toEqual([]); // skipped → no failures extracted
    expect(anomalies).toHaveLength(1);
  });

  it('collector omitted → oversized files are still skipped silently (back-compat 3-arg shape)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    process.env.KMP_JUNIT_XML_MAX_MB = '1';
    writeXml(workDir, 'core', 'jvmTest', 'Big',
      `<testsuite><testcase name="x" classname="C"/><system-out>${'y'.repeat(1_500_000)}</system-out></testsuite>`);
    expect(junitTestCountFor(workDir, ':core:jvmTest')).toBe(0);
  });

  it('forEachJunitXml honors an explicit opts.maxBytes override', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'core', 'jvmTest', 'A');
    const visited = [];
    const skipped = [];
    forEachJunitXml(workDir, ':core:jvmTest', 0, (_xml, file) => visited.push(file), {
      maxBytes: 10, // tiny cap — everything is oversized
      onOversized: (info) => skipped.push(info),
    });
    expect(visited).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

describe('resolveJunitXmlMaxBytes (KMP_JUNIT_XML_MAX_MB knob)', () => {
  it('defaults to 32 MB when unset / empty', () => {
    expect(resolveJunitXmlMaxBytes({})).toBe(DEFAULT_JUNIT_XML_MAX_MB * 1024 * 1024);
    expect(resolveJunitXmlMaxBytes({ KMP_JUNIT_XML_MAX_MB: '' })).toBe(DEFAULT_JUNIT_XML_MAX_MB * 1024 * 1024);
  });

  it('honors a positive integer (MB)', () => {
    expect(resolveJunitXmlMaxBytes({ KMP_JUNIT_XML_MAX_MB: '8' })).toBe(8 * 1024 * 1024);
  });

  it('warns once on stderr and falls back on garbage values', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveJunitXmlMaxBytes({ KMP_JUNIT_XML_MAX_MB: 'abc' })).toBe(DEFAULT_JUNIT_XML_MAX_MB * 1024 * 1024);
    expect(resolveJunitXmlMaxBytes({ KMP_JUNIT_XML_MAX_MB: '-3' })).toBe(DEFAULT_JUNIT_XML_MAX_MB * 1024 * 1024);
    // Warn-once latch: two bad resolutions, one stderr line.
    const warnCalls = spy.mock.calls.filter(c => String(c[0]).includes('KMP_JUNIT_XML_MAX_MB'));
    expect(warnCalls).toHaveLength(1);
  });
});
