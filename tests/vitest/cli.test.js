import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock('node:child_process', () => ({ spawnSync: spawnMock }));

import {
  main,
  EXIT,
  resolveScript,
  ensureProjectRoot,
  getProjectRoot,
  getCoverageToolFromArgs,
  checkGradlew,
  consumeJsonFlag,
  stripAnsi,
  parseScriptOutput,
  buildJsonReport,
  envErrorJson,
  translateFlagForPowerShell,
} from '../../lib/cli.js';

beforeEach(() => spawnMock.mockReset().mockReturnValue({ status: 0 }));

// Build a temp dir with a stub gradlew so the pre-flight check passes.
function withFakeGradleProject(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-test-fixture-'));
  const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  writeFileSync(path.join(dir, wrapperName), '#!/usr/bin/env bash\nexit 0\n');
  // Always create both so platform-agnostic tests pass
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

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
    expect(ensureProjectRoot(['--project-root', '/x', 'extra']))
      .toEqual(['--project-root', '/x', 'extra']);
  });
});

describe('getProjectRoot', () => {
  it('returns cwd when --project-root absent', () => {
    expect(getProjectRoot([])).toBe(process.cwd());
    expect(getProjectRoot(['--module-filter', '*'])).toBe(process.cwd());
  });
  it('returns the explicit value when present', () => {
    expect(getProjectRoot(['--project-root', '/abs/path'])).toBe('/abs/path');
  });
});

describe('getCoverageToolFromArgs', () => {
  it('defaults to "auto" when not specified', () => {
    expect(getCoverageToolFromArgs([])).toBe('auto');
  });
  it('returns the explicit value', () => {
    expect(getCoverageToolFromArgs(['--coverage-tool', 'kover'])).toBe('kover');
    expect(getCoverageToolFromArgs(['--coverage-tool', 'jacoco'])).toBe('jacoco');
  });
});

