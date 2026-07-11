#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tools/wet-evidence.mjs — fail-closed wet-evidence generator (PR-00).
//
// Generates §4 quality-gate evidence rows for kmp-test-runner PRs.
// Sanitizes all output before emitting; refuses to emit if any redaction
// class still matches after processing (fail-closed).
//
// Usage:
//   node tools/wet-evidence.mjs \
//     --alias    <alias>               # project alias used in the evidence row
//     --cmd      "<command>"           # sanitized kmp-test command (re-redacted before emit)
//     --exit     <code>                # exit code from the kmp-test run
//     --project-kind  private|official # private runs require a private-pattern source
//     --platform windows|linux|macos|android
//     --stdout   <file|-|none>         # captured stdout: file path, '-' for stdin, 'none'
//     --stderr   <file|-|none>         # captured stderr: file path, '-' for stdin, 'none'
//     --no-output                      # explicit opt-out: no output to sanitize (= --stdout none --stderr none)
//     --private-patterns <file>        # path to private-patterns JSON (or KMP_PRIVATE_PATTERNS_FILE env)
//     --allow-missing-private-rules    # permit absent private config; only valid with --project-kind official
//     --pr       <number>              # optional PR number to embed in evidence
//     --sha      <string>              # optional git SHA to embed in evidence
//     --format   table|json            # output format; default: table
//
// Fail-closed rules:
//   1. --project-kind private without a private-pattern source exits 1.
//   2. --allow-missing-private-rules with --project-kind private exits 1.
//   3. No --stdout / --stderr / --no-output specified exits 1.
//   3b. --no-output combined with a non-none --stdout or --stderr exits 1.
//   4. Any redaction class still present in the processed output exits 1
//      (content never printed in the refusal message).
//   5. Any redaction class still present in the evidence payload string fields exits 1.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_SHAPE_RULES, loadPrivateRules, redactText, findLeaks } from './lib/redact.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const VALID_PROJECT_KINDS = new Set(['private', 'official']);
const VALID_PLATFORMS     = new Set(['windows', 'linux', 'macos', 'android']);
const VALID_FORMATS       = new Set(['table', 'json']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  process.stderr.write(`REFUSED: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    alias: null,
    cmd: null,
    exitCode: null,
    projectKind: null,
    platform: null,
    stdoutSrc: undefined,
    stderrSrc: undefined,
    noOutput: false,
    privatePatterns: null,
    allowMissingPrivate: false,
    pr: null,
    sha: null,
    format: 'table',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];

    switch (a) {
      case '--alias':            opts.alias = next;                        i++; break;
      case '--cmd':              opts.cmd = next;                          i++; break;
      case '--exit':             opts.exitCode = parseInt(next, 10);       i++; break;
      case '--project-kind':     opts.projectKind = next;                  i++; break;
      case '--platform':         opts.platform = next;                     i++; break;
      case '--stdout':           opts.stdoutSrc = next;                    i++; break;
      case '--stderr':           opts.stderrSrc = next;                    i++; break;
      case '--no-output':        opts.noOutput = true;                          break;
      case '--private-patterns': opts.privatePatterns = next;              i++; break;
      case '--allow-missing-private-rules': opts.allowMissingPrivate = true; break;
      case '--pr':               opts.pr = parseInt(next, 10);             i++; break;
      case '--sha':              opts.sha = next;                          i++; break;
      case '--format':           opts.format = next;                       i++; break;
      default:
        process.stderr.write(`wet-evidence: unknown flag: ${a}\n`);
        process.exit(1);
    }
  }

  return opts;
}

function readSrc(src, label) {
  if (!src || src === 'none') return '';
  if (src === '-') {
    try {
      // fd 0 = stdin; works on both Windows and POSIX.
      return readFileSync(0, 'utf8');
    } catch (err) {
      die(`cannot read from stdin for ${label}: ${err.message}`);
    }
  }
  try {
    return readFileSync(src, 'utf8');
  } catch (err) {
    die(`cannot read ${label} file "${src}": ${err.message}`);
  }
  return '';
}

// Escape | and strip newlines from a markdown table cell value so that a
// user-supplied command or alias cannot break column structure.
function safeCell(val) {
  return String(val).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

// Count per-class matches in text before redaction runs.
function countMatches(text, rules) {
  const counts = {};
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    const m = text.match(rule.re);
    counts[rule.class] = (counts[rule.class] || 0) + (m ? m.length : 0);
    rule.re.lastIndex = 0;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --- Required fields ----------------------------------------------------
  if (!opts.alias)     die('--alias is required');
  if (!opts.cmd)       die('--cmd is required');
  if (opts.exitCode == null || isNaN(opts.exitCode)) die('--exit <number> is required');
  if (!opts.projectKind) die('--project-kind private|official is required');
  if (!VALID_PROJECT_KINDS.has(opts.projectKind)) {
    die(`--project-kind must be "private" or "official", got "${opts.projectKind}"`);
  }
  if (!opts.platform) die('--platform windows|linux|macos|android is required');
  if (!VALID_PLATFORMS.has(opts.platform)) {
    die(`--platform must be one of: windows, linux, macos, android — got "${opts.platform}"`);
  }
  if (!VALID_FORMATS.has(opts.format)) {
    die(`--format must be "table" or "json", got "${opts.format}"`);
  }

  // --- Alias must be a safe identifier (no path separators, pipes, or control chars)
  if (!/^[A-Za-z0-9_.-]+$/.test(opts.alias)) {
    die('--alias must match ^[A-Za-z0-9_.-]+$ (use a safe project identifier)');
  }

  // --- Fail-closed rule 1: --allow-missing-private-rules incompatible with private kind
  if (opts.allowMissingPrivate && opts.projectKind === 'private') {
    die('--allow-missing-private-rules cannot be used with --project-kind private');
  }

  // --- Fail-closed rule 2: output source must be explicit -------------------
  const outputSpecified =
    opts.noOutput ||
    opts.stdoutSrc !== undefined ||
    opts.stderrSrc !== undefined;
  if (!outputSpecified) {
    die('output source not specified; use --no-output if there is no output to sanitize');
  }

  // --- Fail-closed rule 2b: --no-output must not be combined with a real source
  if (opts.noOutput) {
    const stdoutConflict = opts.stdoutSrc !== undefined && opts.stdoutSrc !== 'none';
    const stderrConflict = opts.stderrSrc !== undefined && opts.stderrSrc !== 'none';
    if (stdoutConflict || stderrConflict) {
      die('--no-output conflicts with --stdout / --stderr (use --stdout none or --stderr none to be explicit)');
    }
  }

  // --- Fail-closed rule 3: private kind needs a private-pattern source ------
  const patternFile =
    opts.privatePatterns || process.env.KMP_PRIVATE_PATTERNS_FILE || null;

  if (opts.projectKind === 'private' && !patternFile) {
    die(
      'private-kind run requires a private-pattern source ' +
      '(--private-patterns <file> or KMP_PRIVATE_PATTERNS_FILE)',
    );
  }

  // --- Load rules -----------------------------------------------------------
  const rules = [...PUBLIC_SHAPE_RULES];
  if (patternFile) {
    let privateRules;
    try {
      privateRules = loadPrivateRules(patternFile);
    } catch (err) {
      die(`cannot load private patterns: ${err.message}`);
    }
    rules.push(...privateRules);
  }

  // --- Read output ----------------------------------------------------------
  let combinedOutput = '';
  if (!opts.noOutput) {
    const stdoutText = opts.stdoutSrc != null ? readSrc(opts.stdoutSrc, 'stdout') : '';
    const stderrText = opts.stderrSrc != null ? readSrc(opts.stderrSrc, 'stderr') : '';
    combinedOutput = stdoutText + (stderrText ? '\n' + stderrText : '');
  }

  // --- Count matches before redaction (for the redactionCounts field) -------
  const redactionCounts = countMatches(combinedOutput, rules);

  // --- Redact output --------------------------------------------------------
  const redacted    = redactText(combinedOutput, rules);
  const redactedCmd = redactText(opts.cmd, rules);

  // --- Fail-closed rule 4: check for remaining leaks -----------------------
  const leaks = findLeaks(redacted, rules);
  if (leaks.length > 0) {
    for (const leak of leaks) {
      process.stderr.write(
        `REFUSED: ${leak.class} at line ${leak.lineNo} (content suppressed)\n`,
      );
    }
    process.exit(1);
  }

  // --- Emit evidence --------------------------------------------------------
  const result    = opts.exitCode === 0 ? 'PASS' : 'FAIL';
  const timestamp = new Date().toISOString();

  const evidence = {
    alias:           opts.alias,
    projectKind:     opts.projectKind,
    platform:        opts.platform,
    command:         redactedCmd,
    exitCode:        opts.exitCode,
    result,
    redactionCounts,
    timestamp,
    pr:              typeof opts.pr === 'number' && !isNaN(opts.pr) ? opts.pr : null,
    sha:             opts.sha || null,
  };

  // --- Fail-closed rule 5: redact + leak-check the evidence payload fields --
  // alias and sha are user-supplied strings that may contain private data
  // (e.g. a serial-shaped alias). command is already redacted but re-applied
  // for safety. Enum fields (projectKind, platform, result) are controlled values.
  evidence.alias   = redactText(evidence.alias,   rules);
  evidence.command = redactText(evidence.command,  rules);
  if (evidence.sha) evidence.sha = redactText(evidence.sha, rules);

  for (const [key, val] of Object.entries(evidence)) {
    if (typeof val !== 'string') continue;
    const fieldLeaks = findLeaks(val, rules);
    if (fieldLeaks.length > 0) {
      for (const leak of fieldLeaks) {
        process.stderr.write(
          `REFUSED: ${leak.class} in evidence payload field "${key}" at line ${leak.lineNo} (content suppressed)\n`,
        );
      }
      process.exit(1);
    }
  }

  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  } else {
    // Markdown table row: safeCell escapes | and strips newlines so that a
    // user-supplied command cannot break the column structure.
    process.stdout.write(
      `| ${safeCell(evidence.alias)} | ${safeCell(evidence.projectKind)} | ${safeCell(evidence.platform)} | ${safeCell(evidence.command)} | ${evidence.exitCode} | ${evidence.result} |\n`,
    );
    process.stdout.write('```json\n' + JSON.stringify(evidence, null, 2) + '\n```\n');
  }
}

main();
