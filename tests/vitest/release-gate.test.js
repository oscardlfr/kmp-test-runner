// tests/vitest/release-gate.test.js
// Unit tests for tools/release-gate.mjs pure exports.
// No network calls — all I/O uses fixtures or tmp files.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateTagFormat,
  parseRequiredChecks,
  verifyTagVersion,
  mergeCheckSources,
  pollChecksForSha,
} from '../../tools/release-gate.mjs';

// ---------------------------------------------------------------------------
// validateTagFormat

describe('validateTagFormat', () => {
  it('accepts v<major>.<minor>.<patch>', () => {
    expect(validateTagFormat('v1.2.3')).toBe(true);
    expect(validateTagFormat('v0.14.0')).toBe(true);
    expect(validateTagFormat('v0.0.1')).toBe(true);
    expect(validateTagFormat('v100.200.300')).toBe(true);
  });

  it('rejects tags without v prefix', () => {
    expect(validateTagFormat('1.2.3')).toBe(false);
    expect(validateTagFormat('0.14.0')).toBe(false);
  });

  it('rejects prerelease / build metadata', () => {
    expect(validateTagFormat('v1.2.3-beta')).toBe(false);
    expect(validateTagFormat('v1.2.3-rc.1')).toBe(false);
    expect(validateTagFormat('v1.2.3+build')).toBe(false);
  });

  it('rejects incomplete versions', () => {
    expect(validateTagFormat('v1.2')).toBe(false);
    expect(validateTagFormat('v1')).toBe(false);
  });

  it('rejects non-numeric segments', () => {
    expect(validateTagFormat('vx.y.z')).toBe(false);
    expect(validateTagFormat('v1.2.x')).toBe(false);
  });

  it('rejects empty string and non-strings', () => {
    expect(validateTagFormat('')).toBe(false);
    expect(validateTagFormat(null)).toBe(false);
    expect(validateTagFormat(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseRequiredChecks

describe('parseRequiredChecks', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'rg-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const write = (name, content) => {
    const p = join(tmpDir, name);
    writeFileSync(p, content, 'utf8');
    return p;
  };

  it('returns required_contexts array from valid manifest', () => {
    const p = write('m.json', JSON.stringify({ version: 1, required_contexts: ['build', 'test'] }));
    expect(parseRequiredChecks(p)).toEqual(['build', 'test']);
  });

  it('throws if file does not exist', () => {
    expect(() => parseRequiredChecks(join(tmpDir, 'no-such.json'))).toThrow(/Cannot read/);
  });

  it('throws on malformed JSON', () => {
    const p = write('bad.json', '{not-json}');
    expect(() => parseRequiredChecks(p)).toThrow(/not valid JSON/);
  });

  it('throws if required_contexts is missing', () => {
    const p = write('m.json', JSON.stringify({ version: 1 }));
    expect(() => parseRequiredChecks(p)).toThrow(/missing 'required_contexts'/);
  });

  it('throws if required_contexts is not an array', () => {
    const p = write('m.json', JSON.stringify({ version: 1, required_contexts: 'foo' }));
    expect(() => parseRequiredChecks(p)).toThrow(/missing 'required_contexts'/);
  });

  it('throws if required_contexts is empty', () => {
    const p = write('m.json', JSON.stringify({ version: 1, required_contexts: [] }));
    expect(() => parseRequiredChecks(p)).toThrow(/empty/);
  });

  it('throws if required_contexts contains non-strings', () => {
    const p = write('m.json', JSON.stringify({ version: 1, required_contexts: [42, 'ok'] }));
    expect(() => parseRequiredChecks(p)).toThrow(/only strings/);
  });
});

// ---------------------------------------------------------------------------
// verifyTagVersion

describe('verifyTagVersion', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'rg-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const writePkg = version => {
    const p = join(tmpDir, 'package.json');
    writeFileSync(p, JSON.stringify({ name: 'test', version }), 'utf8');
    return p;
  };

  it('returns ok=true when tag version matches package.json', () => {
    const p = writePkg('1.2.3');
    expect(verifyTagVersion('v1.2.3', p)).toEqual({ ok: true, tagVer: '1.2.3', pkgVer: '1.2.3' });
  });

  it('returns ok=false when versions differ', () => {
    const p = writePkg('1.2.3');
    expect(verifyTagVersion('v1.2.4', p)).toEqual({ ok: false, tagVer: '1.2.4', pkgVer: '1.2.3' });
  });

  it('handles tag without v prefix', () => {
    const p = writePkg('1.2.3');
    expect(verifyTagVersion('1.2.3', p)).toEqual({ ok: true, tagVer: '1.2.3', pkgVer: '1.2.3' });
  });

  it('throws if package.json is missing', () => {
    expect(() => verifyTagVersion('v1.0.0', join(tmpDir, 'no-package.json'))).toThrow(/Cannot read/);
  });
});

// ---------------------------------------------------------------------------
// mergeCheckSources

describe('mergeCheckSources', () => {
  const CTX = ['build (ubuntu-latest)', 'build (windows-latest)', 'secrets-scan'];

  const cr  = (name, conclusion) => ({ name, conclusion, status: conclusion ? 'completed' : 'in_progress' });
  const st  = (context, state)   => ({ context, state });

  it('all check-runs success → all ok', () => {
    const runs = CTX.map(c => cr(c, 'success'));
    const result = mergeCheckSources(runs, [], CTX);
    for (const ctx of CTX) expect(result[ctx].verdict).toBe('ok');
  });

  it('one failure check-run → refuse for that context', () => {
    const runs = [cr(CTX[0], 'failure'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const result = mergeCheckSources(runs, [], CTX);
    expect(result[CTX[0]].verdict).toBe('refuse');
    expect(result[CTX[1]].verdict).toBe('ok');
  });

  it('cancelled check-run → refuse', () => {
    const runs = [cr(CTX[0], 'cancelled'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    expect(mergeCheckSources(runs, [], CTX)[CTX[0]].verdict).toBe('refuse');
  });

  it('timed_out check-run → refuse', () => {
    const runs = [cr(CTX[0], 'timed_out'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    expect(mergeCheckSources(runs, [], CTX)[CTX[0]].verdict).toBe('refuse');
  });

  it('action_required check-run → refuse', () => {
    const runs = [cr(CTX[0], 'action_required'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    expect(mergeCheckSources(runs, [], CTX)[CTX[0]].verdict).toBe('refuse');
  });

  it('skipped check-run with NO matching commit status → refuse', () => {
    const runs = [cr(CTX[0], 'skipped'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    expect(mergeCheckSources(runs, [], CTX)[CTX[0]].verdict).toBe('refuse');
  });

  it('skipped check-run WITH commit status success → ok (sentinel bridge)', () => {
    const runs = [cr(CTX[0], 'skipped'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const stats = [st(CTX[0], 'success')];
    const result = mergeCheckSources(runs, stats, CTX);
    expect(result[CTX[0]].verdict).toBe('ok');
    expect(result[CTX[0]].source).toBe('status');
  });

  it('skipped check-run WITH commit status failure → refuse', () => {
    const runs = [cr(CTX[0], 'skipped'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const stats = [st(CTX[0], 'failure')];
    expect(mergeCheckSources(runs, stats, CTX)[CTX[0]].verdict).toBe('refuse');
  });

  it('context only in commit statuses (success) → ok', () => {
    const runs = [cr(CTX[1], 'success'), cr(CTX[2], 'success')]; // CTX[0] absent
    const stats = [st(CTX[0], 'success')];
    expect(mergeCheckSources(runs, stats, CTX)[CTX[0]].verdict).toBe('ok');
  });

  it('context only in commit statuses (failure) → refuse', () => {
    const runs = [cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const stats = [st(CTX[0], 'failure')];
    expect(mergeCheckSources(runs, stats, CTX)[CTX[0]].verdict).toBe('refuse');
  });

  it('context in neither source → missing', () => {
    const runs = [cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const result = mergeCheckSources(runs, [], CTX);
    expect(result[CTX[0]].verdict).toBe('missing');
  });

  it('in_progress check-run (null conclusion) with no status → wait', () => {
    const runs = [cr(CTX[0], null), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    expect(mergeCheckSources(runs, [], CTX)[CTX[0]].verdict).toBe('wait');
  });

  it('commit status pending with no check-run → wait', () => {
    const runs = [cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const stats = [st(CTX[0], 'pending')];
    expect(mergeCheckSources(runs, stats, CTX)[CTX[0]].verdict).toBe('wait');
  });

  it('real failure check-run overrides any commit status', () => {
    // Ensures failure always wins even if status says success
    const runs = [cr(CTX[0], 'failure'), cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const stats = [st(CTX[0], 'success')];
    expect(mergeCheckSources(runs, stats, CTX)[CTX[0]].verdict).toBe('refuse');
  });

  // Duplicate check-run deduplication — must pick LATEST by timestamp, not by conclusion rank

  it('duplicate runs: newer failure beats older success → refuse', () => {
    // Regression: conclusion-rank dedup (success > failure) would WRONGLY return ok here.
    const old = { name: CTX[0], conclusion: 'success',  status: 'completed',
                  started_at: '2024-01-01T00:00:00Z', completed_at: '2024-01-01T00:01:00Z' };
    const newer = { name: CTX[0], conclusion: 'failure', status: 'completed',
                    started_at: '2024-01-01T00:02:00Z', completed_at: '2024-01-01T00:03:00Z' };
    const runs = [old, newer, cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    expect(mergeCheckSources(runs, [], CTX)[CTX[0]].verdict).toBe('refuse');
  });

  it('duplicate runs: newer success beats older failure → ok', () => {
    const old = { name: CTX[0], conclusion: 'failure', status: 'completed',
                  started_at: '2024-01-01T00:00:00Z', completed_at: '2024-01-01T00:01:00Z' };
    const newer = { name: CTX[0], conclusion: 'success', status: 'completed',
                    started_at: '2024-01-01T00:02:00Z', completed_at: '2024-01-01T00:03:00Z' };
    const runs = [old, newer, cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    expect(mergeCheckSources(runs, [], CTX)[CTX[0]].verdict).toBe('ok');
  });

  it('duplicate runs: no timestamps, one success and one failure → fail closed (refuse)', () => {
    // When timestamps are unavailable and conclusions conflict, err on the side of caution.
    const a = { name: CTX[0], conclusion: 'success', status: 'completed' };
    const b = { name: CTX[0], conclusion: 'failure', status: 'completed' };
    const runs1 = [a, b, cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    const runs2 = [b, a, cr(CTX[1], 'success'), cr(CTX[2], 'success')];
    // Either order should refuse
    expect(mergeCheckSources(runs1, [], CTX)[CTX[0]].verdict).toBe('refuse');
    expect(mergeCheckSources(runs2, [], CTX)[CTX[0]].verdict).toBe('refuse');
  });
});

// ---------------------------------------------------------------------------
// pollChecksForSha

describe('pollChecksForSha', () => {
  let fetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const CTX = ['build (ubuntu-latest)', 'secrets-scan'];

  // Returns a fetch mock that yields check-run + status fixtures
  const mockFetch = (crConclusion, stState) => {
    return vi.fn().mockImplementation(url => {
      let body;
      if (url.includes('/check-runs')) {
        const runs = CTX.map((name, i) => ({
          name,
          conclusion: i === 0 ? crConclusion : 'success',
          status: (i === 0 && !crConclusion) ? 'in_progress' : 'completed',
        }));
        body = { total_count: runs.length, check_runs: runs };
      } else {
        const stats = stState ? [{ context: CTX[0], state: stState }] : [];
        body = stats;
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      });
    });
  };

  it('resolves ok when all checks succeed on first poll', async () => {
    fetchMock.mockImplementation(url => {
      const body = url.includes('/check-runs')
        ? { total_count: 2, check_runs: CTX.map(n => ({ name: n, conclusion: 'success', status: 'completed' })) }
        : [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    const p = pollChecksForSha({ sha: 'abc', contexts: CTX, repo: 'owner/repo', intervalMs: 100, timeoutMs: 5000 });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
  });

  it('returns ok=false immediately on failure conclusion (no wait)', async () => {
    fetchMock = mockFetch('failure', undefined);
    vi.stubGlobal('fetch', fetchMock);

    const p = pollChecksForSha({ sha: 'abc', contexts: CTX, repo: 'owner/repo', intervalMs: 30000, timeoutMs: 60000 });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    // Fetch was called once (failed immediately, no sleep)
    expect(fetchMock).toHaveBeenCalledTimes(2); // check-runs + statuses
  });

  it('waits for in-flight check then resolves ok when it succeeds', async () => {
    let call = 0;
    fetchMock.mockImplementation(url => {
      call++;
      let body;
      if (url.includes('/check-runs')) {
        // First two calls: in_progress; after that: success
        const conclusion = call <= 2 ? null : 'success';
        const status = call <= 2 ? 'in_progress' : 'completed';
        body = { total_count: 2, check_runs: CTX.map(n => ({ name: n, conclusion, status })) };
      } else {
        body = [];
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    const p = pollChecksForSha({ sha: 'abc', contexts: CTX, repo: 'owner/repo', intervalMs: 1000, timeoutMs: 60000 });
    // Advance past the sleep between polls
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with timedOut when checks never complete', async () => {
    fetchMock.mockImplementation(url => {
      const body = url.includes('/check-runs')
        ? { total_count: 2, check_runs: CTX.map(n => ({ name: n, conclusion: null, status: 'in_progress' })) }
        : [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    const p = pollChecksForSha({ sha: 'abc', contexts: CTX, repo: 'owner/repo', intervalMs: 1000, timeoutMs: 2000 });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('returns ok=false with missing list when context never appears', async () => {
    fetchMock.mockImplementation(url => {
      // Only returns secrets-scan, never build (ubuntu-latest)
      const body = url.includes('/check-runs')
        ? { total_count: 1, check_runs: [{ name: 'secrets-scan', conclusion: 'success', status: 'completed' }] }
        : [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    const p = pollChecksForSha({ sha: 'abc', contexts: CTX, repo: 'owner/repo', intervalMs: 1000, timeoutMs: 2000 });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('build (ubuntu-latest)');
  });

  it('resolves ok via sentinel: skipped check-run + success status', async () => {
    fetchMock.mockImplementation(url => {
      let body;
      if (url.includes('/check-runs')) {
        body = { total_count: 2, check_runs: CTX.map(n => ({ name: n, conclusion: 'skipped', status: 'completed' })) };
      } else {
        // sentinel posted success for all contexts
        body = CTX.map(ctx => ({ context: ctx, state: 'success' }));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    const p = pollChecksForSha({ sha: 'abc', contexts: CTX, repo: 'owner/repo', intervalMs: 100, timeoutMs: 5000 });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
  });
});
