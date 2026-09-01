#Requires -Modules Pester

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:AuditRoot = Join-Path $script:RepoRoot 'docs\audits'
    $script:ContractPath = Join-Path $script:AuditRoot 'evidence1-live-handoff-contract.psm1'
    Import-Module $script:ContractPath -Force

    $script:Commit = 'a' * 40
    $script:Tree = 'b' * 40
    $script:SourceCommit = 'c' * 40
    $script:VMName = 'Evidence1-Runner'
    $script:ClaudeVersion = '2.1.238'
    $script:AttestationPath = 'C:\kmp-eval\measurement-scopes\evidence1-attestation.json'
    $script:Now = [DateTime]::Parse('2026-08-28T12:20:00.000Z').ToUniversalTime()

    function Complete-CanaryCopyFixture($Copy) {
        $Copy.schema = 1
        $Copy.invocation_id = '99999999-8888-7777-6666-555555555555'
        $Copy.graceful_shutdown_intent_recorded = $true
        $Copy.graceful_shutdown_requested = $true
        $Copy.graceful_shutdown_completed = $true
        $Copy.hard_power_fallback_used = $false
        $Copy.vm_state = 'Off'
        $Copy.vhd_path = 'C:\kmp-eval\hyperv\Evidence1-Runner.vhdx'
        $Copy.mounted_drive = 'Z:\'
        $Copy.out_dir = 'C:\kmp-eval\scratch\hyperv-copy-live-artifacts'
        $Copy.copied = [ordered]@{}
        $Copy.stage_b_exit_text = [string]$Copy.stage_b_exit.record.exit_code
        $Copy.journal_dirs = @()
        $Copy.journal_event_summaries = @()
        $Copy.journal_event_copies = @()
        $Copy.scenario_files = @()
        $Copy.scenario_copies = @()
        $Copy.incident_diagnostics = @()
        $Copy.rejection_diagnostics = @()
        $Copy.local_structured_rejection_details = @()
        $Copy.runs_inventory = @()
        $Copy.note = 'Inventory uses file names, sizes and hashes only. Raw transcript/stderr contents are not read.'
        $Copy.stage_b_exit.source = 'wrapper_terminal'
        $Copy.stage_b_exit.reason = $null
        $Copy.stage_b_exit.exit_code = $Copy.stage_b_exit.record.exit_code
        $Copy.stage_b_exit.record.ts_utc = '2026-08-28T10:59:00.000Z'
        $Copy.stage_b_exit.record.wrapper_error_type = 'System.InvalidOperationException'
        return $Copy
    }

    function New-CanaryFilesFixture([switch]$Launcher, [switch]$Source) {
        $files = [ordered]@{
            'binding.json' = '1' * 64
            'wet.json' = '2' * 64
            'dry.json' = '3' * 64
            'readiness.json' = '4' * 64
            'handoff.claim.json' = '5' * 64
            'wrapper.claim.json' = '6' * 64
        }
        if ($Launcher) { $files['launcher.claim.json'] = '7' * 64 }
        if ($Source) { $files['source-custody.json'] = '8' * 64 }
        return $files
    }

    function New-ReadinessReport {
        [ordered]@{
            verdict = 'PASS'
            generated_at_utc = '2026-08-28T12:15:00.000Z'
            vm_name = $script:VMName
            vm_state = 'Running'
            target_commit = $script:Commit
            target_tree = $script:Tree
            guest = [ordered]@{
                verdict = 'PASS'
                harness_head = $script:Commit
                harness_tree = $script:Tree
                source_head = $script:SourceCommit
                planned_sessions = 8
                attestation_path = $script:AttestationPath
                attestation_sha256 = 'd' * 64
                tools = [ordered]@{ claude = $script:ClaudeVersion }
            }
            privacy = [ordered]@{
                raw_transcript_content_read = $false
                stderr_content_read = $false
                attestation_content_printed = $false
                dry_run_stdout_printed = $false
            }
        }
    }

    function New-AuthReport {
        param([string]$CompletedAt = '2026-08-28T12:16:00.000Z')
        [ordered]@{
            verdict = 'PASS'
            generated_at_utc = $CompletedAt
            vm_name = $script:VMName
            vm_state = 'Running'
            guest_report = [ordered]@{
                verdict = 'PASS'
                claude_version = $script:ClaudeVersion
                credential_override_names = @()
                ssh_dir_present = $false
                git_credentials_present = $false
                gh_hosts_present = $false
                identity_fields_logged = $false
                remote_auth_canary = [ordered]@{
                    schema = 1
                    state = 'passed'
                    completed_at_utc = $CompletedAt
                    local_auth_status_exit_code = 0
                    process_exit_code = 0
                    claude_version = $script:ClaudeVersion
                    parse_error_count = 0
                    http_statuses = @()
                    credential_override_names = @()
                    terminal = [ordered]@{ present = $true; is_error = $false }
                    privacy = [ordered]@{
                        raw_content_persisted = $false
                        raw_content_printed = $false
                        raw_content_read_in_memory_for_sanitization = $true
                        error_text_persisted = $false
                    }
                }
            }
        }
    }

    function Invoke-LiveHandoffEvidenceAssertion {
        param(
            [Parameter(Mandatory = $true)]$Readiness,
            [Parameter(Mandatory = $true)]$Auth
        )

        Assert-Evidence1LiveHandoffEvidence `
            -ReadinessReport $Readiness `
            -AuthReport $Auth `
            -ExpectedVMName $script:VMName `
            -ExpectedTargetCommit $script:Commit `
            -ExpectedTargetTree $script:Tree `
            -ExpectedSourceCommit $script:SourceCommit `
            -ExpectedClaudeVersion $script:ClaudeVersion `
            -ExpectedAttestationPath $script:AttestationPath `
            -NowUtc $script:Now
    }

    Import-Module (Join-Path $script:AuditRoot 'evidence1-validation-ops.psm1') -Force
    function New-CanaryValidationReport([string]$Operation) {
        $report = New-E1Result $Operation $script:Commit $script:Tree
        $report.state = 'passed'; $report.stage = 'complete'; $report.failure_code = 'none'
        $report.live_records_created = 0
        foreach ($name in @('guest_identity','preflight','postflight','module_target','source_integrity')) { $report.checks[$name] = $true }
        foreach ($name in @('readiness_sha256','ledger_sha256','attestation_sha256','attestation_canonical_sha256',
            'validation_module_sha256','scenario_sha256','product_entry_sha256','product_stdout_sha256',
            'records_metadata_before_sha256','records_metadata_after_sha256','execution_profile_sha256','execution_profile_registry_sha256')) {
            $report.hashes[$name] = 'd' * 64
        }
        $report.hashes.validation_module_sha256 = (Get-FileHash (Join-Path $script:AuditRoot 'evidence1-validation-ops.psm1')).Hash.ToLowerInvariant()
        if ($Operation -eq 'wet-v2') {
            $report.product_invocations = 1
            foreach ($name in @('gradle_daemon_disabled','owned_tree_stopped','not_timed_out','java21_verified') + @((Get-E1WetChecks $null 0 0).Keys)) { $report.checks[$name] = $true }
            $report.processes.product = @{ exit_code = 1; timed_out = $false; cleanup_ok = $true; wall_seconds = 2 }
        } else {
            $report.dry_plan_invocations = 2
            $report.hashes.free_baseline_stdout_sha256 = 'e' * 64
            foreach ($arm in @('product','free_baseline')) {
                foreach ($name in @('process','stderr_empty') + @((Get-E1DryChecks $null 'claude-product-canary-v1' ('d' * 64) ('d' * 64)).Keys)) { $report.checks["${arm}_$name"] = $true }
                $report.processes["${arm}_dry_plan"] = @{ exit_code = 0; timed_out = $false; cleanup_ok = $true; wall_seconds = 1 }
            }
        }
        return ConvertTo-E1SafeResult $report $Operation $script:Commit $script:Tree
    }
    function New-CanaryParameters([string]$Arm = 'product') {
        $readiness = New-ReadinessReport
        $readiness.guest.source_head = '7d45eae4f8720a0c77f507712ba2437ff974b6ed'
        return @{
            Arm = $Arm; RunId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
            TargetCommit = $script:Commit; TargetTree = $script:Tree
            WetReport = New-CanaryValidationReport 'wet-v2'; DryReport = New-CanaryValidationReport 'dry-v3'
            ReadinessReport = $readiness; ReadinessSha256 = 'd' * 64
            WetReportSha256 = '1' * 64; DryReportSha256 = '2' * 64
        }
    }
    function Write-CanaryTestBundle([string]$Directory) {
        $p = New-CanaryParameters
        New-Item -ItemType Directory -Path $Directory | Out-Null
        $utf8 = [Text.UTF8Encoding]::new($false)
        $readinessBytes = $utf8.GetBytes(($p.ReadinessReport | ConvertTo-Json -Depth 20))
        $p.ReadinessSha256 = Get-E1Sha256 $readinessBytes
        $p.WetReport.hashes.readiness_sha256 = $p.ReadinessSha256
        $p.DryReport.hashes.readiness_sha256 = $p.ReadinessSha256
        $wetBytes = $utf8.GetBytes(($p.WetReport | ConvertTo-Json -Depth 20))
        $dryBytes = $utf8.GetBytes(($p.DryReport | ConvertTo-Json -Depth 20))
        $p.WetReportSha256 = Get-E1Sha256 $wetBytes; $p.DryReportSha256 = Get-E1Sha256 $dryBytes
        [IO.File]::WriteAllBytes((Join-Path $Directory 'readiness.json'), $readinessBytes)
        [IO.File]::WriteAllBytes((Join-Path $Directory 'wet.json'), $wetBytes)
        [IO.File]::WriteAllBytes((Join-Path $Directory 'dry.json'), $dryBytes)
        $binding = New-Evidence1CanaryBinding @p
        $bindingBytes = $utf8.GetBytes(($binding | ConvertTo-Json -Depth 20))
        [IO.File]::WriteAllBytes((Join-Path $Directory 'binding.json'), $bindingBytes)
        return @{ Directory = $Directory; RunId = $p.RunId; Arm = $p.Arm; BindingSha256 = Get-E1Sha256 $bindingBytes }
    }
}

Describe 'Evidence1 Stage L canary evidence and authorization' {
    BeforeAll { Import-Module (Join-Path $script:AuditRoot 'evidence1-live-run-contract.psm1') -Force }
    It 'binds <Arm> to exactly one registered V2 cell while retaining eight-cell readiness' -TestCases @(
        @{ Arm = 'product'; Label = 'A'; Condition = 'current-skill'; Access = 'product-assisted'; Hash = 'd' }
        @{ Arm = 'free-baseline'; Label = 'B'; Condition = 'no-skill'; Access = 'free-baseline-no-product'; Hash = 'e' }
    ) {
        param($Arm, $Label, $Condition, $Access, $Hash)
        $p = New-CanaryParameters $Arm
        $binding = New-Evidence1CanaryBinding @p
        $binding.campaign_design_id | Should -BeExactly "claude-$Arm-canary-v1"
        $binding.scenario_id | Should -BeExactly 'coverage-threshold-failure-v2'
        $binding.planned_sessions | Should -Be 1
        $binding.condition | Should -BeExactly $Condition
        $binding.cell_label | Should -BeExactly $Label
        $binding.product_access_mode | Should -BeExactly $Access
        $binding.plan_sha256 | Should -BeExactly ($Hash * 64)
        $p.ReadinessReport.guest.planned_sessions | Should -Be 8
        $binding.wet_report_sha256 | Should -BeExactly $p.WetReportSha256
        $binding.dry_report_sha256 | Should -BeExactly $p.DryReportSha256
    }

    It 'rejects <Name> before producing a launch binding' -TestCases @(
        @{ Name = 'unknown arm'; Change = { $p.Arm = 'full' } }
        @{ Name = 'missing arm'; Change = { $p.Arm = '' } }
        @{ Name = 'noncanonical run'; Change = { $p.RunId = 'not-a-run' } }
        @{ Name = 'failed V2'; Change = { $p.WetReport.state = 'failed'; $p.WetReport.failure_code = 'product_failed' } }
        @{ Name = 'failed V3'; Change = { $p.DryReport.state = 'failed'; $p.DryReport.failure_code = 'dry_plan_failed' } }
        @{ Name = 'schema 1 report'; Change = { $p.WetReport.schema = 1 } }
        @{ Name = 'V2 anchor drift'; Change = { $p.WetReport.target_tree = 'f' * 40 } }
        @{ Name = 'V3 anchor drift'; Change = { $p.DryReport.target_commit = 'f' * 40 } }
        @{ Name = 'attestation mismatch'; Change = { $p.DryReport.hashes.attestation_canonical_sha256 = 'f' * 64 } }
        @{ Name = 'raw attestation mismatch'; Change = { $p.DryReport.hashes.attestation_sha256 = 'f' * 64 } }
        @{ Name = 'readiness bytes changed'; Change = { $p.ReadinessSha256 = 'f' * 64 } }
        @{ Name = 'module hash mismatch'; Change = { $p.DryReport.hashes.validation_module_sha256 = 'f' * 64 } }
        @{ Name = 'both reports agree on the wrong local module'; Change = { $p.WetReport.hashes.validation_module_sha256 = 'f' * 64; $p.DryReport.hashes.validation_module_sha256 = 'f' * 64 } }
        @{ Name = 'false one-cell check'; Change = { $p.DryReport.checks.product_planned_sessions = $false } }
        @{ Name = 'string counter'; Change = { $p.WetReport.product_invocations = '1' } }
        @{ Name = 'V2 exit zero'; Change = { $p.WetReport.processes.product.exit_code = 0 } }
        @{ Name = 'unknown report field'; Change = { $p.WetReport.secret = 'private' } }
    ) {
        param($Name, $Change)
        $p = New-CanaryParameters
        . $Change
        { New-Evidence1CanaryBinding @p } | Should -Throw '*canary*'
    }

    It 'requires the stable one-cell literal for the selected arm without human UUIDs or hashes' {
        $p = New-CanaryParameters
        $binding = New-Evidence1CanaryBinding @p
        $phrase = Get-Evidence1CanaryAuthorizationLiteral $binding
        $phrase | Should -Match '^AUTORIZO 1 SESION LIVE NUEVA'
        $phrase | Should -Not -Match ([regex]::Escape($binding.run_id))
        $phrase | Should -Not -Match ([regex]::Escape($binding.dry_report_sha256))
        { Assert-Evidence1CanaryAuthorization $binding $phrase } | Should -Not -Throw
        foreach ($wrong in @('', $phrase.ToLowerInvariant(), $phrase.Replace('product', 'free-baseline'),
            ('AUTORIZO HASTA 8 SESIONES LIVE NUEVAS DEL EVIDENCE' + '1 CLAUDE WINDOWS PRODUCT-VS-FREE-BASELINE COVERAGE-THRESHOLD EN ESTE ENTORNO AISLADO, SIN REINTENTOS, REEMPLAZOS NI RESPAWNS'))) {
            { Assert-Evidence1CanaryAuthorization $binding $wrong } | Should -Throw
        }
    }

    It 'revalidates staged bytes and rejects substitution of any bound file or arm' {
        $p = Write-CanaryTestBundle (Join-Path $TestDrive 'bundle')
        $actual = Read-Evidence1CanaryBundle @p
        $actual.binding.planned_sessions | Should -Be 1
        foreach ($name in @('wet.json','dry.json','readiness.json','binding.json')) {
            $path = Join-Path $p.Directory $name
            $before = [IO.File]::ReadAllBytes($path)
            [IO.File]::AppendAllText($path, ' ')
            { Read-Evidence1CanaryBundle @p } | Should -Throw '*canary_bundle*'
            [IO.File]::WriteAllBytes($path, $before)
        }
        $p.Arm = 'free-baseline'
        { Read-Evidence1CanaryBundle @p } | Should -Throw '*canary_bundle*'
    }

    It 'uses supplied unique report paths and never replaces original failed evidence' {
        $p = Write-CanaryTestBundle (Join-Path $TestDrive 'supplied')
        $binding = (Read-Evidence1CanaryBundle @p).binding
        $failed = Join-Path $TestDrive 'original-failed.json'
        [IO.File]::WriteAllText($failed, '{"state":"failed"}')
        $before = (Get-FileHash $failed).Hash
        $hostArgs = @{
            Directory = Join-Path $TestDrive 'host-attempt'; RunId = $p.RunId; Arm = $p.Arm
            TargetCommit = $script:Commit; TargetTree = $script:Tree
            WetReportPath = Join-Path $p.Directory 'wet.json'; DryReportPath = Join-Path $p.Directory 'dry.json'
            ReadinessReportPath = Join-Path $p.Directory 'readiness.json'
            ExpectedWetReportSha256 = $binding.wet_report_sha256; ExpectedDryReportSha256 = $binding.dry_report_sha256
            AuthorizationPhrase = Get-Evidence1CanaryAuthorizationLiteral $binding
        }
        $result = New-Evidence1CanaryHostBundle @hostArgs
        (Get-FileHash $failed).Hash | Should -BeExactly $before
        $result.binding.dry_report_sha256 | Should -BeExactly $binding.dry_report_sha256
        Test-Path (Join-Path $result.directory 'handoff.claim.json') | Should -BeTrue
        { New-Evidence1CanaryHostBundle @hostArgs } | Should -Throw '*canary*'
        $hostArgs.Directory = Join-Path $TestDrive 'bad-hash-attempt'
        $hostArgs.ExpectedWetReportSha256 = 'f' * 64
        { New-Evidence1CanaryHostBundle @hostArgs } | Should -Throw '*canary*'
        Test-Path $hostArgs.Directory | Should -BeFalse
    }

    It 'builds the selected registered CLI invocation without repeats, profile override or full-matrix fallback' {
        foreach ($arm in @('product','free-baseline')) {
            $p = New-CanaryParameters $arm
            $binding = New-Evidence1CanaryBinding @p
            $args = @(Get-Evidence1CanaryArguments $binding 'C:\fixture\source' 'C:\fixture\attestation.json')
            $args[0] | Should -BeExactly 'tools/agentic-eval/cli.mjs'
            $args[1] | Should -BeExactly 'run'
            $args[[array]::IndexOf($args, '--scenario') + 1] | Should -BeExactly 'coverage-threshold-failure-v2'
            $args[[array]::IndexOf($args, '--campaign-design') + 1] | Should -BeExactly "claude-$arm-canary-v1"
            $args | Should -Not -Contain '--repeats'
            $args | Should -Not -Contain '--execution-profile'
            $args | Should -Not -Contain '--dry-run'
            $dry = @(Get-Evidence1CanaryArguments $binding 'C:\fixture\source' 'C:\fixture\attestation.json' -DryRun)
            ($dry[0..($dry.Length - 2)] -join '|') | Should -BeExactly ($args -join '|')
            $dry[-1] | Should -BeExactly '--dry-run'
            $binding.planned_sessions = 8
            { Get-Evidence1CanaryArguments $binding 'C:\fixture\source' 'C:\fixture\attestation.json' } | Should -Throw '*canary*'
        }
    }

    It 'validates mounted staged scripts and copied canary custody against placement, not the host script path' {
        $ops = Join-Path $TestDrive 'mounted/Evidence1Ops'
        $p = Write-CanaryTestBundle (Join-Path $ops 'canary/b48bfb0c-a9ae-4e0e-8d89-56eb1e278090')
        $b = (Read-Evidence1CanaryBundle @p).binding
        foreach ($name in $b.scripts.Keys) { Copy-Item (Join-Path $script:AuditRoot $name) (Join-Path $ops $name) }
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'handoff'
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'wrapper'
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'launcher'
        Write-Evidence1JsonAtomically (Join-Path $p.Directory 'source-custody.json') @{
            schema = 1; run_id = $p.RunId; binding_sha256 = $p.BindingSha256; source_preserved = $true
            validation_inventory_before_sha256 = 'd' * 64; validation_inventory_after_sha256 = 'd' * 64
        }
        $terminal = @{ run_id = $p.RunId; canary = @{ arm = 'product'; planned_sessions = 1; binding_sha256 = $p.BindingSha256 } }
        $custody = Get-Evidence1CanaryCustody $p.Directory $p.RunId $p.BindingSha256 $terminal
        $custody.verified | Should -BeTrue
        $custody.binding_sha256 | Should -BeExactly $p.BindingSha256
        $staged = Join-Path $ops 'evidence1-live-run-contract.psm1'
        [IO.File]::AppendAllText($staged, "`n# altered staged module")
        { Get-Evidence1CanaryCustody $p.Directory $p.RunId $p.BindingSha256 $terminal } | Should -Throw '*canary*'
        Copy-Item (Join-Path $script:AuditRoot 'evidence1-live-run-contract.psm1') $staged -Force
        [IO.File]::AppendAllText((Join-Path $p.Directory 'wet.json'), ' ')
        { Get-Evidence1CanaryCustody $p.Directory $p.RunId $p.BindingSha256 $terminal } | Should -Throw '*canary*'
    }

    It 'returns copy-ready incomplete custody for a claimed wrapper preflight failure without authorizing retry' {
        $ops = Join-Path $TestDrive 'mounted-preflight/Evidence1Ops'
        $p = Write-CanaryTestBundle (Join-Path $ops 'canary/b48bfb0c-a9ae-4e0e-8d89-56eb1e278090')
        $b = (Read-Evidence1CanaryBundle @p).binding
        foreach ($name in $b.scripts.Keys) { Copy-Item (Join-Path $script:AuditRoot $name) (Join-Path $ops $name) }
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'handoff'
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'wrapper'
        Write-Evidence1JsonAtomically (Join-Path $p.Directory 'journal-baseline.json') @{
            run_id = $p.RunId; binding_sha256 = $p.BindingSha256; journal_ids = @()
        }
        $diagnostics = New-Evidence1CanaryDiagnostics
        try { throw 'canary_journal_baseline' } catch { Set-Evidence1CanaryFailure $diagnostics primary guest_preflight $_ }
        $terminal = @{
            schema = 1; run_id = $p.RunId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error'
            wrapper_error_stage = 'initialize_journal'; canary = @{ arm = 'product'; planned_sessions = 1; binding_sha256 = $p.BindingSha256 }
            diagnostics = $diagnostics
        }

        $custody = Get-Evidence1CanaryCustody $p.Directory $p.RunId $p.BindingSha256 $terminal
        $custody.verified | Should -BeFalse
        $custody.complete | Should -BeFalse
        $custody.custody_state | Should -BeExactly 'incomplete_wrapper_preflight'
        $custody.attempt_consumed | Should -BeTrue
        $custody.retry_authorized | Should -BeFalse
        $custody.source_preserved | Should -BeFalse
        $custody.failure_phase | Should -BeExactly 'guest_preflight'
        $custody.failure_code | Should -BeExactly 'canary_journal_baseline'
        $custody.files.Keys | Should -Contain 'wrapper.claim.json'
        $custody.files.Keys | Should -Not -Contain 'launcher.claim.json'
        Test-Path (Join-Path $p.Directory 'wrapper.claim.json') | Should -BeTrue
    }

    It 'returns copy-ready incomplete custody when wrapper journal transport aborts a claimed launcher' {
        $ops = Join-Path $TestDrive 'mounted-monitor/Evidence1Ops'
        $p = Write-CanaryTestBundle (Join-Path $ops 'canary/b48bfb0c-a9ae-4e0e-8d89-56eb1e278090')
        $b = (Read-Evidence1CanaryBundle @p).binding
        foreach ($name in $b.scripts.Keys) { Copy-Item (Join-Path $script:AuditRoot $name) (Join-Path $ops $name) }
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'handoff'
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'wrapper'
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'launcher'
        Write-Evidence1JsonAtomically (Join-Path $p.Directory 'journal-baseline.json') @{
            run_id = $p.RunId; binding_sha256 = $p.BindingSha256; journal_ids = @()
        }
        Write-Evidence1JsonAtomically (Join-Path $p.Directory 'journal.json') @{
            run_id = $p.RunId; journal_id = [guid]::NewGuid().ToString(); available = $true; event_count = 0
            latest_event = $null; transition_counts = @{}; publication_pending = $false; publication_pending_since_utc = $null
        }
        $diagnostics = New-Evidence1CanaryDiagnostics
        try { throw 'canary_progress_shape' } catch { Set-Evidence1CanaryFailure $diagnostics primary journal $_ }
        $terminal = @{
            schema = 1; run_id = $p.RunId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error'
            wrapper_error_stage = 'monitor_launcher'; canary = @{ arm = 'product'; planned_sessions = 1; binding_sha256 = $p.BindingSha256 }
            diagnostics = $diagnostics
        }

        $custody = Get-Evidence1CanaryCustody $p.Directory $p.RunId $p.BindingSha256 $terminal
        $custody.verified | Should -BeFalse
        $custody.complete | Should -BeFalse
        $custody.custody_state | Should -BeExactly 'incomplete_wrapper_monitor'
        $custody.attempt_consumed | Should -BeTrue
        $custody.retry_authorized | Should -BeFalse
        $custody.source_preserved | Should -BeFalse
        $custody.failure_phase | Should -BeExactly 'journal'
        $custody.failure_code | Should -BeExactly 'canary_progress_shape'
        $custody.files.Keys | Should -Contain 'launcher.claim.json'
        $custody.files.Keys | Should -Contain 'journal.json'
        $custody.files.Keys | Should -Not -Contain 'source-custody.json'
    }

    It 'rejects incomplete custody outside the exact claimed wrapper preflight failure shape' {
        $ops = Join-Path $TestDrive 'mounted-invalid-preflight/Evidence1Ops'
        $p = Write-CanaryTestBundle (Join-Path $ops 'canary/b48bfb0c-a9ae-4e0e-8d89-56eb1e278090')
        $b = (Read-Evidence1CanaryBundle @p).binding
        foreach ($name in $b.scripts.Keys) { Copy-Item (Join-Path $script:AuditRoot $name) (Join-Path $ops $name) }
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'handoff'
        $null = New-Evidence1CanaryClaim $p.Directory $p.RunId $p.BindingSha256 'wrapper'
        $diagnostics = New-Evidence1CanaryDiagnostics
        try { throw 'canary_live_exit_nonzero' } catch { Set-Evidence1CanaryFailure $diagnostics primary live $_ }
        $terminal = @{
            schema = 1; run_id = $p.RunId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error'
            wrapper_error_stage = 'start_launcher'; canary = @{ arm = 'product'; planned_sessions = 1; binding_sha256 = $p.BindingSha256 }
            diagnostics = $diagnostics
        }
        { Get-Evidence1CanaryCustody $p.Directory $p.RunId $p.BindingSha256 $terminal } | Should -Throw '*canary*'
    }
}

