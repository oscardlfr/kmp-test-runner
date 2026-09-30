$script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-dual-condition-canary-contract.psm1'
Import-Module $script:ModulePath -Force

BeforeAll {
    $script:FixtureHelper = Join-Path $PSScriptRoot 'fixtures/Evidence1DualConditionRealEvidence.mjs'
    $script:FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("e1-dual-condition-fixture-" + [guid]::NewGuid().ToString('N'))
    $fixtureJson = & node $script:FixtureHelper setup $script:FixtureRoot
    if ($LASTEXITCODE -ne 0) { throw 'dual_condition_fixture_setup' }
    $script:Fixture = $fixtureJson | ConvertFrom-Json
    $env:E1_DUAL_VALIDATOR_ROOT=(Get-Location).Path
    $script:FixtureContextPath = Join-Path $script:FixtureRoot 'context.json'
    [IO.File]::WriteAllText($script:FixtureContextPath, $fixtureJson, [Text.UTF8Encoding]::new($false))
    $script:Hashes = @{
        HarnessCommit = $script:Fixture.harness_commit; HarnessTree = $script:Fixture.harness_tree
        SourceCommit = $script:Fixture.source_commit; SourceTree = $script:Fixture.source_tree
        SkillSnapshotSha256 = $script:Fixture.skill_snapshot_sha256
        ClaudeAttestationSha256 = $script:Fixture.claude_attestation_sha256
        CodexAttestationSha256 = $script:Fixture.codex_attestation_sha256
    }
    $script:PairId = '97a3433c-b340-48c4-b503-66f7d4525248'
    function Get-TestSha256Bytes([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return -join($sha.ComputeHash($Bytes)|ForEach-Object{$_.ToString('x2')})}finally{$sha.Dispose()}}
    function New-TestBinding([string]$Arm, [string]$GroupId, [string]$LedgerRoot, [hashtable]$Override = @{}) {
        $arguments = @{
            Arm = $Arm; LedgerRoot = $LedgerRoot; PairId = $script:PairId; GroupRunId = $GroupId
            HarnessCommit = $script:Hashes.HarnessCommit; HarnessTree = $script:Hashes.HarnessTree
            SourceCommit = $script:Hashes.SourceCommit; SourceTree = $script:Hashes.SourceTree
            ClaudePlanSha256 = $(if ($Arm -eq 'product') { $script:Fixture.claude_product_plan_sha256 } else { $script:Fixture.claude_baseline_plan_sha256 })
            CodexPlanSha256 = $(if ($Arm -eq 'product') { $script:Fixture.codex_product_plan_sha256 } else { $script:Fixture.codex_baseline_plan_sha256 })
            ClaudeAttestationSha256 = $script:Hashes.ClaudeAttestationSha256
            CodexAttestationSha256 = $script:Hashes.CodexAttestationSha256
            RemoteAuthMaxAgeMinutes = 10080; ProcessTimeoutSeconds = 1800
        }
        if ($Arm -eq 'product') { $arguments.SkillSnapshotSha256 = $script:Hashes.SkillSnapshotSha256 }
        foreach ($key in $Override.Keys) { $arguments[$key] = $Override[$key] }
        return New-Evidence1DualConditionCanaryBinding @arguments
    }
    function New-Operation([string]$Arm = 'product', [string]$GroupId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090', [hashtable]$Override = @{}, [string]$LedgerRoot = '') {
        if ([string]::IsNullOrWhiteSpace($LedgerRoot)) {
            $LedgerRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
            $null = New-Item -ItemType Directory -Path $LedgerRoot
        }
        $root = Get-Evidence1DualConditionCanaryOperationRoot $LedgerRoot $script:PairId $GroupId
        $null = [IO.Directory]::CreateDirectory($root)
        $binding = New-TestBinding $Arm $GroupId $LedgerRoot $Override
        $receipt = Write-Evidence1DualConditionCanaryBinding $root $binding
        return @{ Root = $root; LedgerRoot = $LedgerRoot; Binding = $binding; Receipt = $receipt }
    }
    function Authorize-Group($Operation) {
        $phrase = Get-Evidence1DualConditionCanaryAuthorizationLiteral $Operation.Root
        $authorization = New-Evidence1DualConditionCanaryAuthorizationClaim $Operation.Root $phrase
        $group = New-Evidence1DualConditionCanaryGroupClaim $Operation.Root
        return @{ Phrase = $phrase; Authorization = $authorization; Group = $group }
    }
    function Write-EvidenceFiles($Operation, [int]$Ordinal) {
        $planPath = Join-Path (Join-Path (Join-Path $Operation.Root 'slots') ([string]$Ordinal)) 'plan.claim.json'
        if (-not (Test-Path -LiteralPath $planPath)) { $null = New-Evidence1DualConditionCanaryPlanClaim $Operation.Root $Ordinal }
        $dispatchPath=Join-Path (Split-Path -Parent $planPath) 'dispatch.started.json'
        if(-not(Test-Path -LiteralPath $dispatchPath)){$null=New-Evidence1DualConditionCanaryDispatchStarted $Operation.Root $Ordinal}
        $privateRoot=Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $result=& node $script:FixtureHelper write-private $script:FixtureContextPath (Join-Path $Operation.Root 'binding.json') ([string]$Ordinal) $privateRoot
        if ($LASTEXITCODE -ne 0) { throw 'dual_condition_fixture_write' }
        $runId=($result|ConvertFrom-Json).run_id;$privateRun=Join-Path $privateRoot 'agentic-eval-scenario'
        $recordSource=Join-Path $privateRun "$runId.json";$sidecarSource=Join-Path (Join-Path $privateRun 'audit') "$runId.json"
        $recordBytes=[IO.File]::ReadAllBytes($recordSource);$sidecarBytes=[IO.File]::ReadAllBytes($sidecarSource)
        $null=New-Evidence1DualConditionCanaryCopyTransaction $Operation.Root $Ordinal $runId (Get-TestSha256Bytes $recordBytes) (Get-TestSha256Bytes $sidecarBytes)
        $slotRoot=Join-Path (Join-Path $Operation.Root 'slots') ([string]$Ordinal)
        [IO.File]::WriteAllBytes((Join-Path $slotRoot "$runId.json"),$recordBytes)
        [IO.File]::WriteAllBytes((Join-Path (Join-Path $slotRoot 'audit') "$runId.json"),$sidecarBytes)
        Remove-Item -LiteralPath $privateRoot -Recurse -Force
    }
    function Write-DummyEvidence($Operation, [int]$Ordinal) {
        $planPath = Join-Path (Join-Path (Join-Path $Operation.Root 'slots') ([string]$Ordinal)) 'plan.claim.json'
        if (-not (Test-Path -LiteralPath $planPath)) { $null = New-Evidence1DualConditionCanaryPlanClaim $Operation.Root $Ordinal }
        $dispatchPath=Join-Path (Split-Path -Parent $planPath) 'dispatch.started.json'
        if(-not(Test-Path -LiteralPath $dispatchPath)){$null=New-Evidence1DualConditionCanaryDispatchStarted $Operation.Root $Ordinal}
        $slotRoot = Join-Path (Join-Path $Operation.Root 'slots') ([string]$Ordinal)
        $auditRoot = Join-Path $slotRoot 'audit'; $runId = "scenario-dummy-$Ordinal"
        $recordBytes=[Text.UTF8Encoding]::new($false).GetBytes('{"looks_valid":true}')
        $sidecarBytes=[Text.UTF8Encoding]::new($false).GetBytes('{"looks_like_sidecar":true}')
        $null=New-Evidence1DualConditionCanaryCopyTransaction $Operation.Root $Ordinal $runId (Get-TestSha256Bytes $recordBytes) (Get-TestSha256Bytes $sidecarBytes)
        [IO.File]::WriteAllBytes((Join-Path $slotRoot "$runId.json"),$recordBytes)
        [IO.File]::WriteAllBytes((Join-Path $auditRoot "$runId.json"),$sidecarBytes)
    }
}

