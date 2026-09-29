#!/usr/bin/env node
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineRuntimeAdapter } from './contract.mjs';
import { buildSharedEnv, spawnCondition } from '../condition-launcher.mjs';
import {
  computeCodexByteMetrics, findCodexCommandAttempts, findCodexFinalText, findCodexStructuralIssues,
  findCodexTerminalEvent, findCodexThreadEvent, parseCodexJsonl,
} from '../codex-jsonl-parser.mjs';
import { redactAndVerify, redactObjectAndVerify } from '../privacy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTIC_EVAL_DIR = resolve(__dirname, '..');
const JUNIT_HOOK_PATH = join(AGENTIC_EVAL_DIR, 'junit-evidence-hook.mjs');
const TARGET_SKILL = 'kmp-test-runner';
const VERSION_RE = /(?:codex-cli(?:-exec)?\s+)?(\d+\.\d+\.\d+)/;
const LOGIN_OK_RE = /^Logged in using (?:ChatGPT|an API key)$/m;
const SAFE_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function isPlainObjectLike(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameStringArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}

const SUPPORTED_PROFILE = Object.freeze({
  id: 'sandboxed-unrestricted-v1',
  isolation_kind: 'external-sandbox',
  network_mode: 'restricted',
  isolation_attestation_required: true,
  policy_mode: 'not_applicable',
  required_capabilities: Object.freeze(['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence']),
});

export function supportsModelConfiguration(entry) {
  return isPlainObjectLike(entry)
    && entry.runtime_id === 'codex-cli'
    && entry.model_vendor_expected === 'openai'
    && typeof entry.model_id === 'string'
    && entry.model_id.length > 0
    && typeof entry.default_reasoning_mode === 'string'
    && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(entry.default_reasoning_mode);
}

export function supportsExecutionProfile(entry) {
  return isPlainObjectLike(entry)
    && entry.id === SUPPORTED_PROFILE.id
    && entry.isolation_kind === SUPPORTED_PROFILE.isolation_kind
    && entry.network_mode === SUPPORTED_PROFILE.network_mode
    && entry.isolation_attestation_required === SUPPORTED_PROFILE.isolation_attestation_required
    && entry.policy_mode === SUPPORTED_PROFILE.policy_mode
    && sameStringArray(entry.required_capabilities, SUPPORTED_PROFILE.required_capabilities);
}

async function runProbe(argv, { env, cwd, timeoutMs = 10000, spawnFn = spawnCondition } = {}) {
  return spawnFn(argv, { env, cwd, timeoutMs });
}

export async function probeInstallation({ sharedEnv = process.env, repoRoot = process.cwd(), timeoutMs = 10000, spawnFn } = {}) {
  const result = await runProbe(['codex', '--version'], { env: sharedEnv, cwd: repoRoot, timeoutMs, spawnFn: spawnFn ?? spawnCondition });
  const versionText = `${result.rawStdout ?? ''}\n${result.stderr ?? ''}`;
  const match = versionText.match(VERSION_RE);
  return {
    installed: result.terminated !== true && result.exitCode === 0 && match != null,
    version: match?.[1] ?? null,
  };
}

export async function preflight({ sharedEnv = process.env, repoRoot = process.cwd(), timeoutMs = 10000, spawnFn } = {}) {
  const runner = spawnFn ?? spawnCondition;
  const installation = await probeInstallation({ sharedEnv, repoRoot, timeoutMs, spawnFn: runner });
  if (!installation.installed) {
    return { ok: false, terminated: false, exitCode: null, loggedIn: null, reasonCode: 'codex_cli_unavailable', cliVersion: null };
  }
  const result = await runProbe(['codex', 'login', 'status'], { env: sharedEnv, cwd: repoRoot, timeoutMs, spawnFn: runner });
  const text = `${result.rawStdout ?? ''}\n${result.stderr ?? ''}`;
  const loggedIn = LOGIN_OK_RE.test(text);
  const reasonCode = result.terminated === true
    ? 'auth_preflight_timeout'
    : result.exitCode !== 0
      ? 'auth_preflight_not_logged_in'
      : loggedIn
        ? null
        : 'auth_preflight_invalid_response';
  return {
    ok: reasonCode == null,
    terminated: result.terminated === true,
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    loggedIn,
    reasonCode,
    cliVersion: installation.version,
  };
}

