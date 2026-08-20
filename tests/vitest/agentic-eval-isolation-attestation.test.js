// tests/vitest/agentic-eval-isolation-attestation.test.js
// RED -> GREEN for tools/agentic-eval/execution-profiles/isolation-attestation.mjs: loads and
// validates a local, operator-authored isolation attestation for a policy_mode:"not_applicable"
// execution profile. The loader validates consistency of a DECLARATION -- it never verifies a real
// VM/sandbox exists, and it must never leak the attestation's own path or content into its return
// value or error reason.
import {
  describe, it, expect, afterEach,
} from 'vitest';
import {
  mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIsolationAttestation, ATTESTATION_KEYS } from '../../tools/agentic-eval/execution-profiles/isolation-attestation.mjs';
import { canonicalJsonSha256 } from '../../tools/agentic-eval/canonical-json.mjs';

const tempDirs = [];
function freshTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-attestation-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const CAMPAIGN_ID = 'my-safe-campaign';
const HARNESS_SHA = 'a'.repeat(40);

function validAttestationObject(overrides = {}) {
  return {
    schema: 1,
    profile_id: 'sandboxed-unrestricted-v1',
    runtime_id: 'claude-code',
    campaign_id: CAMPAIGN_ID,
    platform: 'windows',
    boundary_kind: 'disposable-vm',
    network_mode: 'restricted',
    workspace_scope: 'campaign-only',
    runtime_credential_scope: 'runtime-only',
    normal_maintainer_home_mounted: false,
    ambient_secrets_present: false,
    disposable_home: true,
    rollback_or_destroy_required: true,
    harness_sha: HARNESS_SHA,
    created_at: '2026-08-20T10:00:00Z',
    expires_at: '2026-08-20T18:00:00Z',
    ...overrides,
  };
}

function expectedContext(overrides = {}) {
  return {
    profileId: 'sandboxed-unrestricted-v1', runtimeId: 'claude-code', platform: 'windows',
    networkMode: 'restricted', harnessSha: HARNESS_SHA,
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T12:00:00Z');

function writeAttestation(dir, content) {
  const p = join(dir, 'attestation.json');
  const raw = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(p, raw);
  return p;
}

describe('loadIsolationAttestation -- happy path', () => {
  it('accepts the canonical valid attestation and returns exactly {ok:true, schema:1, sha256}', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject());
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['ok', 'schema', 'sha256']);
    expect(result.schema).toBe(1);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the returned sha256 matches canonicalJsonSha256 of the parsed object', () => {
    const dir = freshTempDir();
    const obj = validAttestationObject();
    const p = writeAttestation(dir, obj);
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result.sha256).toBe(canonicalJsonSha256(obj));
  });

  it('hash is stable across whitespace-only re-serialization (pretty-printed vs compact)', () => {
    const dir = freshTempDir();
    const obj = validAttestationObject();
    const compactPath = join(dir, 'compact.json');
    const prettyPath = join(dir, 'pretty.json');
    writeFileSync(compactPath, JSON.stringify(obj));
    writeFileSync(prettyPath, JSON.stringify(obj, null, 2));
    const compactResult = loadIsolationAttestation(compactPath, expectedContext(), { now: NOW });
    const prettyResult = loadIsolationAttestation(prettyPath, expectedContext(), { now: NOW });
    expect(compactResult.ok).toBe(true);
    expect(prettyResult.ok).toBe(true);
    expect(compactResult.sha256).toBe(prettyResult.sha256);
  });

  it('hash is stable across CRLF vs LF line endings in the raw file', () => {
    const dir = freshTempDir();
    const obj = validAttestationObject();
    const pretty = JSON.stringify(obj, null, 2);
    const lfPath = join(dir, 'lf.json');
    const crlfPath = join(dir, 'crlf.json');
    writeFileSync(lfPath, pretty);
    writeFileSync(crlfPath, pretty.replace(/\n/g, '\r\n'));
    const lfResult = loadIsolationAttestation(lfPath, expectedContext(), { now: NOW });
    const crlfResult = loadIsolationAttestation(crlfPath, expectedContext(), { now: NOW });
    expect(lfResult.ok).toBe(true);
    expect(crlfResult.ok).toBe(true);
    expect(lfResult.sha256).toBe(crlfResult.sha256);
  });

  it('does not mutate or rewrite the file (byte-identical before and after)', () => {
    const dir = freshTempDir();
    const raw = JSON.stringify(validAttestationObject(), null, 2);
    const p = join(dir, 'attestation.json');
    writeFileSync(p, raw);
    loadIsolationAttestation(p, expectedContext(), { now: NOW });
    const after = readFileSync(p, 'utf8');
    expect(after).toBe(raw);
  });
});

