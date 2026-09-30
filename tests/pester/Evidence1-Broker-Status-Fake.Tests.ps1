BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for why.
    $script:RepoDocsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    $script:ContractPath = Join-Path $script:RepoDocsRoot 'evidence1-broker-status-contract.psm1'
    $script:FakePath = Join-Path $script:RepoDocsRoot 'evidence1-broker-status-fake.psm1'
    $script:RealPath = Join-Path $script:RepoDocsRoot 'evidence1-broker-status-real.psm1'
    Import-Module $script:ContractPath -Force
    Import-Module $script:FakePath -Force
}

Describe 'Evidence1 broker-status fake: structural safety (never touches the real broker)' {
    # Maintainer's explicit requirement: this must be a STRUCTURAL guarantee,
    # not a conventional one. Two independent layers below: (1) Should -Invoke
    # -Times 0 -Exactly proves that even if these commands existed and were
    # callable, the fake's actual code path never reaches them; (2) a
    # source-text scan proves the tokens do not appear in the file's
    # executable code at all (comments excluded, since this file's own header
    # documents the forbidden list by name). ADR-S4 itself calls a
    # source-string check alone "allowed as a lint guard but SHALL NOT count
    # as integration proof" -- so layer (1) is the real proof; layer (2) is
    # the supplementary lint guard on top of it, not a replacement.

    BeforeEach {
        InModuleScope evidence1-broker-status-fake {
            Mock Get-ScheduledTask { }
            Mock Get-Acl { }
            Mock Get-Content { }
            Mock Test-Path { }
            Mock Start-Process { }
            Mock New-PSSession { }
            Mock Get-VM { }
            Mock Get-VMNetworkAdapter { }
            Mock Connect-VMNetworkAdapter { }
            Mock Disconnect-VMNetworkAdapter { }
            Mock Mount-VHD { }
            Mock Import-Clixml { }
        }
    }

    It 'never invokes any host-broker, Hyper-V, or elevation command for the default (unseeded) call' {
        InModuleScope evidence1-broker-status-fake {
            $result = Get-E1BrokerStatus
            $result.self_update_capable | Should -BeTrue

            Should -Invoke Get-ScheduledTask -Times 0 -Exactly
            Should -Invoke Get-Acl -Times 0 -Exactly
            Should -Invoke Get-Content -Times 0 -Exactly
            Should -Invoke Test-Path -Times 0 -Exactly
            Should -Invoke Start-Process -Times 0 -Exactly
            Should -Invoke New-PSSession -Times 0 -Exactly
            Should -Invoke Get-VM -Times 0 -Exactly
            Should -Invoke Get-VMNetworkAdapter -Times 0 -Exactly
            Should -Invoke Connect-VMNetworkAdapter -Times 0 -Exactly
            Should -Invoke Disconnect-VMNetworkAdapter -Times 0 -Exactly
            Should -Invoke Mount-VHD -Times 0 -Exactly
            Should -Invoke Import-Clixml -Times 0 -Exactly
        }
    }

    It 'never invokes any of those commands after Set-E1FakeBrokerStatusResult / Reset-E1FakeBrokerStatusState either' {
        InModuleScope evidence1-broker-status-fake {
            $degraded = New-E1BrokerStatusResult -TaskExists $true -Readable $true -DeploymentRoot 'C:\kmp-eval\scratch\fake-broker-deployment' `
              -ManifestSchema 1 -SourceGitCommit ('1' * 40) -PrincipalSid 'S-1-5-21-1-1-1-1001' -ScriptCount 3 `
              -HashesValid $true -AclValid $true -SelfUpdateCapable $false
            Set-E1FakeBrokerStatusResult $degraded
            (Get-E1BrokerStatus).self_update_capable | Should -BeFalse
            Reset-E1FakeBrokerStatusState
            (Get-E1BrokerStatus).self_update_capable | Should -BeTrue

            Should -Invoke Get-ScheduledTask -Times 0 -Exactly
            Should -Invoke Get-Acl -Times 0 -Exactly
            Should -Invoke Start-Process -Times 0 -Exactly
        }
    }

    It 'contains none of the forbidden tokens anywhere in its executable code (comments excluded)' {
        $sourceLines = Get-Content -LiteralPath $script:FakePath
        $codeOnly = ($sourceLines | ForEach-Object {
            $trimmed = $_.Trim()
            if ($trimmed.StartsWith('#')) { '' } else { ($_ -replace '#.*$', '') }
        }) -join "`n"

        # Cmdlet/path tokens: safe to check as plain substrings even in code,
        # since none of them could appear as an innocent code fragment.
        foreach ($forbidden in @(
            'Get-ScheduledTask', 'ScheduledTasks', 'C:\ProgramData', 'C:\kmp-eval\scratch\host-elevated-runner-codex',
            'Get-VM', 'New-PSSession', 'Invoke-Command', 'Connect-VMNetworkAdapter', 'Disconnect-VMNetworkAdapter',
            'Mount-VHD', 'Dismount-VHD', 'Start-Process', 'RunAs', 'Get-Acl', 'Get-Content', 'Test-Path', '[IO.File]'
        )) {
            $codeOnly | Should -Not -Match ([regex]::Escape($forbidden)) -Because "the fake must never reference $forbidden"
        }

        # Provider executable invocation specifically (not the bare words
        # "codex"/"claude", which this file's own header legitimately names
        # in its forbidden-token list comment -- that comment is stripped
        # above; a real invocation would look like one of these instead).
        foreach ($forbidden in @('codex.cmd', 'codex.exe', 'claude.cmd', 'claude.exe', 'codex-cli', 'claude-code')) {
            $codeOnly | Should -Not -Match ([regex]::Escape($forbidden)) -Because "the fake must never reference a real provider executable ($forbidden)"
        }
    }
}

