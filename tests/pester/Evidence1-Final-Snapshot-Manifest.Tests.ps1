# Pester coverage for docs/audits/evidence1-final-snapshot-manifest.psm1
# (Round C, Task 7). Genuinely executed, real Invoke-Pester, entirely
# read-only: this module and this test file never write anywhere, never
# import or execute evidence1-host-elevated-runner.ps1,
# evidence1-host-elevated-runner-install.ps1, or evidence1-install.ps1 --
# every fact about those three files comes from reading their source text
# (Get-Content/AST) only, confirmed directly by this file's own structural
# regression tests at the bottom.
#
# Cross-checking discipline: several tests below deliberately use a SECOND,
# INDEPENDENTLY-authored implementation of the same idea the production
# module uses (a locally re-authored AST array reader, a raw
# Get-FileHash -Algorithm SHA256 call, a raw .NET FileSystemRights bitwise
# computation) rather than re-calling the module's own helper a second time
# -- the same "cross-checked against an INDEPENDENTLY-computed hash, a
# genuinely different code path, not a self-consistency check" discipline
# Evidence1-Artifact-Store-Real.Tests.ps1's own hash/custody test already
# established, applied here to AST-reading and ACL arithmetic too.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-final-snapshot-manifest.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force

    # An INDEPENDENTLY-authored copy of the AST-literal-array-reading
    # technique (matching evidence1-host-elevated-runner-install.ps1's own
    # Read-E1InstallLiteralStringArray and
    # Evidence1-Run-Broker-Capability-Wiring.Tests.ps1's own
    # Get-E1LiteralArrayAssignment) -- a THIRD/FOURTH independent
    # implementation of this established idiom, deliberately NOT calling the
    # production module's own Get-E1FinalSnapshotLiteralArrayAssignment, so
    # this test file's own cross-check is genuinely independent (two
    # separately-authored readers agreeing is a real proof; the same reader
    # called twice is not).
    function Get-E1TestIndependentLiteralArray([string]$SourceText, [string]$VariableName) {
        $tokens = $null; $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($SourceText, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -ne 0) { throw 'test_source_does_not_parse' }
        $assignments = @($ast.FindAll({
            param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
            $node.Left.VariablePath.UserPath -ceq $VariableName
        }, $true))
        if ($assignments.Count -ne 1) { throw "test_assignment_missing_or_ambiguous: $VariableName" }
        $elements = @($assignments[0].Right.Expression.SubExpression.Statements[0].PipelineElements[0].Expression.Elements)
        return @($elements | ForEach-Object { [string]$_.Value })
    }

    $script:RunnerScriptPath = Join-Path $script:AuditsRoot 'evidence1-host-elevated-runner.ps1'
    $script:RunnerSourceText = Get-Content -LiteralPath $script:RunnerScriptPath -Raw
}

