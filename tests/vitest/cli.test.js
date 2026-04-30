import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock('node:child_process', () => ({ spawnSync: spawnMock }));

// v0.6.x Gap 2: mock the JDK catalogue so tests can control which installs
// the auto-select sees. Default empty (the gate fires unless tests override).
const discoverInstalledJdksMock = vi.hoisted(() => vi.fn(() => []));
vi.mock('../../lib/jdk-catalogue.js', () => ({ discoverInstalledJdks: discoverInstalledJdksMock }));

import {
  main,
  EXIT,
  resolveScript,
  ensureProjectRoot,
  getProjectRoot,
  getCoverageToolFromArgs,
  getBenchmarkPlatform,
  checkGradlew,
  consumeJsonFlag,
  consumeDryRunFlag,
  consumeForceFlag,
  consumeTestFilter,
  expandNoCoverageAlias,
  getIgnoreJdkMismatch,
  findRequiredJdkVersion,
  preflightJdkCheck,
  jdkMismatchHint,
  lockfilePath,
  isPidAlive,
  readLockfile,
  writeLockfile,
  removeLockfile,
  acquireLock,
  lockAgeLabel,
  stripAnsi,
  parseScriptOutput,
  buildJsonReport,
  buildDryRunReport,
  envErrorJson,
  translateFlagForPowerShell,
  findFirstClassFqn,
  splitClassMethod,
  resolveAndroidTestFilter,
  resolvePatternForSubcommand,
  runDoctorChecks,
  parseGradleTimeoutMs,
  DEFAULT_GRADLE_TIMEOUT_MS,
} from '../../lib/cli.js';

beforeEach(() => {
  spawnMock.mockReset().mockReturnValue({ status: 0 });
  discoverInstalledJdksMock.mockReset().mockReturnValue([]);
});

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

describe('expandNoCoverageAlias (v0.6 Bug 5)', () => {
  it('returns args unchanged when --no-coverage is absent', () => {
    expect(expandNoCoverageAlias(['parallel', '--project-root', '/x']))
      .toEqual(['parallel', '--project-root', '/x']);
  });

  it('replaces --no-coverage with --coverage-tool none', () => {
    expect(expandNoCoverageAlias(['parallel', '--no-coverage']))
      .toEqual(['parallel', '--coverage-tool', 'none']);
  });

  it('drops --no-coverage when --coverage-tool is already explicit (explicit wins)', () => {
    expect(expandNoCoverageAlias(['parallel', '--no-coverage', '--coverage-tool', 'kover']))
      .toEqual(['parallel', '--coverage-tool', 'kover']);
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
    const fallback = r.errors.find(e => /no recognizable/.test(e.message));
    expect(fallback).toBeDefined();
    expect(fallback.code).toBe('no_summary');
  });

  it('fallback error carries code: no_summary when output is empty', () => {
    const r = parseScriptOutput('', '', []);
    const fallback = r.errors.find(e => e.code === 'no_summary');
    expect(fallback).toBeDefined();
    expect(fallback.message).toMatch(/no recognizable/);
  });

  it('does NOT add parse-gap error when BUILD SUCCESSFUL present', () => {
    const r = parseScriptOutput('BUILD SUCCESSFUL', '', []);
    expect(r.errors.find(e => /no recognizable/.test(e.message))).toBeUndefined();
  });

  it('discriminates code: no_test_modules on wrapper [ERROR] No modules line', () => {
    const out = '[SKIP] composeApp (no test source set - pass --include-untested to override)\n[ERROR] No modules found matching filter: *\n';
    const r = parseScriptOutput(out, '', []);
    const e = r.errors.find(x => x.code === 'no_test_modules');
    expect(e).toBeDefined();
    expect(e.message).toMatch(/^\[ERROR\] No modules found matching filter/);
  });

  it('does NOT fire no_test_modules when the line is in a quoted gradle log body', () => {
    const out = 'gradle log: "[ERROR] No modules found matching filter: foo" (was a comment)\nBUILD SUCCESSFUL\n';
    const r = parseScriptOutput(out, '', []);
    expect(r.errors.find(e => e.code === 'no_test_modules')).toBeUndefined();
  });

  it('no_test_modules discriminator preempts no_summary fallback', () => {
    const out = '[ERROR] No modules found matching filter: *\n';
    const r = parseScriptOutput(out, '', []);
    expect(r.errors.find(e => e.code === 'no_test_modules')).toBeDefined();
    expect(r.errors.find(e => e.code === 'no_summary')).toBeUndefined();
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

// ---------------------------------------------------------------------------
// v0.3.7 — DX & agentic features: --dry-run, doctor, --test-filter
// ---------------------------------------------------------------------------

describe('consumeDryRunFlag', () => {
  it('strips --dry-run and reports true', () => {
    const { args, dryRun } = consumeDryRunFlag(['parallel', '--dry-run', '--project-root', '/x']);
    expect(dryRun).toBe(true);
    expect(args).toEqual(['parallel', '--project-root', '/x']);
  });
  it('passes through unchanged when absent', () => {
    const { args, dryRun } = consumeDryRunFlag(['parallel', '--project-root', '/x']);
    expect(dryRun).toBe(false);
    expect(args).toEqual(['parallel', '--project-root', '/x']);
  });
  it('strips multiple occurrences (idempotent)', () => {
    const { args, dryRun } = consumeDryRunFlag(['--dry-run', 'a', '--dry-run']);
    expect(dryRun).toBe(true);
    expect(args).toEqual(['a']);
  });
});

describe('consumeTestFilter', () => {
  it('strips --test-filter <pattern> and returns it', () => {
    const { args, pattern } = consumeTestFilter(['--test-filter', '*FooTest*', '--module-filter', '*']);
    expect(pattern).toBe('*FooTest*');
    expect(args).toEqual(['--module-filter', '*']);
  });
  it('passes through unchanged when absent', () => {
    const { args, pattern } = consumeTestFilter(['--module-filter', '*']);
    expect(pattern).toBeNull();
    expect(args).toEqual(['--module-filter', '*']);
  });
  it('honors only the last --test-filter when given twice', () => {
    const { args, pattern } = consumeTestFilter(['--test-filter', 'A', '--test-filter', 'B']);
    expect(pattern).toBe('B');
    expect(args).toEqual([]);
  });
  it('does not consume --test-filter without a value', () => {
    // Trailing flag with no value: no value to capture, flag swallowed (defensive).
    const { args, pattern } = consumeTestFilter(['--test-filter']);
    expect(pattern).toBeNull();
    // Edge: unconsumed value-less flag is preserved (loop hits last index without next).
    expect(args).toEqual(['--test-filter']);
  });
});

describe('getBenchmarkPlatform', () => {
  it('defaults to "all" when --platform absent', () => {
    expect(getBenchmarkPlatform([])).toBe('all');
  });
  it('returns explicit platform value', () => {
    expect(getBenchmarkPlatform(['--platform', 'jvm'])).toBe('jvm');
    expect(getBenchmarkPlatform(['--platform', 'android'])).toBe('android');
  });
});

describe('findFirstClassFqn', () => {
  it('locates a Kotlin class declaration with package and returns FQN', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-fqn-'));
    try {
      const moduleSrc = path.join(dir, 'benchmarks', 'src', 'main', 'kotlin', 'com', 'example');
      mkdirSync(moduleSrc, { recursive: true });
      writeFileSync(path.join(moduleSrc, 'ScaleBenchmark.kt'),
        'package com.example\n\nclass ScaleBenchmark {\n  fun bench() {}\n}\n');
      // Add a decoy file with similar name to confirm we match exact simpleName boundary.
      writeFileSync(path.join(moduleSrc, 'ScaleBenchmarkContext.kt'),
        'package com.example\n\nclass ScaleBenchmarkContext {}\n');
      expect(findFirstClassFqn(dir, 'ScaleBenchmark')).toBe('com.example.ScaleBenchmark');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no class with that simpleName exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-none-'));
    try {
      const src = path.join(dir, 'src', 'main', 'kotlin');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'A.kt'), 'package x\n\nclass A {}\n');
      expect(findFirstClassFqn(dir, 'NotPresent')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips build/, .gradle/, node_modules/, .git/', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-skip-'));
    try {
      // Class inside build/ — must NOT be matched
      mkdirSync(path.join(dir, 'build', 'gen'), { recursive: true });
      writeFileSync(path.join(dir, 'build', 'gen', 'BuildArtifact.kt'),
        'package gen\n\nclass BuildArtifact {}\n');
      expect(findFirstClassFqn(dir, 'BuildArtifact')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns simpleName when class found but no package declaration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-nopkg-'));
    try {
      writeFileSync(path.join(dir, 'NoPkg.kt'), 'class NoPkg {}\n');
      expect(findFirstClassFqn(dir, 'NoPkg')).toBe('NoPkg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('substring pattern *Foo* matches a class whose name contains the core', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-substr-'));
    try {
      const src = path.join(dir, 'src', 'androidTest', 'kotlin', 'com', 'example');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'ScaleBenchmark.kt'),
        'package com.example\n\nclass ScaleBenchmark {}\n');
      expect(findFirstClassFqn(dir, '*Scale*')).toBe('com.example.ScaleBenchmark');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefix pattern Foo* matches a class starting with the core', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-prefix-'));
    try {
      const src = path.join(dir, 'src', 'main', 'kotlin', 'p');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'ScaleBenchmark.kt'),
        'package p\n\nclass ScaleBenchmark {}\n');
      expect(findFirstClassFqn(dir, 'Scale*')).toBe('p.ScaleBenchmark');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suffix pattern *Foo matches a class ending with the core', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-suffix-'));
    try {
      const src = path.join(dir, 'src', 'main', 'kotlin', 'p');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'ScaleBenchmark.kt'),
        'package p\n\nclass ScaleBenchmark {}\n');
      expect(findFirstClassFqn(dir, '*Benchmark')).toBe('p.ScaleBenchmark');
      // suffix must NOT match a class that has trailing chars after the core
      expect(findFirstClassFqn(dir, '*Bench')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exact pattern (no wildcards) preserves word-boundary behavior — *Scale* matches ScaleBenchmark but Scale alone does not', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-class-exact-'));
    try {
      const src = path.join(dir, 'src', 'main', 'kotlin', 'p');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'ScaleBenchmark.kt'),
        'package p\n\nclass ScaleBenchmark {}\n');
      // Exact match — boundary after `Scale` would land on `B` (word char), so no match.
      expect(findFirstClassFqn(dir, 'Scale')).toBeNull();
      // Substring with wildcards finds it.
      expect(findFirstClassFqn(dir, '*Scale*')).toBe('p.ScaleBenchmark');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('splitClassMethod (Gap E v0.5.2)', () => {
  it('returns class only when no method portion', () => {
    expect(splitClassMethod('com.example.FooTest')).toEqual({
      cls: 'com.example.FooTest',
      method: null,
    });
  });
  it('splits on # (preferred form)', () => {
    expect(splitClassMethod('com.example.FooTest#testBar')).toEqual({
      cls: 'com.example.FooTest',
      method: 'testBar',
    });
  });
  it('splits on .method via heuristic when last segment lowercase', () => {
    expect(splitClassMethod('com.example.FooTest.testBar')).toEqual({
      cls: 'com.example.FooTest',
      method: 'testBar',
    });
  });
  it('does NOT split when last segment is uppercase (bare FQN)', () => {
    expect(splitClassMethod('com.example.FooTest')).toEqual({
      cls: 'com.example.FooTest',
      method: null,
    });
  });
  it('preserves wildcard in class part when # form used', () => {
    expect(splitClassMethod('*FooTest*#testBar')).toEqual({
      cls: '*FooTest*',
      method: 'testBar',
    });
  });
  it('preserves wildcard in class part when .method form used (heuristic)', () => {
    expect(splitClassMethod('*FooTest*.testBar')).toEqual({
      cls: '*FooTest*',
      method: 'testBar',
    });
  });
  it('handles null/empty input', () => {
    expect(splitClassMethod(null)).toEqual({ cls: null, method: null });
    expect(splitClassMethod('')).toEqual({ cls: '', method: null });
  });
  it('returns method:null when # has no method after it', () => {
    expect(splitClassMethod('FooTest#')).toEqual({ cls: 'FooTest', method: null });
  });
  it('keeps remainder past second # in method portion (forwarded as-is)', () => {
    expect(splitClassMethod('Foo#bar#baz')).toEqual({ cls: 'Foo', method: 'bar#baz' });
  });
});

