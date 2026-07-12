#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/check-line-endings.mjs — line-ending guard.
//
// Parses .gitattributes for eol=lf rules, scans committed files that match,
// and fails with actionable guidance if CRLF is found.
//
// Source of truth for patterns: .gitattributes only — no hardcoded patterns.
//
// Usage:
//   node tools/check-line-endings.mjs    # exit 0 on pass, exit 1 on violation
//   npm run check-line-endings
//
// Exports: parseLFPatterns, shouldCheckLF, hasCRLF, checkFiles (for unit tests)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const GITATTRIBUTES_PATH = join(REPO_ROOT, '.gitattributes');

// ---------------------------------------------------------------------------
// Glob-to-regex conversion (git-attributes subset)

const REGEX_META = /[.+^${}()|[\]\\]/;

/**
 * Convert a git-attributes glob pattern to a JS RegExp anchored to repo root.
 * Handles: * (non-slash), ** / (zero-or-more dirs), ? (single non-slash char).
 *
 * Supported subset: patterns that contain at least one '/'. All current
 * .gitattributes eol=lf patterns contain '/', so they are matched root-anchored
 * (relative to the repo root). Patterns WITHOUT '/' have different git semantics
 * (recursive filename match), which this tool does NOT implement — if a no-slash
 * pattern like `*.sh text eol=lf` is ever added to .gitattributes, update this
 * function to handle the recursive case.
 */
function gitGlobToRegex(pattern) {
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && i + 1 < pattern.length && pattern[i + 1] === '*') {
      // ** — matches zero or more path components
      i += 2;
      if (i < pattern.length && pattern[i] === '/') {
        // **/ → zero-or-more directories (including zero)
        result += '(?:.+/)?';
        i++; // consume the trailing /
      } else {
        // ** at end or before non-/ — matches anything
        result += '.*';
      }
    } else if (ch === '*') {
      // * — matches any non-slash sequence
      result += '[^/]*';
      i++;
    } else if (ch === '?') {
      // ? — matches any single non-slash character
      result += '[^/]';
      i++;
    } else if (REGEX_META.test(ch)) {
      result += '\\' + ch;
      i++;
    } else {
      result += ch;
      i++;
    }
  }
  return new RegExp(`^${result}$`);
}

// ---------------------------------------------------------------------------
// .gitattributes parser

/**
 * Parse .gitattributes text and return the list of patterns requiring LF.
 * @param {string} text — raw .gitattributes content
 * @returns {{ raw: string, regex: RegExp }[]}
 */
export function parseLFPatterns(text) {
  const patterns = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [pattern, ...attrTokens] = trimmed.split(/\s+/);
    if (!pattern) continue;
    const attrStr = attrTokens.join(' ');
    if (attrStr.includes('eol=lf')) {
      patterns.push({ raw: pattern, regex: gitGlobToRegex(pattern) });
    }
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// Per-file helpers

/**
 * Returns true if the Buffer contains a CRLF sequence (0x0D followed by 0x0A).
 * @param {Buffer} buf
 */
export function hasCRLF(buf) {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return true;
  }
  return false;
}

/**
 * Returns true if relPath matches any of the LF-required patterns.
 * Normalizes backslashes to forward slashes for cross-platform safety.
 * @param {string} relPath
 * @param {{ raw: string, regex: RegExp }[]} lfPatterns
 */
export function shouldCheckLF(relPath, lfPatterns) {
  const normalized = relPath.replace(/\\/g, '/');
  return lfPatterns.some(p => p.regex.test(normalized));
}

// ---------------------------------------------------------------------------
// Core check

/**
 * Checks each relative path for CRLF violations.
 * Skips paths that don't match any LF pattern and paths that don't exist on disk.
 * @param {string[]} relPaths — relative paths from repo root (as from git ls-files)
 * @param {string} repoRoot — absolute repo root
 * @param {{ raw: string, regex: RegExp }[]} lfPatterns
 * @returns {{ checked: number, violations: string[] }}
 */
export function checkFiles(relPaths, repoRoot, lfPatterns) {
  let checked = 0;
  const violations = [];
  for (const rel of relPaths) {
    if (!shouldCheckLF(rel, lfPatterns)) continue;
    const absPath = join(repoRoot, rel);
    if (!existsSync(absPath)) continue;
    checked++;
    if (hasCRLF(readFileSync(absPath))) {
      violations.push(rel.replace(/\\/g, '/'));
    }
  }
  return { checked, violations };
}

// ---------------------------------------------------------------------------
// CLI entry point

function main() {
  if (!existsSync(GITATTRIBUTES_PATH)) {
    console.log('[line-endings] SKIP — .gitattributes not found; nothing to check.');
    process.exit(0);
  }
  const gitattributesText = readFileSync(GITATTRIBUTES_PATH, 'utf8');
  const lfPatterns = parseLFPatterns(gitattributesText);
  if (lfPatterns.length === 0) {
    console.log('[line-endings] OK — no eol=lf patterns in .gitattributes; nothing to check.');
    process.exit(0);
  }

  // Enumerate tracked files via git ls-files.
  // git is a real executable on all platforms (not a .cmd script), so no
  // cmd.exe routing is needed (compare check-bundle-size.mjs which routes
  // npm through cmd.exe because npm.cmd is a Windows batch script).
  const r = spawnSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) {
    console.error('[line-endings] FAIL — `git ls-files` exited non-zero.');
    console.error(r.stderr || '(no output)');
    process.exit(2);
  }

  const relPaths = (r.stdout || '').trim().split('\n').filter(Boolean);
  const { checked, violations } = checkFiles(relPaths, REPO_ROOT, lfPatterns);

  if (violations.length > 0) {
    console.error(`[line-endings] FAIL — CRLF detected in LF-required files (${violations.length} file(s)):`);
    for (const v of violations) console.error(`  ${v}`);
    console.error('');
    console.error('Fix: git add --renormalize . && git commit --amend --no-edit');
    console.error('Or add/fix .gitattributes rules and re-commit the affected files.');
    process.exit(1);
  }

  console.log(`[line-endings] OK — ${checked} LF-required file(s) checked, 0 violations.`);
}

// Only run when invoked as the CLI entry point, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
