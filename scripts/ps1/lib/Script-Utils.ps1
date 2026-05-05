# =============================================================================
# Script-Utils.ps1 — Shared utility helpers for runner scripts.
#
# Dot-source this file and call:
#   $verdict = Invoke-GradleExitDeprecationGate -ExitCode $code -SuccessCount $s `
#                                                -FailureCount $f -TotalCount $n -Context 'tests'
#   switch ($verdict) {
#     'success'   { ... }   # exit 0, OR exit nonzero but every task passed (deprecation noise)
#     'env_error' { ... }   # exit nonzero AND zero tasks succeeded; mark all failed
#     'partial'   { ... }   # mixed; caller's per-module reporting speaks for itself
#   }
#
#   $hasTests = Test-ModuleHasTestSources -ProjectRoot $PR -Module 'core-foo'
#   if (-not $hasTests) { Write-Host "[SKIP] $mod (no test source set)"; continue }
#
# =============================================================================

# Phase 4 step 4 (v0.5.1): Test-ModuleHasTestSources moved here from
# run-parallel-coverage-suite.ps1 to mirror the sh layout (script-utils.sh).
# Prefers the ProjectModel JSON via Get-PmModuleHasTests; falls back to the
# filesystem walk when the model is absent / unreadable.
#
# Two call shapes are supported (we keep both for backwards compatibility):
#   Test-ModuleHasTestSources -ModulePath <fs-path>                   (legacy)
#   Test-ModuleHasTestSources -ProjectRoot <root> -Module <name>      (Phase 4)
#
# The ProjectRoot+Module form prefers the model fast-path; ModulePath skips
# the model lookup entirely (used by callers without a project_root context).
function Test-ModuleHasTestSources {
    [CmdletBinding(DefaultParameterSetName = 'ByPath')]
    param(
        [Parameter(ParameterSetName = 'ByPath', Position = 0)]
        [string]$ModulePath,

        [Parameter(ParameterSetName = 'ByModelName', Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(ParameterSetName = 'ByModelName', Mandatory = $true)]
        [string]$Module
    )

    if ($PSCmdlet.ParameterSetName -eq 'ByModelName') {
        # Lazy-source the ProjectModel readers. Sibling lib lives at
        # scripts/ps1/lib/ProjectModel.ps1 — same directory as this file.
        if (-not (Get-Command Get-PmModuleHasTests -ErrorAction SilentlyContinue)) {
            $modelLib = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'ProjectModel.ps1'
            if (Test-Path $modelLib) { . $modelLib }
        }
        if (Get-Command Get-PmModuleHasTests -ErrorAction SilentlyContinue) {
            $modelAnswer = Get-PmModuleHasTests -ProjectRoot $ProjectRoot -Module $Module
            if ($modelAnswer -is [bool]) { return $modelAnswer }
            # $null = model absent; fall through to filesystem walk.
        }
        $rel = $Module.TrimStart(':') -replace ':', [IO.Path]::DirectorySeparatorChar
        $ModulePath = Join-Path $ProjectRoot $rel
    }

    # 9 baseline + 3 JS/Wasm (v0.6 Bug 3) + 6 iOS-arch/macOS (v0.7.0).
    $candidates = @(
        'src\test', 'src\commonTest', 'src\jvmTest', 'src\desktopTest',
        'src\androidUnitTest', 'src\androidInstrumentedTest', 'src\androidTest',
        'src\iosTest', 'src\nativeTest',
        'src\jsTest', 'src\wasmJsTest', 'src\wasmWasiTest',
        'src\iosX64Test', 'src\iosArm64Test', 'src\iosSimulatorArm64Test',
        'src\macosTest', 'src\macosX64Test', 'src\macosArm64Test'
    )
    foreach ($d in $candidates) {
        if (Test-Path (Join-Path $ModulePath $d)) { return $true }
    }
    return $false
}
# =============================================================================

# UX-1 (v0.7.x): does a module declare a target/source set for the requested
# test type? Used by the parallel wrapper to skip modules that lack the
# requested target BEFORE invoking gradle — without this filter, the wrapper
# would queue a non-existent task (e.g. :androidApp:iosSimulatorArm64Test on
# an Android-only module, or :androidApp:desktopTest on a module without a
# jvm target) and gradle would abort the entire build at task-graph
# resolution, taking down even modules that DO support the target.
#
# Source of truth: project model JSON (Get-Pm*TestTask / Get-PmUnitTestTask),
# with a filesystem fallback that checks BOTH src\<platform>Main (production
# code → target is declared in build.gradle.kts → gradle task exists, may be
# a no-op if Test source set is missing) AND src\<platform>Test.
#
# Handled test types: ios, macos (v0.7.0 iOS/macOS dispatch);
# common, desktop (gradle desktopTest task — needs jvm()/jvm("desktop") target).
function Test-ModuleSupportsTestType {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module,
        [Parameter(Mandatory)][string]$TestType
    )

    if ($TestType -notin @('ios', 'macos', 'common', 'desktop')) { return $true }

    # Lazy-source the ProjectModel readers — sibling lib in the same dir.
    if (-not (Get-Command Get-PmIosTestTask -ErrorAction SilentlyContinue)) {
        $modelLib = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'ProjectModel.ps1'
        if (Test-Path $modelLib) { . $modelLib }
    }

    $modelTask = $null
    switch ($TestType) {
        'ios' {
            if (Get-Command Get-PmIosTestTask -ErrorAction SilentlyContinue) {
                $modelTask = Get-PmIosTestTask -ProjectRoot $ProjectRoot -Module $Module
            }
        }
        'macos' {
            if (Get-Command Get-PmMacosTestTask -ErrorAction SilentlyContinue) {
                $modelTask = Get-PmMacosTestTask -ProjectRoot $ProjectRoot -Module $Module
            }
        }
        { $_ -in @('common', 'desktop') } {
            # `--test-type common` and `--test-type desktop` both dispatch
            # gradle's desktopTest. The model's unitTestTask captures the
            # JVM/desktop test task name when the module declares it.
            if (Get-Command Get-PmUnitTestTask -ErrorAction SilentlyContinue) {
                $modelTask = Get-PmUnitTestTask -ProjectRoot $ProjectRoot -Module $Module
            }
        }
    }
    if (-not [string]::IsNullOrEmpty($modelTask)) { return $true }

    # Filesystem fallback per test-type.
    $rel = $Module.TrimStart(':') -replace ':', [IO.Path]::DirectorySeparatorChar
    $modulePath = Join-Path $ProjectRoot $rel

    $candidates = switch ($TestType) {
        'ios' {
            @(
                'src\iosMain', 'src\iosX64Main', 'src\iosArm64Main', 'src\iosSimulatorArm64Main',
                'src\iosTest', 'src\iosX64Test', 'src\iosArm64Test', 'src\iosSimulatorArm64Test'
            )
        }
        'macos' {
            @(
                'src\macosMain', 'src\macosX64Main', 'src\macosArm64Main',
                'src\macosTest', 'src\macosX64Test', 'src\macosArm64Test'
            )
        }
        { $_ -in @('common', 'desktop') } {
            # gradle desktopTest needs a jvm()/jvm("desktop") target. Evidence:
            # any jvm/desktop main or test source set on disk. (commonMain /
            # commonTest alone are NOT sufficient — pure-common KMP modules
            # with no platform target have no platform tasks.)
            @('src\jvmMain', 'src\desktopMain', 'src\jvmTest', 'src\desktopTest')
        }
    }
    foreach ($d in $candidates) {
        if (Test-Path (Join-Path $modulePath $d)) { return $true }
    }
    return $false
}
# =============================================================================

