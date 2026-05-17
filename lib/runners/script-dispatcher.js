// SPDX-License-Identifier: MIT
// lib/runners/script-dispatcher.js — script-backed subcommand spawn pipeline.
//
// Refactor PR-09: extracted verbatim from lib/cli.js#main(). Owns the cross-
// cutting concerns shared by parallel/changed/android/benchmark/coverage:
//   - gradlew preflight check
//   - JDK preflight + mismatch resolution (auto-select / catalogue / gate)
//   - test-filter pattern resolution (per-sub)
//   - .kmp-test-runner.json defaults + finalArgs assembly
//   - spawn cmd resolve (Windows: pwsh + ps1 + flag translation; Unix: bash + sh)
//   - --dry-run plan emit (early exit, no spawn)
//   - lockfile acquire (skipped on --isolated-no-lock; --force bypasses live)
//   - eager ProjectModel build (best-effort, pre-populates cache)
//   - cleanup signal handlers (SIGINT/SIGTERM/uncaughtException)
//   - benchmark outer-timeout (sub-aware branch)
//   - Windows pipe-inheritance deadlock workaround (temp-file FDs)
//   - spawnSync + result handling
//   - migrated short-circuit envelope extract
//   - legacy parseScriptOutput + buildJsonReport emit
//   - finally cleanup
//
// Sequencing is LOCKED. The 17 Pester contract tests + parity snapshots key
// on this exact order. Do NOT reorder.

import { spawnSync } from 'node:child_process';
import { readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildProjectModel } from '../project-model.js';
import { discoverInstalledJdks } from '../jdk-catalogue.js';
// cli.js main() owns the loadMergedConfig + applyConfigDefaults path
// (so getJavaHomeOverride sees user-global java_home). This module
// no longer re-runs the merge here, which avoids a duplicate `java_home
// is not allowed in project-local config` warn.
import { EXIT } from '../envelope/exit-codes.js';
import {
  emitJson,
  buildJsonReport,
  enforceErrorsExitCodeInvariant,
  envErrorJson,
  buildDryRunReport,
} from '../envelope/builder.js';
import { buildDryRunBlockFromArgv } from '../envelope/dry-run-blocks.js';
import {
  pickWindowsShell,
  collapseGradleArgs,
  translateBashFlagsForPowerShell,
} from './shell-runner.js';
import {
  acquireLock,
  removeLockfile,
  lockfilePath,
  lockAgeLabel,
} from './lockfile.js';
import {
  preflightJdkCheck,
  jdkMismatchHint,
  parseGradleConfig,
} from '../project/jdk-preflight.js';
import {
  parseScriptOutput,
  resolveDryRunModules,
} from '../parsers/script-output.js';
import { resolvePatternForSubcommand } from '../parsers/test-filter.js';
// resolveBenchmarkOuterTimeoutMs, parseGradleTimeoutMs, extractMigratedEnvelope,
// ensureProjectRoot, checkGradlew still live in cli.js. ESM live bindings
// resolve the cli.js↔script-dispatcher cycle since uses are runtime, not
// top-level. Same pattern used for shell-runner.
import {
  resolveBenchmarkOuterTimeoutMs,
  parseGradleTimeoutMs,
  extractMigratedEnvelope,
  ensureProjectRoot,
  checkGradlew,
} from '../cli.js';

// Boolean flags injected by COMMANDS[*].prefix or that the user may double up
// when they re-pass the canonical wire form. Only flags that take no value
// belong here — value-bearing flags (--module-filter, --gradle-args, …) must
// keep every occurrence so multi-arg semantics survive.
//
// Today only `coverage.prefix = ['--skip-tests']` exercises this. The set is
// general so future prefix injections (or duplicate user input) stay safe
// across both ps1 (typed param block, rejects double-bind) and bash.
const KNOWN_BOOLEAN_FLAGS = new Set([
  '--skip-tests',
  '--include-shared',
  '--include-untested',
  '--no-coverage',
  '--coverage-only',
  '--ignore-jdk-mismatch',
  '--list-only',
  '--list',
  '--no-jdk-autoselect',
  '--isolated',
  '--isolated-no-lock',
  '--staged-only',
  '--show-modules-only',
  '--no-adb',
  '--skip-probe',
  '--no-cache',
  '--clear-data',
  '--auto-retry',
  '--skip-app',
  '--verbose',
  '--fresh-daemon',
  '--prerelease',
  '--check',
  '--ignore-gradle-timeout',
]);

