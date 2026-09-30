$script:repoRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:modulePath=Join-Path $script:repoRoot 'docs/audits/evidence1-dual-condition-canary-contract.psm1'
$script:launcherPath=Join-Path $script:repoRoot 'docs/audits/evidence1-dual-condition-canary-launch.ps1'
$script:fixtureHelper=Join-Path $script:repoRoot 'tests/pester/fixtures/Evidence1DualConditionRealEvidence.mjs'
Import-Module $script:modulePath -Force

BeforeAll {
  $script:repoRoot=(Get-Location).Path
  $script:launcherPath=Join-Path $script:repoRoot 'docs/audits/evidence1-dual-condition-canary-launch.ps1'
  $script:fixtureHelper=Join-Path $script:repoRoot 'tests/pester/fixtures/Evidence1DualConditionRealEvidence.mjs'
  $script:fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('e1-dual-ops-'+[guid]::NewGuid().ToString('N'))
  $fixtureJson=& node $script:fixtureHelper setup $script:fixtureRoot
  if($LASTEXITCODE-ne0){throw 'fixture_setup'}
  $script:fixture=$fixtureJson|ConvertFrom-Json
  $script:harnessRoot=Join-Path $script:fixtureRoot 'harness'
  & git.exe clone --quiet --no-hardlinks --no-checkout $script:repoRoot $script:harnessRoot
  if($LASTEXITCODE-ne0){throw 'fixture_harness_clone'}
  & git.exe -C $script:harnessRoot checkout --quiet --detach $script:fixture.harness_commit
  if($LASTEXITCODE-ne0){throw 'fixture_harness_checkout'}
  $harnessCommit=(& git.exe -C $script:harnessRoot rev-parse HEAD).Trim()
  $harnessTree=(& git.exe -C $script:harnessRoot rev-parse 'HEAD^{tree}').Trim()
  $harnessStatus=(& git.exe -C $script:harnessRoot status --porcelain=v1 --untracked-files=all)-join''
  if($LASTEXITCODE-ne0-or$harnessCommit-cne$script:fixture.harness_commit-or
    $harnessTree-cne$script:fixture.harness_tree-or$harnessStatus.Length-ne0){throw 'fixture_harness_identity'}
  $script:contextPath=Join-Path $script:fixtureRoot 'context.json'
  [IO.File]::WriteAllText($script:contextPath,$fixtureJson,[Text.UTF8Encoding]::new($false))
  $script:readinessPath=Join-Path $script:fixtureRoot 'READINESS.json'
  [IO.File]::WriteAllText($script:readinessPath,'{"generated_at_utc":"2026-09-11T10:00:00.000Z"}',[Text.UTF8Encoding]::new($false))
  $script:authPath=Join-Path $script:fixtureRoot 'remote-auth-final.json'
  [IO.File]::WriteAllText($script:authPath,'{"status":"passed"}',[Text.UTF8Encoding]::new($false))
  $script:fake=Join-Path $script:fixtureRoot 'fake-runtime.ps1'
  [IO.File]::WriteAllText($script:fake,@'
param([string]$OperationRoot,[string]$BindingPath,[int]$Ordinal,[string]$RunsRoot,[string]$SourceClone)
if(-not(Test-Path -LiteralPath (Join-Path (Join-Path $SourceClone '.git') 'HEAD'))){exit 31}
$journal=Join-Path $RunsRoot "agentic-eval-journal\slot-$Ordinal"
$null=New-Item -ItemType Directory -Path $journal -Force
[IO.File]::WriteAllText((Join-Path $journal 'fake-safe.json'),'{}',[Text.UTF8Encoding]::new($false))
& node $env:E1_DUAL_FIXTURE_HELPER write-private $env:E1_DUAL_FIXTURE_CONTEXT $BindingPath ([string]$Ordinal) $RunsRoot|Out-Null
exit $LASTEXITCODE
'@,[Text.UTF8Encoding]::new($false))
  $env:E1_DUAL_FIXTURE_HELPER=$script:fixtureHelper;$env:E1_DUAL_FIXTURE_CONTEXT=$script:contextPath
  $script:ledger='C:\Evidence1Ops\dual-condition-ledger'
  $null=New-Item -ItemType Directory -Path $script:ledger -Force
  $script:operations=@()
  $script:pairs=@()
  $script:deployedRoots=@()
  $script:testPair=[guid]::NewGuid().ToString('D')
  function Get-TestFileSha256([string]$Path){$stream=[IO.File]::OpenRead($Path);try{$sha=[Security.Cryptography.SHA256]::Create();try{return -join($sha.ComputeHash($stream)|ForEach-Object{$_.ToString('x2')})}finally{$sha.Dispose()}}finally{$stream.Dispose()}}
  function New-OpsFixture([string]$Arm,[string]$PairId,[string]$GroupId) {
    $operation=Get-Evidence1DualConditionCanaryOperationRoot $script:ledger $PairId $GroupId
    $script:operations+=$operation
    $script:pairs+=$PairId
    $null=[IO.Directory]::CreateDirectory($operation)
    $args=@{Arm=$Arm;LedgerRoot=$script:ledger;PairId=$PairId;GroupRunId=$GroupId;HarnessCommit=$script:fixture.harness_commit;
      HarnessTree=$script:fixture.harness_tree;SourceCommit=$script:fixture.source_commit;SourceTree=$script:fixture.source_tree;
      ClaudePlanSha256=$(if($Arm-eq'product'){$script:fixture.claude_product_plan_sha256}else{$script:fixture.claude_baseline_plan_sha256});
      CodexPlanSha256=$(if($Arm-eq'product'){$script:fixture.codex_product_plan_sha256}else{$script:fixture.codex_baseline_plan_sha256});
      ClaudeAttestationSha256=$script:fixture.claude_attestation_sha256;CodexAttestationSha256=$script:fixture.codex_attestation_sha256;
      ValidatorBundleManifest=Get-Evidence1DualConditionValidatorBundleManifest $script:harnessRoot;
      ProcessTimeoutSeconds=300;RemoteAuthMaxAgeMinutes=10080}
    if($Arm-eq'product'){$args.SkillSnapshotSha256=$script:fixture.skill_snapshot_sha256}
    $binding=New-Evidence1DualConditionCanaryBinding @args
    $null=Write-Evidence1DualConditionCanaryBinding $operation $binding
    return @{Root=$operation;Binding=$binding;Phrase=(Get-Evidence1DualConditionCanaryAuthorizationLiteral $operation)}
  }
}

AfterAll {
  Remove-Item Env:E1_DUAL_FIXTURE_HELPER,Env:E1_DUAL_FIXTURE_CONTEXT -ErrorAction SilentlyContinue
  foreach($path in @($script:fixtureRoot)) {if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}}
  foreach($path in $script:operations){if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}}
  foreach($pair in @($script:pairs|Select-Object -Unique)){$path=Join-Path $script:ledger "pairs\$pair";if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}}
  foreach($path in $script:deployedRoots){if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}}
}