describe('checkGradlew', () => {
  it('returns true when gradlew exists', () => {
    withFakeGradleProject(dir => {
      expect(checkGradlew(dir, false)).toBe(true);
      expect(checkGradlew(dir, true)).toBe(true);
    });
  });
  it('returns false on a directory without a wrapper', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-test-empty-'));
    try {
      expect(checkGradlew(dir, false)).toBe(false);
      expect(checkGradlew(dir, true)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('consumeJsonFlag', () => {
  it('strips --json and reports true', () => {
    const { args, json } = consumeJsonFlag(['--json', '--project-root', '/x']);
    expect(json).toBe(true);
    expect(args).toEqual(['--project-root', '/x']);
  });
  it('strips --format json (two tokens) and reports true', () => {
    const { args, json } = consumeJsonFlag(['--format', 'json', '--project-root', '/x']);
    expect(json).toBe(true);
    expect(args).toEqual(['--project-root', '/x']);
  });
  it('passes through unchanged when absent', () => {
    const { args, json } = consumeJsonFlag(['--project-root', '/x']);
    expect(json).toBe(false);
    expect(args).toEqual(['--project-root', '/x']);
  });
  it('does not consume --format when value is not "json"', () => {
    const { args, json } = consumeJsonFlag(['--format', 'yaml']);
    expect(json).toBe(false);
    expect(args).toEqual(['--format', 'yaml']);
  });
});

describe('stripAnsi', () => {
  it('removes color escape codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m text')).toBe('red text');
  });
  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('parseScriptOutput', () => {
  it('parses test counts from "Tests: X total | Y passed | Z failed | W skipped"', () => {
    const out = 'Tests: 42 total | 40 passed | 2 failed | 0 skipped\nBUILD FAILED';
    const r = parseScriptOutput(out, '', []);
    expect(r.tests).toEqual({ total: 42, passed: 40, failed: 2, skipped: 0 });
    // BUILD FAILED is captured in errors[]
    expect(r.errors.some(e => /BUILD FAILED/.test(e.message))).toBe(true);
  });

  it('extracts modules from MODULE COVERAGE SUMMARY table', () => {
    const out = [
      '  MODULE COVERAGE SUMMARY',
      '====',
      'core-foo                                          85.0%       12',
      'core-bar                                          92.5%        4',
      'TOTAL                                             88.0%       16',
      '====',
    ].join('\n');
    const r = parseScriptOutput(out, '', []);
    expect(r.modules).toContain('core-foo');
    expect(r.modules).toContain('core-bar');
    expect(r.modules).not.toContain('TOTAL');
  });

  it('parses SUMMARY coverage line for missed_lines', () => {
    const out = 'SUMMARY: 87.5% total | 42 lines missed | 3 modules at 100% | 1m 23s';
    const r = parseScriptOutput(out, '', []);
    expect(r.coverage.missed_lines).toBe(42);
  });

  it('reads coverage tool from args', () => {
    const r = parseScriptOutput('BUILD SUCCESSFUL', '', ['--coverage-tool', 'kover']);
    expect(r.coverage.tool).toBe('kover');
  });

  it('records a parse-gap error when no recognizable summary present', () => {
    const r = parseScriptOutput('completely opaque output', '', []);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some(e => /no recognizable/.test(e.message))).toBe(true);
  });

  it('does NOT add parse-gap error when BUILD SUCCESSFUL present', () => {
    const r = parseScriptOutput('BUILD SUCCESSFUL', '', []);
    expect(r.errors.find(e => /no recognizable/.test(e.message))).toBeUndefined();
  });

  it('strips ANSI codes before parsing', () => {
    const out = '\x1b[31mTests:\x1b[0m 5 total | 5 passed | 0 failed | 0 skipped';
    const r = parseScriptOutput(out, '', []);
    expect(r.tests.total).toBe(5);
    expect(r.tests.passed).toBe(5);
  });

  it('returns a partial-but-valid shape on completely empty output', () => {
    const r = parseScriptOutput('', '', []);
    expect(r.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(r.modules).toEqual([]);
    expect(r.coverage).toEqual({ tool: 'auto', missed_lines: null });
    expect(Array.isArray(r.errors)).toBe(true);
  });
});

describe('buildJsonReport', () => {
  it('produces an object with all required keys', () => {
    const parsed = parseScriptOutput('Tests: 1 total | 1 passed | 0 failed | 0 skipped\nBUILD SUCCESSFUL', '', []);
    const obj = buildJsonReport({
      subcommand: 'parallel',
      projectRoot: '/abs/p',
      exitCode: 0,
      durationMs: 1234,
      parsed,
    });
    expect(obj.tool).toBe('kmp-test');
    expect(obj.subcommand).toBe('parallel');
    expect(typeof obj.version).toBe('string');
    expect(obj.project_root).toBe('/abs/p');
    expect(obj.exit_code).toBe(0);
    expect(obj.duration_ms).toBe(1234);
    expect(obj.tests).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(Array.isArray(obj.modules)).toBe(true);
    expect(obj.coverage).toBeTypeOf('object');
    expect(Array.isArray(obj.errors)).toBe(true);
    // Entire object must round-trip through JSON without loss.
    expect(JSON.parse(JSON.stringify(obj))).toEqual(obj);
  });
});

describe('envErrorJson', () => {
  it('produces valid JSON shape with exit_code=3', () => {
    const obj = envErrorJson({
      subcommand: 'parallel',
      projectRoot: '/x',
      durationMs: 0,
      message: 'no gradlew',
    });
    expect(obj.exit_code).toBe(EXIT.ENV_ERROR);
    expect(obj.errors[0].message).toBe('no gradlew');
    expect(JSON.parse(JSON.stringify(obj))).toEqual(obj);
  });
});

describe('main() — exit codes & flow', () => {
  it('no args → CONFIG_ERROR (2) + prints global help', () => {
    process.argv = ['node', 'kmp-test.js'];
    expect(main()).toBe(EXIT.CONFIG_ERROR);
  });

  it('--help returns SUCCESS (0)', () => {
    process.argv = ['node', 'kmp-test.js', '--help'];
    expect(main()).toBe(EXIT.SUCCESS);
  });

  it('-h returns SUCCESS (0)', () => {
    process.argv = ['node', 'kmp-test.js', '-h'];
    expect(main()).toBe(EXIT.SUCCESS);
  });

  it('--version returns SUCCESS (0)', () => {
    process.argv = ['node', 'kmp-test.js', '--version'];
    expect(main()).toBe(EXIT.SUCCESS);
  });

  it('-v returns SUCCESS (0)', () => {
    process.argv = ['node', 'kmp-test.js', '-v'];
    expect(main()).toBe(EXIT.SUCCESS);
  });

  it('per-subcommand --help returns SUCCESS without spawning', () => {
    process.argv = ['node', 'kmp-test.js', 'parallel', '--help'];
    expect(main()).toBe(EXIT.SUCCESS);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(['parallel', 'changed', 'android', 'benchmark', 'coverage'])(
    '%s --help returns SUCCESS without spawning',
    (sub) => {
      process.argv = ['node', 'kmp-test.js', sub, '--help'];
      expect(main()).toBe(EXIT.SUCCESS);
      expect(spawnMock).not.toHaveBeenCalled();
    }
  );

  it('per-subcommand --version returns SUCCESS without spawning', () => {
    process.argv = ['node', 'kmp-test.js', 'parallel', '--version'];
    expect(main()).toBe(EXIT.SUCCESS);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('unknown subcommand returns CONFIG_ERROR (2)', () => {
    process.argv = ['node', 'kmp-test.js', 'nope'];
    expect(main()).toBe(EXIT.CONFIG_ERROR);
  });

  it('missing gradlew returns ENV_ERROR (3) without spawning the script', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-no-wrapper-'));
    try {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
      // No script spawn; pickWindowsShell may probe pwsh on win32 but real script never runs.
      const ranScript = spawnMock.mock.calls.some(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(ranScript).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing gradlew + --json emits valid JSON envelope with exit_code=3', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-no-wrapper-json-'));
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
      const code = main();
      process.stdout.write = origWrite;
      expect(code).toBe(EXIT.ENV_ERROR);
      const json = JSON.parse(captured.join('').trim());
      expect(json.tool).toBe('kmp-test');
      expect(json.exit_code).toBe(EXIT.ENV_ERROR);
      expect(json.errors[0].message).toMatch(/gradlew/);
    } finally {
      process.stdout.write = origWrite;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('valid subcommand passes through script status (0 → 0)', () => {
    spawnMock.mockReturnValue({ status: 0 });
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
    });
  });

  it('valid subcommand passes through script status (1 → 1)', () => {
    spawnMock.mockReturnValue({ status: 1 });
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.TEST_FAIL);
    });
  });

  it('coverage subcommand prefixes --skip-tests', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'coverage', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      expect(scriptCall[1].some(a => String(a).includes('--skip-tests') || String(a).includes('-SkipTests'))).toBe(true);
    });
  });

  it('--json mode emits a single valid JSON object on stdout', () => {
    spawnMock.mockReturnValue({
      status: 0,
      stdout: 'Tests: 5 total | 5 passed | 0 failed | 0 skipped\nBUILD SUCCESSFUL\n',
      stderr: '',
    });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
        const code = main();
        expect(code).toBe(EXIT.SUCCESS);
      });
      process.stdout.write = origWrite;
      const text = captured.join('').trim();
      const json = JSON.parse(text);
      expect(json.tool).toBe('kmp-test');
      expect(json.subcommand).toBe('parallel');
      expect(json.tests.total).toBe(5);
      expect(json.tests.passed).toBe(5);
      expect(json.exit_code).toBe(0);
      expect(typeof json.duration_ms).toBe('number');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('--json mode handles "no tests" gracefully (parse-gap → errors[])', () => {
    spawnMock.mockReturnValue({
      status: 3,
      stdout: '[ERROR] No modules found matching filter: *\n',
      stderr: '',
    });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
        const code = main();
        // Script exit 3 passes through (env-ish: no modules).
        expect(code).toBe(3);
      });
      process.stdout.write = origWrite;
      const json = JSON.parse(captured.join('').trim());
      expect(json.errors.length).toBeGreaterThan(0);
      expect(json.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('--format json (alias) is recognized', () => {
    spawnMock.mockReturnValue({
      status: 0,
      stdout: 'BUILD SUCCESSFUL\n',
      stderr: '',
    });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--format', 'json', '--project-root', dir];
        main();
      });
      process.stdout.write = origWrite;
      const text = captured.join('').trim();
      expect(() => JSON.parse(text)).not.toThrow();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('ENOENT (bash/pwsh missing) returns ENV_ERROR (3)', () => {
    const err = new Error('ENOENT'); err.code = 'ENOENT';
    spawnMock.mockReturnValue({ error: err });
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
    });
  });

  it('--project-root absent → cwd is used', () => {
    spawnMock.mockReturnValue({ status: 0 });
    const origCwd = process.cwd;
    withFakeGradleProject(dir => {
      process.cwd = () => dir;
      try {
        process.argv = ['node', 'kmp-test.js', 'parallel'];
        expect(main()).toBe(EXIT.SUCCESS);
        const scriptCall = spawnMock.mock.calls.find(
          c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
        );
        expect(scriptCall).toBeTruthy();
        // The cwd path appears as a --project-root value in the script args
        const argList = scriptCall[1].map(String);
        const idx = argList.findIndex(a => a === '--project-root' || a === '-ProjectRoot');
        expect(idx).toBeGreaterThan(-1);
        expect(argList[idx + 1]).toBe(dir);
      } finally {
        process.cwd = origCwd;
      }
    });
  });
});