describe('resolveAndroidTestFilter', () => {
  it('passes pattern through unchanged when no wildcards', () => {
    expect(resolveAndroidTestFilter('com.example.Foo', '/nope')).toBe('com.example.Foo');
  });
  it('returns original pattern when no source match found', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-resolve-fail-'));
    try {
      expect(resolveAndroidTestFilter('*Missing*', dir)).toBe('*Missing*');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('resolves *FooBar* glob to FQN when class found', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-resolve-ok-'));
    try {
      const src = path.join(dir, 'src', 'androidTest', 'kotlin', 'com', 'demo');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'ScaleBenchmark.kt'),
        'package com.demo\n\nclass ScaleBenchmark {}\n');
      expect(resolveAndroidTestFilter('*ScaleBenchmark*', dir)).toBe('com.demo.ScaleBenchmark');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves *Scale* (substring of class name) to FQN — regression for v0.5.1 wildcard fix', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-resolve-substr-'));
    try {
      const src = path.join(dir, 'benchmark', 'src', 'androidTest', 'kotlin', 'com', 'demo');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'ScaleBenchmark.kt'),
        'package com.demo\n\nclass ScaleBenchmark {}\n');
      // Pre-fix bug: `*Scale*` stripped wildcards → searched `class Scale\b` → no match
      // (because `B` in `ScaleBenchmark` is a word char) → returned `*Scale*` literal,
      // which gradle then rejected with "Failed loading specified test class '*Scale*'".
      expect(resolveAndroidTestFilter('*Scale*', dir)).toBe('com.demo.ScaleBenchmark');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns null/empty input unchanged', () => {
    expect(resolveAndroidTestFilter(null, '/x')).toBeNull();
    expect(resolveAndroidTestFilter('', '/x')).toBe('');
  });

  // Gap E (v0.5.2) — method-level filtering for Android
  it('forwards literal FQN#method as-is (wire format)', () => {
    expect(resolveAndroidTestFilter('com.example.FooTest#testBar', '/nope'))
      .toBe('com.example.FooTest#testBar');
  });
  it('normalizes FQN.method to FQN#method on the wire (heuristic)', () => {
    expect(resolveAndroidTestFilter('com.example.FooTest.testBar', '/nope'))
      .toBe('com.example.FooTest#testBar');
  });
  it('resolves wildcard class part and recombines with method via #', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-resolve-method-hash-'));
    try {
      const src = path.join(dir, 'src', 'androidTest', 'kotlin', 'com', 'demo');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'WidgetTest.kt'),
        'package com.demo\n\nclass WidgetTest {}\n');
      expect(resolveAndroidTestFilter('*WidgetTest*#testFoo', dir))
        .toBe('com.demo.WidgetTest#testFoo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('resolves wildcard class part and recombines with method via .heuristic', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-resolve-method-dot-'));
    try {
      const src = path.join(dir, 'src', 'androidTest', 'kotlin', 'com', 'demo');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'WidgetTest.kt'),
        'package com.demo\n\nclass WidgetTest {}\n');
      expect(resolveAndroidTestFilter('*WidgetTest*.testFoo', dir))
        .toBe('com.demo.WidgetTest#testFoo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolvePatternForSubcommand', () => {
  it('parallel/changed/coverage pass pattern through (gradle --tests handles globs)', () => {
    expect(resolvePatternForSubcommand('*Foo*', 'parallel', [], '/x')).toBe('*Foo*');
    expect(resolvePatternForSubcommand('*Foo*', 'changed', [], '/x')).toBe('*Foo*');
    expect(resolvePatternForSubcommand('*Foo*', 'coverage', [], '/x')).toBe('*Foo*');
  });
  it('android resolves glob via source scan', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-resolve-android-'));
    try {
      const src = path.join(dir, 'src', 'androidTest', 'kotlin', 'p');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'WidgetTest.kt'),
        'package p\n\nclass WidgetTest {}\n');
      expect(resolvePatternForSubcommand('*WidgetTest*', 'android', [], dir)).toBe('p.WidgetTest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('benchmark + --platform jvm passes pattern through', () => {
    expect(resolvePatternForSubcommand('*Foo*', 'benchmark', ['--platform', 'jvm'], '/x')).toBe('*Foo*');
  });
  it('benchmark + --platform android resolves glob', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-resolve-bench-'));
    try {
      const src = path.join(dir, 'benchmarks', 'src', 'main', 'kotlin', 'b');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'DiBenchmark.kt'),
        'package b\n\nclass DiBenchmark {}\n');
      expect(
        resolvePatternForSubcommand('*DiBenchmark*', 'benchmark', ['--platform', 'android'], dir)
      ).toBe('b.DiBenchmark');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns null when no pattern given', () => {
    expect(resolvePatternForSubcommand(null, 'parallel', [], '/x')).toBeNull();
  });
});

