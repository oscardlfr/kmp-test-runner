#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// lib/runner.js — entrypoint dispatcher invoked by the thin shell wrappers
// (scripts/sh/run-*.sh, scripts/ps1/run-*.ps1) since v0.8.
//
// Sub-entry 1 wires `benchmark`. Other subcommands fall through to the
// "not yet migrated" placeholder until their respective migration PRs land.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightJdkCheck, jdkMismatchHint, EXIT } from './cli.js';
import { loadMergedConfig } from './project-config.js';
import { maybeAugmentEnvWithAndroidSdk } from './android-sdk-catalogue.js';
import { aggregateJdkSignals } from './project-model.js';

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

/**
 * Extract --java-home <path> from an args array.
 * Missing value: error, consume only --java-home.
 * Flag-like value (starts with '-'): error, leave that token in args.
 * @returns {{ javaHome: string|null, args: string[], error: {code,message,flag,value}|null }}
 */
export function extractJavaHome(args) {
  const out = [];
  let javaHome = null;
  let error = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--java-home') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        error = {
          code: 'invalid_flag_value',
          message: `--java-home requires a non-empty path that does not start with '-'`,
          flag: '--java-home',
          value: next,
        };
        // If next is a flag, leave it in args for the caller to process.
        continue;
      }
      javaHome = next;
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return { javaHome, args: out, error };
}

/**
 * Apply a --java-home override to process.env so all downstream spawns
 * (preflightJdkCheck, probeGradleTasksCached, orchestrators) inherit the
 * correct JDK. Avoids prepending <jdk>/bin twice on repeated calls.
 */
