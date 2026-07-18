#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/policy-hook.mjs -- PreToolUse Bash policy hook (Round 6).
//
// This is a verified command-policy boundary for a PINNED, TRUSTED fixture/scenario project --
// it is NOT an OS/filesystem sandbox. An approved command (e.g. `./gradlew build`) still
// executes with full host permissions once allowed; Gradle build-script code and kmp-test
// itself are trusted, not further sandboxed. The boundary this hook provides is: only an
// explicit, narrow set of command shapes can be *initiated* at all, every path argument is
// resolved (not just lexically inspected) to prevent it resolving outside the fixture, and the
// wrapper executable itself is resolved to prevent PATH-order or symlink substitution.
//
// Policy configuration comes ONLY from environment variables the harness controls directly
// (never from the hook's stdin payload, which is untrusted per-call input) -- see loadConfig().
//
// This replaces an earlier `--allowedTools` pattern-list design (Round 5), which was tested
// directly and found insufficient: plain --allowedTools + --permission-mode dontAsk let a
// small set of commands (whoami, pwd) bypass the allowlist via an internal, undocumented,
// version-dependent "trivially safe" auto-approval heuristic. This hook governs every Bash
// call, confirmed via hook_started/hook_response stream-json events (see stream-parser.mjs).
//
// Verification: 95+ synthetic cases (tests/vitest/agentic-eval-policy-hook.test.js) plus
// adversarial real-session verification during Step 1 -- see the PR body for the full
// evidence table. A silent policy-code change between runs is detectable via policy_sha256
// recorded in every run record (see policy-config.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DENY_REASON = 'Command not permitted by evaluation harness policy.';
const ALLOW_REASON = 'Command permitted by evaluation harness policy.';

function denyOutput() {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
  });
}
function allowOutput() {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: ALLOW_REASON },
  });
}

// --- path containment: path.relative-based, never a lowercase/prefix string comparison
// (that would false-positive on case-distinct sibling paths on Linux / case-sensitive APFS).
// pathImpl defaults to the platform path module (win32 on this PR's actual target, Windows) --
// tests inject path.posix to verify the ALGORITHM's case-handling in the abstract, since
// Windows' own case-insensitive filesystem means realpath'd Windows paths can't exercise
// genuine case-sensitivity on this host regardless of which path module backs the comparison. ---
export function isEqualCanonical(a, b, pathImpl = path) {
  return pathImpl.relative(a, b) === '';
}
export function isWithinOrEqualCanonical(root, candidate, pathImpl = path) {
  const rel = pathImpl.relative(root, candidate);
  if (rel === '') return true;
  if (pathImpl.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith('..' + pathImpl.sep)) return false;
  return true;
}

// --- externally-supplied policy config (harness-controlled env, not hook stdin) ---
export const GRADLE_TASK_ENTRY_RE = /^[A-Za-z0-9_:.-]+$/;
export const KMPTEST_SUBCOMMAND_ENTRY_RE = /^[a-z]+$/;

export function parsePolicyList(raw, entryRe) {
  if (raw === undefined) return null; // env var not set at all -- malformed, fail closed
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null; // e.g. a bare JSON string parses to a string, not an array -- reject
  const seen = new Set();
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.length === 0) return null;
    if (!entryRe.test(entry)) return null;
    if (seen.has(entry)) return null; // duplicate entries -- malformed config, fail closed
    seen.add(entry);
  }
  return seen; // an explicitly-empty array is a legitimate "nothing in this category" policy
}

export function loadConfig(env = process.env) {
  const expectedFixtureRootRaw = env.KMP_EVAL_EXPECTED_FIXTURE_ROOT;
  if (!expectedFixtureRootRaw) return null;
  let expectedFixtureRootReal;
  try {
    expectedFixtureRootReal = fs.realpathSync(expectedFixtureRootRaw);
  } catch {
    return null;
  }
  const allowedGradleTasks = parsePolicyList(env.KMP_EVAL_ALLOWED_GRADLE_TASKS, GRADLE_TASK_ENTRY_RE);
  const allowedKmpTestSubcommands = parsePolicyList(env.KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS, KMPTEST_SUBCOMMAND_ENTRY_RE);
  if (allowedGradleTasks === null || allowedKmpTestSubcommands === null) return null;
  return { expectedFixtureRootReal, allowedGradleTasks, allowedKmpTestSubcommands };
}