describe('buildDryRunReport', () => {
  it('emits the canonical envelope with dry_run:true and a plan{} section', () => {
    const report = buildDryRunReport({
      subcommand: 'parallel',
      projectRoot: '/abs',
      plan: {
        spawn_cmd: 'bash',
        spawn_args: ['/path/to/script.sh', '--project-root', '/abs'],
        script_path: '/path/to/script.sh',
        final_args: ['--project-root', '/abs'],
        test_filter: null,
      },
    });
    expect(report.tool).toBe('kmp-test');
    expect(report.subcommand).toBe('parallel');
    expect(report.dry_run).toBe(true);
    expect(report.exit_code).toBe(EXIT.SUCCESS);
    expect(report.duration_ms).toBe(0);
    expect(report.plan.spawn_cmd).toBe('bash');
    expect(report.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    // Round-trips through JSON without loss
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('runDoctorChecks', () => {
  it('returns at least 5 checks (Node, shell, gradlew, JDK, ADB)', () => {
    // Mock all spawn probes — JDK 21 found, ADB missing, pwsh found on win
    spawnMock.mockImplementation((cmd) => {
      if (cmd === 'java') {
        return { status: 0, stderr: 'openjdk version "21.0.10" 2024-12\n', stdout: '' };
      }
      if (cmd === 'adb') {
        const e = new Error('not found'); e.code = 'ENOENT';
        return { error: e, status: null };
      }
      // pwsh / bash probes
      return { status: 0, stdout: '', stderr: '' };
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-doctor-'));
    try {
      const { checks, exitCode } = runDoctorChecks(dir);
      expect(checks.length).toBeGreaterThanOrEqual(5);
      const names = checks.map(c => c.name);
      expect(names).toContain('Node');
      expect(names.some(n => n === 'bash' || n === 'pwsh')).toBe(true);
      expect(names).toContain('gradlew');
      expect(names).toContain('JDK');
      expect(names).toContain('ADB');
      // Node always present (running tests on >=18)
      const nodeCheck = checks.find(c => c.name === 'Node');
      expect(['OK', 'FAIL']).toContain(nodeCheck.status);
      // No FAIL → exit SUCCESS
      const hasFail = checks.some(c => c.status === 'FAIL');
      expect(exitCode).toBe(hasFail ? EXIT.ENV_ERROR : EXIT.SUCCESS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports JDK FAIL when java spawn fails outright', () => {
    spawnMock.mockImplementation((cmd) => {
      if (cmd === 'java') {
        const e = new Error('ENOENT'); e.code = 'ENOENT';
        return { error: e, status: null };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-doctor-no-jdk-'));
    try {
      const { checks, exitCode } = runDoctorChecks(dir);
      const jdk = checks.find(c => c.name === 'JDK');
      expect(jdk.status).toBe('FAIL');
      expect(exitCode).toBe(EXIT.ENV_ERROR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports gradlew OK when present in projectRoot', () => {
    spawnMock.mockImplementation((cmd) => {
      if (cmd === 'java') return { status: 0, stderr: 'openjdk version "17.0.1"\n' };
      return { status: 0 };
    });
    withFakeGradleProject(dir => {
      const { checks } = runDoctorChecks(dir);
      const gw = checks.find(c => c.name === 'gradlew');
      expect(gw.status).toBe('OK');
    });
  });
});

describe('parseGradleTimeoutMs (Bug H — gradle watchdog)', () => {
  it('returns 30 minute default when env var unset', () => {
    expect(parseGradleTimeoutMs(undefined)).toBe(30 * 60 * 1000);
    expect(parseGradleTimeoutMs('')).toBe(30 * 60 * 1000);
    expect(DEFAULT_GRADLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('parses positive integer env values', () => {
    expect(parseGradleTimeoutMs('60000')).toBe(60000);
    expect(parseGradleTimeoutMs('3600000')).toBe(3600000);
  });

  it('falls back to default on garbage / non-positive values', () => {
    expect(parseGradleTimeoutMs('not-a-number')).toBe(DEFAULT_GRADLE_TIMEOUT_MS);
    expect(parseGradleTimeoutMs('0')).toBe(DEFAULT_GRADLE_TIMEOUT_MS);
    expect(parseGradleTimeoutMs('-100')).toBe(DEFAULT_GRADLE_TIMEOUT_MS);
  });
});

describe('main() — gradle timeout (Bug H)', () => {
  it('--json mode surfaces gradle_timeout error code on SIGTERM', () => {
    // spawnSync returns { status: null, signal: 'SIGTERM' } when the timeout
    // option fires. The CLI must classify this as a gradle_timeout env error
    // (not a generic test failure) so agents can distinguish hung-daemon from
    // failing-tests.
    spawnMock.mockReturnValue({ status: null, signal: 'SIGTERM' });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
        const code = main();
        // Phase 4 step 9: gradle_timeout returns ENV_ERROR (3) — same class as
        // JDK mismatch and missing shell. Process exit and JSON envelope
        // exit_code now agree (both 3).
        expect(code).toBe(EXIT.ENV_ERROR);
      });
      process.stdout.write = origWrite;
      const json = JSON.parse(captured.join('').trim());
      expect(json.errors).toBeTruthy();
      expect(Array.isArray(json.errors)).toBe(true);
      const timeoutErr = json.errors.find(e => e.code === 'gradle_timeout');
      expect(timeoutErr).toBeTruthy();
      expect(timeoutErr.message).toMatch(/exceeded.*timeout/);
      expect(timeoutErr.message).toMatch(/KMP_GRADLE_TIMEOUT_MS/);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('--json mode surfaces gradle_timeout on Windows ETIMEDOUT error path (Bug H gap)', () => {
    // On Windows the spawn timeout doesn't surface as result.signal=SIGTERM —
    // it bubbles up as result.error.code='ETIMEDOUT'. Both paths must
    // converge on the same gradle_timeout envelope so agents don't see a
    // different shape across platforms.
    spawnMock.mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error('spawnSync pwsh ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
        const code = main();
        expect(code).toBe(EXIT.ENV_ERROR);  // Phase 4 step 9
      });
      process.stdout.write = origWrite;
      const json = JSON.parse(captured.join('').trim());
      const timeoutErr = (json.errors || []).find(e => e.code === 'gradle_timeout');
      expect(timeoutErr).toBeTruthy();
      expect(timeoutErr.message).toMatch(/exceeded.*timeout/);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('--json mode does NOT classify normal exits as gradle_timeout', () => {
    // status=0, no signal → just a successful run, no timeout error.
    spawnMock.mockReturnValue({
      status: 0,
      stdout: 'Tests: 1 total | 1 passed | 0 failed | 0 skipped\nBUILD SUCCESSFUL\n',
      stderr: '',
    });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
        main();
      });
      process.stdout.write = origWrite;
      const json = JSON.parse(captured.join('').trim());
      const timeoutErr = (json.errors || []).find(e => e.code === 'gradle_timeout');
      expect(timeoutErr).toBeFalsy();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('non-json mode prints timeout message to stderr', () => {
    spawnMock.mockReturnValue({ status: null, signal: 'SIGTERM' });
    const stderrCaptured = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrCaptured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
        const code = main();
        expect(code).toBe(EXIT.ENV_ERROR);  // Phase 4 step 9
      });
      process.stderr.write = origStderrWrite;
      const text = stderrCaptured.join('');
      expect(text).toMatch(/exceeded.*timeout/);
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it('passes timeout + killSignal options through to spawnSync', () => {
    // Verify the spawn call carries the watchdog config so a real run will
    // actually time out instead of hanging forever (regression test for the
    // v0.5.0 zombie-process scenario).
    spawnMock.mockReturnValue({ status: 0 });
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      main();
    });
    const scriptCall = spawnMock.mock.calls.find(
      c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
    );
    expect(scriptCall).toBeTruthy();
    const opts = scriptCall[2];
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.killSignal).toBe('SIGTERM');
  });
});

describe('main() — Bug Z (Windows pipe-inheritance deadlock with --json)', () => {
  it('on Windows + --json passes file descriptors instead of pipes to spawn', () => {
    // The whole point of Bug Z fix: spawn opts on Windows + jsonMode use FDs
    // for stdout/stderr (not 'pipe') so the gradle daemon's pipe inheritance
    // can't keep spawnSync waiting forever after pwsh.exe exits.
    if (process.platform !== 'win32') return;  // POSIX uses default pipes; OK.
    spawnMock.mockReturnValue({
      status: 0,
      stdout: 'Tests: 1 total | 1 passed | 0 failed | 0 skipped\nBUILD SUCCESSFUL\n',
      stderr: '',
    });
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
      main();
    });
    const scriptCall = spawnMock.mock.calls.find(
      c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
    );
    expect(scriptCall).toBeTruthy();
    const opts = scriptCall[2];
    // On Windows + jsonMode, stdio must be ['ignore', <fd>, <fd>] rather than
    // the default 'pipe'. Pipes inherit to grandchildren and cause the v0.5.0
    // 41-minute hang.
    expect(Array.isArray(opts.stdio)).toBe(true);
    expect(opts.stdio[0]).toBe('ignore');
    expect(typeof opts.stdio[1]).toBe('number');
    expect(typeof opts.stdio[2]).toBe('number');
  });

  it('non-Windows + --json keeps legacy buffered-pipe contract', () => {
    if (process.platform === 'win32') return;
    spawnMock.mockReturnValue({
      status: 0,
      stdout: 'Tests: 1 total | 1 passed | 0 failed | 0 skipped\nBUILD SUCCESSFUL\n',
      stderr: '',
    });
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
      main();
    });
    const scriptCall = spawnMock.mock.calls.find(
      c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
    );
    expect(scriptCall).toBeTruthy();
    const opts = scriptCall[2];
    expect(opts.encoding).toBe('utf8');
    expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
  });
});

describe('main() — Phase 4 step 7 (eager ProjectModel build before spawn)', () => {
  it('writes model-<sha>.json into the project cache before invoking the script', () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    withFakeGradleProject(dir => {
      // Add a settings.gradle.kts so parseSettingsIncludes has something to do.
      writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
      mkdirSync(path.join(dir, 'm'), { recursive: true });
      writeFileSync(path.join(dir, 'm', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      main();
      const cacheDir = path.join(dir, '.kmp-test-runner-cache');
      const modelFiles = readdirSync(cacheDir).filter(f => f.startsWith('model-') && f.endsWith('.json'));
      expect(modelFiles.length).toBeGreaterThan(0);
      const model = JSON.parse(readFileSync(path.join(cacheDir, modelFiles[0]), 'utf8'));
      expect(model.schemaVersion).toBe(1);
      expect(model.settingsIncludes).toEqual([':m']);
      expect(model.modules[':m'].type).toBe('jvm');
    });
  });

  it('--dry-run does NOT trigger eager model build (kept instant)', () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":m")');
        process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--project-root', dir];
        const code = main();
        expect(code).toBe(EXIT.SUCCESS);
        // The eager build call lives AFTER the dry-run early return, so no
        // model JSON should appear on disk after a --dry-run invocation.
        const cacheDir = path.join(dir, '.kmp-test-runner-cache');
        if (existsSync(cacheDir)) {
          const files = readdirSync(cacheDir).filter(f => f.startsWith('model-'));
          expect(files).toEqual([]);
        }
      });
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('eager build is best-effort: does not throw on a malformed settings.gradle.kts', () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    withFakeGradleProject(dir => {
      // Garbage settings file; aggregateJdkSignals + parseSettingsIncludes
      // must swallow internal errors without aborting the run.
      writeFileSync(path.join(dir, 'settings.gradle.kts'), '\x00\x01\x02 invalid bytes');
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      const code = main();
      expect(code).toBe(EXIT.SUCCESS);  // run still completed
    });
  });
});

describe('main() — doctor subcommand', () => {
  it('doctor returns SUCCESS when no FAIL', () => {
    spawnMock.mockImplementation((cmd) => {
      if (cmd === 'java') return { status: 0, stderr: 'openjdk version "17.0.1"\n' };
      return { status: 0 };
    });
    process.argv = ['node', 'kmp-test.js', 'doctor', '--project-root', tmpdir()];
    const code = main();
    expect([EXIT.SUCCESS, EXIT.ENV_ERROR]).toContain(code);
  });

  it('doctor --json emits a single JSON object with checks[]', () => {
    spawnMock.mockImplementation((cmd) => {
      if (cmd === 'java') return { status: 0, stderr: 'openjdk version "17.0.1"\n' };
      return { status: 0 };
    });
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      process.argv = ['node', 'kmp-test.js', 'doctor', '--json', '--project-root', tmpdir()];
      main();
    } finally {
      process.stdout.write = origWrite;
    }
    const json = JSON.parse(captured.join('').trim());
    expect(json.tool).toBe('kmp-test');
    expect(json.subcommand).toBe('doctor');
    expect(Array.isArray(json.checks)).toBe(true);
    expect(json.checks.length).toBeGreaterThan(0);
    expect(typeof json.exit_code).toBe('number');
  });

  it('doctor --help prints help and returns SUCCESS without spawning checks', () => {
    process.argv = ['node', 'kmp-test.js', 'doctor', '--help'];
    expect(main()).toBe(EXIT.SUCCESS);
    // No java/adb probes should have been issued.
    const probed = spawnMock.mock.calls.some(c => ['java', 'adb'].includes(c[0]));
    expect(probed).toBe(false);
  });
});

describe('main() — --dry-run', () => {
  it('--dry-run skips spawn and returns SUCCESS', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      const ranScript = spawnMock.mock.calls.some(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(ranScript).toBe(false);
    });
  });

  it('--dry-run --json emits a single JSON object with dry_run:true and a plan{}', () => {
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--json', '--project-root', dir];
        expect(main()).toBe(EXIT.SUCCESS);
      });
    } finally {
      process.stdout.write = origWrite;
    }
    const json = JSON.parse(captured.join('').trim());
    expect(json.tool).toBe('kmp-test');
    expect(json.subcommand).toBe('parallel');
    expect(json.dry_run).toBe(true);
    expect(json.exit_code).toBe(0);
    expect(json.plan).toBeTypeOf('object');
    expect(Array.isArray(json.plan.spawn_args)).toBe(true);
    expect(typeof json.plan.script_path).toBe('string');
  });

  it('--dry-run BEFORE the subcommand is also recognized (hoisted)', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', '--dry-run', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      const ranScript = spawnMock.mock.calls.some(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(ranScript).toBe(false);
    });
  });

  it('--dry-run still validates gradlew (env error if missing)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-dry-no-grad-'));
    try {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('main() — --no-coverage alias (v0.6 Bug 5)', () => {
  it('--no-coverage propagates as --coverage-tool none, NOT as --no-coverage / -NoCoverage', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--no-coverage', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      const argList = scriptCall[1].map(String);
      // Final argv must NOT carry --no-coverage or its PowerShell-translated form.
      expect(argList).not.toContain('--no-coverage');
      expect(argList).not.toContain('-NoCoverage');
      // Must carry --coverage-tool none (or PS1-translated -CoverageTool none).
      const i = argList.findIndex(a => a === '--coverage-tool' || a === '-CoverageTool');
      expect(i).toBeGreaterThan(-1);
      expect(argList[i + 1]).toBe('none');
    });
  });
});

