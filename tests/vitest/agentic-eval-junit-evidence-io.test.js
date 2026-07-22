// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-junit-evidence-io.test.js -- direct unit coverage for
// tools/agentic-eval/junit-evidence-io.mjs: the shared sidecar-record read/write primitives used by
// BOTH policy-hook.mjs's decision recording and junit-evidence-hook.mjs's evidence capture.
//
// The collision tests below use a REAL pre-existing target file on disk (no vi.mock) --
// promoteTargetsAtomically's own existsSync pre-check (evidence-io.mjs:132) throws for real the
// moment a target already exists, so a genuine collision (and, for the round-5 fix below, a
// genuine SECOND collision on the tombstone write itself) can be constructed deterministically
// without simulating a real concurrent race.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sha256Hex, listSidecarIds, readSidecarRecord, writeSidecarRecord, hasAnomalyTombstone } from '../../tools/agentic-eval/junit-evidence-io.mjs';

let dir;
afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('sha256Hex', () => {
  it('is deterministic -- the same input always produces the same hash', () => {
    expect(sha256Hex('toolu_01ABC')).toBe(sha256Hex('toolu_01ABC'));
  });
  it('produces different hashes for different inputs', () => {
    expect(sha256Hex('toolu_01ABC')).not.toBe(sha256Hex('toolu_01DEF'));
  });
  it('coerces a non-string input to a string rather than throwing', () => {
    expect(() => sha256Hex(12345)).not.toThrow();
  });
});

describe('listSidecarIds', () => {
  it('returns [] for a directory that does not exist at all', () => {
    dir = path.join(tmpdir(), 'kmp-sidecar-io-never-created');
    expect(listSidecarIds(dir)).toEqual([]);
  });

  it('returns the id (filename minus .json) for every .json file present, ignoring non-.json files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    writeFileSync(path.join(dir, 'aaa.json'), '{}');
    writeFileSync(path.join(dir, 'bbb.json'), '{}');
    writeFileSync(path.join(dir, 'not-json.txt'), 'x');
    const ids = listSidecarIds(dir).sort();
    expect(ids).toEqual(['aaa', 'bbb']);
  });

  it('returns [] for an existing but empty directory', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    expect(listSidecarIds(dir)).toEqual([]);
  });
});

describe('readSidecarRecord', () => {
  it('returns null when the file does not exist', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    expect(readSidecarRecord(dir, 'missing')).toBeNull();
  });

  it('returns null (never throws) for malformed JSON', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    writeFileSync(path.join(dir, 'bad.json'), '{not valid json');
    expect(readSidecarRecord(dir, 'bad')).toBeNull();
  });

  it('returns the parsed object for a well-formed record', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ decision: 'allow', command: 'kmp-test --version' }));
    expect(readSidecarRecord(dir, 'ok')).toEqual({ decision: 'allow', command: 'kmp-test --version' });
  });
});

describe('writeSidecarRecord -- ordinary, non-colliding write', () => {
  it('writes a record that reads back identically via readSidecarRecord', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    const recordsDir = path.join(dir, 'decisions');
    const anomaliesDir = path.join(dir, 'anomalies');
    writeSidecarRecord(recordsDir, 'idhash1', { decision: 'allow', command: 'kmp-test --version' }, anomaliesDir, 'duplicate_decision_write');
    expect(readSidecarRecord(recordsDir, 'idhash1')).toEqual({ decision: 'allow', command: 'kmp-test --version' });
    expect(hasAnomalyTombstone(anomaliesDir, 'idhash1')).toBe(false);
  });

  it('never throws, even if the target/anomalies directories do not exist yet (creates them)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    const recordsDir = path.join(dir, 'nested', 'decisions');
    const anomaliesDir = path.join(dir, 'nested', 'anomalies');
    expect(() => writeSidecarRecord(recordsDir, 'idhash1', { decision: 'allow', command: 'x' }, anomaliesDir, 'r')).not.toThrow();
    expect(readSidecarRecord(recordsDir, 'idhash1')).toEqual({ decision: 'allow', command: 'x' });
  });
});

