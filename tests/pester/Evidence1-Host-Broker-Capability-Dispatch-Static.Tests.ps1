# Static-only verification of evidence1-host-broker-capability-dispatch.ps1
# -- the one new elevated entrypoint. This script requires Administrator and
# can only genuinely run inside the elevated broker's own dispatched
# context; per this engagement's standing boundary, it is NEVER
# dot-sourced, executed, or invoked here. Every assertion below is a parse-
# validity check or a structural/grep-based source read -- the same honest
# limit every other never-executed *-hyperv.psm1-adjacent file in this repo
# is held to (see e.g. docs/audits/evidence1-phase3c-architecture-note.md's
# own repeated "DRAFTED, NEVER EXECUTED CODE" accounting). The genuinely
# EXECUTED proof for this round's dispatch LOGIC lives in
# Evidence1-Broker-Capability-Dispatch-Core.Tests.ps1, which exercises
# Invoke-E1BrokerCapabilityRoute (the function this script calls) for real,
# against real *-fake.psm1 siblings.
BeforeAll {
    $script:DispatchScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits\evidence1-host-broker-capability-dispatch.ps1')).Path
    $script:DispatchSource = Get-Content -LiteralPath $script:DispatchScriptPath -Raw

    function Remove-E1PowerShellLineComments([string]$Source) {
        $lines = $Source -split "`r?`n"
        $stripped = foreach ($line in $lines) {
            $hashIndex = $line.IndexOf('#')
            if ($hashIndex -ge 0) { $line.Substring(0, $hashIndex) } else { $line }
        }
        return ($stripped -join "`n")
    }
    $script:DispatchSourceCodeOnly = Remove-E1PowerShellLineComments $script:DispatchSource
}

Describe 'evidence1-host-broker-capability-dispatch.ps1: parse validity and shape' {
    It 'parses as valid PowerShell (AST, never executed/dot-sourced)' {
        $tokens = $null
        $parseErrors = $null
        [Management.Automation.Language.Parser]::ParseInput($script:DispatchSource, [ref]$tokens, [ref]$parseErrors) | Out-Null
        $parseErrors.Count | Should -Be 0
    }
    It 'declares #Requires -RunAsAdministrator' {
        ($script:DispatchSource -split "`r?`n")[0] | Should -BeExactly '#Requires -RunAsAdministrator'
    }
    It 'declares exactly one Mandatory parameter, -CapabilityRequestPath' {
        $tokens = $null
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($script:DispatchSource, [ref]$tokens, [ref]$parseErrors)
        $paramBlock = $ast.ParamBlock
        $paramBlock.Parameters.Count | Should -Be 1
        $paramBlock.Parameters[0].Name.VariablePath.UserPath | Should -BeExactly 'CapabilityRequestPath'
    }
    It 'contains no PS 6+-only syntax (??, ?., &&, ||)' {
        foreach ($token in @('??', '?.', '&&', '||')) {
            $script:DispatchSourceCodeOnly | Should -Not -Match ([regex]::Escape($token))
        }
    }
}

Describe 'evidence1-host-broker-capability-dispatch.ps1: no arbitrary script/command execution surface' {
    It 'contains no [scriptblock] parameter or Invoke-Expression' {
        $script:DispatchSourceCodeOnly | Should -Not -Match '\[scriptblock\]'
        $script:DispatchSourceCodeOnly | Should -Not -Match 'Invoke-Expression'
    }
    It 'never reads $env: (matches the same posture Get-E1ArtifactCopyRealTrustedRoot itself requires)' {
        $script:DispatchSourceCodeOnly | Should -Not -Match '\$env:'
    }
    It 'imports each capability module by a fixed, authored literal filename -- never a variable-built path' {
        $importLines = [regex]::Matches($script:DispatchSourceCodeOnly, "Import-Module[^\n]*")
        foreach ($match in $importLines) {
            $match.Value | Should -Match "Join-Path \`$PSScriptRoot '[a-z0-9-]+\.psm1'"
        }
    }
}

Describe 'evidence1-host-broker-capability-dispatch.ps1: TrustedRoot resolution (Task 3)' {
    It 'resolves TrustedRoot only via Get-E1ArtifactCopyRealTrustedRoot, exactly once, gated on the artifacts.copy_read_only capability' {
        $matches = [regex]::Matches($script:DispatchSourceCodeOnly, 'Get-E1ArtifactCopyRealTrustedRoot')
        $matches.Count | Should -Be 1
        $script:DispatchSourceCodeOnly | Should -Match "capability -ceq 'artifacts\.copy_read_only'"
    }
    It 'never reads a TrustedRoot-shaped value off the parsed request' {
        $script:DispatchSourceCodeOnly | Should -Not -Match '\$parsedRequest\.arguments\.TrustedRoot'
        $script:DispatchSourceCodeOnly | Should -Not -Match "'TrustedRoot'"
    }
}

Describe 'evidence1-host-broker-capability-dispatch.ps1: exactly one terminal response' {
    It 'calls the create-new response writer exactly once' {
        $matches = [regex]::Matches($script:DispatchSourceCodeOnly, 'Write-E1CapabilityCreateNewJson \$responsePath')
        $matches.Count | Should -Be 1
    }
    It 'every early-VALIDATION Fail (steps A-C) occurs strictly before the replay claim is attempted' {
        # The one expected exception is the replay-rejection Fail itself
        # ('broker_capability_replay_rejected'), which is textually AFTER the
        # claim-write attempt by construction -- it is the catch handler for
        # that exact attempt failing because a claim already exists. It does
        # not indicate "claimed, then something else failed"; it indicates
        # "the claim attempt itself failed", so it is correctly excluded from
        # this check rather than treated as a violation of "no work before
        # a successful claim".
        $claimIndex = $script:DispatchSourceCodeOnly.IndexOf('Write-E1CapabilityCreateNewJson $claimPath')
        $claimIndex | Should -BeGreaterThan 0
        $failCalls = [regex]::Matches($script:DispatchSourceCodeOnly, 'Fail ''([^'']*)''')
        $failCalls.Count | Should -BeGreaterThan 0
        $earlyValidationFails = @($failCalls | Where-Object { $_.Groups[1].Value -cne 'broker_capability_replay_rejected' })
        $earlyValidationFails.Count | Should -BeGreaterThan 0
        foreach ($call in $earlyValidationFails) {
            $call.Index | Should -BeLessThan $claimIndex
        }
        # And the replay-rejection Fail is the only one on the other side.
        $lateFails = @($failCalls | Where-Object { $_.Index -gt $claimIndex })
        $lateFails.Count | Should -Be 1
        $lateFails[0].Groups[1].Value | Should -BeExactly 'broker_capability_replay_rejected'
    }
}
