import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../../lib/cli.js';

let root;
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function fixture() {
  root = mkdtempSync(path.join(tmpdir(), 'kmp-exact-cli-'));
  writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":core:data", ":core:database")\n');
  writeFileSync(path.join(root, 'gradlew'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  for (const name of ['data', 'database']) {
    const dir = path.join(root, 'core', name);
    mkdirSync(path.join(dir, 'src', 'jvmTest', 'kotlin'), { recursive: true });
    writeFileSync(path.join(dir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
  }
  return root;
}

function invoke(sub, dir, selector) {
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
  try {
    process.argv = ['node', 'kmp-test.js', sub, '--project-root', dir,
      '--dry-run', '--json', '--modules', selector];
    const exit = main();
    return { exit, envelope: JSON.parse(chunks.join('').trim()) };
  } finally {
    process.stdout.write = write;
  }
}

it('CLI dry-run resolves exact names before the shell, with Windows flag forwarding in the plan', () => {
  const dir = fixture();
  const { exit, envelope } = invoke('parallel', dir, ':core:data');
  expect(exit).toBe(0);
  expect(envelope.plan.modules.map(module => module.name)).toEqual(['core:data']);
  expect(envelope.plan.spawn_args).toContain(process.platform === 'win32' ? '-Modules' : '--modules');
  expect(existsSync(path.join(dir, '.kmp-test-runner'))).toBe(false);
});

it('CLI dry-run returns typed JSON exit 2 for unknown module names on both execution flows', () => {
  const dir = fixture();
  for (const sub of ['parallel', 'android']) {
    const { exit, envelope } = invoke(sub, dir, ':absent');
    expect(exit).toBe(2);
    expect(envelope.exit_code).toBe(2);
    expect(envelope.errors).toMatchObject([{ code: 'unknown_module', module: ':absent' }]);
  }
});

it('CLI dry-run rejects duplicate --modules flags rather than silently replacing a selection', () => {
  const dir = fixture();
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
  try {
    process.argv = ['node', 'kmp-test.js', 'parallel', '--project-root', dir,
      '--dry-run', '--json', '--modules', ':core:data', '--modules', ':core:database'];
    expect(main()).toBe(2);
    expect(JSON.parse(chunks.join('').trim()).errors[0].code).toBe('invalid_modules');
  } finally {
    process.stdout.write = write;
  }
});