Describe 'Evidence1 live handoff evidence contract' {
    It 'accepts fresh matching readiness and remote-auth evidence' {
        $actual = Invoke-LiveHandoffEvidenceAssertion `
            -Readiness (New-ReadinessReport) `
            -Auth (New-AuthReport)

        $actual.ok | Should -BeTrue
        $actual.target_commit | Should -Be $script:Commit
        $actual.target_tree | Should -Be $script:Tree
    }

    It 'accepts the observed Claude CLI version label when its canonical version is pinned' {
        $readiness = New-ReadinessReport
        $auth = New-AuthReport
        $observedVersion = "$($script:ClaudeVersion) (Claude Code)"
        $readiness.guest.tools.claude = $observedVersion
        $auth.guest_report.claude_version = $observedVersion
        $auth.guest_report.remote_auth_canary.claude_version = $observedVersion

        $actual = Invoke-LiveHandoffEvidenceAssertion -Readiness $readiness -Auth $auth

        $actual.ok | Should -BeTrue
    }

    It 'rejects an observed Claude CLI label with a different canonical version' {
        $readiness = New-ReadinessReport
        $readiness.guest.tools.claude = '2.1.239 (Claude Code)'

        {
            Invoke-LiveHandoffEvidenceAssertion -Readiness $readiness -Auth (New-AuthReport)
        } | Should -Throw '*readiness guest Claude version mismatch*'
    }

    It 'rejects stale remote-auth evidence' {
        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness (New-ReadinessReport) `
                -Auth (New-AuthReport -CompletedAt '2026-08-28T11:00:00.000Z')
        } | Should -Throw '*remote auth canary is stale*'
    }

    It 'rejects readiness anchor drift' {
        $readiness = New-ReadinessReport
        $readiness.target_tree = 'c' * 40

        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness $readiness `
                -Auth (New-AuthReport)
        } | Should -Throw '*readiness target tree mismatch*'
    }

    It 'rejects a privacy-unsafe readiness report' {
        $readiness = New-ReadinessReport
        $readiness.privacy.raw_transcript_content_read = $true

        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness $readiness `
                -Auth (New-AuthReport)
        } | Should -Throw '*raw_transcript_content_read must be false*'
    }

    It 'rejects a remote-auth canary that predates readiness' {
        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness (New-ReadinessReport) `
                -Auth (New-AuthReport -CompletedAt '2026-08-28T12:14:00.000Z')
        } | Should -Throw '*remote auth canary predates readiness*'
    }

    It 'rejects ambient guest credential stores' {
        $auth = New-AuthReport
        $auth.guest_report.ssh_dir_present = $true

        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness (New-ReadinessReport) `
                -Auth $auth
        } | Should -Throw '*ssh_dir_present must be false*'
    }

    It 'rejects evidence generated for another VM' {
        $readiness = New-ReadinessReport
        $readiness.vm_name = 'Other-Runner'

        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness $readiness `
                -Auth (New-AuthReport)
        } | Should -Throw '*readiness VM mismatch*'
    }

    It 'rejects source and toolchain drift hidden behind a PASS verdict' {
        $readiness = New-ReadinessReport
        $readiness.guest.source_head = 'e' * 40

        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness $readiness `
                -Auth (New-AuthReport)
        } | Should -Throw '*source commit mismatch*'
    }

    It 'rejects a canary with unparseable output despite a PASS verdict' {
        $auth = New-AuthReport
        $auth.guest_report.remote_auth_canary.parse_error_count = 1

        {
            Invoke-LiveHandoffEvidenceAssertion `
                -Readiness (New-ReadinessReport) `
                -Auth $auth
        } | Should -Throw '*remote auth canary contains parse errors*'
    }
}

Describe 'Evidence1 previous-run custody contract' {
    BeforeEach {
        $script:PriorRunId = '11111111-2222-3333-4444-555555555555'
        $script:Placement = [ordered]@{
            verdict = 'PASS'
            generated_at_utc = '2026-08-28T10:00:00.000Z'
            vm_name = $script:VMName
            run_id = $script:PriorRunId
        }
        $script:Copy = [ordered]@{
            verdict = 'PASS'
            generated_at_utc = '2026-08-28T11:00:00.000Z'
            vm_name = $script:VMName
            stage_b_exit = [ordered]@{
                valid = $true
                record = [ordered]@{ run_id = $script:PriorRunId }
            }
            raw_content_read = $false
        }
    }

    It 'accepts a copied terminal record bound to the prior placement' {
        $actual = Assert-Evidence1PreviousRunCustody `
            -PlacementReport $script:Placement `
            -CopyReport $script:Copy `
            -ExpectedVMName $script:VMName

        $actual.state | Should -Be 'closed'
        $actual.run_id | Should -Be $script:PriorRunId
    }

    It 'binds complete canary custody to the exact terminal and rejects private shape drift' {
        $bindingSha = 'c' * 64
        $binding = [ordered]@{ schema = 1; run_id = $script:PriorRunId; arm = 'product'; planned_sessions = 1 }
        $placement = [ordered]@{
            verdict = 'PASS'; generated_at_utc = '2026-08-28T10:00:00.000Z'
            vm_name = $script:VMName; run_id = $script:PriorRunId
            canary = [ordered]@{ binding_sha256 = $bindingSha; binding = $binding }
        }
        $diagnostics = [ordered]@{
            schema = 1; failure_phase = $null; failure_code = $null
            failures = [ordered]@{ primary = $null; cleanup = $null; postflight = $null; persistence = $null }
            processes = [ordered]@{ dry_plan = $null; live = $null }
            checks = [ordered]@{ source_preserved = $true; custody_written = $true; terminal_written = $true }
        }
        $copy = [ordered]@{
            state = 'passed'; verdict = 'PASS'; generated_at_utc = '2026-08-28T11:00:00.000Z'
            vm_name = $script:VMName; expected_run_id = $script:PriorRunId; raw_content_read = $false
            failure_phase = $null; failure_code = $null; failure_subreason = $null
            stage_b_exit = [ordered]@{ valid = $true; record = [ordered]@{
                schema = 1; run_id = $script:PriorRunId; state = 'exited'; exit_code = 0; exit_code_source = 'launcher_record'
                wrapper_error_stage = $null; canary = [ordered]@{ arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha }
                diagnostics = $diagnostics
            } }
            canary = [ordered]@{
                verified = $true; complete = $true; custody_state = 'complete'; run_id = $script:PriorRunId
                arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha; attempt_consumed = $true
                retry_authorized = $false; source_preserved = $true; files = New-CanaryFilesFixture -Launcher -Source
            }
        }
        $copy = Complete-CanaryCopyFixture $copy
        $copy.stage_b_exit.record.wrapper_error_type = $null

        (Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName).state | Should -Be 'closed'

        $copy.stage_b_exit.record.canary.binding_sha256 = 'd' * 64
        { Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName } | Should -Throw
        $copy.stage_b_exit.record.canary.binding_sha256 = $bindingSha
        $copy.private_note = 'sentinel'
        { Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName } | Should -Throw
        $copy.Remove('private_note')

        $copy.raw_content_read = 0
        { Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName } | Should -Throw
        $copy.raw_content_read = $false

        $copy.stage_b_exit.record.state = 'running'
        { Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName } | Should -Throw
        $copy.stage_b_exit.record.state = 'exited'
        $copy.stage_b_exit.record.exit_code_source = 'invalid_source'
        { Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName } | Should -Throw
        $copy.stage_b_exit.record.exit_code_source = 'launcher_record'

        $copy.canary.files['private.txt'] = 'sensitive-value'
        { Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName } | Should -Throw
        $copy.canary.files.Remove('private.txt')
        $copy.canary.files['binding.json'] = 'not-a-sha256'
        { Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName } | Should -Throw
        $copy.canary.files['binding.json'] = '1' * 64

        $launcherCopy = $copy | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        $launcherCopy.stage_b_exit.source = 'launcher_terminal'
        $launcherCopy.stage_b_exit.record.PSObject.Properties.Remove('wrapper_error_type')
        $launcherCopy.stage_b_exit.record.PSObject.Properties.Remove('wrapper_error_stage')
        (Assert-Evidence1PreviousRunCustody $placement $launcherCopy $script:VMName).state | Should -Be 'closed'

        $legacyShape = $copy | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        foreach ($name in @(
            'graceful_shutdown_intent_recorded','graceful_shutdown_requested',
            'graceful_shutdown_completed','hard_power_fallback_used'
        )) {
            $legacyShape.PSObject.Properties.Remove($name)
        }
        { Assert-Evidence1PreviousRunCustody $placement $legacyShape $script:VMName } | Should -Throw

        $alreadyOffCopy = $copy | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        $alreadyOffCopy.graceful_shutdown_intent_recorded = $false
        $alreadyOffCopy.graceful_shutdown_requested = $false
        $alreadyOffCopy.graceful_shutdown_completed = $false
        (Assert-Evidence1PreviousRunCustody $placement $alreadyOffCopy $script:VMName).state | Should -Be 'closed'

        foreach ($mutation in @('state','vm_state','failure','shutdown','reason','missing_source')) {
            $candidate = $copy | ConvertTo-Json -Depth 20 | ConvertFrom-Json
            switch ($mutation) {
                'state' { $candidate.state = 'failed' }
                'vm_state' { $candidate.vm_state = 'Running' }
                'failure' { $candidate.failure_code = 'unexpected_failure' }
                'shutdown' { $candidate.graceful_shutdown_completed = $false }
                'reason' { $candidate.stage_b_exit.reason = 'free-form sentinel' }
                'missing_source' { $candidate.canary.files.PSObject.Properties.Remove('source-custody.json') }
            }
            { Assert-Evidence1PreviousRunCustody $placement $candidate $script:VMName } | Should -Throw
        }
    }

    It 'accepts an empty first-run custody state' {
        $actual = Assert-Evidence1PreviousRunCustody `
            -PlacementReport $null `
            -CopyReport $null `
            -ExpectedVMName $script:VMName

        $actual.state | Should -Be 'none'
        $actual.run_id | Should -BeNullOrEmpty
    }

    It 'rejects an uncopied prior placement' {
        {
            Assert-Evidence1PreviousRunCustody `
                -PlacementReport $script:Placement `
                -CopyReport $null `
                -ExpectedVMName $script:VMName
        } | Should -Throw '*has no copied terminal custody*'
    }

    It 'rejects a copied terminal record for another run' {
        $script:Copy.stage_b_exit.record.run_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

        {
            Assert-Evidence1PreviousRunCustody `
                -PlacementReport $script:Placement `
                -CopyReport $script:Copy `
                -ExpectedVMName $script:VMName
        } | Should -Throw '*run_id mismatch*'
    }

    It 'rejects copied custody without its placement record' {
        {
            Assert-Evidence1PreviousRunCustody `
                -PlacementReport $null `
                -CopyReport $script:Copy `
                -ExpectedVMName $script:VMName
        } | Should -Throw '*without a prior placement report*'
    }

    It 'rejects a copy timestamp older than its placement' {
        $script:Copy.generated_at_utc = '2026-08-28T09:00:00.000Z'

        {
            Assert-Evidence1PreviousRunCustody `
                -PlacementReport $script:Placement `
                -CopyReport $script:Copy `
                -ExpectedVMName $script:VMName
        } | Should -Throw '*prior copy predates its placement*'
    }

    It 'rejects prior custody from another VM' {
        $script:Copy.vm_name = 'Other-Runner'

        {
            Assert-Evidence1PreviousRunCustody `
                -PlacementReport $script:Placement `
                -CopyReport $script:Copy `
                -ExpectedVMName $script:VMName
        } | Should -Throw '*prior copy VM mismatch*'
    }

    It 'closes an exact fail-closed incomplete canary attempt without authorizing a retry' {
        $bindingSha = 'c' * 64
        $binding = [ordered]@{
            schema = 1; run_id = $script:PriorRunId; arm = 'product'; planned_sessions = 1
            target_commit = 'a' * 40; hashes = [ordered]@{ readiness_sha256 = 'b' * 64 }
        }
        $placement = [ordered]@{
            verdict = 'PASS'; generated_at_utc = '2026-08-28T10:00:00.000Z'
            vm_name = $script:VMName; run_id = $script:PriorRunId
            canary = [ordered]@{ binding_sha256 = $bindingSha; binding = $binding }
        }
        $diagnostics = [ordered]@{
            schema = 1; failure_phase = 'journal'; failure_code = 'canary_progress_shape'
            failures = [ordered]@{
                primary = [ordered]@{ phase = 'journal'; code = 'canary_progress_shape' }
                cleanup = $null; postflight = $null; persistence = $null
            }
            processes = [ordered]@{ dry_plan = $null; live = $null }
            checks = [ordered]@{ source_preserved = $null; custody_written = $null; terminal_written = $null }
        }
        $copy = [ordered]@{
            state = 'failed'; verdict = 'FAIL'; generated_at_utc = '2026-08-28T11:00:00.000Z'
            vm_name = $script:VMName; expected_run_id = $script:PriorRunId; raw_content_read = $false
            failure_phase = 'canary_custody'; failure_code = 'canary_custody_incomplete'
            failure_subreason = 'canary_progress_shape'
            stage_b_exit = [ordered]@{
                valid = $true
                record = [ordered]@{
                    schema = 1; run_id = $script:PriorRunId; state = 'wrapper_error'; exit_code = 997
                    exit_code_source = 'wrapper_error'; wrapper_error_stage = 'monitor_launcher'
                    canary = [ordered]@{ arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha }
                    diagnostics = $diagnostics
                }
            }
            canary = [ordered]@{
                verified = $false; complete = $false; custody_state = 'incomplete_wrapper_monitor'
                run_id = $script:PriorRunId; arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha
                attempt_consumed = $true; retry_authorized = $false; source_preserved = $false
                failure_phase = 'journal'; failure_code = 'canary_progress_shape'; files = New-CanaryFilesFixture -Launcher
            }
        }
        $copy = Complete-CanaryCopyFixture $copy

        $actual = Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName

        $actual.state | Should -Be 'closed'
        $actual.attempt_status | Should -Be 'failed'
        $actual.canary_custody | Should -Be 'incomplete'

        $copy.failure_subreason = 'unclassified'
        $copy.canary.failure_code = 'unclassified'
        $copy.stage_b_exit.record.diagnostics.failure_code = 'unclassified'
        $copy.stage_b_exit.record.diagnostics.failures.primary.code = 'unclassified'
        (Assert-Evidence1PreviousRunCustody $placement $copy $script:VMName).attempt_status | Should -Be 'failed'
    }

    It 'rejects malformed incomplete canary custody instead of accepting generic failures' {
        $bindingSha = 'c' * 64
        $binding = [ordered]@{ schema = 1; run_id = $script:PriorRunId; arm = 'product'; planned_sessions = 1 }
        $placement = [ordered]@{
            verdict = 'PASS'; generated_at_utc = '2026-08-28T10:00:00.000Z'
            vm_name = $script:VMName; run_id = $script:PriorRunId
            canary = [ordered]@{ binding_sha256 = $bindingSha; binding = $binding }
        }
        $diagnostics = [ordered]@{
            schema = 1; failure_phase = 'journal'; failure_code = 'canary_progress_shape'
            failures = [ordered]@{ primary = [ordered]@{ phase = 'journal'; code = 'canary_progress_shape' }; cleanup = $null; postflight = $null; persistence = $null }
            processes = [ordered]@{ dry_plan = $null; live = $null }
            checks = [ordered]@{ source_preserved = $null; custody_written = $null; terminal_written = $null }
        }
        $copy = [ordered]@{
            state = 'failed'; verdict = 'FAIL'; generated_at_utc = '2026-08-28T11:00:00.000Z'
            vm_name = $script:VMName; expected_run_id = $script:PriorRunId; raw_content_read = $false
            failure_phase = 'canary_custody'; failure_code = 'canary_custody_incomplete'; failure_subreason = 'canary_progress_shape'
            stage_b_exit = [ordered]@{ valid = $true; record = [ordered]@{
                schema = 1; run_id = $script:PriorRunId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error'
                wrapper_error_stage = 'monitor_launcher'; canary = [ordered]@{ arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha }
                diagnostics = $diagnostics
            } }
            canary = [ordered]@{
                verified = $false; complete = $false; custody_state = 'incomplete_wrapper_monitor'; run_id = $script:PriorRunId
                arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha; attempt_consumed = $true
                retry_authorized = $false; source_preserved = $false; failure_phase = 'journal'
                failure_code = 'canary_progress_shape'; files = New-CanaryFilesFixture -Launcher
            }
        }
        $copy = Complete-CanaryCopyFixture $copy

        foreach ($mutation in @('arbitrary_code','extra_copy','extra_canary','extra_stage','extra_terminal','terminal_exit','terminal_exit_type','planned_type','diagnostics_schema_type','terminal_binding','diagnostics','placement_binding')) {
            $candidate = $copy | ConvertTo-Json -Depth 12 | ConvertFrom-Json
            switch ($mutation) {
                'arbitrary_code' {
                    $candidate.canary.failure_code = 'arbitrary_failure'
                    $candidate.failure_subreason = 'arbitrary_failure'
                    $candidate.stage_b_exit.record.diagnostics.failure_code = 'arbitrary_failure'
                    $candidate.stage_b_exit.record.diagnostics.failures.primary.code = 'arbitrary_failure'
                }
                'extra_copy' { $candidate | Add-Member -NotePropertyName private_note -NotePropertyValue 'sentinel' }
                'extra_canary' { $candidate.canary | Add-Member -NotePropertyName private_note -NotePropertyValue 'sentinel' }
                'extra_stage' { $candidate.stage_b_exit | Add-Member -NotePropertyName private_note -NotePropertyValue 'sentinel' }
                'extra_terminal' { $candidate.stage_b_exit.record | Add-Member -NotePropertyName private_note -NotePropertyValue 'sentinel' }
                'terminal_exit' { $candidate.stage_b_exit.record.exit_code = 1 }
                'terminal_exit_type' { $candidate.stage_b_exit.record.exit_code = '997' }
                'planned_type' { $candidate.canary.planned_sessions = '1' }
                'diagnostics_schema_type' { $candidate.stage_b_exit.record.diagnostics.schema = '1' }
                'terminal_binding' { $candidate.stage_b_exit.record.canary.binding_sha256 = 'd' * 64 }
                'diagnostics' { $candidate.stage_b_exit.record.diagnostics.failure_code = 'canary_terminal_binding' }
                'placement_binding' { $placement.canary.binding_sha256 = 'e' * 64 }
            }
            { Assert-Evidence1PreviousRunCustody $placement $candidate $script:VMName } | Should -Throw
            $placement.canary.binding_sha256 = $bindingSha
        }
    }
}