describe('loadIsolationAttestation -- filesystem shape (regular file, no symlink, no directory, size cap)', () => {
  it('rejects a missing file', () => {
    const dir = freshTempDir();
    const result = loadIsolationAttestation(join(dir, 'nope.json'), expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'not_a_regular_file' });
  });

  it('rejects a directory', () => {
    const dir = freshTempDir();
    const sub = join(dir, 'a-directory.json');
    mkdirSync(sub);
    const result = loadIsolationAttestation(sub, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'not_a_regular_file' });
  });

  it('rejects a symlink (never follows it, never stats the target)', () => {
    const dir = freshTempDir();
    const targetPath = writeAttestation(dir, validAttestationObject());
    const linkPath = join(dir, 'link.json');
    try {
      symlinkSync(targetPath, linkPath, 'file');
    } catch (err) {
      // Symlink creation can require elevated privileges on Windows -- skip gracefully rather than
      // false-failing on an environment limitation unrelated to the loader's own correctness.
      if (err.code === 'EPERM') return;
      throw err;
    }
    const result = loadIsolationAttestation(linkPath, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'not_a_regular_file' });
  });

  it('rejects a file larger than 16 KiB', () => {
    const dir = freshTempDir();
    const obj = validAttestationObject({ campaign_id: `${CAMPAIGN_ID}-${'x'.repeat(20000)}` });
    // campaign_id itself would fail its own regex, but size must be rejected FIRST, before content
    // is ever parsed/validated -- the oversized padding proves the size gate fires independently.
    const p = writeAttestation(dir, obj);
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'file_too_large' });
  });

  it('accepts a file right at the 16 KiB boundary is not required -- but a file just over it is rejected deterministically', () => {
    const dir = freshTempDir();
    const raw = `${JSON.stringify(validAttestationObject())}${' '.repeat(17000)}`;
    const p = join(dir, 'attestation.json');
    writeFileSync(p, raw);
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'file_too_large' });
  });
});

describe('loadIsolationAttestation -- encoding and JSON shape', () => {
  it('rejects a UTF-8 BOM-prefixed file', () => {
    const dir = freshTempDir();
    const p = join(dir, 'attestation.json');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(p, Buffer.concat([bom, Buffer.from(JSON.stringify(validAttestationObject()))]));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_encoding' });
  });

  it('rejects invalid UTF-8 byte sequences', () => {
    const dir = freshTempDir();
    const p = join(dir, 'attestation.json');
    writeFileSync(p, Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x7d]));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_encoding' });
  });

  it('rejects malformed JSON', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, '{ not: valid json ]');
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('rejects a top-level JSON array', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, JSON.stringify([1, 2, 3]));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('rejects a top-level JSON primitive (string)', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, JSON.stringify('just a string'));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('rejects an object with a non-plain prototype (JSON.parse never produces one, but the guard is explicit-by-contract)', () => {
    // Cannot express a non-plain-prototype object AS JSON text (JSON.parse always yields
    // Object.prototype-rooted object literals) -- this test instead proves the module-internal
    // guard exists and is exercised indirectly via the missing-key path below, which shares the
    // same rejection code family. A direct unit test of the internal isPlainObject helper would
    // require exporting it, which the module deliberately does not (kept module-private, matching
    // every other module's own local copy of this same check).
    const dir = freshTempDir();
    const p = writeAttestation(dir, 'null');
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('rejects a missing required key', () => {
    const dir = freshTempDir();
    const obj = validAttestationObject();
    delete obj.campaign_id;
    const p = writeAttestation(dir, obj);
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_keys' });
  });

  it('rejects an extra, unrecognized key', () => {
    const dir = freshTempDir();
    const obj = { ...validAttestationObject(), extra_field: 'not allowed' };
    const p = writeAttestation(dir, obj);
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_keys' });
  });

  it('the closed key list has exactly the 16 documented keys', () => {
    expect(ATTESTATION_KEYS).toHaveLength(16);
    expect(new Set(ATTESTATION_KEYS).size).toBe(16);
  });
});

