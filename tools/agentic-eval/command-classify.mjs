#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/command-classify.mjs -- shared Bash-command classification for JUnit-evidence
// attribution. A tiny, dependency-light leaf module: imports only `tokenize` from policy-hook.mjs
// (that file's tokenize()/GRADLE_LEADING_TOKENS never move here -- policy_sha256, computed over
// policy-hook.mjs's own bytes only, would otherwise silently stop covering the grammar that
// actually drives the allow/deny decision). Deliberately not merged into graders.mjs: the new
// junit-evidence-hook.mjs is a hook subprocess that must start up fast and must not transitively
// load graders.mjs's much larger dependency tree just to classify one command string.
import { tokenize } from './policy-hook.mjs';
import { matchModuleFilter } from '../../lib/orchestrators/module-filter.js';

// Codex CLI on Windows reports the shell launcher as the command_execution.command,
// e.g. `".../powershell.exe" -Command 'kmp-test parallel ...'`. Classify the
// single inner command, not the launcher. This whole-command path still refuses a
// compound program; classifyBashCommand's segment pre-pass classifies such a program
// by the kmp-test or Gradle segment it contains.
function commandTokens(command) {
  const outer = tokenize(command);
  if (outer == null || outer.length !== 3
    || !/^(?:[A-Za-z]:[\\/].*[\\/])?(?:powershell|pwsh)\.exe$/i.test(outer[0])
    || outer[1].toLowerCase() !== '-command') return outer;
  const inner = outer[2];
  if (/[;|&`$()<>\r\n]/.test(inner)) return null;
  return tokenize(inner);
}

const DIGITS_RE = /^\d+$/;
const NEGATIVE_NUMBER_FLAG_RE = /^-\d+$/;

// Real transcripts (011c89b6) wrap the actual command in a `cd <dir> &&` (agents re-assert
// cwd defensively) or `timeout <N>` prefix. Recognizing at most one of either leaves the real
// command's own tokens (kmp-test/gradlew and everything after) untouched for the classification
// that follows -- this never changes what a command DOES, only what this classifier reads past.
function stripKnownPrefix(tokens) {
  if (tokens[0] === 'cd' && tokens[2] === '&&') return tokens.slice(3);
  if (tokens[0] === 'timeout' && DIGITS_RE.test(tokens[1] ?? '')) return tokens.slice(2);
  return tokens;
}

// Real transcripts also trail the command with output-shaping redirects/pipes -- `2>&1`
// alone, or (just as commonly) `2>&1` immediately feeding a `| tail -N` / `| head -N` /
// `| Select-Object -Last N`. Checked longest-first so the combined redirect+pipe idiom strips as
// the single trailing suffix it is, rather than requiring two separate passes.
const SUFFIX_PATTERNS = [
  [(t) => t === '2>&1', (t) => t === '|', (t) => t === 'tail', NEGATIVE_NUMBER_FLAG_RE],
  [(t) => t === '2>&1', (t) => t === '|', (t) => t === 'head', NEGATIVE_NUMBER_FLAG_RE],
  [(t) => t === '2>&1', (t) => t === '|', (t) => t === 'Select-Object', (t) => t === '-Last', DIGITS_RE],
  [(t) => t === '|', (t) => t === 'tail', NEGATIVE_NUMBER_FLAG_RE],
  [(t) => t === '|', (t) => t === 'head', NEGATIVE_NUMBER_FLAG_RE],
  [(t) => t === '|', (t) => t === 'Select-Object', (t) => t === '-Last', DIGITS_RE],
  [(t) => t === '2>&1'],
].map((pattern) => pattern.map((m) => (typeof m === 'function' ? m : (t) => m.test(t ?? ''))));

function stripKnownSuffix(tokens) {
  for (const pattern of SUFFIX_PATTERNS) {
    if (tokens.length < pattern.length) continue;
    const start = tokens.length - pattern.length;
    if (pattern.every((matches, i) => matches(tokens[start + i]))) return tokens.slice(0, start);
  }
  return tokens;
}

// Basename rule, not a literal Set: real transcripts keep
// surfacing gradlew invocation forms a fixed Set can't enumerate ahead of time -- a bare `.\gradlew`
// (no .bat) and an absolute checkout path both slipped through the old Set the same way the forms
// H16 added once already did. Matching on the trailing path segment instead closes the whole class:
// any relative or absolute, POSIX or Windows-separated path ending in gradlew(.bat) matches, case-
// insensitively (Windows filesystems are case-insensitive), while a same-directory decoy like
// gradlew-wrapper.sh or a run-together gradlewbat still correctly falls through to {kind:'other'}.
const GRADLEW_TOKEN_RE = /(^|[\\/])gradlew(\.bat)?$/i;

// The classification of ONE command: the launcher unwrap, prefix and suffix stripping and the token
// grammar below, exactly as they were before the segment pre-pass (classifyBashCommand) existed. The
// pre-pass reuses it on every cleaned segment, and falls back to it for the whole command.
function classifyWholeCommand(command) {
  const rawTokens = commandTokens(command);
  if (rawTokens == null || rawTokens.length === 0) return { kind: 'other' };
  return classifyTokens(stripKnownSuffix(stripKnownPrefix(rawTokens)));
}

function classifyTokens(tokens) {
  if (tokens.length === 0) return { kind: 'other' };
  if (tokens[0] === 'kmp-test') {
    let moduleFilter = null;
    let testType = null;
    let minMissedLines = null;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '--module-filter') { moduleFilter = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--module-filter=')) { moduleFilter = tokens[i].slice('--module-filter='.length); }
      else if (tokens[i] === '--test-type') { testType = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--test-type=')) { testType = tokens[i].slice('--test-type='.length); }
      // --min-missed-lines -- raw string token, never parsed to a number here (same convention as
      // moduleFilter/testType above): interpretation/validation is the caller's job. graders.mjs's
      // exact-string comparison against the scenario's own String(min_missed_lines) implicitly
      // rejects non-canonical forms (e.g. "050"/"5e1") without a second regex here.
      else if (tokens[i] === '--min-missed-lines') { minMissedLines = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--min-missed-lines=')) { minMissedLines = tokens[i].slice('--min-missed-lines='.length); }
    }
    // --show-modules-only -- changed's own dry-run-shaped inspection flag (never a real
    // execution, only a preview of which modules a real run would touch): excluded from terminal
    // contention/retries/JUnit relevance downstream exactly like --dry-run/--list/--list-only.
    const isPlanOnly = tokens.includes('--dry-run') || tokens.includes('--list') || tokens.includes('--list-only') || tokens.includes('--show-modules-only');
    // --no-coverage -- policy-hook.mjs's own KMP_TEST_BOOLEAN_FLAGS authorizes this flag, but it is
    // real and consequential: expandNoCoverageAlias (lib/orchestrators/orchestrator-utils.js)
    // rewrites it to `--coverage-tool none`, and runParallel's own coverage hand-off
    // (`if (opts.coverageTool !== 'none') { ... runCoverageInProcess ... }`,
    // lib/orchestrators/parallel-orchestrator.js:816) never even CALLS coverage aggregation when
    // that's set -- a real `--no-coverage` invocation can therefore never produce a
    // coverage_threshold_exceeded outcome. Captured here (unlike --coverage-tool/--coverage-modules/
    // --exclude-coverage, none of which this classifier extracts, since none of them are policy
    // hook -- authorized) specifically so graders.mjs can reject a self-reported
    // coverage_threshold_exceeded claim paired with a command that could never have produced one.
    const coverageDisabled = tokens.includes('--no-coverage');
    return { kind: 'kmp-test', subcommand: tokens[1] ?? null, moduleFilter, testType, minMissedLines, coverageDisabled, isPlanOnly };
  }
  if (GRADLEW_TOKEN_RE.test(tokens[0])) {
    const taskTokens = tokens.slice(1).filter((t) => !t.startsWith('-'));
    const isPlanOnly = tokens.includes('--dry-run');
    return { kind: 'gradle', taskTokens, isPlanOnly };
  }
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------
// Segment pre-pass. A command that chains commands (`a; b`, `a && b`), redirects its output
// (`> log 2>&1`), pipes into a filter (`| grep FAILED`) or is wrapped in a PowerShell launcher is
// classified by the kmp-test or Gradle command it contains, not by its first word. The helpers are
// quote-aware but small on purpose: they never guess, and on anything they cannot read (a quote left
// open) the whole-command result stands.

const POWERSHELL_LAUNCHER_RE = /^(?:.*[\\/])?(?:powershell|pwsh)(?:\.exe)?$/i;
const POWERSHELL_COMMAND_FLAG_RE = /^-(?:command|c)$/i;
const KMP_TEST_FILE_RE = /(^|[\\/])kmp-test(\.cmd|\.ps1)?$/i;
const START_PROCESS_RE = /^(?:\$[\w:]+\s*=\s*)?Start-Process\b/i;

// Redirections and filters that only shape what a command prints. A filter is matched by name, in any
// case (PowerShell cmdlets are case-insensitive).
const FD_DUP_RE = /^(?:\d|\*)?>&\d$/; // 2>&1, 1>&2, >&2, *>&1
const REDIRECT_OPERATOR_RE = /^(?:\d|&|\*)?>>?$/; // >, >>, 2>, 2>>, &>, *> (the file is the next word)
const GLUED_REDIRECT_RE = /^(?:\d|&|\*)?>>?[^>&\s]\S*$/; // >out.log, 2>err.log, >>out.log
const OUTPUT_FILTERS = new Set(['tee', 'tail', 'head', 'grep', 'findstr', 'select-string', 'select-object', 'wc', 'sort', 'cat', 'out-string']);

/** The words of a command line. Adjacent quoted and unquoted pieces join into one word, which is how
 * Codex records a program that holds single quotes (`'a '"'b'"' c'` is the word `a 'b' c`). Single
 * quotes are literal. A backslash escapes the next character outside quotes, and inside double quotes
 * only before a backslash, a double quote, `$` or a backtick, so a doubled backslash is one backslash,
 * as Codex writes Windows paths. Returns null when a quote is left open. */
function shellWords(text) {
  const words = [];
  let word = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= '';
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      word += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      for (i++; ; i++) {
        if (i >= text.length) return null;
        if (text[i] === '"') break;
        if (text[i] === '\\' && i + 1 < text.length && '\\"$`'.includes(text[i + 1])) i++;
        word += text[i];
      }
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
    } else {
      word += c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The program of a command that is exactly `<powershell|pwsh> -Command|-c <one argument>`, the
 * launcher with or without a path and extension; null for any other command. */
function powershellProgram(command) {
  const words = shellWords(command);
  if (words == null || words.length !== 3) return null;
  if (!POWERSHELL_LAUNCHER_RE.test(words[0]) || !POWERSHELL_COMMAND_FLAG_RE.test(words[1])) return null;
  return words[2];
}

/** Splits at top-level `;`, `&&`, `||` and newlines, never inside single or double quotes and never
 * after a backslash. Returns the non-empty segments, or null when a quote is left open. */
function splitSegments(text) {
  const segments = [];
  let start = 0;
  let quote = null;
  const cut = (end, next) => {
    const segment = text.slice(start, end).trim();
    if (segment !== '') segments.push(segment);
    start = next;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') {
      i++;
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === ';' || c === '\n' || c === '\r') {
      cut(i, i + 1);
    } else if ((c === '&' || c === '|') && text[i + 1] === c) {
      cut(i, i + 2);
      i++;
    }
  }
  if (quote !== null) return null;
  cut(text.length, text.length);
  return segments;
}

/** The words of a segment, split at whitespace outside quotes (the quote rules of splitSegments), each
 * with the offset where it ends. */
function wordSpans(segment) {
  const words = [];
  let start = -1;
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') {
      if (start === -1) start = i;
      i++;
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "'" || c === '"') {
      if (start === -1) start = i;
      quote = c;
    } else if (/\s/.test(c)) {
      if (start !== -1) words.push({ text: segment.slice(start, i), end: i });
      start = -1;
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) words.push({ text: segment.slice(start), end: segment.length });
  return words;
}

