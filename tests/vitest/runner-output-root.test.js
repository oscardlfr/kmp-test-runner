import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as runnerMain } from '../../lib/runner.js';
import { OUTPUT_ROOT_ENV } from '../../lib/project/output-root.js';

const projects = [];
const originalArgv = process.argv;
const originalInternalRoot = process.env[OUTPUT_ROOT_ENV];

function project() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kmp-runner-output-'));
  projects.push(root);
  return root;
}

afterEach(() => {
  process.argv = originalArgv;
  if (originalInternalRoot === undefined) delete process.env[OUTPUT_ROOT_ENV];
  else process.env[OUTPUT_ROOT_ENV] = originalInternalRoot;
  for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('direct runner output-root handoff', () => {
  it('honors the resolved root from the outer CLI before subcommand dispatch', async () => {
    const root = project();
    const external = path.join(project(), 'artifacts');
    process.env[OUTPUT_ROOT_ENV] = external;
    process.argv = ['node', 'runner.js', 'unmigrated', '--project-root', root,
      '--ignore-jdk-mismatch'];
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runnerMain()).rejects.toThrow('exit:2');
    expect(existsSync(path.join(external, '.kmp-test-runner-output-root.json'))).toBe(true);
    expect(existsSync(path.join(root, '.kmp-test-runner'))).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('not yet migrated'));
  });

  it('lets a direct caller override the inherited root with --output-dir', async () => {
    const root = project();
    const inherited = path.join(project(), 'inherited');
    const explicit = path.join(project(), 'explicit');
    process.env[OUTPUT_ROOT_ENV] = inherited;
    process.argv = ['node', 'runner.js', 'unmigrated', '--project-root', root,
      '--ignore-jdk-mismatch', '--output-dir', explicit];
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runnerMain()).rejects.toThrow('exit:2');
    expect(process.env[OUTPUT_ROOT_ENV]).toBe(explicit);
    expect(existsSync(path.join(explicit, '.kmp-test-runner-output-root.json'))).toBe(true);
    expect(existsSync(inherited)).toBe(false);
  });

  it('rejects an unsafe direct --output-dir before dispatch', async () => {
    const root = project();
    process.argv = ['node', 'runner.js', 'unmigrated', '--project-root', root,
      '--ignore-jdk-mismatch', '--output-dir', root];
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runnerMain()).rejects.toThrow('exit:2');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unsafe output root'));
    expect(existsSync(path.join(root, '.kmp-test-runner'))).toBe(false);
  });
});