describe('main() — --test-filter passthrough', () => {
  it('parallel + --test-filter <pattern> appends --test-filter to script args', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel',
        '--test-filter', '*FooTest*', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      const argList = scriptCall[1].map(String);
      const i = argList.findIndex(a => a === '--test-filter' || a === '-TestFilter');
      expect(i).toBeGreaterThan(-1);
      expect(argList[i + 1]).toBe('*FooTest*');
    });
  });

  it('android + glob --test-filter resolves via source scan to FQN', () => {
    withFakeGradleProject(dir => {
      const src = path.join(dir, 'app', 'src', 'androidTest', 'kotlin', 'app');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'WidgetTest.kt'),
        'package app\n\nclass WidgetTest {}\n');
      process.argv = ['node', 'kmp-test.js', 'android',
        '--test-filter', '*WidgetTest*', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      const argList = scriptCall[1].map(String);
      const i = argList.findIndex(a => a === '--test-filter' || a === '-TestFilter');
      expect(i).toBeGreaterThan(-1);
      // Wildcards stripped + resolved to FQN
      expect(argList[i + 1]).toBe('app.WidgetTest');
    });
  });
});

// ============================================================================
// Gradle 9 deprecation notice → warnings[] (v0.5.0 — Bug C fix)
// ============================================================================

