import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildInvocation, codexCliRuntimeAdapter, normalizeObservations, parseCodexSkillCatalog,
  preflight, prepareIsolatedHome, prepareSkillDelivery, probeInstallation,
} from '../../tools/agentic-eval/runtimes/codex-cli.mjs';
import { validateObservation, validateRuntimeAdapter } from '../../tools/agentic-eval/runtimes/contract.mjs';

const PROFILE = Object.freeze({
  id: 'sandboxed-unrestricted-v1', enabled: true, default: false,
  supported_runtime_ids: Object.freeze(['claude-code', 'codex-cli']),
  isolation_kind: 'external-sandbox', network_mode: 'restricted',
  isolation_attestation_required: true, policy_mode: 'not_applicable',
  required_capabilities: Object.freeze(['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence']),
});

const cleanup = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true });
});

describe('codex-cli adapter contract and invocation', () => {
  it('is a valid frozen first-class runtime adapter with honest capabilities', () => {
    expect(validateRuntimeAdapter(codexCliRuntimeAdapter)).toEqual({ ok: true, errors: [] });
    expect(codexCliRuntimeAdapter.id).toBe('codex-cli');
    expect(codexCliRuntimeAdapter.capabilities).toEqual({
      observationSources: ['jsonl', 'hooks', 'stderr'], structuredTranscript: true,
      correlatedToolResults: true, skillDeliveryModes: ['project-skill'], skillStateEvidence: true,
      usageDimensions: ['input', 'cached_input', 'output', 'reasoning_output'], softPermissionDenial: false,
    });
    expect(Object.isFrozen(codexCliRuntimeAdapter)).toBe(true);
  });

  it('uses prompt-safe stdin and only documented non-interactive flags', () => {
    const invocation = buildInvocation({ prompt: 'SECRET PROMPT', model: 'gpt-5.6-terra', settingsPath: 'hooks.json', executionProfile: PROFILE, reasoningMode: 'low' });
    expect(invocation.stdinText).toBe('SECRET PROMPT');
    expect(invocation.argv).toEqual([
      'codex', 'exec', '--json', '--ephemeral', '--color', 'never', '--ignore-user-config', '--ignore-rules',
      '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--enable', 'hooks',
      '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="low"', '-',
    ]);
    expect(invocation.argv).not.toContain('SECRET PROMPT');
    expect(invocation.runtimeContext).toEqual({ hooksSourcePath: 'hooks.json', modelConfigured: 'gpt-5.6-terra' });
  });
});

describe('codex-cli auth/version preflight', () => {
  it('probes version then official login status without returning credential metadata', async () => {
    const calls = [];
    const spawnFn = async (argv) => {
      calls.push(argv);
      return argv[1] === '--version'
        ? { exitCode: 0, terminated: false, rawStdout: 'codex-cli 0.154.0', stderr: '' }
        : { exitCode: 0, terminated: false, rawStdout: 'Logged in using ChatGPT', stderr: '' };
    };
    expect(await probeInstallation({ spawnFn })).toEqual({ installed: true, version: '0.154.0' });
    const result = await preflight({ spawnFn });
    expect(result).toEqual({ ok: true, terminated: false, exitCode: 0, loggedIn: true, reasonCode: null, cliVersion: '0.154.0' });
    expect(calls).toEqual([['codex', '--version'], ['codex', '--version'], ['codex', 'login', 'status']]);
  });

  it('fails closed on unavailable CLI, unauthenticated status, or unrecognized output', async () => {
    expect((await preflight({ spawnFn: async () => ({ exitCode: 1, terminated: false, rawStdout: '', stderr: '' }) })).reasonCode).toBe('codex_cli_unavailable');
    let call = 0;
    const unauth = async () => (++call === 1
      ? { exitCode: 0, terminated: false, rawStdout: 'codex-cli 0.154.0', stderr: '' }
      : { exitCode: 1, terminated: false, rawStdout: 'Not logged in', stderr: '' });
    expect((await preflight({ spawnFn: unauth })).reasonCode).toBe('auth_preflight_not_logged_in');
  });
});