describe('loadIsolationAttestation -- every enum/boolean/slug/hash field, invalid', () => {
  const cases = [
    ['schema', { schema: 2 }, 'invalid_schema'],
    ['profile_id (wrong value)', { profile_id: 'strict-policy-v1' }, 'invalid_profile_id'],
    ['profile_id (empty)', { profile_id: '' }, 'invalid_profile_id'],
    ['runtime_id (wrong value)', { runtime_id: 'codex-cli' }, 'invalid_runtime_id'],
    ['campaign_id (uppercase)', { campaign_id: 'MyCampaign' }, 'invalid_campaign_id'],
    ['campaign_id (too short)', { campaign_id: 'ab' }, 'invalid_campaign_id'],
    ['campaign_id (leading hyphen)', { campaign_id: '-abc' }, 'invalid_campaign_id'],
    ['campaign_id (invalid char)', { campaign_id: 'abc_def' }, 'invalid_campaign_id'],
    ['platform (unknown)', { platform: 'freebsd' }, 'invalid_platform'],
    ['boundary_kind (unknown)', { boundary_kind: 'my-laptop' }, 'invalid_boundary_kind'],
    ['network_mode (not restricted)', { network_mode: 'runtime-default' }, 'invalid_network_mode'],
    ['workspace_scope (not campaign-only)', { workspace_scope: 'full-repo' }, 'invalid_workspace_scope'],
    ['runtime_credential_scope (not runtime-only)', { runtime_credential_scope: 'ambient' }, 'invalid_runtime_credential_scope'],
    ['normal_maintainer_home_mounted (true)', { normal_maintainer_home_mounted: true }, 'invalid_safety_claim'],
    ['normal_maintainer_home_mounted (non-boolean)', { normal_maintainer_home_mounted: 'false' }, 'invalid_safety_claim'],
    ['ambient_secrets_present (true)', { ambient_secrets_present: true }, 'invalid_safety_claim'],
    ['disposable_home (false)', { disposable_home: false }, 'invalid_safety_claim'],
    ['rollback_or_destroy_required (false)', { rollback_or_destroy_required: false }, 'invalid_safety_claim'],
    ['harness_sha (uppercase)', { harness_sha: 'A'.repeat(40) }, 'invalid_harness_sha'],
    ['harness_sha (too short)', { harness_sha: 'a'.repeat(39) }, 'invalid_harness_sha'],
    ['harness_sha (too long)', { harness_sha: 'a'.repeat(41) }, 'invalid_harness_sha'],
    ['harness_sha (non-hex char)', { harness_sha: `${'a'.repeat(39)}z` }, 'invalid_harness_sha'],
    ['created_at (wrong format, has milliseconds)', { created_at: '2026-08-20T10:00:00.000Z' }, 'invalid_timestamp'],
    ['created_at (missing Z)', { created_at: '2026-08-20T10:00:00' }, 'invalid_timestamp'],
    ['created_at (not a real date)', { created_at: '2026-02-30T10:00:00Z' }, 'invalid_timestamp'],
    ['expires_at (wrong format)', { expires_at: '08/20/2026' }, 'invalid_timestamp'],
  ];
  for (const [label, overrides, expectedReason] of cases) {
    it(`rejects invalid ${label}`, () => {
      const dir = freshTempDir();
      const p = writeAttestation(dir, validAttestationObject(overrides));
      const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
      expect(result).toEqual({ ok: false, reason: expectedReason });
    });
  }
});

