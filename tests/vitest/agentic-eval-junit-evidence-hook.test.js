// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-junit-evidence-hook.test.js -- direct unit coverage for
// tools/agentic-eval/junit-evidence-hook.mjs's pure-ish logic (loadHookConfig,
// captureEvidenceForEvent), mirroring agentic-eval-policy-hook.test.js's own convention of testing
// the pure decision logic directly with real temp directories rather than spawning a real hook
// subprocess -- runAsHook's own stdin/timeout/process.exit wrapper is exercised for real only via
// the end-to-end fake-claude fixture tests (a full subprocess round-trip), matching the identical
// split already established for policy-hook.mjs's own runAsHook.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadHookConfig, captureEvidenceForEvent, MAX_STDIN_BYTES } from '../../tools/agentic-eval/junit-evidence-hook.mjs';
import { sha256Hex, readSidecarRecord } from '../../tools/agentic-eval/junit-evidence-io.mjs';

let fixtureRoot;
beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'aejeh-fixture-'));
});
afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeXml(root, mod, task, name, xml) {
  const dir = path.join(root, mod, 'build', 'test-results', task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `TEST-${name}.xml`), xml, 'utf8');
}

function baseEnv(evidenceDir, overrides = {}) {
  return {
    KMP_EVAL_JUNIT_EVIDENCE_DIR: evidenceDir,
    KMP_EVAL_JUNIT_EVIDENCE_TASK: ':shared:testAndroidHostTest',
    KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS: JSON.stringify([':shared:testAndroidHostTest']),
    KMP_EVAL_EXPECTED_FIXTURE_ROOT: fixtureRoot,
    ...overrides,
  };
}

function payload(eventName, command, toolUseId = 't1', overrides = {}) {
  return JSON.stringify({
    hook_event_name: eventName,
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    cwd: fixtureRoot,
    tool_input: { command },
    ...overrides,
  });
}

describe('loadHookConfig', () => {
  let evidenceDir;
  beforeAll(() => {
    evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'aejeh-evidence-'));
  });
  afterAll(() => {
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  it('returns a valid config when every env var is present and well-formed', () => {
    const config = loadHookConfig(baseEnv(evidenceDir));
    expect(config).not.toBeNull();
    expect(config.evidenceTask).toBe(':shared:testAndroidHostTest');
    expect(config.allowedInvocations).toEqual([':shared:testAndroidHostTest']);
  });

  it.each([
    'KMP_EVAL_JUNIT_EVIDENCE_DIR',
    'KMP_EVAL_JUNIT_EVIDENCE_TASK',
    'KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS',
    'KMP_EVAL_EXPECTED_FIXTURE_ROOT',
  ])('returns null (strict no-op) when %s is absent -- calibrate/smoke/no_applicable_tests never set these', (missingKey) => {
    const env = baseEnv(evidenceDir);
    delete env[missingKey];
    expect(loadHookConfig(env)).toBeNull();
  });

  it('returns null when KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS is invalid JSON', () => {
    expect(loadHookConfig(baseEnv(evidenceDir, { KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS: '{not valid json' }))).toBeNull();
  });

  it('returns null when KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS parses to a non-array', () => {
    expect(loadHookConfig(baseEnv(evidenceDir, { KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS: JSON.stringify({ not: 'an array' }) }))).toBeNull();
  });

  it('returns null when KMP_EVAL_JUNIT_EVIDENCE_DIR does not exist on disk', () => {
    expect(loadHookConfig(baseEnv(path.join(evidenceDir, 'does-not-exist-at-all')))).toBeNull();
  });

  it('returns null when KMP_EVAL_EXPECTED_FIXTURE_ROOT does not exist on disk', () => {
    expect(loadHookConfig(baseEnv(evidenceDir, { KMP_EVAL_EXPECTED_FIXTURE_ROOT: path.join(fixtureRoot, 'does-not-exist-at-all') }))).toBeNull();
  });
});

