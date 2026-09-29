BeforeAll {
    $script:RepoDocsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    $script:ContractPath = Join-Path $script:RepoDocsRoot 'evidence1-provider-runtime-contract.psm1'
    $script:FakePath = Join-Path $script:RepoDocsRoot 'evidence1-provider-runtime-fake.psm1'
    Import-Module $script:ContractPath -Force
    Import-Module $script:FakePath -Force
}

Describe 'Evidence1 ProviderRuntime fake: structurally incapable of starting a real provider' {
    # The single most safety-sensitive test file this round. Same two-layer
    # proof as the broker-status fake: Should -Invoke -Times 0 -Exactly
    # (would catch it if the fake ever tried to spawn/connect for real) plus
    # a source-text scan (comments excluded) for every forbidden token the
    # maintainer named. ADR-S4 itself calls a source-string check alone "a
    # lint guard, not integration proof" -- so the mock-based layer is the
    # real proof, the text scan is the supplementary guard on top.

    BeforeEach {
        InModuleScope evidence1-provider-runtime-fake {
            Mock Start-Process { }
            Mock Start-Job { }
            Mock Invoke-Command { }
            Mock New-PSSession { }
            Mock Invoke-WebRequest { }
            Mock Invoke-RestMethod { }
            Mock Import-Clixml { }
            Mock ConvertTo-SecureString { }
            Mock Get-Command { }
        }
    }

    It 'never invokes a process-spawn, remoting, network, or credential command for a session dispatch' {
        InModuleScope evidence1-provider-runtime-fake {
            $result = Invoke-E1ProviderRuntimeSession -RuntimeId 'codex' -ModelId 'gpt-5.6-terra' -RoundIndex 0 `
              -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64)
            $result.verdict | Should -BeExactly 'PASS'

            Should -Invoke Start-Process -Times 0 -Exactly
            Should -Invoke Start-Job -Times 0 -Exactly
            Should -Invoke Invoke-Command -Times 0 -Exactly
            Should -Invoke New-PSSession -Times 0 -Exactly
            Should -Invoke Invoke-WebRequest -Times 0 -Exactly
            Should -Invoke Invoke-RestMethod -Times 0 -Exactly
            Should -Invoke Import-Clixml -Times 0 -Exactly
            Should -Invoke ConvertTo-SecureString -Times 0 -Exactly
            Should -Invoke Get-Command -Times 0 -Exactly
        }
    }

    It 'never invokes them across multiple sessions/runtimes either, including a seeded FAIL result' {
        InModuleScope evidence1-provider-runtime-fake {
            Set-E1FakeProviderRuntimeResult -RuntimeId 'claude' -RoundIndex 2 -Verdict 'FAIL' -ReasonCode 'simulated_functional_failure' -ExitCode 7
            $pass = Invoke-E1ProviderRuntimeSession -RuntimeId 'codex' -ModelId 'gpt-5.6-terra' -RoundIndex 0 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64)
            $fail = Invoke-E1ProviderRuntimeSession -RuntimeId 'claude' -ModelId 'claude-sonnet-5' -RoundIndex 2 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64)
            $pass.verdict | Should -BeExactly 'PASS'
            $fail.verdict | Should -BeExactly 'FAIL'
            $fail.exit_code | Should -Be 7

            Should -Invoke Start-Process -Times 0 -Exactly
            Should -Invoke New-PSSession -Times 0 -Exactly
            Should -Invoke Invoke-WebRequest -Times 0 -Exactly
        }
    }

    It 'contains none of the forbidden tokens anywhere in its executable code (comments excluded)' {
        $sourceLines = Get-Content -LiteralPath $script:FakePath
        $codeOnly = ($sourceLines | ForEach-Object {
            $trimmed = $_.Trim()
            if ($trimmed.StartsWith('#')) { '' } else { ($_ -replace '#.*$', '') }
        }) -join "`n"

        foreach ($forbidden in @(
            'codex.cmd', 'codex.exe', 'codex-cli', 'claude.cmd', 'claude.exe', 'claude-code',
            'Start-Process', 'Start-Job', 'Invoke-Command', 'New-PSSession',
            'Invoke-WebRequest', 'Invoke-RestMethod', 'System.Net', 'HttpClient',
            'OAuth', 'ApiKey', 'Bearer', 'Import-Clixml', 'ConvertTo-SecureString', '[pscredential]'
        )) {
            $codeOnly | Should -Not -Match ([regex]::Escape($forbidden)) -Because "the fake must never reference $forbidden"
        }
    }
}

Describe 'Evidence1 ProviderRuntime fake: deterministic sessions and recording' {
    BeforeEach { InModuleScope evidence1-provider-runtime-fake { Reset-E1FakeProviderRuntimeState } }

    It 'produces the identical session_id for identical inputs, and a different one for a different round' {
        $a1 = Invoke-E1ProviderRuntimeSession -RuntimeId 'codex' -ModelId 'gpt-5.6-terra' -RoundIndex 0 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64)
        $a2 = Invoke-E1ProviderRuntimeSession -RuntimeId 'codex' -ModelId 'gpt-5.6-terra' -RoundIndex 0 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64)
        $b = Invoke-E1ProviderRuntimeSession -RuntimeId 'codex' -ModelId 'gpt-5.6-terra' -RoundIndex 1 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64)
        $a1.session_id | Should -BeExactly $a2.session_id
        $a1.session_id | Should -Not -BeExactly $b.session_id
        { Assert-E1ProviderRuntimeSessionResult $a1 } | Should -Not -Throw
    }

    It 'records every invocation in call order for test assertions' {
        Invoke-E1ProviderRuntimeSession -RuntimeId 'codex' -ModelId 'gpt-5.6-terra' -RoundIndex 0 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64) | Out-Null
        Invoke-E1ProviderRuntimeSession -RuntimeId 'claude' -ModelId 'claude-sonnet-5' -RoundIndex 0 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64) | Out-Null
        $invocations = @(Get-E1FakeProviderRuntimeInvocations)
        $invocations.Count | Should -Be 2
        $invocations[0].runtime_id | Should -BeExactly 'codex'
        $invocations[1].runtime_id | Should -BeExactly 'claude'
    }

    It 'rejects a malformed session result through the shared assert' {
        { Assert-E1ProviderRuntimeSessionResult ([ordered]@{ schema = 1 }) } | Should -Throw '*provider_runtime_session_result_shape_invalid*'
    }

    It 'accepts transport metadata added by PowerShell remoting' {
        $result = Invoke-E1ProviderRuntimeSession -RuntimeId 'codex' -ModelId 'gpt-5.6-terra' -RoundIndex 0 -ScenarioSha256 ('a' * 64) -PromptSha256 ('b' * 64)
        $result = [pscustomobject]$result
        $result | Add-Member -NotePropertyName PSComputerName -NotePropertyValue 'Evidence1-Runner-E2E'
        $result | Add-Member -NotePropertyName RunspaceId -NotePropertyValue ([guid]::NewGuid())
        $result | Add-Member -NotePropertyName PSShowComputerName -NotePropertyValue $true

        { Assert-E1ProviderRuntimeSessionResult $result } | Should -Not -Throw
    }
}
