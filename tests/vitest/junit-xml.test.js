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
  junitTestStatsFor,
  junitTestFailuresFor,
  forEachJunitXml,
  extractTestcaseFailures,
  decodeXmlEntities,
  resolveJunitXmlMaxBytes,
  DEFAULT_JUNIT_XML_MAX_MB,
  _resetJunitXmlWarnLatch,
  isInstrumentedTask,
} from '../../lib/parsers/junit-xml.js';
import { pickGradleTaskFor } from '../../lib/orchestrators/parallel/dispatch.js';
import { TEST_TYPE_VALUES } from '../../lib/parsers/argv-constants.js';

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

// ---------------------------------------------------------------------------
// junitTestStatsFor: total, failed and skipped testcase executions from the same files junitTestCountFor walks
// ---------------------------------------------------------------------------
const MIXED_XML = [
  '<testsuite name="S" tests="5">',
  '  <testcase name="ok" classname="com.x.S" time="0.1"/>',
  '  <testcase name="boom" classname="com.x.S" time="0.1"><failure type="T" message="m">stack</failure></testcase>',
  '  <testcase name="err" classname="com.x.S" time="0.1"><error type="E" message="m"/></testcase>',
  '  <testcase name="skip" classname="com.x.S" time="0.0"><skipped/></testcase>',
  '  <testcase name="skip2" classname="com.x.S" time="0.0"><skipped message="not now"></skipped></testcase>',
  '  <system-out><![CDATA[plain text]]></system-out>',
  '</testsuite>',
].join('\n');