function dedupBooleanFlags(args) {
  const seen = new Set();
  const out = [];
  for (const a of args) {
    if (KNOWN_BOOLEAN_FLAGS.has(a)) {
      if (seen.has(a)) continue;
      seen.add(a);
    }
    out.push(a);
  }
  return out;
}

// dispatchScriptCommand: returns the exit code (sync). The 5 script-backed
// commands route here from their `run({...})` after main() has hoisted global
// flags + pre-spawn validation.
function dispatchScriptCommand({
  sub,                  // 'parallel' | 'changed' | 'android' | 'benchmark' | 'coverage'
  cmd,                  // COMMANDS[sub] entry
  projectRoot,          // already resolved + frozen
  cleanedArgs,          // post-validation / post-alias / post-POSIX-equals
  jsonMode,
  dryRun,
  force,
  ignoreJdk,
  javaHomeOverride,
  noJdkAutoselect,
  testFilterPattern,    // raw --test-filter value (or null) — resolved here
  isolatedFlags,        // { enabled, cacheDir, noLock }
  isWin = process.platform === 'win32',
  scriptsDir,           // resolved path to scripts/ directory
}) {
  // Pre-flight gradlew check.
  if (!checkGradlew(projectRoot, isWin)) {
    const wrapper = isWin ? 'gradlew.bat' : 'gradlew';
    const msg = `no ${wrapper} found in ${projectRoot}`;
    if (jsonMode) {
      emitJson(envErrorJson({ subcommand: sub, projectRoot, durationMs: 0, message: msg, code: 'no_gradlew' }));
    } else {
      process.stderr.write(`kmp-test: ${msg}\n`);
      process.stderr.write(`Either pass --project-root <dir> pointing to a Gradle project, or cd into one.\n`);
      process.stderr.write(`If this IS a Gradle project, run \`gradle wrapper\` to generate the wrapper.\n`);
    }
    return EXIT.ENV_ERROR;
  }

  // Pre-flight JDK toolchain check. Gates real runs only — `--dry-run` is for
  // planning without spawning gradle, so a JDK mismatch can't actually break it
  // and gating dry-run only blocks legitimate plan inspection on misconfigured
  // hosts. Bypassable via --ignore-jdk-mismatch (the flag also passes through
  // to the script).
  const jdkResult = !dryRun ? preflightJdkCheck(projectRoot) : null;
  if (jdkResult?.kind === 'preserved') {
    process.stderr.write(
      `[NOTICE] host JDK ${jdkResult.current} meets AGP ${jdkResult.agpVersion} floor `
      + `(JDK ${jdkResult.required}); preserving host\n`,
    );
  }
  const mismatch = jdkResult?.kind === 'mismatch' ? jdkResult : null;
  let jdkOverrideEnv = null;
  if (mismatch && !ignoreJdk) {
    let resolvedJavaHome = javaHomeOverride;
    let autoSelected = false;
    if (!resolvedJavaHome && !noJdkAutoselect) {
      const installed = discoverInstalledJdks();
      const match = installed.find(e => e.majorVersion === mismatch.required);
      if (match) {
        resolvedJavaHome = match.path;
        autoSelected = true;
        const agpNote = mismatch.agpVersion ? ` — project applies AGP ${mismatch.agpVersion}` : '';
        process.stderr.write(
          `[NOTICE] auto-selecting JDK ${mismatch.required} from ${match.path} `
          + `(${match.vendor}; host default is JDK ${mismatch.current}${agpNote})\n`,
        );
      }
    }
    if (resolvedJavaHome) {
      const newPath = path.join(resolvedJavaHome, 'bin') + path.delimiter + (process.env.PATH || '');
      jdkOverrideEnv = { JAVA_HOME: resolvedJavaHome, PATH: newPath };
      void autoSelected;
    } else {
      const hint = jdkMismatchHint(mismatch.required, sub);
      const msg = `JDK mismatch — project requires JDK ${mismatch.required} but current is JDK ${mismatch.current}`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs: 0,
          message: msg, code: 'jdk_mismatch',
          extra: { required_jdk: mismatch.required, current_jdk: mismatch.current },
        }));
      } else {
        process.stderr.write(`\nkmp-test: ${msg}\n`);
        process.stderr.write(`          Tests will fail with UnsupportedClassVersionError if we proceed.\n\n`);
        process.stderr.write(`          Fix: set JAVA_HOME to a JDK ${mismatch.required} install. Example:\n`);
        process.stderr.write(`            ${hint}\n\n`);
        process.stderr.write(`          Or pass --java-home <path> to a JDK ${mismatch.required} install.\n`);
        process.stderr.write(`          Or install a JDK ${mismatch.required} into a standard location for auto-select.\n`);
        process.stderr.write(`          Bypass (not recommended): pass --ignore-jdk-mismatch\n\n`);
      }
      return EXIT.ENV_ERROR;
    }
  }

  // Resolve --test-filter (may walk source tree for android targets).
  const resolvedFilter = testFilterPattern
    ? resolvePatternForSubcommand(testFilterPattern, sub, cleanedArgs, projectRoot)
    : null;

  // cli.js main() already merged user-global + project-local and applied
  // defaults via applyConfigDefaults before reaching here.

  // Inject --project-root if missing.
  const withProjectRoot = ensureProjectRoot(cleanedArgs);
  let finalArgs = [...cmd.prefix, ...withProjectRoot];
  if (resolvedFilter !== null && resolvedFilter !== undefined) {
    finalArgs = [...finalArgs, '--test-filter', resolvedFilter];
  }
  // Collapse duplicate occurrences of known boolean flags so prefix-injected
  // canonical forms (e.g. coverage.prefix=['--skip-tests']) survive a user
  // re-pass without tripping ps1 ValidateSet double-bind rejection.
  finalArgs = dedupBooleanFlags(finalArgs);

  let spawnCmd, spawnArgs, scriptPath;
  if (isWin) {
    const shell = pickWindowsShell();
    scriptPath = path.join(scriptsDir, 'ps1', cmd.ps1);
    const collapsedArgs = collapseGradleArgs(finalArgs);
    const translatedArgs = cmd.passthrough
      ? collapsedArgs
      : translateBashFlagsForPowerShell(collapsedArgs);
    spawnCmd = shell;
    spawnArgs = ['-NoLogo', '-NoProfile', '-File', scriptPath, ...translatedArgs];
  } else {
    scriptPath = path.join(scriptsDir, 'sh', cmd.sh);
    spawnCmd = 'bash';
    spawnArgs = [scriptPath, ...finalArgs];
  }

  // --dry-run: emit the resolved plan and exit before spawning anything.
  if (dryRun) {
    const plan = {
      spawn_cmd: spawnCmd,
      spawn_args: spawnArgs,
      script_path: scriptPath,
      final_args: finalArgs,
      test_filter: resolvedFilter ?? null,
    };
    const resolved = resolveDryRunModules(sub, projectRoot, finalArgs);
    plan.modules = resolved ? resolved.modules : [];
    plan.skipped = resolved ? resolved.skipped : [];
    const isolatedField = {
      enabled: !!isolatedFlags.enabled,
      cache_dir: isolatedFlags.cacheDir || null,
      kept: false,
      locked: !isolatedFlags.noLock,
    };
    if (jsonMode) {
      const envelope = buildDryRunReport({ subcommand: sub, projectRoot, plan, isolated: isolatedField });
      // Surface gradle_config_applied at the dispatcher-level dry-run for
      // `parallel`. The orchestrator-level dry-run (lib/orchestrators/parallel-
      // orchestrator.js) also emits this field, but the dispatcher short-circuits
      // BEFORE invoking the orchestrator on `--dry-run`, so without this patch
      // agents probing via `kmp-test parallel --dry-run --json` would never see
      // the drop signal. Restricted to `parallel`: other script-backed subs
      // (android/benchmark/coverage) don't inject `--parallel` themselves.
      if (sub === 'parallel') {
        const gradleCfg = parseGradleConfig(projectRoot);
        if (gradleCfg.sources.project && gradleCfg.parallel === false) {
          envelope.gradle_config_applied = { parallel_dropped: true };
        }
      }
      // Emit the subcommand-specific block on dry-run with empty-but-
      // present default values. The dispatcher short-circuits before reaching
      // the orchestrator on dry-run, so without this assembly agents reading
      // `android.device_serial` / `benchmark.config` / `changed.staged_only`
      // on --dry-run got `undefined`. Pure builder lives in
      // lib/envelope/dry-run-blocks.js; same shape as the orchestrator's
      // real-run + --list-only emission sites.
      const block = buildDryRunBlockFromArgv(sub, finalArgs, plan);
      if (block) envelope[sub] = block;
      emitJson(envelope);
    } else {
      process.stdout.write(`kmp-test ${sub} — DRY RUN (no script invoked)\n`);
      process.stdout.write(`  Project root: ${projectRoot}\n`);
      process.stdout.write(`  Subcommand:   ${sub}\n`);
      process.stdout.write(`  Script:       ${scriptPath}\n`);
      if (resolvedFilter) {
        process.stdout.write(`  Test filter:  ${resolvedFilter}` +
          (testFilterPattern !== resolvedFilter ? ` (resolved from ${testFilterPattern})` : '') + '\n');
      }
      process.stdout.write(`  Final argv:   ${finalArgs.join(' ')}\n`);
      process.stdout.write(`  Spawn:        ${spawnCmd} ${spawnArgs.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}\n`);
      if (plan.modules.length > 0) {
        process.stdout.write(`  Modules (${plan.modules.length}):\n`);
        for (const m of plan.modules) {
          process.stdout.write(`    - ${m.name}\n`);
        }
      }
    }
    return EXIT.SUCCESS;
  }

  // Acquire advisory lockfile before spawning. doctor + dry-run skip this.
  // --force bypasses a live lock; stale locks (PID dead) are reclaimed.
  // Bypass conditions:
  //   - `--isolated-no-lock`: explicit opt-out
  //   - `--isolated-cache-dir <path>`: user supplied a private gradle cache,
  //     so the shared-cache race the lock protects against can't happen
  //     (report writes are already runId-suffixed across orchestrators).
  const bypassLock = isolatedFlags.noLock || !!isolatedFlags.cacheDir;
  const lockResult = bypassLock
    ? { ok: true, skipped: true }
    : acquireLock(projectRoot, sub, { force });
  if (!lockResult.ok) {
    if (lockResult.reason === 'lock_held') {
      const e = lockResult.existing;
      const age = lockAgeLabel(e.start_time);
      const msg =
        `another kmp-test (${e.subcommand}) is already running with PID ${e.pid} (started ${age} ago). ` +
        `Options: ` +
        `(a) wait for it to finish; ` +
        `(b) run with --isolated-cache-dir <path> to use a separate gradle cache and skip the lock; ` +
        `(c) run with --project-root <other-path> against a different project; ` +
        `(d) pass --force to bypass (risks gradle cache races if both runs touch the same modules).`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs: 0,
          message: msg, code: 'lock_held',
        }));
      } else {
        process.stderr.write(`kmp-test: lock held — ${msg}\n`);
        process.stderr.write(`  PID:        ${e.pid}\n`);
        process.stderr.write(`  age:        ${age}\n`);
        process.stderr.write(`  subcommand: ${e.subcommand}\n`);
      }
      return EXIT.ENV_ERROR;
    }
    if (lockResult.reason === 'write_error') {
      const msg = `failed to write lockfile at ${lockfilePath(projectRoot)}: ${lockResult.error && lockResult.error.message}`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs: 0,
          message: msg, code: 'lock_write_error',
        }));
      } else {
        process.stderr.write(`kmp-test: ${msg}\n`);
      }
      return EXIT.ENV_ERROR;
    }
  }
  if (!jsonMode && lockResult.reclaimed) {
    process.stderr.write(`kmp-test: stale lockfile reclaimed (previous PID was dead)\n`);
  }
  if (!jsonMode && lockResult.forced) {
    process.stderr.write(`kmp-test: --force: bypassing live lock from PID ${lockResult.existing.pid}\n`);
  }

  // Phase 4 (v0.5.1): build the ProjectModel JSON before spawning the script
  // so its sh/ps1 readers (pm_get_*, Get-Pm*) hit the model fast-path on
  // tier 1 instead of falling through to the gradle-tasks probe.
  try {
    buildProjectModel(projectRoot, { skipProbe: true });
  } catch { /* model build is non-essential — script falls through to legacy */ }

  // Cleanup hooks for SIGINT (Ctrl-C), SIGTERM, and uncaughtException.
  // When the lockfile probe was bypassed (noLock or cacheDir), there's no
  // file to remove.
  const cleanup = () => { if (!bypassLock) removeLockfile(projectRoot); };
  const sigintHandler = () => { cleanup(); process.exit(130); };
  const sigtermHandler = () => { cleanup(); process.exit(143); };
  const uncaughtHandler = (err) => {
    cleanup();
    process.stderr.write(`kmp-test: uncaughtException: ${(err && err.stack) || err}\n`);
    process.exit(1);
  };
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);
  process.once('uncaughtException', uncaughtHandler);

  // Bug Z (Windows pipe-inheritance deadlock with --json) workaround.
  const useTempFileRedirect = jsonMode && isWin;
  let stdoutFile = null, stderrFile = null;
  let stdoutFd = null, stderrFd = null;
  const cleanupTempFiles = () => {
    if (stdoutFd !== null) { try { closeSync(stdoutFd); } catch { /* already closed */ } stdoutFd = null; }
    if (stderrFd !== null) { try { closeSync(stderrFd); } catch { /* already closed */ } stderrFd = null; }
    if (stdoutFile) { try { unlinkSync(stdoutFile); } catch { /* best-effort */ } }
    if (stderrFile) { try { unlinkSync(stderrFile); } catch { /* best-effort */ } }
  };

  try {
    const startTime = Date.now();
    // v0.8.0 — adaptive outer timeout for `benchmark`.
    const timeoutMs = sub === 'benchmark'
      ? resolveBenchmarkOuterTimeoutMs(spawnArgs, process.env)
      : parseGradleTimeoutMs();

    if (useTempFileRedirect) {
      const stamp = `${process.pid}-${Date.now()}`;
      stdoutFile = path.join(os.tmpdir(), `kmp-test-${stamp}-stdout.log`);
      stderrFile = path.join(os.tmpdir(), `kmp-test-${stamp}-stderr.log`);
      stdoutFd = openSync(stdoutFile, 'w');
      stderrFd = openSync(stderrFile, 'w');
    }

    const spawnOpts = useTempFileRedirect
      ? { stdio: ['ignore', stdoutFd, stderrFd], timeout: timeoutMs, killSignal: 'SIGTERM' }
      : jsonMode
        ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGTERM' }
        : { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGTERM' };

    if (jdkOverrideEnv) {
      spawnOpts.env = { ...process.env, ...jdkOverrideEnv };
    }
    if (cmd.migrated && jsonMode) {
      spawnOpts.env = { ...(spawnOpts.env || process.env), KMP_TEST_RUNNER_EMIT_ENVELOPE: '1' };
    }

    const result = spawnSync(spawnCmd, spawnArgs, spawnOpts);
    const durationMs = Date.now() - startTime;

    let capturedStdout = '', capturedStderr = '';
    if (useTempFileRedirect) {
      if (result.stdout != null) {
        capturedStdout = result.stdout;
        capturedStderr = result.stderr || '';
      } else {
        try { closeSync(stdoutFd); } catch { /* fall through */ }
        try { closeSync(stderrFd); } catch { /* fall through */ }
        stdoutFd = null; stderrFd = null;
        try { capturedStdout = readFileSync(stdoutFile, 'utf8'); } catch { /* empty */ }
        try { capturedStderr = readFileSync(stderrFile, 'utf8'); } catch { /* empty */ }
      }
    } else if (jsonMode) {
      capturedStdout = result.stdout || '';
      capturedStderr = result.stderr || '';
    }

    // Bug H detection — gradle timeout converged on both POSIX and Windows.
    const isGradleTimeout =
      (result.signal === 'SIGTERM' && result.status === null) ||
      (result.error && result.error.code === 'ETIMEDOUT');

    if (isGradleTimeout) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      const msg = `gradle invocation exceeded ${timeoutSec}s timeout — likely a hung daemon. Set KMP_GRADLE_TIMEOUT_MS env var to override (e.g. 3600000 for 1h).`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs,
          message: msg, code: 'gradle_timeout',
        }));
      } else {
        process.stderr.write(`kmp-test: ${msg}\n`);
      }
      return EXIT.ENV_ERROR;
    }

    if (result.error) {
      if (result.error.code === 'ENOENT') {
        const missing = isWin ? 'pwsh/powershell' : 'bash';
        const msg = `'${missing}' not found on PATH. Install PowerShell (Windows) or bash (Unix).`;
        if (jsonMode) {
          emitJson(envErrorJson({ subcommand: sub, projectRoot, durationMs, message: msg, code: 'missing_shell' }));
        } else {
          process.stderr.write(`kmp-test: ${msg}\n`);
        }
        return EXIT.ENV_ERROR;
      }
      process.stderr.write(`kmp-test: failed to spawn '${spawnCmd}': ${result.error.message}\n`);
      return EXIT.TEST_FAIL;
    }

    const scriptStatus = result.status ?? EXIT.TEST_FAIL;

    // Migrated subcommand short-circuit (v0.8 STRATEGIC PIVOT).
    if (cmd.migrated && jsonMode) {
      const envelope = extractMigratedEnvelope(capturedStdout);
      if (envelope) {
        const parsedAdapter = {
          tests: envelope.tests,
          errors: envelope.errors,
        };
        envelope.exit_code = enforceErrorsExitCodeInvariant(
          envelope.exit_code ?? scriptStatus, parsedAdapter
        );
        emitJson(envelope);
        return envelope.exit_code;
      }
      // No sentinel found → fall through to legacy parser as a safety net.
    }

    // Parse output up-front so the WS-5 invariant can promote scriptStatus.
    const parsed = parseScriptOutput(capturedStdout, capturedStderr, finalArgs, sub);
    const resolvedStatus = enforceErrorsExitCodeInvariant(scriptStatus, parsed);

    if (jsonMode) {
      emitJson(buildJsonReport({
        subcommand: sub,
        projectRoot,
        exitCode: resolvedStatus,
        durationMs,
        parsed,
      }));
    }

    return resolvedStatus;
  } finally {
    cleanupTempFiles();
    cleanup();
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('uncaughtException', uncaughtHandler);
  }
}

export { dispatchScriptCommand, dedupBooleanFlags, KNOWN_BOOLEAN_FLAGS };
