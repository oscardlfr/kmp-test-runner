// tests/vitest/agentic-eval-validate-command.test.js
// Unit tests for tools/agentic-eval/cli.mjs's `validate --run` command (cmdValidate), extended by
// the accepted-run-observability PR to also verify a schema-v5 scenario record's own accepted-run-
// audit sidecar offline: existence, parse, strict schema + record coherence, and an exact SHA-256
// match -- all resolved relative to the run record's OWN directory, never following a symlink
// outside it. Schemas 1-4 (and a schema-5 non-scenario record) keep the exact pre-existing
// record-only behavior; no dedicated test file existed for cmdValidate before this PR (the only
// prior coverage was indirect, via argv-shape tests in agentic-eval-cli.test.js), so this file also
// closes that gap for the record-only path.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { cmdValidate, validateRunRecordFile } from '../../tools/agentic-eval/cli.mjs';
import { ACCEPTED_AUDIT_SIDECAR_SCHEMA } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';

const VALID_SCOPE_ID = '11111111-2222-4333-8444-555555555555';

function baseCalibrationRecordV1() {
  return {
    schema: 1, run_id: 'calibration-no-skill-abcd1234', run_kind: 'calibration', benchmark_eligible: false,
    scenario_id: 'calibration-explicit-invocation', query_id: null, condition: 'no-skill', skill_source_sha: null,
    kmp_test_cli_version: '0.14.0', kmp_test_cli_source_sha: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    resolved_kmp_test_executable_path: 'tools/agentic-eval/fixtures/calibration-project',
    model_requested: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', session_id_observed: 'sess-0001',
    claude_code_version: '1.2.3-fake', repo_commit: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    project_alias: 'calibration-project', project_commit: null, project_url: null, platform: 'windows',
    family: 'trigger-only', cache_state: 'unknown', daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow', seed: null, order_index: null,
    started_at: '2026-07-18T00:00:00.000Z', ended_at: '2026-07-18T00:00:01.000Z', wall_clock_ms: 1000,
    skill_available: { value: false, reason: null }, skill_invocation_attempted: { value: false, reason: null },
    skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    success: { value: null, reason: 'calibration run -- success grading not applicable' },
    expected_outcome_matched: { value: null, reason: 'calibration run -- no scenario grader applies' },
    first_useful_signal_ms: { value: null, reason: 'calibration run -- no signal predicate applies' },
    first_useful_signal_event: null,
    tokens: { input: { value: 2, reason: null }, output: { value: 4, reason: null }, cache_read: { value: 0, reason: null }, cache_creation: { value: 0, reason: null } },
    tool_calls_total: { value: 1, reason: null }, shell_commands_total: { value: 1, reason: null },
    test_invocations_total: { value: null, reason: 'not tracked for calibration runs' }, retries: { value: 0, reason: null },
    output_bytes: { value: 100, reason: null }, stream_json_bytes: { value: 1000, reason: null }, human_interventions: { value: 0, reason: null },
    terminated: false, termination_reason: null, exit_code: 0, permission_mode_used: 'dontAsk',
    policy_allowed_gradle_tasks: ['build'], policy_allowed_kmptest_subcommands: ['doctor'],
    policy_sha256: 'a'.repeat(64), hook_call_count: 1, hook_deny_count: 0, privacy_status: 'redacted-private',
    raw_capture_committed: false, raw_capture_location: 'tools/runs/agentic-eval-calibration/raw/', notes: '', errors: [],
  };
}

function v5Base(overrides = {}) {
  return {
    ...baseCalibrationRecordV1(),
    schema: 5,
    // 0, not baseCalibrationRecordV1's 1 -- matches validSidecarFor's own default empty
    // tool_calls[]/summary, so a sidecar built from an UNMODIFIED v5Base()/scenarioV5Base() record
    // cross-validates cleanly by construction (no hand-fixture mismatch to accidentally introduce).
    tool_calls_total: { value: 0, reason: null },
    shell_commands_total: { value: 0, reason: null },
    grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
    repetition_index: null,
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ambient_skill_profile: { count: 0, scope_id: VALID_SCOPE_ID, fingerprint_hmac: '0'.repeat(64) },
    post_signal_ms: { value: null, reason: 'calibration run -- no first-useful-signal predicate applies' },
    post_signal_tool_calls: { value: null, reason: 'calibration run -- no first-useful-signal predicate applies' },
    policy_denials_before_first_signal: { value: null, reason: 'calibration run -- no first-useful-signal predicate applies' },
    policy_denials_after_first_signal: { value: null, reason: 'calibration run -- no first-useful-signal predicate applies' },
    accepted_audit: null,
    ...overrides,
  };
}

