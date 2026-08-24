// tests/vitest/agentic-eval-product-access-preflight.test.js
// Locks the privacy-safe free-baseline/no-product preflight. This is an offline gate: it never
// launches Claude, never reads raw transcripts, and reports counts/codes rather than host paths.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateProductAccessPreflight,
  summarizeProductAccessPreflight,
} from '../../tools/agentic-eval/product-access-preflight.mjs';

const tempRoots = [];

function tempDir(prefix = 'ae-product-access-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('evaluateProductAccessPreflight -- free-baseline-no-product', () => {
  it('accepts a clean source-only workspace with no product env and no product CLI on PATH', () => {
    const workspace = tempDir();
    writeFileSync(path.join(workspace, 'settings.gradle.kts'), 'pluginManagement {}\n');
    const pathDir = tempDir('ae-clean-path-');

    const result = evaluateProductAccessPreflight({
      mode: 'free-baseline-no-product',
      workspaceDir: workspace,
      env: { PATH: pathDir, JAVA_HOME: 'C:\\Java\\jdk' },
    });

    expect(result.ok).toBe(true);
    expect(result.product_access_mode).toBe('free-baseline-no-product');
    expect(result.observed_product_access_mode).toBe('free-baseline-no-product');
    expect(result.checks.every((c) => c.ok === true)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(workspace);
    expect(JSON.stringify(result)).not.toContain(pathDir);
  });

  it('classifies a harness/product workspace as contaminated without leaking its path', () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, 'tools', 'agentic-eval'), { recursive: true });
    mkdirSync(path.join(workspace, '.skills', 'kmp-test-runner'), { recursive: true });

    const result = evaluateProductAccessPreflight({
      mode: 'free-baseline-no-product',
      workspaceDir: workspace,
      env: { PATH: tempDir('ae-clean-path-') },
    });

    expect(result.ok).toBe(false);
    expect(result.observed_product_access_mode).toBe('contaminated-baseline');
    const markerCheck = result.checks.find((c) => c.id === 'workspace_product_markers_absent');
    expect(markerCheck.ok).toBe(false);
    expect(markerCheck.marker_count).toBe(2);
    expect(JSON.stringify(result)).not.toContain(workspace);
  });

  it('detects kmp-test-runner in package manifests/dependencies', () => {
    const workspace = tempDir();
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'baseline-target',
      devDependencies: { 'kmp-test-runner': '1.2.3' },
    }, null, 2));

    const result = evaluateProductAccessPreflight({
      mode: 'free-baseline-no-product',
      workspaceDir: workspace,
      env: { PATH: tempDir('ae-clean-path-') },
    });

    const manifestCheck = result.checks.find((c) => c.id === 'workspace_manifest_product_dependency_absent');
    expect(result.ok).toBe(false);
    expect(manifestCheck.ok).toBe(false);
    expect(manifestCheck.manifest_match_count).toBe(1);
  });

  it('detects product CLI visibility on PATH without reporting the PATH value', () => {
    const workspace = tempDir();
    const pathDir = tempDir('ae-product-path-');
    writeFileSync(path.join(pathDir, process.platform === 'win32' ? 'kmp-test.cmd' : 'kmp-test'), '');

    const result = evaluateProductAccessPreflight({
      mode: 'free-baseline-no-product',
      workspaceDir: workspace,
      env: { PATH: pathDir },
    });

    const pathCheck = result.checks.find((c) => c.id === 'path_product_cli_absent');
    expect(result.ok).toBe(false);
    expect(pathCheck.ok).toBe(false);
    expect(pathCheck.executable_match_count).toBe(1);
    expect(JSON.stringify(result)).not.toContain(pathDir);
  });

  it('detects product-specific environment variables by count only', () => {
    const workspace = tempDir();
    const result = evaluateProductAccessPreflight({
      mode: 'free-baseline-no-product',
      workspaceDir: workspace,
      env: { PATH: tempDir('ae-clean-path-'), KMP_EVAL_RUNS_ROOT: 'secret-path', KMP_TEST_OUTPUT_DIR: 'secret-path' },
    });

    const envCheck = result.checks.find((c) => c.id === 'env_product_vars_absent');
    expect(result.ok).toBe(false);
    expect(envCheck.ok).toBe(false);
    expect(envCheck.env_var_count).toBe(2);
    expect(JSON.stringify(result)).not.toContain('secret-path');
  });

  it('fails closed on unsupported modes instead of silently treating them as free baseline', () => {
    const result = evaluateProductAccessPreflight({
      mode: 'product-visible-no-skill',
      workspaceDir: tempDir(),
      env: { PATH: tempDir('ae-clean-path-') },
    });

    expect(result.ok).toBe(false);
    expect(result.product_access_mode).toBe('product-visible-no-skill');
    expect(result.observed_product_access_mode).toBe('product-access-not-recorded');
    expect(result.checks.find((c) => c.id === 'mode_supported')).toMatchObject({ ok: false });
  });

  it('summarizes only closed status/count fields', () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, 'tools', 'agentic-eval'), { recursive: true });
    const result = evaluateProductAccessPreflight({
      mode: 'free-baseline-no-product',
      workspaceDir: workspace,
      env: { PATH: tempDir('ae-clean-path-'), KMP_EVAL_RUNS_ROOT: 'secret-path' },
    });

    expect(summarizeProductAccessPreflight(result)).toEqual({
      ok: false,
      product_access_mode: 'free-baseline-no-product',
      observed_product_access_mode: 'contaminated-baseline',
      failed_check_count: 2,
      check_count: result.checks.length,
    });
  });
});

describe('cli.mjs product-access preflight', () => {
  it('prints JSON and exits non-zero for a contaminated free baseline', () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, 'tools', 'agentic-eval'), { recursive: true });
    const cli = path.resolve('tools', 'agentic-eval', 'cli.mjs');
    const child = spawnSync(process.execPath, [
      cli,
      'product-access',
      'preflight',
      '--mode',
      'free-baseline-no-product',
      '--workspace',
      workspace,
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, KMP_EVAL_RUNS_ROOT: undefined, KMP_TEST_OUTPUT_DIR: undefined },
    });

    expect(child.status).toBe(1);
    const parsed = JSON.parse(child.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.observed_product_access_mode).toBe('contaminated-baseline');
    expect(child.stdout).not.toContain(workspace);
  });
});
