import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { canonicalJsonSha256 } from '../../tools/agentic-eval/canonical-json.mjs';
import { computeExecutionProfileSha256 } from '../../tools/agentic-eval/registries.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modulePath = resolve(root, 'docs/audits/evidence1-validation-ops.psm1');
it('preserves the validation module byte identity through Windows Git checkout filters', () => {
  const object = 'HEAD:docs/audits/evidence1-validation-ops.psm1';
  const blob = spawnSync('git', ['cat-file', 'blob', object], { cwd: root, windowsHide: true });
  const checkout = spawnSync('git', ['-c', 'core.autocrlf=true', 'cat-file', '--filters', object], {
    cwd: root, windowsHide: true,
  });
  expect(blob.status, blob.stderr?.toString()).toBe(0);
  expect(checkout.status, checkout.stderr?.toString()).toBe(0);
  expect(checkout.stdout.equals(blob.stdout)).toBe(true);
});
const quote = value => `'${value.replaceAll("'", "''")}'`;
const json = value => `ConvertFrom-E1Json ${quote(JSON.stringify(value))}`;
function ps(body, shell = 'pwsh') {
  const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\nImport-Module ${quote(modulePath)} -Force -DisableNameChecking\n${body}`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 40_000, windowsHide: true,
  });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const source = '7d45eae4f8720a0c77f507712ba2437ff974b6ed';
const attestation = {
  schema: 1, profile_id: 'sandboxed-unrestricted-v1', runtime_id: 'claude-code',
  campaign_id: 'evidence1-product-free-stageb', platform: 'windows',
  boundary_kind: 'dedicated-ephemeral-runner', network_mode: 'restricted',
  workspace_scope: 'campaign-only', runtime_credential_scope: 'runtime-only',
  normal_maintainer_home_mounted: false, ambient_secrets_present: false,
  disposable_home: true, rollback_or_destroy_required: true, harness_sha: commit,
  created_at: '2026-08-30T12:00:00Z', expires_at: '2026-08-31T11:00:00Z',
};
const hash = canonicalJsonSha256(attestation);
const evidence = {
  readiness: { verdict: 'PASS', vm_name: 'Evidence1-Runner', vm_state: 'Running',
    generated_at_utc: '2026-08-30T12:01:00Z', target_commit: commit, target_tree: tree,
    guest: { verdict: 'PASS', harness_head: commit, harness_tree: tree, source_head: source, planned_sessions: 8, tools: { claude: '2.1.238 (Claude Code)', java_present: true },
      attestation_sha256: hash, attestation_path: 'C:\\kmp-eval\\measurement-scopes\\attestation.json' },
    privacy: { raw_transcript_content_read: false, stderr_content_read: false,
      attestation_content_printed: false, dry_run_stdout_printed: false } },
  ledger: { verdict: 'PASS', generated_at_utc: '2026-08-30T12:01:00Z',
    tools: { java_present: true, claude_logged_in: true, claude: '2.1.238 (Claude Code)' },
    anchors: { harness_commit_actual: commit, harness_commit_expected: commit,
      harness_tree_actual: tree, harness_tree_expected: tree,
      source_commit_actual: source, source_commit_expected: source },
    r5_attestation: { ok: true, schema: 1, attestation_sha256: hash },
    operator_confirmation: { boundary_kind: 'dedicated-ephemeral-runner', workspace: 'campaign-only', credentials: 'runtime-only',
      network: 'restricted', normal_home_mounted: false, ambient_secrets_present: false, disposable_home: true,
      rollback_or_destroy_required: true, supplied_in_session: true },
    network: { allowed_probe_count: 4, blocked_probe_count: 6, blocked_probe_success_count: 0 },
    R7_campaign_dry_run: { pass_dry_run: { campaign_design_id: 'claude-product-vs-free-baseline-v1', planned_sessions: 8,
      plan_length: 8, strict_cell_count: 0, unrestricted_cell_count: 8, strict_cells_with_attestation_hash: 0,
      unrestricted_cells_with_attestation_hash: 8, distinct_attestation_hashes_among_unrestricted: 1,
      attestation_hash_matches_fresh_attestation: true, attestation_path_leaked_in_output: false,
      attestation_content_leaked_in_output: false, attestation_timestamps_leaked_in_output: false } },
    zero_live_confirmation: { no_non_dry_run_command_executed_by_readiness: true,
      no_calibrate_or_smoke: true, raw_transcript_content_read: false, stderr_content_read: false } },
};
const envelope = {
  tool: 'kmp-test', subcommand: 'parallel', exit_code: 1,
  tests: { total: 1, passed: 1, failed: 0, individual_total: 4 },
  coverage: { missed_lines: 23, modules_contributing: 1, module_buckets: { with_data: [':core:domain'] } },
  errors: [{ code: 'coverage_threshold_exceeded', threshold: 15, missed_lines: 23, message: 'PRIVATE_PROSE' }],
  project_root: 'PRIVATE_PATH', arbitrary: 'PRIVATE_TRANSCRIPT',
};
const registry = JSON.parse(readFileSync(resolve(root, 'tools/agentic-eval/execution-profiles/registry.json'), 'utf8'));
const profileHash = computeExecutionProfileSha256(registry.execution_profiles.find(profile => profile.id === 'sandboxed-unrestricted-v1'));
function dryPlan(product) {
  return { dry_run: true, scenario_id: 'coverage-threshold-failure-v2', repeats: 1, seed: 20260821,
    campaign_design_id: product ? 'claude-product-canary-v1' : 'claude-free-baseline-canary-v1',
    runtime_id: 'claude-code', model_id: 'irrelevant', max_budget_usd: 2, planned_sessions: 1,
    plan: [{ order_index: 0, repetition_index: 0, campaign_cell_label: product ? 'A' : 'B',
      condition: product ? 'current-skill' : 'no-skill', product_access_mode: product ? 'product-assisted' : 'free-baseline-no-product',
      execution_profile_id: 'sandboxed-unrestricted-v1', execution_profile_sha256: profileHash,
      execution_profile_isolation_kind: 'external-sandbox', execution_profile_network_mode: 'restricted',
      execution_profile_policy_mode: 'not_applicable', execution_profile_isolation_attestation_sha256: hash }] };
}

const hasPowerShell = !spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).error;
describe.skipIf(!hasPowerShell)('Evidence1 validation operations functional contract', () => {
  it('schema2 preserves independent product, postflight and persistence failures and actual process facts', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-diagnostics-'));
    try {
      const result = ps(`$m=Get-Module evidence1-validation-ops
        & $m {
          param($dir)
          function Invoke-E1OwnedProcess { return @{ExitCode=3;TimedOut=$false;WallSeconds=2.75;CleanupOk=$true} }
          $r=Invoke-E1WetAttempt $dir '${commit}' '${tree}' 'synthetic' 'synthetic' 'synthetic'
          function Write-E1Record { throw 'PRIVATE_DISK_DETAIL' }
          $r=Complete-E1Attempt $r $dir { throw 'repo_dirty' }
          $r | ConvertTo-Json -Depth 10 -Compress
        } ${quote(dir)}`);
      expect(result.schema).toBe(2);
      expect(result.failures).toEqual({ primary: 'product_contract', postflight: 'repo_dirty', persistence: 'terminal_write_failed', transport: null });
      expect(result.processes.product).toEqual({ exit_code: 3, wall_seconds: 2.75, timed_out: false, cleanup_ok: true });
      expect(result.live_records_created).toBeNull();
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('schema2 validates every failure enum and process field without coercion or unknown keys', () => {
    const result = ps(`$r=New-E1Result 'wet-v2' '${commit}' '${tree}'
      $out=@()
      foreach($slot in @('primary','postflight','persistence','transport')) {
        $r.failures[$slot]='repo_dirty'
        $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'
        foreach($bad in @('PRIVATE_ERROR','REPO_DIRTY',1,$false,@('repo_dirty'))) {
          $r.failures[$slot]=$bad
          try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }
        }
        $r.failures[$slot]=$null
      }
      $r.processes.product=@{exit_code=3;wall_seconds=2.5;timed_out=$false;cleanup_ok=$true}
      $r.product_invocations=1
      $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'
      foreach($pair in @(@('exit_code','3'),@('exit_code',1.5),@('wall_seconds','2.5'),@('wall_seconds',-1),@('wall_seconds',[double]::NaN),@('timed_out',0),@('cleanup_ok','true'))) {
        $old=$r.processes.product[$pair[0]]; $r.processes.product[$pair[0]]=$pair[1]
        try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }
        $r.processes.product[$pair[0]]=$old
      }
      foreach($object in @($r.failures,$r.processes,$r.processes.product)) {
        $object['extra']='PRIVATE_DETAIL'
        try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }
        $object.Remove('extra')
      }
      $out | ConvertTo-Json -Compress`);
    expect(result).toEqual(Array(30).fill(true));
  });

  it('reads historical schema1 without fabricating process metrics or independent failure causes', () => {
    const historical = { schema: 1, operation: 'wet-v2', state: 'failed', failure_code: 'product_contract', stage: 'postflight',
      target_commit: commit, target_tree: tree, source_commit: source, agent_calls: 0, live_records_created: 0,
      product_invocations: 1, dry_plan_invocations: 0, product_report_build_writes_expected: true,
      checks: { postflight: false }, hashes: {} };
    expect(ps(`ConvertTo-E1SafeResult (${json(historical)}) 'wet-v2' '${commit}' '${tree}' | ConvertTo-Json -Depth 10 -Compress`)).toEqual(historical);
  });

  it('records a transport error independently of an already failed product result', () => {
    const result = ps(`$r=New-E1Result 'wet-v2' '${commit}' '${tree}'
      Set-E1Failure $r 'primary' 'product_contract'
      Set-E1Failure $r 'transport' 'readiness_changed'
      ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}' | ConvertTo-Json -Depth 10 -Compress`);
    expect(result.failures).toEqual({ primary: 'product_contract', postflight: null, persistence: null, transport: 'readiness_changed' });
    expect(result.failure_code).toBe('readiness_changed');
  });

  it('stops on a failed initial marker flush and classifies persistence separately from product', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-marker-'));
    try {
      const result = ps(`$m=Get-Module evidence1-validation-ops
        & $m {
          param($dir)
          $script:calls=0; $script:writes=0
          function Invoke-E1OwnedProcess { $script:calls++; throw 'PRIVATE_PRODUCT_CALLED' }
          function Write-E1Record { $script:writes++; if($script:writes -eq 1) {throw 'PRIVATE_DISK'} }
          $r=Invoke-E1WetAttempt $dir '${commit}' '${tree}' 'synthetic' 'synthetic' 'synthetic'
          @{result=$r;calls=$script:calls} | ConvertTo-Json -Depth 10 -Compress
        } ${quote(dir)}`);
      expect(result.calls).toBe(0);
      expect(result.result.failures).toEqual({ primary: null, postflight: null, persistence: 'terminal_write_failed', transport: null });
      expect(result.result.processes.product).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('checks the real wet envelope and emits only fixed booleans', () => {
    const checks = ps(`Get-E1WetChecks (${json(envelope)}) 1 299.9 | ConvertTo-Json -Compress`);
    expect(Object.values(checks).every(value => value === true)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain('PRIVATE');
  });

  it('rejects wrong counts, coercible strings, extra errors, wrong buckets and timeout', () => {
    const mutations = [
      e => { e.tool = 'KMP-TEST'; }, e => { e.tests.failed = '0'; },
      e => { e.tests.individual_total = 3; }, e => { e.coverage.missed_lines = 22; },
      e => { e.coverage.modules_contributing = 2; },
      e => { e.coverage.module_buckets.with_data.push(':other'); },
      e => { e.errors.push({ code: 'other' }); }, e => { e.errors[0].threshold = 16; },
      e => { e.errors[0].missed_lines = 24; }, e => { e.exit_code = 0; },
      e => { e.errors = e.errors[0]; }, e => { e.coverage.module_buckets.with_data = ':core:domain'; },
      e => { delete e.tests; },
    ].map(mutate => { const e = structuredClone(envelope); mutate(e); return e; });
    const outcomes = ps(`$values = ${json(mutations)}
      @($values | ForEach-Object { $c = Get-E1WetChecks $_ 1 300; -not ($c.Values -contains $false) }) | ConvertTo-Json -Compress`);
    expect(outcomes).toEqual(mutations.map(() => false));
    expect(ps(`Get-E1WetChecks (${json(envelope)}) 1 300.001 | ConvertTo-Json -Compress`).wall_budget).toBe(false);
    expect(ps(`Get-E1WetChecks (${json(envelope)}) 0 1 | ConvertTo-Json -Compress`).process_exit).toBe(false);
  });

  it('rejects escapes, root paths, ADS and ambiguous canonical segments', () => {
    const rejected = ['C:/', 'C:/kmp-eval', 'C:/kmp-eval/../outside', 'C:/kmp-eval/ok/../../other',
      'C:/kmp-eval-other/x', 'C:/kmp-eval/x:stream', '//server/share', 'C:relative',
      'C:/kmp-eval/x./file', 'C:/kmp-eval/x /file'];
    expect(ps(`$paths = ${json(rejected)}
      @($paths | ForEach-Object { try { $null = Resolve-E1Path $_; $false } catch { $true } }) | ConvertTo-Json -Compress`))
      .toEqual(rejected.map(() => true));
    expect(ps(`Resolve-E1Path 'C:/kmp-eval/scratch/validation/report.json' | ConvertTo-Json -Compress`))
      .toBe('C:\\kmp-eval\\scratch\\validation\\report.json');
  });

  it('binds guest identity to the Hyper-V VM id, host distinction and local account', () => {
    expect(ps(`$good = @{ ComputerName='Evidence1Runner'; HostComputerName='HOST'; ExpectedGuest='Evidence1Runner';
      ActualVmId='12345678-1234-1234-1234-123456789abc'; ExpectedVmId='12345678-1234-1234-1234-123456789abc';
      Manufacturer='Microsoft Corporation'; Model='Virtual Machine'; User='Evidence1'; ExpectedUser='Evidence1' }
      $out = @(); Assert-E1GuestIdentity @good; $out += $true
      foreach ($key in @('ActualVmId','ComputerName','User','Model')) {
        $bad = $good.Clone(); $bad[$key] = 'wrong'; try { Assert-E1GuestIdentity @bad; $out += $false } catch { $out += $true }
      }
      $good.HostComputerName = 'Evidence1Runner'; try { Assert-E1GuestIdentity @good; $out += $false } catch { $out += $true }
      $out | ConvertTo-Json -Compress`)).toEqual([true, true, true, true, true, true]);
  });

  it('matches canonical attestation hash to readiness and validates freshness and every source anchor', () => {
    const setup = `$r = ${json(evidence.readiness)}; $l = ${json(evidence.ledger)}; $a = ${json(attestation)}
      $args = @{ Readiness=$r; Ledger=$l; Attestation=$a; VMName='Evidence1-Runner'; TargetCommit='${commit}'; TargetTree='${tree}';
        AttestationPath='C:\\kmp-eval\\measurement-scopes\\attestation.json'; NowUtc=[datetime]'2026-08-30T12:05:00Z' }`;
    expect(ps(`${setup}\nAssert-E1Evidence @args | ConvertTo-Json -Compress`)).toBe(hash);
    for (const mutate of [
      "$args.NowUtc = [datetime]'2026-08-30T13:05:01Z'", "$l.anchors.source_commit_actual = 'c' * 40",
      "$r.target_tree = 'c' * 40", "$a.ambient_secrets_present = 'false'",
      "$r.guest.attestation_sha256 = '0' * 64", "$a.expires_at = '2026-08-30T12:06:00Z'",
    ]) {
      expect(ps(`${setup}\n${mutate}\n$result = try { $null = Assert-E1Evidence @args; $false } catch { $true }; $result | ConvertTo-Json -Compress`)).toBe(true);
    }
  }, 40_000);

  it('persists an exclusive attempt marker and never retries a timeout for the same target', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-attempt-'));
    try {
      const result = ps(`$m = Get-Module evidence1-validation-ops
        & $m {
          param($dir)
          $script:calls = 0
          function Invoke-E1OwnedProcess { $script:calls++; return @{ ExitCode=1; TimedOut=$true; WallSeconds=300; CleanupOk=$true } }
          $params = @{ Directory=$dir; TargetCommit='${commit}'; TargetTree='${tree}'; Node='synthetic'; EntryPoint='synthetic'; SourceDir='synthetic' }
          $first = Invoke-E1WetAttempt @params
          $second = Invoke-E1WetAttempt @params
          @{ first=$first; second=$second; calls=$script:calls; persisted=(Get-Content -LiteralPath (Join-Path $dir 'wet-v2-${commit}.json') -Raw | ConvertFrom-Json) } | ConvertTo-Json -Depth 8 -Compress
        } ${quote(dir)}`);
      expect(result.calls).toBe(1);
      expect(result.first.failure_code).toBe('product_timeout');
      expect(result.second.failure_code).toBe('attempt_exists');
      expect(result.persisted.state).toBe('failed');
      expect(result.persisted.failure_code).toBe('product_timeout');
      expect(result.first.agent_calls).toBe(0);
      expect(JSON.stringify(result)).not.toContain('synthetic');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts exactly the two v2 single-cell plans and rejects crossed arms and coercible fields', () => {
    const result = ps(`$plans = ${json([dryPlan(true), dryPlan(false)])}
      $out = @()
      foreach ($p in $plans) {
        $checks = Get-E1DryChecks $p $p.campaign_design_id '${hash}' '${profileHash}'; $out += -not ($checks.Values -contains $false)
        $p.plan[0].product_access_mode = 'product-visible-no-skill'
        $checks = Get-E1DryChecks $p $p.campaign_design_id '${hash}' '${profileHash}'; $out += -not ($checks.Values -contains $false)
      }
      $out | ConvertTo-Json -Compress`);
    expect(result).toEqual([true, false, true, false]);
    for (const mutation of [
      p => { p.planned_sessions = '1'; }, p => { p.dry_run = 'true'; }, p => { p.repeats = 4; },
      p => { p.plan.push(p.plan[0]); }, p => { p.scenario_id = 'coverage-threshold-failure'; },
      p => { p.plan = p.plan[0]; },
      p => { p.plan[0].execution_profile_isolation_attestation_sha256 = '0'.repeat(64); },
    ]) {
      const plan = dryPlan(true); mutation(plan);
      expect(Object.values(ps(`Get-E1DryChecks (${json(plan)}) 'claude-product-canary-v1' '${hash}' '${profileHash}' | ConvertTo-Json -Compress`))).toContain(false);
    }
  }, 40_000);

  it('computes the profile hash from the real registry exactly as the harness does', () => {
    expect(ps(`Get-E1ProfileHash (${json(registry)}) | ConvertTo-Json -Compress`)).toBe(profileHash);
    const drift = structuredClone(registry);
    drift.execution_profiles.find(profile => profile.id === 'sandboxed-unrestricted-v1').policy_mode = 'required';
    expect(ps(`$ok = try { $null=Get-E1ProfileHash (${json(drift)}); $false } catch { $true }; $ok | ConvertTo-Json -Compress`)).toBe(true);
  });

  it('dispatches exactly one dry plan per real design, validates both complete outputs and refuses a repeat', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-dry-'));
    try {
      const result = ps(`$m=Get-Module evidence1-validation-ops
        & $m {
          param($dir, $planText)
          $script:plans=ConvertFrom-E1Json $planText; $script:invocations=@()
          function Invoke-E1OwnedProcess {
            param($exe, $arguments, $cwd, $stdout, $stderr, $seconds)
            $script:invocations+=,@($arguments)
            [IO.File]::WriteAllText($stderr, '')
            return @{ExitCode=0;TimedOut=$false;WallSeconds=1;CleanupOk=$true}
          }
          function Read-E1Json([string]$path) {
            $index=if($path.Contains('free-baseline')) {1} else {0}
            return @{value=$script:plans[$index];sha256=('d'*64)}
          }
          $hashes=@{}
          foreach($k in @('readiness_sha256','ledger_sha256','attestation_sha256','validation_module_sha256','scenario_sha256','product_entry_sha256','execution_profile_registry_sha256')) { $hashes[$k]='a'*64 }
          $hashes.attestation_canonical_sha256='${hash}'; $hashes.execution_profile_sha256='${profileHash}'
          $r=Invoke-E1DryAttempt $dir '${commit}' '${tree}' 'synthetic' 'synthetic' 'synthetic' 'synthetic' $hashes
          $pending=Get-Content -LiteralPath (Join-Path $dir 'dry-v3-${commit}.json') -Raw | ConvertFrom-Json
          $r.checks.preflight=$true; $r.checks.guest_identity=$true; $r.checks.module_target=$true
          $r=Complete-E1Attempt $r $dir { param($record); Set-E1RecordsCheck $record @{keys=@();sha256=('b'*64)} @{keys=@();sha256=('b'*64)} }
          $safe=ConvertTo-E1SafeResult $r 'dry-v3' '${commit}' '${tree}'
          $repeat=Invoke-E1DryAttempt $dir '${commit}' '${tree}' 'synthetic' 'synthetic' 'synthetic' 'synthetic' $hashes
          $missing=@()
          foreach($key in @($r.checks.Keys)) {
            $r.checks.Remove($key); try { $null=ConvertTo-E1SafeResult $r 'dry-v3' '${commit}' '${tree}'; $missing+=$false } catch { $missing+=$true }; $r.checks[$key]=$true
          }
          $argvOk=$true
          foreach($arguments in $script:invocations) {
            if(@($arguments | Where-Object {$_ -ceq '--dry-run'}).Count -ne 1 -or
              $arguments[$arguments.IndexOf('--scenario')+1] -cne 'coverage-threshold-failure-v2') {$argvOk=$false}
          }
          @{ pending=$pending.state; final=$safe.state; calls=$script:invocations.Count; argv_ok=$argvOk;
            repeat=$repeat.failure_code; missing_rejected=($missing -notcontains $false) } | ConvertTo-Json -Compress
        } ${quote(dir)} ${quote(JSON.stringify([dryPlan(true), dryPlan(false)]))}`);
      expect(result).toEqual({ pending: 'started', final: 'passed', calls: 2, argv_ok: true, repeat: 'attempt_exists', missing_rejected: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses open live handoffs even when no live process has started yet', () => {
    expect(ps(`$r = ${json(evidence.readiness)}
      $out = @(); Assert-E1NoLiveCustody $null $null $null 'Evidence1-Runner' $r; $out += $true
      $handoff = [pscustomobject]@{ state='armed'; vm_name='Evidence1-Runner' }
      try { Assert-E1NoLiveCustody $null $null $handoff 'Evidence1-Runner' $r; $out += $false } catch { $out += $true }
      $out | ConvertTo-Json -Compress`)).toEqual([true, true]);
  });

  it('treats owned-tree cleanup failure as terminal failure, never a passing envelope', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-cleanup-'));
    try {
      const result = ps(`$m = Get-Module evidence1-validation-ops
        & $m {
          param($dir, $text)
          $script:envelopeText = $text
          function Invoke-E1OwnedProcess {
            param($exe, $args, $cwd, $stdout, $stderr, $seconds)
            [IO.File]::WriteAllText($stdout, $script:envelopeText)
            return @{ ExitCode=1; TimedOut=$false; WallSeconds=1; CleanupOk=$false }
          }
          Invoke-E1WetAttempt $dir '${commit}' '${tree}' 'synthetic' 'synthetic' 'synthetic' | ConvertTo-Json -Depth 8 -Compress
        } ${quote(dir)} ${quote(JSON.stringify(envelope))}`);
      expect(result.state).toBe('failed');
      expect(result.checks.owned_tree_stopped).toBe(false);
      expect(result.checks.tool).toBe(true);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never publishes a passing terminal before postflight and keeps snapshot failures unknown', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-postflight-'));
    try {
      const result = ps(`$m = Get-Module evidence1-validation-ops
        & $m {
          param($dir, $text)
          $script:text = $text
          function Invoke-E1OwnedProcess {
            param($exe, $arguments, $cwd, $stdout, $stderr, $seconds)
            [IO.File]::WriteAllText($stdout, $script:text)
            return @{ ExitCode=1; TimedOut=$false; WallSeconds=1; CleanupOk=$true }
          }
          $r = Invoke-E1WetAttempt $dir '${commit}' '${tree}' 'synthetic' 'synthetic' 'synthetic'
          $path = Join-Path $dir 'wet-v2-${commit}.json'
          $before = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
          $failed = Complete-E1Attempt $r $dir { throw 'repo_dirty' }
          $after = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
          @{ before=$before; returned=$failed; after=$after } | ConvertTo-Json -Depth 8 -Compress
        } ${quote(dir)} ${quote(JSON.stringify(envelope))}`);
      expect(result.before.state).toBe('started');
      expect(result.before.failure_code).toBe('postflight_pending');
      expect(result.before.live_records_created).toBeNull();
      expect(result.after.state).toBe('failed');
      expect(result.after.failure_code).toBe('repo_dirty');
      expect(result.after.live_records_created).toBeNull();
      expect(result.after).toEqual(result.returned);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('counts record additions by key even when deletion hides them in a net file count', () => {
    expect(ps(`$r = New-E1Result 'dry-v3' '${commit}' '${tree}'
      try { Set-E1RecordsCheck $r @{ keys=@('old'); sha256=('a'*64) } @{ keys=@('new'); sha256=('b'*64) } } catch { }
      $r.live_records_created | ConvertTo-Json -Compress`)).toBe(1);
  });

  it('sets the no-daemon override only for the product call and restores it after an exception', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-env-'));
    try {
      expect(ps(`$m = Get-Module evidence1-validation-ops
        & $m {
          param($dir)
          $env:GRADLE_OPTS='previous-value'
          function Invoke-E1OwnedProcess {
            $script:during = $env:GRADLE_OPTS
            throw 'process_create'
          }
          $r=Invoke-E1WetAttempt $dir '${commit}' '${tree}' 'synthetic' 'synthetic' 'synthetic'
          @{ during=$script:during; restored=($env:GRADLE_OPTS -ceq 'previous-value'); failure_code=$r.failure_code } | ConvertTo-Json -Compress
        } ${quote(dir)}`)).toEqual({ during: '-Dorg.gradle.daemon=false', restored: true, failure_code: 'process_create' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires every wet success check and hash, rejects null counters and preserves safe error codes', () => {
    expect(ps(`$r = New-E1Result 'wet-v2' '${commit}' '${tree}'
      $r.state='passed'; $r.stage='complete'; $r.failure_code='none'; $r.product_invocations=1; $r.live_records_created=0
      Set-E1ProcessObservation $r 'product' @{ExitCode=1;WallSeconds=1;TimedOut=$false;CleanupOk=$true}
      $r.checks=Get-E1WetChecks (${json(envelope)}) 1 1
      foreach($k in @('guest_identity','preflight','postflight','module_target','gradle_daemon_disabled','owned_tree_stopped','not_timed_out')) { $r.checks[$k]=$true }
      foreach($k in @('readiness_sha256','ledger_sha256','attestation_sha256','attestation_canonical_sha256','validation_module_sha256','scenario_sha256','product_entry_sha256','product_stdout_sha256','records_metadata_before_sha256','records_metadata_after_sha256','execution_profile_sha256','execution_profile_registry_sha256')) { $r.hashes[$k]='a'*64 }
      $good=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'
      $out=@($good.state -ceq 'passed')
      foreach($k in @($r.checks.Keys)) {
        $r.checks.Remove($k); try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }; $r.checks[$k]=$true
      }
      foreach($k in @($r.hashes.Keys)) {
        $r.hashes.Remove($k); try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }; $r.hashes[$k]='a'*64
      }
      $metrics=$r.processes.product; $r.processes.product=$null
      try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }
      $r.processes.product=$metrics
      foreach($bad in @(@('exit_code',3),@('timed_out',$true),@('cleanup_ok',$false),@('wall_seconds',301))) {
        $old=$metrics[$bad[0]]; $metrics[$bad[0]]=$bad[1]
        try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }
        $metrics[$bad[0]]=$old
      }
      $r.live_records_created=$null
      try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }
      $codes=@(); foreach($message in @('repo_dirty','SECRET /private/path repo_dirty')) { try { throw $message } catch { $codes += Get-E1FailureCode $_ } }
      @{ checks=$out; codes=$codes } | ConvertTo-Json -Compress`))
      .toEqual({ checks: Array(42).fill(true), codes: ['repo_dirty', 'preflight_failed'] });
  });

  it('checks the received module bytes before evaluating any code', () => {
    expect(ps(`$receiver=Get-E1ReceiverScript
      try { & $receiver "throw 'PRIVATE_MODULE_EXECUTED'" @{} $null ('0'*64) ('1'*64) } catch { Get-E1FailureCode $_ | ConvertTo-Json -Compress }`)).toBe('module_hash_mismatch');
  });

  it('rejects guest identity before any guest filesystem or process mutation', () => {
    expect(ps(`$m=Get-Module evidence1-validation-ops
      & $m {
        function Get-CimInstance { return @{Manufacturer='Not Microsoft';Model='Host'} }
        function Get-ItemPropertyValue { return '12345678-1234-1234-1234-123456789abc' }
        function New-Item { throw 'PRIVATE_MUTATION' }
        function Invoke-E1OwnedProcess { throw 'PRIVATE_PROCESS' }
        $c=@{Operation='wet-v2';TargetCommit='${commit}';TargetTree='${tree}';HostComputerName='host';GuestComputerName='guest';VMId='12345678-1234-1234-1234-123456789abc';GuestUser='Evidence1'}
        $r=Invoke-E1GuestValidation $c $null ('0'*64) ('0'*64)
        @{ code=$r.failure_code; stage=$r.stage; invocations=$r.product_invocations; live_records=$r.live_records_created } | ConvertTo-Json -Compress
      }`)).toEqual({ code: 'guest_identity', stage: 'guest_identity', invocations: 0, live_records: null });
  });

  it.skipIf(process.platform !== 'win32')('overwrites a stale PASS and emits only a safe bootstrap failure for missing or corrupt modules', () => {
    for (const kind of ['wet-gate-v2', 'canary-dryrun-v3']) {
      for (const corrupt of [false, true]) {
        const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-bootstrap-'));
        const name = `evidence1-hyperv-verify-${kind}-direct.ps1`;
        const script = resolve(dir, name);
        const reportRoot = `C:/kmp-eval/scratch/hyperv-verify-${kind}-direct`;
        const report = resolve(reportRoot, `selftest-${randomUUID()}.json`);
        try {
          mkdirSync(reportRoot, { recursive: true });
          writeFileSync(report, JSON.stringify({ state: 'passed' }));
          writeFileSync(script, readFileSync(resolve(root, 'docs/audits', name)));
          if (corrupt) writeFileSync(resolve(dir, 'evidence1-validation-ops.psm1'), "throw 'PRIVATE_MODULE_FAILURE'");
          const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-TargetCommit', commit, '-TargetTree', tree, '-ReportPath', report], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
          expect(run.status).toBe(1); expect(run.stderr).toBe('');
          expect(JSON.parse(run.stdout).failure_code).toBe('module_import_failed');
          expect(JSON.parse(readFileSync(report, 'utf8')).state).toBe('failed');
          expect(run.stdout).not.toContain('PRIVATE');
        } finally { rmSync(dir, { recursive: true, force: true }); rmSync(report, { force: true }); }
      }
    }
  }, 40_000);

  it.skipIf(process.platform !== 'win32')('contains timeout descendants in its own Windows job without killing unrelated processes', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-job-'));
    const fixture = resolve(dir, 'fixture.cjs');
    writeFileSync(fixture, `const {spawn} = require('node:child_process');
      const child=spawn(process.execPath,['-e',\`const {spawn}=require('node:child_process');
        const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        process.stdout.write(JSON.stringify({child:process.pid,grandchild:grandchild.pid})); setInterval(()=>{},1000);\`],{stdio:['ignore','pipe','ignore']});
      child.stdout.pipe(process.stdout);
      process.stderr.write('PRIVATE_STDERR'); setInterval(()=>{},1000);`);
    try {
      const result = ps(`$m = Get-Module evidence1-validation-ops
        & $m {
          param($dir, $node, $fixture)
          $unrelated = [Diagnostics.Process]::Start([Diagnostics.ProcessStartInfo]@{ FileName=$node; Arguments='-e "setInterval(()=>{},1000)"'; UseShellExecute=$false; CreateNoWindow=$true })
          try {
            $r = Invoke-E1OwnedProcess $node @($fixture) $dir (Join-Path $dir 'stdout.json') (Join-Path $dir 'stderr.txt') 1
            $descendants = Get-Content -LiteralPath (Join-Path $dir 'stdout.json') -Raw | ConvertFrom-Json
            @{ timed_out=$r.TimedOut; cleaned=$r.CleanupOk; child_alive=($null -ne (Get-Process -Id $descendants.child -ErrorAction SilentlyContinue));
              grandchild_alive=($null -ne (Get-Process -Id $descendants.grandchild -ErrorAction SilentlyContinue)); unrelated_alive=(-not $unrelated.HasExited) } | ConvertTo-Json -Compress
          } finally { if (-not $unrelated.HasExited) { $unrelated.Kill(); $unrelated.WaitForExit() }; $unrelated.Dispose() }
        } ${quote(dir)} ${quote(process.execPath)} ${quote(fixture)}`);
      expect(result).toEqual({ timed_out: true, cleaned: true, child_alive: false, grandchild_alive: false, unrelated_alive: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it.skipIf(process.platform !== 'win32')('captures exit 1 privately and cleans descendants after the original process exits normally', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-validation-normal-'));
    const fixture = resolve(dir, 'fixture.cjs');
    writeFileSync(fixture, `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',\`const {spawn}=require('node:child_process');
        const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        process.stdout.write(JSON.stringify({child:process.pid,grandchild:grandchild.pid})); setInterval(()=>{},1000);\`],{stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',data=>{process.stdout.write(data);process.stderr.write('PRIVATE_STDERR');process.exit(1)});`);
    try {
      expect(ps(`$r = Invoke-E1OwnedProcess ${quote(process.execPath)} @(${quote(fixture)}) ${quote(dir)} ${quote(resolve(dir, 'stdout.json'))} ${quote(resolve(dir, 'stderr.txt'))} 5
        $ids = Get-Content -LiteralPath ${quote(resolve(dir, 'stdout.json'))} -Raw | ConvertFrom-Json
        @{ exit_code=$r.ExitCode; timed_out=$r.TimedOut; cleaned=$r.CleanupOk;
          child_alive=($null -ne (Get-Process -Id $ids.child -ErrorAction SilentlyContinue));
          grandchild_alive=($null -ne (Get-Process -Id $ids.grandchild -ErrorAction SilentlyContinue));
          stderr_captured=([IO.File]::ReadAllText(${quote(resolve(dir, 'stderr.txt'))}) -ceq 'PRIVATE_STDERR') } | ConvertTo-Json -Compress`))
        .toEqual({ exit_code: 1, timed_out: false, cleaned: true, child_alive: false, grandchild_alive: false, stderr_captured: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it.skipIf(process.platform !== 'win32')('parses the entrypoints and compiles the native helper in Windows PowerShell 5.1', () => {
    const paths = [modulePath, ...['wet-gate-v2', 'canary-dryrun-v3'].map(kind => resolve(root, `docs/audits/evidence1-hyperv-verify-${kind}-direct.ps1`))];
    expect(ps(`Initialize-E1ProcessJob
      $count=0
      foreach($path in @(${paths.map(quote).join(',')})) {
        $tokens=$null; $errors=$null
        $null=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
        $count+=$errors.Count
      }
      @{ parse_errors=$count; profile_hash=(Get-E1ProfileHash (${json(registry)})) } | ConvertTo-Json -Compress`, 'powershell.exe'))
      .toEqual({ parse_errors: 0, profile_hash: profileHash });
  }, 40_000);
});