AfterAll {
    Remove-Item Env:E1_DUAL_VALIDATOR_ROOT -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $script:FixtureRoot) {
        Get-ChildItem -LiteralPath $script:FixtureRoot -Recurse -Force | ForEach-Object { try { $_.Attributes = [IO.FileAttributes]::Normal } catch {} }
        Remove-Item -LiteralPath $script:FixtureRoot -Recurse -Force
    }
}

Describe 'Evidence1 dual-condition pair bindings' {
    It 'globally permits exactly one group per pair arm and validates the completed pair' {
        $ledger=Join-Path $TestDrive ([guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory $ledger
        $product=New-Operation product ([guid]::NewGuid().ToString('D')) @{} $ledger
        $null=New-Evidence1DualConditionCanaryPairArmClaim $product.Root
        (Assert-Evidence1DualConditionCanaryPair -OperationRoot $product.Root).complete|Should -BeFalse
        $duplicate=New-Operation product ([guid]::NewGuid().ToString('D')) @{} $ledger
        {New-Evidence1DualConditionCanaryPairArmClaim $duplicate.Root}|Should -Throw
        $baseline=New-Operation free-baseline ([guid]::NewGuid().ToString('D')) @{} $ledger
        $null=New-Evidence1DualConditionCanaryPairArmClaim $baseline.Root
        $pair=Assert-Evidence1DualConditionCanaryPair -OperationRoot $baseline.Root
        $pair.complete|Should -BeTrue
        (@($pair.claimed_arms)-join ',')|Should -BeExactly 'free-baseline,product'
    }

    It 'uses schema 2 closed shapes, provider-specific slots and opposite counterbalanced orders' {
        $product = New-Operation product 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
        $baseline = New-Operation free-baseline 'f0ee5356-dcdb-4f79-acaf-a457d7b34856' @{} $product.LedgerRoot
        $pair = Assert-Evidence1DualConditionCanaryPair $product.Root $baseline.Root
        $pair.validated | Should -BeTrue
        $product.Binding.schema | Should -Be 2
        (@($product.Binding.runtime_order) -join ',') | Should -BeExactly 'claude-code,codex-cli'
        (@($baseline.Binding.runtime_order) -join ',') | Should -BeExactly 'codex-cli,claude-code'
        $product.Binding.slots[0].campaign_design_id | Should -BeExactly 'claude-product-canary-v1'
        $product.Binding.slots[1].campaign_design_id | Should -BeExactly 'codex-product-canary-v1'
        $baseline.Binding.slots[0].campaign_design_id | Should -BeExactly 'codex-free-baseline-canary-v1'
        $baseline.Binding.slots[1].campaign_design_id | Should -BeExactly 'claude-free-baseline-canary-v1'
        $product.Binding.slots[0].session_budget_usd | Should -Be 2
        $product.Binding.slots[0].cli_version | Should -BeExactly '2.1.238'
        $product.Binding.slots[0].model_requested | Should -BeExactly 'claude-sonnet-5'
        $product.Binding.slots[0].model_resolved | Should -BeExactly 'claude-sonnet-5'
        $product.Binding.slots[1].cli_version | Should -BeExactly '0.154.0'
        $product.Binding.slots[1].model_requested | Should -BeExactly 'gpt-5.6-terra'
        $product.Binding.slots[1].model_resolved | Should -BeExactly 'gpt-5.6-terra'
        $product.Binding.slots[1].session_budget_usd | Should -BeNullOrEmpty
        $product.Binding.slots[1].session_budget_reason | Should -BeExactly 'runtime_does_not_support_session_budget'
        $product.Binding.skill_snapshot_sha256 | Should -Not -BeNullOrEmpty
        $baseline.Binding.skill_snapshot_sha256 | Should -BeNullOrEmpty
        $baseline.Binding.skill_snapshot_reason | Should -BeExactly 'condition-no-skill'
    }

    It 'does not persist mutable OAuth or readiness digests in the campaign binding' {
        $ledger = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory $ledger
        $binding = New-TestBinding product 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090' $ledger
        $binding.Keys | Should -Not -Contain 'remote_auth_report_sha256'
        $binding.Keys | Should -Not -Contain 'readiness_sha256'
    }

    It 'rejects schema 1, recursive extras and every common-axis pair drift' {
        $ledger = Join-Path $TestDrive ([guid]::NewGuid().ToString('N')); $null = New-Item -ItemType Directory $ledger
        $binding = New-TestBinding product 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090' $ledger; $binding.schema = 1
        { Assert-Evidence1DualConditionCanaryBinding $binding } | Should -Throw
        $binding = New-TestBinding product 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090' $ledger; $binding.slots[0]['raw'] = 'forbidden-extra'
        { Assert-Evidence1DualConditionCanaryBinding $binding } | Should -Throw '*dual_condition_shape*'
        foreach ($drift in @(
            @{ SourceCommit = 'e' * 40 }, @{ SourceTree = 'e' * 40 }, @{ HarnessCommit = 'e' * 40 },
            @{ HarnessTree = 'e' * 40 },
            @{ ProcessTimeoutSeconds = 1799 }, @{ ClaudeAttestationSha256 = 'e' * 64 },
            @{ CodexAttestationSha256 = 'e' * 64 }
        )) {
            $product = New-Operation product 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
            $baseline = New-Operation free-baseline 'f0ee5356-dcdb-4f79-acaf-a457d7b34856' $drift $product.LedgerRoot
            { Assert-Evidence1DualConditionCanaryPair $product.Root $baseline.Root } | Should -Throw '*dual_condition_pair_drift*'
        }
    }

    It 'uses distinct exact authorization phrases with the bound arm order' {
        $product = New-Operation product 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
        $baseline = New-Operation free-baseline 'f0ee5356-dcdb-4f79-acaf-a457d7b34856' @{} $product.LedgerRoot
        $productPhrase = Get-Evidence1DualConditionCanaryAuthorizationLiteral $product.Root
        $baselinePhrase = Get-Evidence1DualConditionCanaryAuthorizationLiteral $baseline.Root
        $productPhrase | Should -Match ' CANARY PRODUCT '
        $productPhrase | Should -Match 'EN ORDEN claude-code -> codex-cli;'
        $baselinePhrase | Should -Match ' CANARY FREE-BASELINE '
        $baselinePhrase | Should -Match 'EN ORDEN codex-cli -> claude-code;'
        $productPhrase | Should -Not -BeExactly $baselinePhrase
        { New-Evidence1DualConditionCanaryAuthorizationClaim $baseline.Root $productPhrase } | Should -Throw '*dual_condition_authorization_required*'
    }
}

Describe 'Evidence1 binding-specific one-shot authorization and claims' {
    It 'binds the exact phrase to pair and group without exposing a mutable digest' {
        $op = New-Operation
        $phrase = Get-Evidence1DualConditionCanaryAuthorizationLiteral $op.Root
        $phrase | Should -Match ([regex]::Escape($op.Binding.pair_id)); $phrase | Should -Match ([regex]::Escape($op.Binding.group_run_id))
        $phrase | Should -Not -Match $op.Receipt.sha256
        $phrase | Should -Not -Match 'BINDING SHA256'
        $authorization = New-Evidence1DualConditionCanaryAuthorizationClaim $op.Root $phrase
        $authorization.value.Keys | Should -Not -Contain 'phrase'
        { New-Evidence1DualConditionCanaryAuthorizationClaim $op.Root $phrase } | Should -Throw
        [IO.File]::AppendAllText((Join-Path $op.Root 'binding.json'), ' ')
        { New-Evidence1DualConditionCanaryGroupClaim $op.Root } | Should -Throw '*dual_condition_binding_hash_mismatch*'
    }

    It 'rejects replay against another binding and ignores alternate authorization paths' {
        $op1 = New-Operation; $op2 = New-Operation product 'f0ee5356-dcdb-4f79-acaf-a457d7b34856'
        $phrase1 = Get-Evidence1DualConditionCanaryAuthorizationLiteral $op1.Root
        $auth1 = New-Evidence1DualConditionCanaryAuthorizationClaim $op1.Root $phrase1
        { New-Evidence1DualConditionCanaryAuthorizationClaim $op2.Root $phrase1 } | Should -Throw '*dual_condition_authorization_required*'
        [IO.File]::Copy($auth1.path, (Join-Path $op2.Root 'authorization.claim.json'))
        { New-Evidence1DualConditionCanaryGroupClaim $op2.Root } | Should -Throw
        $op3 = New-Operation product '90777467-283a-42ce-ab67-5a679b099123'
        $alternate = Join-Path $op3.Root 'alternate'; $null = New-Item -ItemType Directory $alternate
        [IO.File]::Copy($auth1.path, (Join-Path $alternate 'authorization.claim.json'))
        { New-Evidence1DualConditionCanaryGroupClaim $op3.Root } | Should -Throw '*dual_condition_inventory*'
    }

    It 'rejects an identical binding cloned beneath another ledger root' {
        $op = New-Operation
        $cloneLedger = Join-Path $TestDrive ([guid]::NewGuid().ToString('N')); $null = New-Item -ItemType Directory $cloneLedger
        $cloneRoot = Get-Evidence1DualConditionCanaryOperationRoot $cloneLedger $op.Binding.pair_id $op.Binding.group_run_id
        $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path $cloneRoot 'slots') '0'))
        $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path $cloneRoot 'slots') '1'))
        $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path (Join-Path $cloneRoot 'slots') '0') 'audit'))
        $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path (Join-Path $cloneRoot 'slots') '1') 'audit'))
        [IO.File]::Copy((Join-Path $op.Root 'binding.json'), (Join-Path $cloneRoot 'binding.json'))
        { Get-Evidence1DualConditionCanaryAuthorizationLiteral $cloneRoot } | Should -Throw '*dual_condition_noncanonical_operation_root*'
    }

    It 'enforces durable prerequisites and runtime order before either slot can be claimed' {
        $op = New-Operation
        { New-Evidence1DualConditionCanarySlotClaim $op.Root 0 } | Should -Throw
        $phrase = Get-Evidence1DualConditionCanaryAuthorizationLiteral $op.Root
        $null = New-Evidence1DualConditionCanaryAuthorizationClaim $op.Root $phrase
        { New-Evidence1DualConditionCanarySlotClaim $op.Root 0 } | Should -Throw
        $null = New-Evidence1DualConditionCanaryGroupClaim $op.Root
        { New-Evidence1DualConditionCanarySlotClaim $op.Root 1 } | Should -Throw
        $slot0 = New-Evidence1DualConditionCanarySlotClaim $op.Root 0
        $slot0.value.runtime_id | Should -BeExactly 'claude-code'
        { New-Evidence1DualConditionCanarySlotClaim $op.Root 0 } | Should -Throw
    }

    It 'creates an immutable plan claim before spawn and rejects plan receipt drift' {
        $op = New-Operation; $null = Authorize-Group $op
        $claim = New-Evidence1DualConditionCanarySlotClaim $op.Root 0
        $plan = New-Evidence1DualConditionCanaryPlanClaim $op.Root 0
        $plan.value.slot_claim_sha256 | Should -BeExactly $claim.sha256
        $plan.value.plan_sha256 | Should -BeExactly $op.Binding.slots[0].plan_sha256
        $plan.value.run_id | Should -BeNullOrEmpty
        $plan.value.run_id_binding_policy | Should -BeExactly 'runtime-assigned-at-record-finalization; terminal-binds-exact-run-id'
        { New-Evidence1DualConditionCanaryPlanClaim $op.Root 0 } | Should -Throw
        $value = Get-Content -LiteralPath $plan.path -Raw | ConvertFrom-Json
        $value.plan_sha256 = 'e' * 64
        [IO.File]::WriteAllText($plan.path, ($value | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
        { Write-DummyEvidence $op 0; New-Evidence1DualConditionCanarySlotTerminal $op.Root 0 0 $false $true 1 } | Should -Throw '*dual_condition_plan_mismatch*'
    }

    It 'enforces the exported plan-claim to provider-spawn boundary' {
        $op = New-Operation; $null = Authorize-Group $op
        $null = New-Evidence1DualConditionCanarySlotClaim $op.Root 0
        $null = & node $script:FixtureHelper write $script:FixtureContextPath (Join-Path $op.Root 'binding.json') '0' 2>$null
        $LASTEXITCODE | Should -Not -Be 0
        @(Get-ChildItem -LiteralPath (Join-Path (Join-Path $op.Root 'slots') '0') -File -Filter 'scenario-*.json').Count | Should -Be 0
        $plan = New-Evidence1DualConditionCanaryPlanClaim $op.Root 0
        Write-EvidenceFiles $op 0
        $plan.value.state | Should -BeExactly 'claimed-before-spawn'
        @(Get-ChildItem -LiteralPath (Join-Path (Join-Path $op.Root 'slots') '0') -File -Filter 'scenario-*.json').Count | Should -Be 1
    }

    It 'allows exactly one winner in a concurrent claim race' {
        $op = New-Operation; $null = Authorize-Group $op
        $raceModulePath = (Get-Command New-Evidence1DualConditionCanarySlotClaim).Module.Path
        $jobs = 1..2 | ForEach-Object {
            Start-Job -ScriptBlock {
                param($ModulePath, $OperationRoot)
                Import-Module $ModulePath -Force
                try { $null = New-Evidence1DualConditionCanarySlotClaim $OperationRoot 0; 'won' } catch { 'lost' }
            } -ArgumentList $raceModulePath,$op.Root
        }
        try {
            $results = @($jobs | Wait-Job | Receive-Job)
            @($results | Where-Object { $_ -eq 'won' }).Count | Should -Be 1
            @($results | Where-Object { $_ -eq 'lost' }).Count | Should -Be 1
        } finally { $jobs | Remove-Job -Force }
    }
}

Describe 'Evidence1 derived terminals, integrity and custody' {
    BeforeEach {
        $script:Op = New-Operation; $null = Authorize-Group $script:Op
        $null = New-Evidence1DualConditionCanarySlotClaim $script:Op.Root 0
    }

    It 'derives completed only from exit zero and derives nonzero as functional failure' {
        Write-EvidenceFiles $script:Op 0
        $slot0Root = Join-Path (Join-Path $script:Op.Root 'slots') '0'
        $recordFile = @(Get-ChildItem -LiteralPath $slot0Root -File -Filter 'scenario-*.json')
        $sidecarFile = @(Get-ChildItem -LiteralPath (Join-Path $slot0Root 'audit') -File -Filter 'scenario-*.json')
        $recordFile.Count | Should -Be 1; $sidecarFile.Count | Should -Be 1
        $recordFile[0].BaseName | Should -BeExactly $sidecarFile[0].BaseName
        $record = Get-Content -LiteralPath $recordFile[0].FullName -Raw | ConvertFrom-Json
        $sidecar = Get-Content -LiteralPath $sidecarFile[0].FullName -Raw | ConvertFrom-Json
        $record.schema | Should -Be 9; $record.benchmark_eligible | Should -BeFalse
        $sidecar.schema | Should -Be 10; $record.accepted_audit.relative_path | Should -BeExactly "audit/$($record.run_id).json"
        $completed = New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 0 0 $false $true 1
        $completed.value.state | Should -BeExactly 'completed'; $completed.value.integrity_status | Should -BeExactly 'passed'
        $op2 = New-Operation product 'f0ee5356-dcdb-4f79-acaf-a457d7b34856'
        $null = Authorize-Group $op2; $null = New-Evidence1DualConditionCanarySlotClaim $op2.Root 0; Write-EvidenceFiles $op2 0
        $failed = New-Evidence1DualConditionCanarySlotTerminal $op2.Root 0 7 $false $true 1
        $failed.value.state | Should -BeExactly 'functional_failed'; $failed.value.failure_class | Should -BeExactly 'functional'
        $failed.value.reason_code | Should -BeExactly 'runtime_nonzero_exit'
        $decision = New-Evidence1DualConditionInterSlotIntegrity $op2.Root
        $decision.value.dispatch_next_slot | Should -BeTrue; $decision.value.decision | Should -BeExactly 'continue_once'
    }

    It 'closes a crash after contained dispatch as one consumed immutable safety stop' {
        $null=New-Evidence1DualConditionCanaryPlanClaim $script:Op.Root 0
        $started=New-Evidence1DualConditionCanaryDispatchStarted $script:Op.Root 0
        $started.value.sessions_consumed|Should -Be 1
        $terminal=New-Evidence1DualConditionCanaryIncompleteSlotTerminal $script:Op.Root 0
        $terminal.value.reason_code|Should -BeExactly 'crash_after_dispatch'
        $terminal.value.record_status|Should -BeExactly 'missing'
        $null=New-Evidence1DualConditionInterSlotIntegrity $script:Op.Root
        $custody=New-Evidence1DualConditionCanaryGroupCustody $script:Op.Root
        $custody.value.state|Should -BeExactly 'closed_incomplete_safety_stop'
        $custody.value.sessions_consumed|Should -Be 1
        $custody.value.retry_authorized|Should -BeFalse
        {New-Evidence1DualConditionCanaryIncompleteSlotTerminal $script:Op.Root 0}|Should -Throw
        {New-Evidence1DualConditionCanarySlotClaim $script:Op.Root 1}|Should -Throw
    }

    It 'durably rolls back a partial evidence-copy transaction before incomplete custody' {
        $null=New-Evidence1DualConditionCanaryPlanClaim $script:Op.Root 0
        $null=New-Evidence1DualConditionCanaryDispatchStarted $script:Op.Root 0
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"partial":true}')
        $recordHash=Get-TestSha256Bytes $bytes
        $null=New-Evidence1DualConditionCanaryCopyTransaction $script:Op.Root 0 'scenario-partial' $recordHash ('f'*64)
        $recordPath=Join-Path $script:Op.Root 'slots/0/scenario-partial.json'
        [IO.File]::WriteAllBytes($recordPath,$bytes)
        $recovery=Invoke-Evidence1DualConditionCanaryCopyRecovery $script:Op.Root 0
        $recovery.value.state|Should -BeExactly 'rollback-authorized'
        Test-Path -LiteralPath $recordPath|Should -BeFalse
        Test-Path -LiteralPath (Join-Path $script:Op.Root 'slots/0/copy.recovery.json')|Should -BeTrue
        $terminal=New-Evidence1DualConditionCanaryIncompleteSlotTerminal $script:Op.Root 0
        $terminal.value.reason_code|Should -BeExactly 'crash_during_evidence_copy'
        $null=New-Evidence1DualConditionInterSlotIntegrity $script:Op.Root
        $custody=New-Evidence1DualConditionCanaryGroupCustody $script:Op.Root
        $custody.value.state|Should -BeExactly 'closed_incomplete_safety_stop'
        $custody.value.sessions_consumed|Should -Be 1
        (Assert-Evidence1DualConditionCanaryOperation $script:Op.Root).privacy_validated|Should -BeFalse
    }

    It 'validates the copy transaction shape before terminalization' {
        $null=New-Evidence1DualConditionCanaryPlanClaim $script:Op.Root 0
        $null=New-Evidence1DualConditionCanaryDispatchStarted $script:Op.Root 0
        $transaction=New-Evidence1DualConditionCanaryCopyTransaction $script:Op.Root 0 'scenario-tamper' ('e'*64) ('f'*64)
        $value=Get-Content -LiteralPath $transaction.path -Raw|ConvertFrom-Json
        $value|Add-Member -NotePropertyName raw_prompt -NotePropertyValue 'must never enter custody'
        [IO.File]::WriteAllText($transaction.path,($value|ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
        {New-Evidence1DualConditionCanaryIncompleteSlotTerminal $script:Op.Root 0}|Should -Throw '*dual_condition_shape*'
    }

    It 'rejects evidence whose bytes drift from the pre-copy transaction' {
        $null=New-Evidence1DualConditionCanaryPlanClaim $script:Op.Root 0
        $null=New-Evidence1DualConditionCanaryDispatchStarted $script:Op.Root 0
        $privateRoot=Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $result=& node $script:FixtureHelper write-private $script:FixtureContextPath (Join-Path $script:Op.Root 'binding.json') '0' $privateRoot
        $LASTEXITCODE|Should -Be 0
        $runId=($result|ConvertFrom-Json).run_id;$privateRun=Join-Path $privateRoot 'agentic-eval-scenario';$slot=Join-Path $script:Op.Root 'slots/0'
        $recordSource=Join-Path $privateRun "$runId.json";$sidecarSource=Join-Path (Join-Path $privateRun 'audit') "$runId.json"
        $null=New-Evidence1DualConditionCanaryCopyTransaction $script:Op.Root 0 $runId ('e'*64) (Get-TestSha256Bytes ([IO.File]::ReadAllBytes($sidecarSource)))
        [IO.File]::Copy($recordSource,(Join-Path $slot "$runId.json"));[IO.File]::Copy($sidecarSource,(Join-Path (Join-Path $slot 'audit') "$runId.json"))
        {New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 0 0 $false $true 1}|Should -Throw '*dual_condition_copy_hash*'
    }

    It 'derives safety-stop from invalid evidence and makes slot 1 impossible' {
        Write-DummyEvidence $script:Op 0
        $terminal = New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 0 0 $false $true 1
        $terminal.value.state | Should -BeExactly 'safety_stopped'; $terminal.value.integrity_status | Should -BeExactly 'failed'
        $decision = New-Evidence1DualConditionInterSlotIntegrity $script:Op.Root
        $decision.value.dispatch_next_slot | Should -BeFalse
        { New-Evidence1DualConditionCanarySlotClaim $script:Op.Root 1 } | Should -Throw '*dual_condition_safety_stop*'
        $custody = New-Evidence1DualConditionCanaryGroupCustody $script:Op.Root
        $custody.value.state | Should -BeExactly 'closed_incomplete_safety_stop'; $custody.value.sessions_consumed | Should -Be 1
        $custody.value.records_validated | Should -Be 0; $custody.value.sidecars_validated | Should -Be 0
        @($custody.value.slots).Count | Should -Be 1
    }

    It 'derives closed_failed from complete custody containing a functional failure' {
        Write-EvidenceFiles $script:Op 0
        $null = New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 0 8 $false $true 1
        $null = New-Evidence1DualConditionInterSlotIntegrity $script:Op.Root
        $slot1 = New-Evidence1DualConditionCanarySlotClaim $script:Op.Root 1
        $slot1.value.runtime_id | Should -BeExactly 'codex-cli'
        Write-EvidenceFiles $script:Op 1
        $null = New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 1 0 $false $true 1
        $custody = New-Evidence1DualConditionCanaryGroupCustody $script:Op.Root
        $custody.value.complete | Should -BeTrue; $custody.value.state | Should -BeExactly 'closed_failed'
        $custody.value.sessions_consumed | Should -Be 2; $custody.value.records_validated | Should -Be 2
        $custody.value.sidecars_validated | Should -Be 2; $custody.value.aggregated_across_runtimes | Should -BeFalse
        (@($custody.value.slots.runtime_id) -join ',') | Should -BeExactly 'claude-code,codex-cli'
        $custody.value.slots[0].terminal_state | Should -BeExactly 'functional_failed'
        $custody.value.slots[0].failure_class | Should -BeExactly 'functional'
        $custody.value.slots[0].reason_code | Should -BeExactly 'runtime_nonzero_exit'
        (Assert-Evidence1DualConditionCanaryOperation $script:Op.Root).validated | Should -BeTrue
        $recordPath = Join-Path (Join-Path (Join-Path $script:Op.Root 'slots') '1') "$($custody.value.slots[1].run_id).json"
        [IO.File]::WriteAllText($recordPath, '{"mutated":true}')
        { Assert-Evidence1DualConditionCanaryOperation $script:Op.Root } | Should -Throw '*dual_condition_evidence_record_hash*'
    }

    It 'uses closed_pass only when both runtime terminals completed' {
        Write-EvidenceFiles $script:Op 0
        $null = New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 0 0 $false $true 1
        $null = New-Evidence1DualConditionInterSlotIntegrity $script:Op.Root
        $null = New-Evidence1DualConditionCanarySlotClaim $script:Op.Root 1
        Write-EvidenceFiles $script:Op 1
        $null = New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 1 0 $false $true 1
        $custody = New-Evidence1DualConditionCanaryGroupCustody $script:Op.Root
        $custody.value.state | Should -BeExactly 'closed_pass'
        @($custody.value.slots | Where-Object { $_.terminal_state -ne 'completed' }).Count | Should -Be 0
        $claudeRecordPath = Join-Path (Join-Path (Join-Path $script:Op.Root 'slots') '0') "$($custody.value.slots[0].run_id).json"
        $codexRecordPath = Join-Path (Join-Path (Join-Path $script:Op.Root 'slots') '1') "$($custody.value.slots[1].run_id).json"
        $claudeRecord = Get-Content -LiteralPath $claudeRecordPath -Raw | ConvertFrom-Json
        $codexRecord = Get-Content -LiteralPath $codexRecordPath -Raw | ConvertFrom-Json
        $claudeRecord.agent_runtime.cli_version | Should -BeExactly '2.1.238'
        $claudeRecord.agent_runtime.model_resolved | Should -BeExactly 'claude-sonnet-5'
        $codexRecord.agent_runtime.cli_version | Should -BeExactly '0.154.0'
        $codexRecord.agent_runtime.model_requested | Should -BeExactly 'gpt-5.6-terra'
        $codexRecord.agent_runtime.model_resolved | Should -BeExactly 'gpt-5.6-terra'
        $validated=Assert-Evidence1DualConditionCanaryOperation $script:Op.Root
        $validated.privacy_validated|Should -BeTrue
        @($validated.publication_artifacts).Count|Should -Be 4
        @($validated.publication_artifacts|Where-Object{$_.relative_path-like'*copy.transaction.json'}).Count|Should -Be 0
        $custody.value.slots[0].copy_transaction_sha256|Should -Match '^[a-f0-9]{64}$'
        $custody.value.slots[1].copy_transaction_sha256|Should -Match '^[a-f0-9]{64}$'
        $transactionPath=Join-Path $script:Op.Root 'slots/1/copy.transaction.json'
        $transactionBytes=[IO.File]::ReadAllBytes($transactionPath);$transaction=Get-Content -LiteralPath $transactionPath -Raw|ConvertFrom-Json
        $transaction|Add-Member -NotePropertyName raw_prompt -NotePropertyValue 'tampered after custody'
        [IO.File]::WriteAllText($transactionPath,($transaction|ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
        {Assert-Evidence1DualConditionCanaryOperation $script:Op.Root}|Should -Throw
        [IO.File]::WriteAllBytes($transactionPath,$transactionBytes)
        {Assert-Evidence1DualConditionCanaryOperation $script:Op.Root}|Should -Not -Throw
        $unexpectedRecovery=Join-Path $script:Op.Root 'slots/1/copy.recovery.json'
        [IO.File]::WriteAllText($unexpectedRecovery,'{"raw_prompt":"tampered recovery"}',[Text.UTF8Encoding]::new($false))
        {Assert-Evidence1DualConditionCanaryOperation $script:Op.Root}|Should -Throw '*dual_condition_copy_recovery_unexpected*'
    }

    It 'runs official validators and rejects dummy JSON without any declarative receipt escape hatch' {
        Write-DummyEvidence $script:Op 0
        $terminal = New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 0 0 $false $true 1
        $terminal.value.record_status | Should -BeExactly 'invalid'
        $terminal.value.sidecar_status | Should -BeExactly 'invalid'
        $terminal.value.state | Should -BeExactly 'safety_stopped'
        @(Get-ChildItem -LiteralPath (Join-Path (Join-Path $script:Op.Root 'slots') '0') -Recurse -Filter '*.validation.json').Count | Should -Be 0
    }

    It 'rejects slot identity drift in real-schema evidence and recursive raw extras in durable artifacts' {
        Write-EvidenceFiles $script:Op 0
        $slot0Root = Join-Path (Join-Path $script:Op.Root 'slots') '0'
        $recordPath = @(Get-ChildItem -LiteralPath $slot0Root -File -Filter 'scenario-*.json')[0].FullName
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        $record.agent_runtime.runtime_id = 'codex-cli'
        [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 30 -Compress), [Text.UTF8Encoding]::new($false))
        {New-Evidence1DualConditionCanarySlotTerminal $script:Op.Root 0 0 $false $true 1}|Should -Throw '*dual_condition_copy_hash*'
        $op2 = New-Operation product 'f0ee5356-dcdb-4f79-acaf-a457d7b34856'; $null = Authorize-Group $op2
        $groupPath = Join-Path $op2.Root 'group.claim.json'; $group = Get-Content -LiteralPath $groupPath -Raw | ConvertFrom-Json
        $group | Add-Member -NotePropertyName raw -NotePropertyValue 'forbidden-extra'
        [IO.File]::WriteAllText($groupPath, ($group | ConvertTo-Json -Compress))
        { New-Evidence1DualConditionCanarySlotClaim $op2.Root 0 } | Should -Throw '*dual_condition_shape*'
    }

    It 'rejects requested/resolved-model and CLI-version drift for both runtime records' {
        foreach ($case in @(
            @{ Arm = 'product'; Field = 'model_requested'; Value = 'claude-sonnet-5-drifted' },
            @{ Arm = 'product'; Field = 'model_resolved'; Value = 'claude-sonnet-5-drifted' },
            @{ Arm = 'product'; Field = 'cli_version'; Value = '2.1.237' },
            @{ Arm = 'free-baseline'; Field = 'model_requested'; Value = 'gpt-5.6-terra-drifted' },
            @{ Arm = 'free-baseline'; Field = 'model_resolved'; Value = 'gpt-5.6-terra-drifted' },
            @{ Arm = 'free-baseline'; Field = 'cli_version'; Value = '0.153.3' }
        )) {
            $op = New-Operation $case.Arm ([guid]::NewGuid().ToString('D')); $null = Authorize-Group $op
            $null = New-Evidence1DualConditionCanarySlotClaim $op.Root 0; Write-EvidenceFiles $op 0
            $slotRoot = Join-Path (Join-Path $op.Root 'slots') '0'
            $recordPath = @(Get-ChildItem -LiteralPath $slotRoot -File -Filter 'scenario-*.json')[0].FullName
            $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
            if ($case.Field -eq 'model_requested') {
                $record.agent_runtime.model_requested = $case.Value; $record.model_requested = $case.Value
            } elseif ($case.Field -eq 'model_resolved') {
                $record.agent_runtime.model_resolved = $case.Value; $record.model_resolved = $case.Value
            } else {
                $record.agent_runtime.cli_version = $case.Value
                if ($case.Arm -eq 'product') { $record.claude_code_version = $case.Value }
            }
            [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 30 -Compress), [Text.UTF8Encoding]::new($false))
            {New-Evidence1DualConditionCanarySlotTerminal $op.Root 0 0 $false $true 1}|Should -Throw '*dual_condition_copy_hash*'
        }
    }

    It 'rejects byte drift anywhere in the hash-bound validator closure' {
        $op = New-Operation; $null = Authorize-Group $op
        $null = New-Evidence1DualConditionCanarySlotClaim $op.Root 0; Write-EvidenceFiles $op 0
        $tracked = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'tools/agentic-eval/canonical-json.mjs'
        $original = [IO.File]::ReadAllBytes($tracked)
        try {
            [IO.File]::AppendAllText($tracked, "`n// transient dirty provenance probe`n")
            { New-Evidence1DualConditionCanarySlotTerminal $op.Root 0 0 $false $true 1 } | Should -Throw '*dual_condition_validator_bytes*'
        } finally { [IO.File]::WriteAllBytes($tracked, $original) }
        (New-Evidence1DualConditionCanarySlotTerminal $op.Root 0 0 $false $true 1).value.state | Should -BeExactly 'completed'
    }

    It 'kills a detached child even after its Node parent exits normally' {
        $pidFile = Join-Path $TestDrive 'detached-child.pid'
        $nodePath = (Get-Command node).Source
        $module = (Get-Command New-Evidence1DualConditionCanaryBinding).Module
        $result = & $module {
            param($Executable, $PidFile, $WorkDir)
            $child = "setInterval(()=>{},1000)"
            $childB64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($child))
            $code = "const{spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e',Buffer.from(process.env.KMP_E1_CHILD_B64,'base64').toString('utf8')],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.KMP_E1_PID_FILE,String(c.pid));c.unref();"
            $encoded = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($code))
            Invoke-E1BoundedProcess $Executable @('-e', "eval(Buffer.from(process.env.KMP_E1_PARENT_B64,'base64').toString('utf8'))") `
                $WorkDir @{ KMP_E1_PARENT_B64 = $encoded; KMP_E1_CHILD_B64 = $childB64; KMP_E1_PID_FILE = $PidFile } 5
        } $nodePath $pidFile $TestDrive
        $result.exit_code | Should -Be 0; $result.cleanup_ok | Should -BeTrue
        Test-Path -LiteralPath $pidFile | Should -BeTrue
        $childPid = [int](Get-Content -LiteralPath $pidFile -Raw)
        { Get-Process -Id $childPid -ErrorAction Stop } | Should -Throw
    }

    It 'kills the detached child across the real timeout race, not only the root' {
        $pidFile = Join-Path $TestDrive 'timeout-detached-child.pid'
        $nodePath = (Get-Command node).Source
        $module = (Get-Command New-Evidence1DualConditionCanaryBinding).Module
        $message = & $module {
            param($Executable, $PidFile, $WorkDir)
            $child = "setInterval(()=>{},1000)"
            $childB64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($child))
            $code = "const{spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e',Buffer.from(process.env.KMP_E1_CHILD_B64,'base64').toString('utf8')],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.KMP_E1_PID_FILE,String(c.pid));c.unref();setInterval(()=>{},1000);"
            $encoded = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($code))
            try {
                $null = Invoke-E1BoundedProcess $Executable @('-e', "eval(Buffer.from(process.env.KMP_E1_PARENT_B64,'base64').toString('utf8'))") `
                    $WorkDir @{ KMP_E1_PARENT_B64 = $encoded; KMP_E1_CHILD_B64 = $childB64; KMP_E1_PID_FILE = $PidFile } 1
                'unexpected-success'
            } catch { $_.Exception.Message }
        } $nodePath $pidFile $TestDrive
        $message | Should -BeExactly 'dual_condition_process_timeout'
        Test-Path -LiteralPath $pidFile | Should -BeTrue
        $childPid = [int](Get-Content -LiteralPath $pidFile -Raw)
        { Get-Process -Id $childPid -ErrorAction Stop } | Should -Throw
    }
}

