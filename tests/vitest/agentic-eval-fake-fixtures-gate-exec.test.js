// tests/vitest/agentic-eval-fake-fixtures-gate-exec.test.js
//
// Phase 3-bis gate coverage: the fake-claude-campaign-success/claude and
// fake-codex-campaign-success/codex fixtures grew an additive "real execution" branch that fires
// ONLY when cwd is the real materialized coverage-threshold-failure-v2 workspace (real gradlew.bat +
// a settings.gradle.kts naming both the "nowinandroid" root project and the :core:domain module).
// These tests exercise that branch with fully synthetic, inert stand-ins -- a stub gradlew.bat and a
// stub kmp-test/kmp-test.cmd that print canned output -- never real Gradle, never the real product,
// never network access. Real end-to-end verification (actual NowInAndroid + actual Gradle + the real
// product) happens only inside the isolated Evidence1 VM via evidence1-run.ps1; that is a deliberately
// separate, higher-cost verification layer this file does not attempt to replace.
//
// Every existing fixture consumer (agentic-eval-scenario-campaign-run-command.test.js and siblings)
// only ever invokes these fixtures against synthetic/temp source repos, so the gate never fires for
// them -- test 1 and test 5 below pin that byte-identical fallback as a regression guard.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { compareMultiModuleAnswer } from '../../tools/agentic-eval/graders-multi-module.mjs';

const isWindows = process.platform === 'win32';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const CLAUDE_FIXTURE = path.join(FIXTURES_DIR, 'fake-claude-campaign-success', 'claude');
const CODEX_FIXTURE = path.join(FIXTURES_DIR, 'fake-codex-campaign-success', 'codex');

const SETTINGS_GRADLE_KTS = [
  'rootProject.name = "nowinandroid"',
  'include(":core:domain")',
  '',
].join('\n');

// Matches coverage-threshold-failure-v2.json's own `expected.kmp_test` block exactly (1/1 task,
// individual_total 4, missed 23, threshold 15, exit_code 1), plus the full coverage/error shape
// graders.mjs's deriveCoherentCoverageFacts / isCoherentTargetScopedCoverageBlock require to
// canonicalize a coverage_threshold_exceeded claim at all (module_buckets with its 4 exact keys,
// modules_contributing:1, and an errors[] entry actually carrying the threshold breach -- an empty
// errors[] with only a top-level coverage.missed_lines, as an earlier draft of this fixture used,
// can never canonicalize: graders.mjs only reads the coverage_threshold_exceeded facts from errors[]).
const COHERENT_ENVELOPE = JSON.stringify({
  tool: 'kmp-test', schema_version: 3, subcommand: 'parallel', version: '0.14.0',
  project_root: '.', exit_code: 1, duration_ms: 4200,
  tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 4 },
  modules: [':core:domain'], skipped: [],
  coverage: {
    tool: 'auto', missed_lines: 23, modules_contributing: 1,
    module_buckets: { with_data: [':core:domain'], no_xml: [], parse_errored: [], skipped_by_user: [] },
    modules_with_kover_plugin: [':core:domain'], modules_with_jacoco_plugin: [],
  },
  // No >, <, &, |, ^, or % in this message: it gets echoed unquoted from a .cmd stub below, where
  // those are shell metacharacters (a literal '>' would silently redirect the echo to a file).
  errors: [{ code: 'coverage_threshold_exceeded', message: 'Coverage threshold exceeded: 23 missed lines, budget 15 lines (--min-missed-lines)', missed_lines: 23, threshold: 15 }],
  warnings: [], isolated: { enabled: false, cache_dir: null, kept: false, locked: true },
});

let workspaceDir;
let stubBinDir;
let isolatedTmp;