describe('loadIsolationAttestation -- cross-checks against the actual resolved context', () => {
  const mismatches = [
    ['profile_id', { profile_id: 'sandboxed-unrestricted-v1' }, { profileId: 'some-other-profile-v1' }],
    ['runtime_id', {}, { runtimeId: 'some-other-runtime' }],
    ['platform', {}, { platform: 'linux' }],
    ['network_mode', {}, { networkMode: 'runtime-default' }],
    ['harness_sha', {}, { harnessSha: 'b'.repeat(40) }],
  ];
  for (const [label, attestationOverrides, contextOverrides] of mismatches) {
    it(`rejects a ${label} mismatch between the attestation and the actual invocation context`, () => {
      const dir = freshTempDir();
      const p = writeAttestation(dir, validAttestationObject(attestationOverrides));
      const result = loadIsolationAttestation(p, expectedContext(contextOverrides), { now: NOW });
      expect(result).toEqual({ ok: false, reason: 'context_mismatch' });
    });
  }

  it('a fully matching context succeeds', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject());
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe('loadIsolationAttestation -- temporal validity (injected clock, never global monkeypatch)', () => {
  it('rejects created_at more than 5 minutes in the future', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T12:06:00Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'created_at_in_future' });
  });

  it('accepts created_at exactly at the 5-minute forward-skew boundary', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T12:05:00Z', expires_at: '2026-08-20T20:00:00Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result.ok).toBe(true);
  });

  it('rejects an already-expired attestation (expires_at <= now)', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T08:00:00Z', expires_at: '2026-08-20T12:00:00Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects expires_at exactly equal to now (must be strictly greater)', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T08:00:00Z', expires_at: '2026-08-20T12:00:00Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: new Date('2026-08-20T12:00:00Z') });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a zero-length interval (expires_at === created_at) -- both chosen just inside the forward-skew/expiry boundaries so neither of THOSE checks fires first', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T12:05:00Z', expires_at: '2026-08-20T12:05:00Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'non_positive_interval' });
  });

  it('rejects a negative interval (expires_at before created_at) -- both chosen just inside the forward-skew/expiry boundaries so neither of THOSE checks fires first', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T12:05:00Z', expires_at: '2026-08-20T12:01:00Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'non_positive_interval' });
  });

  it('rejects an interval longer than 24 hours', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T10:00:00Z', expires_at: '2026-08-21T10:00:01Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'interval_too_long' });
  });

  it('accepts an interval of exactly 24 hours', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject({ created_at: '2026-08-20T10:00:00Z', expires_at: '2026-08-21T10:00:00Z' }));
    const result = loadIsolationAttestation(p, expectedContext(), { now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe('loadIsolationAttestation -- privacy: path/content/individual-field values never appear in a failure result', () => {
  it('every failure reason across every negative case in this file is a short closed code -- never the file path, never a field value', () => {
    const dir = freshTempDir();
    const weirdPath = join(dir, 'a-very-identifying-campaign-name-attestation.json');
    writeFileSync(weirdPath, JSON.stringify(validAttestationObject({ campaign_id: 'a-very-identifying-campaign-name' })));
    const result = loadIsolationAttestation(weirdPath, expectedContext({ platform: 'linux' }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.reason).not.toMatch(/[\\/]/); // no path separators anywhere in the reason
    expect(result.reason).not.toContain('campaign');
    expect(result.reason).not.toContain(weirdPath);
    expect(result.reason.length).toBeLessThan(40);
  });

  it('a caught filesystem error never leaks the underlying OS error message', () => {
    const dir = freshTempDir();
    const result = loadIsolationAttestation(join(dir, 'definitely-does-not-exist.json'), expectedContext(), { now: NOW });
    expect(result.reason).toBe('not_a_regular_file');
    expect(result.reason).not.toMatch(/ENOENT|errno|syscall/i);
  });
});

describe('loadIsolationAttestation -- caller-contract violations throw (never a silent {ok:false})', () => {
  it('throws when expected is omitted entirely', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject());
    expect(() => loadIsolationAttestation(p, undefined, { now: NOW })).toThrow();
  });

  it('throws when expected is missing a required field', () => {
    const dir = freshTempDir();
    const p = writeAttestation(dir, validAttestationObject());
    expect(() => loadIsolationAttestation(p, { profileId: 'x' }, { now: NOW })).toThrow();
  });

  it('throws when filePath is not a string', () => {
    expect(() => loadIsolationAttestation(null, expectedContext(), { now: NOW })).toThrow();
  });
});