describe('captureEvidenceForEvent -- no-op paths (never write anything)', () => {
  let evidenceDir;
  beforeAll(() => {
    evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'aejeh-evidence-'));
    mkdirSync(path.join(evidenceDir, 'evidence'), { recursive: true });
    mkdirSync(path.join(evidenceDir, 'anomalies'), { recursive: true });
  });
  afterAll(() => {
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  function evidenceFileCount() {
    return readdirSync(path.join(evidenceDir, 'evidence')).length;
  }

  it('an oversized raw payload (over MAX_STDIN_BYTES) is a no-op', () => {
    const before = evidenceFileCount();
    const huge = payload('PostToolUse', './gradlew.bat :shared:testAndroidHostTest --console=plain') + 'x'.repeat(MAX_STDIN_BYTES + 10);
    captureEvidenceForEvent(huge, baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('invalid JSON is a no-op, never throws', () => {
    const before = evidenceFileCount();
    expect(() => captureEvidenceForEvent('{not valid json', baseEnv(evidenceDir))).not.toThrow();
    expect(evidenceFileCount()).toBe(before);
  });

  it('a non-object parsed payload (e.g. a bare JSON array) is a no-op', () => {
    const before = evidenceFileCount();
    captureEvidenceForEvent('[]', baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('hook_event_name other than PostToolUse/PostToolUseFailure is a no-op', () => {
    const before = evidenceFileCount();
    captureEvidenceForEvent(payload('PreToolUse', './gradlew.bat :shared:testAndroidHostTest --console=plain'), baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('tool_name other than Bash is a no-op', () => {
    const before = evidenceFileCount();
    const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't1', cwd: fixtureRoot, tool_input: { command: './gradlew.bat :shared:testAndroidHostTest --console=plain' } });
    captureEvidenceForEvent(p, baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('a missing/empty tool_use_id is a no-op', () => {
    const before = evidenceFileCount();
    const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: fixtureRoot, tool_input: { command: './gradlew.bat :shared:testAndroidHostTest --console=plain' } });
    captureEvidenceForEvent(p, baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('a missing/non-string command is a no-op', () => {
    const before = evidenceFileCount();
    const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', cwd: fixtureRoot, tool_input: {} });
    captureEvidenceForEvent(p, baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('loadHookConfig returning null (e.g. missing env) makes the whole call a no-op', () => {
    const before = evidenceFileCount();
    const env = baseEnv(evidenceDir);
    delete env.KMP_EVAL_JUNIT_EVIDENCE_TASK;
    captureEvidenceForEvent(payload('PostToolUse', './gradlew.bat :shared:testAndroidHostTest --console=plain'), env);
    expect(evidenceFileCount()).toBe(before);
  });

  it('a Gradle command outside allowed_invocations is a no-op', () => {
    const before = evidenceFileCount();
    captureEvidenceForEvent(payload('PostToolUse', './gradlew.bat :shared:build --console=plain'), baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('a kmp-test parallel command is never captured here at all (this hook only ever tracks raw Gradle invocations)', () => {
    const before = evidenceFileCount();
    captureEvidenceForEvent(payload('PostToolUse', 'kmp-test parallel --module-filter shared --json'), baseEnv(evidenceDir));
    expect(evidenceFileCount()).toBe(before);
  });

  it('a cwd outside the expected fixture root is a no-op', () => {
    const before = evidenceFileCount();
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'aejeh-outside-'));
    try {
      const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', cwd: outsideDir, tool_input: { command: './gradlew.bat :shared:testAndroidHostTest --console=plain' } });
      captureEvidenceForEvent(p, baseEnv(evidenceDir));
      expect(evidenceFileCount()).toBe(before);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // isPlanOnly is checked BEFORE any file I/O (round-4 fix d) -- proven here by using a fixture
  // root that DOES have real, matching, readable XML on disk for the evidence task (a setup that
  // would otherwise succeed and write a clean {status:'ok',...} record): a --dry-run invocation
  // must still produce nothing at all. If isPlanOnly's check were ever reordered to AFTER the XML
  // read, this specific test would start failing (evidence would appear).
  it('a plan-only (--dry-run) Gradle invocation is a no-op even when real, matching JUnit XML exists on disk for the task (isPlanOnly gates before any XML read)', () => {
    const planOnlyRoot = mkdtempSync(path.join(os.tmpdir(), 'aejeh-planonly-'));
    try {
      writeXml(planOnlyRoot, 'shared', 'testAndroidHostTest', 'A', '<testsuite name="A" tests="1"><testcase name="a" classname="com.x.A"/></testsuite>');
      const planOnlyEvidenceDir = mkdtempSync(path.join(os.tmpdir(), 'aejeh-evidence-planonly-'));
      try {
        mkdirSync(path.join(planOnlyEvidenceDir, 'evidence'), { recursive: true });
        const env = baseEnv(planOnlyEvidenceDir, { KMP_EVAL_EXPECTED_FIXTURE_ROOT: planOnlyRoot });
        const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', cwd: planOnlyRoot, tool_input: { command: './gradlew.bat :shared:testAndroidHostTest --console=plain --dry-run' } });
        captureEvidenceForEvent(p, env);
        expect(readdirSync(path.join(planOnlyEvidenceDir, 'evidence'))).toEqual([]);
      } finally {
        rmSync(planOnlyEvidenceDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(planOnlyRoot, { recursive: true, force: true });
    }
  });
});

describe('captureEvidenceForEvent -- real capture, end to end', () => {
  it('a well-formed PostToolUse event for a relevant Gradle command writes a real, readable evidence record keyed by sha256(tool_use_id)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aejeh-capture-'));
    const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'aejeh-evidence-capture-'));
    try {
      mkdirSync(path.join(evidenceDir, 'evidence'), { recursive: true });
      mkdirSync(path.join(evidenceDir, 'anomalies'), { recursive: true });
      writeXml(root, 'shared', 'testAndroidHostTest', 'A', [
        '<testsuite name="A" tests="2">',
        '  <testcase name="a" classname="com.x.A" time="0.1"/>',
        '  <testcase name="b" classname="com.x.A" time="0.1"><failure type="x" message="m">s</failure></testcase>',
        '</testsuite>',
      ].join('\n'));
      const command = './gradlew.bat :shared:testAndroidHostTest --console=plain';
      const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_capture1', cwd: root, tool_input: { command } });
      captureEvidenceForEvent(p, baseEnv(evidenceDir, { KMP_EVAL_EXPECTED_FIXTURE_ROOT: root }));

      const record = readSidecarRecord(path.join(evidenceDir, 'evidence'), sha256Hex('toolu_capture1'));
      expect(record).toEqual({ command, status: 'ok', junit: { total: 2, passed: 1, failed: 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it('PostToolUseFailure is captured identically to PostToolUse -- this hook treats both the same way (documented, disclosed routing uncertainty)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aejeh-capture-'));
    const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'aejeh-evidence-capture-'));
    try {
      mkdirSync(path.join(evidenceDir, 'evidence'), { recursive: true });
      mkdirSync(path.join(evidenceDir, 'anomalies'), { recursive: true });
      writeXml(root, 'shared', 'testAndroidHostTest', 'A', '<testsuite name="A" tests="1"><testcase name="a" classname="com.x.A"/></testsuite>');
      const command = './gradlew.bat :shared:testAndroidHostTest --console=plain';
      const p = JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_capture2', cwd: root, tool_input: { command } });
      captureEvidenceForEvent(p, baseEnv(evidenceDir, { KMP_EVAL_EXPECTED_FIXTURE_ROOT: root }));

      const record = readSidecarRecord(path.join(evidenceDir, 'evidence'), sha256Hex('toolu_capture2'));
      expect(record).toEqual({ command, status: 'ok', junit: { total: 1, passed: 1, failed: 0 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it('a lifecycle-alias Gradle invocation (present in allowed_invocations, distinct from the literal evidence_task) is captured, reading XML from evidence_task\'s own directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aejeh-capture-'));
    const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'aejeh-evidence-capture-'));
    try {
      mkdirSync(path.join(evidenceDir, 'evidence'), { recursive: true });
      mkdirSync(path.join(evidenceDir, 'anomalies'), { recursive: true });
      writeXml(root, 'app', 'testDebugUnitTest', 'A', '<testsuite name="A" tests="1"><testcase name="a" classname="com.x.A"/></testsuite>');
      const aliasCommand = './gradlew.bat :app:test --console=plain';
      const env = baseEnv(evidenceDir, {
        KMP_EVAL_EXPECTED_FIXTURE_ROOT: root,
        KMP_EVAL_JUNIT_EVIDENCE_TASK: ':app:testDebugUnitTest',
        KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS: JSON.stringify([':app:testDebugUnitTest', ':app:test']),
      });
      const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_capture3', cwd: root, tool_input: { command: aliasCommand } });
      captureEvidenceForEvent(p, env);

      const record = readSidecarRecord(path.join(evidenceDir, 'evidence'), sha256Hex('toolu_capture3'));
      expect(record).toEqual({ command: aliasCommand, status: 'ok', junit: { total: 1, passed: 1, failed: 0 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it('an internal exception during capture (e.g. a corrupt/inaccessible evidence dir path) is swallowed silently -- never escapes to the caller', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aejeh-capture-'));
    try {
      writeXml(root, 'shared', 'testAndroidHostTest', 'A', '<testsuite name="A" tests="1"><testcase name="a" classname="com.x.A"/></testsuite>');
      const command = './gradlew.bat :shared:testAndroidHostTest --console=plain';
      const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_capture4', cwd: root, tool_input: { command } });
      // KMP_EVAL_JUNIT_EVIDENCE_DIR points at a file (not a directory) that DOES exist -- realpathSync
      // succeeds (so loadHookConfig returns a config), but the later mkdirSync/writeFileSync calls
      // inside promoteTargetsAtomically must fail against a non-directory path.
      const bogusEvidenceDirAsFile = path.join(root, 'not-a-directory.txt');
      writeFileSync(bogusEvidenceDirAsFile, 'x');
      expect(() => captureEvidenceForEvent(p, baseEnv(bogusEvidenceDirAsFile, { KMP_EVAL_EXPECTED_FIXTURE_ROOT: root }))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
