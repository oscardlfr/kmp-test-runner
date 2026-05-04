#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// lib/runner.js — entrypoint dispatcher invoked by the thin shell wrappers
// (scripts/sh/run-*.sh, scripts/ps1/run-*.ps1) since v0.8.
//
// Sub-entry 1 wires `benchmark`. Other subcommands fall through to the
// "not yet migrated" placeholder until their respective migration PRs land.

import path from 'node:path';
import { preflightJdkCheck, jdkMismatchHint, EXIT } from './cli.js';
import { loadProjectConfig } from './project-config.js';

// Orchestrators are dynamically imported on-demand so the gradle plugin's
// per-task `libResources` arrays only need to bundle the orchestrator (and
// its transitive deps) for THAT task — adding sub-entry 3-5 modules doesn't
// require every existing TestsTask to grow its bundle list.

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
  // Strip global flags the orchestrator doesn't consume directly. Track
  // --ignore-jdk-mismatch since runner.js owns the JDK gate when invoked
  // directly via the wrapper (cli.js' upstream gate is bypassed in that path).
  const ignoreJdk = consumeFlag(args, '--ignore-jdk-mismatch');
  args = ignoreJdk.args;
  for (const f of ['--force', '--no-jdk-autoselect']) {
    args = consumeFlag(args, f).args;
  }
  // --java-home <value> takes a value pair.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--java-home') { args.splice(i, 2); i--; }
  }

  const projectRoot = path.resolve(getProjectRoot(args));

  // v0.8.0 — project-level config (.kmp-test-runner.json) loaded once and
  // threaded to every orchestrator. null on absence/error; orchestrators
  // consult `env` first and fall through to `config` for per-test-type skip
  // lists + sharedProject.name.
  const config = loadProjectConfig(projectRoot);

  // Pre-flight JDK gate. Mirrors lib/cli.js (lines ~1530-1549) so direct
  // invocation of the wrapper (bypassing cli.js, e.g. bats / bash test-jdk-gate)
  // still BLOCKs on toolchain mismatch. When invoked via cli.js the upstream
  // gate already ran:
  //   - On auto-select: JAVA_HOME has been overridden, so preflightJdkCheck
  //     here re-reads `java -version`, sees the matching version, and returns
  //     null (silent pass-through).
  //   - On preserve (v0.8.0 fix-PR-B): JAVA_HOME is NOT overridden — the host
  //     already satisfies the AGP floor. preflightJdkCheck returns
  //     `{ kind: 'preserved', ... }` here; we MUST NOT treat this as a
  //     mismatch (CLI already emitted the observability [NOTICE]).
  if (!ignoreJdk.present) {
    let result = null;
    try { result = preflightJdkCheck(projectRoot); } catch { /* best-effort */ }
    if (result?.kind === 'mismatch') {
      const hint = jdkMismatchHint(result.required, sub);
      const msg = `JDK mismatch — project requires JDK ${result.required} but current is JDK ${result.current}`;
      process.stderr.write(`\nkmp-test: ${msg}\n`);
      process.stderr.write(`          Tests will fail with UnsupportedClassVersionError if we proceed.\n\n`);
      process.stderr.write(`          Fix: set JAVA_HOME to a JDK ${result.required} install. Example:\n`);
      process.stderr.write(`            ${hint}\n\n`);
      process.stderr.write(`          Bypass (not recommended): pass --ignore-jdk-mismatch\n\n`);
      process.exit(EXIT.ENV_ERROR);
    }
    // result?.kind === 'preserved' → CLI already emitted [NOTICE]; proceed.
  }

  // Migrated subcommand dispatch. Each branch invokes its orchestrator and
  // emits the sentinel-bracketed envelope on --json (or via env-var signal
  // from lib/cli.js, which consumes --json upstream).
  const emitEnvelope = json.present ||
    String(process.env.KMP_TEST_RUNNER_EMIT_ENVELOPE || '') === '1';

  function writeEnvelope(envelope) {
    if (!emitEnvelope) return;
    process.stdout.write(ENVELOPE_BEGIN + '\n');
    process.stdout.write(JSON.stringify(envelope) + '\n');
    process.stdout.write(ENVELOPE_END + '\n');
  }

  if (sub === 'benchmark') {
    const { runBenchmark } = await import('./benchmark-orchestrator.js');
    const { envelope, exitCode } = await runBenchmark({
      projectRoot,
      args,
      env: process.env,
      config,
      log: (line) => process.stdout.write(line + '\n'),
    });
    writeEnvelope(envelope);
    process.exit(exitCode);
  }

  if (sub === 'changed') {
    const { runChanged } = await import('./changed-orchestrator.js');
    const { envelope, exitCode } = await runChanged({
      projectRoot,
      args,
      env: process.env,
      config,
      log: (line) => process.stdout.write(line + '\n'),
    });
    writeEnvelope(envelope);
    process.exit(exitCode);
  }

  if (sub === 'android') {
    const { runAndroid } = await import('./android-orchestrator.js');
    const { envelope, exitCode } = await runAndroid({
      projectRoot,
      args,
      env: process.env,
      config,
      log: (line) => process.stdout.write(line + '\n'),
    });
    writeEnvelope(envelope);
    process.exit(exitCode);
  }

  if (sub === 'coverage') {
    const { runCoverage } = await import('./coverage-orchestrator.js');
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args,
      env: process.env,
      config,
      log: (line) => process.stdout.write(line + '\n'),
    });
    writeEnvelope(envelope);
    process.exit(exitCode);
  }

  if (sub === 'parallel') {
    const { runParallel } = await import('./parallel-orchestrator.js');
    const { envelope, exitCode } = await runParallel({
      projectRoot,
      args,
      env: process.env,
      config,
      log: (line) => process.stdout.write(line + '\n'),
    });
    writeEnvelope(envelope);
    process.exit(exitCode);
  }

  process.stderr.write(
    `runner.js: subcommand '${sub}' is not yet migrated to Node.\n`
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`runner.js: ${err && err.stack || err}\n`);
  process.exit(2);
});

export { ENVELOPE_BEGIN, ENVELOPE_END };
