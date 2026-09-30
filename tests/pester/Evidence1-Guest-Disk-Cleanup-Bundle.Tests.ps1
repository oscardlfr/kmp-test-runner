# evidence1-guest-bundle-contract.psm1's 'run-agentic-eval-disk-cleanup' bundle: the safety
# property under test is that all three arguments are JSON-encoded arrays of single PATH SEGMENTS,
# validated against a fixed pattern -- never an absolute path, never able to traverse ('..') out
# of the one root each argument is confined to (C:\Evidence1Private, the guest user's %TEMP%,
# C:\E1G).
#
# 2026-09-29 (auditor review, after four straight per-shape transport patch rounds against
# PowerShell-array-typed arguments -- PSCustomObject-vs-Hashtable, empty array to $null, empty
# array to empty dictionary, one-element array to a bare scalar, each confirmed live and fixed in
# turn): "the abstraction is the defect." Redesigned so each list argument is a JSON-encoded
# STRING, parsed inside the bundle with @(ConvertFrom-Json $x) -- strings survive the broker's own
# JSON round trip byte-for-byte (this file's own pre-existing raw_envelope_json precedent), so the
# entire array-collapse bug class no longer applies. The transport-shape tests below replace the
# old per-shape acceptance tests this rewrite removes.
#
# 2026-09-29 (residual PS 5.1-only bug the "full transport simulation" Describe below exists to
# catch, root cause since isolated): parsing a JSON-string argument must be two statements --
# `$raw = ConvertFrom-Json $x` then `@($raw)` on its own line -- never `@(ConvertFrom-Json $x)`
# in one statement, which is a ONE-element array (not @()) for the empty-array case specifically
# in Windows PowerShell 5.1. See evidence1-guest-bundle-contract.psm1's matching note above the
# 'run-agentic-eval-disk-cleanup' bundle for the full isolation matrix.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1') -Force
    $script:BundleName = 'run-agentic-eval-disk-cleanup'
}

Describe 'run-agentic-eval-disk-cleanup: JSON-string argument validation (traversal/absolute-path rejection)' {
    It 'accepts real, already-observed shapes for all three argument kinds' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('live-product-free\1b15e760-03d6-4d7d-93d0-6e652a367b88', 'campaign\freq-01') | ConvertTo-Json -Compress)
            TempDirNamesJson             = (@('kmp-agentic-eval-gradle-abc123') | ConvertTo-Json -Compress)
            CompactSeedNamesJson         = (@('038b150b210b45b68c17bb39b3cfc737') | ConvertTo-Json -Compress)
        } } | Should -Not -Throw
    }

    It 'accepts the literal empty-array JSON "[]" for all three (the normal case for a private-roots-only pass)' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = '["eval-v2-gate\\99f67197-93bf-43a0-bd0f-160f2e6eb52e"]'
            TempDirNamesJson             = '[]'
            CompactSeedNamesJson         = '[]'
        } } | Should -Not -Throw
    }

    It 'rejects a non-string value outright (the whole point of the redesign -- a real array must never reach the validator)' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = @('eval-v2-gate\99f67197-93bf-43a0-bd0f-160f2e6eb52e')
            TempDirNamesJson             = '[]'
            CompactSeedNamesJson         = '[]'
        } } | Should -Throw
    }

    It 'rejects malformed JSON' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = 'not valid json'
            TempDirNamesJson             = '[]'
            CompactSeedNamesJson         = '[]'
        } } | Should -Throw
    }

    It 'rejects a PrivateRootRelativePaths entry that tries to traverse out of C:\Evidence1Private' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('live-product-free\..\..\Windows\System32') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'rejects a PrivateRootRelativePaths entry that is a bare absolute path' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('C:\Evidence1Toolchain') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'rejects a PrivateRootRelativePaths entry with only one path segment (no mode\campaign-id shape)' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('just-one-segment') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'rejects a TempDirNames entry without the kmp-agentic-eval- prefix' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = '[]'
            TempDirNamesJson = (@('some-other-directory') | ConvertTo-Json -Compress)
            CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'rejects a CompactSeedNames entry containing a path separator' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = '[]'; TempDirNamesJson = '[]'
            CompactSeedNamesJson = (@('abc123\..\..\Windows') | ConvertTo-Json -Compress)
        } } | Should -Throw
    }

    It 'declares exactly the result_keys its scriptblock returns' {
        $bundle = (Get-E1GuestBundleRegistry)[$script:BundleName]
        $expected = @(
            'private_roots_deleted', 'private_roots_failed', 'temp_dirs_deleted', 'temp_dirs_failed',
            'compact_seeds_deleted', 'compact_seeds_failed', 'c_drive_free_bytes_before', 'c_drive_free_bytes_after'
        )
        @(Compare-Object $bundle.result_keys $expected).Count | Should -Be 0
    }

    # 2026-09-29 (auditor review, before any dispatch): the first draft's regex allowed '.' inside
    # the second segment, so 'eval-v2-gate\..' validated -- Join-Path/GetFullPath would have
    # resolved it to C:\Evidence1Private itself, and rmSync -recurse would have deleted every
    # campaign root, live evidence included. These four cases are the auditor's own exact list.
    It 'rejects ".." as the second segment (the exploit that motivated this fix)' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('eval-v2-gate\..') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'rejects "." as the second segment' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('eval-v2-gate\.') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'rejects a dotfile-shaped second segment' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('eval-v2-gate\.hidden') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'rejects a sibling-escape second segment ("..\\sibling")' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('eval-v2-gate\..\sibling') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Throw
    }

    It 'accepts a normal two-segment leaf (control case -- the guard must not reject real input)' {
        { Assert-E1GuestBundleArguments $script:BundleName @{
            PrivateRootRelativePathsJson = (@('eval-v2-gate\99f67197-93bf-43a0-bd0f-160f2e6eb52e') | ConvertTo-Json -Compress)
            TempDirNamesJson = '[]'; CompactSeedNamesJson = '[]'
        } } | Should -Not -Throw
    }
}