export function applyJavaHomeToEnv(javaHome) {
  process.env.JAVA_HOME = javaHome;
  const binDir = path.join(javaHome, 'bin');
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (parts[0] !== binDir) {
    process.env.PATH = [binDir, ...parts].join(path.delimiter);
  }
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
  // Apply --java-home BEFORE preflightJdkCheck so the preflight spawns java
  // from the right JDK, and before any orchestrator so probeGradleTasksCached
  // inherits the env. Invalid usage (missing or flag-like value) is a hard error.
  const jhResult = extractJavaHome(args);
  args = jhResult.args;
  if (jhResult.error) {
    process.stderr.write(`kmp-test: ${jhResult.error.message}\n`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (jhResult.javaHome) {
    applyJavaHomeToEnv(jhResult.javaHome);
  }

  const projectRoot = path.resolve(getProjectRoot(args));

  // v0.8.0 — project-level config (.kmp-test-runner.json) loaded once and
  // threaded to every orchestrator. null on absence/error; orchestrators
  // consult `env` first and fall through to `config` for per-test-type skip
  // lists + sharedProject.name.
  // Switched to loadMergedConfig so orchestrators see the union of
  // user-global preset (keyed by project) and project-local config.
  // The collector captures per-field validation drops so they can surface in
  // the envelope's warnings[] — stderr-only warns are invisible in --json
  // mode (an agent never learns its config field was silently ignored).
  const configWarnings = [];
  const config = loadMergedConfig(projectRoot, {
    collect: (w) => configWarnings.push(w),
  });

  // Pre-flight JDK gate. Mirrors lib/cli.js (lines ~1530-1549) so direct
  // invocation of the wrapper (bypassing cli.js, e.g. bats / bash test-jdk-gate)
  // still BLOCKs on toolchain mismatch. When invoked via cli.js the upstream
  // gate already ran:
  //   - On auto-select: JAVA_HOME has been overridden, so preflightJdkCheck
  //     here re-reads `java -version`, sees the matching version, and returns
  //     null (silent pass-through).
  //   - On preserve: JAVA_HOME is NOT overridden — the host
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

  // ANDROID_HOME auto-injection for ANY AGP-applying
  // project, not just `--test-type android*`. Pre-fix, JVM-leg dispatches
  // (e.g. nowinandroid `parallel --test-type unit --module app`) failed at
  // gradle config time when `:lint` / `:check` evaluated `compileSdk`
  // constants and the SDK couldn't be located.
  //
  // Root cause was upstream of the existing parallel-orchestrator.js gate
  // (line ~1083): buildProjectModel's internal `./gradlew tasks` probe runs
  // BEFORE that gate, uses spawnSync without an explicit `env` arg (inherits
  // process.env), and aborts when ANDROID_HOME isn't set — leaving modules
  // empty and short-circuiting to no_test_modules before the gate is reached.
  //
  // Fix: mutate process.env here (CLI entry point) so transitive child
  // processes — notably the model probe — inherit ANDROID_HOME via the
  // default env-inheritance contract. Gate on agpVersion !== null so the
  // injection fires for every test-type leg of an AGP project, while
  // staying inert for pure-Kotlin / pure-iOS projects.
  try {
    const sig = aggregateJdkSignals(projectRoot);
    if (sig.agpVersion !== null) {
      const log = (line) => process.stdout.write(line + '\n');
      const augmented = maybeAugmentEnvWithAndroidSdk(projectRoot, process.env, log);
      if (augmented !== process.env) {
        process.env.ANDROID_HOME = augmented.ANDROID_HOME;
        process.env.ANDROID_SDK_ROOT = augmented.ANDROID_SDK_ROOT;
        // Propagate PATH so adb (and other
        // platform-tools binaries) are callable in this process AND in
        // child processes that inherit env from process.env. Without
        // this propagation, `defaultAdbProbe` would still ENOENT on
        // bare `adb` even though ANDROID_HOME is set.
        if (augmented.PATH) process.env.PATH = augmented.PATH;
      }
    }
  } catch { /* best-effort, mirrors preflightJdkCheck try/catch shape */ }

  // Migrated subcommand dispatch. Each branch invokes its orchestrator and
  // emits the sentinel-bracketed envelope on --json (or via env-var signal
  // from lib/cli.js, which consumes --json upstream).
  const emitEnvelope = json.present ||
    String(process.env.KMP_TEST_RUNNER_EMIT_ENVELOPE || '') === '1';

  function writeEnvelope(envelope) {
    if (!emitEnvelope) return;
    // Prepend config-validation drops. Additive — warnings never affect the
    // exit code. runner.js is the ONLY loader that feeds envelopes, so this
    // is the single injection point (collecting in cli.js too would emit
    // every warning twice — both processes load the config).
    if (configWarnings.length && envelope && Array.isArray(envelope.warnings)) {
      envelope.warnings.unshift(...configWarnings);
    }
    process.stdout.write(ENVELOPE_BEGIN + '\n');
    process.stdout.write(JSON.stringify(envelope) + '\n');
    process.stdout.write(ENVELOPE_END + '\n');
  }

  if (sub === 'benchmark') {
    const { runBenchmark } = await import('./orchestrators/benchmark-orchestrator.js');
    // No `config` param: benchmark consults env only (KMP_TEST_SKIP_ADB,
    // KMP_GRADLE_TIMEOUT_MS) — project-config defaults reach it as injected
    // flags via cli.js#applyConfigDefaults like every other sub. The former
    // placeholder param sat unconsumed since v0.8.0.
    const { envelope, exitCode } = await runBenchmark({
      projectRoot,
      args,
      env: process.env,
      log: (line) => process.stdout.write(line + '\n'),
    });
    writeEnvelope(envelope);
    process.exit(exitCode);
  }

  if (sub === 'changed') {
    const { runChanged } = await import('./orchestrators/changed-orchestrator.js');
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
    const { runAndroid } = await import('./orchestrators/android-orchestrator.js');
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
    const { runCoverage } = await import('./orchestrators/coverage-orchestrator.js');
    // The shared wrapper rewrites `parallel --skip-tests` into a `coverage`
    // invocation, losing which sub the user typed; the dispatcher threads it
    // through KMP_ORIGINATING_SUBCOMMAND so the report header distinguishes
    // "No (--skip-tests)" from "No (coverage subcommand)". Allowlisted: a
    // stale exported var must not inject arbitrary header text. Absent env
    // (direct wrapper / runner.js invocation) keeps the coverage default.
    const originatingSubcommand =
      process.env.KMP_ORIGINATING_SUBCOMMAND === 'parallel' ? 'parallel' : 'coverage';
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args,
      env: process.env,
      config,
      log: (line) => process.stdout.write(line + '\n'),
      originatingSubcommand,
    });
    writeEnvelope(envelope);
    process.exit(exitCode);
  }

  if (sub === 'parallel') {
    const { runParallel } = await import('./orchestrators/parallel-orchestrator.js');
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

// Guard: only invoke main() when this file is the entry point (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`runner.js: ${err && err.stack || err}\n`);
    process.exit(2);
  });
}

export { ENVELOPE_BEGIN, ENVELOPE_END };
