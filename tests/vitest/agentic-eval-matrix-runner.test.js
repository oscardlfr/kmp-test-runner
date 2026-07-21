// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-matrix-runner.test.js -- direct unit coverage for
// tools/agentic-eval/matrix-runner.mjs's captureGradleJunitEvidence, exported specifically for
// this test. A fresh review reproduced a real gap: the function returned
// {total:0,passed:0,failed:0} whether NO JUnit XML file ever existed for the task at all, or a
// real XML file existed and genuinely reported zero testcases -- indistinguishable shapes that
// let a completely ABSENT test-results directory (nothing ever ran) grade identically to a real,
// legitimately-empty test suite, since the schema separately permitted a tests_executed contract
// to expect all-zero counts. Fixed to return null (no evidence at all) in the absent case,
// distinct from a real {total:0,...} snapshot.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureGradleJunitEvidence } from '../../tools/agentic-eval/matrix-runner.mjs';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Lay down <root>/<mod>/build/test-results/<task>/TEST-<name>.xml -- mirrors
// junit-xml.test.js's own writeXml helper exactly (same directory convention
// forEachJunitXml itself expects).
function writeXml(root, mod, task, name, xml) {
  const dir = path.join(root, mod, 'build', 'test-results', task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `TEST-${name}.xml`), xml, 'utf8');
}

const SCENARIO_1 = {
  expected: {
    outcome_kind: 'tests_executed',
    gradle: { evidence_task: ':shared:testAndroidHostTest' },
  },
};

const SCENARIO_2 = {
  expected: {
    outcome_kind: 'no_applicable_tests',
    gradle: { evidence_task: ':app:testDebugUnitTest' },
  },
};

describe('captureGradleJunitEvidence -- absent XML vs. real XML reporting zero, kept distinct', () => {
  it('no build/test-results/<task>/ directory at all (nothing ever ran, or ran against the wrong task) -- returns null, not {total:0,...}', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    // Deliberately create NOTHING under workDir/shared/build/test-results/testAndroidHostTest/ --
    // the directory itself never exists.
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toBeNull();
  });

  it('a REAL XML file exists and genuinely reports zero testcases (an empty <testsuite>) -- returns a real {total:0,passed:0,failed:0} snapshot, correctly distinct from "no evidence at all"', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'Empty', '<testsuite name="Empty" tests="0"></testsuite>');
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).not.toBeNull();
    expect(evidence).toEqual({ total: 0, passed: 0, failed: 0 });
  });

  it('a real XML file with real passing testcases -- returns the real, non-zero counts (regression guard: the null-on-absence fix does not regress the ordinary case)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="a" classname="com.x.A" time="0.1"/>',
      '  <testcase name="b" classname="com.x.A" time="0.1"/>',
      '</testsuite>',
    ].join('\n'));
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toEqual({ total: 2, passed: 2, failed: 0 });
  });

  it('a real XML file with a real failure -- failed count still correctly derived when XML genuinely exists', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="ok" classname="com.x.A" time="0.1"/>',
      '  <testcase name="boom" classname="com.x.A" time="0.1">',
      '    <failure type="org.opentest4j.AssertionFailedError" message="expected &lt;1&gt; but was &lt;2&gt;">stack</failure>',
      '  </testcase>',
      '</testsuite>',
    ].join('\n'));
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toEqual({ total: 2, passed: 1, failed: 1 });
  });

  it('no_applicable_tests scenario -- always null, regardless of what XML exists on disk (this outcome_kind never reads JUnit evidence, unchanged behavior)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'app', 'testDebugUnitTest', 'A', [
      '<testsuite name="A" tests="1">',
      '  <testcase name="a" classname="com.x.A" time="0.1"/>',
      '</testsuite>',
    ].join('\n'));
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_2);
    expect(evidence).toBeNull();
  });

  it('no evidence_task declared at all -- returns null (unchanged pre-existing behavior)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    const scenarioNoTask = { expected: { outcome_kind: 'tests_executed', gradle: {} } };
    const evidence = captureGradleJunitEvidence(workDir, scenarioNoTask);
    expect(evidence).toBeNull();
  });
});

// Round 11 (Docker/local-ci audit): a fresh review reproduced `passed = total - failures.length`
// silently misattributing a genuine <skipped> testcase to `passed` -- documented as a known
// limitation, but not acceptable for evidence that can end up benchmark_eligible:true. Fixed to
// detect a skip (or an unreadable/oversized XML file) and return {harnessIntegrityIssue:true,
// reason} instead of a miscounted total, so the caller (graders.mjs) can treat it as a
// HARNESS-INTEGRITY defect that blocks the whole matrix, never a false pass/fail count.
describe('captureGradleJunitEvidence -- skip/anomaly detection (never a false pass/fail count)', () => {
  it('EXACT REPRODUCTION: a real XML with one pass and one skipped testcase previously produced {total:2,passed:2,failed:0} -- now returns a harness-integrity signal instead', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="ok" classname="com.x.A" time="0.1"/>',
      '  <testcase name="skippedOne" classname="com.x.A" time="0.0">',
      '    <skipped/>',
      '  </testcase>',
      '</testsuite>',
    ].join('\n'));
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toEqual({ harnessIntegrityIssue: true, reason: 'skipped_testcase_unsupported' });
  });

  it('a self-closing <skipped/> testcase (no separate pass) is also detected', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="1">',
      '  <testcase name="skippedOnly" classname="com.x.A" time="0.0"><skipped/></testcase>',
      '</testsuite>',
    ].join('\n'));
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toEqual({ harnessIntegrityIssue: true, reason: 'skipped_testcase_unsupported' });
  });

  it('an oversized XML file (exceeds the real forEachJunitXml size cap) is reported as a read anomaly, never silently undercounted', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    const taskDir = path.join(workDir, 'shared', 'build', 'test-results', 'testAndroidHostTest');
    mkdirSync(taskDir, { recursive: true });
    // DEFAULT_JUNIT_XML_MAX_MB is 32 -- write something larger via a padded <system-out>.
    const padding = 'x'.repeat(33 * 1024 * 1024);
    writeFileSync(path.join(taskDir, 'TEST-Huge.xml'), `<testsuite><testcase name="a" classname="com.x.A"><system-out>${padding}</system-out></testcase></testsuite>`, 'utf8');
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toEqual({ harnessIntegrityIssue: true, reason: 'junit_xml_read_anomaly' });
  });

  it('regression guard: a real failure with NO skip and NO anomaly still returns the real counts, unaffected by the skip/anomaly detection', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="ok" classname="com.x.A" time="0.1"/>',
      '  <testcase name="boom" classname="com.x.A" time="0.1">',
      '    <failure type="org.opentest4j.AssertionFailedError" message="expected &lt;1&gt; but was &lt;2&gt;">stack</failure>',
      '  </testcase>',
      '</testsuite>',
    ].join('\n'));
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toEqual({ total: 2, passed: 1, failed: 1 });
  });

  it('regression guard: a real, genuinely clean run (all real passes, no skips) still returns the real counts', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-matrix-runner-junit-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="a" classname="com.x.A" time="0.1"/>',
      '  <testcase name="b" classname="com.x.A" time="0.1"/>',
      '</testsuite>',
    ].join('\n'));
    const evidence = captureGradleJunitEvidence(workDir, SCENARIO_1);
    expect(evidence).toEqual({ total: 2, passed: 2, failed: 0 });
  });
});