// `tail -f` follows a file for as long as it grows: it does not bound what the command printed, and
// a command that ends in it keeps the result it had before this pre-pass.
function isOutputFilter(words) {
  const name = words[0].text.toLowerCase();
  if (!OUTPUT_FILTERS.has(name)) return false;
  return !(name === 'tail' && words.slice(1).some((w) => w.text === '-f' || w.text === '--follow'));
}

/** The segment without the output redirections and the `| <filter> [args]` pipes at its end, removed
 * repeatedly, so `cmd > log 2>&1 | tail -n 5` is `cmd`. */
function stripOutputShaping(segment) {
  const words = wordSpans(segment);
  let n = words.length;
  while (n > 0) {
    const last = words[n - 1].text;
    if (FD_DUP_RE.test(last) || GLUED_REDIRECT_RE.test(last)) {
      n--;
    } else if (n >= 2 && REDIRECT_OPERATOR_RE.test(words[n - 2].text)) {
      n -= 2;
    } else {
      let pipe = n - 1;
      while (pipe >= 0 && words[pipe].text !== '|') pipe--;
      if (pipe < 0 || pipe + 1 >= n || !isOutputFilter(words.slice(pipe + 1, n))) break;
      n = pipe;
    }
  }
  return n === 0 ? '' : segment.slice(0, words[n - 1].end);
}