describe('writeSidecarRecord -- collision on the main target (a real pre-existing file, not simulated)', () => {
  it('removes the pre-existing, now-ambiguous target (never leaves it looking falsely valid) and writes an anomalies/ tombstone', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    const recordsDir = path.join(dir, 'evidence');
    const anomaliesDir = path.join(dir, 'anomalies');
    mkdirSync(recordsDir, { recursive: true });
    // A genuine pre-existing target -- simulates "another PostToolUse/PostToolUseFailure firing
    // for the same tool_use_id already won the race."
    writeFileSync(path.join(recordsDir, 'idhash1.json'), JSON.stringify({ command: 'FIRST-WRITER', status: 'ok', junit: { total: 1, passed: 1, failed: 0 } }));

    writeSidecarRecord(recordsDir, 'idhash1', { command: 'SECOND-WRITER', status: 'ok', junit: { total: 2, passed: 2, failed: 0 } }, anomaliesDir, 'duplicate_evidence_write');

    // The worst case is bare absence (correctly, unconditionally flagged by every downstream
    // reader) -- NEVER an arbitrary one of the two racing writers' records sitting there looking
    // perfectly valid.
    expect(readSidecarRecord(recordsDir, 'idhash1')).toBeNull();
    expect(hasAnomalyTombstone(anomaliesDir, 'idhash1')).toBe(true);
    expect(readSidecarRecord(anomaliesDir, 'idhash1')).toEqual({ reason: 'duplicate_evidence_write' });
  });

  // Round-5 required proof: even when the tombstone write ITSELF also fails (forced here by a
  // real, second pre-existing file at the tombstone's own target path), the removal of the main,
  // now-ambiguous target must still have happened -- the tombstone is diagnostic-only, never the
  // PRIMARY safety mechanism.
  it('EXACT REPRODUCTION (round-5 fail-closed fix): collision on the main target AND the tombstone write ALSO fails -- the main target is still removed (bare absence), never left falsely valid', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    const recordsDir = path.join(dir, 'evidence');
    const anomaliesDir = path.join(dir, 'anomalies');
    mkdirSync(recordsDir, { recursive: true });
    mkdirSync(anomaliesDir, { recursive: true });
    writeFileSync(path.join(recordsDir, 'idhash1.json'), JSON.stringify({ command: 'FIRST-WRITER', status: 'ok', junit: { total: 1, passed: 1, failed: 0 } }));
    // Pre-seed the tombstone's OWN target too, with a distinctive marker -- forces
    // promoteTargetsAtomically's existsSync pre-check to ALSO throw for the anomalies write,
    // exercising the writeSidecarRecord's outer try/catch around that second call.
    writeFileSync(path.join(anomaliesDir, 'idhash1.json'), JSON.stringify({ reason: 'PRE-EXISTING-UNRELATED-MARKER' }));

    expect(() => writeSidecarRecord(recordsDir, 'idhash1', { command: 'SECOND-WRITER', status: 'ok', junit: { total: 2, passed: 2, failed: 0 } }, anomaliesDir, 'duplicate_evidence_write'))
      .not.toThrow();

    // The PRIMARY guarantee: main target removed regardless of the tombstone outcome.
    expect(readSidecarRecord(recordsDir, 'idhash1')).toBeNull();
    // The tombstone's own pre-existing (unrelated) content is untouched -- proves the second
    // promoteTargetsAtomically call really did fail closed (existsSync pre-check) rather than
    // silently overwriting it.
    expect(readFileSync(path.join(anomaliesDir, 'idhash1.json'), 'utf8')).toBe(JSON.stringify({ reason: 'PRE-EXISTING-UNRELATED-MARKER' }));
  });

  it('a collision on one id never affects a DIFFERENT id\'s independent write in the same directory', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    const recordsDir = path.join(dir, 'evidence');
    const anomaliesDir = path.join(dir, 'anomalies');
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(path.join(recordsDir, 'idhash1.json'), JSON.stringify({ command: 'FIRST-WRITER', status: 'ok', junit: { total: 1, passed: 1, failed: 0 } }));

    writeSidecarRecord(recordsDir, 'idhash1', { command: 'SECOND-WRITER', status: 'ok', junit: { total: 2, passed: 2, failed: 0 } }, anomaliesDir, 'duplicate_evidence_write');
    writeSidecarRecord(recordsDir, 'idhash2', { command: 'UNRELATED', status: 'ok', junit: { total: 3, passed: 3, failed: 0 } }, anomaliesDir, 'duplicate_evidence_write');

    expect(readSidecarRecord(recordsDir, 'idhash1')).toBeNull();
    expect(readSidecarRecord(recordsDir, 'idhash2')).toEqual({ command: 'UNRELATED', status: 'ok', junit: { total: 3, passed: 3, failed: 0 } });
    expect(hasAnomalyTombstone(anomaliesDir, 'idhash2')).toBe(false);
  });
});

describe('hasAnomalyTombstone', () => {
  it('is false when the anomalies directory does not exist at all', () => {
    dir = path.join(tmpdir(), 'kmp-sidecar-io-never-created');
    expect(hasAnomalyTombstone(dir, 'anything')).toBe(false);
  });
  it('is true only for an id with an actual tombstone file present', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-sidecar-io-'));
    writeFileSync(path.join(dir, 'present.json'), '{}');
    expect(hasAnomalyTombstone(dir, 'present')).toBe(true);
    expect(hasAnomalyTombstone(dir, 'absent')).toBe(false);
  });
});