// --- dangerous-shape reject list (whole-command, before tokenization) ---
export const DANGEROUS_SUBSTRING_RE = /[;&|<>`\n\r]|\$\(|\$\{/;
export const ENV_ASSIGNMENT_PREFIX_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;
export const SHELL_WRAPPER_TOKENS = new Set([
  'bash', 'sh', 'zsh', 'ksh', 'dash',
  'cmd', 'cmd.exe',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'node', 'node.exe', 'python', 'python3', 'python.exe',
  'wscript', 'cscript', 'mshta', 'curl', 'wget', 'ssh',
]);

export function tokenize(cmd) {
  const tokens = [];
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    while (i < n && /\s/.test(cmd[i])) i++;
    if (i >= n) break;
    let tok = '';
    if (cmd[i] === '"' || cmd[i] === "'") {
      const quote = cmd[i];
      i++;
      const start = i;
      while (i < n && cmd[i] !== quote) i++;
      if (i >= n) return null;
      tok = cmd.slice(start, i);
      i++;
      if (i < n && !/\s/.test(cmd[i])) return null;
    } else {
      const start = i;
      while (i < n && !/\s/.test(cmd[i])) i++;
      tok = cmd.slice(start, i);
      if (tok.includes('"') || tok.includes("'")) return null;
    }
    tokens.push(tok);
  }
  return tokens;
}

export const EXPANSION_OR_UNSAFE_CHAR_RE = /[$%!~`*?[\]]/;
export const WINDOWS_DEVICE_OR_DRIVE_RELATIVE_RE = /^\\\\[?.]\\|^[A-Za-z]:(?![\\/])/;

export function realpathWithinFixture(rawValue, cwd, expectedFixtureRootReal) {
  if (EXPANSION_OR_UNSAFE_CHAR_RE.test(rawValue)) return false;
  if (WINDOWS_DEVICE_OR_DRIVE_RELATIVE_RE.test(rawValue)) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rawValue)) return false;
  const joined = path.resolve(cwd, rawValue);
  let real;
  try {
    real = fs.realpathSync(joined);
  } catch {
    return false;
  }
  return isWithinOrEqualCanonical(expectedFixtureRootReal, real);
}

export const KMP_TEST_ALLOWED_BARE_FLAGS = new Set(['--version', '--help']);
export const KMP_TEST_PATH_FLAGS = new Set(['--project-root']);
// No '*' -- a shell can glob-expand an unquoted wildcard AFTER this hook approves it, so what
// the hook approved and what actually executes could diverge. Narrow explicit values only;
// wildcard support is a documented future extension, not supported by this grammar.
export const FILTER_VALUE_RE = /^[A-Za-z0-9_.:#-]+$/;
export const KMP_TEST_FILTER_FLAGS = new Set(['--module-filter', '--test-filter']);
export const KMP_TEST_BOOLEAN_FLAGS = new Set(['--json', '--dry-run', '--no-coverage']);

export function isSafeFilterValue(val) {
  // '#' is legitimate mid-value (FQN#method), but a LEADING '#' risks shell-comment
  // reinterpretation if this value is ever re-serialized through a real shell context.
  if (val.startsWith('#')) return false;
  return FILTER_VALUE_RE.test(val);
}

export function evaluateKmpTest(tokens, cwd, config) {
  const rest = tokens.slice(1);
  if (rest.length === 1 && KMP_TEST_ALLOWED_BARE_FLAGS.has(rest[0])) return true;
  if (rest.length === 0) return false;
  const [subcommand, ...args] = rest;
  if (!config.allowedKmpTestSubcommands.has(subcommand)) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (KMP_TEST_PATH_FLAGS.has(a)) {
      const val = args[i + 1];
      if (val === undefined || val.startsWith('-')) return false;
      if (!realpathWithinFixture(val, cwd, config.expectedFixtureRootReal)) return false;
      i++;
      continue;
    }
    if (KMP_TEST_FILTER_FLAGS.has(a)) {
      const val = args[i + 1];
      if (val === undefined || !isSafeFilterValue(val)) return false;
      i++;
      continue;
    }
    if (a.startsWith('--module-filter=') && isSafeFilterValue(a.slice('--module-filter='.length))) continue;
    if (a.startsWith('--test-filter=') && isSafeFilterValue(a.slice('--test-filter='.length))) continue;
    if (KMP_TEST_BOOLEAN_FLAGS.has(a)) continue;
    return false;
  }
  return true;
}

export const GRADLE_ALLOWED_FLAGS = new Set(['--offline', '-q', '--quiet', '--console=plain', '--rerun-tasks']);
// Bare 'gradlew'/'gradlew.bat' are deliberately NOT in this set -- PATH resolution could
// substitute a different executable earlier on PATH (verified with a fake gradlew planted
// first on PATH during Step 1). Only fixture-anchored forms are allowed, and the wrapper file
// itself is realpath-resolved below to reject a symlinked substitute too.
export const GRADLE_LEADING_TOKENS = new Set(['./gradlew', './gradlew.bat', '.\\gradlew.bat']);