function Invoke-GradleExitDeprecationGate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$ExitCode,
        [Parameter(Mandatory)][int]$SuccessCount,
        [Parameter(Mandatory)][int]$FailureCount,
        [Parameter(Mandatory)][int]$TotalCount,
        [string]$Context = 'gradle'
    )

    # Returns a hashtable: @{ Verdict = 'success'|'env_error'|'partial'; Lines = @(...) }
    # Caller picks the right Write-Host color based on Verdict and prints Lines.
    if ($ExitCode -eq 0) {
        return @{ Verdict = 'success'; Lines = @() }
    }

    if ($FailureCount -eq 0 -and $SuccessCount -eq 0) {
        return @{
            Verdict = 'env_error'
            Lines   = @(
                "[!] Gradle ($Context) exited with code $ExitCode and no task results found.",
                "    This usually means a JVM-level error (wrong JAVA_HOME, OOM, daemon crash)."
            )
        }
    }

    if ($FailureCount -eq 0 -and $SuccessCount -gt 0) {
        return @{
            Verdict = 'success'
            Lines   = @(
                "[NOTICE] Gradle ($Context) exited with code $ExitCode but all $SuccessCount tasks passed individually.",
                "         This is likely deprecation warnings (Gradle 9+), not real failures."
            )
        }
    }

    return @{ Verdict = 'partial'; Lines = @() }
}
