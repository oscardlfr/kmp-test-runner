import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'bin/kmp-test.js');
const fixture = path.join(root, 'tests/fixtures/version-catalog-alias-plugins');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

assert.equal(run('--version').trim(), version);
assert.match(run('--help'), /parallel/);

const dryRun = JSON.parse(run('parallel', '--project-root', fixture, '--dry-run', '--json'));
assert.equal(dryRun.version, version);
assert.equal(dryRun.subcommand, 'parallel');
assert.equal(dryRun.dry_run, true);
assert.equal(dryRun.exit_code, 0);
assert.equal(dryRun.plan.spawn_cmd, process.platform === 'win32' ? 'pwsh' : 'bash');
assert.match(dryRun.plan.script_path, process.platform === 'win32' ? /\.ps1$/ : /\.sh$/);

process.stdout.write(`Node ${process.versions.node} CLI compatibility smoke passed\n`);
