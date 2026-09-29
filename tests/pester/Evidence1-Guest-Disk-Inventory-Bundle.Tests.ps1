# evidence1-guest-bundle-contract.psm1's 'inventory-guest-disk-usage' bundle: read-only,
# closed-enum, no caller-supplied path -- every location it walks is a fixed literal. Its
# scriptblock body is pure filesystem I/O (Get-PSDrive/Get-ChildItem/Test-Path) with no PSSession/
# Hyper-V surface to fake, so this test exercises the byte-summing helper directly against real
# temp fixtures rather than the "extract source, shadow cmdlets" pattern this file's other tests
# (which DO call real Hyper-V cmdlets) need.
BeforeAll {
    $script:AuditsRoot = 'C:\kmp-eval\agentic-eval-codex-runtime\docs\audits'
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1') -Force

    $script:Registry = Get-E1GuestBundleRegistry
    $script:Bundle = $script:Registry['inventory-guest-disk-usage']

    # Extract-and-evaluate, same discipline as this file's own sibling tests
    # (Evidence1-Hyperv-Set-Vm-Memory-Direct.Tests.ps1): the real function source, not a
    # hand-retyped copy that could silently drift from the shipped code.
    $contractSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1') -Raw
    $start = $contractSource.IndexOf('function Get-E1GuestDiskInventoryDirectoryBytes')
    if ($start -lt 0) { throw 'Get-E1GuestDiskInventoryDirectoryBytes not found -- bundle changed shape' }
    $end = $contractSource.IndexOf('return [int64]$sum', $start)
    if ($end -lt 0) { throw 'could not isolate the end of Get-E1GuestDiskInventoryDirectoryBytes' }
    $end = $contractSource.IndexOf('}', $end) + 1
    $script:HelperSource = $contractSource.Substring($start, $end - $start) -replace '^function ', 'function script:'
    Invoke-Expression $script:HelperSource

    $script:FixtureRoot = Join-Path 'C:\kmp-eval\scratch\pester-guest-disk-inventory-tests' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:FixtureRoot | Out-Null
}

AfterAll {
    if (Test-Path -LiteralPath $script:FixtureRoot) {
        Remove-Item -LiteralPath $script:FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'inventory-guest-disk-usage: registration shape' {
    It 'is registered with an empty (closed) argument_schema' {
        $script:Bundle | Should -Not -BeNullOrEmpty
        @($script:Bundle.argument_schema.Keys).Count | Should -Be 0
    }

    It 'declares exactly the result_keys its scriptblock returns' {
        $expected = @(
            'c_drive_free_bytes', 'c_drive_total_bytes', 'private_roots',
            'temp_total_bytes', 'temp_harness_prefixed_count', 'temp_harness_prefixed_bytes',
            'compact_gradle_seed_copies_count', 'compact_gradle_seed_copies_bytes',
            'harness_checkout_bytes', 'source_template_bytes', 'canonical_gradle_seed_bytes'
        )
        @(Compare-Object $script:Bundle.result_keys $expected).Count | Should -Be 0
    }
}

Describe 'inventory-guest-disk-usage: Get-E1GuestDiskInventoryDirectoryBytes helper' {
    It 'returns 0 for a path that does not exist, never throws' {
        $missing = Join-Path $script:FixtureRoot 'does-not-exist'
        Get-E1GuestDiskInventoryDirectoryBytes $missing | Should -Be 0
    }

    It 'sums file sizes recursively across nested subdirectories' {
        $dir = Join-Path $script:FixtureRoot 'nested'
        New-Item -ItemType Directory -Force -Path (Join-Path $dir 'a\b') | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'top.txt') -Value ('x' * 100) -NoNewline
        Set-Content -LiteralPath (Join-Path $dir 'a\mid.txt') -Value ('x' * 250) -NoNewline
        Set-Content -LiteralPath (Join-Path $dir 'a\b\deep.txt') -Value ('x' * 37) -NoNewline

        Get-E1GuestDiskInventoryDirectoryBytes $dir | Should -Be 387
    }

    It 'returns 0 for an existing but empty directory' {
        $dir = Join-Path $script:FixtureRoot 'empty'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Get-E1GuestDiskInventoryDirectoryBytes $dir | Should -Be 0
    }
}