// --- Start-Process ---------------------------------------------------------------------------
// Codex launches long runs as `[$var =] Start-Process ... -FilePath <path> ... -ArgumentList <items>`.
// A value is a comma list of string literals ('a','b'), a bare word, an @(...) list, or something
// that is not a literal (a $variable, a parenthesized expression), which reads as null.

const isParameterStart = (text, i) => text[i] === '-' && /[A-Za-z]/.test(text[i + 1] ?? '');

function skipBlanks(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** A PowerShell string literal: '...' (a doubled quote is one quote) or "..." (a backtick or a doubled
 * quote escapes). Returns {value, end} or null when it is not closed. */
function readPsString(text, start) {
  const quote = text[start];
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === quote) {
      if (text[i + 1] !== quote) return { value, end: i + 1 };
      value += quote;
      i++;
    } else if (c === '`' && quote === '"' && i + 1 < text.length) {
      value += text[++i];
    } else {
      value += c;
    }
  }
  return null;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "'" || text[i] === '"') {
      const str = readPsString(text, i);
      if (str === null) return -1;
      i = str.end - 1;
    } else if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function readPsItem(text, i) {
  const c = text[i];
  if (c === "'" || c === '"') {
    const str = readPsString(text, i);
    return str && { values: [str.value], end: str.end };
  }
  if (c === '(' || (c === '@' && text[i + 1] === '(')) {
    const open = c === '(' ? i : i + 1;
    const close = matchingParen(text, open);
    if (close === -1) return null;
    const values = c === '(' ? [null] : (readPsList(text.slice(open + 1, close)) ?? [null]);
    return { values, end: close + 1 };
  }
  let j = i;
  while (j < text.length && !/[\s,)]/.test(text[j])) j++;
  if (j === i) return null;
  const word = text.slice(i, j);
  return { values: [word.startsWith('$') ? null : word], end: j };
}

