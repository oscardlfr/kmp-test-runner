// tests/vitest/agentic-eval-claude-runtime-adapter.test.js
// Unit tests for tools/agentic-eval/runtimes/claude-code.mjs -- the Claude Code runtime adapter
// that composes the frozen condition-launcher/auth-preflight/env-builder/stream-parser/privacy
// modules behind the runtimes/contract.mjs boundary. Uses only the two sanitized JSONL fixtures
// already committed by PR #436 (tests/vitest/fixtures/agentic-eval-stream-{current-skill,
// no-skill}.jsonl) -- no prompts, final prose, cwd, literal session ID, full tool input, or raw
// content appear in any expectation here; every asserted string is either a closed enum/code
// value or a placeholder the fixture itself already carries (e.g. "[synthetic-command]").
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCodeRuntimeAdapter,
  probeInstallation,
  preflight,
  prepareIsolatedHome,
  prepareSkillDelivery,
  buildInvocation,
  normalizeObservations,
  redactRuntimeDiagnostics,
  isPluginBoundToSnapshot,
  EXPECTED_TOOL_NAMES,
} from '../../tools/agentic-eval/runtimes/claude-code.mjs';
import { validateRuntimeAdapter, validateObservation } from '../../tools/agentic-eval/runtimes/contract.mjs';

const FIXTURES_DIR = join('tests', 'vitest', 'fixtures');
const CURRENT_SKILL_RAW = readFileSync(join(FIXTURES_DIR, 'agentic-eval-stream-current-skill.jsonl'), 'utf8');
const NO_SKILL_RAW = readFileSync(join(FIXTURES_DIR, 'agentic-eval-stream-no-skill.jsonl'), 'utf8');

const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

// PR 4: the two real execution-profile shapes, mirrored from registries.mjs's own shipped
// registry.json literals (frozen, matching how resolveSelection actually returns them -- proves
// buildInvocation/prepareIsolatedHome never need to mutate what they receive).
const STRICT_PROFILE = Object.freeze({
  id: 'strict-policy-v1', enabled: true, default: true, supported_runtime_ids: Object.freeze(['claude-code']),
  isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
  isolation_attestation_required: false, policy_mode: 'required',
  required_capabilities: Object.freeze(['softPermissionDenial']),
});
const UNRESTRICTED_PROFILE = Object.freeze({
  id: 'sandboxed-unrestricted-v1', enabled: true, default: false, supported_runtime_ids: Object.freeze(['claude-code']),
  isolation_kind: 'external-sandbox', network_mode: 'restricted',
  isolation_attestation_required: true, policy_mode: 'not_applicable',
  required_capabilities: Object.freeze(['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence']),
});

function receiptMap(eventCount) {
  // Mirrors parseStreamJsonl's own fallback (no taggedLines supplied): receiptNs = BigInt(line
  // index) per event, and every line in both fixtures parses cleanly (malformedLineCount:0), so
  // event index and line index coincide exactly -- a formula, not a hand-typed table.
  return new Map(Array.from({ length: eventCount }, (_, i) => [i, BigInt(i)]));
}