describe('junitTestStatsFor', () => {
  it('counts every testcase, those with a <failure> or <error> child and those with a <skipped> child', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'core', 'jvmTest', 'A', MIXED_XML);
    expect(junitTestStatsFor(workDir, ':core:jvmTest')).toEqual({ total: 5, failed: 2, skipped: 2 });
  });

  it('its total is junitTestCountFor and its failed is the number of junitTestFailuresFor entries', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'core', 'jvmTest', 'A', MIXED_XML);
    writeXml(workDir, 'core', 'jvmTest', 'B', FAILING_XML);
    writeXml(workDir, 'core', 'jvmTest', 'C');
    const stats = junitTestStatsFor(workDir, ':core:jvmTest');
    expect(stats.total).toBe(junitTestCountFor(workDir, ':core:jvmTest'));
    expect(stats.failed).toBe(junitTestFailuresFor(workDir, ':core:jvmTest').length);
    expect(stats).toEqual({ total: 9, failed: 3, skipped: 2 });
  });

  it('counts a passing report with skipped testcases (no failure) and a missing directory as zeros', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'core', 'jvmTest', 'A', '<testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuite>');
    expect(junitTestStatsFor(workDir, ':core:jvmTest')).toEqual({ total: 2, failed: 0, skipped: 1 });
    expect(junitTestStatsFor(workDir, ':missing:test')).toEqual({ total: 0, failed: 0, skipped: 0 });
    expect(junitTestStatsFor('/nonexistent', ':jvmTest')).toEqual({ total: 0, failed: 0, skipped: 0 });
  });

  it('walks the same directories as the count: the umbrella test task aggregates every *UnitTest dir, each flavor run counts', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    for (const variant of ['testDemoDebugUnitTest', 'testProdDebugUnitTest']) {
      writeXml(workDir, 'core', variant, 'S', [
        '<testsuite>',
        '<testcase name="a"/>',
        '<testcase name="b"><failure message="x"/></testcase>',
        '<testcase name="c"><skipped/></testcase>',
        '</testsuite>',
      ].join('\n'));
    }
    expect(junitTestStatsFor(workDir, ':core:test')).toEqual({ total: 6, failed: 2, skipped: 2 });
  });

  it('keeps the stale-XML guard and reports oversized files through the collector like the count does', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    const file = writeXml(workDir, 'core', 'jvmTest', 'A', MIXED_XML);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
    expect(junitTestStatsFor(workDir, ':core:jvmTest', Date.now() - 60_000)).toEqual({ total: 0, failed: 0, skipped: 0 });
    process.env.KMP_JUNIT_XML_MAX_MB = '1';
    writeXml(workDir, 'core', 'jvmTest', 'Big', `<testsuite><testcase name="a"/><system-out>${'x'.repeat(1_100_000)}</system-out></testsuite>`);
    const anomalies = [];
    expect(junitTestStatsFor(workDir, ':core:jvmTest', 0, anomalies).total).toBe(5);
    expect(anomalies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AGP's connected-test results belong to instrumented tasks only
// ---------------------------------------------------------------------------
// forEachJunitXml used to add build/outputs/androidTest-results/connected/ for EVERY task of a module. Results that an
// earlier device run left there were then counted for unit-test tasks, and for an UP-TO-DATE or FROM-CACHE task (sinceMs 0,
// no freshness cutoff) for good: individual_total was inflated and a green run could report individual_failed > 0 (a real
// project showed 4039 against 4036 test cases, and 3 failures next to tests.failed 0).
const DEVICE_FAILURE_XML = [
  '<testsuite name="com.x.Dev" tests="1" failures="1">',
  '  <testcase name="fails" classname="com.x.Dev" time="1.0">',
  '    <failure type="java.lang.AssertionError" message="device only">stack</failure>',
  '  </testcase>',
  '</testsuite>',
].join('\n');

// A result of a device run a month ago, in AGP's <sourceSet> subdirectory.
function writeStaleConnectedXml(root, mod, sourceSet = 'androidMain') {
  const dir = path.join(root, mod, 'build', 'outputs', 'androidTest-results', 'connected', sourceSet);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'TEST-device.xml');
  writeFileSync(file, DEVICE_FAILURE_XML, 'utf8');
  const old = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(file, old, old);
  return file;
}

describe('AGP connected results are read for instrumented tasks only', () => {
  const INSTRUMENTED_TASKS = [
    'connectedDebugAndroidTest', 'connectedReleaseAndroidTest', 'connectedFreeDebugAndroidTest', 'connectedAndroidTest',
    'connectedCheck', 'connectedAndroidDeviceTest', 'androidConnectedCheck',
  ];
  const UNIT_TASKS = [
    'testDebugUnitTest', 'testFreeDebugUnitTest', 'jvmTest', 'desktopTest', 'testAndroidHostTest', 'iosSimulatorArm64Test',
  ];

  it.each(UNIT_TASKS)('%s ignores a stale connected result with a failure, even with no freshness cutoff', (task) => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'app', task, 'Unit');
    writeStaleConnectedXml(workDir, 'app');
    expect(junitTestCountFor(workDir, `:app:${task}`, 0)).toBe(2);
    expect(junitTestStatsFor(workDir, `:app:${task}`, 0)).toEqual({ total: 2, failed: 0, skipped: 0 });
    expect(junitTestFailuresFor(workDir, `:app:${task}`, 0)).toEqual([]);
  });

  it('the umbrella test task (every flavor run) ignores it too', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeXml(workDir, 'app', 'testDemoDebugUnitTest', 'D');
    writeXml(workDir, 'app', 'testProdDebugUnitTest', 'P');
    writeStaleConnectedXml(workDir, 'app');
    expect(junitTestStatsFor(workDir, ':app:test', 0)).toEqual({ total: 4, failed: 0, skipped: 0 });
    expect(junitTestFailuresFor(workDir, ':app:test', 0)).toEqual([]);
  });

  it.each(INSTRUMENTED_TASKS)('%s still counts it: total, failed and the test_failures entry', (task) => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeStaleConnectedXml(workDir, 'app');
    expect(junitTestCountFor(workDir, `:app:${task}`, 0)).toBe(1);
    expect(junitTestStatsFor(workDir, `:app:${task}`, 0)).toEqual({ total: 1, failed: 1, skipped: 0 });
    const failures = junitTestFailuresFor(workDir, `:app:${task}`, 0);
    expect(failures).toHaveLength(1);
    expect(failures[0].test).toBe('com.x.Dev.fails');
  });

  it('opts.instrumented reads it under any task name, as the androidInstrumented leg does for a --device-task name', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-'));
    writeStaleConnectedXml(workDir, 'app');
    expect(junitTestCountFor(workDir, ':app:runDeviceSuite', 0)).toBe(0);
    expect(junitTestCountFor(workDir, ':app:runDeviceSuite', 0, null, { instrumented: true })).toBe(1);
    expect(junitTestStatsFor(workDir, ':app:runDeviceSuite', 0, null, { instrumented: true }))
      .toEqual({ total: 1, failed: 1, skipped: 0 });
    expect(junitTestFailuresFor(workDir, ':app:runDeviceSuite', 0, null, { instrumented: true })).toHaveLength(1);
  });

  it('isInstrumentedTask names the connected family and no unit, desktop or native test task', () => {
    for (const task of INSTRUMENTED_TASKS) expect(isInstrumentedTask(task), task).toBe(true);
    const others = [...UNIT_TASKS, 'test', 'check', 'macosArm64Test', 'jsTest', 'wasmJsTest', 'allTests', 'deviceCheck', 'connect'];
    for (const task of others) expect(isInstrumentedTask(task), task).toBe(false);
  });

  it('follows the dispatchers: a task pickGradleTaskFor gives the androidInstrumented leg is instrumented and no other leg is', () => {
    const agp = {
      name: 'app', type: 'android', androidDsl: true,
      sourceSets: { androidInstrumentedTest: true, test: true },
      resolved: { deviceTestTask: null, unitTestTask: null },
    };
    const modules = [
      agp,
      { ...agp, hasFlavor: true },
      { ...agp, testBuildType: 'release' },
      {
        name: 'feat', type: 'kmp', androidDsl: true, androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidDeviceTest: true, androidUnitTest: true, commonTest: true },
        resolved: { deviceTestTask: null, unitTestTask: 'testAndroidHostTest' },
      },
      {
        name: 'shared', type: 'kmp', sourceSets: { commonTest: true, iosMain: true },
        resolved: {
          unitTestTask: 'jvmTest', iosTestTask: 'iosSimulatorArm64Test', macosTestTask: 'macosArm64Test',
          webTestTask: 'wasmJsTest', deviceTestTask: 'connectedDebugAndroidTest',
        },
      },
    ];
    // Every device-test task the project probe can resolve (lib/project/analyze-module.js deviceCandidates).
    for (const probed of ['connectedAndroidDeviceTest', 'connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck']) {
      modules.push({ name: 'probed', type: 'kmp', sourceSets: {}, resolved: { deviceTestTask: probed } });
    }
    const optionSets = [
      {}, { androidVariant: 'debug' }, { androidVariant: 'release' }, { androidVariant: 'all' },
      { androidVariant: 'debug', flavor: 'free' },
    ];
    let instrumentedPicks = 0;
    for (const mod of modules) {
      for (const opts of optionSets) {
        for (const testType of TEST_TYPE_VALUES) {
          if (testType === 'all') continue; // expands to the other legs before dispatch
          const { task } = pickGradleTaskFor(mod, testType, opts);
          if (!task) continue;
          const instrumented = testType === 'androidInstrumented';
          if (instrumented) instrumentedPicks += 1;
          expect(isInstrumentedTask(task.split(':').pop()), `--test-type ${testType} -> ${task}`).toBe(instrumented);
        }
      }
    }
    expect(instrumentedPicks).toBeGreaterThan(20);
  });
});
