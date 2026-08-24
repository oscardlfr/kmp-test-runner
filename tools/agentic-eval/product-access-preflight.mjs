#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/product-access-preflight.mjs -- offline, privacy-safe checks for the future
// true free-baseline/no-product control. This does not prove an agent lacks latent knowledge; it
// proves the local workspace/process surface does not expose this repo's product artifacts.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isProductAccessMode } from './product-access.mjs';

const SUPPORTED_PREFLIGHT_MODES = Object.freeze(['free-baseline-no-product']);

const PRODUCT_WORKSPACE_MARKERS = Object.freeze([
  '.skills/kmp-test-runner',
  '.claude-plugin',
  'tools/agentic-eval',
  'bin/kmp-test.js',
]);

const PRODUCT_EXECUTABLE_NAMES = Object.freeze([
  'kmp-test',
  'kmp-test.cmd',
  'kmp-test.ps1',
  'kmp-test-runner',
  'kmp-test-runner.cmd',
  'kmp-test-runner.ps1',
]);

const PRODUCT_ENV_PREFIXES = Object.freeze(['KMP_EVAL_', 'KMP_TEST_']);
const PRODUCT_PACKAGE_NAMES = Object.freeze(['kmp-test-runner']);

function check(id, ok, extra = {}) {
  return { id, ok, ...extra };
}

function isDirectory(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function countWorkspaceProductMarkers(workspaceDir) {
  if (!isDirectory(workspaceDir)) return 0;
  let count = 0;
  for (const marker of PRODUCT_WORKSPACE_MARKERS) {
    if (existsSync(path.join(workspaceDir, ...marker.split('/')))) count++;
  }
  return count;
}

function packageJsonProductMatchCount(workspaceDir) {
  const packageJsonPath = path.join(workspaceDir, 'package.json');
  if (!existsSync(packageJsonPath)) return 0;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return 0;
  }
  let count = 0;
  if (PRODUCT_PACKAGE_NAMES.includes(parsed?.name)) count++;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = parsed?.[field];
    if (deps == null || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) {
      if (PRODUCT_PACKAGE_NAMES.includes(name)) count++;
    }
  }
  return count;
}

function pathProductExecutableCount(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return 0;
  let count = 0;
  const seen = new Set();
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const exe of PRODUCT_EXECUTABLE_NAMES) {
      const candidate = path.join(dir, exe);
      const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      if (existsSync(candidate)) count++;
    }
  }
  return count;
}

function productEnvVarCount(env) {
  if (env == null || typeof env !== 'object') return 0;
  return Object.entries(env).filter(([name, value]) => (
    value != null && PRODUCT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  )).length;
}

function pathFromEnv(env) {
  return env?.PATH ?? env?.Path ?? env?.path ?? '';
}

export function summarizeProductAccessPreflight(result) {
  const failed = Array.isArray(result?.checks) ? result.checks.filter((c) => c.ok !== true).length : 0;
  return {
    ok: result?.ok === true,
    product_access_mode: result?.product_access_mode ?? 'product-access-not-recorded',
    observed_product_access_mode: result?.observed_product_access_mode ?? 'product-access-not-recorded',
    failed_check_count: failed,
    check_count: Array.isArray(result?.checks) ? result.checks.length : 0,
  };
}

/**
 * Evaluates whether a process/workspace surface is clean enough to label a future control as
 * `free-baseline-no-product`. The returned object is deliberately closed around counts/statuses:
 * no absolute workspace path, PATH entry, or environment value is emitted.
 */
export function evaluateProductAccessPreflight({ mode, workspaceDir, env = process.env } = {}) {
  const checks = [];

  const modeKnown = isProductAccessMode(mode);
  const modeSupported = SUPPORTED_PREFLIGHT_MODES.includes(mode);
  checks.push(check('mode_known', modeKnown));
  checks.push(check('mode_supported', modeSupported));

  const workspaceAccessible = typeof workspaceDir === 'string' && isDirectory(workspaceDir);
  checks.push(check('workspace_accessible', workspaceAccessible));

  if (!modeKnown || !modeSupported) {
    return {
      schema: 1,
      ok: false,
      product_access_mode: modeKnown ? mode : 'product-access-not-recorded',
      observed_product_access_mode: 'product-access-not-recorded',
      checks,
    };
  }

  const markerCount = workspaceAccessible ? countWorkspaceProductMarkers(workspaceDir) : 0;
  checks.push(check('workspace_product_markers_absent', markerCount === 0, { marker_count: markerCount }));

  const manifestMatchCount = workspaceAccessible ? packageJsonProductMatchCount(workspaceDir) : 0;
  checks.push(check('workspace_manifest_product_dependency_absent', manifestMatchCount === 0, { manifest_match_count: manifestMatchCount }));

  const executableMatchCount = pathProductExecutableCount(pathFromEnv(env));
  checks.push(check('path_product_cli_absent', executableMatchCount === 0, { executable_match_count: executableMatchCount }));

  const envVarCount = productEnvVarCount(env);
  checks.push(check('env_product_vars_absent', envVarCount === 0, { env_var_count: envVarCount }));

  const ok = checks.every((c) => c.ok === true);
  return {
    schema: 1,
    ok,
    product_access_mode: mode,
    observed_product_access_mode: ok ? 'free-baseline-no-product' : 'contaminated-baseline',
    checks,
  };
}
