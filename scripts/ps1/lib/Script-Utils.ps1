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

    $candidates = @(
        'src\test', 'src\commonTest', 'src\jvmTest', 'src\desktopTest',
        'src\androidUnitTest', 'src\androidInstrumentedTest', 'src\androidTest',
        'src\iosTest', 'src\nativeTest'
    )
    foreach ($d in $candidates) {
        if (Test-Path (Join-Path $ModulePath $d)) { return $true }
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