/** The items of the inside of an @(...) list: comma-separated literals only, else null. */
function readPsList(inner) {
  const values = [];
  let i = skipBlanks(inner, 0);
  while (i < inner.length) {
    const item = readPsItem(inner, i);
    if (item === null) return null;
    values.push(...item.values);
    i = skipBlanks(inner, item.end);
    if (i >= inner.length) break;
    if (inner[i] !== ',') return null;
    i = skipBlanks(inner, i + 1);
  }
  return values;
}

function readPsValue(text, start) {
  const values = [];
  let i = start;
  for (;;) {
    const item = readPsItem(text, skipBlanks(text, i));
    if (item === null) return null;
    values.push(...item.values);
    i = skipBlanks(text, item.end);
    if (text[i] !== ',') return { values, end: item.end };
    i++;
  }
}

/** The parameters of a Start-Process segment as {lower-cased name: values}, or null when the segment
 * is not a Start-Process call or cannot be read. A parameter followed by another parameter, or by
 * nothing, is a switch and has no values. */
function startProcessParams(segment) {
  const head = START_PROCESS_RE.exec(segment);
  if (head === null) return null;
  const params = {};
  let i = head[0].length;
  while ((i = skipBlanks(segment, i)) < segment.length) {
    let name = null;
    if (isParameterStart(segment, i)) {
      let j = i + 1;
      while (j < segment.length && /[A-Za-z]/.test(segment[j])) j++;
      name = segment.slice(i + 1, j).toLowerCase();
      i = skipBlanks(segment, segment[j] === ':' ? j + 1 : j);
      if (i >= segment.length || isParameterStart(segment, i)) {
        params[name] ??= [];
        continue;
      }
    }
    const value = readPsValue(segment, i);
    if (value === null) return null;
    if (name !== null) params[name] ??= value.values;
    i = value.end;
  }
  return params;
}

