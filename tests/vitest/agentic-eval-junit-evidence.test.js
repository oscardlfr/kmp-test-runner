// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-junit-evidence.test.js -- direct unit coverage for
// tools/agentic-eval/junit-evidence.mjs: countEvidenceTaskJunit (a genuinely single-pass, bounded
// JUnit-XML read -- supersedes matrix-runner.mjs's deleted captureGradleJunitEvidence, whose own
// coverage lived in the now-removed agentic-eval-matrix-runner.test.js) and attributeCondition (the
// new per-attempt, tool_use_id-keyed correlation logic that replaces the old condition-wide pooled
// snapshot entirely).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { countEvidenceTaskJunit, attributeCondition, MAX_JUNIT_XML_FILES } from '../../tools/agentic-eval/junit-evidence.mjs';
import { sha256Hex } from '../../tools/agentic-eval/junit-evidence-io.mjs';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Lay down <root>/<mod>/build/test-results/<task>/TEST-<name>.xml -- mirrors junit-xml.test.js's
// own writeXml helper exactly (same directory convention forEachJunitXml itself expects).
function writeXml(root, mod, task, name, xml) {
  const dir = path.join(root, mod, 'build', 'test-results', task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `TEST-${name}.xml`), xml, 'utf8');
}

describe('countEvidenceTaskJunit -- absent XML vs. real XML reporting zero, kept distinct', () => {
  it('no build/test-results/<task>/ directory at all (nothing ever ran, or ran against the wrong task) -- returns {status:"no_xml"}', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'no_xml' });
  });

  it('a REAL XML file exists and genuinely reports zero testcases (an empty <testsuite>) -- returns a real {status:"ok", junit:{total:0,...}} snapshot, distinct from "no evidence at all"', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'Empty', '<testsuite name="Empty" tests="0"></testsuite>');
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'ok', junit: { total: 0, passed: 0, failed: 0 } });
  });

  it('a real XML file with real passing testcases -- returns the real, non-zero counts (regression guard: the no_xml-on-absence fix does not regress the ordinary case)', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="a" classname="com.x.A" time="0.1"/>',
      '  <testcase name="b" classname="com.x.A" time="0.1"/>',
      '</testsuite>',
    ].join('\n'));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'ok', junit: { total: 2, passed: 2, failed: 0 } });
  });

  it('a real XML file with a real failure -- failed count still correctly derived when XML genuinely exists', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="ok" classname="com.x.A" time="0.1"/>',
      '  <testcase name="boom" classname="com.x.A" time="0.1">',
      '    <failure type="org.opentest4j.AssertionFailedError" message="expected &lt;1&gt; but was &lt;2&gt;">stack</failure>',
      '  </testcase>',
      '</testsuite>',
    ].join('\n'));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'ok', junit: { total: 2, passed: 1, failed: 1 } });
  });

  // Aggregating across TWO SEPARATE XML files in one call proves this is a genuinely single,
  // coherent walk (both files' testcases land in the SAME running total), not merely "returns
  // something plausible" -- the old captureGradleJunitEvidence bug was three SEPARATE
  // forEachJunitXml walks (one direct, one via junitTestCountFor, one via junitTestFailuresFor);
  // a single-walk implementation naturally sums across every file it visits in that one pass.
  it('aggregates testcases across MULTIPLE XML files under the same task directory in one pass', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', '<testsuite name="A" tests="1"><testcase name="a" classname="com.x.A" time="0.1"/></testsuite>');
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'B', [
      '<testsuite name="B" tests="1">',
      '  <testcase name="b" classname="com.x.B" time="0.1"><failure type="x" message="m">s</failure></testcase>',
      '</testsuite>',
    ].join('\n'));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'ok', junit: { total: 2, passed: 1, failed: 1 } });
  });
});

describe('countEvidenceTaskJunit -- skip/anomaly detection (never a false pass/fail count)', () => {
  it('EXACT REPRODUCTION: a real XML with one pass and one skipped testcase previously (captureGradleJunitEvidence) produced {total:2,passed:2,failed:0} -- now returns an integrity_error instead', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="ok" classname="com.x.A" time="0.1"/>',
      '  <testcase name="skippedOne" classname="com.x.A" time="0.0">',
      '    <skipped/>',
      '  </testcase>',
      '</testsuite>',
    ].join('\n'));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'integrity_error', reason: 'skipped_testcase_unsupported' });
  });

  it('a self-closing <skipped/> testcase (no separate pass) is also detected', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="1">',
      '  <testcase name="skippedOnly" classname="com.x.A" time="0.0"><skipped/></testcase>',
      '</testsuite>',
    ].join('\n'));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'integrity_error', reason: 'skipped_testcase_unsupported' });
  });

  it('an oversized XML file (exceeds the real forEachJunitXml per-file size cap) is reported as a read anomaly, never silently undercounted', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    const taskDir = path.join(workDir, 'shared', 'build', 'test-results', 'testAndroidHostTest');
    mkdirSync(taskDir, { recursive: true });
    // DEFAULT_JUNIT_XML_MAX_MB is 32 -- write something larger via a padded <system-out>.
    const padding = 'x'.repeat(33 * 1024 * 1024);
    writeFileSync(path.join(taskDir, 'TEST-Huge.xml'), `<testsuite><testcase name="a" classname="com.x.A"><system-out>${padding}</system-out></testcase></testsuite>`, 'utf8');
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'integrity_error', reason: 'junit_xml_read_anomaly' });
  });

  it('regression guard: a real failure with NO skip and NO anomaly still returns the real counts, unaffected by the skip/anomaly detection', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    writeXml(workDir, 'shared', 'testAndroidHostTest', 'A', [
      '<testsuite name="A" tests="2">',
      '  <testcase name="ok" classname="com.x.A" time="0.1"/>',
      '  <testcase name="boom" classname="com.x.A" time="0.1">',
      '    <failure type="org.opentest4j.AssertionFailedError" message="expected &lt;1&gt; but was &lt;2&gt;">stack</failure>',
      '  </testcase>',
      '</testsuite>',
    ].join('\n'));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'ok', junit: { total: 2, passed: 1, failed: 1 } });
  });
});