export function evaluateGradle(tokens, cwd, config) {
  const wrapperReal = (() => {
    try {
      return fs.realpathSync(path.resolve(cwd, tokens[0]));
    } catch {
      return null;
    }
  })();
  if (wrapperReal === null) return false;
  if (!isEqualCanonical(config.expectedFixtureRootReal, path.dirname(wrapperReal))) return false;

  const rest = tokens.slice(1);
  if (rest.length === 0) return false;
  let sawTask = false;
  for (const t of rest) {
    if (t.startsWith('-')) {
      if (!GRADLE_ALLOWED_FLAGS.has(t)) return false;
      continue;
    }
    if (!config.allowedGradleTasks.has(t)) return false;
    sawTask = true;
  }
  return sawTask;
}

export const MAX_STDIN_BYTES = 64 * 1024;
export const MAX_TIMEOUT_MS = 300000;

/**
 * Pure decision function: given a raw stdin string and an env source, returns the exact
 * JSON string that should be written to stdout. Never throws -- every path denies on error.
 */
export function decide(raw, env = process.env) {
  try {
    // Defense in depth: the streaming stdin handler (runAsHook, below) also enforces this cap
    // as data arrives, but decide() itself must fail closed on an oversized input regardless of
    // how it was invoked -- it is a public, directly-callable function, not solely reached via
    // the stdin-streaming path.
    if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) return denyOutput();

    const config = loadConfig(env);
    if (config == null) return denyOutput();

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return denyOutput();
    }
    if (payload == null || typeof payload !== 'object') return denyOutput();
    if (payload.hook_event_name !== 'PreToolUse') return denyOutput();
    if (payload.tool_name !== 'Bash') return denyOutput();

    if (typeof payload.cwd !== 'string' || payload.cwd.length === 0) return denyOutput();
    let cwdReal;
    try {
      cwdReal = fs.realpathSync(payload.cwd);
    } catch {
      return denyOutput();
    }
    if (!isEqualCanonical(config.expectedFixtureRootReal, cwdReal)) return denyOutput();

    const toolInput = payload.tool_input;
    if (toolInput == null || typeof toolInput !== 'object') return denyOutput();
    const knownKeys = new Set(['command', 'description', 'timeout', 'run_in_background']);
    for (const k of Object.keys(toolInput)) {
      if (!knownKeys.has(k)) return denyOutput();
    }
    if ('description' in toolInput && typeof toolInput.description !== 'string') return denyOutput();
    if ('run_in_background' in toolInput && toolInput.run_in_background !== false) return denyOutput();
    if ('timeout' in toolInput) {
      const t = toolInput.timeout;
      if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > MAX_TIMEOUT_MS) return denyOutput();
    }

    const command = toolInput.command;
    if (typeof command !== 'string' || command.length === 0) return denyOutput();

    if (DANGEROUS_SUBSTRING_RE.test(command)) return denyOutput();
    if (ENV_ASSIGNMENT_PREFIX_RE.test(command)) return denyOutput();

    const tokens = tokenize(command);
    if (tokens == null || tokens.length === 0) return denyOutput();
    if (SHELL_WRAPPER_TOKENS.has(tokens[0].toLowerCase())) return denyOutput();

    if (tokens[0] === 'kmp-test') {
      return evaluateKmpTest(tokens, cwdReal, config) ? allowOutput() : denyOutput();
    }
    if (GRADLE_LEADING_TOKENS.has(tokens[0])) {
      return evaluateGradle(tokens, cwdReal, config) ? allowOutput() : denyOutput();
    }
    return denyOutput();
  } catch {
    return denyOutput(); // any unexpected parser/logic error -- fail closed
  }
}

// process.stdout.write() is asynchronous when stdout is a pipe (always true here -- Claude
// Code reads the hook's JSON response off a piped child stdout), so calling process.exit()
// immediately after starting the write can terminate the process before the OS has actually
// flushed it, truncating the response. Gating exit on the write's own completion callback
// guarantees the full response is flushed first, while still exiting deterministically (no
// reliance on the event loop draining naturally, which would risk a hang while process.stdin
// still has an active listener on the timeout path below).
function writeAndExit(output) {
  process.stdout.write(output, () => process.exit(0));
}

function runAsHook() {
  let raw = '';
  let finished = false;
  let overflowed = false;
  const HARD_TIMEOUT_MS = 3000;
  const timer = setTimeout(() => {
    if (!finished) { finished = true; writeAndExit(denyOutput()); }
  }, HARD_TIMEOUT_MS);
  timer.unref?.();

  process.stdin.on('data', (chunk) => {
    if (overflowed) return;
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) {
      overflowed = true;
      if (!finished) { finished = true; clearTimeout(timer); writeAndExit(denyOutput()); }
    }
  });
  process.stdin.on('end', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    writeAndExit(decide(raw));
  });
  process.stdin.on('error', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    writeAndExit(denyOutput());
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runAsHook();
