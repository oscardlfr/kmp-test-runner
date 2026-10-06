BeforeAll {
    # Same rationale as every other Evidence1 test file's BeforeAll (see
    # Evidence1-Network-Backend-Contract.Tests.ps1's comment). This file
    # cannot import evidence1-run.ps1 itself (a script, not a module -- doing
    # so would dot-source and therefore EXECUTE it, forbidden). Instead it
    # replicates evidence1-run.ps1's exact fake-mode handler LOGIC for
    # LiveAuthorized/LiveRunning/EvidenceCopied/Closed against the real
    # capability modules, the same technique already used (and reported
    # honestly as such) to verify BrokerReady..RestrictedReady in the first
    # fix-forward round. This is integration-level proof of the LOGIC; it is
    # not proof that evidence1-run.ps1's own copy of that logic is
    # byte-identical -- the file:line citations in the architecture note are
    # how that correspondence is checked instead, since the file cannot be
    # run to compare directly.
    # $PSScriptRoot-relative rather than a hardcoded main-checkout path -- see
    # Evidence1-Run-Disk-Space-Guards.Tests.ps1's own header for why: this whole file (including
    # every "read evidence1-run.ps1's own source and Invoke-Expression a function out of it" Describe
    # block below) silently verified nothing about a work-order worktree's own copy until merge.
    $script:AuditsRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\docs\audits'))
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-run-manifest-contract.psm1') -Force
    # Newly needed this round (overnight work order item 6, Phase 4
    # rehearsals 2/3): New-E1RunStateReceipt/Read-E1RunStateReceipt/
    # Write-E1RunStateReceiptAtomically/Get-E1RunStateNames/
    # Get-E1RunLiveAdjacentStateNames/Assert-E1RunStateReceiptShape. The
    # original "reaches Closed" test never touched a receipt directly (it
    # asserted on each capability's own result object), so this file never
    # needed this module before now.
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-run-state-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-status-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-vm-state-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-network-backend-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-artifact-copy-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-clock-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-provider-runtime-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-artifact-store-fake.psm1') -Force

    # -TrustedRoot (output_roots trust-root portability follow-up): empty by
    # default, in which case Read-E1RunManifest is called with no override
    # -- byte-identical to this helper's own pre-existing behavior, so every
    # existing call site across this file is unaffected. Only the new
    # trust-root-portability Describe below passes a non-empty value,
    # exercising the SAME injected root evidence1-run.ps1 itself would
    # resolve once and pass to the manifest contract, ArtifactCopy, and
    # ArtifactStore.
    function New-TestManifestObject {
        param([hashtable]$Override = @{}, [string]$ExpiresAtUtc = '2099-01-01T00:00:00.000Z', [string]$TrustedRoot = '')
        $manifest = [ordered]@{
            schema = 1
            campaign_id = [guid]::NewGuid().ToString()
            runtimes = @(
                [ordered]@{ runtime_id = 'codex-cli'; model_id = 'gpt-5.6-terra'; campaign_design_id = 'codex-product-vs-free-baseline-v1'; campaign_cell_indices = @(0, 1); max_budget_usd = $null }
                [ordered]@{ runtime_id = 'claude-code'; model_id = 'claude-sonnet-5'; campaign_design_id = 'claude-product-vs-free-baseline-v1'; campaign_cell_indices = @(2, 3); max_budget_usd = 2.0 }
            )
            scenario_id = 'coverage-threshold-failure-v2'
            seed = -1717
            execution_profile_id = 'sandboxed-unrestricted-v1'
            conditions = @('product', 'free')
            round_order = @('product', 'free')
            max_session_count = 4
            vm_name = 'Evidence1FakeVM'
            guest_credential_path = 'C:\kmp-eval\scratch\fake-credential.xml'
            harness_dir = 'C:\kmp-eval\agentic-eval-codex-runtime'
            source_template_dir = 'C:\kmp-eval\source-template'
            claude_attestation_file = 'C:\kmp-eval\attestations\claude.json'
            codex_attestation_file = 'C:\kmp-eval\attestations\codex.json'
            readiness_path = 'C:\kmp-eval\scratch\readiness.json'
            private_root = 'C:\Evidence1Private\campaigns'
            provider_timeout_seconds = 900
            worker_timeout_seconds = 960
            guest_transport_timeout_seconds = 1020
            provider_mode = 'fake'
            output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\integration-private'; public = 'C:\kmp-eval\scratch\integration-public' }
            no_automatic_provider_retry = $true
            generated_at_utc = '2026-01-01T00:00:00.000Z'
        }
        foreach ($key in $Override.Keys) { $manifest[$key] = $Override[$key] }
        $path = Join-Path $TestDrive ([guid]::NewGuid().ToString('N') + '.json')
        ($manifest | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $path -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($TrustedRoot)) { return Read-E1RunManifest $path }
        return Read-E1RunManifest $path -TrustedRoot $TrustedRoot
    }

    # Replicates Invoke-E1RunLiveAuthorizedState's own logic exactly
    # (evidence1-run.ps1) against a manifest object, for direct assertion.
    function Test-LiveAuthorizedLogic($Manifest) {
        $expectedCells = @(Get-E1RunManifestExpectedCells $Manifest)
        return @{ ExpectedCellCount = $expectedCells.Count; Ok = ([bool]$Manifest.no_automatic_provider_retry -and [int]$Manifest.max_session_count -eq $expectedCells.Count) }
    }

    # Replicates Invoke-E1RunVmReadyState (evidence1-run.ps1) exactly, for
    # the "VmReady, its own registered check" Phase 4 rehearsal 2 Describe
    # below. Defined here, in the root BeforeAll -- NOT bare inside that
    # Describe block, which would be discovery-phase-only and invisible to
    # its own It blocks in the run phase (the exact mistake this file's
    # Evidence1-Run-State-Contract.Tests.ps1 sibling already documented once
    # this round; repeated once here too, caught the same way: by actually
    # running the tests and seeing CommandNotFoundException rather than
    # trusting the file was correct).
    function Test-VmReadyLogic($VMName, $VMId) {
        Set-E1FakeVmInitialState -VMName $VMName -VMId $VMId -State 'Off' | Out-Null
        return Invoke-E1VmEnsureState -VMName $VMName -ExpectedVMId $VMId -TargetState 'Running'
    }

    # Byte-for-byte replica of evidence1-run.ps1:502-512's own
    # Get-E1RunResumeIndex -- see the "host reboot/resume drill" Describe
    # below for why this cannot be called directly (it is script-level code,
    # not a module function). Same discovery-phase-visibility reason for
    # living here, in the root BeforeAll.
    function Get-TestResumeIndex([string]$CampaignRoot, [string]$ExpectedCampaignId, [bool]$UseRealBackends) {
        $allStates = Get-E1RunStateNames
        $liveAdjacent = Get-E1RunLiveAdjacentStateNames
        $index = 0
        for ($i = 1; $i -lt $allStates.Count; $i++) {
            $stateName = $allStates[$i]
            if ($UseRealBackends -and $stateName -cin $liveAdjacent) { break }
            $receipt = Read-E1RunStateReceipt $CampaignRoot $stateName
            if ($null -eq $receipt -or [string]$receipt.verdict -cne 'PASS' -or [string]$receipt.campaign_id -cne $ExpectedCampaignId) { break }
            $index = $i
        }
        return $index
    }
}

