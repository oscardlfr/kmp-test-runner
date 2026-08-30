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
    // Isolate only this PS5.1 child from a host application's bundled PS7 modules.
    env: shell === 'powershell.exe'
      ? { ...process.env, PSModulePath: resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') }
      : process.env,
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
function sourceFixture(extra = {}) {
  const dir = mkdtempSync('C:/kmp-eval/scratch/e1-contract-source-');
  const repo = resolve(dir, 'repo');
  const scratch = resolve(dir, 'ops');
  mkdirSync(repo); mkdirSync(scratch);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('config', 'core.autocrlf', 'false');
  for (const [name, text] of Object.entries({ '.gitignore': 'build/\n.gradle/\n', 'source.txt': 'tracked\n', ...extra })) {
    const file = resolve(repo, name); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, text);
  }
  git('add', '.'); git('commit', '-qm', 'fixture');
  return { dir, repo, scratch, git, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}
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

  it('rejects non-string report enums and refuses mutation of historical schema1 diagnostics', () => {
    expect(ps(`$r=New-E1Result 'wet-v2' '${commit}' '${tree}'; $out=@()
      foreach($key in @('state','stage','failure_code')) {
        $old=$r[$key]
        foreach($bad in @(@($old),1,$false,$null,$old.ToUpperInvariant())) {
          $r[$key]=$bad
          try { $null=ConvertTo-E1SafeResult $r 'wet-v2' '${commit}' '${tree}'; $out+=$false } catch { $out+=$true }
        }
        $r[$key]=$old
      }
      $r.schema=1; $r.Remove('failures'); $r.Remove('processes')
      try { Set-E1Failure $r 'transport' 'readiness_changed'; $out+=$false } catch { $out+=((Get-E1FailureCode $_) -ceq 'result_shape') }
      $out | ConvertTo-Json -Compress`)).toEqual(Array(16).fill(true));
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

  it.skipIf(process.platform !== 'win32')('permits only bounded generated source artifacts without changing tracked or index content', () => {
    const f = sourceFixture();
    try {
      const result = ps(`$repo=${quote(f.repo)}; $scratch=${quote(f.scratch)}
        $before=Get-E1SourceSnapshot $repo '${f.commit}' '${f.tree}' $scratch
        $paths=@('.kmp-test-runner/cache/model-${'a'.repeat(40)}.json','.kmp-test-runner/cache/tasks-${'a'.repeat(40)}.txt',
          '.kmp-test-runner/reports/coverage/20260830-120000-123456.md','.kmp-test-runner/reports/coverage/latest.md')
        foreach($path in $paths) { $file=Join-Path $repo $path; $null=New-Item -ItemType Directory -Force (Split-Path -Parent $file); [IO.File]::WriteAllText($file,'synthetic') }
        $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before
        $diff=(& git -C $repo diff HEAD)
        @{passed=$true;tracked_unchanged=(-not $diff)} | ConvertTo-Json -Compress`);
      expect(result).toEqual({ passed: true, tracked_unchanged: true });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('rejects unexpected source files, malformed artifact names and excessive generated sets', () => {
    const f = sourceFixture();
    try {
      const result = ps(`$repo=${quote(f.repo)}; $scratch=${quote(f.scratch)}
        $before=Get-E1SourceSnapshot $repo '${f.commit}' '${f.tree}' $scratch
        $out=@()
        foreach($name in @('unexpected.txt','.kmp-test-runner.lock','.kmp-test-runner/config.json',
          '.kmp-test-runner/cache/model-wrong.json','.kmp-test-runner/cache/model-${'a'.repeat(40)}.json.tmp.12',
          '.kmp-test-runner/reports/coverage/synthetic.md','.kmp-test-runner/logs/android/anything.log')) {
          $path=Join-Path $repo $name; $null=New-Item -ItemType Directory -Force (Split-Path -Parent $path); [IO.File]::WriteAllText($path,'synthetic')
          try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before; $out+=$false } catch { $out+=$true }
          Remove-Item -LiteralPath $path
        }
        $runtime=[IO.Path]::GetFullPath((Join-Path $repo '.kmp-test-runner'))
        if(-not $runtime.StartsWith([IO.Path]::GetFullPath($repo) + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {throw 'fixture_path'}
        Remove-Item -LiteralPath $runtime -Recurse -Force
        $cache=Join-Path $runtime 'cache'; $null=New-Item -ItemType Directory -Force $cache
        foreach($hash in @(('a'*40),('b'*40))) { [IO.File]::WriteAllText((Join-Path $cache "model-$hash.json"),'synthetic') }
        try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before; $out+=$false } catch { $out+=$true }
        $out | ConvertTo-Json -Compress`);
      expect(result).toEqual(Array(8).fill(true));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('accepts V2 artifacts in V3 but forbids any dry-run artifact mutation', () => {
    const f = sourceFixture();
    try {
      const result = ps(`$repo=${quote(f.repo)}; $scratch=${quote(f.scratch)}
        $cache=Join-Path $repo '.kmp-test-runner/cache'; $null=New-Item -ItemType Directory -Force $cache
        $path=Join-Path $cache 'model-${'a'.repeat(40)}.json'; [IO.File]::WriteAllText($path,'before')
        $before=Get-E1SourceSnapshot $repo '${f.commit}' '${f.tree}' $scratch
        $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before -Operation 'dry-v3'
        $out=@($true)
        $stamp=(Get-Item -LiteralPath $path).LastWriteTimeUtc
        [IO.File]::WriteAllText($path,'mutate'); [IO.File]::SetLastWriteTimeUtc($path,$stamp)
        try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before -Operation 'dry-v3'; $out+=$false } catch { $out+=((Get-E1FailureCode $_) -ceq 'source_artifacts') }
        [IO.File]::WriteAllText($path,'before'); [IO.File]::SetLastWriteTimeUtc($path,$stamp)
        $new=Join-Path $cache 'tasks-${'a'.repeat(40)}.txt'; [IO.File]::WriteAllText($new,'synthetic')
        try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before -Operation 'dry-v3'; $out+=$false } catch { $out+=((Get-E1FailureCode $_) -ceq 'source_artifacts') }
        Remove-Item -LiteralPath $new
        $null=New-Item -ItemType Directory -Force (Join-Path $repo '.kmp-test-runner/reports')
        try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before -Operation 'dry-v3'; $out+=$false } catch { $out+=((Get-E1FailureCode $_) -ceq 'source_artifacts') }
        Remove-Item -LiteralPath (Join-Path $repo '.kmp-test-runner/reports')
        Remove-Item -LiteralPath $path
        try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before -Operation 'dry-v3'; $out+=$false } catch { $out+=((Get-E1FailureCode $_) -ceq 'source_artifacts') }
        $out | ConvertTo-Json -Compress`);
      expect(result).toEqual(Array(5).fill(true));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('runs guest V3 after V2 artifacts and rechecks evidence after the Java probe before wet dispatch', () => {
    const f = sourceFixture();
    try {
      const result = ps(`$m=Get-Module evidence1-validation-ops
        & $m {
          param($repo,$scratch,$sourceCommit)
          $script:E1SourceCommit=$sourceCommit
          $cache=Join-Path $repo '.kmp-test-runner/cache'; $null=New-Item -ItemType Directory -Force $cache
          [IO.File]::WriteAllText((Join-Path $cache 'model-${'a'.repeat(40)}.json'),'synthetic V2 artifact')
          function Get-CimInstance { @{Manufacturer='Microsoft Corporation';Model='Virtual Machine'} }
          function Get-ItemPropertyValue { '12345678-1234-1234-1234-123456789abc' }
          function Assert-E1GuestIdentity { }
          function Resolve-E1Path($Path,$Root) {
            if($Path -ceq 'C:\\kmp-eval\\scratch\\evidence1-validation-ops') { return $scratch }
            return $Path.Replace('/','\\')
          }
          function Assert-E1NoGuestLive { }
          $script:expired=$false
          function Assert-E1Evidence { if($script:expired) { throw 'attestation_expiry' }; 'f'*64 }
          function Read-E1Json { @{value=@{id='coverage-threshold-failure-v2';project_commit=$sourceCommit};sha256=('f'*64)} }
          function Get-E1ProfileHash { 'f'*64 }
          function Get-FileHash { @{Hash=('f'*64)} }
          function Assert-E1Repo($Root) { if($Root -ieq $repo.Replace('/','\\')) { throw 'repo_dirty' } }
          function Get-E1RecordsSnapshot { @{sha256=('f'*64);keys=@()} }
          function Invoke-E1OwnedProcess { throw 'UNEXPECTED_EXECUTABLE' }
          function Invoke-E1Git($Root,$Arguments) {
            $text=& 'C:\\Program Files\\Git\\cmd\\git.exe' --no-optional-locks -C $Root @Arguments
            if($LASTEXITCODE -ne 0) { throw 'git_failed' }; return ($text -join "\n").Trim()
          }
          function Invoke-E1DryAttempt($Directory,$TargetCommit,$TargetTree) {
            $r=New-E1Result 'dry-v3' $TargetCommit $TargetTree; $r.state='validated'
            [IO.File]::WriteAllText((Join-Path $Directory "dry-v3-$TargetCommit.json"),'{}')
            if($script:mutate) { [IO.File]::WriteAllText((Join-Path $cache 'tasks-${'a'.repeat(40)}.txt'),'unexpected dry artifact') }
            return $r
          }
          $c=@{Operation='dry-v3';TargetCommit='${commit}';TargetTree='${tree}';HostComputerName='host';GuestComputerName='guest';VMId='12345678-1234-1234-1234-123456789abc';GuestUser='Evidence1';HarnessDir=(Join-Path $scratch 'harness');NowInAndroidDir=$repo;AttestationFile=(Join-Path $scratch 'attestation.json');VMName='guest'}
          $out=@(); $script:mutate=$false
          foreach($mutate in @($false,$true)) {
            $script:mutate=$mutate
            $r=Invoke-E1GuestValidation $c $null ('f'*64) ('f'*64)
            $out+=@{state=$r.state;code=$r.failure_code;postflight=$r.failures.postflight}
            $marker=Join-Path $scratch 'dry-v3-${commit}.json'
            if(Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker }
          }
          function Get-E1Java21 { @{home=$scratch;executable=(Join-Path $scratch 'java.exe')} }
          function Invoke-E1OwnedProcess($Exe,$Arguments,$Cwd,$Stdout,$Stderr) {
            if($Arguments.Count -ne 1 -or $Arguments[0] -cne '-version') {throw 'UNEXPECTED_EXECUTABLE'}
            [IO.File]::WriteAllText($Stdout,''); [IO.File]::WriteAllText($Stderr,'openjdk version "21.0.8"')
            $script:expired=$true
            @{ExitCode=0;TimedOut=$false;CleanupOk=$true;WallSeconds=14}
          }
          $script:consumed=0
          function Invoke-E1WetAttempt {
            $script:consumed++
            $r=New-E1Result 'wet-v2' '${commit}' '${tree}'; $r.state='validated'; return $r
          }
          $c.Operation='wet-v2'
          $wet=Invoke-E1GuestValidation $c $null ('f'*64) ('f'*64)
          @{dry=$out;expired=@{consumed=$script:consumed;code=$wet.failure_code;stage=$wet.stage}} | ConvertTo-Json -Depth 5 -Compress
        } ${quote(f.repo)} ${quote(f.scratch)} '${f.commit}'`);
      expect(result).toEqual({
        dry: [
          { state: 'passed', code: 'none', postflight: null },
          { state: 'failed', code: 'source_artifacts', postflight: 'source_artifacts' },
        ],
        expired: { consumed: 0, code: 'attestation_expiry', stage: 'guest_toolchain' },
      });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('never exempts tracked artifacts or index changes, including assume-unchanged files', () => {
    const artifact = `.kmp-test-runner/cache/model-${'a'.repeat(40)}.json`;
    const f = sourceFixture({ [artifact]: 'tracked runtime file\n' });
    try {
      const result = ps(`$repo=${quote(f.repo)}; $scratch=${quote(f.scratch)}
        $before=Get-E1SourceSnapshot $repo '${f.commit}' '${f.tree}' $scratch
        & git -C $repo update-index --assume-unchanged -- '${artifact}'
        [IO.File]::WriteAllText((Join-Path $repo '${artifact}'),'changed')
        $out=@()
        try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before; $out+=$false } catch { $out+=$true }
        & git -C $repo update-index --no-assume-unchanged -- '${artifact}'
        & git -C $repo add -- '${artifact}'
        try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before; $out+=$false } catch { $out+=$true }
        $out | ConvertTo-Json -Compress`);
      expect(result).toEqual([true, true]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['assume-unchanged', 'skip-worktree'])('rejects preexisting hidden source edits under %s without altering the index', flag => {
    const f = sourceFixture();
    try {
      f.git('update-index', `--${flag}`, '--', 'source.txt');
      writeFileSync(resolve(f.repo, 'source.txt'), 'hidden edit');
      const before = f.git('ls-files', '-v', '--', 'source.txt');
      expect(ps(`$rejected=try { $null=Get-E1SourceSnapshot ${quote(f.repo)} '${f.commit}' '${f.tree}' ${quote(f.scratch)}; $false }
        catch { (Get-E1FailureCode $_) -ceq 'repo_dirty' }; $rejected | ConvertTo-Json -Compress`)).toBe(true);
      expect(f.git('ls-files', '-v', '--', 'source.txt')).toBe(before);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('accepts a 9 MiB task cache and enforces the real 64 MiB producer cap', () => {
    const f = sourceFixture();
    try {
      expect(ps(`$repo=${quote(f.repo)}; $scratch=${quote(f.scratch)}
        $before=Get-E1SourceSnapshot $repo '${f.commit}' '${f.tree}' $scratch
        $cache=Join-Path $repo '.kmp-test-runner/cache'; $null=New-Item -ItemType Directory -Force $cache
        $path=Join-Path $cache 'tasks-${'a'.repeat(40)}.txt'
        $stream=[IO.File]::Create($path); $stream.SetLength(9*1024*1024); $stream.Dispose()
        $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before
        $stream=[IO.File]::OpenWrite($path); $stream.SetLength(64*1024*1024); $stream.Dispose()
        $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before
        $stream=[IO.File]::OpenWrite($path); $stream.SetLength(64*1024*1024+1); $stream.Dispose()
        $bounded=try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before; $false }
          catch { (Get-E1FailureCode $_) -ceq 'source_artifact_limit' }
        $bounded | ConvertTo-Json -Compress`)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['pwsh', 'powershell.exe'])('fingerprints actual source and artifact bytes without Get-FileHash autoload in %s', shell => {
    const f = sourceFixture();
    try {
      expect(ps(`$m=Get-Module evidence1-validation-ops
        & $m {
          param($repo,$scratch)
          function Get-FileHash { throw 'AUTOLOAD_COLLISION' }
          $cache=Join-Path $repo '.kmp-test-runner/cache'; $null=New-Item -ItemType Directory -Force $cache
          $path=Join-Path $cache 'model-${'a'.repeat(40)}.json'; [IO.File]::WriteAllText($path,'before')
          $before=Get-E1SourceSnapshot $repo '${f.commit}' '${f.tree}' $scratch
          $stamp=(Get-Item -LiteralPath $path).LastWriteTimeUtc
          [IO.File]::WriteAllText($path,'mutate'); [IO.File]::SetLastWriteTimeUtc($path,$stamp)
          $rejected=try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before -Operation 'dry-v3'; $false }
          catch { (Get-E1FailureCode $_) -ceq 'source_artifacts' }
          $rejected | ConvertTo-Json -Compress
        } ${quote(f.repo)} ${quote(f.scratch)}`, shell)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('rejects linked runtime artifacts even when ignored by git and OS is absent', () => {
    const f = sourceFixture({ '.gitignore': '.kmp-test-runner/\n' });
    try {
      const result = ps(`$repo=${quote(f.repo)}; $scratch=${quote(f.scratch)}
        $env:OS=$null
        $before=Get-E1SourceSnapshot $repo '${f.commit}' '${f.tree}' $scratch
        $cache=Join-Path $repo '.kmp-test-runner/cache'; $null=New-Item -ItemType Directory -Force $cache
        $target=Join-Path $scratch 'unrelated'; [IO.File]::WriteAllText($target,'synthetic')
        $null=New-Item -ItemType HardLink -Path (Join-Path $cache 'model-${'a'.repeat(40)}.json') -Target $target
        $rejected=try { $null=Assert-E1SourcePostflight $repo '${f.commit}' '${f.tree}' $scratch $before; $false } catch { $true }
        $rejected | ConvertTo-Json -Compress`);
      expect(result).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('prepares and verifies JDK21 in the child environment before an attempt, then restores all scoped variables', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-contract-java-'));
    try {
      const result = ps(`$m=Get-Module evidence1-validation-ops
        & $m {
          param($dir)
          $script:java=Join-Path $dir 'java.exe'; [IO.File]::WriteAllText($script:java,'synthetic executable')
          function Get-E1Java21 { return @{home=$dir;executable=$script:java} }
          $oldHome=$env:JAVA_HOME; $oldPath=$env:PATH; $script:verified=$false
          function Invoke-E1OwnedProcess {
            param($exe,$arguments,$cwd,$stdout,$stderr,$seconds)
            if($exe -cne $script:java -or $env:JAVA_HOME -cne $dir -or $arguments.Count -ne 1 -or $arguments[0] -cne '-version') {throw 'wrong_invocation'}
            [IO.File]::WriteAllText($stdout,''); [IO.File]::WriteAllText($stderr,'openjdk version "21.0.8" 2025-07-15')
            $script:verified=$true; return @{ExitCode=0;WallSeconds=0.1;TimedOut=$false;CleanupOk=$true}
          }
          $seen=Invoke-E1Java21Environment $dir { param($java); @{verified=$script:verified;home=($env:JAVA_HOME -ceq $dir)} }
          try { Invoke-E1Java21Environment $dir {throw 'synthetic_failure'} } catch { }
          @{seen=$seen;restored=($env:JAVA_HOME -ceq $oldHome -and $env:PATH -ceq $oldPath)} | ConvertTo-Json -Compress
        } ${quote(dir)}`);
      expect(result).toEqual({ seen: { verified: true, home: true }, restored: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects missing or wrong Java before invoking the marker-owning action', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-contract-java-fail-'));
    try {
      expect(ps(`$m=Get-Module evidence1-validation-ops
        & $m {
          param($dir)
          $script:java=Join-Path $dir 'java.exe'; [IO.File]::WriteAllText($script:java,'synthetic executable')
          function Get-E1Java21 { return @{home=$dir;executable=$script:java} }
          function Invoke-E1OwnedProcess {
            param($exe,$arguments,$cwd,$stdout,$stderr,$seconds)
            [IO.File]::WriteAllText($stdout,''); [IO.File]::WriteAllText($stderr,'openjdk version "17.0.1"')
            return @{ExitCode=0;WallSeconds=0.1;TimedOut=$false;CleanupOk=$true}
          }
          $script:consumed=$false
          try { Invoke-E1Java21Environment $dir {$script:consumed=$true} } catch { $code=Get-E1FailureCode $_ }
          @{code=$code;consumed=$script:consumed} | ConvertTo-Json -Compress
        } ${quote(dir)}`)).toEqual({ code: 'java_toolchain', consumed: false });
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
          $r=Complete-E1Attempt $r $dir { param($record); $record.checks.source_integrity=$true; Set-E1RecordsCheck $record @{keys=@();sha256=('b'*64)} @{keys=@();sha256=('b'*64)} }
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
      foreach($k in @('guest_identity','preflight','postflight','module_target','gradle_daemon_disabled','owned_tree_stopped','not_timed_out','java21_verified','source_integrity')) { $r.checks[$k]=$true }
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
      .toEqual({ checks: Array(44).fill(true), codes: ['repo_dirty', 'preflight_failed'] });
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
