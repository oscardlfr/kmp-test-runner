import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runParallel } from '../../lib/orchestrators/parallel-orchestrator.js';
import { runAndroid } from '../../lib/orchestrators/android-orchestrator.js';
import { matchModuleFilter } from '../../lib/orchestrators/module-filter.js';
import { resolveDryRunModules } from '../../lib/parsers/script-output.js';
import { effectiveGradleArgs, isGradleCall } from './_spawn-helpers.js';

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

function project(names, android = false) {
  root = mkdtempSync(path.join(tmpdir(), 'kmp-exact-modules-'));
  writeFileSync(path.join(root, 'settings.gradle.kts'), names.map(name => `include(":${name}")`).join('\n'));
  writeFileSync(path.join(root, 'gradlew'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  for (const name of names) {
    const dir = path.join(root, ...name.split(':'));
    mkdirSync(path.join(dir, 'src', android ? 'androidTest' : 'jvmTest', 'kotlin'), { recursive: true });
    writeFileSync(path.join(dir, 'build.gradle.kts'), android
      ? 'plugins { id("com.android.library") }\nandroid { namespace = "fixture.test" }\n'
      : 'plugins { kotlin("jvm") }\n');
  }
  return root;
}

function spawnStub() {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args: [...args], cwd: options?.cwd });
    return { status: 0, stdout: 'BUILD SUCCESSFUL\n', stderr: '', signal: null, error: null };
  };
  spawn.calls = calls;
  return spawn;
}

const evidenceModules = [
  'core:common', 'core:data', 'core:datastore', 'core:domain', 'core:navigation',
  'core:network', 'feature:bookmarks:impl', 'feature:search:impl',
  'feature:settings:impl', 'feature:topic:impl', 'lint',
];
const overlapModules = ['core:database', 'feature:search:implementation', 'lint:checks'];

