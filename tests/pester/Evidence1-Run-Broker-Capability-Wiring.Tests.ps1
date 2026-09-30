# Task 2 of this round's regression suite: proves, by reading actual source
# text (never by dot-sourcing or executing evidence1-run.ps1 -- both remain
# forbidden), that the orchestrator/backend separation this round
# implemented actually holds. These are "grep-based source assertions" in
# this codebase's own established vocabulary (ADR-S4's own distinction
# between an integration test and a lint guard) -- genuinely useful as a
# regression fence, but not a substitute for the real module-level Pester
# coverage in the other files this round added
# (Evidence1-Broker-Capability-*.Tests.ps1,
# Evidence1-{Vm-State,Network-Backend,Guest-Bundle,Artifact-Copy}-Queue-Client.Tests.ps1).
BeforeAll {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $script:AuditsRoot = Join-Path $script:RepoRoot 'docs\audits'
    $script:RunSource = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'evidence1-run.ps1') -Raw
    $script:RunnerSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-host-elevated-runner.ps1') -Raw

    # Strips '#'-to-end-of-line comments so a comment merely MENTIONING a
    # forbidden token (this file's own header does, deliberately, to explain
    # the property) can never be confused with the token actually being
    # present as live code. Deliberately simple (no string-literal-aware
    # tokenizing) -- good enough for the ASCII, no-'#'-inside-quoted-hash
    # source this repo's PowerShell files consistently use, and easy to spot-
    # check by eye if it ever produced a surprising result.
    function Remove-E1PowerShellLineComments([string]$Source) {
        $lines = $Source -split "`r?`n"
        $stripped = foreach ($line in $lines) {
            $hashIndex = $line.IndexOf('#')
            if ($hashIndex -ge 0) { $line.Substring(0, $hashIndex) } else { $line }
        }
        return ($stripped -join "`n")
    }

    $script:RunSourceCodeOnly = Remove-E1PowerShellLineComments $script:RunSource

    # Read-E1InstallLiteralStringArray-class AST extraction (same technique
    # evidence1-host-elevated-runner-install.ps1 itself already uses to read
    # $AllowedScripts/$TrustedSupportFiles/$TrustedNodeFiles without ever
    # executing the runner) -- reused here purely for read-only test
    # assertions, never to derive a live allowlist.
    function Get-E1LiteralArrayAssignment([string]$Source, [string]$VariableName) {
        $tokens = $null
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -ne 0) { throw 'source_does_not_parse' }
        $assignments = @($ast.FindAll({
            param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
            $node.Left.VariablePath.UserPath -ceq $VariableName
        }, $true))
        if ($assignments.Count -ne 1) { throw "assignment_missing_or_ambiguous: $VariableName" }
        $right = $assignments[0].Right
        $elements = @($right.Expression.SubExpression.Statements[0].PipelineElements[0].Expression.Elements)
        return @($elements | ForEach-Object { [string]$_.Value })
    }
}

Describe 'evidence1-run.ps1 never imports a *-hyperv.psm1 module, in any mode' {
    It 'contains zero Import-Module calls naming a *-hyperv.psm1 file' {
        $matches = [regex]::Matches($script:RunSourceCodeOnly, "Import-Module[^\n]*'([^']*-hyperv\.psm1)'")
        $matches.Count | Should -Be 0
    }
    It 'imports the four queue-client siblings instead, under -UseRealBackends' {
        $script:RunSourceCodeOnly | Should -Match "evidence1-vm-state-queue-client\.psm1"
        $script:RunSourceCodeOnly | Should -Match "evidence1-network-backend-queue-client\.psm1"
        $script:RunSourceCodeOnly | Should -Match "evidence1-guest-bundle-queue-client\.psm1"
        $script:RunSourceCodeOnly | Should -Match "evidence1-artifact-copy-queue-client\.psm1"
    }
    It 'still imports evidence1-broker-status-real.psm1 directly (deliberately not rewired -- see that import''s own comment)' {
        $script:RunSourceCodeOnly | Should -Match "evidence1-broker-status-real\.psm1"
    }
}

