import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(join(process.cwd(), 'docs', 'audits', 'evidence1-codex-live-launch.ps1'), 'utf8');

describe('Evidence1 Codex live launcher contract', () => {
  it('fixes the runtime, model campaign, six-session order, and unsupported budget reason', () => {
    expect(script).toContain("$Runtime = 'codex-cli'");
    expect(script).toContain("$CampaignDesign = 'codex-product-vs-free-baseline-v1'");
    expect(script).toContain("[string]$Model = 'gpt-5.6-terra'");
    expect(script).toContain("$ExpectedOrder = @('A', 'B', 'B', 'A', 'A', 'B')");
    expect(script).toContain("$ExpectedConditions = @('current-skill', 'no-skill', 'no-skill', 'current-skill', 'current-skill', 'no-skill')");
    expect(script).toContain("session_budget_reason = 'runtime_does_not_support_session_budget'");
    expect(script).toContain("'tools\\agentic-eval\\codex-offline-preflight.mjs'");
    expect(script).toContain("skill_isolation_preflight = 'pass'");
    expect(script).toContain('inference_sessions_consumed_by_preflight = 0');
    expect(script).toContain('Assert-CanonicalCodexToolchain');
    expect(script).toContain("@('codex-cli','0.154.0','bin\\codex.exe')");
    expect(script).toContain("throw 'canonical Codex publisher mismatch'");
    expect(script).toContain("$env:CODEX_HOME -cne 'C:\\Evidence1RuntimeState\\codex'");
    expect(script).toContain("@('git-bash','2.55.0.windows.5','bin\\bash.exe')");
    expect(script).toContain("$bash = $canonicalToolchain['git-bash'].command");
    expect(script).toContain('KMP_EVAL_BASH_PATH = $bash');
  });

  it('requires the exact authorization and contains one live dispatch with no retry loop', () => {
    expect(script).toContain('AUTORIZO EXACTAMENTE 6 SESIONES CODEX: 3 PRODUCT Y 3 FREE-BASELINE; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS.');
    expect(script).toContain("if ($Authorization -cne $RequiredAuthorization)");
    expect(script.match(/\$liveExit = Invoke-CapturedProcess/g)).toHaveLength(1);
    expect(script).not.toMatch(/for\s*\([^)]*retry|while\s*\([^)]*live/i);
  });

  it('preserves the attested Codex auth home across every isolated child process', () => {
    expect(script).toContain("$codexRuntimeRoot = 'C:\\Evidence1RuntimeState'");
    expect(script).toContain("$codexHome = 'C:\\Evidence1RuntimeState\\codex'");
    expect(script).toContain('KMP_EVAL_CODEX_HOME = $codexHome');
    expect(script).toContain('KMP_EVAL_CODEX_RUNTIME_ROOT = $codexRuntimeRoot');
    expect(script).toContain('$offlineExit = Invoke-CapturedProcess $node @($offlinePreflightPath) $HarnessDir $offlineStdout $offlineStderr $codexIsolationEnv 120');
    expect(script).toContain('$dryExit = Invoke-CapturedProcess $node ($commonArgs + \'--dry-run\') $HarnessDir $dryStdout $dryStderr $codexIsolationEnv 300');
    expect(script).toContain('$liveEnvironment = $codexIsolationEnv.Clone()');
    expect(script).toContain('$liveExit = Invoke-CapturedProcess $node $commonArgs $HarnessDir $liveStdout $liveStderr $liveEnvironment 7200');
  });

  it('closes exact records and sidecars, reduces descriptively, and atomically publishes only the sanitized closed set', () => {
    expect(script).toContain("throw 'CustodyDir must be outside and must not contain the harness repository'");
    expect(script).toContain("throw 'CustodyDir must not already exist'");
    expect(script).toContain("if (@($campaignOutput.records).Count -ne 6)");
    expect(script).toContain("@($cliPath, 'validate', '--run', $recordPath)");
    expect(script).not.toContain("'aggregate', '--runs-dir'");
    expect(script).not.toContain("'analyze', '--runs-dir'");
    expect(script).toContain('evidence1-codex-pilot-describe.mjs');
    expect(script).toContain('evidence1-codex-publication-scan.mjs');
    expect(script).toContain('not-applicable:benchmark_ineligible_records_are_rejected_by_publishable_aggregate');
    expect(script).toContain('benchmark_eligible = $false');
    expect(script).toContain("throw 'PublicDir is required for Live mode'");
    expect(script).toContain("throw 'PublicDir must be a new child of the harness tools/runs directory'");
    expect(script).toContain('Move-Item -LiteralPath $stage -Destination $publicFull');
    expect(script).toContain("if ((Get-ChildItem -LiteralPath $stage -File).Count -ne 8)");
    expect(script).toContain('evidence1-final-codex-publication-manifest');
    expect(script).toContain("binding_sha256 = $CampaignBindingSha256");
    expect(script).toContain("Destination (Join-Path $stage 'manifest.json')");
    expect(script).toContain("throw 'staged publication record hash mismatch'");
    expect(script).not.toContain("Copy-Item -LiteralPath $liveStdout");
    expect(script).not.toContain("Copy-Item -LiteralPath $liveStderr");
    expect(script).not.toContain('Copy-Item -LiteralPath $sidecarPath');
    expect(script).toContain("throw 'process_timeout_tree_terminated'");
  });

  it('binds the live invocation to immutable campaign and authorization claims', () => {
    expect(script).toContain('KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING');
    expect(script).toContain('KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM');
    expect(script).toContain("throw 'final campaign binding or authorization claim hash mismatch'");
    expect(script).toContain('[IO.FileMode]::CreateNew');
    expect(script).toContain('$stream.Flush($true)');
  });

  it('seeds every isolated Gradle home from the certified guest cache', () => {
    expect(script).toContain("$GradleUserHomeSeedDir = Join-Path $env:USERPROFILE '.gradle'");
    expect(script).toContain("throw 'prewarmed Gradle user-home seed directory missing'");
    expect(script).toContain("$GradleCacheCertificationPath = 'C:\\Evidence1RuntimeState\\gradle-cache-certification.json'");
    expect(script).toContain("throw 'Gradle cache certification mismatch'");
    expect(script).toContain("$liveEnvironment['KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR'] = $GradleUserHomeSeedDir");
  });

  it('never adds a Codex monetary budget flag', () => {
    expect(script).not.toContain('--max-budget-usd');
  });
});
