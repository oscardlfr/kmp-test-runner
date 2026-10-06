import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runChanged } from '../../lib/orchestrators/changed-orchestrator.js';
import { expandDependents, parseDependencyGraph } from '../../lib/orchestrators/changed-dependents.js';

let projectRoot;
afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = null;
});

function git(...args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

function writeModuleFile(module, name, contents) {
  const dir = path.join(projectRoot, module, 'src', 'main');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), contents);
}

function fixture() {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'kmp-changed-base-'));
  writeFileSync(path.join(projectRoot, 'settings.gradle.kts'),
    'include(":core")\ninclude(":consumer")\ninclude(":app")\n');
  for (const module of ['core', 'consumer', 'app']) {
    writeModuleFile(module, 'A.kt', 'class A\n');
    writeFileSync(path.join(projectRoot, module, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
  }
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeModuleFile('core', 'A.kt', 'class A { val changed = 1 }\n');
  git('add', '.');
  git('commit', '-qm', 'change core');
  return base;
}

describe('changed --base', () => {
  it('finds committed changes since merge base plus unstaged and untracked files', async () => {
    const base = fixture();
    writeModuleFile('consumer', 'A.kt', 'class A { val unstaged = 1 }\n');
    writeModuleFile('app', 'New.kt', 'class New\n');
    const result = await runChanged({ projectRoot,
      args: ['--base', base, '--show-modules-only'] });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.changed.base_ref).toBe(base);
    expect(result.envelope.changed.detected_modules).toEqual(['app', 'consumer', 'core']);
  });

  it('--staged-only includes committed and staged changes, but excludes unstaged and untracked', async () => {
    const base = fixture();
    writeModuleFile('consumer', 'A.kt', 'class A { val staged = 1 }\n');
    git('add', 'consumer/src/main/A.kt');
    writeModuleFile('app', 'New.kt', 'class New\n');
    const result = await runChanged({ projectRoot,
      args: ['--base', base, '--staged-only', '--show-modules-only'] });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.changed.detected_modules).toEqual(['consumer', 'core']);
  });

  it('invalid refs fail closed with git_error', async () => {
    fixture();
    const result = await runChanged({ projectRoot,
      args: ['--base', 'not-a-ref', '--show-modules-only'] });
    expect(result.exitCode).toBe(3);
    expect(result.envelope.errors[0].code).toBe('git_error');
    expect(result.envelope.changed.base_ref).toBe('not-a-ref');
  });
});

describe('dependent module graph', () => {
  const output = `noise\nKMP_TEST_DEPENDENCIES_BEGIN\nKMP_TEST_DEPENDENCY\t:consumer\t:core\nKMP_TEST_DEPENDENCY\t:app\t:consumer\nKMP_TEST_DEPENDENCY\t:core\t:app\nKMP_TEST_DEPENDENCIES_END\n`;
  it('expands transitively, terminates on cycles, and excludes the direct module', () => {
    const graph = parseDependencyGraph(output, ['core', 'consumer', 'app']);
    expect(expandDependents(['core'], graph)).toEqual(['app', 'consumer']);
  });

  it('includes dependents in dispatch while keeping detected_modules direct', async () => {
    const base = fixture();
    const calls = [];
    const spawn = (cmd, args, options) => {
      if (cmd === 'git') return spawnSync(cmd, args, options);
      calls.push({ cmd, args });
      return { status: 0, stdout: output, stderr: '' };
    };
    let parallelArgs;
    let exactModuleNames;
    const result = await runChanged({ projectRoot,
      args: ['--base', base, '--include-dependents', '--flavor', 'demo'],
      spawn,
      runParallelInjection: async ({ args, exactModuleNames: selected }) => {
        parallelArgs = args;
        exactModuleNames = selected;
        return { exitCode: 0, envelope: { tests: {}, modules: [], skipped: [],
          coverage: {}, errors: [], warnings: [] } };
      } });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.changed.detected_modules).toEqual(['core']);
    expect(result.envelope.changed.dependent_modules).toEqual(['app', 'consumer']);
    expect(result.envelope.changed.selected_modules).toEqual(['app', 'consumer', 'core']);
    expect(parallelArgs[parallelArgs.indexOf('--module-filter') + 1]).toBe('app,consumer,core');
    expect(exactModuleNames).toEqual(['app', 'consumer', 'core']);
    expect(parallelArgs[parallelArgs.indexOf('--flavor') + 1]).toBe('demo');
    expect(calls).toHaveLength(1);
  });

  it('fails closed when Gradle cannot provide the graph', async () => {
    const base = fixture();
    const spawn = (cmd, args, options) => cmd === 'git'
      ? spawnSync(cmd, args, options)
      : { status: 1, stdout: '', stderr: 'configuration failed' };
    const result = await runChanged({ projectRoot,
      args: ['--base', base, '--include-dependents', '--show-modules-only'], spawn });
    expect(result.exitCode).toBe(3);
    expect(result.envelope.errors[0].code).toBe('dependency_graph_unavailable');
  });
});
