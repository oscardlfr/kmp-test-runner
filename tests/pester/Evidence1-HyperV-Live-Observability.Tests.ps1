#Requires -Modules Pester

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:AuditRoot = Join-Path $script:RepoRoot 'docs\audits'
    $script:ContractPath = Join-Path $script:AuditRoot 'evidence1-live-run-contract.psm1'
    $script:WrapperPath = Join-Path $script:AuditRoot 'evidence1-stageb-live-wrapper.ps1'
    $script:PlacePath = Join-Path $script:AuditRoot 'evidence1-hyperv-place-live-autorun.ps1'
    $script:ProgressPath = Join-Path $script:AuditRoot 'evidence1-hyperv-read-live-progress.ps1'
    $script:LauncherPath = Join-Path $script:AuditRoot 'evidence1-stageb-live-launch.ps1'
    Import-Module $script:ContractPath -Force
}

Describe 'Evidence1 canary one-use and journal contracts' {
    BeforeEach {
        $script:CanaryId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
        $script:BindingHash = 'a' * 64
        $script:CanaryDirectory = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:CanaryDirectory | Out-Null
    }

    It 'reserves wrapper and launcher once and preserves consumed evidence on replay' {
        $first = New-Evidence1CanaryClaim $script:CanaryDirectory $script:CanaryId $script:BindingHash 'wrapper'
        $first.phase | Should -BeExactly 'wrapper'
        $path = Join-Path $script:CanaryDirectory 'wrapper.claim.json'
        $before = (Get-FileHash $path).Hash
        { New-Evidence1CanaryClaim $script:CanaryDirectory $script:CanaryId $script:BindingHash 'wrapper' } | Should -Throw '*canary*'
        (Get-FileHash $path).Hash | Should -BeExactly $before
        $launch = New-Evidence1CanaryClaim $script:CanaryDirectory $script:CanaryId $script:BindingHash 'launcher'
        $launch.run_id | Should -BeExactly $script:CanaryId
        { New-Evidence1CanaryClaim $script:CanaryDirectory $script:CanaryId $script:BindingHash 'launcher' } | Should -Throw '*canary*'
    }

    It 'rejects direct launcher dispatch and cross-run or cross-binding claims' {
        { New-Evidence1CanaryClaim $script:CanaryDirectory $script:CanaryId $script:BindingHash 'launcher' } | Should -Throw '*canary*'
        $null = New-Evidence1CanaryClaim $script:CanaryDirectory $script:CanaryId $script:BindingHash 'wrapper'
        { New-Evidence1CanaryClaim $script:CanaryDirectory ([guid]::NewGuid().ToString()) $script:BindingHash 'launcher' } | Should -Throw '*canary*'
        { New-Evidence1CanaryClaim $script:CanaryDirectory $script:CanaryId ('b' * 64) 'launcher' } | Should -Throw '*canary*'
        Test-Path (Join-Path $script:CanaryDirectory 'launcher.claim.json') | Should -BeFalse
    }

    It 'ignores historical journals even when they are newest and binds the one newly created journal' {
        $oldId = [guid]::NewGuid().ToString(); $newId = [guid]::NewGuid().ToString()
        New-Item -ItemType Directory -Path (Join-Path $script:CanaryDirectory $oldId) | Out-Null
        $pending = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @($oldId) $script:CanaryId
        $pending.journal_id | Should -BeNullOrEmpty
        $events = Join-Path $script:CanaryDirectory "$newId/events"
        New-Item -ItemType Directory -Path $events | Out-Null
        [IO.File]::WriteAllText((Join-Path $events '000000-0000-planned.json'), '{"seq":0,"runKind":"scenario","cellOrdinal":0,"transition":"planned","meta":{}}')
        (Get-Item (Join-Path $script:CanaryDirectory $oldId)).LastWriteTimeUtc = [datetime]::UtcNow.AddHours(1)
        $progress = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @($oldId) $script:CanaryId
        $progress.run_id | Should -BeExactly $script:CanaryId
        $progress.journal_id | Should -BeExactly $newId
        $progress.transition_counts.planned | Should -Be 1
        $progress.event_count | Should -Be 1
    }

    It 'rejects multiple new journals rather than selecting the newest' {
        foreach ($i in 1..2) { New-Item -ItemType Directory -Path (Join-Path $script:CanaryDirectory ([guid]::NewGuid().ToString())) | Out-Null }
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId } | Should -Throw '*canary*'
    }

    It 'rejects a second cell, duplicate spawn, or a journal belonging to a different run' {
        $newId = [guid]::NewGuid().ToString()
        $events = Join-Path $script:CanaryDirectory "$newId/events"
        New-Item -ItemType Directory -Path $events | Out-Null
        [IO.File]::WriteAllText((Join-Path $events '000000-0000-planned.json'), '{"seq":0,"runKind":"scenario","cellOrdinal":0,"transition":"planned","meta":{}}')
        $progress = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() ([guid]::NewGuid().ToString()) $progress } | Should -Throw '*canary*'
        [IO.File]::WriteAllText((Join-Path $events '000001-0001-planned.json'), '{"seq":1,"runKind":"scenario","cellOrdinal":1,"transition":"planned","meta":{}}')
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId } | Should -Throw '*canary*'
        Remove-Item (Join-Path $events '000001-0001-planned.json')
        foreach ($i in 1..2) { [IO.File]::WriteAllText((Join-Path $events ('{0:d6}-0000-spawn_started.json' -f $i)), ('{"seq":' + $i + ',"runKind":"scenario","cellOrdinal":0,"transition":"spawn_started","meta":{}}')) }
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId } | Should -Throw '*canary*'
    }

    It 'keeps publication pending before and after the atomic hardlink, then reads the committed event' {
        $newId = [guid]::NewGuid().ToString()
        $events = Join-Path $script:CanaryDirectory "$newId/events"
        New-Item -ItemType Directory -Path $events | Out-Null
        $target = Join-Path $events '000000000000-0-planned.json'
        $temp = $target + '.tmp-1234abcd'
        [IO.File]::WriteAllText($temp, '{"seq":0,"runKind":"scenario","cellOrdinal":0,"transition":"planned","meta":{}}')
        $before = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId
        $before.publication_pending | Should -BeTrue
        $before.event_count | Should -Be 0
        New-Item -ItemType HardLink -Path $target -Target $temp | Out-Null
        $linked = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $before
        $linked.publication_pending | Should -BeTrue
        $linked.event_count | Should -Be 0
        Remove-Item -LiteralPath $temp
        $committed = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $linked
        $committed.publication_pending | Should -BeFalse
        $committed.transition_counts.planned | Should -Be 1
    }

    It 'opens bounded JSON snapshots with delete sharing so atomic replacement cannot be blocked' {
        $definition = (Get-Command Read-Evidence1CanaryJson).ScriptBlock.Ast.Extent.Text
        $definition | Should -Match '\[IO\.FileShare\]::ReadWrite\s+-bor\s+\[IO\.FileShare\]::Delete'
    }

    It 'accepts bound journal retirement only after process exit and preserves the last safe snapshot' {
        $newId = [guid]::NewGuid().ToString()
        $events = Join-Path $script:CanaryDirectory "$newId/events"
        New-Item -ItemType Directory -Path $events | Out-Null
        [IO.File]::WriteAllText((Join-Path $events '000000000000-0-planned.json'), '{"seq":0,"runKind":"scenario","cellOrdinal":0,"transition":"planned","meta":{}}')
        $previous = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId
        Remove-Item -LiteralPath (Join-Path $script:CanaryDirectory $newId) -Recurse

        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $previous } | Should -Throw '*canary_journal_retiring*'
        $retired = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $previous -AllowRetiredAfterProcessExit
        $retired.available | Should -BeFalse
        $retired.journal_id | Should -BeExactly $newId
        $retired.event_count | Should -Be 1
        $retired.transition_counts.planned | Should -Be 1
    }

    It 'accepts terminal partial retirement but rejects retirement without a bound safe planned snapshot' {
        $newId = [guid]::NewGuid().ToString()
        $events = Join-Path $script:CanaryDirectory "$newId/events"
        New-Item -ItemType Directory -Path $events | Out-Null
        [IO.File]::WriteAllText((Join-Path $events '000000000000-0-planned.json'), '{"seq":0,"runKind":"scenario","cellOrdinal":0,"transition":"planned","meta":{}}')
        [IO.File]::WriteAllText((Join-Path $events '000000000001-0-spawn_started.json'), '{"seq":1,"runKind":"scenario","cellOrdinal":0,"transition":"spawn_started","meta":{}}')
        $previous = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId
        Remove-Item -LiteralPath (Join-Path $events '000000000000-0-planned.json')

        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $previous } | Should -Throw '*canary_journal_retiring*'
        $retired = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $previous -AllowRetiredAfterProcessExit
        $retired.event_count | Should -Be 2
        $retired.transition_counts.planned | Should -Be 1

        $unsafe = [ordered]@{ run_id = $script:CanaryId; journal_id = $newId; available = $true; event_count = 0
            latest_event = $null; transition_counts = @{}; publication_pending = $false; publication_pending_since_utc = $null }
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $unsafe -AllowRetiredAfterProcessExit } | Should -Throw '*canary*'
        try { $null = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $unsafe }
        catch { $_.Exception.Message | Should -BeExactly 'canary_journal_planned' }
        Remove-Item -LiteralPath (Join-Path $script:CanaryDirectory $newId) -Recurse
        try { $null = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $unsafe }
        catch { $_.Exception.Message | Should -BeExactly 'canary_journal_retirement' }
    }

    It 'rejects persistent publication windows, unrelated hardlinks, and unknown files' {
        $newId = [guid]::NewGuid().ToString()
        $events = Join-Path $script:CanaryDirectory "$newId/events"
        New-Item -ItemType Directory -Path $events | Out-Null
        $target = Join-Path $events '000000000000-0-planned.json'
        $temp = $target + '.tmp-1234abcd'
        [IO.File]::WriteAllText($temp, '{}')
        $now = [datetime]::UtcNow
        $pending = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId -NowUtc $now
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId $pending -NowUtc $now.AddSeconds(6) } | Should -Throw '*canary*'
        Remove-Item -LiteralPath $temp
        [IO.File]::WriteAllText($target, '{"seq":0,"runKind":"scenario","cellOrdinal":0,"transition":"planned","meta":{}}')
        New-Item -ItemType HardLink -Path (Join-Path $script:CanaryDirectory 'external-link') -Target $target | Out-Null
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId } | Should -Throw '*canary*'
        Remove-Item (Join-Path $script:CanaryDirectory 'external-link')
        [IO.File]::WriteAllText((Join-Path $events 'raw.json'), '{}')
        { Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId } | Should -Throw '*canary*'
    }

    It 'preserves primary failure independently from cleanup, postflight and persistence without leaking exception text' {
        $diagnostics = New-Evidence1CanaryDiagnostics
        try { throw 'canary_dry_plan_changed' } catch { Set-Evidence1CanaryFailure $diagnostics 'primary' 'dry_plan' $_ }
        try { throw 'job_create' } catch { Set-Evidence1CanaryFailure $diagnostics 'cleanup' 'live' $_ }
        try { throw 'canary_sdk_changed' } catch { Set-Evidence1CanaryFailure $diagnostics 'postflight' 'postflight' $_ }
        try { throw 'failed to write C:\private\secret.json with secret-value' } catch { Set-Evidence1CanaryFailure $diagnostics 'persistence' 'terminal_write' $_ }
        $diagnostics.failure_phase | Should -BeExactly 'dry_plan'
        $diagnostics.failure_code | Should -BeExactly 'canary_dry_plan_changed'
        $diagnostics.failures.cleanup.code | Should -BeExactly 'job_create'
        $diagnostics.failures.postflight.code | Should -BeExactly 'canary_sdk_changed'
        $diagnostics.failures.persistence.code | Should -BeExactly 'unclassified'
        ($diagnostics | ConvertTo-Json -Depth 10) | Should -Not -Match 'private|secret-value|secret.json'
    }

    It 'rejects unknown fields and raw content in transported canary progress and diagnostics' {
        $progress = Get-Evidence1CanaryJournalProgress $script:CanaryDirectory @() $script:CanaryId
        (ConvertTo-Evidence1CanaryJournalSnapshot $progress $script:CanaryId).event_count | Should -Be 0
        $progress.raw = 'secret-value'
        { ConvertTo-Evidence1CanaryJournalSnapshot $progress $script:CanaryId } | Should -Throw '*canary*'
        $diagnostics = New-Evidence1CanaryDiagnostics
        (ConvertTo-Evidence1CanaryDiagnostics $diagnostics).schema | Should -Be 1
        $diagnostics.failures.primary = @{ phase = 'live'; code = 'C:\private\secret-value' }
        { ConvertTo-Evidence1CanaryDiagnostics $diagnostics } | Should -Throw '*canary*'
    }
}

