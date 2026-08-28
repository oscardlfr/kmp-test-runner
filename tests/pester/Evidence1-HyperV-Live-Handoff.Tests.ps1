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
}
