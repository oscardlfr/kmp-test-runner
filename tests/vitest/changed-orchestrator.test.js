// SPDX-License-Identifier: MIT
// Tests for lib/changed-orchestrator.js — v0.8 STRATEGIC PIVOT, sub-entry 2.
//
// Migrates `kmp-test changed` from scripts/sh/run-changed-modules-tests.sh
// (293 LOC) + scripts/ps1/run-changed-modules-tests.ps1 (315 LOC) to Node.
//
// Test surface (acceptance rubric: BACKLOG.md Sub-entry 2):
//   1. git-diff-to-module mapping walks all 18 sourceSetNames from project-model
//   2. WS-4 reproducer (top-level :shared module like Confetti's)
//   3. Nested-module longest-prefix precedence
//   4. --staged-only uses git diff --cached
//   5. Zero changed modules → errors[].code:"no_changed_modules", exit 0
//   6. --show-modules-only short-circuit (no parallel-suite dispatch)
//   7. Multi-module dispatch builds correct --module-filter
//   8. Envelope shape: changed:{detected_modules, staged_only, base_ref}
//   9. --include-shared / SHARED_PROJECT_NAME filter
//   10. Discriminator preempts no_summary fallback
//   11. Banner emission ([OK]/[FAIL]/[SKIP] flow through from parallel suite)
//   12. Non-git directory → no_changed_modules

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runChanged } from '../../lib/changed-orchestrator.js';

const SOURCE_SETS = [
  'test', 'commonTest', 'jvmTest', 'desktopTest',
  'androidUnitTest', 'androidInstrumentedTest', 'androidTest',
  'iosTest', 'nativeTest',
  'jsTest', 'wasmJsTest', 'wasmWasiTest',
  'iosX64Test', 'iosArm64Test', 'iosSimulatorArm64Test',
  'macosTest', 'macosX64Test', 'macosArm64Test',
];

let workDir;

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Build a project with the listed modules. Each gets a build.gradle.kts so
// discoverIncludedModules + the per-module existence check pass.
function makeProject(modules, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-changed-test-'));
  workDir = dir;
  const includes = modules.map(m => `include(":${m}")`).join('\n');
  writeFileSync(path.join(dir, 'settings.gradle.kts'),
    `rootProject.name = "${opts.rootName ?? 'fixture'}"\n${includes}\n`);
  for (const mod of modules) {
    const modDir = path.join(dir, ...mod.split(':'));
    mkdirSync(modDir, { recursive: true });
    writeFileSync(path.join(modDir, 'build.gradle.kts'),
      opts.moduleBuild?.[mod] ?? 'plugins { kotlin("jvm") }\n');
  }
  return dir;
}

// Reusable spawn stub. `git` configures git command responses; `parallelSuite`
// configures the test-suite subprocess output. Every call is recorded for
// assertions.
function makeSpawnStub({ git = {}, parallelSuite = {} } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({
      cmd,
      args: [...args],
      cwd: opts?.cwd ?? null,
      env: opts?.env ?? null,
    });
    if (cmd === 'git') {
      const sub = args[0];
      if (sub === 'rev-parse') {
        return {
          status: git.notRepo ? 128 : 0,
          stdout: git.notRepo ? '' : 'true\n',
          stderr: git.notRepo ? 'fatal: not a git repository\n' : '',
          error: null,
          signal: null,
        };
      }
      if (sub === 'status') {
        return {
          status: 0,
          stdout: git.statusOutput ?? '',
          stderr: '',
          error: null,
          signal: null,
        };
      }
      if (sub === 'diff') {
        return {
          status: 0,
          stdout: git.diffOutput ?? '',
          stderr: '',
          error: null,
          signal: null,
        };
      }
    }
    // Otherwise: assume the parallel-suite subprocess.
    return {
      status: parallelSuite.status ?? 0,
      stdout: parallelSuite.stdout ?? 'BUILD SUCCESSFUL\n',
      stderr: parallelSuite.stderr ?? '',
      error: null,
      signal: null,
    };
  };
  fn.calls = calls;
  return fn;
}