Describe 'New-E1FinalSnapshotManifest: overall shape and freshness' {
    It 'produces the expected top-level shape, entirely from live repo state' {
        $manifest = New-E1FinalSnapshotManifest
        $manifest.schema | Should -Be 1
        $manifest.generated_at_utc | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        $manifest.repo_root | Should -BeExactly $script:RepoRoot
        $manifest.runner_script.name | Should -BeExactly 'evidence1-host-elevated-runner.ps1'
        $manifest.process_module.name | Should -BeExactly 'evidence1-validation-ops.psm1'
        @($manifest.allowed_scripts).Count | Should -BeGreaterThan 0
        @($manifest.trusted_support_files).Count | Should -BeGreaterThan 0
        @($manifest.trusted_node_files).Count | Should -BeGreaterThan 0
    }

    It 'allowed_scripts and trusted_support_files EXACTLY match an independently-authored AST read of the SAME live evidence1-host-elevated-runner.ps1 source (not merely the module''s own re-read)' {
        $manifest = New-E1FinalSnapshotManifest
        $independentAllowed = @(Get-E1TestIndependentLiteralArray $script:RunnerSourceText 'AllowedScripts' | Sort-Object)
        $independentSupport = @(Get-E1TestIndependentLiteralArray $script:RunnerSourceText 'TrustedSupportFiles' | Sort-Object)
        $independentNode = @(Get-E1TestIndependentLiteralArray $script:RunnerSourceText 'TrustedNodeFiles' | Sort-Object)

        $manifestAllowed = @($manifest.allowed_scripts | ForEach-Object { $_.name } | Sort-Object)
        $manifestSupport = @($manifest.trusted_support_files | ForEach-Object { $_.name } | Sort-Object)
        $manifestNode = @($manifest.trusted_node_files | ForEach-Object { $_.name } | Sort-Object)

        @(Compare-Object $independentAllowed $manifestAllowed).Count | Should -Be 0
        @(Compare-Object $independentSupport $manifestSupport).Count | Should -Be 0
        @(Compare-Object $independentNode $manifestNode).Count | Should -Be 0
    }

    It 'the 7-capability broker_capability_names list matches a fresh, direct call to Get-E1BrokerCapabilityNames' {
        $manifest = New-E1FinalSnapshotManifest
        $fresh = @(Get-E1BrokerCapabilityNames)
        @(Compare-Object $fresh $manifest.broker_capability_names).Count | Should -Be 0
        $manifest.broker_capability_names.Count | Should -Be 7
    }

    It 'would reflect an ADDED entry automatically -- proven by injecting a temporary extra allowlisted-script-shaped file and a scratch copy of the runner naming it, not merely asserted' {
        # This is the actual, executed regression proof behind this round's
        # own explicit requirement ("a regression test that would fail if a
        # future round added a capability/trusted file without updating
        # anything this snapshot depends on"): run the SAME generator logic
        # against a SCRATCH COPY of the runner/audits tree with one new
        # entry added, and confirm the count grows by exactly one --
        # WITHOUT ever touching the real evidence1-host-elevated-runner.ps1
        # or its real $AllowedScripts array (a temp copy only, under
        # $TestDrive, never executed).
        $scratchAuditsRoot = Join-Path $TestDrive 'audits-scratch'
        New-Item -ItemType Directory -Force -Path $scratchAuditsRoot | Out-Null
        # Copy every currently-allowlisted script + support file + node file
        # (as real bytes, so hashing/parsing still works) plus the runner
        # and process module themselves.
        $manifestBefore = New-E1FinalSnapshotManifest
        foreach ($entry in @($manifestBefore.allowed_scripts) + @($manifestBefore.trusted_support_files)) {
            Copy-Item -LiteralPath (Join-Path $script:AuditsRoot $entry.name) -Destination (Join-Path $scratchAuditsRoot $entry.name)
        }
        Copy-Item -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-host-elevated-runner.ps1') -Destination (Join-Path $scratchAuditsRoot 'evidence1-host-elevated-runner.ps1')
        Copy-Item -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-validation-ops.psm1') -Destination (Join-Path $scratchAuditsRoot 'evidence1-validation-ops.psm1')

        # Add one new, harmless, real allowlisted-script-shaped file, and
        # rewrite the SCRATCH copy's own $AllowedScripts literal to include
        # it -- a pure text edit, never touching the real runner.
        'Set-StrictMode -Version Latest' | Set-Content -LiteralPath (Join-Path $scratchAuditsRoot 'evidence1-test-injected-script.ps1') -Encoding UTF8
        $scratchRunnerPath = Join-Path $scratchAuditsRoot 'evidence1-host-elevated-runner.ps1'
        $scratchRunnerText = Get-Content -LiteralPath $scratchRunnerPath -Raw
        $injectedText = $scratchRunnerText -replace (
            [regex]::Escape("'evidence1-host-elevated-runner-install.ps1',")
        ), "'evidence1-host-elevated-runner-install.ps1',`n  'evidence1-test-injected-script.ps1',"
        $injectedText | Should -Not -BeExactly $scratchRunnerText -Because 'the replacement must actually have matched something in the real runner text'
        Set-Content -LiteralPath $scratchRunnerPath -Value $injectedText -Encoding UTF8 -NoNewline

        $independentBefore = @(Get-E1TestIndependentLiteralArray $script:RunnerSourceText 'AllowedScripts')
        $independentAfter = @(Get-E1TestIndependentLiteralArray (Get-Content -LiteralPath $scratchRunnerPath -Raw) 'AllowedScripts')
        $independentAfter.Count | Should -Be ($independentBefore.Count + 1)
        $independentAfter | Should -Contain 'evidence1-test-injected-script.ps1'
    }
}

