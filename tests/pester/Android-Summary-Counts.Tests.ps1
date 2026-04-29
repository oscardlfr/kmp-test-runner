#Requires -Modules Pester
# v0.5.2 Gap D — regression tests for run-android-tests.ps1 single-module
# summary.json counter shape.
#
# Background: PR #54 fixed PowerShell single-item-pipeline collapse:
# Where-Object on a single-element collection collapsed to a hashtable, so
# $modules.Count returned the number of HASHTABLE KEYS (5 for $modules,
# 11 for $results) instead of the array length 1. This propagated into
# summary.json as `totalModules: 5, passedModules: 11, modules.length: 1`
# on single-module runs.
#
# Fix: wrap every Where-Object pipeline that feeds a `.Count` reference
# in `@(...)` to force array semantics. These tests lock the fix at the
# source level; any future regression that drops the @() wrapper is
# caught at PR time.
#
# Sibling bats coverage on the bash side: tests/bats/test-android-summary-counts.bats.

BeforeAll {
    $script:scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-android-tests.ps1'
    $script:scriptText = Get-Content -Raw -Path $script:scriptPath
}

Describe 'PR #54 regression: single-item-pipeline collapse on $modules' {
    It 'wraps $modules assignment from $allModules in @() to enforce array semantics' {
        $script:scriptText | Should -Match '\$modules\s*=\s*@\(\$allModules\)'
    }

    It 'wraps the include-filter Where-Object pipeline in @()' {
        # `$modules = @($modules | Where-Object { ... })` is the post-PR-54 form.
        # Without @(), a single match returns a hashtable and $modules.Count
        # silently degrades to 5 (the number of object property keys).
        $script:scriptText | Should -Match '\$modules\s*=\s*@\(\$modules\s*\|\s*Where-Object'
    }
}

Describe 'PR #54 regression: single-item-pipeline collapse on $results' {
    It '$totalSuccess wraps the Where-Object result in @() before .Count' {
        # `@($results | Where-Object { $_.Success }).Count` — the @() forces
        # array enumeration so .Count returns the number of matching items
        # (1 for a single-module pass), not the number of hashtable keys (11).
        $script:scriptText | Should -Match '\$totalSuccess\s*=\s*@\(\$results\s*\|\s*Where-Object[^)]*\$_\.Success[^)]*\)\.Count'
    }

    It '$totalFailure wraps the Where-Object result in @() before .Count' {
        $script:scriptText | Should -Match '\$totalFailure\s*=\s*@\(\$results\s*\|\s*Where-Object[^)]*-not\s+\$_\.Success[^)]*\)\.Count'
    }
}

Describe 'summary.json field-shape contract (PR #54 + parseAndroidSummary v0.5.1)' {
    It 'totalModules sources from $totalModules (= $modules.Count post-fix)' {
        $script:scriptText | Should -Match 'totalModules\s*=\s*\$totalModules'
    }

    It 'passedModules sources from $totalSuccess' {
        $script:scriptText | Should -Match 'passedModules\s*=\s*\$totalSuccess'
    }

    It 'failedModules sources from $totalFailure' {
        $script:scriptText | Should -Match 'failedModules\s*=\s*\$totalFailure'
    }

    It 'modules array is built via @($results | ForEach-Object { ... })' {
        # Same @() wrapping pattern — the modules[] array must enumerate as
        # an array even when only one result matches.
        $script:scriptText | Should -Match 'modules\s*=\s*@\(\$results\s*\|\s*ForEach-Object'
    }
}

Describe 'Negative guard: bug-pattern must never return' {
    It 'no `$results | Where-Object { ... }.Count` outside @() wrapping' {
        # If anyone refactors and drops the @() wrapper, .Count silently goes
        # back to returning hashtable key counts. Catch the bare form.
        # (Match Where-Object piped result with .Count NOT preceded by @( ).)
        $bareForms = [System.Text.RegularExpressions.Regex]::Matches(
            $script:scriptText,
            '(?<!@\()\$results\s*\|\s*Where-Object[^)\n]*\)\s*\.Count'
        )
        # Should be 0 — only the @()-wrapped forms survive.
        $bareForms.Count | Should -Be 0
    }
}