function writeStub(filePath, contentLines, { mode } = {}) {
  // .cmd stubs are cmd.exe batch files (CRLF); every other stub here is a POSIX #!/usr/bin/env
  // bash script invoked via bash's own eval/exec, which parses only LF as the shebang terminator --
  // a trailing \r becomes part of the interpreter name ("bash\r") and fails to resolve. This only
  // fails under a real Linux kernel exec, never on the Windows/MSYS host these fixtures were
  // authored and run on before.
  const eol = filePath.endsWith('.cmd') ? '\r\n' : '\n';
  writeFileSync(filePath, contentLines.join(eol));
  if (mode !== undefined) chmodSync(filePath, mode);
}

beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-workspace-'));
  stubBinDir = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-stubbin-'));
  isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-tmp-'));
  writeFileSync(path.join(workspaceDir, 'settings.gradle.kts'), SETTINGS_GRADLE_KTS);
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(stubBinDir, { recursive: true, force: true });
  rmSync(isolatedTmp, { recursive: true, force: true });
});

function stubEnv() {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    PATH: `${stubBinDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
    TEMP: isolatedTmp,
    TMP: isolatedTmp,
    TMPDIR: isolatedTmp,
  };
}

// One new test in this file failed twice under full-suite-only load (never standalone) with no
// error captured beyond "stdout wasn't the expected JSON" -- not enough to diagnose or fix without
// guessing. This captures everything needed to diagnose it for real the next time it happens:
// spawn-level error/signal (a SIGTERM/ETIMEDOUT-style kill leaves no readable stdout, distinct from
// the process legitimately exiting with bad output), wall-clock duration (a hung/slow spawn under
// contention vs. a fast, clean wrong-output run are different failure classes), and the tail of both
// streams. Attached to the relevant expect() calls' own failure message below, not just logged --
// console output during a passing run is not reliably preserved, an assertion failure message always is.
function runFixture(fixturePath, args, { cwd, env }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    let spawnError = null;
    try {
      child = spawn(resolveBash(), [fixturePath, ...args], { cwd, env });
    } catch (err) {
      resolve({ code: null, signal: null, error: err, stdout: '', stderr: '', elapsedMs: Date.now() - startedAt });
      return;
    }
    child.on('error', (err) => { spawnError = err; });
    // setEncoding BEFORE the first 'data' listener: lets Node buffer a multi-byte UTF-8 sequence
    // split across chunk boundaries internally, rather than this handler calling .toString() on
    // each raw chunk independently (which can mangle a split character under real I/O timing).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      if (stderr) console.error(`[gate-exec fixture stderr, exit ${code}]`, stderr);
      resolve({ code, signal, error: spawnError, stdout, stderr, elapsedMs });
    });
  });
}

function tail(s, n = 1000) {
  const str = String(s ?? '');
  return str.length > n ? `...(truncated)...${str.slice(-n)}` : str;
}

function diagBlock(result) {
  return [
    `exit_code=${result.code} signal=${result.signal ?? 'null'} spawn_error=${result.error ? result.error.message : 'null'} duration_ms=${result.elapsedMs}`,
    `--- stdout tail (last ${Math.min(1000, result.stdout.length)} chars) ---`,
    tail(result.stdout),
    `--- stderr tail (last ${Math.min(1000, result.stderr.length)} chars) ---`,
    tail(result.stderr),
  ].join('\n');
}

function events(stdout) {
  return stdout.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function resultText(stdout) {
  const evts = events(stdout);
  const resultEvt = evts.find((e) => e.type === 'result');
  return resultEvt ? resultEvt.result : null;
}

describe('fake-claude-campaign-success/claude -- Phase 3-bis gate', () => {
  it('gate OFF: plain temp cwd (no gradlew.bat) falls through to the unchanged :fakemod literal', async () => {
    const plainCwd = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-plain-'));
    try {
      const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd: plainCwd, env: stubEnv() });
      expect(result.code, diagBlock(result)).toBe(0);
      const text = resultText(result.stdout);
      expect(text, diagBlock(result)).toContain('"outcome_kind": "no_applicable_tests"');
      expect(text, diagBlock(result)).toContain('":fakemod"');
    } finally {
      rmSync(plainCwd, { recursive: true, force: true });
    }
  });

  it('gate ON, product condition, coherent envelope: dispatches the real command and builds KMP_EVAL_RESULT from it', async () => {
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    writeStub(path.join(stubBinDir, 'kmp-test'), ['#!/usr/bin/env bash', `echo '${COHERENT_ENVELOPE}'`, 'exit 1'], { mode: 0o755 });

    const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd: workspaceDir, env: stubEnv() });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const evts = events(result.stdout);
    const bashToolUse = evts.find((e) => e.type === 'assistant' && e.message?.content?.[0]?.name === 'Bash');
    expect(bashToolUse.message.content[0].input.command, diag).toBe('kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json --project-root .');

    const toolResult = evts.find((e) => e.type === 'user' && e.message?.content?.[0]?.tool_use_id === 'toolu_fakebash1');
    expect(toolResult.message.content[0].content, diag).toContain('"missed_lines":23');

    const text = resultText(result.stdout);
    expect(text, diag).toContain('KMP_EVAL_RESULT');
    const block = JSON.parse(text.split('KMP_EVAL_RESULT\n')[1].split('\nKMP_EVAL_RESULT_END')[0]);
    // test_count/passed are individual_total (4), not tests.total (1 Gradle task) -- H15 fix.
    expect(block, diag).toEqual({
      module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded',
      test_count: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1,
    });
  });

  // WO-A2 step 8 (design.md (i)): proves this fixture is genuinely scenario-generic, not merely
  // "still happens to work for the anchor" -- a completely DIFFERENT module, project include
  // marker, and outcome_kind (tests_executed, not coverage_threshold_exceeded), driven entirely by
  // the KMP_FAKE_SCENARIO_* env vars, with the fixture file itself untouched. Mirrors
  // nowinandroid-core-common.json's own real expected shape (module ":core:common",
  // individual_total:1) -- the held-out scenario a future v2.1 would exercise this exact mechanism
  // for, per the auditor's own note that a unit-level fixture-logic test is the right verification
  // strategy tonight (the held-out project itself cannot run offline against today's Gradle seed).
  it('gate ON with KMP_FAKE_SCENARIO_* overrides: drives a COMPLETELY DIFFERENT module/outcome (:core:common, tests_executed) through the SAME unmodified fixture file', async () => {
    writeFileSync(path.join(workspaceDir, 'settings.gradle.kts'), [
      'rootProject.name = "nowinandroid"',
      'include(":core:common")',
      '',
    ].join('\n'));
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    const coreCommonEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 3, subcommand: 'parallel', version: '0.14.0',
      project_root: '.', exit_code: 0, duration_ms: 1800,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 },
      modules: [':core:common'], skipped: [],
      coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] },
      errors: [], warnings: [], isolated: { enabled: false, cache_dir: null, kept: false, locked: true },
    });
    writeStub(path.join(stubBinDir, 'kmp-test'), ['#!/usr/bin/env bash', `echo '${coreCommonEnvelope}'`, 'exit 0'], { mode: 0o755 });

    const env = {
      ...stubEnv(),
      KMP_FAKE_SCENARIO_INCLUDE_MARKER: 'include(":core:common")',
      KMP_FAKE_SCENARIO_MODULE: ':core:common',
      KMP_FAKE_SCENARIO_MIN_MISSED_LINES: '999999', // no coverage data on this envelope -- must never matter
      KMP_FAKE_SCENARIO_GRADLE_TASKS: ':core:common:test',
    };
    const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd: workspaceDir, env });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const evts = events(result.stdout);
    const bashToolUse = evts.find((e) => e.type === 'assistant' && e.message?.content?.[0]?.name === 'Bash');
    expect(bashToolUse.message.content[0].input.command, diag).toBe('kmp-test parallel --module-filter :core:common --min-missed-lines 999999 --json --project-root .');

    const text = resultText(result.stdout);
    expect(text, diag).toContain('KMP_EVAL_RESULT');
    const block = JSON.parse(text.split('KMP_EVAL_RESULT\n')[1].split('\nKMP_EVAL_RESULT_END')[0]);
    expect(block, diag).toEqual({ module: ':core:common', outcome_kind: 'tests_executed', test_count: 1, passed: 1, failed: 0 });
  });

  it('gate ON, product condition, coherent envelope PLUS real stderr diagnostics: still builds KMP_EVAL_RESULT (the real kmp-test writes failure diagnostics to stderr before the envelope whenever a migrated subcommand exits non-zero -- script-dispatcher.js:568-573 -- coverage_threshold_exceeded is exit_code 1, so this is the REAL shape, not an edge case)', async () => {
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    writeStub(path.join(stubBinDir, 'kmp-test'), [
      '#!/usr/bin/env bash',
      'echo "[kmp-test runner stdout] Task :core:domain:test\\nBUILD FAILED in 2s" >&2',
      `echo '${COHERENT_ENVELOPE}'`,
      'exit 1',
    ], { mode: 0o755 });

    const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd: workspaceDir, env: stubEnv() });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const text = resultText(result.stdout);
    expect(text, diag).toContain('KMP_EVAL_RESULT');
    const block = JSON.parse(text.split('KMP_EVAL_RESULT\n')[1].split('\nKMP_EVAL_RESULT_END')[0]);
    expect(block, diag).toEqual({
      module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded',
      test_count: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1,
    });

    // The tool_result the agent actually SEES still shows both streams combined, matching what a
    // real Bash tool invocation displays -- only the JSON-parsing source is stderr-free, not the
    // transcript itself.
    const evts = events(result.stdout);
    const toolResult = evts.find((e) => e.type === 'user' && e.message?.content?.[0]?.tool_use_id === 'toolu_fakebash1');
    expect(toolResult.message.content[0].content, diag).toContain('BUILD FAILED');
    expect(toolResult.message.content[0].content, diag).toContain('"missed_lines":23');
  });

  it('gate ON, product condition, broken/unparseable output: omits KMP_EVAL_RESULT entirely (honest no_summary)', async () => {
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    writeStub(path.join(stubBinDir, 'kmp-test'), ['#!/usr/bin/env bash', 'echo "wrapper produced no output"', 'exit 2'], { mode: 0o755 });

    const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd: workspaceDir, env: stubEnv() });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);
    const text = resultText(result.stdout);
    expect(text, diag).not.toContain('KMP_EVAL_RESULT');
  });

  it('gate ON, free condition: dispatches the real flavor-specific gradlew command via ./gradlew (POSIX, matching a real Claude Bash-tool invocation), not :core:domain:test', async () => {
    // gradlew.bat only needs to EXIST for the gate check -- Claude's free arm actually invokes the
    // POSIX ./gradlew (Git Bash convention), never the .bat form (that's Codex's own fidelity point).
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    writeStub(path.join(workspaceDir, 'gradlew'), ['#!/usr/bin/env bash', 'echo BUILD SUCCESSFUL'], { mode: 0o755 });

    const result = await runFixture(CLAUDE_FIXTURE, ['--permission-mode', 'bypassPermissions'], { cwd: workspaceDir, env: stubEnv() });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const evts = events(result.stdout);
    const bashToolUse = evts.find((e) => e.type === 'assistant' && e.message?.content?.[0]?.name === 'Bash');
    const command = bashToolUse.message.content[0].input.command;
    expect(command.startsWith('./gradlew '), diag).toBe(true);
    expect(command, diag).toContain('testDemoDebugUnitTest');
    expect(command, diag).toContain('createDemoDebugUnitTestCoverageReport');
    expect(command, diag).not.toContain(':core:domain:test ');
    expect(command).not.toMatch(/:core:domain:test$/);

    const toolResult = evts.find((e) => e.type === 'user' && e.message?.content?.[0]?.tool_use_id === 'toolu_fakebash1');
    expect(toolResult.message.content[0].content, diag).toContain('BUILD SUCCESSFUL');
  });
});

describe('fake-codex-campaign-success/codex -- Phase 3-bis gate', () => {
  it('gate OFF: plain temp cwd falls through to the unchanged :fakemod literal', async () => {
    const plainCwd = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-plain-codex-'));
    try {
      const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: plainCwd, env: stubEnv() });
      const diag = diagBlock(result);
      expect(result.code, diag).toBe(0);
      const evts = events(result.stdout);
      const msg = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
      expect(msg.item.text, diag).toContain('"outcome_kind": "no_applicable_tests"');
    } finally {
      rmSync(plainCwd, { recursive: true, force: true });
    }
  });

  const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  // Codex's real dispatch always wraps the inner command in a literal powershell.exe launcher path
  // (see the fixture's own POWERSHELL_EXE comment) -- unlike the Claude describe block above, which
  // dispatches via POSIX ./gradlew and needs no guard. Requires a real Windows powershell.exe.
  it.skipIf(!isWindows)('gate ON, product condition (SKILL.md present), coherent envelope: wraps in the full powershell.exe path with a single-quoted inner command, and builds KMP_EVAL_RESULT', async () => {
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    mkdirSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner', 'SKILL.md'), '# fake\n');
    writeStub(path.join(stubBinDir, 'kmp-test.cmd'), ['@echo off', `echo ${COHERENT_ENVELOPE}`, 'exit /b 1'], {});

    const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env: stubEnv() });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const evts = events(result.stdout);
    const started = evts.find((e) => e.type === 'item.started');
    // Real Codex-on-Windows shape: full launcher path, no -NoProfile, single-quoted inner command --
    // matches command-classify.mjs's unwrap regex and what graders.mjs/junit-evidence.mjs expect.
    expect(started.item.command, diag).toBe(`"${POWERSHELL_EXE}" -Command 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json --project-root .'`);

    const completedCmd = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'command_execution');
    expect(completedCmd.item.aggregated_output, diag).toContain('"missed_lines":23');

    const msg = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
    expect(msg.item.text, diag).toContain('KMP_EVAL_RESULT');
    const block = JSON.parse(msg.item.text.split('KMP_EVAL_RESULT\n')[1].split('\nKMP_EVAL_RESULT_END')[0]);
    expect(block, diag).toEqual({
      module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded',
      test_count: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1,
    });
  });

  // WO-A2 step 8 -- the Codex sibling of the Claude fixture's own identical genericity proof above.
  // Requires a real Windows powershell.exe (see the POWERSHELL_EXE comment above).
  it.skipIf(!isWindows)('gate ON with KMP_FAKE_SCENARIO_* overrides: drives a COMPLETELY DIFFERENT module/outcome (:core:common, tests_executed) through the SAME unmodified fixture file', async () => {
    writeFileSync(path.join(workspaceDir, 'settings.gradle.kts'), [
      'rootProject.name = "nowinandroid"',
      'include(":core:common")',
      '',
    ].join('\n'));
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    mkdirSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner', 'SKILL.md'), '# fake\n');
    const coreCommonEnvelope = JSON.stringify({
      tool: 'kmp-test', schema_version: 3, subcommand: 'parallel', version: '0.14.0',
      project_root: '.', exit_code: 0, duration_ms: 1800,
      tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 },
      modules: [':core:common'], skipped: [],
      coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] },
      errors: [], warnings: [], isolated: { enabled: false, cache_dir: null, kept: false, locked: true },
    });
    writeStub(path.join(stubBinDir, 'kmp-test.cmd'), ['@echo off', `echo ${coreCommonEnvelope}`, 'exit /b 0'], {});

    const env = {
      ...stubEnv(),
      KMP_FAKE_SCENARIO_INCLUDE_MARKER: 'include(":core:common")',
      KMP_FAKE_SCENARIO_MODULE: ':core:common',
      KMP_FAKE_SCENARIO_MIN_MISSED_LINES: '999999',
      KMP_FAKE_SCENARIO_GRADLE_TASKS: ':core:common:test',
    };
    const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const evts = events(result.stdout);
    const started = evts.find((e) => e.type === 'item.started');
    expect(started.item.command, diag).toBe(`"${POWERSHELL_EXE}" -Command 'kmp-test parallel --module-filter :core:common --min-missed-lines 999999 --json --project-root .'`);

    const msg = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
    expect(msg.item.text, diag).toContain('KMP_EVAL_RESULT');
    const block = JSON.parse(msg.item.text.split('KMP_EVAL_RESULT\n')[1].split('\nKMP_EVAL_RESULT_END')[0]);
    expect(block, diag).toEqual({ module: ':core:common', outcome_kind: 'tests_executed', test_count: 1, passed: 1, failed: 0 });
  });

  it.skipIf(!isWindows)('gate ON, product condition PLUS real stderr diagnostics: still builds KMP_EVAL_RESULT (same real kmp-test shape as the Claude fixture\'s equivalent test -- script-dispatcher.js:568-573)', async () => {
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
    mkdirSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner', 'SKILL.md'), '# fake\n');
    writeStub(path.join(stubBinDir, 'kmp-test.cmd'), [
      '@echo off',
      'echo [kmp-test runner stdout] Task :core:domain:test 1>&2',
      `echo ${COHERENT_ENVELOPE}`,
      'exit /b 1',
    ], {});

    const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env: stubEnv() });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const evts = events(result.stdout);
    const msg = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
    expect(msg.item.text, diag).toContain('KMP_EVAL_RESULT');
    const block = JSON.parse(msg.item.text.split('KMP_EVAL_RESULT\n')[1].split('\nKMP_EVAL_RESULT_END')[0]);
    expect(block, diag).toEqual({
      module: ':core:domain', outcome_kind: 'coverage_threshold_exceeded',
      test_count: 4, passed: 4, failed: 0, missed_lines: 23, threshold: 15, modules_contributing: 1,
    });

    const completedCmd = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'command_execution');
    expect(completedCmd.item.aggregated_output, diag).toContain('kmp-test runner stdout');
    expect(completedCmd.item.aggregated_output, diag).toContain('"missed_lines":23');
  });

  it.skipIf(!isWindows)('gate ON, free condition (no SKILL.md): wraps the real .bat gradlew command in the full powershell.exe path', async () => {
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\necho BUILD SUCCESSFUL\r\n');

    const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env: stubEnv() });
    const diag = diagBlock(result);
    expect(result.code, diag).toBe(0);

    const evts = events(result.stdout);
    const started = evts.find((e) => e.type === 'item.started');
    expect(started.item.command, diag).toBe(`"${POWERSHELL_EXE}" -Command './gradlew.bat :core:domain:testDemoDebugUnitTest :core:domain:createDemoDebugUnitTestCoverageReport --offline --console=plain'`);

    const completedCmd = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'command_execution');
    expect(completedCmd.item.aggregated_output, diag).toContain('BUILD SUCCESSFUL');
  });
});

