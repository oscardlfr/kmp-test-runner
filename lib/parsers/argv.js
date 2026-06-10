// SPDX-License-Identifier: MIT
// lib/parsers/argv.js — argv parsers.
//
// Pure helpers that read or consume flags from a Node argv array. cli.js
// re-exports every name via its export block so external consumers (tests,
// orchestrators, lib/commands/doctor.js) keep importing from './cli.js'
// through ESM live bindings.

/**
 * Resolve `--project-root <path>` from argv, falling back to process.cwd().
 * @param {string[]} args - CLI argv array.
 * @returns {string} Absolute or relative project-root path.
 */
export function getProjectRoot(args) {
  const idx = args.indexOf('--project-root');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return process.cwd();
}

export function getCoverageToolFromArgs(args) {
  const idx = args.indexOf('--coverage-tool');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return 'auto';
}

export function getBenchmarkPlatform(args) {
  const idx = args.indexOf('--platform');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return 'all';
}

export function getBenchmarkConfigFromArgs(args) {
  // Accept both POSIX (`--config`) and PowerShell-translated (`-Config`) forms.
  const idx = args.findIndex(a => a === '--config' || a === '-Config');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
}

// Strip --json / --format json from args; return cleaned args + flag.
export function consumeJsonFlag(args) {
  const out = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { json = true; continue; }
    if (args[i] === '--format' && args[i + 1] === 'json') { json = true; i++; continue; }
    out.push(args[i]);
  }
  return { args: out, json };
}

// Strip --dry-run from args; return cleaned args + flag.
export function consumeDryRunFlag(args) {
  const out = [];
  let dryRun = false;
  for (const a of args) {
    if (a === '--dry-run') { dryRun = true; continue; }
    out.push(a);
  }
  return { args: out, dryRun };
}

// Strip --force from args; return cleaned args + flag.
export function consumeForceFlag(args) {
  const out = [];
  let force = false;
  for (const a of args) {
    if (a === '--force') { force = true; continue; }
    out.push(a);
  }
  return { args: out, force };
}

// Check (without consuming) if --ignore-jdk-mismatch is present. The flag
// passes through to the underlying script so script-level callers honor it too.
export function getIgnoreJdkMismatch(args) {
  return args.includes('--ignore-jdk-mismatch');
}

// v0.6.x Gap 2: read --java-home <path> WITHOUT consuming. The flag also
// passes through to the sh/ps1 scripts (which accept it natively) so the
// script-level JDK gate also bypasses. Defense in depth.
export function getJavaHomeOverride(args) {
  const i = args.indexOf('--java-home');
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

// v0.6.x Gap 2: consume --no-jdk-autoselect (CLI-only flag — scripts don't
// know about it, so we strip it from the spawn argv).
export function extractNoJdkAutoselect(args) {
  const out = [];
  let noAutoselect = false;
  for (const a of args) {
    if (a === '--no-jdk-autoselect') { noAutoselect = true; continue; }
    out.push(a);
  }
  return { args: out, noAutoselect };
}

// Expand `--no-coverage` to `--coverage-tool none` so the alias works on both
// platforms. Without this, `translateFlagForPowerShell` would emit `-NoCoverage`
// (a switch the .ps1 scripts don't declare) and bash scripts would also reject
// the unknown flag — neither side has ever wired up `--no-coverage` directly,
// only `--coverage-tool none`. If `--coverage-tool` is already explicit, the
// user's choice wins and `--no-coverage` is dropped silently (last-wins would
// be ambiguous, conservative passthrough is cleaner).
export function expandNoCoverageAlias(args) {
  if (!args.includes('--no-coverage')) return args;
  const hasExplicitCoverageTool = args.includes('--coverage-tool');
  const out = [];
  for (const a of args) {
    if (a === '--no-coverage') continue;
    out.push(a);
  }
  if (!hasExplicitCoverageTool) {
    out.push('--coverage-tool', 'none');
  }
  return out;
}

// Strip --test-filter <pattern> from args; return cleaned args + pattern (or null).
export function consumeTestFilter(args) {
  const out = [];
  let pattern = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--test-filter' && args[i + 1] !== undefined) {
      pattern = args[i + 1];
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return { args: out, pattern };
}

// Strip `--color <mode>` and `--color=<mode>` from args; return cleaned
// args + parsed mode (or null when absent). Validation happens here so
// cli.js can surface an invalid_args envelope before any orchestrator
// runs. Accepted values are 'always', 'never', 'auto' (POSIX-ish triple).
export function consumeColorFlag(args) {
  const VALID = ['always', 'never', 'auto'];
  const out = [];
  let mode = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--color' && args[i + 1] !== undefined) {
      mode = args[i + 1];
      i++;
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--color=')) {
      mode = a.slice('--color='.length);
      continue;
    }
    out.push(a);
  }
  if (mode !== null && !VALID.includes(mode)) {
    throw new Error(`invalid --color value: ${mode} (expected one of: ${VALID.join(', ')})`);
  }
  return { args: out, mode };
}

// Peek at `--isolated*` flags WITHOUT stripping. The
// orchestrators strip + parse them themselves (via
// orchestrator-utils.js#parseIsolatedArgs) so they can emit the resulting
// state in their envelope. cli.js only needs `noLock` for the Tier 1
// acquireLock decision; we read all three for symmetry / future use.
// `errors` carries `invalid_flag_value` entries for a dangling / empty
// `--isolated-cache-dir`; cli.js rejects BEFORE the acquireLock decision and
// the wrapper spawn (pre-fix the lock was taken while isolation silently
// stayed off and the dangling token leaked into orchestrator args).
export function peekIsolatedFlags(args) {
  let enabled = false;
  let cacheDir = null;
  let noLock = false;
  const errors = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--isolated') enabled = true;
    // `--isolated-no-lock` implies `--isolated`. The
    // help text documents the implication; pre-fix passing `--isolated-no-lock`
    // alone produced `isolated:{enabled:false, locked:false}` (a nonsensical
    // shape — locked:false but no isolation actually applied). Mirrors the
    // existing `--isolated-cache-dir` branch below.
    else if (args[i] === '--isolated-no-lock') { noLock = true; enabled = true; }
    else if (args[i] === '--isolated-cache-dir') {
      const v = args[i + 1];
      if (v === undefined || v === '') {
        // Dangling (last token) or explicit-empty. The caller pre-expands
        // equals forms (cli.js#main), so `--isolated-cache-dir=` arrives
        // here as ['--isolated-cache-dir', ''].
        errors.push({
          code: 'invalid_flag_value',
          flag: '--isolated-cache-dir',
          value: v ?? null,
          message: '--isolated-cache-dir: missing required <path> value',
        });
        if (v !== undefined) i++;
      } else {
        cacheDir = v;
        enabled = true;
        i++;
      }
    }
  }
  return { enabled, cacheDir, noLock, errors };
}