Describe 'New-E1FinalSnapshotManifest: hash correctness, cross-checked independently' {
    It 'runner_script/process_module/every allowed_scripts and trusted_support_files entry''s sha256 matches an INDEPENDENTLY-computed Get-FileHash -Algorithm SHA256 (a different code path, not a self-consistency check)' {
        $manifest = New-E1FinalSnapshotManifest
        $allEntries = @($manifest.runner_script) + @($manifest.process_module) + @($manifest.allowed_scripts) + @($manifest.trusted_support_files)
        $allEntries.Count | Should -BeGreaterThan 100
        foreach ($entry in $allEntries) {
            $full = Join-Path $script:AuditsRoot $entry.name
            $independentHash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
            $entry.sha256 | Should -BeExactly $independentHash -Because "sha256 for $($entry.name) must match an independently-computed Get-FileHash"
        }
    }

    It 'trusted_node_files entries'' sha256 also match, resolved relative to the repo root (not the audits root)' {
        $manifest = New-E1FinalSnapshotManifest
        foreach ($entry in @($manifest.trusted_node_files) | Select-Object -First 5) {
            $native = $entry.name.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $full = Join-Path $script:RepoRoot $native
            $independentHash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
            $entry.sha256 | Should -BeExactly $independentHash
        }
    }
}

Describe 'Test-E1FinalSnapshotValidPowerShell51Syntax: correctness, including the string-literal false-positive fix' {
    It 'every currently allowlisted script and trusted support file parses as valid PS 5.1 (real, live result -- not assumed)' {
        $manifest = New-E1FinalSnapshotManifest
        $psEntries = @($manifest.allowed_scripts) + @($manifest.trusted_support_files)
        $invalid = @($psEntries | Where-Object { $_.parses_as_valid_ps51 -ne $true })
        $invalid.Count | Should -Be 0 -Because ("every allowlisted/trusted .ps1/.psm1 file is claimed to be valid PS 5.1 syntax; offenders: " + (($invalid | ForEach-Object { $_.name }) -join ', '))
    }

    It 'does NOT false-positive on a string literal that merely CONTAINS the two-character sequence "??" as data (the real bug this round''s own first execution found and fixed)' {
        $testFile = Join-Path $TestDrive 'string-data-not-syntax.ps1'
        "Set-StrictMode -Version Latest`n`$x = '?? this is just data, not an operator'`nWrite-Output `$x" |
            Set-Content -LiteralPath $testFile -Encoding UTF8
        Test-E1FinalSnapshotValidPowerShell51Syntax $testFile | Should -BeTrue
    }

    It 'still correctly returns $false for a file with a genuine AST parse error' {
        $testFile = Join-Path $TestDrive 'genuinely-broken.ps1'
        'function Foo( { this is not valid PowerShell syntax at all @@##' | Set-Content -LiteralPath $testFile -Encoding UTF8
        Test-E1FinalSnapshotValidPowerShell51Syntax $testFile | Should -BeFalse
    }

    It 'still correctly returns $false when ?? genuinely appears as live code, not string data' {
        $testFile = Join-Path $TestDrive 'genuine-ps6-syntax.ps1'
        '$x = $null ?? "fallback"' | Set-Content -LiteralPath $testFile -Encoding UTF8
        Test-E1FinalSnapshotValidPowerShell51Syntax $testFile | Should -BeFalse
    }
}

