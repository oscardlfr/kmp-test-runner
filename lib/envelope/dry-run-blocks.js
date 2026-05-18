// SPDX-License-Identifier: MIT
// lib/envelope/dry-run-blocks.js — pure builders for the subcommand-specific
// envelope blocks emitted on `--dry-run` paths.
//
// The script-dispatcher short-circuits on --dry-run
// BEFORE invoking an orchestrator, so the subcommand-specific block
// (android:{}, benchmark:{}, changed:{}, parallel:{}) was previously absent
// from --dry-run envelopes. Real-run + --list-only paths emit these blocks
// from the orchestrators directly.
//
// Both call sites (dispatcher + orchestrator direct-call) now route through
// the builders below. Same shape, same defaults, same flag-echo semantics —
// the envelope is consistent across all 3 entry points (--dry-run,
// --list-only, real-run).
//
// Block shapes mirror the orchestrator's real-run emission sites:
//   - android-orchestrator.js  (success: L786-792 / list-only: L496-501)
//   - benchmark-orchestrator.js (success: L590-594)
//   - changed-orchestrator.js   (success: L477-481 — emitted via parallel
//                                envelope mirror on parallel-leg path)
//   - parallel-orchestrator.js  (success: lib/orchestrators/parallel/
//                                result-rollup.js per-leg legs[] aggregation)
//
// Dry-run values: flag-echo where the user supplied input, defaults
// otherwise. Counter fields default to 0, array fields to [], string fields
// to '' (or the documented default like 'smoke' for --config / 'auto' for
// --test-type / 'HEAD' for --base-ref).

/**
 * Find the value of a CLI flag in an argv array (kebab-case).
 *
 * @param {string[]} argv — array of CLI tokens, e.g. ['--device','R3CT30KAMEH','--flavor','staging']
 * @param {string} name — the flag to find, e.g. '--device'
 * @returns {string} the value following the flag, or '' if the flag is
 *                   absent / has no following token.
 */
function findFlagValue(argv, name) {
  if (!Array.isArray(argv)) return '';
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return '';
  const v = argv[i + 1];
  // Defensive: if the "value" is actually the next flag (--foo --bar), the
  // user passed `--foo` as a boolean — treat as absent.
  if (typeof v !== 'string' || v.startsWith('--')) return '';
  return v;
}

/**
 * Test whether a boolean flag is present in argv.
 *
 * @param {string[]} argv
 * @param {string} name
 * @returns {boolean}
 */
function hasFlag(argv, name) {
  return Array.isArray(argv) && argv.includes(name);
}

/**
 * Parse an integer flag value with a numeric default.
 *
 * @param {string[]} argv
 * @param {string} name
 * @param {number} defaultValue
 * @returns {number} the parsed int, or `defaultValue` if the flag is absent
 *                   or the value isn't a finite integer.
 */
