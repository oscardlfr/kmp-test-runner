#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/condition-launcher.mjs -- builds the argv/env for each condition and
// spawns the measured claude session. No --bare (breaks OAuth), no --session-id (would make
// argv diverge in more than --plugin-dir), no --allowedTools (superseded entirely by the
// PreToolUse policy hook -- Round 6), no bypassPermissions, never Read/Glob/Grep/Edit/Write/
// Agent in --tools.
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvalEnv } from './env-builder.mjs';
import { buildPolicyEnvValues, computePolicySha256 } from './policy-config.mjs';
import { resolveBash } from './resolve-bash.mjs';

const POLICY_HOOK_PATH = join(import.meta.dirname, 'policy-hook.mjs');

const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;

/**
 * Generates a --settings JSON file wiring policy-hook.mjs as the PreToolUse Bash hook.
 * Independent of --setting-sources (verified during Step 1 -- --settings is additive, not
 * excluded by "" setting-sources).
 */
export function buildPolicySettingsFile() {
  const dir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-settings-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${POLICY_HOOK_PATH}"` }] }] },
  }, null, 2));
  return settingsPath;
}

/**
 * The ONE shared base argv, condition-agnostic. --output-format stream-json requires
 * --verbose when combined with --print -- undocumented in --help, found only by running it.
 */
export function buildBaseArgv({ prompt, model = 'claude-sonnet-5', settingsPath, maxBudgetUsd = 0.60 }) {
  return [
    'claude', '-p', prompt,
    '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--model', model,
    '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--no-session-persistence',
    '--settings', settingsPath,
    '--tools', 'Bash,Skill',
    '--permission-mode', 'dontAsk', '--max-budget-usd', String(maxBudgetUsd),
  ];
}

/**
 * The ONLY condition-specific step: appends --plugin-dir at the end if and only if
 * condition==='current-skill'; otherwise returns baseArgv completely unchanged (same array
 * content, never mutated in place). A dedicated test asserts this mechanically: condition A's
 * argv is byte-identical to condition B's argv minus exactly this one trailing pair.
 */
export function buildConditionArgv(baseArgv, condition, snapshotDir) {
  if (condition === 'candidate-skill') {
    throw new Error('candidate-skill is accepted as a future path but not implemented in this harness version.');
  }
  if (condition === 'current-skill') {
    if (!snapshotDir) throw new Error('current-skill requires a materialized snapshotDir');
    return [...baseArgv, '--plugin-dir', snapshotDir];
  }
  if (condition === 'no-skill') return baseArgv;
  throw new Error(`Unknown condition: ${condition}`);
}

/**
 * Builds the ONE shared env object used verbatim for both conditions of a run-pair -- the
 * harness-controlled policy config (fix #18) travels in this same object, so it is
 * byte-identical between A and B too. Policy config is validated through
 * buildPolicyEnvValues() (policy-config.mjs) BEFORE it ever reaches the env object: invalid
 * grammar, duplicate entries, or a non-array input fail loudly here, at harness-construction
 * time, instead of surfacing only as an opaque runtime hook denial once a real session is
 * already spawned.
 */
export function buildSharedEnv({ shimDir, gradleUserHome, kmpEvalTempHome, expectedFixtureRoot, allowedGradleTasks, allowedKmpTestSubcommands }) {
  const baseEnv = buildEvalEnv(process.env);
  const { errors, envValues } = buildPolicyEnvValues({ allowedGradleTasks, allowedKmpTestSubcommands });
  if (errors.length > 0) {
    throw new Error(`Invalid policy configuration: ${JSON.stringify(errors)}`);
  }
  return {
    ...baseEnv,
    PATH: `${shimDir}${process.platform === 'win32' ? ';' : ':'}${baseEnv.PATH ?? baseEnv.Path ?? ''}`,
    GRADLE_USER_HOME: gradleUserHome,
    KMP_EVAL_TEMP_HOME: kmpEvalTempHome,
    KMP_EVAL_EXPECTED_FIXTURE_ROOT: expectedFixtureRoot,
    ...envValues,
  };
}

// Killing just the wrapper bash PID does not reliably terminate a shell's descendants on
// either platform -- confirmed empirically (a nested/child command kept running well past a
// SIGTERM to the wrapper, on both `spawn()`'s own `timeout` option and a hand-rolled
// `child.kill()`). `taskkill /F /T` targets the whole process tree by PID on Windows; on POSIX,
// spawning with `detached: true` makes the wrapper the leader of a new process group, so
// `process.kill(-pid, signal)` reaches the whole group instead of just the one process.
function killTree(pid, signal) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => { /* best-effort -- process may already be gone */ });
  } else {
    try { process.kill(-pid, signal); } catch { /* already exited, or never became a group leader */ }
  }
}

/**
 * Spawns the measured session via `bash -c` (required on Windows -- direct spawnSync of
 * `claude` with shell:false hits EINVAL, the same class of issue the prior harness.mjs
 * documented for .bat/.cmd files; confirmed empirically during Step 1). Tags each stdout line
 * with a monotonic, ABSOLUTE process.hrtime.bigint() receiptNs as it arrives (Round 3 fix #4)
 * -- NOT pre-subtracted against t0 here; stream-parser.mjs's deriveFirstUsefulSignalMs() does
 * the one subtraction against spawnHrtimeNs. Pre-subtracting here too would double-subtract
 * there, producing a large negative "ms" value. Grading consumes only the resulting event
 * index, never a timestamp directly.
 *
 * Uses the async spawn() (not spawnSync()) specifically so lines can be tagged as they actually
 * arrive off the child's stdout stream: spawnSync() buffers the entire child output until exit,
 * so a post-hoc tagging pass over the buffered result would stamp every line with
 * (approximately) the same post-exit timestamp -- flattening receipt_ns to "total run
 * duration" for every event and defeating the whole point of per-event timing.
 * @returns {Promise<object>}
 */
export function spawnCondition(argv, { env, cwd, timeoutMs = 300000 }) {
  const cmd = argv.map(shQuote).join(' ');
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = spawn(resolveBash(), ['-c', cmd], { env, cwd, detached: process.platform !== 'win32' });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let rawStdout = '';
    let stderr = '';
    let buf = '';
    const taggedLines = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGTERM');
      const killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      const receiptNs = process.hrtime.bigint();
      rawStdout += chunk;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line) taggedLines.push({ line, receiptNs });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // terminated:true here (never false) -- the schema itself rejects terminated:false paired
      // with a non-null termination_reason, and a spawn-level failure (e.g. ENOENT) is exactly
      // an abnormal, non-'timeout' termination: the run never reached a normal conclusion.
      resolve({
        exitCode: null,
        terminated: true,
        terminationReason: 'error',
        rawStdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        taggedLines,
        spawnHrtimeNs: t0,
        policySha256: computePolicySha256(),
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buf) taggedLines.push({ line: buf, receiptNs: process.hrtime.bigint() });
      const terminated = timedOut || signal != null;
      resolve({
        exitCode: code,
        terminated,
        terminationReason: terminated ? 'timeout' : (code !== 0 ? 'error' : null),
        rawStdout,
        stderr,
        taggedLines,
        spawnHrtimeNs: t0,
        policySha256: computePolicySha256(),
      });
    });
  });
}

export { POLICY_HOOK_PATH };