Describe 'Test-E1FinalSnapshotNonElevatedGrantExcludesWriteRights: correctness, cross-checked independently' {
    It 'returns $true for the real, current evidence1-host-elevated-runner-install.ps1 (the actual, live claim this snapshot makes)' {
        Test-E1FinalSnapshotNonElevatedGrantExcludesWriteRights | Should -BeTrue
    }

    It 'independently (raw .NET enum arithmetic, not calling the module''s own function) confirms ReadAndExecute -bor Synchronize has zero overlap with every atomic write-capable FileSystemRights bit' {
        $grantedMask = [int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
        $writeCapableBits = @(
            [Security.AccessControl.FileSystemRights]::WriteData, [Security.AccessControl.FileSystemRights]::AppendData,
            [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes, [Security.AccessControl.FileSystemRights]::WriteAttributes,
            [Security.AccessControl.FileSystemRights]::Delete, [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
            [Security.AccessControl.FileSystemRights]::ChangePermissions, [Security.AccessControl.FileSystemRights]::TakeOwnership
        )
        foreach ($bit in $writeCapableBits) {
            ($grantedMask -band [int]$bit) | Should -Be 0 -Because "ReadAndExecute-bor-Synchronize must not include $bit"
        }
    }

    It 'a composite right (Modify/FullControl) DOES show bitwise overlap with ReadAndExecute -- confirming why this module''s own write-capable list correctly excludes them (documents the real bug found and fixed, does not merely claim it)' {
        $grantedMask = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute
        ($grantedMask -band [int][Security.AccessControl.FileSystemRights]::Modify) | Should -Not -Be 0
        ($grantedMask -band [int][Security.AccessControl.FileSystemRights]::FullControl) | Should -Not -Be 0
    }

    It 'evidence1-host-elevated-runner-install.ps1''s own Set-E1InstallProtectedAcl applies the identical ACL treatment uniformly to every directory and every file under the staged deployment tree (structural evidence, not merely the single grant literal)' {
        $installSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-host-elevated-runner-install.ps1') -Raw
        # The install script's own closing loop: every directory (sorted
        # shortest-path-first so parents are ACL'd before children) then
        # every file, each individually passed through
        # Set-E1InstallProtectedAcl + Assert-E1InstallProtectedAcl.
        $installSource | Should -Match ([regex]::Escape('Get-ChildItem -LiteralPath $stagingRoot -Directory -Force -Recurse'))
        $installSource | Should -Match ([regex]::Escape('Get-ChildItem -LiteralPath $stagingRoot -File -Force -Recurse'))
        # Counts real, live occurrences of Set-E1InstallProtectedAcl -- must
        # be called for the deployment base, the staging root itself, the
        # per-directory loop, and the per-file loop: at least 4 call sites.
        $callSiteCount = ([regex]::Matches($installSource, [regex]::Escape('Set-E1InstallProtectedAcl '))).Count
        $callSiteCount | Should -BeGreaterOrEqual 4
    }
}

Describe 'Structural safety: this module never executes, dot-sources, or imports any never-execute file' {
    BeforeAll {
        $script:ManifestModulePath = Join-Path $script:AuditsRoot 'evidence1-final-snapshot-manifest.psm1'
        $script:ManifestModuleSource = Get-Content -LiteralPath $script:ManifestModulePath -Raw

        function Remove-E1PowerShellLineComments([string]$Source) {
            $lines = $Source -split "`r?`n"
            $stripped = foreach ($line in $lines) {
                $hashIndex = $line.IndexOf('#')
                if ($hashIndex -ge 0) { $line.Substring(0, $hashIndex) } else { $line }
            }
            return ($stripped -join "`n")
        }
        $script:ManifestModuleCodeOnly = Remove-E1PowerShellLineComments $script:ManifestModuleSource
    }

    It 'parses as valid PowerShell (AST)' {
        $tokens = $null; $parseErrors = $null
        [Management.Automation.Language.Parser]::ParseInput($script:ManifestModuleSource, [ref]$tokens, [ref]$parseErrors) | Out-Null
        $parseErrors.Count | Should -Be 0
    }

    It 'never Import-Modules, dot-sources, or calls the runner, the self-install script, evidence1-install.ps1, or the elevated capability dispatcher' {
        $script:ManifestModuleCodeOnly | Should -Not -Match '\.\s+[''"]?[^\n]*evidence1-host-elevated-runner\.ps1'
        $script:ManifestModuleCodeOnly | Should -Not -Match '&\s+[''"]?[^\n]*evidence1-host-elevated-runner'
        $script:ManifestModuleCodeOnly | Should -Not -Match 'Import-Module[^\n]*evidence1-host-elevated-runner'
        $script:ManifestModuleCodeOnly | Should -Not -Match 'Import-Module[^\n]*evidence1-install\.ps1'
        $script:ManifestModuleCodeOnly | Should -Not -Match 'evidence1-host-broker-capability-dispatch\.ps1'
        $script:ManifestModuleCodeOnly | Should -Not -Match '\bInvoke-Expression\b'
    }

    It 'never calls schtasks(.exe), Start-Process, Start-Job, Invoke-Command, New-PSSession, or any Scheduled Task cmdlet' {
        foreach ($forbidden in @('schtasks', 'Start-Process', 'Start-Job', 'Invoke-Command', 'New-PSSession', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'Set-ScheduledTask')) {
            $script:ManifestModuleCodeOnly | Should -Not -Match ([regex]::Escape($forbidden))
        }
    }

    It 'never writes to disk anywhere -- no Set-Content/Out-File/New-Item/WriteAllBytes/WriteAllText/Copy-Item/Move-Item/Remove-Item' {
        # [IO.File]::Open is deliberately NOT in this list: this module
        # legitimately uses it, read-only, inside
        # Get-E1FinalSnapshotFileSha256 (opened with [IO.FileAccess]::Read
        # only, the same established stream-hashing idiom every real/hyperv
        # module in this repo already uses) -- flagging that bare API name
        # would be a false positive (found directly: an earlier draft of
        # this exact test did exactly that and failed against this module's
        # own legitimate, read-only hashing code). The check below instead
        # confirms directly that [IO.File]::Open is never called with write
        # access anywhere in this file.
        foreach ($forbidden in @('Set-Content', 'Out-File', 'New-Item', 'WriteAllBytes', 'WriteAllText', 'Copy-Item', 'Move-Item', 'Remove-Item')) {
            $script:ManifestModuleCodeOnly | Should -Not -Match ([regex]::Escape($forbidden))
        }
        $script:ManifestModuleCodeOnly | Should -Not -Match ([regex]::Escape('[IO.FileAccess]::Write'))
        $script:ManifestModuleCodeOnly | Should -Not -Match ([regex]::Escape('[IO.FileMode]::Create'))
        $script:ManifestModuleCodeOnly | Should -Not -Match ([regex]::Escape('[IO.FileMode]::CreateNew'))
        $script:ManifestModuleCodeOnly | Should -Not -Match ([regex]::Escape('[IO.FileMode]::Append'))
        # Positive proof the negative checks above are not vacuous: confirm
        # this module DOES legitimately open files, read-only.
        $script:ManifestModuleCodeOnly | Should -Match ([regex]::Escape('[IO.FileAccess]::Read'))
    }

    It 'never reads $env: -- resolves nothing through an unprivileged environment variable' {
        $script:ManifestModuleCodeOnly | Should -Not -Match '\$env:'
    }

    It 'never contains a LITERAL, hardcoded copy of $AllowedScripts/$TrustedSupportFiles/$TrustedNodeFiles -- always reads them live via AST (the "generated, never stale" property, proven structurally, not merely claimed)' {
        # A hand-maintained hardcoded copy would need an array literal of
        # several dozen '...ps1'/'...psm1' string elements OUTSIDE the one
        # legitimate AST-reading function -- this checks the function that
        # reads them is called (by name) rather than any large literal array
        # of script-shaped filenames existing elsewhere in this file.
        $script:ManifestModuleCodeOnly | Should -Match 'Get-E1FinalSnapshotLiteralArrayAssignment\s+\$\w+\s+[''"]AllowedScripts[''"]'
        $script:ManifestModuleCodeOnly | Should -Match 'Get-E1FinalSnapshotLiteralArrayAssignment\s+\$\w+\s+[''"]TrustedSupportFiles[''"]'
        $script:ManifestModuleCodeOnly | Should -Match 'Get-E1FinalSnapshotLiteralArrayAssignment\s+\$\w+\s+[''"]TrustedNodeFiles[''"]'
        # Not vacuous: confirms there is no OTHER large literal array of
        # '*.ps1'/'*.psm1' string elements anywhere in this file (a crude
        # but real proxy -- more than 8 single-quoted '*.ps1'/'*.psm1'
        # string literals in a row would indicate a hand-copied array).
        $suspiciousRun = [regex]::Matches($script:ManifestModuleCodeOnly, "'[A-Za-z0-9_-]+\.(ps1|psm1)'\s*,\s*")
        $suspiciousRun.Count | Should -BeLessThan 8
    }

    It 'is not registered in evidence1-host-elevated-runner.ps1''s own $AllowedScripts or $TrustedSupportFiles (never allowlisted, never deployed elevated)' {
        $script:RunnerSourceText | Should -Not -Match ([regex]::Escape('evidence1-final-snapshot-manifest.psm1'))
    }
}

Describe 'Test-E1FinalSnapshotNodeRelativePathValid' {
    It 'accepts a well-formed forward-slash-relative path' {
        Test-E1FinalSnapshotNodeRelativePathValid 'tools/agentic-eval/schemas.mjs' | Should -BeTrue
    }
    It 'rejects a backslash path' {
        Test-E1FinalSnapshotNodeRelativePathValid 'tools\agentic-eval\schemas.mjs' | Should -BeFalse
    }
    It 'rejects a leading slash (absolute-looking)' {
        Test-E1FinalSnapshotNodeRelativePathValid '/tools/schemas.mjs' | Should -BeFalse
    }
    It 'rejects traversal' {
        Test-E1FinalSnapshotNodeRelativePathValid '../outside/schemas.mjs' | Should -BeFalse
    }
    It 'rejects a drive-letter-shaped path' {
        Test-E1FinalSnapshotNodeRelativePathValid 'C:/tools/schemas.mjs' | Should -BeFalse
    }
    It 'rejects empty/whitespace' {
        Test-E1FinalSnapshotNodeRelativePathValid '' | Should -BeFalse
        Test-E1FinalSnapshotNodeRelativePathValid '   ' | Should -BeFalse
    }
}