/** The classification of a Start-Process call, by its -FilePath: gradlew[.bat] is gradle, with the
 * -ArgumentList items as its tokens; kmp-test[.cmd|.ps1] is kmp-test, with the first item as its
 * subcommand. An argument list that is not a list of literals (a variable) contributes no items.
 * Null for any other program. */
function classifyStartProcess(params) {
  const filePath = params.filepath?.[0];
  if (typeof filePath !== 'string') return null;
  const args = (params.argumentlist ?? []).filter((item) => typeof item === 'string');
  if (GRADLEW_TOKEN_RE.test(filePath)) return classifyTokens([filePath, ...args]);
  if (KMP_TEST_FILE_RE.test(filePath)) return classifyTokens(['kmp-test', ...args]);
  return null;
}

function classifySegment(segment) {
  const cleaned = stripOutputShaping(segment);
  if (cleaned === '') return { kind: 'other' };
  const params = startProcessParams(cleaned);
  if (params !== null) return classifyStartProcess(params) ?? { kind: 'other' };
  return classifyWholeCommand(cleaned);
}

/** Classifies one tool's raw command string. The direct-command grammar remains shared by
 * graders.mjs, junit-evidence.mjs, and junit-evidence-hook.mjs. The command is classified by the
 * kmp-test or Gradle command it contains:
 *  1. a command that is exactly a PowerShell launcher (`powershell`, `powershell.exe` or `pwsh`, with
 *     or without a path, then `-Command` or `-c` and one argument) is replaced by that argument;
 *  2. the text is split at top-level `;`, `&&`, `||` and newlines, never inside quotes or after a
 *     backslash; a quote left open skips this and returns the whole-command result;
 *  3. each segment loses the output redirections and `| <filter>` pipes at its end;
 *  4. each cleaned segment is classified by the direct-command grammar, or, for a Start-Process call,
 *     by its -FilePath and -ArgumentList;
 *  5. the result is the first segment whose kind is kmp-test or gradle, else the whole-command result.
 * Returns
 * `{kind:'kmp-test', subcommand, moduleFilter, testType, minMissedLines, coverageDisabled, isPlanOnly}` |
 * `{kind:'gradle', taskTokens, isPlanOnly}` | `{kind:'other'}`. */
export function classifyBashCommand(command) {
  if (typeof command !== 'string') return { kind: 'other' };
  const whole = classifyWholeCommand(command);
  const segments = splitSegments(powershellProgram(command) ?? command);
  if (segments === null) return whole;
  for (const segment of segments) {
    const result = classifySegment(segment);
    if (result.kind !== 'other') return result;
  }
  return whole;
}