function isWithin(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sameExistingPath(left, right) {
  try {
    const leftReal = realpathSync.native(left);
    const rightReal = realpathSync.native(right);
    return process.platform === 'win32'
      ? leftReal.toLowerCase() === rightReal.toLowerCase()
      : leftReal === rightReal;
  } catch {
    return false;
  }
}

function optionalCodexHome() {
  const home = process.env.KMP_EVAL_CODEX_HOME;
  if (!home) return null;
  const root = process.env.KMP_EVAL_CODEX_RUNTIME_ROOT;
  if (!isAbsolute(home) || (root && (!isAbsolute(root) || !isWithin(home, root)))) {
    throw new Error('codex_home_outside_attested_runtime_root');
  }
  return home;
}

function hookCommand(path, ...args) {
  return [process.execPath, path, ...args].map((value) => `"${value}"`).join(' ');
}

function buildCodexHooksFile({ junitEvidenceEnabled }) {
  const dir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-codex-hooks-'));
  const path = join(dir, 'hooks.json');
  const hooks = {};
  if (junitEvidenceEnabled) {
    hooks.PostToolUse = [{ matcher: '^Bash$', hooks: [{ type: 'command', command: hookCommand(JUNIT_HOOK_PATH), commandWindows: hookCommand(JUNIT_HOOK_PATH), timeout: 10 }] }];
  }
  writeFileSync(path, JSON.stringify({ description: 'agentic-eval runtime observation hooks', hooks }, null, 2));
  return path;
}

export async function prepareIsolatedHome({
  shimDir, gradleUserHome, kmpEvalTempHome, expectedFixtureRoot, allowedGradleTasks,
  allowedKmpTestSubcommands, junitEvidenceEnabled = false, executionProfile,
} = {}) {
  if (!supportsExecutionProfile(executionProfile)) throw new Error('unsupported_codex_execution_profile');
  const hooksPath = buildCodexHooksFile({ junitEvidenceEnabled });
  const sharedEnv = buildSharedEnv({
    shimDir, gradleUserHome, kmpEvalTempHome, expectedFixtureRoot, allowedGradleTasks,
    allowedKmpTestSubcommands, includePolicyEnv: false,
  });
  const codexHome = optionalCodexHome();
  if (codexHome) sharedEnv.CODEX_HOME = codexHome;
  return { sharedEnv, settingsPath: hooksPath, cleanupPaths: [dirname(hooksPath)] };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function ambientTargetPaths(targetSkillName, fixtureDir) {
  const candidates = [];
  for (const base of [process.env.HOME, process.env.USERPROFILE]) {
    if (base) candidates.push(join(base, '.agents', 'skills', targetSkillName, 'SKILL.md'));
  }
  candidates.push(join('/etc/codex/skills', targetSkillName, 'SKILL.md'));
  const target = resolve(fixtureDir, '.agents', 'skills', targetSkillName, 'SKILL.md');
  return [...new Set(candidates.filter((path) => existsSync(path) && resolve(path) !== target).map((path) => resolve(path)))];
}

function skillDisableOverride(paths) {
  if (paths.length === 0) return null;
  // TOML basic strings reject Windows drive paths when their backslashes survive as escape
  // initiators. Forward slashes are accepted by Windows and keep the one-off -c value valid TOML.
  return `skills.config=[${paths.map((path) => `{path=${tomlString(path.replaceAll('\\', '/'))},enabled=false}`).join(',')}]`;
}

function collectText(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectText(item, out));
  else if (isPlainObjectLike(value)) Object.values(value).forEach((item) => collectText(item, out));
  return out;
}

export function parseCodexSkillCatalog(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, entries: [] }; }
  const text = collectText(parsed).join('\n');
  const roots = new Map();
  const rootRe = /^\s*-\s+`?(r\d+)`?\s*=\s*`([^`\r\n]+)`\s*$/gmi;
  for (const match of text.matchAll(rootRe)) roots.set(match[1], match[2]);
  const entries = [];
  const re = /^\s*-\s+([a-z0-9][a-z0-9-]*):[^\r\n]*\(file:\s*([^\r\n)]+[\\/]SKILL\.md)\)\s*$/gmi;
  for (const match of text.matchAll(re)) {
    if (!SAFE_SKILL_NAME_RE.test(match[1])) continue;
    const reported = match[2].trim();
    const aliasMatch = reported.match(/^(r\d+)[\\/](.+)$/);
    const expanded = aliasMatch != null && roots.has(aliasMatch[1])
      ? join(roots.get(aliasMatch[1]), ...aliasMatch[2].split(/[\\/]/))
      : reported;
    entries.push({ name: match[1], path: expanded });
  }
  return { ok: true, entries };
}

async function probeEffectiveSkillCatalog(invocation, { cwd, env, spawnFn = spawnCondition } = {}) {
  const configArgs = [];
  for (let i = 0; i < invocation.argv.length; i++) {
    if ((invocation.argv[i] === '-c' || invocation.argv[i] === '--config') && typeof invocation.argv[i + 1] === 'string') {
      configArgs.push('-c', invocation.argv[++i]);
    }
  }
  const result = await spawnFn({ argv: ['codex', 'debug', 'prompt-input', ...configArgs] }, { env, cwd, timeoutMs: 30000 });
  if (result.terminated === true || result.exitCode !== 0) throw new Error('codex_skill_catalog_probe_failed');
  const parsed = parseCodexSkillCatalog(result.rawStdout ?? '');
  if (!parsed.ok) throw new Error('codex_skill_catalog_invalid');
  return parsed.entries;
}

function directoryFingerprint(root) {
  const hash = createHash('sha256');
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full, rel);
      else if (entry.isFile()) {
        hash.update(`file\0${rel}\0`);
        hash.update(readFileSync(full));
        hash.update('\0');
      } else {
        throw new Error('codex_skill_snapshot_contains_unsupported_entry');
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

export async function prepareSkillDelivery(invocation, condition, snapshotDir, context = {}) {
  const { fixtureDir, conditionEnv, targetSkillName = TARGET_SKILL, spawnFn } = context;
  if (typeof fixtureDir !== 'string' || !isAbsolute(fixtureDir)) throw new Error('codex_skill_delivery_requires_fixture');
  const codexDir = join(fixtureDir, '.codex');
  mkdirSync(codexDir, { recursive: true });
  cpSync(invocation.runtimeContext.hooksSourcePath, join(codexDir, 'hooks.json'));

  const targetDir = join(fixtureDir, '.agents', 'skills', targetSkillName);
  if (condition === 'current-skill') {
    const sourceDir = join(snapshotDir, '.skills', targetSkillName);
    if (!existsSync(sourceDir)) throw new Error('codex_skill_snapshot_missing');
    mkdirSync(dirname(targetDir), { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true });
  } else if (condition === 'no-skill') {
    rmSync(targetDir, { recursive: true, force: true });
  } else {
    throw new Error('unsupported_codex_skill_condition');
  }

  const disabledPaths = ambientTargetPaths(targetSkillName, fixtureDir);
  const disableOverride = skillDisableOverride(disabledPaths);
  const prepared = {
    ...invocation,
    argv: disableOverride == null ? [...invocation.argv] : [...invocation.argv, '-c', disableOverride],
  };
  const entries = await probeEffectiveSkillCatalog(prepared, { cwd: fixtureDir, env: conditionEnv, spawnFn: spawnFn ?? spawnCondition });
  const targetEntries = entries.filter((entry) => entry.name === targetSkillName);
  const targetSkillFile = resolve(targetDir, 'SKILL.md');
  const expectedTargetCount = condition === 'current-skill' ? 1 : 0;
  if (targetEntries.length !== expectedTargetCount) {
    throw new Error('codex_skill_isolation_target_count_failed');
  }
  if (condition === 'current-skill' && !sameExistingPath(targetEntries[0].path, targetSkillFile)) {
    throw new Error('codex_skill_isolation_target_path_failed');
  }

  const ambientNames = new Set(entries.filter((entry) => entry.name !== targetSkillName).map((entry) => entry.name));
  return {
    ...prepared,
    runtimeContext: {
      ...prepared.runtimeContext,
      skillAvailable: condition === 'current-skill',
      profileMatchesCondition: true,
      snapshotBindingMatches: condition === 'current-skill'
        ? statSync(targetSkillFile).isFile() && directoryFingerprint(join(snapshotDir, '.skills', targetSkillName)) === directoryFingerprint(targetDir)
        : false,
      ambientNames,
      targetIdentityOk: true,
    },
  };
}

export function buildInvocation({ prompt, model, settingsPath, executionProfile, reasoningMode }) {
  if (!supportsExecutionProfile(executionProfile)) throw new Error('unsupported_codex_execution_profile');
  if (typeof reasoningMode !== 'string') throw new Error('codex_reasoning_mode_required');
  return {
    argv: [
      'codex', 'exec', '--json', '--ephemeral', '--color', 'never', '--ignore-user-config',
      '--ignore-rules', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
      '--enable', 'hooks', '--model', model, '-c', `model_reasoning_effort=${tomlString(reasoningMode)}`, '-',
    ],
    stdinText: prompt,
    runtimeContext: { hooksSourcePath: settingsPath, modelConfigured: model },
  };
}

export async function collectObservationSources(invocation, { env, cwd, timeoutMs, onSpawned } = {}) {
  const spawnResult = await spawnCondition(invocation, { env, cwd, timeoutMs, onSpawned });
  return {
      process: {
        exitCode: spawnResult.exitCode,
        terminated: spawnResult.terminated,
        terminationReason: spawnResult.terminationReason,
        spawnHrtimeNs: spawnResult.spawnHrtimeNs,
        endedHrtimeNs: spawnResult.endedHrtimeNs,
      },
      capture: { primaryText: spawnResult.rawStdout, stderrText: spawnResult.stderr },
      providerSources: {
        rawJsonl: spawnResult.rawStdout,
        taggedLines: spawnResult.taggedLines,
        delivery: invocation.runtimeContext,
      },
  };
}

function usageFromTerminal(terminal) {
  const usage = terminal?.usage;
  const integerOrNull = (value) => Number.isInteger(value) && value >= 0 ? value : null;
  return {
    input: integerOrNull(usage?.input_tokens),
    cached_input: integerOrNull(usage?.cached_input_tokens),
    cache_write: null,
    output: integerOrNull(usage?.output_tokens),
    reasoning_output: integerOrNull(usage?.reasoning_output_tokens),
  };
}

function timeoutTolerantIssues(strict, process) {
  if (!(process?.terminated === true && process?.terminationReason === 'timeout')) return strict;
  let removed = false;
  return strict.filter((issue) => {
    if (!removed && issue.type === 'result_count' && issue.count === 0) { removed = true; return false; }
    return true;
  });
}

export function normalizeObservations(sources, context) {
  const { events, malformedLines } = parseCodexJsonl(sources.providerSources.rawJsonl, { taggedLines: sources.providerSources.taggedLines });
  const thread = findCodexThreadEvent(events);
  const terminalEvent = findCodexTerminalEvent(events);
  const commandAttempts = findCodexCommandAttempts(events);
  const structuralIssues = findCodexStructuralIssues(events, commandAttempts);
  const incomplete = commandAttempts.filter((attempt) => !attempt.resultFound).map((attempt) => ({
    index: attempt.index, receiptNs: attempt.receiptNs, name: 'command_execution', id: attempt.id,
  }));
  const tolerateTrailingTimeout = sources.process.terminated === true && sources.process.terminationReason === 'timeout' && incomplete.length === 1
    && incomplete[0].index === Math.max(...commandAttempts.map((attempt) => attempt.index));
  const toolAttempts = commandAttempts.map((attempt) => ({
    id: attempt.id,
    kind: 'shell',
    runtimeName: 'command_execution',
    eventIndex: attempt.index,
    receiptNs: attempt.receiptNs,
    profileAllowed: true,
    command: attempt.command,
    skillReference: null,
    targetsExpectedSkill: null,
    result: {
      found: attempt.resultFound,
      eventIndex: attempt.resultFound ? attempt.resultIndex : null,
      isError: attempt.resultFound ? attempt.resultIsError : null,
      text: attempt.resultTextStatus === 'text' ? attempt.resultText : null,
      textStatus: attempt.resultTextStatus,
    },
    preDispatchBlock: { recognized: false, signature: null },
  }));
  const delivery = sources.providerSources.delivery ?? {};
  const receiptNsByEventIndex = new Map();
  events.forEach((event, index) => {
    if (typeof event._receiptNs === 'bigint') receiptNsByEventIndex.set(index, event._receiptNs);
  });
  const terminalPresent = terminalEvent != null;
  const usage = terminalPresent ? usageFromTerminal(terminalEvent) : { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null };
  const resultSubtype = terminalEvent?.type === 'turn.completed' ? 'success' : terminalEvent?.type === 'turn.failed' ? 'error_during_execution' : null;
  return {
    schema: 1,
    runtime: { id: 'codex-cli', protocolVersion: 1 },
    process: sources.process,
    session: {
      initPresent: thread != null,
      modelResolved: thread != null && typeof delivery.modelConfigured === 'string'
        ? delivery.modelConfigured
        : null,
      sessionIdObserved: typeof thread?.thread_id === 'string' ? thread.thread_id : null,
      runtimeVersion: context.runtimePreflight?.cliVersion ?? null,
      toolProfileMatchesExpected: context.executionProfile?.policy_mode === 'not_applicable',
      // modelSnapshot (eval-v2 recording fields): always null -- codex-cli's JSONL carries no
      // per-turn model field, only the session-level configured model already captured above in
      // modelResolved. See runtimes/claude-code.mjs's own modelSnapshot for the contrasting case
      // where a genuine per-turn signal exists.
      modelSnapshot: null,
    },
    transcript: {
      malformedLineCount: malformedLines.length,
      strictStructuralIssues: structuralIssues,
      effectiveStructuralIssues: timeoutTolerantIssues(structuralIssues, sources.process),
      strictIncompleteToolResults: incomplete,
      effectiveIncompleteToolResults: tolerateTrailingTimeout ? [] : incomplete,
    },
    terminal: {
      present: terminalPresent,
      isError: terminalPresent ? terminalEvent.type === 'turn.failed' : null,
      turnCount: terminalPresent ? events.filter((event) => event.type === 'turn.started').length : null,
      finalText: terminalPresent ? findCodexFinalText(events) : null,
      resultSubtype,
      usage,
    },
    toolAttempts,
    skill: {
      available: delivery.skillAvailable === true,
      profileMatchesCondition: delivery.profileMatchesCondition === true,
      snapshotBindingMatches: delivery.snapshotBindingMatches === true,
      targetInvocation: null,
      foreignInvocations: [],
      ambient: {
        names: delivery.ambientNames instanceof Set ? delivery.ambientNames : new Set(),
        structurallyWellFormed: delivery.ambientNames instanceof Set,
        targetIdentityOk: delivery.targetIdentityOk === true,
      },
    },
    hookStats: {
      hookCallCount: 0,
      hookResponseCount: 0,
      hookDenyCount: 0,
      hookAllowCount: 0,
      hookPairingOk: true,
      everyCallHooked: toolAttempts.length === 0,
    },
    byteMetrics: computeCodexByteMetrics(sources.providerSources.rawJsonl, events),
    timing: { receiptNsByEventIndex },
  };
}

export function redactRuntimeDiagnostics(value) {
  if (typeof value === 'string') {
    const { ok, redacted } = redactAndVerify(value);
    return ok ? redacted : '[redaction-incomplete]';
  }
  if (value !== null && typeof value === 'object') {
    const { ok, redactedObj } = redactObjectAndVerify(value);
    return ok ? redactedObj : { redaction: 'incomplete' };
  }
  return value;
}

export const codexCliRuntimeAdapter = defineRuntimeAdapter({
  id: 'codex-cli',
  protocolVersion: 1,
  capabilities: {
    observationSources: ['jsonl', 'hooks', 'stderr'],
    structuredTranscript: true,
    correlatedToolResults: true,
    skillDeliveryModes: ['project-skill'],
    skillStateEvidence: true,
    usageDimensions: ['input', 'cached_input', 'output', 'reasoning_output'],
    softPermissionDenial: false,
  },
  supportsModelConfiguration,
  supportsExecutionProfile,
  probeInstallation,
  preflight,
  prepareIsolatedHome,
  prepareSkillDelivery,
  buildInvocation,
  collectObservationSources,
  normalizeObservations,
  redactRuntimeDiagnostics,
});

export default codexCliRuntimeAdapter;