describe('parseScriptOutput — Gradle deprecation notice → warnings[]', () => {
  it('extracts [NOTICE] line into warnings with code "gradle_deprecation"', () => {
    const out = [
      'Tests: 20 total | 20 passed | 0 failed | 0 skipped',
      '[NOTICE] Gradle exited with code 1 but all 20 tasks passed individually.',
      '         This is likely deprecation warnings (Gradle 9+), not test failures.',
      'BUILD SUCCESSFUL in 1m',
    ].join('\n');
    const r = parseScriptOutput(out, '', []);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].code).toBe('gradle_deprecation');
    expect(r.warnings[0].gradle_exit_code).toBe(1);
    expect(r.warnings[0].tasks_passed).toBe(20);
    expect(r.warnings[0].message).toMatch(/all 20 tasks passed/);
  });

  it('does NOT push BUILD FAILED to errors[] when paired with the deprecation notice', () => {
    const out = [
      'Tests: 20 total | 20 passed | 0 failed | 0 skipped',
      'BUILD FAILED in 791ms',
      '[NOTICE] Gradle exited with code 1 but all 20 tasks passed individually.',
    ].join('\n');
    const r = parseScriptOutput(out, '', []);
    // Deprecation went to warnings, BUILD FAILED was suppressed in errors.
    expect(r.warnings.some(w => w.code === 'gradle_deprecation')).toBe(true);
    expect(r.errors.find(e => /BUILD FAILED/.test(e.message))).toBeUndefined();
  });

  it('still surfaces BUILD FAILED in errors[] when there is no deprecation notice', () => {
    const out = 'Tests: 20 total | 18 passed | 2 failed | 0 skipped\nBUILD FAILED in 1s';
    const r = parseScriptOutput(out, '', []);
    expect(r.errors.some(e => /BUILD FAILED/.test(e.message))).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('warnings[] defaults to [] when no notice is present', () => {
    const r = parseScriptOutput('BUILD SUCCESSFUL', '', []);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('also recognizes the legacy `[!]` prefix variant', () => {
    // Pre-v0.5 scripts emitted `[!]` for the same notice. Anyone running an
    // older script via direct invocation should still see the warning.
    const out = '[!] Gradle exited with code 1 but all 5 tasks passed individually.';
    const r = parseScriptOutput(out, '', []);
    expect(r.warnings[0]?.code).toBe('gradle_deprecation');
  });

  it('does NOT add the parse-gap error when only a deprecation notice is present', () => {
    const out = '[NOTICE] Gradle exited with code 1 but all 5 tasks passed individually.';
    const r = parseScriptOutput(out, '', []);
    expect(r.errors.find(e => /no recognizable/.test(e.message))).toBeUndefined();
  });
});

describe('buildJsonReport / envErrorJson / buildDryRunReport — warnings[] in shape', () => {
  it('buildJsonReport always emits warnings: [] in the envelope', () => {
    const parsed = parseScriptOutput('BUILD SUCCESSFUL', '', []);
    const obj = buildJsonReport({
      subcommand: 'parallel', projectRoot: '/x', exitCode: 0, durationMs: 0, parsed,
    });
    expect(obj).toHaveProperty('warnings');
    expect(Array.isArray(obj.warnings)).toBe(true);
  });

  it('buildJsonReport surfaces parsed.warnings when present', () => {
    const parsed = parseScriptOutput(
      '[NOTICE] Gradle exited with code 1 but all 3 tasks passed individually.', '', []);
    const obj = buildJsonReport({
      subcommand: 'parallel', projectRoot: '/x', exitCode: 0, durationMs: 0, parsed,
    });
    expect(obj.warnings[0].code).toBe('gradle_deprecation');
  });

  it('envErrorJson emits warnings: [] for shape consistency', () => {
    const obj = envErrorJson({
      subcommand: 'parallel', projectRoot: '/x', durationMs: 0, message: 'no gradlew',
    });
    expect(obj).toHaveProperty('warnings');
    expect(obj.warnings).toEqual([]);
  });

  it('buildDryRunReport emits warnings: [] for shape consistency', () => {
    const obj = buildDryRunReport({ subcommand: 'parallel', projectRoot: '/x', plan: {} });
    expect(obj).toHaveProperty('warnings');
    expect(obj.warnings).toEqual([]);
  });
});

// ============================================================================
// Per-subcommand JSON envelope parsing (v0.5.1 — Bug G fix)
// ============================================================================

describe('parseScriptOutput — android subcommand summary', () => {
  it('parses === JSON SUMMARY === into tests + modules + per-failed-module errors', () => {
    const summary = {
      timestamp: '2026-04-27_10:00:00',
      device: 'emulator-5554',
      packageName: 'com.example.app',
      totalModules: 2,
      passedModules: 1,
      failedModules: 1,
      totalTests: 25,
      passedTests: 23,
      failedTests: 2,
      logsDir: 'androidtest-logs/2026-04-27_10:00:00',
      modules: [
        {
          name: 'core:db', status: 'PASS', duration: '01:30',
          testsPassed: 20, testsFailed: 0, testsSkipped: 1,
          logFile: 'androidtest-logs/2026-04-27_10:00:00/core_db.log',
          logcatFile: 'androidtest-logs/2026-04-27_10:00:00/core_db_logcat.log',
          errorsFile: null, retried: false,
        },
        {
          name: 'core:net', status: 'FAIL', duration: '00:45',
          testsPassed: 3, testsFailed: 2, testsSkipped: 0,
          logFile: 'androidtest-logs/2026-04-27_10:00:00/core_net.log',
          logcatFile: 'androidtest-logs/2026-04-27_10:00:00/core_net_logcat.log',
          errorsFile: 'androidtest-logs/2026-04-27_10:00:00/core_net_errors.json',
          retried: false,
        },
      ],
    };
    const stdout = `Test run starting...\n\n=== JSON SUMMARY ===\n${JSON.stringify(summary, null, 2)}\n\nBUILD FAILED - 1 module(s) failed\n`;
    const r = parseScriptOutput(stdout, '', [], 'android');
    expect(r.tests).toEqual({ total: 25, passed: 23, failed: 2, skipped: 1 });
    expect(r.modules).toEqual(['core:db', 'core:net']);
    const failed = r.errors.find(e => e.code === 'module_failed');
    expect(failed).toBeDefined();
    expect(failed.module).toBe('core:net');
    expect(failed.log_file).toBe('androidtest-logs/2026-04-27_10:00:00/core_net.log');
    expect(failed.logcat_file).toBe('androidtest-logs/2026-04-27_10:00:00/core_net_logcat.log');
    expect(failed.errors_file).toBe('androidtest-logs/2026-04-27_10:00:00/core_net_errors.json');
  });

  it('falls back to [PASS]/[FAIL] table when the JSON SUMMARY block is missing', () => {
    const stdout = [
      'Test run starting...',
      '  [PASS] core:db                (01:30) - 20 tests',
      '  [FAIL] core:net               (00:45) - 5 tests, 2 failed',
      'BUILD FAILED',
    ].join('\n');
    const r = parseScriptOutput(stdout, '', [], 'android');
    expect(r.modules).toEqual(['core:db', 'core:net']);
    const failed = r.errors.find(e => e.code === 'module_failed');
    expect(failed).toBeDefined();
    expect(failed.module).toBe('core:net');
  });

  it('emits json_summary_parse_failed warning when the JSON SUMMARY block is malformed', () => {
    const stdout = '=== JSON SUMMARY ===\n{ this is not valid JSON\n';
    const r = parseScriptOutput(stdout, '', [], 'android');
    expect(r.warnings.some(w => w.code === 'json_summary_parse_failed')).toBe(true);
  });
});

describe('parseScriptOutput — benchmark subcommand summary', () => {
  it('parses [OK]/[FAIL] per-module markers + Result tally + emits top-level benchmark field', () => {
    const stdout = [
      '  [>>] core:jvm-perf (jvm) -> :core:jvm-perf:desktopBench',
      '  [OK] core:jvm-perf (jvm) completed successfully.',
      '  [>>] core:android-bench (android) -> :core:android-bench:androidBench',
      '  [FAIL] core:android-bench (android) failed with exit code 1.',
      '',
      'Result: 1 passed, 1 failed',
    ].join('\n');
    const r = parseScriptOutput(stdout, '', [], 'benchmark');
    expect(r.tests).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(r.modules).toEqual(['core:jvm-perf', 'core:android-bench']);
    expect(r.benchmark).toEqual({ config: null, total: 2, passed: 1, failed: 1 });
    const failed = r.errors.find(e => e.code === 'module_failed');
    expect(failed).toBeDefined();
    expect(failed.module).toBe('core:android-bench');
    expect(failed.platform).toBe('android');
  });

  it('reads --config value from args into benchmark.config', () => {
    const stdout = [
      '  [OK] core:bench (jvm) completed successfully.',
      'Result: 1 passed, 0 failed',
    ].join('\n');
    const r = parseScriptOutput(stdout, '', ['--config', 'main'], 'benchmark');
    expect(r.benchmark.config).toBe('main');
    expect(r.benchmark.passed).toBe(1);
  });
});

describe('parseScriptOutput — error code discriminators', () => {
  it('extracts code "task_not_found" from "Cannot locate tasks" gradle error', () => {
    const stderr = "Cannot locate tasks that match ':core-encryption:connectedDebugAndroidTest' as task 'connectedDebugAndroidTest' not found in project ':core-encryption'.";
    const r = parseScriptOutput('', stderr, [], 'android');
    const tnf = r.errors.find(e => e.code === 'task_not_found');
    expect(tnf).toBeDefined();
    expect(tnf.message).toMatch(/Cannot locate tasks/);
  });

  it('extracts code "unsupported_class_version" with class_file_version + runtime_version captured', () => {
    const stderr = 'java.lang.UnsupportedClassVersionError: org/openjdk/jmh/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0';
    const r = parseScriptOutput('Result: 0 passed, 1 failed', stderr, [], 'benchmark');
    const ucv = r.errors.find(e => e.code === 'unsupported_class_version');
    expect(ucv).toBeDefined();
    expect(ucv.class_file_version).toBe(65);
    expect(ucv.runtime_version).toBe(61);
  });
});

describe('parseScriptOutput — subcommand-aware fallback', () => {
  it('android: does NOT add parse-gap error when [FAIL] markers are seen but no JSON SUMMARY', () => {
    const stdout = '  [FAIL] core:net (00:45) - 5 tests, 2 failed';
    const r = parseScriptOutput(stdout, '', [], 'android');
    expect(r.errors.find(e => /no recognizable/.test(e.message))).toBeUndefined();
    expect(r.errors.some(e => e.code === 'module_failed')).toBe(true);
  });
});

describe('buildJsonReport — optional benchmark field', () => {
  it('forwards parsed.benchmark only when present (omitted on non-benchmark subcommands)', () => {
    const parsedNoBench = parseScriptOutput('BUILD SUCCESSFUL', '', [], 'parallel');
    const objNoBench = buildJsonReport({
      subcommand: 'parallel', projectRoot: '/x', exitCode: 0, durationMs: 0, parsed: parsedNoBench,
    });
    expect(objNoBench).not.toHaveProperty('benchmark');

    const stdout = '[OK] mod (jvm) completed successfully.\nResult: 1 passed, 0 failed';
    const parsedBench = parseScriptOutput(stdout, '', ['--config', 'main'], 'benchmark');
    const objBench = buildJsonReport({
      subcommand: 'benchmark', projectRoot: '/x', exitCode: 0, durationMs: 0, parsed: parsedBench,
    });
    expect(objBench.benchmark).toEqual({ config: 'main', total: 1, passed: 1, failed: 0 });
  });
});

// ============================================================================
// --exclude-modules / --include-untested passthrough (v0.5.0 — Bug B fix)
// ============================================================================

describe('main() — --exclude-modules / --include-untested passthrough', () => {
  it('parallel + --exclude-modules passes the value through to the script', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel',
        '--exclude-modules', '*:api,build-logic', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      const argList = scriptCall[1].map(String);
      const i = argList.findIndex(a => a === '--exclude-modules' || a === '-ExcludeModules');
      expect(i).toBeGreaterThan(-1);
      expect(argList[i + 1]).toBe('*:api,build-logic');
    });
  });

  it('parallel + --include-untested reaches the script as a switch', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel',
        '--include-untested', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      const argList = scriptCall[1].map(String);
      expect(argList.some(a => a === '--include-untested' || a === '-IncludeUntested'))
        .toBe(true);
    });
  });

  it('changed + --exclude-modules + --include-untested both pass through', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'changed',
        '--exclude-modules', 'api', '--include-untested',
        '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      const argList = scriptCall[1].map(String);
      const ei = argList.findIndex(a => a === '--exclude-modules' || a === '-ExcludeModules');
      expect(ei).toBeGreaterThan(-1);
      expect(argList[ei + 1]).toBe('api');
      expect(argList.some(a => a === '--include-untested' || a === '-IncludeUntested'))
        .toBe(true);
    });
  });

  it('subcommand --help advertises both flags for parallel and changed', () => {
    const writes = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      for (const sub of ['parallel', 'changed']) {
        writes.length = 0;
        process.argv = ['node', 'kmp-test.js', sub, '--help'];
        main();
        const out = writes.join('');
        expect(out).toMatch(/--exclude-modules/);
        expect(out).toMatch(/--include-untested/);
      }
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

// ============================================================================
// JDK toolchain pre-flight gate (v0.5.0 — Bug A fix)
// ============================================================================

// Helper: write a build.gradle.kts with jvmToolchain(N) into a fake project.
function withFakeKmpProject(jvmVersion, fn) {
  withFakeGradleProject(dir => {
    writeFileSync(path.join(dir, 'build.gradle.kts'),
      `kotlin {\n    jvmToolchain(${jvmVersion})\n}\n`);
    fn(dir);
  });
}

// Helper: make spawnMock return a `java -version` stderr line for the given major.
function mockJavaVersion(major) {
  spawnMock.mockImplementation((cmd) => {
    if (cmd === 'java') {
      return { status: 0, stdout: '', stderr: `openjdk version "${major}.0.1" 2024-01-16\n` };
    }
    return { status: 0 };
  });
}

describe('getIgnoreJdkMismatch', () => {
  it('returns false when flag absent', () => {
    expect(getIgnoreJdkMismatch(['--project-root', '/x'])).toBe(false);
  });
  it('returns true when flag present', () => {
    expect(getIgnoreJdkMismatch(['--ignore-jdk-mismatch', '--project-root', '/x'])).toBe(true);
  });
  it('returns true regardless of position', () => {
    expect(getIgnoreJdkMismatch(['--project-root', '/x', '--ignore-jdk-mismatch'])).toBe(true);
  });
});

describe('findRequiredJdkVersion', () => {
  it('extracts N from jvmToolchain(N) in build.gradle.kts at the root', () => {
    withFakeKmpProject(17, dir => {
      expect(findRequiredJdkVersion(dir)).toBe(17);
    });
  });
  it('returns null when no JDK signal found anywhere', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
      expect(findRequiredJdkVersion(dir)).toBeNull();
    });
  });
  it('walks subdirectories to find a nested jvmToolchain', () => {
    withFakeGradleProject(dir => {
      const sub = path.join(dir, 'core', 'json');
      mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(sub, 'build.gradle.kts'),
        'kotlin { jvmToolchain(21) }\n');
      expect(findRequiredJdkVersion(dir)).toBe(21);
    });
  });
  it('skips build/, .gradle/, node_modules/ when walking', () => {
    withFakeGradleProject(dir => {
      const skipped = path.join(dir, 'build', 'extracted');
      mkdirSync(skipped, { recursive: true });
      writeFileSync(path.join(skipped, 'build.gradle.kts'),
        'kotlin { jvmToolchain(99) }\n');
      // No real signal anywhere except inside build/ — must return null.
      expect(findRequiredJdkVersion(dir)).toBeNull();
    });
  });

  it('detects JvmTarget.JVM_N in convention plugins under build-logic/', () => {
    // Real-world case (v0.5.1 Bug F): a project with no jvmToolchain anywhere
    // but its KmpBenchmarkConventionPlugin sets jvmTarget = JvmTarget.JVM_21,
    // which makes the compiled bytecode require JDK 21+ at runtime.
    withFakeGradleProject(dir => {
      const conv = path.join(dir, 'build-logic', 'src', 'main', 'kotlin');
      mkdirSync(conv, { recursive: true });
      writeFileSync(path.join(conv, 'KmpBenchmarkConventionPlugin.kt'),
        'import org.jetbrains.kotlin.gradle.dsl.JvmTarget\n\n' +
        'class KmpBenchmarkConventionPlugin {\n' +
        '  fun apply() {\n' +
        '    jvm("desktop") { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }\n' +
        '  }\n}\n');
      expect(findRequiredJdkVersion(dir)).toBe(21);
    });
  });

  it('detects JavaVersion.VERSION_N in compileOptions blocks (Android source/target compatibility)', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, 'build.gradle.kts'),
        'android {\n' +
        '  compileOptions {\n' +
        '    sourceCompatibility = JavaVersion.VERSION_17\n' +
        '    targetCompatibility = JavaVersion.VERSION_17\n' +
        '  }\n}\n');
      expect(findRequiredJdkVersion(dir)).toBe(17);
    });
  });

  it('returns the MAXIMUM across mixed signals (jvmToolchain 17 + JvmTarget.JVM_21 → 21)', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, 'build.gradle.kts'),
        'kotlin {\n' +
        '  jvmToolchain(17)\n' +
        '  jvm("desktop") { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }\n' +
        '}\n');
      expect(findRequiredJdkVersion(dir)).toBe(21);
    });
  });

  it('Phase 4 step 3: delegates to aggregateJdkSignals (returns min)', async () => {
    // The function is now a thin wrapper around lib/project-model.js#aggregateJdkSignals.
    // Verify both produce the same result for a non-trivial fixture so any
    // regression that reinstates the inline walker is caught immediately.
    const { aggregateJdkSignals } = await import('../../lib/project-model.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-jdk-deleg-'));
    try {
      writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\n');
      writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\n');
      mkdirSync(path.join(dir, 'build-logic'), { recursive: true });
      writeFileSync(path.join(dir, 'build.gradle.kts'), 'kotlin { jvmToolchain(11) }');
      writeFileSync(path.join(dir, 'build-logic', 'KmpConv.kt'),
        'compilerOptions { jvmTarget.set(JvmTarget.JVM_21) }');
      const wrapperResult = findRequiredJdkVersion(dir);
      const directResult  = aggregateJdkSignals(dir).min;
      expect(wrapperResult).toBe(directResult);
      expect(wrapperResult).toBe(21);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('jdkMismatchHint', () => {
  it('darwin → /usr/libexec/java_home -v N', () => {
    expect(jdkMismatchHint(17, 'parallel', 'darwin'))
      .toBe('JAVA_HOME=$(/usr/libexec/java_home -v 17) kmp-test parallel');
  });
  it('linux → /usr/lib/jvm/java-N path', () => {
    expect(jdkMismatchHint(17, 'changed', 'linux'))
      .toBe('JAVA_HOME=/usr/lib/jvm/java-17 kmp-test changed');
  });
  it('win32 → $env:JAVA_HOME powershell syntax', () => {
    expect(jdkMismatchHint(17, 'parallel', 'win32'))
      .toBe('$env:JAVA_HOME = "C:\\Program Files\\...\\jdk-17"; kmp-test parallel');
  });
  it('uses the supplied subcommand in the hint', () => {
    expect(jdkMismatchHint(21, 'benchmark', 'linux'))
      .toContain('kmp-test benchmark');
  });
});

describe('preflightJdkCheck', () => {
  it('returns null when no jvmToolchain present in project (no detection possible)', () => {
    withFakeGradleProject(dir => {
      mockJavaVersion(23);
      expect(preflightJdkCheck(dir)).toBeNull();
    });
  });

  it('returns null when gradle.properties has org.gradle.java.home pointing to existing dir', () => {
    withFakeKmpProject(17, dir => {
      // Use the project dir itself as a stand-in for an existing JDK directory.
      writeFileSync(path.join(dir, 'gradle.properties'),
        `org.gradle.java.home=${dir}\n`);
      mockJavaVersion(23);
      // Should bail at gradle.properties check before consulting java -version.
      expect(preflightJdkCheck(dir)).toBeNull();
    });
  });

  it('returns null when gradle.properties path does NOT exist (falls through to java check)', () => {
    withFakeKmpProject(17, dir => {
      writeFileSync(path.join(dir, 'gradle.properties'),
        'org.gradle.java.home=/nonexistent/path/to/jdk\n');
      mockJavaVersion(17); // matches required → null
      expect(preflightJdkCheck(dir)).toBeNull();
    });
  });

  it('returns mismatch info when jvmToolchain != current java major', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      const result = preflightJdkCheck(dir);
      expect(result).toEqual({ required: 17, current: 23 });
    });
  });

  it('returns null when java -version major matches jvmToolchain', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(17);
      expect(preflightJdkCheck(dir)).toBeNull();
    });
  });

  it('returns null when java -version output is unparseable', () => {
    withFakeKmpProject(17, dir => {
      spawnMock.mockReturnValue({ status: 0, stderr: 'garbled noise\n', stdout: '' });
      expect(preflightJdkCheck(dir)).toBeNull();
    });
  });

  it('returns null when `java` is not on PATH (spawnSync errors)', () => {
    withFakeKmpProject(17, dir => {
      spawnMock.mockReturnValue({ status: null, error: { code: 'ENOENT' } });
      expect(preflightJdkCheck(dir)).toBeNull();
    });
  });

  it('handles legacy "1.8" version strings as major 8', () => {
    withFakeKmpProject(8, dir => {
      spawnMock.mockImplementation((cmd) => {
        if (cmd === 'java') {
          return { status: 0, stdout: '', stderr: 'java version "1.8.0_321"\n' };
        }
        return { status: 0 };
      });
      // 1.8 → major 8, equals required → null
      expect(preflightJdkCheck(dir)).toBeNull();
    });
  });
});

