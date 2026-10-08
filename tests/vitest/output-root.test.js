import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMergedConfig } from '../../lib/project-config.js';
import {
  assertOutputRootOwned, extractOutputDir, resolveOutputRoot,
} from '../../lib/project/output-root.js';
import { cleanArtifacts } from '../../lib/project/artifact-sweep.js';
import { runDescribe } from '../../lib/orchestrators/describe-orchestrator.js';
import {
  acquireProjectRunLock, releaseProjectRunLock, hostLockfilePath, lockfilePath,
} from '../../lib/runners/lockfile.js';

const dirs = [];
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kmp-output-root-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('configurable output root', () => {
  it('extracts --output-dir without leaking it into wrapper argv and rejects empty values', () => {
    expect(extractOutputDir(['--module-filter', 'app', '--output-dir=out']))
      .toEqual({ args: ['--module-filter', 'app'], value: 'out', errors: [] });
    expect(extractOutputDir(['--output-dir', '--json']).errors[0]).toMatchObject({
      code: 'invalid_flag_value', flag: '--output-dir',
    });
  });

  it('resolves CLI > env > project config > user preset > default against project root', () => {
    const home = fixture();
    const project = path.join(home, 'project');
    mkdirSync(project);
    mkdirSync(path.join(home, '.kmp-test'));
    writeFileSync(path.join(home, '.kmp-test', 'config.json'), JSON.stringify({
      projects: { fixture: { defaults: { outputDir: 'user-output' } } },
    }));
    const user = loadMergedConfig(project, { homeOverride: home, projectKey: 'fixture' });
    expect(resolveOutputRoot(project, { config: user, env: {} })).toBe(path.join(project, 'user-output'));
    writeFileSync(path.join(project, '.kmp-test-runner.json'), JSON.stringify({ defaults: { outputDir: 'project-output' } }));
    const merged = loadMergedConfig(project, { homeOverride: home, projectKey: 'fixture' });
    expect(resolveOutputRoot(project, { config: merged, env: {} })).toBe(path.join(project, 'project-output'));
    expect(resolveOutputRoot(project, { config: merged, env: { KMP_TEST_OUTPUT_DIR: 'env-output' } }))
      .toBe(path.join(project, 'env-output'));
    expect(resolveOutputRoot(project, { cli: 'cli-output', config: merged,
      env: { KMP_TEST_OUTPUT_DIR: 'env-output' } })).toBe(path.join(project, 'cli-output'));
    expect(resolveOutputRoot(project, { env: {} })).toBe(path.join(project, '.kmp-test-runner'));
  });

  it('rejects roots that could expose project, home, Gradle or filesystem data', () => {
    const project = fixture();
    for (const unsafe of [project, path.dirname(project), os.homedir(),
      path.parse(project).root, path.join(project, 'app', 'build', 'report')]) {
      expect(() => resolveOutputRoot(project, { cli: unsafe, env: {} })).toThrow(/unsafe output root/);
    }
  });

  it('requires project ownership before cleaning a custom root and protects another project', () => {
    const a = fixture();
    const b = fixture();
    const output = path.join(fixture(), 'artifacts');
    mkdirSync(path.join(output, 'logs'), { recursive: true });
    writeFileSync(path.join(output, 'logs', 'unrelated.txt'), 'keep');
    expect(() => assertOutputRootOwned(a, output, { create: true })).toThrow(/unrelated data/);
    expect(() => cleanArtifacts(a, { outputRoot: output, all: true })).toThrow(/ownership marker/);
    expect(readFileSync(path.join(output, 'logs', 'unrelated.txt'), 'utf8')).toBe('keep');
    rmSync(output, { recursive: true });
    assertOutputRootOwned(a, output, { create: true });
    expect(() => assertOutputRootOwned(b, output, { create: true })).toThrow(/different project/);
  });

  it('reports an unsafe describe output root distinctly from project-model errors', () => {
    const project = fixture();
    writeFileSync(path.join(project, 'settings.gradle.kts'), 'rootProject.name = "fixture"');
    const output = path.join(fixture(), 'artifacts');
    mkdirSync(output);
    writeFileSync(path.join(output, 'unrelated.txt'), 'keep');
    const { envelope, exitCode } = runDescribe({ projectRoot: project, outputRoot: output });
    expect(exitCode).toBe(3);
    expect(envelope.errors).toEqual([expect.objectContaining({ code: 'unsafe_output_root' })]);
    expect(readFileSync(path.join(output, 'unrelated.txt'), 'utf8')).toBe('keep');
  });

  it('does not follow symlinked children during clean', () => {
    const project = fixture();
    const outside = fixture();
    const output = path.join(fixture(), 'artifacts');
    assertOutputRootOwned(project, output, { create: true });
    writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
    symlinkSync(outside, path.join(output, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = cleanArtifacts(project, { outputRoot: output, all: true });
    expect(result.removed).not.toContain(path.join(output, 'logs'));
    expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('does not count or remove data reached through a nested symlink during clean', () => {
    const project = fixture();
    const outside = fixture();
    const output = path.join(fixture(), 'artifacts');
    assertOutputRootOwned(project, output, { create: true });
    mkdirSync(path.join(output, 'logs'));
    writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
    symlinkSync(outside, path.join(output, 'logs', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    const planned = cleanArtifacts(project, { outputRoot: output, dryRun: true });
    expect(planned.targets.find(t => t.path === path.join(output, 'logs'))?.bytes).toBe(0);
    cleanArtifacts(project, { outputRoot: output });
    expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('rejects a symlinked parent into the Gradle build tree before creating output', () => {
    const project = fixture();
    const linkParent = fixture();
    const build = path.join(project, 'app', 'build');
    mkdirSync(build, { recursive: true });
    const link = path.join(linkParent, 'alias');
    symlinkSync(build, link, process.platform === 'win32' ? 'junction' : 'dir');
    const output = path.join(link, 'new-artifacts');
    expect(() => assertOutputRootOwned(project, output, { create: true })).toThrow(/unsafe output root/);
    expect(existsSync(path.join(build, 'new-artifacts'))).toBe(false);
  });

  it('refuses to clean a symlinked output root', () => {
    const project = fixture();
    const outside = fixture();
    const root = path.join(project, '.kmp-test-runner');
    mkdirSync(path.join(outside, 'logs'));
    writeFileSync(path.join(outside, 'logs', 'sentinel.txt'), 'keep');
    symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => cleanArtifacts(project, { all: true })).toThrow(/symlink/);
    expect(readFileSync(path.join(outside, 'logs', 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('holds one host lock for a project across output roots and retains legacy lock only for default', () => {
    const project = fixture();
    const first = acquireProjectRunLock(project, 'parallel', { customOutputRoot: true });
    expect(first.ok).toBe(true);
    expect(existsSync(hostLockfilePath(project))).toBe(true);
    expect(existsSync(lockfilePath(project))).toBe(false);
    expect(acquireProjectRunLock(project, 'android', { customOutputRoot: true })).toMatchObject({
      ok: false, reason: 'lock_held',
    });
    expect(acquireProjectRunLock(project, 'android', { customOutputRoot: false })).toMatchObject({
      ok: false, reason: 'lock_held',
    });
    releaseProjectRunLock(project, first);
    const standard = acquireProjectRunLock(project, 'parallel');
    expect(standard.ok).toBe(true);
    expect(existsSync(lockfilePath(project))).toBe(true);
    releaseProjectRunLock(project, standard);
    expect(existsSync(hostLockfilePath(project))).toBe(false);
    expect(existsSync(lockfilePath(project))).toBe(false);
  });

  it('routes a real CLI coverage report through the PowerShell wrapper into --output-dir', () => {
    const project = fixture();
    const output = path.join(fixture(), 'artifacts');
    writeFileSync(path.join(project, 'settings.gradle.kts'), 'rootProject.name = "fixture"\ninclude(":app")\n');
    writeFileSync(path.join(project, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
    writeFileSync(path.join(project, 'gradlew'), '#!/bin/sh\nexit 0\n');
    mkdirSync(path.join(project, 'app', 'build', 'reports', 'kover'), { recursive: true });
    writeFileSync(path.join(project, 'app', 'build.gradle.kts'),
      'plugins { id("org.jetbrains.kotlinx.kover"); kotlin("jvm") }\n');
    const xml = readFileSync(fileURLToPath(new URL('../fixtures/coverage-xml/full-covered.xml', import.meta.url)));
    writeFileSync(path.join(project, 'app', 'build', 'reports', 'kover', 'report.xml'), xml);
    const bin = fileURLToPath(new URL('../../bin/kmp-test.js', import.meta.url));
    const result = spawnSync(process.execPath, [bin, 'coverage', '--project-root', project,
      '--output-dir', output, '--json'], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, KMP_TEST_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.exit_code).toBe(0);
    expect(existsSync(path.join(output, 'reports', 'coverage', 'latest.md'))).toBe(true);
    expect(existsSync(path.join(project, '.kmp-test-runner', 'reports', 'coverage', 'latest.md'))).toBe(false);
  });
});
