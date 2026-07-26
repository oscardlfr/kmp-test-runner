// tests/vitest/agentic-eval-condition-launcher.test.js
// Unit tests for tools/agentic-eval/condition-launcher.mjs. Argv/env construction only --
// mocked spawn, no real claude process. Real end-to-end spawn behavior is proven separately
// (Step 1 gate evidence, in the PR description) since it inherently requires a real session.
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // Every argv here is a PLAIN command (no nested 'bash -c ...' inside argv itself) -- matching
  // how buildBaseArgv/buildConditionArgv actually shape a real invocation (['claude', '-p',
  // ...]). spawnCondition already adds the one level of bash -c wrapping; an argv that ALSO
  // starts with 'bash' would double-wrap and depend on the outer (correctly resolveBash()'d)
  // process successfully resolving a nested, PATH-ambiguous 'bash' a second time -- the exact
  // portability hazard resolveBash() exists to eliminate at the outer layer.
  it('resolves with rawStdout, a zero exitCode, and per-line receiptNs values that are non-decreasing', async () => {
    const argv = ['printf', 'line1\nline2\nline3\n'];
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

  it('a normal nonzero exit is NOT a "termination" -- exit_code alone conveys it (terminated:false, reason:null)', async () => {
    // Regression coverage for a real schema-violation bug found by an independent review pass:
    // this exact case previously produced {terminated:false, terminationReason:'error'}, a
    // combination schemas.mjs itself rejects (terminated:false requires termination_reason:null).
    // A process that ran to a normal (if unsuccessful) conclusion was never "terminated" in the
    // abnormal sense that field is meant to capture -- only OUR OWN timeout firing, or the
    // process being killed by some signal we did not send, should ever set terminated:true.
    const argv = ['node', '-e', 'process.exit(7)'];
    const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 10000 });
    expect(result.exitCode).toBe(7);
    expect(result.terminated).toBe(false);
    expect(result.terminationReason).toBeNull();
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
    const argv = ['printf', 'row-1\nrow-2\nrow-3\nrow-4\nrow-5\n'];
    const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 10000 });
    expect(result.taggedLines.map((t) => t.line)).toEqual(['row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
  });

  it('resolves rather than hanging when the command itself fails to spawn', async () => {
    const result = await spawnCondition(['this-binary-does-not-exist-anywhere-xyz'], { env: process.env, cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.exitCode).not.toBe(0);
  });

  it('when the spawn itself fails (ENOENT), resolves with a schema-valid terminated/termination_reason pair', async () => {
    // A nonexistent cwd reliably triggers Node's real child.on('error', ...) path (distinct from
    // the previous test, where bash spawns fine and only the COMMAND inside it is missing) --
    // resolveBash() checks well-known absolute install paths first, so an empty/broken PATH env
    // alone no longer reproduces this (confirmed: it fell through to a normal close/127 instead).
    // The schema rejects terminated:false paired with a non-null termination_reason -- this
    // confirms the fix, not just that the promise resolves.
    //
    // The missing directory is a REAL temp directory, created then immediately removed --
    // guaranteed absent on every platform this suite runs on, rather than a hardcoded
    // Windows-drive-letter-shaped string. An earlier version of this test used a literal
    // 'C:\\...' path, which is only an absolute (and thus reliably nonexistent) path on Windows
    // -- on POSIX it's just an unusual relative path name, technically not a principled
    // guarantee of absence even though it happened to work in practice.
    const missingDir = mkdtempSync(join(tmpdir(), 'aecl-missing-'));
    rmSync(missingDir, { recursive: true, force: true });
    const result = await spawnCondition(['anything'], { env: process.env, cwd: missingDir, timeoutMs: 5000 });
    expect(result.exitCode).toBeNull();
    expect(result.terminated).toBe(true);
    expect(result.terminationReason).toBe('error');
    expect(result.stderr).toContain('[spawn error]');
  });

  // endedHrtimeNs (accepted-run-observability PR): the ONE monotonic-completion-time counterpart
  // to spawnHrtimeNs -- captured immediately before resolving, on BOTH the child 'close' path
  // (a normal exit, this test) and the child 'error' path (spawn failure, the next test). Without
  // this, post_signal_ms has no monotonic end-of-condition time to subtract from at all.
  describe('endedHrtimeNs -- monotonic completion time (accepted-run-observability)', () => {
    it('is a bigint at or after spawnHrtimeNs and every tagged line\'s own receiptNs, on a normal close', async () => {
      const argv = ['printf', 'line1\nline2\n'];
      const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 10000 });
      expect(typeof result.endedHrtimeNs).toBe('bigint');
      expect(result.endedHrtimeNs >= result.spawnHrtimeNs).toBe(true);
      for (const { receiptNs } of result.taggedLines) {
        expect(result.endedHrtimeNs >= receiptNs).toBe(true);
      }
    });

    it('is a bigint at or after spawnHrtimeNs on the spawn-error (child "error" event) path too', async () => {
      const missingDir = mkdtempSync(join(tmpdir(), 'aecl-missing-ended-'));
      rmSync(missingDir, { recursive: true, force: true });
      const result = await spawnCondition(['anything'], { env: process.env, cwd: missingDir, timeoutMs: 5000 });
      expect(result.terminated).toBe(true);
      expect(result.terminationReason).toBe('error');
      expect(typeof result.endedHrtimeNs).toBe('bigint');
      expect(result.endedHrtimeNs >= result.spawnHrtimeNs).toBe(true);
    });

    it('reflects the real elapsed wall-clock-ish gap for a command with a deliberate delay', async () => {
      // node -e 'a busy-ish delay' -- avoids depending on a real `sleep` binary being on PATH
      // (this repo's own portability discipline: spawnCondition always resolves via bash -c).
      const argv = ['node', '-e', 'const t=Date.now(); while(Date.now()-t<50){}'];
      const result = await spawnCondition(argv, { env: process.env, cwd: process.cwd(), timeoutMs: 10000 });
      const elapsedMs = Number(result.endedHrtimeNs - result.spawnHrtimeNs) / 1e6;
      expect(elapsedMs).toBeGreaterThanOrEqual(40); // comfortably below the real ~50ms delay, avoiding flakiness
    });
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

  // Round-4 fix (the headline finding of this PR's own final review round): registering the new
  // JUnit-evidence hooks must be CONDITIONAL on junitEvidenceEnabled, not merely internally inert --
  // calibrate/smoke/no_applicable_tests must produce a settings.json Claude Code cannot tell apart
  // from before this mechanism existed at all (no extra hook subprocess spawn, no extra
  // hook_started/hook_response transcript lines).
  describe('junitEvidenceEnabled gating -- byte-identical when false/omitted, additive when true', () => {
    it('omitting the option produces the exact same hooks shape as passing {junitEvidenceEnabled:false} explicitly', () => {
      const pathDefault = buildPolicySettingsFile();
      const pathExplicitFalse = buildPolicySettingsFile({ junitEvidenceEnabled: false });
      try {
        const contentDefault = JSON.parse(readFileSync(pathDefault, 'utf8'));
        const contentExplicitFalse = JSON.parse(readFileSync(pathExplicitFalse, 'utf8'));
        expect(contentDefault).toEqual(contentExplicitFalse);
      } finally {
        rmSync(join(pathDefault, '..'), { recursive: true, force: true });
        rmSync(join(pathExplicitFalse, '..'), { recursive: true, force: true });
      }
    });

    it('junitEvidenceEnabled:false (or omitted) produces hooks with ONLY the PreToolUse entry -- no PostToolUse/PostToolUseFailure keys at all', () => {
      const settingsPath = buildPolicySettingsFile({ junitEvidenceEnabled: false });
      try {
        const content = JSON.parse(readFileSync(settingsPath, 'utf8'));
        expect(Object.keys(content.hooks)).toEqual(['PreToolUse']);
      } finally {
        rmSync(join(settingsPath, '..'), { recursive: true, force: true });
      }
    });

    it('junitEvidenceEnabled:true adds exactly PostToolUse and PostToolUseFailure, both wiring junit-evidence-hook.mjs on matcher "Bash", while the sole PreToolUse entry is preserved unchanged', () => {
      const pathWithout = buildPolicySettingsFile({ junitEvidenceEnabled: false });
      const pathWith = buildPolicySettingsFile({ junitEvidenceEnabled: true });
      try {
        const contentWithout = JSON.parse(readFileSync(pathWithout, 'utf8'));
        const contentWith = JSON.parse(readFileSync(pathWith, 'utf8'));

        expect(contentWith.hooks.PreToolUse).toEqual(contentWithout.hooks.PreToolUse);
        expect(Object.keys(contentWith.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);

        for (const eventName of ['PostToolUse', 'PostToolUseFailure']) {
          expect(contentWith.hooks[eventName]).toHaveLength(1);
          expect(contentWith.hooks[eventName][0].matcher).toBe('Bash');
          expect(contentWith.hooks[eventName][0].hooks[0].command).toContain('junit-evidence-hook.mjs');
          expect(contentWith.hooks[eventName][0].hooks[0].command).not.toContain('policy-hook.mjs');
        }
      } finally {
        rmSync(join(pathWithout, '..'), { recursive: true, force: true });
        rmSync(join(pathWith, '..'), { recursive: true, force: true });
      }
    });
  });
});
