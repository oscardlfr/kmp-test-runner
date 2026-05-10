// SPDX-License-Identifier: MIT
// lib/runners/shell-runner.js — Shell/PowerShell helpers for cli.js dispatcher.
//
// Refactor PR-06 (pre-v0.10) — extracted from lib/cli.js. Pure helpers for
// resolving the script wrapper to invoke (sh on POSIX, ps1 on Windows) and
// for translating bash long-flags to their PowerShell PascalCase form before
// the spawn. cli.js re-exports every name through its existing `export {}`
// block so external consumers (tests, orchestrators) keep importing from
// './cli.js' unchanged via ESM live bindings — same pattern already used by
// lib/commands/doctor.js (PR-04).
//
// COMMANDS is imported back from cli.js (live binding) so resolveScript()
// stays close to its only caller and we don't have to invert the dependency
// direction. Cycle resolves at runtime since COMMANDS is only read inside
// resolveScript() bodies, never at module-evaluation time.

import { spawnSync } from 'node:child_process';
import { COMMANDS } from '../cli.js';

function pickWindowsShell() {
  const probe = spawnSync('pwsh', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
  if (probe.status === 0) return 'pwsh';
  return 'powershell.exe';
}

// Translates a long-form bash flag (--project-root) to PowerShell PascalCase (-ProjectRoot).
// Values and positional args pass through unchanged.
//
// v0.9 session 2 Bug-A.1 — POSIX `--name=value` form: split on the FIRST `=`
// before walking dash segments, so the value is preserved verbatim. Without
// this, `--module-filter=:foo-bar` was translated to `-ModuleFilter=:fooBar`
// (mangling `foo-bar` → `fooBar`) and `--gradle-args=--rerun-tasks` to
// `-GradleArgs=RerunTasks` (losing the value's leading `--`).
function translateFlagForPowerShell(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) return arg;
  const eq = arg.indexOf('=');
  const head = eq > 2 ? arg.slice(0, eq) : arg;
  const tail = eq > 2 ? arg.slice(eq) : '';
  const rest = head.slice(2);
  return '-' + rest.split('-')
    .map(w => w.length === 0 ? '' : w[0].toUpperCase() + w.slice(1))
    .join('') + tail;
}

// v0.9 step 2 — PowerShell-binding hazards for the new --gradle-args flag.
//
// Two pitfalls when bridging bash-form `--gradle-args VAL` to the PowerShell
// wrapper:
//   1. PowerShell binds [string[]] parameters via COMMA syntax, NOT repeated
//      `-Param`. `-GradleArgs A -GradleArgs B` errors with "specified more
//      than once". We can't use comma either: gradle props naturally contain
//      commas (e.g. `-Pfoo=a,b`).
//   2. translateFlagForPowerShell maps every arg starting with `--` to its
//      PascalCase form. That correctly handles flags but mangles --gradle-args
//      VALUES that themselves start with `--` (e.g. `--no-parallel` would be
//      translated to `-NoParallel`, which gradle doesn't recognise).
//
// Combined fix:
//   * collapseGradleArgs (called BEFORE translation) joins repeated
//     `--gradle-args` invocations into a single arg whose value is the
//     sentinel-joined list. ASCII Unit Separator (\x1F) is guaranteed not
//     to appear in gradle CLI flags.
//   * translateBashFlagsForPowerShell replaces the simple `.map()`. It
//     preserves the value immediately after `--gradle-args` verbatim so
//     a value like `--no-parallel\x1F-Pfoo=bar` survives intact.
//   * The ps1 wrapper splits on \x1F and re-emits one `--gradle-args <tok>`
//     per element so the Node-side parser sees the canonical multi-invocation
//     shape.
const PS_GRADLE_ARGS_SEP = '\u001F';
function collapseGradleArgs(args) {
  const out = [];
  const collected = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gradle-args' && i + 1 < args.length) {
      collected.push(args[i + 1]);
      i++;
    } else {
      out.push(args[i]);
    }
  }
  if (collected.length > 0) out.push('--gradle-args', collected.join(PS_GRADLE_ARGS_SEP));
  return out;
}
function translateBashFlagsForPowerShell(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    out.push(translateFlagForPowerShell(a));
    if (a === '--gradle-args' && i + 1 < args.length) {
      // Value of --gradle-args is opaque pass-through; never translate.
      out.push(args[++i]);
    }
  }
  return out;
}

function resolveScript(sub, platform) {
  const cmd = COMMANDS[sub];
  if (!cmd) return null;
  return {
    script: platform === 'win32' ? cmd.ps1 : cmd.sh,
    prefix: cmd.prefix,
  };
}

export {
  pickWindowsShell,
  translateFlagForPowerShell,
  PS_GRADLE_ARGS_SEP,
  collapseGradleArgs,
  translateBashFlagsForPowerShell,
  resolveScript,
};
