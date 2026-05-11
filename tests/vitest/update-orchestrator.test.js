// SPDX-License-Identifier: MIT
// Tests for lib/update-orchestrator.js — v0.9 step 3 DX-parity bundle.
//
// `kmp-test update` re-runs the install script for the latest GitHub release.
// Idempotent: no-op when already on latest. Test surface:
//   1. compareVersions semver-ish ordering
//   2. probeLatestVersion uses redirect URL primary, API fallback
//   3. --check returns check-only envelope, never spawns install
//   4. current === latest && !--force → no-op
//   5. current < latest → spawns install with --version <latest>
//   6. --force flag re-installs even when on latest
//   7. Failed probe → release_resolve_failed
//   8. Win32 spawns install.ps1 with -Version; non-win32 spawns install.sh with --version

import { describe, it, expect } from 'vitest';

import {
  runUpdate,
  formatUpdateText,
  parseArgs,
  compareVersions,
  probeLatestVersion,
  buildInstallSpawn,
  REPO,
} from '../../lib/orchestrators/update-orchestrator.js';

// Build a stub fetch returning canned responses. `redirect` controls the
// redirect-URL probe; `api` controls the API fallback. Each tier may be
// configured to error (Promise rejection), succeed, or return a non-OK
// response.
function makeFetchStub({ redirect, api } = {}) {
  return async (url) => {
    if (url.startsWith('https://github.com/')) {
      if (redirect === 'error') throw new Error('redirect probe error');
      if (redirect === 'no-tag') return { ok: true, url: 'https://github.com/foo/bar' };
      if (typeof redirect === 'string') {
        return { ok: true, url: `https://github.com/${REPO}/releases/tag/v${redirect}` };
      }
      throw new Error('redirect probe error');
    }
    if (url.startsWith('https://api.github.com/')) {
      if (api === 'error') throw new Error('api probe error');
      if (api === 'not-ok') return { ok: false };
      if (typeof api === 'object' && api !== null) {
        return {
          ok: true,
          json: async () => api,
        };
      }
      throw new Error('api probe error');
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
}

function makeSpawnStub({ status = 0 } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd, stdio: opts?.stdio });
    return { status, stdout: '', stderr: '', signal: null, error: null };
  };
  fn.calls = calls;
  return fn;
}