# Second, independent layer: Assert-E1CleanupPathConfined itself, extracted from the real bundle
# source (not hand-retyped) and evaluated in isolation -- proves the runtime confinement check
# catches a traversal on its OWN merits, not merely because the regex above already blocked it.
Describe 'Assert-E1CleanupPathConfined (runtime confinement, independent of the regex layer)' {
    BeforeAll {
        $contractSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1') -Raw
        $start = $contractSource.IndexOf('function Assert-E1CleanupPathConfined')
        if ($start -lt 0) { throw 'Assert-E1CleanupPathConfined not found -- bundle changed shape' }
        $end = $contractSource.IndexOf('function Get-E1CleanupChildEnvironment', $start)
        if ($end -lt 0) { throw 'could not isolate the end of Assert-E1CleanupPathConfined' }
        $script:ConfinedSource = ($contractSource.Substring($start, $end - $start)) -replace '^function ', 'function script:'
        Invoke-Expression $script:ConfinedSource
    }

    It 'throws cleanup_target_equals_boundary when the candidate resolves to the boundary itself' {
        { Assert-E1CleanupPathConfined 'C:\Evidence1Private' 'eval-v2-gate' 'C:\Evidence1Private\eval-v2-gate' } |
            Should -Throw 'cleanup_target_equals_boundary*'
    }

    It 'throws cleanup_target_outside_boundary for the exact exploit shape (".." resolves ABOVE the boundary, to the shared root)' {
        # eval-v2-gate\.. resolves to C:\Evidence1Private itself -- outside, not equal to, the
        # eval-v2-gate boundary. Still fails closed; the reason code just reflects which check
        # actually caught it, since a bare '..' one level up lands one directory too far, not
        # exactly on the boundary.
        { Assert-E1CleanupPathConfined 'C:\Evidence1Private' 'eval-v2-gate' 'C:\Evidence1Private\eval-v2-gate\..' } |
            Should -Throw 'cleanup_target_outside_boundary*'
    }

    It 'throws cleanup_target_outside_boundary when the candidate escapes above the root entirely' {
        { Assert-E1CleanupPathConfined 'C:\Evidence1Private' 'eval-v2-gate' 'C:\Evidence1Private\eval-v2-gate\..\..\Windows' } |
            Should -Throw 'cleanup_target_outside_boundary*'
    }

    It 'throws cleanup_target_touches_protected_root for the canonical Gradle seed' {
        $seedDir = Join-Path $env:USERPROFILE '.gradle'
        { Assert-E1CleanupPathConfined $env:USERPROFILE $null $seedDir } |
            Should -Throw 'cleanup_target_touches_protected_root*'
    }

    It 'passes a genuine descendant of the boundary through unchanged' {
        $result = Assert-E1CleanupPathConfined 'C:\Evidence1Private' 'eval-v2-gate' 'C:\Evidence1Private\eval-v2-gate\99f67197-93bf-43a0-bd0f-160f2e6eb52e'
        $result | Should -BeExactly 'C:\Evidence1Private\eval-v2-gate\99f67197-93bf-43a0-bd0f-160f2e6eb52e'
    }
}

