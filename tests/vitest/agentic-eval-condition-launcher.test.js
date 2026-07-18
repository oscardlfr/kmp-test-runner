// tests/vitest/agentic-eval-condition-launcher.test.js
// Unit tests for tools/agentic-eval/condition-launcher.mjs. Argv/env construction only --
// mocked spawn, no real claude process. Real end-to-end spawn behavior is proven separately
// (Step 1 gate evidence, in the PR description) since it inherently requires a real session.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildBaseArgv,
  buildConditionArgv,
  buildSharedEnv,
  buildPolicySettingsFile,
  spawnCondition,
} from '../../tools/agentic-eval/condition-launcher.mjs';

describe('buildBaseArgv / buildConditionArgv -- mechanical A/B equivalence', () => {
  const settingsPath = 'C:\\fake\\settings.json';

  it('condition A (no-skill) returns the base argv completely unchanged (same reference)', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    const argvA = buildConditionArgv(base, 'no-skill', null);
    expect(argvA).toBe(base);
  });

  it('condition B (current-skill) is the base argv plus exactly one trailing --plugin-dir pair', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    const argvB = buildConditionArgv(base, 'current-skill', 'C:\\fake-snapshot');
    expect(argvB.slice(0, base.length)).toEqual(base);
    expect(argvB.slice(base.length)).toEqual(['--plugin-dir', 'C:\\fake-snapshot']);
  });

  it('A is an exact, unmodified prefix of B -- the only structural difference is --plugin-dir', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    const argvA = buildConditionArgv(base, 'no-skill', null);
    const argvB = buildConditionArgv(base, 'current-skill', 'C:\\fake-snapshot');
    expect(argvA.every((v, i) => v === argvB[i])).toBe(true);
    expect(argvB.length - argvA.length).toBe(2);
  });

  it('current-skill without a snapshotDir throws rather than silently omitting --plugin-dir', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(() => buildConditionArgv(base, 'current-skill', null)).toThrow();
  });

  it('candidate-skill throws a clear, typed error -- accepted in schema, not implemented here', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(() => buildConditionArgv(base, 'candidate-skill', null)).toThrow(/not implemented/);
  });

  it('unknown condition throws', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(() => buildConditionArgv(base, 'bogus-condition', null)).toThrow();
  });

  it('--tools is exactly "Bash,Skill"', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(base[base.indexOf('--tools') + 1]).toBe('Bash,Skill');
  });

  it('never contains Read/Glob/Grep/Edit/Write/Agent anywhere in --tools', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    const toolsValue = base[base.indexOf('--tools') + 1];
    for (const forbidden of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent']) {
      expect(toolsValue).not.toContain(forbidden);
    }
  });

  it('never contains --allowedTools anywhere -- superseded entirely by the policy hook', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(base).not.toContain('--allowedTools');
  });

  it('never contains --bare -- breaks OAuth (Round 1)', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(base).not.toContain('--bare');
  });

  it('never contains --session-id -- would make A/B argv diverge in more than --plugin-dir', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(base).not.toContain('--session-id');
  });

  it('never contains bypassPermissions anywhere', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(base.join(' ')).not.toContain('bypassPermissions');
  });

  it('--permission-mode is exactly dontAsk', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(base[base.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('--output-format stream-json is always paired with --verbose', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath });
    expect(base).toContain('--verbose');
    expect(base[base.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('--settings points at the provided settings path', () => {
    const base = buildBaseArgv({ prompt: 'test', settingsPath: 'C:\\some\\settings.json' });
    expect(base[base.indexOf('--settings') + 1]).toBe('C:\\some\\settings.json');
  });
});

describe('buildSharedEnv -- byte-identical policy config between conditions', () => {
  const opts = {
    shimDir: 'C:\\shim', gradleUserHome: 'C:\\gradle-home', kmpEvalTempHome: 'C:\\kmp-home',
    expectedFixtureRoot: 'C:\\fixture', allowedGradleTasks: ['build'], allowedKmpTestSubcommands: ['doctor'],
  };

  it('never includes HOME/USERPROFILE (narrow allowlist, fix #7)', () => {
    const env = buildSharedEnv(opts);
    expect(env).not.toHaveProperty('HOME');
    expect(env).not.toHaveProperty('USERPROFILE');
  });

  it('carries the harness-controlled policy config', () => {
    const env = buildSharedEnv(opts);
    expect(env.KMP_EVAL_EXPECTED_FIXTURE_ROOT).toBe('C:\\fixture');
    expect(JSON.parse(env.KMP_EVAL_ALLOWED_GRADLE_TASKS)).toEqual(['build']);
    expect(JSON.parse(env.KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS)).toEqual(['doctor']);
  });

  it('prepends the shim dir to PATH', () => {
    const env = buildSharedEnv(opts);
    expect(env.PATH.startsWith('C:\\shim')).toBe(true);
  });

  it('two calls with identical opts produce deep-equal (byte-identical-content) env objects', () => {
    const envA = buildSharedEnv(opts);
    const envB = buildSharedEnv(opts);
    expect(envA).toEqual(envB);
  });

  it('routes allowedGradleTasks/allowedKmpTestSubcommands through the policy-config validator -- fails loudly at construction time on invalid grammar', () => {
    expect(() => buildSharedEnv({ ...opts, allowedGradleTasks: ['build; rm -rf /'] })).toThrow(/Invalid policy configuration/);
  });

  it('fails loudly on a non-array policy input, not just an opaque runtime hook denial later', () => {
    expect(() => buildSharedEnv({ ...opts, allowedKmpTestSubcommands: 'doctor' })).toThrow(/Invalid policy configuration/);
  });

  it('fails loudly on duplicate policy entries', () => {
    expect(() => buildSharedEnv({ ...opts, allowedGradleTasks: ['build', 'build'] })).toThrow(/Invalid policy configuration/);
  });
});

describe('spawnCondition -- real subprocess (local shell only, no Claude, no network)', () => {
  it('resolves with rawStdout, a zero exitCode, and per-line receiptNs values that are non-decreasing', async () => {
    const argv = ['bash', '-c', 'printf "line1\\nline2\\nline3\\n"'];
    const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 10000 });
    expect(result.exitCode).toBe(0);
    expect(result.terminated).toBe(false);
    expect(result.terminationReason).toBeNull();
    expect(result.rawStdout).toContain('line1');
    expect(result.taggedLines.length).toBe(3);
    for (const { receiptNs } of result.taggedLines) expect(typeof receiptNs).toBe('bigint');
    for (let i = 1; i < result.taggedLines.length; i++) {
      expect(result.taggedLines[i].receiptNs >= result.taggedLines[i - 1].receiptNs).toBe(true);
    }
  });

  it('reports terminationReason "error" for a nonzero exit code', async () => {
    const argv = ['bash', '-c', 'exit 7'];
    const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 10000 });
    expect(result.exitCode).toBe(7);
    expect(result.terminated).toBe(false);
    expect(result.terminationReason).toBe('error');
  });

  it('terminates a hanging command once timeoutMs elapses', async () => {
    // A realistic argv shape (a plain command, matching how buildBaseArgv/buildConditionArgv
    // produce a flat ['claude', '-p', ...] array) -- spawnCondition itself adds the one level
    // of `bash -c` wrapping. An already-bash-wrapped argv here would double-wrap, which
    // reproduces a DIFFERENT, real bug found during development: killing the outer wrapper did
    // not reliably terminate a process it spawned further down (nested-bash or backgrounded
    // child) via a plain child.kill() -- confirmed empirically on Windows, fixed by tree-killing
    // via `taskkill /F /T` (win32) / a POSIX process-group kill (killTree in condition-launcher.mjs).
    const argv = ['sleep', '60'];
    const start = Date.now();
    const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 300 });
    expect(result.terminated).toBe(true);
    expect(result.terminationReason).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10000);

  it('captures stdout emitted across multiple chunks/lines without dropping or duplicating any', async () => {
    const argv = ['bash', '-c', 'for i in 1 2 3 4 5; do echo "row-$i"; done'];
    const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 10000 });
    expect(result.taggedLines.map((t) => t.line)).toEqual(['row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
  });

  it('resolves rather than hanging when the command itself fails to spawn', async () => {
    const result = await spawnCondition(['this-binary-does-not-exist-anywhere-xyz'], { env: process.env, cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('buildPolicySettingsFile', () => {
  it('generates a settings file wiring policy-hook.mjs as the PreToolUse Bash hook', () => {
    const settingsPath = buildPolicySettingsFile();
    expect(settingsPath.endsWith('settings.json')).toBe(true);
    const content = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(content.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(content.hooks.PreToolUse[0].hooks[0].command).toContain('policy-hook.mjs');
  });
});
