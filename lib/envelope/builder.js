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

/**
 * Build the canonical JSON object emitted by `--json` mode for any subcommand.
 * Top-level subcommand blocks (benchmark / changed / android / parallel /
 * info / describe / update / isolated) are emitted only when `parsed` carries
 * them — keeps the envelope shape stable across subcommands.
 * @param {object} opts
 * @param {string} opts.subcommand - Subcommand name (parallel/info/...).
 * @param {string} opts.projectRoot - Absolute path to the gradle project root.
 * @param {number} opts.exitCode - Process exit code.
 * @param {number} opts.durationMs - Total run duration in ms.
 * @param {object} opts.parsed - Parsed result from the orchestrator.
 * @returns {object} The envelope JSON object (ready to JSON.stringify).
 */
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
  // Node-only orchestrators surface their subcommand-specific
  // block at the top level for JSON-envelope-shape consistency.
  if (parsed.info)      out.info = parsed.info;
  if (parsed.describe)  out.describe = parsed.describe;
  if (parsed.update)    out.update = parsed.update;
  // `isolated:{}` is always emitted when parsed sets it (even
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
// firing. `no_changed_modules` is soft: a clean working tree is a legitimate
// exit-0 outcome. `gradle_timeout` is soft for the same reason: benchmark
// partial timeout (≥1 pass, some modules timed out, without --strict-timeouts)
// intentionally exits 0 — the per-module timeout in errors[] is an
// observability signal, not a hard failure. For all other subcommands the
// gradle_timeout exit code is already non-zero, so the SOFT treatment is
// a no-op there (the invariant's scriptStatus===EXIT.SUCCESS guard never fires).
export const SOFT_ERROR_CODES = new Set(['no_summary', 'no_changed_modules', 'gradle_timeout']);
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

/**
 * Build a CONFIG_ERROR (exit 2) envelope for invalid CLI arguments. Distinct
 * from envErrorJson (ENV_ERROR / exit 3): bad CLI input is a usage error,
 * not an environment failure. Callers pre-filter errors[] to invalid_*
 * codes only so non-validation errors don't leak in.
 * @param {object} opts
 * @param {string} opts.subcommand
 * @param {string} opts.projectRoot
 * @param {number} opts.durationMs
 * @param {Array<{code:string, flag?:string, value?:any, message:string}>} opts.errors
 * @returns {object} The envelope JSON object.
 */
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
      module_buckets: { with_data: [], no_xml: [], parse_errored: [], skipped_by_user: [] },
    },
    errors,
    warnings: [],
  };
}

/**
 * Build an environment-error envelope (defaults to EXIT.ENV_ERROR / exit 3).
 * The `exitCode` parameter overrides the default so the envelope's exit_code
 * field stays in sync with the actual process exit when callers need
 * CONFIG_ERROR (2) or SUCCESS (0) for soft fallbacks.
 * @param {object} opts
 * @param {string} opts.subcommand
 * @param {string} opts.projectRoot
 * @param {number} opts.durationMs
 * @param {string} opts.message - Human-readable error message.
 * @param {string} [opts.code] - Discriminated error code (e.g. 'no_project').
 * @param {object} [opts.extra] - Extra fields merged into the error entry.
 * @param {number} [opts.exitCode=EXIT.ENV_ERROR]
 * @returns {object} The envelope JSON object.
 */
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
      module_buckets: { with_data: [], no_xml: [], parse_errored: [], skipped_by_user: [] },
    },
    errors: [err],
    warnings: [],
  };
}

/**
 * Build the JSON payload emitted in `--dry-run --json` mode. Same envelope
 * shape as the regular report, plus `dry_run:true` and a `plan{}` section
 * describing what *would* run. When `isolated` is supplied, surfaces the
 * top-level `isolated:{}` field so dry-run envelopes match real-run shape.
 * @param {object} opts
 * @param {string} opts.subcommand
 * @param {string} opts.projectRoot
 * @param {object} opts.plan - Subcommand-specific plan block.
 * @param {object|null} [opts.isolated=null]
 * @returns {object} The envelope JSON object.
 */
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
      module_buckets: { with_data: [], no_xml: [], parse_errored: [], skipped_by_user: [] },
    },
    errors: [],
    warnings: [],
    plan,
  };
  if (isolated) out.isolated = isolated;
  return out;
}
