#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/isolation-probe.mjs -- automated pre-session isolation probe (eval-v2,
// design.md (c)). The direct fix for Evidence1's own HIGH-severity, primary-metric-affecting
// disclosed threat: the scenario's full ground truth sitting in plain JSON on the guest
// filesystem, confirmed by reading a real committed scenario file directly (research-v1.md item
// 4). This module never itself decides WHERE a session may run -- it is a pure, synchronously
// callable check a caller runs against a materialized workspace (and its temp-root siblings)
// AFTER materialization and BEFORE a session dispatches, per design.md (c)'s own three checks:
//
//  1. No file under the given roots contains any of the current scenario's own `expected` values
//     (module path, outcome_kind, and the specific coverage/count numbers) as a literal substring.
//  2. For a free cell specifically: no SKILL.md, no bin/kmp-test.js-shaped file, and no
//     .codex/hooks.json exists anywhere under the given roots.
//  3. Neither a `corpus/scenarios` path segment nor an `evidence*-preregistration*.md`-shaped
//     filename exists anywhere under the given roots.
//
// A cell that fails this probe must not dispatch -- recorded as a harness-integrity failure, the
// same severity class Evidence1's own preregistration already uses for other structural gates
// (design.md (c)'s own final paragraph), never folded into "rejected" or "missing".
//
// Deliberately synchronous and dependency-free (no import from cli.mjs/matrix-runner.mjs): this
// runs as a last-mile filesystem check, not part of the harness's own orchestration graph, and
// must stay independently testable and independently trustworthy of whatever it is checking.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

// Files this large are never scenario-leak-relevant (JSON prompts/config, source files, logs) --
// skipped by size alone rather than attempting a partial read, so a stray multi-gigabyte binary
// (a Gradle wrapper jar, a git pack file) can never make this probe slow or exhaust memory.
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

const CORPUS_SCENARIOS_SEGMENT_RE = /[\\/]corpus[\\/]scenarios(?:[\\/]|$)/;
const PREREGISTRATION_FILENAME_RE = /^evidence\d*-preregistration.*\.md$/i;
const KMP_TEST_SHIM_FILENAME_RE = /^kmp-test(\.js|\.cmd)?$/i;

/** Recursively enumerates every regular file under `root` (root itself may not exist -- treated
 * as empty, never an error, since a temp-root sibling a given cell never created is a legitimate,
 * common case). Symlinks are not followed (lstat semantics via readdirSync withFileTypes), so this
 * can never be tricked into scanning outside `root` via a symlink planted by a prior cell. */
function listFilesRecursive(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // missing/unreadable directory -- nothing to scan, not a probe failure by itself
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

/** The exact, closed set design.md (c) itself enumerates -- "module path, the specific
 * missed-lines/threshold numbers, outcome_kind string" -- deliberately never wider than that
 * literal list. Values outside it (individual_total, evidence_task, etc.) were considered and
 * dropped: they are not in design.md's own enumeration, and unlike missed_lines/threshold (which
 * are real, scenario-authored numbers with no reason to ever be single-digit) a per-scenario count
 * like individual_total can legitimately be small enough (this repo's own anchor scenario has
 * individual_total:4) that checking it would mean either accepting single-character false-positive
 * risk everywhere or silently under-covering exactly the scenarios where it is small -- neither of
 * which design.md asked for. `min_missed_lines` is the scenario's own threshold value under its
 * kmp_test.coverage key name; still "the threshold number" design.md's own text names.
 */
export function extractSensitiveValues(expected) {
  const values = [];
  const push = (label, value) => {
    if (value == null) return;
    const text = String(value);
    if (text.length === 0) return;
    values.push({ label, value: text });
  };
  push('module', expected?.module);
  push('outcome_kind', expected?.outcome_kind);
  push('kmp_test.coverage.missed_lines', expected?.kmp_test?.coverage?.missed_lines);
  push('kmp_test.coverage.min_missed_lines', expected?.kmp_test?.coverage?.min_missed_lines);
  return values;
}

/** Check 1: scans every file under `roots` for any of `expected`'s own sensitive values as a
 * literal substring. Binary/unreadable files are skipped (never treated as a pass OR a failure by
 * themselves -- a probe that silently ignored a file it could not read would be worse than one
 * that scans slightly less; a probe that FAILED closed on every unreadable file would flag normal
 * binary assets like a Gradle wrapper jar constantly). Returns every match found, not just the
 * first -- a caller deciding whether to dispatch only needs to know `violations.length === 0`, but
 * a real leak is worth reporting completely, not just as a single boolean.
 */
export function findLeakedExpectedValues({ roots, expected }) {
  const sensitiveValues = extractSensitiveValues(expected);
  const violations = [];
  if (sensitiveValues.length === 0) return violations;
  for (const root of roots) {
    for (const filePath of listFilesRecursive(root)) {
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      if (stat.size > MAX_SCANNED_FILE_BYTES) continue;
      let content;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue; // not readable as text (binary, permission) -- not scannable, not a violation
      }
      for (const { label, value } of sensitiveValues) {
        if (content.includes(value)) {
          violations.push({ code: 'expected_value_leaked', path: filePath, detail: `contains expected.${label} (${JSON.stringify(value)})` });
        }
      }
    }
  }
  return violations;
}

