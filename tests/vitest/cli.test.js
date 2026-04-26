import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
  getBenchmarkPlatform,
  checkGradlew,
  consumeJsonFlag,
  consumeDryRunFlag,
  consumeForceFlag,
  consumeTestFilter,
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
  resolveAndroidTestFilter,
  resolvePatternForSubcommand,
  runDoctorChecks,
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
  it('returns null/empty input unchanged', () => {
    expect(resolveAndroidTestFilter(null, '/x')).toBeNull();
    expect(resolveAndroidTestFilter('', '/x')).toBe('');
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
