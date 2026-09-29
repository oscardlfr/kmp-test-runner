#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSkillSnapshotArtifact } from '../../../tools/agentic-eval/input-artifacts.mjs';
import { buildScenarioCampaignPlan } from '../../../tools/agentic-eval/scenario-campaign-plan.mjs';
import { canonicalJsonSha256 } from '../../../tools/agentic-eval/canonical-json.mjs';
import { resolveBash } from '../../../tools/agentic-eval/resolve-bash.mjs';
import { PINNED_SKILL_SHA } from '../../../tools/agentic-eval/cli.mjs';

const [action, ...args] = process.argv.slice(2);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliPath = path.join(repoRoot, 'tools', 'agentic-eval', 'cli.mjs');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');
const utf8 = 'utf8';

function git(argv, cwd) {
  const result = spawnSync('git', argv, { cwd, encoding: utf8, timeout: 30000, killSignal: 'SIGKILL' });
  if (result.error || result.signal != null || result.status !== 0) throw new Error(`fixture_git_failed:${argv[0]}`);
  return result.stdout.trim();
}

function platformName() {
  return { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] ?? 'not-recorded';
}

function writeAttestation(root, runtimeId, harnessSha) {
  const now = Date.now();
  const value = {
    schema: 1, profile_id: 'sandboxed-unrestricted-v1', runtime_id: runtimeId,
    campaign_id: `dual-condition-offline-${runtimeId}`, platform: platformName(),
    boundary_kind: 'disposable-vm', network_mode: 'restricted', workspace_scope: 'campaign-only',
    runtime_credential_scope: 'runtime-only', normal_maintainer_home_mounted: false,
    ambient_secrets_present: false, disposable_home: true, rollback_or_destroy_required: true,
    harness_sha: harnessSha,
    created_at: new Date(now - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expires_at: new Date(now + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const file = path.join(root, `attestation-${runtimeId}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return { file, sha256: canonicalJsonSha256(value) };
}

function setup(root) {
  mkdirSync(root, { recursive: true });
  const source = path.join(root, 'source');
  mkdirSync(source);
  git(['init', '-q'], source);
  git(['config', 'user.email', 'test@example.invalid'], source);
  git(['config', 'user.name', 'Evidence Fixture'], source);
  writeFileSync(path.join(source, 'marker.txt'), 'pristine\n');
  writeFileSync(path.join(source, 'gradlew'), '#!/usr/bin/env sh\nexit 0\n');
  writeFileSync(path.join(source, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  try { chmodSync(path.join(source, 'gradlew'), 0o755); } catch { /* Windows */ }
  git(['add', '-A'], source);
  git(['commit', '-q', '-m', 'fixture'], source);
  const sourceCommit = git(['rev-parse', 'HEAD'], source);
  const sourceTree = git(['rev-parse', 'HEAD^{tree}'], source);
  const projectUrl = 'https://example.invalid/evidence1-dual-condition-fixture.git';
  git(['remote', 'add', 'origin', projectUrl], source);
  const scenarios = path.join(root, 'scenarios');
  mkdirSync(scenarios);
  writeFileSync(path.join(scenarios, 'coverage-threshold-failure-v2.json'), JSON.stringify({
    schema: 1, id: 'coverage-threshold-failure-v2', family: 'test-only',
    project_alias: 'dual-condition-fixture', project_url: projectUrl, project_commit: sourceCommit,
    prompt: 'Run the tests for the only module and report the result.',
    expected_outcome: 'The module has no applicable tests.',
    policy: { allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'], allowed_gradle_tasks: [':fakemod:test'] },
    expected: {
      module: ':fakemod', outcome_kind: 'no_applicable_tests',
      kmp_test: { error_code: 'no_test_modules', exit_code: 2, caused_by_filter: true },
      gradle: { allowed_invocations: [':fakemod:test'], evidence_task: ':fakemod:test', exit_code: 0, marker: 'NO-SOURCE' },
    },
    first_useful_signal_predicate: { description: 'first authoritative no-applicable-tests result' }, tags: ['train'],
  }, null, 2));
  const harnessCommit = git(['rev-parse', 'HEAD'], repoRoot);
  const harnessTree = git(['rev-parse', 'HEAD^{tree}'], repoRoot);
  const claudeAttestation = writeAttestation(root, 'claude-code', harnessCommit);
  const codexAttestation = writeAttestation(root, 'codex-cli', harnessCommit);
  // The real CLI's own skill observation is computed against PINNED_SKILL_SHA (cli.mjs), a frozen
  // commit representing a known-stable skill snapshot -- NOT the harness's current HEAD, which
  // moves with every commit and would never match a live run's own skill_observation.treatment_
  // size.snapshot_sha256 as a result (confirmed by direct diagnostic comparison: harnessCommit
  // produced a completely different sha256 than what a real dispatched session actually reported).
  const snapshot = computeSkillSnapshotArtifact({ repoRoot, sha: PINNED_SKILL_SHA, root: '.skills/kmp-test-runner' });
  const planHash = (designId) => {
    const result = buildScenarioCampaignPlan({
      designId, repeats: 1, executionProfiles: ['sandboxed-unrestricted-v1'],
    });
    if (!result.ok) throw new Error('fixture_plan_failed');
    return createHash('sha256').update(JSON.stringify(result.plan)).digest('hex');
  };
  return {
    root, source, scenarios, harness_commit: harnessCommit, harness_tree: harnessTree,
    source_commit: sourceCommit, source_tree: sourceTree, skill_snapshot_sha256: snapshot.snapshot_sha256,
    claude_attestation_file: claudeAttestation.file, claude_attestation_sha256: claudeAttestation.sha256,
    codex_attestation_file: codexAttestation.file, codex_attestation_sha256: codexAttestation.sha256,
    claude_product_plan_sha256: planHash('claude-product-canary-v1'),
    codex_product_plan_sha256: planHash('codex-product-canary-v1'),
    claude_baseline_plan_sha256: planHash('claude-free-baseline-canary-v1'),
    codex_baseline_plan_sha256: planHash('codex-free-baseline-canary-v1'),
  };
}

function withoutProductPath(value) {
  const names = ['kmp-test', 'kmp-test.cmd', 'kmp-test.ps1', 'kmp-test-runner', 'kmp-test-runner.cmd', 'kmp-test-runner.ps1'];
  return String(value ?? '').split(path.delimiter).filter(Boolean)
    .filter((entry) => !names.some((name) => existsSync(path.join(entry, name)))).join(path.delimiter);
}

function stopChildTree(child) {
  if (child.exitCode != null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

function spawnCli(argv, env, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env, detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding(utf8); child.stderr.setEncoding(utf8);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { stopChildTree(child); }, timeoutSeconds * 1000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code == null) reject(new Error('fixture_cli_timeout'));
      else if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`fixture_cli_failed:${code}`));
    });
  });
}

async function writeEvidence(contextFile, bindingFile, ordinalText, privateRunsRoot = null) {
  const context = JSON.parse(readFileSync(contextFile, utf8));
  const binding = JSON.parse(readFileSync(bindingFile, utf8));
  const ordinal = Number(ordinalText);
  const slot = binding.slots[ordinal];
  const operationRoot = path.dirname(bindingFile);
  const slotRoot = path.join(operationRoot, 'slots', String(ordinal));
  const slotClaimBytes = readFileSync(path.join(slotRoot, 'claim.json'));
  const planClaim = JSON.parse(readFileSync(path.join(slotRoot, 'plan.claim.json'), utf8));
  const dispatchStarted = JSON.parse(readFileSync(path.join(slotRoot, 'dispatch.started.json'), utf8));
  if (planClaim.kind !== 'dual-condition-plan-claim' || planClaim.state !== 'claimed-before-spawn' ||
      planClaim.run_id !== null || planClaim.slot_id !== slot.slot_id || planClaim.runtime_id !== slot.runtime_id ||
      planClaim.plan_sha256 !== slot.plan_sha256 ||
      planClaim.slot_claim_sha256 !== createHash('sha256').update(slotClaimBytes).digest('hex')) {
    throw new Error('fixture_plan_claim_mismatch');
  }
  if (dispatchStarted.kind !== 'dual-condition-dispatch-started' || dispatchStarted.state !== 'started-contained' ||
      dispatchStarted.sessions_consumed !== 1 || dispatchStarted.contained_before_release !== true ||
      dispatchStarted.plan_claim_sha256 !== createHash('sha256').update(readFileSync(path.join(slotRoot, 'plan.claim.json'))).digest('hex')) {
    throw new Error('fixture_dispatch_started_mismatch');
  }
  const fakeName = slot.runtime_id === 'claude-code' ? 'fake-claude-campaign-success' : 'fake-codex-campaign-success';
  // The TRACKED fixture file is always the bare name (source of the pinned copy below); the
  // WRITTEN/resolved name must match resolveClaudeCommand()'s own platform rule
  // (condition-launcher.mjs) -- Git Bash does not apply Windows PATHEXT lookup to bare command
  // names, so runAuthPreflight's `bash -c "claude.cmd auth status --json"` (auth-preflight.mjs,
  // reached via the claude-code runtime adapter) fails with exit 127 (not found) unless the file
  // on disk is literally named claude.cmd on win32. codex-cli has no equivalent auth-preflight
  // call site (grepped: runAuthPreflight is only imported by runtimes/claude-code.mjs), so codex
  // keeps its bare name.
  //
  // A SECOND, deeper problem the rename alone doesn't fix: on Windows, a file named *.cmd is
  // launched through cmd.exe's OWN batch interpreter regardless of its shebang line or how bash
  // resolved it on PATH -- confirmed by direct repro (`bash -c "claude.cmd ..."` against a bash-
  // shebang script literally renamed to .cmd: cmd.exe tries to run "#!/usr/bin/env bash" as a
  // batch command, exit 255). No currently-passing test in this codebase actually spawns a real,
  // bash-executed claude.cmd end to end -- every other claude.cmd reference either mocks the spawn
  // layer entirely (agentic-eval-claude-runtime-adapter.test.js's spawnFn seam) or checks the
  // resolved command NAME only, never really running it (Evidence1-Internal-Session-Worker.Tests.
  // ps1's own $fake mock). So there's no established working pattern to copy; this is a genuine
  // gap this fixture is the first to hit. Fix: keep the real (patched) bash logic under its own
  // bare-named file, and make claude.cmd a real, minimal Windows batch wrapper that re-invokes
  // bash against it, forwarding all arguments and letting bash's own exit code become the batch's.
  const sourceExecutable = slot.runtime_id === 'claude-code' ? 'claude' : 'codex';
  const isWinClaude = slot.runtime_id === 'claude-code' && process.platform === 'win32';
  const bashImplName = isWinClaude ? 'claude.impl' : sourceExecutable;
  let fakeDir = path.join(fixturesDir, fakeName);
  let pinnedFakeRoot = null;
  if (slot.runtime_id === 'claude-code') {
    pinnedFakeRoot = mkdtempSync(path.join(tmpdir(), 'e1-dual-condition-claude-'));
    fakeDir = path.join(pinnedFakeRoot, fakeName); mkdirSync(fakeDir);
    const original = readFileSync(path.join(fixturesDir, fakeName, sourceExecutable), utf8);
    const pinned = original
      .replace('\\"model\\":\\"claude-sonnet-5-fake-resolved\\"', '\\"model\\":\\"claude-sonnet-5\\"')
      .replace('\\"claude_code_version\\":\\"fake\\"', '\\"claude_code_version\\":\\"2.1.238\\"');
    if (pinned === original) throw new Error('fixture_claude_pin_patch_failed');
    writeFileSync(path.join(fakeDir, bashImplName), pinned);
    if (isWinClaude) {
      // A bare `bash` inside the .cmd wrapper is NOT reliably resolvable by the nested cmd.exe
      // this wrapper runs under (confirmed by direct repro: cmd.exe error 9009, "'bash' is not
      // recognized" -- the WSL/Git-Bash directory isn't necessarily on the WINDOWS-style PATH a
      // nested native process inherits, even though the OUTER bash process that got us here found
      // its own bash fine). resolveBash() is the same resolution the rest of this codebase already
      // trusts (condition-launcher.mjs's spawnCondition) -- reusing it here, as an ABSOLUTE path
      // baked into the wrapper, sidesteps PATH entirely instead of guessing at why it didn't
      // propagate through this specific nested-process chain.
      const bashPath = resolveBash();
      writeFileSync(path.join(fakeDir, 'claude.cmd'), `@echo off\r\n"${bashPath}" "%~dp0claude.impl" %*\r\n`);
    }
  }
  try { chmodSync(path.join(fakeDir, bashImplName), 0o755); } catch { /* Windows */ }
  const runs = mkdtempSync(path.join(tmpdir(), 'e1-dual-condition-runs-'));
  const isolated = mkdtempSync(path.join(tmpdir(), 'e1-dual-condition-home-'));
  const attestation = slot.runtime_id === 'claude-code' ? context.claude_attestation_file : context.codex_attestation_file;
  const basePath = slot.condition === 'no-skill'
    ? withoutProductPath(process.env.PATH ?? process.env.Path)
    : (process.env.PATH ?? process.env.Path ?? '');
  const env = {
    ...process.env, PATH: `${fakeDir}${path.delimiter}${basePath}`, KMP_EVAL_RUNS_ROOT: runs,
    KMP_EVAL_SCENARIOS_DIR: context.scenarios, KMP_EVAL_EXPECTED_DIR: context.scenarios,
    TEMP: isolated, TMP: isolated, TMPDIR: isolated,
  };
  const argv = [
    'run', '--scenario', slot.scenario_id, '--source-repo-dir', context.source,
    '--seed', String(slot.seed), '--runtime', slot.runtime_id, '--model', slot.model_requested,
    '--campaign-design', slot.campaign_design_id, '--isolation-attestation-file', attestation,
    '--timeout-ms', String(Math.round(slot.process_timeout_seconds * 1000)),
  ];
  if (slot.runtime_id === 'claude-code') argv.push('--max-budget-usd', String(slot.session_budget_usd));
  try {
    const output = await spawnCli(argv, env, slot.process_timeout_seconds);
    if (!Array.isArray(output.records) || output.records.length !== 1) throw new Error('fixture_record_count');
    const record = output.records[0];
    const evidenceRoot = path.join(runs, 'agentic-eval-scenario');
    const destinationRoot = privateRunsRoot == null ? slotRoot : path.join(privateRunsRoot, 'agentic-eval-scenario');
    mkdirSync(path.join(destinationRoot, 'audit'), { recursive: true });
    copyFileSync(path.join(evidenceRoot, `${record.run_id}.json`), path.join(destinationRoot, `${record.run_id}.json`));
    copyFileSync(path.join(evidenceRoot, 'audit', `${record.run_id}.json`), path.join(destinationRoot, 'audit', `${record.run_id}.json`));
    return { run_id: record.run_id };
  } finally {
    rmSync(runs, { recursive: true, force: true });
    rmSync(isolated, { recursive: true, force: true });
    if (pinnedFakeRoot != null) rmSync(pinnedFakeRoot, { recursive: true, force: true });
  }
}

if (action === 'setup') {
  process.stdout.write(JSON.stringify(setup(path.resolve(args[0]))));
} else if (action === 'write') {
  process.stdout.write(JSON.stringify(await writeEvidence(path.resolve(args[0]), path.resolve(args[1]), args[2])));
} else if (action === 'write-private') {
  process.stdout.write(JSON.stringify(await writeEvidence(path.resolve(args[0]), path.resolve(args[1]), args[2], path.resolve(args[3]))));
} else {
  throw new Error('fixture_action');
}