/** Check 2 (free cells only): no skill snapshot, no kmp-test shim, no Codex hooks config may exist
 * anywhere under the given roots -- a free (no-product) cell has no legitimate reason to have any
 * of these materialized anywhere it could reach, even outside its own PATH (design.md (c): "create
 * the skill snapshot and kmp-test shim only when a product cell is actually planned, and
 * materialize them outside the free cell's own workspace and outside anything on its ambient
 * %TEMP%"). Matches by FILENAME (never by directory name alone, which would over-match e.g. a
 * project's own unrelated `skill/` source directory).
 */
export function findProductSurfaceForFreeCell({ roots }) {
  const violations = [];
  for (const root of roots) {
    for (const filePath of listFilesRecursive(root)) {
      const filename = filePath.split(sep).pop();
      if (filename === 'SKILL.md') {
        violations.push({ code: 'skill_snapshot_present_for_free_cell', path: filePath, detail: 'SKILL.md must not exist anywhere for a free (no-product) cell' });
      } else if (KMP_TEST_SHIM_FILENAME_RE.test(filename)) {
        violations.push({ code: 'kmp_test_shim_present_for_free_cell', path: filePath, detail: 'a kmp-test-shaped shim must not exist anywhere for a free (no-product) cell' });
      } else if (filename === 'hooks.json' && filePath.split(sep).includes('.codex')) {
        violations.push({ code: 'codex_hooks_present_for_free_cell', path: filePath, detail: '.codex/hooks.json must not exist anywhere for a free (no-product) cell' });
      }
    }
  }
  return violations;
}

/** Check 3: neither the harness's own scenario corpus directory nor a preregistration document
 * shaped filename may exist anywhere under the given roots, for ANY cell (product or free) --
 * once grading moves host-side (design.md (c)), the guest-side harness checkout no longer needs to
 * ship either at all. Path-segment matching (corpus/scenarios) rather than a bare directory-name
 * check, so this cannot be defeated by a differently-rooted copy.
 */
export function findForbiddenHarnessPaths({ roots }) {
  const violations = [];
  for (const root of roots) {
    for (const filePath of listFilesRecursive(root)) {
      const filename = filePath.split(sep).pop();
      if (CORPUS_SCENARIOS_SEGMENT_RE.test(filePath)) {
        violations.push({ code: 'corpus_scenarios_present', path: filePath, detail: 'a corpus/scenarios path must not exist anywhere under a materialized guest checkout' });
      } else if (PREREGISTRATION_FILENAME_RE.test(filename)) {
        violations.push({ code: 'preregistration_doc_present', path: filePath, detail: 'a preregistration-shaped document must not exist anywhere under a materialized guest checkout' });
      }
    }
  }
  return violations;
}

/** The full pre-session probe, combining all three design.md (c) checks. `roots` is the
 * materialized workspace directory PLUS every temp-root sibling this cell's own materialization
 * step created (skill snapshot dir, kmp-test shim dir, Gradle snapshot dir, etc.) -- a caller
 * assembling this list is expected to pass every directory it itself just created or resolved for
 * this cell, never a guess. Never throws: a filesystem error scanning one root does not prevent
 * every other root/check from still running and being reported.
 * @param {{roots: string[], expected: object, isFreeCell: boolean}} args
 * @returns {{ok: boolean, violations: Array<{code: string, path: string, detail: string}>}}
 */
export function checkIsolationProbe({ roots, expected, isFreeCell }) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new TypeError('checkIsolationProbe: roots must be a non-empty array of directory paths');
  }
  const violations = [
    ...findLeakedExpectedValues({ roots, expected }),
    ...findForbiddenHarnessPaths({ roots }),
    ...(isFreeCell ? findProductSurfaceForFreeCell({ roots }) : []),
  ];
  return { ok: violations.length === 0, violations };
}
