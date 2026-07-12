// SPDX-License-Identifier: MIT
// lib/commands/clean.js — `kmp-test clean`: purge run artifacts under
// <projectRoot>/.kmp-test-runner.
//
// Default scope: per-run debris (logs/, cache-isolated/, init-scripts/,
// cache/*.tmp.*) regardless of age. `--all` adds the model/tasks cache and
// reports/. The lockfile (concurrency key) and .kmp-test-runner.json (user
// input) are never touched. Respects the project lock: refuses with
// `lock_held` when another kmp-test run is live (a sweep mid-run would
// delete artifacts the run is still writing). `--dry-run` lists targets
// without deleting; `--force` displaces a live lock (same contract as the
// test subcommands).

import path from 'node:path';

import { EXIT, ENVELOPE_SCHEMA_VERSION } from '../envelope/exit-codes.js';
import { emitJson, readVersion } from '../envelope/builder.js';
import { cleanArtifacts } from '../project/artifact-sweep.js';
import { acquireLock, releaseOwnLock, lockAgeLabel } from '../runners/lockfile.js';
// ESM live binding resolves the cli.js → commands/clean.js → cli.js cycle the
// same way it does for doctor/info/describe.
import { getProjectRoot } from '../cli.js';

// dryRun + force arrive via ctx (cli.js#main consumes the global flags from
// rawArgv before dispatch); --all is clean-specific and stays in args.
function runClean(args, jsonMode, { dryRun = false, force = false } = {}) {
  const startTime = Date.now();
  const projectRoot = path.resolve(getProjectRoot(args));
  const all = args.includes('--all');

  const errors = [];
  let result = { targets: [], removed: [], failed: [], bytesFreed: 0 };
  let exitCode = EXIT.SUCCESS;
  let lockResult = null;

  if (dryRun) {
    result = cleanArtifacts(projectRoot, { all, dryRun: true });
  } else {
    // Deleting under a live run would race its log/cache writers.
    lockResult = acquireLock(projectRoot, 'clean', { force });
    if (!lockResult.ok && lockResult.reason === 'lock_held') {
      const e = lockResult.existing || {};
      errors.push({
        code: 'lock_held',
        message: `another kmp-test process holds the project lock (PID ${e.pid}, age ${lockAgeLabel(e.start_time)}, subcommand ${e.subcommand}). Re-run with --force only if that process is known dead.`,
      });
      exitCode = EXIT.ENV_ERROR;
    } else if (!lockResult.ok) {
      errors.push({
        code: 'lock_write_error',
        message: `failed to write lockfile: ${(lockResult.error && lockResult.error.message) || 'unknown'}`,
      });
      exitCode = EXIT.ENV_ERROR;
    } else {
      try {
        result = cleanArtifacts(projectRoot, { all, dryRun: false });
        if (result.failed.length > 0) {
          errors.push({
            code: 'clean_failed',
            message: `${result.failed.length} target(s) could not be removed (file locks?): ${result.failed.map(f => f.path).join(', ')}`,
          });
          exitCode = EXIT.ENV_ERROR;
        }
      } finally {
        releaseOwnLock(projectRoot, lockResult.ourLock);
      }
    }
  }

  const durationMs = Date.now() - startTime;

  if (jsonMode) {
    // Unified envelope shape (doctor precedent): canonical fields + the
    // clean-specific block. Additive — schema_version does not bump.
    emitJson({
      tool: 'kmp-test',
      schema_version: ENVELOPE_SCHEMA_VERSION,
      subcommand: 'clean',
      version: readVersion(),
      project_root: projectRoot,
      exit_code: exitCode,
      duration_ms: durationMs,
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      modules: [],
      skipped: [],
      coverage: { tool: 'none', missed_lines: null },
      errors,
      warnings: [],
      clean: {
        all,
        dry_run: dryRun,
        targets: result.targets.map(t => t.path),
        removed: result.removed,
        failed: result.failed,
        bytes_freed: result.bytesFreed,
        bytes_in_targets: result.targets.reduce((a, t) => a + t.bytes, 0),
      },
    });
    return exitCode;
  }

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`kmp-test clean: ${e.message}\n`);
    return exitCode;
  }
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  if (dryRun) {
    process.stdout.write(`kmp-test clean --dry-run — ${result.targets.length} target(s), ${mb(result.targets.reduce((a, t) => a + t.bytes, 0))} MB:\n`);
    for (const t of result.targets) process.stdout.write(`  ${t.path} (${mb(t.bytes)} MB)\n`);
    if (result.targets.length === 0) process.stdout.write('  (nothing to clean)\n');
  } else {
    process.stdout.write(`kmp-test clean — removed ${result.removed.length} target(s), freed ${mb(result.bytesFreed)} MB${all ? ' (--all: cache + reports included)' : ''}\n`);
  }
  return exitCode;
}

// Dispatch-table contract (mirrors lib/commands/doctor.js).
function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run({ args, jsonMode, dryRun = false, force = false }) {
  return runClean(args, jsonMode, { dryRun, force });
}

export { runClean, parse, run };
