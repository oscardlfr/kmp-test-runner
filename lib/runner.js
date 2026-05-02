#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// lib/runner.js — entrypoint dispatcher invoked by the thin shell wrappers
// (scripts/sh/run-*.sh, scripts/ps1/run-*.ps1) since v0.8.
//
// Sub-entry 1 wires `benchmark`. Other subcommands fall through to the
// "not yet migrated" placeholder until their respective migration PRs land.

import path from 'node:path';
import { runBenchmark } from './benchmark-orchestrator.js';

const ENVELOPE_BEGIN = '__KMP_TEST_ENVELOPE_V1_BEGIN__';
const ENVELOPE_END   = '__KMP_TEST_ENVELOPE_V1_END__';

function getProjectRoot(args) {
  const i = args.indexOf('--project-root');
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return process.cwd();
}

function consumeFlag(args, name) {
  let present = false;
  const out = [];
  for (const a of args) {
    if (a === name) { present = true; continue; }
    out.push(a);
  }
  return { args: out, present };
}

async function main() {
  const sub = process.argv[2];
  let args = process.argv.slice(3);

  // The wrapper passes through ALL flags lib/cli.js consumed earlier.
  // For migrated subcommands the orchestrator only cares about its
  // benchmark-specific surface, but --json controls envelope emission here.
  const json = consumeFlag(args, '--json');
  args = json.args;
  // Strip global flags the orchestrator doesn't consume directly.
  for (const f of ['--force', '--ignore-jdk-mismatch', '--no-jdk-autoselect']) {
    args = consumeFlag(args, f).args;
  }
  // --java-home <value> takes a value pair.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--java-home') { args.splice(i, 2); i--; }
  }

  const projectRoot = path.resolve(getProjectRoot(args));

  if (sub === 'benchmark') {
    const { envelope, exitCode } = await runBenchmark({
      projectRoot,
      args,
      env: process.env,
      log: (line) => process.stdout.write(line + '\n'),
    });
    // Emit sentinel-bracketed envelope when the caller asked for --json OR
    // when invoked from lib/cli.js (which consumes --json upstream and signals
    // via env var that the migrated short-circuit needs the envelope).
    const emitEnvelope = json.present ||
      String(process.env.KMP_TEST_RUNNER_EMIT_ENVELOPE || '') === '1';
    if (emitEnvelope) {
      process.stdout.write(ENVELOPE_BEGIN + '\n');
      process.stdout.write(JSON.stringify(envelope) + '\n');
      process.stdout.write(ENVELOPE_END + '\n');
    }
    process.exit(exitCode);
  }

  process.stderr.write(
    `runner.js: subcommand '${sub}' is not yet migrated to Node.\n` +
    `           Sub-entries 2-5 will wire changed/android/coverage/parallel.\n`
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`runner.js: ${err && err.stack || err}\n`);
  process.exit(2);
});

export { ENVELOPE_BEGIN, ENVELOPE_END };
