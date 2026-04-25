import { vi, describe, it, expect, beforeEach } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock('node:child_process', () => ({ spawnSync: spawnMock }));

import { main, resolveScript, ensureProjectRoot, translateFlagForPowerShell } from '../../lib/cli.js';

beforeEach(() => spawnMock.mockReset().mockReturnValue({ status: 0 }));

describe('resolveScript', () => {
  it('parallel/linux → run-parallel-coverage-suite.sh', () => {
    expect(resolveScript('parallel', 'linux')).toEqual({
      script: 'run-parallel-coverage-suite.sh', prefix: [],
    });
  });
  it('coverage/win32 → ps1 with --skip-tests prefix', () => {
    expect(resolveScript('coverage', 'win32')).toEqual({
      script: 'run-parallel-coverage-suite.ps1', prefix: ['--skip-tests'],
    });
  });
  it('unknown subcommand returns null', () => {
    expect(resolveScript('xyz', 'linux')).toBeNull();
  });
});

describe('translateFlagForPowerShell', () => {
  it('converts --project-root to -ProjectRoot', () => {
    expect(translateFlagForPowerShell('--project-root')).toBe('-ProjectRoot');
  });
  it('converts --skip-tests to -SkipTests', () => {
    expect(translateFlagForPowerShell('--skip-tests')).toBe('-SkipTests');
  });
  it('converts --include-shared to -IncludeShared', () => {
    expect(translateFlagForPowerShell('--include-shared')).toBe('-IncludeShared');
  });
  it('passes through values unchanged', () => {
    expect(translateFlagForPowerShell('/tmp/x')).toBe('/tmp/x');
  });
  it('passes through short flags unchanged', () => {
    expect(translateFlagForPowerShell('-h')).toBe('-h');
  });
  it('handles multi-word flags correctly', () => {
    expect(translateFlagForPowerShell('--benchmark-config')).toBe('-BenchmarkConfig');
  });
});

describe('ensureProjectRoot', () => {
  it('injects --project-root + cwd when omitted', () => {
    const out = ensureProjectRoot([]);
    expect(out[0]).toBe('--project-root');
    expect(out[1]).toBe(process.cwd());
  });
  it('passes through unchanged when present', () => {
    expect(ensureProjectRoot(['--project-root', '/x', 'extra'])).toEqual(['--project-root', '/x', 'extra']);
  });
});

describe('main()', () => {
  it('--help returns 0', () => {
    process.argv = ['node', 'kmp-test.js', '--help'];
    expect(main()).toBe(0);
  });
  it('--version returns 0', () => {
    process.argv = ['node', 'kmp-test.js', '--version'];
    expect(main()).toBe(0);
  });
  it('--help after subcommand returns 0 without spawning', () => {
    process.argv = ['node', 'kmp-test.js', 'parallel', '--help'];
    expect(main()).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it('--version after subcommand returns 0 without spawning', () => {
    process.argv = ['node', 'kmp-test.js', 'parallel', '--version'];
    expect(main()).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it('unknown subcommand returns 2', () => {
    process.argv = ['node', 'kmp-test.js', 'nope'];
    expect(main()).toBe(2);
  });
  it('valid subcommand propagates spawnSync status', () => {
    // On win32 pickWindowsShell() fires a spawnSync probe first.
    // Setting persistent return to 42 ensures all calls return 42.
    spawnMock.mockReturnValue({ status: 42 });
    process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', '/tmp/x'];
    expect(main()).toBe(42);
  });
  it('coverage subcommand prefixes --skip-tests', () => {
    process.argv = ['node', 'kmp-test.js', 'coverage', '--project-root', '/tmp/x'];
    main();
    const scriptCall = spawnMock.mock.calls.find(
      c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
    );
    expect(scriptCall).toBeTruthy();
    expect(scriptCall[1].some(a => String(a).includes('--skip-tests') || String(a).includes('-SkipTests'))).toBe(true);
  });
  it('ENOENT returns 127', () => {
    const err = new Error('ENOENT'); err.code = 'ENOENT';
    spawnMock.mockReturnValue({ error: err });
    process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', '/tmp/x'];
    expect(main()).toBe(127);
  });
});