# 2026-09-29 (auditor directive: "test the real transport BEFORE redeploying" -- no more blind
# redeploy cycles). Simulates the broker's own real path end to end, in Windows PowerShell 5.1
# specifically (the broker's own engine): ConvertTo-Json -> temp file -> ConvertFrom-Json ->
# Assert-E1GuestBundleArguments -> the scriptblock's own JSON parse, against a real temp
# directory tree, covering 0, 1 and 125 entries. This is what should have existed before the
# first live dispatch attempt.
Describe 'run-agentic-eval-disk-cleanup: full transport simulation in Windows PowerShell 5.1' {
    BeforeAll {
        $script:FixtureRoot = Join-Path 'C:\kmp-eval\scratch\pester-cleanup-transport-tests' ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $script:FixtureRoot | Out-Null

    function script:Invoke-TransportSimulation([string[]]$Paths) {
        # -InputObject, never piped: piping an empty array skips ConvertTo-Json's own process
        # block entirely (confirmed directly -- @() | ConvertTo-Json produces an empty STRING,
        # not "[]"), and piping a one-element array unwraps it to a bare scalar before
        # ConvertTo-Json ever sees a collection. -InputObject has neither problem, confirmed
        # directly for 0, 1, and 2 elements -- this is likely the root cause of the original
        # one-element-collapses-to-a-bare-string bug this whole redesign responds to.
        if ($null -eq $Paths) { $Paths = @() }
        $argsHashtable = @{
            PrivateRootRelativePathsJson = (ConvertTo-Json -InputObject $Paths -Compress)
            TempDirNamesJson             = '[]'
            CompactSeedNamesJson         = '[]'
        }
        $requestPath = Join-Path $script:FixtureRoot "$([guid]::NewGuid().ToString('N')).json"
        $argsHashtable | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $requestPath -Encoding UTF8
        $ps1 = @"
Import-Module '$($script:AuditsRoot -replace "'", "''")\evidence1-guest-bundle-contract.psm1' -Force
`$deserialized = Get-Content -LiteralPath '$($requestPath -replace "'", "''")' -Raw | ConvertFrom-Json
Assert-E1GuestBundleArguments 'run-agentic-eval-disk-cleanup' `$deserialized
`$parsedRaw = ConvertFrom-Json `$deserialized.PrivateRootRelativePathsJson
`$parsed = @(`$parsedRaw)
Write-Output "COUNT:`$(`$parsed.Count)"
"@
        $scriptPath = Join-Path $script:FixtureRoot "$([guid]::NewGuid().ToString('N')).ps1"
        Set-Content -LiteralPath $scriptPath -Value $ps1 -Encoding UTF8
        & powershell.exe -NoProfile -File $scriptPath 2>&1
    }
    }

    AfterAll {
        if (Test-Path -LiteralPath $script:FixtureRoot) {
            Remove-Item -LiteralPath $script:FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'round-trips 0 entries (the normal private-roots-only-empty case) under real powershell.exe 5.1' {
        $output = Invoke-TransportSimulation -Paths @()
        $LASTEXITCODE | Should -Be 0
        $output | Should -Match 'COUNT:0'
    }

    It 'round-trips exactly 1 entry (the shape that collapsed to a bare string before this redesign) under real powershell.exe 5.1' {
        $output = Invoke-TransportSimulation -Paths @('eval-v2-gate\99f67197-93bf-43a0-bd0f-160f2e6eb52e')
        $LASTEXITCODE | Should -Be 0
        $output | Should -Match 'COUNT:1'
    }

    It 'round-trips the real 125-entry list under real powershell.exe 5.1' {
        $paths = 1..125 | ForEach-Object { "campaign\fixture-$_" }
        $output = Invoke-TransportSimulation -Paths $paths
        $LASTEXITCODE | Should -Be 0
        $output | Should -Match 'COUNT:125'
    }

    It 'the scriptblock body actually deletes a real fixture tree end to end (proves the environment fix, not just argument parsing)' {
        $treeRoot = Join-Path $script:FixtureRoot 'Evidence1Private'
        New-Item -ItemType Directory -Force -Path (Join-Path $treeRoot 'eval-v2-gate\fixture-campaign\nested') | Out-Null
        Set-Content -LiteralPath (Join-Path $treeRoot 'eval-v2-gate\fixture-campaign\nested\file.txt') -Value 'x'

        $contractSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1') -Raw
        $start = $contractSource.IndexOf('function Assert-E1CleanupPathConfined')
        $end = $contractSource.IndexOf('$childEnvironment = Get-E1CleanupChildEnvironment', $start)
        $end = $contractSource.IndexOf("`n", $end) + 1
        $body = $contractSource.Substring($start, $end - $start)

        $ps1 = @"
`$ErrorActionPreference = 'Stop'
$body
`$env:E1FakeBoundedProcess = 'placeholder'
function script:FakeBoundedProcess {
    param(`$FileName, `$Arguments, `$WorkingDirectory, `$EnvironmentVariables, `$TimeoutSeconds)
    if ([string]::IsNullOrEmpty(`$EnvironmentVariables.SystemRoot)) { throw 'no_system_root_in_child_environment' }
    # Remove-E1CleanupLongPathTree hardcodes the GUEST's own canonical node.exe path and its
    # own C:\Evidence1Private working directory (by this file's established, deliberate
    # convention -- every bundle's guest-side paths are fixed literals, never parameterized).
    # Neither exists on this host, so this fake substitutes a real, host-available node.exe
    # and an always-present working directory when asked for either -- the script text and
    # arguments Remove-E1CleanupLongPathTree builds are unchanged and still run for real; only
    # these two guest-only locations differ from the guest.
    if (`$FileName -eq 'C:\Evidence1Toolchain\node\24.19.0\node.exe') {
        `$hostNode = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not `$hostNode) { throw 'no_host_node_available_for_fake_bounded_process' }
        `$FileName = `$hostNode
    }
    if (-not (Test-Path -LiteralPath `$WorkingDirectory)) { `$WorkingDirectory = `$env:TEMP }
    `$psi = [Diagnostics.ProcessStartInfo]::new()
    `$psi.FileName = `$FileName
    # ArgumentList comes back `$null on this host's PS 5.1/.NET Framework combination
    # (confirmed live -- "cannot call a method on a null-valued expression" adding to it).
    # None of this bundle's real args (-e, the single-quoted JS one-liner, a plain Windows
    # path) ever contain a literal double quote, so simple wrap-and-escape is exact here.
    `$psi.Arguments = ((`$Arguments | ForEach-Object { '"' + `$_.Replace('"','""') + '"' }) -join ' ')
    `$psi.WorkingDirectory = `$WorkingDirectory
    `$psi.UseShellExecute = `$false
    `$psi.RedirectStandardOutput = `$true
    foreach (`$k in `$EnvironmentVariables.Keys) { `$psi.EnvironmentVariables[`$k] = `$EnvironmentVariables[`$k] }
    `$p = [Diagnostics.Process]::Start(`$psi)
    `$stdout = `$p.StandardOutput.ReadToEnd()
    `$p.WaitForExit()
    [ordered]@{ exit_code = `$p.ExitCode; cleanup_ok = `$true; stdout = `$stdout }
}
`$childEnvironment = Get-E1CleanupChildEnvironment
`$full = Assert-E1CleanupPathConfined '$($treeRoot -replace "'", "''")' 'eval-v2-gate' '$($treeRoot -replace "'", "''")\eval-v2-gate\fixture-campaign'
`$removed = Remove-E1CleanupLongPathTree (Get-Command FakeBoundedProcess).ScriptBlock `$childEnvironment `$full
Write-Output "REMOVED_ENTRIES:`$removed"
Write-Output "STILL_EXISTS:`$(Test-Path -LiteralPath `$full)"
"@
        $scriptPath = Join-Path $script:FixtureRoot 'delete-e2e.ps1'
        Set-Content -LiteralPath $scriptPath -Value $ps1 -Encoding UTF8
        $output = & powershell.exe -NoProfile -File $scriptPath 2>&1

        $LASTEXITCODE | Should -Be 0
        # Should -Match tests each PIPED element separately (an implicit AND across the whole
        # array, not "any element matches") -- this script prints two lines, and the first
        # ("REMOVED_ENTRIES:1") never matches a pattern aimed at the second. Confirmed live: a
        # temporary full-output dump showed 'STILL_EXISTS:False' genuinely present while this
        # exact assertion still failed. Join into one string first so a pattern on either line
        # is found regardless of which line it is on.
        ($output -join "`n") | Should -Match 'STILL_EXISTS:False'
        Test-Path -LiteralPath (Join-Path $treeRoot 'eval-v2-gate\fixture-campaign') | Should -BeFalse
    }
}