describe('exact module dispatch', () => {
  it('reproduces Evidence6 scope: exact 11 tasks while the legacy filter still matches 14', async () => {
    const dir = project([...evidenceModules, ...overlapModules]);
    const selector = evidenceModules.map(name => ':' + name).join(',');
    const legacy = [...evidenceModules, ...overlapModules].filter(name => matchModuleFilter(name, selector));
    expect(legacy).toHaveLength(14);

    const exactSpawn = spawnStub();
    const exact = await runParallel({ projectRoot: dir,
      args: ['--modules', selector, '--no-coverage'], spawn: exactSpawn, log: () => {} });
    expect(exact.envelope.errors).toEqual([]);
    const exactTasks = exactSpawn.calls.filter(isGradleCall)
      .flatMap(call => effectiveGradleArgs(call).filter(arg => arg.endsWith(':jvmTest')));
    expect(new Set(exactTasks)).toEqual(new Set(evidenceModules.map(name => `:${name}:jvmTest`)));
    expect(exactTasks).toHaveLength(11);

    const globSpawn = spawnStub();
    await runParallel({ projectRoot: dir,
      args: ['--module-filter', selector, '--no-coverage'], spawn: globSpawn, log: () => {} });
    const globTasks = globSpawn.calls.filter(isGradleCall)
      .flatMap(call => effectiveGradleArgs(call).filter(arg => arg.endsWith(':jvmTest')));
    expect(globTasks).toHaveLength(14);

    const preview = resolveDryRunModules('parallel', dir, ['--modules', selector]);
    expect(preview.modules.map(module => module.name)).toEqual([...evidenceModules].sort());
  });

  it('reports unknown modules before test-source filtering, and intersects existing filters', async () => {
    const dir = project(['core:data', 'core:domain', 'feature:data']);
    const spawn = spawnStub();
    const unknown = await runParallel({ projectRoot: dir,
      args: ['--modules', ':missing'], spawn, log: () => {} });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.envelope.errors).toMatchObject([{ code: 'unknown_module', module: ':missing' }]);
    expect(spawn.calls.filter(isGradleCall)).toHaveLength(0);
    const ambiguous = await runParallel({ projectRoot: dir,
      args: ['--modules', 'data'], spawn, log: () => {} });
    expect(ambiguous.envelope.errors[0].code).toBe('ambiguous_module');
    const narrowed = await runParallel({ projectRoot: dir,
      args: ['--modules', ':core:data,:core:domain', '--module-filter', ':core',
        '--exclude-modules', ':core:domain', '--list-only'], spawn, log: () => {} });
    expect(narrowed.envelope.modules.map(module => module.name)).toEqual(['core:data']);
    expect(narrowed.envelope.skipped).toContainEqual({ module: 'core:domain', reason: 'excluded by --exclude-modules' });
    expect(resolveDryRunModules('parallel', dir, ['--modules', ':missing']).errors[0].code).toBe('unknown_module');
  });

  it('keeps configured per-leg skip rules effective for an exact selection', async () => {
    const dir = project(['core:data', 'core:domain']);
    const spawn = spawnStub();
    const result = await runParallel({ projectRoot: dir,
      args: ['--modules', ':core:data,:core:domain', '--test-type', 'common', '--no-coverage'],
      env: { ...process.env, SKIP_DESKTOP_MODULES: 'data' }, spawn, log: () => {} });
    const tasks = spawn.calls.filter(isGradleCall)
      .flatMap(call => effectiveGradleArgs(call).filter(arg => arg.startsWith(':')));
    expect(tasks).toEqual([':core:domain:jvmTest']);
    expect(result.envelope.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'core:data' }),
    ]));
  });

  it('applies the same exact names to the dedicated device workflow', async () => {
    const dir = project(['feature:one', 'feature:two', 'other:one'], true);
    const spawn = spawnStub();
    const result = await runAndroid({ projectRoot: dir, args: ['--modules', ':feature:one,:feature:two'],
      spawn, adbProbe: () => [{ serial: 'emulator-5554', state: 'device', type: 'emulator', model: 'sdk' }],
      log: () => {} });
    const tasks = spawn.calls.filter(isGradleCall)
      .flatMap(call => effectiveGradleArgs(call).filter(arg => arg.startsWith(':')));
    expect(tasks).toEqual(expect.arrayContaining([':feature:one:connectedDebugAndroidTest', ':feature:two:connectedDebugAndroidTest']));
    expect(tasks.some(task => task.startsWith(':other:one:'))).toBe(false);
    expect(result.envelope.android.instrumented_modules).toEqual(['feature:one', 'feature:two']);
    const preview = resolveDryRunModules('android', dir, ['--modules', ':feature:one']);
    expect(preview.modules).toEqual(['feature:one']);
  });

  it('limits the parallel Android-instrumented leg to the exact requested modules', async () => {
    const dir = project(['feature:one', 'feature:two', 'other:one'], true);
    const spawn = spawnStub();
    const result = await runParallel({ projectRoot: dir,
      args: ['--modules', ':feature:one,:feature:two', '--test-type', 'androidInstrumented', '--no-coverage'],
      spawn, adbProbe: () => [{ serial: 'emulator-5554', state: 'device', type: 'emulator', model: 'sdk' }],
      log: () => {} });
    const tasks = spawn.calls.filter(isGradleCall)
      .flatMap(call => effectiveGradleArgs(call).filter(arg => arg.includes(':connected')));
    expect(tasks).toEqual(expect.arrayContaining([
      ':feature:one:connectedDebugAndroidTest', ':feature:two:connectedDebugAndroidTest',
    ]));
    expect(tasks).toHaveLength(2);
    expect(result.envelope.errors).toEqual([]);
  });

  it('reports a valid but ineligible device module as a filtered empty set, not an unknown name', async () => {
    const dir = project(['host:only']);
    const result = await runAndroid({ projectRoot: dir, args: ['--modules', ':host:only', '--list-only'],
      spawn: spawnStub(), log: () => {} });
    expect(result.exitCode).toBe(2);
    expect(result.envelope.errors).toMatchObject([{ code: 'no_test_modules', caused_by_filter: true }]);
  });
});
