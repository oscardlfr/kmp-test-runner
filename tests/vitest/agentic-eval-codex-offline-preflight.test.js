import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { runCodexOfflinePreflight } from '../../tools/agentic-eval/codex-offline-preflight.mjs';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

const repoRoot = process.cwd();
const fakeDir = join(repoRoot, 'tests', 'fixtures', 'fake-codex-campaign-success');
const fakeCodex = join(fakeDir, 'codex');

describe('Codex offline preflight executable', () => {
  it('proves product presence, baseline absence, snapshot binding, and ambient equivalence without inference', () => {
    if (process.platform !== 'win32') chmodSync(fakeCodex, 0o755);
    const bash = process.platform === 'win32' ? resolveBash({ fresh: true }) : null;
    const stdout = execFileSync(process.execPath, [join(repoRoot, 'tools', 'agentic-eval', 'codex-offline-preflight.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeDir}${delimiter}${process.env.PATH ?? ''}`,
        ...(bash ? { KMP_EVAL_BASH_PATH: bash } : {}),
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      reason_code: null,
      runtime_id: 'codex-cli',
      cli_version: '0.154.0',
      auth_preflight: 'pass',
      model_requested: 'gpt-5.6-terra',
      product_skill_available: true,
      product_snapshot_bound: true,
      baseline_skill_available: false,
      ambient_equivalent: true,
      inference_sessions_consumed: 0,
    });
  }, 60000);

  it('closes an adapter exception as a zero-session JSON-compatible failure', async () => {
    const result = await runCodexOfflinePreflight({
      adapter: { preflight: async () => { throw new Error('fixture failure'); } },
    });
    expect(result).toEqual({
      ok: false,
      reason_code: 'codex_offline_preflight_failed',
      runtime_id: 'codex-cli',
      cli_version: null,
      inference_sessions_consumed: 0,
    });
  });

  it('identifies the failing offline isolation stage without exposing exception text', async () => {
    const result = await runCodexOfflinePreflight({
      adapter: {
        preflight: async () => ({ ok: true, cliVersion: '0.154.0' }),
        prepareIsolatedHome: async () => { throw new Error('private fixture path'); },
      },
    });
    expect(result).toEqual({
      ok: false,
      reason_code: 'codex_offline_preflight_isolated_home_failed',
      runtime_id: 'codex-cli',
      cli_version: '0.154.0',
      inference_sessions_consumed: 0,
    });
    expect(JSON.stringify(result)).not.toContain('private fixture path');
  });

  it('preserves an allowlisted skill-catalog failure code without raw process output', async () => {
    const result = await runCodexOfflinePreflight({
      adapter: {
        preflight: async () => ({ ok: true, cliVersion: '0.154.0' }),
        prepareIsolatedHome: async () => ({ cleanupPaths: [], sharedEnv: {}, settingsPath: 'fixture' }),
        buildInvocation: () => ({ runtimeContext: {} }),
        prepareSkillDelivery: async () => { throw new Error('codex_skill_catalog_probe_failed'); },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      reason_code: 'codex_offline_preflight_codex_skill_catalog_probe_failed',
      inference_sessions_consumed: 0,
    });
  });
});