describe('Codex project-skill isolation', () => {
  it('parses Windows and POSIX skill catalog paths without exposing prompt content', () => {
    const raw = JSON.stringify([{
      text: '- kmp-test-runner: KMP runner (file: C:\\isolated\\.agents\\skills\\kmp-test-runner\\SKILL.md)\n- other: X (file: /tmp/.agents/skills/other/SKILL.md)',
    }]);
    expect(parseCodexSkillCatalog(raw)).toEqual({ ok: true, entries: [
      { name: 'kmp-test-runner', path: 'C:\\isolated\\.agents\\skills\\kmp-test-runner\\SKILL.md' },
      { name: 'other', path: '/tmp/.agents/skills/other/SKILL.md' },
    ] });
  });

  it('expands Codex skill-root aliases before verifying the project skill identity', () => {
    const raw = JSON.stringify([{ text: '### Skill roots\n- `r11` = `C:\\isolated\\.agents\\skills`\n### Available skills\n- kmp-test-runner: KMP runner (file: r11/kmp-test-runner/SKILL.md)' }]);
    expect(parseCodexSkillCatalog(raw)).toEqual({ ok: true, entries: [
      { name: 'kmp-test-runner', path: join('C:\\isolated\\.agents\\skills', 'kmp-test-runner', 'SKILL.md') },
    ] });
  });

  it('materializes product only in .agents/skills and proves baseline catalog absence', async () => {
    const snapshot = mkdtempSync(join(tmpdir(), 'codex-snapshot-'));
    const fixture = mkdtempSync(join(tmpdir(), 'codex-fixture-'));
    cleanup.push(snapshot, fixture);
    const source = join(snapshot, '.skills', 'kmp-test-runner');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# test skill\n');
    const hookSource = join(snapshot, 'hooks.json');
    writeFileSync(hookSource, '{}');
    const base = { argv: ['codex', 'exec'], stdinText: 'p', runtimeContext: { hooksSourcePath: hookSource } };
    const spawnFn = async (_invocation, { cwd }) => {
      const skill = join(cwd, '.agents', 'skills', 'kmp-test-runner', 'SKILL.md');
      const entries = existsSync(skill) ? [`- kmp-test-runner: X (file: ${skill})`] : [];
      return { exitCode: 0, terminated: false, rawStdout: JSON.stringify(entries), stderr: '' };
    };
    const product = await prepareSkillDelivery(base, 'current-skill', snapshot, { fixtureDir: resolve(fixture), conditionEnv: {}, spawnFn });
    expect(product.runtimeContext).toMatchObject({ skillAvailable: true, profileMatchesCondition: true, snapshotBindingMatches: true });
    expect(readFileSync(join(fixture, '.agents', 'skills', 'kmp-test-runner', 'SKILL.md'), 'utf8')).toBe('# test skill\n');
    const baseline = await prepareSkillDelivery(base, 'no-skill', null, { fixtureDir: resolve(fixture), conditionEnv: {}, spawnFn });
    expect(baseline.runtimeContext.skillAvailable).toBe(false);
    expect(existsSync(join(fixture, '.agents', 'skills', 'kmp-test-runner'))).toBe(false);
  });

  it('distinguishes a duplicated target skill from a target path mismatch', async () => {
    const snapshot = mkdtempSync(join(tmpdir(), 'codex-snapshot-'));
    const fixture = mkdtempSync(join(tmpdir(), 'codex-fixture-'));
    cleanup.push(snapshot, fixture);
    const source = join(snapshot, '.skills', 'kmp-test-runner');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# test skill\n');
    const hookSource = join(snapshot, 'hooks.json');
    writeFileSync(hookSource, '{}');
    const base = { argv: ['codex', 'exec'], stdinText: 'p', runtimeContext: { hooksSourcePath: hookSource } };
    const duplicate = async () => ({ exitCode: 0, terminated: false, rawStdout: JSON.stringify([
      '- kmp-test-runner: X (file: C:\\one\\SKILL.md)',
      '- kmp-test-runner: X (file: C:\\two\\SKILL.md)',
    ]), stderr: '' });
    await expect(prepareSkillDelivery(base, 'current-skill', snapshot, {
      fixtureDir: resolve(fixture), conditionEnv: {}, spawnFn: duplicate,
    })).rejects.toThrow('codex_skill_isolation_target_count_failed');

    const wrongPath = async () => ({
      exitCode: 0, terminated: false,
      rawStdout: JSON.stringify(['- kmp-test-runner: X (file: C:\\wrong\\SKILL.md)']), stderr: '',
    });
    await expect(prepareSkillDelivery(base, 'current-skill', snapshot, {
      fixtureDir: resolve(fixture), conditionEnv: {}, spawnFn: wrongPath,
    })).rejects.toThrow('codex_skill_isolation_target_path_failed');
  });

  it('treats Windows path casing as the same existing skill file identity', async () => {
    const snapshot = mkdtempSync(join(tmpdir(), 'codex-snapshot-'));
    const fixture = mkdtempSync(join(tmpdir(), 'codex-fixture-'));
    cleanup.push(snapshot, fixture);
    const source = join(snapshot, '.skills', 'kmp-test-runner');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# test skill\n');
    const hookSource = join(snapshot, 'hooks.json');
    writeFileSync(hookSource, '{}');
    const base = { argv: ['codex', 'exec'], stdinText: 'p', runtimeContext: { hooksSourcePath: hookSource } };
    const spawnFn = async (_invocation, { cwd }) => {
      const skill = join(cwd, '.agents', 'skills', 'kmp-test-runner', 'SKILL.md');
      const reported = process.platform === 'win32' ? skill.toUpperCase() : skill;
      return { exitCode: 0, terminated: false, rawStdout: JSON.stringify([
        `- kmp-test-runner: X (file: ${reported})`,
      ]), stderr: '' };
    };
    const product = await prepareSkillDelivery(base, 'current-skill', snapshot, {
      fixtureDir: resolve(fixture), conditionEnv: {}, spawnFn,
    });
    expect(product.runtimeContext.targetIdentityOk).toBe(true);
  });

  it('creates only the requested JUnit project hook with no policy or model-observation hook', async () => {
    const isolated = await prepareIsolatedHome({
      shimDir: 'C:\\shim', gradleUserHome: 'C:\\gradle', kmpEvalTempHome: 'C:\\temp',
      expectedFixtureRoot: 'C:\\fixture', allowedGradleTasks: ['test'], allowedKmpTestSubcommands: ['parallel'],
      junitEvidenceEnabled: true, executionProfile: PROFILE,
    });
    cleanup.push(...isolated.cleanupPaths);
    const hooks = JSON.parse(readFileSync(isolated.settingsPath, 'utf8')).hooks;
    expect(Object.keys(hooks)).toEqual(['PostToolUse']);
    expect(hooks.PreToolUse).toBeUndefined();
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.PostToolUse[0].hooks[0].command).toContain(process.execPath);
  });

  // D5 (PLAN-A-cierre-evidence1.md 2.3) sets BASH_DEFAULT_TIMEOUT_MS/BASH_MAX_TIMEOUT_MS
  // explicitly for the Claude adapter only -- Claude Code's own documented env vars
  // (docs.claude.com/en/docs/claude-code/env-vars), meaningless to codex-cli. Codex's own
  // prepareIsolatedHome (this file's import) is untouched by that change.
  it('does not set Claude-specific Bash timeout env vars', async () => {
    const isolated = await prepareIsolatedHome({
      shimDir: 'C:\\shim', gradleUserHome: 'C:\\gradle', kmpEvalTempHome: 'C:\\temp',
      expectedFixtureRoot: 'C:\\fixture', allowedGradleTasks: ['test'], allowedKmpTestSubcommands: ['parallel'],
      executionProfile: PROFILE,
    });
    cleanup.push(...isolated.cleanupPaths);
    expect(isolated.sharedEnv).not.toHaveProperty('BASH_DEFAULT_TIMEOUT_MS');
    expect(isolated.sharedEnv).not.toHaveProperty('BASH_MAX_TIMEOUT_MS');
  });

  // Claude Code's auto memory flag and the five launcher variables the Claude adapter passes through are
  // Claude-only: Codex memories are off by default, and the Codex env must not grow any of them.
  const CLAUDE_ONLY_VARS = [
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDE_CODE_DISABLE_ARTIFACT',
  ];

  async function codexSharedEnv() {
    const isolated = await prepareIsolatedHome({
      shimDir: 'C:\\shim', gradleUserHome: 'C:\\gradle', kmpEvalTempHome: 'C:\\temp',
      expectedFixtureRoot: 'C:\\fixture', allowedGradleTasks: ['test'], allowedKmpTestSubcommands: ['parallel'],
      executionProfile: PROFILE,
    });
    cleanup.push(...isolated.cleanupPaths);
    return isolated.sharedEnv;
  }

  it('does not set the Claude auto-memory flag', async () => {
    expect(await codexSharedEnv()).not.toHaveProperty('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
  });

  it('does not pass the Claude-only variables through, even when the parent environment holds them', async () => {
    const saved = Object.fromEntries(CLAUDE_ONLY_VARS.map((name) => [name, process.env[name]]));
    for (const name of CLAUDE_ONLY_VARS) process.env[name] = 'parent-value';
    try {
      const sharedEnv = await codexSharedEnv();
      for (const name of CLAUDE_ONLY_VARS) expect(sharedEnv, name).not.toHaveProperty(name);
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
});

describe('Codex observation normalization', () => {
  it('maps documented events and usage to the common contract without fabricating cache writes or skill activation', () => {
    const events = [
      { type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.started' },
      { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: './gradlew test' } },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', aggregated_output: 'ok', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 4 } },
    ];
    const rawJsonl = events.map((event) => JSON.stringify(event)).join('\n');
    const observation = normalizeObservations({
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 1n, endedHrtimeNs: 2n },
      providerSources: { rawJsonl, taggedLines: [], delivery: {
        modelConfigured: 'gpt-5.6-terra',
        skillAvailable: true, profileMatchesCondition: true, snapshotBindingMatches: true,
        ambientNames: new Set(['other']), targetIdentityOk: true,
      } },
    }, { executionProfile: PROFILE, runtimePreflight: { cliVersion: '0.154.0' } });
    expect(validateObservation(observation)).toEqual({ ok: true, errors: [] });
    expect(observation.session).toMatchObject({ modelResolved: 'gpt-5.6-terra', runtimeVersion: '0.154.0' });
    expect(observation.terminal.usage).toEqual({ input: 10, cached_input: 2, cache_write: null, output: 5, reasoning_output: 4 });
    expect(observation.skill.targetInvocation).toBeNull();
    expect(observation.toolAttempts[0].result).toMatchObject({ found: true, isError: false, text: 'ok' });
  });

  it('does not claim the configured model was resolved when no Codex thread started', () => {
    const observation = normalizeObservations({
      process: { exitCode: 1, terminated: false, terminationReason: null, spawnHrtimeNs: 1n, endedHrtimeNs: 2n },
      providerSources: {
        rawJsonl: '', taggedLines: [],
        delivery: { modelConfigured: 'gpt-5.6-terra', ambientNames: new Set(), targetIdentityOk: true },
      },
    }, { executionProfile: PROFILE, runtimePreflight: { cliVersion: '0.154.0' } });
    expect(observation.session).toMatchObject({ initPresent: false, modelResolved: null });
  });
});
