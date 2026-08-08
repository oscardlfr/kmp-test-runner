// SPDX-License-Identifier: MIT
// lib/orchestrators/module-filter.js — pure `--module-filter` matching semantics (glob + comma-CSV
// + substring + colon/leaf-name tolerance). Extracted verbatim from orchestrator-utils.js (which
// re-exports these three functions for backward compatibility) so a consumer that only needs the
// matching CONTRACT — not the rest of orchestrator-utils.js's fs/child_process/console-mode
// surface — can depend on it directly. tools/agentic-eval's grading harness is exactly that
// consumer: it must judge an agent's `--module-filter` argument against the SAME rule the real CLI
// dispatch uses, never a second, independently-maintained approximation of it.
//
// No imports — a genuine leaf module.

// Split a comma-separated value into trimmed, non-empty segments.
export function splitCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Compile a glob pattern (with `*` and `?` wildcards) into a regex anchored
// at both ends. Mirrors the bash wrapper's `case` glob shape.
export function globToRegex(pattern) {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*')      re += '.*';
    else if (ch === '?') re += '.';
    else if (/[\\^$+.()|[\]{}]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re + '$');
}

// True iff `name` matches any pattern in the comma-separated CSV.
// Pattern semantics (per-pattern, not per-CSV):
//   - **No glob metacharacters** (`*` / `?`): substring match. `feature`
//     matches `feature-auth` AND `:feature:auth`. Mirrors the historical
//     android / benchmark filter contract — typing a bare term does not
//     anchor to exact match.
//   - **Glob metacharacters present**: anchored glob match. `feature-*`
//     matches `feature-auth` but not `core-feature-auth`. Mirrors the
//     historical parallel filter contract.
// In both modes we try the bare name AND the `:`-prefixed variant since
// project module names can be either form depending on settings.gradle.kts
// shape and the orchestrator's discovery normalization. Empty filter or
// `'*'` matches all.
export function matchModuleFilter(name, filterCsv) {
  if (!filterCsv || filterCsv === '*') return true;
  const patterns = splitCsv(filterCsv);
  if (patterns.length === 0) return true;
  const bareName = name.replace(/^:/, '');
  const colonName = bareName.startsWith(':') ? bareName : ':' + bareName;
  const short = bareName.split(':').pop();
  for (const pat of patterns) {
    const isGlob = /[*?]/.test(pat);
    if (isGlob) {
      const re = globToRegex(pat);
      if (re.test(name)) return true;
      if (re.test(bareName)) return true;
      if (re.test(colonName)) return true;
      if (short !== bareName && re.test(short)) return true;
    } else {
      // Substring contract — preserves historical android / benchmark behavior.
      if (name.includes(pat)) return true;
      if (bareName.includes(pat)) return true;
      if (colonName.includes(pat)) return true;
    }
  }
  return false;
}