function scenarioV5Base(overrides = {}) {
  return v5Base({
    run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery',
    grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), reason: null },
    repetition_index: 0,
    run_id: 'scenario-current-skill-abcd1234',
    ...overrides,
  });
}

function validSidecarFor(record, overrides = {}) {
  return {
    schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA, run_id: record.run_id, run_schema: 5, run_kind: 'scenario',
    condition: record.condition, scenario_id: record.scenario_id,
    first_useful_signal_event: null, terminal_authoritative_event: null, tool_calls: [],
    summary: {
      tool_calls_total: 0, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null,
      policy_denials_total: 0, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null,
      policy_decisions_missing: 0,
    },
    ...overrides,
  };
}

/** Writes record.json + audit/<run_id>.json into `dir`, computing a REAL sha256 binding (or a
 * deliberately WRONG one, via `tamperSha256AfterWrite`) -- returns the record path. */
function writeRunAndSidecar(dir, record, sidecarOverrides = {}, { tamperSha256AfterWrite = false, sidecarText: sidecarTextOverride } = {}) {
  const sidecar = validSidecarFor(record, sidecarOverrides);
  const sidecarText = sidecarTextOverride ?? JSON.stringify(sidecar, null, 2);
  const sha256 = createHash('sha256').update(sidecarText, 'utf8').digest('hex');
  record.accepted_audit = { schema: 1, relative_path: `audit/${record.run_id}.json`, sha256: tamperSha256AfterWrite ? 'f'.repeat(64) : sha256 };
  const runPath = path.join(dir, `${record.run_id}.json`);
  writeFileSync(runPath, JSON.stringify(record, null, 2));
  const auditDir = path.join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, `${record.run_id}.json`), sidecarText);
  return runPath;
}