Describe 'Evidence1 full fake campaign: BrokerReady through Closed' {
    It 'reaches Closed with a committed publication, using exclusively fake backends' {
        Reset-E1FakeBrokerStatusState
        # Unique, non-campaign-relative output_roots (overnight work order
        # item 1): deliberately NOT under $campaignRoot at all, to prove
        # evidence lands wherever the MANIFEST says, not at whatever
        # evidence1-run.ps1 used to hardcode
        # (<CampaignRoot>\private-evidence / public-evidence). Suffixed with
        # a fresh guid per test run so a leftover .publication.ready.json
        # from a prior run of this same test can never short-circuit this
        # run into the "already-committed" idempotent branch.
        $outputRootsSuffix = [guid]::NewGuid().ToString('N')
        $manifestOutputRootsPrivate = "C:\kmp-eval\scratch\pester-run-integration-tests\custom-output-roots-$outputRootsSuffix\private"
        $manifestOutputRootsPublic = "C:\kmp-eval\scratch\pester-run-integration-tests\custom-output-roots-$outputRootsSuffix\public"
        $manifest = New-TestManifestObject -Override @{
            output_roots = [ordered]@{ private = $manifestOutputRootsPrivate; public = $manifestOutputRootsPublic }
        }
        $vmName = [string]$manifest.vm_name
        $vmId = [guid]::NewGuid().ToString()
        $guestCredentialPath = ''
        # Scratch-scoped, not $TestDrive: evidence1-artifact-copy-fake.psm1's
        # destination-scoping assertion (and evidence1-artifact-store-fake.psm1's
        # own root-scoping assertion, exercised later in this same test)
        # requires C:\kmp-eval\scratch\ -- matching how evidence1-run.ps1
        # itself always roots a real campaign there by default
        # (-StateRoot = 'C:\kmp-eval\scratch\evidence1-run'). $TestDrive lives
        # elsewhere and would trip both checks for the exact right reason:
        # they are not lint, they are the same path-scoping discipline every
        # filesystem-touching module in this repo enforces for real.
        $campaignRoot = Join-Path 'C:\kmp-eval\scratch\pester-run-integration-tests' ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $campaignRoot | Out-Null

        # BrokerReady
        $broker = Get-E1BrokerStatus
        $broker.self_update_capable | Should -BeTrue

        # VmReady
        Set-E1FakeVmInitialState -VMName $vmName -VMId $vmId -State 'Off' | Out-Null
        $vmReady = Invoke-E1VmEnsureState -VMName $vmName -ExpectedVMId $vmId -TargetState 'Running'
        $vmReady.verdict | Should -BeExactly 'PASS'

        # ToolchainReady / AuthReady (both runtimes)
        foreach ($runtimeId in @('codex', 'claude')) {
            Set-E1FakeGuestBundleResult -VMName $vmName -BundleName 'get-cli-version-and-login-status' -Verdict 'PASS' `
              -Output ([ordered]@{ command_found = $true; version_text = "$runtimeId-fake"; login_status_exit_code = 0 }) | Out-Null
            $inv = Invoke-E1GuestBundle -VMName $vmName -GuestCredentialPath $guestCredentialPath -BundleName 'get-cli-version-and-login-status' `
              -Arguments @{ CommandPath = "C:\Evidence1Toolchain\$runtimeId-cli\x\$runtimeId.cmd"; LoginStatusArgs = [string[]]@('status') }
            $inv.verdict | Should -BeExactly 'PASS'
            $inv.output.login_status_exit_code | Should -Be 0
        }

        # RestrictedReady
        Set-E1FakeNetworkInitialMode -VMName $vmName -VMId $vmId -Mode 'offline' | Out-Null
        $restricted = Invoke-E1NetworkEnsureMode -VMName $vmName -GuestCredentialPath $guestCredentialPath -TargetMode 'restricted'
        $restricted.verdict | Should -BeExactly 'PASS'
        $restricted.mode | Should -BeExactly 'restricted'

        # LiveAuthorized
        $auth = Test-LiveAuthorizedLogic $manifest
        $auth.Ok | Should -BeTrue

        # LiveRunning -- driven off Get-E1RunManifestExpectedCells, matching
        # Invoke-E1RunLiveRunningState (evidence1-run.ps1) exactly, not a
        # second independent round_order/runtimes nested loop (overnight
        # work order item 2: the two must never be able to drift apart).
        $sessions = @()
        $cells = @(Get-E1RunManifestExpectedCells $manifest)
        foreach ($cell in $cells) {
            $session = Invoke-E1ProviderRuntimeSession -RuntimeId ([string]$cell.runtime_id) -ModelId ([string]$cell.model_id) `
              -RoundIndex ([int]$cell.round_index) -ScenarioSha256 ([string]$manifest.scenario_id) -PromptSha256 ([string]$cell.campaign_design_id)
            $sessions += $session
        }
        $sessions.Count | Should -Be $cells.Count
        $sessions.Count | Should -Be (@($manifest.round_order).Count * @($manifest.runtimes).Count)
        @($sessions | Where-Object { $_.verdict -cne 'PASS' }).Count | Should -Be 0

        # EvidenceCopied
        $fakeMountRoot = Join-Path $campaignRoot 'fake-guest-mount'
        $attestationDir = Join-Path $fakeMountRoot 'kmp-eval\measurement-scopes'
        New-Item -ItemType Directory -Force -Path $attestationDir | Out-Null
        '{"schema":1,"fake":true}' | Set-Content -LiteralPath (Join-Path $attestationDir 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') -Encoding UTF8
        Set-E1FakeArtifactCopyMountRoot -VMName $vmName -MountRootPath $fakeMountRoot
        # Sourced from the manifest's own output_roots.private (Invoke-E1RunEvidenceCopiedState,
        # evidence1-run.ps1) -- NOT a <CampaignRoot>-relative hardcode.
        $privateEvidenceRoot = [string]$manifest.output_roots.private
        $privateEvidenceRoot | Should -BeExactly $manifestOutputRootsPrivate
        $copyResult = Copy-E1ArtifactsReadOnly -VMName $vmName -ExpectedVMId $vmId -SpecName 'final-codex-attestation' -Arguments @{} -DestinationDir $privateEvidenceRoot
        @($copyResult.files_copied).Count | Should -Be 1
        Test-Path -LiteralPath (Join-Path $manifestOutputRootsPrivate 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') | Should -BeTrue

        # Closed
        $vmOff = Invoke-E1VmEnsureState -VMName $vmName -ExpectedVMId $vmId -TargetState 'Off'
        $vmOff.verdict | Should -BeExactly 'PASS'; $vmOff.state | Should -BeExactly 'Off'
        $netOffline = Invoke-E1NetworkEnsureMode -VMName $vmName -GuestCredentialPath $guestCredentialPath -TargetMode 'offline'
        $netOffline.verdict | Should -BeExactly 'PASS'; $netOffline.mode | Should -BeExactly 'offline'
        # Sourced from the manifest's own output_roots.public (Invoke-E1RunClosedState,
        # evidence1-run.ps1) -- NOT a <CampaignRoot>-relative hardcode.
        $publicEvidenceRoot = [string]$manifest.output_roots.public
        $publicEvidenceRoot | Should -BeExactly $manifestOutputRootsPublic
        $publish = Publish-E1ArtifactStoreSet -PrivateRoot $privateEvidenceRoot -PublicRoot $publicEvidenceRoot
        $publish.verdict | Should -BeExactly 'PASS'; $publish.state | Should -BeExactly 'committed'; $publish.artifact_count | Should -Be 1
        $publish.private_root | Should -BeExactly $manifestOutputRootsPrivate
        $publish.public_root | Should -BeExactly $manifestOutputRootsPublic
        Test-Path -LiteralPath (Join-Path $manifestOutputRootsPublic 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') | Should -BeTrue
    }
}

Describe 'Evidence1 Phase 4 rehearsal 2: Hyper-V VM preparation with fake providers (VmReady, its own registered check)' {
    # Replicates Invoke-E1RunVmReadyState (evidence1-run.ps1) exactly,
    # isolated from the rest of the campaign -- plan section 7 Phase 4 item
    # 2 asks for this as its own rehearsal, not merely one step folded into
    # the full-campaign test above. (Test-VmReadyLogic itself lives in the
    # root BeforeAll -- see its own comment there for why.)

    It 'hops a fresh fake VM from Off to Running, PASS, using exclusively the fake VmState backend' {
        $vmName = 'Evidence1FakeVM'; $vmId = [guid]::NewGuid().ToString()
        $result = Test-VmReadyLogic $vmName $vmId
        $result.verdict | Should -BeExactly 'PASS'
        $result.state | Should -BeExactly 'Running'
        # Wrapped exactly as Invoke-E1RunVmReadyState wraps it, to prove the
        # receipt this state would actually persist is well-formed.
        $receipt = New-E1RunStateReceipt -CampaignId ([guid]::NewGuid().ToString()) -StateName 'VmReady' -Verdict ([string]$result.verdict) -ReasonCode ([string]$result.reason_code) -Detail $result
        { Assert-E1RunStateReceiptShape $receipt } | Should -Not -Throw
    }

    It 'is idempotent -- a second Ensure(Running) against an already-Running fake VM is still PASS, not an error' {
        $vmName = 'Evidence1FakeVM'; $vmId = [guid]::NewGuid().ToString()
        Test-VmReadyLogic $vmName $vmId | Out-Null
        $second = Invoke-E1VmEnsureState -VMName $vmName -ExpectedVMId $vmId -TargetState 'Running'
        $second.verdict | Should -BeExactly 'PASS'
        $second.state | Should -BeExactly 'Running'
    }
}

Describe 'Evidence1 Phase 4 rehearsal 4: VM stop/start and network reseal (Closed''s VM/network prefix, its own registered check)' {
    # Replicates ONLY the VM-Off + network-offline prefix of
    # Invoke-E1RunClosedState (evidence1-run.ps1), isolated from the
    # publication step -- plan section 7 Phase 4 item 4's own rehearsal,
    # registered separately from the full-campaign test and from item 7's
    # publication-crash-recovery test below.
    It 'ensures VM Off and network offline from a live-adjacent starting state (VM Running, network restricted)' {
        $vmName = 'Evidence1FakeVM'; $vmId = [guid]::NewGuid().ToString()
        Set-E1FakeVmInitialState -VMName $vmName -VMId $vmId -State 'Running' | Out-Null
        Set-E1FakeNetworkInitialMode -VMName $vmName -VMId $vmId -Mode 'restricted' | Out-Null

        $vmResult = Invoke-E1VmEnsureState -VMName $vmName -ExpectedVMId $vmId -TargetState 'Off'
        $vmResult.verdict | Should -BeExactly 'PASS'
        $vmResult.state | Should -BeExactly 'Off'

        $networkResult = Invoke-E1NetworkEnsureMode -VMName $vmName -GuestCredentialPath '' -TargetMode 'offline'
        $networkResult.verdict | Should -BeExactly 'PASS'
        $networkResult.mode | Should -BeExactly 'offline'
    }
}

Describe 'Evidence1 Phase 4 rehearsal 3: host reboot/resume drill' {
    # Nothing in this environment can simulate an actual OS reboot -- this
    # tests the documented equivalent: a fresh process (a fresh Pester It
    # block, no shared state with any prior test) resuming from the same
    # CampaignId/StateRoot a "first invocation" already wrote durable PASS
    # receipts under. Get-E1RunResumeIndex itself is evidence1-run.ps1's
    # own top-level script code (not a module function), so it cannot be
    # called directly without executing the forbidden script -- replicated
    # in the root BeforeAll byte-for-byte from evidence1-run.ps1:502-512,
    # cited so the correspondence can be checked by reading, the same caveat
    # as every other replicated-logic test in this file.

    It 'resumes from the last durable PASS receipt, not from the beginning, after a simulated reboot' {
        $campaignId = [guid]::NewGuid().ToString()
        $campaignRoot = Join-Path 'C:\kmp-eval\scratch\pester-run-integration-tests\reboot-resume' ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $campaignRoot | Out-Null

        # "First invocation": writes real PASS receipts through
        # ToolchainReady (index 3 in Get-E1RunStateNames), exactly the shape
        # Write-E1RunStateReceiptAtomically produces.
        foreach ($stateName in @('BrokerReady', 'VmReady', 'ToolchainReady')) {
            $receipt = New-E1RunStateReceipt -CampaignId $campaignId -StateName $stateName -Verdict 'PASS' -Detail ([ordered]@{ fake = $true })
            Write-E1RunStateReceiptAtomically $campaignRoot $receipt
        }
        $beforeResumeTimestamps = @{}
        foreach ($stateName in @('BrokerReady', 'VmReady', 'ToolchainReady')) {
            $beforeResumeTimestamps[$stateName] = [string](Read-E1RunStateReceipt $campaignRoot $stateName).generated_at_utc
        }

        # "Reboot": a fresh resume-index computation against the SAME
        # CampaignId/StateRoot, nothing else carried over.
        $resumeIndex = Get-TestResumeIndex $campaignRoot $campaignId $false
        $allStates = Get-E1RunStateNames
        $resumeIndex | Should -Be ([array]::IndexOf($allStates, 'ToolchainReady')) -Because 'the last durable PASS receipt is ToolchainReady'
        $allStates[$resumeIndex + 1] | Should -BeExactly 'AuthReady' -Because 'the next invocation must continue from AuthReady, not restart at BrokerReady'

        # Prove "does not re-run completed states" concretely, not just via
        # the index arithmetic: simulate the second invocation processing
        # only AuthReady onward (a single new receipt), then confirm the
        # three earlier receipts are byte-for-byte the same generated_at_utc
        # as before -- nothing touched them.
        $newReceipt = New-E1RunStateReceipt -CampaignId $campaignId -StateName 'AuthReady' -Verdict 'PASS' -Detail ([ordered]@{ resumed = $true })
        Write-E1RunStateReceiptAtomically $campaignRoot $newReceipt
        foreach ($stateName in @('BrokerReady', 'VmReady', 'ToolchainReady')) {
            [string](Read-E1RunStateReceipt $campaignRoot $stateName).generated_at_utc | Should -BeExactly $beforeResumeTimestamps[$stateName] -Because "$stateName was already durably PASS and must not be re-run by the resumed invocation"
        }
        (Read-E1RunStateReceipt $campaignRoot 'AuthReady').verdict | Should -BeExactly 'PASS'
    }

    It 'resumes from the last GOOD receipt when the very next one is entirely missing (crash mid-write, not just mid-campaign)' {
        $campaignId = [guid]::NewGuid().ToString()
        $campaignRoot = Join-Path 'C:\kmp-eval\scratch\pester-run-integration-tests\reboot-resume' ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $campaignRoot | Out-Null
        $receipt = New-E1RunStateReceipt -CampaignId $campaignId -StateName 'BrokerReady' -Verdict 'PASS'
        Write-E1RunStateReceiptAtomically $campaignRoot $receipt
        # VmReady.receipt.json deliberately never written -- simulates a
        # crash after BrokerReady completed but before VmReady's own
        # receipt was durably persisted.
        $resumeIndex = Get-TestResumeIndex $campaignRoot $campaignId $false
        $allStates = Get-E1RunStateNames
        $resumeIndex | Should -Be ([array]::IndexOf($allStates, 'BrokerReady'))
        $allStates[$resumeIndex + 1] | Should -BeExactly 'VmReady' -Because 'the resumed invocation must retry VmReady, the state that never got a durable receipt, not skip past it'
    }
}

Describe 'Evidence1 Phase 4 rehearsal 7: crash between private/public artifact publication and recovery (manifest-driven output_roots)' {
    # Overnight work order item 6: "needs real coverage now that
    # output_roots actually matters" -- driven through an actual manifest's
    # output_roots.private/.public (as Invoke-E1RunClosedState now reads
    # them), not arbitrary scratch paths, closing the gap between this and
    # Evidence1-Artifact-Store-Fake.Tests.ps1's own (path-agnostic)
    # crash-recovery coverage.
    It 'recovers a leftover .staging directory left by a crash between the private copy and the atomic public rename' {
        $suffix = [guid]::NewGuid().ToString('N')
        $manifest = New-TestManifestObject -Override @{
            output_roots = [ordered]@{
                private = "C:\kmp-eval\scratch\pester-run-integration-tests\crash-recovery-$suffix\private"
                public  = "C:\kmp-eval\scratch\pester-run-integration-tests\crash-recovery-$suffix\public"
            }
        }
        $privateRoot = [string]$manifest.output_roots.private
        $publicRoot = [string]$manifest.output_roots.public
        New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null
        'evidence-bytes' | Set-Content -LiteralPath (Join-Path $privateRoot 'evidence.txt') -Encoding UTF8

        # Simulate the crash: a torn .staging directory left behind, as if
        # Publish-E1ArtifactStoreSet died after copying into staging but
        # before the atomic [IO.Directory]::Move to the public root.
        $stagingPath = "$publicRoot.staging"
        New-Item -ItemType Directory -Force -Path $stagingPath | Out-Null
        'PARTIAL, torn state from a simulated crash' | Set-Content -LiteralPath (Join-Path $stagingPath 'torn.txt') -Encoding UTF8
        Test-Path -LiteralPath $stagingPath | Should -BeTrue -Because 'sanity: the crash simulation actually created the torn state this test exists to prove recovery from'

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $privateRoot -PublicRoot $publicRoot
        $result.verdict | Should -BeExactly 'PASS'
        $result.state | Should -BeExactly 'committed'
        $result.recovered_torn_state | Should -BeTrue -Because 'a leftover .staging directory was present before this call'
        $result.private_root | Should -BeExactly $privateRoot
        $result.public_root | Should -BeExactly $publicRoot
        Test-Path -LiteralPath $stagingPath | Should -BeFalse -Because 'the torn staging directory must be gone after recovery'
        Test-Path -LiteralPath (Join-Path $publicRoot 'evidence.txt') | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $publicRoot 'torn.txt') | Should -BeFalse -Because 'torn staging content must never leak into the committed public root'
    }

    It 'recovers an unmatched transaction record left by a crash after the transaction was written but before the ready marker' {
        $suffix = [guid]::NewGuid().ToString('N')
        $manifest = New-TestManifestObject -Override @{
            output_roots = [ordered]@{
                private = "C:\kmp-eval\scratch\pester-run-integration-tests\crash-recovery-$suffix\private"
                public  = "C:\kmp-eval\scratch\pester-run-integration-tests\crash-recovery-$suffix\public"
            }
        }
        $privateRoot = [string]$manifest.output_roots.private
        $publicRoot = [string]$manifest.output_roots.public
        New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null
        'evidence-bytes' | Set-Content -LiteralPath (Join-Path $privateRoot 'evidence.txt') -Encoding UTF8

        # Simulate the crash: a transaction record with no matching ready
        # marker, as if the process died between writing the transaction and
        # writing the ready marker (after the atomic rename itself, which
        # evidence1-artifact-store-fake.psm1's own sequence places BEFORE
        # the ready marker -- see that module's own protocol comment).
        $transactionPath = "$publicRoot.publication.transaction.json"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $transactionPath) | Out-Null
        '{"schema":1,"artifact_count":1,"created_at_utc":"2026-01-01T00:00:00.000Z"}' | Set-Content -LiteralPath $transactionPath -Encoding UTF8
        Test-Path -LiteralPath $transactionPath | Should -BeTrue -Because 'sanity: the crash simulation actually created the torn transaction record'

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $privateRoot -PublicRoot $publicRoot
        $result.verdict | Should -BeExactly 'PASS'
        $result.state | Should -BeExactly 'committed'
        $result.recovered_torn_state | Should -BeTrue -Because 'an unmatched transaction record was present before this call'
        Test-Path -LiteralPath (Join-Path $publicRoot 'evidence.txt') | Should -BeTrue
        Test-Path -LiteralPath "$publicRoot.publication.ready.json" | Should -BeTrue -Because 'a clean commit must leave a fresh ready marker behind'
    }

    It 'a clean run with no torn state reports recovered_torn_state = false (the negative case, proving the flag is not always true)' {
        $suffix = [guid]::NewGuid().ToString('N')
        $manifest = New-TestManifestObject -Override @{
            output_roots = [ordered]@{
                private = "C:\kmp-eval\scratch\pester-run-integration-tests\crash-recovery-$suffix\private"
                public  = "C:\kmp-eval\scratch\pester-run-integration-tests\crash-recovery-$suffix\public"
            }
        }
        $privateRoot = [string]$manifest.output_roots.private
        $publicRoot = [string]$manifest.output_roots.public
        New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null
        'evidence-bytes' | Set-Content -LiteralPath (Join-Path $privateRoot 'evidence.txt') -Encoding UTF8

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $privateRoot -PublicRoot $publicRoot
        $result.recovered_torn_state | Should -BeFalse
    }
}

Describe 'Evidence1 LiveRunning cell cardinality (overnight work order item 2)' {
    It 'dispatches exactly one session per expected cell for a single-runtime manifest, proving 2 runtimes is not hardcoded in the dispatch path' {
        $manifest = New-TestManifestObject -Override @{
            runtimes = @([ordered]@{ runtime_id = 'codex-cli'; model_id = 'gpt-5.6-terra'; campaign_design_id = 'codex-product-vs-free-baseline-v1'; campaign_cell_indices = @(0, 1, 2, 3, 4, 5); max_budget_usd = $null })
            round_order = @('product', 'free', 'free', 'product', 'product', 'free')
            max_session_count = 6
        }
        $cells = @(Get-E1RunManifestExpectedCells $manifest)
        $cells.Count | Should -Be 6
        $sessions = @()
        foreach ($cell in $cells) {
            $sessions += Invoke-E1ProviderRuntimeSession -RuntimeId ([string]$cell.runtime_id) -ModelId ([string]$cell.model_id) `
              -RoundIndex ([int]$cell.round_index) -ScenarioSha256 ([string]$manifest.scenario_id) -PromptSha256 ([string]$cell.campaign_design_id)
        }
        $sessions.Count | Should -Be 6
        (@($sessions | ForEach-Object { $_.runtime_id } | Sort-Object -Unique)) -join ',' | Should -BeExactly 'codex-cli'
        @($sessions | Where-Object { $_.verdict -cne 'PASS' }).Count | Should -Be 0
    }

    It 'a manifest whose max_session_count is too low for the derived cell count is rejected before LiveRunning ever dispatches anything' {
        { New-TestManifestObject -Override @{
            max_session_count = 3
        } } | Should -Throw '*run_manifest_max_session_count_below_round_order*'
    }
}