describe('main() — JDK gate integration', () => {
  it('mismatch with no opt-out and --no-jdk-autoselect → returns ENV_ERROR (3) and does NOT spawn the script', () => {
    // v0.6.x Gap 2: default behavior now consults the JDK catalogue and
    // auto-selects a matching install. To exercise the gate-fires path
    // explicitly (independent of which JDKs the test host has installed),
    // pass --no-jdk-autoselect.
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      process.argv = ['node', 'kmp-test.js', 'parallel', '--no-jdk-autoselect', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
      // No script spawn happened (only the java -version probe).
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeUndefined();
    });
  });

  it('mismatch + --ignore-jdk-mismatch → proceeds to spawn (flag passes through to script)', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      process.argv = ['node', 'kmp-test.js', 'parallel',
        '--ignore-jdk-mismatch', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      const argList = scriptCall[1].map(String);
      // Flag must reach the script (translated to PascalCase on win32, lowercase otherwise).
      expect(argList.some(a => a === '--ignore-jdk-mismatch' || a === '-IgnoreJdkMismatch'))
        .toBe(true);
    });
  });

  it('no jvmToolchain in project → no gate, proceeds normally', () => {
    withFakeGradleProject(dir => {
      mockJavaVersion(23);
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      main();
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
    });
  });

  it('--json + --no-jdk-autoselect on mismatch → emits jdk_mismatch code with versions in errors[0]', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      const writes = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
      try {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--no-jdk-autoselect', '--project-root', dir];
        expect(main()).toBe(EXIT.ENV_ERROR);
      } finally {
        process.stdout.write = origWrite;
      }
      const jsonLine = writes.find(w => w.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const obj = JSON.parse(jsonLine);
      expect(obj.exit_code).toBe(EXIT.ENV_ERROR);
      expect(obj.errors[0].code).toBe('jdk_mismatch');
      expect(obj.errors[0].required_jdk).toBe(17);
      expect(obj.errors[0].current_jdk).toBe(23);
    });
  });

  // ------------------------------------------------------------------
  // v0.6.x Gap 2 — JDK catalogue auto-selection
  // ------------------------------------------------------------------
  it('catalogue match → auto-selects matching JDK and bypasses gate (Gap 2)', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      // mockJavaVersion replaces all spawn (including the script). Re-arrange
      // so `java -version` returns 23 but the script spawn returns success.
      spawnMock.mockImplementation((cmd) => {
        if (cmd === 'java') {
          return { status: 0, stdout: '', stderr: 'openjdk version "23.0.1" 2024-01-16\n' };
        }
        return { status: 0, stdout: 'BUILD SUCCESSFUL\n', stderr: '' };
      });
      discoverInstalledJdksMock.mockReturnValue([
        { majorVersion: 11, vendor: 'Eclipse Adoptium', path: '/fake/jdk-11' },
        { majorVersion: 17, vendor: 'Eclipse Adoptium', path: '/fake/jdk-17' },
        { majorVersion: 23, vendor: 'Azul Zulu', path: '/fake/jdk-23' },
      ]);
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      const code = main();
      expect(code).toBe(EXIT.SUCCESS);
      // The script call carried a JAVA_HOME env override.
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      const opts = scriptCall[2];
      expect(opts.env).toBeTruthy();
      expect(opts.env.JAVA_HOME).toBe('/fake/jdk-17');
      // PATH prefix is `path.join(JAVA_HOME, 'bin') + path.delimiter`. Use
      // path.join + path.delimiter for cross-platform parity (Windows
      // substitutes \ for / and uses ; not :).
      expect(opts.env.PATH.startsWith(path.join('/fake/jdk-17', 'bin') + path.delimiter)).toBe(true);
    });
  });

  it('--java-home overrides catalogue auto-select (Gap 2)', () => {
    withFakeKmpProject(17, dir => {
      spawnMock.mockImplementation((cmd) => {
        if (cmd === 'java') {
          return { status: 0, stdout: '', stderr: 'openjdk version "23.0.1" 2024-01-16\n' };
        }
        return { status: 0, stdout: 'BUILD SUCCESSFUL\n', stderr: '' };
      });
      discoverInstalledJdksMock.mockReturnValue([
        { majorVersion: 17, vendor: 'Catalogue', path: '/from/catalogue' },
      ]);
      process.argv = ['node', 'kmp-test.js', 'parallel',
        '--java-home', '/explicit/user/jdk-17', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      const scriptCall = spawnMock.mock.calls.find(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(scriptCall).toBeTruthy();
      expect(scriptCall[2].env.JAVA_HOME).toBe('/explicit/user/jdk-17');
    });
  });

  it('--no-jdk-autoselect prevents catalogue lookup → gate fires (Gap 2)', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      // Even if catalogue HAS a match, --no-jdk-autoselect disables the lookup.
      discoverInstalledJdksMock.mockReturnValue([
        { majorVersion: 17, vendor: 'Eclipse Adoptium', path: '/would-match' },
      ]);
      process.argv = ['node', 'kmp-test.js', 'parallel', '--no-jdk-autoselect', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
      // Catalogue MUST NOT be consulted (the flag short-circuits before discoverInstalledJdks runs).
      expect(discoverInstalledJdksMock).not.toHaveBeenCalled();
    });
  });

  it('catalogue empty (no installs) → gate fires as today (Gap 2)', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      discoverInstalledJdksMock.mockReturnValue([]);
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
      expect(discoverInstalledJdksMock).toHaveBeenCalled();
    });
  });

  it('catalogue has only non-matching versions → gate fires (Gap 2)', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      discoverInstalledJdksMock.mockReturnValue([
        { majorVersion: 11, vendor: 'Adoptium', path: '/fake/jdk-11' },
        { majorVersion: 23, vendor: 'Zulu', path: '/fake/jdk-23' },
      ]);
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
    });
  });

  it('--dry-run BYPASSES the gate (planning is safe even on a mismatched JDK)', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      const ranScript = spawnMock.mock.calls.some(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(ranScript).toBe(false);
    });
  });

  it('--dry-run --json on mismatched JDK emits a plan, NOT a jdk_mismatch error', () => {
    withFakeKmpProject(17, dir => {
      mockJavaVersion(23);
      const writes = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
      try {
        process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--json', '--project-root', dir];
        expect(main()).toBe(EXIT.SUCCESS);
      } finally {
        process.stdout.write = origWrite;
      }
      const json = JSON.parse(writes.join('').trim());
      expect(json.dry_run).toBe(true);
      expect(json.exit_code).toBe(0);
      expect(json.plan).toBeTypeOf('object');
      expect(Array.isArray(json.errors) ? json.errors : []).toHaveLength(0);
    });
  });
});

