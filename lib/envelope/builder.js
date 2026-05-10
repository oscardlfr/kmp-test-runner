// SPDX-License-Identifier: MIT
// lib/envelope/builder.js — JSON envelope builders for every kmp-test subcommand.
//
// All builders embed `schema_version: ENVELOPE_SCHEMA_VERSION` and use `EXIT.*`
// for exit-code defaults. `readVersion()` lives here because every builder needs
// the package version and it's logically tied to envelope construction (cli.js
// re-imports it for the `--version` flag handler).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT, ENVELOPE_SCHEMA_VERSION } from './exit-codes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function readVersion() {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  return pkg.version;
}

// Build the canonical JSON object emitted by --json mode. Conditionally
// includes the top-level `benchmark` field when the parsed result contains
// one — keeps the envelope shape stable for non-benchmark subcommands.
export function buildJsonReport({ subcommand, projectRoot, exitCode, durationMs, parsed }) {
  const out = {
    tool: 'kmp-test',
    schema_version: ENVELOPE_SCHEMA_VERSION,
    subcommand,
    version: readVersion(),
    project_root: projectRoot,
    exit_code: exitCode,
    duration_ms: durationMs,
    tests: parsed.tests,
    modules: parsed.modules,
    skipped: parsed.skipped || [],
    coverage: parsed.coverage,
    errors: parsed.errors,
    warnings: parsed.warnings || [],
  };
  if (parsed.benchmark) out.benchmark = parsed.benchmark;
  if (parsed.changed)   out.changed = parsed.changed;
  if (parsed.android)   out.android = parsed.android;
  if (parsed.parallel)  out.parallel = parsed.parallel;
  // v0.9 step 3 — Node-only orchestrators surface their subcommand-specific
  // block at the top level for JSON-envelope-shape consistency.
  if (parsed.info)      out.info = parsed.info;
  if (parsed.describe)  out.describe = parsed.describe;
  if (parsed.update)    out.update = parsed.update;
  // v0.9 step 4 — `isolated:{}` is always emitted when parsed sets it (even
  // when enabled:false). coverage-orchestrator omits it intentionally
  // because it never spawns gradle, so the field would be misleading there.
  if (parsed.isolated)  out.isolated = parsed.isolated;
  return out;
}

// WS-5 invariant: if discriminated errors[] is non-empty, exit_code MUST be
// non-zero. Pre-v0.7.x the wrapper could exit 0 while a discriminator (e.g.
// task_not_found) had still pushed an error — agents reading
// `errors.length > 0` got false positives on a "passing" run. Discriminated
// codes (task_not_found / unsupported_class_version / instrumented_setup_failed
// / no_test_modules) and uncoded BUILD FAILED entries represent hard failures;
// `no_summary` is a recoverable parse-gap signal (the wrapper output didn't
// include any recognizable summary line) and must NOT trigger promotion —
// stub scripts in unit tests legitimately exit 0 with the parse-gap fallback
// firing. v0.8 sub-entry 2 adds `no_changed_modules` to the soft list: a
// clean working tree is a legitimate exit-0 outcome with structured signal
// in errors[].code (BACKLOG line 105).
export const SOFT_ERROR_CODES = new Set(['no_summary', 'no_changed_modules']);
export function enforceErrorsExitCodeInvariant(scriptStatus, parsed) {
  const errors = (parsed && parsed.errors) || [];
  const hardErrors = errors.filter(e => e && !SOFT_ERROR_CODES.has(e.code));
  if (hardErrors.length > 0 && scriptStatus === EXIT.SUCCESS) {
    return EXIT.TEST_FAIL;
  }
  return scriptStatus;
}

export function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// v0.9 session 2 Bug-B/C/D — build a CONFIG_ERROR (exit 2) envelope when
// parseArgs collected one or more `invalid_flag_value` / `invalid_regex`
// errors. Distinct from envErrorJson (which uses ENV_ERROR / exit 3) — bad
// CLI input is a usage error, not an environment failure. Caller-shape:
// the orchestrator passes its full errors[] (filtered to invalid_* codes
// before calling here so non-validation errors don't leak in).
export function buildInvalidArgsEnvelope({ subcommand, projectRoot, durationMs, errors }) {
  return {
    tool: 'kmp-test',
    schema_version: ENVELOPE_SCHEMA_VERSION,
    subcommand,
    version: readVersion(),
    project_root: projectRoot,
    exit_code: EXIT.CONFIG_ERROR,
    duration_ms: durationMs,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    skipped: [],
    coverage: {
      tool: 'auto',
      missed_lines: null,
      modules_with_kover_plugin: [],
      modules_with_jacoco_plugin: [],
    },
    errors,
    warnings: [],
  };
}

// v0.9 wet-audit finding F-1 — `exitCode` parameter accepts the caller's
// intended exit code so the envelope's `exit_code` field matches the actual
// process exit. Defaults to EXIT.ENV_ERROR for backward-compat (most callers
// use envErrorJson for genuine environment failures and want exit 3). The
// pre-fix hardcode forced describe.no_project (which returns CONFIG_ERROR / 2)
// + changed.no_changed_modules (which returns SUCCESS / 0 via a manual
// post-call override at line 387) to disagree with the envelope they emitted.
export function envErrorJson({ subcommand, projectRoot, durationMs, message, code, extra, exitCode = EXIT.ENV_ERROR }) {
  const err = { message };
  if (code) err.code = code;
  if (extra) Object.assign(err, extra);
  return {
    tool: 'kmp-test',
    schema_version: ENVELOPE_SCHEMA_VERSION,
    subcommand,
    version: readVersion(),
    project_root: projectRoot,
    exit_code: exitCode,
    duration_ms: durationMs,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    skipped: [],
    coverage: {
      tool: 'auto',
      missed_lines: null,
      modules_with_kover_plugin: [],
      modules_with_jacoco_plugin: [],
    },
    errors: [err],
    warnings: [],
  };
}

// Build the JSON payload emitted in --dry-run --json mode. Same envelope shape as the
// regular report, plus dry_run:true and a plan{} section describing what *would* run.
//
// v0.9 step 9.6 (Bug #6) — `isolated` parameter populated from peekIsolatedFlags
// so `kmp-test parallel --isolated --dry-run --json` (and android dry-run, etc.)
// surfaces the `isolated:{}` envelope field. Pre-fix the dry-run path always
// emitted an envelope without the field even when `--isolated` was supplied,
// forcing agents to peek inside `plan.spawn_args` for the `-Isolated` flag —
// inconsistent with real-run envelope shape (which always carries `isolated:{}`).
export function buildDryRunReport({ subcommand, projectRoot, plan, isolated = null }) {
  const out = {
    tool: 'kmp-test',
    schema_version: ENVELOPE_SCHEMA_VERSION,
    subcommand,
    version: readVersion(),
    project_root: projectRoot,
    exit_code: EXIT.SUCCESS,
    duration_ms: 0,
    dry_run: true,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    skipped: [],
    coverage: {
      tool: 'auto',
      missed_lines: null,
      modules_with_kover_plugin: [],
      modules_with_jacoco_plugin: [],
    },
    errors: [],
    warnings: [],
    plan,
  };
  if (isolated) out.isolated = isolated;
  return out;
}