// Round-5 fixed, documented numeric limits: MAX_JUNIT_XML_FILES=2000, MAX_JUNIT_XML_AGGREGATE_
// BYTES=64 MiB. Both bounds share the exact same sentinel-throw-and-catch mechanism (one
// `if (fileCount > MAX_JUNIT_XML_FILES || totalBytes > MAX_JUNIT_XML_AGGREGATE_BYTES) throw ...`
// inside the single visitor) -- proven directly against the real, documented threshold values
// below, not an injected/mocked stand-in.
describe('countEvidenceTaskJunit -- aggregate byte cap (MAX_JUNIT_XML_AGGREGATE_BYTES = 64 MiB) actually halts the walk, not just the reported status', () => {
  const ONE_MB = 1024 * 1024;

  function xmlOfSize(name, approxBytes) {
    const testcaseOverhead = `<testsuite><testcase name="${name}" classname="com.x.A"><system-out></system-out></testcase></testsuite>`.length;
    const padding = 'x'.repeat(Math.max(0, approxBytes - testcaseOverhead));
    return `<testsuite><testcase name="${name}" classname="com.x.A"><system-out>${padding}</system-out></testcase></testsuite>`;
  }

  it('several files comfortably UNDER the 64 MiB aggregate (e.g. 3 x 1 MiB) are all read cleanly -- status:"ok", not integrity_error', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    for (const n of ['A', 'B', 'C']) writeXml(workDir, 'shared', 'testAndroidHostTest', n, xmlOfSize(n, ONE_MB));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result.status).toBe('ok');
    expect(result.junit.total).toBe(3);
  });

  it('a set of files whose combined size EXCEEDS the 64 MiB aggregate cap trips capture_bounds_exceeded, even though every individual file is well under the 32 MiB per-file cap', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    // 4 files x 20 MiB = 80 MiB aggregate -- each individually well under the 32 MiB per-file cap
    // (so forEachJunitXml's own onOversized never fires), but the SUM exceeds 64 MiB, the exact gap
    // the per-file guard alone cannot close.
    for (const n of ['A', 'B', 'C', 'D']) writeXml(workDir, 'shared', 'testAndroidHostTest', n, xmlOfSize(n, 20 * ONE_MB));
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'integrity_error', reason: 'capture_bounds_exceeded' });
  });
});

describe('countEvidenceTaskJunit -- aggregate file-count cap (MAX_JUNIT_XML_FILES = 2000) at the real, documented threshold', () => {
  // Writes real files (no mocking) at MAX_JUNIT_XML_FILES and MAX_JUNIT_XML_FILES+1 -- slower than
  // the rest of this suite (thousands of small file writes), but proves the actual exported
  // constant is what gates the walk, not an approximation of it.
  it(`exactly MAX_JUNIT_XML_FILES (${MAX_JUNIT_XML_FILES}) tiny files are all read cleanly -- status:"ok", the boundary itself is not yet exceeded`, () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    for (let i = 0; i < MAX_JUNIT_XML_FILES; i++) {
      writeXml(workDir, 'shared', 'testAndroidHostTest', `F${i}`, `<testsuite><testcase name="t" classname="com.x.A"/></testsuite>`);
    }
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'ok', junit: { total: MAX_JUNIT_XML_FILES, passed: MAX_JUNIT_XML_FILES, failed: 0 } });
  }, 30000);

  it(`ONE MORE than MAX_JUNIT_XML_FILES (${MAX_JUNIT_XML_FILES + 1} total) trips capture_bounds_exceeded`, () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-evidence-'));
    for (let i = 0; i < MAX_JUNIT_XML_FILES + 1; i++) {
      writeXml(workDir, 'shared', 'testAndroidHostTest', `F${i}`, `<testsuite><testcase name="t" classname="com.x.A"/></testsuite>`);
    }
    const result = countEvidenceTaskJunit(workDir, ':shared:testAndroidHostTest');
    expect(result).toEqual({ status: 'integrity_error', reason: 'capture_bounds_exceeded' });
  }, 30000);
});