Describe 'Evidence1 broker-status fake: deterministic shape' {
    BeforeEach { InModuleScope evidence1-broker-status-fake { Reset-E1FakeBrokerStatusState } }

    It 'returns a fully-valid, self-update-capable PASS shape by default, every time' {
        $first = Get-E1BrokerStatus
        $second = Get-E1BrokerStatus
        { Assert-E1BrokerStatusResult $first } | Should -Not -Throw
        $first.task_exists | Should -BeTrue
        $first.readable | Should -BeTrue
        $first.hashes_valid | Should -BeTrue
        $first.acl_valid | Should -BeTrue
        $first.self_update_capable | Should -BeTrue
        ($first | ConvertTo-Json -Compress) | Should -BeExactly ($second | ConvertTo-Json -Compress)
    }

    It 'rejects a malformed override through the same Assert-E1BrokerStatusResult every real result passes' {
        { Set-E1FakeBrokerStatusResult ([ordered]@{ task_exists = $true }) } | Should -Throw '*broker_status_result_shape_invalid*'
    }

    It 'lets a test simulate a degraded/rolled-back broker deterministically (needed for the broker-update failure drill)' {
        $rolledBack = New-E1BrokerStatusResult -TaskExists $true -Readable $true -DeploymentRoot 'C:\kmp-eval\scratch\fake-broker-deployment' `
          -ManifestSchema 1 -SourceGitCommit ('2' * 40) -PrincipalSid 'S-1-5-21-2-2-2-1001' -ScriptCount 5 `
          -HashesValid $true -AclValid $true -SelfUpdateCapable $false
        Set-E1FakeBrokerStatusResult $rolledBack
        (Get-E1BrokerStatus).self_update_capable | Should -BeFalse
        (Get-E1BrokerStatus).manifest_schema | Should -Be 1
    }
}

Describe 'Evidence1 broker-status real path: the self-update gate must not silently weaken' {
    # Regression pin, per the maintainer's explicit instruction: on THIS
    # host, at the time this round's work was done, the real broker.status
    # path reports broker_not_self_update_capable (confirmed independently by
    # both the maintainer and an earlier round of this task -- see
    # docs/audits/evidence1-phase1-architecture-note.md and
    # evidence1-stabilization-plan.md section 2's verified baseline: the
    # installed runner source predates the self-update-capable manifest
    # schema). This test imports evidence1-broker-status-real.psm1 (the
    # module -- never evidence1-install.ps1/evidence1-run.ps1 themselves) and
    # calls Get-E1BrokerStatus directly, which is read-only host inspection
    # (Get-ScheduledTask, Get-Acl, file hashing) -- explicitly in scope per
    # the boundary update, and exactly what evidence1-install.ps1 itself does
    # every time it runs. If this host's broker is ever actually upgraded to
    # a self-update-capable deployment (e.g. by running evidence1-install.ps1
    # for real), this specific assertion is EXPECTED to need updating -- that
    # is the gate not silently drifting, not a false alarm.
    #
    # 2026-09-29: this host's broker was upgraded to self-update-capable via
    # evidence1-install -UpdateBroker; pin updated per the test's own
    # instruction above.
    BeforeAll {
        Import-Module $script:RealPath -Force
    }

    It 'reports self_update_capable=$true on this host, updated 2026-09-29 after the broker-status upgrade' {
        $status = Get-E1BrokerStatus
        if (-not $status.task_exists) { Set-ItResult -Skipped -Because 'requires a pre-provisioned real Evidence1 broker scheduled task' }
        { Assert-E1BrokerStatusResult $status } | Should -Not -Throw
        $status.task_exists | Should -BeTrue
        $status.self_update_capable | Should -BeTrue
    }
}