/** A Gradle-project-path-shaped module identifier, normalized to bare-no-leading-colon form for
 * comparison. Relocated verbatim from graders.mjs. */
export function normalizeModuleName(name) {
  return typeof name === 'string' ? name.replace(/^:/, '') : name;
}

/** True only for a non-plan-only Gradle invocation whose task tokens include at least one entry
 * from `allowedInvocations` (the scenario's `expected.gradle.allowed_invocations`) -- deliberately
 * NOT "any Gradle command" and NOT "only the literal evidence_task": a policy-permitted lifecycle
 * alias (e.g. `:app:test`) must count as relevant even though its own task token never literally
 * equals `evidence_task` (schemas.mjs's own "decision 3" contract, graders.mjs:759-764's own
 * confirmed real-Gradle-behavior comment: the alias still prints the underlying leaf task's own
 * status line as part of its dependency chain). The JUnit XML itself is still always read from
 * `evidence_task`'s own directory -- this predicate only decides relevance/tracking, never where to
 * look for evidence. */
export function isRelevantGradleInvocation(classification, allowedInvocations) {
  if (classification.kind !== 'gradle' || classification.isPlanOnly) return false;
  return classification.taskTokens.some((t) => (allowedInvocations ?? []).includes(t));
}

/** True only for a non-plan-only `kmp-test parallel` invocation whose `--module-filter` is either
 * absent (ran every module, including the target) or MATCHES the target module under the real
 * production matcher (`matchModuleFilter`, `lib/orchestrators/module-filter.js`) -- mirrors the
 * original `classifyJunitProvenance` per-command rule (graders.mjs:939-944): a `parallel` call
 * dispatches the same underlying Gradle task and can write/overwrite the same JUnit XML, so it is
 * just as much a potential producer as a raw Gradle invocation, scoped the same way. Follow-up fix:
 * this originally compared `moduleFilter` to `targetModule` via exact string equality, so a command
 * correctly targeting a NESTED module (`:core:common`) via a short substring filter (`common`) or
 * an anchored glob (`core:*`) was invisible to this relevance check even though the real CLI's own
 * dispatch would have matched it -- silently hiding a genuine same-turn JUnit-evidence conflict
 * from `junit-evidence.mjs`'s `attributeCondition`. `targetModule` is expected to be a string
 * (`attributeCondition` reads it from `scenario.expected?.module`, note the existing optional
 * chaining there); unlike `normalizeModuleName`'s safe passthrough for a non-string value,
 * `matchModuleFilter` calls `.replace` on its `name` argument unconditionally, so a missing/
 * non-string `targetModule` is guarded explicitly rather than left to throw. */
export function isRelevantKmpTestParallel(classification, targetModule) {
  if (classification.kind !== 'kmp-test' || classification.subcommand !== 'parallel' || classification.isPlanOnly) return false;
  if (classification.moduleFilter == null) return true;
  return typeof targetModule === 'string' && matchModuleFilter(targetModule, classification.moduleFilter);
}

/** True only for a non-plan-only `kmp-test changed` invocation -- deliberately NO module-filter
 * parameter/logic, unlike isRelevantKmpTestParallel above: `changed` has no `--module-filter` flag
 * at all (the real CLI rejects it as `unknown_flag`), so there is no "ran the wrong module" shape
 * to reconcile here -- every non-plan-only `changed` call is unconditionally relevant. This
 * predicate itself carries no scenario awareness (no targetModule, no outcome_kind check) by
 * design -- callers (junit-evidence.mjs's attributeCondition) are responsible for only folding it
 * into their own `relevant` set when the scenario itself actually expects a `changed` subcommand
 * (`scenario.expected.changed != null`), so the other 5 scenarios' behavior stays untouched. */
export function isRelevantKmpTestChanged(classification) {
  return classification.kind === 'kmp-test' && classification.subcommand === 'changed' && !classification.isPlanOnly;
}
