#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/condition-launcher.mjs -- builds the argv/env for each condition and
// spawns the measured claude session. No --bare (breaks OAuth), no --session-id (would make
// argv diverge in more than --plugin-dir), no --allowedTools (superseded entirely by the
// PreToolUse policy hook -- Round 6), no bypassPermissions, never Read/Glob/Grep/Edit/Write/
// Agent in --tools.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvalEnv } from './env-builder.mjs';
import { computePolicySha256 } from './policy-config.mjs';

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
 * byte-identical between A and B too.
 */
export function buildSharedEnv({ shimDir, gradleUserHome, kmpEvalTempHome, expectedFixtureRoot, allowedGradleTasks, allowedKmpTestSubcommands }) {
  const baseEnv = buildEvalEnv(process.env);
  return {
    ...baseEnv,
    PATH: `${shimDir}${process.platform === 'win32' ? ';' : ':'}${baseEnv.PATH ?? baseEnv.Path ?? ''}`,
    GRADLE_USER_HOME: gradleUserHome,
    KMP_EVAL_TEMP_HOME: kmpEvalTempHome,
    KMP_EVAL_EXPECTED_FIXTURE_ROOT: expectedFixtureRoot,
    KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify(allowedGradleTasks),
    KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS: JSON.stringify(allowedKmpTestSubcommands),
  };
}

/**
 * Spawns the measured session via `bash -c` (required on Windows -- direct spawnSync of
 * `claude` with shell:false hits EINVAL, the same class of issue the prior harness.mjs
 * documented for .bat/.cmd files; confirmed empirically during Step 1). Tags each stdout line
 * with a monotonic receipt_ns relative to a t0 captured immediately before spawn (Round 3 fix
 * #4) -- graders consume only the resulting event index, never a timestamp directly.
 */
export function spawnCondition(argv, { env, cwd, timeoutMs = 300000 }) {
  const cmd = argv.map(shQuote).join(' ');
  const t0 = process.hrtime.bigint();
  const result = spawnSync('bash', ['-c', cmd], { env, cwd, encoding: 'utf8', timeout: timeoutMs });
  const rawStdout = result.stdout ?? '';
  const taggedLines = rawStdout.split('\n').filter(Boolean).map((line) => ({ line, receiptNs: process.hrtime.bigint() - t0 }));
  const terminated = result.signal != null || result.error?.code === 'ETIMEDOUT';
  return {
    exitCode: result.status,
    terminated,
    terminationReason: terminated ? 'timeout' : (result.status !== 0 ? 'error' : null),
    rawStdout,
    stderr: result.stderr ?? '',
    taggedLines,
    spawnHrtimeNs: t0,
    policySha256: computePolicySha256(),
  };
}

export { POLICY_HOOK_PATH };
