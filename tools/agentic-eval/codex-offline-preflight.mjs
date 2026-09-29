#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import codexCliRuntimeAdapter from './runtimes/codex-cli.mjs';
import { materializeSkillSnapshot } from './materialize.mjs';
import { resolveSelection } from './registries.mjs';
import { runValidator as runPluginValidator } from '../validate-plugin.mjs';
import { PINNED_SKILL_SHA } from './cli.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAFE_OFFLINE_FAILURE_CODES = new Set([
  'codex_skill_catalog_probe_failed',
  'codex_skill_catalog_invalid',
  'codex_skill_snapshot_missing',
  'codex_skill_isolation_failed',
  'codex_skill_isolation_target_count_failed',
  'codex_skill_isolation_target_path_failed',
  'codex_skill_snapshot_contains_unsupported_entry',
  'codex_skill_delivery_requires_fixture',
]);

async function runCodexOfflinePreflightUnsafe({
  repoRoot = REPO_ROOT,
  adapter = codexCliRuntimeAdapter,
  validateFn = runPluginValidator,
} = {}) {
  const selection = resolveSelection({
    runtimeId: 'codex-cli', modelId: 'gpt-5.6-terra', executionProfileId: 'sandboxed-unrestricted-v1',
  });
  if (!selection.ok) return { ok: false, reason_code: 'registry_selection_failed' };

  const auth = await adapter.preflight({ sharedEnv: process.env, repoRoot });
  if (!auth.ok) return { ok: false, reason_code: auth.reasonCode, cli_version: auth.cliVersion ?? null };

  const cleanup = [];
  let stage = 'skill_snapshot';
  try {
    const { snapshotDir } = await materializeSkillSnapshot({ repoRoot, sha: PINNED_SKILL_SHA, validateFn });
    cleanup.push(snapshotDir);
    stage = 'fixture_creation';
    const productFixture = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-codex-product-'));
    const baselineFixture = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-codex-baseline-'));
    cleanup.push(productFixture, baselineFixture);
    stage = 'isolated_home';
    const isolated = await adapter.prepareIsolatedHome({
      shimDir: '', gradleUserHome: tmpdir(), kmpEvalTempHome: tmpdir(),
      expectedFixtureRoot: productFixture, allowedGradleTasks: [], allowedKmpTestSubcommands: [],
      junitEvidenceEnabled: false, executionProfile: selection.selection.executionProfile,
    });
    cleanup.push(...isolated.cleanupPaths);
    stage = 'invocation_build';
    const invocation = adapter.buildInvocation({
      prompt: '', model: selection.selection.model.model_id, settingsPath: isolated.settingsPath,
      executionProfile: selection.selection.executionProfile,
      reasoningMode: selection.selection.model.default_reasoning_mode,
    });
    stage = 'product_skill_delivery';
    const product = await adapter.prepareSkillDelivery(invocation, 'current-skill', snapshotDir, {
      fixtureDir: productFixture, conditionEnv: isolated.sharedEnv,
    });
    stage = 'baseline_skill_delivery';
    const baseline = await adapter.prepareSkillDelivery(invocation, 'no-skill', null, {
      fixtureDir: baselineFixture, conditionEnv: isolated.sharedEnv,
    });
    stage = 'condition_evaluation';
    const productAmbient = [...product.runtimeContext.ambientNames].sort();
    const baselineAmbient = [...baseline.runtimeContext.ambientNames].sort();
    const ambientEquivalent = JSON.stringify(productAmbient) === JSON.stringify(baselineAmbient);
    const ok = product.runtimeContext.skillAvailable === true
      && product.runtimeContext.snapshotBindingMatches === true
      && baseline.runtimeContext.skillAvailable === false
      && ambientEquivalent;
    return {
      ok,
      reason_code: ok ? null : 'codex_skill_condition_isolation_failed',
      runtime_id: 'codex-cli',
      cli_version: auth.cliVersion,
      auth_preflight: 'pass',
      model_requested: selection.selection.model.model_id,
      product_skill_available: product.runtimeContext.skillAvailable === true,
      product_snapshot_bound: product.runtimeContext.snapshotBindingMatches === true,
      baseline_skill_available: baseline.runtimeContext.skillAvailable === true,
      ambient_non_target_count: productAmbient.length,
      ambient_equivalent: ambientEquivalent,
      inference_sessions_consumed: 0,
    };
  } catch (error) {
    const detail = error instanceof Error && SAFE_OFFLINE_FAILURE_CODES.has(error.message)
      ? error.message
      : null;
    return {
      ok: false,
      reason_code: detail == null
        ? `codex_offline_preflight_${stage}_failed`
        : `codex_offline_preflight_${detail}`,
      runtime_id: 'codex-cli',
      cli_version: auth.cliVersion, inference_sessions_consumed: 0,
    };
  } finally {
    for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
  }
}

export async function runCodexOfflinePreflight(options = {}) {
  try {
    return await runCodexOfflinePreflightUnsafe(options);
  } catch {
    return {
      ok: false,
      reason_code: 'codex_offline_preflight_failed',
      runtime_id: 'codex-cli',
      cli_version: null,
      inference_sessions_consumed: 0,
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCodexOfflinePreflight();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