// ============================================================================
// Concurrency Tier 1 (v0.3.8+): lockfile + --force + run-id
// ============================================================================

// PID 999999999 is well outside any OS PID range — process.kill(pid, 0)
// reliably throws ESRCH, giving a deterministic "dead PID" for tests.
const DEAD_PID = 999999999;

describe('consumeForceFlag', () => {
  it('strips --force and reports true', () => {
    const { args, force } = consumeForceFlag(['--force', '--project-root', '/x']);
    expect(force).toBe(true);
    expect(args).toEqual(['--project-root', '/x']);
  });
  it('passes through unchanged when absent', () => {
    const { args, force } = consumeForceFlag(['--project-root', '/x']);
    expect(force).toBe(false);
    expect(args).toEqual(['--project-root', '/x']);
  });
  it('handles --force at any position', () => {
    expect(consumeForceFlag(['parallel', '--force']).force).toBe(true);
    expect(consumeForceFlag(['--force', 'parallel']).force).toBe(true);
    expect(consumeForceFlag(['parallel', '--json', '--force']).force).toBe(true);
  });
});

describe('lockfilePath', () => {
  it('returns <projectRoot>/.kmp-test-runner.lock', () => {
    const got = lockfilePath('/abs/proj');
    expect(got.endsWith('.kmp-test-runner.lock')).toBe(true);
    expect(got.includes('proj')).toBe(true);
  });
});

describe('isPidAlive', () => {
  it('returns true for current process PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('returns false for clearly-dead PID', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });
  it('returns false for non-numeric / invalid input', () => {
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(undefined)).toBe(false);
    expect(isPidAlive('123')).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });
});

describe('readLockfile / writeLockfile / removeLockfile round-trip', () => {
  it('returns null when no lockfile exists', () => {
    withFakeGradleProject(dir => {
      expect(readLockfile(dir)).toBeNull();
    });
  });

  it('write → read produces the same shape with required keys', () => {
    withFakeGradleProject(dir => {
      const written = writeLockfile(dir, 'parallel');
      const read = readLockfile(dir);
      expect(read).toEqual(written);
      expect(read.schema).toBe(1);
      expect(read.pid).toBe(process.pid);
      expect(read.subcommand).toBe('parallel');
      expect(read.project_root).toBe(dir);
      expect(typeof read.start_time).toBe('string');
      expect(new Date(read.start_time).toString()).not.toBe('Invalid Date');
      expect(typeof read.version).toBe('string');
    });
  });

  it('returns {invalid:true} on unparseable JSON', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, '.kmp-test-runner.lock'), 'not-json{', 'utf8');
      expect(readLockfile(dir)).toEqual({ invalid: true });
    });
  });

  it('removeLockfile deletes the file and is idempotent', () => {
    withFakeGradleProject(dir => {
      writeLockfile(dir, 'parallel');
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(true);
      removeLockfile(dir);
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(false);
      // Calling again on missing lock must not throw.
      expect(() => removeLockfile(dir)).not.toThrow();
    });
  });
});

describe('acquireLock', () => {
  it('fresh acquire when no prior lock', () => {
    withFakeGradleProject(dir => {
      const r = acquireLock(dir, 'parallel', { force: false });
      expect(r.ok).toBe(true);
      expect(r.reclaimed).toBeUndefined();
      expect(r.forced).toBeUndefined();
      expect(r.ourLock.pid).toBe(process.pid);
    });
  });

  it('refuses with lock_held when existing lock has live PID and no --force', () => {
    withFakeGradleProject(dir => {
      // Pre-write a lock with our own PID (definitely alive).
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: false });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('lock_held');
      expect(r.existing.pid).toBe(process.pid);
      expect(r.existing.subcommand).toBe('parallel');
    });
  });

  it('reclaims when existing lock has dead PID', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: DEAD_PID, start_time: '2026-04-26T00:00:00.000Z',
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: false });
      expect(r.ok).toBe(true);
      expect(r.reclaimed).toBe(true);
      expect(r.ourLock.pid).toBe(process.pid);
      expect(r.ourLock.subcommand).toBe('changed');
    });
  });

  it('--force bypasses a live lock and writes our own', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: true });
      expect(r.ok).toBe(true);
      expect(r.forced).toBe(true);
      expect(r.existing).toBeTruthy();
      expect(r.ourLock.subcommand).toBe('changed');
      // On disk, the new lock should reflect 'changed', not the original 'parallel'.
      const onDisk = readLockfile(dir);
      expect(onDisk.subcommand).toBe('changed');
    });
  });

  it('reclaims unparseable lockfile', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, '.kmp-test-runner.lock'), 'garbage{', 'utf8');
      const r = acquireLock(dir, 'parallel', { force: false });
      expect(r.ok).toBe(true);
      expect(r.ourLock.pid).toBe(process.pid);
    });
  });

  it('returns write_error when target dir does not exist', () => {
    const ghost = path.join(tmpdir(), 'kmp-no-such-dir-' + Date.now());
    const r = acquireLock(ghost, 'parallel', { force: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('write_error');
    expect(r.error).toBeTruthy();
  });
});