// Render `git status --porcelain` output for a list of file paths (all marked
// as modified `M  <path>`). Mirrors what the bash + ps1 wrappers parse.
function porcelain(files) {
  return files.map(f => ` M ${f}`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Case 1 — WS-4 reproducer: top-level :shared module
// ---------------------------------------------------------------------------
describe('runChanged WS-4 reproducer (top-level :shared module)', () => {
  it('shared/src/commonMain/X.kt → changed.detected_modules:["shared"]', async () => {
    const dir = makeProject(['app', 'shared']);
    // Add the source-set leaf so the file path is structurally valid.
    mkdirSync(path.join(dir, 'shared', 'src', 'commonMain', 'kotlin'), { recursive: true });

    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain(['shared/src/commonMain/kotlin/Model.kt']) },
    });

    const { envelope, exitCode } = await runChanged({
      projectRoot: dir,
      args: ['--show-modules-only'],
      spawn,
    });

    expect(envelope.changed.detected_modules).toEqual(['shared']);
    expect(envelope.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — All 18 sourceSets walk
// ---------------------------------------------------------------------------
describe('runChanged sourceSets walker (closes WS-4)', () => {
  for (const ss of SOURCE_SETS) {
    it(`mod/src/${ss}/X.kt → detected_modules:["mod"]`, async () => {
      const dir = makeProject(['mod']);
      const spawn = makeSpawnStub({
        git: { statusOutput: porcelain([`mod/src/${ss}/kotlin/X.kt`]) },
      });

      const { envelope, exitCode } = await runChanged({
        projectRoot: dir,
        args: ['--show-modules-only'],
        spawn,
      });

      expect(envelope.changed.detected_modules).toEqual(['mod']);
      expect(exitCode).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Case 3 — Nested module longest-prefix precedence
// ---------------------------------------------------------------------------
describe('runChanged nested-module precedence', () => {
  it(':core and :core:domain both included; core/domain/X.kt → :core:domain', async () => {
    const dir = makeProject(['core', 'core:domain']);
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain(['core/domain/src/commonMain/X.kt']) },
    });

    const { envelope } = await runChanged({
      projectRoot: dir,
      args: ['--show-modules-only'],
      spawn,
    });

    expect(envelope.changed.detected_modules).toEqual(['core:domain']);
    expect(envelope.changed.detected_modules).not.toContain('core');
  });
});

// ---------------------------------------------------------------------------
// Case 4 — --staged-only uses git diff --cached
// ---------------------------------------------------------------------------
describe('runChanged --staged-only', () => {
  it('uses git diff --cached --name-only (not git status --porcelain)', async () => {
    const dir = makeProject(['mod']);
    const spawn = makeSpawnStub({
      git: { diffOutput: 'mod/src/jvmTest/X.kt\n' },
    });

    const { envelope } = await runChanged({
      projectRoot: dir,
      args: ['--staged-only', '--show-modules-only'],
      spawn,
    });

    // Find the git diff call.
    const gitCalls = spawn.calls.filter(c => c.cmd === 'git');
    const diffCall = gitCalls.find(c => c.args[0] === 'diff');
    expect(diffCall).toBeDefined();
    expect(diffCall.args).toEqual(['diff', '--cached', '--name-only']);

    // No git status call.
    const statusCall = gitCalls.find(c => c.args[0] === 'status');
    expect(statusCall).toBeUndefined();

    // staged_only flag reflected in envelope.
    expect(envelope.changed.staged_only).toBe(true);
    expect(envelope.changed.detected_modules).toEqual(['mod']);
  });

  it('without --staged-only uses git status --porcelain', async () => {
    const dir = makeProject(['mod']);
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain(['mod/src/jvmTest/X.kt']) },
    });

    const { envelope } = await runChanged({
      projectRoot: dir,
      args: ['--show-modules-only'],
      spawn,
    });

    const gitCalls = spawn.calls.filter(c => c.cmd === 'git');
    const statusCall = gitCalls.find(c => c.args[0] === 'status');
    expect(statusCall).toBeDefined();
    expect(statusCall.args).toEqual(['status', '--porcelain']);
    expect(envelope.changed.staged_only).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — Zero modules → no_changed_modules + exit 0
// ---------------------------------------------------------------------------
describe('runChanged no_changed_modules discriminator', () => {
  it('clean working tree → errors[0].code:"no_changed_modules", exit 0', async () => {
    const dir = makeProject(['mod']);
    const spawn = makeSpawnStub({ git: { statusOutput: '' } });

    const { envelope, exitCode } = await runChanged({
      projectRoot: dir,
      args: [],
      spawn,
    });

    expect(envelope.errors).toHaveLength(1);
    expect(envelope.errors[0].code).toBe('no_changed_modules');
    // Locks the discriminator: must NOT fall through to no_summary fallback.
    expect(envelope.errors.find(e => e.code === 'no_summary')).toBeUndefined();
    expect(envelope.changed.detected_modules).toEqual([]);
    expect(exitCode).toBe(0);

    // No parallel-suite dispatch when zero modules.
    const nonGit = spawn.calls.filter(c => c.cmd !== 'git');
    expect(nonGit).toHaveLength(0);
  });

  it('files only outside any module → no_changed_modules', async () => {
    const dir = makeProject(['mod']);
    const spawn = makeSpawnStub({
      // Root build.gradle.kts + libs.versions.toml — neither lives under :mod.
      git: { statusOutput: porcelain(['build.gradle.kts', 'gradle/libs.versions.toml']) },
    });

    const { envelope, exitCode } = await runChanged({
      projectRoot: dir,
      args: [],
      spawn,
    });

    expect(envelope.errors[0].code).toBe('no_changed_modules');
    expect(envelope.changed.detected_modules).toEqual([]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — --show-modules-only short-circuit
// ---------------------------------------------------------------------------
describe('runChanged --show-modules-only', () => {
  it('detects modules + skips parallel-suite dispatch', async () => {
    const dir = makeProject(['mod-a', 'mod-b']);
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain(['mod-a/src/jvmTest/X.kt', 'mod-b/src/commonTest/Y.kt']) },
      parallelSuite: { stdout: 'SHOULD NOT BE CALLED\n' },
    });

    const { envelope, exitCode } = await runChanged({
      projectRoot: dir,
      args: ['--show-modules-only'],
      spawn,
    });

    expect(envelope.changed.detected_modules.sort()).toEqual(['mod-a', 'mod-b']);

    // Spawn calls: only git, never the parallel suite.
    const nonGit = spawn.calls.filter(c => c.cmd !== 'git');
    expect(nonGit).toHaveLength(0);

    expect(exitCode).toBe(0);
    expect(envelope.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 7 — Multi-module dispatch + --module-filter shape
// ---------------------------------------------------------------------------
// Find the parallel-suite spawn call. The orchestrator picks `bash` on
// Linux/macOS and `powershell` on Windows, with the script path landing at
// different argv positions in each shape — search all args for robustness.
function findSuiteCall(spawn) {
  return spawn.calls.find(c =>
    c.cmd !== 'git' &&
    c.args.some(a => String(a).includes('run-parallel-coverage-suite'))
  );
}

// The PS1 wrapper takes `-ModuleFilter <X>`; the bash wrapper takes
// `--module-filter <X>`. Walk argv for either shape and return the value.
function extractModuleFilter(args) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--module-filter' || args[i] === '-ModuleFilter') {
      return args[i + 1];
    }
  }
  return null;
}

describe('runChanged multi-module dispatch', () => {
  it('passes detected modules as comma-separated --module-filter', async () => {
    const dir = makeProject(['core', 'feature']);
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain([
        'core/src/jvmTest/X.kt',
        'feature/src/commonTest/Y.kt',
      ]) },
      parallelSuite: { stdout: 'BUILD SUCCESSFUL\n' },
    });

    await runChanged({ projectRoot: dir, args: [], spawn });

    const suiteCall = findSuiteCall(spawn);
    expect(suiteCall).toBeDefined();

    const filterValue = extractModuleFilter(suiteCall.args);
    expect(filterValue).not.toBeNull();
    const mods = filterValue.split(',').sort();
    expect(mods).toEqual(['core', 'feature']);
  });
});

// ---------------------------------------------------------------------------
// Case 8 — Envelope shape
// ---------------------------------------------------------------------------
describe('runChanged envelope shape', () => {
  it('emits canonical envelope with changed:{detected_modules, staged_only, base_ref}', async () => {
    const dir = makeProject(['mod']);
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain(['mod/src/jvmTest/X.kt']) },
    });

    const { envelope } = await runChanged({
      projectRoot: dir,
      args: ['--show-modules-only'],
      spawn,
    });

    // Standard envelope keys.
    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.subcommand).toBe('changed');
    expect(envelope.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(envelope.project_root).toBe(dir);
    expect(envelope).toHaveProperty('exit_code');
    expect(envelope).toHaveProperty('duration_ms');
    expect(envelope).toHaveProperty('tests');
    expect(envelope).toHaveProperty('modules');
    expect(envelope).toHaveProperty('skipped');
    expect(envelope).toHaveProperty('coverage');
    expect(envelope).toHaveProperty('errors');
    expect(envelope).toHaveProperty('warnings');

    // Sub-entry 2 additions.
    expect(envelope).toHaveProperty('changed');
    expect(envelope.changed).toHaveProperty('detected_modules');
    expect(envelope.changed).toHaveProperty('staged_only');
    expect(envelope.changed).toHaveProperty('base_ref');
    expect(envelope.changed.base_ref).toBe('HEAD');
    expect(envelope.changed.staged_only).toBe(false);
    expect(envelope.changed.detected_modules).toEqual(['mod']);
  });
});

// ---------------------------------------------------------------------------
// Case 9 — --include-shared / SHARED_PROJECT_NAME filter
// ---------------------------------------------------------------------------
describe('runChanged --include-shared filter', () => {
  it('SHARED_PROJECT_NAME=foo + --include-shared NOT set → drops modules containing "foo"', async () => {
    const dir = makeProject(['app', 'foo-shared']);
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain([
        'app/src/jvmTest/X.kt',
        'foo-shared/src/commonTest/Y.kt',
      ]) },
    });

    const { envelope } = await runChanged({
      projectRoot: dir,
      args: ['--show-modules-only'],
      env: { SHARED_PROJECT_NAME: 'foo' },
      spawn,
    });

    expect(envelope.changed.detected_modules).toEqual(['app']);
    expect(envelope.changed.detected_modules).not.toContain('foo-shared');
  });

  it('SHARED_PROJECT_NAME=foo + --include-shared set → keeps modules containing "foo"', async () => {
    const dir = makeProject(['app', 'foo-shared']);
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain([
        'app/src/jvmTest/X.kt',
        'foo-shared/src/commonTest/Y.kt',
      ]) },
    });

    const { envelope } = await runChanged({
      projectRoot: dir,
      args: ['--include-shared', '--show-modules-only'],
      env: { SHARED_PROJECT_NAME: 'foo' },
      spawn,
    });

    expect(envelope.changed.detected_modules.sort()).toEqual(['app', 'foo-shared']);
  });
});