// -------------------------------------------------------------------------------------------------
// multi-module-tests family (PLAN.md D4, D5; WO-07): the same two fixtures answer correctly for the
// new family when KMP_FAKE_SCENARIO_FAMILY says so, in both arms. Three more variables carry what the
// launcher's shim writes for a multi-module scenario: the kmp-test arguments the VM's smoke run uses
// (expected.smoke.kmp_test_args), and the four expected fields as JSON. The other families, and a v2
// invocation that sets none of them, are covered by every test above and stay byte-identical.
// -------------------------------------------------------------------------------------------------
describe('multi-module-tests family -- the fake providers answer correctly in both arms', () => {
  const multiModuleTruth = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'agentic-eval-multi-module', 'expected-draft.json'), 'utf8'));
  const EXPECTED_FIELDS = multiModuleTruth.expected;
  const FAMILY_ENV = {
    KMP_FAKE_SCENARIO_FAMILY: 'multi-module-tests',
    KMP_FAKE_SCENARIO_KMP_TEST_ARGS: multiModuleTruth.smoke.kmp_test_args.join(' '),
    KMP_FAKE_SCENARIO_EXPECTED_JSON: JSON.stringify(EXPECTED_FIELDS),
    KMP_FAKE_SCENARIO_GRADLE_TASKS: ':core:common:test',
    KMP_FAKE_SCENARIO_INCLUDE_MARKER: 'include(":core:data")',
  };
  const KMP_COMMAND = `kmp-test ${multiModuleTruth.smoke.kmp_test_args.join(' ')} --project-root .`;

  const blockOf = (text) => JSON.parse(text.split('KMP_EVAL_RESULT\n')[1].split('\nKMP_EVAL_RESULT_END')[0]);
  const matchesGroundTruth = (block) => compareMultiModuleAnswer(block, EXPECTED_FIELDS).matched === true;

  function writeMultiModuleWorkspace() {
    writeFileSync(path.join(workspaceDir, 'settings.gradle.kts'), ['rootProject.name = "nowinandroid"', 'include(":core:data")', ''].join('\n'));
    writeFileSync(path.join(workspaceDir, 'gradlew.bat'), '@echo off\r\n');
  }

  describe('fake-claude-campaign-success/claude', () => {
    it('product arm, no real workspace: runs the smoke kmp-test command and answers with the ground truth', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-family-plain-'));
      try {
        const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd, env: { ...stubEnv(), ...FAMILY_ENV } });
        const diag = diagBlock(result);
        expect(result.code, diag).toBe(0);
        const evts = events(result.stdout);
        const bash = evts.find((e) => e.type === 'assistant' && e.message?.content?.[0]?.name === 'Bash');
        expect(bash.message.content[0].input.command, diag).toBe(KMP_COMMAND);
        expect(evts.some((e) => e.type === 'assistant' && e.message?.content?.[0]?.name === 'Skill'), diag).toBe(true);
        const text = resultText(result.stdout);
        expect(blockOf(text), diag).toEqual(EXPECTED_FIELDS);
        expect(matchesGroundTruth(blockOf(text)), diag).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('free arm, no real workspace: runs the first allowed Gradle test task and answers with the ground truth', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-family-plain-'));
      try {
        const result = await runFixture(CLAUDE_FIXTURE, ['--permission-mode', 'bypassPermissions'], { cwd, env: { ...stubEnv(), ...FAMILY_ENV } });
        const diag = diagBlock(result);
        expect(result.code, diag).toBe(0);
        const bash = events(result.stdout).find((e) => e.type === 'assistant' && e.message?.content?.[0]?.name === 'Bash');
        expect(bash.message.content[0].input.command, diag).toBe('./gradlew :core:common:test --offline --console=plain');
        expect(matchesGroundTruth(blockOf(resultText(result.stdout))), diag).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('product arm in a real-looking workspace: actually runs the command (stub output reaches the transcript) and still answers with the ground truth', async () => {
      writeMultiModuleWorkspace();
      writeStub(path.join(stubBinDir, 'kmp-test'), ['#!/usr/bin/env bash', 'echo "stub kmp-test ran: $*"', 'exit 1'], { mode: 0o755 });
      const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd: workspaceDir, env: { ...stubEnv(), ...FAMILY_ENV } });
      const diag = diagBlock(result);
      expect(result.code, diag).toBe(0);
      const toolResult = events(result.stdout).find((e) => e.type === 'user' && e.message?.content?.[0]?.tool_use_id === 'toolu_fakebash1');
      expect(toolResult.message.content[0].content, diag).toContain('stub kmp-test ran: parallel --flavor demo --exclude-modules');
      expect(matchesGroundTruth(blockOf(resultText(result.stdout))), diag).toBe(true);
    });

    it('records the policy decision for the one command when the permission mode is dontAsk', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-family-plain-'));
      const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-family-evidence-'));
      try {
        const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'dontAsk'], { cwd, env: { ...stubEnv(), ...FAMILY_ENV, KMP_EVAL_JUNIT_EVIDENCE_DIR: evidenceDir } });
        const diag = diagBlock(result);
        expect(result.code, diag).toBe(0);
        const hookResponses = events(result.stdout).filter((e) => e.type === 'system' && e.subtype === 'hook_response');
        expect(hookResponses, diag).toHaveLength(1);
        expect(matchesGroundTruth(blockOf(resultText(result.stdout))), diag).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(evidenceDir, { recursive: true, force: true });
      }
    });

    it('fails loudly when the expected JSON is not valid JSON', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-family-plain-'));
      try {
        const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd, env: { ...stubEnv(), ...FAMILY_ENV, KMP_FAKE_SCENARIO_EXPECTED_JSON: '{not json' } });
        expect(result.code, diagBlock(result)).not.toBe(0);
        expect(result.stderr).toContain('KMP_FAKE_SCENARIO_EXPECTED_JSON');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('leaves a v2 invocation untouched: the family variables absent, the :fakemod literal is still emitted', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'gate-exec-family-v2-'));
      try {
        const result = await runFixture(CLAUDE_FIXTURE, ['--plugin-dir', '/fake/plugin', '--permission-mode', 'bypassPermissions'], { cwd, env: stubEnv() });
        expect(resultText(result.stdout), diagBlock(result)).toContain('":fakemod"');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('fake-codex-campaign-success/codex', () => {
    // The fixture's own launcher path (the existing Codex describe block above keeps its own copy of this constant).
    const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    function writeSkill() {
      mkdirSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner'), { recursive: true });
      writeFileSync(path.join(workspaceDir, '.agents', 'skills', 'kmp-test-runner', 'SKILL.md'), '# fake\n');
    }

    it('product arm, no real workspace: runs the smoke kmp-test command and answers with the ground truth', async () => {
      writeSkill();
      const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env: { ...stubEnv(), ...FAMILY_ENV } });
      const diag = diagBlock(result);
      expect(result.code, diag).toBe(0);
      const evts = events(result.stdout);
      const started = evts.find((e) => e.type === 'item.started');
      expect(started.item.command, diag).toBe(`"${POWERSHELL_EXE}" -Command '${KMP_COMMAND}'`);
      const message = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
      expect(blockOf(message.item.text), diag).toEqual(EXPECTED_FIELDS);
      expect(matchesGroundTruth(blockOf(message.item.text)), diag).toBe(true);
    });

    it('free arm, no real workspace: runs the first allowed Gradle test task and answers with the ground truth', async () => {
      const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env: { ...stubEnv(), ...FAMILY_ENV } });
      const diag = diagBlock(result);
      expect(result.code, diag).toBe(0);
      const evts = events(result.stdout);
      const started = evts.find((e) => e.type === 'item.started');
      expect(started.item.command, diag).toBe(`"${POWERSHELL_EXE}" -Command './gradlew.bat :core:common:test --offline --console=plain'`);
      const message = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
      expect(matchesGroundTruth(blockOf(message.item.text)), diag).toBe(true);
    });

    it.skipIf(!isWindows)('product arm in a real-looking workspace: actually runs the command and still answers with the ground truth', async () => {
      writeMultiModuleWorkspace();
      writeSkill();
      writeStub(path.join(stubBinDir, 'kmp-test.cmd'), ['@echo off', 'echo stub kmp-test ran', 'exit /b 1'], {});
      const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env: { ...stubEnv(), ...FAMILY_ENV } });
      const diag = diagBlock(result);
      expect(result.code, diag).toBe(0);
      const evts = events(result.stdout);
      const completed = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'command_execution');
      expect(completed.item.aggregated_output, diag).toContain('stub kmp-test ran');
      const message = evts.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
      expect(matchesGroundTruth(blockOf(message.item.text)), diag).toBe(true);
    });

    it('leaves a v2 invocation untouched: the family variables absent, the :fakemod literal is still emitted', async () => {
      const result = await runFixture(CODEX_FIXTURE, ['exec'], { cwd: workspaceDir, env: stubEnv() });
      const message = events(result.stdout).find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
      expect(message.item.text, diagBlock(result)).toContain('":fakemod"');
    });
  });
});