describe('claudeCodeRuntimeAdapter -- shape', () => {
  it('validates clean against runtimes/contract.mjs\'s own adapter validator', () => {
    const result = validateRuntimeAdapter(claudeCodeRuntimeAdapter);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('id is exactly "claude-code"; protocolVersion is exactly 1', () => {
    expect(claudeCodeRuntimeAdapter.id).toBe('claude-code');
    expect(claudeCodeRuntimeAdapter.protocolVersion).toBe(1);
  });

  it('declares the exact literal capabilities from the runbook contract', () => {
    expect(claudeCodeRuntimeAdapter.capabilities).toEqual({
      observationSources: ['stream-jsonl', 'stderr'],
      structuredTranscript: true,
      correlatedToolResults: true,
      skillDeliveryModes: ['plugin-dir'],
      skillStateEvidence: true,
      usageDimensions: ['input', 'cached_input', 'cache_write', 'output'],
      softPermissionDenial: true,
    });
  });

  it('is frozen, including its capabilities and their arrays', () => {
    expect(Object.isFrozen(claudeCodeRuntimeAdapter)).toBe(true);
    expect(Object.isFrozen(claudeCodeRuntimeAdapter.capabilities)).toBe(true);
    expect(Object.isFrozen(claudeCodeRuntimeAdapter.capabilities.observationSources)).toBe(true);
  });
});

// Migrated here from tests/vitest/agentic-eval-cell-integrity.test.js's own 'isPluginBoundToSnapshot'
// describe block -- the function moved to this module (it is a genuinely Claude-specific fact: a
// real plugin.json path Claude Code reports on the wire), so cell-integrity.mjs no longer exports
// it. Same 6 cases, same assertions -- only the import path changed.
describe('isPluginBoundToSnapshot', () => {
  const FAKE_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-adapter-snapshot-'));
  const WRONG_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-adapter-wrong-snapshot-'));
  afterAll(() => {
    rmSync(FAKE_SNAPSHOT_DIR, { recursive: true, force: true });
    rmSync(WRONG_SNAPSHOT_DIR, { recursive: true, force: true });
  });

  it('true when the reported path and the expected snapshot dir are the SAME real directory', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: FAKE_SNAPSHOT_DIR }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(true);
  });

  it('false when the reported path is a DIFFERENT real directory than the expected snapshot', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: WRONG_SNAPSHOT_DIR }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false (fail closed) when the reported path does not exist on disk', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: '/definitely/does/not/exist' }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false when init has no plugins at all', () => {
    expect(isPluginBoundToSnapshot({ plugins: [] }, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false when init has more than one plugin', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: FAKE_SNAPSHOT_DIR }, { name: 'other', path: FAKE_SNAPSHOT_DIR }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false when initEvent is null', () => {
    expect(isPluginBoundToSnapshot(null, FAKE_SNAPSHOT_DIR)).toBe(false);
  });
});

describe('EXPECTED_TOOL_NAMES -- the literal Claude tools profile', () => {
  it('is exactly the Set {Bash, Skill}', () => {
    expect([...EXPECTED_TOOL_NAMES].sort()).toEqual(['Bash', 'Skill']);
  });
});

describe('buildInvocation -- byte-identical to condition-launcher.mjs\'s buildBaseArgv contract', () => {
  it('freezes the exact full argv for the defaults case (mirrors agentic-eval-condition-launcher.test.js)', () => {
    const argv = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS' });
    expect(argv).toEqual([
      'claude', '-p', 'PROMPT',
      '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--model', 'claude-sonnet-5',
      '--setting-sources', '', '--strict-mcp-config', '--no-chrome',
      '--no-session-persistence', '--settings', 'SETTINGS',
      '--tools', 'Bash,Skill',
      '--permission-mode', 'dontAsk',
      '--max-budget-usd', '0.6',
    ]);
  });

  it('freezes the exact full argv when model/maxBudgetUsd are supplied', () => {
    const argv = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS', model: 'MODEL', maxBudgetUsd: 1.25 });
    expect(argv).toEqual([
      'claude', '-p', 'PROMPT',
      '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--model', 'MODEL',
      '--setting-sources', '', '--strict-mcp-config', '--no-chrome',
      '--no-session-persistence', '--settings', 'SETTINGS',
      '--tools', 'Bash,Skill',
      '--permission-mode', 'dontAsk',
      '--max-budget-usd', '1.25',
    ]);
  });
});

describe('buildInvocation -- executionProfile-aware permission mode (PR 4)', () => {
  it('omitting executionProfile still defaults to dontAsk -- byte-identical to the pre-existing frozen argv (strict, unchanged)', () => {
    const withDefault = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS' });
    expect(withDefault[withDefault.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('executionProfile:strict-policy-v1 (policy_mode:required) produces the SAME byte-identical argv as omitting it entirely', () => {
    const withDefault = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS' });
    const withStrict = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS', executionProfile: STRICT_PROFILE });
    expect(withStrict).toEqual(withDefault);
  });

  it('executionProfile:sandboxed-unrestricted-v1 (policy_mode:not_applicable) produces the identical argv shape/order with ONLY --permission-mode swapped to bypassPermissions', () => {
    const strict = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS' });
    const unrestricted = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS', executionProfile: UNRESTRICTED_PROFILE });
    expect(unrestricted.length).toBe(strict.length);
    const idx = strict.indexOf('--permission-mode');
    expect(unrestricted.slice(0, idx)).toEqual(strict.slice(0, idx));
    expect(unrestricted.slice(idx + 2)).toEqual(strict.slice(idx + 2));
    expect(unrestricted[idx + 1]).toBe('bypassPermissions');
  });

  it('never contains --dangerously-skip-permissions -- only --permission-mode bypassPermissions is ever compiled', () => {
    const unrestricted = buildInvocation({ prompt: 'PROMPT', settingsPath: 'SETTINGS', executionProfile: UNRESTRICTED_PROFILE });
    expect(unrestricted.join(' ')).not.toContain('dangerously-skip-permissions');
  });

  it('the SAME Bash,Skill --tools value and model/budget appear for both profiles', () => {
    const strict = buildInvocation({
      prompt: 'p', settingsPath: 's', model: 'M', maxBudgetUsd: 2, executionProfile: STRICT_PROFILE,
    });
    const unrestricted = buildInvocation({
      prompt: 'p', settingsPath: 's', model: 'M', maxBudgetUsd: 2, executionProfile: UNRESTRICTED_PROFILE,
    });
    expect(strict[strict.indexOf('--tools') + 1]).toBe('Bash,Skill');
    expect(unrestricted[unrestricted.indexOf('--tools') + 1]).toBe('Bash,Skill');
    expect(strict[strict.indexOf('--model') + 1]).toBe('M');
    expect(unrestricted[unrestricted.indexOf('--model') + 1]).toBe('M');
    expect(strict[strict.indexOf('--max-budget-usd') + 1]).toBe('2');
    expect(unrestricted[unrestricted.indexOf('--max-budget-usd') + 1]).toBe('2');
  });

  it('a frozen executionProfile object (exactly as resolveSelection returns) works fine -- buildInvocation never attempts to mutate it', () => {
    expect(() => buildInvocation({ prompt: 'p', settingsPath: 's', executionProfile: UNRESTRICTED_PROFILE })).not.toThrow();
  });
});

describe('prepareIsolatedHome -- executionProfile-aware settings/env compilation (PR 4)', () => {
  const baseOpts = {
    shimDir: 'C:\\shim', gradleUserHome: 'C:\\gradle-home', kmpEvalTempHome: 'C:\\kmp-home',
    expectedFixtureRoot: 'C:\\fixture', allowedGradleTasks: ['build'], allowedKmpTestSubcommands: ['doctor'],
  };

  it('omitting executionProfile still produces settings WITH the PreToolUse policy hook and env WITH the policy allowlist keys -- strict\'s pre-existing shape, unchanged', async () => {
    const { sharedEnv, settingsPath, cleanupPaths } = await prepareIsolatedHome(baseOpts);
    try {
      const content = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(content.hooks.PreToolUse[0].hooks[0].command).toContain('policy-hook.mjs');
      expect(JSON.parse(sharedEnv.KMP_EVAL_ALLOWED_GRADLE_TASKS)).toEqual(['build']);
    } finally {
      for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
    }
  });

  it('executionProfile:strict-policy-v1 produces the identical shape as omitting it', async () => {
    const omitted = await prepareIsolatedHome(baseOpts);
    const explicitStrict = await prepareIsolatedHome({ ...baseOpts, executionProfile: STRICT_PROFILE });
    try {
      expect(JSON.parse(readFileSync(explicitStrict.settingsPath, 'utf8'))).toEqual(JSON.parse(readFileSync(omitted.settingsPath, 'utf8')));
      expect(explicitStrict.sharedEnv).toEqual(omitted.sharedEnv);
    } finally {
      for (const p of omitted.cleanupPaths) rmSync(p, { recursive: true, force: true });
      for (const p of explicitStrict.cleanupPaths) rmSync(p, { recursive: true, force: true });
    }
  });

  it('executionProfile:sandboxed-unrestricted-v1 produces settings with NO PreToolUse key and env with NO policy allowlist keys at all', async () => {
    const { sharedEnv, settingsPath, cleanupPaths } = await prepareIsolatedHome({ ...baseOpts, executionProfile: UNRESTRICTED_PROFILE });
    try {
      const content = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(content.hooks.PreToolUse).toBeUndefined();
      expect(sharedEnv).not.toHaveProperty('KMP_EVAL_ALLOWED_GRADLE_TASKS');
      expect(sharedEnv).not.toHaveProperty('KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS');
      expect(sharedEnv.KMP_EVAL_EXPECTED_FIXTURE_ROOT).toBe('C:\\fixture');
      expect(sharedEnv.PATH.startsWith('C:\\shim')).toBe(true);
    } finally {
      for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
    }
  });

  it('executionProfile:sandboxed-unrestricted-v1 + junitEvidenceEnabled:true still wires the JUnit PostToolUse/PostToolUseFailure hooks', async () => {
    const { settingsPath, cleanupPaths } = await prepareIsolatedHome({
      ...baseOpts, executionProfile: UNRESTRICTED_PROFILE, junitEvidenceEnabled: true,
    });
    try {
      const content = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(Object.keys(content.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure']);
    } finally {
      for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
    }
  });

  it('unrestricted still rejects invalid policy grammar -- allowedGradleTasks/allowedKmpTestSubcommands are scenario config, validated regardless of profile', async () => {
    await expect(prepareIsolatedHome({
      ...baseOpts, executionProfile: UNRESTRICTED_PROFILE, allowedGradleTasks: ['build; rm -rf /'],
    })).rejects.toThrow(/Invalid policy configuration/);
  });
});

describe('prepareSkillDelivery -- condition delta (mirrors agentic-eval-condition-launcher.test.js)', () => {
  it('no-skill returns the base argv completely unchanged (same reference)', () => {
    const base = buildInvocation({ prompt: 'test', settingsPath: 'C:\\fake\\settings.json' });
    const argvA = prepareSkillDelivery(base, 'no-skill', null);
    expect(argvA).toBe(base);
  });

  it('current-skill is the base argv plus exactly one trailing --plugin-dir pair', () => {
    const base = buildInvocation({ prompt: 'test', settingsPath: 'C:\\fake\\settings.json' });
    const argvB = prepareSkillDelivery(base, 'current-skill', 'C:\\fake-snapshot');
    expect(argvB.slice(0, base.length)).toEqual(base);
    expect(argvB.slice(base.length)).toEqual(['--plugin-dir', 'C:\\fake-snapshot']);
  });

  it('current-skill without a snapshotDir throws rather than silently omitting --plugin-dir', () => {
    const base = buildInvocation({ prompt: 'test', settingsPath: 'C:\\fake\\settings.json' });
    expect(() => prepareSkillDelivery(base, 'current-skill', null)).toThrow();
  });
});

describe('prepareIsolatedHome -- byte-identical policy config between conditions', () => {
  it('builds a sharedEnv carrying the harness-controlled policy config, PATH-prepended with shimDir', async () => {
    const { sharedEnv, settingsPath, cleanupPaths } = await prepareIsolatedHome({
      shimDir: 'C:\\shim', gradleUserHome: 'C:\\gradle-home', kmpEvalTempHome: 'C:\\kmp-home',
      expectedFixtureRoot: 'C:\\fixture', allowedGradleTasks: ['build'], allowedKmpTestSubcommands: ['doctor'],
    });
    expect(sharedEnv.KMP_EVAL_EXPECTED_FIXTURE_ROOT).toBe('C:\\fixture');
    expect(JSON.parse(sharedEnv.KMP_EVAL_ALLOWED_GRADLE_TASKS)).toEqual(['build']);
    expect(sharedEnv.PATH.startsWith('C:\\shim')).toBe(true);
    expect(settingsPath.endsWith('settings.json')).toBe(true);
    expect(Array.isArray(cleanupPaths)).toBe(true);
    expect(cleanupPaths.length).toBeGreaterThan(0);
    for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
  });

  it('routes invalid policy grammar through the existing validator -- fails loudly at construction time', async () => {
    await expect(prepareIsolatedHome({
      shimDir: 'C:\\shim', gradleUserHome: 'C:\\gradle-home', kmpEvalTempHome: 'C:\\kmp-home',
      expectedFixtureRoot: 'C:\\fixture', allowedGradleTasks: ['build; rm -rf /'], allowedKmpTestSubcommands: [],
    })).rejects.toThrow(/Invalid policy configuration/);
  });
});

describe('preflight -- delegates to runAuthPreflight with the same closed reason codes', () => {
  it('ok:true, reasonCode:null on a healthy preflight', async () => {
    const spawnFn = async () => ({ exitCode: 0, terminated: false, rawStdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":null,"subscriptionType":null}' });
    const result = await preflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
    expect(result).toEqual({ ok: true, terminated: false, exitCode: 0, loggedIn: true, reasonCode: null });
  });

  it('ok:false, reasonCode:auth_preflight_terminated on a timeout, even with a well-formed body', async () => {
    const spawnFn = async () => ({ exitCode: 0, terminated: true, rawStdout: '{"loggedIn":true}' });
    const result = await preflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('auth_preflight_terminated');
  });

  it('ok:false, reasonCode:auth_preflight_nonzero_exit', async () => {
    const spawnFn = async () => ({ exitCode: 1, terminated: false, rawStdout: '{"loggedIn":false}' });
    const result = await preflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
    expect(result.reasonCode).toBe('auth_preflight_nonzero_exit');
  });

  it('ok:false, reasonCode:auth_preflight_not_logged_in', async () => {
    const spawnFn = async () => ({ exitCode: 0, terminated: false, rawStdout: '{"loggedIn":false}' });
    const result = await preflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
    expect(result.reasonCode).toBe('auth_preflight_not_logged_in');
  });

  it('ok:false, reasonCode:auth_preflight_invalid_response on unparseable stdout', async () => {
    const spawnFn = async () => ({ exitCode: 0, terminated: false, rawStdout: 'not json' });
    const result = await preflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
    expect(result.reasonCode).toBe('auth_preflight_invalid_response');
  });

  it('never exposes authMethod/apiProvider/subscriptionType -- exactly the 5 closed keys', async () => {
    const spawnFn = async () => ({ exitCode: 0, terminated: false, rawStdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"anthropic","subscriptionType":"pro"}' });
    const result = await preflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
    expect(Object.keys(result).sort()).toEqual(['exitCode', 'loggedIn', 'ok', 'reasonCode', 'terminated']);
  });

  it('issues the fixed, documented probe argv against the caller\'s sharedEnv/repoRoot/timeout unchanged', async () => {
    const calls = [];
    const sharedEnv = { PATH: '/fake/path' };
    const spawnFn = async (argv, opts) => { calls.push({ argv, opts }); return { exitCode: 0, terminated: false, rawStdout: '{"loggedIn":true}' }; };
    await preflight({ sharedEnv, repoRoot: '/real/repo', timeoutMs: 12345, spawnFn });
    expect(calls.length).toBe(1);
    expect(calls[0].argv).toEqual(['claude', 'auth', 'status', '--json']);
    expect(calls[0].opts.env).toBe(sharedEnv);
    expect(calls[0].opts.cwd).toBe('/real/repo');
    expect(calls[0].opts.timeoutMs).toBe(12345);
  });
});

describe('probeInstallation -- injected fake spawn only, never claude.exe', () => {
  it('reports installed:true with the observed version string from a fake spawn', async () => {
    const spawnFn = async () => ({ exitCode: 0, terminated: false, rawStdout: '2.1.212 (Claude Code)' });
    const result = await probeInstallation({ spawnFn });
    expect(result.installed).toBe(true);
    expect(result.version).toBe('2.1.212');
  });

  it('reports installed:false when the fake spawn fails to resolve the binary at all', async () => {
    const spawnFn = async () => ({ exitCode: null, terminated: true, rawStdout: '' });
    const result = await probeInstallation({ spawnFn });
    expect(result.installed).toBe(false);
    expect(result.version).toBeNull();
  });

  it('reports installed:false on a nonzero exit even with output present', async () => {
    const spawnFn = async () => ({ exitCode: 1, terminated: false, rawStdout: 'command not found' });
    const result = await probeInstallation({ spawnFn });
    expect(result.installed).toBe(false);
  });

  it('is never wired to a real subprocess by default in this PR -- calling it without an injected spawnFn throws a closed, explicit error rather than shelling out', async () => {
    await expect(probeInstallation({})).rejects.toThrow();
  });
});

describe('redactRuntimeDiagnostics -- delegates to the existing privacy primitive', () => {
  it('leaves clean text unchanged', () => {
    expect(redactRuntimeDiagnostics('all clean, nothing sensitive here')).toBe('all clean, nothing sensitive here');
  });

  it('redacts a Windows user-home-shaped path rather than leaking it verbatim', () => {
    const redacted = redactRuntimeDiagnostics('failed at C:\\Users\\realname\\project\\file.txt');
    expect(redacted).not.toContain('realname');
  });

  it('never throws on a string it cannot fully clean -- returns a safe closed fallback instead (diagnostics are best-effort, not the final journal/incident redaction tier)', () => {
    expect(() => redactRuntimeDiagnostics('some diagnostic text')).not.toThrow();
  });

  it('handles an object input by redacting each string field, never the other tiers\' final redaction contract', () => {
    const result = redactRuntimeDiagnostics({ note: 'path C:\\Users\\realname\\x', code: 'auth_preflight_terminated' });
    expect(JSON.stringify(result)).not.toContain('realname');
    expect(result.code).toBe('auth_preflight_terminated');
  });
});

describe('normalizeObservations -- current-skill fixture (real PR #436 JSONL)', () => {
  let observation;
  const context = {
    condition: 'current-skill',
    targetPluginName: TARGET_PLUGIN_NAME,
    targetSkillName: TARGET_SKILL_NAME,
    expectedToolNames: new Set(['Bash', 'Skill']),
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 10000n },
  };

  it('produces an observation that validates clean against the canonical contract', () => {
    const sources = { process: context.process, capture: { primaryText: CURRENT_SKILL_RAW, stderrText: '' }, providerSources: { rawJsonl: CURRENT_SKILL_RAW } };
    observation = normalizeObservations(sources, context);
    const result = validateObservation(observation);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('session identity: init present, model/session id/runtimeVersion resolved from the init event verbatim (mirrors the existing v5 session_id_observed/claude_code_version record fields)', () => {
    expect(observation.session).toEqual({
      initPresent: true,
      modelResolved: 'claude-sonnet-5',
      sessionIdObserved: 'sess-synthetic-0001',
      runtimeVersion: '2.1.212',
      toolProfileMatchesExpected: true,
    });
  });

  it('terminal status + canonical usage mapping (cache_read->cached_input, cache_creation->cache_write, reasoning_output:null)', () => {
    expect(observation.terminal).toEqual({
      present: true,
      isError: false,
      turnCount: 5,
      finalText: '[synthetic result text]',
      resultSubtype: 'success',
      usage: { input: 8, cached_input: 77339, cache_write: 5847, output: 1194, reasoning_output: null },
    });
  });

  it('transcript: 0 malformed lines, 3 strict/effective structural issues (2 empty_tool_use_id + 1 orphan_tool_result), 2 strict/effective incomplete Bash calls', () => {
    const structuralIssues = [
      { type: 'empty_tool_use_id' },
      { type: 'empty_tool_use_id' },
      { type: 'orphan_tool_result', id: null },
    ];
    const incompleteResults = [
      { index: 8, receiptNs: 8n, name: 'Bash', id: null },
      { index: 15, receiptNs: 15n, name: 'Bash', id: null },
    ];
    expect(observation.transcript).toEqual({
      malformedLineCount: 0,
      strictStructuralIssues: structuralIssues,
      effectiveStructuralIssues: structuralIssues,
      strictIncompleteToolResults: incompleteResults,
      effectiveIncompleteToolResults: incompleteResults,
    });
  });

  it('hooks: 2 hook pairs, both deny, fully paired and accounted for', () => {
    expect(observation.hookStats).toEqual({
      hookCallCount: 2, hookResponseCount: 2, hookDenyCount: 2, hookAllowCount: 0,
      hookPairingOk: true, everyCallHooked: true,
    });
  });

  it('bytes: output/stream-json byte counts match the fixture exactly', () => {
    expect(observation.byteMetrics).toEqual({ outputBytes: 69, streamJsonBytes: 6665 });
  });

  it('skill proof: available, profile matches condition, one confirmed target invocation, zero foreign uses, empty ambient set', () => {
    expect(observation.skill.available).toBe(true);
    expect(observation.skill.profileMatchesCondition).toBe(true);
    expect(observation.skill.snapshotBindingMatches).toBe(false); // no real snapshot dir on disk for this fixture's synthetic plugin path
    expect(observation.skill.targetInvocation).toEqual({
      attempted: true, confirmed: true, attemptCount: 1, eventIndex: 3, receiptNs: 3n, resultIsError: false,
    });
    expect(observation.skill.foreignInvocations).toEqual([]);
    expect(observation.skill.ambient.names).toEqual(new Set());
    expect(observation.skill.ambient.structurallyWellFormed).toBe(true);
    expect(observation.skill.ambient.targetIdentityOk).toBe(true);
  });

  it('toolAttempts: the Skill call plus two unresolved Bash calls, in transcript order, no raw content beyond the fixture\'s own placeholders', () => {
    expect(observation.toolAttempts).toEqual([
      {
        id: 'toolu_synthetic0001', kind: 'skill', runtimeName: 'Skill', eventIndex: 3, receiptNs: 3n,
        profileAllowed: true, command: null, skillReference: 'kmp-test-runner', targetsExpectedSkill: true,
        result: { found: true, eventIndex: 4, isError: false, text: '[synthetic tool result]', textStatus: 'text' },
        preDispatchBlock: { recognized: false, signature: null },
      },
      {
        id: null, kind: 'shell', runtimeName: 'Bash', eventIndex: 8, receiptNs: 8n,
        profileAllowed: true, command: '[synthetic-command]', skillReference: null, targetsExpectedSkill: null,
        result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
        preDispatchBlock: { recognized: false, signature: null },
      },
      {
        id: null, kind: 'shell', runtimeName: 'Bash', eventIndex: 15, receiptNs: 15n,
        profileAllowed: true, command: '[synthetic-command]', skillReference: null, targetsExpectedSkill: null,
        result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
        preDispatchBlock: { recognized: false, signature: null },
      },
    ]);
  });

  it('timing.receiptNsByEventIndex covers all 26 events, index i -> BigInt(i)', () => {
    expect(observation.timing.receiptNsByEventIndex).toEqual(receiptMap(26));
  });

  it('process/runtime carry through unchanged', () => {
    expect(observation.process).toEqual({ exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 10000n });
    expect(observation.runtime).toEqual({ id: 'claude-code', protocolVersion: 1 });
    expect(observation.schema).toBe(1);
  });
});

describe('normalizeObservations -- no-skill fixture (real PR #436 JSONL)', () => {
  let observation;
  const context = {
    condition: 'no-skill',
    targetPluginName: TARGET_PLUGIN_NAME,
    targetSkillName: TARGET_SKILL_NAME,
    expectedToolNames: new Set(['Bash', 'Skill']),
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 10000n },
  };

  it('produces an observation that validates clean against the canonical contract', () => {
    const sources = { process: context.process, capture: { primaryText: NO_SKILL_RAW, stderrText: '' }, providerSources: { rawJsonl: NO_SKILL_RAW } };
    observation = normalizeObservations(sources, context);
    expect(validateObservation(observation)).toEqual({ ok: true, errors: [] });
  });

  it('session identity + terminal status + canonical usage', () => {
    expect(observation.session).toEqual({
      initPresent: true, modelResolved: 'claude-sonnet-5', sessionIdObserved: 'sess-synthetic-0001',
      runtimeVersion: '2.1.212', toolProfileMatchesExpected: true,
    });
    expect(observation.terminal).toEqual({
      present: true, isError: false, turnCount: 2, finalText: '[synthetic result text]',
      resultSubtype: 'success',
      usage: { input: 4, cached_input: 32898, cache_write: 531, output: 790, reasoning_output: null },
    });
  });

  it('transcript: 0 malformed, 2 strict/effective structural issues (1 empty_tool_use_id + 1 orphan_tool_result), 1 strict/effective incomplete Bash call', () => {
    const structuralIssues = [{ type: 'empty_tool_use_id' }, { type: 'orphan_tool_result', id: null }];
    const incompleteResults = [{ index: 6, receiptNs: 6n, name: 'Bash', id: null }];
    expect(observation.transcript).toEqual({
      malformedLineCount: 0, strictStructuralIssues: structuralIssues, effectiveStructuralIssues: structuralIssues,
      strictIncompleteToolResults: incompleteResults, effectiveIncompleteToolResults: incompleteResults,
    });
  });

  it('hooks: 1 hook pair, denied, fully accounted for', () => {
    expect(observation.hookStats).toEqual({
      hookCallCount: 1, hookResponseCount: 1, hookDenyCount: 1, hookAllowCount: 0,
      hookPairingOk: true, everyCallHooked: true,
    });
  });

  it('bytes match the fixture exactly', () => {
    expect(observation.byteMetrics).toEqual({ outputBytes: 23, streamJsonBytes: 3405 });
  });

  it('skill proof: unavailable, no target invocation attempted, zero foreign uses -- a no-skill cell that never attempts the skill is legitimate', () => {
    expect(observation.skill.available).toBe(false);
    expect(observation.skill.profileMatchesCondition).toBe(true);
    expect(observation.skill.snapshotBindingMatches).toBe(false);
    expect(observation.skill.targetInvocation).toBeNull();
    expect(observation.skill.foreignInvocations).toEqual([]);
    expect(observation.skill.ambient.names).toEqual(new Set());
  });

  it('toolAttempts: exactly one unresolved Bash call', () => {
    expect(observation.toolAttempts).toEqual([
      {
        id: null, kind: 'shell', runtimeName: 'Bash', eventIndex: 6, receiptNs: 6n,
        profileAllowed: true, command: '[synthetic-command]', skillReference: null, targetsExpectedSkill: null,
        result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
        preDispatchBlock: { recognized: false, signature: null },
      },
    ]);
  });

  it('timing.receiptNsByEventIndex covers all 13 events', () => {
    expect(observation.timing.receiptNsByEventIndex).toEqual(receiptMap(13));
  });
});

describe('normalizeObservations -- malformed transcript retains its issues rather than reading clean', () => {
  it('a truncated/malformed JSONL line is preserved as malformedLineCount, not silently dropped into a clean-looking observation', () => {
    const malformedRaw = CURRENT_SKILL_RAW.trimEnd() + '\n{not valid json\n';
    const sources = {
      process: { exitCode: null, terminated: true, terminationReason: 'error', spawnHrtimeNs: 0n, endedHrtimeNs: 10000n },
      capture: { primaryText: malformedRaw, stderrText: '' },
      providerSources: { rawJsonl: malformedRaw },
    };
    const observation = normalizeObservations(sources, {
      condition: 'current-skill', targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
      expectedToolNames: new Set(['Bash', 'Skill']),
      process: sources.process,
    });
    expect(observation.transcript.malformedLineCount).toBe(1);
    const result = validateObservation(observation);
    expect(result.ok).toBe(true); // malformed lines are a reported FACT, not a contract violation
  });
});

describe('isRecognizedPreDispatchBlock normalization', () => {
  // Migrated here from tests/vitest/agentic-eval-junit-evidence.test.js's own
  // 'resolveDecisions -- recognized pre-dispatch block' it.each precision-matching cases: since
  // resolveDecisions no longer re-runs the strict matcher itself (it reads
  // attempt.preDispatchBlock.recognized, already computed by the adapter), the "does the transcript
  // shape actually match" precision this it.each exercised belongs here now -- the one and only
  // place the matcher still runs. No case's outcome changed; only where it's proven did.
  const REAL_BODY = 'Blocked: standalone sleep 60. To wait for a condition, use Monitor with an until-loop '
    + '(e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use '
    + 'run_in_background: true. Do not chain shorter sleeps to work around this block.';

  function preDispatchRaw({ command = 'sleep 60', resultBody = REAL_BODY, isError = true, extraEventBeforeResult = false, extraResultBlock = false } = {}) {
    const initLine = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/x', session_id: 's', tools: ['Bash', 'Skill'], mcp_servers: [], model: 'claude-sonnet-5', permissionMode: 'dontAsk', plugins: [], skills: [], apiKeySource: 'none', claude_code_version: '2.1.227' });
    const toolUseLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_pd_1', name: 'Bash', input: { command } }] } });
    const resultBlocks = [{ type: 'tool_result', tool_use_id: 'toolu_pd_1', content: `<tool_use_error>${resultBody}</tool_use_error>`, is_error: isError }];
    if (extraResultBlock) resultBlocks.push({ type: 'text', text: 'extra block' });
    const toolResultLine = JSON.stringify({ type: 'user', message: { content: resultBlocks }, tool_use_result: `Error: ${REAL_BODY}` });
    const fillerLine = JSON.stringify({ type: 'system', subtype: 'thinking_tokens' });
    const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: 'x', usage: {} });
    const lines = [initLine, toolUseLine];
    if (extraEventBeforeResult) lines.push(fillerLine);
    lines.push(toolResultLine, resultLine);
    return lines.join('\n') + '\n';
  }

  function normalizeFromRaw(raw) {
    const process_ = { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 100n };
    const observation = normalizeObservations(
      { process: process_, capture: { primaryText: raw, stderrText: '' }, providerSources: { rawJsonl: raw } },
      { condition: 'no-skill', targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, expectedToolNames: new Set(['Bash', 'Skill']), process: process_ },
    );
    return observation.toolAttempts.find((a) => a.kind === 'shell');
  }

  it('a real recognized pre-dispatch block normalizes to {recognized:true, signature:"claude-code/bash-pre-dispatch-block/v1"}', () => {
    const bashAttempt = normalizeFromRaw(preDispatchRaw());
    expect(bashAttempt.preDispatchBlock).toEqual({ recognized: true, signature: 'claude-code/bash-pre-dispatch-block/v1' });
  });

  it.each([
    ['a different command', { command: 'sleep 61' }],
    ['a divergent message', { resultBody: 'Blocked: something else entirely.' }],
    ['a non-error result', { isError: false }],
    ['a non-immediate result (an event intervenes)', { extraEventBeforeResult: true }],
    ['a multi-block result event', { extraResultBlock: true }],
  ])('stays recognized:false for %s -- the strict matcher never widens on inference', (_label, overrides) => {
    const bashAttempt = normalizeFromRaw(preDispatchRaw(overrides));
    expect(bashAttempt.preDispatchBlock).toEqual({ recognized: false, signature: null });
  });

  it('stays recognized:false for a divergent tool_use_result (the two compared strings must both match)', () => {
    // Not expressible via preDispatchRaw's overrides (tool_use_result is intentionally always
    // rendered from REAL_BODY there) -- built directly to diverge tool_use_result specifically
    // while tool_result.content stays the real, matching body.
    const initLine = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/x', session_id: 's', tools: ['Bash', 'Skill'], mcp_servers: [], model: 'claude-sonnet-5', permissionMode: 'dontAsk', plugins: [], skills: [], apiKeySource: 'none', claude_code_version: '2.1.227' });
    const toolUseLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_pd_1', name: 'Bash', input: { command: 'sleep 60' } }] } });
    const toolResultLine = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_pd_1', content: `<tool_use_error>${REAL_BODY}</tool_use_error>`, is_error: true }] }, tool_use_result: 'Error: nope' });
    const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: 'x', usage: {} });
    const raw = [initLine, toolUseLine, toolResultLine, resultLine].join('\n') + '\n';
    expect(normalizeFromRaw(raw).preDispatchBlock).toEqual({ recognized: false, signature: null });
  });
});