Describe 'Evidence1 offline copy shutdown custody contract' {
    It 'accepts only the exact consumed run handoff before a graceful shutdown' {
        $runId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
        $bindingSha = 'c' * 64
        $binding = [ordered]@{
            schema = 1; run_id = $runId; arm = 'product'; planned_sessions = 1
            target_commit = 'a' * 40; hashes = [ordered]@{ readiness_sha256 = 'b' * 64 }
        }
        $placement = @{
            verdict = 'PASS'; run_id = $runId; vm_name = 'Evidence1-Runner'
            canary = @{ binding_sha256 = $bindingSha; binding = $binding }
        }
        $handoff = @{
            schema = 1; state = 'started'; run_id = $runId; vm_name = 'Evidence1-Runner'
            generated_at_utc = '2026-08-28T10:01:00.000Z'; vm_state = 'Running'
            target_commit = 'a' * 40; target_tree = 'd' * 40; prior_run_custody = $null; failure_kind = $null
            hard_power_fallback_used = $false; replacement_or_respawn_used = $false; raw_content_read = $false
            canary = @{ binding_sha256 = $bindingSha; binding = ($binding | ConvertTo-Json -Depth 8 | ConvertFrom-Json) }
        }
        $terminal = [pscustomobject]@{
            schema = 1; run_id = $runId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error'
            canary = [pscustomobject]@{ arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha }
        }

        Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' | Should -BeTrue
    }

    It 'rejects missing or nonterminal evidence, binding drift, another run, or any hard-power fallback' {
        $runId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
        $bindingSha = 'c' * 64
        $binding = [ordered]@{
            schema = 1; run_id = $runId; arm = 'product'; planned_sessions = 1
            target_commit = 'a' * 40; hashes = [ordered]@{ readiness_sha256 = 'b' * 64 }
        }
        $placement = @{
            verdict = 'PASS'; run_id = $runId; vm_name = 'Evidence1-Runner'
            canary = @{ binding_sha256 = $bindingSha; binding = $binding }
        }
        $handoff = @{
            schema = 1; state = 'started'; run_id = $runId; vm_name = 'Evidence1-Runner'
            generated_at_utc = '2026-08-28T10:01:00.000Z'; vm_state = 'Running'
            target_commit = 'a' * 40; target_tree = 'd' * 40; prior_run_custody = $null; failure_kind = $null
            hard_power_fallback_used = $false; replacement_or_respawn_used = $false; raw_content_read = $false
            canary = @{ binding_sha256 = $bindingSha; binding = ($binding | ConvertTo-Json -Depth 8 | ConvertFrom-Json) }
        }
        $terminal = [pscustomobject]@{
            schema = 1; run_id = $runId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error'
            canary = [pscustomobject]@{ arm = 'product'; planned_sessions = 1; binding_sha256 = $bindingSha }
        }

        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' 'Evidence1-Runner' } | Should -Throw
        $handoff.state = 'stopping'
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $handoff.state = 'started'; $handoff.hard_power_fallback_used = $true
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $handoff.hard_power_fallback_used = $false
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $null $runId 'Evidence1-Runner' } | Should -Throw
        $placementWithoutCanary = @{ verdict = 'PASS'; run_id = $runId; vm_name = 'Evidence1-Runner' }
        { Assert-Evidence1CanaryShutdownCustody $placementWithoutCanary $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $terminal.state = 'running'
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $terminal.state = 'wrapper_error'; $terminal.canary.binding_sha256 = 'd' * 64
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $terminal.canary.binding_sha256 = $bindingSha; $handoff.canary.binding_sha256 = 'e' * 64
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $handoff.canary.binding_sha256 = $bindingSha; $handoff.canary.binding.target_commit = 'f' * 40
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $handoff.canary.binding.target_commit = 'a' * 40; $handoff.private_note = 'sentinel'
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
        $handoff.Remove('private_note'); $handoff.canary.private_note = 'sentinel'
        { Assert-Evidence1CanaryShutdownCustody $placement $handoff $terminal $runId 'Evidence1-Runner' } | Should -Throw
    }
}