Describe 'Evidence1 dual-condition operational launcher' {
  It 'executes four fake sessions across both counterbalanced arms with closed custody' {
    if (-not (Test-Path -LiteralPath 'C:\Evidence1Toolchain')) { Set-ItResult -Skipped -Because 'requires the provisioned Evidence1 guest toolchain' }
    $pairs=@(
      @{Arm='product';Pair=$script:testPair;Group=[guid]::NewGuid().ToString('D')},
      @{Arm='free-baseline';Pair=$script:testPair;Group=[guid]::NewGuid().ToString('D')}
    )
    $private=Join-Path $script:fixtureRoot 'private'
    foreach($item in $pairs){
      $op=New-OpsFixture $item.Arm $item.Pair $item.Group
      $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:launcherPath,'-Mode','FakeRuntime','-OperationRoot',$op.Root,
        '-AuthorizationPhrase',$op.Phrase,'-HarnessDir',$script:harnessRoot,'-SourceTemplateDir',$script:fixture.source,
        '-ClaudeAttestationFile',$script:fixture.claude_attestation_file,'-CodexAttestationFile',$script:fixture.codex_attestation_file,
        '-ReadinessPath',$script:readinessPath,'-RemoteAuthCanaryOperationId','6bf48fb8-5fe0-4cb5-9965-e9081705f8fc',
        '-PrivateRoot',$private,'-FakeRuntimeScript',$script:fake,'-TestMode')
      & powershell.exe @arguments | Out-Null
      $LASTEXITCODE | Should -Be 0
      $custody=Get-Content -LiteralPath (Join-Path $op.Root 'custody.json') -Raw|ConvertFrom-Json
      $custody.complete|Should -BeTrue
      $custody.sessions_consumed|Should -Be 2
      $custody.aggregated_across_runtimes|Should -BeFalse
      @($custody.slots|ForEach-Object runtime_id) -join ',' | Should -BeExactly (@($op.Binding.runtime_order)-join ',')
    }
  }

  It 'completes both provider dry-runs without consuming or claiming a session' {
    if (-not (Test-Path -LiteralPath 'C:\Evidence1Toolchain')) { Set-ItResult -Skipped -Because 'requires the provisioned Evidence1 guest toolchain' }
    $op=New-OpsFixture product ([guid]::NewGuid().ToString('D')) ([guid]::NewGuid().ToString('D'))
    $fakeBin=Join-Path $script:fixtureRoot 'dry-run-bin'
    $null=New-Item -ItemType Directory -Path $fakeBin
    $claudeSource=Get-Content -LiteralPath (Join-Path $script:repoRoot 'tests/fixtures/fake-claude-campaign-success/claude') -Raw
    $claudeSource=$claudeSource.Replace('\"model\":\"claude-sonnet-5-fake-resolved\"','\"model\":\"claude-sonnet-5\"').Replace('\"claude_code_version\":\"fake\"','\"claude_code_version\":\"2.1.238\"')
    [IO.File]::WriteAllText((Join-Path $fakeBin 'claude'),$claudeSource,[Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $script:repoRoot 'tests/fixtures/fake-codex-campaign-success/codex') -Destination (Join-Path $fakeBin 'codex')
    $priorPath=$env:PATH;$priorScenarios=$env:KMP_EVAL_SCENARIOS_DIR
    try {
      $env:PATH="$fakeBin;$priorPath";$env:KMP_EVAL_SCENARIOS_DIR=$script:fixture.scenarios
      $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:launcherPath,'-Mode','DryRun','-OperationRoot',$op.Root,
        '-HarnessDir',$script:harnessRoot,'-SourceTemplateDir',$script:fixture.source,
        '-ClaudeAttestationFile',$script:fixture.claude_attestation_file,'-CodexAttestationFile',$script:fixture.codex_attestation_file,
        '-ReadinessPath',$script:readinessPath,'-RemoteAuthCanaryOperationId','6bf48fb8-5fe0-4cb5-9965-e9081705f8fc',
        '-PrivateRoot',(Join-Path $script:fixtureRoot 'dry-private'),'-TestMode')
      $output=& powershell.exe @arguments | Out-String
      $LASTEXITCODE|Should -Be 0
      $result=$output|ConvertFrom-Json
      $result.inference_sessions_consumed|Should -Be 0
      @($result.plans).Count|Should -Be 2
      Test-Path -LiteralPath (Join-Path $op.Root 'group.claim.json')|Should -BeFalse
    } finally {
      $env:PATH=$priorPath
      if($null-eq$priorScenarios){Remove-Item Env:KMP_EVAL_SCENARIOS_DIR -ErrorAction SilentlyContinue}else{$env:KMP_EVAL_SCENARIOS_DIR=$priorScenarios}
    }
  }

  It 'stops on readiness drift before any session claim' {
    $op=New-OpsFixture product ([guid]::NewGuid().ToString('D')) ([guid]::NewGuid().ToString('D'))
    $prior=[IO.File]::ReadAllBytes($script:readinessPath)
    try {
      [IO.File]::AppendAllText($script:readinessPath,"`n",[Text.UTF8Encoding]::new($false))
      $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:launcherPath,'-Mode','FakeRuntime','-OperationRoot',$op.Root,
        '-AuthorizationPhrase',$op.Phrase,'-HarnessDir',$script:harnessRoot,'-SourceTemplateDir',$script:fixture.source,
        '-ClaudeAttestationFile',$script:fixture.claude_attestation_file,'-CodexAttestationFile',$script:fixture.codex_attestation_file,
        '-ReadinessPath',$script:readinessPath,'-RemoteAuthCanaryOperationId','6bf48fb8-5fe0-4cb5-9965-e9081705f8fc',
        '-PrivateRoot',(Join-Path $script:fixtureRoot 'readiness-drift-private'),'-FakeRuntimeScript',$script:fake,'-TestMode')
      & powershell.exe @arguments 2>$null | Out-Null
      $LASTEXITCODE|Should -Not -Be 0
      Test-Path -LiteralPath (Join-Path $op.Root 'group.claim.json')|Should -BeFalse
      Test-Path -LiteralPath (Join-Path $op.Root 'slots/0/claim.json')|Should -BeFalse
    } finally {[IO.File]::WriteAllBytes($script:readinessPath,$prior)}
  }

  It 'rejects a valid but wrong attestation before any claim or contained spawn' {
    $op=New-OpsFixture product ([guid]::NewGuid().ToString('D')) ([guid]::NewGuid().ToString('D'))
    $private=Join-Path $script:fixtureRoot 'wrong-attestation-private'
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:launcherPath,'-Mode','FakeRuntime','-OperationRoot',$op.Root,
      '-AuthorizationPhrase',$op.Phrase,'-HarnessDir',$script:harnessRoot,'-SourceTemplateDir',$script:fixture.source,
      '-ClaudeAttestationFile',$script:fixture.codex_attestation_file,'-CodexAttestationFile',$script:fixture.codex_attestation_file,
      '-ReadinessPath',$script:readinessPath,'-RemoteAuthCanaryOperationId','6bf48fb8-5fe0-4cb5-9965-e9081705f8fc',
      '-PrivateRoot',$private,'-FakeRuntimeScript',$script:fake,'-TestMode')
    & powershell.exe @arguments 2>$null|Out-Null
    $LASTEXITCODE|Should -Not -Be 0
    Test-Path -LiteralPath (Join-Path $script:ledger "pairs\$($op.Binding.pair_id)\product.claim.json")|Should -BeFalse
    foreach($name in @('authorization.claim.json','group.claim.json','slots/0/claim.json','slots/0/dispatch.started.json')){Test-Path -LiteralPath (Join-Path $op.Root $name)|Should -BeFalse}
    Test-Path -LiteralPath $private|Should -BeFalse
  }

  It 'burns a slot claim on crash and rejects replay without respawn' {
    $op=New-OpsFixture product ([guid]::NewGuid().ToString('D')) ([guid]::NewGuid().ToString('D'))
    $null=New-Evidence1DualConditionCanaryAuthorizationClaim $op.Root $op.Phrase
    $null=New-Evidence1DualConditionCanaryGroupClaim $op.Root
    $null=New-Evidence1DualConditionCanarySlotClaim $op.Root 0
    {New-Evidence1DualConditionCanarySlotClaim $op.Root 0}|Should -Throw
    {New-Evidence1DualConditionCanaryPlanClaim $op.Root 1}|Should -Throw
  }

  It 'recovers a contained dispatch crash into immutable incomplete custody without respawn' {
    if (-not (Test-Path -LiteralPath 'C:\Evidence1Toolchain')) { Set-ItResult -Skipped -Because 'requires the provisioned Evidence1 guest toolchain' }
    $op=New-OpsFixture product ([guid]::NewGuid().ToString('D')) ([guid]::NewGuid().ToString('D'))
    $crashRuntime=Join-Path $script:fixtureRoot 'fake-runtime-no-record.ps1'
    [IO.File]::WriteAllText($crashRuntime,'exit 77',[Text.UTF8Encoding]::new($false))
    $private=Join-Path $script:fixtureRoot 'crash-recovery-private'
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:launcherPath,'-Mode','FakeRuntime','-OperationRoot',$op.Root,
      '-AuthorizationPhrase',$op.Phrase,'-HarnessDir',$script:harnessRoot,'-SourceTemplateDir',$script:fixture.source,
      '-ClaudeAttestationFile',$script:fixture.claude_attestation_file,'-CodexAttestationFile',$script:fixture.codex_attestation_file,
      '-ReadinessPath',$script:readinessPath,'-RemoteAuthCanaryOperationId','6bf48fb8-5fe0-4cb5-9965-e9081705f8fc',
      '-PrivateRoot',$private,'-FakeRuntimeScript',$crashRuntime,'-TestMode')
    & powershell.exe @arguments 2>$null|Out-Null
    $LASTEXITCODE|Should -Be 1
    $terminalPath=Join-Path $op.Root 'slots/0/terminal.json';$custodyPath=Join-Path $op.Root 'custody.json'
    $terminalBytes=[IO.File]::ReadAllBytes($terminalPath);$custodyBytes=[IO.File]::ReadAllBytes($custodyPath)
    $terminal=Get-Content -LiteralPath $terminalPath -Raw|ConvertFrom-Json
    $custody=Get-Content -LiteralPath $custodyPath -Raw|ConvertFrom-Json
    $terminal.reason_code|Should -BeExactly 'crash_after_dispatch'
    $custody.state|Should -BeExactly 'closed_incomplete_safety_stop'
    $custody.sessions_consumed|Should -Be 1
    Test-Path -LiteralPath (Join-Path $op.Root 'slots/0/dispatch.started.json')|Should -BeTrue
    Test-Path -LiteralPath (Join-Path $private $op.Binding.group_run_id)|Should -BeTrue
    & powershell.exe @arguments 2>$null|Out-Null
    $LASTEXITCODE|Should -Not -Be 0
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($terminalPath))|Should -BeExactly ([Convert]::ToBase64String($terminalBytes))
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($custodyPath))|Should -BeExactly ([Convert]::ToBase64String($custodyBytes))
  }

  It 'recovers a real process death between record and sidecar copy transactionally' {
    if (-not (Test-Path -LiteralPath 'C:\Evidence1Toolchain')) { Set-ItResult -Skipped -Because 'requires the provisioned Evidence1 guest toolchain' }
    $op=New-OpsFixture product ([guid]::NewGuid().ToString('D')) ([guid]::NewGuid().ToString('D'))
    $private=Join-Path $script:fixtureRoot 'mid-copy-crash-private'
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:launcherPath,'-Mode','FakeRuntime','-OperationRoot',$op.Root,
      '-AuthorizationPhrase',$op.Phrase,'-HarnessDir',$script:harnessRoot,'-SourceTemplateDir',$script:fixture.source,
      '-ClaudeAttestationFile',$script:fixture.claude_attestation_file,'-CodexAttestationFile',$script:fixture.codex_attestation_file,
      '-ReadinessPath',$script:readinessPath,'-RemoteAuthCanaryOperationId','6bf48fb8-5fe0-4cb5-9965-e9081705f8fc',
      '-PrivateRoot',$private,'-FakeRuntimeScript',$script:fake,'-TestMode')
    try{$env:E1_DUAL_TEST_CRASH_AFTER_RECORD_COPY='1';& powershell.exe @arguments 2>$null|Out-Null;$LASTEXITCODE|Should -Not -Be 0}
    finally{Remove-Item Env:E1_DUAL_TEST_CRASH_AFTER_RECORD_COPY -ErrorAction SilentlyContinue}
    $slot=Join-Path $op.Root 'slots/0'
    Test-Path -LiteralPath (Join-Path $slot 'copy.transaction.json')|Should -BeTrue
    @(Get-ChildItem -LiteralPath $slot -File -Filter 'scenario-*.json').Count|Should -Be 1
    @(Get-ChildItem -LiteralPath (Join-Path $slot 'audit') -File -Filter 'scenario-*.json').Count|Should -Be 0
    Test-Path -LiteralPath (Join-Path $slot 'terminal.json')|Should -BeFalse
    & powershell.exe @arguments 2>$null|Out-Null
    $LASTEXITCODE|Should -Be 1
    @(Get-ChildItem -LiteralPath $slot -File -Filter 'scenario-*.json').Count|Should -Be 0
    Test-Path -LiteralPath (Join-Path $slot 'copy.recovery.json')|Should -BeTrue
    $terminal=Get-Content -LiteralPath (Join-Path $slot 'terminal.json') -Raw|ConvertFrom-Json
    $custody=Get-Content -LiteralPath (Join-Path $op.Root 'custody.json') -Raw|ConvertFrom-Json
    $terminal.reason_code|Should -BeExactly 'crash_during_evidence_copy'
    $custody.state|Should -BeExactly 'closed_incomplete_safety_stop'
    $custody.sessions_consumed|Should -Be 1
    {Assert-Evidence1DualConditionCanaryOperation $op.Root}|Should -Not -Throw
  }

  It 'validates evidence from the immutable deployed layout under C Evidence1Ops' {
    $op=New-OpsFixture product ([guid]::NewGuid().ToString('D')) ([guid]::NewGuid().ToString('D'))
    $bundleRoot=Join-Path 'C:\Evidence1Ops\dual-condition-validator-test' $op.Binding.validator_bundle.bundle_sha256
    $script:deployedRoots+=$bundleRoot
    foreach($file in @($op.Binding.validator_bundle.files)){
      $source=Join-Path $script:harnessRoot ([string]$file.relative_path).Replace('/','\')
      $destination=Join-Path $bundleRoot ([string]$file.relative_path).Replace('/','\')
      $null=New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
      $bytes=[IO.File]::ReadAllBytes($source)
      $stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
      try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    }
    Assert-Evidence1DualConditionValidatorBundle $bundleRoot $op.Binding.validator_bundle -ExactInventory|Should -BeTrue
    $prior=$env:E1_DUAL_VALIDATOR_ROOT
    try{
      $env:E1_DUAL_VALIDATOR_ROOT=$bundleRoot
      $null=New-Evidence1DualConditionCanaryAuthorizationClaim $op.Root $op.Phrase
      $null=New-Evidence1DualConditionCanaryGroupClaim $op.Root
      $null=New-Evidence1DualConditionCanarySlotClaim $op.Root 0
      $null=New-Evidence1DualConditionCanaryPlanClaim $op.Root 0
      $null=New-Evidence1DualConditionCanaryDispatchStarted $op.Root 0
      $privateRoot=Join-Path $script:fixtureRoot ([guid]::NewGuid().ToString('N'))
      $result=& node $script:fixtureHelper write-private $script:contextPath (Join-Path $op.Root 'binding.json') '0' $privateRoot
      $LASTEXITCODE|Should -Be 0
      $runId=($result|ConvertFrom-Json).run_id;$privateRun=Join-Path $privateRoot 'agentic-eval-scenario';$slot=Join-Path $op.Root 'slots/0'
      $recordSource=Join-Path $privateRun "$runId.json";$sidecarSource=Join-Path (Join-Path $privateRun 'audit') "$runId.json"
      $null=New-Evidence1DualConditionCanaryCopyTransaction $op.Root 0 $runId (Get-TestFileSha256 $recordSource) (Get-TestFileSha256 $sidecarSource)
      [IO.File]::Copy($recordSource,(Join-Path $slot "$runId.json"));[IO.File]::Copy($sidecarSource,(Join-Path (Join-Path $slot 'audit') "$runId.json"))
      Remove-Item -LiteralPath $privateRoot -Recurse -Force
      (New-Evidence1DualConditionCanarySlotTerminal $op.Root 0 0 $false $true 1).value.state|Should -BeExactly 'completed'
    }finally{if($null-eq$prior){Remove-Item Env:E1_DUAL_VALIDATOR_ROOT -ErrorAction SilentlyContinue}else{$env:E1_DUAL_VALIDATOR_ROOT=$prior}}
  }

  It 'sanitizes a contaminated inherited PSModulePath for the contained child' {
    $poison=Join-Path $script:fixtureRoot 'poison-modules';$null=New-Item -ItemType Directory -Path $poison
    $prior=$env:PSModulePath
    try{
      $env:PSModulePath="$poison;$prior"
      $module=(Get-Command New-Evidence1DualConditionCanaryBinding).Module
      $node=(Get-Command node).Source
      $result=& $module {param($Node,$WorkDir) Invoke-E1BoundedProcess $Node @('-e','console.log(process.env.PSModulePath)') $WorkDir @{} 30} $node $script:fixtureRoot
      $result.exit_code|Should -Be 0
      ([string]$result.stdout).Trim()|Should -BeExactly "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
    }finally{$env:PSModulePath=$prior}
  }
}

Describe 'Evidence1 dual-condition operational source contracts' {
  It 'normalizes local cache paths for long-path-safe System.IO access' {
    Import-Module (Join-Path $script:repoRoot 'docs/audits/evidence1-validation-ops.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $script:repoRoot 'docs/audits/evidence1-gradle-offline-probe.psm1') -Force -DisableNameChecking
    ConvertTo-E1ExtendedFilePath 'C:\cache\artifact.jar'|Should -BeExactly '\\?\C:\cache\artifact.jar'
  }

  It 'ships every PowerShell module imported by the live launcher in the sealed validator bundle' {
    $manifest=Get-Evidence1DualConditionValidatorBundleManifest $script:repoRoot
    $relativePaths=@($manifest.files|ForEach-Object relative_path)
    $relativePaths|Should -Contain 'docs/audits/evidence1-validation-ops.psm1'
    $relativePaths|Should -Contain 'docs/audits/evidence1-validation-forensics.psm1'
    $relativePaths|Should -Contain 'docs/audits/evidence1-gradle-offline-probe.psm1'
    $runnerSource=Get-Content -LiteralPath (Join-Path $script:repoRoot 'docs/audits/evidence1-host-elevated-runner.ps1') -Raw
    $runnerSource|Should -Match "'docs/audits/evidence1-validation-forensics\.psm1'"
    $runnerSource|Should -Match "'docs/audits/evidence1-gradle-offline-probe\.psm1'"
  }

  It 'keeps runtime order, budgets, claims, containment and privacy explicit' {
    $source=Get-Content -LiteralPath $script:launcherPath -Raw
    $source|Should -Match 'New-Evidence1DualConditionCanarySlotClaim'
    $source|Should -Match 'New-Evidence1DualConditionCanaryPlanClaim'
    $source|Should -Match 'New-Evidence1DualConditionCanaryPairArmClaim'
    $source|Should -Match 'Assert-Evidence1DualConditionCanaryPair -OperationRoot'
    $source|Should -Match 'New-Evidence1DualConditionCanaryDispatchStarted'
    $claimBoundary=$source.LastIndexOf('New-Evidence1DualConditionCanaryPlanClaim $OperationRoot $ordinal')
    $claimBoundary|Should -BeLessThan $source.IndexOf("if (`$Mode -ceq 'FakeRuntime')",$claimBoundary)
    $source|Should -Match "--max-budget-usd','2'"
    $source|Should -Match "runtime_id.*claude-code"
    $source|Should -Match 'aggregated_across_runtimes'
    $source|Should -Not -Match 'Copy-Item.*raw|Copy-Item.*stderr'
  }
}