function parseIntFlag(argv, name, defaultValue) {
  const raw = findFlagValue(argv, name);
  if (raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Build the `android:{}` dry-run block.
 *
 * Shape mirrors lib/orchestrators/android-orchestrator.js real-run + list-
 * only emission sites. All 4 fields always present; values echo user input
 * or default to ''.
 *
 * @param {object} input
 * @param {string} [input.device]      — value of --device (or '')
 * @param {string} [input.deviceTask]  — value of --device-task (or '')
 * @param {string} [input.flavor]      — value of --flavor (or '')
 * @param {Array<string|{name:string}>} [input.modules] — instrumented modules
 *   (post-filter); auto-coerces `{name}` objects to strings.
 * @returns {{device_serial:string, device_task:string, flavor:string, instrumented_modules:string[]}}
 */
function buildAndroidBlock({ device = '', deviceTask = '', flavor = '', modules = [] } = {}) {
  return {
    device_serial: device || '',
    device_task: deviceTask || '',
    flavor: flavor || '',
    instrumented_modules: (modules || [])
      .map(m => (typeof m === 'string' ? m : m && m.name) || '')
      .filter(Boolean),
  };
}

/**
 * Build the `benchmark:{}` dry-run block.
 *
 * Shape mirrors lib/orchestrators/benchmark-orchestrator.js real-run
 * emission (L586-594). All 7 fields always present; counters default to 0,
 * platforms[] to [], `config` echoes --config (default 'smoke' per
 * SUBCOMMAND_HELP).
 *
 * @param {object} input
 * @param {string} [input.config]      — value of --config (default 'smoke')
 * @param {number} [input.timeoutMs]   — resolved per-config timeout (default 0)
 * @returns {{config:string, total:number, passed:number, failed:number,
 *            timed_out:number, platforms:string[], timeout_ms:number}}
 */
function buildBenchmarkBlock({ config = 'smoke', timeoutMs = 0 } = {}) {
  return {
    config: config || 'smoke',
    total: 0,
    passed: 0,
    failed: 0,
    timed_out: 0,
    platforms: [],
    timeout_ms: Number.isFinite(timeoutMs) ? timeoutMs : 0,
  };
}

/**
 * Build the `changed:{}` dry-run block.
 *
 * Shape mirrors lib/orchestrators/changed-orchestrator.js real-run
 * emission (L477-481). `staged_only` echoes --staged-only; `base_ref` is
 * always 'HEAD' (the only base-ref the `changed` subcommand supports today).
 *
 * @param {object} input
 * @param {boolean} [input.stagedOnly] — whether --staged-only was passed
 * @returns {{detected_modules:string[], staged_only:boolean, base_ref:string}}
 */
function buildChangedBlock({ stagedOnly = false } = {}) {
  return {
    detected_modules: [],
    staged_only: !!stagedOnly,
    base_ref: 'HEAD',
  };
}

/**
 * Build the `parallel:{}` dry-run block.
 *
 * Shape mirrors lib/orchestrators/parallel-orchestrator.js real-run
 * top-level `parallel:{}` field. `legs` is empty on dry-run (no leg
 * dispatch); `test_type` defaults to 'auto', `max_workers` to 0 (gradle
 * default), `timeout_s` to 600 (per SUBCOMMAND_HELP default).
 *
 * @param {object} input
 * @param {string} [input.testType]   — value of --test-type (default 'auto')
 * @param {number} [input.maxWorkers] — value of --max-workers (default 0)
 * @param {number} [input.timeoutS]   — value of --timeout in seconds (default 600)
 * @returns {{test_type:string, max_workers:number, timeout_s:number, legs:Array}}
 */
function buildParallelBlock({ testType = 'auto', maxWorkers = 0, timeoutS = 600 } = {}) {
  return {
    test_type: testType || 'auto',
    max_workers: Number.isFinite(maxWorkers) ? maxWorkers : 0,
    timeout_s: Number.isFinite(timeoutS) ? timeoutS : 600,
    legs: [],
  };
}

/**
 * Adapter — build the subcommand-specific dry-run block from raw `finalArgs`
 * (the dispatcher's post-translation argv). Used by the script-dispatcher,
 * which doesn't have parsed `opts` at the dry-run short-circuit.
 *
 * @param {string} sub — 'android' | 'benchmark' | 'changed' | 'parallel'
 *                       (coverage has no subcommand-specific block on dry-run)
 * @param {string[]} finalArgs — the resolved kebab-case CLI argv
 * @param {{modules?:Array}} plan — the resolved plan (for android's
 *                                  instrumented_modules[] echo)
 * @returns {object|null} the block object, or `null` if `sub` has no block.
 */
function buildDryRunBlockFromArgv(sub, finalArgs, plan = {}) {
  switch (sub) {
    case 'android':
      return buildAndroidBlock({
        device: findFlagValue(finalArgs, '--device'),
        deviceTask: findFlagValue(finalArgs, '--device-task'),
        flavor: findFlagValue(finalArgs, '--flavor'),
        modules: plan && Array.isArray(plan.modules) ? plan.modules : [],
      });
    case 'benchmark':
      return buildBenchmarkBlock({
        config: findFlagValue(finalArgs, '--config') || 'smoke',
        timeoutMs: 0,
      });
    case 'changed':
      return buildChangedBlock({
        stagedOnly: hasFlag(finalArgs, '--staged-only'),
      });
    case 'parallel':
      return buildParallelBlock({
        testType: findFlagValue(finalArgs, '--test-type') || 'auto',
        maxWorkers: parseIntFlag(finalArgs, '--max-workers', 0),
        timeoutS: parseIntFlag(finalArgs, '--timeout', 600),
      });
    default:
      return null;
  }
}

export {
  buildAndroidBlock,
  buildBenchmarkBlock,
  buildChangedBlock,
  buildParallelBlock,
  buildDryRunBlockFromArgv,
  // Helpers exported for direct test coverage.
  findFlagValue,
  hasFlag,
  parseIntFlag,
};
