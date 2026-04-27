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