// ---------------------------------------------------------------------------
// Case 10 — Discriminator preempts no_summary fallback
// ---------------------------------------------------------------------------
describe('runChanged error code discrimination', () => {
  it('parallel-suite output with task_not_found surfaces in errors[].code', async () => {
    const dir = makeProject(['mod']);
    const suiteOutput =
      "FAILURE: Build failed with an exception.\n" +
      "Cannot locate tasks that match ':mod:nonexistentTask' as task 'nonexistentTask' not found in project ':mod'.\n";
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain(['mod/src/jvmTest/X.kt']) },
      parallelSuite: { status: 1, stdout: suiteOutput, stderr: '' },
    });

    const { envelope } = await runChanged({
      projectRoot: dir,
      args: [],
      spawn,
    });

    // task_not_found discriminator should preempt generic no_summary.
    const codes = envelope.errors.map(e => e.code);
    expect(codes).toContain('task_not_found');
    expect(codes).not.toContain('no_summary');
  });
});

// ---------------------------------------------------------------------------
// Case 11 — Banner emission (parallel-suite stdout flows through log())
// ---------------------------------------------------------------------------
describe('runChanged banner emission', () => {
  it('logs "Modules with changes:" header + per-module line', async () => {
    const dir = makeProject(['mod']);
    const banners = [];
    const spawn = makeSpawnStub({
      git: { statusOutput: porcelain(['mod/src/jvmTest/X.kt']) },
    });

    await runChanged({
      projectRoot: dir,
      args: ['--show-modules-only'],
      spawn,
      log: (line) => banners.push(line),
    });

    const joined = banners.join('\n');
    expect(joined).toMatch(/Modules with changes/i);
    expect(joined).toMatch(/mod/);
  });

  it('zero modules emits "No modules with uncommitted changes" banner', async () => {
    const dir = makeProject(['mod']);
    const banners = [];
    const spawn = makeSpawnStub({ git: { statusOutput: '' } });

    await runChanged({
      projectRoot: dir,
      args: [],
      spawn,
      log: (line) => banners.push(line),
    });

    const joined = banners.join('\n');
    expect(joined).toMatch(/No modules with uncommitted changes/i);
  });
});

// ---------------------------------------------------------------------------
// Case 12 — Non-git directory
// ---------------------------------------------------------------------------
describe('runChanged non-git directory', () => {
  it('git rev-parse fails → no_changed_modules with "Not a git repository"', async () => {
    const dir = makeProject(['mod']);
    const spawn = makeSpawnStub({ git: { notRepo: true } });

    const { envelope, exitCode } = await runChanged({
      projectRoot: dir,
      args: [],
      spawn,
    });

    expect(envelope.errors[0].code).toBe('no_changed_modules');
    expect(envelope.errors[0].message).toMatch(/not a git repository/i);
    // Per current bash shape (run-changed-modules-tests.sh:191): exit 1 on non-git.
    // The orchestrator's discriminator promotes via enforceErrorsExitCodeInvariant,
    // but cleanest is to emit ENV_ERROR (3) so agents branch on a meaningful code.
    expect(exitCode).not.toBe(0);
  });
});
