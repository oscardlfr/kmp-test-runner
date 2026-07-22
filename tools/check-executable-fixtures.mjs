#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/check-executable-fixtures.mjs — executable-bit guard for fake-claude fixture scripts.
//
// Surfaced by the feature/agentic-foreign-skill-diagnostics incident: two new
// tests/fixtures/fake-claude-*/claude fixtures were committed at git mode 100644 instead of
// 100755 (a Windows-side `Write` doesn't preserve the POSIX executable bit the way an
// existing-file copy or an explicit chmod does). This repo's OWN local-ci Linux lane could not
// catch it -- tools/local-ci/container/prepare-source.sh deliberately resets every file to 0644
// and re-derives the executable bit from a shebang-sniff (`head -c 2 == '#!'`), working around
// WSL's DrvFs reporting unreliable Windows-filesystem permission bits. That heuristic is correct
// for its own purpose (approximating a real Linux checkout when the SOURCE tree only exists on an
// NTFS mount) but is blind to the actual git-tracked mode -- it will silently "fix" this exact bug
// class forever, locally, while a real checkout (GitHub Actions' actions/checkout, which honors
// the tracked index mode faithfully) fails outright: `bash -c "claude ..."` resolves `claude` via
// PATH, hits "Permission denied" (exit 126), and produces an empty transcript. This check reads
// git's ACTUAL tracked mode directly (`git ls-files -s`), independent of any on-disk heuristic, so
// the gap is closed on every platform, not just the one where DrvFs-masking happens not to apply.
//
// Scope deliberately narrow, not "every shebang script must be +x": this repo has several
// shebang-carrying .sh files that are legitimately 100644 (sourced libraries like
// scripts/sh/lib/project-model.sh, or files explicitly chmod'd inside a Dockerfile after copy like
// tools/local-ci/container/*.sh) -- a blanket shebang-implies-executable rule would false-positive
// on those. fake-claude-*/claude fixtures are the one family actually invoked via bare PATH lookup
// (`claude` inside a spawned `bash -c` command line), the exact mechanism this bug broke; mirrors
// .gitattributes' own equally narrow `tests/fixtures/fake-claude-*/claude text eol=lf` rule for
// the same fixture family (a different git-tracked property, same narrow scope rationale).
//
// Usage:
//   node tools/check-executable-fixtures.mjs    # exit 0 on pass, exit 1 on violation
//   npm run check-executable-fixtures
//
// Exports: EXECUTABLE_FIXTURE_PATTERN, parseLsFilesStageLine, findExecutableBitViolations (for unit tests)

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const EXECUTABLE_FIXTURE_PATTERN = /^tests\/fixtures\/fake-claude-[^/]+\/claude$/;

/**
 * Parses one line of `git ls-files -s` output (`<mode> <SP> <hash> <SP> <stage> <TAB> <path>`)
 * into `{mode, path}`, or returns null for a line that doesn't match the expected shape.
 * Backslashes normalized to forward slashes so this matches identically regardless of which
 * platform ran `git ls-files` (Windows' git still prints paths with forward slashes in practice,
 * but normalizing costs nothing and removes the assumption).
 * @param {string} line
 * @returns {{mode: string, path: string}|null}
 */
export function parseLsFilesStageLine(line) {
  const m = line.match(/^(\d{6})\s+\S+\s+\d+\t(.+)$/);
  if (!m) return null;
  return { mode: m[1], path: m[2].replace(/\\/g, '/') };
}

/**
 * @param {string} lsFilesOutput - raw stdout from `git ls-files -s`
 * @returns {{path: string, mode: string}[]} every fake-claude fixture `claude` script NOT tracked as 100755
 */
export function findExecutableBitViolations(lsFilesOutput) {
  const violations = [];
  for (const line of lsFilesOutput.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseLsFilesStageLine(line);
    if (!parsed) continue;
    if (EXECUTABLE_FIXTURE_PATTERN.test(parsed.path) && parsed.mode !== '100755') {
      violations.push(parsed);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// CLI entry point

function main() {
  const r = spawnSync('git', ['ls-files', '-s'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) {
    console.error('[executable-fixtures] FAIL — `git ls-files -s` exited non-zero.');
    console.error(r.stderr || '(no output)');
    process.exit(2);
  }

  const violations = findExecutableBitViolations(r.stdout || '');

  if (violations.length > 0) {
    console.error(`[executable-fixtures] FAIL — fake-claude fixture(s) tracked without the executable bit (${violations.length} file(s)):`);
    for (const v of violations) console.error(`  ${v.path} (mode ${v.mode}, expected 100755)`);
    console.error('');
    console.error('Fix: git update-index --chmod=+x <path>, then commit the mode change.');
    process.exit(1);
  }

  const checked = (r.stdout || '').split('\n').filter((l) => l.trim() && EXECUTABLE_FIXTURE_PATTERN.test(parseLsFilesStageLine(l)?.path ?? '')).length;
  console.log(`[executable-fixtures] OK — ${checked} fake-claude fixture(s) checked, 0 violations.`);
}

// Only run when invoked as the CLI entry point, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