Describe 'Evidence1 LiveRunning/EvidenceCopied: a session missing benchmark_status must not crash (2026-09-28 live hang)' {
    # evidence1-run.ps1 cannot be dot-sourced here (its top-level body would execute -- see this
    # file's own top BeforeAll comment); Get-E1SafeBenchmarkStatus is extracted from the real source
    # text and evaluated in isolation instead, the same "read the source, don't execute the script"
    # discipline the trust-root-portability Describe below already uses via $script:RunScriptSource.
    BeforeAll {
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $runScriptSource = (Get-Content -LiteralPath (Join-Path $repoRoot 'evidence1-run.ps1') -Raw) -replace "`r`n", "`n"
        $script:LiveRunningFixSource = $runScriptSource
        $start = $runScriptSource.IndexOf('function Get-E1SafeBenchmarkStatus')
        if ($start -lt 0) { throw 'Get-E1SafeBenchmarkStatus not found in evidence1-run.ps1 -- fix not applied' }
        $end = $runScriptSource.IndexOf("`n}`n", $start)
        if ($end -lt 0) { throw 'could not isolate the end of Get-E1SafeBenchmarkStatus' }
        # Evaluated into THIS scope only -- a bare function definition has no top-level side effects
        # to worry about, unlike dot-sourcing the whole script.
        Invoke-Expression ($runScriptSource.Substring($start, $end - $start + 2))
    }

    It '(RED proof) the ORIGINAL unsafe pattern really does throw under Set-StrictMode -- reproduces the live crash exactly' {
        {
            & {
                Set-StrictMode -Version Latest
                $outputSummary = [ordered]@{ worker_output_present = $false }
                [string]$outputSummary.benchmark_status
            }
        } | Should -Throw '*benchmark_status*'
    }

    It '(GREEN) Get-E1SafeBenchmarkStatus returns $null for a session with no benchmark_status key, instead of throwing' {
        & {
            Set-StrictMode -Version Latest
            $outputSummary = [ordered]@{ worker_output_present = $false }
            Get-E1SafeBenchmarkStatus $outputSummary
        } | Should -BeNullOrEmpty
    }

    It 'Get-E1SafeBenchmarkStatus still returns the real value when the key IS present (both accepted and rejected)' {
        & { Set-StrictMode -Version Latest; Get-E1SafeBenchmarkStatus ([ordered]@{ benchmark_status = 'accepted' }) } | Should -BeExactly 'accepted'
        & { Set-StrictMode -Version Latest; Get-E1SafeBenchmarkStatus ([ordered]@{ benchmark_status = 'rejected' }) } | Should -BeExactly 'rejected'
    }

    It 'Get-E1SafeBenchmarkStatus is null-safe on a $null OutputSummary too (belt-and-suspenders, not just the missing-key case)' {
        & { Set-StrictMode -Version Latest; Get-E1SafeBenchmarkStatus $null } | Should -BeNullOrEmpty
    }

    It 'a session missing benchmark_status is not counted as a semantic rejection (LiveRunning''s own semanticRejectionCount formula, replicated)' {
        $sessions = @(
            [ordered]@{ output_summary = [ordered]@{ benchmark_status = 'accepted' } }
            [ordered]@{ output_summary = [ordered]@{ worker_output_present = $false } }
            [ordered]@{ output_summary = [ordered]@{ benchmark_status = 'rejected' } }
        )
        $semanticRejectionCount = @($sessions | Where-Object { (Get-E1SafeBenchmarkStatus $_.output_summary) -ceq 'rejected' }).Count
        $semanticRejectionCount | Should -Be 1
    }

    It 'both LiveRunning and EvidenceCopied''s benchmark_status reads in the real source now go through the safe accessor, not raw property access' {
        $script:LiveRunningFixSource | Should -Match ([regex]::Escape('$semanticRejectionCount = @($sessions | Where-Object { (Get-E1SafeBenchmarkStatus $_.output_summary) -ceq ''rejected'' }).Count'))
        $script:LiveRunningFixSource | Should -Match ([regex]::Escape('$benchmarkStatus = Get-E1SafeBenchmarkStatus $matchingSessions[0].output_summary'))
        $script:LiveRunningFixSource | Should -Not -Match ([regex]::Escape('[string]$_.output_summary.benchmark_status'))
        $script:LiveRunningFixSource | Should -Not -Match ([regex]::Escape('[string]$matchingSessions[0].output_summary.benchmark_status'))
    }
}