// --- attributeCondition -------------------------------------------------------------------------

const SCENARIO = {
  expected: {
    module: ':shared',
    gradle: { allowed_invocations: [':shared:testAndroidHostTest'] },
  },
};

function makeEvidenceDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-attribute-condition-'));
  mkdirSync(path.join(dir, 'decisions'), { recursive: true });
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  mkdirSync(path.join(dir, 'anomalies'), { recursive: true });
  return dir;
}
function writeDecision(dir, id, decision, command) {
  writeFileSync(path.join(dir, 'decisions', `${sha256Hex(id)}.json`), JSON.stringify({ decision, command }));
}
function writeEvidence(dir, id, command, result) {
  writeFileSync(path.join(dir, 'evidence', `${sha256Hex(id)}.json`), JSON.stringify({ command, ...result }));
}
function writeAnomaly(dir, id, reason) {
  writeFileSync(path.join(dir, 'anomalies', `${sha256Hex(id)}.json`), JSON.stringify({ reason }));
}
const GRADLE_CMD = './gradlew.bat :shared:testAndroidHostTest --console=plain';
const KMP_TEST_CMD = 'kmp-test parallel --module-filter shared --json';

describe('attributeCondition -- deny exclusion', () => {
  it('a decision:"deny" Gradle attempt is excluded from perAttemptJunit entirely, and never marked incomplete or ambiguous', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'deny', GRADLE_CMD);
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.get('t1')).toBe('deny');
      expect(result.perAttemptJunit.has('t1')).toBe(false);
      expect(result.captureIncomplete).toBe(false);
      expect(result.ambiguousJunitEvidence).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attributeCondition -- missing decision for ANY relevant attempt sets captureIncomplete, scanned across every attempt not just terminal', () => {
  // Direct regression proof for the round-4/round-5 finding: a Gradle attempt's OWN evidence
  // capture goes missing (decision recorded, but the PostToolUse hook never wrote an evidence
  // record), and a LATER kmp-test attempt on the same module is clean and would become terminal at
  // the graders.mjs level. Scoping the integrity scan to only "terminal" (mirroring
  // parallelEvidenceMalformed) would have completely missed the earlier attempt's real capture
  // failure -- this proves the whole-condition, all-relevant-attempts scan catches it regardless.
  it('Gradle attempt has an "allow" decision but NO evidence record at all, followed by a clean, terminal kmp-test attempt -- captureIncomplete:true despite the terminal attempt looking clean', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD); // Gradle: decision recorded...
      // ...but no writeEvidence(dir, 't1', ...) call at all -- the capture step silently failed.
      writeDecision(dir, 't2', 'allow', KMP_TEST_CMD); // kmp-test: clean, self-contained, terminal.
      const bashResults = [
        { index: 1, id: 't1', command: GRADLE_CMD },
        { index: 2, id: 't2', command: KMP_TEST_CMD },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.captureIncomplete).toBe(true);
      expect(result.decisionByAttempt.get('t2')).toBe('allow'); // the kmp-test attempt itself is fine
      expect(result.ambiguousJunitEvidence).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing decision record for a relevant kmp-test-parallel attempt ALSO sets captureIncomplete (any provider, not just Gradle)', () => {
    const dir = makeEvidenceDir();
    try {
      // No writeDecision at all for t1 -- simulating the policy hook's own decision-record write
      // never landing.
      const bashResults = [{ index: 1, id: 't1', command: KMP_TEST_CMD }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.captureIncomplete).toBe(true);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attributeCondition -- anomaly tombstone always forces captureIncomplete, regardless of what decisions/evidence independently contain', () => {
  it('a fully well-formed decision AND evidence record for an id that ALSO has an anomalies/ tombstone -- captureIncomplete:true, the tombstone wins', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      writeAnomaly(dir, 't1', 'duplicate_decision_write');
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.captureIncomplete).toBe(true);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
      expect(result.perAttemptJunit.get('t1')).toEqual({ status: 'integrity_error', reason: 'duplicate_write' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attributeCondition -- same-transcript-index conflict vs. different-index sequential attempts', () => {
  it('two relevant, ALLOWED attempts sharing the SAME .index (a genuine same-turn concurrent dispatch) trip ambiguousJunitEvidence:true, and each resolves to {status:"conflict"}', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      writeDecision(dir, 't2', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't2', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      const bashResults = [
        { index: 5, id: 't1', command: GRADLE_CMD },
        { index: 5, id: 't2', command: GRADLE_CMD },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.ambiguousJunitEvidence).toBe(true);
      // Each conflicting attempt gets its OWN {status:'conflict'} entry, keyed by its own id -- a
      // same-turn conflict never collapses two distinct attempts into one shared slot.
      expect(result.perAttemptJunit.get('t1')).toEqual({ status: 'conflict' });
      expect(result.perAttemptJunit.get('t2')).toEqual({ status: 'conflict' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two relevant, ALLOWED attempts at DIFFERENT .index values (genuinely sequential) do NOT trip ambiguity -- each attributes its own clean evidence independently', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 20, failed: 4 } });
      writeDecision(dir, 't2', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't2', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      const bashResults = [
        { index: 1, id: 't1', command: GRADLE_CMD },
        { index: 2, id: 't2', command: GRADLE_CMD },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.ambiguousJunitEvidence).toBe(false);
      expect(result.perAttemptJunit.get('t1')).toEqual({ command: GRADLE_CMD, status: 'ok', junit: { total: 24, passed: 20, failed: 4 } });
      expect(result.perAttemptJunit.get('t2')).toEqual({ command: GRADLE_CMD, status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two DENIED attempts sharing the same .index never trigger ambiguity -- the concurrency check groups only decision:"allow" entries, filtered BEFORE grouping', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'deny', GRADLE_CMD);
      writeDecision(dir, 't2', 'deny', GRADLE_CMD);
      const bashResults = [
        { index: 5, id: 't1', command: GRADLE_CMD },
        { index: 5, id: 't2', command: GRADLE_CMD },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.ambiguousJunitEvidence).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attributeCondition -- unreliable evidence (integrity_error) surfaces independently of captureIncomplete', () => {
  it('an allowed Gradle attempt whose evidence record itself carries status:"integrity_error" sets unreliable:true, without necessarily setting captureIncomplete', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'integrity_error', reason: 'skipped_testcase_unsupported' });
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.unreliable).toBe(true);
      expect(result.captureIncomplete).toBe(false);
      expect(result.perAttemptJunit.get('t1')).toEqual({ command: GRADLE_CMD, status: 'integrity_error', reason: 'skipped_testcase_unsupported' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attributeCondition -- lifecycle-alias relevance (decision 3 contract)', () => {
  it('a Gradle command invoking a policy-permitted lifecycle alias (present in allowed_invocations, distinct from the literal evidence_task) is still tracked and attributed', () => {
    const scenarioWithAlias = { expected: { module: ':app', gradle: { allowed_invocations: [':app:testDebugUnitTest', ':app:test'] } } };
    const dir = makeEvidenceDir();
    try {
      const aliasCmd = './gradlew.bat :app:test --console=plain';
      writeDecision(dir, 't1', 'allow', aliasCmd);
      writeEvidence(dir, 't1', aliasCmd, { status: 'ok', junit: { total: 1, passed: 1, failed: 0 } });
      const bashResults = [{ index: 1, id: 't1', command: aliasCmd }];
      const result = attributeCondition(dir, scenarioWithAlias, bashResults);
      expect(result.decisionByAttempt.get('t1')).toBe('allow');
      expect(result.perAttemptJunit.get('t1')).toEqual({ command: aliasCmd, status: 'ok', junit: { total: 1, passed: 1, failed: 0 } });
      expect(result.captureIncomplete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a Gradle command outside allowed_invocations entirely is not tracked at all -- never even reaches captureIncomplete', () => {
    const dir = makeEvidenceDir();
    try {
      // No sidecar records written for this id at all -- if this command were (wrongly) considered
      // relevant, the missing decision would trip captureIncomplete.
      const bashResults = [{ index: 1, id: 't1', command: './gradlew.bat :shared:build --console=plain' }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.captureIncomplete).toBe(false);
      expect(result.decisionByAttempt.has('t1')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attributeCondition -- command cross-check mismatch is always a hard anomaly', () => {
  it('a decision record whose own stored command differs from the transcript\'s bashResults[i].command sets captureIncomplete:true', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', './gradlew.bat :shared:testAndroidHostTest --console=plain --SOMETHING-ELSE');
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.captureIncomplete).toBe(true);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an evidence record whose own stored command differs from the transcript command sets captureIncomplete:true', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', './gradlew.bat :shared:testAndroidHostTest --console=plain --SOMETHING-ELSE', { status: 'ok', junit: { total: 1, passed: 1, failed: 0 } });
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attributeCondition -- an incoherent decision value (neither allow nor deny) always sets captureIncomplete, timeout or not', () => {
  it('a decision record present but carrying an unrecognized decision string', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'maybe', GRADLE_CMD);
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.captureIncomplete).toBe(true);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Round-5 narrowed-timeout-tolerance matrix -- one test per case, matching the plan's own required
// granularity. Every case uses the SAME single, LAST relevant attempt under a genuine timeout
// termination; cases (c)-(f) are direct regression tests for round 5's "the timeout exception was
// too broad" finding (an earlier revision skipped ALL checks for the trailing attempt under
// timeout, not just a genuinely-missing record). Every fixture below sets `resultFound: false`
// explicitly (real bashResults entries always carry this field -- see
// findBashToolUsesWithResults) to genuinely represent "this specific Bash call has no correlated
// tool_result at all," the precise, narrower condition a later adversarial review (P1b) required --
// see the dedicated "resultFound" describe block below for the regression proof itself.
describe('attributeCondition -- round-5 narrowed timeout tolerance: ONLY a genuinely absent record is tolerated', () => {
  const TIMEOUT_INFO = { terminated: true, terminationReason: 'timeout' };

  it('(a) last attempt, genuine timeout, decision record entirely ABSENT -- tolerated, captureIncomplete stays false', () => {
    const dir = makeEvidenceDir();
    try {
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      expect(result.captureIncomplete).toBe(false);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contrast for (a): the SAME missing-decision shape WITHOUT a genuine timeout termination is NOT tolerated -- proves the tolerance is genuinely timeout-gated, not unconditional', () => {
    const dir = makeEvidenceDir();
    try {
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, { terminated: false, terminationReason: null });
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) last attempt, genuine timeout, decision found "allow" but evidence record entirely ABSENT -- tolerated, captureIncomplete stays false', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      expect(result.captureIncomplete).toBe(false);
      expect(result.perAttemptJunit.has('t1')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contrast for (b): the SAME missing-evidence shape WITHOUT a genuine timeout termination IS captureIncomplete:true', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, { terminated: false, terminationReason: null });
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) last attempt under genuine timeout, but it has an anomalies/ tombstone -- captureIncomplete:true regardless of timeout', () => {
    const dir = makeEvidenceDir();
    try {
      writeAnomaly(dir, 't1', 'duplicate_decision_write');
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) last attempt under genuine timeout, but its decision record EXISTS with an incoherent value -- captureIncomplete:true regardless of timeout', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'maybe', GRADLE_CMD);
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(e) last attempt under genuine timeout, evidence record EXISTS with status:"integrity_error" -- unreliable:true regardless of timeout', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'integrity_error', reason: 'junit_xml_read_anomaly' });
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      expect(result.unreliable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(f) last attempt under genuine timeout, but a command-string cross-check mismatch -- captureIncomplete:true regardless of timeout', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', './gradlew.bat :shared:testAndroidHostTest --console=plain --SOMETHING-ELSE');
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the timeout tolerance applies ONLY to the LAST relevant attempt -- an EARLIER attempt missing its decision under the same timeout condition still sets captureIncomplete:true', () => {
    const dir = makeEvidenceDir();
    try {
      // t1 (earlier, index 1) has no decision record at all -- NOT the last relevant attempt.
      writeDecision(dir, 't2', 'allow', GRADLE_CMD); // t2 (index 2) is the last relevant attempt, complete.
      writeEvidence(dir, 't2', GRADLE_CMD, { status: 'ok', junit: { total: 1, passed: 1, failed: 0 } });
      const bashResults = [
        { index: 1, id: 't1', command: GRADLE_CMD, resultFound: false },
        { index: 2, id: 't2', command: GRADLE_CMD, resultFound: true },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F2 regression (adversarial review finding): the trailing-timeout tolerance used to key on
  // "b.index === the max index among relevant attempts", which could match MORE than one attempt
  // if the final assistant turn itself dispatched two relevant calls sharing that same index --
  // both would then be (wrongly) treated as "the last one." Fixed to use identity (the actual last
  // entry in relevant's own, order-preserving array), so exactly one specific attempt is ever
  // tolerated, never "whichever attempts happen to share the maximal index value."
  it('F2: two relevant attempts sharing the SAME (maximal) .index under a genuine timeout -- only the TRUE last one (by transcript/array order) is tolerated for a missing decision; its same-index sibling still sets captureIncomplete', () => {
    const dir = makeEvidenceDir();
    try {
      // t1 and t2 share index 5 (a same-turn dispatch) -- under the OLD index-based tolerance check
      // BOTH would satisfy "b.index === lastRelevantIndexValue" and BOTH would be excused for a
      // missing decision, leaving captureIncomplete FALSE even though t1's own capture genuinely
      // never happened. Neither has any decision record at all; both genuinely lack a tool_result
      // (a real same-turn kill-mid-flight shape).
      const bashResults = [
        { index: 5, id: 't1', command: GRADLE_CMD, resultFound: false },
        { index: 5, id: 't2', command: './gradlew.bat :shared:testAndroidHostTest --console=plain --rerun-tasks', resultFound: false },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults, TIMEOUT_INFO);
      // t2 (the true last entry in array order) is correctly tolerated for its missing decision.
      expect(result.decisionByAttempt.get('t2')).toBeNull();
      // t1 (shares the same .index value, but is NOT the true last entry) is NOT tolerated --
      // its own missing decision still sets captureIncomplete.
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// P1b regression (a fresh adversarial review found this real, confirmed defect): the trailing-
// timeout tolerance previously checked ONLY "is this the last relevant attempt AND did the whole
// CONDITION end in a timeout" -- never whether THIS SPECIFIC Bash call itself genuinely lacks a
// tool_result. A session-wide timeout can kill a LATER step (e.g. final-answer generation) after
// the last relevant Bash call already completed normally -- reproduced directly: an attempt with
// resultFound:true but a genuinely missing sidecar (an unrelated harness capture bug) incorrectly
// read as captureIncomplete:false. Fixed by additionally requiring `b.resultFound === false`,
// mirroring findIncompleteToolResultsToleratingTimeout's own convention elsewhere in this codebase.
describe('attributeCondition -- P1b: the timeout tolerance requires the SPECIFIC last attempt to genuinely lack a tool_result, not just a condition-wide timeout', () => {
  it('EXACT REPRODUCTION: last relevant attempt genuinely COMPLETED (resultFound:true) but its decision record is entirely absent, under a genuine session-wide timeout -- NOT tolerated, captureIncomplete:true', () => {
    const dir = makeEvidenceDir();
    try {
      // No decision record written at all for t1 -- but t1's own tool_result IS present (resultFound
      // true), simulating a LATER step (not this Bash call) being the one the timeout actually killed.
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: true }];
      const result = attributeCondition(dir, SCENARIO, bashResults, { terminated: true, terminationReason: 'timeout' });
      expect(result.captureIncomplete).toBe(true);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EXACT REPRODUCTION (evidence variant): last relevant attempt genuinely COMPLETED, decision found "allow", but its evidence record is entirely absent, under a genuine session-wide timeout -- NOT tolerated, captureIncomplete:true', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: true }];
      const result = attributeCondition(dir, SCENARIO, bashResults, { terminated: true, terminationReason: 'timeout' });
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contrast: the IDENTICAL shape (last attempt, missing decision, genuine timeout) but with resultFound:false (the Bash call itself genuinely has no tool_result) IS tolerated -- proves the new resultFound check is genuinely gating, not accidentally always blocking', () => {
    const dir = makeEvidenceDir();
    try {
      const bashResults = [{ index: 1, id: 't1', command: GRADLE_CMD, resultFound: false }];
      const result = attributeCondition(dir, SCENARIO, bashResults, { terminated: true, terminationReason: 'timeout' });
      expect(result.captureIncomplete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// F1 regression (HIGH-severity adversarial review finding): an earlier revision keyed
// perAttemptJunit/decisionByAttempt by bashResults[i].index -- unique per assistant TURN, not per
// attempt. Two attempts dispatched in the SAME turn (one policy-allowed, one policy-denied -- a
// real, reachable shape since Gradle-task relevance and Gradle-task policy-allowance are two
// independently-configured lists) would both write to the SAME map slot under that scheme, the
// later-processed attempt's value silently overwriting the earlier one's -- invisibly to
// ambiguousJunitEvidence (which correctly does not flag this shape: only one of the two ever
// actually executed, so there is no genuine multi-producer race). Fixed by keying both maps on
// each attempt's own tool_use_id (b.id), globally unique per Bash call.
describe('attributeCondition -- F1 regression: a same-turn ALLOWED+DENIED pair never collides (each keeps its own independent slot, keyed by id not index)', () => {
  const DENIED_CMD = './gradlew.bat :shared:testAndroidHostTest --console=plain --stacktrace';

  it('allow-first array order: the allowed attempt\'s own clean data is untouched by its denied, same-index sibling', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      writeDecision(dir, 't2', 'deny', DENIED_CMD);
      const bashResults = [
        { index: 5, id: 't1', command: GRADLE_CMD },
        { index: 5, id: 't2', command: DENIED_CMD },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      // Not a genuine conflict -- only ONE of the two ever actually executed.
      expect(result.ambiguousJunitEvidence).toBe(false);
      expect(result.decisionByAttempt.get('t1')).toBe('allow');
      expect(result.decisionByAttempt.get('t2')).toBe('deny');
      expect(result.perAttemptJunit.get('t1')).toEqual({ command: GRADLE_CMD, status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      expect(result.perAttemptJunit.has('t2')).toBe(false);
      expect(result.captureIncomplete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deny-first array order: the IDENTICAL pair in the OPPOSITE order produces the IDENTICAL, order-independent result (proves the fix is not merely "last write wins in the lucky order")', () => {
    const dir = makeEvidenceDir();
    try {
      writeDecision(dir, 't1', 'deny', DENIED_CMD);
      writeDecision(dir, 't2', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't2', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      const bashResults = [
        { index: 5, id: 't1', command: DENIED_CMD },
        { index: 5, id: 't2', command: GRADLE_CMD },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.ambiguousJunitEvidence).toBe(false);
      expect(result.decisionByAttempt.get('t1')).toBe('deny');
      expect(result.decisionByAttempt.get('t2')).toBe('allow');
      expect(result.perAttemptJunit.has('t1')).toBe(false);
      expect(result.perAttemptJunit.get('t2')).toEqual({ command: GRADLE_CMD, status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      expect(result.captureIncomplete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Final-review addition: the same-turn conflict/id-keying interaction, generalized from a PAIR to
// a TRIPLE sharing one .index -- locks the exact interaction this whole fix is about (traced by
// hand during the final review, not previously covered by an explicit test).
describe('attributeCondition -- same-turn TRIPLE (3 attempts sharing one .index): conflict detection and id-keyed storage compose correctly beyond a simple pair', () => {
  it('2 ALLOWED + 1 DENIED sharing the same .index: the conflict group is exactly the 2 allowed attempts (both {status:"conflict"}); the denied one keeps its own independent "deny" decision, untouched by the conflict', () => {
    const dir = makeEvidenceDir();
    try {
      const cmd2 = './gradlew.bat :shared:testAndroidHostTest --console=plain --rerun-tasks';
      const deniedCmd = './gradlew.bat :shared:testAndroidHostTest --console=plain --stacktrace';
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      writeDecision(dir, 't2', 'allow', cmd2);
      writeEvidence(dir, 't2', cmd2, { status: 'ok', junit: { total: 24, passed: 20, failed: 4 } });
      writeDecision(dir, 't3', 'deny', deniedCmd);
      const bashResults = [
        { index: 7, id: 't1', command: GRADLE_CMD },
        { index: 7, id: 't2', command: cmd2 },
        { index: 7, id: 't3', command: deniedCmd },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.ambiguousJunitEvidence).toBe(true);
      expect(result.perAttemptJunit.get('t1')).toEqual({ status: 'conflict' });
      expect(result.perAttemptJunit.get('t2')).toEqual({ status: 'conflict' });
      // The denied sibling never entered the conflict group at all (allowedRelevant only ever
      // contains decision:'allow' entries) -- its own decision is untouched by the pair's conflict.
      expect(result.perAttemptJunit.has('t3')).toBe(false);
      expect(result.decisionByAttempt.get('t1')).toBe('allow');
      expect(result.decisionByAttempt.get('t2')).toBe('allow');
      expect(result.decisionByAttempt.get('t3')).toBe('deny');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3 ALLOWED attempts sharing the same .index: the conflict group has all 3, every one independently resolves to its OWN {status:"conflict"} slot (no pairwise collision, no map-slot loss)', () => {
    const dir = makeEvidenceDir();
    try {
      const cmd2 = './gradlew.bat :shared:testAndroidHostTest --console=plain --rerun-tasks';
      const cmd3 = 'kmp-test parallel --module-filter shared --gradle-args --rerun-tasks --json';
      writeDecision(dir, 't1', 'allow', GRADLE_CMD);
      writeEvidence(dir, 't1', GRADLE_CMD, { status: 'ok', junit: { total: 24, passed: 24, failed: 0 } });
      writeDecision(dir, 't2', 'allow', cmd2);
      writeEvidence(dir, 't2', cmd2, { status: 'ok', junit: { total: 24, passed: 20, failed: 4 } });
      writeDecision(dir, 't3', 'allow', cmd3); // a kmp-test-parallel producer, same turn too
      const bashResults = [
        { index: 7, id: 't1', command: GRADLE_CMD },
        { index: 7, id: 't2', command: cmd2 },
        { index: 7, id: 't3', command: cmd3 },
      ];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.ambiguousJunitEvidence).toBe(true);
      // Both Gradle attempts resolve to their own conflict marker -- neither map slot was lost or
      // overwritten by the third (kmp-test-parallel) attempt sharing the same index.
      expect(result.perAttemptJunit.get('t1')).toEqual({ status: 'conflict' });
      expect(result.perAttemptJunit.get('t2')).toEqual({ status: 'conflict' });
      // kmp-test-parallel attempts never populate perAttemptJunit at all (self-contained envelope,
      // graded independently) -- still correctly present, with its own decision, in the ambiguous
      // group's accounting.
      expect(result.perAttemptJunit.has('t3')).toBe(false);
      expect(result.decisionByAttempt.get('t1')).toBe('allow');
      expect(result.decisionByAttempt.get('t2')).toBe('allow');
      expect(result.decisionByAttempt.get('t3')).toBe('allow');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Adversarial-review finding (LOW severity, diagnostic-metric drift): isRelevantKmpTestParallel
// excludes a wrong-module `parallel` call from `relevant` entirely (correctly -- it is not a
// candidate producer of the TARGET module's evidence), but graders.mjs's own evaluateKmpTestAttempt
// evaluates EVERY non-plan-only `parallel` attempt regardless of module, deferring its own
// target-match check to AFTER its deny/null gate. Without the decision-only pass below, such an
// attempt's REAL decision would never reach decisionByAttempt at all, so evaluateKmpTestAttempt
// would see `undefined` (never gates) instead of 'deny' (excludes) for a genuinely denied,
// never-executed attempt -- silently phantom-counting it in testInvocationsTotal/retries.
describe('attributeCondition -- wrong-module kmp-test parallel attempts still get their REAL decision tracked (never phantom-counted as executed when actually denied)', () => {
  it('a DENIED kmp-test parallel attempt targeting a DIFFERENT module than the scenario expects still has its real "deny" decision recorded, even though it is excluded from the whole-condition integrity scan', () => {
    const dir = makeEvidenceDir();
    try {
      const wrongModuleCmd = 'kmp-test parallel --module-filter app --json'; // SCENARIO targets :shared
      writeDecision(dir, 't1', 'deny', wrongModuleCmd);
      const bashResults = [{ index: 1, id: 't1', command: wrongModuleCmd }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.get('t1')).toBe('deny');
      // Never a JUnit-evidence candidate, and never folded into the whole-condition integrity scan
      // -- its own capture completeness says nothing about :shared's own evidence trustworthiness.
      expect(result.perAttemptJunit.has('t1')).toBe(false);
      expect(result.captureIncomplete).toBe(false);
      expect(result.ambiguousJunitEvidence).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ALLOWED kmp-test parallel attempt targeting a DIFFERENT module also gets its real "allow" decision recorded, still excluded from the integrity scan', () => {
    const dir = makeEvidenceDir();
    try {
      const wrongModuleCmd = 'kmp-test parallel --module-filter app --json';
      writeDecision(dir, 't1', 'allow', wrongModuleCmd);
      const bashResults = [{ index: 1, id: 't1', command: wrongModuleCmd }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.get('t1')).toBe('allow');
      expect(result.perAttemptJunit.has('t1')).toBe(false);
      expect(result.captureIncomplete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // EXACT REPRODUCTION, ROUND 1 (a fresh adversarial review found this real, confirmed defect): the
  // four tests below each construct one of the FOUR ways a wrong-module attempt's decision sidecar
  // can be untrustworthy -- absent, incoherent, tombstoned, or command-mismatched. An earlier
  // revision of the decision-only pass only ever SET decisionByAttempt for a fully coherent record,
  // leaving it entirely unset (`.get()` returns `undefined`) in all four of these cases. Since
  // `undefined` is graders.mjs's own reserved signal for "the mechanism was never enabled for this
  // condition at all" (which never gates), and evaluateKmpTestAttempt evaluates ANY non-plan-only
  // `parallel` attempt regardless of module BEFORE its own deny/null gate, an attempt whose own
  // decision status the harness could not even verify silently passed that gate -- phantom-counted
  // as a real execution in testInvocationsTotal/retries, a documented, publishable metric. Each case
  // here must now resolve to explicit `null` (never bare `undefined`), which DOES correctly gate.
  //
  // EXACT REPRODUCTION, ROUND 2 (a second review found round 1's fix was itself still fail-open):
  // resolving to `null` stopped the OVERcounting, but captureIncomplete was never raised for it --
  // so a real, executed attempt whose decision the harness genuinely could not verify was silently
  // EXCLUDED with no integrity signal at all, UNDERcounting testInvocationsTotal/retries with zero
  // trace that anything went wrong. Each of the four cases below now also asserts
  // captureIncomplete:true -- a harness that cannot verify whether a real Bash call was allowed or
  // denied has failed to capture it, regardless of which module it targeted.
  it('(i) a wrong-module kmp-test parallel attempt with NO decision record at all resolves to null (not undefined) AND flags captureIncomplete -- correctly excluded downstream, never phantom-countable, never silently undercounted either', () => {
    const dir = makeEvidenceDir();
    try {
      const wrongModuleCmd = 'kmp-test parallel --module-filter app --json';
      const bashResults = [{ index: 1, id: 't1', command: wrongModuleCmd }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.has('t1')).toBe(true);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
      // A real, unverifiable capture failure IS a whole-condition harness-integrity signal, even
      // though this attempt was never a candidate producer of :shared's own JUnit evidence.
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(ii) a wrong-module kmp-test parallel attempt whose decision record EXISTS but is INCOHERENT (neither allow nor deny) also resolves to null AND flags captureIncomplete', () => {
    const dir = makeEvidenceDir();
    try {
      const wrongModuleCmd = 'kmp-test parallel --module-filter app --json';
      writeDecision(dir, 't1', 'maybe', wrongModuleCmd);
      const bashResults = [{ index: 1, id: 't1', command: wrongModuleCmd }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(iii) a wrong-module kmp-test parallel attempt with an anomalies/ tombstone (a duplicate-write collision) also resolves to null AND flags captureIncomplete', () => {
    const dir = makeEvidenceDir();
    try {
      const wrongModuleCmd = 'kmp-test parallel --module-filter app --json';
      writeDecision(dir, 't1', 'allow', wrongModuleCmd); // a decision exists...
      writeAnomaly(dir, 't1', 'duplicate_decision_write'); // ...but a tombstone also exists for it
      const bashResults = [{ index: 1, id: 't1', command: wrongModuleCmd }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(iv) a wrong-module kmp-test parallel attempt whose decision record\'s OWN stored command differs from the transcript command also resolves to null AND flags captureIncomplete', () => {
    const dir = makeEvidenceDir();
    try {
      const wrongModuleCmd = 'kmp-test parallel --module-filter app --json';
      writeDecision(dir, 't1', 'allow', 'kmp-test parallel --module-filter app --json --SOMETHING-ELSE');
      const bashResults = [{ index: 1, id: 't1', command: wrongModuleCmd }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.get('t1')).toBeNull();
      expect(result.captureIncomplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a wrong-module kmp-test --dry-run call is never tracked at all, even decision-only (plan-only, never executed)', () => {
    const dir = makeEvidenceDir();
    try {
      const wrongModuleDryRun = 'kmp-test parallel --module-filter app --dry-run --json';
      writeDecision(dir, 't1', 'allow', wrongModuleDryRun);
      const bashResults = [{ index: 1, id: 't1', command: wrongModuleDryRun }];
      const result = attributeCondition(dir, SCENARIO, bashResults);
      expect(result.decisionByAttempt.has('t1')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