describe('cmdValidate / validateRunRecordFile -- schemas 1-4 (unchanged, record-only behavior)', () => {
  it('schema:1 calibration record validates cleanly with no sidecar concept at all', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v1-'));
    try {
      const runPath = path.join(dir, 'record.json');
      writeFileSync(runPath, JSON.stringify(baseCalibrationRecordV1(), null, 2));
      const { errors } = validateRunRecordFile(runPath);
      expect(errors).toEqual([]);
      expect(cmdValidate({ run: runPath })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a schema:4 record (pre-v5) validates cleanly, never attempting sidecar resolution', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v4-'));
    try {
      const record = {
        ...baseCalibrationRecordV1(), schema: 4,
        grading_checks: { value: null, reason: 'not applicable for run_kind calibration' }, repetition_index: null,
        foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
        ambient_skill_profile: { count: 0, scope_id: VALID_SCOPE_ID, fingerprint_hmac: '0'.repeat(64) },
      };
      const runPath = path.join(dir, 'record.json');
      writeFileSync(runPath, JSON.stringify(record, null, 2));
      expect(validateRunRecordFile(runPath).errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid record (missing fields) still reports errors and a nonzero exit, exactly as before', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-invalid-'));
    try {
      const runPath = path.join(dir, 'record.json');
      writeFileSync(runPath, JSON.stringify({ schema: 1 }, null, 2));
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.length).toBeGreaterThan(0);
      expect(cmdValidate({ run: runPath })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cmdValidate / validateRunRecordFile -- schema:5 non-scenario (record-only, same as pre-v5)', () => {
  it('validates the record only -- no sidecar resolution attempted for a non-scenario record', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-nonscenario-'));
    try {
      const runPath = path.join(dir, 'record.json');
      writeFileSync(runPath, JSON.stringify(v5Base(), null, 2));
      expect(validateRunRecordFile(runPath).errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cmdValidate / validateRunRecordFile -- schema:5 scenario (full sidecar verification)', () => {
  it('a genuinely well-formed record + matching sidecar validates cleanly end-to-end', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-happy-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record);
      const { errors } = validateRunRecordFile(runPath);
      expect(errors).toEqual([]);
      expect(cmdValidate({ run: runPath })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sidecar file is missing entirely', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-missing-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record);
      rmSync(path.join(dir, 'audit', `${record.run_id}.json`));
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.length).toBeGreaterThan(0);
      expect(cmdValidate({ run: runPath })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sidecar file is not valid JSON', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-invalidjson-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record);
      writeFileSync(path.join(dir, 'audit', `${record.run_id}.json`), 'not valid json {{{');
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sidecar was TAMPERED (its bytes changed after the digest was computed)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-tampered-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record);
      const sidecarPath = path.join(dir, 'audit', `${record.run_id}.json`);
      // record.condition defaults to 'no-skill' (baseCalibrationRecordV1) -- tampering to
      // 'current-skill' is a GENUINE byte change, unlike reassigning the value it already had.
      const tampered = { ...JSON.parse(readFileSync(sidecarPath, 'utf8')), condition: 'current-skill' };
      writeFileSync(sidecarPath, JSON.stringify(tampered, null, 2));
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field.includes('sha256'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when accepted_audit.sha256 is simply wrong (does not match the real file bytes)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-wrongdigest-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record, {}, { tamperSha256AfterWrite: true });
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field.includes('sha256'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sidecar\'s own run_id disagrees with the record\'s run_id', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-wrongrunid-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record, { run_id: 'scenario-current-skill-DIFFERENT' });
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field.includes('run_id'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sidecar\'s own condition disagrees with the record\'s condition', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-wrongcondition-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record, { condition: 'current-skill' }); // record says no-skill
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field.includes('condition'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sidecar\'s own scenario_id disagrees with the record\'s scenario_id', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-wrongscenario-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record, { scenario_id: 'kampkit-no-applicable-tests' });
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field.includes('scenario_id'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the sidecar itself is schema-malformed (e.g. an unrecognized top-level key)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-malformedsidecar-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record, { extra: 'nope' });
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review finding 5 -- a sidecar file that PARSES as valid JSON but whose root is null, a
  // scalar, or an array is rejected by validateAcceptedRunAuditSidecar's own shape check, but
  // (before this fix) crossValidateAcceptedRunAuditAgainstRecord was still unconditionally called
  // afterward and dereferenced sidecar.run_id, throwing a TypeError for the null case instead of
  // returning the structured {errors, warnings} shape this command's own contract promises.
  describe('never throws for valid JSON with a non-object sidecar root', () => {
    it.each([
      ['null', 'null'],
      ['a bare number', '42'],
      ['a bare string', '"just a string"'],
      ['an empty array', '[]'],
      ['a non-empty array', '[1,2,3]'],
    ])('sidecar text %s does not throw, and reports structured errors', (_label, sidecarText) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-nonobject-'));
      try {
        const record = scenarioV5Base();
        const runPath = writeRunAndSidecar(dir, record, {}, { sidecarText });
        expect(() => validateRunRecordFile(runPath)).not.toThrow();
        const { errors } = validateRunRecordFile(runPath);
        expect(errors.length).toBeGreaterThan(0);
        for (const e of errors) {
          expect(typeof e.field).toBe('string');
          expect(typeof e.message).toBe('string');
        }
        expect(() => cmdValidate({ run: runPath })).not.toThrow();
        expect(cmdValidate({ run: runPath })).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Traversal/absolute-path/backslash-path protection: these are caught one layer UP, by
  // validateRun's own accepted_audit.relative_path regex (schemas.mjs) -- since a record file can
  // be hand-edited/tampered independently of any sidecar, this proves cmdValidate's own record
  // validation step (which always runs FIRST) genuinely blocks these before any sidecar resolution
  // is even attempted.
  it('a tampered relative_path (traversal) fails at the record-validation step, before any sidecar I/O', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-traversal-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record);
      const tamperedRecord = { ...JSON.parse(readFileSync(runPath, 'utf8')) };
      tamperedRecord.accepted_audit = { ...tamperedRecord.accepted_audit, relative_path: '../../../etc/passwd' };
      writeFileSync(runPath, JSON.stringify(tamperedRecord, null, 2));
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered relative_path (absolute path) fails at the record-validation step', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-absolute-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record);
      const tamperedRecord = { ...JSON.parse(readFileSync(runPath, 'utf8')) };
      tamperedRecord.accepted_audit = { ...tamperedRecord.accepted_audit, relative_path: '/etc/passwd' };
      writeFileSync(runPath, JSON.stringify(tamperedRecord, null, 2));
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered relative_path (backslash) fails at the record-validation step', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-backslash-'));
    try {
      const record = scenarioV5Base();
      const runPath = writeRunAndSidecar(dir, record);
      const tamperedRecord = { ...JSON.parse(readFileSync(runPath, 'utf8')) };
      tamperedRecord.accepted_audit = { ...tamperedRecord.accepted_audit, relative_path: 'audit\\scenario-current-skill-abcd1234.json' };
      writeFileSync(runPath, JSON.stringify(tamperedRecord, null, 2));
      const { errors } = validateRunRecordFile(runPath);
      expect(errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Symlink escape -- a REAL symlink whose target resolves OUTSIDE the run record's own directory.
  // Gated to non-Windows, matching this repo's established convention for real-symlink integration
  // tests (see agentic-eval-measurement-scope.test.js's identical `process.platform !== 'win32'`
  // gate) -- creating a symlink on Windows requires elevated privileges/Developer Mode, unreliable
  // in CI; POSIX runners (ubuntu-latest/macos-latest) give this real, unmocked coverage.
  if (process.platform !== 'win32') {
    it('rejects a REAL symlink at the sidecar path whose target resolves outside the run directory (POSIX integration)', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-symlink-'));
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'aevc-v5-symlink-outside-'));
      try {
        const record = scenarioV5Base();
        const runPath = writeRunAndSidecar(dir, record);
        // Replace the legitimate sidecar file with a symlink pointing OUTSIDE dir entirely.
        const outsideTarget = path.join(outsideDir, 'escaped.json');
        writeFileSync(outsideTarget, JSON.stringify(validSidecarFor(record), null, 2));
        const sidecarPath = path.join(dir, 'audit', `${record.run_id}.json`);
        rmSync(sidecarPath);
        symlinkSync(outsideTarget, sidecarPath);
        const { errors } = validateRunRecordFile(runPath);
        expect(errors.some((e) => e.field === 'accepted_audit')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  }
});

// A second review round found validateRunRecordFile's own top-level readFileSync+JSON.parse was
// itself unguarded -- a malformed *run* file (not a malformed sidecar, which was already handled)
// threw a raw SyntaxError instead of returning the structured {errors,warnings} shape this
// function's own contract promises, propagating uncaught through cmdValidate (and, separately,
// through cmdAggregate -- see agentic-eval-cli.test.js).
describe('validateRunRecordFile / cmdValidate -- malformed top-level run file (fails closed, never throws)', () => {
  it('validateRunRecordFile never throws for malformed top-level JSON; record is null, errors non-empty', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-malformed-run-'));
    try {
      const runPath = path.join(dir, 'bad.json');
      writeFileSync(runPath, 'not valid json {{{');
      let result;
      expect(() => { result = validateRunRecordFile(runPath); }).not.toThrow();
      expect(result.record).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validateRunRecordFile\'s error message never leaks the absolute path or the file\'s own content', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-malformed-run-leak-'));
    try {
      const runPath = path.join(dir, 'bad.json');
      const secretLookingContent = 'not valid json {{{ sk-ant-totally-not-a-real-secret-marker';
      writeFileSync(runPath, secretLookingContent);
      const { errors } = validateRunRecordFile(runPath);
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(runPath);
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain('sk-ant-totally-not-a-real-secret-marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cmdValidate returns structured errors and exit 1 for malformed JSON, never throws', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aevc-malformed-run-cmd-'));
    try {
      const runPath = path.join(dir, 'bad.json');
      writeFileSync(runPath, 'not valid json {{{');
      let exitCode;
      expect(() => { exitCode = cmdValidate({ run: runPath }); }).not.toThrow();
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