Describe 'Evidence1 failure-safe closure attempt on a mid-campaign crash (2026-09-28 no-closure-on-failure gap)' {
    # Same "read the source, don't execute the script" discipline as the benchmark_status Describe
    # above -- evidence1-run.ps1 cannot be dot-sourced (its top-level body would execute).
    BeforeAll {
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $runScriptSource = (Get-Content -LiteralPath (Join-Path $repoRoot 'evidence1-run.ps1') -Raw) -replace "`r`n", "`n"
        $script:FailureSafeClosureFixSource = $runScriptSource
        $start = $runScriptSource.IndexOf('function Invoke-E1RunFailureSafeClosureAttempt')
        if ($start -lt 0) { throw 'Invoke-E1RunFailureSafeClosureAttempt not found in evidence1-run.ps1 -- fix not applied' }
        $end = $runScriptSource.IndexOf("`n}`n", $start)
        if ($end -lt 0) { throw 'could not isolate the end of Invoke-E1RunFailureSafeClosureAttempt' }
        Invoke-Expression ($runScriptSource.Substring($start, $end - $start + 2))

        # P0 #5: Invoke-E1RunFailureSafeClosureAttempt now calls this sibling function directly
        # (a real, non-Import-Module call, resolved from the current scope at call time) --
        # extracted separately here for the exact same reason as every other function this file
        # pulls out of evidence1-run.ps1's own source: it is script-level code, not a module
        # function, and this file may never dot-source the script itself.
        $evidenceCopyStart = $runScriptSource.IndexOf('function Invoke-E1RunFailureSafeEvidenceCopyAttempt')
        if ($evidenceCopyStart -lt 0) { throw 'Invoke-E1RunFailureSafeEvidenceCopyAttempt not found in evidence1-run.ps1 -- fix not applied' }
        $evidenceCopyEnd = $runScriptSource.IndexOf("`n}`n", $evidenceCopyStart)
        if ($evidenceCopyEnd -lt 0) { throw 'could not isolate the end of Invoke-E1RunFailureSafeEvidenceCopyAttempt' }
        Invoke-Expression ($runScriptSource.Substring($evidenceCopyStart, $evidenceCopyEnd - $evidenceCopyStart + 2))

        # Invoke-E1RunFailureSafeEvidenceCopyAttempt's tier-1 path calls this too (same
        # already-established extraction technique; see the "benchmark_status" Describe elsewhere
        # in this file for its own independent use of the identical citation).
        $benchmarkStatusStart = $runScriptSource.IndexOf('function Get-E1SafeBenchmarkStatus')
        if ($benchmarkStatusStart -lt 0) { throw 'Get-E1SafeBenchmarkStatus not found in evidence1-run.ps1 -- fix not applied' }
        $benchmarkStatusEnd = $runScriptSource.IndexOf("`n}`n", $benchmarkStatusStart)
        if ($benchmarkStatusEnd -lt 0) { throw 'could not isolate the end of Get-E1SafeBenchmarkStatus' }
        Invoke-Expression ($runScriptSource.Substring($benchmarkStatusStart, $benchmarkStatusEnd - $benchmarkStatusStart + 2))

        # Explicit rather than relying on evidence1-artifact-copy-fake.psm1's own transitive import
        # of this module (already imported at this file's top level) to also make
        # Assert-E1ArtifactCopyResultShape callable from here -- not empirically confirmed either
        # way, and this Describe block never uses the fake backend directly (it shadows
        # Copy-E1ArtifactsReadOnly itself, same style as its network/VM shadows above), so nothing
        # else in this file guarantees this import already happened.
        Import-Module (Join-Path $script:AuditsRoot 'evidence1-artifact-copy-contract.psm1') -Force -DisableNameChecking
    }

    It '(M1 RED/GREEN) both calls pass a bounded -TimeoutMinutes instead of falling through to each function''s own 120-minute default' {
        # RED on 70fe951: neither call passed -TimeoutMinutes at all, so these stubs would capture
        # their own -1 sentinel default, not a real caller-supplied value -- both assertions below
        # would fail. GREEN once evidence1-run.ps1 passes -TimeoutMinutes 10 explicitly to both.
        $script:E1TestCapturedNetworkTimeoutMinutes = -1
        $script:E1TestCapturedVmTimeoutMinutes = -1
        function Get-E1RunRealTransportArguments { @{} }
        function Invoke-E1NetworkEnsureMode {
            param($VMName, $GuestCredentialPath, $TargetMode, [int]$TimeoutMinutes = -1)
            $script:E1TestCapturedNetworkTimeoutMinutes = $TimeoutMinutes
            [ordered]@{ verdict = 'PASS' }
        }
        function Invoke-E1VmEnsureState {
            param($VMName, $ExpectedVMId, $TargetState, [int]$TimeoutMinutes = -1)
            $script:E1TestCapturedVmTimeoutMinutes = $TimeoutMinutes
            [ordered]@{ verdict = 'PASS' }
        }
        $context = [ordered]@{ UseRealBackends = $true; VMName = 'x'; VMId = 'y'; GuestCredentialPath = 'z' }
        Invoke-E1RunFailureSafeClosureAttempt $context | Out-Null
        ($script:E1TestCapturedNetworkTimeoutMinutes -ge 0 -and $script:E1TestCapturedNetworkTimeoutMinutes -le 10) | Should -BeTrue
        ($script:E1TestCapturedVmTimeoutMinutes -ge 0 -and $script:E1TestCapturedVmTimeoutMinutes -le 10) | Should -BeTrue
    }

    It '(GREEN) never throws even when every real capability call throws, and records each failure distinctly' {
        function Get-E1RunRealTransportArguments { @{} }
        function Invoke-E1NetworkEnsureMode { param($VMName, $GuestCredentialPath, $TargetMode) throw 'network_backend_unreachable' }
        function Invoke-E1VmEnsureState { param($VMName, $ExpectedVMId, $TargetState) throw 'vm_backend_unreachable' }
        $context = [ordered]@{ UseRealBackends = $true; VMName = 'Evidence1-Runner-E2E'; VMId = 'fake-vm-id'; GuestCredentialPath = 'C:\fake\cred.clixml' }
        # Direct assignment, not `{ $result = ... } | Should -Not -Throw` -- that idiom invokes the
        # scriptblock in its OWN child scope, so the assignment never reaches this $result at all
        # (confirmed empirically while writing this test: every field silently read back $null). An
        # unexpected throw here fails the It block on its own, which already proves the same thing.
        $result = Invoke-E1RunFailureSafeClosureAttempt $context
        $result.network_result.reason_code | Should -BeExactly 'failure_safe_network_attempt_threw'
        $result.network_result.error | Should -Match 'network_backend_unreachable'
        $result.vm_result.reason_code | Should -BeExactly 'failure_safe_vm_attempt_threw'
        $result.vm_result.error | Should -Match 'vm_backend_unreachable'
    }

    It 'records both underlying results as-is when the capability calls succeed' {
        function Get-E1RunRealTransportArguments { @{} }
        function Invoke-E1NetworkEnsureMode { param($VMName, $GuestCredentialPath, $TargetMode) [ordered]@{ verdict = 'PASS' } }
        function Invoke-E1VmEnsureState { param($VMName, $ExpectedVMId, $TargetState) [ordered]@{ verdict = 'PASS' } }
        $context = [ordered]@{ UseRealBackends = $true; VMName = 'x'; VMId = 'y'; GuestCredentialPath = 'z' }
        $result = Invoke-E1RunFailureSafeClosureAttempt $context
        $result.network_result.verdict | Should -BeExactly 'PASS'
        $result.vm_result.verdict | Should -BeExactly 'PASS'
        $result.error | Should -BeNullOrEmpty
    }

    It 'is a no-op in fake-backend mode -- never touches real transport at all' {
        function Get-E1RunRealTransportArguments { throw 'must not be called in fake mode' }
        $context = [ordered]@{ UseRealBackends = $false }
        $result = Invoke-E1RunFailureSafeClosureAttempt $context
        $result.error | Should -BeExactly 'skipped_fake_backend'
        $result.network_result | Should -BeNullOrEmpty
        $result.vm_result | Should -BeNullOrEmpty
    }

    It 'also survives Get-E1RunRealTransportArguments itself throwing (e.g. broker_deployment_root_unavailable)' {
        function Get-E1RunRealTransportArguments { throw 'broker_deployment_root_unavailable' }
        $context = [ordered]@{ UseRealBackends = $true; VMName = 'x'; VMId = 'y'; GuestCredentialPath = 'z' }
        $result = Invoke-E1RunFailureSafeClosureAttempt $context
        $result.error | Should -Match 'broker_deployment_root_unavailable'
        $result.network_result | Should -BeNullOrEmpty
        $result.vm_result | Should -BeNullOrEmpty
    }

    It 'the main loop wires this in from VmReady onward only, and can never let it overwrite the original failure reason (source-level check)' {
        $script:FailureSafeClosureFixSource | Should -Match ([regex]::Escape('$lastAttemptedIndex = $resumeIndex'))
        $script:FailureSafeClosureFixSource | Should -Match ([regex]::Escape('$lastAttemptedIndex = $i'))
        $script:FailureSafeClosureFixSource | Should -Match ([regex]::Escape('$vmReadyIndex = [array]::IndexOf($AllStates, ''VmReady'')'))
        $script:FailureSafeClosureFixSource | Should -Match ([regex]::Escape('if ($vmReadyIndex -ge 0 -and $lastAttemptedIndex -ge $vmReadyIndex) {'))
        $script:FailureSafeClosureFixSource | Should -Match ([regex]::Escape('$Report.failure_safe_closure = Invoke-E1RunFailureSafeClosureAttempt $Context'))
        # $Report.reason must already be assigned before the closure-attempt call is ever reached,
        # so a throw inside the attempt (belt-and-suspenders outer catch) can never replace it.
        $reasonIndex = $script:FailureSafeClosureFixSource.IndexOf('$Report.reason = [string]$_.Exception.Message')
        $closureCallIndex = $script:FailureSafeClosureFixSource.IndexOf('$Report.failure_safe_closure = Invoke-E1RunFailureSafeClosureAttempt $Context')
        $reasonIndex | Should -BeGreaterThan 0
        $closureCallIndex | Should -BeGreaterThan $reasonIndex
    }

    It 'does not write an $AllStates-shaped Closed receipt -- Get-E1RunResumeIndex must not be able to mistake a best-effort attempt for a verified PASS' {
        $script:FailureSafeClosureFixSource | Should -Not -Match ([regex]::Escape("-StateName 'Closed'`n") + '.*Invoke-E1RunFailureSafeClosureAttempt')
        $funcStart = $script:FailureSafeClosureFixSource.IndexOf('function Invoke-E1RunFailureSafeClosureAttempt')
        $funcEnd = $script:FailureSafeClosureFixSource.IndexOf("`n}`n", $funcStart)
        $funcBody = $script:FailureSafeClosureFixSource.Substring($funcStart, $funcEnd - $funcStart)
        $funcBody | Should -Not -Match 'New-E1RunStateReceipt'
        $funcBody | Should -Not -Match 'Write-E1RunStateReceiptAtomically'
    }

    # P0 #5 (publication hardening, auditor-directed): "evidence from a failed LiveRunning reaches
    # the host automatically" -- see Invoke-E1RunFailureSafeEvidenceCopyAttempt's own header
    # (evidence1-run.ps1) for the two-tier design these tests exercise.
    Context 'evidence_copy (P0 #5)' {
        BeforeAll {
            function New-TestFailureSafeContext([switch]$WithManifest) {
                $campaignRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
                New-Item -ItemType Directory -Force -Path $campaignRoot | Out-Null
                $manifest = if ($WithManifest) { New-TestManifestObject } else { $null }
                return [ordered]@{
                    UseRealBackends        = $true
                    VMName                 = 'Evidence1-Runner-E2E'
                    VMId                   = [guid]::NewGuid().ToString()
                    GuestCredentialPath    = 'C:\fake\cred.clixml'
                    Manifest               = $manifest
                    CampaignRoot           = $campaignRoot
                    OutputRootsTrustedRoot = 'C:\kmp-eval\scratch\'
                }
            }
            # The 4 expected cells New-TestManifestObject's own default manifest resolves to
            # (2 runtimes x 2 rounds, round 1 reversed per Get-E1RunManifestExpectedCells' own D7
            # Host closure keys use the global campaign indices; guest copy requests remain local.
            $script:ExpectedCellKeys = @('codex-cli-0', 'claude-code-2', 'claude-code-3', 'codex-cli-1')
        }

        It 'skips with no_manifest and never calls the copy capability when the context has no manifest at all' {
            function Get-E1RunRealTransportArguments { @{} }
            function Invoke-E1NetworkEnsureMode { param($VMName, $GuestCredentialPath, $TargetMode) [ordered]@{ verdict = 'PASS' } }
            function Invoke-E1VmEnsureState { param($VMName, $ExpectedVMId, $TargetState) [ordered]@{ verdict = 'PASS' } }
            function Copy-E1ArtifactsReadOnly { throw 'must not be called when there is no manifest' }
            $context = New-TestFailureSafeContext
            $result = Invoke-E1RunFailureSafeClosureAttempt $context
            $result.evidence_copy.attempted | Should -BeFalse
            $result.evidence_copy.skipped_reason | Should -BeExactly 'no_manifest'
        }

        It 'skips with vm_not_confirmed_off and never calls the copy capability when the VM could not be confirmed Off' {
            function Get-E1RunRealTransportArguments { @{} }
            function Invoke-E1NetworkEnsureMode { param($VMName, $GuestCredentialPath, $TargetMode) [ordered]@{ verdict = 'PASS' } }
            function Invoke-E1VmEnsureState { param($VMName, $ExpectedVMId, $TargetState) [ordered]@{ verdict = 'FAIL'; reason_code = 'vm_state_stop_timeout' } }
            function Copy-E1ArtifactsReadOnly { throw 'must not be called when the VM is not confirmed Off' }
            $context = New-TestFailureSafeContext -WithManifest
            $result = Invoke-E1RunFailureSafeClosureAttempt $context
            $result.evidence_copy.attempted | Should -BeFalse
            $result.evidence_copy.skipped_reason | Should -BeExactly 'vm_not_confirmed_off'
        }

        It '(tier 2: no LiveRunning receipt) attempts agentic-eval-session-record per cell, best-effort -- a cell already recorded PASSes, a cell never recorded is a recorded miss, not a fatal error' {
            function Get-E1RunRealTransportArguments { @{} }
            function Invoke-E1NetworkEnsureMode { param($VMName, $GuestCredentialPath, $TargetMode) [ordered]@{ verdict = 'PASS' } }
            function Invoke-E1VmEnsureState { param($VMName, $ExpectedVMId, $TargetState) [ordered]@{ verdict = 'PASS' } }
            $script:E1TestCapturedCopyTimeoutMinutes = @()
            # Only 2 of the 4 expected cells had actually been recorded before the failure --
            # matches the real fake backend's own artifact_copy_required_source_missing throw
            # shape (evidence1-artifact-copy-fake.psm1) for the other 2.
            function Copy-E1ArtifactsReadOnly {
                param($VMName, $ExpectedVMId, $SpecName, $Arguments, $DestinationDir, $TrustedRoot, [int]$TimeoutMinutes = -1)
                $script:E1TestCapturedCopyTimeoutMinutes += $TimeoutMinutes
                if ($Arguments.CellKey -cin @('codex-cli-0', 'claude-code-1')) {
                    return [ordered]@{ files_copied = @('audit.json', 'record.json') }
                }
                throw "artifact_copy_required_source_missing: record.json"
            }
            $context = New-TestFailureSafeContext -WithManifest
            $result = Invoke-E1RunFailureSafeClosureAttempt $context
            $copy = $result.evidence_copy
            $copy.attempted | Should -BeTrue
            $copy.tier | Should -BeExactly 'best_effort_session_record_only'
            $copy.live_running_available | Should -BeFalse
            $copy.results.Count | Should -Be 4
            ($copy.results | ForEach-Object { $_.cell_key } | Sort-Object) | Should -Be ($script:ExpectedCellKeys | Sort-Object)
            foreach ($entry in ($copy.results | Where-Object { $_.cell_key -cin @('codex-cli-0', 'claude-code-3') })) {
                $entry.verdict | Should -BeExactly 'PASS'
                $entry.spec_name | Should -BeExactly 'agentic-eval-session-record'
                $entry.files_copied | Should -Be @('audit.json', 'record.json')
            }
            foreach ($entry in ($copy.results | Where-Object { $_.cell_key -cin @('claude-code-2', 'codex-cli-1') })) {
                $entry.verdict | Should -BeExactly 'FAIL'
                $entry.error | Should -Match 'artifact_copy_required_source_missing'
            }
            # Bounded, same discipline as the network/VM calls above (M1 RED/GREEN) -- a best-effort
            # attempt must never risk each cell's own full 120-minute default.
            foreach ($captured in $script:E1TestCapturedCopyTimeoutMinutes) { ($captured -ge 0 -and $captured -le 10) | Should -BeTrue }
            # The outer closure attempt's own error/network/vm fields are unaffected by per-cell
            # copy misses -- a partial evidence recovery must never look like a whole-function error.
            $result.error | Should -BeNullOrEmpty
            $result.network_result.verdict | Should -BeExactly 'PASS'
            $result.vm_result.verdict | Should -BeExactly 'PASS'
        }

        It '(tier 1: complete LiveRunning receipt) copies the accepted-vs-rejected spec per cell exactly like EvidenceCopied itself would have' {
            function Get-E1RunRealTransportArguments { @{} }
            function Invoke-E1NetworkEnsureMode { param($VMName, $GuestCredentialPath, $TargetMode) [ordered]@{ verdict = 'PASS' } }
            function Invoke-E1VmEnsureState { param($VMName, $ExpectedVMId, $TargetState) [ordered]@{ verdict = 'PASS' } }
            $script:E1TestCapturedCopySpecCalls = @()
            function Copy-E1ArtifactsReadOnly {
                param($VMName, $ExpectedVMId, $SpecName, $Arguments, $DestinationDir, $TrustedRoot, [int]$TimeoutMinutes = -1)
                $script:E1TestCapturedCopySpecCalls += [ordered]@{ cell_key = $Arguments.CellKey; spec_name = $SpecName; rejection_id = $Arguments.RejectionId }
                [ordered]@{ files_copied = @('audit.json', 'record.json') }
            }
            $context = New-TestFailureSafeContext -WithManifest
            $rejectionId = [guid]::NewGuid().ToString()
            $sessions = @(
                [ordered]@{ runtime_id = 'codex-cli'; round_index = 0; output_summary = [ordered]@{ benchmark_status = 'accepted' } }
                [ordered]@{ runtime_id = 'claude-code'; round_index = 0; output_summary = [ordered]@{ benchmark_status = 'accepted' } }
                [ordered]@{ runtime_id = 'claude-code'; round_index = 1; output_summary = [ordered]@{ benchmark_status = 'rejected'; rejection_id = $rejectionId } }
                [ordered]@{ runtime_id = 'codex-cli'; round_index = 1; output_summary = [ordered]@{ benchmark_status = 'accepted' } }
            )
            $liveReceipt = New-E1RunStateReceipt -CampaignId ([string]$context.Manifest.campaign_id) -StateName 'LiveRunning' `
              -Verdict 'FAIL' -ReasonCode 'one_or_more_provider_sessions_failed' -Detail ([ordered]@{ sessions = $sessions })
            Write-E1RunStateReceiptAtomically $context.CampaignRoot $liveReceipt

            $result = Invoke-E1RunFailureSafeClosureAttempt $context
            $copy = $result.evidence_copy
            $copy.tier | Should -BeExactly 'live_running_session_status'
            $copy.live_running_available | Should -BeTrue
            $copy.results.Count | Should -Be 4

            $rejectedCall = $script:E1TestCapturedCopySpecCalls | Where-Object { $_.cell_key -ceq 'claude-code-1' }
            $rejectedCall.spec_name | Should -BeExactly 'agentic-eval-rejection-diagnostic'
            $rejectedCall.rejection_id | Should -BeExactly $rejectionId
            $rejectedResult = $copy.results | Where-Object { $_.cell_key -ceq 'claude-code-3' }
            $rejectedResult.benchmark_status | Should -BeExactly 'rejected'
            $rejectedResult.verdict | Should -BeExactly 'PASS'

            foreach ($cellKey in @('codex-cli-0', 'claude-code-2', 'codex-cli-1')) {
                $guestCellKey = if ($cellKey -ceq 'claude-code-2') { 'claude-code-0' } else { $cellKey }
                $call = $script:E1TestCapturedCopySpecCalls | Where-Object { $_.cell_key -ceq $guestCellKey }
                $call.spec_name | Should -BeExactly 'agentic-eval-session-record'
                $entry = $copy.results | Where-Object { $_.cell_key -ceq $cellKey }
                $entry.benchmark_status | Should -BeExactly 'accepted'
                $entry.verdict | Should -BeExactly 'PASS'
            }
        }

        It 'never lets a copy capability that always throws propagate past the closure attempt -- every cell is recorded FAIL, nothing rethrows' {
            function Get-E1RunRealTransportArguments { @{} }
            function Invoke-E1NetworkEnsureMode { param($VMName, $GuestCredentialPath, $TargetMode) [ordered]@{ verdict = 'PASS' } }
            function Invoke-E1VmEnsureState { param($VMName, $ExpectedVMId, $TargetState) [ordered]@{ verdict = 'PASS' } }
            function Copy-E1ArtifactsReadOnly { throw 'broker_deployment_root_unavailable' }
            $context = New-TestFailureSafeContext -WithManifest
            $result = Invoke-E1RunFailureSafeClosureAttempt $context
            $copy = $result.evidence_copy
            $copy.results.Count | Should -Be 4
            foreach ($entry in $copy.results) {
                $entry.verdict | Should -BeExactly 'FAIL'
                $entry.error | Should -Match 'broker_deployment_root_unavailable'
            }
            $copy.error | Should -BeNullOrEmpty
            $result.error | Should -BeNullOrEmpty
        }
    }
}

Describe 'Evidence1 broker stall recovery on a hung dispatch (2026-09-28 orphan-runner incident, items 2-3)' {
    BeforeAll {
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $runScriptSource = (Get-Content -LiteralPath (Join-Path $repoRoot 'evidence1-run.ps1') -Raw) -replace "`r`n", "`n"
        $script:StallRecoveryFixSource = $runScriptSource
        $start = $runScriptSource.IndexOf('function Invoke-E1RunBrokerStallRecoveryAttempt')
        if ($start -lt 0) { throw 'Invoke-E1RunBrokerStallRecoveryAttempt not found in evidence1-run.ps1 -- fix not applied' }
        $end = $runScriptSource.IndexOf("`n}`n", $start)
        if ($end -lt 0) { throw 'could not isolate the end of Invoke-E1RunBrokerStallRecoveryAttempt' }
        Invoke-Expression ($runScriptSource.Substring($start, $end - $start + 2))

        # A fresh, TestDrive-scoped queue layout per test -- never the real
        # C:\kmp-eval\scratch\host-elevated-runner-codex\. Get-E1BrokerCapabilityDefaultQueueRoot
        # is stubbed locally inside each It block (same dynamic-scope-shadowing this file's own
        # failure-safe-closure tests already rely on, confirmed empirically there) to point here
        # instead, so this function's real Get-ChildItem/Move-Item calls can never reach the real
        # broker queue no matter what this function does internally.
        function New-TestBrokerQueueLayout {
            $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
            foreach ($sub in 'requests', 'in-progress', 'logs', 'stale') {
                New-Item -ItemType Directory -Force -Path (Join-Path $root $sub) | Out-Null
            }
            return $root
        }

        function New-TestOuterRequestFile([string]$Dir, [string]$Id) {
            $path = Join-Path $Dir "$Id.request.json"
            ([ordered]@{ id = $Id; created_at_utc = '2026-09-28T02:15:42.000Z' } | ConvertTo-Json) |
                Set-Content -LiteralPath $path -Encoding UTF8
            return $path
        }
    }

    It 'is a no-op on a clean queue, regardless of what the reason says -- trigger is state-based, not message-based (R1 fix)' {
        $queueRoot = New-TestBrokerQueueLayout
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        $context = [ordered]@{ UseRealBackends = $true }
        $script:E1TestEndTaskCalled = $false
        $fakeEndTask = { param($TaskName) $script:E1TestEndTaskCalled = $true; [ordered]@{ end_exit_code = 0; stopped = $true } }
        # Deliberately an unrelated reason -- proves the empty queue, not a matched string, is why this is a no-op.
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'state_failed: DryRunPassed (dry_run_product_smoke_failed)' $fakeEndTask
        $recovery.triggered | Should -BeFalse
        $script:E1TestEndTaskCalled | Should -BeFalse
        $recovery.moved.Count | Should -Be 0
    }

    It 'is a no-op in fake-backend mode even with a stale request present' {
        $context = [ordered]@{ UseRealBackends = $false }
        function Get-E1BrokerCapabilityDefaultQueueRoot { throw 'must not be called in fake mode' }
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'anything'
        $recovery.triggered | Should -BeFalse
        $recovery.error | Should -BeExactly 'skipped_fake_backend'
    }

    It '(R1 fix, RED on f0db67d / GREEN after) triggers on the queue state alone, even with the generic wrapped reason the live path actually produces' {
        # This is the exact reason evidence1-provider-runtime-real.psm1's own catch block produces
        # on the live dispatch path -- broker_request_stalled/not_picked_up never survives that far
        # (see this function's own header comment for the confirmed call chain). f0db67d's
        # $Reason -cnotmatch '^broker_request_(stalled|not_picked_up)' gate would have returned
        # triggered=$false here, exactly reproducing the 2026-09-28 incident. This must trigger
        # anyway, from the queue state alone.
        $queueRoot = New-TestBrokerQueueLayout
        New-TestOuterRequestFile (Join-Path $queueRoot 'in-progress') 'req-20260928-021542-edbd6f57' | Out-Null
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        $context = [ordered]@{ UseRealBackends = $true }
        $script:E1TestEndTaskCalled = $false
        $fakeEndTask = { param($TaskName) $script:E1TestEndTaskCalled = $true; [ordered]@{ end_exit_code = 0; stopped = $true } }
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'state_failed: LiveRunning (one_or_more_provider_sessions_failed)' $fakeEndTask

        $recovery.triggered | Should -BeTrue
        $script:E1TestEndTaskCalled | Should -BeTrue
        $staleFiles = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'stale') -File)
        $staleFiles.Count | Should -Be 1
        $staleFiles[0].Name | Should -Match '^\d{8}-\d{4}\.in-progress\.req-20260928-021542-edbd6f57\.stalled-before-log\.request\.json$'
    }

    It '(R1 fix) same, for a request still in requests/ -- withdrawn-not-picked-up, same generic wrapped reason' {
        $queueRoot = New-TestBrokerQueueLayout
        New-TestOuterRequestFile (Join-Path $queueRoot 'requests') 'req-20260928-100000-aaaaaaaa' | Out-Null
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        $context = [ordered]@{ UseRealBackends = $true }
        $fakeEndTask = { param($TaskName) [ordered]@{ end_exit_code = 0; stopped = $true } }
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'state_failed: LiveRunning (one_or_more_provider_sessions_failed)' $fakeEndTask

        $recovery.triggered | Should -BeTrue
        $staleFiles = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'stale') -File)
        $staleFiles.Count | Should -Be 1
        $staleFiles[0].Name | Should -Match '^\d{8}-\d{4}\.requests\.req-20260928-100000-aaaaaaaa\.withdrawn-not-picked-up\.request\.json$'
    }

    It 'records the reason it was called with even though the reason no longer gates anything' {
        $queueRoot = New-TestBrokerQueueLayout
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        $context = [ordered]@{ UseRealBackends = $true }
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'some diagnostic reason text'
        $recovery.reason_at_attempt | Should -BeExactly 'some diagnostic reason text'
    }

    It 'when -EndTask is not supplied, resolves and calls the real Invoke-E1BrokerCapabilityEndTask by name' {
        $queueRoot = New-TestBrokerQueueLayout
        New-TestOuterRequestFile (Join-Path $queueRoot 'requests') 'req-20260928-100000-cccccccc' | Out-Null
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        function Invoke-E1BrokerCapabilityEndTask { param($TaskName) $script:E1TestCapturedEndTaskName = $TaskName; [ordered]@{ end_exit_code = 0; stopped = $true } }
        $context = [ordered]@{ UseRealBackends = $true }
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'broker_request_stalled: X'
        $script:E1TestCapturedEndTaskName | Should -BeExactly 'Evidence1CodexElevatedRunner'
        $recovery.end_task_result.stopped | Should -BeTrue
    }

    It 'never throws even when EndTask itself throws -- records the error and still attempts the sweep' {
        $queueRoot = New-TestBrokerQueueLayout
        New-TestOuterRequestFile (Join-Path $queueRoot 'requests') 'req-20260928-100000-aaaaaaaa' | Out-Null
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        $context = [ordered]@{ UseRealBackends = $true }
        $throwingEndTask = { param($TaskName) throw 'schtasks_end_denied' }
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'broker_request_stalled: X' $throwingEndTask
        $recovery.end_task_result.error | Should -Match 'schtasks_end_denied'
        # The sweep still ran despite the EndTask failure -- moved below confirms this.
        $recovery.moved.Count | Should -Be 1
    }

    It 'moves an unclaimed request (still in requests/, no log) to stale/ with the exact withdrawn-not-picked-up filename, and it is gone from requests/' {
        $queueRoot = New-TestBrokerQueueLayout
        $reqPath = New-TestOuterRequestFile (Join-Path $queueRoot 'requests') 'req-20260928-100000-aaaaaaaa'
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        $context = [ordered]@{ UseRealBackends = $true }
        $fakeEndTask = { param($TaskName) [ordered]@{ end_exit_code = 0; stopped = $true } }
        Invoke-E1RunBrokerStallRecoveryAttempt $context 'broker_request_not_picked_up: X' $fakeEndTask | Out-Null

        Test-Path -LiteralPath $reqPath | Should -BeFalse
        $staleFiles = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'stale') -File)
        $staleFiles.Count | Should -Be 1
        $staleFiles[0].Name | Should -Match '^\d{8}-\d{4}\.requests\.req-20260928-100000-aaaaaaaa\.withdrawn-not-picked-up\.request\.json$'
    }

    It 'moves a claimed-but-stalled request (in-progress/, no log) to stale/ with the exact stalled-before-log filename, and it is gone from in-progress/' {
        $queueRoot = New-TestBrokerQueueLayout
        $reqPath = New-TestOuterRequestFile (Join-Path $queueRoot 'in-progress') 'req-20260928-021542-edbd6f57'
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        $context = [ordered]@{ UseRealBackends = $true }
        $fakeEndTask = { param($TaskName) [ordered]@{ end_exit_code = 0; stopped = $true } }
        Invoke-E1RunBrokerStallRecoveryAttempt $context 'broker_request_stalled: X' $fakeEndTask | Out-Null

        Test-Path -LiteralPath $reqPath | Should -BeFalse
        $staleFiles = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'stale') -File)
        $staleFiles.Count | Should -Be 1
        $staleFiles[0].Name | Should -Match '^\d{8}-\d{4}\.in-progress\.req-20260928-021542-edbd6f57\.stalled-before-log\.request\.json$'
    }

    It 'leaves a request alone when it HAS a matching log -- something claimed it and may still be legitimately working' {
        $queueRoot = New-TestBrokerQueueLayout
        $reqPath = New-TestOuterRequestFile (Join-Path $queueRoot 'in-progress') 'req-20260928-110000-bbbbbbbb'
        'still alive' | Set-Content -LiteralPath (Join-Path $queueRoot 'logs\req-20260928-110000-bbbbbbbb.log') -Encoding UTF8
        function Get-E1BrokerCapabilityDefaultQueueRoot { $queueRoot }
        function Get-E1BrokerCapabilityDefaultTaskName { 'Evidence1CodexElevatedRunner' }
        $context = [ordered]@{ UseRealBackends = $true }
        $fakeEndTask = { param($TaskName) [ordered]@{ end_exit_code = 0; stopped = $true } }
        $recovery = Invoke-E1RunBrokerStallRecoveryAttempt $context 'broker_request_stalled: X' $fakeEndTask

        Test-Path -LiteralPath $reqPath | Should -BeTrue
        @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'stale') -File).Count | Should -Be 0
        $recovery.moved.Count | Should -Be 0
    }

    It 'the main loop wires this in before the failure-safe closure, and never lets it overwrite the original failure reason (source-level check)' {
        $script:StallRecoveryFixSource | Should -Match ([regex]::Escape('$Report.broker_stall_recovery = Invoke-E1RunBrokerStallRecoveryAttempt $Context $Report.reason'))
        $reasonIndex = $script:StallRecoveryFixSource.IndexOf('$Report.reason = [string]$_.Exception.Message')
        $recoveryCallIndex = $script:StallRecoveryFixSource.IndexOf('$Report.broker_stall_recovery = Invoke-E1RunBrokerStallRecoveryAttempt $Context $Report.reason')
        $closureCallIndex = $script:StallRecoveryFixSource.IndexOf('$Report.failure_safe_closure = Invoke-E1RunFailureSafeClosureAttempt $Context')
        $reasonIndex | Should -BeGreaterThan 0
        $recoveryCallIndex | Should -BeGreaterThan $reasonIndex
        $closureCallIndex | Should -BeGreaterThan $recoveryCallIndex
    }

    It 'does not retry the failed dispatch -- no ProviderRuntimeSession or state-handler call anywhere in its body' {
        $funcStart = $script:StallRecoveryFixSource.IndexOf('function Invoke-E1RunBrokerStallRecoveryAttempt')
        $funcEnd = $script:StallRecoveryFixSource.IndexOf("`n}`n", $funcStart)
        $funcBody = $script:StallRecoveryFixSource.Substring($funcStart, $funcEnd - $funcStart)
        $funcBody | Should -Not -Match 'Invoke-E1ProviderRuntimeSession'
        $funcBody | Should -Not -Match '\$StateHandlers'
    }
}