Describe 'Evidence1 canary launcher runtime failures' {
    BeforeAll {
        Import-Module (Join-Path $script:AuditRoot 'evidence1-validation-ops.psm1') -Force
        Import-Module (Join-Path $script:AuditRoot 'evidence1-gradle-offline-probe.psm1') -Force
        . $script:LauncherPath -LoadOnly
        $ast = [Management.Automation.Language.Parser]::ParseFile($script:LauncherPath, [ref]$null, [ref]$null)
        $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Evidence1CanaryLaunch' }, $true).Extent.Text
        $definition = $definition.Replace("'C:\Evidence1Ops'", '$script:FixtureOps').Replace("'C:\kmp-eval\scratch\evidence1-validation-ops'", '$script:FixtureOps')
        $definition = $definition.Replace('$PSScriptRoot', '$script:AuditRoot')
        $definition = $definition.Replace('Global\Evidence1ValidationOps', ('Local\Evidence1CanaryFixture-' + [guid]::NewGuid().ToString('N')))
        . ([scriptblock]::Create($definition))
        function Invoke-FixtureClaude { $global:LASTEXITCODE = 0; return '2.1.238 (Claude Code)' }
    }
    BeforeEach {
        $RunId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
        $CanaryArm = 'product'; $CanaryBindingSha256 = 'a' * 64
        $script:FixtureOps = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:FixtureOps | Out-Null
        $GradleUserHomeSeedDir = $script:FixtureOps; $TerminalRecordPath = Join-Path $script:FixtureOps 'terminal.json'
        $script:FixtureWrites = @{}; $script:FixtureCalls = [Collections.Generic.List[string]]::new()
        $script:JournalCalls = 0; $script:InventoryCalls = 0
        $script:FixtureOp = [pscustomobject]@{ Task = [pscustomobject]@{ IsCompleted = $false } }
        $script:FixtureResult = [pscustomobject]@{ ExitCode = 0; WallSeconds = 1.0; TimedOut = $false; CleanupOk = $true; Cancelled = $false }
        [IO.File]::WriteAllText((Join-Path $script:FixtureOps 'prelaunch-dry.stderr.txt'), '')
        Mock Import-Module { }
        Mock Refresh-StageBPath { }
        Mock Set-StageBClaudeNetworkEnvironment { }
        Mock Read-Evidence1CanaryBundle { @{ binding = @{ target_commit = 'b'*40; target_tree = 'c'*40; source_commit = 'd'*40; campaign_design_id = 'claude-product-canary-v1'; plan_sha256 = 'e'*64; hashes = @{ attestation_canonical_sha256 = 'f'*64; execution_profile_sha256 = '0'*64 } } } }
        Mock New-Evidence1CanaryClaim { }
        Mock Assert-E1NoGuestLive { }
        Mock Assert-E1Repo { }
        Mock Assert-Evidence1CanaryGuestEvidence { }
        Mock Get-Evidence1CanaryValidationInventory { $script:InventoryCalls++; return ('d'*64) }
        Mock Command-Source { 'Invoke-FixtureClaude' }
        Mock Assert-CredentialEnvironmentPosture { }
        Mock Assert-ClaudeAuthReady { }
        Mock Assert-RestrictedNetwork { }
        Mock Assert-RemoteAuthCanary { }
        Mock Read-ReadinessLedger { }
        Mock Read-Evidence1CanaryJson { @{ value = @{ run_id = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'; binding_sha256 = 'a'*64; journal_ids = @() } } }
        Mock Get-Evidence1CanaryJournalProgress {
            $script:JournalCalls++
            if ($script:JournalCalls -gt 1) { $script:FixtureOp.Task.IsCompleted = $true }
            $journalId = if ($script:JournalCalls -gt 1) { '69cd5780-49fa-4531-960a-e26cbd7fda54' } else { $null }
            @{ run_id = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'; journal_id = $journalId; available = $null -ne $journalId
                event_count = $(if ($journalId) { 1 } else { 0 }); latest_event = $(if ($journalId) { '000000000000-0-planned.json' } else { $null })
                transition_counts = $(if ($journalId) { @{ planned = 1 } } else { @{} }); publication_pending = $false; publication_pending_since_utc = $null }
        }
        Mock New-Evidence1CanarySource { @{ path = $script:FixtureOps; directory = $script:FixtureOps; tree = 'e'*40; before = @{} } }
        Mock Get-E1SourceSnapshot { @{ tree = 'e'*40 } }
        Mock Get-E1OfflineSdk { @{ root = $script:FixtureOps; configuration_sha256 = 'a'*64; build_tools_sha256 = 'b'*64 } }
        Mock Get-Evidence1CanaryArguments { @('fixture-only') }
        Mock Invoke-E1OwnedProcess { [pscustomobject]@{ ExitCode = 0; WallSeconds = 1.0; TimedOut = $false; CleanupOk = $true } }
        Mock Start-E1OwnedProcess { $script:FixtureCalls.Add('start'); $script:FixtureOp }
        Mock Stop-E1OwnedProcess { $script:FixtureCalls.Add('stop'); $script:FixtureOp.Task.IsCompleted = $true }
        Mock Wait-E1OwnedProcess { $script:FixtureCalls.Add('wait'); $script:FixtureResult }
        Mock Start-Sleep { }
        Mock Read-E1Json { @{ value = @{}; sha256 = 'e'*64 } }
        Mock Get-E1DryChecks { @{ pass = $true } }
        Mock Assert-E1SourcePostflight { }
        Mock Write-Evidence1JsonAtomically {
            param($Path, $Value)
            $script:FixtureWrites[[IO.Path]::GetFileName($Path)] = $Value | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        }
    }
    It 'uses the owned async operation, observes its journal and waits for cleanup before success' {
        Invoke-Evidence1CanaryLaunch | Should -Be 0
        ($script:FixtureCalls -join ',') | Should -BeExactly 'start,wait'
        Should -Invoke Invoke-E1OwnedProcess -Times 1 -Exactly
        Should -Invoke Start-E1OwnedProcess -Times 1 -Exactly -ParameterFilter { $Seconds -eq 1800 }
        $script:FixtureWrites['terminal.json'].diagnostics.processes.live.cleanup_ok | Should -BeTrue
        $script:FixtureWrites['terminal.json'].diagnostics.failure_code | Should -BeNullOrEmpty
        Should -Invoke Get-Evidence1CanaryJournalProgress -Times 1 -Exactly -ParameterFilter { $AllowRetiredAfterProcessExit }
    }
    It 'cancels and joins on a journal failure without replacing it with cleanup or postflight failures' {
        Mock Get-Evidence1CanaryJournalProgress {
            $script:JournalCalls++
            if ($script:JournalCalls -gt 1) { throw 'canary_journal_cell' }
            @{ journal_id = $null; publication_pending = $false }
        }
        Mock Get-Evidence1CanaryValidationInventory {
            $script:InventoryCalls++
            if ($script:InventoryCalls -gt 2) { throw 'canary_validation_changed' }
            return ('d'*64)
        }
        $script:FixtureResult.ExitCode = 130; $script:FixtureResult.Cancelled = $true; $script:FixtureResult.CleanupOk = $false
        Invoke-Evidence1CanaryLaunch | Should -Be 997
        ($script:FixtureCalls -join ',') | Should -BeExactly 'start,stop,wait'
        $record = $script:FixtureWrites['terminal.json']
        $record.diagnostics.failure_phase | Should -BeExactly 'journal'
        $record.diagnostics.failure_code | Should -BeExactly 'canary_journal_cell'
        $record.diagnostics.failures.cleanup.code | Should -BeExactly 'canary_process_cleanup'
        $record.diagnostics.failures.postflight.code | Should -BeExactly 'canary_validation_changed'
        $record.diagnostics.processes.live.exit_code | Should -Be 130
    }

    It 'bridges only a bounded retirement race when the owned task completes' {
        $script:JournalCalls = 0
        $script:RetirementObserved = $false
        Mock Get-Evidence1CanaryJournalProgress {
            param($JournalRoot, $BaselineIds, $ExpectedRunId, $Previous, $NowUtc, [switch]$AllowRetiredAfterProcessExit)
            $script:JournalCalls++
            if ($script:JournalCalls -eq 1) {
                return @{ run_id = $RunId; journal_id = $null; available = $false; event_count = 0; latest_event = $null
                    transition_counts = @{}; publication_pending = $false; publication_pending_since_utc = $null }
            }
            if ($script:JournalCalls -eq 2) {
                return @{ run_id = $RunId; journal_id = '69cd5780-49fa-4531-960a-e26cbd7fda54'; available = $true; event_count = 1
                    latest_event = '000000000000-0-planned.json'; transition_counts = @{ planned = 1 }
                    publication_pending = $false; publication_pending_since_utc = $null }
            }
            if (-not $AllowRetiredAfterProcessExit) { $script:RetirementObserved = $true; throw 'canary_journal_retiring' }
            return @{ run_id = $RunId; journal_id = '69cd5780-49fa-4531-960a-e26cbd7fda54'; available = $false; event_count = 1
                latest_event = '000000000000-0-planned.json'; transition_counts = @{ planned = 1 }
                publication_pending = $false; publication_pending_since_utc = $null }
        }
        Mock Start-Sleep { if ($script:RetirementObserved) { $script:FixtureOp.Task.IsCompleted = $true } }

        Invoke-Evidence1CanaryLaunch | Should -Be 0
        ($script:FixtureCalls -join ',') | Should -BeExactly 'start,wait'
        Should -Invoke Get-Evidence1CanaryJournalProgress -Times 1 -Exactly -ParameterFilter { $AllowRetiredAfterProcessExit }
        Should -Invoke Stop-E1OwnedProcess -Times 0 -Exactly
    }

    It 'does not accept retirement while the owned task remains active' {
        $script:JournalCalls = 0
        Mock Get-Evidence1CanaryJournalProgress {
            $script:JournalCalls++
            if ($script:JournalCalls -eq 1) { return @{ run_id = $RunId; journal_id = $null; publication_pending = $false } }
            if ($script:JournalCalls -eq 2) { return @{ run_id = $RunId; journal_id = '69cd5780-49fa-4531-960a-e26cbd7fda54'; publication_pending = $false } }
            throw 'canary_journal_retiring'
        }
        $script:FixtureResult.ExitCode = 130; $script:FixtureResult.Cancelled = $true

        Invoke-Evidence1CanaryLaunch | Should -Be 997
        ($script:FixtureCalls -join ',') | Should -BeExactly 'start,stop,wait'
        Should -Invoke Get-Evidence1CanaryJournalProgress -Times 0 -Exactly -ParameterFilter { $AllowRetiredAfterProcessExit }
        $script:FixtureWrites['terminal.json'].diagnostics.failure_code | Should -BeExactly 'canary_journal_retiring'
    }
    It 'preserves a source-clone primary failure in custody when terminal persistence also fails' {
        Mock New-Evidence1CanarySource { throw 'canary_source_invalid' }
        Mock Write-Evidence1JsonAtomically {
            param($Path, $Value)
            if ([IO.Path]::GetFileName($Path) -eq 'terminal.json') { throw 'C:\private\secret.json could not be written' }
            $script:FixtureWrites[[IO.Path]::GetFileName($Path)] = $Value | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        }
        Invoke-Evidence1CanaryLaunch | Should -Be 997
        Should -Invoke Start-E1OwnedProcess -Times 0 -Exactly
        Should -Invoke Invoke-E1OwnedProcess -Times 0 -Exactly
        Should -Invoke Assert-E1SourcePostflight -Times 1 -Exactly
        $record = $script:FixtureWrites['source-custody.json']
        $record.diagnostics.failure_phase | Should -BeExactly 'source_clone'
        $record.diagnostics.failure_code | Should -BeExactly 'canary_source_invalid'
        $record.diagnostics.failures.persistence.phase | Should -BeExactly 'terminal_write'
        $record.diagnostics.failures.persistence.code | Should -BeExactly 'unclassified'
        ($record | ConvertTo-Json -Depth 15) | Should -Not -Match 'private|secret.json'
    }
}

Describe 'Evidence1 canary wrapper terminal routing' {
    BeforeAll {
        Import-Module (Join-Path $script:AuditRoot 'evidence1-validation-ops.psm1') -Force
        $ast = [Management.Automation.Language.Parser]::ParseFile($script:WrapperPath, [ref]$null, [ref]$null)
        $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Evidence1CanaryWrapper' }, $true)
        if ($definition) { . ([scriptblock]::Create($definition.Extent.Text)) }
        function Write-Status { param($CurrentState, $CurrentExitCode) }
    }
    BeforeEach {
        $RunId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'; $CanaryArm = 'product'; $CanaryBindingSha256 = 'a'*64
        $HarnessDir = $TestDrive; $stdoutPath = Join-Path $TestDrive 'stdout'; $stderrPath = Join-Path $TestDrive 'stderr'
        $launcherTerminalPath = Join-Path $TestDrive 'terminal.json'
        $script:exitCode = 997
        $script:FixtureTerminal = @{ valid = $true; exit_code = 7; record = @{ run_id = $RunId; canary = @{ arm = $CanaryArm; planned_sessions = 1; binding_sha256 = $CanaryBindingSha256 }; diagnostics = New-Evidence1CanaryDiagnostics } }
        Mock Start-E1OwnedProcess { @{ Task = @{ IsCompleted = $true } } }
        Mock Wait-E1OwnedProcess { @{ ExitCode = 7; TimedOut = $false; Cancelled = $false; CleanupOk = $true } }
        Mock Read-Evidence1TerminalRecord { $script:FixtureTerminal }
        Mock Write-Status { }
    }
    It 'uses owned direct-file transport and carries the bound launcher terminal diagnosis' {
        Invoke-Evidence1CanaryWrapper 'fixture.exe' @('fixture-only')
        $script:exitCode | Should -Be 7
        Should -Invoke Start-E1OwnedProcess -Exactly -Times 1 -ParameterFilter { $Stdout -eq $stdoutPath -and $Stderr -eq $stderrPath }
        Should -Invoke Wait-E1OwnedProcess -Exactly -Times 1
        $script:CanaryLauncherDiagnostics.schema | Should -Be 1
    }
    It 'rejects a same-run terminal for the wrong arm or binding' {
        $script:FixtureTerminal.record.canary.arm = 'free-baseline'
        { Invoke-Evidence1CanaryWrapper 'fixture.exe' @('fixture-only') } | Should -Throw '*canary_terminal_binding*'
        $script:FixtureTerminal.record.canary.arm = 'product'; $script:FixtureTerminal.record.canary.binding_sha256 = 'b'*64
        { Invoke-Evidence1CanaryWrapper 'fixture.exe' @('fixture-only') } | Should -Throw '*canary_terminal_binding*'
    }
    It 'never promotes a process exit code when the canary terminal is missing or stale' {
        $script:FixtureTerminal.valid = $false
        { Invoke-Evidence1CanaryWrapper 'fixture.exe' @('fixture-only') } | Should -Throw '*canary_terminal_required*'
        $script:exitCode | Should -Be 997
    }
}

Describe 'Evidence1 canary wrapper claimed preflight lifecycle' {
    BeforeAll {
        Import-Module (Join-Path $script:AuditRoot 'evidence1-validation-ops.psm1') -Force
        $script:RealCanaryJsonWriter = (Get-Command Write-Evidence1JsonAtomically).ScriptBlock
        $source = [IO.File]::ReadAllText($script:WrapperPath)
        $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
        $exits = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.ExitStatementAst] }, $true))
        if ($exits.Count -ne 1) { throw 'fixture requires the single wrapper exit' }
        $exit = $exits[0].Extent
        $source = $source.Substring(0, $exit.StartOffset) + 'return $exitCode' + $source.Substring($exit.EndOffset)
        $source = $source.Replace('$PSScriptRoot', ('$script:AuditRoot'))
        $source = $source.Replace('& (Join-Path $env:SystemRoot ''System32\shutdown.exe'')', 'Invoke-FixtureShutdown')
        $source = $source.Replace('New-Item -Path $regPath -Force | Out-Null', 'Invoke-FixtureRegistry')
        $source = $source.Replace('New-ItemProperty -Path $regPath -Name ''Evidence1StageBProgress'' -Value ($snapshot | ConvertTo-Json -Depth 8 -Compress) -PropertyType String -Force | Out-Null', 'Invoke-FixtureRegistry')
        if ($source.Contains('shutdown.exe')) { throw 'fixture must never invoke real shutdown' }
        if ($source.Contains('New-ItemProperty')) { throw 'fixture must never write the registry' }
        $script:WholeCanaryWrapper = [scriptblock]::Create($source)
        function Invoke-FixtureShutdown { param([Parameter(ValueFromRemainingArguments)]$Arguments) }
        function Invoke-FixtureRegistry { throw 'fixture_registry_disabled' }
        function Invoke-ClaimedWrapperFixture {
            try {
                $code = & $script:WholeCanaryWrapper -RunId $script:LifecycleId -CanaryArm product -CanaryBindingSha256 ('a'*64) `
                    -OpsDir $script:LifecycleOps -HarnessDir $script:LifecycleHarness -LauncherPath $script:LifecycleLauncher -ShutdownOnExit
                return @{ exit_code = $code; error = $null }
            } catch { return @{ exit_code = $null; error = $_.Exception.Message } }
        }
        function Assert-SharedCanarySentinels {
            foreach ($path in $script:LifecycleSentinels.Keys) { (Get-FileHash -LiteralPath $path).Hash | Should -BeExactly $script:LifecycleSentinels[$path] }
        }
    }
    BeforeEach {
        $script:LifecycleId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
        $script:LifecycleOps = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $script:LifecycleHarness = Join-Path $script:LifecycleOps 'harness'
        $script:LifecycleJournal = Join-Path $script:LifecycleHarness 'tools/runs/agentic-eval-journal'
        $script:LifecycleBundle = Join-Path $script:LifecycleOps "canary/$script:LifecycleId"
        New-Item -ItemType Directory -Path $script:LifecycleJournal, $script:LifecycleBundle | Out-Null
        $script:LifecycleLauncher = Join-Path $script:LifecycleOps 'launcher.ps1'
        [IO.File]::WriteAllText($script:LifecycleLauncher, '# never executed')
        $script:LifecycleLauncherHash = (Get-FileHash $script:LifecycleLauncher).Hash.ToLowerInvariant()
        $script:LifecycleSentinels = @{}
        foreach ($name in @('STAGE-B-live.stdout.log','STAGE-B-live.stderr.log','STAGE-B-live.status.json','STAGE-B-live.exit.json','STAGE-B-live.launcher-exit.json')) {
            $path = Join-Path $script:LifecycleOps $name
            [IO.File]::WriteAllText($path, 'prior-run-evidence')
            $script:LifecycleSentinels[$path] = (Get-FileHash $path).Hash
        }
        $script:LifecycleMode = 'enumeration'; $script:LifecycleShutdowns = 0
        $script:LifecycleWrites = [Collections.Generic.List[string]]::new()
        Mock Import-Module { }
        Mock Read-Evidence1CanaryBundle {
            if ($script:LifecycleMode -eq 'binding') { throw 'canary_bundle_invalid' }
            @{ binding = @{ scripts = @{ 'evidence1-stageb-live-launch.ps1' = $script:LifecycleLauncherHash } } }
        }
        Mock Get-ChildItem { throw 'canary_journal_baseline' } -ParameterFilter {
            $LiteralPath -eq $script:LifecycleJournal -and $script:LifecycleMode -in @('enumeration','status','terminal')
        }
        Mock Write-Evidence1JsonAtomically {
            param($Path, $Value)
            $name = [IO.Path]::GetFileName($Path)
            $script:LifecycleWrites.Add($name)
            if ($name -eq 'STAGE-B-live.status.json' -and $script:LifecycleMode -eq 'status') { throw 'private status write failure' }
            if ($name -eq 'STAGE-B-live.exit.json' -and $script:LifecycleMode -eq 'terminal') { throw 'fixture_terminal_write_failure' }
            & $script:RealCanaryJsonWriter -Path $Path -Value $Value
        }
        Mock Invoke-FixtureShutdown { $script:LifecycleShutdowns++ }
        Mock Start-E1OwnedProcess { throw 'fixture_dispatch_forbidden' }
    }
    It 'publishes a bound failed terminal and shuts down after claimed baseline enumeration fails' {
        $result = Invoke-ClaimedWrapperFixture
        $result.error | Should -BeNullOrEmpty
        $result.exit_code | Should -Be 997
        Test-Path (Join-Path $script:LifecycleBundle 'wrapper.claim.json') | Should -BeTrue
        $terminal = (Read-Evidence1CanaryJson (Join-Path $script:LifecycleOps 'STAGE-B-live.exit.json')).value
        Assert-Evidence1CanaryTerminalBinding $terminal $script:LifecycleId product ('a'*64)
        $terminal.wrapper_error_stage | Should -BeExactly 'initialize_journal'
        $terminal.diagnostics.failure_phase | Should -BeExactly 'guest_preflight'
        $terminal.diagnostics.failure_code | Should -BeExactly 'canary_journal_baseline'
        $script:LifecycleShutdowns | Should -Be 1
        Should -Invoke Start-E1OwnedProcess -Times 0 -Exactly
    }
    It 'keeps the baseline failure primary when final status persistence also fails' {
        $script:LifecycleMode = 'status'
        $result = Invoke-ClaimedWrapperFixture
        $result.error | Should -BeNullOrEmpty
        $result.exit_code | Should -Be 997
        $terminal = (Read-Evidence1CanaryJson (Join-Path $script:LifecycleOps 'STAGE-B-live.exit.json')).value
        $terminal.diagnostics.failure_code | Should -BeExactly 'canary_journal_baseline'
        $terminal.diagnostics.failures.persistence.code | Should -BeExactly 'unclassified'
        ($terminal | ConvertTo-Json -Depth 12) | Should -Not -Match 'private status'
        $script:LifecycleShutdowns | Should -Be 1
        Should -Invoke Start-E1OwnedProcess -Times 0 -Exactly
    }
    It 'still shuts down when the post-claim terminal write itself fails' {
        $script:LifecycleMode = 'terminal'
        $result = Invoke-ClaimedWrapperFixture
        $result.error | Should -BeExactly 'fixture_terminal_write_failure'
        $script:LifecycleWrites | Should -Contain 'STAGE-B-live.exit.json'
        $script:LifecycleShutdowns | Should -Be 1
        Should -Invoke Start-E1OwnedProcess -Times 0 -Exactly
    }
    It 'preserves shared evidence and claims without shutdown or dispatch for <Mode>' -TestCases @(
        @{ Mode = 'binding' }, @{ Mode = 'launcher' }, @{ Mode = 'replay' }
    ) {
        param($Mode)
        $script:LifecycleMode = $Mode
        $claimPath = Join-Path $script:LifecycleBundle 'wrapper.claim.json'
        if ($Mode -eq 'replay') { $null = New-Evidence1CanaryClaim $script:LifecycleBundle $script:LifecycleId ('a'*64) wrapper; $claimHash = (Get-FileHash $claimPath).Hash }
        if ($Mode -eq 'launcher') { [IO.File]::AppendAllText($script:LifecycleLauncher, '# drift') }
        $result = Invoke-ClaimedWrapperFixture
        $result.error | Should -Match '^canary_'
        Assert-SharedCanarySentinels
        if ($Mode -eq 'replay') { (Get-FileHash $claimPath).Hash | Should -BeExactly $claimHash }
        else { Test-Path $claimPath | Should -BeFalse }
        $script:LifecycleWrites.Count | Should -Be 0
        $script:LifecycleShutdowns | Should -Be 0
        Should -Invoke Start-E1OwnedProcess -Times 0 -Exactly
    }
}

Describe 'Evidence1 canary source custody' {
    BeforeAll {
        $script:CloneFixtureRoot = 'C:\kmp-eval\.smoke'
        $script:CloneFixture = Join-Path $script:CloneFixtureRoot ('canary-source-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:CloneFixture | Out-Null
        $script:FixtureSource = Join-Path $script:CloneFixture 'preserved'
        New-Item -ItemType Directory -Path $script:FixtureSource | Out-Null
        & git init --quiet $script:FixtureSource
        [IO.File]::WriteAllText((Join-Path $script:FixtureSource 'build.gradle.kts'), '// pinned source')
        [IO.File]::WriteAllText((Join-Path $script:FixtureSource '.gitignore'), "build/`n.gradle/`n")
        & git -C $script:FixtureSource add .
        & git -C $script:FixtureSource -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=NUL commit --quiet -m fixture
        $script:FixtureCommit = (& git -C $script:FixtureSource rev-parse HEAD).Trim()
        New-Item -ItemType Directory -Path (Join-Path $script:FixtureSource '.kmp-test-runner/reports/coverage'), (Join-Path $script:FixtureSource 'build') | Out-Null
        [IO.File]::WriteAllText((Join-Path $script:FixtureSource '.kmp-test-runner/reports/coverage/20260831-120000-000001.md'), 'failed V2 evidence')
        [IO.File]::WriteAllText((Join-Path $script:FixtureSource 'build/failed.xml'), '<failed/>')
    }
    AfterAll {
        $root = [IO.Path]::GetFullPath($script:CloneFixtureRoot).TrimEnd('\') + '\'
        $target = [IO.Path]::GetFullPath($script:CloneFixture)
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture cleanup outside owned worktree' }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    It 'clones pinned objects independently without cleaning the failed V2 source' {
        $before = @(Get-ChildItem $script:FixtureSource -File -Recurse -Force | Sort-Object FullName | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName).Hash })
        $directory = Join-Path $script:CloneFixture 'attempt'
        $result = New-Evidence1CanarySource $script:FixtureSource $directory $script:FixtureCommit
        (& git -C $result.path rev-parse HEAD).Trim() | Should -BeExactly $script:FixtureCommit
        @(& git -C $result.path status --porcelain).Count | Should -Be 0
        (& git -C $result.path remote get-url origin).Trim() | Should -BeExactly 'https://github.com/android/nowinandroid'
        Test-Path (Join-Path $result.path '.git/objects/info/alternates') | Should -BeFalse
        Test-Path (Join-Path $result.path '.kmp-test-runner/reports/coverage/20260831-120000-000001.md') | Should -BeFalse
        $after = @(Get-ChildItem $script:FixtureSource -File -Recurse -Force | Sort-Object FullName | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName).Hash })
        ($after -join "`n") | Should -BeExactly ($before -join "`n")
        { New-Evidence1CanarySource $script:FixtureSource $directory $script:FixtureCommit } | Should -Throw '*canary*'
    }
    It 'rejects overlapping paths and tracked source edits without repairing them' {
        { New-Evidence1CanarySource $script:FixtureSource (Join-Path $script:FixtureSource 'attempt') $script:FixtureCommit } | Should -Throw '*canary*'
        [IO.File]::AppendAllText((Join-Path $script:FixtureSource 'build.gradle.kts'), '// uncommitted')
        { New-Evidence1CanarySource $script:FixtureSource (Join-Path $script:CloneFixture 'dirty-attempt') $script:FixtureCommit } | Should -Throw '*canary*'
        (Get-Content (Join-Path $script:FixtureSource 'build.gradle.kts') -Raw) | Should -Match 'uncommitted'
    }
}

Describe 'Evidence1 Hyper-V live observability scripts' {
    It 'ships the reusable run contract and standalone wrapper' {
        $script:ContractPath | Should -Exist
        $script:WrapperPath | Should -Exist
    }

    It 'parses every shipped PowerShell artifact' {
        $paths = @(
            $script:ContractPath
            $script:WrapperPath
            $script:PlacePath
            $script:ProgressPath
            $script:LauncherPath
        )
        foreach ($path in $paths) {
            $tokens = $null
            $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile(
                $path,
                [ref]$tokens,
                [ref]$errors
            )
            $errors | Should -HaveCount 0 -Because $path
        }
    }

    It 'contains no maintainer-specific host checkout path' {
        $content = Get-Content -LiteralPath $script:PlacePath -Raw
        $content | Should -Not -Match 'Users\\[0-9]+\\AndroidStudioProjects'
        $content | Should -Match '\$PSScriptRoot'
    }

    It 'does not delete the Startup entry before invoking the live wrapper' {
        $content = Get-Content -LiteralPath $script:PlacePath -Raw
        $deleteIndex = $content.IndexOf('del "%SELF%"', [StringComparison]::Ordinal)
        $invokeIndex = $content.IndexOf('-File "$wrapperGuestPath"', [StringComparison]::Ordinal)
        $deleteIndex | Should -BeGreaterOrEqual 0
        $invokeIndex | Should -BeGreaterOrEqual 0
        $deleteIndex | Should -BeGreaterThan $invokeIndex
        $content | Should -Match 'set "WRAPPER_EXIT=%ERRORLEVEL%"'
        $content | Should -Match 'exit /b %WRAPPER_EXIT%'
    }

    It 'does not collect process command lines or inspect operational logs' {
        $content = Get-Content -LiteralPath $script:ProgressPath -Raw
        $content | Should -Not -Match '\bCommandLine\b'
        $content | Should -Not -Match 'Get-Content.+(?:stdout|stderr|STAGE-B-live\.log)'
    }

    It 'launches the native Node process from the harness directory' {
        $content = Get-Content -LiteralPath $script:LauncherPath -Raw
        $content | Should -Match '\$psi\.WorkingDirectory = \$HarnessDir'
    }

    It 'accepts the current readiness ledger harness anchor shape' {
        . $script:LauncherPath -LoadOnly
        function Fail($Message) { throw "HARD STOP: $Message" }

        $HarnessCommit = '657f426f3091ffa1045f0ddd76ab5ce3b2a5d5a3'
        $HarnessTree = 'c65a1dc0ad0af9558d17f8df0c133a2a1fca7a2f'
        $ReadinessLedgerPath = Join-Path $TestDrive 'READINESS.json'
        $sha = 'a' * 64
        $ledger = [ordered]@{
            verdict = 'PASS'
            harness = [ordered]@{
                expected_commit = $HarnessCommit
                actual_commit = $HarnessCommit
                expected_tree = $HarnessTree
                actual_tree = $HarnessTree
            }
            attestation = [ordered]@{
                canonical_json_sha256 = $sha
            }
            dry_run_campaign_pass = [ordered]@{
                campaign_design_id = 'claude-product-vs-free-baseline-v1'
                planned_sessions = 8
                plan_length = 8
                strict_cell_count = 0
                unrestricted_cell_count = 8
                output_sha256_lf_normalized = $sha
                strict_cells_with_attestation_hash = 0
                unique_isolation_attestation_hash_count = 1
                bound_isolation_attestation_sha256 = $sha
                attestation_path_leaked_in_output = $false
                attestation_content_leaked_in_output = $false
                attestation_timestamps_leaked_in_output = $false
                label_order_matches_expected = $true
                profile_order_matches_expected = $true
                condition_order_matches_expected = $true
                max_budget_usd = '2.00'
            }
        }
        $ledger | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReadinessLedgerPath -Encoding UTF8

        $actual = Read-ReadinessLedger

        $actual.__live_harness_commit | Should -Be $HarnessCommit
        $actual.__live_harness_tree | Should -Be $HarnessTree
        $actual.__live_campaign_dry_run.__live_output_sha256 | Should -Be $sha
    }
}

Describe 'Evidence1 live run contract' {
    BeforeAll {
        Import-Module $script:ContractPath -Force
    }

    It 'writes and validates a run-scoped terminal record atomically' {
        $path = Join-Path $TestDrive 'terminal.json'
        $runId = [guid]::NewGuid().ToString('D')
        $record = [ordered]@{
            schema = 1
            run_id = $runId
            state = 'exited'
            ts_utc = '2026-08-23T00:00:00.000Z'
            exit_code = 7
            exit_code_source = 'launcher_record'
        }

        Write-Evidence1JsonAtomically -Path $path -Value $record
        $actual = Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId

        $actual.valid | Should -BeTrue
        $actual.exit_code | Should -Be 7
        Get-ChildItem -LiteralPath $TestDrive -Filter '*.tmp' | Should -HaveCount 0

        $record.exit_code = 8
        Write-Evidence1JsonAtomically -Path $path -Value $record
        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).exit_code | Should -Be 8
    }

    It 'rejects stale and malformed terminal records' {
        $path = Join-Path $TestDrive 'stale.json'
        $runId = [guid]::NewGuid().ToString('D')
        Write-Evidence1JsonAtomically -Path $path -Value ([ordered]@{
            schema = 1
            run_id = [guid]::NewGuid().ToString('D')
            state = 'exited'
            ts_utc = '2026-08-23T00:00:00.000Z'
            exit_code = 0
            exit_code_source = 'launcher_record'
        })

        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).reason | Should -Be 'run_id_mismatch'
        Set-Content -LiteralPath $path -Value '{not-json' -Encoding UTF8
        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).reason | Should -Be 'invalid_json'

        Set-Content -LiteralPath $path -Value '{"schema":1}' -Encoding UTF8
        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).reason | Should -Be 'invalid_shape'
    }

    It 'rejects stale progress and accepts only the expected run identity' {
        $runId = [guid]::NewGuid().ToString('D')
        $progress = [pscustomobject]@{
            schema = 1
            run_id = $runId
            state = 'running'
            elapsed_seconds = 12
            exit_code = 997
            exit_code_source = 'wrapper_error'
            journal = [pscustomobject]@{ event_count = 3 }
        }

        (Test-Evidence1ProgressRecord -Record $progress -Source 'test' -ExpectedRunId $runId).valid | Should -BeTrue
        $progress.run_id = [guid]::NewGuid().ToString('D')
        (Test-Evidence1ProgressRecord -Record $progress -Source 'test' -ExpectedRunId $runId).reason | Should -Be 'run_id_mismatch'
    }

    It 'terminates a process tree within a bounded wait' {
        $child = Start-Process -FilePath powershell.exe -ArgumentList @(
            '-NoProfile',
            '-Command',
            'Start-Sleep -Seconds 300'
        ) -WindowStyle Hidden -PassThru
        try {
            $result = Stop-Evidence1ProcessTree -ProcessId $child.Id -TimeoutMilliseconds 5000
            $result.stopped | Should -BeTrue
            Get-Process -Id $child.Id -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
        } finally {
            Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Evidence1 live wrapper process lifecycle' {
    BeforeEach {
        $script:OpsDir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $script:OpsDir | Out-Null
    }

    It 'trusts a matching terminal record and terminates a lingering launcher tree' {
        $runId = [guid]::NewGuid().ToString('D')
        $launcher = Join-Path $script:OpsDir 'fake-launcher.ps1'
        Set-Content -LiteralPath $launcher -Encoding UTF8 -Value @'
param([string]$RunId, [string]$TerminalRecordPath)
$record = [ordered]@{
    schema = 1
    run_id = $RunId
    state = 'exited'
    ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    exit_code = 7
    exit_code_source = 'launcher_record'
}
[System.IO.File]::WriteAllText($TerminalRecordPath, ($record | ConvertTo-Json -Compress))
Start-Sleep -Seconds 300
'@

        $watch = [Diagnostics.Stopwatch]::StartNew()
        $process = Start-Process -FilePath powershell.exe -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $script:WrapperPath,
            '-RunId', $runId,
            '-LauncherPath', $launcher,
            '-OpsDir', $script:OpsDir,
            '-HarnessDir', $script:OpsDir,
            '-HeartbeatSeconds', '1',
            '-StopTimeoutMilliseconds', '5000'
        ) -WindowStyle Hidden -PassThru -Wait
        $watch.Stop()

        $process.ExitCode | Should -Be 7
        # Hosted Windows process-tree teardown can cross 15s under load; this still proves the
        # wrapper terminates promptly instead of waiting for the fake launcher's 300s sleep.
        $watch.Elapsed.TotalSeconds | Should -BeLessThan 45
        $terminal = Get-Content -LiteralPath (Join-Path $script:OpsDir 'STAGE-B-live.exit.json') -Raw | ConvertFrom-Json
        $terminal.run_id | Should -Be $runId
        $terminal.state | Should -Be 'terminated_after_launcher_exit'
        $terminal.exit_code_source | Should -Be 'launcher_record'
    }

    It 'ignores a stale terminal record and falls back to the launcher process exit code' {
        $runId = [guid]::NewGuid().ToString('D')
        $launcher = Join-Path $script:OpsDir 'fake-stale-launcher.ps1'
        Set-Content -LiteralPath $launcher -Encoding UTF8 -Value @'
param([string]$RunId, [string]$TerminalRecordPath)
$record = [ordered]@{
    schema = 1
    run_id = [guid]::NewGuid().ToString('D')
    state = 'exited'
    ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    exit_code = 0
    exit_code_source = 'launcher_record'
}
[System.IO.File]::WriteAllText($TerminalRecordPath, ($record | ConvertTo-Json -Compress))
exit 9
'@

        $process = Start-Process -FilePath powershell.exe -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $script:WrapperPath,
            '-RunId', $runId,
            '-LauncherPath', $launcher,
            '-OpsDir', $script:OpsDir,
            '-HarnessDir', $script:OpsDir,
            '-HeartbeatSeconds', '1',
            '-StopTimeoutMilliseconds', '5000'
        ) -WindowStyle Hidden -PassThru -Wait

        $terminal = Get-Content -LiteralPath (Join-Path $script:OpsDir 'STAGE-B-live.exit.json') -Raw | ConvertFrom-Json
        $process.ExitCode | Should -Be 9 -Because "wrapper_error_type=$($terminal.wrapper_error_type), stage=$($terminal.wrapper_error_stage)"
        $terminal.run_id | Should -Be $runId
        $terminal.state | Should -Be 'exited'
        $terminal.exit_code_source | Should -Be 'process_exit_code'
    }
}