describe('lockAgeLabel', () => {
  it('formats sub-minute as "Ns"', () => {
    const t = new Date(Date.now() - 5_000).toISOString();
    expect(lockAgeLabel(t)).toMatch(/^\ds$/);
  });
  it('formats sub-hour as "NmMs"', () => {
    const t = new Date(Date.now() - (3 * 60 + 12) * 1000).toISOString();
    expect(lockAgeLabel(t)).toBe('3m12s');
  });
  it('formats over-hour as "NhMm"', () => {
    const t = new Date(Date.now() - (2 * 3600 + 17 * 60) * 1000).toISOString();
    expect(lockAgeLabel(t)).toBe('2h17m');
  });
  it('returns "?" for unparseable input', () => {
    expect(lockAgeLabel('not-a-date')).toBe('?');
    expect(lockAgeLabel(null)).toBe('?');
  });
});

describe('main() — lockfile integration', () => {
  it('cleans up lockfile after a successful spawn', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      main();
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(false);
    });
  });

  it('refuses to spawn when a live lock is held (no --force)', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.ENV_ERROR);
      // Spawn must NOT have run for the script.
      const ranScript = spawnMock.mock.calls.some(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(ranScript).toBe(false);
      // The original lock must remain (we did not steal it).
      const onDisk = readLockfile(dir);
      expect(onDisk.subcommand).toBe('parallel');
      expect(onDisk.pid).toBe(process.pid);
    });
  });

  it('lock_held in --json mode emits errors[].code = "lock_held"', () => {
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      withFakeGradleProject(dir => {
        writeFileSync(
          path.join(dir, '.kmp-test-runner.lock'),
          JSON.stringify({
            schema: 1, pid: process.pid, start_time: new Date().toISOString(),
            subcommand: 'parallel', project_root: dir, version: '0.3.8',
          }),
          'utf8',
        );
        process.argv = ['node', 'kmp-test.js', 'parallel', '--json', '--project-root', dir];
        expect(main()).toBe(EXIT.ENV_ERROR);
      });
    } finally {
      process.stdout.write = origWrite;
    }
    const obj = JSON.parse(captured.join('').trim());
    expect(obj.exit_code).toBe(EXIT.ENV_ERROR);
    expect(obj.errors[0].code).toBe('lock_held');
    expect(obj.errors[0].message).toMatch(/already running/);
  });

  it('--force bypasses live lock and proceeds to spawn', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      process.argv = ['node', 'kmp-test.js', 'parallel', '--force', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      const ranScript = spawnMock.mock.calls.some(
        c => c[1]?.some(a => String(a).endsWith('.sh') || String(a).endsWith('.ps1'))
      );
      expect(ranScript).toBe(true);
      // Lock cleaned up after spawn.
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(false);
    });
  });

  it('--force placed before subcommand is also recognized', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      process.argv = ['node', 'kmp-test.js', '--force', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
    });
  });

  it('stale lock (dead PID) is reclaimed automatically — no --force needed', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: DEAD_PID, start_time: '2026-01-01T00:00:00.000Z',
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      // Lock cleaned up after spawn.
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(false);
    });
  });

  it('--dry-run does NOT acquire a lock', () => {
    withFakeGradleProject(dir => {
      process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      // Lockfile must not be present after dry-run.
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(false);
    });
  });

  it('--dry-run does NOT block on existing live lock (read-only operation)', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      process.argv = ['node', 'kmp-test.js', 'parallel', '--dry-run', '--project-root', dir];
      expect(main()).toBe(EXIT.SUCCESS);
      // Original lock untouched.
      expect(readLockfile(dir).pid).toBe(process.pid);
    });
  });

  it('doctor does NOT acquire a lock even with one present', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      process.argv = ['node', 'kmp-test.js', 'doctor', '--project-root', dir];
      // doctor exits with 0 or ENV_ERROR depending on env, but must not be lock_held.
      const code = main();
      expect([EXIT.SUCCESS, EXIT.ENV_ERROR]).toContain(code);
      // Original lock untouched (we never wrote/removed it).
      expect(readLockfile(dir).subcommand).toBe('parallel');
    });
  });
});

// ---------------------------------------------------------------------------
// v0.5.1 Phase 2+3 — coverage layer (Bugs B''/E/C') + android task probe (B')
// ---------------------------------------------------------------------------
describe('parseScriptOutput — v0.5.1 coverage layer (Bugs E + C\')', () => {
  it('Bug E: emits warnings[].code = "no_coverage_data" when banner present', () => {
    const out = [
      'Tests: 5 total | 5 passed | 0 failed | 0 skipped',
      '[!] No coverage data collected from any module — verify your project has kover/jacoco configured (see https://github.com/oscardlfr/kmp-test-runner#coverage-setup)',
      'COVERAGE_MODULES_CONTRIBUTING: 0',
      'BUILD SUCCESSFUL',
    ].join('\n');
    const r = parseScriptOutput(out, '', []);
    const noData = r.warnings.find(w => w.code === 'no_coverage_data');
    expect(noData).toBeDefined();
    expect(noData.message).toMatch(/No coverage data collected/);
  });

  it('Bug E: populates coverage.modules_contributing from machine marker', () => {
    const out = 'Tests: 1 total | 1 passed | 0 failed | 0 skipped\nCOVERAGE_MODULES_CONTRIBUTING: 7\nBUILD SUCCESSFUL';
    const r = parseScriptOutput(out, '', []);
    expect(r.coverage.modules_contributing).toBe(7);
  });

  it('Bug E: no_coverage_data warning absent when contributing > 0', () => {
    const out = 'Tests: 1 total | 1 passed | 0 failed | 0 skipped\nCOVERAGE_MODULES_CONTRIBUTING: 3\n[OK] Full coverage report generated!\nBUILD SUCCESSFUL';
    const r = parseScriptOutput(out, '', []);
    expect(r.warnings.find(w => w.code === 'no_coverage_data')).toBeUndefined();
    expect(r.coverage.modules_contributing).toBe(3);
  });

  it('Bug C\': captures TWO deprecation warnings (one per pass) when both contexts emit', () => {
    const out = [
      'Tests: 5 total | 5 passed | 0 failed | 0 skipped',
      '[NOTICE] Gradle (tests) exited with code 1 but all 5 tasks passed individually.',
      '         This is likely deprecation warnings (Gradle 9+), not real failures.',
      '[NOTICE] Gradle (coverage) exited with code 1 but all 4 tasks passed individually.',
      '         This is likely deprecation warnings (Gradle 9+), not real failures.',
      'COVERAGE_MODULES_CONTRIBUTING: 4',
      'BUILD SUCCESSFUL',
    ].join('\n');
    const r = parseScriptOutput(out, '', []);
    const deps = r.warnings.filter(w => w.code === 'gradle_deprecation');
    expect(deps).toHaveLength(2);
    expect(deps[0].context).toBe('tests');
    expect(deps[0].tasks_passed).toBe(5);
    expect(deps[1].context).toBe('coverage');
    expect(deps[1].tasks_passed).toBe(4);
  });

  it('Bug C\': captures the optional context tag in the deprecation warning', () => {
    const out = '[NOTICE] Gradle (shared coverage) exited with code 1 but all 3 tasks passed individually.';
    const r = parseScriptOutput(out, '', []);
    const dep = r.warnings.find(w => w.code === 'gradle_deprecation');
    expect(dep).toBeDefined();
    expect(dep.context).toBe('shared coverage');
  });

  it('regression: legacy NOTICE format (no context tag) still parses, no context field set', () => {
    const out = '[NOTICE] Gradle exited with code 1 but all 5 tasks passed individually.';
    const r = parseScriptOutput(out, '', []);
    const dep = r.warnings.find(w => w.code === 'gradle_deprecation');
    expect(dep).toBeDefined();
    expect(dep.tasks_passed).toBe(5);
    expect(dep.context).toBeUndefined();
  });
});

describe('android subcommand — v0.5.1 Bug B\' (--device-task flag)', () => {
  it('--device-task <name> appears in `kmp-test android --help` source', () => {
    // Source-grep via the already-imported `readFileSync` (top of file). Avoids
    // `require()` on this ESM module, which double-loads cli.js and tanks v8
    // coverage for every test in the same file.
    const cliJsPath = path.join(__dirname, '..', '..', 'lib', 'cli.js');
    const cliJs = readFileSync(cliJsPath, 'utf8');
    expect(cliJs).toMatch(/--device-task\s+<name>/);
    expect(cliJs).toMatch(/androidConnectedCheck/);
  });

  it('translateFlagForPowerShell: --device-task -> -DeviceTask', () => {
    expect(translateFlagForPowerShell('--device-task')).toBe('-DeviceTask');
  });
});