Describe 'Evidence1 LiveAuthorized budget and retry gate' {
    It 'accepts the exact manifest-derived session count with retries disabled' {
        $manifest = New-TestManifestObject
        (Test-LiveAuthorizedLogic $manifest).Ok | Should -BeTrue
    }

    It 'rejects a manifest that permits automatic provider retry' {
        { New-TestManifestObject -Override @{ no_automatic_provider_retry = $false } } | Should -Throw '*run_manifest_automatic_retry_statement_invalid*'
    }

    It 'rejects an under-budget manifest before a provider session can be dispatched' {
        { New-TestManifestObject -Override @{ max_session_count = 3 } } | Should -Throw '*run_manifest_max_session_count_below_round_order*'
    }
}

Describe 'Evidence1 Phase 4 rehearsal: broker-update failure and rollback drill' {
    AfterEach { Reset-E1FakeBrokerStatusState }

    It 'BrokerReady-equivalent logic reports FAIL for a broker that rolled back to not-self-update-capable' {
        $rolledBack = New-E1BrokerStatusResult -TaskExists $true -Readable $true -DeploymentRoot 'C:\kmp-eval\scratch\fake-broker-deployment' `
          -ManifestSchema 1 -SourceGitCommit ('9' * 40) -PrincipalSid 'S-1-5-21-9-9-9-1001' -ScriptCount 8 `
          -HashesValid $true -AclValid $true -SelfUpdateCapable $false
        Set-E1FakeBrokerStatusResult $rolledBack

        $status = Get-E1BrokerStatus
        $ok = $status.task_exists -and $status.readable -and $status.self_update_capable
        $ok | Should -BeFalse -Because 'this replicates Invoke-E1RunBrokerReadyState''s own PASS condition exactly'
    }

    It 'BrokerReady-equivalent logic reports PASS again once the (simulated) update completes successfully' {
        Reset-E1FakeBrokerStatusState
        $status = Get-E1BrokerStatus
        $status.self_update_capable | Should -BeTrue -Because 'the default fake state is always a healthy, self-update-capable broker'
    }
}