Describe 'Evidence1 journal-bound public copy' {
    It 'copies one verified byte snapshot and rejects source hash drift before destination creation' {
        $source=Join-Path $TestDrive 'publication-source.json';$destination=Join-Path $TestDrive 'published/record.json'
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"safe":true}')
        [IO.File]::WriteAllBytes($source,$bytes);$expected=Get-TestSha256Bytes $bytes
        $result=Copy-Evidence1DualConditionPublicArtifact $source $destination $expected
        $result.sha256|Should -BeExactly $expected
        (Get-TestSha256Bytes ([IO.File]::ReadAllBytes($destination)))|Should -BeExactly $expected
        [IO.File]::WriteAllText($source,'{"raw_prompt":"drift"}',[Text.UTF8Encoding]::new($false))
        $rejected=Join-Path $TestDrive 'published/rejected.json'
        {Copy-Evidence1DualConditionPublicArtifact $source $rejected $expected}|Should -Throw '*dual_condition_publication_source_hash*'
        Test-Path -LiteralPath $rejected|Should -BeFalse
    }

    It 'recovers a killed partial stage and exposes only the atomic completed directory' {
        $source=Join-Path $TestDrive 'publication-set-source';$trustedRoot=Join-Path $TestDrive 'public';$destination=Join-Path $trustedRoot 'pair/group'
        $null=New-Item -ItemType Directory -Path $trustedRoot
        $null=New-Item -ItemType Directory -Path (Join-Path $source 'nested') -Force
        $artifacts=@()
        foreach($item in @([ordered]@{path='binding.json';content='{"schema":1}'},[ordered]@{path='nested/record.json';content='{"record":"safe"}'},[ordered]@{path='nested/sidecar.json';content='{"sidecar":"safe"}'})){
          $path=Join-Path $source ($item.path-replace'/','\');$bytes=[Text.UTF8Encoding]::new($false).GetBytes($item.content)
          [IO.File]::WriteAllBytes($path,$bytes)
          $artifacts+=[ordered]@{relative_path=$item.path;sha256=Get-TestSha256Bytes $bytes;size_bytes=[int64]$bytes.Length}
        }
        $manifestPath=Join-Path $TestDrive 'publication-manifest.json'
        [IO.File]::WriteAllText($manifestPath,($artifacts|ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
        $crashScript=Join-Path $PSScriptRoot 'fixtures/Evidence1DualConditionPublicationCrash.ps1'
        $publicationModule=(Get-Command Publish-Evidence1DualConditionArtifactSet).Module.Path
        $childOutput=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $crashScript -ModulePath $publicationModule -SourceRoot $source -DestinationRoot $destination -TrustedRoot $trustedRoot -ManifestPath $manifestPath 2>&1
        $LASTEXITCODE|Should -Not -Be 0
        Test-Path -LiteralPath $destination|Should -BeFalse
        Test-Path -LiteralPath "$destination.staging"|Should -BeTrue -Because ($childOutput|Out-String)
        @(Get-ChildItem -LiteralPath "$destination.staging" -Recurse -File).Count|Should -Be 1
        Test-Path -LiteralPath "$destination.publication.transaction.json"|Should -BeTrue
        Test-Path -LiteralPath "$destination.publication.ready.json"|Should -BeFalse
        $result=Publish-Evidence1DualConditionArtifactSet -SourceRoot $source -DestinationRoot $destination -TrustedRoot $trustedRoot -Tier public -Artifacts $artifacts
        $result.state|Should -BeExactly 'committed'
        Test-Path -LiteralPath "$destination.staging"|Should -BeFalse
        @(Get-ChildItem -LiteralPath $destination -Recurse -File).Count|Should -Be 3
        @(Get-ChildItem -LiteralPath $destination -Recurse -File|Where-Object{$_.Name-match'publication|transaction|ready'}).Count|Should -Be 0
        (Publish-Evidence1DualConditionArtifactSet -SourceRoot $source -DestinationRoot $destination -TrustedRoot $trustedRoot -Tier public -Artifacts $artifacts).state|Should -BeExactly 'already-committed'
    }

    It 'recovers torn transaction and ready JSON after real process death' {
        $source=Join-Path $TestDrive 'atomic-control-source';$trustedRoot=Join-Path $TestDrive 'atomic-public'
        $null=New-Item -ItemType Directory -Path $source,$trustedRoot
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"record":"safe"}');[IO.File]::WriteAllBytes((Join-Path $source 'record.json'),$bytes)
        $artifacts=@([pscustomobject][ordered]@{relative_path='record.json';sha256=Get-TestSha256Bytes $bytes;size_bytes=[int64]$bytes.Length})
        $manifestPath=Join-Path $TestDrive 'atomic-control-manifest.json'
        [IO.File]::WriteAllText($manifestPath,($artifacts|ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
        $crashScript=Join-Path $PSScriptRoot 'fixtures/Evidence1DualConditionPublicationCrash.ps1';$module=(Get-Command Publish-Evidence1DualConditionArtifactSet).Module.Path
        foreach($point in @('transaction','ready')){
          $destination=Join-Path $trustedRoot "$point/pair"
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $crashScript -ModulePath $module -SourceRoot $source -DestinationRoot $destination -TrustedRoot $trustedRoot -ManifestPath $manifestPath -CrashPoint $point 2>$null|Out-Null
          $LASTEXITCODE|Should -Not -Be 0
          Test-Path -LiteralPath $destination|Should -BeFalse
          if($point-ceq'transaction'){
            Test-Path -LiteralPath "$destination.publication.transaction.json"|Should -BeFalse
            Test-Path -LiteralPath "$destination.publication.transaction.json.pending"|Should -BeTrue
          }else{
            Test-Path -LiteralPath "$destination.publication.transaction.json"|Should -BeTrue
            Test-Path -LiteralPath "$destination.publication.ready.json"|Should -BeFalse
            Test-Path -LiteralPath "$destination.publication.ready.json.pending"|Should -BeTrue
          }
          $result=Publish-Evidence1DualConditionArtifactSet -SourceRoot $source -DestinationRoot $destination -TrustedRoot $trustedRoot -Tier public -Artifacts $artifacts
          $result.state|Should -BeExactly 'committed';$result.recovered_torn_json_count|Should -Be 1
          Test-Path -LiteralPath $destination|Should -BeTrue
          @(Get-ChildItem -LiteralPath $destination -Recurse -File).Count|Should -Be 1
        }
    }

    It 'recovers a torn report temp but never replaces a corrupt definitive report' {
        $trustedRoot=Join-Path $TestDrive 'atomic-reports';$null=New-Item -ItemType Directory -Path $trustedRoot
        $target=Join-Path $trustedRoot 'pair/group/COPY.json';$valuePath=Join-Path $TestDrive 'report-value.json'
        [IO.File]::WriteAllText($valuePath,'{"schema":1,"state":"passed","raw_content_read":false}',[Text.UTF8Encoding]::new($false))
        $module=(Get-Command Write-Evidence1DualConditionAtomicJson).Module.Path;$crashScript=Join-Path $PSScriptRoot 'fixtures/Evidence1DualConditionAtomicJsonCrash.ps1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $crashScript -ModulePath $module -TargetPath $target -TrustedRoot $trustedRoot -ValuePath $valuePath 2>$null|Out-Null
        $LASTEXITCODE|Should -Not -Be 0
        Test-Path -LiteralPath $target|Should -BeFalse;Test-Path -LiteralPath "$target.pending"|Should -BeTrue
        $value=Get-Content -LiteralPath $valuePath -Raw|ConvertFrom-Json
        $receipt=Write-Evidence1DualConditionAtomicJson -Path $target -Value $value -TrustedRoot $trustedRoot
        $receipt.state|Should -BeExactly 'committed';$receipt.recovered_torn_temp|Should -BeTrue
        (Write-Evidence1DualConditionAtomicJson -Path $target -Value $value -TrustedRoot $trustedRoot).state|Should -BeExactly 'already-committed'
        [IO.File]::AppendAllText($target,"`n",[Text.UTF8Encoding]::new($false));$corrupt=[IO.File]::ReadAllBytes($target)
        {Write-Evidence1DualConditionAtomicJson -Path $target -Value $value -TrustedRoot $trustedRoot}|Should -Throw '*dual_condition_atomic_json_final_corrupt*'
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($target))|Should -BeExactly ([Convert]::ToBase64String($corrupt))
    }

    It 'rejects a nested junction escape before creating any outside artifact' {
        $trustedRoot=Join-Path $TestDrive 'trusted-public';$outside=Join-Path $TestDrive 'outside-public';$source=Join-Path $TestDrive 'junction-source'
        $null=New-Item -ItemType Directory -Path $trustedRoot,$outside,$source
        $null=New-Item -ItemType Junction -Path (Join-Path $trustedRoot 'nested') -Target $outside
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"safe":true}');[IO.File]::WriteAllBytes((Join-Path $source 'record.json'),$bytes)
        $artifact=[pscustomobject][ordered]@{relative_path='record.json';sha256=Get-TestSha256Bytes $bytes;size_bytes=[int64]$bytes.Length}
        {Publish-Evidence1DualConditionArtifactSet -SourceRoot $source -DestinationRoot (Join-Path $trustedRoot 'nested/group') -TrustedRoot $trustedRoot -Tier public -Artifacts @($artifact)}|Should -Throw '*dual_condition_reparse_point*'
        {Write-Evidence1DualConditionAtomicJson -Path (Join-Path $trustedRoot 'nested/COPY.json') -Value ([ordered]@{schema=1}) -TrustedRoot $trustedRoot}|Should -Throw '*dual_condition_reparse_point*'
        @(Get-ChildItem -LiteralPath $outside -Force).Count|Should -Be 0
    }
}

Describe 'Evidence1 exact operation inventory' {
    It 'rejects unexpected raw files before advancing state' {
        $op = New-Operation; $null = Authorize-Group $op
        [IO.File]::WriteAllText((Join-Path $op.Root 'raw-transcript.json'), '{"raw":true}')
        { New-Evidence1DualConditionCanarySlotClaim $op.Root 0 } | Should -Throw '*dual_condition_inventory*'

        $op2 = New-Operation product 'f0ee5356-dcdb-4f79-acaf-a457d7b34856'; $null = Authorize-Group $op2
        $null = New-Item -ItemType Directory (Join-Path $op2.Root 'unexpected-directory')
        { New-Evidence1DualConditionCanarySlotClaim $op2.Root 0 } | Should -Throw '*dual_condition_inventory*'
    }

    It 'rejects reparse points anywhere below the operation root' {
        $op = New-Operation; $null = Authorize-Group $op
        $target = Join-Path $TestDrive ([guid]::NewGuid().ToString('N')); $null = New-Item -ItemType Directory $target
        $null = New-Item -ItemType Junction -Path (Join-Path $op.Root 'linked-raw') -Target $target
        { New-Evidence1DualConditionCanarySlotClaim $op.Root 0 } | Should -Throw '*dual_condition_reparse_point*'
    }
}

Describe 'Evidence1 durable state machine' {
    It 'accepts only the closed two-slot transition graph' {
        $state = 'bound'
        foreach ($step in @(
            @('authorization_claimed','authorized'), @('group_claimed','group_claimed'), @('slot_0_claimed','slot_0_claimed'),
            @('slot_0_plan_claimed','slot_0_plan_claimed'), @('slot_0_terminal','slot_0_terminal'), @('integrity_continue','inter_slot_integrity_checked'),
            @('slot_1_claimed','slot_1_claimed'), @('slot_1_plan_claimed','slot_1_plan_claimed'),
            @('slot_1_terminal','slot_1_terminal'), @('custody_pass','closed_pass')
        )) {
            $state = Get-Evidence1DualConditionCanaryNextState $state $step[0]; $state | Should -BeExactly $step[1]
        }
        (Get-Evidence1DualConditionCanaryNextState 'slot_0_terminal' 'integrity_safety_stop') | Should -BeExactly 'closed_incomplete_safety_stop'
        (Get-Evidence1DualConditionCanaryNextState 'slot_1_terminal' 'custody_functional_failed') | Should -BeExactly 'closed_failed'
        { Get-Evidence1DualConditionCanaryNextState 'group_claimed' 'slot_1_claimed' } | Should -Throw
    }
}