describe('compareVersions', () => {
  it('0.8.1 > 0.8.0', () => {
    expect(compareVersions('0.8.1', '0.8.0')).toBe(1);
  });
  it('0.8.0 < 0.9.0', () => {
    expect(compareVersions('0.8.0', '0.9.0')).toBe(-1);
  });
  it('1.0.0 = 1.0.0', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
  it('0.8 < 0.8.1 (zero-padding)', () => {
    expect(compareVersions('0.8', '0.8.1')).toBe(-1);
  });
});

describe('probeLatestVersion', () => {
  it('redirect tier returns tag from /releases/tag/<tag>', async () => {
    const probe = await probeLatestVersion({
      fetchImpl: makeFetchStub({ redirect: '0.9.0' }),
    });
    expect(probe).toEqual({ tag: '0.9.0', source: 'redirect' });
  });

  it('redirect failure falls through to API', async () => {
    const probe = await probeLatestVersion({
      fetchImpl: makeFetchStub({ redirect: 'error', api: { tag_name: 'v0.9.0', prerelease: false } }),
    });
    expect(probe).toEqual({ tag: '0.9.0', source: 'api' });
  });

  it('both probes fail → null', async () => {
    const probe = await probeLatestVersion({
      fetchImpl: makeFetchStub({ redirect: 'error', api: 'error' }),
    });
    expect(probe).toBeNull();
  });

  it('API prerelease tag rejected by default', async () => {
    const probe = await probeLatestVersion({
      fetchImpl: makeFetchStub({ redirect: 'error', api: { tag_name: 'v1.0.0-rc1', prerelease: true } }),
    });
    expect(probe).toBeNull();
  });

  it('--prerelease accepts pre-release tags', async () => {
    const probe = await probeLatestVersion({
      fetchImpl: makeFetchStub({ redirect: 'error', api: { tag_name: 'v1.0.0-rc1', prerelease: true } }),
      prerelease: true,
    });
    expect(probe).toEqual({ tag: '1.0.0-rc1', source: 'api' });
  });
});

describe('runUpdate --check', () => {
  it('current === latest → check-only, up_to_date:true, never spawns', async () => {
    const spawn = makeSpawnStub();
    const fetchImpl = makeFetchStub({ redirect: '0.8.1' });   // matches package.json
    const { envelope, exitCode } = await runUpdate({
      args: ['--check'],
      spawn, fetchImpl,
    });
    expect(envelope.update.action).toBe('check-only');
    expect(envelope.update.up_to_date).toBe(true);
    expect(spawn.calls).toHaveLength(0);
    expect(exitCode).toBe(0);
  });

  it('current < latest → check-only, up_to_date:false, never spawns', async () => {
    const spawn = makeSpawnStub();
    const fetchImpl = makeFetchStub({ redirect: '99.99.99' });
    const { envelope, exitCode } = await runUpdate({
      args: ['--check'],
      spawn, fetchImpl,
    });
    expect(envelope.update.action).toBe('check-only');
    expect(envelope.update.up_to_date).toBe(false);
    expect(envelope.update.latest_version).toBe('99.99.99');
    expect(spawn.calls).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});

describe('runUpdate no-op path', () => {
  it('current === latest && no --force → action:"no-op", exit 0', async () => {
    const spawn = makeSpawnStub();
    const fetchImpl = makeFetchStub({ redirect: '0.8.1' });
    const { envelope, exitCode } = await runUpdate({
      args: [],
      spawn, fetchImpl,
    });
    expect(envelope.update.action).toBe('no-op');
    expect(envelope.update.reason).toMatch(/already/i);
    expect(spawn.calls).toHaveLength(0);
    expect(exitCode).toBe(0);
  });

  it('--force re-installs even when current === latest', async () => {
    const spawn = makeSpawnStub();
    const fetchImpl = makeFetchStub({ redirect: '0.8.1' });
    const { envelope, exitCode } = await runUpdate({
      args: ['--force'],
      spawn, fetchImpl,
    });
    expect(envelope.update.action).toBe('installed');
    expect(spawn.calls).toHaveLength(1);
    expect(exitCode).toBe(0);
  });
});

describe('runUpdate install path', () => {
  it('current < latest → spawns install with --version (sh) or -Version (ps1)', async () => {
    const spawn = makeSpawnStub();
    const fetchImpl = makeFetchStub({ redirect: '99.99.99' });
    const { envelope, exitCode } = await runUpdate({
      args: [],
      spawn, fetchImpl,
    });
    expect(envelope.update.action).toBe('installed');
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    if (process.platform === 'win32') {
      expect(call.cmd).toMatch(/pwsh|powershell/i);
      expect(call.args).toContain('-Version');
      expect(call.args).toContain('99.99.99');
    } else {
      expect(call.cmd).toBe('bash');
      expect(call.args).toContain('--version');
      expect(call.args).toContain('99.99.99');
    }
    expect(exitCode).toBe(0);
  });

  it('install script failure → action:"install-failed", exit 3', async () => {
    const spawn = makeSpawnStub({ status: 7 });
    const fetchImpl = makeFetchStub({ redirect: '99.99.99' });
    const { envelope, exitCode } = await runUpdate({
      args: [],
      spawn, fetchImpl,
    });
    expect(envelope.update.action).toBe('install-failed');
    expect(envelope.errors[0].code).toBe('install_failed');
    expect(exitCode).toBe(3);
  });

  it('--prefix is forwarded to install script', async () => {
    const spawn = makeSpawnStub();
    const fetchImpl = makeFetchStub({ redirect: '99.99.99' });
    await runUpdate({
      args: ['--prefix', '/tmp/kmp'],
      spawn, fetchImpl,
    });
    const call = spawn.calls[0];
    const flag = process.platform === 'win32' ? '-Prefix' : '--prefix';
    expect(call.args).toContain(flag);
    expect(call.args).toContain('/tmp/kmp');
  });
});

describe('runUpdate failure modes', () => {
  it('release resolution fails → exit 3 + errors[].code:"release_resolve_failed"', async () => {
    const spawn = makeSpawnStub();
    const fetchImpl = makeFetchStub({ redirect: 'error', api: 'error' });
    const { envelope, exitCode } = await runUpdate({
      args: [],
      spawn, fetchImpl,
    });
    expect(envelope.errors[0].code).toBe('release_resolve_failed');
    expect(exitCode).toBe(3);
  });
});

describe('parseArgs', () => {
  it('--check, --force, --prerelease are flags', () => {
    expect(parseArgs(['--check']).check).toBe(true);
    expect(parseArgs(['--force']).force).toBe(true);
    expect(parseArgs(['--prerelease']).prerelease).toBe(true);
    expect(parseArgs([]).check).toBe(false);
    expect(parseArgs([]).force).toBe(false);
    expect(parseArgs([]).prerelease).toBe(false);
  });

  it('--prefix takes value', () => {
    expect(parseArgs(['--prefix', '/tmp/kmp']).prefix).toBe('/tmp/kmp');
  });
});

describe('buildInstallSpawn', () => {
  it('returns platform-specific command + args', () => {
    const spawn = buildInstallSpawn('1.2.3', '');
    if (process.platform === 'win32') {
      expect(spawn.command).toBe('pwsh');
      expect(spawn.args).toContain('-Version');
      expect(spawn.args).toContain('1.2.3');
      expect(spawn.fallback).toBe('powershell.exe');
    } else {
      expect(spawn.command).toBe('bash');
      expect(spawn.args).toContain('--version');
      expect(spawn.args).toContain('1.2.3');
    }
  });
});

describe('formatUpdateText', () => {
  it('renders multi-line summary for no-op', () => {
    const text = formatUpdateText({
      update: {
        current_version: '0.8.1',
        latest_version: '0.8.1',
        action: 'no-op',
        latest_source: 'redirect',
      },
    });
    expect(text).toMatch(/kmp-test update/);
    expect(text).toMatch(/Current.*0\.8\.1/);
    expect(text).toMatch(/Already on the latest/);
  });
});