Describe 'evidence1-run.ps1 never touches Hyper-V, ProgramData, a Scheduled Task, or a provider directly' {
    It 'contains no direct Hyper-V cmdlet call' {
        foreach ($cmdlet in @('Get-VM ', 'Get-VM(', 'Set-VM ', 'Start-VM ', 'Stop-VM ', 'Connect-VMNetworkAdapter', 'Disconnect-VMNetworkAdapter', 'New-VM ', 'Remove-VM ', 'Get-VMNetworkAdapter', 'Mount-VHD', 'Dismount-VHD')) {
            $script:RunSourceCodeOnly | Should -Not -Match ([regex]::Escape($cmdlet))
        }
    }
    It 'contains no PowerShell Direct session call (New-PSSession/Invoke-Command -VMId/-VMName)' {
        $script:RunSourceCodeOnly | Should -Not -Match 'New-PSSession'
        $script:RunSourceCodeOnly | Should -Not -Match 'Invoke-Command\s'
    }
    It 'never reads C:\ProgramData\KmpEval directly' {
        $script:RunSourceCodeOnly | Should -Not -Match 'ProgramData\\KmpEval'
    }
    It 'never calls Start-Process -Verb RunAs (the one sanctioned bootstrap elevation lives only in evidence1-install.ps1, a different file)' {
        $script:RunSourceCodeOnly | Should -Not -Match 'Start-Process'
        $script:RunSourceCodeOnly | Should -Not -Match '-Verb\s+RunAs'
    }
    It 'never modifies a Scheduled Task (Register-/Unregister-/Set-ScheduledTask, or schtasks.exe)' {
        foreach ($token in @('Register-ScheduledTask', 'Unregister-ScheduledTask', 'Set-ScheduledTask', 'schtasks')) {
            $script:RunSourceCodeOnly | Should -Not -Match ([regex]::Escape($token))
        }
    }
    It 'never invokes a provider CLI (claude/codex) locally' {
        # evidence1-run.ps1 legitimately CONTAINS the strings claude.cmd/codex.cmd
        # as DATA -- $script:E1RunCanonicalRuntimeProbes's guest-side command
        # paths, handed to guest.invoke_bundle as an argument, never resolved
        # or executed against this host's own filesystem. Proving "never
        # invoked locally" means proving there is no call operator, process
        # launch, or expression-evaluation construct anywhere in the file --
        # not that the string is absent (a stricter, wrong property this
        # test previously asserted and had to be corrected: a hardcoded
        # guest-side path table is not the same thing as a local invocation
        # surface).
        $script:RunSourceCodeOnly | Should -Not -Match 'Invoke-Expression'
        $script:RunSourceCodeOnly | Should -Not -Match '&\s*\$\w*[Cc]ommand'
        $script:RunSourceCodeOnly | Should -Not -Match 'Start-Process'
    }
}

Describe 'evidence1-host-elevated-runner.ps1: the capability dispatcher is allowlisted exactly once' {
    It '$AllowedScripts contains evidence1-host-broker-capability-dispatch.ps1 exactly once' {
        $allowedScripts = Get-E1LiteralArrayAssignment $script:RunnerSource 'AllowedScripts'
        @($allowedScripts | Where-Object { $_ -ceq 'evidence1-host-broker-capability-dispatch.ps1' }).Count | Should -Be 1
    }
    It '$AllowedScripts does not separately allowlist any capability module by name (no "one script per operation" regression)' {
        $allowedScripts = Get-E1LiteralArrayAssignment $script:RunnerSource 'AllowedScripts'
        foreach ($moduleName in @(
            'evidence1-vm-state-hyperv.psm1', 'evidence1-network-backend-hyperv.psm1',
            'evidence1-guest-bundle-hyperv.psm1', 'evidence1-artifact-copy-hyperv.psm1', 'evidence1-broker-status-real.psm1'
        )) {
            $allowedScripts | Should -Not -Contain $moduleName
        }
    }
    It '$TrustedSupportFiles registers the full closure of modules the dispatcher imports' {
        $supportFiles = Get-E1LiteralArrayAssignment $script:RunnerSource 'TrustedSupportFiles'
        foreach ($expected in @(
            'evidence1-broker-capability-contract.psm1', 'evidence1-broker-capability-dispatch-core.psm1',
            'evidence1-broker-status-contract.psm1', 'evidence1-broker-status-real.psm1',
            'evidence1-vm-state-contract.psm1', 'evidence1-vm-state-hyperv.psm1',
            'evidence1-network-backend-contract.psm1', 'evidence1-network-backend-hyperv.psm1',
            'evidence1-guest-bundle-contract.psm1', 'evidence1-guest-bundle-hyperv.psm1',
            'evidence1-artifact-copy-contract.psm1', 'evidence1-artifact-copy-hyperv.psm1',
            'evidence1-trusted-root-config.psm1'
        )) {
            $supportFiles | Should -Contain $expected
        }
    }
}

Describe 'Global sweep: *-hyperv.psm1 is importable only from evidence1-host-broker-capability-dispatch.ps1' {
    It 'no other .ps1/.psm1 file under docs/audits or the repo root imports a *-hyperv.psm1 module' {
        $dispatcherPath = Join-Path $script:AuditsRoot 'evidence1-host-broker-capability-dispatch.ps1'
        $candidates = @(Get-ChildItem -LiteralPath $script:AuditsRoot -Filter '*.ps1' -File) +
                      @(Get-ChildItem -LiteralPath $script:AuditsRoot -Filter '*.psm1' -File) +
                      @(Get-ChildItem -LiteralPath $script:RepoRoot -Filter '*.ps1' -File)
        $offenders = @()
        foreach ($file in $candidates) {
            if ($file.FullName -ceq $dispatcherPath) { continue }
            if ($file.Name -cmatch '-hyperv\.psm1$') { continue }
            $text = Remove-E1PowerShellLineComments (Get-Content -LiteralPath $file.FullName -Raw)
            if ($text -match "Import-Module[^\n]*'[^']*-hyperv\.psm1'") { $offenders += $file.Name }
        }
        $offenders | Should -Be @()
    }
}