Describe 'Evidence1 full fake campaign: output_roots trust-root portability, end to end (Task 1 follow-up)' {
    # evidence1-run.ps1 must resolve ONE trust root and pass the SAME value
    # to the manifest contract, ArtifactCopy, and ArtifactStore -- not three
    # independent resolutions. This replicates EvidenceCopied and Closed's
    # exact call shape (Invoke-E1RunEvidenceCopiedState/Invoke-E1RunClosedState,
    # evidence1-run.ps1) with an EXPLICITLY INJECTED, non-default trust root
    # under $TestDrive, proving the injection genuinely threads through the
    # manifest load AND both capability calls together, not just one of the
    # three in isolation (each already covered individually by
    # Evidence1-Run-Manifest-Contract.Tests.ps1,
    # Evidence1-Artifact-Copy-Fake.Tests.ps1, and
    # Evidence1-Artifact-Store-Fake.Tests.ps1's own dedicated Describes).

    It 'reaches a committed publication using an injected custom trust root outside the historical C:\kmp-eval\scratch\ default, for the manifest load AND both capability calls' {
        Reset-E1FakeBrokerStatusState
        $customRoot = Join-Path $TestDrive 'e2e-injected-trust-root'
        $manifestOutputRootsPrivate = Join-Path $customRoot 'private'
        $manifestOutputRootsPublic = Join-Path $customRoot 'public'
        $manifest = New-TestManifestObject -TrustedRoot $customRoot -Override @{
            output_roots = [ordered]@{ private = $manifestOutputRootsPrivate; public = $manifestOutputRootsPublic }
        }
        $vmName = [string]$manifest.vm_name
        $vmId = [guid]::NewGuid().ToString()

        # EvidenceCopied-equivalent: Copy-E1ArtifactsReadOnly with the SAME
        # injected -TrustedRoot.
        $fakeMountRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $attestationDir = Join-Path $fakeMountRoot 'kmp-eval\measurement-scopes'
        New-Item -ItemType Directory -Force -Path $attestationDir | Out-Null
        '{"schema":1,"fake":true}' | Set-Content -LiteralPath (Join-Path $attestationDir 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') -Encoding UTF8
        Set-E1FakeArtifactCopyMountRoot -VMName $vmName -MountRootPath $fakeMountRoot
        $privateEvidenceRoot = [string]$manifest.output_roots.private
        $copyResult = Copy-E1ArtifactsReadOnly -VMName $vmName -ExpectedVMId $vmId -SpecName 'final-codex-attestation' `
            -Arguments @{} -DestinationDir $privateEvidenceRoot -TrustedRoot $customRoot
        @($copyResult.files_copied).Count | Should -Be 1
        Test-Path -LiteralPath (Join-Path $manifestOutputRootsPrivate 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') | Should -BeTrue

        # Closed-equivalent: Publish-E1ArtifactStoreSet with the SAME
        # injected -TrustedRoot.
        $publicEvidenceRoot = [string]$manifest.output_roots.public
        $publish = Publish-E1ArtifactStoreSet -PrivateRoot $privateEvidenceRoot -PublicRoot $publicEvidenceRoot -TrustedRoot $customRoot
        $publish.verdict | Should -BeExactly 'PASS'
        $publish.state | Should -BeExactly 'committed'
        Test-Path -LiteralPath (Join-Path $manifestOutputRootsPublic 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') | Should -BeTrue
    }

    It 'the manifest load itself rejects the injected output_roots under the historical default when the SAME custom root is not also passed to Read-E1RunManifest -- proving the manifest cannot widen or choose its own trust root' {
        $customRoot = Join-Path $TestDrive 'e2e-injected-trust-root-2'
        {
            New-TestManifestObject -Override @{
                output_roots = [ordered]@{ private = (Join-Path $customRoot 'private'); public = (Join-Path $customRoot 'public') }
            }
        } | Should -Throw '*run_manifest_output_roots_outside_trusted_root*'
    }
}

Describe 'Evidence1 evidence1-run.ps1 source wiring: output_roots trust root threads to the manifest load AND both capability calls (Task 1 follow-up)' {
    # evidence1-run.ps1 itself can never be executed (standing boundary), so
    # this is a source-scan proof that the fix landed in the right place --
    # the same technique Evidence1-Dual-Remote-Auth-Canary.Tests.ps1 already
    # established for the schema=2 producer fix ("the exact success-path
    # text, proving the fix landed in the right place, not merely 'the file
    # contains schema = 2 somewhere'"). Combined with the replicated-logic
    # integration test immediately above (same call shapes, same capability
    # modules, genuinely executed), this is the strongest available proof
    # for a script that structurally cannot be run in this engagement.

    BeforeAll {
        # $script:AuditsRoot (root BeforeAll, top of this file) is
        # 'C:\...\docs\audits' -- evidence1-run.ps1 lives at the repo root,
        # TWO levels up (docs\audits -> docs -> repo root), not one. This
        # file has no separate $script:RepoRoot variable (unlike
        # Evidence1-Dual-Remote-Auth-Canary.Tests.ps1's own
        # $script:RepoRoot); derived here rather than introducing a second
        # hardcoded absolute literal. (First draft called Split-Path
        # -Parent only once and pointed at docs\, not the repo root --
        # caught by running, Get-Content threw ItemNotFoundException.)
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $script:RunScriptSource = Get-Content -LiteralPath (Join-Path $repoRoot 'evidence1-run.ps1') -Raw
    }

    It 'resolves the trust root exactly once into $ResolvedOutputRootsTrustedRoot and stores it on $Context' {
        $script:RunScriptSource | Should -Match ([regex]::Escape('$ResolvedOutputRootsTrustedRoot = if ([string]::IsNullOrWhiteSpace($OutputRootsTrustedRoot))'))
        $script:RunScriptSource | Should -Match ([regex]::Escape('OutputRootsTrustedRoot = $ResolvedOutputRootsTrustedRoot'))
    }

    It 'passes the resolved trust root explicitly to Read-E1RunManifest' {
        $script:RunScriptSource | Should -Match ([regex]::Escape('Read-E1RunManifest $Manifest -TrustedRoot $ResolvedOutputRootsTrustedRoot'))
    }

    It 'passes $Context.OutputRootsTrustedRoot explicitly to Copy-E1ArtifactsReadOnly (EvidenceCopied)' {
        $script:RunScriptSource | Should -Match ([regex]::Escape('-DestinationDir $privateEvidenceRoot -TrustedRoot $Context.OutputRootsTrustedRoot'))
    }

    It 'copies structured semantic rejections and always finalizes through Invoke-E1CampaignEligibilityFinalization, passing -ProviderMode and -RejectedCellKeys (H20: no global short-circuit that skips finalization entirely when any rejection exists)' {
        $script:RunScriptSource | Should -Match ([regex]::Escape("-SpecName 'agentic-eval-rejection-diagnostic'"))
        $script:RunScriptSource | Should -Match ([regex]::Escape('-ProviderMode ([string]$Context.Manifest.provider_mode)'))
        $script:RunScriptSource | Should -Match ([regex]::Escape('-RejectedCellKeys $rejectedCellKeys'))
        # The old global short-circuit ("any rejection anywhere -> skip finalization, fabricate a
        # fixed FAIL") is gone -- the finalizer itself now decides eligibility per runtime.
        $script:RunScriptSource | Should -Not -Match ([regex]::Escape('campaign_contains_semantic_rejections'))
    }

    It 'passes $Context.OutputRootsTrustedRoot explicitly to Publish-E1ArtifactStoreSet (Closed)' {
        $script:RunScriptSource | Should -Match ([regex]::Escape('Publish-E1ArtifactStoreSet -PrivateRoot $privateEvidenceRoot -PublicRoot $publicEvidenceRoot -TrustedRoot $Context.OutputRootsTrustedRoot'))
    }

    It 'never hardcodes C:\kmp-eval\scratch\ directly as a trust-root literal inside the EvidenceCopied/Closed handlers -- the shared default lives in exactly one place (evidence1-trusted-root-config.psm1), not duplicated here' {
        $evidenceCopiedStart = $script:RunScriptSource.IndexOf('function Invoke-E1RunEvidenceCopiedState')
        $closedStart = $script:RunScriptSource.IndexOf('function Invoke-E1RunClosedState')
        $closedEnd = $script:RunScriptSource.IndexOf('$StateHandlers = @{')
        $evidenceCopiedStart | Should -BeGreaterThan 0
        $closedStart | Should -BeGreaterThan $evidenceCopiedStart
        $closedEnd | Should -BeGreaterThan $closedStart
        $handlersSource = $script:RunScriptSource.Substring($evidenceCopiedStart, $closedEnd - $evidenceCopiedStart)
        $handlersSource | Should -Not -Match ([regex]::Escape('kmp-eval\scratch'))
    }
}
